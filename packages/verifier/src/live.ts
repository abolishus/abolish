// Live releases in the verdict (docs/spec/verifier.md, Releases; 7.5, 7.6
// and 8.2's `live-final-batch`): once 7.1 passed under a live definition,
// every copy admission read, the anchored extent's share receipts and
// running openings, and the bundle's run of finalized L1 headers go through
// releases.ts's two steps. What is this module's is gathering them: each
// copy keyed by its tier and nullifier and by its `M`, and when each ballot
// is fully receipted, by @abolishus/crypto's `checkDeliveryV2` over the
// receipts boarded by each scheduled snapshot, so no receipt is judged here
// (T-16, T-29, T-45). Nothing comes from a release, a coordinator or the
// operator's word: a release the verifier recomputes differently is the
// opening's breach (T-34).

import {
  type AnchorClock,
  ballotHashV4,
  type BoardEntryVersion,
  checkDeliveryV2,
  DecodeError,
  decodeBoardEntry,
  type DeliveryBallotV4,
  type DeliveryElectionV2,
  deliveryDeadlines,
  deliverySegments,
  RECORD_TYPES,
  type RegisteredKeys,
  tallyRules,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { LiveBallotCopy } from "./ballots.ts";
import { cellTiers } from "./counted.ts";
import type { PanelledRecord } from "./definition.ts";
import type { L1Header } from "./l1.ts";
import {
  type CellReleasesReport,
  type LiveCopy,
  liveReleases,
  liveRunning,
  type LiveSnapshot,
  type ReleaseRow,
  type RunningOpeningReport,
  runningOpeningFacts,
  snapshotHeads,
  type TierReleasesReport,
} from "./releases.ts";

/** The report's `releases` (docs/spec/verifier.md, Releases). */
export interface ReleasesReport {
  /** Each scheduled snapshot `r`, from 1, with `σ_r` and its L1 head `h_r`. */
  readonly snapshots: readonly {
    readonly snapshot: number;
    readonly segment: number;
    readonly l1Head: { readonly number: string; readonly hash: string };
  }[];
  readonly tiers: readonly TierReleasesReport[];
  readonly cells: readonly CellReleasesReport[];
  readonly openings: readonly RunningOpeningReport[];
}

export interface ReleaseOutcome {
  readonly status: "pass" | "fail" | "unverifiable";
  readonly code?: NonNullable<ReleaseRow["code"]> | "l1-blocks-short";
  readonly at?: NonNullable<ReleaseRow["at"]> | { readonly snapshot: number };
}

export interface ReleaseInputs {
  /** A live version-6 or fixed version-7 definition without an author panel. */
  readonly definition: PanelledRecord;
  readonly definitionHash: Uint8Array;
  /** The registered key set the transcript check returned (3.2 passed). */
  readonly registered: readonly RegisteredKeys[];
  /** Admission's copies (`ballotChecks`' `live`), in copy order. */
  readonly copies: readonly LiveBallotCopy[];
  readonly entries: readonly Uint8Array[];
  readonly boardEntryVersion: BoardEntryVersion;
  /** The anchored extent, which 7.1's pass makes the sealed board. */
  readonly extent: number;
  readonly clock: AnchorClock;
  /** The bundle's run of finalized L1 headers; empty if it has none. */
  readonly blocks: readonly L1Header[];
  /** Each cell's counted set (7.1), by each ballot's `M` as hex. */
  readonly counted: readonly ReadonlySet<string>[];
}

/**
 * 7.5 and 7.6 and the report's `releases`, past Releases' step 1: call it
 * only under a live definition pinning tally-opening version 2, once 7.1
 * passed. A run that doesn't fix every snapshot's head leaves both rows
 * unverifiable with `l1-blocks-short` and no report (step 2; T-53).
 */
export function releaseChecks(inputs: ReleaseInputs): {
  readonly rows: ReadonlyMap<"7.5" | "7.6", ReleaseOutcome>;
  readonly report?: ReleasesReport;
} {
  const { definition, definitionHash, registered, clock, extent } = inputs;
  const d = definition.value;
  if (d.author_keys.length !== 0)
    throw new RangeError("releaseChecks: a live poll's running sets are the default panel's");
  const heads = snapshotHeads(clock, d.opens_at, d.closes_at, d.live_every, inputs.blocks);
  if (!heads.ok) {
    const short: ReleaseOutcome = { status: "unverifiable", code: heads.code, at: heads.at };
    return {
      rows: new Map([
        ["7.5", short],
        ["7.6", short],
      ]),
    };
  }
  const { snapshots } = heads;

  // The anchored extent's entries of this election: 4.1 passed, so every
  // one decodes, and another election's is 4.1's.
  const receipts: { readonly segment: number; readonly payload: Uint8Array }[] = [];
  const openings: { readonly entry: number; readonly payload: Uint8Array }[] = [];
  for (const [at, encoded] of inputs.entries.entries()) {
    if (at >= extent) break;
    let e;
    try {
      e = decodeBoardEntry(encoded, inputs.boardEntryVersion);
    } catch (err) {
      if (err instanceof DecodeError) continue;
      throw err;
    }
    if (bytesToHex(e.election_id) !== bytesToHex(d.election_id)) continue;
    const type = ((e.payload[0] as number) << 8) | (e.payload[1] as number);
    // Only board-path receipts are read: 7.1's pass means 5.9 ran with no
    // contract-path delivery record in the anchored extent, since one leaves
    // 5.9 unverifiable until 4.4 authenticates its time, and under ballot
    // version 4 the board's events carry only version-1 records, which
    // deliver nothing ([[delivery]], Versions). A posting never lets a ballot
    // enter (tally.md, Running set, condition 2).
    if (type === RECORD_TYPES.shareReceipt)
      receipts.push({ segment: e.segment, payload: e.payload });
    else if (type === RECORD_TYPES.runningOpening) openings.push({ entry: at, payload: e.payload });
  }

  const own = inputs.copies.filter((c) => c.entry < extent);
  // Each ballot that 5.1 to 5.4 admit, by `M`, with what delivery and the
  // tally read of it: every copy of one `M` is the same record's fields.
  const admitted = new Map<string, NonNullable<LiveBallotCopy["tally"]>>();
  for (const c of own)
    if (c.tally !== undefined) {
      const m = bytesToHex(c.message);
      if (!admitted.has(m)) admitted.set(m, c.tally);
    }
  const bound = BigInt(d.l1_inclusion_bound);
  const receiptedAt = receiptSegments(
    {
      definitionHash,
      panelSize: d.panel_size,
      authorPanelSize: 0,
      registered: { default: registered, author: [] },
      segments: deliverySegments(clock, d.closes_at, bound),
      deadlines: deliveryDeadlines(d.closes_at, bound),
    },
    admitted,
    receipts,
    snapshots,
  );

  const copies = own.map((c): LiveCopy<string, string> => ({
    entry: c.entry,
    segment: c.segment,
    // Nullifiers are scoped per tier.
    nullifier: `${c.tier}:${c.nullifier}`,
    ballot: bytesToHex(c.message),
    cell: c.cell,
    // Definition version 6 and a fixed version 7 have no rolling tier.
    stepFinalAt: null,
    member: c.member,
    rejected: c.rejected,
    reference: c.reference,
    referenceKnown: c.referenceKnown,
    receiptedAt: receiptedAt.get(bytesToHex(c.message)) ?? null,
  }));
  const running = liveRunning({
    cellTiers: cellTiers(definition),
    snapshots,
    copies,
    batch: d.live_batch,
  });
  const rules = tallyRules(definition);
  if (rules.questions === undefined)
    throw new Error("releaseChecks: a version-6 definition's rules have its questions");
  const facts = runningOpeningFacts(
    { definitionHash, rules, registered },
    running,
    openings,
    (ballot) => {
      // Only an admitted ballot enters a running set.
      const tally = admitted.get(ballot);
      if (tally === undefined) throw new Error("releaseChecks: a running set's ballot unadmitted");
      return tally.vss;
    },
  );
  const released = liveReleases({
    running,
    rules: { optionCount: rules.optionCount, questions: rules.questions },
    batch: d.live_batch,
    openings: facts,
    counted: inputs.counted,
  });
  return {
    rows: new Map([
      ["7.5", released.rows["7.5"]],
      ["7.6", released.rows["7.6"]],
    ]),
    report: {
      snapshots: snapshots.map((s, i) => ({
        snapshot: i + 1,
        segment: s.segment,
        l1Head: { number: s.head.number.toString(), hash: bytesToHex(s.head.hash) },
      })),
      tiers: released.tiers,
      cells: released.cells,
      openings: released.openings,
    },
  };
}

/**
 * The least scheduled snapshot's `σ_r` by which each admitted ballot, by
 * `M`, is fully receipted: `S_r` holds, for every qualified seat, a share
 * receipt that passes the delivery check's receipt checks, each read by its
 * entry's segment ([[delivery]], Delivery check (version 2)). A receipt
 * names the ballot hash, which doesn't bind the L1 reference, so ballots
 * with different `M` can share one: the check runs over distinct ballot
 * hashes, and each `M` takes its hash's segment, never a receipt counted for
 * one `M` and not another (T-29). The receipts are given to the check in the
 * runs between consecutive snapshots, each once, and a seat's receipt
 * delivers whatever else the run holds, so a seat is receipted by `σ_r` if
 * a run up to it found it not missing: no receipt is verified twice, however
 * many snapshots there are or however long a seat withholds (T-52). Only
 * receipts are given, so a seat a posting would deliver stays missing (a
 * posting never lets a ballot enter; T-15).
 */
function receiptSegments(
  election: DeliveryElectionV2,
  ballots: ReadonlyMap<string, { readonly deliveryV4?: DeliveryBallotV4 }>,
  receipts: readonly { readonly segment: number; readonly payload: Uint8Array }[],
  snapshots: readonly LiveSnapshot[],
): Map<string, number> {
  const hashOf = new Map<string, string>();
  const byHash = new Map<string, DeliveryBallotV4>();
  for (const [m, t] of ballots) {
    const b = t.deliveryV4;
    if (b === undefined)
      throw new Error("releaseChecks: an admitted version-4 ballot without its delivery fields");
    const h = bytesToHex(
      ballotHashV4(
        { definitionHash: election.definitionHash, cell: b.cell, nullifier: b.nullifier },
        b.vote,
      ),
    );
    hashOf.set(m, h);
    if (!byHash.has(h)) byHash.set(h, b);
  }
  const hashes = [...byHash.keys()];
  const list = hashes.map((h) => byHash.get(h) as DeliveryBallotV4);
  const seats = election.registered.default.map((k) => k.index);
  const held = hashes.map(() => new Set<number>());
  const at = new Map<string, number>();
  let from = -1;
  for (const { segment } of snapshots) {
    if (at.size === hashes.length) break;
    const run = receipts
      .filter((r) => r.segment > from && r.segment <= segment)
      .map((r) => ({ path: "board" as const, segment: r.segment, payload: r.payload }));
    from = segment;
    if (run.length === 0) continue;
    const checked = checkDeliveryV2(election, list, run);
    for (const [i, b] of checked.ballots.entries()) {
      const h = hashes[i] as string;
      if (at.has(h)) continue;
      const missing = new Set(b.missing.map((x) => x.seat));
      const got = held[i] as Set<number>;
      for (const seat of seats) if (!missing.has(seat)) got.add(seat);
      if (got.size === seats.length) at.set(h, segment);
    }
  }
  const out = new Map<string, number>();
  for (const [m, h] of hashOf) {
    const s = at.get(h);
    if (s !== undefined) out.set(m, s);
  }
  return out;
}
