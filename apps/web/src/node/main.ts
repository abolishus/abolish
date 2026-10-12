// The deployable's entry point (dist/node/main.mjs): reads the environment,
// loads the built Start server beside it, connects the account system as a
// user granted abolish_app (never the owner; packages/core, Database) and
// listens.

import { createAccounts } from "@abolishus/core";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as z from "zod";

import { createAnalytics, noAnalytics } from "./analytics.ts";
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
const accounts = createAccounts({
  sql,
  secret: env.ACCOUNT_SECRET,
  origin: new URL(env.WEB_ORIGIN).origin,
  rpID: env.ACCOUNT_RP_ID ?? new URL(env.WEB_ORIGIN).hostname,
  log: write,
});
const analytics =
  env.POSTHOG_HOST === undefined || env.POSTHOG_KEY === undefined
    ? noAnalytics
    : createAnalytics({
        host: new URL(env.POSTHOG_HOST).origin,
        key: env.POSTHOG_KEY,
        log: write,
      });
const server = createWebServer({
  start,
  accounts: (request) => accounts.handler(request),
  clientDir: fileURLToPath(new URL("../client/", import.meta.url)),
  origin: new URL(env.WEB_ORIGIN).origin,
  log: write,
  analytics,
});
server.listen(env.WEB_PORT, env.WEB_HOST);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(() => void Promise.all([sql.end(), analytics.close()]));
  });
