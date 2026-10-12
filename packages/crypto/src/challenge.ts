// The Benaloh challenge (docs/spec/challenge.md; ADR 0021, option B): a
// ballot's core and its tracking code, the spoiled-ballot opening record
// (type 0x0003, version 1) that reveals a challenged core's polynomials and
// encapsulation randomness, the client's side that makes one, and the checks
// that rebuild the core from it (T-42, T-44, T-47). A challenged core never
// reaches the board on its own; its opening is published only at the voter's
// request, after close.

import {
  BALLOT_RECORD_TYPE,
  BALLOT_VERSION,
  type CommittedVote,
  markOpened,
  type Share,
  VSS,
} from "./ballot-validity.ts";
import {
  type BallotElection,
  type BallotRecord,
  definitionHashOf,
  registeredKeysOf,
} from "./ballot.ts";
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

/** Spoiled-ballot opening, version 1: one challenged core and everything that made it. */
export type SpoiledBallotOpening = CodecValue<typeof openingV1>;

/** Record type `0x0003`. The election's profile pins its version. */
export const SPOILED_BALLOT_OPENING = recordType(RECORD_TYPES.spoiledBallotOpening, {
  1: openingV1,
});

const SCHEMA = new RecordSchema([SPOILED_BALLOT_OPENING]);

export function encodeOpening(record: SpoiledBallotOpening): Uint8Array {
  return SCHEMA.encode(SPOILED_BALLOT_OPENING, 1, record);
}

/**
 * Strictly decodes an opening against the version the election's profile
 * pins. Decoding compares nothing with the election; `checkChallengeOpening` does, so
 * an opening naming another election is still read, and reported.
 */
export function decodeOpening(bytes: Uint8Array, pinned: 1): SpoiledBallotOpening {
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
  const made = encryptionOf(encrypted);
  if (made === undefined) throw new TypeError("core: the shares must come from encryptShares");
  const { sharing } = made;
  if (!equalBytes(made.definitionHash, definitionHash))
    throw new RangeError("core: the shares were encrypted for another election");
  if (
    sharing.vss.length !== election.optionCount ||
    sharing.vss.some((e) => e.length !== election.threshold) ||
    sharing.shares.length !== election.panelSize
  )
    throw new RangeError("core: the sharing doesn't match the election");
  const registered = registeredKeysOf(election);
  // Each registered seat's ciphertext must be under its registered key, or
  // the opening would rebuild another ciphertext than the trustee checks.
  for (const k of registered)
    if (!equalBytes(made.keys[k.index - 1] as Uint8Array, encode(KEM_PUBLIC_KEY, k.kemKey)))
      throw new RangeError("core: a seat's shares weren't encrypted to its registered key");
  const qualified = registered.map((k) => k.index).sort((a, b) => a - b);
  // A seat outside the registered key set gets no shares: its hash is fixed
  // at zero (docs/spec/ballot-validity.md, Casting step 1).
  const shareHashes = made.hashes.map((h, i) =>
    qualified.includes(i + 1) ? Uint8Array.from(h) : Uint8Array.from(ZERO_HASH),
  );
  const core: BallotCore = {
    definitionHash: Uint8Array.from(definitionHash),
    tier,
    vss: sharing.vss,
    shareHashes,
  };
  return { core, made, qualified };
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

/**
 * Whether a published opening would open a commitment of `ballot`
 * (docs/spec/challenge.md, Opened commitments): the same definition hash,
 * and some ballot commitment `C_{j'}`, at any option, equal to an opened
 * `C_j`, or to `h^s` or `g · h^s` for a secret scalar `s` the opening
 * reveals: a coefficient of any `g_j`, a coefficient of any `f_j` but its
 * constant term (the vote), a seat's share `f_j(i)` or `g_j(i)`,
 * or a seat's `e_i` or `w_i`. An opened `C_j` is opened wherever it is cast
 * (under fresh share hashes, another tier, re-blinded higher coefficients or
 * another option), and so is any commitment to 0 or 1 whose randomness is a
 * revealed scalar. So `opening-cast` and the checker's warning compare this,
 * never tracking codes or whole VSS lists (T-45, T-47). Randomness derived
 * from revealed scalars by a chosen relation isn't caught: a residual. It
 * takes an opening that passed `checkChallengeOpening`, whose share hashes
 * give `n`.
 */
export function opensBallotCommitment(
  opening: SpoiledBallotOpening,
  ballot: Pick<BallotCore, "definitionHash" | "vss">,
): boolean {
  if (!equalBytes(opening.definition_hash, ballot.definitionHash)) return false;
  // Encoded, so an element is compared by its one canonical encoding.
  const enc = (e: Element) => toHex(encode(elementOrIdentity, e));
  const opened = new Set<string>();
  for (const row of opening.vss) {
    const c = row[0];
    if (c === undefined) throw new RangeError("vss: an option without commitments");
    opened.add(enc(c));
  }
  const seats = opening.share_hashes.map((_, i) => BigInt(i + 1));
  const revealed = new Set<bigint>();
  for (const { f, g } of opening.polynomials) {
    // f_j's constant term is the vote, 0 or 1, never randomness: h^{v_j} and
    // g · h^{v_j} are commitments anyone can open, so matching them would let
    // one such ballot block every opening, and reveal nothing (challenge.md).
    for (const c of f.slice(1)) revealed.add(c);
    for (const c of g) revealed.add(c);
    for (const poly of [f, g]) for (const x of seats) revealed.add(evaluate(poly, x));
  }
  for (const { e, w } of opening.seats) {
    revealed.add(e);
    revealed.add(w);
  }
  for (const s of revealed) {
    const hs = mul(GENERATOR_H, s);
    opened.add(enc(hs));
    opened.add(enc(hs.add(G)));
  }
  return ballot.vss.some((row) => {
    const c = row[0];
    if (c === undefined) throw new RangeError("vss: an option without commitments");
    return opened.has(enc(c));
  });
}

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
    polynomials: made.sharing.polynomials.map((p) => ({ f: [...p.f], g: [...p.g] })),
    seats: qualified.map((seat) => {
      const r = made.randomness[seat - 1] as (typeof made.randomness)[number];
      return { seat, m: Uint8Array.from(r.m), e: r.e, w: r.w };
    }),
  };
  // Throws if the sharing was proved; marked before anything leaves.
  markOpened(made.sharing);
  // Round-trips through the codec, so an opening this returns always encodes.
  encodeOpening(opening);
  return { opening, coreHash: coreHash(core) };
}

/** The checks of docs/spec/challenge.md (Checks), in checking order. */
export type ChallengeOpeningCode =
  | "opening-stray"
  | "opening-tier"
  | "opening-shape"
  | "opening-unqualified"
  | "opening-vss"
  | "opening-ciphertext";

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
  | {
      readonly ok: false;
      readonly code: ChallengeOpeningCode;
      readonly option?: number;
      readonly seat?: number;
    };

const mod = (x: bigint) => ((x % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER;

// Multiplication by 0 is allowed here: an opening's coefficients are public.
const mul = (p: Element, s: bigint) => (s === 0n ? IDENTITY : p.multiply(s));

function evaluate(coefficients: readonly bigint[], x: bigint): bigint {
  let acc = 0n;
  for (let t = coefficients.length - 1; t >= 0; t--)
    acc = mod(acc * x + (coefficients[t] as bigint));
  return acc;
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
  // Reads each field once, so a record with getters can't show one check one
  // value and the next another.
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
  const { optionCount: m, threshold: k, panelSize: n } = election;
  const registered = [...registeredKeysOf(election)].sort((a, b) => a.index - b.index);
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
  const votes = polynomials.map((p) => p.f[0] as bigint);
  const total = votes.reduce((a, v) => a + v, 0n);
  const withinRules =
    votes.every((v) => v === 0n || v === 1n) &&
    total >= BigInt(election.minSelections) &&
    total <= BigInt(election.maxSelections);
  return {
    ok: true,
    coreHash: coreHash({ definitionHash, tier, vss, shareHashes }),
    votes,
    withinRules,
  };
}
