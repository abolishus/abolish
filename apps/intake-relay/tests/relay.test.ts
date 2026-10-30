import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SEALED_REQUEST, SEALED_ANSWER_LENGTH } from "@abolishus/crypto";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { parseRelayConfig, type RelayConfig } from "../src/config.ts";
import { type RelayOptions, serveRelay } from "../src/relay.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

interface Seen {
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** A stand-in node: records what reaches it and answers with `answer`. */
async function node(
  answer: (seen: Seen, res: ServerResponse) => void,
  listen: (h: (req: IncomingMessage, res: ServerResponse) => void) => Server = (h) =>
    createServer(h),
) {
  const seen: Seen[] = [];
  const server = listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = { url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(s);
      answer(s, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    seen,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const sealedAnswer = Buffer.alloc(SEALED_ANSWER_LENGTH, 7);
const answering = (_: Seen, res: ServerResponse) =>
  res
    .writeHead(200, {
      "content-type": "message/ohttp-res",
      "cache-control": "no-store",
      "x-node-only": "1",
    })
    .end(sealedAnswer);

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** A client's request to the relay. */
function send(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method ?? "POST",
        headers: {
          "content-type": "message/ohttp-req",
          ...(options.body === undefined ? {} : { "content-length": String(options.body.length) }),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const config = (port: number, extra: Partial<RelayConfig> = {}): RelayConfig =>
  parseRelayConfig(
    JSON.stringify({
      host: "127.0.0.1",
      port: 0,
      resources: [{ path: "seats/1", node: `http://127.0.0.1:${port}` }],
      ...extra,
    }),
  );

const request16k = new Uint8Array(16 * 1024).fill(3);

let stop: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stop.map((f) => f()));
  stop = [];
});

async function setup(
  answer: (seen: Seen, res: ServerResponse) => void = answering,
  extra: Partial<RelayConfig> = {},
  options: RelayOptions = {},
) {
  const n = await node(answer);
  const relay = await serveRelay(config(n.port, extra), options);
  stop.push(n.close, relay.close);
  return { n, relay, url: `${relay.origin}/seats/1` };
}

describe("the relay", () => {
  it("carries the body alone to the node's sealed route and returns only its answer (T-11)", async () => {
    const { n, url } = await setup();
    const reply = await send(url, {
      body: request16k,
      headers: {
        cookie: "a=b",
        "user-agent": "browser",
        "accept-language": "es",
        "x-forwarded-for": "203.0.113.9",
        forwarded: "for=203.0.113.9",
        via: "1.1 edge",
        "x-real-ip": "203.0.113.9",
      },
    });
    expect(reply.status).toBe(200);
    expect(reply.body.equals(sealedAnswer)).toBe(true);
    expect(reply.headers["content-type"]).toBe("message/ohttp-res");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["x-node-only"]).toBeUndefined();
    expect(n.seen).toHaveLength(1);
    const [seen] = n.seen;
    expect(seen?.url).toBe("/v1/sealed-intake");
    expect(Buffer.from(request16k).equals(seen?.body ?? Buffer.alloc(0))).toBe(true);
    expect(Object.keys(seen?.headers ?? {}).sort()).toEqual([
      "connection",
      "content-length",
      "content-type",
      "host",
    ]);
    expect(seen?.headers["content-type"]).toBe("message/ohttp-req");
  });

  it("carries any body byte for byte", async () => {
    const { n, url } = await setup();
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (body) => {
        const before = n.seen.length;
        const reply = await send(url, { body });
        return reply.status === 200 && (n.seen[before]?.body.equals(Buffer.from(body)) ?? false);
      }),
      { numRuns: Math.min(numRuns, 200) },
    );
  });

  it("returns the node's error status with no body and none of its headers", async () => {
    for (const status of [400, 413, 415, 503]) {
      const { url } = await setup((_, res) =>
        res.writeHead(status, { "retry-after": "5", "x-node-only": "1" }).end(),
      );
      const reply = await send(url, { body: request16k });
      expect(reply.status).toBe(status);
      expect(reply.body).toHaveLength(0);
      expect(reply.headers["x-node-only"]).toBeUndefined();
      expect(reply.headers["retry-after"]).toBeUndefined();
    }
  });

  it("answers 502 when the node gives no answer", async () => {
    const cases: ((s: Seen, res: ServerResponse) => void)[] = [
      // Another media type.
      (_, res) => res.writeHead(200, { "content-type": "text/plain" }).end("hi"),
      // An answer longer than any sealed answer.
      (_, res) =>
        res
          .writeHead(200, { "content-type": "message/ohttp-res" })
          .end(Buffer.alloc(SEALED_ANSWER_LENGTH + 1)),
      // A status the node's route never gives.
      (_, res) => res.writeHead(302, { location: "https://elsewhere.example" }).end(),
      // The connection dropped.
      (_, res) => res.socket?.destroy(),
    ];
    for (const answer of cases) {
      const { relay, url } = await setup(answer);
      const reply = await send(url, { body: request16k });
      expect(reply.status).toBe(502);
      expect(reply.body).toHaveLength(0);
      expect(relay.takeCounts()).toEqual({ "seats/1": { requests: 1, failed: 1 } });
    }
  });

  it("answers 502 for a node that isn't there, and when the node takes too long", async () => {
    const gone = await node(answering);
    await gone.close();
    const relay = await serveRelay(config(gone.port));
    stop.push(relay.close);
    expect((await send(`${relay.origin}/seats/1`, { body: request16k })).status).toBe(502);

    const { url } = await setup(() => undefined, { timeoutSeconds: 1 });
    expect((await send(url, { body: request16k })).status).toBe(502);
  });

  it("refuses another media type, method, resource or spelling of it", async () => {
    const { n, relay, url } = await setup();
    expect(
      (
        await send(url, {
          body: request16k,
          headers: { "content-type": "application/octet-stream" },
        })
      ).status,
    ).toBe(415);
    expect((await send(url, { method: "GET" })).status).toBe(405);
    expect((await send(`${relay.origin}/seats/2`, { body: request16k })).status).toBe(404);
    expect((await send(`${url}?x=1`, { body: request16k })).status).toBe(404);
    expect((await send(`${url}/`, { body: request16k })).status).toBe(404);
    expect((await send(`${relay.origin}/seats%2F1`, { body: request16k })).status).toBe(404);
    expect(n.seen).toHaveLength(0);
  });

  it("answers a browser's preflight from any origin, with nothing cached", async () => {
    const { n, url } = await setup();
    const reply = await send(url, {
      method: "OPTIONS",
      headers: { origin: "https://ballot.example", "access-control-request-method": "POST" },
    });
    expect(reply.status).toBe(204);
    expect(reply.headers["access-control-allow-origin"]).toBe("*");
    expect(reply.headers["access-control-allow-methods"]).toBe("POST");
    expect(reply.headers["access-control-allow-headers"]).toBe("content-type");
    expect(n.seen).toHaveLength(0);
    const posted = await send(url, { body: request16k });
    expect(posted.headers["access-control-allow-origin"]).toBe("*");
  });

  it("refuses a declared length past MAX_SEALED_REQUEST before reading it, and a streamed one past it (T-52)", async () => {
    const { n, url } = await setup();
    const declared = await send(url, {
      headers: { "content-length": String(MAX_SEALED_REQUEST + 1) },
    });
    expect(declared.status).toBe(413);
    const streamed = await new Promise<number>((resolve, reject) => {
      const req = request(
        url,
        { method: "POST", headers: { "content-type": "message/ohttp-req" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(Buffer.alloc(MAX_SEALED_REQUEST + 1));
    });
    expect(streamed).toBe(413);
    expect(n.seen).toHaveLength(0);
  });

  it("holds at most `queue` bodies at once, answering 503 past it (T-52)", async () => {
    let release: (() => void) | undefined;
    let hold = true;
    const { url } = await setup(
      (s, res) => {
        if (hold) release = () => answering(s, res);
        else answering(s, res);
      },
      { queue: 1 },
    );
    const first = send(url, { body: request16k });
    while (release === undefined) await new Promise((r) => setTimeout(r, 5));
    const second = await send(url, { body: request16k });
    expect(second.status).toBe(503);
    expect(second.headers["retry-after"]).toBe("5");
    hold = false;
    release();
    expect((await first).status).toBe(200);
    expect((await send(url, { body: request16k })).status).toBe(200);
  });

  it("limits each address's requests per window, by the edge's last address, keeping no address past it (T-54)", async () => {
    let t = 0;
    const { url } = await setup(
      answering,
      { rate: { requests: 2, windowSeconds: 60, addressHeader: "x-forwarded-for" } },
      { now: () => t },
    );
    const from = (address: string) =>
      send(url, { body: request16k, headers: { "x-forwarded-for": address } });
    expect((await from("198.51.100.1, 203.0.113.1")).status).toBe(200);
    // A client's own value before the edge's doesn't make it another address.
    expect((await from("198.51.100.2, 203.0.113.1")).status).toBe(200);
    const limited = await from("203.0.113.1");
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("5");
    expect((await from("203.0.113.2")).status).toBe(200);
    t = 60_000;
    expect((await from("203.0.113.1")).status).toBe(200);
  });

  it("never asks the node for a request past the rate", async () => {
    const { n, url } = await setup(answering, { rate: { requests: 1, windowSeconds: 60 } });
    expect((await send(url, { body: request16k })).status).toBe(200);
    expect((await send(url, { body: request16k })).status).toBe(429);
    expect(n.seen).toHaveLength(1);
  });

  it("counts an IPv6 address by its /64, and a header holding no address as the socket's peer (T-54)", async () => {
    const { url } = await setup(answering, {
      rate: { requests: 1, windowSeconds: 60, addressHeader: "x-real-ip" },
    });
    const from = (address: string) =>
      send(url, { body: request16k, headers: { "x-real-ip": address } });
    expect((await from("2001:db8:1:2::1")).status).toBe(200);
    expect((await from("2001:0db8:0001:0002:ffff::9")).status).toBe(429);
    expect((await from("2001:db8:1:3::1")).status).toBe(200);
    // Junk falls back to the socket's peer, 127.0.0.1, whichever junk it is.
    expect((await from("x".repeat(4000))).status).toBe(200);
    expect((await from("not an address")).status).toBe(429);
    expect((await from("::ffff:127.0.0.1")).status).toBe(429);
  });

  it("leaves a new address unlimited once a window's table is full, so filling it holds no one off", async () => {
    const { url } = await setup(
      answering,
      { rate: { requests: 1, windowSeconds: 60, addressHeader: "x-forwarded-for" } },
      { now: () => 0, trackedAddresses: 2 },
    );
    const from = (address: string) =>
      send(url, { body: request16k, headers: { "x-forwarded-for": address } });
    expect((await from("203.0.113.1")).status).toBe(200);
    expect((await from("203.0.113.2")).status).toBe(200);
    expect((await from("203.0.113.3")).status).toBe(200);
    expect((await from("203.0.113.3")).status).toBe(200);
    // The tracked ones are still limited.
    expect((await from("203.0.113.1")).status).toBe(429);
  });

  it("gives up on a node that trickles its answer past the deadline (T-52)", async () => {
    const { url } = await setup(
      (_, res) => {
        res.writeHead(200, { "content-type": "message/ohttp-res" });
        const timer = setInterval(() => res.write(Buffer.alloc(1)), 300);
        res.on("close", () => clearInterval(timer));
      },
      { timeoutSeconds: 1 },
    );
    const started = Date.now();
    expect((await send(url, { body: request16k })).status).toBe(502);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("lets a stalled node hold at most half the queue, so other seats keep their route (T-25)", async () => {
    const stalled = await node(() => undefined);
    const healthy = await node(answering);
    const relay = await serveRelay(
      parseRelayConfig(
        JSON.stringify({
          host: "127.0.0.1",
          port: 0,
          queue: 2,
          resources: [
            { path: "seats/1", node: `http://127.0.0.1:${stalled.port}` },
            { path: "seats/2", node: `http://127.0.0.1:${healthy.port}` },
          ],
        }),
      ),
    );
    stop.push(stalled.close, healthy.close, relay.close);
    void send(`${relay.origin}/seats/1`, { body: request16k }).catch(() => undefined);
    while (stalled.seen.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect((await send(`${relay.origin}/seats/1`, { body: request16k })).status).toBe(503);
    expect((await send(`${relay.origin}/seats/2`, { body: request16k })).status).toBe(200);
  });

  it("releases a place when its client goes away mid-forward", async () => {
    let held: ServerResponse | undefined;
    const { url } = await setup(
      (s, res) => {
        if (held === undefined) held = res;
        else answering(s, res);
      },
      { queue: 1 },
    );
    const req = request(url, {
      method: "POST",
      headers: { "content-type": "message/ohttp-req", "content-length": String(request16k.length) },
    });
    req.on("error", () => undefined);
    req.end(request16k);
    while (held === undefined) await new Promise((r) => setTimeout(r, 5));
    req.destroy();
    held.end();
    let status = 503;
    for (let i = 0; i < 100 && status === 503; i++) {
      status = (await send(url, { body: request16k })).status;
      if (status === 503) await new Promise((r) => setTimeout(r, 10));
    }
    expect(status).toBe(200);
  });

  it("counts requests per resource and nothing else", async () => {
    const { relay, url } = await setup();
    await send(url, { body: request16k });
    await send(url, { body: request16k });
    await send(url, { method: "GET" });
    expect(relay.takeCounts()).toEqual({ "seats/1": { requests: 2, failed: 0 } });
    expect(relay.takeCounts()).toEqual({ "seats/1": { requests: 0, failed: 0 } });
  });
});

describe("the relay's connection to a node over TLS", () => {
  let dir: string;
  let cert: string;
  let key: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "intake-relay-tls-"));
    const keyFile = join(dir, "key.pem");
    const certFile = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    cert = await readFile(certFile, "utf8");
    key = await readFile(keyFile, "utf8");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const tlsNode = (ecdhCurve: string, maxVersion: "TLSv1.2" | "TLSv1.3" = "TLSv1.3") =>
    node(answering, (h) => createHttpsServer({ cert, key, ecdhCurve, maxVersion }, h));

  const relayTo = async (port: number, ca: string | undefined) => {
    const relay = await serveRelay(
      parseRelayConfig(
        JSON.stringify({
          host: "127.0.0.1",
          port: 0,
          resources: [
            {
              path: "seats/1",
              node: `https://127.0.0.1:${port}`,
              ...(ca === undefined ? {} : { ca }),
            },
          ],
        }),
      ),
    );
    stop.push(relay.close);
    return `${relay.origin}/seats/1`;
  };

  it("reaches a node that holds to the hybrid post-quantum group, with its pinned certificate (T-15)", async () => {
    const n = await tlsNode("X25519MLKEM768");
    stop.push(n.close);
    const reply = await send(await relayTo(n.port, cert), { body: request16k });
    expect(reply.status).toBe(200);
    expect(reply.body.equals(sealedAnswer)).toBe(true);
  });

  it("gives no answer from a node offering only a classical group or TLS 1.2, or one it can't authenticate", async () => {
    const classical = await tlsNode("X25519:P-256");
    stop.push(classical.close);
    expect((await send(await relayTo(classical.port, cert), { body: request16k })).status).toBe(
      502,
    );
    expect(classical.seen).toHaveLength(0);

    const old = await tlsNode("X25519MLKEM768:X25519", "TLSv1.2");
    stop.push(old.close);
    expect((await send(await relayTo(old.port, cert), { body: request16k })).status).toBe(502);
    expect(old.seen).toHaveLength(0);

    const unpinned = await tlsNode("X25519MLKEM768");
    stop.push(unpinned.close);
    expect((await send(await relayTo(unpinned.port, undefined), { body: request16k })).status).toBe(
      502,
    );
    expect(unpinned.seen).toHaveLength(0);
  });
});
