// Test only: drives the real ballot worker from a page under the client's own
// CSP, for tests/worker.e2e.ts, and opens an election the way the page does
// (src/open.tsx), against a deployment that names a registry. The production
// page has no such hook.

// First, as in main.tsx.
import "../../src/worker-policy.ts";

import { STAGING } from "../../src/deployment.ts";
import { loadElection } from "../../src/load.ts";
import { loadProverArtifacts } from "../../src/prover-artifacts.ts";
import { proveMembership } from "../../src/prover-client.ts";
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
  /** Fetches an election from staging's origins with `registry` pinned, then checks it in the worker. */
  async open(electionId: string, registry: string): Promise<string> {
    const deployment = { ...STAGING, electionRegistry: registry };
    const loaded = await loadElection(deployment, fromHex(electionId), (url, init) =>
      fetch(url, init),
    );
    if (!loaded.ok) return JSON.stringify(loaded);
    const result = await worker.checkElection(
      fromHex(electionId),
      loaded.registeredHash,
      loaded.definition,
      loaded.displayText,
    );
    return JSON.stringify(result, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  },
  /**
   * Loads the artifacts from the client's own origin (through its cache) and
   * proves membership through a prover worker, with every step it reported.
   */
  async prove(
    secret: string,
    leaves: readonly string[],
    definitionHash: string,
    tier: number,
    root: string,
    message: string,
  ): Promise<string> {
    const progress: [number, number][] = [];
    let result: unknown;
    try {
      const artifacts = await loadProverArtifacts({
        base: import.meta.url,
        fetch: (url, init) => fetch(url, init),
        caches: globalThis.caches,
      });
      result = await proveMembership(
        worker,
        {
          secret: fromHex(secret),
          leaves: leaves.map(BigInt),
          definitionHash: fromHex(definitionHash),
          tier,
          root: BigInt(root),
          message: fromHex(message),
        },
        artifacts,
        (done, of) => progress.push([done, of]),
      );
    } catch (e) {
      result = {
        thrown: e instanceof Error ? e.name : "?",
        problem: (e as { problem?: string }).problem,
      };
    }
    return JSON.stringify({ result, progress }, (_, v: unknown) =>
      v instanceof Uint8Array ? Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("") : v,
    );
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
