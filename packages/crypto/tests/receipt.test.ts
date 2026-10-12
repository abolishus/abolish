import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type BoardEntryVersion,
  BOARD_TREE,
  boardEntryHash,
  chainLink,
  checkReceiptAtCast,
  decodeReceipt,
  DecodeError,
  encodeBoardEntry,
  encodeReceipt,
  identityKey,
  inclusionProof,
  merkleRoot,
  type Receipt,
  receiptStatement,
  signReceipt,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/receipt.json comes from an independent Python
// implementation (scripts/receipt-vectors.py), so these expected values never
// come from the code under test.

interface ReceiptVectors {
  readonly format: string;
  readonly tag: string;
  readonly electionId: string;
  readonly receiptKeys: readonly string[];
  readonly receipts: readonly {
    readonly id: string;
    readonly secretKey: string;
    readonly electionId: string;
    readonly index: string;
    readonly segment: number;
    readonly entryHash: string;
    readonly link: string;
    readonly root: string;
    readonly operatorKey: string;
    readonly signature: string;
    readonly inclusion: readonly string[];
    readonly statement: string;
    readonly encoding: string;
  }[];
  readonly decodeErrors: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
  readonly atCast: readonly {
    readonly id: string;
    readonly receipt: string;
    readonly electionId: string;
    readonly payload: string;
    readonly receiptKeys: readonly string[];
    readonly segments: { readonly min: number; readonly max: number };
    readonly ok?: true;
    readonly code?: string;
    readonly decodeError?: string;
    readonly offset?: number;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("receipt.json", SPEC_VECTORS), "utf8"),
) as ReceiptVectors;

const decimal = (s: string) => {
  if (!/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Each run signs a receipt (RFC 6979 P-256), about 10 ms in CI at 1000 runs.
const PROPERTY_TIMEOUT = 120_000;

describe("receipt vectors (docs/spec/vectors/receipt.json)", () => {
  test("names its format and the receipt signature tag", () => {
    expect(vectors.format).toBe("abolish-receipt-vectors/1");
    expect(vectors.tag).toBe("abolish/v1/sig/receipt");
  });

  test.each(vectors.receipts)("$id decodes to its fields and re-encodes to its bytes", (v) => {
    const r = decodeReceipt(hex(v.encoding));
    expect(r).toEqual({
      election_id: hex(v.electionId),
      index: decimal(v.index),
      segment: v.segment,
      entry_hash: hex(v.entryHash),
      link: hex(v.link),
      root: hex(v.root),
      operator_key: hex(v.operatorKey),
      signature: hex(v.signature),
      inclusion: v.inclusion.map(hex),
    });
    expect(encodeReceipt(r)).toEqual(hex(v.encoding));
    expect(receiptStatement(r)).toEqual(hex(v.statement));
    expect(receiptStatement(r)).toHaveLength(173);
  });

  test.each(vectors.receipts)("$id is what signReceipt makes (RFC 6979)", (v) => {
    const { operator_key: _k, signature: _s, ...unsigned } = decodeReceipt(hex(v.encoding));
    expect(encodeReceipt(signReceipt(hex(v.secretKey), unsigned))).toEqual(hex(v.encoding));
  });

  test.each(vectors.decodeErrors)("$id is rejected with $error at $offset", (v) => {
    let caught: unknown;
    try {
      decodeReceipt(hex(v.encoding));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DecodeError);
    expect((caught as DecodeError).code).toBe(v.error);
    expect((caught as DecodeError).offset).toBe(v.offset);
  });

  test.each(vectors.atCast)("at cast: $id", (v) => {
    const got = checkReceiptAtCast(hex(v.receipt), {
      electionId: hex(v.electionId),
      payload: hex(v.payload),
      boardEntryVersion: 1,
      receiptKeys: v.receiptKeys.map(hex),
      segments: v.segments,
    });
    if (v.ok === true) {
      expect(got.ok).toBe(true);
      if (got.ok) expect(encodeReceipt(got.receipt)).toEqual(hex(v.receipt));
    } else {
      expect(got).toEqual({
        ok: false,
        code: v.code,
        ...(v.decodeError === undefined
          ? {}
          : { decodeError: { code: v.decodeError, offset: v.offset } }),
      });
    }
  });
});

// Boards built here are honest by construction: the operator side of the
// protocol (signReceipt, inclusionProof, consistencyProof) against the
// client's checks.
const E = hex(vectors.electionId);
const OPERATOR = hex(vectors.receipts[0]?.secretKey ?? "");
const KEYS = [identityKey(OPERATOR)];

const ballot = (body: Uint8Array) => new Uint8Array([0x00, 0x02, 0x01, ...body]);

function makeBoard(
  payloads: readonly Uint8Array[],
  segments: readonly number[],
  version: BoardEntryVersion,
) {
  const entries = payloads.map((payload, i) =>
    encodeBoardEntry(
      { election_id: E, index: BigInt(i), segment: segments[i] ?? 0, payload },
      version,
    ),
  );
  const hashes = entries.map(boardEntryHash);
  const links: Uint8Array[] = [];
  for (const h of hashes) links.push(chainLink(links.at(-1) ?? new Uint8Array(32), h));
  return { entries, hashes, links, segments, version };
}

type Board = ReturnType<typeof makeBoard>;

function receiptFor(b: Board, i: number): Receipt {
  const hashes = b.hashes.slice(0, i + 1);
  return signReceipt(OPERATOR, {
    election_id: E,
    index: BigInt(i),
    segment: b.segments[i] ?? 0,
    entry_hash: b.hashes[i] as Uint8Array,
    link: b.links[i] as Uint8Array,
    root: merkleRoot(BOARD_TREE, hashes),
    inclusion: inclusionProof(BOARD_TREE, hashes, i),
  });
}

const arbBoard = fc
  .tuple(
    fc.array(fc.tuple(fc.uint8Array({ maxLength: 24 }), fc.integer({ min: 0, max: 2 })), {
      minLength: 1,
      maxLength: 24,
    }),
    fc.constantFrom<BoardEntryVersion>(1, 3),
  )
  .map(([rows, version]) => {
    // Segment steps of 0 to 2, capped at the clock's last segment, so
    // segments never decrease; each payload is made distinct by its position.
    let s = 0;
    const segments = rows.map(([, step], i) => (i === 0 ? 0 : (s = Math.min(6, s + step))));
    const payloads = rows.map(([body], i) => ballot(new Uint8Array([i, ...body])));
    return makeBoard(payloads, segments, version);
  })
  .chain((b) => fc.tuple(fc.constant(b), fc.nat({ max: b.entries.length - 1 })));

describe("receipt properties", () => {
  test(
    "an honest receipt passes at cast",
    () => {
      fc.assert(
        fc.property(arbBoard, ([b, i]) => {
          const r = receiptFor(b, i);
          const s = b.segments[i] as number;
          const cast = checkReceiptAtCast(encodeReceipt(r), {
            electionId: E,
            payload: ballotOf(b, i),
            boardEntryVersion: b.version,
            receiptKeys: KEYS,
            segments: { min: s, max: s },
          });
          expect(cast).toEqual({ ok: true, receipt: r });
          // The same receipt checked under the other board-entry version.
          const other = checkReceiptAtCast(encodeReceipt(r), {
            electionId: E,
            payload: ballotOf(b, i),
            boardEntryVersion: b.version === 1 ? 3 : 1,
            receiptKeys: KEYS,
            segments: { min: s, max: s },
          });
          expect(other).toEqual({ ok: false, code: "receipt-entry" });
        }),
        { numRuns },
      );
    },
    PROPERTY_TIMEOUT,
  );

  test(
    "any changed byte of a receipt fails the checks at cast",
    () => {
      fc.assert(
        fc.property(arbBoard, fc.nat(), fc.integer({ min: 1, max: 255 }), ([b, i], at, x) => {
          const bytes = encodeReceipt(receiptFor(b, i));
          const k = at % bytes.length;
          bytes[k] = (bytes[k] as number) ^ x;
          const s = b.segments[i] as number;
          const got = checkReceiptAtCast(bytes, {
            electionId: E,
            payload: ballotOf(b, i),
            boardEntryVersion: b.version,
            receiptKeys: KEYS,
            segments: { min: s, max: s },
          });
          expect(got.ok).toBe(false);
        }),
        { numRuns },
      );
    },
    PROPERTY_TIMEOUT,
  );
});

function ballotOf(b: Board, i: number): Uint8Array {
  // The payload is the entry's tail after its 47-byte header and 4-byte length.
  return (b.entries[i] as Uint8Array).subarray(51);
}
