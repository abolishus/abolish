// The posting relay's chain adapter (docs/spec/posting-relay.md, Sending,
// In flight and Pruning; ADR 0042, option A; packages/core's `PostingChain`
// and `PostingKeyChain`): the board read over viem from one L2 node, and
// `submitPosting` calls signed here with the posting key and sent to that
// node. Core decides; this file only reads, signs and sends.
//
// A posting's event is read as the spec names it, a `SharePosted` log of the
// board whose topics are the posting's own `definition_hash` and
// `ballot_hash` and whose data is exactly `abi.encode(posting)`, never from
// the board's storage, whose record keys nothing outside it recomputes. Each
// posting's search is kept in memory up to the finalized block it reached,
// where no reorganisation reaches, so a tend or a prune reads only the blocks
// since; it starts `POSTING_LOOKBACK` blocks behind the head it is first
// asked at, or at the board's deployment block if that is later. An event
// older than that is missed: the relay then pays for its one no-op repeat,
// or keeps the entry until its `t_D` (Known-weak in docs/status/P2-8.md),
// both of which the caps and the budget bound (T-52).
//
// Every failure throws `PostingChainError`, whose message names a step and
// nothing else: viem's errors quote the URL, which can carry a provider's API
// key, and the request, which can carry `m_i` before the chain holds it or
// the signed transaction (T-10, T-15, T-18, T-69).

import { boardAbi } from "@abolishus/contracts/abi";
import { decodeSharePosting } from "@abolishus/crypto";
import {
  POSTING_GAS_LIMIT_MAX,
  type PostingChain,
  type PostingCosts,
  type PostingHead,
  type PostingKeyChain,
  type PostingReceipt,
  type PostingSigned,
  type PostingSimulation,
} from "@abolishus/core";
import {
  type Address,
  BaseError,
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  ExecutionRevertedError,
  getAddress,
  type Hex,
  hexToBytes,
  keccak256,
  parseAbi,
  type PublicClient,
  RpcError,
  RpcRequestError,
  serializeTransaction,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TIER0_LOG_RANGE } from "./tier0-chain.ts";

/** The most blocks one `eth_getLogs` call spans, as Tier 0's. */
export const POSTING_LOG_RANGE = TIER0_LOG_RANGE;

/**
 * Blocks behind the head at which a posting's event search starts: a day at
 * Base's two-second blocks. The relay asks about a posting only once it has
 * sent it, and a client asks the relay only for a posting it hasn't seen
 * recorded, so an event of it older than that is one nobody needed.
 */
export const POSTING_LOOKBACK = 43_200n;

/** Postings whose search is kept: the oldest is let go past it, and searched again from scratch if asked of. */
const KEPT_SEARCHES = 4_096;

/** The OP Stack's `GasPriceOracle` predeploy, which prices a transaction's L1 data. */
const GAS_PRICE_ORACLE: Address = "0x420000000000000000000000000000000000000F";

const gasPriceOracleAbi = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);

const SHARE_POSTED = keccak256(toBytes("SharePosted(bytes32,bytes32,bytes)"));

const U64_MAX = (1n << 64n) - 1n;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/;
const HASH = /^0x[0-9a-f]{64}$/;

export interface PostingChainOptions {
  /** One L2 node; its HTTP transport should time out well within core's `POSTING_CHAIN_TIMEOUT_MS`. */
  readonly client: PublicClient;
  readonly chainId: bigint;
  readonly board: Address;
  /** The board's deployment block: no event of it is older. */
  readonly fromBlock: bigint;
  /** The posting key: it signs every call and pays for it, and nothing else (ADR 0042, option A). */
  readonly key: Uint8Array;
  /** Blocks per log query; `POSTING_LOG_RANGE` unless a provider allows fewer. */
  readonly logRange?: bigint;
  /** Blocks behind the head a posting's first search starts at; `POSTING_LOOKBACK` by default. */
  readonly lookback?: bigint;
}

/** A call to the node failed, or it answered something it can't have. Names the step only. */
export class PostingChainError extends Error {
  override readonly name = "PostingChainError";
  constructor(step: string) {
    super(`the posting relay's L2 node: ${step}`);
  }
}

/** One posting's event search: no event of it up to finalized block `through` since it began, or one at or below a finalized block if `final`. */
interface Search {
  through: bigint;
  final: boolean;
}

interface RawLog {
  readonly address?: unknown;
  readonly blockNumber?: unknown;
  readonly removed?: unknown;
  readonly topics?: unknown;
  readonly data?: unknown;
}

/** The board and the posting key as the posting worker and its ledger use them. */
export class ViemPostingChain implements PostingChain, PostingKeyChain {
  readonly #client: PublicClient;
  readonly #chainId: bigint;
  readonly #board: Address;
  readonly #from: bigint;
  readonly #account: ReturnType<typeof privateKeyToAccount>;
  readonly #range: bigint;
  readonly #lookback: bigint;
  readonly #searches = new Map<Hex, Search>();
  // Whether the chain prices L1 data, once seen: an OP Stack chain's oracle
  // is a predeploy that never goes away, so a receipt without its L1 fee is
  // refused there rather than counted at nothing.
  #oracle = false;

  constructor(options: PostingChainOptions) {
    const range = options.logRange ?? POSTING_LOG_RANGE;
    const lookback = options.lookback ?? POSTING_LOOKBACK;
    if (range < 1n) throw new RangeError("logRange must be at least one block");
    if (lookback < 0n) throw new RangeError("lookback must not be negative");
    if (options.fromBlock < 0n) throw new RangeError("fromBlock must not be negative");
    // viem signs with the chain ID as a JavaScript number.
    if (options.chainId < 1n || options.chainId > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError("chainId must be a positive safe integer");
    this.#client = options.client;
    this.#chainId = options.chainId;
    this.#board = getAddress(options.board);
    this.#from = options.fromBlock;
    this.#account = postingAccount(options.key);
    this.#range = range;
    this.#lookback = lookback;
  }

  /** The posting key's address, which pays for every call. */
  get address(): Address {
    return this.#account.address;
  }

  latest(): Promise<PostingHead> {
    return guard("latest block", async () => {
      const block = await this.#client.getBlock({ blockTag: "latest" });
      if (block.number === null) throw new Error("a pending block");
      return { number: block.number, timestamp: block.timestamp };
    });
  }

  simulate(posting: Uint8Array, ballot: Uint8Array): Promise<PostingSimulation> {
    return guard("simulation", async () => {
      // The gas limit the node finds the call needs, at most the cap: never
      // below the gas it used, so `g` over it is the headroom's at least.
      // viem's `estimateGas` drops `gas`, so the request is sent as is.
      let answer: unknown;
      try {
        answer = await this.#client.request({
          method: "eth_estimateGas",
          params: [
            {
              from: this.#account.address,
              to: this.#board,
              data: this.#calldata(posting, ballot),
              gas: `0x${POSTING_GAS_LIMIT_MAX.toString(16)}`,
            },
            "latest",
          ],
        } as never);
      } catch (e) {
        // A call that can't succeed within the cap used more than it,
        // which the worker refuses as `too-costly`; one the board reverts
        // is refused as `simulation`. Any other error, a rate limit or a
        // backend without the latest block among them, rejects, so the pair
        // stays queued (docs/spec/posting-relay.md, Sending, step 4).
        const message = nodeMessage(e);
        if (/gas required exceeds allowance/i.test(message))
          return { reverted: false, gasUsed: POSTING_GAS_LIMIT_MAX + 1n };
        if (reverted(e) || /execution reverted/i.test(message)) return { reverted: true };
        throw e;
      }
      if (typeof answer !== "string" || !QUANTITY.test(answer.toLowerCase()))
        throw new Error("a malformed estimate");
      return { reverted: false, gasUsed: BigInt(answer) };
    });
  }

  nonce(): Promise<bigint> {
    return guard("nonce", async () =>
      BigInt(
        await this.#client.getTransactionCount({
          address: this.#account.address,
          blockTag: "latest",
        }),
      ),
    );
  }

  costs(posting: Uint8Array, ballot: Uint8Array, gasLimit: bigint): Promise<PostingCosts> {
    return guard("costs", async () => {
      checkGasLimit(gasLimit);
      const code = await this.#client.getCode({ address: GAS_PRICE_ORACLE });
      if (code === undefined || code === "0x") {
        // A chain with no oracle (a local Anvil) charges no L1 fee; one
        // that had it doesn't lose it.
        if (this.#oracle) throw new Error("the fee oracle went away");
        return { l1DataFee: 0n, deposit: 0n };
      }
      this.#oracle = true;
      // Priced at the widest nonce and fees, so the signed call's bytes are
      // never longer than the ones priced.
      const unsigned = serializeTransaction({
        type: "eip1559",
        chainId: Number(this.#chainId),
        nonce: Number.MAX_SAFE_INTEGER,
        to: this.#board,
        data: this.#calldata(posting, ballot),
        value: 0n,
        gas: gasLimit,
        maxFeePerGas: U64_MAX,
        maxPriorityFeePerGas: U64_MAX,
      });
      const l1DataFee = await this.#client.readContract({
        address: GAS_PRICE_ORACLE,
        abi: gasPriceOracleAbi,
        functionName: "getL1Fee",
        args: [unsigned],
      });
      // No deposit yet: the forced path (part 2b-2b-2b-2b-3) sends none, so
      // there is nothing on L1 to reserve for.
      return { l1DataFee, deposit: 0n };
    });
  }

  sign(
    posting: Uint8Array,
    ballot: Uint8Array,
    options: {
      readonly nonce: bigint;
      readonly gasLimit: bigint;
      readonly feeCap: bigint;
      readonly fees?: { readonly maxFee: bigint; readonly priorityFee: bigint };
    },
  ): Promise<PostingSigned> {
    return guard("signing", async () => {
      const { nonce, gasLimit, feeCap, fees } = options;
      if (nonce < 0n || nonce > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("a nonce out of range");
      checkGasLimit(gasLimit);
      if (feeCap < 1n) throw new Error("a fee cap below 1 wei");
      let maxFee: bigint;
      let priorityFee: bigint;
      if (fees !== undefined) {
        // A replacement: exactly the fees core chose, which it keeps within
        // the cap; past it nothing is signed.
        ({ maxFee, priorityFee } = fees);
        if (maxFee > feeCap || priorityFee > maxFee || priorityFee < 0n)
          throw new Error("fees past the cap");
      } else {
        // The node's fee answers are its own, so the cap bounds what any
        // call can cost whatever it says (T-52).
        const estimate = await this.#client.estimateFeesPerGas({ chain: null, type: "eip1559" });
        maxFee = estimate.maxFeePerGas < feeCap ? estimate.maxFeePerGas : feeCap;
        priorityFee =
          estimate.maxPriorityFeePerGas < maxFee ? estimate.maxPriorityFeePerGas : maxFee;
      }
      const tx = await this.#account.signTransaction({
        type: "eip1559",
        chainId: Number(this.#chainId),
        nonce: Number(nonce),
        to: this.#board,
        data: this.#calldata(posting, ballot),
        value: 0n,
        gas: gasLimit,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: priorityFee,
      });
      return { tx: hexToBytes(tx), hash: hexToBytes(keccak256(tx)), maxFee, priorityFee };
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
        return /already known|known transaction|already imported|alreadyknown/i.test(nodeMessage(e))
          ? "sent"
          : "refused";
      }
      if (typeof hash !== "string" || hash.toLowerCase() !== keccak256(raw))
        throw new Error("the node named another transaction");
      return "sent";
    });
  }

  receipt(hash: Uint8Array): Promise<PostingReceipt | undefined> {
    return guard("receipt", async () => {
      if (hash.length !== 32) throw new Error("a hash out of form");
      const wanted = bytesToHex(hash);
      // As the node sends it, so an OP Stack receipt's `l1Fee` isn't lost
      // to a formatter that doesn't know it.
      const r = (await this.#client.request({
        method: "eth_getTransactionReceipt",
        params: [wanted],
      } as never)) as Record<string, unknown> | null;
      if (r === null) return undefined;
      if (typeof r !== "object") throw new Error("a malformed receipt");
      const field = (name: string): bigint => {
        const v = r[name];
        if (typeof v !== "string" || !QUANTITY.test(v.toLowerCase()))
          throw new Error("a malformed receipt");
        return BigInt(v);
      };
      if (typeof r["transactionHash"] !== "string" || r["transactionHash"].toLowerCase() !== wanted)
        throw new Error("another receipt");
      // A receipt is of a block, never of a pending transaction.
      field("blockNumber");
      let l1Fee = 0n;
      if (r["l1Fee"] !== undefined && r["l1Fee"] !== null) l1Fee = field("l1Fee");
      else if (this.#oracle || (await this.#hasOracle()))
        throw new Error("a receipt without its L1 fee");
      return { gasUsed: field("gasUsed"), effectiveGasPrice: field("effectiveGasPrice"), l1Fee };
    });
  }

  posted(posting: Uint8Array): Promise<boolean> {
    return guard("posting event", async () => {
      const event = postingEvent(posting);
      const [latest, finalized] = await Promise.all([
        this.#client.getBlock({ blockTag: "latest" }),
        this.#client.getBlock({ blockTag: "finalized" }),
      ]);
      if (latest.number === null || finalized.number === null) throw new Error("a pending block");
      if (finalized.number > latest.number) throw new Error("a finalized block past the latest");
      const search = this.#search(event.key, latest.number);
      if (await this.#advance(search, event, finalized.number)) return true;
      // Above the finalized block a reorganisation can drop or bring back
      // the event, so those blocks are read again on every ask.
      const lo =
        search.through + 1n > finalized.number + 1n ? search.through + 1n : finalized.number + 1n;
      return lo <= latest.number && (await this.#found(event, lo, latest.number));
    });
  }

  postedFinal(posting: Uint8Array): Promise<boolean> {
    return guard("final posting event", async () => {
      const event = postingEvent(posting);
      const finalized = await this.#client.getBlock({ blockTag: "finalized" });
      if (finalized.number === null) throw new Error("a pending block");
      return this.#advance(this.#search(event.key, finalized.number), event, finalized.number);
    });
  }

  #calldata(posting: Uint8Array, ballot: Uint8Array): Hex {
    return encodeFunctionData({
      abi: boardAbi,
      functionName: "submitPosting",
      args: [bytesToHex(posting), bytesToHex(ballot)],
    });
  }

  async #hasOracle(): Promise<boolean> {
    const code = await this.#client.getCode({ address: GAS_PRICE_ORACLE });
    this.#oracle = code !== undefined && code !== "0x";
    return this.#oracle;
  }

  /** The posting's search, started `lookback` behind `head` if it is new. */
  #search(key: Hex, head: bigint): Search {
    const kept = this.#searches.get(key);
    if (kept !== undefined) {
      // Re-set, so the ones let go are those asked of least recently.
      this.#searches.delete(key);
      this.#searches.set(key, kept);
      return kept;
    }
    const back = head - this.#lookback;
    const from = back > this.#from ? back : this.#from;
    const search: Search = { through: from - 1n, final: false };
    this.#searches.set(key, search);
    while (this.#searches.size > KEPT_SEARCHES)
      this.#searches.delete(this.#searches.keys().next().value as Hex);
    return search;
  }

  /** Brings the search up to `finalized`; true once an event is found at or below a finalized block. */
  async #advance(search: Search, event: PostingEvent, finalized: bigint): Promise<boolean> {
    if (search.final) return true;
    if (finalized > search.through) {
      const lo = search.through + 1n;
      if (await this.#found(event, lo, finalized)) search.final = true;
      else search.through = finalized;
    }
    return search.final;
  }

  /** Whether blocks `from` to `to` hold the posting's event, read a range at a time. */
  async #found(event: PostingEvent, from: bigint, to: bigint): Promise<boolean> {
    const ranges: [bigint, bigint][] = [];
    for (let lo = from; lo <= to; lo += this.#range)
      ranges.push([lo, lo + this.#range - 1n < to ? lo + this.#range - 1n : to]);
    const found = await Promise.all(ranges.map(([lo, hi]) => this.#foundIn(event, lo, hi)));
    return found.includes(true);
  }

  async #foundIn(event: PostingEvent, lo: bigint, hi: bigint): Promise<boolean> {
    const logs = (await this.#client.request({
      method: "eth_getLogs",
      params: [
        {
          address: this.#board,
          topics: event.topics,
          fromBlock: `0x${lo.toString(16)}`,
          toBlock: `0x${hi.toString(16)}`,
        },
      ],
    } as never)) as unknown;
    if (!Array.isArray(logs)) throw new Error("malformed logs");
    for (const log of logs as RawLog[]) {
      // A node that answers with a log of another contract or topics, out
      // of the asked range, pending or removed, is refused rather than read.
      if (
        typeof log !== "object" ||
        log === null ||
        typeof log.address !== "string" ||
        log.address.toLowerCase() !== this.#board.toLowerCase() ||
        typeof log.blockNumber !== "string" ||
        !QUANTITY.test(log.blockNumber.toLowerCase()) ||
        BigInt(log.blockNumber) < lo ||
        BigInt(log.blockNumber) > hi ||
        log.removed === true ||
        !Array.isArray(log.topics) ||
        log.topics.length !== 3 ||
        !log.topics.every((t, i) => typeof t === "string" && t.toLowerCase() === event.topics[i]) ||
        typeof log.data !== "string"
      )
        throw new Error("a log outside the asked filter");
      // Exactly the posting's bytes as the board encodes its record.
      if (log.data.toLowerCase() === event.data) return true;
    }
    return false;
  }
}

/** A posting's `SharePosted` filter and data, as the board emits them. */
interface PostingEvent {
  readonly key: Hex;
  readonly topics: readonly [Hex, Hex, Hex];
  readonly data: Hex;
}

function postingEvent(posting: Uint8Array): PostingEvent {
  // The relay sends only postings that decode (Sending, step 1); the
  // version is the record's own, which both of its versions begin the same
  // way after.
  const version = posting[2];
  if (version !== 1 && version !== 2) throw new Error("not a share posting");
  const { definition_hash, ballot_hash } =
    version === 1 ? decodeSharePosting(posting, 1) : decodeSharePosting(posting, 2);
  const topics = [SHARE_POSTED, bytesToHex(definition_hash), bytesToHex(ballot_hash)] as const;
  if (!topics.every((t) => HASH.test(t))) throw new Error("a topic out of form");
  return {
    key: keccak256(posting),
    topics,
    data: encodeAbiParameters([{ type: "bytes" }], [bytesToHex(posting)]).toLowerCase() as Hex,
  };
}

function checkGasLimit(gasLimit: bigint): void {
  if (gasLimit < 1n || gasLimit > POSTING_GAS_LIMIT_MAX)
    throw new Error("a gas limit out of range");
}

/** The node's own words for an error, wherever viem wrapped them. */
function nodeMessage(e: unknown): string {
  if (!(e instanceof BaseError)) return e instanceof Error ? e.message : "";
  const parts: string[] = [];
  e.walk((c) => {
    if (c instanceof BaseError) parts.push(c.details);
    else if (c instanceof Error) parts.push(c.message);
    return false;
  });
  return parts.join("\n");
}

/** viem read the node's answer as a revert (code 3). */
function reverted(e: unknown): boolean {
  return (
    e instanceof BaseError &&
    e.walk(
      (c) =>
        c instanceof ExecutionRevertedError ||
        (c as { code?: unknown } | null | undefined)?.code === ExecutionRevertedError.code,
    ) !== null
  );
}

/** The node answered with a JSON-RPC error, rather than failing to answer. */
function answered(e: unknown): boolean {
  return (
    e instanceof BaseError &&
    e.walk((c) => c instanceof RpcRequestError || c instanceof RpcError) !== null
  );
}

async function guard<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw new PostingChainError(step);
  }
}

/** The account a 32-byte key controls; a key out of secp256k1's range is refused without quoting it. */
function postingAccount(key: Uint8Array) {
  if (key.length !== 32) throw new RangeError("the posting key must be 32 bytes");
  try {
    return privateKeyToAccount(bytesToHex(key));
  } catch {
    // viem's message for an out-of-range key quotes the key.
    throw new RangeError("the posting key isn't a secp256k1 key");
  }
}
