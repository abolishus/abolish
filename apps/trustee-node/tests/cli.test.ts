import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cidText,
  encodeElectionDefinition,
  identityKey,
  kemKeygen,
  objectCar,
  objectCid,
  panelId,
} from "@abolishus/crypto";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { cli, dutyWiring } from "../src/cli.ts";
import { L1AnchorError } from "../src/l1.ts";
import { encodeDelivery } from "../src/endpoint.ts";
import { parseConfig } from "../src/config.ts";
import { servedBlocks } from "../src/served.ts";
import { MemoryStore } from "../src/store.ts";
import { LocalCoordinator, serveCoordinator } from "../src/local.ts";
import { anvil, freePort, type Node } from "./anvil.ts";
import {
  chainId,
  registry,
  release,
  ROOT_BLOCK,
  tierOf,
} from "../../../packages/verifier/tests/registry-logs.ts";
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
  test("refuses every stub without a group registry to check its electorate against, and stops at once when aborted mid-poll", async () => {
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

describe("run with the intake endpoint", () => {
  test("serves it and refuses every delivery until the node approves a stub", async () => {
    const { panel, secrets } = panelOf(3, 2);
    const keyFile = join(dir, "identity-intake");
    await writeFile(keyFile, hex(secrets[0] as Uint8Array), { mode: 0o600 });
    const configFile = join(dir, "config-intake.json");
    await writeFile(
      configFile,
      JSON.stringify({
        panel: { threshold: 2, keys: panel.keys.map(hex) },
        panelId: hex(panelId(panel)),
        l2ChainId: L2_CHAIN_ID.toString(),
        trusteeRegistry: hex(TRUSTEE_REGISTRY),
        seat: 1,
        identityKeyFile: keyFile,
        store: join(dir, "store-intake"),
        // Nothing listens there: the ceremony loop's failures don't stop `run`.
        coordinator: `http://127.0.0.1:${await freePort()}/`,
        pollSeconds: 3600,
        intake: { host: "127.0.0.1", port: 0 },
      }),
    );
    const stop = new AbortController();
    const t = io(stop.signal);
    let url: string | undefined;
    let stopped: Promise<number> | undefined;
    const started = new Promise<void>((resolve) => {
      const running = cli(["run", "--config", configFile], {
        ...t.io,
        out: (v) => {
          t.out.push(v);
          const e = v as { event?: string; intake?: string };
          if (e.event === "started") {
            url = e.intake;
            resolve();
          }
        },
      });
      void running.finally(resolve);
      stopped = running;
    });
    await started;
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/intake$/);
      const res = await fetch(url as string, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from(
          encodeDelivery({
            stub: encodeElectionDefinition(stubFor(panel)),
            transcript: new Uint8Array(0),
            record: new Uint8Array(0),
            ciphertext: new Uint8Array(0),
          }),
        ),
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toBe("intake-unapproved");
    } finally {
      stop.abort();
    }
    expect(await stopped).toBe(0);
    // The endpoint closed with `run`.
    await expect(fetch(url as string, { method: "OPTIONS" })).rejects.toThrow();
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

describe("run with the group registry", () => {
  // The registry's log of regional-cells.json's one-group tier, emitted at
  // the vectors' registry address on an Anvil node of their chain by code
  // that logs its calldata: `k ‖ k topics ‖ data`, for k of 1 to 3. The
  // records' approvals bind that chain and address, so the recount accepts
  // them only there.
  // PUSH1 0 CALLDATALOAD PUSH1 0xf8 SHR (k), the data copied to memory from
  // byte 1 + 32k, then LOG1, LOG2 or LOG3 over the topics at 1, 33 and 65.
  const EMITTER =
    "0x60003560f81c80602002600101803603808260003790509080600114602d5780600214603757600314604457005b50600135906000a1005b50602135600135826000a2005b604135602135600135836000a300";
  const BOARD = `0x${"b0".repeat(20)}`;
  const PORTAL = `0x${"90".repeat(20)}`;
  const tier = tierOf("one-group");
  let chain: Node;
  let deployer: string;

  beforeAll(async () => {
    chain = await anvil(chainId, true);
    const address = `0x${hex(registry)}`;
    await chain.rpc.call("anvil_setCode", [address, EMITTER]);
    for (const a of [BOARD, PORTAL]) await chain.rpc.call("anvil_setCode", [a, "0x00"]);
    [deployer] = (await chain.rpc.call("eth_accounts", [])) as [string];
    for (const r of tier.records) {
      const k = Uint8Array.of(r.topics.length);
      const data = Buffer.concat([k, ...r.topics, r.data]);
      await chain.rpc.call("eth_sendTransaction", [
        { from: deployer, to: address, data: `0x${data.toString("hex")}`, gas: "0x200000" },
      ]);
    }
    // Past the tier's block and Anvil's finality depth, so the tier is final.
    await chain.rpc.call("anvil_mine", [`0x${(ROOT_BLOCK + 200n).toString(16)}`]);
  }, 60_000);
  afterAll(() => chain?.process.kill());

  test("passes a stub whose tier the registry's finalized log makes, and refuses one it doesn't", async () => {
    const { panel, secrets } = panelOf(3, 2);
    const keyFile = join(dir, "identity-electorate");
    await writeFile(keyFile, hex(secrets[0] as Uint8Array), { mode: 0o600 });
    const accountKeyFile = join(dir, "account-electorate");
    await writeFile(accountKeyFile, hex(crypto.getRandomValues(new Uint8Array(32))), {
      mode: 0o600,
    });
    const blocks = join(dir, "blocks-electorate");
    await mkdir(blocks);
    const [cell] = tier.electorate.cells;
    const stated = {
      tier: 0 as const,
      group_id: tier.electorate.groups[0]?.group_id as bigint,
      root: cell?.root as bigint,
      root_l2_block: ROOT_BLOCK,
      group_size: cell?.members as bigint,
    };
    const outcome = async (name: string, group_size: bigint) => {
      const coordinator = new LocalCoordinator({
        stub: encodeElectionDefinition(
          stubFor(panel, {
            l2_chain_id: chainId,
            group_registry: registry,
            electorate: [{ ...stated, group_size }],
          }),
        ),
        panel,
        l2ChainId: chainId,
        trusteeRegistry: TRUSTEE_REGISTRY,
        roundMs: 60_000,
        now: () => 0,
      });
      const { url, server } = await serveCoordinator(coordinator);
      try {
        const configFile = join(dir, `${name}.json`);
        await writeFile(
          configFile,
          JSON.stringify({
            panel: { threshold: 2, keys: panel.keys.map(hex) },
            panelId: hex(panelId(panel)),
            l2ChainId: chainId.toString(),
            trusteeRegistry: hex(TRUSTEE_REGISTRY),
            seat: 1,
            identityKeyFile: keyFile,
            store: join(dir, `${name}-store`),
            coordinator: url,
            pollSeconds: 3600,
            availability: {
              l1: chain.url.href,
              l1ChainId: chainId.toString(),
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
              blocks,
              serve: { port: 0 },
              groupRegistry: {
                address: hex(registry),
                fromBlock: "0",
                registrars: release.registrars.map(hex),
                threshold: release.threshold,
              },
            },
          }),
        );
        const stop = new AbortController();
        const t = io(stop.signal);
        const code = await cli(["run", "--config", configFile], {
          ...t.io,
          out: (v) => {
            t.out.push(v);
            const e = (v as { event?: string }).event;
            if (e === "sent" || e === "refused") stop.abort();
          },
        });
        expect(code).toBe(0);
        return t.out.find((v) => ["sent", "refused"].includes((v as { event: string }).event));
      } finally {
        server.close();
      }
    };
    expect(await outcome("electorate-pass", stated.group_size)).toMatchObject({
      event: "sent",
      round: 1,
    });
    expect(await outcome("electorate-fail", stated.group_size + 1n)).toMatchObject({
      event: "refused",
      round: 1,
      code: "stub-electorate",
    });
  }, 120_000);
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
  let emptyBlocks: string;
  beforeAll(async () => {
    emptyBlocks = join(dir, "empty-blocks");
    await mkdir(emptyBlocks);
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
    blocks: emptyBlocks,
    serve: { port: 0 },
    ...change,
  });

  async function runWith(
    name: string,
    change: Record<string, unknown>,
    abortOn?: string,
    // Awaited before aborting, while the node still runs.
    onEvent?: (e: { event?: string; address?: AddressInfo; url?: string }) => Promise<void>,
  ) {
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
        const e = v as { event?: string; address?: AddressInfo; url?: string };
        if (e.event !== abortOn) return;
        if (onEvent === undefined) stop.abort();
        else void onEvent(e).finally(() => stop.abort());
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
      {
        event: "serving",
        address: { address: "127.0.0.1", family: "IPv4", port: expect.any(Number) },
      },
      { event: "started", seat: 1, availability: true },
    ]);
  }, 60_000);

  test("serves the blocks directory over the trustless gateway while it runs, and closes it when stopped", async () => {
    const blocks = join(dir, "served-blocks");
    await mkdir(blocks);
    const object = Uint8Array.from({ length: 40 }, (_, i) => i);
    const cid = objectCid(object);
    await writeFile(join(blocks, `${cidText(cid)}.car`), objectCar(object));
    let url = "";
    let answer: number | undefined;
    const run = await runWith("serving", { blocks }, "serving", async (e) => {
      url = `http://127.0.0.1:${e.address?.port}/ipfs/${cidText(cid)}?format=raw`;
      answer = (await fetch(url)).status;
    });
    expect(run.code).toBe(0);
    expect(answer).toBe(200);
    await expect(fetch(url)).rejects.toThrow();
  }, 60_000);

  test("with a tally section, serves the summed-share channel while it runs and closes it when stopped", async () => {
    let url = "";
    let answer: number | undefined;
    const tally = {
      host: "127.0.0.1",
      port: 0,
      peers: { "2": "https://seat-2.example/v1/summed-shares" },
      operator: "http://127.0.0.1:1/",
    };
    const run = await runWith("tally", { tally }, "summed-shares", async (e) => {
      url = e.url ?? "";
      // Acknowledged on arrival whatever the duties make of it (T-39).
      answer = (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array(8),
        })
      ).status;
    });
    expect(run.code).toBe(0);
    // The ceremony's first poll may report its coordinator unreachable after these.
    expect(run.out.slice(0, 3)).toEqual([
      { event: "serving", address: expect.objectContaining({ address: "127.0.0.1" }) },
      {
        event: "summed-shares",
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1\/summed-shares$/),
      },
      { event: "started", seat: 1, availability: true },
    ]);
    expect(answer).toBe(202);
    await expect(fetch(url, { method: "POST" })).rejects.toThrow();
  }, 60_000);

  test.each<[string, Record<string, unknown>, string]>([
    [
      "a peer endpoint over plain HTTP off loopback",
      { peers: { "2": "http://seat-2.example/v1/summed-shares" } },
      "availability.tally.peers: summed-share peers: seat 2's endpoint must be https",
    ],
    [
      "a peer endpoint that isn't a URL",
      { peers: { "2": "seat-2" } },
      "availability.tally.peers: Invalid URL",
    ],
    ["a CA file that isn't there", { caFile: "/nonexistent" }, "tally CA: ENOENT"],
  ])(
    "refuses %s as bad configuration",
    async (name, change, error) => {
      const run = await runWith(name.replaceAll(" ", "-"), {
        tally: {
          host: "127.0.0.1",
          port: 0,
          peers: {},
          operator: "http://127.0.0.1:1/",
          ...change,
        },
      });
      expect(run.code).toBe(2);
      expect(run.err).toEqual([{ error }]);
    },
    60_000,
  );

  test("refuses a port already taken as bad configuration", async () => {
    const taken = createServer();
    taken.listen(0, "127.0.0.1");
    await once(taken, "listening");
    try {
      const port = (taken.address() as AddressInfo).port;
      const run = await runWith("taken", { serve: { port } });
      expect(run.code).toBe(2);
      expect(run.err).toEqual([{ error: "availability.serve: EADDRINUSE" }]);
      expect(run.out).toEqual([]);
    } finally {
      taken.close();
    }
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

  test("wires the reader, each election's duties and the decision's view from the configuration, under the definition's own board version", async () => {
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
    const servedDir = join(dir, "wiring-blocks");
    await mkdir(servedDir);
    const atStart = Uint8Array.from({ length: 30 }, (_, i) => i + 1);
    await writeFile(join(servedDir, `${cidText(objectCid(atStart))}.car`), objectCar(atStart));
    const remote = Uint8Array.of(9, 9, 9);
    const sources = {
      l1: { call: async () => null },
      l2: { call: async () => null },
      contract: { send: async () => {}, recorded: async () => undefined },
      receipts: { send: async () => {}, recorded: async () => [] },
      complaints: {
        postings: async () => ({ finalizedAt: 0n, postings: [] }),
        send: async () => {},
        recorded: async () => [],
      },
      served: await servedBlocks(servedDir),
      // A gateway holding only `remote`'s block.
      gateways: async (cid: Uint8Array) =>
        hex(cid) === hex(objectCid(remote)) ? [remote] : ([] as Uint8Array[]),
      store: new MemoryStore(),
      clock: () => 7n,
    };
    const w = dutyWiring(parsed, a, sources);
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
      opensAt: 0n,
      closesAt: 0n,
      l1InclusionBound: 0n,
      members: 0n,
      signingSecret: new Uint8Array(32),
      kemKeyPair: kemKeygen(),
    };
    const reader = { boardVersion: 5 as const, read: async () => expect.fail("not read") };
    const o = w.seat(election, reader);
    expect(o).toEqual({
      store: sources.store,
      election,
      boardVersion: 5,
      l1: reader,
      blocks: expect.any(Function),
      pin: sources.served.pin,
      contract: sources.contract,
      clock: sources.clock,
      sendMargin: 1234n,
      maxBytes: 5678,
    });
    // The directory, then the gateways; what the seat pins is read back from it.
    expect(await o.blocks(objectCid(atStart), 1 << 20)).toHaveLength(1);
    expect((await o.blocks(objectCid(remote), 1 << 20)).map(hex)).toEqual([hex(remote)]);
    const attested = Uint8Array.from({ length: 50 }, (_, i) => 200 - i);
    expect(await o.blocks(objectCid(attested), 1 << 20)).toEqual([]);
    await o.pin(objectCid(attested), attested);
    expect(await stat(join(servedDir, `${cidText(objectCid(attested))}.car`))).toBeTruthy();
    expect(await o.blocks(objectCid(attested), 1 << 20)).toHaveLength(1);
    // The view reads the seat's own nodes, the deployment's registry and
    // board, and the configured panel, over the duty's store.
    expect(w.view).toEqual({
      store: sources.store,
      panel: parsed.panel,
      l1: sources.l1,
      l1ChainId: L2_CHAIN_ID,
      l2: sources.l2,
      l2ChainId: L2_CHAIN_ID,
      registry: a.registry,
      registryFromBlock: 22n,
      board: a.board,
      boardFromBlock: 33n,
      extent: expect.any(Function),
    });
    expect(w.receipts(election)).toEqual({
      store: sources.store,
      election,
      view: expect.any(Function),
      contract: sources.receipts,
      now: sources.clock,
    });
    // The complaint duty decides over the receipt duty's own view, so its
    // scope is the decision stored at `c_I`, and reads the deployment's ballots.
    const complaints = w.complaints(election);
    expect(complaints).toEqual({
      store: sources.store,
      election,
      view: w.receipts(election).view,
      contract: sources.complaints,
      ballots: expect.any(Function),
      now: sources.clock,
    });
    expect(complaints.view).toBe(w.receipts(election).view);
  });

  test("gives the view no extent for an election the seat didn't attest, without asking its nodes", async () => {
    const parsed = parseConfig(
      JSON.stringify({
        ...seatConfig,
        store: join(dir, "unattested-store"),
        availability: availability(),
      }),
    );
    const a = parsed.availability;
    if (a === undefined) return expect.fail("no availability");
    const servedDir = join(dir, "unattested-blocks");
    await mkdir(servedDir);
    const asked: string[] = [];
    const node = {
      call: async (method: string) => {
        asked.push(method);
        throw new Error("not asked");
      },
    };
    const w = dutyWiring(parsed, a, {
      l1: node,
      l2: node,
      contract: { send: async () => {}, recorded: async () => undefined },
      receipts: { send: async () => {}, recorded: async () => [] },
      complaints: {
        postings: async () => ({ finalizedAt: 0n, postings: [] }),
        send: async () => {},
        recorded: async () => [],
      },
      served: await servedBlocks(servedDir),
      gateways: async () => [],
      store: new MemoryStore(),
      clock: () => 7n,
    });
    const election = {
      index: 1,
      stubHash: new Uint8Array(32),
      definitionHash: new Uint8Array(32).fill(1),
      electionId: new Uint8Array(32),
      opensAt: 0n,
      closesAt: 0n,
      l1InclusionBound: 0n,
      members: 0n,
      signingSecret: new Uint8Array(32),
      kemKeyPair: kemKeygen(),
    };
    expect(await w.view.extent(election)).toBeUndefined();
    expect(await w.counted.extent(election)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  test("gives the counted set's source the counted extent only, under the pinned clock, and none for a seat that attested only the ballot extent", async () => {
    const parsed = parseConfig(
      JSON.stringify({
        ...seatConfig,
        store: join(dir, "counted-store"),
        availability: availability({ boardFromBlock: "33", registryFromBlock: "22" }),
      }),
    );
    const a = parsed.availability;
    if (a === undefined) return expect.fail("no availability");
    const servedDir = join(dir, "counted-blocks");
    await mkdir(servedDir);
    const asked: string[] = [];
    const node = {
      call: async (method: string) => {
        asked.push(method);
        throw new Error("not asked");
      },
    };
    const store = new MemoryStore();
    const definitionHash = new Uint8Array(32).fill(2);
    // The ballot extent's attestation, as the availability duty stores it.
    await store.putOnce(`availability/${hex(definitionHash)}/ballot/attestation`, Uint8Array.of(1));
    const w = dutyWiring(parsed, a, {
      l1: node,
      l2: node,
      contract: { send: async () => {}, recorded: async () => undefined },
      receipts: { send: async () => {}, recorded: async () => [] },
      complaints: {
        postings: async () => ({ finalizedAt: 0n, postings: [] }),
        send: async () => {},
        recorded: async () => [],
      },
      served: await servedBlocks(servedDir),
      gateways: async () => [],
      store,
      clock: () => 7n,
    });
    expect(w.counted).toMatchObject({
      counted: a.anchorClock,
      board: a.board,
      boardFromBlock: 33n,
      registryFromBlock: 22n,
      panel: parsed.panel,
    });
    expect(
      await w.counted.extent({
        index: 1,
        stubHash: new Uint8Array(32),
        definitionHash,
        electionId: new Uint8Array(32),
        opensAt: 0n,
        closesAt: 0n,
        l1InclusionBound: 0n,
        members: 0n,
        signingSecret: new Uint8Array(32),
        kemKeyPair: kemKeygen(),
      }),
    ).toBeUndefined();
    expect(asked).toEqual([]);
    // With the counted extent's attestation stored, it reads the extent
    // again through the seat's own L1 node.
    const counted = new Uint8Array(32).fill(3);
    await store.putOnce(`availability/${hex(counted)}/counted/attestation`, Uint8Array.of(1));
    await expect(
      w.counted.extent({
        index: 1,
        stubHash: new Uint8Array(32),
        definitionHash: counted,
        electionId: new Uint8Array(32),
        opensAt: 0n,
        closesAt: 0n,
        l1InclusionBound: 0n,
        members: 0n,
        signingSecret: new Uint8Array(32),
        kemKeyPair: kemKeygen(),
      }),
    ).rejects.toThrow("not asked");
    expect(asked.length).toBeGreaterThan(0);
  });

  test("reads the board's openings back through the seat's own nodes from the first read, refusing a node on another chain", async () => {
    const parsed = parseConfig(
      JSON.stringify({
        ...seatConfig,
        store: join(dir, "openings-store"),
        availability: availability(),
      }),
    );
    const a = parsed.availability;
    if (a === undefined) return expect.fail("no availability");
    const servedDir = join(dir, "openings-blocks");
    await mkdir(servedDir);
    const asked: string[] = [];
    const node = {
      call: async (method: string) => {
        asked.push(method);
        return "0x1";
      },
    };
    const w = dutyWiring(parsed, a, {
      l1: node,
      l2: node,
      contract: { send: async () => {}, recorded: async () => undefined },
      receipts: { send: async () => {}, recorded: async () => [] },
      complaints: {
        postings: async () => ({ finalizedAt: 0n, postings: [] }),
        send: async () => {},
        recorded: async () => [],
      },
      served: await servedBlocks(servedDir),
      gateways: async () => [],
      store: new MemoryStore(),
      clock: () => 7n,
    });
    const read = w.openings({
      index: 1,
      stubHash: new Uint8Array(32),
      definitionHash: new Uint8Array(32),
      electionId: new Uint8Array(32),
      opensAt: 0n,
      closesAt: 0n,
      l1InclusionBound: 0n,
      members: 0n,
      signingSecret: new Uint8Array(32),
      kemKeyPair: kemKeygen(),
    });
    // Nothing is asked until the first read.
    expect(asked).toEqual([]);
    await expect(read()).rejects.toThrow(L1AnchorError);
    expect(asked).toEqual(["eth_chainId"]);
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
