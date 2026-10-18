// The anchoring runner's configuration from the environment (P4-1 part
// 2b-2b-1): all of it or none of it, as the Tier 0 job's. The anchor's
// address and clock and the Safe's record are the deployment record's, all
// public (docs/spec/contracts.md, Board anchor, Deployment); the owner keys
// and the executor key are secrets (T-69), so a malformed one is refused
// with a message naming the variable and never quoting its value. The URL
// may carry a provider's API key in its path or query, so a malformed one is
// named, never quoted, too.

import type { AnchoringClock } from "@abolishus/core";
import { type Address, getAddress, type Hex, isAddress } from "viem";
import * as z from "zod";
import type { AnchorSafe } from "./anchor-safe.ts";

export interface AnchorConfig {
  /** The L1 node the runner reads, checks the Safe on and sends to. */
  readonly l1RpcUrl: string;
  readonly chainId: bigint;
  /** The board anchor our definitions name as `l1_anchor`. */
  readonly anchor: Address;
  /** The clock the anchor fixes, as the release pins it. */
  readonly clock: AnchoringClock;
  /** The anchoring authority, as the deployment record names it. */
  readonly safe: AnchorSafe;
  /** The owner keys this runner holds, distinct. */
  readonly ownerKeys: readonly Uint8Array[];
  /** The key that pays for and sends the Safe's transactions. */
  readonly executorKey: Uint8Array;
  /** How often the run is scheduled. */
  readonly everyMs: number;
}

export const ANCHOR_ENV = [
  "ANCHOR_L1_RPC_URL",
  "ANCHOR_CHAIN_ID",
  "ANCHOR_ADDRESS",
  "ANCHOR_EPOCH",
  "ANCHOR_PERIOD",
  "ANCHOR_DEADLINE",
  "ANCHOR_SAFE",
  "ANCHOR_SAFE_BLOCK",
  "ANCHOR_SAFE_PROXY_CODE_HASH",
  "ANCHOR_SAFE_SINGLETON",
  "ANCHOR_SAFE_SINGLETON_CODE_HASH",
  "ANCHOR_SAFE_OWNERS",
  "ANCHOR_SAFE_THRESHOLD",
  "ANCHOR_SAFE_FALLBACK_HANDLER",
  "ANCHOR_OWNER_KEYS",
  "ANCHOR_EXECUTOR_KEY",
] as const;

/** Optional: how often the run is scheduled, in milliseconds. */
export const ANCHOR_EVERY_ENV = "ANCHOR_EVERY_MS";

/**
 * Every five minutes by default: twelve tries an hour, so a period's
 * checkpoint is sent minutes after it ends and a failed call is retried
 * well over a hundred times before its 12-hour deadline (T-49).
 */
export const ANCHOR_EVERY_MS = 5 * 60_000;

type AnchorEnv = Partial<Record<(typeof ANCHOR_ENV)[number] | typeof ANCHOR_EVERY_ENV, string>>;

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
const CodeHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase() as Hex);

const Public = z.strictObject({
  ANCHOR_L1_RPC_URL: z.url({ protocol: /^https?$/ }),
  // viem signs with the chain ID as a JavaScript number.
  ANCHOR_CHAIN_ID: Uint(BigInt(Number.MAX_SAFE_INTEGER)).refine((v) => v > 0n),
  ANCHOR_ADDRESS: AddressValue,
  // The anchor's immutables are `uint64`s (docs/spec/contracts.md, Board
  // anchor, Deployment).
  ANCHOR_EPOCH: Uint(2n ** 64n - 1n),
  ANCHOR_PERIOD: Uint(2n ** 64n - 1n).refine((v) => v > 0n),
  ANCHOR_DEADLINE: Uint(2n ** 64n - 1n),
  ANCHOR_SAFE: AddressValue,
  ANCHOR_SAFE_BLOCK: Uint(2n ** 64n - 1n),
  ANCHOR_SAFE_PROXY_CODE_HASH: CodeHash,
  ANCHOR_SAFE_SINGLETON: AddressValue,
  ANCHOR_SAFE_SINGLETON_CODE_HASH: CodeHash,
  ANCHOR_SAFE_OWNERS: z
    .string()
    .transform((v) => v.split(","))
    .pipe(z.array(AddressValue).min(2).max(255)),
  ANCHOR_SAFE_THRESHOLD: Uint(255n),
  ANCHOR_SAFE_FALLBACK_HANDLER: AddressValue,
  // At least a minute, so a run's L1 reads finish before the next.
  ANCHOR_EVERY_MS: z
    .string()
    .regex(/^[1-9][0-9]{0,9}$/)
    .transform(Number)
    .refine((v) => v >= 60_000)
    .optional(),
});

const key = (value: string): Uint8Array | undefined => {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Uint8Array.from(Buffer.from(hex, "hex")) : undefined;
};

/**
 * The runner's configuration, or undefined if no `ANCHOR_` variable is set.
 * Throws if only some are, if one is malformed, if the Safe's record isn't
 * one `checkAnchorSafeState` could pass (owners repeated, a threshold below
 * 2 or above the owners), if the owner keys repeat one, or if the schedule
 * is longer than the anchor's period or deadline; no key's value is ever
 * quoted.
 */
export function anchorFromEnv(env: AnchorEnv): AnchorConfig | undefined {
  const set = ANCHOR_ENV.filter((name) => env[name] !== undefined && env[name] !== "");
  if (set.length === 0) {
    if (env[ANCHOR_EVERY_ENV] !== undefined && env[ANCHOR_EVERY_ENV] !== "")
      throw new Error(`${ANCHOR_EVERY_ENV} needs the anchoring runner configured`);
    return undefined;
  }
  if (set.length !== ANCHOR_ENV.length)
    throw new Error(`the anchoring runner needs every one of ${ANCHOR_ENV.join(", ")}`);
  const parsed = Public.safeParse(
    Object.fromEntries(
      Object.keys(Public.shape).map((name) => [name, env[name as keyof AnchorEnv] || undefined]),
    ),
  );
  if (!parsed.success)
    throw new Error(
      `malformed ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")}`,
    );
  const p = parsed.data;
  if (new Set(p.ANCHOR_SAFE_OWNERS).size !== p.ANCHOR_SAFE_OWNERS.length)
    throw new Error("ANCHOR_SAFE_OWNERS repeats an owner");
  // T-69: a threshold of 1 is a single key, as the anchor's own constructor
  // refuses one.
  if (p.ANCHOR_SAFE_THRESHOLD < 2n) throw new Error("ANCHOR_SAFE_THRESHOLD is below 2");
  if (p.ANCHOR_SAFE_THRESHOLD > BigInt(p.ANCHOR_SAFE_OWNERS.length))
    throw new Error("ANCHOR_SAFE_THRESHOLD is above the number of owners");
  const everyMs = p.ANCHOR_EVERY_MS ?? ANCHOR_EVERY_MS;
  // T-49: within the period, so each checkpoint is sent soon after its
  // period ends; within the deadline, so no checkpoint's window opens and
  // closes between two runs.
  if (BigInt(everyMs) > p.ANCHOR_PERIOD * 1000n)
    throw new Error(`${ANCHOR_EVERY_ENV} is longer than the anchor's period`);
  if (BigInt(everyMs) > p.ANCHOR_DEADLINE * 1000n)
    throw new Error(`${ANCHOR_EVERY_ENV} is longer than the anchor's deadline`);
  const ownerKeys = (env.ANCHOR_OWNER_KEYS as string).split(",").map(key);
  if (ownerKeys.some((k) => k === undefined))
    throw new Error("ANCHOR_OWNER_KEYS holds a malformed key");
  const hexKeys = ownerKeys.map((k) => Buffer.from(k as Uint8Array).toString("hex"));
  if (new Set(hexKeys).size !== hexKeys.length) throw new Error("ANCHOR_OWNER_KEYS repeats a key");
  const executorKey = key(env.ANCHOR_EXECUTOR_KEY as string);
  if (executorKey === undefined) throw new Error("ANCHOR_EXECUTOR_KEY holds a malformed key");
  return {
    l1RpcUrl: p.ANCHOR_L1_RPC_URL,
    chainId: p.ANCHOR_CHAIN_ID,
    anchor: p.ANCHOR_ADDRESS,
    clock: { epoch: p.ANCHOR_EPOCH, period: p.ANCHOR_PERIOD, deadline: p.ANCHOR_DEADLINE },
    safe: {
      address: p.ANCHOR_SAFE,
      deploymentBlock: p.ANCHOR_SAFE_BLOCK,
      proxyCodeHash: p.ANCHOR_SAFE_PROXY_CODE_HASH,
      singleton: p.ANCHOR_SAFE_SINGLETON,
      singletonCodeHash: p.ANCHOR_SAFE_SINGLETON_CODE_HASH,
      owners: p.ANCHOR_SAFE_OWNERS,
      threshold: p.ANCHOR_SAFE_THRESHOLD,
      fallbackHandler: p.ANCHOR_SAFE_FALLBACK_HANDLER,
    },
    ownerKeys: ownerKeys as Uint8Array[],
    executorKey,
    everyMs,
  };
}
