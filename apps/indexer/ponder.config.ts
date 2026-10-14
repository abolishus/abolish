import { groupRegistryAbi } from "@abolishus/contracts/abi";
import { createConfig } from "ponder";
import { readEnv } from "./src/env.ts";

const env = readEnv(process.env);

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
    GroupRegistry: {
      abi: groupRegistryAbi,
      chain: "l2",
      address: env.groupRegistry,
      startBlock: env.startBlock,
    },
  },
});
