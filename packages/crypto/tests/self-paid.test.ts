import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  applySelfPaidRecords,
  type ContractEventRecord,
  countTier1Additions,
  decodeSelfPaidAddition,
  deriveTierCells,
  encodeGroupAddition,
  encodeGroupRemoval,
  encodeSelfPaidAddition,
  EncodeError,
  firstOccurrence,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  groupRegistryEvents,
  type GroupRegistryEvent,
  type GroupRegistryPins,
  groupRemovalDigest,
  isForbiddenCommitment,
  SELF_PAID_RECORD_LENGTH,
  signGroupApproval,
  statedTierElectorate,
  tier0Registration,
  type TierElectorate,
  tierMembership,
  TierMembershipError,
  type TierMembershipErrorCode,
  tierTreeMemberPath,
  tierTreePath,
} from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// Self-paid Tier 0 additions (docs/spec/contracts.md, Group registry,
// Self-paid additions and Verification; docs/spec/membership.md, Cell tree;
// 0024-tier0-registration, Amendment 1; P3-2 part 5c). Every expected value
// comes from docs/spec/vectors/self-paid.json, printed by an independent
// Python implementation (scripts/self-paid-vectors.py), never from the code
// under test. The tiers are also boarded as the registry logs them under
// contract-event version 7 and read back through the ballot client's and the
// creator's replays (T-16, T-06, T-71, T-25).

interface SelfPaidVectors {
  readonly format: string;
  readonly records: {
    readonly valid: readonly {
      readonly id: string;
      readonly groupId: string;
      readonly commitment: string;
      readonly record: string;
    }[];
    readonly rejected: readonly {
      readonly id: string;
      readonly record: string;
      readonly error: string;
    }[];
  };
  readonly replays: readonly {
    readonly id: string;
    readonly groupId: string;
    readonly records: readonly { readonly index: string; readonly record: string }[];
    readonly leaves?: readonly string[];
    readonly at?: number;
    readonly reason?: string;
  }[];
  readonly tiers: readonly Tier[];
}

type LogEntry =
  | { readonly group: string; readonly add: readonly string[] }
  | { readonly group: string; readonly remove: readonly string[] }
  | { readonly group: string; readonly selfPaid: string };

interface Tier {
  readonly id: string;
  readonly groups: readonly {
    readonly groupId: string;
    readonly region: number;
    readonly kind: "signed" | "self-paid";
  }[];
  readonly log: readonly LogEntry[];
  readonly regionCount: number;
  readonly leaves?: readonly (readonly string[])[];
  readonly chainOrder?: readonly (readonly string[] | null)[];
  readonly ranked?: readonly (readonly string[])[];
  readonly regions: readonly string[];
  readonly cells: readonly {
    readonly regions: readonly number[];
    readonly groups: readonly string[];
    readonly root: string;
    readonly members: string;
    readonly leafCount: number;
    readonly paths: readonly {
      readonly index: number;
      readonly leaf: string;
      readonly siblings: readonly string[];
    }[];
  }[];
}

interface RegistryVectors {
  readonly domain: { readonly chainId: number; readonly verifyingContract: string };
  readonly registrars: {
    readonly threshold: number;
    readonly secretKeys: readonly string[];
    readonly addresses: readonly string[];
  };
}

const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as T;
const vectors = read<SelfPaidVectors>("self-paid.json");
const registryVectors = read<RegistryVectors>("group-registry.json");
// Topic 0 of each group-registry event, from the independent generator of
// contract-event-v7.json, so the logs built below are the registry's.
const eventVectors = read<{
  readonly events: readonly { readonly signature: string; readonly topic0: string }[];
}>("contract-event-v7.json");

const decimal = (s: string | undefined) => {
  if (s === undefined || !/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};
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
const pins: GroupRegistryPins = {
  version: 7,
  chainId,
  registry,
  registrars: registryVectors.registrars.addresses.map(hex),
  threshold: registryVectors.registrars.threshold,
};
const domain = groupRegistryDomainSeparator(chainId, registry);
const keys = registryVectors.registrars.secretKeys.map(hex);
const ROOT_BLOCK = 100n;

const approve = (digest: Uint8Array) =>
  keys.slice(0, pins.threshold).map((k, i) => signGroupApproval(digest, i + 1, new Uint8Array(k)));

/** A registry event before it is logged: `logs` numbers them and gives each a block. */
type Event =
  | { readonly kind: "created"; readonly groupId: bigint; readonly tier: number }
  | { readonly kind: "self-paid-created"; readonly groupId: bigint }
  | { readonly kind: "added"; readonly groupId: bigint; readonly record: Uint8Array }
  | { readonly kind: "removed"; readonly groupId: bigint; readonly record: Uint8Array }
  | {
      readonly kind: "self-paid";
      readonly groupId: bigint;
      readonly index: bigint;
      readonly record: Uint8Array;
    };

function added(groupId: bigint, firstIndex: bigint, commitments: readonly bigint[]): Event {
  const digest = groupAdditionDigest(domain, { groupId, tier: 0, firstIndex, commitments });
  const record = encodeGroupAddition({
    groupId,
    firstIndex,
    commitments,
    approvals: approve(digest),
  });
  return { kind: "added", groupId, record };
}

function removed(groupId: bigint, size: bigint, indices: readonly bigint[]): Event {
  const digest = groupRemovalDigest(domain, { groupId, tier: 0, size, indices });
  return {
    kind: "removed",
    groupId,
    record: encodeGroupRemoval({ groupId, size, indices, approvals: approve(digest) }),
  };
}

const selfPaid = (groupId: bigint, index: bigint, commitment: bigint): Event => ({
  kind: "self-paid",
  groupId,
  index,
  record: encodeSelfPaidAddition({ groupId, commitment }),
});

/** The registry's log of `events`, numbered from `n` in order, each at block 10 unless given. */
function logs(
  events: readonly (Event & { readonly block?: bigint })[],
  n = 1,
): ContractEventRecord[] {
  return events.map((e, i) => {
    const block = e.block ?? 10n;
    const base = {
      contract: registry,
      n: BigInt(n + i),
      l2_block: block,
      l2_timestamp: 1_760_000_000n + block * 2n,
    };
    if (e.kind === "created")
      return {
        ...base,
        topics: [topic0("GroupCreated(uint64,uint8)"), word(e.groupId), word(BigInt(e.tier))],
        data: new Uint8Array(0),
      };
    if (e.kind === "self-paid-created")
      return {
        ...base,
        topics: [topic0("SelfPaidGroupCreated(uint64)"), word(e.groupId)],
        data: new Uint8Array(0),
      };
    if (e.kind === "added")
      return {
        ...base,
        topics: [
          topic0("MembersAdded(uint64,uint64,bytes)"),
          word(e.groupId),
          word(new DataView(e.record.buffer).getBigUint64(8, false)),
        ],
        data: abiBytes(e.record),
      };
    if (e.kind === "removed")
      return {
        ...base,
        topics: [topic0("MembersRemoved(uint64,bytes)"), word(e.groupId)],
        data: abiBytes(e.record),
      };
    return {
      ...base,
      topics: [topic0("SelfPaidMemberAdded(uint64,uint64,bytes)"), word(e.groupId), word(e.index)],
      data: abiBytes(e.record),
    };
  });
}

/** A tier's groups' leaves and self-paid chain positions, read structurally from the vector's log. */
function replayLog(t: Tier) {
  const leaves = new Map(t.groups.map((g) => [decimal(g.groupId), [] as bigint[]]));
  const chain = new Map<bigint, bigint[]>();
  for (const [pos, e] of t.log.entries()) {
    const g = leaves.get(decimal(e.group)) as bigint[];
    if ("add" in e) g.push(...e.add.map(decimal));
    else if ("remove" in e) for (const i of e.remove) g[Number(i)] = 0n;
    else {
      g.push(decimal(e.selfPaid));
      const order = chain.get(decimal(e.group)) ?? [];
      order.push(BigInt(pos));
      chain.set(decimal(e.group), order);
    }
  }
  return { leaves, chain };
}

/** The tier boarded as the registry logs it: creations first, then the log in chain order. */
function board(t: Tier): ContractEventRecord[] {
  const events: Event[] = t.groups.map((g): Event =>
    g.kind === "signed"
      ? { kind: "created", groupId: decimal(g.groupId), tier: 0 }
      : { kind: "self-paid-created", groupId: decimal(g.groupId) },
  );
  const count = new Map<bigint, bigint>();
  for (const e of t.log) {
    const id = decimal(e.group);
    const c = count.get(id) ?? 0n;
    if ("add" in e) {
      events.push(added(id, c, e.add.map(decimal)));
      count.set(id, c + BigInt(e.add.length));
    } else if ("remove" in e) events.push(removed(id, c, e.remove.map(decimal)));
    else {
      events.push(selfPaid(id, c, decimal(e.selfPaid)));
      count.set(id, c + 1n);
    }
  }
  return logs(events);
}

const electorateOf = (t: Tier): TierElectorate => ({
  tier: 0,
  root_l2_block: ROOT_BLOCK,
  groups: t.groups.map((g) => ({ group_id: decimal(g.groupId), region: g.region })),
  regions: t.regions.map(decimal),
  cells: t.cells.map((c) => ({ root: decimal(c.root), members: decimal(c.members) })),
});

const tierOf = (id: string) => {
  const found = vectors.tiers.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no tier ${id}`);
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

describe("self-paid records (docs/spec/vectors/self-paid.json)", () => {
  test("uses the format this reader knows", () => {
    expect(vectors.format).toBe("abolish-self-paid-vectors/1");
    expect(SELF_PAID_RECORD_LENGTH).toBe(40);
    expect(vectors.records.valid.length).toBeGreaterThanOrEqual(3);
    expect(vectors.records.rejected.length).toBeGreaterThanOrEqual(10);
    expect(vectors.replays).toHaveLength(10);
    expect(vectors.tiers).toHaveLength(8);
  });

  test.each(vectors.records.valid.map((v) => [v.id, v] as const))("decodes %s", (_id, v) => {
    const value = { groupId: decimal(v.groupId), commitment: decimal(v.commitment) };
    expect(decodeSelfPaidAddition(hex(v.record))).toEqual({ ok: true, value });
    expect(Buffer.from(encodeSelfPaidAddition(value)).toString("hex")).toBe(v.record);
  });

  test.each(vectors.records.rejected.map((v) => [v.id, v] as const))("refuses %s", (_id, v) => {
    expect(decodeSelfPaidAddition(hex(v.record))).toEqual({ ok: false, error: v.error });
  });

  test("encode refuses exactly what decode refuses", () => {
    expect(() => encodeSelfPaidAddition({ groupId: 1n, commitment: 1n })).toThrow(EncodeError);
    expect(() => encodeSelfPaidAddition({ groupId: 1n << 64n, commitment: 5n })).toThrow(
      EncodeError,
    );
    expect(() => encodeSelfPaidAddition({ groupId: -1n, commitment: 5n })).toThrow(EncodeError);
  });

  test("decode(encode(x)) = x and encode(decode(b)) = b for every accepted b", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        fc.bigInt({ min: 0n, max: (1n << 256n) - 1n }),
        (groupId, commitment) => {
          if (isForbiddenCommitment(commitment)) {
            expect(() => encodeSelfPaidAddition({ groupId, commitment })).toThrow(EncodeError);
            return;
          }
          const b = encodeSelfPaidAddition({ groupId, commitment });
          expect(b).toHaveLength(40);
          const d = decodeSelfPaidAddition(b);
          expect(d).toEqual({ ok: true, value: { groupId, commitment } });
        },
      ),
      { numRuns },
    );
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 80 }), (b) => {
        const d = decodeSelfPaidAddition(b);
        if (b.length !== 40) expect(d).toEqual({ ok: false, error: "length" });
        else if (d.ok) expect(encodeSelfPaidAddition(d.value)).toEqual(b);
        else expect(d.error).toBe("forbidden-commitment");
      }),
      { numRuns },
    );
  });
});

describe("a self-paid group's replay (docs/spec/contracts.md, Verification, Self-paid groups)", () => {
  test.each(vectors.replays.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const records = v.records.map((r) => ({ index: decimal(r.index), record: hex(r.record) }));
    const result = applySelfPaidRecords(records, { groupId: decimal(v.groupId) });
    if (v.leaves !== undefined) {
      const leaves = v.leaves.map(decimal);
      expect(result).toEqual({
        ok: true,
        count: BigInt(leaves.length),
        leaves,
        groupSize: leaves.length,
      });
    } else
      expect(result).toEqual({ ok: false, error: "group-history", at: v.at, reason: v.reason });
  });

  test("each check, removed, lets a bad history through: a mutation of every honest record is refused", () => {
    const honest = vectors.replays.find((v) => v.id === "honest");
    if (honest === undefined) throw new Error("no honest replay");
    const records = honest.records.map((r) => ({ index: decimal(r.index), record: hex(r.record) }));
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: records.length - 1 }),
        fc.bigInt({ min: 1n, max: 5n }),
        (at, shift) => {
          const moved = records.map((r, i) => (i === at ? { ...r, index: r.index + shift } : r));
          expect(applySelfPaidRecords(moved, { groupId: 3n })).toEqual({
            ok: false,
            error: "group-history",
            at,
            reason: "position",
          });
        },
      ),
      { numRuns },
    );
    expect(applySelfPaidRecords(records, { groupId: 4n })).toEqual({
      ok: false,
      error: "group-history",
      at: 0,
      reason: "group",
    });
  });
});

describe("the first-occurrence ranking (docs/spec/membership.md, Cell tree)", () => {
  test.each(vectors.tiers.filter((t) => t.ranked !== undefined).map((t) => [t.id, t] as const))(
    "ranks %s: signed groups by group_id, then self-paid additions in chain order",
    (_id, t) => {
      const leaves = (t.leaves ?? []).map((row) => row.map(decimal));
      const order = (t.chainOrder ?? []).map((row) =>
        row === null ? undefined : row.map(decimal),
      );
      expect(firstOccurrence(leaves, order)).toEqual(
        (t.ranked ?? []).map((row) => row.map(decimal)),
      );
      // The vector's leaves are the log's, as replayLog reads it.
      const { leaves: fromLog, chain } = replayLog(t);
      expect(t.groups.map((g) => fromLog.get(decimal(g.groupId)))).toEqual(leaves);
      expect(t.groups.map((g) => chain.get(decimal(g.groupId)))).toEqual(order);
    },
  );

  test.each(vectors.tiers.map((t) => [t.id, t] as const))(
    "derives %s's region counts, cells, roots and paths",
    (_id, t) => {
      const { leaves, chain } = replayLog(t);
      const tier = {
        groups: t.groups.map((g) => ({ group_id: decimal(g.groupId), region: g.region })),
        regions: Array.from({ length: t.regionCount }, () => 0n),
      };
      const derived = deriveTierCells(tier, leaves, chain);
      expect(derived.regions).toEqual(t.regions.map(decimal));
      expect(derived.cells).toHaveLength(t.cells.length);
      for (const [i, c] of t.cells.entries()) {
        const d = derived.cells[i];
        expect(d?.regions).toEqual(c.regions);
        expect(d?.groups).toEqual(c.groups.map(decimal));
        expect(d?.root).toBe(decimal(c.root));
        expect(d?.members).toBe(decimal(c.members));
        expect(d?.leaves).toHaveLength(c.leafCount);
        for (const p of c.paths) {
          expect(d?.leaves[p.index]).toBe(decimal(p.leaf));
          expect(tierTreePath(d?.leaves ?? [], p.index)).toEqual(p.siblings.map(decimal));
        }
      }
    },
    60_000,
  );

  test("without chain positions every group walks by group_id, as before self-paid groups", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.bigInt({ min: 0n, max: 6n }), { maxLength: 6 }), { maxLength: 5 }),
        (groups) => {
          const seen = new Set<bigint>();
          const expected = groups.map((row) =>
            row.map((x) => {
              if (x === 0n || seen.has(x)) return 0n;
              seen.add(x);
              return x;
            }),
          );
          expect(firstOccurrence(groups, [])).toEqual(expected);
        },
      ),
      { numRuns },
    );
  });

  test("a signed occurrence always counts, and each value counts at most once", () => {
    const value = fc.bigInt({ min: 0n, max: 8n });
    fc.assert(
      fc.property(
        fc.array(fc.record({ selfPaid: fc.boolean(), leaves: fc.array(value, { maxLength: 6 }) }), {
          maxLength: 5,
        }),
        fc.integer({ min: 0, max: 1000 }),
        (groups, seed) => {
          // Distinct chain positions in an order unrelated to the group order.
          let next = 0;
          const order = groups.map((g) =>
            g.selfPaid
              ? g.leaves.map(() => BigInt(((next++ * 7919 + seed) % 100_003) * 64 + next))
              : undefined,
          );
          const ranked = firstOccurrence(
            groups.map((g) => g.leaves),
            order,
          );
          const counted = ranked.flat().filter((x) => x !== 0n);
          expect(new Set(counted).size).toBe(counted.length);
          const all = new Set(groups.flatMap((g) => g.leaves).filter((x) => x !== 0n));
          expect(new Set(counted)).toEqual(all);
          const signed = new Set(groups.flatMap((g) => (g.selfPaid ? [] : g.leaves)));
          for (const [i, g] of groups.entries())
            if (g.selfPaid)
              for (const [j, x] of g.leaves.entries())
                if (signed.has(x)) expect(ranked[i]?.[j]).toBe(0n);
        },
      ),
      { numRuns },
    );
  });

  test("requires the chain positions, so no caller ranks self-paid groups by group_id by omission", () => {
    expect(() =>
      (firstOccurrence as (g: readonly (readonly bigint[])[]) => bigint[][])([[5n]]),
    ).toThrow(TypeError);
    expect(() =>
      (deriveTierCells as (t: unknown, l: unknown) => unknown)(
        { groups: [{ group_id: 1n, region: 0 }], regions: [0n] },
        new Map([[1n, [5n]]]),
      ),
    ).toThrow(TypeError);
  });

  test("refuses chain positions that don't match the leaves or repeat", () => {
    expect(() => firstOccurrence([[5n, 6n]], [[1n]])).toThrow(RangeError);
    expect(() => firstOccurrence([[5n], [6n]], [[1n], [1n]])).toThrow(RangeError);
  });
});

describe("groupRegistryEvents reads the self-paid events (contract-event version 7)", () => {
  test("as events at their blocks, with the index topic", () => {
    const record = encodeSelfPaidAddition({ groupId: 4n, commitment: 1000n });
    const read = groupRegistryEvents(
      logs([
        { kind: "self-paid-created", groupId: 4n, block: 3n },
        { kind: "self-paid", groupId: 4n, index: 0n, record, block: 5n },
      ]),
      registry,
      7,
    );
    expect(read).toEqual({
      ok: true,
      events: [
        { kind: "self-paid-group-created", block: 3n, groupId: 4n },
        { kind: "self-paid-addition", block: 5n, groupId: 4n, index: 0n, record },
      ],
      pinned: [],
    });
  });

  test("refuses them under version 6, which has no self-paid events", () => {
    const read = groupRegistryEvents(
      logs([{ kind: "self-paid-created", groupId: 4n }]),
      registry,
      6,
    );
    expect(read).toEqual({ ok: false, at: 0, error: "unknown-event" });
  });
});

describe("Tier 1 counting beside self-paid groups (docs/spec/vouching.md, A broken Tier 2 history)", () => {
  const ctx = {
    chainId,
    registry,
    registrars: pins.registrars,
    threshold: pins.threshold,
  };
  const spRecord = (groupId: bigint) => encodeSelfPaidAddition({ groupId, commitment: 1000n });
  const at = (events: GroupRegistryEvent[]) => countTier1Additions(events, ctx).broken;

  test("a self-paid group's own events break nothing", () => {
    expect(
      at([
        { kind: "self-paid-group-created", block: 1n, groupId: 0n },
        { kind: "self-paid-addition", block: 2n, groupId: 0n, index: 0n, record: spRecord(0n) },
      ]),
    ).toBeNull();
  });

  test("a creation of either kind for an identifier already created breaks it", () => {
    expect(
      at([
        { kind: "group-created", block: 1n, groupId: 0n, tier: 1 },
        { kind: "self-paid-group-created", block: 2n, groupId: 0n },
      ]),
    ).toEqual({ at: 1, block: 2n, groupId: 0n, reason: "duplicate-group" });
    expect(
      at([
        { kind: "self-paid-group-created", block: 1n, groupId: 0n },
        { kind: "group-created", block: 2n, groupId: 0n, tier: 2 },
      ]),
    ).toEqual({ at: 1, block: 2n, groupId: 0n, reason: "duplicate-group" });
  });

  test("a self-paid addition naming no created group breaks it at its block", () => {
    expect(
      at([{ kind: "self-paid-addition", block: 4n, groupId: 9n, index: 0n, record: spRecord(9n) }]),
    ).toEqual({ at: 0, block: 4n, groupId: 9n, reason: "created" });
  });

  test("a signed record naming a self-paid group, or a self-paid addition naming a Tier 0 or Tier 1 group, breaks nothing", () => {
    const signed = (groupId: bigint) => {
      const digest = groupAdditionDigest(domain, {
        groupId,
        tier: 0,
        firstIndex: 0n,
        commitments: [1000n],
      });
      return encodeGroupAddition({
        groupId,
        firstIndex: 0n,
        commitments: [1000n],
        approvals: approve(digest),
      });
    };
    expect(
      at([
        { kind: "self-paid-group-created", block: 1n, groupId: 0n },
        { kind: "group-created", block: 1n, groupId: 1n, tier: 0 },
        { kind: "group-created", block: 1n, groupId: 2n, tier: 1 },
        { kind: "members-added", block: 2n, groupId: 0n, record: signed(0n), firstIndex: 0n },
        { kind: "self-paid-addition", block: 3n, groupId: 1n, index: 0n, record: spRecord(1n) },
        { kind: "self-paid-addition", block: 3n, groupId: 2n, index: 0n, record: spRecord(2n) },
      ]),
    ).toBeNull();
  });

  test("a self-paid addition naming a Tier 2 group breaks its replay at group", () => {
    expect(
      at([
        { kind: "group-created", block: 1n, groupId: 0n, tier: 2 },
        { kind: "self-paid-addition", block: 3n, groupId: 0n, index: 0n, record: spRecord(0n) },
      ]),
    ).toEqual({ at: 1, block: 3n, groupId: 0n, reason: "group" });
  });
});

describe("the ballot client's and the creator's replays over self-paid groups", () => {
  test.each(vectors.tiers.map((t) => [t.id, t] as const))(
    "%s: the stated electorate and each path the vectors give",
    (_id, t) => {
      const records = board(t);
      const electorate = electorateOf(t);
      const stated = statedTierElectorate(
        records,
        { tier: 0, root_l2_block: ROOT_BLOCK, groups: electorate.groups },
        pins,
      );
      expect(stated).toEqual(electorate);
      const { leaves } = replayLog(t);
      for (const [c, cell] of t.cells.entries())
        for (const p of cell.paths) {
          const leaf = decimal(p.leaf);
          // The counted occurrence's group: the one whose stretch of the cell's leaves holds p.index.
          let offset = 0;
          const home = cell.groups.map(decimal).find((g) => {
            offset += (leaves.get(g) ?? []).length;
            return p.index < offset;
          });
          if (home === undefined) throw new Error("no home");
          const m = tierMembership(records, electorate, leaf, home, pins);
          expect(m.cell).toBe(c);
          expect(m.root).toBe(decimal(cell.root));
          expect(tierTreeMemberPath(m.leaves, leaf)).toEqual({
            index: p.index,
            siblings: p.siblings.map(decimal),
            root: decimal(cell.root),
          });
        }
    },
    120_000,
  );

  test("alarms when a self-paid copy landing first moves a self-paid registrant", () => {
    // chain-order: 1000000000 lands first in group 9 (region 1), then in group 4 (region 0).
    const t = tierOf("chain-order");
    const records = board(t);
    expect(refusal(() => tierMembership(records, electorateOf(t), 1_000_000_000n, 4n, pins))).toBe(
      "moved",
    );
    expect(tierMembership(records, electorateOf(t), 1_000_000_000n, 9n, pins).cell).toBe(0);
  });

  test("alarms when a signed copy moves a self-paid registrant, whenever it lands", () => {
    const t = tierOf("signed-copy-wins");
    const records = board(t);
    expect(refusal(() => tierMembership(records, electorateOf(t), 1_000_000_000n, 5n, pins))).toBe(
      "moved",
    );
  });

  describe("refuses a history the registry can't log", () => {
    const t = tierOf("copy-after-signed"); // signed group 10 (region 0), self-paid group 5 (region 1)
    const electorate = electorateOf(t);
    const commitment = 1_000_000_002n; // group 5's first member
    const base: Event[] = [
      { kind: "self-paid-created", groupId: 5n },
      { kind: "created", groupId: 10n, tier: 0 },
      added(10n, 0n, [1_000_000_000n, 1_000_000_001n]),
      selfPaid(5n, 0n, commitment),
      selfPaid(5n, 1n, 1_000_000_000n),
    ];
    const code = (events: readonly Event[]) =>
      refusal(() => tierMembership(logs(events), electorate, commitment, 5n, pins));

    test("the honest board reads", () => {
      expect(tierMembership(logs(base), electorate, commitment, 5n, pins).cell).toBe(0);
    });

    test("a skipped or repeated index", () => {
      expect(code([...base.slice(0, 4), selfPaid(5n, 2n, 1_000_000_000n)])).toBe("group-history");
      expect(code([...base.slice(0, 4), selfPaid(5n, 0n, 1_000_000_000n)])).toBe("group-history");
    });

    test("a self-paid record whose own group differs from its topic", () => {
      const record = encodeSelfPaidAddition({ groupId: 6n, commitment: 1_000_000_000n });
      const other: Event = { kind: "self-paid", groupId: 5n, index: 1n, record };
      expect(code([...base.slice(0, 4), other])).toBe("group-history");
    });

    test("a signed record naming a self-paid group", () => {
      const forged = added(5n, 2n, [1_000_000_003n]);
      expect(code([...base, forged])).toBe("group-history");
      expect(code([...base, removed(5n, 2n, [1n])])).toBe("group-history");
    });

    test("a self-paid record naming a signed group", () => {
      expect(code([...base, selfPaid(10n, 2n, 1_000_000_003n)])).toBe("group-history");
    });

    test("a signed record before its group's creation", () => {
      const [spCreated, created, add, ...rest] = base;
      expect(code([spCreated as Event, add as Event, created as Event, ...rest])).toBe(
        "group-history",
      );
    });

    test("statedTierElectorate refuses the same histories", () => {
      const choice = { tier: 0, root_l2_block: ROOT_BLOCK, groups: electorate.groups };
      const stated = (events: readonly Event[]) =>
        refusal(() => statedTierElectorate(logs(events), choice, pins));
      expect(stated([...base.slice(0, 4), selfPaid(5n, 2n, 1_000_000_000n)])).toBe("group-history");
      expect(stated([...base, added(5n, 2n, [1_000_000_003n])])).toBe("group-history");
      expect(stated([...base, selfPaid(10n, 2n, 1_000_000_003n)])).toBe("group-history");
      expect(stated([...base, { kind: "self-paid-created", groupId: 10n }])).toBe("group-created");
    });

    test("a record before its group's creation", () => {
      const [spCreated, created, ...rest] = base;
      expect(
        code([
          created as Event,
          selfPaid(5n, 0n, commitment),
          spCreated as Event,
          ...rest.slice(0, 1),
        ]),
      ).toBe("group-history");
    });

    test("a group created twice, of either kind", () => {
      expect(code([...base, { kind: "created", groupId: 5n, tier: 0 }])).toBe("group-created");
      expect(code([...base, { kind: "self-paid-created", groupId: 10n }])).toBe("group-created");
    });

    test("a self-paid group listed in a Tier 1 tier", () => {
      expect(
        refusal(() => tierMembership(logs(base), { ...electorate, tier: 1 }, commitment, 5n, pins)),
      ).toBe("group-tier");
    });

    test("records after the tier's root_l2_block change nothing", () => {
      const late = { ...selfPaid(5n, 2n, 1_000_000_009n), block: ROOT_BLOCK + 1n };
      expect(tierMembership(logs([...base, late]), electorate, commitment, 5n, pins).cell).toBe(0);
    });
  });
});

describe("tier0Registration: a registrant's outcome over self-paid groups", () => {
  // Region codes, not a tier's region indices: the vectors' index i is code
  // 1000 + i here, so a mix-up of the two can't pass.
  const code = (region: number) => 1000 + region;
  const groupsOf = (t: Tier, block = ROOT_BLOCK) => ({
    block,
    groups: t.groups.map((g) => ({ group_id: decimal(g.groupId), region: code(g.region) })),
  });

  test.each(vectors.tiers.filter((t) => t.ranked !== undefined).map((t) => [t.id, t] as const))(
    "%s: registered only in the region of the occurrence the vectors rank first",
    (_id, t) => {
      const records = board(t);
      const regions = [...new Set(t.groups.map((g) => g.region))];
      const commitments = new Set(
        t.log.flatMap((e) => ("add" in e ? e.add : "selfPaid" in e ? [e.selfPaid] : [])),
      );
      for (const c of [...commitments].map(decimal)) {
        // The vectors' ranking: the group whose ranked leaves still hold c.
        const at = (t.ranked ?? []).findIndex((leaves) => leaves.map(decimal).includes(c));
        for (const region of regions) {
          const outcome = tier0Registration(records, groupsOf(t), c, code(region), pins);
          const home = t.groups[at];
          if (home === undefined) expect(outcome, `${c}`).toEqual({ kind: "not-yet" });
          else
            expect(outcome, `${c} in region ${region}`).toEqual({
              kind: home.region === region ? "registered" : "moved",
              group: decimal(home.groupId),
            });
        }
      }
    },
    120_000,
  );

  test("a removed leaf counts nowhere, and a later copy is the occurrence", () => {
    // removed-no-precedence: 1000000000 is removed from signed group 2 (region 0), then added to self-paid group 8 (region 1).
    const t = tierOf("removed-no-precedence");
    const records = board(t);
    expect(tier0Registration(records, groupsOf(t), 1_000_000_000n, code(1), pins)).toEqual({
      kind: "registered",
      group: 8n,
    });
    expect(tier0Registration(records, groupsOf(t), 1_000_000_000n, code(0), pins)).toEqual({
      kind: "moved",
      group: 8n,
    });
    // Before the self-paid copy: removed, so in no group.
    const events: Event[] = [
      { kind: "created", groupId: 2n, tier: 0 },
      { kind: "self-paid-created", groupId: 8n },
      added(2n, 0n, [1_000_000_000n, 1_000_000_001n]),
      removed(2n, 2n, [0n]),
    ];
    expect(tier0Registration(logs(events), groupsOf(t), 1_000_000_000n, code(0), pins)).toEqual({
      kind: "not-yet",
    });
  });

  test("reads the registry only up to the block given", () => {
    const t = tierOf("chain-order"); // 1000000000 lands first in group 9 (region 1), then in group 4 (region 0)
    const events: (Event & { block?: bigint })[] = [
      { kind: "self-paid-created", groupId: 4n, block: 1n },
      { kind: "self-paid-created", groupId: 9n, block: 1n },
      { ...selfPaid(4n, 0n, 1_000_000_000n), block: 5n },
      { ...selfPaid(9n, 0n, 1_000_000_000n), block: 6n },
    ];
    const at = (block: bigint, region: number) =>
      tier0Registration(logs(events), groupsOf(t, block), 1_000_000_000n, code(region), pins);
    expect(at(4n, 0)).toEqual({ kind: "not-yet" });
    expect(at(5n, 0)).toEqual({ kind: "registered", group: 4n });
    expect(at(6n, 0)).toEqual({ kind: "registered", group: 4n });
    expect(at(6n, 1)).toEqual({ kind: "moved", group: 4n });
  });

  test("refuses a history the registry can't log, as tierMembership does", () => {
    const t = tierOf("copy-after-signed");
    const events: Event[] = [
      { kind: "self-paid-created", groupId: 5n },
      { kind: "created", groupId: 10n, tier: 0 },
      added(10n, 0n, [1_000_000_000n]),
      selfPaid(10n, 1n, 1_000_000_003n),
    ];
    expect(
      refusal(() => tier0Registration(logs(events), groupsOf(t), 1_000_000_000n, code(0), pins)),
    ).toBe("group-history");
    expect(
      refusal(() =>
        tier0Registration(logs(events.slice(1, 3)), groupsOf(t), 1_000_000_000n, code(0), pins),
      ),
    ).toBe("group-created");
  });

  test("refuses arguments outside its forms", () => {
    const t = tierOf("copy-after-signed");
    const records = board(t);
    const groups = groupsOf(t);
    const ok =
      (g: unknown, c: unknown = 1_000_000_000n, region: unknown = code(0)) =>
      () =>
        tier0Registration(records, g as never, c as bigint, region as number, pins);
    expect(ok(groups)).not.toThrow();
    for (const c of [0n, 1n, 1_000_000_000])
      expect(ok(groups, c), `commitment ${String(c)}`).toThrow(RangeError);
    for (const region of [code(5), -1, 2 ** 32, 0.5, "1000"])
      expect(ok(groups, undefined, region), `region ${String(region)}`).toThrow(RangeError);
    const [a, b] = groups.groups as [
      { group_id: bigint; region: number },
      { group_id: bigint; region: number },
    ];
    for (const bad of [
      { ...groups, block: -1n },
      { ...groups, block: 1n << 64n },
      { ...groups, groups: [] },
      { ...groups, groups: [b, a] },
      { ...groups, groups: [a, a] },
      { ...groups, groups: [a, { ...b, region: 2 ** 32 }] },
      { ...groups, groups: [a, { ...b, group_id: 1n << 64n }] },
    ])
      expect(ok(bad)).toThrow(RangeError);
    expect(ok(null)).toThrow(TypeError);
  });
});
