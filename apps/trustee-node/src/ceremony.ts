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
//   rule 7; T-14, T-54), signed over the key set its own check returned;
// - every election it approves recorded with what the capacity check reads,
//   before it signs, and approvals one at a time, so each stub check 4 sees
//   every election approved before it (docs/spec/delivery.md, Capacity;
//   T-25, T-52, T-54).
import {
  answersMessage,
  bytesFixed,
  bytesVar,
  type CeremonyParams,
  type CeremonyRegistration,
  type CeremonyTranscript,
  type ChallengesMessage,
  type ForcedPathElection,
  challengesMessage,
  checkCeremonyTranscript,
  ceremonyKeygen,
  decode,
  decodeCeremonyTranscript,
  DecodeError,
  decodeElectionDefinitionRecord,
  type ElectionDefinition,
  electionDefinitionHash,
  electionStubHash,
  encode,
  EncodeError,
  encodeCeremonyTranscript,
  identityKey,
  KEM_SECRET_KEY,
  type KemSecretKey,
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
  u32,
  u64,
  u8,
} from "@abolishus/crypto";
import type { SeatStore } from "./store.ts";
import {
  checkStub,
  type ElectorateCheck,
  type Pins,
  stubDemand,
  type StubRefusal,
} from "./stub.ts";

/**
 * Whether finalized L2 shows that the election with this definition hash can
 * never be registered: its `opens_at` has passed in finalized L2 time and the
 * election registry holds no registration of it (the registry refuses one at
 * or after `opens_at`, docs/spec/contracts.md, Registration, rule 6). It must
 * resolve `false` whenever it can't decide, so an entry is released only on
 * proof. The read belongs to `packages/verifier`'s chain access (P2-13 part 3),
 * as the electorate check's does; until a deployment supplies it, no entry is
 * ever released.
 */
export type NeverRegistered = (definitionHash: Uint8Array, opensAt: bigint) => Promise<boolean>;

export interface SeatConfig extends Pins {
  /** This node's seat in the pinned panel, 1 to n. */
  readonly index: number;
  /** The seat's identity secret key; its public key is the panel's key at `index`. */
  readonly identitySecret: Uint8Array;
  readonly electorate: ElectorateCheck;
  readonly store: SeatStore;
  /** Releases a served election's capacity once it provably can't be registered; never, if absent. */
  readonly neverRegistered?: NeverRegistered;
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

/** An election this seat approved, as its later duties read it. */
export interface ApprovedElection {
  readonly index: number;
  readonly stubHash: Uint8Array;
  /** The definition the approval registers: the stub with the approved transcript. */
  readonly definitionHash: Uint8Array;
  readonly electionId: Uint8Array;
  readonly opensAt: bigint;
  readonly closesAt: bigint;
  readonly l1InclusionBound: bigint;
  /** `M`, the definition's members over its tiers: what bounds the seat's contract-path obligation at `2M`. */
  readonly members: bigint;
  /** The seat's per-election signing secret, registered by the approved transcript. Never logged. */
  readonly signingSecret: Uint8Array;
}

/**
 * What intake reads of an election this seat approved: the transcript and
 * key set the approval signed for, and the approved run's per-election keys
 * (docs/spec/share-encryption.md, Intake and receipts). Never logged.
 */
export interface IntakeSecrets {
  readonly transcriptHash: Uint8Array;
  /** The key set the seat's own check of the transcript returned, which its approval signed. */
  readonly keySetHash: Uint8Array;
  readonly kemSecret: KemSecretKey;
  readonly signingSecret: Uint8Array;
}

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
// The run whose keys an approved stub registers, written before the approval,
// so the seat's later duties find its per-election keys.
const APPROVED_RUN = struct([["run_id", HASH]] as const);
// What stub check 4 reads of an election the seat serves, and what shows
// it can no longer be registered: its definition hash and `opens_at`.
const SERVED = struct([
  ["members", u64],
  ["seats", u8],
  ["closes_at", u64],
  ["l1_inclusion_bound", u32],
  ["definition_hash", HASH],
  ["opens_at", u64],
] as const);
const HEX64 = /^[0-9a-f]{64}$/;

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
  // Approvals run one at a time, so no two can each pass stub check 4
  // against a ledger the other is about to add to.
  #approving: Promise<unknown> = Promise.resolve();

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
    const checked = await checkStub(stubBytes, config, config.electorate, await this.#served());
    if (!checked.ok) return refuse(checked.code);
    const stubHash = hex(checked.stubHash);
    if ((await this.#durable(`approvals/${stubHash}`)) !== undefined)
      return refuse("stub-approved");
    const prefix = `runs/${stubHash}/${hex(runId)}`;
    const begun = await config.store.putOnce(
      `${prefix}/begun`,
      encode(BEGUN, { election_id: checked.stub.election_id }),
    );
    if (!begun.created) {
      // A retry after a lost response gets the message it already sent; a
      // run without one (it crashed before recording it) stays abandoned.
      const sent = await this.#durable(`${prefix}/round-1`);
      const own =
        sent === undefined
          ? undefined
          : decodeCeremonyTranscript(decode(SENT, sent).rounds, 1).keys[0];
      return own === undefined ? refuse("run-seen") : { ok: true, value: own };
    }
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
    given: readonly KeysMessage[],
  ): Promise<SeatResult<ChallengesMessage>> {
    const run = await this.#run(stubHash, runId);
    if (run === undefined) return refuse("no-run");
    const own = await this.#own(run, 1);
    if (own === undefined) return refuse("no-run");
    const copy = this.#snapshot(runId, { keys: given });
    if (copy === undefined) return refuse("rounds");
    const { keys } = copy;
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
    given: Rounds12,
  ): Promise<SeatResult<AnswersMessage>> {
    const run = await this.#run(stubHash, runId);
    if (run === undefined) return refuse("no-run");
    const sent = await this.#record(run, 2);
    if (sent === undefined) return refuse("no-run");
    const copy = this.#snapshot(runId, given);
    if (copy === undefined) return refuse("rounds");
    const rounds: Rounds12 = { keys: copy.keys, challenges: copy.challenges };
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
    given: Rounds123,
  ): Promise<SeatResult<RevealsMessage>> {
    const run = await this.#run(stubHash, runId);
    if (run === undefined) return refuse("no-run");
    const challenged = await this.#record(run, 2);
    const sent = await this.#record(run, 3);
    if (challenged === undefined || sent === undefined) return refuse("no-run");
    const copy = this.#snapshot(runId, given);
    if (copy === undefined) return refuse("rounds");
    const rounds: Rounds123 = {
      keys: copy.keys,
      challenges: copy.challenges,
      answers: copy.answers,
    };
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
    const turn = this.#approving.then(() => this.#approve(stubBytes, transcript));
    this.#approving = turn.catch(() => undefined);
    return turn;
  }

  async #approve(stubBytes: Uint8Array, transcript: Uint8Array): Promise<SeatResult<Approval>> {
    const config = this.#config;
    // A stub this seat already approved was judged by check 4 then, and its
    // signature may already be registering it: a retry after a lost response
    // gets the recorded approval (or `approved-other`) below, never a new
    // verdict from a ledger that has grown since.
    const served = (await this.#approvedBefore(stubBytes)) ? new Map() : await this.#served();
    const checked = await checkStub(stubBytes, config, config.electorate, served);
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
    const earlier = await this.#durable(approvalKey);
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
    // Recorded before signing, so every later stub check 4 counts it, even
    // after a crash between this record and the approval.
    const demand = stubDemand(checked.stub);
    const definitionHash = electionDefinitionHash({
      ...checked.stub,
      ceremony_transcript_hash: result.hash,
    });
    const recorded = await config.store.putOnce(
      `served/${hex(checked.stubHash)}`,
      encode(SERVED, {
        members: demand.members,
        seats: demand.seats,
        closes_at: demand.closesAt,
        l1_inclusion_bound: Number(demand.l1InclusionBound),
        // The definition this approval registers: the stub with this transcript.
        definition_hash: definitionHash,
        opens_at: checked.stub.opens_at,
      }),
    );
    // A record a crash left for another transcript of this stub names another
    // definition, which `neverRegistered` would then judge in this one's
    // place: this seat keeps to the transcript it recorded first.
    if (!equal(decode(SERVED, recorded.value).definition_hash, definitionHash))
      return refuse("approved-other");
    const approvedRun = await config.store.putOnce(
      `approved-runs/${hex(checked.stubHash)}`,
      encode(APPROVED_RUN, { run_id: t.run_id }),
    );
    if (!equal(decode(APPROVED_RUN, approvedRun.value).run_id, t.run_id))
      return refuse("approved-other");
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

  /** The stub hash of every stub the seat approved, in the store's order. */
  async approvedStubs(): Promise<Uint8Array[]> {
    return (await this.#config.store.list("approvals")).map((name) => {
      if (!HEX64.test(name)) throw new Error(`trustee node: an approval record named ${name}`);
      return Uint8Array.from(Buffer.from(name, "hex"));
    });
  }

  /**
   * The election an approved stub registers, with the seat's per-election
   * signing secret from the approved run, for the duties after the ceremony
   * (docs/spec/availability.md, What a seat does); undefined unless this seat
   * approved the stub.
   */
  async approvedElection(stubHash: Uint8Array): Promise<ApprovedElection | undefined> {
    if (!(stubHash instanceof Uint8Array) || stubHash.length !== 32) return undefined;
    const name = hex(stubHash);
    if ((await this.#durable(`approvals/${name}`)) === undefined) return undefined;
    const runRecord = await this.#durable(`approved-runs/${name}`);
    const served = await this.#durable(`served/${name}`);
    if (runRecord === undefined || served === undefined)
      throw new Error(`trustee node: approval of ${name} without its run or served record`);
    const run = await this.#run(stubHash, decode(APPROVED_RUN, runRecord).run_id);
    if (run === undefined) throw new Error(`trustee node: the approved run of ${name} is gone`);
    const r = decode(SERVED, served);
    return {
      index: this.#config.index,
      stubHash: Uint8Array.from(stubHash),
      definitionHash: r.definition_hash,
      electionId: Uint8Array.from(run.params.electionId),
      opensAt: r.opens_at,
      closesAt: r.closes_at,
      l1InclusionBound: BigInt(r.l1_inclusion_bound),
      members: r.members,
      signingSecret: Uint8Array.from(run.seat.signingSecret),
    };
  }

  /**
   * The approval's transcript and key set, with the approved run's KEM and
   * signing secrets, for intake; undefined unless this seat approved the stub.
   */
  async intakeSecrets(stubHash: Uint8Array): Promise<IntakeSecrets | undefined> {
    if (!(stubHash instanceof Uint8Array) || stubHash.length !== 32) return undefined;
    const name = hex(stubHash);
    const approval = await this.#durable(`approvals/${name}`);
    if (approval === undefined) return undefined;
    const runRecord = await this.#durable(`approved-runs/${name}`);
    if (runRecord === undefined)
      throw new Error(`trustee node: approval of ${name} without its run`);
    const run = await this.#run(stubHash, decode(APPROVED_RUN, runRecord).run_id);
    if (run === undefined) throw new Error(`trustee node: the approved run of ${name} is gone`);
    const a = decode(APPROVED, approval);
    return {
      transcriptHash: a.transcript_hash,
      keySetHash: a.key_set_hash,
      kemSecret: {
        seed: Uint8Array.from(run.seat.kem.secretKey.seed),
        x: run.seat.kem.secretKey.x,
      },
      signingSecret: Uint8Array.from(run.seat.signingSecret),
    };
  }

  /** Whether the seat holds an approval for the stub these bytes decode to. */
  async #approvedBefore(stubBytes: Uint8Array): Promise<boolean> {
    let stub: ElectionDefinition;
    try {
      const record = decodeElectionDefinitionRecord(stubBytes);
      if (record.version !== 1) return false;
      stub = record.value;
    } catch (e) {
      // checkStub refuses it with its own code.
      if (e instanceof DecodeError) return false;
      throw e;
    }
    return (await this.#durable(`approvals/${hex(electionStubHash(stub))}`)) !== undefined;
  }

  /**
   * Every election the seat has approved, by stub hash (hex), as stub check 4
   * reads it, less those finalized L2 shows can never be registered: an
   * approved stub nobody registers otherwise holds the seat's capacity for
   * good, so whoever gets stubs run could take every slot (T-25).
   */
  async #served(): Promise<Map<string, ForcedPathElection>> {
    const served = new Map<string, ForcedPathElection>();
    const neverRegistered = this.#config.neverRegistered ?? (() => Promise.resolve(false));
    for (const name of await this.#config.store.list("served")) {
      if (!HEX64.test(name)) throw new Error(`trustee node: a served record named ${name}`);
      const bytes = await this.#durable(`served/${name}`);
      if (bytes === undefined) throw new Error(`trustee node: served/${name} vanished`);
      const r = decode(SERVED, bytes);
      if (await neverRegistered(r.definition_hash, r.opens_at)) continue;
      served.set(name, {
        members: r.members,
        seats: r.seats,
        closesAt: r.closes_at,
        l1InclusionBound: BigInt(r.l1_inclusion_bound),
      });
    }
    return served;
  }

  /**
   * A record, made durable before the node acts on it: another request may
   * have linked it and not yet synced it, or crashed in between (the
   * store's `putOnce` syncs a record it already holds).
   */
  async #durable(key: string): Promise<Uint8Array | undefined> {
    const store = this.#config.store;
    const value = await store.get(key);
    return value === undefined ? undefined : (await store.putOnce(key, value)).value;
  }

  #params(electionId: Uint8Array, stubHash: Uint8Array, runId: Uint8Array): CeremonyParams {
    const { l2ChainId, trusteeRegistry, panel } = this.#config;
    return { l2ChainId, trusteeRegistry, electionId, stubHash, panel, runId };
  }

  async #run(stubHash: Uint8Array, runId: Uint8Array): Promise<Run | undefined> {
    if (!(stubHash instanceof Uint8Array) || stubHash.length !== 32) return undefined;
    if (!(runId instanceof Uint8Array) || runId.length !== 32) return undefined;
    const prefix = `runs/${hex(stubHash)}/${hex(runId)}`;
    const begun = await this.#durable(`${prefix}/begun`);
    const secrets = await this.#durable(`${prefix}/secrets`);
    const round1 = await this.#durable(`${prefix}/round-1`);
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
    const bytes = await this.#durable(`${run.prefix}/round-${round}`);
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

  /**
   * The caller's rounds as fresh decoded copies of their encoding, so what
   * the checks read is what the node signs over and records, whatever
   * objects a transport handed in; `undefined` for rounds with no encoding.
   */
  #snapshot(runId: Uint8Array, given: Partial<Rounds123>): CeremonyTranscript | undefined {
    if (given === null || typeof given !== "object") return undefined;
    const { keys, challenges, answers } = given;
    let bytes: Uint8Array;
    try {
      bytes = this.#sent(
        runId,
        {
          ...(keys !== undefined && { keys }),
          ...(challenges !== undefined && { challenges }),
          ...(answers !== undefined && { answers }),
        },
        [],
      );
    } catch (e) {
      if (e instanceof EncodeError || e instanceof TypeError) return undefined;
      throw e;
    }
    return decodeCeremonyTranscript(decode(SENT, bytes).rounds, 1);
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
