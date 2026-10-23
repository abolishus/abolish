import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BOARD_PAYLOAD_TYPES,
  BOARD_PAYLOAD_TYPES_V3,
  checkDelivery,
  COMMITTED_VOTE,
  COMPLAINT_WINDOW,
  CONTRACT_EVENT_WINDOW,
  decode,
  DecodeError,
  decodeBoardEntry,
  decodeShareComplaint,
  decodeSharePosting,
  decodeShareReceipt,
  DELIVERY_WINDOW,
  type DeliveryBallot,
  type DeliveryCheck,
  type DeliveryElection,
  type DeliveryEntry,
  deliveryDeadlines,
  BALLOT_FETCH_ALLOWANCE,
  deliveryWindowFits,
  intakeCutoff,
  deliverySegments,
  encodeBoardEntry,
  EncodeError,
  encodeShareComplaint,
  encodeSharePosting,
  encodeShareReceipt,
  KEM_PUBLIC_KEY,
  RECORD_TYPES,
  shareComplaintStatement,
  signShareComplaint,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/delivery.json comes from an independent Python
// implementation of the delivery records and the delivery check
// (scripts/delivery-vectors.py, with its own P-256 ECDSA, ML-KEM, AEAD and
// ristretto255), so the expected bytes and verdicts never come from the code
// under test.

type RecordKind = "share-receipt" | "share-posting" | "share-complaint";

interface ResultVector {
  readonly ballots: readonly {
    readonly ballotHash: string;
    readonly counted: boolean;
    readonly delivered: boolean;
    readonly missing: readonly number[];
    readonly excludedBy: readonly {
      readonly at: number;
      readonly seat: number;
      readonly signer: number | null;
    }[];
  }[];
  readonly records: readonly {
    readonly at: number;
    readonly code: string;
    readonly signer?: number | null;
  }[];
  readonly rejected: readonly { readonly at: number; readonly error: string }[];
}

interface ElectionVector {
  readonly id: string;
  readonly registered: readonly number[];
  readonly segments: { readonly delivery: string; readonly complaint: string };
  readonly deadlines: { readonly delivery: string; readonly complaint: string };
  readonly ballots: readonly {
    readonly id: string;
    readonly tier: number;
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

interface Vectors {
  readonly format: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly windows: { readonly delivery: string; readonly complaint: string };
  readonly definitionHash: string;
  readonly panel: readonly {
    readonly seat: number;
    readonly kemKey: string;
    readonly signingSecret: string;
    readonly signingKey: string;
    readonly identityKey: string;
  }[];
  readonly records: readonly {
    readonly id: string;
    readonly type: RecordKind;
    readonly encoding: string;
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
    readonly version: 1 | 3;
    readonly encoding: string;
    readonly error: string | null;
  }[];
  readonly segments: readonly {
    readonly id: string;
    readonly epoch: string;
    readonly period: string;
    readonly closesAt: string;
    readonly l1InclusionBound: string;
    readonly delivery: string;
    readonly complaint: string;
    readonly deliveryDeadline: string;
    readonly complaintDeadline: string;
  }[];
  readonly elections: readonly ElectionVector[];
}

const V = JSON.parse(readFileSync(new URL("delivery.json", SPEC_VECTORS), "utf8")) as Vectors;
const bytesHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const DEFINITION = hex(V.definitionHash);

const decoders = {
  "share-receipt": (b: Uint8Array) => encodeShareReceipt(decodeShareReceipt(b, 1)),
  "share-posting": (b: Uint8Array) => encodeSharePosting(decodeSharePosting(b, 1)),
  "share-complaint": (b: Uint8Array) => encodeShareComplaint(decodeShareComplaint(b, 1)),
} as const;

function electionOf(v: ElectionVector): DeliveryElection {
  return {
    definitionHash: DEFINITION,
    panelSize: V.panel.length,
    registered: v.registered.map((seat) => {
      const p = V.panel.find((x) => x.seat === seat);
      if (p === undefined) throw new Error(`no seat ${seat}`);
      return {
        index: seat,
        kemKey: decode(KEM_PUBLIC_KEY, hex(p.kemKey)),
        signingKey: hex(p.signingKey),
      };
    }),
    segments: { delivery: BigInt(v.segments.delivery), complaint: BigInt(v.segments.complaint) },
    deadlines: {
      delivery: BigInt(v.deadlines.delivery),
      complaint: BigInt(v.deadlines.complaint),
    },
  };
}

const ballotsOf = (v: ElectionVector): DeliveryBallot[] =>
  v.ballots.map((b) => ({
    tier: b.tier,
    nullifier: BigInt(b.nullifier),
    vote: decode(COMMITTED_VOTE, hex(b.committedVote)),
  }));

const entriesOf = (v: ElectionVector): DeliveryEntry[] =>
  v.entries.map((e) =>
    e.path === "board"
      ? { path: "board", segment: e.segment, payload: hex(e.payload) }
      : { path: "contract", submittedAt: BigInt(e.submittedAt), payload: hex(e.payload) },
  );

function asJson(r: DeliveryCheck): ResultVector {
  return {
    ballots: r.ballots.map((b) => ({
      ballotHash: bytesHex(b.ballotHash),
      counted: b.counted,
      delivered: b.delivered,
      missing: [...b.missing],
      excludedBy: b.excludedBy.map(({ at, seat, signer }) => ({ at, seat, signer })),
    })),
    records: r.records.map((x) => (x.signer === undefined ? { at: x.at, code: x.code } : { ...x })),
    rejected: r.rejected.map(({ at, error }) => ({ at, error })),
  };
}

// Verdicts without board positions, which a reordering moves.
const verdicts = (r: DeliveryCheck) =>
  r.ballots.map((b) => ({
    counted: b.counted,
    delivered: b.delivered,
    missing: [...b.missing],
    excludedBy: [...new Set(b.excludedBy.map((c) => c.seat))].sort((x, y) => x - y),
  }));

describe("delivery vectors", () => {
  test("file format, tags and windows", () => {
    expect(V.format).toBe("abolish-delivery-vectors/1");
    expect(V.tags).toEqual({
      receipt: "abolish/v1/sig/share-receipt",
      complaint: "abolish/v1/sig/share-complaint",
    });
    expect(BigInt(V.windows.delivery)).toBe(DELIVERY_WINDOW);
    expect(BigInt(V.windows.complaint)).toBe(COMPLAINT_WINDOW);
  });

  test("records decode and re-encode byte for byte", () => {
    for (const r of V.records)
      expect(bytesHex(decoders[r.type](hex(r.encoding))), r.id).toBe(r.encoding);
  });

  test("a share receipt's first fields are its signed statement", () => {
    const r = V.records.find((x) => x.type === "share-receipt");
    if (r?.statement === undefined) throw new Error("no receipt vector");
    expect(r.encoding.slice(6, 6 + 194)).toBe(r.statement);
  });

  test("complaints are re-made byte for byte from the signing secret (RFC 6979)", () => {
    const r = V.records.find((x) => x.type === "share-complaint");
    if (r?.statement === undefined) throw new Error("no complaint vector");
    const c = decodeShareComplaint(hex(r.encoding), 1);
    expect(bytesHex(shareComplaintStatement(c))).toBe(r.statement);
    const secret = V.panel.find((p) => p.seat === r.seat)?.signingSecret;
    if (secret === undefined) throw new Error("no secret");
    expect(bytesHex(encodeShareComplaint(signShareComplaint(hex(secret), c)))).toBe(r.encoding);
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

  test.each(V.segments.map((v) => [v.id, v] as const))("deadline segments %s", (_id, v) => {
    expect(
      deliverySegments(
        { epoch: BigInt(v.epoch), period: BigInt(v.period) },
        BigInt(v.closesAt),
        BigInt(v.l1InclusionBound),
      ),
    ).toEqual({ delivery: BigInt(v.delivery), complaint: BigInt(v.complaint) });
    expect(deliveryDeadlines(BigInt(v.closesAt), BigInt(v.l1InclusionBound))).toEqual({
      delivery: BigInt(v.deliveryDeadline),
      complaint: BigInt(v.complaintDeadline),
    });
  });

  test.each(V.elections.map((v) => [v.id, v] as const))(
    "delivery check %s",
    { timeout: 60_000 },
    (_id, v) => {
      const r = checkDelivery(electionOf(v), ballotsOf(v), entriesOf(v), 1);
      expect(asJson(r)).toEqual(v.result);
      expect(r.ballots.map((b) => bytesHex(b.ballotHash))).toEqual(
        v.ballots.map((b) => b.ballotHash),
      );
    },
  );
});

describe("board entry version 3", () => {
  const base = { election_id: new Uint8Array(32), index: 0n, segment: 0 };
  const record = (t: number) => Uint8Array.of(t >> 8, t & 0xff, 1, 0);

  test("allows exactly version 1's types, share receipts and complaints", () => {
    expect([...BOARD_PAYLOAD_TYPES_V3].sort((a, b) => a - b)).toEqual(
      [...BOARD_PAYLOAD_TYPES, RECORD_TYPES.shareReceipt, RECORD_TYPES.shareComplaint].sort(
        (a, b) => a - b,
      ),
    );
    expect(Object.isFrozen(BOARD_PAYLOAD_TYPES_V3)).toBe(true);
  });

  test("version 1 refuses to encode a receipt or complaint; version 3 encodes it", () => {
    for (const t of [RECORD_TYPES.shareReceipt, RECORD_TYPES.shareComplaint]) {
      expect(() => encodeBoardEntry({ ...base, payload: record(t) }, 1)).toThrow(EncodeError);
      const b = encodeBoardEntry({ ...base, payload: record(t) }, 3);
      expect(b[2]).toBe(3);
      expect(decodeBoardEntry(b, 3).payload).toEqual(record(t));
    }
  });

  test("no version encodes a share posting: postings reach the board only as contract events", () => {
    for (const version of [1, 3, 4, 5, 6] as const)
      expect(() =>
        encodeBoardEntry({ ...base, payload: record(RECORD_TYPES.sharePosting) }, version),
      ).toThrow(EncodeError);
  });

  test("version 2 is never assigned", () => {
    expect(() => encodeBoardEntry({ ...base, payload: record(2) }, 2 as never)).toThrow(
      EncodeError,
    );
  });
});

describe("input checks", () => {
  const v = V.elections[0] as ElectionVector;

  test("refuses a registered key set listing a seat twice", () => {
    const e = electionOf(v);
    const twice = { ...e, registered: [...e.registered, ...e.registered.slice(0, 1)] };
    expect(() => checkDelivery(twice, ballotsOf(v), [], 1)).toThrow(RangeError);
  });

  test("refuses a ballot that didn't pass validity-shape and a seat outside the panel", () => {
    const [b] = ballotsOf(v) as [Extract<DeliveryBallot, { tier: number }>];
    const short = { ...b, vote: { ...b.vote, share_hashes: b.vote.share_hashes.slice(1) } };
    expect(() => checkDelivery(electionOf(v), [short], [], 1)).toThrow(RangeError);
    const e = electionOf(v);
    const bad = {
      ...e,
      registered: [{ ...(e.registered[0] as DeliveryElection["registered"][number]), index: 4 }],
    };
    expect(() => checkDelivery(bad, [b], [], 1)).toThrow(RangeError);
  });

  test("refuses an entry with no path, a bad segment or a submission time that isn't a bigint", () => {
    const e = electionOf(v);
    const b = ballotsOf(v);
    const payload = new Uint8Array(3);
    for (const bad of [
      { segment: 0, payload },
      { path: "board", segment: -1, payload },
      { path: "board", segment: 1.5, payload },
      { path: "contract", submittedAt: 5, payload },
      { path: "relay", submittedAt: 5n, payload },
    ])
      expect(() => checkDelivery(e, b, [bad as unknown as DeliveryEntry], 1)).toThrow(RangeError);
  });

  test("refuses segments and deadlines that aren't ordered bigints", () => {
    const e = electionOf(v);
    for (const bad of [
      { deadlines: { delivery: 1, complaint: 2 } },
      { segments: { delivery: undefined, complaint: 2n } },
      { segments: { delivery: -1n, complaint: 2n } },
      { segments: { delivery: 3n, complaint: 2n } },
      { deadlines: { delivery: 3n, complaint: 2n } },
    ])
      expect(() =>
        checkDelivery({ ...e, ...bad } as unknown as DeliveryElection, ballotsOf(v), [], 1),
      ).toThrow(RangeError);
  });

  test("the windows cover anchoring or forced inclusion, then a forced receipt or complaint", () => {
    const hour = 3600n;
    // Hourly periods, a 12-hour anchoring deadline, Base's 12-hour forced
    // inclusion plus an hour of missed slots, the 14-hour contract-event window
    // and an hour for L1 finality and the node's reaction.
    const deployed = {
      period: hour,
      deadline: 12n * hour,
      contractEventWindow: CONTRACT_EVENT_WINDOW,
      forcedInclusion: 13n * hour,
      margin: hour,
    };
    expect(deliveryWindowFits(deployed)).toBe(true);
    // Each term alone can break a bound.
    expect(deliveryWindowFits({ ...deployed, deadline: DELIVERY_WINDOW })).toBe(false);
    expect(deliveryWindowFits({ ...deployed, margin: DELIVERY_WINDOW })).toBe(false);
    expect(deliveryWindowFits({ ...deployed, contractEventWindow: DELIVERY_WINDOW })).toBe(false);
    // R counts once on top of both terms: the contract-event window alone now
    // needs W_C + R + F.
    expect(deliveryWindowFits({ ...deployed, contractEventWindow: 34n * hour })).toBe(true);
    expect(deliveryWindowFits({ ...deployed, contractEventWindow: 34n * hour + 1n })).toBe(false);
    // The anchoring term carries the ballot extent's fetch allowance A, 12
    // hours (docs/spec/availability.md, Windows): with W_C below it, the
    // anchoring clock now binds at 2 · period + deadline + A + R + F.
    expect(BALLOT_FETCH_ALLOWANCE).toBe(12n * hour);
    expect(deliveryWindowFits({ ...deployed, margin: 9n * hour })).toBe(true);
    expect(deliveryWindowFits({ ...deployed, margin: 9n * hour + 1n })).toBe(false);
    expect(deliveryWindowFits({ ...deployed, deadline: 20n * hour })).toBe(true);
    expect(deliveryWindowFits({ ...deployed, deadline: 20n * hour + 1n })).toBe(false);
    const delivery = DELIVERY_WINDOW - 27n * hour;
    expect(deliveryWindowFits({ ...deployed, forcedInclusion: delivery })).toBe(true);
    expect(deliveryWindowFits({ ...deployed, forcedInclusion: delivery + 1n })).toBe(false);
    // The complaint bound (W_C + F + R within the three days after the delivery
    // deadline) is checked too: nothing that breaks it passes.
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n * DELIVERY_WINDOW }),
        fc.bigInt({ min: 0n, max: 2n * DELIVERY_WINDOW }),
        fc.bigInt({ min: 0n, max: 2n * DELIVERY_WINDOW }),
        (contractEventWindow, forcedInclusion, margin) => {
          const c = { ...deployed, contractEventWindow, forcedInclusion, margin };
          const complaintFits =
            contractEventWindow + forcedInclusion + margin <= COMPLAINT_WINDOW - DELIVERY_WINDOW;
          if (!complaintFits) expect(deliveryWindowFits(c)).toBe(false);
        },
      ),
      { numRuns },
    );
    expect(() => deliveryWindowFits({ ...deployed, period: -1n })).toThrow(RangeError);
  });

  test("the intake cutoff is the delivery deadline less F and R: 34 hours after the close rule's deadline", () => {
    const hour = 3600n;
    const closesAt = 1_800_000_000n;
    const bound = 2n * hour;
    const constants = { forcedInclusion: 13n * hour, margin: hour };
    expect(intakeCutoff(closesAt, bound, constants)).toBe(
      deliveryDeadlines(closesAt, bound).delivery - 14n * hour,
    );
    expect(intakeCutoff(closesAt, bound, constants)).toBe(closesAt + bound + 34n * hour);
    expect(() => intakeCutoff(closesAt, bound, { ...constants, margin: -1n })).toThrow(RangeError);
    // F + R must leave the cutoff after closes_at + l1_inclusion_bound.
    expect(
      intakeCutoff(closesAt, bound, { forcedInclusion: DELIVERY_WINDOW - 1n, margin: 0n }),
    ).toBe(closesAt + bound + 1n);
    expect(() =>
      intakeCutoff(closesAt, bound, { forcedInclusion: DELIVERY_WINDOW - hour, margin: hour }),
    ).toThrow(RangeError);
  });

  test("refuses a close before the anchoring clock's epoch", () => {
    expect(() => deliverySegments({ epoch: 100n, period: 10n }, 50n, 0n)).toThrow(RangeError);
    expect(() => deliverySegments({ epoch: 0n, period: 0n }, 50n, 0n)).toThrow(RangeError);
  });
});

// --- Properties --------------------------------------------------------------

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Each run re-checks postings and complaints with ML-KEM, which is slow in
// JavaScript, so these properties scale their runs down.
const slowRuns = Math.max(10, Math.ceil(numRuns / 20));

describe("properties", () => {
  const multi = V.elections.find((e) => e.id === "three-ballots") as ElectionVector;
  const one = V.elections.find((e) => e.id === "all-receipted") as ElectionVector;

  test(
    "verdicts don't depend on the records' order or on duplicates (R3)",
    { timeout: 120_000 },
    () => {
      const entries = entriesOf(multi);
      const expected = verdicts(checkDelivery(electionOf(multi), ballotsOf(multi), entries, 1));
      fc.assert(
        fc.property(
          fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }),
          fc.array(fc.nat({ max: entries.length - 1 }), { maxLength: 4 }),
          (shuffled, dups) => {
            const all = [...shuffled, ...dups.map((i) => entries[i] as DeliveryEntry)];
            const r = checkDelivery(electionOf(multi), ballotsOf(multi), all, 1);
            expect(verdicts(r)).toEqual(expected);
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
            const r = checkDelivery(electionOf(one), ballotsOf(one), changed, 1);
            const [b] = r.ballots;
            // The record is rejected, set aside (another ballot or definition) or
            // reported; whichever, it no longer delivers its seat.
            expect(b?.delivered).toBe(false);
          },
        ),
        { numRuns },
      );
    },
  );

  test(
    "a passing posting delivers through the contract path and never through the board path",
    { timeout: 120_000 },
    () => {
      const fallback = V.elections.find((e) => e.id === "posting-fallback") as ElectionVector;
      const entries = entriesOf(fallback);
      const posting = entries.findIndex((e) => e.path === "contract");
      fc.assert(
        fc.property(fc.nat({ max: 1_000 }), (segment) => {
          const moved = entries.map((e, i) =>
            i === posting ? { path: "board" as const, segment, payload: e.payload } : e,
          );
          const r = checkDelivery(electionOf(fallback), ballotsOf(fallback), moved, 1);
          expect(r.ballots[0]?.missing).toEqual([3]);
          expect(r.rejected).toEqual([{ at: posting, error: "unexpected-record-type" }]);
        }),
        { numRuns: slowRuns },
      );
    },
  );

  test("random bytes decode as a delivery record only if they re-encode to themselves", () => {
    const kinds = Object.keys(decoders) as RecordKind[];
    const types = {
      "share-receipt": RECORD_TYPES.shareReceipt,
      "share-posting": RECORD_TYPES.sharePosting,
      "share-complaint": RECORD_TYPES.shareComplaint,
    };
    fc.assert(
      fc.property(fc.constantFrom(...kinds), fc.uint8Array({ maxLength: 300 }), (kind, body) => {
        const t = types[kind];
        const b = Uint8Array.of(t >> 8, t & 0xff, 1, ...body);
        let out: Uint8Array;
        try {
          out = decoders[kind](b);
        } catch (e) {
          if (e instanceof DecodeError) return;
          throw e;
        }
        expect(out).toEqual(b);
      }),
      { numRuns },
    );
  });

  test(
    "a vector posting with any byte changed decodes only if it re-encodes to itself",
    {
      timeout: 120_000,
    },
    () => {
      // Random bytes never reach a full-size posting, so mutate a real one.
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
});
