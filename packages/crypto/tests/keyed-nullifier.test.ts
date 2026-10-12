import { babyjubjub } from "@noble/curves/misc.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BJJ_FIELD_ORDER,
  BJJ_G,
  BJJ_ORDER,
  type BjjPoint,
  bjjPoint,
  bjjPointOrIdentity,
  bjjScalar,
  challengeBjj,
  checkNullifierAnswer,
  combineAnswers,
  decode,
  DecodeError,
  decodeNullifierAnswer,
  encode,
  EncodeError,
  encodeNullifierAnswer,
  evaluate,
  GENERATOR_J,
  hashToScalarBjj,
  identityKey,
  bjjLagrangeAtZero,
  NULLIFIER_ANSWER,
  type NullifierAnswer,
  type NullifierKey,
  nullifierAnswerMessage,
  RECORD_TYPES,
  RecordSchema,
  shareCommitment,
  unblind,
  UNPINNED,
} from "../src/index.ts";
import { evaluateWith } from "../src/keyed-nullifier.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/keyed-nullifier.json comes from an independent Python
// implementation of docs/spec/keyed-nullifier.md (scripts/keyed-nullifier-
// vectors.py, with its own Baby Jubjub arithmetic, expand_message_xmd checked
// against RFC 9380 Appendix K.1, and P-256 ECDSA), so these values never come
// from the code under test.

interface CodecVector {
  readonly id: string;
  readonly type:
    | { readonly kind: "bjj-scalar" }
    | { readonly kind: "bjj-point"; readonly identity: "allowed" | "rejected" };
  readonly encoding: string;
  readonly value?: string | { readonly x: string; readonly y: string };
  readonly error?: string;
}

interface Vectors {
  readonly format: string;
  readonly tags: {
    readonly generatorJ: string;
    readonly evaluation: string;
    readonly answer: string;
  };
  readonly recordType: string;
  readonly version: number;
  readonly group: {
    readonly p: string;
    readonly l: string;
    readonly a: string;
    readonly d: string;
    readonly g: string;
    readonly j: string;
  };
  readonly codecs: readonly CodecVector[];
  readonly hashToScalar: readonly {
    readonly id: string;
    readonly dst: string;
    readonly message: string;
    readonly scalar: string;
  }[];
  readonly key: {
    readonly k: number;
    readonly n: number;
    readonly keyId: string;
    readonly sk: string;
    readonly dealers: readonly { readonly commitments: readonly string[] }[];
    readonly seats: readonly {
      readonly seat: number;
      readonly sk: string;
      readonly s: string;
      readonly commitment: string;
      readonly identitySecret: string;
      readonly identityKey: string;
    }[];
  };
  readonly queries: readonly {
    readonly id: string;
    readonly queryHash: string;
    readonly base: string;
    readonly r: string;
    readonly b: string;
  }[];
  readonly answers: readonly {
    readonly id: string;
    readonly query: string;
    readonly seat: number;
    readonly w1: string;
    readonly w2: string;
    readonly message: string;
    readonly record: string;
  }[];
  readonly combinations: readonly {
    readonly query: string;
    readonly seats: readonly number[];
    readonly lambdas: readonly string[];
    readonly z: string;
    readonly u: string;
  }[];
  readonly checks: readonly {
    readonly id: string;
    readonly query: string;
    readonly record: string;
    readonly result: string;
  }[];
  readonly decodeErrors: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("keyed-nullifier.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const point = (h: string): BjjPoint => decode(bjjPoint, hex(h));
const pointHex = (p: BjjPoint) => Buffer.from(encode(bjjPointOrIdentity, p)).toString("hex");
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

const key: NullifierKey = {
  keyId: hex(vectors.key.keyId),
  identityKeys: vectors.key.seats.map((s) => hex(s.identityKey)),
  commitments: vectors.key.seats.map((s) => point(s.commitment)),
};

const queries = new Map(
  vectors.queries.map((q) => [
    q.id,
    { queryHash: hex(q.queryHash), b: point(q.b), r: BigInt(q.r), base: point(q.base) },
  ]),
);

const query = (id: string) => {
  const q = queries.get(id);
  if (q === undefined) throw new Error(`no query ${id}`);
  return q;
};

const seatOf = (seat: number) => {
  const s = vectors.key.seats[seat - 1];
  if (s === undefined) throw new Error(`no seat ${seat}`);
  return s;
};

describe("keyed-nullifier.json", () => {
  test("format, tags and record type", () => {
    expect(vectors.format).toBe("abolish-keyed-nullifier-vectors/1");
    expect(vectors.tags).toEqual({
      generatorJ: "abolish/v1/keyed-nullifier/generator-j",
      evaluation: "abolish/v1/fs/keyed-nullifier/evaluation",
      answer: "abolish/v1/sig/nullifier-answer",
    });
    expect(Number(vectors.recordType)).toBe(RECORD_TYPES.nullifierAnswer);
    expect(vectors.version).toBe(1);
  });

  test("the group, G and J are the spec's", () => {
    expect(BJJ_FIELD_ORDER).toBe(BigInt(vectors.group.p));
    expect(BJJ_ORDER).toBe(BigInt(vectors.group.l));
    expect(babyjubjub.Point.CURVE().a).toBe(BigInt(vectors.group.a));
    expect(babyjubjub.Point.CURVE().d).toBe(BigInt(vectors.group.d));
    expect(pointHex(BJJ_G)).toBe(vectors.group.g);
    expect(pointHex(GENERATOR_J)).toBe(vectors.group.j);
    expect(GENERATOR_J.equals(BJJ_G) || GENERATOR_J.equals(BJJ_G.negate())).toBe(false);
    expect(GENERATOR_J.is0()).toBe(false);
  });

  test("the spec page's J matches the vectors", () => {
    const page = readFileSync(new URL("../keyed-nullifier.md", SPEC_VECTORS), "utf8");
    const x = /^J\.x = (\d+)$/m.exec(page)?.[1];
    const y = /^J\.y = (\d+)$/m.exec(page)?.[1];
    const { x: jx, y: jy } = GENERATOR_J.toAffine();
    expect([x, y]).toEqual([String(jx), String(jy)]);
  });

  test.each(vectors.codecs)("codec $id", (v) => {
    const codec =
      v.type.kind === "bjj-scalar"
        ? bjjScalar
        : v.type.identity === "allowed"
          ? bjjPointOrIdentity
          : bjjPoint;
    const bytes = hex(v.encoding);
    if (v.error !== undefined) {
      expect(() => decode(codec as typeof bjjScalar, bytes)).toThrow(DecodeError);
      try {
        decode(codec as typeof bjjScalar, bytes);
      } catch (e) {
        expect((e as DecodeError).code).toBe(v.error);
      }
      return;
    }
    if (v.type.kind === "bjj-scalar") {
      expect(decode(bjjScalar, bytes)).toBe(BigInt(v.value as string));
      expect(encode(bjjScalar, BigInt(v.value as string))).toEqual(bytes);
    } else {
      const want = v.value as { x: string; y: string };
      const p = decode(codec as typeof bjjPoint, bytes);
      expect(p.toAffine()).toEqual({ x: BigInt(want.x), y: BigInt(want.y) });
      expect(encode(codec as typeof bjjPoint, p)).toEqual(bytes);
    }
  });

  test.each(vectors.hashToScalar)("HashToScalarBJJ $id", ({ dst, message, scalar }) => {
    expect(hashToScalarBjj(hex(message), ascii(dst))).toBe(BigInt(scalar));
  });

  test("share commitments from the dealers' coefficient commitments", () => {
    const dealers = vectors.key.dealers.map((d) => d.commitments.map(point));
    for (const s of vectors.key.seats) {
      const c = shareCommitment(dealers, s.seat);
      expect(pointHex(c)).toBe(s.commitment);
      const opened = BJJ_G.multiply(BigInt(s.sk)).add(GENERATOR_J.multiply(BigInt(s.s)));
      expect(opened.equals(c)).toBe(true);
    }
  });

  test.each(vectors.answers)("answer $id re-made byte for byte", (a) => {
    const s = seatOf(a.seat);
    const answer = evaluateWith(
      key,
      query(a.query),
      { seat: a.seat, sk: BigInt(s.sk), s: BigInt(s.s) },
      hex(s.identitySecret),
      BigInt(a.w1),
      BigInt(a.w2),
    );
    expect(nullifierAnswerMessage(answer)).toEqual(hex(a.message));
    expect(encodeNullifierAnswer(answer)).toEqual(hex(a.record));
    expect(checkNullifierAnswer(key, query(a.query), hex(a.record))).toEqual({ ok: true, answer });
  });

  test.each(vectors.combinations)("combination of seats $seats for $query", (c) => {
    const q = query(c.query);
    const answers = c.seats.map((seat) => {
      const rec = vectors.answers.find((a) => a.query === c.query && a.seat === seat);
      return decodeNullifierAnswer(hex(rec?.record ?? ""), 1);
    });
    expect(c.seats.map((s) => bjjLagrangeAtZero(s, c.seats))).toEqual(c.lambdas.map(BigInt));
    const z = combineAnswers(answers, vectors.key.k);
    expect(pointHex(z)).toBe(c.z);
    expect(pointHex(unblind(z, q.r))).toBe(c.u);
    expect(z.equals(q.b.multiply(BigInt(vectors.key.sk)))).toBe(true);
    expect(unblind(z, q.r).equals(q.base.multiply(BigInt(vectors.key.sk)))).toBe(true);
  });

  test.each(vectors.checks)("answer check $id", (c) => {
    const r = checkNullifierAnswer(key, query(c.query), hex(c.record));
    expect(r.ok ? "ok" : r.code).toBe(c.result);
  });

  test.each(vectors.decodeErrors)("decode rejection $id", ({ encoding, error, offset }) => {
    // Unpinned, so a wrong version is `unknown-version`, as in the vector file.
    const schema = new RecordSchema([NULLIFIER_ANSWER]);
    try {
      schema.decode(NULLIFIER_ANSWER, hex(encoding), UNPINNED);
      expect.unreachable("decoded");
    } catch (e) {
      expect(e).toBeInstanceOf(DecodeError);
      expect([(e as DecodeError).code, (e as DecodeError).offset]).toEqual([error, offset]);
    }
  });
});

describe("keyed nullifier", () => {
  const scalarArb = fc.bigInt({ min: 1n, max: BJJ_ORDER - 1n });

  test("any k answers with valid proofs combine to sk · B, and unblind to sk · P", () => {
    fc.assert(
      fc.property(
        scalarArb,
        scalarArb,
        fc.shuffledSubarray([1, 2, 3, 4, 5], { minLength: 3, maxLength: 3 }),
        (m, r, seats) => {
          const base = BJJ_G.multiply(m);
          const q = { queryHash: hex(vectors.queries[0]?.queryHash ?? ""), b: base.multiply(r) };
          const answers = seats.map((seat) => {
            const s = seatOf(seat);
            const a = evaluate(
              key,
              q,
              { seat, sk: BigInt(s.sk), s: BigInt(s.s) },
              hex(s.identitySecret),
            );
            const checked = checkNullifierAnswer(key, q, encodeNullifierAnswer(a));
            expect(checked.ok).toBe(true);
            return a;
          });
          const z = combineAnswers(answers, 3);
          expect(z.equals(q.b.multiply(BigInt(vectors.key.sk)))).toBe(true);
          expect(unblind(z, r).equals(base.multiply(BigInt(vectors.key.sk)))).toBe(true);
        },
      ),
      { numRuns: Math.max(5, numRuns / 50) },
    );
  });

  test("any changed byte of an answer fails its check", () => {
    const rec = hex(vectors.answers[0]?.record ?? "");
    const q = query(vectors.answers[0]?.query ?? "");
    fc.assert(
      fc.property(fc.nat({ max: rec.length - 1 }), fc.integer({ min: 1, max: 255 }), (i, x) => {
        const bad = rec.slice();
        bad[i] = (bad[i] as number) ^ x;
        expect(checkNullifierAnswer(key, q, bad).ok).toBe(false);
      }),
      { numRuns: Math.max(20, numRuns / 10) },
    );
  });

  test("bjj codecs round-trip and reject what isn't canonical", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (b) => {
        try {
          expect(encode(bjjScalar, decode(bjjScalar, b))).toEqual(b);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
        }
      }),
      { numRuns },
    );
    fc.assert(
      fc.property(scalarArb, (s) => {
        const p = BJJ_G.multiply(s);
        expect(decode(bjjPoint, encode(bjjPoint, p)).equals(p)).toBe(true);
      }),
      { numRuns: Math.max(10, numRuns / 10) },
    );
    expect(() => encode(bjjPoint, babyjubjub.Point.ZERO)).toThrow(EncodeError);
    expect(() => encode(bjjScalar, BJJ_ORDER)).toThrow(EncodeError);
    // A point of the full group outside 𝔾: EIP-2494's generator.
    const gEip = babyjubjub.Point.fromAffine({
      x: 995203441582195749578291179787384436505546430278305826713579947235728471134n,
      y: 5472060717959818805561601436314318772137091100104008585924551046643952123905n,
    });
    expect(() => encode(bjjPointOrIdentity, gEip)).toThrow(EncodeError);
  });

  test("evaluation refuses a share its commitment doesn't open, and another seat's identity key", () => {
    const s = seatOf(2);
    const q = query("query-0");
    const share = { seat: 2, sk: BigInt(s.sk), s: BigInt(s.s) };
    expect(() =>
      evaluate(key, q, { ...share, sk: (share.sk + 1n) % BJJ_ORDER }, hex(s.identitySecret)),
    ).toThrow(RangeError);
    expect(() => evaluate(key, q, share, hex(seatOf(3).identitySecret))).toThrow(RangeError);
    expect(identityKey(hex(s.identitySecret))).toEqual(key.identityKeys[1]);
  });

  test("combination refuses too few, repeated or mismatched answers", () => {
    const rec = (id: string) =>
      decodeNullifierAnswer(hex(vectors.answers.find((a) => a.id === id)?.record ?? ""), 1);
    const [a1, a2, a3] = ["query-0-seat-1", "query-0-seat-2", "query-0-seat-3"].map(rec) as [
      NullifierAnswer,
      NullifierAnswer,
      NullifierAnswer,
    ];
    expect(() => combineAnswers([a1, a2], 3)).toThrow(RangeError);
    expect(() => combineAnswers([a1, a2, a2], 3)).toThrow(RangeError);
    expect(() => combineAnswers([a1, a2, rec("query-1-seat-3")], 3)).toThrow(RangeError);
    expect(combineAnswers([a3, a1, a2], 3).equals(combineAnswers([a1, a2, a3], 3))).toBe(true);
  });

  test("the Fiat–Shamir (Baby Jubjub) challenge takes only its own tags", () => {
    expect(() => challengeBjj("abolish/v1/fs/share-complaint" as never, new Uint8Array())).toThrow(
      RangeError,
    );
    expect(() => hashToScalarBjj(new Uint8Array(), new Uint8Array(15))).toThrow(RangeError);
  });
});
