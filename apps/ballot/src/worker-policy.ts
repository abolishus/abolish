// The one Trusted Types policy the ballot client's CSP allows, ballot-worker,
// created when this module is evaluated. main.tsx imports it first, and an ES
// module's imports are evaluated in order before its body, so it runs before
// any other module of the client: React, @abolishus/ui and the client's own.
// It imports nothing but the two workers' URLs, strings Vite builds in. The CSP
// names the policy without 'allow-duplicates', so once it exists nothing else
// in the page can create it, and no later code gets a policy to mint script
// URLs of its own (T-43).
//
// `new Worker(url)` is a script-URL sink, so under `require-trusted-types-for
// 'script'` it needs a TrustedScriptURL. The policy turns exactly two strings,
// the ballot worker's and the prover worker's bundled URLs, into one, and
// refuses every other.

import proverPath from "./prover/prover.ts?worker&url";
import workerPath from "./worker/worker.ts?worker&url";

/** The ballot worker script's absolute URL: one of the two strings the policy accepts. */
export const WORKER_URL = new URL(workerPath, import.meta.url).href;
/** The prover worker script's absolute URL (ADR 0009, Amendment of 2026-10-17): the other. */
export const PROVER_URL = new URL(proverPath, import.meta.url).href;

// TypeScript's DOM library has no Trusted Types yet.
interface TrustedScriptURL {
  readonly __brand: "TrustedScriptURL";
}
interface WorkerPolicy {
  createScriptURL(input: string): TrustedScriptURL;
}
interface TrustedTypes {
  createPolicy(name: string, rules: { createScriptURL(input: string): string }): WorkerPolicy;
}

/** The policy's rule: the two workers' own URLs pass; anything else throws. */
export function allowWorkerUrl(input: string): string {
  if (input !== WORKER_URL && input !== PROVER_URL)
    throw new TypeError("ballot-worker: not the ballot or prover worker's URL");
  return input;
}

// A browser without Trusted Types gets no policy and spawns each worker from
// its plain URL, which `worker-src 'self'` still confines to the client's
// origin. If another script had created the policy first, this throws and
// the client stops here, never running beside it.
const trustedTypes = (globalThis as { trustedTypes?: TrustedTypes }).trustedTypes;
const policy = trustedTypes?.createPolicy("ballot-worker", { createScriptURL: allowWorkerUrl });

const mint = (url: string): TrustedScriptURL | string =>
  policy === undefined ? url : policy.createScriptURL(url);

/** The ballot worker's script URL, minted by the policy where the browser has Trusted Types. */
export function workerScriptUrl(): TrustedScriptURL | string {
  return mint(WORKER_URL);
}

/** The prover worker's script URL, minted the same way. */
export function proverScriptUrl(): TrustedScriptURL | string {
  return mint(PROVER_URL);
}
