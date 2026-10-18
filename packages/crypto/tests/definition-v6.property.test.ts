import { createHash } from "node:crypto";

import { p256 } from "@noble/curves/nist.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  authorPanelId,
  authorPanelRule,
  DecodeError,
  decodeElectionDefinitionV5,
  decodeElectionDefinitionV6,
  DEFINITION_V6_LIMITS,
  type ElectionDefinitionV6,
  electionAuthorStubV6Hash,
  electionDefinitionV6Rule,
  electionStubV6Hash,
  encodeElectionDefinitionV5,
  encodeElectionDefinitionV6,
  PARAMETERS,
  POLL_CLASSES,
  profileCombinationRule,
  RECORD_TYPES,
  RESULTS_MODES,
} from "../src/index.ts";
import { hex, readVectorFile } from "./spec-vectors.ts";

// Properties of election-definition version 6 (docs/spec/election-definition.md,
// Layout (version 6), Poll class and results, Author panel, Stub hash and the
// ceremony, Well-formedness) and the author panel identifier
// (docs/spec/trustee-identity.md): every value round-trips and every accepted
// encoding re-encodes to itself, version 6's bytes are version 5's with the
// new fields appended, the new rules accept exactly what the spec's rows
// accept and come after version 5's, and the stubs bind what each ceremony
// must (T-14, T-16, T-17, T-31, T-34, T-37).
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const opts = { numRuns };

const vector = (file: string, id: string) => {
  const v = readVectorFile(file).vectors.find((x) => x.id === id);
  if (v === undefined) throw new Error(`${id} is missing`);
  return v;
};

const typical = decodeElectionDefinitionV6(
  hex(vector("election-definition-v6.json", "definition-v6-typical").encoding),
);
const typicalV5 = decodeElectionDefinitionV5(
  hex(vector("election-definition-v5.json", "definition-v5-typical").encoding),
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

// A pool of identity keys, so lists repeat keys often and stay cheap to make.
const POOL = Array.from({ length: 20 }, (_, i) =>
  p256.Point.BASE.multiply(BigInt(i + 1) * 0x9e3779b97f4a7c15n).toBytes(true),
);
const key = fc.integer({ min: 0, max: POOL.length - 1 }).map((i) => POOL[i]!);
const zero32 = new Uint8Array(32);
const transcript = fc.oneof(fc.constant(zero32), fc.uint8Array({ minLength: 32, maxLength: 32 }));

type V6Fields = Pick<
  ElectionDefinitionV6,
  | "poll_class"
  | "results_mode"
  | "live_every"
  | "live_batch"
  | "author_threshold"
  | "author_keys"
  | "author_transcript_hash"
>;

// Small schedule, batch and threshold values hit every rule's boundary; the
// codec tests use the whole range.
const fields = (n: fc.Arbitrary<number>, threshold: fc.Arbitrary<number>): fc.Arbitrary<V6Fields> =>
  fc.record({
    poll_class: fc.constantFrom(1, 2, 3) as fc.Arbitrary<1 | 2 | 3>,
    results_mode: fc.constantFrom(1, 2) as fc.Arbitrary<1 | 2>,
    live_every: n,
    live_batch: n,
    author_threshold: threshold,
    author_keys: fc.array(key, { minLength: 0, maxLength: DEFINITION_V6_LIMITS.authorKeys }),
    author_transcript_hash: transcript,
  });
const anyFields = fields(fc.nat({ max: 0xffffffff }), fc.nat({ max: 0xff }));
const smallFields = fields(
  fc.oneof(fc.constantFrom(0, 1, 19, 20, 21), fc.nat({ max: 40 })),
  fc.nat({ max: 18 }),
);

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const isZero = (b: Uint8Array) => b.every((x) => x === 0);

/** The spec's `results`, `civic-sealed` and `author-panel` rows, read directly. */
function specRule(f: V6Fields) {
  const sealed = f.results_mode === 1;
  if (
    sealed
      ? f.live_every !== 0 || f.live_batch !== 0
      : f.live_every < 1 || f.live_batch < PARAMETERS.MIN_LIVE_BATCH
  )
    return "results";
  if (f.poll_class === 3 && !sealed) return "civic-sealed";
  const n = f.author_keys.length;
  const none = f.author_threshold === 0 && n === 0 && isZero(f.author_transcript_hash);
  const valid =
    n > 0 &&
    !isZero(f.author_transcript_hash) &&
    f.author_threshold >= 1 &&
    f.author_threshold <= n &&
    new Set(f.author_keys.map(toHex)).size === n;
  if (!none && !valid) return "author-panel";
  return undefined;
}

describe("definition version 6", () => {
  test("its limits and enums are the spec's", () => {
    expect(DEFINITION_V6_LIMITS.authorKeys).toBe(PARAMETERS.MAX_TRUSTEES);
    expect(DEFINITION_V6_LIMITS.minLiveBatch).toBe(PARAMETERS.MIN_LIVE_BATCH);
    expect(POLL_CLASSES).toEqual({ everyday: 1, organisational: 2, civicReferendum: 3 });
    expect(RESULTS_MODES).toEqual({ sealed: 1, live: 2 });
    expect(electionDefinitionV6Rule(typical)).toBeUndefined();
  });

  test(
    "every value of the new fields round-trips, and each encoding re-encodes to itself",
    { timeout: 120_000 },
    () => {
      fc.assert(
        fc.property(anyFields, (f) => {
          const d = { ...typical, ...f };
          const bytes = encodeElectionDefinitionV6(d);
          const decoded = decodeElectionDefinitionV6(bytes);
          expect(decoded).toEqual(d);
          expect(encodeElectionDefinitionV6(decoded)).toEqual(bytes);
        }),
        opts,
      );
    },
  );

  test(
    "version 6's bytes are version 5's after the header, followed by the new fields",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(anyFields, (f) => {
          const five = encodeElectionDefinitionV5(typicalV5);
          const six = encodeElectionDefinitionV6({ ...typicalV5, ...f });
          // The header is the record type (u16) and the version byte.
          expect(six[2]).toBe(6);
          expect(toHex(six.subarray(3, five.length))).toBe(toHex(five.subarray(3)));
          const tail = six.subarray(five.length);
          expect(tail[0]).toBe(f.poll_class);
          expect(tail[1]).toBe(f.results_mode);
          // A list count is a u32 (notation.md).
          expect(tail.length).toBe(1 + 1 + 4 + 4 + 1 + 4 + 33 * f.author_keys.length + 32);
          expect(toHex(tail.subarray(tail.length - 32))).toBe(toHex(f.author_transcript_hash));
        }),
        opts,
      );
    },
  );

  test(
    "every accepted single-byte change re-encodes to the changed bytes",
    { timeout: 60_000 },
    () => {
      const bytes = encodeElectionDefinitionV6(typical);
      fc.assert(
        fc.property(fc.nat({ max: bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), (i, x) => {
          const changed = new Uint8Array(bytes);
          changed[i]! ^= x;
          let decoded: ElectionDefinitionV6;
          try {
            decoded = decodeElectionDefinitionV6(changed);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            return;
          }
          expect(toHex(encodeElectionDefinitionV6(decoded))).toBe(toHex(changed));
        }),
        opts,
      );
    },
  );

  test("17 author keys don't encode, and a list count of 17 is length-over-max", () => {
    const keys = POOL.slice(0, 17);
    expect(() => encodeElectionDefinitionV6({ ...typical, author_keys: keys })).toThrow();
    const bytes = encodeElectionDefinitionV6({ ...typical, author_keys: keys.slice(0, 16) });
    // The u32 count sits before the keys and the 32-byte transcript hash.
    const at = bytes.length - 32 - 33 * 16 - 4;
    expect(toHex(bytes.subarray(at, at + 4))).toBe("00000010");
    const over = new Uint8Array(bytes);
    over[at + 3] = 17;
    let error: unknown;
    try {
      decodeElectionDefinitionV6(over);
    } catch (e) {
      error = e;
    }
    expect((error as DecodeError).code).toBe("length-over-max");
  });

  test("the new rules accept exactly what the spec's rows accept, in their order", () => {
    fc.assert(
      fc.property(smallFields, (f) => {
        const rule = specRule(f);
        expect(electionDefinitionV6Rule({ ...typical, ...f })).toEqual(
          rule === undefined ? undefined : { rule },
        );
      }),
      opts,
    );
  });

  test("version 5's rules come first", () => {
    fc.assert(
      fc.property(smallFields, (f) => {
        const d = { ...typical, ...f };
        expect(electionDefinitionV6Rule({ ...d, questions: [] })).toEqual({ rule: "questions" });
        expect(electionDefinitionV6Rule({ ...d, receipt_keys: [] })).toEqual({
          rule: "receipt-keys",
        });
      }),
      opts,
    );
  });

  test("the stubs bind what each ceremony must", { timeout: 120_000 }, () => {
    fc.assert(
      fc.property(smallFields, smallFields, (a, b) => {
        const da = { ...typical, ...a };
        const db = { ...typical, ...b };
        const stub = (d: ElectionDefinitionV6) =>
          specHash(
            "abolish/v1/election-stub",
            encodeElectionDefinitionV6({ ...d, ceremony_transcript_hash: zero32 }),
          );
        const authorStub = (d: ElectionDefinitionV6) =>
          stub({ ...d, author_transcript_hash: zero32 });
        expect(electionStubV6Hash(da)).toEqual(stub(da));
        expect(electionAuthorStubV6Hash(da)).toEqual(authorStub(da));
        // The two stubs are the same bytes exactly when there is no author
        // transcript, which `author-panel` allows only with no author panel.
        expect(toHex(electionStubV6Hash(da)) === toHex(electionAuthorStubV6Hash(da))).toBe(
          isZero(a.author_transcript_hash),
        );
        // Neither stub depends on the default transcript; the author stub
        // doesn't depend on the author transcript, and the default stub does.
        const other = { ...da, ceremony_transcript_hash: new Uint8Array(32).fill(1) };
        expect(electionStubV6Hash(other)).toEqual(electionStubV6Hash(da));
        const { author_transcript_hash: _a, ...restA } = a;
        const { author_transcript_hash: _b, ...restB } = b;
        if (JSON.stringify(restA) !== JSON.stringify(restB))
          expect(electionAuthorStubV6Hash(da)).not.toEqual(electionAuthorStubV6Hash(db));
        if (toHex(a.author_transcript_hash) !== toHex(b.author_transcript_hash))
          expect(electionStubV6Hash(da)).not.toEqual(
            electionStubV6Hash({ ...da, author_transcript_hash: b.author_transcript_hash }),
          );
      }),
      opts,
    );
  });
});

describe("author panels", () => {
  const panels = fc.record({
    threshold: fc.nat({ max: 18 }),
    keys: fc.array(key, { minLength: 0, maxLength: 18 }),
  });

  const validPanels = fc
    .uniqueArray(fc.integer({ min: 0, max: POOL.length - 1 }), {
      minLength: 1,
      maxLength: PARAMETERS.MAX_TRUSTEES,
    })
    .chain((ix) =>
      fc.record({
        threshold: fc.integer({ min: 1, max: ix.length }),
        keys: fc.constant(ix.map((i) => POOL[i]!)),
      }),
    );

  /** docs/spec/trustee-identity.md, Author panel identifier, rules 1 to 4 read directly. */
  function specPanelRule(
    p: { threshold: number; keys: readonly Uint8Array[] },
    defaults?: readonly Uint8Array[],
  ) {
    if (p.keys.length > PARAMETERS.MAX_TRUSTEES) return "size";
    if (p.threshold < 1 || p.threshold > p.keys.length) return "threshold";
    for (const [i, k] of p.keys.entries())
      if (p.keys.slice(0, i).some((x) => toHex(x) === toHex(k))) return "duplicate-key";
    if (defaults?.some((d) => p.keys.some((k) => toHex(k) === toHex(d)))) return "default-seat";
    return undefined;
  }

  test("the validity rules are the spec's, in its order", () => {
    fc.assert(
      fc.property(
        panels,
        fc.option(fc.array(key, { maxLength: 4 }), { nil: undefined }),
        (p, d) => {
          expect(authorPanelRule(p, d)).toBe(specPanelRule(p, d));
        },
      ),
      opts,
    );
  });

  test(
    "the identifier is the spec's formula, and binds the threshold and every seat",
    { timeout: 120_000 },
    () => {
      fc.assert(
        fc.property(validPanels, validPanels, (a, b) => {
          expect(authorPanelRule(a)).toBeUndefined();
          const input = Uint8Array.from([
            a.threshold,
            a.keys.length,
            ...a.keys.flatMap((k) => [...k]),
          ]);
          expect(authorPanelId(a)).toEqual(specHash("abolish/v1/author-panel", input));
          const same =
            a.threshold === b.threshold &&
            a.keys.length === b.keys.length &&
            a.keys.every((k, i) => toHex(k) === toHex(b.keys[i]!));
          expect(toHex(authorPanelId(a)) === toHex(authorPanelId(b))).toBe(same);
        }),
        opts,
      );
    },
  );

  test("a key in the wrong encoding is `key`", () => {
    const k = POOL[0]!;
    const bad = new Uint8Array(k);
    bad[0] = 0x04;
    expect(authorPanelRule({ threshold: 1, keys: [bad] })).toBe("key");
    expect(authorPanelRule({ threshold: 1, keys: [k.subarray(1)] })).toBe("key");
  });
});

// docs/spec/verifier.md 2.3 for definition version 6: display-text version
// 2, ballot version 4 and spoiled-ballot opening version 3, which opens its
// cores; a sealed poll without an author panel pins tally-opening version 1
// and board-entry version 5; a live poll pins tally-opening version 2 and
// board-entry version 6 and runs only under the live restriction (at least
// `k` default seats the caller's release pins as ours, T-16, T-45); an author
// panel fails until its transcript's channel is closed (T-17); and nothing
// else may pin their tally-opening versions (2, 3) or board-entry versions
// (6, 7).
describe("2.3's profile combination under version 6", () => {
  const minimal = decodeElectionDefinitionV6(
    hex(vector("election-definition-v6.json", "definition-v6-minimal").encoding),
  );
  const FITTING: Readonly<Record<number, number>> = {
    [RECORD_TYPES.electionDefinition]: 6,
    [RECORD_TYPES.ballot]: 4,
    [RECORD_TYPES.spoiledBallotOpening]: 3,
    [RECORD_TYPES.tallyOpening]: 1,
    [RECORD_TYPES.boardEntry]: 5,
    [RECORD_TYPES.contractEvent]: 8,
    [RECORD_TYPES.displayText]: 2,
  };
  const v6 = (
    pins: Readonly<Record<number, number | undefined>> = {},
    fields: Partial<ElectionDefinitionV6> = {},
  ): ElectionDefinitionV6 => {
    const wanted = { ...FITTING, ...pins };
    return {
      ...minimal,
      ...fields,
      profile: {
        ...minimal.profile,
        pins: [
          ...minimal.profile.pins.filter((p) => !Object.hasOwn(wanted, p.record_type)),
          ...Object.entries(wanted)
            .filter((e): e is [string, number] => e[1] !== undefined)
            .map(([t, version]) => ({ record_type: Number(t), version })),
        ].sort((a, b) => a.record_type - b.record_type),
      },
    };
  };
  const authorPanel = {
    author_threshold: 1,
    author_keys: [POOL[0]!],
    author_transcript_hash: new Uint8Array(32).fill(7),
  };

  test("a sealed poll without an author panel fits", () => {
    expect(electionDefinitionV6Rule(v6())).toBeUndefined();
    expect(profileCombinationRule(v6())).toBeUndefined();
    // Every poll class: the default panel's kind is 2.5's, not 2.3's.
    for (const poll_class of Object.values(POLL_CLASSES))
      expect(profileCombinationRule(v6({}, { poll_class }))).toBeUndefined();
  });

  const live = { results_mode: RESULTS_MODES.live, live_every: 3600, live_batch: 20 };
  const livePins = { [RECORD_TYPES.tallyOpening]: 2, [RECORD_TYPES.boardEntry]: 6 };

  test("an author panel fails whatever it pins, live or sealed, and however many seats are ours", () => {
    expect(electionDefinitionV6Rule(v6({}, authorPanel))).toBeUndefined();
    for (const fields of [authorPanel, { ...live, ...authorPanel }])
      for (const pins of [
        {},
        livePins,
        { [RECORD_TYPES.tallyOpening]: 3, [RECORD_TYPES.boardEntry]: 7 },
        // Before a board-entry version this package reads or not.
        { [RECORD_TYPES.contractEvent]: 255 },
      ])
        for (const ours of [0, minimal.threshold, 255])
          expect(profileCombinationRule(v6(pins, fields), ours)).toBe("profile-combination");
  });

  test("a live poll fits with its own pins under at least k seats pinned as ours", () => {
    expect(electionDefinitionV6Rule(v6(livePins, live))).toBeUndefined();
    for (const ours of [minimal.threshold, minimal.panel_size, 255])
      expect(profileCombinationRule(v6(livePins, live), ours)).toBeUndefined();
    // Every poll class: whether a live poll may be on the civic record is
    // 2.1's and 2.5's, not this rule's.
    for (const poll_class of Object.values(POLL_CLASSES))
      expect(
        profileCombinationRule(v6(livePins, { ...live, poll_class }), minimal.threshold),
      ).toBeUndefined();
  });

  test("a live poll fails under fewer than k seats pinned as ours, and by default", () => {
    expect(profileCombinationRule(v6(livePins, live))).toBe("profile-combination");
    for (let ours = 0; ours < minimal.threshold; ours++)
      expect(profileCombinationRule(v6(livePins, live), ours)).toBe("profile-combination");
    // A count that isn't a safe integer never passes, whatever an untyped caller gives.
    for (const ours of [Number.NaN, -1, minimal.threshold + 0.5, Infinity])
      expect(profileCombinationRule(v6(livePins, live), ours), String(ours)).toBe(
        "profile-combination",
      );
    // Before a version a later release may read: the restriction isn't one.
    expect(
      profileCombinationRule(v6({ ...livePins, [RECORD_TYPES.contractEvent]: 255 }, live), 0),
    ).toBe("profile-combination");
  });

  test("the live restriction is exactly k seats pinned as ours", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (threshold, ours) => {
          const d = v6(livePins, { ...live, threshold, panel_size: Math.max(threshold, 1) });
          expect(profileCombinationRule(d, ours)).toBe(
            ours >= threshold ? undefined : "profile-combination",
          );
        },
      ),
      opts,
    );
  });

  test("a live poll pins tally-opening version 2 and board-entry version 6, and nothing else", () => {
    const ours = minimal.threshold;
    for (const pins of [
      // A sealed poll's: no running opening, or no board for one.
      {},
      { [RECORD_TYPES.tallyOpening]: 2 },
      { [RECORD_TYPES.boardEntry]: 6 },
      // An author panel's.
      { [RECORD_TYPES.tallyOpening]: 3, [RECORD_TYPES.boardEntry]: 6 },
      { [RECORD_TYPES.tallyOpening]: 2, [RECORD_TYPES.boardEntry]: 7 },
      // No close statement, no delivery records or no destruction.
      ...[1, 3, 4].map((board) => ({ ...livePins, [RECORD_TYPES.boardEntry]: board })),
      // Contract-event versions 1 to 7 miss board or registry events.
      ...[1, 2, 3, 4, 5, 6, 7].map((events) => ({
        ...livePins,
        [RECORD_TYPES.contractEvent]: events,
      })),
      { ...livePins, [RECORD_TYPES.ballot]: 3 },
      { ...livePins, [RECORD_TYPES.spoiledBallotOpening]: 2 },
      { ...livePins, [RECORD_TYPES.displayText]: 1 },
    ])
      expect(profileCombinationRule(v6(pins, live), ours), JSON.stringify(pins)).toBe(
        "profile-combination",
      );
    // Versions a later release may read stay unsupported, as for a sealed poll (T-36).
    for (const pins of [
      { [RECORD_TYPES.ballot]: 255 },
      { [RECORD_TYPES.spoiledBallotOpening]: 255 },
      { [RECORD_TYPES.contractEvent]: 255 },
      { [RECORD_TYPES.boardEntry]: 8 },
    ])
      expect(
        profileCombinationRule(v6({ ...livePins, ...pins }, live), ours),
        JSON.stringify(pins),
      ).toBe("unsupported-version");
  });

  test("a sealed poll never pins a live poll's versions, however many seats are ours", () => {
    for (const pins of [
      livePins,
      { [RECORD_TYPES.tallyOpening]: 2 },
      { [RECORD_TYPES.boardEntry]: 6 },
    ])
      for (const ours of [0, minimal.threshold, 255])
        expect(profileCombinationRule(v6(pins), ours), JSON.stringify(pins)).toBe(
          "profile-combination",
        );
  });

  test("a board-entry version this package doesn't read is unsupported first", () => {
    expect(profileCombinationRule(v6({ [RECORD_TYPES.boardEntry]: 8 }))).toBe(
      "unsupported-version",
    );
  });

  test("a sealed poll without an author panel pins only its own versions", () => {
    const fails: Readonly<Record<number, number | undefined>>[] = [
      // Ballot versions 1 to 3 carry no author half; none pinned can't vote.
      { [RECORD_TYPES.ballot]: 1 },
      { [RECORD_TYPES.ballot]: 2 },
      { [RECORD_TYPES.ballot]: 3 },
      { [RECORD_TYPES.ballot]: undefined },
      // Opening versions 1 and 2 don't open version-4 cores.
      { [RECORD_TYPES.spoiledBallotOpening]: 1 },
      { [RECORD_TYPES.spoiledBallotOpening]: 2 },
      { [RECORD_TYPES.spoiledBallotOpening]: undefined },
      // A live poll's and an author panel's tally-opening and board versions.
      { [RECORD_TYPES.tallyOpening]: 2 },
      { [RECORD_TYPES.tallyOpening]: 3 },
      { [RECORD_TYPES.tallyOpening]: undefined },
      { [RECORD_TYPES.boardEntry]: 6 },
      { [RECORD_TYPES.boardEntry]: 7 },
      // No close statement, no delivery records or no destruction.
      { [RECORD_TYPES.boardEntry]: 1 },
      { [RECORD_TYPES.boardEntry]: 3 },
      { [RECORD_TYPES.boardEntry]: 4 },
      // Display-text version 1 has no questions; an unknown one fails too.
      { [RECORD_TYPES.displayText]: 1 },
      { [RECORD_TYPES.displayText]: 3 },
      { [RECORD_TYPES.displayText]: undefined },
      // Contract-event versions 1 to 7 miss board or registry events.
      ...[1, 2, 3, 4, 5, 6, 7].map((events) => ({ [RECORD_TYPES.contractEvent]: events })),
      // A failure is reported beside a version this package doesn't read.
      { [RECORD_TYPES.boardEntry]: 1, [RECORD_TYPES.spoiledBallotOpening]: 255 },
      { [RECORD_TYPES.ballot]: 3, [RECORD_TYPES.contractEvent]: 255 },
    ];
    for (const pins of fails)
      expect(profileCombinationRule(v6(pins)), JSON.stringify(pins)).toBe("profile-combination");
  });

  test("versions a later release may read are unsupported, never failed", () => {
    // A later release may define a ballot carrying both halves, an opening
    // of version-4 cores or a contract-event version naming every event (T-36).
    for (const pins of [
      { [RECORD_TYPES.ballot]: 255 },
      { [RECORD_TYPES.spoiledBallotOpening]: 255 },
      { [RECORD_TYPES.contractEvent]: 255 },
    ])
      expect(profileCombinationRule(v6(pins)), JSON.stringify(pins)).toBe("unsupported-version");
  });

  test("ballot version 4 fails under every other definition version", () => {
    for (const definition of [1, 3, 4, 5])
      for (const pins of [
        { [RECORD_TYPES.electionDefinition]: definition },
        { [RECORD_TYPES.electionDefinition]: definition, [RECORD_TYPES.ballot]: 4 },
      ])
        expect(profileCombinationRule({ ...typicalV5, profile: v6(pins).profile })).toBe(
          "profile-combination",
        );
  });

  test("a version-6 pin on a value without version 6's fields fails, and the reverse", () => {
    expect(profileCombinationRule({ ...typicalV5, profile: v6().profile })).toBe(
      "profile-combination",
    );
    // A live version-6 value pinned as version 5 is never judged by version
    // 5's rules, which would skip its results mode, however many seats are ours.
    for (const definition of [1, 3, 4, 5])
      expect(
        profileCombinationRule(
          v6({ [RECORD_TYPES.electionDefinition]: definition, [RECORD_TYPES.ballot]: 3 }, live),
          255,
        ),
      ).toBe("profile-combination");
    expect(
      profileCombinationRule(
        v6(
          {
            [RECORD_TYPES.electionDefinition]: 5,
            [RECORD_TYPES.ballot]: 3,
            [RECORD_TYPES.spoiledBallotOpening]: 2,
          },
          { results_mode: RESULTS_MODES.sealed },
        ),
      ),
    ).toBe("profile-combination");
  });
});
