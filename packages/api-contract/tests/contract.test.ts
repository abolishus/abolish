import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { generateOpenApi, renderOpenApi } from "../scripts/openapi.ts";
import { contract, MAX_BOARD_PAYLOAD } from "../src/index.ts";

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

describe("the generated OpenAPI document", () => {
  test("is deterministic", async () => {
    expect(await renderOpenApi()).toBe(await renderOpenApi());
  });

  test("lists exactly the contract's operations", () => {
    expect(operations.map(({ method, path }) => `${method.toUpperCase()} ${path}`).sort()).toEqual([
      "GET /board/entries",
      "GET /board/head",
      "GET /board/proofs/consistency",
      "GET /board/proofs/inclusion",
      "GET /elections/definition",
      "POST /ballots",
    ]);
  });
});

describe("spec ties", () => {
  test("MAX_BOARD_PAYLOAD matches docs/spec/parameters.md", () => {
    const table = readFileSync(join(repo, "docs/spec/parameters.md"), "utf8");
    const row = /^\|\s*`MAX_BOARD_PAYLOAD`\s*\|\s*([\d,]+)\s*\|/m.exec(table);
    expect(row?.[1]?.replaceAll(",", "")).toBe(String(MAX_BOARD_PAYLOAD));
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
