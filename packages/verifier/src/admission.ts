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

import {
  type BallotCheck,
  type BallotCheckV2,
  type BallotStep,
  DecodeError,
  type DecodeErrorCode,
  finishBallotSteps,
  pinnedVersion,
  profileCombinationRule,
  RECORD_TYPES,
  type Panel,
} from "@abolishus/crypto";
import { type AdmissionCode, steppedJudgeFor } from "./ballots.ts";
import { type CeremonyCode, ceremonyChecks } from "./ceremony.ts";
import { authorRunOf, decodeDefinition, isReadable, readDefinition } from "./definition.ts";

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

/** An election whose ballots can be judged, with the window its definition sets. */
export interface ElectionAdmission {
  readonly ok: true;
  readonly electionId: Uint8Array;
  readonly opensAt: bigint;
  readonly closesAt: bigint;
  /** The L1 chain its ballots name blocks of (5.8). */
  readonly l1ChainId: bigint;
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
}

/**
 * How an election's ballots are admitted, from its definition's bytes, the
 * panel the release pins for it and the board entries that may carry its
 * transcript (each an encoded entry; only an entry of this election, under
 * the pinned board-entry version, whose payload hashes to the definition's
 * `ceremony_transcript_hash` counts). Every input is what the verifier
 * would read, never a ballot's or a submitter's choice (T-37, T-04).
 */
export function electionAdmission(
  definitionBytes: Uint8Array,
  panel: Panel,
  entries: readonly Uint8Array[],
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
  const combination = profileCombinationRule(d);
  if (combination !== undefined) return refuse(combination);
  const { rows, registered } = ceremonyChecks(
    d,
    stubHash,
    panel,
    authorRunOf(record),
    entries,
    boardEntryVersion,
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
  const judge = steppedJudgeFor(record, registered);
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
  return {
    ok: true,
    electionId: new Uint8Array(d.election_id),
    opensAt: d.opens_at,
    closesAt: d.closes_at,
    l1ChainId: d.l1_chain_id,
    admit: (payload) => admitAll([payload])[0] as BallotAdmission,
    admitAll,
  };
}
