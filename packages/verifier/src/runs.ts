// The event replay's reads (docs/spec/archive.md, Contract-event run, The
// event replay): one contract's archived event sequence from index 0,
// assembled from the contract-event runs that reached version-3 manifests
// list, so 4.4 can replay a contract's accumulator against its archived
// evidence once no L2 node serves its logs (T-49, T-51). A run is read by
// the CID its reference names and held to the reference's claim; nothing it
// says is trusted beyond that, since only its replay against evidence shows
// it is the contract's history (T-53). None of this fails an election: a
// sequence the archive doesn't give whole leaves what needs it unverifiable.

import {
  type ContractEventRecord,
  type ContractEventRun,
  contractEventRunRecords,
  DecodeError,
  decodeContractEventRun,
  MAX_CONTRACT_EVENT_RUN,
  MAX_EVENT_DATA,
  MAX_EVENT_TOPICS,
  readArchivedObject,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { archivedDataLimit, type RunListing, type TransactionSource } from "./archive.ts";

/**
 * The most bytes a run of `count` events encodes (docs/spec/archive.md,
 * Layout (version 1)): the record's three bytes of framing, its fixed fields
 * and every event at its longest, never past `MAX_CONTRACT_EVENT_RUN`, the
 * bound every reader reads a run within. Data naming a longer object under
 * the reference's CID is no run of that count.
 */
export function runBound(count: number): number {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError("a run holds an event");
  const event = 8 + 8 + 4 + MAX_EVENT_TOPICS * 32 + 4 + MAX_EVENT_DATA;
  return Math.min(MAX_CONTRACT_EVENT_RUN, 3 + 8 + 20 + 8 + 4 + count * event);
}

/**
 * What one event of a run taken is charged as held: its contract-event
 * record decoded, with its topics' and data's arrays, well over the few
 * hundred bytes it measures at, so `maxBytes` bounds what the reads hold
 * and not only what they fetch (T-52).
 */
export const HELD_PER_EVENT = 512;

/** The run reads' byte budget when the caller sets none: 1 GiB, as the listed objects'. */
export const DEFAULT_RUN_BYTES = 2 ** 30;

/**
 * How many transactions the run reads ask of the sources when the caller
 * sets nothing: an honest archive serves each run from its first
 * transaction, about one run per contract and anchored period.
 */
export const DEFAULT_RUN_READS = 1_024;

/** One report on a contract's archived runs. None is a verdict on an election (T-53). */
export type RunFinding =
  /** Data that reads as the CID but isn't a version-1 run: the CID fixes the bytes. */
  | {
      readonly code: "run-malformed";
      readonly first: bigint;
      readonly cid: Uint8Array;
      readonly transaction: Uint8Array;
    }
  /** Data that reads as the CID names an object longer than a run of the reference's count can be. */
  | {
      readonly code: "run-over-bound";
      readonly first: bigint;
      readonly cid: Uint8Array;
      readonly transaction: Uint8Array;
    }
  /** A run of another L2 or contract, or not at the reference's `first` with its `count`. */
  | {
      readonly code: "run-foreign";
      readonly first: bigint;
      readonly cid: Uint8Array;
      readonly transaction: Uint8Array;
    }
  /** No source served data that reads as the CID from any transaction listing it. */
  | {
      readonly code: "run-unavailable";
      readonly first: bigint;
      readonly cid: Uint8Array;
      readonly transactions: readonly Uint8Array[];
    }
  /** An index below the count where no listed run starts, or none starting there is taken. */
  | { readonly code: "run-gap"; readonly n: bigint }
  /** The byte or read budget ran out at index `n`: unverifiable for this reader. */
  | {
      readonly code: "runs-over-budget";
      readonly n: bigint;
      readonly maxBytes: number;
      readonly maxReads: number;
    };

/**
 * A run taken into the sequence: its listing's claim and the transaction its
 * CID was read from, which a listing naming a CID read for an earlier one
 * may not list, since the CID fixes the bytes whichever served them.
 */
export interface TakenRun {
  readonly first: bigint;
  readonly count: number;
  readonly cid: Uint8Array;
  readonly transaction: Uint8Array;
}

/** What reading a contract's archived runs came to. */
export interface ArchivedSequence {
  /** The events of the runs taken, from index 0, each as its contract-event record (0x0008). */
  readonly records: readonly ContractEventRecord[];
  /** The runs taken, in order of `first`. */
  readonly taken: readonly TakenRun[];
  /** Whether the runs taken reach the count asked for; if not, the last finding says why. */
  readonly complete: boolean;
  readonly findings: readonly RunFinding[];
  /**
   * Bytes charged against `maxBytes`: every answer the sources gave, or the
   * run it read, if longer, and `HELD_PER_EVENT` for each event taken.
   */
  readonly spent: number;
  /** Transactions asked of the sources, against `maxReads`. */
  readonly reads: number;
}

const compare = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
};

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && compare(a, b) === 0;

// What a CID's bytes came to once data read as it: the CID fixes the bytes,
// so a second reference to it is judged from this, never read again.
// A run is kept as its bytes, already charged, and what its listing is held
// to: decoded, its events take many times their encoding, so only a run
// taken is decoded again and kept (T-52).
type Settled =
  | {
      readonly kind: "run";
      readonly bytes: Uint8Array;
      readonly head: Omit<ContractEventRun, "events">;
      readonly count: number;
      readonly transaction: Uint8Array;
    }
  | {
      readonly kind: "run-malformed" | "run-over-bound";
      readonly transaction: Uint8Array;
      readonly length: number;
    };

/**
 * Reads `contract`'s archived event sequence up to `count`, the count an
 * evidence record proves (docs/spec/archive.md, The event replay): from
 * `n = 0`, the listings whose `first` is `n`, in ascending order of CID
 * (then of count), are each read from their transactions in walk order
 * until data reads as the CID within the run's bound and what is left of
 * `maxBytes`, and the first whose run has `l2ChainId`, the listing's
 * contract and `first`, and exactly its `count` events is taken; the reads
 * go on from `n + count` until `n ≥ count`. Two runs that read at one `n`
 * are both the authority's, so the first taken stands and a replay it breaks
 * is never repaired by trying the other: the reads stay linear in the runs
 * needed, each CID taken at most once.
 *
 * A listing whose data reads as its CID but doesn't decode is
 * `run-malformed`, one naming an object longer than a run of its count is
 * `run-over-bound`, one disagreeing with the listing or the L2 is
 * `run-foreign`, and one no transaction serves is `run-unavailable`; each
 * is reported and the next listing at `n` tried. An `n` where no listing is
 * taken stops the reads with `run-gap`. Both budgets are the reader's
 * (T-52), charged as the listed objects' are: every answer against
 * `maxBytes`, read or not, a run read at its own length where that is more,
 * each event of a run taken at `HELD_PER_EVENT` for its record kept, and
 * every transaction asked against `maxReads`; a run not taken is kept only
 * as its bytes, so the reads hold about `maxBytes` at most. The reads stop
 * (`runs-over-budget`) where either runs out, or where no answer read while
 * what is left of `maxBytes` was short of the run's bound, since an honest
 * answer may have been too long to hold; what they didn't reach is
 * unverifiable for this reader, never missing.
 *
 * The events taken are only the archive's word: the caller replays them
 * against the contract's evidence ([[contracts]], Event accumulator,
 * Verification), which alone shows them the contract's history (T-53).
 */
export async function readRuns(
  listings: readonly RunListing[],
  contract: Uint8Array,
  l2ChainId: bigint,
  count: bigint,
  source: TransactionSource,
  maxBytes: number = DEFAULT_RUN_BYTES,
  maxReads: number = DEFAULT_RUN_READS,
): Promise<ArchivedSequence> {
  if (!(contract instanceof Uint8Array) || contract.length !== 20)
    throw new RangeError("a contract address is 20 bytes");
  if (typeof count !== "bigint" || count < 0n) throw new RangeError("count must be a u64");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("maxBytes must be a positive integer");
  if (!Number.isSafeInteger(maxReads) || maxReads < 1)
    throw new RangeError("maxReads must be a positive integer");
  const byFirst = new Map<bigint, RunListing[]>();
  for (const l of listings) {
    if (!equal(l.contract, contract)) continue;
    const at = byFirst.get(l.first);
    if (at === undefined) byFirst.set(l.first, [l]);
    else at.push(l);
  }
  // `sort` is stable, so listings of one CID and count stay in walk order.
  for (const at of byFirst.values()) at.sort((a, b) => compare(a.cid, b.cid) || a.count - b.count);

  const records: ContractEventRecord[] = [];
  const taken: TakenRun[] = [];
  const findings: RunFinding[] = [];
  const settled = new Map<string, Settled>();
  let spent = 0;
  let reads = 0;
  const left = () => maxBytes - spent;
  const done = (complete: boolean): ArchivedSequence => ({
    records,
    taken,
    complete,
    findings,
    spent,
    reads,
  });

  // Reads a listing's CID from its transactions: what it settled as, or
  // "unavailable" with the transactions tried, or "over-budget".
  const read = async (
    listing: RunListing,
    bound: number,
  ): Promise<Settled | readonly Uint8Array[] | "over-budget"> => {
    const tried: Uint8Array[] = [];
    // A transaction listed in several manifests is one upload, asked once.
    const distinct = [...new Map(listing.transactions.map((t) => [bytesToHex(t), t])).values()];
    for (const transaction of distinct) {
      if (left() === 0 || reads === maxReads) return "over-budget";
      const within = Math.min(bound, left());
      const limit = archivedDataLimit(within);
      tried.push(transaction);
      reads++;
      for await (const data of await source(transaction, limit)) {
        // A source past the limit is that source's failure, never parsed (T-52).
        if (data.length > limit) continue;
        const got = readArchivedObject(data, listing.cid, within);
        // What is held is charged, as the listed objects' reads charge it.
        spent = Math.min(maxBytes, spent + Math.max(data.length, got.ok ? got.bytes.length : 0));
        if (!got.ok && got.reason === "inconsistent") {
          // Junk that spent the budget: the reads stop at the next ask.
          if (left() === 0) break;
          continue;
        }
        if (!got.ok)
          return got.length > bound
            ? { kind: "run-over-bound", transaction, length: got.length }
            : "over-budget";
        try {
          const { events, ...head } = decodeContractEventRun(got.bytes, 1);
          return { kind: "run", bytes: got.bytes, head, count: events.length, transaction };
        } catch (e) {
          // The CID fixes the bytes, so no other source can do better.
          if (e instanceof DecodeError)
            return { kind: "run-malformed", transaction, length: got.bytes.length };
          throw e;
        }
      }
    }
    // With the budget short of the bound, an honest answer may have been too
    // long to hold: unverifiable for this reader, never unavailable.
    return left() < bound ? "over-budget" : tried;
  };

  let n = 0n;
  while (n < count) {
    let next: bigint | undefined;
    for (const listing of byFirst.get(n) ?? []) {
      const { first, cid } = listing;
      const key = bytesToHex(cid);
      const bound = runBound(listing.count);
      let got = settled.get(key);
      // An object over a smaller count's bound may be a run of this larger
      // count: its bytes were never held, so it is read again within this bound.
      if (got === undefined || (got.kind === "run-over-bound" && got.length <= bound)) {
        const r = await read(listing, bound);
        if (r === "over-budget") {
          findings.push({ code: "runs-over-budget", n, maxBytes, maxReads });
          return done(false);
        }
        if (!("kind" in r)) {
          findings.push({ code: "run-unavailable", first, cid, transactions: r });
          continue;
        }
        got = r;
        settled.set(key, got);
      }
      const { transaction } = got;
      if (got.kind !== "run") {
        findings.push({ code: got.kind, first, cid, transaction });
        continue;
      }
      const { head } = got;
      if (
        head.l2_chain_id !== l2ChainId ||
        !equal(head.contract, contract) ||
        head.first !== first ||
        got.count !== listing.count
      ) {
        findings.push({ code: "run-foreign", first, cid, transaction });
        continue;
      }
      // The records kept are charged as held, not as their encoding: a run
      // of empty events is a few bytes an event and many times that decoded.
      const held = got.count * HELD_PER_EVENT;
      if (held > left()) {
        findings.push({ code: "runs-over-budget", n, maxBytes, maxReads });
        return done(false);
      }
      spent += held;
      for (const r of contractEventRunRecords(decodeContractEventRun(got.bytes, 1)))
        records.push(r);
      taken.push({ first, count: listing.count, cid, transaction });
      next = n + BigInt(listing.count);
      break;
    }
    if (next === undefined) {
      findings.push({ code: "run-gap", n });
      return done(false);
    }
    n = next;
  }
  return done(true);
}
