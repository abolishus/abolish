import { groupRegistryAbi } from "@abolishus/contracts/abi";
import { createConfig } from "ponder";
import { readEnv } from "./src/env.ts";

const env = readEnv(process.env);

export default createConfig({
  // Postgres only (DATABASE_URL), never PGlite's local files: the index lives
  // where the other servers' state does, and is rebuilt from the chain (T-66).
  database: { kind: "postgres" },
  chains: {
    l2: { id: env.chainId, rpc: env.rpcUrl },
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
