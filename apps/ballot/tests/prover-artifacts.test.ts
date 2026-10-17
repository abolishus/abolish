// Loading the prover's artifacts (src/prover-artifacts.ts) against an
// in-memory release and Cache Storage: the vendored, pinned files are
// fetched once and served from the cache after; a cached copy that isn't the
// pinned bytes is dropped and fetched again; fetched bytes that aren't are
// refused and never cached; and a missing or refusing cache only costs a
// fetch (T-07, T-12).

import { readFileSync } from "node:fs";

import { describe, expect, test } from "vite-plus/test";

import {
  loadProverArtifacts,
  PROVER_ARTIFACT_NAMES,
  PROVER_CACHE,
  ProverArtifactError,
  type ProverArtifactSources,
} from "../src/prover-artifacts.ts";

const ARTIFACTS = new URL(
  "../../../packages/membership-prover/artifacts/snark-artifacts/",
  import.meta.url,
);
const pinned = {
  zkey: new Uint8Array(readFileSync(new URL("semaphore-32.zkey", ARTIFACTS))),
  wasm: new Uint8Array(readFileSync(new URL("semaphore-32.wasm", ARTIFACTS))),
};
const BASE = "https://ballot.example/assets/index-abc.js";
const url = (kind: keyof typeof pinned) => new URL(PROVER_ARTIFACT_NAMES[kind], BASE).href;

/** A Cache Storage holding one cache in a Map, as much of the API as the loader uses. */
function memoryCaches(entries = new Map<string, Uint8Array>()) {
  const names: string[] = [];
  const cache = {
    match: async (key: string) => {
      const body = entries.get(key);
      return body === undefined ? undefined : new Response(body.slice());
    },
    put: async (key: string, response: Response) => {
      entries.set(key, new Uint8Array(await response.arrayBuffer()));
    },
    delete: async (key: string) => entries.delete(key),
  };
  const caches = {
    open: async (name: string) => {
      names.push(name);
      return cache;
    },
  } as unknown as CacheStorage;
  return { caches, entries, names };
}

function release(files: Partial<Record<keyof typeof pinned, Uint8Array>> = pinned) {
  const fetched: string[] = [];
  const fetch: ProverArtifactSources["fetch"] = async (u, init) => {
    fetched.push(u);
    expect(init).toEqual({ credentials: "omit", redirect: "error" });
    const kind = (Object.keys(PROVER_ARTIFACT_NAMES) as (keyof typeof pinned)[]).find(
      (k) => url(k) === u,
    );
    const body = kind === undefined ? undefined : files[kind];
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body.slice());
  };
  return { fetch, fetched };
}

// Compared as buffers: a deep equality over 5.8 MB, element by element, takes a minute.
const isPinned = (a: { zkey: Uint8Array; wasm: Uint8Array }) =>
  Buffer.from(a.zkey).equals(pinned.zkey) && Buffer.from(a.wasm).equals(pinned.wasm);

const problem = (p: Promise<unknown>) =>
  p.then(
    () => "loaded",
    (e: unknown) => (e instanceof ProverArtifactError ? e.problem : String(e)),
  );

describe("loading the prover's artifacts", () => {
  test("names each file by its pin, beside the page's scripts", () => {
    expect(url("zkey")).toMatch(
      /^https:\/\/ballot\.example\/assets\/semaphore-32-2e5f7a9f880c3371\.zkey$/,
    );
    expect(url("wasm")).toMatch(
      /^https:\/\/ballot\.example\/assets\/semaphore-32-528333d1247f585d\.wasm$/,
    );
  });

  test("fetches them once, then serves them from the cache", async () => {
    const { caches, entries, names } = memoryCaches();
    const { fetch, fetched } = release();
    const sources = { base: BASE, fetch, caches };
    expect(isPinned(await loadProverArtifacts(sources))).toBe(true);
    expect(isPinned(await loadProverArtifacts(sources))).toBe(true);
    expect(fetched.sort()).toEqual([url("zkey"), url("wasm")].sort());
    expect(new Set(names)).toEqual(new Set([PROVER_CACHE]));
    expect([...entries.keys()].sort()).toEqual([url("zkey"), url("wasm")].sort());
  });

  test("drops a cached copy that isn't the pinned bytes, and fetches it again", async () => {
    const tampered = pinned.zkey.slice();
    tampered[1000] = (tampered[1000] as number) ^ 1;
    const { caches, entries } = memoryCaches(
      new Map([
        [url("zkey"), tampered],
        [url("wasm"), pinned.wasm],
      ]),
    );
    const { fetch, fetched } = release();
    expect(isPinned(await loadProverArtifacts({ base: BASE, fetch, caches }))).toBe(true);
    expect(fetched).toEqual([url("zkey")]);
    expect(Buffer.from(entries.get(url("zkey")) ?? []).equals(pinned.zkey)).toBe(true);
  });

  test("refuses fetched bytes that aren't pinned, naming the file, and never caches them", async () => {
    const { caches, entries } = memoryCaches();
    const swapped = { zkey: pinned.zkey, wasm: pinned.zkey };
    await expect(
      problem(loadProverArtifacts({ base: BASE, fetch: release(swapped).fetch, caches })),
    ).resolves.toBe("wasm");
    expect(entries.has(url("wasm"))).toBe(false);
    const truncated = { zkey: pinned.zkey.slice(0, -1), wasm: pinned.wasm };
    await expect(
      problem(
        loadProverArtifacts({ base: BASE, fetch: release(truncated).fetch, caches: undefined }),
      ),
    ).resolves.toBe("zkey");
  });

  test("says the release didn't serve them when it doesn't, or the network fails", async () => {
    await expect(
      problem(
        loadProverArtifacts({
          base: BASE,
          fetch: release({ wasm: pinned.wasm }).fetch,
          caches: undefined,
        }),
      ),
    ).resolves.toBe("unavailable");
    await expect(
      problem(
        loadProverArtifacts({
          base: BASE,
          fetch: () => Promise.reject(new TypeError("offline")),
          caches: undefined,
        }),
      ),
    ).resolves.toBe("unavailable");
  });

  test("stops reading a response that runs past any pinned file's size", async () => {
    let pulled = 0;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++;
            controller.enqueue(new Uint8Array(1 << 20));
          },
        }),
      );
    await expect(
      problem(loadProverArtifacts({ base: BASE, fetch: async () => endless(), caches: undefined })),
    ).resolves.toBe("unavailable");
    // Two files, each stopped a chunk or two past 8 MiB.
    expect(pulled).toBeLessThanOrEqual(2 * 11);
  });

  test("loads without a cache, or with one that refuses every call", async () => {
    const refusing = {
      open: async () => ({
        match: () => Promise.reject(new DOMException("blocked", "SecurityError")),
        put: () => Promise.reject(new DOMException("full", "QuotaExceededError")),
        delete: () => Promise.reject(new DOMException("blocked", "SecurityError")),
      }),
    } as unknown as CacheStorage;
    const unopenable = {
      open: () => Promise.reject(new DOMException("blocked", "SecurityError")),
    } as unknown as CacheStorage;
    for (const caches of [undefined, refusing, unopenable]) {
      const { fetch, fetched } = release();
      expect(isPinned(await loadProverArtifacts({ base: BASE, fetch, caches }))).toBe(true);
      expect(fetched).toHaveLength(2);
    }
  });
});
