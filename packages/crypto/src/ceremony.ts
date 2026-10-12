// The key ceremony (docs/spec/ceremony.md, ADR 0018, record type 0x0005):
// each seat registers a per-election KEM key and signing key, proves it holds
// the DH key (Schnorr) and the signing key (a signature), and proves it holds
// the ML-KEM key by answering every other seat's encapsulated challenge before
// the challenges are revealed. The transcript check recomputes the qualified
// seats and their keys from the transcript alone (T-37, T-40, T-14, T-54).
// ML-KEM, ECDSA and the group are @noble's; this module only composes them.

import { p256 } from "@noble/curves/nist.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { randomScalar } from "./ballot-validity.ts";
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
import {
  challenge,
  type Element,
  elementOrIdentity,
  G,
  GROUP_ORDER,
  H,
  IDENTITY,
  scalar,
} from "./group.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import {
  KEM_PUBLIC_KEY,
  type KemKeyPair,
  kemKeygen,
  type KemPublicKey,
} from "./share-encryption.ts";
import {
  identityKey,
  type Panel,
  panelId,
  p256Key,
  p256Sig,
  signStatement,
  verifyStatement,
} from "./trustee.ts";

const { MAX_TRUSTEES } = PARAMETERS;

/** FIPS 203 Table 3, ML-KEM-768: ciphertext and message sizes. */
const MLKEM_CT_LEN = 1088;
const MLKEM_MSG_LEN = 32;

const MESSAGE_TAG = "abolish/v1/sig/ceremony-message";
const SIGNING_KEY_TAG = "abolish/v1/sig/ceremony-signing-key";

const ROUND_1 = struct([
  ["index", u8],
  ["kem_key", KEM_PUBLIC_KEY],
  ["signing_key", p256Key],
  ["pok_c", scalar],
  ["pok_z", scalar],
  ["signing_pop", p256Sig],
  ["signature", p256Sig],
] as const);

const ROUND_2 = struct([
  ["index", u8],
  ["challenges", list(bytesFixed(MLKEM_CT_LEN), MAX_TRUSTEES - 1)],
  ["signature", p256Sig],
] as const);

const ROUND_3 = struct([
  ["index", u8],
  ["answers", list(bytesFixed(MLKEM_MSG_LEN), MAX_TRUSTEES - 1)],
  ["signature", p256Sig],
] as const);

const ROUND_4 = struct([
  ["index", u8],
  ["reveals", list(bytesFixed(MLKEM_MSG_LEN), MAX_TRUSTEES - 1)],
  ["signature", p256Sig],
] as const);

const KEYS = list(ROUND_1, MAX_TRUSTEES);
const CHALLENGES = list(ROUND_2, MAX_TRUSTEES);
const ANSWERS = list(ROUND_3, MAX_TRUSTEES);
const REVEALS = list(ROUND_4, MAX_TRUSTEES);

const transcriptV1 = struct([
  ["run_id", bytesFixed(32)],
  ["keys", KEYS],
  ["challenges", CHALLENGES],
  ["answers", ANSWERS],
  ["reveals", REVEALS],
] as const);

export type KeysMessage = CodecValue<typeof ROUND_1>;
export type ChallengesMessage = CodecValue<typeof ROUND_2>;
export type AnswersMessage = CodecValue<typeof ROUND_3>;
export type RevealsMessage = CodecValue<typeof ROUND_4>;

/** Ceremony transcript, version 1 (docs/spec/ceremony.md, Transcript). */
export type CeremonyTranscript = CodecValue<typeof transcriptV1>;

/** Record type `0x0005`: the key ceremony's public transcript. */
export const CEREMONY_TRANSCRIPT = recordType(RECORD_TYPES.ceremonyTranscript, {
  1: transcriptV1,
});

const SCHEMA = new RecordSchema([CEREMONY_TRANSCRIPT]);

/** Encodes a transcript under version 1, the only version. */
export function encodeCeremonyTranscript(transcript: CeremonyTranscript): Uint8Array {
  return SCHEMA.encode(CEREMONY_TRANSCRIPT, 1, transcript);
}

/** Strictly decodes a transcript against the version the election's profile pins. */
export function decodeCeremonyTranscript(bytes: Uint8Array, pinned: 1): CeremonyTranscript {
  return SCHEMA.decode(CEREMONY_TRANSCRIPT, bytes, pinned).value;
}

/** `H(DS("abolish/v1/ceremony-transcript", encode(transcript)))`, over the full record encoding. */
export function ceremonyTranscriptHash(encoded: Uint8Array): Uint8Array {
  return H(ds("abolish/v1/ceremony-transcript", encoded));
}

/** What a run of the ceremony is for; every field comes from the stub and the pinned panel. */
export interface CeremonyParams {
  readonly l2ChainId: bigint;
  readonly trusteeRegistry: Uint8Array;
  readonly electionId: Uint8Array;
  readonly stubHash: Uint8Array;
  readonly panel: Panel;
  readonly runId: Uint8Array;
}

const CONTEXT = struct([
  ["l2_chain_id", u64],
  ["trustee_registry", bytesFixed(20)],
  ["election_id", bytesFixed(32)],
  ["stub_hash", bytesFixed(32)],
  ["panel_id", bytesFixed(32)],
  ["run_id", bytesFixed(32)],
] as const);

interface Run {
  readonly context: Uint8Array;
  readonly threshold: number;
  readonly keys: readonly Uint8Array[];
}

// Each field read once, and the panel's identifier computed here, never taken
// from data (T-37).
function runOf(params: CeremonyParams): Run {
  if (params === null || typeof params !== "object")
    throw new TypeError("ceremony: expected parameters");
  const { l2ChainId, trusteeRegistry, electionId, stubHash, panel, runId } = params;
  if (panel === null || typeof panel !== "object")
    throw new TypeError("ceremony: expected a panel");
  const keys = Array.isArray(panel.keys) ? panel.keys.map((k) => Uint8Array.from(k)) : [];
  const threshold = panel.threshold;
  const id = panelId({ threshold, keys });
  const context = H(
    ds(
      "abolish/v1/ceremony-context",
      encode(CONTEXT, {
        l2_chain_id: l2ChainId,
        trustee_registry: trusteeRegistry,
        election_id: electionId,
        stub_hash: stubHash,
        panel_id: id,
        run_id: runId,
      }),
    ),
  );
  return { context, threshold, keys };
}

/** `ceremony_context` (docs/spec/ceremony.md, Ceremony context). */
export function ceremonyContext(params: CeremonyParams): Uint8Array {
  return runOf(params).context;
}

/** `h_r = H(DS("abolish/v1/ceremony-round", h_{r−1} ‖ u8(r) ‖ encode(R_r)))`. */
function roundHash(prev: Uint8Array, round: number, encodedRound: Uint8Array): Uint8Array {
  const w = new Writer();
  w.bytes(prev);
  u8.write(w, round);
  w.bytes(encodedRound);
  return H(ds("abolish/v1/ceremony-round", w.finish()));
}

/** The chain `h_0 … h_3` over the rounds given so far. */
function chain(context: Uint8Array, t: Partial<Rounds>): Uint8Array[] {
  const h = [context];
  if (t.keys === undefined) return h;
  h.push(roundHash(h[0] as Uint8Array, 1, encode(KEYS, t.keys)));
  if (t.challenges === undefined) return h;
  h.push(roundHash(h[1] as Uint8Array, 2, encode(CHALLENGES, t.challenges)));
  if (t.answers === undefined) return h;
  h.push(roundHash(h[2] as Uint8Array, 3, encode(ANSWERS, t.answers)));
  return h;
}

type Rounds = Pick<CeremonyTranscript, "keys" | "challenges" | "answers" | "reveals">;

// `body` is the message's encoding without `index` (first byte) and the
// 64-byte signature (last), which is exactly its fields in between.
function signedMessage(round: number, prev: Uint8Array, encoded: Uint8Array): Uint8Array {
  const w = new Writer();
  u8.write(w, round);
  w.bytes(prev);
  w.bytes(encoded.subarray(0, encoded.length - 64));
  return w.finish();
}

const ROUND_CODECS = [ROUND_1, ROUND_2, ROUND_3, ROUND_4] as const;

function messageOk(
  run: Run,
  round: number,
  prev: Uint8Array,
  msg: { index: number; signature: Uint8Array },
): boolean {
  const key = run.keys[msg.index - 1];
  if (key === undefined) return false;
  const codec = ROUND_CODECS[round - 1] as (typeof ROUND_CODECS)[number];
  const encoded = encode(codec as never, msg as never);
  return verifyStatement(key, MESSAGE_TAG, signedMessage(round, prev, encoded), msg.signature);
}

function sign<T extends { signature: Uint8Array }>(
  identitySecret: Uint8Array,
  round: number,
  prev: Uint8Array,
  unsigned: Omit<T, "signature">,
): T {
  const codec = ROUND_CODECS[round - 1] as (typeof ROUND_CODECS)[number];
  // Encoded with a placeholder signature: the body is everything before it.
  const placeholder = { ...unsigned, signature: PLACEHOLDER_SIG } as unknown as T;
  const encoded = encode(codec as never, placeholder as never);
  const signature = signStatement(identitySecret, MESSAGE_TAG, signedMessage(round, prev, encoded));
  const signed = { ...unsigned, signature } as unknown as T;
  // Round-tripped, so only an encodable message with its own copies leaves here.
  return decode(codec as never, encode(codec as never, signed as never)) as T;
}

// r = s = 1: a canonical encoding no real signature takes the place of.
const PLACEHOLDER_SIG = (() => {
  const b = new Uint8Array(64);
  b[31] = 1;
  b[63] = 1;
  return b;
})();

function possessionChallenge(
  context: Uint8Array,
  index: number,
  kemKey: KemPublicKey,
  signingKey: Uint8Array,
  a: Element,
): bigint {
  const w = new Writer();
  w.bytes(context);
  u8.write(w, index);
  KEM_PUBLIC_KEY.write(w, kemKey);
  p256Key.write(w, signingKey);
  elementOrIdentity.write(w, a);
  return challenge("abolish/v1/fs/ceremony/possession", w.finish());
}

function signingPopMessage(
  context: Uint8Array,
  index: number,
  kemKey: KemPublicKey,
  signingKey: Uint8Array,
): Uint8Array {
  const w = new Writer();
  w.bytes(context);
  u8.write(w, index);
  KEM_PUBLIC_KEY.write(w, kemKey);
  p256Key.write(w, signingKey);
  return w.finish();
}

// @noble rejects a multiplier of 0, which proofs legitimately use.
function mul(p: Element, s: bigint): Element {
  const e = ((s % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER;
  return e === 0n ? IDENTITY : p.multiply(e);
}

function possessionOk(context: Uint8Array, m: KeysMessage): boolean {
  const a = mul(G, m.pok_z).subtract(mul(m.kem_key.dh, m.pok_c));
  if (possessionChallenge(context, m.index, m.kem_key, m.signing_key, a) !== m.pok_c) return false;
  return verifyStatement(
    m.signing_key,
    SIGNING_KEY_TAG,
    signingPopMessage(context, m.index, m.kem_key, m.signing_key),
    m.signing_pop,
  );
}

/**
 * The ML-KEM message of seat `j`'s challenge to seat `i`:
 * `H(DS("abolish/v1/ceremony-challenge", ceremony_context ‖ u8(j) ‖ u8(i) ‖ μ))`.
 * Binding the pair means a challenge only re-encapsulates as the one `j` sent
 * `i`: a seat that relays another seat's challenge to the real key owner, to
 * have it decapsulated, can't reveal a `μ` that checks for its own slot
 * (docs/spec/ceremony.md, Round 2; T-37, T-54).
 */
function challengeMessage(context: Uint8Array, j: number, i: number, mu: Uint8Array): Uint8Array {
  const w = new Writer();
  w.bytes(context);
  u8.write(w, j);
  u8.write(w, i);
  w.bytes(mu);
  return H(ds("abolish/v1/ceremony-challenge", w.finish()));
}

/**
 * Seat `i`'s answer to seat `j`'s challenge:
 * `H(DS("abolish/v1/ceremony-answer", ceremony_context ‖ u8(j) ‖ u8(i) ‖ ss))`.
 * A seat publishes only answers bound to itself as target, so whatever round 2
 * a coordinator showed it, no other seat can reuse what it publishes as its
 * own answer (docs/spec/ceremony.md, Round 3; T-37).
 */
function answerHash(context: Uint8Array, j: number, i: number, ss: Uint8Array): Uint8Array {
  const w = new Writer();
  w.bytes(context);
  u8.write(w, j);
  u8.write(w, i);
  w.bytes(ss);
  return H(ds("abolish/v1/ceremony-answer", w.finish()));
}

/** A seat's secrets for one run: its identity key, and the fresh per-election keys it registers. */
export interface SeatSecrets {
  readonly index: number;
  readonly identitySecret: Uint8Array;
  readonly kem: KemKeyPair;
  /** The per-election P-256 signing key, 32 bytes big-endian. */
  readonly signingSecret: Uint8Array;
}

/** Fresh per-election keys for a seat, every secret from the CSPRNG. */
export function ceremonyKeygen(index: number, identitySecret: Uint8Array): SeatSecrets {
  return { index, identitySecret, kem: kemKeygen(), signingSecret: p256.utils.randomSecretKey() };
}

function seatKey(run: Run, seat: SeatSecrets): void {
  const key = Number.isSafeInteger(seat.index) ? run.keys[seat.index - 1] : undefined;
  if (key === undefined || seat.index < 1)
    throw new RangeError("ceremony: index must be a seat of the panel");
  // A key outside its seat would sign messages no verifier attributes to it.
  if (!equalBytes(identityKey(seat.identitySecret), key))
    throw new RangeError("ceremony: identitySecret is not the key of seat index");
}

/**
 * Internal: seat `seat.index`'s round-1 message with the proof nonce `w`.
 * Production code calls `keysMessage`; the package entry point doesn't
 * export this.
 */
export function keysMessageWith(params: CeremonyParams, seat: SeatSecrets, w: bigint): KeysMessage {
  const run = runOf(params);
  seatKey(run, seat);
  if (typeof w !== "bigint" || w <= 0n || w >= GROUP_ORDER)
    throw new RangeError("ceremony: w must be a scalar from 1 to ℓ − 1");
  const kemKey = seat.kem.publicKey;
  const signingKey = identityKey(seat.signingSecret);
  const c = possessionChallenge(run.context, seat.index, kemKey, signingKey, G.multiply(w));
  const z = (w + c * seat.kem.secretKey.x) % GROUP_ORDER;
  const pop = signStatement(
    seat.signingSecret,
    SIGNING_KEY_TAG,
    signingPopMessage(run.context, seat.index, kemKey, signingKey),
  );
  return sign<KeysMessage>(seat.identitySecret, 1, run.context, {
    index: seat.index,
    kem_key: kemKey,
    signing_key: signingKey,
    pok_c: c,
    pok_z: z,
    signing_pop: pop,
  });
}

/** Round 1: the seat's keys, its proof of knowledge of `x` and its signing key's signature. */
export function keysMessage(params: CeremonyParams, seat: SeatSecrets): KeysMessage {
  // w is uniform on 1 to ℓ − 1; randomScalar can return 0 (probability 2⁻²⁵²).
  let w = randomScalar();
  while (w === 0n) w = randomScalar();
  return keysMessageWith(params, seat, w);
}

/** A round-2 message and the challenge secrets `μ` its seat keeps until round 4. */
export interface Challenges {
  readonly message: ChallengesMessage;
  readonly secrets: readonly Uint8Array[];
}

/**
 * Internal: seat `seat.index`'s round-2 message with the given `μ`s, one per
 * other seat of round 1 in order. Production code calls `challengesMessage`;
 * the package entry point doesn't export this.
 */
export function challengesMessageWith(
  params: CeremonyParams,
  seat: SeatSecrets,
  keys: readonly KeysMessage[],
  secrets: readonly Uint8Array[],
): Challenges {
  const run = runOf(params);
  seatKey(run, seat);
  const h = checkedPrefix(run, { keys });
  const targets = keys.filter((m) => m.index !== seat.index);
  if (targets.length === keys.length)
    throw new RangeError("ceremony: the seat has no round-1 message");
  if (secrets.length !== targets.length) throw new RangeError("ceremony: one μ per other seat");
  const mus = secrets.map((mu) => {
    if (!(mu instanceof Uint8Array) || mu.length !== MLKEM_MSG_LEN)
      throw new RangeError("ceremony: μ must be 32 bytes");
    return Uint8Array.from(mu);
  });
  const challenges = targets.map(
    (t, i) =>
      ml_kem768.encapsulate(
        t.kem_key.ek,
        challengeMessage(run.context, seat.index, t.index, mus[i] as Uint8Array),
      ).cipherText,
  );
  const message = sign<ChallengesMessage>(seat.identitySecret, 2, h[1] as Uint8Array, {
    index: seat.index,
    challenges,
  });
  return { message, secrets: mus };
}

/** Round 2: an encapsulated challenge to every other seat, each with a fresh `μ` from the CSPRNG. */
export function challengesMessage(
  params: CeremonyParams,
  seat: SeatSecrets,
  keys: readonly KeysMessage[],
): Challenges {
  const others = keys.filter((m) => m.index !== seat.index).length;
  return challengesMessageWith(
    params,
    seat,
    keys,
    Array.from({ length: others }, () => randomBytes(MLKEM_MSG_LEN)),
  );
}

/** Round 3: the shared secret of every challenge addressed to the seat, by decapsulation. */
export function answersMessage(
  params: CeremonyParams,
  seat: SeatSecrets,
  keys: readonly KeysMessage[],
  challenges: readonly ChallengesMessage[],
): AnswersMessage {
  const run = runOf(params);
  seatKey(run, seat);
  const h = checkedPrefix(run, { keys, challenges });
  const own = keys.find((m) => m.index === seat.index);
  // Only the key it registered: answering for another key would prove nothing.
  if (
    own === undefined ||
    !equalBytes(encode(KEM_PUBLIC_KEY, own.kem_key), encode(KEM_PUBLIC_KEY, seat.kem.publicKey))
  )
    throw new RangeError("ceremony: the seat's round-1 message doesn't carry its KEM key");
  const { secretKey: dk } = ml_kem768.keygen(seat.kem.secretKey.seed);
  const s1 = keys.map((m) => m.index);
  const answers = challenges
    .filter((c) => c.index !== seat.index)
    .map((c) => {
      const position = s1.filter((i) => i !== c.index).indexOf(seat.index);
      const ss = ml_kem768.decapsulate(c.challenges[position] as Uint8Array, dk);
      const answer = answerHash(run.context, c.index, seat.index, ss);
      ss.fill(0);
      return answer;
    });
  dk.fill(0);
  return sign<AnswersMessage>(seat.identitySecret, 3, h[2] as Uint8Array, {
    index: seat.index,
    answers,
  });
}

/** Round 4: the seat's challenge secrets, once every answer is fixed. */
export function revealsMessage(
  params: CeremonyParams,
  seat: SeatSecrets,
  rounds: Pick<CeremonyTranscript, "keys" | "challenges" | "answers">,
  secrets: readonly Uint8Array[],
): RevealsMessage {
  const run = runOf(params);
  seatKey(run, seat);
  const h = checkedPrefix(run, rounds);
  if (!rounds.challenges.some((c) => c.index === seat.index))
    throw new RangeError("ceremony: the seat sent no challenges");
  const targets = rounds.keys.filter((m) => m.index !== seat.index);
  if (secrets.length !== targets.length) throw new RangeError("ceremony: one μ per other seat");
  // The μs must be the ones behind the challenges this transcript holds for
  // the seat: after a restart or a replayed round 2 they may not be, and
  // revealing them would get the seat itself disqualified (bad-challenge).
  const sent = rounds.challenges.find((c) => c.index === seat.index) as ChallengesMessage;
  targets.forEach((t, at) => {
    const mu = secrets[at];
    if (!(mu instanceof Uint8Array) || mu.length !== MLKEM_MSG_LEN)
      throw new RangeError("ceremony: μ must be 32 bytes");
    const m = challengeMessage(run.context, seat.index, t.index, mu);
    if (
      !equalBytes(
        ml_kem768.encapsulate(t.kem_key.ek, m).cipherText,
        sent.challenges[at] as Uint8Array,
      )
    )
      throw new RangeError("ceremony: a μ doesn't match the challenge the transcript holds");
  });
  return sign<RevealsMessage>(seat.identitySecret, 4, h[3] as Uint8Array, {
    index: seat.index,
    reveals: secrets.map((s) => Uint8Array.from(s)),
  });
}

// A node checks the rounds it signs over, as a verifier would, so its
// signature never commits to a malformed or forged earlier round.
function checkedPrefix(run: Run, rounds: Partial<Rounds>): Uint8Array[] {
  const code = structureCode(run, rounds);
  if (code !== null) throw new RangeError(`ceremony: earlier rounds fail (${code})`);
  return chain(run.context, rounds);
}

/** Why a transcript is invalid as a whole (docs/spec/ceremony.md, Transcript check). */
export type CeremonyErrorCode =
  | DecodeErrorCode
  | "ceremony-order"
  | "ceremony-shape"
  | "ceremony-signature"
  | "ceremony-quorum";

/** Why a seat isn't qualified, in the order docs/spec/ceremony.md lists them. */
export type SeatReason =
  | "absent"
  | "possession"
  | "duplicate-key"
  | "no-challenges"
  | "no-answers"
  | "no-reveals"
  | "bad-challenge"
  | "wrong-answer";

export interface SeatResult {
  readonly index: number;
  readonly reasons: readonly SeatReason[];
}

/** A qualified seat's registered keys. */
export interface RegisteredKeys {
  readonly index: number;
  readonly kemKey: KemPublicKey;
  readonly signingKey: Uint8Array;
}

export type CeremonyCheck =
  | {
      readonly ok: true;
      readonly hash: Uint8Array;
      readonly seats: readonly SeatResult[];
      readonly registered: readonly RegisteredKeys[];
    }
  | {
      readonly ok: false;
      readonly code: CeremonyErrorCode;
      readonly seats?: readonly SeatResult[];
    };

function increasing(indices: readonly number[], n: number): boolean {
  return indices.every(
    (i, at) => i >= 1 && i <= n && (at === 0 || i > (indices[at - 1] as number)),
  );
}

// Checks 1 to 3 over the rounds present: order, shape, then signatures.
function structureCode(run: Run, t: Partial<Rounds>): CeremonyErrorCode | null {
  const n = run.keys.length;
  const s1 = (t.keys ?? []).map((m) => m.index);
  const s2 = (t.challenges ?? []).map((m) => m.index);
  const inS1 = (i: number) => s1.includes(i);
  if (!increasing(s1, n)) return "ceremony-order";
  for (const [round, senders, allowed] of [
    [t.challenges, s2, inS1],
    [t.answers, (t.answers ?? []).map((m) => m.index), inS1],
    [t.reveals, (t.reveals ?? []).map((m) => m.index), (i: number) => s2.includes(i)],
  ] as const)
    if (round !== undefined && (!increasing(senders, n) || !senders.every(allowed)))
      return "ceremony-order";
  const others = (set: readonly number[], i: number) => set.filter((j) => j !== i).length;
  if (t.challenges?.some((m) => m.challenges.length !== others(s1, m.index)))
    return "ceremony-shape";
  if (t.answers?.some((m) => m.answers.length !== others(s2, m.index))) return "ceremony-shape";
  if (t.reveals?.some((m) => m.reveals.length !== others(s1, m.index))) return "ceremony-shape";
  const h = chain(run.context, t);
  const rounds = [t.keys, t.challenges, t.answers, t.reveals];
  for (const [r, msgs] of rounds.entries())
    for (const m of msgs ?? [])
      if (!messageOk(run, r + 1, h[r] as Uint8Array, m)) return "ceremony-signature";
  return null;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// Check 4: each seat's reasons, from the transcript alone.
function seatResults(run: Run, t: Rounds): SeatResult[] {
  const n = run.keys.length;
  const reasons = new Map<number, SeatReason[]>();
  for (let i = 1; i <= n; i++) reasons.set(i, []);
  const add = (i: number, r: SeatReason) => {
    const list = reasons.get(i) as SeatReason[];
    if (!list.includes(r)) list.push(r);
  };
  const byIndex = <M extends { index: number }>(ms: readonly M[]) =>
    new Map(ms.map((m) => [m.index, m]));
  const keys = byIndex(t.keys);
  const challenges = byIndex(t.challenges);
  const answers = byIndex(t.answers);
  const reveals = byIndex(t.reveals);
  const s1 = t.keys.map((m) => m.index);
  const s2 = t.challenges.map((m) => m.index);

  const passing = t.keys.filter((m) => possessionOk(run.context, m));
  const identities = new Set(run.keys.map(hex));
  const count = (values: string[]) => {
    const c = new Map<string, number>();
    for (const v of values) c.set(v, (c.get(v) ?? 0) + 1);
    return c;
  };
  const dhCount = count(passing.map((m) => hex(encode(KEM_PUBLIC_KEY, m.kem_key).subarray(-32))));
  const sigCount = count(passing.map((m) => hex(m.signing_key)));

  // Re-encapsulation of every revealed challenge: valid, and the answer it expects.
  const valid = new Map<string, Uint8Array | null>();
  for (const [j, rev] of reveals) {
    const c = challenges.get(j) as ChallengesMessage;
    s1.filter((i) => i !== j).forEach((i, at) => {
      const ek = (keys.get(i) as KeysMessage).kem_key.ek;
      const m = challengeMessage(run.context, j, i, rev.reveals[at] as Uint8Array);
      const { cipherText, sharedSecret } = ml_kem768.encapsulate(ek, m);
      valid.set(
        `${j}>${i}`,
        equalBytes(cipherText, c.challenges[at] as Uint8Array)
          ? answerHash(run.context, j, i, sharedSecret)
          : null,
      );
    });
  }

  for (let i = 1; i <= n; i++) {
    const k = keys.get(i);
    if (k === undefined) {
      add(i, "absent");
      continue;
    }
    if (!passing.includes(k)) add(i, "possession");
    else {
      const dh = hex(encode(KEM_PUBLIC_KEY, k.kem_key).subarray(-32));
      const sk = hex(k.signing_key);
      if ((dhCount.get(dh) ?? 0) > 1 || (sigCount.get(sk) ?? 0) > 1 || identities.has(sk))
        add(i, "duplicate-key");
    }
    if (!challenges.has(i)) add(i, "no-challenges");
    if (!answers.has(i)) add(i, "no-answers");
    if (challenges.has(i) && !reveals.has(i)) add(i, "no-reveals");
    if (reveals.has(i) && s1.some((x) => x !== i && valid.get(`${i}>${x}`) === null))
      add(i, "bad-challenge");
    const a = answers.get(i);
    if (a !== undefined)
      s2.filter((j) => j !== i).forEach((j, at) => {
        const ss = valid.get(`${j}>${i}`);
        if (ss != null && !equalBytes(ss, a.answers[at] as Uint8Array)) add(i, "wrong-answer");
      });
  }
  return Array.from(reasons, ([index, r]) => ({ index, reasons: r }));
}

/**
 * The transcript check of docs/spec/ceremony.md ([[verifier]] 3.1 and 3.2):
 * the context rebuilt from `params` (never from the transcript), checks 1 to
 * 5 in order, and for a valid transcript the qualified seats' registered keys.
 */
export function checkCeremonyTranscript(
  params: Omit<CeremonyParams, "runId">,
  bytes: Uint8Array,
  pinned: 1,
): CeremonyCheck {
  let t: CeremonyTranscript;
  try {
    t = decodeCeremonyTranscript(bytes, pinned);
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: e.code };
    throw e;
  }
  const run = runOf({ ...params, runId: t.run_id });
  const code = structureCode(run, t);
  if (code !== null) return { ok: false, code };
  const seats = seatResults(run, t);
  const qualified = seats.filter((s) => s.reasons.length === 0).map((s) => s.index);
  if (qualified.length < run.threshold) return { ok: false, code: "ceremony-quorum", seats };
  const registered = qualified.map((index) => {
    const m = t.keys.find((k) => k.index === index) as KeysMessage;
    return { index, kemKey: m.kem_key, signingKey: m.signing_key };
  });
  return { ok: true, hash: ceremonyTranscriptHash(bytes), seats, registered };
}

// Public values, so timing doesn't matter; written without early exit anyway.
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}
