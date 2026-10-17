// A community node (apps/node, P4-5) mirroring the board's blocks: `serve
// --blocks`, run in a process of its own from its source, the command anyone
// runs, so the verifier can fetch the board by CID with our servers offline
// (docs/spec/verifier.md, Board by CID, Gateways; T-24, T-49, T-51).

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../../node/src/main.ts", import.meta.url));
/** How long the node may take to read its blocks and listen. */
const STARTUP_MS = 30_000;

export interface Node {
  /** The node's gateway base, on loopback. */
  readonly url: string;
  stop(): Promise<void>;
}

/** Starts `abolish-node serve --blocks <dir>` on a free loopback port. */
export async function startNode(blocks: string): Promise<Node> {
  const child = spawn(process.execPath, [MAIN, "serve", "--blocks", blocks, "--port", "0"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  };
  const listening = async (): Promise<string> => {
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      const out = JSON.parse(line) as {
        listening?: { address: string; port: number };
        unreadableBytes?: number;
      };
      if (out.listening !== undefined) {
        lines.close();
        return `http://127.0.0.1:${out.listening.port}`;
      }
      // Each CAR file it read: one it couldn't read whole stops the run.
      if ("error" in out || (out.unreadableBytes ?? 0) !== 0)
        throw new Error(`the node couldn't read its blocks: ${line}`);
    }
    const [code, signal] = (await exited) as [number | null, string | null];
    throw new Error(`the node stopped before listening (exit ${code ?? signal})`);
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const url = await Promise.race([
      listening(),
      // A spawn that fails (no such file, out of descriptors) is an `error` event.
      once(child, "error").then(([e]) => {
        throw e;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the node didn't listen within ${STARTUP_MS} ms`)),
          STARTUP_MS,
        );
      }),
    ]);
    return { url, stop };
  } catch (e) {
    await stop();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** What `abolish-node verify` printed, line by line, and how it exited. */
export interface NodeVerify {
  readonly code: number | null;
  readonly lines: readonly Record<string, unknown>[];
}

/**
 * Runs `abolish-node verify` to its end, in a process of its own: every
 * election the anchor's checkpoints name, verified from the blocks in
 * `blocks` and from the two chains, with no input from the fixture.
 */
export async function nodeVerify(args: {
  readonly blocks: string;
  readonly reports: string;
  readonly l1: string;
  readonly anchor: string;
  readonly l2: string;
  readonly registry: string;
}): Promise<NodeVerify> {
  const child = spawn(
    process.execPath,
    [MAIN, "verify", ...Object.entries(args).flatMap(([name, value]) => [`--${name}`, value])],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = Promise.race([
    once(child, "exit"),
    // A spawn that fails emits `error` and never `exit`.
    once(child, "error").then(([e]) => {
      throw e;
    }),
  ]);
  exited.catch(() => {});
  const lines: Record<string, unknown>[] = [];
  for await (const line of createInterface({ input: child.stdout }))
    lines.push(JSON.parse(line) as Record<string, unknown>);
  const [code] = (await exited) as [number | null];
  return { code, lines };
}
