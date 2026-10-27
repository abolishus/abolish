import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type ContractEventRecord,
  encodeGroupAddition,
  encodeGroupRemoval,
  encodeSelfPaidAddition,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  groupRemovalDigest,
  type GroupRegistryPins,
  rollingTierEvents,
  type RollingTierEvent,
  rollingTierSteps,
  signGroupApproval,
  TierMembershipError,
  type TierMembershipErrorCode,
} from "../src/index.ts";
import { type RollingEvent, tierEvent } from "./rolling-tree.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// A rolling tier's events from the group registry's own records
// (docs/spec/membership.md, Rolling tier tree and Rolling checks; verifier
// 2.4; P2-17 part 4c). Each tree of rolling-tier-tree.json, printed by an
// independent Python generator, is logged here as the registry logs it,
// signed under group-registry.json's test registrars: the events read back
// and every opening state and step root are the vectors', never the code
// under test's (T-08, T-13, T-16, T-71).

const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as T;
const registryVectors = read<{
  readonly domain: { readonly chainId: number; readonly verifyingContract: string };
  readonly registrars: {
    readonly threshold: number;
    readonly secretKeys: readonly string[];
    readonly addresses: readonly string[];
  };
}>("group-registry.json");
// Topic 0 of each group-registry event, from the independent generator of
// contract-event-v8.json, so the logs built below are the registry's.
const eventVectors = read<{
  readonly events: readonly { readonly signature: string; readonly topic0: string }[];
}>("contract-event-v8.json");
const rolling = read<{
  readonly trees: readonly {
    readonly id: string;
    readonly groups: readonly string[];
    readonly events: readonly RollingEvent[];
    readonly rootL2Block: string;
    readonly registeredAt: string;
    readonly closesAt: string;
    readonly opening: { readonly root: string; readonly memberCount: string };
    readonly steps: readonly {
      readonly step: string;
      readonly root: string;
      readonly memberCount: string;
      readonly accepted: boolean;
    }[];
  }[];
}>("rolling-tier-tree.json");

const hex = (s: string | undefined) => {
  if (s === undefined || !/^(?:[0-9a-f]{2})*$/.test(s)) throw new Error(`not hex: ${s}`);
  return Uint8Array.from(Buffer.from(s, "hex"));
};
const word = (v: bigint) => hex(v.toString(16).padStart(64, "0"));
const abiBytes = (b: Uint8Array) => {
  const padded = new Uint8Array(Math.ceil(b.length / 32) * 32);
  padded.set(b);
  return Uint8Array.from([...word(32n), ...word(BigInt(b.length)), ...padded]);
};
const topic0 = (signature: string) => {
  const found = eventVectors.events.find((e) => e.signature === signature);
  if (found === undefined) throw new Error(`no event ${signature}`);
  expect(Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString("hex")).toBe(
    found.topic0,
  );
  return hex(found.topic0);
};
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const registry = hex(registryVectors.domain.verifyingContract);
const chainId = BigInt(registryVectors.domain.chainId);
// The contract-event version a rolling profile pins beside ballot version 5.
const pins: GroupRegistryPins = {
  version: 11,
  chainId,
  registry,
  registrars: registryVectors.registrars.addresses.map(hex),
  threshold: registryVectors.registrars.threshold,
};
const domain = groupRegistryDomainSeparator(chainId, registry);
const keys = registryVectors.registrars.secretKeys.map(hex);

/** A registry event at an L2 block and timestamp, before `logs` numbers it. */
type Logged = { readonly block: bigint; readonly timestamp: bigint } & (
  | { readonly kind: "created"; readonly groupId: bigint; readonly tier: number }
  | { readonly kind: "self-paid-created"; readonly groupId: bigint }
  | { readonly kind: "added"; readonly groupId: bigint; readonly record: Uint8Array }
  | { readonly kind: "removed"; readonly groupId: bigint; readonly record: Uint8Array }
  | {
      readonly kind: "self-paid";
      readonly groupId: bigint;
      readonly index: bigint;
      readonly record: Uint8Array;
    }
);

const approve = (digest: Uint8Array, t = pins.threshold) =>
  keys.slice(0, t).map((k, i) => signGroupApproval(digest, i + 1, new Uint8Array(k)));

const addedRecord = (
  groupId: bigint,
  firstIndex: bigint,
  commitments: readonly bigint[],
  t?: number,
) =>
  encodeGroupAddition({
    groupId,
    firstIndex,
    commitments,
    approvals: approve(
      groupAdditionDigest(domain, { groupId, tier: 0, firstIndex, commitments }),
      t,
    ),
  });
const removedRecord = (groupId: bigint, size: bigint, indices: readonly bigint[]) =>
  encodeGroupRemoval({
    groupId,
    size,
    indices,
    approvals: approve(groupRemovalDigest(domain, { groupId, tier: 0, size, indices })),
  });

/** The registry's log of `events`, numbered from `n` in order. */
function logs(events: readonly Logged[], n = 0): ContractEventRecord[] {
  return events.map((e, i) => {
    const base = {
      contract: registry,
      n: BigInt(n + i),
      l2_block: e.block,
      l2_timestamp: e.timestamp,
    };
    switch (e.kind) {
      case "created":
        return {
          ...base,
          topics: [topic0("GroupCreated(uint64,uint8)"), word(e.groupId), word(BigInt(e.tier))],
          data: new Uint8Array(0),
        };
      case "self-paid-created":
        return {
          ...base,
          topics: [topic0("SelfPaidGroupCreated(uint64)"), word(e.groupId)],
          data: new Uint8Array(0),
        };
      case "added":
        return {
          ...base,
          topics: [
            topic0("MembersAdded(uint64,uint64,bytes)"),
            word(e.groupId),
            word(new DataView(e.record.buffer).getBigUint64(8, false)),
          ],
          data: abiBytes(e.record),
        };
      case "removed":
        return {
          ...base,
          topics: [topic0("MembersRemoved(uint64,bytes)"), word(e.groupId)],
          data: abiBytes(e.record),
        };
      case "self-paid":
        return {
          ...base,
          topics: [
            topic0("SelfPaidMemberAdded(uint64,uint64,bytes)"),
            word(e.groupId),
            word(e.index),
          ],
          data: abiBytes(e.record),
        };
    }
  });
}

/**
 * A vector tree's events as the registry logs them: every group the tree
 * names created at block 1, then each event signed at the group's running
 * count, at the vector's block and timestamp.
 */
function treeLog(events: readonly RollingEvent[]): Logged[] {
  const ids = [...new Set(events.map((e) => BigInt(e.group)))].sort((a, b) => (a < b ? -1 : 1));
  const first = BigInt((events[0] as RollingEvent).timestamp) - 1_000n;
  const out: Logged[] = ids.map((groupId) => ({
    kind: "created",
    groupId,
    tier: 0,
    block: 1n,
    timestamp: first,
  }));
  const count = new Map<bigint, bigint>();
  for (const e of events) {
    const groupId = BigInt(e.group);
    const at = { block: BigInt(e.block), timestamp: BigInt(e.timestamp) };
    const c = count.get(groupId) ?? 0n;
    if (e.remove !== undefined)
      out.push({
        ...at,
        kind: "removed",
        groupId,
        record: removedRecord(groupId, c, e.remove.map(BigInt)),
      });
    else {
      const commitments = (e.add ?? []).map(BigInt);
      out.push({ ...at, kind: "added", groupId, record: addedRecord(groupId, c, commitments) });
      count.set(groupId, c + BigInt(commitments.length));
    }
  }
  return out;
}

const trees = rolling.trees.map((t) => ({
  ...t,
  log: treeLog(t.events),
  choice: { tier: 0, root_l2_block: BigInt(t.rootL2Block), groups: t.groups.map(BigInt) },
}));
const treeOf = (id: string) => {
  const found = trees.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no tree ${id}`);
  return found;
};

function refusal(f: () => unknown): TierMembershipErrorCode {
  try {
    f();
  } catch (e) {
    if (e instanceof TierMembershipError) return e.code;
    throw e;
  }
  throw new Error("not refused");
}

describe("rollingTierEvents over rolling-tier-tree.json", () => {
  test.each(trees.map((t) => [t.id, t] as const))(
    "%s: reads the listed groups' events through close, in chain order",
    (_id, t) => {
      const closesAt = BigInt(t.closesAt);
      const got = rollingTierEvents(logs(t.log), t.choice, closesAt, pins);
      const want = t.events
        .filter((e) => t.groups.includes(e.group) && BigInt(e.timestamp) <= closesAt)
        .map(tierEvent);
      expect(got).toEqual(want);
    },
  );

  test.each(trees.map((t) => [t.id, t] as const))(
    "%s: gives the vectors' opening state and step roots from the records",
    (_id, t) => {
      const events = rollingTierEvents(logs(t.log), t.choice, BigInt(t.closesAt), pins);
      const got = rollingTierSteps(
        events,
        {
          groups: t.choice.groups,
          rootL2Block: t.choice.root_l2_block,
          registeredAt: BigInt(t.registeredAt),
          closesAt: BigInt(t.closesAt),
        },
        t.steps.map((s) => BigInt(s.step)),
      );
      expect(got.opening).toEqual({
        root: BigInt(t.opening.root),
        memberCount: Number(t.opening.memberCount),
      });
      // Every step at or before the close: a later one reads events this never returns.
      for (const s of t.steps.filter((s) => s.accepted)) {
        const step = got.steps.find((x) => x.step === BigInt(s.step));
        expect(step?.root, s.step).toBe(BigInt(s.root));
        expect(step?.memberCount, s.step).toBe(Number(s.memberCount));
      }
    },
  );

  test("takes a self-paid group's additions one leaf each, interleaved with a signed group's", () => {
    const at = (block: bigint) => ({ block, timestamp: 1_779_839_000n + block });
    const commitment = (i: bigint) => 1_000_000_000_000n + i;
    const log: Logged[] = [
      { ...at(1n), kind: "created", groupId: 1n, tier: 0 },
      { ...at(1n), kind: "self-paid-created", groupId: 2n },
      {
        ...at(5n),
        kind: "self-paid",
        groupId: 2n,
        index: 0n,
        record: encodeSelfPaidAddition({ groupId: 2n, commitment: commitment(1n) }),
      },
      {
        ...at(6n),
        kind: "added",
        groupId: 1n,
        record: addedRecord(1n, 0n, [commitment(2n), commitment(1n)]),
      },
      {
        ...at(7n),
        kind: "self-paid",
        groupId: 2n,
        index: 1n,
        record: encodeSelfPaidAddition({ groupId: 2n, commitment: commitment(3n) }),
      },
    ];
    const got = rollingTierEvents(
      logs(log),
      { tier: 0, root_l2_block: 6n, groups: [1n, 2n] },
      at(7n).timestamp,
      pins,
    );
    const event = (block: bigint, groupId: bigint, commitments: bigint[]): RollingTierEvent => ({
      blockNumber: block,
      timestamp: at(block).timestamp,
      groupId,
      kind: "add",
      commitments,
    });
    expect(got).toEqual([
      event(5n, 2n, [commitment(1n)]),
      event(6n, 1n, [commitment(2n), commitment(1n)]),
      event(7n, 2n, [commitment(3n)]),
    ]);
    // A self-paid index the replay hasn't reached breaks the group's history.
    const skipped = log.map((e) =>
      e.kind === "self-paid" && e.index === 1n ? { ...e, index: 2n } : e,
    );
    expect(
      refusal(() =>
        rollingTierEvents(
          logs(skipped),
          { tier: 0, root_l2_block: 6n, groups: [1n, 2n] },
          at(7n).timestamp,
          pins,
        ),
      ),
    ).toBe("group-history");
  });

  test("is the listed groups' events for any strict history, through close only", () => {
    const COMMITMENT = 1_000_000_000_000n;
    const step = fc.record({
      group: fc.constantFrom(1n, 2n, 3n),
      gap: fc.integer({ min: 0, max: 400 }),
      remove: fc.boolean(),
      size: fc.integer({ min: 1, max: 3 }),
      pick: fc.nat(),
    });
    fc.assert(
      fc.property(
        fc.array(step, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        (steps, rootAt, closeAt) => {
          const start = 1_779_839_000n;
          const log: Logged[] = [1n, 2n, 3n].map((groupId) => ({
            kind: "created",
            groupId,
            tier: 0,
            block: 1n,
            timestamp: start,
          }));
          const live = new Map<bigint, bigint[]>([
            [1n, []],
            [2n, []],
            [3n, []],
          ]);
          const count = new Map<bigint, bigint>();
          let block = 1n;
          let timestamp = start;
          let next = COMMITMENT;
          const blocks: { block: bigint; timestamp: bigint }[] = [];
          for (const s of steps) {
            if (s.gap > 0) {
              block += 1n;
              timestamp += BigInt(s.gap);
            }
            blocks.push({ block, timestamp });
            const c = count.get(s.group) ?? 0n;
            const alive = live.get(s.group) as bigint[];
            if (s.remove && alive.length > 0) {
              const index = alive.splice(s.pick % alive.length, 1)[0] as bigint;
              log.push({
                block,
                timestamp,
                kind: "removed",
                groupId: s.group,
                record: removedRecord(s.group, c, [index]),
              });
            } else {
              // Repeats across groups are allowed: every other addition reuses the first commitment.
              const commitments = Array.from({ length: s.size }, (_, i) =>
                i % 2 === 1 ? COMMITMENT : next++,
              );
              for (let i = 0n; i < BigInt(s.size); i++) alive.push(c + i);
              log.push({
                block,
                timestamp,
                kind: "added",
                groupId: s.group,
                record: addedRecord(s.group, c, commitments),
              });
              count.set(s.group, c + BigInt(s.size));
            }
          }
          const rootBlock = (blocks[Math.min(rootAt, blocks.length - 1)] as { block: bigint })
            .block;
          const closesAt = (blocks[Math.min(closeAt, blocks.length - 1)] as { timestamp: bigint })
            .timestamp;
          const records = logs(log);
          const got = rollingTierEvents(
            records,
            { tier: 0, root_l2_block: rootBlock, groups: [1n, 3n] },
            closesAt,
            pins,
          );
          // Exactly the listed groups' records at or before the close, in log order.
          const want = log.filter(
            (e) =>
              (e.kind === "added" || e.kind === "removed") &&
              e.groupId !== 2n &&
              e.timestamp <= closesAt,
          );
          expect(got.map((e) => [e.blockNumber, e.timestamp, e.groupId, e.kind])).toEqual(
            want.map((e) => [
              e.block,
              e.timestamp,
              (e as { groupId: bigint }).groupId,
              e.kind === "added" ? "add" : "remove",
            ]),
          );
        },
      ),
      { numRuns: Math.min(numRuns, 25) },
    );
  }, 120_000);
});

describe("rollingTierEvents reads the board as untrusted", () => {
  const t = treeOf("repeats-and-re-additions");
  const closesAt = BigInt(t.closesAt);
  const run = (log: readonly Logged[], choice = t.choice, close = closesAt) =>
    refusal(() => rollingTierEvents(logs(log), choice, close, pins));

  test("refuses a listed group with no creation by root_l2_block, two, or another tier's", () => {
    const creations = t.log.filter((e) => e.kind === "created");
    const rest = t.log.filter((e) => e.kind !== "created");
    expect(run([...creations.slice(1), ...rest])).toBe("group-created");
    expect(run([...creations, ...creations.slice(0, 1), ...rest])).toBe("group-created");
    // Created in the first block after root_l2_block, before the close.
    const next = rest.findIndex((e) => e.block > t.choice.root_l2_block);
    const { block, timestamp } = rest[next] as Logged;
    const late = { ...(creations[0] as Logged), block, timestamp };
    expect(timestamp <= closesAt).toBe(true);
    expect(run([...creations.slice(1), ...rest.slice(0, next), late, ...rest.slice(next)])).toBe(
      "group-created",
    );
    const tier1 = creations.map((e, i) => (i === 0 ? { ...e, tier: 1 } : e));
    expect(run([...tier1, ...rest])).toBe("group-tier");
  });

  test("refuses a broken record before the close, and never reads one after it", () => {
    // A removal signed at a size the group hasn't reached, after root_l2_block.
    const last = t.log.at(-1) as Logged;
    const broken: Logged = {
      block: last.block + 1n,
      timestamp: closesAt - 1n,
      kind: "removed",
      groupId: 1n,
      record: removedRecord(1n, 100n, [1n]),
    };
    // rolling-tier-tree.json's last event of this tree is after the close.
    expect(last.timestamp > closesAt).toBe(true);
    const before = [...t.log.filter((e) => e.timestamp <= closesAt), broken];
    expect(run(before)).toBe("group-history");
    const after = [...t.log, { ...broken, timestamp: last.timestamp + 1n }];
    expect(rollingTierEvents(logs(after), t.choice, closesAt, pins)).toEqual(
      rollingTierEvents(logs(t.log), t.choice, closesAt, pins),
    );
    // One approval short of the threshold.
    const short: Logged = {
      ...broken,
      kind: "added",
      record: addedRecord(1n, 3n, [5n << 100n], pins.threshold - 1),
    };
    expect(run([...t.log.filter((e) => e.timestamp <= closesAt), short])).toBe("group-history");
  });

  test("refuses a record naming a listed group before its creation, or of the other kind", () => {
    const [created, ...rest] = t.log;
    const first = rest.find((e) => e.kind === "added" && e.groupId === 1n) as Logged;
    expect(
      run(
        [first, created as Logged, ...rest.filter((e) => e !== first)].map((e) => ({
          ...e,
          block: 1n,
          timestamp: (created as Logged).timestamp,
        })),
      ),
    ).toBe("group-history");
    const selfPaid: Logged = {
      ...(rest[0] as Logged),
      kind: "self-paid",
      groupId: 1n,
      index: 0n,
      record: encodeSelfPaidAddition({ groupId: 1n, commitment: 7n << 100n }),
    };
    expect(run([...t.log.slice(0, 2), selfPaid, ...t.log.slice(2)])).toBe("group-history");
  });

  test("refuses timestamps that go back along n, or differ within one block", () => {
    const back = t.log.map((e, i) => (i === t.log.length - 2 ? { ...e, timestamp: 0n } : e));
    expect(run(back)).toBe("board-event");
    const i = t.log.findIndex((e) => e.kind !== "created");
    const twin = { ...(t.log[i] as Logged), timestamp: (t.log[i] as Logged).timestamp + 1n };
    const split = [
      ...t.log.slice(0, i + 1),
      { ...twin, groupId: 99n, kind: "created" as const, tier: 0 },
      ...t.log.slice(i + 1),
    ];
    expect(run(split)).toBe("board-event");
  });

  test("refuses Tier 1 and Tier 2 tiers, whose additions it doesn't count", () => {
    for (const tier of [1, 2]) expect(run(t.log, { ...t.choice, tier })).toBe("tier-unsupported");
  });

  test("rejects malformed arguments rather than guessing", () => {
    const records = logs(t.log);
    expect(() => rollingTierEvents(records, { ...t.choice, groups: [] }, closesAt, pins)).toThrow(
      RangeError,
    );
    expect(() =>
      rollingTierEvents(records, { ...t.choice, groups: [2n, 1n] }, closesAt, pins),
    ).toThrow(RangeError);
    expect(() =>
      rollingTierEvents(records, { ...t.choice, groups: [1n, 1n] }, closesAt, pins),
    ).toThrow(RangeError);
    expect(() =>
      rollingTierEvents(records, { ...t.choice, root_l2_block: -1n }, closesAt, pins),
    ).toThrow(RangeError);
    expect(() => rollingTierEvents(records, t.choice, 1n << 64n, pins)).toThrow(RangeError);
    expect(() =>
      rollingTierEvents(records, t.choice, closesAt, { ...pins, registry: new Uint8Array(19) }),
    ).toThrow(RangeError);
  });
});
