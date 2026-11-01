import {
  type ContractEventRecord,
  contractEventLog,
  replayEventAccumulator,
} from "@abolishus/crypto";
import { GameBlockError, type Rpc, RpcError } from "@abolishus/node";
import { OutputRootError, rollingChain, type RollingChainRelease } from "@abolishus/verifier";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";
import { definitionRegistered } from "../../../packages/verifier/tests/registration-logs.ts";
import { release, rolling, rollingTree } from "../../../packages/verifier/tests/registry-logs.ts";
import type { ProvenRegistryAccumulator, RegistryAccumulators } from "../src/output-root.ts";
import { l2RollingChain } from "../src/rolling-chain.ts";

// The deployment's rolling chain for intake (P2-17 part 7c-3b): both
// registries' whole logs from the seat's own L2 node, each replayed to its
// accumulator proven under one output root, the group registry's group
// events and the election's registration built into the chain by the
// verifier's `rollingChain`, with `safeAt` the proven block's timestamp. The
// records are rolling-tier-tree.json's `chain-order` tree as the group
// registry logs it (packages/verifier/tests/registry-logs.ts) and its
// definition's `DefinitionRegistered` at the vector's registration time
// (T-08, T-25, T-52, T-71).

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const same = (a: Uint8Array, b: Uint8Array) => hex(a) === hex(b);

const tree = rollingTree("chain-order");
const definition = rolling([tree.tier], tree.closesAt);
const registration = definitionRegistered(definition, undefined, undefined, 99n, tree.registeredAt);
const pinned: RollingChainRelease = {
  ...release,
  electionRegistry: definition.value.election_registry,
};
const HISTORY: readonly ContractEventRecord[] = [...tree.records, registration];

// The registries' deployment blocks; the tree's last event is at block 452.
const FROM_BLOCK = 1n;
const ELECTION_FROM_BLOCK = 50n;
const PROVEN_BLOCK = 500n;
const PROVEN_AT = 1_779_841_000n;
const FINALIZED = 600n;

/** An L2 node answering `eth_getLogs` from `held` by address and range, as a real one does. */
function l2Node(
  held: readonly ContractEventRecord[],
  options: { chain?: bigint; finalized?: bigint } = {},
) {
  const asked: { address: string; fromBlock: string; toBlock: string }[] = [];
  const rpc: Rpc = {
    call: async (method, params) => {
      if (method === "eth_chainId") return `0x${(options.chain ?? release.chainId).toString(16)}`;
      if (method === "eth_getBlockByNumber") {
        expect(params).toEqual(["finalized", false]);
        return { number: `0x${(options.finalized ?? FINALIZED).toString(16)}` };
      }
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      const [filter] = params as [{ address: string; fromBlock: string; toBlock: string }];
      asked.push({ address: filter.address, fromBlock: filter.fromBlock, toBlock: filter.toBlock });
      return held
        .filter(
          (r) =>
            hex(r.contract) === filter.address &&
            r.l2_block >= BigInt(filter.fromBlock) &&
            r.l2_block <= BigInt(filter.toBlock),
        )
        .map((r) => ({
          address: hex(r.contract),
          topics: r.topics.map(hex),
          data: hex(r.data),
          blockNumber: `0x${r.l2_block.toString(16)}`,
          blockTimestamp: `0x${r.l2_timestamp.toString(16)}`,
        }));
    },
  };
  return { rpc, asked };
}

/** `contract`'s accumulator after `block` over `history`, numbered in order, as a root proves it. */
const provenOf = (
  history: readonly ContractEventRecord[],
  contract: Uint8Array,
  block = PROVEN_BLOCK,
  timestamp = PROVEN_AT,
): ProvenRegistryAccumulator => ({
  block,
  timestamp,
  ...replayEventAccumulator(
    release.chainId,
    contract,
    history
      .filter((r) => same(r.contract, contract) && r.l2_block <= block)
      .map((r, i) => contractEventLog({ ...r, n: BigInt(i) })),
  ),
});

const provenOver =
  (history: readonly ContractEventRecord[], asked: bigint[] = []): RegistryAccumulators =>
  async (registries, atLeast) => {
    asked.push(atLeast);
    return registries.map((r) => provenOf(history, r));
  };

const chainOver = (
  rpc: Rpc,
  options: { accumulators?: RegistryAccumulators; fromBlock?: bigint } = {},
) =>
  l2RollingChain({
    ...pinned,
    l2: rpc,
    fromBlock: options.fromBlock ?? FROM_BLOCK,
    electionFromBlock: ELECTION_FROM_BLOCK,
    accumulators: options.accumulators ?? provenOver(HISTORY),
  });

const expected = () => {
  const outcome = rollingChain(definition, HISTORY, pinned);
  if (!("status" in outcome)) throw new Error(`the vectors' chain stops at ${outcome.check}`);
  return outcome.chain;
};

describe("l2RollingChain", () => {
  test("gives the verifier's chain over both registries' proven logs, with the proven block's timestamp", async () => {
    const { rpc, asked } = l2Node(HISTORY);
    const atLeast: bigint[] = [];
    const got = await chainOver(rpc, { accumulators: provenOver(HISTORY, atLeast) })(definition);
    expect(got).toEqual({ chain: expected(), safeAt: PROVEN_AT });
    expect(got?.chain.registeredAt).toBe(tree.registeredAt);
    // Proven at or after the opening state's block and both deployments,
    // and each registry's whole log read from its own deployment.
    expect(atLeast).toEqual([tree.tier.root_l2_block]);
    const to = `0x${PROVEN_BLOCK.toString(16)}`;
    expect(asked).toEqual([
      { address: hex(release.registry), fromBlock: `0x${FROM_BLOCK.toString(16)}`, toBlock: to },
      {
        address: hex(pinned.electionRegistry),
        fromBlock: `0x${ELECTION_FROM_BLOCK.toString(16)}`,
        toBlock: to,
      },
    ]);
    const later: bigint[] = [];
    await chainOver(rpc, { fromBlock: 200n, accumulators: provenOver(HISTORY, later) })(definition);
    expect(later).toEqual([200n]);
  });

  test("ignores the registries' other events, another election's registration among them", async () => {
    const other = rolling([tree.tier], tree.closesAt);
    const another = definitionRegistered(
      { ...other, value: { ...other.value, election_id: new Uint8Array(32).fill(0x0e) } },
      undefined,
      undefined,
      98n,
      tree.registeredAt - 1n,
    );
    // An event of no kind the recount reads, in the tree's last event's block.
    const last = tree.records.at(-1) as ContractEventRecord;
    const stray: ContractEventRecord = {
      ...last,
      topics: [new Uint8Array(32).fill(0x77)],
      data: Uint8Array.of(0x77),
    };
    const history = [...HISTORY, another, stray].sort((a, b) => Number(a.l2_block - b.l2_block));
    const got = await chainOver(l2Node(history).rpc, { accumulators: provenOver(history) })(
      definition,
    );
    expect(got).toEqual({ chain: expected(), safeAt: PROVEN_AT });
  });

  test("refuses a proven block the node hasn't finalized, or one short of the opening state's", async () => {
    expect(await chainOver(l2Node(HISTORY, { finalized: PROVEN_BLOCK - 1n }).rpc)(definition)).toBe(
      undefined,
    );
    const short: RegistryAccumulators = async (registries) =>
      registries.map((r) => provenOf(HISTORY, r, tree.tier.root_l2_block - 1n));
    expect(await chainOver(l2Node(HISTORY).rpc, { accumulators: short })(definition)).toBe(
      undefined,
    );
  });

  test("refuses the two registries proven at different blocks, or no root at all", async () => {
    const apart: RegistryAccumulators = async ([group, election]) => [
      provenOf(HISTORY, group as Uint8Array),
      provenOf(HISTORY, election as Uint8Array, PROVEN_BLOCK + 1n, PROVEN_AT + 2n),
    ];
    expect(await chainOver(l2Node(HISTORY).rpc, { accumulators: apart })(definition)).toBe(
      undefined,
    );
    const none: RegistryAccumulators = async () => undefined;
    expect(await chainOver(l2Node(HISTORY).rpc, { accumulators: none })(definition)).toBe(
      undefined,
    );
  });

  test("refuses a log the node hides or invents, which only the replay catches (T-71)", async () => {
    const withoutRegistration = HISTORY.filter((r) => r !== registration);
    // Served without the registration, proven with it.
    expect(await chainOver(l2Node(withoutRegistration).rpc)(definition)).toBe(undefined);
    // Served with a group record the proven history doesn't hold.
    expect(
      await chainOver(l2Node(HISTORY).rpc, { accumulators: provenOver(withoutRegistration) })(
        definition,
      ),
    ).toBe(undefined);
    const withoutJoin = HISTORY.filter((r) => r !== tree.records.at(-1));
    expect(
      await chainOver(l2Node(HISTORY).rpc, { accumulators: provenOver(withoutJoin) })(definition),
    ).toBe(undefined);
  });

  test("refuses a definition the registry never registered, or one whose opening state differs", async () => {
    const unregistered = HISTORY.filter((r) => r !== registration);
    expect(
      await chainOver(l2Node(unregistered).rpc, { accumulators: provenOver(unregistered) })(
        definition,
      ),
    ).toBe(undefined);
    const tier = { ...tree.tier, group_size: tree.tier.group_size + 1n };
    const overstated = rolling([tier], tree.closesAt);
    const records = [
      ...tree.records,
      definitionRegistered(overstated, undefined, undefined, 99n, tree.registeredAt),
    ];
    expect(
      await chainOver(l2Node(records).rpc, { accumulators: provenOver(records) })(overstated),
    ).toBe(undefined);
  });

  test("refuses a node of another chain, and resolves undefined on a node or root that fails", async () => {
    expect(await chainOver(l2Node(HISTORY, { chain: release.chainId + 1n }).rpc)(definition)).toBe(
      undefined,
    );
    for (const error of [
      new RpcError("down"),
      new OutputRootError("output-root"),
      new GameBlockError(),
    ]) {
      const failing: RegistryAccumulators = async () => {
        throw error;
      };
      expect(await chainOver(l2Node(HISTORY).rpc, { accumulators: failing })(definition)).toBe(
        undefined,
      );
    }
  });
});
