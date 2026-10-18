// The deployable's entry point (dist/node/main.mjs): reads the environment,
// loads the built Start server beside it, connects the account system as a
// user granted abolish_app (never the owner; packages/core, Database) and
// listens.

import { createAccounts, createTurnstile } from "@abolishus/core";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as z from "zod";

import { isSiteKey } from "../values.ts";
import { createAnalytics, noAnalytics } from "./analytics.ts";
import { createDraftsHandler } from "./drafts.ts";
import { createWebServer, type StartHandler } from "./serve.ts";

const Env = z
  .strictObject({
    DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
    // Read by the Start server's own code (src/server/api.ts); checked here so
    // a missing one fails at start, not on the first page.
    API_URL: z.url({ protocol: /^https?$/ }),
    // This site's public origin, which is the passkeys' origin.
    WEB_ORIGIN: z.url({ protocol: /^https$/ }),
    // The passkeys' RP ID: WEB_ORIGIN's host unless told otherwise, and never
    // the ballot client's (ADR 0017).
    ACCOUNT_RP_ID: z.string().min(1).optional(),
    // Signs account cookies: at least 32 bytes of randomness, as text.
    ACCOUNT_SECRET: z.string().min(32),
    // The Turnstile widget's secret key: every passkey ceremony start and
    // every poll submission needs a token solved on this site (packages/core,
    // Turnstile; T-01, T-52, T-72).
    TURNSTILE_SECRET_KEY: z.string().min(1),
    // The same widget's site key, which the poll editor renders it with
    // (src/data.ts, fetchChallengeKey). Without one the editor says polls
    // can't be submitted here; a malformed one is refused at start.
    TURNSTILE_SITE_KEY: z.string().refine(isSiteKey, "not a Turnstile site key").optional(),
    // Loopback unless told otherwise: the deployment's proxy terminates TLS.
    WEB_HOST: z.string().min(1).default("127.0.0.1"),
    WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // PostHog's ingestion origin and project key, both or neither: without
    // them nothing is reported (src/node/analytics.ts).
    POSTHOG_HOST: z.url({ protocol: /^https$/ }).optional(),
    POSTHOG_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .refine((env) => (env.POSTHOG_HOST === undefined) === (env.POSTHOG_KEY === undefined), {
    message: "POSTHOG_HOST and POSTHOG_KEY go together",
  });

const env = Env.parse({
  DATABASE_URL: process.env["DATABASE_URL"],
  API_URL: process.env["API_URL"],
  WEB_ORIGIN: process.env["WEB_ORIGIN"],
  ACCOUNT_RP_ID: process.env["ACCOUNT_RP_ID"] || undefined,
  ACCOUNT_SECRET: process.env["ACCOUNT_SECRET"],
  TURNSTILE_SECRET_KEY: process.env["TURNSTILE_SECRET_KEY"],
  TURNSTILE_SITE_KEY: process.env["TURNSTILE_SITE_KEY"] || undefined,
  WEB_HOST: process.env["WEB_HOST"],
  WEB_PORT: process.env["WEB_PORT"],
  POSTHOG_HOST: process.env["POSTHOG_HOST"] || undefined,
  POSTHOG_KEY: process.env["POSTHOG_KEY"] || undefined,
});

const write = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);

// Beside this file in dist/: node/main.mjs, server/server.js, client/.
const start = (
  (await import(new URL("../server/server.js", import.meta.url).href)) as {
    default: StartHandler;
  }
).default;

const sql = postgres(env.DATABASE_URL, { onnotice: () => {} });
const origin = new URL(env.WEB_ORIGIN).origin;
// One widget secret for every action on this site: each token is checked
// against the action it was solved for.
const turnstile = createTurnstile({
  secretKey: env.TURNSTILE_SECRET_KEY,
  hostname: new URL(env.WEB_ORIGIN).hostname,
});
const accounts = createAccounts({
  sql,
  secret: env.ACCOUNT_SECRET,
  origin,
  rpID: env.ACCOUNT_RP_ID ?? new URL(env.WEB_ORIGIN).hostname,
  turnstile,
  log: write,
});
const drafts = createDraftsHandler({
  sql,
  accountOf: (headers) => accounts.accountOf(headers),
  turnstile,
  origin,
});
const analytics =
  env.POSTHOG_HOST === undefined || env.POSTHOG_KEY === undefined
    ? noAnalytics
    : createAnalytics({
        // Refused at start unless a bare origin.
        host: env.POSTHOG_HOST,
        key: env.POSTHOG_KEY,
        log: write,
      });
const server = createWebServer({
  start,
  accounts: (request) => accounts.handler(request),
  drafts,
  clientDir: fileURLToPath(new URL("../client/", import.meta.url)),
  origin,
  log: write,
  analytics,
});
server.listen(env.WEB_PORT, env.WEB_HOST);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(() => void Promise.all([sql.end(), analytics.close()]));
  });
