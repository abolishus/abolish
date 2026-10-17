import { BallotAdmissions, createTurnstile, Tier0Registrations } from "@abolishus/core";
import { Redis } from "ioredis";
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
  // Tier 0 registration (docs/spec/registration.md), all four or none: the
  // Redis (or Dragonfly) holding the queue, the published group of region 0
  // as the deployment record lists it, the Turnstile secret key and the
  // challenge origin's host its tokens must be solved on. Without them the
  // route answers REGISTRATION_UNAVAILABLE.
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
  API_TIER0_GROUP: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .optional(),
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  API_CHALLENGE_HOST: z.string().min(1).optional(),
  // The ballot client's origins, comma-separated, whose pages may read the
  // API's answers (CORS); the server checks each is an exact origin.
  API_CORS_ORIGINS: z.string().min(1).optional(),
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
  REDIS_URL: process.env["REDIS_URL"],
  API_TIER0_GROUP: process.env["API_TIER0_GROUP"],
  TURNSTILE_SECRET_KEY: process.env["TURNSTILE_SECRET_KEY"],
  API_CHALLENGE_HOST: process.env["API_CHALLENGE_HOST"],
  API_CORS_ORIGINS: process.env["API_CORS_ORIGINS"],
});

let admissions: BallotAdmissions | undefined;
if (
  env.API_PINNED_PANELS === undefined &&
  (env.API_ANCHOR_EPOCH !== undefined || env.API_ANCHOR_PERIOD !== undefined)
)
  // A clock without panels is a misconfiguration that would board nothing.
  throw new Error("API_ANCHOR_EPOCH and API_ANCHOR_PERIOD need API_PINNED_PANELS");
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

const tier0Env = [
  env.REDIS_URL,
  env.API_TIER0_GROUP,
  env.TURNSTILE_SECRET_KEY,
  env.API_CHALLENGE_HOST,
];
let redis: Redis | undefined;
let tier0: Tier0Registrations | undefined;
if (tier0Env.some((v) => v !== undefined)) {
  if (
    env.REDIS_URL === undefined ||
    env.API_TIER0_GROUP === undefined ||
    env.TURNSTILE_SECRET_KEY === undefined ||
    env.API_CHALLENGE_HOST === undefined
  )
    throw new Error(
      "REDIS_URL, API_TIER0_GROUP, TURNSTILE_SECRET_KEY and API_CHALLENGE_HOST go together",
    );
  // Fail fast while Redis is down or stalled, so a registration answers
  // unavailable within a second rather than hold one of the server's slots
  // until its deadline (T-52).
  redis = new Redis(env.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
  });
  // Without a listener an 'error' event would crash the process; its message
  // can quote a command's arguments, a commitment among them (T-11).
  redis.on("error", () => process.stdout.write(`${JSON.stringify({ error: "redis" })}\n`));
  tier0 = new Tier0Registrations({
    redis,
    groups: new Map([[0, BigInt(env.API_TIER0_GROUP)]]),
    turnstile: createTurnstile({
      secretKey: env.TURNSTILE_SECRET_KEY,
      hostname: env.API_CHALLENGE_HOST,
    }),
    now: () => Math.floor(Date.now() / 1000),
  });
}

const sql = postgres(env.DATABASE_URL, { onnotice: () => {} });
const server = createApiServer({
  sql,
  ...(admissions !== undefined && { admissions }),
  ...(tier0 !== undefined && { tier0 }),
  ...(env.API_CORS_ORIGINS !== undefined && { corsOrigins: env.API_CORS_ORIGINS.split(",") }),
  log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
});
server.listen(env.API_PORT, env.API_HOST);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(() => void Promise.all([sql.end(), redis?.quit()]));
  });
