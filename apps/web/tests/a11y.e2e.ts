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
// share sheet's hold on focus. A screen reader's part (part 3b-2) reads each
// page's accessibility tree, what Chromium hands a screen reader: every page
// has a title of its own, nothing is read twice in a row, every control's
// name holds the words it shows, and links of one name lead to one place
// unless what is around them tells them apart. The text's part (part 3b-3)
// reads each page as a reader who needs its text larger or more spaced out:
// in the catalog's language, nothing cut off or drawn over other text as it
// is, with WCAG's text spacing (1.4.12) or at twice its size (1.4.4). The
// words themselves are held to the voice in tests/messages.test.ts.

import type { Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import axe from "axe-core";
import { type Browser, type BrowserContextOptions, chromium, type Page } from "playwright";
import { createBuilder } from "vite-plus";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { OFFLINE_PATH, offlinePath } from "../src/app/offline.ts";
import { DEFAULT_LOCALE, isLocale, LOCALES } from "../src/locales.ts";
import { loadCatalog } from "../src/messages.ts";
import { titles } from "../src/titles.ts";
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
  CELLS_ID,
  stubApi,
  SWAPPED_ID,
  UNKNOWN_ID,
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
  "/verify",
  "/polls",
  `/polls/${ID}`,
  `/polls/${QUESTIONS_ID}`,
  `/polls/${STREAM_V5}`,
  `/polls/${HIDDEN_ID}`,
  `/polls/${ID}/board`,
  `/polls/${CELLS_ID}/results`,
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

/**
 * Each page in every language the site has (P2-28 part 4), chosen as a
 * visitor's browser chooses it, by `Accept-Language`: another language's
 * words are longer or shorter, and its labels are translated apart from
 * the text they name.
 */
const IN_LOCALES = LOCALES.map((locale) => ({ locale }));

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
    push: nothing,
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
async function open(
  path: string,
  options: BrowserContextOptions = {},
  prepare?: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({
    ...options,
    bypassCSP: path.startsWith("/embed/"),
  });
  const page = await context.newPage();
  await page.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );
  await prepare?.(page);
  // The offline page's language is its address's, not the browser's (P2-28
  // part 4c): a visitor reading in a locale gets that locale's, as the
  // worker their pages registered keeps it.
  const at = path === OFFLINE_PATH && isLocale(options.locale) ? offlinePath(options.locale) : path;
  await page.goto(`${origin}${at}`, { waitUntil: "networkidle" });
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
  describe.each(
    // Every language in light, and the source one in dark too: the palette
    // doesn't change with the words.
    [
      ...LOCALES.map((locale) => ({ colorScheme: "light" as const, locale })),
      ...SCHEMES.filter((scheme) => scheme !== "light").map((colorScheme) => ({
        colorScheme,
        locale: DEFAULT_LOCALE,
      })),
    ],
  )("in $colorScheme, in $locale", ({ colorScheme, locale }) => {
    test.each(PAGES)(
      "%s passes WCAG 2.2 AA's automated rules and axe's best practices",
      async (path) => {
        const { context, page } = await open(path, { viewport, colorScheme, locale });
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
    // The perimeter of the part on the screen: a control the browser leaves
    // straddling the screen's edge when focused (Chromium scrolls only one
    // wholly out of sight) shows its ring only there, and `seen` has already
    // judged whether enough of it is in sight.
    const visible = (from: number, size: number, end: number) =>
      Math.round(Math.min(end, from + size) - Math.max(0, from));
    const perimeter =
      2 *
      (visible(at.box.x, at.box.width, viewport.width) +
        visible(at.box.y, at.box.height, viewport.height));
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

/**
 * A node of the page's accessibility tree, as Chromium gives it to a screen
 * reader, with the nodes it ignores (a layout `div`, anything `aria-hidden`
 * and what isn't drawn) left out and their children kept in their place.
 */
type Read = {
  role: string;
  name: string;
  description: string;
  url: string | undefined;
  children: Read[];
};

async function readTree(page: Page): Promise<Read> {
  const debug = await page.context().newCDPSession(page);
  const { nodes } = await debug.send("Accessibility.getFullAXTree");
  await debug.detach();
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const value = (v: { value?: unknown } | undefined) =>
    typeof v?.value === "string" ? v.value : "";
  const flatten = (id: string): Read[] => {
    const node = byId.get(id);
    if (node === undefined) return [];
    const children = (node.childIds ?? []).flatMap(flatten);
    if (node.ignored === true) return children;
    const url = node.properties?.find((p) => p.name === "url")?.value.value;
    return [
      {
        role: value(node.role),
        name: value(node.name),
        description: value(node.description),
        url: typeof url === "string" ? url : undefined,
        children,
      },
    ];
  };
  const root = nodes.find((n) => n.parentId === undefined);
  if (root === undefined) throw new Error("no accessibility tree");
  const [tree] = flatten(root.nodeId);
  if (tree === undefined) throw new Error("the whole page is ignored");
  return tree;
}

/** Words as a screen reader compares them: case and spacing aside. */
const plain = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The text `node` holds, in order, as its static text nodes give it. */
function texts(node: Read): string[] {
  if (node.role === "StaticText") return [node.name];
  // A list's bullet or number is the browser's, not the page's words.
  if (node.role === "ListMarker") return [];
  return node.children.flatMap(texts);
}

/**
 * Roles a screen reader reads as a line or a part of their own, saying the
 * role or pausing between them: the same words in two of them (two list
 * items, a cell and the next) are two things, not one said twice.
 */
const BLOCKS = new Set([
  "banner",
  "main",
  "contentinfo",
  "navigation",
  "complementary",
  "search",
  "form",
  "region",
  "article",
  "dialog",
  "group",
  "figure",
  "list",
  "listitem",
  "table",
  "caption",
  "row",
  "cell",
  "columnheader",
  "rowheader",
  "heading",
  "paragraph",
  "term",
  "definition",
  "link",
  "button",
]);

/**
 * What isn't words: a code or hash, which can repeat a part of itself, and
 * a field's own parts, which are the browser's (a date field's blanks).
 */
const NOT_WORDS = new Set([
  "code",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "spinbutton",
  "slider",
  "date",
  "time",
  "DateTime",
  "InputTime",
]);

/** The words `node` reads, in order, with `null` wherever a screen reader starts a new part. */
function runs(node: Read): (string | null)[] {
  if (node.role === "StaticText") return [plain(node.name)];
  if (node.role === "ListMarker" || NOT_WORDS.has(node.role)) return [null];
  const inner = node.children.flatMap(runs);
  return BLOCKS.has(node.role) ? [null, ...inner, null] : inner;
}

/** Roles a person activates or sets, whose name a screen reader announces with them. */
const NAMED_BY_CONTENT = new Set([
  "link",
  "button",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
]);

/**
 * Containers whose name a screen reader says on entering them, and so the
 * context a link's purpose can be told from (2.4.4: "together with its
 * programmatically determined link context").
 */
const CONTEXTS = new Set([
  "article",
  "list",
  "region",
  "navigation",
  "group",
  "complementary",
  "form",
  "search",
  "dialog",
  "row",
]);

/**
 * What a screen reader's pass over `page` finds wrong, as lines:
 * - the same words read twice in a row within one part of the page (a
 *   status beside a line that repeats it);
 * - a control whose name doesn't hold the text it shows (2.5.3 Label in
 *   Name), so a voice user saying what they see misses it, and a screen
 *   reader says something other than what is on the screen;
 * - links of one name leading to different places with nothing to tell them
 *   apart: not their description, not the nearest named container around
 *   them (2.4.4 Link Purpose, In Context).
 */
async function hear(page: Page): Promise<string[]> {
  const tree = await readTree(page);
  const problems: string[] = [];
  const read = runs(tree).filter((t) => t !== "");
  read.forEach((t, i) => {
    if (t !== null && read[i - 1] === t) problems.push(`read twice: "${t}"`);
  });
  const links = new Map<string, Set<string>>();
  const walk = (node: Read, context: string) => {
    if (NAMED_BY_CONTENT.has(node.role)) {
      const shown = texts(node).join("").replace(/\s+/g, "").toLowerCase();
      const name = node.name.replace(/\s+/g, "").toLowerCase();
      if (!name.includes(shown))
        problems.push(
          `${node.role} "${node.name}" doesn't hold its text "${texts(node).join("")}"`,
        );
    }
    if (node.role === "link" && node.url !== undefined) {
      const key = `${plain(node.name)}|${plain(node.description)}|${context}`;
      links.set(key, (links.get(key) ?? new Set()).add(node.url));
    }
    const inner =
      CONTEXTS.has(node.role) && node.name !== "" ? `${node.role} "${plain(node.name)}"` : context;
    for (const child of node.children) walk(child, inner);
  };
  walk(tree, "the page");
  for (const [key, urls] of links)
    if (urls.size > 1) {
      const [name, , context] = key.split("|");
      problems.push(`links "${name}" in ${context} lead to ${[...urls].join(", ")}`);
    }
  return problems;
}

describe.each(VIEWS)("a screen reader at $name width", ({ viewport }) => {
  describe.each(IN_LOCALES)("in $locale", ({ locale }) => {
    test.each(PAGES)(
      "%s: nothing read twice, every control named with its text, every link's purpose told",
      async (path) => {
        const { context, page } = await open(path, { viewport, locale });
        try {
          expect(await hear(page)).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );
  });
});

describe("a screen reader's reading itself", () => {
  test("finds what it checks for: words read twice, a name hiding its text, two links alike", async () => {
    const { context, page } = await open("/how-it-works", VIEWS[0]);
    try {
      await page.evaluate(() => {
        const main = document.querySelector("main");
        if (main === null) throw new Error("no main");
        const twice = document.createElement("p");
        const [a, b] = [document.createElement("span"), document.createElement("span")];
        a.textContent = "Closed";
        b.textContent = "Closed";
        twice.append(a, document.createElement("br"), b);
        const hidden = document.createElement("button");
        hidden.textContent = "Send";
        hidden.setAttribute("aria-label", "Submit the form");
        const link = (href: string) => {
          const l = document.createElement("a");
          l.href = href;
          l.textContent = "Read more";
          return l;
        };
        main.prepend(twice, hidden, link("/polls"), link("/moderation"));
      });
      expect(await hear(page)).toEqual(
        expect.arrayContaining([
          'read twice: "closed"',
          'button "Submit the form" doesn\'t hold its text "Send"',
          expect.stringMatching(
            /^links "read more" in the page lead to .*\/polls, .*\/moderation$/,
          ),
        ]),
      );
    } finally {
      await context.close();
    }
  });
});

describe("each page's title", () => {
  test("names the page, before the site's name, with no two pages alike and nothing typed into the address", async () => {
    // The pages, a topic's page, a place, a poll that isn't there and one
    // whose server sent another poll's definition.
    const paths = [
      ...PAGES,
      "/discover?topic=housing",
      "/discover?place=Old%20Town",
      `/polls/${UNKNOWN_ID}`,
      `/polls/${SWAPPED_ID}`,
    ];
    const titles = new Map<string, string>();
    for (const path of paths) {
      const { context, page } = await open(path, VIEWS[0]);
      try {
        titles.set(path, await page.title());
      } finally {
        await context.close();
      }
    }
    // The home page is the site's name alone; every other page leads with its own.
    expect(titles.get("/")).toBe("Abolish");
    for (const [path, title] of titles)
      if (path !== "/") expect(title, path).toMatch(/^\S.* · Abolish$/);
    expect(titles.get("/nowhere")).toBe("Page not found · Abolish");
    expect(titles.get(`/polls/${UNKNOWN_ID}`)).toBe("Page not found · Abolish");
    expect(titles.get(`/polls/${SWAPPED_ID}`)).toBe("Poll unavailable · Abolish");
    expect(titles.get("/discover?topic=housing")).toBe("Housing · Discover · Abolish");
    expect(titles.get(`/polls/${ID}`)).toBe(`Poll ${ID.slice(0, 16)}… · Abolish`);
    // A search or a place narrows the stream without naming it (T-67).
    for (const path of ["/discover?q=park", "/discover?place=Old%20Town"])
      expect(titles.get(path), path).toBe(titles.get("/discover"));
    // Every other page's title is its own.
    const alike = new Map<string, string[]>();
    for (const [path, title] of titles)
      if (!path.startsWith("/discover?q=") && !path.startsWith("/discover?place="))
        alike.set(title, [...(alike.get(title) ?? []), path]);
    expect([...alike.values()].filter((p) => p.length > 1)).toEqual([
      // A poll that isn't there is the site's 404.
      ["/nowhere", `/polls/${UNKNOWN_ID}`],
    ]);
  });
});

/**
 * The text a box around it cuts off, or that lies over other text, as
 * lines: a line drawn past the edge of a box that hides or clips its
 * overflow (a box that scrolls itself keeps it reachable, and nothing past
 * it is judged), or two lines of different text drawn over each other by
 * more than half a line. Text kept for screen readers only (`sr-only`,
 * clipped to a pixel) isn't drawn to be read, and isn't judged; nor is
 * anything inside `except`.
 */
function textCut(page: Page, except?: string) {
  return page.evaluate((except) => {
    const out: string[] = [];
    const lines: { rect: DOMRect; node: Text }[] = [];
    const say = (node: Text) => `"${(node.textContent ?? "").trim().slice(0, 40)}"`;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const node = n as Text;
      const owner = node.parentElement;
      if (owner === null || (node.textContent ?? "").trim() === "") continue;
      if (except !== undefined && owner.closest(except) !== null) continue;
      if (!owner.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      let unread = false;
      const cut = new Set<string>();
      for (
        let up: Element | null = owner;
        up !== null && up !== document.body;
        up = up.parentElement
      ) {
        const { overflowX, overflowY } = getComputedStyle(up);
        if (/auto|scroll/.test(overflowX) || /auto|scroll/.test(overflowY)) break;
        const [clipsX, clipsY] = [/hidden|clip/.test(overflowX), /hidden|clip/.test(overflowY)];
        if (!clipsX && !clipsY) continue;
        const box = up.getBoundingClientRect();
        if (box.width <= 1 || box.height <= 1) {
          unread = true;
          break;
        }
        const left = box.left + up.clientLeft;
        const top = box.top + up.clientTop;
        const right = left + up.clientWidth;
        const bottom = top + up.clientHeight;
        for (const r of rects) {
          if (clipsX && (r.left < left - 1 || r.right > right + 1)) cut.add("at the side");
          if (clipsY && (r.top < top - 1 || r.bottom > bottom + 1)) cut.add("below");
        }
      }
      if (unread) continue;
      for (const how of cut) out.push(`${say(node)} cut off ${how}`);
      for (const rect of rects) lines.push({ rect, node });
    }
    for (const [i, a] of lines.entries())
      for (const b of lines.slice(i + 1)) {
        if (a.node === b.node) continue;
        const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (w > 2 && h > Math.min(a.rect.height, b.rect.height) / 2)
          out.push(`${say(a.node)} over ${say(b.node)}`);
      }
    return [...new Set(out)];
  }, except);
}

/**
 * WCAG 1.4.12's spacing over the page's own styles: lines 1.5 times the
 * text, paragraphs followed by twice it, letters 0.12 and words 0.16 of
 * it apart. Through a constructed stylesheet, which the policy allows.
 */
async function spaceText(page: Page) {
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important }" +
        " p { margin-block-end: 2em !important }",
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
}

/**
 * The browser's default text size doubled before the page loads, as a
 * reader's own setting does (1.4.4): every size in `rem` doubles, and so
 * does every breakpoint, which are in `rem` too.
 */
async function doubleText(page: Page) {
  const debug = await page.context().newCDPSession(page);
  await debug.send("Page.setFontSizes", { fontSizes: { standard: 32, fixed: 26 } });
}

/**
 * The flyer's sheet is drawn to its paper (src/components/poll-flyer.tsx):
 * its text is sized to the sheet, not to the reader's text, so it neither
 * grows nor reflows. What it says, the poll page says in text that does.
 */
const SHEET = "[data-flyer]";

describe.each(VIEWS)("the text at $name width", ({ viewport }) => {
  describe.each(IN_LOCALES)("in $locale", ({ locale }) => {
    test.each(PAGES)(
      "%s: nothing cut off or drawn over other text, as it is and with WCAG's text spacing",
      async (path) => {
        const { context, page } = await open(path, { viewport, locale });
        try {
          // 3.1.1 Language of Page: the catalog's language, which axe checks
          // is valid but not that it is the right one.
          expect(await page.locator("html").getAttribute("lang")).toBe(locale);
          expect(await textCut(page)).toEqual([]);
          // 1.4.12 Text Spacing.
          await spaceText(page);
          expect(await textCut(page, SHEET)).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );
  });
});

// At twice the text's size a desktop's 1280 px holds 40 of the larger rem,
// a tablet's layout, which is what 1.4.4 asks to work. At the phone's
// width it would be a screen 180 px wide, which no criterion asks for
// (1.4.10 Reflow is 320 px at 400% zoom, the phone test above).
describe.each(IN_LOCALES)("the text at twice its size, in $locale", ({ locale }) => {
  test.each(PAGES)(
    "%s: grows, and nothing is cut off, drawn over other text or past the edge",
    async (path) => {
      const { context, page } = await open(path, { ...VIEWS[0], locale }, doubleText);
      try {
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
          "32px",
        );
        expect(await textCut(page, SHEET)).toEqual([]);
        expect(await pastTheEdge(page)).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );
});

describe("the text's check itself", () => {
  test("finds what it checks for: text a box cuts off, text over other text, and not what only a screen reader reads", async () => {
    const { context, page } = await open("/how-it-works", VIEWS[0]);
    try {
      await page.evaluate(() => {
        const main = document.querySelector("main");
        if (main === null) throw new Error("no main");
        const text = (words: string) => {
          const p = document.createElement("p");
          p.textContent = words;
          return p;
        };
        // Through the CSSOM, which the policy's style-src allows.
        const box = document.createElement("div");
        Object.assign(box.style, { height: "1em", overflow: "hidden", width: "10em" });
        box.append(text("A sentence too long for its box, which hides the rest"));
        const stack = document.createElement("div");
        stack.style.position = "relative";
        const [under, over] = [text("Underneath"), text("On top")];
        Object.assign(over.style, { position: "absolute", top: "0", left: "0" });
        stack.append(under, over);
        const unread = text("Only for screen readers");
        unread.className = "sr-only";
        main.prepend(box, stack, unread);
      });
      const found = await textCut(page);
      expect(found).toEqual(
        expect.arrayContaining([
          '"A sentence too long for its box, which h" cut off below',
          '"Underneath" over "On top"',
        ]),
      );
      expect(found.join("\n")).not.toContain("Only for screen readers");
    } finally {
      await context.close();
    }
  });
});

// The second language end to end (P2-28 part 4): a browser that asks for
// Spanish gets it, the footer's switch keeps a visitor's own choice over
// what their browser asks for, and every later page keeps it.
describe("the page's language", () => {
  // This process's copy of the catalogs, for the words the pages should show.
  beforeAll(() => loadCatalog("es-US"));
  const es = titles("es-US").text;
  const en = titles("en-US").text;

  test("follows the browser's Accept-Language, head and all", async () => {
    const { context, page } = await open("/how-it-works", { ...VIEWS[0], locale: "es-MX" });
    try {
      expect(await page.locator("html").getAttribute("lang")).toBe("es-US");
      expect(await page.title()).toBe(`${es("navHowItWorks")} · ${es("siteName")}`);
      await expect
        .poll(() => page.getByRole("heading", { level: 1 }).textContent())
        .toBe(es("howTitle"));
    } finally {
      await context.close();
    }
  });

  test("changes with the footer's switch, which outlasts the browser's choice and every page after", async () => {
    // Without the offline worker: switching language registers the other
    // locale's, and on a loaded runner the later `goto` sometimes never saw
    // its page load while that worker installed and took over. Whether
    // the language holds is the server's and the router's; the worker's
    // switch is offline.e2e.ts's.
    const { context, page } = await open("/", {
      ...VIEWS[0],
      locale: "en-US",
      serviceWorkers: "block",
    });
    try {
      const switcher = page.getByRole("navigation", { name: en("footerLanguage") });
      await expect
        .poll(() => switcher.locator('[aria-current="true"]').textContent())
        .toBe("English");
      await Promise.all([
        page.waitForEvent("load"),
        switcher.getByRole("button", { name: "Español" }).click(),
      ]);
      expect(await page.locator("html").getAttribute("lang")).toBe("es-US");
      expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe(es("homeTitle"));
      // A link followed inside the app keeps the language without the server.
      await page
        .getByRole("navigation", { name: es("navSite") })
        .getByRole("link", { name: es("navDiscover") })
        .click();
      await page.waitForURL(`${origin}/discover`);
      await expect.poll(() => page.title()).toBe(`${es("navDiscover")} · ${es("siteName")}`);
      // A new visit asks the server, which reads the cookie before the header.
      await page.goto(`${origin}/how-it-works`);
      expect(await page.locator("html").getAttribute("lang")).toBe("es-US");
      const cookies = await context.cookies(origin);
      expect(cookies.map(({ name, value }) => `${name}=${value}`)).toEqual(["lang=es-US"]);
      // And back.
      await Promise.all([
        page.waitForEvent("load"),
        page
          .getByRole("navigation", { name: es("footerLanguage") })
          .getByRole("button", { name: "English" })
          .click(),
      ]);
      expect(await page.locator("html").getAttribute("lang")).toBe("en-US");
    } finally {
      await context.close();
    }
  });
});
