// The built server, end to end: pages rendered by dist/server/server.js
// against a stub API, checking what reaches the visitor (headers, nonces,
// what is shown) and what reaches the API (nothing of the visitor's).

import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import { shortCode } from "@abolishus/core/short-codes";
import {
  decodeElectionDefinition,
  electionDefinitionHash,
  encodeElectionDefinition,
} from "@abolishus/crypto";
import { createBuilder } from "vite-plus";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { fromHex, toHex } from "../src/values.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

interface Vector {
  id: string;
  value?: { election_id: string };
  encoding: string;
  hash?: string;
}
const vectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/election-definition.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const typical = vectors.find((v) => v.id === "definition-typical");
const approval = vectors.find((v) => v.id === "definition-approval");
if (typical?.value === undefined || approval?.value === undefined)
  throw new Error("vectors missing");

const ID = typical.value.election_id;
/** Known to the stub, but its definition names another election. */
const SWAPPED_ID = "ab".repeat(32);
const UNKNOWN_ID = "cd".repeat(32);
const HEAD = { treeSize: "12", chainHead: "1f".repeat(32), root: "2e".repeat(32) };
const LATEST = {
  seq: "7",
  action: "hide",
  reason: "personal-data",
  decidedAt: "2026-10-01T12:00:00.000Z",
};

/** A poll whose text moderation has hidden: the approval vector, under an ID of its own. */
const HIDDEN_ID = "ef".repeat(32);
const hiddenDefinition = toHex(
  encodeElectionDefinition({
    ...decodeElectionDefinition(fromHex(approval.encoding)),
    election_id: fromHex(HIDDEN_ID),
  }),
);

const definitions = new Map([
  [ID, typical.encoding],
  [HIDDEN_ID, hiddenDefinition],
  [SWAPPED_ID, typical.encoding],
]);

/**
 * What the stub lists for discovery, in order, as the API would: never the
 * hidden poll. Eighteen fillers, the typical poll and one the stub has lost
 * fill the first page, with the lost one last (so it is the page's cursor
 * but not shown); the swapped poll is on the second.
 */
const FILLER = Array.from({ length: 18 }, (_, i) =>
  (i + 1).toString(16).padStart(2, "0").repeat(32),
);
const LOST_ID = "13".repeat(32);
const listed = [...FILLER, ID, SWAPPED_ID, LOST_ID].sort();
for (const id of FILLER)
  definitions.set(
    id,
    toHex(
      encodeElectionDefinition({
        ...decodeElectionDefinition(fromHex(typical.encoding)),
        election_id: fromHex(id),
      }),
    ),
  );

/** A poll's short code at `length`, from the definition the stub serves for it. */
const codeOf = (id: string, length = 7) =>
  shortCode(
    electionDefinitionHash(decodeElectionDefinition(fromHex(definitions.get(id) ?? ""))),
    length,
  );
const CODE = codeOf(ID);
/** The hidden poll's code, as if an earlier poll's hash shared its first 7 characters. */
const HIDDEN_CODE = codeOf(HIDDEN_ID, 8);
/** A code the stub claims for the typical poll, though its hash doesn't start with it. */
const FALSE_CODE = CODE.startsWith("z") ? `y${CODE.slice(1)}` : `z${CODE.slice(1)}`;
/** A code the stub claims for the swapped poll, whose served definition names another. */
const SWAPPED_CODE = "s".repeat(7);
const UNKNOWN_CODE = "x".repeat(7);
const owners = new Map([
  [CODE, ID],
  [HIDDEN_CODE, HIDDEN_ID],
  [FALSE_CODE, ID],
  [SWAPPED_CODE, SWAPPED_ID],
]);
/** A listed poll the stub claims a code for that isn't a prefix of its hash. */
const MISCODED_ID = FILLER[0]!;
const MISCODED_CODE = codeOf(MISCODED_ID).startsWith("z")
  ? `y${codeOf(MISCODED_ID).slice(1)}`
  : `z${codeOf(MISCODED_ID).slice(1)}`;
/** A listed poll whose code the stub fails to answer, as an API without the route would. */
const CODE_FAILS_ID = FILLER[2]!;
/** Each poll's canonical code as the stub claims it; the other polls have no registration. */
const codes = new Map([
  [ID, CODE],
  [HIDDEN_ID, HIDDEN_CODE],
  [MISCODED_ID, MISCODED_CODE],
]);

/** A forgiving spelling of `code`: upper case, with `0` written `O` and `1` written `I`. */
const forgiving = (code: string) => code.toUpperCase().replaceAll("0", "O").replaceAll("1", "I");

/** While set, the stub drops every connection unanswered, as a dead API would. */
let down = false;

/** Every request the stub API received, with its headers. */
const seen: { path: string; headers: IncomingHttpHeaders }[] = [];

function stubApi(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    seen.push({ path: url.pathname, headers: req.headers });
    if (down) return void req.socket.destroy();
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const electionId = url.searchParams.get("electionId") ?? "";
    const definition = definitions.get(electionId);
    if (url.pathname === "/moderation/log") {
      const after = BigInt(url.searchParams.get("after") ?? "0");
      const entries = after < 7n ? [{ ...LATEST, electionId: HIDDEN_ID }] : [];
      return json(200, { entries });
    }
    if (url.pathname === "/elections/by-code") {
      // The API's answer for a code it is given in any form; this stub knows only canonical ones.
      const code = url.searchParams.get("code") ?? "";
      const electionId = owners.get(code);
      if (electionId === undefined)
        return json(404, {
          defined: true,
          code: "CODE_NOT_FOUND",
          status: 404,
          message: "No poll owns this code.",
        });
      return json(200, { electionId, code });
    }
    if (url.pathname === "/elections") {
      const after = url.searchParams.get("after") ?? "";
      const limit = Number(url.searchParams.get("limit"));
      return json(200, { elections: listed.filter((id) => id > after).slice(0, limit) });
    }
    if (definition === undefined)
      return json(404, {
        defined: true,
        code: "ELECTION_NOT_FOUND",
        status: 404,
        message: "No election with this id is known to this server.",
      });
    switch (url.pathname) {
      case "/elections/definition":
        return json(200, { definition });
      case "/board/head":
        return json(200, HEAD);
      case "/moderation/status":
        return json(
          200,
          electionId === HIDDEN_ID ? { state: "hidden", latest: LATEST } : { state: "visible" },
        );
      case "/elections/code": {
        if (electionId === CODE_FAILS_ID) return json(500, {});
        const code = codes.get(electionId);
        return code === undefined
          ? json(404, {
              defined: true,
              code: "CODE_NOT_FOUND",
              status: 404,
              message: "No registration is recorded for this election.",
            })
          : json(200, { code });
      }
    }
    json(404, {});
  });
}

let api: Server;
let handler: { fetch(request: Request): Promise<Response> };

beforeAll(async () => {
  api = stubApi();
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  process.env["API_URL"] = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const builder = await createBuilder({ root, logLevel: "warn" });
  await builder.buildApp();
  const server = (await import(pathToFileURL(`${root}dist/server/server.js`).href)) as {
    default: typeof handler;
  };
  handler = server.default;
}, 120_000);

afterAll(async () => {
  await new Promise((resolve) => api.close(resolve));
});

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return handler.fetch(new Request(`http://localhost${path}`, { headers }));
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
  const match = /script-src 'self' 'nonce-([A-Za-z0-9+/]{22}==)'(?:;|$)/.exec(csp);
  if (match?.[1] === undefined) throw new Error(`unexpected CSP: ${csp}`);
  return match[1];
}

describe("every page", () => {
  test.each([
    "/",
    `/polls/${ID}`,
    "/moderation",
    "/polls",
    "/account",
    "/nowhere",
    `/p/${UNKNOWN_CODE}`,
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
      expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
    },
  );

  test("the frame marks the page the visitor is on, and only that one", async () => {
    const html = await (await get("/polls")).text();
    const current = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)].map((m) => m[0]);
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/polls"');
    expect(await (await get("/nowhere")).text()).not.toContain('aria-current="page"');
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
    expect(html).not.toContain('name="robots"');
    expect(html).toContain(`href="/p/${CODE}"`);
    expect(html).toContain(`<meta property="og:title" content="Poll ${CODE}"`);
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
  });

  test("forwards nothing of the visitor's to the API (T-10)", async () => {
    seen.length = 0;
    await get(`/polls/${ID}`, {
      cookie: "__Secure-abolish-account.session_token=secret",
      authorization: "Bearer secret",
      "x-forwarded-for": "203.0.113.9",
      "user-agent": "visitor-agent",
    });
    expect(seen.length).toBe(4);
    for (const { headers } of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers["x-forwarded-for"]).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain("secret");
      expect(JSON.stringify(headers)).not.toContain("203.0.113.9");
      expect(JSON.stringify(headers)).not.toContain("visitor-agent");
    }
  });

  test("a hidden poll says so, with the reason, and is kept out of search engines", async () => {
    const html = await (await get(`/polls/${HIDDEN_ID}`)).text();
    expect(html).toContain("question and option text are withheld (Personal data)");
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).toContain("Approve any number");
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

describe("poll list", () => {
  /** The polls a page of the list links to, in order. */
  const linked = (html: string) =>
    [...html.matchAll(/<li\b[^>]*><a[^>]*href="\/polls\/([0-9a-f]{64})"/g)].map((m) => m[1]);

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

describe("moderation log", () => {
  test("lists decisions with their reasons, linking each poll", async () => {
    const html = await (await get("/moderation")).text();
    expect(html).toContain("Text hidden");
    expect(html).toContain("Personal data");
    expect(html).toContain(`href="/polls/${HIDDEN_ID}"`);
  });

  test.each(["?after=abc", "?after=99999999999999999999", "?after=1&after=2", "?after=-1"])(
    "%s starts from the beginning, quoting no error",
    async (search) => {
      const response = await follow(`/moderation${search}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Text hidden");
      expect(html).not.toMatch(/new Error|expected a canonical/);
    },
  );

  test("pages by sequence number", async () => {
    const html = await (await get("/moderation?after=7")).text();
    expect(html).toContain("No decisions yet.");
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
    expect(ids.length).toBe(4);
    return ids;
  }

  test("refuse a call from another site before running", async () => {
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
      const own = await get(`/_serverFn/${id}`, {
        "sec-fetch-site": "same-origin",
        "x-tsr-serverfn": "true",
      });
      expect(own.status).toBe(200);
      expect(await own.text()).toMatch(
        /expected an election ID|expected a canonical decimal u64|or an empty string|expected a canonical short code/,
      );
    }
  });
});

describe("failures", () => {
  test("a short link while the API is unreachable fails uncached, quoting no error", async () => {
    down = true;
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
      down = false;
    }
  });

  test("an unreachable API gives an error page that quotes nothing", async () => {
    down = true;
    try {
      const response = await get(`/polls/${ID}`);
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("Something went wrong on our side");
      expect(html).not.toContain("127.0.0.1");
      expect(html).not.toMatch(/ECONNREFUSED|fetch failed/);
      expect(html).not.toMatch(/ECONNRESET|socket hang up/);
    } finally {
      down = false;
    }
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

  test.each([
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
