// The built ballot client in a real browser: it renders under its own CSP
// with no violation and no request to another origin, and the browser really
// enforces the policy (T-43, T-41). Runs the production build, served
// statically, as an IPFS gateway or our domains would.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Browser, chromium, type Page } from "playwright";
import { build, preview, type PreviewServer } from "vite-plus";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

const root = fileURLToPath(new URL("..", import.meta.url));
const GATEWAY_PATH = "/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/";

let outDir: string;
let server: PreviewServer;
let gateway: PreviewServer;
let origin: string;
let browser: Browser;
let page: Page;
let violations: string[];
let foreignRequests: string[];
let foreignResponses: string[];
let consoleErrors: string[];

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "abolish-ballot-e2e-"));
  const nodeEnv = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";
  try {
    await build({ root, mode: "production", logLevel: "silent", build: { outDir } });
  } finally {
    if (nodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = nodeEnv;
  }
  server = await preview({
    root,
    logLevel: "silent",
    build: { outDir },
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error("the preview server has no local URL");
  origin = new URL(url).origin;
  // The same bytes under a path gateway's /ipfs/<cid>/.
  gateway = await preview({
    root,
    base: GATEWAY_PATH,
    logLevel: "silent",
    build: { outDir },
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await gateway?.close();
  if (outDir !== undefined) await rm(outDir, { recursive: true, force: true });
});

beforeEach(async () => {
  violations = [];
  foreignRequests = [];
  foreignResponses = [];
  consoleErrors = [];
  page = await browser.newPage();
  // Recorded from the page itself, since a violation is reported there.
  await page.exposeFunction("reportViolation", (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { reportViolation(v: string): void }).reportViolation(
        `${e.effectiveDirective} ${e.blockedURI}`,
      ),
    );
  });
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) foreignRequests.push(request.url());
  });
  // A request the CSP blocks still shows as attempted; a response means it left.
  page.on("response", (response) => {
    if (new URL(response.url()).origin !== origin) foreignResponses.push(response.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(`${origin}/`);
  await page.getByRole("heading", { level: 1 }).waitFor();
});

describe("the served ballot client", () => {
  test("renders with its styles and fonts, no CSP violation and no foreign request", async () => {
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe(
      "Abolish ballot",
    );
    // The stylesheet applied: the ground is the theme's background (light theme).
    await expect(
      page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    ).resolves.toMatch(/^(rgb\(255, 255, 255\)|oklch\(1 0 0\))$/);
    // The self-hosted interface font loaded (font-src 'self').
    await expect(
      page.evaluate(async () => {
        await document.fonts.ready;
        return document.fonts.check('600 16px "Oxanium Variable"');
      }),
    ).resolves.toBe(true);
    expect(violations).toEqual([]);
    expect(foreignRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("refuses to turn a string into script or markup (Trusted Types)", async () => {
    const outcomes = await page.evaluate(() => {
      const attempts: Record<string, () => void> = {
        "script text": () => {
          document.createElement("script").textContent = "window.injected = true";
        },
        "script src": () => {
          document.createElement("script").src = "https://example.com/tracker.js";
        },
        innerHTML: () => {
          document.createElement("div").innerHTML = "<b>injected</b>";
        },
        insertAdjacentHTML: () => {
          document.body.insertAdjacentHTML("beforeend", "<b>injected</b>");
        },
        "event handler": () => {
          document.body.setAttribute("onclick", "window.injected = true");
        },
      };
      return Object.fromEntries(
        Object.entries(attempts).map(([name, attempt]) => {
          try {
            attempt();
            return [name, "allowed"];
          } catch (e) {
            return [name, e instanceof TypeError ? "refused" : String(e)];
          }
        }),
      );
    });
    expect(outcomes).toEqual({
      "script text": "refused",
      "script src": "refused",
      innerHTML: "refused",
      insertAdjacentHTML: "refused",
      "event handler": "refused",
    });
    await expect
      .poll(() => violations.filter((v) => v.startsWith("require-trusted-types-for")).length)
      .toBe(5);
  });

  test("refuses a request to any origin, its own included", async () => {
    const outcome = await page.evaluate(async (self) => {
      const results: string[] = [];
      for (const url of ["https://example.com/", `${self}/index.html`])
        try {
          await fetch(url);
          results.push("fetched");
        } catch {
          results.push("refused");
        }
      return results;
    }, origin);
    expect(outcome).toEqual(["refused", "refused"]);
    await expect.poll(() => violations.filter((v) => v.startsWith("connect-src")).length).toBe(2);
  });

  test("refuses an image from another origin", async () => {
    await page.evaluate(() => {
      const img = document.createElement("img");
      img.src = "https://example.com/pixel.gif";
      document.body.append(img);
    });
    await expect.poll(() => violations).toContain("img-src https://example.com/pixel.gif");
    expect(foreignResponses).toEqual([]);
  });

  test("refuses to run from a path gateway, where other content shares its origin", async () => {
    const url = gateway.resolvedUrls?.local[0];
    if (url === undefined) throw new Error("the gateway server has no local URL");
    expect(new URL(url).pathname).toBe(GATEWAY_PATH);
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe(
      "This address isn't safe for voting",
    );
    await expect(page.getByText(/open the ballot link/).count()).resolves.toBe(0);
    expect(violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
