// Releases (docs/spec/verifier.md, Releases; 7.5, 7.6 and 8.2's
// `live-final-batch`): under a live definition the verifier recomputes the
// scheduled snapshots, their L1 heads, every cell's running sets and each
// tier's release choice from the sealed board, the definition and finalized
// L1 alone, never from a release, a coordinator or the operator, and checks
// and reports the running openings against them (T-16, T-29, T-34).
//
// Two steps, so the running openings can be judged between them against the
// running sets the first computes: `liveRunning` (steps 2 to 4: snapshots'
// heads, running sets, release choice) and `liveReleases` (steps 5 to 7: the
// openings' breaks, the rows and the final tally's least side). The running
// sets and the choice are @abolishus/crypto's (`runningSets`,
// `chooseReleases`), and so is each opening's check against its aggregate
// (`readRunningOpenings`, through `runningOpeningFacts`); what is the
// verifier's is how each ballot copy stands at a snapshot's head, the
// boarding rule's breaks with their blame, the rows and the closed form of
// the least side.
//
// Running totals never decide the result, which is the final tally's
// (7.1 to 7.3): 7.5 fails only on evidence that binding is broken, and 7.6
// and `live-final-batch` only report.

import {
  chooseReleases,
  type CommittedVote,
  DecodeError,
  type DecodeErrorCode,
  decodeRunningOpening,
  type PeriodClock,
  type QuestionRules,
  readRunningOpenings,
  type ReleaseChoice,
  type ReleaseRefusal,
  type RunningOpeningEntry,
  runningEntries,
  runningOpeningStatement,
  type RunningSet,
  runningSets,
  scheduledSnapshots,
  type SnapshotBallot,
  type TallyElection,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Nullifiers and ballots are compared by `===` and as Map keys, so they are primitives (hex strings, say). */
export type LiveKey = string | number | bigint;

/** An L1 block of the bundle's run of finalized headers, as far as the releases read it. */
export interface LiveBlock {
  readonly number: bigint;
  readonly timestamp: bigint;
  readonly hash: Uint8Array;
}

/** A scheduled snapshot: `σ_r`, and `h_r`, the last block of the run before the end of period `σ_r`. */
export interface LiveSnapshot {
  readonly segment: number;
  readonly head: LiveBlock;
}

/**
 * The scheduled snapshots `σ_r = s_open + r · live_every − 1` while
 * `σ_r < s_close` ([Releases](#releases), step 2), each with its L1 head
 * `h_r`, the last block of `blocks` whose timestamp is before the end of
 * period `σ_r`, `epoch + (σ_r + 1) · period`. `l1-blocks-short` at the first
 * `r` (from 1) for which the run doesn't start before that time or its head
 * isn't at or after it: a block before the time could be missing at the run's
 * end, so `h_r` isn't fixed by the run (T-53). `blocks` is a parsed run
 * (Bundle): consecutive, linked and with increasing timestamps.
 */
export function snapshotHeads<H extends LiveBlock>(
  clock: PeriodClock,
  opensAt: bigint,
  closesAt: bigint,
  liveEvery: number,
  blocks: readonly H[],
):
  | { readonly ok: true; readonly snapshots: readonly (LiveSnapshot & { readonly head: H })[] }
  | {
      readonly ok: false;
      readonly code: "l1-blocks-short";
      readonly at: { readonly snapshot: number };
    } {
  const segments = scheduledSnapshots(clock, opensAt, closesAt, liveEvery);
  const first = blocks[0];
  const last = blocks.at(-1);
  const snapshots: (LiveSnapshot & { readonly head: H })[] = [];
  for (const [i, sigma] of segments.entries()) {
    const end = clock.epoch + (sigma + 1n) * clock.period;
    if (first === undefined || last === undefined || first.timestamp >= end || last.timestamp < end)
      return { ok: false, code: "l1-blocks-short", at: { snapshot: i + 1 } };
    // The last block before `end`: timestamps increase along the run, and
    // the first block is before it, so one exists.
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((blocks[mid] as H).timestamp < end) lo = mid;
      else hi = mid - 1;
    }
    snapshots.push({ segment: Number(sigma), head: blocks[lo] as H });
  }
  return { ok: true, snapshots };
}

/**
 * One ballot copy of the anchored extent ([Releases](#releases), step 3): a
 * ballot entry of either path that decodes, carries the definition's
 * `election_id` and names its tier (5.4's `ballot-tier` or `ballot-cell`
 * passing), with the admission results that don't depend on the head and
 * the ones that do, as the verifier's own checks found them.
 */
export interface LiveCopy<N extends LiveKey, B extends LiveKey> {
  /** Its entry's position on the copy; copies are read in this order. */
  readonly entry: number;
  readonly segment: number;
  /** Its nullifier, unique across tiers (nullifiers are scoped per tier, so prefix one with its tier). */
  readonly nullifier: N;
  /** Its message `M`: copies with the same `M` are one ballot (5.7). */
  readonly ballot: B;
  /** The cell it names, by position in the registered partition. */
  readonly cell: number;
  /** The L1 block from which the rolling step its membership check needs is final, or `null` if it needs none. */
  readonly stepFinalAt: bigint | null;
  /** Whether its membership check (5.1 to 5.3) passes once that step is final. */
  readonly member: boolean;
  /**
   * Whether it fails any admission check but membership, a reference above
   * the head and an unknown reference: 5.4, 5.5, 5.7, 5.8's other codes
   * (`l1-ref-before-open`, `l1-ref-after-close`) and a rolling step's
   * (`root-step-stale`, `root-step-future`). Each of those is fixed whatever
   * the head, so one left out here would let a ballot enter a running set no
   * honest node's holds, and every honest seat's opening of that release
   * would read as over another aggregate (T-29, T-16).
   */
  readonly rejected: boolean;
  /** The L1 block number its reference names (5.8). */
  readonly reference: bigint;
  /** Whether the run of finalized headers holds the block its reference names, by number and hash. */
  readonly referenceKnown: boolean;
  /**
   * The least segment by whose end the copy holds, for this ballot, a share
   * receipt passing [[delivery]]'s receipt checks from every qualified seat
   * of every panel the definition has, each read by its entry's segment, or
   * `null` if it never does. A batch's pair never counts: ballot versions 4
   * and 5 fix no batch version.
   */
  readonly receiptedAt: number | null;
}

/** How a copy stands in snapshot `S_r` with `h_r` as the L1 head: only `non-member` and `absent` don't count. */
export type CopyStatus = "absent" | "pending" | "non-member" | "rejected" | "admitted";

/**
 * A copy's standing at a snapshot ([Releases](#releases), step 3): absent
 * after `σ_r`; pending while the rolling step it needs isn't final at `h_r`;
 * then not counting if its membership check fails; rejected if another
 * check does; pending if its L1 reference is above `h_r`; rejected if the
 * run doesn't hold the block it names; otherwise admitted. A pending or
 * rejected copy counts towards the one-ballot rule, so a coercer's first
 * ballot, or one bound to fail, keeps a re-vote from entering alone (T-45).
 */
export function copyStatus(
  copy: LiveCopy<LiveKey, LiveKey>,
  segment: number,
  head: bigint,
): CopyStatus {
  if (copy.segment > segment) return "absent";
  if (copy.stepFinalAt !== null && copy.stepFinalAt > head) return "pending";
  if (!copy.member) return "non-member";
  if (copy.rejected) return "rejected";
  if (copy.reference > head) return "pending";
  if (!copy.referenceKnown) return "rejected";
  return "admitted";
}

const counts = (s: CopyStatus) => s === "pending" || s === "rejected" || s === "admitted";

/** Steps 2 to 4: the snapshots, every cell's running sets and each tier's release choice. */
export interface LiveRunning<N extends LiveKey, B extends LiveKey> {
  /** Each cell's tier, by position in the registered partition. */
  readonly cellTiers: readonly number[];
  readonly snapshots: readonly LiveSnapshot[];
  /** Per cell, `R_0, …, R_N`, `R_0` the empty set. */
  readonly sets: readonly (readonly RunningSet<N, B>[])[];
  /** Per tier, in ascending order, its decisions and releases. */
  readonly choices: ReadonlyMap<number, ReleaseChoice>;
  /** Each ballot's first copy's entry, which the report lists ballots by. */
  readonly firstEntry: ReadonlyMap<B, number>;
}

/**
 * The running sets and release choice ([Releases](#releases), steps 3 and
 * 4) from every copy of the anchored extent. For each tier and each
 * nullifier not yet in one of its running sets, each of its ballots in
 * `S_r` counts if any of its copies counts and is admitted if any is (a
 * copy that fails is never an earlier ballot, R4), standing for itself by
 * its first admitted copy, else its first counting one: its cell and
 * whether it is fully receipted in `S_r` are that copy's. So a copy the
 * operator boards with a broken proof ahead of a voter's real one, or one
 * rejected for its own window ahead of a timely one, changes nothing. The
 * nullifier enters with exactly one counting ballot that is admitted and
 * fully receipted, and stays with it (crypto's `runningSets`; T-16, T-45).
 */
export function liveRunning<N extends LiveKey, B extends LiveKey>(input: {
  readonly cellTiers: readonly number[];
  readonly snapshots: readonly LiveSnapshot[];
  readonly copies: readonly LiveCopy<N, B>[];
  /** The definition's `live_batch`. */
  readonly batch: number;
}): LiveRunning<N, B> {
  const { cellTiers, snapshots, batch } = input;
  if (cellTiers.length < 1 || cellTiers.length > 256)
    throw new RangeError("liveRunning: from 1 to 256 cells");
  for (const [i, s] of snapshots.entries()) {
    const prev = snapshots[i - 1];
    if (prev !== undefined && (s.segment <= prev.segment || s.head.number < prev.head.number))
      throw new RangeError("liveRunning: snapshots ascend, their heads never fall");
  }
  const copies = [...input.copies].sort((a, b) => a.entry - b.entry);
  for (const [i, c] of copies.entries())
    if (i > 0 && (copies[i - 1] as LiveCopy<N, B>).entry === c.entry)
      throw new RangeError(`liveRunning: two copies at entry ${c.entry}`);
  const firstEntry = new Map<B, number>();
  for (const c of copies) {
    if (!Number.isInteger(c.cell) || c.cell < 0 || c.cell >= cellTiers.length)
      throw new RangeError(`liveRunning: entry ${c.entry} names no cell of the partition`);
    if (!firstEntry.has(c.ballot)) firstEntry.set(c.ballot, c.entry);
  }
  const sets: RunningSet<N, B>[][] = cellTiers.map(() => []);
  const choices = new Map<number, ReleaseChoice>();
  for (const tier of [...new Set(cellTiers)].sort((a, b) => a - b)) {
    const cells = cellTiers.flatMap((t, c) => (t === tier ? [c] : []));
    const local = new Map(cells.map((c, i) => [c, i] as const));
    const own = copies.filter((c) => local.has(c.cell));
    const perSnapshot = snapshots.map(({ segment, head }) => {
      // Per nullifier, per ballot, its copies in `S_r` that count.
      const byNullifier = new Map<N, Map<B, { copy: LiveCopy<N, B>; status: CopyStatus }[]>>();
      for (const copy of own) {
        const status = copyStatus(copy, segment, head.number);
        if (!counts(status)) continue;
        let ballots = byNullifier.get(copy.nullifier);
        if (ballots === undefined) byNullifier.set(copy.nullifier, (ballots = new Map()));
        let held = ballots.get(copy.ballot);
        if (held === undefined) ballots.set(copy.ballot, (held = []));
        held.push({ copy, status });
      }
      const out = new Map<N, SnapshotBallot<B>[]>();
      for (const [n, ballots] of byNullifier)
        out.set(
          n,
          [...ballots].map(([ballot, held]) => {
            const admitted = held.find((h) => h.status === "admitted");
            const stand = (admitted ?? held[0]) as { copy: LiveCopy<N, B> };
            const { receiptedAt } = stand.copy;
            return {
              ballot,
              cell: local.get(stand.copy.cell) as number,
              admission:
                admitted !== undefined
                  ? "admitted"
                  : held.some((h) => h.status === "pending")
                    ? "pending"
                    : "rejected",
              fullyReceipted: receiptedAt !== null && receiptedAt <= segment,
            };
          }),
        );
      return out;
    });
    const tierSets = runningSets<N, B>(cells.length, perSnapshot);
    for (const [i, c] of cells.entries()) sets[c] = tierSets[i] as RunningSet<N, B>[];
    choices.set(tier, chooseReleases(tierSets, batch));
  }
  return { cellTiers, snapshots, sets, choices, firstEntry };
}

/** A running opening's check against `R_{q,c}`, the set its snapshot names. */
export type OpeningVerdict =
  | { readonly passes: true }
  | { readonly passes: false; readonly reason: "aggregate" }
  | { readonly passes: false; readonly reason: "opening"; readonly option: number };

/**
 * One running-opening payload of the anchored extent, as far as its breaks
 * read it: one that doesn't decode under version 1, or its fields with its
 * check against the running set its snapshot names.
 */
export type RunningOpeningFacts =
  | { readonly entry: number; readonly decodeError: DecodeErrorCode }
  | {
      readonly entry: number;
      /** Whether its `definition_hash` is the definition's. */
      readonly thisElection: boolean;
      readonly cell: number;
      readonly snapshot: number;
      /** The seat its signature attributes it to, or `null`. */
      readonly signer: number | null;
      /** Its number of `(V, R)` entries. */
      readonly entries: number;
      /** Its signed message `m`: a replay carries the same one. */
      readonly message: string;
      /** Its `(V, R)` list: two passing openings of one release and cell with different lists break binding. */
      readonly opening: string;
      /** Its `V` per option. */
      readonly counts: readonly bigint[];
      /**
       * Against `R_{snapshot,cell}`, present exactly when it names this
       * election, a cell of the partition and a scheduled snapshot, and
       * carries `m` entries.
       */
      readonly verdict?: OpeningVerdict;
    };

/**
 * Every running-opening payload's facts, by @abolishus/crypto's
 * `readRunningOpenings` judging each one against the running set its
 * snapshot names, as if every scheduled snapshot were a release: whether
 * each was chosen is `liveReleases`' to decide, and an unscheduled opening
 * that would pass is a disclosure ([Releases](#releases), step 5). `vss`
 * gives the VSS of the ballot a nullifier entered with; each running set's
 * aggregate is computed once. `entries` are the payloads' positions on the
 * copy.
 */
export function runningOpeningFacts<N extends LiveKey, B extends LiveKey>(
  election: Pick<TallyElection, "definitionHash" | "rules" | "registered">,
  running: LiveRunning<N, B>,
  payloads: readonly { readonly entry: number; readonly payload: Uint8Array }[],
  vss: (ballot: B) => CommittedVote["vss"],
): RunningOpeningFacts[] {
  const scheduled = Array.from({ length: running.snapshots.length }, (_, i) => i + 1);
  const read = readRunningOpenings(
    election,
    {
      cellTiers: running.cellTiers,
      chosen: new Map([...new Set(running.cellTiers)].map((t) => [t, scheduled] as const)),
      runningSet: (cell, snapshot) => {
        const set = running.sets[cell]?.[snapshot];
        if (set === undefined) throw new RangeError("runningOpeningFacts: no such running set");
        return [...set.values()].map(vss);
      },
    },
    payloads.map((p) => p.payload),
  );
  return payloads.map(({ entry, payload }, i): RunningOpeningFacts => {
    const judged = read.entries[i] as RunningOpeningEntry;
    if (judged.kind === "rejected") return { entry, decodeError: judged.error };
    let o;
    try {
      o = decodeRunningOpening(payload, 1);
    } catch (e) {
      // `readRunningOpenings` decoded the same bytes.
      if (e instanceof DecodeError) throw new Error("runningOpeningFacts: decoders disagree");
      throw e;
    }
    const facts = {
      entry,
      thisElection: bytesToHex(o.definition_hash) === bytesToHex(election.definitionHash),
      cell: o.cell,
      snapshot: o.snapshot,
      signer: judged.signer,
      entries: o.opening.length,
      message: bytesToHex(runningOpeningStatement(o)),
      opening: o.opening.map(({ v, r }) => `${v}:${r}`).join(","),
      counts: o.opening.map(({ v }) => v),
    };
    if (judged.kind !== "release") return facts;
    if (judged.passes) return { ...facts, verdict: { passes: true } };
    switch (judged.reason) {
      // Its entries aren't `m`: `running-missing`, with no check against the set.
      case "entries":
        return facts;
      case "aggregate":
        return { ...facts, verdict: { passes: false, reason: "aggregate" } };
      case "opening":
        return { ...facts, verdict: { passes: false, reason: "opening", option: judged.option } };
    }
  });
}

/** A break of the boarding rule ([[tally]], Running opening record, Boarding), in the order step 5 lists them. */
export type RunningBreak =
  | { readonly code: "running-stray" }
  | { readonly code: "running-unscheduled" }
  | { readonly code: "running-missing" }
  | { readonly code: "running-aggregate" }
  | { readonly code: "running-opening"; readonly option: number }
  | { readonly code: "running-unattributed" }
  /** `of`: the first earlier entry with an opening of the release and cell by the same seat, over another message. */
  | { readonly code: "running-second"; readonly of: number }
  /** `of`: the same, over the same message, which anyone can replay: the operator's alone (T-29). */
  | { readonly code: "running-repeat"; readonly of: number };

/** One running-opening entry of the report, in copy order. */
export type RunningOpeningReport =
  | { readonly entry: number; readonly code: "decode"; readonly decodeError: DecodeErrorCode }
  | {
      readonly entry: number;
      readonly cell: number;
      readonly snapshot: number;
      readonly signer: number | null;
      readonly kind: "release" | "outside-schedule";
      /** For an opening of a release. */
      readonly passes?: boolean;
      /** For an unscheduled one: whether it opens the running set its snapshot names. */
      readonly discloses?: boolean;
      readonly breaks: readonly RunningBreak[];
      /** The seat reported beside the operator, or `null`. */
      readonly blamed: number | null;
    };

/** One decision of a tier, with each earlier candidate tried and the rule it failed. */
export interface DecisionReport {
  readonly at: number;
  readonly release: number | null;
  readonly refused: readonly { readonly snapshot: number; readonly rule: ReleaseRefusal }[];
}

export interface TierReleasesReport {
  readonly tier: number;
  readonly decisions: readonly DecisionReport[];
  /** Each chosen release, with the per-option sums of its cells' counts where every cell has some, as decimal strings. */
  readonly releases: readonly {
    readonly snapshot: number;
    readonly counts: readonly string[] | null;
  }[];
}

/** The least non-empty side of any combination of a tier's releases and the final tally in a cell. */
export interface FinalBatchReport {
  /** `d`, or `null` if no release and not the final tally holds a ballot. */
  readonly cut: number | null;
  /** `d < B`: never fails or withholds anything (T-16, T-45). */
  readonly flagged: boolean;
  readonly side: {
    readonly kind: "uncounted" | "unreleased" | "counted" | "entered";
    readonly release: number | null;
    /** By their first copy's entry, ascending. */
    readonly ballots: readonly number[];
  } | null;
}

export interface CellReleasesReport {
  readonly cell: number;
  readonly tier: number;
  readonly releases: readonly {
    readonly snapshot: number;
    /** `|R_{q,c}|`. */
    readonly size: number;
    /** The nullifiers that entered since the previous chosen release. */
    readonly entered: number;
    /** From its first passing opening, or `null` if none passes: the release was skipped in this cell. */
    readonly counts: readonly string[] | null;
    /** The seats its passing openings are attributed to, ascending. */
    readonly signers: readonly number[];
  }[];
  /** `null` when the tier chose no release. */
  readonly finalBatch: FinalBatchReport | null;
}

export type ReleaseRowCode =
  | "running-conflict"
  | "running-range"
  | "running-question-range"
  | "decode"
  | RunningBreak["code"];

export interface ReleaseRow {
  readonly status: "pass" | "fail";
  readonly code?: ReleaseRowCode;
  readonly at?:
    | {
        readonly cell: number;
        readonly snapshot: number;
        readonly option?: number;
        readonly question?: number;
      }
    | { readonly entry: number; readonly decodeError?: DecodeErrorCode };
}

export interface LiveReleases {
  readonly rows: { readonly "7.5": ReleaseRow; readonly "7.6": ReleaseRow };
  readonly tiers: readonly TierReleasesReport[];
  readonly cells: readonly CellReleasesReport[];
  readonly openings: readonly RunningOpeningReport[];
}

/**
 * Steps 5 to 7 over `running`: every running opening's breaks and whom each
 * is reported against, each release's totals per cell and tier, 7.5's and
 * 7.6's rows, and per cell the final tally's least side against its tier's
 * releases. `counted` is each cell's counted set (7.1), the ballots the
 * final tally counts; `rules` the definition's option total and its
 * questions' limits, which every live definition (version 6 or 7) has, the
 * same rules `runningOpeningFacts` judged the openings with.
 */
export function liveReleases<N extends LiveKey, B extends LiveKey>(input: {
  readonly running: LiveRunning<N, B>;
  readonly rules: { readonly optionCount: number; readonly questions: readonly QuestionRules[] };
  readonly batch: number;
  readonly openings: readonly RunningOpeningFacts[];
  readonly counted: readonly ReadonlySet<B>[];
}): LiveReleases {
  const { running, rules, batch } = input;
  const { cellTiers, sets, choices } = running;
  const scheduled = running.snapshots.length;
  const chosen = (cell: number) => choices.get(cellTiers[cell] as number)?.releases ?? [];
  if (input.counted.length !== cellTiers.length)
    throw new RangeError("liveReleases: one counted set per cell");

  // Step 5: the breaks.
  const firstBySeat = new Map<string, { entry: number; message: string }>();
  const passing = new Map<
    string,
    { opening: string; counts: readonly bigint[]; signer: number | null }[]
  >();
  // Copy order decides which earlier opening a repeat or second points to
  // and which passing opening gives a release's counts, so it is enforced,
  // never assumed (T-29).
  for (const [i, o] of input.openings.entries())
    if (i > 0 && (input.openings[i - 1] as RunningOpeningFacts).entry >= o.entry)
      throw new RangeError("liveReleases: openings must be given in copy order, one per entry");
  const openings = input.openings.map((o): RunningOpeningReport => {
    if ("decodeError" in o) return { entry: o.entry, code: "decode", decodeError: o.decodeError };
    const breaks: RunningBreak[] = [];
    const verdict = () => {
      if (o.verdict === undefined)
        throw new RangeError(
          `liveReleases: entry ${o.entry} has no verdict against its running set`,
        );
      return o.verdict;
    };
    let kind: "release" | "outside-schedule" = "outside-schedule";
    let judged: { readonly passes?: boolean; readonly discloses?: boolean };
    if (!o.thisElection || o.cell >= cellTiers.length) {
      breaks.push({ code: "running-stray" });
      judged = {};
    } else if (!chosen(o.cell).includes(o.snapshot)) {
      breaks.push({ code: "running-unscheduled" });
      if (o.entries !== rules.optionCount) breaks.push({ code: "running-missing" });
      // A count over a set the batch rule never bounded against the
      // releases (T-16).
      judged = {
        discloses:
          o.snapshot >= 1 &&
          o.snapshot <= scheduled &&
          o.entries === rules.optionCount &&
          verdict().passes,
      };
    } else {
      kind = "release";
      if (o.entries !== rules.optionCount) breaks.push({ code: "running-missing" });
      else {
        const v = verdict();
        if (!v.passes)
          breaks.push(
            v.reason === "aggregate"
              ? { code: "running-aggregate" }
              : { code: "running-opening", option: v.option },
          );
      }
      const passes = breaks.length === 0;
      if (passes) {
        const key = `${o.cell}/${o.snapshot}`;
        let list = passing.get(key);
        if (list === undefined) passing.set(key, (list = []));
        list.push({ opening: o.opening, counts: o.counts, signer: o.signer });
      }
      judged = { passes };
    }
    if (o.signer === null) breaks.push({ code: "running-unattributed" });
    else if (kind === "release") {
      const key = `${o.cell}/${o.snapshot}/${o.signer}`;
      const first = firstBySeat.get(key);
      if (first === undefined) firstBySeat.set(key, { entry: o.entry, message: o.message });
      else
        breaks.push(
          first.message === o.message
            ? { code: "running-repeat", of: first.entry }
            : { code: "running-second", of: first.entry },
        );
    }
    // Every break is the operator's; all but a replay also its signer's,
    // since the board checks passed and a seat signs only a release it
    // computed (T-29).
    const blamed =
      o.signer !== null && breaks.some((b) => b.code !== "running-repeat") ? o.signer : null;
    return {
      entry: o.entry,
      cell: o.cell,
      snapshot: o.snapshot,
      signer: o.signer,
      kind,
      ...judged,
      breaks,
      blamed,
    };
  });

  // Each chosen release per cell.
  const cells = cellTiers.map((tier, c): CellReleasesReport => {
    const releases = chosen(c);
    const setsOf = sets[c] as readonly RunningSet<N, B>[];
    let previous = 0;
    const rows = releases.map((q) => {
      const set = setsOf[q] as RunningSet<N, B>;
      const pass = passing.get(`${c}/${q}`) ?? [];
      const row = {
        snapshot: q,
        size: set.size,
        entered: runningEntries(setsOf[previous] as RunningSet<N, B>, set),
        counts: pass[0]?.counts.map(String) ?? null,
        signers: [...new Set(pass.flatMap((p) => (p.signer === null ? [] : [p.signer])))].sort(
          (a, b) => a - b,
        ),
      };
      previous = q;
      return row;
    });
    const finalBatch =
      releases.length === 0
        ? null
        : finalSide(
            releases.map((q) => setsOf[q] as RunningSet<N, B>),
            input.counted[c] as ReadonlySet<B>,
            running.firstEntry,
            batch,
          );
    return { cell: c, tier, releases: rows, finalBatch };
  });

  const tiers = [...choices].map(([tier, choice]): TierReleasesReport => {
    const own = cells.filter((c) => c.tier === tier);
    return {
      tier,
      decisions: choice.decisions.map((d) => ({
        at: d.at,
        release: d.release,
        refused: [...d.refused].map(([snapshot, rule]) => ({ snapshot, rule })),
      })),
      releases: choice.releases.map((snapshot, i) => {
        const got = own.map((c) => c.releases[i]?.counts ?? null);
        const all = got.every((g) => g !== null) ? (got as (readonly string[])[]) : null;
        return {
          snapshot,
          // A tier's running totals are its cells' sums, never another tier's.
          counts:
            all === null
              ? null
              : Array.from({ length: rules.optionCount }, (_, j) =>
                  String(all.reduce((s, g) => s + BigInt(g[j] as string), 0n)),
                ),
        };
      }),
    };
  });

  return {
    rows: { "7.5": row75(cells, passing, rules), "7.6": row76(openings) },
    tiers,
    cells,
    openings,
  };
}

/**
 * 7.5 ([Releases](#releases), step 6): over each cell and each chosen release
 * of its tier, `running-conflict` if two passing openings have different
 * `(V, R)` lists (different signers and signatures are no conflict), then on
 * the first passing one `running-range` for a count above `|R_{q,c}|` and
 * `running-question-range` for a question whose total lies outside its
 * limits times `|R_{q,c}|`: none of them is possible under binding, since
 * every entering ballot passed its validity proofs (T-29, T-16).
 */
function row75(
  cells: readonly CellReleasesReport[],
  passing: ReadonlyMap<string, readonly { opening: string; counts: readonly bigint[] }[]>,
  rules: { readonly optionCount: number; readonly questions: readonly QuestionRules[] },
): ReleaseRow {
  for (const cell of cells)
    for (const release of cell.releases) {
      const pass = passing.get(`${cell.cell}/${release.snapshot}`) ?? [];
      const first = pass[0];
      if (first === undefined) continue;
      const at = { cell: cell.cell, snapshot: release.snapshot };
      if (pass.some((p) => p.opening !== first.opening))
        return { status: "fail", code: "running-conflict", at };
      const size = BigInt(release.size);
      // `V_j` decodes as an integer from 0 to ℓ − 1, so a count above the
      // set's size is its own break, not a negative one.
      const option = first.counts.findIndex((v) => v > size);
      if (option !== -1) return { status: "fail", code: "running-range", at: { ...at, option } };
      let start = 0;
      for (const [question, q] of rules.questions.entries()) {
        const total = first.counts.slice(start, start + q.optionCount).reduce((s, v) => s + v, 0n);
        if (total < BigInt(q.minSelections) * size || total > BigInt(q.maxSelections) * size)
          return { status: "fail", code: "running-question-range", at: { ...at, question } };
        start += q.optionCount;
      }
    }
  return { status: "pass" };
}

/** 7.6, report-only: the first running opening that doesn't decode or breaks the boarding rule. */
function row76(openings: readonly RunningOpeningReport[]): ReleaseRow {
  for (const o of openings) {
    if ("code" in o)
      return { status: "fail", code: "decode", at: { entry: o.entry, decodeError: o.decodeError } };
    const first = o.breaks[0];
    if (first !== undefined) return { status: "fail", code: first.code, at: { entry: o.entry } };
  }
  return { status: "pass" };
}

/**
 * The final tally against a cell's releases ([Releases](#releases), step 7),
 * by the closed form: with `x_u` the ballots that first entered at release
 * `u + 1` and are counted, `y_u` those that entered there and aren't, and
 * `z` the counted ballots in no release, `d` is the least non-zero size
 * among each `y_u`; `z`, or each `x_u` if `z` is empty; and each
 * `x_u ∪ y_u`, the side the first of those in that order. These are the
 * edges entering every vertex set of the release graph with the final tally
 * as its last vertex, so `d` is its least positive directed cut (T-16, T-45).
 */
function finalSide<N extends LiveKey, B extends LiveKey>(
  releases: readonly RunningSet<N, B>[],
  counted: ReadonlySet<B>,
  firstEntry: ReadonlyMap<B, number>,
  batch: number,
): FinalBatchReport {
  const entered = new Map<B, number>();
  for (const [u, set] of releases.entries())
    for (const b of set.values()) if (!entered.has(b)) entered.set(b, u);
  const x: B[][] = releases.map(() => []);
  const y: B[][] = releases.map(() => []);
  for (const [b, u] of entered) (counted.has(b) ? x : y)[u]?.push(b);
  const z = [...counted].filter((b) => !entered.has(b));
  type Kind = NonNullable<FinalBatchReport["side"]>["kind"];
  const candidates: { kind: Kind; release: number | null; ballots: readonly B[] }[] = [
    ...y.map((ballots, u) => ({ kind: "uncounted" as const, release: u + 1, ballots })),
    ...(z.length > 0
      ? [{ kind: "unreleased" as const, release: null, ballots: z }]
      : x.map((ballots, u) => ({ kind: "counted" as const, release: u + 1, ballots }))),
    ...x.map((ballots, u) => ({
      kind: "entered" as const,
      release: u + 1,
      ballots: [...ballots, ...(y[u] as B[])],
    })),
  ];
  let side: (typeof candidates)[number] | undefined;
  for (const c of candidates)
    if (c.ballots.length > 0 && (side === undefined || c.ballots.length < side.ballots.length))
      side = c;
  if (side === undefined) return { cut: null, flagged: false, side: null };
  const entry = (b: B) => {
    const e = firstEntry.get(b);
    if (e === undefined)
      throw new RangeError("liveReleases: a ballot in a release or the final tally has no copy");
    return e;
  };
  return {
    cut: side.ballots.length,
    flagged: side.ballots.length < batch,
    side: {
      kind: side.kind,
      release: side.release,
      ballots: side.ballots.map(entry).sort((a, b) => a - b),
    },
  };
}
