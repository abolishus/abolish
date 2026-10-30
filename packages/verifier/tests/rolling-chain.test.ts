import { describe, expect, test } from "vite-plus/test";
import { type RollingTierEvent, rollingTierSteps } from "@abolishus/crypto";
import { rollingChain, type RollingChainRelease } from "../src/index.ts";
import { definitionRegistered, encodingOf } from "./registration-logs.ts";
import {
  added,
  decimal,
  logs,
  read,
  release,
  rolling,
  rollingTree,
  rollingTrees,
} from "./registry-logs.ts";

// The chain a rolling poll's ballots are judged against (docs/spec/verifier.md,
// Electorate, The rolling chain; P2-17 part 4d-2b), from the registries'
// records as they log them: each tree of rolling-tier-tree.json logged by the
// group registry, and its definition's `DefinitionRegistered` at the vector's
// registration time. Every event, step root, member count and acceptance
// compared is the independent generator's, never the code under test's
// (T-08, T-13, T-34, T-71).

const raw = read<{
  readonly trees: readonly {
    readonly id: string;
    readonly events: readonly {
      readonly block: string;
      readonly timestamp: string;
      readonly group: string;
      readonly add?: readonly string[];
      readonly remove?: readonly string[];
    }[];
  }[];
}>("rolling-tier-tree.json");

/** A tree's definition (contract-event version 13, which reads its registration) and records. */
function poll(id: string, version = 13) {
  const t = rollingTree(id);
  const d = rolling([t.tier], t.closesAt, version);
  const registration = definitionRegistered(d, undefined, undefined, 99n, t.registeredAt);
  const pinned: RollingChainRelease = { ...release, electionRegistry: d.value.election_registry };
  return { t, d, registration, release: pinned, records: [...t.records, registration] };
}

function chainOf(outcome: ReturnType<typeof rollingChain>) {
  if (!("status" in outcome)) throw new Error(`stopped at ${outcome.check}`);
  return outcome.chain;
}

// The vectors' events of a tree's listed groups, in log order, through close
// and never short of root_l2_block ([[membership]], Rolling checks).
function expectedEvents(id: string): RollingTierEvent[] {
  const { tier, closesAt } = rollingTree(id);
  const events = raw.trees.find((t) => t.id === id)?.events ?? [];
  return events.flatMap((e): RollingTierEvent[] => {
    const at = {
      blockNumber: decimal(e.block),
      timestamp: decimal(e.timestamp),
      groupId: decimal(e.group),
    };
    if (!tier.groups.includes(at.groupId)) return [];
    if (at.timestamp > closesAt && at.blockNumber > tier.root_l2_block) return [];
    return [
      e.remove === undefined
        ? { ...at, kind: "add", commitments: (e.add ?? []).map(decimal) }
        : { ...at, kind: "remove", indices: e.remove.map(decimal) },
    ];
  });
}

// A tree's records with an addition to `group` at index 5, which no count
// of the vectors' reaches, logged before the tree's first addition, and the
// registration.
function withStray(t: ReturnType<typeof rollingTree>, group: bigint) {
  const first = t.events.findIndex((e) => e.kind !== "created");
  const { block, timestamp } = t.events[first] as (typeof t.events)[number];
  const stray = { ...added(group, 5n, [1_000_000_000_999n]), block, timestamp };
  const registration = definitionRegistered(
    rolling([t.tier], t.closesAt, 13),
    undefined,
    undefined,
    99n,
    t.registeredAt,
  );
  return [...logs([...t.events.slice(0, first), stray, ...t.events.slice(first)]), registration];
}

describe("rollingChain", () => {
  test("gives each tree's listed groups' events through close and its registration's time", () => {
    expect(rollingTrees.map((t) => t.id)).toEqual([
      "chain-order",
      "repeats-and-re-additions",
      "empty-opening",
    ]);
    for (const { id } of rollingTrees) {
      const { d, registration, records, release: pinned } = poll(id);
      const chain = chainOf(rollingChain(d, records, pinned));
      expect(chain.registeredAt, id).toBe(registration.l2_timestamp);
      expect(chain.events, id).toEqual(expectedEvents(id));
    }
  });

  test("gives the chain every step root, count and acceptance of the vectors through close", () => {
    for (const { id } of rollingTrees) {
      const { t, d, records, release: pinned } = poll(id);
      const chain = chainOf(rollingChain(d, records, pinned));
      const { steps } = rollingTierSteps(
        chain.events,
        {
          groups: t.tier.groups,
          rootL2Block: t.tier.root_l2_block,
          registeredAt: chain.registeredAt,
          closesAt: t.closesAt,
        },
        t.steps.map((s) => s.step),
      );
      // Every step is judged for acceptance; a step after close is never
      // accepted, and its tree reads events the chain rightly leaves out.
      expect(
        steps.map((s) => s.accepted),
        id,
      ).toEqual(t.steps.map((s) => s.accepted));
      const upToClose = t.steps.filter((s) => s.tau <= t.closesAt);
      expect(upToClose.length, id).toBeGreaterThan(1);
      expect(
        steps
          .filter((_, i) => (t.steps[i]?.tau ?? 0n) <= t.closesAt)
          .map(({ step, root, memberCount }) => ({ step, root, memberCount })),
        id,
      ).toEqual(upToClose.map(({ step, root, memberCount }) => ({ step, root, memberCount })));
    }
  });

  test("gives no chain where 2.4's recount doesn't pass", () => {
    const { t, d, records, release: pinned } = poll("chain-order");
    const stopped = (outcome: object) => ({ check: "2.4", outcome });
    // A stray addition to a listed group, at an index its count doesn't
    // reach, breaks the group's strict replay before close: no step root is
    // taken from it, or from any other record (T-08, T-71).
    expect(rollingChain(d, withStray(t, 2n), pinned)).toEqual(
      stopped({ status: "fail", code: "group-history", at: { tier: 0, group: 2n } }),
    );
    // Another group registry than the release pins.
    const elsewhere = { ...pinned, registry: new Uint8Array(20).fill(0x77) };
    expect(rollingChain(d, records, elsewhere)).toEqual(
      stopped({ status: "fail", code: "group-registry", at: {} }),
    );
    // An opening state the records don't reach.
    const overstated = rolling([{ ...t.tier, group_size: t.tier.group_size + 1n }], t.closesAt, 13);
    expect(rollingChain(overstated, records, pinned)).toEqual(
      stopped({ status: "fail", code: "electorate", at: { tier: 0 } }),
    );
    // A Tier 2 tier, which this release can't recount, and a contract-event
    // version it doesn't read: unverifiable, still no chain (T-36).
    expect(
      rollingChain(rolling([{ ...t.tier, tier: 2 }], t.closesAt, 13), records, pinned),
    ).toEqual(stopped({ status: "unverifiable", code: "tier-unsupported", at: { tier: 0 } }));
    expect(rollingChain(rolling([t.tier], t.closesAt, 14), records, pinned)).toEqual(
      stopped({ status: "unverifiable", code: "unsupported-version", at: {} }),
    );
  });

  test("an unlisted group's records, approved or not, change nothing", () => {
    const { t, d, records, release: pinned } = poll("chain-order");
    // Group 7 is created but listed by no tier: anything logged in it is
    // outside the tier's tree, its history included.
    expect(chainOf(rollingChain(d, withStray(t, 7n), pinned))).toEqual(
      chainOf(rollingChain(d, records, pinned)),
    );
  });

  test("gives no chain where the definition's registration isn't found", () => {
    const { t, d, registration, records, release: pinned } = poll("chain-order");
    const stopped = (code: string) => ({
      check: "registration",
      outcome: { status: "fail", code },
    });
    const groups = t.records;
    expect(rollingChain(d, groups, pinned)).toEqual(stopped("definition-unregistered"));
    // A second registration, or one of other bytes under the honest topic.
    const later = { ...d, value: { ...d.value, closes_at: d.value.closes_at + 1n } };
    expect(rollingChain(d, [...records, registration], pinned)).toEqual(
      stopped("definition-registered"),
    );
    expect(
      rollingChain(
        d,
        [...groups, definitionRegistered(d, encodingOf(later), undefined, 99n, t.registeredAt)],
        pinned,
      ),
    ).toEqual(stopped("definition-registered"));
    // Another election's registration is none of this one's.
    const elsewhere = { ...d, value: { ...d.value, election_id: new Uint8Array(32).fill(0x55) } };
    expect(
      rollingChain(
        d,
        [...groups, definitionRegistered(elsewhere, undefined, undefined, 99n, t.registeredAt)],
        pinned,
      ),
    ).toEqual(stopped("definition-unregistered"));
    // Another election registry than the release pins.
    expect(
      rollingChain(d, records, { ...pinned, electionRegistry: new Uint8Array(20).fill(0x77) }),
    ).toEqual(stopped("registries"));
    // Under contract-event version 11, whose `DefinitionRegistered` reads no
    // version-7 definition, the registration is no record of the registry's.
    const v11 = poll("chain-order", 11);
    expect(rollingChain(v11.d, v11.records, v11.release)).toEqual(stopped("registry-records"));
  });

  test("checks the recount before the registration", () => {
    const { t, d, release: pinned } = poll("chain-order");
    expect(rollingChain(d, t.records, { ...pinned, registry: new Uint8Array(20) })).toMatchObject({
      check: "2.4",
    });
  });

  test("refuses a fixed definition", () => {
    const { d, records, release: pinned } = poll("chain-order");
    const fixed = { ...d, value: { ...d.value, electorate_mode: 1 as const } };
    expect(() => rollingChain(fixed, records, pinned)).toThrow(TypeError);
  });
});
