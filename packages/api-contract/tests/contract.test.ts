import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { generateOpenApi, renderOpenApi } from "../scripts/openapi.ts";
import {
  contract,
  MAX_BOARD_PAYLOAD,
  MAX_DISPLAY_TEXT,
  MAX_ANSWERED_ELECTIONS,
  MAX_LISTED_PLACES,
  MAX_PLACE_LENGTH,
  MAX_RESULT_CELLS,
  MAX_RESULT_OPTIONS,
  MAX_RESULT_QUESTIONS,
  MAX_RESULT_SEATS,
  POSTING_MAX_DATA,
} from "../src/index.ts";

const root = join(import.meta.dirname, "..");
const repo = join(root, "../..");

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = { [k: string]: Json };

const doc = (await generateOpenApi()) as unknown as {
  paths: Record<string, Record<string, Schema>>;
  security?: Json;
  components?: { securitySchemes?: Json };
};

const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ path, method, op })),
);

/** Every schema the contract defines: request bodies, parameters, success bodies and defined error data. */
function contractSchemas(op: Schema): Json[] {
  const out: Json[] = [];
  const params = (op["parameters"] ?? []) as Schema[];
  for (const p of params) out.push(p["schema"] ?? null);
  const body = op["requestBody"] as Schema | undefined;
  if (body) out.push(((body["content"] as Schema)["application/json"] as Schema)["schema"] ?? null);
  for (const [status, res] of Object.entries(op["responses"] as Record<string, Schema>)) {
    const schema = (((res["content"] as Schema)["application/json"] as Schema)["schema"] ??
      null) as Schema;
    if (status.startsWith("2")) out.push(schema);
    else {
      // oRPC's error envelope: only the `data` of errors we define is ours.
      for (const variant of (schema["oneOf"] ?? []) as Schema[]) {
        const props = variant["properties"] as Schema;
        if ((props["defined"] as Schema)["const"] === true) out.push(props["data"] ?? null);
      }
    }
  }
  return out;
}

function* walk(s: Json, at = "$"): Generator<[string, Schema]> {
  if (s === null || typeof s !== "object") return;
  if (Array.isArray(s)) {
    for (const [i, v] of s.entries()) yield* walk(v, `${at}[${i}]`);
    return;
  }
  yield [at, s];
  for (const [k, v] of Object.entries(s)) yield* walk(v, `${at}.${k}`);
}

describe("the contract's shape", () => {
  test("every procedure has an explicit method and path", () => {
    const procedures = Object.values(contract).flatMap((group) => Object.values(group));
    expect(procedures.length).toBe(operations.length);
    for (const p of procedures) {
      const route = p["~orpc"].route;
      expect(route.method).toBeDefined();
      // T-31: no path parameters, so a query or body field can't override one.
      expect(route.path).not.toMatch(/[{}]/);
    }
  });

  test("every object the contract defines rejects unknown properties (strict objects only)", () => {
    for (const { path, method, op } of operations) {
      for (const schema of contractSchemas(op)) {
        for (const [at, node] of walk(schema)) {
          if (node["type"] === "object") {
            expect(node["additionalProperties"], `${method} ${path} ${at}`).toBe(false);
          }
        }
      }
    }
  });

  test("a request with an extra field is refused, not ignored", async () => {
    const input = contract.ballots.submit["~orpc"].inputSchema;
    const valid = { electionId: "00".repeat(32), ballot: "000201" };
    expect((await input?.["~standard"].validate(valid))?.issues).toBeUndefined();
    const extra = { ...valid, accountId: "x" };
    expect((await input?.["~standard"].validate(extra))?.issues).toBeDefined();
  });

  test("no field names an account, a session, a person or a plaintext vote (T-09, T-10)", () => {
    const banned =
      /account|user|session|email|phone|name|address|ip|cookie|token|auth|device|vote|choice|selection|plaintext|option/i;
    for (const { path, method, op } of operations) {
      for (const p of (op["parameters"] ?? []) as Schema[]) {
        expect(p["name"], `${method} ${path}`).not.toMatch(banned);
      }
      for (const schema of contractSchemas(op)) {
        for (const [at, node] of walk(schema)) {
          for (const key of Object.keys((node["properties"] ?? {}) as Schema)) {
            expect(key, `${method} ${path} ${at}`).not.toMatch(banned);
          }
        }
      }
    }
  });

  test("no operation declares authentication, so a ballot can't carry a credential (T-10)", () => {
    expect(doc.security).toBeUndefined();
    expect(doc.components?.securitySchemes).toBeUndefined();
    for (const { op } of operations) expect(op["security"]).toBeUndefined();
  });
});

describe("identity backups (ADR 0017; T-10, T-20)", () => {
  test("every backup route is a POST, so a locator never sits in a URL", () => {
    const routes = Object.values(contract.backups).map((p) => p["~orpc"].route);
    expect(routes.length).toBe(3);
    for (const route of routes) expect(route.method).toBe("POST");
  });

  test("a backup request has one size: a 32-byte locator and a 63-byte envelope", async () => {
    const input = contract.backups.put["~orpc"].inputSchema;
    const valid = { locator: "ab".repeat(32), envelope: "000a01" + "cd".repeat(60) };
    expect((await input?.["~standard"].validate(valid))?.issues).toBeUndefined();
    for (const bad of [
      { ...valid, locator: "ab".repeat(31) },
      { ...valid, locator: "ab".repeat(33) },
      { ...valid, envelope: valid.envelope.slice(2) },
      { ...valid, envelope: `${valid.envelope}00` },
      { ...valid, envelope: valid.envelope.toUpperCase() },
    ])
      expect((await input?.["~standard"].validate(bad))?.issues).toBeDefined();
  });
});

describe("the moderation log's page", () => {
  const input = contract.moderation.getLog["~orpc"].inputSchema;
  const issues = async (value: unknown) => (await input?.["~standard"].validate(value))?.issues;

  test("reads after a number, before one, or from the first, never both ways at once", async () => {
    for (const ok of [
      { after: "0", limit: "50" },
      { before: "18446744073709551615", limit: "50" },
      { before: "7", limit: "1" },
      { limit: "50" },
    ])
      expect(await issues(ok)).toBeUndefined();
    for (const bad of [
      { after: "3", before: "9", limit: "50" },
      { before: "-1", limit: "50" },
      { before: "07", limit: "50" },
      { before: "18446744073709551616", limit: "50" },
      { before: "7", limit: "50", order: "desc" },
    ])
      expect(await issues(bad)).toBeDefined();
  });
});

describe("the listing's page", () => {
  const input = contract.elections.list["~orpc"].inputSchema;
  const issues = async (value: unknown) => (await input?.["~standard"].validate(value))?.issues;
  const id = "ab".repeat(32);

  test("reads before a poll only alone and under the id order", async () => {
    for (const ok of [
      { before: id, limit: "20" },
      { before: id, sort: "id", limit: "20", q: "park", topic: "housing", place: "Old Town" },
      { after: id, limit: "20" },
      { after: id, sort: "closing", limit: "20" },
    ])
      expect(await issues(ok)).toBeUndefined();
    for (const bad of [
      { before: id, after: id, limit: "20" },
      { before: id, sort: "new", limit: "20" },
      { before: id, sort: "closing", limit: "20" },
      { before: id, sort: "answered", limit: "20" },
      { before: id.toUpperCase(), limit: "20" },
      { before: id.slice(2), limit: "20" },
    ])
      expect(await issues(bad), JSON.stringify(bad)).toBeDefined();
  });
});

describe("the listing's counts", () => {
  const input = contract.elections.getCounts["~orpc"].inputSchema;
  const output = contract.elections.getCounts["~orpc"].outputSchema;
  const issues = async (schema: typeof input | typeof output, value: unknown) =>
    (await schema?.["~standard"].validate(value))?.issues;
  const counts = { listed: "12", open: "5", scheduled: "2" };

  test("take nothing, and serve each count as a decimal", async () => {
    expect(await issues(input, {})).toBeUndefined();
    expect(await issues(input, { limit: "1" })).toBeDefined();
    expect(await issues(output, counts)).toBeUndefined();
    for (const bad of [
      { ...counts, listed: "012" },
      { ...counts, open: "-1" },
      { ...counts, open: 5 },
      { ...counts, scheduled: "18446744073709551616" },
      { ...counts, closed: "5" },
      { listed: "12", open: "5" },
    ])
      expect(await issues(output, bad)).toBeDefined();
  });
});

describe("the listed places", () => {
  const input = contract.elections.getPlaces["~orpc"].inputSchema;
  const output = contract.elections.getPlaces["~orpc"].outputSchema;
  const issues = async (schema: typeof input | typeof output, value: unknown) =>
    (await schema?.["~standard"].validate(value))?.issues;

  test("take nothing, and serve at most MAX_LISTED_PLACES places a filter could name", async () => {
    expect(await issues(input, {})).toBeUndefined();
    expect(await issues(input, { limit: "1" })).toBeDefined();
    for (const good of [
      { places: [] },
      { places: ["Riverside", "東京 Ward 2", "\u{10000}".repeat(MAX_PLACE_LENGTH)] },
      { places: Array.from({ length: MAX_LISTED_PLACES }, (_, i) => `Place ${i}`) },
    ])
      expect(await issues(output, good)).toBeUndefined();
    for (const bad of [
      { places: [""] },
      { places: ["x".repeat(2 * MAX_PLACE_LENGTH + 1)] },
      { places: [7] },
      { places: Array.from({ length: MAX_LISTED_PLACES + 1 }, (_, i) => `Place ${i}`) },
      { places: ["Riverside"], polls: "1" },
      {},
    ])
      expect(await issues(output, bad)).toBeDefined();
  });
});

describe("the moderation log's counts", () => {
  const input = contract.moderation.getCounts["~orpc"].inputSchema;
  const output = contract.moderation.getCounts["~orpc"].outputSchema;
  const issues = async (schema: typeof input | typeof output, value: unknown) =>
    (await schema?.["~standard"].validate(value))?.issues;
  const counts = {
    delist: "1",
    hide: "0",
    hideProfile: "2",
    restore: "1",
    refile: "0",
    total: "4",
  };

  test("take nothing, and serve each action's count as a decimal", async () => {
    expect(await issues(input, {})).toBeUndefined();
    expect(await issues(input, { limit: "1" })).toBeDefined();
    expect(await issues(output, counts)).toBeUndefined();
    // `since` only once the log has a decision, at the log's own precision.
    expect(await issues(output, { ...counts, since: "2026-09-01T08:30:00.000Z" })).toBeUndefined();
    for (const bad of [
      { ...counts, since: "2026-09-01T08:30:00Z" },
      { ...counts, since: "1 September 2026" },
      { ...counts, since: null },
      { ...counts, total: "04" },
      { ...counts, hide: "-1" },
      { ...counts, hide: 0 },
      { ...counts, moderator: "mod-1" },
      Object.fromEntries(Object.entries(counts).filter(([key]) => key !== "refile")),
    ])
      expect(await issues(output, bad)).toBeDefined();
  });
});

describe("Tier 0 registration (docs/spec/registration.md, Request)", () => {
  const input = contract.registrations.tier0["~orpc"].inputSchema;
  const valid = { commitment: "0a".repeat(32), region: "0", turnstile: "tok.en-1_" };
  const issues = async (value: unknown) => (await input?.["~standard"].validate(value))?.issues;

  test("a POST, so nothing of the request sits in a URL", () => {
    expect(contract.registrations.tier0["~orpc"].route.method).toBe("POST");
  });

  test("takes exactly a 32-byte commitment, a canonical u32 region and a token", async () => {
    expect(await issues(valid)).toBeUndefined();
    expect(await issues({ ...valid, region: "4294967295" })).toBeUndefined();
    expect(await issues({ ...valid, turnstile: "~".repeat(2048) })).toBeUndefined();
    for (const bad of [
      { ...valid, commitment: "0a".repeat(31) },
      { ...valid, commitment: "0A".repeat(32) },
      { ...valid, commitment: `0x${"0a".repeat(31)}` },
      { ...valid, region: "" },
      { ...valid, region: "01" },
      { ...valid, region: "-1" },
      { ...valid, region: "4294967296" },
      { ...valid, region: 0 },
      { ...valid, turnstile: "" },
      { ...valid, turnstile: "a b" },
      { ...valid, turnstile: "a".repeat(2049) },
      { commitment: valid.commitment, region: valid.region },
    ])
      expect(await issues(bad)).toBeDefined();
  });
});

describe("a poll's count so far (P2-23 part 2c; T-01)", () => {
  const output = contract.elections.getAnswered["~orpc"].outputSchema;
  const issues = async (value: unknown) => (await output?.["~standard"].validate(value))?.issues;
  const at = (tier: number, answered = "1") => ({ tier, answered });

  test("holds at most one count a tier, in ascending order", async () => {
    for (const good of [[], [at(0)], [at(0), at(2)], [at(0), at(1), at(2, "18446744073709551615")]])
      expect(await issues({ tiers: good }), JSON.stringify(good)).toBeUndefined();
    for (const bad of [
      [at(0), at(0)],
      [at(2), at(0)],
      [at(0), at(2), at(1)],
      [at(3)],
      [at(-1)],
      [at(0, "01")],
      [at(0, "18446744073709551616")],
      [{ ...at(0), voters: "1" }],
    ])
      expect(await issues({ tiers: bad }), JSON.stringify(bad)).toBeDefined();
  });
});

describe("several polls' counts at once (P2-19 part 58; T-01, T-52)", () => {
  const route = contract.elections.getAnsweredMany["~orpc"];
  const inputIssues = async (value: unknown) =>
    (await route.inputSchema?.["~standard"].validate(value))?.issues;
  const outputIssues = async (value: unknown) =>
    (await route.outputSchema?.["~standard"].validate(value))?.issues;
  const id = (i: number) => i.toString(16).padStart(64, "0");

  test("asks for 1 to MAX_ANSWERED_ELECTIONS distinct IDs", async () => {
    for (const n of [1, 2, MAX_ANSWERED_ELECTIONS])
      expect(
        await inputIssues({ electionIds: Array.from({ length: n }, (_, i) => id(i)) }),
      ).toBeUndefined();
    for (const bad of [
      [],
      [id(1), id(1)],
      [id(0xab).toUpperCase()],
      [id(1).slice(2)],
      Array.from({ length: MAX_ANSWERED_ELECTIONS + 1 }, (_, i) => id(i)),
    ])
      expect(await inputIssues({ electionIds: bad }), JSON.stringify(bad)).toBeDefined();
    expect(await inputIssues({ electionIds: [id(1)], extra: 1 })).toBeDefined();
  });

  test("serves each election's tiers as the one-poll route does", async () => {
    const at = (tier: number, answered = "1") => ({ tier, answered });
    expect(
      await outputIssues({
        elections: [
          { electionId: id(2), tiers: [at(0), at(2)] },
          { electionId: id(1), tiers: [] },
        ],
      }),
    ).toBeUndefined();
    for (const bad of [
      [{ electionId: id(1), tiers: [at(1), at(0)] }],
      [{ electionId: id(1), tiers: [at(0, "01")] }],
      [{ electionId: id(1) }],
      [{ electionId: id(1), tiers: [], extra: 1 }],
      Array.from({ length: MAX_ANSWERED_ELECTIONS + 1 }, (_, i) => ({
        electionId: id(i),
        tiers: [],
      })),
    ])
      expect(
        await outputIssues({ elections: bad }),
        JSON.stringify(bad).slice(0, 80),
      ).toBeDefined();
  });
});

describe("the Tier 1 relay (docs/spec/tier1-relay.md, Request)", () => {
  const input = contract.registrations.tier1["~orpc"].inputSchema;
  const valid = { record: "0a".repeat(1919), turnstile: "tok.en-1_" };
  const issues = async (value: unknown) => (await input?.["~standard"].validate(value))?.issues;

  test("a POST, so nothing of the request sits in a URL", () => {
    expect(contract.registrations.tier1["~orpc"].route.method).toBe("POST");
  });

  test("takes exactly a record of 3,838 lowercase hex digits and a token", async () => {
    expect(await issues(valid)).toBeUndefined();
    expect(await issues({ ...valid, turnstile: "~".repeat(2048) })).toBeUndefined();
    for (const bad of [
      { ...valid, record: "0a".repeat(1918) },
      { ...valid, record: "0a".repeat(1920) },
      { ...valid, record: `${"0a".repeat(1918)}0` },
      { ...valid, record: "0A".repeat(1919) },
      { ...valid, record: `0x${"0a".repeat(1918)}` },
      { ...valid, turnstile: "" },
      { ...valid, turnstile: "a b" },
      { ...valid, turnstile: "a".repeat(2049) },
      { ...valid, region: "0" },
      { record: valid.record },
    ])
      expect(await issues(bad)).toBeDefined();
  });
});

describe("the posting relay (docs/spec/posting-relay.md, Request)", () => {
  const input = contract.postings.submit["~orpc"].inputSchema;
  const valid = { posting: "000d01", ballot: "000203" };
  const issues = async (value: unknown) => (await input?.["~standard"].validate(value))?.issues;

  test("a POST, so nothing of the request sits in a URL", () => {
    expect(contract.postings.submit["~orpc"].route.method).toBe("POST");
  });

  test("takes exactly a posting and a ballot, each lowercase hex within POSTING_MAX_DATA", async () => {
    expect(await issues(valid)).toBeUndefined();
    const most = "00".repeat(POSTING_MAX_DATA);
    expect(await issues({ posting: most, ballot: most })).toBeUndefined();
    for (const bad of [
      { ...valid, posting: `${most}00` },
      { ...valid, ballot: `${most}00` },
      { ...valid, posting: "000D01" },
      { ...valid, ballot: "0x000203" },
      { ...valid, posting: "000d0" },
      { ...valid, electionId: "00".repeat(32) },
      { posting: valid.posting },
      { ballot: valid.ballot },
    ])
      expect(await issues(bad)).toBeDefined();
  });

  test("POSTING_MAX_DATA matches docs/spec/posting-relay.md", () => {
    const table = readFileSync(join(repo, "docs/spec/posting-relay.md"), "utf8");
    const row = /^\|\s*`POSTING_MAX_DATA`\s*\|\s*([\d,]+)\s*\|/m.exec(table);
    expect(row?.[1]?.replaceAll(",", "")).toBe(String(POSTING_MAX_DATA));
  });
});

describe("the generated OpenAPI document", () => {
  test("is deterministic", async () => {
    expect(await renderOpenApi()).toBe(await renderOpenApi());
  });

  test("lists exactly the contract's operations", () => {
    expect(operations.map(({ method, path }) => `${method.toUpperCase()} ${path}`).sort()).toEqual([
      "GET /board/checkpoints",
      "GET /board/entries",
      "GET /board/head",
      "GET /board/proofs/consistency",
      "GET /board/proofs/inclusion",
      "GET /elections",
      "GET /elections/answered",
      "GET /elections/by-code",
      "GET /elections/code",
      "GET /elections/counts",
      "GET /elections/definition",
      "GET /elections/display-text",
      "GET /elections/places",
      "GET /elections/results",
      "GET /elections/tags",
      "GET /moderation/log",
      "GET /moderation/log/counts",
      "GET /moderation/status",
      "POST /backups",
      "POST /backups/delete",
      "POST /backups/fetch",
      "POST /ballots",
      "POST /destructions",
      "POST /elections/answered",
      "POST /moderation/reports",
      "POST /openings",
      "POST /postings",
      "POST /receipts",
      "POST /registrations/tier0",
      "POST /registrations/tier1",
    ]);
  });
});

describe("spec ties", () => {
  test("MAX_BOARD_PAYLOAD matches docs/spec/parameters.md", () => {
    const table = readFileSync(join(repo, "docs/spec/parameters.md"), "utf8");
    const row = /^\|\s*`MAX_BOARD_PAYLOAD`\s*\|\s*([\d,]+)\s*\|/m.exec(table);
    expect(row?.[1]?.replaceAll(",", "")).toBe(String(MAX_BOARD_PAYLOAD));
  });

  test("MAX_DISPLAY_TEXT matches docs/spec/parameters.md", () => {
    const table = readFileSync(join(repo, "docs/spec/parameters.md"), "utf8");
    const row = /^\|\s*`MAX_DISPLAY_TEXT`\s*\|\s*([\d,]+)\s*\|/m.exec(table);
    expect(row?.[1]?.replaceAll(",", "")).toBe(String(MAX_DISPLAY_TEXT));
  });

  test("the results' bounds match docs/spec/parameters.md and the definition's cell limit", () => {
    const table = readFileSync(join(repo, "docs/spec/parameters.md"), "utf8");
    const param = (name: string) =>
      new RegExp(`^\\|\\s*\`${name}\`\\s*\\|\\s*([\\d,]+)\\s*\\|`, "m")
        .exec(table)?.[1]
        ?.replaceAll(",", "");
    expect(param("MAX_OPTIONS")).toBe(String(MAX_RESULT_OPTIONS));
    expect(param("MAX_QUESTIONS")).toBe(String(MAX_RESULT_QUESTIONS));
    expect(param("MAX_TRUSTEES")).toBe(String(MAX_RESULT_SEATS));
    const definition = readFileSync(join(repo, "docs/spec/election-definition.md"), "utf8");
    expect(definition).toContain(`${MAX_RESULT_CELLS} cells in the whole definition`);
  });

  test("source imports zod only as zod/mini", () => {
    const files = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" }).filter(
      (f) => f.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(root, "src", f), "utf8");
      for (const m of text.matchAll(/from\s+["'](zod[^"']*)["']/g))
        expect(m[1], f).toBe("zod/mini");
    }
  });
});
