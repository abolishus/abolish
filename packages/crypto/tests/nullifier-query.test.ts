import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BJJ_G,
  BJJ_ORDER,
  type BjjPoint,
  bjjPoint,
  checkNullifierOutput,
  checkNullifierQuery,
  decode,
  decodeNullifierOutput,
  decodeNullifierQuery,
  EncodeError,
  encodeNullifierAnswer,
  encodeNullifierOutput,
  encodeNullifierQuery,
  MAX_NULLIFIER_PROOF,
  NULLIFIER_OUTPUT,
  NULLIFIER_QUERY,
  type NullifierKey,
  type NullifierQuery,
  nullifierQueryContextField,
  nullifierQueryContextMessage,
  nullifierQueryHash,
  nullifierQueryHashField,
  nullifierQueryMessage,
  type NullifierQueryRecord,
  nullifierScopeField,
  outputCircuitPublicInputs,
  type QueryCheckContext,
  queryCircuitPublicInputs,
  RECORD_TYPES,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/nullifier-query.json comes from an independent Python
// implementation of docs/spec/nullifier-query.md (scripts/nullifier-query-
// vectors.py, over the Python sponge, H1, H2, Baby Jubjub arithmetic and
// answers of the keyed-nullifier generators), so these values never come from
// the code under test. Its proofs are stand-ins: the proof checks are the
// circuits' (P3-4 part 2b-3b-2b).

interface KeyVector {
  readonly keyId: string;
  readonly k: number;
  readonly n: number;
  readonly seats: readonly { readonly commitment: string; readonly signingKey: string }[];
}

interface Vectors {
  readonly format: string;
  readonly tags: { readonly queryContext: string; readonly query: string };
  readonly recordTypes: { readonly query: number; readonly output: number };
  readonly maxProofLength: number;
  readonly scope: {
    readonly l2ChainId: string;
    readonly groupRegistry: string;
    readonly sigma: string;
  };
  readonly tier2Groups: readonly string[];
  readonly key: KeyVector;
  readonly zeroKey: KeyVector;
  readonly queries: readonly {
    readonly id: string;
    readonly fields: {
      readonly keyId: string;
      readonly groupId: string;
      readonly commitment: string;
      readonly queryId: string;
      readonly commIn: string;
      readonly b: string;
      readonly proof: string;
    };
    readonly mCtx: string;
    readonly ctx: string;
    readonly mQuery: string;
    readonly queryHash: string;
    readonly q: string;
    readonly queryPublicInputs: readonly string[];
    readonly record: string;
  }[];
  readonly outputs: readonly {
    readonly id: string;
    readonly query: string;
    readonly answers: readonly { readonly seat: number; readonly record: string }[];
    readonly z: { readonly x: string; readonly y: string };
    readonly n: string;
    readonly outputPublicInputs: readonly string[];
    readonly record: string;
  }[];
  readonly zeroQuery: { readonly id: string; readonly queryHash: string; readonly b: string };
  readonly rejectedQueries: readonly {
    readonly id: string;
    readonly record: string;
    readonly code: string;
  }[];
  readonly rejectedOutputs: readonly {
    readonly id: string;
    readonly query: string;
    readonly key: string;
    readonly record: string;
    readonly code: string;
    readonly index?: number;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("nullifier-query.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const point = (h: string): BjjPoint => decode(bjjPoint, hex(h));
const big = (h: string) => BigInt(h);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const pointHex = (p: { readonly x: string; readonly y: string }) =>
  big(p.x).toString(16).padStart(64, "0") + big(p.y).toString(16).padStart(64, "0");

function keyOf(v: KeyVector): NullifierKey {
  return {
    keyId: hex(v.keyId),
    threshold: v.k,
    signingKeys: v.seats.map((s) => hex(s.signingKey)),
    commitments: v.seats.map((s) => point(s.commitment)),
  };
}

const KEY = keyOf(vectors.key);
const ZERO_KEY = keyOf(vectors.zeroKey);
const SIGMA = big(vectors.scope.sigma);
const tier2 = new Set(vectors.tier2Groups.map(BigInt));

const CONTEXT: QueryCheckContext = {
  keyId: KEY.keyId,
  l2ChainId: BigInt(vectors.scope.l2ChainId),
  groupRegistry: hex(vectors.scope.groupRegistry),
  isTier2Group: (id) => tier2.has(id),
};

const queryOf = (id: string): NullifierQuery => {
  if (id === vectors.zeroQuery.id)
    return { queryHash: hex(vectors.zeroQuery.queryHash), b: point(vectors.zeroQuery.b) };
  const q = vectors.queries.find((v) => v.id === id);
  if (q === undefined) throw new Error(`no query ${id}`);
  return { queryHash: hex(q.queryHash), b: point(q.fields.b) };
};

const goodQuery = vectors.queries[0];
if (goodQuery === undefined) throw new Error("no query vectors");
const GOOD_QUERY_BYTES = hex(goodQuery.record);
const GOOD_QUERY = decodeNullifierQuery(GOOD_QUERY_BYTES, 1);

describe("vector file", () => {
  test("names this page's tags, record types and proof bound", () => {
    expect(vectors.format).toBe("abolish-nullifier-query-vectors/1");
    expect(vectors.tags).toEqual({
      queryContext: "abolish/v1/keyed-nullifier/query-context",
      query: "abolish/v1/keyed-nullifier/query",
    });
    expect(vectors.recordTypes).toEqual({
      query: RECORD_TYPES.nullifierQuery,
      output: RECORD_TYPES.nullifierOutput,
    });
    expect(NULLIFIER_QUERY.recordType).toBe(0x001d);
    expect(NULLIFIER_OUTPUT.recordType).toBe(0x001e);
    expect(vectors.maxProofLength).toBe(MAX_NULLIFIER_PROOF);
  });

  test("σ is the scope field of the pinned chain and registry", () => {
    expect(nullifierScopeField(CONTEXT.l2ChainId, CONTEXT.groupRegistry)).toBe(SIGMA);
  });
});

describe("query record", () => {
  test.each(vectors.queries)("$id: context, query_hash and public inputs", (v) => {
    const bytes = hex(v.record);
    const q = decodeNullifierQuery(bytes, 1);
    expect(encodeNullifierQuery(q)).toEqual(bytes);
    expect(toHex(nullifierQueryContextMessage(q))).toBe(v.mCtx);
    expect(nullifierQueryContextField(q)).toBe(big(v.ctx));
    expect(toHex(nullifierQueryMessage(q))).toBe(v.mQuery);
    expect(toHex(nullifierQueryHash(q))).toBe(v.queryHash);
    expect(nullifierQueryHashField(hex(v.queryHash))).toBe(big(v.q));
    expect(queryCircuitPublicInputs(SIGMA, q)).toEqual(v.queryPublicInputs.map(big));
    // The record without its proof is m_query; m_ctx is its prefix.
    expect(toHex(bytes)).toMatch(new RegExp(`^${v.mQuery}`));
    expect(v.mQuery.startsWith(v.mCtx)).toBe(true);
  });

  test.each(vectors.queries)("$id passes the query check up to its proof", (v) => {
    const result = checkNullifierQuery(CONTEXT, hex(v.record));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(toHex(result.queryHash)).toBe(v.queryHash);
    expect(result.publicInputs).toEqual(v.queryPublicInputs.map(big));
  });

  test.each(vectors.rejectedQueries)("$id is refused with $code", (v) => {
    const result = checkNullifierQuery(CONTEXT, hex(v.record));
    expect(result).toEqual({ ok: false, code: v.code });
  });

  test("arbitrary bytes are refused, never thrown on", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (bytes) => {
        expect(checkNullifierQuery(CONTEXT, bytes).ok).toBe(false);
      }),
      { numRuns },
    );
  });

  test("every byte but the proof's is bound by query_hash, and only the context by ctx", () => {
    const statementLength = hex(goodQuery.mQuery).length;
    const contextLength = hex(goodQuery.mCtx).length;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: GOOD_QUERY_BYTES.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const bytes = Uint8Array.from(GOOD_QUERY_BYTES);
          bytes[at] = (bytes[at] ?? 0) ^ flip;
          const result = checkNullifierQuery(CONTEXT, bytes);
          if (!result.ok) return;
          const sameHash = toHex(result.queryHash) === goodQuery.queryHash;
          const sameCtx = result.publicInputs[1] === big(goodQuery.ctx);
          // A change inside the proof keeps the statement; any other change
          // that still decodes changes query_hash, and ctx exactly when it is
          // inside the context's fields.
          expect(sameHash).toBe(at >= statementLength);
          expect(sameCtx).toBe(at >= contextLength);
        },
      ),
      { numRuns },
    );
  });

  test("round-trips arbitrary well-formed queries", () => {
    const arbQuery = fc.record({
      key_id: fc.uint8Array({ minLength: 32, maxLength: 32 }),
      l2_chain_id: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
      group_registry: fc.uint8Array({ minLength: 20, maxLength: 20 }),
      group_id: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
      commitment: fc.bigInt({ min: 0n, max: SIGMA }),
      query_id: fc.uint8Array({ minLength: 32, maxLength: 32 }),
      comm_in: fc.bigInt({ min: 0n, max: SIGMA }),
      b: fc.bigInt({ min: 1n, max: BJJ_ORDER - 1n }).map((k) => BJJ_G.multiply(k)),
      proof: fc.uint8Array({ maxLength: 64 }),
    });
    fc.assert(
      fc.property(arbQuery, (q: NullifierQueryRecord) => {
        const bytes = encodeNullifierQuery(q);
        const back = decodeNullifierQuery(bytes, 1);
        expect(encodeNullifierQuery(back)).toEqual(bytes);
        expect(nullifierQueryHash(back)).toEqual(nullifierQueryHash(q));
      }),
      { numRuns },
    );
  });

  test("refuses to encode what the spec doesn't define", () => {
    const identity = BJJ_G.multiply(BJJ_ORDER - 1n).add(BJJ_G);
    expect(() => encodeNullifierQuery({ ...GOOD_QUERY, b: identity })).toThrow(EncodeError);
    expect(() =>
      encodeNullifierQuery({ ...GOOD_QUERY, proof: new Uint8Array(MAX_NULLIFIER_PROOF + 1) }),
    ).toThrow(EncodeError);
    expect(() => encodeNullifierQuery({ ...GOOD_QUERY, commitment: -1n })).toThrow(EncodeError);
    expect(() => nullifierQueryHashField(new Uint8Array(31))).toThrow(RangeError);
  });
});

describe("output record", () => {
  test.each(vectors.outputs)("$id passes the output check up to its proof", (v) => {
    const bytes = hex(v.record);
    const output = decodeNullifierOutput(bytes, 1);
    expect(encodeNullifierOutput(output)).toEqual(bytes);
    expect(output.answers.map((a) => toHex(encodeNullifierAnswer(a)))).toEqual(
      v.answers.slice(0, KEY.threshold).map((a) => a.record),
    );
    const query = queryOf(v.query);
    const result = checkNullifierOutput(KEY, query, bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const z = result.z.toAffine();
    expect([z.x, z.y]).toEqual([big(v.z.x), big(v.z.y)]);
    expect(outputCircuitPublicInputs(SIGMA, query, result.z, output.n)).toEqual(
      v.outputPublicInputs.map(big),
    );
  });

  test.each(vectors.rejectedOutputs)("$id is refused with $code", (v) => {
    const key = v.key === "zero-key" ? ZERO_KEY : KEY;
    const result = checkNullifierOutput(key, queryOf(v.query), hex(v.record));
    expect(result).toEqual(
      v.index === undefined
        ? { ok: false, code: v.code }
        : { ok: false, code: v.code, index: v.index },
    );
  });

  test("arbitrary bytes are refused, never thrown on", () => {
    const query = queryOf(goodQuery.id);
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 1200 }), (bytes) => {
        expect(checkNullifierOutput(KEY, query, bytes).ok).toBe(false);
      }),
      { numRuns },
    );
  });

  test("every k-subset of a query's answers gives the same Z", () => {
    const v = vectors.outputs[0];
    if (v === undefined) throw new Error("no output vectors");
    const base = decodeNullifierOutput(hex(v.record), 1);
    const all = v.answers.map((a) => hex(a.record));
    const query = queryOf(v.query);
    const zs = [
      [0, 1],
      [0, 2],
      [1, 2],
    ].map(([i = 0, j = 0]) => {
      const result = checkNullifierOutput(KEY, query, withAnswers(base, [all[i], all[j]]));
      if (!result.ok) throw new Error(`seats ${i + 1} and ${j + 1}: ${result.code}`);
      return result.z;
    });
    for (const z of zs) expect(z.equals(point(pointHex(v.z)))).toBe(true);
  });
});

function withAnswers(
  base: ReturnType<typeof decodeNullifierOutput>,
  answers: readonly (Uint8Array | undefined)[],
): Uint8Array {
  // Splices answer records into an output's bytes, so the test builds outputs
  // from the vectors' own answer bytes rather than from decoded values.
  const head = encodeNullifierOutput({ ...base, answers: [] });
  const prefix = head.subarray(0, 3 + 32);
  const rest = head.subarray(3 + 32 + 4);
  const count = new Uint8Array([0, 0, 0, answers.length]);
  return Uint8Array.from([...prefix, ...count, ...answers.flatMap((a) => [...(a ?? [])]), ...rest]);
}
