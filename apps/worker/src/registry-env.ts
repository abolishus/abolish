// The registry sync's configuration from the environment (P3-5 parts 3a and
// 3b): all of it or none of it, as the Tier 0 job's. Addresses, the chains
// and the schema are public; the index's database URL carries
// a password and either node's URL may carry a provider's API key, so a
// malformed one is named, never quoted.

import type { ContractEventVersion } from "@abolishus/crypto";
import { type Address, getAddress, isAddress } from "viem";
import * as z from "zod";

export interface RegistrySyncConfig {
  /** The indexer's database and the schema it runs under (its `DATABASE_SCHEMA`). */
  readonly indexUrl: string;
  readonly indexSchema: string;
  /** The L2 node, whose answers are proven under output roots. */
  readonly l2RpcUrl: string;
  readonly chainId: bigint;
  /** The L1 node whose finalized head the sync trusts, and the L1's chain. */
  readonly l1RpcUrl: string;
  readonly l1ChainId: bigint;
  /** The L2's OptimismPortal on L1, which names the dispute game factory and the respected game type. */
  readonly portal: Address;
  readonly electionRegistry: Address;
  readonly trusteeRegistry: Address;
  readonly groupRegistry: Address;
  readonly board: Address;
  /** The contract-event version the deployment's profiles pin (verifier 2.3). */
  readonly eventVersion: ContractEventVersion;
}

export const REGISTRY_SYNC_ENV = [
  "REGISTRY_SYNC_INDEX_URL",
  "REGISTRY_SYNC_INDEX_SCHEMA",
  "REGISTRY_SYNC_L2_RPC_URL",
  "REGISTRY_SYNC_CHAIN_ID",
  "REGISTRY_SYNC_L1_RPC_URL",
  "REGISTRY_SYNC_L1_CHAIN_ID",
  "REGISTRY_SYNC_PORTAL",
  "REGISTRY_SYNC_ELECTION_REGISTRY",
  "REGISTRY_SYNC_TRUSTEE_REGISTRY",
  "REGISTRY_SYNC_GROUP_REGISTRY",
  "REGISTRY_SYNC_BOARD",
  "REGISTRY_SYNC_EVENT_VERSION",
] as const;

type RegistrySyncEnv = Partial<Record<(typeof REGISTRY_SYNC_ENV)[number], string>>;

const AddressValue = z
  .string()
  .refine((v) => isAddress(v, { strict: false }))
  .transform((v) => getAddress(v));

const Env = z.strictObject({
  REGISTRY_SYNC_INDEX_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  // As Ponder names schemas, and so it can be quoted as an identifier.
  REGISTRY_SYNC_INDEX_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  REGISTRY_SYNC_L2_RPC_URL: z.url({ protocol: /^https?$/ }),
  // The accumulator binds the chain ID as a u64.
  REGISTRY_SYNC_CHAIN_ID: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .transform((v) => BigInt(v))
    .refine((v) => v < 1n << 64n),
  REGISTRY_SYNC_L1_RPC_URL: z.url({ protocol: /^https?$/ }),
  REGISTRY_SYNC_L1_CHAIN_ID: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .transform((v) => BigInt(v))
    .refine((v) => v < 1n << 64n),
  REGISTRY_SYNC_PORTAL: AddressValue,
  REGISTRY_SYNC_ELECTION_REGISTRY: AddressValue,
  REGISTRY_SYNC_TRUSTEE_REGISTRY: AddressValue,
  REGISTRY_SYNC_GROUP_REGISTRY: AddressValue,
  REGISTRY_SYNC_BOARD: AddressValue,
  REGISTRY_SYNC_EVENT_VERSION: z.enum(["1", "2", "3", "4", "5", "6"]),
});

/**
 * The sync's configuration, or undefined if no `REGISTRY_SYNC_` variable is
 * set. Throws if only some are, or if one is malformed, naming the variable.
 */
export function registrySyncFromEnv(env: RegistrySyncEnv): RegistrySyncConfig | undefined {
  const set = REGISTRY_SYNC_ENV.filter((name) => env[name] !== undefined && env[name] !== "");
  if (set.length === 0) return undefined;
  if (set.length !== REGISTRY_SYNC_ENV.length)
    throw new Error(`the registry sync needs every one of ${REGISTRY_SYNC_ENV.join(", ")}`);
  const parsed = Env.safeParse(Object.fromEntries(REGISTRY_SYNC_ENV.map((n) => [n, env[n]])));
  if (!parsed.success)
    throw new Error(
      `malformed ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")}`,
    );
  const p = parsed.data;
  const contracts = [
    p.REGISTRY_SYNC_ELECTION_REGISTRY,
    p.REGISTRY_SYNC_TRUSTEE_REGISTRY,
    p.REGISTRY_SYNC_GROUP_REGISTRY,
    p.REGISTRY_SYNC_BOARD,
  ];
  // The event check finds a log's role by its address.
  if (new Set(contracts).size !== contracts.length)
    throw new Error("the registry sync's four contract addresses must be distinct");
  return {
    indexUrl: p.REGISTRY_SYNC_INDEX_URL,
    indexSchema: p.REGISTRY_SYNC_INDEX_SCHEMA,
    l2RpcUrl: p.REGISTRY_SYNC_L2_RPC_URL,
    chainId: p.REGISTRY_SYNC_CHAIN_ID,
    l1RpcUrl: p.REGISTRY_SYNC_L1_RPC_URL,
    l1ChainId: p.REGISTRY_SYNC_L1_CHAIN_ID,
    portal: p.REGISTRY_SYNC_PORTAL,
    electionRegistry: p.REGISTRY_SYNC_ELECTION_REGISTRY,
    trusteeRegistry: p.REGISTRY_SYNC_TRUSTEE_REGISTRY,
    groupRegistry: p.REGISTRY_SYNC_GROUP_REGISTRY,
    board: p.REGISTRY_SYNC_BOARD,
    eventVersion: Number(p.REGISTRY_SYNC_EVENT_VERSION) as ContractEventVersion,
  };
}
