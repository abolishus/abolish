import { BallotAdmissions } from "@abolishus/core";
import postgres from "postgres";
import * as z from "zod";
import { createApiServer } from "./server.ts";

// Entry point: reads the environment, connects as a user granted abolish_app
// (never the owner; packages/core, Database) and listens.

const Env = z.strictObject({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  // Loopback unless told otherwise: the deployment's proxy terminates TLS.
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  // Ballot admission: the trustee panels the release pins, as JSON
  // (`[{"threshold": k, "keys": ["<hex>", …]}]`, each key a seat's identity
  // key in seat order), and the anchoring clock of the anchor contract our
  // definitions name (docs/spec/board.md, Timing). Without the panels the
  // server boards no ballot.
  API_PINNED_PANELS: z.string().min(1).optional(),
  API_ANCHOR_EPOCH: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .optional(),
  API_ANCHOR_PERIOD: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .optional(),
});

const Panels = z
  .array(
    z.strictObject({
      threshold: z.number().int().min(1),
      keys: z.array(z.string().regex(/^(?:[0-9a-f]{2})+$/)).min(1),
    }),
  )
  .min(1);

const env = Env.parse({
  DATABASE_URL: process.env["DATABASE_URL"],
  API_HOST: process.env["API_HOST"],
  API_PORT: process.env["API_PORT"],
  API_PINNED_PANELS: process.env["API_PINNED_PANELS"],
  API_ANCHOR_EPOCH: process.env["API_ANCHOR_EPOCH"],
  API_ANCHOR_PERIOD: process.env["API_ANCHOR_PERIOD"],
});

let admissions: BallotAdmissions | undefined;
if (env.API_PINNED_PANELS !== undefined) {
  if (env.API_ANCHOR_EPOCH === undefined || env.API_ANCHOR_PERIOD === undefined)
    throw new Error("API_PINNED_PANELS needs API_ANCHOR_EPOCH and API_ANCHOR_PERIOD");
  admissions = new BallotAdmissions({
    panels: Panels.parse(JSON.parse(env.API_PINNED_PANELS)).map((p) => ({
      threshold: p.threshold,
      keys: p.keys.map((k) => new Uint8Array(Buffer.from(k, "hex"))),
    })),
    clock: { epoch: BigInt(env.API_ANCHOR_EPOCH), period: BigInt(env.API_ANCHOR_PERIOD) },
  });
}

const sql = postgres(env.DATABASE_URL, { onnotice: () => {} });
const server = createApiServer({
  sql,
  ...(admissions !== undefined && { admissions }),
  log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
});
server.listen(env.API_PORT, env.API_HOST);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(() => void sql.end());
  });
