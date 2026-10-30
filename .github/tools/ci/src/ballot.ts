// Bundle and CSP policy for the ballot client (apps/ballot), the only place a
// plaintext vote exists. The brief requires "a test asserts its bundle
// contains no analytics SDK"; AGENTS.md allows it no third-party runtime code
// beyond React and the shadcn/ui runtime; T-43 needs its strict CSP. Those are policies, so
// they live here, under CODEOWNERS, where the PR they judge can't weaken them
// (T-59; AGENTS.md rule B). apps/ballot's own tests may repeat them.
//
// The check builds the client with its own Vite config and judges two
// things: the module graph each build resolved (which npm packages and
// workspace files went into the page and into each Web Worker), and the
// emitted bytes (file names, index.html, URLs and SDK markers in every script
// and stylesheet).

import { createHash } from "node:crypto";
import { posix, relative, sep } from "node:path";

/**
 * npm packages whose code may run in the ballot client: React, the shadcn/ui
 * runtime the owner allowed on 2026-10-12 (Base UI and its dependencies,
 * class-variance-authority, clsx behind `cn`, lucide-react;
 * docs/PROJECT_BRIEF.md, AGENTS.md "Dependencies"), and the `@noble/*`
 * libraries @abolishus/crypto is built on, which the client runs to encrypt
 * and prove a ballot (AGENTS.md: code that touches the plaintext or the
 * encryption randomness is a packages/crypto API the client calls). Adding to
 * it is an owner-reviewed change.
 */
export const RUNTIME_PACKAGES: ReadonlySet<string> = new Set([
  "react",
  "react-dom",
  "scheduler",
  "@base-ui/react",
  "@base-ui/utils",
  "@floating-ui/core",
  "@floating-ui/dom",
  "@floating-ui/react-dom",
  "@floating-ui/utils",
  "@babel/runtime",
  "reselect",
  "use-sync-external-store",
  "class-variance-authority",
  "clsx",
  "cn",
  "lucide-react",
  "@noble/ciphers",
  "@noble/curves",
  "@noble/hashes",
  "@noble/post-quantum",
]);

/**
 * Workspace files the client may bundle, relative to the repository root.
 * @abolishus/crypto is reached through its exports, so its build output, which
 * ci's setup builds from packages/crypto/src (inside the crypto-review gate).
 */
export const WORKSPACE_SOURCES = [
  "apps/ballot/src/",
  "apps/ballot/index.html",
  "packages/ui/src/",
  "packages/crypto/dist/",
] as const;

/**
 * Code only the prover worker may bundle, besides the above (ADR 0009,
 * Amendment 2026-10-17, owner-approved): snarkjs's and ffjavascript's
 * prebuilt browser builds, each the one file named here, and the gated
 * adapter around them. snarkjs holds the identity secret there, in a realm of
 * its own, and the ballot worker re-verifies and re-randomises what it
 * returns; neither the page nor the ballot worker may run any of it (T-55).
 */
export const PROVER_PACKAGES: ReadonlyMap<string, string> = new Map([
  ["snarkjs", "build/browser.esm.js"],
  ["ffjavascript", "build/browser.esm.js"],
]);
export const PROVER_SOURCES = ["packages/membership-prover/src/"] as const;

/**
 * The client's two Web Workers, by emitted name (Vite names a worker after
 * its entry file): the ballot worker, which encrypts and proves, and the
 * prover worker, which runs snarkjs. No other script may be left for the page
 * to start, and the page loads neither itself.
 */
export const BALLOT_WORKER = /^assets\/worker-[\w-]+\.js$/;
export const PROVER_WORKER = /^assets\/prover-[\w-]+\.js$/;

/**
 * The proving key and witness calculator the client serves from its own
 * release for the prover worker, by sha256: Semaphore 4.13.0's depth-32
 * `semaphore-32.zkey` and `semaphore-32.wasm` (snark-artifacts.pse.dev, which
 * vectors-provenance re-fetches), so a build can ship no other key or
 * WebAssembly under these extensions.
 */
export const PROVER_ARTIFACTS: Readonly<Record<string, string>> = {
  zkey: "2e5f7a9f880c337134ee4c7fc4e53573813b4c9c6ae46221c0b56e7992304650",
  wasm: "528333d1247f585d33c5a40f46053fb7f8b1f5b8b8fa29118abfc47a60921dc5",
};

/**
 * The origins besides its own the client may make requests to, and the only
 * ones its code may name (T-34, T-43): the API that serves definitions,
 * display text and the board; the L2 JSON-RPC endpoint the election and group
 * registries are read through (ADR 0004: Base Sepolia while there is no
 * mainnet); a second L2 endpoint of another operator, which must agree before
 * the client treats a `moved` registration as real and offers a new identity
 * (T-16, T-11), so one lying endpoint can't make a voter give theirs up; and
 * one L1 JSON-RPC endpoint (Sepolia), for the L1 block a ballot names and the
 * voting window by chain time (docs/spec/revoting.md, Client rules); and the
 * intake relay a sealed delivery goes through to a seat's node
 * (docs/spec/sealed-delivery.md, The relay; apps/intake-relay), on an origin of
 * its own, never a node's. All are untrusted: the client checks every answer
 * against the registry or the chain before acting on it, and the relay carries
 * only a sealed request it can't read, so a hostile one can refuse service but
 * not change a ballot. These are staging's. A release names its own, and a release build
 * naming a staging origin is a policy failure (owner review, rule B).
 */
export const CONNECT_ORIGINS: readonly string[] = [
  "https://api-staging.abolish.us",
  "https://sepolia.base.org",
  "https://base-sepolia-rpc.publicnode.com",
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://intake-relay-staging.up.railway.app",
];

/**
 * The origins the client may frame, and name besides CONNECT_ORIGINS: the
 * challenge page ([[registration]], Challenge page; apps/challenge), where
 * Turnstile runs on an origin of its own so the client never runs
 * Cloudflare's unpinnable script (T-43, T-67). The frame gets no access to the
 * client's document; the client takes one well-formed token from it, checked
 * by origin and source window, and nothing else. Staging's, a Railway domain
 * (`up.railway.app` is a public suffix, so the host is a site of its own,
 * apart from the client's and the ballot RP ID); a release names its own
 * (owner review, rule B).
 */
export const FRAME_ORIGINS: readonly string[] = ["https://challenge-staging.up.railway.app"];

/**
 * The ballot client's Content Security Policy (T-43). Scripts, styles, fonts
 * and images from its own origin only, and WebAssembly compiled
 * ('wasm-unsafe-eval', which never allows JavaScript eval) for the prover's
 * curve code and witness calculator; requests only to its own origin, for the
 * prover's key and witness calculator from its own release, and to
 * CONNECT_ORIGINS, from the main thread (a worker gets no CSP from the page,
 * so WORKER_BANNED keeps its I/O out); Web Workers from its own origin only,
 * where encryption and proving run; Trusted Types, with one named policy,
 * `ballot-worker`, for the two workers' script URLs (`new Worker(url)` is a
 * script-URL sink; the client creates the policy first, and a second policy
 * of that name throws); frames from FRAME_ORIGINS only, for the challenge
 * page; no <base> and no form posts.
 */
export const BALLOT_CSP: Readonly<Record<string, readonly string[]>> = {
  "default-src": ["'none'"],
  "script-src": ["'self'", "'wasm-unsafe-eval'"],
  "style-src": ["'self'"],
  "font-src": ["'self'"],
  "img-src": ["'self'"],
  "connect-src": ["'self'", ...CONNECT_ORIGINS],
  "frame-src": [...FRAME_ORIGINS],
  "worker-src": ["'self'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "require-trusted-types-for": ["'script'"],
  "trusted-types": ["ballot-worker"],
};

/**
 * URLs that may appear in scripts and stylesheets as inert strings, never
 * fetched: XML namespace names React DOM sets, React's and Base UI's
 * error-decoder links (each only formatted into a thrown error's message) and
 * Tailwind's licence comment.
 */
export const INERT_URLS: ReadonlySet<string> = new Set([
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/XML/1998/namespace",
  "https://base-ui.com/production-error",
  "https://react.dev/errors/",
  "https://tailwindcss.com",
]);

/** Whether a URL in a script may appear: an inert string, or an allowed origin itself or under it. */
export function isAllowedUrl(url: string): boolean {
  return (
    INERT_URLS.has(url) ||
    [...CONNECT_ORIGINS, ...FRAME_ORIGINS].some(
      (origin) => url === origin || url.startsWith(`${origin}/`),
    )
  );
}

/** Package names, globals and collection hosts of analytics, tracking and error-reporting SDKs (T-67). */
export const ANALYTICS_MARKERS: readonly RegExp[] = [
  /posthog/i,
  /google-analytics|googletagmanager|\bgtag\(/i,
  /segment\.(io|com)|analytics\.js/i,
  /sentry/i,
  /mixpanel/i,
  /amplitude/i,
  /plausible/i,
  /datadog|\bdd-rum\b/i,
  /hotjar/i,
  /fullstory/i,
  /logrocket/i,
  /bugsnag/i,
  /newrelic|nr-data\.net/i,
  // Word-bounded: Tailwind emits "scrollbar" utilities.
  /\brollbar\b/i,
  /heap(analytics|-api)/i,
  /clarity\.ms/i,
  /cloudflareinsights|beacon\.min\.js/i,
  /\bsendBeacon\b/,
];

/**
 * What the build may emit, besides index.html: hashed scripts and styles,
 * self-hosted fonts, licences, and the prover's key and witness calculator
 * (PROVER_ARTIFACTS pins their bytes).
 */
const EMITTED = [
  /^index\.html$/,
  /^assets\/[\w-]+\.(js|css)$/,
  /^assets\/(oxanium|jetbrains-mono)-[\w-]+\.woff2?$/,
  /^assets\/[\w-]+\.(zkey|wasm)$/,
  /^third-party-licenses\.md$/,
  /^font-licenses\.txt$/,
];

/**
 * The npm package a resolved module id belongs to, and the file within it:
 * only a file inside the package's own pnpm store entry under the
 * repository's node_modules, with no node_modules nested below it. Anything
 * else, a directory merely named node_modules included, is undefined and
 * judged as workspace code.
 */
function storeEntryOf(id: string, repoRoot: string): { name: string; file: string } | undefined {
  const path = relative(repoRoot, id).split(sep).join(posix.sep);
  const m = /^node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/@][^/]*)\/(.+)$/.exec(
    path,
  );
  if (m?.[1] === undefined || m[2] === undefined || m[2].split("/").includes("node_modules"))
    return undefined;
  return { name: m[1], file: m[2] };
}

/** The npm package a resolved module id belongs to (see storeEntryOf). */
export function packageOf(id: string, repoRoot: string): string | undefined {
  return storeEntryOf(id, repoRoot)?.name;
}

/**
 * One build the child ran: the page's, or one Web Worker's (`worker`), with
 * the chunks it emitted and every module it resolved.
 */
export interface BuildReport {
  readonly worker: boolean;
  readonly chunks: readonly string[];
  readonly modules: readonly string[];
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/** Whether a build is the prover worker's: a worker build whose one chunk has the prover's name. */
export function isProverBuild(build: BuildReport): boolean {
  const [chunk, ...rest] = build.chunks;
  return build.worker && rest.length === 0 && chunk !== undefined && PROVER_WORKER.test(chunk);
}

/**
 * Problems with the builds the child reported: a list of them, each with a
 * worker flag and lists of chunk names and module ids; react-dom among the
 * modules (or the module check would be vacuous); and every build passing
 * `moduleViolations`, with the prover's code allowed in the prover worker's
 * build only.
 */
export function moduleListViolations(report: unknown, repoRoot: string): string[] {
  const builds: BuildReport[] = [];
  for (const build of Array.isArray(report) ? report : [undefined]) {
    const b = build as Partial<Record<keyof BuildReport, unknown>> | null | undefined;
    if (typeof b?.worker !== "boolean" || !isStringList(b.chunks) || !isStringList(b.modules))
      return ["apps/ballot: the build's report isn't a list of { worker, chunks, modules }"];
    builds.push({ worker: b.worker, chunks: b.chunks, modules: b.modules });
  }
  return [
    ...(builds.some((b) => b.modules.some((id) => packageOf(id, repoRoot) === "react-dom"))
      ? []
      : ["apps/ballot: the build reported no react-dom, so the module check would be vacuous"]),
    ...builds.flatMap((b) => moduleViolations(b.modules, repoRoot, isProverBuild(b))),
  ];
}

/**
 * Modules in one build that come from neither an allowed package nor allowed
 * workspace source; `prover` admits the prover worker's code as well.
 */
export function moduleViolations(
  ids: readonly string[],
  repoRoot: string,
  prover = false,
): string[] {
  const violations: string[] = [];
  const sources = prover ? [...WORKSPACE_SOURCES, ...PROVER_SOURCES] : WORKSPACE_SOURCES;
  for (const id of ids) {
    // Virtual modules (a leading NUL, or anything outside the repository) are
    // code a plugin made up, whatever path they name.
    const entry = id.startsWith("\0") ? undefined : storeEntryOf(id, repoRoot);
    if (entry !== undefined) {
      const proverFile = PROVER_PACKAGES.get(entry.name);
      if (proverFile !== undefined) {
        if (!prover || entry.file !== proverFile)
          violations.push(
            `apps/ballot: bundles ${entry.name} (${id}); only its ${proverFile}, and only in the prover worker`,
          );
      } else if (!RUNTIME_PACKAGES.has(entry.name))
        violations.push(
          `apps/ballot: bundles ${entry.name} (${id}); only ${[...RUNTIME_PACKAGES].join(", ")} may run in the client`,
        );
      continue;
    }
    const path = relative(repoRoot, id).split(sep).join(posix.sep);
    if (
      id.startsWith("\0") ||
      path.startsWith("..") ||
      path.split("/").includes("node_modules") ||
      !sources.some((allowed) => path.startsWith(allowed))
    )
      violations.push(`apps/ballot: bundles ${JSON.stringify(id)}, outside ${sources.join(", ")}`);
  }
  return violations;
}

/**
 * The pinned policy's one accepted serialisation. The page must carry exactly
 * these bytes: comparing parsed directives would need our parser to agree
 * with every browser's on whitespace and separators, and it needn't.
 */
export const BALLOT_CSP_TEXT = Object.entries(BALLOT_CSP)
  .map(([name, values]) => [name, ...values].join(" "))
  .join("; ");

const META_END = "[\\t\\n\\f\\r ]*/?>$";
/** The <meta> elements index.html may contain, attributes exact. */
const ALLOWED_METAS: readonly RegExp[] = [
  new RegExp(`^<meta[\\t\\n\\f\\r ]+charset="utf-8"${META_END}`, "i"),
  new RegExp(
    `^<meta[\\t\\n\\f\\r ]+http-equiv="Content-Security-Policy"[\\t\\n\\f\\r ]+content="[^"<>]*"${META_END}`,
  ),
  new RegExp(
    `^<meta[\\t\\n\\f\\r ]+name="referrer"[\\t\\n\\f\\r ]+content="no-referrer"${META_END}`,
  ),
  new RegExp(
    `^<meta[\\t\\n\\f\\r ]+name="viewport"[\\t\\n\\f\\r ]+content="width=device-width, initial-scale=1"${META_END}`,
  ),
];

/** The only elements index.html may contain. */
const PAGE_ELEMENTS: ReadonlySet<string> = new Set([
  "html",
  "head",
  "meta",
  "title",
  "script",
  "link",
  "body",
  "div",
]);

const WS = "[\\t\\n\\f\\r ]";
/** The start every page must have, up to and including the CSP <meta>, whose content it captures. */
const PAGE_PREFIX = new RegExp(
  `^${WS}*<!doctype html>${WS}*<html(?:${WS}+lang="[A-Za-z-]+")?>${WS}*<head>${WS}*` +
    `<meta${WS}+charset="utf-8"${WS}*/?>${WS}*` +
    `<meta${WS}+http-equiv="Content-Security-Policy"${WS}+content="([^"<>]*)"${WS}*/?>`,
  "i",
);

/** Problems with index.html: the CSP's presence, place and value, inline code, non-relative references. */
export function htmlViolations(page: string): string[] {
  const violations: string[] = [];
  const at = (msg: string) => violations.push(`apps/ballot: index.html: ${msg}`);
  // A regex scan doesn't parse HTML as a browser does: a comment (`<!--`,
  // or a bogus one opened by `<?` or `</` before a non-letter) can hide a
  // policy the scan sees, and any text before the metas closes <head>, where
  // a CSP meta is ignored. So the page is ASCII, every `<` opens an allowed
  // element, and it starts with one exact, anchored prefix ending in the CSP.
  if (/[^\t\n\r\x20-\x7e]/.test(page)) at("must be printable ASCII");
  for (const [tag] of page.matchAll(/<(?!!doctype html>)[^>]*/gi)) {
    const name = /^<\/?([a-z][a-z0-9-]*)(?=[\t\n\f\r />]|$)/i.exec(tag)?.[1];
    if (name === undefined || !PAGE_ELEMENTS.has(name.toLowerCase()))
      at(
        `${JSON.stringify(tag.slice(0, 40))}: only <${[...PAGE_ELEMENTS].join(">, <")}> may appear`,
      );
  }
  // Every <meta> is one of the four the client uses: a refresh, say, would
  // navigate voters away, and CSP doesn't govern navigation.
  for (const [meta] of page.matchAll(/<meta\b[^>]*>/gi))
    if (!ALLOWED_METAS.some((allowed) => allowed.test(meta)))
      at(`${JSON.stringify(meta.slice(0, 60))}: not an allowed <meta>`);
  const content = PAGE_PREFIX.exec(page)?.[1];
  if (content === undefined)
    at(
      'must begin <!doctype html><html lang="…"><head><meta charset="utf-8"> and then the Content-Security-Policy <meta>, with only whitespace between',
    );
  else if (content !== BALLOT_CSP_TEXT)
    at(
      `CSP ${JSON.stringify(content)} isn't the pinned policy ${JSON.stringify(BALLOT_CSP_TEXT)} (.github/tools/ci/src/ballot.ts)`,
    );
  if ((page.match(/content-security-policy/gi) ?? []).length !== 1)
    at("must name Content-Security-Policy exactly once");
  for (const [, attrs, body] of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
    if (!/\ssrc="\.\/assets\/[\w-]+\.js"/.test(attrs ?? "") || (body ?? "").trim() !== "")
      at("every <script> must load ./assets/*.js and have no body");
  if (/<style\b/i.test(page)) at("no <style> element");
  if (/\sstyle\s*=/i.test(page)) at("no style attribute");
  if (/\son[a-z]+\s*=/i.test(page)) at("no event-handler attribute");
  for (const [, ref] of page.matchAll(
    /\s(?:src|href|srcset|action|data|poster)\s*=\s*"?([^"\s>]*)/gi,
  ))
    if (!/^\.\/assets\/[\w-]+\.(js|css)$/.test(ref ?? ""))
      at(`${JSON.stringify(ref)}: references must be ./assets/*.js or *.css`);
  return violations;
}

/**
 * APIs that reach the network or load code, banned from every script the page
 * doesn't load itself. Those scripts are the Web Workers, the ballot worker
 * and the prover worker, and a dedicated worker takes its CSP from its own
 * response headers, never from the page's <meta>: on a host that sends none
 * (an IPFS gateway, abolishus.eth), connect-src and Trusted Types don't apply
 * in the worker, where the plaintext, the randomness and the identity secret
 * are. So their I/O stays on the main thread (T-43). A heuristic over the bytes, like the URL scan: code that
 * builds the names at run time evades it, and the worker's own e2e is the
 * other check.
 */
const WORKER_BANNED: readonly RegExp[] = [
  /\bfetch\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bWebTransport\b/,
  /\bEventSource\b/,
  /\bimportScripts\b/,
  /\b(Shared)?Worker\b/,
  /\bimport\(/,
];

/** WebRTC reaches any host and no CSP directive governs it, in a page or a worker. */
const BANNED: readonly RegExp[] = [/\bRTC(PeerConnection|DataChannel)\b/];

/**
 * Problems with the emitted files: unexpected names, URLs, SDK markers, string
 * evaluation, network APIs, workers, and prover artifacts other than the
 * pinned ones (`artifacts`, by extension; tests pass their own).
 */
export function distViolations(
  files: ReadonlyMap<string, string>,
  artifacts: Readonly<Record<string, string>> = PROVER_ARTIFACTS,
): string[] {
  const violations: string[] = [];
  // The scripts index.html loads (a <script src> or a modulepreload <link>).
  const pageScripts = new Set(
    [...(files.get("index.html") ?? "").matchAll(/\s(?:src|href)="\.\/(assets\/[\w-]+\.js)"/g)].map(
      ([, name]) => name,
    ),
  );
  for (const [name, bytes] of files) {
    if (!EMITTED.some((pattern) => pattern.test(name)))
      violations.push(
        `apps/ballot: emits ${name}, which isn't a page, script, style, font, licence or prover artifact`,
      );
    const pinned = artifacts[/\.(zkey|wasm)$/.exec(name)?.[1] ?? ""];
    if (
      pinned !== undefined &&
      createHash("sha256").update(bytes, "latin1").digest("hex") !== pinned
    )
      violations.push(`apps/ballot: emits ${name}, which isn't the pinned prover artifact`);
  }
  // The page loads neither worker, and nothing else is left for it to start.
  const workers = [...files.keys()].filter(
    (name) => name.endsWith(".js") && !pageScripts.has(name),
  );
  for (const name of pageScripts)
    if (name !== undefined && (BALLOT_WORKER.test(name) || PROVER_WORKER.test(name)))
      violations.push(`apps/ballot: index.html loads ${name}, a worker's script`);
  for (const name of workers)
    if (!BALLOT_WORKER.test(name) && !PROVER_WORKER.test(name))
      violations.push(
        `apps/ballot: emits ${name}, a script index.html doesn't load that is neither the ballot worker nor the prover worker`,
      );
  for (const [label, pattern] of [
    ["ballot worker", BALLOT_WORKER],
    ["prover worker", PROVER_WORKER],
  ] as const)
    if (workers.filter((name) => pattern.test(name)).length > 1)
      violations.push(`apps/ballot: emits more than one ${label}`);
  const page = files.get("index.html");
  if (page === undefined) violations.push("apps/ballot: the build has no index.html");
  else violations.push(...htmlViolations(page));
  for (const [name, text] of files) {
    if (!/\.(html|js|css)$/.test(name)) continue;
    const at = (msg: string) => violations.push(`apps/ballot: ${name}: ${msg}`);
    // Escaped slashes (`https:\/\/host`) are the same string in JS.
    for (const [url] of text.matchAll(/\b(?:https?|wss?):(?:\\?\/){2}[^\s"'`)<>]*/g)) {
      const trimmed = url.replace(/\\\//g, "/").replace(/[.,;\\]+$/, "");
      if (!isAllowedUrl(trimmed)) at(`names ${trimmed}`);
    }
    // A heuristic over quoted strings; the CSP's 'self' is the real barrier.
    for (const [ref] of text.matchAll(/["'`(=](?:\\?\/){2}[a-z0-9.-]+\.[a-z]{2,}/gi))
      at(`names a protocol-relative URL ${ref}`);
    for (const marker of ANALYTICS_MARKERS)
      if (marker.test(text)) at(`matches the analytics marker ${marker}`);
    if (name.endsWith(".js")) {
      for (const pattern of [/\beval\(/, /\bnew Function\(/, /\bset(Timeout|Interval)\(\s*["'`]/])
        if (pattern.test(text)) at(`uses ${pattern}, which the CSP refuses`);
      for (const pattern of BANNED) if (pattern.test(text)) at(`uses ${pattern}`);
      if (!pageScripts.has(name))
        for (const pattern of WORKER_BANNED)
          if (pattern.test(text))
            at(
              `uses ${pattern} outside the scripts index.html loads; a worker gets no CSP from the page, so its I/O stays on the main thread`,
            );
    }
  }
  return violations;
}
