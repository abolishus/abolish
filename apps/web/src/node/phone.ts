// An account's phone number, under /phone on apps/web's origin
// ([[0038-verified-accounts]], Phone codes; P2-31 part 3b): read the day the
// verified number was verified, ask for a code to a number, and enter the
// code with the number again (nothing stored can give the number back). The
// account system lives here, so these routes are here too, never on the API
// (T-10, ADR 0017). This transport parses, asks core and serialises; the
// rules are packages/core's (src/account-phones.ts).
//
// T-11, T-73: a request for a code answers the same whether a code went or
// the number's daily cap kept it back, and whoever holds the number. Core
// calls the provider's `start` only for an uncapped number, so a request
// that waited for it would answer a capped number faster, and a failed send
// (`send-unavailable`) could only be an uncapped one's. So `start` is called
// after the answer, never before it (`afterAnswer`), and a failed send
// reaches only the operator's log, by kind. The lookup before it is made for
// every number, capped or not, and its refusals (a virtual line, a country
// not served) are the ADR's to show in plain words.
//
// T-10, T-11, T-67: a request's session names its account and nothing else
// is read from it; answers are no-store, and the request log keeps only the
// route class: never the number or the code. CSRF: the session cookie is
// SameSite=Strict, and every POST must also carry our own Origin. T-52: a
// request for a code costs a Turnstile solve for `phone-code`, and every
// limit, the daily ceiling across accounts among them, is core's.

import {
  type Keyring,
  type PhoneVerifier,
  PhoneVerificationError,
  type PhoneVerificationErrorCode,
  readAccountPhone,
  requestPhoneCode,
  type Turnstile,
  TURNSTILE_HEADER,
  verifyPhoneCode,
} from "@abolishus/core";
import type { Sql } from "postgres";
import * as z from "zod";

/** Every phone route: `METHOD /path`. Anything else is answered 404. */
export const PHONE_ROUTES = ["GET /phone", "POST /phone/request", "POST /phone/verify"] as const;

const ROUTES: ReadonlySet<string> = new Set(PHONE_ROUTES);

/** What the routes need to verify a number; without it every route answers 503. */
export interface PhoneService {
  /** The phone-hash keyring, shared with no other use. */
  readonly keys: Keyring;
  readonly verifier: PhoneVerifier;
  /** Requests every account together may make in any 24 hours (T-52). */
  readonly dailyCeiling: number;
}

export interface PhoneOptions {
  readonly sql: Sql;
  /** The signed-in account behind a request's cookies (`Accounts.accountOf`). */
  readonly accountOf: (headers: Headers) => Promise<string | undefined>;
  /** The keyring and the provider, if this deployment has them. */
  readonly service: PhoneService | undefined;
  /** Checks the `phone-code` token a request for a code carries in `TURNSTILE_HEADER`. */
  readonly turnstile: Turnstile;
  /** apps/web's origin: every POST must come from it. */
  readonly origin: string;
  /** Where a send the provider didn't take is reported, by kind only. */
  readonly log: (line: { readonly error: string }) => void;
  /** The clock; the system's by default. Injected so tests can set it. */
  readonly now?: () => Date;
}

// Transport bounds only, generous over core's (a number as typed is at most
// 64 characters, a code 10 digits with any spaces or hyphens): what is
// acceptable is core's.
const Inputs = {
  "POST /phone/request": z.strictObject({ number: z.string().max(256) }),
  "POST /phone/verify": z.strictObject({ number: z.string().max(256), code: z.string().max(64) }),
} as const;

/**
 * `verifier`, with `start` called without waiting: every send is taken as
 * `sent` at once, and one the provider didn't take is logged by kind only.
 * `lookup` and `check` are the provider's own, awaited.
 */
function afterAnswer(verifier: PhoneVerifier, log: PhoneOptions["log"]): PhoneVerifier {
  const failed = () => log({ error: "PhoneSendUnavailable" });
  return {
    lookup: (number) => verifier.lookup(number),
    check: (number, code) => verifier.check(number, code),
    start: async (number, channel) => {
      verifier
        .start(number, channel)
        .then((outcome) => outcome === "sent" || failed(), failed)
        // Nothing may reject unobserved here: an unhandled rejection stops Node.
        .catch(() => {});
      return "sent";
    },
  };
}

const answer = (status: number, body: object) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refuse = (status: number, code: string, extra: object = {}) =>
  answer(status, { code, status, ...extra });

// `afterAnswer`'s verifier always starts `sent`, so core never throws `send-unavailable`.
export const ERRORS: Record<
  Exclude<PhoneVerificationErrorCode, "send-unavailable">,
  [number, string]
> = {
  "invalid-number": [422, "INVALID_NUMBER"],
  "too-many-this-hour": [429, "TOO_MANY_THIS_HOUR"],
  "too-many-today": [429, "TOO_MANY_TODAY"],
  "service-busy": [503, "SERVICE_BUSY"],
  "challenge-refused": [403, "TURNSTILE_REFUSED"],
  "challenge-unavailable": [503, "TURNSTILE_UNAVAILABLE"],
  "lookup-unavailable": [503, "LOOKUP_UNAVAILABLE"],
  "unsupported-country": [422, "UNSUPPORTED_COUNTRY"],
  "virtual-number": [422, "VIRTUAL_NUMBER"],
  "no-code": [409, "NO_CODE"],
  expired: [409, "EXPIRED"],
  "wrong-code": [422, "WRONG_CODE"],
  "too-many-tries": [409, "TOO_MANY_TRIES"],
  "check-unavailable": [503, "CHECK_UNAVAILABLE"],
  "number-held": [409, "NUMBER_HELD"],
};

/** The phone handler: answers every route in `PHONE_ROUTES` for the signed-in account. */
export function createPhoneHandler({
  sql,
  accountOf,
  service,
  turnstile,
  origin,
  log,
  now = () => new Date(),
}: PhoneOptions): (request: Request) => Promise<Response> {
  const phoning: PhoneService | undefined =
    service === undefined
      ? undefined
      : { ...service, verifier: afterAnswer(service.verifier, log) };
  return async (request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (!ROUTES.has(route) || url.search !== "") return refuse(404, "NOT_FOUND");
    if (request.method === "POST") {
      // A browser sends Origin on every POST; another site's form or script can't send ours.
      if (request.headers.get("origin") !== origin) return refuse(403, "FORBIDDEN_ORIGIN");
      if (request.headers.get("content-type") !== "application/json")
        return refuse(415, "UNSUPPORTED_MEDIA_TYPE");
    }
    const account = await accountOf(request.headers);
    if (account === undefined) return refuse(401, "SIGNED_OUT");
    if (phoning === undefined) return refuse(503, "PHONE_UNAVAILABLE");
    if (route === "GET /phone") {
      const phone = await readAccountPhone(sql, account);
      // The day only, as core keeps it: the number itself is gone.
      return answer(
        200,
        phone === undefined ? {} : { verifiedOn: phone.verifiedOn.toISOString().slice(0, 10) },
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return refuse(400, "BAD_REQUEST");
    }
    try {
      switch (route) {
        case "POST /phone/request": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          await requestPhoneCode(sql, account, input.data.number, {
            ...phoning,
            turnstile,
            token: request.headers.get(TURNSTILE_HEADER),
            now: now(),
          });
          return answer(202, {});
        }
        case "POST /phone/verify": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          await verifyPhoneCode(sql, account, input.data.number, input.data.code, {
            keys: phoning.keys,
            verifier: phoning.verifier,
            now: now(),
          });
          return answer(200, {});
        }
      }
      return refuse(404, "NOT_FOUND");
    } catch (e) {
      if (!(e instanceof PhoneVerificationError) || e.code === "send-unavailable") throw e;
      const [status, code] = ERRORS[e.code];
      return refuse(status, code, e.triesLeft === undefined ? {} : { triesLeft: e.triesLeft });
    }
  };
}
