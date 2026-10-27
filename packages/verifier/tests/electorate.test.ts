import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  type ContractEventRecord,
  decodeElectionDefinitionV7,
  type TierElectorate,
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
  ROOT_BLOCK,
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
  test("passes every strict tier of regional-cells.json as the vectors state it", () => {
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
  });

  test("passes every tier of self-paid.json, signed and self-paid groups ranked by chain order", () => {
    expect(selfPaidTiers.length).toBeGreaterThanOrEqual(8);
    for (const t of selfPaidTiers)
      expect(electorateCheck(v5([t.electorate]), t.records, release), t.id).toEqual({
        status: "pass",
      });
  });

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

  test("reads only the registry's records up to each tier's root_l2_block", () => {
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
    expect(electorateCheck(v5([t.electorate]), [...t.records, ...later, other], release)).toEqual({
      status: "pass",
    });
  });

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

  test("leaves a rolling electorate and an unread contract-event version unverifiable", () => {
    const rolling = decodeElectionDefinitionV7(
      definitionOf("election-definition-v7.json", "definition-v7-rolling-typical"),
    );
    expect(electorateCheck({ version: 7, value: rolling }, [], release)).toEqual({
      status: "unverifiable",
      code: "rolling",
      at: {},
    });
    const t = tierOf("one-group");
    const d = v5([t.electorate]);
    const pins = d.value.profile.pins.map((p) => (p.record_type === 8 ? { ...p, version: 13 } : p));
    expect(
      electorateCheck(
        { ...d, value: { ...d.value, profile: { protocol_major: 1, pins } } },
        t.records,
        release,
      ),
    ).toEqual({ status: "unverifiable", code: "unsupported-version", at: {} });
  });

  test("checks a fixed version-7 definition as version 5's", () => {
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
