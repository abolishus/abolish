import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type ContractEventRecord,
  decodeElectionDefinitionV5,
  type ElectionDefinitionV5,
  encodeBoardEntry,
  encodeContractEvent,
  encodeGroupAddition,
  encodeGroupRemoval,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  groupRemovalDigest,
  type GroupRegistryPins,
  identityCommitment,
  membershipProverInput,
  signGroupApproval,
  statedTierElectorate,
  type TierChoice,
  type TierElectorate,
  tierMembership,
  TierMembershipError,
  type TierMembershipErrorCode,
  tierTreeMemberPath,
  tierTreeRoot,
  voterCellV5,
} from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// The ballot client's cell from the board's group-registry events
// (docs/spec/membership.md, Tier tree and Cell tree; docs/spec/contracts.md,
// Group registry, Verification; P2-21 part 3). Each tier below is one of
// regional-cells.json's, from an independent Python implementation of the
// fold, the first-occurrence rule and cell trees, boarded here as records
// signed under group-registry.json's test registrars; every expected cell,
// root and path is the vectors', never the code under test's (T-10, T-13,
// T-16, T-71).

type RawEvent =
  | { readonly add: string }
  | { readonly addRange: readonly [string, string] }
  | { readonly remove: string };

interface CellsVectors {
  readonly tiers: readonly {
    readonly id: string;
    readonly groups: readonly {
      readonly groupId: string;
      readonly region: number;
      readonly events: readonly RawEvent[];
    }[];
    readonly regions: readonly string[];
    readonly cells: readonly {
      readonly regions: readonly number[];
      readonly root: string;
      readonly members: string;
      readonly leafCount: number;
      readonly paths: readonly {
        readonly index: number;
        readonly leaf: string;
        readonly siblings: readonly string[];
      }[];
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

interface CountVectors {
  readonly context: { readonly chainId: string; readonly registry: string };
  readonly cases: readonly {
    readonly id: string;
    readonly events: readonly {
      readonly kind: string;
      readonly block: string;
      readonly groupId?: string;
      readonly tier?: number;
      readonly record?: string;
    }[];
    readonly additions: readonly { readonly at: number; readonly valid: boolean }[];
    readonly leaves: readonly {
      readonly groupId: string;
      readonly block: string;
      readonly leaves: readonly string[];
    }[];
  }[];
}

interface ProverVectors {
  readonly definitionHash: string;
  readonly members: readonly { readonly secret: string }[];
  readonly trees: readonly {
    readonly id: string;
    readonly tier: number;
    readonly leaves: readonly string[];
    readonly root: string;
  }[];
  readonly cases: readonly {
    readonly name: string;
    readonly member: number;
    readonly tree: string;
    readonly message: string;
    readonly input: Record<string, unknown>;
  }[];
}

const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as T;
const cellsVectors = read<CellsVectors>("regional-cells.json");
const registryVectors = read<RegistryVectors>("group-registry.json");
const proverVectors = read<ProverVectors>("membership-prover.json");
const countVectors = read<CountVectors>("vouch-count.json");
// Topic 0 of each group-registry event, from the independent generator of
// contract-event-v6.json, so the logs built below are the registry's.
const eventVectors = read<{
  readonly events: readonly { readonly signature: string; readonly topic0: string }[];
}>("contract-event-v6.json");

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
  version: 6,
  chainId,
  registry,
  registrars: registryVectors.registrars.addresses.map(hex),
  threshold: registryVectors.registrars.threshold,
};
const domain = groupRegistryDomainSeparator(chainId, registry);
const keys = registryVectors.registrars.secretKeys.map(hex);
const ROOT_BLOCK = 100n;

// voterCellV5's definition: version 5's typical one under the profile every
// poll pins today (board-entry 5, contract-event 7), its electorate and
// group registry replaced by the board's.
const typicalV5 = decodeElectionDefinitionV5(
  hex(
    read<{ vectors: readonly { id: string; encoding: string }[] }>(
      "election-definition-v5.json",
    ).vectors.find((v) => v.id === "definition-v5-typical")?.encoding,
  ),
);
const POLL_PINS = (
  [
    [1, 5],
    [2, 3],
    [3, 2],
    [4, 1],
    [5, 1],
    [6, 1],
    [7, 5],
    [8, 8],
    [9, 2],
  ] as const
).map(([record_type, version]) => ({ record_type, version }));
const pollDefinition = (
  electorate: readonly TierElectorate[],
  registryAddress = registry,
  l2ChainId = chainId,
): ElectionDefinitionV5 => ({
  ...typicalV5,
  l2_chain_id: l2ChainId,
  group_registry: registryAddress,
  electorate: [...electorate],
  profile: { protocol_major: 1, pins: POLL_PINS },
});
/** Each record as a board entry of `definition`'s election, under board-entry version 5. */
const boardEntries = (definition: ElectionDefinitionV5, records: readonly ContractEventRecord[]) =>
  records.map((r, i) =>
    encodeBoardEntry(
      {
        election_id: definition.election_id,
        index: BigInt(i),
        segment: 0,
        payload: encodeContractEvent(r, 8),
      },
      5,
    ),
  );
const release = { registrars: pins.registrars, threshold: pins.threshold };

/** A registry event before it is logged: the board numbers and blocks them. */
type Event =
  | { readonly kind: "created"; readonly groupId: bigint; readonly tier: number }
  | {
      readonly kind: "added";
      readonly groupId: bigint;
      readonly record: Uint8Array;
      readonly firstIndex?: bigint;
    }
  | { readonly kind: "removed"; readonly groupId: bigint; readonly record: Uint8Array }
  | {
      readonly kind: "pinned";
      readonly threshold: number;
      readonly registrars: readonly Uint8Array[];
    };

/** Approvals by the first `t` test registrars, in seat order. */
const approve = (digest: Uint8Array, t = pins.threshold) =>
  keys.slice(0, t).map((k, i) => signGroupApproval(digest, i + 1, new Uint8Array(k)));

function added(
  groupId: bigint,
  firstIndex: bigint,
  commitments: readonly bigint[],
  t?: number,
): Extract<Event, { kind: "added" }> {
  const digest = groupAdditionDigest(domain, { groupId, tier: 0, firstIndex, commitments });
  const record = encodeGroupAddition({
    groupId,
    firstIndex,
    commitments,
    approvals: approve(digest, t),
  });
  return { kind: "added", groupId, record };
}

function removed(groupId: bigint, size: bigint, indices: readonly bigint[]): Event {
  const digest = groupRemovalDigest(domain, { groupId, tier: 0, size, indices });
  const record = encodeGroupRemoval({ groupId, size, indices, approvals: approve(digest) });
  return { kind: "removed", groupId, record };
}

/** One group's additions, in batches of at most 256 from index `from`. */
function additions(groupId: bigint, commitments: readonly bigint[], from = 0n): Event[] {
  const out: Event[] = [];
  for (let i = 0; i < commitments.length; i += 256)
    out.push(added(groupId, from + BigInt(i), commitments.slice(i, i + 256)));
  return out;
}

/** The registry's log of `events`, numbered from `n` in order, at `block` unless given. */
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
    if (e.kind === "added")
      return {
        ...base,
        topics: [
          topic0("MembersAdded(uint64,uint64,bytes)"),
          word(e.groupId),
          word(e.firstIndex ?? new DataView(e.record.buffer).getBigUint64(8, false)),
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
      topics: [topic0("RegistrarsPinned(uint8,address[])")],
      data: Uint8Array.from([
        ...word(BigInt(e.threshold)),
        ...word(64n),
        ...word(BigInt(e.registrars.length)),
        ...e.registrars.flatMap((r) => [...new Uint8Array(12), ...r]),
      ]),
    };
  });
}

const values = (events: readonly RawEvent[]) =>
  events.flatMap((e) => {
    if ("add" in e) return [decimal(e.add)];
    if ("addRange" in e) {
      const [start, count] = e.addRange.map(decimal) as [bigint, bigint];
      return Array.from({ length: Number(count) }, (_, i) => start + BigInt(i));
    }
    throw new Error("a removal: not a strict history");
  });

// Every tier of regional-cells.json whose events a strict replay accepts
// (no forbidden commitment or stray removal), boarded as the registry logs it.
const tiers = cellsVectors.tiers
  .filter((t) =>
    t.groups.every((g) =>
      g.events.every((e) => !("remove" in e) && !("add" in e && decimal(e.add) <= 1n)),
    ),
  )
  .map((t) => {
    const groups = t.groups.map((g) => ({
      id: decimal(g.groupId),
      region: g.region,
      leaves: values(g.events),
    }));
    const board: Event[] = [
      { kind: "pinned", threshold: pins.threshold, registrars: pins.registrars },
      ...groups.map((g): Event => ({ kind: "created", groupId: g.id, tier: 0 })),
      ...groups.flatMap((g) => additions(g.id, g.leaves)),
    ];
    const electorate: TierElectorate = {
      tier: 0,
      root_l2_block: ROOT_BLOCK,
      groups: [...groups]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((g) => ({ group_id: g.id, region: g.region })),
      regions: t.regions.map(decimal),
      cells: t.cells.map((c) => ({ root: decimal(c.root), members: decimal(c.members) })),
    };
    return { vector: t, groups, records: logs(board), electorate };
  });
const tierOf = (id: string) => {
  const found = tiers.find((t) => t.vector.id === id);
  if (found === undefined) throw new Error(`no tier ${id}`);
  return found;
};

/** The group a commitment is counted in: the first, by `group_id`, that adds it. */
const homeOf = (t: (typeof tiers)[number], leaf: bigint) =>
  [...t.groups].sort((a, b) => (a.id < b.id ? -1 : 1)).find((g) => g.leaves.includes(leaf))?.id;

function refusal(f: () => unknown): TierMembershipErrorCode {
  try {
    f();
  } catch (e) {
    if (e instanceof TierMembershipError) return e.code;
    throw e;
  }
  throw new Error("not refused");
}

describe("tierMembership against regional-cells.json", () => {
  test("boards every strict tier of the vectors", () => {
    expect(tiers.map((t) => t.vector.id)).toEqual([
      "one-group",
      "repeat-across-groups",
      "repeat-within-group",
      "groups-ordered-by-id",
      "split",
      "repeat-moves-a-voter",
      "repeat-keeps-region-below-floor",
    ]);
  });

  test(
    "gives each member its cell, the cell's root and the vectors' path from the leaves",
    { timeout: 300_000 },
    () => {
      let checked = 0;
      for (const t of tiers)
        for (const [c, cell] of t.vector.cells.entries())
          for (const p of cell.paths) {
            const leaf = decimal(p.leaf);
            const home = homeOf(t, leaf);
            if (leaf === 0n || home === undefined) continue;
            const m = tierMembership(t.records, t.electorate, leaf, home, pins);
            const id = `${t.vector.id} cell ${c} [${p.index}]`;
            expect(m.cell, id).toBe(c);
            expect(m.root, id).toBe(decimal(cell.root));
            expect([...m.leaves].length, id).toBe(cell.leafCount);
            expect(tierTreeMemberPath(m.leaves, leaf), id).toEqual({
              index: p.index,
              siblings: p.siblings.map(decimal),
              root: decimal(cell.root),
            });
            checked++;
          }
      expect(checked).toBeGreaterThanOrEqual(12);
    },
  );

  test("alarms when a repeat moves the voter out of the region it registered in", () => {
    const t = tierOf("repeat-moves-a-voter");
    // 1007000000 is added to group 31 (region 0) and to group 33 (region 2).
    const e = (() => {
      try {
        tierMembership(t.records, t.electorate, 1_007_000_000n, 33n, pins);
      } catch (err) {
        return err;
      }
    })();
    expect(e).toBeInstanceOf(TierMembershipError);
    expect((e as TierMembershipError).code).toBe("moved");
    expect((e as TierMembershipError).group).toBe(31n);
    expect(tierMembership(t.records, t.electorate, 1_007_000_000n, 31n, pins).cell).toBe(0);
  });

  test("a repeat within one region keeps the voter in its cell", () => {
    const t = tierOf("repeat-across-groups");
    // 1000000001 is in group 11 and again in group 12, both region 0.
    expect(tierMembership(t.records, t.electorate, 1_000_000_001n, 12n, pins).cell).toBe(0);
  });
});

describe("tierMembership reads the board as untrusted", () => {
  const t = tierOf("split");
  const leaf = 1_000_001_000n; // group 22's first member
  const expected = tierMembership(t.records, t.electorate, leaf, 22n, pins);
  const same = (records: readonly ContractEventRecord[]) => {
    const m = tierMembership(records, t.electorate, leaf, 22n, pins);
    expect(m.cell).toBe(expected.cell);
    expect(m.root).toBe(expected.root);
    expect([...m.leaves]).toEqual([...expected.leaves]);
  };

  test(
    "in any order, with records boarded twice, and with other contracts' records",
    { timeout: 120_000 },
    () => {
      const other = {
        ...(t.records[1] as ContractEventRecord),
        contract: new Uint8Array(20).fill(7),
      };
      fc.assert(
        fc.property(
          fc.shuffledSubarray(t.records, { minLength: 0, maxLength: 3 }),
          fc.nat(),
          (twice, seed) => {
            const all = [...t.records, ...twice, other];
            // A deterministic shuffle from the seed.
            const shuffled = all
              .map((r, i) => ({ r, k: (i * 2_654_435_761 + seed) % 4_294_967_291 }))
              .sort((a, b) => a.k - b.k)
              .map((x) => x.r);
            same(shuffled);
          },
        ),
        { numRuns: Math.min(numRuns, 20) },
      );
    },
  );

  test("ignores records after root_l2_block and of groups the tier doesn't list", () => {
    const later = logs(
      [
        { ...added(22n, 700n, [1n << 100n]), block: ROOT_BLOCK + 1n },
        { kind: "created", groupId: 99n, tier: 0, block: ROOT_BLOCK + 1n },
      ],
      t.records.length + 100,
    );
    const otherGroup = logs(
      [{ kind: "created", groupId: 99n, tier: 0 }, ...additions(99n, [leaf, 5n])],
      t.records.length + 10,
    );
    same([...t.records, ...otherGroup, ...later]);
  });

  test("refuses records that fail the event check, disagree at one n, or go back in blocks", () => {
    const first = t.records[1] as ContractEventRecord;
    const bad = { ...first, topics: [new Uint8Array(32), ...first.topics.slice(1)] };
    expect(
      refusal(() =>
        tierMembership([...t.records, { ...bad, n: 1000n }], t.electorate, leaf, 22n, pins),
      ),
    ).toBe("board-event");
    const differs = { ...first, l2_timestamp: first.l2_timestamp + 1n };
    expect(
      refusal(() => tierMembership([...t.records, differs], t.electorate, leaf, 22n, pins)),
    ).toBe("board-event");
    const back = {
      ...(t.records[2] as ContractEventRecord),
      l2_block: 1n,
      l2_timestamp: 1_760_000_002n,
    };
    expect(
      refusal(() => tierMembership(t.records.with(2, back), t.electorate, leaf, 22n, pins)),
    ).toBe("board-event");
  });

  test("refuses a RegistrarsPinned other than the release's pins", () => {
    const other = logs([
      { kind: "pinned", threshold: 3, registrars: pins.registrars },
    ])[0] as ContractEventRecord;
    expect(
      refusal(() => tierMembership(t.records.with(0, other), t.electorate, leaf, 22n, pins)),
    ).toBe("registrars");
    const fewer = logs([
      { kind: "pinned", threshold: 2, registrars: pins.registrars.slice(0, 2) },
    ])[0];
    expect(
      refusal(() =>
        tierMembership(
          t.records.with(0, fewer as ContractEventRecord),
          t.electorate,
          leaf,
          22n,
          pins,
        ),
      ),
    ).toBe("registrars");
  });

  test("refuses a listed group with no creation by root_l2_block, two, or another tier's", () => {
    const at = t.records.findIndex((r) => r.topics.length === 3 && r.data.length === 0);
    const without = t.records.filter((_, i) => i !== at);
    expect(refusal(() => tierMembership(without, t.electorate, leaf, 22n, pins))).toBe(
      "group-created",
    );
    const late = { ...(t.records[at] as ContractEventRecord) };
    const created = t.records[at] as ContractEventRecord;
    const gid = BigInt(`0x${Buffer.from(created.topics[1] as Uint8Array).toString("hex")}`);
    const lateLog = logs(
      [{ kind: "created", groupId: gid, tier: 0, block: ROOT_BLOCK + 1n }],
      5000,
    )[0];
    expect(
      refusal(() =>
        tierMembership([...without, lateLog as ContractEventRecord], t.electorate, leaf, 22n, pins),
      ),
    ).toBe("group-created");
    const twice = logs(
      [{ kind: "created", groupId: gid, tier: 0 }],
      5000,
    )[0] as ContractEventRecord;
    expect(
      refusal(() => tierMembership([...t.records, twice], t.electorate, leaf, 22n, pins)),
    ).toBe("group-created");
    const tier2 = logs(
      [{ kind: "created", groupId: gid, tier: 2 }],
      Number(late.n),
    )[0] as ContractEventRecord;
    expect(
      refusal(() => tierMembership(t.records.with(at, tier2), t.electorate, leaf, 22n, pins)),
    ).toBe("group-tier");
  });

  test("refuses Tier 2 tiers, which have no addition path yet (P3-4)", () => {
    const board = logs([{ kind: "created", groupId: 7n, tier: 2 }]);
    const electorate: TierElectorate = {
      tier: 2,
      root_l2_block: ROOT_BLOCK,
      groups: [{ group_id: 7n, region: 0 }],
      regions: [1n],
      cells: [{ root: 5n, members: 1n }],
    };
    expect(refusal(() => tierMembership(board, electorate, 5n, 7n, pins))).toBe("tier-unsupported");
  });

  test("refuses a history the registry's rules forbid", () => {
    const g = t.groups.find((x) => x.id === 23n);
    if (g === undefined) throw new Error("no group 23");
    const at = t.records.findIndex(
      (r) => r.topics.length === 3 && r.data.length > 0 && r.topics[1]?.[31] === 23,
    );
    // Under the threshold of approvals.
    const unsigned = logs(
      [added(23n, 0n, g.leaves, 1)],
      Number(t.records[at]?.n),
    )[0] as ContractEventRecord;
    expect(
      refusal(() => tierMembership(t.records.with(at, unsigned), t.electorate, leaf, 22n, pins)),
    ).toBe("group-history");
    // A batch boarded again later, at a position the count has passed.
    const replayed = { ...(t.records[at] as ContractEventRecord), n: 9000n, l2_block: 50n };
    expect(
      refusal(() => tierMembership([...t.records, replayed], t.electorate, leaf, 22n, pins)),
    ).toBe("group-history");
    // A firstIndex topic other than the record's own.
    const moved = logs(
      [{ ...added(23n, 0n, g.leaves), firstIndex: 1n }],
      Number(t.records[at]?.n),
    )[0];
    expect(
      refusal(() =>
        tierMembership(
          t.records.with(at, moved as ContractEventRecord),
          t.electorate,
          leaf,
          22n,
          pins,
        ),
      ),
    ).toBe("group-history");
  });

  test("refuses regions or cells other than the board's", () => {
    const e = t.electorate;
    const regions = e.regions.with(1, (e.regions[1] as bigint) + 1n);
    expect(refusal(() => tierMembership(t.records, { ...e, regions }, leaf, 22n, pins))).toBe(
      "electorate",
    );
    const cells = e.cells.with(0, { ...(e.cells[0] as (typeof e.cells)[number]), members: 999n });
    expect(refusal(() => tierMembership(t.records, { ...e, cells }, leaf, 22n, pins))).toBe(
      "electorate",
    );
    expect(
      refusal(() => tierMembership(t.records, { ...e, cells: e.cells.slice(1) }, leaf, 22n, pins)),
    ).toBe("electorate");
  });

  test("refuses a commitment that isn't a live leaf of the group the voter registered in", () => {
    expect(refusal(() => tierMembership(t.records, t.electorate, 5n, 22n, pins))).toBe(
      "not-a-member",
    );
    // In the tier, but not in the group named.
    expect(refusal(() => tierMembership(t.records, t.electorate, leaf, 21n, pins))).toBe(
      "not-a-member",
    );
    expect(refusal(() => tierMembership(t.records, t.electorate, leaf, 98n, pins))).toBe(
      "not-a-member",
    );
    // Removed before root_l2_block. The removal leaves the counts one short,
    // so the definition is given the board's, as an honest one would be.
    const rm = logs([removed(22n, 700n, [0n])], 9000);
    const e = t.electorate;
    const regions = e.regions.with(1, (e.regions[1] as bigint) - 1n);
    const cells = e.cells.map((c, i) =>
      i === expected.cell ? { ...c, members: c.members - 1n } : c,
    );
    expect(
      refusal(() =>
        tierMembership([...t.records, ...rm], { ...e, regions, cells }, leaf, 22n, pins),
      ),
    ).toBe("not-a-member");
    expect(() =>
      tierMembership([...t.records, ...rm], { ...e, regions, cells }, leaf + 1n, 22n, pins),
    ).not.toThrow();
  });

  test("rejects malformed arguments rather than guessing", () => {
    expect(() => tierMembership(null as never, t.electorate, leaf, 22n, pins)).toThrow(TypeError);
    expect(() => tierMembership(t.records, t.electorate, 1n, 22n, pins)).toThrow(RangeError);
    expect(() => tierMembership(t.records, t.electorate, leaf, -1n, pins)).toThrow(RangeError);
    expect(() =>
      tierMembership(t.records, t.electorate, leaf, 22n, { ...pins, registry: new Uint8Array(19) }),
    ).toThrow(RangeError);
    const unordered = { ...t.electorate, groups: [...t.electorate.groups].reverse() };
    expect(() => tierMembership(t.records, unordered, leaf, 22n, pins)).toThrow(RangeError);
    const negative = {
      ...t.electorate,
      groups: t.electorate.groups.map((g) => ({ ...g, region: -1 })),
    };
    expect(() => tierMembership(t.records, negative, leaf, 22n, pins)).toThrow(RangeError);
    const noRegion = {
      ...t.electorate,
      groups: t.electorate.groups.map((g) => ({ ...g, region: 9 })),
    };
    expect(() => tierMembership(t.records, noRegion, leaf, 22n, pins)).toThrow(RangeError);
  });
});

describe("tierMembership feeds the prover", () => {
  test(
    "a Semaphore identity's cell gives the circuit inputs Semaphore's generateProof gives",
    { timeout: 60_000 },
    () => {
      const c = proverVectors.cases.find((x) => x.name === "first-tier");
      const tree = proverVectors.trees.find((x) => x.id === c?.tree);
      if (c === undefined || tree === undefined || tree.tier !== 0)
        throw new Error("no tier-0 case");
      const leaves = tree.leaves.map(decimal);
      const board = logs([
        { kind: "created", groupId: 1n, tier: 0 },
        ...additions(1n, leaves.slice(0, 1)),
        ...additions(1n, leaves.slice(1), 1n),
      ]);
      const electorate: TierElectorate = {
        tier: 0,
        root_l2_block: ROOT_BLOCK,
        groups: [{ group_id: 1n, region: 0 }],
        regions: [BigInt(leaves.length)],
        cells: [{ root: decimal(tree.root), members: BigInt(leaves.length) }],
      };
      const secret = hex(proverVectors.members[c.member]?.secret);
      const m = tierMembership(board, electorate, identityCommitment(secret), 1n, pins);
      const input = membershipProverInput(secret, m.leaves, {
        definitionHash: hex(proverVectors.definitionHash),
        tier: 0,
        root: m.root,
        message: hex(c.message),
      });
      expect(input.witness).toEqual(c.input);
      // A cell root the board's leaves don't climb to is refused by the prover.
      const wrong = {
        ...electorate,
        cells: [{ root: decimal(tree.root) + 1n, members: BigInt(leaves.length) }],
      };
      const w = tierMembership(board, wrong, identityCommitment(secret), 1n, pins);
      expect(() =>
        membershipProverInput(secret, w.leaves, {
          definitionHash: hex(proverVectors.definitionHash),
          tier: 0,
          root: w.root,
          message: hex(c.message),
        }),
      ).toThrow("root");
    },
  );
});

// A Tier 1 tier's leaves are the group's boarded additions, which the board
// carries exactly as counted (docs/spec/verifier.md, Contract events, Tier 1
// boarding). vouch-count.json's deployment, from the independent generator of
// vouch-count's vectors, says which of its additions count and each group's
// leaves at each block; the board below carries only the counted ones, as an
// honest operator's would (T-06, T-53).
describe("tierMembership in a Tier 1 tier", () => {
  const deployment = countVectors.cases.find((c) => c.id === "deployment");
  if (deployment === undefined) throw new Error("no deployment case");
  const tier1Registry = hex(countVectors.context.registry);
  const tier1Pins: GroupRegistryPins = {
    ...pins,
    chainId: decimal(countVectors.context.chainId),
    registry: tier1Registry,
  };
  const TIER1 = new Set([9n, 10n, 12n]);
  const counted = new Set(deployment.additions.filter((a) => a.valid).map((a) => a.at));

  /** The registry's log of vouch-count's event `at` (`n` = `at` + 1), or of a stand-in record there. */
  function logOf(at: number, record?: Uint8Array): ContractEventRecord {
    const e = deployment?.events[at];
    if (e === undefined) throw new Error(`no event ${at}`);
    const block = decimal(e.block);
    const base = {
      contract: tier1Registry,
      n: BigInt(at + 1),
      l2_block: block,
      l2_timestamp: 1_760_000_000n + block * 2n,
    };
    if (e.kind === "group-created")
      return {
        ...base,
        topics: [
          topic0("GroupCreated(uint64,uint8)"),
          word(decimal(e.groupId)),
          word(BigInt(e.tier as number)),
        ],
        data: new Uint8Array(0),
      };
    if (e.kind !== "tier1-addition") throw new Error(`event ${at} is ${e.kind}`);
    return {
      ...base,
      topics: [topic0("Tier1MemberAdded(bytes)")],
      data: abiBytes(record ?? hex(e.record)),
    };
  }
  const groupOf = (at: number) =>
    new DataView(hex(deployment.events[at]?.record).buffer).getBigUint64(0, false);

  // The Tier 1 groups' creations and their counted additions, nothing else.
  const board = deployment.events.flatMap((e, at) =>
    (e.kind === "group-created" && TIER1.has(decimal(e.groupId))) ||
    (e.kind === "tier1-addition" && counted.has(at))
      ? [logOf(at)]
      : [],
  );
  const finalLeaves = (groupId: bigint) => {
    const last = deployment.leaves.filter((l) => decimal(l.groupId) === groupId).at(-1);
    if (last === undefined) throw new Error(`no leaves for group ${groupId}`);
    return last.leaves.map(decimal);
  };
  const ROOT = 1_562_401n;
  const oneGroup = (groupId: bigint, leaves: readonly bigint[], root = ROOT): TierElectorate => ({
    tier: 1,
    root_l2_block: root,
    groups: [{ group_id: groupId, region: 0 }],
    regions: [BigInt(leaves.length)],
    cells: [{ root: 5n, members: BigInt(leaves.length) }],
  });

  test("boards the vectors' counted additions of three Tier 1 groups", () => {
    expect(board.length).toBe(3 + 10);
    expect(new Set(board.filter((r) => r.topics.length === 1).map((r) => r.n))).toEqual(
      new Set([...counted].map((at) => BigInt(at + 1))),
    );
  });

  // Each tierMembership call replays the Tier 1 groups' counted additions,
  // Groth16 checks included, which can pass the default timeout on a shared
  // runner.
  test("gives each group's leaves at every block the vectors list", { timeout: 60_000 }, () => {
    let checked = 0;
    for (const l of deployment.leaves) {
      const groupId = decimal(l.groupId);
      const leaves = l.leaves.map(decimal);
      if (!TIER1.has(groupId) || leaves.length === 0) continue;
      const electorate = oneGroup(groupId, leaves, decimal(l.block));
      for (const leaf of leaves) {
        const m = tierMembership(board, electorate, leaf, groupId, tier1Pins);
        expect(m.cell).toBe(0);
        expect(m.root).toBe(5n);
        expect([...m.leaves], `group ${groupId} at ${l.block}`).toEqual(leaves);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  test("voterCellV5 places a Tier 1 voter after every Tier 0 cell", { timeout: 60_000 }, () => {
    const groupId = 9n;
    const leaves = finalLeaves(groupId);
    const tier0 = tierOf("split").electorate;
    const definition = pollDefinition(
      [tier0, oneGroup(groupId, leaves)],
      tier1Registry,
      tier1Pins.chainId,
    );
    const found = voterCellV5(
      definition,
      boardEntries(definition, board),
      { commitment: leaves[0] as bigint, tier: 1, group: groupId },
      release,
    );
    if (!found.ok) throw new Error(found.code);
    expect(tier0.cells.length).toBeGreaterThan(1);
    expect(found.cell).toBe(tier0.cells.length);
    expect([...found.leaves]).toEqual(leaves);
  });

  test("applies the first-occurrence rule across Tier 1 groups and alarms on a move", () => {
    // Group 9 holds four commitments; groups 10 and 12 repeat three of them each.
    const nine = finalLeaves(9n);
    const ten = finalLeaves(10n);
    const twelve = finalLeaves(12n);
    expect(ten.every((c) => nine.includes(c))).toBe(true);
    expect(twelve.every((c) => nine.includes(c))).toBe(true);
    const electorate: TierElectorate = {
      tier: 1,
      root_l2_block: ROOT,
      groups: [
        { group_id: 9n, region: 0 },
        { group_id: 10n, region: 1 },
        { group_id: 12n, region: 0 },
      ],
      regions: [4n, 0n],
      cells: [{ root: 5n, members: 4n }],
    };
    // One cell (both regions fold, below the floor): group 9's leaves, then
    // groups 10's and 12's repeats, each zeroed at its index.
    const cell = [...nine, ...Array<bigint>(6).fill(0n)];
    const repeated = ten[0] as bigint;
    const m = tierMembership(board, electorate, repeated, 9n, tier1Pins);
    expect([...m.leaves]).toEqual(cell);
    // Registered in group 12, same region as group 9: counted there, no alarm.
    expect([
      ...tierMembership(board, electorate, twelve[0] as bigint, 12n, tier1Pins).leaves,
    ]).toEqual(cell);
    // Registered in group 10, counted in group 9 of another region: an alarm.
    const e = (() => {
      try {
        tierMembership(board, electorate, repeated, 10n, tier1Pins);
      } catch (err) {
        return err;
      }
    })();
    expect(e).toBeInstanceOf(TierMembershipError);
    expect((e as TierMembershipError).code).toBe("moved");
    expect((e as TierMembershipError).group).toBe(9n);
  });

  // Each tierMembership call replays the Tier 1 groups' counted additions,
  // Groth16 checks included, which can pass the default timeout on a shared
  // runner.
  test(
    "a board carrying more or fewer than the counted additions is refused",
    { timeout: 60_000 },
    () => {
      const leaves = finalLeaves(9n);
      const electorate = oneGroup(9n, leaves);
      const voter = leaves[0] as bigint;
      expect([...tierMembership(board, electorate, voter, 9n, tier1Pins).leaves]).toEqual(leaves);
      // Uncounted additions of the group: copies of a counted commitment...
      for (const at of [14, 15]) {
        expect(counted.has(at)).toBe(false);
        expect(
          refusal(() => tierMembership([...board, logOf(at)], electorate, voter, 9n, tier1Pins)),
          `event ${at}`,
        ).toBe("group-history");
      }
      // ...and a fresh commitment (event 36, its vouch's proof broken, given a
      // commitment no addition has): a leaf the definition doesn't count.
      expect(counted.has(36)).toBe(false);
      expect(groupOf(36)).toBe(9n);
      const fresh = hex(deployment.events[36]?.record);
      fresh.set(word(12_345n), 8);
      expect(
        refusal(() =>
          tierMembership([...board, logOf(36, fresh)], electorate, voter, 9n, tier1Pins),
        ),
      ).toBe("electorate");
      // A counted addition left off.
      const last = board.findLast((r) => r.topics.length === 1 && groupOf(Number(r.n) - 1) === 9n);
      expect(
        refusal(() =>
          tierMembership(
            board.filter((r) => r !== last),
            electorate,
            voter,
            9n,
            tier1Pins,
          ),
        ),
      ).toBe("electorate");
      // A boarded addition that doesn't decode fails the event check.
      expect(
        refusal(() => tierMembership([...board, logOf(38)], electorate, voter, 9n, tier1Pins)),
      ).toBe("board-event");
    },
  );

  test("refuses a boarded addition logged before its group's creation", () => {
    // Event 22 names group 12 before event 23 creates it; vouch-count's `group` check refuses it.
    expect(groupOf(22)).toBe(12n);
    expect(counted.has(22)).toBe(false);
    const leaves = finalLeaves(12n);
    expect(
      refusal(() =>
        tierMembership(
          [...board, logOf(22)],
          oneGroup(12n, leaves),
          leaves[0] as bigint,
          12n,
          tier1Pins,
        ),
      ),
    ).toBe("group-history");
  });

  test("refuses a boarded addition with a forbidden commitment", () => {
    const leaves = finalLeaves(9n);
    const record = hex(deployment.events[13]?.record);
    record.set(word(1n), 8);
    expect(
      refusal(() =>
        tierMembership(
          [...board, logOf(14, record)],
          oneGroup(9n, leaves),
          leaves[0] as bigint,
          9n,
          tier1Pins,
        ),
      ),
    ).toBe("group-history");
  });

  test("ignores what changes nothing in a Tier 1 group", () => {
    const leaves = finalLeaves(9n);
    const electorate = oneGroup(9n, leaves, 1_261_860n);
    const voter = leaves[0] as bigint;
    const expected = [...tierMembership(board, electorate, voter, 9n, tier1Pins).leaves];
    expect(expected).toEqual(leaves);
    // Other groups' additions, counted or not, and the group's own after root_l2_block.
    const others = deployment.events.flatMap((e, at) =>
      e.kind === "tier1-addition" && at !== 38 && at !== 43 && groupOf(at) !== 9n
        ? [logOf(at)]
        : [],
    );
    // An addition of group 9 with a fresh commitment, logged after root_l2_block.
    const fresh = hex(deployment.events[36]?.record);
    fresh.set(word(12_345n), 8);
    const later = logOf(43, fresh);
    // A MembersAdded and a MembersRemoved naming the group, which the registry
    // refuses, logged where vouch-count's other groups' records sit.
    const members = logs([added(9n, 0n, [5n]), removed(9n, 1n, [0n])]).map((r, i) => ({
      ...r,
      contract: tier1Registry,
      n: BigInt([3, 5][i] as number),
      l2_block: 1_100_000n,
      l2_timestamp: 1_760_000_000n + 2_200_000n,
    }));
    expect([
      ...tierMembership([...board, ...others, later, ...members], electorate, voter, 9n, tier1Pins)
        .leaves,
    ]).toEqual(expected);
  });

  test("feeds the prover the path Semaphore's generateProof takes", { timeout: 60_000 }, () => {
    const c = proverVectors.cases.find((x) => x.name === "first-tier");
    const tree = proverVectors.trees.find((x) => x.id === c?.tree);
    if (c === undefined || tree === undefined) throw new Error("no first-tier case");
    // The vectors' tree boarded as Tier 1 additions: vouch-count's first
    // counted record with its group and commitment replaced. No vouch is
    // checked by the client, so only the leaves matter here.
    const template = hex(deployment.events[13]?.record);
    const leaves = tree.leaves.map(decimal);
    // Events 13 to 22 are all additions, so each stand-in takes an addition's place.
    expect(leaves.length).toBeLessThanOrEqual(10);
    const records = leaves.map((leaf, i) => {
      const r = new Uint8Array(template);
      r.set(word(1n).subarray(24), 0);
      r.set(word(leaf), 8);
      return logOf(13 + i, r);
    });
    const created = {
      ...logOf(1),
      topics: [topic0("GroupCreated(uint64,uint8)"), word(1n), word(1n)],
    };
    const electorate: TierElectorate = {
      tier: 1,
      root_l2_block: ROOT,
      groups: [{ group_id: 1n, region: 0 }],
      regions: [BigInt(leaves.length)],
      cells: [{ root: decimal(tree.root), members: BigInt(leaves.length) }],
    };
    const secret = hex(proverVectors.members[c.member]?.secret);
    const m = tierMembership(
      [created, ...records],
      electorate,
      identityCommitment(secret),
      1n,
      tier1Pins,
    );
    const input = membershipProverInput(secret, m.leaves, {
      definitionHash: hex(proverVectors.definitionHash),
      tier: 1,
      root: m.root,
      message: hex(c.message),
    });
    // The path is the tier's, whatever the tier; the scope is Tier 1's.
    expect(input.witness.merkleProofIndex).toBe(c.input["merkleProofIndex"]);
    expect(input.witness.merkleProofSiblings).toEqual(c.input["merkleProofSiblings"]);
    expect(input.witness.scope).not.toBe(c.input["scope"]);
  });
});

// The creator's side (P2-22 part 3b-2): the electorate a definition states,
// from the registry's sequence. Every expected region count, cell root and
// member count is regional-cells.json's, from the independent implementation.
// The client's call: the whole board as the API serves it, encoded entries
// in any order, with the election's other records among them.
describe("voterCellV5 reads the voter's cell from the whole board", () => {
  const t = tierOf("split");
  const leaf = 1_000_001_000n; // group 22's first member
  const identity = { commitment: leaf, tier: 0, group: 22n };
  const definition = pollDefinition([t.electorate, ...typicalV5.electorate.slice(1)]);
  const expected = tierMembership(t.records, t.electorate, leaf, 22n, pins);
  const entries = boardEntries(definition, t.records);
  const otherElection = encodeBoardEntry(
    {
      election_id: new Uint8Array(32).fill(9),
      index: 0n,
      segment: 0,
      payload: encodeContractEvent(t.records[1] as ContractEventRecord, 8),
    },
    5,
  );
  // A payload of another record type (a transcript's header) and bytes that aren't an entry.
  const otherType = encodeBoardEntry(
    {
      election_id: definition.election_id,
      index: 0n,
      segment: 0,
      payload: Uint8Array.of(0x00, 0x05, 1, 2, 3),
    },
    5,
  );
  const noEntry = Uint8Array.of(0, 7, 0, 5);

  test(
    "gives tierMembership's cell and leaves, in any order, skipping what isn't the election's",
    { timeout: 120_000 },
    () => {
      fc.assert(
        fc.property(fc.nat(), (seed) => {
          const all = [...entries, otherElection, otherType, noEntry];
          const shuffled = all
            .map((e, i) => ({ e, k: (i * 2_654_435_761 + seed) % 4_294_967_291 }))
            .sort((a, b) => a.k - b.k)
            .map((x) => x.e);
          const found = voterCellV5(definition, shuffled, identity, release);
          if (!found.ok) throw new Error(found.code);
          expect(found.cell).toBe(expected.cell);
          expect([...found.leaves]).toEqual([...expected.leaves]);
        }),
        { numRuns: Math.min(numRuns, 10) },
      );
    },
  );

  test("refuses a contract-event payload that doesn't decode, which may be the registry's", () => {
    const payload = encodeContractEvent(t.records[1] as ContractEventRecord, 8);
    const broken = encodeBoardEntry(
      {
        election_id: definition.election_id,
        index: 0n,
        segment: 0,
        payload: payload.subarray(0, payload.length - 1),
      },
      5,
    );
    expect(voterCellV5(definition, [...entries, broken], identity, release)).toEqual({
      ok: false,
      code: "board-event",
    });
  });

  test("passes tierMembership's refusals on, with the group they concern", () => {
    expect(voterCellV5(definition, entries, { ...identity, group: 21n }, release)).toEqual({
      ok: false,
      code: "not-a-member",
      group: 21n,
    });
    // The release's registrars, never ones the board logs.
    expect(
      voterCellV5(definition, entries, identity, {
        registrars: [...release.registrars].reverse(),
        threshold: release.threshold,
      }),
    ).toMatchObject({ ok: false, code: "registrars" });
    // Without the tier's records the board can't give the voter a cell.
    expect(voterCellV5(definition, entries.slice(0, 1), identity, release)).toMatchObject({
      ok: false,
      code: "group-created",
    });
  });

  test("refuses a tier the electorate doesn't list and a profile 2.3 refuses", () => {
    expect(voterCellV5(definition, entries, { ...identity, tier: 1 }, release)).toEqual({
      ok: false,
      code: "tier-absent",
    });
    const v6 = {
      ...definition,
      profile: {
        protocol_major: 1,
        pins: POLL_PINS.map((p) => (p.record_type === 8 ? { ...p, version: 6 } : p)),
      },
    };
    expect(voterCellV5(v6, entries, identity, release)).toEqual({
      ok: false,
      code: "profile-combination",
    });
  });
});

describe("statedTierElectorate", () => {
  const choiceOf = (t: (typeof tiers)[number]): TierChoice => ({
    tier: 0,
    root_l2_block: ROOT_BLOCK,
    groups: t.electorate.groups,
  });

  test("states every strict tier of regional-cells.json as the vectors do", () => {
    for (const t of tiers)
      expect(statedTierElectorate(t.records, choiceOf(t), pins), t.vector.id).toEqual(t.electorate);
  });

  test("reads only the listed groups up to root_l2_block, ignoring other contracts", () => {
    const t = tierOf("split");
    const later = logs(
      [
        { ...added(22n, 700n, [1n << 100n]), block: ROOT_BLOCK + 1n },
        { kind: "created", groupId: 99n, tier: 0, block: ROOT_BLOCK + 1n },
      ],
      t.records.length + 100,
    );
    const otherGroup = logs(
      [{ kind: "created", groupId: 98n, tier: 0 }, ...additions(98n, [1_000_001_000n, 5n])],
      t.records.length + 10,
    );
    const other = {
      ...(t.records[1] as ContractEventRecord),
      contract: new Uint8Array(20).fill(7),
    };
    expect(
      statedTierElectorate([...t.records, ...otherGroup, ...later, other], choiceOf(t), pins),
    ).toEqual(t.electorate);
  });

  test(
    "states what the ballot client's recount accepts, for any regions the creator draws",
    { timeout: 300_000 },
    () => {
      const t = tierOf("split");
      const ids = t.electorate.groups.map((g) => g.group_id);
      fc.assert(
        fc.property(
          fc.array(fc.nat({ max: ids.length - 1 }), {
            minLength: ids.length,
            maxLength: ids.length,
          }),
          (draw) => {
            // Renumber so every region is named, in first-use order.
            const order = [...new Set(draw)];
            const groups = ids.map((group_id, i) => ({
              group_id,
              region: order.indexOf(draw[i] as number),
            }));
            const stated = statedTierElectorate(
              t.records,
              { tier: 0, root_l2_block: ROOT_BLOCK, groups },
              pins,
            );
            expect(stated.regions.reduce((a, b) => a + b, 0n)).toBe(
              t.electorate.regions.reduce((a, b) => a + b, 0n),
            );
            for (const g of t.groups) {
              const leaf = g.leaves.find((l) => homeOf(t, l) === g.id);
              if (leaf === undefined) continue;
              const m = tierMembership(t.records, stated, leaf, g.id, pins);
              expect(tierTreeRoot([...m.leaves])).toBe(m.root);
            }
          },
        ),
        { numRuns: Math.min(numRuns, 25) },
      );
    },
  );

  test("refuses a region with no counted member", () => {
    const t = tierOf("one-group");
    const board = [...t.records, ...logs([{ kind: "created", groupId: 500n, tier: 0 }], 900)];
    const gid = t.electorate.groups[0]?.group_id as bigint;
    const groups = [
      { group_id: gid, region: 0 },
      { group_id: 500n, region: 1 },
    ];
    expect(
      refusal(() =>
        statedTierElectorate(board, { tier: 0, root_l2_block: ROOT_BLOCK, groups }, pins),
      ),
    ).toBe("empty");
    // The empty group shares a region with a counted one: stated, holding no leaf.
    const shared = groups.map((g) => ({ ...g, region: 0 }));
    expect(
      statedTierElectorate(board, { tier: 0, root_l2_block: ROOT_BLOCK, groups: shared }, pins)
        .regions,
    ).toEqual(t.electorate.regions);
    // A region no group names.
    expect(
      refusal(() =>
        statedTierElectorate(
          t.records,
          { tier: 0, root_l2_block: ROOT_BLOCK, groups: [{ group_id: gid, region: 1 }] },
          pins,
        ),
      ),
    ).toBe("empty");
    // Read before the group was created.
    expect(
      refusal(() => statedTierElectorate(t.records, { ...choiceOf(t), root_l2_block: 9n }, pins)),
    ).toBe("group-created");
  });

  test("refuses Tier 1 and Tier 2 choices, whose additions it doesn't count", () => {
    const board = logs([{ kind: "created", groupId: 7n, tier: 1 }]);
    for (const tier of [1, 2])
      expect(
        refusal(() =>
          statedTierElectorate(
            board,
            { tier, root_l2_block: ROOT_BLOCK, groups: [{ group_id: 7n, region: 0 }] },
            pins,
          ),
        ),
      ).toBe("tier-unsupported");
    expect(
      refusal(() =>
        statedTierElectorate(
          board,
          { tier: 0, root_l2_block: ROOT_BLOCK, groups: [{ group_id: 7n, region: 0 }] },
          pins,
        ),
      ),
    ).toBe("group-tier");
  });

  test("refuses a history the release's registry can't log, as tierMembership does", () => {
    const t = tierOf("split");
    const choice = choiceOf(t);
    const at = t.records.findIndex((r) => r.topics.length === 3 && r.data.length === 0);
    expect(
      refusal(() =>
        statedTierElectorate(
          t.records.filter((_, i) => i !== at),
          choice,
          pins,
        ),
      ),
    ).toBe("group-created");
    const g = t.groups.find((x) => x.id === 23n);
    if (g === undefined) throw new Error("no group 23");
    const add = t.records.findIndex(
      (r) => r.topics.length === 3 && r.data.length > 0 && r.topics[1]?.[31] === 23,
    );
    const unsigned = logs(
      [added(23n, 0n, g.leaves, 1)],
      Number(t.records[add]?.n),
    )[0] as ContractEventRecord;
    expect(refusal(() => statedTierElectorate(t.records.with(add, unsigned), choice, pins))).toBe(
      "group-history",
    );
    const other = logs([
      { kind: "pinned", threshold: 3, registrars: pins.registrars },
    ])[0] as ContractEventRecord;
    expect(refusal(() => statedTierElectorate(t.records.with(0, other), choice, pins))).toBe(
      "registrars",
    );
  });

  test("refuses malformed choices before reading anything", () => {
    const t = tierOf("split");
    const choice = choiceOf(t);
    expect(() => statedTierElectorate(t.records, { ...choice, groups: [] }, pins)).toThrow(
      RangeError,
    );
    expect(() =>
      statedTierElectorate(t.records, { ...choice, groups: [...choice.groups].reverse() }, pins),
    ).toThrow(RangeError);
    expect(() =>
      statedTierElectorate(t.records, { ...choice, root_l2_block: 1n << 64n }, pins),
    ).toThrow(RangeError);
    expect(() =>
      statedTierElectorate(t.records, { ...choice, groups: [{ group_id: 21n, region: -1 }] }, pins),
    ).toThrow(RangeError);
    // Beyond what a definition can list: refused before any region is counted.
    expect(() =>
      statedTierElectorate(
        t.records,
        { ...choice, groups: [{ group_id: 21n, region: 1024 }] },
        pins,
      ),
    ).toThrow(RangeError);
    const many = Array.from({ length: 1025 }, (_, i) => ({ group_id: BigInt(i), region: 0 }));
    expect(() => statedTierElectorate(t.records, { ...choice, groups: many }, pins)).toThrow(
      RangeError,
    );
  });
});
