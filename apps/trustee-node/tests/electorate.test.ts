import {
  type ContractEventRecord,
  contractEventLog,
  type ProvenEventAccumulator,
  replayEventAccumulator,
} from "@abolishus/crypto";
import { GameBlockError, type Rpc, RpcError } from "@abolishus/node";
import { OutputRootError } from "@abolishus/verifier";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";
import {
  added,
  chainId,
  logs,
  selfPaidTiers,
  registry,
  release,
  removed,
  ROOT_BLOCK,
  tierOf,
  v1,
  v5,
} from "../../../packages/verifier/tests/registry-logs.ts";
import { l2ElectorateCheck } from "../src/electorate.ts";
import type { Stub } from "../src/stub.ts";

// The deployment's electorate check (P2-13 part 3): the group registry's
// log from the seat's own L2 node, in finalized history, replayed against
// the registry's accumulator proven under an output root (part 3c) and
// recounted by the verifier's 2.4 under the pinned registry and registrars.
// The logs are regional-cells.json's tiers as the registry emits them
// (packages/verifier/tests/registry-logs.ts), and each stated electorate is
// the vectors' (T-13, T-16, T-71). The proven accumulator is the honest
// history's, replayed here; tests/output-root.test.ts in apps/node proves
// one under a root.

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const FROM_BLOCK = 5n;
// The block the output root is posted for: past every tier's root block.
const PROVEN_BLOCK = ROOT_BLOCK + 20n;

interface Log {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly blockTimestamp: string;
}

const logOf = (r: ContractEventRecord): Log => ({
  address: hex(r.contract),
  topics: r.topics.map(hex),
  data: hex(r.data),
  blockNumber: `0x${r.l2_block.toString(16)}`,
  blockTimestamp: `0x${r.l2_timestamp.toString(16)}`,
});

/**
 * An L2 node answering `eth_getLogs` from `held` by address, range and
 * topics, as a real one does, with each log's block time.
 */
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
            (filter.topics[0] === undefined || filter.topics[0].includes(l.topics[0] as string)),
        );
    },
  };
  return { rpc, asked };
}

/** The registry's accumulator after `block` over its whole history `records`, as a root proves it. */
const provenOf = (
  records: readonly ContractEventRecord[],
  block = PROVEN_BLOCK,
): ProvenEventAccumulator => ({
  block,
  ...replayEventAccumulator(
    chainId,
    registry,
    records.filter((r) => r.l2_block <= block).map(contractEventLog),
  ),
});

/**
 * The check over `rpc`, with the accumulator proven over `honest`, the
 * registry's true history (by default what the node serves).
 */
const check = (
  node: { rpc: Rpc; held: readonly ContractEventRecord[] },
  options: {
    fromBlock?: bigint;
    honest?: readonly ContractEventRecord[];
    accumulator?: () => Promise<ProvenEventAccumulator | undefined>;
  } = {},
) =>
  l2ElectorateCheck({
    ...release,
    l2: node.rpc,
    fromBlock: options.fromBlock ?? FROM_BLOCK,
    accumulators: async (registries) => {
      expect(registries).toEqual([registry]);
      const proven = await (
        options.accumulator ?? (async () => provenOf(options.honest ?? node.held))
      )();
      return proven === undefined ? undefined : [proven];
    },
  });

const nodeOf = (held: readonly ContractEventRecord[], finalized?: bigint, chain?: bigint) => ({
  ...l2Node(held, finalized, chain),
  held,
});

const one = tierOf("one-group");
const stubOf = (t = one): Stub => v5([t.electorate]);

describe("l2ElectorateCheck", () => {
  test("passes a stub whose tiers are the registry's finalized history's", async () => {
    for (const id of ["one-group", "repeat-moves-a-voter"]) {
      const t = tierOf(id);
      expect(await check(nodeOf(t.records))(stubOf(t)), id).toBe(true);
    }
    const [cell] = one.electorate.cells;
    const tier = {
      tier: 0 as const,
      group_id: one.electorate.groups[0]?.group_id as bigint,
      root: cell?.root as bigint,
      root_l2_block: ROOT_BLOCK,
      group_size: cell?.members as bigint,
    };
    expect(await check(nodeOf(one.records))(v1([tier]))).toBe(true);
    expect(await check(nodeOf(one.records))(v1([{ ...tier, group_size: 1n }]))).toBe(false);
  });

  test("reads every log of the pinned registry from its deployment block to the proven block", async () => {
    const node = nodeOf(one.records, ROOT_BLOCK + 50n);
    expect(await check(node)(stubOf())).toBe(true);
    expect(node.asked).toEqual([
      {
        address: hex(registry),
        fromBlock: `0x${FROM_BLOCK.toString(16)}`,
        toBlock: `0x${PROVEN_BLOCK.toString(16)}`,
        topics: [],
      },
    ]);
  });

  test("replays another event of the registry, but recounts only the group events", async () => {
    const other = {
      ...(one.records[1] as ContractEventRecord),
      topics: [new Uint8Array(32).fill(0x4e), new Uint8Array(32)],
    };
    expect(await check(nodeOf([...one.records, other]))(stubOf())).toBe(true);
    // Left out by the node, it is still in the accumulator.
    expect(await check(nodeOf(one.records), { honest: [...one.records, other] })(stubOf())).toBe(
      false,
    );
  });

  test("recounts only up to the stub's root block, though it replays up to the proven one", async () => {
    // A removal after the root block, which the stub's root rightly predates.
    const [removal] = logs(
      [
        {
          ...removed(one.electorate.groups[0]?.group_id as bigint, 1n, [0n]),
          block: ROOT_BLOCK + 5n,
        },
      ],
      one.records.length,
    );
    expect(await check(nodeOf([...one.records, removal as ContractEventRecord]))(stubOf())).toBe(
      true,
    );
  });

  test("refuses a node hiding a log the recount alone can't miss, or inventing one", async () => {
    // T-71: a later addition hidden leaves the stub's root reachable by the
    // logs shown, so only the accumulator refuses it.
    const group = one.electorate.groups[0]?.group_id as bigint;
    const extra = logs([{ ...added(group, 1n, [123_456_789n]), block: ROOT_BLOCK - 1n }]);
    const hidden = nodeOf(one.records);
    expect(await check(hidden, { honest: [...one.records, ...extra] })(stubOf())).toBe(false);
    // Without the accumulator's evidence the logs shown would pass.
    expect(await check(hidden)(stubOf())).toBe(true);
    // A self-paid group the node invents, which needs no signature.
    const invented = logs([{ kind: "self-paid-created", groupId: 99n, block: 20n }]);
    expect(
      await check(nodeOf([...one.records, ...invented]), { honest: one.records })(stubOf()),
    ).toBe(false);
  });

  test("refuses a node that moves a log to another time, or reorders the log", async () => {
    const moved = one.records.map((r, i) =>
      i === 1 ? { ...r, l2_timestamp: r.l2_timestamp + 1n } : r,
    );
    expect(await check(nodeOf(moved), { honest: one.records })(stubOf())).toBe(false);
    const swapped = [one.records[0], one.records[2], one.records[1], ...one.records.slice(3)].map(
      (r) => r as ContractEventRecord,
    );
    expect(await check(nodeOf(swapped), { honest: one.records })(stubOf())).toBe(false);
  });

  test("passes self-paid.json's tiers, ranked in the order the log holds, and refuses them reordered", async () => {
    let reordered = 0;
    for (const t of selfPaidTiers) {
      expect(await check(nodeOf(t.records))(v5([t.electorate])), t.id).toBe(true);
      // The self-paid additions after the creations, in reverse.
      const created = t.records.filter((r) => r.data.length === 0 || r.topics.length === 1);
      const rest = t.records.slice(created.length).reverse();
      if (rest.filter((r) => r.topics.length === 3).length < 2) continue;
      // Even an accumulator over the reordered history: the recount refuses it.
      expect(await check(nodeOf([...created, ...rest]))(v5([t.electorate])), t.id).toBe(false);
      reordered++;
    }
    expect(reordered).toBeGreaterThanOrEqual(4);
  });

  test("refuses on a node of another chain, reading no log", async () => {
    const other = nodeOf(one.records, ROOT_BLOCK, chainId + 1n);
    expect(await check(other)(stubOf())).toBe(false);
    expect(other.asked).toEqual([]);
  });

  test("refuses a stub stating another count, and a history missing a log", async () => {
    const e = one.electorate;
    expect(
      await check(nodeOf(one.records))(v5([{ ...e, regions: [(e.regions[0] as bigint) + 1n] }])),
    ).toBe(false);
    expect(await check(nodeOf(one.records.slice(0, -1)))(stubOf())).toBe(false);
  });

  test("refuses, reading no log, a root block not finalized yet, before the registry existed or past the proven block", async () => {
    const late = nodeOf(one.records, ROOT_BLOCK - 1n);
    expect(await check(late)(stubOf())).toBe(false);
    expect(late.asked).toEqual([]);
    const early = nodeOf(one.records);
    expect(await check(early, { fromBlock: ROOT_BLOCK + 1n })(stubOf())).toBe(false);
    expect(early.asked).toEqual([]);
    const unproven = nodeOf(one.records);
    const below = async () => provenOf(one.records, ROOT_BLOCK - 1n);
    expect(await check(unproven, { accumulator: below })(stubOf())).toBe(false);
    expect(await check(unproven, { accumulator: async () => undefined })(stubOf())).toBe(false);
    expect(unproven.asked).toEqual([]);
  });

  test("refuses when the log read starts after the registry's first log", async () => {
    // The replay from genesis is then short of the proven count.
    expect(await check(nodeOf(one.records), { fromBlock: 11n })(stubOf())).toBe(false);
  });

  test("refuses a stub naming another group registry or L2, whatever its logs show", async () => {
    const node = nodeOf(one.records);
    const s = v5([one.electorate]);
    expect(
      await check(node)({
        ...s,
        value: { ...s.value, group_registry: new Uint8Array(20).fill(9) },
      }),
    ).toBe(false);
    expect(await check(node)({ ...s, value: { ...s.value, l2_chain_id: chainId + 1n } })).toBe(
      false,
    );
  });

  test("refuses a Tier 1 tier, whose additions it doesn't count", async () => {
    const records = [...one.records, ...logs([{ kind: "created", groupId: 7n, tier: 1 }], 50)];
    const tier1 = { ...one.electorate, tier: 1 as const, groups: [{ group_id: 7n, region: 0 }] };
    expect(await check(nodeOf(records))(v5([one.electorate, tier1]))).toBe(false);
  });

  test("refuses when a node can't be read or doesn't prove, and rethrows anything else", async () => {
    const failing = (error: Error): Rpc => ({
      call: async (method) => {
        if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
        if (method === "eth_getBlockByNumber") return { number: `0x${ROOT_BLOCK.toString(16)}` };
        throw error;
      },
    });
    const node = (rpc: Rpc) => ({ rpc, held: one.records });
    expect(await check(node(failing(new RpcError("down"))))(stubOf())).toBe(false);
    await expect(check(node(failing(new TypeError("bug"))))(stubOf())).rejects.toThrow("bug");
    const notAList: Rpc = {
      call: async (method) =>
        method === "eth_getLogs"
          ? { logs: [] }
          : method === "eth_chainId"
            ? `0x${chainId.toString(16)}`
            : { number: `0x${ROOT_BLOCK.toString(16)}` },
    };
    expect(await check(node(notAList))(stubOf())).toBe(false);
    for (const error of [
      new RpcError("down"),
      new OutputRootError("output-root"),
      new GameBlockError(),
    ]) {
      const accumulator = () => Promise.reject(error);
      expect(await check(nodeOf(one.records), { accumulator })(stubOf())).toBe(false);
    }
    const bug = () => Promise.reject(new TypeError("bug"));
    await expect(check(nodeOf(one.records), { accumulator: bug })(stubOf())).rejects.toThrow("bug");
  });
});
