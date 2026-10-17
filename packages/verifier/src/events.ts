// Check 4.4's per-record part (docs/spec/verifier.md, Contract events; 4.4):
// every contract-event record (0x0008) of this election on the board copy is
// decoded strictly under the contract-event version the profile pins and
// passes @abolishus/crypto's event check against the definition's L2
// contracts (docs/spec/contracts.md, Contract-event record, Event check).
// Only the operator boards a contract-event record, and every log our
// contracts emit passes the check, so a record that fails either is the
// operator's, and fails the election (T-17, T-31, T-71).
//
// Only the anchored board is anyone's claim: a record fails 4.4 only inside
// the extent the board checks authenticated, once 4.1 and 4.2 pass, so no
// one can fail an election by appending entries to a copy of its board, or
// by serving a copy the anchors don't match (T-53). Without that extent a
// failing record leaves 4.4 unverifiable, with the code it would fail with.
// The L2 addresses are the definition's, unauthenticated until 2.1 proves
// its hash against the election registry, so a crafted definition can make
// honest records fail against the inputs, never the verdict (T-53).
//
// The election's own `ElectionCreated` and `DefinitionRegistered` also carry
// the L1 origin of the L2 block that emitted them, which the sequencer, or
// L2 governance rewriting the `L1Block` predeploy, chooses within the drift:
// each is checked as docs/spec/contracts.md (Election registry, The L1
// origin) says, against the release's pinned drift and, for format 5, the
// run of finalized L1 headers, and one that fails fails 4.4 like a record
// that fails the event check (T-71, T-69, T-34).
//
// Nothing here can pass 4.4. Which events the board must carry (the
// required entries) needs the L2 reads that 2.4, 2.5 and 3.1 wait on too,
// and whether the records are the contracts' own needs the accumulator
// replayed against archived storage proofs (P4-3) at output roots settled on
// L1 (P1-19 part 3b). The board carries only the events the election's
// checks use, out of sequences shared by every election, so their `n` have
// gaps, and the accumulator's rule 1 holds only over a contract's whole
// archived sequence: no ordering rule is applied to the board's subset.

import {
  checkContractEvent,
  type ContractEventError,
  type ContractEventVersion,
  DecodeError,
  type DecodeErrorCode,
  decodeBoardEntry,
  decodeContractEvent,
  type BoardEntryVersion,
  type EventContracts,
  type L1Origin,
  pinnedVersion,
  RECORD_TYPES,
} from "@abolishus/crypto";

import type { VerifiedDefinition } from "./definition.ts";
import type { L1Header } from "./l1.ts";

/** Why an event's L1 origin fails (docs/spec/verifier.md, Contract events, step 4). */
export type OriginCode = "l1-origin-unknown" | "l1-origin-drift" | "l1-origin-order";

export type EventCode = "decode" | ContractEventError | OriginCode;

/**
 * The `max_sequencer_drift` this release pins for the deployment's L2, in
 * seconds: Base's (docs/spec/contracts.md, Election registry, The L1 origin;
 * 0004-l2-choice). Never a definition's own value, which its creator chooses
 * (T-71). Changing it is a new release.
 */
export const PINNED_SEQUENCER_DRIFT = 1800n;

export interface EventOutcome {
  readonly status: "fail" | "unverifiable";
  readonly code: EventCode | "unsupported-version" | "not-implemented";
  readonly at?:
    | { readonly entry: number; readonly decodeError?: DecodeErrorCode }
    | Record<string, never>;
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// The versions this package's event check reads. A profile pinning another
// (or none) may name one a later release reads: unverifiable, never failed,
// so releases agree (2.3; T-36).
const isReadable = (v: number | undefined): v is ContractEventVersion =>
  v === 1 || v === 2 || v === 3 || v === 4 || v === 5 || v === 6 || v === 7 || v === 8;

/**
 * The row 4.4 as far as the board copy decides it: the first contract-event
 * record of the election, in copy order, that doesn't decode under the
 * pinned version or fails the event check, or, if none does,
 * `not-implemented`. `anchored` is the number of entries the board checks
 * authenticated, when 4.1 and 4.2 passed: a failing record among them
 * fails 4.4, and entries past them aren't read. Without it a failing record
 * leaves 4.4 unverifiable, with its code.
 */
export function eventChecks(
  definition: VerifiedDefinition,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
  anchored: number | undefined,
  blocks?: readonly L1Header[],
): EventOutcome {
  const d = definition.value;
  const version = pinnedVersion(d, RECORD_TYPES.contractEvent);
  if (!isReadable(version)) return { status: "unverifiable", code: "unsupported-version", at: {} };
  // The `chain` rule of 2.1 keeps the four addresses pairwise distinct, so
  // each record has at most one role.
  const contracts: EventContracts = {
    electionRegistry: d.election_registry,
    trusteeRegistry: d.trustee_registry,
    groupRegistry: d.group_registry,
    board: d.board,
  };
  const status = anchored === undefined ? "unverifiable" : "fail";
  const records: { readonly at: number; readonly payload: Uint8Array }[] = [];
  for (const [at, encoded] of entries.entries()) {
    // The board checks ignore what no anchor covers; so does 4.4.
    if (anchored !== undefined && at >= anchored) break;
    let payload: Uint8Array;
    try {
      const e = decodeBoardEntry(encoded, boardEntryVersion);
      // 4.1 reports an entry that doesn't decode or names another election.
      if (!equal(e.election_id, d.election_id)) continue;
      payload = e.payload;
    } catch (e) {
      if (e instanceof DecodeError) continue;
      throw e;
    }
    if ((((payload[0] as number) << 8) | (payload[1] as number)) !== RECORD_TYPES.contractEvent)
      continue;
    records.push({ at, payload });
  }
  type Checked =
    | {
        readonly at: number;
        readonly record: ReturnType<typeof decodeContractEvent>;
        readonly result: ReturnType<typeof checkContractEvent>;
      }
    | { readonly at: number; readonly error: DecodeErrorCode };
  const checked = records.map(({ at, payload }): Checked => {
    try {
      const record = decodeContractEvent(payload, version);
      return { at, record, result: checkContractEvent(record, contracts, version) };
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      return { at, error: e.code };
    }
  });
  // The election's creation, whose origin a registration's must not precede
  // (check 3): the first that passes the event check, wherever it is read.
  let creation: L1Origin | undefined;
  for (const c of checked)
    if ("result" in c && c.result.ok && c.result.event.event === "ElectionCreated")
      if (equal(c.result.event.electionId, d.election_id)) {
        creation = c.result.event.l1Origin;
        break;
      }
  for (const c of checked) {
    if (!("result" in c))
      return { status, code: "decode", at: { entry: c.at, decodeError: c.error } };
    if (!c.result.ok) return { status, code: c.result.error, at: { entry: c.at } };
    const event = c.result.event;
    if (event.event !== "ElectionCreated" && event.event !== "DefinitionRegistered") continue;
    if (!equal(event.electionId, d.election_id)) continue;
    const code = originCode(
      event.l1Origin,
      c.record.l2_timestamp,
      event.event === "DefinitionRegistered" ? creation : undefined,
      blocks,
    );
    if (code !== undefined) return { status, code, at: { entry: c.at } };
  }
  return { status: "unverifiable", code: "not-implemented" };
}

/**
 * The first of docs/spec/contracts.md's L1-origin checks an event fails
 * (Election registry, The L1 origin), or `undefined`. Check 1 is decided
 * only where the run of finalized headers holds the origin's number; a run
 * that doesn't reach it decides nothing, and 4.4 never passes anyway.
 */
export function originCode(
  origin: L1Origin,
  l2Timestamp: bigint,
  creation: L1Origin | undefined,
  blocks: readonly L1Header[] | undefined,
): OriginCode | undefined {
  // 1. One block of finalized L1: the run's block of that number has that
  // hash and that timestamp.
  const first = blocks?.[0];
  if (blocks !== undefined && first !== undefined && origin.number >= first.number) {
    const held = blocks[Number(origin.number - first.number)];
    if (
      held !== undefined &&
      (!equal(held.hash, origin.hash) || held.timestamp !== origin.timestamp)
    )
      return "l1-origin-unknown";
  }
  // 2. The event's L2 block is at or after its origin, by at most the
  // pinned drift.
  if (l2Timestamp < origin.timestamp || l2Timestamp > origin.timestamp + PINNED_SEQUENCER_DRIFT)
    return "l1-origin-drift";
  // 3. A registration's origin is at or after its election's creation's.
  if (
    creation !== undefined &&
    (origin.number < creation.number || origin.timestamp < creation.timestamp)
  )
    return "l1-origin-order";
  return undefined;
}
