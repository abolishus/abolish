// The posting worker's configuration from the environment (P2-8 part
// 3c-1b-2b-2b-2d-2b-2b-2b-2b-2b-2): all of it or none of it, as the Tier 1
// relay's. Addresses and numbers are public; the posting key is a secret
// (T-69), so a malformed one is refused with a message naming the variable
// and never quoting its value. The URLs may carry a provider's API key or the
// store's password, so a malformed one is named, never quoted, too.

import { type Address, getAddress, isAddress } from "viem";
import * as z from "zod";

export interface PostingConfig {
  /**
   * The relay's own store, the API's `API_POSTING_REDIS_URL`: it must not
   * evict, persist, snapshot or back up anything (docs/spec/posting-relay.md,
   * Queue; T-18).
   */
  readonly redisUrl: string;
  /** The L2 node the worker reads, simulates against and sends to. */
  readonly l2RpcUrl: string;
  readonly chainId: bigint;
  /** The board our definitions name. */
  readonly board: Address;
  /** The board's deployment block. */
  readonly boardBlock: bigint;
  /** The posting key, which pays for every call it sends and does nothing else (ADR 0042, option A). */
  readonly key: Uint8Array;
  /** The fee cap: the most wei per L2 gas any relayed call is signed to pay. */
  readonly feeCap: bigint;
  /** The election budget: the most wei the relay spends on one election's postings. */
  readonly budget: bigint;
}

export const POSTING_ENV = [
  "POSTING_REDIS_URL",
  "POSTING_L2_RPC_URL",
  "POSTING_CHAIN_ID",
  "POSTING_BOARD",
  "POSTING_BOARD_BLOCK",
  "POSTING_KEY",
  "POSTING_FEE_CAP",
  "POSTING_ELECTION_BUDGET",
] as const;

type PostingEnv = Partial<Record<(typeof POSTING_ENV)[number], string>>;

const Uint = (max: bigint) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]{0,77})$/)
    .transform((v) => BigInt(v))
    .refine((v) => v <= max);

const Public = z.strictObject({
  POSTING_REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  POSTING_L2_RPC_URL: z.url({ protocol: /^https?$/ }),
  // viem signs with the chain ID as a JavaScript number.
  POSTING_CHAIN_ID: Uint(BigInt(Number.MAX_SAFE_INTEGER)).refine((v) => v > 0n),
  POSTING_BOARD: z
    .string()
    .refine((v) => isAddress(v, { strict: false }))
    .transform((v) => getAddress(v)),
  POSTING_BOARD_BLOCK: Uint(2n ** 64n - 1n),
  POSTING_FEE_CAP: Uint(2n ** 128n - 1n).refine((v) => v > 0n),
  POSTING_ELECTION_BUDGET: Uint(2n ** 128n - 1n),
});

/**
 * The worker's configuration, or undefined if no `POSTING_` variable is set.
 * Throws if only some are, or if one is malformed; the key's value is never
 * quoted.
 */
export function postingFromEnv(env: PostingEnv): PostingConfig | undefined {
  const set = POSTING_ENV.filter((name) => env[name] !== undefined && env[name] !== "");
  if (set.length === 0) return undefined;
  if (set.length !== POSTING_ENV.length)
    throw new Error(`the posting worker needs every one of ${POSTING_ENV.join(", ")}`);
  const parsed = Public.safeParse(
    Object.fromEntries(
      Object.keys(Public.shape).map((name) => [name, env[name as keyof PostingEnv]]),
    ),
  );
  if (!parsed.success)
    throw new Error(
      `malformed ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")}`,
    );
  const p = parsed.data;
  const key = env.POSTING_KEY as string;
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("POSTING_KEY holds a malformed key");
  return {
    redisUrl: p.POSTING_REDIS_URL,
    l2RpcUrl: p.POSTING_L2_RPC_URL,
    chainId: p.POSTING_CHAIN_ID,
    board: p.POSTING_BOARD,
    boardBlock: p.POSTING_BOARD_BLOCK,
    key: Uint8Array.from(Buffer.from(hex, "hex")),
    feeCap: p.POSTING_FEE_CAP,
    budget: p.POSTING_ELECTION_BUDGET,
  };
}
