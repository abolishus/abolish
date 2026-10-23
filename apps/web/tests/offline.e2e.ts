// The offline shell in a real browser (P2-28 part 1b): the built site behind
// its own front (src/node/serve.ts), opened in Chromium, which installs
// `/sw.js`; then the server goes away and a page is opened again. What the
// unit tests can't show: that the worker registers under the site's policy,
// that the browser runs it as served, and that the offline page draws with
// its stylesheet and fonts from the cache, with no policy violation.

import type { Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { createBuilder } from "vite-plus";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { CACHE_PREFIX, OFFLINE_PATH } from "../src/app/offline.ts";
import { createWebServer, type StartHandler } from "../src/node/serve.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Nothing on this page reaches an account or the API: they answer 404. */
const nothing = async () => new Response("{}", { status: 404 });

let start: StartHandler;
let port: number;
let server: Server | undefined;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let violations: string[];

/** A port free now, so the site's origin is known before its server starts. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function up() {
  const origin = `http://127.0.0.1:${port}`;
  server = createWebServer({
    start,
    accounts: nothing,
    drafts: nothing,
    email: nothing,
    phone: nothing,
    token: nothing,
    reactions: nothing,
    profiles: nothing,
    accountExport: nothing,
    push: nothing,
    clientDir: `${root}dist/client`,
    origin,
    log: () => {},
  });
  await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));
  return origin;
}

async function down() {
  const s = server;
  server = undefined;
  if (s === undefined) return;
  s.closeAllConnections();
  await new Promise((resolve) => s.close(resolve));
}

beforeAll(async () => {
  const builder = await createBuilder({ root, logLevel: "warn" });
  await builder.buildApp();
  start = (
    (await import(pathToFileURL(`${root}dist/server/server.js`).href)) as { default: StartHandler }
  ).default;
  port = await freePort();
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await down();
});

beforeEach(async () => {
  violations = [];
  context = await browser.newContext();
  page = await context.newPage();
  await page.exposeFunction("reportViolation", (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { reportViolation(v: string): void }).reportViolation(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
});

afterEach(async () => {
  await context?.close();
  await down();
});

/** Opens `path` and waits until the worker controls the page. */
async function installed(origin: string, path: string) {
  await page.goto(`${origin}${path}`);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 30_000,
  });
}

describe("the offline shell", () => {
  test("installs from the first page and keeps only the offline page and its files", async () => {
    const origin = await up();
    await installed(origin, "/how-it-works");
    const kept = await page.evaluate(async () => {
      const out: Record<string, string[]> = {};
      for (const name of await caches.keys())
        out[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
      return out;
    });
    const names = Object.keys(kept);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^${CACHE_PREFIX}[0-9a-f]{32}$`));
    const paths = kept[names[0]!]!;
    expect(paths).toContain(OFFLINE_PATH);
    for (const path of paths.filter((p) => p !== OFFLINE_PATH))
      expect(path).toMatch(/^\/assets\/[\w-]+\.(css|woff2)$/);
    expect(paths.filter((p) => p.endsWith(".css"))).toHaveLength(1);
    expect(paths.filter((p) => p.endsWith(".woff2")).length).toBeGreaterThan(0);
    // The page it was registered from is not among them.
    expect(paths).not.toContain("/how-it-works");
    expect(violations).toEqual([]);
  });

  test("shows the offline page, styled, when the site can't be reached", async () => {
    const origin = await up();
    await installed(origin, "/how-it-works");
    await down();

    await page.goto(`${origin}/polls?after=3`);
    // The address is still the one asked for; the page says what happened.
    expect(page.url()).toBe(`${origin}/polls?after=3`);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe(
      "You're offline",
    );
    // Drawn with the site's stylesheet and its own font, both from the cache.
    expect(
      await page.evaluate(async () => {
        await document.fonts.ready;
        const h1 = document.querySelector("h1")!;
        return {
          font: getComputedStyle(h1).fontFamily,
          loaded: document.fonts.check(`16px "Oxanium Variable"`),
          scripts: document.scripts.length,
        };
      }),
    ).toEqual({ font: expect.stringContaining("Oxanium"), loaded: true, scripts: 0 });
    expect(violations).toEqual([]);
  });

  test("once the site is back, 'Try again' opens the page that was asked for", async () => {
    const origin = await up();
    await installed(origin, "/how-it-works");
    const heading = await page.getByRole("heading", { level: 1 }).textContent();
    await down();
    await page.goto(`${origin}/how-it-works`);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe(
      "You're offline",
    );
    await up();
    await page.getByRole("link", { name: "Try again" }).click();
    await page.waitForURL(`${origin}/how-it-works`);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe(heading);
    expect(violations).toEqual([]);
  });
});
