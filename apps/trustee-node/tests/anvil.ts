// An Anvil node standing in for either chain, mining on every transaction
// or only when told, so a transaction can wait outside any block. Nothing
// here holds a key: tests sign with keys they make up.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { type Rpc, rpcClient } from "@abolishus/node";

/** A loopback port nothing listens on now. */
export async function freePort(): Promise<number> {
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

export interface Node {
  readonly rpc: Rpc;
  readonly url: URL;
  readonly process: ChildProcess;
}

/** An Anvil node on chain `id`; `extra` are more of Anvil's options (a genesis time, a finality depth). */
export async function anvil(
  id: bigint,
  automine: boolean,
  extra: readonly string[] = [],
): Promise<Node> {
  const port = await freePort();
  const args = ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(id), ...extra];
  if (!automine) args.push("--no-mining");
  const child = spawn("anvil", [...args, "--silent"], { stdio: ["ignore", "ignore", "inherit"] });
  const url = new URL(`http://127.0.0.1:${port}`);
  const rpc = rpcClient(url);
  const end = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    try {
      await rpc.call("eth_chainId", []);
      return { rpc, url, process: child };
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
