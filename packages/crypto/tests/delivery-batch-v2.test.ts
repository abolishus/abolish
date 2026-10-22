import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { checkDeliveryV2With } from "../src/delivery.ts";
import {
  batchShareComplaintsV2,
  batchShareReceiptsV2,
  buildObligationRootV2,
  checkDeliveryV2,
  COMMITTED_VOTE_V4,
  COMPLAINT_BATCH_MAX,
  COMPLAINT_PROOF,
  type ComplaintEntry,
  decode,
  DecodeError,
  decodeObligationRoot,
  decodeShareComplaintBatch,
  decodeShareReceiptBatch,
  type DeliveryBallotV4,
  type DeliveryCheckV2,
  type DeliveryElectionV2,
  type DeliveryEntry,
  type DeliveryRootsV2,
  EncodeError,
  encodeObligationRootV2,
  encodeShareComplaintBatchV2,
  encodeShareReceiptBatchV2,
  KEM_PUBLIC_KEY,
  OBLIGATION_ROOT_LENGTH_V2,
  obligationRootHash,
  obligationRootStatementV2,
  type ObligationRootKind,
  type ObligationRootRecordV2,
  RECEIPT_BATCH_MAX,
  type ReceiptPair,
  SEAT_PANELS,
  type SeatPanel,
  shareComplaintBatchStatementV2,
  shareReceiptBatchStatementV2,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/delivery-batch-v2.json comes from an independent Python
// implementation of the version-2 batches and root and of the delivery check
// reading them over both panels (scripts/delivery-batch-v2-vectors.py, over
// delivery-batch-vectors.py's and delivery-v2-vectors.py's P-256 ECDSA,
// ML-KEM, AEAD and ristretto255), so the expected bytes and verdicts never
// come from the code under test. Elections with an author panel run through
// the internal `checkDeliveryV2With`, as delivery-v2.test.ts explains: the
// vectors carry no author run.

type RecordKind = "share-receipt-batch" | "share-complaint-batch" | "obligation-root";

interface Seat {
  readonly panel: number;
  readonly seat: number;
}

type Part = { readonly pair?: number; readonly leaf?: number };

interface Decided {
  readonly ballots: readonly {
    readonly ballotHash: string;
    readonly counted: boolean;
    readonly delivered: boolean;
    readonly missing: readonly Seat[];
    readonly excludedBy: readonly (Seat &
      Part & { readonly at: number; readonly signer: number | null })[];
  }[];
  readonly records: readonly (Seat &
    Part & {
      readonly at: number;
      readonly code: string;
      readonly signer?: number | null;
      readonly namedBy?: readonly number[];
      readonly attestedWithout?: readonly number[];
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
  readonly thresholds: { readonly default: number; readonly author: number };
  readonly bound: number;
  readonly segments: { readonly delivery: string; readonly complaint: string };
  readonly deadlines: { readonly delivery: string; readonly complaint: string };
  readonly ballots: readonly {
    readonly cell: number;
    readonly nullifier: string;
    readonly committedVote: string;
  }[];
  readonly entries: readonly (
    | { readonly path: "board"; readonly segment: number; readonly payload: string }
    | { readonly path: "contract"; readonly submittedAt: string; readonly payload: string }
  )[];
  readonly attestations: readonly (Seat & { readonly roots: readonly string[] })[];
  readonly leafObjects: readonly { readonly cid: string; readonly bytes: string }[];
  readonly result: Decided | { readonly unverifiable: readonly { readonly at: number }[] };
}

interface SeatVector {
  readonly seat: number;
  readonly kemKey: string;
  readonly signingSecret: string;
  readonly signingKey: string;
}

interface Vectors {
  readonly format: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly maxPairs: number;
  readonly maxComplaints: number;
  readonly panels: { readonly default: number; readonly author: number };
  readonly seats: {
    readonly default: readonly SeatVector[];
    readonly author: readonly SeatVector[];
  };
  readonly records: readonly {
    readonly id: string;
    readonly type: RecordKind;
    readonly encoding: string;
    readonly panel: SeatPanel;
    readonly seat: number;
    readonly statement: string;
    readonly count: number;
    readonly kind?: ObligationRootKind;
    readonly root?: string;
    readonly leavesCid?: string;
    readonly recordHash?: string;
    readonly leafObject?: string;
  }[];
  readonly limits: readonly {
    readonly encoding: string;
    readonly count: number;
    readonly root?: string;
    readonly leavesCid?: string;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly type: RecordKind;
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
  readonly elections: readonly ElectionVector[];
}

const V = JSON.parse(
  readFileSync(new URL("delivery-batch-v2.json", SPEC_VECTORS), "utf8"),
) as Vectors;
const bytesHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Each run is a whole delivery check, its P-256, ML-KEM and ristretto255
// checks in JavaScript, so the property that runs it scales its runs down.
const slowRuns = Math.max(10, Math.ceil(numRuns / 20));

const recode: Readonly<Record<RecordKind, (b: Uint8Array) => Uint8Array>> = {
  "share-receipt-batch": (b) => encodeShareReceiptBatchV2(decodeShareReceiptBatch(b, 2)),
  "share-complaint-batch": (b) => encodeShareComplaintBatchV2(decodeShareComplaintBatch(b, 2)),
  "obligation-root": (b) => encodeObligationRootV2(decodeObligationRoot(b, 2)),
};

const seatsOf = (panel: SeatPanel) =>
  panel === SEAT_PANELS.author ? V.seats.author : V.seats.default;

const secretOf = (panel: SeatPanel, seat: number) => {
  const s = seatsOf(panel).find((p) => p.seat === seat)?.signingSecret;
  if (s === undefined) throw new Error(`no seat ${panel}:${seat}`);
  return hex(s);
};

function keysOf(panel: SeatPanel, registered: readonly number[]) {
  return registered.map((seat) => {
    const p = seatsOf(panel).find((x) => x.seat === seat);
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
      default: keysOf(SEAT_PANELS.default, v.registered),
      author: keysOf(SEAT_PANELS.author, v.authorRegistered),
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

// Every leaf object here is one raw block: a source answers its CID with the
// bytes it holds, which hash to it or, where the file says so, don't. The
// check takes only attestations that count, as `checkDelivery` does, so one
// the file lists from a seat outside its panel's key set, which the board
// refuses (availability-seat) and which decides nothing in its election, is
// left out.
const rootsOf = (v: ElectionVector): DeliveryRootsV2 => ({
  bound: BigInt(v.bound),
  thresholds: v.thresholds,
  attestations: v.attestations
    .filter((a) =>
      (a.panel === SEAT_PANELS.author ? v.authorRegistered : v.registered).includes(a.seat),
    )
    .map((a) => ({
      panel: a.panel as SeatPanel,
      seat: a.seat,
      roots: a.roots.map(hex),
    })),
  leafBlocks: (cid) =>
    v.leafObjects.filter((o) => o.cid === bytesHex(cid)).map((o) => hex(o.bytes)),
});

function asJson(r: DeliveryCheckV2): ElectionVector["result"] {
  if (r.unverifiable.length > 0) return { unverifiable: r.unverifiable.map((u) => ({ ...u })) };
  return {
    ballots: r.ballots.map((b) => ({
      ballotHash: bytesHex(b.ballotHash),
      counted: b.counted,
      delivered: b.delivered,
      missing: b.missing.map(({ panel, seat }) => ({ panel, seat })),
      excludedBy: b.excludedBy.map((c) => ({ ...c })),
    })),
    records: r.records.map((x) => ({ ...x })),
    rejected: r.rejected.map(({ at, error }) => ({ at, error })),
  };
}

const run = (v: ElectionVector, entries = entriesOf(v)) =>
  checkDeliveryV2With(electionOf(v), ballotsOf(v), entries, rootsOf(v));

const electionById = (id: string) => {
  const v = V.elections.find((e) => e.id === id);
  if (v === undefined) throw new Error(`no election ${id}`);
  return v;
};

// The leaves of a leaf object as the node's builder takes them.
function owedOf(kind: ObligationRootKind, object: Uint8Array) {
  const size = kind === 1 ? 64 : 128;
  const parts = Array.from({ length: object.length / size }, (_, j) =>
    object.subarray(size * j, size * (j + 1)),
  );
  return kind === 1
    ? {
        kind: 1 as const,
        leaves: parts.map((b): ReceiptPair => ({
          ballot_hash: b.subarray(0, 32),
          share_hash: b.subarray(32),
        })),
      }
    : {
        kind: 2 as const,
        leaves: parts.map((b): ComplaintEntry => ({
          ballot_hash: b.subarray(0, 32),
          proof: decode(COMPLAINT_PROOF, b.subarray(32)),
        })),
      };
}

describe("version-2 batches and roots (delivery-batch-v2.json)", () => {
  test("file format, tags, panels and bounds", () => {
    expect(V.format).toBe("abolish-delivery-batch-vectors/2");
    expect(V.tags).toEqual({
      receiptBatch: "abolish/v1/sig/share-receipt-batch-2",
      complaintBatch: "abolish/v1/sig/share-complaint-batch-2",
      root: "abolish/v1/sig/obligation-root-2",
      recordHash: "abolish/v1/obligation-root",
      leaf: "abolish/v1/obligation/leaf",
      node: "abolish/v1/obligation/node",
    });
    expect(V.panels).toEqual(SEAT_PANELS);
    expect([V.maxPairs, V.maxComplaints]).toEqual([RECEIPT_BATCH_MAX, COMPLAINT_BATCH_MAX]);
  });

  test.each(V.records.map((r) => [r.id, r] as const))(
    "%s decodes, re-encodes and states its statement",
    (_id, r) => {
      const b = hex(r.encoding);
      expect(bytesHex(recode[r.type](b))).toBe(r.encoding);
      if (r.type === "share-receipt-batch") {
        const d = decodeShareReceiptBatch(b, 2);
        expect([d.panel, d.seat, d.receipts.length]).toEqual([r.panel, r.seat, r.count]);
        expect(bytesHex(shareReceiptBatchStatementV2(d))).toBe(r.statement);
        expect(b.length).toBe(105 + 64 * r.count);
      } else if (r.type === "share-complaint-batch") {
        const d = decodeShareComplaintBatch(b, 2);
        expect([d.panel, d.seat, d.complaints.length]).toEqual([r.panel, r.seat, r.count]);
        expect(bytesHex(shareComplaintBatchStatementV2(d))).toBe(r.statement);
        expect(b.length).toBe(105 + 128 * r.count);
      } else {
        const d = decodeObligationRoot(b, 2);
        expect([d.panel, d.seat, d.kind, d.count]).toEqual([r.panel, r.seat, r.kind, r.count]);
        expect([bytesHex(d.root), bytesHex(d.leaves_cid)]).toEqual([r.root, r.leavesCid]);
        expect(bytesHex(obligationRootStatementV2(d))).toBe(r.statement);
        expect(bytesHex(obligationRootHash(b))).toBe(r.recordHash);
        expect(b.length).toBe(OBLIGATION_ROOT_LENGTH_V2);
      }
    },
  );

  test.each(V.records.map((r) => [r.id, r] as const))(
    "%s is re-made byte for byte from its seat's signing secret (RFC 6979)",
    (_id, r) => {
      const b = hex(r.encoding);
      const secret = secretOf(r.panel, r.seat);
      let made: Uint8Array[];
      if (r.type === "share-receipt-batch") {
        const d = decodeShareReceiptBatch(b, 2);
        // Given out of order, as a node's store may hold them.
        made = batchShareReceiptsV2(
          secret,
          d.definition_hash,
          d.panel,
          d.seat,
          [...d.receipts].reverse(),
        ).map(encodeShareReceiptBatchV2);
      } else if (r.type === "share-complaint-batch") {
        const d = decodeShareComplaintBatch(b, 2);
        made = batchShareComplaintsV2(
          secret,
          d.definition_hash,
          d.panel,
          d.seat,
          [...d.complaints].reverse(),
        ).map(encodeShareComplaintBatchV2);
      } else {
        const d = decodeObligationRoot(b, 2);
        if (r.leafObject === undefined) throw new Error("no leaf object");
        const built = buildObligationRootV2(
          secret,
          d.definition_hash,
          d.panel,
          d.seat,
          owedOf(d.kind, hex(r.leafObject)),
        );
        expect(bytesHex(built.leafObject)).toBe(r.leafObject);
        made = [encodeObligationRootV2(built.record)];
      }
      expect(made.map(bytesHex)).toEqual([r.encoding]);
    },
  );

  test("the limits: a batch of RECEIPT_BATCH_MAX pairs and a root over a 1 MiB raw block", () => {
    for (const l of V.limits) {
      const b = hex(l.encoding);
      const type = ((b[0] as number) << 8) | (b[1] as number);
      if (type === 0x0016) {
        expect(decodeShareReceiptBatch(b, 2).receipts.length).toBe(l.count);
        expect(b.length).toBe(105 + 64 * RECEIPT_BATCH_MAX);
        expect(bytesHex(encodeShareReceiptBatchV2(decodeShareReceiptBatch(b, 2)))).toBe(l.encoding);
      } else {
        const d = decodeObligationRoot(b, 2);
        expect([d.count, bytesHex(d.root), bytesHex(d.leaves_cid)]).toEqual([
          l.count,
          l.root,
          l.leavesCid,
        ]);
        expect(bytesHex(encodeObligationRootV2(d))).toBe(l.encoding);
      }
    }
  });

  test.each(V.decode.map((v) => [v.id, v] as const))("rejects %s", (_id, v) => {
    let err: unknown;
    try {
      recode[v.type](hex(v.encoding));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeError);
    expect({ code: (err as DecodeError).code, offset: (err as DecodeError).offset }).toEqual({
      code: v.error,
      offset: v.offset,
    });
  });

  test("version 1 and version 2 records never decode as each other", () => {
    const v1: Readonly<Record<RecordKind, (b: Uint8Array) => unknown>> = {
      "share-receipt-batch": (b) => decodeShareReceiptBatch(b, 1),
      "share-complaint-batch": (b) => decodeShareComplaintBatch(b, 1),
      "obligation-root": (b) => decodeObligationRoot(b, 1),
    };
    for (const r of V.records)
      expect(() => v1[r.type](hex(r.encoding)), r.id).toThrow(
        expect.objectContaining({ code: "profile-mismatch" }) as Error,
      );
  });

  test.each(V.elections.map((v) => [v.id, v] as const))(
    "delivery check %s",
    { timeout: 60_000 },
    (_id, v) => {
      expect(asJson(run(v))).toEqual(v.result);
    },
  );

  test("the file covers every root and batch code, both panels and a poll without an author panel", () => {
    const records = V.elections.flatMap((e) => ("records" in e.result ? e.result.records : []));
    for (const code of [
      "delivery-stray",
      "delivery-seat",
      "delivery-late",
      "share-receipt",
      "complaint-void",
      "complaint-proof",
      "complaint-unfounded",
      "receipt-contradicted",
      "root-signature",
      "root-repeat",
      "root-count",
      "root-withheld",
      "root-inconsistent",
    ])
      expect(new Set(records.map((r) => r.code)), code).toContain(code);
    expect(new Set(records.map((r) => r.panel))).toEqual(
      new Set([SEAT_PANELS.default, SEAT_PANELS.author]),
    );
    expect(V.elections.some((e) => "unverifiable" in e.result)).toBe(true);
    expect(V.elections.some((e) => e.authorPanelSize === 0)).toBe(true);
  });

  test("verdicts don't depend on the order of the entries", { timeout: 120_000 }, () => {
    const v = electionById("three-ballots");
    const verdicts = (r: DeliveryCheckV2) =>
      r.ballots.map((b) => ({
        counted: b.counted,
        missing: b.missing.map(({ panel, seat }) => `${panel}:${seat}`),
        excludedBy: [...new Set(b.excludedBy.map((c) => `${c.panel}:${c.seat}`))].sort(),
      }));
    const expected = verdicts(run(v));
    const entries = entriesOf(v);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(
          entries.map((_, i) => i),
          { minLength: entries.length },
        ),
        (order) => {
          expect(
            verdicts(
              run(
                v,
                order.map((i) => entries[i] as DeliveryEntry),
              ),
            ),
          ).toEqual(expected);
        },
      ),
      { numRuns: slowRuns },
    );
  });
});

describe("the exported version-2 check reads batches and roots", () => {
  test("a poll without an author panel", () => {
    const v = electionById("batch-no-author-panel");
    const r = checkDeliveryV2(electionOf(v), ballotsOf(v), entriesOf(v), undefined, rootsOf(v));
    expect(asJson(r)).toEqual(v.result);
  });

  test("without the roots' sources, a root that may deliver leaves the counted set undecided", () => {
    const v = electionById("roots");
    const r = checkDeliveryV2With(electionOf(v), ballotsOf(v), entriesOf(v));
    expect(r.ballots).toEqual([]);
    expect(r.unverifiable.length).toBeGreaterThan(0);
  });

  test("an attestation of the other panel's seat, or two of one seat, is refused", () => {
    const v = electionById("roots");
    const roots = rootsOf(v);
    const [first] = roots.attestations;
    if (first === undefined) throw new Error("no attestation");
    const twice = { ...roots, attestations: [...roots.attestations, first] };
    expect(() => checkDeliveryV2With(electionOf(v), ballotsOf(v), entriesOf(v), twice)).toThrow(
      RangeError,
    );
    const none = electionById("batch-no-author-panel");
    const author = {
      ...rootsOf(none),
      attestations: [{ panel: SEAT_PANELS.author, seat: 1, roots: [] }],
    };
    expect(() =>
      checkDeliveryV2With(electionOf(none), ballotsOf(none), entriesOf(none), author),
    ).toThrow(RangeError);
    const lowThreshold = { ...roots, thresholds: { ...roots.thresholds, author: 0 } };
    expect(() =>
      checkDeliveryV2With(electionOf(v), ballotsOf(v), entriesOf(v), lowThreshold),
    ).toThrow(RangeError);
  });

  test("each root is judged by its own panel's threshold", () => {
    // Every author seat named every author root in `roots`; with the author
    // threshold at its most, one author seat's attestation alone makes none
    // available, whatever the default seats name.
    const v = electionById("roots");
    const roots = rootsOf(v);
    const one = {
      ...roots,
      thresholds: { ...roots.thresholds, author: v.authorRegistered.length },
      attestations: roots.attestations.filter(
        (a) => a.panel === SEAT_PANELS.default || a.seat === 1,
      ),
    };
    const r = checkDeliveryV2With(electionOf(v), ballotsOf(v), entriesOf(v), one);
    expect(r.ballots.every((b) => b.counted)).toBe(true);
    const fewer = {
      ...one,
      thresholds: { ...one.thresholds, author: 1 },
    };
    const withheld = checkDeliveryV2With(electionOf(v), ballotsOf(v), entriesOf(v), fewer);
    expect(new Set(withheld.records.map((x) => [x.code, x.panel].join(":")))).toEqual(
      new Set(["root-withheld:2"]),
    );
  });
});

describe("version-2 batch and root encoding", () => {
  const byte32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
  const panel = fc.constantFrom<SeatPanel>(SEAT_PANELS.default, SEAT_PANELS.author);
  const honestRoot = decodeObligationRoot(
    hex(V.records.find((r) => r.type === "obligation-root")?.encoding ?? ""),
    2,
  );
  const honestBatch = decodeShareReceiptBatch(
    hex(V.records.find((r) => r.type === "share-receipt-batch")?.encoding ?? ""),
    2,
  );

  const root = fc
    .record({
      definition_hash: byte32,
      panel,
      seat: fc.integer({ min: 0, max: 255 }),
      kind: fc.constantFrom<ObligationRootKind>(1, 2),
      count: fc.oneof(fc.integer({ min: 1, max: 0xffffffff }), fc.constantFrom(1, 16384, 16385)),
      root: byte32,
      digest: byte32,
    })
    .map(({ digest, ...r }): ObligationRootRecordV2 => ({
      ...r,
      leaves_cid: Uint8Array.from([
        0x01,
        (r.kind === 1 ? 64 : 128) * r.count <= 1_048_576 ? 0x55 : 0x70,
        0x12,
        0x20,
        ...digest,
      ]),
      signature: honestRoot.signature,
    }));

  test("roots: decode(encode(x)) = x", () => {
    fc.assert(
      fc.property(root, (r) => {
        expect(decodeObligationRoot(encodeObligationRootV2(r), 2)).toEqual(r);
      }),
      { numRuns },
    );
  });

  test("receipt batches: decode(encode(x)) = x over sorted, distinct pairs", () => {
    const pairs = fc
      .uniqueArray(fc.tuple(byte32, byte32), {
        minLength: 1,
        maxLength: 20,
        selector: ([b]) => bytesHex(b),
      })
      .map((ps) =>
        ps
          .map(([ballot_hash, share_hash]) => ({ ballot_hash, share_hash }))
          .sort((a, b) => Buffer.compare(a.ballot_hash, b.ballot_hash)),
      );
    fc.assert(
      fc.property(byte32, panel, fc.integer({ min: 0, max: 255 }), pairs, (d, p, seat, rs) => {
        const record = {
          definition_hash: d,
          panel: p,
          seat,
          receipts: rs,
          signature: honestBatch.signature,
        };
        expect(decodeShareReceiptBatch(encodeShareReceiptBatchV2(record), 2)).toEqual(record);
      }),
      { numRuns },
    );
  });

  test.each(V.records.map((r) => [r.id, r] as const))(
    "random changes to %s are rejected or re-encode to themselves",
    (_id, r) => {
      const bytes = hex(r.encoding);
      const mutated = fc
        .tuple(fc.nat({ max: bytes.length - 1 }), fc.integer({ min: 0, max: 255 }), fc.nat(8))
        .map(([at, value, cut]) => {
          const b = bytes.slice(0, bytes.length - cut);
          if (at < b.length) b[at] = value;
          return b;
        });
      fc.assert(
        fc.property(mutated, (b) => {
          let out: Uint8Array;
          try {
            out = recode[r.type](b);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            return;
          }
          expect(out).toEqual(b);
        }),
        { numRuns },
      );
    },
    // CI's FC_NUM_RUNS=1000 decodes a full batch per run: seconds on a shared runner.
    60_000,
  );

  test("never encodes what it can't decode", () => {
    expect(() => encodeObligationRootV2({ ...honestRoot, panel: 3 as SeatPanel })).toThrow(
      EncodeError,
    );
    expect(() => encodeObligationRootV2({ ...honestRoot, count: 0 })).toThrow(EncodeError);
    expect(() => obligationRootStatementV2({ ...honestRoot, count: 2 ** 32 })).toThrow(EncodeError);
    expect(() => encodeShareReceiptBatchV2({ ...honestBatch, receipts: [] })).toThrow(EncodeError);
    expect(() => encodeShareReceiptBatchV2({ ...honestBatch, panel: 0 as SeatPanel })).toThrow(
      EncodeError,
    );
  });

  test("a node's builders refuse a ballot hash twice and cut at the batch maximum", () => {
    const secret = secretOf(SEAT_PANELS.author, 1);
    const d = new Uint8Array(32);
    const pair = (i: number): ReceiptPair => ({
      ballot_hash: Uint8Array.from({ length: 32 }, (_, j) =>
        j === 0 ? i >> 8 : j === 1 ? i & 255 : 0,
      ),
      share_hash: new Uint8Array(32).fill(i & 255),
    });
    expect(() =>
      batchShareReceiptsV2(secret, d, SEAT_PANELS.author, 1, [pair(1), pair(1)]),
    ).toThrow(RangeError);
    const batches = batchShareReceiptsV2(
      secret,
      d,
      SEAT_PANELS.author,
      1,
      Array.from({ length: RECEIPT_BATCH_MAX + 1 }, (_, i) => pair(i)),
    );
    expect(batches.map((b) => [b.panel, b.receipts.length])).toEqual([
      [SEAT_PANELS.author, RECEIPT_BATCH_MAX],
      [SEAT_PANELS.author, 1],
    ]);
    expect(() =>
      buildObligationRootV2(secret, d, SEAT_PANELS.author, 1, { kind: 1, leaves: [] }),
    ).toThrow(RangeError);
  });
});
