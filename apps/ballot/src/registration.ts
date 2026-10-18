// The ballot client's side of Tier 0 registration ([[registration]]): the
// challenge frame's address and the one message it accepts from it, the
// request to the registration route and what each answer means, and when a
// request that hasn't landed may be sent again. The outcome itself is read
// from the group registry, never asked of the service (`tier0Registration`
// in @abolishus/crypto; T-11, T-13).
//
// The challenge page runs Cloudflare's Turnstile on an origin of its own, so
// its third-party script never runs here (T-67) and never sees the
// commitment; only its token crosses, by `postMessage` (T-43).

import { isForbiddenCommitment } from "@abolishus/crypto";

import type { Deployment } from "./deployment.ts";
import type { Fetch } from "./load.ts";
import { readJson } from "./answer.ts";

/** The Turnstile action a Tier 0 registration's token is solved for (`TURNSTILE_ACTION_TIER0`). */
export const TIER0_ACTION = "tier0-register";

// [[registration]], Values: a period's length and how many boundaries a
// short queue may be held, which bound how long an accepted request waits
// before it is signed, finality aside.
const REGISTRATION_PERIOD = 600;
const MAX_REGISTRATION_HOLD = 6;

/**
 * How long after an accepted request the client may send it again, in
 * seconds of L2 time ([[registration]], Outcome): `(MAX_REGISTRATION_HOLD +
 * 2) · REGISTRATION_PERIOD`. It is measured against the finalized block the
 * outcome was read at, so finality is counted as it happened rather than
 * guessed.
 */
export const RETRY_AFTER = (MAX_REGISTRATION_HOLD + 2) * REGISTRATION_PERIOD;

const MAX_U32 = 0xffff_ffff;

/** A Turnstile token's form: 1 to 2,048 characters from `0x21` to `0x7e`. */
const TOKEN = /^[\x21-\x7e]{1,2048}$/;

/**
 * The challenge frame's `src` ([[registration]], The handoff, step 1): the
 * challenge origin with the client's serialized origin and the action in
 * its fragment, which never reaches a server. Each value is
 * percent-encoded, so the page's strict parse sees exactly two keys.
 */
export function challengeFrameSrc(challengeOrigin: string, clientOrigin: string): string {
  for (const origin of [challengeOrigin, clientOrigin])
    if (!isSerializedOrigin(origin)) throw new RangeError(`not an origin: ${origin}`);
  return `${challengeOrigin}/#origin=${encodeURIComponent(clientOrigin)}&action=${TIER0_ACTION}`;
}

/** An HTTPS origin exactly as `URL#origin` serializes it, with nothing after the host and port. */
function isSerializedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.origin === origin;
  } catch {
    return false;
  }
}

/** What the client sees of a `message` event: the parts it checks. */
export interface ChallengeMessage {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
}

/**
 * The token in a message from the challenge frame, or `undefined` for any
 * other message, which the client ignores ([[registration]], The handoff,
 * step 3): it must come from the pinned challenge origin and from the
 * client's own frame's window, and be exactly `{ v: 1, token }` with a
 * token of Turnstile's form. A message from another frame of the same
 * origin, or one whose data carries anything more, hands over nothing.
 */
export function challengeToken(
  event: ChallengeMessage,
  challengeOrigin: string,
  frame: unknown,
): string | undefined {
  if (event.origin !== challengeOrigin || frame == null || event.source !== frame) return undefined;
  const { data } = event;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  if (Object.getPrototypeOf(data) !== Object.prototype) return undefined;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes("v") || !keys.includes("token")) return undefined;
  const { v, token } = data as Record<string, unknown>;
  if (v !== 1 || typeof token !== "string" || !TOKEN.test(token)) return undefined;
  return token;
}

/**
 * The route's body ([[registration]], Request): the commitment as 64
 * lowercase hex digits, the region as a canonical decimal and the token,
 * exactly these three fields. A value outside its form is refused here, so
 * the voter's solve is never spent on a request the route would refuse
 * before Turnstile anyway.
 */
export function tier0RequestBody(commitment: bigint, region: number, token: string): string {
  if (typeof commitment !== "bigint" || isForbiddenCommitment(commitment))
    throw new RangeError("commitment: expected a field element that isn't forbidden");
  if (!Number.isInteger(region) || region < 0 || region > MAX_U32 || Object.is(region, -0))
    throw new RangeError("region: expected a u32");
  if (typeof token !== "string" || !TOKEN.test(token))
    throw new RangeError("token: expected a Turnstile token");
  return JSON.stringify({
    commitment: commitment.toString(16).padStart(64, "0"),
    region: String(region),
    turnstile: token,
  });
}

/** What the route answered ([[registration]], Answers), as the client acts on it. */
export type Tier0Answer =
  /** Queued, or already queued, in a batch or a member: the same answer for each (T-13). */
  | "accepted"
  /** The request is outside the route's forms: a bug of this client, not the voter's. */
  | "malformed"
  /** The region has no published group. */
  | "region-unknown"
  /** The group's queue is full: try after the next batch. */
  | "busy"
  /** The service can't take requests for now (its index lags, or it isn't running). */
  | "unavailable"
  /** Turnstile refused the token: spent, expired, or for another site or action. */
  | "challenge-refused"
  /** The token couldn't be checked: try again with a new solve. */
  | "challenge-unavailable"
  /** The network failed, or the answer isn't one the route gives. */
  | "unreachable";

// Each refusal the route defines, by its status and code: a code at another
// status isn't the route's (a proxy's page, say) and is read as unreachable.
const REFUSALS: Readonly<Record<string, readonly [number, Tier0Answer]>> = {
  REGISTRATION_MALFORMED: [422, "malformed"],
  REGION_UNKNOWN: [422, "region-unknown"],
  REGISTRATION_BUSY: [503, "busy"],
  REGISTRATION_UNAVAILABLE: [503, "unavailable"],
  CHALLENGE_REFUSED: [403, "challenge-refused"],
  CHALLENGE_UNAVAILABLE: [503, "challenge-unavailable"],
};

/**
 * Sends `body` (`tier0RequestBody`) to the deployment's registration route
 * and reads the answer. Like every request the client makes, it carries no
 * cookie, referrer or credential (T-10), and follows no redirect.
 */
export async function sendTier0Request(
  deployment: Pick<Deployment, "api">,
  body: string,
  fetchFn: Fetch,
): Promise<Tier0Answer> {
  let response: Response;
  try {
    response = await fetchFn(`${deployment.api}/registrations/tier0`, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      mode: "cors",
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch {
    return "unreachable";
  }
  const answer = await readJson(response);
  if (response.status === 200)
    return isRecord(answer) && Object.keys(answer).length === 0 ? "accepted" : "unreachable";
  const code = isRecord(answer) ? answer["code"] : undefined;
  // Every route's own refusal of a body outside its forms (steps 1 and 2),
  // only in the route's own shape: this client checked the forms before
  // sending, so a bare 400 is an edge's, and is read as unreachable rather
  // than as a fault that would keep the direct path from being offered (T-25).
  if (response.status === 400) return code === "BAD_REQUEST" ? "malformed" : "unreachable";
  const refusal =
    typeof code === "string" && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : undefined;
  return refusal !== undefined && refusal[0] === response.status ? refusal[1] : "unreachable";
}

/**
 * Whether a request the route accepted at `acceptedAt` (milliseconds, this
 * device's clock) may be sent again, as of the L2's finalized block at
 * `finalizedTimestamp` (seconds): once `RETRY_AFTER` seconds of finalized
 * chain time have passed with no addition of the commitment
 * ([[registration]], Outcome). The caller has read the outcome at that
 * block first and found it `not-yet`; a repeat is harmless either way.
 */
export function retryDue(acceptedAt: number, finalizedTimestamp: bigint): boolean {
  return finalizedTimestamp * 1000n >= BigInt(acceptedAt) + BigInt(RETRY_AFTER) * 1000n;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
