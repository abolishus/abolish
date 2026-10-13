import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeElectionDefinition, identityKey, panelId } from "@abolishus/crypto";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { cli } from "../src/cli.ts";
import { LocalCoordinator, serveCoordinator } from "../src/local.ts";
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
