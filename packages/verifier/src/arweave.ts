// A transaction source over the network (docs/spec/archive.md, Reading from
// gateways): the raw-data request `GET /raw/{id}` that Arweave nodes and
// ar.io gateways answer with a transaction's data as posted, by its ID in
// unpadded base64url. The raw route resolves no path manifest and sends no
// sandbox redirect, so the answer is the data the ID names or nothing.
// Nothing a gateway sends is trusted: the archive reader counts an answer
// only if it reads as the CID asked for (`readArchivedObject`), so a gateway
// can withhold an object but never change one (T-49, T-24, T-53).
//
// What the verifier asks for is visible to every gateway it names: a
// transaction ID says which manifest or segment it is reading (T-11).

import { arweaveId } from "@abolishus/crypto";
import type { TransactionSource } from "./archive.ts";
import {
  DEFAULT_GATEWAY_TIMEOUT_MS,
  type GatewayOptions,
  MAX_GATEWAYS,
  bodyWithin,
  parseGateway,
} from "./gateways.ts";

/** How a run's requests to its Arweave gateways came out. */
export interface ArweaveStats {
  /** Requests sent, over every gateway. */
  readonly requests: number;
  /** Answers given to the reader: bodies of status 200 within its limit, read or not. */
  readonly answers: number;
}

export interface ArweaveGateways {
  readonly source: TransactionSource;
  /** The counts so far. */
  readonly stats: () => ArweaveStats;
}

/**
 * A transaction source over `gateways` (each parsed as `parseGateway`
 * parses an IPFS gateway's base), asked in the order given and only as the
 * reader needs: each gateway's answer is handed over before the next is
 * asked, and the reader stops at the first that reads as its CID. An error,
 * a status other than 200, a redirect, a timeout or a body past the reader's
 * limit is that gateway's failure for that transaction, never the read's, so
 * the next gateway is asked. No request is sent for anything but a 32-byte
 * ID or with a limit that isn't a non-negative safe integer.
 */
export function arweaveSource(
  gateways: readonly URL[],
  options: GatewayOptions = {},
): ArweaveGateways {
  if (gateways.length === 0 || gateways.length > MAX_GATEWAYS)
    throw new RangeError(`between 1 and ${MAX_GATEWAYS} gateways`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("timeoutMs must be a positive integer");
  const fetch = options.fetch ?? globalThis.fetch;
  // Copied and checked as gatewaySource's are, so a caller changing its URLs
  // later changes nothing and no URL's path can name another host.
  const bases = gateways.map((g) => {
    const url = parseGateway(g.href);
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  });
  let requests = 0;
  let answers = 0;
  const ask = async (base: string, id: string, limit: number) => {
    requests++;
    try {
      const res = await fetch(`${base}/raw/${id}`, {
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
      // The gateway's failure for this transaction, never the read's.
      return undefined;
    }
  };
  async function* source(transaction: Uint8Array, limit: number): AsyncGenerator<Uint8Array> {
    if (transaction.length !== 32 || !Number.isSafeInteger(limit) || limit < 0) return;
    const id = arweaveId(transaction);
    for (const base of bases) {
      const data = await ask(base, id, limit);
      if (data === undefined) continue;
      answers++;
      yield data;
    }
  }
  return { source, stats: () => ({ requests, answers }) };
}
