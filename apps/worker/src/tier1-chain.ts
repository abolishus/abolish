// The Tier 1 relay's chain adapter (docs/spec/tier1-relay.md, Roles and The
// batch; packages/core's `Tier1Chain`): the group registry read over viem
// from one L2 node, and `addTier1Member` calls signed here with the relay
// account's key and sent to that node. Core decides; this file only reads,
// signs and sends.
//
// The registry's logs are checked against its own event accumulator: each
// read replays them from the accumulator at the block the last read ended at
// and must reach the accumulator and count the registry holds at the block
// it reads to, read by that block's hash as `heads()` gave it to core, so a
// node that drops, adds, alters or reorders a log, gives a block another
// timestamp, or serves logs of another fork than the block core checks, is
// refused rather than counted (T-53, T-71).
// That is the node's own state, not a proof: a node that lies about both is
// the relay's to trust (Known-weak in docs/status/P3-3.md), and costs only
// what the relay pays for, never what counts.
//
// Every failure throws `Tier1ChainError`, whose message names a step and
// nothing else: viem's errors quote the URL, which can carry a provider's
// API key, and the request, which can carry a record not yet on chain or the
// signed transaction (T-10, T-13, T-69).

import { groupRegistryAbi } from "@abolishus/contracts/abi";
import {
  type ContractEventRecord,
  eventAccumulatorGenesis,
  eventAccumulatorStep,
} from "@abolishus/crypto";
import {
  type Tier1Chain,
  type Tier1Head,
  type Tier1Heads,
  TIER1_RELAY_GAS_LIMIT,
  type Tier1SignedSend,
} from "@abolishus/core";
import {
  type Address,
  BaseError,
  BlockNotFoundError,
  bytesToHex,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBytes,
  keccak256,
  parseTransaction,
  type PublicClient,
  RpcError,
  RpcRequestError,
  ExecutionRevertedError,
  TransactionReceiptNotFoundError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { checkTier0Deployment, TIER0_LOG_RANGE } from "./tier0-chain.ts";

/** The most blocks one `eth_getLogs` call spans, as Tier 0's. */
export const TIER1_LOG_RANGE = TIER0_LOG_RANGE;

/**
 * Ends of reads kept for the next read to start from. Core starts each read
 * where the last one it accepted ended, and a read it refused ends no later
 * than the next, so a few are plenty.
 */
const KEPT_ENDS = 8;

export interface Tier1ChainOptions {
  /** One L2 node; its HTTP transport should time out well within core's `TIER1_BATCH_LOCK_MS`. */
  readonly client: PublicClient;
  readonly chainId: bigint;
  readonly registry: Address;
  /** The registry's deployment block: no log of it is older. */
  readonly fromBlock: bigint;
  /** The relay account's key: it signs every call and pays for it, and nothing else. */
  readonly key: Uint8Array;
  /**
   * The most wei per gas any call is signed to pay. The node's fee answers
   * are its own, so this bounds a boundary's spend at
   * `TIER1_RELAY_MAX_BATCH · TIER1_RELAY_GAS_LIMIT · maxFeePerGas` whatever
   * it says (T-52).
   */
  readonly maxFeePerGas: bigint;
  /** Blocks per log query; `TIER1_LOG_RANGE` unless a provider allows fewer. */
  readonly logRange?: bigint;
}

/** A call to the node failed, or it answered something it can't have. Names the step only. */
export class Tier1ChainError extends Error {
  override readonly name = "Tier1ChainError";
  constructor(step: string) {
    super(`the Tier 1 relay's L2 node: ${step}`);
  }
}

/** The registry's accumulator and log count after a block. */
interface End {
  readonly accumulator: Uint8Array;
  readonly count: bigint;
}

interface RawLog {
  readonly blockNumber: bigint | null;
  readonly logIndex: number | null;
  readonly removed?: boolean;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The group registry and the relay's account as the Tier 1 relay job uses them. */
export class ViemTier1Chain implements Tier1Chain {
  readonly #client: PublicClient;
  readonly #chainId: bigint;
  readonly #registry: Address;
  readonly #registryBytes: Uint8Array;
  readonly #from: bigint;
  readonly #account: ReturnType<typeof privateKeyToAccount>;
  readonly #maxFee: bigint;
  readonly #range: bigint;
  readonly #ends = new Map<bigint, End>();
  // The latest block the last `heads()` gave core, whose hash core checks
  // again after reading the records up to it.
  #latest: Tier1Head | undefined;

  constructor(options: Tier1ChainOptions) {
    const range = options.logRange ?? TIER1_LOG_RANGE;
    if (range < 1n) throw new RangeError("logRange must be at least one block");
    if (options.fromBlock < 0n) throw new RangeError("fromBlock must not be negative");
    if (options.maxFeePerGas < 1n) throw new RangeError("maxFeePerGas must be at least 1 wei");
    // viem signs with the chain ID as a JavaScript number.
    if (options.chainId < 1n || options.chainId > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError("chainId must be a positive safe integer");
    this.#client = options.client;
    this.#chainId = options.chainId;
    this.#registry = getAddress(options.registry);
    this.#registryBytes = hexToBytes(this.#registry);
    this.#from = options.fromBlock;
    this.#account = relayAccount(options.key);
    this.#maxFee = options.maxFeePerGas;
    this.#range = range;
  }

  /** The relay account's address, which pays for every call. */
  get address(): Address {
    return this.#account.address;
  }

  heads(): Promise<Tier1Heads> {
    return guard("heads", async () => {
      const [latest, safe, finalized] = await Promise.all([
        this.#client.getBlock({ blockTag: "latest" }),
        this.#client.getBlock({ blockTag: "safe" }),
        this.#client.getBlock({ blockTag: "finalized" }),
      ]);
      this.#latest = head(latest);
      return { latest: this.#latest, safe: safe.number, finalized: finalized.number };
    });
  }

  blockHash(number: bigint): Promise<Uint8Array | null> {
    return guard("block hash", async () => {
      try {
        const block = await this.#client.getBlock({ blockNumber: number });
        return head(block, number).hash;
      } catch (e) {
        if (e instanceof BlockNotFoundError) return null;
        throw e;
      }
    });
  }

  records(after: bigint | null, through: bigint): Promise<readonly ContractEventRecord[]> {
    return guard("records", async () => {
      const start = after === null ? null : after + 1n;
      if (after !== null && after < this.#from) throw new Error("before the deployment");
      if (through < (start ?? this.#from)) throw new Error("an empty range");
      const at =
        this.#latest?.number === through
          ? this.#latest.hash
          : head(await this.#client.getBlock({ blockNumber: through }), through).hash;
      const [begin, end] = await Promise.all([this.#endAt(after), this.#accumulatorAt(at)]);
      const logs = await this.#logs(start ?? this.#from, through);
      const times = new Map<bigint, bigint>();
      for (const log of logs)
        if (!times.has(log.blockNumber))
          times.set(
            log.blockNumber,
            (await this.#client.getBlock({ blockNumber: log.blockNumber })).timestamp,
          );
      let acc = begin.accumulator;
      const records = logs.map((log, i): ContractEventRecord => {
        const record = {
          contract: this.#registryBytes,
          n: begin.count + BigInt(i),
          l2_block: log.blockNumber,
          l2_timestamp: times.get(log.blockNumber) as bigint,
          topics: log.topics.map((t) => hexToBytes(t)),
          data: hexToBytes(log.data),
        };
        acc = eventAccumulatorStep(acc, record.n, {
          block: record.l2_block,
          timestamp: record.l2_timestamp,
          topics: record.topics,
          data: record.data,
        });
        return record;
      });
      // The node's logs, replayed, must reach its own accumulator.
      if (end.count !== begin.count + BigInt(records.length) || !equalBytes(acc, end.accumulator))
        throw new Error("the logs don't reach the accumulator");
      // Re-set at the end, so the oldest ends are the ones let go.
      this.#ends.delete(through);
      this.#ends.set(through, end);
      while (this.#ends.size > KEPT_ENDS)
        this.#ends.delete(this.#ends.keys().next().value as bigint);
      return records;
    });
  }

  nonce(): Promise<{ readonly count: bigint; readonly at: Tier1Head }> {
    return guard("nonce", async () => {
      const at = head(await this.#client.getBlock({ blockTag: "latest" }));
      const count = await this.#client.getTransactionCount({
        address: this.#account.address,
        blockNumber: at.number,
      });
      return { count: BigInt(count), at };
    });
  }

  included(hash: Uint8Array): Promise<bigint | null> {
    return guard("inclusion", async () => {
      const wanted = bytesToHex(hash);
      try {
        const receipt = await this.#client.getTransactionReceipt({ hash: wanted });
        if (receipt.transactionHash.toLowerCase() !== wanted) throw new Error("another receipt");
        return receipt.blockNumber;
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    });
  }

  simulate(record: Uint8Array): Promise<boolean> {
    return guard("simulation", async () => {
      try {
        await this.#client.call({
          account: this.#account.address,
          to: this.#registry,
          data: this.#calldata(record),
          gas: TIER1_RELAY_GAS_LIMIT,
          blockTag: "latest",
        });
        return true;
      } catch (e) {
        // The node answered the call with an error: a revert, by any node's
        // wording. One that couldn't answer rejects.
        if (answered(e)) return false;
        throw e;
      }
    });
  }

  sign(record: Uint8Array, nonce: bigint, replacing?: Uint8Array): Promise<Tier1SignedSend> {
    return guard("signing", async () => {
      const fees = await this.#client.estimateFeesPerGas({ chain: null, type: "eip1559" });
      let maxFeePerGas = fees.maxFeePerGas;
      let maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
      if (replacing !== undefined) {
        const old = parseTransaction(bytesToHex(replacing));
        if (
          old.type !== "eip1559" ||
          old.chainId !== Number(this.#chainId) ||
          old.nonce !== Number(nonce) ||
          old.maxFeePerGas === undefined ||
          old.maxPriorityFeePerGas === undefined
        )
          throw new Error("the transaction replaced isn't ours at that nonce");
        // Nodes take a replacement only with both fees raised, by 10% for
        // geth's pool; an eighth more clears it.
        const raise = (v: bigint) => v + v / 8n + 1n;
        if (raise(old.maxFeePerGas) > maxFeePerGas) maxFeePerGas = raise(old.maxFeePerGas);
        if (raise(old.maxPriorityFeePerGas) > maxPriorityFeePerGas)
          maxPriorityFeePerGas = raise(old.maxPriorityFeePerGas);
      }
      // At the cap a replacement may not be taken; the transaction it would
      // replace still stands (core broadcasts it again).
      if (maxFeePerGas > this.#maxFee) maxFeePerGas = this.#maxFee;
      if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
      const tx = await this.#account.signTransaction({
        type: "eip1559",
        chainId: Number(this.#chainId),
        nonce: Number(nonce),
        to: this.#registry,
        data: this.#calldata(record),
        value: 0n,
        gas: TIER1_RELAY_GAS_LIMIT,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      return { tx: hexToBytes(tx), hash: hexToBytes(keccak256(tx)) };
    });
  }

  broadcast(tx: Uint8Array): Promise<"sent" | "refused"> {
    return guard("broadcast", async () => {
      const raw = bytesToHex(tx);
      let hash: unknown;
      try {
        hash = await this.#client.request({ method: "eth_sendRawTransaction", params: [raw] });
      } catch (e) {
        if (!answered(e)) throw e;
        // A node that already holds it says so in its own words.
        return /already known|known transaction|already imported|alreadyknown/i.test(
          (e as Error).message,
        )
          ? "sent"
          : "refused";
      }
      if (typeof hash !== "string" || hash.toLowerCase() !== keccak256(raw))
        throw new Error("the node named another transaction");
      return "sent";
    });
  }

  #calldata(record: Uint8Array): Hex {
    return encodeFunctionData({
      abi: groupRegistryAbi,
      functionName: "addTier1Member",
      args: [bytesToHex(record)],
    });
  }

  /** The accumulator and count after block `after`, or before the deployment. */
  async #endAt(after: bigint | null): Promise<End> {
    if (after === null)
      return {
        accumulator: eventAccumulatorGenesis(this.#chainId, this.#registryBytes),
        count: 0n,
      };
    const kept = this.#ends.get(after);
    if (kept !== undefined) return kept;
    const [accumulator, count] = await this.#client.readContract({
      address: this.#registry,
      abi: groupRegistryAbi,
      functionName: "eventAccumulator",
      blockNumber: after,
    });
    return { accumulator: hexToBytes(accumulator), count };
  }

  /**
   * The registry's accumulator after the block whose hash is `hash`
   * (EIP-1898): a node without that block in its canonical chain refuses
   * rather than answer for another.
   */
  async #accumulatorAt(hash: Uint8Array): Promise<End> {
    const data = encodeFunctionData({ abi: groupRegistryAbi, functionName: "eventAccumulator" });
    const answer = await this.#client.request({
      method: "eth_call",
      params: [
        { to: this.#registry, data },
        { blockHash: bytesToHex(hash), requireCanonical: true },
      ],
    } as never);
    const [accumulator, count] = decodeFunctionResult({
      abi: groupRegistryAbi,
      functionName: "eventAccumulator",
      data: answer as Hex,
    });
    return { accumulator: hexToBytes(accumulator), count };
  }

  /** Every log of the registry in blocks `from` to `to`, in chain order. */
  async #logs(from: bigint, to: bigint) {
    const out: (RawLog & { blockNumber: bigint; logIndex: number })[] = [];
    for (let lo = from; lo <= to; lo += this.#range) {
      const hi = lo + this.#range - 1n < to ? lo + this.#range - 1n : to;
      const logs = (await this.#client.getLogs({
        address: this.#registry,
        fromBlock: lo,
        toBlock: hi,
      })) as readonly RawLog[];
      const sorted = [...logs].sort((a, b) =>
        a.blockNumber === b.blockNumber
          ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
          : (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n)
            ? -1
            : 1,
      );
      // A node that answers with logs outside the asked range, pending,
      // removed or repeated is refused rather than read.
      for (const log of sorted) {
        if (
          log.blockNumber === null ||
          log.logIndex === null ||
          log.removed === true ||
          log.blockNumber < lo ||
          log.blockNumber > hi
        )
          throw new Error("a log outside the asked range");
        const last = out.at(-1);
        if (last?.blockNumber === log.blockNumber && last.logIndex === log.logIndex)
          throw new Error("a repeated log");
        out.push(log as RawLog & { blockNumber: bigint; logIndex: number });
      }
    }
    return out;
  }
}

/** A block's number and hash, refusing a pending one or one the node put at another number. */
function head(
  block: { readonly number: bigint | null; readonly hash: Hex | null },
  number?: bigint,
): Tier1Head {
  if (block.number === null || block.hash === null) throw new Error("a pending block");
  if (number !== undefined && block.number !== number) throw new Error("another block");
  return { number: block.number, hash: hexToBytes(block.hash) };
}

/** The node answered with a JSON-RPC error, rather than failing to answer. */
function answered(e: unknown): boolean {
  return (
    e instanceof BaseError &&
    e.walk(
      (c) =>
        c instanceof RpcRequestError ||
        c instanceof RpcError ||
        c instanceof ExecutionRevertedError,
    ) !== null
  );
}

async function guard<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw new Tier1ChainError(step);
  }
}

/** The account a 32-byte key controls; a key out of secp256k1's range is refused without quoting it. */
function relayAccount(key: Uint8Array) {
  if (key.length !== 32) throw new RangeError("the relay key must be 32 bytes");
  try {
    return privateKeyToAccount(bytesToHex(key));
  } catch {
    // viem's message for an out-of-range key quotes the key.
    throw new RangeError("the relay key isn't a secp256k1 key");
  }
}

export interface Tier1Deployment {
  readonly chainId: bigint;
  readonly registry: Address;
  /** The registry's deployment block, as `Tier1ChainOptions.fromBlock`. */
  readonly fromBlock: bigint;
  readonly registrars: readonly Address[];
  readonly threshold: number;
  /** Region 0's published Tier 1 group (docs/spec/tier1-relay.md, Groups). */
  readonly group: bigint;
}

/**
 * The startup check (P3-3 part 3c-2b-2b): the node is on the configured
 * chain, the registry's finalized state pins exactly the configured
 * registrars and threshold, and `fromBlock` is its deployment block, as
 * Tier 0's check reads them, so the counting state misses none of the
 * registry's logs; and the published group's creation is final, as a Tier 1
 * group. So a misconfigured relay refuses to start rather than pay for
 * additions that can't count (T-52, T-53). Throws naming the mismatch.
 */
export async function checkTier1Deployment(
  client: PublicClient,
  deployment: Tier1Deployment,
): Promise<void> {
  // No registrar key is held for Tier 1: an addition's authorisation is its vouches.
  await checkTier0Deployment(client, { ...deployment, signers: [] });
  const blockNumber = (await client.getBlock({ blockTag: "finalized" })).number;
  const [tier, exists] = await client.readContract({
    address: deployment.registry,
    abi: groupRegistryAbi,
    functionName: "groupOf",
    args: [deployment.group],
    blockNumber,
  });
  if (!exists) throw new Error("the published group's creation isn't final");
  if (tier !== 1) throw new Error("the published group isn't a Tier 1 group");
}
