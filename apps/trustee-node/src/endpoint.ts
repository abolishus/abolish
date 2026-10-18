// The seat's intake endpoint (README, Intake endpoint). Clients deliver to it
// directly, through a network anonymiser, when the operator's route fails
// (docs/spec/delivery.md, Client rules 4; T-11), and the operator's relay
// delivers through it too. Every
// delivery goes through `IntakeSeat`, so nothing a request carries is
// trusted; the endpoint only bounds what one costs: the body, the deliveries
// held at once, and the time a peer may take to send one (T-39, T-52). The
// body is this transport's envelope, not protocol bytes, around the spec's
// own records.
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Server } from "node:net";
import { bytesVar, decode, DecodeError, encode, struct } from "@abolishus/crypto";
import type { IntakeOutcome } from "./intake.ts";
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
  /** One line per failure, never a body, a ballot or an address. */
  readonly log?: (event: { readonly event: "intake-error"; readonly error: string }) => void;
}

export interface Endpoint {
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

/** Only the hybrid post-quantum group: ADR 0002 has every intake endpoint negotiate it (T-39). */
export const INTAKE_GROUPS = "X25519MLKEM768";
/** Seconds a client is told to wait when the queue is full. */
export const BUSY_RETRY_SECONDS = 5;
const HEADERS_MS = 10_000;
const REQUEST_MS = 30_000;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const ROUTE = "/v1/intake";

// The delivery carries no credential and the receipt is public, so any
// origin may post; nothing is sent with cookies or read back but the answer.
const CORS = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
} as const;

/**
 * Serves `intake` at `POST /v1/intake`. The body is a `Delivery` as
 * `application/octet-stream`; a share receipt record (`0x000b`) comes back
 * with 200, a refusal's code as text with 422 (429 for `intake-rate`).
 */
export async function serveIntake(intake: Intake, options: EndpointOptions): Promise<Endpoint> {
  if (!Number.isSafeInteger(options.queue) || options.queue < 1)
    throw new RangeError("intake endpoint: the queue must hold at least one delivery");
  if (options.tls === undefined && !LOOPBACK.has(options.host))
    throw new RangeError("intake endpoint: plain HTTP only on a loopback address");
  let held = 0;
  // `intakeBallot` is synchronous work, so deliveries are checked one after
  // another; the queue bounds how many wait.
  let chain: Promise<unknown> = Promise.resolve();
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== ROUTE) return end(res, 404);
    if (req.method === "OPTIONS")
      return end(res, 204, {
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      });
    if (req.method !== "POST") return end(res, 405, { allow: "POST, OPTIONS" });
    if (req.headers["content-type"] !== "application/octet-stream") return end(res, 415);
    const length = Number(req.headers["content-length"] ?? Number.NaN);
    if (length > MAX_DELIVERY) return end(res, 413);
    if (held >= options.queue) return end(res, 503, { "retry-after": String(BUSY_RETRY_SECONDS) });
    held++;
    void (async () => {
      try {
        const body = await readBody(req);
        if (body === undefined) return end(res, 413);
        let delivery: Delivery;
        try {
          delivery = decodeDelivery(body);
        } catch (e) {
          if (e instanceof DecodeError) return end(res, 400);
          throw e;
        }
        const run = () =>
          intake.intake(delivery.stub, delivery.transcript, delivery.record, delivery.ciphertext);
        const outcome = chain.then(run, run);
        chain = outcome.catch(() => undefined);
        const out = await outcome;
        if (out.ok)
          return end(res, 200, { "content-type": "application/octet-stream" }, out.receipt);
        return end(
          res,
          out.code === "intake-rate" ? 429 : 422,
          { "content-type": "text/plain; charset=utf-8" },
          new TextEncoder().encode(out.code),
        );
      } catch (e) {
        options.log?.({ event: "intake-error", error: (e as Error).name });
        end(res, 500);
      } finally {
        held--;
      }
    })();
  };
  const timeouts = { headersTimeout: HEADERS_MS, requestTimeout: REQUEST_MS, maxHeaderSize: 8192 };
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { address, port } = server.address() as AddressInfo;
  const host = address.includes(":") ? `[${address}]` : address;
  return {
    url: `${options.tls === undefined ? "http" : "https"}://${host}:${port}${ROUTE}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function end(
  res: ServerResponse,
  status: number,
  headers: Record<string, string> = {},
  body?: Uint8Array,
): void {
  if (res.headersSent) return;
  // A refused request's body is never read, so the connection can't be reused.
  const close = status === 413 || status === 503 || status === 415 ? { connection: "close" } : {};
  res.writeHead(status, { ...CORS, ...close, ...headers }).end(body);
}

/** The body, or undefined once it passes `MAX_DELIVERY`. */
async function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > MAX_DELIVERY) return undefined;
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
