import { createConfig } from "ponder";
import { readEnv } from "./src/env.ts";
import { INDEXED_ABIS } from "./src/events.ts";

const env = readEnv(process.env);

const contract = <const A>(abi: A, at: { address: `0x${string}`; startBlock: number }) => ({
  abi,
  chain: "l2" as const,
  address: at.address,
  startBlock: at.startBlock,
});

export default createConfig({
  // Postgres only (DATABASE_URL), never PGlite's local files: the index lives
  // where the other servers' state does, and is rebuilt from the chain (T-66).
  database: { kind: "postgres" },
  chains: {
    // Ponder treats a block as final once it is this many seconds older than
    // the head, by wall clock, not by the L2's safe or finalized head; older
    // rows are never rechecked. 600 s is Ponder's maximum.
    l2: { id: env.chainId, rpc: env.rpcUrl, reorgWindow: 600 },
  },
  contracts: {
    ElectionRegistry: contract(INDEXED_ABIS.ElectionRegistry, env.contracts.ElectionRegistry),
    TrusteeRegistry: contract(INDEXED_ABIS.TrusteeRegistry, env.contracts.TrusteeRegistry),
    GroupRegistry: contract(INDEXED_ABIS.GroupRegistry, env.contracts.GroupRegistry),
    Board: contract(INDEXED_ABIS.Board, env.contracts.Board),
  },
});
