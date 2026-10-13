import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeElectionDefinition, panelId } from "@abolishus/crypto";
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
  test("refuses every stub until the node has a production electorate check", async () => {
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
          pollSeconds: 1,
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
      expect(await running).toBe(0);
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
