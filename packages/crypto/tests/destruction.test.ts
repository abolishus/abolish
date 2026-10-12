import { p256 } from "@noble/curves/nist.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BOARD_PAYLOAD_TYPES_V3,
  BOARD_PAYLOAD_TYPES_V4,
  type BoardEntryVersion,
  checkDestruction,
  DecodeError,
  decodeBoardEntry,
  decodeDestructionStatement,
  type DestructionElection,
  destructionSegment,
  type DestructionStatement,
  destructionStatementMessage,
  encodeBoardEntry,
  encodeDestructionStatement,
  EncodeError,
  RECORD_TYPES,
  signDestructionStatement,
  verifyStatement,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/destruction.json comes from an independent Python
// implementation of docs/spec/tally.md, Destruction and Destruction checks
// (scripts/destruction-vectors.py, with its own strict decoder, P-256 ECDSA
// and report), so these bytes and reports never come from the code under test.

interface Vectors {
  readonly format: string;
  readonly tag: string;
  readonly recordType: string;
  readonly version: number;
  readonly election: {
    readonly definitionHash: string;
    readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
  };
  readonly statements: readonly {
    readonly id: string;
    readonly signingSecret: string;
    readonly signingKey: string;
    readonly definitionHash: string;
    readonly signer: number;
    readonly message: string;
    readonly signature: string;
    readonly encoding: string;
  }[];
  readonly decodeErrors: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
  readonly reports: readonly {
    readonly id: string;
    readonly firstPassing: readonly (number | null)[];
    readonly windowSegment: number;
    readonly entries: readonly { readonly segment: number; readonly payload: string }[];
    readonly result: unknown;
  }[];
  readonly boardEntries: readonly {
    readonly id: string;
    readonly version: BoardEntryVersion;
    readonly encoding: string;
    readonly error: string | null;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("destruction.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const election: DestructionElection = {
  definitionHash: hex(vectors.election.definitionHash),
  registered: vectors.election.registered.map((k) => ({
    index: k.index,
    signingKey: hex(k.signingKey),
  })),
};

const seat1 = vectors.statements.find((s) => s.id === "seat-1");
if (seat1 === undefined) throw new Error("destruction.json: no seat-1 statement");
const secret1 = hex(seat1.signingSecret);
const honest = hex(seat1.encoding);
const tally = { firstPassing: [10, 12], windowSegment: 40 };

function report(entries: readonly { segment: number; payload: Uint8Array }[]) {
  return checkDestruction(election, entries, tally, 1);
}

describe("destruction statement vectors (docs/spec/vectors/destruction.json)", () => {
  test("the file is the destruction format for record type 0x000f, version 1", () => {
    expect(vectors.format).toBe("abolish-destruction-vectors/1");
    expect(vectors.tag).toBe("abolish/v1/sig/destruction");
    expect(vectors.recordType).toBe("0x000f");
    expect(vectors.version).toBe(1);
  });

  test.each(vectors.statements.map((s) => [s.id, s] as const))(
    "%s: signs, encodes and decodes byte for byte",
    (_id, v) => {
      const fields = { definition_hash: hex(v.definitionHash), signer: v.signer };
      expect(destructionStatementMessage(fields)).toEqual(hex(v.message));
      const signed = signDestructionStatement(hex(v.signingSecret), fields);
      expect(signed.signature).toEqual(hex(v.signature));
      expect(encodeDestructionStatement(signed)).toEqual(hex(v.encoding));
      expect(decodeDestructionStatement(hex(v.encoding), 1)).toEqual(signed);
      expect(p256.getPublicKey(hex(v.signingSecret), true)).toEqual(hex(v.signingKey));
    },
  );

  test.each(vectors.decodeErrors.map((v) => [v.id, v] as const))(
    "%s: rejected with its code and offset",
    (_id, v) => {
      let error: unknown;
      try {
        decodeDestructionStatement(hex(v.encoding), 1);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DecodeError);
      expect((error as DecodeError).code).toBe(v.error);
      expect((error as DecodeError).offset).toBe(v.offset);
    },
  );

  test.each(vectors.reports.map((r) => [r.id, r] as const))("%s: the report", (_id, v) => {
    const got = checkDestruction(
      election,
      v.entries.map((e) => ({ segment: e.segment, payload: hex(e.payload) })),
      { firstPassing: v.firstPassing, windowSegment: v.windowSegment },
      1,
    );
    expect(JSON.parse(JSON.stringify(got))).toEqual(v.result);
  });

  test.each(vectors.boardEntries.map((v) => [v.id, v] as const))("board entry %s", (_id, v) => {
    const b = hex(v.encoding);
    if (v.error === null) {
      expect(encodeBoardEntry(decodeBoardEntry(b, v.version), v.version)).toEqual(b);
    } else {
      expect(() => decodeBoardEntry(b, v.version)).toThrow(
        expect.objectContaining({ code: v.error }) as Error,
      );
    }
  });
});

describe("board entry version 4", () => {
  const entry = { election_id: new Uint8Array(32), index: 0n, segment: 0, payload: honest };

  test("allows exactly version 3's types and the destruction statement", () => {
    expect([...BOARD_PAYLOAD_TYPES_V4].sort((a, b) => a - b)).toEqual(
      [...BOARD_PAYLOAD_TYPES_V3, RECORD_TYPES.destructionStatement].sort((a, b) => a - b),
    );
    expect(Object.isFrozen(BOARD_PAYLOAD_TYPES_V4)).toBe(true);
  });

  test("only version 4 encodes a destruction statement", () => {
    for (const version of [1, 3] as const)
      expect(() => encodeBoardEntry(entry, version)).toThrow(EncodeError);
    const b = encodeBoardEntry(entry, 4);
    expect(b[2]).toBe(4);
    expect(decodeBoardEntry(b, 4).payload).toEqual(honest);
  });
});

describe("the report's rules", () => {
  // Each test below fails if the rule it names is dropped from checkDestruction.

  test("a statement for another definition never counts for this one", () => {
    const other = signDestructionStatement(secret1, {
      definition_hash: new Uint8Array(32).fill(7),
      signer: 1,
    });
    const r = report([{ segment: 20, payload: encodeDestructionStatement(other) }]);
    expect(r.seats[0]).toEqual({ seat: 1, code: "destruction-missing" });
    expect(r.stray).toEqual([{ at: 0, signer: 1 }]);
  });

  test("a statement whose signature doesn't verify counts for no seat", () => {
    const bad = Uint8Array.from(honest);
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    // Flipping s's last bit can leave a high s, which the decoder rejects; either way it never counts.
    const r = report([{ segment: 20, payload: bad }]);
    expect(r.seats[0]).toEqual({ seat: 1, code: "destruction-missing" });
    expect(r.unattributed.length + r.rejected.length).toBe(1);
  });

  test("a seat's first statement decides, and the timing compares segments", () => {
    const r = report([
      { segment: 12, payload: honest },
      { segment: 13, payload: honest },
    ]);
    expect(r.seats[0]).toEqual({ seat: 1, code: "destruction-early", at: 0 });
    expect(r.duplicates).toEqual([{ at: 1, seat: 1 }]);
    expect(report([{ segment: 13, payload: honest }]).seats[0]).toEqual({
      seat: 1,
      code: "destroyed",
      at: 0,
    });
  });

  test("the destruction segment is min(s_O + 1, s_T), or s_T with a cell unopened", () => {
    expect(destructionSegment({ firstPassing: [3, 9, 1], windowSegment: 40 })).toBe(10);
    expect(destructionSegment({ firstPassing: [3, 39], windowSegment: 40 })).toBe(40);
    expect(destructionSegment({ firstPassing: [3, 50], windowSegment: 40 })).toBe(40);
    expect(destructionSegment({ firstPassing: [3, null], windowSegment: 40 })).toBe(40);
    expect(destructionSegment({ firstPassing: [0], windowSegment: 0 })).toBe(0);
  });

  test("refuses inputs that aren't a partition or segments", () => {
    expect(() => destructionSegment({ firstPassing: [], windowSegment: 1 })).toThrow(RangeError);
    expect(() => destructionSegment({ firstPassing: [-1], windowSegment: 1 })).toThrow(RangeError);
    expect(() => destructionSegment({ firstPassing: [1], windowSegment: 2 ** 32 })).toThrow(
      RangeError,
    );
    expect(() => report([{ segment: 1.5, payload: honest }])).toThrow(RangeError);
    expect(() =>
      checkDestruction({ ...election, definitionHash: new Uint8Array(31) }, [], tally, 1),
    ).toThrow(RangeError);
  });

  test("the signature covers the header: the same fields under another version don't verify", () => {
    const fields = { definition_hash: election.definitionHash, signer: 1 };
    const m = destructionStatementMessage(fields);
    expect(Array.from(m.subarray(0, 3))).toEqual([0x00, 0x0f, 0x01]);
    expect(m.length).toBe(3 + 32 + 1);
    const { signature } = signDestructionStatement(secret1, fields);
    const key = election.registered[0]?.signingKey as Uint8Array;
    const tag = "abolish/v1/sig/destruction";
    expect(verifyStatement(key, tag, m, signature)).toBe(true);
    const v2 = Uint8Array.from(m);
    v2[2] = 2;
    expect(verifyStatement(key, tag, v2, signature)).toBe(false);
    // Without the header the same fields don't verify either.
    expect(verifyStatement(key, tag, m.subarray(3), signature)).toBe(false);
  });
});

describe("destruction statement properties", () => {
  const fields = fc.record({
    definition_hash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
    signer: fc.integer({ min: 0, max: 255 }),
  });

  test("records round-trip, and a signed one is attributed only to its own seat", () => {
    fc.assert(
      fc.property(fields, (f) => {
        const s = signDestructionStatement(secret1, f);
        const b = encodeDestructionStatement(s);
        expect(b.length).toBe(100);
        expect(decodeDestructionStatement(b, 1)).toEqual(s);
        const r = checkDestruction(
          { ...election, definitionHash: f.definition_hash },
          [{ segment: 20, payload: b }],
          tally,
          1,
        );
        const seat1Line = r.seats.find((x) => x.seat === 1);
        expect(seat1Line?.code === "destroyed").toBe(f.signer === 1);
      }),
      { numRuns: Math.min(numRuns, 200) },
    );
  }, 60_000);

  test("any changed byte of a statement is rejected or unattributed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: honest.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, x) => {
          const b = Uint8Array.from(honest);
          b[at] = (b[at] as number) ^ x;
          const r = report([{ segment: 20, payload: b }]);
          expect(r.seats.every((s) => s.code === "destruction-missing")).toBe(true);
        },
      ),
      { numRuns },
    );
  }, 60_000);

  test("every accepted encoding re-encodes to itself", () => {
    const tails = fc.uint8Array({ minLength: 0, maxLength: 120 });
    fc.assert(
      fc.property(
        fc.oneof(
          tails,
          tails.map((t) => Uint8Array.of(0x00, 0x0f, 0x01, ...t)),
          // Near-valid: the honest fields with any 64 bytes as the signature.
          fc
            .uint8Array({ minLength: 64, maxLength: 64 })
            .map((sig) => Uint8Array.of(...honest.subarray(0, 36), ...sig)),
        ),
        (b) => {
          let s: DestructionStatement;
          try {
            s = decodeDestructionStatement(b, 1);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            return;
          }
          expect(encodeDestructionStatement(s)).toEqual(b);
        },
      ),
      { numRuns },
    );
  }, 60_000);
});
