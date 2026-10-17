// The node's command line. `serve`: mirror every block in a directory of CAR
// files over HTTP. Output is one JSON object per line.

import { once } from "node:events";
import { parseArgs } from "node:util";
import { gateway } from "./gateway.ts";
import { openMirror } from "./store.ts";

export interface CliIo {
  readonly out: (value: unknown) => void;
  readonly err: (value: unknown) => void;
  /** Stops `serve`; the process wires it to SIGINT and SIGTERM. */
  readonly signal: AbortSignal;
}

export const USAGE =
  "usage: abolish-node serve --blocks <directory> [--port <n>] [--host <address>]";

/** Exit codes: 0 stopped, 2 bad usage, a directory that can't be read or an address it can't listen on. */
export async function cli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "serve") return await serve(rest, io);
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err({ error: (e as Error).message });
      return 2;
    }
    throw e;
  }
  io.err({ error: USAGE });
  return 2;
}

async function serve(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      blocks: { type: "string" },
      port: { type: "string", default: "8080" },
      // Loopback unless the operator chooses to publish the mirror.
      host: { type: "string", default: "127.0.0.1" },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (values.blocks === undefined || !/^\d{1,5}$/.test(values.port) || port > 65_535) {
    io.err({ error: USAGE });
    return 2;
  }
  let mirror;
  try {
    mirror = await openMirror(values.blocks);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === undefined) throw e;
    io.err({ error: `blocks: ${code}` });
    return 2;
  }
  for (const file of mirror.files) io.out(file);
  const server = gateway(mirror);
  server.listen(port, values.host);
  try {
    await once(server, "listening");
  } catch (e) {
    io.err({ error: `listen: ${(e as NodeJS.ErrnoException).code ?? "failed"}` });
    return 2;
  }
  const address = server.address();
  io.out({ listening: typeof address === "object" && address !== null ? address : values.host });
  if (!io.signal.aborted) await once(io.signal, "abort");
  server.close();
  server.closeAllConnections();
  await once(server, "close");
  return 0;
}
