// Bundle and CSP policy for the ballot client (apps/ballot), the only place a
// plaintext vote exists. The brief requires "a test asserts its bundle
// contains no analytics SDK"; AGENTS.md allows it no third-party runtime code
// beyond the framework; T-43 needs its strict CSP. Those are policies, so
// they live here, under CODEOWNERS, where the PR they judge can't weaken them
// (T-59; AGENTS.md rule B). apps/ballot's own tests may repeat them.
//
// The check builds the client with its own Vite config and judges two
// things: the module graph the build resolved (which npm packages and
// workspace files went in), and the emitted bytes (file names, index.html,
// URLs and SDK markers in every script and stylesheet).

import { posix, relative, sep } from "node:path";

/** npm packages whose code may run in the ballot client: the framework only. */
export const RUNTIME_PACKAGES: ReadonlySet<string> = new Set(["react", "react-dom", "scheduler"]);

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

/** What the build may emit, besides index.html: hashed scripts and styles, IBM Plex fonts, licences. */
const EMITTED = [
  /^index\.html$/,
  /^assets\/[\w-]+\.(js|css)$/,
  /^assets\/ibm-plex-(sans|mono|serif)-[\w-]+\.woff2?$/,
  /^third-party-licenses\.md$/,
  /^font-licenses\.txt$/,
];

/** The npm package a resolved module id belongs to, or undefined for anything else. */
export function packageOf(id: string): string | undefined {
  const parts = id.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return undefined;
  const scope = parts[at + 1];
  return scope?.startsWith("@") ? `${scope}/${parts[at + 2] ?? ""}` : scope;
}

/** Modules in the build that come from neither an allowed package nor allowed workspace source. */
export function moduleViolations(ids: readonly string[], repoRoot: string): string[] {
  const violations: string[] = [];
  for (const id of ids) {
    const pkg = packageOf(id);
    if (pkg !== undefined) {
      if (!RUNTIME_PACKAGES.has(pkg))
        violations.push(
          `apps/ballot: bundles ${pkg} (${id}); only ${[...RUNTIME_PACKAGES].join(", ")} may run in the client`,
        );
      continue;
    }
    // Virtual modules (a leading NUL or a scheme) are code a plugin made up.
    const path = relative(repoRoot, id).split(sep).join(posix.sep);
    if (
      id.startsWith("\0") ||
      path.startsWith("..") ||
      !WORKSPACE_SOURCES.some((allowed) => path.startsWith(allowed))
    )
      violations.push(
        `apps/ballot: bundles ${JSON.stringify(id)}, outside ${WORKSPACE_SOURCES.join(", ")}`,
      );
  }
  return violations;
}

/** Parses a serialised policy; a repeated directive, which browsers ignore, is an error. */
export function parseCsp(policy: string): Record<string, string[]> {
  const parsed: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name === undefined || name === "") continue;
    const key = name.toLowerCase();
    if (Object.hasOwn(parsed, key)) throw new Error(`repeated CSP directive ${key}`);
    parsed[key] = values;
  }
  return parsed;
}

const sameCsp = (a: Record<string, readonly string[]>, b: Record<string, readonly string[]>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(
    ([k, v]) => Object.hasOwn(b, k) && JSON.stringify(v) === JSON.stringify(b[k]),
  );

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

/** Problems with index.html: the CSP's presence, place and value, inline code, non-relative references. */
export function htmlViolations(page: string): string[] {
  const violations: string[] = [];
  const at = (msg: string) => violations.push(`apps/ballot: index.html: ${msg}`);
  // Comments, CDATA and raw-text elements hide markup from the tag scan
  // below (a commented-out policy would pass it while the browser applies
  // none), so the page may hold only the doctype and a fixed set of elements.
  if (/<!(?!doctype html>)/i.test(page)) at("no comment, CDATA or declaration but <!doctype html>");
  for (const [, name] of page.matchAll(/<\/?([a-z][a-z0-9-]*)/gi))
    if (!PAGE_ELEMENTS.has((name ?? "").toLowerCase())) at(`no <${name}> element`);
  // A policy in a <meta> applies only to what comes after it, so nothing of
  // any kind may precede it but the charset declaration.
  const tags = [...page.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)]
    .map(([, name, attrs]) => ({ name: (name ?? "").toLowerCase(), attrs: attrs ?? "" }))
    .filter(({ name }) => name !== "html" && name !== "head");
  if (!(tags[0]?.name === "meta" && /^\s+charset="utf-8"\s*\/?$/i.test(tags[0].attrs)))
    at('the first element must be <meta charset="utf-8">');
  const csp = tags[1];
  const content =
    csp?.name === "meta"
      ? /^\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?$/.exec(csp.attrs)?.[1]
      : undefined;
  if (content === undefined) at("the second element must be the Content-Security-Policy <meta>");
  else {
    try {
      if (!sameCsp(parseCsp(content), BALLOT_CSP))
        at(
          `CSP ${JSON.stringify(content)} differs from the pinned policy (.github/tools/ci/src/ballot.ts)`,
        );
    } catch (e) {
      at(`CSP: ${(e as Error).message}`);
    }
  }
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
