// The built server, end to end: pages rendered by dist/server/server.js
// against a stub API, checking what reaches the visitor (headers, nonces,
// what is shown) and what reaches the API (nothing of the visitor's).

import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";

import {
  boardEntryHash,
  checkpointHash,
  decodeCheckpoint,
  decodeElectionDefinitionV5,
  electionDefinitionV5Hash,
} from "@abolishus/crypto";
import { createBuilder } from "vite-plus";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { offlineWorkerConfig } from "../src/app/offline.ts";
import { pushNotice } from "../src/app/offline-page.tsx";
import { loadCatalog } from "../src/messages.ts";
import { titles } from "../src/titles.ts";
import type { AskedBy } from "../src/poll.ts";
import type { ProfileRecord } from "../src/server/load.ts";
import type { StartRequestContext } from "../src/start.ts";
import { fromHex, toHex } from "../src/values.ts";
import {
  BALLOT,
  BOARD,
  brokenInclusion,
  brokenProofs,
  CELLS_ID,
  CELLS_MISFIT_ID,
  CIVIC_ID,
  COUNTED_ID,
  CHECKPOINTS,
  CODE,
  CODE_FAILS_ID,
  codeOf,
  FALSE_CODE,
  FILLER,
  HEAD,
  HEAD_FAILS_ID,
  HIDDEN_CODE,
  HIDDEN_ID,
  LATEST,
  LISTED_PLACES,
  LISTING_COUNTS,
  LOG_COUNTS,
  LOG_ENTRIES,
  ID,
  listed,
  LOST_ID,
  MISCODED_CODE,
  MISCODED_ID,
  OPEN_MANY,
  OPEN_MANY_CODE,
  OPEN_ONE,
  OPEN_ONE_CODE,
  OVERRIDE_ID,
  PROFILE_HANDLE,
  QUESTIONS_ID,
  questionsDefinition,
  RESULTS_FAILS_ID,
  RESULTS_MISFIT_ID,
  RESULTS_NOT_READY_ID,
  seen,
  streamed,
  STREAM_BAD_TEXT,
  STREAM_NO_TEXT,
  STREAM_V1,
  STREAM_V1_CODE,
  STREAM_V5,
  STREAM_V5_CODE,
  stub,
  stubApi,
  SWAPPED_CODE,
  SWAPPED_ID,
  typical,
  UNKNOWN_CODE,
  UNKNOWN_ID,
} from "./stub-api.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** A forgiving spelling of `code`: upper case, with `0` written `O` and `1` written `I`. */
const forgiving = (code: string) => code.toUpperCase().replaceAll("0", "O").replaceAll("1", "I");

const SITE_KEY = "1x00000000000000000000AA";

let api: Server;
let handler: {
  fetch(request: Request, options?: { context?: StartRequestContext }): Promise<Response>;
};

beforeAll(async () => {
  api = stubApi();
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  process.env["API_URL"] = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  // Cloudflare's published test key, which always passes.
  process.env["TURNSTILE_SITE_KEY"] = SITE_KEY;
  process.env["BALLOT_URL"] = BALLOT;
  // Built as deployed: the test runner sets NODE_ENV to `test`, which the
  // build would read as React's development bundle, so the budgets below
  // would count a script no visitor gets.
  const nodeEnv = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";
  try {
    await (await createBuilder({ root, logLevel: "warn" })).buildApp();
  } finally {
    if (nodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = nodeEnv;
  }
  const server = (await import(pathToFileURL(`${root}dist/server/server.js`).href)) as {
    default: typeof handler;
  };
  handler = server.default;
}, 120_000);

afterAll(async () => {
  await new Promise((resolve) => api.close(resolve));
});

/** Profiles as the front's reader gives them (src/node/main.ts), by handle. */
const HIDDEN_HANDLE = "hhhhhhhhhhhhhhhh";
const EMPTY_HANDLE = "eeeeeeeeeeeeeeee";
/** A name in a right-to-left script, which must not reorder the page's words (T-75). */
const PROFILE_NAME = "Riverside \u05e9\u05db\u05e0\u05d9\u05dd";
const profiles = new Map<string, ProfileRecord>([
  [
    PROFILE_HANDLE,
    {
      state: "visible",
      handle: PROFILE_HANDLE,
      name: PROFILE_NAME,
      // A poll the API no longer serves drops out of its page.
      polls: [UNKNOWN_ID, ...streamed],
    },
  ],
  [HIDDEN_HANDLE, { state: "hidden", handle: HIDDEN_HANDLE, reason: "harassment" }],
  [EMPTY_HANDLE, { state: "visible", handle: EMPTY_HANDLE, name: "Nobody yet", polls: [] }],
]);
/** Every handle the reader was asked for, in order. */
const profileReads: unknown[] = [];

/**
 * Who asked each poll, as the front's reader gives it (src/node/main.ts):
 * the typical poll, the stream's version-5 poll (which the profile shows
 * too) and the hidden poll, which core never names but the page must not
 * either. The questions poll's read fails, and the stream's version-1 poll's
 * handle is one core never issues.
 */
const ASKER: AskedBy = { handle: PROFILE_HANDLE, name: PROFILE_NAME };
const askers = new Map<string, AskedBy>([
  [ID, ASKER],
  [STREAM_V5, ASKER],
  [HIDDEN_ID, ASKER],
  [STREAM_V1, { handle: "../account", name: "Mallory" }],
]);
const FAILING_ASKER = QUESTIONS_ID;
/** Every argument the asked-by reader was given, in order. */
const askedByReads: unknown[] = [];

/** Every request goes through Start as the front sends it, with the account side's readers. */
function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return handler.fetch(new Request(`http://localhost${path}`, { headers }), {
    context: {
      readProfile: async (...args) => {
        profileReads.push(...args);
        return profiles.get(args[0]);
      },
      readAskedBy: async (...args) => {
        askedByReads.push(...args);
        if (args[0] === FAILING_ASKER) throw new Error("connection lost");
        return askers.get(args[0]);
      },
    },
  });
}

/** `get`, following one redirect to this site, as a browser would. */
async function follow(path: string): Promise<Response> {
  const response = await get(path);
  const location = response.headers.get("location");
  if (response.status !== 307 || location === null) return response;
  const next = new URL(location, "http://localhost");
  expect(next.origin).toBe("http://localhost");
  return get(next.pathname + next.search);
}

/** The nonce the CSP allows, checking the rest of the policy along the way. */
function cspNonce(response: Response): string {
  const csp = response.headers.get("content-security-policy") ?? "";
  // The poll editor's adds Turnstile's origin (src/security.ts), and nothing else.
  const match =
    /script-src 'self' 'nonce-([A-Za-z0-9+/]{22}==)'(?: https:\/\/challenges\.cloudflare\.com)?(?:;|$)/.exec(
      csp,
    );
  if (match?.[1] === undefined) throw new Error(`unexpected CSP: ${csp}`);
  return match[1];
}

describe("every page", () => {
  test.each([
    "/",
    `/polls/${ID}`,
    `/polls/${ID}/board`,
    `/polls/${CELLS_ID}/results`,
    "/moderation",
    "/polls",
    "/account",
    "/account/polls/new",
    `/account/polls/${"a".repeat(32)}/setup`,
    "/account/verify",
    "/how-it-works",
    "/verify",
    "/trustees",
    "/discover",
    `/by/${PROFILE_HANDLE}`,
    "/nowhere",
    `/p/${UNKNOWN_CODE}`,
    `/p/${CODE}/flyer`,
  ])(
    "%s carries the security headers, and its inline scripts the response's nonce",
    async (path) => {
      const response = await get(path);
      const nonce = cspNonce(response);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("connect-src 'self'");
      // Turnstile's origin only on the poll editor's pages (P2-22 part 6c) and
      // the verification page (P2-31 part 4; T-43, T-55).
      const editor = path === "/account/verify" || /^\/account\/polls\/[a-z0-9]+$/.test(path);
      expect(csp.includes("https://challenges.cloudflare.com")).toBe(editor);
      expect(csp.includes("frame-src")).toBe(editor);
      const html = await response.text();
      const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1] ?? "");
      expect(scripts.length).toBeGreaterThan(0);
      for (const attrs of scripts) {
        // Every script is either one of our bundles or nonced inline code.
        if (/\bsrc="/.test(attrs)) expect(attrs).toMatch(/\bsrc="\/assets\/[\w-]+\.js"/);
        else expect(attrs).toContain(`nonce="${nonce}"`);
      }
      expect(html).not.toMatch(/\son[a-z]+="/);
      // The CSP's style-src 'self' would block an inline style (P2-19).
      expect(html).not.toMatch(/\sstyle="/);
      // The one way off the site: the ballot client, with a poll in the fragment.
      expect(
        html.replaceAll(
          new RegExp(`href="${BALLOT}#election=[0-9a-f]{64}(?:&amp;pick=[0-9]+)?"`, "g"),
          "",
        ),
      ).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
    },
  );

  test("the frame marks the page the visitor is on, and only that one", async () => {
    const html = await (await get("/polls")).text();
    const current = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)].map((m) => m[0]);
    // The header's link and the footer's, which a phone's header leaves out.
    expect(current).toHaveLength(2);
    for (const link of current) expect(link).toContain('href="/polls"');
    expect(await (await get("/nowhere")).text()).not.toContain('aria-current="page"');
  });

  test("links the web app manifest and the icons from its head (P2-28 part 1a)", async () => {
    const html = await (await get("/discover")).text();
    const head = html.slice(0, html.indexOf("</head>"));
    const links = [...head.matchAll(/<link rel="(manifest|icon|apple-touch-icon)" ([^>]*)\/>/g)];
    expect(links.map(([, rel, attrs]) => [rel, attrs?.replace(/ nonce="[^"]*"/, "")])).toEqual([
      ["manifest", 'href="/manifest.webmanifest"'],
      ["icon", 'href="/icons/icon.svg" type="image/svg+xml"'],
      ["apple-touch-icon", 'href="/icons/apple-touch-icon.png"'],
    ]);
  });

  test("each response gets a nonce of its own", async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 5; i++) nonces.add(cspNonce(await get("/")));
    expect(nonces.size).toBe(5);
  });
});

describe("poll page", () => {
  test("shows the decoded definition and the board head, as claims", async () => {
    const response = await get(`/polls/${ID}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("what our server says about this poll");
    // The definition hash, from the published vector, for comparing with the registry (T-34).
    expect(html.replace(/<[^>]+>/g, "")).toContain(typical.hash);
    expect(html.replace(/<[^>]+>/g, "")).toContain(HEAD.chainHead);
    expect(html).toContain("One choice");
    expect(html).toContain("4 of 7");
    // The stub's poll closed on 8 January 2026, by its definition's own times.
    expect(html).toContain(">Closed</span>");
    // And when, beside its status at the top, in the definition's time
    // (P2-19 part 64).
    expect(html).toMatch(/>On<!-- --> <time datetime="2026-01-08T00:00:00.000Z"/i);
    // Closed, the panel says only that, and the evidence that each answer
    // was sealed on the voter's device, each said once (P2-29, the poll
    // page's iteration 13).
    expect(html).toContain("This poll has closed and takes no more answers.");
    expect(html.match(/sealed on/g)).toHaveLength(1);
    // The evidence is one step down, but in the server's HTML, so it opens without script.
    expect(html).toMatch(/<details\b[^>]*>\s*<summary\b/);
    // Above it, the heading and what the evidence shows in plain words,
    // whose summary offers to show it, saying so without script.
    const section = /<section aria-labelledby="evidence-title"[^>]*>([\s\S]*?)<details/.exec(
      html,
    )?.[1];
    expect(section?.replace(/<[^>]+>/g, "")).toBe(
      "How do we know this is real?" +
        "Every answer was sealed on the device that sent it and listed on the public board, which anyone can download and count again." +
        "Whoever asked it can&#x27;t see anyone&#x27;s answers. During launch, Abolish alone holds the key for this poll." +
        "How the poll&#x27;s key was made",
    );
    // P2-19 part 62: where that key came from, the ceremony's record on the
    // board's first page (T-14, T-40).
    expect(section).toContain(`href="/polls/${ID}/board#ceremony-title"`);
    const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? "";
    expect(summary).toMatch(/<span class="group-open:hidden">Show the evidence<\/span>/);
    expect(summary).toMatch(/<span class="hidden group-open:inline">Hide the evidence<\/span>/);
    expect(html).not.toContain('name="robots"');
    expect(html).toContain(`href="/p/${CODE}"`);
    expect(html).toContain(`<meta property="og:title" content="Poll ${CODE}"`);
    // The share sheet's trigger; the sheet itself opens in the browser.
    expect(html).toContain(">Share this poll<");
  });

  // P2-19 part 56: the class the definition states, and what one on the civic record means (T-14).
  test("names the poll's class, and says a civic-record class can't be registered yet", async () => {
    const everyday = (await (await get(`/polls/${ID}`)).text()).replace(/<[^>]+>/g, "");
    expect(everyday).toContain("Poll · Everyday poll · One choice");
    expect(everyday).toContain("KindEveryday poll");
    expect(everyday).not.toContain("civic record");
    const response = await get(`/polls/${CIVIC_ID}`);
    expect(response.status).toBe(200);
    const civic = (await response.text()).replace(/<[^>]+>/g, "");
    expect(civic).toContain("Civic referendum · Question by question");
    expect(civic).toContain("KindCivic referendum");
    expect(civic).toContain(
      "Its definition puts it on the civic record, which takes only polls whose key is held by independent trustees. None are named yet, so the election registry on chain refuses to register a poll like this one.",
    );
  });

  test("names Tier 0 by the deployment's phone setting, off unless set to on", async () => {
    // What the token issuer checks (P2-31 part 6b-2a; T-01).
    const text = async () => (await (await get(`/polls/${ID}`)).text()).replace(/<[^>]+>/g, "");
    expect(await text()).toContain("Tier 0 (verified e-mail)");
    process.env["PHONE_VERIFICATION"] = "on";
    try {
      const on = await text();
      expect(on).toContain("Tier 0 (verified e-mail and phone)");
      expect(on).not.toContain("Tier 0 (verified e-mail)");
    } finally {
      delete process.env["PHONE_VERIFICATION"];
    }
  });

  test("offers reactions to everyone alike, their counts read once the page's script runs", async () => {
    // The page's server never gets the account cookie (src/node/serve.ts), so
    // the counts and the account's own come from /reactions in the browser.
    const html = await (
      await get(`/polls/${ID}`, { cookie: "__Secure-abolish-account.session_token=secret" })
    ).text();
    expect(html).toContain('<h2 id="reactions-title"');
    expect(html).toContain("A reaction isn&#x27;t an answer");
    expect(html).toContain("Loading reactions…");
  });

  test("offers anyone a report of the poll, with nothing sent until a ground is chosen", async () => {
    const response = await get(`/polls/${ID}`);
    const html = await response.text();
    expect(html).toContain("Something wrong with this poll?");
    expect(html).toContain(">Report this poll<");
    // The grounds appear only once the page's script opens the form.
    expect(html).not.toContain("Why should a moderator look at it?");
  });

  test("offers following to everyone alike, reading nothing until the visitor asks", async () => {
    // The page's server never gets the account cookie (src/node/serve.ts),
    // and the page doesn't ask whether this account follows the poll (T-11).
    const html = await (
      await get(`/polls/${ID}`, { cookie: "__Secure-abolish-account.session_token=secret" })
    ).text();
    expect(html).toContain('<h2 id="follow-title"');
    expect(html).toContain("Following isn&#x27;t answering");
    expect(html).toContain(">Follow this poll<");
  });

  // P2-19 part 13: the page in the poll's own words, answerable from it.
  test("an open poll's page is headed and titled in its own words, its answers listed", async () => {
    const html = await (await get(`/polls/${OPEN_ONE}`)).text();
    // A poll with no title is headed by its question, in its language and
    // direction, and the title isolates it from the site's words (T-75).
    expect(html).toMatch(
      /<h1 id="poll-heading" lang="en" dir="auto"[^>]*>Should the park stay open late\?<\/h1>/,
    );
    expect(html).toContain("<title>\u2068Should the park stay open late?\u2069 · Abolish</title>");
    // Its ID is in the evidence, not in a label over its words (P2-29, the
    // poll page's iteration 11).
    expect(html).not.toContain(`Poll ${OPEN_ONE.slice(0, 16)}…`);
    expect(html).toContain(OPEN_ONE);
    const page = html.replace(/<[^>]+>/g, "");
    expect(page).toContain("What it asks");
    // The answers that open the ballot app are under one line, which says
    // "Pick one" as "Choose an answer" (P2-29, the poll page's iteration 8).
    expect(page).not.toContain("Pick one from 3 options");
    // Its one question heads the page, so it isn't said a second time, only numbered.
    expect(html).not.toMatch(/<h3[^>]*>(?:<[^>]+>)*[^<]*Should the park/);
    expect(html).toContain('<h3 id="question-0" class="sr-only">Question 1</h3>');
    // Each answer opens the ballot client with it chosen, as a stream card's
    // and the embed's do, and so does the one way in without a pick, each
    // carrying the poll in the fragment alone, which no server sees (T-10,
    // T-11; P2-29, the poll page's iteration 1).
    for (const [pick, label] of ["Yes", "No", "Abstain"].entries())
      expect(html).toMatch(
        new RegExp(
          `href="${BALLOT}#election=${OPEN_ONE}&amp;pick=${pick}"[^>]*><span lang="en" dir="auto"[^>]*>${label}</span>`,
        ),
      );
    expect(html).not.toContain("pick=3");
    expect(html).toContain(`href="${BALLOT}#election=${OPEN_ONE}"`);
    expect(page).toContain("Answer the question");
    // Said once, with the answers that open the ballot app (P2-29, the poll
    // page's iteration 7).
    expect(page.match(/Nothing is sent until you cast/g)).toHaveLength(1);
  });

  test("a poll of several questions is headed by its title, each question with its answers", async () => {
    const html = await (await get(`/polls/${OPEN_MANY}`)).text();
    expect(html).toMatch(/<h1 id="poll-heading" lang="en" dir="auto"[^>]*>Park and library<\/h1>/);
    expect(html).toContain("<title>\u2068Park and library\u2069 · Abolish</title>");
    const page = html.replace(/<[^>]+>/g, "");
    expect(page).toContain("Question 1: Should the park stay open late?");
    expect(page).toContain("Question 2: Should the library open on Sundays?");
    // Question 1's answers open the ballot app under their one line;
    // question 2's are words, with their rule (P2-29, the poll page's
    // iteration 8).
    expect(page).not.toContain("Pick one from 3 options");
    expect(page).toMatch(/Pick [a-z ]+ from 2 options/);
    // Its card is numbered and the lede counts the questions, so the line
    // over its answers doesn't say "question 1 of 2" (P2-29, the poll page's
    // iteration 10).
    expect(page).toContain("Choose an answer to open it in the ballot app.");
    expect(page).not.toContain("question 1\u00a0of\u00a02");
    expect(page).toContain("Answer 2 questions");
    expect(html).toContain(`href="${BALLOT}#election=${OPEN_MANY}"`);
    // A link carries one pick, for question 1: its 3 answers, not question 2's.
    for (const pick of [0, 1, 2])
      expect(html).toContain(`href="${BALLOT}#election=${OPEN_MANY}&amp;pick=${pick}"`);
    expect(html).not.toContain("pick=3");
  });

  test("the page's words follow its language, as its heading's", async () => {
    const html = await (await get(`/polls/${OPEN_ONE}`, { "accept-language": "es-MX" })).text();
    expect(html).toMatch(
      /<h1 id="poll-heading" lang="es-419" dir="auto"[^>]*>¿Debe el parque abrir hasta tarde\?<\/h1>/,
    );
    expect(html).toContain("Lo que pregunta");
    expect(html).toContain("Responder la pregunta");
  });

  test.each([
    ["a closed poll", STREAM_V1],
    ["a poll whose text fails its check", STREAM_BAD_TEXT],
    ["a poll with no text", STREAM_NO_TEXT],
    ["a hidden poll", HIDDEN_ID],
  ])("%s offers no way in to answer it", async (_, id) => {
    const html = await (await get(`/polls/${id}`)).text();
    expect(html).not.toContain(`href="${BALLOT}`);
    expect(html).not.toMatch(/>Answer (?:the question|\d+ questions)</);
  });

  test("a deployment that names no ballot client says answering isn't set up, linking nowhere", async () => {
    delete process.env["BALLOT_URL"];
    try {
      const html = await (await get(`/polls/${OPEN_ONE}`)).text();
      expect(html).not.toContain(BALLOT);
      expect(html).toContain("Answering from this page isn&#x27;t set up on this site yet.");
      // Its words are still shown.
      expect(html).toContain("What it asks");
    } finally {
      process.env["BALLOT_URL"] = BALLOT;
    }
  });

  test("a poll whose words can't be shown is headed and titled by its ID, with no questions", async () => {
    for (const id of [STREAM_BAD_TEXT, HIDDEN_ID]) {
      const html = await (await get(`/polls/${id}`)).text();
      expect(html).toContain(`Poll ${id.slice(0, 16)}…</h1>`);
      expect(html).toContain(`<title>Poll ${id.slice(0, 16)}… · Abolish</title>`);
      expect(html).not.toContain("What it asks");
    }
  });

  test("shows a version-5 poll question by question, with version 5's hash", async () => {
    const response = await get(`/polls/${QUESTIONS_ID}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain(
      toHex(electionDefinitionV5Hash(decodeElectionDefinitionV5(questionsDefinition))),
    );
    expect(text).toContain("Question by question");
    expect(text).toContain("4 questions, 18 options");
    expect(text).toContain("Question 1: Pick one, from 3 options; 0 to 1 selections");
    expect(text).toContain("Question 2: Pick any, from 5 options; 0 to 5 selections");
    expect(text).toContain("Question 3: Pick up to 2, from 4 options; 0 to 2 selections");
    expect(text).toContain("Question 4: Pick exactly 3, from 6 options; 3 to 3 selections");
    // Tier 0's regions, 5,000 + 1,200 + 40 + 980, and Tier 2's one.
    expect(text).toContain("7,220 members");
    expect(text).toContain("120 members");
    expect(text).not.toContain("Selections per ballot");
  });

  test("shows a collided poll's longer code, as the API resolves it", async () => {
    const html = await (await get(`/polls/${HIDDEN_ID}`)).text();
    expect(HIDDEN_CODE).toHaveLength(8);
    expect(html).toContain(`href="/p/${HIDDEN_CODE}"`);
    expect(html).toContain(`<meta property="og:title" content="Poll ${HIDDEN_CODE}"`);
  });

  test.each([
    ["a code that isn't a prefix of the poll's hash (T-34)", MISCODED_ID, MISCODED_CODE],
    ["no recorded registration", FILLER[1]!, codeOf(FILLER[1]!)],
    ["an API that fails to answer the code", CODE_FAILS_ID, codeOf(CODE_FAILS_ID)],
  ])("prints no code for %s", async (_, id, code) => {
    const response = await get(`/polls/${id}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("/p/");
    expect(html).not.toContain(code);
    expect(html).toContain('<meta property="og:title" content="A poll on localhost"');
    // Nothing to share without a short link.
    expect(html).not.toContain("Share this poll");
  });

  test("forwards nothing of the visitor's to the API (T-10)", async () => {
    seen.length = 0;
    await get(`/polls/${ID}`, {
      cookie: "__Secure-abolish-account.session_token=secret",
      authorization: "Bearer secret",
      "x-forwarded-for": "203.0.113.9",
      "user-agent": "visitor-agent",
    });
    // The definition, head, moderation, code, tags, display text, results and answered count.
    expect(seen.length).toBe(8);
    for (const { headers } of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers["x-forwarded-for"]).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain("secret");
      expect(JSON.stringify(headers)).not.toContain("203.0.113.9");
      expect(JSON.stringify(headers)).not.toContain("visitor-agent");
    }
  });

  // P2-19 part 21: how many have answered, on the poll page.
  test("says how many have answered the poll, tier by tier, or nothing when the read fails", async () => {
    const text = async (id: string) =>
      (await (await get(`/polls/${id}`)).text()).replace(/<[^>]+>/g, "|");
    // Each tier the definition names on its own line, one with none served
    // at 0; the API's count for a tier it doesn't name is left out (T-01).
    const counted = await text(STREAM_V5);
    expect(counted).toMatch(
      /Answered before it closed\|+1,204 people[| ]+·[| ]+Tier 0 \(verified e-mail\)\|+0 people[| ]+·[| ]+Tier 2 \(document-verified\)\|/,
    );
    expect(counted).not.toMatch(/\b7 people/);
    // An open poll's count is so far; none served is 0.
    expect(await text(OPEN_ONE)).toMatch(/Answered so far\|+0 people\|/);
    // A failed read shows no count, and the page stays.
    const failed = await text(STREAM_V1);
    expect(failed).toContain("This poll has closed and takes no more answers.");
    expect(failed).not.toMatch(/Answered (?:so far|before it closed)/);
  });

  test("shows where the poll is listed, each tag a link into the stream", async () => {
    const html = await (await get(`/polls/${ID}`)).text();
    const listed = /<ul aria-label="Where it&#x27;s listed"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1];
    expect(listed).toMatch(/<a [^>]*href="\/discover\?topic=housing"[^>]*>Housing<\/a>/);
    expect(listed).toMatch(
      /<a [^>]*href="\/discover\?place=Old%20Town"[^>]*><bdi>Old Town<\/bdi><\/a>/,
    );
    expect(html).toContain("moderation can change them");
  });

  test.each([
    ["no tags", FILLER[1]!],
    ["an API that fails to answer the tags", CODE_FAILS_ID],
    ["tags withheld while the poll is hidden (T-68)", HIDDEN_ID],
  ])("shows no tags for %s, and the page stands", async (_, id) => {
    const response = await get(`/polls/${id}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("Where it&#x27;s listed");
    expect(html).not.toContain("moderation can change them");
  });

  test("shows no place a draft couldn't hold, such as one with a bidi override (T-67)", async () => {
    const html = await (await get(`/polls/${OVERRIDE_ID}`)).text();
    const listed = /<ul aria-label="Where it&#x27;s listed"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1];
    expect(listed).toContain(">Food</a>");
    expect(listed).not.toContain("<bdi>");
    expect(html).not.toContain("\u202e");
    expect(html).not.toContain("teertS");
  });

  test("a hidden poll says so, with the reason, and is kept out of search engines", async () => {
    const html = await (await get(`/polls/${HIDDEN_ID}`)).text();
    expect(html).toContain("question and option text are withheld (Personal data)");
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).toContain("Approve any number");
    // Moderation withheld its text: we don't offer to spread it.
    expect(html).not.toContain("Share this poll");
    // And it takes no reactions, shows no counts and takes no followers (T-68).
    expect(html).not.toContain("reactions-title");
    expect(html).not.toContain("follow-title");
    // Nor a report: moderators have already removed its text.
    expect(html).not.toContain("Report this poll");
  });

  test("refuses a definition that names another election (T-34)", async () => {
    const html = await (await get(`/polls/${SWAPPED_ID}`)).text();
    expect(html).toContain("the definition of another poll");
    expect(html).not.toContain(typical.hash);
  });

  test.each([
    ["an unknown poll", UNKNOWN_ID],
    ["a non-canonical ID", ID.toUpperCase()],
    ["a short ID", ID.slice(2)],
  ])("%s is not found", async (_, id) => {
    const response = await get(`/polls/${id}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("There is no page at this address");
  });
});

describe("results", () => {
  const text = async (path: string) => (await (await get(path)).text()).replace(/<[^>]+>/g, "");
  const section = async (path: string) =>
    /<section aria-labelledby="results-title"[^>]*>([\s\S]*?)<\/section>\s*<section aria-labelledby="answer-title"/.exec(
      await (await get(path)).text(),
    )?.[1];

  test("a counted poll's results, in a sentence first, then each answer's share and count, by tier", async () => {
    const page = await text(`/polls/${STREAM_V1}`);
    expect(page).toContain("Tier 0 (verified e-mail)");
    expect(page).toContain("12 people answered");
    expect(page).toContain("Should the park stay open late?");
    // The author's words isolated inside our sentence (T-75).
    expect(page).toContain("Most picked: \u2068Yes\u2069, by 50% of those who answered.");
    expect(page).toContain("25%");
    expect(page).toContain("8.3%");
    expect(page).toContain("6 people");
    expect(page).toContain("1 person");
    // A tier with a cell still unopened shows no counts (ADR 0026: never a partial tier).
    expect(page).toContain("2 people answered");
    expect(page).toContain("Part of this group&#x27;s count isn&#x27;t published yet");
    // The board's results, not the verifier's verdict, with the way to check them (T-34).
    expect(page).toContain("Nothing on this page checks them for you");
    expect(await section(`/polls/${STREAM_V1}`)).toContain(`href="/polls/${STREAM_V1}/board"`);
  });

  test("a version-5 poll's results question by question, with a tie said as one", async () => {
    const page = await text(`/polls/${STREAM_V5}`);
    expect(page).toContain("8 people answered");
    expect(page).toContain("Should the library open on Sundays?");
    expect(page).toContain(
      "Tied for most picked: \u2068Yes\u2069 and \u2068No\u2069, each by 50% of those who answered.",
    );
    expect(page).toContain("Most picked: \u2068Yes\u2069, by 62.5% of those who answered.");
  });

  test("a hidden poll's results go by answer number, since its text is withheld", async () => {
    const page = await text(`/polls/${HIDDEN_ID}`);
    // Moderation never withholds a result (docs/moderation-policy.md).
    expect(page).toContain("3 people answered");
    expect(page).toContain("Most picked: \u2068Answer 1\u2069, by 100% of those who answered.");
    expect(page).toContain("Answer 5");
  });

  test.each([
    ["unopened and closed", ID, "The results appear here once its answers are counted."],
    ["unopened and open", OPEN_ONE, "The answers stay sealed until the poll closes on"],
    ["not counted here", FILLER[1]!, "This server doesn&#x27;t publish this poll&#x27;s results."],
    ["not ready", RESULTS_NOT_READY_ID, "The results couldn&#x27;t be loaded just now."],
    ["a failed read", RESULTS_FAILS_ID, "The results couldn&#x27;t be loaded just now."],
    // T-34: counts that don't fit the definition aren't printed under its options.
    [
      "counts that don't fit the poll",
      RESULTS_MISFIT_ID,
      "The results couldn&#x27;t be loaded just now.",
    ],
  ])("%s says so in place of the results, and still serves the page", async (_, id, says) => {
    const response = await get(`/polls/${id}`);
    expect(response.status).toBe(200);
    const html = (await section(`/polls/${id}`)) ?? "";
    expect(html).toContain(says);
    expect(html).not.toContain("answered</p>");
  });

  // P2-19 part 40: an open poll's sealed results in its mockup's words.
  test("an open poll's results say when they appear, who can't see them and who can open them", async () => {
    const html = (await section(`/polls/${OPEN_ONE}`)) ?? "";
    expect(html).toMatch(/^<h2 id="results-title"[^>]*>Results appear when it closes<\/h2>/);
    const page = html.replace(/<[^>]+>/g, "");
    expect(page).toMatch(
      /The answers stay sealed until the poll closes on January 1, 2100 at 12:00\s?AM\u00a0UTC\./,
    );
    // T-14: the asker holds no seat, and the page says whose the launch seats are.
    expect(page).toContain(
      "Until then whoever asked it can&#x27;t see them either: only the poll&#x27;s trustee seats can open the count, and during launch Abolish runs every seat.",
    );
    expect(page).toContain("Anyone can count the sealed answers on the poll&#x27;s public board");
    const es = (
      await (await get(`/polls/${OPEN_ONE}`, { "accept-language": "es-MX" })).text()
    ).replace(/<[^>]+>/g, "");
    expect(es).toContain("Los resultados aparecen cuando cierre");
    expect(es).toContain("Las respuestas siguen selladas hasta que la encuesta cierre el ");
  });

  // P2-19 part 41: an open poll's lede, in its mockup's words.
  test("an open poll says under its status that its answers can be changed until it closes", async () => {
    const one = (await (await get(`/polls/${OPEN_ONE}`)).text()).replace(/<[^>]+>/g, "");
    expect(one).toContain(
      "One question. You can change your answer until the poll closes, and only your last one counts.",
    );
    // Under the status, before the facts and what it asks.
    expect(one.indexOf("Open for answers")).toBeLessThan(one.indexOf("One question. You can"));
    expect(one.indexOf("One question. You can")).toBeLessThan(one.indexOf("What it asks"));
    // In its own words an everyday poll opens on its question, with no
    // label naming its ID, class and counting above it (P2-29, the poll
    // page's iteration 11); the evidence still says its kind.
    expect(one).not.toContain("Everyday poll · ");
    expect(one).toContain("KindEveryday poll");
    const many = (await (await get(`/polls/${OPEN_MANY}`)).text()).replace(/<[^>]+>/g, "");
    expect(many).toContain(
      "2 questions, answered together. You can change your answers until the poll closes, and only your last ones count.",
    );
    const es = (
      await (await get(`/polls/${OPEN_ONE}`, { "accept-language": "es-MX" })).text()
    ).replace(/<[^>]+>/g, "");
    expect(es).toContain("Una pregunta. Puedes cambiar tu respuesta hasta que cierre la encuesta");
  });

  test("a closed poll counted in its one tier is summed up under its heading, question by question", async () => {
    const html = await (await get(`/polls/${CELLS_ID}`)).text();
    const header = /<article[^>]*>\s*<header[^>]*>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
    const inShort = /<ul aria-label="In short"[^>]*>([\s\S]*?)<\/ul>/.exec(header)?.[1];
    expect(header.replace(/<[^>]+>/g, "")).toContain(
      "Final results. 8 people answered; here is what they said.",
    );
    expect(inShort?.replace(/<[^>]+>/g, "|")).toMatch(
      /Should the park stay open late\?\|+Tied for most picked: \u2068Yes\u2069 and \u2068No\u2069, each by 50% of those who answered\.\|+Should the library open on Sundays\?\|+Most picked: \u2068Yes\u2069, by 62\.5% of those who answered\./,
    );
    expect(inShort?.match(/<li/g)).toHaveLength(2);
  });

  test("a closed poll's summary links down to its evidence, which the link's fragment opens", async () => {
    const html = await (await get(`/polls/${CELLS_ID}`)).text();
    const header = /<article[^>]*>\s*<header[^>]*>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
    const link = /<a href="#evidence"[^>]*>([\s\S]*?)<\/a>/.exec(header)?.[1] ?? "";
    expect(link.replace(/<[^>]+>/g, "")).toBe("How do we know this is real?");
    // The target sits inside the closed disclosure, after its summary, so
    // following the link reveals it without script.
    const details = /<details[^>]*>([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
    expect(details).toMatch(/<\/summary>\s*<div id="evidence"/);
    expect(html.match(/id="evidence"/g)).toHaveLength(1);
  });

  test.each([
    // T-16: no lead across tiers, nor a summary of a tier still partly unopened.
    ["several tiers", STREAM_V1],
    ["one tier counted of the two it names", STREAM_V5],
    ["an open poll", OPEN_MANY],
    ["one not counted yet", ID],
  ])("%s has no summary", async (_, id) => {
    const html = await (await get(`/polls/${id}`)).text();
    expect(html).not.toContain('aria-label="In short"');
    expect(html).not.toContain("Final results.");
    expect(html).not.toContain('href="#evidence"');
  });

  test("the API is asked for the results by the poll's ID alone", async () => {
    seen.length = 0;
    await get(`/polls/${STREAM_V1}`, { cookie: "__Secure-abolish-account.session_token=secret" });
    const asks = seen.filter((r) => r.path === "/elections/results");
    expect(asks).toHaveLength(1);
    expect([...asks[0]!.query.keys()]).toEqual(["electionId"]);
    expect(asks[0]!.headers["cookie"]).toBeUndefined();
  });
});

describe("results page", () => {
  const text = async (path: string) => (await (await get(path)).text()).replace(/<[^>]+>/g, "");

  test("a poll's results question by question, under its own words", async () => {
    const response = await get(`/polls/${CELLS_ID}/results`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // Its heading in the author's words, isolated from ours (T-75).
    expect(html).toMatch(/<h1[^>]*><bdi[^>]*>Park and library<\/bdi><\/h1>/);
    expect(html).toContain("<title>Results · Poll c5c5c5c5c5c5c5c5…");
    const page = html.replace(/<[^>]+>/g, "");
    expect(page).toContain("Tier 0 (verified e-mail)");
    expect(page).toContain("8 people answered");
    // How many of the tier's 7,220 members answered, before what they picked.
    const turnout = page.indexOf("Turnout0.1% of 7,220 members");
    expect(turnout).toBeGreaterThan(page.indexOf("Results by group"));
    expect(turnout).toBeLessThan(page.indexOf("Tied for most picked"));
    // What its members proved, between its turnout and its answers: accounts, not people (T-01).
    const meaning = page.indexOf(
      "Tier 0 (verified e-mail). Each account here showed it holds an e-mail address.",
    );
    expect(meaning).toBeGreaterThan(turnout);
    expect(meaning).toBeLessThan(page.indexOf("Tied for most picked"));
    expect(page).toContain(
      "so this group counts accounts, not people, and is never added to another.",
    );
    expect(page).toContain(
      "Tied for most picked: \u2068Yes\u2069 and \u2068No\u2069, each by 50% of those who answered.",
    );
    expect(page).toContain("Most picked: \u2068Yes\u2069, by 62.5% of those who answered.");
    // One tier: nothing to set side by side.
    expect(page).not.toContain("The groups side by side");
  });

  test("is headed by the poll's facts and gives the ID and definition hash a recount starts from", async () => {
    const page = await text(`/polls/${CELLS_ID}/results`);
    expect(page).toContain("Who can vote");
    expect(page).toContain("Opens");
    expect(page).toContain("Closes");
    expect(page).toContain("Counting");
    expect(page).toContain("Check it yourself");
    // Whose word the page is, said under the facts before any figure, linking down (T-34).
    const upFront = page.indexOf("Everything below is what our server says about this poll.");
    expect(upFront).toBeGreaterThan(page.indexOf("Counting"));
    expect(upFront).toBeLessThan(page.indexOf("Results by group"));
    const html = await (await get(`/polls/${CELLS_ID}/results`)).text();
    expect(html).toMatch(/<a [^>]*href="#results-check-title"[^>]*>How to check it yourself<\/a>/);
    expect(html).toContain('id="results-check-title"');
    expect(page).toContain("Counting it again without us starts from this poll&#x27;s ID");
    expect(page).toContain("Poll ID");
    expect(page).toContain("Definition hash, to compare with the election registry on chain");
    // Where a receipt is, before the recount, and no lookup of one (T-11).
    const receipt = page.indexOf("Your receipt");
    expect(receipt).toBeGreaterThan(page.indexOf("Check it yourself"));
    expect(receipt).toBeLessThan(page.indexOf("Count this poll again"));
    expect(page).toContain("This page doesn&#x27;t look a receipt up");
  });

  test("a tier counted in several cells shows each cell's own results, with its regions and members", async () => {
    const page = await text(`/polls/${CELLS_ID}/results`);
    expect(page).toContain("Part by part");
    expect(page).toContain("This group is counted in 3 parts, each published on its own.");
    expect(page).toContain("Part 1");
    expect(page).toContain("region 1 · 5,000 members");
    expect(page).toContain("region 3 and region 4 · 1,020 members");
    // Cell 1's first question: 2 and 3 of its 5.
    expect(page).toContain("40%");
    expect(page).toContain("60%");
  });

  test("names the seat that opened each part of the count, as the board attributes it", async () => {
    const page = await text(`/polls/${CELLS_ID}/results`);
    expect(page).toContain("Who opened the count");
    expect(page).toMatch(/opened by one of this poll&#x27;s \d+ trustee seats, once at least \d+/);
    for (const part of [1, 2, 3])
      expect(page).toContain(`Tier 0 (verified e-mail) · Part ${part}Seat 1`);
  });

  test("several tiers side by side, never added together, and a tier of one cell has no parts", async () => {
    const page = await text(`/polls/${STREAM_V1}/results`);
    expect(page).toContain("12 people answered");
    expect(page).toContain("Tier 2 (document-verified)");
    expect(page).toContain("Most picked: \u2068Yes\u2069, by 50% of those who answered.");
    expect(page).toContain("There is no total column: the groups are never added together.");
    expect(page).toContain("Not all published yet");
    // Each group's column headed by its own turnout, never one across them (T-16).
    expect(page.match(/Turnout: [^A-Z]*members/g)).toEqual([
      "Turnout: 0.2% of 5,000 members",
      "Turnout: 1.7% of 120 members",
    ]);
    expect(page).not.toContain("14 people");
    expect(page).not.toContain("Part by part");
  });

  test("cells that don't add up to their tier aren't shown, and the tier's results still are (T-34)", async () => {
    const page = await text(`/polls/${CELLS_MISFIT_ID}/results`);
    expect(page).toContain("4 people answered");
    expect(page).toContain("This group&#x27;s parts couldn&#x27;t be shown just now.");
    expect(page).not.toContain("Who opened the count");
  });

  test("a hidden poll's results go by answer number, out of search engines", async () => {
    const html = await (await get(`/polls/${HIDDEN_ID}/results`)).text();
    expect(html).toContain('<meta name="robots" content="noindex"');
    const page = html.replace(/<[^>]+>/g, "");
    expect(page).toContain("Most picked: \u2068Answer 1\u2069, by 100% of those who answered.");
    expect(page).toContain("Poll efefefefefefefef…");
  });

  test.each([
    ["unopened and closed", ID, "The results appear here once its answers are counted."],
    ["unopened and open", OPEN_ONE, "Answers stay sealed while the poll is open."],
    ["not counted here", FILLER[1]!, "This server doesn&#x27;t publish this poll&#x27;s results."],
    ["a failed read", RESULTS_FAILS_ID, "The results couldn&#x27;t be loaded just now."],
    [
      "counts that don't fit the poll",
      RESULTS_MISFIT_ID,
      "The results couldn&#x27;t be loaded just now.",
    ],
  ])("%s says so, and still serves the page", async (_, id, says) => {
    const response = await get(`/polls/${id}/results`);
    expect(response.status).toBe(200);
    const page = (await response.text()).replace(/<[^>]+>/g, "");
    expect(page).toContain(says);
    expect(page).not.toContain("Results by group");
  });

  test("links back to the poll, to its board and to counting it yourself (T-34)", async () => {
    const html = await (await get(`/polls/${STREAM_V1}/results`)).text();
    expect(html).toContain(`href="/polls/${STREAM_V1}"`);
    expect(html).toContain(`href="/polls/${STREAM_V1}/board"`);
    expect(html).toContain('href="/verify"');
    expect(html).toContain("Nothing on this page checks them for you");
  });

  test("the poll page links to its results page once results are read", async () => {
    expect(await (await get(`/polls/${STREAM_V1}`)).text()).toContain(
      `href="/polls/${STREAM_V1}/results"`,
    );
    expect(await (await get(`/polls/${ID}`)).text()).not.toContain(`/polls/${ID}/results`);
  });

  test("states the board's head as the poll page does, as the server's word (T-23, T-34)", async () => {
    const html = await (await get(`/polls/${CELLS_ID}/results`)).text();
    const page = html.replace(/<[^>]+>/g, "");
    expect(page).toContain("What the board holds");
    expect(page).toContain(`Entries: ${HEAD.treeSize}`);
    expect(html).toContain(HEAD.chainHead);
    expect(html).toContain(HEAD.root);
    expect(html).toContain(`Fingerprint of the chain head ${HEAD.chainHead.slice(0, 8)}`);
    expect(page).toContain("only this server&#x27;s word");
  });

  test("gives the verifier's command for this poll alone, as the verify page runs it (T-53)", async () => {
    const html = await (await get(`/polls/${CELLS_ID}/results`)).text();
    expect(html).toContain(
      `<code translate="no">vp node packages/verifier/src/bin.ts --gateway $GATEWAY reports/${CELLS_ID}</code>`,
    );
    expect(html).not.toContain("$POLL_ID");
    expect(html.replace(/<[^>]+>/g, "")).toContain("anchor boards to Ethereum yet");
  });

  test("a failed read of the board's head leaves the results page up and says so", async () => {
    const response = await get(`/polls/${HEAD_FAILS_ID}/results`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const page = html.replace(/<[^>]+>/g, "");
    expect(page).toContain("The board couldn&#x27;t be read just now.");
    expect(html).not.toContain(HEAD.chainHead);
  });

  test("refuses a definition that names another election (T-34)", async () => {
    const page = await text(`/polls/${SWAPPED_ID}/results`);
    expect(page).toContain("the definition of another poll");
  });

  test.each([
    ["an unknown poll", UNKNOWN_ID],
    ["a non-canonical ID", STREAM_V1.toUpperCase()],
  ])("%s is not found", async (_, id) => {
    expect((await get(`/polls/${id}/results`)).status).toBe(404);
  });

  test("the API is asked by the poll's ID alone, with no cookie (T-10)", async () => {
    seen.length = 0;
    await get(`/polls/${CELLS_ID}/results`, {
      cookie: "__Secure-abolish-account.session_token=secret",
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      expect([...r.query.keys()]).toEqual(["electionId"]);
      expect(r.headers["cookie"]).toBeUndefined();
    }
    expect(seen.filter((r) => r.path === "/elections/results")).toHaveLength(1);
    expect(seen.filter((r) => r.path === "/board/head")).toHaveLength(1);
  });
});

describe("asked by", () => {
  const asked = (html: string) =>
    new RegExp(
      `Asked by(?:<!-- -->)? <a [^>]*href="/by/${PROFILE_HANDLE}"[^>]*><bdi>${PROFILE_NAME}</bdi></a>`,
    ).test(html);

  test("a poll's page names the profile its author chose, isolated and linked, as the website's word", async () => {
    const html = await (await get(`/polls/${ID}`)).text();
    // The name in its own isolate, so a right-to-left name can't reorder the page (T-75).
    expect(asked(html)).toBe(true);
    expect(html).toContain("It isn&#x27;t part of the poll");
    // The page's preview is unchanged: who asked isn't in what others copy of it.
    expect(html).toContain(`<meta property="og:title" content="Poll ${CODE}"`);
  });

  test("a poll no profile shows, a hidden poll, a failed read and a handle core never issues name no one", async () => {
    for (const id of [FILLER[0], HIDDEN_ID, QUESTIONS_ID]) {
      const response = await get(`/polls/${id}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Asked by");
      expect(html).not.toContain(PROFILE_NAME);
    }
    // The version-1 stream poll's handle reads as a path, so it would link off the profiles.
    const html = await (await get(`/polls/${STREAM_V1}`)).text();
    expect(html).not.toContain("Asked by");
    expect(html).not.toContain("Mallory");
  });

  test("the stream's cards name who asked, and a profile's own page doesn't repeat it", async () => {
    const stream = await (await get("/discover")).text();
    expect(stream.match(/Asked by/g)).toHaveLength(1);
    expect(asked(stream)).toBe(true);
    expect(stream).not.toContain("Mallory");
    const profile = await (await get(`/by/${PROFILE_HANDLE}`)).text();
    expect(profile).not.toContain("Asked by");
  });

  test("the reader is asked for poll IDs only, never anything of the visitor's", async () => {
    askedByReads.length = 0;
    await get(`/polls/${ID}`, { cookie: "__Secure-abolish-account.session_token=secret" });
    await get("/discover");
    expect(askedByReads.length).toBeGreaterThan(1);
    for (const read of askedByReads) expect(read).toMatch(/^[0-9a-f]{64}$/);
    expect(askedByReads).toContain(ID);
    expect(askedByReads).toContain(STREAM_V5);
  });

  test("a front with no reader names no one, and still serves the page", async () => {
    const response = await handler.fetch(new Request(`http://localhost/polls/${ID}`), {
      context: {},
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("Asked by");
  });
});

describe("board page", () => {
  const text = async (path: string) => (await (await get(path)).text()).replace(/<[^>]+>/g, "");
  const short = (entry: string) => {
    const hash = toHex(boardEntryHash(fromHex(entry)));
    return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
  };

  test("the poll page links to its board", async () => {
    expect(await (await get(`/polls/${ID}`)).text()).toContain(`href="/polls/${ID}/board"`);
  });

  test("shows a page of entries with the hashes this page computed, and the head as a claim", async () => {
    const response = await get(`/polls/${ID}/board`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const page = html.replace(/<[^>]+>/g, "");
    // A full page, though the API answers 7 entries at a time.
    expect(page).toContain("Entries 0 to 24 of 30");
    for (const entry of BOARD.slice(0, 25)) expect(page).toContain(short(entry));
    expect(page).not.toContain(short(BOARD[25]!));
    // The vector's first payloads: the ceremony, then a chain event.
    expect(page).toContain("Key ceremony");
    expect(page).toContain("Chain event");
    expect(page).toContain(HEAD.chainHead);
    expect(page).toContain("they are only this server");
    expect(page).not.toContain("Earlier entries");
    expect(html).toContain(`href="/polls/${ID}/board?from=25"`);
    // Never a lookup by entry number (T-10).
    expect(html).not.toMatch(/<input\b[^>]*name="from"/);
  });

  test("reads the key ceremony from the board's first entry, on its page only (T-34)", async () => {
    // The stub's first payload is the board vector's placeholder ceremony
    // record, which doesn't decode as a transcript.
    const first = await text(`/polls/${ID}/board`);
    expect(first).toContain("How the poll");
    expect(first).toContain("doesn&#x27;t decode as a ceremony record this page reads");
    expect(first).not.toContain("See it on the first page");
    const later = await get(`/polls/${ID}/board?from=25`);
    const html = await later.text();
    expect(html).toContain("is the board&#x27;s first entry.");
    expect(html).toContain(`href="/polls/${ID}/board?from=0#ceremony-title"`);
    expect(html).not.toContain("as a ceremony record this page reads");
  });

  test("shows the latest checkpoints, the latest first, with the hashes this page computed (T-23, T-24)", async () => {
    for (const from of ["0", "25", "50"]) {
      const page = await text(`/polls/${ID}/board?from=${from}`);
      const periods = [...page.matchAll(/After period (\d+)/g)].map((m) => Number(m[1]));
      expect(periods).toEqual([5, 4, 3, 2, 1, 0]);
      for (const c of CHECKPOINTS) {
        const checkpoint = decodeCheckpoint(fromHex(c));
        expect(page).toContain(toHex(checkpointHash(checkpoint)));
        expect(page).toContain(toHex(checkpoint.root));
      }
      expect(page).toContain(
        "that is for the verifier, which reads the anchor and the whole board",
      );
      // Fewer than the page asked for, and all of them shown: none earlier.
      expect(page).not.toContain("Only the latest");
    }
  });

  test("checks that the head and the checkpoints shown are one history, by the server's consistency proofs (T-24)", async () => {
    seen.length = 0;
    const page = (await text(`/polls/${ID}/board?from=25`)).replaceAll("&#x27;", "'");
    expect(page).toContain("The tree root above and the latest checkpoint's are one history");
    const extend = [...page.matchAll(/Extends the checkpoint after period (\d+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(extend).toEqual([4, 3, 2, 1, 0]);
    expect(page).not.toContain("not one history");
    expect(page).not.toContain("Doesn't extend");
    // One proof per pair of checkpoints shown, asked for by sizes alone; the
    // head and the latest checkpoint are the same size, so they need none.
    const proofs = seen.filter((r) => r.path.endsWith("/board/proofs/consistency"));
    expect(
      proofs
        .map((r) => [Number(r.query.get("firstSize")), Number(r.query.get("secondSize"))])
        .toSorted((x, y) => x[0]! - y[0]!),
    ).toEqual([
      [5, 10],
      [10, 15],
      [15, 20],
      [20, 25],
      [25, 30],
    ]);
    for (const r of proofs)
      expect([...r.query.keys()].toSorted()).toEqual(["electionId", "firstSize", "secondSize"]);
  });

  test("says so when the server's consistency proofs fail, and still shows the board (T-24)", async () => {
    brokenProofs.on = true;
    try {
      const page = (await text(`/polls/${ID}/board?from=25`)).replaceAll("&#x27;", "'");
      const broken = [...page.matchAll(/Doesn't extend the checkpoint after period (\d+)/g)].map(
        (m) => Number(m[1]),
      );
      expect(broken).toEqual([4, 3, 2, 1, 0]);
      expect(page).not.toContain("Extends the checkpoint");
      expect(page).toContain("evidence of tampering");
      // Equal sizes need no proof: the head and the latest checkpoint still agree.
      expect(page).toContain("The tree root above and the latest checkpoint's are one history");
      expect(page).toContain("Entries 25 to 29 of 30");
    } finally {
      brokenProofs.on = false;
    }
  });

  test("checks that each entry on the page is in the head's tree, asking for every one alike (T-10, T-24)", async () => {
    seen.length = 0;
    const page = (await text(`/polls/${ID}/board?from=25`)).replaceAll("&#x27;", "'");
    expect(page).toContain(
      "The 5 entries on this page that the tree root above covers are each in that tree",
    );
    expect(page).not.toContain("isn't in the tree whose root is above");
    // One proof per entry of the page, in the head's tree, asked for by
    // position alone: the same requests whichever entry a visitor came for.
    const proofs = seen.filter((r) => r.path.endsWith("/board/proofs/inclusion"));
    expect(
      proofs
        .map((r) => [Number(r.query.get("index")), Number(r.query.get("treeSize"))])
        .toSorted((x, y) => x[0]! - y[0]!),
    ).toEqual([25, 26, 27, 28, 29].map((i) => [i, 30]));
    for (const r of proofs)
      expect([...r.query.keys()].toSorted()).toEqual(["electionId", "index", "treeSize"]);
  });

  test("says so when an entry's inclusion proof fails, and still shows the board (T-23, T-24)", async () => {
    brokenInclusion.at = 27;
    try {
      const page = (await text(`/polls/${ID}/board?from=25`)).replaceAll("&#x27;", "'");
      expect(page).toContain("Entry 27 isn't in the tree whose root is above");
      expect(page).toContain("evidence of tampering");
      expect(page).not.toContain("that the tree root above covers");
      expect(page).toContain("Entries 25 to 29 of 30");
    } finally {
      brokenInclusion.at = undefined;
    }
  });

  test("counts each period's entries from the checkpoints, as SVG attributes only", async () => {
    const html = await (await get(`/polls/${ID}/board?from=25`)).text();
    expect(html).toContain(
      'aria-label="Entries per period, periods 0 to 5: 30 entries in all. Every period is in the table below."',
    );
    const table = html.slice(html.indexOf("Entries added in each period, earliest first"));
    const counts = [
      ...table.matchAll(/<th scope="row"[^>]*>(\d+)<\/th><td[^>]*><data value="(\d+)"/g),
    ];
    expect(counts.map((m) => [Number(m[1]), Number(m[2])])).toEqual(
      [0, 1, 2, 3, 4, 5].map((s) => [s, 5]),
    );
    const bars = [...html.matchAll(/<rect [^>]*height="([\d.]+)"[^>]*class="fill-primary"/g)];
    expect(bars).toHaveLength(6);
    expect(new Set(bars.map((m) => m[1])).size).toBe(1);
  });

  test("refuses checkpoints that name another poll, showing none of them (T-31)", async () => {
    // Past the end, so the entries (also the typical poll's) don't refuse the page first.
    const page = await text(`/polls/${FILLER[3]}/board?from=50`);
    expect(page).toContain("there is no entry 50 yet");
    expect(page).toContain("sent checkpoints for this board that");
    expect(page).not.toContain("After period");
    expect(page).not.toContain(toHex(checkpointHash(decodeCheckpoint(fromHex(CHECKPOINTS[0]!)))));
  });

  test("pages by windows of 25, with links to the earlier ones", async () => {
    const html = await (await get(`/polls/${ID}/board?from=25`)).text();
    const page = html.replace(/<[^>]+>/g, "");
    expect(page).toContain("Entries 25 to 29 of 30");
    expect(page).not.toContain(short(BOARD[24]!));
    expect(html).toContain(`href="/polls/${ID}/board?from=0"`);
    expect(page).not.toContain("Later entries");
  });

  test("filters the page in hand by kind, asking the API for the same entries (T-10)", async () => {
    seen.length = 0;
    await get(`/polls/${ID}/board?from=0`);
    const plain = seen.map((r) => `${r.path}?${r.query}`).toSorted();
    seen.length = 0;
    const html = await (await get(`/polls/${ID}/board?from=0&kind=ceremony`)).text();
    expect(seen.map((r) => `${r.path}?${r.query}`).toSorted()).toEqual(plain);
    const page = html.replace(/<[^>]+>/g, "");
    // The vector's first payload is the ceremony, the next a chain event.
    expect(page).toContain(short(BOARD[0]!));
    expect(page).not.toContain(short(BOARD[1]!));
    expect(page).toContain("Entries 0 to 24 of 30");
    expect(page).toMatch(/\d+ of the 25 entries on this page are of this kind\./);
    expect(html).toMatch(
      /<input[^>]*value="ceremony"[^>]*checked=""|<input[^>]*checked=""[^>]*value="ceremony"/,
    );
    expect(html).toContain(`href="/polls/${ID}/board?from=25&amp;kind=ceremony"`);
    expect(html).toContain(`href="/polls/${ID}/board?from=0"`);
    // The form keeps the page it filters, and still offers no lookup by entry number.
    const later = await (await get(`/polls/${ID}/board?from=25&kind=all`)).text();
    expect(later).toMatch(/<input type="hidden" name="from" value="25"\/>/);
    expect(later).not.toMatch(/<input\b(?![^>]*type="hidden")[^>]*name="from"/);
  });

  test("shows every kind for an unknown or repeated kind", async () => {
    for (const search of ["kind=vote", "kind=ceremony&kind=ballot", "kind=Ceremony"]) {
      const page = (await (await follow(`/polls/${ID}/board?${search}`)).text()).replace(
        /<[^>]+>/g,
        "",
      );
      expect(page).toContain(short(BOARD[1]!));
      expect(page).not.toContain("entries on this page are of this kind");
    }
  });

  test("says where the board ends, and when an entry isn't on it yet", async () => {
    expect(await text(`/polls/${ID}/board?from=50`)).toContain("there is no entry 50 yet");
  });

  test("starts from the first entry for anything but a canonical page start", async () => {
    for (const from of ["abc", "01", "-1", "10", "18446744073709551616"]) {
      const response = await follow(`/polls/${ID}/board?from=${from}`);
      expect((await response.text()).replace(/<[^>]+>/g, "")).toContain("Entries 0 to 24 of 30");
    }
  });

  test("refuses entries that name another poll, showing none of them (T-31)", async () => {
    const page = await text(`/polls/${FILLER[3]}/board`);
    expect(page).toContain("sits at another place");
    expect(page).not.toContain(short(BOARD[0]!));
  });

  test("refuses a definition that names another election (T-34)", async () => {
    expect(await text(`/polls/${SWAPPED_ID}/board`)).toContain("the definition of another poll");
  });

  test.each([
    ["an unknown poll", UNKNOWN_ID],
    ["a non-canonical ID", ID.toUpperCase()],
  ])("%s has no board page", async (_, id) => {
    expect((await get(`/polls/${id}/board`)).status).toBe(404);
  });
});

describe("lookup", () => {
  test("sends a pasted ID to its canonical page", async () => {
    const response = await get(`/polls?id=${encodeURIComponent(` 0x${ID.toUpperCase()} `)}`);
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("location")).toMatch(new RegExp(`/polls/${ID}$`));
  });

  test.each(["?id=a&id=b", "?id=", "?id=%00"])(
    "%s is a normal page, quoting no error",
    async (search) => {
      const response = await follow(`/polls${search}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('name="id"');
      expect(html).not.toMatch(/new Error|is not a function/);
    },
  );

  test("returns anything else to the form, marked invalid", async () => {
    const html = await (await get("/polls?id=123")).text();
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('value="123"');
  });
});

describe("short links", () => {
  test("a poll's code sends the visitor to its page, cacheable for a day", async () => {
    const response = await get(`/p/${CODE}`);
    expect(response.status).toBe(301);
    expect(new URL(response.headers.get("location") ?? "", "http://localhost").pathname).toBe(
      `/polls/${ID}`,
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toBeNull();
    const page = await get(`/polls/${ID}`);
    expect(page.status).toBe(200);
    expect((await page.text()).replace(/<[^>]+>/g, "")).toContain(typical.hash);
  });

  test.each([
    ["as a QR code carries it", () => `/P/${CODE.toUpperCase()}`],
    ["in a forgiving spelling", () => `/p/${forgiving(CODE)}`],
    ["in mixed case", () => `/p/${CODE.slice(0, 3).toUpperCase()}${CODE.slice(3)}`],
  ])("a code %s resolves the same", async (_, path) => {
    seen.length = 0;
    const response = await get(path());
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toMatch(new RegExp(`/polls/${ID}$`));
    // The API is asked for the canonical code only.
    expect(seen.find((r) => r.path === "/elections/by-code")).toBeDefined();
  });

  test("a code longer than 7 characters resolves when its poll owns it, hidden or not", async () => {
    const response = await get(`/p/${HIDDEN_CODE}`);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toMatch(new RegExp(`/polls/${HIDDEN_ID}$`));
  });

  test.each([
    ["a code no poll owns", () => UNKNOWN_CODE],
    ["a code the API claims for a poll whose hash doesn't start with it", () => FALSE_CODE],
    ["a code whose poll's served definition names another election (T-34)", () => SWAPPED_CODE],
  ])("%s is not found, and not cached", async (_, code) => {
    const response = await get(`/p/${code()}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("There is no page at this address");
    expect(html).not.toContain(code());
  });

  test.each([
    ["a u", "3j55dwu"],
    ["too short", "3j55dw"],
    ["too long", "3".repeat(53)],
    ["far too long", "3".repeat(300)],
    ["punctuation", "3j55-dw1"],
    ["a non-ASCII letter", "3j55dw\u212a"],
    ["padding bits set in the 52nd character", "0".repeat(51) + "1"],
  ])("%s is not found without asking the API, quoting nothing", async (_, code) => {
    seen.length = 0;
    const response = await get(`/p/${encodeURIComponent(code)}`);
    expect(response.status).toBe(404);
    expect(seen.filter((r) => r.path === "/elections/by-code")).toEqual([]);
    expect(await response.text()).not.toContain(code);
  });

  test("forwards nothing of the visitor's to the API (T-10)", async () => {
    seen.length = 0;
    await get(`/p/${CODE}`, {
      cookie: "__Secure-abolish-account.session_token=secret",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(seen.map((r) => r.path)).toEqual(["/elections/by-code", "/elections/definition"]);
    for (const { headers } of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain("secret");
      expect(JSON.stringify(headers)).not.toContain("203.0.113.9");
    }
  });

  test("other redirects stay uncached", async () => {
    const response = await get(`/polls?id=${ID}`);
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("flyer", () => {
  /** The sheet's HTML, from its opening tag to its tabs' end. */
  const sheetOf = (html: string) =>
    html.slice(html.indexOf("data-flyer"), html.indexOf("</ul>", html.indexOf("data-flyer")));

  test("prints the poll's short link, as the poll page names it, on US Letter by default", async () => {
    const response = await get(`/p/${CODE}/flyer`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<meta name="robots" content="noindex"');
    const sheet = sheetOf(html);
    expect(sheet).toContain("[page:flyer-letter]");
    expect(sheet).toContain(`>Poll ${CODE}</h2>`);
    // The QR code is drawn on the server, so the sheet prints without script.
    expect(sheet).toContain(`<svg role="img" aria-label="QR code for localhost/p/${CODE}"`);
    // Seven tear-off tabs, each with the link.
    expect(sheet.match(new RegExp(`/p/<br/>${CODE}</span>`, "g"))).toHaveLength(7);
    expect(html).toMatch(
      /<a href="\/p\/[0-9a-z]+\/flyer\?paper=letter&amp;ink=color" aria-current="page"/,
    );
    // The stub's poll closed on 8 January 2026.
    expect(sheet).toContain("Scan to see the poll");
    expect(sheet).toContain("Closed January 8, 2026");
    expect(sheet).toContain("Abolish alone holds the key for this poll");
  });

  test("comes on A4 and in black and white by its links, which need no script", async () => {
    const html = await (await get(`/p/${CODE}/flyer?paper=a4&ink=mono`)).text();
    const sheet = sheetOf(html);
    expect(sheet).toContain("[page:flyer-a4]");
    expect(sheet).not.toMatch(/\b(?:bg|border)-primary\b/);
    expect(html).toContain(`href="/p/${CODE}/flyer?paper=letter&amp;ink=mono"`);
    expect(html).toContain(`href="/p/${CODE}/flyer?paper=a4&amp;ink=color"`);
    // Anything else is the default, quoting nothing.
    const other = await (await follow(`/p/${CODE}/flyer?paper=%3Cb%3E&ink=x`)).text();
    expect(sheetOf(other)).toContain("[page:flyer-letter]");
    expect(other).not.toContain("&lt;b&gt;");
  });

  test("a code in any spelling prints its canonical form", async () => {
    const response = await get(`/P/${CODE.toUpperCase()}/flyer`);
    expect(response.status).toBe(200);
    const sheet = sheetOf(await response.text());
    expect(sheet).toContain(`>Poll ${CODE}</h2>`);
    expect(sheet).not.toContain(CODE.toUpperCase());
  });

  // P2-24 part 6: the poll's words, checked as a stream card's are, in their
  // own language and direction.
  test("prints the poll's own words where its display text checks, in the page's translation", async () => {
    const english = await (await get(`/p/${OPEN_ONE_CODE}/flyer`)).text();
    expect(sheetOf(english)).toMatch(
      /<h2 lang="en" dir="auto" class="[^"]+">Should the park stay open late\?<\/h2>/,
    );
    expect(english).not.toContain(`Poll ${OPEN_ONE_CODE}`);
    // Isolated in the title, so right-to-left words can't reorder the site's (T-75).
    expect(english).toContain(
      "<title>Print a flyer · \u2068Should the park stay open late?\u2069 · Abolish</title>",
    );
    const spanish = await (
      await get(`/p/${OPEN_ONE_CODE}/flyer`, { "accept-language": "es-MX" })
    ).text();
    expect(sheetOf(spanish)).toContain('<h2 lang="es-419" dir="auto" class="');
    expect(sheetOf(spanish)).toContain(">¿Debe el parque abrir hasta tarde?</h2>");
    // A poll of several is named by its title.
    const many = await (await get(`/p/${OPEN_MANY_CODE}/flyer`)).text();
    expect(sheetOf(many)).toContain(">Park and library</h2>");
  });

  test("a poll whose words can't be shown is named by its code, in our language", async () => {
    const html = await (await get(`/p/${CODE}/flyer`)).text();
    expect(sheetOf(html)).toMatch(/<h2 class="[^"]+">Poll [0-9a-z]+<\/h2>/);
    expect(html).toContain(`<title>Print a flyer · Poll ${CODE} · Abolish</title>`);
  });

  test("a hidden poll gets no flyer, and says why", async () => {
    const response = await get(`/p/${HIDDEN_CODE}/flyer`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Moderation has hidden this poll");
    expect(html).not.toContain("data-flyer");
    expect(html).toContain(`href="/p/${HIDDEN_CODE}"`);
  });

  test.each([
    ["a code no poll owns", () => UNKNOWN_CODE],
    ["a code the API claims for a poll whose hash doesn't start with it", () => FALSE_CODE],
    ["a code whose poll's served definition names another election (T-34)", () => SWAPPED_CODE],
    ["a malformed code", () => "3j55-dw1"],
  ])("%s is not found, quoting nothing", async (_, code) => {
    const response = await get(`/p/${code()}/flyer`);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("There is no page at this address");
    expect(html).not.toContain(code());
  });

  test("forwards nothing of the visitor's to the API (T-10)", async () => {
    seen.length = 0;
    await get(`/p/${CODE}/flyer?paper=a4`, {
      cookie: "__Secure-abolish-account.session_token=secret",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const { headers } of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain("secret");
      expect(JSON.stringify(headers)).not.toContain("203.0.113.9");
    }
  });
});

describe("embed", () => {
  /** The policy every embed carries, found or not (src/security.ts, `embedHeaders`). */
  const embedPolicy = (response: Response) => {
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors *");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    // No script of any kind, ours included.
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("nonce-");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("set-cookie")).toBeNull();
  };

  /** Checks what any embed's HTML may hold: no script, nothing to fill in, every link a new tab. */
  const scriptFree = (html: string) => {
    expect(html).not.toMatch(/<script\b/);
    expect(html).not.toMatch(/<(?:form|input|button|select|textarea|iframe)\b/);
    expect(html).not.toMatch(/\son[a-z]+="/);
    expect(html).not.toMatch(/\sstyle="/);
    for (const [link] of html.matchAll(/<a\b[^>]*>/g)) {
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener"');
    }
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/[\w-]+\.css"\/>/);
  };

  test("draws an open poll's question, each answer a link into the ballot client, with no script", async () => {
    const response = await get(`/embed/p/${OPEN_ONE_CODE}`);
    expect(response.status).toBe(200);
    embedPolicy(response);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const html = await response.text();
    scriptFree(html);
    expect(html).toContain('<meta name="robots" content="noindex"');
    // The reader's own setting by default.
    expect(html).toMatch(/<html lang="en-US">/);
    // The poll's own words, not the preview's headline, in the heading and
    // the title, which isolates them from the site's name (T-75).
    expect(html).not.toContain(`Poll ${OPEN_ONE_CODE}`);
    expect(html).toMatch(/<title>\u2068[^<]+\u2069 · Abolish<\/title>/);
    expect(html).toMatch(/<h1 id="[^"]+" lang="[a-z-]+" dir="auto"/);
    // Each answer carries the poll and the pick in the fragment, which no server sees.
    for (const pick of [0, 1, 2])
      expect(html).toContain(`href="${BALLOT}#election=${OPEN_ONE}&amp;pick=${pick}"`);
    expect(html).not.toContain("pick=3");
    expect(html).toContain(`href="${BALLOT}#election=${OPEN_ONE}"`);
    expect(html).toContain("Answer on Abolish");
    expect(html).toContain("Answers are taken only on Abolish, never in this card.");
    expect(html).toContain(`href="http://localhost/p/${OPEN_ONE_CODE}"`);
    expect(html).toContain("Closes");
    // The only links off the card: the ballot client and the poll's short link.
    expect(
      html
        .replaceAll(
          new RegExp(`href="${BALLOT}#election=${OPEN_ONE}(?:&amp;pick=[0-9])?"`, "g"),
          "",
        )
        .replaceAll(`href="http://localhost/p/${OPEN_ONE_CODE}"`, ""),
    ).not.toMatch(/href="(?:https?:)?\/\//);
  });

  test("names how many questions a poll of several has, and answers its first", async () => {
    const html = await (await get(`/embed/p/${OPEN_MANY_CODE}`)).text();
    scriptFree(html);
    expect(html).toContain("2 questions");
    expect(html).toContain("Answer 2 questions on Abolish");
    expect(html).toContain("Pick an answer to question 1 of 2.");
    expect(html).toContain(`href="${BALLOT}#election=${OPEN_MANY}&amp;pick=2"`);
    expect(html).not.toContain("pick=3");
  });

  test("a closed poll takes no answers and links to its page", async () => {
    const html = await (await get(`/embed/p/${CODE}`)).text();
    scriptFree(html);
    expect(html).not.toContain(BALLOT);
    // The stub serves no text for it, so the card names it as the link preview does.
    expect(html).toContain(`>Poll ${CODE}</h1>`);
    expect(html).toContain("See the poll on localhost");
    expect(html).toContain("Closed");
    expect(html).toContain("January 8, 2026");
  });

  // P2-24 part 4b: a closed poll's final count, from the results its page reads.
  test("a closed poll counted in one tier shows its first question's final count", async () => {
    const html = (await (await get(`/embed/p/${STREAM_V5_CODE}`)).text()).replaceAll("&#x27;", "'");
    scriptFree(html);
    const results =
      /<section aria-labelledby="[^"]+" class="[^"]*" data-testid="embed-results">(.*?)<\/section>/.exec(
        html,
      )?.[1];
    if (results === undefined) throw new Error("no results");
    // The first question's count, labelled, never a figure across questions (T-16).
    expect(results).toContain("Final count · 8 answers counted · Question 1 of 2");
    expect(results).toContain(
      "Tied for most picked: \u2068Yes\u2069 and \u2068No\u2069, each by 50% of those who answered.",
    );
    expect(results.match(/<li\b/g)).toHaveLength(3);
    for (const share of [">50%<", ">50%<", ">0%<"]) expect(results).toContain(share);
    // The second question's counts (5 and 1 of 8) appear nowhere.
    expect(html).not.toMatch(/62\.5%|12\.5%/);
    // Still no answers taken here.
    expect(html).not.toContain(BALLOT);
  });

  test("a closed poll counted in several tiers shows no figure across them", async () => {
    const html = (await (await get(`/embed/p/${STREAM_V1_CODE}`)).text()).replaceAll("&#x27;", "'");
    scriptFree(html);
    expect(html).toContain("Each tier is counted on its own.");
    expect(html).not.toContain("%");
    expect(html).not.toContain("Final count");
  });

  test("a closed poll not yet counted says so, with no figure", async () => {
    const html = (await (await get(`/embed/p/${CODE}`)).text()).replaceAll("&#x27;", "'");
    expect(html).toContain("The count isn't published yet.");
    expect(html).not.toContain("%");
  });

  test("an open poll's embed shows nothing of its results, whatever the API answers", async () => {
    // The stub serves counts for this open poll, as a faulty or hostile API could.
    const html = await (await get(`/embed/p/${OPEN_MANY_CODE}`)).text();
    expect(html).not.toContain('data-testid="embed-results"');
    expect(html).not.toContain("%");
  });

  test("comes light or dark by its link, and otherwise follows the reader", async () => {
    expect(await (await get(`/embed/p/${CODE}?theme=dark`)).text()).toMatch(
      /<html lang="en-US" data-theme="dark">/,
    );
    expect(await (await get(`/embed/p/${CODE}?theme=light`)).text()).toMatch(
      /<html lang="en-US" data-theme="light">/,
    );
    const other = await (await get(`/embed/p/${CODE}?theme=%3Cb%3E`)).text();
    expect(other).toMatch(/<html lang="en-US">/);
    expect(other).not.toContain("&lt;b&gt;");
  });

  test("a code in any spelling draws its canonical form", async () => {
    const html = await (await get(`/embed/p/${forgiving(CODE)}`)).text();
    expect(html).toContain(`>Poll ${CODE}</h1>`);
    expect(html).not.toContain(forgiving(CODE));
  });

  test("a hidden poll shows none of its text, and links to its page", async () => {
    const response = await get(`/embed/p/${HIDDEN_CODE}`);
    expect(response.status).toBe(200);
    embedPolicy(response);
    const html = await response.text();
    scriptFree(html);
    expect(html).toContain("Moderation has hidden this poll");
    expect(html).not.toContain('data-testid="embed-card"');
    expect(html).toContain(`href="http://localhost/p/${HIDDEN_CODE}"`);
  });

  test.each([
    ["a code no poll owns", () => UNKNOWN_CODE],
    ["a code the API claims for a poll whose hash doesn't start with it", () => FALSE_CODE],
    ["a code whose poll's served definition names another election (T-34)", () => SWAPPED_CODE],
    ["a malformed code", () => "3j55-dw1"],
  ])("%s is not found, quoting nothing and never cached", async (_, code) => {
    const response = await get(`/embed/p/${code()}`);
    expect(response.status).toBe(404);
    embedPolicy(response);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    scriptFree(html);
    expect(html).toContain("No poll here");
    expect(html).not.toContain(code());
  });

  test("forwards nothing of the reader's to the API (T-10, T-11)", async () => {
    seen.length = 0;
    await get(`/embed/p/${OPEN_ONE_CODE}?theme=dark`, {
      cookie: "__Secure-abolish-account.session_token=secret",
      "x-forwarded-for": "203.0.113.9",
      referer: "https://news.example/story",
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const { headers } of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain("secret");
      expect(JSON.stringify(headers)).not.toContain("203.0.113.9");
      expect(JSON.stringify(headers)).not.toContain("news.example");
    }
  });

  test("only the embed may be framed: every other page refuses", async () => {
    for (const path of [`/p/${CODE}/flyer`, `/polls/${ID}`, `/embed/p/${CODE}/x`, "/embed"])
      expect((await get(path)).headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
  });
});

describe("poll list", () => {
  /** The polls a page of the list links to, in order. */
  const linked = (html: string) =>
    [...html.matchAll(/<h3\b[^>]*><a[^>]*href="\/polls\/([0-9a-f]{64})"/g)].map((m) => m[1]);

  test("pages through what the API lists, each poll's definition decoded", async () => {
    const first = await (await get("/polls")).text();
    expect(first).toContain("Listed polls");
    expect(first).toContain('name="id"');
    const page1 = linked(first);
    expect(listed.indexOf(LOST_ID)).toBe(19);
    expect(page1).toEqual(listed.slice(0, 19));
    const more = /href="\/polls\?after=([0-9a-f]{64})"/.exec(first)?.[1];
    // The cursor is the listing's last ID, even when that poll isn't shown.
    expect(more).toBe(listed[19]);
    const second = await (await get(`/polls?after=${more}`)).text();
    const page2 = linked(second);
    // The poll the stub lost drops out; nothing else is skipped or repeated.
    expect([...page1, ...page2]).toEqual(listed.filter((id) => id !== LOST_ID));
    expect(second).not.toMatch(/href="\/polls\?after=/);
    expect(first).toContain("One choice");
  });

  // P2-19 part 47: the register's pages.
  test("leads from a later page back to the first, and past the last poll says the list ended", async () => {
    const pages = (html: string) =>
      /<nav [^>]*aria-label="Pages of the list"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    const first = await (await get("/polls")).text();
    expect(pages(first)).toContain(`href="/polls?after=${listed[19]}"`);
    expect(pages(first)).not.toContain("First page");
    const second = await (await get(`/polls?after=${listed[19]}&status=closed`)).text();
    expect(pages(second)).toMatch(/href="\/polls\?status=closed"[^>]*>.*First page<\/a>/);
    // A cursor at the last listed poll, as a full last page's link gives.
    const past = await (await get(`/polls?after=${listed.at(-1)}&q=park`)).text();
    expect(linked(past)).toEqual([]);
    expect(past).toContain("No more polls");
    expect(past).not.toContain("No polls listed.");
    expect(past).not.toContain("No listed poll matches");
    expect(past).toMatch(/href="\/polls\?q=park"[^>]*>First page<\/a>/);
  });

  // P2-19 part 49: the register's previous page.
  test("turns back a page before the first poll shown, and to the first page at the start", async () => {
    const pages = (html: string) =>
      /<nav [^>]*aria-label="Pages of the list"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    // The first page offers nothing back.
    expect(pages(await (await get("/polls")).text())).not.toContain("Previous page");
    // The second page turns back before its first poll, keeping the filters.
    const second = await (await get(`/polls?after=${listed[19]}&status=closed`)).text();
    expect(pages(second)).toMatch(
      new RegExp(`href="/polls\\?before=${listed[20]}&amp;status=closed"[^>]*>.*Previous page</a>`),
    );
    // Back from there is the start of the list: the first page, which shows it whole.
    for (const [search, target] of [
      [`before=${listed[20]}`, "/polls"],
      [`before=${listed[20]}&status=closed&q=+park`, "/polls?status=closed&q=+park"],
    ] as const) {
      const response = await get(`/polls?${search}`);
      expect(response.status, search).toBe(307);
      const location = new URL(response.headers.get("location") ?? "", "http://localhost");
      expect(location.origin).toBe("http://localhost");
      expect(location.pathname + location.search).toBe(target);
    }
    // From the last poll back, more than a page lies below: the page just
    // before it, the stub's lost poll dropping out, leading back again and on.
    const back = await follow(`/polls?before=${listed.at(-1)}`);
    expect(back.status).toBe(200);
    const html = await back.text();
    expect(linked(html)).toEqual(listed.slice(4, 24).filter((id) => id !== LOST_ID));
    expect(pages(html)).toContain(`href="/polls?before=${listed[4]}"`);
    expect(pages(html)).toContain(`href="/polls?after=${listed[23]}"`);
    expect(pages(html)).toMatch(/href="\/polls"[^>]*>.*First page<\/a>/);
    // Its form keeps the page it shows, never as `after`.
    expect(html).toContain(`name="before" value="${listed.at(-1)}"`);
    expect(html).not.toContain('name="after"');
    // `after` wins when a link carries both, and the address drops `before`.
    const both = await (await follow(`/polls?after=${listed[19]}&before=${listed[3]}`)).text();
    expect(linked(both)).toEqual(listed.slice(20));
    expect(both).not.toContain('name="before"');
    expect(pages(both)).not.toContain(`before=${listed[3]}`);
  });

  // P2-19 part 50: a page past the end leads back to the last page.
  test("leads from past the last poll back to the page ending on it", async () => {
    const last = listed.at(-1)!;
    const after = (BigInt(`0x${last}`) + 1n).toString(16).padStart(64, "0");
    const past = await (await get(`/polls?after=${last}&status=closed`)).text();
    expect(past).toContain("No more polls");
    expect(past).toMatch(
      new RegExp(`href="/polls\\?before=${after}&amp;status=closed"[^>]*>Previous page</a>`),
    );
    expect(past).toMatch(/href="\/polls\?status=closed"[^>]*>First page<\/a>/);
    // The page back holds the cursor's own poll, last, as the forward page before it did.
    const back = await follow(`/polls?before=${after}`);
    expect(back.status).toBe(200);
    expect(linked(await back.text())).toEqual(listed.slice(-20).filter((id) => id !== LOST_ID));
    // Past the largest ID nothing follows, so only the first page is offered.
    const top = await (await get(`/polls?after=${"f".repeat(64)}`)).text();
    expect(top).toContain("No more polls");
    expect(top).not.toContain("Previous page");
  });

  test("states the whole listing in numbers under its heading, as of the page's clock (P2-19 part 46)", async () => {
    const html = await (await get("/polls")).text();
    const tally =
      /<section aria-labelledby="register-counts"[^>]*><h2 id="register-counts"[^>]*>The list in numbers<\/h2><dl[^>]*>([\s\S]*?)<\/dl>/.exec(
        html,
      )?.[1];
    expect(tally).toBeDefined();
    const pairs = [...tally!.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)<\/dd>/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(pairs.slice(0, 3)).toEqual([
      ["Listed polls", "1,234"],
      ["Open now", "212"],
      ["Scheduled", "41"],
    ]);
    expect(pairs[3]![0]).toBe("As of");
    expect(pairs[3]![1]).toMatch(/\u00a0UTC$/);
    // Under the heading, before the lookup form.
    expect(html.indexOf("The list in numbers")).toBeGreaterThan(html.indexOf("<h1"));
    expect(html.indexOf("The list in numbers")).toBeLessThan(html.indexOf('name="id"'));
    // Asked for with nothing, as the contract's empty input takes it.
    const asked = seen.filter((r) => r.path === "/elections/counts");
    expect(asked.length).toBeGreaterThan(0);
    for (const r of asked) expect([...r.query]).toEqual([]);
    // The whole listing's, so read only where the register starts: a later
    // page or a search doesn't count every listed poll again (T-52).
    seen.length = 0;
    for (const path of [
      `/polls?after=${listed[19]}`,
      "/polls?q=bridge",
      "/polls?topic=housing",
      "/polls?place=Old+Town",
    ]) {
      const later = await (await get(path)).text();
      expect(later).toContain("<h1");
      expect(later).not.toContain("The list in numbers");
    }
    expect(seen.filter((r) => r.path === "/elections/counts")).toEqual([]);
  });

  test.each([
    ["a failed read", undefined],
    ["more open than listed", { ...LISTING_COUNTS, open: "1235" }],
    ["open and scheduled past the listed", { ...LISTING_COUNTS, scheduled: "1023" }],
    ["a count past a safe integer", { ...LISTING_COUNTS, listed: "9007199254740993" }],
  ])("leaves the counts out after %s, and keeps the list", async (_, counts) => {
    stub.listingCounts = counts;
    try {
      const response = await get("/polls");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("The list in numbers");
      expect(linked(html).length).toBeGreaterThan(0);
    } finally {
      stub.listingCounts = LISTING_COUNTS;
    }
  });

  test("suggests the listed polls' places in the place box wherever the register starts (P2-19 part 52)", async () => {
    const suggested = (html: string) => {
      const list = /<input[^>]*name="place"[^>]*>/.exec(html)?.[0].match(/list="([^"]+)"/)?.[1];
      if (list === undefined) return undefined;
      const datalist = new RegExp(`<datalist id="${list}">([\\s\\S]*?)</datalist>`).exec(html)?.[1];
      return [...(datalist ?? "").matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    };
    seen.length = 0;
    for (const path of ["/polls", "/polls?q=bridge", "/polls?topic=housing&place=Old+Town"]) {
      const html = await (await get(path)).text();
      expect(suggested(html), path).toEqual(LISTED_PLACES);
      expect(html).toContain("It suggests the places listed polls are filed at.");
    }
    // Asked for with nothing, as the contract's empty input takes it.
    const asked = seen.filter((r) => r.path === "/elections/places");
    expect(asked).toHaveLength(3);
    for (const r of asked) expect([...r.query]).toEqual([]);
    // A later page reads them again nowhere (T-52), and keeps a plain box.
    seen.length = 0;
    const later = await (await get(`/polls?after=${"0".repeat(64)}`)).text();
    expect(later).toContain('name="place"');
    expect(suggested(later)).toBeUndefined();
    expect(later).not.toContain("<datalist");
    expect(seen.filter((r) => r.path === "/elections/places")).toEqual([]);
  });

  test("keeps a plain place box, and the list, after the places fail to read", async () => {
    stub.listedPlaces = undefined;
    try {
      const response = await get("/polls");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("<datalist");
      expect(html).not.toContain("suggests the places");
      expect(linked(html).length).toBeGreaterThan(0);
    } finally {
      stub.listedPlaces = LISTED_PLACES;
    }
  });

  test("never lists a poll the API leaves out, such as a hidden one (T-68)", async () => {
    let html = await (await get("/polls")).text();
    let all = linked(html);
    const more = /href="\/polls\?after=([0-9a-f]{64})"/.exec(html)?.[1];
    html = await (await get(`/polls?after=${more}`)).text();
    all = [...all, ...linked(html)];
    expect(all).not.toContain(HIDDEN_ID);
  });

  test("flags a definition that names another election rather than showing it (T-34)", async () => {
    const html = await (await get(`/polls?after=${LOST_ID}`)).text();
    expect(html).toContain(`href="/polls/${SWAPPED_ID}"`);
    expect(html).toContain("sent another poll&#x27;s definition");
  });

  // P2-19 part 16: the register in polls' own words.
  test("names each poll in its own words where its definition commits to them, by its ID otherwise", async () => {
    const html = await (await get(`/polls?after=${LOST_ID}`)).text();
    // A version-5 poll by its title, a version-1 poll by its question, in
    // their language and direction, each with its ID under it.
    expect(html).toMatch(
      new RegExp(
        `<h3[^>]*lang="en" dir="auto"[^>]*><a[^>]*href="/polls/${STREAM_V5}">Park and library</a></h3>`,
      ),
    );
    expect(html).toMatch(
      new RegExp(
        `<h3[^>]*lang="en" dir="auto"[^>]*><a[^>]*href="/polls/${STREAM_V1}">Should the park stay open late\\?</a></h3>`,
      ),
    );
    expect(html).toContain(`>${STREAM_V5.slice(0, 16)}…</p>`);
    // Text the definition doesn't commit to, or none, gives no words (T-34, T-41).
    for (const id of [STREAM_BAD_TEXT, STREAM_NO_TEXT])
      expect(html).toMatch(new RegExp(`href="/polls/${id}">${id.slice(0, 16)}…</a>`));
    expect(html).not.toMatch(new RegExp(`href="/polls/${STREAM_BAD_TEXT}">[^<]*[^0-9a-f…<]`));
  });

  test("names each poll in the page's language", async () => {
    const html = await (
      await get(`/polls?after=${LOST_ID}`, { "accept-language": "es-MX" })
    ).text();
    expect(html).toMatch(
      new RegExp(
        `<h3[^>]*lang="es-419"[^>]*><a[^>]*href="/polls/${STREAM_V1}">¿Debe el parque abrir hasta tarde\\?</a>`,
      ),
    );
  });

  test("lists a refiling with its topic and what it did to the place", async () => {
    const html = await (await get("/moderation")).text();
    expect(html).toContain("Refiled");
    expect(html).toContain("Misfiled");
    expect(html).toContain("Topic now Transport · No place");
  });

  test.each(["?after=abc", `?after=${ID.toUpperCase()}`, `?after=${ID}&after=${ID}`])(
    "%s starts from the beginning, quoting no error",
    async (search) => {
      const response = await follow(`/polls${search}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(linked(html)).toEqual(listed.slice(0, 19));
      expect(html).not.toMatch(/new Error|expected an election ID/);
    },
  );

  test("filters the page in hand by status and counting rule, with no script", async () => {
    // Every stub poll closed on 8 January 2026, so none is open.
    let response = await get("/polls?status=open");
    expect(response.status).toBe(200);
    let html = await response.text();
    expect(linked(html)).toEqual([]);
    expect(html).toContain("No polls on this page match");
    expect(html).toContain("0 of 19 polls on this page match.");
    expect(html).toMatch(/<input type="radio" [^>]*name="status" checked="" value="open"/);
    // What the form sends, a group at All included, renders as sent, and the next page keeps it.
    response = await get("/polls?status=closed&counting=plurality");
    expect(response.status).toBe(200);
    html = await response.text();
    expect(linked(html)).toEqual(listed.slice(0, 19));
    expect(html).toContain("19 of 19 polls on this page match.");
    expect(html).toContain(
      `href="/polls?after=${listed[19]}&amp;status=closed&amp;counting=plurality"`,
    );
    expect(html).toMatch(/href="\/polls">Clear filters<\/a>/);
    response = await get("/polls?status=all&counting=approval");
    expect(response.status).toBe(200);
    expect(linked(await response.text())).toEqual([]);
    // A definition that names another election never matches a filter (T-34).
    html = await (await get(`/polls?after=${LOST_ID}&status=closed`)).text();
    expect(linked(html)).not.toContain(SWAPPED_ID);
    expect(html).toContain(`<input type="hidden" name="after" value="${LOST_ID}"/>`);
    html = await (await get(`/polls?after=${LOST_ID}`)).text();
    expect(linked(html)).toContain(SWAPPED_ID);
  });

  // P2-19 part 56: the class each poll's definition states, as a filter over the page in hand.
  test("names each row's class and filters the page in hand by it, with no script", async () => {
    let html = await (await get("/polls")).text();
    expect(html).toContain(">Kind and counting<");
    expect(html.replace(/<[^>]+>/g, "")).toContain("Everyday pollOne choice");
    // Versions 1 and 5 are everyday polls, so every stub poll is one.
    expect(html).toMatch(/<input type="radio" [^>]*name="kind" checked="" value="all"/);
    html = await (await get("/polls?kind=everyday&status=closed")).text();
    expect(linked(html)).toEqual(listed.slice(0, 19));
    expect(html).toMatch(/<input type="radio" [^>]*name="kind" checked="" value="everyday"/);
    expect(html).toContain(`href="/polls?after=${listed[19]}&amp;status=closed&amp;kind=everyday"`);
    // The search form keeps the filter, as it keeps the others.
    expect(html).toContain('<input type="hidden" name="kind" value="everyday"/>');
    for (const kind of ["civic", "organisational"]) {
      html = await (await get(`/polls?kind=${kind}`)).text();
      expect(linked(html)).toEqual([]);
      expect(html).toContain("0 of 19 polls on this page match.");
    }
  });

  test.each([
    "?status=bogus",
    "?status=open&status=closed",
    "?counting=ranked",
    "?kind=referendum",
  ])("%s is no filter, quoting nothing", async (search) => {
    const response = await follow(`/polls${search}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(linked(html)).toEqual(listed.slice(0, 19));
    expect(html).not.toContain("bogus");
    expect(html).not.toContain("ranked");
    expect(html).not.toContain("kind=referendum");
  });

  test("a filter asks the API for the same page as no filter", async () => {
    seen.length = 0;
    await get("/polls?status=open&counting=approval");
    expect(seen.filter((r) => r.path === "/elections")).toHaveLength(1);
    expect(seen.filter((r) => r.path === "/elections/definition")).toHaveLength(20);
    expect(seen.filter((r) => r.path === "/elections/display-text")).toHaveLength(20);
    expect(seen.filter((r) => r.path === "/elections/tags")).toHaveLength(20);
    // Every row's count from one read naming the page's polls (P2-19 part 59, T-52).
    const answered = seen.filter((r) => r.path === "/elections/answered");
    expect(answered.map((r) => r.method)).toEqual(["POST"]);
    const { electionIds } = answered[0]!.body as { electionIds: string[] };
    const read = seen.filter((r) => r.path === "/elections/definition");
    expect(electionIds).toHaveLength(read.length);
    expect(new Set(electionIds)).toEqual(new Set(read.map((r) => r.query.get("electionId"))));
  });

  // P2-19 part 17: how many have answered each poll on the register.
  test("says how many have answered each poll so far, tier by tier, or nothing when the read fails", async () => {
    const html = await (await get(`/polls?after=${LOST_ID}`)).text();
    const row = (id: string) =>
      (html.split(/<article\b/).find((part) => part.includes(`href="/polls/${id}"`)) ?? "").replace(
        /<[^>]+>/g,
        "|",
      );
    // Each tier the definition names on its own line, one with none served
    // at 0; the API's count for a tier it doesn't name is left out (T-01).
    expect(row(STREAM_V5)).toMatch(
      /Answered so far\|+1,204 people\|+Tier 0 \(verified e-mail\)\|+0 people\|+Tier 2 \(document-verified\)\|/,
    );
    expect(row(STREAM_V5)).not.toContain("Tier 1");
    expect(row(STREAM_V5)).not.toMatch(/\b7 people/);
    // A failed read shows no count, and the row stays.
    expect(row(STREAM_V1)).toContain("Should the park stay open late?");
    expect(row(STREAM_V1)).not.toContain("Answered so far");
    // A definition that names another election shows nothing from it, no count included (T-34).
    expect(row(SWAPPED_ID)).not.toContain("Answered so far");
  });

  // P2-19 part 59: every row's count from one read.
  test("shows no row's count when the one read of them fails, and keeps every row", async () => {
    stub.answeredManyFails = true;
    try {
      const html = await (await get(`/polls?after=${LOST_ID}`)).text();
      const rows = html.split(/<article\b/).slice(1);
      expect(rows.some((row) => row.includes(`href="/polls/${STREAM_V5}"`))).toBe(true);
      expect(html).toContain("Should the park stay open late?");
      // The column's heading stays; no row says a count.
      expect(rows.filter((row) => /\d people/.test(row.replace(/<[^>]+>/g, "|")))).toEqual([]);
    } finally {
      stub.answeredManyFails = false;
    }
  });

  // P2-19 part 19: where each poll on the register is listed.
  test("shows where each poll is listed, each tag a link into the stream, and no place a draft couldn't hold", async () => {
    /** The tags' links in each row of `html` that has any, by the row's poll. */
    const tagsOf = (html: string) =>
      Object.fromEntries(
        html
          .split(/<article\b/)
          .slice(1)
          .flatMap((row) => {
            const id = /href="\/polls\/([0-9a-f]{64})"/.exec(row)?.[1];
            const list = /<ul aria-label="Where it&#x27;s listed"[^>]*>([\s\S]*?)<\/ul>/.exec(row);
            if (id === undefined || list === null) return [];
            return [[id, [...(list[1] ?? "").matchAll(/href="([^"]*)"/g)].map((h) => h[1])]];
          }),
      );
    const second = await (await get(`/polls?after=${LOST_ID}`)).text();
    // The version-5 poll's topic and place, the version-1 poll's topic alone,
    // and nothing on a row the API files under neither.
    expect(tagsOf(second)).toEqual({
      [STREAM_V5]: ["/discover?topic=community", "/discover?place=Riverside%20Park"],
      [STREAM_V1]: ["/discover?topic=transport"],
    });
    expect(second).toContain("<bdi>Riverside Park</bdi>");
    // A place with a bidi override, which no draft could hold, isn't shown;
    // its topic still is (T-67, T-68).
    const first = await (await get("/polls")).text();
    expect(tagsOf(first)).toEqual({
      [ID]: ["/discover?topic=housing", "/discover?place=Old%20Town"],
      [OVERRIDE_ID]: ["/discover?topic=food"],
    });
    expect(first).not.toContain("\u202e");
  });

  // P2-19 part 20: a closed poll counted, on the register.
  test("says a closed poll is counted only once every tier's results are read, linking to them", async () => {
    /** Each row of `html` that says it is counted, by its poll, and the results it links to. */
    const countedOf = (html: string) =>
      html
        .split(/<article\b/)
        .slice(1)
        .filter((row) => row.includes("· <!-- -->counted") || row.includes("· counted"))
        .map((row) => [
          /href="\/polls\/([0-9a-f]{64})"/.exec(row)?.[1],
          /href="([^"]*)">See the results</.exec(row)?.[1],
        ]);
    // Of the first page, only the poll counted in both its tiers: unopened,
    // not counted here, not ready, failing, and results that don't fit the
    // definition or leave a tier unopened all say nothing (T-34, T-52).
    expect(countedOf(await (await get("/polls")).text())).toEqual([
      [COUNTED_ID, `/polls/${COUNTED_ID}/results`],
    ]);
    seen.length = 0;
    const second = await (await get(`/polls?after=${LOST_ID}`)).text();
    // The version-5 poll's results name only Tier 0 of its two tiers, and the
    // version-1 poll's Tier 2 is still partly unopened, so neither is counted.
    expect(countedOf(second)).toEqual([]);
    // Only polls whose definitions the page reads are asked about, the
    // swapped one not among them.
    const asked = seen
      .filter((r) => r.path === "/elections/results")
      .map((r) => r.query.get("electionId"));
    expect(asked).toContain(STREAM_V5);
    expect(asked).not.toContain(SWAPPED_ID);
  });

  // P2-19 part 18: searching the register by the polls' words.
  test("searches every listed poll by its words, keeping the search on every form and link", async () => {
    seen.length = 0;
    let html = await (await get("/polls?q=%20PaRK%20")).text();
    expect(seen.find((r) => r.path === "/elections")?.query.get("q")).toBe("PaRK");
    expect(linked(html)).toEqual(listed.filter((id) => id === STREAM_V5 || id === STREAM_V1));
    expect(html).toContain("hold every word you searched for");
    // The box holds what was typed; the page's own words never quote it.
    expect(html).toMatch(/<input[^>]*type="search"[^>]*name="q"[^>]*value=" PaRK "/);
    expect(html.replace(/<script\b[\s\S]*?<\/script>/g, "")).not.toMatch(/>[^<]*PaRK/);
    expect(html).toContain('<input type="hidden" name="q" value="PaRK"/>');
    expect(html).toContain('href="/polls">Clear the search');
    // The filters still apply to the page in hand, and the search form keeps them.
    html = await (await get("/polls?q=library&status=closed")).text();
    expect(linked(html)).toEqual([STREAM_V5]);
    expect(html).toMatch(
      /<form role="search"[^>]*>(?:(?!<\/form>)[\s\S])*name="status" value="closed"/,
    );
    expect(html).toContain('href="/polls?q=library">Clear filters');
    expect(html).toContain('href="/polls?status=closed">Clear the search');
    // A blank search is no search.
    html = await (await get("/polls?q=%20%20")).text();
    expect(linked(html)).toEqual(listed.slice(0, 19));
    expect(html).not.toContain("Clear the search");
  });

  test("says when a search finds nothing, or can't be run, asking nothing of one the contract refuses", async () => {
    let html = await (await get("/polls?q=ferries")).text();
    expect(linked(html)).toEqual([]);
    expect(html).toContain("No listed poll matches");
    expect(html).not.toContain("No polls listed.");
    for (const q of [Array.from({ length: 9 }, (_, i) => `w${i}`).join("+"), "a".repeat(201)]) {
      seen.length = 0;
      const response = await get(`/polls?q=${q}`);
      expect(response.status).toBe(200);
      html = await response.text();
      expect(html).toContain("That search can&#x27;t be run");
      expect(linked(html)).toEqual([]);
      expect(seen).toEqual([]);
    }
    // Control characters alone pass the contract's pattern, and the API refuses them.
    html = await (await get("/polls?q=%C2%85")).text();
    expect(html).toContain("That search can&#x27;t be run");
    expect(html).not.toContain("BAD_REQUEST");
  });

  // P2-19 part 48: narrowing the register to a topic and a place.
  test("narrows every listed poll to a topic and a place, never quoting the place", async () => {
    seen.length = 0;
    let html = await (await get("/polls?topic=housing&place=%20old%20%20TOWN%20")).text();
    const asked = seen.find((r) => r.path === "/elections");
    expect(asked?.query.get("topic")).toBe("housing");
    // Single-spaced and trimmed, as the stream sends a place.
    expect(asked?.query.get("place")).toBe("old TOWN");
    expect(linked(html)).toEqual([ID]);
    expect(html).toContain("Only the polls filed under Housing.");
    expect(html).toContain("Only the polls filed at the place you gave.");
    expect(html).toMatch(/<option[^>]*value="housing"[^>]*selected=""/);
    expect(html).toMatch(/<input[^>]*name="place"[^>]*value=" old {2}TOWN "/);
    expect(html.replace(/<script\b[\s\S]*?<\/script>/g, "")).not.toMatch(/>[^<]*old {1,2}TOWN/);
    expect(html).toContain('<input type="hidden" name="place" value="old TOWN"/>');
    expect(html).toContain('href="/polls">Clear the search');
    // A topic not on the list is no topic; the form's blank fields are no filter.
    const unlisted = await get("/polls?topic=gossip&q=&place=");
    expect(unlisted.headers.get("location")).toBe("/polls?q=&place=");
    html = await (await get("/polls?q=&place=")).text();
    expect(linked(html)).toEqual(listed.slice(0, 19));
    expect(html).not.toContain("Only the polls filed");
    expect(html).not.toContain("Clear the search");
    // Nothing filed there says so, in words that are true of a filing.
    html = await (await get("/polls?topic=sport")).text();
    expect(linked(html)).toEqual([]);
    expect(html).toContain("No listed poll matches");
    expect(html).toContain("only where its asker, or moderation, filed it");
    // A place the contract refuses is refused here, without a request.
    seen.length = 0;
    const response = await get(`/polls?place=${"x".repeat(81)}`);
    expect(response.status).toBe(200);
    html = await response.text();
    expect(html).toContain("That place can&#x27;t be looked up");
    expect(seen).toEqual([]);
  });

  test("asks the API for nothing of the visitor's (T-10)", async () => {
    seen.length = 0;
    await get("/polls", { cookie: "session=secret", "x-forwarded-for": "203.0.113.9" });
    expect(seen.map((r) => r.path).filter((p) => p === "/elections")).toHaveLength(1);
    for (const { headers } of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain("203.0.113.9");
    }
  });
});

describe("stream", () => {
  /** The polls a page of the stream shows, in order, by the links of their cards' headings. */
  const cards = (html: string) =>
    [...html.matchAll(/<h3\b[^>]*><a[^>]*href="\/polls\/([0-9a-f]{64})"/g)].map((m) => m[1]);

  test("shows each open poll's checked words, answerable in the ballot client", async () => {
    const response = await get("/discover");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("What people are asking");
    expect(cards(html)).toEqual(streamed.slice(0, 10));
    // A version-5 poll's title, a version-1 poll's question, each in its own language.
    expect(html).toMatch(
      /<h3[^>]*lang="en"[^>]*><a href="\/polls\/c1c1[0-9a-f]{60}"[^>]*>Park and library</,
    );
    expect(html).toContain(">Should the park stay open late?<");
    // Each card's first question's answers, each a link with its pick in the fragment.
    for (const id of [STREAM_V5, STREAM_V1])
      expect(
        [
          ...html.matchAll(new RegExp(`href="${BALLOT}#election=${id}&amp;pick=([0-9]+)"`, "g")),
        ].map((m) => m[1]),
      ).toEqual(["0", "1", "2"]);
    expect(html).toContain("These answers are for question 1\u00a0of\u00a02.");
    expect(html).toContain("Choose an answer on any card to open it in the ballot app.");
    expect(html).not.toContain(`#election=${STREAM_V5}"`);
    // Text the definition doesn't commit to, or none, gets no words and no way to answer (T-41).
    expect(html).not.toContain(`#election=${STREAM_BAD_TEXT}`);
    expect(html).not.toContain(`#election=${STREAM_NO_TEXT}`);
    expect(html.match(/can&#x27;t be shown here/g)).toHaveLength(8);
    // The order is marked, and the next page keeps it.
    expect(html).toMatch(/<a href="\/discover" aria-current="page"[^>]*>New</);
    expect(html).toContain(`href="/discover?after=${streamed[9]}"`);
    expect(html).not.toContain("These come after the first page.");
    // The server doesn't know the visitor's zone, so each card's closing time
    // is served in UTC; the browser redraws it on the visitor's own clock
    // (P2-29, the stream's iteration 22).
    expect(html).toMatch(
      /Closes(?:<!-- -->)? <time datetime="[^"]+Z"[^>]*>[^<]*\u00a0UTC<\/time>/i,
    );
  });

  test("shows where each card's poll is listed, each tag a link into the stream", async () => {
    const html = await (await get("/discover")).text();
    const listed = [
      ...html.matchAll(/<ul aria-label="Where it&#x27;s listed"[^>]*>([\s\S]*?)<\/ul>/g),
    ].map((m) => [...(m[1] ?? "").matchAll(/href="([^"]*)"/g)].map((h) => h[1]));
    // In stream order: the version-5 poll's topic and place, the version-1
    // poll's topic alone, and nothing on a card with no words or no tags.
    expect(listed).toEqual([
      ["/discover?topic=community", "/discover?place=Riverside%20Park"],
      ["/discover?topic=transport"],
    ]);
    expect(html).toContain("<bdi>Riverside Park</bdi>");
    // The card's place link finds the poll, as the API keys it.
    const place = await (await get("/discover?place=Riverside%20Park")).text();
    expect(cards(place)).toEqual([STREAM_V5]);
  });

  test("pages and orders as the API does, never with an endless scroll", async () => {
    const second = await (await get(`/discover?after=${streamed[9]}`)).text();
    expect(cards(second)).toEqual(streamed.slice(10, 20));
    // A later page marks its order as chosen, not as this page: the link
    // leads back to the first (P2-29, the stream's iteration 20).
    expect(second).toMatch(/<a href="\/discover" aria-current="true"[^>]*>New</);
    expect(second).toMatch(/<a href="\/discover" aria-current="true"[^>]*>All topics</);
    // And says it is a later page, with a way back to the first (the
    // stream's iteration 21); the first page says neither.
    expect(second).toContain("These come after the first page.");
    expect(second).toMatch(/<a [^>]*href="\/discover">Start from the top</);
    const third = await (await get(`/discover?after=${streamed[19]}`)).text();
    expect(cards(third)).toEqual(streamed.slice(20));
    expect(third).not.toContain("More questions");
    // A full last page leads to one holding nothing, which says the earlier
    // pages held them all and leads back to the first, never that nothing
    // is open (P2-29, the stream's iteration 19).
    const past = await (await get(`/discover?sort=closing&after=${streamed[0]}`)).text();
    expect(cards(past)).toEqual([]);
    expect(past).toContain("That was the last of them");
    expect(past).toContain('href="/discover?sort=closing">Start from the top');
    expect(past).not.toContain("No open questions just now");
    const closing = await (await get("/discover?sort=closing")).text();
    expect(cards(closing)).toEqual(streamed.toReversed().slice(0, 10));
    expect(closing).toMatch(/<a href="\/discover\?sort=closing" aria-current="page"/);
    expect(closing).toContain(
      `href="/discover?sort=closing&amp;after=${streamed.toReversed()[9]}"`,
    );
  });

  test("says when an order is unavailable, or a page can't be placed, quoting nothing", async () => {
    let response = await get("/discover?sort=answered");
    expect(response.status).toBe(200);
    let html = await response.text();
    expect(html).toContain("This order isn&#x27;t available just now");
    expect(cards(html)).toEqual([]);
    response = await get(`/discover?sort=closing&after=${UNKNOWN_ID}`);
    expect(response.status).toBe(200);
    html = await response.text();
    expect(html).toContain("That page has moved on");
    expect(html).toContain('href="/discover?sort=closing">Start from the top');
    expect(html).not.toContain("CURSOR_NOT_FOUND");
  });

  test.each(["?sort=bogus", "?sort=id", "?after=abc", "?sort=new&sort=closing"])(
    "%s is the first page of the newest, quoting nothing",
    async (search) => {
      const response = await follow(`/discover${search}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(cards(html)).toEqual(streamed.slice(0, 10));
      expect(html).not.toContain("bogus");
    },
  );

  test("searches within the order, keeping the search on every link", async () => {
    let html = await (await get("/discover?q=%20PaRK%20")).text();
    expect(cards(html)).toEqual([STREAM_V5, STREAM_V1]);
    expect(html).toContain("with all your words");
    // The box holds what was typed; the page's own words never quote it.
    expect(html).toMatch(/<input[^>]*type="search"[^>]*name="q"[^>]*value=" PaRK "/);
    expect(html.replace(/<script\b[\s\S]*?<\/script>/g, "")).not.toMatch(/>[^<]*PaRK/);
    expect(html).toContain('href="/discover?sort=closing&amp;q=PaRK"');
    expect(html).toContain('href="/discover">Clear the search');
    html = await (await get("/discover?sort=closing&q=park")).text();
    expect(cards(html)).toEqual([STREAM_V1, STREAM_V5]);
    expect(html).toMatch(/<input type="hidden" name="sort" value="closing"/);
    html = await (await get("/discover?q=library")).text();
    expect(cards(html)).toEqual([STREAM_V5]);
    // Spaces in either spelling, and a blank search is no search.
    for (const search of ["?q=park+library", "?q=park%20library"]) {
      seen.length = 0;
      await get(`/discover${search}`);
      expect(seen.find((r) => r.path === "/elections")?.query.get("q")).toBe("park library");
    }
    html = await (await get("/discover?q=%20%20")).text();
    expect(cards(html)).toEqual(streamed.slice(0, 10));
    expect(html).not.toContain("Clear the search");
  });

  test("says when a search finds nothing, or can't be run, asking nothing of one the contract refuses", async () => {
    let html = await (await get("/discover?q=ferries")).text();
    expect(cards(html)).toEqual([]);
    expect(html).toContain("No open question matches");
    expect(html).not.toContain("No open questions just now");
    for (const q of [Array.from({ length: 9 }, (_, i) => `w${i}`).join("+"), "a".repeat(201)]) {
      seen.length = 0;
      const response = await get(`/discover?q=${q}`);
      expect(response.status).toBe(200);
      html = await response.text();
      expect(html).toContain("That search can&#x27;t be run");
      expect(cards(html)).toEqual([]);
      expect(seen).toEqual([]);
    }
    // Control characters alone pass the contract's pattern, and the API refuses them.
    html = await (await get("/discover?q=%C2%85")).text();
    expect(html).toContain("That search can&#x27;t be run");
    expect(html).not.toContain("BAD_REQUEST");
  });

  test("a topic's page lists the polls filed under it, titled with the topic, every link keeping it", async () => {
    let html = await (await get("/discover?topic=community")).text();
    expect(cards(html)).toEqual([STREAM_V5, STREAM_V1]);
    expect(html).toMatch(/<h1[^>]*>Community</);
    expect(html).toMatch(
      /<a href="\/discover\?topic=community" aria-current="page"[^>]*>Community</,
    );
    expect(html).toMatch(/<a href="\/discover"[^>]*>All topics</);
    // Only the orders' "New" and the topics' own list link the page's topic:
    // no card repeats it.
    expect(html.split('href="/discover?topic=community"')).toHaveLength(3);
    expect(html).toContain('href="/discover?sort=closing&amp;topic=community"');
    expect(html).toMatch(/<input type="hidden" name="topic" value="community"/);
    html = await (await get("/discover?sort=closing&topic=transport&q=park")).text();
    expect(cards(html)).toEqual([STREAM_V1]);
    expect(html).toContain('href="/discover?sort=closing&amp;topic=transport">Clear the search');
    expect(html).toContain('href="/discover?sort=closing&amp;topic=community&amp;q=park"');
    // A topic not on the list is no topic, quoting nothing.
    const response = await follow("/discover?topic=bogus");
    html = await response.text();
    expect(cards(html)).toEqual(streamed.slice(0, 10));
    expect(html).not.toContain("bogus");
  });

  test("filters by place as the API keys it, never quoting the place but in its box", async () => {
    seen.length = 0;
    let html = await (await get("/discover?place=%20RIVERSIDE%20%20park")).text();
    expect(seen.find((r) => r.path === "/elections")?.query.get("place")).toBe("RIVERSIDE park");
    expect(cards(html)).toEqual([STREAM_V5]);
    expect(html).toMatch(/<input[^>]*name="place"[^>]*value=" RIVERSIDE  park"/);
    expect(html.replace(/<script\b[\s\S]*?<\/script>/g, "")).not.toMatch(/>[^<]*RIVERSIDE/);
    expect(html).toContain("filed at this place");
    expect(html).toContain('href="/discover">Clear the place');
    expect(html).toContain('href="/discover?sort=closing&amp;place=RIVERSIDE%20park"');
    // Filed under a topic and at a place that share nothing.
    html = await (await get("/discover?topic=transport&place=riverside+park")).text();
    expect(cards(html)).toEqual([]);
    expect(html).toContain("No open question is filed here");
    expect(html).toContain("under this topic and at this place");
    expect(html).not.toContain("Show everything");
    expect(html).toContain('href="/discover?topic=transport">Clear the place');
    // A blank place is no place.
    html = await (await get("/discover?place=%20")).text();
    expect(cards(html)).toEqual(streamed.slice(0, 10));
    expect(html).not.toContain("Clear the place");
  });

  test("refuses a place the API wouldn't take, without asking it", async () => {
    for (const place of ["a".repeat(81), "%C2%85", "%01%20%C2%85"]) {
      seen.length = 0;
      const response = await get(`/discover?q=park&place=${place}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("That place can&#x27;t be looked up");
      expect(html).toContain('href="/discover?q=park">Clear the place');
      expect(cards(html)).toEqual([]);
      expect(seen).toEqual([]);
    }
  });

  test("suggests the listed polls' places in the place box wherever the stream starts (P2-23 part 3b)", async () => {
    const suggested = (html: string) => {
      // The place box, not the search form's hidden field keeping the place.
      const box = [...html.matchAll(/<input[^>]*name="place"[^>]*>/g)].find(
        ([input]) => !input.includes('type="hidden"'),
      );
      const list = box?.[0].match(/list="([^"]+)"/)?.[1];
      if (list === undefined) return undefined;
      const datalist = new RegExp(`<datalist id="${list}">([\\s\\S]*?)</datalist>`).exec(html)?.[1];
      return [...(datalist ?? "").matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    };
    seen.length = 0;
    // The folded box, the box beside the search on a place's page, and a
    // search under another order.
    for (const path of [
      "/discover",
      "/discover?place=Riverside%20Park",
      "/discover?sort=closing&q=park",
    ]) {
      const html = await (await get(path)).text();
      expect(suggested(html), path).toEqual(LISTED_PLACES);
      expect(html.match(/<datalist\b/g), path).toHaveLength(1);
      // Offered only as the browser's suggestions, never in the page's words (T-67).
      expect(html.replace(/<script\b[\s\S]*?<\/script>/g, ""), path).not.toMatch(
        />[^<]*Riverside</,
      );
    }
    // The hint says so where it shows: under the folded box, not where the
    // place narrows the page and its note takes the hint's place.
    expect(await (await get("/discover")).text()).toContain(
      "but the whole name must match. It suggests the places listed polls are filed at.",
    );
    // Asked for with nothing, as the contract's empty input takes it.
    const asked = seen.filter((r) => r.path === "/elections/places");
    expect(asked).toHaveLength(4);
    for (const r of asked) expect([...r.query]).toEqual([]);
    // A later page reads them nowhere (T-52), and keeps a plain box; nor
    // does the home page, which has no place box.
    seen.length = 0;
    const later = await (await get(`/discover?after=${streamed[9]}`)).text();
    expect(later).toContain('name="place"');
    expect(suggested(later)).toBeUndefined();
    expect(later).not.toContain("<datalist");
    await get("/");
    expect(seen.filter((r) => r.path === "/elections/places")).toEqual([]);
  });

  test("keeps a plain place box, and the stream, after the places fail to read", async () => {
    stub.listedPlaces = undefined;
    try {
      const response = await get("/discover");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('name="place"');
      expect(html).not.toContain("<datalist");
      expect(html).not.toContain("suggests the places");
      expect(cards(html)).toEqual(streamed.slice(0, 10));
    } finally {
      stub.listedPlaces = LISTED_PLACES;
    }
  });

  test("offers no suggestions on a refused place's page, which asks the API nothing", async () => {
    seen.length = 0;
    const html = await (await get(`/discover?place=${"a".repeat(81)}`)).text();
    expect(html).not.toContain("<datalist");
    expect(seen).toEqual([]);
  });

  test("says how many have answered each card's poll so far, tier by tier, or that it couldn't when the read fails", async () => {
    const html = await (await get("/discover?topic=community")).text();
    expect(cards(html)).toEqual([STREAM_V5, STREAM_V1]);
    const [v5, v1] = html.split(/<article\b/).slice(1);
    const text = (part: string | undefined) => (part ?? "").replace(/<[^>]+>/g, "|");
    // Each tier the definition names on its own line, one with none served
    // at 0; the API's count for a tier it doesn't name is left out (T-01).
    expect(text(v5)).toMatch(
      /Answered so far\|+1,204 people with a verified e-mail\|+0 people verified with a passport or ID\|/,
    );
    // Each tier in words, never as a code (P2-29, the stream's iteration 9).
    expect(text(v5)).not.toMatch(/Tier \d/);
    expect(text(v5)).not.toContain("vouched");
    expect(text(v5)).not.toMatch(/\b7 people/);
    // A failed read shows no count, but says so in the band, and the card
    // stays (P2-29, the stream's iteration 31).
    expect(text(v1)).not.toContain("Answered so far");
    expect(text(v1)).toContain("We couldn&#x27;t get how many have answered just now.");
  });

  // P2-19 part 59: every card's count from one read.
  test("says it couldn't get any card's count when the one read of them fails, and keeps every card", async () => {
    stub.answeredManyFails = true;
    try {
      const html = await (await get("/discover?topic=community")).text();
      expect(cards(html)).toEqual([STREAM_V5, STREAM_V1]);
      expect(html).not.toContain("Answered so far");
      expect(html.match(/We couldn&#x27;t get how many have answered just now\./g)).toHaveLength(2);
    } finally {
      stub.answeredManyFails = false;
    }
  });

  test("asks the API for one page, and nothing of the visitor's (T-10)", async () => {
    seen.length = 0;
    await get("/discover", { cookie: "session=secret", "x-forwarded-for": "203.0.113.9" });
    expect(seen.filter((r) => r.path === "/elections")).toHaveLength(1);
    expect(seen.filter((r) => r.path === "/elections/definition")).toHaveLength(10);
    expect(seen.filter((r) => r.path === "/elections/display-text")).toHaveLength(10);
    expect(seen.filter((r) => r.path === "/elections/tags")).toHaveLength(10);
    // Every card's count from one read naming the page's polls (P2-19 part 59, T-52).
    const answered = seen.filter((r) => r.path === "/elections/answered");
    expect(answered.map((r) => r.method)).toEqual(["POST"]);
    const { electionIds } = answered[0]!.body as { electionIds: string[] };
    const read = seen.filter((r) => r.path === "/elections/definition");
    expect(electionIds).toHaveLength(read.length);
    expect(new Set(electionIds)).toEqual(new Set(read.map((r) => r.query.get("electionId"))));
    expect(seen.filter((r) => r.path === "/elections/places")).toHaveLength(1);
    for (const { headers } of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain("203.0.113.9");
    }
  });
});

describe("profile page", () => {
  /** The polls a page shows, in order, by the links of their cards' headings. */
  const cards = (html: string) =>
    [...html.matchAll(/<h3\b[^>]*><a[^>]*href="\/polls\/([0-9a-f]{64})"/g)].map((m) => m[1]);
  const text = (html: string) => html.replace(/<[^>]+>/g, "");

  test("shows the name isolated and its polls as the stream's cards, kept out of search engines", async () => {
    const response = await get(`/by/${PROFILE_HANDLE}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // The name in its own isolate, so a right-to-left name can't reorder the page (T-75).
    expect(html).toMatch(new RegExp(`<h1[^>]*><bdi>${PROFILE_NAME}</bdi></h1>`));
    expect(html).toContain('<meta name="robots" content="noindex"');
    // What the page is: a name nobody checked, and the website's word.
    expect(text(html)).toContain("names aren&#x27;t checked and needn&#x27;t be unique");
    expect(text(html)).toContain("It isn&#x27;t part of any poll");
    // Its first ten listed polls, the one the API no longer serves dropped,
    // each card checked and answerable as in the stream.
    expect(cards(html)).toEqual(streamed.slice(0, 9));
    expect(html).toContain(`href="${BALLOT}#election=${STREAM_V5}&amp;pick=0"`);
    expect(html).not.toContain(`#election=${STREAM_BAD_TEXT}`);
    expect(html).toContain(`href="/by/${PROFILE_HANDLE}?after=${streamed[8]}"`);
    expect(html).not.toContain(">Start from the top<");
    // Reporting needs the page's script, and offers the policy's grounds once opened.
    expect(html).toContain(">Report this profile<");
    expect(html).toContain('href="/moderation"');
  });

  test("pages through the polls it shows, a page of ten at a time", async () => {
    const second = await (await get(`/by/${PROFILE_HANDLE}?after=${streamed[8]}`)).text();
    expect(cards(second)).toEqual(streamed.slice(9, 19));
    expect(second).toContain(`href="/by/${PROFILE_HANDLE}"`);
    expect(second).toContain(">Start from the top<");
    const last = streamed.at(-1);
    const end = await (await get(`/by/${PROFILE_HANDLE}?after=${streamed.at(-2)}`)).text();
    expect(cards(end)).toEqual([last]);
    expect(end).not.toContain(`?after=`);
  });

  test.each([`?after=${"0".repeat(64)}`, "?after=abc", "?after=1&after=2"])(
    "%s starts from the top",
    async (search) => {
      const response = await follow(`/by/${PROFILE_HANDLE}${search}`);
      expect(response.status).toBe(200);
      expect(cards(await response.text())).toEqual(streamed.slice(0, 9));
    },
  );

  test("a hidden profile shows the ground alone: no name and no polls (T-68)", async () => {
    const response = await get(`/by/${HIDDEN_HANDLE}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("This profile is hidden");
    expect(text(html)).toContain("for Harassment.");
    expect(cards(html)).toEqual([]);
    expect(html).not.toContain("Report this profile");
    expect(html).toContain('<meta name="robots" content="noindex"');
  });

  test("a profile showing no polls says so", async () => {
    const html = await (await get(`/by/${EMPTY_HANDLE}`)).text();
    expect(html).toContain("<bdi>Nobody yet</bdi>");
    expect(html).toContain("No polls to show");
    expect(cards(html)).toEqual([]);
  });

  test("an unknown handle is not found, and a malformed one is never read", async () => {
    profileReads.length = 0;
    expect((await get(`/by/${"z".repeat(16)}`)).status).toBe(404);
    expect(profileReads).toEqual(["z".repeat(16)]);
    profileReads.length = 0;
    for (const handle of [
      "K7QA2MZR5XW3BN4D",
      "k7qa2mzr5xw3bn4",
      "k7qa2mzr5xw3bn4d0",
      "k7qa2mzr5xw3bn41",
    ])
      expect((await get(`/by/${handle}`)).status).toBe(404);
    expect(profileReads).toEqual([]);
  });

  test("reads the profile by its handle alone, and asks the API nothing of the visitor's (T-10)", async () => {
    profileReads.length = 0;
    seen.length = 0;
    await get(`/by/${PROFILE_HANDLE}`, {
      cookie: "session=secret",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(profileReads).toEqual([PROFILE_HANDLE]);
    expect(seen.filter((r) => r.path === "/elections/definition")).toHaveLength(10);
    for (const { headers } of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain("203.0.113.9");
    }
  });
});

describe("moderation log", () => {
  test("lists decisions with their reasons, linking each poll", async () => {
    const html = await (await get("/moderation")).text();
    expect(html).toContain("Text hidden");
    expect(html).toContain("Personal data");
    expect(html).toContain(`href="/polls/${HIDDEN_ID}"`);
  });

  test("ends on how to report and appeal, leading to the register (T-10, T-68)", async () => {
    seen.length = 0;
    const html = await (await get("/moderation")).text();
    expect(html).toContain("See a poll that breaks these rules?");
    expect(html).toContain("Reports are counted, never who sent them");
    expect(html).toContain("A moderator other than the one who decided reviews it.");
    expect(html).toMatch(/href="\/polls"[^>]*>Find the poll in the register</);
    // The section is words and a link: the page sends nothing and asks the API nothing more.
    expect(html).not.toContain("/moderation/reports");
    expect(seen.map((r) => r.path).sort()).toEqual(["/moderation/log", "/moderation/log/counts"]);
  });

  test("lists a decision about a profile by its handle, linking its page", async () => {
    const html = await (await get("/moderation")).text();
    expect(html).toContain("Profile hidden");
    expect(html).toMatch(new RegExp(`href="/by/${PROFILE_HANDLE}"[^>]*>${PROFILE_HANDLE}<`));
  });

  test("starts from the latest decision, newest first (T-68)", async () => {
    seen.length = 0;
    const html = await (await get("/moderation")).text();
    expect(seen.filter((r) => r.path === "/moderation/log").map((r) => `${r.query}`)).toEqual([
      "before=18446744073709551615&limit=50",
    ]);
    expect(html).toContain("Decisions, newest first");
    // The rows, after the filter's labels.
    const rows = html
      .slice(html.indexOf('<ol aria-labelledby="log-title"'))
      .replace(/<[^>]+>/g, "");
    expect(rows.indexOf("Refiled")).toBeLessThan(rows.indexOf("Text hidden"));
    expect(rows.indexOf("Text hidden")).toBeLessThan(rows.indexOf("Profile hidden"));
    expect(rows.indexOf("Refiled")).toBeGreaterThanOrEqual(0);
    // The latest page links to no later one.
    expect(html).not.toContain("Latest decisions");
  });

  test.each([
    "?before=abc",
    "?before=99999999999999999999",
    "?before=1&before=2",
    "?before=-1",
    "?after=abc",
    "?after=3&after=4",
    "?after=-1",
  ])("%s starts from the latest, quoting no error", async (search) => {
    seen.length = 0;
    const response = await follow(`/moderation${search}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Text hidden");
    expect(html).not.toMatch(/new Error|expected a canonical/);
    expect(seen.find((r) => r.path === "/moderation/log")?.query.get("before")).toBe(
      "18446744073709551615",
    );
  });

  test("pages back by sequence number, with a way back to the latest", async () => {
    seen.length = 0;
    const html = await (await get("/moderation?before=5")).text();
    expect(seen.find((r) => r.path === "/moderation/log")?.query.get("before")).toBe("5");
    expect(html).toContain("No decisions yet.");
    expect(html).toMatch(/href="\/moderation"[^>]*>(<[^>]+>)*Latest decisions/);
  });

  describe("a log longer than a page", () => {
    // Decisions 1 to 120, each delisting the hidden poll.
    const long = Array.from({ length: 120 }, (_, i) => ({
      ...LATEST,
      seq: String(i + 1),
      action: "delist",
      reason: "spam",
      electionId: HIDDEN_ID,
    }));
    const logReads = () =>
      seen.filter((r) => r.path === "/moderation/log").map((r) => `${r.query}`);
    const pageLinks = (html: string) =>
      [...html.matchAll(/href="(\/moderation\?[^"]*)"[^>]*>(?:<[^>]+>)*(\w+) decisions</g)].map(
        (m) => `${m[2]} ${m[1]!.replaceAll("&amp;", "&")}`,
      );
    beforeAll(() => {
      stub.log = long;
    });
    afterAll(() => {
      stub.log = LOG_ENTRIES;
    });

    test("an earlier page links to later decisions, above its newest", async () => {
      seen.length = 0;
      const html = await (await get("/moderation?before=60")).text();
      expect(logReads()).toEqual(["before=60&limit=50"]);
      expect(html).toContain(">59<");
      expect(html).not.toContain(">60<");
      expect(pageLinks(html)).toEqual([
        "Later /moderation?after=59",
        "Earlier /moderation?before=10",
      ]);
      expect(html).toMatch(/href="\/moderation"[^>]*>(<[^>]+>)*Latest decisions/);
    });

    test("reads later decisions forward and shows them newest first", async () => {
      seen.length = 0;
      const html = await (await get("/moderation?after=10&action=delist")).text();
      expect(logReads()).toEqual(["after=10&limit=50"]);
      const rows = html.slice(html.indexOf('<ol aria-labelledby="log-title"'));
      expect(rows.indexOf(">60<")).toBeGreaterThan(0);
      expect(rows.indexOf(">60<")).toBeLessThan(rows.indexOf(">11<"));
      expect(rows).not.toContain(">10<");
      expect(rows).not.toContain(">61<");
      // Every link keeps the filter; the form and the clear link keep the page.
      expect(pageLinks(html)).toEqual([
        "Latest /moderation?action=delist",
        "Later /moderation?after=60&action=delist",
        "Earlier /moderation?before=11&action=delist",
      ]);
      expect(html).toMatch(/<input type="hidden" name="after" value="10"\/>/);
      expect(html).toContain('href="/moderation?after=10"');
    });

    test("reads the latest page when fewer than a page of decisions are later", async () => {
      seen.length = 0;
      const html = await (await get("/moderation?after=100")).text();
      expect(logReads()).toEqual(["after=100&limit=50", "before=18446744073709551615&limit=50"]);
      const rows = html.slice(html.indexOf('<ol aria-labelledby="log-title"'));
      expect(rows.indexOf(">120<")).toBeGreaterThan(0);
      expect(rows).toContain(">71<");
      expect(rows).not.toContain(">70<");
      // The latest page offers nothing later and doesn't hold its place.
      expect(pageLinks(html)).toEqual(["Earlier /moderation?before=71"]);
      expect(html).not.toContain("Latest decisions");
      expect(html).not.toMatch(/<input type="hidden" name="(after|before)"/);
    });

    test("prefers before when both are given", async () => {
      seen.length = 0;
      await follow("/moderation?before=60&after=10");
      expect(logReads()).toEqual(["before=60&limit=50"]);
    });
  });

  test("filters the page in hand by action, asking the API for the same page (T-10)", async () => {
    seen.length = 0;
    await get("/moderation");
    const plain = seen.map((r) => `${r.path}?${r.query}`).toSorted();
    seen.length = 0;
    const html = await (await get("/moderation?action=hide-profile")).text();
    expect(seen.map((r) => `${r.path}?${r.query}`).toSorted()).toEqual(plain);
    const page = html.replace(/<[^>]+>/g, "");
    expect(html).toContain(`href="/by/${PROFILE_HANDLE}"`);
    expect(html).not.toContain(`href="/polls/${HIDDEN_ID}"`);
    expect(page).toContain("1 of the 3 decisions on this page took this action.");
    expect(html).toMatch(
      /<input[^>]*value="hide-profile"[^>]*checked=""|<input[^>]*checked=""[^>]*value="hide-profile"/,
    );
    expect(html).toContain('href="/moderation"');
  });

  test("keeps the page it filters, in the form and the clear link", async () => {
    const html = await (await get("/moderation?before=9&action=refile")).text();
    expect(html).toMatch(/<input type="hidden" name="before" value="9"\/>/);
    expect(html).toContain('href="/moderation?before=9"');
    expect(html).toContain('href="/moderation?action=refile"');
    expect(html.replace(/<[^>]+>/g, "")).toContain("Refiled");
    expect(html).not.toContain(`href="/by/${PROFILE_HANDLE}"`);
  });

  test.each(["action=vote", "action=hide&action=delist", "action=Hide"])(
    "shows every action for %s",
    async (search) => {
      const html = await (await follow(`/moderation?${search}`)).text();
      expect(html).toContain(`href="/by/${PROFILE_HANDLE}"`);
      expect(html).toContain(`href="/polls/${HIDDEN_ID}"`);
      expect(html).not.toContain("decisions on this page took this action");
    },
  );

  test("counts the whole log by action beside the page, asking for nothing about the visitor (T-10)", async () => {
    seen.length = 0;
    const html = await (await get("/moderation")).text();
    expect(
      seen.filter((r) => r.path === "/moderation/log/counts").map((r) => `${r.query}`),
    ).toEqual([""]);
    const from = html.indexOf('<figure aria-labelledby="log-counts"');
    const tally = html
      .slice(from, html.indexOf("</figure>", from))
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    expect(tally).toContain("The whole log since September 1, 2026: 11 decisions, by action");
    expect(tally).not.toContain("Shown below");
    expect(tally).toContain("Delisted 4");
    expect(tally).toContain("Text hidden 2");
    expect(tally).toContain("Profile hidden 1");
    expect(tally).toContain("Restored 3");
    expect(tally).toContain("Refiled 1");
    expect(html.replace(/<[^>]+>/g, "")).toContain(
      "This page holds 3 of the log&#x27;s 11 decisions.",
    );
    // An earlier page counts the same whole log, and an empty one says nothing of its place.
    const earlier = await (await get("/moderation?before=5")).text();
    expect(earlier).toContain("The whole log since September 1, 2026: 11 decisions");
    expect(earlier).not.toContain("This page holds");
  });

  test("marks the filtered action's count among the whole log's", async () => {
    const html = await (await get("/moderation?action=restore")).text();
    const from = html.indexOf('<figure aria-labelledby="log-counts"');
    const rows = html
      .slice(from, html.indexOf("</figure>", from))
      .split("<li")
      .slice(1)
      .map((row) => ({
        current: row.startsWith(' aria-current="true"'),
        lead: row.includes("fill-primary"),
        text: row
          .replace(/^[^>]*>/, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      }));
    expect(rows).toEqual([
      { current: false, lead: false, text: "Delisted 4" },
      { current: false, lead: false, text: "Text hidden 2" },
      { current: false, lead: false, text: "Profile hidden 1" },
      { current: true, lead: true, text: "Restored Shown below 3" },
      { current: false, lead: false, text: "Refiled 1" },
    ]);
  });

  test.each([
    ["a failed read", undefined],
    ["parts that don't add up to the total", { ...LOG_COUNTS, total: "12" }],
    [
      "decisions with no first one's time",
      Object.fromEntries(Object.entries(LOG_COUNTS).filter(([key]) => key !== "since")),
    ],
    [
      "a first decision's time for an empty log",
      {
        ...LOG_COUNTS,
        ...Object.fromEntries(Object.keys(LOG_COUNTS).map((k) => [k, "0"])),
        since: LOG_COUNTS.since,
      },
    ],
  ])("leaves the counts out after %s, and keeps the log", async (_, counts) => {
    stub.logCounts = counts;
    try {
      const response = await get("/moderation");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`href="/polls/${HIDDEN_ID}"`);
      expect(html).not.toContain("The whole log");
      expect(html).not.toContain("of the log's");
    } finally {
      stub.logCounts = LOG_COUNTS;
    }
  });

  test("states what moderation can't reach and every ground, with the log or without it", async () => {
    for (const path of ["/moderation", "/moderation?before=5"]) {
      const html = await (await get(path)).text();
      expect(html).toContain("Moderation acts on poll text, never on results");
      expect(html).toContain("The count and the result");
      expect(html).toContain("The only seven grounds");
      for (const code of ["illegal", "personal-data", "legal-notice", "notice-withdrawn"])
        expect(html).toContain(`>${code}</code>`);
    }
  });
});

describe("account page", () => {
  test("renders signed out, with the separation, and leaves the session to the page's script", async () => {
    seen.length = 0;
    const response = await get("/account");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Sign in, or create an account");
    expect(html).toContain("Your account is not your vote");
    expect(html).toContain("Accounts use passkeys, which need this page&#x27;s script.");
    expect(html).toMatch(/<meta name="robots" content="noindex"[^>]*>/);
    expect(seen).toEqual([]);
  });

  test("asks a visitor who came to ask a question to sign in for it, and honours no other next", async () => {
    const asking = await (await get("/account?next=new-poll")).text();
    expect(asking).toMatch(/<h1[^>]*>Sign in to ask your question</);
    for (const next of ["https%3A%2F%2Fevil.example", "%2Fpolls", "new-poll%2F"]) {
      // The router drops an unknown value, sending the visitor to the plain page.
      const response = await get(`/account?next=${next}`);
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("/account");
    }
  });
});

describe("verification page", () => {
  test("asks for no phone while phone verification is off, as it is unless set", async () => {
    const html = await (await get("/account/verify")).text();
    expect(html).toContain("Verify your e-mail");
    expect(html).toContain("Your e-mail address");
    expect(html).not.toContain("Verify your e-mail and phone");
    expect(html).not.toContain("Your phone number");
  });

  test("leaves the account's e-mail and phone to the page's script, with no request behind it", async () => {
    seen.length = 0;
    process.env["PHONE_VERIFICATION"] = "on";
    let response: Response;
    try {
      response = await get("/account/verify");
    } finally {
      delete process.env["PHONE_VERIFICATION"];
    }
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Verify your e-mail and phone");
    expect(html).toContain("Your phone number");
    expect(html).toContain("Verifying needs this page&#x27;s script.");
    expect(html).toMatch(/<meta name="robots" content="noindex"[^>]*>/);
    // What the account holds is its own: none of it is server-rendered.
    expect(html).not.toContain("Verified");
    expect(html).not.toContain("Send a code");
    // Turnstile isn't loaded with the page: only a request for a code loads it.
    expect(html).not.toContain("api.js");
    expect(html).toContain(SITE_KEY);
    expect(seen).toEqual([]);
  });
});

describe("poll form", () => {
  test("leaves the form to the page's script, with no request behind it", async () => {
    seen.length = 0;
    for (const path of ["/account/polls/new", `/account/polls/${"a".repeat(32)}`]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Saving a draft needs this page&#x27;s script.");
      expect(html).toMatch(/<meta name="robots" content="noindex"[^>]*>/);
      // A draft is the account's, and the form needs the script: neither is server-rendered.
      expect(html).not.toContain("Save draft");
      // Turnstile isn't loaded with the page: only a submission loads it.
      expect(html).not.toContain("challenges.cloudflare.com");
      expect(html).not.toContain("api.js");
      // The site key the editor renders the widget with comes with the page.
      expect(html).toContain(SITE_KEY);
    }
    expect(seen).toEqual([]);
  });
});

describe("setting up a poll", () => {
  test("leaves setup's steps to the page's script, with no request behind it", async () => {
    seen.length = 0;
    const response = await get(`/account/polls/${"a".repeat(32)}/setup`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Setting up your poll");
    expect(html).toContain("Following setup needs this page&#x27;s script.");
    expect(html).toMatch(/<meta name="robots" content="noindex"[^>]*>/);
    // The poll is the account's: nothing of it is server-rendered.
    expect(html).not.toContain("Put on the public record");
    // A submission lands here as a new document, under every other page's policy (T-55).
    expect(response.headers.get("content-security-policy")).not.toContain(
      "challenges.cloudflare.com",
    );
    expect(seen).toEqual([]);
  });
});

describe("server functions", () => {
  /** The server functions' IDs, as the client bundle calls them. */
  function serverFnIds(): string[] {
    const dir = `${root}dist/client/assets`;
    const ids = readdirSync(dir)
      .filter((f) => f.endsWith(".js"))
      .flatMap((f) => [...readFileSync(`${dir}/${f}`, "utf8").matchAll(/\(`([0-9a-f]{64})`\)/g)])
      .map((m) => m[1] ?? "");
    expect(ids.length).toBe(14);
    return ids;
  }

  test("refuse a call from another site before running", async () => {
    let posts = 0;
    for (const id of serverFnIds()) {
      seen.length = 0;
      const response = await get(`/_serverFn/${id}`, {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "x-tsr-serverfn": "true",
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(seen).toEqual([]);
      // The same call from our own pages gets past the check: with no input, the
      // function's own input check answers, so it was the CSRF check that refused above.
      const headers = { "sec-fetch-site": "same-origin", "x-tsr-serverfn": "true" };
      let own = await get(`/_serverFn/${id}`, headers);
      // The poll page's report is the one POST function (src/data.ts): it refuses a GET.
      if (own.status === 405) {
        posts++;
        seen.length = 0;
        const cross = await handler.fetch(
          new Request(`http://localhost/_serverFn/${id}`, {
            method: "POST",
            headers: {
              origin: "https://attacker.example",
              "sec-fetch-site": "cross-site",
              "x-tsr-serverfn": "true",
            },
          }),
        );
        expect(cross.status).toBe(403);
        expect(seen).toEqual([]);
        own = await handler.fetch(
          new Request(`http://localhost/_serverFn/${id}`, { method: "POST", headers }),
        );
      }
      expect(own.status).toBe(200);
      expect(await own.text()).toMatch(
        // The site key's, the ballot client's and the phone setting's take no
        // input, and answer the key, the address and the setting: off here,
        // which seroval writes `{"t":2,"s":3}`.
        new RegExp(
          `expected an election ID|expected 1 to 10 distinct election IDs|expected a canonical decimal u64|or an empty string|expected a canonical short code|expected a profile handle|expected a stream order|expected a locale|${SITE_KEY}|${BALLOT.replaceAll(".", "\\.")}|"result","error","context"\\],"v":\\[\\{"t":2,"s":3\\}`,
        ),
      );
    }
    expect(posts).toBe(1);
  });
});

describe("home", () => {
  test("shows the newest questions as the stream's cards, with ways to ask and browse", async () => {
    const html = await (await get("/")).text();
    const linked = [...html.matchAll(/<h3\b[^>]*><a[^>]*href="\/polls\/([0-9a-f]{64})"/g)].map(
      (m) => m[1],
    );
    expect(linked).toEqual(streamed.slice(0, 3));
    // The stream's order and checks: a version-5 poll's words, answerable in the ballot client.
    expect(html).toMatch(
      /<h3[^>]*lang="en"[^>]*><a href="\/polls\/c1c1[0-9a-f]{60}"[^>]*>Park and library</,
    );
    expect(html).toContain(`href="${BALLOT}#election=${STREAM_V1}&amp;pick=0"`);
    expect(html).not.toContain(`#election=${STREAM_BAD_TEXT}`);
    expect(html).toMatch(/<a href="\/account\?next=new-poll"[^>]*>Ask a question</);
    expect(html).toMatch(/<a href="\/discover"[^>]*>Browse questions</);
    expect(html).toMatch(/<a href="\/discover"[^>]*>See all questions/);
    // What choosing an answer does is said once, above the cards, not on each.
    expect(html.match(/Nothing is sent until you cast your ballot there/g)).toHaveLength(1);
    // The ID lookup is the register's, not the front page's.
    expect(html).not.toContain('name="id"');
    expect(html).toContain("Why you can trust a casual poll");
    // P2-19 part 65: the trust scene ends on where to read more and where to count again.
    expect(html).toMatch(/<a href="\/how-it-works"[^>]*>How it works, in full</);
    expect(html).toMatch(/<a href="\/verify"[^>]*>How to verify a result yourself</);
  });

  test("asks the API for one short page of the stream (T-52)", async () => {
    seen.length = 0;
    await get("/");
    // The listing, newest first, then each card's definition, text and tags,
    // three, not ten, and their counts in one read (P2-19 part 59). Then the
    // most answered, one past those three, which this API can't sort by, so
    // no card is read for it.
    const listings = seen.filter((r) => r.path === "/elections");
    expect(listings).toHaveLength(2);
    expect(listings[0]?.query.get("sort")).toBe("new");
    expect(listings[0]?.query.get("limit")).toBe("3");
    expect(listings[1]?.query.get("sort")).toBe("answered");
    expect(listings[1]?.query.get("limit")).toBe("4");
    expect(seen).toHaveLength(2 + 3 * 3 + 1);
  });

  // P2-19 part 44: the featured question, from the home mockup's hero.
  describe("the featured question", () => {
    const featured = (html: string) =>
      /<section aria-labelledby="featured-title"[\s\S]*?<\/section>/.exec(html)?.[0];
    const withOrder = async (order: readonly string[], run: () => Promise<void>) => {
      stub.mostAnswered = order;
      stub.answered.set(OPEN_MANY, [{ tier: 0, answered: "9" }]);
      try {
        await run();
      } finally {
        stub.mostAnswered = undefined;
        stub.answered.delete(OPEN_MANY);
      }
    };

    test("is the most answered this week of those not among the newest, answerable from its card", async () =>
      withOrder([STREAM_V5, OPEN_MANY, STREAM_V1], async () => {
        seen.length = 0;
        const html = await (await get("/")).text();
        const section = featured(html);
        expect(section).toBeDefined();
        expect(section).toMatch(/<h2 id="featured-title"[^>]*>Most answered this week</);
        expect(section).toMatch(
          /<a href="\/discover\?sort=answered"[^>]*>More of the most answered</,
        );
        // STREAM_V5 is already among the newest, so the next is featured.
        expect(section).toContain(`href="/polls/${OPEN_MANY}"`);
        expect(section).not.toContain(STREAM_V5);
        expect(section).toContain(`href="${BALLOT}#election=${OPEN_MANY}&amp;pick=0"`);
        // Its card says what choosing does, which the newest's lede says only for theirs.
        expect(section).toContain(
          "Choose an answer to question 1\u00a0of\u00a02 to open it in the ballot app.",
        );
        // Beside the promise, before the newest questions.
        expect(html.indexOf("featured-title")).toBeLessThan(html.indexOf("newest-title"));
        expect(html.indexOf("Browse questions")).toBeLessThan(html.indexOf("featured-title"));
        // One card more than the newest three: four requests for it, no more (T-52).
        expect(seen.filter((r) => r.query.get("electionId") === OPEN_MANY)).toHaveLength(4);
        expect(seen).toHaveLength(2 + 3 * 3 + 1 + 4);
      }));

    test("is left out when the next is a poll nobody has answered, rather than reading another", async () =>
      withOrder([STREAM_V5, OPEN_ONE, OPEN_MANY], async () => {
        seen.length = 0;
        const html = await (await get("/")).text();
        expect(featured(html)).toBeUndefined();
        expect(html).not.toContain("Most answered this week");
        expect(seen.filter((r) => r.query.get("electionId") === OPEN_MANY)).toEqual([]);
        // The newest questions are as without it.
        expect(html).toContain("What people are asking");
      }));

    test("is left out when every most answered poll is among the newest", async () =>
      withOrder([STREAM_V5, STREAM_V1, STREAM_BAD_TEXT], async () => {
        const html = await (await get("/")).text();
        expect(featured(html)).toBeUndefined();
        expect(html).not.toContain("Most answered this week");
      }));
  });

  test("stays up without the API, leaving out only the questions and quoting nothing", async () => {
    stub.down = true;
    try {
      const response = await get("/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Ask a question");
      expect(html).toContain("couldn&#x27;t be loaded just now. Try again in a little while.");
      // A poll's page, its short link and Discover fail on the same API (below),
      // so the note promises none of them and the section links to none.
      expect(html).not.toContain("still works");
      expect(html).not.toContain("See all questions");
      expect(html).not.toContain("127.0.0.1");
      expect(html).not.toMatch(/ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/);
    } finally {
      stub.down = false;
    }
  });
});

describe("how it works", () => {
  test("renders every chapter and the limits from the server, without asking the API", async () => {
    seen.length = 0;
    const response = await get("/how-it-works");
    expect(response.status).toBe(200);
    const html = await response.text();
    const current = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)].map((m) => m[0]);
    expect(current).toHaveLength(2);
    for (const link of current) expect(link).toContain('href="/how-it-works"');
    for (const id of [
      "tiers",
      "secrecy",
      "cast-as-intended",
      "recorded-as-cast",
      "counted-as-recorded",
      "takedown",
      "weak-points",
    ]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
    // The launch panel is ours, and the page says so ([[0027-trustee-panels-and-live-results]]).
    expect(html).toContain("we hold every trustee seat");
    // So is a person with two documents joining Tier 2 twice (T-03).
    expect(html).toContain("One person can hold two documents");
    // Each diagram draws its first step on the server.
    expect([...html.matchAll(/data-testid="diagram-[a-z]+" data-step="0"/g)]).toHaveLength(6);
    // It ends on the verify page, a plain link that needs no script.
    expect(html).toMatch(/<a href="\/verify"[^>]*>How to verify a result yourself<\/a>/);
    expect(seen).toHaveLength(0);
  });
});

describe("verify it yourself", () => {
  test("says the anchor isn't running before any command, without asking the API", async () => {
    seen.length = 0;
    const response = await get("/verify");
    expect(response.status).toBe(200);
    const html = await response.text();
    const current = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)].map((m) => m[0]);
    expect(current).toHaveLength(2);
    for (const link of current) expect(link).toContain('href="/verify"');
    for (const id of ["run", "checks", "trust", "node"]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
    // Nothing here is a sample run: what doesn't work yet comes first.
    const notYet = html.indexOf("Our servers don&#x27;t anchor boards to Ethereum yet");
    expect(notYet).toBeGreaterThan(0);
    expect(notYet).toBeLessThan(html.indexOf("git clone"));
    expect(html).toContain("packages/verifier/src/bin.ts");
    expect(seen).toHaveLength(0);
  });
});

describe("who holds the keys", () => {
  test("says every seat is ours, from the server without asking the API, linked from the footer", async () => {
    seen.length = 0;
    const response = await get("/trustees");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Who holds the keys");
    // Only the footer links it, so the footer's link is the one marked.
    const current = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)].map((m) => m[0]);
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/trustees"');
    for (const id of ["seats", "ours", "promises", "next"]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
    // The label comes before anything else the page says about seats (T-14).
    const label = html.indexOf("During launch, Abolish alone holds the key");
    expect(label).toBeGreaterThan(0);
    expect(label).toBeLessThan(html.indexOf('id="seats"'));
    expect(seen).toHaveLength(0);
    expect(await (await get("/verify")).text()).toContain('href="/trustees"');
  });
});

describe("failures", () => {
  test("a short link while the API is unreachable fails uncached, quoting no error", async () => {
    stub.down = true;
    try {
      const response = await get(`/p/${CODE}`);
      expect(response.status).toBe(500);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(html).toContain("Something went wrong on our side");
      expect(html).not.toContain("127.0.0.1");
      expect(html).not.toMatch(/ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/);
    } finally {
      stub.down = false;
    }
  });

  test("an unreachable API gives an error page that quotes nothing", async () => {
    stub.down = true;
    try {
      const response = await get(`/polls/${ID}`);
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("Something went wrong on our side");
      expect(html).not.toContain("127.0.0.1");
      expect(html).not.toMatch(/ECONNREFUSED|fetch failed/);
      expect(html).not.toMatch(/ECONNRESET|socket hang up/);
    } finally {
      stub.down = false;
    }
  });
});

describe("offline shell", () => {
  test("the offline page is the same script-free document for everyone, with no cookie (P2-28 part 1b)", async () => {
    const response = await get("/offline", { cookie: "better-auth.session_token=tok" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("nonce-");
    expect(response.headers.get("set-cookie")).toBeNull();
    const html = await response.text();
    expect(html).not.toMatch(/<script\b/);
    expect(html).not.toMatch(/<(?:form|input|button|select|textarea|iframe)\b/);
    expect(html).not.toMatch(/\s(?:on[a-z]+|style)="/);
    expect(html).toContain("You&#x27;re offline");
    // "Try again" is this document's own address, which is the page asked for.
    expect(html).toMatch(/<a href="" class="[^"]*">.*Try again<\/a>/);
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/[\w-]+\.css"\/>/);
    // Every link stays on the site.
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
    // And none goes to another page, which would fail offline as this one did.
    expect([...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1])).toEqual(["#main", ""]);
    expect(await (await get("/offline")).text()).toBe(html);
  });

  test.each([
    ["en-US", "/sw.js", "/offline"],
    ["es-US", "/sw.js?lang=es-US", "/offline?lang=es-US"],
  ] as const)(
    "%s's worker is a script naming its offline page's hash and stylesheet, and its notice, and runs as served",
    async (locale, worker, offline) => {
      await loadCatalog(locale);
      const response = await get(worker);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; connect-src 'self'",
      );
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("set-cookie")).toBeNull();
      const source = await response.text();
      const html = await (await get(offline)).text();
      const stylesheet = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1] ?? "";
      const config = await offlineWorkerConfig(locale, html, stylesheet, pushNotice(locale));
      expect(config.offline).toBe(offline);
      expect(config.notice.title).toBe(titles(locale).text("pushNoticeTitle"));
      expect(source).toContain(JSON.stringify(config));
      // The built server's copy of the worker uses nothing outside itself.
      const listened: string[] = [];
      runInNewContext(source, {
        self: { addEventListener: (type: string) => listened.push(type) },
      });
      expect(listened).toEqual(["install", "activate", "fetch", "push", "notificationclick"]);
    },
  );

  test("every page lets the worker start, from our own origin only", async () => {
    for (const path of ["/", "/discover", `/polls/${ID}`])
      expect((await get(path)).headers.get("content-security-policy")).toContain(
        "worker-src 'self'",
      );
  });
});

/**
 * What a first visit to `path` downloads before the page is whole, as a CDN
 * gzips it: the document; every script it runs or preloads, with every module
 * those import statically (not the ones loaded on demand); its stylesheets;
 * and the fonts those name for Basic Latin, the subset an English page draws.
 * Fonts are woff2, compressed already, so they count as built.
 */
async function firstLoad(path: string) {
  const html = await (await get(path)).text();
  const asset = (href: string) => readFileSync(`${root}dist/client${href}`);
  const gzipped = (bytes: Uint8Array) => gzipSync(bytes).byteLength;
  const scripts = new Set(
    [
      ...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g),
      ...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g),
    ].map((m) => m[1]!),
  );
  for (const href of scripts) {
    const code = asset(href).toString("utf8");
    for (const m of code.matchAll(/\b(?:from|import)\s*"\.\/([\w.-]+\.js)"/g))
      scripts.add(`/assets/${m[1]}`);
  }
  const stylesheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
    (m) => m[1]!,
  );
  const fonts = new Set<string>();
  for (const href of stylesheets)
    for (const [face] of asset(href)
      .toString("utf8")
      .matchAll(/@font-face\{[^}]*\}/g))
      if (/unicode-range:U\+\?\?[,;}]/.test(face))
        for (const m of face.matchAll(/url\(([^)]+\.woff2)\)/g)) fonts.add(m[1]!);
  const sum = (hrefs: Iterable<string>, size: (bytes: Uint8Array) => number) =>
    [...hrefs].reduce((total, href) => total + size(asset(href)), 0);
  return {
    html: gzipped(new TextEncoder().encode(html)),
    js: sum(scripts, gzipped),
    css: sum(stylesheets, gzipped),
    fonts: sum(fonts, (bytes) => bytes.byteLength),
  };
}

const KB = 1024;

/**
 * Each everyday page's first visit, in KiB as {@link firstLoad} counts it
 * (P2-28 part 2a). Set a little above what the pages weigh today, so code that
 * grows a page fails here and has to raise its number in the same diff; a
 * dependency that starts shipping far more than it did shows up the same way
 * (T-55). On a slow phone connection (1.6 Mbit/s, Lighthouse's mobile
 * throttling) every 100 KiB is about half a second. Every page shares about
 * 155 KiB of script (React, the router, the message catalog, the frame) and
 * adds only its own (P2-28 part 2b): the poll page its share sheet,
 * reactions, report and follow controls, the results page its tier switcher, the poll form the draft rules and the codecs they check with,
 * home the stream's cards, the featured question's among them, beside its trust scene, the register its search box with its topics and place, counts and pages.
 */
const BUDGETS: Record<string, { html: number; js: number; css: number; fonts: number }> = {
  "/": { html: 10, js: 185, css: 40, fonts: 58 },
  "/discover": { html: 8, js: 182, css: 40, fonts: 58 },
  [`/polls/${ID}`]: { html: 10, js: 222, css: 40, fonts: 58 },
  [`/polls/${CELLS_ID}/results`]: { html: 10, js: 192, css: 40, fonts: 58 },
  "/polls": { html: 12, js: 185, css: 40, fonts: 58 },
  "/how-it-works": { html: 12, js: 178, css: 40, fonts: 58 },
  "/verify": { html: 8, js: 174, css: 40, fonts: 58 },
  "/trustees": { html: 6, js: 177, css: 40, fonts: 58 },
  "/account": { html: 6, js: 204, css: 40, fonts: 58 },
  "/account/polls/new": { html: 5, js: 259, css: 40, fonts: 58 },
  [`/p/${CODE}/flyer`]: { html: 8, js: 179, css: 40, fonts: 58 },
  "/offline": { html: 4, js: 0, css: 40, fonts: 58 },
};

describe("performance budgets", () => {
  test.each(Object.entries(BUDGETS))("%s stays within its budget", async (path, budget) => {
    const load = await firstLoad(path);
    const kib = Object.fromEntries(
      Object.entries(load).map(([k, bytes]) => [k, Math.ceil(bytes / KB)]),
    );
    for (const key of ["html", "js", "css", "fonts"] as const)
      expect(load[key], `${key}: ${JSON.stringify(kib)}`).toBeLessThanOrEqual(budget[key] * KB);
  });
});

describe("link preview", () => {
  /** A PNG's width and height, from its IHDR chunk, after checking the signature. */
  async function pngSize(response: Response) {
    const png = new Uint8Array(await response.arrayBuffer());
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
    const view = new DataView(png.buffer);
    return [view.getUint32(16), view.getUint32(20)];
  }

  /** The poll page's og:image, which names the preview's current version. */
  async function ogImage(): Promise<URL> {
    const html = await (await get(`/polls/${ID}`)).text();
    const image = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
    if (image === undefined) throw new Error("no og:image");
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
    expect(html).toContain('<meta property="og:image:width" content="1200"');
    expect(html).toContain('<meta name="twitter:image" content="');
    return new URL(image.replaceAll("&amp;", "&"));
  }

  test("the poll page names a versioned image, cached for good, with no cookie", async () => {
    const image = await ogImage();
    expect(image.origin).toBe("http://localhost");
    expect(image.pathname).toBe(`/polls/${ID}/preview.png`);
    expect(image.searchParams.get("v")).toMatch(/^[0-9a-f]{24}$/);
    const response = await get(image.pathname + image.search, {
      cookie: "__Secure-abolish-account.session_token=secret",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBe(`"${image.searchParams.get("v")}"`);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    // Chats' web clients show it from our URL.
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'; sandbox",
    );
    expect(await pngSize(response)).toEqual([1200, 630]);
  });

  test("an unversioned or stale URL gets the current image, briefly cached and revalidated", async () => {
    for (const path of [
      `/polls/${ID}/preview.png`,
      `/polls/${ID}/preview.png?v=${"0".repeat(24)}`,
    ]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
      const etag = response.headers.get("etag") ?? "";
      expect(etag).toMatch(/^"[0-9a-f]{24}"$/);
      await response.body?.cancel();
      const again = await get(path, { "if-none-match": etag });
      expect(again.status).toBe(304);
      expect(await again.text()).toBe("");
    }
  });

  test("comes square on request", async () => {
    const response = await get(`/polls/${ID}/preview.png?format=square`);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await pngSize(response)).toEqual([1080, 1080]);
  });

  // P2-28 part 4c-2: the page's language picks the preview's words, and the
  // image's address carries it, since a chat fetches the image with none of
  // the reader's headers.
  test("a page in Spanish names the Spanish image and words, whatever the image's request asks", async () => {
    const html = await (await get(`/polls/${ID}`, { "accept-language": "es-MX,es;q=0.9" })).text();
    expect(html).toContain(`<meta property="og:title" content="Encuesta ${CODE}"`);
    expect(html).toMatch(/<meta property="og:description" content="[^"]*el conteo\."/);
    const found = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
    if (found === undefined) throw new Error("no og:image");
    const image = new URL(found.replaceAll("&amp;", "&"));
    expect(image.pathname).toBe(`/polls/${ID}/preview.png`);
    expect(image.searchParams.get("lang")).toBe("es-US");
    const english = await ogImage();
    expect(english.searchParams.has("lang")).toBe(false);
    expect(image.searchParams.get("v")).not.toBe(english.searchParams.get("v"));
    // The address alone decides: an English reader's request gets the same image.
    const bodies: string[] = [];
    for (const headers of [{}, { "accept-language": "en-US" }, { cookie: "lang=en-US" }]) {
      const response = await get(image.pathname + image.search, headers);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("etag")).toBe(`"${image.searchParams.get("v")}"`);
      bodies.push(Buffer.from(await response.arrayBuffer()).toString("base64"));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  // P2-24 part 4: a closed poll's final lead, from the results its page reads.
  test("gives a closed poll's final lead where one tier's count is published", async () => {
    const meta = async (id: string) => {
      const html = (await (await get(`/polls/${id}`)).text()).replaceAll("&#x27;", "'");
      return {
        description: /<meta property="og:description" content="([^"]*)"/.exec(html)?.[1],
        image: /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1],
      };
    };
    // The first question's lead, never one across questions (T-16).
    const v5 = await meta(STREAM_V5);
    expect(v5.description).toMatch(
      /^Closed on \d+ \w+\. Tied for most picked: \u2068Yes\u2069 and \u2068No\u2069, each by 50% of those who answered\. Anyone can check the count\.$/,
    );
    // A hidden poll's result by answer number: its text is withheld, its result never is.
    expect((await meta(HIDDEN_ID)).description).toContain(
      "Most picked: Answer 1, by 100% of those who answered.",
    );
    // Counted in two tiers: no lead across them (ADR 0026).
    expect((await meta(STREAM_V1)).description).toContain("Each tier is counted on its own.");
    expect((await meta(STREAM_V1)).description).not.toContain("%");
    // Not yet counted: no lead.
    expect((await meta(ID)).description).not.toContain("%");
    if (v5.image === undefined) throw new Error("no og:image");
    const image = new URL(v5.image.replaceAll("&amp;", "&"));
    const response = await get(image.pathname + image.search);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await pngSize(response)).toEqual([1200, 630]);
  });

  // P2-24 part 6: the question in the preview, from the display text checked
  // against the definition, in the page's translation.
  test("names a poll by its question where its display text checks, in the page's language", async () => {
    const meta = async (id: string, headers: Record<string, string> = {}) => {
      const html = await (await get(`/polls/${id}`, headers)).text();
      return {
        title: /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1],
        image: /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1],
      };
    };
    const one = await meta(OPEN_ONE);
    expect(one.title).toBe("Should the park stay open late?");
    // Beside our words in the image's description, the author's are isolated (T-75).
    const html = await (await get(`/polls/${OPEN_ONE}`)).text();
    expect(html).toContain(
      '<meta property="og:image:alt" content="\u2068Should the park stay open late?\u2069. ',
    );
    expect((await meta(OPEN_ONE, { "accept-language": "es-MX" })).title).toBe(
      "¿Debe el parque abrir hasta tarde?",
    );
    expect((await meta(OPEN_MANY)).title).toBe("Park and library");
    // Text that fails its check against the definition names no one's words (T-34).
    expect((await meta(STREAM_BAD_TEXT)).title).toBe("A poll on localhost");
    expect((await meta(STREAM_NO_TEXT)).title).toBe("A poll on localhost");
    // The image the page names is the one served for it now.
    if (one.image === undefined) throw new Error("no og:image");
    const image = new URL(one.image.replaceAll("&amp;", "&"));
    const response = await get(image.pathname + image.search);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await pngSize(response)).toEqual([1200, 630]);
  });

  test.each([
    ["the default's name", `/polls/${ID}/preview.png?lang=en-US`, 400],
    ["a language that isn't exactly ours", `/polls/${ID}/preview.png?lang=es`, 400],
    ["a language we don't have", `/polls/${ID}/preview.png?lang=fr-FR`, 400],
    ["an unknown poll", `/polls/${UNKNOWN_ID}/preview.png`, 404],
    ["a non-canonical ID", `/polls/${ID.toUpperCase()}/preview.png`, 404],
    ["another election's definition", `/polls/${SWAPPED_ID}/preview.png`, 404],
    ["an unknown format", `/polls/${ID}/preview.png?format=tall`, 400],
    ["an unknown parameter", `/polls/${ID}/preview.png?utm_source=chat`, 400],
  ])("refuses %s", async (_, path, status) => {
    const response = await get(path);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).not.toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

// The second language (P2-28 part 4): each page is in the language its
// request chose, the footer's cookie first, then `Accept-Language`, then
// English (src/locales.ts), its head and its words alike.
describe("the page's language", () => {
  // This process's copy of the catalogs, for the words the pages should show.
  beforeAll(() => loadCatalog("es-US"));
  const es = titles("es-US").text;
  const SPANISH = { "accept-language": "es-MX,es;q=0.9,en;q=0.5" };
  const lang = (html: string) => /<html lang="([^"]+)"/.exec(html)?.[1];

  test("is English for a request that asks for no language of ours", async () => {
    for (const headers of [
      {},
      { "accept-language": "fr-CA,de;q=0.8" },
      { "accept-language": "*" },
    ]) {
      const response = await get("/how-it-works", headers);
      expect(lang(await response.text())).toBe("en-US");
      expect(response.headers.get("content-language")).toBe("en-US");
    }
  });

  test("follows Accept-Language: the document, its title and its words", async () => {
    const response = await get("/how-it-works", SPANISH);
    expect(response.headers.get("content-language")).toBe("es-US");
    const html = await response.text();
    expect(lang(html)).toBe("es-US");
    expect(html).toContain(`<title>${es("navHowItWorks")} · ${es("siteName")}</title>`);
    expect(html).toContain(es("howTitle"));
    expect(html).not.toContain("How a ballot stays secret");
  });

  test("shows each card's translation in the page's language, where the poll has one", async () => {
    const html = await (await get("/discover", SPANISH)).text();
    expect(html).toContain(es("homeStreamTitle"));
    // Both polls' texts have an `es-419` translation beside their `en`, each marked as such.
    expect(html).toMatch(
      /<h3[^>]*lang="es-419"[^>]*><a href="\/polls\/c1c1[0-9a-f]{60}"[^>]*>Parque y biblioteca</,
    );
    expect(html).toContain(">¿Debe el parque abrir hasta tarde?<");
    expect(html).not.toContain("Park and library");
  });

  test("keeps the footer's choice over Accept-Language, and ignores a cookie that names none of ours", async () => {
    const chosen = await get("/how-it-works", { ...SPANISH, cookie: "theme=x; lang=en-US" });
    expect(lang(await chosen.text())).toBe("en-US");
    const own = await get("/how-it-works", { cookie: "lang=es-US" });
    expect(lang(await own.text())).toBe("es-US");
    for (const cookie of ["lang=fr-FR", "lang=es-us", "lang=es-US; lang=en-US", "lang="]) {
      const response = await get("/how-it-works", { ...SPANISH, cookie });
      expect(lang(await response.text())).toBe("es-US");
    }
    // A page sets no cookie of its own: only the switch writes it.
    expect(chosen.headers.get("set-cookie")).toBeNull();
  });

  test("the footer names each language in itself, the page's own marked and the other a button", async () => {
    for (const [headers, current, other] of [
      [{}, "English", "Español"],
      [SPANISH, "Español", "English"],
    ] as const) {
      const html = await (await get("/polls", headers)).text();
      const nav = /<nav aria-label="(?:Language|Idioma)">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
      expect(nav).toMatch(
        new RegExp(`<span lang="[a-z]{2}-US" aria-current="true"[^>]*>${current}</span>`),
      );
      expect(nav).toMatch(
        new RegExp(`<button type="button" lang="[a-z]{2}-US"[^>]*>${other}</button>`),
      );
    }
  });

  test("an embed follows its reader's Accept-Language alone, and says it varies by it", async () => {
    const response = await get(`/embed/p/${OPEN_ONE_CODE}`, { ...SPANISH, cookie: "lang=en-US" });
    expect(response.headers.get("vary")).toBe("Accept-Language");
    expect(response.headers.get("content-language")).toBe("es-US");
    const html = await response.text();
    expect(lang(html)).toBe("es-US");
    expect(lang(await (await get(`/embed/p/${OPEN_ONE_CODE}`)).text())).toBe("en-US");
  });

  test("the offline page and its worker are their address's language, whatever the request asks", async () => {
    const english = await (await get("/offline")).text();
    const spanish = await (await get("/offline?lang=es-US")).text();
    expect([lang(english), lang(spanish)]).toEqual(["en-US", "es-US"]);
    expect(spanish).toContain(`<title>${es("offlineTitle")} · ${es("siteName")}</title>`);
    expect(spanish).toContain(es("offlineRetry"));
    expect(spanish).not.toContain("Try again");
    // One address is one document for everyone (the worker's cache is named by its hash).
    for (const [path, html] of [
      ["/offline", english],
      ["/offline?lang=es-US", spanish],
    ] as const)
      for (const headers of [{}, SPANISH, { cookie: "lang=es-US" }, { cookie: "lang=en-US" }]) {
        const response = await get(path, headers);
        expect(await response.text()).toBe(html);
        expect(response.headers.get("content-language")).toBeNull();
      }
    expect(await (await get("/sw.js", SPANISH)).text()).toBe(await (await get("/sw.js")).text());
    // Any other query is no shell of ours.
    for (const query of ["?lang=en-US", "?lang=es", "?lang=fr-FR", "?lang=es-US&x=1", "?v=1"]) {
      expect((await get(`/offline${query}`)).status, query).toBe(404);
      expect((await get(`/sw.js${query}`)).status, query).toBe(404);
    }
  });

  test("a page links its own language's manifest", async () => {
    const manifest = (html: string) => /<link rel="manifest" href="([^"]+)"/.exec(html)?.[1];
    expect(manifest(await (await get("/discover")).text())).toBe("/manifest.webmanifest");
    expect(manifest(await (await get("/discover", SPANISH)).text())).toBe(
      "/manifest.es-US.webmanifest",
    );
  });
});
