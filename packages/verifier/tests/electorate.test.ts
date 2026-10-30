import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  type ContractEventRecord,
  decodeElectionDefinitionV7,
  type TierElectorate,
  tierTreeRoot,
} from "@abolishus/crypto";
import { electorateCheck } from "../src/index.ts";
import {
  added,
  additions,
  chainId,
  definitionOf,
  type Event,
  logs,
  numRuns,
  registry,
  release,
  removed,
  rolling,
  rollingTree,
  rollingTrees,
  ROOT_BLOCK,
  selfPaid,
  selfPaidTiers,
  tierOf,
  tiers,
  v1,
  v5,
} from "./registry-logs.ts";

// 2.4's recount (docs/spec/verifier.md, Electorate) over the group
// registry's log of regional-cells.json's tiers (tests/registry-logs.ts):
// every stated region, root and count is the vectors' (T-13, T-16, T-71).

describe("electorateCheck", () => {
  test(
    "passes every strict tier of regional-cells.json as the vectors state it",
    { timeout: 60_000 },
    () => {
      expect(tiers.map((t) => t.id)).toEqual([
        "one-group",
        "repeat-across-groups",
        "repeat-within-group",
        "groups-ordered-by-id",
        "split",
        "repeat-moves-a-voter",
        "repeat-keeps-region-below-floor",
      ]);
      for (const t of tiers)
        expect(electorateCheck(v5([t.electorate]), t.records, release), t.id).toEqual({
          status: "pass",
        });
    },
  );

  test(
    "passes every tier of self-paid.json, signed and self-paid groups ranked by chain order",
    { timeout: 60_000 },
    () => {
      expect(selfPaidTiers.length).toBeGreaterThanOrEqual(8);
      for (const t of selfPaidTiers)
        expect(electorateCheck(v5([t.electorate]), t.records, release), t.id).toEqual({
          status: "pass",
        });
    },
  );

  test("passes a version-1 tier whose root and group_size are the vectors' one cell", () => {
    const t = tierOf("one-group");
    const [cell] = t.electorate.cells;
    const tier = {
      tier: 0 as const,
      group_id: t.electorate.groups[0]?.group_id as bigint,
      root: cell?.root as bigint,
      root_l2_block: ROOT_BLOCK,
      group_size: cell?.members as bigint,
    };
    expect(electorateCheck(v1([tier]), t.records, release)).toEqual({ status: "pass" });
    expect(electorateCheck(v1([{ ...tier, root: tier.root + 1n }]), t.records, release)).toEqual({
      status: "fail",
      code: "electorate",
      at: { tier: 0, cell: 0 },
    });
    expect(
      electorateCheck(v1([{ ...tier, group_size: tier.group_size - 1n }]), t.records, release),
    ).toEqual({ status: "fail", code: "electorate", at: { tier: 0, region: 0 } });
  });

  test(
    "fails a stated region, cell root, cell count or cell list that isn't the recount",
    { timeout: 120_000 },
    () => {
      const t = tierOf("split");
      const e = t.electorate;
      const check = (electorate: TierElectorate) =>
        electorateCheck(v5([electorate]), t.records, release);
      expect(check({ ...e, regions: e.regions.map((n, i) => (i === 1 ? n + 1n : n)) })).toEqual({
        status: "fail",
        code: "electorate",
        at: { tier: 0, region: 1 },
      });
      expect(
        check({ ...e, cells: e.cells.map((c, i) => (i === 1 ? { ...c, root: c.root ^ 1n } : c)) }),
      ).toEqual({ status: "fail", code: "electorate", at: { tier: 0, cell: 1 } });
      expect(
        check({
          ...e,
          cells: e.cells.map((c, i) => (i === 0 ? { ...c, members: c.members - 1n } : c)),
        }),
      ).toEqual({ status: "fail", code: "electorate", at: { tier: 0, cell: 0 } });
      expect(check({ ...e, cells: e.cells.slice(0, 1) })).toEqual({
        status: "fail",
        code: "electorate",
        at: { tier: 0 },
      });
    },
  );

  test(
    "fails a definition whose records lack any one addition, as a recount differing",
    { timeout: 300_000 },
    () => {
      const t = tierOf("split");
      const adds = t.records.flatMap((r, i) => (r.data.length > 0 && i > 0 ? [i] : []));
      fc.assert(
        fc.property(fc.constantFrom(...adds), (drop) => {
          const records = t.records.filter((_, i) => i !== drop);
          const outcome = electorateCheck(v5([t.electorate]), records, release);
          expect(outcome.status).toBe("fail");
        }),
        { numRuns: Math.min(numRuns, 10) },
      );
    },
  );

  test(
    "reads only the registry's records up to each tier's root_l2_block",
    { timeout: 60_000 },
    () => {
      const t = tierOf("split");
      const later = logs(
        [
          { ...added(22n, 700n, [1n << 100n]), block: ROOT_BLOCK + 1n },
          { kind: "created", groupId: 99n, tier: 0, block: ROOT_BLOCK + 1n },
        ],
        t.records.length,
      );
      const other = {
        ...(t.records[1] as ContractEventRecord),
        contract: new Uint8Array(20).fill(7),
      };
      expect(electorateCheck(v5([t.electorate]), [...t.records, ...later, other], release)).toEqual(
        {
          status: "pass",
        },
      );
    },
  );

  test("fails a definition naming another L2 or another group registry than the release pins", () => {
    const t = tierOf("one-group");
    const d = v5([t.electorate]);
    for (const value of [
      { ...d.value, l2_chain_id: chainId + 1n },
      { ...d.value, group_registry: new Uint8Array(20).fill(9) },
    ])
      expect(electorateCheck({ ...d, value }, t.records, release)).toEqual({
        status: "fail",
        code: "group-registry",
        at: {},
      });
  });

  test("fails a registry history the release's registrars don't sign, or that names other registrars", () => {
    const t = tierOf("one-group");
    const gid = t.electorate.groups[0]?.group_id as bigint;
    const d = v5([t.electorate]);
    // One approval short of the threshold.
    const short = logs([
      { kind: "created", groupId: gid, tier: 0 },
      added(gid, 0n, t.groups[0]?.leaves ?? [], release.threshold - 1),
    ]);
    expect(electorateCheck(d, short, release)).toEqual({
      status: "fail",
      code: "group-history",
      at: { tier: 0, group: gid },
    });
    const pinned = logs([
      {
        kind: "pinned",
        threshold: release.threshold,
        registrars: [...release.registrars].reverse(),
      },
    ]);
    expect(electorateCheck(d, [...pinned, ...t.records.slice(1)], release)).toEqual({
      status: "fail",
      code: "registrars",
      at: { tier: 0 },
    });
    // The release's own registrars, read under another threshold.
    expect(electorateCheck(d, t.records, { ...release, threshold: release.threshold + 1 })).toEqual(
      { status: "fail", code: "registrars", at: { tier: 0 } },
    );
  });

  test("fails a group never created, created twice or created for another tier", () => {
    const t = tierOf("one-group");
    const gid = t.electorate.groups[0]?.group_id as bigint;
    const d = v5([t.electorate]);
    const leaves = t.groups[0]?.leaves ?? [];
    const expectCode = (events: (Event & { readonly block?: bigint })[], code: string) =>
      expect(electorateCheck(d, logs(events), release)).toEqual({
        status: "fail",
        code,
        at: { tier: 0, group: gid },
      });
    expectCode(additions(gid, leaves), "group-created");
    expectCode(
      [
        { kind: "created", groupId: gid, tier: 0 },
        { kind: "created", groupId: gid, tier: 0 },
        ...additions(gid, leaves),
      ],
      "group-created",
    );
    expectCode([{ kind: "created", groupId: gid, tier: 1 }], "group-tier");
    // Created only after the tier's block.
    expectCode(
      [{ kind: "created", groupId: gid, tier: 0, block: ROOT_BLOCK + 1n }],
      "group-created",
    );
  });

  test("fails a removal signed for another group size, as a broken history", () => {
    const t = tierOf("one-group");
    const gid = t.electorate.groups[0]?.group_id as bigint;
    const size = BigInt(t.groups[0]?.leaves.length ?? 0);
    const records = [...t.records, ...logs([removed(gid, size + 1n, [0n])], t.records.length)];
    expect(electorateCheck(v5([t.electorate]), records, release)).toEqual({
      status: "fail",
      code: "group-history",
      at: { tier: 0, group: gid },
    });
  });

  test("fails two different records at one n", () => {
    const t = tierOf("one-group");
    const twin = { ...(t.records[2] as ContractEventRecord), n: 1n };
    expect(electorateCheck(v5([t.electorate]), [...t.records, twin], release)).toEqual({
      status: "fail",
      code: "group-records",
      at: { tier: 0 },
    });
  });

  test("leaves Tier 1 and Tier 2 tiers unverifiable, and fails a Tier 0 tier listed after one", () => {
    const t = tierOf("one-group");
    const other = { ...t.electorate, tier: 1 as const, groups: [{ group_id: 7n, region: 0 }] };
    const records = [...t.records, ...logs([{ kind: "created", groupId: 7n, tier: 1 }], 50)];
    for (const tier of [1, 2] as const)
      expect(electorateCheck(v5([{ ...other, tier }]), records, release)).toEqual({
        status: "unverifiable",
        code: "tier-unsupported",
        at: { tier: 0 },
      });
    expect(electorateCheck(v5([t.electorate, other]), records, release)).toEqual({
      status: "unverifiable",
      code: "tier-unsupported",
      at: { tier: 1 },
    });
    const wrong = { ...t.electorate, regions: [(t.electorate.regions[0] as bigint) + 1n] };
    expect(electorateCheck(v5([other, wrong]), records, release)).toEqual({
      status: "fail",
      code: "electorate",
      at: { tier: 1, region: 0 },
    });
  });

  test("fails a region with no counted member", () => {
    const t = tierOf("one-group");
    const gid = t.electorate.groups[0]?.group_id as bigint;
    const records = [...t.records, ...logs([{ kind: "created", groupId: 500n, tier: 0 }], 50)];
    const electorate = {
      ...t.electorate,
      groups: [
        { group_id: gid, region: 0 },
        { group_id: 500n, region: 1 },
      ],
      regions: [...t.electorate.regions, 1n],
    };
    expect(electorateCheck(v5([electorate]), records, release)).toEqual({
      status: "fail",
      code: "electorate",
      at: { tier: 0 },
    });
  });

  test("leaves an unread contract-event version unverifiable", () => {
    const t = tierOf("one-group");
    const d = v5([t.electorate]);
    const pins = d.value.profile.pins.map((p) => (p.record_type === 8 ? { ...p, version: 14 } : p));
    expect(
      electorateCheck(
        { ...d, value: { ...d.value, profile: { protocol_major: 1, pins } } },
        t.records,
        release,
      ),
    ).toEqual({ status: "unverifiable", code: "unsupported-version", at: {} });
  });

  test("checks a fixed version-7 definition as version 5's", { timeout: 60_000 }, () => {
    const fixed = decodeElectionDefinitionV7(
      definitionOf("election-definition-v7.json", "definition-v7-fixed-typical"),
    );
    const t = tierOf("split");
    const value = {
      ...fixed,
      l2_chain_id: chainId,
      group_registry: registry,
      electorate: [t.electorate],
      profile: { protocol_major: 1, pins: fixed.profile.pins },
    };
    const version = value.profile.pins.find((p) => p.record_type === 8)?.version;
    // Its vector pins a contract-event version this release reads.
    expect(version !== undefined && version <= 12).toBe(true);
    expect(electorateCheck({ version: 7, value }, t.records, release)).toEqual({ status: "pass" });
  });
});

// 2.4 under a rolling electorate (docs/spec/verifier.md, 2.4 and Electorate;
// [[membership]], Rolling checks; P2-17 part 4c), over each tree of
// rolling-tier-tree.json, printed by an independent Python generator and
// logged here as the registry logs it: every opening root and count is the
// vectors' (T-08, T-13, T-16, T-71).

describe("electorateCheck under a rolling electorate", () => {
  test("passes every tree of rolling-tier-tree.json stated at its opening state", () => {
    expect(rollingTrees.map((t) => t.id)).toEqual([
      "chain-order",
      "repeats-and-re-additions",
      "empty-opening",
    ]);
    for (const t of rollingTrees)
      expect(electorateCheck(rolling([t.tier], t.closesAt), t.records, release), t.id).toEqual({
        status: "pass",
      });
  });

  test("fails a root or group_size that isn't the opening state, never a later step's", () => {
    for (const t of rollingTrees) {
      const check = (tier: typeof t.tier) =>
        electorateCheck(rolling([tier], t.closesAt), t.records, release);
      const failed = { status: "fail", code: "electorate", at: { tier: 0 } };
      expect(check({ ...t.tier, root: t.tier.root ^ 1n }), t.id).toEqual(failed);
      expect(check({ ...t.tier, group_size: t.tier.group_size + 1n }), t.id).toEqual(failed);
    }
    // The same events stated at the close's tree: two members, not the opening's one.
    const t = rollingTree("empty-opening");
    expect(
      electorateCheck(rolling([{ ...t.tier, group_size: 1n }], t.closesAt), t.records, release),
    ).toEqual({ status: "fail", code: "electorate", at: { tier: 0 } });
  });

  test("fails a definition whose records lack its first addition", () => {
    const t = rollingTree("chain-order");
    const first = t.events.findIndex((e) => e.kind === "added");
    // Dropped, group 1's later additions no longer follow its own count.
    const records = logs(t.events.filter((_, i) => i !== first));
    expect(electorateCheck(rolling([t.tier], t.closesAt), records, release)).toEqual({
      status: "fail",
      code: "group-history",
      at: { tier: 0, group: 1n },
    });
  });

  test("replays the groups through close: a broken record before it fails, one after it is never read", () => {
    const t = rollingTree("repeats-and-re-additions");
    const last = t.events.at(-1) as (typeof t.events)[number];
    expect(last.timestamp > t.closesAt).toBe(true);
    const upToClose = t.events.filter((e) => e.timestamp <= t.closesAt);
    // A removal signed at a size group 1 never reaches, after root_l2_block.
    const broken = { ...removed(1n, 100n, [1n]), block: last.block - 1n, timestamp: t.closesAt };
    expect(broken.block > t.tier.root_l2_block).toBe(true);
    const d = rolling([t.tier], t.closesAt);
    expect(electorateCheck(d, logs([...upToClose, broken]), release)).toEqual({
      status: "fail",
      code: "group-history",
      at: { tier: 0, group: 1n },
    });
    expect(
      electorateCheck(
        d,
        logs([...t.events, { ...broken, block: last.block, timestamp: last.timestamp }]),
        release,
      ),
    ).toEqual({ status: "pass" });
  });

  test("fails a listed group created after root_l2_block, for another tier, or by records out of time order", () => {
    const t = rollingTree("repeats-and-re-additions");
    const d = rolling([t.tier], t.closesAt);
    const [first, ...rest] = t.events;
    const next = rest.findIndex((e) => e.block > t.tier.root_l2_block);
    const { block, timestamp } = rest[next] as (typeof rest)[number];
    const late = [
      ...rest.slice(0, next),
      { ...(first as (typeof t.events)[number]), block, timestamp },
      ...rest.slice(next),
    ];
    expect(electorateCheck(d, logs(late), release)).toEqual({
      status: "fail",
      code: "group-created",
      at: { tier: 0, group: 1n },
    });
    expect(
      electorateCheck(
        d,
        logs([
          { ...(first as (typeof t.events)[number]), kind: "created", groupId: 1n, tier: 1 },
          ...rest,
        ]),
        release,
      ),
    ).toEqual({ status: "fail", code: "group-tier", at: { tier: 0, group: 1n } });
    const back = t.events.map((e, i) => (i === t.events.length - 2 ? { ...e, timestamp: 0n } : e));
    expect(electorateCheck(d, logs(back), release)).toEqual({
      status: "fail",
      code: "group-records",
      at: { tier: 0 },
    });
  });

  test("passes a self-paid group's additions into the tree in chain order, with no first-occurrence rule", () => {
    const [c1, c2] = [1_000_000_000_001n, 1_000_000_000_002n];
    const at = (block: bigint) => ({ block, timestamp: 1_779_839_000n + block });
    const records = logs([
      { kind: "created", groupId: 1n, tier: 0, ...at(1n) },
      { kind: "self-paid-created", groupId: 2n, ...at(1n) },
      { ...added(1n, 0n, [c1, c2]), ...at(50n) },
      // A repeat of group 1's first commitment: its leaf counts, its member doesn't.
      { ...selfPaid(2n, 0n, c1), ...at(60n) },
    ]);
    const tier = {
      tier: 0 as const,
      root_l2_block: 60n,
      groups: [1n, 2n],
      root: tierTreeRoot([c1, c2, c1]),
      group_size: 2n,
    };
    const closesAt = at(60n).timestamp;
    expect(electorateCheck(rolling([tier], closesAt), records, release)).toEqual({
      status: "pass",
    });
    // The fixed recount's first-occurrence rule would zero the repeat.
    expect(
      electorateCheck(
        rolling([{ ...tier, root: tierTreeRoot([c1, c2, 0n]) }], closesAt),
        records,
        release,
      ),
    ).toEqual({ status: "fail", code: "electorate", at: { tier: 0 } });
  });

  test("leaves a Tier 1 or Tier 2 rolling tier unverifiable, after any Tier 0 tier that fails", () => {
    const t = rollingTree("chain-order");
    const first = t.events[0] as (typeof t.events)[number];
    const records = logs([
      { kind: "created", groupId: 70n, tier: 1, block: first.block, timestamp: first.timestamp },
      ...t.events,
    ]);
    const upper = {
      ...t.tier,
      tier: 1 as const,
      groups: [70n],
      root: tierTreeRoot([]),
      group_size: 0n,
    };
    for (const tier of [1, 2] as const)
      expect(electorateCheck(rolling([{ ...upper, tier }], t.closesAt), records, release)).toEqual({
        status: "unverifiable",
        code: "tier-unsupported",
        at: { tier: 0 },
      });
    expect(electorateCheck(rolling([t.tier, upper], t.closesAt), records, release)).toEqual({
      status: "unverifiable",
      code: "tier-unsupported",
      at: { tier: 1 },
    });
    expect(
      electorateCheck(
        rolling([{ ...t.tier, group_size: 0n }, upper], t.closesAt),
        records,
        release,
      ),
    ).toEqual({ status: "fail", code: "electorate", at: { tier: 0 } });
  });

  test("fails a rolling definition naming another L2 or group registry, and leaves an unread contract-event pin unverifiable", () => {
    const t = rollingTree("chain-order");
    const d = rolling([t.tier], t.closesAt);
    for (const value of [
      { ...d.value, l2_chain_id: chainId + 1n },
      { ...d.value, group_registry: new Uint8Array(20).fill(9) },
    ])
      expect(electorateCheck({ ...d, value }, t.records, release)).toEqual({
        status: "fail",
        code: "group-registry",
        at: {},
      });
    const pins = d.value.profile.pins.map((p) => (p.record_type === 8 ? { ...p, version: 14 } : p));
    expect(
      electorateCheck(
        { ...d, value: { ...d.value, profile: { protocol_major: 1, pins } } },
        t.records,
        release,
      ),
    ).toEqual({ status: "unverifiable", code: "unsupported-version", at: {} });
  });
});
