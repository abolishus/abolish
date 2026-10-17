import { createTurnstile, Tier0Registrations, Tier1Relay } from "@abolishus/core";
import { BallotQueue } from "@abolishus/worker/ballot-queue";
import { Redis } from "ioredis";
import postgres from "postgres";
import * as z from "zod";
import { CEREMONY_ENV, ceremonyFromEnv } from "./ceremony-env.ts";
import { createApiServer } from "./server.ts";

// Entry point: reads the environment, connects as a user granted abolish_app
// (never the owner; packages/core, Database) and listens.

const Env = z.strictObject({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  // Loopback unless told otherwise: the deployment's proxy terminates TLS.
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  // The Redis (or Dragonfly) the worker reads: ballots go to its
  // `{ballot-submit}` queue, judged by the worker in batches (T-52). Without
  // it the server boards no ballot.
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
  // Tier 0 registration (docs/spec/registration.md), all three or none, and
  // REDIS_URL, which holds its queue: the published group of region 0 as the
  // deployment record lists it, the Turnstile secret key and the challenge
  // origin's host its tokens must be solved on. Without them the route
  // answers REGISTRATION_UNAVAILABLE.
  API_TIER0_GROUP: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .optional(),
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  API_CHALLENGE_HOST: z.string().min(1).optional(),
  // The Tier 1 relay (docs/spec/tier1-relay.md): the published Tier 1 group
  // of region 0, with REDIS_URL, which holds its queue, and the same
  // Turnstile secret key and challenge host. Without it the route answers
  // RELAY_UNAVAILABLE.
  API_TIER1_GROUP: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .optional(),
  // The ballot client's origins, comma-separated, whose pages may read the
  // API's answers (CORS); the server checks each is an exact origin.
  API_CORS_ORIGINS: z.string().min(1).optional(),
});

const env = Env.parse({
  DATABASE_URL: process.env["DATABASE_URL"],
  API_HOST: process.env["API_HOST"],
  API_PORT: process.env["API_PORT"],
  REDIS_URL: process.env["REDIS_URL"],
  API_TIER0_GROUP: process.env["API_TIER0_GROUP"],
  TURNSTILE_SECRET_KEY: process.env["TURNSTILE_SECRET_KEY"],
  API_CHALLENGE_HOST: process.env["API_CHALLENGE_HOST"],
  API_TIER1_GROUP: process.env["API_TIER1_GROUP"],
  API_CORS_ORIGINS: process.env["API_CORS_ORIGINS"],
});

let redis: Redis | undefined;
let ballots: BallotQueue | undefined;
if (env.REDIS_URL !== undefined) {
  // Fail fast while Redis is down or stalled, so a request answers
  // unavailable within a second rather than hold one of the server's slots
  // until its deadline (T-52).
  redis = new Redis(env.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
  });
  // Without a listener an 'error' event would crash the process; its message
  // can quote a command's arguments, a commitment or a ballot among them (T-11).
  redis.on("error", () => process.stdout.write(`${JSON.stringify({ error: "redis" })}\n`));
  ballots = await BallotQueue.open({ connection: redis });
}

const tier0Env = [env.API_TIER0_GROUP, env.TURNSTILE_SECRET_KEY, env.API_CHALLENGE_HOST];
let tier0: Tier0Registrations | undefined;
if (tier0Env.some((v) => v !== undefined)) {
  if (
    redis === undefined ||
    env.API_TIER0_GROUP === undefined ||
    env.TURNSTILE_SECRET_KEY === undefined ||
    env.API_CHALLENGE_HOST === undefined
  )
    throw new Error(
      "API_TIER0_GROUP, TURNSTILE_SECRET_KEY and API_CHALLENGE_HOST go together, with REDIS_URL",
    );
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

let tier1: Tier1Relay | undefined;
if (env.API_TIER1_GROUP !== undefined) {
  if (
    redis === undefined ||
    env.TURNSTILE_SECRET_KEY === undefined ||
    env.API_CHALLENGE_HOST === undefined
  )
    throw new Error("API_TIER1_GROUP needs TURNSTILE_SECRET_KEY, API_CHALLENGE_HOST and REDIS_URL");
  tier1 = new Tier1Relay({
    redis,
    groups: new Map([[0, BigInt(env.API_TIER1_GROUP)]]),
    turnstile: createTurnstile({
      secretKey: env.TURNSTILE_SECRET_KEY,
      hostname: env.API_CHALLENGE_HOST,
    }),
    now: () => Math.floor(Date.now() / 1000),
  });
}

// The key ceremony's coordinator (P2-22 part 4c-2): the default panel's
// seats poll it here, beside the worker that opens runs and closes rounds.
// Without its variables the routes answer 503.
const ceremony = ceremonyFromEnv(
  Object.fromEntries(CEREMONY_ENV.map((name) => [name, process.env[name]])),
);

const sql = postgres(env.DATABASE_URL, { onnotice: () => {} });
const server = createApiServer({
  sql,
  ...(ballots !== undefined && { ballots }),
  ...(tier0 !== undefined && { tier0 }),
  ...(tier1 !== undefined && { tier1 }),
  ...(env.API_CORS_ORIGINS !== undefined && { corsOrigins: env.API_CORS_ORIGINS.split(",") }),
  ...(ceremony !== undefined && { ceremony: { deployment: ceremony } }),
  log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
});
server.listen(env.API_PORT, env.API_HOST);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(() => void Promise.all([sql.end(), ballots?.close().then(() => redis?.quit())]));
  });
