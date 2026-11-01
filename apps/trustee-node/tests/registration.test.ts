import {
  type ContractEventRecord,
  contractEventLog,
  replayEventAccumulator,
} from "@abolishus/crypto";
import { GameBlockError, type Rpc, RpcError } from "@abolishus/node";
import { OutputRootError } from "@abolishus/verifier";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  ceremonyRegistered,
  type Definition,
  definitionRegistered,
  KEY_SET,
  OTHER_KEY_SET,
  releaseOf,
  v1Definition,
  v5Definition,
} from "../../../packages/verifier/tests/registration-logs.ts";
import type { ProvenRegistryAccumulator, RegistryAccumulators } from "../src/output-root.ts";
import { l2RegistrationCheck } from "../src/registration.ts";

// The deployment's registration check (P2-13 parts 3b and 3d): the election
// registry's registration and the trustee registry's ceremony record from
// the seat's own L2 node, each registry's whole log replayed against its
// accumulator proven under one output root, and judged by the verifier's
// `registrationCheck` under the pinned registries. The logs are the
// registries' as they emit them (packages/verifier/tests/registration-logs.ts),
// with key-set.json's key set and hash (T-34, T-37, T-53, T-71). The proven
// accumulators are the honest histories', replayed here; tests/output-root.test.ts
// in apps/node proves one under a root.

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const numRuns = Number(process.env.FC_NUM_RUNS ?? 100);
// The election registry's deployment block, and the trustee registry's, before it.
const FROM_BLOCK = 5n;
const TRUSTEE_FROM_BLOCK = 3n;
// The block the output root is posted for: past the registration's (20).
const PROVEN_BLOCK = 40n;
// The seat's L2 node's finalized block: past the registration's, short of the root's.
const FINALIZED = 30n;

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

const same = (a: Uint8Array, b: Uint8Array) => hex(a) === hex(b);

/** An L2 node answering `eth_getLogs` from `held` by address and range, as a real one does. */
function l2Node(held: readonly ContractEventRecord[], chain: bigint, finalized = FINALIZED) {
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
        { address: string; fromBlock: string; toBlock: string; topics: string[] },
      ];
      asked.push(filter);
      expect(filter.topics).toEqual([]);
      return held
        .map(logOf)
        .filter(
          (l) =>
            l.address === filter.address &&
            BigInt(l.blockNumber) >= BigInt(filter.fromBlock) &&
            BigInt(l.blockNumber) <= BigInt(filter.toBlock),
        );
    },
  };
  return { rpc, asked };
}

/** A log of `contract` the check doesn't judge: another event, at `block`. */
const otherEvent = (contract: Uint8Array, block: bigint, fill: number): ContractEventRecord => ({
  contract,
  n: 0n,
  l2_block: block,
  l2_timestamp: 0n,
  topics: [new Uint8Array(32).fill(fill)],
  data: Uint8Array.of(fill),
});

const v5 = v5Definition();

/**
 * Each registry's history for `d`: the trustee registry's panel pinned at
 * its deployment and the ceremony record; the election registry's election
 * created, another election's registration and `d`'s.
 */
const honest = (d: Definition = v5, version?: number): ContractEventRecord[] => {
  const other = {
    ...d,
    value: { ...d.value, election_id: new Uint8Array(32).fill(0x0e) },
  } as Definition;
  return [
    otherEvent(d.value.trustee_registry, TRUSTEE_FROM_BLOCK, 0x71),
    otherEvent(d.value.election_registry, FROM_BLOCK + 1n, 0x72),
    definitionRegistered(other, undefined, undefined, 12n),
    ceremonyRegistered(d, version === undefined ? {} : { version }),
    definitionRegistered(d),
  ];
};

/** `contract`'s accumulator after `block` over `history`, numbered in order, as a root proves it. */
const provenOf = (
  history: readonly ContractEventRecord[],
  chainId: bigint,
  contract: Uint8Array,
  block = PROVEN_BLOCK,
): ProvenRegistryAccumulator => ({
  block,
  // Any timestamp: these checks read the block, not its time.
  timestamp: block,
  ...replayEventAccumulator(
    chainId,
    contract,
    history
      .filter((r) => same(r.contract, contract) && r.l2_block <= block)
      .map((r, i) => contractEventLog({ ...r, n: BigInt(i) })),
  ),
});

/** Both registries' accumulators proven over `history` at `block`. */
const provenOver =
  (history: readonly ContractEventRecord[], chainId: bigint, block = PROVEN_BLOCK) =>
  (asked: ProvenAsked[] = []): RegistryAccumulators =>
  async (registries, atLeast) => {
    asked.push({ registries: registries.map(hex), atLeast });
    return registries.map((r) => provenOf(history, chainId, r, block));
  };

interface ProvenAsked {
  readonly registries: readonly string[];
  readonly atLeast: bigint;
}

/**
 * The check over a node serving `served`, with the accumulators proven over
 * `options.honest`, the registries' true history (by default what is served).
 */
const check = (
  rpc: Rpc,
  d: Definition,
  options: {
    honest?: readonly ContractEventRecord[];
    served?: readonly ContractEventRecord[];
    fromBlock?: bigint;
    trusteeFromBlock?: bigint;
    accumulators?: RegistryAccumulators;
    release?: Definition;
  } = {},
) =>
  l2RegistrationCheck({
    ...releaseOf(options.release ?? d),
    l2: rpc,
    fromBlock: options.fromBlock ?? FROM_BLOCK,
    trusteeFromBlock: options.trusteeFromBlock ?? TRUSTEE_FROM_BLOCK,
    accumulators:
      options.accumulators ??
      provenOver(options.honest ?? options.served ?? honest(d), d.value.l2_chain_id)(),
  });

/** The check of `d` over a node serving `served`, proven over `honestHistory`. */
const judge = async (
  served: readonly ContractEventRecord[],
  d: Definition = v5,
  honestHistory: readonly ContractEventRecord[] = served,
  keySet = KEY_SET,
) => check(l2Node(served, d.value.l2_chain_id).rpc, d, { honest: honestHistory })(d, keySet);

describe("l2RegistrationCheck", () => {
  test("passes a definition proven history shows registered over the approved ceremony and key set", async () => {
    expect(await judge(honest())).toBe(true);
    const v1 = v1Definition(1);
    expect(await judge(honest(v1, 1), v1)).toBe(true);
  });

  test("asks for both accumulators under one root at or after both deployments, then each registry's whole log from its own deployment to the proven block", async () => {
    const { rpc, asked } = l2Node(honest(), v5.value.l2_chain_id);
    const proven: ProvenAsked[] = [];
    const accumulators = provenOver(honest(), v5.value.l2_chain_id)(proven);
    expect(await check(rpc, v5, { accumulators })(v5, KEY_SET)).toBe(true);
    expect(proven).toEqual([
      {
        registries: [hex(v5.value.election_registry), hex(v5.value.trustee_registry)],
        atLeast: FROM_BLOCK,
      },
    ]);
    const to = `0x${PROVEN_BLOCK.toString(16)}`;
    expect(asked).toEqual([
      {
        address: hex(v5.value.election_registry),
        fromBlock: `0x${FROM_BLOCK.toString(16)}`,
        toBlock: to,
        topics: [],
      },
      {
        address: hex(v5.value.trustee_registry),
        fromBlock: `0x${TRUSTEE_FROM_BLOCK.toString(16)}`,
        toBlock: to,
        topics: [],
      },
    ]);
    // The later of the two deployments, whichever registry's it is.
    const later: ProvenAsked[] = [];
    await check(rpc, v5, {
      trusteeFromBlock: 8n,
      fromBlock: 2n,
      accumulators: provenOver(honest(), v5.value.l2_chain_id)(later),
    })(v5, KEY_SET);
    expect(later[0]?.atLeast).toBe(8n);
  });

  test("refuses another key set, a missing registration or ceremony, and a second registration", async () => {
    expect(await judge(honest(), v5, honest(), OTHER_KEY_SET)).toBe(false);
    const [pinned, created, other, ceremony, registration] = honest() as [
      ContractEventRecord,
      ContractEventRecord,
      ContractEventRecord,
      ContractEventRecord,
      ContractEventRecord,
    ];
    // Absent from the proven history too: the replay passes, the check doesn't.
    expect(await judge([pinned, created, other, ceremony])).toBe(false);
    expect(await judge([pinned, created, other, registration])).toBe(false);
    const again = definitionRegistered(v5, undefined, undefined, 30n);
    expect(await judge([...honest(), again])).toBe(false);
  });

  test("refuses a registration or ceremony record the node invents, which only the replay catches", async () => {
    const [pinned, created, other, ceremony, registration] = honest() as [
      ContractEventRecord,
      ContractEventRecord,
      ContractEventRecord,
      ContractEventRecord,
      ContractEventRecord,
    ];
    // Without the accumulators' evidence the logs served would pass.
    const withoutRegistration = [pinned, created, other, ceremony];
    expect(await judge(honest(), v5, withoutRegistration)).toBe(false);
    const withoutCeremony = [pinned, created, other, registration];
    expect(await judge(honest(), v5, withoutCeremony)).toBe(false);
    // Nor a registration moved to another block.
    const moved = definitionRegistered(v5, undefined, undefined, 21n);
    expect(await judge([pinned, created, other, ceremony, moved], v5, honest())).toBe(false);
  });

  test("refuses when the node hides or reorders any log of either registry, judged or not", async () => {
    const all = honest();
    for (let i = 0; i < all.length; i++)
      expect(
        await judge(
          all.filter((_, j) => j !== i),
          v5,
          all,
        ),
        `log ${i}`,
      ).toBe(false);
    const [pinned, created, other, ceremony, registration] = all as [
      ContractEventRecord,
      ContractEventRecord,
      ContractEventRecord,
      ContractEventRecord,
      ContractEventRecord,
    ];
    // Another election's registration and this one's, in each other's place.
    const swapped = [
      pinned,
      created,
      { ...registration, l2_block: other.l2_block },
      ceremony,
      { ...other, l2_block: registration.l2_block },
    ];
    expect(await judge(swapped, v5, all)).toBe(false);
  });

  test("refuses any served history but the proven one's (property)", async () => {
    const all = honest();
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(all.map((_, i) => i)),
        fc.option(fc.integer({ min: 0, max: all.length - 1 }), { nil: undefined }),
        async (kept, doubled) => {
          const indices = doubled === undefined ? kept : [...kept, doubled];
          const served = indices.map((i) => all[i] as ContractEventRecord);
          // The node serves each registry's log apart, so only each one's order counts.
          const of = (is: readonly number[], c: Uint8Array) =>
            is.filter((i) => same((all[i] as ContractEventRecord).contract, c)).join();
          const whole = all.map((_, i) => i);
          const proven = [v5.value.election_registry, v5.value.trustee_registry].every(
            (c) => of(indices, c) === of(whole, c),
          );
          expect(await judge(served, v5, all)).toBe(proven);
        },
      ),
      { numRuns },
    );
  });

  test("refuses a registration past the proven block until a root reaches it", async () => {
    // Registered in block 20, proven only to block 19.
    const node = l2Node(honest(), v5.value.l2_chain_id);
    const at = (block: bigint) => provenOver(honest(), v5.value.l2_chain_id, block)();
    expect(await check(node.rpc, v5, { accumulators: at(19n) })(v5, KEY_SET)).toBe(false);
    expect(await check(node.rpc, v5, { accumulators: at(20n) })(v5, KEY_SET)).toBe(true);
  });

  test("refuses a registration or ceremony record not finalized yet, though a root past it proves it", async () => {
    // Registered in block 20 and the ceremony in 15: a game may claim an
    // unsafe block's root, and the seat keeps a pass (T-34, T-71).
    const at = (finalized: bigint) =>
      check(l2Node(honest(), v5.value.l2_chain_id, finalized).rpc, v5)(v5, KEY_SET);
    expect(await at(19n)).toBe(false);
    expect(await at(14n)).toBe(false);
    expect(await at(20n)).toBe(true);
  });

  test("refuses, reading no log, with no root yet or one below either registry's deployment", async () => {
    const node = l2Node(honest(), v5.value.l2_chain_id);
    const none: RegistryAccumulators = async () => undefined;
    expect(await check(node.rpc, v5, { accumulators: none })(v5, KEY_SET)).toBe(false);
    const short: RegistryAccumulators = async (registries) =>
      registries.slice(1).map((r) => provenOf(honest(), v5.value.l2_chain_id, r));
    expect(await check(node.rpc, v5, { accumulators: short })(v5, KEY_SET)).toBe(false);
    const below = provenOver(honest(), v5.value.l2_chain_id, FROM_BLOCK - 1n)();
    expect(await check(node.rpc, v5, { accumulators: below })(v5, KEY_SET)).toBe(false);
    expect(node.asked).toEqual([]);
  });

  test("refuses when either log is read from after its registry's first log", async () => {
    // Each replay from its first event is then short of the proven count.
    const { rpc } = l2Node(honest(), v5.value.l2_chain_id);
    expect(await check(rpc, v5, { fromBlock: FROM_BLOCK + 2n })(v5, KEY_SET)).toBe(false);
    expect(await check(rpc, v5, { trusteeFromBlock: TRUSTEE_FROM_BLOCK + 1n })(v5, KEY_SET)).toBe(
      false,
    );
  });

  test("refuses a node of another chain, reading nothing, or a definition naming other registries", async () => {
    const other = l2Node(honest(), v5.value.l2_chain_id + 1n);
    const proven: ProvenAsked[] = [];
    const accumulators = provenOver(honest(), v5.value.l2_chain_id)(proven);
    expect(await check(other.rpc, v5, { accumulators })(v5, KEY_SET)).toBe(false);
    expect([other.asked, proven]).toEqual([[], []]);
    const moved = {
      ...v5,
      value: { ...v5.value, trustee_registry: new Uint8Array(20).fill(0x77) },
    };
    const { rpc } = l2Node(honest(moved), moved.value.l2_chain_id);
    expect(await check(rpc, moved, { release: v5 })(moved, KEY_SET)).toBe(false);
    expect(await check(rpc, moved)(moved, KEY_SET)).toBe(true);
  });

  test("refuses when a node can't be read or doesn't prove, and rethrows anything else", async () => {
    const unreadable: Rpc = {
      call: () => Promise.reject(new RpcError("eth_chainId: unreachable")),
    };
    expect(await check(unreadable, v5)(v5, KEY_SET)).toBe(false);
    const broken: Rpc = { call: () => Promise.reject(new TypeError("bug")) };
    await expect(check(broken, v5)(v5, KEY_SET)).rejects.toThrow(TypeError);
    const { rpc } = l2Node(honest(), v5.value.l2_chain_id);
    for (const error of [
      new RpcError("down"),
      new OutputRootError("output-root"),
      new GameBlockError(),
      new RangeError("past a u64"),
    ]) {
      const accumulators: RegistryAccumulators = () => Promise.reject(error);
      expect(await check(rpc, v5, { accumulators })(v5, KEY_SET), error.name).toBe(false);
    }
    const bug: RegistryAccumulators = () => Promise.reject(new TypeError("bug"));
    await expect(check(rpc, v5, { accumulators: bug })(v5, KEY_SET)).rejects.toThrow("bug");
  });
});
