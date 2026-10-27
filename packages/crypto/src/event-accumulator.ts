// The event accumulator of docs/spec/contracts.md: the running hash and
// counter each of our contracts keeps over its own events, each step binding
// the log's L2 block number and timestamp. A verifier replays the archived
// event sequence and compares the result with the contract's storage at an
// output root, so an event the board operator left out (a direct-submitted
// ballot, say) or moved to another block shows as a mismatch (T-71, T-25).
// It is the only evidence archived for our contracts' events, so no
// transaction's chosen bytes reach the archive (T-17;
// docs/adr/0025-contract-event-evidence.md).

import { bytesFixed, encode, u32, u64, u8, Writer } from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";

/**
 * One log a contract emitted, in the block numbered `block` with timestamp
 * `timestamp`: 1 to 4 topics, `topics[0]` the event's signature hash.
 */
export interface ContractLog {
  readonly block: bigint;
  readonly timestamp: bigint;
  readonly topics: readonly Uint8Array[];
  readonly data: Uint8Array;
}

/** A log as the archive numbers it: `n` is its position in its contract's sequence. */
export interface ArchivedContractLog extends ContractLog {
  readonly n: bigint;
}

/**
 * A storage proof's values, already proven: the contract's accumulator and
 * count after the L2 block numbered `block`.
 */
export interface ProvenEventAccumulator extends EventAccumulatorState {
  readonly block: bigint;
}

/** The first rule of docs/spec/contracts.md (Event accumulator, Verification) an archive breaks. */
export type EventAccumulatorProofError = "index" | "order" | "block-range" | "accumulator";

/** A contract's accumulator after `count` events. */
export interface EventAccumulatorState {
  readonly accumulator: Uint8Array;
  readonly count: bigint;
}

const GENESIS = 0;
const STEP = 1;
const MAX_U64 = 2n ** 64n - 1n;
const MAX_U32 = 2 ** 32 - 1;
const TAG = "abolish/v1/event-accumulator-2";

const u64Arg = (v: bigint, what: string) => {
  if (typeof v !== "bigint" || v < 0n || v > MAX_U64)
    throw new RangeError(`${what} must be a bigint from 0 to 2^64 - 1`);
  return v;
};

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const copyBytes = (b: Uint8Array, what: string) => {
  if (!(b instanceof Uint8Array) || !ArrayBuffer.isView(b))
    throw new TypeError(`${what} must be a Uint8Array`);
  return new Uint8Array(b);
};

/**
 * `acc_0 = H(DS("abolish/v1/event-accumulator-2", u8(0) ‖ u64(chain_id) ‖
 * bytes[20](address)))`: the value a contract stores at deployment. Binding
 * the chain and the address means one contract's event sequence can't be
 * passed off as another's (T-71).
 */
export function eventAccumulatorGenesis(chainId: bigint, address: Uint8Array): Uint8Array {
  u64Arg(chainId, "chainId");
  const w = new Writer();
  w.uint(1, GENESIS);
  w.bytes(encode(u64, chainId));
  w.bytes(encode(bytesFixed(20), copyBytes(address, "address")));
  return H(ds(TAG, w.finish()));
}

/**
 * `acc_{n+1} = H(DS("abolish/v1/event-accumulator-2", u8(1) ‖ acc_n ‖ u64(n) ‖
 * u64(block) ‖ u64(timestamp) ‖ u8(k) ‖ topic_0 ‖ … ‖ topic_{k−1} ‖
 * u32(len(data)) ‖ data))` for event `n` (0-based) with `k` topics,
 * 1 ≤ k ≤ 4. A log with no topics (an anonymous event) is rejected: our
 * contracts never emit one.
 */
export function eventAccumulatorStep(
  accumulator: Uint8Array,
  index: bigint,
  log: ContractLog,
): Uint8Array {
  const acc = copyBytes(accumulator, "accumulator");
  if (acc.length !== 32) throw new RangeError("accumulator must be 32 bytes");
  u64Arg(index, "index");
  u64Arg(log.block, "block");
  u64Arg(log.timestamp, "timestamp");
  const topics = Array.from(log.topics, (t, i) => copyBytes(t, `topics[${i}]`));
  if (topics.length < 1 || topics.length > 4) throw new RangeError("a log has 1 to 4 topics");
  if (topics.some((t) => t.length !== 32)) throw new RangeError("every topic is 32 bytes");
  const data = copyBytes(log.data, "data");
  if (data.length > MAX_U32) throw new RangeError("log data is at most 2^32 - 1 bytes");
  const w = new Writer();
  w.uint(1, STEP);
  w.bytes(acc);
  w.bytes(encode(u64, index));
  w.bytes(encode(u64, log.block));
  w.bytes(encode(u64, log.timestamp));
  w.bytes(encode(u8, topics.length));
  for (const t of topics) w.bytes(t);
  w.bytes(encode(u32, data.length));
  w.bytes(data);
  return H(ds(TAG, w.finish()));
}

/**
 * Replays a contract's logs, in emission order, from its genesis value. The
 * result equals the contract's stored accumulator and count after the block
 * that emitted the last log exactly when `logs` is its whole event sequence up
 * to there, each in its own block: nothing left out, added, reordered or moved
 * (docs/spec/verifier.md 4.4). It doesn't check the blocks' order;
 * `checkEventAccumulatorProof` does.
 */
export function replayEventAccumulator(
  chainId: bigint,
  address: Uint8Array,
  logs: Iterable<ContractLog>,
): EventAccumulatorState {
  let accumulator = eventAccumulatorGenesis(chainId, address);
  let count = 0n;
  for (const log of logs) {
    accumulator = eventAccumulatorStep(accumulator, count, log);
    count += 1n;
  }
  return { accumulator, count };
}

/**
 * Verification of docs/spec/contracts.md (Event accumulator): whether
 * `archive`, a contract's archived logs in order of `n`, matches a storage
 * proof of its accumulator after block `proven.block`. Returns the first rule
 * it breaks, or `null` when it matches. Rule 2 keeps a log from being counted
 * on the wrong side of the proof's block without changing the accumulator,
 * so an archive can't move an event across a period boundary (T-71, T-25).
 * The proof itself (account and storage proofs under an output root) is the
 * caller's to check first. Throws a RangeError or TypeError on malformed
 * input rather than reporting a rule: a proven count, block or accumulator
 * that isn't a `u64`, `u64` or 32 bytes, or any log's `n`, block or
 * timestamp outside `u64`. A counted log's topics and data are checked as
 * `eventAccumulatorStep` checks them, when rule 3 replays it; a log past the
 * count is checked by the proof that later counts it.
 */
export function checkEventAccumulatorProof(
  chainId: bigint,
  address: Uint8Array,
  archive: Iterable<ArchivedContractLog>,
  proven: ProvenEventAccumulator,
): EventAccumulatorProofError | null {
  u64Arg(proven.block, "proven.block");
  u64Arg(proven.count, "proven.count");
  const provenAccumulator = copyBytes(proven.accumulator, "proven.accumulator");
  if (provenAccumulator.length !== 32) throw new RangeError("proven.accumulator must be 32 bytes");
  const logs = Array.from(archive);
  for (const log of logs) {
    u64Arg(log.n, "n");
    u64Arg(log.block, "block");
    u64Arg(log.timestamp, "timestamp");
  }
  // Rule 1: the numbering over the whole archive, then the order, so an
  // archive breaking both reports `index` (docs/spec/contracts.md, Verification).
  if (logs.some((log, i) => log.n !== BigInt(i))) return "index";
  for (const [i, log] of logs.entries()) {
    const prev = logs[i - 1];
    if (prev !== undefined && (log.block < prev.block || log.timestamp < prev.timestamp))
      return "order";
  }
  // Rule 2 over the logs the archive holds; a count beyond the archive can't
  // be reproduced from it, which rule 3 reports.
  const short = proven.count > BigInt(logs.length);
  const c = short ? logs.length : Number(proven.count);
  if (logs.slice(0, c).some((l) => l.block > proven.block)) return "block-range";
  const next = logs[c];
  if (!short && next !== undefined && next.block <= proven.block) return "block-range";
  if (short) return "accumulator";
  const replayed = replayEventAccumulator(chainId, address, logs.slice(0, c));
  return equalBytes(replayed.accumulator, provenAccumulator) ? null : "accumulator";
}

/**
 * `checkEventAccumulatorProof` for each of `provens` over one archive, in
 * one pass: entry `i` of the result is what `checkEventAccumulatorProof`
 * returns for `provens[i]`, but the archive is validated, numbered and
 * ordered once and its accumulator replayed once, up to the largest count
 * left to compare, rather than once per proof. A contract proven at
 * every anchored period has one proof a period, and replaying its whole
 * sequence for each would cost their product (T-52). Throws as
 * `checkEventAccumulatorProof` does, for any proof or log; with no proof
 * it returns none and judges nothing, as no single call would.
 */
export function checkEventAccumulatorProofs(
  chainId: bigint,
  address: Uint8Array,
  archive: Iterable<ArchivedContractLog>,
  provens: readonly ProvenEventAccumulator[],
): (EventAccumulatorProofError | null)[] {
  if (provens.length === 0) return [];
  const checked = provens.map((proven) => {
    u64Arg(proven.block, "proven.block");
    u64Arg(proven.count, "proven.count");
    const accumulator = copyBytes(proven.accumulator, "proven.accumulator");
    if (accumulator.length !== 32) throw new RangeError("proven.accumulator must be 32 bytes");
    return { block: proven.block, count: proven.count, accumulator };
  });
  const logs = Array.from(archive);
  for (const log of logs) {
    u64Arg(log.n, "n");
    u64Arg(log.block, "block");
    u64Arg(log.timestamp, "timestamp");
  }
  // Rule 1 holds or breaks for every proof alike.
  if (logs.some((log, i) => log.n !== BigInt(i))) return checked.map(() => "index");
  for (const [i, log] of logs.entries()) {
    const prev = logs[i - 1];
    if (prev !== undefined && (log.block < prev.block || log.timestamp < prev.timestamp))
      return checked.map(() => "order");
  }
  // Rule 2: with the blocks never decreasing (rule 1), every counted log is
  // at or before the proof's block exactly when the last one is. A proof
  // past the archive breaks rule 3 without a replay.
  const rule2 = checked.map((proven): EventAccumulatorProofError | undefined => {
    const short = proven.count > BigInt(logs.length);
    const c = short ? logs.length : Number(proven.count);
    const last = logs[c - 1];
    if (last !== undefined && last.block > proven.block) return "block-range";
    const next = logs[c];
    if (!short && next !== undefined && next.block <= proven.block) return "block-range";
    return short ? "accumulator" : undefined;
  });
  // Rule 3: one replay, as far as the largest count still to compare, so it
  // steps exactly the logs some proof's own replay would, and throws where
  // one of those would.
  const asked = new Set(checked.filter((_, i) => rule2[i] === undefined).map((p) => p.count));
  const after = new Map<bigint, Uint8Array>();
  if (asked.size > 0) {
    // A loop, not a spread: an archive may prove as many counts as a reader's budget allows.
    let reached = 0;
    for (const count of asked) if (Number(count) > reached) reached = Number(count);
    let accumulator = eventAccumulatorGenesis(chainId, address);
    if (asked.has(0n)) after.set(0n, accumulator);
    for (let i = 0; i < reached; i++) {
      accumulator = eventAccumulatorStep(accumulator, BigInt(i), logs[i] as ArchivedContractLog);
      if (asked.has(BigInt(i + 1))) after.set(BigInt(i + 1), accumulator);
    }
  }
  return checked.map((proven, i) => {
    const broken = rule2[i];
    if (broken !== undefined) return broken;
    return equalBytes(after.get(proven.count) as Uint8Array, proven.accumulator)
      ? null
      : "accumulator";
  });
}

/**
 * Where a contract's archive stands after a proof that matched it: the
 * proof's accumulator, count and block, and the block and timestamp of the
 * last log it counts (both 0 while it counts none).
 */
export interface ProvenContinuation extends ProvenEventAccumulator {
  readonly lastBlock: bigint;
  readonly lastTimestamp: bigint;
}

/**
 * `checkEventAccumulatorProof` for the logs after a proof already matched,
 * without the logs before it: whether `logs`, the contract's from index
 * `from.count` in order of `n`, extend an archive that matched `from` to one
 * matching `proven`, exactly as the whole archive would be judged against
 * both proofs. Rule 1 over the logs and against the last one `from` counts;
 * rule 2 against both proofs' blocks, so no log counted by `proven` sits at
 * or before `from`'s block (where `from` would have counted it) or after
 * `proven`'s; rule 3 by stepping on from `from`'s accumulator. A writer
 * that holds only where its archive stands checks each new proof with it,
 * so what it archives always replays against every proof (T-71). `logs`
 * must be all the logs `proven` counts past `from`; one more or fewer is
 * `accumulator`. Throws as `checkEventAccumulatorProof` does, and on a
 * `proven` count below `from`'s.
 */
export function checkEventAccumulatorContinuation(
  from: ProvenContinuation,
  archive: Iterable<ArchivedContractLog>,
  proven: ProvenEventAccumulator,
): EventAccumulatorProofError | null {
  for (const [v, what] of [
    [from.block, "from.block"],
    [from.count, "from.count"],
    [from.lastBlock, "from.lastBlock"],
    [from.lastTimestamp, "from.lastTimestamp"],
    [proven.block, "proven.block"],
    [proven.count, "proven.count"],
  ] as const)
    u64Arg(v, what);
  const start = copyBytes(from.accumulator, "from.accumulator");
  const end = copyBytes(proven.accumulator, "proven.accumulator");
  if (start.length !== 32) throw new RangeError("from.accumulator must be 32 bytes");
  if (end.length !== 32) throw new RangeError("proven.accumulator must be 32 bytes");
  if (proven.count < from.count) throw new RangeError("proven.count is below from.count");
  const logs = Array.from(archive);
  for (const log of logs) {
    u64Arg(log.n, "n");
    u64Arg(log.block, "block");
    u64Arg(log.timestamp, "timestamp");
  }
  if (logs.some((log, i) => log.n !== from.count + BigInt(i))) return "index";
  let block = from.lastBlock;
  let timestamp = from.lastTimestamp;
  for (const log of logs) {
    if (log.block < block || log.timestamp < timestamp) return "order";
    block = log.block;
    timestamp = log.timestamp;
  }
  // Every log `from` counts is at or before `proven`'s block too.
  if (proven.block < from.lastBlock) return "block-range";
  const added = proven.count - from.count;
  // Two proofs of one count agree on everything they count; one that counts
  // more is at a later block than every log the earlier one counts, and
  // the earlier one's block is before every log it doesn't.
  if (added > 0n && proven.block <= from.block) return "block-range";
  if (BigInt(logs.length) !== added) return "accumulator";
  if (logs.some((l) => l.block <= from.block || l.block > proven.block)) return "block-range";
  let accumulator: Uint8Array = start;
  for (const log of logs) accumulator = eventAccumulatorStep(accumulator, log.n, log);
  return equalBytes(accumulator, end) ? null : "accumulator";
}
