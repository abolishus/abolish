// The Railway variables `admin-cli deployment variables` prints (P2-32 part
// 2b) are read by this worker's own parsers, so a value core prints in a
// form a service refuses fails here, not on deploy day. The chain files are
// core's fixtures, the deploy script's output on the local Anvil pair; what
// isn't the deployment's (URLs, keys, receipt keys, creation blocks) is
// filled in as the owner would.

import { readFileSync } from "node:fs";
import { deploymentVariables } from "@abolishus/core";
import { describe, expect, test } from "vite-plus/test";
import { pinnedPanels } from "../src/ballot-env.ts";
import {
  pollCreationFromEnv,
  pollRootFromEnv,
  pollStubFromEnv,
  postingFromEnv,
  registrySyncFromEnv,
  tier0FromEnv,
} from "../src/index.ts";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/core/tests/fixtures/deployment/${name}`, import.meta.url),
      "utf8",
    ),
  );

const INPUTS = {
  l2FromBlock: "0",
  l2MaxSequencerDrift: 1800,
  disputeGameTypes: [0, 1],
  ours: [true, true, true, true, true, true, true],
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

const { built, services } = deploymentVariables(
  fixture("31337.json"),
  fixture("31338.json"),
  INPUTS,
  "https://api.staging.example",
);
const v = built.record.value;
const setup = services["setup-worker"] ?? {};
const KEY = `0x${"aa".repeat(32)}`;
const L2_RPC = "https://l2.example/v2/provider-api-key";
const L1_RPC = "https://l1.example/v2/provider-api-key";
const panel = v.panels[0];
const pick = (vars: Readonly<Record<string, string>> | undefined, prefix: string) =>
  Object.fromEntries(Object.entries(vars ?? {}).filter(([name]) => name.startsWith(prefix)));

describe("the deployment's variables, as the worker reads them", () => {
  test("the creation step", () => {
    const config = pollCreationFromEnv(
      {
        ...services["creation-worker"],
        CREATE_L2_RPC_URL: L2_RPC,
        CREATE_L1_RPC_URL: L1_RPC,
        CREATE_KEY: KEY,
      },
      10,
    );
    expect(config?.chainId).toBe(v.l2_chain_id);
    expect(config?.l1ChainId).toBe(v.l1_chain_id);
    expect(config?.registry.toLowerCase()).toBe(
      `0x${Buffer.from(v.election_registry).toString("hex")}`,
    );
    expect(config?.anchor.toLowerCase()).toBe(`0x${Buffer.from(v.l1_anchor).toString("hex")}`);
    expect(config?.panel).toEqual({
      threshold: panel?.threshold,
      keys: panel?.seats.map((s) => s.key),
    });
  });

  test("the stub and roots steps", () => {
    const stub = pollStubFromEnv({
      ...pick(setup, "POLL_STUB_"),
      POLL_STUB_RECEIPT_KEYS: `02${"11".repeat(32)}`,
      POLL_STUB_INCLUSION_BOUND: "3600",
      POLL_STUB_SEQUENCING_WINDOW: "43200",
    });
    expect(stub?.panel).toEqual({
      threshold: panel?.threshold,
      keys: panel?.seats.map((s) => s.key),
    });
    expect(stub?.maxSequencerDrift).toBe(v.l2_max_sequencer_drift);
    const roots = pollRootFromEnv(pick(setup, "POLL_ROOT_"));
    expect(roots?.groups.get(0)?.map((g) => g.group_id)).toEqual([1n, 2n]);
    expect(roots?.threshold).toBe(v.registrar_threshold);
    expect(roots?.registrars).toHaveLength(v.registrars.length);
  });

  test("the registry sync", () => {
    const sync = registrySyncFromEnv({
      ...pick(setup, "REGISTRY_SYNC_"),
      REGISTRY_SYNC_INDEX_URL: "postgres://reader:secret@index:5432/ponder",
      REGISTRY_SYNC_INDEX_SCHEMA: "indexer",
      REGISTRY_SYNC_L2_RPC_URL: L2_RPC,
      REGISTRY_SYNC_L1_RPC_URL: L1_RPC,
    });
    expect(sync?.chainId).toBe(v.l2_chain_id);
    expect(sync?.l1ChainId).toBe(v.l1_chain_id);
    expect(sync?.eventVersion).toBe(13);
    expect(sync?.board.toLowerCase()).toBe(`0x${Buffer.from(v.board).toString("hex")}`);
  });

  test("the Tier 0 job", () => {
    const tier0 = tier0FromEnv({
      ...pick(setup, "TIER0_"),
      TIER0_L2_RPC_URL: L2_RPC,
      TIER0_BUNDLER_URL: "https://bundler.example/v2/provider-api-key",
      TIER0_REGISTRY_BLOCK: "1",
      TIER0_SIGNER_KEYS: `1:${KEY},2:${`0x${"bb".repeat(32)}`}`,
      TIER0_ACCOUNT_KEY: `0x${"cc".repeat(32)}`,
    });
    expect(tier0?.chainId).toBe(v.l2_chain_id);
    expect(tier0?.group).toBe(1n);
    expect(tier0?.threshold).toBe(v.registrar_threshold);
  });

  test("ballot admission and the posting worker", () => {
    const expected = v.panels.map((p) => ({
      threshold: p.threshold,
      keys: p.seats.map((s) => s.key),
    }));
    expect(pinnedPanels(setup["BALLOT_PINNED_PANELS"] ?? "")).toEqual(expected);
    const posting = services["posting-worker"] ?? {};
    expect(pinnedPanels(posting["BALLOT_PINNED_PANELS"] ?? "")).toEqual(expected);
    const config = postingFromEnv({
      ...pick(posting, "POSTING_"),
      POSTING_REDIS_URL: "redis://:store-password@posting-store:6379",
      POSTING_L2_RPC_URL: L2_RPC,
      POSTING_BOARD_BLOCK: "1",
      POSTING_KEY: KEY,
      POSTING_FEE_CAP: "1000000000",
      POSTING_ELECTION_BUDGET: "50000000000000000",
      POSTING_L1_RPC_URL: L1_RPC,
      POSTING_L1_FEE_CAP: "30000000000",
    });
    expect(config?.chainId).toBe(v.l2_chain_id);
    expect(config?.board.toLowerCase()).toBe(`0x${Buffer.from(v.board).toString("hex")}`);
  });
});
