// The event accumulator of docs/spec/contracts.md: the running hash and
// counter each of our contracts keeps over its own L2 events. A verifier
// replays the archived event sequence and compares the result with the
// contract's storage at an output root, so an event the board operator left
// out (a direct-submitted ballot, say) shows as a mismatch (T-71, T-25;
// docs/adr/0005-permanent-archive.md).

import { bytesFixed, encode, u32, u64, u8, Writer } from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";

/** One log a contract emitted: 1 to 4 topics, `topics[0]` the event's signature hash. */
export interface ContractLog {
  readonly topics: readonly Uint8Array[];
  readonly data: Uint8Array;
}

/** A contract's accumulator after `count` events. */
export interface EventAccumulatorState {
  readonly accumulator: Uint8Array;
  readonly count: bigint;
}

const GENESIS = 0;
const STEP = 1;
const MAX_U64 = 2n ** 64n - 1n;
const MAX_U32 = 2 ** 32 - 1;

const copyBytes = (b: Uint8Array, what: string) => {
  if (!(b instanceof Uint8Array) || !ArrayBuffer.isView(b))
    throw new TypeError(`${what} must be a Uint8Array`);
  return new Uint8Array(b);
};

/**
 * `acc_0 = H(DS("abolish/v1/event-accumulator", u8(0) ‖ u64(chain_id) ‖
 * bytes[20](address)))`: the value a contract stores at deployment. Binding
 * the chain and the address means one contract's event sequence can't be
 * passed off as another's (T-71).
 */
export function eventAccumulatorGenesis(chainId: bigint, address: Uint8Array): Uint8Array {
  if (typeof chainId !== "bigint" || chainId < 0n || chainId > MAX_U64)
    throw new RangeError("chainId must be a bigint from 0 to 2^64 - 1");
  const w = new Writer();
  w.uint(1, GENESIS);
  w.bytes(encode(u64, chainId));
  w.bytes(encode(bytesFixed(20), copyBytes(address, "address")));
  return H(ds("abolish/v1/event-accumulator", w.finish()));
}

/**
 * `acc_{n+1} = H(DS("abolish/v1/event-accumulator", u8(1) ‖ acc_n ‖ u64(n) ‖
 * u8(k) ‖ topic_0 ‖ … ‖ topic_{k−1} ‖ u32(len(data)) ‖ data))` for event `n`
 * (0-based) with `k` topics, 1 ≤ k ≤ 4. A log with no topics (an anonymous
 * event) is rejected: our contracts never emit one.
 */
export function eventAccumulatorStep(
  accumulator: Uint8Array,
  index: bigint,
  log: ContractLog,
): Uint8Array {
  const acc = copyBytes(accumulator, "accumulator");
  if (acc.length !== 32) throw new RangeError("accumulator must be 32 bytes");
  if (typeof index !== "bigint" || index < 0n || index > MAX_U64)
    throw new RangeError("index must be a bigint from 0 to 2^64 - 1");
  const topics = Array.from(log.topics, (t, i) => copyBytes(t, `topics[${i}]`));
  if (topics.length < 1 || topics.length > 4) throw new RangeError("a log has 1 to 4 topics");
  if (topics.some((t) => t.length !== 32)) throw new RangeError("every topic is 32 bytes");
  const data = copyBytes(log.data, "data");
  if (data.length > MAX_U32) throw new RangeError("log data is at most 2^32 - 1 bytes");
  const w = new Writer();
  w.uint(1, STEP);
  w.bytes(acc);
  w.bytes(encode(u64, index));
  w.bytes(encode(u8, topics.length));
  for (const t of topics) w.bytes(t);
  w.bytes(encode(u32, data.length));
  w.bytes(data);
  return H(ds("abolish/v1/event-accumulator", w.finish()));
}

/**
 * Replays a contract's logs, in L2 order, from its genesis value. The result
 * equals the contract's stored accumulator and count after the block that
 * emitted the last log exactly when `logs` is its whole event sequence up to
 * there: nothing left out, added or reordered (docs/spec/verifier.md 4.4).
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
