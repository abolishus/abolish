// Generates the OpenAPI document for the public API from the contract. The
// build writes it to dist/ and each release publishes it; repro-build checks
// that two builds produce the same bytes.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";

import { contract } from "../src/contract.ts";

export async function generateOpenApi() {
  const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
  return generator.generate(contract, {
    info: {
      title: "Abolish public API",
      // The document's own version, not a release number, so the output
      // depends only on the contract.
      version: "1",
      description:
        "Every response is a claim by the server that answered. Check returned bytes with @abolishus/crypto against the chain and the anchored checkpoints (docs/spec/).",
      license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
    },
  });
}

/** The document as written to disk: two-space JSON with a final newline. */
export async function renderOpenApi() {
  return `${JSON.stringify(await generateOpenApi(), null, 2)}\n`;
}

if (argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  const out = argv[2];
  if (out === undefined) throw new Error("usage: openapi.ts <output.json>");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await renderOpenApi());
}
