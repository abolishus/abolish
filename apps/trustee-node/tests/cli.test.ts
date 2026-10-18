import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeElectionDefinition, identityKey, panelId } from "@abolishus/crypto";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { cli, dutyWiring } from "../src/cli.ts";
import { parseConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store.ts";
import { LocalCoordinator, serveCoordinator } from "../src/local.ts";
import { anvil, freePort, type Node } from "./anvil.ts";
import { L2_CHAIN_ID, panelOf, stubFor, TRUSTEE_REGISTRY } from "./fixture.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function io(signal = new AbortController().signal) {
  const out: unknown[] = [];
  const err: unknown[] = [];
  return {
    io: { out: (v: unknown) => out.push(v), err: (v: unknown) => err.push(v), signal },
    out,
    err,
  };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "trustee-node-cli-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("local-ceremony", () => {
  test("runs a whole ceremony between local nodes over HTTP, every seat qualified and approving", async () => {
    const t = io();
    const code = await cli(
      ["local-ceremony", "--seats", "4", "--threshold", "2", "--dir", join(dir, "local")],
      t.io,
    );
    expect(code).toBe(0);
    expect(t.out).toMatchObject([
      { event: "ceremony", ok: true, qualified: [1, 2, 3, 4], approved: [1, 2, 3, 4] },
    ]);
    // What the nodes report holds no secret: only events, rounds, hashes and run ids.
    for (const e of t.err)
      expect(Object.keys(e as object).sort()).toEqual([
        "event",
        "round",
        "runId",
        "seat",
        "stubHash",
      ]);
  }, 120_000);

  test.each([
    [["local-ceremony", "--seats", "1"]],
    [["local-ceremony", "--seats", "4", "--threshold", "5"]],
    [["local-ceremony", "--unknown"]],
    [["run"]],
    [["nothing"]],
    [[]],
  ])("refuses %j as bad usage", async (argv) => {
    const t = io();
    expect(await cli(argv, t.io)).toBe(2);
    expect(t.out).toEqual([]);
  });
});

describe("run", () => {
  test("refuses every stub until the node has a production electorate check, and stops at once when aborted mid-poll", async () => {
    const { panel, secrets } = panelOf(3, 2);
    const stub = encodeElectionDefinition(stubFor(panel));
    const coordinator = new LocalCoordinator({
      stub,
      panel,
      l2ChainId: L2_CHAIN_ID,
      trusteeRegistry: TRUSTEE_REGISTRY,
      roundMs: 60_000,
      now: () => 0,
    });
    const { url, server } = await serveCoordinator(coordinator);
    try {
      const keyFile = join(dir, "identity");
      await writeFile(keyFile, hex(secrets[0] as Uint8Array), { mode: 0o600 });
      const configFile = join(dir, "config.json");
      await writeFile(
        configFile,
        JSON.stringify({
          panel: { threshold: 2, keys: panel.keys.map(hex) },
          panelId: hex(panelId(panel)),
          l2ChainId: L2_CHAIN_ID.toString(),
          trusteeRegistry: hex(TRUSTEE_REGISTRY),
          seat: 1,
          identityKeyFile: keyFile,
          store: join(dir, "store"),
          coordinator: url,
          // An hour: `run` must end on the abort, not on the next poll.
          pollSeconds: 3600,
        }),
      );
      const stop = new AbortController();
      const t = io(stop.signal);
      const running = cli(["run", "--config", configFile], {
        ...t.io,
        out: (v) => {
          t.out.push(v);
          if ((v as { event?: string }).event === "refused") stop.abort();
        },
      });
      const started = performance.now();
      expect(await running).toBe(0);
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(t.out).toMatchObject([
        { event: "started", seat: 1 },
        { event: "refused", round: 1, code: "stub-electorate" },
      ]);
      expect(await coordinator.requests(1)).toHaveLength(1);
    } finally {
      server.close();
    }
  }, 60_000);
});

describe("keygen", () => {
  test("writes a fresh key to a new owner-only file and prints only its public key", async () => {
    const out = join(dir, "keygen");
    const t = io();
    expect(await cli(["keygen", "--out", out], t.io)).toBe(0);
    const secret = Uint8Array.from(Buffer.from((await readFile(out, "utf8")).trim(), "hex"));
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(t.out).toEqual([{ event: "keygen", identityKey: hex(identityKey(secret)) }]);
    // Never over an existing key.
    const again = io();
    expect(await cli(["keygen", "--out", out], again.io)).toBe(2);
    expect((await readFile(out, "utf8")).trim()).toBe(hex(secret));
  });
});

describe("run's configuration", () => {
  test("a missing config file, and an identity key that isn't the seat's, are bad configuration", async () => {
    const { panel, secrets } = panelOf(3, 2);
    const keyFile = join(dir, "identity-2");
    await writeFile(keyFile, hex(secrets[1] as Uint8Array), { mode: 0o600 });
    const configFile = join(dir, "config-mismatch.json");
    await writeFile(
      configFile,
      JSON.stringify({
        panel: { threshold: 2, keys: panel.keys.map(hex) },
        panelId: hex(panelId(panel)),
        l2ChainId: L2_CHAIN_ID.toString(),
        trusteeRegistry: hex(TRUSTEE_REGISTRY),
        seat: 1,
        identityKeyFile: keyFile,
        store: join(dir, "store-mismatch"),
        coordinator: "https://coordinator.example/",
      }),
    );
    for (const argv of [
      ["run", "--config", join(dir, "absent.json")],
      ["run", "--config", configFile],
    ]) {
      const t = io();
      expect(await cli(argv, t.io)).toBe(2);
      expect(t.out).toEqual([]);
    }
  });
});

describe("run with the availability duty", () => {
  const BOARD = `0x${"b0".repeat(20)}`;
  const PORTAL = `0x${"90".repeat(20)}`;
  const ACCEPT = "0x00";
  // One Anvil node stands in for both chains: what is checked here is the
  // duty's setup over the configuration, not either chain's behaviour.
  let chain: Node;
  let seatConfig: Record<string, unknown>;
  let accountKeyFile: string;
  beforeAll(async () => {
    chain = await anvil(L2_CHAIN_ID, true);
    for (const address of [BOARD, PORTAL]) await chain.rpc.call("anvil_setCode", [address, ACCEPT]);
    const { panel, secrets } = panelOf(3, 2);
    const identityKeyFile = join(dir, "availability-identity");
    await writeFile(identityKeyFile, hex(secrets[0] as Uint8Array), { mode: 0o600 });
    accountKeyFile = join(dir, "availability-account");
    await writeFile(accountKeyFile, hex(crypto.getRandomValues(new Uint8Array(32))), {
      mode: 0o600,
    });
    seatConfig = {
      panel: { threshold: 2, keys: panel.keys.map(hex) },
      panelId: hex(panelId(panel)),
      l2ChainId: L2_CHAIN_ID.toString(),
      trusteeRegistry: hex(TRUSTEE_REGISTRY),
      seat: 1,
      identityKeyFile,
      // Nothing listens there: the ceremony's polls fail as transport errors.
      coordinator: `http://127.0.0.1:${await freePort()}/`,
      pollSeconds: 3600,
    };
  });
  afterAll(() => chain?.process.kill());

  const availability = (change: Record<string, unknown> = {}) => ({
    l1: chain.url.href,
    l1ChainId: L2_CHAIN_ID.toString(),
    l2: chain.url.href,
    anchor: `0x${"a1".repeat(20)}`,
    anchorFromBlock: "0",
    anchorClock: { epoch: "0", period: "3600", deadline: "43200" },
    registry: `0x${"e1".repeat(20)}`,
    registryFromBlock: "0",
    board: BOARD,
    boardFromBlock: "0",
    portal: PORTAL,
    accountKeyFile,
    l1MaxFeePerGas: "300000000000",
    l2MaxFeePerGas: "10000000000",
    forceAfterSeconds: 1800,
    forceLeadSeconds: 3600,
    sendMarginSeconds: 1800,
    gateways: ["http://127.0.0.1:1/"],
    ...change,
  });

  async function runWith(name: string, change: Record<string, unknown>, abortOn?: string) {
    const configFile = join(dir, `${name}.json`);
    await writeFile(
      configFile,
      JSON.stringify({
        ...seatConfig,
        store: join(dir, `${name}-store`),
        availability: availability(change),
      }),
    );
    const stop = new AbortController();
    const t = io(stop.signal);
    const code = await cli(["run", "--config", configFile], {
      ...t.io,
      out: (v) => {
        t.out.push(v);
        if ((v as { event?: string }).event === abortOn) stop.abort();
      },
    });
    return { code, out: t.out, err: t.err };
  }

  test("sets the duty up over the configured nodes, contracts and sources, and stops when aborted", async () => {
    const blocks = join(dir, "blocks");
    await mkdir(blocks);
    await writeFile(join(blocks, "broken.car"), "not a car");
    const run = await runWith("availability", { blocks }, "started");
    expect(run.code).toBe(0);
    expect(run.out).toEqual([
      { event: "blocks", file: "broken.car", error: "not-a-car" },
      { event: "started", seat: 1, availability: true },
    ]);
  }, 60_000);

  test.each<[string, Record<string, unknown>, string]>([
    ["a board without code", { board: `0x${"b1".repeat(20)}` }, "availability: no-code"],
    ["a node on another chain", { l1ChainId: "1" }, "availability: chain"],
    [
      "a blocks directory that isn't there",
      { blocks: "/nonexistent" },
      "availability.blocks: ENOENT",
    ],
  ])(
    "refuses %s as bad configuration",
    async (name, change, error) => {
      const run = await runWith(name.replaceAll(" ", "-"), change);
      expect(run.code).toBe(2);
      expect(run.err).toEqual([{ error }]);
      expect(run.out).toEqual([]);
    },
    60_000,
  );

  test("refuses the identity key as the account key", async () => {
    const run = await runWith("same-key", { accountKeyFile: seatConfig["identityKeyFile"] });
    expect(run.code).toBe(2);
    expect(run.err).toEqual([{ error: "account key: must not be the identity key" }]);
  });

  test("wires the reader and each election's duty from the configuration, under the definition's own board version", () => {
    const parsed = parseConfig(
      JSON.stringify({
        ...seatConfig,
        store: join(dir, "wiring-store"),
        availability: availability({
          anchorFromBlock: "11",
          registryFromBlock: "22",
          boardFromBlock: "33",
          sendMarginSeconds: 1234,
          maxBoardBytes: 5678,
        }),
      }),
    );
    const a = parsed.availability;
    if (a === undefined) return expect.fail("no availability");
    const sources = {
      l1: { call: async () => null },
      l2: { call: async () => null },
      contract: { send: async () => {}, recorded: async () => undefined },
      blocks: async () => [],
      store: new MemoryStore(),
      clock: () => 7n,
    };
    const w = dutyWiring(parsed.l2ChainId, a, sources);
    expect(w.anchors).toEqual({
      l1: sources.l1,
      l1ChainId: L2_CHAIN_ID,
      anchor: a.anchor,
      timing: { epoch: 0n, period: 3600n, deadline: 43200n },
      l1FromBlock: 11n,
      l2: sources.l2,
      l2ChainId: L2_CHAIN_ID,
      registry: a.registry,
      l2FromBlock: 22n,
    });
    const election = {
      index: 1,
      stubHash: new Uint8Array(32),
      definitionHash: new Uint8Array(32),
      electionId: new Uint8Array(32),
      closesAt: 0n,
      l1InclusionBound: 0n,
      signingSecret: new Uint8Array(32),
    };
    const reader = { boardVersion: 5 as const, read: async () => expect.fail("not read") };
    const o = w.seat(election, reader);
    expect(o).toEqual({
      store: sources.store,
      election,
      boardVersion: 5,
      l1: reader,
      blocks: sources.blocks,
      contract: sources.contract,
      clock: sources.clock,
      sendMargin: 1234n,
      maxBytes: 5678,
    });
  });

  test("refuses an account key others can read", async () => {
    const loose = join(dir, "loose-account");
    await writeFile(loose, "22".repeat(32), { mode: 0o644 });
    const run = await runWith("loose", { accountKeyFile: loose });
    expect(run.code).toBe(2);
    expect(run.err).toMatchObject([{ error: expect.stringMatching(/^account key: /) }]);
  });

  test("exits 1 when a chain's node can't be read at start, never naming its URL", async () => {
    const l1 = `http://user:key@127.0.0.1:${await freePort()}/secret`;
    const run = await runWith("unreachable", { l1 });
    expect(run.code).toBe(1);
    expect(run.err).toEqual([{ error: expect.stringMatching(/^availability: eth_chainId: /) }]);
    expect(JSON.stringify(run.err)).not.toContain("key@");
    expect(run.out).toEqual([]);
  }, 60_000);
});
