// Test only: drives the real ballot worker from a page under the client's own
// CSP, for tests/worker.e2e.ts. The production page has no such hook; part 2b
// wires the worker to the election screens.

// First, as in main.tsx.
import "../../src/worker-policy.ts";

import { BallotWorker } from "../../src/worker-client.ts";

const worker = new BallotWorker();

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

const harness = {
  /** The worker's verdict, with its bigints as strings so the test can read it. */
  async check(
    electionId: string,
    registeredHash: string,
    definition: string,
    displayText: string,
  ): Promise<string> {
    const result = await worker.checkElection(
      fromHex(electionId),
      fromHex(registeredHash),
      fromHex(definition),
      fromHex(displayText),
    );
    return JSON.stringify(result, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  },
  /** Stops the worker, then reports how a request fares: at once, or at its timeout. */
  async stopThenCheck(): Promise<string> {
    worker.terminate();
    const started = performance.now();
    try {
      await worker.checkElection(
        new Uint8Array(32),
        new Uint8Array(32),
        new Uint8Array(),
        new Uint8Array(),
      );
      return "answered";
    } catch (e) {
      return `${e instanceof Error ? e.name : "?"} after ${Math.round(performance.now() - started)} ms`;
    }
  },
};

(globalThis as unknown as { ballotHarness: typeof harness }).ballotHarness = harness;
document.getElementById("root")?.setAttribute("data-ready", "true");
