// A trustee seat's part in the key ceremony (docs/spec/ceremony.md): the
// messages come from `@abolishus/crypto`; what this file adds is the node's
// duties, each kept by a write-once record made before the node acts:
//
// - a run whose (`stub_hash`, `run_id`) the node has seen is refused, and
//   every run gets fresh keys, nonces and challenge secrets (Ceremony
//   context; T-37);
// - one message per round per run: asked again over the same earlier rounds
//   it resends the one it recorded, and over any other it refuses, so it
//   never signs two messages in a round (Security notes, Withholding);
// - at most one round-4 message per run, recorded before it is returned,
//   and only over earlier rounds that hold its own messages as sent
//   (Soundness);
// - at most one approved transcript per `stub_hash`, only one that holds
//   every message it sent and the rounds it signed over, with at least
//   `max(k, n − 1)` qualified seats (Approval and re-runs; [[0006-trustees]]
//   rule 7; T-14, T-54), signed over the key set its own check returned.
import {
  answersMessage,
  bytesFixed,
  bytesVar,
  type CeremonyParams,
  type CeremonyRegistration,
  type CeremonyTranscript,
  type ChallengesMessage,
  challengesMessage,
  checkCeremonyTranscript,
  ceremonyKeygen,
  decode,
  decodeCeremonyTranscript,
  DecodeError,
  encode,
  EncodeError,
  encodeCeremonyTranscript,
  identityKey,
  KEM_SECRET_KEY,
  type KeysMessage,
  keysMessage,
  keySetEntry,
  keySetHash,
  list,
  MAX_TRUSTEES,
  p256Sig,
  type RevealsMessage,
  revealsMessage,
  type SeatSecrets,
  signCeremonyRegistration,
  struct,
  type AnswersMessage,
} from "@abolishus/crypto";
import type { SeatStore } from "./store.ts";
import { checkStub, type ElectorateCheck, type Pins, type StubRefusal } from "./stub.ts";

export interface SeatConfig extends Pins {
  /** This node's seat in the pinned panel, 1 to n. */
  readonly index: number;
  /** The seat's identity secret key; its public key is the panel's key at `index`. */
  readonly identitySecret: Uint8Array;
  readonly electorate: ElectorateCheck;
  readonly store: SeatStore;
}

/** Why a seat refuses a request; a refusal sends and records nothing new. */
export type SeatRefusal =
  | StubRefusal
  /** The stub already has a transcript this node approved, which is final for it. */
  | "stub-approved"
  /** The node has seen this (`stub_hash`, `run_id`) before. */
  | "run-seen"
  /** The node has no record of the run, or hasn't sent the round before. */
  | "no-run"
  /** The earlier rounds don't hold this node's own messages as it sent them, or differ from the rounds it signed over. */
  | "view"
  /** The earlier rounds are malformed or badly signed (crypto's checks). */
  | "rounds"
  /** The transcript fails its check. */
  | "transcript"
  /** Fewer than `max(k, n − 1)` seats qualified, or this seat isn't one. */
  | "participation"
  /** The node approved another transcript for this stub. */
  | "approved-other";

export type SeatResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: SeatRefusal };

export interface Approval {
  readonly registration: CeremonyRegistration;
  /** The seat's identity-key signature on `registration`. */
  readonly signature: Uint8Array;
}

export interface Rounds12 {
  readonly keys: readonly KeysMessage[];
  readonly challenges: readonly ChallengesMessage[];
}

export interface Rounds123 extends Rounds12 {
  readonly answers: readonly AnswersMessage[];
}

const HASH = bytesFixed(32);
// The node's own storage, not protocol bytes: the rounds a message was
// signed over and the message itself, as a partial transcript record.
const BEGUN = struct([["election_id", HASH]] as const);
const SECRETS = struct([
  ["kem", KEM_SECRET_KEY],
  ["signing", HASH],
] as const);
const SENT = struct([
  ["rounds", bytesVar(1 << 20)],
  ["mus", list(HASH, MAX_TRUSTEES - 1)],
] as const);
const APPROVED = struct([
  ["transcript_hash", HASH],
  ["key_set_hash", HASH],
  ["signature", p256Sig],
] as const);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const refuse = <T>(code: SeatRefusal): SeatResult<T> => ({ ok: false, code });

interface Run {
  readonly params: CeremonyParams;
  readonly seat: SeatSecrets;
  readonly prefix: string;
}

type Round = 1 | 2 | 3 | 4;
const FIELD = { 1: "keys", 2: "challenges", 3: "answers", 4: "reveals" } as const;

export class CeremonySeat {
  readonly #config: SeatConfig;

  constructor(config: SeatConfig) {
    const key = config.panel.keys[config.index - 1];
    // A secret outside its seat would sign messages no verifier attributes to it.
    if (key === undefined || !equal(identityKey(config.identitySecret), key))
      throw new RangeError("trustee node: identitySecret is not the key of seat index");
    this.#config = config;
  }

  /**
   * Round 1 of a new run: the stub checks, then fresh keys. The run is
   * recorded as seen before any key exists, so it is never joined twice,
   * even across a crash.
   */
  async keys(stubBytes: Uint8Array, runId: Uint8Array): Promise<SeatResult<KeysMessage>> {
    const config = this.#config;
    if (!(runId instanceof Uint8Array) || runId.length !== 32)
      throw new RangeError("trustee node: runId must be 32 bytes");
    const checked = await checkStub(stubBytes, config, config.electorate);
    if (!checked.ok) return refuse(checked.code);
    const stubHash = hex(checked.stubHash);
    if ((await config.store.get(`approvals/${stubHash}`)) !== undefined)
      return refuse("stub-approved");
    const prefix = `runs/${stubHash}/${hex(runId)}`;
    const begun = await config.store.putOnce(
      `${prefix}/begun`,
      encode(BEGUN, { election_id: checked.stub.election_id }),
    );
    if (!begun.created) return refuse("run-seen");
    const seat = ceremonyKeygen(config.index, config.identitySecret);
    const params = this.#params(checked.stub.election_id, checked.stubHash, runId);
    const message = keysMessage(params, seat);
    await config.store.putOnce(
      `${prefix}/secrets`,
      encode(SECRETS, { kem: seat.kem.secretKey, signing: seat.signingSecret }),
    );
    await config.store.putOnce(`${prefix}/round-1`, this.#sent(runId, { keys: [message] }, []));
    return { ok: true, value: message };
  }

  /** Round 2: over a round 1 that holds this seat's keys as it sent them. */
  async challenges(
    stubHash: Uint8Array,
    runId: Uint8Array,
    keys: readonly KeysMessage[],
  ): Promise<SeatResult<ChallengesMessage>> {
    const run = await this.#run(stubHash, runId);
    if (run === undefined) return refuse("no-run");
    const own = await this.#own(run, 1);
    if (own === undefined) return refuse("no-run");
    if (!this.#holds(runId, 1, keys, own)) return refuse("view");
    return this.#round(run, 2, { keys }, () => {
      const c = challengesMessage(run.params, run.seat, keys);
      return { message: c.message, mus: c.secrets };
    });
  }

  /** Round 3: over the round 1 its round 2 signed over and a round 2 holding its challenges as sent. */
  async answers(
    stubHash: Uint8Array,
    runId: Uint8Array,
    rounds: Rounds12,
  ): Promise<SeatResult<AnswersMessage>> {
    const run = await this.#run(stubHash, runId);
    if (run === undefined) return refuse("no-run");
    const sent = await this.#record(run, 2);
    if (sent === undefined) return refuse("no-run");
    const own = (sent.transcript.challenges as readonly ChallengesMessage[])[0];
    if (
      own === undefined ||
      !this.#same(runId, 1, rounds.keys, sent.transcript.keys) ||
      !this.#holds(runId, 2, rounds.challenges, own)
    )
      return refuse("view");
    return this.#round(run, 3, rounds, () => ({
      message: answersMessage(run.params, run.seat, rounds.keys, rounds.challenges),
      mus: [],
    }));
  }

  /**
   * Round 4: the challenge secrets, over rounds 1 and 2 as its round 3
   * signed over them and a round 3 holding its answers as sent. Recorded
   * before it is returned, and never given over another round 3.
   */
  async reveals(
    stubHash: Uint8Array,
    runId: Uint8Array,
    rounds: Rounds123,
  ): Promise<SeatResult<RevealsMessage>> {
    const run = await this.#run(stubHash, runId);
    if (run === undefined) return refuse("no-run");
    const challenged = await this.#record(run, 2);
    const sent = await this.#record(run, 3);
    if (challenged === undefined || sent === undefined) return refuse("no-run");
    const own = (sent.transcript.answers as readonly AnswersMessage[])[0];
    if (
      own === undefined ||
      !this.#same(runId, 1, rounds.keys, sent.transcript.keys) ||
      !this.#same(runId, 2, rounds.challenges, sent.transcript.challenges) ||
      !this.#holds(runId, 3, rounds.answers, own)
    )
      return refuse("view");
    return this.#round(run, 4, rounds, () => ({
      message: revealsMessage(run.params, run.seat, rounds, challenged.mus),
      mus: [],
    }));
  }

  /**
   * The ceremony registration signature for `transcript`: the stub checks
   * again, then the transcript check, and only for the one transcript per
   * stub this node approves.
   */
  async approve(stubBytes: Uint8Array, transcript: Uint8Array): Promise<SeatResult<Approval>> {
    const config = this.#config;
    const checked = await checkStub(stubBytes, config, config.electorate);
    if (!checked.ok) return refuse(checked.code);
    let t: CeremonyTranscript;
    try {
      t = decodeCeremonyTranscript(transcript, 1);
    } catch (e) {
      if (e instanceof DecodeError) return refuse("transcript");
      throw e;
    }
    const run = await this.#run(checked.stubHash, t.run_id);
    const sent = run === undefined ? undefined : await this.#record(run, 4);
    if (run === undefined || sent === undefined) return refuse("no-run");
    const own = (sent.transcript.reveals as readonly RevealsMessage[])[0];
    // The rounds it signed over, every message it sent as sent (the earlier
    // ones are in those rounds), and no other message of its seat.
    if (
      own === undefined ||
      !this.#same(t.run_id, 1, t.keys, sent.transcript.keys) ||
      !this.#same(t.run_id, 2, t.challenges, sent.transcript.challenges) ||
      !this.#same(t.run_id, 3, t.answers, sent.transcript.answers) ||
      !this.#holds(t.run_id, 4, t.reveals, own)
    )
      return refuse("view");
    const result = checkCeremonyTranscript(run.params, transcript, 1);
    if (!result.ok) return refuse("transcript");
    const n = config.panel.keys.length;
    const quorum = Math.max(config.panel.threshold, n - 1);
    if (
      result.registered.length < quorum ||
      !result.registered.some((k) => k.index === config.index)
    )
      return refuse("participation");
    const approvalKey = `approvals/${hex(checked.stubHash)}`;
    const earlier = await config.store.get(approvalKey);
    if (earlier !== undefined && !equal(decode(APPROVED, earlier).transcript_hash, result.hash))
      return refuse("approved-other");
    const registration: CeremonyRegistration = {
      l2ChainId: config.l2ChainId,
      trusteeRegistry: config.trusteeRegistry,
      index: config.index,
      stubHash: checked.stubHash,
      ceremonyTranscriptHash: result.hash,
      // From this node's own check, never from the coordinator (T-37, T-14).
      keySetHash: keySetHash(result.registered.map(keySetEntry)),
    };
    const signature = signCeremonyRegistration(config.identitySecret, config.panel, registration);
    const stored = await config.store.putOnce(
      approvalKey,
      encode(APPROVED, {
        transcript_hash: registration.ceremonyTranscriptHash,
        key_set_hash: registration.keySetHash,
        signature,
      }),
    );
    const approved = decode(APPROVED, stored.value);
    if (!equal(approved.transcript_hash, result.hash)) return refuse("approved-other");
    // A repeat request gets the signature first recorded (ECDSA signatures
    // differ per signing; either verifies).
    return { ok: true, value: { registration, signature: approved.signature } };
  }

  #params(electionId: Uint8Array, stubHash: Uint8Array, runId: Uint8Array): CeremonyParams {
    const { l2ChainId, trusteeRegistry, panel } = this.#config;
    return { l2ChainId, trusteeRegistry, electionId, stubHash, panel, runId };
  }

  async #run(stubHash: Uint8Array, runId: Uint8Array): Promise<Run | undefined> {
    const store = this.#config.store;
    if (!(stubHash instanceof Uint8Array) || stubHash.length !== 32) return undefined;
    if (!(runId instanceof Uint8Array) || runId.length !== 32) return undefined;
    const prefix = `runs/${hex(stubHash)}/${hex(runId)}`;
    const begun = await store.get(`${prefix}/begun`);
    const secrets = await store.get(`${prefix}/secrets`);
    const round1 = await store.get(`${prefix}/round-1`);
    // A crash between the run's records leaves it unusable: it is abandoned,
    // and the creator starts another with a fresh run_id.
    if (begun === undefined || secrets === undefined || round1 === undefined) return undefined;
    const { election_id } = decode(BEGUN, begun);
    const s = decode(SECRETS, secrets);
    const own = decodeCeremonyTranscript(decode(SENT, round1).rounds, 1).keys[0];
    if (own === undefined) throw new Error("trustee node: a round-1 record without its message");
    const seat: SeatSecrets = {
      index: this.#config.index,
      identitySecret: this.#config.identitySecret,
      // The public key is the one the seat's round-1 message registered.
      kem: { publicKey: own.kem_key, secretKey: s.kem },
      signingSecret: s.signing,
    };
    return { params: this.#params(election_id, stubHash, runId), seat, prefix };
  }

  async #record(
    run: Run,
    round: Round,
  ): Promise<{ transcript: CeremonyTranscript; mus: readonly Uint8Array[] } | undefined> {
    const bytes = await this.#config.store.get(`${run.prefix}/round-${round}`);
    if (bytes === undefined) return undefined;
    const sent = decode(SENT, bytes);
    return { transcript: decodeCeremonyTranscript(sent.rounds, 1), mus: sent.mus };
  }

  async #own(run: Run, round: Round): Promise<{ index: number } | undefined> {
    const record = await this.#record(run, round);
    return record === undefined ? undefined : record.transcript[FIELD[round]][0];
  }

  /**
   * The round's message: the one recorded if the node already sent this
   * round over the same earlier rounds, a refusal if it sent it over others,
   * or a new one, recorded before it is returned.
   */
  async #round<M extends { index: number }>(
    run: Run,
    round: 2 | 3 | 4,
    earlier: Partial<Rounds123>,
    make: () => { message: M; mus: readonly Uint8Array[] },
  ): Promise<SeatResult<M>> {
    const runId = run.params.runId;
    const sentOver = (r: CeremonyTranscript) =>
      [1, 2, 3]
        .filter((at) => at < round)
        .every((at) =>
          this.#same(
            runId,
            at as Round,
            earlier[FIELD[at as 1 | 2 | 3]] ?? [],
            r[FIELD[at as 1 | 2 | 3]],
          ),
        );
    const before = await this.#record(run, round);
    if (before !== undefined) {
      if (!sentOver(before.transcript)) return refuse("view");
      return { ok: true, value: before.transcript[FIELD[round]][0] as unknown as M };
    }
    let made: { message: M; mus: readonly Uint8Array[] };
    try {
      made = make();
    } catch (e) {
      if (e instanceof RangeError) return refuse("rounds");
      throw e;
    }
    const stored = await this.#config.store.putOnce(
      `${run.prefix}/round-${round}`,
      this.#sent(runId, { ...earlier, [FIELD[round]]: [made.message] }, made.mus),
    );
    // Another request for this round got there first: the same rule as above.
    const kept = decodeCeremonyTranscript(decode(SENT, stored.value).rounds, 1);
    if (!sentOver(kept)) return refuse("view");
    return { ok: true, value: kept[FIELD[round]][0] as unknown as M };
  }

  #sent(
    runId: Uint8Array,
    rounds: Partial<Omit<CeremonyTranscript, "run_id">>,
    mus: readonly Uint8Array[],
  ): Uint8Array {
    return encode(SENT, {
      rounds: encodeCeremonyTranscript({
        run_id: runId,
        keys: rounds.keys ?? [],
        challenges: rounds.challenges ?? [],
        answers: rounds.answers ?? [],
        reveals: rounds.reveals ?? [],
      }),
      mus,
    });
  }

  /** Whether two lists of round-`r` messages encode to the same bytes. */
  #same(
    runId: Uint8Array,
    round: Round,
    a: readonly { index: number }[],
    b: readonly { index: number }[],
  ): boolean {
    const bytes = (msgs: readonly { index: number }[]) => {
      try {
        return this.#sent(runId, { [FIELD[round]]: msgs }, []);
      } catch (e) {
        // A message with no encoding is one this seat never sent.
        if (e instanceof EncodeError) return undefined;
        throw e;
      }
    };
    const x = bytes(a);
    const y = bytes(b);
    return x !== undefined && y !== undefined && equal(x, y);
  }

  /** Whether a round's messages hold `own`, this seat's, exactly as it sent it. */
  #holds(
    runId: Uint8Array,
    round: Round,
    msgs: readonly { index: number }[],
    own: { index: number },
  ): boolean {
    if (!Array.isArray(msgs)) return false;
    const theirs = msgs.filter((m) => m !== null && typeof m === "object" && m.index === own.index);
    return theirs.length === 1 && this.#same(runId, round, theirs, [own]);
  }
}
