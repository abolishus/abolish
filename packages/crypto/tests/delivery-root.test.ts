import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  decodeObligationRoot,
  EncodeError,
  encodeObligationRoot,
  OBLIGATION_ROOT_KINDS,
  type ObligationRootKind,
  type ObligationRootRecord,
  RECORD_TYPES,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/delivery-root.json comes from an independent Python
// implementation of the obligation root (scripts/delivery-root-vectors.py),
// so the expected fields and rejections never come from the code under test.
// This file reads the record only: the tree, the leaf object, the delivery
// check over roots and the forced path are delivery-root-check.test.ts's.

interface Vectors {
  readonly format: string;
  readonly definitionHash: string;
  readonly records: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly seat: number;
    readonly kind: number;
    readonly count: number;
    readonly root: string;
    readonly leavesCid: string;
    readonly statement: string;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("delivery-root.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

describe("obligation root (docs/spec/vectors/delivery-root.json)", () => {
  test("the file is the obligation-root format for record type 0x001a", () => {
    expect(vectors.format).toBe("abolish-delivery-root-vectors/1");
    expect(RECORD_TYPES.obligationRoot).toBe(0x001a);
  });

  test.each(vectors.records.map((r) => [r.id, r] as const))(
    "%s: decodes to the file's fields and re-encodes to its bytes",
    (_id, v) => {
      const bytes = hex(v.encoding);
      const root = decodeObligationRoot(bytes, 1);
      expect(root).toEqual({
        definition_hash: hex(vectors.definitionHash),
        seat: v.seat,
        kind: v.kind,
        count: v.count,
        root: hex(v.root),
        leaves_cid: hex(v.leavesCid),
        signature: bytes.subarray(109),
      });
      // `m`, the 106 bytes the seat signs, is the record between its header and signature.
      expect(bytes.subarray(3, 109)).toEqual(hex(v.statement));
      expect(encodeObligationRoot(root)).toEqual(bytes);
    },
  );

  test.each(vectors.decode.map((v) => [v.id, v] as const))(
    "%s: rejected with its code and offset",
    (_id, v) => {
      let error: unknown;
      try {
        decodeObligationRoot(hex(v.encoding), 1);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DecodeError);
      expect((error as DecodeError).code).toBe(v.error);
      expect((error as DecodeError).offset).toBe(v.offset);
    },
  );
});

describe("obligation root properties", () => {
  const honest = decodeObligationRoot(hex(vectors.records[0]?.encoding ?? ""), 1);
  const byte32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
  // The CID a root of `kind` over `count` leaves must carry: raw up to 1 MiB
  // of leaves, dag-pb above (content-addressing.md, Small objects).
  const cidFor = (kind: ObligationRootKind, count: number, digest: Uint8Array) =>
    Uint8Array.from([
      0x01,
      (kind === 1 ? 64 : 128) * count <= 1_048_576 ? 0x55 : 0x70,
      0x12,
      0x20,
      ...digest,
    ]);
  const root = fc
    .record({
      definition_hash: byte32,
      seat: fc.integer({ min: 0, max: 255 }),
      kind: fc.constantFrom<ObligationRootKind>(
        OBLIGATION_ROOT_KINDS.receipts,
        OBLIGATION_ROOT_KINDS.complaints,
      ),
      count: fc.oneof(
        fc.integer({ min: 1, max: 0xffffffff }),
        fc.constantFrom(1, 8192, 8193, 16384, 16385),
      ),
      root: byte32,
      digest: byte32,
    })
    .map(({ digest, ...r }): ObligationRootRecord => ({
      ...r,
      leaves_cid: cidFor(r.kind, r.count, digest),
      signature: honest.signature,
    }));

  test("decode(encode(x)) = x", () => {
    fc.assert(
      fc.property(root, (r) => {
        expect(decodeObligationRoot(encodeObligationRoot(r), 1)).toEqual(r);
      }),
      { numRuns },
    );
  });

  test("random changes are rejected or re-encode to themselves", () => {
    const bytes = encodeObligationRoot(honest);
    const mutated = fc
      .tuple(fc.nat({ max: bytes.length - 1 }), fc.integer({ min: 0, max: 255 }), fc.nat(8))
      .map(([at, value, cut]) => {
        const b = bytes.slice(0, bytes.length - cut);
        if (at < b.length) b[at] = value;
        return b;
      });
    fc.assert(
      fc.property(fc.oneof(mutated, fc.uint8Array({ maxLength: 200 })), (b) => {
        let decoded: ObligationRootRecord;
        try {
          decoded = decodeObligationRoot(b, 1);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
          return;
        }
        expect(encodeObligationRoot(decoded)).toEqual(b);
      }),
      { numRuns },
    );
  });

  // The codec of a raw block's CID at the size where the object needs a
  // dag-pb tree, and the reverse, never encodes: the decoder refuses both.
  test("refuses to encode what it can't decode", () => {
    const raw = cidFor(1, 16384, new Uint8Array(32));
    const dagPb = cidFor(1, 16385, new Uint8Array(32));
    const at = (count: number, leaves_cid: Uint8Array) => () =>
      encodeObligationRoot({ ...honest, kind: 1, count, leaves_cid });
    expect(at(16384, raw)).not.toThrow();
    expect(at(16385, dagPb)).not.toThrow();
    expect(at(16385, raw)).toThrow(EncodeError);
    expect(at(16384, dagPb)).toThrow(EncodeError);
    expect(at(0, raw)).toThrow(EncodeError);
    expect(at(2 ** 32, dagPb)).toThrow(EncodeError);
    expect(() => encodeObligationRoot({ ...honest, kind: 3 as ObligationRootKind })).toThrow(
      EncodeError,
    );
  });
});
