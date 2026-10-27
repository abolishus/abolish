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
import { SPOILED_BALLOT_OPENING } from "../src/challenge.ts";
import { BALLOT } from "../src/ballot.ts";
import {
  BALLOT_VERSIONS,
  CONTRACT_EVENT_VERSIONS,
  SPOILED_OPENING_VERSIONS,
} from "../src/protocol.ts";
import { CONTRACT_EVENT } from "../src/contract-event.ts";

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
    // A vouch's root window spans whole intervals of the root grid
    // (docs/spec/vouching.md, The root a vouch names).
    expect(PARAMETERS.VOUCH_ROOT_WINDOW % PARAMETERS.VOUCH_ROOT_INTERVAL).toBe(0);
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
  // Contract-event version 8 unless `events` says otherwise: every board and
  // registry event, which every profile needs ([[close]], Version).
  const pinning = (
    board: number,
    ballot: number,
    opening: number,
    events = 8,
  ): ElectionDefinition => ({
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
                : p.record_type === RECORD_TYPES.contractEvent
                  ? events
                  : p.version,
      })),
    },
  });

  // From docs/spec/verifier.md 2.3: ballot versions 1 to 3 need board-entry
  // 3, 4 or 5, tally-opening version 1 needs 4 or 5, ballot version 2 needs
  // definition version 3 or 4 and ballot version 3 definition version 5
  // (these are version 1, which pins ballot version 1 with opening version 1),
  // every profile needs board-entry version 5 (the close statement) and
  // contract-event version 8 to 11 (the close rule's, the batches', the
  // root's and the availability records' events, and the group registry's
  // Tier 1 and self-paid additions), a board-entry version this package
  // doesn't read is unsupported, never a failure, and so is a
  // contract-event version it doesn't read where nothing else fails (T-36).
  const expected = (board: number, ballot: number, opening: number, events: number) => {
    // Board-entry version 6 carries running openings, so only a live
    // definition (version 6 or 7) may pin it, never these (tally.md,
    // Tally-opening version 2).
    if (board === 6) return "profile-combination";
    // Board-entry version 7 is only for a definition with an author panel.
    if (board === 7) return "profile-combination";
    if (![1, 3, 4, 5].includes(board)) return "unsupported-version";
    // Tally-opening version 2 needs board-entry version 6 (a live poll's) and
    // version 3 needs version 7 (an author panel's), neither of which these
    // definitions may pin.
    if (opening === 2 || opening === 3) return "profile-combination";
    if (ballot !== 1) return "profile-combination";
    const carriesDelivery = board === 3 || board === 4 || board === 5;
    const carriesDestruction = board === 4 || board === 5;
    const carriesClose = board === 5;
    const fits =
      (ballot !== 1 || carriesDelivery) &&
      (opening !== 1 || carriesDestruction) &&
      carriesClose &&
      events !== 1 &&
      events !== 2 &&
      events !== 3 &&
      events !== 4 &&
      events !== 5 &&
      events !== 6 &&
      events !== 7;
    if (!fits) return "profile-combination";
    return events >= 8 && events <= 11 ? undefined : "unsupported-version";
  };

  test("board-entry versions 1 to 8 against ballot, tally-opening and contract-event versions", () => {
    for (let board = 1; board <= 8; board++)
      for (let ballot = 1; ballot <= 3; ballot++)
        for (let opening = 1; opening <= 3; opening++)
          for (const events of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 255])
            expect(profileCombinationRule(pinning(board, ballot, opening, events))).toBe(
              expected(board, ballot, opening, events),
            );
  });

  test("the typical profile, all at version 1, fails; with board-entry version 5 and contract-event version 8 it fits", () => {
    expect(electionDefinitionRule(sampleDefinition)).toBeUndefined();
    expect(profileCombinationRule(pinning(1, 1, 1, 1))).toBe("profile-combination");
    expect(profileCombinationRule(pinning(5, 1, 1))).toBeUndefined();
  });

  test("every profile needs the close statement and every board and registry event", () => {
    // Board-entry versions 3 and 4 carry delivery and destruction but not the
    // close statement; contract-event versions 1 and 2 name none of the close
    // rule's board events, version 3 not the batches', version 4 not the
    // obligation root's, version 5 not the group registry's Tier 1 addition,
    // version 6 not its self-paid group and addition and version 7 not the
    // board's availability records ([[close]], Version; [[contracts]], Event
    // tables (version 8); T-35, T-50, T-25, T-53, T-24).
    for (const board of [1, 3, 4])
      expect(profileCombinationRule(pinning(board, 1, 2))).toBe("profile-combination");
    for (const events of [1, 2, 3, 4, 5, 6, 7])
      expect(profileCombinationRule(pinning(5, 1, 1, events))).toBe("profile-combination");
    // A contract-event version this package doesn't read may be a later
    // release's that names those events: unsupported, never a failure, unless
    // the profile fails on another ground (T-36).
    expect(profileCombinationRule(pinning(5, 1, 1, 12))).toBe("unsupported-version");
    expect(profileCombinationRule(pinning(4, 1, 1, 12))).toBe("profile-combination");
    expect(profileCombinationRule(pinning(5, 2, 1, 12))).toBe("profile-combination");
    // Each of versions 9 to 11 reads every record the one before passes as it
    // does, so each fits wherever version 8 does ([[contracts]], Event tables
    // (versions 9 to 11)).
    for (const events of [9, 10, 11]) {
      expect(profileCombinationRule(pinning(5, 1, 1, events))).toBeUndefined();
      expect(profileCombinationRule(pinning(4, 1, 1, events))).toBe("profile-combination");
    }
  });

  // The verifier reads version 9 whole since P2-16 part 5d-3b, and versions
  // 10 and 11 since P2-17 part 4b-1, so 2.3 judges a profile pinning any of
  // them ([[contracts]], Contract-event record, Event tables (versions 9 to
  // 11); T-36, T-37). Version 12 is read by the event check since P2-16
  // part 5e-3, but 2.3 leaves it unverifiable until the verifier reads it
  // (part 5e-4), so a profile pinning it is never passed early.
  test("the contract-event versions 2.3 knows are the ones its codec reads, but version 12", () => {
    const ascending = (a: number, b: number) => a - b;
    expect([...CONTRACT_EVENT_VERSIONS, 12].sort(ascending)).toEqual(
      Object.keys(CONTRACT_EVENT.versions).map(Number).sort(ascending),
    );
    expect(profileCombinationRule(pinning(5, 1, 1, 12))).toBe("unsupported-version");
  });

  test("a contract-event type pinned twice or not at all is refused, never a fit", () => {
    const fitting = pinning(5, 1, 1);
    const without = {
      ...fitting,
      profile: {
        ...fitting.profile,
        pins: fitting.profile.pins.filter((p) => p.record_type !== RECORD_TYPES.contractEvent),
      },
    };
    const twice = {
      ...fitting,
      profile: {
        ...fitting.profile,
        pins: [...fitting.profile.pins, { record_type: RECORD_TYPES.contractEvent, version: 8 }],
      },
    };
    expect(profileCombinationRule(fitting)).toBeUndefined();
    expect(profileCombinationRule(without)).toBe("profile-combination");
    expect(profileCombinationRule(twice)).toBe("profile-combination");
  });

  test("the opening and ballot versions 2.3 knows are the ones their codecs read", () => {
    const ascending = (a: number, b: number) => a - b;
    expect([...SPOILED_OPENING_VERSIONS].sort(ascending)).toEqual(
      Object.keys(SPOILED_BALLOT_OPENING.versions).map(Number).sort(ascending),
    );
    // Ballot version 5 joins 2.3's set with definition version 7 (P2-17 part 4).
    expect([...BALLOT_VERSIONS, 5].sort(ascending)).toEqual(
      Object.keys(BALLOT.versions).map(Number).sort(ascending),
    );
  });

  test("definition version 3 pairs only with ballot version 2, which opening version 2 opens", () => {
    // The rule reads only the profile, so version 1's value with 0x0001
    // pinned at 3 stands in for a version-3 definition.
    const v3 = (ballot: number) => {
      const d = pinning(5, ballot, 1);
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
    // Ballot version 3 carries questions, which definition version 5 alone
    // has, and version 4 an author half, which definition version 6 alone has.
    expect(profileCombinationRule(v3(3))).toBe("profile-combination");
    expect(profileCombinationRule(v3(4))).toBe("profile-combination");
    // A ballot version this package doesn't know may be a later release's
    // cell-naming ballot: unsupported, never failed (T-36).
    expect(profileCombinationRule(v3(5))).toBe("unsupported-version");
    // Ballot version 2 is the only one that could fit, and only opening
    // version 2 opens its cores, so it is refused beside opening version 1
    // or 3 (docs/spec/challenge.md, Versions; T-42). One this package doesn't
    // know, which a later release may read: unsupported, never a failure
    // that release would disagree with (T-36).
    for (const spoiled of [1, 2, 3, 255]) {
      const d = v3(2);
      const pinned = {
        ...d,
        profile: {
          ...d.profile,
          pins: d.profile.pins.map((p) =>
            p.record_type === RECORD_TYPES.spoiledBallotOpening ? { ...p, version: spoiled } : p,
          ),
        },
      };
      expect(profileCombinationRule(pinned)).toBe(
        spoiled === 2 ? undefined : spoiled === 255 ? "unsupported-version" : "profile-combination",
      );
    }
    expect(profileCombinationRule(pinning(5, 1, 1))).toBeUndefined();
    expect(profileCombinationRule(pinning(5, 2, 1))).toBe("profile-combination");
    // Ballot version 2 still needs a board that carries its delivery records.
    const v3Board1 = v3(2);
    const board1 = {
      ...v3Board1,
      profile: {
        ...v3Board1.profile,
        pins: v3Board1.profile.pins.map((p) =>
          p.record_type === RECORD_TYPES.boardEntry ? { ...p, version: 1 } : p,
        ),
      },
    };
    expect(profileCombinationRule(board1)).toBe("profile-combination");
    // A failure whatever the opening version is reported as one even beside
    // an opening version this package doesn't know.
    const unknownOpening = {
      ...board1,
      profile: {
        ...board1.profile,
        pins: board1.profile.pins.map((p) =>
          p.record_type === RECORD_TYPES.spoiledBallotOpening ? { ...p, version: 255 } : p,
        ),
      },
    };
    expect(profileCombinationRule(unknownOpening)).toBe("profile-combination");
  });

  test("definition version 4 keeps version 3's regional cells and its pairing", () => {
    const v4 = (ballot: number) => {
      const d = pinning(5, ballot, 1);
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
    expect(profileCombinationRule(v4(3))).toBe("profile-combination");
    expect(profileCombinationRule(v4(4))).toBe("profile-combination");
    expect(profileCombinationRule(v4(5))).toBe("unsupported-version");
    expect(profileCombinationRule(v4(2))).toBe("profile-combination");
    const v4Board = (board: number) => ({
      ...v4(2),
      profile: {
        ...v4(2).profile,
        pins: v4(2).profile.pins.map((p) =>
          p.record_type === RECORD_TYPES.boardEntry ? { ...p, version: board } : p,
        ),
      },
    });
    // Ballot version 2 needs receipts on the board, and tally-opening 1 destruction.
    expect(profileCombinationRule(v4Board(1))).toBe("profile-combination");
    expect(profileCombinationRule(v4Board(3))).toBe("profile-combination");
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
      const fitting = pinning(5, 1, 1);
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

  test("definition versions 1, 3 and 4 pair with display-text version 1 only, and an unknown one fails", () => {
    // From docs/spec/verifier.md 2.3: display-text version 2 carries
    // questions and pairs with definition versions 5 and 6, and a
    // display-text version this package doesn't know fails rather than being
    // unsupported, whatever else the profile pins (T-34, T-36, T-41).
    const withDisplayText = (d: ElectionDefinition, version: number, definition = 1) => ({
      ...d,
      profile: {
        ...d.profile,
        pins: d.profile.pins.map((p) =>
          p.record_type === RECORD_TYPES.displayText
            ? { ...p, version }
            : p.record_type === RECORD_TYPES.electionDefinition
              ? { ...p, version: definition }
              : p,
        ),
      },
    });
    // Under 3 and 4, ballot version 2 beside a spoiled-ballot opening version
    // this package doesn't know is unsupported when the display text fits;
    // a display-text failure is never hidden behind it.
    const regional = pinning(5, 2, 1);
    const unknownOpening = {
      ...regional,
      profile: {
        ...regional.profile,
        pins: regional.profile.pins.map((p) =>
          p.record_type === RECORD_TYPES.spoiledBallotOpening ? { ...p, version: 255 } : p,
        ),
      },
    };
    for (const definition of [1, 3, 4]) {
      const fitting = definition === 1 ? pinning(5, 1, 1) : unknownOpening;
      expect(profileCombinationRule(withDisplayText(fitting, 1, definition))).toBe(
        definition === 1 ? undefined : "unsupported-version",
      );
      for (const version of [2, 3, 255])
        expect(profileCombinationRule(withDisplayText(fitting, version, definition))).toBe(
          "profile-combination",
        );
    }
    const unpinned = {
      ...sampleDefinition,
      profile: {
        ...sampleDefinition.profile,
        pins: sampleDefinition.profile.pins.filter(
          (p) => p.record_type !== RECORD_TYPES.displayText,
        ),
      },
    };
    expect(profileCombinationRule(unpinned)).toBe("profile-combination");
    // A board-entry version this package doesn't read stays unsupported (2.3, step 2).
    expect(profileCombinationRule(withDisplayText(pinning(8, 1, 1), 2))).toBe(
      "unsupported-version",
    );
  });

  // The rule reads only the profile, so version 1's value with its pins
  // changed stands in for each definition version.
  const withPins = (d: ElectionDefinition, pins: Readonly<Record<number, number | undefined>>) => ({
    ...d,
    profile: {
      ...d.profile,
      pins: [
        ...d.profile.pins.filter((p) => !Object.hasOwn(pins, p.record_type)).map((p) => ({ ...p })),
        ...Object.entries(pins)
          .filter((e): e is [string, number] => e[1] !== undefined)
          .map(([t, version]) => ({ record_type: Number(t), version })),
      ].sort((a, b) => a.record_type - b.record_type),
    },
  });
  const v5 = (pins: Readonly<Record<number, number | undefined>> = {}) =>
    withPins(pinning(5, 3, 1), {
      [RECORD_TYPES.electionDefinition]: 5,
      [RECORD_TYPES.displayText]: 2,
      [RECORD_TYPES.spoiledBallotOpening]: 2,
      ...pins,
    });

  test("definition version 5 pairs only with ballot version 3, display-text version 2 and opening version 2", () => {
    // Opening version 2 opens version-3 cores, so the typical version-5
    // profile passes.
    expect(profileCombinationRule(v5())).toBeUndefined();
    for (const ballot of [1, 2])
      expect(profileCombinationRule(v5({ [RECORD_TYPES.ballot]: ballot }))).toBe(
        "profile-combination",
      );
    // Ballot version 4 pairs with definition version 6 only; a ballot version
    // it doesn't know may be a later release's question ballot.
    expect(profileCombinationRule(v5({ [RECORD_TYPES.ballot]: 4 }))).toBe("profile-combination");
    expect(profileCombinationRule(v5({ [RECORD_TYPES.ballot]: 5 }))).toBe("unsupported-version");
    // Display-text version 1 has no questions; an unknown one fails too.
    for (const displayText of [1, 3, undefined])
      expect(profileCombinationRule(v5({ [RECORD_TYPES.displayText]: displayText }))).toBe(
        "profile-combination",
      );
    // Opening version 1 opens version-1 cores only, and version 3 version-4
    // cores; none pinned can't challenge.
    for (const spoiled of [1, 3, undefined])
      expect(profileCombinationRule(v5({ [RECORD_TYPES.spoiledBallotOpening]: spoiled }))).toBe(
        "profile-combination",
      );
    expect(profileCombinationRule(v5({ [RECORD_TYPES.spoiledBallotOpening]: 255 }))).toBe(
      "unsupported-version",
    );
    // Ballot version 3 needs a board that carries its delivery records, and
    // that failure is reported beside an opening this package doesn't read.
    expect(profileCombinationRule(v5({ [RECORD_TYPES.boardEntry]: 1 }))).toBe(
      "profile-combination",
    );
    expect(
      profileCombinationRule(
        v5({ [RECORD_TYPES.boardEntry]: 1, [RECORD_TYPES.spoiledBallotOpening]: 255 }),
      ),
    ).toBe("profile-combination");
    // Ballot version 3 pairs with definition version 5 alone.
    for (const definition of [1, 3, 4])
      expect(profileCombinationRule(v5({ [RECORD_TYPES.electionDefinition]: definition }))).toBe(
        "profile-combination",
      );
  });

  test("a definition version without known pairings fails, never borrowing version 1's", () => {
    for (const definition of [2, 6, 7, 255, undefined])
      expect(
        profileCombinationRule(
          withPins(pinning(5, 1, 1), { [RECORD_TYPES.electionDefinition]: definition }),
        ),
      ).toBe("profile-combination");
  });

  test("ballot version 1 pairs only with opening version 1, which opens its cores", () => {
    expect(profileCombinationRule(pinning(5, 1, 1))).toBeUndefined();
    // Opening version 2 opens cells' cores; one this package doesn't know
    // can't be a later release's opening of version-1 cores either: the
    // spec gives version 1 its opening (docs/spec/verifier.md, 2.3).
    for (const spoiled of [2, 255, undefined])
      expect(
        profileCombinationRule(
          withPins(pinning(5, 1, 1), { [RECORD_TYPES.spoiledBallotOpening]: spoiled }),
        ),
      ).toBe("profile-combination");
  });
});
