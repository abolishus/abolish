// Runs the checks of docs/spec/verifier.md over one bundle and builds the
// report (Procedure, Verdicts, Report). Only the board checks (4.1, 4.2), the
// definition's decoding and well-formedness (part of 2.1) under definition
// versions 1, 3, 4, 5 and 6, 2.3's profile combination, 2.9's receipt keys from L1
// state, 8.5's not-applicable case,
// 1.3's failure for a definition naming another membership key and, for
// formats 4 and 5, the key-ceremony
// transcript check (3.2, and the parts of 2.5 and 3.1 that need no L2 state)
// ballot admission (5.1 to 5.4, and 5.7 as far as 5.5 allows; ballot
// version 2 against its cell under definition versions 3 and 4, ballot
// version 3 against its cell and questions under definition version 5; for
// format 5, 5.8 against its run of L1 headers, before 5.7) and the
// spoiled-ballot openings (6.2, as far as the floor of s_S decides them;
// opening version 2 under definition versions 3 to 5) and
// the tally openings' sorting, attribution and boarding breaches (7.4, as far
// as they need no counted set; against the cells under definition versions 3
// to 5) and, for format 5, selection (6.1, once the counted extent is fixed)
// and, once it passes, delivery (5.9), the close check (6.3), the tally
// checks (7.1 to 7.3, and 7.4's counted-set breaks) and 8.5 (counted.ts,
// close.ts) are implemented, under a live definition once 7.1 passes the
// releases (7.5, 7.6; live.ts), and, for formats 3 to 5, 4.4's event and
// L1-origin checks over the board's contract-event records, which can fail
// 4.4 but never pass it;
// every other check is reported unverifiable, so no run can report an
// election verified yet. A run on unauthenticated inputs reports
// what the checks found against them, but its verdict stays unverifiable, so
// a crafted bundle can neither verify nor fail an election (T-53, T-24).

import {
  type Anchor,
  type AsyncBlockSource,
  BoardError,
  type BoardEntryVersion,
  boardPayloadTypes,
  type BoardErrorAt,
  type BoardErrorCode,
  boardEntryHash,
  DecodeError,
  type DecodeErrorCode,
  decodeReceipt,
  type ElectionDefinitionV6Rule,
  encodeBoardEntry,
  EncodeError,
  membershipVkHash,
  pinnedVersion,
  profileCombinationRule,
  readBoardCopy,
  type ReceiptVerdict,
  RECORD_TYPES,
  verifyBoard,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  type AdmissionCode,
  ballotChecks,
  type BallotsReport,
  type CountedCandidate,
  isLive,
  judgeFor,
  readsEvents,
  type WindowCode,
} from "./ballots.ts";
import { type DropOutcome, judgeDropRule } from "./drops.ts";
import { type L1RefCode, referenceJudge } from "./references.ts";
import type { BlockStore } from "./blocks.ts";
import type { Gateways } from "./gateways.ts";
import type { Bundle, CidRead, InputSource, InputSources } from "./bundle.ts";
import { type CeremonyCode, ceremonyChecks, type CeremonyReport } from "./ceremony.ts";
import { CHECKS, type CheckKind } from "./checks.ts";
import {
  authorRunOf,
  decodeDefinition,
  isReadable,
  readDefinition,
  type VerifiedDefinition,
} from "./definition.ts";
import { eventChecks, type EventCode } from "./events.ts";
import {
  type CellReport,
  cellTiers,
  countedChecks,
  type CountedCode,
  countedRows,
  type CountedResult,
  type DeliveryReport,
  type DeliveryReportV2,
  type DestructionReport,
  type QuestionReport,
  type TierReport,
} from "./counted.ts";
import { countedFloor, openingChecks, type OpeningCode, type OpeningReport } from "./openings.ts";
import { admissionSettled, selectionCheck } from "./selection.ts";
import { type ReceiptKeyCode, receiptKeyRow } from "./receipt-keys.ts";
import type { CloseReport } from "./close.ts";
import { tallyChecks, type TallyCode, type TallyReport } from "./tallies.ts";
import { releaseChecks, type ReleasesReport } from "./live.ts";
import type { ReleaseRowCode } from "./releases.ts";
import {
  anchorsFromState,
  type L1Evidence,
  L1Error,
  type L1ErrorCode,
  type StateAnchor,
} from "./l1.ts";

export type CheckStatus = "pass" | "fail" | "unverifiable";
export type Verdict = "verified" | "failed" | "unverifiable";
export type CheckCode =
  | BoardErrorCode
  | L1ErrorCode
  | ElectionDefinitionV6Rule
  | CeremonyCode
  | AdmissionCode
  | WindowCode
  | "repeat"
  | L1RefCode
  | "l1-ref-pending"
  | "l1-blocks-short"
  | "not-sealed"
  | OpeningCode
  | TallyCode
  | CountedCode
  | ReceiptKeyCode
  | EventCode
  | ReleaseRowCode
  | "decode"
  | "membership-key"
  | "profile-combination"
  | "unsupported-version"
  | "not-reached"
  | "not-applicable"
  | "not-implemented";

/**
 * Where a failure is: an entry, a checkpoint by its position in the bundle's
 * anchors, a segment, the definition's decode error, or the board.
 */
export type CheckAt =
  /** `panel` is set on 3.1 and 3.2 when the author panel's run is the one that failed. */
  | { readonly entry: number; readonly decodeError?: DecodeErrorCode; readonly panel?: "author" }
  /** 3.1's author panel transcript or approvals, where no entry is named. */
  | { readonly panel: "author" }
  | { readonly decodeError: DecodeErrorCode }
  /** 2.1's first failing question under definition versions 5 and 6. */
  | { readonly question: number }
  | { readonly checkpoint: number }
  | { readonly segment: number }
  | { readonly key: number }
  /** 7.2's first failing cell, with its option or question where the code names one. */
  | { readonly cell: number; readonly option?: number; readonly question?: number }
  /** 7.5's first failing release and cell, with its option or question where the code names one. */
  | {
      readonly cell: number;
      readonly snapshot: number;
      readonly option?: number;
      readonly question?: number;
    }
  /** 7.5's and 7.6's first snapshot whose L1 head the run doesn't fix. */
  | { readonly snapshot: number }
  /** 8.5's first registered seat that isn't `destroyed`, or isn't decided; 2.5's `default-seat`'s first author seat. */
  | { readonly seat: number }
  | Record<string, never>;

export interface CheckResult {
  readonly id: string;
  readonly kind: CheckKind;
  readonly status: CheckStatus;
  readonly code?: CheckCode;
  readonly at?: CheckAt;
}

export interface Report {
  readonly format: typeof REPORT_FORMAT;
  readonly verdict: Verdict;
  readonly verdictAgainstInputs: Verdict;
  readonly inputs: InputSources;
  /** A format-3, 4 or 5 bundle's definition hash, once the definition decodes. */
  readonly definition?: { readonly hash: string };
  /** A format-4 or 5 bundle's transcript check, once it reached the seats. */
  readonly ceremony?: CeremonyReport;
  /** A format-4 or 5 bundle's ballot admission, once it ran (5.1 to 5.5, 5.7, and 5.8 for format 5). */
  readonly ballots?: BallotsReport;
  /** A format-4 or 5 bundle's spoiled-ballot openings, once 6.2 ran, in copy order. */
  readonly openings?: readonly OpeningReport[];
  /** A format-4 or 5 bundle's tally openings, once 7.4 ran, in copy order. */
  readonly tallies?: readonly TallyReport[];
  /** A format-5 bundle's delivery check over the selected ballots, once 5.9 passed. */
  readonly delivery?: DeliveryReport | DeliveryReportV2;
  /** A format-5 bundle's cells, each with its counted ballots and counts, once 7.1 passed. */
  readonly cells?: readonly CellReport[];
  /** A format-5 bundle's per-tier results, derived from the cells, once 7.1 passed. */
  readonly tiers?: readonly TierReport[];
  /** Under definition versions 5 and 6, beside `cells`, each question's limits and method (8.1). */
  readonly questions?: readonly QuestionReport[];
  /** A format-5 bundle's destruction report, once 8.5 ran. */
  readonly destruction?: DestructionReport;
  /** A format-5 bundle's close check, once 6.3 found `L_δ`. */
  readonly close?: CloseReport;
  /** A format-5 bundle's releases under a live definition, once 7.5 fixed its snapshots. */
  readonly releases?: ReleasesReport;
  readonly board: {
    readonly entries: number;
    readonly unreadableBytes: number;
    readonly unauthenticated?: number;
    /** A copy read by CID from blocks.car: how the read came out. */
    readonly byCid?: CidRead;
  };
  /** The L1 block a format-2 to 5 bundle was proven at, and the anchors read from its state. */
  readonly l1?: {
    readonly blockHash: string;
    readonly blockNumber: string;
    readonly timestamp: string;
    readonly anchors?: readonly {
      readonly segment: number;
      readonly hash: string;
      readonly source: StateAnchor["source"];
    }[];
  };
  readonly checks: readonly CheckResult[];
}

export const REPORT_FORMAT = "abolish-verifier-report/1";

type Outcome = Pick<CheckResult, "status" | "code" | "at">;

const PASS: Outcome = { status: "pass" };
const NOT_REACHED: Outcome = { status: "unverifiable", code: "not-reached" };
const NOT_IMPLEMENTED: Outcome = { status: "unverifiable", code: "not-implemented" };
const UNSUPPORTED: Outcome = { status: "unverifiable", code: "unsupported-version", at: {} };
// 8.5 under a board-entry version that can't carry a destruction statement:
// reported, never `destruction-missing` for every seat (docs/spec/verifier.md, 8.5).
const NOT_APPLICABLE: Outcome = { status: "unverifiable", code: "not-applicable" };
const carriesDestruction = (v: BoardEntryVersion) =>
  boardPayloadTypes(v).includes(RECORD_TYPES.destructionStatement);

/**
 * 7.5's and 7.6's rows before the releases are read (docs/spec/verifier.md,
 * Releases, step 1): a sealed definition has none, and no board-entry
 * version it can pin carries a running opening, so both pass; a live one
 * under a tally-opening pin other than 2 is a later release's (T-36), and
 * otherwise waits on 7.1's pass, which `verifyBundle` checks next.
 */
function releaseGate(definition: VerifiedDefinition): Outcome {
  if (!isLive(definition)) return PASS;
  if (pinnedVersion(definition.value, RECORD_TYPES.tallyOpening) !== 2) return UNSUPPORTED;
  return { status: "unverifiable", code: "not-reached", at: {} };
}

function copyAt(at: BoardErrorAt): CheckAt {
  if ("entry" in at)
    return at.decodeError === undefined
      ? { entry: at.entry }
      : { entry: at.entry, decodeError: at.decodeError };
  if ("checkpoint" in at) return { checkpoint: at.checkpoint };
  if ("segment" in at) return { segment: at.segment };
  return {};
}

/**
 * The rows of 4.1 and 4.2 for a board-check failure (docs/spec/verifier.md,
 * Procedure, step 5). The board checks stop at the first failure, so the
 * code says which steps ran. Exhaustive: a new code doesn't compile until it
 * is mapped.
 */
function boardOutcomes(e: BoardError): readonly [Outcome, Outcome] {
  const at = copyAt(e.at);
  const failed: Outcome = { status: "fail", code: e.code, at };
  const code: BoardErrorCode = e.code;
  switch (code) {
    // A copy that is too short or differs is that copy's problem:
    // unverifiable from this source, never the election's failure (T-53).
    case "checkpoint-missing":
    case "copy-mismatch": {
      const copy: Outcome = { status: "unverifiable", code, at };
      return [copy, copy];
    }
    // Anchor checks run before any entry is decoded.
    case "checkpoint-equivocation":
    case "checkpoint-size":
    case "checkpoint-inconsistent":
      return [NOT_REACHED, failed];
    case "wrong-election":
      return "checkpoint" in e.at ? [NOT_REACHED, failed] : [failed, NOT_REACHED];
    // Entry checks: 4.1 failed, and the checkpoint steps after it never ran.
    case "decode":
    case "wrong-index":
    case "segment-decreased":
    case "opening-order":
      return [failed, NOT_REACHED];
    // Run only once every entry passed.
    case "checkpoint-boundary":
    case "checkpoint-cid":
    case "unanchored":
    case "unsealed":
      return [PASS, failed];
    default: {
      const unmapped: never = code;
      throw new Error(`unmapped board-check code ${String(unmapped)}`);
    }
  }
}

// A local file authenticates nothing. The switch is exhaustive, so a new
// source type doesn't compile until it is decided here.
export function authenticated(source: InputSource): boolean {
  switch (source) {
    case "local-file":
      return false;
    // Proven against the header's state root: as authentic as the header,
    // the anchor's address and the first segment, each judged as its own
    // input.
    case "l1-state-proof":
    // A field of the definition: as authentic as the definition, judged as
    // its own input.
    case "definition":
      return true;
    default: {
      const unhandled: never = source;
      throw new Error(`unknown input source ${String(unhandled)}`);
    }
  }
}

/** `verdictAgainstInputs` (docs/spec/verifier.md, Verdicts). Report-only checks never change it. */
function judge(checks: readonly CheckResult[]): Verdict {
  if (checks.some((c) => c.kind === "election" && c.status === "fail")) return "failed";
  if (checks.some((c) => c.kind !== "report-only" && c.status === "unverifiable"))
    return "unverifiable";
  return "verified";
}

/** What the board checks run with besides the copy and the clock. */
type BoardInputs =
  | {
      readonly electionId: Uint8Array;
      readonly boardEntryVersion: BoardEntryVersion;
      readonly now: bigint;
      readonly anchors: readonly Anchor[];
    }
  | {
      readonly electionId: Uint8Array;
      readonly boardEntryVersion: BoardEntryVersion;
      readonly l1: L1Evidence;
    };

/** Whether the definition's ballots are proved under the one membership key this release pins (ballot versions 1 to 4). */
function provedUnderPinnedKey(d: VerifiedDefinition["value"]): boolean {
  const pinned = pinnedVersion(d, RECORD_TYPES.ballot);
  return pinned === 1 || pinned === 2 || pinned === 3 || pinned === 4;
}

/**
 * A format-3, 4 or 5 bundle's definition (docs/spec/verifier.md, Definition): its
 * decoding and well-formedness, which are part of 2.1, the board-entry
 * version its profile pins, and the board checks' inputs taken from it. Any
 * other format gives them as they are.
 */
function fromDefinition(bundle: Bundle):
  | {
      readonly inputs: BoardInputs;
      readonly hash?: Uint8Array;
      readonly definition?: VerifiedDefinition;
      readonly stubHash?: Uint8Array;
      /** 2.3's row when the profile's versions don't fit together, or pin one this verifier doesn't know. */
      readonly profile?: Outcome;
    }
  | {
      readonly rows: ReadonlyMap<string, Outcome>;
      readonly hash?: Uint8Array;
    } {
  if (bundle.format === "abolish-verifier-bundle/1") return { inputs: bundle };
  if (bundle.format === "abolish-verifier-bundle/2") return { inputs: bundle };
  // The board checks need the election and the version: without them they
  // can't run, so 4.1 and 4.2 are not reached, and neither are 4.4's event
  // check nor the ceremony checks and ballot admission of formats 4 and 5, which
  // read the board.
  const boardRows: [string, Outcome][] = [
    ["4.4", NOT_REACHED],
    ["7.5", NOT_REACHED],
    ["7.6", NOT_REACHED],
    ...(bundle.format === "abolish-verifier-bundle/4" ||
    bundle.format === "abolish-verifier-bundle/5"
      ? ([
          ["2.5", NOT_REACHED],
          ["3.1", NOT_REACHED],
          ["3.2", NOT_REACHED],
          ["5.1", NOT_REACHED],
          ["5.2", NOT_REACHED],
          ["5.3", NOT_REACHED],
          ["5.4", NOT_REACHED],
          ["5.5", NOT_REACHED],
          ["5.7", NOT_REACHED],
          ["6.2", NOT_REACHED],
          ["7.4", NOT_REACHED],
          ["5.9", NOT_REACHED],
          ["7.1", NOT_REACHED],
          ["7.2", NOT_REACHED],
          ["7.3", NOT_REACHED],
          ["8.5", NOT_REACHED],
          ["6.3", NOT_REACHED],
          ...(bundle.format === "abolish-verifier-bundle/5"
            ? ([
                ["5.8", NOT_REACHED],
                ["6.1", NOT_REACHED],
              ] satisfies [string, Outcome][])
            : []),
        ] satisfies [string, Outcome][])
      : []),
  ];
  const stopped = (row: string, outcome: Outcome, hash?: Uint8Array) => ({
    rows: new Map([...boardRows, [row, outcome], ["4.1", NOT_REACHED], ["4.2", NOT_REACHED]]),
    ...(hash !== undefined && { hash }),
  });
  let record;
  try {
    record = decodeDefinition(bundle.definition);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    // A definition version this verifier doesn't know may be one a later
    // release reads, so, like an unknown board-entry version below, it
    // leaves the election unverifiable, never failed: releases must not
    // disagree on a verdict (T-36). Version 0 can't be any release's:
    // `profile-version` forbids pinning it, and the self-pin check requires
    // the record's version to equal its pin. The version byte is offset 2.
    if (e.code === "unknown-version" && e.offset === 2 && bundle.definition[2] !== 0)
      return stopped("2.3", UNSUPPORTED);
    return stopped("2.1", { status: "fail", code: "decode", at: { decodeError: e.code } });
  }
  const definition = record.value;
  const { hash, stubHash, rule, question } = readDefinition(record);
  if (rule !== undefined)
    return stopped(
      "2.1",
      { status: "fail", code: rule, at: question === undefined ? {} : { question } },
      hash,
    );
  // A version this verifier can't read may be one a later release supports,
  // so it leaves the election unverifiable here, never failed (2.3).
  const version = pinnedVersion(definition, RECORD_TYPES.boardEntry);
  if (!isReadable(version)) return stopped("2.3", UNSUPPORTED, hash);
  let combination: Outcome | undefined;
  const pins = profileCombinationRule(definition);
  switch (pins) {
    case undefined:
      break;
    case "profile-combination":
      combination = { status: "fail", code: "profile-combination", at: {} };
      break;
    case "unsupported-version":
      // The board-entry version is one this verifier reads, so another pin is
      // one a later release may know (a ballot, spoiled-ballot opening or
      // contract-event version it doesn't): unverifiable, never failed, so releases agree
      // (T-36). The board checks still run, as for a failing combination.
      combination = UNSUPPORTED;
      break;
    default: {
      const unknown: never = pins;
      throw new Error(`unmapped profile rule ${String(unknown)}`);
    }
  }
  return {
    hash,
    definition: record,
    stubHash,
    ...(combination !== undefined && { profile: combination }),
    inputs: {
      electionId: definition.election_id,
      boardEntryVersion: version,
      l1: { ...bundle.l1, anchor: definition.l1_anchor },
    },
  };
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The board checks' anchors and `now`: given as they are, or read from L1 state. */
function anchoring(
  bundle: Bundle,
  inputs: BoardInputs,
):
  | {
      readonly anchors: readonly Anchor[];
      readonly now: bigint;
      readonly read?: readonly StateAnchor[];
    }
  | L1Error {
  if (!("l1" in inputs)) return { anchors: inputs.anchors, now: inputs.now };
  try {
    const read = anchorsFromState(inputs.l1, inputs.electionId, bundle.entries, bundle.clock);
    return { anchors: read.map((a) => a.anchor), now: inputs.l1.header.timestamp, read };
  } catch (e) {
    if (e instanceof L1Error) return e;
    throw e;
  }
}

/** Runs the board checks and maps them onto 4.1 and 4.2. */
function runBoard(
  bundle: Bundle,
  inputs: BoardInputs,
  anchors: readonly Anchor[],
  now: bigint,
): { board: Report["board"]; outcomes: readonly [Outcome, Outcome] } {
  try {
    const verified = verifyBoard(
      inputs.electionId,
      bundle.entries,
      inputs.boardEntryVersion,
      anchors,
      bundle.clock,
      now,
    );
    return {
      board: {
        entries: bundle.entries.length,
        unreadableBytes: bundle.unreadableBytes,
        unauthenticated: verified.unauthenticated,
      },
      outcomes: [PASS, PASS],
    };
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    return {
      board: { entries: bundle.entries.length, unreadableBytes: bundle.unreadableBytes },
      outcomes: boardOutcomes(e),
    };
  }
}

/**
 * Reads the board copy of a bundle parsed without one from a local block
 * store, gateways over the network, or both, the store asked first for each
 * block, by the CIDs its counted checkpoints name (docs/spec/verifier.md,
 * Board by CID; docs/spec/board.md, A copy from L1's CIDs), within `maxBytes`
 * for the whole copy, and returns the bundle with that copy. The anchors are
 * read as `verifyBundle` reads them, with no copy to match words against, so
 * every anchored word needs its checkpoint in `l1.checkpoints`, as it would
 * from its `CheckpointAnchored` log (T-24). Where the board checks stop
 * before they need a copy, the read doesn't run and the copy stays empty:
 * `verifyBundle` then reports the same stop from the bundle alone. Nothing
 * read here is trusted: `verifyBundle` authenticates every entry against the
 * anchored heads and roots, so a store or a gateway can only leave the copy
 * short (T-49, T-53).
 */
export async function readBoardByCid(
  bundle: Bundle,
  store: BlockStore | undefined,
  maxBytes: number,
  gateways?: Gateways,
): Promise<Bundle> {
  if (bundle.entries.length !== 0 || bundle.unreadableBytes !== 0 || bundle.byCid !== undefined)
    throw new TypeError("the bundle already holds a board copy");
  if (store === undefined && gateways === undefined)
    throw new TypeError("a read by CID needs a store or gateways");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("maxBytes must be a positive integer");
  // Taken once the read is over, so the gateways' counts cover all of it.
  const read = () => ({
    ...(store !== undefined && {
      storeBlocks: store.blocks,
      storeUnreadableBytes: store.unreadableBytes,
    }),
    ...(gateways !== undefined && { gateways: gateways.stats() }),
  });
  const notReached = () =>
    ({ ...bundle, byCid: { ...read(), stopped: { reason: "not-reached" } } }) as const;
  const definition = fromDefinition(bundle);
  if ("rows" in definition) return notReached();
  const input = anchoring(bundle, definition.inputs);
  if (input instanceof L1Error) return notReached();
  // The store first: a block it holds costs no request, and tells no gateway
  // what is being read (T-11).
  const source: AsyncBlockSource = async (cid, limit) => {
    const held = store === undefined ? [] : await store.source(cid, limit);
    return held.length !== 0 || gateways === undefined ? held : gateways.source(cid, limit);
  };
  let copy;
  try {
    copy = await readBoardCopy(
      definition.inputs.electionId,
      input.anchors,
      bundle.clock,
      input.now,
      source,
      maxBytes,
    );
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    return notReached();
  }
  return {
    ...bundle,
    entries: copy.encodedEntries,
    byCid: { ...read(), ...(copy.stopped !== undefined && { stopped: copy.stopped }) },
  };
}

/** Runs every check over one bundle and reports it (docs/spec/verifier.md, Report). */
export function verifyBundle(bundle: Bundle): Report {
  const definition = fromDefinition(bundle);
  const unsplit = { entries: bundle.entries.length, unreadableBytes: bundle.unreadableBytes };
  let board: Report["board"] = unsplit;
  let input: ReturnType<typeof anchoring> | undefined;
  let implemented: ReadonlyMap<string, Outcome>;
  let ceremony: CeremonyReport | undefined;
  let ballots: BallotsReport | undefined;
  let openings: readonly OpeningReport[] | undefined;
  let tallies: readonly TallyReport[] | undefined;
  let counted: CountedResult | undefined;
  let releases: ReleasesReport | undefined;
  if ("rows" in definition) implemented = definition.rows;
  else {
    input = anchoring(bundle, definition.inputs);
    let outcomes: readonly [Outcome, Outcome];
    if (input instanceof L1Error) {
      // Words that can't be read leave the board checks without anchors:
      // never a failure, since no one but L1 itself can settle them (T-53).
      outcomes = [
        NOT_REACHED,
        {
          status: "unverifiable",
          code: input.code,
          at: input.segment === undefined ? {} : { segment: input.segment },
        },
      ];
    } else ({ board, outcomes } = runBoard(bundle, definition.inputs, input.anchors, input.now));
    implemented = new Map([
      ["4.1", outcomes[0]],
      ["4.2", outcomes[1]],
      // A failing combination doesn't stop the checks: the pinned version is
      // one this verifier reads, so the report still shows what the board holds.
      ...(definition.profile !== undefined ? [["2.3", definition.profile] as const] : []),
      // Definition versions 1 and 3 list no receipt keys, so 2.9 has nothing
      // to check; version 4's and 5's keys are judged by the anchor's record,
      // read from L1 state whatever the board checks found. Formats 1 and 2 carry
      // no definition, so 2.9 stays unverifiable there, never a pass.
      ...(definition.definition === undefined
        ? []
        : [
            [
              "2.9",
              definition.definition.version === 1 || definition.definition.version === 3
                ? PASS
                : "l1" in definition.inputs
                  ? receiptKeyRow(
                      definition.inputs.l1,
                      definition.definition.value.receipt_keys,
                      definition.definition.value.opens_at,
                    )
                  : // Never a pass without the record: every definition-bearing
                    // format carries L1 evidence today.
                    NOT_IMPLEMENTED,
            ] as const,
          ]),
      // A contract-event record is judged from its own bytes and the
      // definition's L2 contracts, whatever 4.1 and 4.2 found, but fails 4.4
      // only inside the extent they authenticated (docs/spec/verifier.md,
      // Contract events; T-53).
      ...(definition.definition === undefined
        ? []
        : [
            [
              "4.4",
              eventChecks(
                definition.definition,
                bundle.entries,
                definition.inputs.boardEntryVersion,
                // Set only when 4.1 and 4.2 pass: the anchored extent.
                board.unauthenticated === undefined
                  ? undefined
                  : board.entries - board.unauthenticated,
                // Format 5's run decides whether an L1 origin is a finalized block.
                bundle.format === "abolish-verifier-bundle/5" ? bundle.l1Blocks : undefined,
              ),
            ] as const,
          ]),
      ...(carriesDestruction(definition.inputs.boardEntryVersion)
        ? []
        : [["8.5", NOT_APPLICABLE] as const]),
      ...(definition.definition === undefined
        ? []
        : (["7.5", "7.6"] as const).map(
            (id) => [id, releaseGate(definition.definition as VerifiedDefinition)] as const,
          )),
      // 1.3 also covers the keys inside the verifier contracts the election
      // uses, which aren't read yet: it can fail here, never pass. Only
      // ballot versions 1 to 4's key (one key: a version-2 to version-4
      // ballot proves membership of its cell's tree under it) is pinned here; a version
      // this verifier doesn't read may have a key a later release pins, so
      // releases agree (T-36).
      ...(definition.definition !== undefined &&
      provedUnderPinnedKey(definition.definition.value) &&
      !equal(definition.definition.value.membership_vk_hash, membershipVkHash())
        ? [["1.3", { status: "fail", code: "membership-key", at: {} }] as const]
        : []),
    ]);
    // The transcript's bytes are authenticated by the definition's hash of
    // them, not by the board checks, so they run whatever 4.1 and 4.2 found.
    if (
      (bundle.format === "abolish-verifier-bundle/4" ||
        bundle.format === "abolish-verifier-bundle/5") &&
      definition.definition !== undefined &&
      definition.hash !== undefined &&
      definition.stubHash !== undefined
    ) {
      const checked = ceremonyChecks(
        definition.definition.value,
        definition.stubHash,
        bundle.panel,
        authorRunOf(definition.definition),
        bundle.entries,
        definition.inputs.boardEntryVersion,
      );
      implemented = new Map([...implemented, ...checked.rows]);
      ceremony = checked.report;
      // Admission is judged per entry from the record's own bytes, so, like
      // the transcript, it runs whatever 4.1 and 4.2 found: the verdict
      // rests on them anyway (docs/spec/verifier.md, Ballot admission).
      const admission = ballotChecks(
        definition.definition,
        checked.registered,
        checked.authorRegistered,
        bundle.entries,
        definition.inputs.boardEntryVersion,
        bundle.clock,
        bundle.format === "abolish-verifier-bundle/5" ? bundle.l1Blocks : undefined,
      );
      implemented = new Map<string, Outcome>([...implemented, ...admission.rows]);
      ballots = admission.report;
      // Selection is decided over the counted extent alone, so it needs what
      // admission doesn't: the anchored extent, the seal and 4.4
      // (docs/spec/verifier.md, Selection).
      const chosen = selectionCheck({
        admissionSettled: admissionSettled(admission.rows),
        candidates: admission.candidates,
        ordinary: admission.ordinary ?? [],
        // Set only when 4.1 and 4.2 pass.
        extent:
          board.unauthenticated === undefined ? undefined : board.entries - board.unauthenticated,
        eventsPass: implemented.get("4.4")?.status === "pass",
        clock: bundle.clock,
        now: input === undefined || input instanceof L1Error ? undefined : input.now,
        floor: countedFloor(definition.definition.value.closes_at, bundle.clock),
      });
      implemented = new Map<string, Outcome>([...implemented, ["6.1", chosen.row]]);
      if (ballots !== undefined && chosen.report !== undefined)
        ballots = { ...ballots, ...chosen.report };
      // The counted set is selection's ballots less those delivery (5.9)
      // excludes, so it, the tally checks and 8.5 wait on 6.1's pass, which
      // also fixes the sealed, anchored board they read (docs/spec/
      // verifier.md, Counted set and tally).
      const destructionApplies = carriesDestruction(definition.inputs.boardEntryVersion);
      const extent =
        board.unauthenticated === undefined ? undefined : board.entries - board.unauthenticated;
      if (
        chosen.report === undefined ||
        checked.registered === undefined ||
        extent === undefined ||
        admission.candidates === undefined
      )
        counted = countedRows(
          { status: "unverifiable", code: "not-reached", at: {} },
          destructionApplies,
        );
      else {
        const byEntry = new Map(admission.candidates.map((c) => [c.entry, c]));
        counted = countedChecks({
          definition: definition.definition,
          definitionHash: definition.hash,
          registered: checked.registered,
          ...(checked.authorRegistered !== undefined && {
            authorRegistered: checked.authorRegistered,
          }),
          selected: chosen.report.selected.map(({ entry }) => {
            const tally = byEntry.get(entry)?.tally;
            if (tally === undefined)
              throw new Error("verifyBundle: a selected ballot wasn't admitted");
            return { entry, tally };
          }),
          entries: bundle.entries,
          boardEntryVersion: definition.inputs.boardEntryVersion,
          extent,
          eventsPass: implemented.get("4.4")?.status === "pass",
          clock: bundle.clock,
          destruction: destructionApplies,
          // The close check compares the counted extent's admitted ballots,
          // and 6.1's pass put every admitted ballot of the anchored extent
          // there.
          admitted: admission.candidates.filter((c) => c.entry < extent),
          blocks: bundle.format === "abolish-verifier-bundle/5" ? bundle.l1Blocks : undefined,
        });
      }
      implemented = new Map<string, Outcome>([...implemented, ...counted.rows]);
      // Under a live definition pinning tally-opening version 2, the
      // releases are read once 7.1 passed: the board is then sealed and
      // authenticated, and every snapshot fixed (docs/spec/verifier.md,
      // Releases, step 1).
      if (
        // 7.1 passes only where 6.1 did, which needs 5.8 and so format 5.
        bundle.format === "abolish-verifier-bundle/5" &&
        isLive(definition.definition) &&
        implemented.get("7.5")?.code === "not-reached" &&
        implemented.get("7.1")?.status === "pass" &&
        chosen.report !== undefined &&
        checked.registered !== undefined &&
        extent !== undefined &&
        admission.candidates !== undefined &&
        admission.live !== undefined &&
        counted.delivery !== undefined
      ) {
        const byEntry = new Map(admission.candidates.map((c) => [c.entry, c]));
        const excluded = new Set(counted.delivery.excluded.map((x) => x.entry));
        const countedSets = cellTiers(definition.definition).map(() => new Set<string>());
        for (const { entry } of chosen.report.selected) {
          const c = byEntry.get(entry);
          if (c?.tally === undefined)
            throw new Error("verifyBundle: a selected ballot wasn't admitted");
          if (!excluded.has(entry)) countedSets[c.tally.cell]?.add(bytesToHex(c.ballot.message));
        }
        const live = releaseChecks({
          definition: definition.definition,
          definitionHash: definition.hash,
          registered: checked.registered,
          copies: admission.live,
          entries: bundle.entries,
          boardEntryVersion: definition.inputs.boardEntryVersion,
          extent,
          clock: bundle.clock,
          blocks: bundle.l1Blocks,
          counted: countedSets,
        });
        implemented = new Map<string, Outcome>([...implemented, ...live.rows]);
        releases = live.report;
      }
      // Sorting and attribution need only the definition and the registered
      // signing keys, so 7.4 runs wherever 3.2 passed, under definition
      // versions 3 to 6 against their cells, beside an author panel per panel
      // with its own key set (docs/spec/verifier.md, Tally openings); the
      // counted set, once known, settles the rest, `tally-early` included.
      const opened = tallyChecks(
        definition.definition,
        definition.hash,
        checked.registered,
        checked.authorRegistered,
        bundle.entries,
        definition.inputs.boardEntryVersion,
        counted.tallyBreaks === undefined || extent === undefined
          ? undefined
          : {
              extent,
              breaks: counted.tallyBreaks,
              ...(counted.tallyEarly !== undefined && { early: counted.tallyEarly }),
            },
      );
      implemented = new Map<string, Outcome>([...implemented, ["7.4", opened.row]]);
      tallies = opened.report;
      // An opening is checked against the same registered election, and
      // `opening-cast` against the ballots admission admitted, so 6.2 is
      // reached exactly where admission is.
      const spoiled = openingChecks(
        definition.definition,
        checked.registered,
        checked.authorRegistered,
        admission.admitted,
        bundle.entries,
        definition.inputs.boardEntryVersion,
        bundle.clock,
      );
      implemented = new Map<string, Outcome>([...implemented, ["6.2", spoiled.row]]);
      openings = spoiled.report;
    }
  }
  const checks = CHECKS.map((c): CheckResult => ({
    id: c.id,
    kind: c.kind,
    ...(implemented.get(c.id) ?? { status: "unverifiable", code: "not-implemented" }),
  }));
  const verdictAgainstInputs = judge(checks);
  const sources = Object.values(bundle.sources) as InputSource[];
  return {
    format: REPORT_FORMAT,
    verdict: sources.every(authenticated) ? verdictAgainstInputs : "unverifiable",
    verdictAgainstInputs,
    inputs: { ...bundle.sources },
    ...(definition.hash !== undefined && { definition: { hash: bytesToHex(definition.hash) } }),
    ...(ceremony !== undefined && { ceremony }),
    ...(ballots !== undefined && { ballots }),
    ...(openings !== undefined && { openings }),
    ...(tallies !== undefined && { tallies }),
    ...(counted?.delivery !== undefined && { delivery: counted.delivery }),
    ...(counted?.cells !== undefined && { cells: counted.cells }),
    ...(counted?.tiers !== undefined && { tiers: counted.tiers }),
    ...(counted?.questions !== undefined && { questions: counted.questions }),
    ...(counted?.destruction !== undefined && { destruction: counted.destruction }),
    ...(counted?.close !== undefined && { close: counted.close }),
    ...(releases !== undefined && { releases }),
    board: bundle.byCid === undefined ? board : { ...board, byCid: bundle.byCid },
    ...(bundle.format !== "abolish-verifier-bundle/1" && {
      l1: {
        blockHash: bytesToHex(bundle.l1.header.hash),
        blockNumber: bundle.l1.header.number.toString(),
        timestamp: bundle.l1.header.timestamp.toString(),
        ...(input !== undefined &&
          !(input instanceof L1Error) &&
          input.read !== undefined && {
            anchors: input.read.map((a) => ({
              segment: a.anchor.checkpoint.segment,
              hash: bytesToHex(a.hash),
              source: a.source,
            })),
          }),
      },
    }),
    checks,
  };
}

/**
 * Whether a receipt's ballot was dropped, as `Report` has `verdict` and
 * `verdictAgainstInputs`: `dropAgainstInputs` is what the rule found against
 * the bundle's inputs, and `drop` is it only where every input authenticates,
 * otherwise `inputs-unauthenticated`, so a crafted bundle can neither make
 * nor clear a drop (T-53, T-24).
 */
export interface DropReport {
  readonly drop: DropOutcome;
  readonly dropAgainstInputs: DropOutcome;
}

/**
 * Whether the ballot a receipt covers was dropped from the board this bundle
 * holds (docs/spec/receipts.md, Drops), given the receipt, its payload and
 * the verdict `judgeReceipt` reached for it. The payload is judged as
 * `verifyBundle` judges the board's ballots, against the same registered key
 * sets and, for format 5, its run of L1 headers, and the board's admitted
 * ballots are read only once selection (6.1) has passed over the sealed,
 * anchored copy: otherwise the outcome is `unjudged`, never a drop. Throws a
 * `DecodeError` for a receipt that doesn't decode, and a `RangeError` for one
 * of another election or whose entry hash isn't the payload's: an
 * `unanchored` or `forked` verdict passed the checks at cast, which bind the
 * receipt to both, so the verdict isn't this receipt and payload's.
 */
export function judgeDrop(
  bundle: Bundle,
  receipt: Uint8Array,
  payload: Uint8Array,
  verdict: ReceiptVerdict,
): DropReport {
  const report = (outcome: DropOutcome, authenticates: boolean): DropReport => ({
    drop: authenticates ? outcome : { status: "unjudged", code: "inputs-unauthenticated" },
    dropAgainstInputs: outcome,
  });
  if (verdict.verdict !== "unanchored" && verdict.verdict !== "forked")
    return report({ status: "not-drop", code: "not-alarm" }, true);
  const r = decodeReceipt(receipt);
  const sources = Object.values(bundle.sources) as InputSource[];
  const authenticates = sources.every(authenticated);
  const definition = fromDefinition(bundle);
  if (
    "rows" in definition ||
    definition.definition === undefined ||
    definition.stubHash === undefined ||
    (bundle.format !== "abolish-verifier-bundle/4" && bundle.format !== "abolish-verifier-bundle/5")
  )
    return report({ status: "unjudged", code: "not-reached" }, authenticates);
  const d = definition.definition;
  const { boardEntryVersion } = definition.inputs;
  if (!equal(r.election_id, d.value.election_id))
    throw new RangeError("judgeDrop: the receipt names another election");
  // The checks at cast's `receipt-entry`: the payload is the one the
  // receipt covers, so no other ballot can be called the dropped one, and
  // the segment the close rule reads is that entry's.
  let entry;
  try {
    entry = encodeBoardEntry(
      { election_id: r.election_id, index: r.index, segment: r.segment, payload },
      boardEntryVersion,
    );
  } catch (e) {
    if (!(e instanceof EncodeError)) throw e;
    throw new RangeError("judgeDrop: no board entry can carry the payload");
  }
  if (!equal(boardEntryHash(entry), r.entry_hash))
    throw new RangeError("judgeDrop: the receipt doesn't cover the payload");
  // Under a contract-event version this release doesn't read, 5.5 and 5.8
  // are unsupported for the board's ballots, so they are for this one too:
  // releases agree (T-36).
  if (!readsEvents(pinnedVersion(d.value, RECORD_TYPES.contractEvent)))
    return report({ status: "unjudged", code: "unsupported-version" }, authenticates);
  const checked = ceremonyChecks(
    d.value,
    definition.stubHash,
    bundle.panel,
    authorRunOf(d),
    bundle.entries,
    boardEntryVersion,
  );
  const blocks = bundle.format === "abolish-verifier-bundle/5" ? bundle.l1Blocks : undefined;
  return report(
    judgeDropRule({
      verdict,
      segment: r.segment,
      payload,
      judge: judgeFor(d, checked.registered, checked.authorRegistered),
      references:
        blocks === undefined
          ? undefined
          : referenceJudge(blocks, d.value.opens_at, d.value.closes_at),
      lastBoardSegment: countedFloor(d.value.closes_at, bundle.clock),
      admitted: anchoredAdmitted(bundle, d, definition.inputs, checked),
    }),
    authenticates,
  );
}

/** The admitted ballots of the anchored extent, once 6.1 passes over the bundle's copy, as `verifyBundle` decides it. */
export function anchoredAdmitted(
  bundle: Bundle,
  definition: VerifiedDefinition,
  inputs: BoardInputs,
  checked: ReturnType<typeof ceremonyChecks>,
): readonly CountedCandidate[] | undefined {
  const input = anchoring(bundle, inputs);
  if (input instanceof L1Error) return undefined;
  const { board, outcomes } = runBoard(bundle, inputs, input.anchors, input.now);
  if (outcomes.some((o) => o.status !== "pass") || board.unauthenticated === undefined)
    return undefined;
  const extent = board.entries - board.unauthenticated;
  // Typed as a row, as `verifyBundle` reads 4.4: it can't pass in this
  // release, and selection waits on its pass wherever an ordinary ballot is.
  const events: Outcome = eventChecks(
    definition,
    bundle.entries,
    inputs.boardEntryVersion,
    extent,
    bundle.format === "abolish-verifier-bundle/5" ? bundle.l1Blocks : undefined,
  );
  const admission = ballotChecks(
    definition,
    checked.registered,
    checked.authorRegistered,
    bundle.entries,
    inputs.boardEntryVersion,
    bundle.clock,
    bundle.format === "abolish-verifier-bundle/5" ? bundle.l1Blocks : undefined,
  );
  const chosen = selectionCheck({
    admissionSettled: admissionSettled(admission.rows),
    candidates: admission.candidates,
    ordinary: admission.ordinary ?? [],
    extent,
    eventsPass: events.status === "pass",
    clock: bundle.clock,
    now: input.now,
    floor: countedFloor(definition.value.closes_at, bundle.clock),
  });
  if (chosen.row.status !== "pass" || admission.candidates === undefined) return undefined;
  return admission.candidates.filter((c) => c.entry < extent);
}
