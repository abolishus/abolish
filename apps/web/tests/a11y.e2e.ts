// The accessibility audit's automated pass (P2-28 part 3a): every everyday
// page of the built site, behind its own front (src/node/serve.ts) and
// against the stub API, opened in Chromium once its requests have settled and
// checked by axe against WCAG 2.2 AA's rules, the same set the stories run,
// and axe's best practices. Each page is checked at desktop width and a small
// phone's, in light and dark, where the stories see only their component: the
// whole page, its landmarks and headings, and the frame around it. At the
// phone's width anything past the screen's edge fails too (1.4.10 Reflow): the
// frame clips sideways overflow, so a page never scrolls sideways, and what
// doesn't fit is simply cut off. What axe can't judge (whether text says what
// it should, keyboard order, a screen reader's reading) is the audit's manual
// pass, part 3b.

import type { Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import axe from "axe-core";
import { type Browser, type BrowserContextOptions, chromium, type Page } from "playwright";
import { createBuilder } from "vite-plus";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createWebServer, type StartHandler } from "../src/node/serve.ts";
import {
  BALLOT,
  CODE,
  HIDDEN_ID,
  ID,
  OPEN_MANY_CODE,
  OPEN_ONE_CODE,
  QUESTIONS_ID,
  STREAM_V5,
  stubApi,
} from "./stub-api.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Nothing on these pages reaches drafts, e-mail, a token, reactions or profiles: they answer 404. */
const nothing = async () => new Response("{}", { status: 404 });
/** No one is signed in: the session is `null`, as Better Auth answers a visitor without one. */
const noSession = async () => Response.json(null);

/**
 * The rules the stories run (.storybook/preview.tsx), WCAG 2.2 AA, and axe's
 * best practices, which judge what only a whole page has: one `main`, all
 * content in landmarks, one `h1`, headings in order.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/** Every everyday page, as a visitor with no account sees it. */
const PAGES = [
  "/",
  "/discover",
  "/discover?q=park",
  "/how-it-works",
  "/polls",
  `/polls/${ID}`,
  `/polls/${QUESTIONS_ID}`,
  `/polls/${STREAM_V5}`,
  `/polls/${HIDDEN_ID}`,
  `/polls/${ID}/board`,
  `/p/${CODE}/flyer`,
  `/embed/p/${OPEN_ONE_CODE}`,
  `/embed/p/${OPEN_MANY_CODE}`,
  "/moderation",
  "/account",
  "/account/polls/new",
  "/account/verify",
  "/offline",
  "/nowhere",
];

const VIEWS = [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "phone", viewport: { width: 360, height: 780 } },
] as const;
const SCHEMES = ["light", "dark"] as const;

let api: Server;
let site: Server;
let origin: string;
let browser: Browser;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

beforeAll(async () => {
  api = stubApi();
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  process.env["API_URL"] = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  // Cloudflare's published test key, so the poll form draws its widget's place.
  process.env["TURNSTILE_SITE_KEY"] = "1x00000000000000000000AA";
  process.env["BALLOT_URL"] = BALLOT;
  const nodeEnv = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";
  try {
    await (await createBuilder({ root, logLevel: "warn" })).buildApp();
  } finally {
    if (nodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = nodeEnv;
  }
  const start = (
    (await import(pathToFileURL(`${root}dist/server/server.js`).href)) as { default: StartHandler }
  ).default;
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  site = createWebServer({
    start,
    accounts: noSession,
    drafts: nothing,
    email: nothing,
    phone: nothing,
    token: nothing,
    reactions: nothing,
    profiles: nothing,
    clientDir: `${root}dist/client`,
    origin,
    log: () => {},
  });
  await new Promise<void>((resolve) => site.listen(port, "127.0.0.1", resolve));
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.closeAllConnections();
  await new Promise((resolve) => site?.close(resolve) ?? resolve(undefined));
  await new Promise((resolve) => api?.close(resolve) ?? resolve(undefined));
});

/** A violation as one line: the rule, and each node it found by its selector. */
const describeViolation = (v: axe.Result) =>
  `${v.id} (${v.impact ?? "?"}): ${v.help}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`;

/**
 * `path` opened once its requests have settled, in a context of its own, with nothing
 * beyond the site: Turnstile's script would make the test wait on the
 * network, and the widget is Cloudflare's to audit. An embed's policy
 * sandboxes it without script, where the debugger can't run axe either; it
 * has no script of its own, so it draws the same without its policy. Every
 * other page keeps its own.
 */
async function open(path: string, options: BrowserContextOptions = {}) {
  const context = await browser.newContext({
    ...options,
    bypassCSP: path.startsWith("/embed/"),
  });
  const page = await context.newPage();
  await page.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );
  await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
  return { context, page };
}

/**
 * Axe's violations on `page`, as lines. It runs through the debugger, not the
 * page, so the site's policy (no inline script) still holds.
 */
async function audit(page: Page) {
  await page.evaluate(axe.source);
  const violations = await page.evaluate(
    (values) =>
      (window as unknown as { axe: typeof axe }).axe
        .run(document, { runOnly: { type: "tag", values } })
        .then((r) => r.violations),
    TAGS,
  );
  return violations.map(describeViolation);
}

/**
 * The elements drawn past the right edge of the screen, by selector: cut off
 * by the frame's clip, unless a box between them and the page scrolls
 * sideways itself (a wide table's own scroller, which 1.4.10 allows).
 */
function pastTheEdge(page: Page) {
  return page.evaluate(() => {
    const scrolls = (el: Element) => /auto|scroll/.test(getComputedStyle(el).overflowX);
    const out: string[] = [];
    for (const el of document.body.querySelectorAll("*")) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.right <= innerWidth + 0.5) continue;
      let up = el.parentElement;
      while (up !== null && !scrolls(up)) up = up.parentElement;
      if (up === null) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`);
    }
    return out;
  });
}

describe.each(VIEWS)("at $name width", ({ name, viewport }) => {
  describe.each(SCHEMES)("in %s", (colorScheme) => {
    test.each(PAGES)(
      "%s passes WCAG 2.2 AA's automated rules and axe's best practices",
      async (path) => {
        const { context, page } = await open(path, { viewport, colorScheme });
        try {
          expect(await audit(page)).toEqual([]);
          if (name === "phone") expect(await pastTheEdge(page)).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );
  });
});

describe("the audit itself", () => {
  test("finds what it checks for: an image with no text, a second main, a page too wide", async () => {
    const { context, page } = await open("/how-it-works", VIEWS[1]);
    try {
      await page.evaluate(() => {
        const main = document.querySelector("main");
        if (main === null) throw new Error("no main");
        const image = document.createElement("img");
        image.src = "/icons/icon-192.png";
        const wide = document.createElement("div");
        // Through the CSSOM, which the policy's style-src allows.
        wide.className = "too-wide";
        wide.style.width = "2000px";
        main.append(image, wide);
        document.body.append(document.createElement("main"));
      });
      const found = (await audit(page)).map((line) => line.slice(0, line.indexOf(" ")));
      expect(found).toEqual(expect.arrayContaining(["image-alt", "landmark-no-duplicate-main"]));
      expect(await pastTheEdge(page)).toEqual(["div.too-wide"]);
    } finally {
      await context.close();
    }
  });
});
