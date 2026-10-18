// The staging host for the challenge page ([[registration]], Challenge page):
// serves the page and its script and stylesheet as built, and nothing else,
// with the headers the build wrote to dist/headers.json, so the policy and
// its `frame-ancestors` can't drift from the entry points the page posts to
// (T-43). It sets no cookie (T-10) and logs nothing. No dependencies: Node's
// own http, fs and path only.

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

// With its separator, so a sibling such as dist-x/ never passes the prefix check.
const root =
  resolvePath(process.env.CHALLENGE_DIST ?? fileURLToPath(new URL("../dist/", import.meta.url))) +
  sep;
const assets = join(root, "assets") + sep;
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
  if (path === "/") return join(root, "index.html");
  // Checked after normalizing, so `..` can't reach the page, the headers
  // file or anything outside assets/.
  const file = normalize(join(root, path));
  if (!file.startsWith(assets) || file.includes(`${sep}.`)) return undefined;
  if (extname(file) !== ".js" && extname(file) !== ".css") return undefined;
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
  let body;
  try {
    body = readFileSync(file);
  } catch {
    // Gone since it was found: answered, so one request can't stop the host.
    res
      .writeHead(404, { ...HEADERS, "content-type": "text/plain; charset=utf-8" })
      .end("Not found\n");
    return;
  }
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
