// Creator profiles ([[0040-creator-profiles]]; [[P2-27]] part 1b): an
// account may make one profile, a name it chooses and a random handle, and
// choose for each of its polls whether the profile shows it. A poll not
// chosen names no author anywhere. A profile moderation hid
// (src/profile-moderation.ts) shows only its handle and the reason, and names
// no poll's author, until it is restored.
//
// T-10: account-side rows that name an account, its profile and its own
// polls' creator records, never a ballot, a nullifier, a receipt or the fact
// of having answered: a profile is about asking, never answering. The public
// reads join the creator record to the stored definitions and the moderation
// log, both public, to show only registered polls that are listed.
//
// T-75: the name and which polls an author linked become public, and that
// those polls share an author; nothing else about the account does. The
// handle is 80 bits from the CSPRNG, never derived from the account, the name
// or anything else, never chosen by the author and never issued twice
// (`profile_handles` keeps each). The name is the author's, unverified and not
// unique; `profileName` admits no control, format, private-use, unassigned,
// default-ignorable or separator characters but the space, and needs one
// visible character, so no bidi override or invisible character hides in it. Look-alike letters pass, and only `impersonation`
// moderation answers them. A name is set at most once a UTC day, making a
// profile included, and the day outlives the profile, so deleting and making
// one again doesn't flip a name faster (T-52, T-75).
//
// T-52: one profile per account, made only by an account with a verified
// phone ([[0038-verified-accounts]]), so profiles cost what numbers cost; a
// profile shows at most the polls its account wrote.

import { and, asc, desc, eq, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import {
  accountPhones,
  accountPolls,
  accountProfileNamings,
  accountProfilePolls,
  accountProfiles,
  electionDefinitions,
  electionRegistrations,
  moderationActions,
  profileHandles,
  profileModerationActions,
} from "./db/schema/index.ts";
import { type RemovalReason, statusOf } from "./moderation.ts";

/** The longest name, in code points; the table's check holds it too. */
export const MAX_PROFILE_NAME = 60;
/** The most polls `readProfile` returns, the newest registered first. */
export const MAX_PROFILE_POLLS = 100;
/** A profile's handle: 16 characters of lowercase RFC 4648 base32, 80 random bits. */
export const PROFILE_HANDLE = /^[a-z2-7]{16}$/;

export type ProfileErrorCode =
  /** The account has no verified phone. */
  | "account"
  /** The account already has a profile. */
  | "exists"
  /** `profileName` refuses the name. */
  | "invalid-name"
  /** The account has no profile. */
  | "no-profile"
  /** The account set a name already this UTC day. */
  | "too-soon"
  /** No poll with this ID belongs to the account. */
  | "not-found";

export class ProfileError extends Error {
  override readonly name = "ProfileError";
  readonly code: ProfileErrorCode;
  constructor(code: ProfileErrorCode) {
    super(`profile: ${code}`);
    this.code = code;
  }
}

/** An account or poll ID as `newAccountId` makes them. */
const ID = /^[a-z0-9]{32}$/;

function checkId(id: string, what: string): void {
  if (typeof id !== "string" || !ID.test(id)) throw new RangeError(`not ${what}`);
}

const dayOf = (now: Date) => {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    throw new TypeError("now must be a valid Date");
  return new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000);
};

// T-75: controls (tabs and newlines included), format characters (bidi
// overrides, zero-width joiners), private use, unassigned code points, lone
// surrogates, line and paragraph separators, every space but U+0020, and the
// letters and marks that render as nothing: default-ignorable code points
// (Hangul fillers, the combining grapheme joiner, variation selectors) and
// the blank Braille pattern.
const FORBIDDEN =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]|[^\P{Zs} ]/u;
/** Something a reader sees: a name of combining marks and spaces alone is blank. */
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

/**
 * `name` as a profile stores it, or `undefined` if it can't be one: refused
 * if it holds a `FORBIDDEN` character or nothing `VISIBLE`; otherwise runs of spaces collapsed to
 * one, the ends trimmed and the whole in Unicode NFC, then 1 to
 * `MAX_PROFILE_NAME` code points.
 */
export function profileName(name: unknown): string | undefined {
  if (typeof name !== "string" || FORBIDDEN.test(name) || !VISIBLE.test(name)) return undefined;
  const n = name.replace(/ {2,}/g, " ").trim().normalize("NFC");
  const length = Array.from(n).length;
  return length >= 1 && length <= MAX_PROFILE_NAME ? n : undefined;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A fresh handle: 10 bytes from the CSPRNG in lowercase RFC 4648 base32. */
export function newProfileHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let handle = "";
  for (let i = 15; i >= 0; i--) handle += BASE32[Number((bits >> BigInt(i * 5)) & 31n)];
  return handle;
}

type Db = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One account's lock on its profile, so two requests can't both pass a check. */
const lock = (tx: Tx, accountId: string) =>
  tx.execute(
    q`SELECT pg_advisory_xact_lock(hashtextextended(${`account_profiles:${accountId}`}, 0))`,
  );

/** Whether the account set a name on `day` or later (a clock that ran ahead). */
async function namedSince(tx: Tx, accountId: string, day: Date): Promise<boolean> {
  const [row] = await tx
    .select({ namedOn: accountProfileNamings.namedOn })
    .from(accountProfileNamings)
    .where(eq(accountProfileNamings.userId, accountId));
  return row !== undefined && row.namedOn.getTime() >= day.getTime();
}

const recordNaming = (tx: Tx, accountId: string, day: Date) =>
  tx
    .insert(accountProfileNamings)
    .values({ userId: accountId, namedOn: day })
    .onConflictDoUpdate({ target: accountProfileNamings.userId, set: { namedOn: day } });

/**
 * Makes `accountId`'s profile named `name`, returning its new handle.
 * Refused, with nothing written, in this order: a name `profileName` refuses
 * (`invalid-name`), an account with no verified phone (`account`), one that
 * has a profile (`exists`) and one that set a name already this UTC day,
 * under this profile or one since deleted (`too-soon`).
 */
export async function makeProfile(
  client: Sql,
  accountId: string,
  name: string,
  { now }: { readonly now: Date },
): Promise<string> {
  checkId(accountId, "an account ID");
  const day = dayOf(now);
  const n = profileName(name);
  if (n === undefined) throw new ProfileError("invalid-name");
  return drizzle({ client }).transaction(async (tx) => {
    await lock(tx, accountId);
    if ((await tx.$count(accountPhones, eq(accountPhones.userId, accountId))) === 0)
      throw new ProfileError("account");
    if ((await tx.$count(accountProfiles, eq(accountProfiles.userId, accountId))) > 0)
      throw new ProfileError("exists");
    if (await namedSince(tx, accountId, day)) throw new ProfileError("too-soon");
    // 80 random bits make a collision negligible; the key refuses one anyway,
    // and a retired handle is never issued again.
    const handle = newProfileHandle();
    await tx.insert(profileHandles).values({ handle });
    await tx.insert(accountProfiles).values({ userId: accountId, handle, name: n });
    await recordNaming(tx, accountId, day);
    return handle;
  });
}

/**
 * Renames `accountId`'s profile to `name`, returning whether the name
 * changed: the name it has already changes nothing and isn't counted against
 * the day. Refused, with nothing written, in this order: a name `profileName`
 * refuses (`invalid-name`), an account with no profile (`no-profile`) and one
 * that set a name already this UTC day (`too-soon`). The handle never
 * changes, and every poll the profile shows takes the new name.
 */
export async function renameProfile(
  client: Sql,
  accountId: string,
  name: string,
  { now }: { readonly now: Date },
): Promise<boolean> {
  checkId(accountId, "an account ID");
  const day = dayOf(now);
  const n = profileName(name);
  if (n === undefined) throw new ProfileError("invalid-name");
  return drizzle({ client }).transaction(async (tx) => {
    await lock(tx, accountId);
    const [row] = await tx
      .select({ name: accountProfiles.name })
      .from(accountProfiles)
      .where(eq(accountProfiles.userId, accountId));
    if (row === undefined) throw new ProfileError("no-profile");
    if (row.name === n) return false;
    if (await namedSince(tx, accountId, day)) throw new ProfileError("too-soon");
    await tx.update(accountProfiles).set({ name: n }).where(eq(accountProfiles.userId, accountId));
    await recordNaming(tx, accountId, day);
    return true;
  });
}

/**
 * Deletes `accountId`'s profile and every poll's choice with it, returning
 * whether it had one. Its handle is retired, never issued again; its polls
 * stay, naming no author. The day it last set a name is kept.
 */
export async function deleteProfile(client: Sql, accountId: string): Promise<boolean> {
  checkId(accountId, "an account ID");
  return drizzle({ client }).transaction(async (tx) => {
    // So a choice being made sees the profile gone and is refused as such.
    await lock(tx, accountId);
    const rows = await tx
      .delete(accountProfiles)
      .where(eq(accountProfiles.userId, accountId))
      .returning({ one: q<number>`1` });
    return rows.length > 0;
  });
}

/**
 * Shows (`on`) or stops showing `accountId`'s poll `pollId` on its profile,
 * at any state of the poll, returning whether anything changed. Showing is
 * refused, with nothing written, for an account with no profile
 * (`no-profile`) and a poll it didn't write (`not-found`); the table's keys
 * hold both too. Stopping is always allowed.
 */
export async function showOnProfile(
  client: Sql,
  accountId: string,
  pollId: string,
  on: boolean,
): Promise<boolean> {
  checkId(accountId, "an account ID");
  checkId(pollId, "a poll ID");
  if (typeof on !== "boolean") throw new TypeError("on must be a boolean");
  const p = accountProfilePolls;
  if (!on) {
    const rows = await drizzle({ client })
      .delete(p)
      .where(and(eq(p.pollId, pollId), eq(p.userId, accountId)))
      .returning({ one: q<number>`1` });
    return rows.length > 0;
  }
  return drizzle({ client }).transaction(async (tx) => {
    await lock(tx, accountId);
    if ((await tx.$count(accountProfiles, eq(accountProfiles.userId, accountId))) === 0)
      throw new ProfileError("no-profile");
    const owned = and(eq(accountPolls.id, pollId), eq(accountPolls.userId, accountId));
    if ((await tx.$count(accountPolls, owned)) === 0) throw new ProfileError("not-found");
    const rows = await tx
      .insert(p)
      .values({ pollId, userId: accountId })
      .onConflictDoNothing()
      .returning({ one: q<number>`1` });
    return rows.length > 0;
  });
}

/** An account's own profile, for its own settings only. */
export interface OwnProfile {
  readonly handle: string;
  readonly name: string;
  /** The first UTC day the name can change again; none if it can today. */
  readonly renamableOn: Date | undefined;
  /** The IDs of its polls the profile shows, whatever their state. */
  readonly pollIds: readonly string[];
}

/** `accountId`'s profile, or `undefined` if it has none, as of `now`. */
export async function readOwnProfile(
  client: Sql,
  accountId: string,
  { now }: { readonly now: Date },
): Promise<OwnProfile | undefined> {
  checkId(accountId, "an account ID");
  const day = dayOf(now);
  const db = drizzle({ client });
  const [row] = await db
    .select({
      handle: accountProfiles.handle,
      name: accountProfiles.name,
      namedOn: accountProfileNamings.namedOn,
    })
    .from(accountProfiles)
    .leftJoin(accountProfileNamings, eq(accountProfileNamings.userId, accountProfiles.userId))
    .where(eq(accountProfiles.userId, accountId));
  if (row === undefined) return undefined;
  const polls = await db
    .select({ pollId: accountProfilePolls.pollId })
    .from(accountProfilePolls)
    .where(eq(accountProfilePolls.userId, accountId))
    .orderBy(asc(accountProfilePolls.pollId));
  const next = row.namedOn === null ? undefined : new Date(row.namedOn.getTime() + 86_400_000);
  return {
    handle: row.handle,
    name: row.name,
    renamableOn: next !== undefined && next.getTime() > day.getTime() ? next : undefined,
    pollIds: polls.map((r) => r.pollId),
  };
}

/**
 * A profile as anyone may see it: its name and the polls it shows that are
 * listed, or, while moderation hides it, only the ground it was hidden on.
 */
export type PublicProfile =
  | {
      readonly handle: string;
      readonly state: "visible";
      readonly name: string;
      /**
       * The election IDs of the polls it shows whose definition the registry
       * sync stored and that are neither delisted nor hidden, the latest
       * registered first, at most `MAX_PROFILE_POLLS`.
       */
      readonly polls: readonly Uint8Array[];
    }
  | {
      readonly handle: string;
      readonly state: "hidden";
      /** The ground of the newest hide (src/profile-moderation.ts). */
      readonly reason: RemovalReason;
    };

/**
 * The newest decision about the profile at `handle` hides it: the reason, or
 * `undefined` while it is shown.
 */
async function hiddenFor(
  db: Pick<Db, "select">,
  handle: string,
): Promise<RemovalReason | undefined> {
  const t = profileModerationActions;
  const [row] = await db
    .select({ action: t.action, reason: t.reason })
    .from(t)
    .where(eq(t.handle, handle))
    .orderBy(desc(t.seq))
    .limit(1);
  // The table's check constraint gives a hide a removal reason.
  return row?.action === "hide" ? (row.reason as RemovalReason) : undefined;
}

/**
 * The profile at `handle`, or `undefined` if none has it: never made,
 * deleted, or not a handle at all. Nothing about the account, the profile's
 * age or its other polls (drafts, failures, unlisted or unlinked ones), and
 * neither name nor polls while moderation hides it (T-75). Read in one
 * snapshot, so a hide and the name can't pass each other.
 */
export async function readProfile(client: Sql, handle: string): Promise<PublicProfile | undefined> {
  if (typeof handle !== "string" || !PROFILE_HANDLE.test(handle)) return undefined;
  return drizzle({ client }).transaction((tx) => profileOf(tx, handle), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

async function profileOf(db: Tx, handle: string): Promise<PublicProfile | undefined> {
  const [profile] = await db
    .select({ userId: accountProfiles.userId, name: accountProfiles.name })
    .from(accountProfiles)
    .where(eq(accountProfiles.handle, handle));
  if (profile === undefined) return undefined;
  const hidden = await hiddenFor(db, handle);
  if (hidden !== undefined) return { handle, state: "hidden", reason: hidden };
  // The newest decision about each poll, as the listing reads it.
  const newest = db
    .select({ action: moderationActions.action })
    .from(moderationActions)
    .where(eq(moderationActions.electionId, electionDefinitions.electionId))
    .orderBy(desc(moderationActions.seq))
    .limit(1);
  const rows = await db
    .select({ electionId: electionDefinitions.electionId })
    .from(accountProfilePolls)
    .innerJoin(accountPolls, eq(accountPolls.id, accountProfilePolls.pollId))
    .innerJoin(electionDefinitions, eq(electionDefinitions.electionId, accountPolls.electionId))
    .leftJoin(
      electionRegistrations,
      eq(electionRegistrations.electionId, electionDefinitions.electionId),
    )
    .where(
      and(
        eq(accountProfilePolls.userId, profile.userId),
        q`coalesce((${newest}), 'restore') = 'restore'`,
      ),
    )
    .orderBy(
      q`${electionRegistrations.l2Block} DESC NULLS LAST`,
      q`${electionRegistrations.logIndex} DESC NULLS LAST`,
      asc(electionDefinitions.electionId),
    )
    .limit(MAX_PROFILE_POLLS);
  return {
    handle,
    state: "visible",
    name: profile.name,
    polls: rows.map((r) => new Uint8Array(r.electionId)),
  };
}

/** Who asked a poll, as its page and card say it. */
export interface AskedBy {
  readonly handle: string;
  readonly name: string;
}

/**
 * The profile `electionId`'s author chose to show the poll on, or
 * `undefined`: none chosen, no profile, no creator record (a poll not made
 * on the website, or one a wipe or account deletion took), a hidden poll,
 * whose page shows none of it, or a profile moderation hid. "Asked by" is our database's word, never part
 * of the poll anyone can verify (T-75).
 */
export async function askedBy(client: Sql, electionId: Uint8Array): Promise<AskedBy | undefined> {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
  const id = new Uint8Array(electionId);
  return drizzle({ client }).transaction(
    async (tx) => {
      const [row] = await tx
        .select({ handle: accountProfiles.handle, name: accountProfiles.name })
        .from(accountPolls)
        .innerJoin(accountProfilePolls, eq(accountProfilePolls.pollId, accountPolls.id))
        .innerJoin(accountProfiles, eq(accountProfiles.userId, accountProfilePolls.userId))
        .where(eq(accountPolls.electionId, id));
      if (row === undefined) return undefined;
      if ((await statusOf(tx, id)).state === "hidden") return undefined;
      if ((await hiddenFor(tx, row.handle)) !== undefined) return undefined;
      return row;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
