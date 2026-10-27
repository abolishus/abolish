import { readFileSync } from "node:fs";
import type { ContractEventRecord } from "@abolishus/crypto";
import { type Rpc, RpcError } from "@abolishus/node";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";
import {
  chainId,
  logs,
  selfPaidTiers,
  registry,
  release,
  ROOT_BLOCK,
  tierOf,
  v1,
  v5,
} from "../../../packages/verifier/tests/registry-logs.ts";
import { l2ElectorateCheck } from "../src/electorate.ts";
import type { Stub } from "../src/stub.ts";

// The deployment's electorate check (P2-13 part 3): the group registry's
// log from the seat's own L2 node, in finalized history, recounted by the
// verifier's 2.4 under the pinned registry and registrars. The logs are
// regional-cells.json's tiers as the registry emits them
// (packages/verifier/tests/registry-logs.ts), and each stated electorate is
// the vectors' (T-13, T-16, T-71).

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
// Topic 0 of each group-registry event, from contract-event-v8.json's
// independent generator rather than the node's constants.
const GROUP_TOPICS = (
  JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/contract-event-v8.json", import.meta.url),
      "utf8",
    ),
  ) as { events: { signature: string; topic0: string }[] }
).events
  .filter((e) =>
    [
      "RegistrarsPinned(",
      "GroupCreated(",
      "MembersAdded(",
      "MembersRemoved(",
      "Tier1MemberAdded(",
      "SelfPaidGroupCreated(",
      "SelfPaidMemberAdded(",
    ].some((s) => e.signature.startsWith(s)),
  )
  .map((e) => `0x${e.topic0}`);
const FROM_BLOCK = 5n;

interface Log {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
}

const logOf = (r: ContractEventRecord): Log => ({
  address: hex(r.contract),
  topics: r.topics.map(hex),
  data: hex(r.data),
  blockNumber: `0x${r.l2_block.toString(16)}`,
});

/** An L2 node answering `eth_getLogs` from `held` by address and range, as a real one does. */
function l2Node(held: readonly ContractEventRecord[], finalized = ROOT_BLOCK, chain = chainId) {
  const asked: unknown[] = [];
  const rpc: Rpc = {
    call: async (method, params) => {
      if (method === "eth_chainId") return `0x${chain.toString(16)}`;
      if (method === "eth_getBlockByNumber") {
        expect(params).toEqual(["finalized", false]);
        return { number: `0x${finalized.toString(16)}` };
      }
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      const [filter] = params as [
        { address: string; fromBlock: string; toBlock: string; topics: string[][] },
      ];
      asked.push(filter);
      return held
        .map(logOf)
        .filter(
          (l) =>
            l.address === filter.address &&
            BigInt(l.blockNumber) >= BigInt(filter.fromBlock) &&
            BigInt(l.blockNumber) <= BigInt(filter.toBlock) &&
            (filter.topics[0] ?? []).includes(l.topics[0] as string),
        );
    },
  };
  return { rpc, asked };
}

const check = (rpc: Rpc, fromBlock = FROM_BLOCK) =>
  l2ElectorateCheck({ ...release, l2: rpc, fromBlock });

const one = tierOf("one-group");
const stubOf = (t = one): Stub => v5([t.electorate]);

describe("l2ElectorateCheck", () => {
  test("passes a stub whose tiers are the registry's finalized history's", async () => {
    for (const id of ["one-group", "repeat-moves-a-voter"]) {
      const t = tierOf(id);
      const { rpc } = l2Node(t.records);
      expect(await check(rpc)(stubOf(t)), id).toBe(true);
    }
    const [cell] = one.electorate.cells;
    const tier = {
      tier: 0 as const,
      group_id: one.electorate.groups[0]?.group_id as bigint,
      root: cell?.root as bigint,
      root_l2_block: ROOT_BLOCK,
      group_size: cell?.members as bigint,
    };
    expect(await check(l2Node(one.records).rpc)(v1([tier]))).toBe(true);
    expect(await check(l2Node(one.records).rpc)(v1([{ ...tier, group_size: 1n }]))).toBe(false);
  });

  test("reads every log of the pinned registry from its deployment block to the latest root block", async () => {
    const { rpc, asked } = l2Node(one.records, ROOT_BLOCK + 50n);
    expect(await check(rpc)(stubOf())).toBe(true);
    expect(asked).toEqual([
      {
        address: hex(registry),
        fromBlock: `0x${FROM_BLOCK.toString(16)}`,
        toBlock: `0x${ROOT_BLOCK.toString(16)}`,
        topics: [GROUP_TOPICS],
      },
    ]);
  });

  test("asks only for the group events, so another event of the registry can't fail the check", async () => {
    const other = {
      ...(one.records[1] as ContractEventRecord),
      topics: [new Uint8Array(32).fill(0x4e), new Uint8Array(32)],
    };
    expect(await check(l2Node([...one.records, other]).rpc)(stubOf())).toBe(true);
  });

  test("passes self-paid.json's tiers, ranked in the order the log holds, and refuses them reordered", async () => {
    let reordered = 0;
    for (const t of selfPaidTiers) {
      expect(await check(l2Node(t.records).rpc)(v5([t.electorate])), t.id).toBe(true);
      // The self-paid additions after the creations, in reverse.
      const created = t.records.filter((r) => r.data.length === 0 || r.topics.length === 1);
      const rest = t.records.slice(created.length).reverse();
      if (rest.filter((r) => r.topics.length === 3).length < 2) continue;
      expect(await check(l2Node([...created, ...rest]).rpc)(v5([t.electorate])), t.id).toBe(false);
      reordered++;
    }
    expect(reordered).toBeGreaterThanOrEqual(4);
  });

  test("refuses on a node of another chain, reading no log", async () => {
    const other = l2Node(one.records, ROOT_BLOCK, chainId + 1n);
    expect(await check(other.rpc)(stubOf())).toBe(false);
    expect(other.asked).toEqual([]);
  });

  test("refuses a stub stating another count, and a history missing a log", async () => {
    const { rpc } = l2Node(one.records);
    const e = one.electorate;
    expect(await check(rpc)(v5([{ ...e, regions: [(e.regions[0] as bigint) + 1n] }]))).toBe(false);
    expect(await check(l2Node(one.records.slice(0, -1)).rpc)(stubOf())).toBe(false);
  });

  test("refuses, reading no log, a root block not finalized yet or before the registry existed", async () => {
    const late = l2Node(one.records, ROOT_BLOCK - 1n);
    expect(await check(late.rpc)(stubOf())).toBe(false);
    expect(late.asked).toEqual([]);
    const early = l2Node(one.records);
    expect(await check(early.rpc, ROOT_BLOCK + 1n)(stubOf())).toBe(false);
    expect(early.asked).toEqual([]);
  });

  test("refuses a stub naming another group registry or L2, whatever its logs show", async () => {
    const { rpc } = l2Node(one.records);
    const s = v5([one.electorate]);
    expect(
      await check(rpc)({
        ...s,
        value: { ...s.value, group_registry: new Uint8Array(20).fill(9) },
      }),
    ).toBe(false);
    expect(await check(rpc)({ ...s, value: { ...s.value, l2_chain_id: chainId + 1n } })).toBe(
      false,
    );
  });

  test("refuses a Tier 1 tier, whose additions it doesn't count", async () => {
    const records = [...one.records, ...logs([{ kind: "created", groupId: 7n, tier: 1 }], 50)];
    const tier1 = { ...one.electorate, tier: 1 as const, groups: [{ group_id: 7n, region: 0 }] };
    expect(await check(l2Node(records).rpc)(v5([one.electorate, tier1]))).toBe(false);
  });

  test("refuses when the node can't be read, and rethrows anything else", async () => {
    const failing = (error: Error): Rpc => ({
      call: async (method) => {
        if (method === "eth_getBlockByNumber") return { number: `0x${ROOT_BLOCK.toString(16)}` };
        throw error;
      },
    });
    expect(await check(failing(new RpcError("down")))(stubOf())).toBe(false);
    await expect(check(failing(new TypeError("bug")))(stubOf())).rejects.toThrow("bug");
    const notAList: Rpc = {
      call: async (method) =>
        method === "eth_getLogs" ? { logs: [] } : { number: `0x${ROOT_BLOCK.toString(16)}` },
    };
    expect(await check(notAList)(stubOf())).toBe(false);
  });
});
