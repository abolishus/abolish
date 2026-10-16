// The author approvals record (docs/spec/ceremony.md, Author panel, record
// type 0x0019): an author panel's approvals of its ceremony transcript,
// which no contract records, so every reader counts them itself from the
// definition and its own transcript check. The check stands in for the
// trustee registry's quorum: a default seat runs it before lending its keys
// (Stub checks, step 5), every seat before intake, the ballot client before
// any share and the verifier in 3.1 (T-17, T-37, T-54).

import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  list,
  struct,
  u8,
} from "./codec.ts";
import { checkedTranscriptHash, keySetEntry, keySetHash, type RegisteredKeys } from "./ceremony.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { type Panel, p256Sig, verifyAuthorCeremonyRegistration } from "./trustee.ts";

const { MAX_TRUSTEES } = PARAMETERS;

const approvalsV1 = struct([
  ["transcript_hash", bytesFixed(32)],
  [
    "approvals",
    list(
      struct([
        ["index", u8],
        ["signature", p256Sig],
      ] as const),
      MAX_TRUSTEES,
    ),
  ],
] as const);

/** Author approvals, version 1: `39 + 65·c` bytes for `c` approvals. */
export type AuthorApprovals = CodecValue<typeof approvalsV1>;

/**
 * Record type `0x0019`. No profile pins it: board-entry version 7, which
 * allows it, fixes version 1, so any other version is `profile-mismatch`.
 */
export const AUTHOR_APPROVALS = recordType(RECORD_TYPES.authorApprovals, { 1: approvalsV1 });

const SCHEMA = new RecordSchema([AUTHOR_APPROVALS]);

export function encodeAuthorApprovals(record: AuthorApprovals): Uint8Array {
  return SCHEMA.encode(AUTHOR_APPROVALS, 1, record);
}

/** Strictly decodes an author approvals record under version 1; needs no context. */
export function decodeAuthorApprovals(bytes: Uint8Array, pinned: 1): AuthorApprovals {
  return SCHEMA.decode(AUTHOR_APPROVALS, bytes, pinned).value;
}

/**
 * What an author approval is rebuilt from: the stub (or registered
 * definition) and the checker's own transcript check. Never the record's
 * own claims, so an approval can't name a key set, stub or panel of its own.
 */
export interface AuthorApprovalContext {
  readonly l2ChainId: bigint;
  readonly trusteeRegistry: Uint8Array;
  /** `author_stub_hash`, recomputed from the stub. */
  readonly authorStubHash: Uint8Array;
  /** The definition's `author_threshold` and `author_keys`. */
  readonly panel: Panel;
  /** The definition's `author_transcript_hash`. */
  readonly authorTranscriptHash: Uint8Array;
  /**
   * The registered key set `checkCeremonyTranscript` returned for the author
   * transcript, run with `panelKind: "author"`; no other set is accepted.
   */
  readonly registered: readonly RegisteredKeys[];
}

/** Why a set of approvals records doesn't approve the author transcript. */
export type AuthorApprovalsCode =
  | "ceremony-participation"
  | "author-approvals"
  | "author-approvals-missing";

export type AuthorApprovalsCheck =
  | { readonly ok: true; readonly seats: readonly number[] }
  | { readonly ok: false; readonly code: AuthorApprovalsCode; readonly seats?: readonly number[] };

interface Prepared {
  readonly ctx: AuthorApprovalContext;
  readonly keySet: Uint8Array;
  readonly n: number;
  readonly quorum: number;
}

// Each field read once; the key set must be one the transcript check
// returned for the definition's author transcript (T-37).
function prepare(input: AuthorApprovalContext): Prepared {
  if (input === null || typeof input !== "object")
    throw new TypeError("author approvals: expected a context");
  const { l2ChainId, trusteeRegistry, authorStubHash, panel, authorTranscriptHash, registered } =
    input;
  if (panel === null || typeof panel !== "object" || !Array.isArray(panel.keys))
    throw new TypeError("author approvals: expected the author panel");
  const transcript = Array.isArray(registered) ? checkedTranscriptHash(registered) : undefined;
  if (transcript === undefined || !equalBytes(transcript, authorTranscriptHash))
    throw new RangeError(
      "author approvals: the key set must come from checkCeremonyTranscript on the author transcript",
    );
  const panelCopy = { threshold: panel.threshold, keys: panel.keys.map((k) => Uint8Array.from(k)) };
  const n = panelCopy.keys.length;
  return {
    ctx: {
      l2ChainId,
      trusteeRegistry,
      authorStubHash,
      panel: panelCopy,
      authorTranscriptHash: transcript,
      registered,
    },
    keySet: keySetHash(registered.map(keySetEntry)),
    n,
    // q_A = max(k_A, n_A − 1): rule 7 per panel, the approval quorum and the
    // participation every approved transcript needs (T-54).
    quorum: Math.max(panelCopy.threshold, n - 1),
  };
}

function decoded(bytes: Uint8Array): AuthorApprovals | DecodeError {
  try {
    return decodeAuthorApprovals(bytes, 1);
  } catch (e) {
    if (e instanceof DecodeError) return e;
    throw e;
  }
}

// The seats whose approvals in one record count, or null when the record's
// seats aren't strictly increasing within 1 to n_A, which spoils all of it.
function counting(p: Prepared, record: AuthorApprovals): number[] | null {
  let previous = 0;
  for (const { index } of record.approvals) {
    if (index <= previous || index > p.n) return null;
    previous = index;
  }
  const { l2ChainId, trusteeRegistry, authorStubHash, panel, authorTranscriptHash } = p.ctx;
  return record.approvals
    .filter(({ index, signature }) =>
      verifyAuthorCeremonyRegistration(
        panel,
        {
          l2ChainId,
          trusteeRegistry,
          index,
          stubHash: authorStubHash,
          ceremonyTranscriptHash: authorTranscriptHash,
          keySetHash: p.keySet,
        },
        signature,
      ),
    )
    .map((a) => a.index);
}

/**
 * Author panel, Check: whether `records` approve the author transcript. A
 * transcript with fewer than `q_A` qualified seats is refused whatever the
 * records (`ceremony-participation`). Otherwise every record that decodes
 * strictly and names the transcript is counted, each seat once however
 * many valid signatures it has; it approves with at least `q_A` seats. With
 * none naming the transcript the check is `author-approvals-missing` (the
 * copy may lack them); with some that fall short, `author-approvals`.
 */
export function checkAuthorApprovals(
  context: AuthorApprovalContext,
  records: readonly Uint8Array[],
): AuthorApprovalsCheck {
  const p = prepare(context);
  if (p.ctx.registered.length < p.quorum) return { ok: false, code: "ceremony-participation" };
  let named = false;
  const counted = new Set<number>();
  for (const bytes of records) {
    const record = decoded(bytes);
    if (record instanceof DecodeError) continue;
    if (!equalBytes(record.transcript_hash, p.ctx.authorTranscriptHash)) continue;
    named = true;
    for (const seat of counting(p, record) ?? []) counted.add(seat);
  }
  const seats = [...counted].sort((a, b) => a - b);
  if (seats.length >= p.quorum) return { ok: true, seats };
  return { ok: false, code: named ? "author-approvals" : "author-approvals-missing", seats };
}

/** Why the operator refuses to board an approvals record (Author panel, Boarding). */
export type AuthorApprovalsRefusal =
  | DecodeErrorCode
  | "transcript"
  | "seats"
  | "signature"
  | "quorum"
  | "boarded";

/**
 * The operator's boarding rule: a record is boarded only if it decodes,
 * names the definition's `author_transcript_hash`, its seats are strictly
 * increasing within 1 to `n_A`, every approval in it counts, they number at
 * least `q_A`, and no approvals record is on the board yet (`boarded`). A
 * boarded record then carries no chosen bytes beyond its seats' ECDSA nonces
 * (T-17). Returns `undefined` when it may be boarded.
 */
export function authorApprovalsRefusal(
  context: AuthorApprovalContext,
  bytes: Uint8Array,
  boarded: boolean,
): AuthorApprovalsRefusal | undefined {
  const p = prepare(context);
  const record = decoded(bytes);
  if (record instanceof DecodeError) return record.code;
  if (!equalBytes(record.transcript_hash, p.ctx.authorTranscriptHash)) return "transcript";
  const seats = counting(p, record);
  if (seats === null) return "seats";
  if (seats.length !== record.approvals.length) return "signature";
  if (seats.length < p.quorum) return "quorum";
  if (boarded) return "boarded";
  return undefined;
}

// Public values, so timing doesn't matter.
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}
