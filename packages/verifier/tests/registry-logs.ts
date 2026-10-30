import { keccak_256 } from "@noble/hashes/sha3.js";
import { readFileSync } from "node:fs";
import { expect } from "vite-plus/test";
import {
  type ContractEventRecord,
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  decodeElectionDefinitionV7,
  type ElectionDefinition,
  type ElectionDefinitionV5,
  type ElectionDefinitionV7,
  encodeGroupAddition,
  encodeGroupRemoval,
  encodeSelfPaidAddition,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  groupRemovalDigest,
  signGroupApproval,
  type TierElectorate,
} from "@abolishus/crypto";
import type { GroupRegistryRelease } from "../src/index.ts";

// The group registry's log as the registry emits it, for 2.4's recount
// (docs/spec/verifier.md, Electorate) here and the trustee node's electorate
// check. Each tier is one of regional-cells.json's, from an independent
// Python implementation of the fold, the first-occurrence rule and cell
// trees, logged under group-registry.json's test registrars; every stated
// region, root and count is the vectors', never the code under test's
// (T-13, T-16, T-71).

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
export const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as T;

type RawEvent =
  | { readonly add: string }
  | { readonly addRange: readonly [string, string] }
  | { readonly remove: string };

const cellsVectors = read<{
  readonly tiers: readonly {
    readonly id: string;
    readonly groups: readonly {
      readonly groupId: string;
      readonly region: number;
      readonly events: readonly RawEvent[];
    }[];
    readonly regions: readonly string[];
    readonly cells: readonly { readonly root: string; readonly members: string }[];
  }[];
}>("regional-cells.json");
export const registryVectors = read<{
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
export const definitionOf = (file: string, id: string) => {
  const found = read<{ vectors: readonly { id: string; encoding?: string }[] }>(file).vectors.find(
    (v) => v.id === id,
  )?.encoding;
  if (found === undefined) throw new Error(`no vector ${id}`);
  return hex(found);
};

export const decimal = (s: string | undefined) => {
  if (s === undefined || !/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};
export const hex = (s: string | undefined) => {
  if (s === undefined || !/^(?:[0-9a-f]{2})*$/.test(s)) throw new Error(`not hex: ${s}`);
  return Uint8Array.from(Buffer.from(s, "hex"));
};
export const word = (v: bigint) => hex(v.toString(16).padStart(64, "0"));
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
export const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

export const registry = hex(registryVectors.domain.verifyingContract);
export const chainId = BigInt(registryVectors.domain.chainId);
export const release: GroupRegistryRelease = {
  chainId,
  registry,
  registrars: registryVectors.registrars.addresses.map(hex),
  threshold: registryVectors.registrars.threshold,
};
const domain = groupRegistryDomainSeparator(chainId, registry);
const keys = registryVectors.registrars.secretKeys.map(hex);
export const ROOT_BLOCK = 100n;

// Every type 0x0001 to 0x0009 pinned, the contract event at version 8, as a
// poll the website creates pins them.
export const POLL_PINS = (
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

const typicalV5 = decodeElectionDefinitionV5(
  definitionOf("election-definition-v5.json", "definition-v5-typical"),
);
export const v5 = (electorate: readonly TierElectorate[]) => ({
  version: 5 as const,
  value: {
    ...typicalV5,
    l2_chain_id: chainId,
    group_registry: registry,
    electorate: [...electorate],
    profile: { protocol_major: 1, pins: POLL_PINS },
  } satisfies ElectionDefinitionV5,
});
const typicalV1 = decodeElectionDefinition(
  definitionOf("election-definition.json", "definition-typical"),
);
export const v1 = (electorate: ElectionDefinition["electorate"]) => ({
  version: 1 as const,
  value: {
    ...typicalV1,
    l2_chain_id: chainId,
    group_registry: registry,
    electorate,
    profile: {
      protocol_major: 1,
      pins: POLL_PINS.map((p) => (p.record_type === 1 ? { ...p, version: 1 } : p)),
    },
  } satisfies ElectionDefinition,
});

/** A registry event before it is logged: `logs` numbers and blocks them. */
export type Event =
  | { readonly kind: "created"; readonly groupId: bigint; readonly tier: number }
  | { readonly kind: "added"; readonly groupId: bigint; readonly record: Uint8Array }
  | { readonly kind: "removed"; readonly groupId: bigint; readonly record: Uint8Array }
  | { readonly kind: "self-paid-created"; readonly groupId: bigint }
  | {
      readonly kind: "self-paid";
      readonly groupId: bigint;
      readonly index: bigint;
      readonly record: Uint8Array;
    }
  | {
      readonly kind: "pinned";
      readonly threshold: number;
      readonly registrars: readonly Uint8Array[];
    };

const approve = (digest: Uint8Array, t = release.threshold) =>
  keys.slice(0, t).map((k, i) => signGroupApproval(digest, i + 1, new Uint8Array(k)));

export function added(
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

export function removed(groupId: bigint, size: bigint, indices: readonly bigint[]): Event {
  const digest = groupRemovalDigest(domain, { groupId, tier: 0, size, indices });
  const record = encodeGroupRemoval({ groupId, size, indices, approvals: approve(digest) });
  return { kind: "removed", groupId, record };
}

export function additions(groupId: bigint, commitments: readonly bigint[]): Event[] {
  const out: Event[] = [];
  for (let i = 0; i < commitments.length; i += 256)
    out.push(added(groupId, BigInt(i), commitments.slice(i, i + 256)));
  return out;
}

/**
 * The registry's log of `events`, numbered from `n` in order, at `block`
 * and `timestamp` unless given.
 */
export function logs(
  events: readonly (Event & { readonly block?: bigint; readonly timestamp?: bigint })[],
  n = 0,
): ContractEventRecord[] {
  return events.map((e, i) => {
    const block = e.block ?? 10n;
    const base = {
      contract: registry,
      n: BigInt(n + i),
      l2_block: block,
      l2_timestamp: e.timestamp ?? 1_760_000_000n + block * 2n,
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
          word(new DataView(e.record.buffer).getBigUint64(8, false)),
        ],
        data: abiBytes(e.record),
      };
    if (e.kind === "self-paid-created")
      return {
        ...base,
        topics: [topic0("SelfPaidGroupCreated(uint64)"), word(e.groupId)],
        data: new Uint8Array(0),
      };
    if (e.kind === "self-paid")
      return {
        ...base,
        topics: [
          topic0("SelfPaidMemberAdded(uint64,uint64,bytes)"),
          word(e.groupId),
          word(e.index),
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

// Every tier of regional-cells.json a strict replay accepts (no forbidden
// commitment or stray removal), logged as the registry logs it.
export const tiers = cellsVectors.tiers
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
    const events: Event[] = [
      { kind: "pinned", threshold: release.threshold, registrars: release.registrars },
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
    return { id: t.id, groups, events, records: logs(events), electorate };
  });
export const tierOf = (id: string) => {
  const found = tiers.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no tier ${id}`);
  return found;
};

export const selfPaid = (groupId: bigint, index: bigint, commitment: bigint): Event => ({
  kind: "self-paid",
  groupId,
  index,
  record: encodeSelfPaidAddition({ groupId, commitment }),
});

const selfPaidVectors = read<{
  readonly tiers: readonly {
    readonly id: string;
    readonly groups: readonly {
      readonly groupId: string;
      readonly region: number;
      readonly kind: "signed" | "self-paid";
    }[];
    readonly log: readonly (
      | { readonly group: string; readonly add: readonly string[] }
      | { readonly group: string; readonly remove: readonly string[] }
      | { readonly group: string; readonly selfPaid: string }
    )[];
    readonly regions: readonly string[];
    readonly cells: readonly { readonly root: string; readonly members: string }[];
  }[];
}>("self-paid.json");

// Every tier of self-paid.json (signed and self-paid groups, ranked by the
// first-occurrence rule's chain order), logged as the registry logs it:
// creations first, then the vector's log in chain order.
export const selfPaidTiers = selfPaidVectors.tiers.map((t) => {
  const events: Event[] = [
    { kind: "pinned", threshold: release.threshold, registrars: release.registrars },
    ...t.groups.map((g): Event =>
      g.kind === "signed"
        ? { kind: "created", groupId: decimal(g.groupId), tier: 0 }
        : { kind: "self-paid-created", groupId: decimal(g.groupId) },
    ),
  ];
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
  const electorate: TierElectorate = {
    tier: 0,
    root_l2_block: ROOT_BLOCK,
    groups: [...t.groups]
      .sort((a, b) => (decimal(a.groupId) < decimal(b.groupId) ? -1 : 1))
      .map((g) => ({ group_id: decimal(g.groupId), region: g.region })),
    regions: t.regions.map(decimal),
    cells: t.cells.map((c) => ({ root: decimal(c.root), members: decimal(c.members) })),
  };
  return { id: t.id, events, records: logs(events), electorate };
});

// rolling-tier-tree.json's trees, printed by an independent Python generator,
// logged as the registry logs them, and a rolling definition stating one:
// every opening state, step root and acceptance is the vectors' (2.4 and
// 5.1 under a rolling electorate; P2-17 parts 4c and 4d-2b).

export interface RollingVectorEvent {
  readonly block: string;
  readonly timestamp: string;
  readonly group: string;
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}
/**
 * The registry's events for a rolling vector's log: every group it names,
 * created at block 1, then each event signed at its group's running count,
 * at the vector's block and timestamp.
 */
export function rollingEvents(
  log: readonly RollingVectorEvent[],
): (Event & { block: bigint; timestamp: bigint })[] {
  const ids = [...new Set(log.map((e) => decimal(e.group)))].sort((a, b) => (a < b ? -1 : 1));
  const created = decimal(log[0]?.timestamp) - 1_000n;
  const events: (Event & { block: bigint; timestamp: bigint })[] = ids.map((groupId) => ({
    kind: "created",
    groupId,
    tier: 0,
    block: 1n,
    timestamp: created,
  }));
  const count = new Map<bigint, bigint>();
  for (const e of log) {
    const id = decimal(e.group);
    const at = { block: decimal(e.block), timestamp: decimal(e.timestamp) };
    const c = count.get(id) ?? 0n;
    if (e.remove !== undefined) events.push({ ...removed(id, c, e.remove.map(decimal)), ...at });
    else {
      const commitments = (e.add ?? []).map(decimal);
      events.push({ ...added(id, c, commitments), ...at });
      count.set(id, c + BigInt(commitments.length));
    }
  }
  return events;
}

export const rollingTrees = read<{
  readonly trees: readonly {
    readonly id: string;
    readonly groups: readonly string[];
    readonly events: readonly RollingVectorEvent[];
    readonly rootL2Block: string;
    readonly registeredAt: string;
    readonly closesAt: string;
    readonly opening: { readonly root: string; readonly memberCount: string };
    readonly steps: readonly {
      readonly step: string;
      readonly tau: string;
      readonly root: string;
      readonly memberCount: string;
      readonly accepted: boolean;
    }[];
  }[];
}>("rolling-tier-tree.json").trees.map((t) => {
  const events = rollingEvents(t.events);
  const tier = {
    tier: 0 as const,
    root_l2_block: decimal(t.rootL2Block),
    groups: t.groups.map(decimal),
    root: decimal(t.opening.root),
    group_size: decimal(t.opening.memberCount),
  };
  return {
    id: t.id,
    events,
    records: logs(events),
    tier,
    registeredAt: decimal(t.registeredAt),
    closesAt: decimal(t.closesAt),
    steps: t.steps.map((s) => ({
      step: decimal(s.step),
      tau: decimal(s.tau),
      root: decimal(s.root),
      memberCount: Number(decimal(s.memberCount)),
      accepted: s.accepted,
    })),
  };
});
export const rollingTree = (id: string) => {
  const found = rollingTrees.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no tree ${id}`);
  return found;
};

const rollingTypical = decodeElectionDefinitionV7(
  definitionOf("election-definition-v7.json", "definition-v7-rolling-typical"),
);
export const rolling = (
  tiers: ElectionDefinitionV7["rolling_electorate"],
  closesAt: bigint,
  version = 13,
): { version: 7; value: ElectionDefinitionV7 } => ({
  version: 7,
  value: {
    ...rollingTypical,
    l2_chain_id: chainId,
    group_registry: registry,
    closes_at: closesAt,
    rolling_electorate: [...tiers],
    // Contract-event version 13 unless given, the only one 2.3 lets a
    // version-7 definition pin, since only it reads the definition's own
    // registration; 2.4 reads the group registry's records under 1 to 13.
    profile: {
      protocol_major: 1,
      pins: rollingTypical.profile.pins.map((p) => (p.record_type === 8 ? { ...p, version } : p)),
    },
  },
});
