// An account's verified e-mail address ([[0038-verified-accounts]], Email;
// P2-31 part 2). The account asks for a code to an address, then enters the
// code on the page that asked: 8 digits, single use, 15 minutes, 5 tries. A
// code, not a link, so it works when the mail is read on another device and
// gives a phishing page no link to copy.
//
// The address is never stored in the clear (T-73): it is AES-256-GCM
// ciphertext bound to its account, decrypted only to send to it or show the
// account its own address, and an HMAC of its case-folded form, for one
// account per address. Folding is case and the domain's ASCII form only
// (`foldEmailAddress`): the phone, not the address, is the Sybil cost (T-01),
// and provider-specific folding guesses wrong.
//
// A request for an address another account holds sends that address a notice
// instead of a code, and answers the requester exactly as if a code had gone,
// so the route can't be used to learn who has an account (T-11, T-73). Only
// someone reading that mailbox learns it.
//
// An address an account let go, by its deletion (the table's trigger) or a
// change of address, is held for `EMAIL_HOLD_DAYS`, as a number is: while
// phone verification is off the address is all a second account costs, so
// one address mustn't verify account after account, each taking a Tier 0
// token (T-01). A held address is answered as one another account holds,
// with a notice of its own. The hold keeps only the address's hash under the
// key it was made with, which can't be rewritten, so a hash key stays in its
// keyring until the holds under it end (the account-keys runbook).
//
// T-52: every request costs a Turnstile solve for `email-code`, and an
// account is sent at most `MAX_SENDS_PER_HOUR` codes an hour and
// `MAX_SENDS_PER_DAY` a day. An address is sent at most
// `MAX_SENDS_PER_ADDRESS` messages a day, whoever asks, so accounts made in
// bulk can't flood a mailbox; past that the request is answered as usual and
// nothing is sent, so the cap tells the requester nothing either. The two
// counts are kept apart: one per account, at the second, and one per address
// hash, at the hour (`hourOf`), so the two tables share no time to join on
// beyond the hour itself (T-73).
//
// T-10: account-side tables only, read by nothing on the ballot path; the
// provider is told an address and a code, never an account, a poll or a
// ballot.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { domainToASCII } from "node:url";
import { and, asc, eq, gt, inArray, lt, lte, ne, notInArray, or, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import {
  accountEmailCodes,
  accountEmailHolds,
  accountEmailKeyChecks,
  accountEmailRecipients,
  accountEmails,
  accountEmailSends,
} from "./db/schema/index.ts";
import { assertDistinctKeyrings, type Keyring } from "./keyring.ts";
import type { Notice } from "./account-notices.ts";
import type { RemovalReason, RestoreReason } from "./moderation.ts";
import type { Turnstile } from "./turnstile.ts";

/** Digits in a code. */
export const EMAIL_CODE_DIGITS = 8;
/** How long a code can be entered after it is sent. */
export const EMAIL_CODE_SECONDS = 15 * 60;
/** Wrong answers a code survives before it is gone. */
export const EMAIL_CODE_TRIES = 5;
/** Codes one account may be sent in any hour. */
export const MAX_SENDS_PER_HOUR = 5;
/** Codes one account may be sent in any 24 hours. */
export const MAX_SENDS_PER_DAY = 10;
/** Messages one address may be sent in any 24 hours, whichever accounts asked. */
export const MAX_SENDS_PER_ADDRESS = 5;
/** Days, counted from the UTC day it was let go, that an address stays unverifiable by any account. */
export const EMAIL_HOLD_DAYS = 90;
/** An address's largest UTF-8 length (RFC 5321's path limit, less its brackets). */
export const MAX_EMAIL_BYTES = 254;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const HASH_LABEL = new TextEncoder().encode("abolish/email/v1");
const BOX_LABEL = new TextEncoder().encode("abolish/email-box/v1");
const CODE_LABEL = new TextEncoder().encode("abolish/email-code/v1");

/** The two keyrings an address is kept under: separate keys for each use (ADR 0038, Keys). */
export interface EmailKeys {
  /** For `address_hash`. */
  readonly hash: Keyring;
  /** For `address_box`. */
  readonly box: Keyring;
}

/** Checks that no key serves both uses, and returns the keys. */
export function emailKeys(hash: Keyring, box: Keyring): EmailKeys {
  assertDistinctKeyrings(hash, box);
  return { hash, box };
}

/** What the sending service is asked to send; it renders each with `renderEmail`. */
export type EmailMessage =
  /** A code for `to`, which an account asked to verify. */
  | { readonly kind: "email-code"; readonly to: string; readonly code: string }
  /** `to` is another account's address: no code, just the fact that someone asked. */
  | { readonly kind: "email-held"; readonly to: string }
  /** `to` was let go by an account less than `EMAIL_HOLD_DAYS` ago: no code either. */
  | { readonly kind: "email-on-hold"; readonly to: string }
  /** What moderation did to the poll or profile of the account `to` is verified for (src/account-notices.ts). */
  | { readonly kind: "notice"; readonly to: string; readonly notice: Notice };

/**
 * The sending service, shared with notices (src/account-notices.ts). `unavailable`:
 * the provider didn't take the message. It must send plain transactional
 * mail with open and link tracking off (ADR 0038; T-67).
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<"sent" | "unavailable">;
}

/** A message's subject and plain-text body: no link, no image, nothing to track (T-67). */
export function renderEmail(message: EmailMessage): {
  readonly subject: string;
  readonly text: string;
} {
  switch (message.kind) {
    case "email-code":
      return {
        subject: `Your Abolish code: ${message.code}`,
        text: [
          `Your code to verify this address on Abolish is ${message.code}.`,
          "",
          "Enter it on the page that asked for it. It works once, for 15 minutes.",
          "",
          "If you didn't ask for it, you can ignore this message: nothing changes until the code is entered.",
        ].join("\n"),
      };
    case "email-held":
      return {
        subject: "Someone tried to add this address to Abolish",
        text: [
          "Someone asked to verify this address for an Abolish account, but it is already verified for another one.",
          "",
          "No code was sent and nothing changed. If it was you, sign in with the account that already has this address.",
        ].join("\n"),
      };
    case "email-on-hold":
      return {
        subject: "Someone tried to add this address to Abolish",
        text: [
          "Someone asked to verify this address for an Abolish account, but an account that had it verified let it go less than 90 days ago.",
          "",
          "An address can't be verified again until 90 days after an account lets it go, so no code was sent and nothing changed.",
        ].join("\n"),
      };
    case "notice":
      return renderNotice(message.notice);
  }
}

// docs/moderation-policy.md, Reasons, in the words a notice uses.
const GROUNDS: Record<RemovalReason, string> = {
  illegal: "content that is illegal to host",
  "personal-data": "a private person's personal data",
  threat: "a threat of violence",
  harassment: "harassment of a private person",
  spam: "spam",
  impersonation: "impersonation",
  "legal-notice": "a legal notice we must act on",
};
const RESTORED: Record<RestoreReason, string> = {
  "appeal-upheld": "your appeal was upheld",
  error: "the earlier decision was a mistake",
  "notice-withdrawn": "the legal notice behind it was withdrawn",
};

// T-73: no poll's question, profile's name, handle, link or time: which poll
// or profile it was is on the account page, behind the account's sign-in.
function renderNotice(notice: Notice): { readonly subject: string; readonly text: string } {
  const always = "We send moderation notices whatever your notification settings.";
  const lines = (subject: string, ...text: string[]) => ({
    subject,
    text: [...text, "", always].join("\n"),
  });
  if (notice.event === "restore") {
    const why = RESTORED[notice.reason];
    return notice.subject === "poll"
      ? lines(
          "A moderator restored one of your polls",
          `A moderator restored one of your polls on Abolish: ${why}. It is listed and shown again.`,
          "",
          "Sign in to Abolish to see which poll.",
        )
      : lines(
          "A moderator restored your public profile",
          `A moderator restored your public profile on Abolish: ${why}. Its name and polls are shown again.`,
        );
  }
  const ground = GROUNDS[notice.reason];
  if (notice.event === "appeal-rejected")
    return notice.subject === "poll"
      ? lines(
          "Your appeal about one of your polls was turned down",
          `A moderator reviewed your appeal and kept the decision on one of your polls on Abolish, on the ground of ${ground}.`,
          "",
          "Sign in to Abolish to see which poll.",
        )
      : lines(
          "Your appeal about your public profile was turned down",
          `A moderator reviewed your appeal and kept your public profile on Abolish hidden, on the ground of ${ground}.`,
        );
  if (notice.subject === "profile")
    return lines(
      "A moderator hid your public profile",
      `A moderator hid your public profile on Abolish, on the ground of ${ground}. Its page shows the reason instead of its name and polls, and your polls don't say who asked while it stands.`,
      "",
      "Sign in to Abolish to see the decision and to appeal it.",
    );
  return lines(
    notice.event === "delist"
      ? "A moderator took one of your polls off Discover"
      : "A moderator hid one of your polls",
    notice.event === "delist"
      ? `A moderator took one of your polls on Abolish off Discover and search, on the ground of ${ground}. Anyone with its link can still see it.`
      : `A moderator hid one of your polls on Abolish, on the ground of ${ground}. Our pages no longer show its question and options.`,
    "Its results stay published, and anyone can still check them.",
    "",
    "Sign in to Abolish to see which poll and to appeal the decision.",
  );
}

export type EmailVerificationErrorCode =
  /** Not an address we take. */
  | "invalid-address"
  | "too-many-this-hour"
  | "too-many-today"
  | "challenge-refused"
  | "challenge-unavailable"
  /** The provider didn't take the message; the send still counts. */
  | "send-unavailable"
  /** No code is waiting for this account. */
  | "no-code"
  /** The code waiting was sent more than 15 minutes ago, and is gone. */
  | "expired"
  /** Not the code sent; it survives `triesLeft` more. */
  | "wrong-code"
  /** Not the code sent, for the last time: the code is gone. */
  | "too-many-tries"
  /**
   * The right code, but another account verified the address since it was
   * sent, or an account let it go less than `EMAIL_HOLD_DAYS` ago.
   */
  | "address-taken";

export class EmailVerificationError extends Error {
  override readonly name = "EmailVerificationError";
  readonly code: EmailVerificationErrorCode;
  /** For `wrong-code`: how many more wrong answers the code survives. */
  readonly triesLeft: number | undefined;
  constructor(code: EmailVerificationErrorCode, triesLeft?: number) {
    super(`email verification: ${code}`);
    this.code = code;
    this.triesLeft = triesLeft;
  }
}

// Unquoted local parts of RFC 5322's dot-atoms, in any script (RFC 6531),
// and domains of letter-or-digit labels joined by hyphens.
const LOCAL =
  /^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+)*$/u;
const LABEL = /^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?$/u;
const DIGITS = /^[0-9]+$/;

/**
 * An address as typed, trimmed and in Unicode NFC, if it is one we take:
 * `local@domain`, unquoted, at most `MAX_EMAIL_BYTES` bytes of UTF-8, with a
 * domain of at least two labels and a top-level label that isn't all digits.
 * Not every address RFC 5322 allows, but every one a provider gives out.
 */
export function parseEmailAddress(input: string): string | undefined {
  const address = input.trim().normalize("NFC");
  if (Buffer.byteLength(address, "utf8") > MAX_EMAIL_BYTES) return undefined;
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (at < 1 || Buffer.byteLength(local, "utf8") > 64 || !LOCAL.test(local)) return undefined;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return undefined;
  if (DIGITS.test(labels[labels.length - 1]!)) return undefined;
  // A domain with no ASCII form (UTS 46 refuses it) can't be folded.
  if (domainToASCII(domain) === "") return undefined;
  return address;
}

/**
 * The form one account per address is checked on, for an address
 * `parseEmailAddress` took: the local part lowercased, and the domain in its
 * ASCII form (UTS 46, which also folds its case), so `bücher.de` and
 * `xn--bcher-kva.de` are one domain (ADR 0038, Amendment).
 */
export function foldEmailAddress(address: string): string {
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at).normalize("NFC").toLowerCase().normalize("NFC");
  return `${local}@${domainToASCII(address.slice(at + 1))}`;
}

const hashUnder = (key: Uint8Array, address: string): Uint8Array =>
  createHmac("sha256", key).update(HASH_LABEL).update(foldEmailAddress(address), "utf8").digest();

/** The address's hash under every key of the hash keyring: a match under any is the same address. */
const hashesOf = (keys: EmailKeys, address: string): Uint8Array[] =>
  keys.hash.keys.map((k) => hashUnder(k.key, address));

/** An account ID as `newAccountId` makes them: a fixed length, so label ‖ ID ‖ rest needs no separator. */
const ACCOUNT_ID = /^[a-z0-9]{32}$/;

function checkAccountId(accountId: string): void {
  if (!ACCOUNT_ID.test(accountId)) throw new RangeError("not an account ID");
}

const boundTo = (label: Uint8Array, accountId: string): Buffer =>
  Buffer.concat([label, Buffer.from(accountId, "utf8")]);

/** `address` sealed for `accountId` under the current box key: nonce ‖ ciphertext ‖ tag. */
function seal(keys: EmailKeys, accountId: string, address: string): Uint8Array {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.box.current.key, nonce);
  // T-73: bound to its account, so a row's box copied to another account's
  // row doesn't open there.
  cipher.setAAD(boundTo(BOX_LABEL, accountId));
  const body = Buffer.concat([cipher.update(address, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function unseal(keys: EmailKeys, accountId: string, box: Uint8Array, keyId: string): string {
  const key = keys.box.get(keyId);
  // A key is retired only once no row is under it (the account-keys runbook).
  if (key === undefined) throw new Error(`email box key ${keyId} is not in the keyring`);
  const decipher = createDecipheriv("aes-256-gcm", key, box.subarray(0, 12));
  decipher.setAAD(boundTo(BOX_LABEL, accountId));
  decipher.setAuthTag(box.subarray(box.length - 16));
  try {
    return Buffer.concat([
      decipher.update(box.subarray(12, box.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("an email box failed to open");
  }
}

/** `unseal`, for the account's own export (src/account-export.ts) only. */
export const unsealEmailAddress = unseal;

/**
 * A code's hash, keyed with a hash key so a dump of the table alone can't
 * search the 10^8 codes for it.
 */
const codeHash = (key: Uint8Array, accountId: string, code: string): Buffer =>
  createHmac("sha256", key).update(boundTo(CODE_LABEL, accountId)).update(code, "utf8").digest();

/** `EMAIL_CODE_DIGITS` uniform decimal digits. */
function newCode(): string {
  const bound = 10 ** EMAIL_CODE_DIGITS;
  // The largest multiple of `bound` below 2^32: values at or above it would bias the code.
  const limit = Math.floor(2 ** 32 / bound) * bound;
  for (;;) {
    const n = randomBytes(4).readUInt32BE(0);
    if (n < limit) return (n % bound).toString().padStart(EMAIL_CODE_DIGITS, "0");
  }
}

type Db = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One account's lock on its address and codes, so two requests can't both pass a limit. */
const lockAccount = (tx: Tx, accountId: string) =>
  tx.execute(
    q`SELECT pg_advisory_xact_lock(hashtextextended(${`account_emails:${accountId}`}, 0))`,
  );

/**
 * One address's locks, one per hash key, in a fixed order, so two accounts
 * can't both verify it or both pass its cap: two app instances share a lock
 * whenever their keyrings share a key, as they do while a new key is rolled
 * out. Taken after the account's lock, never before. Each lock is named by
 * 64 bits of the address's hash, so not even the hash reaches the database's
 * logs.
 */
async function lockAddress(tx: Tx, keys: EmailKeys, address: string): Promise<void> {
  const ids = hashesOf(keys, address)
    .map((h) => Buffer.from(h).readBigInt64BE(0))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of ids) await tx.execute(q`SELECT pg_advisory_xact_lock(${id.toString()}::bigint)`);
}

const dayOf = (now: Date) => new Date(Math.floor(now.getTime() / DAY) * DAY);
/** Holds freed on or before this day are `EMAIL_HOLD_DAYS` or more before `now`'s, and have ended. */
const holdEnded = (now: Date) => new Date(dayOf(now).getTime() - EMAIL_HOLD_DAYS * DAY);

/**
 * Whether an account other than `accountId` holds `address` (`account`), or
 * else an account let it go and its hold hasn't ended (`hold`), under any
 * hash key. One statement, so an account's deletion or change of address
 * committing meanwhile is seen either as its row or as its hold, never as
 * neither.
 */
async function addressHeld(
  tx: Tx,
  keys: EmailKeys,
  accountId: string,
  address: string,
  now: Date,
): Promise<"account" | "hold" | undefined> {
  const hashes = hashesOf(keys, address);
  const account = tx
    .select({ one: q`1` })
    .from(accountEmails)
    .where(and(inArray(accountEmails.addressHash, hashes), ne(accountEmails.userId, accountId)));
  const hold = tx
    .select({ one: q`1` })
    .from(accountEmailHolds)
    .where(
      and(
        inArray(accountEmailHolds.addressHash, hashes),
        gt(accountEmailHolds.freedOn, holdEnded(now)),
      ),
    );
  const [held] = await tx.execute<{ account: boolean; hold: boolean }>(
    q`SELECT EXISTS (${account}) AS account, EXISTS (${hold}) AS hold`,
  );
  return held?.account === true ? "account" : held?.hold === true ? "hold" : undefined;
}

/**
 * The start of `now`'s hour: when an address was sent a message is kept to
 * the hour only, so a dump can't pair a recipient row with the account whose
 * send row has the same instant; at best with every account that asked for a
 * code that hour (T-11, T-73).
 */
const hourOf = (now: Date) => new Date(Math.floor(now.getTime() / HOUR) * HOUR);

/** Whether `address` was sent `MAX_SENDS_PER_ADDRESS` messages in the 24 hours up to `now`'s hour. */
async function addressCapped(tx: Tx, keys: EmailKeys, address: string, now: Date) {
  const sent = await tx.$count(
    accountEmailRecipients,
    and(
      inArray(accountEmailRecipients.addressHash, hashesOf(keys, address)),
      gt(accountEmailRecipients.sentAt, new Date(hourOf(now).getTime() - DAY)),
    ),
  );
  return sent >= MAX_SENDS_PER_ADDRESS;
}

/** The limit `accountId` is at, if any, as of `now`. */
async function limitReached(
  db: Db | Tx,
  accountId: string,
  now: Date,
): Promise<EmailVerificationErrorCode | undefined> {
  const since = (ms: number) =>
    db.$count(
      accountEmailSends,
      and(
        eq(accountEmailSends.userId, accountId),
        gt(accountEmailSends.sentAt, new Date(now.getTime() - ms)),
      ),
    );
  if ((await since(HOUR)) >= MAX_SENDS_PER_HOUR) return "too-many-this-hour";
  if ((await since(DAY)) >= MAX_SENDS_PER_DAY) return "too-many-today";
  return undefined;
}

export interface RequestEmailCodeOptions {
  readonly keys: EmailKeys;
  readonly sender: EmailSender;
  readonly turnstile: Turnstile;
  /** The token the form's widget solved for `email-code`, if any. */
  readonly token: string | null;
  readonly now: Date;
}

/**
 * Sends `accountId` a code to verify `input`, replacing any code waiting.
 * Checked cheapest first, so a refused request never spends the solve: the
 * address (`invalid-address`), the account's limits, then the Turnstile
 * token; the limits again under the account's lock, since the token's round
 * trip lets a second request land in between. The send is counted and the
 * code stored before the message goes, so a failed send (`send-unavailable`)
 * still counts against the limits.
 *
 * Answers the same whether a code went, a notice went (another account holds
 * the address), or nothing did (the address's daily cap).
 */
export async function requestEmailCode(
  client: Sql,
  accountId: string,
  input: string,
  { keys, sender, turnstile, token, now }: RequestEmailCodeOptions,
): Promise<void> {
  checkAccountId(accountId);
  const address = parseEmailAddress(input);
  if (address === undefined) throw new EmailVerificationError("invalid-address");
  const db = drizzle({ client });
  const limit = await limitReached(db, accountId, now);
  if (limit !== undefined) throw new EmailVerificationError(limit);
  const verdict = await turnstile.verify(token, "email-code");
  if (verdict === "unavailable") throw new EmailVerificationError("challenge-unavailable");
  if (verdict !== "passed") throw new EmailVerificationError("challenge-refused");
  const code = newCode();
  const message = await db.transaction(async (tx): Promise<EmailMessage | undefined> => {
    await lockAccount(tx, accountId);
    const again = await limitReached(tx, accountId, now);
    if (again !== undefined) throw new EmailVerificationError(again);
    await lockAddress(tx, keys, address);
    const held = await addressHeld(tx, keys, accountId, address, now);
    const capped = await addressCapped(tx, keys, address, now);
    const row = {
      addressBox: seal(keys, accountId, address),
      boxKey: keys.box.current.id,
      codeKey: keys.hash.current.id,
      // A held address gets no code: a random hash, which no answer
      // matches, so the requester can't tell (T-11).
      codeHash:
        held !== undefined ? randomBytes(32) : codeHash(keys.hash.current.key, accountId, code),
      tries: 0,
      expiresAt: new Date(now.getTime() + EMAIL_CODE_SECONDS * 1000),
    };
    await tx
      .insert(accountEmailCodes)
      .values({ userId: accountId, ...row })
      .onConflictDoUpdate({ target: accountEmailCodes.userId, set: row });
    await tx.insert(accountEmailSends).values({ userId: accountId, sentAt: now });
    if (capped) return undefined;
    await tx
      .insert(accountEmailRecipients)
      .values({ addressHash: hashUnder(keys.hash.current.key, address), sentAt: hourOf(now) });
    if (held === "account") return { kind: "email-held", to: address };
    if (held === "hold") return { kind: "email-on-hold", to: address };
    return { kind: "email-code", to: address, code };
  });
  if (message !== undefined && (await sender.send(message)) !== "sent")
    throw new EmailVerificationError("send-unavailable");
}

/** A code as the form may send it: the digits, with any spaces or hyphens dropped. */
const CODE_INPUT = /^[0-9]{8}$/;

type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: EmailVerificationErrorCode; readonly triesLeft?: number };

/**
 * Verifies `accountId`'s waiting code with `input`, making its address the
 * account's verified one (replacing any earlier one) and spending the code.
 * A wrong answer costs a try, and the last try the code; an answer in any
 * other shape than 8 digits is a wrong one. `address-taken` spends the code
 * too: the address can't be verified until the other account lets it go and
 * its hold ends. An earlier address of the account's is held for
 * `EMAIL_HOLD_DAYS`.
 */
export async function verifyEmailCode(
  client: Sql,
  accountId: string,
  input: string,
  { keys, now }: { readonly keys: EmailKeys; readonly now: Date },
): Promise<void> {
  checkAccountId(accountId);
  const answer = input.replace(/[\s-]/g, "");
  const db = drizzle({ client });
  const verdict = await db.transaction(async (tx): Promise<Verdict> => {
    await lockAccount(tx, accountId);
    const [waiting] = await tx
      .select()
      .from(accountEmailCodes)
      .where(eq(accountEmailCodes.userId, accountId))
      .for("update");
    if (waiting === undefined) return { ok: false, code: "no-code" };
    const spend = () => tx.delete(accountEmailCodes).where(eq(accountEmailCodes.userId, accountId));
    if (waiting.expiresAt.getTime() <= now.getTime()) {
      await spend();
      return { ok: false, code: "expired" };
    }
    const codeKey = keys.hash.get(waiting.codeKey);
    // A key is retired only once nothing is under it (the account-keys runbook).
    if (codeKey === undefined)
      throw new Error(`email hash key ${waiting.codeKey} is not in the keyring`);
    const right =
      CODE_INPUT.test(answer) &&
      timingSafeEqual(codeHash(codeKey, accountId, answer), waiting.codeHash);
    if (!right) {
      const tries = waiting.tries + 1;
      if (tries >= EMAIL_CODE_TRIES) {
        await spend();
        return { ok: false, code: "too-many-tries" };
      }
      await tx
        .update(accountEmailCodes)
        .set({ tries })
        .where(eq(accountEmailCodes.userId, accountId));
      return { ok: false, code: "wrong-code", triesLeft: EMAIL_CODE_TRIES - tries };
    }
    await spend();
    const address = unseal(keys, accountId, waiting.addressBox, waiting.boxKey);
    await lockAddress(tx, keys, address);
    if ((await addressHeld(tx, keys, accountId, address, now)) !== undefined)
      return { ok: false, code: "address-taken" };
    // Read under the account's lock, which a rotation takes before rewriting
    // the row, so its hash and key are the ones stored.
    const [mine] = await tx
      .select({ addressHash: accountEmails.addressHash, hashKey: accountEmails.hashKey })
      .from(accountEmails)
      .where(eq(accountEmails.userId, accountId));
    const hashes = hashesOf(keys, address);
    if (mine !== undefined && !hashes.some((h) => Buffer.from(h).equals(mine.addressHash)))
      await tx
        .insert(accountEmailHolds)
        .values({ addressHash: mine.addressHash, hashKey: mine.hashKey, freedOn: dayOf(now) });
    const row = {
      addressHash: hashUnder(keys.hash.current.key, address),
      hashKey: keys.hash.current.id,
      addressBox: seal(keys, accountId, address),
      boxKey: keys.box.current.id,
      verifiedAt: now,
    };
    await tx
      .insert(accountEmails)
      .values({ userId: accountId, ...row })
      .onConflictDoUpdate({ target: accountEmails.userId, set: row });
    return { ok: true };
  });
  if (!verdict.ok) throw new EmailVerificationError(verdict.code, verdict.triesLeft);
}

/** `accountId`'s verified address and when it was verified, if it has one. */
export async function readAccountEmail(
  client: Sql,
  accountId: string,
  keys: EmailKeys,
): Promise<{ readonly address: string; readonly verifiedAt: Date } | undefined> {
  checkAccountId(accountId);
  const [row] = await drizzle({ client })
    .select()
    .from(accountEmails)
    .where(eq(accountEmails.userId, accountId));
  if (row === undefined) return undefined;
  return {
    address: unseal(keys, accountId, row.addressBox, row.boxKey),
    verifiedAt: row.verifiedAt,
  };
}

/**
 * Deletes codes that expired before `now`, sends and recipients older than
 * the daily window, and holds that have ended, returning how many of each. A
 * scheduled job (P2-4) runs it, so an abandoned code's ciphertext doesn't
 * outlive its 15 minutes by much.
 */
export async function pruneAccountEmails(
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
    .delete(accountEmailCodes)
    .where(lt(accountEmailCodes.expiresAt, now))
    .returning({ id: accountEmailCodes.userId });
  const sends = await db
    .delete(accountEmailSends)
    .where(lt(accountEmailSends.sentAt, new Date(now.getTime() - DAY)))
    .returning({ id: accountEmailSends.id });
  const recipients = await db
    .delete(accountEmailRecipients)
    .where(lt(accountEmailRecipients.sentAt, new Date(hourOf(now).getTime() - DAY)))
    .returning({ id: accountEmailRecipients.id });
  const holds = await db
    .delete(accountEmailHolds)
    .where(lte(accountEmailHolds.freedOn, holdEnded(now)))
    .returning({ id: accountEmailHolds.id });
  return {
    codes: codes.length,
    sends: sends.length,
    recipients: recipients.length,
    holds: holds.length,
  };
}

/** Rows a rotation reads at a time. */
const ROTATION_BATCH = 500;

const HASH_CHECK_LABEL = new TextEncoder().encode("abolish/email/keycheck/v1");
const BOX_CHECK_LABEL = new TextEncoder().encode("abolish/email-box/keycheck/v1");

/** What `rotateEmailKeys` did. */
export interface EmailKeyRotation {
  /** Verified addresses and waiting codes rewritten under the current keys. */
  readonly rotated: number;
  /**
   * Rows under a key the keyrings don't hold, left as they are: the keyring
   * dropped a key still in use (a hold's included, which nothing rewrites),
   * or another instance's holds one this one lacks. This instance can't match
   * or open them.
   */
  readonly unknownKeys: number;
  /**
   * Verified addresses left as they are: another account's row already holds
   * the address under the current key (two accounts on one address), or the
   * box didn't open under the key its row names.
   */
  readonly skipped: number;
  /** Keys whose bytes don't reproduce the check stored for their ID: nothing was rotated. */
  readonly mismatchedKeys: number;
}

/**
 * How many of `keys`' keys don't reproduce the check value stored for their
 * keyring and ID, storing the check of any not seen before (the first
 * instance to hold a key writes it). A hash key retyped under its ID matches
 * no address hashed or rotated under the right bytes, so an address another
 * account holds would verify again through it (T-01); a box key opens
 * nothing. The website refuses to start with one, and a rotation rewrites
 * nothing while one is held.
 */
export async function checkEmailKeys(client: Sql, keys: EmailKeys): Promise<number> {
  const db = drizzle({ client });
  const checksOf = (keyring: "hash" | "box", ring: Keyring, label: Uint8Array) =>
    ring.keys.map(({ id, key }) => ({
      keyring,
      keyId: id,
      keyCheck: createHmac("sha256", key).update(label).digest(),
    }));
  const checks = [
    ...checksOf("hash", keys.hash, HASH_CHECK_LABEL),
    ...checksOf("box", keys.box, BOX_CHECK_LABEL),
  ];
  await db.insert(accountEmailKeyChecks).values(checks).onConflictDoNothing();
  const stored = new Map(
    (await db.select().from(accountEmailKeyChecks)).map((row) => [
      `${row.keyring}:${row.keyId}`,
      Buffer.from(row.keyCheck),
    ]),
  );
  return checks.filter((c) => !stored.get(`${c.keyring}:${c.keyId}`)?.equals(c.keyCheck)).length;
}

/**
 * Rewrites every verified address under the keyrings' current keys,
 * re-hashed and re-sealed, and every waiting code's address re-sealed
 * ([[0038-verified-accounts]], Email): an address can be read back, unlike a
 * phone number, so once a rotation has run no row needs an older key, and
 * the key can leave its keyring for good (T-73). Rows under a key listed
 * after the current one (staged by a newer instance) are left alone, so an
 * instance still on an older configuration never rewrites them back.
 *
 * A waiting code's hash stays under the hash key it was made with, since the
 * code itself isn't kept; it lasts `EMAIL_CODE_SECONDS`. The per-address
 * counts aren't keyed and can't be read back; they last a day. A hold's hash
 * stays too, since its address isn't kept; it lasts `EMAIL_HOLD_DAYS`.
 *
 * Idempotent and safe beside requests, answers and other instances: a
 * verified address is rewritten under its address's locks, which requests
 * and answers hold while they check who holds it, and only if its row still
 * holds what was read; a code's only if it still holds the box read.
 *
 * Rotates nothing while any key fails its stored check (`mismatchedKeys`).
 */
export async function rotateEmailKeys(client: Sql, keys: EmailKeys): Promise<EmailKeyRotation> {
  const db = drizzle({ client });
  const mismatchedKeys = await checkEmailKeys(client, keys);

  const ids = (ring: Keyring) => ring.keys.map((k) => k.id);
  /** The ring's keys up to and including the current one: those a row may be rewritten from. */
  const upToCurrent = (ring: Keyring) => ids(ring).slice(0, ids(ring).indexOf(ring.current.id) + 1);
  const hashFrom = upToCurrent(keys.hash);
  const boxFrom = upToCurrent(keys.box);

  let rotated = 0;
  let skipped = 0;
  if (mismatchedKeys === 0) {
    for (let after: string | undefined; ;) {
      const rows = await db
        .select()
        .from(accountEmails)
        .where(
          and(
            inArray(accountEmails.hashKey, hashFrom),
            inArray(accountEmails.boxKey, boxFrom),
            or(
              ne(accountEmails.hashKey, keys.hash.current.id),
              ne(accountEmails.boxKey, keys.box.current.id),
            ),
            after === undefined ? undefined : gt(accountEmails.userId, after),
          ),
        )
        .orderBy(asc(accountEmails.userId))
        .limit(ROTATION_BATCH);
      for (const row of rows) {
        let address: string;
        try {
          address = unseal(keys, row.userId, row.addressBox, row.boxKey);
        } catch {
          skipped++;
          continue;
        }
        const outcome = await db.transaction(async (tx) => {
          // The account's lock, then the address's, as a request or an
          // answer takes them: no account verifies the address while its row
          // is between hashes, and no lock waits in a cycle with an answer.
          await lockAccount(tx, row.userId);
          await lockAddress(tx, keys, address);
          const addressHash = hashUnder(keys.hash.current.key, address);
          const [taken] = await tx
            .select({ userId: accountEmails.userId })
            .from(accountEmails)
            .where(
              and(eq(accountEmails.addressHash, addressHash), ne(accountEmails.userId, row.userId)),
            );
          // Two accounts on one address, which only an instance without a
          // key could have let happen: left for the operator, never sent to
          // the database to refuse, whose log would carry the hash.
          if (taken !== undefined) return "skipped";
          const done = await tx
            .update(accountEmails)
            .set({
              addressHash,
              hashKey: keys.hash.current.id,
              addressBox: seal(keys, row.userId, address),
              boxKey: keys.box.current.id,
            })
            .where(
              and(
                eq(accountEmails.userId, row.userId),
                eq(accountEmails.addressHash, row.addressHash),
                eq(accountEmails.addressBox, row.addressBox),
              ),
            )
            .returning({ userId: accountEmails.userId });
          return done.length === 1 ? "rotated" : "gone";
        });
        if (outcome === "rotated") rotated++;
        if (outcome === "skipped") skipped++;
      }
      if (rows.length < ROTATION_BATCH) break;
      after = rows[rows.length - 1]!.userId;
    }

    for (let after: string | undefined; ;) {
      const rows = await db
        .select({
          userId: accountEmailCodes.userId,
          addressBox: accountEmailCodes.addressBox,
          boxKey: accountEmailCodes.boxKey,
        })
        .from(accountEmailCodes)
        .where(
          and(
            inArray(accountEmailCodes.boxKey, boxFrom),
            ne(accountEmailCodes.boxKey, keys.box.current.id),
            after === undefined ? undefined : gt(accountEmailCodes.userId, after),
          ),
        )
        .orderBy(asc(accountEmailCodes.userId))
        .limit(ROTATION_BATCH);
      for (const row of rows) {
        let address: string;
        try {
          address = unseal(keys, row.userId, row.addressBox, row.boxKey);
        } catch {
          skipped++;
          continue;
        }
        // An answer reads the code under its row lock and changes only its
        // tries or deletes it, so this waits for it, then finds the box it
        // read or nothing.
        const done = await db
          .update(accountEmailCodes)
          .set({ addressBox: seal(keys, row.userId, address), boxKey: keys.box.current.id })
          .where(
            and(
              eq(accountEmailCodes.userId, row.userId),
              eq(accountEmailCodes.addressBox, row.addressBox),
            ),
          )
          .returning({ userId: accountEmailCodes.userId });
        rotated += done.length;
      }
      if (rows.length < ROTATION_BATCH) break;
      after = rows[rows.length - 1]!.userId;
    }
  }

  const unknownKeys =
    (await db.$count(
      accountEmails,
      or(
        notInArray(accountEmails.hashKey, ids(keys.hash)),
        notInArray(accountEmails.boxKey, ids(keys.box)),
      ),
    )) +
    (await db.$count(
      accountEmailCodes,
      or(
        notInArray(accountEmailCodes.boxKey, ids(keys.box)),
        notInArray(accountEmailCodes.codeKey, ids(keys.hash)),
      ),
    )) +
    (await db.$count(accountEmailHolds, notInArray(accountEmailHolds.hashKey, ids(keys.hash))));
  return { rotated, unknownKeys, skipped, mismatchedKeys };
}
