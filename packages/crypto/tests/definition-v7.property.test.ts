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
  type ElectionDefinitionV6,
  ELECTORATE_MODES,
  encodeElectionDefinitionV6,
  encodeElectionDefinitionV7,
  nullifierScope,
  profileCombinationRule,
  RECORD_TYPES,
  RESULTS_MODES,
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
});

// docs/spec/verifier.md 2.3 for definition version 7: display-text version 2
// and spoiled-ballot opening version 3, as version 6; ballot version 4 under
// `electorate_mode` 1 and ballot version 5, which names its step, under 2;
// ballot version 5 beside contract-event version 8, 9 or 10, which name no
// relayed rolling ballot, fails, and beside 11 is unverifiable until the
// verifier's rolling checks (P2-17 parts 4c and 4d); and what the row says of version 6's author
// panel, results mode and tally-opening version holds under either mode
// (T-16, T-17, T-25, T-34, T-36, T-50, T-53). Ballot version 5 beside a
// definition before version 7 is still judged as a version 2.3 doesn't know
// until the verifier admits it (P2-17 part 4): unsupported, not yet failed.
describe("2.3's profile combination under version 7", () => {
  // Sealed, with no author panel and the profile version 6 fits with.
  const FITTING: Readonly<Record<number, number>> = {
    [RECORD_TYPES.electionDefinition]: 7,
    [RECORD_TYPES.ballot]: 4,
    [RECORD_TYPES.spoiledBallotOpening]: 3,
    [RECORD_TYPES.tallyOpening]: 1,
    [RECORD_TYPES.boardEntry]: 5,
    [RECORD_TYPES.contractEvent]: 8,
    [RECORD_TYPES.displayText]: 2,
  };
  const ROLLING = { ...FITTING, [RECORD_TYPES.ballot]: 5, [RECORD_TYPES.contractEvent]: 11 };
  const sealed = {
    results_mode: RESULTS_MODES.sealed,
    live_every: 0,
    live_batch: 0,
    author_threshold: 0,
    author_keys: [],
    author_transcript_hash: new Uint8Array(32),
  };
  const withPins = <D extends ElectionDefinitionV6>(
    d: D,
    pins: Readonly<Record<number, number | undefined>>,
  ): D => ({
    ...d,
    profile: {
      ...d.profile,
      pins: [
        ...d.profile.pins.filter((p) => !Object.hasOwn(pins, p.record_type)),
        ...Object.entries(pins)
          .filter((e): e is [string, number] => e[1] !== undefined)
          .map(([t, version]) => ({ record_type: Number(t), version })),
      ].sort((a, b) => a.record_type - b.record_type),
    },
  });
  const v7 = (
    mode: 1 | 2,
    pins: Readonly<Record<number, number | undefined>> = {},
    fields: Partial<ElectionDefinitionV7> = {},
  ): ElectionDefinitionV7 =>
    withPins(
      { ...(mode === 1 ? fixedTypical : rollingTypical), ...sealed, ...fields },
      { ...(mode === 1 ? FITTING : ROLLING), ...pins },
    );
  // The version-6 value with the same fields and pins, but for 0x0001's.
  const asV6 = (d: ElectionDefinitionV7): ElectionDefinitionV6 => {
    const { electorate_mode: _mode, rolling_electorate: _rolling, ...v6 } = d;
    return withPins(v6, { [RECORD_TYPES.electionDefinition]: 6 });
  };
  const live = { results_mode: RESULTS_MODES.live, live_every: 3600, live_batch: 20 };
  const livePins = { [RECORD_TYPES.tallyOpening]: 2, [RECORD_TYPES.boardEntry]: 6 };
  const authorPanel = {
    author_threshold: 1,
    // The rule reads only whether there is a panel, never its keys.
    author_keys: [new Uint8Array(33).fill(2)],
    author_transcript_hash: new Uint8Array(32).fill(7),
  };

  test("a fixed electorate fits with ballot version 4 and version 6's pins", () => {
    expect(profileCombinationRule(v7(1))).toBeUndefined();
    for (const events of [9, 10, 11])
      expect(profileCombinationRule(v7(1, { [RECORD_TYPES.contractEvent]: events }))).toBeUndefined();
    expect(profileCombinationRule(v7(1, livePins, live), fixedTypical.threshold)).toBeUndefined();
    // Ballot version 5 names a step, which a fixed electorate has none of.
    for (const events of [8, 9, 10, 11, 255])
      expect(
        profileCombinationRule(
          v7(1, { [RECORD_TYPES.ballot]: 5, [RECORD_TYPES.contractEvent]: events }),
        ),
      ).toBe("profile-combination");
  });

  test("a rolling electorate pins ballot version 5 beside contract-event version 11, unverifiable until the rolling checks are read", () => {
    expect(profileCombinationRule(v7(2))).toBe("unsupported-version");
    expect(profileCombinationRule(v7(2, livePins, live), rollingTypical.threshold)).toBe(
      "unsupported-version",
    );
    // A later version this package doesn't know may name the relayed
    // rolling ballot too: unsupported, never failed (T-36).
    expect(profileCombinationRule(v7(2, { [RECORD_TYPES.contractEvent]: 255 }))).toBe(
      "unsupported-version",
    );
    // Versions 8 and 9 archive no rolling ballot, and 10 none forced through L1.
    for (const events of [1, 7, 8, 9, 10])
      expect(profileCombinationRule(v7(2, { [RECORD_TYPES.contractEvent]: events }))).toBe(
        "profile-combination",
      );
    // Ballot version 4 carries no step, so a rolling poll's ballots couldn't
    // name the root their proofs used.
    for (const events of [8, 9, 11])
      expect(
        profileCombinationRule(
          v7(2, { [RECORD_TYPES.ballot]: 4, [RECORD_TYPES.contractEvent]: events }),
        ),
      ).toBe("profile-combination");
  });

  test("ballot version 5 beside version 6 is still a ballot version 2.3 doesn't know", () => {
    // As the verifier's 2.3 vectors, written before version 5 had a
    // layout, expect: the events rule and its cores' opening aren't read.
    for (const events of [8, 9, 10, 11]) {
      const d = withPins(asV6(v7(1)), {
        [RECORD_TYPES.ballot]: 5,
        [RECORD_TYPES.contractEvent]: events,
        [RECORD_TYPES.spoiledBallotOpening]: 2,
      });
      expect(profileCombinationRule(d)).toBe("unsupported-version");
    }
  });

  test("a ballot version this package doesn't know is unsupported under either mode", () => {
    for (const mode of [1, 2] as const)
      for (const events of [8, 9])
        expect(
          profileCombinationRule(
            v7(mode, { [RECORD_TYPES.ballot]: 6, [RECORD_TYPES.contractEvent]: events }),
          ),
        ).toBe("unsupported-version");
  });

  test("ballot version 5 needs opening version 3, display-text version 2 and a board carrying its delivery", () => {
    for (const spoiled of [1, 2, undefined])
      expect(profileCombinationRule(v7(2, { [RECORD_TYPES.spoiledBallotOpening]: spoiled }))).toBe(
        "profile-combination",
      );
    for (const displayText of [1, 3])
      expect(profileCombinationRule(v7(2, { [RECORD_TYPES.displayText]: displayText }))).toBe(
        "profile-combination",
      );
    for (const board of [1, 3, 7])
      expect(profileCombinationRule(v7(2, { [RECORD_TYPES.boardEntry]: board }))).toBe(
        "profile-combination",
      );
    // An opening version this package doesn't read may open version-5 cores.
    expect(profileCombinationRule(v7(2, { [RECORD_TYPES.spoiledBallotOpening]: 255 }))).toBe(
      "unsupported-version",
    );
  });

  test("an author panel fails under either mode, and a live poll needs k seats pinned as ours", () => {
    for (const mode of [1, 2] as const) {
      for (const fields of [authorPanel, { ...live, ...authorPanel }])
        for (const ours of [0, 255])
          expect(profileCombinationRule(v7(mode, livePins, fields), ours)).toBe(
            "profile-combination",
          );
      expect(profileCombinationRule(v7(mode, livePins, live))).toBe("profile-combination");
      // A live poll's pins on a sealed one, and a sealed poll's on a live one.
      expect(profileCombinationRule(v7(mode, livePins), 255)).toBe("profile-combination");
      expect(profileCombinationRule(v7(mode, {}, live), 255)).toBe("profile-combination");
    }
  });

  test("an electorate mode version 7 doesn't have fails, whatever it pins", () => {
    // Only an untyped caller can pass one: the decoder refuses it.
    for (const electorate_mode of [0, 3, 255])
      for (const ballot of [4, 5, 6])
        expect(
          profileCombinationRule(
            v7(1, { [RECORD_TYPES.ballot]: ballot }, { electorate_mode } as never),
          ),
        ).toBe("profile-combination");
  });

  test("the definition's pin and its fields agree, either way round", () => {
    // A version-7 value pinned 6 would be judged without its electorate mode,
    // and a version-6 value pinned 7 has none to be judged by.
    for (const mode of [1, 2] as const) {
      const d = v7(mode);
      expect(profileCombinationRule(withPins(d, { [RECORD_TYPES.electionDefinition]: 6 }))).toBe(
        "profile-combination",
      );
      expect(
        profileCombinationRule(withPins(asV6(d), { [RECORD_TYPES.electionDefinition]: 7 })),
      ).toBe("profile-combination");
    }
  });

  // Small version ranges around every boundary, so each rule is reached.
  const anyPins = fc.record({
    [RECORD_TYPES.ballot]: fc.integer({ min: 1, max: 6 }),
    [RECORD_TYPES.spoiledBallotOpening]: fc.option(fc.integer({ min: 1, max: 4 }), {
      nil: undefined,
    }),
    [RECORD_TYPES.tallyOpening]: fc.integer({ min: 1, max: 4 }),
    [RECORD_TYPES.boardEntry]: fc.integer({ min: 1, max: 8 }),
    [RECORD_TYPES.contractEvent]: fc.integer({ min: 1, max: 12 }),
    [RECORD_TYPES.displayText]: fc.integer({ min: 1, max: 3 }),
  });
  const anyFields = fc.record({
    results: fc.constantFrom(sealed, { ...sealed, ...live }),
    author: fc.boolean(),
    ours: fc.integer({ min: 0, max: 4 }),
  });
  const fieldsOf = (f: { results: object; author: boolean }) =>
    ({ ...f.results, ...(f.author && authorPanel) }) as Partial<ElectionDefinitionV7>;

  test("a fixed version 7 is judged as version 6 is, but fails ballot version 5", () => {
    fc.assert(
      fc.property(anyPins, anyFields, (pins, f) => {
        const d = v7(1, pins, fieldsOf(f));
        const unread = ![1, 3, 4, 5, 6, 7].includes(pins[RECORD_TYPES.boardEntry]);
        expect(profileCombinationRule(d, f.ours)).toBe(
          pins[RECORD_TYPES.ballot] === 5 && !unread
            ? "profile-combination"
            : profileCombinationRule(asV6(d), f.ours),
        );
      }),
      opts,
    );
  });

  test("a rolling version 7's ballot version 5 is judged as a fixed one's 4, fails beside contract-event versions 1 to 10 and is unverifiable where it fits", () => {
    fc.assert(
      fc.property(anyPins, anyFields, (pins, f) => {
        const ballot = pins[RECORD_TYPES.ballot];
        const events = pins[RECORD_TYPES.contractEvent];
        const rolling = profileCombinationRule(v7(2, pins, fieldsOf(f)), f.ours);
        const fixed = profileCombinationRule(
          v7(1, { ...pins, [RECORD_TYPES.ballot]: ballot === 5 ? 4 : ballot }, fieldsOf(f)),
          f.ours,
        );
        // Where the board-entry version is unread, nothing else is judged.
        const unread = ![1, 3, 4, 5, 6, 7].includes(pins[RECORD_TYPES.boardEntry]);
        if (unread) expect(rolling).toBe("unsupported-version");
        else if (ballot === 4) expect(rolling).toBe("profile-combination");
        else if (ballot === 5 && events <= 10) expect(rolling).toBe("profile-combination");
        // What fits waits on the verifier's rolling checks (P2-17 parts 4c
        // and 4d): unsupported, never passed (T-36).
        else if (ballot === 5 && fixed === undefined) expect(rolling).toBe("unsupported-version");
        else expect(rolling).toBe(fixed);
      }),
      opts,
    );
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
