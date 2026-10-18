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
import {
  ballotElection,
  type BallotElection,
  bytesFixed,
  bytesVar,
  ceremonyTranscriptHash,
  checkCeremonyTranscript,
  decode,
  decodeElectionDefinitionRecord,
  DecodeError,
  type ElectionDefinition,
  electionDefinitionHash,
  electionStubHash,
  encode,
  encodeShareReceipt,
  fieldBn254,
  identityKey,
  type IntakeCode,
  intakeBallot,
  intakeCutoff,
  keySetEntry,
  keySetHash,
  SHARES,
  shareReceiptRecord,
  struct,
  u64,
  u8,
} from "@abolishus/crypto";
import type { CeremonySeat } from "./ceremony.ts";
import type { SeatStore } from "./store.ts";
import { checkStub, type ElectorateCheck, type Pins, RELEASE_WINDOWS } from "./stub.ts";
import { MAX_RECORD } from "./wire.ts";

/**
 * Whether finalized L2 shows the definition with this hash registered in the
 * election registry it names, under this key set in the trustee registry
 * ([[verifier]] 2.1, 2.5 and 3.2 from L2 state). It must resolve `false`
 * whenever it can't decide, since a seat takes no ballot of an election it
 * hasn't checked. The read belongs to `packages/verifier`'s chain access
 * (P2-13 part 3), as the electorate check's does; until a deployment supplies
 * it, every intake is refused.
 */
export type RegistrationCheck = (
  definitionHash: Uint8Array,
  keySetHash: Uint8Array,
) => Promise<boolean>;

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
      /** The share receipt record (`0x000b`) for the ballot, under this seat. */
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

interface Opened {
  readonly election: BallotElection;
  readonly stubHash: Uint8Array;
  readonly cutoff: bigint;
  readonly keys: Parameters<typeof intakeBallot>[1];
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export class IntakeSeat {
  readonly #config: IntakeConfig;
  // Elections that passed every check, by stub hash and transcript hash. Each
  // check reads finalized state, so a pass stays one; a refusal isn't kept,
  // since a check that couldn't decide yet may pass later.
  readonly #opened = new Map<string, Opened>();

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
    const { election, stubHash, keys } = opened.value;
    const taken = intakeBallot(election, keys, record, ciphertext);
    if (!taken.ok)
      return taken.option === undefined
        ? { ok: false, code: taken.code }
        : { ok: false, code: taken.code, option: taken.option };
    // The proofs take a while: a delivery begun before `c_I` that finishes
    // after it stores and signs nothing (What a node owes).
    if (this.#closed(opened.value)) return { ok: false, code: "intake-closed" };
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
    await this.#config.store.putOnce(
      `copies/${hex(stubHash)}/${ballot}/${taken.l1RefNumber}-${hex(taken.l1RefHash)}`,
      encode(COPY, { l1_ref_number: taken.l1RefNumber, l1_ref_hash: taken.l1RefHash }),
    );
    return {
      ok: true,
      ballotHash: taken.ballotHash,
      receipt: encodeShareReceipt(shareReceiptRecord(election.definitionHash, keys.seat, taken)),
    };
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
    let stub: ElectionDefinition;
    try {
      const record = decodeElectionDefinitionRecord(stubBytes);
      if (record.version !== 1) return { ok: false, code: "intake-unapproved" };
      stub = record.value;
    } catch (e) {
      if (e instanceof DecodeError) return { ok: false, code: "intake-unapproved" };
      throw e;
    }
    const stubHash = electionStubHash(stub);
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
    stub: ElectionDefinition,
    stubBytes: Uint8Array,
    stubHash: Uint8Array,
    transcript: Uint8Array,
    transcriptHash: Uint8Array,
  ): Promise<{ ok: true; value: Opened } | { ok: false; code: ElectionRefusal }> {
    const config = this.#config;
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
    const again = await checkStub(stubBytes, config, config.electorate, new Map());
    if (!again.ok) return { ok: false, code: "intake-definition" };
    const definition: ElectionDefinition = { ...stub, ceremony_transcript_hash: result.hash };
    const definitionHash = electionDefinitionHash(definition);
    if (!(await config.registration(definitionHash, secrets.keySetHash)))
      return { ok: false, code: "intake-unregistered" };
    let election: BallotElection;
    try {
      election = ballotElection(definition, result.registered);
    } catch (e) {
      // A root of 0, which anyone can prove membership of (T-04), passes no
      // correct electorate check; this refuses it whatever the deployment's does.
      if (e instanceof RangeError) return { ok: false, code: "intake-definition" };
      throw e;
    }
    return {
      ok: true,
      value: {
        election,
        stubHash,
        cutoff: intakeCutoff(stub.closes_at, BigInt(stub.l1_inclusion_bound), RELEASE_WINDOWS),
        keys: {
          seat: config.index,
          kemSecret: secrets.kemSecret,
          signingSecret: secrets.signingSecret,
        },
      },
    };
  }
}
