import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  decodeElectionDefinitionV6,
  decodeElectionDefinitionV7,
  DEFINITION_V3_LIMITS,
  DEFINITION_V7_LIMITS,
  type ElectionDefinitionV7,
  electionAuthorStubV7Hash,
  electionDefinitionV7Hash,
  electionDefinitionV7Rule,
  electionStubV7Hash,
  ELECTORATE_MODES,
  encodeElectionDefinitionV6,
  encodeElectionDefinitionV7,
  nullifierScope,
  profileCombinationRule,
  type RollingTier,
  rollingNullifierScope,
} from "../src/index.ts";
import { hex, readVectorFile } from "./spec-vectors.ts";

// Properties of election-definition version 7 (docs/spec/election-definition.md,
// Layout (version 7), Rolling electorates, Well-formedness) and the rolling
// scope (docs/spec/membership.md, Rolling scope): every value round-trips and
// every accepted encoding re-encodes to itself, a fixed version-7 definition
// is version 6's bytes with the mode and an empty list appended, the electorate
// and the new rules accept exactly what the spec's rows accept and in their
// order, the stubs bind the rolling electorate, and the rolling scope is the
// spec's formula (T-01, T-13, T-16, T-31, T-34, T-36).
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const opts = { numRuns };

const vector = (file: string, id: string) => {
  const v = readVectorFile(file).vectors.find((x) => x.id === id);
  if (v === undefined) throw new Error(`${id} is missing`);
  return v;
};

const rollingTypical = decodeElectionDefinitionV7(
  hex(vector("election-definition-v7.json", "definition-v7-rolling-typical").encoding),
);
const fixedTypical = decodeElectionDefinitionV7(
  hex(vector("election-definition-v7.json", "definition-v7-fixed-typical").encoding),
);
// Sealed, so a civic class meets `civic-sealed` and only the rolling rules judge it.
const sealedRolling = { ...rollingTypical, results_mode: 1, live_every: 0, live_batch: 0 } as const;
const typicalV6 = decodeElectionDefinitionV6(
  hex(vector("election-definition-v6.json", "definition-v6-typical").encoding),
);

/** `H(DS(tag, bytes))` by the spec's formula, with node:crypto rather than the code under test. */
function specHash(tag: string, bytes: Uint8Array): Uint8Array {
  const t = Buffer.from(tag, "ascii");
  return Uint8Array.from(
    createHash("sha256")
      .update(Buffer.concat([Buffer.from([t.length]), t, bytes]))
      .digest(),
  );
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const tier = fc.constantFrom(0, 1, 2) as fc.Arbitrary<0 | 1 | 2>;
const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
// Below the BN254 scalar field's order, so every value encodes.
const root = fc.bigInt({ min: 0n, max: (1n << 253n) - 1n });

const anyRollingTier: fc.Arbitrary<RollingTier> = fc.record({
  tier,
  root_l2_block: u64,
  groups: fc.array(u64, { maxLength: 8 }),
  root,
  group_size: u64,
});

// Few group identifiers and tiers, so repeats, disorder and sharing are common.
const smallRollingTier: fc.Arbitrary<RollingTier> = fc.record({
  tier,
  root_l2_block: fc.constant(41_000_000n),
  groups: fc.array(fc.bigInt({ min: 0n, max: 5n }), { maxLength: 4 }),
  root: fc.constantFrom(0n, 1n, 2n),
  group_size: fc.constantFrom(0n, 1n),
});

type V7Fields = Pick<
  ElectionDefinitionV7,
  "electorate_mode" | "rolling_electorate" | "electorate" | "poll_class"
>;

const smallFields: fc.Arbitrary<V7Fields> = fc.record({
  electorate_mode: fc.constantFrom(1, 2) as fc.Arbitrary<1 | 2>,
  rolling_electorate: fc.array(smallRollingTier, { maxLength: 3 }),
  electorate: fc.constantFrom(fixedTypical.electorate, []),
  poll_class: fc.constantFrom(1, 2, 3) as fc.Arbitrary<1 | 2 | 3>,
});

/**
 * The spec's `electorate` (mode and lists only: the fixed electorate, when
 * present, is the typical one, which meets version 6's rows), `rolling-class`
 * and `rolling-tier` rows, read directly. A civic poll here is sealed, so
 * `civic-sealed`, between them, holds.
 */
function specRule(f: V7Fields) {
  const tiers = f.rolling_electorate.map((t) => t.tier);
  const ascending = tiers.every((t, i) => i === 0 || tiers[i - 1]! < t);
  if (f.electorate_mode === 1) {
    if (f.electorate.length === 0 || f.rolling_electorate.length > 0) return "electorate";
  } else if (f.electorate.length > 0 || tiers.length === 0 || !ascending) return "electorate";
  if (f.electorate_mode === 2 && f.poll_class !== 1) return "rolling-class";
  const all = f.rolling_electorate.flatMap((t) => t.groups);
  if (
    f.rolling_electorate.some(
      (t) => t.groups.length === 0 || t.groups.some((g, i) => i > 0 && t.groups[i - 1]! >= g),
    ) ||
    new Set(all).size !== all.length
  )
    return "rolling-tier";
  return undefined;
}

describe("definition version 7", () => {
  test("its limits and enums are the spec's, and the typical definitions are well formed", () => {
    expect(DEFINITION_V7_LIMITS.groupsPerTier).toBe(DEFINITION_V3_LIMITS.groupsPerTier);
    expect(ELECTORATE_MODES).toEqual({ fixed: 1, rolling: 2 });
    expect(electionDefinitionV7Rule(rollingTypical)).toBeUndefined();
    expect(electionDefinitionV7Rule(fixedTypical)).toBeUndefined();
  });

  test(
    "every value of the new fields round-trips, and each encoding re-encodes to itself",
    { timeout: 120_000 },
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom(1, 2) as fc.Arbitrary<1 | 2>,
          fc.array(anyRollingTier, { maxLength: 3 }),
          (mode, tiers) => {
            const d = { ...rollingTypical, electorate_mode: mode, rolling_electorate: tiers };
            const bytes = encodeElectionDefinitionV7(d);
            const decoded = decodeElectionDefinitionV7(bytes);
            expect(decoded).toEqual(d);
            expect(encodeElectionDefinitionV7(decoded)).toEqual(bytes);
          },
        ),
        opts,
      );
    },
  );

  test("a fixed version-7 definition is version 6's bytes with the mode and an empty list appended", () => {
    const six = encodeElectionDefinitionV6(typicalV6);
    const seven = encodeElectionDefinitionV7({
      ...typicalV6,
      electorate_mode: 1,
      rolling_electorate: [],
    });
    // The header is the record type (u16) and the version byte; a list count is a u32.
    expect(seven[2]).toBe(7);
    expect(toHex(seven.subarray(3))).toBe(`${toHex(six.subarray(3))}0100000000`);
  });

  test(
    "every accepted single-byte change re-encodes to the changed bytes",
    { timeout: 60_000 },
    () => {
      const bytes = encodeElectionDefinitionV7(rollingTypical);
      fc.assert(
        fc.property(fc.nat({ max: bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), (i, x) => {
          const changed = new Uint8Array(bytes);
          changed[i]! ^= x;
          let decoded: ElectionDefinitionV7;
          try {
            decoded = decodeElectionDefinitionV7(changed);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            return;
          }
          expect(toHex(encodeElectionDefinitionV7(decoded))).toBe(toHex(changed));
        }),
        opts,
      );
    },
  );

  test("1025 groups in a rolling tier don't encode", () => {
    const groups = Array.from({ length: 1025 }, (_, i) => BigInt(i));
    const [first] = rollingTypical.rolling_electorate;
    expect(() =>
      encodeElectionDefinitionV7({
        ...rollingTypical,
        rolling_electorate: [{ ...first!, groups }],
      }),
    ).toThrow();
  });

  test("the electorate and the new rules accept exactly what the spec's rows accept, in their order", () => {
    fc.assert(
      fc.property(smallFields, (f) => {
        const rule = specRule(f);
        expect(electionDefinitionV7Rule({ ...sealedRolling, ...f })).toEqual(
          rule === undefined ? undefined : { rule },
        );
      }),
      opts,
    );
  });

  test("version 6's rules hold in their places: questions first, the tail and panels before rolling-class", () => {
    fc.assert(
      fc.property(smallFields, (f) => {
        const d = { ...sealedRolling, ...f };
        expect(electionDefinitionV7Rule({ ...d, questions: [] })).toEqual({ rule: "questions" });
        // `electorate` comes before `panel`; after it, `panel` and
        // `receipt-keys` come before both rolling rules.
        const electorate = specRule(f) === "electorate";
        expect(electionDefinitionV7Rule({ ...d, threshold: 1 })).toEqual({
          rule: electorate ? "electorate" : "panel",
        });
        expect(electionDefinitionV7Rule({ ...d, receipt_keys: [] })).toEqual({
          rule: electorate ? "electorate" : "receipt-keys",
        });
        expect(electionDefinitionV7Rule({ ...d, author_threshold: 1, author_keys: [] })).toEqual({
          rule: electorate ? "electorate" : "author-panel",
        });
      }),
      opts,
    );
  });

  test("under mode 1 the fixed electorate's own rules and cells apply", () => {
    const [first] = fixedTypical.electorate;
    expect(
      electionDefinitionV7Rule({ ...fixedTypical, electorate: [{ ...first!, regions: [] }] }),
    ).toEqual({ rule: "electorate" });
    expect(
      electionDefinitionV7Rule({ ...fixedTypical, electorate: [{ ...first!, cells: [] }] }),
    ).toEqual({ rule: "cells" });
  });

  test("a rolling tier may open empty, with no live member", () => {
    const [first, ...rest] = rollingTypical.rolling_electorate;
    const empty = { ...first!, root: 0n, group_size: 0n };
    expect(
      electionDefinitionV7Rule({ ...rollingTypical, rolling_electorate: [empty, ...rest] }),
    ).toBeUndefined();
  });

  test("the stubs bind the electorate mode and the rolling electorate", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(fc.array(anyRollingTier, { maxLength: 3 }), (tiers) => {
        const d = { ...rollingTypical, rolling_electorate: tiers };
        const zero32 = new Uint8Array(32);
        const stub = specHash(
          "abolish/v1/election-stub",
          encodeElectionDefinitionV7({ ...d, ceremony_transcript_hash: zero32 }),
        );
        expect(electionStubV7Hash(d)).toEqual(stub);
        expect(electionAuthorStubV7Hash(d)).toEqual(
          specHash(
            "abolish/v1/election-stub",
            encodeElectionDefinitionV7({
              ...d,
              ceremony_transcript_hash: zero32,
              author_transcript_hash: zero32,
            }),
          ),
        );
        expect(electionDefinitionV7Hash(d)).toEqual(
          specHash("abolish/v1/election-definition", encodeElectionDefinitionV7(d)),
        );
        const sameTiers = JSON.stringify(tiers, (_k, v: unknown) =>
          typeof v === "bigint" ? String(v) : v,
        );
        const typicalTiers = JSON.stringify(rollingTypical.rolling_electorate, (_k, v: unknown) =>
          typeof v === "bigint" ? String(v) : v,
        );
        if (sameTiers !== typicalTiers)
          expect(electionStubV7Hash(d)).not.toEqual(electionStubV7Hash(rollingTypical));
        expect(electionStubV7Hash({ ...d, electorate_mode: 1 })).not.toEqual(electionStubV7Hash(d));
      }),
      opts,
    );
  });

  // 2.3 knows no pairing for version 7 until P2-17 part 4, so a client that
  // must refuse an election bound to fail it refuses every version-7 one.
  test("2.3's profile combination refuses a version-7 definition", () => {
    for (const d of [rollingTypical, fixedTypical])
      expect(profileCombinationRule(d as never)).toBe("profile-combination");
  });
});

describe("rolling scope (docs/spec/membership.md, Rolling scope)", () => {
  test("is the spec's formula over 33 bytes, binds the tier and never equals a fixed scope", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        tier,
        fc.bigInt({ min: 1n, max: (1n << 253n) - 1n }),
        (hash, t, r) => {
          const scope = rollingNullifierScope(hash, t);
          expect(scope).toEqual(
            specHash("abolish/v1/rolling-nullifier-scope", Uint8Array.from([...hash, t])),
          );
          for (const other of [0, 1, 2])
            if (other !== t) expect(rollingNullifierScope(hash, other)).not.toEqual(scope);
          expect(nullifierScope(hash, t, r)).not.toEqual(scope);
        },
      ),
      opts,
    );
  });

  test("refuses a tier outside 0 to 2 and a hash that isn't 32 bytes", () => {
    const hash = new Uint8Array(32).fill(7);
    for (const t of [-1, 3, 0.5, Number.NaN])
      expect(() => rollingNullifierScope(hash, t)).toThrow(RangeError);
    for (const h of [new Uint8Array(31), new Uint8Array(33)])
      expect(() => rollingNullifierScope(h, 0)).toThrow(TypeError);
  });
});
