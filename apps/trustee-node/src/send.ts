// The board's contract-path sending (docs/spec/availability.md, Windows and
// Contract path; docs/spec/delivery.md, Direct submit): a seat's stored
// record sent to the board contract (`submitAvailabilityRecord` for an
// availability record, `submitReceiptBatch` for a share-receipt batch)
// through the seat's L2 node, which passes it to the sequencer, and
// deposited through the L2's portal on L1 when the sequencer refuses it,
// holds it back, or the cutoff is near. The L2 must include a deposit within
// its sequencing window `F` whatever the sequencer wants, and a record
// counts by the time of the L2 block that emits it, so a deposit on L1 by a
// cutoff of its deadline less `F` (`c_I` for `t_A`, `c_D` for `t_D`) lands
// in time (T-25, T-50, T-71).
//
// One account, the deployment's, pays on both chains. It grants no
// authority: the board accepts each record for its P-256 signature, which
// binds the seat, whoever sends it, so the key only spends the account's
// gas. It signs nothing but these calls and deposits of them. The board
// takes a byte-identical repeat as a no-op, so a record that reaches it both
// ways, or again after a restart, costs gas and nothing else (T-52).
//
// Nothing here decides whether a record is recorded: the seat reads that
// from finalized L2 history, and resends until it is. What a node answers
// here only decides when to deposit, so a node that lies about a receipt can
// delay the deposit to `cutoff − forceLead`, never past it, and one that
// lies about nonces can make the sender sign at most
// `MAX_SIGNED_PER_RECORD` transactions of a record on each chain.
import { boardAbi } from "@abolishus/contracts/abi";
import { FORCED_PATH } from "@abolishus/crypto";
import { chainId, type Rpc, RpcError } from "@abolishus/node";
import { bytesToHex, encodeFunctionData, type Hex, hexToBytes, keccak256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ContractPath } from "./availability.ts";
import type { ReceiptPath } from "./delivery.ts";

/**
 * The gas limit of the board call, sent or deposited: the board's figure for
 * an availability record is at most about 172,000 cold with its intrinsic
 * gas, and an attestation naming 32 roots, the most a record can, about
 * 422,000 (docs/spec/contracts.md, Board, Gas). Fixed rather than estimated,
 * so no node's answer can starve the call, which would revert and leave the
 * slot empty.
 */
export const AVAILABILITY_CALL_GAS = 600_000n;

/**
 * The gas limit of the receipt-batch call, sent or deposited: the release's
 * `RECEIPT_CALL_GAS`, measured cold for a full batch of `RECEIPT_BATCH_MAX`
 * pairs, which the board's tests require a deposit with exactly this limit
 * to carry (docs/spec/delivery.md, Capacity).
 */
export const RECEIPT_CALL_GAS = FORCED_PATH.receiptCallGas;

/** EIP-7825's cap on one transaction's gas, 2²⁴: a deposit estimated past it can't be sent. */
export const MAX_TRANSACTION_GAS = 1n << 24n;

/**
 * The least gas the deposit's L1 transaction is given whatever the L1 node
 * estimates: the portal's call with its resource metering, and the data, run
 * to about 100,000 at an availability record's size.
 */
export const DEPOSIT_GAS_FLOOR = 150_000n;

const portalAbi = parseAbi([
  "function depositTransaction(address to, uint256 value, uint64 gasLimit, bool isCreation, bytes data) payable",
]);

export interface SendOptions {
  /** The seat's own L2 node, which passes transactions to the sequencer. */
  readonly l2: Rpc;
  readonly l2ChainId: bigint;
  /** An L1 node, for the deposit. */
  readonly l1: Rpc;
  readonly l1ChainId: bigint;
  /** The deployment's board contract on L2, 20 bytes. */
  readonly board: Uint8Array;
  /** The L2's `OptimismPortal` on L1, 20 bytes: the deployment's pin. */
  readonly portal: Uint8Array;
  /** The paying account's secp256k1 secret key, 32 bytes; funded on both chains. */
  readonly accountKey: Uint8Array;
  /** The most the account pays a unit of gas on each chain, in wei. */
  readonly l2MaxFeePerGas: bigint;
  readonly l1MaxFeePerGas: bigint;
  /** Seconds a record may wait outside any L2 block before it is deposited. */
  readonly forceAfter: bigint;
  /** Seconds before the cutoff from which every unrecorded record is deposited. */
  readonly forceLead: bigint;
  /** The node's wall clock, in seconds. */
  readonly clock: () => bigint;
}

export type SendErrorCode =
  /** A node is on another chain than the deployment's. */
  | "chain"
  /** The board or the portal has no code: a transaction to it would do nothing. */
  | "no-code"
  /** The board reverted the call: it refuses the record, so no resend can get it recorded. */
  | "reverted"
  /** Neither the sequencer nor the portal took the record now. */
  | "unsent"
  /** The deposit's L1 transaction would need more gas than one transaction may have. */
  | "deposit-gas";

export class SendError extends Error {
  override readonly name = "SendError";
  readonly code: SendErrorCode;
  constructor(code: SendErrorCode) {
    super(code);
    this.code = code;
  }
}

function quantity(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/u.test(value))
    throw new RpcError(`${what}: not a quantity`);
  return BigInt(value);
}

const txHash = (tx: Uint8Array) => keccak256(tx);

type Inclusion = "none" | "succeeded" | "reverted";

/** Whether the node holds the transaction in a block, and how it ran. */
async function inclusion(rpc: Rpc, hash: Hex): Promise<Inclusion> {
  const r = await rpc.call("eth_getTransactionReceipt", [hash]);
  if (r === null) return "none";
  if (typeof r !== "object") throw new RpcError("eth_getTransactionReceipt: not a receipt");
  const { status, transactionHash } = r as { status?: unknown; transactionHash?: unknown };
  if (typeof transactionHash !== "string" || transactionHash.toLowerCase() !== hash)
    throw new RpcError("eth_getTransactionReceipt: another transaction's receipt");
  if (status === "0x1") return "succeeded";
  if (status === "0x0") return "reverted";
  throw new RpcError("eth_getTransactionReceipt: no status");
}

/**
 * Hands a signed transaction to a node: `stale` when the account's nonce
 * has moved past it without it, so it can never be included and is signed
 * again. Any other refusal throws `RpcError`.
 */
async function broadcast(rpc: Rpc, tx: Uint8Array): Promise<"sent" | "stale"> {
  const raw = bytesToHex(tx);
  let hash: unknown;
  try {
    hash = await rpc.call("eth_sendRawTransaction", [raw]);
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    // Nodes word these in their own way (geth, reth, Anvil).
    if (/already known|known transaction|already imported/i.test(e.message)) return "sent";
    if (/nonce too low|nonce has already been used/i.test(e.message)) return "stale";
    throw e;
  }
  if (typeof hash !== "string" || hash.toLowerCase() !== txHash(tx))
    throw new RpcError("eth_sendRawTransaction: another transaction's hash");
  return "sent";
}

interface Chain {
  readonly rpc: Rpc;
  readonly id: bigint;
  readonly maxFeePerGas: bigint;
}

/**
 * The most transactions the sender signs for one record on one chain. Each
 * is valid until its nonce is used, so a node answering "nonce too low" or
 * "reverted" on every send could otherwise collect a deposit a step and
 * broadcast them all, spending the account to `t_A` (T-52). Three covers a
 * nonce another transaction took and a deposit the portal's metering
 * reverted.
 */
export const MAX_SIGNED_PER_RECORD = 3;

/** One chain's transaction for a record: the signed bytes resent, and how many were signed. */
interface Slot {
  tx?: Uint8Array;
  signed: number;
}

/** What the sender holds of one record. */
interface Pending {
  /** When the record was first offered, by the node's clock. */
  readonly since: bigint;
  readonly l2: Slot;
  readonly deposit: Slot;
}

/** The board calls one sender makes, sharing its account, so its nonces. */
export interface BoardSender {
  /** `submitAvailabilityRecord`, by the point's cutoff. */
  readonly availability: ContractPath["send"];
  /** `submitReceiptBatch`, by `c_D`. */
  readonly receiptBatch: ReceiptPath["send"];
}

/**
 * The board's calls over the seat's L2 node and an L1 node. Checks both
 * nodes' chains and that the board and the portal have code, once, here
 * (`SendError`). Each send offers the record's board call to the sequencer,
 * resending the same signed transaction until it is in a block, and deposits
 * it through the portal, resending that deposit until it is in an L1 block,
 * once the sequencer refuses it, once it has waited `forceAfter` outside any
 * block, and from `cutoff − forceLead` whatever the sequencer did. Throws
 * `SendError` `unsent` when neither took it now, `reverted` when the board
 * refused it on L2 (deposited all the same from `cutoff − forceLead`, so no
 * node's receipt keeps the record off L1), and `deposit-gas` when the
 * deposit can't be sent at all. Sends run one at a time, so two never take
 * one nonce; the deployment runs one sender per account, since two would.
 */
export async function boardSender(options: SendOptions): Promise<BoardSender> {
  const o = options;
  if (o.board.length !== 20 || o.portal.length !== 20)
    throw new RangeError("send: board and portal must be 20-byte addresses");
  if (o.accountKey.length !== 32) throw new RangeError("send: accountKey must be 32 bytes");
  if (o.l2MaxFeePerGas <= 0n || o.l1MaxFeePerGas <= 0n)
    throw new RangeError("send: the fee caps must be positive");
  if (o.forceAfter < 0n || o.forceLead < 0n)
    throw new RangeError("send: forceAfter and forceLead must be ≥ 0");
  let account;
  try {
    account = privateKeyToAccount(bytesToHex(o.accountKey));
  } catch {
    // viem's message would quote the key.
    throw new RangeError("send: accountKey is not a secp256k1 secret key");
  }
  const l2: Chain = { rpc: o.l2, id: o.l2ChainId, maxFeePerGas: o.l2MaxFeePerGas };
  const l1: Chain = { rpc: o.l1, id: o.l1ChainId, maxFeePerGas: o.l1MaxFeePerGas };
  for (const c of [l2, l1]) if ((await chainId(c.rpc)) !== c.id) throw new SendError("chain");
  const board = bytesToHex(o.board);
  const portal = bytesToHex(o.portal);
  for (const [c, address] of [
    [l2, board],
    [l1, portal],
  ] as const) {
    const code = await c.rpc.call("eth_getCode", [address, "latest"]);
    if (typeof code !== "string" || !/^0x([0-9a-fA-F]{2})*$/u.test(code))
      throw new RpcError("eth_getCode: not bytes");
    if (code === "0x") throw new SendError("no-code");
  }

  const sign = async (c: Chain, to: Hex, data: Hex, gas: bigint): Promise<Uint8Array> => {
    const nonce = quantity(
      await c.rpc.call("eth_getTransactionCount", [account.address, "pending"]),
      "eth_getTransactionCount",
    );
    // viem takes a nonce as a number; EIP-2681 bounds it below 2⁶⁴ − 1, and
    // no account reaches 2⁵³.
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RpcError("eth_getTransactionCount: a nonce no account reaches");
    const tip = quantity(
      await c.rpc.call("eth_maxPriorityFeePerGas", []),
      "eth_maxPriorityFeePerGas",
    );
    // The cap is the fee itself: a transaction pays only the block's base
    // fee and its tip, so the most it may pay is what keeps it includable.
    return hexToBytes(
      await account.signTransaction({
        type: "eip1559",
        chainId: Number(c.id),
        nonce: Number(nonce),
        to,
        data,
        value: 0n,
        gas,
        maxFeePerGas: c.maxFeePerGas,
        maxPriorityFeePerGas: tip < c.maxFeePerGas ? tip : c.maxFeePerGas,
      }),
    );
  };

  /**
   * Resends the slot's transaction until it is in a block, signing anew
   * when there is none yet, its nonce went to another transaction, or it
   * reverted and `retry` says a new one may help, at most
   * `MAX_SIGNED_PER_RECORD` times. Returns whether a block holds it.
   */
  const offer = async (
    c: Chain,
    slot: Slot,
    retry: boolean,
    build: () => Promise<Uint8Array>,
  ): Promise<Inclusion> => {
    const signed = slot.tx;
    if (signed !== undefined) {
      const state = await inclusion(c.rpc, txHash(signed));
      if (state === "succeeded" || (state === "reverted" && !retry)) return state;
      if (state === "none") {
        if ((await broadcast(c.rpc, signed)) === "sent") return state;
        // Mined between the receipt and the resend, rather than replaced.
        if ((await inclusion(c.rpc, txHash(signed))) === "succeeded") return "succeeded";
      }
    }
    if (slot.signed >= MAX_SIGNED_PER_RECORD)
      throw new RpcError("signed as many transactions for the record as it may");
    const tx = await build();
    slot.signed++;
    slot.tx = tx;
    if ((await broadcast(c.rpc, tx)) === "stale")
      throw new RpcError("eth_sendRawTransaction: the nonce moved on");
    return "none";
  };

  const depositGas = async (data: Hex): Promise<bigint> => {
    const estimate = quantity(
      await l1.rpc.call("eth_estimateGas", [{ from: account.address, to: portal, data }]),
      "eth_estimateGas",
    );
    const gas = estimate + estimate / 4n;
    if (gas > MAX_TRANSACTION_GAS) throw new SendError("deposit-gas");
    return gas < DEPOSIT_GAS_FLOOR ? DEPOSIT_GAS_FLOOR : gas;
  };

  const pending = new Map<string, Pending>();
  let queue: Promise<unknown> = Promise.resolve();

  const send = async (
    functionName: "submitAvailabilityRecord" | "submitReceiptBatch",
    gasLimit: bigint,
    record: Uint8Array,
    cutoff: bigint,
  ): Promise<void> => {
    const now = o.clock();
    const call = encodeFunctionData({ abi: boardAbi, functionName, args: [bytesToHex(record)] });
    const key = keccak256(call);
    const p: Pending = pending.get(key) ?? {
      since: now,
      l2: { signed: 0 },
      deposit: { signed: 0 },
    };
    pending.set(key, p);

    let l2State: Inclusion | "refused";
    try {
      // The board's revert is final: the same call reverts again.
      l2State = await offer(l2, p.l2, false, () => sign(l2, board, call, gasLimit));
    } catch (e) {
      // An unreachable node and a refusing sequencer alike leave the record
      // to the portal.
      if (!(e instanceof RpcError)) throw e;
      l2State = "refused";
    }
    const late = now >= cutoff - o.forceLead;
    // Only the node says the board reverted, so from `cutoff − forceLead`
    // the record is deposited all the same: one deposit, which an honest
    // node's revert makes a reverted deposit on L2.
    if (l2State === "reverted" && !late) throw new SendError("reverted");
    const force =
      l2State === "refused" || (l2State === "none" && now - p.since >= o.forceAfter) || late;
    if (!force) return;

    const deposit = encodeFunctionData({
      abi: portalAbi,
      functionName: "depositTransaction",
      args: [board, 0n, gasLimit, false, call],
    });
    try {
      // A deposit that reverted on L1 made no deposit, and the portal's
      // metering can revert one whose gas a quiet market's estimate set: it
      // is signed again, with a fresh estimate.
      await offer(l1, p.deposit, true, async () =>
        sign(l1, portal, deposit, await depositGas(deposit)),
      );
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      throw new SendError("unsent");
    }
    if (l2State === "reverted") throw new SendError("reverted");
  };

  const queued =
    (functionName: Parameters<typeof send>[0], gasLimit: bigint) =>
    (record: Uint8Array, cutoff: bigint) => {
      const run = queue.then(() => send(functionName, gasLimit, record, cutoff));
      queue = run.catch(() => undefined);
      return run;
    };
  return {
    availability: queued("submitAvailabilityRecord", AVAILABILITY_CALL_GAS),
    receiptBatch: queued("submitReceiptBatch", RECEIPT_CALL_GAS),
  };
}

/** `ContractPath.send`: the availability call of a sender of its own (`boardSender`). */
export async function availabilitySender(options: SendOptions): Promise<ContractPath["send"]> {
  return (await boardSender(options)).availability;
}
