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
  type ElectionDefinitionRecord,
  type EventContracts,
  pinnedVersion,
  RECORD_TYPES,
} from "@abolishus/crypto";

export type EventCode = "decode" | ContractEventError;

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
const isReadable = (v: number | undefined): v is ContractEventVersion => v === 1 || v === 2;

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
  definition: ElectionDefinitionRecord,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
  anchored: number | undefined,
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
    let checked;
    try {
      checked = checkContractEvent(decodeContractEvent(payload, version), contracts, version);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      return { status, code: "decode", at: { entry: at, decodeError: e.code } };
    }
    if (!checked.ok) return { status, code: checked.error, at: { entry: at } };
  }
  return { status: "unverifiable", code: "not-implemented" };
}
