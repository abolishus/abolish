import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cidText, contentDag, readObjectAsync } from "@abolishus/crypto";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  BundleError,
  type CheckResult,
  EXIT_CODES,
  gatewaySource,
  loadBundle,
  MAX_GATEWAYS,
  parseBundle,
  parseGateway,
  readBoardByCid,
  readBundle,
  type Report,
  runCli,
  verifyBundle,
} from "../src/index.ts";

// docs/spec/verifier.md, Board by CID: block sources over the IPFS trustless
// gateway API. A gateway here is a local HTTP server, or a `fetch` the test
// supplies; no test reaches the network.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const CHUNK = 1 << 20;

interface Block {
  readonly cid: Uint8Array;
  readonly bytes: Uint8Array;
}

// What a gateway serves for a CID's text form: the bytes, or undefined (404).
type Serve = (cid: string, headers: IncomingHttpHeaders, url: string) => Uint8Array | undefined;

let server: Server;
let base: URL;
let serve: Serve = () => undefined;
const requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    const m = /^\/gw\/ipfs\/([a-z2-7]+)\?format=raw$/u.exec(url);
    const body = m === null ? undefined : serve(m[1] as string, req.headers, url);
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/vnd.ipld.raw" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = parseGateway(`http://127.0.0.1:${(server.address() as AddressInfo).port}/gw/`);
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const byText = (blocks: readonly Block[]) => new Map(blocks.map((b) => [cidText(b.cid), b.bytes]));

const urlOf = (input: string | URL | Request) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

// A fetch whose every answer is `respond(url)`; the requests are counted.
function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetch = ((input: string | URL | Request) => {
    const url = urlOf(input);
    urls.push(url);
    return Promise.resolve(respond(url));
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

// A body that never ends, counting what the reader pulled.
function endless(pulled: { bytes: number }): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      pulled.bytes += 4096;
      controller.enqueue(new Uint8Array(4096));
    },
  });
}

describe("parseGateway", () => {
  test("takes http: and https: bases, dropping a trailing slash", () => {
    expect(parseGateway("https://ipfs.example/").href).toBe("https://ipfs.example/");
    expect(parseGateway("http://127.0.0.1:8080/a/b/").pathname).toBe("/a/b");
  });

  test("refuses anything else", () => {
    for (const bad of [
      "",
      "ipfs.example",
      "ftp://ipfs.example",
      "file:///tmp",
      "data:,x",
      "https://user:pass@ipfs.example",
      "https://user@ipfs.example",
      "https://ipfs.example/?x=1",
      "https://ipfs.example/?",
      "https://ipfs.example/#x",
      "https://ipfs.example/#",
    ])
      expect(() => parseGateway(bad), bad).toThrow(RangeError);
  });
});

describe("gatewaySource", () => {
  test("needs 1 to MAX_GATEWAYS gateways and a positive timeout", () => {
    const g = parseGateway("https://ipfs.example");
    expect(() => gatewaySource([])).toThrow(RangeError);
    expect(() => gatewaySource(Array.from({ length: MAX_GATEWAYS + 1 }, () => g))).toThrow(
      RangeError,
    );
    // A URL that skipped parseGateway is checked all the same.
    for (const bad of [
      "blob:https://evil.example/x",
      "ftp://ipfs.example",
      "https://ipfs.example/?q",
    ])
      expect(() => gatewaySource([new URL(bad)]), bad).toThrow(RangeError);
    for (const timeoutMs of [0, -1, 1.5, Number.NaN])
      expect(() => gatewaySource([g], { timeoutMs })).toThrow(RangeError);
  });

  test("reads an object back by its CID with raw-block requests", async () => {
    const object = new Uint8Array(2 * CHUNK + 5).map((_, i) => i % 251);
    const dag = contentDag(object);
    const blocks = byText(dag.blocks);
    const accepts: (string | undefined)[] = [];
    serve = (cid, headers) => {
      accepts.push(headers.accept);
      return blocks.get(cid);
    };
    requests.length = 0;
    const g = gatewaySource([base]);
    const r = await readObjectAsync(dag.root, object.length, g.source);
    // Compared as hex: a deep comparison of 2 MiB element by element takes seconds.
    expect(r.ok && bytesToHex(r.bytes) === bytesToHex(object)).toBe(true);
    expect(requests).toEqual(
      [dag.root, ...dag.blocks.filter((b) => b.cid !== dag.root).map((b) => b.cid)].map(
        (c) => `/gw/ipfs/${cidText(c)}?format=raw`,
      ),
    );
    expect(new Set(accepts)).toEqual(new Set(["application/vnd.ipld.raw"]));
    expect(g.stats()).toEqual({ requests: dag.blocks.length, blocks: dag.blocks.length });
  });

  test("asks the next gateway only when one fails, and serves only blocks that hash", async () => {
    // Each gateway holds the block whole, holds other bytes, holds nothing or
    // fails: the block is served exactly when some gateway holds it whole,
    // by the first such, and the gateways after it aren't asked.
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        fc.array(fc.constantFrom("whole", "altered", "missing", "error"), {
          minLength: 1,
          maxLength: MAX_GATEWAYS,
        }),
        async (object, kinds) => {
          const dag = contentDag(object);
          const block = dag.blocks[0] as Block;
          let asked = 0;
          const fetch = ((input: string | URL | Request) => {
            asked++;
            const i = Number(/^g([0-9]+)\./u.exec(new URL(urlOf(input)).host)?.[1]);
            switch (kinds[i]) {
              case "whole":
                return Promise.resolve(new Response(block.bytes));
              case "altered":
                return Promise.resolve(new Response(concatBytes(block.bytes, Uint8Array.of(0))));
              case "error":
                return Promise.reject(new TypeError("network"));
              default:
                return Promise.resolve(new Response(null, { status: 404 }));
            }
          }) as typeof globalThis.fetch;
          const g = gatewaySource(
            kinds.map((_, i) => parseGateway(`https://g${i}.example`)),
            { fetch },
          );
          const r = await readObjectAsync(dag.root, object.length, g.source);
          const first = kinds.indexOf("whole");
          if (first === -1) {
            expect(r).toEqual({ ok: false, reason: "unavailable" });
            expect(g.stats()).toEqual({ requests: kinds.length, blocks: 0 });
          } else {
            expect(r).toEqual({ ok: true, bytes: object });
            expect(g.stats()).toEqual({ requests: first + 1, blocks: 1 });
          }
          expect(asked).toBe(g.stats().requests);
        },
      ),
      { numRuns },
    );
  });

  test("stops reading an endless answer past the limit, before holding more", async () => {
    const block = contentDag(Uint8Array.of(1, 2, 3)).blocks[0] as Block;
    const pulled = { bytes: 0 };
    const first = fakeFetch(() => new Response(endless(pulled)));
    const second = fakeFetch(() => new Response(block.bytes));
    let n = 0;
    const fetch = ((input: string | URL | Request) =>
      (n++ === 0 ? first : second).fetch(input)) as typeof globalThis.fetch;
    const g = gatewaySource(
      [parseGateway("https://a.example"), parseGateway("https://b.example")],
      { fetch },
    );
    expect(await g.source(block.cid, 10_000)).toEqual([block.bytes]);
    // At most one chunk of the stream past the limit was ever pulled.
    expect(pulled.bytes).toBeLessThanOrEqual(10_000 + 2 * 4096);
    // The reader's limit is capped at one chunk whatever it asks for.
    pulled.bytes = 0;
    n = 0;
    expect(await g.source(block.cid, 2 ** 40)).toEqual([block.bytes]);
    expect(pulled.bytes).toBeLessThanOrEqual(CHUNK + 2 * 4096);
  });

  test("refuses a declared length past the limit without reading the body", async () => {
    const block = contentDag(new Uint8Array(100)).blocks[0] as Block;
    const pulled = { bytes: 0 };
    const { fetch } = fakeFetch(
      () => new Response(endless(pulled), { headers: { "content-length": "101" } }),
    );
    const g = gatewaySource([parseGateway("https://a.example")], { fetch });
    expect(await g.source(block.cid, 99)).toEqual([]);
    expect(pulled.bytes).toBeLessThanOrEqual(4096);
  });

  test("a status other than 200 is no answer, whatever its body", async () => {
    const block = contentDag(Uint8Array.of(7)).blocks[0] as Block;
    for (const status of [201, 203, 206, 301, 404, 500]) {
      const { fetch } = fakeFetch(() =>
        status === 301
          ? new Response(null, { status, headers: { location: "https://elsewhere.example" } })
          : new Response(block.bytes, { status }),
      );
      const g = gatewaySource([parseGateway("https://a.example")], { fetch });
      expect(await g.source(block.cid, CHUNK), String(status)).toEqual([]);
    }
  });

  test("follows no redirect", async () => {
    const block = contentDag(Uint8Array.of(9)).blocks[0] as Block;
    const target = createServer((_, res) => res.end(block.bytes));
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const to = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`;
    const redirecting = createServer((_, res) => res.writeHead(302, { location: to }).end());
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
    try {
      const g = gatewaySource([
        parseGateway(`http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`),
      ]);
      expect(await g.source(block.cid, CHUNK)).toEqual([]);
    } finally {
      redirecting.close();
      target.close();
    }
  });

  test("gives up on a gateway that doesn't answer within the timeout", async () => {
    const block = contentDag(Uint8Array.of(5)).blocks[0] as Block;
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const slow = createServer((_, res) => {
      res.writeHead(200);
      res.write(block.bytes.subarray(0, 0));
      // Headers, then a body that never ends.
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    try {
      const url = (s: Server) =>
        parseGateway(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
      const start = performance.now();
      const g = gatewaySource([url(silent), url(slow)], { timeoutMs: 200 });
      expect(await g.source(block.cid, CHUNK)).toEqual([]);
      expect(performance.now() - start).toBeLessThan(5_000);
    } finally {
      silent.closeAllConnections();
      slow.closeAllConnections();
      silent.close();
      slow.close();
    }
  });

  test("a bare origin, with or without a trailing slash, asks for exactly /ipfs/{cid}?format=raw", async () => {
    const block = contentDag(Uint8Array.of(3)).blocks[0] as Block;
    for (const text of [
      "https://ipfs.example",
      "https://ipfs.example/",
      "https://ipfs.example//",
    ]) {
      const { fetch, urls } = fakeFetch(() => new Response(block.bytes));
      const g = gatewaySource([parseGateway(text)], { fetch });
      expect(await g.source(block.cid, CHUNK), text).toEqual([block.bytes]);
      expect(urls).toEqual([`https://ipfs.example/ipfs/${cidText(block.cid)}?format=raw`]);
    }
  });

  test("sends no request for a CID the reader can't use", async () => {
    const { fetch, urls } = fakeFetch(() => new Response(new Uint8Array()));
    const g = gatewaySource([parseGateway("https://a.example")], { fetch });
    const good = contentDag(Uint8Array.of(1)).root;
    const bad = [
      good.subarray(0, 35),
      concatBytes(good, Uint8Array.of(0)),
      Uint8Array.from([0x12, 0x20, ...good.subarray(4)]),
      Uint8Array.from([0x01, 0x71, ...good.subarray(2)]),
      Uint8Array.from([0x01, 0x55, 0x13, ...good.subarray(3)]),
    ];
    for (const cid of bad) expect(await g.source(cid, CHUNK)).toEqual([]);
    for (const limit of [-1, 1.5, Number.NaN]) expect(await g.source(good, limit)).toEqual([]);
    expect(urls).toEqual([]);
  });
});

// The boards of docs/spec/vectors/board.json (from the independent Python
// implementation, never from the code under test), read by CID from a
// gateway holding each vector's own entries' segment objects.

interface BoardVector {
  readonly id: string;
  readonly electionId: string;
  readonly now: string;
  readonly entries: readonly string[];
  readonly checkpoints: readonly Readonly<Record<string, string>>[];
}
const boards = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/board.json", import.meta.url), "utf8"),
) as { readonly clock: Readonly<Record<string, string>>; readonly boards: readonly BoardVector[] };
const valid = boards.boards.find((b) => b.id === "valid") as BoardVector;

const root = mkdtempSync(join(tmpdir(), "abolish-verify-gateways-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
function dir(files: Readonly<Record<string, string | Uint8Array>>): string {
  const d = join(root, String(dirs++));
  mkdirSync(d);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content);
  return d;
}

function localJson(v: BoardVector): string {
  return JSON.stringify({
    format: "abolish-verifier-bundle/1",
    electionId: v.electionId,
    boardEntryVersion: 1,
    clock: boards.clock,
    now: v.now,
    anchors: v.checkpoints.map((c) => ({
      electionId: c["electionId"],
      segment: c["segment"],
      size: c["size"],
      head: c["head"],
      root: c["root"],
      objectCid: c["objectCid"],
      hashesCid: c["hashesCid"],
      anchoredAt: c["anchoredAt"],
    })),
  });
}

const entriesOf = (v: BoardVector) => v.entries.map((e) => hexToBytes(e));

// Every block of every segment object of the vector's entries, as a mirror holds them.
function segmentBlocks(v: BoardVector): Block[] {
  const bySegment = new Map<number, Uint8Array[]>();
  for (const e of entriesOf(v).filter((e) => e.length >= 47)) {
    const s = new DataView(e.buffer, e.byteOffset + 43, 4).getUint32(0);
    bySegment.set(s, [...(bySegment.get(s) ?? []), e]);
  }
  return [...bySegment.values()].flatMap((run) => [...contentDag(concatBytes(...run)).blocks]);
}

function car(blocks: readonly Block[]): Uint8Array {
  const varint = (n: number) => {
    const out: number[] = [];
    do {
      out.push((n & 0x7f) | (n >= 0x80 ? 0x80 : 0));
      n = Math.floor(n / 0x80);
    } while (n > 0);
    return Uint8Array.from(out);
  };
  const ascii = (s: string) => new TextEncoder().encode(s);
  const header = concatBytes(
    Uint8Array.of(0xa2, 0x65),
    ascii("roots"),
    Uint8Array.of(0x81, 0xd8, 0x2a, 0x58, 37, 0x00),
    new Uint8Array(36),
    Uint8Array.of(0x67),
    ascii("version"),
    Uint8Array.of(0x01),
  );
  return concatBytes(
    varint(header.length),
    header,
    ...blocks.flatMap((b) => [varint(b.cid.length + b.bytes.length), b.cid, b.bytes]),
  );
}

const row = (r: Report, id: string) => r.checks.find((c) => c.id === id) as CheckResult;

describe("a board copy read from gateways", () => {
  test("every board.json board reads as from blocks.car holding the same blocks", async () => {
    for (const v of boards.boards) {
      const blocks = segmentBlocks(v);
      const held = byText(blocks);
      serve = (cid) => held.get(cid);
      const json = localJson(v);
      const fromGateway = verifyBundle(
        await loadBundle(dir({ "bundle.json": json }), undefined, gatewaySource([base])),
      );
      const fromCar = verifyBundle(
        await loadBundle(dir({ "bundle.json": json, "blocks.car": car(blocks) })),
      );
      expect(fromGateway.checks, v.id).toEqual(fromCar.checks);
      expect(fromGateway.board.entries, v.id).toBe(fromCar.board.entries);
      expect(fromGateway.board.byCid?.stopped, v.id).toEqual(fromCar.board.byCid?.stopped);
      expect(fromGateway.board.byCid?.storeBlocks, v.id).toBeUndefined();
    }
  });

  test("asks gateways only for what blocks.car doesn't hold", async () => {
    const blocks = segmentBlocks(valid);
    const [kept, ...rest] = blocks;
    const held = byText(rest);
    serve = (cid) => held.get(cid);
    const whole = verifyBundle(
      readBundle(
        dir({ "bundle.json": localJson(valid), "board.bin": concatBytes(...entriesOf(valid)) }),
      ),
    );
    const g = gatewaySource([base]);
    const r = verifyBundle(
      await loadBundle(
        dir({ "bundle.json": localJson(valid), "blocks.car": car([kept as Block]) }),
        undefined,
        g,
      ),
    );
    expect(r.checks).toEqual(whole.checks);
    expect(r.board.byCid).toEqual({
      storeBlocks: 1,
      storeUnreadableBytes: 0,
      gateways: { requests: rest.length, blocks: rest.length },
    });
  });

  test("an empty gateway leaves the copy short, unavailable, never failed", async () => {
    serve = () => undefined;
    const r = verifyBundle(
      await loadBundle(dir({ "bundle.json": localJson(valid) }), undefined, gatewaySource([base])),
    );
    expect(r.board.byCid).toEqual({
      gateways: { requests: 1, blocks: 0 },
      stopped: { checkpoint: 0, reason: "unavailable" },
    });
    expect(row(r, "4.2")).toMatchObject({ status: "unverifiable", code: "checkpoint-missing" });
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
  });

  test("a gateway serving other bytes leaves the copy short, never failed", async () => {
    const held = byText(segmentBlocks(valid));
    serve = (cid) => {
      const b = held.get(cid);
      return b === undefined ? undefined : concatBytes(b, Uint8Array.of(0));
    };
    const r = verifyBundle(
      await loadBundle(dir({ "bundle.json": localJson(valid) }), undefined, gatewaySource([base])),
    );
    expect(r.board.byCid?.stopped).toMatchObject({ reason: "unavailable" });
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
  });

  test("a bundle with board.bin and gateways is rejected; one with neither needs gateways", async () => {
    const d = dir({
      "bundle.json": localJson(valid),
      "board.bin": concatBytes(...entriesOf(valid)),
    });
    await expect(loadBundle(d, undefined, gatewaySource([base]))).rejects.toThrow(BundleError);
    await expect(loadBundle(dir({ "bundle.json": localJson(valid) }))).rejects.toThrow(BundleError);
    const parsed = parseBundle(localJson(valid), new Uint8Array());
    await expect(readBoardByCid(parsed, undefined, 1 << 20)).rejects.toThrow(TypeError);
  });
});

describe("the command line with --gateway", () => {
  async function run(...args: string[]) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(args, {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
    });
    return { code, stdout, stderr };
  }

  test("reads the copy from the gateways named, in order", async () => {
    const held = byText(segmentBlocks(valid));
    serve = (cid) => held.get(cid);
    const d = dir({ "bundle.json": localJson(valid) });
    const whole = verifyBundle(
      readBundle(
        dir({ "bundle.json": localJson(valid), "board.bin": concatBytes(...entriesOf(valid)) }),
      ),
    );
    // A gateway that refuses everything first, then ours.
    const r = await run("--gateway", `${base.origin}/nothing`, "--gateway", base.href, d);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.checks).toEqual(whole.checks);
    expect(report.board.byCid?.gateways).toEqual({
      requests: 2 * held.size,
      blocks: held.size,
    });
  });

  test("refuses a bad gateway or too many as usage", async () => {
    const d = dir({ "bundle.json": localJson(valid) });
    for (const bad of ["", "ftp://x", "https://x/?a", "https://u:p@x"]) {
      const u = await run("--gateway", bad, d);
      expect(u.code, bad).toBe(EXIT_CODES.usage);
      expect(u.stdout).toBe("");
    }
    const many = Array.from({ length: MAX_GATEWAYS + 1 }, () => ["--gateway", base.href]).flat();
    expect((await run(...many, d)).code).toBe(EXIT_CODES.usage);
  });

  test("a bundle with neither copy and no gateway is rejected", async () => {
    const r = await run(dir({ "bundle.json": localJson(valid) }));
    expect(r.code).toBe(EXIT_CODES.bundleRejected);
  });
});
