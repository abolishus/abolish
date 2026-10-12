// The one Trusted Types policy the ballot client's CSP allows, ballot-worker,
// created when this module is evaluated. main.tsx imports it first, and an ES
// module's imports are evaluated in order before its body, so it runs before
// any other module of the client: React, @abolishus/ui and the client's own.
// It imports nothing but the worker's URL, a string Vite builds in. The CSP
// names the policy without 'allow-duplicates', so once it exists nothing else
// in the page can create it, and no later code gets a policy to mint script
// URLs of its own (T-43).
//
// `new Worker(url)` is a script-URL sink, so under `require-trusted-types-for
// 'script'` it needs a TrustedScriptURL. The policy turns exactly one string,
// the worker's own bundled URL, into one, and refuses every other.

import workerPath from "./worker/worker.ts?worker&url";

/** The worker script's absolute URL: the only string the policy accepts. */
export const WORKER_URL = new URL(workerPath, import.meta.url).href;

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

/** The policy's rule: the worker's own URL passes; anything else throws. */
export function allowWorkerUrl(input: string): string {
  if (input !== WORKER_URL) throw new TypeError("ballot-worker: not the ballot worker's URL");
  return input;
}

// A browser without Trusted Types gets no policy and spawns the worker from
// the plain URL, which `worker-src 'self'` still confines to the client's
// origin. If another script had created the policy first, this throws and
// the client stops here, never running beside it.
const trustedTypes = (globalThis as { trustedTypes?: TrustedTypes }).trustedTypes;
const policy = trustedTypes?.createPolicy("ballot-worker", { createScriptURL: allowWorkerUrl });

/** The worker's script URL, minted by the policy where the browser has Trusted Types. */
export function workerScriptUrl(): TrustedScriptURL | string {
  return policy === undefined ? WORKER_URL : policy.createScriptURL(WORKER_URL);
}
