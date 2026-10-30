import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeDeploymentRecord, deploymentHash } from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { run } from "../src/index.ts";

// The record is built offline: this connection throws if the command opens the database.
const noDatabase = () => {
  throw new Error("a deployment command opened the database");
};

async function cli(...argv: string[]) {
  const out: Record<string, unknown>[] = [];
  const err: Record<string, unknown>[] = [];
  const code = await run(argv, noDatabase, {
    out: (v) => out.push(JSON.parse(JSON.stringify(v))),
    err: (v) => err.push(JSON.parse(JSON.stringify(v))),
  });
  return { code, out, err };
}

// The deploy script's files from the local Anvil pair, as core's tests read them.
const FIXTURES = new URL("../../../packages/core/tests/fixtures/deployment/", import.meta.url)
  .pathname;
const L1 = join(FIXTURES, "31337.json");
const L2 = join(FIXTURES, "31338.json");

const INPUTS = {
  l2FromBlock: "0",
  l2MaxSequencerDrift: 1800,
  disputeGameTypes: [0, 1],
  ours: [true, false, false, false, false, false, false],
  groups: [
    { groupId: "1", tier: 0, selfPaid: false, region: 0 },
    { groupId: "2", tier: 0, selfPaid: true, region: 0 },
  ],
  api: ["https://api.staging.example"],
  l2Rpc: ["https://l2.staging.example"],
  l1Rpc: ["https://l1.staging.example"],
  backupRpId: "ballot-staging.example",
  backups: true,
  accountRpId: "staging.example",
  membershipZkeySha256: `0x${"11".repeat(32)}`,
  membershipWasmSha256: `0x${"22".repeat(32)}`,
  tier0TokenKeys: [],
  seatRelays: [],
};

function inputsFile(contents: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "abolish-deployment-")), "inputs.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("deployment record", () => {
  test("prints the record's encoding and its deployment hash", async () => {
    const r = await cli(
      "deployment",
      "record",
      "--l1",
      L1,
      "--l2",
      L2,
      "--inputs",
      inputsFile(INPUTS),
    );
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    const { version, record, deploymentHash: hash } = r.out[0] as Record<string, string>;
    const bytes = Uint8Array.from(Buffer.from(record ?? "", "hex"));
    expect(version).toBe(1);
    expect(decodeDeploymentRecord(bytes).version).toBe(1);
    expect(hash).toBe(Buffer.from(deploymentHash(bytes)).toString("hex"));
  });

  test("names the file and path of a malformed value, and the rule a record breaks", async () => {
    const malformed = await cli(
      "deployment",
      "record",
      "--l1",
      L1,
      "--l2",
      L2,
      "--inputs",
      inputsFile({ ...INPUTS, l2FromBlock: 0 }),
    );
    expect(malformed.code).toBe(1);
    expect(malformed.err).toEqual([{ error: "malformed", source: "inputs", path: ".l2FromBlock" }]);

    const illFormed = await cli(
      "deployment",
      "record",
      "--l1",
      L1,
      "--l2",
      L2,
      "--inputs",
      inputsFile({ ...INPUTS, groups: [] }),
    );
    expect(illFormed.code).toBe(1);
    expect(illFormed.err).toEqual([{ error: "ill-formed", failure: { rule: "groups-empty" } }]);

    // The two chain files given the other way round.
    const swapped = await cli(
      "deployment",
      "record",
      "--l1",
      L2,
      "--l2",
      L1,
      "--inputs",
      inputsFile(INPUTS),
    );
    expect(swapped.err).toEqual([{ error: "malformed", source: "l1", path: ".pins.anchor" }]);
  });

  test("refuses a file it can't read or parse, naming which", async () => {
    const missing = await cli(
      "deployment",
      "record",
      "--l1",
      join(FIXTURES, "none.json"),
      "--l2",
      L2,
      "--inputs",
      inputsFile(INPUTS),
    );
    expect(missing.code).toBe(1);
    expect(missing.err).toEqual([{ error: "unreadable", source: "l1" }]);
    const notJson = await cli(
      "deployment",
      "record",
      "--l1",
      L1,
      "--l2",
      L2,
      "--inputs",
      inputsFile("{"),
    );
    expect(notJson.err).toEqual([{ error: "malformed", source: "inputs", path: "." }]);
  });

  test("requires all three files", async () => {
    const r = await cli("deployment", "record", "--l1", L1, "--l2", L2);
    expect(r.code).toBe(2);
    expect(r.err[0]?.["error"]).toBe("usage");
  });
});
