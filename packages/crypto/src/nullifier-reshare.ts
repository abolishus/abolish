// Resharing the Tier 2 keyed nullifier's key (docs/spec/nullifier-reshare.md;
// ADR 0022, option A; record types 0x0013 and 0x0014): each new seat
// registers a KEM key and a signing key, each qualified seat of the
// predecessor shares its own share again to the new seats under Pedersen VSS
// whose constant commitment is its `C_i`, new seats complain about a share
// that fails, and dealers answer with the share itself. The check recombines
// the qualified dealers' commitments with Lagrange coefficients, so the
// successor holds the same `sk` in fresh shares (Desmedt–Jajodia;
// Herzberg et al.; Wong–Wang–Wing; T-14, T-15, T-40). This module composes
// @noble's primitives through nullifier-key.ts.

import { randomBytes } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  decode,
  encode,
  list,
  struct,
  u64,
  u8,
  Writer,
} from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { element, G, H } from "./group.ts";
import {
  BJJ_G,
  type BjjPoint,
  bjjLagrangeAtZero,
  bjjPoint,
  type NullifierKey,
  type SeatShare,
} from "./keyed-nullifier.ts";
import {
  checkPolynomials,
  checkRecordMargin,
  checkRunDeadline,
  commitmentAt,
  type DealtShareResult,
  equalBytes,
  evaluatePolynomial,
  hex,
  increasing,
  type KeySeat,
  modL,
  opening,
  openShareWith,
  ownKeys,
  type Polynomials,
  randomBjjScalar,
  type ReceivedShare,
  type RegistrationKeysMessage,
  type RegistrationSecrets,
  REVEALED_SHARE,
  ROUND_1,
  roundMessageOk,
  type ShareChannel,
  type ShareRandomness,
  sealShareWith,
  seatKey,
  signingPopMessage,
  signRoundMessage,
} from "./nullifier-key.ts";
import {
  nullifierReshareApprovalStatement,
  nullifierReshareConsentStatement,
  STATEMENT_TAGS,
} from "./nullifier-key-statements.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import {
  AEAD_TAG_LEN,
  KEM_SECRET_KEY,
  type KemSecretKey,
  MLKEM_CT_LEN,
  MLKEM_MSG_LEN,
  nonZeroRandom,
} from "./share-encryption.ts";
import {
  identityKey,
  type Panel,
  panelId,
  p256Sig,
  signStatement,
  verifyStatement,
} from "./trustee.ts";

const { MAX_TRUSTEES } = PARAMETERS;

/**
 * The longest a run's deadline may lie ahead, in L2 blocks: 7 days of 2-second
 * blocks, a constant of transcript version 1. Without a bound a coordinator
 * could set a deadline that never passes, and a stalled run would hold its
 * approving seats for good (docs/spec/nullifier-reshare.md, Reshare context).
 */
export const MAX_RESHARE_WINDOW = 302_400n;

// An honest new seat takes part in, and approves, only a run whose deadline is
// still ahead of its latest L2 block and at most `MAX_RESHARE_WINDOW` ahead.
function checkDeadline(deadline: bigint, currentL2Block: bigint): void {
  checkRunDeadline(deadline, currentL2Block, MAX_RESHARE_WINDOW, "nullifier reshare");
}

const MESSAGE_TAG = "abolish/v1/sig/nullifier-reshare-message";
const SIGNING_KEY_TAG = "abolish/v1/sig/nullifier-reshare-signing-key";

// Recipients are another panel's seats, so a dealer's lists run to
// MAX_TRUSTEES, never MAX_TRUSTEES − 1 as in the initial sharing.
const ROUND_2 = struct([
  ["index", u8],
  ["commitments", list(bjjPoint, MAX_TRUSTEES)],
  ["share_hashes", list(bytesFixed(32), MAX_TRUSTEES)],
  ["signature", p256Sig],
] as const);

const ROUND_3 = struct([
  ["index", u8],
  ["complaints", list(u8, MAX_TRUSTEES)],
  ["signature", p256Sig],
] as const);

const ROUND_4 = struct([
  ["index", u8],
  ["reveals", list(REVEALED_SHARE, MAX_TRUSTEES)],
  ["signature", p256Sig],
] as const);

const KEYS = list(ROUND_1, MAX_TRUSTEES);
const DEALINGS = list(ROUND_2, MAX_TRUSTEES);
const COMPLAINTS = list(ROUND_3, MAX_TRUSTEES);
const RESPONSES = list(ROUND_4, MAX_TRUSTEES);

const transcriptV1 = struct([
  ["run_id", bytesFixed(32)],
  ["predecessor", bytesFixed(32)],
  ["deadline", u64],
  ["keys", KEYS],
  ["dealings", DEALINGS],
  ["complaints", COMPLAINTS],
  ["responses", RESPONSES],
] as const);

export type ReshareDealingMessage = CodecValue<typeof ROUND_2>;
export type ReshareComplaintsMessage = CodecValue<typeof ROUND_3>;
export type ReshareResponsesMessage = CodecValue<typeof ROUND_4>;

/** Reshare transcript, version 1 (docs/spec/nullifier-reshare.md, Transcript). */
export type NullifierReshareTranscript = CodecValue<typeof transcriptV1>;

/** Record type `0x0013`: a reshare of the Tier 2 key, public. */
export const NULLIFIER_RESHARE_TRANSCRIPT = recordType(RECORD_TYPES.nullifierReshareTranscript, {
  1: transcriptV1,
});

const resharedShareV1 = struct([
  ["reshare_context", bytesFixed(32)],
  ["dealer", u8],
  ["recipient", u8],
  ["ct_mlkem", bytesFixed(MLKEM_CT_LEN)],
  ["ct_dh", element],
  ["sealed", bytesFixed(64 + AEAD_TAG_LEN)],
] as const);

/** Reshared share, version 1 (docs/spec/nullifier-reshare.md, Reshared share). */
export type ResharedShare = CodecValue<typeof resharedShareV1>;

/**
 * Record type `0x0014`: one new seat's share of an old seat's share, sealed
 * by that old seat. Private, and never pinned by a profile: version 1 of the
 * reshare transcript fixes version 1.
 */
export const NULLIFIER_RESHARE_SHARE = recordType(RECORD_TYPES.nullifierReshareShare, {
  1: resharedShareV1,
});

const SCHEMA = new RecordSchema([NULLIFIER_RESHARE_TRANSCRIPT, NULLIFIER_RESHARE_SHARE]);

const CHANNEL: ShareChannel = {
  recordType: RECORD_TYPES.nullifierReshareShare,
  kemTag: "abolish/v1/kem/nullifier-reshare-share",
  aadTag: "abolish/v1/kem/nullifier-reshare-share-aad",
};

export function encodeNullifierReshareTranscript(
  transcript: NullifierReshareTranscript,
): Uint8Array {
  return SCHEMA.encode(NULLIFIER_RESHARE_TRANSCRIPT, 1, transcript);
}

/** Strictly decodes a reshare transcript under version 1, the only version. */
export function decodeNullifierReshareTranscript(
  bytes: Uint8Array,
  pinned: 1,
): NullifierReshareTranscript {
  return SCHEMA.decode(NULLIFIER_RESHARE_TRANSCRIPT, bytes, pinned).value;
}

export function encodeResharedShare(share: ResharedShare): Uint8Array {
  return SCHEMA.encode(NULLIFIER_RESHARE_SHARE, 1, share);
}

/** Strictly decodes a reshared share under version 1, the version transcript 1 fixes. */
export function decodeResharedShare(bytes: Uint8Array, pinned: 1): ResharedShare {
  return SCHEMA.decode(NULLIFIER_RESHARE_SHARE, bytes, pinned).value;
}

/** The successor's `key_id = H(DS("abolish/v1/keyed-nullifier/reshared-key", encode(transcript)))`. */
export function nullifierReshareKeyId(encoded: Uint8Array): Uint8Array {
  return H(ds("abolish/v1/keyed-nullifier/reshared-key", encoded));
}

/** `share_hash` of a reshared-share message, over its full record encoding. */
export function resharedShareHash(encoded: Uint8Array): Uint8Array {
  return H(ds("abolish/v1/keyed-nullifier/reshare-share", encoded));
}

/**
 * The scope, the predecessor and the two panels of a reshare; every field
 * comes from the release's pins, and `predecessor` from the predecessor's own
 * check (`checkNullifierKeyTranscript`, or this module's for a reshare).
 */
export interface NullifierReshareScope {
  readonly l2ChainId: bigint;
  readonly groupRegistry: Uint8Array;
  readonly oldPanel: Panel;
  readonly predecessor: NullifierKey;
  readonly newPanel: Panel;
}

/**
 * A reshare scope and one run: its identifier and its deadline, the L2 block
 * by which the successor's approvals must be recorded to count.
 */
export interface NullifierReshareParams extends NullifierReshareScope {
  readonly runId: Uint8Array;
  readonly deadline: bigint;
}

interface PanelPins {
  readonly id: Uint8Array;
  readonly threshold: number;
  readonly keys: readonly Uint8Array[];
}

interface Scope {
  readonly l2ChainId: bigint;
  readonly groupRegistry: Uint8Array;
  readonly old: PanelPins;
  readonly next: PanelPins;
  readonly predecessorId: Uint8Array;
  /** The predecessor's `C_i` and signing key, seat `i` at `i − 1`; `null` where unqualified. */
  readonly commitments: readonly (BjjPoint | null)[];
  readonly signingKeys: readonly (Uint8Array | null)[];
}

interface Run extends Scope {
  readonly context: Uint8Array;
}

function pinsOf(panel: Panel, name: string): PanelPins {
  if (panel === null || typeof panel !== "object")
    throw new TypeError(`nullifier reshare: expected ${name}`);
  const keys = Array.isArray(panel.keys) ? panel.keys.map((k) => Uint8Array.from(k)) : [];
  const threshold = panel.threshold;
  return { id: panelId({ threshold, keys }), threshold, keys };
}

// Each field read once, both panels' identifiers computed here, never taken
// from data (T-37), and the predecessor tied to the old panel's shape.
function scopeOf(params: NullifierReshareScope): Scope {
  if (params === null || typeof params !== "object")
    throw new TypeError("nullifier reshare: expected parameters");
  const { l2ChainId, groupRegistry, predecessor } = params;
  const old = pinsOf(params.oldPanel, "the old panel");
  const next = pinsOf(params.newPanel, "the new panel");
  if (!(groupRegistry instanceof Uint8Array) || groupRegistry.length !== 20)
    throw new RangeError("nullifier reshare: groupRegistry must be 20 bytes");
  if (predecessor === null || typeof predecessor !== "object")
    throw new TypeError("nullifier reshare: expected the predecessor key");
  const commitments = [...predecessor.commitments];
  const signingKeys = predecessor.signingKeys.map((k) => (k === null ? null : Uint8Array.from(k)));
  if (
    !(predecessor.keyId instanceof Uint8Array) ||
    predecessor.keyId.length !== 32 ||
    predecessor.threshold !== old.threshold ||
    commitments.length !== old.keys.length ||
    signingKeys.length !== old.keys.length ||
    commitments.some((c, i) => (c === null) !== (signingKeys[i] === null))
  )
    throw new RangeError("nullifier reshare: the predecessor isn't a key of the old panel");
  return {
    l2ChainId,
    groupRegistry: Uint8Array.from(groupRegistry),
    old,
    next,
    predecessorId: Uint8Array.from(predecessor.keyId),
    commitments,
    signingKeys,
  };
}

const CONTEXT = struct([
  ["l2_chain_id", u64],
  ["group_registry", bytesFixed(20)],
  ["old_panel_id", bytesFixed(32)],
  ["predecessor", bytesFixed(32)],
  ["new_panel_id", bytesFixed(32)],
  ["run_id", bytesFixed(32)],
  ["deadline", u64],
] as const);

function runOf(params: NullifierReshareParams): Run {
  const scope = scopeOf(params);
  const context = H(
    ds(
      "abolish/v1/keyed-nullifier/reshare-context",
      encode(CONTEXT, {
        l2_chain_id: scope.l2ChainId,
        group_registry: scope.groupRegistry,
        old_panel_id: scope.old.id,
        predecessor: scope.predecessorId,
        new_panel_id: scope.next.id,
        run_id: params.runId,
        deadline: params.deadline,
      }),
    ),
  );
  return { ...scope, context };
}

/** `reshare_context` (docs/spec/nullifier-reshare.md, Reshare context). */
export function nullifierReshareContext(params: NullifierReshareParams): Uint8Array {
  return runOf(params).context;
}

type Rounds = Pick<NullifierReshareTranscript, "keys" | "dealings" | "complaints" | "responses">;

function roundHash(prev: Uint8Array, round: number, encodedRound: Uint8Array): Uint8Array {
  const w = new Writer();
  w.bytes(prev);
  u8.write(w, round);
  w.bytes(encodedRound);
  return H(ds("abolish/v1/keyed-nullifier/reshare-round", w.finish()));
}

function chain(context: Uint8Array, t: Partial<Rounds>): Uint8Array[] {
  const h = [context];
  if (t.keys === undefined) return h;
  h.push(roundHash(h[0] as Uint8Array, 1, encode(KEYS, t.keys)));
  if (t.dealings === undefined) return h;
  h.push(roundHash(h[1] as Uint8Array, 2, encode(DEALINGS, t.dealings)));
  if (t.complaints === undefined) return h;
  h.push(roundHash(h[2] as Uint8Array, 3, encode(COMPLAINTS, t.complaints)));
  return h;
}

const ROUND_CODECS = [ROUND_1, ROUND_2, ROUND_3, ROUND_4] as const;

// New seats send rounds 1 and 3, old seats rounds 2 and 4.
const senders = (run: Scope, round: number) => (round % 2 === 1 ? run.next : run.old);

function sign<T extends { signature: Uint8Array }>(
  identitySecret: Uint8Array,
  round: number,
  prev: Uint8Array,
  unsigned: Omit<T, "signature">,
): T {
  return signRoundMessage<T>(
    ROUND_CODECS[round - 1],
    MESSAGE_TAG,
    identitySecret,
    round,
    prev,
    unsigned,
  );
}

function possessionOk(context: Uint8Array, m: RegistrationKeysMessage): boolean {
  return verifyStatement(
    m.signing_key,
    SIGNING_KEY_TAG,
    signingPopMessage(context, m.index, m.kem_key, m.signing_key),
    m.signing_pop,
  );
}

/**
 * Round 1: a new seat's registration KEM key and signing key, with the
 * signing key's signature. `currentL2Block` is the latest L2 block the seat's
 * node has seen: it takes part only in a run whose deadline is ahead of it by
 * at most `MAX_RESHARE_WINDOW`.
 */
export function reshareKeysMessage(
  params: NullifierReshareParams,
  seat: RegistrationSecrets,
  currentL2Block: bigint,
): RegistrationKeysMessage {
  const run = runOf(params);
  seatKey(run.next, seat);
  checkDeadline(params.deadline, currentL2Block);
  const kemKey = seat.kem.publicKey;
  const signingKey = identityKey(seat.signingSecret);
  const pop = signStatement(
    seat.signingSecret,
    SIGNING_KEY_TAG,
    signingPopMessage(run.context, seat.index, kemKey, signingKey),
  );
  return sign<RegistrationKeysMessage>(seat.identitySecret, 1, run.context, {
    index: seat.index,
    kem_key: kemKey,
    signing_key: signingKey,
    signing_pop: pop,
  });
}

/** An old seat as a dealer: its seat on the predecessor's panel and its identity key. */
export interface OldSeat {
  readonly index: number;
  readonly identitySecret: Uint8Array;
}

/**
 * A round-2 message, the reshared-share messages it carries the hashes of
 * (one per new seat of round 1, in order), and the polynomials the dealer
 * keeps until round 4 closes.
 */
export interface ReshareDealing {
  readonly message: ReshareDealingMessage;
  readonly shares: readonly { readonly recipient: number; readonly bytes: Uint8Array }[];
  readonly polynomials: Polynomials;
}

/**
 * Internal: old seat `dealer.index`'s round-2 message from the given
 * polynomials and sealing randomness, one per new seat of round 1 in order.
 * The polynomials' constant terms must be `share`, which must open the
 * seat's `C_i`, and the run's deadline must lie ahead of `currentL2Block` by
 * at most `MAX_RESHARE_WINDOW`. Production code calls `reshareDealing`; the package entry
 * point doesn't export this.
 */
export function reshareDealingWith(
  params: NullifierReshareParams,
  dealer: OldSeat,
  share: SeatShare,
  keys: readonly RegistrationKeysMessage[],
  polynomials: Polynomials,
  randomness: readonly ShareRandomness[],
  currentL2Block: bigint,
): ReshareDealing {
  const run = runOf(params);
  seatKey(run.old, dealer);
  // A dealer is held to one successor panel while a run to it is live, so it
  // deals only in a run whose deadline is bounded (Round 2).
  checkDeadline(params.deadline, currentL2Block);
  const h = checkedPrefix(run, { keys });
  checkPolynomials(polynomials, run.next.threshold);
  const own = run.commitments[dealer.index - 1];
  // Only a qualified seat's own share: anything else fails `constant`, or
  // isn't a reshare of `sk` at all.
  if (
    own === null ||
    own === undefined ||
    share.seat !== dealer.index ||
    !opening(share.sk, share.s).equals(own)
  )
    throw new RangeError("nullifier reshare: the share doesn't open the seat's commitment");
  const f = [...polynomials.f];
  const g = [...polynomials.g];
  if (f[0] !== share.sk || g[0] !== share.s)
    throw new RangeError("nullifier reshare: the polynomials' constant terms must be the share");
  // Constant-time multiplication: the coefficients are the dealer's secrets.
  const commitments = f.map((a, j) => (j === 0 ? own : opening(a, g[j] as bigint)));
  if (commitments.some((c) => c.is0()))
    throw new RangeError("nullifier reshare: a coefficient commitment is the identity; redraw");
  if (randomness.length !== keys.length)
    throw new RangeError("nullifier reshare: one sealing randomness per new seat");
  const shares = keys.map((t, at) => {
    const sealed = sealShareWith(
      CHANNEL,
      run.context,
      dealer.index,
      t,
      commitments,
      evaluatePolynomial(f, t.index),
      evaluatePolynomial(g, t.index),
      randomness[at] as ShareRandomness,
    );
    const bytes = encodeResharedShare({
      reshare_context: run.context,
      dealer: dealer.index,
      recipient: t.index,
      ...sealed,
    });
    return { recipient: t.index, bytes };
  });
  const message = sign<ReshareDealingMessage>(dealer.identitySecret, 2, h[1] as Uint8Array, {
    index: dealer.index,
    commitments,
    share_hashes: shares.map((s) => resharedShareHash(s.bytes)),
  });
  return { message, shares, polynomials: { f, g } };
}

/**
 * Round 2: a fresh resharing of the old seat's share (docs/spec/
 * nullifier-reshare.md, Round 2), every other coefficient, `μ` and `e` from
 * the CSPRNG, redrawing a coefficient pair whose commitment is the identity.
 */
export function reshareDealing(
  params: NullifierReshareParams,
  dealer: OldSeat,
  share: SeatShare,
  keys: readonly RegistrationKeysMessage[],
  currentL2Block: bigint,
): ReshareDealing {
  const k = runOf(params).next.threshold;
  const f: bigint[] = [share.sk];
  const g: bigint[] = [share.s];
  while (f.length < k) {
    const a = randomBjjScalar();
    const b = randomBjjScalar();
    if (opening(a, b).is0()) continue;
    f.push(a);
    g.push(b);
  }
  return reshareDealingWith(
    params,
    dealer,
    share,
    keys,
    { f, g },
    keys.map(() => ({ mu: randomBytes(MLKEM_MSG_LEN), e: nonZeroRandom() })),
    currentL2Block,
  );
}

/**
 * New seat `recipient.index`'s check of a reshared-share message (docs/spec/
 * nullifier-reshare.md, Reshared-share check), in order: it decodes, is for
 * this run, this seat and a dealer of round 2, its hash is the one that
 * dealer signed for this seat, it opens, and the share opens the dealer's
 * commitment at this seat. Only the last two failures are grounds for a
 * complaint; `dealer` is set on those.
 */
export function checkResharedShare(
  params: NullifierReshareParams,
  recipient: { readonly index: number; readonly secretKey: KemSecretKey },
  rounds: Pick<NullifierReshareTranscript, "keys" | "dealings">,
  bytes: Uint8Array,
): DealtShareResult {
  const run = runOf(params);
  checkedPrefix(run, rounds);
  const secret = decode(KEM_SECRET_KEY, encode(KEM_SECRET_KEY, recipient.secretKey));
  // Only the key the seat registered, as for a dealt share.
  ownKeys(rounds.keys, recipient.index, {
    ek: ml_kem768.keygen(secret.seed).publicKey,
    dh: G.multiply(secret.x),
  });
  let msg: ResharedShare;
  try {
    msg = decodeResharedShare(bytes, 1);
  } catch {
    return { ok: false, code: "share-malformed" };
  }
  const dealing = rounds.dealings.find((m) => m.index === msg.dealer);
  if (
    !equalBytes(msg.reshare_context, run.context) ||
    msg.recipient !== recipient.index ||
    dealing === undefined
  )
    return { ok: false, code: "share-context" };
  const position = rounds.keys.findIndex((m) => m.index === recipient.index);
  const signed = dealing.share_hashes[position];
  if (signed === undefined || !equalBytes(resharedShareHash(bytes), signed))
    return { ok: false, code: "share-hash" };
  return openShareWith(
    CHANNEL,
    run.context,
    secret,
    msg.dealer,
    recipient.index,
    dealing.commitments,
    msg,
  );
}

/**
 * Round 3: the old seats a new seat complains about, each one whose message
 * matched its signed hash and then failed `share-decrypt` or `share-verify`.
 * A seat with none sends nothing; a missing message is never a complaint.
 */
export function reshareComplaintsMessage(
  params: NullifierReshareParams,
  seat: RegistrationSecrets,
  rounds: Pick<NullifierReshareTranscript, "keys" | "dealings">,
  dealers: readonly number[],
): ReshareComplaintsMessage {
  const run = runOf(params);
  seatKey(run.next, seat);
  const h = checkedPrefix(run, rounds);
  ownKeys(rounds.keys, seat.index, seat.kem.publicKey, identityKey(seat.signingSecret));
  const s2 = rounds.dealings.map((m) => m.index);
  if (
    dealers.length === 0 ||
    !increasing(dealers, run.old.keys.length) ||
    dealers.some((d) => !s2.includes(d))
  )
    throw new RangeError(
      "nullifier reshare: complaints name dealers of round 2, increasing, at least one",
    );
  return sign<ReshareComplaintsMessage>(seat.identitySecret, 3, h[2] as Uint8Array, {
    index: seat.index,
    complaints: [...dealers],
  });
}

/**
 * Round 4: an old seat's answer to every complaint about it, its share for
 * each complainer in the clear. `polynomials` must be the ones behind its
 * round-2 message in this transcript.
 */
export function reshareResponsesMessage(
  params: NullifierReshareParams,
  dealer: OldSeat,
  rounds: Pick<NullifierReshareTranscript, "keys" | "dealings" | "complaints">,
  polynomials: Polynomials,
): ReshareResponsesMessage {
  const run = runOf(params);
  seatKey(run.old, dealer);
  const h = checkedPrefix(run, rounds);
  const dealing = rounds.dealings.find((m) => m.index === dealer.index);
  if (dealing === undefined) throw new RangeError("nullifier reshare: the seat dealt nothing");
  checkPolynomials(polynomials, run.next.threshold);
  const commitments = polynomials.f.map((a, j) => opening(a, polynomials.g[j] as bigint));
  if (
    commitments.length !== dealing.commitments.length ||
    commitments.some((c, j) => !c.equals(dealing.commitments[j] as BjjPoint))
  )
    throw new RangeError("nullifier reshare: the polynomials aren't the transcript's dealing");
  const complainers = complainersOf(rounds.complaints, dealer.index);
  if (complainers.length === 0)
    throw new RangeError("nullifier reshare: no complaint about the seat");
  return sign<ReshareResponsesMessage>(dealer.identitySecret, 4, h[3] as Uint8Array, {
    index: dealer.index,
    reveals: complainers.map((c) => ({
      complainer: c,
      share: evaluatePolynomial(polynomials.f, c),
      blind: evaluatePolynomial(polynomials.g, c),
    })),
  });
}

function complainersOf(complaints: readonly ReshareComplaintsMessage[], dealer: number): number[] {
  return complaints.filter((m) => m.complaints.includes(dealer)).map((m) => m.index);
}

// A node checks the rounds it signs over, as a checker would.
function checkedPrefix(run: Run, rounds: Partial<Rounds>): Uint8Array[] {
  const code = structureCode(run, rounds);
  if (code !== null) throw new RangeError(`nullifier reshare: earlier rounds fail (${code})`);
  return chain(run.context, rounds);
}

/** Why a reshare transcript is invalid as a whole (docs/spec/nullifier-reshare.md, Transcript check). */
export type NullifierReshareErrorCode =
  | DecodeErrorCode
  | "key-predecessor"
  | "key-order"
  | "key-shape"
  | "key-signature"
  | "key-dealers"
  | "key-quorum";

/** Why an old seat that dealt isn't a qualified dealer, in the spec's order. */
export type ReshareDealerReason = "constant" | "unanswered" | "bad-reveal";

/** Why a new seat isn't qualified, in the spec's order. */
export type ReshareSeatReason = "absent" | "possession" | "duplicate-key" | "identity-commitment";

export interface ReshareDealerResult {
  readonly index: number;
  readonly reasons: readonly ReshareDealerReason[];
}

export interface ReshareSeatResult {
  readonly index: number;
  readonly reasons: readonly ReshareSeatReason[];
}

export type NullifierReshareCheck =
  | {
      readonly ok: true;
      readonly keyId: Uint8Array;
      readonly predecessor: Uint8Array;
      /** The L2 block by which the successor's approvals must be recorded to count. */
      readonly deadline: bigint;
      /** Each old seat of round 2, in order, with its reasons. */
      readonly dealerResults: readonly ReshareDealerResult[];
      /** The qualified dealers `Q`, whose reshares make up the successor's shares. */
      readonly dealers: readonly number[];
      /** Each seat of the new panel, with its reasons. */
      readonly seats: readonly ReshareSeatResult[];
      readonly qualified: readonly KeySeat[];
      /** What the answer check takes (docs/spec/keyed-nullifier.md, Answer check). */
      readonly key: NullifierKey;
    }
  | {
      readonly ok: false;
      readonly code: NullifierReshareErrorCode;
      readonly dealerResults?: readonly ReshareDealerResult[];
      readonly seats?: readonly ReshareSeatResult[];
    };

// Checks 1 to 4 over the rounds present: predecessor (in the caller), order,
// shape, then signatures.
function structureCode(run: Run, t: Partial<Rounds>): NullifierReshareErrorCode | null {
  const n = run.next.keys.length;
  const nOld = run.old.keys.length;
  const s1 = (t.keys ?? []).map((m) => m.index);
  const s2 = (t.dealings ?? []).map((m) => m.index);
  const holder = (i: number) => (run.commitments[i - 1] ?? null) !== null;
  if (!increasing(s1, n)) return "key-order";
  for (const [round, seats, max, allowed] of [
    [t.dealings, s2, nOld, holder],
    [t.complaints, (t.complaints ?? []).map((m) => m.index), n, (i: number) => s1.includes(i)],
    [t.responses, (t.responses ?? []).map((m) => m.index), nOld, (i: number) => s2.includes(i)],
  ] as const)
    if (round !== undefined && (!increasing(seats, max) || !seats.every(allowed)))
      return "key-order";
  if (
    t.dealings?.some(
      (m) => m.commitments.length !== run.next.threshold || m.share_hashes.length !== s1.length,
    )
  )
    return "key-shape";
  if (
    t.complaints?.some(
      (m) =>
        m.complaints.length === 0 ||
        !increasing(m.complaints, nOld) ||
        m.complaints.some((d) => !s2.includes(d)),
    )
  )
    return "key-shape";
  if (t.responses !== undefined) {
    const complaints = t.complaints ?? [];
    for (const m of t.responses) {
      const expected = complainersOf(complaints, m.index);
      const got = m.reveals.map((r) => r.complainer);
      if (expected.length === 0 || got.length !== expected.length) return "key-shape";
      if (got.some((c, at) => c !== expected[at])) return "key-shape";
    }
  }
  const h = chain(run.context, t);
  const rounds = [t.keys, t.dealings, t.complaints, t.responses];
  for (const [r, msgs] of rounds.entries())
    for (const m of msgs ?? [])
      if (
        !roundMessageOk(
          ROUND_CODECS[r],
          MESSAGE_TAG,
          senders(run, r + 1).keys[m.index - 1],
          r + 1,
          h[r] as Uint8Array,
          m,
        )
      )
        return "key-signature";
  return null;
}

// Check 5: each dealer's reasons.
function dealerResultsOf(run: Run, t: Rounds): ReshareDealerResult[] {
  const responses = new Map(t.responses.map((m) => [m.index, m]));
  return t.dealings.map((dealing) => {
    const i = dealing.index;
    const reasons: ReshareDealerReason[] = [];
    if (!(dealing.commitments[0] as BjjPoint).equals(run.commitments[i - 1] as BjjPoint))
      reasons.push("constant");
    if (complainersOf(t.complaints, i).length > 0) {
      const response = responses.get(i);
      if (response === undefined) reasons.push("unanswered");
      else if (
        response.reveals.some(
          (r) => !opening(r.share, r.blind).equals(commitmentAt(dealing.commitments, r.complainer)),
        )
      )
        reasons.push("bad-reveal");
    }
    return { index: i, reasons };
  });
}

/** `C'_j = Σ_{i ∈ Q} λ_i · Σ_t (j^t mod l) · B_{i,t}`. Public values only. */
function successorCommitment(
  dealings: readonly ReshareDealingMessage[],
  dealers: readonly number[],
  j: number,
): BjjPoint {
  let c = BJJ_G.subtract(BJJ_G);
  for (const m of dealings) {
    if (!dealers.includes(m.index)) continue;
    const lambda = bjjLagrangeAtZero(m.index, dealers);
    c = c.add(commitmentAt(m.commitments, j).multiplyUnsafe(lambda));
  }
  return c;
}

// Every valid result this module's check returned, frozen, so approving,
// consenting and counting take a successor's `key_id`, deadline, dealers and
// qualified seats only as one check gave them together.
const CHECKED = new WeakSet<object>();

function checked(successor: object): void {
  if (!CHECKED.has(successor))
    throw new TypeError("nullifier reshare: expected a result of checkNullifierReshareTranscript");
}

/**
 * The transcript check of docs/spec/nullifier-reshare.md: the context
 * rebuilt from `scope` (never from the transcript), checks 1 to 8 in order,
 * and for a valid transcript the successor key, in the shape the answer
 * check takes.
 */
export function checkNullifierReshareTranscript(
  scope: NullifierReshareScope,
  bytes: Uint8Array,
  pinned: 1,
): NullifierReshareCheck {
  let t: NullifierReshareTranscript;
  try {
    t = decodeNullifierReshareTranscript(bytes, pinned);
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: e.code };
    throw e;
  }
  const run = runOf({ ...scope, runId: t.run_id, deadline: t.deadline });
  if (!equalBytes(t.predecessor, run.predecessorId)) return { ok: false, code: "key-predecessor" };
  const code = structureCode(run, t);
  if (code !== null) return { ok: false, code };
  const dealerResults = dealerResultsOf(run, t);
  const dealers = dealerResults.filter((d) => d.reasons.length === 0).map((d) => d.index);
  if (dealers.length < run.old.threshold) return { ok: false, code: "key-dealers", dealerResults };

  const n = run.next.keys.length;
  const keys = new Map(t.keys.map((m) => [m.index, m]));
  const passing = t.keys.filter((m) => possessionOk(run.context, m));
  const taken = new Set([
    ...run.old.keys.map(hex),
    ...run.next.keys.map(hex),
    ...run.signingKeys.flatMap((k) => (k === null ? [] : [hex(k)])),
  ]);
  const count = new Map<string, number>();
  for (const m of passing) count.set(hex(m.signing_key), (count.get(hex(m.signing_key)) ?? 0) + 1);
  const seats: ReshareSeatResult[] = [];
  const qualified: KeySeat[] = [];
  for (let j = 1; j <= n; j++) {
    const m = keys.get(j);
    if (m === undefined) {
      seats.push({ index: j, reasons: ["absent"] });
      continue;
    }
    const reasons: ReshareSeatReason[] = [];
    const sk = hex(m.signing_key);
    if (!passing.includes(m)) reasons.push("possession");
    else if ((count.get(sk) ?? 0) > 1 || taken.has(sk)) reasons.push("duplicate-key");
    if (reasons.length === 0) {
      const commitment = successorCommitment(t.dealings, dealers, j);
      if (commitment.is0()) reasons.push("identity-commitment");
      else qualified.push({ index: j, kemKey: m.kem_key, signingKey: m.signing_key, commitment });
    }
    seats.push({ index: j, reasons });
  }
  if (qualified.length < run.next.threshold)
    return { ok: false, code: "key-quorum", dealerResults, seats };
  const keyId = nullifierReshareKeyId(bytes);
  const key: NullifierKey = {
    keyId,
    threshold: run.next.threshold,
    signingKeys: Array.from(
      { length: n },
      (_, i) => qualified.find((s) => s.index === i + 1)?.signingKey ?? null,
    ),
    commitments: Array.from(
      { length: n },
      (_, i) => qualified.find((s) => s.index === i + 1)?.commitment ?? null,
    ),
  };
  const result = Object.freeze({
    ok: true as const,
    keyId,
    predecessor: Uint8Array.from(t.predecessor),
    deadline: t.deadline,
    dealerResults: Object.freeze(dealerResults),
    dealers: Object.freeze(dealers),
    seats: Object.freeze(seats),
    qualified: Object.freeze(qualified),
    key,
  });
  CHECKED.add(result);
  return result;
}

/**
 * New seat `index`'s share of the successor: `Σ_{i ∈ Q} λ_i · (g_i(j), g'_i(j))`,
 * each from the dealer's reveal where the seat complained and from
 * `received` otherwise. Throws unless it opens the seat's `C'_j`, in which
 * case the seat lacks a share and doesn't approve (Approval, rule 2).
 */
export function reshareSeatShareOf(
  check: Extract<NullifierReshareCheck, { ok: true }>,
  transcript: NullifierReshareTranscript,
  index: number,
  received: readonly ReceivedShare[],
): SeatShare {
  const seat = check.qualified.find((s) => s.index === index);
  if (seat === undefined) throw new RangeError("nullifier reshare: the seat isn't qualified");
  let sk = 0n;
  let s = 0n;
  for (const dealer of check.dealers) {
    const value =
      transcript.responses
        .find((m) => m.index === dealer)
        ?.reveals.find((r) => r.complainer === index) ?? received.find((r) => r.dealer === dealer);
    if (value === undefined)
      throw new RangeError(`nullifier reshare: no share from qualified dealer ${dealer}`);
    const lambda = bjjLagrangeAtZero(dealer, check.dealers);
    sk = modL(sk + lambda * value.share);
    s = modL(s + lambda * value.blind);
  }
  if (sk === 0n || !opening(sk, s).equals(seat.commitment))
    throw new RangeError("nullifier reshare: the share doesn't open the seat's commitment");
  return { seat: index, sk, s };
}

/**
 * New seat `index`'s 133-byte statement approving a successor with its run's
 * deadline, signed under `abolish/v1/sig/nullifier-reshare-approval-2`
 * (docs/spec/nullifier-reshare.md, Approval). The statement without the
 * deadline, `abolish/v1/sig/nullifier-reshare-approval`, is retired: approvals
 * held back past the run's deadline could be recorded under it once the new
 * seats had erased their shares (T-54).
 */
export function nullifierReshareApprovalMessage(
  scope: NullifierReshareScope,
  index: number,
  keyId: Uint8Array,
  deadline: bigint,
): Uint8Array {
  const s = scopeOf(scope);
  if (!Number.isSafeInteger(index) || index < 1 || index > s.next.keys.length)
    throw new RangeError("nullifier reshare: index must be a seat of the new panel");
  return nullifierReshareApprovalStatement(s, s.next.id, index, s.predecessorId, keyId, deadline);
}

/**
 * Old seat `index`'s 165-byte statement consenting to the successor, signed
 * under `abolish/v1/sig/nullifier-reshare-consent` (docs/spec/
 * nullifier-reshare.md, Consent): the dealer quorum shown to the registry,
 * which can't run the transcript check (T-37, T-40).
 */
export function nullifierReshareConsentMessage(
  scope: NullifierReshareScope,
  index: number,
  keyId: Uint8Array,
  deadline: bigint,
): Uint8Array {
  const s = scopeOf(scope);
  if (!Number.isSafeInteger(index) || index < 1 || index > s.old.keys.length)
    throw new RangeError("nullifier reshare: index must be a seat of the old panel");
  return nullifierReshareConsentStatement(
    s,
    s.old.id,
    index,
    s.predecessorId,
    s.next.id,
    keyId,
    deadline,
  );
}

// Rule 1 of both the approval and the consent, and rule 5: the check's own
// result, of this scope's predecessor, with both quorums, a deadline ahead
// within the window, and the margin to force the record left.
function checkSuccessor(
  scope: NullifierReshareScope,
  successor: Extract<NullifierReshareCheck, { ok: true }>,
  currentL2Block: bigint,
): void {
  checked(successor);
  if (!equalBytes(successor.predecessor, scopeOf(scope).predecessorId))
    throw new RangeError("nullifier reshare: the check is of another predecessor");
  if (successor.dealers.length < nullifierReshareDealerQuorum(scope))
    throw new RangeError("nullifier reshare: fewer than max(k, n − 1) qualified dealers");
  if (successor.qualified.length < nullifierReshareQuorum(scope))
    throw new RangeError("nullifier reshare: fewer than q' qualified new seats");
  checkDeadline(successor.deadline, currentL2Block);
  checkRecordMargin(successor.deadline, currentL2Block, "nullifier reshare");
}

/**
 * New seat `index`'s approval of a successor, as one check of its transcript
 * returned it, refused without both quorums (rule 1), for a seat that isn't
 * qualified (rule 2), or for a deadline passed, beyond `MAX_RESHARE_WINDOW`
 * or with fewer than `RECORD_MARGIN` blocks left (rule 5). The caller MUST
 * have checked the other approval rules of docs/spec/nullifier-reshare.md
 * first, from its own L2 node, rules 4 and 6 above all: the predecessor is
 * the group registry's current key, and every other successor of it the seat
 * approved passed its deadline without being recorded.
 */
export function approveNullifierReshare(
  scope: NullifierReshareScope,
  identitySecret: Uint8Array,
  index: number,
  successor: Extract<NullifierReshareCheck, { ok: true }>,
  currentL2Block: bigint,
): Uint8Array {
  checkSuccessor(scope, successor, currentL2Block);
  if (!successor.qualified.some((q) => q.index === index))
    throw new RangeError("nullifier reshare: the new seat isn't qualified");
  const key = scopeOf(scope).next.keys[index - 1];
  if (key === undefined || !equalBytes(identityKey(identitySecret), key))
    throw new RangeError("nullifier reshare: identitySecret is not the key of seat index");
  return signStatement(
    identitySecret,
    STATEMENT_TAGS.reshareApproval,
    nullifierReshareApprovalMessage(scope, index, successor.keyId, successor.deadline),
  );
}

/**
 * Old seat `index`'s consent to a successor, as one check of its transcript
 * returned it, refused without both quorums (rule 1), for a seat that isn't a
 * qualified dealer of it (rule 2), or for a deadline passed, beyond
 * `MAX_RESHARE_WINDOW` or with fewer than `RECORD_MARGIN` blocks left
 * (rule 5). The caller MUST have checked the other consent rules first:
 * the transcript holds every message the seat sent (rule 3), the predecessor
 * is the group registry's current key, read from its own L2 node (rule 4),
 * and the new panel is one the release allows as a successor, verified out of
 * band, with no other `key_id` of this run consented to (rule 6).
 */
export function consentNullifierReshare(
  scope: NullifierReshareScope,
  identitySecret: Uint8Array,
  index: number,
  successor: Extract<NullifierReshareCheck, { ok: true }>,
  currentL2Block: bigint,
): Uint8Array {
  checkSuccessor(scope, successor, currentL2Block);
  if (!successor.dealers.includes(index))
    throw new RangeError("nullifier reshare: the old seat isn't a qualified dealer");
  const key = scopeOf(scope).old.keys[index - 1];
  if (key === undefined || !equalBytes(identityKey(identitySecret), key))
    throw new RangeError("nullifier reshare: identitySecret is not the key of old seat index");
  return signStatement(
    identitySecret,
    STATEMENT_TAGS.consent,
    nullifierReshareConsentMessage(scope, index, successor.keyId, successor.deadline),
  );
}

// The distinct seats of `keys` whose signature verifies on `message(index)`,
// in increasing order: counted per seat, never per signature (T-14, T-37).
function signingSeats(
  keys: readonly Uint8Array[],
  tag: (typeof STATEMENT_TAGS)["reshareApproval" | "consent"],
  message: (index: number) => Uint8Array,
  signatures: readonly { readonly index: number; readonly signature: Uint8Array }[],
): number[] {
  const seats = new Set<number>();
  for (const a of signatures) {
    const key = Number.isSafeInteger(a.index) ? keys[a.index - 1] : undefined;
    if (key === undefined || a.index < 1) continue;
    if (verifyStatement(key, tag, message(a.index), a.signature)) seats.add(a.index);
  }
  return [...seats].sort((x, y) => x - y);
}

/** The distinct new seats whose approval of `keyId` with `deadline` verifies under their pinned identity key. */
export function reshareApprovingSeats(
  scope: NullifierReshareScope,
  keyId: Uint8Array,
  deadline: bigint,
  approvals: readonly { readonly index: number; readonly signature: Uint8Array }[],
): number[] {
  return signingSeats(
    scopeOf(scope).next.keys,
    STATEMENT_TAGS.reshareApproval,
    (i) => nullifierReshareApprovalMessage(scope, i, keyId, deadline),
    approvals,
  );
}

/** The distinct old seats whose consent to `keyId` with `deadline` verifies under their pinned identity key. */
export function reshareConsentingSeats(
  scope: NullifierReshareScope,
  keyId: Uint8Array,
  deadline: bigint,
  consents: readonly { readonly index: number; readonly signature: Uint8Array }[],
): number[] {
  return signingSeats(
    scopeOf(scope).old.keys,
    STATEMENT_TAGS.consent,
    (i) => nullifierReshareConsentMessage(scope, i, keyId, deadline),
    consents,
  );
}

/**
 * `max(k, n − 1)` over the predecessor's panel: the qualified dealers a
 * successor needs, the old panel's consent to the succession (approval
 * rule 1). The transcript check needs only `k`, enough to recombine `sk`.
 */
export function nullifierReshareDealerQuorum(scope: NullifierReshareScope): number {
  const s = scopeOf(scope);
  return Math.max(s.old.threshold, s.old.keys.length - 1);
}

/**
 * Whether a successor's transcript, consents and approvals are enough for it
 * to count (docs/spec/nullifier-reshare.md, Approval): `check` is a result of
 * this module's check of the scope's predecessor, with at least
 * `max(k, n − 1)` qualified dealers and `q'` qualified new seats, and
 * `max(k, n − 1)` distinct old seats consented and `q'` distinct new seats
 * approved it with its deadline. The dealer quorum is checked here, not only
 * by honest approvers, because a panel of an insider's own keys has no honest
 * seat to check it. Whether it counts is then the group registry's record of
 * it, by the deadline, as a successor of the current key
 * (`replayNullifierKeyRecords`).
 */
export function nullifierReshareCounts(
  scope: NullifierReshareScope,
  check: Extract<NullifierReshareCheck, { ok: true }>,
  consents: readonly { readonly index: number; readonly signature: Uint8Array }[],
  approvals: readonly { readonly index: number; readonly signature: Uint8Array }[],
): boolean {
  checked(check);
  const dealerQuorum = nullifierReshareDealerQuorum(scope);
  const q = nullifierReshareQuorum(scope);
  return (
    equalBytes(check.predecessor, scopeOf(scope).predecessorId) &&
    check.dealers.length >= dealerQuorum &&
    check.qualified.length >= q &&
    reshareConsentingSeats(scope, check.keyId, check.deadline, consents).length >= dealerQuorum &&
    reshareApprovingSeats(scope, check.keyId, check.deadline, approvals).length >= q
  );
}

/** `q' = max(k', n' − 1)`: the approvals a successor needs, and the qualified new seats an honest seat requires. */
export function nullifierReshareQuorum(scope: NullifierReshareScope): number {
  const s = scopeOf(scope);
  return Math.max(s.next.threshold, s.next.keys.length - 1);
}
