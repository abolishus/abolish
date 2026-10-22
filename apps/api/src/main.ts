import { createTurnstile, Tier0Registrations, Tier1Relay } from "@abolishus/core";
import { BallotQueue, ReceiptQueue } from "@abolishus/worker/ballot-queue";
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
  // `{ballot-submit}` queue, judged by the worker in batches, and share
  // receipts to its `{receipt-submit}` queue (T-52). Without it the server
  // boards no ballot and no receipt.
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
  // The operator's intake relay (docs/spec/delivery.md, Client rules 4): each
  // default-panel seat's intake endpoint as the release lists it, an https
  // URL, comma-separated, seat 1 first. Without it the route answers 503.
  API_INTAKE_ENDPOINTS: z.string().min(1).optional(),
  // The anchoring clock the worker labels board segments by, both or
  // neither, with the worker's own values: the epoch and period of the
  // anchor contract our definitions name (docs/spec/board.md, Timing).
  // Without them the listing's `answered` order answers SORT_UNAVAILABLE.
  BALLOT_ANCHOR_EPOCH: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .optional(),
  BALLOT_ANCHOR_PERIOD: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .optional(),
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
  API_INTAKE_ENDPOINTS: process.env["API_INTAKE_ENDPOINTS"],
  BALLOT_ANCHOR_EPOCH: process.env["BALLOT_ANCHOR_EPOCH"],
  BALLOT_ANCHOR_PERIOD: process.env["BALLOT_ANCHOR_PERIOD"],
});

let redis: Redis | undefined;
let ballots: BallotQueue | undefined;
let receipts: ReceiptQueue | undefined;
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
  receipts = await ReceiptQueue.open({ connection: redis });
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

// The server checks each endpoint; the relay's seat i is the panel's seat
// i, so where both are set the two lists must agree.
const intakeEndpoints = env.API_INTAKE_ENDPOINTS?.split(",");
if (
  intakeEndpoints !== undefined &&
  ceremony !== undefined &&
  ceremony.panel.keys.length !== intakeEndpoints.length
)
  throw new Error("API_INTAKE_ENDPOINTS must list one endpoint per API_CEREMONY_PANEL_KEYS key");

if ((env.BALLOT_ANCHOR_EPOCH === undefined) !== (env.BALLOT_ANCHOR_PERIOD === undefined))
  throw new Error("BALLOT_ANCHOR_EPOCH and BALLOT_ANCHOR_PERIOD go together");
const boardClock =
  env.BALLOT_ANCHOR_EPOCH === undefined || env.BALLOT_ANCHOR_PERIOD === undefined
    ? undefined
    : { epoch: BigInt(env.BALLOT_ANCHOR_EPOCH), period: BigInt(env.BALLOT_ANCHOR_PERIOD) };

const sql = postgres(env.DATABASE_URL, { onnotice: () => {} });
const server = createApiServer({
  sql,
  ...(ballots !== undefined && { ballots }),
  ...(receipts !== undefined && { receipts }),
  ...(tier0 !== undefined && { tier0 }),
  ...(tier1 !== undefined && { tier1 }),
  ...(boardClock !== undefined && { boardClock }),
  ...(env.API_CORS_ORIGINS !== undefined && { corsOrigins: env.API_CORS_ORIGINS.split(",") }),
  ...(ceremony !== undefined && { ceremony: { deployment: ceremony } }),
  ...(intakeEndpoints !== undefined && { intake: { endpoints: intakeEndpoints } }),
  log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
});
server.listen(env.API_PORT, env.API_HOST);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(
      () =>
        void Promise.all([
          sql.end(),
          Promise.all([ballots?.close(), receipts?.close()]).then(() => redis?.quit()),
        ]),
    );
  });
