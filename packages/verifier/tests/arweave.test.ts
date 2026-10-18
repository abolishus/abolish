import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  arweaveId,
  encodeArchiveLocator,
  encodeArchiveManifest,
  objectCar,
  objectCid,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  arweaveSource,
  MANIFEST_DATA_LIMIT,
  MAX_GATEWAYS,
  parseGateway,
  readListedObjects,
  walkArchive,
} from "../src/index.ts";

// docs/spec/archive.md, Reading from gateways: Arweave transactions' data
// over `GET /raw/{id}`. A gateway here is a local HTTP server, or a `fetch`
// the test supplies; no test reaches the network.

const DEPLOYMENT = { l1ChainId: 11_155_111n, anchor: new Uint8Array(20).fill(0xa0) };

const tx = (n: number) => {
  const t = new Uint8Array(32);
  t[0] = 0x7a;
  t[31] = n;
  return t;
};

// A one-manifest archive: its bytes, CID, transaction and locator.
const m0 = (() => {
  const bytes = encodeArchiveManifest({
    l1_chain_id: DEPLOYMENT.l1ChainId,
    anchor: DEPLOYMENT.anchor,
    sequence: 0n,
    objects: [{ cid: objectCid(Uint8Array.of(1)), transaction: tx(9) }],
    links: [],
  });
  const cid = objectCid(bytes);
  return { bytes, cid, transaction: tx(1), locator: encodeArchiveLocator(cid, tx(1)) };
})();

let server: Server;
let base: URL;
// What the server sends for a transaction ID: the body, or undefined (404).
let serve: (id: string) => Uint8Array | undefined = () => undefined;
const requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    const m = /^\/ar\/raw\/([A-Za-z0-9_-]{43})$/u.exec(url);
    const body = m === null ? undefined : serve(m[1] as string);
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = parseGateway(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ar/`);
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const urlOf = (input: string | URL | Request) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

// A fetch answering each request in turn from `responses` (404 past them).
function fakeFetch(responses: readonly (() => Response)[]) {
  const urls: string[] = [];
  const fetch = ((input: string | URL | Request) => {
    const url = urlOf(input);
    const respond = responses[urls.length];
    urls.push(url);
    return Promise.resolve(respond === undefined ? new Response(null, { status: 404 }) : respond());
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

const gateways = (n: number) =>
  Array.from({ length: n }, (_, i) => parseGateway(`https://ar${i}.example`));

async function answers(source: ReturnType<typeof arweaveSource>["source"], t: Uint8Array) {
  const out: Uint8Array[] = [];
  for await (const a of await source(t, MANIFEST_DATA_LIMIT)) out.push(a);
  return out;
}

describe("arweaveSource", () => {
  test("needs 1 to MAX_GATEWAYS gateways and a positive timeout", () => {
    expect(() => arweaveSource([])).toThrow(RangeError);
    expect(() => arweaveSource(gateways(MAX_GATEWAYS + 1))).toThrow(RangeError);
    expect(() => arweaveSource(gateways(MAX_GATEWAYS))).not.toThrow();
    for (const timeoutMs of [0, -1, 1.5])
      expect(() => arweaveSource(gateways(1), { timeoutMs })).toThrow(RangeError);
    // A base parseGateway refuses is refused here too.
    expect(() => arweaveSource([new URL("https://user@ar.example")])).toThrow(RangeError);
  });

  test("walks an archive over HTTP, asking for exactly {base}/raw/{id}", async () => {
    requests.length = 0;
    serve = (id) => (id === arweaveId(m0.transaction) ? objectCar(m0.bytes) : undefined);
    const ar = arweaveSource([base]);
    const walk = await walkArchive(m0.locator, DEPLOYMENT, ar.source);
    expect(walk.findings).toEqual([]);
    expect(walk.latest).toBe(0n);
    expect(requests).toEqual([`/ar/raw/${arweaveId(m0.transaction)}`]);
    expect(ar.stats()).toEqual({ requests: 1, answers: 1 });
  });

  test("asks the next gateway only once an answer fails to read", async () => {
    const car = objectCar(m0.bytes);
    const { fetch, urls } = fakeFetch([
      () => new Response(null, { status: 404 }),
      () => new Response(Uint8Array.of(1, 2, 3)),
      () => new Response(car),
      () => new Response(car),
    ]);
    const ar = arweaveSource(gateways(4), { fetch });
    const walk = await walkArchive(m0.locator, DEPLOYMENT, ar.source);
    expect(walk.findings).toEqual([]);
    // The fourth gateway is never asked: the third's answer read.
    const id = arweaveId(m0.transaction);
    expect(urls).toEqual([0, 1, 2].map((i) => `https://ar${i}.example/raw/${id}`));
    expect(ar.stats()).toEqual({ requests: 3, answers: 2 });
  });

  test("a transaction no gateway serves is unavailable, after every gateway was asked", async () => {
    const { fetch, urls } = fakeFetch([]);
    const ar = arweaveSource(gateways(3), { fetch });
    const walk = await walkArchive(m0.locator, DEPLOYMENT, ar.source);
    expect(walk.findings.map((f) => f.code)).toEqual(["unavailable"]);
    expect(urls).toHaveLength(3);
  });

  test("a status other than 200 is no answer, whatever its body", async () => {
    const car = objectCar(m0.bytes);
    for (const status of [201, 203, 206, 301, 404, 500]) {
      const { fetch } = fakeFetch([
        () =>
          status === 301
            ? new Response(null, { status, headers: { location: "https://elsewhere.example" } })
            : new Response(car, { status }),
      ]);
      const ar = arweaveSource(gateways(1), { fetch });
      expect(await answers(ar.source, m0.transaction), String(status)).toEqual([]);
    }
  });

  test("follows no redirect", async () => {
    const target = createServer((_, res) => res.end(objectCar(m0.bytes)));
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const to = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`;
    const redirecting = createServer((_, res) => res.writeHead(302, { location: to }).end());
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
    try {
      const ar = arweaveSource([
        parseGateway(`http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`),
      ]);
      expect(await answers(ar.source, m0.transaction)).toEqual([]);
    } finally {
      redirecting.close();
      target.close();
    }
  });

  test("stops reading an answer past the limit, before holding more", async () => {
    const pulled = { bytes: 0 };
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled.bytes += 4096;
        controller.enqueue(new Uint8Array(4096));
      },
    });
    const { fetch } = fakeFetch([() => new Response(endless)]);
    const ar = arweaveSource(gateways(1), { fetch });
    const out: Uint8Array[] = [];
    for await (const a of await ar.source(m0.transaction, 10_000)) out.push(a);
    expect(out).toEqual([]);
    expect(pulled.bytes).toBeLessThanOrEqual(10_000 + 2 * 4096);
  });

  test("gives up on a gateway that doesn't answer within the timeout", async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    try {
      const start = performance.now();
      const ar = arweaveSource(
        [parseGateway(`http://127.0.0.1:${(silent.address() as AddressInfo).port}`)],
        { timeoutMs: 200 },
      );
      expect(await answers(ar.source, m0.transaction)).toEqual([]);
      expect(performance.now() - start).toBeLessThan(5_000);
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  });

  test("sends no request for an ID that isn't 32 bytes or a limit that isn't a count", async () => {
    const { fetch, urls } = fakeFetch([]);
    const ar = arweaveSource(gateways(1), { fetch });
    for (const t of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(0)])
      expect(await answers(ar.source, t)).toEqual([]);
    for (const limit of [-1, 1.5, Number.NaN]) {
      const out: Uint8Array[] = [];
      for await (const a of await ar.source(m0.transaction, limit)) out.push(a);
      expect(out).toEqual([]);
    }
    expect(urls).toEqual([]);
  });

  test("reads listed objects over HTTP under each one's own limit", async () => {
    const segment = Uint8Array.of(5, 6, 7);
    const t = tx(2);
    requests.length = 0;
    serve = (id) => (id === arweaveId(t) ? objectCar(segment) : undefined);
    const read = await readListedObjects(
      [{ size: 1n, cid: objectCid(segment), bound: 100n }],
      new Map([[bytesToHex(objectCid(segment)), [t]]]),
      arweaveSource([base]).source,
      1_000,
    );
    expect(read.findings).toEqual([]);
    expect(read.spent).toBe(3);
    expect(requests).toEqual([`/ar/raw/${arweaveId(t)}`]);
  });
});
