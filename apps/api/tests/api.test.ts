import {
  BOARD_TREE,
  checkBoard,
  checkElectionToShow,
  checkpointOf,
  decodeCheckpoint,
  type DisplayText,
  displayTextCommitment,
  encodeDisplayText,
  encodeElectionDefinition,
  identityBackupId,
  merkleRoot,
  newIdentitySecret,
  openIdentityBackup,
  sealIdentityBackup,
  UNPINNED,
  verifyConsistency,
  verifyInclusion,
} from "@abolishus/crypto";
import {
  ACCOUNT_COOKIE_PREFIX,
  appendEntry,
  IDENTITY_BACKUP_ENVELOPE_LENGTH,
  IDENTITY_BACKUP_RETENTION_MONTHS,
  MAX_REPORT_QUEUE,
  insertPollTags,
  MAX_ANSWERED_ELECTIONS as CORE_MAX_ANSWERED_ELECTIONS,
  MAX_LISTED_PLACES as CORE_MAX_LISTED_PLACES,
  MAX_PLACE_LENGTH as CORE_MAX_PLACE_LENGTH,
  MAX_SEARCH_QUERY as CORE_MAX_SEARCH_QUERY,
  MAX_SEARCH_TERMS as CORE_MAX_SEARCH_TERMS,
  MAX_SHORT_CODE_LENGTH as CORE_MAX_SHORT_CODE_LENGTH,
  makeProfile,
  moderate,
  POLL_TOPICS as CORE_POLL_TOPICS,
  moderateProfile,
  PROFILE_HANDLE as CORE_PROFILE_HANDLE,
  readBoard,
  readReportQueue,
  recordRegistration,
  REFILE_REASONS as CORE_REFILE_REASONS,
  refilePoll,
  REMOVAL_REASONS as CORE_REMOVAL_REASONS,
  RESTORE_REASONS as CORE_RESTORE_REASONS,
  SearchQueryError,
  searchTerms,
  shortCode,
  storeDefinition,
  storeDisplayText,
  takeCheckpoints,
} from "@abolishus/core";
import {
  contract,
  IDENTITY_BACKUP_ENVELOPE,
  IDENTITY_BACKUP_RETENTION_MONTHS as CONTRACT_RETENTION_MONTHS,
  MAX_ANSWERED_ELECTIONS,
  MAX_LISTED_PLACES,
  MAX_PLACE_LENGTH,
  MAX_SEARCH_QUERY,
  MAX_SEARCH_TERMS,
  MAX_SHORT_CODE_LENGTH,
  POLL_TOPICS,
  PROFILE_HANDLE,
  REFILE_REASONS,
  REMOVAL_REASONS,
  RESTORE_REASONS,
} from "@abolishus/api-contract";
import { addModerators, newAccount, type TestDb, testDb, typical } from "@abolishus/core/test-db";
import fc from "fast-check";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { createServer, request as httpRequest, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { createApiServer, MAX_REQUEST_BODY, type RequestLogLine } from "../src/index.ts";

// The API end to end over HTTP, against a live Postgres: what it serves is
// what the verifier's own code accepts (T-23, T-24, T-34), inputs are bounded
// (T-31, T-52), no ballot is boarded without admission (T-53), and the
// request log never carries anything that names a person, a session or a
// ballot (T-10, T-11).

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const b32 = () => new Uint8Array(randomBytes(32));
const utf8 = (s: string) => new TextEncoder().encode(s);

let db: TestDb;
let app: Sql;
let server: Server;
let base: string;
const logs: unknown[] = [];

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  await addModerators(app, "mod-1", "mod-2", "mod-other", "mod-secret");
  server = createApiServer({ sql: app, log: (l) => logs.push(l) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await db?.close();
});

/** A stored election with `n` ballots on its board. */
async function election(n = 0, payloadSize = 4) {
  const id = b32();
  const definition = encodeElectionDefinition({ ...typical, election_id: id });
  await storeDefinition(app, definition);
  for (let i = 0; i < n; i++) {
    const payload = new Uint8Array(payloadSize);
    payload.set([0, 2, 1, i & 0xff]);
    await appendEntry(app, id, Math.floor(i / 2), payload);
  }
  const checked = checkBoard(id, await readBoard(app, id), UNPINNED);
  const root = (m: number) => merkleRoot(BOARD_TREE, checked.entryHashes.slice(0, m));
  return { id, idHex: hex(id), definition, checked, root };
}

const get = (path: string, query: Record<string, string>) =>
  fetch(`${base}${path}?${new URLSearchParams(query).toString()}`);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("elections.getDefinition", () => {
  test("serves a stored definition's bytes", async () => {
    const e = await election();
    const r = await get("/elections/definition", { electionId: e.idHex });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ definition: hex(e.definition) });
  });

  test("an unknown election is ELECTION_NOT_FOUND", async () => {
    const r = await get("/elections/definition", { electionId: hex(b32()) });
    expect(r.status).toBe(404);
    expect((await json(r))["code"]).toBe("ELECTION_NOT_FOUND");
  });

  test("refuses an election ID in any spelling but lowercase hex", async () => {
    const e = await election();
    for (const electionId of [e.idHex.toUpperCase(), `0x${e.idHex}`, e.idHex.slice(2)])
      expect((await get("/elections/definition", { electionId })).status).toBe(400);
  });
});

describe("elections.getDisplayText (T-34, T-68)", () => {
  interface TextVector {
    id: string;
    encoding: string;
    definition?: { optionCount: string; displayTextCommitment: string };
  }
  const good = (
    JSON.parse(
      readFileSync(
        new URL("../../../docs/spec/vectors/display-text.json", import.meta.url),
        "utf8",
      ),
    ).vectors as TextVector[]
  ).find((v) => v.id === "display-text-two-languages")!;

  /** A stored election committing to the good text, closing at `closesAt`, with the text stored. */
  async function withText(closesAt = typical.closes_at, store = true) {
    const id = b32();
    const definition = encodeElectionDefinition({
      ...typical,
      election_id: id,
      closes_at: closesAt,
      option_count: Number(good.definition!.optionCount),
      display_text_commitment: unhex(good.definition!.displayTextCommitment),
    });
    const { definitionHash } = await storeDefinition(app, definition);
    if (store) await storeDisplayText(app, id, unhex(good.encoding));
    return { id, idHex: hex(id), definition, definitionHash };
  }
  const text = (electionId: string) => get("/elections/display-text", { electionId });

  test("serves the stored text, which passes the client's check against the definition", async () => {
    const e = await withText();
    const r = await text(e.idHex);
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body).toEqual({ displayText: good.encoding });
    const checked = checkElectionToShow(
      e.id,
      e.definitionHash,
      e.definition,
      unhex(body["displayText"] as string),
    );
    expect(checked.ok).toBe(true);
  });

  test("an unknown election is ELECTION_NOT_FOUND, a known one without text DISPLAY_TEXT_NOT_FOUND", async () => {
    const unknown = await text(hex(b32()));
    expect([unknown.status, (await json(unknown))["code"]]).toEqual([404, "ELECTION_NOT_FOUND"]);
    const none = await text((await withText(typical.closes_at, false)).idHex);
    expect([none.status, (await json(none))["code"]]).toEqual([404, "DISPLAY_TEXT_NOT_FOUND"]);
  });

  test("a hidden poll's text is DISPLAY_TEXT_WITHHELD, and served again once restored", async () => {
    const e = await withText();
    await moderate(app, e.id, { action: "hide", reason: "spam", moderator: "mod-1" });
    const r = await text(e.idHex);
    expect([r.status, (await json(r))["code"]]).toEqual([451, "DISPLAY_TEXT_WITHHELD"]);
    await moderate(app, e.id, { action: "restore", reason: "error", moderator: "mod-1" });
    expect((await text(e.idHex)).status).toBe(200);
  });

  test("an open poll hidden as a threat is served by the server's clock until it can take no ballot", async () => {
    const closesAt = BigInt(Math.floor(Date.now() / 1000)) + 86_400n;
    const e = await withText(closesAt);
    await moderate(app, e.id, { action: "hide", reason: "threat", moderator: "mod-1" });
    expect((await text(e.idHex)).status).toBe(200);
    const later = createApiServer({
      sql: app,
      log: () => {},
      now: () => closesAt + BigInt(typical.l1_inclusion_bound),
    });
    await new Promise<void>((r) => later.listen(0, "127.0.0.1", r));
    const port = (later.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/elections/display-text?electionId=${e.idHex}`);
    await new Promise((res) => later.close(res));
    expect(r.status).toBe(451);
  });

  test("refuses an election ID in any spelling but lowercase hex", async () => {
    const e = await withText();
    for (const electionId of [e.idHex.toUpperCase(), `0x${e.idHex}`, e.idHex.slice(2)])
      expect((await text(electionId)).status).toBe(400);
  });
});

describe("CORS for the ballot client", () => {
  const client = "https://ballot.example";
  let cors: Server;
  let corsBase: string;
  const corsLogs: unknown[] = [];
  beforeAll(async () => {
    cors = createApiServer({
      sql: app,
      log: (l) => corsLogs.push(l),
      corsOrigins: [client, "http://localhost:4173"],
    });
    await new Promise<void>((r) => cors.listen(0, "127.0.0.1", r));
    corsBase = `http://127.0.0.1:${(cors.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => cors?.close(r)));

  const preflight = (path: string, origin: string, method: string, headers?: string) =>
    fetch(`${corsBase}${path}`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": method,
        ...(headers !== undefined && { "access-control-request-headers": headers }),
      },
    });

  test("a listed origin may read answers and refusals, and nothing allows credentials", async () => {
    const e = await election();
    const read = await fetch(`${corsBase}/elections/definition?electionId=${e.idHex}`, {
      headers: { origin: client },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBe(client);
    expect(read.headers.get("vary")).toBe("origin");
    expect(read.headers.get("access-control-allow-credentials")).toBeNull();
    const refused = await fetch(`${corsBase}/nope`, { headers: { origin: client } });
    expect(refused.status).toBe(404);
    expect(refused.headers.get("access-control-allow-origin")).toBe(client);
    const local = await fetch(`${corsBase}/elections/definition?electionId=${e.idHex}`, {
      headers: { origin: "http://localhost:4173" },
    });
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:4173");
  });

  test("any other origin gets no allow header, and a server with no list sends no CORS header", async () => {
    const e = await election();
    for (const origin of [
      "https://ballot.example.evil",
      "https://evil.example",
      "http://ballot.example",
      "https://ballot.example:443",
      "null",
    ]) {
      const r = await fetch(`${corsBase}/elections/definition?electionId=${e.idHex}`, {
        headers: { origin },
      });
      expect([origin, r.headers.get("access-control-allow-origin")]).toEqual([origin, null]);
      expect((await preflight("/ballots", origin, "POST", "content-type")).status).toBe(403);
    }
    const plain = await fetch(`${base}/elections/definition?electionId=${e.idHex}`, {
      headers: { origin: client },
    });
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();
    expect(plain.headers.get("vary")).toBeNull();
    expect(
      (await fetch(`${base}/ballots`, { method: "OPTIONS", headers: { origin: client } })).status,
    ).toBe(403);
  });

  test("a preflight allows the procedure's own method and no request header but content-type", async () => {
    const ok = await preflight("/ballots", client, "POST", "Content-Type");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(client);
    expect(ok.headers.get("access-control-allow-methods")).toBe("POST");
    expect(ok.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    const get = await preflight("/elections/display-text", client, "GET");
    expect(get.status).toBe(204);
    expect(get.headers.get("access-control-allow-methods")).toBe("GET");
    expect(get.headers.get("access-control-allow-headers")).toBeNull();
    for (const [path, method, headers] of [
      ["/ballots", "GET", undefined],
      ["/ballots", "PUT", "content-type"],
      ["/elections/definition", "POST", "content-type"],
      ["/ballots", "POST", "content-type, authorization"],
      ["/ballots", "POST", "x-session"],
    ] as const)
      expect([
        path,
        method,
        headers,
        (await preflight(path, client, method, headers)).status,
      ]).toEqual([path, method, headers, 403]);
    expect((await preflight("/nope", client, "GET")).status).toBe(404);
    expect((await preflight("/ballots", client, "POST", "content-type, CONTENT-TYPE")).status).toBe(
      204,
    );
  });

  test("a preflight with a body is refused", async () => {
    const r = await fetch(`${corsBase}/ballots`, {
      method: "OPTIONS",
      headers: { origin: client, "access-control-request-method": "POST" },
      body: "{}",
    });
    expect(r.status).toBe(400);
  });

  test("a preflight is logged under its route from the fixed list", async () => {
    corsLogs.length = 0;
    await preflight("/ballots", client, "POST", "content-type");
    await preflight("/nope", client, "GET");
    await new Promise((r) => setTimeout(r, 50));
    expect(corsLogs).toEqual([
      expect.objectContaining({ method: "OPTIONS", route: "OPTIONS /ballots", status: 204 }),
      expect.objectContaining({ method: "OPTIONS", route: "unmatched", status: 404 }),
    ]);
    expect(JSON.stringify(corsLogs)).not.toContain("ballot.example");
  });

  test("a CORS origin that isn't an exact https or loopback http origin is refused at start", () => {
    for (const origin of [
      "https://ballot.example/",
      "https://ballot.example/path",
      "http://ballot.example",
      "https://ballot.example:443",
      "*",
      "",
      "HTTPS://ballot.example",
    ])
      expect(
        () => createApiServer({ sql: app, log: () => {}, corsOrigins: [origin] }),
        origin,
      ).toThrow(RangeError);
  });
});

describe("elections.list (T-68)", () => {
  /** Every listed election, `limit` at a time, kept to `mine`. */
  async function listed(mine: string[], limit = "256") {
    const all: string[] = [];
    let after: string | undefined;
    for (;;) {
      const r = await get("/elections", after === undefined ? { limit } : { after, limit });
      expect(r.status).toBe(200);
      const page = (await json(r))["elections"] as string[];
      all.push(...page);
      if (page.length < Number(limit)) return all.filter((id) => mine.includes(id));
      after = page.at(-1);
    }
  }

  test("pages through the stored polls in order of election ID", async () => {
    const mine: string[] = [];
    for (let i = 0; i < 5; i++) mine.push((await election()).idHex);
    expect(await listed(mine)).toEqual([...mine].sort());
    expect(await listed(mine, "2")).toEqual([...mine].sort());
  });

  test("leaves out delisted and hidden polls, which stay served by ID", async () => {
    const [shown, delisted, hidden] = [await election(), await election(), await election()];
    await moderate(app, delisted.id, { action: "delist", reason: "spam", moderator: "mod-1" });
    await moderate(app, hidden.id, { action: "hide", reason: "illegal", moderator: "mod-1" });
    expect(await listed([shown.idHex, delisted.idHex, hidden.idHex])).toEqual([shown.idHex]);
    for (const e of [delisted, hidden])
      expect((await get("/elections/definition", { electionId: e.idHex })).status).toBe(200);
    await moderate(app, hidden.id, { action: "restore", reason: "error", moderator: "mod-2" });
    expect(await listed([shown.idHex, delisted.idHex, hidden.idHex])).toEqual(
      [shown.idHex, hidden.idHex].sort(),
    );
  });

  test("refuses cursors and page sizes outside their bounds, and extra fields", async () => {
    const e = await election();
    for (const query of [
      {},
      { limit: "0" },
      { limit: "257" },
      { limit: "01" },
      { after: e.idHex.toUpperCase(), limit: "1" },
      { after: e.idHex.slice(2), limit: "1" },
      { after: "", limit: "1" },
      { limit: "1", state: "hidden" },
    ])
      expect((await get("/elections", query)).status, JSON.stringify(query)).toBe(400);
    const r = await get("/elections", { after: "ff".repeat(32), limit: "1" });
    expect(await json(r)).toEqual({ elections: [] });
  });

  test("pages back by before, in the same order, through the stored polls (P2-19 part 49)", async () => {
    const mine: string[] = [];
    for (let i = 0; i < 5; i++) mine.push((await election()).idHex);
    const forward = await listed(mine);
    for (const limit of ["1", "2", "256"]) {
      const pages: string[][] = [];
      let before = "ff".repeat(32);
      for (;;) {
        const r = await get("/elections", { before, limit });
        expect(r.status).toBe(200);
        const page = (await json(r))["elections"] as string[];
        pages.unshift(page);
        if (page.length < Number(limit)) break;
        before = page[0]!; // a full page holds at least one poll
      }
      expect(pages.flat().filter((id) => mine.includes(id))).toEqual(forward);
    }
    expect(await json(await get("/elections", { before: "00".repeat(32), limit: "1" }))).toEqual({
      elections: [],
    });
  });

  test("takes before only alone, under the id order", async () => {
    const before = "ff".repeat(32);
    expect((await get("/elections", { before, sort: "id", limit: "1" })).status).toBe(200);
    for (const query of [
      { before, after: "00".repeat(32), limit: "1" },
      { before, sort: "new", limit: "1" },
      { before, sort: "closing", limit: "1" },
      { before, sort: "answered", limit: "1" },
      { before: before.toUpperCase(), limit: "1" },
      { before: "", limit: "1" },
    ])
      expect((await get("/elections", query)).status, JSON.stringify(query)).toBe(400);
  });

  describe("new and closing (P2-23)", () => {
    // Registration positions in L2 block 0, before every later test's in
    // this file, which start at block 1: the table takes them in chain order.
    let logIndex = 0;
    const nowS = () => BigInt(Math.floor(Date.now() / 1000));

    /** A poll open now for `seconds` more, its registration recorded at the next position. */
    async function open(seconds: bigint) {
      const id = b32();
      const definition = encodeElectionDefinition({
        ...typical,
        election_id: id,
        opens_at: nowS() - 60n,
        closes_at: nowS() + seconds,
      });
      const { definitionHash } = await storeDefinition(app, definition);
      await recordRegistration(app, {
        electionId: id,
        definitionHash,
        l2Block: 0n,
        logIndex: logIndex++,
      });
      return hex(id);
    }

    async function sorted(sort: string, mine: string[], limit: string) {
      const all: string[] = [];
      let after: string | undefined;
      for (;;) {
        const query = after === undefined ? { sort, limit } : { sort, after, limit };
        const r = await get("/elections", query);
        expect(r.status).toBe(200);
        const page = (await json(r))["elections"] as string[];
        all.push(...page);
        if (page.length < Number(limit)) return all.filter((id) => mine.includes(id));
        after = page.at(-1);
      }
    }

    test("list the polls open by the server's clock, newest or soonest closing first", async () => {
      const closed = (await election()).idHex;
      const [a, b, c] = [await open(3_000n), await open(1_000n), await open(2_000n)];
      const mine = [a, b, c, closed];
      for (const limit of ["1", "256"]) {
        expect(await sorted("new", mine, limit)).toEqual([c, b, a]);
        expect(await sorted("closing", mine, limit)).toEqual([b, c, a]);
      }
      expect(await listed(mine)).toEqual([...mine].sort());
    });

    test("count the listed polls, those open by the server's clock and those not open yet", async () => {
      const counts = async () => {
        const r = await get("/elections/counts", {});
        expect(r.status).toBe(200);
        return Object.fromEntries(
          Object.entries(await json(r)).map(([k, v]) => [k, BigInt(v as string)]),
        );
      };
      const was = await counts();
      expect(Object.keys(was).sort()).toEqual(["listed", "open", "scheduled"]);
      await election();
      await open(1_000n);
      const soon = b32();
      await storeDefinition(
        app,
        encodeElectionDefinition({
          ...typical,
          election_id: soon,
          opens_at: nowS() + 3_600n,
          closes_at: nowS() + 7_200n,
        }),
      );
      const hidden = await open(1_000n);
      await moderate(app, new Uint8Array(Buffer.from(hidden, "hex")), {
        action: "hide",
        reason: "threat",
        moderator: "mod-1",
      });
      const now = await counts();
      expect(now["listed"]! - was["listed"]!).toBe(3n);
      expect(now["open"]! - was["open"]!).toBe(1n);
      expect(now["scheduled"]! - was["scheduled"]!).toBe(1n);
      expect((await get("/elections/counts", { limit: "1" })).status).toBe(400);
    });

    test("refuse an unknown sort, and a cursor the order can't place", async () => {
      expect((await get("/elections", { sort: "popular", limit: "1" })).status).toBe(400);
      const unregistered = (await election()).idHex;
      for (const [sort, after] of [
        ["new", "ff".repeat(32)],
        ["closing", "ff".repeat(32)],
        ["new", unregistered],
      ] as const) {
        const r = await get("/elections", { sort, after, limit: "1" });
        expect(r.status).toBe(400);
        expect((await json(r))["code"]).toBe("CURSOR_NOT_FOUND");
      }
    });
  });

  describe("answered (P2-23)", () => {
    // A server of its own, with the boards' anchoring clock and a fixed
    // clock far from every other test's polls.
    const clock = { epoch: 0n, period: 3600n };
    const now = 7_000_000_000n;
    const segment = now / clock.period - 1n;
    let ranked: Server;
    let rankedBase: string;
    beforeAll(async () => {
      ranked = createApiServer({ sql: app, log: () => {}, now: () => now, boardClock: clock });
      await new Promise<void>((r) => ranked.listen(0, "127.0.0.1", r));
      rankedBase = `http://127.0.0.1:${(ranked.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise((r) => ranked?.close(r)));

    /** A poll open at `now` with `voters` distinct voters boarded last period, one re-voting. */
    async function answeredBy(voters: number) {
      const id = b32();
      await storeDefinition(
        app,
        encodeElectionDefinition({
          ...typical,
          election_id: id,
          opens_at: now - 60n,
          closes_at: now + 60n,
        }),
      );
      const nullifiers = Array.from({ length: voters }, (_, v) => BigInt(v + 1));
      for (const nullifier of voters > 0 ? [...nullifiers, 1n] : [])
        await appendEntry(app, id, Number(segment), Uint8Array.of(0, 2, 1, ...randomBytes(8)), {
          ballot: { tier: 0, nullifier, message: b32(), ballotHash: b32() },
        });
      return hex(id);
    }

    test("lists the polls open now by voters this week, a page at a time", async () => {
      const [one, three, none] = [await answeredBy(1), await answeredBy(3), await answeredBy(0)];
      const mine = [one, three, none];
      for (const limit of ["1", "256"]) {
        const all: string[] = [];
        let after: string | undefined;
        for (;;) {
          const query = { sort: "answered", limit, ...(after !== undefined && { after }) };
          const r = await fetch(`${rankedBase}/elections?${new URLSearchParams(query).toString()}`);
          expect(r.status).toBe(200);
          const page = (await json(r))["elections"] as string[];
          all.push(...page);
          if (page.length < Number(limit)) break;
          after = page.at(-1);
        }
        expect(all.filter((id) => mine.includes(id))).toEqual([three, one, none]);
      }
    });

    test("is SORT_UNAVAILABLE without the anchoring clock, and refuses a cursor it can't place", async () => {
      const r = await get("/elections", { sort: "answered", limit: "1" });
      expect(r.status).toBe(503);
      expect((await json(r))["code"]).toBe("SORT_UNAVAILABLE");
      const stray = await fetch(
        `${rankedBase}/elections?${new URLSearchParams({ sort: "answered", after: "ff".repeat(32), limit: "1" }).toString()}`,
      );
      expect(stray.status).toBe(400);
      expect((await json(stray))["code"]).toBe("CURSOR_NOT_FOUND");
    });

    test("a malformed clock is refused at start", () => {
      for (const boardClock of [
        { epoch: 0n, period: 0n },
        { epoch: -1n, period: 1n },
      ])
        expect(() => createApiServer({ sql: app, log: () => {}, boardClock })).toThrow(TypeError);
    });
  });

  describe("search (P2-23 part 4)", () => {
    /** A stored poll asking `question` in English, its display text stored. */
    async function asking(question: string) {
      const id = b32();
      const text: DisplayText = {
        salt: b32(),
        translations: [
          {
            language: utf8("en"),
            question: utf8(question),
            description: new Uint8Array(0),
            options: ["Yes", "No", "Abstain"].map((l) => ({
              label: utf8(l),
              description: new Uint8Array(0),
            })),
          },
        ],
      };
      await storeDefinition(
        app,
        encodeElectionDefinition({
          ...typical,
          election_id: id,
          display_text_commitment: displayTextCommitment(text),
        }),
      );
      await storeDisplayText(app, id, encodeDisplayText(text));
      return hex(id);
    }

    /** Every poll matching `q`, a page of `limit` at a time. */
    async function found(q: string, limit = "256", sort = "id") {
      const all: string[] = [];
      let after: string | undefined;
      for (;;) {
        const r = await get("/elections", {
          q,
          limit,
          sort,
          ...(after !== undefined && { after }),
        });
        expect(r.status).toBe(200);
        const page = (await json(r))["elections"] as string[];
        all.push(...page);
        if (page.length < Number(limit)) return all;
        after = page.at(-1);
      }
    }

    test("the contract's bounds are core's", () => {
      expect([MAX_SEARCH_QUERY, MAX_SEARCH_TERMS]).toEqual([
        CORE_MAX_SEARCH_QUERY,
        CORE_MAX_SEARCH_TERMS,
      ]);
    });

    test("lists only the polls whose question holds every term, in the order asked, a page at a time", async () => {
      const [ferry, ferries, bridge] = [
        await asking("Should the Harbourline ferry run at night?"),
        await asking("More HARBOURLINE ferries on weekends?"),
        await asking("A new Harbourline bridge?"),
      ];
      const hidden = await asking("Harbourline ferry fares?");
      await moderate(app, unhex(hidden), { action: "hide", reason: "illegal", moderator: "mod-1" });
      for (const limit of ["1", "256"]) {
        expect(await found("harbourline", limit)).toEqual([ferry, ferries, bridge].sort());
        expect(await found("Harbourline FERR", limit)).toEqual([ferry, ferries].sort());
        expect(await found("harbourline night", limit)).toEqual([ferry]);
        expect(await found("harbourline tunnel", limit)).toEqual([]);
      }
      // A filter on the other orders too: these polls closed in January 2026.
      expect(await found("harbourline", "256", "closing")).toEqual([]);
    });

    test("refuses an empty query, too many terms and too many characters", async () => {
      const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
      for (const q of ["", "  ", words(MAX_SEARCH_TERMS + 1), "a".repeat(MAX_SEARCH_QUERY + 1)])
        expect((await get("/elections", { q, limit: "1" })).status, q).toBe(400);
      for (const q of [words(MAX_SEARCH_TERMS), "a".repeat(MAX_SEARCH_QUERY), " a "])
        expect((await get("/elections", { q, limit: "1" })).status, q).toBe(200);
    });

    test("the contract admits exactly the queries core reads, and those blank once normalised", () => {
      const input = contract.elections.list["~orpc"].inputSchema!;
      const admits = (q: string) => {
        const result = input["~standard"].validate({ limit: "1", q });
        if (result instanceof Promise) throw new Error("the contract validates synchronously");
        return result.issues === undefined;
      };
      const piece = fc.oneof(
        fc.string({ unit: "binary", maxLength: 6 }),
        fc.constantFrom(" ", "\t", "\n", "\u3000", "\u00a0", "\u2028", "\ufeff", "\u180e"),
        fc.constantFrom("\u0085", "\u0001", "\u009f"),
      );
      fc.assert(
        fc.property(fc.array(piece, { maxLength: 60 }), (pieces) => {
          const q = pieces.join("");
          let read: "terms" | "blank" | "refused" = "terms";
          try {
            searchTerms(q);
          } catch (e) {
            read = e instanceof SearchQueryError ? "blank" : "refused";
          }
          expect(admits(q), JSON.stringify(q)).toBe(read !== "refused");
        }),
        { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) },
      );
    });

    test("a query blank once normalised is refused, quoting nothing", async () => {
      for (const q of ["\u0085", "\u0001 \u009f"]) {
        const r = await get("/elections", { q, limit: "1" });
        expect(r.status, JSON.stringify(q)).toBe(400);
        expect(JSON.stringify(await json(r))).not.toContain(q);
      }
      // A blank term beside a real one is dropped.
      expect(searchTerms("park \u0085")).toEqual(["park"]);
    });

    test("the query is never logged", async () => {
      const secret = `unusualword${hex(b32()).slice(0, 12)}`;
      logs.length = 0;
      await get("/elections", { q: secret, limit: "1" });
      await get("/elections", { q: `${secret} ${"x ".repeat(20)}`, limit: "1" });
      await new Promise((r) => setTimeout(r, 50));
      expect(logs).toHaveLength(2);
      expect(JSON.stringify(logs)).not.toContain(secret);
    });
  });

  describe("topic and place (P2-26 part 1c; ADR 0041)", () => {
    /** Every poll listed with `filter`, a page of `limit` at a time. */
    async function filed(filter: Record<string, string>, limit = "256") {
      const all: string[] = [];
      let after: string | undefined;
      for (;;) {
        const r = await get("/elections", {
          ...filter,
          limit,
          ...(after !== undefined && { after }),
        });
        expect(r.status).toBe(200);
        const page = (await json(r))["elections"] as string[];
        all.push(...page);
        if (page.length < Number(limit)) return all;
        after = page.at(-1);
      }
    }

    test("the contract's topics and place bound are core's", () => {
      expect([[...POLL_TOPICS], MAX_PLACE_LENGTH, MAX_LISTED_PLACES]).toEqual([
        [...CORE_POLL_TOPICS],
        CORE_MAX_PLACE_LENGTH,
        CORE_MAX_LISTED_PLACES,
      ]);
    });

    test("lists the polls under a topic or at a place, matched whole after normalising, a page at a time", async () => {
      const town = `Brook ${hex(b32()).slice(0, 8)}`;
      const at = await election();
      const atAndSport = await election();
      const elsewhere = await election();
      await insertPollTags(app, at.id, { place: town });
      await insertPollTags(app, atAndSport.id, { topic: "sport", place: town });
      await insertPollTags(app, elsewhere.id, { topic: "sport", place: `${town} East` });
      const ids = (...xs: { id: Uint8Array }[]) => xs.map((x) => hex(x.id)).sort();
      for (const limit of ["1", "256"]) {
        expect(await filed({ place: ` ${town.toUpperCase()}  ` }, limit)).toEqual(
          ids(at, atAndSport),
        );
        expect(await filed({ place: town, topic: "sport" }, limit)).toEqual(ids(atAndSport));
        expect(await filed({ place: `${town} east` }, limit)).toEqual(ids(elsewhere));
      }
      const sport = await filed({ topic: "sport" });
      for (const x of [atAndSport, elsewhere]) expect(sport).toContain(hex(x.id));
      expect(sport).not.toContain(hex(at.id));
      await moderate(app, atAndSport.id, { action: "delist", reason: "spam", moderator: "mod-1" });
      expect(await filed({ place: town })).toEqual(ids(at));
    });

    test("refuses an unknown topic, an empty or overlong place, and one blank once normalised, quoting nothing", async () => {
      for (const filter of [
        { topic: "weather" },
        { topic: "Sport" },
        { place: "" },
        { place: "a".repeat(MAX_PLACE_LENGTH + 1) },
        { place: "  " },
        { place: "\u0085" },
      ]) {
        const r = await get("/elections", { ...filter, limit: "1" });
        expect(r.status, JSON.stringify(filter)).toBe(400);
      }
      const r = await get("/elections", { place: "\u0001\u009f", limit: "1" });
      expect(r.status).toBe(400);
      expect(JSON.stringify(await json(r))).not.toContain("\u0001");
      for (const filter of [{ topic: "transport" }, { place: "a".repeat(MAX_PLACE_LENGTH) }])
        expect((await get("/elections", { ...filter, limit: "1" })).status).toBe(200);
    });

    test("a poll's tags are served as it is filed, withheld while it is hidden", async () => {
      const tags = (e: { idHex: string }) => get("/elections/tags", { electionId: e.idHex });
      const tagged = await election();
      await insertPollTags(app, tagged.id, { topic: "housing", place: "東京 Ward 2" });
      let r = await tags(tagged);
      expect(r.status).toBe(200);
      expect(await json(r)).toEqual({ topic: "housing", place: "東京 Ward 2" });
      expect(await json(await tags(await election()))).toEqual({});
      await refilePoll(app, tagged.id, {
        tags: { topic: "transport" },
        reason: "personal-data",
        moderator: "mod-1",
      });
      expect(await json(await tags(tagged))).toEqual({ topic: "transport" });
      await moderate(app, tagged.id, { action: "delist", reason: "spam", moderator: "mod-1" });
      expect(await json(await tags(tagged))).toEqual({ topic: "transport" });
      await moderate(app, tagged.id, { action: "hide", reason: "threat", moderator: "mod-1" });
      r = await tags(tagged);
      expect(r.status).toBe(451);
      expect(await json(r)).toEqual(expect.objectContaining({ code: "TAGS_WITHHELD" }));
      r = await get("/elections/tags", { electionId: hex(b32()) });
      expect(r.status).toBe(404);
      expect((await json(r))["code"]).toBe("ELECTION_NOT_FOUND");
      expect((await get("/elections/tags", { electionId: "00" })).status).toBe(400);
    });

    test("suggests the places of listed polls only, each once in its commonest spelling", async () => {
      const places = async () => {
        const r = await get("/elections/places", {});
        expect(r.status).toBe(200);
        return (await json(r))["places"] as string[];
      };
      const town = `Mill ${hex(b32()).slice(0, 8)}`;
      const hidden = `Mill ${hex(b32()).slice(0, 8)}`;
      // The commonest spelling is the last by code point, not the first.
      for (const place of [town.toUpperCase(), town, town.toLowerCase(), town.toLowerCase()])
        await insertPollTags(app, (await election()).id, { place });
      const h = await election();
      await insertPollTags(app, h.id, { place: hidden });
      expect(await places()).toEqual(expect.arrayContaining([town.toLowerCase(), hidden]));
      await moderate(app, h.id, { action: "hide", reason: "threat", moderator: "mod-1" });
      const now = await places();
      expect(now.filter((p) => p.toLowerCase() === town.toLowerCase())).toEqual([
        town.toLowerCase(),
      ]);
      expect(now).not.toContain(hidden);
      expect((await get("/elections/places", { limit: "1" })).status).toBe(400);
    });

    test("a place as long as a draft may hold is served", async () => {
      const e = await election();
      const place = "𝔄".repeat(MAX_PLACE_LENGTH);
      await insertPollTags(app, e.id, { place });
      expect(await json(await get("/elections/tags", { electionId: e.idHex }))).toEqual({ place });
    });

    test("the place is never logged", async () => {
      const secret = `Unusualplace ${hex(b32()).slice(0, 12)}`;
      logs.length = 0;
      await get("/elections", { place: secret, limit: "1" });
      await new Promise((r) => setTimeout(r, 50));
      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain(secret.split(" ")[1]);
    });
  });
});

describe("elections.getAnswered (P2-23 part 2c; T-01, T-68)", () => {
  test("a poll's voters are counted tier by tier, a re-vote once, and never withheld", async () => {
    const answered = (e: { idHex: string }) => get("/elections/answered", { electionId: e.idHex });
    const e = await election();
    expect(await json(await answered(e))).toEqual({ tiers: [] });
    const cast = (tier: number, nullifier: bigint) =>
      appendEntry(app, e.id, 0, Uint8Array.of(0, 2, 1, ...randomBytes(8)), {
        ballot: { tier, nullifier, message: b32(), ballotHash: b32() },
      });
    for (const [tier, nullifier] of [
      [2, 5n],
      [0, 1n],
      [0, 2n],
      [0, 1n],
    ] as const)
      await cast(tier, nullifier);
    const counted = {
      tiers: [
        { tier: 0, answered: "2" },
        { tier: 2, answered: "1" },
      ],
    };
    const r = await answered(e);
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual(counted);
    await moderate(app, e.id, { action: "hide", reason: "threat", moderator: "mod-1" });
    expect(await json(await answered(e))).toEqual(counted);
    const unknown = await get("/elections/answered", { electionId: hex(b32()) });
    expect(unknown.status).toBe(404);
    expect((await json(unknown))["code"]).toBe("ELECTION_NOT_FOUND");
    expect((await get("/elections/answered", { electionId: "00" })).status).toBe(400);
  });
});

describe("elections.getAnsweredMany (P2-19 part 58; T-01, T-52)", () => {
  test("serves each known poll's counts in the asked order, as the one-poll route does", async () => {
    const [a, b] = [await election(), await election()];
    const cast = (e: { id: Uint8Array }, tier: number, nullifier: bigint) =>
      appendEntry(app, e.id, 0, Uint8Array.of(0, 2, 1, ...randomBytes(8)), {
        ballot: { tier, nullifier, message: b32(), ballotHash: b32() },
      });
    await cast(a, 0, 1n);
    await cast(a, 0, 1n);
    await cast(a, 1, 1n);
    await cast(b, 2, 4n);
    const unknown = hex(b32());
    const r = await post("/elections/answered", { electionIds: [b.idHex, unknown, a.idHex] });
    expect(r.status).toBe(200);
    const one = async (e: { idHex: string }) =>
      (await json(await get("/elections/answered", { electionId: e.idHex })))["tiers"];
    expect(await json(r)).toEqual({
      elections: [
        { electionId: b.idHex, tiers: await one(b) },
        { electionId: a.idHex, tiers: await one(a) },
      ],
    });
    expect(await one(a)).toEqual([
      { tier: 0, answered: "1" },
      { tier: 1, answered: "1" },
    ]);
  });

  test("refuses an empty, repeated, oversized or malformed list, and the bound is core's", async () => {
    expect(MAX_ANSWERED_ELECTIONS).toBe(CORE_MAX_ANSWERED_ELECTIONS);
    const id = hex(b32());
    for (const electionIds of [
      [],
      [id, id],
      ["00"],
      Array.from({ length: MAX_ANSWERED_ELECTIONS + 1 }, () => hex(b32())),
    ])
      expect((await post("/elections/answered", { electionIds })).status).toBe(400);
    const most = Array.from({ length: MAX_ANSWERED_ELECTIONS }, () => hex(b32()));
    expect(await json(await post("/elections/answered", { electionIds: most }))).toEqual({
      elections: [],
    });
  });
});

describe("elections.resolveCode and elections.getCode (P2-18; T-49, T-53, T-67)", () => {
  /** Registration positions in increasing order, as the indexer records them. */
  let block = 1n;

  /** A stored election whose registration is recorded, with its definition hash's code. */
  async function registered() {
    const e = await election();
    const { definitionHash } = await storeDefinition(app, e.definition);
    await recordRegistration(app, {
      electionId: e.id,
      definitionHash,
      l2Block: block++,
      logIndex: 0,
    });
    return { ...e, definitionHash, code: shortCode(definitionHash) };
  }

  const resolve = (code: string) => get("/elections/by-code", { code });
  const codeOf = (electionId: string) => get("/elections/code", { electionId });

  test("the contract's longest code is core's", () => {
    expect(MAX_SHORT_CODE_LENGTH).toBe(CORE_MAX_SHORT_CODE_LENGTH);
  });

  test("resolves a poll's code in any forgiven form to its election and canonical code", async () => {
    const e = await registered();
    const forms = [
      e.code,
      e.code.toUpperCase(),
      e.code.replaceAll("0", "o").replaceAll("1", "l"),
      e.code.replaceAll("1", "I").replaceAll("0", "O"),
    ];
    for (const code of forms) {
      const r = await resolve(code);
      expect(r.status).toBe(200);
      expect(await json(r)).toEqual({ electionId: e.idHex, code: e.code });
    }
    expect(await json(await codeOf(e.idHex))).toEqual({ code: e.code });
  });

  test("a later poll ground to an earlier poll's prefix never takes its code", async () => {
    const first = await registered();
    // A registered definition this server didn't store (one it refused, say)
    // with the same first 255 bits.
    const ground = b32();
    const collided = first.definitionHash.slice();
    collided[31] = (collided[31] ?? 0) ^ 1;
    await recordRegistration(app, {
      electionId: ground,
      definitionHash: collided,
      l2Block: block++,
      logIndex: 0,
    });
    expect(await json(await resolve(first.code))).toEqual({
      electionId: first.idHex,
      code: first.code,
    });
    expect((await resolve(shortCode(collided, 8))).status).toBe(404);
    const full = shortCode(collided, MAX_SHORT_CODE_LENGTH);
    expect(await json(await resolve(full))).toEqual({ electionId: hex(ground), code: full });
    // Each poll's own code is the one that resolves to it.
    expect(await json(await codeOf(first.idHex))).toEqual({ code: first.code });
    expect(await json(await codeOf(hex(ground)))).toEqual({ code: full });
  });

  test("delisted and hidden polls resolve as they do by ID", async () => {
    const delisted = await registered();
    const hidden = await registered();
    await moderate(app, delisted.id, { action: "delist", reason: "spam", moderator: "mod-1" });
    await moderate(app, hidden.id, { action: "hide", reason: "illegal", moderator: "mod-1" });
    for (const e of [delisted, hidden]) {
      expect(await json(await resolve(e.code))).toEqual({ electionId: e.idHex, code: e.code });
      expect(await json(await codeOf(e.idHex))).toEqual({ code: e.code });
    }
  });

  test("an election with no recorded registration has no code, stored or not", async () => {
    const unregistered = await election();
    await storeDefinition(app, unregistered.definition);
    for (const id of [unregistered.idHex, hex(b32())]) {
      const r = await codeOf(id);
      expect(r.status).toBe(404);
      expect((await json(r))["code"]).toBe("CODE_NOT_FOUND");
    }
    // Not an election ID at all.
    for (const id of ["00".repeat(31), "AB".repeat(32), ""])
      expect((await codeOf(id)).status).toBe(400);
  });

  test("unknown codes, unregistered polls and malformed input are CODE_NOT_FOUND, never quoted", async () => {
    const unregistered = await election();
    const { definitionHash } = await storeDefinition(app, unregistered.definition);
    const inputs = [
      shortCode(definitionHash),
      "zzzzzzz",
      "zuzzzzz",
      "abc",
      "abc-def",
      "0".repeat(MAX_SHORT_CODE_LENGTH + 1),
      `${"0".repeat(51)}1`,
      "",
    ];
    for (const code of inputs) {
      const r = await resolve(code);
      expect(r.status).toBe(404);
      const body = await r.text();
      expect(JSON.parse(body)["code"]).toBe("CODE_NOT_FOUND");
      if (code.length > 0) expect(body).not.toContain(code);
    }
  });

  test("input past the transport bound is BAD_REQUEST, never quoted", async () => {
    const code = "q".repeat(65);
    const r = await resolve(code);
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain("qqqqqqq");
  });

  test("the request log records the route and never the code", async () => {
    const e = await registered();
    logs.length = 0;
    await resolve(e.code.toUpperCase());
    await resolve("zuzzzzz");
    await codeOf(e.idHex);
    await new Promise((r) => setTimeout(r, 50));
    expect(logs).toEqual([
      expect.objectContaining({ route: "GET /elections/by-code", status: 200 }),
      expect.objectContaining({ route: "GET /elections/by-code", status: 404 }),
      expect.objectContaining({ route: "GET /elections/code", status: 200 }),
    ]);
    const text = JSON.stringify(logs).toLowerCase();
    for (const value of [e.code, e.idHex, "zuzzzzz"]) expect(text).not.toContain(value);
  });
});

describe("board", () => {
  test("an empty board's head is size 0 with zeros", async () => {
    const e = await election();
    const r = await get("/board/head", { electionId: e.idHex });
    expect(await json(r)).toEqual({
      treeSize: "0",
      chainHead: "00".repeat(32),
      root: "00".repeat(32),
    });
  });

  test("the head is the size, chain head and root the verifier recomputes", async () => {
    const e = await election(5);
    const r = await get("/board/head", { electionId: e.idHex });
    expect(await json(r)).toEqual({
      treeSize: "5",
      chainHead: hex(e.checked.links.at(-1)!),
      root: hex(e.root(5)),
    });
  });

  test("board procedures need an election this server holds", async () => {
    const id = b32();
    // A board starts only once its definition is stored.
    await expect(appendEntry(app, id, 0, Uint8Array.of(0, 2, 1, 0))).rejects.toThrow(
      /no-definition/,
    );
    for (const [path, extra] of [
      ["/board/head", {}],
      ["/board/entries", { start: "0", limit: "1" }],
      ["/board/checkpoints", { limit: "1" }],
      ["/board/proofs/inclusion", { index: "0", treeSize: "1" }],
      ["/board/proofs/consistency", { firstSize: "1", secondSize: "1" }],
    ] as const) {
      const r = await get(path, { electionId: hex(id), ...extra });
      expect(r.status, path).toBe(404);
      expect((await json(r))["code"], path).toBe("ELECTION_NOT_FOUND");
    }
  });

  test("pages read in turn are the board, and checkBoard accepts them", async () => {
    const e = await election(7);
    const entries: string[] = [];
    for (let start = 0; ;) {
      const page = (await json(
        await get("/board/entries", { electionId: e.idHex, start: String(start), limit: "3" }),
      )) as { entries: string[] };
      if (page.entries.length === 0) break;
      entries.push(...page.entries);
      start += page.entries.length;
    }
    expect(entries).toHaveLength(7);
    expect(checkBoard(e.id, entries.map(unhex), UNPINNED).links).toEqual(e.checked.links);
  });

  test("a start beyond the board is OUT_OF_RANGE; a limit over 256 is refused", async () => {
    const e = await election(2);
    const r = await get("/board/entries", { electionId: e.idHex, start: "3", limit: "1" });
    expect(r.status).toBe(416);
    expect((await json(r))["code"]).toBe("OUT_OF_RANGE");
    const big = await get("/board/entries", { electionId: e.idHex, start: "0", limit: "257" });
    expect(big.status).toBe(400);
  });

  test("a page holds at most MAX_PAGE_BYTES of entries", async () => {
    const e = await election(9, 1_000_000);
    const page = (await json(
      await get("/board/entries", { electionId: e.idHex, start: "0", limit: "256" }),
    )) as { entries: string[] };
    expect(page.entries).toHaveLength(8);
  });

  test("checkpoints are the verifier's own, the latest first, paged by before (P2-19)", async () => {
    // Two entries a segment: segments 0 to 3.
    const e = await election(8);
    const none = (await json(
      await get("/board/checkpoints", { electionId: e.idHex, limit: "5" }),
    )) as { checkpoints: string[] };
    expect(none.checkpoints).toEqual([]);
    await takeCheckpoints(app, e.id, 3);
    const page = async (q: Record<string, string>) =>
      (
        (await json(await get("/board/checkpoints", { electionId: e.idHex, ...q }))) as {
          checkpoints: string[];
        }
      ).checkpoints.map((c) => decodeCheckpoint(unhex(c)));
    const all = await page({ limit: "256" });
    expect(all.map((c) => c.segment)).toEqual([3, 2, 1, 0]);
    for (const c of all) expect(c).toEqual(checkpointOf(e.checked, c.segment));
    expect(await page({ limit: "2" })).toEqual(all.slice(0, 2));
    expect(await page({ limit: "2", before: "2" })).toEqual(all.slice(2));
    expect(await page({ limit: "2", before: "0" })).toEqual([]);
    expect(await page({ limit: "2", before: "18446744073709551615" })).toEqual(all.slice(0, 2));
  });

  test("checkpoints: a limit over 256 or a before that isn't a canonical u64 is refused", async () => {
    const e = await election(1);
    for (const q of [{ limit: "257" }, { limit: "1", before: "01" }, { limit: "1", before: "-1" }])
      expect((await get("/board/checkpoints", { electionId: e.idHex, ...q })).status).toBe(400);
  });

  test("every inclusion and consistency proof verifies", async () => {
    const n = 6;
    const e = await election(n);
    for (let size = 1; size <= n; size++) {
      for (let i = 0; i < size; i++) {
        const { path } = (await json(
          await get("/board/proofs/inclusion", {
            electionId: e.idHex,
            index: String(i),
            treeSize: String(size),
          }),
        )) as { path: string[] };
        expect(
          verifyInclusion(
            BOARD_TREE,
            BigInt(i),
            BigInt(size),
            e.checked.entryHashes[i]!,
            path.map(unhex),
            e.root(size),
          ),
        ).toBe(true);
      }
      for (let m = 1; m <= size; m++) {
        const { path } = (await json(
          await get("/board/proofs/consistency", {
            electionId: e.idHex,
            firstSize: String(m),
            secondSize: String(size),
          }),
        )) as { path: string[] };
        expect(
          verifyConsistency(
            BOARD_TREE,
            BigInt(m),
            BigInt(size),
            e.root(m),
            e.root(size),
            path.map(unhex),
          ),
        ).toBe(true);
      }
    }
  });

  test("proofs: impossible positions are BAD_REQUEST, trees beyond the board OUT_OF_RANGE", async () => {
    const e = await election(3);
    const status = async (path: string, q: Record<string, string>) =>
      (await get(path, { electionId: e.idHex, ...q })).status;
    expect(await status("/board/proofs/inclusion", { index: "3", treeSize: "3" })).toBe(400);
    expect(await status("/board/proofs/inclusion", { index: "0", treeSize: "4" })).toBe(416);
    expect(await status("/board/proofs/consistency", { firstSize: "0", secondSize: "3" })).toBe(
      400,
    );
    expect(await status("/board/proofs/consistency", { firstSize: "2", secondSize: "1" })).toBe(
      400,
    );
    expect(
      await status("/board/proofs/consistency", {
        firstSize: "1",
        secondSize: "18446744073709551615",
      }),
    ).toBe(416);
  });
});

describe("ballots.submit", () => {
  const ballot = hex(Uint8Array.of(0, 2, 1, 7));

  test("without a ballot queue, boards nothing: ELECTION_NOT_OPEN", async () => {
    const e = await election(1);
    const r = await post("/ballots", { electionId: e.idHex, ballot });
    expect(r.status).toBe(409);
    expect((await json(r))["code"]).toBe("ELECTION_NOT_OPEN");
    expect(await readBoard(app, e.id)).toHaveLength(1);
  });

  test("an unknown election is ELECTION_NOT_FOUND", async () => {
    const r = await post("/ballots", { electionId: hex(b32()), ballot });
    expect(r.status).toBe(404);
  });

  test("refuses bodies that aren't bounded JSON", async () => {
    const e = await election();
    expect((await post("/ballots", "{", {})).status).toBe(400);
    expect((await post("/ballots", { electionId: e.idHex, ballot, extra: 1 })).status).toBe(400);
    // T-31: a repeated key, last one wins in JSON.parse, never reaches a procedure.
    const twice = `{"electionId":"${e.idHex}","ballot":"${ballot}","ballot":"${ballot}"}`;
    expect((await post("/ballots", twice)).status).toBe(400);
    expect(
      (await post("/ballots", { electionId: e.idHex, ballot }, { "content-type": "text/plain" }))
        .status,
    ).toBe(415);
    const form = new FormData();
    form.set("electionId", e.idHex);
    expect((await fetch(`${base}/ballots`, { method: "POST", body: form })).status).toBe(415);
    const huge = JSON.stringify({ electionId: e.idHex, ballot: "00".repeat(MAX_REQUEST_BODY) });
    expect((await post("/ballots", huge)).status).toBe(413);
  });

  test("an oversize body without a length is cut off, not buffered", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/ballots`, {
        method: "POST",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      const chunk = Buffer.alloc(64 * 1024, 0x30);
      let sent = 0;
      const write = () => {
        while (sent <= MAX_REQUEST_BODY + chunk.length) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once("drain", write);
        }
        req.end();
      };
      write();
    });
    expect(status).toBe(413);
  });
});

describe("moderation (T-68)", () => {
  test("the contract's reason codes are core's", () => {
    expect([...REMOVAL_REASONS]).toEqual([...CORE_REMOVAL_REASONS]);
    expect([...RESTORE_REASONS]).toEqual([...CORE_RESTORE_REASONS]);
    expect([...REFILE_REASONS]).toEqual([...CORE_REFILE_REASONS]);
  });

  test("a poll never moderated is visible, with no decision", async () => {
    const e = await election();
    const r = await get("/moderation/status", { electionId: e.idHex });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ state: "visible" });
  });

  test("the status is the newest decision, without the moderator", async () => {
    const e = await election();
    const { seq } = await moderate(app, e.id, {
      action: "hide",
      reason: "personal-data",
      moderator: "mod-secret",
    });
    const r = await get("/moderation/status", { electionId: e.idHex });
    const body = await json(r);
    expect(body).toEqual({
      state: "hidden",
      latest: {
        seq: seq.toString(),
        action: "hide",
        reason: "personal-data",
        decidedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      },
    });
    expect(JSON.stringify(body)).not.toContain("mod-secret");
  });

  test("the status of an unknown election is ELECTION_NOT_FOUND", async () => {
    const r = await get("/moderation/status", { electionId: hex(b32()) });
    expect(r.status).toBe(404);
    expect((await json(r))["code"]).toBe("ELECTION_NOT_FOUND");
  });

  test("the public log pages through every decision in order, without the moderator", async () => {
    const [a, b] = [await election(), await election()];
    const before = await json(await get("/moderation/log", { after: "0", limit: "256" }));
    const start = (before["entries"] as { seq: string }[]).at(-1)?.seq ?? "0";
    await moderate(app, a.id, { action: "delist", reason: "spam", moderator: "mod-secret" });
    await moderate(app, b.id, { action: "hide", reason: "threat", moderator: "mod-secret" });
    await moderate(app, a.id, { action: "restore", reason: "error", moderator: "mod-other" });
    const first = await json(await get("/moderation/log", { after: start, limit: "2" }));
    const entries = first["entries"] as Record<string, string>[];
    expect(entries.map((x) => [x["electionId"], x["action"], x["reason"]])).toEqual([
      [a.idHex, "delist", "spam"],
      [b.idHex, "hide", "threat"],
    ]);
    for (const x of entries)
      expect(Object.keys(x).sort()).toEqual(["action", "decidedAt", "electionId", "reason", "seq"]);
    const rest = await json(
      await get("/moderation/log", { after: entries[1]!["seq"]!, limit: "2" }),
    );
    expect((rest["entries"] as Record<string, string>[]).map((x) => x["action"])).toEqual([
      "restore",
    ]);
    expect(JSON.stringify([first, rest])).not.toContain("mod-");
  });

  test("the public log reads back from a number, newest first, and from the latest", async () => {
    const [a, b] = [await election(), await election()];
    const x = await moderate(app, a.id, { action: "delist", reason: "spam", moderator: "mod-1" });
    const y = await moderate(app, b.id, { action: "hide", reason: "threat", moderator: "mod-1" });
    const z = await moderate(app, a.id, { action: "restore", reason: "error", moderator: "mod-2" });
    const seqs = async (query: Record<string, string>) =>
      ((await json(await get("/moderation/log", query)))["entries"] as { seq: string }[]).map(
        (e) => e.seq,
      );
    expect(await seqs({ before: String(z.seq + 1n), limit: "3" })).toEqual(
      [z.seq, y.seq, x.seq].map(String),
    );
    expect(await seqs({ before: String(z.seq), limit: "1" })).toEqual([String(y.seq)]);
    expect(await seqs({ before: "1", limit: "5" })).toEqual([]);
    // Past every number, from the latest decision.
    for (const before of ["9223372036854775807", "18446744073709551615"])
      expect((await seqs({ before, limit: "1" }))[0]).toBe(
        (await seqs({ after: String(z.seq - 1n), limit: "256" })).at(-1),
      );
    // Without either, from the first.
    expect(await seqs({ limit: "256" })).toEqual(await seqs({ after: "0", limit: "256" }));
    const both = await get("/moderation/log", { after: "0", before: "9", limit: "1" });
    expect(both.status).toBe(400);
  });

  test("the log's counts are the whole log's, by action, naming no moderator", async () => {
    const counts = async () =>
      (await json(await get("/moderation/log/counts", {}))) as Record<string, string>;
    const [a, b] = [await election(), await election()];
    const was = await counts();
    await moderate(app, a.id, { action: "delist", reason: "spam", moderator: "mod-secret" });
    await moderate(app, b.id, { action: "hide", reason: "threat", moderator: "mod-secret" });
    await moderate(app, a.id, { action: "restore", reason: "error", moderator: "mod-secret" });
    const now = await counts();
    expect(Object.keys(now).sort()).toEqual(
      ["delist", "hide", "hideProfile", "refile", "restore", "since", "total"].sort(),
    );
    // The log's first decision's time, which these three come after.
    expect(now["since"]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    if (was["since"] !== undefined) expect(now["since"]).toBe(was["since"]);
    const grew = (key: string) => BigInt(now[key]!) - BigInt(was[key]!);
    expect(["delist", "hide", "hideProfile", "restore", "refile", "total"].map(grew)).toEqual([
      1n,
      1n,
      0n,
      1n,
      0n,
      3n,
    ]);
    // `total` is every entry the log serves.
    let served = 0;
    const times: number[] = [];
    for (let after = "0"; ;) {
      const page = (await json(await get("/moderation/log", { after, limit: "256" })))[
        "entries"
      ] as { seq: string; decidedAt: string }[];
      served += page.length;
      times.push(...page.map((e) => Date.parse(e.decidedAt)));
      if (page.length < 256) break;
      after = page.at(-1)!.seq;
    }
    expect(now["total"]).toBe(String(served));
    expect(Date.parse(now["since"]!)).toBe(Math.min(...times));
    expect(JSON.stringify(now)).not.toContain("mod-");
    expect((await get("/moderation/log/counts", { limit: "1" })).status).toBe(400);
  });

  test("the contract's profile handle is core's", () => {
    expect(PROFILE_HANDLE.source).toBe(CORE_PROFILE_HANDLE.source);
    expect(PROFILE_HANDLE.flags).toBe(CORE_PROFILE_HANDLE.flags);
  });

  test("the log carries profile decisions by handle, in one numbering with polls'", async () => {
    const user = await newAccount(app);
    // A stand-in for a verified phone, which making a profile needs.
    await app`INSERT INTO account_phones VALUES (${user}, ${randomBytes(32)}, 'p1', '2026-10-01T00:00:00Z')`;
    const handle = await makeProfile(app, user, "Riverside Neighbours", {
      now: new Date("2026-10-22T12:00:00Z"),
    });
    const e = await election();
    const before = await json(await get("/moderation/log", { after: "0", limit: "256" }));
    const start = (before["entries"] as { seq: string }[]).at(-1)?.seq ?? "0";
    const hid = { action: "hide", reason: "impersonation", moderator: "mod-secret" } as const;
    await moderateProfile(app, handle, hid);
    await moderate(app, e.id, { action: "delist", reason: "spam", moderator: "mod-secret" });
    await moderateProfile(app, handle, {
      action: "restore",
      reason: "error",
      moderator: "mod-other",
    });
    const body = await json(await get("/moderation/log", { after: start, limit: "256" }));
    const entries = body["entries"] as Record<string, string>[];
    expect(entries.map((x) => [x["handle"] ?? x["electionId"], x["action"], x["reason"]])).toEqual([
      [handle, "hide", "impersonation"],
      [e.idHex, "delist", "spam"],
      [handle, "restore", "error"],
    ]);
    expect(Object.keys(entries[0]!).sort()).toEqual([
      "action",
      "decidedAt",
      "handle",
      "reason",
      "seq",
    ]);
    const seqs = entries.map((x) => BigInt(x["seq"]!));
    expect(seqs).toEqual([...seqs].sort((a, b) => (a < b ? -1 : 1)));
    // A page of one ends at the profile's decision; the next starts after it.
    const one = await json(await get("/moderation/log", { after: start, limit: "1" }));
    expect((one["entries"] as Record<string, string>[]).map((x) => x["handle"])).toEqual([handle]);
    // Neither the moderator nor the profile's account or name is served (T-10).
    const served = JSON.stringify(body);
    for (const secret of ["mod-", user, "Riverside"]) expect(served).not.toContain(secret);
  });

  test("the log carries refilings in the poll's numbering, saying what changed but never a place or the moderator", async () => {
    const e = await election();
    const place = `Unusualstreet ${hex(b32()).slice(0, 8)}`;
    await insertPollTags(app, e.id, { topic: "food", place });
    const before = await json(await get("/moderation/log", { after: "0", limit: "256" }));
    const start = (before["entries"] as { seq: string }[]).at(-1)?.seq ?? "0";
    const by = { moderator: "mod-secret" } as const;
    await refilePoll(app, e.id, { tags: { topic: "housing", place }, reason: "misfiled", ...by });
    await moderate(app, e.id, { action: "delist", reason: "spam", ...by });
    await refilePoll(app, e.id, { tags: { topic: "housing" }, reason: "personal-data", ...by });
    await refilePoll(app, e.id, { tags: { place: "Ward 3" }, reason: "misfiled", ...by });
    const body = await json(await get("/moderation/log", { after: start, limit: "256" }));
    const entries = (body["entries"] as Record<string, string>[]).map(
      ({ seq, decidedAt, ...rest }) => {
        expect(seq).toMatch(/^\d+$/);
        expect(decidedAt).toMatch(/Z$/);
        return rest;
      },
    );
    expect(entries).toEqual([
      { electionId: e.idHex, action: "refile", reason: "misfiled", topic: "housing" },
      { electionId: e.idHex, action: "delist", reason: "spam" },
      { electionId: e.idHex, action: "refile", reason: "personal-data", place: "cleared" },
      {
        electionId: e.idHex,
        action: "refile",
        reason: "misfiled",
        topic: null,
        place: "changed",
      },
    ]);
    const served = JSON.stringify(body);
    for (const secret of ["mod-", "Unusualstreet", "Ward"]) expect(served).not.toContain(secret);
  });

  test("the log refuses positions and page sizes outside its bounds", async () => {
    const page = (after: string, limit: string) => get("/moderation/log", { after, limit });
    for (const [after, limit] of [
      ["-1", "1"],
      ["01", "1"],
      ["18446744073709551616", "1"],
      ["0", "0"],
      ["0", "257"],
    ] as const)
      expect((await page(after, limit)).status, `${after} ${limit}`).toBe(400);
    // Past the largest sequence number Postgres holds, the log is empty.
    for (const after of ["9223372036854775807", "18446744073709551615"])
      expect(await json(await page(after, "1"))).toEqual({ entries: [] });
  });

  test("a report is counted for the moderators and changes nothing public", async () => {
    const e = await election();
    for (let i = 0; i < 3; i++) {
      const r = await post("/moderation/reports", { electionId: e.idHex, reason: "harassment" });
      expect(r.status).toBe(202);
      expect(await json(r)).toEqual({});
    }
    const queue = (await readReportQueue(app, MAX_REPORT_QUEUE)).filter(
      (q) => hex(q.electionId) === e.idHex,
    );
    expect(queue.map((q) => [q.reason, q.pending])).toEqual([["harassment", 3n]]);
    expect(await json(await get("/moderation/status", { electionId: e.idHex }))).toEqual({
      state: "visible",
    });
  });

  test("a report needs a known election and one of the policy's removal grounds", async () => {
    const e = await election();
    const r = await post("/moderation/reports", { electionId: hex(b32()), reason: "spam" });
    expect(r.status).toBe(404);
    expect((await json(r))["code"]).toBe("ELECTION_NOT_FOUND");
    for (const body of [
      { electionId: e.idHex, reason: "error" },
      { electionId: e.idHex, reason: "unpopular" },
      { electionId: e.idHex },
      { electionId: e.idHex, reason: "spam", note: "call me on 555-0100" },
      { electionId: e.idHex, reason: "spam", account: "x" },
    ])
      expect((await post("/moderation/reports", body)).status, JSON.stringify(body)).toBe(400);
    expect(
      (await readReportQueue(app, MAX_REPORT_QUEUE)).filter((q) => hex(q.electionId) === e.idHex),
    ).toEqual([]);
  });
});

describe("backups (ADR 0017; T-10, T-20, T-52)", () => {
  /** A backup as the ballot client makes one. */
  function backup() {
    const prf = b32();
    const secret = newIdentitySecret();
    const { locator, envelope } = sealIdentityBackup(prf, Uint8Array.from(secret));
    return { prf, secret, locator: hex(locator), envelope: hex(envelope) };
  }

  test("the contract's sizes and retention are core's", () => {
    expect(IDENTITY_BACKUP_ENVELOPE).toBe(IDENTITY_BACKUP_ENVELOPE_LENGTH);
    expect(CONTRACT_RETENTION_MONTHS).toBe(IDENTITY_BACKUP_RETENTION_MONTHS);
  });

  test("put, fetch, replace and delete by locator; the envelope opens to the secret", async () => {
    const b = backup();
    expect((await post("/backups", { locator: b.locator, envelope: b.envelope })).status).toBe(200);
    const r = await post("/backups/fetch", { locator: b.locator });
    expect(r.status).toBe(200);
    const { envelope } = await json(r);
    expect(envelope).toBe(b.envelope);
    expect(openIdentityBackup(b.prf, unhex(envelope as string))).toEqual(b.secret);

    const next = hex(sealIdentityBackup(b.prf, newIdentitySecret()).envelope);
    expect((await post("/backups", { locator: b.locator, envelope: next })).status).toBe(200);
    expect(await json(await post("/backups/fetch", { locator: b.locator }))).toEqual({
      envelope: next,
    });

    expect((await post("/backups/delete", { locator: b.locator })).status).toBe(200);
    for (const path of ["/backups/fetch", "/backups/delete"]) {
      const gone = await post(path, { locator: b.locator });
      expect(gone.status).toBe(404);
      expect((await json(gone))["code"]).toBe("BACKUP_NOT_FOUND");
    }
  });

  test("the table keeps a hash of the locator, never the locator", async () => {
    const b = backup();
    await post("/backups", { locator: b.locator, envelope: b.envelope });
    const rows = await app`SELECT encode(id, 'hex') AS id FROM identity_backups`;
    const ids = rows.map((r) => r["id"]);
    expect(ids).toContain(hex(identityBackupId(unhex(b.locator))));
    expect(ids).not.toContain(b.locator);
    // A row's id, presented as a locator, finds nothing (T-66).
    const id = hex(identityBackupId(unhex(b.locator)));
    expect((await post("/backups/fetch", { locator: id })).status).toBe(404);
  });

  test("an envelope that doesn't decode is BACKUP_REJECTED with the decoder's code", async () => {
    const b = backup();
    for (const [envelope, code] of [
      [`000b01${b.envelope.slice(6)}`, "unknown-record-type"],
      [`000a02${b.envelope.slice(6)}`, "unknown-version"],
    ] as const) {
      const r = await post("/backups", { locator: b.locator, envelope });
      expect(r.status).toBe(422);
      const body = await json(r);
      expect(body["code"]).toBe("BACKUP_REJECTED");
      expect(body["data"]).toEqual({ code });
    }
    expect((await post("/backups/fetch", { locator: b.locator })).status).toBe(404);
  });

  test("refuses a locator or envelope of any other size or spelling, and extra fields", async () => {
    const b = backup();
    for (const body of [
      { locator: b.locator.slice(2), envelope: b.envelope },
      { locator: `${b.locator}00`, envelope: b.envelope },
      { locator: b.locator.toUpperCase(), envelope: b.envelope },
      { locator: b.locator, envelope: b.envelope.slice(2) },
      { locator: b.locator, envelope: `${b.envelope}00` },
      { locator: b.locator, envelope: b.envelope, accountId: "x" },
      { envelope: b.envelope },
    ])
      expect((await post("/backups", body)).status).toBe(400);
    expect(
      (await post("/backups/fetch", { locator: b.locator, envelope: b.envelope })).status,
    ).toBe(400);
  });

  test("the locator never travels in a URL: GET is not a route", async () => {
    const b = backup();
    await post("/backups", { locator: b.locator, envelope: b.envelope });
    for (const path of ["/backups", "/backups/fetch"])
      expect((await get(path, { locator: b.locator })).status).toBe(404);
  });
});

describe("transport", () => {
  test("a POST with a query string is refused: inputs come from the body alone (T-31)", async () => {
    const e = await election();
    const r = await fetch(`${base}/ballots?electionId=${hex(b32())}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ electionId: e.idHex, ballot: "000201" }),
    });
    expect(r.status).toBe(400);
  });

  test("past maxInFlight, requests are refused before anything is read (T-52)", async () => {
    const capped = createApiServer({ sql: app, log: () => {}, maxInFlight: 1 });
    await new Promise<void>((r) => capped.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(capped.address() as AddressInfo).port}`;
    // A body that never finishes holds the only slot.
    const slow = httpRequest(`${url}/ballots`, {
      method: "POST",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
    });
    slow.on("error", () => {});
    slow.write("{");
    await new Promise((r) => setTimeout(r, 50));
    const e = await election();
    expect((await fetch(`${url}/board/head?electionId=${e.idHex}`)).status).toBe(503);
    slow.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`${url}/board/head?electionId=${e.idHex}`)).status).toBe(200);
    capped.closeAllConnections();
    await new Promise((r) => capped.close(r));
    expect(() => createApiServer({ sql: app, log: () => {}, maxInFlight: 0 })).toThrow(RangeError);
  });

  test(
    "an idle client loses its slot: a stalled upload or an unread answer (T-52)",
    // Two stalls, each polling up to 10 seconds for its slot (below).
    { timeout: 30_000 },
    async () => {
      const capped = createApiServer({
        sql: app,
        log: () => {},
        maxInFlight: 1,
        idleTimeoutMs: 300,
      });
      await new Promise<void>((r) => capped.listen(0, "127.0.0.1", r));
      const port = (capped.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}`;
      const e = await election(9, 1_000_000);
      const head = () => fetch(`${url}/board/head?electionId=${e.idHex}`).then((r) => r.status);
      const stalls = [
        // Headers and one byte of a body, then nothing.
        `POST /ballots HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n1\r\n{\r\n`,
        // An 8 MB page the client never reads.
        `GET /board/entries?electionId=${e.idHex}&start=0&limit=256 HTTP/1.1\r\nhost: x\r\n\r\n`,
      ];
      for (const stall of stalls) {
        const socket = connect(port, "127.0.0.1");
        socket.on("error", () => {});
        socket.write(stall);
        socket.pause();
        await new Promise((r) => setTimeout(r, 100));
        expect(await head()).toBe(503);
        // The idle timer starts only once the server stops making progress, and
        // building the unread 8 MB page alone has taken over a second on CI's
        // shared runners, so a fixed wait raced it. Poll instead, well inside the
        // 60-second default deadline: a slot freed before that was freed by the
        // idle timeout (300 ms here), never by the deadline.
        const until = Date.now() + 10_000;
        let status = await head();
        while (status !== 200 && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 100));
          status = await head();
        }
        expect(status).toBe(200);
        socket.destroy();
      }
      capped.closeAllConnections();
      await new Promise((r) => capped.close(r));
    },
  );

  test("a slow reader loses its slot at the deadline, however it trickles (T-52)", async () => {
    const capped = createApiServer({ sql: app, log: () => {}, maxInFlight: 1, deadlineMs: 500 });
    await new Promise<void>((r) => capped.listen(0, "127.0.0.1", r));
    const port = (capped.address() as AddressInfo).port;
    const e = await election(9, 1_000_000);
    const head = () =>
      fetch(`http://127.0.0.1:${port}/board/head?electionId=${e.idHex}`).then((r) => r.status);
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    socket.write(
      `GET /board/entries?electionId=${e.idHex}&start=0&limit=256 HTTP/1.1\r\nhost: x\r\n\r\n`,
    );
    // Read a little every 50 ms: never idle, never done.
    socket.pause();
    const trickle = setInterval(() => socket.read(1024), 50);
    await new Promise((r) => setTimeout(r, 200));
    expect(await head()).toBe(503);
    await new Promise((r) => setTimeout(r, 800));
    expect(await head()).toBe(200);
    clearInterval(trickle);
    socket.destroy();
    capped.closeAllConnections();
    await new Promise((r) => capped.close(r));
  });

  // The poll below waits up to 10 s for a cold Node start, which a loaded CI
  // runner can need, so the test's timeout must outlast it (the default is 5 s).
  test("src/main.ts starts under plain Node, without a TypeScript transform", async () => {
    // Node strips types but rejects TypeScript-only syntax (parameter
    // properties, enums) that the test runner's transform would accept.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          DATABASE_URL: process.env["TEST_DATABASE_URL"] ?? "",
          API_PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    try {
      let status = 0;
      for (let i = 0; i < 100 && status === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        status = await fetch(`http://127.0.0.1:${port}/nope`).then(
          (r) => r.status,
          () => 0,
        );
        if (child.exitCode !== null) break;
      }
      expect(stderr).toBe("");
      expect(status).toBe(404);
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }, 20_000);

  test("unknown routes and methods are 404", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/ballots`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${base}/board/head`, { method: "POST" })).status).toBe(404);
  });

  test("a GET with a body is refused: inputs come from the query alone (T-31)", async () => {
    const e = await election();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/elections/definition?electionId=${e.idHex}`, {
        method: "GET",
        headers: { "content-type": "application/json" },
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.end(JSON.stringify({ electionId: hex(b32()) }));
    });
    expect(status).toBe(400);
  });
});

describe("request log (T-10, T-11)", () => {
  test("no line carries an address, a header, a query, a body or an identifier", async () => {
    const e = await election(2);
    // Account credentials are refused outright (next describe); anything else
    // a client sends is served but never logged.
    const secrets = {
      cookie: `session=${hex(b32())}`,
      "x-forwarded-for": "203.0.113.77",
      "x-request-id": hex(b32()),
    };
    const ballot = hex(Uint8Array.of(0, 2, 1, ...b32()));
    const nullifierLike = hex(b32());
    logs.length = 0;
    await fetch(`${base}/elections/definition?electionId=${e.idHex}&n=${nullifierLike}`, {
      headers: secrets,
    });
    await fetch(`${base}/board/head?electionId=${e.idHex}`, { headers: secrets });
    await post("/ballots", { electionId: e.idHex, ballot }, secrets);
    await post("/ballots", { electionId: e.idHex, ballot, nullifier: nullifierLike }, secrets);
    await fetch(`${base}/${ballot}?${nullifierLike}`, { headers: secrets });
    await post("/ballots", "{", secrets);
    await post("/moderation/reports", { electionId: e.idHex, reason: "spam" }, secrets);
    const prf = b32();
    const { locator, envelope } = sealIdentityBackup(prf, newIdentitySecret());
    await post("/backups", { locator: hex(locator), envelope: hex(envelope) }, secrets);
    await post("/backups/fetch", { locator: hex(locator) }, secrets);
    await post("/backups/delete", { locator: hex(locator) }, secrets);
    // The server logs on "finish", after the response: wait for every line.
    await new Promise((r) => setTimeout(r, 50));
    expect(logs).toHaveLength(10);
    const text = JSON.stringify(logs);
    for (const value of [
      ...Object.values(secrets),
      ...Object.values(secrets).map((s) => s.split(/[= ]/).pop()!),
      e.idHex,
      ballot,
      nullifierLike,
      hex(locator),
      hex(identityBackupId(locator)),
      hex(envelope),
      "127.0.0.1",
    ])
      expect(text).not.toContain(value);
    for (const line of logs as RequestLogLine[]) {
      expect(Object.keys(line).sort()).toEqual(["method", "ms", "route", "status"]);
      expect(["GET", "POST", "other"]).toContain(line.method);
      expect(line.route).toMatch(/^(?:(?:GET|POST) \/[a-z/]+|unmatched)$/);
    }
    expect((logs as RequestLogLine[]).map((l) => l.route)).toEqual([
      "GET /elections/definition",
      "GET /board/head",
      "POST /ballots",
      "POST /ballots",
      "unmatched",
      "POST /ballots",
      "POST /moderation/reports",
      "POST /backups",
      "POST /backups/fetch",
      "POST /backups/delete",
    ]);
  });

  test("an internal error is logged by kind only", async () => {
    const broken = createApiServer({
      sql: (() => {
        throw new Error(`connection secret ${hex(b32())}`);
      }) as unknown as Sql,
      log: (l) => lines.push(l),
    });
    const lines: unknown[] = [];
    await new Promise<void>((r) => broken.listen(0, "127.0.0.1", r));
    const port = (broken.address() as AddressInfo).port;
    const id = hex(b32());
    const r = await fetch(`http://127.0.0.1:${port}/elections/definition?electionId=${id}`);
    await new Promise((res) => broken.close(res));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("secret");
    expect(lines.filter((l) => "error" in (l as object))).toEqual([
      { error: expect.stringMatching(/^[A-Za-z]+$/) },
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret");
    expect(JSON.stringify(lines)).not.toContain(id);
  });
});

describe("account credentials (T-10)", () => {
  const token = () => hex(b32());
  const refused = [
    { cookie: `__Secure-${ACCOUNT_COOKIE_PREFIX}.session_token=${token()}` },
    { cookie: `${ACCOUNT_COOKIE_PREFIX}.session_token=${token()}` },
    { cookie: `__Host-${ACCOUNT_COOKIE_PREFIX}.session_data=${token()}` },
    { cookie: `a=1; __SECURE-${ACCOUNT_COOKIE_PREFIX.toUpperCase()}.passkey-challenge=${token()}` },
    { cookie: `__cf_bm=x;${ACCOUNT_COOKIE_PREFIX}.dont_remember=true` },
    { cookie: `${ACCOUNT_COOKIE_PREFIX}-session_token=${token()}` },
    { authorization: `Bearer ${token()}` },
    { authorization: `Basic ${token()}` },
  ];

  test("a request carrying one is refused, on every route, before anything is read", async () => {
    const e = await election(1);
    // A stored backup, so a refused request that slipped through would find it.
    const { locator, envelope } = sealIdentityBackup(b32(), newIdentitySecret());
    const stored = { locator: hex(locator), envelope: hex(envelope) };
    expect((await post("/backups", stored)).status).toBe(200);
    for (const headers of refused) {
      const reads = [
        await fetch(`${base}/elections/definition?electionId=${e.idHex}`, { headers }),
        await fetch(`${base}/board/head?electionId=${e.idHex}`, { headers }),
        await fetch(`${base}/nope`, { headers }),
        await post("/ballots", { electionId: e.idHex, ballot: "000201" }, headers),
        await post("/backups", { locator: stored.locator, envelope: stored.envelope }, headers),
        await post("/backups/fetch", { locator: stored.locator }, headers),
        await post("/backups/delete", { locator: stored.locator }, headers),
      ];
      for (const r of reads) {
        expect([headers, r.status]).toEqual([headers, 400]);
        expect(await r.json()).toEqual({ code: "BAD_REQUEST", status: 400 });
      }
    }
    // Neither replaced nor deleted (ADR 0017: refused, not ignored).
    expect(await json(await post("/backups/fetch", { locator: stored.locator }))).toEqual({
      envelope: stored.envelope,
    });
  });

  test("other cookies are served as usual", async () => {
    const e = await election(1);
    const r = await fetch(`${base}/board/head?electionId=${e.idHex}`, {
      headers: { cookie: `__cf_bm=${token()}; abolish.theme=dark; account=1` },
    });
    expect(r.status).toBe(200);
  });
});
