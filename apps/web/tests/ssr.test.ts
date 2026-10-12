// The built server, end to end: pages rendered by dist/server/server.js
// against a stub API, checking what reaches the visitor (headers, nonces,
// what is shown) and what reaches the API (nothing of the visitor's).

import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import { decodeElectionDefinition, encodeElectionDefinition } from "@abolishus/crypto";
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
  test.each(["/", `/polls/${ID}`, "/moderation", "/polls", "/account", "/nowhere"])(
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
      expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
    },
  );

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
  });

  test("forwards nothing of the visitor's to the API (T-10)", async () => {
    seen.length = 0;
    await get(`/polls/${ID}`, {
      cookie: "__Secure-abolish-account.session_token=secret",
      authorization: "Bearer secret",
      "x-forwarded-for": "203.0.113.9",
      "user-agent": "visitor-agent",
    });
    expect(seen.length).toBe(3);
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
    expect(await response.text()).toContain("knows no poll or page");
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
    expect(ids.length).toBe(3);
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
        /expected an election ID|expected a canonical decimal u64|or an empty string/,
      );
    }
  });
});

describe("failures", () => {
  test("an unreachable API gives an error page that quotes nothing", async () => {
    down = true;
    try {
      const response = await get(`/polls/${ID}`);
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("Something went wrong");
      expect(html).not.toContain("127.0.0.1");
      expect(html).not.toMatch(/ECONNREFUSED|fetch failed/);
      expect(html).not.toMatch(/ECONNRESET|socket hang up/);
    } finally {
      down = false;
    }
  });
});
