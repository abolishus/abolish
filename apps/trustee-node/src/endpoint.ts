// The seat's intake endpoint (README, Intake endpoint). Clients deliver to it
// directly, through a network anonymiser, when the operator's route fails
// (docs/spec/delivery.md, Client rules 4; T-11), and the operator's relay
// delivers through it too. Every
// delivery goes through `IntakeSeat`, so nothing a request carries is
// trusted; the endpoint only bounds what one costs: the body, the deliveries
// held at once, and the time a peer may take to send one (T-39, T-52). The
// body is this transport's envelope, not protocol bytes, around the spec's
// own records. With `sealed`, it also serves the sealed route a relay
// carries clients' deliveries to (docs/spec/sealed-delivery.md, The node's
// route): the same intake behind the seat's KEM key, under the same bounds.
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Server } from "node:net";
import {
  bytesVar,
  decode,
  DecodeError,
  decodeSealedDelivery,
  type DeliveryAnswer,
  encode,
  MAX_SEALED_REQUEST,
  openSealedDelivery,
  sealAnswer,
  type SealedDelivery,
  struct,
} from "@abolishus/crypto";
import type { IntakeOutcome } from "./intake.ts";
import type { SealedKeys } from "./sealed-intake.ts";
import { MAX_RECORD } from "./wire.ts";

const DELIVERY = struct([
  ["stub", bytesVar(MAX_RECORD)],
  ["transcript", bytesVar(MAX_RECORD)],
  ["record", bytesVar(MAX_RECORD)],
  ["ciphertext", bytesVar(MAX_RECORD)],
] as const);

/** One delivery: the election (its stub and approved transcript), the whole ballot record and the seat's `ct_i`. */
export interface Delivery {
  readonly stub: Uint8Array;
  readonly transcript: Uint8Array;
  readonly record: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/** Bound on a delivery's body: four `bytes<2^20>`, each with its `u32` length. */
export const MAX_DELIVERY = 4 * (4 + MAX_RECORD);

export const encodeDelivery = (delivery: Delivery) => encode(DELIVERY, delivery);
/** Throws `DecodeError` on a body with no decoding. */
export const decodeDelivery = (bytes: Uint8Array): Delivery => decode(DELIVERY, bytes);

/** What the endpoint serves: `IntakeSeat`, or a stand-in in tests. */
export interface Intake {
  intake(
    stub: Uint8Array,
    transcript: Uint8Array,
    record: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<IntakeOutcome>;
}

export interface EndpointOptions {
  readonly host: string;
  /** 0 picks a free port. */
  readonly port: number;
  /**
   * The certificate chain and key, PEM. Without them the endpoint takes
   * plain HTTP and only on a loopback address, for a TLS proxy on the same
   * host that holds to the same key exchange.
   */
  readonly tls?: { readonly cert: string; readonly key: string };
  /** Deliveries held at once, being read, waiting or checked; past it the endpoint answers 503. */
  readonly queue: number;
  /** The seat's KEM keys: with them the endpoint serves `POST /v1/sealed-intake` too. */
  readonly sealed?: SealedKeys;
  /** One line per failure, never a body, a ballot or an address. */
  readonly log?: (event: { readonly event: "intake-error"; readonly error: string }) => void;
}

export interface Endpoint {
  readonly url: string;
  /** The sealed route's URL, when the endpoint serves it. */
  readonly sealedUrl?: string;
  readonly server: Server;
  close(): Promise<void>;
}

/** Only the hybrid post-quantum group: ADR 0002 has every intake endpoint negotiate it (T-39). */
export const INTAKE_GROUPS = "X25519MLKEM768";
/** Seconds a client is told to wait when the queue is full. */
export const BUSY_RETRY_SECONDS = 5;
/** Open connections allowed for each queue place. */
export const CONNECTIONS_PER_PLACE = 4;
const HEADERS_MS = 10_000;
const REQUEST_MS = 30_000;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const ROUTE = "/v1/intake";
const SEALED_ROUTE = "/v1/sealed-intake";

// The delivery carries no credential and the receipt is public, so any
// origin may post; nothing is sent with cookies or read back but the answer.
const CORS = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
} as const;
// The sealed route's only peers are relays: no browser origin (T-43).
const NO_STORE = { "cache-control": "no-store" } as const;
// RFC 9458 §9's media types, the ones a relay forwards.
const SEALED_REQUEST_TYPE = "message/ohttp-req";
const SEALED_ANSWER_TYPE = "message/ohttp-res";

/**
 * Serves `intake` at `POST /v1/intake`. The body is a `Delivery` as
 * `application/octet-stream`; a share receipt record (`0x000c`) comes back
 * with 200, a refusal's code as text with 422. With `sealed`, also at
 * `POST /v1/sealed-intake`: a sealed delivery (`0x0027`) as
 * `message/ohttp-req`, and a sealed answer (`0x0028`) back with 200.
 */
export async function serveIntake(intake: Intake, options: EndpointOptions): Promise<Endpoint> {
  if (!Number.isSafeInteger(options.queue) || options.queue < 1)
    throw new RangeError("intake endpoint: the queue must hold at least one delivery");
  if (options.tls === undefined && !LOOPBACK.has(options.host))
    throw new RangeError("intake endpoint: plain HTTP only on a loopback address");
  let held = 0;
  // `intakeBallot` is synchronous work, so deliveries are checked one after
  // another, from either route; the queue bounds how many wait.
  let chain: Promise<unknown> = Promise.resolve();
  const check = (d: Delivery): Promise<IntakeOutcome> => {
    const run = () => intake.intake(d.stub, d.transcript, d.record, d.ciphertext);
    const outcome = chain.then(run, run);
    chain = outcome.catch(() => undefined);
    return outcome;
  };
  // A rejection need not be an Error; a log line must never throw past an
  // opened request's sealed answer (T-13).
  const log = (e: unknown) =>
    options.log?.({ event: "intake-error", error: e instanceof Error ? e.name : "unknown" });
  // The route's bounds, shared by both routes (T-52): the declared length
  // and the bodies held at once, before any of the body is read. Then the
  // body, or undefined once it has answered.
  const admit = async (
    req: IncomingMessage,
    res: ServerResponse,
    base: Headers,
    max: number,
    serve: (body: Uint8Array) => Promise<void>,
  ) => {
    const length = Number(req.headers["content-length"] ?? Number.NaN);
    if (length > max) return end(res, 413, base);
    if (held >= options.queue)
      return end(res, 503, { ...base, "retry-after": String(BUSY_RETRY_SECONDS) });
    held++;
    try {
      let body;
      try {
        body = await readBody(req, max);
      } catch {
        // The peer went away or timed out mid-body: nothing to answer and
        // nothing worth a log line, which anyone could flood.
        return void res.destroy();
      }
      if (body === undefined) return end(res, 413, base);
      await serve(body);
    } catch (e) {
      log(e);
      end(res, 500, base);
    } finally {
      held--;
    }
  };
  const plain = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS")
      return end(res, 204, {
        ...CORS,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      });
    if (req.method !== "POST") return end(res, 405, { ...CORS, allow: "POST, OPTIONS" });
    if (req.headers["content-type"] !== "application/octet-stream") return end(res, 415, CORS);
    void admit(req, res, CORS, MAX_DELIVERY, async (body) => {
      let delivery: Delivery;
      try {
        delivery = decodeDelivery(body);
      } catch (e) {
        if (e instanceof DecodeError) return end(res, 400, CORS);
        throw e;
      }
      const out = await check(delivery);
      if (out.ok)
        return end(res, 200, { ...CORS, "content-type": "application/octet-stream" }, out.receipt);
      return end(
        res,
        422,
        { ...CORS, "content-type": "text/plain; charset=utf-8" },
        new TextEncoder().encode(out.code),
      );
    });
  };
  const sealed = (req: IncomingMessage, res: ServerResponse, keys: SealedKeys) => {
    if (req.method !== "POST") return end(res, 405, { ...NO_STORE, allow: "POST" });
    if (req.headers["content-type"] !== SEALED_REQUEST_TYPE) return end(res, 415, NO_STORE);
    void admit(req, res, NO_STORE, MAX_SEALED_REQUEST, async (body) => {
      try {
        await answerSealed(res, keys, body);
      } finally {
        // Retention: the request is kept only until it is answered (T-15).
        body.fill(0);
      }
    });
  };
  // The request check, then intake on the envelope, then the answer sealed
  // under the request's key (docs/spec/sealed-delivery.md, Request check).
  const answerSealed = async (res: ServerResponse, keys: SealedKeys, body: Uint8Array) => {
    let request: SealedDelivery;
    try {
      request = decodeSealedDelivery(body, 1);
    } catch (e) {
      // `sealed-malformed`.
      if (e instanceof DecodeError) return end(res, 400, NO_STORE);
      throw e;
    }
    const opened = await keys.withHolder(request.kem_key_hash, (holder) =>
      openSealedDelivery([holder], body),
    );
    // `sealed-key` (no holder) and every failure before the request opened
    // get the same answer and no body: whether it opened is all the sender
    // learns (T-39).
    if (opened === undefined || (!opened.ok && opened.code !== "sealed-envelope"))
      return end(res, 400, NO_STORE);
    let answer: DeliveryAnswer;
    try {
      if (!opened.ok) answer = { outcome: "refused", code: "sealed-envelope" };
      else {
        const { envelope } = opened;
        try {
          const out = await check(envelope);
          answer = out.ok
            ? { outcome: "receipt", receipt: out.receipt }
            : { outcome: "refused", code: out.code };
        } catch (e) {
          // Past the opening every outcome is a sealed 200, so the relay
          // can't tell a request that reached intake from one that didn't
          // (T-13).
          log(e);
          answer = { outcome: "busy" };
        } finally {
          // The plaintext only until the answer; intake keeps its own copy
          // of what it holds (Retention; T-15).
          envelope.record.fill(0);
          envelope.ciphertext.fill(0);
        }
      }
      let sealedAnswer: Uint8Array;
      try {
        sealedAnswer = sealAnswer(opened.opened, answer);
      } catch (e) {
        // A refusal code an answer can't carry: busy, as any error after
        // the request opened is.
        log(e);
        sealedAnswer = sealAnswer(opened.opened, { outcome: "busy" });
      }
      return end(res, 200, { ...NO_STORE, "content-type": SEALED_ANSWER_TYPE }, sealedAnswer);
    } finally {
      opened.opened.key.fill(0);
    }
  };
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === ROUTE) return plain(req, res);
    if (path === SEALED_ROUTE && options.sealed !== undefined)
      return sealed(req, res, options.sealed);
    return end(res, 404, CORS);
  };
  const timeouts = {
    headersTimeout: HEADERS_MS,
    requestTimeout: REQUEST_MS,
    // Node enforces both timeouts only at this interval (30 s by default).
    connectionsCheckingInterval: 1000,
    maxHeaderSize: 8192,
  };
  const server =
    options.tls === undefined
      ? createHttpServer(timeouts, handle)
      : createHttpsServer(
          {
            ...timeouts,
            cert: options.tls.cert,
            key: options.tls.key,
            minVersion: "TLSv1.3",
            ecdhCurve: INTAKE_GROUPS,
          },
          handle,
        );
  // Connections still sending headers hold no queue place, so they are
  // bounded apart, before they exhaust the host's descriptors.
  server.maxConnections = CONNECTIONS_PER_PLACE * options.queue;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { address, port } = server.address() as AddressInfo;
  const host = address.includes(":") ? `[${address}]` : address;
  const origin = `${options.tls === undefined ? "http" : "https"}://${host}:${port}`;
  return {
    url: `${origin}${ROUTE}`,
    ...(options.sealed === undefined ? {} : { sealedUrl: `${origin}${SEALED_ROUTE}` }),
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

type Headers = Readonly<Record<string, string>>;

function end(res: ServerResponse, status: number, headers: Headers, body?: Uint8Array): void {
  if (res.headersSent) return;
  // A refused request's body is never read, so the connection can't be reused.
  const close = status === 413 || status === 503 || status === 415 ? { connection: "close" } : {};
  res.writeHead(status, { ...close, ...headers }).end(body);
}

/** The body, or undefined once it passes `max`. */
async function readBody(req: IncomingMessage, max: number): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > max) return undefined;
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
