// The node's mirror over HTTP: the raw-block requests of the IPFS trustless
// gateway API (`GET /ipfs/{cid}` with `?format=raw` or
// `Accept: application/vnd.ipld.raw`), which any IPFS client and the
// verifier's network sources can read (P4-3). A reader hashes every block
// against the CID it asked for, so it trusts the node for availability only
// (T-49, T-51).
//
// No path below a CID, no CAR responses and no deserialized responses: the
// node serves blocks, never pages, so nothing it holds runs in a browser at
// its origin (T-43). The one other thing it serves is the verifier's report
// on each election `verify` wrote, as JSON under a policy that runs nothing.
//
// Nothing about a request is written anywhere. Which CIDs a reader fetches
// can say which election, or which segment, it cares about (T-11).

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { cidText } from "@abolishus/crypto";
import { parseCid } from "./cid.ts";
import type { Mirror } from "./store.ts";

const RAW = "application/vnd.ipld.raw";
// Longest request target answered: `/ipfs/` and a CID, then a short query.
const MAX_TARGET = 128;
// `/reports/` and an election identifier in lowercase hex: one URL per report.
const REPORT = /^\/reports\/([0-9a-f]{64})$/u;
/** Largest report served: one of a board at the verifier's whole budget fits many times over. */
export const MAX_REPORT_BYTES = 256 * 1024 * 1024;

export interface GatewayLimits {
  /** Most connections open at once; past it, new ones are closed on accept (T-52). Default 1,024. */
  readonly maxConnections?: number;
  /** A request whose headers take longer is refused (T-52). Default 10 s. */
  readonly headersTimeoutMs?: number;
  /** A request still open after this long is refused (T-52). Default 30 s. */
  readonly requestTimeoutMs?: number;
}

/**
 * An HTTP server answering raw-block requests from `mirror` and, given
 * `reports`, the reports `verify` wrote there. Not yet listening.
 */
export function gateway(mirror: Mirror, limits: GatewayLimits = {}, reports?: string): Server {
  const server = createServer(
    {
      headersTimeout: limits.headersTimeoutMs ?? 10_000,
      requestTimeout: limits.requestTimeoutMs ?? 30_000,
      connectionsCheckingInterval: 1_000,
      maxHeaderSize: 8_192,
      // Node's default: an idle keep-alive connection is closed after 5 s.
      keepAliveTimeout: 5_000,
    },
    (req, res) => {
      res.setHeader("x-content-type-options", "nosniff");
      answer(mirror, reports, req, res).catch(() => {
        if (!res.headersSent) refuse(res, 500);
        else res.destroy();
      });
    },
  );
  // T-52: past this, Node closes each new socket on accept instead of serving it.
  server.maxConnections = limits.maxConnections ?? 1_024;
  return server;
}

async function answer(
  mirror: Mirror,
  reports: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // A request with a body is refused and its connection closed, so Node
  // doesn't read the body to reuse the connection.
  const body =
    (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") ||
    req.headers["transfer-encoding"] !== undefined;
  if (req.method !== "GET" && req.method !== "HEAD")
    return refuse(res, 405, { allow: "GET, HEAD", ...(body ? { connection: "close" } : {}) });
  if (body) return refuse(res, 400, { connection: "close" });
  const target = req.url ?? "";
  if (target.length > MAX_TARGET) return refuse(res, 404);
  const report = REPORT.exec(target)?.[1];
  if (report !== undefined)
    return reports === undefined
      ? refuse(res, 404)
      : answerReport(join(reports, report, "report.json"), req, res);
  if (!target.startsWith("/ipfs/")) return refuse(res, 404);
  const query = target.indexOf("?");
  const path = target.slice("/ipfs/".length, query === -1 ? undefined : query);
  const cid = parseCid(path);
  if (cid === undefined) return refuse(res, 400);
  const format = new URLSearchParams(query === -1 ? "" : target.slice(query + 1)).getAll("format");
  const raw = format.length > 0 ? format.every((f) => f === "raw") : accepts(req.headers.accept);
  if (!raw) return refuse(res, 406, { vary: "accept" });
  const block = await mirror.block(cid);
  if (block === undefined) return refuse(res, 404);
  const name = cidText(cid);
  res.writeHead(200, {
    "content-type": RAW,
    "content-length": block.length,
    // A CID names its bytes for good; the same URL without `format` is a 406
    // to another Accept.
    "cache-control": "public, max-age=29030400, immutable",
    vary: "accept",
    etag: `"${name}.raw"`,
    "content-disposition": `attachment; filename="${name}.bin"`,
    // Blocks are public and checked by whoever reads them, from any origin.
    "access-control-allow-origin": "*",
  });
  res.end(req.method === "HEAD" ? undefined : block);
}

// The report at `path`, opened at each request: the node keeps no cache, and
// `verify` replaces a report by a rename, so a request reads one run's. It is
// streamed, never held whole, so open requests cost what is in flight (T-52).
async function answerReport(
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let file;
  try {
    // Non-blocking, so a FIFO put in the directory can't hold a thread.
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return refuse(res, 404);
  }
  let streaming = false;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) return refuse(res, 404);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": stat.size,
      // A later run replaces it.
      "cache-control": "no-cache",
      // JSON, never a page: nothing in it runs or loads at the node's origin (T-43).
      "content-security-policy": "default-src 'none'; sandbox",
      // A report is public and checkable by anyone who reruns the verifier.
      "access-control-allow-origin": "*",
    });
    if (req.method === "HEAD" || stat.size === 0) return void res.end();
    streaming = true;
    // The stream closes the file when it ends or fails.
    await pipeline(file.createReadStream({ end: stat.size - 1 }), res);
  } finally {
    if (!streaming) await file.close();
  }
}

// Whether an Accept header lists the raw-block type (case-insensitively, as
// media types are) with a weight above zero.
function accepts(accept: string | undefined): boolean {
  return (accept ?? "").split(",").some((entry) => {
    const [type, ...params] = entry.split(";").map((p) => p.trim().toLowerCase());
    if (type !== RAW) return false;
    const q = params.find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

function refuse(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...headers, "cache-control": "no-store", "content-length": 0 });
  res.end();
}
