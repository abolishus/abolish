// An L1 for the node's tests: Anvil running the board anchor, checkpoints
// anchored through it from an impersonated authority (standing in for the
// Safe; no key is held here, AGENTS.md).

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { type Checkpoint, encodeCheckpoint } from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { type Rpc, rpcClient } from "../src/rpc.ts";

export const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
export const word = (n: bigint) => {
  const w = new Uint8Array(32);
  for (let i = 31, x = n; x > 0n; i--, x >>= 8n) w[i] = Number(x & 0xffn);
  return w;
};
export const padded = (b: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32);
  out.set(b);
  return out;
};

const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));
export const PERIOD = 3600n;
export const DEADLINE = 43_200n;
// One slot per epoch: Anvil's finalized block is then the latest but two.
const FINALITY_DEPTH = 2;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

export interface Anchor {
  readonly address: Uint8Array;
  readonly authority: string;
  readonly epoch: bigint;
}

export interface Chain {
  readonly rpc: Rpc;
  readonly url: URL;
  /** A board anchor whose periods 0 to 2 have ended at the latest block. */
  deployAnchor(): Promise<Anchor>;
  /** Anchors `checkpoints` in one call, then mines until it is finalized. */
  anchorAll(anchor: Anchor, checkpoints: readonly Checkpoint[]): Promise<void>;
  mine(blocks: number): Promise<unknown>;
  stop(): Promise<void>;
}

/** Calldata for `anchor(bytes checkpoints, bytes locator)` with no locator, in the one encoding the contract accepts. */
function anchorCalldata(checkpoints: readonly Checkpoint[]): Uint8Array {
  const encoded = concatBytes(...checkpoints.map(encodeCheckpoint));
  const selector = keccak_256(new TextEncoder().encode("anchor(bytes,bytes)")).slice(0, 4);
  const first = concatBytes(word(BigInt(encoded.length)), padded(encoded));
  return concatBytes(selector, word(64n), word(64n + BigInt(first.length)), first, word(0n));
}

/** Starts Anvil on a free loopback port and waits until it answers. */
export async function startChain(): Promise<Chain> {
  const port = await freePort();
  const url = new URL(`http://127.0.0.1:${port}`);
  const anvil: ChildProcess = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--slots-in-an-epoch", "1", "--silent"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const rpc = rpcClient(url);
  let deployer: string;
  const end = Date.now() + 20_000;
  for (;;) {
    if (anvil.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    try {
      deployer = ((await rpc.call("eth_accounts", [])) as string[])[0] as string;
      break;
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const bytecode = execFileSync(
    "forge",
    ["inspect", "--root", contractsRoot, "src/BoardAnchor.sol:BoardAnchor", "bytecode"],
    { encoding: "utf8" },
  ).trim();
  let nextAuthority = 0xa0c4000n;

  const send = async (tx: Record<string, string>): Promise<string | null> => {
    const hash = await rpc.call("eth_sendTransaction", [tx]);
    for (let attempt = 0; attempt < 50; attempt++) {
      const receipt = (await rpc.call("eth_getTransactionReceipt", [hash]).catch(() => null)) as {
        status: string;
        contractAddress: string | null;
      } | null;
      if (receipt !== null) {
        if (receipt.status !== "0x1") throw new Error("reverted");
        return receipt.contractAddress;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("not mined");
  };
  const mine = (blocks: number) => rpc.call("anvil_mine", [`0x${blocks.toString(16)}`]);

  return {
    rpc,
    url,
    mine,
    async deployAnchor() {
      const latest = (await rpc.call("eth_getBlockByNumber", ["latest", false])) as {
        timestamp: string;
      };
      const epoch = BigInt(latest.timestamp) - 3n * PERIOD - 60n;
      const authority = `0x${(nextAuthority += 1n).toString(16).padStart(40, "0")}`;
      await rpc.call("anvil_setCode", [authority, "0x00"]);
      await rpc.call("anvil_setBalance", [authority, "0x56bc75e2d63100000"]);
      await rpc.call("anvil_impersonateAccount", [authority]);
      const address = await send({
        from: deployer,
        data: hex(
          concatBytes(
            hexToBytes(bytecode.slice(2)),
            word(epoch),
            word(PERIOD),
            word(DEADLINE),
            word(BigInt(authority)),
          ),
        ),
      });
      if (address === null) throw new Error("BoardAnchor wasn't deployed");
      return { address: hexToBytes(address.slice(2)), authority, epoch };
    },
    async anchorAll(anchor, checkpoints) {
      await send({
        from: anchor.authority,
        to: hex(anchor.address),
        data: hex(anchorCalldata(checkpoints)),
      });
      await mine(FINALITY_DEPTH);
    },
    async stop() {
      if (anvil.exitCode !== null) return;
      const exited = new Promise((r) => anvil.once("exit", r));
      anvil.kill("SIGTERM");
      await exited;
    },
  };
}
