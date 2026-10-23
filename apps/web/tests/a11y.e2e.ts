// The accessibility audit's automated pass (P2-28 part 3a): every everyday
// page of the built site, behind its own front (src/node/serve.ts) and
// against the stub API, opened in Chromium once its requests have settled and
// checked by axe against WCAG 2.2 AA's rules, the same set the stories run,
// and axe's best practices. Each page is checked at desktop width and a small
// phone's, in light and dark, where the stories see only their component: the
// whole page, its landmarks and headings, and the frame around it. At the
// phone's width anything past the screen's edge fails too (1.4.10 Reflow): the
// frame clips sideways overflow, so a page never scrolls sideways, and what
// doesn't fit is simply cut off. The keyboard's part of the manual pass
// (part 3b-1) runs on the same pages: Tab through each, checking order, traps,
// what covers the focused control and whether its focus can be seen, and the
// share sheet's hold on focus. A screen reader's reading and whether the text
// says what it should are the rest of part 3b.

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
/** A blank page of the browser's own, with no policy, where screenshots are decoded. */
let canvas: Page;

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
    accountExport: nothing,
    clientDir: `${root}dist/client`,
    origin,
    log: () => {},
  });
  await new Promise<void>((resolve) => site.listen(port, "127.0.0.1", resolve));
  browser = await chromium.launch();
  canvas = await browser.newPage();
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

/**
 * A control a keyboard reaches, by where it is: its tag, its own text or
 * label, and its index among the page's controls in document order.
 */
type Stop = { index: number; name: string; box: Rect };
type Rect = { x: number; y: number; width: number; height: number };

/**
 * Marks every control Tab should reach on `page`, in document order, and
 * returns them: what can take focus (a link, a control that isn't disabled,
 * a frame, anything with a `tabindex`), isn't taken out of the order
 * (`tabindex="-1"`, `inert`) and is drawn, with one stop per group of native
 * radio buttons, as Chromium gives it. An `sr-only` element is drawn (only
 * clipped), so the skip link counts.
 */
function controls(page: Page): Promise<Stop[]> {
  return page.evaluate(() => {
    const focusable =
      "a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]";
    const radios = new Set<string>();
    const out: {
      index: number;
      name: string;
      box: { x: number; y: number; width: number; height: number };
    }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(focusable)) {
      if (el.tabIndex < 0 || el.closest("[inert]") !== null) continue;
      if ((el as HTMLButtonElement).disabled === true) continue;
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      if (el instanceof HTMLInputElement && el.type === "radio" && el.name !== "") {
        const group = document.querySelectorAll<HTMLInputElement>(
          `input[type=radio][name="${CSS.escape(el.name)}"]`,
        );
        const stop = [...group].find((r) => r.checked) ?? group[0];
        if (stop !== el || radios.has(el.name)) continue;
        radios.add(el.name);
      }
      const index = out.length;
      el.dataset["kbStop"] = String(index);
      const text = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
      const type = el instanceof HTMLInputElement ? `[type=${el.type}]` : "";
      const id = el.id === "" ? "" : `#${el.id}`;
      const { x, y, width, height } = el.getBoundingClientRect();
      out.push({
        index,
        name: `${el.tagName.toLowerCase()}${type}${id} "${text}"`,
        box: { x, y, width, height },
      });
    }
    return out;
  });
}

/** The focused element's stop index and its box on the screen, or `null` once focus has left the controls. */
function focused(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el.dataset["kbStop"] === undefined) return null;
    const { x, y, width, height } = el.getBoundingClientRect();
    return { index: Number(el.dataset["kbStop"]), box: { x, y, width, height } };
  });
}

/**
 * Whether the focused element is at least partly on the screen and not
 * covered there by anything else (2.4.11 Focus Not Obscured, Minimum): one
 * of its centre and four inset corners, inside the viewport, hits it or what
 * it contains.
 */
function seen(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const r = el.getBoundingClientRect();
    const inset = (a: number, b: number) => (b - a > 4 ? 2 : 0);
    const xs = [
      r.left + inset(r.left, r.right),
      (r.left + r.right) / 2,
      r.right - inset(r.left, r.right) - 0.01,
    ];
    const ys = [
      r.top + inset(r.top, r.bottom),
      (r.top + r.bottom) / 2,
      r.bottom - inset(r.top, r.bottom) - 0.01,
    ];
    for (const x of xs)
      for (const y of ys) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit !== null && (hit === el || el.contains(hit))) return true;
      }
    return false;
  });
}

/** `box` grown by `by` on every side and cut to the viewport, in whole pixels. */
function around(box: Rect, by: number, viewport: { width: number; height: number }): Rect | null {
  const x = Math.max(0, Math.floor(box.x - by));
  const y = Math.max(0, Math.floor(box.y - by));
  const right = Math.min(viewport.width, Math.ceil(box.x + box.width + by));
  const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height + by));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * How many pixels of two same-sized PNGs differ by a contrast ratio of at
 * least 3:1 (WCAG's relative luminance), decoded on the blank page.
 */
function changedAt3To1(a: Buffer, b: Buffer): Promise<number> {
  return canvas.evaluate(
    async ([a, b]) => {
      const pixels = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const c = new OffscreenCanvas(bitmap.width, bitmap.height);
        const g = c.getContext("2d");
        if (g === null) throw new Error("no 2d context");
        g.drawImage(bitmap, 0, 0);
        return g.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      const channel = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (d: Uint8ClampedArray, i: number) =>
        0.2126 * channel(d[i] ?? 0) +
        0.7152 * channel(d[i + 1] ?? 0) +
        0.0722 * channel(d[i + 2] ?? 0);
      const [p, q] = await Promise.all([pixels(a), pixels(b)]);
      let n = 0;
      for (let i = 0; i < p.length; i += 4) {
        const [hi, lo] = [luminance(p, i), luminance(q, i)].sort((x, y) => y - x) as [
          number,
          number,
        ];
        if ((hi + 0.05) / (lo + 0.05) >= 3) n++;
      }
      return n;
    },
    [a.toString("base64"), b.toString("base64")] as const,
  );
}

/**
 * Tab from the top of `page` to past its end, as the keyboard's part of the
 * manual pass (P2-28 part 3b-1) does: the stops `controls` expects, the ones
 * Tab reached in order, and what was wrong at each. At every stop the
 * control must be on the screen and uncovered (2.4.11), and focusing it must
 * change pixels around it by at least 3:1 against how they look unfocused,
 * for at least its perimeter's length (2.4.7, and 1.4.11 for the
 * indicator): a ring one pixel wide all round, or a thicker one on fewer
 * sides. Transitions run at once, through the debugger, so each picture is
 * the finished state.
 */
async function walk(page: Page, viewport: { width: number; height: number }) {
  const debug = await page.context().newCDPSession(page);
  await debug.send("Animation.enable");
  await debug.send("Animation.setPlaybackRate", { playbackRate: 1e6 });
  const stops = await controls(page);
  const reached: number[] = [];
  const problems: string[] = [];
  // Enough presses for every stop and a date field's parts, and one more to
  // leave the page; a trap runs out of them.
  for (let press = 0; press < 4 * stops.length + 1; press++) {
    await page.keyboard.press("Tab");
    const at = await focused(page);
    if (at === null) break;
    // A date or time field takes one Tab per part and one for its picker's
    // button, inside the browser's own control: one stop, judged as the
    // first part has it, with the field's own ring.
    if (reached.at(-1) === at.index) continue;
    if (reached.length > stops.length) break;
    reached.push(at.index);
    const name = stops[at.index]?.name ?? String(at.index);
    if (!(await seen(page))) problems.push(`${name}: not on the screen or covered`);
    const clip = around(at.box, 6, viewport);
    if (clip === null) continue;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const on = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const off = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
    // Focused again, without scrolling, so the next Tab starts from it and
    // reaches its own key handlers, as a visitor's would.
    await page.evaluate((index) => {
      document
        .querySelector<HTMLElement>(`[data-kb-stop="${index}"]`)
        ?.focus({ preventScroll: true });
    }, at.index);
    const changed = await changedAt3To1(on, off);
    const perimeter = 2 * (Math.round(at.box.width) + Math.round(at.box.height));
    if (changed < perimeter)
      problems.push(
        `${name}: focus changes ${changed} px at 3:1, under its perimeter ${perimeter}`,
      );
  }
  return { stops, reached, problems };
}

describe.each(VIEWS)("the keyboard at $name width", ({ viewport }) => {
  describe.each(SCHEMES)("in %s", (colorScheme) => {
    test.each(PAGES)(
      "%s: Tab reaches the skip link, then every control in order, each on the screen with a visible focus",
      async (path) => {
        const { context, page } = await open(path, { viewport, colorScheme });
        try {
          const { stops, reached, problems } = await walk(page, viewport);
          expect(problems).toEqual([]);
          // The skip link first (2.4.1), on every page with the site's links.
          if (path !== "/offline" && !path.startsWith("/embed/"))
            expect(stops[0]?.name).toBe('a "Skip to content"');
          // Every control once, in document order, then off the page
          // (2.1.1, 2.1.2, 2.4.3).
          expect(reached).toEqual(stops.map((s) => s.index));
        } finally {
          await context.close();
        }
      },
    );
  });
});

describe("the keyboard's walk itself", () => {
  test("finds what it checks for: a control with no focus indicator, one covered, a trap", async () => {
    const { context, page } = await open("/how-it-works", VIEWS[0]);
    try {
      await page.evaluate(() => {
        const main = document.querySelector("main");
        if (main === null) throw new Error("no main");
        const button = (text: string) => {
          const b = document.createElement("button");
          b.textContent = text;
          return b;
        };
        const [plain, covered, trap] = [button("Plain"), button("Covered"), button("Trap")];
        // Through the CSSOM, which the policy's style-src allows.
        plain.style.outline = "none";
        trap.addEventListener("keydown", (e) => {
          if (e.key === "Tab") e.preventDefault();
        });
        main.prepend(plain, covered, trap);
        const box = covered.getBoundingClientRect();
        const cover = document.createElement("div");
        Object.assign(cover.style, {
          position: "absolute",
          left: `${box.left + scrollX - 8}px`,
          top: `${box.top + scrollY - 8}px`,
          width: `${box.width + 16}px`,
          height: `${box.height + 16}px`,
          background: "gray",
        });
        document.body.append(cover);
      });
      const { stops, reached, problems } = await walk(page, VIEWS[0].viewport);
      expect(problems).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^button "Plain": focus changes \d+ px at 3:1/),
          'button "Covered": not on the screen or covered',
        ]),
      );
      expect(stops[reached.at(-1) ?? -1]?.name).toBe('button "Trap"');
      expect(reached.length).toBeLessThan(stops.length);
    } finally {
      await context.close();
    }
  });
});

describe("the keyboard in the share sheet", () => {
  test("opens from its button, holds focus inside while open, and closes back to the button with Escape", async () => {
    const { context, page } = await open(`/polls/${ID}`, VIEWS[0]);
    try {
      const button = page.getByRole("button", { name: "Share this poll" });
      await button.focus();
      await page.keyboard.press("Enter");
      const sheet = page.getByRole("dialog");
      await expect.poll(() => sheet.evaluate((d) => d.contains(document.activeElement))).toBe(true);
      // Round the sheet's controls more than once: a modal keeps focus in
      // (2.4.3), with the page behind it out of reach.
      const controls = await sheet.evaluate(
        (d) => d.querySelectorAll("a[href], button:not([disabled]), input, [tabindex='0']").length,
      );
      for (let i = 0; i < 2 * controls + 2; i++) {
        await page.keyboard.press("Tab");
        // Past the last control focus lands on Base UI's guard, outside the
        // sheet, whose handler sends it back to the first.
        await expect
          .poll(() => sheet.evaluate((d) => d.contains(document.activeElement)))
          .toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect.poll(() => sheet.count()).toBe(0);
      await expect.poll(() => button.evaluate((b) => b === document.activeElement)).toBe(true);
    } finally {
      await context.close();
    }
  });
});
