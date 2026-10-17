// Block sources over the network (docs/spec/verifier.md, Board by CID): the
// raw-block requests of the IPFS trustless gateway API, `GET
// /ipfs/{cid}?format=raw` with `Accept: application/vnd.ipld.raw`, which any
// IPFS gateway that offers it and `apps/node` answer. Nothing a gateway
// sends is trusted: an answer counts only if its SHA-256 is the digest of the
// CID asked for, so a gateway can withhold a block but never change one
// (T-49, T-24), and the board checks authenticate the copy against L1's
// anchors, so a gateway can only leave it short (T-53).
//
// What the verifier asks for is visible to every gateway it names: the CIDs
// say which election, and which segments, it is checking (T-11).

import { type AsyncBlockSource, CHUNK_SIZE, cidText } from "@abolishus/crypto";
import { sha256 } from "@noble/hashes/sha2.js";

const RAW = "application/vnd.ipld.raw";

/** Most gateways one read may name. */
export const MAX_GATEWAYS = 16;

/** How long one request may take, headers and body, when the caller sets nothing: 30 s. */
export const DEFAULT_GATEWAY_TIMEOUT_MS = 30_000;

/** How a read's requests to its gateways came out. */
export interface GatewayStats {
  /** Requests sent, over every gateway. */
  readonly requests: number;
  /** Blocks served: answers that hashed to the CID asked for. */
  readonly blocks: number;
}

export interface Gateways {
  readonly source: AsyncBlockSource;
  /** The counts so far. */
  readonly stats: () => GatewayStats;
}

export interface GatewayOptions {
  /** Where requests go: the platform's `fetch` unless a test supplies one. */
  readonly fetch?: typeof globalThis.fetch;
  /** How long one request may take, headers and body; default 30 s (T-52). */
  readonly timeoutMs?: number;
}

/**
 * A gateway's base URL from text: `http:` or `https:`, with no credentials,
 * query or fragment, so the request URL is the base's origin and path, then
 * `/ipfs/{cid}?format=raw`, and nothing else from the text. A trailing `/`
 * on the path is dropped. Throws `RangeError` otherwise.
 */
export function parseGateway(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RangeError("a gateway must be an absolute http: or https: URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new RangeError("a gateway must be an absolute http: or https: URL");
  if (url.username !== "" || url.password !== "")
    throw new RangeError("a gateway URL carries no credentials");
  // `new URL` drops an empty `?` or `#`, so the text is checked as well.
  if (url.search !== "" || url.hash !== "" || /[?#]/u.test(text))
    throw new RangeError("a gateway URL has no query or fragment");
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

// The CID's digest, for a CID of the layout's form (`0x01 ‖ raw or dag-pb ‖
// sha2-256`, 36 bytes), the only form the reader asks for; undefined for any
// other, which no request is sent for.
function digestOf(cid: Uint8Array): Uint8Array | undefined {
  if (
    cid.length !== 36 ||
    cid[0] !== 0x01 ||
    (cid[1] !== 0x55 && cid[1] !== 0x70) ||
    cid[2] !== 0x12 ||
    cid[3] !== 0x20
  )
    return undefined;
  return cid.subarray(4);
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// The body, if it is at most `limit` bytes. The stream is read chunk by
// chunk and cancelled once the count passes `limit`, before more is held,
// whatever Content-Length or Content-Encoding say (a compressed body is
// counted as it decompresses), so no answer costs more than `limit` bytes
// of memory (docs/spec/content-addressing.md, Reading by CID; T-52).
async function bodyWithin(res: Response, limit: number): Promise<Uint8Array | undefined> {
  const declared = res.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/u.test(declared) && Number(declared) > limit) {
    await res.body?.cancel();
    return undefined;
  }
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * A block source over `gateways`, asked in the order given. For each block
 * the reader asks for, each gateway in turn gets one raw-block request until
 * one answers with a block of at most the reader's limit (and at most
 * `CHUNK_SIZE`) that hashes to the CID; that block is the only answer, and
 * the gateways after it aren't asked. An error, a status other than 200, a
 * redirect, a timeout, an answer past the limit or one that doesn't hash is
 * that gateway's failure for that block, never the read's: the next gateway
 * is asked, and a block no gateway serves is unavailable. No request is sent
 * for a CID the reader can't use.
 */
export function gatewaySource(gateways: readonly URL[], options: GatewayOptions = {}): Gateways {
  if (gateways.length === 0 || gateways.length > MAX_GATEWAYS)
    throw new RangeError(`between 1 and ${MAX_GATEWAYS} gateways`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("timeoutMs must be a positive integer");
  const fetch = options.fetch ?? globalThis.fetch;
  // Copied, so a caller changing its URLs later changes nothing here.
  const bases = gateways.map((g) => `${g.origin}${g.pathname.replace(/\/+$/u, "")}`);
  let requests = 0;
  let blocks = 0;
  const ask = async (
    base: string,
    cid: Uint8Array,
    limit: number,
  ): Promise<Uint8Array | undefined> => {
    requests++;
    try {
      const res = await fetch(`${base}/ipfs/${cidText(cid)}?format=raw`, {
        headers: { accept: RAW },
        // A redirect could send the request to a host the user never named.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) {
        await res.body?.cancel();
        return undefined;
      }
      return await bodyWithin(res, limit);
    } catch {
      // The gateway's failure for this block, never the read's.
      return undefined;
    }
  };
  return {
    source: async (cid, limit) => {
      const digest = digestOf(cid);
      if (digest === undefined || !Number.isSafeInteger(limit) || limit < 0) return [];
      const within = Math.min(limit, CHUNK_SIZE);
      for (const base of bases) {
        const block = await ask(base, cid, within);
        if (block !== undefined && same(sha256(block), digest)) {
          blocks++;
          return [block];
        }
      }
      return [];
    },
    stats: () => ({ requests, blocks }),
  };
}
