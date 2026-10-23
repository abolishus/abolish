// The author approvals record (docs/spec/ceremony.md, Author panel, record
// type 0x0019): an author panel's approvals of its ceremony transcript,
// which no contract records, so every reader counts them itself from the
// definition and its own transcript check. The check stands in for the
// trustee registry's quorum: a default seat runs it before lending its keys
// (Stub checks, step 5), every seat before intake, the ballot client before
// any share and the verifier in 3.1 (T-17, T-37, T-54). Once the election
// registry has registered the definition, its `AuthorPanelRegistered`
// carries the approvals it counted, which every reader of the election's
// events counts beside the records (The registration's approvals).

import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  list,
  struct,
  u8,
} from "./codec.ts";
import {
  checkedTranscriptHash,
  decodeCeremonyRegistration,
  keySetEntry,
  keySetHash,
  type RegisteredKeys,
} from "./ceremony.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { authorPanelId, type Panel, p256Sig, verifyAuthorCeremonyRegistration } from "./trustee.ts";

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
  | "key-set-mismatch"
  | "author-approvals"
  | "author-approvals-missing";

export type AuthorApprovalsCheck =
  | { readonly ok: true; readonly seats: readonly number[] }
  | { readonly ok: false; readonly code: AuthorApprovalsCode; readonly seats?: readonly number[] };

interface Prepared {
  readonly ctx: AuthorApprovalContext;
  readonly panelId: Uint8Array;
  readonly keySet: Uint8Array;
  readonly n: number;
  readonly quorum: number;
}

// Each field read once, and every byte array copied before any signature is
// verified, so a caller can't verify approvals under one context and have
// the key set approved under another (T-37); the key set must be one the
// transcript check returned for the definition's author transcript.
function prepare(input: AuthorApprovalContext): Prepared {
  if (input === null || typeof input !== "object")
    throw new TypeError("author approvals: expected a context");
  const { l2ChainId, panel, authorTranscriptHash, registered } = input;
  if (typeof l2ChainId !== "bigint")
    throw new TypeError("author approvals: expected l2ChainId as a bigint");
  if (
    !(input.trusteeRegistry instanceof Uint8Array) ||
    !(input.authorStubHash instanceof Uint8Array)
  )
    throw new TypeError(
      "author approvals: expected the trustee registry and author stub hash as bytes",
    );
  const trusteeRegistry = Uint8Array.from(input.trusteeRegistry);
  const authorStubHash = Uint8Array.from(input.authorStubHash);
  if (panel === null || typeof panel !== "object" || !Array.isArray(panel.keys))
    throw new TypeError("author approvals: expected the author panel");
  const transcript = Array.isArray(registered) ? checkedTranscriptHash(registered) : undefined;
  if (transcript === undefined || !equalBytes(transcript, authorTranscriptHash))
    throw new RangeError(
      "author approvals: the key set must come from checkCeremonyTranscript on the author transcript",
    );
  const panelCopy = { threshold: panel.threshold, keys: panel.keys.map((k) => Uint8Array.from(k)) };
  // The author panel's rules 1 to 3 (PanelError otherwise), so a threshold
  // of 0 can't make the quorum 0 and approve with no approvals at all.
  const panelId = authorPanelId(panelCopy);
  const n = panelCopy.keys.length;
  return {
    panelId,
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
// `keySet` is the key set hash the approvals sign: the checker's own, but
// for a registration's quorum, the registration's (`fromRegistration`).
function counting(
  p: Prepared,
  record: AuthorApprovals,
  keySet: Uint8Array = p.keySet,
): number[] | null {
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
          keySetHash: keySet,
        },
        signature,
      ),
    )
    .map((a) => a.index);
}

/**
 * An `AuthorPanelRegistered` registration read as an approvals record naming
 * the transcript, when it is one of this run's: its header is this run's
 * (`author_panel_id`, `author_stub_hash`, `author_transcript_hash`) and at
 * least `q_A` distinct seats' approvals in it verify over its own key set,
 * as the election registry requires before it emits one; then
 * `key-set-mismatch` when that key set isn't the checker's own, since the
 * board takes the author seats' keys from it (T-37, T-14). Undefined for
 * anything else, which the registry never emits for this definition
 * (contracts.md, Author panel registration, checks 2 to 9), so bytes no
 * quorum signed can't fail the check (T-53).
 */
function fromRegistration(
  p: Prepared,
  bytes: Uint8Array,
): AuthorApprovals | "key-set-mismatch" | undefined {
  let r;
  try {
    r = decodeCeremonyRegistration(bytes);
  } catch (e) {
    if (e instanceof DecodeError) return undefined;
    throw e;
  }
  // The registry's check 6 bounds the seats by `n_A` (and the decoder made
  // them strictly increasing from 1), so a seat above it is no registration
  // of this run either, and a key set of one never reaches `keySetHash`.
  if (
    r.keySet.some((e) => e.index > p.n) ||
    !equalBytes(r.panelId, p.panelId) ||
    !equalBytes(r.stubHash, p.ctx.authorStubHash) ||
    !equalBytes(r.ceremonyTranscriptHash, p.ctx.authorTranscriptHash)
  )
    return undefined;
  const record: AuthorApprovals = {
    transcript_hash: r.ceremonyTranscriptHash,
    approvals: r.approvals.map((a) => ({ index: a.index, signature: a.signature })),
  };
  const own = keySetHash(r.keySet);
  if ((counting(p, record, own) ?? []).length < p.quorum) return undefined;
  return equalBytes(own, p.keySet) ? record : "key-set-mismatch";
}

/**
 * Author panel, Check: whether `records` and `registrations` approve the
 * author transcript. A transcript with fewer than `q_A` qualified seats is
 * refused whatever they hold (`ceremony-participation`). `registrations`
 * are the `registration` of every `AuthorPanelRegistered` whose
 * `definitionHash` is the registered definition's, which only the caller
 * can match (The registration's approvals): one of this run's, `q_A` seats
 * approving its key set, fails the check when that set isn't the checker's
 * (`key-set-mismatch`). Otherwise
 * every record that decodes strictly and names the transcript, and every
 * registration of this run, is counted, each seat once however many valid
 * signatures it has; it approves with at least `q_A` seats. With none
 * naming the transcript the check is `author-approvals-missing` (the copy
 * may lack them); with some that fall short, `author-approvals`.
 */
export function checkAuthorApprovals(
  context: AuthorApprovalContext,
  records: readonly Uint8Array[],
  registrations: readonly Uint8Array[] = [],
): AuthorApprovalsCheck {
  const p = prepare(context);
  if (!Array.isArray(registrations))
    throw new TypeError("author approvals: expected the registrations as an array");
  if (p.ctx.registered.length < p.quorum) return { ok: false, code: "ceremony-participation" };
  const named: AuthorApprovals[] = [];
  for (const bytes of records) {
    const record = decoded(bytes);
    if (record instanceof DecodeError) continue;
    if (equalBytes(record.transcript_hash, p.ctx.authorTranscriptHash)) named.push(record);
  }
  for (const bytes of registrations) {
    const record = fromRegistration(p, bytes);
    if (record === "key-set-mismatch") return { ok: false, code: record };
    if (record !== undefined) named.push(record);
  }
  const counted = new Set<number>();
  for (const record of named) for (const seat of counting(p, record) ?? []) counted.add(seat);
  const seats = [...counted].sort((a, b) => a - b);
  if (seats.length >= p.quorum) {
    approve(p);
    return { ok: true, seats };
  }
  return {
    ok: false,
    code: named.length > 0 ? "author-approvals" : "author-approvals-missing",
    seats,
  };
}

/**
 * What an author key set was approved under: every input of the approvals'
 * statement but the key set itself, which is the marked set.
 */
export interface AuthorApproval {
  readonly l2ChainId: bigint;
  readonly trusteeRegistry: Uint8Array;
  readonly authorPanelId: Uint8Array;
  readonly authorStubHash: Uint8Array;
  readonly authorTranscriptHash: Uint8Array;
}

/**
 * Every registered key set `checkAuthorApprovals` approved, with each
 * context it was approved under (a set is frozen by the transcript check
 * that returned it), so the author panel's key set is taken only for the
 * definition whose author run it is: never one served from anywhere else,
 * one whose approvals fell short, or another election's (T-37, T-17).
 */
const APPROVED = new WeakMap<readonly RegisteredKeys[], AuthorApproval[]>();

// `prepare` copied every array in `p.ctx`, and nothing writes them after.
function approve(p: Prepared): void {
  const { l2ChainId, trusteeRegistry, authorStubHash, authorTranscriptHash, registered } = p.ctx;
  const under: AuthorApproval = {
    l2ChainId,
    trusteeRegistry,
    authorPanelId: p.panelId,
    authorStubHash,
    authorTranscriptHash,
  };
  if (!wasApproved(registered, under))
    APPROVED.set(registered, [...(APPROVED.get(registered) ?? []), under]);
}

/**
 * Internal: whether `checkAuthorApprovals` approved this key set under
 * exactly `under`. The package entry point doesn't export it.
 */
export function wasApproved(keys: readonly RegisteredKeys[], under: AuthorApproval): boolean {
  return (APPROVED.get(keys) ?? []).some(
    (a) =>
      a.l2ChainId === under.l2ChainId &&
      equalBytes(a.trusteeRegistry, under.trusteeRegistry) &&
      equalBytes(a.authorPanelId, under.authorPanelId) &&
      equalBytes(a.authorStubHash, under.authorStubHash) &&
      equalBytes(a.authorTranscriptHash, under.authorTranscriptHash),
  );
}

/** Why the operator refuses to board an approvals record (Author panel, Boarding). */
export type AuthorApprovalsRefusal =
  | "ceremony-participation"
  | DecodeErrorCode
  | "transcript"
  | "seats"
  | "signature"
  | "quorum"
  | "boarded";

/**
 * The operator's boarding rule: a record is boarded only for a transcript
 * with at least `q_A` qualified seats (`ceremony-participation`), and only if it decodes,
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
  // No record approves a transcript with too few qualified seats, so none is
  // boarded for one, whoever signed it (a disqualified seat still can).
  if (p.ctx.registered.length < p.quorum) return "ceremony-participation";
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
