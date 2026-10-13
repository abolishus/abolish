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
 * caller's to check first. Throws a RangeError or TypeError, as
 * `eventAccumulatorStep` does, on a log that isn't well formed (an `n`,
 * block or timestamp outside `u64`, or a malformed topic or data): that is
 * a malformed input, not an archive that fails to match.
 */
export function checkEventAccumulatorProof(
  chainId: bigint,
  address: Uint8Array,
  archive: Iterable<ArchivedContractLog>,
  proven: ProvenEventAccumulator,
): EventAccumulatorProofError | null {
  u64Arg(proven.block, "proven.block");
  u64Arg(proven.count, "proven.count");
  const logs = Array.from(archive);
  for (const log of logs) {
    u64Arg(log.n, "n");
    u64Arg(log.block, "block");
    u64Arg(log.timestamp, "timestamp");
  }
  for (const [i, log] of logs.entries()) {
    if (log.n !== BigInt(i)) return "index";
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
  return equalBytes(replayed.accumulator, copyBytes(proven.accumulator, "proven.accumulator"))
    ? null
    : "accumulator";
}
