// The fixture's Arweave node as a process of its own (`arweave.ts`): it
// listens on a free loopback port, prints `{"port": n}` once it does, and
// stops on SIGTERM.

import type { AddressInfo } from "node:net";
import { arweaveServer } from "./arweave.ts";

const server = arweaveServer();
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ port: (server.address() as AddressInfo).port })}\n`);
});
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
