import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { generateOpenApi, renderOpenApi } from "../scripts/openapi.ts";
import {
  contract,
  MAX_BOARD_PAYLOAD,
  MAX_DISPLAY_TEXT,
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
      "GET /elections/definition",
      "GET /elections/display-text",
      "GET /elections/results",
      "GET /elections/tags",
      "GET /moderation/log",
      "GET /moderation/status",
      "POST /backups",
      "POST /backups/delete",
      "POST /backups/fetch",
      "POST /ballots",
      "POST /destructions",
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
