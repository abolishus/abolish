// Test only: drives the real ballot worker from a page under the client's own
// CSP, for tests/worker.e2e.ts, and opens an election the way the page does
// (src/open.tsx), against a deployment that names a registry. The production
// page has no such hook.

// First, as in main.tsx.
import "../../src/worker-policy.ts";

import { STAGING } from "../../src/deployment.ts";
import { IDENTITY_DB, readIdentity, saveIdentity } from "../../src/identity.ts";
import { loadElection } from "../../src/load.ts";
import { loadProverArtifacts } from "../../src/prover-artifacts.ts";
import { castBallot } from "../../src/prover-client.ts";
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
      [],
      [],
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
      loaded.entries,
      deployment.panels,
    );
    return JSON.stringify(result, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  },
  /**
   * Checks a version-5 poll with its board's entries under `panel`, then
   * seals `votes` in cell 0 and challenges the seal twice, with every answer.
   */
  async sealAndChallenge(
    electionId: string,
    registeredHash: string,
    definition: string,
    displayText: string,
    entries: readonly string[],
    panel: { readonly threshold: number; readonly keys: readonly string[] },
    votes: readonly (0 | 1)[],
  ): Promise<string> {
    const check = await worker.checkElection(
      fromHex(electionId),
      fromHex(registeredHash),
      fromHex(definition),
      fromHex(displayText),
      entries.map(fromHex),
      [{ threshold: panel.threshold, keys: panel.keys.map(fromHex) }],
    );
    const sealed = await worker.seal(fromHex(registeredHash), 0, votes);
    const opened = sealed.ok ? await worker.challenge(sealed.seal) : undefined;
    const again = sealed.ok ? await worker.challenge(sealed.seal) : undefined;
    return JSON.stringify({ check: check.ok, sealed, opened, again }, (_, v: unknown) =>
      v instanceof Uint8Array ? Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("") : v,
    );
  },
  /**
   * Checks a version-5 poll as `sealAndChallenge` does, finds the voter's
   * cell from `find`'s board, seals `votes` there, casts the seal for `secret` under the L1 block given,
   * with the artifacts loaded from the client's own origin (through its
   * cache), then tries to challenge it, with every answer and every proving
   * step the prover reported.
   */
  async sealAndCast(
    electionId: string,
    registeredHash: string,
    definition: string,
    displayText: string,
    entries: readonly string[],
    panel: { readonly threshold: number; readonly keys: readonly string[] },
    votes: readonly (0 | 1)[],
    secret: string,
    find: {
      readonly tier: number;
      readonly group: string;
      readonly board: readonly string[];
      readonly registrars: readonly string[];
      readonly threshold: number;
    },
    l1: { readonly number: string; readonly hash: string },
  ): Promise<string> {
    const check = await worker.checkElection(
      fromHex(electionId),
      fromHex(registeredHash),
      fromHex(definition),
      fromHex(displayText),
      entries.map(fromHex),
      [{ threshold: panel.threshold, keys: panel.keys.map(fromHex) }],
    );
    const found = await worker.findCell({
      definitionHash: fromHex(registeredHash),
      secret: fromHex(secret),
      tier: find.tier,
      group: BigInt(find.group),
      entries: find.board.map(fromHex),
      registrars: find.registrars.map(fromHex),
      threshold: find.threshold,
    });
    if (!found.ok) return JSON.stringify({ check: check.ok, found });
    const sealed = await worker.seal(fromHex(registeredHash), found.cell, votes);
    if (!sealed.ok) return JSON.stringify({ check: check.ok, sealed });
    const artifacts = await loadProverArtifacts({
      base: import.meta.url,
      fetch: (url, init) => fetch(url, init),
      caches: globalThis.caches,
    });
    const progress: [number, number][] = [];
    const cast = await castBallot(
      worker,
      {
        seal: sealed.seal,
        secret: fromHex(secret),
        l1Number: BigInt(l1.number),
        l1Hash: fromHex(l1.hash),
      },
      artifacts,
      (done, of) => progress.push([done, of]),
    );
    const opened = await worker.challenge(sealed.seal);
    return JSON.stringify({ check: check.ok, sealed, cast, opened, progress }, (_, v: unknown) =>
      v instanceof Uint8Array ? Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("") : v,
    );
  },
  /** Stores an identity as this device's (identity.ts), with its groups as decimal strings. */
  async saveIdentity(
    secret: string,
    memberships: readonly { readonly tier: number; readonly group: string }[],
  ): Promise<void> {
    await saveIdentity({
      secret: fromHex(secret),
      memberships: memberships.map(({ tier, group }) => ({ tier, group: BigInt(group) })),
    });
  },
  /** The identity this device holds, read as the page reads it, with hex and decimal strings. */
  async readIdentity(): Promise<string> {
    return JSON.stringify(await readIdentity(), (_, v: unknown) =>
      v instanceof Uint8Array
        ? Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("")
        : typeof v === "bigint"
          ? v.toString()
          : v,
    );
  },
  /** Rewrites the stored record's version in place, as a store another client wrote would hold. */
  async restampIdentity(version: number): Promise<void> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(IDENTITY_DB, 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("identity", "readwrite");
      const store = transaction.objectStore("identity");
      const get = store.get("voter");
      get.onsuccess = () => store.put({ ...(get.result as object), v: version }, "voter");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
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
        [],
        [],
      );
      return "answered";
    } catch (e) {
      return `${e instanceof Error ? e.name : "?"} after ${Math.round(performance.now() - started)} ms`;
    }
  },
};

(globalThis as unknown as { ballotHarness: typeof harness }).ballotHarness = harness;
document.getElementById("root")?.setAttribute("data-ready", "true");
