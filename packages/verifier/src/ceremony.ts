// The key-ceremony checks of docs/spec/verifier.md (Key ceremony): the
// pinned panel against the definition (part of 2.5), and the transcript the
// definition names, found on the board copy by its hash and checked by
// @abolishus/crypto's transcript check (part of 3.1, and 3.2). The context is
// rebuilt from the definition and the pinned panel, never read from the
// transcript, so one election's ceremony can't pass for another's (T-37).
// The L2 side (the trustee registry's registration and its approvals) isn't
// read yet, so 3.1 and 2.5 never pass here.

import {
  type CeremonyErrorCode,
  ceremonyTranscriptHash,
  checkCeremonyTranscript,
  DecodeError,
  type DecodeErrorCode,
  decodeBoardEntry,
  type ElectionDefinition,
  electionStubHash,
  type Panel,
  panelId,
  pinnedVersion,
  RECORD_TYPES,
  type SeatReason,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Codes the ceremony checks report besides a transcript's own (docs/spec/verifier.md, Key ceremony). */
export type CeremonyCode =
  | Exclude<CeremonyErrorCode, DecodeErrorCode>
  | "panel-unpinned"
  | "ceremony-transcript-missing"
  | "ceremony-participation";

/** What the transcript check found, once it reached the seats (the report's `ceremony`). */
export interface CeremonyReport {
  /** The position in the copy, from 0, of the entry that carries the transcript (not its `index` field). */
  readonly entry: number;
  readonly seats: readonly { readonly index: number; readonly reasons: readonly SeatReason[] }[];
  /** The qualified seats and their per-election signing keys; empty when `ceremony-quorum` fails. */
  readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
}

type Status = "pass" | "fail" | "unverifiable";

export interface CeremonyOutcome {
  readonly status: Status;
  readonly code?:
    | CeremonyCode
    | "decode"
    | "unsupported-version"
    | "not-reached"
    | "not-implemented";
  readonly at?:
    | { readonly entry: number; readonly decodeError?: DecodeErrorCode }
    | Record<string, never>;
}

const NOT_REACHED: CeremonyOutcome = { status: "unverifiable", code: "not-reached" };
const NOT_IMPLEMENTED: CeremonyOutcome = { status: "unverifiable", code: "not-implemented" };

const TRANSCRIPT_CODES: ReadonlySet<string> = new Set<CeremonyErrorCode>([
  "ceremony-order",
  "ceremony-shape",
  "ceremony-signature",
]);

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The first entry of the copy that is the definition's transcript: an entry
 * of this election, under the pinned version, whose payload hashes to
 * `ceremony_transcript_hash`, whatever its record type: bytes the definition
 * binds that aren't a transcript fail its decoding, never go missing. The hash
 * authenticates the bytes wherever they sit, so its position, and whether it
 * is inside the anchored extent, don't matter; any copy of them is the
 * transcript.
 */
function findTranscript(
  d: ElectionDefinition,
  entries: readonly Uint8Array[],
  boardEntryVersion: 1,
): { readonly entry: number; readonly bytes: Uint8Array } | undefined {
  for (const [at, encoded] of entries.entries()) {
    let payload: Uint8Array;
    try {
      const e = decodeBoardEntry(encoded, boardEntryVersion);
      if (!equal(e.election_id, d.election_id)) continue;
      payload = e.payload;
    } catch (e) {
      // 4.1 reports an entry that doesn't decode; it can't be the transcript.
      if (e instanceof DecodeError) continue;
      throw e;
    }
    if (equal(ceremonyTranscriptHash(payload), d.ceremony_transcript_hash))
      return { entry: at, bytes: payload };
  }
  return undefined;
}

/**
 * The rows 2.5, 3.1 and 3.2 for a definition that decoded, is well formed and
 * pins a board-entry version this verifier reads, and the report's
 * `ceremony` once the transcript check reached the seats.
 */
export function ceremonyChecks(
  d: ElectionDefinition,
  panel: Panel,
  entries: readonly Uint8Array[],
  boardEntryVersion: 1,
): { readonly rows: ReadonlyMap<string, CeremonyOutcome>; readonly report?: CeremonyReport } {
  const rows = (r25: CeremonyOutcome, r31: CeremonyOutcome, r32: CeremonyOutcome) =>
    new Map([
      ["2.5", r25],
      ["3.1", r31],
      ["3.2", r32],
    ]);
  // 2.5: the definition names the pinned panel. The transcript's context
  // binds the pinned panel's identifier, so checking it against any other
  // panel would only ever fail its signatures.
  if (
    !equal(panelId(panel), d.panel_id) ||
    panel.threshold !== d.threshold ||
    panel.keys.length !== d.panel_size
  )
    return {
      rows: rows({ status: "fail", code: "panel-unpinned", at: {} }, NOT_REACHED, NOT_REACHED),
    };
  // A transcript version this verifier can't read may be one a later release
  // reads: unverifiable, never failed, so releases agree (2.3; T-36).
  if (pinnedVersion(d, RECORD_TYPES.ceremonyTranscript) !== 1) {
    const unsupported: CeremonyOutcome = {
      status: "unverifiable",
      code: "unsupported-version",
      at: {},
    };
    return { rows: rows(NOT_IMPLEMENTED, unsupported, unsupported) };
  }
  const found = findTranscript(d, entries, boardEntryVersion);
  // A copy without the transcript is that copy's problem, like a short copy
  // in 4.1: unverifiable from it, never the election's failure (T-53).
  if (found === undefined)
    return {
      rows: rows(
        NOT_IMPLEMENTED,
        { status: "unverifiable", code: "ceremony-transcript-missing", at: {} },
        NOT_REACHED,
      ),
    };
  const checked = checkCeremonyTranscript(
    {
      l2ChainId: d.l2_chain_id,
      trusteeRegistry: d.trustee_registry,
      electionId: d.election_id,
      stubHash: electionStubHash(d),
      panel,
    },
    found.bytes,
    1,
  );
  const at = { entry: found.entry };
  if (!checked.ok && checked.seats === undefined) {
    // The definition binds these bytes, so a transcript that doesn't decode
    // or fails a transcript-level check fails the election (ceremony.md,
    // Transcript check, checks 1 to 3).
    const failed: CeremonyOutcome = TRANSCRIPT_CODES.has(checked.code)
      ? { status: "fail", code: checked.code as CeremonyCode, at }
      : {
          status: "fail",
          code: "decode",
          at: { ...at, decodeError: checked.code as DecodeErrorCode },
        };
    return { rows: rows(NOT_IMPLEMENTED, failed, NOT_REACHED) };
  }
  const report: CeremonyReport = {
    entry: found.entry,
    seats: (checked.seats ?? []).map((s) => ({ index: s.index, reasons: [...s.reasons] })),
    registered: checked.ok
      ? checked.registered.map((k) => ({ index: k.index, signingKey: bytesToHex(k.signingKey) }))
      : [],
  };
  // ADR 0006 rule 7 (the owner, 2026-10-12): an election opens only if at
  // least n − 1 seats took part, so a coordinator can't quietly shrink the
  // qualified set to k and the tally's failure margin with it (T-54, T-40).
  const participation = Math.max(panel.threshold, panel.keys.length - 1);
  const ceremony: CeremonyOutcome = !checked.ok
    ? { status: "fail", code: "ceremony-quorum", at }
    : checked.registered.length < participation
      ? { status: "fail", code: "ceremony-participation", at }
      : { status: "pass" };
  // 3.1 also needs the trustee registry's record of this transcript and its
  // approvals on L2, which this verifier doesn't read yet: never a pass here.
  return { rows: rows(NOT_IMPLEMENTED, NOT_IMPLEMENTED, ceremony), report };
}
