import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  ds,
  H,
  PARAMETERS,
  semaphoreField,
  tierTreeRoot,
  tierTreeZeros,
  UNPINNED,
} from "../src/index.ts";
import { buildSchema, hex, readVectorFile, SPEC_VECTORS, type VectorFile } from "./spec-vectors.ts";

// docs/spec/vectors/election-definition-v7.json and rolling-tier-tree.json,
// printed by scripts/rolling-electorate-vectors.py (P2-17 part 1).
// packages/crypto has no codec or rolling tree for version 7 yet (part 3), so,
// as for version 6, these tests decode the definitions with codecs built from
// the file's own type descriptors, beside version 6's, so a record labelled
// with the other version reads that layout (T-31, T-36), and read the rolling
// tier tree, the root clock and the rolling scope from docs/spec/membership.md
// directly, with only the tier tree's root taken from packages/crypto.
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const rollingScope = (definitionHash: Uint8Array, tier: number) =>
  H(ds("abolish/v1/rolling-nullifier-scope", Uint8Array.from([...definitionHash, tier])));

type V7File = VectorFile & { readonly tags: { readonly rollingScope: string } };
const file = readVectorFile("election-definition-v7.json") as V7File;

function decodeError(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return undefined;
}

describe("election definition version 7 (docs/spec/election-definition.md, Layout (version 7))", () => {
  const v6 = readVectorFile("election-definition-v6.json");
  const { schema, type } = buildSchema({
    ...file,
    types: { ...v6.types, ...file.types },
    vectors: [...file.vectors, ...v6.vectors],
  });
  const { recordType } = type(file.vectors[0]!.type); // the file has vectors

  // Decoding, steps 1 and 2: strictly with no pin, then the record's own profile pin.
  const decode = (bytes: Uint8Array) => {
    const record = schema.decode(recordType, bytes, UNPINNED);
    const pins = (
      record.value as { profile: { pins: { record_type: number; version: number }[] } }
    ).profile.pins.filter((p) => p.record_type === 1);
    if (pins.length !== 1 || pins[0]!.version !== record.version)
      throw new DecodeError("profile-mismatch", 0);
    return record;
  };

  test("has unique ids, exactly one of value or error on each vector, and the tag", () => {
    expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
    for (const v of file.vectors) expect("value" in v !== "error" in v).toBe(true);
    expect(file.tags.rollingScope).toBe("abolish/v1/rolling-nullifier-scope");
  });

  const valid = file.vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const invalid = file.vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);

  test.each(valid)("%s decodes as version 7, re-encodes and hashes", (_id, v) => {
    const record = decode(hex(v.encoding));
    expect(record.version).toBe(7);
    expect(record.value).toEqual(type(v.type).built.fromJson(v.value));
    expect(toHex(schema.encode(recordType, 7, record.value as never))).toBe(v.encoding);
    const hash = H(ds("abolish/v1/election-definition", hex(v.encoding)));
    expect(toHex(hash)).toBe(v.hash);
    const stubHash = (stub: object) =>
      toHex(H(ds("abolish/v1/election-stub", schema.encode(recordType, 7, stub as never))));
    const stub = { ...(record.value as object), ceremony_transcript_hash: new Uint8Array(32) };
    const w = v as typeof v & {
      authorStubHash?: string;
      rollingScopes?: { tier: string; scope: string }[];
    };
    expect(stubHash(stub)).toBe(v.stubHash);
    expect(stubHash({ ...stub, author_transcript_hash: new Uint8Array(32) })).toBe(
      w.authorStubHash,
    );
    // Membership, Rolling scope: one per tier, from the definition hash alone.
    const { electorate_mode: mode, rolling_electorate: tiers } = record.value as {
      electorate_mode: number;
      rolling_electorate: { tier: number }[];
    };
    expect(w.rollingScopes === undefined).toBe(mode === 1);
    for (const [i, s] of (w.rollingScopes ?? []).entries()) {
      expect(s.tier).toBe(String(tiers[i]!.tier));
      expect(toHex(rollingScope(hash, tiers[i]!.tier))).toBe(s.scope);
    }
  });

  test.each(invalid)("%s is rejected", (_id, v) => {
    expect(decodeError(() => decode(hex(v.encoding)))).toBe(v.error);
  });

  test("labels every well-formedness rule version 7 adds, beside earlier ones", () => {
    const labelled = valid.map(([, v]) => v as typeof v & { illFormedQuestion?: string });
    expect(new Set(labelled.map((v) => v.illFormed).filter((r) => r !== undefined))).toEqual(
      new Set([
        "electorate",
        "rolling-class",
        "rolling-tier",
        "author-panel",
        "civic-sealed",
        "selections",
        "panel",
      ]),
    );
    for (const v of labelled)
      expect(v.illFormedQuestion !== undefined).toBe(v.illFormed === "selections");
  });
});

interface RollingEvent {
  readonly block: string;
  readonly timestamp: string;
  readonly group: string;
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

interface RollingTree {
  readonly leaves: readonly string[];
  readonly root: string;
  readonly memberCount: string;
}

interface RollingFile {
  readonly format: string;
  readonly rootPeriod: string;
  readonly rootOffset: string;
  readonly rootWindow: string;
  readonly trees: readonly {
    readonly id: string;
    readonly groups: readonly string[];
    readonly events: readonly RollingEvent[];
    readonly rootL2Block: string;
    readonly registeredAt: string;
    readonly closesAt: string;
    readonly opening: RollingTree;
    readonly steps: readonly (RollingTree & {
      readonly step: string;
      readonly tau: string;
      readonly accepted: boolean;
    })[];
  }[];
  readonly windows: readonly {
    readonly id: string;
    readonly step: string;
    readonly l1Timestamp: string;
    readonly window: "in" | "stale" | "future";
  }[];
  readonly scopes: readonly {
    readonly id: string;
    readonly definitionHash: string;
    readonly tier: number;
    readonly scope: string;
    readonly scopeField: string;
  }[];
}

/** Membership, Rolling tier tree: the listed groups' additions in chain order, removals by member index. */
function rollingLeaves(
  events: readonly RollingEvent[],
  groups: readonly string[],
  admit: (e: RollingEvent) => boolean,
): bigint[] {
  const leaves: bigint[] = [];
  const at = new Map<string, number>();
  const count = new Map<string, number>();
  for (const e of events) {
    if (!admit(e) || !groups.includes(e.group)) continue;
    for (const c of e.add ?? []) {
      const i = count.get(e.group) ?? 0;
      at.set(`${e.group}/${i}`, leaves.length);
      count.set(e.group, i + 1);
      leaves.push(BigInt(c));
    }
    for (const i of e.remove ?? []) leaves[at.get(`${e.group}/${i}`)!] = 0n;
  }
  return leaves;
}

const memberCount = (leaves: readonly bigint[]) => new Set(leaves.filter((x) => x !== 0n)).size;
const tau = (n: bigint) => n * BigInt(PARAMETERS.ROOT_PERIOD) + BigInt(PARAMETERS.ROOT_OFFSET);

describe("rolling tier trees (docs/spec/membership.md, Rolling tier tree, Root clock and steps)", () => {
  const rolling = JSON.parse(
    readFileSync(new URL("rolling-tier-tree.json", SPEC_VECTORS), "utf8"),
  ) as RollingFile;
  const z32 = tierTreeZeros()[32]!;

  test("carries the root clock's parameters", () => {
    expect(rolling.format).toBe("abolish-rolling-tier-tree-vectors/1");
    expect(rolling.rootPeriod).toBe(String(PARAMETERS.ROOT_PERIOD));
    expect(rolling.rootOffset).toBe(String(PARAMETERS.ROOT_OFFSET));
    expect(rolling.rootWindow).toBe(String(PARAMETERS.ROOT_WINDOW));
  });

  const check = (leaves: bigint[], want: RollingTree) => {
    expect(leaves.map(String)).toEqual(want.leaves);
    expect(String(tierTreeRoot(leaves))).toBe(want.root);
    expect(String(memberCount(leaves))).toBe(want.memberCount);
  };

  test.each(rolling.trees.map((t) => [t.id, t] as const))("%s", (_id, t) => {
    check(
      rollingLeaves(t.events, t.groups, (e) => BigInt(e.block) <= BigInt(t.rootL2Block)),
      t.opening,
    );
    for (const s of t.steps) {
      const boundary = tau(BigInt(s.step));
      expect(String(boundary)).toBe(s.tau);
      const leaves = rollingLeaves(t.events, t.groups, (e) => BigInt(e.timestamp) <= boundary);
      check(leaves, s);
      const accepted =
        boundary > BigInt(t.registeredAt) &&
        boundary <= BigInt(t.closesAt) &&
        leaves.length <= 2 ** 32 &&
        tierTreeRoot(leaves) !== z32;
      expect(accepted).toBe(s.accepted);
    }
  });

  test("covers accepted and refused steps, an empty opening and a repeated commitment", () => {
    const steps = rolling.trees.flatMap((t) => t.steps);
    expect(new Set(steps.map((s) => s.accepted))).toEqual(new Set([true, false]));
    expect(rolling.trees.some((t) => t.opening.root === String(z32))).toBe(true);
    // A repeat keeps its leaf but never counts twice.
    expect(
      steps.some((s) => s.leaves.filter((x) => x !== "0").length > Number(s.memberCount)),
    ).toBe(true);
  });

  test.each(rolling.windows.map((w) => [w.id, w] as const))("window %s", (_id, w) => {
    const boundary = tau(BigInt(w.step));
    const t = BigInt(w.l1Timestamp);
    const window = BigInt(PARAMETERS.ROOT_WINDOW);
    const verdict = boundary > t ? "future" : boundary <= t - window ? "stale" : "in";
    expect(verdict).toBe(w.window);
  });

  test.each(rolling.scopes.map((s) => [s.id, s] as const))("scope %s", (_id, s) => {
    const scope = rollingScope(hex(s.definitionHash), s.tier);
    expect(toHex(scope)).toBe(s.scope);
    expect(String(semaphoreField(scope))).toBe(s.scopeField);
  });
});
