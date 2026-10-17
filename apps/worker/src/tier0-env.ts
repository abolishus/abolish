// The Tier 0 batch job's configuration from the environment (P3-2 part
// 4d-2b-2b): all of it or none of it, as the API's registration route takes
// its own. Addresses and numbers are public; the registrars' keys and the
// account's owner key are secrets (T-69), so a malformed key is refused with
// a message naming the variable and never quoting its value.

import { type Address, getAddress, isAddress } from "viem";
import * as z from "zod";

export interface Tier0Config {
  /** The L2 node the job reads, and the bundler it submits through. */
  readonly l2RpcUrl: string;
  readonly bundlerUrl: string;
  readonly chainId: bigint;
  /** Region 0's published group, as the API's `API_TIER0_GROUP`. */
  readonly group: bigint;
  readonly registry: Address;
  /** The registry's deployment block. */
  readonly registryBlock: bigint;
  readonly registrars: readonly Address[];
  readonly threshold: number;
  /** The registrar keys the service holds, by 1-based seat, in ascending seat order. */
  readonly signers: readonly { readonly seat: number; readonly secretKey: Uint8Array }[];
  readonly entryPoint: Address;
  readonly account: Address;
  readonly accountKey: Uint8Array;
  readonly paymaster: Address;
}

export const TIER0_ENV = [
  "TIER0_L2_RPC_URL",
  "TIER0_BUNDLER_URL",
  "TIER0_CHAIN_ID",
  "TIER0_GROUP",
  "TIER0_REGISTRY",
  "TIER0_REGISTRY_BLOCK",
  "TIER0_REGISTRARS",
  "TIER0_THRESHOLD",
  "TIER0_SIGNER_KEYS",
  "TIER0_ENTRY_POINT",
  "TIER0_ACCOUNT",
  "TIER0_ACCOUNT_KEY",
  "TIER0_PAYMASTER",
] as const;

type Tier0Env = Partial<Record<(typeof TIER0_ENV)[number], string>>;

const Url = z.url({ protocol: /^https?$/ });
const Uint = (max: bigint) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]{0,77})$/)
    .transform((v) => BigInt(v))
    .refine((v) => v <= max);
const AddressValue = z
  .string()
  .refine((v) => isAddress(v, { strict: false }))
  .transform((v) => getAddress(v));

const Public = z.strictObject({
  TIER0_L2_RPC_URL: Url,
  TIER0_BUNDLER_URL: Url,
  TIER0_CHAIN_ID: Uint(2n ** 64n - 1n).refine((v) => v > 0n),
  TIER0_GROUP: Uint(2n ** 64n - 1n),
  TIER0_REGISTRY: AddressValue,
  TIER0_REGISTRY_BLOCK: Uint(2n ** 64n - 1n),
  TIER0_REGISTRARS: z
    .string()
    .transform((v) => v.split(","))
    .pipe(z.array(AddressValue).min(1).max(255)),
  TIER0_THRESHOLD: z.coerce.number().int().min(1).max(255),
  TIER0_ENTRY_POINT: AddressValue,
  TIER0_ACCOUNT: AddressValue,
  TIER0_PAYMASTER: AddressValue,
});

/** A 32-byte key as 64 hex digits, `0x` optional; anything else is refused without quoting it. */
function secretKey(name: string, value: string): Uint8Array {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} holds a malformed key`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/**
 * The job's configuration, or undefined if no `TIER0_` variable is set.
 * Throws if only some are, or if one is malformed; a key's value is never
 * quoted.
 */
export function tier0FromEnv(env: Tier0Env): Tier0Config | undefined {
  const set = TIER0_ENV.filter((name) => env[name] !== undefined && env[name] !== "");
  if (set.length === 0) return undefined;
  if (set.length !== TIER0_ENV.length)
    throw new Error(`the Tier 0 job needs every one of ${TIER0_ENV.join(", ")}`);
  const parsed = Public.safeParse(
    Object.fromEntries(
      Object.keys(Public.shape).map((name) => [name, env[name as keyof Tier0Env]]),
    ),
  );
  if (!parsed.success)
    throw new Error(
      `malformed ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")}`,
    );
  const p = parsed.data;
  if (p.TIER0_THRESHOLD > p.TIER0_REGISTRARS.length)
    throw new Error("TIER0_THRESHOLD is above the number of registrars");
  // `seat:key` pairs, comma-separated: `threshold` of them, seats ascending
  // and within the registrars, as core's Tier0Batches requires.
  const signers = (env.TIER0_SIGNER_KEYS as string).split(",").map((pair) => {
    const at = pair.indexOf(":");
    const seat = at === -1 ? Number.NaN : Number(pair.slice(0, at));
    if (!Number.isInteger(seat) || seat < 1 || seat > p.TIER0_REGISTRARS.length)
      throw new Error("TIER0_SIGNER_KEYS names a seat outside the registrars");
    return { seat, secretKey: secretKey("TIER0_SIGNER_KEYS", pair.slice(at + 1)) };
  });
  if (signers.length !== p.TIER0_THRESHOLD)
    throw new Error("TIER0_SIGNER_KEYS must hold exactly TIER0_THRESHOLD keys");
  if (signers.some((s, i) => i > 0 && s.seat <= (signers[i - 1] as { seat: number }).seat))
    throw new Error("TIER0_SIGNER_KEYS must list seats in ascending order");
  return {
    l2RpcUrl: p.TIER0_L2_RPC_URL,
    bundlerUrl: p.TIER0_BUNDLER_URL,
    chainId: p.TIER0_CHAIN_ID,
    group: p.TIER0_GROUP,
    registry: p.TIER0_REGISTRY,
    registryBlock: p.TIER0_REGISTRY_BLOCK,
    registrars: p.TIER0_REGISTRARS,
    threshold: p.TIER0_THRESHOLD,
    signers,
    entryPoint: p.TIER0_ENTRY_POINT,
    account: p.TIER0_ACCOUNT,
    accountKey: secretKey("TIER0_ACCOUNT_KEY", env.TIER0_ACCOUNT_KEY as string),
    paymaster: p.TIER0_PAYMASTER,
  };
}
