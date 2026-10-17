import { keccak_256 } from "@noble/hashes/sha3.js";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ContractEventRecord, GroupRegistryEvent } from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// What countTier1Additions spends pairings on, and how it reads the group
// registry's archived sequence (docs/spec/vouching.md, Batched verification,
// Proofs last; docs/spec/contracts.md, Group registry, Verification). The
// batch verifier is wrapped to count the proofs it is given; its verdicts are
// the real ones. Verdicts are compared with vouch-count.json's, written by
// hand from the spec and reproduced by scripts/vouch-vectors.mjs, never with
// the code under test (T-52, T-38, T-71).

const checked: number[] = [];

vi.mock("../src/membership-proof.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/membership-proof.ts")>();
  return {
    ...real,
    verifyDecodedMembershipProofs: (
      checks: Parameters<typeof real.verifyDecodedMembershipProofs>[0],
    ) => {
      checked.push(checks.length);
      return real.verifyDecodedMembershipProofs(checks);
    },
  };
});

const { countTier1Additions, groupRegistryEvents, VOUCH_K, VOUCH_LENGTH } =
  await import("../src/index.ts");

interface EventVector {
  readonly kind: "group-created" | "members-added" | "members-removed" | "tier1-addition";
  readonly block: string;
  readonly groupId?: string;
  readonly tier?: number;
  readonly record?: string;
}

interface Vectors {
  readonly context: {
    readonly chainId: string;
    readonly registry: string;
    readonly registrars: readonly string[];
    readonly threshold: number;
  };
  readonly cases: readonly {
    readonly id: string;
    readonly events: readonly EventVector[];
    readonly additions: readonly {
      readonly at: number;
      readonly valid: boolean;
      readonly index?: number;
      readonly error?: string;
    }[];
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("vouch-count.json", SPEC_VECTORS), "utf8"),
) as Vectors;
// Topic 0 of each group-registry event, from the independent generator of
// contract-event-v6.json, so the logs built below are the registry's.
const eventVectors = JSON.parse(
  readFileSync(new URL("contract-event-v6.json", SPEC_VECTORS), "utf8"),
) as { readonly events: readonly { readonly signature: string; readonly topic0: string }[] };

const hex = (s: string | undefined) => {
  if (s === undefined || !/^(?:[0-9a-f]{2})*$/.test(s)) throw new Error(`not hex: ${s}`);
  return Uint8Array.from(Buffer.from(s, "hex"));
};
const decimal = (s: string | undefined) => {
  if (s === undefined || !/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};

const ctx = {
  chainId: decimal(vectors.context.chainId),
  registry: hex(vectors.context.registry),
  registrars: vectors.context.registrars.map(hex),
  threshold: vectors.context.threshold,
};
const deployment = vectors.cases.find((c) => c.id === "deployment");
if (deployment === undefined) throw new Error("no deployment case");

function events(list: readonly EventVector[]): GroupRegistryEvent[] {
  return list.map((e) => {
    const block = decimal(e.block);
    if (e.kind === "group-created")
      return { kind: e.kind, block, groupId: decimal(e.groupId), tier: e.tier as number };
    if (e.kind === "members-added" || e.kind === "members-removed")
      return { kind: e.kind, block, groupId: decimal(e.groupId), record: hex(e.record) };
    return { kind: e.kind, block, record: hex(e.record) };
  });
}
const all = events(deployment.events);
const tier1 = (at: number) => {
  const e = all[at];
  if (e?.kind !== "tier1-addition") throw new Error(`event ${at} is not a Tier 1 addition`);
  return e;
};
const counted = deployment.additions.filter((a) => a.valid).length;
const proofFailed = deployment.additions.filter((a) => a.error === "proof").length;

// A copy of an addition with its first vouch's two proofs exchanged: every
// point still decodes, the nullifiers are the original's, and both proofs fail.
function exchangedProofs(record: Uint8Array): Uint8Array {
  const copy = record.slice();
  const vouch = 41;
  const proofs = vouch + VOUCH_LENGTH - 512;
  copy.set(record.subarray(proofs + 256, proofs + 512), proofs);
  copy.set(record.subarray(proofs, proofs + 256), proofs + 256);
  return copy;
}

beforeEach(() => {
  checked.length = 0;
});

describe("countTier1Additions checks proofs last", () => {
  test(
    "spends pairings only on additions some walk counts, each proof once",
    { timeout: 120_000 },
    () => {
      const got = countTier1Additions(all, ctx);
      expect(got.additions.filter((a) => a.verdict.ok)).toHaveLength(counted);
      // Every counted addition's proofs and each failing one's, and nothing
      // for the copies, the spent slots and the cheap failures before them.
      expect(checked.reduce((n, c) => n + c, 0)).toBe(2 * VOUCH_K * (counted + proofFailed));
      // The failing proof's slots fund a later addition, which the first walk
      // left as slot-spent: the walk is redone, and only that addition's
      // proofs are checked again.
      expect(checked).toEqual([2 * VOUCH_K * (counted - 1 + proofFailed), 2 * VOUCH_K]);
    },
  );

  test("a copy of a counted addition with failing proofs fails slot-spent, unchecked", () => {
    // Events 0 to 13 of the deployment: the groups, the Tier 2 records and
    // its first counted addition, at 13.
    const first = all.slice(0, 14);
    const original = tier1(13);
    const bad = { ...original, record: exchangedProofs(original.record) };
    const got = countTier1Additions([...first, bad], ctx);
    expect(got.additions.map((a) => a.verdict)).toMatchObject([
      { ok: true, index: 0 },
      { ok: false, error: "slot-spent", vouch: 0 },
    ]);
    expect(checked).toEqual([2 * VOUCH_K]);
  });

  test("the same copy logged first fails proof, and the original then counts", () => {
    const original = tier1(13);
    const bad = { ...original, record: exchangedProofs(original.record) };
    const got = countTier1Additions([...all.slice(0, 13), bad, original], ctx);
    expect(got.additions.map((a) => a.verdict)).toMatchObject([
      { ok: false, error: "proof", vouch: 0, which: "vouchee" },
      { ok: true, index: 0 },
    ]);
    // The first walk counts the copy and leaves the original slot-spent.
    expect(checked).toEqual([2 * VOUCH_K, 2 * VOUCH_K]);
  });

  test("an honest replay takes one batch", () => {
    const got = countTier1Additions(all.slice(0, 14), ctx);
    expect(got.additions.map((a) => a.verdict.ok)).toEqual([true]);
    expect(checked).toEqual([2 * VOUCH_K]);
  });
});

// The group registry's logs for the deployment, as contract-event records:
// topics and ABI data built here as the registry's events emit them
// (docs/spec/contracts.md, Group registry, Events), each record its own `n`.
const topic0 = (signature: string) => {
  const found = eventVectors.events.find((e) => e.signature === signature);
  if (found === undefined) throw new Error(`no event ${signature}`);
  expect(Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString("hex")).toBe(
    found.topic0,
  );
  return hex(found.topic0);
};
const word = (v: bigint) => hex(v.toString(16).padStart(64, "0"));
const abiBytes = (b: Uint8Array) => {
  const padded = new Uint8Array(Math.ceil(b.length / 32) * 32);
  padded.set(b);
  return Uint8Array.from([...word(32n), ...word(BigInt(b.length)), ...padded]);
};
const u64At = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset).getBigUint64(at, false);

function logOf(e: GroupRegistryEvent, n: number): ContractEventRecord {
  const base = {
    contract: ctx.registry,
    n: BigInt(n),
    l2_block: e.block,
    l2_timestamp: 1_760_000_000n + e.block * 2n,
  };
  if (e.kind === "group-created")
    return {
      ...base,
      topics: [topic0("GroupCreated(uint64,uint8)"), word(e.groupId), word(BigInt(e.tier))],
      data: new Uint8Array(0),
    };
  if (e.kind === "members-added")
    return {
      ...base,
      topics: [
        topic0("MembersAdded(uint64,uint64,bytes)"),
        word(e.groupId),
        word(e.firstIndex ?? u64At(e.record, 8)),
      ],
      data: abiBytes(e.record),
    };
  if (e.kind === "members-removed")
    return {
      ...base,
      topics: [topic0("MembersRemoved(uint64,bytes)"), word(e.groupId)],
      data: abiBytes(e.record),
    };
  return { ...base, topics: [topic0("Tier1MemberAdded(bytes)")], data: abiBytes(e.record) };
}

const registrarsPinned = (n: number): ContractEventRecord => ({
  contract: ctx.registry,
  n: BigInt(n),
  l2_block: 1n,
  l2_timestamp: 1_760_000_002n,
  topics: [topic0("RegistrarsPinned(uint8,address[])")],
  data: Uint8Array.from([
    ...word(BigInt(ctx.threshold)),
    ...word(64n),
    ...word(BigInt(ctx.registrars.length)),
    ...ctx.registrars.flatMap((r) => [...new Uint8Array(12), ...r]),
  ]),
});

describe("groupRegistryEvents", () => {
  // Events 4 (a Tier 0 record that doesn't decode) and 38 (a Tier 1 addition
  // a byte short) are ones the registry never logs: logged, each fails the
  // event check. The rest are its sequence, after its RegistrarsPinned.
  const unloggable = [4, 38];
  const loggable = all.filter((_, i) => !unloggable.includes(i));
  const logs = [registrarsPinned(0), ...loggable.map((e, i) => logOf(e, i + 1))];
  const newAt = (at: number) => at - unloggable.filter((u) => u < at).length;

  test("reads the registry's logs as the events counting takes", { timeout: 120_000 }, () => {
    const read = groupRegistryEvents(logs, ctx.registry, 6);
    if (!read.ok) throw new Error(`refused at ${read.at}: ${read.error}`);
    // RegistrarsPinned counts nothing; each addition carries its topic.
    expect(read.events).toEqual(
      loggable.map((e) =>
        e.kind === "members-added" ? { ...e, firstIndex: u64At(e.record, 8) } : e,
      ),
    );
    const got = countTier1Additions(read.events, ctx);
    expect(
      got.additions.map((a) => ({
        at: a.at,
        valid: a.verdict.ok,
        ...(a.verdict.ok ? { index: a.verdict.index } : { error: a.verdict.error }),
      })),
    ).toEqual(
      deployment.additions
        .filter((a) => !unloggable.includes(a.at))
        .map((a) => ({
          at: newAt(a.at),
          valid: a.valid,
          ...(a.valid ? { index: a.index } : { error: a.error }),
        })),
    );
    expect(got.broken).toBeNull();
  });

  test("an event the registry never logs fails the event check", () => {
    for (const u of unloggable) {
      const e = all[u] as GroupRegistryEvent & { record: Uint8Array };
      const log = logOf(e.kind === "members-added" ? { ...e, firstIndex: 0n } : e, logs.length);
      expect(groupRegistryEvents([...logs, log], ctx.registry, 6)).toEqual({
        ok: false,
        at: logs.length,
        error: "event-data",
      });
    }
  });

  test("an addition whose firstIndex topic isn't its own first_index breaks its group", () => {
    const at = loggable.findIndex((e) => e.kind === "members-added");
    const e = loggable[at] as GroupRegistryEvent & { kind: "members-added" };
    const moved = logs.map((l, i) =>
      i === at + 1 ? logOf({ ...e, firstIndex: u64At(e.record, 8) + 1n }, at + 1) : l,
    );
    const read = groupRegistryEvents(moved, ctx.registry, 6);
    if (!read.ok) throw new Error(`refused at ${read.at}: ${read.error}`);
    const got = countTier1Additions(read.events, ctx);
    expect(got.broken).toEqual({ at, block: e.block, groupId: e.groupId, reason: "position" });
    // Without the topic the same record replays: only the topic broke it.
    expect(countTier1Additions(loggable.slice(0, at + 1), ctx).broken).toBeNull();
  });

  test("reports the first record that fails the event check, by position", () => {
    const other = { ...(logs[3] as ContractEventRecord), contract: new Uint8Array(20) };
    expect(
      groupRegistryEvents(
        [logs[0], logs[1], logs[2], other] as ContractEventRecord[],
        ctx.registry,
        6,
      ),
    ).toEqual({
      ok: false,
      at: 3,
      error: "unknown-contract",
    });
    const t1 = logs.findIndex((l) => l.topics.length === 1 && l.data.length > 1_000);
    expect(groupRegistryEvents(logs.slice(0, t1 + 1), ctx.registry, 5)).toEqual({
      ok: false,
      at: t1,
      error: "unknown-event",
    });
    const record = (logs[t1] as ContractEventRecord).data;
    const short = {
      ...(logs[t1] as ContractEventRecord),
      data: abiBytes(record.subarray(64, 64 + 41)),
    };
    expect(groupRegistryEvents([...logs.slice(0, t1), short], ctx.registry, 6)).toEqual({
      ok: false,
      at: t1,
      error: "event-data",
    });
  });

  test("refuses records out of the order of n, and a malformed registry", () => {
    expect(() =>
      groupRegistryEvents([logs[1], logs[0]] as ContractEventRecord[], ctx.registry, 6),
    ).toThrow(RangeError);
    expect(() =>
      groupRegistryEvents([logs[0], logs[0]] as ContractEventRecord[], ctx.registry, 6),
    ).toThrow(RangeError);
    expect(() => groupRegistryEvents(logs, new Uint8Array(0), 6)).toThrow(RangeError);
    expect(groupRegistryEvents([], ctx.registry, 6)).toEqual({ ok: true, events: [] });
  });
});
