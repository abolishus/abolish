// The Tier 2 keyed nullifier's query and output with their proofs
// (docs/spec/nullifier-query.md): the client proves both circuits, a seat
// checks a query through `query-proof` and answers only a query it checked,
// and an attester checks an output through `output-proof`. The records'
// codecs and the checks before each proof are packages/crypto's; this adds
// the proofs, which need Barretenberg (P3-4 part 2b-3b-2b-2b).

import {
  BJJ_G,
  BJJ_ORDER,
  type BjjPoint,
  bjjPoint,
  checkNullifierAnswer,
  checkNullifierOutput,
  checkNullifierQuery,
  combineAnswers,
  decode,
  encodeNullifierAnswer,
  evaluate,
  type NullifierAnswer,
  type NullifierKey,
  type NullifierOutputRecord,
  type NullifierQueryRecord,
  nullifierQueryContextField,
  nullifierQueryHash,
  nullifierQueryHashField,
  nullifierScopeField,
  type OutputCode,
  outputCircuitPublicInputs,
  type QueryCheckContext,
  type QueryCode,
  type SeatShare,
  unblind,
} from "@abolishus/crypto";
import type { NullifierProofs } from "./proofs.ts";

const toHex = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;

function pointFromFields(x: bigint, y: bigint): BjjPoint {
  const bytes = new Uint8Array(64);
  for (let i = 31, a = x, b = y; i >= 0; i--, a >>= 8n, b >>= 8n) {
    bytes[i] = Number(a & 0xffn);
    bytes[32 + i] = Number(b & 0xffn);
  }
  // In 𝔾 and not the identity, or this throws.
  return decode(bjjPoint, bytes);
}

/** A scalar uniform on 1 to l − 1, from 64 CSPRNG bytes reduced mod l. */
function randomScalar(): bigint {
  for (;;) {
    let v = 0n;
    for (const b of crypto.getRandomValues(new Uint8Array(64))) v = (v << 8n) | BigInt(b);
    v %= BJJ_ORDER;
    if (v !== 0n) return v;
  }
}

/** The query's fields the client chooses; `query_id` is drawn fresh for each query. */
export type QueryFields = Omit<NullifierQueryRecord, "query_id" | "b" | "proof">;

/** What opens `comm_in`'s fifth slot and the rest for the query circuit; never leaves the device. */
export interface QueryOpening {
  /** `d_1` to `d_4`, the salted hashes of the commitment's first four slots. */
  readonly d: readonly [bigint, bigint, bigint, bigint];
  /** `s_x`, the private nullifier's salt. */
  readonly saltX: bigint;
  /** `x`, zkPassport's private nullifier. */
  readonly x: bigint;
}

/** A proved query, with the blinding scalar the output needs. */
export interface ProvedQuery {
  readonly record: NullifierQueryRecord;
  /** `r`: the client keeps it secret, for unblinding and the output proof. */
  readonly r: bigint;
}

/**
 * Internal: a query with the given `query_id` and `r`. Production code calls
 * `proveQuery`; the package entry point doesn't export this.
 */
export async function proveQueryWith(
  proofs: NullifierProofs,
  fields: QueryFields,
  opening: QueryOpening,
  queryId: Uint8Array,
  r: bigint,
): Promise<ProvedQuery> {
  const sigma = nullifierScopeField(fields.l2_chain_id, fields.group_registry);
  // ctx covers the context fields only; the statement type also has `b`,
  // which the circuit outputs, so a stand-in point fills it here.
  const ctx = nullifierQueryContextField({ ...fields, query_id: queryId, b: BJJ_G });
  const { publicInputs, proof } = await proofs.prove("nullifier_query", {
    sigma: toHex(sigma),
    ctx: toHex(ctx),
    comm_in: toHex(fields.comm_in),
    d: opening.d.map(toHex),
    s_x: toHex(opening.saltX),
    x: toHex(opening.x),
    r: toHex(r),
  });
  const [s, c, commIn, bx, by] = publicInputs as [bigint, bigint, bigint, bigint, bigint];
  if (s !== sigma || c !== ctx || commIn !== fields.comm_in)
    throw new Error("proveQuery: the proof's public inputs aren't the query's");
  return {
    record: { ...fields, query_id: Uint8Array.from(queryId), b: pointFromFields(bx, by), proof },
    r,
  };
}

/**
 * The client's query (docs/spec/nullifier-query.md, The query): `r` and
 * `query_id` fresh from the CSPRNG for every query, never reused, and the
 * query proof, whose execution gives `B = r · H1(σ, x)`. The circuit refuses
 * an opening that doesn't open `comm_in`, and a zero `x` or `s_x`.
 */
export function proveQuery(
  proofs: NullifierProofs,
  fields: QueryFields,
  opening: QueryOpening,
): Promise<ProvedQuery> {
  return proveQueryWith(
    proofs,
    fields,
    opening,
    crypto.getRandomValues(new Uint8Array(32)),
    randomScalar(),
  );
}

/**
 * The client's output (docs/spec/nullifier-query.md, The output): the `k`
 * answers, each checked as an attester will check it, combined to
 * `Z = sk · B` and unblinded to `U = r⁻¹ · Z`, then the output proof, whose
 * execution gives `N = H2(σ, x, U)`. `U`, `x` and `r` stay on the device.
 */
export async function proveOutput(
  proofs: NullifierProofs,
  key: NullifierKey,
  proved: ProvedQuery,
  x: bigint,
  answers: readonly NullifierAnswer[],
): Promise<NullifierOutputRecord> {
  const { record, r } = proved;
  const query = { queryHash: nullifierQueryHash(record), b: record.b };
  const sorted = [...answers].sort((a, b) => a.seat - b.seat);
  for (const answer of sorted) {
    const result = checkNullifierAnswer(key, query, encodeNullifierAnswer(answer));
    if (!result.ok) throw new RangeError(`proveOutput: seat ${answer.seat}: ${result.code}`);
  }
  const z = combineAnswers(key, sorted);
  const u = unblind(z, r).toAffine();
  const zz = z.toAffine();
  const b = record.b.toAffine();
  const sigma = nullifierScopeField(record.l2_chain_id, record.group_registry);
  const q = nullifierQueryHashField(query.queryHash);
  const { publicInputs, proof } = await proofs.prove("nullifier_output", {
    sigma: toHex(sigma),
    q: toHex(q),
    b_x: toHex(b.x),
    b_y: toHex(b.y),
    z_x: toHex(zz.x),
    z_y: toHex(zz.y),
    x: toHex(x),
    r: toHex(r),
    u_x: toHex(u.x),
    u_y: toHex(u.y),
  });
  const n = publicInputs[6] as bigint;
  const expected = outputCircuitPublicInputs(sigma, query, z, n);
  if (publicInputs.some((v, i) => v !== expected[i]))
    throw new Error("proveOutput: the proof's public inputs aren't the output's");
  return { query_hash: query.queryHash, answers: sorted, n, proof };
}

/**
 * Registers each query that passed its check, proof included, so only those
 * can be answered or have an output checked against them: a plain object with
 * the same fields isn't one (T-21).
 */
const checkedQueries = new WeakSet<CheckedQuery>();

/** A query that passed the whole query check, `query-proof` included. */
export interface CheckedQuery {
  readonly query: NullifierQueryRecord;
  readonly queryHash: Uint8Array;
  readonly b: BjjPoint;
  /** `σ`, recomputed from the seat's pins. */
  readonly sigma: bigint;
}

export type CheckedQueryResult =
  | { readonly ok: true; readonly query: CheckedQuery }
  | { readonly ok: false; readonly code: QueryCode | "query-proof" };

/**
 * The query check (docs/spec/nullifier-query.md, Query check), in its order:
 * packages/crypto's checks, then `query-proof` under the pinned query-circuit
 * key with the public inputs those checks built from the seat's pins and the
 * record. The identity chain's checks (part 2b-4) come before an answer too.
 */
export async function checkQuery(
  proofs: NullifierProofs,
  context: QueryCheckContext,
  bytes: Uint8Array,
): Promise<CheckedQueryResult> {
  const result = checkNullifierQuery(context, bytes);
  if (!result.ok) return result;
  if (!(await proofs.verify("nullifier_query", result.publicInputs, result.query.proof)))
    return { ok: false, code: "query-proof" };
  const query: CheckedQuery = Object.freeze({
    query: result.query,
    queryHash: result.queryHash,
    b: result.query.b,
    sigma: result.publicInputs[0] as bigint,
  });
  checkedQueries.add(query);
  return { ok: true, query };
}

function assertChecked(query: CheckedQuery, what: string): void {
  // Without the query proof, answers are a static Diffie–Hellman oracle
  // (docs/spec/keyed-nullifier.md, Security notes; T-21).
  if (!checkedQueries.has(query)) throw new TypeError(`${what}: the query wasn't checked here`);
}

/**
 * Seat `share.seat`'s answer (docs/spec/keyed-nullifier.md, Evaluation) to a
 * query `checkQuery` passed, and nothing else.
 */
export function answerQuery(
  key: NullifierKey,
  query: CheckedQuery,
  share: SeatShare,
  signingSecret: Uint8Array,
): NullifierAnswer {
  assertChecked(query, "answerQuery");
  return evaluate(key, query, share, signingSecret);
}

export type CheckedOutputResult =
  | { readonly ok: true; readonly output: NullifierOutputRecord; readonly z: BjjPoint }
  | {
      readonly ok: false;
      readonly code: OutputCode | "output-proof";
      /** For an answer's own code: the answer's index in the record. */
      readonly index?: number;
    };

/**
 * The output check (docs/spec/nullifier-query.md, Output check), in its
 * order, against a query `checkQuery` passed and the key's transcript:
 * packages/crypto's checks, then `output-proof` with `σ` from the pins, `q`
 * and `B` from the checked query and `Z` from the attester's own combination.
 */
export async function checkOutput(
  proofs: NullifierProofs,
  key: NullifierKey,
  query: CheckedQuery,
  bytes: Uint8Array,
): Promise<CheckedOutputResult> {
  assertChecked(query, "checkOutput");
  const result = checkNullifierOutput(key, query, bytes);
  if (!result.ok) return result;
  const publicInputs = outputCircuitPublicInputs(query.sigma, query, result.z, result.output.n);
  if (!(await proofs.verify("nullifier_output", publicInputs, result.output.proof)))
    return { ok: false, code: "output-proof" };
  return result;
}
