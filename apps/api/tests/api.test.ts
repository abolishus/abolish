import {
  BOARD_TREE,
  checkBoard,
  decodeElectionDefinition,
  encodeElectionDefinition,
  merkleRoot,
  UNPINNED,
  verifyConsistency,
  verifyInclusion,
} from "@abolishus/crypto";
import { appendEntry, readBoard, storeDefinition } from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { createApiServer, MAX_REQUEST_BODY, type RequestLogLine } from "../src/index.ts";

// The API end to end over HTTP, against a live Postgres: what it serves is
// what the verifier's own code accepts (T-23, T-24, T-34), inputs are bounded
// (T-31, T-52), no ballot is boarded before admission exists (T-53), and the
// request log never carries anything that names a person, a session or a
// ballot (T-10, T-11).

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const b32 = () => new Uint8Array(randomBytes(32));

const typical = decodeElectionDefinition(
  unhex(
    JSON.parse(
      readFileSync(
        new URL("../../../docs/spec/vectors/election-definition.json", import.meta.url),
        "utf8",
      ),
    ).vectors.find((v: { id: string }) => v.id === "definition-typical").encoding,
  ),
);

let db: TestDb;
let app: Sql;
let server: Server;
let base: string;
const logs: unknown[] = [];

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
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
    // Entries without a stored definition aren't served.
    await appendEntry(app, id, 0, Uint8Array.of(0, 2, 1, 0));
    for (const [path, extra] of [
      ["/board/head", {}],
      ["/board/entries", { start: "0", limit: "1" }],
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

  test("boards nothing before admission exists: ELECTION_NOT_OPEN", async () => {
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

describe("transport", () => {
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
    const secrets = {
      cookie: `session=${hex(b32())}`,
      authorization: `Bearer ${hex(b32())}`,
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
    // The server logs on "finish", after the response: wait for every line.
    await new Promise((r) => setTimeout(r, 50));
    expect(logs).toHaveLength(6);
    const text = JSON.stringify(logs);
    for (const value of [
      ...Object.values(secrets),
      ...Object.values(secrets).map((s) => s.split(/[= ]/).pop()!),
      e.idHex,
      ballot,
      nullifierLike,
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
