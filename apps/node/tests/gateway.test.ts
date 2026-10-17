import { once } from "node:events";
import { request } from "node:http";
import { connect } from "node:net";
import { cidText, contentDag, objectCar, readObjectAsync } from "@abolishus/crypto";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { type GatewayLimits, gateway } from "../src/gateway.ts";
import { openMirror } from "../src/store.ts";
import { blocksDir, close, listen, removeDirs } from "./fixture.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of servers.splice(0)) await stop();
  await removeDirs();
});

async function serve(files: Record<string, Uint8Array>, limits?: GatewayLimits): Promise<string> {
  const server = gateway(await openMirror(await blocksDir(files)), limits);
  const base = await listen(server);
  servers.push(() => close(server));
  return base;
}

// Byte equality without vitest's element-by-element diff, which takes seconds on 1 MiB.
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

const raw = (base: string, cid: Uint8Array, init?: RequestInit) =>
  fetch(`${base}/ipfs/${cidText(cid)}?format=raw`, init);

// 2.5 MiB: a dag-pb root over three distinct raw leaves.
const large = Uint8Array.from({ length: 2_621_440 }, (_, i) => (i * 31 + (i >>> 20)) & 0xff);

describe("the gateway", () => {
  test("serves every block of an object's DAG, and a reader rebuilds the object from them", async () => {
    const base = await serve({ "large.car": objectCar(large) });
    const dag = contentDag(large);
    expect(dag.blocks.length).toBe(4);
    for (const block of dag.blocks) {
      const res = await raw(base, block.cid);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/vnd.ipld.raw");
      expect(res.headers.get("cache-control")).toBe("public, max-age=29030400, immutable");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("vary")).toBe("accept");
      expect(res.headers.get("content-length")).toBe(String(block.bytes.length));
      expect(res.headers.get("etag")).toBe(`"${cidText(block.cid)}.raw"`);
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="${cidText(block.cid)}.bin"`,
      );
      expect(same(new Uint8Array(await res.arrayBuffer()), block.bytes)).toBe(true);
    }
    const read = await readObjectAsync(dag.root, large.length, async (cid) => {
      const res = await raw(base, cid);
      return res.ok ? [new Uint8Array(await res.arrayBuffer())] : [];
    });
    expect(read.ok && same(read.bytes, large)).toBe(true);
  });

  test("serves exactly the blocks its files hold, from any of them", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.uint8Array({ minLength: 1, maxLength: 300 }), {
          minLength: 1,
          maxLength: 4,
          selector: (b) => cidText(contentDag(b).root),
        }),
        fc.uint8Array({ minLength: 1, maxLength: 300 }),
        async (held, other) => {
          const files = Object.fromEntries(held.map((o, i) => [`${i}.car`, objectCar(o)]));
          const base = await serve(files);
          for (const o of held) {
            const res = await raw(base, contentDag(o).root);
            expect(new Uint8Array(await res.arrayBuffer())).toEqual(o);
          }
          if (!held.some((o) => cidText(contentDag(o).root) === cidText(contentDag(other).root)))
            expect((await raw(base, contentDag(other).root)).status).toBe(404);
          await servers.pop()?.();
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("never serves a block that doesn't hash to its CID", async () => {
    const object = new TextEncoder().encode("a segment object");
    const car = objectCar(object);
    // A single raw block ends the CAR.
    car[car.length - 1] = (car[car.length - 1] as number) ^ 1;
    const base = await serve({ "bad.car": car, "good.car": objectCar(new Uint8Array([1, 2, 3])) });
    expect((await raw(base, contentDag(object).root)).status).toBe(404);
    expect((await raw(base, contentDag(new Uint8Array([1, 2, 3])).root)).status).toBe(200);
  });

  test("answers HEAD with the headers and no body", async () => {
    const object = new Uint8Array([9, 9, 9]);
    const base = await serve({ "a.car": objectCar(object) });
    const res = await raw(base, contentDag(object).root, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("3");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    const missing = await raw(base, contentDag(new Uint8Array([1])).root, { method: "HEAD" });
    expect(missing.status).toBe(404);
  });

  test("serves raw blocks by the Accept header too, and nothing else", async () => {
    const object = new Uint8Array([4, 5, 6]);
    const cid = cidText(contentDag(object).root);
    const base = await serve({ "a.car": objectCar(object) });
    const accept = (value: string) => fetch(`${base}/ipfs/${cid}`, { headers: { accept: value } });
    expect((await accept("application/vnd.ipld.raw")).status).toBe(200);
    expect((await accept("text/html, application/vnd.ipld.raw;q=0.9")).status).toBe(200);
    expect((await accept("Application/VND.ipld.RAW")).status).toBe(200);
    expect((await accept("text/html")).status).toBe(406);
    expect((await accept("application/vnd.ipld.raw;q=0")).status).toBe(406);
    expect((await accept("application/vnd.ipld.raw; q=0.0, text/html")).status).toBe(406);
    expect((await fetch(`${base}/ipfs/${cid}`)).status).toBe(406);
    expect((await fetch(`${base}/ipfs/${cid}?format=car`)).status).toBe(406);
    expect((await fetch(`${base}/ipfs/${cid}?format=raw&format=car`)).status).toBe(406);
  });

  test("refuses anything but a raw-block request for a layout CID", async () => {
    const object = new Uint8Array([4, 5, 6]);
    const cid = cidText(contentDag(object).root);
    const base = await serve({ "a.car": objectCar(object) });
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/ipns/${cid}?format=raw`)).status).toBe(404);
    expect((await fetch(`${base}/ipfs/${cid}/file?format=raw`)).status).toBe(400);
    expect((await fetch(`${base}/ipfs/${cid.toUpperCase()}?format=raw`)).status).toBe(400);
    expect((await fetch(`${base}/ipfs/${cid}?format=raw&${"x".repeat(100)}`)).status).toBe(404);
    const post = await fetch(`${base}/ipfs/${cid}?format=raw`, { method: "POST", body: "x" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  test("refuses a request that carries a body, and closes its connection", async () => {
    const object = new Uint8Array([4, 5, 6]);
    const base = await serve({ "a.car": objectCar(object) });
    const send = (method: string, headers: Record<string, string>, body?: string) =>
      new Promise<{ status: number | undefined; connection: string | undefined }>(
        (resolve, reject) => {
          const req = request(`${base}/ipfs/${cidText(contentDag(object).root)}?format=raw`, {
            method,
            headers,
          });
          req.on("response", (res) => {
            res.resume();
            resolve({ status: res.statusCode, connection: res.headers.connection });
          });
          req.on("error", reject);
          req.end(body);
        },
      );
    // Declares far more than it sends: the answer doesn't wait for it.
    expect(await send("GET", { "content-length": "100000000" }, "x")).toEqual({
      status: 400,
      connection: "close",
    });
    expect(await send("POST", { "content-length": "1" }, "x")).toEqual({
      status: 405,
      connection: "close",
    });
    // An empty body declared as such is no body.
    expect((await send("GET", { "content-length": "0" })).status).toBe(200);
  });

  test("closes connections past its limit, and keeps serving", async () => {
    const object = new Uint8Array([4, 5, 6]);
    const base = await serve({ "a.car": objectCar(object) }, { maxConnections: 1 });
    const { port } = new URL(base);
    const held = connect(Number(port), "127.0.0.1");
    await once(held, "connect");
    const extra = connect(Number(port), "127.0.0.1");
    await once(extra, "close");
    held.destroy();
    await once(held, "close");
    await expect.poll(async () => (await raw(base, contentDag(object).root)).status).toBe(200);
  });

  test("closes a connection whose headers don't arrive in time", async () => {
    const base = await serve({}, { headersTimeoutMs: 200 });
    const socket = connect(Number(new URL(base).port), "127.0.0.1");
    await once(socket, "connect");
    let answer = "";
    socket.on("data", (d: Buffer) => (answer += d.toString("latin1")));
    socket.write("GET /ipfs/ HTTP/1.1\r\nhost: x\r\n");
    await once(socket, "close");
    expect(answer.startsWith("HTTP/1.1 408 ")).toBe(true);
  });
});
