import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { checkDeliveryV2With } from "../src/delivery.ts";
import * as entry from "../src/index.ts";
import {
  checkDeliveryV2,
  COMMITTED_VOTE_V4,
  decode,
  DecodeError,
  decodeBoardEntry,
  decodeShareComplaint,
  decodeSharePosting,
  decodeShareReceipt,
  type DeliveryBallotV4,
  type DeliveryCheckV2,
  type DeliveryElectionV2,
  type DeliveryEntry,
  encodeBoardEntry,
  encodeShareComplaintV2,
  encodeSharePostingV2,
  encodeShareReceiptV2,
  KEM_PUBLIC_KEY,
  RECORD_TYPES,
  SEAT_PANELS,
  shareComplaintStatementV2,
  shareReceiptRecordV2,
  shareReceiptStatementV4,
  signShareComplaintV2,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/delivery-v2.json comes from an independent Python
// implementation of the version-2 delivery records and the delivery check
// over both panels (scripts/delivery-v2-vectors.py, with its own P-256
// ECDSA, ML-KEM, AEAD and ristretto255), so the expected bytes and verdicts
// never come from the code under test. Elections with an author panel run
// through the internal `checkDeliveryV2With`, since the exported check
// refuses an author key set until P2-16 part 3 gives it a checked source.

type RecordKind = "share-receipt" | "share-posting" | "share-complaint";

interface Seat {
  readonly panel: number;
  readonly seat: number;
}

interface ResultVector {
  readonly ballots: readonly {
    readonly ballotHash: string;
    readonly counted: boolean;
    readonly delivered: boolean;
    readonly missing: readonly Seat[];
    readonly excludedBy: readonly (Seat & {
      readonly at: number;
      readonly signer: number | null;
    })[];
  }[];
  readonly records: readonly (Seat & {
    readonly at: number;
    readonly code: string;
    readonly signer?: number | null;
  })[];
  readonly rejected: readonly { readonly at: number; readonly error: string }[];
}

interface ElectionVector {
  readonly id: string;
  readonly definitionHash: string;
  readonly panelSize: number;
  readonly authorPanelSize: number;
  readonly registered: readonly number[];
  readonly authorRegistered: readonly number[];
  readonly segments: { readonly delivery: string; readonly complaint: string };
  readonly deadlines: { readonly delivery: string; readonly complaint: string };
  readonly ballots: readonly {
    readonly id: string;
    readonly cell: number;
    readonly nullifier: string;
    readonly committedVote: string;
    readonly ballotHash: string;
  }[];
  readonly entries: readonly (
    | { readonly path: "board"; readonly segment: number; readonly payload: string }
    | { readonly path: "contract"; readonly submittedAt: string; readonly payload: string }
  )[];
  readonly result: ResultVector;
}

interface SeatVector {
  readonly seat: number;
  readonly kemKey: string;
  readonly signingSecret: string;
  readonly signingKey: string;
  readonly identityKey: string;
}

interface Vectors {
  readonly format: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly panels: { readonly default: number; readonly author: number };
  readonly seats: {
    readonly default: readonly SeatVector[];
    readonly author: readonly SeatVector[];
  };
  readonly records: readonly {
    readonly id: string;
    readonly type: RecordKind;
    readonly encoding: string;
    readonly panel: 1 | 2;
    readonly seat: number;
    readonly statement?: string;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly type: RecordKind;
    readonly encoding: string;
    readonly error: string;
  }[];
  readonly boardEntries: readonly {
    readonly id: string;
    readonly version: 4;
    readonly encoding: string;
    readonly error: string | null;
  }[];
  readonly elections: readonly ElectionVector[];
}

const V = JSON.parse(readFileSync(new URL("delivery-v2.json", SPEC_VECTORS), "utf8")) as Vectors;
const bytesHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Each run re-checks postings and complaints with ML-KEM, which is slow in
// JavaScript, so the properties that run the whole check scale their runs down.
const slowRuns = Math.max(10, Math.ceil(numRuns / 20));

const decoders = {
  "share-receipt": (b: Uint8Array) => encodeShareReceiptV2(decodeShareReceipt(b, 2)),
  "share-posting": (b: Uint8Array) => encodeSharePostingV2(decodeSharePosting(b, 2)),
  "share-complaint": (b: Uint8Array) => encodeShareComplaintV2(decodeShareComplaint(b, 2)),
} as const;

function keysOf(seats: readonly SeatVector[], registered: readonly number[]) {
  return registered.map((seat) => {
    const p = seats.find((x) => x.seat === seat);
    if (p === undefined) throw new Error(`no seat ${seat}`);
    return {
      index: seat,
      kemKey: decode(KEM_PUBLIC_KEY, hex(p.kemKey)),
      signingKey: hex(p.signingKey),
    };
  });
}

function electionOf(v: ElectionVector): DeliveryElectionV2 {
  return {
    definitionHash: hex(v.definitionHash),
    panelSize: v.panelSize,
    authorPanelSize: v.authorPanelSize,
    registered: {
      default: keysOf(V.seats.default, v.registered),
      author: keysOf(V.seats.author, v.authorRegistered),
    },
    segments: { delivery: BigInt(v.segments.delivery), complaint: BigInt(v.segments.complaint) },
    deadlines: {
      delivery: BigInt(v.deadlines.delivery),
      complaint: BigInt(v.deadlines.complaint),
    },
  };
}

const ballotsOf = (v: ElectionVector): DeliveryBallotV4[] =>
  v.ballots.map((b) => ({
    cell: b.cell,
    nullifier: BigInt(b.nullifier),
    vote: decode(COMMITTED_VOTE_V4, hex(b.committedVote)),
  }));

const entriesOf = (v: ElectionVector): DeliveryEntry[] =>
  v.entries.map((e) =>
    e.path === "board"
      ? { path: "board", segment: e.segment, payload: hex(e.payload) }
      : { path: "contract", submittedAt: BigInt(e.submittedAt), payload: hex(e.payload) },
  );

const check = (v: ElectionVector, entries = entriesOf(v)) =>
  checkDeliveryV2With(electionOf(v), ballotsOf(v), entries);

function asJson(r: DeliveryCheckV2): ResultVector {
  return {
    ballots: r.ballots.map((b) => ({
      ballotHash: bytesHex(b.ballotHash),
      counted: b.counted,
      delivered: b.delivered,
      missing: b.missing.map(({ panel, seat }) => ({ panel, seat })),
      excludedBy: b.excludedBy.map(({ at, panel, seat, signer }) => ({ at, panel, seat, signer })),
    })),
    records: r.records.map(({ at, code, panel, seat, signer }) =>
      signer === undefined ? { at, code, panel, seat } : { at, code, panel, seat, signer },
    ),
    rejected: r.rejected.map(({ at, error }) => ({ at, error })),
  };
}

// Verdicts without board positions, which a reordering moves.
const verdicts = (r: DeliveryCheckV2) =>
  r.ballots.map((b) => ({
    counted: b.counted,
    delivered: b.delivered,
    missing: b.missing.map(({ panel, seat }) => `${panel}:${seat}`),
    excludedBy: [...new Set(b.excludedBy.map((c) => `${c.panel}:${c.seat}`))].sort(),
  }));

const electionById = (id: string) => {
  const v = V.elections.find((e) => e.id === id);
  if (v === undefined) throw new Error(`no election ${id}`);
  return v;
};

describe("delivery version 2 vectors", () => {
  test("file format, tags and panels", () => {
    expect(V.format).toBe("abolish-delivery-vectors/2");
    expect(V.tags).toEqual({
      receipt: "abolish/v1/sig/share-receipt-2",
      complaint: "abolish/v1/sig/share-complaint-2",
    });
    expect(V.panels).toEqual(SEAT_PANELS);
  });

  test("records decode and re-encode byte for byte, at their sizes", () => {
    for (const r of V.records) {
      expect(bytesHex(decoders[r.type](hex(r.encoding))), r.id).toBe(r.encoding);
      if (r.type === "share-receipt") expect(r.encoding.length / 2).toBe(165);
      if (r.type === "share-complaint") expect(r.encoding.length / 2).toBe(229);
    }
  });

  test("a version-2 receipt's first fields are the 98-byte version-4 receipt statement", () => {
    for (const r of V.records.filter((x) => x.type === "share-receipt")) {
      const rec = decodeShareReceipt(hex(r.encoding), 2);
      expect([rec.panel, rec.seat], r.id).toEqual([r.panel, r.seat]);
      expect(bytesHex(shareReceiptStatementV4(rec)), r.id).toBe(r.statement);
      // shareReceiptRecordV2 builds the same record from an intake result's fields.
      const built = shareReceiptRecordV2(rec.definition_hash, rec.seat, {
        panel: rec.panel,
        ballotHash: rec.ballot_hash,
        shareHash: rec.share_hash,
        receipt: rec.signature,
      });
      expect(bytesHex(encodeShareReceiptV2(built))).toBe(r.encoding);
    }
  });

  test("complaints are re-made byte for byte from the signing secret (RFC 6979)", () => {
    for (const r of V.records.filter((x) => x.type === "share-complaint")) {
      const c = decodeShareComplaint(hex(r.encoding), 2);
      expect(bytesHex(shareComplaintStatementV2(c)), r.id).toBe(r.statement);
      const seats = r.panel === SEAT_PANELS.author ? V.seats.author : V.seats.default;
      const secret = seats.find((p) => p.seat === r.seat)?.signingSecret;
      if (secret === undefined) throw new Error("no secret");
      expect(bytesHex(encodeShareComplaintV2(signShareComplaintV2(hex(secret), c)))).toBe(
        r.encoding,
      );
    }
  });

  test.each(V.decode.map((v) => [v.id, v] as const))("rejects %s", (_id, v) => {
    let err: unknown;
    try {
      decoders[v.type](hex(v.encoding));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).code).toBe(v.error);
  });

  test.each(V.boardEntries.map((v) => [v.id, v] as const))("board entry %s", (_id, v) => {
    const b = hex(v.encoding);
    if (v.error === null) {
      const e = decodeBoardEntry(b, v.version);
      expect(bytesHex(encodeBoardEntry(e, v.version))).toBe(v.encoding);
    } else {
      expect(() => decodeBoardEntry(b, v.version)).toThrow(
        expect.objectContaining({ code: v.error }) as Error,
      );
    }
  });

  test.each(V.elections.map((v) => [v.id, v] as const))(
    "delivery check %s",
    { timeout: 60_000 },
    (_id, v) => {
      const r = check(v);
      expect(asJson(r)).toEqual(v.result);
      expect(r.ballots.map((b) => bytesHex(b.ballotHash))).toEqual(
        v.ballots.map((b) => b.ballotHash),
      );
    },
  );

  test("the file covers every report code, both panels and a poll without an author panel", () => {
    const codes = new Set(V.elections.flatMap((e) => e.result.records.map((r) => r.code)));
    for (const code of [
      "delivery-stray",
      "delivery-seat",
      "delivery-late",
      "share-receipt",
      "posting-hash",
      "posting-encapsulation",
      "complaint-void",
      "complaint-proof",
      "complaint-unfounded",
      "receipt-contradicted",
    ])
      expect(codes, code).toContain(code);
    const excluded = V.elections.flatMap((e) =>
      e.result.ballots.flatMap((b) => b.excludedBy.map((c) => c.panel)),
    );
    expect(new Set(excluded)).toEqual(new Set([SEAT_PANELS.default, SEAT_PANELS.author]));
    expect(V.elections.some((e) => e.authorPanelSize === 0)).toBe(true);
  });
});

describe("exported check", () => {
  test("runs a poll without an author panel", () => {
    const v = electionById("no-author-panel");
    const r = checkDeliveryV2(electionOf(v), ballotsOf(v), entriesOf(v));
    expect(asJson(r)).toEqual(v.result);
  });

  test("refuses an author panel or author keys until they have a checked source", () => {
    const v = electionById("all-receipted");
    expect(() => checkDeliveryV2(electionOf(v), ballotsOf(v), entriesOf(v))).toThrow(RangeError);
    const plain = electionById("no-author-panel");
    const e = electionOf(plain);
    const withKeys = { ...e, registered: { ...e.registered, author: e.registered.default } };
    expect(() => checkDeliveryV2(withKeys, ballotsOf(plain), [])).toThrow(RangeError);
  });

  test("the internal check isn't exported from the entry point", () => {
    expect("checkDeliveryV2With" in entry).toBe(false);
  });
});

describe("input checks", () => {
  const v = electionById("all-receipted");

  test("refuses a key set listing a seat twice or a seat outside its panel", () => {
    const e = electionOf(v);
    const [d1] = e.registered.default;
    const [a1] = e.registered.author;
    if (d1 === undefined || a1 === undefined) throw new Error("no seats");
    for (const registered of [
      { ...e.registered, default: [...e.registered.default, d1] },
      { ...e.registered, author: [...e.registered.author, a1] },
      { ...e.registered, default: [{ ...d1, index: 4 }] },
      { ...e.registered, author: [{ ...a1, index: 4 }] },
      { ...e.registered, author: [{ ...a1, index: 0 }] },
    ])
      expect(() => checkDeliveryV2With({ ...e, registered }, ballotsOf(v), [])).toThrow(RangeError);
  });

  test("refuses panel sizes out of range", () => {
    const e = electionOf(v);
    for (const bad of [
      { panelSize: 1 },
      { panelSize: 17 },
      { authorPanelSize: -1 },
      { authorPanelSize: 17 },
      { authorPanelSize: 1.5 },
    ])
      expect(() => checkDeliveryV2With({ ...e, ...bad }, [], [])).toThrow(RangeError);
  });

  test("refuses a ballot that didn't pass validity-shape", () => {
    const e = electionOf(v);
    const [b] = ballotsOf(v) as [DeliveryBallotV4];
    for (const vote of [
      { ...b.vote, share_hashes: b.vote.share_hashes.slice(1) },
      { ...b.vote, author_share_hashes: b.vote.author_share_hashes.slice(1) },
      { ...b.vote, author_vss: [] },
    ])
      expect(() => checkDeliveryV2With(e, [{ ...b, vote }], [])).toThrow(RangeError);
    // A ballot with an author half in a poll without an author panel.
    const plain = { ...e, authorPanelSize: 0, registered: { ...e.registered, author: [] } };
    const noAuthorHashes = { ...b.vote, author_share_hashes: [] };
    expect(() => checkDeliveryV2With(plain, [{ ...b, vote: noAuthorHashes }], [])).toThrow(
      RangeError,
    );
  });

  test("refuses malformed entries and windows", () => {
    const e = electionOf(v);
    const b = ballotsOf(v);
    const payload = new Uint8Array(3);
    for (const bad of [
      { segment: 0, payload },
      { path: "board", segment: -1, payload },
      { path: "contract", submittedAt: 5, payload },
    ])
      expect(() => checkDeliveryV2With(e, b, [bad as unknown as DeliveryEntry])).toThrow(
        RangeError,
      );
    for (const bad of [
      { segments: { delivery: 3n, complaint: 2n } },
      { deadlines: { delivery: 1, complaint: 2 } },
    ])
      expect(() =>
        checkDeliveryV2With({ ...e, ...bad } as unknown as DeliveryElectionV2, b, []),
      ).toThrow(RangeError);
  });
});

// --- Properties --------------------------------------------------------------

describe("properties", () => {
  test(
    "verdicts don't depend on the records' order or on duplicates (R3)",
    { timeout: 300_000 },
    () => {
      const multi = electionById("three-ballots");
      const entries = entriesOf(multi);
      const expected = verdicts(check(multi));
      fc.assert(
        fc.property(
          fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }),
          fc.array(fc.nat({ max: entries.length - 1 }), { maxLength: 4 }),
          (shuffled, dups) => {
            const all = [...shuffled, ...dups.map((i) => entries[i] as DeliveryEntry)];
            expect(verdicts(check(multi, all))).toEqual(expected);
          },
        ),
        { numRuns: slowRuns },
      );
    },
  );

  test(
    "any changed byte of a receipt either fails to decode or stops it delivering",
    { timeout: 120_000 },
    () => {
      const one = electionById("all-receipted");
      const entries = entriesOf(one);
      fc.assert(
        fc.property(
          fc.nat({ max: entries.length - 1 }),
          fc.nat(),
          fc.integer({ min: 1, max: 255 }),
          (which, pos, flip) => {
            const e = entries[which] as DeliveryEntry;
            // Bytes 0–1 are the record type, which the caller dispatches on.
            const i = 2 + (pos % (e.payload.length - 2));
            const payload = e.payload.slice();
            payload[i] = (payload[i] as number) ^ flip;
            const changed = entries.map((x, j) => (j === which ? { ...x, payload } : x));
            expect(check(one, changed).ballots[0]?.delivered).toBe(false);
          },
        ),
        { numRuns },
      );
    },
  );

  test(
    "a record moved to the other panel never delivers, excludes or is attributed (T-37)",
    { timeout: 300_000 },
    () => {
      // Any subset of the contradicted case's records relabelled with the other
      // panel: each moved receipt fails unattributed, a moved posting fails its
      // hash, a moved complaint is void, and nothing moved excludes the ballot.
      const v = electionById("contradicted-receipt");
      const entries = entriesOf(v);
      const kinds = entries.map((e) => ((e.payload[0] as number) << 8) | (e.payload[1] as number));
      const expected = {
        [RECORD_TYPES.shareReceipt]: { code: "share-receipt", signer: null },
        [RECORD_TYPES.sharePosting]: { code: "posting-hash" },
        [RECORD_TYPES.shareComplaint]: { code: "complaint-void" },
      };
      fc.assert(
        fc.property(fc.subarray(entries.map((_, i) => i)), (moved) => {
          const swapped = entries.map((e, i) => {
            if (!moved.includes(i)) return e;
            const payload = e.payload.slice();
            payload[67] = 3 - (payload[67] as number);
            return { ...e, payload };
          });
          const r = check(v, swapped);
          for (const i of moved) {
            expect(r.ballots[0]?.excludedBy.some((c) => c.at === i)).toBe(false);
            const report = r.records.find((x) => x.at === i);
            expect(report).toMatchObject(expected[kinds[i] as keyof typeof expected]);
          }
        }),
        { numRuns: slowRuns },
      );
    },
  );

  test("random bytes decode as a version-2 record only if they re-encode to themselves", () => {
    const kinds = Object.keys(decoders) as RecordKind[];
    const types = {
      "share-receipt": RECORD_TYPES.shareReceipt,
      "share-posting": RECORD_TYPES.sharePosting,
      "share-complaint": RECORD_TYPES.shareComplaint,
    };
    fc.assert(
      fc.property(
        fc.constantFrom(...kinds),
        fc.constantFrom(1, 2, 3),
        fc.uint8Array({ maxLength: 300 }),
        (kind, panel, body) => {
          const t = types[kind];
          // A panel byte at its offset, so the bytes after it are reached.
          const b = Uint8Array.of(t >> 8, t & 0xff, 2, ...new Uint8Array(64), panel, ...body);
          let out: Uint8Array;
          try {
            out = decoders[kind](b);
          } catch (e) {
            if (e instanceof DecodeError) return;
            throw e;
          }
          expect(out).toEqual(b);
        },
      ),
      { numRuns },
    );
  });

  test(
    "a vector posting with any byte changed decodes only if it re-encodes to itself",
    { timeout: 120_000 },
    () => {
      const posting = hex(
        (V.records.find((r) => r.type === "share-posting") as { encoding: string }).encoding,
      );
      fc.assert(
        fc.property(fc.nat(), fc.integer({ min: 1, max: 255 }), (pos, flip) => {
          const b = posting.slice();
          const i = 3 + (pos % (b.length - 3));
          b[i] = (b[i] as number) ^ flip;
          let out: Uint8Array;
          try {
            out = decoders["share-posting"](b);
          } catch (e) {
            if (e instanceof DecodeError) return;
            throw e;
          }
          expect(out).toEqual(b);
        }),
        { numRuns },
      );
    },
  );

  test("version 1 and version 2 records never decode as each other", () => {
    for (const r of V.records) {
      const b = hex(r.encoding);
      const v1 = {
        "share-receipt": () => decodeShareReceipt(b, 1),
        "share-posting": () => decodeSharePosting(b, 1),
        "share-complaint": () => decodeShareComplaint(b, 1),
      }[r.type];
      expect(v1, r.id).toThrow(expect.objectContaining({ code: "profile-mismatch" }) as Error);
    }
  });
});
