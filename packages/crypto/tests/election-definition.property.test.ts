import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BN254_R,
  DecodeError,
  decodeDisplayText,
  decodeElectionDefinition,
  type DisplayText,
  displayTextCommitment,
  displayTextRule,
  type ElectionDefinition,
  electionDefinitionHash,
  electionDefinitionRule,
  electionStubHash,
  encodeDisplayText,
  encodeElectionDefinition,
  newDisplayTextSalt,
  PARAMETERS,
  UnsupportedVersionError,
  DEFINITION_V1_LIMITS,
  pinnedVersion,
  profileCombinationRule,
  RECORD_TYPES,
} from "../src/index.ts";

// Properties of the election definition and display-text records
// (docs/spec/election-definition.md, docs/spec/display-text.md): every value
// round-trips, every accepted byte string re-encodes to itself, a flipped byte
// is rejected or yields a different, re-encodable definition, and each
// well-formedness rule rejects what it should (T-31, T-34, T-52).
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const opts = { numRuns };

const bytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n });
const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
const allPins = Array.from({ length: 9 }, (_, i) => ({ record_type: i + 1, version: 1 }));

/** Definitions that decode, well formed or not. */
const anyDefinition: fc.Arbitrary<ElectionDefinition> = fc.record({
  profile: fc.record({
    protocol_major: fc.integer({ min: 0, max: 255 }),
    pins: fc.array(
      fc.record({
        record_type: fc.integer({ min: 0, max: 0xffff }),
        version: fc.integer({ min: 0, max: 255 }),
      }),
      { maxLength: 64 },
    ),
  }),
  election_id: bytes(32),
  l2_chain_id: u64,
  l1_chain_id: u64,
  election_registry: bytes(20),
  board: bytes(20),
  trustee_registry: bytes(20),
  group_registry: bytes(20),
  l1_anchor: bytes(20),
  l1_relay: bytes(20),
  election_type: fc.constantFrom(1 as const, 2 as const),
  tally_scheme: fc.constant(1 as const),
  option_count: fc.integer({ min: 0, max: 0xffff }),
  min_selections: fc.integer({ min: 0, max: 0xffff }),
  max_selections: fc.integer({ min: 0, max: 0xffff }),
  electorate: fc.array(
    fc.record({
      tier: fc.constantFrom(0 as const, 1 as const, 2 as const),
      group_id: u64,
      root: fc.bigInt({ min: 0n, max: BN254_R - 1n }),
      root_l2_block: u64,
      group_size: u64,
    }),
    { maxLength: 3 },
  ),
  membership_vk_hash: bytes(32),
  panel_id: bytes(32),
  threshold: fc.integer({ min: 0, max: 255 }),
  panel_size: fc.integer({ min: 0, max: 255 }),
  ceremony_transcript_hash: bytes(32),
  opens_at: u64,
  closes_at: u64,
  l1_inclusion_bound: fc.integer({ min: 0, max: 0xffff_ffff }),
  sequencing_window: u64,
  max_sequencer_drift: u64,
  display_text_commitment: bytes(32),
});

/** Definitions that decode under their own profile's pin. */
const selfPinned = anyDefinition.map((d) => ({
  ...d,
  profile: {
    ...d.profile,
    pins: [
      { record_type: 1, version: 1 },
      ...d.profile.pins.filter((p) => p.record_type !== 1).slice(0, 63),
    ],
  },
}));

const sampleDefinition: ElectionDefinition = {
  profile: { protocol_major: 1, pins: allPins },
  election_id: new Uint8Array(32).fill(7),
  l2_chain_id: 84532n,
  l1_chain_id: 11155111n,
  election_registry: new Uint8Array(20).fill(1),
  board: new Uint8Array(20).fill(2),
  trustee_registry: new Uint8Array(20).fill(3),
  group_registry: new Uint8Array(20).fill(4),
  l1_anchor: new Uint8Array(20).fill(5),
  l1_relay: new Uint8Array(20).fill(6),
  election_type: 2,
  tally_scheme: 1,
  option_count: 4,
  min_selections: 1,
  max_selections: 2,
  electorate: [
    { tier: 0, group_id: 1n, root: 5n, root_l2_block: 10n, group_size: 100n },
    { tier: 1, group_id: 2n, root: 6n, root_l2_block: 10n, group_size: 50n },
  ],
  membership_vk_hash: new Uint8Array(32).fill(8),
  panel_id: new Uint8Array(32).fill(9),
  threshold: 4,
  panel_size: 7,
  ceremony_transcript_hash: new Uint8Array(32).fill(10),
  opens_at: 100n,
  closes_at: 200n,
  l1_inclusion_bound: 3600,
  sequencing_window: 3600n,
  max_sequencer_drift: 1800n,
  display_text_commitment: new Uint8Array(32).fill(11),
};

function rejects(f: () => unknown): boolean {
  try {
    f();
    return false;
  } catch (e) {
    if (e instanceof DecodeError) return true;
    throw e;
  }
}

describe("election definition codec", () => {
  test("every self-pinned definition round-trips", () => {
    fc.assert(
      fc.property(selfPinned, (d) => {
        const b = encodeElectionDefinition(d);
        expect(decodeElectionDefinition(b)).toEqual(d);
        expect(encodeElectionDefinition(decodeElectionDefinition(b))).toEqual(b);
      }),
      opts,
    );
  });

  test("a definition not pinned at its own version is profile-mismatch", () => {
    fc.assert(
      // Some definitions pin 0x0001 once, some twice, some not at all.
      fc.property(anyDefinition, fc.nat({ max: 2 }), (base, copies) => {
        const others = base.profile.pins.filter((p) => p.record_type !== 1).slice(0, 62);
        const own = Array.from({ length: copies }, (_, i) => ({ record_type: 1, version: i + 1 }));
        const d = { ...base, profile: { ...base.profile, pins: [...own, ...others] } };
        // The spec's oracle: exactly one pin for 0x0001, at the record's version 1.
        const ownPins = d.profile.pins.filter((p) => p.record_type === 1);
        const pinned = ownPins.length === 1 && ownPins[0]?.version === 1;
        const b = encodeElectionDefinition(d);
        if (pinned) expect(decodeElectionDefinition(b)).toEqual(d);
        else expect(() => decodeElectionDefinition(b)).toThrow("profile-mismatch");
      }),
      opts,
    );
  });

  test("a flipped byte is rejected or decodes to a definition that re-encodes to it", () => {
    fc.assert(
      fc.property(selfPinned, fc.nat(), fc.integer({ min: 1, max: 255 }), (d, at, x) => {
        const b = encodeElectionDefinition(d);
        const i = at % b.length;
        const m = b.slice();
        m[i] = (m[i] as number) ^ x;
        if (rejects(() => decodeElectionDefinition(m))) return;
        const decoded = decodeElectionDefinition(m);
        expect(encodeElectionDefinition(decoded)).toEqual(m);
        expect(electionDefinitionHash(decoded)).not.toEqual(electionDefinitionHash(d));
      }),
      opts,
    );
  });

  test("random bytes are rejected or re-encode to themselves", () => {
    const header = fc.constantFrom(Uint8Array.of(0, 1, 1), Uint8Array.of(0, 1, 2));
    fc.assert(
      fc.property(header, fc.uint8Array({ maxLength: 512 }), (h, body) => {
        const b = Uint8Array.from([...h, ...body]);
        if (rejects(() => decodeElectionDefinition(b))) return;
        expect(encodeElectionDefinition(decodeElectionDefinition(b))).toEqual(b);
      }),
      opts,
    );
  });

  test("the hash covers every field: any change to a definition changes it", () => {
    fc.assert(
      fc.property(selfPinned, selfPinned, (a, b) => {
        const same = Buffer.compare(encodeElectionDefinition(a), encodeElectionDefinition(b)) === 0;
        expect(Buffer.compare(electionDefinitionHash(a), electionDefinitionHash(b)) === 0).toBe(
          same,
        );
      }),
      opts,
    );
  });
});

describe("stub hash", () => {
  test("ignores the ceremony transcript hash and binds every other field", () => {
    fc.assert(
      fc.property(selfPinned, bytes(32), selfPinned, (d, h, other) => {
        expect(electionStubHash({ ...d, ceremony_transcript_hash: h })).toEqual(
          electionStubHash(d),
        );
        // A definition differing in anything but the ceremony hash has another stub.
        const zero = (x: ElectionDefinition) =>
          encodeElectionDefinition({ ...x, ceremony_transcript_hash: new Uint8Array(32) });
        const same = Buffer.compare(zero(d), zero(other)) === 0;
        expect(Buffer.compare(electionStubHash(d), electionStubHash(other)) === 0).toBe(same);
        expect(electionStubHash(d)).not.toEqual(electionDefinitionHash(d));
      }),
      opts,
    );
  });
});

describe("election definition well-formedness", () => {
  test("the sample is well formed", () => {
    expect(electionDefinitionRule(sampleDefinition)).toBeUndefined();
  });

  // Each mutation breaks exactly one rule; removing that rule's check would
  // let it through, which the vectors also pin (crypto-review: negative tests).
  const cases: [string, Partial<ElectionDefinition>][] = [
    ["protocol-major", { profile: { protocol_major: 0, pins: allPins } }],
    ["profile-order", { profile: { protocol_major: 1, pins: allPins.toReversed() } }],
    ["profile-types", { profile: { protocol_major: 1, pins: allPins.slice(0, 8) } }],
    [
      "profile-version",
      {
        profile: {
          protocol_major: 1,
          pins: allPins.map((p) => (p.record_type === 9 ? { ...p, version: 0 } : p)),
        },
      },
    ],
    ["option-count", { option_count: PARAMETERS.MAX_OPTIONS + 1, max_selections: 2 }],
    ["selections", { election_type: 1 }],
    ["selections", { min_selections: 3 }],
    ["selections", { election_type: 1, min_selections: 1, max_selections: 1 }],
    ["electorate", { electorate: [] }],
    [
      "electorate",
      {
        electorate: [
          { tier: 1, group_id: 1n, root: 5n, root_l2_block: 10n, group_size: 100n },
          { tier: 1, group_id: 2n, root: 6n, root_l2_block: 10n, group_size: 50n },
        ],
      },
    ],
    ["panel", { threshold: 8 }],
    ["panel", { threshold: 1 }],
    [
      "electorate",
      {
        electorate: [
          { tier: 0, group_id: 1n, root: 5n, root_l2_block: 10n, group_size: 100n },
          { tier: 1, group_id: 2n, root: 5n, root_l2_block: 10n, group_size: 50n },
        ],
      },
    ],
    ["panel", { threshold: 2, panel_size: PARAMETERS.MAX_TRUSTEES + 1 }],
    ["chain", { l1_chain_id: 84532n }],
    ["chain", { l1_relay: new Uint8Array(20).fill(5) }],
    ["chain", { group_registry: new Uint8Array(20) }],
    ["timing", { closes_at: 100n }],
  ];
  test.each(cases)("%s rejects its mutation", (rule, change) => {
    expect(electionDefinitionRule({ ...sampleDefinition, ...change })).toBe(rule);
  });

  test("L1 and L2 contracts may share an address; contracts on one chain may not", () => {
    const d = { ...sampleDefinition, l1_anchor: sampleDefinition.board };
    expect(electionDefinitionRule(d)).toBeUndefined();
  });
});

describe("display text", () => {
  const text = (labels: string[], language = "en"): DisplayText => ({
    salt: new Uint8Array(32).fill(3),
    translations: [
      {
        language: new TextEncoder().encode(language),
        question: new TextEncoder().encode("Which?"),
        description: new Uint8Array(),
        options: labels.map((l) => ({
          label: new TextEncoder().encode(l),
          description: new Uint8Array(),
        })),
      },
    ],
  });

  test("a client accepts only text matching the definition's commitment and shape", () => {
    const t = text(["a", "b", "c", "d"]);
    const d = { ...sampleDefinition, display_text_commitment: displayTextCommitment(t) };
    expect(displayTextRule(t, d)).toBeUndefined();
    expect(decodeDisplayText(encodeDisplayText(t), d)).toEqual(t);
    // Relabelling one option changes the commitment (T-34, T-41).
    expect(displayTextRule(text(["a", "b", "d", "c"]), d)).toBe("commitment");
    const three = text(["a", "b", "c"]);
    expect(
      displayTextRule(three, { ...d, display_text_commitment: displayTextCommitment(three) }),
    ).toBe("option-count");
  });

  test("repeated labels and uppercase tags are rejected", () => {
    const check = (t: DisplayText) =>
      displayTextRule(t, {
        ...sampleDefinition,
        display_text_commitment: displayTextCommitment(t),
      });
    expect(check(text(["a", "a", "b", "c"]))).toBe("labels");
    expect(check(text(["a", "b", "c", "d"], "EN"))).toBe("language-tag");
  });

  test("a type pinned twice has no pinned version, whatever the order", () => {
    const twice = (a: number, b: number) => ({
      ...sampleDefinition,
      profile: {
        protocol_major: 1,
        pins: [...allPins, { record_type: 9, version: a }, { record_type: 9, version: b }].filter(
          (p, i) => p.record_type !== 9 || i >= 9,
        ),
      },
    });
    expect(pinnedVersion(twice(1, 2), 9)).toBeUndefined();
    expect(pinnedVersion(twice(2, 1), 9)).toBeUndefined();
    expect(pinnedVersion(sampleDefinition, 9)).toBe(1);
  });

  test("decodes only against a definition that pins version 1", () => {
    const t = text(["a", "b"]);
    const unpinned = {
      ...sampleDefinition,
      profile: { protocol_major: 1, pins: allPins.slice(0, 8) },
    };
    expect(() => decodeDisplayText(encodeDisplayText(t), unpinned)).toThrow(
      UnsupportedVersionError,
    );
  });

  test("text round-trips and random bodies are rejected or re-encode", () => {
    const utf8 = (max: number) =>
      fc
        .string({ unit: "binary", maxLength: Math.floor(max / 4) })
        .map((s) => new TextEncoder().encode(s));
    const arb: fc.Arbitrary<DisplayText> = fc.record({
      salt: bytes(32),
      translations: fc.array(
        fc.record({
          language: utf8(35),
          question: utf8(1024),
          description: utf8(64),
          options: fc.array(fc.record({ label: utf8(64), description: utf8(64) }), {
            maxLength: 8,
          }),
        }),
        { maxLength: 4 },
      ),
    });
    const d = sampleDefinition;
    fc.assert(
      fc.property(arb, fc.uint8Array({ maxLength: 256 }), (t, body) => {
        expect(decodeDisplayText(encodeDisplayText(t), d)).toEqual(t);
        const b = Uint8Array.from([0, 9, 1, ...body]);
        if (rejects(() => decodeDisplayText(b, d))) return;
        expect(encodeDisplayText(decodeDisplayText(b, d))).toEqual(b);
      }),
      opts,
    );
  });
});

describe("self-pin", () => {
  test("the entry point exposes no generic decode path for a definition", async () => {
    // A generic decode would skip decodeElectionDefinition's self-pin check.
    const api: Record<string, unknown> = await import("../src/index.ts");
    expect(api).not.toHaveProperty("PROTOCOL_SCHEMA");
    expect(api).not.toHaveProperty("ELECTION_DEFINITION");
  });
});

describe("randomness and parameters", () => {
  test("salts are fresh 32-byte CSPRNG outputs", () => {
    expect(newDisplayTextSalt()).toHaveLength(PARAMETERS.DISPLAY_TEXT_SALT_LEN);
    expect(newDisplayTextSalt()).not.toEqual(newDisplayTextSalt());
  });

  test("PARAMETERS matches docs/spec/parameters.md", () => {
    const md = readFileSync(new URL("../../../docs/spec/parameters.md", import.meta.url), "utf8");
    const rows = [...md.matchAll(/^\| `([A-Z_]+)` +\| ([\d,]+) +\|/gm)].map((m) => [
      m[1],
      Number(m[2]!.replaceAll(",", "")),
    ]);
    expect(Object.entries(PARAMETERS)).toEqual(rows);
    expect(Object.isFrozen(PARAMETERS)).toBe(true);
    // Version 1's limits are literals; today they equal the protocol-wide ones.
    expect(DEFINITION_V1_LIMITS).toEqual({
      maxOptions: PARAMETERS.MAX_OPTIONS,
      maxTrustees: PARAMETERS.MAX_TRUSTEES,
    });
  });
});

describe("record types other than the definition", () => {
  // Specified types are unexpected where a definition is read; reserved and
  // unassigned ones are unknown. The contract's decoder reports the same
  // codes (packages/contracts, docs/spec/contracts.md, Registration; T-36).
  const vectors = JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/election-definition.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: { id: string; encoding: string }[] };
  const typical = vectors.vectors.find((v) => v.id === "definition-typical");
  if (typical === undefined) throw new Error("definition-typical vector missing");

  test.each([
    [0x0007, "unexpected-record-type"],
    [0x0009, "unexpected-record-type"],
    [0x0002, "unknown-record-type"],
  ] as const)("type %i is %s", (type, code) => {
    const b = Uint8Array.from(Buffer.from(typical.encoding, "hex"));
    b[0] = type >> 8;
    b[1] = type & 0xff;
    let caught: unknown;
    try {
      decodeElectionDefinition(b);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DecodeError);
    expect((caught as DecodeError).code).toBe(code);
  });
});

describe("2.3's profile combination", () => {
  const pinning = (board: number, ballot: number, opening: number): ElectionDefinition => ({
    ...sampleDefinition,
    profile: {
      ...sampleDefinition.profile,
      pins: sampleDefinition.profile.pins.map((p) => ({
        ...p,
        version:
          p.record_type === RECORD_TYPES.boardEntry
            ? board
            : p.record_type === RECORD_TYPES.ballot
              ? ballot
              : p.record_type === RECORD_TYPES.tallyOpening
                ? opening
                : p.version,
      })),
    },
  });

  // From docs/spec/verifier.md 2.3: ballot version 1 needs board-entry 3 or
  // 4, tally-opening version 1 needs 4, and a board-entry version this
  // package doesn't read is unsupported, never a failure (T-36).
  const expected = (board: number, ballot: number, opening: number) => {
    if (![1, 3, 4].includes(board)) return "unsupported-version";
    const carriesDelivery = board === 3 || board === 4;
    const carriesDestruction = board === 4;
    const fits = (ballot !== 1 || carriesDelivery) && (opening !== 1 || carriesDestruction);
    return fits ? undefined : "profile-combination";
  };

  test("board-entry versions 1 to 6 against ballot and tally-opening versions 1 to 3", () => {
    for (let board = 1; board <= 6; board++)
      for (let ballot = 1; ballot <= 3; ballot++)
        for (let opening = 1; opening <= 3; opening++)
          expect(profileCombinationRule(pinning(board, ballot, opening))).toBe(
            expected(board, ballot, opening),
          );
  });

  test("the typical profile, all at version 1, fails; with board-entry version 4 it fits", () => {
    expect(electionDefinitionRule(sampleDefinition)).toBeUndefined();
    expect(profileCombinationRule(pinning(1, 1, 1))).toBe("profile-combination");
    expect(profileCombinationRule(pinning(4, 1, 1))).toBeUndefined();
  });

  test("definition version 3 refuses every ballot version until one names its cell", () => {
    // The rule reads only the profile, so version 1's value with 0x0001
    // pinned at 3 stands in for a version-3 definition.
    const v3 = (ballot: number) => {
      const d = pinning(4, ballot, 1);
      return {
        ...d,
        profile: {
          ...d.profile,
          pins: d.profile.pins.map((p) =>
            p.record_type === RECORD_TYPES.electionDefinition ? { ...p, version: 3 } : p,
          ),
        },
      };
    };
    expect(profileCombinationRule(v3(1))).toBe("profile-combination");
    expect(profileCombinationRule(v3(2))).toBe("profile-combination");
    expect(profileCombinationRule(pinning(4, 1, 1))).toBeUndefined();
  });

  test("definition version 4 keeps version 3's regional cells, so it refuses them too", () => {
    const v4 = (ballot: number) => {
      const d = pinning(4, ballot, 1);
      return {
        ...d,
        profile: {
          ...d.profile,
          pins: d.profile.pins.map((p) =>
            p.record_type === RECORD_TYPES.electionDefinition ? { ...p, version: 4 } : p,
          ),
        },
      };
    };
    expect(profileCombinationRule(v4(1))).toBe("profile-combination");
    expect(profileCombinationRule(v4(2))).toBe("profile-combination");
  });

  test("a definition pinning no board-entry version is unsupported, never a failure", () => {
    const none = {
      ...sampleDefinition,
      profile: {
        ...sampleDefinition.profile,
        pins: sampleDefinition.profile.pins.filter(
          (p) => p.record_type !== RECORD_TYPES.boardEntry,
        ),
      },
    };
    expect(profileCombinationRule(none)).toBe("unsupported-version");
  });

  test("a ballot or tally-opening type pinned twice or not at all is refused, never a fit", () => {
    // electionDefinitionRule refuses these too; a caller that skipped it
    // must still refuse to cast (T-34).
    for (const type of [RECORD_TYPES.ballot, RECORD_TYPES.tallyOpening]) {
      const fitting = pinning(4, 2, 2);
      const without = {
        ...fitting,
        profile: {
          ...fitting.profile,
          pins: fitting.profile.pins.filter((p) => p.record_type !== type),
        },
      };
      const twice = {
        ...fitting,
        profile: {
          ...fitting.profile,
          pins: [...fitting.profile.pins, { record_type: type, version: 2 }],
        },
      };
      expect(profileCombinationRule(fitting)).toBeUndefined();
      expect(electionDefinitionRule(without)).toBeDefined();
      expect(profileCombinationRule(without)).toBe("profile-combination");
      expect(electionDefinitionRule(twice)).toBeDefined();
      expect(profileCombinationRule(twice)).toBe("profile-combination");
    }
  });
});
