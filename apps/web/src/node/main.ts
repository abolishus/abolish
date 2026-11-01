// The deployable's entry point (dist/node/main.mjs): reads the environment,
// loads the built Start server beside it, connects the account system as a
// user granted abolish_app (never the owner; packages/core, Database) and
// listens.

import {
  askedBy,
  assertDistinctKeyrings,
  checkEmailKeys,
  checkPhoneKeys,
  checkTier0IssuerDeployment,
  createAccounts,
  createPostmarkSender,
  createTurnstile,
  createTwilioVerifier,
  createWebPushSender,
  emailKeys,
  type Keyring,
  parseKeyring,
  parseTier0IssuerKeys,
  readProfile,
  type PushSender,
  type Tier0Issuer,
  tier0Issuer,
  vapidKeys,
  vapidPublicKey,
} from "@abolishus/core";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as z from "zod";

import { createApi } from "../server/api.ts";
import type { ReadAskedBy, ReadProfile } from "../server/load.ts";
import { ballotBase, fromHex, isSiteKey, toHex } from "../values.ts";
import { createAnalytics, noAnalytics } from "./analytics.ts";
import { createDraftsHandler } from "./drafts.ts";
import { createEmailHandler, type EmailService } from "./email.ts";
import { resultsInFrom, startResultsLanding } from "./landing.ts";
import { createPhoneHandler, type PhoneService } from "./phone.ts";
import { startAccountPrune } from "./prune.ts";
import { createExportHandler } from "./export.ts";
import { createFollowsHandler } from "./follows.ts";
import { createProfilesHandler } from "./profiles.ts";
import { createPushHandler } from "./push.ts";
import { createReactionsHandler } from "./reactions.ts";
import { createWebServer, type StartHandler } from "./serve.ts";
import { createTokenHandler } from "./token.ts";

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
    // The ballot client's address, which the stream's cards link to with the
    // poll in the fragment (src/values.ts, ballotLink). Read by the Start
    // server's own code (src/data.ts, fetchStream); without one the cards
    // link only to each poll's page, and a malformed one is refused at start.
    BALLOT_URL: z
      .string()
      .refine(
        (url) => ballotBase(url) !== undefined,
        "not an https URL without a query or fragment",
      )
      .optional(),
    // An account's e-mail address (src/node/email.ts; ADR 0038, Email): the
    // keyrings its hash and its ciphertext are made under (`id:hex,…`,
    // packages/core's src/keyring.ts; each key in one ring only), and the
    // Postmark server token and sender address. All four or none: without
    // them every /email route answers 503. Staging uses Postmark's test
    // token, which takes messages and sends none.
    EMAIL_HASH_KEYS: z.string().min(1).optional(),
    EMAIL_BOX_KEYS: z.string().min(1).optional(),
    POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(1).optional(),
    // An account's phone number (src/node/phone.ts; ADR 0038, Phone codes):
    // the keyring its hash chain is made under (its own keys, in no other
    // ring, every one kept for good, oldest first), the Twilio API key and
    // Verify service, and how many codes every account together may ask for
    // in 24 hours (T-52). All five or none: without them every /phone route
    // answers 503.
    // Whether voting needs a verified phone ([[0038-verified-accounts]],
    // Owner decision (2026-10-22)): `on` or `off`, off unless set, and `on`
    // only with the five above. Off, the token issuer asks for a verified
    // e-mail alone, no page asks for a number and every /phone route answers
    // 503, though phone-hash keys still rotate and holds still age, so turning
    // it off and on again frees no number early (T-01, T-73).
    PHONE_VERIFICATION: z.enum(["on", "off"]).default("off"),
    PHONE_HASH_KEYS: z.string().min(1).optional(),
    TWILIO_KEY_SID: z.string().min(1).optional(),
    TWILIO_KEY_SECRET: z.string().min(1).optional(),
    TWILIO_VERIFY_SERVICE_SID: z.string().min(1).optional(),
    PHONE_DAILY_CEILING: z.coerce.number().int().min(1).optional(),
    // The Tier 0 token issuer (src/node/token.ts; [[tier0-token]]): its keys
    // (`period:hex,…`, each period's `skS`, held here apart from every other
    // secret, T-74), and the deployment record's L2 chain ID, group registry
    // and region 0's Tier 0 group, which every token's group `info` binds;
    // and that record itself, the version-2 deployment record the release
    // names, as lowercase hex, which every held key must be listed in, for
    // its period and not retired, or the site doesn't start (T-74). All five
    // or none: without them POST /token answers 503.
    TIER0_ISSUER_KEYS: z.string().min(1).optional(),
    TIER0_CHAIN_ID: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,19})$/)
      .optional(),
    TIER0_GROUP_REGISTRY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    TIER0_GROUP: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,19})$/)
      .optional(),
    TIER0_DEPLOYMENT_RECORD: z
      .string()
      .regex(/^(?:[0-9a-f]{2})+$/)
      .optional(),
    // Web push beside the moderation notices' e-mail (src/node/push.ts;
    // packages/core, src/web-push.ts; T-76): the VAPID secret key (a P-256
    // scalar as unpadded base64url, held here apart from every other secret)
    // and the contact the push services may reach us at (`mailto:` or an
    // https URL). Both or neither, and only with the e-mail service, which
    // sends the notices a push goes beside: without them every /push route
    // answers 503 and the account page offers no push.
    VAPID_SECRET_KEY: z.string().min(1).optional(),
    VAPID_SUBJECT: z.string().min(1).optional(),
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
  })
  .refine(
    (env) =>
      new Set(
        [env.EMAIL_HASH_KEYS, env.EMAIL_BOX_KEYS, env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM].map(
          (v) => v === undefined,
        ),
      ).size === 1,
    {
      message: "EMAIL_HASH_KEYS, EMAIL_BOX_KEYS, POSTMARK_SERVER_TOKEN and EMAIL_FROM go together",
    },
  )
  .refine(
    (env) =>
      new Set(
        [
          env.PHONE_HASH_KEYS,
          env.TWILIO_KEY_SID,
          env.TWILIO_KEY_SECRET,
          env.TWILIO_VERIFY_SERVICE_SID,
          env.PHONE_DAILY_CEILING,
        ].map((v) => v === undefined),
      ).size === 1,
    {
      message:
        "PHONE_HASH_KEYS, TWILIO_KEY_SID, TWILIO_KEY_SECRET, TWILIO_VERIFY_SERVICE_SID and PHONE_DAILY_CEILING go together",
    },
  )
  .refine((env) => env.PHONE_VERIFICATION === "off" || env.PHONE_HASH_KEYS !== undefined, {
    message: "PHONE_VERIFICATION=on needs PHONE_HASH_KEYS and the phone provider's settings",
  })
  .refine((env) => (env.VAPID_SECRET_KEY === undefined) === (env.VAPID_SUBJECT === undefined), {
    message: "VAPID_SECRET_KEY and VAPID_SUBJECT go together",
  })
  .refine((env) => env.VAPID_SECRET_KEY === undefined || env.EMAIL_FROM !== undefined, {
    message: "VAPID_SECRET_KEY needs the e-mail service, whose notices a push goes beside",
  })
  .refine(
    (env) =>
      new Set(
        [
          env.TIER0_ISSUER_KEYS,
          env.TIER0_CHAIN_ID,
          env.TIER0_GROUP_REGISTRY,
          env.TIER0_GROUP,
          env.TIER0_DEPLOYMENT_RECORD,
        ].map((v) => v === undefined),
      ).size === 1,
    {
      message:
        "TIER0_ISSUER_KEYS, TIER0_CHAIN_ID, TIER0_GROUP_REGISTRY, TIER0_GROUP and TIER0_DEPLOYMENT_RECORD go together",
    },
  );

const env = Env.parse({
  DATABASE_URL: process.env["DATABASE_URL"],
  API_URL: process.env["API_URL"],
  WEB_ORIGIN: process.env["WEB_ORIGIN"],
  ACCOUNT_RP_ID: process.env["ACCOUNT_RP_ID"] || undefined,
  ACCOUNT_SECRET: process.env["ACCOUNT_SECRET"],
  TURNSTILE_SECRET_KEY: process.env["TURNSTILE_SECRET_KEY"],
  TURNSTILE_SITE_KEY: process.env["TURNSTILE_SITE_KEY"] || undefined,
  BALLOT_URL: process.env["BALLOT_URL"] || undefined,
  WEB_HOST: process.env["WEB_HOST"],
  WEB_PORT: process.env["WEB_PORT"],
  POSTHOG_HOST: process.env["POSTHOG_HOST"] || undefined,
  POSTHOG_KEY: process.env["POSTHOG_KEY"] || undefined,
  EMAIL_HASH_KEYS: process.env["EMAIL_HASH_KEYS"] || undefined,
  EMAIL_BOX_KEYS: process.env["EMAIL_BOX_KEYS"] || undefined,
  POSTMARK_SERVER_TOKEN: process.env["POSTMARK_SERVER_TOKEN"] || undefined,
  EMAIL_FROM: process.env["EMAIL_FROM"] || undefined,
  PHONE_HASH_KEYS: process.env["PHONE_HASH_KEYS"] || undefined,
  TWILIO_KEY_SID: process.env["TWILIO_KEY_SID"] || undefined,
  TWILIO_KEY_SECRET: process.env["TWILIO_KEY_SECRET"] || undefined,
  TWILIO_VERIFY_SERVICE_SID: process.env["TWILIO_VERIFY_SERVICE_SID"] || undefined,
  PHONE_DAILY_CEILING: process.env["PHONE_DAILY_CEILING"] || undefined,
  PHONE_VERIFICATION: process.env["PHONE_VERIFICATION"] || undefined,
  TIER0_ISSUER_KEYS: process.env["TIER0_ISSUER_KEYS"] || undefined,
  TIER0_CHAIN_ID: process.env["TIER0_CHAIN_ID"] || undefined,
  TIER0_GROUP_REGISTRY: process.env["TIER0_GROUP_REGISTRY"] || undefined,
  TIER0_GROUP: process.env["TIER0_GROUP"] || undefined,
  TIER0_DEPLOYMENT_RECORD: process.env["TIER0_DEPLOYMENT_RECORD"] || undefined,
  VAPID_SECRET_KEY: process.env["VAPID_SECRET_KEY"] || undefined,
  VAPID_SUBJECT: process.env["VAPID_SUBJECT"] || undefined,
});

/** Runs `make`, naming `name` and never the value in any failure: a key or a token (T-65). */
function attempt<T>(name: string, make: () => T): T {
  try {
    return make();
  } catch (e) {
    throw new Error(`${name}: ${e instanceof Error ? e.message : "invalid"}`);
  }
}

/** The e-mail service's keyrings, if configured. */
function emailKeyrings(): { readonly hash: Keyring; readonly box: Keyring } | undefined {
  const { EMAIL_HASH_KEYS, EMAIL_BOX_KEYS } = env;
  if (EMAIL_HASH_KEYS === undefined || EMAIL_BOX_KEYS === undefined) return undefined;
  return {
    hash: attempt("EMAIL_HASH_KEYS", () => parseKeyring(EMAIL_HASH_KEYS)),
    box: attempt("EMAIL_BOX_KEYS", () => parseKeyring(EMAIL_BOX_KEYS)),
  };
}

/**
 * The e-mail service, if configured. Each failure names the variable,
 * never its value, which is a key or a token (T-65).
 */
function emailService(): EmailService | undefined {
  const { EMAIL_HASH_KEYS, EMAIL_BOX_KEYS, POSTMARK_SERVER_TOKEN, EMAIL_FROM } = env;
  if (
    EMAIL_HASH_KEYS === undefined ||
    EMAIL_BOX_KEYS === undefined ||
    POSTMARK_SERVER_TOKEN === undefined ||
    EMAIL_FROM === undefined
  )
    return undefined;
  // Defined whenever the two variables are.
  const { hash, box } = emailKeyrings()!;
  return {
    keys: attempt("EMAIL_HASH_KEYS and EMAIL_BOX_KEYS", () => emailKeys(hash, box)),
    // Its errors name the option (`serverToken`, `from`), never the value.
    sender: attempt("POSTMARK_SERVER_TOKEN or EMAIL_FROM", () =>
      createPostmarkSender({ serverToken: POSTMARK_SERVER_TOKEN, from: EMAIL_FROM }),
    ),
  };
}

/** The phone service, if configured; each failure names the variable, never its value (T-65). */
function phoneService(): PhoneService | undefined {
  const {
    PHONE_HASH_KEYS,
    TWILIO_KEY_SID,
    TWILIO_KEY_SECRET,
    TWILIO_VERIFY_SERVICE_SID,
    PHONE_DAILY_CEILING,
  } = env;
  if (
    PHONE_HASH_KEYS === undefined ||
    TWILIO_KEY_SID === undefined ||
    TWILIO_KEY_SECRET === undefined ||
    TWILIO_VERIFY_SERVICE_SID === undefined ||
    PHONE_DAILY_CEILING === undefined
  )
    return undefined;
  const keys = attempt("PHONE_HASH_KEYS", () => parseKeyring(PHONE_HASH_KEYS));
  const email = emailKeyrings();
  // ADR 0038, Keys: each key in one ring only, so a phone hash is never an e-mail one.
  attempt("PHONE_HASH_KEYS and the e-mail keyrings", () =>
    assertDistinctKeyrings(keys, ...(email === undefined ? [] : [email.hash, email.box])),
  );
  return {
    keys,
    // Its errors name the option (`keySid`, …), never the value.
    verifier: attempt("TWILIO_KEY_SID, TWILIO_KEY_SECRET or TWILIO_VERIFY_SERVICE_SID", () =>
      createTwilioVerifier({
        keySid: TWILIO_KEY_SID,
        keySecret: TWILIO_KEY_SECRET,
        verifyServiceSid: TWILIO_VERIFY_SERVICE_SID,
      }),
    ),
    dailyCeiling: PHONE_DAILY_CEILING,
  };
}

/**
 * The Tier 0 token issuer, if configured. Its keys' errors name an entry's
 * position, never its text, which is a key (T-65, T-74); a key past its
 * redemption window, or one the release's deployment record doesn't list
 * for its period or lists retired, is refused here, at start.
 */
function tokenIssuer(): Tier0Issuer | undefined {
  const {
    TIER0_ISSUER_KEYS,
    TIER0_CHAIN_ID,
    TIER0_GROUP_REGISTRY,
    TIER0_GROUP,
    TIER0_DEPLOYMENT_RECORD,
  } = env;
  if (
    TIER0_ISSUER_KEYS === undefined ||
    TIER0_CHAIN_ID === undefined ||
    TIER0_GROUP_REGISTRY === undefined ||
    TIER0_GROUP === undefined ||
    TIER0_DEPLOYMENT_RECORD === undefined
  )
    return undefined;
  const keys = attempt("TIER0_ISSUER_KEYS", () => parseTier0IssuerKeys(TIER0_ISSUER_KEYS));
  const issuer = attempt("TIER0_ISSUER_KEYS, TIER0_CHAIN_ID or TIER0_GROUP", () =>
    tier0Issuer({
      keys,
      chainId: BigInt(TIER0_CHAIN_ID),
      groupRegistry: Uint8Array.from(Buffer.from(TIER0_GROUP_REGISTRY.slice(2), "hex")),
      groups: new Map([[0, BigInt(TIER0_GROUP)]]),
      now: new Date(),
      phoneVerification: env.PHONE_VERIFICATION === "on",
    }),
  );
  // Its errors name a period or a rule, never a key.
  attempt("TIER0_DEPLOYMENT_RECORD", () =>
    checkTier0IssuerDeployment(
      issuer,
      Uint8Array.from(Buffer.from(TIER0_DEPLOYMENT_RECORD, "hex")),
    ),
  );
  return issuer;
}

/**
 * The push sender and the public key browsers subscribe with, if configured.
 * Each failure names the variable, never its value (T-65).
 */
function webPush(): { readonly sender: PushSender; readonly publicKey: string } | undefined {
  const { VAPID_SECRET_KEY, VAPID_SUBJECT } = env;
  if (VAPID_SECRET_KEY === undefined || VAPID_SUBJECT === undefined) return undefined;
  const keys = attempt("VAPID_SECRET_KEY", () => vapidKeys(VAPID_SECRET_KEY));
  return {
    sender: attempt("VAPID_SECRET_KEY or VAPID_SUBJECT", () =>
      createWebPushSender({ secretKey: VAPID_SECRET_KEY, subject: VAPID_SUBJECT }),
    ),
    publicKey: vapidPublicKey(keys),
  };
}

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
const api = createApi(env.API_URL);
const drafts = createDraftsHandler({
  sql,
  accountOf: (headers) => accounts.accountOf(headers),
  turnstile,
  origin,
  answered: async (electionIds) =>
    (await api.elections.getAnsweredMany({ electionIds: [...electionIds] })).elections,
});
const emailVerification = emailService();
const email = createEmailHandler({
  sql,
  accountOf: (headers) => accounts.accountOf(headers),
  service: emailVerification,
  turnstile,
  origin,
  log: write,
});
const phoneProvider = phoneService();
const phone = createPhoneHandler({
  sql,
  accountOf: (headers) => accounts.accountOf(headers),
  // Off, no number goes to the provider: the routes answer as unconfigured.
  service: env.PHONE_VERIFICATION === "on" ? phoneProvider : undefined,
  turnstile,
  origin,
  log: write,
});
const token = createTokenHandler({
  sql,
  accountOf: (headers) => accounts.accountOf(headers),
  issuer: tokenIssuer(),
  origin,
});
const reactions = createReactionsHandler({
  sql,
  accountOf: (headers) => accounts.accountOf(headers),
  origin,
});
const follows = createFollowsHandler({
  sql,
  accountOf: (headers) => accounts.accountOf(headers),
  origin,
});
const profiles = createProfilesHandler({
  sql,
  accountOf: (headers) => accounts.accountOf(headers),
  origin,
});
// Without the e-mail service the export gives a verified address as `null`.
const accountExport = createExportHandler({
  sql,
  accountOf: (headers) => accounts.accountOf(headers),
  emailKeys: emailVerification?.keys,
  origin,
});
const pushService = webPush();
const push = createPushHandler({
  sql,
  accountOf: (headers) => accounts.accountOf(headers),
  publicKey: pushService?.publicKey,
  origin,
});
// A profile's page reads it by its public handle alone, never with a
// session (pages never get the cookie), from the account side the API never
// reads (T-10; [[0040-creator-profiles]]).
const publicProfile: ReadProfile = async (handle) => {
  const p = await readProfile(sql, handle);
  if (p === undefined || p.state === "hidden") return p;
  return { state: "visible", handle: p.handle, name: p.name, polls: p.polls.map(toHex) };
};
// A poll's page and card say who asked it, read by the poll's public ID
// alone, as the profile is by its handle (T-10).
const pollAskedBy: ReadAskedBy = (electionId) => askedBy(sql, fromHex(electionId));
// A key retyped under its ID matches nothing made or rotated under the right
// bytes, so through it an address or number another account holds would
// verify again (T-01; the account-keys runbook): an instance holding one
// doesn't start.
if (emailVerification !== undefined && (await checkEmailKeys(sql, emailVerification.keys)) > 0)
  throw new Error(
    "EMAIL_HASH_KEYS or EMAIL_BOX_KEYS: a key differs from the one its ID was first seen with",
  );
if (phoneProvider !== undefined && (await checkPhoneKeys(sql, phoneProvider.keys)) > 0)
  throw new Error("PHONE_HASH_KEYS: a key differs from the one its ID was first seen with");
const prune = startAccountPrune({
  sql,
  log: write,
  ...(phoneProvider === undefined ? {} : { phoneKeys: phoneProvider.keys }),
  // The plain Postmark sender, never the /email routes' wrapper, which
  // answers `sent` for every message: a refused notice is tried again.
  ...(emailVerification === undefined
    ? {}
    : { emailKeys: emailVerification.keys, noticeSender: emailVerification.sender }),
  ...(pushService === undefined ? {} : { pushSender: pushService.sender }),
});
// Followed polls' results, read from the API by each poll's ID alone, as
// the poll page reads them (T-10); landing one queues its followers' notices,
// which the prune timer sends where the e-mail service is configured.
const landing = startResultsLanding({
  sql,
  resultsIn: resultsInFrom(api),
  log: write,
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
  email,
  phone,
  token,
  reactions,
  follows,
  profiles,
  accountExport,
  push,
  context: { readProfile: publicProfile, readAskedBy: pollAskedBy },
  clientDir: fileURLToPath(new URL("../client/", import.meta.url)),
  origin,
  log: write,
  analytics,
});
server.listen(env.WEB_PORT, env.WEB_HOST);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(
      () =>
        void Promise.all([prune.stop(), landing.stop()]).then(() =>
          Promise.all([sql.end(), analytics.close()]),
        ),
    );
  });
