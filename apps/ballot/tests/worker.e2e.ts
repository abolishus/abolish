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
  membershipProverInput,
  sealingElectionV5,
  verifyMembershipProof,
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
  test("the worker finds the voter's cell from the board and casts a seal there through a prover worker into a record the admission checks pass, and never opens it", async () => {
    const l1 = { number: "9000000", hash: "ab".repeat(32) };
    const json = await page.evaluate(
      ([id, h, d, t, entries, panel, secret, find, block]) =>
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
          secret,
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
        hex(poll.members[1] as Uint8Array),
        {
          tier: 0,
          group: String(poll.GROUP),
          board: poll.board.map(hex),
          registrars: poll.registrars.registrars.map(hex),
          threshold: poll.registrars.threshold,
        },
        l1,
      ] as const,
    );
    const { check, cast, opened } = JSON.parse(json) as {
      check: boolean;
      cast: { ok: boolean; ballot: string; ballotHash: string };
      opened: unknown;
    };
    expect(check).toBe(true);
    expect(cast.ok, JSON.stringify(cast)).toBe(true);
    // Judged here, under a context made from the same records, not by the worker.
    const independent = sealingElectionV5(poll.definition, [poll.panel], [poll.entry]);
    if (!independent.ok) throw new Error(independent.code);
    const record = decodeBallot(fromHex(cast.ballot), 3);
    const verdict = checkBallotV3(independent.election, record);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(hex(verdict.ballotHash)).toBe(cast.ballotHash);
    expect(record.l1_ref_number).toBe(BigInt(l1.number));
    expect(opened).toEqual({ ok: false, problem: "cast" });
    expect(violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
    for (const url of requests) expect(new URL(url).origin).toBe(origin);
  }, 120_000);
});

describe("proving membership", () => {
  // docs/spec/vectors/membership-prover.json: Semaphore 4.14.3's identities
  // over Abolish tier trees (P2-21 part 2).
  interface ProverVectors {
    readonly definitionHash: string;
    readonly members: readonly { readonly secret: string }[];
    readonly trees: readonly {
      readonly id: string;
      readonly tier: number;
      readonly leaves: readonly string[];
      readonly root: string;
    }[];
    readonly cases: readonly {
      readonly member: number;
      readonly tree: string;
      readonly message: string;
      readonly input: { readonly merkleProofIndex: string };
    }[];
  }
  const loadCase = async () => {
    const v = JSON.parse(
      await readFile(
        new URL("../../../docs/spec/vectors/membership-prover.json", import.meta.url),
        "utf8",
      ),
    ) as ProverVectors;
    const c = v.cases[0];
    const tree = v.trees.find((t) => t.id === c?.tree);
    const secret = v.members[c?.member ?? -1]?.secret;
    if (c === undefined || tree === undefined || secret === undefined) throw new Error("no case");
    return { ...c, tree, secret, definitionHash: v.definitionHash };
  };
  type Case = Awaited<ReturnType<typeof loadCase>>;
  let proving: Case;
  beforeAll(async () => {
    proving = await loadCase();
  });

  const prove = (c: Case, leaves = c.tree.leaves) =>
    page
      .evaluate(
        ([secret, l, h, tier, root, message]) =>
          (
            globalThis as unknown as {
              ballotHarness: {
                prove(
                  ...args: [string, readonly string[], string, number, string, string]
                ): Promise<string>;
              };
            }
          ).ballotHarness.prove(secret, l, h, tier, root, message),
        [c.secret, leaves, c.definitionHash, c.tree.tier, c.tree.root, c.message] as const,
      )
      .then(
        (json) =>
          JSON.parse(json) as {
            result: { ok?: boolean; proof?: string; problem?: string; thrown?: string };
            progress: [number, number][];
          },
      );

  const signals = (c: Case) =>
    membershipProverInput(fromHex(c.secret), c.tree.leaves.map(BigInt), {
      definitionHash: fromHex(c.definitionHash),
      tier: c.tree.tier,
      root: BigInt(c.tree.root),
      message: fromHex(c.message),
    }).signals;

  const artifactRequests = () =>
    requests.filter((url) => /\/assets\/semaphore-32-[0-9a-f]{16}\.(zkey|wasm)$/.test(url));

  test("proves in a prover worker of its own, under the client's CSP, with nothing requested but its own files", async () => {
    const { result, progress } = await prove(proving);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(verifyMembershipProof(fromHex(result.proof ?? ""), signals(proving))).toBe(true);
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

  test("fetches the artifacts once and proves again from the cache, into another proof", async () => {
    const first = await prove(proving);
    const fetched = artifactRequests().length;
    const second = await prove(proving);
    expect(fetched).toBe(2);
    expect(artifactRequests()).toHaveLength(2);
    expect(second.result.ok).toBe(true);
    expect(verifyMembershipProof(fromHex(second.result.proof ?? ""), signals(proving))).toBe(true);
    // Re-randomised each time from the ballot worker's CSPRNG.
    expect(second.result.proof).not.toBe(first.result.proof);
  }, 180_000);

  test("drops a cached key that isn't the pinned one, and proves with the key fetched again", async () => {
    await prove(proving);
    const zkeyUrl = `${origin}/assets/${PROVER_ARTIFACT_NAMES.zkey}`;
    await page.evaluate(
      async ([name, url]) => {
        const cache = await caches.open(name);
        await cache.put(url, new Response(new Uint8Array(1024)));
      },
      [PROVER_CACHE, zkeyUrl] as const,
    );
    const before = artifactRequests().length;
    const { result } = await prove(proving);
    expect(result.ok).toBe(true);
    expect(artifactRequests().slice(before)).toEqual([zkeyUrl]);
  }, 180_000);

  test("refuses a secret whose commitment isn't a leaf, without a proof", async () => {
    const without = proving.tree.leaves.filter(
      (_, i) => i !== Number(proving.input.merkleProofIndex),
    );
    const { result, progress } = await prove(proving, without);
    expect(result).toEqual({ ok: false, problem: "not-a-member" });
    // The prover never got a witness to make a step of.
    expect(progress.filter(([done]) => done > 0)).toEqual([]);
  }, 120_000);
});
