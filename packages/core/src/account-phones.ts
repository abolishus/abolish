// An account's verified phone number ([[0038-verified-accounts]]; P2-31
// part 3): one account per number, so a second account, and a second Tier 0
// identity in a group (P2-30), costs a second number (T-01). The account asks
// for a code to a number, then enters it on the page that asked, sending the
// number again with it. The provider (Twilio Verify, behind `PhoneVerifier`)
// makes, sends and checks the codes, so we hold none.
//
// The number is never stored, not even sealed (T-73): only a nested HMAC
// chain over its E.164 form, `h_1 = HMAC(k_1, "abolish/phone/v1" ‖ number)`
// and `h_i = HMAC(k_i, h_{i-1})`, under the phone-hash keyring's keys, oldest
// first, up to the current one. Rotating to a new key extends every stored
// chain by one HMAC without the number, and a lookup matches a number on any
// prefix of its chain, so every key is kept for good: a keyring that dropped
// one would stop matching the values made under it.
//
// Before a code goes, the provider's lookup must say the number is in a
// country we serve (`PHONE_COUNTRIES`) and of a line type we take: a mobile
// gets an SMS, a landline or fixed VoIP line a call; any other type, an
// unknown one included, is refused as virtual.
//
// A number another account holds, or one held after an account let it go
// (`PHONE_HOLD_DAYS`, so a number can't be cycled through accounts), is
// refused only once the right code is entered, never when a code is asked
// for: so only whoever has the phone learns that it is someone's (T-11). A
// number its account verified or took more than `PHONE_HOLD_DAYS` ago moves
// to the account entering its code, since carriers recycle numbers: the old
// account loses its verified phone, never itself, whose sign-in is its
// passkeys. An account deleted (by any path, through the table's trigger) or
// changing its number leaves the old one held.
//
// T-52: every request costs a Turnstile solve for `phone-code`; an account is
// allowed `MAX_PHONE_SENDS_PER_HOUR` requests an hour and
// `MAX_PHONE_SENDS_PER_DAY` a day, and every account together `dailyCeiling`
// a day, counted before the lookup since the lookup costs too. A number is
// sent at most `MAX_SENDS_PER_NUMBER` codes a day, whoever asks; past that,
// the request is answered as usual and nothing is sent. As with e-mail, the
// count per account is kept to the second and the count per number's hash to
// the hour, and days held to the day, so the tables share no finer time to
// join on (T-73).
//
// T-10: account-side tables only, read by nothing on the ballot path; the
// provider is told a number and a code, never an account, a poll or a ballot.

import { createHmac } from "node:crypto";
import { and, eq, gt, inArray, lt, lte, ne, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import {
  accountPhoneCodes,
  accountPhoneHolds,
  accountPhoneRecipients,
  accountPhones,
  accountPhoneSends,
} from "./db/schema/index.ts";
import type { Keyring } from "./keyring.ts";
import type { Turnstile } from "./turnstile.ts";

/** How long a code can be entered after it is sent: Verify's own default. */
export const PHONE_CODE_SECONDS = 10 * 60;
/** Wrong answers a code survives before it is gone. */
export const PHONE_CODE_TRIES = 5;
/** Requests one account may make in any hour. */
export const MAX_PHONE_SENDS_PER_HOUR = 5;
/** Requests one account may make in any 24 hours. */
export const MAX_PHONE_SENDS_PER_DAY = 10;
/** Codes one number may be sent in any 24 hours, whichever accounts asked. */
export const MAX_SENDS_PER_NUMBER = 5;
/** Days a number is held after its account lets it go, and kept from moving after it is verified or moved. */
export const PHONE_HOLD_DAYS = 90;
/** The countries whose numbers are taken at launch, as the lookup names them (ISO 3166-1 alpha-2). */
export const PHONE_COUNTRIES: readonly string[] = ["US", "CA"];

/** How a code reaches a line. */
export type PhoneChannel = "sms" | "call";

/** The line types taken, as Twilio Lookup names them, and how each gets its code. */
export const PHONE_LINE_TYPES: Readonly<Record<string, PhoneChannel>> = {
  mobile: "sms",
  landline: "call",
  fixedVoip: "call",
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const HASH_LABEL = new TextEncoder().encode("abolish/phone/v1");

/**
 * The verification provider. `lookup`: the number's country and line type.
 * `start`: send a code by `channel`. `check`: whether `code` is the one sent
 * and still good; a code the provider no longer has (expired, spent, or never
 * sent because the number was capped) is `wrong`. `unavailable`: the provider
 * didn't answer.
 */
export interface PhoneVerifier {
  lookup(
    number: string,
  ): Promise<{ readonly country: string; readonly lineType: string } | "unavailable">;
  start(number: string, channel: PhoneChannel): Promise<"sent" | "unavailable">;
  check(number: string, code: string): Promise<"approved" | "wrong" | "unavailable">;
}

export type PhoneVerificationErrorCode =
  /** Not a number we take. */
  | "invalid-number"
  | "too-many-this-hour"
  | "too-many-today"
  /** Every account together has made `dailyCeiling` requests in the last 24 hours. */
  | "service-busy"
  | "challenge-refused"
  | "challenge-unavailable"
  /** The provider's lookup didn't answer; the request still counts. */
  | "lookup-unavailable"
  /** A number from a country not served yet. */
  | "unsupported-country"
  /** A line type we don't take: an internet or virtual number. */
  | "virtual-number"
  /** The provider didn't take the code; the request still counts. */
  | "send-unavailable"
  /** No code is waiting for this account and number. */
  | "no-code"
  /** The code waiting was sent more than `PHONE_CODE_SECONDS` ago, and is gone. */
  | "expired"
  /** Not the code sent; it survives `triesLeft` more. */
  | "wrong-code"
  /** Not the code sent, for the last time: the code is gone. */
  | "too-many-tries"
  /** The provider didn't answer whether the code is right; no try is spent. */
  | "check-unavailable"
  /** The right code, but another account holds the number, or it is held after one let it go. */
  | "number-held";

export class PhoneVerificationError extends Error {
  override readonly name = "PhoneVerificationError";
  readonly code: PhoneVerificationErrorCode;
  /** For `wrong-code`: how many more wrong answers the code survives. */
  readonly triesLeft: number | undefined;
  constructor(code: PhoneVerificationErrorCode, triesLeft?: number) {
    super(`phone verification: ${code}`);
    this.code = code;
    this.triesLeft = triesLeft;
  }
}

/** What a number may be written with besides its digits and a leading `+`. */
const SEPARATORS = /[\s().-]/g;
const E164 = /^\+[1-9][0-9]{6,14}$/;
/** A North American number: area code and exchange each start with 2 to 9. */
const NANP = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/;

/**
 * A number as typed, in E.164 (`+` and at most 15 digits), if it is one we
 * take: separators dropped, and ten digits, or eleven starting with 1, read
 * as a North American number. Whether it is a real line in a country we
 * serve is the lookup's to say.
 */
export function parsePhoneNumber(input: string): string | undefined {
  if (input.length > 64) return undefined;
  let number = input.replace(SEPARATORS, "");
  if (/^[0-9]{10}$/.test(number)) number = `+1${number}`;
  else if (/^1[0-9]{10}$/.test(number)) number = `+${number}`;
  if (!E164.test(number)) return undefined;
  if (number.startsWith("+1") && !NANP.test(number)) return undefined;
  return number;
}

/** A number's chain under each key of `keys` in turn, oldest first: one value per prefix. */
function chainOf(keys: Keyring, number: string): { readonly id: string; readonly hash: Buffer }[] {
  const chain: { id: string; hash: Buffer }[] = [];
  let hash: Buffer | undefined;
  for (const { id, key } of keys.keys) {
    const mac = createHmac("sha256", key);
    hash =
      hash === undefined
        ? mac.update(HASH_LABEL).update(number, "utf8").digest()
        : mac.update(hash).digest();
    chain.push({ id, hash });
  }
  return chain;
}

/** A number's hashes: every value it may be stored under, and the one new values take. */
function hashesOf(keys: Keyring, number: string) {
  const chain = chainOf(keys, number);
  // The keyring's current key is one of its keys.
  const current = chain.find((c) => c.id === keys.current.id)!;
  return { all: chain.map((c) => c.hash), current };
}

/** An account ID as `newAccountId` makes them. */
const ACCOUNT_ID = /^[a-z0-9]{32}$/;

function checkAccountId(accountId: string): void {
  if (!ACCOUNT_ID.test(accountId)) throw new RangeError("not an account ID");
}

type Db = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One account's lock on its number and codes. */
const lockAccount = (tx: Tx, accountId: string) =>
  tx.execute(
    q`SELECT pg_advisory_xact_lock(hashtextextended(${`account_phones:${accountId}`}, 0))`,
  );

/** The lock every account's request takes to count against the daily ceiling. */
const lockCeiling = (tx: Tx) =>
  tx.execute(q`SELECT pg_advisory_xact_lock(hashtextextended('account_phone_sends', 0))`);

/**
 * One number's locks, one per value of its chain, in a fixed order, so two
 * accounts can't both take it or both pass its cap; taken after the
 * account's lock, never before. Each is named by 64 bits of a hash, so not
 * even the hash reaches the database's logs.
 */
async function lockNumber(tx: Tx, hashes: readonly Buffer[]): Promise<void> {
  const ids = hashes.map((h) => h.readBigInt64BE(0)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of ids) await tx.execute(q`SELECT pg_advisory_xact_lock(${id.toString()}::bigint)`);
}

const hourOf = (now: Date) => new Date(Math.floor(now.getTime() / HOUR) * HOUR);
const dayOf = (now: Date) => new Date(Math.floor(now.getTime() / DAY) * DAY);
/** Days on or before this one are `PHONE_HOLD_DAYS` or more before `now`'s. */
const holdEnded = (now: Date) => new Date(dayOf(now).getTime() - PHONE_HOLD_DAYS * DAY);

/** The limit `accountId`, or every account together, is at, if any, as of `now`. */
async function limitReached(
  db: Db | Tx,
  accountId: string,
  now: Date,
  dailyCeiling: number,
): Promise<PhoneVerificationErrorCode | undefined> {
  const since = (ms: number) => gt(accountPhoneSends.sentAt, new Date(now.getTime() - ms));
  const mine = (ms: number) =>
    db.$count(accountPhoneSends, and(eq(accountPhoneSends.userId, accountId), since(ms)));
  if ((await mine(HOUR)) >= MAX_PHONE_SENDS_PER_HOUR) return "too-many-this-hour";
  if ((await mine(DAY)) >= MAX_PHONE_SENDS_PER_DAY) return "too-many-today";
  if ((await db.$count(accountPhoneSends, since(DAY))) >= dailyCeiling) return "service-busy";
  return undefined;
}

export interface RequestPhoneCodeOptions {
  /** The phone-hash keyring: its own keys, shared with no other use (ADR 0038, Keys). */
  readonly keys: Keyring;
  readonly verifier: PhoneVerifier;
  readonly turnstile: Turnstile;
  /** The token the form's widget solved for `phone-code`, if any. */
  readonly token: string | null;
  /** Requests every account together may make in any 24 hours (T-52). */
  readonly dailyCeiling: number;
  /** The countries served; `PHONE_COUNTRIES` by default. */
  readonly countries?: readonly string[];
  readonly now: Date;
}

/**
 * Sends `accountId` a code to verify `input`, replacing any code waiting.
 * Checked cheapest first, so a refused request spends nothing it needn't:
 * the number (`invalid-number`), the limits, the Turnstile token; then the
 * limits again under the account's lock, where the request is counted, and
 * only then the provider's lookup, which costs. The count stays whatever the
 * lookup or the send says.
 *
 * Answers the same whether a code went or the number's daily cap kept it
 * back, and whoever holds the number.
 */
export async function requestPhoneCode(
  client: Sql,
  accountId: string,
  input: string,
  {
    keys,
    verifier,
    turnstile,
    token,
    dailyCeiling,
    countries = PHONE_COUNTRIES,
    now,
  }: RequestPhoneCodeOptions,
): Promise<void> {
  checkAccountId(accountId);
  const number = parsePhoneNumber(input);
  if (number === undefined) throw new PhoneVerificationError("invalid-number");
  const db = drizzle({ client });
  const limit = await limitReached(db, accountId, now, dailyCeiling);
  if (limit !== undefined) throw new PhoneVerificationError(limit);
  const verdict = await turnstile.verify(token, "phone-code");
  if (verdict === "unavailable") throw new PhoneVerificationError("challenge-unavailable");
  if (verdict !== "passed") throw new PhoneVerificationError("challenge-refused");
  await db.transaction(async (tx) => {
    await lockAccount(tx, accountId);
    await lockCeiling(tx);
    const again = await limitReached(tx, accountId, now, dailyCeiling);
    if (again !== undefined) throw new PhoneVerificationError(again);
    await tx.insert(accountPhoneSends).values({ userId: accountId, sentAt: now });
  });
  const line = await verifier.lookup(number);
  if (line === "unavailable") throw new PhoneVerificationError("lookup-unavailable");
  if (!countries.includes(line.country)) throw new PhoneVerificationError("unsupported-country");
  const channel = Object.hasOwn(PHONE_LINE_TYPES, line.lineType)
    ? PHONE_LINE_TYPES[line.lineType]
    : undefined;
  if (channel === undefined) throw new PhoneVerificationError("virtual-number");
  const hashes = hashesOf(keys, number);
  const capped = await db.transaction(async (tx) => {
    await lockAccount(tx, accountId);
    await lockNumber(tx, hashes.all);
    const sent = await tx.$count(
      accountPhoneRecipients,
      and(
        inArray(accountPhoneRecipients.phoneHash, hashes.all),
        gt(accountPhoneRecipients.sentAt, new Date(hourOf(now).getTime() - DAY)),
      ),
    );
    const row = {
      phoneHash: hashes.current.hash,
      hashKey: hashes.current.id,
      tries: 0,
      expiresAt: new Date(now.getTime() + PHONE_CODE_SECONDS * 1000),
    };
    await tx
      .insert(accountPhoneCodes)
      .values({ userId: accountId, ...row })
      .onConflictDoUpdate({ target: accountPhoneCodes.userId, set: row });
    if (sent >= MAX_SENDS_PER_NUMBER) return true;
    await tx
      .insert(accountPhoneRecipients)
      .values({ phoneHash: hashes.current.hash, sentAt: hourOf(now) });
    return false;
  });
  if (!capped && (await verifier.start(number, channel)) !== "sent")
    throw new PhoneVerificationError("send-unavailable");
}

/** A code as the form may send it: Verify's 4 to 10 digits, with any spaces or hyphens dropped. */
const CODE_INPUT = /^[0-9]{4,10}$/;

type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PhoneVerificationErrorCode; readonly triesLeft?: number };

/**
 * Verifies `accountId`'s waiting code for `numberInput` with `codeInput`,
 * making the number the account's verified one and spending the code. A
 * wrong answer costs a try, and the last try the code; an answer in any
 * other shape than 4 to 10 digits is a wrong one, never sent to the
 * provider. `number-held` spends the code too.
 *
 * An earlier number of the account's is held for `PHONE_HOLD_DAYS`; a number
 * another account verified or took at least `PHONE_HOLD_DAYS` days before
 * moves here, and that account loses it.
 */
export async function verifyPhoneCode(
  client: Sql,
  accountId: string,
  numberInput: string,
  codeInput: string,
  {
    keys,
    verifier,
    now,
  }: { readonly keys: Keyring; readonly verifier: PhoneVerifier; readonly now: Date },
): Promise<void> {
  checkAccountId(accountId);
  const number = parsePhoneNumber(numberInput);
  if (number === undefined) throw new PhoneVerificationError("invalid-number");
  const hashes = hashesOf(keys, number);
  const answer = codeInput.replace(/[\s-]/g, "");
  const db = drizzle({ client });
  const verdict = await db.transaction(async (tx): Promise<Verdict> => {
    await lockAccount(tx, accountId);
    const [waiting] = await tx
      .select()
      .from(accountPhoneCodes)
      .where(eq(accountPhoneCodes.userId, accountId))
      .for("update");
    if (waiting === undefined || !hashes.all.some((h) => h.equals(waiting.phoneHash)))
      return { ok: false, code: "no-code" };
    const spend = () => tx.delete(accountPhoneCodes).where(eq(accountPhoneCodes.userId, accountId));
    if (waiting.expiresAt.getTime() <= now.getTime()) {
      await spend();
      return { ok: false, code: "expired" };
    }
    // The provider is asked while the account's lock is held, so two answers
    // to one code can't each spend a try the other doesn't see.
    const checked = CODE_INPUT.test(answer) ? await verifier.check(number, answer) : "wrong";
    if (checked === "unavailable") return { ok: false, code: "check-unavailable" };
    if (checked === "wrong") {
      const tries = waiting.tries + 1;
      if (tries >= PHONE_CODE_TRIES) {
        await spend();
        return { ok: false, code: "too-many-tries" };
      }
      await tx
        .update(accountPhoneCodes)
        .set({ tries })
        .where(eq(accountPhoneCodes.userId, accountId));
      return { ok: false, code: "wrong-code", triesLeft: PHONE_CODE_TRIES - tries };
    }
    await spend();
    await lockNumber(tx, hashes.all);
    const ended = holdEnded(now);
    const [other] = await tx
      .select()
      .from(accountPhones)
      .where(
        and(inArray(accountPhones.phoneHash, hashes.all), ne(accountPhones.userId, accountId)),
      );
    const held = await tx.$count(
      accountPhoneHolds,
      and(inArray(accountPhoneHolds.phoneHash, hashes.all), gt(accountPhoneHolds.freedOn, ended)),
    );
    if (held > 0 || (other !== undefined && other.verifiedOn.getTime() > ended.getTime()))
      return { ok: false, code: "number-held" };
    if (other !== undefined) {
      // A move, not a release: the trigger that holds a deleted account's
      // number skips this deletion, since the number stays held, here.
      await tx.execute(q`SELECT set_config('abolish.phone_moving', 'on', true)`);
      await tx.delete(accountPhones).where(eq(accountPhones.userId, other.userId));
      await tx.execute(q`SELECT set_config('abolish.phone_moving', '', true)`);
    }
    await tx
      .delete(accountPhoneHolds)
      .where(
        and(
          inArray(accountPhoneHolds.phoneHash, hashes.all),
          lte(accountPhoneHolds.freedOn, ended),
        ),
      );
    const [mine] = await tx.select().from(accountPhones).where(eq(accountPhones.userId, accountId));
    if (mine !== undefined && !hashes.all.some((h) => h.equals(mine.phoneHash)))
      await tx
        .insert(accountPhoneHolds)
        .values({ phoneHash: mine.phoneHash, hashKey: mine.hashKey, freedOn: dayOf(now) });
    const row = {
      phoneHash: hashes.current.hash,
      hashKey: hashes.current.id,
      verifiedOn: dayOf(now),
    };
    await tx
      .insert(accountPhones)
      .values({ userId: accountId, ...row })
      .onConflictDoUpdate({ target: accountPhones.userId, set: row });
    return { ok: true };
  });
  if (!verdict.ok) throw new PhoneVerificationError(verdict.code, verdict.triesLeft);
}

/** The day `accountId`'s number was verified or moved to it, if it has one; the number itself is gone. */
export async function readAccountPhone(
  client: Sql,
  accountId: string,
): Promise<{ readonly verifiedOn: Date } | undefined> {
  checkAccountId(accountId);
  const [row] = await drizzle({ client })
    .select({ verifiedOn: accountPhones.verifiedOn })
    .from(accountPhones)
    .where(eq(accountPhones.userId, accountId));
  return row;
}

/**
 * Deletes codes that expired before `now`, requests and recipients older
 * than the daily window, and holds that have ended, returning how many of
 * each. Run with the e-mail prune on its timer.
 */
export async function pruneAccountPhones(
  client: Sql,
  now: Date,
): Promise<{
  readonly codes: number;
  readonly sends: number;
  readonly recipients: number;
  readonly holds: number;
}> {
  const db = drizzle({ client });
  const codes = await db
    .delete(accountPhoneCodes)
    .where(lt(accountPhoneCodes.expiresAt, now))
    .returning({ id: accountPhoneCodes.userId });
  const sends = await db
    .delete(accountPhoneSends)
    .where(lt(accountPhoneSends.sentAt, new Date(now.getTime() - DAY)))
    .returning({ id: accountPhoneSends.id });
  const recipients = await db
    .delete(accountPhoneRecipients)
    .where(lt(accountPhoneRecipients.sentAt, new Date(hourOf(now).getTime() - DAY)))
    .returning({ id: accountPhoneRecipients.id });
  const holds = await db
    .delete(accountPhoneHolds)
    .where(lte(accountPhoneHolds.freedOn, holdEnded(now)))
    .returning({ id: accountPhoneHolds.id });
  return {
    codes: codes.length,
    sends: sends.length,
    recipients: recipients.length,
    holds: holds.length,
  };
}
