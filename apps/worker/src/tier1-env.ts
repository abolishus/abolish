// The Tier 1 relay job's configuration from the environment (P3-3 part
// 3c-2b-2b): all of it or none of it, as the Tier 0 job's. Addresses and
// numbers are public; the relay account's key is a secret (T-69), so a
// malformed one is refused with a message naming the variable and never
// quoting its value. The URL may carry a provider's API key in its path or
// query, so a malformed one is named, never quoted, too.

import type { ContractEventVersion } from "@abolishus/crypto";
import { type Address, getAddress, isAddress } from "viem";
import * as z from "zod";

export interface Tier1Config {
  /** The L2 node the job reads and sends to. */
  readonly l2RpcUrl: string;
  readonly chainId: bigint;
  /** Region 0's published Tier 1 group, as the API's `API_TIER1_GROUP`. */
  readonly group: bigint;
  readonly registry: Address;
  /** The registry's deployment block. */
  readonly registryBlock: bigint;
  readonly registrars: readonly Address[];
  readonly threshold: number;
  /** The contract-event version the release pins for the registry's events. */
  readonly eventVersion: ContractEventVersion;
  /** The relay account's key, which pays for every addition it sends. */
  readonly relayKey: Uint8Array;
  /** The most wei per gas any relayed call is signed to pay. */
  readonly maxFeePerGas: bigint;
}

export const TIER1_ENV = [
  "TIER1_L2_RPC_URL",
  "TIER1_CHAIN_ID",
  "TIER1_GROUP",
  "TIER1_REGISTRY",
  "TIER1_REGISTRY_BLOCK",
  "TIER1_REGISTRARS",
  "TIER1_THRESHOLD",
  "TIER1_EVENT_VERSION",
  "TIER1_RELAY_KEY",
  "TIER1_MAX_FEE_PER_GAS",
] as const;

type Tier1Env = Partial<Record<(typeof TIER1_ENV)[number], string>>;

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
  TIER1_L2_RPC_URL: z.url({ protocol: /^https?$/ }),
  // viem signs with the chain ID as a JavaScript number.
  TIER1_CHAIN_ID: Uint(BigInt(Number.MAX_SAFE_INTEGER)).refine((v) => v > 0n),
  TIER1_GROUP: Uint(2n ** 64n - 1n),
  TIER1_REGISTRY: AddressValue,
  TIER1_REGISTRY_BLOCK: Uint(2n ** 64n - 1n),
  TIER1_REGISTRARS: z
    .string()
    .transform((v) => v.split(","))
    .pipe(z.array(AddressValue).min(1).max(255)),
  TIER1_THRESHOLD: Uint(255n)
    .refine((v) => v > 0n)
    .transform((v) => Number(v)),
  // `Tier1MemberAdded` is named from contract-event version 6.
  TIER1_EVENT_VERSION: z.enum(["6", "7", "8", "9", "10", "11", "12", "13"]),
  TIER1_MAX_FEE_PER_GAS: Uint(2n ** 128n - 1n).refine((v) => v > 0n),
});

/**
 * The job's configuration, or undefined if no `TIER1_` variable is set.
 * Throws if only some are, or if one is malformed; the key's value is never
 * quoted.
 */
export function tier1FromEnv(env: Tier1Env): Tier1Config | undefined {
  const set = TIER1_ENV.filter((name) => env[name] !== undefined && env[name] !== "");
  if (set.length === 0) return undefined;
  if (set.length !== TIER1_ENV.length)
    throw new Error(`the Tier 1 relay needs every one of ${TIER1_ENV.join(", ")}`);
  const parsed = Public.safeParse(
    Object.fromEntries(
      Object.keys(Public.shape).map((name) => [name, env[name as keyof Tier1Env]]),
    ),
  );
  if (!parsed.success)
    throw new Error(
      `malformed ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")}`,
    );
  const p = parsed.data;
  if (p.TIER1_THRESHOLD > p.TIER1_REGISTRARS.length)
    throw new Error("TIER1_THRESHOLD is above the number of registrars");
  const key = env.TIER1_RELAY_KEY as string;
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("TIER1_RELAY_KEY holds a malformed key");
  return {
    l2RpcUrl: p.TIER1_L2_RPC_URL,
    chainId: p.TIER1_CHAIN_ID,
    group: p.TIER1_GROUP,
    registry: p.TIER1_REGISTRY,
    registryBlock: p.TIER1_REGISTRY_BLOCK,
    registrars: p.TIER1_REGISTRARS,
    threshold: p.TIER1_THRESHOLD,
    eventVersion: Number(p.TIER1_EVENT_VERSION) as ContractEventVersion,
    relayKey: Uint8Array.from(Buffer.from(hex, "hex")),
    maxFeePerGas: p.TIER1_MAX_FEE_PER_GAS,
  };
}
