// Ballot admission for one ballot at a time, as a board operator runs it
// before boarding (docs/spec/board.md, Envelope: the operator MUST append
// only payloads that decode strictly under the election's profile). It is
// the verifier's own admission (5.1 to 5.4), under the same definition
// checks (2.1, 2.3, 1.3), the same transcript check (2.5's panel, 3.2) and
// the same per-ballot judge `ballotChecks` runs, so a ballot the operator
// boards is one the verifier admits by those rows, and no server code
// reimplements them (AGENTS.md, The verifier's trust base; T-17, T-52).
//
// What it can't decide from the definition, the panel and the transcript
// alone stays with the caller or the verifier: the L1 reference (5.8), the
// close rule (5.5), repeats (5.7) and the L2 side of 3.1.
//
// It also judges a share receipt the operator is asked to board, by the
// receipt's own rules of Boarding (docs/spec/delivery.md, rules 1 and 4):
// the record decodes strictly, names this definition and a seat of the
// registered key set, and passes `share-receipt` against the boarded ballot
// its ballot hash names, with that ballot's own share hash for the seat. So
// the operator boards only receipts the delivery check reads as passing
// (T-17, T-52). Finding the ballot (rule 2), the window (rule 3) and an
// earlier passing receipt (rule 5) are the board's, which the caller holds.

import {
  type BallotCheck,
  type BallotCheckV2,
  type BallotStep,
  castReceiptSeatV3,
  DecodeError,
  type DecodeErrorCode,
  decodeShareReceipt,
  finishBallotSteps,
  pinnedVersion,
  profileCombinationRule,
  type QuestionBallotElection,
  questionBallotElection,
  RECORD_TYPES,
  type Panel,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type AdmissionCode, steppedJudgeFor } from "./ballots.ts";
import { type CeremonyCode, ceremonyChecks } from "./ceremony.ts";
import { authorRunOf, decodeDefinition, isReadable, readDefinition } from "./definition.ts";
import { PINNED_PANELS, type PinnedPanel, pinnedOurs } from "./panels.ts";

/** Why no ballot of an election can be admitted: the first check that stops them all. */
export type ElectionAdmissionCode =
  /** The definition doesn't decode strictly (2.1). */
  | "definition-decode"
  /** It breaks a well-formedness rule (2.1). */
  | "definition-rule"
  /** It pins a version this verifier doesn't read, or a profile 2.3 refuses. */
  | "unsupported-version"
  | "profile-combination"
  /** The definition doesn't name this panel (2.5). */
  | "panel-unpinned"
  /** No entry given is the transcript the definition names (3.2 unverifiable). */
  | "ceremony-transcript-missing"
  /** The transcript check didn't pass (3.2): its code. */
  | Exclude<CeremonyCode, "panel-unpinned" | "ceremony-transcript-missing">
  | "ceremony-decode"
  /** 3.2 passed, but its ballots can't be judged: another membership key (1.3) or a zero root. */
  | "not-reached";

/** One ballot's verdict: admitted by 5.1 to 5.4, or the code it was rejected under. */
export type BallotAdmission =
  | {
      readonly ok: true;
      /** The ballot hash, recomputed from the record (never a decoded field): what a share receipt names. */
      readonly ballotHash: Uint8Array;
      readonly tier: number;
      readonly nullifier: bigint;
      /** `M`, recomputed from the record, so a re-randomised proof doesn't hide a repeat (T-38). */
      readonly message: Uint8Array;
      /** The L1 block the ballot names (5.8 is the caller's), as `M` binds it. */
      readonly l1RefNumber: bigint;
      readonly l1RefHash: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly code: AdmissionCode | "decode";
      readonly decodeError?: DecodeErrorCode;
    };

/** Why a share receipt can't be boarded for an election (docs/spec/delivery.md, Boarding). */
export type ReceiptAdmissionCode =
  /** It doesn't decode strictly as the share receipt the election's ballot version fixes. */
  | "decode"
  /** This release boards no receipt for the election's definition version yet. */
  | "unsupported-version"
  /** It names another definition than the election's (rule 1). */
  | "receipt-definition"
  /** Its seat isn't one of the registered key set's (rule 1). */
  | "receipt-seat";

/**
 * A share receipt's verdict by rule 1: refused with its code, or the ballot
 * hash and seat it names, and `check`, rule 4 against a boarded ballot.
 */
export type ReceiptAdmission =
  | {
      readonly ok: true;
      /** The ballot hash the record names: the ballot the caller finds on the board (rule 2). */
      readonly ballotHash: Uint8Array;
      readonly seat: number;
      /**
       * Whether the receipt passes `share-receipt` against `ballot`, a
       * ballot record the board carries (rule 4): the ballot hash
       * recomputed from it and its own share hash for the seat are the
       * record's, and the signature verifies under that seat's registered
       * signing key. False for bytes that aren't a ballot of this election.
       */
      readonly check: (ballot: Uint8Array) => boolean;
    }
  | {
      readonly ok: false;
      readonly code: ReceiptAdmissionCode;
      readonly decodeError?: DecodeErrorCode;
    };

/** An election whose ballots can be judged, with the window its definition sets. */
export interface ElectionAdmission {
  readonly ok: true;
  readonly electionId: Uint8Array;
  readonly opensAt: bigint;
  readonly closesAt: bigint;
  /** The L1 chain its ballots name blocks of (5.8). */
  readonly l1ChainId: bigint;
  /** The definition's `l1_inclusion_bound`: with `closesAt`, where the delivery windows end. */
  readonly l1InclusionBound: bigint;
  /** Strictly decodes one ballot payload and runs 5.1 to 5.4 on it; never throws on its bytes. */
  readonly admit: (payload: Uint8Array) => BallotAdmission;
  /**
   * Each payload's verdict, exactly as `admit` gives it, with the membership
   * proofs of the ballots that reach that check verified together
   * (docs/spec/ballot-validity.md, Batched admission): a ballot whose proof
   * fails runs no validity proof, and an invalid proof costs at most its own
   * batch of 64 the gain from batching (T-52). Never throws on the bytes.
   */
  readonly admitAll: (payloads: readonly Uint8Array[]) => BallotAdmission[];
  /** Rule 1 for a share receipt's bytes, with rule 4 to run against its ballot; never throws on them. */
  readonly receipt: (payload: Uint8Array) => ReceiptAdmission;
}

/**
 * How an election's ballots are admitted, from its definition's bytes, the
 * panel the release pins for it and the board entries that may carry its
 * transcript (each an encoded entry; only an entry of this election, under
 * the pinned board-entry version, whose payload hashes to the definition's
 * `ceremony_transcript_hash` counts). Every input is what the verifier
 * would read, never a ballot's or a submitter's choice (T-37, T-04).
 * `pins` are the panels the release pins, as `verifyBundle` reads them, so
 * admission and 2.3 judge a live poll's restriction alike.
 */
export function electionAdmission(
  definitionBytes: Uint8Array,
  panel: Panel,
  entries: readonly Uint8Array[],
  pins: readonly PinnedPanel[] = PINNED_PANELS,
): ElectionAdmission | { readonly ok: false; readonly code: ElectionAdmissionCode } {
  const refuse = (code: ElectionAdmissionCode) => ({ ok: false, code }) as const;
  let record;
  try {
    record = decodeDefinition(definitionBytes);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    return refuse(
      // As 2.1 reads it: version 0 is no release's, so it fails decoding.
      e.code === "unknown-version" && e.offset === 2 && definitionBytes[2] !== 0
        ? "unsupported-version"
        : "definition-decode",
    );
  }
  const { stubHash, rule } = readDefinition(record);
  if (rule !== undefined) return refuse("definition-rule");
  const d = record.value;
  const boardEntryVersion = pinnedVersion(d, RECORD_TYPES.boardEntry);
  if (!isReadable(boardEntryVersion)) return refuse("unsupported-version");
  // As 2.3 reads it, with the release's pins: a live poll's ballots are
  // admitted only under the live restriction (T-16, T-45).
  const combination = profileCombinationRule(
    d,
    pinnedOurs(bytesToHex(d.panel_id), d.panel_size, pins),
  );
  if (combination !== undefined) return refuse(combination);
  const { rows, registered, authorRegistered } = ceremonyChecks(
    d,
    stubHash,
    panel,
    authorRunOf(record),
    entries,
    boardEntryVersion,
    pins,
  );
  if (registered === undefined) {
    // The first failing row decides: 2.5 (another panel, a transitional one
    // on the civic record, or an author seat a default seat's), 3.1 (a transcript
    // that doesn't decode or fails a transcript-level check), then 3.2
    // (quorum or participation). Otherwise 3.1 says why nothing was checked.
    for (const id of ["2.5", "3.1", "3.2"]) {
      const o = rows.get(id);
      if (o?.status !== "fail" || o.code === undefined) continue;
      return refuse(o.code === "decode" ? "ceremony-decode" : (o.code as ElectionAdmissionCode));
    }
    const why = rows.get("3.1")?.code;
    return refuse(
      why === "ceremony-transcript-missing" || why === "unsupported-version" ? why : "not-reached",
    );
  }
  const judge = steppedJudgeFor(record, registered, authorRegistered);
  if (typeof judge !== "function")
    return refuse(judge.code === "unsupported-version" ? "unsupported-version" : "not-reached");
  // Up to the membership proof: a payload decided before it, or its step.
  const step = (payload: Uint8Array): BallotAdmission | BallotStep<BallotCheck | BallotCheckV2> => {
    // The envelope's record type first: a payload of another type is no
    // ballot, whatever its bytes after the type would decode to.
    if (
      payload.length < 2 ||
      (((payload[0] as number) << 8) | (payload[1] as number)) !== RECORD_TYPES.ballot
    )
      return { ok: false, code: "decode", decodeError: "unexpected-record-type" };
    try {
      return judge(payload).step;
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      return { ok: false, code: "decode", decodeError: e.code };
    }
  };
  const verdict = (checked: BallotCheck | BallotCheckV2): BallotAdmission =>
    checked.ok
      ? {
          ok: true,
          ballotHash: new Uint8Array(checked.ballotHash),
          tier: checked.tier,
          nullifier: checked.nullifier,
          message: checked.message,
          l1RefNumber: checked.l1RefNumber,
          l1RefHash: new Uint8Array(checked.l1RefHash),
        }
      : { ok: false, code: checked.code };
  const admitAll = (payloads: readonly Uint8Array[]): BallotAdmission[] => {
    const results: (BallotAdmission | undefined)[] = [];
    const waiting: {
      readonly at: number;
      readonly step: BallotStep<BallotCheck | BallotCheckV2>;
    }[] = [];
    for (const [at, payload] of payloads.entries()) {
      const s = step(payload);
      if ("ok" in s) results.push(s);
      else {
        results.push(undefined);
        waiting.push({ at, step: s });
      }
    }
    // Finishing reads only what each step decoded and the election's own
    // context, so no payload's bytes can make it throw and lose the others'
    // verdicts: every decoding error was caught above, per payload.
    const finished = finishBallotSteps(waiting.map((w) => w.step));
    for (const [i, { at }] of waiting.entries())
      results[at] = verdict(finished[i] as BallotCheck | BallotCheckV2);
    return results as BallotAdmission[];
  };
  // Only definition version 5's receipts (ballot version 3, the one the
  // ballot client casts) are judged yet; another version's are refused,
  // never judged under the wrong ballot hash (T-36).
  const questions =
    record.version === 5 ? questionBallotElection(record.value, registered) : undefined;
  const seats = new Set(registered.map((k) => k.index));
  return {
    ok: true,
    electionId: new Uint8Array(d.election_id),
    opensAt: d.opens_at,
    closesAt: d.closes_at,
    l1ChainId: d.l1_chain_id,
    l1InclusionBound: BigInt(d.l1_inclusion_bound),
    admit: (payload) => admitAll([payload])[0] as BallotAdmission,
    admitAll,
    receipt: (payload) =>
      questions === undefined
        ? { ok: false, code: "unsupported-version" }
        : receiptAdmission(questions, seats, payload),
  };
}

/** Rule 1 for a version-1 share receipt (ballot version 3's), and its rule 4. */
function receiptAdmission(
  election: QuestionBallotElection,
  seats: ReadonlySet<number>,
  payload: Uint8Array,
): ReceiptAdmission {
  const own = new Uint8Array(payload);
  let decoded;
  try {
    decoded = decodeShareReceipt(own, 1);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    return { ok: false, code: "decode", decodeError: e.code };
  }
  if (!equal(decoded.definition_hash, election.definitionHash))
    return { ok: false, code: "receipt-definition" };
  const { seat } = decoded;
  if (!seats.has(seat)) return { ok: false, code: "receipt-seat" };
  return {
    ok: true,
    ballotHash: new Uint8Array(decoded.ballot_hash),
    seat,
    check: (ballot) => {
      try {
        return castReceiptSeatV3(election, ballot, own) === seat;
      } catch (e) {
        // A ballot that doesn't decode, or is another election's: no ballot
        // this receipt can stand for (castReceiptSeatV3 throws on both).
        if (e instanceof DecodeError || e instanceof TypeError) return false;
        throw e;
      }
    },
  };
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
