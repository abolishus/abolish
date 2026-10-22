import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingHttpHeaders, Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Delivery,
  encodeDelivery,
  type Endpoint,
  type Intake,
  type IntakeOutcome,
  INTAKE_GROUPS,
  MAX_DELIVERY,
  serveIntake,
} from "@abolishus/trustee-node";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  type ApiOptions,
  createApiServer,
  intakeEndpoints,
  MAX_INTAKE_ANSWER,
  MAX_INTAKE_SEATS,
} from "../src/index.ts";

// The operator's intake relay (docs/spec/delivery.md, Client rules 4; P2-8
// part 3c-1b-2b-2b-2a), against apps/trustee-node's own endpoint over TLS
// with the hybrid group and against raw nodes that answer badly: the node
// gets the client's delivery byte for byte and nothing else of its request
// (T-11), the client gets the node's answer as the node gave it or a 502,
// a classical-only node gets nothing (T-39), and the relay's slots and
// bounds hold (T-52).

const runs = Number(process.env.FC_NUM_RUNS ?? 100);
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);
const DELIVERY: Delivery = {
  stub: bytes(3, 1),
  transcript: bytes(4, 2),
  record: bytes(5, 3),
  ciphertext: bytes(6, 4),
};
const RECEIPT = bytes(170, 9);
const ORIGIN = "https://ballot.example";

// The relay reads no database; one that throws shows it.
const NO_SQL = (() => {
  throw new Error("the relay reads no database");
}) as unknown as Sql;

let dir: string;
let tls: { cert: string; key: string };
const closing: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "api-intake-tls-"));
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
  tls = { cert: await readFile(certFile, "utf8"), key: await readFile(keyFile, "utf8") };
});
afterAll(async () => {
  for (const close of closing.reverse()) await close();
  await rm(dir, { recursive: true, force: true });
});

/** A stand-in seat behind the node's real endpoint, recording what it was given. */
async function node(
  answer: (d: Delivery) => Promise<IntakeOutcome> = async () => ({
    ok: true,
    ballotHash: bytes(32),
    receipt: RECEIPT,
  }),
): Promise<{ endpoint: Endpoint; given: Delivery[] }> {
  const given: Delivery[] = [];
  const intake: Intake = {
    async intake(stub, transcript, record, ciphertext) {
      const d = { stub, transcript, record, ciphertext };
      given.push(d);
      return answer(d);
    },
  };
  const endpoint = await serveIntake(intake, { host: "127.0.0.1", port: 0, tls, queue: 4 });
  closing.push(() => endpoint.close());
  return { endpoint, given };
}

/** A node answering however `handle` does, over TLS 1.3 with `groups`; records each request's headers and every connection. */
async function rawNode(
  handle: (res: import("node:http").ServerResponse) => void,
  groups = INTAKE_GROUPS,
) {
  const seen: { headers: IncomingHttpHeaders; body: Uint8Array }[] = [];
  const state = { connections: 0 };
  const server: HttpsServer = createHttpsServer(
    { ...tls, minVersion: "TLSv1.3", ecdhCurve: groups },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ headers: req.headers, body: new Uint8Array(Buffer.concat(chunks)) });
        handle(res);
      });
    },
  );
  server.on("secureConnection", () => state.connections++);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closing.push(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `https://127.0.0.1:${port}/v1/intake`, seen, state };
}

/** The API with a relay to `endpoints`, trusting the test certificate; returns its base URL and log. */
async function api(endpoints: readonly string[], options: Partial<ApiOptions> = {}) {
  const logs: unknown[] = [];
  const server: Server = createApiServer({
    sql: NO_SQL,
    log: (l) => logs.push(l),
    intake: { endpoints, ca: tls.cert, timeoutMs: 2_000 },
    corsOrigins: [ORIGIN],
    ...options,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closing.push(() => new Promise((r) => server.close(r)));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logs };
}

const deliver = (
  base: string,
  seat: number | string,
  body: Uint8Array = encodeDelivery(DELIVERY),
  headers: Record<string, string> = {},
) =>
  fetch(`${base}/v1/intake/seats/${seat}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", ...headers },
    body: Buffer.from(body),
  });

describe("relaying a delivery", () => {
  test("hands the seat's node the delivery and answers with its receipt", async () => {
    const one = await node();
    const two = await node();
    const { base } = await api([one.endpoint.url, two.endpoint.url]);
    const res = await deliver(base, 2, encodeDelivery(DELIVERY), { origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(RECEIPT);
    expect(two.given).toEqual([DELIVERY]);
    expect(one.given).toEqual([]);
  });

  test("answers a node's refusal with its code, as the node's own endpoint does", async () => {
    const n = await node(async () => ({ ok: false, code: "intake-closed" }));
    const { base } = await api([n.endpoint.url]);
    const res = await deliver(base, 1);
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("intake-closed");
  });

  test("passes any delivery within its bounds to the node byte for byte", async () => {
    const n = await rawNode((res) =>
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from(RECEIPT)),
    );
    const { base } = await api([n.url]);
    const field = fc.uint8Array({ maxLength: 48 });
    await fc.assert(
      fc.asyncProperty(field, field, field, field, async (stub, transcript, record, ciphertext) => {
        const body = encodeDelivery({ stub, transcript, record, ciphertext });
        const res = await deliver(base, 1, body);
        expect(res.status).toBe(200);
        expect(n.seen.at(-1)?.body).toEqual(body);
      }),
      { numRuns: Math.min(runs, 200) },
    );
  });

  test("sends the node nothing of the client's request but the body, on a connection of its own (T-11)", async () => {
    const n = await rawNode((res) =>
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from(RECEIPT)),
    );
    const { base } = await api([n.url]);
    const headers = {
      origin: ORIGIN,
      "x-forwarded-for": "198.51.100.7",
      forwarded: "for=198.51.100.7",
      "user-agent": "voter-browser/1.0",
      "accept-language": "fr",
      "x-request-id": "abc",
    };
    expect((await deliver(base, 1, encodeDelivery(DELIVERY), headers)).status).toBe(200);
    expect((await deliver(base, 1, encodeDelivery(DELIVERY), headers)).status).toBe(200);
    expect(n.state.connections).toBe(2);
    for (const { headers: h } of n.seen)
      expect(Object.keys(h).sort()).toEqual([
        "connection",
        "content-length",
        "content-type",
        "host",
      ]);
  });
});

describe("what the relay refuses", () => {
  test("a seat with no endpoint, a malformed seat or a query string is not found", async () => {
    const n = await node();
    const { base } = await api([n.endpoint.url]);
    for (const seat of ["2", "0", "01", "100", "1?x=1", "1/", "a"])
      expect((await deliver(base, seat)).status).toBe(404);
    expect(n.given).toEqual([]);
  });

  test("a body with no decoding, another type or past the bound, before any node is asked", async () => {
    const n = await node();
    const { base } = await api([n.endpoint.url]);
    const whole = encodeDelivery(DELIVERY);
    expect((await deliver(base, 1, whole.subarray(0, whole.length - 1))).status).toBe(400);
    expect((await deliver(base, 1, new Uint8Array([...whole, 0]))).status).toBe(400);
    const json = await fetch(`${base}/v1/intake/seats/1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(json.status).toBe(415);
    expect((await deliver(base, 1, new Uint8Array(MAX_DELIVERY + 1))).status).toBe(413);
    expect(n.given).toEqual([]);
  });

  test("an account credential, as every route does (T-10)", async () => {
    const n = await node();
    const { base } = await api([n.endpoint.url]);
    const res = await deliver(base, 1, encodeDelivery(DELIVERY), { authorization: "Bearer x" });
    expect(res.status).toBe(400);
    expect(n.given).toEqual([]);
  });

  test("everything with 503 on a server without a relay", async () => {
    const logs: unknown[] = [];
    const server = createApiServer({ sql: NO_SQL, log: (l) => logs.push(l) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closing.push(() => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await deliver(base, 1)).status).toBe(503);
  });
});

describe("a node that doesn't answer as one", () => {
  const cases: [string, (res: import("node:http").ServerResponse) => void, number, string?][] = [
    ["a failure", (res) => res.writeHead(500).end(), 502, "answer"],
    [
      "a receipt of another type",
      (res) => res.writeHead(200, { "content-type": "text/html" }).end("<p>"),
      502,
      "answer",
    ],
    [
      "a refusal that isn't a code",
      (res) => res.writeHead(422).end("<script>alert(1)</script>"),
      502,
      "answer",
    ],
    [
      "an answer past the bound",
      (res) =>
        res
          .writeHead(200, { "content-type": "application/octet-stream" })
          .end(Buffer.alloc(MAX_INTAKE_ANSWER + 1)),
      502,
      "answer",
    ],
    [
      "a redirect",
      (res) => res.writeHead(307, { location: "https://elsewhere/" }).end(),
      502,
      "answer",
    ],
    ["no answer in time", () => {}, 502, "timeout"],
    ["a busy queue", (res) => res.writeHead(503, { "retry-after": "5" }).end(), 503],
  ];
  for (const [name, handle, status, failure] of cases)
    test(`${name} is answered with ${status}`, async () => {
      const n = await rawNode(handle);
      const { base, logs } = await api([n.url], {
        intake: { endpoints: [n.url], ca: tls.cert, timeoutMs: 300 },
      });
      const res = await deliver(base, 1);
      expect(res.status).toBe(status);
      if (status === 503) expect(res.headers.get("retry-after")).toBe("1");
      expect(logs.filter((l) => "error" in (l as object))).toEqual(
        failure === undefined ? [] : [{ error: `intake-relay-${failure}` }],
      );
    });

  test("a node that offers only a classical group gets nothing (T-39)", async () => {
    const n = await rawNode(
      (res) => res.writeHead(200, { "content-type": "application/octet-stream" }).end("x"),
      "X25519:P-256",
    );
    const { base, logs } = await api([n.url]);
    expect((await deliver(base, 1)).status).toBe(502);
    expect(n.seen).toEqual([]);
    expect(logs).toContainEqual({ error: "intake-relay-unreachable" });
  });

  test("a certificate the relay doesn't trust gets nothing", async () => {
    const n = await rawNode((res) => res.writeHead(200).end());
    const logs: unknown[] = [];
    const server = createApiServer({
      sql: NO_SQL,
      log: (l) => logs.push(l),
      intake: { endpoints: [n.url] },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closing.push(() => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await deliver(base, 1)).status).toBe(502);
    expect(n.seen).toEqual([]);
  });

  test("a node that is down is answered with 502", async () => {
    const n = await rawNode(() => {});
    const url = n.url;
    await closing.pop()?.();
    const { base, logs } = await api([url]);
    expect((await deliver(base, 1)).status).toBe(502);
    expect(logs).toContainEqual({ error: "intake-relay-unreachable" });
  });
});

describe("the relay's slots and log", () => {
  test("past its slots a delivery is refused with 503, and a slot frees once the node answers (T-52)", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const n = await rawNode((res) => {
      void held.then(() =>
        res
          .writeHead(200, { "content-type": "application/octet-stream" })
          .end(Buffer.from(RECEIPT)),
      );
    });
    const { base } = await api([n.url], {
      intake: { endpoints: [n.url], ca: tls.cert, maxInFlight: 1 },
    });
    const first = deliver(base, 1);
    while (n.seen.length === 0) await new Promise((r) => setTimeout(r, 10));
    const second = await deliver(base, 1);
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("1");
    release();
    expect((await first).status).toBe(200);
    expect((await deliver(base, 1)).status).toBe(200);
  });

  test("a preflight from a listed origin allows POST and content-type only", async () => {
    const { base } = await api([(await node()).endpoint.url]);
    const ask = (origin: string, method = "POST", headers = "content-type") =>
      fetch(`${base}/v1/intake/seats/1`, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": method,
          "access-control-request-headers": headers,
        },
      });
    const ok = await ask(ORIGIN);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-methods")).toBe("POST");
    expect(ok.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    expect((await ask("https://elsewhere.example")).status).toBe(403);
    expect((await ask(ORIGIN, "GET")).status).toBe(403);
    expect((await ask(ORIGIN, "POST", "content-type,x-seat")).status).toBe(403);
  });

  test("the request log names the route's template, never the seat", async () => {
    const one = await node();
    const two = await node();
    const { base, logs } = await api([one.endpoint.url, two.endpoint.url]);
    await deliver(base, 2);
    await deliver(base, 1);
    await fetch(`${base}/v1/intake/seats/2`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });
    const routes = logs.map((l) => (l as { route: string }).route);
    expect(routes).toEqual([
      "POST /v1/intake/seats/{seat}",
      "POST /v1/intake/seats/{seat}",
      "OPTIONS /v1/intake/seats/{seat}",
    ]);
    for (const l of logs)
      expect(Object.keys(l as object).sort()).toEqual(["method", "ms", "route", "status"]);
  });
});

describe("the relay's endpoints", () => {
  test("are plain https URLs, one to sixteen of them", () => {
    expect(intakeEndpoints(["https://seat-1.example/v1/intake"]).map(String)).toEqual([
      "https://seat-1.example/v1/intake",
    ]);
    for (const bad of [
      [],
      Array.from({ length: MAX_INTAKE_SEATS + 1 }, (_, i) => `https://seat-${i}.example/v1/intake`),
      ["http://seat.example/v1/intake"],
      ["https://user:pw@seat.example/v1/intake"],
      ["https://seat.example/v1/intake?relay=1"],
      ["https://seat.example/v1/intake?"],
      ["https://seat.example/v1/intake#x"],
      ["seat.example/v1/intake"],
      [""],
    ])
      expect(() => intakeEndpoints(bad)).toThrow(RangeError);
    expect(() =>
      createApiServer({ sql: NO_SQL, log: () => {}, intake: { endpoints: ["http://x/"] } }),
    ).toThrow(RangeError);
    expect(() =>
      createApiServer({
        sql: NO_SQL,
        log: () => {},
        intake: { endpoints: ["https://x/"], maxInFlight: 0 },
      }),
    ).toThrow(RangeError);
  });
});
