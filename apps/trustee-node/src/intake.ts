// A trustee seat's intake of delivered ballots (docs/spec/share-encryption.md,
// Intake and receipts): before taking any ballot of an election, the seat
// checks the definition it takes the roots from as a verifier does before
// admitting ballots (2.5, 3.2, 1.3, 2.4); then, for each delivery, crypto's
// `intakeBallot` runs the admission checks, the membership proof included,
// and opens the seat's shares; and the node stores the ciphertext and shares
// under the ballot hash before it hands out the receipt, so a receipt never
// names a share the seat doesn't hold (T-41, T-52, T-37, T-14). Intake closes
// at the intake cutoff `c_I`, where the seat decides what it owes through the
// contract path (docs/spec/delivery.md, What a node owes; T-54).
import { createHash } from "node:crypto";
import {
  ballotElection,
  type BallotElection,
  bytesFixed,
  bytesVar,
  ceremonyTranscriptHash,
  checkCeremonyTranscript,
  decode,
  DecodeError,
  encode,
  encodeShareReceipt,
  fieldBn254,
  identityKey,
  type IntakeCode,
  intakeBallot,
  intakeCutoff,
  keySetEntry,
  keySetHash,
  membershipMessage,
  questionBallotElection,
  type QuestionBallotElection,
  SHARES,
  type Share,
  shareCiphertextHash,
  shareReceiptRecord,
  struct,
  u64,
  u8,
  type ViewBallot,
} from "@abolishus/crypto";
import type { CeremonySeat, IntakeSecrets } from "./ceremony.ts";
import type { SeatStore } from "./store.ts";
import {
  checkStub,
  decodeStub,
  type ElectorateCheck,
  type Pins,
  RELEASE_WINDOWS,
  type Stub,
  stubHash as hashOfStub,
} from "./stub.ts";
import { MAX_RECORD } from "./wire.ts";

/**
 * Whether finalized L2 shows `definition` (the approved stub with its
 * transcript's hash) registered in the election registry it names, over the
 * ceremony the trustee registry recorded with this key set ([[verifier]] 2.1,
 * 3.1's registration part and 3.2 from L2 state, Registration). It must
 * resolve `false` whenever it can't decide, since a seat takes no ballot of
 * an election it hasn't checked. The deployment's reads the seat's own L2
 * node through `packages/verifier`'s `registrationCheck` (src/registration.ts),
 * as the electorate check does `electorateCheck`.
 */
export type RegistrationCheck = (definition: Stub, keySetHash: Uint8Array) => Promise<boolean>;

export interface IntakeConfig extends Pins {
  /** This node's seat in the pinned panel, 1 to n: the seat `ceremony` holds. */
  readonly index: number;
  /** The seat whose approvals and per-election keys intake reads. */
  readonly ceremony: CeremonySeat;
  readonly electorate: ElectorateCheck;
  readonly registration: RegistrationCheck;
  readonly store: SeatStore;
  /** The node's clock, in Unix seconds; intake closes at `c_I` by it. */
  readonly now: () => bigint;
}

/** Why a seat refuses an election's intake, before reading the ballot. */
export type ElectionRefusal =
  /** The stub doesn't decode, or the seat approved no transcript for it. */
  | "intake-unapproved"
  /** The transcript isn't the one the seat approved, or its check no longer returns the approved key set. */
  | "intake-transcript"
  /** The stub fails a stub check now (the pins, the profile, the membership key or the electorate, 2.4). */
  | "intake-definition"
  /** Finalized L2 doesn't show the definition registered under the approved key set. */
  | "intake-unregistered"
  /** The intake cutoff `c_I` has passed. */
  | "intake-closed";

export type IntakeRefusal = ElectionRefusal | IntakeCode;

export type IntakeOutcome =
  | {
      readonly ok: true;
      readonly ballotHash: Uint8Array;
      /** The share receipt record (`0x000c`) for the ballot, under this seat. */
      readonly receipt: Uint8Array;
    }
  | { readonly ok: false; readonly code: IntakeRefusal; readonly option?: number };

const HASH = bytesFixed(32);
// The node's own storage, not protocol bytes: what the seat holds of a
// ballot it receipted, until the tally. The tier and nullifier are what its
// contract-path obligation is decided over (docs/spec/delivery.md, What a
// node owes). A receipt covers the public part under any L1 reference, so the
// references each copy was delivered under are kept apart, one record each
// (`COPY`): the decision ranks the receipted copies by them, and the operator
// may withhold every other copy of the ballot (T-25, T-54).
const TAKEN = struct([
  ["share_hash", HASH],
  ["ciphertext", bytesVar(MAX_RECORD)],
  ["shares", SHARES],
  ["tier", u8],
  ["nullifier", fieldBn254],
] as const);
const COPY = struct([
  ["l1_ref_number", u64],
  ["l1_ref_hash", HASH],
] as const);
// A receipted delivery's record, by its bytes' digest (`recordName`): the
// ballot hash its receipt is held under and the share hash it was given for,
// so a byte-identical repeat is answered from the stored receipt (`#repeat`).
// Both are public, so destruction leaves it in place.
const REPEAT = struct([
  ["ballot_hash", HASH],
  ["share_hash", HASH],
] as const);

interface Opened {
  readonly election: BallotElection | QuestionBallotElection;
  readonly stubHash: Uint8Array;
  readonly cutoff: bigint;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
// A store name for a delivered record's bytes, not protocol bytes: nothing
// outside the node computes or reads it.
const recordName = (record: Uint8Array) => createHash("sha256").update(record).digest("hex");

export class IntakeSeat {
  readonly #config: IntakeConfig;
  // Elections that passed every check, by stub hash and transcript hash. Each
  // check judges only finalized records, so a pass stays one (but for a pass
  // under a root later shown false, T-71); a refusal isn't kept,
  // since a check that couldn't decide yet may pass later. No secret is kept
  // here: each delivery reads them (`withSecrets`), so none outlives destruction.
  readonly #opened = new Map<string, Opened>();
  // Stubs that passed the stub checks again at intake, by stub hash. The
  // electorate's recount reads finalized history, so its pass stays one, and
  // an election waiting on its registration (which comes after its
  // ceremony) doesn't recount the whole registry log on every delivery
  // (T-52). Kept in memory only: a restarted node recounts once.
  readonly #stubPassed = new Set<string>();

  constructor(config: IntakeConfig) {
    if (
      !Number.isSafeInteger(config.index) ||
      config.index < 1 ||
      config.index > config.panel.keys.length
    )
      throw new RangeError("trustee node: the seat must be from 1 to n");
    this.#config = config;
  }

  /**
   * Intake of one delivered ballot: `record`, the whole ballot record, and
   * `ciphertext`, this seat's `ct_i`, for the election `stubBytes` and
   * `transcript` register. The first failure is the result, and nothing is
   * signed or stored on one. Delivered again, the same ballot gets the same
   * receipt (RFC 6979 nonces).
   */
  async intake(
    stubBytes: Uint8Array,
    transcript: Uint8Array,
    record: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<IntakeOutcome> {
    const opened = await this.#open(stubBytes, transcript);
    if (!opened.ok) return opened;
    const { stubHash } = opened.value;
    // The secrets are read for this delivery only, as one use destruction
    // waits for: once it has begun, nothing is opened, stored or signed with
    // them, and no intake record it removed is written again (docs/spec/tally.md,
    // Destruction; T-14, T-40). By then intake has long closed at `c_I`.
    const outcome = await this.#config.ceremony.withSecrets(stubHash, (secrets) =>
      this.#take(opened.value, secrets, record, ciphertext),
    );
    return outcome ?? { ok: false, code: "intake-closed" };
  }

  async #take(
    opened: Opened,
    secrets: IntakeSecrets,
    record: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<IntakeOutcome> {
    const { election, stubHash } = opened;
    const repeat = await this.#repeat(stubHash, record, ciphertext);
    // Its reads may finish past `c_I`, where intake answers nothing.
    if (repeat !== undefined)
      return this.#closed(opened) ? { ok: false, code: "intake-closed" } : repeat;
    const keys = {
      seat: this.#config.index,
      kemSecret: secrets.kemSecret,
      signingSecret: secrets.signingSecret,
    };
    const taken = intakeBallot(election, keys, record, ciphertext);
    if (!taken.ok)
      return taken.option === undefined
        ? { ok: false, code: taken.code }
        : { ok: false, code: taken.code, option: taken.option };
    // The proofs take a while: a delivery begun before `c_I` that finishes
    // after it stores and signs nothing (What a node owes).
    if (this.#closed(opened)) return { ok: false, code: "intake-closed" };
    // Held before the receipt leaves the node, so a crash after this never
    // leaves a receipt for a share the seat lost (Intake and receipts).
    const ballot = hex(taken.ballotHash);
    const stored = await this.#config.store.putOnce(
      `intake/${hex(stubHash)}/${ballot}`,
      encode(TAKEN, {
        share_hash: taken.shareHash,
        ciphertext,
        shares: taken.shares,
        tier: taken.tier,
        nullifier: taken.nullifier,
      }),
    );
    // `ballot_hash` binds every share hash, so a held record names this one.
    if (!equal(decode(TAKEN, stored.value).share_hash, taken.shareHash))
      throw new Error("trustee node: a held ballot's share hash differs from its ballot hash's");
    const copy = await this.#config.store.putOnce(
      `copies/${hex(stubHash)}/${ballot}/${taken.l1RefNumber}-${hex(taken.l1RefHash)}`,
      encode(COPY, { l1_ref_number: taken.l1RefNumber, l1_ref_hash: taken.l1RefHash }),
    );
    // Checked again once the records are durable: a receipt leaves the node
    // only if its records were written before `c_I`, so the decision taken
    // from `c_I` on, which reads them then, covers every receipt the seat
    // gave (`decideObligation`).
    if (this.#closed(opened)) return { ok: false, code: "intake-closed" };
    const receipt = encodeShareReceipt(
      shareReceiptRecord(election.definitionHash, keys.seat, taken),
    );
    // Kept for the copy the seat boards itself through the board path
    // (`ReceiptCopySender`; docs/spec/delivery.md, Client rules), so a
    // receipted seat reaches the board even when the client goes away
    // (T-25). The same ballot signs the same bytes (RFC 6979), so a second
    // delivery finds them held.
    await this.#config.store.putOnce(`receipts/${hex(stubHash)}/${ballot}`, receipt);
    // After the receipt, so a repeat that finds this record finds the
    // receipt; and only for the delivery that wrote the copy, so one copy
    // has one: anyone can re-randomise a Groth16 proof into other bytes of
    // the same copy, and each would otherwise leave a record (T-52). Those
    // run intake in full, as a repeat did before.
    if (copy.created)
      await this.#config.store.putOnce(
        `repeats/${hex(stubHash)}/${recordName(record)}`,
        encode(REPEAT, { ballot_hash: taken.ballotHash, share_hash: taken.shareHash }),
      );
    return { ok: true, ballotHash: taken.ballotHash, receipt };
  }

  /**
   * The stored receipt, when `record` is byte for byte one the seat
   * receipted and `ciphertext` hashes to the share hash it was receipted
   * for; otherwise undefined, and intake runs in full. Anyone holding a
   * member's delivery, a relay replaying a sealed request included, could
   * otherwise make the seat run its membership and validity proofs again on
   * every repeat (docs/spec/sealed-delivery.md, Known-weak; T-52). The same
   * bytes passed every check intake runs, and the election's checks and
   * cutoff ran again before this, so full intake would give this receipt
   * (RFC 6979) and store nothing new: the copy's L1 reference is in the
   * record, so a copy under another reference isn't a repeat.
   */
  async #repeat(
    stubHash: Uint8Array,
    record: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<IntakeOutcome | undefined> {
    const store = this.#config.store;
    const held = await store.get(`repeats/${hex(stubHash)}/${recordName(record)}`);
    if (held === undefined) return undefined;
    const repeat = decode(REPEAT, held);
    if (!equal(repeat.share_hash, shareCiphertextHash(ciphertext))) return undefined;
    const receipt = await store.get(`receipts/${hex(stubHash)}/${hex(repeat.ballot_hash)}`);
    if (receipt === undefined) return undefined;
    return { ok: true, ballotHash: repeat.ballot_hash, receipt };
  }

  /** The ballot hashes this seat receipted for the stub, sorted. */
  async receipted(stubHash: Uint8Array): Promise<Uint8Array[]> {
    return (await this.#config.store.list(`intake/${hex(stubHash)}`)).map((name) =>
      Uint8Array.from(Buffer.from(name, "hex")),
    );
  }

  async #open(
    stubBytes: Uint8Array,
    transcript: Uint8Array,
  ): Promise<{ ok: true; value: Opened } | { ok: false; code: ElectionRefusal }> {
    let stub: Stub;
    try {
      stub = decodeStub(stubBytes);
    } catch (e) {
      if (e instanceof DecodeError) return { ok: false, code: "intake-unapproved" };
      throw e;
    }
    const stubHash = hashOfStub(stub);
    const transcriptHash = ceremonyTranscriptHash(transcript);
    const name = `${hex(stubHash)}/${hex(transcriptHash)}`;
    let opened = this.#opened.get(name);
    if (opened === undefined) {
      const checked = await this.#check(stub, stubBytes, stubHash, transcript, transcriptHash);
      if (!checked.ok) return checked;
      opened = checked.value;
      this.#opened.set(name, opened);
    }
    if (this.#closed(opened)) return { ok: false, code: "intake-closed" };
    return { ok: true, value: opened };
  }

  // From `c_I` on, the seat's obligation is decided: a receipt issued later
  // is one no decision covers (docs/spec/delivery.md, What a node owes).
  #closed(opened: Opened): boolean {
    return this.#config.now() >= opened.cutoff;
  }

  async #check(
    record: Stub,
    stubBytes: Uint8Array,
    stubHash: Uint8Array,
    transcript: Uint8Array,
    transcriptHash: Uint8Array,
  ): Promise<{ ok: true; value: Opened } | { ok: false; code: ElectionRefusal }> {
    const config = this.#config;
    const stub = record.value;
    const secrets = await config.ceremony.intakeSecrets(stubHash);
    if (secrets === undefined) return { ok: false, code: "intake-unapproved" };
    // 3.2 as this seat checked it when it approved: the transcript it signed
    // for, and the key set its own check returned, never the delivery's word
    // (T-37).
    if (!equal(transcriptHash, secrets.transcriptHash))
      return { ok: false, code: "intake-transcript" };
    const result = checkCeremonyTranscript(
      {
        l2ChainId: stub.l2_chain_id,
        trusteeRegistry: stub.trustee_registry,
        electionId: stub.election_id,
        stubHash,
        panel: config.panel,
      },
      transcript,
      1,
    );
    // The seat's own registered signing key must be the one its secret
    // signs under, or every receipt it gives would fail `share-receipt`.
    const own = result.ok ? result.registered.find((k) => k.index === config.index) : undefined;
    if (
      !result.ok ||
      !equal(keySetHash(result.registered.map(keySetEntry)), secrets.keySetHash) ||
      own === undefined ||
      !equal(own.signingKey, identityKey(secrets.signingSecret))
    )
      return { ok: false, code: "intake-transcript" };
    // 2.5's pinned panel, 2.3, 1.3 and 2.4 again, now against the roots the
    // ballots will be checked under: a definition whose roots carry
    // identities nobody registered would lift the bound on what the seat
    // owes. The capacity check (4) passed when the seat approved; with no
    // other election it sees only this one's demand.
    const stubName = hex(stubHash);
    if (!this.#stubPassed.has(stubName)) {
      const again = await checkStub(stubBytes, config, config.electorate, new Map());
      if (!again.ok) return { ok: false, code: "intake-definition" };
      this.#stubPassed.add(stubName);
    }
    // A rolling stub never passes check 4 yet, so no seat approved one; its
    // ballots (version 5, against step roots) are [[P2-17]] part 7c-3b's.
    if (record.version === 7) return { ok: false, code: "intake-definition" };
    // Under definition version 5, ballot version 3: its questions' ranges
    // and the cell each ballot names (P2-14).
    const definition: Stub =
      record.version === 1
        ? { version: 1, value: { ...record.value, ceremony_transcript_hash: result.hash } }
        : { version: 5, value: { ...record.value, ceremony_transcript_hash: result.hash } };
    let election: BallotElection | QuestionBallotElection;
    try {
      election =
        definition.version === 1
          ? ballotElection(definition.value, result.registered)
          : questionBallotElection(definition.value, result.registered);
    } catch (e) {
      // A root of 0, which anyone can prove membership of (T-04), passes no
      // correct electorate check; this refuses it whatever the deployment's does.
      if (e instanceof RangeError) return { ok: false, code: "intake-definition" };
      throw e;
    }
    if (!(await config.registration(definition, secrets.keySetHash)))
      return { ok: false, code: "intake-unregistered" };
    return {
      ok: true,
      value: {
        election,
        stubHash,
        cutoff: intakeCutoff(stub.closes_at, BigInt(stub.l1_inclusion_bound), RELEASE_WINDOWS),
      },
    };
  }
}

/**
 * What a seat holds of its own intake for the stub: the ballot hash of every
 * receipt it gave, and each copy it receipted as a view ballot, with `M`
 * recomputed from the ballot hash, its tier and the copy's L1 reference under
 * `definitionHash`, the definition the approval registers. A copy from intake
 * has no entry the node has seen (docs/spec/delivery.md, What a node owes).
 */
export async function heldIntake(
  store: SeatStore,
  stubHash: Uint8Array,
  definitionHash: Uint8Array,
): Promise<{ receipts: Uint8Array[]; copies: ViewBallot[] }> {
  const stub = hex(stubHash);
  const receipts: Uint8Array[] = [];
  const copies: ViewBallot[] = [];
  for (const name of await store.list(`intake/${stub}`)) {
    const ballotHash = Uint8Array.from(Buffer.from(name, "hex"));
    const held = await store.get(`intake/${stub}/${name}`);
    if (held === undefined) throw new Error(`trustee node: intake record ${name} is gone`);
    const { tier, nullifier } = decode(TAKEN, held);
    receipts.push(ballotHash);
    for (const ref of await store.list(`copies/${stub}/${name}`)) {
      const bytes = await store.get(`copies/${stub}/${name}/${ref}`);
      if (bytes === undefined) throw new Error(`trustee node: copy record ${ref} is gone`);
      const copy = decode(COPY, bytes);
      copies.push({
        ballotHash,
        tier,
        nullifier,
        // T-38: `M` is recomputed, never stored, so a copy can't name a
        // message its ballot hash and reference don't give.
        message: membershipMessage({
          definitionHash,
          tier,
          ballotHash,
          l1RefNumber: copy.l1_ref_number,
          l1RefHash: copy.l1_ref_hash,
        }),
        l1RefNumber: copy.l1_ref_number,
        l1RefHash: copy.l1_ref_hash,
        entry: null,
      });
    }
  }
  return { receipts, copies };
}

/**
 * Every share receipt record (`0x000c`) the seat gave for the stub, by its
 * ballot hash in hex, as intake kept them: public records, which the seat
 * boards itself (`ReceiptCopySender`) and destruction leaves in place.
 */
export async function givenReceipts(
  store: SeatStore,
  stubHash: Uint8Array,
): Promise<{ readonly ballot: string; readonly receipt: Uint8Array }[]> {
  const stub = hex(stubHash);
  const given = [];
  for (const ballot of await store.list(`receipts/${stub}`)) {
    const receipt = await store.get(`receipts/${stub}/${ballot}`);
    if (receipt === undefined) throw new Error(`trustee node: receipt record ${ballot} is gone`);
    given.push({ ballot, receipt });
  }
  return given;
}

/**
 * The share hash the seat receipted for `ballotHash` under the stub: the
 * `share_hash` of the receipt it gave, read from the record intake wrote
 * before giving it. Throws if the seat holds no receipt for the ballot hash,
 * since a batch may carry only receipts the seat issued
 * (docs/spec/delivery.md, Share-receipt batch).
 */
export async function receiptedShareHash(
  store: SeatStore,
  stubHash: Uint8Array,
  ballotHash: Uint8Array,
): Promise<Uint8Array> {
  const held = await store.get(`intake/${hex(stubHash)}/${hex(ballotHash)}`);
  if (held === undefined) throw new Error("trustee node: no receipt held for an owed ballot hash");
  return decode(TAKEN, held).share_hash;
}

/**
 * The shares the seat opened from `ballotHash`'s ciphertext at intake under
 * the stub, checked against the ballot's commitments before its receipt was
 * given (docs/spec/ballot-validity.md, Shares), or `undefined` if the seat
 * took no such ballot in. Never logged.
 */
export async function heldShares(
  store: SeatStore,
  stubHash: Uint8Array,
  ballotHash: Uint8Array,
): Promise<readonly Share[] | undefined> {
  const held = await store.get(`intake/${hex(stubHash)}/${hex(ballotHash)}`);
  return held === undefined ? undefined : decode(TAKEN, held).shares;
}
