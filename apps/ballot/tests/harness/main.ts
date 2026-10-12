// Test only: drives the real ballot worker from a page under the client's own
// CSP, for tests/worker.e2e.ts. The production page has no such hook; part 2b
// wires the worker to the election screens.

import { BallotWorker, claimWorkerPolicy } from "../../src/worker-client.ts";

claimWorkerPolicy();
const worker = new BallotWorker();

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

const harness = {
  /** The worker's verdict, with its bigints as strings so the test can read it. */
  async check(electionId: string, definition: string, displayText: string): Promise<string> {
    const result = await worker.checkElection(
      fromHex(electionId),
      fromHex(definition),
      fromHex(displayText),
    );
    return JSON.stringify(result, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  },
};

(globalThis as unknown as { ballotHarness: typeof harness }).ballotHarness = harness;
document.getElementById("root")?.setAttribute("data-ready", "true");
