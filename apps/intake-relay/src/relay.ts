// RFC 9458's relay role and nothing more (docs/spec/sealed-delivery.md, The
// relay; [[0043-intake-anonymiser]], Decision, rule 4). Each resource
// carries `POST`s of an opaque `message/ohttp-req` body to one node's
// `POST /v1/sealed-intake`, on the relay's own connection and with none of
// the client's headers, so the node never learns the client's address
// (T-11), and returns the node's status, with its body only for a 200. It
// can't read or forge a request or an answer, which are sealed end to end
// (T-25), and it keeps nothing of any one request: it counts requests per
// resource, and a rate limit's addresses live in memory for its window only
// (T-13, T-54).
import { Agent, request as httpsRequest } from "node:https";
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, isIPv4, isIPv6 } from "node:net";
import type { Server } from "node:http";
import { MAX_SEALED_REQUEST, SEALED_ANSWER_LENGTH } from "@abolishus/crypto";
import type { RelayConfig, RelayResource } from "./config.ts";

/** The group every connection to a node negotiates, as the node's route requires (T-15). */
export const NODE_GROUPS = "X25519MLKEM768";
/** Open connections allowed for each queue place, as the node's route allows. */
export const CONNECTIONS_PER_PLACE = 4;
/** Seconds a client is told to wait when the relay is full or it has hit the rate. */
export const BUSY_RETRY_SECONDS = 5;
/** Distinct addresses a rate window tracks; past it, a new address isn't limited until the next window. */
export const MAX_TRACKED_ADDRESSES = 65_536;
const HEADERS_MS = 10_000;
const REQUEST_MS = 30_000;

const SEALED_ROUTE = "/v1/sealed-intake";
// RFC 9458 §9's media types.
const REQUEST_TYPE = "message/ohttp-req";
const ANSWER_TYPE = "message/ohttp-res";

// The client is a browser page on another origin. A request carries no
// credential and anyone may send one, so any origin may; nothing is sent
// with cookies, and nothing is cached on the way (T-43).
const BASE = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
} as const;

/** What the relay has counted for each resource since the last `takeCounts`. */
export interface ResourceCounts {
  /** `POST`s of a sealed request the resource took. */
  readonly requests: number;
  /** Of those, the ones the node gave no answer to: unreachable, timed out or malformed. */
  readonly failed: number;
}

export interface Relay {
  /** The relay's origin, as a client reaches it here. */
  readonly origin: string;
  readonly server: Server;
  /** Each resource's counts since the last call, by path, and then zero. */
  readonly takeCounts: () => Record<string, ResourceCounts>;
  readonly close: () => Promise<void>;
}

export interface RelayOptions {
  /** An error inside the relay, by name only. */
  readonly log?: (event: { event: "relay-error"; error: string }) => void;
  /** The clock a rate window reads, in milliseconds; `Date.now` by default. */
  readonly now?: () => number;
  /** Distinct addresses a rate window tracks; `MAX_TRACKED_ADDRESSES` by default. */
  readonly trackedAddresses?: number;
}

type Headers = Readonly<Record<string, string>>;

type Forwarded = { status: number; answer?: Uint8Array } | undefined;

/**
 * Serves each of `config.resources` at `/<path>` (the root for an empty
 * path), plain HTTP: the host's edge terminates the client's TLS.
 */
export async function serveRelay(config: RelayConfig, options: RelayOptions = {}): Promise<Relay> {
  const now = options.now ?? Date.now;
  const tracked = options.trackedAddresses ?? MAX_TRACKED_ADDRESSES;
  const resources = new Map<string, RelayResource>(config.resources.map((r) => [`/${r.path}`, r]));
  // One pool of connections per node, apart from every client's connection.
  const agents = new Map(
    config.resources.map(
      (r) =>
        [
          r.path,
          new Agent({
            keepAlive: true,
            minVersion: "TLSv1.3",
            ecdhCurve: NODE_GROUPS,
            ...(r.ca === undefined ? {} : { ca: r.ca }),
          }),
        ] as const,
    ),
  );
  const zero = () =>
    new Map<string, { requests: number; failed: number }>(
      config.resources.map((r) => [r.path, { requests: 0, failed: 0 }]),
    );
  let counts = zero();
  let held = 0;
  // Places each resource holds, and the most one may: a node that stalls
  // can take at most half the queue, so the other seats behind the relay
  // keep their sealed route (T-52, T-25).
  const heldBy = new Map<string, number>();
  const perResource = Math.ceil(config.queue / 2);
  // Fixed windows: the whole table is dropped when one ends.
  let window = { start: now(), seen: new Map<string, number>() };

  const limited = (req: IncomingMessage): boolean => {
    const rate = config.rate;
    if (rate === undefined) return false;
    const t = now();
    if (t - window.start >= rate.windowSeconds * 1000) window = { start: t, seen: new Map() };
    const address = clientAddress(req, rate.addressHeader);
    const n = window.seen.get(address) ?? 0;
    if (n >= rate.requests) return true;
    // Past the table's bound a new address goes unlimited rather than
    // refused, so addresses enough to fill it can't hold off every other
    // client; the queue still bounds what reaches the node (T-52).
    if (n > 0 || window.seen.size < tracked) window.seen.set(address, n + 1);
    return false;
  };

  const forward = (resource: RelayResource, body: Uint8Array): Promise<Forwarded> =>
    new Promise((resolve) => {
      const url = new URL(SEALED_ROUTE, resource.node);
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(
        url,
        {
          method: "POST",
          // The body's type and length alone: no header of the client's.
          headers: { "content-type": REQUEST_TYPE, "content-length": String(body.length) },
          // The whole exchange's deadline, not an idle timeout, which a node
          // trickling its answer could reset at every byte.
          signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
          ...(url.protocol === "https:" ? { agent: agents.get(resource.path) } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            res.resume();
            // The node's route answers only 200 or an error with no body;
            // anything else is no answer.
            return resolve(status >= 400 && status <= 599 ? { status } : undefined);
          }
          if (res.headers["content-type"] !== ANSWER_TYPE) {
            res.destroy();
            return resolve(undefined);
          }
          void readBody(res, SEALED_ANSWER_LENGTH).then(
            (answer) => resolve(answer === undefined ? undefined : { status, answer }),
            () => resolve(undefined),
          );
        },
      );
      req.on("error", () => resolve(undefined));
      req.end(body);
    });

  const relay = (req: IncomingMessage, res: ServerResponse, resource: RelayResource) => {
    if (req.headers["content-type"] !== REQUEST_TYPE) return end(res, 415, BASE);
    const length = Number(req.headers["content-length"] ?? Number.NaN);
    if (length > MAX_SEALED_REQUEST) return end(res, 413, BASE);
    const mine = heldBy.get(resource.path) ?? 0;
    if (held >= config.queue || mine >= perResource)
      return end(res, 503, { ...BASE, "retry-after": String(BUSY_RETRY_SECONDS) });
    if (limited(req)) return end(res, 429, { ...BASE, "retry-after": String(BUSY_RETRY_SECONDS) });
    held++;
    heldBy.set(resource.path, mine + 1);
    void (async () => {
      try {
        let body;
        try {
          body = await readBody(req, MAX_SEALED_REQUEST);
        } catch {
          // The client went away or timed out mid-body: nothing to answer.
          return void res.destroy();
        }
        if (body === undefined) return end(res, 413, BASE);
        const count = counts.get(resource.path);
        if (count !== undefined) count.requests++;
        const out = await forward(resource, body);
        if (out === undefined) {
          if (count !== undefined) count.failed++;
          return end(res, 502, BASE);
        }
        if (out.answer === undefined) return end(res, out.status, BASE);
        return end(res, 200, { ...BASE, "content-type": ANSWER_TYPE }, out.answer);
      } catch (e) {
        options.log?.({ event: "relay-error", error: e instanceof Error ? e.name : "unknown" });
        end(res, 500, BASE);
      } finally {
        held--;
        heldBy.set(resource.path, (heldBy.get(resource.path) ?? 1) - 1);
      }
    })();
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    // The exact bytes the deployment record lists: no query, no other
    // spelling (T-31).
    const resource = resources.get(req.url ?? "");
    if (resource === undefined) return end(res, 404, BASE);
    if (req.method === "OPTIONS")
      return end(res, 204, {
        ...BASE,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      });
    if (req.method !== "POST") return end(res, 405, { ...BASE, allow: "POST, OPTIONS" });
    return relay(req, res, resource);
  };

  const server = createServer(
    {
      headersTimeout: HEADERS_MS,
      requestTimeout: REQUEST_MS,
      // Node enforces both timeouts only at this interval (30 s by default).
      connectionsCheckingInterval: 1000,
      maxHeaderSize: 8192,
    },
    handle,
  );
  // Connections still sending headers hold no queue place, so they are
  // bounded apart, before they exhaust the host's descriptors.
  server.maxConnections = CONNECTIONS_PER_PLACE * config.queue;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { address, port } = server.address() as AddressInfo;
  const host = address.includes(":") ? `[${address}]` : address;
  return {
    origin: `http://${host}:${port}`,
    server,
    takeCounts: () => {
      const out = Object.fromEntries(counts);
      counts = zero();
      return out;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const agent of agents.values()) agent.destroy();
      }),
  };
}

/**
 * The key a rate window counts: the edge's header's last value, or the
 * socket's peer when the header holds no IP address, so no key is longer
 * than an address. An IPv6 address counts by its /64, the block one host
 * is commonly given, so one host can't take a fresh key per request (T-54).
 */
function clientAddress(req: IncomingMessage, header: string | undefined): string {
  if (header !== undefined) {
    const value = req.headers[header];
    const last = (Array.isArray(value) ? value.at(-1) : value)?.split(",").at(-1)?.trim();
    if (last !== undefined) {
      const key = addressKey(last);
      if (key !== undefined) return key;
    }
  }
  return addressKey(req.socket.remoteAddress ?? "") ?? "";
}

function addressKey(address: string): string | undefined {
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return undefined;
  // An IPv4-mapped address is its IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  return `${prefix64(address)}::/64`;
}

/** The first four groups of an IPv6 address, `::` expanded. */
function prefix64(address: string): string {
  const [head = "", tail] = address.toLowerCase().split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  // A trailing embedded IPv4 address fills two groups.
  const width = (g: string[]) => g.reduce((n, x) => n + (x.includes(".") ? 2 : 1), 0);
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - width(left) - width(right)).fill("0"), ...right];
  return groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":");
}

function end(res: ServerResponse, status: number, headers: Headers, body?: Uint8Array): void {
  if (res.headersSent) return;
  // A refused request's body is never read, so the connection can't be reused.
  const close =
    status === 413 || status === 415 || status === 429 || status === 503
      ? { connection: "close" }
      : {};
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
