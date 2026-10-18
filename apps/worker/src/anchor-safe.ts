// The anchoring authority's Safe (docs/spec/contracts.md, Board anchor;
// P4-1 part 2b-2a): the check that the authority is the Safe the deployment
// record names, configured so that only its owners' threshold can act as it,
// and the sender `ViemAnchorChain` takes, which signs the anchor call as a
// Safe transaction with the runner's owner keys and executes it.
//
// The anchor pins only the Safe's address, and a quorum can later make one
// key the authority without touching the anchor: by enabling a module (which
// executes as the Safe with no signatures), setting a guard or another
// fallback handler, or replacing the proxy's singleton through a
// delegatecall (Board anchor, Known-weak). So the runner checks the whole
// configuration at startup, at the L1 node's finalized block, and again
// before every signature, at the block it signs at, and signs for nothing
// else: a Safe changed since the deployment record is an alarm for a person,
// never a transaction to keep signing (T-49, T-69). The owners and the
// threshold are pinned too, so the quorum the record names is the one the
// runners sign for.
//
// A Safe transaction is signed with no `safeTxGas`, base gas or gas price,
// so a Safe whose anchor call reverts reverts as a whole (`GS013`) and
// nothing is mined as made (packages/contracts/test/BoardAnchorSafe.t.sol);
// the receipt must also carry the Safe's `ExecutionSuccess` for exactly the
// hash signed. Keys are used for nothing but signing, and nothing here logs
// or throws a key, a signature or a node's answer (T-10, T-65).

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
  TransactionReceiptNotFoundError,
  zeroAddress,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

/** The parts of Safe v1.4.1's interface the check and the sender use. */
export const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)",
]);

/** The modules list's sentinel (Safe's `ModuleManager`). */
const SENTINEL = "0x0000000000000000000000000000000000000001";
/** `keccak256("guard_manager.guard.address")` (Safe's `GuardManager`). */
export const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
/** `keccak256("fallback_manager.handler.address")` (Safe's `FallbackManager`). */
export const FALLBACK_HANDLER_SLOT =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
/** The proxy keeps its singleton in slot 0 (Safe's `SafeProxy`). */
const SINGLETON_SLOT = "0x0";

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
  /** `keccak256` of the proxy's runtime code. */
  readonly proxyCodeHash: Hex;
  /** The singleton the proxy must delegate to, and `keccak256` of its runtime code. */
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
 * The Safe at `blockNumber` is exactly `safe`: the proxy's and singleton's
 * code, the singleton it delegates to, its owners and threshold, no module,
 * no guard and the named fallback handler. Throws naming the first
 * mismatch; the configuration itself is refused if its threshold is below
 * 2 or above its owners.
 */
export async function checkAnchorSafe(
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

/** An owner key held by this runner. */
export function keySigner(key: Uint8Array): SafeSigner {
  if (key.length !== 32) throw new TypeError("an owner key is 32 bytes");
  const account = privateKeyToAccount(bytesToHex(key));
  return { address: account.address, sign: (hash) => account.sign({ hash }) };
}

/** How many of the latest base fee a transaction's fee cap allows, before its tip. */
const BASE_FEE_HEADROOM = 3n;
/** Headroom over the node's gas estimate, in percent. */
const GAS_HEADROOM = 120n;

export interface SafeSenderOptions {
  /** One L1 node. */
  readonly client: PublicClient;
  /** The node's chain, as `checkAnchorDeployment` checked it. */
  readonly chainId: bigint;
  /** The board anchor: the only contract this sender calls. */
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
 * `ViemAnchorChain`'s sender: `calldata` to the anchor as a transaction of
 * the Safe, checked, signed by the threshold's owners and executed. Resolves
 * once a successful receipt carries the Safe's `ExecutionSuccess` for it;
 * throws otherwise, without a transaction if the Safe has changed, too few
 * owners signed, or the node's simulation of the execution reverts.
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
  if (options.executor.length !== 32) throw new TypeError("the executor key is 32 bytes");
  const executor: PrivateKeyAccount = privateKeyToAccount(bytesToHex(options.executor));
  const timeout = options.receiptTimeoutMs ?? 600_000;
  const pollMs = options.pollMs ?? 2_000;

  return async (calldata) => {
    const block = await client.getBlock({ blockTag: "latest" });
    await checkAnchorSafe(client, safe, block.number);
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
    // an anchor call the anchor refuses reverts it, before anything is sent.
    const [gas, tip, pending] = await Promise.all([
      client.estimateGas({ account: executor.address, to: address, data }),
      client.estimateMaxPriorityFeePerGas(),
      client.getTransactionCount({ address: executor.address, blockTag: "pending" }),
    ]);
    if (block.baseFeePerGas === null) throw new Error("the L1 has no base fee");
    const tx = await executor.signTransaction({
      type: "eip1559",
      chainId: Number(chainId),
      nonce: pending,
      to: address,
      data,
      gas: (gas * GAS_HEADROOM) / 100n,
      maxFeePerGas: block.baseFeePerGas * BASE_FEE_HEADROOM + tip,
      maxPriorityFeePerGas: tip,
    });
    const sent = await client.sendRawTransaction({ serializedTransaction: tx });
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
 * signer's address is skipped, so a signer elsewhere (part 2b-2b) can fail a
 * call but never make the Safe count someone else.
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
        throw e;
    }
    if (Date.now() > end) throw new Error("the Safe's transaction wasn't included in time");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
