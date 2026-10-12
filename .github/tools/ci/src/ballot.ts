// Bundle and CSP policy for the ballot client (apps/ballot), the only place a
// plaintext vote exists. The brief requires "a test asserts its bundle
// contains no analytics SDK"; AGENTS.md allows it no third-party runtime code
// beyond React and the shadcn/ui runtime; T-43 needs its strict CSP. Those are policies, so
// they live here, under CODEOWNERS, where the PR they judge can't weaken them
// (T-59; AGENTS.md rule B). apps/ballot's own tests may repeat them.
//
// The check builds the client with its own Vite config and judges two
// things: the module graph the build resolved (which npm packages and
// workspace files went in), and the emitted bytes (file names, index.html,
// URLs and SDK markers in every script and stylesheet).

import { posix, relative, sep } from "node:path";

/**
 * npm packages whose code may run in the ballot client: React, and the
 * shadcn/ui runtime the owner allowed on 2026-10-12 (Base UI and its
 * dependencies, class-variance-authority, clsx behind `cn`, lucide-react;
 * docs/PROJECT_BRIEF.md, AGENTS.md "Dependencies"). Adding to it is an
 * owner-reviewed change.
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
]);

/** Workspace files the client may bundle, relative to the repository root. */
export const WORKSPACE_SOURCES = [
  "apps/ballot/src/",
  "apps/ballot/index.html",
  "packages/ui/src/",
] as const;

/**
 * The ballot client's Content Security Policy (T-43). Scripts, styles, fonts
 * and images from its own origin only; no requests (a later change that
 * fetches an election widens connect-src here, under owner review); Trusted
 * Types; no <base> and no form posts.
 */
export const BALLOT_CSP: Readonly<Record<string, readonly string[]>> = {
  "default-src": ["'none'"],
  "script-src": ["'self'"],
  "style-src": ["'self'"],
  "font-src": ["'self'"],
  "img-src": ["'self'"],
  "connect-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "require-trusted-types-for": ["'script'"],
  "trusted-types": ["'none'"],
};

/**
 * URLs that may appear in scripts and stylesheets as inert strings, never
 * fetched: XML namespace names React DOM sets, React's error-decoder link,
 * and Tailwind's licence comment.
 */
export const INERT_URLS: ReadonlySet<string> = new Set([
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/XML/1998/namespace",
  "https://react.dev/errors/",
  "https://tailwindcss.com",
]);

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
  /rollbar/i,
  /heap(analytics|-api)/i,
  /clarity\.ms/i,
  /cloudflareinsights|beacon\.min\.js/i,
  /\bsendBeacon\b/,
];

/** What the build may emit, besides index.html: hashed scripts and styles, self-hosted fonts, licences. */
const EMITTED = [
  /^index\.html$/,
  /^assets\/[\w-]+\.(js|css)$/,
  /^assets\/(oxanium|jetbrains-mono)-[\w-]+\.woff2?$/,
  /^third-party-licenses\.md$/,
  /^font-licenses\.txt$/,
];

/**
 * The npm package a resolved module id belongs to: only a file inside the
 * package's own pnpm store entry under the repository's node_modules, with no
 * node_modules nested below it. Anything else, a directory merely named
 * node_modules included, is undefined and judged as workspace code.
 */
export function packageOf(id: string, repoRoot: string): string | undefined {
  const path = relative(repoRoot, id).split(sep).join(posix.sep);
  const m = /^node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/@][^/]*)\/(.+)$/.exec(
    path,
  );
  if (m === null || m[2]?.split("/").includes("node_modules")) return undefined;
  return m[1];
}

/** Modules in the build that come from neither an allowed package nor allowed workspace source. */
export function moduleViolations(ids: readonly string[], repoRoot: string): string[] {
  const violations: string[] = [];
  for (const id of ids) {
    // Virtual modules (a leading NUL, or anything outside the repository) are
    // code a plugin made up, whatever path they name.
    const pkg = id.startsWith("\0") ? undefined : packageOf(id, repoRoot);
    if (pkg !== undefined) {
      if (!RUNTIME_PACKAGES.has(pkg))
        violations.push(
          `apps/ballot: bundles ${pkg} (${id}); only ${[...RUNTIME_PACKAGES].join(", ")} may run in the client`,
        );
      continue;
    }
    const path = relative(repoRoot, id).split(sep).join(posix.sep);
    if (
      id.startsWith("\0") ||
      path.startsWith("..") ||
      path.split("/").includes("node_modules") ||
      !WORKSPACE_SOURCES.some((allowed) => path.startsWith(allowed))
    )
      violations.push(
        `apps/ballot: bundles ${JSON.stringify(id)}, outside ${WORKSPACE_SOURCES.join(", ")}`,
      );
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

/** Problems with the emitted files: unexpected names, URLs, SDK markers, string evaluation. */
export function distViolations(files: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const name of files.keys())
    if (!EMITTED.some((pattern) => pattern.test(name)))
      violations.push(
        `apps/ballot: emits ${name}, which isn't a page, script, style, font or licence`,
      );
  const page = files.get("index.html");
  if (page === undefined) violations.push("apps/ballot: the build has no index.html");
  else violations.push(...htmlViolations(page));
  for (const [name, text] of files) {
    if (!/\.(html|js|css)$/.test(name)) continue;
    const at = (msg: string) => violations.push(`apps/ballot: ${name}: ${msg}`);
    for (const [url] of text.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)<>\\]*/g)) {
      const trimmed = url.replace(/[.,;]+$/, "");
      if (!INERT_URLS.has(trimmed)) at(`names ${trimmed}`);
    }
    // A heuristic over quoted strings; the CSP's 'self' is the real barrier.
    for (const [ref] of text.matchAll(/["'`(=](?:\\?\/){2}[a-z0-9.-]+\.[a-z]{2,}/gi))
      at(`names a protocol-relative URL ${ref}`);
    for (const marker of ANALYTICS_MARKERS)
      if (marker.test(text)) at(`matches the analytics marker ${marker}`);
    if (name.endsWith(".js"))
      for (const pattern of [/\beval\(/, /\bnew Function\(/, /\bset(Timeout|Interval)\(\s*["'`]/])
        if (pattern.test(text)) at(`uses ${pattern}, which the CSP refuses`);
  }
  return violations;
}
