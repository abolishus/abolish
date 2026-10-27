// The anchoring authority's Safe (docs/spec/contracts.md, Board anchor;
// P4-1 part 2b-2a): the check that the authority is the Safe the deployment
// record names, configured so that only its owners' threshold can act as it,
// and the sender `ViemAnchorChain` takes, which signs the anchor call as a
// Safe transaction with the runner's owner keys and executes it.
//
// The anchor pins only the Safe's address, and a quorum can later make one
// key the authority without touching the anchor: by enabling a module (which
// executes as the Safe with no signatures), setting a guard or another
// fallback handler, or replacing the proxy's singleton (Board anchor,
// Known-weak). The Safe's own getters don't show everything: a delegatecall
// can write a module or an owner into the Safe's mappings without linking it
// into the lists `getModulesPaginated` and `getOwners` walk, and the Safe
// lets it act. So the Safe is a SafeL2, which logs every execution with its
// operation, and the check reads its whole history as well as its state:
// set up with no setup delegatecall, never a delegatecall since, and never a
// module's execution. With no delegatecall ever, the Safe's storage changed
// only through its own functions, which keep the lists whole, so its getters
// and slots show what can act (T-49, T-69). The runner signs for nothing
// else: a Safe changed since the deployment record is an alarm for a person,
// never a transaction to keep signing. The owners and the threshold are
// pinned too, so the quorum the record names is the one the runners sign
// for.
//
// A Safe transaction is signed with no `safeTxGas`, base gas or gas price,
// so a Safe whose anchor call reverts reverts as a whole (`GS013`), leaving
// its nonce and the anchor unchanged (packages/contracts/test/
// BoardAnchorSafe.t.sol); the receipt must also carry the Safe's
// `ExecutionSuccess` for exactly the hash signed. Keys are used for nothing
// but signing, and what this file throws is its own fixed text, never a
// key, a signature or a node's answer (T-10, T-65).

import { boardAnchorAbi } from "@abolishus/contracts/abi";
import {
  type Address,
  BaseError,
  bytesToHex,
  encodeFunctionData,
  getAddress,
  type Hex,
  hashTypedData,
  keccak256,
  parseAbi,
  parseEventLogs,
  type PublicClient,
  recoverAddress,
  toFunctionSelector,
  TransactionReceiptNotFoundError,
  zeroAddress,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

/** The parts of SafeL2 v1.4.1's interface the check and the sender use. */
export const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)",
  "event SafeSetup(address indexed initiator, address[] owners, uint256 threshold, address initializer, address fallbackHandler)",
  "event SafeMultiSigTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures, bytes additionalInfo)",
  "event SafeModuleTransaction(address module, address to, uint256 value, bytes data, uint8 operation)",
  "event ExecutionFromModuleSuccess(address indexed module)",
  "event ExecutionFromModuleFailure(address indexed module)",
]);

const HISTORY_EVENTS = safeAbi.filter(
  (item) =>
    item.type === "event" &&
    [
      "SafeSetup",
      "SafeMultiSigTransaction",
      "SafeModuleTransaction",
      "ExecutionFromModuleSuccess",
      "ExecutionFromModuleFailure",
    ].includes(item.name),
);

/** The modules list's sentinel (Safe's `ModuleManager`). */
const SENTINEL = "0x0000000000000000000000000000000000000001";
/** `keccak256("guard_manager.guard.address")` (Safe's `GuardManager`). */
export const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
/** `keccak256("fallback_manager.handler.address")` (Safe's `FallbackManager`). */
export const FALLBACK_HANDLER_SLOT =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
/** The proxy keeps its singleton in slot 0 (Safe's `SafeProxy`). */
const SINGLETON_SLOT = "0x0";
/** The most blocks one `eth_getLogs` asks for, within common node limits. */
export const LOG_RANGE = 5_000n;
/** The order of secp256k1, which a key must be below. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const ANCHOR_SELECTOR = toFunctionSelector(
  boardAnchorAbi.find((item) => item.type === "function" && item.name === "anchor")!,
);

/** The EIP-712 type a Safe owner signs (Safe v1.4.1, `SAFE_TX_TYPEHASH`). */
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The anchoring authority as the deployment record names it. */
export interface AnchorSafe {
  /** The Safe's proxy: the anchor's `authority`. */
  readonly address: Address;
  /** The block the proxy was created and set up in. */
  readonly deploymentBlock: bigint;
  /** `keccak256` of the proxy's runtime code. */
  readonly proxyCodeHash: Hex;
  /** The SafeL2 singleton the proxy must delegate to, and `keccak256` of its runtime code. */
  readonly singleton: Address;
  readonly singletonCodeHash: Hex;
  /** Exactly the Safe's owners, in any order. */
  readonly owners: readonly Address[];
  /** At least 2, at most the number of owners: no single key acts as the Safe. */
  readonly threshold: bigint;
  /** The fallback handler, or the zero address for none. */
  readonly fallbackHandler: Address;
}

const word = (value: Hex | undefined) => BigInt(value === undefined || value === "0x" ? 0 : value);
const sameSet = (a: readonly Address[], b: readonly Address[]) => {
  const x = a.map((o) => getAddress(o)).sort();
  const y = b.map((o) => getAddress(o)).sort();
  return x.length === y.length && new Set(x).size === x.length && x.every((o, i) => o === y[i]);
};

/**
 * The Safe at `blockNumber` is exactly `safe`: its history from its
 * deployment (`checkAnchorSafeHistory`) and its state there
 * (`checkAnchorSafeState`). Throws naming the first mismatch.
 */
export async function checkAnchorSafe(
  client: PublicClient,
  safe: AnchorSafe,
  blockNumber: bigint,
): Promise<void> {
  await checkAnchorSafeHistory(client, safe, safe.deploymentBlock, blockNumber);
  await checkAnchorSafeState(client, safe, blockNumber);
}

/**
 * The Safe's logs in blocks `from` to `to`: one `SafeSetup` with no
 * initializer in its deployment block, if the range holds it, and none
 * elsewhere; every `SafeMultiSigTransaction` a `CALL`; no module's
 * execution. Read `LOG_RANGE` blocks at a time.
 */
export async function checkAnchorSafeHistory(
  client: PublicClient,
  safe: AnchorSafe,
  from: bigint,
  to: bigint,
): Promise<void> {
  if (from < safe.deploymentBlock) throw new RangeError("the history starts at the deployment");
  const address = getAddress(safe.address);
  let setups = 0;
  for (let start = from; start <= to; start += LOG_RANGE) {
    const end = start + LOG_RANGE - 1n < to ? start + LOG_RANGE - 1n : to;
    const logs = await client.getLogs({
      address,
      events: HISTORY_EVENTS,
      fromBlock: start,
      toBlock: end,
      strict: true,
    });
    for (const log of logs) {
      if (getAddress(log.address) !== address) throw new Error("the node returned another's logs");
      switch (log.eventName) {
        case "SafeSetup":
          if (log.blockNumber !== safe.deploymentBlock || log.args.initializer !== zeroAddress)
            throw new Error("the Safe's setup isn't the record's");
          setups += 1;
          break;
        case "SafeMultiSigTransaction":
          if (log.args.operation !== 0) throw new Error("the Safe has made a delegatecall");
          break;
        default:
          throw new Error("a module has acted as the Safe");
      }
    }
  }
  if (setups !== (from === safe.deploymentBlock ? 1 : 0))
    throw new Error("the Safe's setup isn't the record's");
}

/**
 * The Safe's state at `blockNumber`: the proxy's and singleton's code, the
 * singleton it delegates to, its owners and threshold, no module, no guard
 * and the named fallback handler. Sound only over a history
 * `checkAnchorSafeHistory` accepted, since a delegatecall can act through
 * entries the getters don't list. The record itself is refused if its
 * threshold is below 2 or above its owners.
 */
export async function checkAnchorSafeState(
  client: PublicClient,
  safe: AnchorSafe,
  blockNumber: bigint,
): Promise<void> {
  if (safe.threshold < 2n || safe.threshold > BigInt(safe.owners.length))
    throw new RangeError("the Safe's threshold must be at least 2 and at most its owners");
  const address = getAddress(safe.address);
  const codeHash = async (a: Address) => {
    const code = await client.getCode({ address: a, blockNumber });
    return code === undefined || code === "0x" ? undefined : keccak256(code);
  };
  if ((await codeHash(address)) !== safe.proxyCodeHash.toLowerCase())
    throw new Error("the authority isn't the Safe's proxy");
  const slot = (s: Hex) => client.getStorageAt({ address, slot: s, blockNumber });
  const [singleton, guard, handler] = await Promise.all([
    slot(SINGLETON_SLOT),
    slot(GUARD_SLOT),
    slot(FALLBACK_HANDLER_SLOT),
  ]);
  if (word(singleton) !== BigInt(safe.singleton))
    throw new Error("the Safe delegates to another singleton");
  if ((await codeHash(getAddress(safe.singleton))) !== safe.singletonCodeHash.toLowerCase())
    throw new Error("the Safe's singleton has other code");
  if (word(guard) !== 0n) throw new Error("the Safe has a guard");
  if (word(handler) !== BigInt(safe.fallbackHandler))
    throw new Error("the Safe has another fallback handler");
  const at = { address, abi: safeAbi, blockNumber } as const;
  const [owners, threshold, [modules]] = await Promise.all([
    client.readContract({ ...at, functionName: "getOwners" }),
    client.readContract({ ...at, functionName: "getThreshold" }),
    client.readContract({ ...at, functionName: "getModulesPaginated", args: [SENTINEL, 1n] }),
  ]);
  if (modules.length !== 0) throw new Error("the Safe has a module");
  if (!sameSet(owners, safe.owners)) throw new Error("the Safe has other owners");
  if (threshold !== safe.threshold) throw new Error("the Safe has another threshold");
}

/** One owner's signature over a Safe transaction's hash. */
export interface SafeSigner {
  readonly address: Address;
  /** A 65-byte `r ‖ s ‖ v` signature of `hash` itself, `v` 27 or 28. */
  sign(hash: Hex): Promise<Hex>;
}

/** A secp256k1 key's account, refused without quoting the key. */
function account(key: Uint8Array, what: string): PrivateKeyAccount {
  if (key.length !== 32) throw new TypeError(`${what} is 32 bytes`);
  const k = BigInt(bytesToHex(key));
  if (k === 0n || k >= SECP256K1_N) throw new RangeError(`${what} isn't a secp256k1 key`);
  return privateKeyToAccount(bytesToHex(key));
}

/** An owner key held by this runner. */
export function keySigner(key: Uint8Array): SafeSigner {
  const a = account(key, "an owner key");
  return { address: a.address, sign: (hash) => a.sign({ hash }) };
}

/** How many of the latest base fee a transaction's fee cap allows, before its tip. */
const BASE_FEE_HEADROOM = 3n;
/** Headroom over the node's gas estimate, in percent. */
const GAS_HEADROOM = 120n;
/**
 * A replacement's least fee, as eighths of the pending transaction's: pools
 * refuse one that doesn't raise both its fee cap and its tip by their
 * margin (10% by geth's default), so 12.5% clears it with room. One wei
 * more on top, so a zero tip is raised too.
 */
const REPLACEMENT_EIGHTHS = 9n;
const bumped = (fee: bigint) => (fee * REPLACEMENT_EIGHTHS) / 8n + 1n;
/**
 * A replacement's fees are at most this many times today's (plus one wei).
 * A pending transaction priced above that is over the market and is mined
 * without one, and sends refused run after run (an executor short of
 * funds) can't compound the fees past what it can pay once refunded.
 */
const REPLACEMENT_CAP = 2n;
const replacing = (last: bigint, today: bigint) => {
  const [want, cap] = [bumped(last), today * REPLACEMENT_CAP + 1n];
  return want < today ? today : want > cap ? cap : want;
};

export interface SafeSenderOptions {
  /** One L1 node. */
  readonly client: PublicClient;
  /** The node's chain, as `checkAnchorDeployment` checked it. */
  readonly chainId: bigint;
  /** The board anchor: the only contract, and `anchor` the only function, this sender calls. */
  readonly anchor: Address;
  readonly safe: AnchorSafe;
  /** Owners' signers; their first `threshold` valid signatures are used. */
  readonly signers: readonly SafeSigner[];
  /** The key that pays for and sends the Safe's transaction; it needn't be an owner. */
  readonly executor: Uint8Array;
  /** How long to wait for the transaction's receipt. */
  readonly receiptTimeoutMs?: number;
  readonly pollMs?: number;
}

/**
 * `ViemAnchorChain`'s sender: `anchor` calldata to the anchor as a
 * transaction of the Safe, checked, signed by the threshold's owners and
 * executed. Resolves once a successful receipt carries the Safe's
 * `ExecutionSuccess` for it; throws otherwise, without a transaction if the
 * Safe has changed, too few owners signed, or the node's estimate of the
 * execution reverts. The Safe's history up to the finalized block is read
 * once and remembered; the rest, and its state, on every call.
 */
export function safeSender(options: SafeSenderOptions): (calldata: Uint8Array) => Promise<void> {
  const { client, chainId, safe } = options;
  const address = getAddress(safe.address);
  const anchor = getAddress(options.anchor);
  const owners = new Set(safe.owners.map((o) => getAddress(o)));
  const signers = options.signers.map((s) => ({ ...s, address: getAddress(s.address) }));
  if (signers.some((s) => !owners.has(s.address)))
    throw new Error("a signer isn't one of the Safe's owners");
  if (new Set(signers.map((s) => s.address)).size < safe.threshold)
    throw new Error("fewer signers than the Safe's threshold");
  const executor = account(options.executor, "the executor key");
  const timeout = options.receiptTimeoutMs ?? 600_000;
  const pollMs = options.pollMs ?? 2_000;
  // The finalized history already accepted, and the highest block read: a
  // node (or a load balancer's other node) that later answers from below it
  // could show a Safe from before a change (T-49).
  let checkedThrough = safe.deploymentBlock - 1n;
  let seen = 0n;
  // The fees of the last transaction signed and its nonce. One whose receipt
  // didn't come in time can still be pending at the latest nonce, and the
  // next call, a checkpoint's or a locator's, replaces it only at fees the
  // pool takes as a replacement (T-49).
  let last: { nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined;

  return async (calldata) => {
    if (bytesToHex(calldata.subarray(0, 4)) !== ANCHOR_SELECTOR)
      throw new Error("the sender signs only anchor calls");
    const [block, finalized] = await Promise.all([
      client.getBlock({ blockTag: "latest" }),
      client.getBlock({ blockTag: "finalized" }),
    ]);
    if (block.number < seen || finalized.number > block.number)
      throw new Error("the node is behind blocks already read");
    seen = block.number;
    if (finalized.number > checkedThrough) {
      await checkAnchorSafeHistory(client, safe, checkedThrough + 1n, finalized.number);
      checkedThrough = finalized.number;
    }
    await checkAnchorSafeHistory(client, safe, checkedThrough + 1n, block.number);
    await checkAnchorSafeState(client, safe, block.number);
    const nonce = await client.readContract({
      address,
      abi: safeAbi,
      functionName: "nonce",
      blockNumber: block.number,
    });
    const message = {
      to: anchor,
      value: 0n,
      data: bytesToHex(calldata),
      operation: 0, // CALL: a delegatecall would run the anchor's code as the Safe.
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce,
    } as const;
    const hash = hashTypedData({
      domain: { chainId, verifyingContract: address },
      types: SAFE_TX_TYPES,
      primaryType: "SafeTx",
      message,
    });
    const signatures = await signaturesOf(signers, hash, safe.threshold);
    const data = encodeFunctionData({
      abi: safeAbi,
      functionName: "execTransaction",
      args: [
        message.to,
        message.value,
        message.data,
        message.operation,
        message.safeTxGas,
        message.baseGas,
        message.gasPrice,
        message.gasToken,
        message.refundReceiver,
        signatures,
      ],
    });
    // The estimate runs the execution: a stale nonce, a bad signature or
    // an anchor call the anchor refuses reverts it, before anything is
    // sent. At the block the Safe's nonce was read at, since a node
    // estimating over its pending block would run it after our own stuck
    // transaction, which spends that nonce. Its error would quote the
    // calldata, signatures included.
    let gas: bigint;
    try {
      gas = await client.estimateGas({
        account: executor.address,
        to: address,
        data,
        blockNumber: block.number,
      });
    } catch {
      throw new Error("the node's estimate of the Safe's transaction failed");
    }
    // The latest nonce, not the pending one: a transaction stuck under a
    // fee rise is replaced at today's fees, or at its own bumped if they
    // are higher, never queued behind. Read after the estimate, so a stuck
    // transaction mined in between leaves this one at a spent Safe nonce:
    // it reverts on chain, costing its gas, and the next run reads both
    // afresh.
    const [estimate, nextNonce] = await Promise.all([
      client.estimateMaxPriorityFeePerGas(),
      client.getTransactionCount({ address: executor.address, blockTag: "latest" }),
    ]);
    if (block.baseFeePerGas === null) throw new Error("the L1 has no base fee");
    let tip = estimate;
    let maxFee = block.baseFeePerGas * BASE_FEE_HEADROOM + estimate;
    if (last?.nonce === nextNonce) {
      tip = replacing(last.maxPriorityFeePerGas, tip);
      maxFee = replacing(last.maxFeePerGas, maxFee);
      if (maxFee < tip) maxFee = tip;
    }
    const tx = await executor.signTransaction({
      type: "eip1559",
      chainId: Number(chainId),
      nonce: nextNonce,
      to: address,
      data,
      gas: (gas * GAS_HEADROOM) / 100n,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: tip,
    });
    // Kept before sending: a send that fails may still have reached the pool.
    last = { nonce: nextNonce, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
    let sent: Hex;
    try {
      sent = await client.sendRawTransaction({ serializedTransaction: tx });
    } catch {
      throw new Error("the node refused the Safe's transaction");
    }
    const receipt = await receiptOf(client, sent, timeout, pollMs);
    if (receipt.status !== "success") throw new Error("the Safe's transaction reverted");
    const executed = parseEventLogs({
      abi: safeAbi,
      eventName: "ExecutionSuccess",
      logs: receipt.logs.filter((l) => getAddress(l.address) === address),
      strict: true,
    });
    if (executed.length !== 1 || executed[0]!.args.txHash !== hash)
      throw new Error("the Safe didn't execute the transaction signed");
  };
}

/**
 * `threshold` signatures of `hash` by distinct owners, ordered by owner
 * address as the Safe requires. A signature that doesn't recover to its
 * signer's address, or a signer that fails, is skipped, so a signer
 * elsewhere (part 2b-2b-2) can withhold a signature but never make the Safe
 * count someone else; too few left is the error.
 */
async function signaturesOf(
  signers: readonly SafeSigner[],
  hash: Hex,
  threshold: bigint,
): Promise<Hex> {
  const signed = new Map<Address, Hex>();
  for (const signer of signers) {
    if (BigInt(signed.size) === threshold) break;
    if (signed.has(signer.address)) continue;
    let signature: Hex;
    try {
      signature = await signer.sign(hash);
      if (!/^0x[0-9a-fA-F]{128}(1b|1c)$/.test(signature)) continue;
      if (getAddress(await recoverAddress({ hash, signature })) !== signer.address) continue;
    } catch {
      continue;
    }
    signed.set(signer.address, signature);
  }
  if (BigInt(signed.size) < threshold) throw new Error("too few owners signed");
  const ordered = [...signed].sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return `0x${ordered.map(([, s]) => s.slice(2)).join("")}`;
}

// Polled directly: viem's waitForTransactionReceipt looks again only when
// the block number changes, and can miss a change that lands during a look.
async function receiptOf(client: PublicClient, hash: Hex, timeout: number, pollMs: number) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (e) {
      if (!(e instanceof BaseError && e.walk((c) => c instanceof TransactionReceiptNotFoundError)))
        throw new Error("the node's receipt couldn't be read");
    }
    if (Date.now() > end) throw new Error("the Safe's transaction wasn't included in time");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
