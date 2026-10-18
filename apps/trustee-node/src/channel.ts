// The channel between trustee nodes that carries summed-share messages
// (docs/spec/tally.md, Summed-share message; README, Summed-share channel):
// `serveSummedShares`, the endpoint a seat's node receives them at, and
// `httpPeers`, the `SummedSharePeers` it sends them through. Both hold to
// TLS 1.3 with only the hybrid post-quantum group, since a summed share
// recorded in transit is exposed to a later quantum break otherwise, and
// neither keeps a message after it is handed on ([[0015-tally-publication]];
// T-15, T-39).
//
// The endpoint acknowledges a message as soon as its body is read, before
// and whatever the seat makes of it, so its answer never tells the sender
// which check failed (Receiving, Notes; T-39). The check itself is
// synchronous, so a registered seat's next message, acknowledged only once
// the event loop is free, can still time it (README, Known-weak). It bounds
// only what a message costs: the body, the messages held at once and the
// time a peer may take to send one (T-52). The message is the spec's record
// itself, with no envelope: every check is the seat's (`TallyDuty.receive`).
import {
  createServer as createHttpServer,
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { PARAMETERS } from "@abolishus/crypto";
import { CONNECTIONS_PER_PLACE, type Endpoint, INTAKE_GROUPS } from "./endpoint.ts";
import type { SummedSharePeers } from "./tally.ts";

/**
 * Bound on a summed-share message: version 2's fields (version 1's and the
 * panel) at `MAX_OPTIONS`, the record's 3-byte header and the signature.
 */
export const MAX_SUMMED_SHARE =
  3 + 32 + 1 + 1 + 32 + 1 + 1 + 1088 + 32 + (4 + 4 + 64 * PARAMETERS.MAX_OPTIONS + 16) + 64;

/** What the endpoint hands each message to: the elections' `TallyDuty.receive`. */
export type ReceiveSummedShare = (message: Uint8Array) => Promise<void>;

export interface ChannelOptions {
  readonly host: string;
  /** 0 picks a free port. */
  readonly port: number;
  /**
   * The certificate chain and key, PEM. Without them the endpoint takes
   * plain HTTP and only on a loopback address, for a TLS proxy on the same
   * host that holds to the same key exchange.
   */
  readonly tls?: { readonly cert: string; readonly key: string };
  /** Messages held at once, being read or checked; past it the endpoint answers 503. */
  readonly queue: number;
  /** One line per failure, never a body or an address. */
  readonly log?: (event: { readonly event: "summed-share-error"; readonly error: string }) => void;
}

/** Seconds a sender is told to wait when the queue is full. */
export const CHANNEL_RETRY_SECONDS = 5;
const HEADERS_MS = 10_000;
const REQUEST_MS = 30_000;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
// The same addresses as a URL's `hostname` gives them.
const LOOPBACK_URL = new Set(["127.0.0.1", "[::1]", "localhost"]);
const ROUTE = "/v1/summed-shares";

/**
 * Serves `receive` at `POST /v1/summed-shares`. The body is one summed-share
 * message as `application/octet-stream`; it is answered 202 once read in
 * full, then handed to `receive`, one message at a time.
 */
export async function serveSummedShares(
  receive: ReceiveSummedShare,
  options: ChannelOptions,
): Promise<Endpoint> {
  if (!Number.isSafeInteger(options.queue) || options.queue < 1)
    throw new RangeError("summed-share channel: the queue must hold at least one message");
  if (options.tls === undefined && !LOOPBACK.has(options.host))
    throw new RangeError("summed-share channel: plain HTTP only on a loopback address");
  let held = 0;
  // `openSummedShares` is synchronous work, so messages are checked one
  // after another; the queue bounds how many wait.
  let chain: Promise<unknown> = Promise.resolve();
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== ROUTE) return end(res, 404);
    if (req.method !== "POST") return end(res, 405, { allow: "POST" });
    if (req.headers["content-type"] !== "application/octet-stream") return end(res, 415);
    const length = Number(req.headers["content-length"] ?? Number.NaN);
    if (length > MAX_SUMMED_SHARE) return end(res, 413);
    if (held >= options.queue)
      return end(res, 503, { "retry-after": String(CHANNEL_RETRY_SECONDS) });
    held++;
    void (async () => {
      try {
        let body;
        try {
          body = await readBody(req);
        } catch {
          // The peer went away or timed out mid-body: nothing to answer and
          // nothing worth a log line, which anyone could flood.
          return void res.destroy();
        }
        if (body === undefined) return end(res, 413);
        // Acknowledged before the seat sees it: the same answer for a
        // message that passes and one that fails any check.
        end(res, 202);
        const run = () => receive(body);
        const outcome = chain.then(run, run);
        chain = outcome.catch(() => undefined);
        await outcome;
      } catch (e) {
        options.log?.({
          event: "summed-share-error",
          error: e instanceof Error ? e.name : "unknown",
        });
      } finally {
        held--;
      }
    })();
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

function end(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  // A refused request's body is never read, so the connection can't be reused.
  const close = status === 413 || status === 503 || status === 415 ? { connection: "close" } : {};
  res.writeHead(status, { "cache-control": "no-store", ...close, ...headers }).end();
}

/** The body, or undefined once it passes `MAX_SUMMED_SHARE`. */
async function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > MAX_SUMMED_SHARE) return undefined;
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export interface PeersOptions {
  /**
   * Each other seat's summed-share endpoint, by seat index: `https:`, or
   * `http:` only on a loopback address, for a TLS proxy on the same host
   * that holds to the same key exchange.
   */
  readonly peers: ReadonlyMap<number, string>;
  /** The CA certificates (PEM) the peers' certificates chain to, in place of the system's. */
  readonly ca?: string;
  /** How long one send may take, connecting included, before it fails. */
  readonly timeoutMs: number;
}

/** Why a send failed now; the tally duty sends again at its next step. */
export class PeerError extends Error {
  override readonly name = "PeerError";
}

/**
 * `SummedSharePeers` over the other seats' endpoints. A send resolves once
 * the recipient's node has answered 202, which says only that the message
 * arrived; anything else, or no answer within `timeoutMs`, throws
 * `PeerError`. A seat with no configured endpoint throws too, so a step
 * reports it as unsent rather than skipping it.
 */
export function httpPeers(options: PeersOptions): SummedSharePeers {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    throw new RangeError("summed-share peers: the timeout must be a positive number of ms");
  const urls = new Map<number, URL>();
  for (const [seat, text] of options.peers) {
    const url = new URL(text);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_URL.has(url.hostname)))
      throw new RangeError(`summed-share peers: seat ${seat}'s endpoint must be https`);
    urls.set(seat, url);
  }
  return {
    send: (recipient, message) => {
      const url = urls.get(recipient);
      if (url === undefined)
        return Promise.reject(new PeerError(`no endpoint for seat ${recipient}`));
      return new Promise<void>((resolve, reject) => {
        const common = {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": message.length,
          },
          timeout: options.timeoutMs,
          // A fresh connection per send: a pooled one its peer has since
          // closed would fail a send that could have gone through.
          agent: false,
        };
        const answer = (res: IncomingMessage) => {
          res.resume();
          if (res.statusCode === 202) resolve();
          else reject(new PeerError(`seat ${recipient} answered ${res.statusCode ?? 0}`));
        };
        const req =
          url.protocol === "https:"
            ? httpsRequest(
                url,
                {
                  ...common,
                  minVersion: "TLSv1.3",
                  ecdhCurve: INTAKE_GROUPS,
                  ...(options.ca === undefined ? {} : { ca: options.ca }),
                },
                answer,
              )
            : httpRequest(url, common, answer);
        // `timeout` covers an idle socket; the whole send is bounded too.
        const late = () => req.destroy(new PeerError(`seat ${recipient}: timed out`));
        const timer = setTimeout(late, options.timeoutMs);
        req.on("timeout", late);
        // The code only (`ECONNREFUSED`, a TLS alert's): never the peer's address.
        req.on("error", (e: NodeJS.ErrnoException) =>
          reject(
            e instanceof PeerError ? e : new PeerError(`seat ${recipient}: ${e.code ?? e.name}`),
          ),
        );
        req.on("close", () => clearTimeout(timer));
        req.end(message);
      });
    },
  };
}
