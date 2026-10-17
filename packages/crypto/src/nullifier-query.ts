// A client's Tier 2 keyed-nullifier query and output (docs/spec/nullifier-query.md;
// docs/adr/0022-tier2-keyed-nullifier.md, Query and Attestation): the query
// record (0x001d) with its context field `ctx` and `query_hash`, the output
// record (0x001e), both circuits' public inputs in order, and the query and
// output checks up to their proofs. The proofs themselves are verified by the
// circuits' verifier against the public inputs built here (P3-4 part 2b-3b-2b).

import {
  bytesFixed,
  bytesVar,
  type Codec,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  fieldBn254,
  list,
  struct,
  u8,
  u16,
  u64,
  Writer,
} from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";
import { isForbiddenCommitment } from "./group-registry.ts";
import {
  type AnswerCode,
  bjjPoint,
  type BjjPoint,
  checkNullifierAnswer,
  combineAnswers,
  decodeNullifierAnswer,
  encodeNullifierAnswer,
  type NullifierAnswer,
  type NullifierKey,
  type NullifierQuery,
  nullifierScopeField,
} from "./keyed-nullifier.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { MAX_TRUSTEES } from "./trustee.ts";

const VERSION = 1;

/**
 * The bound on a proof's encoded length. It only keeps decoding finite: the
 * proving system fixes a proof's length, and the proof check refuses any other.
 */
export const MAX_NULLIFIER_PROOF = 65536;

/** A nullifier answer record (0x0010, version 1) is always this long. */
const ANSWER_LENGTH = 356;

const contextFields = [
  ["key_id", bytesFixed(32)],
  ["l2_chain_id", u64],
  ["group_registry", bytesFixed(20)],
  ["group_id", u64],
  ["commitment", fieldBn254],
  ["query_id", bytesFixed(32)],
] as const;

const statementFields = [...contextFields, ["comm_in", fieldBn254], ["b", bjjPoint]] as const;

const contextV1 = struct(contextFields);

const statementV1 = struct(statementFields);

const queryV1 = struct([...statementFields, ["proof", bytesVar(MAX_NULLIFIER_PROOF)]] as const);

/** A client's query, version 1 (docs/spec/nullifier-query.md, Query record). */
export type NullifierQueryRecord = CodecValue<typeof queryV1>;

/** What the query's context and `query_hash` cover: the record without its proof. */
export type NullifierQueryStatement = CodecValue<typeof statementV1>;

/**
 * An answer record inside an output: exactly 356 bytes, decoded strictly as
 * version 1, the version the Tier 2 key fixes. A failure keeps the answer's
 * own code, at its offset in the output.
 */
const embeddedAnswer: Codec<NullifierAnswer> = {
  minLength: ANSWER_LENGTH,
  write(w, value) {
    w.bytes(encodeNullifierAnswer(value));
  },
  read(r) {
    const at = r.offset;
    const bytes = r.take(ANSWER_LENGTH);
    try {
      return decodeNullifierAnswer(bytes, 1);
    } catch (e) {
      if (e instanceof DecodeError) throw new DecodeError(e.code, at + e.offset);
      throw e;
    }
  },
};

const outputV1 = struct([
  ["query_hash", bytesFixed(32)],
  ["answers", list(embeddedAnswer, MAX_TRUSTEES)],
  ["n", fieldBn254],
  ["proof", bytesVar(MAX_NULLIFIER_PROOF)],
] as const);

/** A client's output, version 1 (docs/spec/nullifier-query.md, Output record). */
export type NullifierOutputRecord = CodecValue<typeof outputV1>;

/** Record type `0x001d`. Never on the board; the Tier 2 key fixes its version. */
export const NULLIFIER_QUERY = recordType(RECORD_TYPES.nullifierQuery, { 1: queryV1 });

/** Record type `0x001e`. Never on the board; the Tier 2 key fixes its version. */
export const NULLIFIER_OUTPUT = recordType(RECORD_TYPES.nullifierOutput, { 1: outputV1 });

const SCHEMA = new RecordSchema([NULLIFIER_QUERY, NULLIFIER_OUTPUT]);

export function encodeNullifierQuery(query: NullifierQueryRecord): Uint8Array {
  return SCHEMA.encode(NULLIFIER_QUERY, 1, query);
}

/** Strictly decodes a query under version 1, the version the Tier 2 key fixes. */
export function decodeNullifierQuery(bytes: Uint8Array, pinned: 1): NullifierQueryRecord {
  return SCHEMA.decode(NULLIFIER_QUERY, bytes, pinned).value;
}

export function encodeNullifierOutput(output: NullifierOutputRecord): Uint8Array {
  return SCHEMA.encode(NULLIFIER_OUTPUT, 1, output);
}

/** Strictly decodes an output, and each answer in it, under version 1. */
export function decodeNullifierOutput(bytes: Uint8Array, pinned: 1): NullifierOutputRecord {
  return SCHEMA.decode(NULLIFIER_OUTPUT, bytes, pinned).value;
}

function header(w: Writer): void {
  u16.write(w, RECORD_TYPES.nullifierQuery);
  u8.write(w, VERSION);
}

/**
 * `m_ctx = u16(0x001d) ‖ u8(1) ‖ key_id ‖ u64(l2_chain_id) ‖ group_registry ‖
 * u64(group_id) ‖ commitment ‖ query_id`. Read through the struct, so only
 * these fields are taken even from a whole record.
 */
export function nullifierQueryContextMessage(query: NullifierQueryStatement): Uint8Array {
  const w = new Writer();
  header(w);
  contextV1.write(w, {
    key_id: query.key_id,
    l2_chain_id: query.l2_chain_id,
    group_registry: query.group_registry,
    group_id: query.group_id,
    commitment: query.commitment,
    query_id: query.query_id,
  });
  return w.finish();
}

/** `m_query = m_ctx ‖ comm_in ‖ encode(b)`: the record without its proof. */
export function nullifierQueryMessage(query: NullifierQueryStatement): Uint8Array {
  const w = new Writer();
  header(w);
  statementV1.write(w, {
    key_id: query.key_id,
    l2_chain_id: query.l2_chain_id,
    group_registry: query.group_registry,
    group_id: query.group_id,
    commitment: query.commitment,
    query_id: query.query_id,
    comm_in: query.comm_in,
    b: query.b,
  });
  return w.finish();
}

/** A digest read big-endian and shifted right by 8 bits, so it is below BN254's `r`. */
function digestField(digest: Uint8Array): bigint {
  let v = 0n;
  for (const b of digest) v = (v << 8n) | BigInt(b);
  return v >> 8n;
}

/**
 * `ctx = int(H(DS("abolish/v1/keyed-nullifier/query-context", m_ctx))) >> 8`:
 * the query circuit's public input binding its proof to the key, the scope,
 * the group, the commitment and the query identifier (T-21, T-30).
 */
export function nullifierQueryContextField(query: NullifierQueryStatement): bigint {
  return digestField(
    H(ds("abolish/v1/keyed-nullifier/query-context", nullifierQueryContextMessage(query))),
  );
}

/**
 * `query_hash = H(DS("abolish/v1/keyed-nullifier/query", m_query))`: the
 * query's name, which every seat's answer signs. It doesn't cover the proof.
 */
export function nullifierQueryHash(query: NullifierQueryStatement): Uint8Array {
  return H(ds("abolish/v1/keyed-nullifier/query", nullifierQueryMessage(query)));
}

/** `q = int(query_hash) >> 8`, the output circuit's public input naming the query. */
export function nullifierQueryHashField(queryHash: Uint8Array): bigint {
  if (!(queryHash instanceof Uint8Array) || queryHash.length !== 32)
    throw new RangeError("nullifierQueryHashField: query_hash must be 32 bytes");
  return digestField(queryHash);
}

/** The query circuit's public inputs, in order: `σ`, `ctx`, `comm_in`, `B.x`, `B.y`. */
export function queryCircuitPublicInputs(
  sigma: bigint,
  query: NullifierQueryStatement,
): readonly bigint[] {
  const b = query.b.toAffine();
  return [sigma, nullifierQueryContextField(query), query.comm_in, b.x, b.y];
}

/**
 * The output circuit's public inputs, in order: `σ`, `q`, `B.x`, `B.y`,
 * `Z.x`, `Z.y`, `N`, with `Z` the attester's own combination.
 */
export function outputCircuitPublicInputs(
  sigma: bigint,
  query: NullifierQuery,
  z: BjjPoint,
  n: bigint,
): readonly bigint[] {
  const b = query.b.toAffine();
  const zz = z.toAffine();
  return [sigma, nullifierQueryHashField(query.queryHash), b.x, b.y, zz.x, zz.y, n];
}

/** What a seat checks a query against: its own pins and key, never the query's values. */
export interface QueryCheckContext {
  /** `key_id` of the key the seat holds a share of. */
  readonly keyId: Uint8Array;
  /** The release's pinned L2 chain ID. */
  readonly l2ChainId: bigint;
  /** The release's pinned group registry address, 20 bytes. */
  readonly groupRegistry: Uint8Array;
  /**
   * Whether a group of the registry has tier 2, in the seat's view of the
   * registry's finalized history.
   */
  readonly isTier2Group: (groupId: bigint) => boolean;
}

export type QueryCode =
  | DecodeErrorCode
  | "query-key"
  | "query-scope"
  | "query-group"
  | "query-commitment";

export type QueryResult =
  | {
      readonly ok: true;
      readonly query: NullifierQueryRecord;
      readonly queryHash: Uint8Array;
      /** For the proof check: `σ`, `ctx`, `comm_in`, `B.x`, `B.y`. */
      readonly publicInputs: readonly bigint[];
    }
  | { readonly ok: false; readonly code: QueryCode };

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The query check (docs/spec/nullifier-query.md, Query check) up to
 * `query-proof`, in its order. `ok` means only that the query may go on to its
 * proof, which the caller verifies against `publicInputs` under the pinned
 * query-circuit key, and then to the identity chain's checks (part 2b-4); a
 * seat answers only after both (T-21).
 */
export function checkNullifierQuery(context: QueryCheckContext, bytes: Uint8Array): QueryResult {
  let query: NullifierQueryRecord;
  try {
    query = decodeNullifierQuery(bytes, 1);
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: e.code };
    throw e;
  }
  if (!sameBytes(query.key_id, context.keyId)) return { ok: false, code: "query-key" };
  if (
    query.l2_chain_id !== context.l2ChainId ||
    !sameBytes(query.group_registry, context.groupRegistry)
  )
    return { ok: false, code: "query-scope" };
  if (!context.isTier2Group(query.group_id)) return { ok: false, code: "query-group" };
  if (isForbiddenCommitment(query.commitment)) return { ok: false, code: "query-commitment" };
  // σ from the pins, which the query has just been checked to name.
  const sigma = nullifierScopeField(context.l2ChainId, context.groupRegistry);
  return {
    ok: true,
    query,
    queryHash: nullifierQueryHash(query),
    publicInputs: queryCircuitPublicInputs(sigma, query),
  };
}

export type OutputCode =
  | DecodeErrorCode
  | "output-query"
  | "output-answers"
  | Exclude<AnswerCode, DecodeErrorCode>
  | "output-combination";

export type OutputResult =
  | {
      readonly ok: true;
      readonly output: NullifierOutputRecord;
      /** `Z = sk · B`, combined from the answers by the attester itself. */
      readonly z: BjjPoint;
    }
  | {
      readonly ok: false;
      readonly code: OutputCode;
      /** For an answer's own code: the answer's index in the record. */
      readonly index?: number;
    };

/**
 * The output check (docs/spec/nullifier-query.md, Output check) up to
 * `output-proof`, in its order, against the key's checked transcript and the
 * query the attester checked. `ok` means the output may go on to its proof,
 * which the caller verifies against `outputCircuitPublicInputs(σ, query, z,
 * output.n)` under the pinned output-circuit key.
 */
export function checkNullifierOutput(
  key: NullifierKey,
  query: NullifierQuery,
  bytes: Uint8Array,
): OutputResult {
  let output: NullifierOutputRecord;
  try {
    output = decodeNullifierOutput(bytes, 1);
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: e.code };
    throw e;
  }
  if (!sameBytes(output.query_hash, query.queryHash)) return { ok: false, code: "output-query" };
  const { answers } = output;
  // k from the key's transcript, never from the record: fewer answers combine
  // to a Z the client can compute itself (T-03).
  if (answers.length !== key.threshold) return { ok: false, code: "output-answers" };
  for (let i = 1; i < answers.length; i++)
    if ((answers[i - 1] as NullifierAnswer).seat >= (answers[i] as NullifierAnswer).seat)
      return { ok: false, code: "output-answers" };
  for (const [index, answer] of answers.entries()) {
    const result = checkNullifierAnswer(key, query, encodeNullifierAnswer(answer));
    // Each answer decoded strictly inside the output, so only the answer
    // check's own codes remain.
    if (!result.ok) return { ok: false, code: result.code as OutputCode, index };
  }
  // The answers are checked, k of them, from distinct qualified seats of this
  // key and query, so the identity is the only combination combineAnswers
  // refuses.
  let z: BjjPoint;
  try {
    z = combineAnswers(key, answers);
  } catch (e) {
    if (e instanceof RangeError) return { ok: false, code: "output-combination" };
    throw e;
  }
  return { ok: true, output, z };
}
