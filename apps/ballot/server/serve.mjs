// The staging host for the ballot client: serves dist/ as built and nothing
// else, with the client's own policy also sent as a header. A dedicated worker
// takes its CSP from its own response, never from the page's <meta> (T-43), so
// on this host the workers are held to the same policy as the page. The policy
// is read from index.html at start, so the header can't drift from the meta.
// No dependencies: Node's own http, fs and path only.

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const root = new URL("../dist/", import.meta.url).pathname;
const page = readFileSync(join(root, "index.html"), "utf8");
const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(page)?.[1];
if (meta === undefined) throw new Error("index.html has no Content-Security-Policy <meta>");
// frame-ancestors can't be set from a <meta>; the header adds it.
const csp = `${meta}; frame-ancestors 'none'`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".zkey": "application/octet-stream",
};

const HEADERS = {
  "content-security-policy": csp,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** The file under dist/ a request path names, or undefined. */
function resolve(urlPath) {
  let path;
  try {
    path = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return undefined;
  }
  if (path === "/") path = "/index.html";
  const file = normalize(join(root, path));
  if (!file.startsWith(root) || file.includes(`${sep}.`)) return undefined;
  if (!(extname(file) in TYPES)) return undefined;
  try {
    return statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...HEADERS, allow: "GET, HEAD" }).end();
    return;
  }
  const file = resolve(req.url ?? "/");
  if (file === undefined) {
    res
      .writeHead(404, { ...HEADERS, "content-type": "text/plain; charset=utf-8" })
      .end("Not found\n");
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    ...HEADERS,
    "content-type": TYPES[extname(file)],
    "content-length": body.length,
    // Hashed asset names never change content; the page must always be fresh.
    "cache-control": file.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  });
  res.end(req.method === "HEAD" ? undefined : body);
});

server.listen(Number(process.env.BALLOT_PORT ?? 8080), process.env.BALLOT_HOST ?? "0.0.0.0");
