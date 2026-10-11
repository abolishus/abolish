import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import {
  accountCredentials,
  accountPasskeys,
  accountSessions,
  accountUsers,
  accountVerifications,
} from "./db/schema/index.ts";

// Accounts: who someone is to the app (poll creation, moderation,
// notifications), with better-auth and passkeys. Never a voting identity:
// the voting identity and its recovery passkey live in the ballot client on
// their own RP ID, and nothing here can name a ballot, a nullifier or a poll
// someone took part in (docs/PROJECT_BRIEF.md; T-10, T-20; ADR 0017).
//
// The account system holds as little as better-auth allows: no e-mail, name,
// picture, address or user agent (the migration's checks refuse them), and
// sign-in is by passkey alone, with user verification enforced here rather
// than only asked for. apps/web serves `handler` on its own origin, which is
// the passkeys' RP ID, so the session cookie is host-only there and never
// reaches the API or the ballot client's host.

/** Every account route: `METHOD /path`. Anything else is answered 404 before better-auth sees it. */
export const ACCOUNT_ROUTES = [
  "GET /auth/get-session",
  "POST /auth/sign-out",
  "GET /auth/list-sessions",
  "POST /auth/revoke-session",
  "POST /auth/revoke-other-sessions",
  "POST /auth/delete-user",
  "GET /auth/passkey/generate-register-options",
  "POST /auth/passkey/verify-registration",
  "GET /auth/passkey/generate-authenticate-options",
  "POST /auth/passkey/verify-authentication",
  "GET /auth/passkey/list-user-passkeys",
  "POST /auth/passkey/update-passkey",
  "POST /auth/passkey/delete-passkey",
] as const;

export type AccountRoute = (typeof ACCOUNT_ROUTES)[number];

const ROUTES: ReadonlySet<string> = new Set(ACCOUNT_ROUTES);

/**
 * Every account cookie's name starts with this, after the `__Secure-` prefix
 * browsers require of a secure cookie's name. Ballot and board routes refuse
 * any request carrying one (T-10).
 */
export const ACCOUNT_COOKIE_PREFIX = "abolish-account";

/** Largest request body an account route reads: a WebAuthn response is a few KiB. */
export const MAX_ACCOUNT_BODY = 64 * 1024;

/** How long a session lasts, and how often its expiry moves forward on use. */
const SESSION_SECONDS = 14 * 24 * 60 * 60;
const SESSION_REFRESH_SECONDS = 24 * 60 * 60;

/** The label a new passkey shows in the user's passkey manager: nothing about the person. */
export const PASSKEY_USER_NAME = "Abolish account";

/** better-auth's own warnings and errors, by level only: their messages and arguments can quote input. */
export interface AccountLogLine {
  readonly auth: "warn" | "error";
}

export interface AccountsOptions {
  readonly sql: Sql;
  /** Signs cookies; at least 32 bytes of randomness, as text. */
  readonly secret: string;
  /** apps/web's origin (`https://…`), which serves `handler`: the only origin trusted for account requests. */
  readonly origin: string;
  /** The passkeys' RP ID: `origin`'s host or a registrable suffix of it, and never the ballot client's (ADR 0017). */
  readonly rpID: string;
  readonly log: (line: AccountLogLine) => void;
}

export interface Accounts {
  /** Answers one account request. Routes outside `ACCOUNT_ROUTES` get 404, bodies over `MAX_ACCOUNT_BODY` 413. */
  handler(request: Request): Promise<Response>;
  /** The signed-in account behind a request's cookies, if any. */
  accountOf(headers: Headers): Promise<string | undefined>;
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 32 characters from 36, by rejection sampling: about 165 bits. */
export function newAccountId(): string {
  let id = "";
  while (id.length < 32) {
    for (const b of crypto.getRandomValues(new Uint8Array(48))) {
      // 252 = 7 × 36: values at or above it would bias the first characters.
      if (b < 252 && id.length < 32) id += ID_ALPHABET[b % 36];
    }
  }
  return id;
}

function refuse(status: number): Response {
  return Response.json(
    { code: status === 404 ? "NOT_FOUND" : "PAYLOAD_TOO_LARGE", status },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** The body of `request`, at most `MAX_ACCOUNT_BODY` bytes, or undefined if it is longer. */
async function boundedBody(request: Request): Promise<Uint8Array | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_ACCOUNT_BODY)) return undefined;
  if (!request.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ACCOUNT_BODY) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return body;
}

export function createAccounts({ sql, secret, origin, rpID, log }: AccountsOptions): Accounts {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin)
    throw new Error("origin must be a bare https origin");
  if (url.hostname !== rpID && !url.hostname.endsWith(`.${rpID}`))
    throw new Error("rpID must be the origin's host or a suffix of it");
  if (new TextEncoder().encode(secret).length < 32)
    throw new Error("secret must be at least 32 bytes");
  // better-auth sends usage telemetry if this is set, whatever its options say.
  const telemetry = process.env["BETTER_AUTH_TELEMETRY"];
  if (telemetry !== undefined && telemetry !== "" && telemetry !== "0" && telemetry !== "false")
    throw new Error("BETTER_AUTH_TELEMETRY must not be set");

  const auth = betterAuth({
    appName: "Abolish",
    baseURL: origin,
    basePath: "/auth",
    secret,
    trustedOrigins: [origin],
    database: drizzleAdapter(drizzle({ client: sql }), {
      provider: "pg",
      schema: {
        account_users: accountUsers,
        account_sessions: accountSessions,
        account_passkeys: accountPasskeys,
        account_credentials: accountCredentials,
        account_verifications: accountVerifications,
      },
    }),
    user: { modelName: "account_users", deleteUser: { enabled: true } },
    session: {
      modelName: "account_sessions",
      expiresIn: SESSION_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
    },
    account: { modelName: "account_credentials" },
    verification: { modelName: "account_verifications", storeIdentifier: "hashed" },
    // No password, e-mail or social sign-in: passkeys only.
    emailAndPassword: { enabled: false },
    // Per-address limits belong to the proxy (P2-11); better-auth's would key
    // on addresses we don't keep (T-11, T-52).
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    experimental: { instrumentation: { enabled: false } },
    logger: {
      level: "warn",
      log: (level) => {
        if (level === "warn" || level === "error") log({ auth: level });
      },
    },
    advanced: {
      cookiePrefix: ACCOUNT_COOKIE_PREFIX,
      useSecureCookies: true,
      // better-auth turns both off under a test runner; pin them so tests see
      // what production does.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      defaultCookieAttributes: { sameSite: "strict", httpOnly: true, secure: true },
      // T-10, T-11: no address on any session, whatever headers arrive.
      ipAddress: { disableIpTracking: true },
      database: { generateId: newAccountId },
    },
    databaseHooks: {
      session: {
        create: {
          // T-10, T-11: better-auth records the user agent; we don't.
          before: async (session) => ({ data: { ...session, ipAddress: null, userAgent: null } }),
        },
      },
    },
    plugins: [
      passkey({
        rpID,
        rpName: "Abolish",
        origin,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        advanced: { webAuthnChallengeCookie: "passkey-challenge" },
        schema: { passkey: { modelName: "account_passkeys" } },
        registration: {
          // Signing up is registering a passkey: no other credential exists.
          requireSession: false,
          resolveUser: () => ({ id: newAccountId(), name: PASSKEY_USER_NAME }),
          afterVerification: async ({ ctx, verification, user }) => {
            // The plugin asks for user verification but doesn't check it.
            if (!verification.registrationInfo?.userVerified)
              throw new APIError("UNAUTHORIZED", { message: "user verification required" });
            // A signed-in user adds a passkey to their own account.
            if (await ctx.context.internalAdapter.findUserById(user.id)) return;
            const created = await ctx.context.internalAdapter.createUser(
              {
                email: `${newAccountId()}@account.invalid`,
                emailVerified: false,
                name: "",
              },
              { method: "passkey" },
            );
            return { userId: created.id };
          },
        },
        authentication: {
          afterVerification: async ({ verification }) => {
            if (!verification.authenticationInfo.userVerified)
              throw new APIError("UNAUTHORIZED", { message: "user verification required" });
          },
        },
      }),
    ],
  });

  return {
    async handler(request) {
      const path = new URL(request.url).pathname;
      if (!ROUTES.has(`${request.method} ${path}`)) return refuse(404);
      if (request.method !== "POST") return auth.handler(request);
      const body = await boundedBody(request);
      if (!body) return refuse(413);
      return auth.handler(
        new Request(request.url, { method: "POST", headers: request.headers, body }),
      );
    },
    async accountOf(headers) {
      const session = await auth.api.getSession({ headers });
      return session?.user.id;
    },
  };
}
