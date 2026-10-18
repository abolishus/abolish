// The staging host for the challenge page ([[registration]], Challenge page):
// serves the page and its script and stylesheet as built, and nothing else,
// with the headers the build wrote to dist/headers.json, so the policy and
// its `frame-ancestors` can't drift from the entry points the page posts to
// (T-43). It sets no cookie (T-10) and logs nothing. No dependencies: Node's
// own http, fs and path only.

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const root = process.env.CHALLENGE_DIST ?? new URL("../dist/", import.meta.url).pathname;
const HEADERS = JSON.parse(readFileSync(join(root, "headers.json"), "utf8"));
if (typeof HEADERS["content-security-policy"] !== "string")
  throw new Error("headers.json has no content-security-policy");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** The file a request path names: the page, or a script or stylesheet under assets/. */
function resolve(urlPath) {
  let path;
  try {
    path = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return undefined;
  }
  // The fragment never reaches the host, so `/` is the page's one address.
  if (path === "/") path = "/index.html";
  else if (!path.startsWith("/assets/")) return undefined;
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

server.listen(Number(process.env.CHALLENGE_PORT ?? 8080), process.env.CHALLENGE_HOST ?? "0.0.0.0");
