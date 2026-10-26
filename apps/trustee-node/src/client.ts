// The node's side of the coordinator transport (README, Transport). For the
// ceremony the node only calls out: it fetches what the coordinator asks of
// its seat and posts its answers, so no ceremony request reaches the host
// that holds the seat's keys unasked (it listens only for intake deliveries,
// endpoint.ts, and gateway requests for what it attests). The coordinator is trusted for liveness only
// (docs/spec/ceremony.md, Parties and keys): every body it returns is checked
// by the seat before the node acts on it, and every body the node posts is
// signed or public.
import {
  type ApprovalPost,
  type CeremonyRequest,
  decodeRequests,
  encodeApprovalPost,
  encodeMessagePost,
  MAX_BODY,
  type MessagePost,
} from "./wire.ts";

/** What the node needs of a coordinator; `HttpCoordinator` over HTTPS, or one in-process. */
export interface Coordinator {
  /** What the coordinator asks of `seat` now. Throws `TransportError` when it can't tell. */
  requests(seat: number): Promise<readonly CeremonyRequest[]>;
  postMessage(seat: number, post: MessagePost): Promise<void>;
  postApproval(seat: number, post: ApprovalPost): Promise<void>;
}

/** The coordinator couldn't be reached, or answered with something the transport can't read. */
export class TransportError extends Error {
  override readonly name = "TransportError";
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The coordinator's base URL: HTTPS, or HTTP to loopback for a local run, so
 * no one on the path can read or change what the node is asked (it would
 * still be checked, but a path attacker could withhold it like any
 * coordinator) or learn which elections a seat takes part in. The
 * operator's API base URL, which the seat sends its tally openings to, is
 * held to the same rule (`what`).
 */
export function coordinatorUrl(url: string, what = "coordinator"): URL {
  const u = new URL(url);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname)))
    throw new RangeError(`trustee node: the ${what} URL must be https (or http to loopback)`);
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "")
    throw new RangeError(`trustee node: the ${what} URL takes no credentials, query or fragment`);
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u;
}

export interface HttpOptions {
  /** Injected for tests; the platform's `fetch` otherwise. */
  readonly fetch?: typeof fetch;
  /** Per request, in milliseconds. */
  readonly timeoutMs?: number;
}

export class HttpCoordinator implements Coordinator {
  readonly #base: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(url: string, options: HttpOptions = {}) {
    this.#base = coordinatorUrl(url);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async requests(seat: number): Promise<readonly CeremonyRequest[]> {
    const body = await this.#call(seat, "requests", "GET");
    try {
      return decodeRequests(body);
    } catch (e) {
      throw new TransportError("coordinator: requests body has no decoding", { cause: e });
    }
  }

  async postMessage(seat: number, post: MessagePost): Promise<void> {
    await this.#call(seat, "messages", "POST", encodeMessagePost(post));
  }

  async postApproval(seat: number, post: ApprovalPost): Promise<void> {
    await this.#call(seat, "approvals", "POST", encodeApprovalPost(post));
  }

  async #call(
    seat: number,
    path: string,
    method: "GET" | "POST",
    body?: Uint8Array,
  ): Promise<Uint8Array> {
    if (!Number.isInteger(seat) || seat < 1) throw new RangeError("trustee node: bad seat");
    const url = new URL(`v1/ceremony/seats/${seat}/${path}`, this.#base);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        // A redirect could leave HTTPS or the pinned host.
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(body !== undefined && {
          body: body as Uint8Array<ArrayBuffer>,
          headers: { "content-type": "application/octet-stream" },
        }),
      });
    } catch (e) {
      // The cause's code (a timeout, DNS, TLS) tells an operator what failed, and holds no secret.
      const cause = (e as { cause?: { code?: unknown } }).cause?.code;
      const code = typeof cause === "string" ? cause : e instanceof Error ? e.name : "unknown";
      throw new TransportError(`coordinator: ${method} ${path} failed (${code})`, {
        cause: e,
      });
    }
    if (!response.ok) {
      // A body that already errored (a reset after the headers) rejects its cancel.
      await response.body?.cancel().catch(() => undefined);
      throw new TransportError(`coordinator: ${method} ${path} answered ${response.status}`);
    }
    return readCapped(response, MAX_BODY);
  }
}

/** A response body, refused once it passes `max` bytes rather than buffered whole. */
export async function readCapped(
  response: Response,
  max: number,
  what = "coordinator",
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) {
        await reader.cancel();
        throw new TransportError(`${what}: body too large`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof TransportError) throw e;
    throw new TransportError(`${what}: body unreadable`, { cause: e });
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
