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
// 4.4 but never pass it, and, for a run that read the archive
// (`readArchive`), 4.3, which can pass but never fail, and, under a
// rolling definition, admission, selection, the spoiled-ballot openings and,
// without an author panel, delivery, the counted set and the tally openings
// against the chain from the archive's replay once the release pins the registries
// (rolling-chain.ts);
// every other check is reported unverifiable, so no run can report an
// election verified yet. A run on unauthenticated inputs reports
// what the checks found against them, but its verdict stays unverifiable, so
// a crafted bundle can neither verify nor fail an election (T-53, T-24).

import {
  type Anchor,
  type AsyncBlockSource,
  BoardError,
  type ContractRole,
  type BoardEntryVersion,
  countedCheckpoints,
  boardPayloadTypes,
  type BoardErrorAt,
  type BoardErrorCode,
  boardEntryHash,
  DecodeError,
  type DecodeErrorCode,
  decodeReceipt,
  type ElectionDefinitionV7Rule,
  encodeBoardEntry,
  EncodeError,
  membershipVkHash,
  pinnedVersion,
  profileCombinationRule,
  readBoardCopy,
  type ReceiptVerdict,
  RECORD_TYPES,
  RESULTS_MODES,
  type RollingBallotChain,
  SEAT_PANELS,
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
  restsOnChain,
  unprovenRoots,
  type WindowCode,
} from "./ballots.ts";
import { earlierLocators } from "./anchor-logs.ts";
import { type DropOutcome, judgeDropRule } from "./drops.ts";
import { type L1RefCode, referenceJudge } from "./references.ts";
import type { BlockStore } from "./blocks.ts";
import type { Gateways } from "./gateways.ts";
import {
  availabilityChecks,
  type AvailabilityEvidenceCode,
  type AvailabilityReport,
} from "./availability.ts";
import {
  type ArchiveFinding,
  DEFAULT_MANIFEST_BUDGET,
  DEFAULT_OBJECT_READS,
  type ListedFinding,
  listedTargets,
  readListedObjects,
  type TransactionSource,
  walkArchive,
} from "./archive.ts";
import { DEFAULT_EVIDENCE_READS, latestEvidence } from "./evidence.ts";
import { type ContractReplay, DEFAULT_REPLAY_EVIDENCE_READS, replayArchive } from "./replay.ts";
import { DEFAULT_RUN_BYTES, DEFAULT_RUN_READS } from "./runs.ts";
import type { ArchiveRead, Bundle, CidRead, InputSource, InputSources } from "./bundle.ts";
import { type CeremonyCode, ceremonyChecks, type CeremonyReport } from "./ceremony.ts";
import { CHECKS, type CheckKind } from "./checks.ts";
import {
  authorRunOf,
  decodeDefinition,
  isReadable,
  isRolling,
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
import { PINNED_PANELS, type PinnedPanel, pinnedOurs } from "./panels.ts";
import { archivedChain, PINNED_REGISTRIES, type RollingChainRelease } from "./rolling-chain.ts";
import type { ReleaseRowCode } from "./releases.ts";
import {
  anchorsFromState,
  latestLocatorFromState,
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
  | ElectionDefinitionV7Rule
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
  | AvailabilityEvidenceCode
  | ArchiveFinding["code"]
  | ListedFinding["code"]
  | "locator-none"
  | "anchor-logs"
  | "anchor-logs-missing"
  | "unavailable"
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
  /** 2.1's first failing question under definition versions 5 to 7. */
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
  /** 4.6's first point and panel that doesn't hold (1 the ballot extent; 1 the default panel, 2 the author panel). */
  | { readonly point: number; readonly panel: number }
  /** 4.4's first contract, by role, whose archive leaves it unverifiable. */
  | { readonly contract: ContractRole }
  /** 4.6's first board event, by its position in the bundle's `l2Board.events`, that doesn't decode. */
  | { readonly event: number; readonly decodeError?: DecodeErrorCode }
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
  /** Under definition versions 5 to 7, beside `cells`, each question's limits and method (8.1). */
  readonly questions?: readonly QuestionReport[];
  /** A format-5 bundle's destruction report, once 8.5 ran. */
  readonly destruction?: DestructionReport;
  /** A format-5 bundle's close check, once 6.3 found `L_δ`. */
  readonly close?: CloseReport;
  /** A format-5 bundle's releases under a live definition, once 7.5 fixed its snapshots. */
  readonly releases?: ReleasesReport;
  /** A format-6 bundle's availability check, once the board's accumulator replayed (4.6). */
  readonly availability?: AvailabilityReport;
  /** A format-3 to 6 bundle's archive read, once the run read the archive (4.3). */
  readonly archive?: Plain<ReportedArchive>;
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

/** A value as the report's JSON gives it: bytes as hex, integers as decimal strings. */
export type Plain<T> = T extends Uint8Array
  ? string
  : T extends bigint
    ? string
    : T extends readonly (infer U)[]
      ? readonly Plain<U>[]
      : T extends object
        ? { readonly [K in keyof T]: Plain<T[K]> }
        : T;

function plain<T>(x: T): Plain<T>;
function plain(x: unknown): unknown {
  if (x instanceof Uint8Array) return bytesToHex(x);
  if (typeof x === "bigint") return x.toString();
  if (Array.isArray(x)) return x.map(plain);
  if (typeof x === "object" && x !== null)
    return Object.fromEntries(
      Object.entries(x)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, plain(v)]),
    );
  return x;
}

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
  // A live rolling poll's running copies aren't read yet (P2-17 part
  // 4d-2b-2b-2b-2b-2), so its releases can't pass, as a live poll's can't before
  // 7.1 (T-16, T-45).
  if (definition.version === 7 && isRolling(definition))
    return definition.value.results_mode === RESULTS_MODES.live ? NOT_REACHED : PASS;
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

/** Whether the definition's ballots are proved under the one membership key this release pins (ballot versions 1 to 5). */
function provedUnderPinnedKey(d: VerifiedDefinition["value"]): boolean {
  const pinned = pinnedVersion(d, RECORD_TYPES.ballot);
  return pinned === 1 || pinned === 2 || pinned === 3 || pinned === 4 || pinned === 5;
}

/**
 * A format-3, 4 or 5 bundle's definition (docs/spec/verifier.md, Definition): its
 * decoding and well-formedness, which are part of 2.1, the board-entry
 * version its profile pins, and the board checks' inputs taken from it. Any
 * other format gives them as they are. A rolling definition whose profile
 * fits goes on only with its chain from the bundle's archive under
 * `registries` (Electorate, The rolling chain), except `forArchive`, where
 * the archive is yet to be read and only the deployment is wanted.
 */
function fromDefinition(
  bundle: Bundle,
  pins: readonly PinnedPanel[] = PINNED_PANELS,
  registries: RollingChainRelease | undefined = PINNED_REGISTRIES,
  forArchive = false,
):
  | {
      readonly inputs: BoardInputs;
      readonly hash?: Uint8Array;
      readonly definition?: VerifiedDefinition;
      readonly stubHash?: Uint8Array;
      /** 2.3's row when the profile's versions don't fit together, or pin one this verifier doesn't know. */
      readonly profile?: Outcome;
      /** A rolling definition's chain, from the archive's replay. */
      readonly rolling?: RollingBallotChain;
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
    ...("panel" in bundle
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
          ...("l1Blocks" in bundle
            ? ([
                ["5.8", NOT_REACHED],
                ["6.1", NOT_REACHED],
              ] satisfies [string, Outcome][])
            : []),
          ...("l2Board" in bundle ? ([["4.6", NOT_REACHED]] satisfies [string, Outcome][]) : []),
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
  // The live restriction counts the seats the release pins as ours on the
  // definition's default panel (docs/spec/verifier.md, 2.3; T-16, T-45).
  // A rolling profile that fits is read as fitting here, and goes on below
  // only with its chain.
  const combinationRule = profileCombinationRule(
    definition,
    pinnedOurs(bytesToHex(definition.panel_id), definition.panel_size, pins),
    isRolling(record),
  );
  switch (combinationRule) {
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
      const unknown: never = combinationRule;
      throw new Error(`unmapped profile rule ${String(unknown)}`);
    }
  }
  // A rolling electorate's roots are its steps', which 5.1 and 5.2 read
  // from the chain 2.4's rolling replay of the archive gives, under the
  // registries the release pins. Without it a later release may verify the
  // poll, so a profile that fits is unverifiable, never failed, and the
  // board checks have no election to run for (P2-17 part 4d-2b; T-36). One
  // that doesn't fit fails 2.3 under every release, as any other
  // definition's does, and one pinning a version this verifier doesn't know
  // is a later release's.
  let rolling: RollingBallotChain | undefined;
  if (record.version === 7 && isRolling(record)) {
    if (combination !== undefined) return stopped("2.3", combination, hash);
    const replay = archivedEvents(bundle);
    if (!forArchive) {
      rolling =
        registries === undefined || replay === undefined
          ? undefined
          : archivedChain(record, replay, registries);
      if (rolling === undefined) return stopped("2.3", UNSUPPORTED, hash);
    }
  }
  return {
    hash,
    definition: record,
    stubHash,
    ...(combination !== undefined && { profile: combination }),
    ...(rolling !== undefined && { rolling }),
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

/** The archive read as the report gives it: each replay without the events it read. */
export type ReportedArchive =
  | Extract<ArchiveRead, { readonly stopped: unknown }>
  | (Omit<Extract<ArchiveRead, { readonly walk: unknown }>, "replay"> & {
      readonly replay?: {
        readonly contracts: readonly ContractReplay[];
        readonly findings: readonly Extract<ArchiveFinding, { code: "evidence-over-budget" }>[];
      };
    });

// 4.4's replay of the archive, where the run read one.
const archivedEvents = (bundle: Bundle) =>
  bundle.archive !== undefined && "walk" in bundle.archive ? bundle.archive.replay : undefined;

// The board's events from 4.4's replay of its runs, which 4.6 may take.
const boardRecords = (bundle: Bundle) =>
  archivedEvents(bundle)?.contracts.find((c) => c.role === "board")?.records;

function reportedArchive(read: ArchiveRead): ReportedArchive {
  if (!("walk" in read) || read.replay === undefined) return read;
  const contracts = read.replay.contracts.map(
    ({ role, contract, evidence, runs, held }): ContractReplay => ({
      role,
      contract,
      evidence,
      runs,
      held,
    }),
  );
  return { ...read, replay: { ...read.replay, contracts } };
}

/** The archive read's budgets (docs/spec/archive.md; T-52). */
export interface ArchiveReadOptions {
  /** Manifest reads; default `DEFAULT_MANIFEST_BUDGET`. */
  readonly maxManifests?: number;
  /** Bytes the listed objects' answers may cost; default 1 GiB. */
  readonly maxBytes?: number;
  /** Transactions the listed objects' reads may ask; default `DEFAULT_OBJECT_READS`. */
  readonly maxReads?: number;
  /** Transactions the board's evidence reads may ask (format 6); default `DEFAULT_EVIDENCE_READS`. */
  readonly maxEvidenceReads?: number;
  /** Transactions 4.4's replay may ask for evidence; default `DEFAULT_REPLAY_EVIDENCE_READS`. */
  readonly maxReplayEvidenceReads?: number;
  /** Bytes 4.4's replay may hold of runs; default `DEFAULT_RUN_BYTES`. */
  readonly maxRunBytes?: number;
  /** Transactions 4.4's replay may ask for runs; default `DEFAULT_RUN_READS`. */
  readonly maxRunReads?: number;
}

/** The listed objects' byte budget when the caller sets none: 1 GiB, as a copy's (T-52). */
export const DEFAULT_ARCHIVE_BYTES = 2 ** 30;

/**
 * Reads the permanent archive for a format-3 to 6 bundle (docs/spec/
 * verifier.md, Archive; 4.3): the latest locator from the board anchor's
 * state, proven under the bundle's L1 header at the definition's anchor;
 * the chain of manifests from it (`walkArchive`, under the definition's
 * `l1_chain_id` and anchor); and, where the board checks' steps 1 and 2 fix
 * the counted checkpoints, the objects they name (`readListedObjects`).
 * The objects are read only after a walk that reached the latest
 * locator's manifest within its budget, since an unread manifest may list
 * any object. Returns the bundle with how the read came out, which `verifyBundle`
 * reports as 4.3's row and the report's `archive`, and the objects' blocks,
 * which `readBoardByCid` asks beside its other sources.
 *
 * The anchors are read as `verifyBundle` reads them: from the copy where the
 * bundle holds one, else every anchored word needs its checkpoint in
 * `l1.checkpoints`. Nothing read here is trusted beyond being the bytes its
 * CID names: a source or the archive's authority can leave the archive
 * short, which 4.3 reports, never change what the board checks judge
 * (T-49, T-51, T-53).
 */
export async function readArchive(
  bundle: Bundle,
  source: TransactionSource,
  options: ArchiveReadOptions = {},
): Promise<{ readonly bundle: Bundle; readonly blocks: AsyncBlockSource }> {
  if (
    bundle.format === "abolish-verifier-bundle/1" ||
    bundle.format === "abolish-verifier-bundle/2"
  )
    throw new TypeError("the archive is read for a definition's deployment: format 3 or later");
  if (bundle.archive !== undefined) throw new TypeError("the bundle's archive was already read");
  const maxManifests = options.maxManifests ?? DEFAULT_MANIFEST_BUDGET;
  const maxBytes = options.maxBytes ?? DEFAULT_ARCHIVE_BYTES;
  const maxReads = options.maxReads ?? DEFAULT_OBJECT_READS;
  const maxEvidenceReads = options.maxEvidenceReads ?? DEFAULT_EVIDENCE_READS;
  const replayBudgets = {
    maxEvidenceReads: options.maxReplayEvidenceReads ?? DEFAULT_REPLAY_EVIDENCE_READS,
    maxRunBytes: options.maxRunBytes ?? DEFAULT_RUN_BYTES,
    maxRunReads: options.maxRunReads ?? DEFAULT_RUN_READS,
  };
  // Checked before anything is read, whatever the bundle holds.
  for (const [name, value] of [
    ["maxManifests", maxManifests],
    ["maxBytes", maxBytes],
    ["maxReads", maxReads],
    ["maxEvidenceReads", maxEvidenceReads],
    ["maxReplayEvidenceReads", replayBudgets.maxEvidenceReads],
    ["maxRunBytes", replayBudgets.maxRunBytes],
    ["maxRunReads", replayBudgets.maxRunReads],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`${name} must be a positive integer`);
  const none: AsyncBlockSource = async () => [];
  const done = (archive: ArchiveRead, blocks = none) => ({
    bundle: { ...bundle, archive },
    blocks,
  });
  const definition = fromDefinition(bundle, PINNED_PANELS, undefined, true);
  // No definition to name the deployment, so no anchor and no chain.
  if ("rows" in definition || definition.definition === undefined || !("l1" in definition.inputs))
    return done({ stopped: "not-reached" });
  const d = definition.definition.value;
  let state;
  try {
    state = latestLocatorFromState(definition.inputs.l1);
  } catch (e) {
    if (!(e instanceof L1Error)) throw e;
    return done({ stopped: e.code });
  }
  if (state.kind === "none") return done({ stopped: "locator-none", count: state.count });
  // The earlier locators, from the anchor's logs where the bundle carries
  // them, proven against its accumulator at `B`, or nothing is read: an
  // earlier locator taken from logs that don't hold up could be anyone's.
  let earlier: readonly Uint8Array[] | undefined;
  if (bundle.anchorLogs !== undefined && state.kind === "locator") {
    let logged;
    try {
      logged = earlierLocators(definition.inputs.l1, d.l1_chain_id, bundle.anchorLogs, state);
    } catch (e) {
      if (!(e instanceof L1Error)) throw e;
      return done({ stopped: e.code });
    }
    if ("rule" in logged) return done({ stopped: "anchor-logs", rule: logged.rule });
    earlier = logged.locators;
  }
  // The counted checkpoints name the objects; where the anchors or steps 1
  // and 2 stop the board checks, there are none to look for.
  let targets;
  const input = anchoring(bundle, definition.inputs);
  if (!(input instanceof L1Error))
    try {
      targets = listedTargets(
        countedCheckpoints(d.election_id, input.anchors, bundle.clock, input.now),
      );
    } catch (e) {
      if (!(e instanceof BoardError)) throw e;
    }
  const walk =
    state.kind === "locator"
      ? await walkArchive(
          state.locator,
          { l1ChainId: d.l1_chain_id, anchor: d.l1_anchor },
          source,
          {
            maxManifests,
            ...(earlier !== undefined && { earlier }),
            ...(targets !== undefined && { objects: targets.map((t) => t.cid) }),
            // 4.4 replays every one of the definition's L2 contracts, and
            // format 6's 4.6 the board's, so their evidence and runs are
            // kept (step 5).
            contracts: [d.election_registry, d.trustee_registry, d.group_registry, d.board],
          },
        )
      : // A length word no locator has: reported as the anchor's framing
        // refuses it, and nothing is read (docs/spec/archive.md, step 1).
        {
          latest: undefined,
          manifests: [],
          listings: new Map<string, readonly Uint8Array[]>(),
          evidence: [],
          runs: [],
          findings: [{ code: "locator-framing", locator: "latest" } as const],
          reads: 0,
        };
  // The listings are known only from a chain read from the latest's manifest
  // within the budget: a manifest the walk didn't read may list any object,
  // so none is called `not-archived` from a partial walk (T-52).
  const whole = walk.latest !== undefined && !walk.findings.some((f) => f.code === "over-budget");
  const objects =
    targets === undefined || !whole
      ? undefined
      : await readListedObjects(targets, walk.listings, source, maxBytes, maxReads);
  // 4.4's replay of every contract's archive, from a partial walk's
  // listings too: a run or record a manifest left unread costs only a gap.
  const replay =
    state.kind === "locator"
      ? await replayArchive(
          walk,
          {
            "election-registry": d.election_registry,
            "trustee-registry": d.trustee_registry,
            "group-registry": d.group_registry,
            board: d.board,
          },
          d.l2_chain_id,
          source,
          replayBudgets,
        )
      : undefined;
  // The evidence is 4.6's, never 4.3's: its budget's report is kept apart
  // from the walk's, or a long evidence list would make 4.3 unverifiable.
  // A partial walk's listings are read too: a record is held to its proof,
  // not to being the latest, so a manifest left unread costs only a later one.
  const evidence =
    "l2Board" in bundle && state.kind === "locator"
      ? await latestEvidence(
          walk.evidence.filter((l) => equal(l.contract, d.board)),
          d.l2_chain_id,
          // A record is worth reading only if some events can replay it:
          // the bundle's, or the board's from the runs the replay read.
          Math.max(
            bundle.l2Board.events.length,
            replay?.find((c) => c.role === "board")?.records.length ?? 0,
          ),
          source,
          maxEvidenceReads,
        )
      : undefined;
  const overEvidence = walk.findings.filter(
    (f): f is Extract<ArchiveFinding, { code: "evidence-over-budget" }> =>
      f.code === "evidence-over-budget",
  );
  return done(
    {
      count: state.count,
      ...(earlier !== undefined && { earlier: earlier.length }),
      walk: {
        latest: walk.latest,
        manifests: walk.manifests.length,
        reads: walk.reads,
        findings: walk.findings.filter((f) => f.code !== "evidence-over-budget"),
      },
      ...(evidence !== undefined && {
        evidence: { ...evidence, findings: [...overEvidence, ...evidence.findings] },
      }),
      // The walk's budget of references is the replay's too: a walk that
      // kept no more leaves every contract's listings partial.
      ...(replay !== undefined && { replay: { contracts: replay, findings: overEvidence } }),
      ...(objects !== undefined &&
        targets !== undefined && {
          objects: {
            targets: targets.length,
            read: objects.objects.size,
            reads: objects.reads,
            spent: objects.spent,
            findings: objects.findings,
          },
        }),
    },
    objects?.blocks,
  );
}

/**
 * 4.3's row from the archive read (docs/spec/verifier.md, Archive): a pass
 * only where the chain from the latest locator was read whole and every
 * listed object was read, and otherwise unverifiable with the first report,
 * never a failure: a source that withheld a transaction and an authority
 * that cut the archive look alike to a reader, and the board checks judge
 * the bytes wherever they came from (docs/spec/archive.md; T-53).
 */
function archiveRow(read: ArchiveRead): Outcome {
  if ("stopped" in read) return { status: "unverifiable", code: read.stopped, at: {} };
  const first = read.walk.findings[0] ?? read.objects?.findings[0];
  if (first !== undefined) return { status: "unverifiable", code: first.code, at: {} };
  // Without counted checkpoints there is no object to look for, and so no pass.
  if (read.objects === undefined) return { status: "unverifiable", code: "not-reached", at: {} };
  // 4.3 also judges the earlier locators from the anchor's `ArchiveLocated`
  // logs, the only check that sees a seized authority's overwritten locator
  // (T-69): a whole chain from the latest is no pass without them.
  if (read.earlier === undefined)
    return { status: "unverifiable", code: "anchor-logs-missing", at: {} };
  return PASS;
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
  archived?: AsyncBlockSource,
): Promise<Bundle> {
  if (bundle.entries.length !== 0 || bundle.unreadableBytes !== 0 || bundle.byCid !== undefined)
    throw new TypeError("the bundle already holds a board copy");
  if (store === undefined && gateways === undefined && archived === undefined)
    throw new TypeError("a read by CID needs a store, gateways or archived objects");
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
  // The store first, then the objects already read from the archive: a
  // block either holds costs no request, and tells no gateway what is being
  // read (T-11).
  const source: AsyncBlockSource = async (cid, limit) => {
    for (const local of [store?.source, archived]) {
      const held = local === undefined ? [] : await local(cid, limit);
      if (held.length !== 0) return held;
    }
    return gateways === undefined ? [] : gateways.source(cid, limit);
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

/**
 * Runs every check over one bundle and reports it (docs/spec/verifier.md,
 * Report). `pins` are the panels the release pins, whose kinds 2.5 and whose
 * seats marked ours 2.3's live restriction read: `PINNED_PANELS` unless a
 * test gives others, and `registries` those a rolling poll's chain is built
 * under: `PINNED_REGISTRIES` unless a test gives others. Changing either
 * changes the trust roots, as a new release would (T-64).
 */
export function verifyBundle(
  bundle: Bundle,
  pins: readonly PinnedPanel[] = PINNED_PANELS,
  registries: RollingChainRelease | undefined = PINNED_REGISTRIES,
): Report {
  const definition = fromDefinition(bundle, pins, registries);
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
  let availability: AvailabilityReport | undefined;
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
                "l1Blocks" in bundle ? bundle.l1Blocks : undefined,
                archivedEvents(bundle),
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
      // ballot versions 1 to 5's key (one key: a version-2 to version-5
      // ballot proves membership of its cell's or step's tree under it) is pinned here; a version
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
      "panel" in bundle &&
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
        pins,
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
        "l1Blocks" in bundle ? bundle.l1Blocks : undefined,
        definition.rolling,
      );
      // Under the archive's chain a rejection resting on it leaves its rows
      // unverifiable and selection unsettled, even beside another rejection
      // that fails the same row (6.1, condition 1).
      const admissionRows =
        definition.rolling === undefined
          ? admission.rows
          : unprovenRoots(admission.rows, admission.report?.rejected ?? []);
      implemented = new Map<string, Outcome>([...implemented, ...admissionRows]);
      ballots = admission.report;
      // Selection is decided over the counted extent alone, so it needs what
      // admission doesn't: the anchored extent, the seal and 4.4
      // (docs/spec/verifier.md, Selection).
      const chosen = selectionCheck({
        admissionSettled:
          admissionSettled(admissionRows) &&
          !(definition.rolling !== undefined && restsOnChain(admission.report?.rejected ?? [])),
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
      // Under a rolling definition delivery (5.9) reads ballot version 5's
      // fields, its hash binding the step, and the counted set is per rolling
      // tier, each tallied per panel beside an author panel.
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
          blocks: "l1Blocks" in bundle ? bundle.l1Blocks : undefined,
        });
      }
      implemented = new Map<string, Outcome>([...implemented, ...counted.rows]);
      // Under a live definition pinning tally-opening version 2, the
      // releases are read once 7.1 passed: the board is then sealed and
      // authenticated, and every snapshot fixed (docs/spec/verifier.md,
      // Releases, step 1).
      if (
        // 7.1 passes only where 6.1 did, which needs 5.8 and so a run of
        // L1 headers (format 5 or 6).
        "l1Blocks" in bundle &&
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
      // versions 3 to 7 against their cells, a rolling one's one per rolling
      // tier, beside an author panel per panel with its own key set (docs/
      // spec/verifier.md, Tally openings); the counted set, once known,
      // settles the rest, `tally-early` included.
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
      // An opening is checked against the same registered election, under a
      // rolling definition the context made from the same chain, and
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
        definition.rolling,
      );
      implemented = new Map<string, Outcome>([...implemented, ["6.2", spoiled.row]]);
      openings = spoiled.report;
      // 4.6 reads L1's counted checkpoints and the board contract's events
      // alone, never the copy, so it runs whatever 4.1 and 4.2 found
      // (docs/spec/availability.md, Availability check, Precedence).
      if ("l2Board" in bundle) {
        const d = definition.definition.value;
        const author = authorRunOf(definition.definition);
        const archivedBoard = boardRecords(bundle);
        const checkedAvailability =
          input instanceof L1Error || checked.registered === undefined
            ? { row: NOT_REACHED }
            : availabilityChecks({
                definitionHash: definition.hash,
                electionId: d.election_id,
                closesAt: d.closes_at,
                l1InclusionBound: BigInt(d.l1_inclusion_bound),
                l2ChainId: d.l2_chain_id,
                eventVersion: pinnedVersion(d, RECORD_TYPES.contractEvent),
                contracts: {
                  electionRegistry: d.election_registry,
                  trusteeRegistry: d.trustee_registry,
                  groupRegistry: d.group_registry,
                  board: d.board,
                },
                panels: [
                  {
                    panel: SEAT_PANELS.default,
                    threshold: d.threshold,
                    registered: checked.registered,
                  },
                  // The author panel's registered key set, its own run's that
                  // its approvals approved, as the default panel's is its run's:
                  // the election registry's record of it isn't read yet
                  // (docs/spec/availability.md, Terms; 3.1's
                  // registration part; T-37, T-53). Beside an author panel
                  // `registered` is set only with it.
                  ...(author === undefined
                    ? []
                    : [
                        {
                          panel: SEAT_PANELS.author,
                          threshold: author.panel.threshold,
                          registered: checked.authorRegistered ?? [],
                        },
                      ]),
                ],
                anchors: input.anchors,
                clock: bundle.clock,
                now: input.now,
                l2: bundle.l2Board,
                ...(bundle.archive !== undefined &&
                  "walk" in bundle.archive &&
                  bundle.archive.evidence?.proven !== undefined && {
                    archived: bundle.archive.evidence.proven,
                  }),
                ...(archivedBoard !== undefined && { archivedEvents: archivedBoard }),
              });
        implemented = new Map<string, Outcome>([...implemented, ["4.6", checkedAvailability.row]]);
        if ("report" in checkedAvailability) availability = checkedAvailability.report;
      }
    }
  }
  // The archive is read before the checks run, whatever they found: a run
  // that read none leaves 4.3 not implemented (docs/spec/verifier.md, Archive).
  if (bundle.archive !== undefined)
    implemented = new Map<string, Outcome>([...implemented, ["4.3", archiveRow(bundle.archive)]]);
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
    ...(availability !== undefined && { availability }),
    ...(bundle.archive !== undefined && { archive: plain(reportedArchive(bundle.archive)) }),
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
    !("panel" in bundle)
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
  const blocks = "l1Blocks" in bundle ? bundle.l1Blocks : undefined;
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
  // The archive's replay is left out: it only ever makes 4.4 unverifiable,
  // which changes nothing here, and judging every held event again costs
  // as much as the row itself.
  const events: Outcome = eventChecks(
    definition,
    bundle.entries,
    inputs.boardEntryVersion,
    extent,
    "l1Blocks" in bundle ? bundle.l1Blocks : undefined,
  );
  const admission = ballotChecks(
    definition,
    checked.registered,
    checked.authorRegistered,
    bundle.entries,
    inputs.boardEntryVersion,
    bundle.clock,
    "l1Blocks" in bundle ? bundle.l1Blocks : undefined,
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
