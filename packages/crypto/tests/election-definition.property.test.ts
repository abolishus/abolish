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
  DRAFT_VERSIONS,
  type ElectionDefinition,
  electionDefinitionHash,
  electionDefinitionRule,
  encodeDisplayText,
  encodeElectionDefinition,
  newDisplayTextSalt,
  newElectionId,
  PARAMETERS,
  pinsDraftVersion,
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
      fc.property(anyDefinition, (d) => {
        const pinned = d.profile.pins.find((p) => p.record_type === 1)?.version === 1;
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

  test("decodes only against a definition that pins version 1", () => {
    const t = text(["a", "b"]);
    const unpinned = {
      ...sampleDefinition,
      profile: { protocol_major: 1, pins: allPins.slice(0, 8) },
    };
    expect(() => decodeDisplayText(encodeDisplayText(t), unpinned)).toThrow(RangeError);
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

describe("draft versions", () => {
  test("every definition pinning version 1 of 0x0001 pins a draft", () => {
    expect(pinsDraftVersion(sampleDefinition)).toBe(true);
    expect(DRAFT_VERSIONS).toEqual([
      { record_type: 1, version: 1 },
      { record_type: 9, version: 1 },
    ]);
  });
});

describe("randomness and parameters", () => {
  test("salts and election IDs are fresh 32-byte CSPRNG outputs", () => {
    expect(newDisplayTextSalt()).toHaveLength(PARAMETERS.DISPLAY_TEXT_SALT_LEN);
    expect(newElectionId()).toHaveLength(32);
    expect(newDisplayTextSalt()).not.toEqual(newDisplayTextSalt());
    expect(newElectionId()).not.toEqual(newElectionId());
  });

  test("PARAMETERS matches docs/spec/parameters.md", () => {
    const md = readFileSync(new URL("../../../docs/spec/parameters.md", import.meta.url), "utf8");
    const rows = [...md.matchAll(/^\| `([A-Z_]+)` +\| (\d+) +\|/gm)].map((m) => [
      m[1],
      Number(m[2]),
    ]);
    expect(Object.entries(PARAMETERS)).toEqual(rows);
    expect(Object.isFrozen(PARAMETERS)).toBe(true);
  });
});
