import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh directory holding `files`. */
export async function blocksDir(files: Record<string, Uint8Array>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "abolish-node-"));
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
  return dir;
}

/** Listens on a loopback port and returns the server's base URL. */
export async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function close(server: Server): Promise<void> {
  server.close();
  server.closeAllConnections();
  await once(server, "close");
}
