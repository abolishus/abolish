// The challenge page in a real browser, served by its own server with the
// headers the build wrote, at the origins it would have: the ballot client's
// entry point frames it and receives the token, and nothing else can
// (T-43, T-10). Every origin is a Playwright route, so the browser sees
// HTTPS origins while nothing leaves the machine; Turnstile is a stand-in
// script that records what the page asks of it.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Browser, chromium, type Frame, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { PAGE_POLICY } from "../src/policy.ts";
import { TURNSTILE_SCRIPT } from "../src/turnstile.ts";
import { buildPage, TEST } from "./build.ts";

const CLIENT = "https://ballot.test";
const SECOND = "https://ballot-2.test:8443";
const CHALLENGE = "https://challenge.test";
const OTHER = "https://other.test";
const serve = fileURLToPath(new URL("../server/serve.mjs", import.meta.url));

// Turnstile as far as the page can tell: `render` keeps its options where the
// test can reach them and answers with a widget id; `remove` is counted.
const FAKE_TURNSTILE = `
  window.rendered = [];
  window.removed = [];
  window.turnstile = {
    render(container, options) {
      window.rendered.push({ container: container.id, options });
      return "widget-" + window.rendered.length;
    },
    remove(widget) { window.removed.push(widget); },
  };
`;

// The client's side, reduced to what the test checks: one frame, and every
// message it receives with where it came from.
function parent(src: string): string {
  return `<!doctype html><title>client</title><iframe id="f" src="${src.replaceAll("&", "&amp;")}" title="challenge"></iframe>
<script>
  window.messages = [];
  addEventListener("message", (e) => window.messages.push({
    origin: e.origin,
    fromFrame: e.source === document.getElementById("f").contentWindow,
    data: e.data,
  }));
</script>`;
}

const frameSrc = (origin: string, action = "tier0-register") =>
  `${CHALLENGE}/#origin=${encodeURIComponent(origin)}&action=${action}`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

let outDir: string;
let server: ChildProcess;
let local: string;
let browser: Browser;
let page: Page;
let turnstileRequests: string[];
let unexpected: string[];
let violations: string[];
let consoleErrors: string[];

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "abolish-challenge-e2e-"));
  await buildPage(TEST, outDir);
  const port = await freePort();
  server = spawn(process.execPath, [serve], {
    env: {
      CHALLENGE_DIST: `${outDir}/`,
      CHALLENGE_HOST: "127.0.0.1",
      CHALLENGE_PORT: String(port),
    },
    stdio: "inherit",
  });
  local = `http://127.0.0.1:${port}`;
  // The server says nothing when it is up, so ask until it answers.
  for (let i = 0; ; i++) {
    try {
      await fetch(`${local}/`);
      break;
    } catch (e) {
      if (i === 100 || server.exitCode !== null) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
  if (outDir !== undefined) await rm(outDir, { recursive: true, force: true });
});

beforeEach(async () => {
  turnstileRequests = [];
  unexpected = [];
  violations = [];
  consoleErrors = [];
  page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.exposeFunction("reportViolation", (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { reportViolation(v: string): void }).reportViolation(
        `${e.effectiveDirective} ${e.blockedURI}`,
      ),
    );
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === CHALLENGE) {
      // The real server's answer, headers and all.
      const response = await route.fetch({ url: `${local}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    } else if (url.href === TURNSTILE_SCRIPT) {
      turnstileRequests.push(url.href);
      await route.fulfill({ contentType: "text/javascript", body: FAKE_TURNSTILE });
    } else if ([CLIENT, SECOND, OTHER].includes(url.origin) && url.pathname === "/") {
      await route.fulfill({
        contentType: "text/html",
        body: parent(url.searchParams.get("src") ?? ""),
      });
    } else {
      unexpected.push(url.href);
      await route.abort();
    }
  });
});

afterEach(async () => {
  await page?.close();
});

/** Opens `origin`'s page framing `src`, and the challenge frame once its page has run. */
async function framed(origin: string, src: string): Promise<Frame | undefined> {
  await page.goto(`${origin}/?src=${encodeURIComponent(src)}`);
  await page.waitForLoadState("load");
  return page.frames().find((f) => f.url().startsWith(CHALLENGE));
}

const rendered = (frame: Frame) =>
  frame.evaluate(
    () =>
      (
        window as unknown as {
          rendered?: { container: string; options: Record<string, unknown> }[];
        }
      ).rendered,
  );
const solve = (frame: Frame, token: unknown, n = 0) =>
  frame.evaluate(
    ([t, i]) =>
      (window as unknown as { rendered: { options: { callback(t: unknown): void } }[] }).rendered[
        i as number
      ]?.options.callback(t),
    [token, n] as const,
  );
const messages = () => page.evaluate(() => (window as unknown as { messages: unknown[] }).messages);

describe("the challenge page", () => {
  test("renders one widget for the fragment's action and posts its token to the client once", async () => {
    const frame = await framed(CLIENT, frameSrc(CLIENT));
    expect(frame).toBeDefined();
    await frame?.waitForFunction(
      () =>
        "rendered" in window && (window as unknown as { rendered: unknown[] }).rendered.length > 0,
    );
    const [widget, ...more] = (await rendered(frame as Frame)) ?? [];
    expect(more).toEqual([]);
    expect(widget?.container).toBe("challenge");
    expect(widget?.options).toMatchObject({
      sitekey: TEST.siteKey,
      action: "tier0-register",
      "response-field": false,
    });
    await solve(frame as Frame, "a-token.of_turnstile's~form");
    await solve(frame as Frame, "a-second-token");
    await page.waitForFunction(
      () => (window as unknown as { messages: unknown[] }).messages.length > 0,
    );
    // Give a second message the chance to arrive, if one were posted.
    await page.waitForTimeout(200);
    expect(await messages()).toEqual([
      { origin: CHALLENGE, fromFrame: true, data: { v: 1, token: "a-token.of_turnstile's~form" } },
    ]);
    expect(
      await frame?.evaluate(() => (window as unknown as { removed: string[] }).removed),
    ).toEqual(["widget-1"]);
    expect(turnstileRequests).toEqual([TURNSTILE_SCRIPT]);
    expect(unexpected).toEqual([]);
    expect(violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("renders for the relay's action and for every entry point", async () => {
    const frame = await framed(SECOND, frameSrc(SECOND, "tier1-relay"));
    await frame?.waitForFunction(
      () =>
        "rendered" in window && (window as unknown as { rendered: unknown[] }).rendered.length > 0,
    );
    expect((await rendered(frame as Frame))?.[0]?.options["action"]).toBe("tier1-relay");
    await solve(frame as Frame, "t");
    await page.waitForFunction(
      () => (window as unknown as { messages: unknown[] }).messages.length > 0,
    );
    expect(await messages()).toEqual([
      { origin: CHALLENGE, fromFrame: true, data: { v: 1, token: "t" } },
    ]);
  });

  test("posts nothing for a token outside Turnstile's form", async () => {
    const frame = await framed(CLIENT, frameSrc(CLIENT));
    await frame?.waitForFunction(
      () =>
        "rendered" in window && (window as unknown as { rendered: unknown[] }).rendered.length > 0,
    );
    for (const token of ["", "a b", "x".repeat(2049), 7, { token: "t" }])
      await solve(frame as Frame, token);
    await page.waitForTimeout(200);
    expect(await messages()).toEqual([]);
    expect(
      await frame?.evaluate(() => (window as unknown as { removed: string[] }).removed),
    ).toEqual([]);
  });

  test("can't be framed by a page that isn't an entry point", async () => {
    // Even with the fragment naming the client, the browser refuses the
    // frame (frame-ancestors), so the page never runs and nothing is posted.
    const frame = await framed(OTHER, frameSrc(CLIENT));
    expect(await frame?.evaluate(() => typeof document.getElementById)).not.toBe("function");
    await page.waitForTimeout(200);
    expect(turnstileRequests).toEqual([]);
    expect(await messages()).toEqual([]);
  });

  test("loads nothing for a fragment naming another origin or action, or none", async () => {
    for (const src of [
      frameSrc(OTHER),
      frameSrc(CLIENT, "account-create"),
      `${CHALLENGE}/#action=tier0-register&origin=${encodeURIComponent(CLIENT)}`,
      `${CHALLENGE}/`,
    ]) {
      const frame = await framed(CLIENT, src);
      expect(
        await frame?.evaluate(() => document.getElementById("challenge")?.childElementCount),
      ).toBe(0);
      expect(turnstileRequests, src).toEqual([]);
    }
    expect(unexpected).toEqual([]);
    expect(violations).toEqual([]);
  });

  test("hands a token for another entry point to no one", async () => {
    // The page can't see who framed it; the browser delivers the message only
    // to a parent of the origin it names, so a client framing the page for
    // another entry point gets nothing.
    const frame = await framed(CLIENT, frameSrc(SECOND));
    await frame?.waitForFunction(
      () =>
        "rendered" in window && (window as unknown as { rendered: unknown[] }).rendered.length > 0,
    );
    await solve(frame as Frame, "t");
    await page.waitForTimeout(200);
    expect(await messages()).toEqual([]);
  });

  test("loads nothing when it isn't framed", async () => {
    await page.goto(frameSrc(CLIENT));
    await page.waitForLoadState("load");
    await page.waitForTimeout(200);
    expect(turnstileRequests).toEqual([]);
    expect(violations).toEqual([]);
  });
});

describe("its server", () => {
  test("sends the build's headers with the page, and no cookie", async () => {
    const response = await fetch(`${local}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      `${PAGE_POLICY}; frame-ancestors ${TEST.entryPoints.join(" ")}`,
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.text()).toContain('<div id="challenge"></div>');
  });

  test("serves the page and its assets and nothing else", async () => {
    for (const path of [
      "/index.html",
      "/headers.json",
      "/assets/",
      "/assets/../headers.json",
      "/%2e%2e/package.json",
      "/x",
      "/assets/%ZZ",
    ]) {
      const response = await fetch(`${local}${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-security-policy"), path).not.toBeNull();
    }
    expect((await fetch(`${local}/`, { method: "POST" })).status).toBe(405);
  });
});
