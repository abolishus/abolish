// The ballot worker in a real browser, under the client's own CSP (T-43): the
// page spawns it through the ballot-worker Trusted Types policy and nothing
// else can, it checks an election and refuses relabelled text (T-34, T-41),
// and while it runs nothing is requested but the client's own files. The
// static server sends no CSP header with the worker's script, as an IPFS
// gateway wouldn't, so the worker's lack of any network API is what keeps it
// off the network there.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeDisplayText,
  decodeElectionDefinition,
  type ElectionDefinition,
  encodeDisplayText,
  encodeElectionDefinition,
} from "@abolishus/crypto";
import { type Browser, chromium, type Page } from "playwright";
import { build, preview, type PreviewServer } from "vite-plus";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

const root = fileURLToPath(new URL("..", import.meta.url));
const vectors = (name: string) =>
  readFile(new URL(`../../../docs/spec/vectors/${name}.json`, import.meta.url), "utf8").then(
    (text) => (JSON.parse(text) as { vectors: { id: string; encoding: string }[] }).vectors,
  );
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromHex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

let outDir: string;
let server: PreviewServer;
let origin: string;
let browser: Browser;
let page: Page;
let violations: string[];
let requests: string[];
let consoleErrors: string[];
let definition: ElectionDefinition;
let definitionHex: string;
let textHex: string;
let relabelledHex: string;

beforeAll(async () => {
  // An election whose definition commits to a vector's display text.
  const find = async (file: string, id: string) => {
    const v = (await vectors(file)).find((x) => x.id === id);
    if (v === undefined) throw new Error(`no vector ${id}`);
    return fromHex(v.encoding);
  };
  const typical = decodeElectionDefinition(await find("election-definition", "definition-typical"));
  const textBytes = await find("display-text", "display-text-two-languages");
  // Decoded under any definition that pins display text version 1.
  const text = decodeDisplayText(textBytes, typical);
  const tag = Buffer.from("abolish/v1/display-text", "ascii");
  definition = {
    ...typical,
    option_count: text.translations[0]?.options.length ?? 0,
    display_text_commitment: Uint8Array.from(
      createHash("sha256")
        .update(Buffer.concat([Buffer.from([tag.length]), tag, textBytes]))
        .digest(),
    ),
  };
  definitionHex = hex(encodeElectionDefinition(definition));
  textHex = hex(textBytes);
  // The same text with the first two options' labels swapped in every
  // language: what a server relabelling the ballot for one voter would send.
  relabelledHex = hex(
    encodeDisplayText({
      ...text,
      translations: text.translations.map((t) => {
        const [a, b, ...rest] = t.options;
        if (a === undefined || b === undefined) throw new Error("vector has under two options");
        return {
          ...t,
          options: [{ ...a, label: b.label }, { ...b, label: a.label }, ...rest],
        };
      }),
    }),
  );

  outDir = await mkdtemp(join(tmpdir(), "abolish-ballot-worker-e2e-"));
  const nodeEnv = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";
  try {
    await build({
      root,
      mode: "production",
      logLevel: "silent",
      build: { outDir, rollupOptions: { input: join(root, "tests/harness/index.html") } },
    });
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
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (outDir !== undefined) await rm(outDir, { recursive: true, force: true });
});

beforeEach(async () => {
  violations = [];
  requests = [];
  consoleErrors = [];
  page = await browser.newPage();
  await page.exposeFunction("reportViolation", (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { reportViolation(v: string): void }).reportViolation(
        `${e.effectiveDirective} ${e.blockedURI}`,
      ),
    );
  });
  // The browser context sees the worker's requests as well as the page's.
  page.context().on("request", (request) => requests.push(request.url()));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(`${origin}/tests/harness/index.html`);
  await page.locator("#root[data-ready]").waitFor({ state: "attached" });
});

afterEach(async () => {
  await page?.close();
});

const check = (electionId: string, definitionBytes: string, displayText: string) =>
  page
    .evaluate(
      ([id, d, t]) =>
        (
          globalThis as unknown as {
            ballotHarness: { check(id: string, d: string, t: string): Promise<string> };
          }
        ).ballotHarness.check(id, d, t),
      [electionId, definitionBytes, displayText] as const,
    )
    .then((json) => JSON.parse(json) as Record<string, unknown>);

describe("the ballot worker", () => {
  test("runs in a harness under the client's own CSP", async () => {
    const csp = (file: string) =>
      readFile(join(root, file), "utf8").then(
        (html) => /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1],
      );
    const own = await csp("index.html");
    expect(own).toMatch(/trusted-types ballot-worker/);
    await expect(csp("tests/harness/index.html")).resolves.toBe(own);
  });

  test("checks an election and shows its text, with no request but the client's own files", async () => {
    const result = await check(hex(definition.election_id), definitionHex, textHex);
    expect(result).toMatchObject({
      ok: true,
      election: {
        electionId: hex(definition.election_id),
        electionType: "plurality",
        translations: [
          { language: "en", options: [{ label: "Yes" }, { label: "No" }, { label: "Abstain" }] },
          {
            language: "es-419",
            options: [{ label: "Sí" }, { label: "No" }, { label: "Abstención" }],
          },
        ],
      },
    });
    expect(violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
    // The page, its script and the worker's script; nothing else, and nothing elsewhere.
    for (const url of requests) {
      expect(new URL(url).origin).toBe(origin);
      expect(new URL(url).pathname).toMatch(/^\/(tests\/harness\/index\.html|assets\/[\w-]+\.js)$/);
    }
    expect(requests.filter((url) => /\/assets\/worker-[\w-]+\.js$/.test(url))).toHaveLength(1);
  });

  test("refuses text relabelled for one voter", async () => {
    await expect(check(hex(definition.election_id), definitionHex, relabelledHex)).resolves.toEqual(
      {
        ok: false,
        problem: "display-text-ill-formed",
        rule: "commitment",
      },
    );
  });

  test("refuses the election under another election's id", async () => {
    await expect(check("ff".repeat(32), definitionHex, textHex)).resolves.toEqual({
      ok: false,
      problem: "another-election",
    });
  });

  test("can't be spawned from any other URL, and its policy can't be created again", async () => {
    const outcomes = await page.evaluate(() => {
      const tt = (
        globalThis as unknown as {
          trustedTypes: { createPolicy(n: string, r: object): unknown };
        }
      ).trustedTypes;
      const attempts: Record<string, () => void> = {
        "a worker from a string URL": () => new Worker("./assets/other.js"),
        "the ballot-worker policy again": () =>
          tt.createPolicy("ballot-worker", { createScriptURL: (s: string) => s }),
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
      "a worker from a string URL": "refused",
      "the ballot-worker policy again": "refused",
    });
  });
});
