// The Benaloh challenge (docs/spec/challenge.md; ADR 0021, option B): a
// ballot's core and its tracking code, the spoiled-ballot opening record
// (type 0x0003, version 1 for ballot version 1's cores, version 2 for the
// cores of ballot versions 2 and 3, which name a cell) that reveals a
// challenged core's polynomials and encapsulation randomness, the client's
// side that makes one, and the checks that rebuild the core from it (T-42,
// T-44, T-47). A challenged core never
// reaches the board on its own; its opening is published only at the voter's
// request, after close.

import {
  BALLOT_RECORD_TYPE,
  BALLOT_VERSION,
  type CommittedVote,
  type CommittedVoteV4,
  markOpened,
  type QuestionRules,
  type Share,
  sharingVersion,
  VSS,
} from "./ballot-validity.ts";
import {
  type BallotElection,
  type BallotRecord,
  type CellBallotElection,
  cellContextOf,
  definitionHashOf,
  type QuestionBallotElection,
  registeredKeysOf,
} from "./ballot.ts";
import type { RegisteredKeys } from "./ceremony.ts";
import {
  bytesFixed,
  type CodecValue,
  encode,
  enum8,
  list,
  struct,
  u16,
  u8,
  Writer,
} from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { TIERS } from "./election-definition.ts";
import {
  type Element,
  elementOrIdentity,
  G,
  GENERATOR_H,
  GROUP_ORDER,
  H,
  IDENTITY,
  scalar,
} from "./group.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import {
  type EncryptedShares,
  encryptionOf,
  encryptSeat,
  KEM_PUBLIC_KEY,
  shareCiphertextHash,
} from "./share-encryption.ts";

const { MAX_OPTIONS, MAX_TRUSTEES } = PARAMETERS;

const SHARE_HASHES = list(bytesFixed(32), MAX_TRUSTEES);

const optionOpening = struct([
  ["f", list(scalar, MAX_TRUSTEES)],
  ["g", list(scalar, MAX_TRUSTEES)],
] as const);

const seatOpening = struct([
  ["seat", u8],
  ["m", bytesFixed(32)],
  ["e", scalar],
  ["w", scalar],
] as const);

// The core comes first, in the order and encodings the core hash takes it.
const openingV1 = struct([
  ["definition_hash", bytesFixed(32)],
  ["tier", enum8(TIERS)],
  ["vss", VSS],
  ["share_hashes", SHARE_HASHES],
  ["polynomials", list(optionOpening, MAX_OPTIONS)],
  ["seats", list(seatOpening, MAX_TRUSTEES)],
] as const);

// Version 2 (docs/spec/challenge.md, Opening version 2): version 1's fields
// with the cell, any u8, in place of the tier. Decoding never compares it
// with the partition; `opening-cell` does.
const openingV2 = struct([
  ["definition_hash", bytesFixed(32)],
  ["cell", u8],
  ["vss", VSS],
  ["share_hashes", SHARE_HASHES],
  ["polynomials", list(optionOpening, MAX_OPTIONS)],
  ["seats", list(seatOpening, MAX_TRUSTEES)],
] as const);

/** Spoiled-ballot opening, version 1: one challenged core and everything that made it. */
export type SpoiledBallotOpening = CodecValue<typeof openingV1>;

/** Spoiled-ballot opening, version 2: the same for a core of ballot version 2 or 3, which names a cell. */
export type SpoiledBallotOpeningV2 = CodecValue<typeof openingV2>;

/** Record type `0x0003`. The election's profile pins its version. */
export const SPOILED_BALLOT_OPENING = recordType(RECORD_TYPES.spoiledBallotOpening, {
  1: openingV1,
  2: openingV2,
});

const SCHEMA = new RecordSchema([SPOILED_BALLOT_OPENING]);

export function encodeOpening(record: SpoiledBallotOpening): Uint8Array {
  return SCHEMA.encode(SPOILED_BALLOT_OPENING, 1, record);
}

export function encodeOpeningV2(record: SpoiledBallotOpeningV2): Uint8Array {
  return SCHEMA.encode(SPOILED_BALLOT_OPENING, 2, record);
}

/**
 * Strictly decodes an opening against the version the election's profile
 * pins. Decoding compares nothing with the election; `checkChallengeOpening`
 * and `checkChallengeOpeningV2` do, so an opening naming another election or
 * cell is still read, and reported.
 */
export function decodeOpening(bytes: Uint8Array, pinned: 1): SpoiledBallotOpening;
export function decodeOpening(bytes: Uint8Array, pinned: 2): SpoiledBallotOpeningV2;
export function decodeOpening(
  bytes: Uint8Array,
  pinned: 1 | 2,
): SpoiledBallotOpening | SpoiledBallotOpeningV2 {
  return SCHEMA.decode(SPOILED_BALLOT_OPENING, bytes, pinned).value;
}

/** A ballot's core: what it commits to before the voter chooses to cast or to challenge. */
export interface BallotCore {
  readonly definitionHash: Uint8Array;
  readonly tier: (typeof TIERS)[number];
  readonly vss: CommittedVote["vss"];
  readonly shareHashes: CommittedVote["share_hashes"];
}

/**
 * The tracking code `H(DS("abolish/v1/ballot-core", definition_hash ‖
 * u16(0x0002) ‖ u8(1) ‖ u8(tier) ‖ encode(vss) ‖ encode(share_hashes)))`
 * (docs/spec/ballot-validity.md, Core hash). Always the full 32 bytes: a
 * shorter rendering is a label, never a match (T-42).
 */
export function coreHash(core: BallotCore): Uint8Array {
  if (!(core.definitionHash instanceof Uint8Array) || core.definitionHash.length !== 32)
    throw new RangeError("coreHash: definitionHash must be 32 bytes");
  const w = new Writer();
  w.bytes(core.definitionHash);
  u16.write(w, BALLOT_RECORD_TYPE);
  u8.write(w, BALLOT_VERSION);
  enum8(TIERS).write(w, core.tier);
  VSS.write(w, core.vss);
  SHARE_HASHES.write(w, core.shareHashes);
  return H(ds("abolish/v1/ballot-core", w.finish()));
}

/** The core of a ballot of version 2 or 3, which names a cell of the partition rather than a tier. */
export interface CellBallotCore {
  readonly definitionHash: Uint8Array;
  readonly ballotVersion: 2 | 3;
  readonly cell: number;
  readonly vss: CommittedVote["vss"];
  readonly shareHashes: CommittedVote["share_hashes"];
}

/**
 * The tracking code of a core of ballot version 2 or 3 (docs/spec/ballot-validity.md,
 * Core hash): version 1's inputs with the version input 2 or 3 and the cell
 * in place of the tier, so one code never names cores of two ballot versions
 * (T-42, T-47, T-31).
 */
export function cellCoreHash(core: CellBallotCore): Uint8Array {
  if (!(core.definitionHash instanceof Uint8Array) || core.definitionHash.length !== 32)
    throw new RangeError("cellCoreHash: definitionHash must be 32 bytes");
  if (core.ballotVersion !== 2 && core.ballotVersion !== 3)
    throw new RangeError("cellCoreHash: ballot version 2 or 3");
  const w = new Writer();
  w.bytes(core.definitionHash);
  u16.write(w, BALLOT_RECORD_TYPE);
  u8.write(w, core.ballotVersion);
  u8.write(w, core.cell);
  VSS.write(w, core.vss);
  SHARE_HASHES.write(w, core.shareHashes);
  return H(ds("abolish/v1/ballot-core", w.finish()));
}

/** The core of a ballot of version 4: version 3's, with the author half (empty without an author panel). */
export interface CellBallotCoreV4 {
  readonly definitionHash: Uint8Array;
  readonly cell: number;
  readonly vss: CommittedVoteV4["vss"];
  readonly shareHashes: CommittedVoteV4["share_hashes"];
  readonly authorVss: CommittedVoteV4["author_vss"];
  readonly authorShareHashes: CommittedVoteV4["author_share_hashes"];
}

/**
 * The tracking code of a core of ballot version 4 (docs/spec/ballot-validity.md,
 * Hashes (version 4)): version 3's inputs with version input 4 and the author
 * half after the default half, so the code names both halves and a challenge
 * opens both (T-42, T-47, T-31).
 */
export function coreHashV4(core: CellBallotCoreV4): Uint8Array {
  if (!(core.definitionHash instanceof Uint8Array) || core.definitionHash.length !== 32)
    throw new RangeError("coreHashV4: definitionHash must be 32 bytes");
  const w = new Writer();
  w.bytes(core.definitionHash);
  u16.write(w, BALLOT_RECORD_TYPE);
  u8.write(w, 4);
  u8.write(w, core.cell);
  VSS.write(w, core.vss);
  SHARE_HASHES.write(w, core.shareHashes);
  VSS.write(w, core.authorVss);
  SHARE_HASHES.write(w, core.authorShareHashes);
  return H(ds("abolish/v1/ballot-core", w.finish()));
}

/** The tracking code of a cast ballot record, which the voter's checker finds it by. */
export function ballotCoreHash(ballot: BallotRecord): Uint8Array {
  return coreHash({
    definitionHash: ballot.definition_hash,
    tier: ballot.tier,
    vss: ballot.committed_vote.vss,
    shareHashes: ballot.committed_vote.share_hashes,
  });
}

/** The tracking code of an opening's core. */
export function openingCoreHash(opening: SpoiledBallotOpening): Uint8Array {
  return coreHash({
    definitionHash: opening.definition_hash,
    tier: opening.tier,
    vss: opening.vss,
    shareHashes: opening.share_hashes,
  });
}

/**
 * The tracking code of a version-2 opening's core under the ballot version
 * its election's profile pins, 2 or 3: the opening carries none of its own,
 * so the same bytes under two elections are two cores (docs/spec/
 * challenge.md, Opening version 2; T-42, T-47).
 */
export function openingV2CoreHash(
  opening: SpoiledBallotOpeningV2,
  ballotVersion: 2 | 3,
): Uint8Array {
  return cellCoreHash({
    definitionHash: opening.definition_hash,
    ballotVersion,
    cell: opening.cell,
    vss: opening.vss,
    shareHashes: opening.share_hashes,
  });
}

const ZERO_HASH = new Uint8Array(32);

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// The core of shares `encryptShares` made for this election, checked as
// both the code shown before the choice and a challenge's opening need it.
function coreOf(
  election: BallotElection,
  tier: (typeof TIERS)[number],
  encrypted: EncryptedShares,
) {
  const definitionHash = definitionHashOf(election);
  if (!election.tiers.some((g) => g.tier === tier))
    throw new RangeError("core: the election has no group of this tier");
  // A version-1 core only: a version-3 sharing's votes were checked against
  // its questions, never this election's one range (opening version 2 opens
  // version-3 cores; T-42).
  const { made, vss, shareHashes, qualified } = sealedCore(
    { definitionHash, keys: registeredKeysOf(election), sharingVersion: 1 },
    election.optionCount,
    election.threshold,
    election.panelSize,
    encrypted,
  );
  const core: BallotCore = {
    definitionHash: Uint8Array.from(definitionHash),
    tier,
    vss,
    shareHashes,
  };
  return { core, made, qualified };
}

// What the cores of every version share: shares `encryptShares` made from a
// sharing of the version the ballot version proves, for this election, over
// its `m` options, `k` and `n`, each registered seat's under its registered
// key, and every other seat's share hash zero.
function sealedCore(
  context: {
    readonly definitionHash: Uint8Array;
    readonly keys: readonly RegisteredKeys[];
    readonly sharingVersion: 1 | 3;
  },
  m: number,
  k: number,
  n: number,
  encrypted: EncryptedShares,
) {
  const made = encryptionOf(encrypted);
  if (made === undefined) throw new TypeError("core: the shares must come from encryptShares");
  const { sharing } = made;
  if (sharingVersion(sharing) !== context.sharingVersion)
    throw new TypeError(
      `core: the shares must come from a version-${context.sharingVersion} sharing`,
    );
  if (!equalBytes(made.definitionHash, context.definitionHash))
    throw new RangeError("core: the shares were encrypted for another election");
  if (
    sharing.vss.length !== m ||
    sharing.vss.some((e) => e.length !== k) ||
    sharing.shares.length !== n
  )
    throw new RangeError("core: the sharing doesn't match the election");
  // Each registered seat's ciphertext must be under its registered key, or
  // the opening would rebuild another ciphertext than the trustee checks.
  for (const key of context.keys)
    if (!equalBytes(made.keys[key.index - 1] as Uint8Array, encode(KEM_PUBLIC_KEY, key.kemKey)))
      throw new RangeError("core: a seat's shares weren't encrypted to its registered key");
  const qualified = context.keys.map((key) => key.index).sort((a, b) => a - b);
  // A seat outside the registered key set gets no shares: its hash is fixed
  // at zero (docs/spec/ballot-validity.md, Casting step 1).
  const shareHashes = made.hashes.map((h, i) =>
    qualified.includes(i + 1) ? Uint8Array.from(h) : Uint8Array.from(ZERO_HASH),
  );
  return { made, vss: sharing.vss, shareHashes, qualified };
}

/**
 * The core of shares `encryptShares` made for this election and tier: what
 * the client shows the tracking code of before the voter chooses, and, on
 * cast, the share hashes it proves over (docs/spec/ballot-validity.md,
 * Casting; docs/spec/challenge.md, Client rules). `openChallenge` opens
 * exactly this core, so the code shown, the core opened and the core cast
 * come from one place.
 */
export function ballotCore(
  election: BallotElection,
  tier: (typeof TIERS)[number],
  encrypted: EncryptedShares,
): BallotCore {
  return coreOf(election, tier, encrypted).core;
}

/** The tracking code the client shows before the cast-or-challenge choice: `coreHash(ballotCore(…))`. */
export function trackingCode(
  election: BallotElection,
  tier: (typeof TIERS)[number],
  encrypted: EncryptedShares,
): Uint8Array {
  return coreHash(ballotCore(election, tier, encrypted));
}

/** What one published opening opens, built once by `openedCommitments`. */
export interface OpenedCommitments {
  readonly definitionHash: Uint8Array;
  /** Whether `commitment` is one the opening opens. */
  readonly has: (commitment: Element) => boolean;
}

/**
 * What a published opening opens (docs/spec/challenge.md, Opened
 * commitments): each opened `C_j`, and `h^s` and `g · h^s` for every scalar
 * `s` it reveals (every coefficient of every `f_j` and `g_j`, each seat's
 * shares `f_j(i)` and `g_j(i)`, each registered seat's `e_i` and `w_i`)
 * except 0 and 1. Those two are public, an honest vote is one of them, and
 * `h^s` or `g · h^s` for them opens nothing, so matching them would let one
 * ballot carrying `g` or `h` block every opening; an out-of-rules vote is
 * kept, since a ballot could use it as randomness. Built once per opening,
 * so a verifier tests each ballot against it with no group operations (T-52).
 * It takes an opening of either version that passed `checkChallengeOpening`
 * or `checkChallengeOpeningV2`, whose share hashes give `n`; a version-2
 * opening opens commitments whatever their ballot's cell (Opening version 2). Randomness derived from revealed scalars by a chosen relation
 * isn't caught: a residual.
 */
export function openedCommitments(
  opening: SpoiledBallotOpening | SpoiledBallotOpeningV2,
): OpenedCommitments {
  const encodings = new Set<string>();
  for (const row of opening.vss) {
    const c = row[0];
    if (c === undefined) throw new RangeError("vss: an option without commitments");
    encodings.add(encodeHex(c));
  }
  const seats = opening.share_hashes.map((_, i) => BigInt(i + 1));
  const revealed = new Set<bigint>();
  for (const { f, g } of opening.polynomials)
    for (const poly of [f, g]) {
      for (const c of poly) revealed.add(c);
      for (const x of seats) revealed.add(evaluate(poly, x));
    }
  for (const { e, w } of opening.seats) {
    revealed.add(e);
    revealed.add(w);
  }
  revealed.delete(0n);
  revealed.delete(1n);
  for (const s of revealed) {
    const hs = mul(GENERATOR_H, s);
    encodings.add(encodeHex(hs));
    encodings.add(encodeHex(hs.add(G)));
  }
  // The set stays private: callers can only look commitments up in it.
  return Object.freeze({
    definitionHash: Uint8Array.from(opening.definition_hash),
    has: (commitment: Element) => encodings.has(encodeHex(commitment)),
  });
}

/**
 * Whether a published opening opens a commitment of `ballot`: the same
 * definition hash, and some ballot commitment `C_{j'}`, at any option, in
 * the opening's `openedCommitments`. `opening-cast` and the checker's warning
 * compare this, never tracking codes or whole VSS lists (T-45, T-47).
 */
export function opensBallotCommitment(
  opened: OpenedCommitments,
  ballot: Pick<BallotCore, "definitionHash" | "vss">,
): boolean {
  if (!equalBytes(opened.definitionHash, ballot.definitionHash)) return false;
  return ballot.vss.some((row) => {
    const c = row[0];
    if (c === undefined) throw new RangeError("vss: an option without commitments");
    return opened.has(c);
  });
}

// Canonical encoding, hex, so an element is compared by its one encoding.
const encodeHex = (e: Element) => toHex(encode(elementOrIdentity, e));

/**
 * The client's side of a challenge (docs/spec/challenge.md, Client rules 2):
 * the opening of the core `ballotCore` gives for these shares, which the
 * voter's checker checks. It reveals only a sharing this package made and
 * hasn't proved, and marks it opened, so `proveValidity` refuses it from
 * then on: an opened core is never cast, and a cast core is never opened
 * (T-42, T-45). Seats outside the registered key set reveal nothing. The
 * opening leaves the device only by QR code or file, and is published only
 * at the voter's request, after the counted extent.
 */
export function openChallenge(
  election: BallotElection,
  tier: (typeof TIERS)[number],
  encrypted: EncryptedShares,
): { readonly opening: SpoiledBallotOpening; readonly coreHash: Uint8Array } {
  const { core, made, qualified } = coreOf(election, tier, encrypted);
  const opening: SpoiledBallotOpening = {
    definition_hash: core.definitionHash,
    tier,
    vss: core.vss,
    share_hashes: core.shareHashes,
    ...revealed(made, qualified),
  };
  // Throws if the sharing was proved; marked before anything leaves.
  markOpened(made.sharing);
  // Round-trips through the codec, so an opening this returns always encodes.
  encodeOpening(opening);
  return { opening, coreHash: coreHash(core) };
}

// What a challenge reveals beside the core: every polynomial, and each
// registered seat's encapsulation randomness, in increasing seat order.
function revealed(
  made: NonNullable<ReturnType<typeof encryptionOf>>,
  qualified: readonly number[],
): Pick<SpoiledBallotOpening, "polynomials" | "seats"> {
  return {
    polynomials: made.sharing.polynomials.map((p) => ({ f: [...p.f], g: [...p.g] })),
    seats: qualified.map((seat) => {
      const r = made.randomness[seat - 1] as (typeof made.randomness)[number];
      return { seat, m: Uint8Array.from(r.m), e: r.e, w: r.w };
    }),
  };
}

/** The checks of docs/spec/challenge.md (Checks), in checking order. */
export type ChallengeOpeningCode =
  | "opening-stray"
  | "opening-tier"
  | "opening-shape"
  | "opening-unqualified"
  | "opening-vss"
  | "opening-ciphertext";

/** Opening version 2's checks: version 1's, with `opening-cell` in place of `opening-tier`. */
export type ChallengeOpeningV2Code = Exclude<ChallengeOpeningCode, "opening-tier"> | "opening-cell";

type OpeningFailure<C> = {
  readonly ok: false;
  readonly code: C;
  readonly option?: number;
  readonly seat?: number;
};

export type ChallengeOpeningCheck =
  | {
      readonly ok: true;
      /** The tracking code of the opened core. */
      readonly coreHash: Uint8Array;
      /** `v_j = coef_0(f_j)` for each option, as the scalar the client committed to. */
      readonly votes: readonly bigint[];
      /** `false` is `opening-vote-outside`: no valid ballot could carry this vote. */
      readonly withinRules: boolean;
    }
  | OpeningFailure<ChallengeOpeningCode>;

export type ChallengeOpeningV2Check =
  | {
      readonly ok: true;
      /** The tracking code of the opened core, under the ballot version the profile pins. */
      readonly coreHash: Uint8Array;
      /** `v_j = coef_0(f_j)` for each flat option, as the scalar the client committed to. */
      readonly votes: readonly bigint[];
      /** `false` is `opening-vote-outside`: no valid ballot could carry this vote. */
      readonly withinRules: boolean;
      /** With `withinRules` false, the first question whose votes are outside its rules. */
      readonly question?: number;
    }
  | OpeningFailure<ChallengeOpeningV2Code>;

const mod = (x: bigint) => ((x % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER;

// Multiplication by 0 is allowed here: an opening's coefficients are public.
const mul = (p: Element, s: bigint) => (s === 0n ? IDENTITY : p.multiply(s));

function evaluate(coefficients: readonly bigint[], x: bigint): bigint {
  let acc = 0n;
  for (let t = coefficients.length - 1; t >= 0; t--)
    acc = mod(acc * x + (coefficients[t] as bigint));
  return acc;
}

// The fields every opening version shares after its header field, read once
// by the caller, so a record with getters can't show one check one value and
// the next another.
interface OpenedCore {
  readonly vss: CommittedVote["vss"];
  readonly shareHashes: readonly Uint8Array[];
  readonly polynomials: SpoiledBallotOpening["polynomials"];
  readonly seats: SpoiledBallotOpening["seats"];
}

// The checks after the header (docs/spec/challenge.md, Checks: from
// `opening-shape` on, in order), over `m` options, `k` and `n`, with each
// registered seat's ciphertext rebuilt from the opening, never from a board
// entry. Undefined when they all pass.
function checkOpenedCore(
  definitionHash: Uint8Array,
  keys: readonly RegisteredKeys[],
  m: number,
  k: number,
  n: number,
  { vss, shareHashes, polynomials, seats }: OpenedCore,
): OpeningFailure<Exclude<ChallengeOpeningCode, "opening-stray" | "opening-tier">> | undefined {
  const registered = [...keys].sort((a, b) => a.index - b.index);
  const shapeOk =
    vss.length === m &&
    vss.every((e) => e.length === k) &&
    shareHashes.length === n &&
    polynomials.length === m &&
    polynomials.every((p) => p.f.length === k && p.g.length === k) &&
    seats.length === registered.length &&
    seats.every((s, i) => s.seat === (registered[i] as (typeof registered)[number]).index);
  if (!shapeOk) return { ok: false, code: "opening-shape" };
  const qualified = new Set(registered.map((r) => r.index));
  for (let seat = 1; seat <= n; seat++)
    if (!qualified.has(seat) && !equalBytes(shareHashes[seat - 1] as Uint8Array, ZERO_HASH))
      return { ok: false, code: "opening-unqualified" };
  for (let j = 0; j < m; j++) {
    const { f, g } = polynomials[j] as (typeof polynomials)[number];
    const row = vss[j] as readonly Element[];
    for (let t = 0; t < k; t++) {
      const rebuilt = mul(G, f[t] as bigint).add(mul(GENERATOR_H, g[t] as bigint));
      if (!rebuilt.equals(row[t] as Element)) return { ok: false, code: "opening-vss", option: j };
    }
  }
  const ctx = { definitionHash };
  for (const [i, key] of registered.entries()) {
    const s = seats[i] as (typeof seats)[number];
    const shares: Share[] = polynomials.map((p) => ({
      v: evaluate(p.f, BigInt(s.seat)),
      r: evaluate(p.g, BigInt(s.seat)),
    }));
    // An honest client draws e and w from 1 to ℓ − 1; e = 0 has no ciphertext.
    const rebuilt =
      s.e === 0n || s.w === 0n
        ? undefined
        : encryptSeat(ctx, s.seat, key.kemKey, vss, shares, { m: s.m, e: s.e, w: s.w });
    if (
      rebuilt === undefined ||
      !equalBytes(shareCiphertextHash(rebuilt), shareHashes[s.seat - 1] as Uint8Array)
    )
      return { ok: false, code: "opening-ciphertext", seat: s.seat };
  }
  return undefined;
}

// The first question whose votes aren't each 0 or 1 with a sum within its
// limits (`opening-vote-outside`), over the flat options in question order.
function firstQuestionOutside(
  questions: readonly QuestionRules[],
  votes: readonly bigint[],
): number | undefined {
  let offset = 0;
  for (const [q, rules] of questions.entries()) {
    const own = votes.slice(offset, offset + rules.optionCount);
    offset += rules.optionCount;
    const total = own.reduce((a, v) => a + v, 0n);
    if (
      !own.every((v) => v === 0n || v === 1n) ||
      total < BigInt(rules.minSelections) ||
      total > BigInt(rules.maxSelections)
    )
      return q;
  }
  return undefined;
}

/**
 * Checks a decoded opening against a registered election
 * (docs/spec/challenge.md, Checks): the core's shape and unqualified seats,
 * then every VSS commitment and every registered seat's ciphertext rebuilt
 * from the opening, never from a board entry. The first failure is the
 * result. A passing opening gives its tracking code and the vote it opens to,
 * whatever that vote is (`withinRules` false is `opening-vote-outside`).
 * Whether its vote was cast, and where it was boarded, are the board's checks
 * (`opensBallotCommitment`). It takes a record `decodeOpening` returned: a
 * hand-built one with a coefficient at or above ℓ, say, throws instead.
 */
export function checkChallengeOpening(
  election: BallotElection,
  opening: SpoiledBallotOpening,
): ChallengeOpeningCheck {
  const definitionHash = definitionHashOf(election);
  const {
    definition_hash: claimed,
    tier,
    vss,
    share_hashes: shareHashes,
    polynomials,
    seats,
  } = opening;
  if (!equalBytes(claimed, definitionHash)) return { ok: false, code: "opening-stray" };
  if (!election.tiers.some((g) => g.tier === tier)) return { ok: false, code: "opening-tier" };
  const failed = checkOpenedCore(
    definitionHash,
    registeredKeysOf(election),
    election.optionCount,
    election.threshold,
    election.panelSize,
    { vss, shareHashes, polynomials, seats },
  );
  if (failed !== undefined) return failed;
  const votes = polynomials.map((p) => p.f[0] as bigint);
  return {
    ok: true,
    coreHash: coreHash({ definitionHash, tier, vss, shareHashes }),
    votes,
    withinRules: firstQuestionOutside([election], votes) === undefined,
  };
}

// A cell context's questions: ballot version 3's own, or ballot version 2's
// one question, the definition's option count and range (Opening version 2,
// Votes outside the rules).
function questionsOf(election: CellBallotElection | QuestionBallotElection) {
  return "questions" in election ? election.questions : [election];
}

// The core of shares `encryptShares` made for a cell of this election: a
// ballot version 2 core from a version-1 sharing over the definition's
// options, a ballot version 3 core from a version-3 sharing over its flat
// options (T-42, T-31).
function cellCoreOf(
  election: CellBallotElection | QuestionBallotElection,
  cell: number,
  encrypted: EncryptedShares,
) {
  const { definitionHash, ballotVersion, keys } = cellContextOf(election);
  if (!Number.isInteger(cell) || cell < 0 || cell >= election.cells.length)
    throw new RangeError("core: the election's partition has no such cell");
  const { made, vss, shareHashes, qualified } = sealedCore(
    { definitionHash, keys, sharingVersion: ballotVersion === 2 ? 1 : 3 },
    questionsOf(election).reduce((t, q) => t + q.optionCount, 0),
    election.threshold,
    election.panelSize,
    encrypted,
  );
  const core: CellBallotCore = {
    definitionHash: Uint8Array.from(definitionHash),
    ballotVersion,
    cell,
    vss,
    shareHashes,
  };
  return { core, made, qualified };
}

/**
 * `ballotCore` for a ballot of version 2 or 3: the core of shares
 * `encryptShares` made for this election and cell, under the ballot version
 * its context checks (docs/spec/challenge.md, Opening version 2).
 * `openChallengeV2` opens exactly this core.
 */
export function cellBallotCore(
  election: CellBallotElection | QuestionBallotElection,
  cell: number,
  encrypted: EncryptedShares,
): CellBallotCore {
  return cellCoreOf(election, cell, encrypted).core;
}

/** The tracking code the client shows before the cast-or-challenge choice: `cellCoreHash(cellBallotCore(…))`. */
export function cellTrackingCode(
  election: CellBallotElection | QuestionBallotElection,
  cell: number,
  encrypted: EncryptedShares,
): Uint8Array {
  return cellCoreHash(cellBallotCore(election, cell, encrypted));
}

/**
 * `openChallenge` for a ballot of version 2 or 3: the version-2 opening of
 * the core `cellBallotCore` gives for these shares, under the same rules (it
 * reveals only a sharing this package made and hasn't proved, and marks it
 * opened; seats outside the registered key set reveal nothing; T-42, T-45).
 */
export function openChallengeV2(
  election: CellBallotElection | QuestionBallotElection,
  cell: number,
  encrypted: EncryptedShares,
): { readonly opening: SpoiledBallotOpeningV2; readonly coreHash: Uint8Array } {
  const { core, made, qualified } = cellCoreOf(election, cell, encrypted);
  const opening: SpoiledBallotOpeningV2 = {
    definition_hash: core.definitionHash,
    cell,
    vss: core.vss,
    share_hashes: core.shareHashes,
    ...revealed(made, qualified),
  };
  // Throws if the sharing was proved; marked before anything leaves.
  markOpened(made.sharing);
  encodeOpeningV2(opening);
  return { opening, coreHash: cellCoreHash(core) };
}

/**
 * Checks a decoded version-2 opening against a registered election of
 * definition version 3, 4 or 5 (docs/spec/challenge.md, Opening version 2):
 * version 1's checks in order, with `opening-cell` in place of
 * `opening-tier` and `m` the definition's option count, under version 5 the
 * total over its questions. A passing opening gives its tracking code under
 * the ballot version the context checks, and its votes, whatever they are;
 * `withinRules` false is `opening-vote-outside`, with the first question
 * outside (under definition versions 3 and 4, question 0). It takes a record
 * `decodeOpening(…, 2)` returned.
 */
export function checkChallengeOpeningV2(
  election: CellBallotElection | QuestionBallotElection,
  opening: SpoiledBallotOpeningV2,
): ChallengeOpeningV2Check {
  const { definitionHash, ballotVersion, keys } = cellContextOf(election);
  const {
    definition_hash: claimed,
    cell,
    vss,
    share_hashes: shareHashes,
    polynomials,
    seats,
  } = opening;
  if (!equalBytes(claimed, definitionHash)) return { ok: false, code: "opening-stray" };
  if (cell >= election.cells.length) return { ok: false, code: "opening-cell" };
  const questions = questionsOf(election);
  const failed = checkOpenedCore(
    definitionHash,
    keys,
    questions.reduce((t, q) => t + q.optionCount, 0),
    election.threshold,
    election.panelSize,
    { vss, shareHashes, polynomials, seats },
  );
  if (failed !== undefined) return failed;
  const votes = polynomials.map((p) => p.f[0] as bigint);
  const outside = firstQuestionOutside(questions, votes);
  return {
    ok: true,
    coreHash: cellCoreHash({ definitionHash, ballotVersion, cell, vss, shareHashes }),
    votes,
    withinRules: outside === undefined,
    ...(outside !== undefined && { question: outside }),
  };
}
