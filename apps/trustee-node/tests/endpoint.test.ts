import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecodeError } from "@abolishus/crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  decodeDelivery,
  type Delivery,
  encodeDelivery,
  type Endpoint,
  type Intake,
  type IntakeOutcome,
  MAX_DELIVERY,
  serveIntake,
} from "../src/index.ts";
import { MAX_RECORD } from "../src/wire.ts";

const runs = Number(process.env.FC_NUM_RUNS ?? 100);
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);
const delivery: Delivery = {
  stub: bytes(3, 1),
  transcript: bytes(4, 2),
  record: bytes(5, 3),
  ciphertext: bytes(6, 4),
};
const RECEIPT = bytes(10, 9);

/** A stand-in seat: answers what `answer` says and records what it was given, and how many ran at once. */
function seat(
  answer: (d: Delivery) => Promise<IntakeOutcome> = async () => ({
    ok: true,
    ballotHash: bytes(32),
    receipt: RECEIPT,
  }),
) {
  const given: Delivery[] = [];
  let running = 0;
  const state = { given, most: 0 };
  const intake: Intake = {
    async intake(stub, transcript, record, ciphertext) {
      const d = { stub, transcript, record, ciphertext };
      given.push(d);
      running++;
      state.most = Math.max(state.most, running);
      try {
        return await answer(d);
      } finally {
        running--;
      }
    },
  };
  return { intake, state };
}

const post = (url: string, body: Uint8Array, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", ...headers },
    body: Buffer.from(body),
  });

/** A POST over `node:http`, writing `chunks` until the endpoint answers; resolves to its status. */
const raw = (url: string, headers: Record<string, string>, chunks: readonly Uint8Array[]) =>
  new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: "POST", headers: { "content-type": "application/octet-stream", ...headers } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    let answered = false;
    req.on("response", () => (answered = true));
    req.on("error", (e) => (answered ? undefined : reject(e)));
    void (async () => {
      for (const c of chunks) {
        if (answered || req.destroyed) return;
        if (!req.write(c)) await new Promise((r) => req.once("drain", r));
      }
      if (!answered) req.end();
    })();
    if (chunks.length === 0) req.flushHeaders();
  });

const open: Endpoint[] = [];
async function serve(intake: Intake, queue = 4): Promise<Endpoint> {
  const endpoint = await serveIntake(intake, { host: "127.0.0.1", port: 0, queue });
  open.push(endpoint);
  return endpoint;
}
afterAll(async () => {
  for (const e of open) await e.close();
});

describe("the delivery envelope", () => {
  it("round-trips any delivery within its bounds, and refuses every truncation", () => {
    const field = fc.uint8Array({ maxLength: 64 });
    fc.assert(
      fc.property(field, field, field, field, (stub, transcript, record, ciphertext) => {
        const d = { stub, transcript, record, ciphertext };
        const encoded = encodeDelivery(d);
        expect(decodeDelivery(encoded)).toEqual(d);
        for (let cut = 0; cut < encoded.length; cut += 7)
          expect(() => decodeDelivery(encoded.subarray(0, cut))).toThrow(DecodeError);
        expect(() => decodeDelivery(new Uint8Array([...encoded, 0]))).toThrow(DecodeError);
      }),
      { numRuns: runs },
    );
  });

  it("bounds the body at four records with their lengths", () => {
    const full = {
      stub: bytes(MAX_RECORD),
      transcript: bytes(MAX_RECORD),
      record: bytes(MAX_RECORD),
      ciphertext: bytes(MAX_RECORD),
    };
    expect(encodeDelivery(full).length).toBe(MAX_DELIVERY);
  });
});

describe("the intake endpoint", () => {
  it("hands the seat the delivery and returns its receipt", async () => {
    const s = seat();
    const { url } = await serve(s.intake);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/intake$/);
    const res = await post(url, encodeDelivery(delivery));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(RECEIPT);
    expect(s.state.given).toEqual([delivery]);
  });

  it("answers a refusal with its code, and the member limit with 429", async () => {
    const codes: IntakeOutcome[] = [
      { ok: false, code: "membership-proof" },
      { ok: false, code: "intake-closed" },
      { ok: false, code: "intake-rate" },
    ];
    const s = seat(async () => codes.shift() as IntakeOutcome);
    const { url } = await serve(s.intake);
    for (const [status, code] of [
      [422, "membership-proof"],
      [422, "intake-closed"],
      [429, "intake-rate"],
    ] as const) {
      const res = await post(url, encodeDelivery(delivery));
      expect(res.status).toBe(status);
      expect(await res.text()).toBe(code);
    }
  });

  it("answers a browser's preflight, and refuses other paths, methods and types without asking the seat", async () => {
    const s = seat();
    const { url } = await serve(s.intake);
    const pre = await fetch(url, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toBe("POST");
    expect(pre.headers.get("access-control-allow-headers")).toBe("content-type");
    expect((await fetch(url.replace("/v1/intake", "/v1/other"), { method: "POST" })).status).toBe(
      404,
    );
    expect((await fetch(url)).status).toBe(405);
    const text = await post(url, encodeDelivery(delivery), { "content-type": "text/plain" });
    expect(text.status).toBe(415);
    expect((await post(url, new Uint8Array([1, 2, 3]))).status).toBe(400);
    expect(s.state.given).toEqual([]);
  });

  it("refuses a body past its bound, declared or streamed, without asking the seat (T-52)", async () => {
    const s = seat();
    const { url } = await serve(s.intake);
    // Declared too long: answered before any of the body is read.
    expect(await raw(url, { "content-length": String(MAX_DELIVERY + 1) }, [])).toBe(413);
    // Streamed with no length: answered once it passes the bound.
    const chunk = new Uint8Array(1 << 16);
    const chunks = Array.from({ length: Math.ceil(MAX_DELIVERY / chunk.length) + 1 }, () => chunk);
    expect(await raw(url, { "transfer-encoding": "chunked" }, chunks)).toBe(413);
    expect(s.state.given).toEqual([]);
  });

  it("checks one delivery at a time, and answers 503 past its queue without reading the body (T-39)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = seat(async () => {
      await gate;
      return { ok: true, ballotHash: bytes(32), receipt: RECEIPT };
    });
    const { url } = await serve(s.intake, 2);
    const first = post(url, encodeDelivery(delivery));
    const second = post(url, encodeDelivery(delivery));
    // Both are held once the first has reached the seat.
    while (s.state.given.length < 1) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));
    const busy = await post(url, encodeDelivery(delivery));
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("5");
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(s.state.most).toBe(1);
    // The queue frees as deliveries finish.
    expect((await post(url, encodeDelivery(delivery))).status).toBe(200);
  });

  it("answers 500 when the seat throws, logging only the error's name", async () => {
    const logged: unknown[] = [];
    const endpoint = await serveIntake(
      {
        intake: () => Promise.reject(new TypeError(`secret ${"ab".repeat(8)}`)),
      },
      { host: "127.0.0.1", port: 0, queue: 1, log: (e) => logged.push(e) },
    );
    open.push(endpoint);
    expect((await post(endpoint.url, encodeDelivery(delivery))).status).toBe(500);
    expect(logged).toEqual([{ event: "intake-error", error: "TypeError" }]);
    // A failure doesn't stop the next delivery.
    expect((await post(endpoint.url, encodeDelivery(delivery))).status).toBe(500);
  });

  it("refuses plain HTTP off loopback and an empty queue", async () => {
    const s = seat();
    await expect(serveIntake(s.intake, { host: "0.0.0.0", port: 0, queue: 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(serveIntake(s.intake, { host: "127.0.0.1", port: 0, queue: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("the intake endpoint over TLS", () => {
  let dir: string;
  let endpoint: Endpoint;
  let cert: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "trustee-node-tls-"));
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
    endpoint = await serveIntake(seat().intake, {
      host: "127.0.0.1",
      port: 0,
      tls: { cert, key: await readFile(keyFile, "utf8") },
      queue: 1,
    });
  });
  afterAll(async () => {
    await endpoint.close();
    await rm(dir, { recursive: true, force: true });
  });

  const deliver = (tls: { ecdhCurve?: string; maxVersion?: "TLSv1.2" | "TLSv1.3" }) =>
    new Promise<number>((resolve, reject) => {
      const body = encodeDelivery(delivery);
      const req = httpsRequest(
        endpoint.url,
        {
          method: "POST",
          ca: cert,
          headers: { "content-type": "application/octet-stream", "content-length": body.length },
          ...tls,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(body);
    });

  it("serves a client that negotiates the hybrid post-quantum group (T-39)", async () => {
    expect(endpoint.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/v1\/intake$/);
    expect(await deliver({ ecdhCurve: "X25519MLKEM768:X25519" })).toBe(200);
  });

  it("refuses a client that offers only a classical group, or only TLS 1.2", async () => {
    await expect(deliver({ ecdhCurve: "X25519:P-256" })).rejects.toThrow();
    await expect(deliver({ maxVersion: "TLSv1.2" })).rejects.toThrow();
  });
});
