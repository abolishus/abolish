// The node's mirror over HTTP: the raw-block requests of the IPFS trustless
// gateway API (`GET /ipfs/{cid}` with `?format=raw` or
// `Accept: application/vnd.ipld.raw`), which any IPFS client and the
// verifier's network sources can read (P4-3). A reader hashes every block
// against the CID it asked for, so it trusts the node for availability only
// (T-49, T-51).
//
// No path below a CID, no CAR responses and no deserialized responses: the
// node serves blocks, never pages, so nothing it holds runs in a browser at
// its origin (T-43).
//
// Nothing about a request is written anywhere. Which CIDs a reader fetches
// can say which election, or which segment, it cares about (T-11).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { cidText } from "@abolishus/crypto";
import { parseCid } from "./cid.ts";
import type { Mirror } from "./store.ts";

const RAW = "application/vnd.ipld.raw";
// Longest request target answered: `/ipfs/` and a CID, then a short query.
const MAX_TARGET = 128;

export interface GatewayLimits {
  /** A connection idle this long is destroyed (T-52). Default 15 s. */
  readonly idleTimeoutMs?: number;
  /** A request whose headers take longer is refused (T-52). Default 10 s. */
  readonly headersTimeoutMs?: number;
  /** A request still open after this long is destroyed (T-52). Default 30 s. */
  readonly requestTimeoutMs?: number;
}

/** An HTTP server answering raw-block requests from `mirror`. Not yet listening. */
export function gateway(mirror: Mirror, limits: GatewayLimits = {}): Server {
  const server = createServer(
    {
      headersTimeout: limits.headersTimeoutMs ?? 10_000,
      requestTimeout: limits.requestTimeoutMs ?? 30_000,
      connectionsCheckingInterval: 1_000,
      maxHeaderSize: 8_192,
    },
    (req, res) => {
      res.setHeader("x-content-type-options", "nosniff");
      answer(mirror, req, res).catch(() => {
        if (!res.headersSent) refuse(res, 500);
        else res.destroy();
      });
    },
  );
  server.setTimeout(limits.idleTimeoutMs ?? 15_000);
  return server;
}

async function answer(mirror: Mirror, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD")
    return refuse(res, 405, { allow: "GET, HEAD" });
  // A GET or HEAD carries no body; one that says it does is refused unread.
  if (req.headers["content-length"] !== undefined || req.headers["transfer-encoding"] !== undefined)
    return refuse(res, 400);
  const target = req.url ?? "";
  if (target.length > MAX_TARGET || !target.startsWith("/ipfs/")) return refuse(res, 404);
  const query = target.indexOf("?");
  const path = target.slice("/ipfs/".length, query === -1 ? undefined : query);
  const cid = parseCid(path);
  if (cid === undefined) return refuse(res, 400);
  const format = new URLSearchParams(query === -1 ? "" : target.slice(query + 1)).getAll("format");
  const raw =
    format.length > 0
      ? format.every((f) => f === "raw")
      : (req.headers.accept ?? "").split(",").some((t) => t.split(";")[0]?.trim() === RAW);
  if (!raw) return refuse(res, 406);
  const block = await mirror.block(cid);
  if (block === undefined) return refuse(res, 404);
  const name = cidText(cid);
  res.writeHead(200, {
    "content-type": RAW,
    "content-length": block.length,
    // A CID names its bytes for good.
    "cache-control": "public, max-age=29030400, immutable",
    etag: `"${name}.raw"`,
    "content-disposition": `attachment; filename="${name}.bin"`,
    // Blocks are public and checked by whoever reads them, from any origin.
    "access-control-allow-origin": "*",
  });
  res.end(req.method === "HEAD" ? undefined : block);
}

function refuse(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...headers, "cache-control": "no-store", "content-length": 0 });
  res.end();
}
