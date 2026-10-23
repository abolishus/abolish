// The posting relay's forced path on L1 (docs/spec/posting-relay.md, Forced
// through L1 and Depositing; ADR 0042, rule 5; packages/core's
// `PostingDepositChain` and `PostingRegistryLog`): the posting key's
// deposits through the portal over viem from one L1 node, signed here and
// sent to it, beside the L2 reads the deposits judge by (the safe head) and
// the election registry's events the registered elections are checked
// against. Core decides; this file only reads, signs and sends.
//
// The portal is the one the deployment's L1 relay names, read once at
// startup (`checkPostingL1`) from the relay the board's election registry
// names, so a deposit goes where the board's own forced path does and no
// variable can point it elsewhere. A deposit's sender must be the posting
// key's externally owned account: a contract's would be aliased on L2, so
// the board would see another caller (T-50).
//
// Every failure throws `PostingChainError`, naming the node and a step and
// nothing else: viem's errors quote the URL, which can carry a provider's
// API key, and the request, which can carry `m_i` before the chain holds it
// or the signed transaction (T-10, T-15, T-18, T-69).

import { ballotRelayAbi, boardAbi } from "@abolishus/contracts/abi";
import {
  POSTING_CANCEL_GAS,
  POSTING_GAS_LIMIT_MAX,
  POSTING_L1_GAS_LIMIT_MAX,
  type PostingDepositChain,
  postingDepositGasLimit,
  postingDepositReserve,
  type PostingL1Head,
  type PostingL1Receipt,
  type PostingRegistration,
  type PostingRegistryLog,
  type PostingSigned,
} from "@abolishus/core";
import {
  type Address,
  bytesToHex,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBytes,
  keccak256,
  parseAbi,
  type PublicClient,
  toBytes,
} from "viem";
import {
  answered,
  guard,
  HASH,
  nodeMessage,
  POSTING_LOG_RANGE,
  postingAccount,
  QUANTITY,
  reverted,
  type ViemPostingChain,
} from "./posting-chain.ts";

const portalAbi = parseAbi([
  "function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable",
]);

const DEFINITION_REGISTERED = keccak256(
  toBytes("DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)"),
);

type Fees = { readonly maxFee: bigint; readonly priorityFee: bigint };

export interface PostingL1Deployment {
  /** The L1 the board's election registry names, as `checkPostingDeployment` read it. */
  readonly l1ChainId: bigint;
  /** The registry's L1 relay, which names the portal and the board it deposits to. */
  readonly l1Relay: Address;
  readonly board: Address;
  /** The posting key's address. */
  readonly address: Address;
}

/**
 * The forced path's startup check: throws, naming what differs and nothing
 * secret, unless the L1 node is on the chain the registry names, the
 * registry's L1 relay names this board, its portal holds code, and the
 * posting key's L1 account holds none (an EIP-7702 delegation would let
 * other code spend from it, and a contract's deposit is aliased on L2;
 * T-50, T-52). Returns the portal.
 */
export async function checkPostingL1(
  client: PublicClient,
  deployment: PostingL1Deployment,
): Promise<Address> {
  const chainId = BigInt(await client.getChainId());
  if (chainId !== deployment.l1ChainId) throw new Error("the L1 node is on another chain");
  const relayCode = await client.getCode({ address: deployment.l1Relay, blockTag: "finalized" });
  if (relayCode === undefined || relayCode === "0x")
    throw new Error("the registry's L1 relay holds no code on this L1");
  const [board, portal] = await Promise.all([
    client.readContract({
      address: deployment.l1Relay,
      abi: ballotRelayAbi,
      functionName: "board",
      blockTag: "finalized",
    }),
    client.readContract({
      address: deployment.l1Relay,
      abi: ballotRelayAbi,
      functionName: "portal",
      blockTag: "finalized",
    }),
  ]);
  if (getAddress(board) !== getAddress(deployment.board))
    throw new Error("the registry's L1 relay names another board");
  const portalCode = await client.getCode({ address: portal, blockTag: "finalized" });
  if (portalCode === undefined || portalCode === "0x") throw new Error("the portal holds no code");
  const code = await client.getCode({ address: deployment.address, blockTag: "latest" });
  if (code !== undefined && code !== "0x")
    throw new Error("the posting key's L1 account holds code");
  return getAddress(portal);
}

export interface PostingL1Options {
  /** One L1 node; its HTTP transport should time out well within core's `POSTING_CHAIN_TIMEOUT_MS`. */
  readonly client: PublicClient;
  readonly chainId: bigint;
  /** The portal, as `checkPostingL1` returns it. */
  readonly portal: Address;
  /** The board on L2 every deposit calls. */
  readonly board: Address;
  /** The posting key: it signs every deposit and pays for it (ADR 0042, option A). */
  readonly key: Uint8Array;
  /** The L1 fee cap: the most wei per L1 gas any deposit is signed to pay; a cancellation up to twice it. */
  readonly l1FeeCap: bigint;
}

/** The posting key on L1: the deposits' and cancellations' signing, sending and receipts, and the L1 heads. */
export class ViemPostingL1 {
  readonly #client: PublicClient;
  readonly #chainId: bigint;
  readonly #portal: Address;
  readonly #board: Address;
  readonly #account: ReturnType<typeof postingAccount>;
  readonly #l1FeeCap: bigint;

  constructor(options: PostingL1Options) {
    // viem signs with the chain ID as a JavaScript number.
    if (options.chainId < 1n || options.chainId > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError("chainId must be a positive safe integer");
    if (options.l1FeeCap < 1n) throw new RangeError("l1FeeCap must be at least 1 wei");
    this.#client = options.client;
    this.#chainId = options.chainId;
    this.#portal = getAddress(options.portal);
    this.#board = getAddress(options.board);
    this.#account = postingAccount(options.key);
    this.#l1FeeCap = options.l1FeeCap;
  }

  /** The posting key's address, the same on both chains. */
  get address(): Address {
    return this.#account.address;
  }

  latest(): Promise<PostingL1Head> {
    return this.#head("latest");
  }

  finalized(): Promise<PostingL1Head> {
    return this.#head("finalized");
  }

  nonce(): Promise<bigint> {
    return guard(
      "nonce",
      async () =>
        BigInt(
          await this.#client.getTransactionCount({
            address: this.#account.address,
            blockTag: "latest",
          }),
        ),
      "L1",
    );
  }

  nonceAt(block: bigint): Promise<bigint> {
    return guard(
      "nonce at a block",
      async () => {
        if (block < 0n) throw new Error("a block out of range");
        return BigInt(
          await this.#client.getTransactionCount({
            address: this.#account.address,
            blockNumber: block,
          }),
        );
      },
      "L1",
    );
  }

  /**
   * The L1 node's gas estimate at its latest block for the deposit of
   * `submitPosting(posting, ballot)` with L2 gas limit `gasLimit`; undefined
   * if it reverts, and one past `POSTING_L1_GAS_LIMIT_MAX` if no gas the
   * node allows is enough, which core refuses as past the cap.
   */
  estimate(posting: Uint8Array, ballot: Uint8Array, gasLimit: bigint): Promise<bigint | undefined> {
    return guard(
      "deposit estimate",
      async () => {
        checkGasLimit(gasLimit);
        let answer: unknown;
        try {
          answer = await this.#client.request({
            method: "eth_estimateGas",
            params: [
              {
                from: this.#account.address,
                to: this.#portal,
                data: this.#calldata(posting, ballot, gasLimit),
                value: "0x0",
              },
              "latest",
            ],
          } as never);
        } catch (e) {
          // A revert sends no deposit on this tend (Depositing, step 1); any
          // other failure, a rate limit among them, rejects.
          const message = nodeMessage(e);
          if (/gas required exceeds allowance/i.test(message)) return POSTING_L1_GAS_LIMIT_MAX + 1n;
          if (reverted(e) || /execution reverted/i.test(message)) return undefined;
          throw e;
        }
        if (typeof answer !== "string" || !QUANTITY.test(answer.toLowerCase()))
          throw new Error("a malformed estimate");
        return BigInt(answer);
      },
      "L1",
    );
  }

  /**
   * The reserve a first send counts for the call's deposit, priced as one
   * would be now (Depositing, steps 1 and 2): 0 if the estimate reverts or
   * its gas limit passes EIP-7825's cap.
   */
  async reserve(posting: Uint8Array, ballot: Uint8Array, gasLimit: bigint): Promise<bigint> {
    const estimate = await this.estimate(posting, ballot, gasLimit);
    if (estimate === undefined) return 0n;
    const l1GasLimit = postingDepositGasLimit(estimate);
    if (l1GasLimit === 0n || l1GasLimit > POSTING_L1_GAS_LIMIT_MAX) return 0n;
    return postingDepositReserve(l1GasLimit, this.#l1FeeCap);
  }

  signDeposit(
    posting: Uint8Array,
    ballot: Uint8Array,
    options: {
      readonly nonce: bigint;
      readonly gasLimit: bigint;
      readonly l1GasLimit: bigint;
      readonly feeCap: bigint;
      readonly fees?: Fees;
    },
  ): Promise<PostingSigned> {
    return guard(
      "deposit signing",
      async () => {
        const { nonce, gasLimit, l1GasLimit, feeCap, fees } = options;
        checkGasLimit(gasLimit);
        if (l1GasLimit < 1n || l1GasLimit > POSTING_L1_GAS_LIMIT_MAX)
          throw new Error("an L1 gas limit out of range");
        // T-52: never past the cap the operator set, whatever core asks.
        if (feeCap < 1n || feeCap > this.#l1FeeCap) throw new Error("a fee cap out of range");
        let chosen: Fees;
        if (fees !== undefined) {
          // A replacement: exactly the fees core chose, within the cap.
          checkFees(fees, feeCap);
          chosen = fees;
        } else {
          // The node's fee answers are its own, so the cap bounds what any
          // deposit can cost whatever it says.
          const estimate = await this.#client.estimateFeesPerGas({ chain: null, type: "eip1559" });
          const maxFee = estimate.maxFeePerGas < feeCap ? estimate.maxFeePerGas : feeCap;
          chosen = {
            maxFee,
            priorityFee:
              estimate.maxPriorityFeePerGas < maxFee ? estimate.maxPriorityFeePerGas : maxFee,
          };
        }
        return this.#sign({
          nonce,
          to: this.#portal,
          data: this.#calldata(posting, ballot, gasLimit),
          gas: l1GasLimit,
          fees: chosen,
        });
      },
      "L1",
    );
  }

  signCancel(options: { readonly nonce: bigint; readonly fees: Fees }): Promise<PostingSigned> {
    return guard(
      "cancellation signing",
      async () => {
        // A cancellation may pay up to twice the L1 fee cap (Depositing).
        checkFees(options.fees, 2n * this.#l1FeeCap);
        return this.#sign({
          nonce: options.nonce,
          to: this.#account.address,
          data: "0x",
          gas: POSTING_CANCEL_GAS,
          fees: options.fees,
        });
      },
      "L1",
    );
  }

  broadcast(tx: Uint8Array): Promise<"sent" | "refused"> {
    return guard(
      "broadcast",
      async () => {
        const raw = bytesToHex(tx);
        let hash: unknown;
        try {
          hash = await this.#client.request({ method: "eth_sendRawTransaction", params: [raw] });
        } catch (e) {
          if (!answered(e)) throw e;
          return /already known|known transaction|already imported|alreadyknown/i.test(
            nodeMessage(e),
          )
            ? "sent"
            : "refused";
        }
        if (typeof hash !== "string" || hash.toLowerCase() !== keccak256(raw))
          throw new Error("the node named another transaction");
        return "sent";
      },
      "L1",
    );
  }

  receipt(hash: Uint8Array): Promise<PostingL1Receipt | undefined> {
    return guard(
      "receipt",
      async () => {
        if (hash.length !== 32) throw new Error("a hash out of form");
        const wanted = bytesToHex(hash);
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
        if (
          typeof r["transactionHash"] !== "string" ||
          r["transactionHash"].toLowerCase() !== wanted
        )
          throw new Error("another receipt");
        const status = field("status");
        if (status > 1n) throw new Error("a malformed receipt");
        return {
          success: status === 1n,
          gasUsed: field("gasUsed"),
          effectiveGasPrice: field("effectiveGasPrice"),
          block: field("blockNumber"),
        };
      },
      "L1",
    );
  }

  #head(tag: "latest" | "finalized"): Promise<PostingL1Head> {
    return guard(
      `${tag} block`,
      async () => {
        const block = await this.#client.getBlock({ blockTag: tag });
        if (block.number === null) throw new Error("a pending block");
        return { number: block.number, timestamp: block.timestamp };
      },
      "L1",
    );
  }

  /** `depositTransaction(board, 0, gasLimit, false, submitPosting(posting, ballot))` on the portal. */
  #calldata(posting: Uint8Array, ballot: Uint8Array, gasLimit: bigint): Hex {
    return encodeFunctionData({
      abi: portalAbi,
      functionName: "depositTransaction",
      args: [this.#board, 0n, gasLimit, false, submitPostingCalldata(posting, ballot)],
    });
  }

  async #sign(t: {
    readonly nonce: bigint;
    readonly to: Address;
    readonly data: Hex;
    readonly gas: bigint;
    readonly fees: Fees;
  }): Promise<PostingSigned> {
    if (t.nonce < 0n || t.nonce > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("a nonce out of range");
    const tx = await this.#account.signTransaction({
      type: "eip1559",
      chainId: Number(this.#chainId),
      nonce: Number(t.nonce),
      to: t.to,
      data: t.data,
      value: 0n,
      gas: t.gas,
      maxFeePerGas: t.fees.maxFee,
      maxPriorityFeePerGas: t.fees.priorityFee,
    });
    return {
      tx: hexToBytes(tx),
      hash: hexToBytes(keccak256(tx)),
      maxFee: t.fees.maxFee,
      priorityFee: t.fees.priorityFee,
    };
  }
}

/** `submitPosting(posting, ballot)`'s calldata, as the L2 call carries it. */
function submitPostingCalldata(posting: Uint8Array, ballot: Uint8Array): Hex {
  return encodeFunctionData({
    abi: boardAbi,
    functionName: "submitPosting",
    args: [bytesToHex(posting), bytesToHex(ballot)],
  });
}

function checkGasLimit(gasLimit: bigint): void {
  if (gasLimit < 1n || gasLimit > POSTING_GAS_LIMIT_MAX)
    throw new Error("a gas limit out of range");
}

function checkFees(fees: Fees, cap: bigint): void {
  if (fees.maxFee > cap || fees.priorityFee > fees.maxFee || fees.priorityFee < 0n)
    throw new Error("fees past the cap");
}

/**
 * Core's `PostingDepositChain` from the posting key on both chains: the
 * safe-head reads from the L2 adapter, the rest from the L1 one.
 */
export function postingDepositChain(l2: ViemPostingChain, l1: ViemPostingL1): PostingDepositChain {
  return {
    includedSafe: (hash) => l2.includedSafe(hash),
    postedSafe: (posting) => l2.postedSafe(posting),
    nonce: () => l1.nonce(),
    nonceAt: (block) => l1.nonceAt(block),
    estimate: (posting, ballot, gasLimit) => l1.estimate(posting, ballot, gasLimit),
    signDeposit: (posting, ballot, options) => l1.signDeposit(posting, ballot, options),
    signCancel: (options) => l1.signCancel(options),
    broadcast: (tx) => l1.broadcast(tx),
    receipt: (hash) => l1.receipt(hash),
  };
}

export interface PostingRegistryOptions {
  /** The L2 node, as the posting worker's. */
  readonly client: PublicClient;
  /** The board's election registry, as `checkPostingDeployment` read it. */
  readonly registry: Address;
  /** The first block any of its events can be in: the board's deployment block. */
  readonly fromBlock: bigint;
  /** Blocks per log query; `POSTING_LOG_RANGE` unless a provider allows fewer. */
  readonly logRange?: bigint;
}

/**
 * The registry's `DefinitionRegistered` events in finalized L2 blocks, which
 * the registered elections check the index's progress against. The blocks
 * read are kept in memory with what they held, so each ask reads only the
 * finalized blocks since the last; finalized blocks never change.
 */
export class ViemPostingRegistry implements PostingRegistryLog {
  readonly #client: PublicClient;
  readonly #registry: Address;
  readonly #from: bigint;
  readonly #range: bigint;
  // Blocks `#start` to `#through` read, and the events in them.
  #start: bigint;
  #through: bigint;
  #found: PostingRegistration[] = [];

  constructor(options: PostingRegistryOptions) {
    const range = options.logRange ?? POSTING_LOG_RANGE;
    if (range < 1n) throw new RangeError("logRange must be at least one block");
    if (options.fromBlock < 0n) throw new RangeError("fromBlock must not be negative");
    this.#client = options.client;
    this.#registry = getAddress(options.registry);
    this.#from = options.fromBlock;
    this.#range = range;
    this.#start = options.fromBlock;
    this.#through = options.fromBlock - 1n;
  }

  registered(from: bigint): Promise<readonly PostingRegistration[]> {
    return guard("registry events", async () => {
      const start = from > this.#from ? from : this.#from;
      if (start < this.#start) {
        // Asked from further back than what is kept (the index wiped, say):
        // read again from there.
        this.#start = start;
        this.#through = start - 1n;
        this.#found = [];
      } else if (start > this.#start) {
        this.#start = start;
        this.#found = this.#found.filter((e) => e.l2Block >= start);
        if (this.#through < start - 1n) this.#through = start - 1n;
      }
      const finalized = await this.#client.getBlock({ blockTag: "finalized" });
      if (finalized.number === null) throw new Error("a pending block");
      // One range at a time, kept as it is read, so a node that fails
      // midway costs only the range it failed on.
      while (this.#through < finalized.number) {
        const lo = this.#through + 1n;
        const hi =
          lo + this.#range - 1n < finalized.number ? lo + this.#range - 1n : finalized.number;
        this.#found.push(...(await this.#read(lo, hi)));
        this.#through = hi;
      }
      return this.#found.slice();
    });
  }

  async #read(lo: bigint, hi: bigint): Promise<PostingRegistration[]> {
    const logs = (await this.#client.request({
      method: "eth_getLogs",
      params: [
        {
          address: this.#registry,
          topics: [DEFINITION_REGISTERED],
          fromBlock: `0x${lo.toString(16)}`,
          toBlock: `0x${hi.toString(16)}`,
        },
      ],
    } as never)) as unknown;
    if (!Array.isArray(logs)) throw new Error("malformed logs");
    const found: PostingRegistration[] = [];
    const times = new Map<bigint, bigint>();
    for (const log of logs as Record<string, unknown>[]) {
      // A node that answers with a log of another contract or event, out of
      // the asked range or removed, is refused rather than read (T-25).
      const topics = log?.["topics"];
      const blockNumber = log?.["blockNumber"];
      if (
        typeof log !== "object" ||
        log === null ||
        typeof log["address"] !== "string" ||
        log["address"].toLowerCase() !== this.#registry.toLowerCase() ||
        typeof blockNumber !== "string" ||
        !QUANTITY.test(blockNumber.toLowerCase()) ||
        BigInt(blockNumber) < lo ||
        BigInt(blockNumber) > hi ||
        log["removed"] === true ||
        !Array.isArray(topics) ||
        topics.length !== 3 ||
        !topics.every((t) => typeof t === "string" && HASH.test(t.toLowerCase())) ||
        (topics[0] as string).toLowerCase() !== DEFINITION_REGISTERED
      )
        throw new Error("a log outside the asked filter");
      const l2Block = BigInt(blockNumber);
      let timestamp = times.get(l2Block);
      if (timestamp === undefined) {
        timestamp = (await this.#client.getBlock({ blockNumber: l2Block })).timestamp;
        times.set(l2Block, timestamp);
      }
      found.push({ definitionHash: hexToBytes(topics[2] as Hex), l2Block, timestamp });
    }
    return found;
  }
}
