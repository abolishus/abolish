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
// Where the run read the archive, each contract's archived sequence is
// replayed against its archived evidence (src/replay.ts), and every boarded
// record must be the sequence's event at its `n`. The archive's authority
// writes the runs and the evidence whole, and a record's output root is its
// word until P1-19 reads its game on L1 (T-71), so a replay that doesn't
// hold, an archived event that fails the event check, or a boarded record
// the sequence doesn't hold leaves 4.4 unverifiable, never failed (T-53).
//
// Nothing here can pass 4.4. Which events the board must carry (the
// required entries) needs the L2 reads that 2.4, 2.5 and 3.1 wait on too,
// and the replay is worth its records' output roots, which P1-19 part 3b
// settles on L1. The board carries only the events the election's checks
// use, out of sequences shared by every election, so their `n` have gaps,
// and the accumulator's rule 1 holds only over a contract's whole archived
// sequence: no ordering rule is applied to the board's subset.

import {
  checkContractEvent,
  type ContractRole,
  encodeContractEvent,
  type EventAccumulatorProofError,
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

import type { ArchiveFinding } from "./archive.ts";
import type { VerifiedDefinition } from "./definition.ts";
import type { L1Header } from "./l1.ts";
import type { ContractSequence } from "./replay.ts";
import type { RunFinding } from "./runs.ts";

/** Why an event's L1 origin fails (docs/spec/verifier.md, Contract events, step 4). */
export type OriginCode = "l1-origin-unknown" | "l1-origin-drift" | "l1-origin-order";

/**
 * Why the archive leaves 4.4 unverifiable (docs/spec/verifier.md 4.4): a
 * budget that kept or read no more, a replay rule broken, runs that stop
 * short, or a boarded record the replayed sequence doesn't hold at its `n`
 * (`archived-mismatch`) or doesn't reach (`archived-unreached`).
 */
export type ArchivedCode =
  | "evidence-over-budget"
  | "evidence-reads-over-budget"
  | EventAccumulatorProofError
  | Extract<RunFinding["code"], "run-gap" | "runs-over-budget">
  | "archived-mismatch"
  | "archived-unreached";

export type EventCode = "decode" | ContractEventError | OriginCode | ArchivedCode;

/** 4.4's replay of the archive, as the archive read keeps it. */
export interface ArchivedEvents {
  readonly contracts: readonly ContractSequence[];
  readonly findings: readonly Extract<ArchiveFinding, { code: "evidence-over-budget" }>[];
}

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
    | { readonly contract: ContractRole }
    | Record<string, never>;
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// The versions this package's event check reads. A profile pinning another
// (or none) may name one a later release reads: unverifiable, never failed,
// so releases agree (2.3; T-36).
const isReadable = (v: number | undefined): v is ContractEventVersion =>
  v !== undefined && Number.isInteger(v) && v >= 1 && v <= 12;

/**
 * The row 4.4 as far as the board copy decides it: the first contract-event
 * record of the election, in copy order, that doesn't decode under the
 * pinned version or fails the event check, or, if none does,
 * `not-implemented`. `anchored` is the number of entries the board checks
 * authenticated, when 4.1 and 4.2 passed: a failing record among them
 * fails 4.4, and entries past them aren't read. Without it a failing record
 * leaves 4.4 unverifiable, with its code. Where no record fails and the run
 * read the archive (`archived`), its replay is judged (`archivedOutcome`).
 */
export function eventChecks(
  definition: VerifiedDefinition,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
  anchored: number | undefined,
  blocks?: readonly L1Header[],
  archived?: ArchivedEvents,
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
  if (archived === undefined) return { status: "unverifiable", code: "not-implemented" };
  return archivedOutcome(
    archived,
    // Every record read passed the event check, above.
    checked.flatMap((c) => ("record" in c ? [{ at: c.at, record: c.record }] : [])),
    contracts,
    version,
  );
}

/**
 * 4.4 against the archive's replay (docs/spec/verifier.md 4.4; [[archive]],
 * The event replay), unverifiable with the first of, in order: the walk
 * keeping no more references (`evidence-over-budget`); then for each
 * contract in role order, its evidence reads cut short
 * (`evidence-reads-over-budget`), a proven record its sequence breaks a
 * rule of (`index`, `order`, `block-range`, `accumulator`), its runs
 * stopping short of the largest count proven (`run-gap`,
 * `runs-over-budget`), and an event it holds that fails the event check
 * (the check's code), each at `{"contract": role}`; then, in copy order, a
 * boarded record past the events its contract holds (`archived-unreached`)
 * or other than the held event at its `n` (`archived-mismatch`), at
 * `{"entry": n}`. Otherwise `not-implemented`, for the required entries.
 * Never a failure: the authority writes runs and evidence whole, and their
 * roots are its word until P1-19 (T-71, T-53).
 */
function archivedOutcome(
  archived: ArchivedEvents,
  boarded: readonly { readonly at: number; readonly record: ContractEventRecordOf }[],
  contracts: EventContracts,
  version: ContractEventVersion,
): EventOutcome {
  const unverifiable = (
    code: EventOutcome["code"],
    at: NonNullable<EventOutcome["at"]>,
  ): EventOutcome => ({
    status: "unverifiable",
    code,
    at,
  });
  if (archived.findings.length > 0) return unverifiable("evidence-over-budget", {});
  for (const c of archived.contracts) {
    const at = { contract: c.role };
    if (c.evidence.findings.some((f) => f.code === "evidence-reads-over-budget"))
      return unverifiable("evidence-reads-over-budget", at);
    for (const r of c.evidence.records)
      if (r.replay !== null && r.replay !== "unreached") return unverifiable(r.replay, at);
    const stop = c.runs.findings.at(-1);
    if (!c.runs.complete && (stop?.code === "run-gap" || stop?.code === "runs-over-budget"))
      return unverifiable(stop.code, at);
    // Only the events a proven record authenticates are judged; one that
    // fails is the archive's, never the board's (T-53).
    for (const r of c.records.slice(0, Number(c.held))) {
      const result = checkContractEvent(r, contracts, version);
      if (!result.ok) return unverifiable(result.error, at);
    }
    // With the runs whole, only an event with no topic, which no log of
    // ours has, leaves a proven record unreached (src/replay.ts).
    if (c.runs.complete && c.evidence.records.some((r) => r.replay === "unreached"))
      return unverifiable("event-topics", at);
  }
  for (const { at, record } of boarded) {
    const sequence = archived.contracts.find((c) => equal(c.contract, record.contract));
    // The event check passed, so the record is one of the four contracts'.
    if (sequence === undefined || record.n >= sequence.held)
      return unverifiable("archived-unreached", { entry: at });
    const held = sequence.records[Number(record.n)] as ContractEventRecordOf;
    if (!equal(encodeContractEvent(held, version), encodeContractEvent(record, version)))
      return unverifiable("archived-mismatch", { entry: at });
  }
  return { status: "unverifiable", code: "not-implemented" };
}

type ContractEventRecordOf = ReturnType<typeof decodeContractEvent>;

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
