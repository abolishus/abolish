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
  checkBallotV3,
  decodeBallot,
  decodeDisplayText,
  decodeElectionDefinition,
  type ElectionDefinition,
  encodeDisplayText,
  encodeElectionDefinition,
  sealingElectionV5,
} from "@abolishus/crypto";
import { type Browser, chromium, type Page } from "playwright";
import { build, preview, type PreviewServer } from "vite-plus";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { PROVER_ARTIFACT_NAMES, PROVER_CACHE } from "../src/prover-artifacts.ts";
import * as poll from "./poll.ts";

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

/** The definition hash by the spec's formula, standing in for what the L2 registry holds. */
const registered = (definitionHexBytes: string) => {
  const tag = Buffer.from("abolish/v1/election-definition", "ascii");
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from([tag.length]), tag, fromHex(definitionHexBytes)]))
    .digest("hex");
};

const check = (
  electionId: string,
  definitionBytes: string,
  displayText: string,
  registeredHash = registered(definitionBytes),
) =>
  page
    .evaluate(
      ([id, h, d, t]) =>
        (
          globalThis as unknown as {
            ballotHarness: {
              check(id: string, h: string, d: string, t: string): Promise<string>;
            };
          }
        ).ballotHarness.check(id, h, d, t),
      [electionId, registeredHash, definitionBytes, displayText] as const,
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
        version: 1,
        translations: [
          {
            language: "en",
            questions: [{ options: [{ label: "Yes" }, { label: "No" }, { label: "Abstain" }] }],
          },
          {
            language: "es-419",
            questions: [{ options: [{ label: "Sí" }, { label: "No" }, { label: "Abstención" }] }],
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

  test("refuses a definition the registry doesn't hold, however its text matches", async () => {
    await expect(
      check(hex(definition.election_id), definitionHex, textHex, "00".repeat(32)),
    ).resolves.toEqual({
      ok: false,
      problem: "unregistered-definition",
      // The served definition's own hash, for the refusal to show beside the registered one.
      servedHash: registered(definitionHex),
    });
  });

  test("refuses the election under another election's id", async () => {
    await expect(check("ff".repeat(32), definitionHex, textHex)).resolves.toEqual({
      ok: false,
      problem: "another-election",
    });
  });

  test("once stopped, fails a request at once rather than at its timeout", async () => {
    const outcome = await page.evaluate(() =>
      (
        globalThis as unknown as { ballotHarness: { stopThenCheck(): Promise<string> } }
      ).ballotHarness.stopThenCheck(),
    );
    expect(outcome).toMatch(/^WorkerFailure after \d+ ms$/);
    expect(Number(/(\d+) ms/.exec(outcome)?.[1])).toBeLessThan(1000);
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

describe("opening an election from staging's origins", () => {
  const REGISTRY = "0x00000000000000000000000000000000000000aa";
  const RPC = "https://sepolia.base.org";
  const API = "https://api-staging.abolish.us";

  /**
   * Stands in for the RPC and the API at their real origins, answering with
   * the CORS headers a browser needs to let the page read them, and records
   * every JSON-RPC call.
   */
  async function serve({
    registeredHash = registered(definitionHex),
    textStatus = 200,
  }: { registeredHash?: string; textStatus?: number } = {}) {
    const calls: unknown[] = [];
    const cors = {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "content-type",
      vary: "origin",
    };
    await page.route(
      (url) => url.origin === RPC,
      async (route) => {
        if (route.request().method() === "OPTIONS")
          return route.fulfill({ status: 204, headers: cors });
        const call = JSON.parse(route.request().postData() ?? "null") as {
          id: number;
          method: string;
        };
        calls.push(call);
        const result = call.method === "eth_chainId" ? "0x14a34" : `0x${registeredHash}`;
        return route.fulfill({
          status: 200,
          headers: cors,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: call.id, result }),
        });
      },
    );
    await page.route(
      (url) => url.origin === API,
      (route) => {
        const url = new URL(route.request().url());
        const wanted = url.searchParams.get("electionId") === hex(definition.election_id);
        if (url.pathname === "/elections/definition" && wanted)
          return route.fulfill({
            status: 200,
            headers: cors,
            contentType: "application/json",
            body: JSON.stringify({ definition: definitionHex }),
          });
        if (url.pathname === "/elections/display-text" && wanted)
          return route.fulfill({
            status: textStatus,
            headers: cors,
            contentType: "application/json",
            body: JSON.stringify(textStatus === 200 ? { displayText: textHex } : {}),
          });
        // Never moderated (docs/moderation-policy.md, Open polls).
        if (url.pathname === "/moderation/status" && wanted)
          return route.fulfill({
            status: 200,
            headers: cors,
            contentType: "application/json",
            body: JSON.stringify({ state: "visible" }),
          });
        // A version-1 election's board: no transcript is looked for.
        if (url.pathname === "/board/entries" && wanted)
          return route.fulfill({
            status: 200,
            headers: cors,
            contentType: "application/json",
            body: JSON.stringify({ entries: [] }),
          });
        return route.fulfill({ status: 404, headers: cors, body: "{}" });
      },
    );
    return calls;
  }

  const open = (registry = REGISTRY) =>
    page
      .evaluate(
        ([id, r]) =>
          (
            globalThis as unknown as {
              ballotHarness: { open(id: string, registry: string): Promise<string> };
            }
          ).ballotHarness.open(id, r),
        [hex(definition.election_id), registry] as const,
      )
      .then((json) => JSON.parse(json) as Record<string, unknown>);

  test("reads the pinned registry at the finalized head, fetches the records and checks them", async () => {
    const calls = await serve();
    await expect(open()).resolves.toMatchObject({
      ok: true,
      election: {
        electionId: hex(definition.election_id),
        definitionHash: registered(definitionHex),
        translations: [{ language: "en" }, { language: "es-419" }],
      },
    });
    expect(calls).toContainEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "eth_call",
      params: [{ to: REGISTRY, data: `0xd325433f${hex(definition.election_id)}` }, "finalized"],
    });
    // Under the client's own CSP, nothing but its own files and the two origins it names.
    expect(violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
    for (const url of requests) expect([origin, RPC, API]).toContain(new URL(url).origin);
  });

  test("refuses records the registry doesn't hold, fetched through the real network path", async () => {
    await serve({ registeredHash: "11".repeat(32) });
    await expect(open()).resolves.toEqual({
      ok: false,
      problem: "unregistered-definition",
      servedHash: registered(definitionHex),
    });
  });

  test("says so when the API withholds the text", async () => {
    await serve({ textStatus: 451 });
    await expect(open()).resolves.toEqual({ ok: false, problem: "withheld" });
  });
});

describe("sealing a version-5 poll", () => {
  test("the worker checks the poll's ceremony, seals under it and opens the seal once", async () => {
    const json = await page.evaluate(
      ([id, h, d, t, entries, panel]) =>
        (
          globalThis as unknown as {
            ballotHarness: {
              sealAndChallenge(
                id: string,
                h: string,
                d: string,
                t: string,
                entries: readonly string[],
                panel: { threshold: number; keys: readonly string[] },
                votes: readonly (0 | 1)[],
              ): Promise<string>;
            };
          }
        ).ballotHarness.sealAndChallenge(id, h, d, t, entries, panel, [0, 1, 0, 1, 0]),
      [
        hex(poll.definition.election_id),
        hex(poll.registeredHash),
        hex(poll.definitionBytes),
        hex(poll.displayText),
        [hex(poll.entry)],
        { threshold: poll.panel.threshold, keys: poll.panel.keys.map(hex) },
      ] as const,
    );
    const { check, sealed, opened, again } = JSON.parse(json) as {
      check: boolean;
      sealed: { ok: boolean; trackingCode: string };
      opened: { ok: boolean; opening: string; trackingCode: string };
      again: unknown;
    };
    expect(check).toBe(true);
    expect(sealed.ok).toBe(true);
    expect(opened.ok).toBe(true);
    expect(opened.trackingCode).toBe(sealed.trackingCode);
    // The opening's record type and version: spoiled-ballot opening 2.
    expect(opened.opening.slice(0, 6)).toBe("000302");
    expect(again).toEqual({ ok: false, problem: "unknown" });
    expect(violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
    for (const url of requests) expect(new URL(url).origin).toBe(origin);
  });
});

describe("casting a version-5 poll's seal", () => {
  const l1 = { number: "9000000", hash: "ab".repeat(32) };

  /** Checks `poll`, finds `secret`'s cell from its board, seals there and casts, in the page. */
  const sealAndCast = (secret = poll.members[1] as Uint8Array) =>
    page
      .evaluate(
        ([id, h, d, t, entries, panel, voter, find, block]) =>
          (
            globalThis as unknown as {
              ballotHarness: {
                sealAndCast(
                  id: string,
                  h: string,
                  d: string,
                  t: string,
                  entries: readonly string[],
                  panel: { threshold: number; keys: readonly string[] },
                  votes: readonly (0 | 1)[],
                  secret: string,
                  find: {
                    tier: number;
                    group: string;
                    board: readonly string[];
                    registrars: readonly string[];
                    threshold: number;
                  },
                  l1: { number: string; hash: string },
                ): Promise<string>;
              };
            }
          ).ballotHarness.sealAndCast(
            id,
            h,
            d,
            t,
            entries,
            panel,
            [0, 0, 1, 1, 0],
            voter,
            find,
            block,
          ),
        [
          hex(poll.definition.election_id),
          hex(poll.registeredHash),
          hex(poll.definitionBytes),
          hex(poll.displayText),
          [hex(poll.entry)],
          { threshold: poll.panel.threshold, keys: poll.panel.keys.map(hex) },
          hex(secret),
          {
            tier: 0,
            group: String(poll.GROUP),
            board: poll.board.map(hex),
            registrars: poll.registrars.registrars.map(hex),
            threshold: poll.registrars.threshold,
          },
          l1,
        ] as const,
      )
      .then(
        (json) =>
          JSON.parse(json) as {
            check: boolean;
            found?: { ok: boolean; problem?: string; code?: string };
            cast?: { ok: boolean; ballot: string; ballotHash: string };
            opened?: unknown;
            progress?: [number, number][];
          },
      );

  /** The record, judged here under a context made from the same records, not by the worker. */
  const admitted = (cast: { ok: boolean; ballot: string; ballotHash: string } | undefined) => {
    expect(cast?.ok, JSON.stringify(cast)).toBe(true);
    const independent = sealingElectionV5(poll.definition, [poll.panel], [poll.entry]);
    if (!independent.ok) throw new Error(independent.code);
    const record = decodeBallot(fromHex(cast?.ballot ?? ""), 3);
    const verdict = checkBallotV3(independent.election, record);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(hex(verdict.ballotHash)).toBe(cast?.ballotHash);
    return record;
  };

  const artifactRequests = () =>
    requests.filter((url) => /\/assets\/semaphore-32-[0-9a-f]{16}\.(zkey|wasm)$/.test(url));

  test("the worker finds the voter's cell from the board and casts a seal there through a prover worker of its own into a record the admission checks pass, with nothing requested but the client's own files, and never opens it", async () => {
    const { check, cast, opened, progress } = await sealAndCast();
    expect(check).toBe(true);
    const record = admitted(cast);
    expect(record.l1_ref_number).toBe(BigInt(l1.number));
    expect(opened).toEqual({ ok: false, problem: "cast" });
    // Real progress, every step once and in order, from none to all.
    expect(progress).toEqual(Array.from({ length: 11 }, (_, i) => [i, 10]));
    expect(violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
    for (const url of requests) {
      expect(new URL(url).origin).toBe(origin);
      expect(new URL(url).pathname).toMatch(
        /^\/(tests\/harness\/index\.html|assets\/[\w-]+\.js|assets\/semaphore-32-[0-9a-f]{16}\.(zkey|wasm))$/,
      );
    }
    expect(requests.filter((url) => /\/assets\/prover-[\w-]+\.js$/.test(url))).toHaveLength(1);
    expect(
      artifactRequests()
        .map((url) => new URL(url).pathname)
        .sort(),
    ).toEqual(
      [`/assets/${PROVER_ARTIFACT_NAMES.wasm}`, `/assets/${PROVER_ARTIFACT_NAMES.zkey}`].sort(),
    );
  }, 120_000);

  test("fetches the artifacts once and casts again from the cache", async () => {
    admitted((await sealAndCast()).cast);
    const fetched = artifactRequests().length;
    admitted((await sealAndCast()).cast);
    expect(fetched).toBe(2);
    expect(artifactRequests()).toHaveLength(2);
  }, 180_000);

  test("drops a cached key that isn't the pinned one, and casts with the key fetched again", async () => {
    admitted((await sealAndCast()).cast);
    const zkeyUrl = `${origin}/assets/${PROVER_ARTIFACT_NAMES.zkey}`;
    await page.evaluate(
      async ([name, url]) => {
        const cache = await caches.open(name);
        await cache.put(url, new Response(new Uint8Array(1024)));
      },
      [PROVER_CACHE, zkeyUrl] as const,
    );
    const before = artifactRequests().length;
    admitted((await sealAndCast()).cast);
    expect(artifactRequests().slice(before)).toEqual([zkeyUrl]);
  }, 180_000);

  // That the prover then hears nothing is cast.test.ts's: the harness stops at the refusal.
  test("finds no cell for a secret whose commitment isn't on the board", async () => {
    const outsider = new Uint8Array(32);
    outsider[0] = 1;
    const { found } = await sealAndCast(outsider);
    expect(found).toEqual({ ok: false, problem: "cell", code: "not-a-member" });
  }, 120_000);
});

describe("the device's voting identity", () => {
  type Harness = {
    saveIdentity(secret: string, memberships: { tier: number; group: string }[]): Promise<void>;
    createIdentity(secret: string): Promise<string>;
    recordTier0Request(secret: string, region: number, acceptedAt: number): Promise<string>;
    commitment(secret: string): Promise<string>;
    tier0Outcome(
      secret: string,
      query: {
        readonly region: number;
        readonly block: string;
        readonly groups: readonly { readonly group_id: string; readonly region: number }[];
        readonly records: readonly string[];
        readonly registry: string;
        readonly chainId: string;
        readonly registrars: readonly string[];
        readonly threshold: number;
      },
    ): Promise<string>;
    readIdentity(): Promise<string>;
    restampIdentity(version: number): Promise<void>;
  };
  const read = () =>
    page
      .evaluate(() =>
        (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.readIdentity(),
      )
      .then((json) => JSON.parse(json) as unknown);
  const secret = `01${"0b".repeat(31)}`;
  const memberships = [
    { tier: 0, group: "5" },
    { tier: 2, group: "18446744073709551615" },
  ];

  test("is none until one is saved, then the same one in this origin's storage, across loads", async () => {
    await expect(read()).resolves.toEqual({ kind: "none" });
    await page.evaluate(
      ([s, m]) =>
        (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.saveIdentity(s, m),
      [secret, memberships] as const,
    );
    const found = { kind: "found", identity: { secret, memberships } };
    await expect(read()).resolves.toEqual(found);
    await page.reload();
    await page.locator("#root[data-ready]").waitFor({ state: "attached" });
    await expect(read()).resolves.toEqual(found);
    expect(violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
    // Nothing of it went anywhere: no request but the client's own files.
    for (const url of requests)
      expect(new URL(url).pathname).toMatch(/^\/(tests\/harness\/index\.html|assets\/[\w-]+\.js)$/);
  });

  test("is unreadable, never guessed at, once the record is of another version", async () => {
    await page.evaluate(
      ([s, m]) =>
        (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.saveIdentity(s, m),
      [secret, memberships] as const,
    );
    await page.evaluate(() =>
      (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.restampIdentity(1),
    );
    await expect(read()).resolves.toEqual({ kind: "unreadable" });
  });

  test("refuses to save what isn't an identity, leaving the store as it was", async () => {
    const refused = await page.evaluate(
      ([m]) =>
        (globalThis as unknown as { ballotHarness: Harness }).ballotHarness
          .saveIdentity("00".repeat(32), m)
          .then(
            () => "saved",
            (e: unknown) => (e instanceof Error ? e.name : "?"),
          ),
      [memberships] as const,
    );
    expect(refused).toBe("TypeError");
    await expect(read()).resolves.toEqual({ kind: "none" });
  });

  const other = `02${"0c".repeat(31)}`;

  test("a new identity is kept in no group, and never over one the device holds", async () => {
    await expect(
      page.evaluate(
        ([s]) =>
          (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.createIdentity(s),
        [secret] as const,
      ),
    ).resolves.toBe("created");
    const kept = { kind: "found", identity: { secret, memberships: [] } };
    await expect(read()).resolves.toEqual(kept);
    // Another identity, readable or not, is never replaced.
    await expect(
      page.evaluate(
        ([s]) =>
          (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.createIdentity(s),
        [other] as const,
      ),
    ).resolves.toBe("exists");
    await expect(read()).resolves.toEqual(kept);
    await page.evaluate(() =>
      (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.restampIdentity(1),
    );
    await expect(
      page.evaluate(
        ([s]) =>
          (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.createIdentity(s),
        [other] as const,
      ),
    ).resolves.toBe("exists");
    await expect(read()).resolves.toEqual({ kind: "unreadable" });
  });

  test("an accepted request is noted only beside the identity it was made for", async () => {
    // None held: nothing to note it beside.
    await expect(
      page.evaluate(
        ([s]) =>
          (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.recordTier0Request(
            s,
            0,
            1_790_000_000_000,
          ),
        [secret] as const,
      ),
    ).resolves.toBe("changed");
    await expect(read()).resolves.toEqual({ kind: "none" });
    await page.evaluate(
      ([s]) =>
        (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.createIdentity(s),
      [secret] as const,
    );
    // Another identity's request leaves this one as it is.
    await expect(
      page.evaluate(
        ([s]) =>
          (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.recordTier0Request(
            s,
            0,
            1_790_000_000_000,
          ),
        [other] as const,
      ),
    ).resolves.toBe("changed");
    await expect(read()).resolves.toEqual({ kind: "found", identity: { secret, memberships: [] } });
    await expect(
      page.evaluate(
        ([s]) =>
          (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.recordTier0Request(
            s,
            7,
            1_790_000_000_000,
          ),
        [secret] as const,
      ),
    ).resolves.toBe("recorded");
    await expect(read()).resolves.toEqual({
      kind: "found",
      identity: {
        secret,
        memberships: [],
        tier0Request: { region: 7, acceptedAt: 1_790_000_000_000 },
      },
    });
    // Nor beside one already in a Tier 0 group.
    await page.evaluate(
      ([s, m]) =>
        (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.saveIdentity(s, m),
      [secret, memberships] as const,
    );
    await expect(
      page.evaluate(
        ([s]) =>
          (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.recordTier0Request(
            s,
            7,
            1_790_000_000_001,
          ),
        [secret] as const,
      ),
    ).resolves.toBe("changed");
    await expect(read()).resolves.toEqual({ kind: "found", identity: { secret, memberships } });
  });

  test("the worker reads a registration's outcome from the registry's log under the client's CSP", async () => {
    type Query = Parameters<Harness["tier0Outcome"]>[1];
    const answer = (s: string, region: number) =>
      page
        .evaluate(
          ([x, q]) =>
            (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.tier0Outcome(x, q),
          [
            s,
            {
              region,
              block: "1000",
              groups: [
                { group_id: String(poll.GROUP), region: 3 },
                { group_id: String(poll.OTHER_GROUP), region: 7 },
              ],
              records: poll.registryWith(poll.cellLeaves).map(hex),
              registry: hex(poll.definition.group_registry),
              chainId: String(poll.definition.l2_chain_id),
              registrars: poll.registrars.registrars.map(hex),
              threshold: poll.registrars.threshold,
            } satisfies Query,
          ] as const,
        )
        .then((json) => JSON.parse(json) as unknown);
    const member = hex(poll.members[0] as Uint8Array);
    await expect(answer(member, 3)).resolves.toEqual({
      result: { ok: true, outcome: { kind: "registered", group: String(poll.GROUP) } },
      // Copied to the worker: the page's copy stays the page's to zero.
      intact: true,
    });
    await expect(answer(member, 7)).resolves.toMatchObject({
      result: { ok: true, outcome: { kind: "moved", group: String(poll.GROUP) } },
    });
    await expect(answer(`01${"0b".repeat(31)}`, 3)).resolves.toMatchObject({
      result: { ok: true, outcome: { kind: "not-yet" } },
    });
    expect(violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("the worker commits a secret under the client's CSP, and refuses one that isn't", async () => {
    const answer = (s: string) =>
      page
        .evaluate(
          ([x]) =>
            (globalThis as unknown as { ballotHarness: Harness }).ballotHarness.commitment(x),
          [s] as const,
        )
        .then((json) => JSON.parse(json) as unknown);
    // The page's copy goes to the worker by copy, and stays the page's to zero.
    // Semaphore's own commitment of its first vector identity (docs/spec/vectors/membership-prover.json).
    await expect(
      answer("038e85d5e2b855cd8ba658216c65bcb761cc34d0082765ddbd0334ece36b4a8d"),
    ).resolves.toEqual({
      result: {
        ok: true,
        commitment: "11762512682537715524099446441423048587560576251586398063711036406738253258307",
      },
      // Copied to the worker: the page's copy stays the page's to zero.
      intact: true,
    });
    await expect(answer("00".repeat(32))).resolves.toMatchObject({
      result: { ok: false, problem: "secret" },
    });
    expect(violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
