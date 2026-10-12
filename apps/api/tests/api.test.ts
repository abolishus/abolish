import {
  BOARD_TREE,
  checkBoard,
  decodeElectionDefinition,
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
  moderate,
  readBoard,
  readReportQueue,
  REMOVAL_REASONS as CORE_REMOVAL_REASONS,
  RESTORE_REASONS as CORE_RESTORE_REASONS,
  storeDefinition,
} from "@abolishus/core";
import {
  IDENTITY_BACKUP_ENVELOPE,
  IDENTITY_BACKUP_RETENTION_MONTHS as CONTRACT_RETENTION_MONTHS,
  REMOVAL_REASONS,
  RESTORE_REASONS,
} from "@abolishus/api-contract";
import { type TestDb, testDb } from "@abolishus/core/test-db";
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

  test("an idle client loses its slot: a stalled upload or an unread answer (T-52)", async () => {
    const capped = createApiServer({ sql: app, log: () => {}, maxInFlight: 1, idleTimeoutMs: 300 });
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
      await new Promise((r) => setTimeout(r, 800));
      expect(await head()).toBe(200);
      socket.destroy();
    }
    capped.closeAllConnections();
    await new Promise((r) => capped.close(r));
  });

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
  });

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
