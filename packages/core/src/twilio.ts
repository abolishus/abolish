// The phone provider behind `PhoneVerifier` ([[0038-verified-accounts]],
// Phone codes and the line-type check; P2-31 part 3b): Twilio Lookup v2's
// line-type intelligence, then Twilio Verify, which makes, sends and checks
// the code, so we hold none.
//
// T-73: Twilio is told a number, a channel and the code typed, never an
// account, a poll or a ballot; no custom field, friendly name or locale goes
// with them. T-01: Verify keeps one code per number and caps the checks
// against it (5 per verification, the service's default), and a check past
// that cap is `wrong`, so the many accounts that may each ask for a code to
// one number share Verify's one bound on guesses.
//
// `check` runs inside core's transaction on the account, holding a database
// connection while Twilio answers, so its timeout is short.

import type { PhoneChannel, PhoneVerifier } from "./account-phones.ts";

/** Lookup v2's phone-number endpoint; the number follows, URL-encoded. */
export const TWILIO_LOOKUP = "https://lookups.twilio.com/v2/PhoneNumbers/";
/** Verify v2's services endpoint; the service SID follows. */
export const TWILIO_VERIFY = "https://verify.twilio.com/v2/Services/";

/** Verify's error code for a check past the verification's cap on checks. */
const MAX_CHECKS_REACHED = 60202;

export interface TwilioOptions {
  /** An API key's SID (`SK…`), or the account's own SID (`AC…`). */
  readonly keySid: string;
  /** That key's secret, or the account's auth token. */
  readonly keySecret: string;
  /** The Verify service's SID (`VA…`). */
  readonly verifyServiceSid: string;
  /** How long to wait for a lookup or a send before answering `unavailable`. */
  readonly timeoutMs?: number;
  /** How long to wait for a check, which holds a database connection, before `unavailable`. */
  readonly checkTimeoutMs?: number;
  /** For tests; the platform's otherwise. */
  readonly fetch?: typeof globalThis.fetch;
}

const KEY_SID = /^(?:AC|SK)[0-9a-f]{32}$/;
const SECRET = /^[A-Za-z0-9]{32}$/;
const SERVICE_SID = /^VA[0-9a-f]{32}$/;
// What core passes: a number in E.164, a code of 4 to 10 digits.
const E164 = /^\+[1-9][0-9]{6,14}$/;
const CODE = /^[0-9]{4,10}$/;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Asks Twilio through Lookup and Verify. Anything but Twilio's clear answer
 * (a status, a body or a field we don't expect) is `unavailable`, never a
 * pass: a lookup that can't be read sends no code, and a check that can't
 * be read verifies nothing.
 */
export function createTwilioVerifier({
  keySid,
  keySecret,
  verifyServiceSid,
  timeoutMs = 10_000,
  checkTimeoutMs = 5_000,
  fetch = globalThis.fetch,
}: TwilioOptions): PhoneVerifier {
  if (!KEY_SID.test(keySid)) throw new Error("keySid is not a Twilio key or account SID");
  if (!SECRET.test(keySecret)) throw new Error("keySecret is not a Twilio secret");
  if (!SERVICE_SID.test(verifyServiceSid))
    throw new Error("verifyServiceSid is not a Verify service SID");
  const authorization = `Basic ${Buffer.from(`${keySid}:${keySecret}`).toString("base64")}`;
  const service = `${TWILIO_VERIFY}${verifyServiceSid}`;

  /** Twilio's answer: its status and its JSON body, if it has one. */
  async function call(
    url: string,
    form: Record<string, string> | undefined,
    timeout: number,
  ): Promise<{ readonly status: number; readonly body: Json | undefined } | undefined> {
    try {
      const response = await fetch(url, {
        method: form === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          authorization,
          ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        },
        ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      return { status: response.status, body: isObject(body) ? body : undefined };
    } catch {
      return undefined;
    }
  }

  return {
    async lookup(number) {
      if (!E164.test(number)) return "invalid";
      const answer = await call(
        `${TWILIO_LOOKUP}${encodeURIComponent(number)}?Fields=line_type_intelligence`,
        undefined,
        timeoutMs,
      );
      if (answer === undefined) return "unavailable";
      // Lookup answers 404 for a number it can't parse at all.
      if (answer.status === 404) return "invalid";
      const { status, body } = answer;
      if (status !== 200 || body === undefined) return "unavailable";
      if (body["valid"] === false) return "invalid";
      const found = body["phone_number"];
      const country = body["country_code"];
      if (body["valid"] !== true || typeof found !== "string" || typeof country !== "string")
        return "unavailable";
      // A line type Lookup couldn't give (`null`, with an `error_code`) is
      // `unknown`, which core refuses as virtual: the ADR's unknown type.
      const intelligence = body["line_type_intelligence"];
      const type = isObject(intelligence) ? intelligence["type"] : undefined;
      return { number: found, country, lineType: typeof type === "string" ? type : "unknown" };
    },

    async start(number, channel: PhoneChannel) {
      if (!E164.test(number)) return "unavailable";
      const answer = await call(
        `${service}/Verifications`,
        { To: number, Channel: channel },
        timeoutMs,
      );
      return answer?.status === 201 && answer.body?.["status"] === "pending"
        ? "sent"
        : "unavailable";
    },

    async check(number, code) {
      if (!E164.test(number) || !CODE.test(code)) return "wrong";
      const answer = await call(
        `${service}/VerificationCheck`,
        { To: number, Code: code },
        checkTimeoutMs,
      );
      if (answer === undefined) return "unavailable";
      const { status, body } = answer;
      if (status === 200 && body !== undefined) {
        if (body["status"] === "approved" && body["valid"] === true) return "approved";
        // `pending` for a wrong code; `canceled`, `expired` and the rest for one that is gone.
        return typeof body["status"] === "string" ? "wrong" : "unavailable";
      }
      // No verification waiting for the number (expired, approved or never
      // sent, as for a capped number), or past its cap on checks.
      if (status === 404 || (status === 429 && body?.["code"] === MAX_CHECKS_REACHED))
        return "wrong";
      return "unavailable";
    },
  };
}
