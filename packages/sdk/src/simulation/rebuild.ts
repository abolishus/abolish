// Wipe and rebuild (AGENTS.md, Reference election, stage 8), under
// simulation: with the operator's copy of the board and everything the run
// derived from it gone, every result is rebuilt from the public record
// alone. From chain: the definition the election registry registered, the
// panel the trustee registry pins and the key set it recorded, every
// checkpoint the anchor holds, L1's finalized blocks and the contract-path
// postings; from IPFS: each segment object an anchored checkpoint names by
// CID. The board is the fetched objects, split by crypto's
// `splitSegmentObject` and authenticated by crypto's `verifyBoard` against
// every anchor, so no byte rests on its source (T-24, T-49, T-51, T-53); the
// key set is the ceremony transcript's on that board, checked by crypto's
// `checkCeremonyTranscript` and compared with the registry's record (T-37);
// the counted set is ./count.ts's, the reading the trustees made at t_S; and
// the tally and destruction are crypto's checks over the board's openings and
// statements. Nothing here reimplements a check the verifier makes (AGENTS.md,
// Architecture). The chain reads are the simulated contracts' memory, and the
// postings their records held in memory (SIMULATION_STUBS).

import {
  type Anchor,
  type AnchorClock,
  type BallotRecordV2,
  cellBallotElection,
  ceremonyTranscriptHash,
  checkCeremonyTranscript,
  checkDestruction,
  checkTally,
  type CommittedVote,
  DecodeError,
  type DeliveryEntry,
  decodeElectionDefinitionRecord,
  decodeOpening,
  deriveTotal,
  electionDefinitionV4Hash,
  electionStubV4Hash,
  keySetEntry,
  keySetHash,
  l1RefMin,
  openingV2CoreHash,
  panelId,
  pinnedVersion,
  RECORD_TYPES,
  type SeatDestruction,
  isTimely,
  objectCid,
  splitSegmentObject,
  verifyBoard,
} from "@abolishus/crypto";
import type { SimulatedIpfs } from "./archive.ts";
import { anchorClock } from "./anchor.ts";
import { endOf, postClose, SIMULATED_ANCHOR_DEADLINE } from "./board.ts";
import { readCountedExtent, recordTypeOf } from "./count.ts";
import { SIMULATED_BOARD_ENTRY_VERSION } from "./election.ts";
import type { SimulatedL1 } from "./l1.ts";
import type { SimulatedElectionRegistry, SimulatedTrusteeRegistry } from "./l2.ts";

/**
 * Everything public after the election: what a rebuild may read, and
 * nothing else. Each contract is only the reads a rebuild makes of it.
 */
export interface PublicRecord {
  /** The election an observer asks about. */
  readonly electionId: Uint8Array;
  readonly electionRegistry: Pick<SimulatedElectionRegistry, "definitionOf" | "definitionHashOf">;
  readonly trusteeRegistry: Pick<SimulatedTrusteeRegistry, "panelOf" | "keySetOf">;
  /** The board anchor's checkpoints, in L1 order, and its clock. */
  readonly anchor: { readonly anchors: readonly Anchor[]; readonly clock: AnchorClock };
  readonly l1: Pick<SimulatedL1, "block" | "firstAfter" | "finalized">;
  /** Contract-path share postings, by their submission time. */
  readonly postings: readonly DeliveryEntry[];
  readonly ipfs: Pick<SimulatedIpfs, "get">;
}

export type RebuildFailure =
  | "definition-unregistered"
  | "definition-mismatch"
  | "panel-unpinned"
  | "object-unavailable"
  | "object-malformed"
  | "hashes-unavailable"
  | "clock-mismatch"
  | "transcript-mismatch"
  | "ceremony-failed"
  | "key-set-mismatch";

/** A public record from which the election can't be rebuilt. */
export class RebuildError extends Error {
  override readonly name = "RebuildError";
  constructor(readonly code: RebuildFailure) {
    super(`rebuild: ${code}`);
  }
}

export interface RebuiltCell {
  readonly tier: number;
  /** Counted ballots in the cell. */
  readonly ballots: number;
  /** The counts the board's opening gives, when the tally check passes the cell. */
  readonly counts?: readonly number[];
}

/** The results rebuilt from the public record. */
export interface RebuiltElection {
  readonly definitionHash: string;
  readonly board: {
    readonly entries: number;
    /** Entries in the counted extent. */
    readonly counted: number;
    readonly head: string;
    /** Segment objects fetched by CID, each with its entry-hash list. */
    readonly objects: number;
  };
  readonly ballots: {
    /** Ballots on the board that decode and name a cell of the partition. */
    readonly cast: number;
    /** Ballots and published openings rejected as entries: undecodable, or naming no cell. */
    readonly rejected: number;
    readonly counted: number;
    /** Selected ballots the delivery check kept out. */
    readonly undelivered: number;
  };
  readonly cells: readonly RebuiltCell[];
  readonly total?: readonly number[];
  readonly destruction: { readonly from: number; readonly seats: readonly SeatDestruction[] };
  /** The core hashes of the spoiled-ballot openings on the board, in board order, in hex. */
  readonly spoiled: readonly string[];
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Rebuilds the closed election's results from `record` alone, as read at the
 * first L1 block after the seal's window has closed, the moment the
 * verifier reads it. Throws `RebuildError` when the record can't give them,
 * and crypto's `BoardError` when the fetched board fails a board check.
 */
export function rebuildElection(record: PublicRecord): RebuiltElection {
  const { electionId, l1 } = record;
  // The definition the registration carried, decoded strictly and held to
  // the hash the registry recorded (T-34, T-24).
  const encoded = record.electionRegistry.definitionOf(electionId);
  const registeredHash = record.electionRegistry.definitionHashOf(electionId);
  if (encoded === undefined || registeredHash === undefined)
    throw new RebuildError("definition-unregistered");
  let decoded: ReturnType<typeof decodeElectionDefinitionRecord>;
  try {
    decoded = decodeElectionDefinitionRecord(encoded);
  } catch (e) {
    if (e instanceof DecodeError) throw new RebuildError("definition-mismatch");
    throw e;
  }
  if (decoded.version !== 4) throw new RebuildError("definition-mismatch");
  const definition = decoded.value;
  const definitionHash = electionDefinitionV4Hash(definition);
  if (
    !same(definitionHash, registeredHash) ||
    !same(definition.election_id, electionId) ||
    pinnedVersion(definition, RECORD_TYPES.boardEntry) !== SIMULATED_BOARD_ENTRY_VERSION
  )
    throw new RebuildError("definition-mismatch");
  const panel = record.trusteeRegistry.panelOf(definition.panel_id);
  if (panel === undefined || !same(panelId(panel), definition.panel_id))
    throw new RebuildError("panel-unpinned");

  // The windows follow from the definition, and the anchor's clock must be
  // the one they assume, so the read below is the verifier's moment.
  const after = postClose(definition.closes_at);
  const { clock } = record.anchor;
  const want = anchorClock(after.seal);
  if (
    clock.epoch !== want.epoch ||
    clock.period !== want.period ||
    clock.deadline !== want.deadline ||
    clock.lastSegment !== want.lastSegment
  )
    throw new RebuildError("clock-mismatch");
  // The board, from each checkpoint the board checks count (timely, for
  // this election, finalized by the verifier's read), in segment order: a
  // re-anchor names the objects before it, so only a checkpoint that grew
  // the board adds one.
  const now = l1.block(l1.firstAfter(endOf(after.seal) + SIMULATED_ANCHOR_DEADLINE)).timestamp;
  const anchored = record.anchor.anchors
    .filter(
      (a) =>
        a.anchoredAt <= now &&
        same(a.checkpoint.election_id, electionId) &&
        isTimely(clock, a.checkpoint.segment, a.anchoredAt),
    )
    .map((a) => a.checkpoint)
    .sort((a, b) => a.segment - b.segment);
  const entries: Uint8Array[] = [];
  let objects = 0;
  for (const cp of anchored) {
    if (cp.size <= BigInt(entries.length)) continue;
    // Each fetch is checked by its CID here, whatever the store does (T-49).
    const object = record.ipfs.get(cp.object_cid);
    if (object === undefined || !same(objectCid(object), cp.object_cid))
      throw new RebuildError("object-unavailable");
    // The entry-hash list voters' clients read (docs/spec/receipts.md):
    // published beside the object, so it must be fetchable too.
    const hashes = record.ipfs.get(cp.hashes_cid);
    if (hashes === undefined || !same(objectCid(hashes), cp.hashes_cid))
      throw new RebuildError("hashes-unavailable");
    let split: Uint8Array[];
    try {
      split = splitSegmentObject(object);
    } catch (e) {
      if (e instanceof DecodeError) throw new RebuildError("object-malformed");
      throw e;
    }
    entries.push(...split);
    objects++;
  }
  const { board, unauthenticated } = verifyBoard(
    electionId,
    entries,
    SIMULATED_BOARD_ENTRY_VERSION,
    record.anchor.anchors,
    clock,
    now,
  );
  // Only objects the counted checkpoints name were fetched, so every entry
  // is in the anchored extent unless an object holds more than its
  // checkpoint says, which verifyBoard's CID check has already refused.
  if (unauthenticated > 0) throw new Error("simulation: fetched entries past the anchored extent");

  // The key set: the transcript on the board, which the definition names,
  // checked from the stub's fields, and the one the trustee registry
  // recorded from the quorum's approvals (T-37, T-14).
  const transcript = board.entries[0]?.payload;
  if (
    transcript === undefined ||
    !same(ceremonyTranscriptHash(transcript), definition.ceremony_transcript_hash)
  )
    throw new RebuildError("transcript-mismatch");
  const stubHash = electionStubV4Hash(definition);
  const ceremony = checkCeremonyTranscript(
    {
      l2ChainId: definition.l2_chain_id,
      trusteeRegistry: definition.trustee_registry,
      electionId: definition.election_id,
      stubHash,
      panel,
    },
    transcript,
    1,
  );
  if (!ceremony.ok) throw new RebuildError("ceremony-failed");
  const { registered } = ceremony;
  const recorded = record.trusteeRegistry.keySetOf(stubHash, definition.panel_id);
  if (recorded === undefined || !same(recorded.keySetHash, keySetHash(registered.map(keySetEntry))))
    throw new RebuildError("key-set-mismatch");

  // The counted set, as the trustees read it at t_S (./count.ts).
  const partition = cellBallotElection(definition, registered).cells;
  const finalized = l1.finalized(l1.firstAfter(definition.closes_at));
  const refMin = l1RefMin(finalized, 0n, definition.opens_at);
  if (refMin === undefined) throw new Error("simulation: L1 hasn't reached the election's window");
  const countedEntries = board.entries.filter((e) => e.segment <= after.counted);
  const extent = readCountedExtent(
    {
      definitionHash,
      panelSize: definition.panel_size,
      registered,
      tierOfCell: (cell) => partition[cell]?.tier,
      closesAt: definition.closes_at,
      inclusionBound: definition.l1_inclusion_bound,
      finalized,
      window: { l1RefMin: refMin, closesAt: definition.closes_at },
      postings: record.postings,
    },
    countedEntries,
  );
  const vss: CommittedVote["vss"][][] = partition.map(() => []);
  for (const b of extent.counted) {
    // Every selected ballot is one readCountedExtent decoded, in a cell of the partition.
    const { cell, committed_vote: vote } = extent.ballots.get(Number(b.index)) as BallotRecordV2;
    (vss[cell] as CommittedVote["vss"][]).push(vote.vss);
  }

  // The tally and destruction, from the board's openings and statements in
  // its sealed extent (verifier 7.2, 8.5).
  const sealed = (type: number) =>
    board.entries
      .filter((e) => e.segment <= after.seal && recordTypeOf(e.payload) === type)
      .map((e) => ({ segment: e.segment, payload: e.payload }));
  const tallyRules = {
    optionCount: definition.option_count,
    threshold: definition.threshold,
    panelSize: definition.panel_size,
  };
  const openings = sealed(RECORD_TYPES.tallyOpening);
  const tally = checkTally(
    { definitionHash, rules: tallyRules, registered },
    vss,
    openings.map((e) => e.payload),
    1,
  );
  const cells: RebuiltCell[] = partition.map((p, c) => {
    const check = tally.cells[c];
    return {
      tier: p.tier,
      ballots: vss[c]?.length ?? 0,
      ...(check?.ok === true ? { counts: check.counts.map(Number) } : {}),
    };
  });
  const firstPassing = tally.cells.map((cell) => {
    const first = cell.passing[0];
    return first === undefined ? null : (openings[first.at] as { segment: number }).segment;
  });
  const destruction = checkDestruction(
    { definitionHash, registered },
    sealed(RECORD_TYPES.destructionStatement),
    { firstPassing, windowSegment: after.windowSegment },
    1,
  );
  // Published openings that don't decode are rejected entries (verifier
  // 6.2), never a reason to stop.
  const spoiled: string[] = [];
  let rejectedOpenings = 0;
  for (const e of sealed(RECORD_TYPES.spoiledBallotOpening)) {
    try {
      spoiled.push(hex(openingV2CoreHash(decodeOpening(e.payload, 2), 2)));
    } catch (err) {
      if (!(err instanceof DecodeError)) throw err;
      rejectedOpenings++;
    }
  }
  const allOpened = cells.every((c) => c.counts !== undefined);
  return {
    definitionHash: hex(definitionHash),
    board: {
      entries: board.entries.length,
      counted: countedEntries.length,
      head: hex(board.links.at(-1) ?? new Uint8Array(32)),
      objects,
    },
    ballots: {
      cast: extent.ballots.size,
      rejected: extent.rejected.length + rejectedOpenings,
      counted: extent.counted.length,
      undelivered: extent.selection.selected.length - extent.counted.length,
    },
    cells,
    ...(allOpened
      ? {
          total: deriveTotal(cells.map((c) => (c.counts as readonly number[]).map(BigInt))).map(
            Number,
          ),
        }
      : {}),
    destruction: { from: destruction.from, seats: destruction.seats },
    spoiled,
  };
}

/** What a run holds before the wipe, which its rebuild must give back. */
export interface RebuildExpectation {
  readonly definitionHash: string;
  readonly entries: number;
  readonly counted: number;
  readonly head: string;
  readonly cast: number;
  readonly countedBallots: number;
  readonly undelivered: number;
  readonly cells: readonly {
    readonly tier: number;
    readonly ballots: number;
    readonly counts?: readonly number[];
  }[];
  readonly destruction: { readonly from: number; readonly seats: readonly SeatDestruction[] };
  readonly spoiled: readonly string[];
}

/**
 * Every way `rebuilt` differs from what the run held before the wipe, one
 * line each: empty exactly when the public record gave back every result.
 */
export function judgeRebuild(rebuilt: RebuiltElection, want: RebuildExpectation): string[] {
  const out: string[] = [];
  const check = (what: string, got: unknown, expected: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(expected))
      out.push(`${what}: rebuilt ${JSON.stringify(got)}, held ${JSON.stringify(expected)}`);
  };
  check("definition", rebuilt.definitionHash, want.definitionHash);
  check("board entries", rebuilt.board.entries, want.entries);
  check("counted extent", rebuilt.board.counted, want.counted);
  check("board head", rebuilt.board.head, want.head);
  check("ballots cast", rebuilt.ballots.cast, want.cast);
  check("entries rejected", rebuilt.ballots.rejected, 0);
  check("ballots counted", rebuilt.ballots.counted, want.countedBallots);
  check("ballots undelivered", rebuilt.ballots.undelivered, want.undelivered);
  check(
    "cells",
    rebuilt.cells.map((c) => [c.tier, c.ballots, c.counts ?? null]),
    want.cells.map((c) => [c.tier, c.ballots, c.counts ?? null]),
  );
  check("destruction", rebuilt.destruction, {
    from: want.destruction.from,
    seats: want.destruction.seats,
  });
  check("spoiled openings", rebuilt.spoiled, want.spoiled);
  return out;
}
