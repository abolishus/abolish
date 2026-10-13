import { p256 } from "@noble/curves/nist.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  ballotWindow,
  boardBallotSegment,
  CLOSE_WINDOW,
  type CloseBallot,
  closeCheck,
  closeDeadline,
  type CloseElection,
  closeHead,
  type CloseStatementEntry,
  type CloseStatementFields,
  closeStatementMessage,
  DecodeError,
  decodeCloseStatement,
  encodeCloseStatement,
  type FinalizedL1,
  lDelta,
  PARAMETERS,
  RECORD_TYPES,
  signCloseStatement,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/close-statement.json comes from an independent Python
// implementation of docs/spec/close.md (scripts/close-statement-vectors.py,
// with its own strict decoder, P-256 ECDSA, close head, re-vote selection and
// close check), so these bytes and verdicts never come from the code under test.

interface Vectors {
  readonly format: string;
  readonly tag: string;
  readonly recordType: string;
  readonly version: number;
  readonly closeWindow: number;
  readonly clock: { readonly epoch: string; readonly period: string };
  readonly window: {
    readonly opensAt: string;
    readonly closesAt: string;
    readonly boardSegment: number;
  };
  readonly election: {
    readonly definitionHash: string;
    readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
    readonly threshold: number;
    readonly closesAt: string;
    readonly l1InclusionBound: number;
    readonly lDelta: { readonly number: string; readonly hash: string };
    readonly deadline: { readonly time: string; readonly segment: number };
  };
  readonly statements: readonly {
    readonly id: string;
    readonly signingSecret: string;
    readonly signingKey: string;
    readonly definitionHash: string;
    readonly signer: number;
    readonly l1Number: string;
    readonly l1Hash: string;
    readonly l2Number: string;
    readonly l2Hash: string;
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
  readonly windows: readonly {
    readonly id: string;
    readonly path: "ordinary" | "relayed" | "board";
    readonly value: string;
    readonly result: string;
  }[];
  readonly lDelta: readonly {
    readonly id: string;
    readonly closesAt: string;
    readonly bound: number;
    readonly blocks: readonly {
      readonly number: string;
      readonly timestamp: string;
      readonly hash: string;
    }[];
    readonly result: string | null;
  }[];
  readonly heads: readonly {
    readonly id: string;
    readonly floor: string | null;
    readonly entries: readonly (
      | { readonly path: "board"; readonly segment: number; readonly payload: string }
      | { readonly path: "contract"; readonly submittedAt: string; readonly payload: string }
    )[];
    readonly result: unknown;
  }[];
  readonly checks: readonly {
    readonly id: string;
    readonly head: string | null;
    readonly ballots: readonly {
      readonly index: string;
      readonly cell: number;
      readonly tier: number;
      readonly nullifier: string;
      readonly message: string;
      readonly l1RefNumber: string;
      readonly ballotHash: string;
      readonly path: "ordinary" | "relayed" | "board";
      readonly l2Block?: string;
    }[];
    readonly undelivered: readonly string[];
    readonly result: unknown;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("close-statement.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** The vector files' JSON shapes: bigints as decimal strings, bytes as hex. */
function plain(x: unknown): unknown {
  if (typeof x === "bigint") return x.toString();
  if (x instanceof Uint8Array) return toHex(x);
  if (Array.isArray(x)) return x.map(plain);
  if (x !== null && typeof x === "object")
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, plain(v)]));
  return x;
}

const election: CloseElection = {
  definitionHash: hex(vectors.election.definitionHash),
  registered: vectors.election.registered.map((k) => ({
    index: k.index,
    signingKey: hex(k.signingKey),
  })),
  threshold: vectors.election.threshold,
  lDelta: {
    number: BigInt(vectors.election.lDelta.number),
    hash: hex(vectors.election.lDelta.hash),
  },
  deadline: {
    time: BigInt(vectors.election.deadline.time),
    segment: BigInt(vectors.election.deadline.segment),
  },
  floor: null,
};

const clock = { epoch: BigInt(vectors.clock.epoch), period: BigInt(vectors.clock.period) };

function entries(es: Vectors["heads"][number]["entries"]): CloseStatementEntry[] {
  return es.map((e) =>
    e.path === "board"
      ? { path: "board", segment: BigInt(e.segment), payload: hex(e.payload) }
      : { path: "contract", submittedAt: BigInt(e.submittedAt), payload: hex(e.payload) },
  );
}

function ballots(bs: Vectors["checks"][number]["ballots"]): CloseBallot[] {
  return bs.map((b) => {
    const base = {
      index: BigInt(b.index),
      cell: b.cell,
      tier: b.tier,
      nullifier: BigInt(b.nullifier),
      message: hex(b.message),
      l1RefNumber: BigInt(b.l1RefNumber),
      ballotHash: hex(b.ballotHash),
    };
    if (b.path !== "ordinary") return { ...base, path: b.path };
    if (b.l2Block === undefined) throw new Error("an ordinary ballot has an L2 block");
    return { ...base, path: "ordinary", l2Block: BigInt(b.l2Block) };
  });
}

const notIn = (hashes: readonly string[]) => (h: Uint8Array) => !hashes.includes(toHex(h));

describe("close statement vectors (docs/spec/vectors/close-statement.json)", () => {
  test("the file is the close format for record type 0x0015, version 1", () => {
    expect(vectors.format).toBe("abolish-close-statement-vectors/1");
    expect(vectors.tag).toBe("abolish/v1/sig/close-statement");
    expect(vectors.recordType).toBe("0x0015");
    expect(RECORD_TYPES.closeStatement).toBe(0x0015);
    expect(vectors.version).toBe(1);
    expect(BigInt(vectors.closeWindow)).toBe(CLOSE_WINDOW);
    expect(PARAMETERS.CLOSE_WINDOW).toBe(vectors.closeWindow);
  });

  test.each(vectors.statements.map((s) => [s.id, s] as const))(
    "%s: signs, encodes and decodes byte for byte",
    (_id, v) => {
      const fields: CloseStatementFields = {
        definition_hash: hex(v.definitionHash),
        signer: v.signer,
        l1_number: BigInt(v.l1Number),
        l1_hash: hex(v.l1Hash),
        l2_number: BigInt(v.l2Number),
        l2_hash: hex(v.l2Hash),
      };
      expect(closeStatementMessage(fields)).toEqual(hex(v.message));
      const signed = signCloseStatement(hex(v.signingSecret), fields);
      expect(signed.signature).toEqual(hex(v.signature));
      expect(encodeCloseStatement(signed)).toEqual(hex(v.encoding));
      expect(decodeCloseStatement(hex(v.encoding), 1)).toEqual(signed);
      expect(p256.getPublicKey(hex(v.signingSecret), true)).toEqual(hex(v.signingKey));
    },
  );

  test.each(vectors.decodeErrors.map((v) => [v.id, v] as const))(
    "%s: rejected with its code and offset",
    (_id, v) => {
      let error: unknown;
      try {
        decodeCloseStatement(hex(v.encoding), 1);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DecodeError);
      expect((error as DecodeError).code).toBe(v.error);
      expect((error as DecodeError).offset).toBe(v.offset);
    },
  );

  test("s_A and the close deadline follow from the clock", () => {
    const closesAt = BigInt(vectors.window.closesAt);
    expect(boardBallotSegment(clock, closesAt)).toBe(BigInt(vectors.window.boardSegment));
    const d = closeDeadline(
      clock,
      BigInt(vectors.election.closesAt),
      BigInt(vectors.election.l1InclusionBound),
    );
    expect(plain(d)).toEqual({
      time: vectors.election.deadline.time,
      segment: String(vectors.election.deadline.segment),
    });
  });

  test.each(vectors.windows.map((v) => [v.id, v] as const))("window %s", (_id, v) => {
    const window = {
      opensAt: BigInt(vectors.window.opensAt),
      closesAt: BigInt(vectors.window.closesAt),
      boardSegment: BigInt(vectors.window.boardSegment),
    };
    expect(ballotWindow(v.path, BigInt(v.value), window)).toBe(v.result);
  });

  test.each(vectors.lDelta.map((v) => [v.id, v] as const))("L_δ %s", (_id, v) => {
    const blocks = new Map(v.blocks.map((b) => [BigInt(b.number), b]));
    const first = BigInt(v.blocks[0]?.number ?? "0");
    const l1: FinalizedL1 = {
      head: BigInt(v.blocks.at(-1)?.number ?? "0"),
      block(n) {
        const b = blocks.get(n);
        if (b === undefined) throw new Error(`block ${n} wasn't read`);
        return { hash: hex(b.hash), timestamp: BigInt(b.timestamp) };
      },
    };
    const got = lDelta(l1, first, BigInt(v.closesAt), BigInt(v.bound));
    if (v.result === null) expect(got).toBeUndefined();
    else expect(plain(got)).toEqual({ number: v.result, hash: blocks.get(BigInt(v.result))?.hash });
  });

  test.each(vectors.heads.map((v) => [v.id, v] as const))("close head %s", (_id, v) => {
    const floor = v.floor === null ? null : BigInt(v.floor);
    const got = closeHead({ ...election, floor }, entries(v.entries), 1);
    expect(plain(got)).toEqual(v.result);
  });

  test.each(vectors.checks.map((v) => [v.id, v] as const))("close check %s", (_id, v) => {
    const head = v.head === null ? null : BigInt(v.head);
    expect(plain(closeCheck(ballots(v.ballots), head, notIn(v.undelivered)))).toEqual(v.result);
  });
});

const seat1 = vectors.statements.find((s) => s.id === "seat-1");
if (seat1 === undefined) throw new Error("close-statement.json: no seat-1 statement");
const honestFields: CloseStatementFields = {
  definition_hash: hex(seat1.definitionHash),
  signer: 1,
  l1_number: BigInt(seat1.l1Number),
  l1_hash: hex(seat1.l1Hash),
  l2_number: BigInt(seat1.l2Number),
  l2_hash: hex(seat1.l2Hash),
};

describe("the codec", () => {
  const secret = hex(seat1.signingSecret);
  const arbitraryFields = fc.record({
    definition_hash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
    signer: fc.integer({ min: 0, max: 255 }),
    l1_number: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
    l1_hash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
    l2_number: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
    l2_hash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
  });

  test("decode(encode(x)) = x, the record is 180 bytes and verifies", () => {
    fc.assert(
      fc.property(arbitraryFields, (fields) => {
        const signed = signCloseStatement(secret, fields);
        const b = encodeCloseStatement(signed);
        expect(b).toHaveLength(180);
        expect(decodeCloseStatement(b, 1)).toEqual(signed);
        expect(closeStatementMessage(signed)).toEqual(b.subarray(0, 116));
      }),
      { numRuns: Math.min(numRuns, 200) },
    );
  });

  test("encode(decode(b)) = b for every accepted b, and every other length is refused", () => {
    const honest = hex(seat1.encoding);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 179 }), fc.integer({ min: 0, max: 255 }), (i, x) => {
        const b = Uint8Array.from(honest);
        b[i] = x;
        let decoded;
        try {
          decoded = decodeCloseStatement(b, 1);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
          return;
        }
        expect(encodeCloseStatement(decoded)).toEqual(b);
      }),
      { numRuns },
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (b) => {
        fc.pre(b.length !== 180);
        expect(() => decodeCloseStatement(b, 1)).toThrow(DecodeError);
      }),
      { numRuns },
    );
  });
});

describe("the close head's rules", () => {
  // Each test below fails if the rule it names is dropped from closeHead.
  const secrets = new Map(
    vectors.statements
      .filter((s) => s.definitionHash === seat1.definitionHash)
      .map((s) => [s.signer, hex(s.signingSecret)]),
  );
  const onTime = election.deadline.segment;
  const at = (signer: number, claim: bigint, extra: Partial<CloseStatementFields> = {}) => {
    const secret = secrets.get(signer);
    if (secret === undefined) throw new Error(`no secret for seat ${signer}`);
    const s = signCloseStatement(secret, {
      ...honestFields,
      signer,
      l2_number: claim,
      l2_hash: new Uint8Array(32).fill(Number(claim % 256n)),
      ...extra,
    });
    return { path: "board", segment: onTime, payload: encodeCloseStatement(s) } as const;
  };

  test("the k-th largest counted claim is the head, so k − 1 high liars can't move it", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1000n, max: 1n << 40n }),
        fc.bigInt({ min: 0n, max: 1n << 41n }),
        fc.bigInt({ min: 0n, max: 1n << 41n }),
        (honest, liar3, liar5) => {
          // Seats 1 and 2 are honest, seats 3 and 5 claim anything (k = 3).
          const r = closeHead(
            election,
            [at(1, honest), at(2, honest), at(3, liar3), at(5, liar5)],
            1,
          );
          const sorted = [honest, honest, liar3, liar5].sort((a, b) =>
            a > b ? -1 : a < b ? 1 : 0,
          );
          expect(r.head).toBe(sorted[2]);
          // Two liars, fewer than k, can lower the head only by both stating
          // low, and never raise it above the honest claim.
          expect(r.head !== null && r.head <= honest).toBe(true);
          if (liar3 >= honest || liar5 >= honest) expect(r.head).toBe(honest);
        },
      ),
      { numRuns },
    );
  });

  test("statements are counted once per seat, whatever their order", () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([1, 2, 3, 5, 1, 2], { minLength: 6, maxLength: 6 }),
        (order) => {
          const r = closeHead(
            election,
            order.map((s) => at(s, 40_001_000n)),
            1,
          );
          expect(r.head).toBe(40_001_000n);
          expect(r.seats.map((s) => s.code)).toEqual([
            "close-counted",
            "close-counted",
            "close-counted",
            "close-counted",
          ]);
        },
      ),
      { numRuns },
    );
  });

  test("an equivocating seat counts nothing, through any path", () => {
    const r = closeHead(
      election,
      [at(1, 5n), at(2, 5n), at(3, 5n), { ...at(3, 9n), path: "board", segment: onTime - 1n }],
      1,
    );
    expect(r.seats[2]).toEqual({ seat: 3, code: "close-equivocation" });
    expect(r.head).toBeNull();
    expect(r.claims.map((c) => c.number)).toEqual([5n, 9n]);
  });

  test("a statement against another L1 block never counts", () => {
    const r = closeHead(
      election,
      [at(1, 5n), at(2, 5n), at(3, 5n, { l1_number: honestFields.l1_number - 1n })],
      1,
    );
    expect(r.statements[2]).toEqual({ at: 2, code: "close-l1", seat: 3 });
    expect(r.head).toBeNull();
  });

  test("a claim below the floor never counts", () => {
    const r = closeHead({ ...election, floor: 6n }, [at(1, 7n), at(2, 7n), at(3, 5n)], 1);
    expect(r.seats[2]).toMatchObject({ seat: 3, code: "close-below-floor" });
    expect(r.head).toBeNull();
    expect(closeHead({ ...election, floor: 5n }, [at(1, 7n), at(2, 7n), at(3, 5n)], 1).head).toBe(
      5n,
    );
  });

  test("lateness compares segments through the board path and times through the contract path", () => {
    const late = { ...at(3, 5n), segment: onTime + 1n };
    const contract = {
      path: "contract",
      submittedAt: election.deadline.time + 1n,
      payload: at(5, 5n).payload,
    } as const;
    const r = closeHead(election, [at(1, 5n), at(2, 5n), late, contract], 1);
    expect(r.statements.slice(2)).toEqual([
      { at: 2, code: "close-late", seat: null },
      { at: 3, code: "close-late", seat: 5 },
    ]);
    expect(r.head).toBeNull();
  });
});

describe("the close check's rules", () => {
  const h = (label: string) => Uint8Array.from(Buffer.from(label.padEnd(32, ".").slice(0, 32)));
  const ballot = (
    index: bigint,
    nullifier: bigint,
    l1RefNumber: bigint,
    path: "ordinary" | "relayed" | "board",
    l2Block = 0n,
    content = "",
  ): CloseBallot => {
    const base = {
      index,
      cell: 0,
      tier: 0,
      nullifier,
      l1RefNumber,
      ballotHash: h(`b${nullifier}${content}`),
      message: h(`m${nullifier}${content}${l1RefNumber}`),
    };
    return path === "ordinary" ? { ...base, path, l2Block } : { ...base, path };
  };
  const all = () => true;

  test("a head at or above every ordinary block never fails, and lists nothing late", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            nullifier: fc.bigInt({ min: 1n, max: 6n }),
            ref: fc.bigInt({ min: 1n, max: 4n }),
            block: fc.bigInt({ min: 0n, max: 100n }),
            path: fc.constantFrom("ordinary", "relayed", "board") as fc.Arbitrary<
              "ordinary" | "relayed" | "board"
            >,
          }),
          { maxLength: 12 },
        ),
        (spec) => {
          const bs = spec.map((s, i) =>
            ballot(BigInt(i), s.nullifier, s.ref, s.path, s.block, `${i}`),
          );
          expect(closeCheck(bs, 100n, all)).toEqual({ status: "pass", late: [] });
        },
      ),
      { numRuns },
    );
  });

  test("the verdict doesn't depend on the order of the entries", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            nullifier: fc.bigInt({ min: 1n, max: 4n }),
            ref: fc.bigInt({ min: 1n, max: 3n }),
            block: fc.bigInt({ min: 0n, max: 20n }),
            content: fc.constantFrom("a", "b"),
            path: fc.constantFrom("ordinary", "relayed", "board") as fc.Arbitrary<
              "ordinary" | "relayed" | "board"
            >,
          }),
          { maxLength: 10 },
        ),
        fc.bigInt({ min: 0n, max: 20n }),
        (spec, head) => {
          const bs = spec.map((s, i) =>
            ballot(BigInt(i), s.nullifier, s.ref, s.path, s.block, s.content),
          );
          const r = closeCheck(bs, head, all);
          const reversed = closeCheck([...bs].reverse(), head, all);
          expect(reversed).toEqual(r);
        },
      ),
      { numRuns },
    );
  });

  test("late copies are removed before repeats, so a timely copy stands", () => {
    // Without the removal first, the late copy at index 0 would stand as the
    // repeat's original and the check would compare it with itself.
    const late = ballot(0n, 1n, 5n, "ordinary", 50n, "x");
    const relayed = ballot(1n, 1n, 5n, "relayed", 0n, "x");
    expect(closeCheck([late, relayed], 10n, all)).toEqual({ status: "pass", late: [0n] });
    expect(closeCheck([late], 10n, all)).toMatchObject({ status: "fail", cell: 0 });
  });

  test("an undelivered selected ballot is outside the counted set", () => {
    const first = ballot(0n, 1n, 5n, "board", 0n, "first");
    const revote = ballot(1n, 1n, 6n, "ordinary", 50n, "second");
    const undelivered = (b: Uint8Array) => toHex(b) !== toHex(revote.ballotHash);
    expect(closeCheck([first, revote], 10n, undelivered)).toMatchObject({ status: "fail" });
    expect(closeCheck([revote], 10n, undelivered)).toEqual({ status: "pass", late: [1n] });
  });

  test("with no head the check is unchecked and never fails", () => {
    const r = closeCheck([ballot(0n, 1n, 5n, "ordinary", 50n)], null, all);
    expect(r).toEqual({ status: "unchecked", unchecked: [0n] });
  });
});
