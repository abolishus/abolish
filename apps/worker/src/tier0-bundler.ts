// The Tier 0 batch job's submitter (P3-2 part 4d-2b-2b): each signed addition
// record goes to the group registry as an ERC-4337 operation from the
// registration account, paid by the registration paymaster, through a
// bundler (docs/spec/contracts.md, Registration paymaster and Registration
// account; docs/spec/registration.md, The batch, step 6).
//
// The operation is built here to pass exactly the paymaster's rules: the
// account as sender, no initCode, `paymasterAndData` of the paymaster and its
// two gas limits only, `execute(registry, 0, addMembers(record))` in the
// standard ABI encoding, and a most-it-can-cost within the paymaster's cap
// (T-52). The account's owner key signs EntryPoint v0.8's hash of it, computed
// here, and the bundler must answer with that same hash. Nothing here logs,
// and every failure throws a fixed message: a bundler's or node's error can
// quote the operation, and with it the record not yet on chain (T-10, T-13).

import { decodeGroupAddition } from "@abolishus/crypto";
import {
  groupRegistryAbi,
  registrationAccountAbi,
  registrationPaymasterAbi,
} from "@abolishus/contracts/abi";
import {
  type Address,
  encodeFunctionData,
  getAddress,
  type Hex,
  isHex,
  type PublicClient,
  toHex,
} from "viem";
import { privateKeyToAddress, sign } from "viem/accounts";
import {
  entryPoint08Abi,
  formatUserOperationRequest,
  getUserOperationHash,
  type UserOperation,
} from "viem/account-abstraction";
import * as z from "zod";

/** A bundler's JSON-RPC (ERC-7769): `eth_chainId`, `eth_supportedEntryPoints`, `eth_estimateUserOperationGas` and `eth_sendUserOperation`. */
export type BundlerRequest = (args: { method: string; params?: unknown }) => Promise<unknown>;

export interface Tier0BundlerOptions {
  /** The L2 node the batch job reads: the account's nonce and the fees come from it. */
  readonly client: PublicClient;
  readonly bundler: BundlerRequest;
  readonly chainId: bigint;
  /** EntryPoint v0.8, as the deployment record names it. */
  readonly entryPoint: Address;
  /** The registration account, the paymaster's `service`. */
  readonly account: Address;
  /** The account's owner key; checked against `owner()` before anything is sent. */
  readonly ownerKey: Uint8Array;
  readonly paymaster: Address;
  readonly registry: Address;
}

/**
 * The paymaster's validation gas when the bundler's estimate names none: its
 * checks read only calldata and immutables, well within this, and an unused
 * limit costs nothing but the cap's headroom.
 */
export const TIER0_PAYMASTER_VERIFICATION_GAS = 60_000n;

/**
 * A 65-byte signature the account's checks parse (low `s`, `v` 27) but that
 * recovers to no owner, for gas estimation: the account answers
 * `SIG_VALIDATION_FAILED` rather than revert, as ERC-4337 asks, so the
 * estimate runs the same validation as the signed operation.
 */
const DUMMY_SIGNATURE: Hex = `0x${"ff".repeat(15)}f0${"00".repeat(16)}7a${"aa".repeat(31)}1c`;

const MAX_UINT128 = 2n ** 128n - 1n;

const Quantity = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/)
  .transform((v) => BigInt(v));

/** ERC-7769's estimate for an EntryPoint v0.7 or later operation. */
const Estimate = z.strictObject({
  preVerificationGas: Quantity,
  verificationGasLimit: Quantity,
  callGasLimit: Quantity,
  paymasterVerificationGasLimit: Quantity.optional(),
  paymasterPostOpGasLimit: Quantity.optional(),
});

export class Tier0BundlerError extends Error {}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

function fail(message: string): never {
  throw new Tier0BundlerError(message);
}

/**
 * Checks the deployment the submitter sends through, then returns the
 * submitter for `ViemTier0Chain`. Before anything is sent: the node and the
 * bundler are on the configured chain and the bundler serves the
 * EntryPoint; the account has code, runs on that EntryPoint and is owned by
 * the configured key; and the paymaster is that EntryPoint's, sponsors that
 * account's calls to that registry, and its cap is read (T-62, T-69). Throws
 * naming the mismatch, never a key.
 */
export async function connectTier0Bundler(
  options: Tier0BundlerOptions,
): Promise<(record: Uint8Array) => Promise<void>> {
  const { client, bundler, chainId } = options;
  const entryPoint = getAddress(options.entryPoint);
  const account = getAddress(options.account);
  const paymaster = getAddress(options.paymaster);
  const registry = getAddress(options.registry);
  const ownerKey: Hex = `0x${Buffer.from(options.ownerKey).toString("hex")}`;
  let owner: Address | undefined;
  try {
    owner = privateKeyToAddress(ownerKey);
  } catch {
    // viem's message for an out-of-range key quotes the key.
  }
  if (owner === undefined) return fail("the account key isn't a secp256k1 key");
  // viem hashes an operation with the chain ID as a JavaScript number.
  if (chainId < 1n || chainId > BigInt(Number.MAX_SAFE_INTEGER))
    fail("the chain ID is out of range");

  if (BigInt(await client.getChainId()) !== chainId) fail("the L2 node is on another chain");
  const [bundlerChain, served] = await Promise.all([
    bundler({ method: "eth_chainId" }),
    bundler({ method: "eth_supportedEntryPoints" }),
  ]);
  if (
    typeof bundlerChain !== "string" ||
    !/^0x[0-9a-fA-F]{1,16}$/.test(bundlerChain) ||
    BigInt(bundlerChain) !== chainId
  )
    fail("the bundler is on another chain");
  if (
    !Array.isArray(served) ||
    !served.some(
      (e) => typeof e === "string" && isHex(e) && e.length === 42 && getAddress(e) === entryPoint,
    )
  )
    fail("the bundler doesn't serve the EntryPoint");

  const code = await client.getCode({ address: account });
  if (code === undefined || code === "0x") fail("the account has no code");
  const [accountEntryPoint, accountOwner, payEntryPoint, payRegistry, payService, cap] =
    await Promise.all([
      client.readContract({
        address: account,
        abi: registrationAccountAbi,
        functionName: "entryPoint",
      }),
      client.readContract({ address: account, abi: registrationAccountAbi, functionName: "owner" }),
      client.readContract({
        address: paymaster,
        abi: registrationPaymasterAbi,
        functionName: "entryPoint",
      }),
      client.readContract({
        address: paymaster,
        abi: registrationPaymasterAbi,
        functionName: "registry",
      }),
      client.readContract({
        address: paymaster,
        abi: registrationPaymasterAbi,
        functionName: "service",
      }),
      client.readContract({
        address: paymaster,
        abi: registrationPaymasterAbi,
        functionName: "maxCost",
      }),
    ]);
  const is = (a: Address, b: Address) => getAddress(a) === b;
  if (!is(accountEntryPoint, entryPoint)) fail("the account runs on another EntryPoint");
  if (!is(accountOwner, owner)) fail("the account key isn't the account's owner");
  if (!is(payEntryPoint, entryPoint)) fail("the paymaster is another EntryPoint's");
  if (!is(payRegistry, registry)) fail("the paymaster sponsors another registry");
  if (!is(payService, account)) fail("the paymaster sponsors another account");

  return async (record) => {
    try {
      await submit(record);
    } catch (e) {
      throw e instanceof Tier0BundlerError ? e : new Tier0BundlerError("the batch wasn't taken");
    }
  };

  async function submit(record: Uint8Array): Promise<void> {
    const callData = encodeFunctionData({
      abi: registrationAccountAbi,
      functionName: "execute",
      args: [
        registry,
        0n,
        encodeFunctionData({
          abi: groupRegistryAbi,
          functionName: "addMembers",
          args: [toHex(record)],
        }),
      ],
    });
    // Each group's batches take the sequence of the nonce key named by the
    // group's ID, read at the latest block: one group's operation still
    // pending never shares a nonce with another group's, and a resubmission
    // while the group's last one is still pending takes its nonce, so at
    // most one of the two lands. One that landed after core's reads leaves
    // the resubmission the next nonce: it lands too, reverting at the
    // registry for at most the cap (docs/spec/contracts.md, Registration
    // paymaster, Known-weak).
    const decoded = decodeGroupAddition(record);
    if (!decoded.ok) return fail("the record doesn't decode");
    const [nonce, fees] = await Promise.all([
      client.readContract({
        address: entryPoint,
        abi: entryPoint08Abi,
        functionName: "getNonce",
        args: [account, decoded.value.groupId],
        blockTag: "latest",
      }),
      client.estimateFeesPerGas(),
    ]);
    const draft: UserOperation<"0.8"> = {
      sender: account,
      nonce,
      callData,
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      paymaster,
      paymasterVerificationGasLimit: TIER0_PAYMASTER_VERIFICATION_GAS,
      paymasterPostOpGasLimit: 0n,
      paymasterData: "0x",
      signature: DUMMY_SIGNATURE,
    };
    const estimateAt = async (fee: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) => {
      const estimate = Estimate.safeParse(
        await bundler({
          method: "eth_estimateUserOperationGas",
          params: [formatUserOperationRequest({ ...draft, ...fee }), entryPoint],
        }),
      );
      if (!estimate.success) return fail("the bundler's estimate is malformed");
      const gas = {
        callGasLimit: estimate.data.callGasLimit,
        verificationGasLimit: estimate.data.verificationGasLimit,
        preVerificationGas: estimate.data.preVerificationGas,
        paymasterVerificationGasLimit:
          estimate.data.paymasterVerificationGasLimit ?? TIER0_PAYMASTER_VERIFICATION_GAS,
        // The paymaster returns no context, so the EntryPoint never calls
        // `postOp`: nothing is reserved for it, whatever the estimate says.
        paymasterPostOpGasLimit: 0n,
      };
      for (const v of Object.values(gas))
        if (v > MAX_UINT128) fail("the bundler's estimate is malformed");
      const units =
        gas.callGasLimit +
        gas.verificationGasLimit +
        gas.preVerificationGas +
        gas.paymasterVerificationGasLimit +
        gas.paymasterPostOpGasLimit;
      if (units === 0n) fail("the bundler's estimate is malformed");
      return { gas, units };
    };
    // EntryPoint v0.8 charges the deposit at most every limit times
    // `maxFeePerGas`, and the paymaster refuses an operation above its cap
    // (rule `Cost`), so a fee that doesn't fit is lowered. An L2 bundler's
    // `preVerificationGas` carries the L1 data fee divided by the
    // operation's fee, so it grows as the fee falls: taking all of it as
    // that fee (`preVerificationGas · fee` wei, whatever the fee), the
    // lowered fee is `(cap − preVerificationGas · fee) / (the other limits)`,
    // estimated again, and must fit; otherwise nothing is sent and the
    // record waits for the next boundary (T-52).
    let { gas, units } = await estimateAt(fees);
    let maxFeePerGas = fees.maxFeePerGas;
    if (units * maxFeePerGas > cap) {
      const dataFee = gas.preVerificationGas * maxFeePerGas;
      const rest = units - gas.preVerificationGas;
      maxFeePerGas = dataFee >= cap || rest === 0n ? 0n : (cap - dataFee) / rest;
      if (maxFeePerGas === 0n) fail("the paymaster's cap can't pay for the batch's gas");
      ({ gas, units } = await estimateAt({
        maxFeePerGas,
        maxPriorityFeePerGas: min(fees.maxPriorityFeePerGas, maxFeePerGas),
      }));
      if (units * maxFeePerGas > cap) fail("the paymaster's cap can't pay for the batch's gas");
    }
    const maxPriorityFeePerGas = min(fees.maxPriorityFeePerGas, maxFeePerGas);
    const op: UserOperation<"0.8"> = { ...draft, ...gas, maxFeePerGas, maxPriorityFeePerGas };
    const hash = getUserOperationHash({
      chainId: Number(chainId),
      entryPointAddress: entryPoint,
      entryPointVersion: "0.8",
      userOperation: op,
    });
    // viem's signatures are low-s with `v` 27 or 28, as the account requires.
    const signed = { ...op, signature: await sign({ hash, privateKey: ownerKey, to: "hex" }) };
    const taken = await bundler({
      method: "eth_sendUserOperation",
      params: [formatUserOperationRequest(signed), entryPoint],
    });
    // Only a bundler that answers this operation's hash may have taken it;
    // the answer proves nothing more, and core sends the record again until
    // it is on chain.
    if (typeof taken !== "string" || taken.toLowerCase() !== hash.toLowerCase())
      fail("the bundler answered another operation");
  }
}
