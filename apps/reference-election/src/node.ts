// A community node (apps/node, P4-5) mirroring the board's blocks: `serve
// --blocks`, run in a process of its own from its source, the command anyone
// runs, so the verifier can fetch the board by CID with our servers offline
// (docs/spec/verifier.md, Board by CID, Gateways; T-24, T-49, T-51).

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const MAIN = new URL("../../node/src/main.ts", import.meta.url);

export interface Node {
  /** The node's gateway base, on loopback. */
  readonly url: string;
  stop(): Promise<void>;
}

/** Starts `abolish-node serve --blocks <dir>` on a free loopback port. */
export async function startNode(blocks: string): Promise<Node> {
  const child: ChildProcess = spawn(
    process.execPath,
    [MAIN.pathname, "serve", "--blocks", blocks, "--port", "0"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await once(child, "exit");
  };
  try {
    const lines = createInterface({ input: child.stdout as NonNullable<typeof child.stdout> });
    for await (const line of lines) {
      const out = JSON.parse(line) as {
        listening?: { address: string; port: number };
        unreadableBytes?: number;
      };
      if (out.listening !== undefined) {
        lines.close();
        return { url: `http://127.0.0.1:${out.listening.port}`, stop };
      }
      // Each CAR file it read: one it couldn't read whole stops the run.
      if ("error" in out || (out.unreadableBytes ?? 0) !== 0)
        throw new Error(`the node couldn't read its blocks: ${line}`);
    }
    throw new Error(`the node stopped before listening (exit ${child.exitCode})`);
  } catch (e) {
    await stop();
    throw e;
  }
}
