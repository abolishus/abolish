// The prover's proving key and witness calculator, fetched by the page from
// the client's own release (connect-src 'self'; the build emits both, pinned
// by sha256) and kept in the browser's Cache Storage, so a voter downloads
// the 5.8 MB key once. Neither is trusted from the cache or the network: the
// bytes are checked against the sha256s @abolishus/crypto pins on every load,
// before they are handed on, and the prover checks them again (T-07, T-12).
// A cached copy that fails the check is dropped and fetched again; one
// fetched that fails it is never cached.

import {
  checkMembershipWasm,
  checkMembershipZkey,
  MEMBERSHIP_WASM_SHA256,
  MEMBERSHIP_ZKEY_SHA256,
  MembershipProverError,
} from "@abolishus/crypto";

/**
 * The artifacts' file names in the release, beside the scripts: each names
 * its own pinned hash, so a release with another key never shares a cache
 * entry with this one. The build emits them under these names
 * (vite.config.ts).
 */
export const PROVER_ARTIFACT_NAMES = {
  zkey: `semaphore-32-${MEMBERSHIP_ZKEY_SHA256.slice(0, 16)}.zkey`,
  wasm: `semaphore-32-${MEMBERSHIP_WASM_SHA256.slice(0, 16)}.wasm`,
} as const;

/** The Cache Storage cache the artifacts live in. */
export const PROVER_CACHE = "abolish-prover-artifacts";

/** Most bytes either response may carry: both pinned files are smaller (5.8 MB and 1.9 MB). */
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

export type ProverArtifactKind = keyof typeof PROVER_ARTIFACT_NAMES;

export interface ProverArtifacts {
  readonly zkey: Uint8Array;
  readonly wasm: Uint8Array;
}

/**
 * Why the artifacts couldn't be loaded: `unavailable` (the release didn't
 * serve them), or `zkey` or `wasm` (it served other bytes than the pinned
 * ones). Each is a reason the client shows.
 */
export class ProverArtifactError extends Error {
  override readonly name = "ProverArtifactError";
  constructor(readonly problem: "unavailable" | ProverArtifactKind) {
    super(problem);
  }
}

export interface ProverArtifactSources {
  /** The page's script URL, which the artifacts sit beside. */
  readonly base: string;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The page's Cache Storage, or `undefined` where the browser offers none. */
  readonly caches: CacheStorage | undefined;
}

const CHECKS: Record<ProverArtifactKind, (bytes: Uint8Array) => void> = {
  zkey: checkMembershipZkey,
  wasm: checkMembershipWasm,
};

function pinned(kind: ProverArtifactKind, bytes: Uint8Array): boolean {
  try {
    CHECKS[kind](bytes);
    return true;
  } catch (e) {
    if (e instanceof MembershipProverError) return false;
    throw e;
  }
}

/** Both artifacts, each checked against its pin; throws `ProverArtifactError`. */
export async function loadProverArtifacts(
  sources: ProverArtifactSources,
): Promise<ProverArtifacts> {
  const cache = await open(sources.caches);
  const [zkey, wasm] = await Promise.all([
    load(sources, cache, "zkey"),
    load(sources, cache, "wasm"),
  ]);
  return { zkey, wasm };
}

// The cache is a convenience, never a source of trust: where it is missing,
// full or refuses (a private window, storage blocked), the artifacts are
// fetched on every load instead, and every load is checked either way.
async function open(caches: CacheStorage | undefined): Promise<Cache | undefined> {
  try {
    return await caches?.open(PROVER_CACHE);
  } catch {
    return undefined;
  }
}

async function load(
  sources: ProverArtifactSources,
  cache: Cache | undefined,
  kind: ProverArtifactKind,
): Promise<Uint8Array> {
  const url = new URL(PROVER_ARTIFACT_NAMES[kind], sources.base).href;
  const cached = await cachedBytes(cache, url);
  if (cached !== undefined && pinned(kind, cached)) return cached;
  if (cached !== undefined) await cache?.delete(url).catch(() => false);
  const fetched = await download(sources, url);
  if (!pinned(kind, fetched)) throw new ProverArtifactError(kind);
  await cache?.put(url, new Response(fetched.slice())).catch(() => undefined);
  return fetched;
}

async function cachedBytes(cache: Cache | undefined, url: string): Promise<Uint8Array | undefined> {
  try {
    const response = await cache?.match(url);
    return response === undefined ? undefined : await readCapped(response);
  } catch {
    return undefined;
  }
}

async function download(sources: ProverArtifactSources, url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    // Our own origin, no cookies and no redirect elsewhere; the browser's
    // HTTP cache may answer, since the bytes are checked whatever answers.
    response = await sources.fetch(url, { credentials: "omit", redirect: "error" });
  } catch {
    throw new ProverArtifactError("unavailable");
  }
  if (!response.ok) throw new ProverArtifactError("unavailable");
  const bytes = await readCapped(response).catch(() => undefined);
  if (bytes === undefined) throw new ProverArtifactError("unavailable");
  return bytes;
}

/** The body's bytes, refused once they pass MAX_ARTIFACT_BYTES rather than read without end. */
async function readCapped(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_ARTIFACT_BYTES) {
      await reader.cancel();
      throw new RangeError("artifact: response too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
