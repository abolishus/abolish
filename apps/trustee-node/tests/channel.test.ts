// The summed-share channel (P2-13 part 5b-1): the endpoint acknowledges
// every message on arrival and hands it to the seat one at a time, bounding
// only what a message costs; `httpPeers` sends through it, over TLS 1.3 with
// the hybrid post-quantum group only. Last, three real tally duties open a
// cell talking over the channel alone.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { type AddressInfo, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTallyOpening, PARAMETERS } from "@abolishus/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  type Endpoint,
  httpPeers,
  MAX_SUMMED_SHARE,
  PeerError,
  type ReceiveSummedShare,
  serveSummedShares,
  TallyDuty,
} from "../src/index.ts";
import type { IntakeSecrets } from "../src/ceremony.ts";
import { cast, seatsOf, setup } from "./ballots.ts";
import { L2_CHAIN_ID, TRUSTEE_REGISTRY } from "./fixture.ts";

const MESSAGE = new Uint8Array(1406).fill(7);

/** A stand-in seat: records what it was given, and how many ran at once. */
function seat(answer: (m: Uint8Array) => Promise<void> = async () => undefined) {
  const given: Uint8Array[] = [];
  let running = 0;
  const state = { given, most: 0 };
  const receive: ReceiveSummedShare = async (m) => {
    given.push(m);
    running++;
    state.most = Math.max(state.most, running);
    try {
      await answer(m);
    } finally {
      running--;
    }
  };
  return { receive, state };
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

const until = async (done: () => boolean) => {
  while (!done()) await new Promise((r) => setTimeout(r, 5));
};

const open: Endpoint[] = [];
async function serve(receive: ReceiveSummedShare, queue = 4, log?: (e: unknown) => void) {
  const endpoint = await serveSummedShares(receive, {
    host: "127.0.0.1",
    port: 0,
    queue,
    ...(log === undefined ? {} : { log }),
  });
  open.push(endpoint);
  return endpoint;
}
afterAll(async () => {
  for (const e of open) await e.close();
});

describe("the summed-share bound", () => {
  it("is the spec's size of a version-2 message at MAX_OPTIONS", () => {
    // docs/spec/tally.md, Summed-share message, Size, with version 2's panel byte.
    const m = PARAMETERS.MAX_OPTIONS;
    expect(MAX_SUMMED_SHARE).toBe(
      3 + 32 + 1 + 32 + 1 + 1 + 1088 + 32 + 4 + (4 + 64 * m + 16) + 64 + 1,
    );
  });
});

describe("the summed-share endpoint", () => {
  it("acknowledges a message with 202 and hands the seat its exact bytes", async () => {
    const s = seat();
    const { url } = await serve(s.receive);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/summed-shares$/);
    const res = await post(url, MESSAGE);
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // No origin may read the answer: only nodes post here.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await res.arrayBuffer()).toHaveProperty("byteLength", 0);
    await until(() => s.state.given.length === 1);
    expect(s.state.given).toEqual([MESSAGE]);
  });

  it("answers before the seat has checked the message, whatever it makes of it (T-39)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const logged: unknown[] = [];
    const s = seat(async () => {
      await gate;
      throw new TypeError(`secret ${"ab".repeat(8)}`);
    });
    const { url } = await serve(s.receive, 4, (e) => logged.push(e));
    // The seat hasn't finished, yet the sender has its answer.
    expect((await post(url, MESSAGE)).status).toBe(202);
    await until(() => s.state.given.length === 1);
    release();
    await until(() => logged.length === 1);
    // A seat that throws is logged by the error's name only.
    expect(logged).toEqual([{ event: "summed-share-error", error: "TypeError" }]);
    expect((await post(url, MESSAGE)).status).toBe(202);
  });

  it("refuses other paths, methods and types without asking the seat", async () => {
    const s = seat();
    const { url } = await serve(s.receive);
    expect((await post(url.replace("/v1/summed-shares", "/v1/intake"), MESSAGE)).status).toBe(404);
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: "OPTIONS" })).status).toBe(405);
    expect((await post(url, MESSAGE, { "content-type": "text/plain" })).status).toBe(415);
    expect(s.state.given).toEqual([]);
  });

  it("refuses a body past its bound, declared or streamed, without asking the seat (T-52)", async () => {
    const s = seat();
    const { url } = await serve(s.receive);
    expect(await raw(url, { "content-length": String(MAX_SUMMED_SHARE + 1) }, [])).toBe(413);
    const chunk = new Uint8Array(1024);
    const chunks = Array.from({ length: Math.ceil(MAX_SUMMED_SHARE / 1024) + 1 }, () => chunk);
    expect(await raw(url, { "transfer-encoding": "chunked" }, chunks)).toBe(413);
    // A body of exactly the bound is taken.
    expect((await post(url, new Uint8Array(MAX_SUMMED_SHARE))).status).toBe(202);
    await until(() => s.state.given.length === 1);
    expect(s.state.given[0]).toHaveLength(MAX_SUMMED_SHARE);
  });

  it("checks one message at a time, and answers 503 past its queue (T-52)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = seat(() => gate);
    const { url, server } = await serve(s.receive, 2);
    expect(server.maxConnections).toBe(8);
    // Both are held, acknowledged, until the seat has checked them.
    expect((await post(url, MESSAGE)).status).toBe(202);
    expect((await post(url, MESSAGE)).status).toBe(202);
    const busy = await post(url, MESSAGE);
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("5");
    release();
    await until(() => s.state.given.length === 2);
    expect(s.state.most).toBe(1);
    // The queue frees as messages are checked.
    await new Promise((r) => setTimeout(r, 20));
    expect((await post(url, MESSAGE)).status).toBe(202);
  });

  it("frees the place of an upload its peer abandons, logging nothing", async () => {
    const logged: unknown[] = [];
    const s = seat();
    const { url } = await serve(s.receive, 1, (e) => logged.push(e));
    const req = httpRequest(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": "100" },
    });
    req.on("error", () => undefined);
    req.write(new Uint8Array(10));
    await new Promise((r) => setTimeout(r, 50));
    req.destroy();
    // The place frees once the endpoint has seen the upload end.
    let status = 503;
    while (status === 503) status = (await post(url, MESSAGE)).status;
    expect(status).toBe(202);
    await until(() => s.state.given.length === 1);
    expect(logged).toEqual([]);
  });

  it("refuses plain HTTP off loopback and an empty queue", async () => {
    const s = seat();
    await expect(
      serveSummedShares(s.receive, { host: "0.0.0.0", port: 0, queue: 1 }),
    ).rejects.toThrow(RangeError);
    await expect(
      serveSummedShares(s.receive, { host: "127.0.0.1", port: 0, queue: 0 }),
    ).rejects.toThrow(RangeError);
  });
});

describe("httpPeers", () => {
  it("sends to the recipient's endpoint and resolves on its acknowledgement", async () => {
    const s = seat();
    const { url } = await serve(s.receive);
    const peers = httpPeers({ peers: new Map([[2, url]]), timeoutMs: 5000 });
    await peers.send(2, MESSAGE);
    await until(() => s.state.given.length === 1);
    expect(s.state.given).toEqual([MESSAGE]);
  });

  it("throws PeerError for a seat it has no endpoint for, any other answer, or none", async () => {
    const s = seat();
    const { url } = await serve(s.receive);
    const closed = await serve(s.receive);
    await closed.close();
    const peers = httpPeers({
      peers: new Map([
        [2, url.replace("/v1/summed-shares", "/v1/other")],
        [3, closed.url],
      ]),
      timeoutMs: 5000,
    });
    await expect(peers.send(4, MESSAGE)).rejects.toThrow(new PeerError("no endpoint for seat 4"));
    await expect(peers.send(2, MESSAGE)).rejects.toThrow(new PeerError("seat 2 answered 404"));
    // The error's code only, never the peer's address.
    await expect(peers.send(3, MESSAGE)).rejects.toThrow(new PeerError("seat 3: ECONNREFUSED"));
    expect(s.state.given).toEqual([]);
  });

  it("gives up on a peer that doesn't answer in time", async () => {
    // Takes the connection and never answers.
    const sockets: Socket[] = [];
    const silent = createNetServer((socket) => void sockets.push(socket));
    silent.listen(0, "127.0.0.1");
    await new Promise((r) => silent.once("listening", r));
    const { port } = silent.address() as AddressInfo;
    const peers = httpPeers({
      peers: new Map([[2, `http://127.0.0.1:${port}/v1/summed-shares`]]),
      timeoutMs: 100,
    });
    await expect(peers.send(2, MESSAGE)).rejects.toThrow(new PeerError("seat 2: timed out"));
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => silent.close(r));
  });

  it("refuses an endpoint that isn't https, unless on loopback, and a timeout under 1 ms", () => {
    for (const url of ["http://10.0.0.2/v1/summed-shares", "ftp://127.0.0.1/"])
      expect(() => httpPeers({ peers: new Map([[2, url]]), timeoutMs: 5000 })).toThrow(RangeError);
    for (const url of ["http://127.0.0.1:1/v1/summed-shares", "http://[::1]:1/v1/summed-shares"])
      expect(() => httpPeers({ peers: new Map([[2, url]]), timeoutMs: 5000 })).not.toThrow();
    expect(() => httpPeers({ peers: new Map(), timeoutMs: 0 })).toThrow(RangeError);
  });
});

describe("the summed-share channel over TLS", () => {
  let dir: string;
  let cert: string;
  let key: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "trustee-node-channel-"));
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

  it("sends over the hybrid post-quantum group to a peer whose certificate chains to the CA (T-39)", async () => {
    const s = seat();
    const endpoint = await serveSummedShares(s.receive, {
      host: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      queue: 1,
    });
    open.push(endpoint);
    expect(endpoint.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/v1\/summed-shares$/);
    await httpPeers({ peers: new Map([[2, endpoint.url]]), ca: cert, timeoutMs: 5000 }).send(
      2,
      MESSAGE,
    );
    await until(() => s.state.given.length === 1);
    // Without the CA, the self-signed peer isn't trusted.
    await expect(
      httpPeers({ peers: new Map([[2, endpoint.url]]), timeoutMs: 5000 }).send(2, MESSAGE),
    ).rejects.toThrow(PeerError);
  });

  it("refuses a peer that offers only a classical group, and the endpoint refuses such a sender", async () => {
    const classical = createHttpsServer(
      { cert, key, ecdhCurve: "X25519:P-256" },
      (_req, res) => void res.writeHead(202).end(),
    );
    classical.listen(0, "127.0.0.1");
    await new Promise((r) => classical.once("listening", r));
    const port = (classical.address() as { port: number }).port;
    await expect(
      httpPeers({
        peers: new Map([[2, `https://127.0.0.1:${port}/v1/summed-shares`]]),
        ca: cert,
        timeoutMs: 5000,
      }).send(2, MESSAGE),
    ).rejects.toThrow(PeerError);
    classical.close();

    const endpoint = await serveSummedShares(seat().receive, {
      host: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      queue: 1,
    });
    open.push(endpoint);
    const status = (ecdhCurve: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpsRequest(
          endpoint.url,
          {
            method: "POST",
            ca: cert,
            ecdhCurve,
            headers: { "content-type": "application/octet-stream" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(MESSAGE);
      });
    expect(await status("X25519MLKEM768:X25519")).toBe(202);
    await expect(status("X25519:P-256")).rejects.toThrow();
  });
});

describe("three tally duties over the channel", () => {
  it("open the cell with nothing between them but their endpoints", async () => {
    const s = await setup();
    const ballots = [await cast(s, 0, 0), await cast(s, 1, 1), await cast(s, 2, 0)];
    for (const b of ballots)
      for (const [i, intake] of seatsOf(s).intake.entries()) {
        const taken = await intake.intake(
          s.e.stubBytes,
          s.transcript,
          b.bytes,
          b.ciphertexts[i] as Uint8Array,
        );
        if (!taken.ok) throw new Error(`intake refused an honest ballot: ${taken.code}`);
      }
    const duties: TallyDuty[] = [];
    const endpoints = await Promise.all(
      s.e.seats.map((_, i) => serve((m) => (duties[i] as TallyDuty).receive(m))),
    );
    for (const [i, seat] of s.e.seats.entries()) {
      const election = await seat.approvedElection(s.e.stubHash);
      const secrets = await seat.intakeSecrets(s.e.stubHash);
      if (election === undefined || secrets === undefined) throw new Error("no approval");
      duties.push(
        new TallyDuty({
          panel: s.e.panelists.panel,
          l2ChainId: L2_CHAIN_ID,
          trusteeRegistry: TRUSTEE_REGISTRY,
          election,
          secrets: secrets as IntakeSecrets,
          definition: s.definition,
          transcript: s.transcript,
          store: s.stores[i]!,
          counted: async () => ({ state: "fixed", cells: [ballots.map((b) => b.bytes)] }),
          peers: httpPeers({
            peers: new Map(endpoints.map((e, j) => [j + 1, e.url])),
            timeoutMs: 5000,
          }),
        }),
      );
    }
    // Every seat fixes its set first, so no message arrives before it can be kept.
    for (const duty of duties) await duty.step();
    // Messages are checked after they are acknowledged, so the seats step
    // until `k` of them have opened; a seat that opened stops sending, so
    // the last may never hold another's sums (Known-weak, part 5a).
    const opened = async () => {
      const out: Uint8Array[] = [];
      for (const duty of duties) {
        const opening = (await duty.openings()).get(0);
        if (opening !== undefined) out.push(opening);
      }
      return out;
    };
    for (let round = 0; round < 50 && (await opened()).length < 2; round++) {
      await Promise.all(duties.map((d) => d.step()));
      await new Promise((r) => setTimeout(r, 20));
    }
    const openings = await opened();
    expect(openings.length).toBeGreaterThanOrEqual(2);
    for (const opening of openings)
      expect(decodeTallyOpening(opening, 1).opening.map((o) => o.v)).toEqual([2n, 1n]);
  }, 120_000);
});
