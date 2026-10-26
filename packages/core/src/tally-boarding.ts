// The board path for tally openings (docs/spec/tally.md, Opening record,
// Boarding): the operator boards an opening only if @abolishus/crypto's
// Boarding judge passes it against each cell's aggregate over the anchored
// counted set, which packages/verifier's `countedTally` computes from the
// operator's own board through the counted checkpoint, so what the operator
// boards is judged over the set the verifier recomputes and never by code
// outside the gate (AGENTS.md, The verifier's trust base; T-29, T-17). A
// boarded opening carries no chosen bytes beyond a registered seat's
// signature nonce, at most one per seat and cell, and no summed shares
// dressed as a failing opening (T-15, T-17). A seat's node resends its
// opening until the seal, so a repeat is answered with the entry already
// boarded (Resending). Nothing here sees who sent an opening (T-10).

import {
  type CellAggregate,
  checkpointHash,
  countedExtent,
  DecodeError,
  decodeBoardEntry,
  L1_REF_MARGIN,
  type Panel,
  panelId,
  type TallyElection,
  tallyOpeningBoarding,
  type WholeOpeningVersion,
} from "@abolishus/crypto";
import { countedTally, type L1Header } from "@abolishus/verifier";
import type { Sql } from "postgres";
import { type AnchorChain, readCheckpoints } from "./anchoring.ts";
import {
  appendEntry,
  type AppendedEntry,
  AppendError,
  boardVersion,
  readBoard,
  readBoardedOpenings,
} from "./board.ts";
import { isBytes } from "./bytes.ts";
import { decodeStoredDefinition, readDefinition } from "./definitions.ts";

const MAX_SEGMENT = 2 ** 32 - 1;

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Finalized L1 headers, as one node reports them, for 5.8's run. */
export interface L1HeaderRun {
  /** The node's EIP-155 chain ID, checked when the run was made. */
  readonly chainId: bigint;
  /**
   * A run of finalized L1 headers, each the parent of the next, from the
   * last block before `before` (or block 0) to the first after `after`, as
   * packages/verifier's `countedSet` takes it: shorter while finalized L1
   * hasn't passed `after`, so the set waits on it.
   */
  run(window: { readonly before: bigint; readonly after: bigint }): Promise<readonly L1Header[]>;
}

/** The anchored counted set's tally for one election, as `countedTally` gives it. */
export type CountedTally =
  | {
      readonly state: "fixed";
      readonly election: TallyElection;
      readonly aggregates: readonly CellAggregate[];
      readonly pinned: WholeOpeningVersion;
    }
  /** Not yet decided: before `t_S`, or while finalized L1 hasn't reached every ballot's reference. */
  | { readonly state: "waiting" }
  /** Never decided by this release from this board: no opening of the election is boarded. */
  | { readonly state: "refused"; readonly reason: string };

export interface AnchoredCountedTallyOptions {
  /** The trustee panels this release pins, as `BallotAdmissions` takes them. */
  readonly panels: readonly Panel[];
  /** The anchor contract the operator's boards are anchored to, read only. */
  readonly anchor: Pick<AnchorChain, "chainId" | "address" | "clock" | "now" | "anchored">;
  /** Finalized L1 headers from a node on the anchor's chain. */
  readonly l1: L1HeaderRun;
}

// Undecided outcomes a later read of finalized L1 can settle, at 5.8 only:
// elsewhere `not-reached` waits on authenticated contract events (6.1, 5.9),
// which this source never claims (below), so it never settles here.
const GROWS: ReadonlySet<string> = new Set(["l1-ref-pending", "l1-blocks-short", "not-reached"]);

/**
 * How far, in seconds, the anchor's latest block must be past `t_S` before
 * the anchor's state is taken as final: the L1 finality term of the
 * contract-event window (docs/spec/tally.md, Tally window). An anchor
 * included just before `t_S` in a block later reorganised away would
 * otherwise fix, for the process's life, a checkpoint finalized L1 never
 * holds (T-24, T-54).
 */
export const ANCHOR_FINALITY_MARGIN = 1_800n;

/**
 * The operator's source of the counted tally: `countedTally` over its own
 * board through `C_S`, the latest checkpoint at or before `s_S`, once `t_S`
 * has passed by the anchor's L1 time, by `ANCHOR_FINALITY_MARGIN`, and the
 * anchor holds that checkpoint,
 * so the extent is the anchored one, which no later entry changes (T-24,
 * T-29). Before `t_S` it waits: a checkpoint at or before `s_S` may still be
 * anchored. After it, no checkpoint taken here at or before `s_S` that the
 * anchor doesn't hold ever will be, so the board fails its checks and the
 * election is refused, as it is when the operator's board has an entry at
 * or before `s_S` past `C_S`, when the definition names another anchor or
 * L1, or when the set is undecided for a reason no later read settles.
 *
 * Contract events are never claimed authenticated: the operator boards no
 * contract-event record yet, and one on the board would leave the set
 * undecided at 6.1 rather than trusted unread (T-35, T-71). Throws when the
 * anchor or the L1 node can't be read; the caller tries again.
 */
export function anchoredCountedTally(
  options: AnchoredCountedTallyOptions,
): (client: Sql, electionId: Uint8Array) => Promise<CountedTally> {
  const { panels, anchor, l1 } = options;
  if (panels.length === 0) throw new RangeError("panels must name at least one panel");
  // A malformed panel throws PanelError here, at start, not on an opening.
  for (const panel of panels) panelId(panel);
  if (l1.chainId !== anchor.chainId)
    throw new RangeError("the L1 node must be on the anchor's chain");
  if (!isBytes(anchor.address) || anchor.address.length !== 20)
    throw new TypeError("the anchor's address must be 20 bytes");
  return async (client, electionId) => {
    const definition = await readDefinition(client, electionId);
    if (definition === undefined) throw new OpeningError("unknown-election");
    let d;
    try {
      d = decodeStoredDefinition(definition).value;
    } catch (e) {
      if (e instanceof DecodeError) return { state: "refused", reason: "an unread definition" };
      throw e;
    }
    // Its verifier reads no other anchor's checkpoints (T-52).
    if (d.l1_chain_id !== anchor.chainId || !equal(d.l1_anchor, anchor.address))
      return { state: "refused", reason: "a definition naming another anchor" };
    const { clock } = anchor;
    // 2.6 fails a definition opening before the clock's epoch.
    if (d.closes_at < clock.epoch)
      return { state: "refused", reason: "a close before the anchoring clock's epoch" };
    const extent = countedExtent(clock, d.closes_at, BigInt(d.l1_inclusion_bound));
    if (extent.segment > BigInt(MAX_SEGMENT))
      return { state: "refused", reason: "s_S past the last segment" };
    const sS = Number(extent.segment);
    // By the anchor's own time, which judges whether a checkpoint is timely.
    if ((await anchor.now()) <= extent.due + ANCHOR_FINALITY_MARGIN) return { state: "waiting" };
    let counted;
    for (const checkpoint of await readCheckpoints(client, electionId))
      if (checkpoint.segment <= sS) counted = checkpoint;
    if (counted === undefined)
      return { state: "refused", reason: "no checkpoint at or before s_S was taken" };
    const held = await anchor.anchored(electionId, counted.segment);
    if (held === undefined || !equal(held, checkpointHash(counted)))
      return { state: "refused", reason: "the anchor doesn't hold the counted checkpoint" };
    const version = await boardVersion(client, electionId);
    if (typeof version === "string") return { state: "refused", reason: version };
    const board = await readBoard(client, electionId);
    const size = Number(counted.size);
    // A board shorter than a checkpoint taken from it was written around appendEntry.
    if (board.length < size)
      return { state: "refused", reason: "a board shorter than its counted checkpoint" };
    // An entry at or before `s_S` past the checkpoint was never anchored: the
    // anchored extent isn't this board's.
    for (const encoded of board.slice(size))
      if (decodeBoardEntry(encoded, version).segment <= sS)
        return {
          state: "refused",
          reason: "an entry at or before s_S past the counted checkpoint",
        };
    const blocks = await l1.run({
      before: d.opens_at > L1_REF_MARGIN ? d.opens_at - L1_REF_MARGIN : 0n,
      after: d.closes_at,
    });
    for (const panel of panels) {
      let result;
      try {
        result = countedTally({
          definition,
          panel,
          entries: board.slice(0, size),
          clock: { ...clock, lastSegment: sS },
          blocks,
          eventsAuthenticated: false,
        });
      } catch (e) {
        // The entries aren't the counted extent the board checks pass.
        if (e instanceof RangeError) return { state: "refused", reason: e.message };
        throw e;
      }
      if (result.ok)
        return {
          state: "fixed",
          election: result.election,
          aggregates: result.aggregates,
          pinned: result.pinned,
        };
      if ("code" in result) {
        if (result.code === "panel-unpinned") continue;
        return { state: "refused", reason: `no ballot can be admitted: ${result.code}` };
      }
      const code = result.outcome.code ?? "";
      if (GROWS.has(code) && result.row === "5.8") return { state: "waiting" };
      return { state: "refused", reason: `the counted set is undecided at ${result.row}: ${code}` };
    }
    return { state: "refused", reason: "the definition names no pinned panel" };
  };
}

export type OpeningErrorCode =
  /** No definition is stored for the election. */
  | "unknown-election"
  /** The counted set isn't fixed yet (before `t_S`, or L1 hasn't reached a reference): try again later. */
  | "not-ready"
  /** This operator never boards an opening of the election (`CountedTally`'s `refused`). */
  | "not-open"
  /** The Boarding judge refuses the opening. */
  | "rejected";

/**
 * Why an opening was refused: crypto's Boarding codes, but for
 * `tally-repeat`, which is answered with the entry already boarded.
 */
export type OpeningRejectionCode =
  | "decode"
  | "tally-stray"
  | "tally-missing"
  | "tally-aggregate"
  | "tally-opening"
  | "tally-unattributed"
  | "tally-second";

export class OpeningError extends Error {
  override readonly name = "OpeningError";
  readonly code: OpeningErrorCode;
  /** Under `rejected`: why. */
  readonly rejection?: OpeningRejectionCode;
  constructor(code: OpeningErrorCode, rejection?: OpeningRejectionCode) {
    super(`tally opening refused: ${code}${rejection === undefined ? "" : ` (${rejection})`}`);
    this.code = code;
    if (rejection !== undefined) this.rejection = rejection;
  }
}

export interface OpeningBoardingOptions {
  /** Each election's counted tally: `anchoredCountedTally`'s in a deployment. */
  readonly tally: (client: Sql, electionId: Uint8Array) => Promise<CountedTally>;
  /** The anchoring clock: it labels each entry's segment. */
  readonly clock: { readonly epoch: bigint; readonly period: bigint };
  /** Elections whose counted tally is kept in memory once decided (default 256). */
  readonly cacheSize?: number;
  /** How long a `waiting` answer is kept before the tally is asked again (default 60 s). */
  readonly waitMs?: number;
  /** Milliseconds, for `waitMs`; `Date.now` unless a test moves it. */
  readonly nowMs?: () => number;
}

type Decided = Exclude<CountedTally, { readonly state: "waiting" }>;

/**
 * Judges and boards tally openings. One per process: each election's counted
 * tally, once decided, is kept, so an opening costs its own checks, never a
 * read of the board through `C_S` and the admission of its ballots. That is
 * sound because the anchored counted extent never changes once `t_S` has
 * passed. A `waiting` answer is kept for `waitMs`, so openings sent before the
 * set is fixed cost one admission per election per interval at most (T-52).
 */
export class OpeningBoardings {
  readonly #tally: OpeningBoardingOptions["tally"];
  readonly #clock: { readonly epoch: bigint; readonly period: bigint };
  readonly #cacheSize: number;
  readonly #waitMs: number;
  readonly #nowMs: () => number;
  readonly #decided = new Map<string, Decided>();
  readonly #waiting = new Map<string, number>();
  readonly #inFlight = new Map<string, Promise<CountedTally>>();

  constructor({
    tally,
    clock,
    cacheSize = 256,
    waitMs = 60_000,
    nowMs = Date.now,
  }: OpeningBoardingOptions) {
    if (typeof clock.epoch !== "bigint" || clock.epoch < 0n)
      throw new RangeError("clock.epoch must be a bigint ≥ 0");
    if (typeof clock.period !== "bigint" || clock.period < 1n)
      throw new RangeError("clock.period must be a bigint ≥ 1");
    if (!Number.isSafeInteger(cacheSize) || cacheSize < 1)
      throw new RangeError("cacheSize must be at least 1");
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new RangeError("waitMs must be ≥ 0");
    this.#tally = tally;
    this.#clock = { epoch: clock.epoch, period: clock.period };
    this.#cacheSize = cacheSize;
    this.#waitMs = waitMs;
    this.#nowMs = nowMs;
  }

  /**
   * Judges `opening` (a tally opening record's bytes) for `electionId` by
   * the Boarding rule and, if it passes, appends it to the board in the
   * segment current at UNIX time `now` (seconds), or the latest one taken
   * since, and returns its entry. Throws `OpeningError` for a refusal, with
   * nothing written. A repeat, which a seat's node sends until the seal,
   * returns the entry that carries it, writing nothing.
   */
  async submitOpening(
    client: Sql,
    electionId: Uint8Array,
    opening: Uint8Array,
    now: bigint,
  ): Promise<AppendedEntry> {
    if (!isBytes(electionId) || electionId.length !== 32)
      throw new TypeError("electionId must be 32 bytes");
    if (!isBytes(opening)) throw new TypeError("opening must be bytes");
    if (typeof now !== "bigint" || now < 0n) throw new TypeError("now must be a bigint ≥ 0");
    const id = new Uint8Array(electionId);
    const own = new Uint8Array(opening);
    const tally = await this.#counted(client, id);
    if (tally.state === "waiting") throw new OpeningError("not-ready");
    if (tally.state === "refused") throw new OpeningError("not-open");
    if (now < this.#clock.epoch) throw new OpeningError("not-ready");
    const segment = (now - this.#clock.epoch) / this.#clock.period;
    if (segment > BigInt(MAX_SEGMENT)) throw new OpeningError("not-open");
    const boarded = await readBoardedOpenings(client, id);
    const verdict = tallyOpeningBoarding(
      tally.election,
      tally.aggregates,
      boarded.map((b) => b.payload),
      own,
      tally.pinned,
    );
    if (!verdict.ok) {
      if (verdict.code !== "tally-repeat") throw new OpeningError("rejected", verdict.code);
      // The same signed message, attributed: the seat's resend gets the
      // entry that carries it, whatever its signature's bytes.
      const { payload: _, ...entry } = boarded[verdict.of] as (typeof boarded)[number];
      return entry;
    }
    try {
      // The counted checkpoint fences every segment through it, so the
      // opening lands past the counted extent whatever `now` says.
      const entry = await appendEntry(client, id, Number(segment), own, {
        raiseToPrevious: true,
        opening: { cell: verdict.cell, seat: verdict.signer },
      });
      return entry;
    } catch (e) {
      if (!(e instanceof AppendError && e.code === "opening-present" && e.existing !== undefined))
        throw e;
      // Another opening of the cell by the seat was boarded since the judge
      // read the board, in other bytes: judged against it, a repeat of its
      // signed message gets its entry, anything else is the seat's second.
      const { payload, ...entry } = e.existing;
      const again = tallyOpeningBoarding(
        tally.election,
        tally.aggregates,
        [payload],
        own,
        tally.pinned,
      );
      if (!again.ok && again.code === "tally-repeat") return entry;
      throw new OpeningError("rejected", "tally-second");
    }
  }

  async #counted(client: Sql, id: Uint8Array): Promise<CountedTally> {
    const key = Buffer.from(id).toString("hex");
    const known = this.#decided.get(key);
    if (known !== undefined) {
      // Least recently used goes first: a hit moves the election to the end.
      this.#decided.delete(key);
      this.#decided.set(key, known);
      return known;
    }
    const until = this.#waiting.get(key);
    if (until !== undefined && this.#nowMs() < until) return { state: "waiting" };
    // Concurrent openings of one election share one computation (T-52).
    const running = this.#inFlight.get(key);
    if (running !== undefined) return running;
    const pending = this.#tally(client, id);
    this.#inFlight.set(key, pending);
    let tally;
    try {
      tally = await pending;
    } finally {
      this.#inFlight.delete(key);
    }
    if (tally.state === "waiting") {
      remember(this.#waiting, key, this.#nowMs() + this.#waitMs, this.#cacheSize);
      return tally;
    }
    this.#waiting.delete(key);
    remember(this.#decided, key, tally, this.#cacheSize);
    return tally;
  }
}

/** Keeps `value` under `key`, dropping the least recently used beyond `size`. */
function remember<V>(cache: Map<string, V>, key: string, value: V, size: number) {
  cache.delete(key);
  if (cache.size >= size) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}
