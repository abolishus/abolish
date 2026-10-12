// What the ballot client's build may contain. The client is the only place a
// plaintext vote exists, so its bundle carries no third-party runtime code
// beyond React, no analytics SDK, no inline script and no other origin, and
// its CSP forbids loading anything else (T-43, T-67, T-41; AGENTS.md,
// Dependencies). The test builds the app itself, so it judges the real output.

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "vite-plus";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { BALLOT_CSP, parseCsp } from "./csp.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const repo = join(root, "..", "..");

/** npm packages whose code may run in the ballot client: the framework only. */
const RUNTIME_PACKAGES = new Set(["react", "react-dom", "scheduler"]);
/** Workspace source the client may bundle. */
const WORKSPACE_SOURCES = ["apps/ballot/src/", "apps/ballot/index.html", "packages/ui/src/"];

/**
 * URLs that appear in the bundle as inert strings, never fetched: XML namespace
 * names React DOM sets on elements, React's error-decoder link in its error
 * messages, and Tailwind's licence comment. The CSP is the network barrier;
 * this list keeps a new origin from slipping in unnoticed.
 */
const INERT_URLS = new Set([
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/XML/1998/namespace",
  "https://react.dev/errors/",
  "https://tailwindcss.com",
]);

/**
 * Markers of analytics, tracking and error-reporting SDKs: their package
 * names, globals and collection hosts (T-67; brief: "a test asserts its
 * bundle contains no analytics SDK").
 */
const ANALYTICS_MARKERS = [
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

let outDir: string;
let moduleIds: string[];
let files: Map<string, string>;

/** The npm package a resolved module id belongs to, or undefined for workspace code. */
function packageOf(id: string): string | undefined {
  const at = id.lastIndexOf(`node_modules${sep}`);
  if (at < 0) return undefined;
  const [scope, name] = id.slice(at + `node_modules${sep}`.length).split(sep);
  return scope?.startsWith("@") ? `${scope}/${name}` : scope;
}

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "abolish-ballot-"));
  const ids: string[] = [];
  const collect: Plugin = {
    name: "collect-module-ids",
    buildEnd() {
      ids.push(...this.getModuleIds());
    },
  };
  // The test runner sets NODE_ENV=test, which would make Vite bundle React's
  // development build; `vp build` runs with production.
  const nodeEnv = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";
  try {
    await build({
      root,
      mode: "production",
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
      plugins: [collect],
    });
  } finally {
    if (nodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = nodeEnv;
  }
  moduleIds = ids;
  files = new Map();
  for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(relative(outDir, path).split(sep).join("/"), await readFile(path, "latin1"));
    }
});

afterAll(async () => {
  if (outDir !== undefined) await rm(outDir, { recursive: true, force: true });
});

const textFiles = () => [...files].filter(([name]) => /\.(html|js|css)$/.test(name));
const html = () => {
  const page = files.get("index.html");
  if (page === undefined) throw new Error("the build has no index.html");
  return page;
};

describe("bundle contents", () => {
  test("bundles no npm package's code but React's", () => {
    const packages = new Set(moduleIds.map(packageOf).filter((p) => p !== undefined));
    expect([...packages].filter((p) => !RUNTIME_PACKAGES.has(p))).toEqual([]);
    // The list isn't vacuous: React is really there.
    expect(packages.has("react-dom")).toBe(true);
  });

  test("bundles workspace code only from the ballot app and @abolishus/ui", () => {
    const outside = moduleIds
      .filter((id) => packageOf(id) === undefined)
      .map((id) => relative(repo, id).split(sep).join("/"))
      .filter((id) => !WORKSPACE_SOURCES.some((allowed) => id.startsWith(allowed)));
    expect(outside).toEqual([]);
  });

  test("emits only the page, scripts, styles and self-hosted IBM Plex fonts", () => {
    const unexpected = [...files.keys()].filter(
      (name) =>
        name !== "index.html" &&
        name !== "third-party-licenses.md" &&
        !/^assets\/[\w-]+\.(js|css)$/.test(name) &&
        !/^assets\/ibm-plex-(sans|mono|serif)-[\w-]+\.woff2?$/.test(name),
    );
    expect(unexpected).toEqual([]);
  });

  test("contains no analytics, tracking or error-reporting SDK", () => {
    const found = textFiles().flatMap(([name, text]) =>
      ANALYTICS_MARKERS.filter((marker) => marker.test(text)).map((m) => `${name}: ${m}`),
    );
    expect(found).toEqual([]);
  });

  test("names no URL but the inert ones", () => {
    const urls = textFiles().flatMap(([name, text]) =>
      [...text.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)<>]*/g)]
        .map(([url]) => url.replace(/[.,;]+$/, ""))
        .filter((url) => !INERT_URLS.has(url))
        .map((url) => `${name}: ${url}`),
    );
    expect(urls).toEqual([]);
  });

  test("names no protocol-relative URL", () => {
    const urls = textFiles().flatMap(([name, text]) =>
      [...text.matchAll(/["'`(]\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)].map(([url]) => `${name}: ${url}`),
    );
    expect(urls).toEqual([]);
  });

  test("never uses eval, Function or string timers, which the CSP would refuse anyway", () => {
    const found = textFiles()
      .filter(([name]) => name.endsWith(".js"))
      .flatMap(([name, text]) =>
        [/\beval\(/, /\bnew Function\(/, /\bset(Timeout|Interval)\(\s*["'`]/]
          .filter((pattern) => pattern.test(text))
          .map((pattern) => `${name}: ${pattern}`),
      );
    expect(found).toEqual([]);
  });
});

describe("index.html", () => {
  test("carries the ballot CSP as the first element after the charset", () => {
    const page = html();
    // A policy in a <meta> applies only to what comes after it, so nothing of
    // any kind may precede it but the charset declaration.
    const tags = [...page.matchAll(/<([a-z]+)\b([^>]*)>/gi)]
      .map(([, name, attrs]) => ({ name: name?.toLowerCase(), attrs: attrs ?? "" }))
      .filter(({ name }) => name !== "html" && name !== "head");
    expect(tags[0]).toEqual({ name: "meta", attrs: ' charset="utf-8" /' });
    const csp = tags[1];
    expect(csp?.name).toBe("meta");
    expect(csp?.attrs).toMatch(/^\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/$/);
    expect(parseCsp(/content="([^"]*)"/.exec(csp?.attrs ?? "")?.[1] ?? "")).toEqual(BALLOT_CSP);
    // Exactly one policy, however its attributes are written.
    expect(page.match(/content-security-policy/gi)).toHaveLength(1);
  });

  test("has no inline script, style or event handler", () => {
    const page = html();
    for (const [, attrs, body] of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(attrs).toMatch(/\ssrc="\.\/assets\/[\w-]+\.js"/);
      expect(body?.trim()).toBe("");
    }
    expect(page).not.toMatch(/<style\b/i);
    expect(page).not.toMatch(/\sstyle=/i);
    expect(page).not.toMatch(/\son[a-z]+=/i);
  });

  test("loads every resource by a relative path, so one build serves from any origin", () => {
    const refs = [...html().matchAll(/\s(?:src|href)="([^"]*)"/gi)].map(([, ref]) => ref);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(/^\.\/assets\/[\w-]+\.(js|css)$/);
  });
});
