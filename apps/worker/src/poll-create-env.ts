// The creation step's configuration from the environment
// ([[0032-poll-creation-operations]], rules 1, 2 and 18; P2-22 parts 3a and
// 3b-1; the poll-creation runbook): all of it or none of it, the daily
// ceiling aside. The L1 node and the anchor are part of it, since nothing
// created may go on unchecked, and so is the default panel the registration
// step registers ceremonies of (part 5b), the same as the stub step's.
// The creation key is a secret (T-65, T-72), so a malformed one is refused
// with a message naming the variable and never quoting its value; so is the
// URL, which can carry a provider's API key.

import { type Address, getAddress, isAddress } from "viem";
import * as z from "zod";
import { P256_KEYS, PANEL_THRESHOLD } from "./poll-stub-env.ts";

export interface PollCreationConfig {
  /** The L2 node the step signs against, sends to and reads. */
  readonly l2RpcUrl: string;
  readonly chainId: bigint;
  /** The election registry our definitions name. */
  readonly registry: Address;
  /** The L1 node the per-slot check proves the anchor's words from (P2-22 part 3b-1). */
  readonly l1RpcUrl: string;
  readonly l1ChainId: bigint;
  /** The board anchor our definitions name. */
  readonly anchor: Address;
  /** The creation key's 32 bytes. */
  readonly key: Uint8Array;
  /**
   * The default panel whose approved ceremonies are registered: its
   * threshold and the seats' `p256-key`s, seat 1 first, as the stub step's
   * `POLL_STUB_PANEL_*` name it.
   */
  readonly panel: { readonly threshold: number; readonly keys: readonly Uint8Array[] };
  /** Creations sent in any 24 hours (rule 18). */
  readonly dailyCeiling: number;
}

export const POLL_CREATE_ENV = [
  "CREATE_L2_RPC_URL",
  "CREATE_CHAIN_ID",
  "CREATE_REGISTRY",
  "CREATE_KEY",
  "CREATE_L1_RPC_URL",
  "CREATE_L1_CHAIN_ID",
  "CREATE_ANCHOR",
  "CREATE_PANEL_THRESHOLD",
  "CREATE_PANEL_KEYS",
] as const;

/** Optional beside the others: core's `CREATE_DAILY_CEILING` when unset. */
export const POLL_CREATE_CEILING_ENV = "CREATE_DAILY_CEILING";

type PollCreateEnv = Partial<
  Record<(typeof POLL_CREATE_ENV)[number] | typeof POLL_CREATE_CEILING_ENV, string>
>;

// viem signs with the chain ID as a JavaScript number.
const chainId = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .transform((v) => BigInt(v))
  .refine((v) => v <= BigInt(Number.MAX_SAFE_INTEGER));
const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }))
  .transform((v) => getAddress(v));

const Public = z.strictObject({
  CREATE_L2_RPC_URL: z.url({ protocol: /^https?$/ }),
  CREATE_CHAIN_ID: chainId,
  CREATE_REGISTRY: address,
  CREATE_L1_RPC_URL: z.url({ protocol: /^https?$/ }),
  CREATE_L1_CHAIN_ID: chainId,
  CREATE_ANCHOR: address,
  CREATE_PANEL_THRESHOLD: PANEL_THRESHOLD,
  CREATE_PANEL_KEYS: P256_KEYS,
  CREATE_DAILY_CEILING: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,5})$/)
    .transform((v) => Number(v))
    .optional(),
});

/**
 * The step's configuration, or undefined if none of `POLL_CREATE_ENV` is
 * set. Throws if only some are, if one is malformed, or if the ceiling is
 * set without them; the key's value is never quoted.
 */
export function pollCreationFromEnv(
  env: PollCreateEnv,
  defaultCeiling: number,
): PollCreationConfig | undefined {
  const has = (name: keyof PollCreateEnv) => env[name] !== undefined && env[name] !== "";
  const set = POLL_CREATE_ENV.filter(has);
  if (set.length === 0) {
    if (has(POLL_CREATE_CEILING_ENV))
      throw new Error(`${POLL_CREATE_CEILING_ENV} needs the creation step configured`);
    return undefined;
  }
  if (set.length !== POLL_CREATE_ENV.length)
    throw new Error(`the creation step needs every one of ${POLL_CREATE_ENV.join(", ")}`);
  const parsed = Public.safeParse({
    CREATE_L2_RPC_URL: env.CREATE_L2_RPC_URL,
    CREATE_CHAIN_ID: env.CREATE_CHAIN_ID,
    CREATE_REGISTRY: env.CREATE_REGISTRY,
    CREATE_L1_RPC_URL: env.CREATE_L1_RPC_URL,
    CREATE_L1_CHAIN_ID: env.CREATE_L1_CHAIN_ID,
    CREATE_ANCHOR: env.CREATE_ANCHOR,
    CREATE_PANEL_THRESHOLD: env.CREATE_PANEL_THRESHOLD,
    CREATE_PANEL_KEYS: env.CREATE_PANEL_KEYS,
    CREATE_DAILY_CEILING: has(POLL_CREATE_CEILING_ENV) ? env.CREATE_DAILY_CEILING : undefined,
  });
  if (!parsed.success)
    throw new Error(
      `malformed ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")}`,
    );
  const key = (env.CREATE_KEY as string).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("CREATE_KEY holds a malformed key");
  const p = parsed.data;
  return {
    l2RpcUrl: p.CREATE_L2_RPC_URL,
    chainId: p.CREATE_CHAIN_ID,
    registry: p.CREATE_REGISTRY,
    l1RpcUrl: p.CREATE_L1_RPC_URL,
    l1ChainId: p.CREATE_L1_CHAIN_ID,
    anchor: p.CREATE_ANCHOR,
    key: Uint8Array.from(Buffer.from(key, "hex")),
    panel: { threshold: p.CREATE_PANEL_THRESHOLD, keys: p.CREATE_PANEL_KEYS },
    dailyCeiling: p.CREATE_DAILY_CEILING ?? defaultCeiling,
  };
}
