import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  batchShareComplaints,
  batchShareReceipts,
  COMPLAINT_BATCH_MAX,
  decodeShareComplaintBatch,
  encodeShareComplaintBatch,
  shareComplaintBatchStatement,
  checkDelivery,
  checkDeliveryV2,
  COMMITTED_VOTE,
  decode,
  DecodeError,
  decodeShareReceiptBatch,
  type DeliveryBallot,
  type DeliveryCheck,
  type DeliveryElection,
  type DeliveryEntry,
  EncodeError,
  encodeShareReceiptBatch,
  KEM_PUBLIC_KEY,
  RECEIPT_BATCH_MAX,
  RECORD_TYPES,
  type ReceiptPair,
  shareReceiptBatchStatement,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/delivery-batch.json comes from an independent Python
// implementation of the share-receipt batch and of the delivery check reading
// its pairs (scripts/delivery-batch-vectors.py, over delivery-vectors.py's
// P-256 ECDSA, ML-KEM, AEAD and ristretto255), so the expected bytes and
// verdicts never come from the code under test.

interface Report {
  readonly at: number;
  readonly pair?: number;
  readonly code: string;
  readonly signer?: number | null;
}

interface ElectionVector {
  readonly id: string;
  readonly registered: readonly number[];
  readonly segments: { readonly delivery: string; readonly complaint: string };
  readonly deadlines: { readonly delivery: string; readonly complaint: string };
  readonly ballots: readonly {
    readonly tier: number;
    readonly nullifier: string;
    readonly committedVote: string;
  }[];
  readonly entries: readonly (
    | { readonly path: "board"; readonly segment: number; readonly payload: string }
    | { readonly path: "contract"; readonly submittedAt: string; readonly payload: string }
  )[];
  readonly result: {
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
    readonly records: readonly Report[];
    readonly rejected: readonly { readonly at: number; readonly error: string }[];
  };
}

interface Vectors {
  readonly format: string;
  readonly tag: string;
  readonly maxPairs: number;
  readonly definitionHash: string;
  readonly panel: readonly {
    readonly seat: number;
    readonly kemKey: string;
    readonly signingSecret: string;
    readonly signingKey: string;
  }[];
  readonly records: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly seat: number;
    readonly count: number;
    readonly pairs?: readonly { readonly ballotHash: string; readonly shareHash: string }[];
    readonly statement?: string;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
  readonly complaintTag: string;
  readonly maxComplaints: number;
  readonly complaintRecords: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly seat: number;
    readonly count: number;
    readonly statement: string;
  }[];
  readonly complaintDecode: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
  readonly elections: readonly ElectionVector[];
}

const V = JSON.parse(readFileSync(new URL("delivery-batch.json", SPEC_VECTORS), "utf8")) as Vectors;
const bytesHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const DEFINITION = hex(V.definitionHash);
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const secretOf = (seat: number) => {
  const s = V.panel.find((p) => p.seat === seat)?.signingSecret;
  if (s === undefined) throw new Error(`no seat ${seat}`);
  return hex(s);
};

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
    deadlines: { delivery: BigInt(v.deadlines.delivery), complaint: BigInt(v.deadlines.complaint) },
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

function asJson(r: DeliveryCheck): ElectionVector["result"] {
  return {
    ballots: r.ballots.map((b) => ({
      ballotHash: bytesHex(b.ballotHash),
      counted: b.counted,
      delivered: b.delivered,
      missing: [...b.missing],
      excludedBy: b.excludedBy.map((c) => ({ ...c })),
    })),
    records: r.records.map((x) => ({ ...x })),
    rejected: r.rejected.map(({ at, error }) => ({ at, error })),
  };
}

const run = (v: ElectionVector, entries = entriesOf(v)) =>
  checkDelivery(electionOf(v), ballotsOf(v), entries, 1);

describe("share-receipt batch vectors (docs/spec/vectors/delivery-batch.json)", () => {
  test("file format, tag, maximum and record type", () => {
    expect(V.format).toBe("abolish-delivery-batch-vectors/1");
    expect(V.tag).toBe("abolish/v1/sig/share-receipt-batch");
    expect(V.maxPairs).toBe(RECEIPT_BATCH_MAX);
    expect(RECORD_TYPES.shareReceiptBatch).toBe(0x0016);
  });

  test.each(V.records.map((r) => [r.id, r] as const))(
    "%s decodes, re-encodes and is re-made from the seat's secret (RFC 6979)",
    (_id, r) => {
      const b = decodeShareReceiptBatch(hex(r.encoding), 1);
      expect(bytesHex(encodeShareReceiptBatch(b))).toBe(r.encoding);
      expect(b.seat).toBe(r.seat);
      expect(b.receipts.length).toBe(r.count);
      expect(hex(r.encoding).length).toBe(104 + 64 * r.count);
      if (r.statement !== undefined) {
        expect(bytesHex(shareReceiptBatchStatement(b))).toBe(r.statement);
        expect(r.encoding.slice(6, -128)).toBe(r.statement);
      }
      if (r.pairs !== undefined)
        expect(
          b.receipts.map((p) => ({
            ballotHash: bytesHex(p.ballot_hash),
            shareHash: bytesHex(p.share_hash),
          })),
        ).toEqual(r.pairs);
      // The node's batching sorts its receipts and signs each batch; given
      // them in reverse, it makes the same record.
      const [made] = batchShareReceipts(
        secretOf(r.seat),
        DEFINITION,
        r.seat,
        [...b.receipts].reverse(),
      );
      if (made === undefined) throw new Error("no batch");
      expect(bytesHex(encodeShareReceiptBatch(made))).toBe(r.encoding);
    },
  );

  test("the complaint batch's tag, maximum and record type", () => {
    expect(V.complaintTag).toBe("abolish/v1/sig/share-complaint-batch");
    expect(V.maxComplaints).toBe(COMPLAINT_BATCH_MAX);
    expect(RECORD_TYPES.shareComplaintBatch).toBe(0x0017);
  });

  test.each(V.complaintRecords.map((r) => [r.id, r] as const))(
    "complaint batch %s decodes, re-encodes and is re-made from the seat's secret (RFC 6979)",
    (_id, r) => {
      const b = decodeShareComplaintBatch(hex(r.encoding), 1);
      expect(bytesHex(encodeShareComplaintBatch(b))).toBe(r.encoding);
      expect(b.seat).toBe(r.seat);
      expect(b.complaints.length).toBe(r.count);
      expect(bytesHex(shareComplaintBatchStatement(b))).toBe(r.statement);
      const [made] = batchShareComplaints(
        secretOf(r.seat),
        DEFINITION,
        r.seat,
        [...b.complaints].reverse(),
      );
      if (made === undefined) throw new Error("no batch");
      expect(bytesHex(encodeShareComplaintBatch(made))).toBe(r.encoding);
    },
  );

  test.each(V.complaintDecode.map((v) => [v.id, v] as const))(
    "rejects complaint batch %s",
    (_id, v) => {
      let err: unknown;
      try {
        decodeShareComplaintBatch(hex(v.encoding), 1);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DecodeError);
      expect({ code: (err as DecodeError).code, offset: (err as DecodeError).offset }).toEqual({
        code: v.error,
        offset: v.offset,
      });
    },
  );

  test.each(V.decode.map((v) => [v.id, v] as const))("rejects %s", (_id, v) => {
    let err: unknown;
    try {
      decodeShareReceiptBatch(hex(v.encoding), 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeError);
    expect({ code: (err as DecodeError).code, offset: (err as DecodeError).offset }).toEqual({
      code: v.error,
      offset: v.offset,
    });
  });

  test.each(V.elections.map((v) => [v.id, v] as const))("election %s", (_id, v) => {
    expect(asJson(run(v))).toEqual(v.result);
  });

  test("under ballot version 4 every batch is a rejected entry (profile-mismatch)", () => {
    const v = V.elections.find((e) => e.id === "batches-deliver");
    if (v === undefined) throw new Error("no election");
    const r = checkDeliveryV2(
      {
        definitionHash: DEFINITION,
        panelSize: 3,
        authorPanelSize: 0,
        registered: { default: electionOf(v).registered, author: [] },
        segments: electionOf(v).segments,
        deadlines: electionOf(v).deadlines,
      },
      [],
      entriesOf(v),
    );
    expect(r.rejected).toEqual(entriesOf(v).map((_, at) => ({ at, error: "profile-mismatch" })));
  });
});

describe("share-receipt batch encoding", () => {
  const pair = (i: number): ReceiptPair => ({
    ballot_hash: Uint8Array.from({ length: 32 }, (_, j) =>
      j === 0 ? i >> 8 : j === 1 ? i & 255 : 7,
    ),
    share_hash: new Uint8Array(32).fill(i & 255),
  });

  test("a node's receipts are cut into batches of at most RECEIPT_BATCH_MAX, in ballot-hash order", () => {
    const receipts = Array.from({ length: RECEIPT_BATCH_MAX + 5 }, (_, i) =>
      pair(RECEIPT_BATCH_MAX + 4 - i),
    );
    const batches = batchShareReceipts(secretOf(1), DEFINITION, 1, receipts);
    expect(batches.map((b) => b.receipts.length)).toEqual([RECEIPT_BATCH_MAX, 5]);
    const all = batches.flatMap((b) => b.receipts.map((p) => bytesHex(p.ballot_hash)));
    expect(all).toEqual([...all].sort());
    for (const b of batches)
      expect(decodeShareReceiptBatch(encodeShareReceiptBatch(b), 1)).toEqual(b);
  });

  test("a repeated ballot hash, an empty or oversized batch and unordered pairs never encode", () => {
    expect(() => batchShareReceipts(secretOf(1), DEFINITION, 1, [pair(1), pair(1)])).toThrow(
      RangeError,
    );
    const [b] = batchShareReceipts(secretOf(1), DEFINITION, 1, [pair(1), pair(2)]);
    if (b === undefined) throw new Error("no batch");
    expect(() => encodeShareReceiptBatch({ ...b, receipts: [] })).toThrow(EncodeError);
    expect(() => encodeShareReceiptBatch({ ...b, receipts: [pair(2), pair(1)] })).toThrow(
      EncodeError,
    );
    const over = Array.from({ length: RECEIPT_BATCH_MAX + 1 }, (_, i) => pair(i));
    expect(() => encodeShareReceiptBatch({ ...b, receipts: over })).toThrow(EncodeError);
  });

  // R3: a batch's verdicts don't depend on the order of the records.
  test("shuffling an election's records changes no ballot's verdict", () => {
    const elections = V.elections.filter((e) => e.result.rejected.length === 0);
    fc.assert(
      fc.property(
        fc.nat({ max: elections.length - 1 }),
        fc.array(fc.nat(), { minLength: 0, maxLength: 16 }),
        (which, swaps) => {
          const v = elections[which] as ElectionVector;
          const entries = entriesOf(v).map((e) => ({ ...e }));
          // Board-path segments stay with their records; the check reads no order.
          for (const s of swaps) {
            const i = s % entries.length;
            const j = (s >> 4) % entries.length;
            [entries[i], entries[j]] = [entries[j] as DeliveryEntry, entries[i] as DeliveryEntry];
          }
          const a = run(v).ballots.map((b) => [b.counted, b.missing]);
          const b = run(v, entries).ballots.map((x) => [x.counted, x.missing]);
          expect(b).toEqual(a);
        },
      ),
      { numRuns },
    );
  });

  // One encoding per batch (T-31): any sorted set of pairs round-trips, and
  // any bytes either fail to decode or re-encode to themselves.
  test("decode(encode(x)) = x, and every decodable input is its own encoding", () => {
    const hash = fc.uint8Array({ minLength: 32, maxLength: 32 });
    const [base] = batchShareReceipts(secretOf(1), DEFINITION, 1, [pair(1)]);
    if (base === undefined) throw new Error("no batch");
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ ballot_hash: hash, share_hash: hash }), {
          minLength: 1,
          maxLength: 8,
          selector: (p) => bytesHex(p.ballot_hash),
        }),
        (pairs) => {
          const receipts = [...pairs].sort((a, b) =>
            bytesHex(a.ballot_hash).localeCompare(bytesHex(b.ballot_hash)),
          );
          const enc = encodeShareReceiptBatch({ ...base, receipts });
          expect(decodeShareReceiptBatch(enc, 1)).toEqual({ ...base, receipts });
        },
      ),
      { numRuns },
    );
    const honest = hex((V.records[1] as Vectors["records"][number]).encoding);
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 300 }),
          fc.tuple(fc.nat(), fc.integer({ min: 1, max: 255 })).map(([at, x]) => {
            const b = Uint8Array.from(honest);
            b[at % b.length] = ((b[at % b.length] as number) ^ x) & 255;
            return b;
          }),
        ),
        (bytes) => {
          let decoded;
          try {
            decoded = decodeShareReceiptBatch(bytes, 1);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            return;
          }
          expect(bytesHex(encodeShareReceiptBatch(decoded))).toBe(bytesHex(bytes));
        },
      ),
      { numRuns },
    );
  });
});
