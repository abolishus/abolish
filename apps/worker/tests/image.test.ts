import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

// What the image runs (Dockerfile): the bundle in dist/, copied away from the
// repository so nothing resolves through node_modules, run by plain Node. One
// image serves the creation worker and the setup worker, told apart by their
// variables only (docs/runbooks/railway.md, Services), so each refusal below
// comes before Postgres, Redis or a chain is reached.

const pkg = fileURLToPath(new URL("..", import.meta.url));
const KEY = "c7".repeat(32);
const NOWHERE = { DATABASE_URL: "postgres://u:p@127.0.0.1:1/db", REDIS_URL: "redis://127.0.0.1:1" };
const CREATION = {
  CREATE_L2_RPC_URL: "https://l2.example/v2/provider-api-key",
  CREATE_CHAIN_ID: "84532",
  CREATE_REGISTRY: "0x00000000000000000000000000000000000000e1",
  CREATE_KEY: KEY,
  CREATE_L1_RPC_URL: "https://l1.example/v2/provider-api-key",
  CREATE_L1_CHAIN_ID: "11155111",
  CREATE_ANCHOR: "0x00000000000000000000000000000000000000a1",
  CREATE_PANEL_THRESHOLD: "2",
  CREATE_PANEL_KEYS: `02${"11".repeat(32)},03${"22".repeat(32)}`,
};

const POSTING = {
  POSTING_REDIS_URL: "redis://:store-password@127.0.0.1:1",
  POSTING_L2_RPC_URL: "https://l2.example/v2/provider-api-key",
  POSTING_CHAIN_ID: "84532",
  POSTING_BOARD: "0x00000000000000000000000000000000000000b0",
  POSTING_BOARD_BLOCK: "0",
  POSTING_KEY: KEY,
  POSTING_FEE_CAP: "1000000000",
  POSTING_ELECTION_BUDGET: "1000000000000000",
  POSTING_L1_RPC_URL: "https://l1.example/v2/provider-api-key",
  POSTING_L1_FEE_CAP: "30000000000",
};

const WALLET = generateKeyPairSync("rsa", { modulusLength: 4096 }).privateKey.export({
  format: "jwk",
});
const ARCHIVE = {
  ARCHIVE_ARWEAVE_URL: "https://arweave.example/provider-api-key",
  ARCHIVE_WALLET: JSON.stringify(WALLET),
  ARCHIVE_MAX_REWARD: "5000000000",
};

let dir: string;

beforeAll(() => {
  // Packed straight into a directory outside the repository, so nothing
  // resolves through node_modules and a concurrent build's dist/ is untouched.
  dir = mkdtempSync(join(tmpdir(), "abolish-worker-image-"));
  execFileSync("vp", ["pack", "--out-dir", dir], { cwd: pkg, stdio: "inherit" });
}, 120_000);
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Runs `file` from the copied bundle with exactly `env`, to its exit. */
async function run(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, args, {
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (output += d.toString()));
  const [code] = (await once(child, "exit")) as [number];
  return { code, output };
}

describe("the bundle", () => {
  test("main.mjs refuses to start without its database and Redis", async () => {
    const { code, output } = await run(["main.mjs"], {});
    expect(code).not.toBe(0);
    expect(output).toContain("DATABASE_URL");
    expect(output).toContain("REDIS_URL");
  }, 30_000);

  test("main.mjs refuses the creation key beside any other job's variable, never quoting it", async () => {
    for (const other of [
      { BALLOT_ANCHOR_EPOCH: "0" },
      { TIER0_CHAIN_ID: "84532" },
      { REGISTRY_SYNC_CHAIN_ID: "84532" },
      { POLL_STUB_PANEL_THRESHOLD: "2" },
    ]) {
      const { code, output } = await run(["main.mjs"], { ...NOWHERE, ...CREATION, ...other });
      expect(code).not.toBe(0);
      expect(output).toContain("a worker holding the creation key runs nothing else");
      expect(output).not.toContain(KEY);
      expect(output).not.toContain("provider-api-key");
    }
  }, 60_000);

  test("main.mjs refuses the archive without the anchoring runner, never quoting its wallet or node", async () => {
    for (const other of [{}, CREATION]) {
      const { code, output } = await run(["main.mjs"], { ...NOWHERE, ...ARCHIVE, ...other });
      expect(code).not.toBe(0);
      expect(output).toContain("the archive runs only beside the anchoring runner");
      expect(output).not.toContain(WALLET.d);
      expect(output).not.toContain("provider-api-key");
    }
  }, 60_000);

  test("main.mjs refuses the posting worker's variables, never quoting the key", async () => {
    const { code, output } = await run(["main.mjs"], { ...NOWHERE, ...POSTING });
    expect(code).not.toBe(0);
    expect(output).toContain("the posting worker's variables belong to posting.mjs alone");
    expect(output).not.toContain(KEY);
    expect(output).not.toContain("provider-api-key");
  }, 30_000);

  test("posting.mjs needs every one of its variables", async () => {
    const { code, output } = await run(["posting.mjs"], {});
    expect(code).not.toBe(0);
    expect(output).toContain("the posting worker needs every one of POSTING_REDIS_URL");
  }, 30_000);

  test("posting.mjs refuses the posting key beside any other job's variable, never quoting it", async () => {
    for (const other of [
      { REDIS_URL: NOWHERE.REDIS_URL },
      { CREATE_KEY: KEY },
      { TIER1_RELAY_KEY: KEY },
      { REGISTRY_SYNC_CHAIN_ID: "84532" },
      { ANCHOR_EXECUTOR_KEY: KEY },
      { ARCHIVE_WALLET: ARCHIVE.ARCHIVE_WALLET },
      { BALLOT_L1_CHAIN_ID: "11155111" },
    ]) {
      const { code, output } = await run(["posting.mjs"], {
        DATABASE_URL: NOWHERE.DATABASE_URL,
        ...POSTING,
        ...other,
      });
      expect(code).not.toBe(0);
      expect(output).toContain("the posting worker runs nothing else");
      expect(output).not.toContain(KEY);
      expect(output).not.toContain(WALLET.d);
      expect(output).not.toContain("provider-api-key");
      expect(output).not.toContain("store-password");
    }
  }, 60_000);

  test("posting.mjs reports an unreachable node by step, never quoting its URL", async () => {
    const { code, output } = await run(["posting.mjs"], {
      DATABASE_URL: NOWHERE.DATABASE_URL,
      ...POSTING,
      POSTING_L2_RPC_URL: "http://127.0.0.1:1/v2/provider-api-key",
      BALLOT_PINNED_PANELS: JSON.stringify([{ threshold: 1, keys: [`02${"11".repeat(32)}`] }]),
      BALLOT_ANCHOR_EPOCH: "0",
      BALLOT_ANCHOR_PERIOD: "3600",
    });
    expect(code).not.toBe(0);
    expect(output).toContain("the posting worker's startup check couldn't reach the L2 node");
    expect(output).not.toContain(KEY);
    expect(output).not.toContain("provider-api-key");
  }, 30_000);

  test("posting.mjs refuses a posting key out of secp256k1's range without quoting it", async () => {
    for (const key of ["00".repeat(32), "ff".repeat(32)]) {
      const { code, output } = await run(["posting.mjs"], {
        DATABASE_URL: NOWHERE.DATABASE_URL,
        ...POSTING,
        POSTING_KEY: key,
        BALLOT_PINNED_PANELS: JSON.stringify([{ threshold: 1, keys: [`02${"11".repeat(32)}`] }]),
        BALLOT_ANCHOR_EPOCH: "0",
        BALLOT_ANCHOR_PERIOD: "3600",
      });
      expect(code).not.toBe(0);
      expect(output).toContain("the posting key isn't a secp256k1 key");
      expect(output).not.toContain(key);
    }
  }, 30_000);

  test("creation-key.mjs needs the creation step's variables", async () => {
    const { code, output } = await run(["creation-key.mjs", "status"], {});
    expect(code).not.toBe(0);
    expect(output).toContain("the creation key's commands need the creation step's variables");
  }, 30_000);
});

describe("the Dockerfile", () => {
  const dockerfile = readFileSync(join(pkg, "Dockerfile"), "utf8");

  test("builds on the repository's Node, pinned by digest", () => {
    const node = readFileSync(new URL("../../../.node-version", import.meta.url), "utf8").trim();
    const from = dockerfile.match(/^FROM (\S+)$/m)?.[1] ?? "";
    expect(from).toMatch(
      new RegExp(`:${node.replaceAll(".", "\\.")}-[a-z-]+@sha256:[0-9a-f]{64}$`),
    );
  });

  test("runs the bundle as node, with no package manager", () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^CMD \["node", "main\.mjs"\]$/m);
    expect(dockerfile).toContain("rm -rf /usr/local/lib/node_modules /usr/local/bin/npm");
  });
});
