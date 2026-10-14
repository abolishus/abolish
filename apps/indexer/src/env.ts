// The indexer's deployment, read once from the environment and refused
// whole if any part is malformed, so a typo never indexes another chain or
// contract silently.

export interface IndexerEnv {
  /** The L2's chain ID. */
  readonly chainId: number;
  /** JSON-RPC endpoint of an L2 node. */
  readonly rpcUrl: string;
  /** The group registry's address, as `0x` and 40 lowercase hex digits. */
  readonly groupRegistry: `0x${string}`;
  /** The block the group registry was deployed in: nothing before it is read. */
  readonly startBlock: number;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function count(env: Record<string, string | undefined>, name: string, min: number): number {
  const value = required(env, name);
  // Decimal digits only: Number() would also take "0x10", "1e3" and " 7".
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be a decimal integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be at least ${min}`);
  return n;
}

export function readEnv(env: Record<string, string | undefined>): IndexerEnv {
  const rpcUrl = required(env, "INDEXER_RPC_URL");
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new Error("INDEXER_RPC_URL must be a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("INDEXER_RPC_URL must be http or https");
  const address = required(env, "GROUP_REGISTRY_ADDRESS");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new Error("GROUP_REGISTRY_ADDRESS must be 0x and 40 hex digits");
  return {
    chainId: count(env, "INDEXER_CHAIN_ID", 1),
    rpcUrl,
    groupRegistry: address.toLowerCase() as `0x${string}`,
    startBlock: count(env, "GROUP_REGISTRY_START_BLOCK", 0),
  };
}
