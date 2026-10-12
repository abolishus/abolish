// A local Anvil node for the fixture's L1, and a minimal JSON-RPC client.
// Anvil runs on loopback only, and the fixture never holds a private key: it
// sends from Anvil's unlocked development account and from impersonated
// addresses (AGENTS.md, Testnets only).

import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";

export interface Rpc {
  readonly call: <T>(method: string, params?: readonly unknown[]) => Promise<T>;
}

export interface Anvil extends Rpc {
  readonly url: string;
  stop(): Promise<void>;
}

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

export function rpcClient(url: string): Rpc {
  let id = 0;
  return {
    call: async <T>(method: string, params: readonly unknown[] = []): Promise<T> => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const body = (await response.json()) as {
        result?: T;
        error?: { code: number; message: string };
      };
      if (body.error !== undefined)
        throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
      return body.result as T;
    },
  };
}

/** Starts Anvil with the given L1 chain ID and waits until it answers. */
export async function startAnvil(chainId: bigint): Promise<Anvil> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", chainId.toString(), "--silent"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const spawnError = new Promise<never>((_, reject) => child.once("error", reject));
  const url = `http://127.0.0.1:${port}`;
  const rpc = rpcClient(url);
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await Promise.race([rpc.call("eth_chainId"), spawnError]);
      return { url, call: rpc.call, stop };
    } catch (e) {
      if (attempt >= 100 || child.exitCode !== null) {
        await stop();
        throw new Error("anvil didn't start (is the toolchain installed? AGENTS.md)", {
          cause: e,
        });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
