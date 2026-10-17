// The indexer's deployment, read once from the environment and refused
// whole if any part is malformed, so a typo never indexes another chain or
// contract silently.

/** The L2 contracts the indexer reads, by the names `ponder.config.ts` gives them. */
export const CONTRACT_NAMES = [
  "ElectionRegistry",
  "TrusteeRegistry",
  "GroupRegistry",
  "Board",
] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

/** Each contract's environment prefix: `<PREFIX>_ADDRESS` and `<PREFIX>_START_BLOCK`. */
const PREFIX: Readonly<Record<ContractName, string>> = {
  ElectionRegistry: "ELECTION_REGISTRY",
  TrusteeRegistry: "TRUSTEE_REGISTRY",
  GroupRegistry: "GROUP_REGISTRY",
  Board: "BOARD",
};

export interface IndexedContract {
  /** The contract's address, as `0x` and 40 lowercase hex digits. */
  readonly address: `0x${string}`;
  /** The block the contract was deployed in: nothing before it is read. */
  readonly startBlock: number;
}

export interface IndexerEnv {
  /** The L2's chain ID. */
  readonly chainId: number;
  /** JSON-RPC endpoint of an L2 node. */
  readonly rpcUrl: string;
  /** The deployment's four L2 contracts ([[contracts]]). */
  readonly contracts: Readonly<Record<ContractName, IndexedContract>>;
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

function contract(env: Record<string, string | undefined>, prefix: string): IndexedContract {
  const address = required(env, `${prefix}_ADDRESS`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new Error(`${prefix}_ADDRESS must be 0x and 40 hex digits`);
  return {
    address: address.toLowerCase() as `0x${string}`,
    startBlock: count(env, `${prefix}_START_BLOCK`, 0),
  };
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
  const contracts = Object.fromEntries(
    CONTRACT_NAMES.map((name) => [name, contract(env, PREFIX[name])]),
  ) as Record<ContractName, IndexedContract>;
  // A definition's `chain` rule keeps the four distinct, and a log's role is
  // its address's: one address under two names would index its logs twice.
  const addresses = new Set(CONTRACT_NAMES.map((name) => contracts[name].address));
  if (addresses.size !== CONTRACT_NAMES.length)
    throw new Error("the four contract addresses must be distinct");
  return { chainId: count(env, "INDEXER_CHAIN_ID", 1), rpcUrl, contracts };
}
