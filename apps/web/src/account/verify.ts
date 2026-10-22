// The verification page's calls to the e-mail and phone handlers on our own
// origin (src/node/email.ts, /email; src/node/phone.ts, /phone;
// [[0038-verified-accounts]]; P2-31 part 4). The session cookie goes only
// because the call is same-origin, as the account client's does
// (src/account/client.ts); the handlers name the account from it, and
// nothing here names one (T-10).
//
// T-11, T-73: a request for a code answers alike whether a code, a notice or
// nothing went, so there is nothing here to tell them apart; the page says a
// message went and to ask again if none arrives. The number is never kept,
// on the server or here: the page holds it only while its code waits, and
// sends it again with the code.

import { TURNSTILE_HEADER } from "@abolishus/core/turnstile";

/** The account's verified e-mail address. */
export interface EmailView {
  readonly address: string;
  /** ISO 8601. */
  readonly verifiedAt: string;
}

/** The account's verified phone: only the day, since the number itself is never kept. */
export interface PhoneView {
  /** `YYYY-MM-DD`, UTC. */
  readonly verifiedOn: string;
}

/** Why a verification action didn't happen. */
export type VerifyFailure =
  /** The session ended: sign in again. */
  | "signedOut"
  /** This site can't verify this yet (no provider configured). */
  | "unavailable"
  | "invalidAddress"
  | "invalidNumber"
  /** A US or Canadian number only, for now. */
  | "unsupportedCountry"
  /** An internet or virtual number. */
  | "virtualNumber"
  /** This account asked for as many codes this hour as it may. */
  | "tooManyThisHour"
  /** This account asked for as many codes today as it may. */
  | "tooManyToday"
  /** Every account together asked for as many phone codes today as this site sends (T-52). */
  | "serviceBusy"
  /** Turnstile refused the request's token (spent, expired or not solved here). */
  | "challengeRefused"
  /** Turnstile couldn't be asked, or its check couldn't load. */
  | "challengeUnavailable"
  /** The phone provider couldn't look the number up. */
  | "lookupUnavailable"
  /** No code is waiting: ask for one. */
  | "noCode"
  | "expired"
  /** The code isn't right; `triesLeft` says how many remain. */
  | "wrongCode"
  /** Every try at this code is spent: ask for another. */
  | "tooManyTries"
  /** The phone provider couldn't check the code; no try was spent. */
  | "checkUnavailable"
  /** Another account holds the address. */
  | "addressTaken"
  /** Another account holds the number, or let it go under 90 days ago. */
  | "numberHeld"
  /** The server refused or failed, or the network did. */
  | "failed";

export class VerifyError extends Error {
  readonly failure: VerifyFailure;
  /** With `wrongCode`: the tries this code has left. */
  readonly triesLeft: number | undefined;
  constructor(failure: VerifyFailure, triesLeft?: number) {
    super(`verify action ${failure}`);
    this.name = "VerifyError";
    this.failure = failure;
    this.triesLeft = triesLeft;
  }
}

/** Every call the page makes, so it can be shown with stand-ins (stories, tests). */
export interface VerifyClient {
  /** The verified address; none while there is none. */
  email(): Promise<EmailView | undefined>;
  /** Sends a code to `address`, with a token solved for `email-code`. */
  requestEmailCode(address: string, token: string): Promise<void>;
  verifyEmailCode(code: string): Promise<void>;
  /** The day the phone was verified; none while there is none. */
  phone(): Promise<PhoneView | undefined>;
  /** Sends a code to `number`, with a token solved for `phone-code`. */
  requestPhoneCode(number: string, token: string): Promise<void>;
  /** Checks `code`, with the number it was sent to: nothing stored can give it back. */
  verifyPhoneCode(number: string, code: string): Promise<void>;
}

// The handlers' codes (src/node/email.ts and src/node/phone.ts, ERRORS);
// anything else is `failed`.
const REFUSALS: Readonly<Record<string, VerifyFailure>> = {
  SIGNED_OUT: "signedOut",
  EMAIL_UNAVAILABLE: "unavailable",
  PHONE_UNAVAILABLE: "unavailable",
  INVALID_ADDRESS: "invalidAddress",
  INVALID_NUMBER: "invalidNumber",
  UNSUPPORTED_COUNTRY: "unsupportedCountry",
  VIRTUAL_NUMBER: "virtualNumber",
  TOO_MANY_THIS_HOUR: "tooManyThisHour",
  TOO_MANY_TODAY: "tooManyToday",
  SERVICE_BUSY: "serviceBusy",
  TURNSTILE_REFUSED: "challengeRefused",
  TURNSTILE_UNAVAILABLE: "challengeUnavailable",
  LOOKUP_UNAVAILABLE: "lookupUnavailable",
  NO_CODE: "noCode",
  EXPIRED: "expired",
  WRONG_CODE: "wrongCode",
  TOO_MANY_TRIES: "tooManyTries",
  CHECK_UNAVAILABLE: "checkUnavailable",
  ADDRESS_TAKEN: "addressTaken",
  NUMBER_HELD: "numberHeld",
};

const TRIES = /^(?:0|[1-9][0-9]?)$/;

function refusal(answer: unknown): VerifyError {
  if (typeof answer !== "object" || answer === null) return new VerifyError("failed");
  const { code, triesLeft } = answer as Record<string, unknown>;
  const failure =
    (typeof code === "string" && Object.hasOwn(REFUSALS, code) && REFUSALS[code]) || "failed";
  // A count is shown only with the refusal it belongs to, and only if it is one.
  return failure === "wrongCode" && typeof triesLeft === "number" && TRIES.test(String(triesLeft))
    ? new VerifyError(failure, triesLeft)
    : new VerifyError(failure);
}

async function call(
  path:
    | "/email"
    | "/email/request"
    | "/email/verify"
    | "/phone"
    | "/phone/request"
    | "/phone/verify",
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<object> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    // Exactly this type, with no charset: the handlers refuse anything else.
    ...(body === undefined
      ? {}
      : {
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  }).catch(() => {
    throw new VerifyError("failed");
  });
  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw refusal(answer);
  if (typeof answer !== "object" || answer === null || Array.isArray(answer))
    throw new VerifyError("failed");
  return answer;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `value` is an answer with no fields: the handlers' "none". */
const empty = (value: object) => Object.keys(value).length === 0;

function emailView(value: object): EmailView | undefined {
  if (empty(value)) return undefined;
  const { address, verifiedAt } = value as Record<string, unknown>;
  // An address is at most 254 bytes (packages/core, account-emails).
  if (
    typeof address !== "string" ||
    address.length === 0 ||
    address.length > 254 ||
    typeof verifiedAt !== "string" ||
    !ISO.test(verifiedAt)
  )
    throw new VerifyError("failed");
  return { address, verifiedAt };
}

function phoneView(value: object): PhoneView | undefined {
  if (empty(value)) return undefined;
  const { verifiedOn } = value as Record<string, unknown>;
  if (typeof verifiedOn !== "string" || !DAY.test(verifiedOn)) throw new VerifyError("failed");
  return { verifiedOn };
}

/** The client for this origin's e-mail and phone handlers. */
export const verifyClient: VerifyClient = {
  email: async () => emailView(await call("/email")),
  async requestEmailCode(address, token) {
    await call("/email/request", { address }, { [TURNSTILE_HEADER]: token });
  },
  async verifyEmailCode(code) {
    await call("/email/verify", { code });
  },
  phone: async () => phoneView(await call("/phone")),
  async requestPhoneCode(number, token) {
    await call("/phone/request", { number }, { [TURNSTILE_HEADER]: token });
  },
  async verifyPhoneCode(number, code) {
    await call("/phone/verify", { number, code });
  },
};
