// An account's own data, for the account to take away ([[P2-27]] part 2a):
// everything the account tables hold about it, as one JSON document. Only
// the account itself asks for it (the website's route, part 2b), and what it
// gets back is a file outside our control from then on, so the export leaves
// out what would harm the account in another's hands and adds nothing for it
// to read: secrets (session tokens, passkeys' public keys and credential IDs,
// better-auth's provider tokens), the keyed hashes and ciphertexts we keep in
// place of an address or a number, and rate-limit counts. Of a poll it
// gives what the author wrote and what became of it (state, times, election
// ID, failure), not the chain's bookkeeping (creator address, transaction
// hashes, blocks, the electorate's cells), which is public on chain or
// derived from the draft. `ACCOUNT_EXPORT` names, for every account table,
// what the export takes from it or why it takes nothing, and a test holds
// that list equal to the account class.
//
// T-10: account tables only, read in one snapshot. None of them names a
// ballot, a nullifier, a receipt or the fact of having answered (the no-join
// tests), so neither can the export. A Tier 0 token's record gives its group
// and key period, never the blinded element: on its own that element names
// nothing, but with the blinding the voter's device keeps it is one step
// toward the voting identity, and an exported file may be copied anywhere.
// For the same reason the address's verification is given to the day, as
// the number's is: the token is taken once the account is verified, and a
// time to the second would narrow which of the next day's joins is its.
// T-73: the address is opened only here and to send to it, and the export
// gives the number's verification day only, as the number itself is gone.
// T-68: an appeal's outcome without its reviewer, as the author's own view.

import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { type EmailKeys, unsealEmailAddress } from "./account-emails.ts";
import {
  accountAppeals,
  accountCredentials,
  accountEmails,
  accountModerators,
  accountPasskeys,
  accountPhones,
  accountPolls,
  accountProfileAppeals,
  accountProfileNamings,
  accountProfilePolls,
  accountProfiles,
  accountReactions,
  accountSessions,
  accountTokens,
  accountUsers,
} from "./db/schema/index.ts";

/** The export's layout; a change to it is a new version. */
export const ACCOUNT_EXPORT_VERSION = 2;

/**
 * What the export takes from each account table: `"exported"`, or why it
 * takes nothing. Every account table is named, so a new one is a decision.
 */
export const ACCOUNT_EXPORT = {
  account_appeals: "exported",
  account_credentials: "exported",
  account_email_codes:
    "a pending code: its address's ciphertext and the code's hash, gone in 15 minutes",
  account_email_holds: "names no account: a freed address's hash",
  account_email_key_checks: "names no account: the keyrings' checks",
  account_email_recipients: "names no account: an address's hash and send time, for its daily cap",
  account_email_sends: "rate-limit counts, gone in a day",
  account_emails: "exported",
  account_moderators: "exported",
  account_notices:
    "a moderation notice waiting to be e-mailed, gone once sent: a due time and a try count",
  account_passkeys: "exported",
  account_phone_codes: "a pending code: the number's hash, gone in 10 minutes",
  account_phone_holds: "names no account: a freed number's hash",
  account_phone_key_checks: "names no account: the keyring's checks",
  account_phone_recipients: "names no account: a number's hash and send time, for its daily cap",
  account_phone_sends: "rate-limit counts, gone in a day",
  account_phones: "exported",
  account_poll_submissions: "rate-limit counts, gone in a day",
  account_polls: "exported",
  account_profile_appeals: "exported",
  account_profile_namings: "exported",
  account_profile_polls: "exported",
  account_profiles: "exported",
  account_push_subscriptions:
    "a browser's push endpoint: a standing way to wake that browser, which the browser itself holds",
  account_reaction_hours: "rate-limit counts, gone in two hours",
  account_reactions: "exported",
  account_sessions: "exported",
  account_tokens: "exported",
  account_users: "exported",
  account_verifications: "a passkey ceremony's challenge, gone in minutes",
  profile_handles: "names no account: every handle ever issued",
} as const;

/** An appeal as its author sees it: never who reviewed it (T-68). */
export interface ExportedAppeal {
  readonly decisionSeq: string;
  readonly filedAt: string;
  readonly outcome: string | null;
  readonly reviewedAt: string | null;
}

/** An account's data as `exportAccount` gives it: times ISO 8601, bytes hex. */
export interface AccountExport {
  readonly version: typeof ACCOUNT_EXPORT_VERSION;
  readonly exportedAt: string;
  readonly account: { readonly id: string; readonly createdAt: string };
  readonly passkeys: readonly {
    readonly createdAt: string | null;
    readonly deviceType: string;
    readonly backedUp: boolean;
  }[];
  readonly sessions: readonly { readonly createdAt: string; readonly expiresAt: string }[];
  readonly signInMethods: readonly { readonly providerId: string; readonly createdAt: string }[];
  /**
   * The address is `null` if its box no longer opens (its key left the
   * keyring) or the deployment holds no e-mail keys. `locale` is the
   * language its notices are written in (version 2).
   */
  readonly email: {
    readonly address: string | null;
    readonly verifiedOn: string;
    readonly locale: string;
  } | null;
  /** The number itself is never kept. */
  readonly phone: { readonly verifiedOn: string } | null;
  readonly polls: readonly {
    readonly id: string;
    readonly state: string;
    readonly draft: unknown;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly submittedAt: string | null;
    readonly electionId: string | null;
    readonly failure: string | null;
    readonly appeals: readonly ExportedAppeal[];
  }[];
  readonly profile: {
    readonly handle: string;
    readonly name: string;
    readonly pollIds: readonly string[];
    readonly appeals: readonly ExportedAppeal[];
  } | null;
  /** Kept when the profile is deleted, for the one name a day. */
  readonly profileNamedOn: string | null;
  readonly reactions: readonly { readonly electionId: string; readonly reaction: string }[];
  readonly tier0Tokens: readonly {
    readonly chainId: string;
    readonly groupRegistry: string;
    readonly region: number;
    readonly keyPeriod: number | null;
  }[];
  readonly moderator: { readonly handle: string; readonly addedAt: string } | null;
}

/** An account ID as `newAccountId` makes them. */
const ACCOUNT_ID = /^[a-z0-9]{32}$/;

const iso = (d: Date) => d.toISOString();
const isoOr = (d: Date | null) => (d === null ? null : d.toISOString());
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const dayOf = (d: Date) => new Date(Math.floor(d.getTime() / 86_400_000) * 86_400_000);

// A box the rotation couldn't move, or a deployment that no longer holds the
// e-mail keys, keeps an account's export from failing: the rest is still the
// account's to take.
function opened(keys: EmailKeys | undefined, accountId: string, box: Uint8Array, keyId: string) {
  if (keys === undefined) return null;
  try {
    return unsealEmailAddress(keys, accountId, box, keyId);
  } catch {
    return null;
  }
}

const appealOf = (r: {
  decisionSeq: bigint;
  filedAt: Date;
  outcome: string | null;
  reviewedAt: Date | null;
}): ExportedAppeal => ({
  decisionSeq: r.decisionSeq.toString(),
  filedAt: iso(r.filedAt),
  outcome: r.outcome,
  reviewedAt: isoOr(r.reviewedAt),
});

/**
 * Everything the account tables hold about `accountId` that `ACCOUNT_EXPORT`
 * exports, read in one snapshot, or `undefined` if there is no such account.
 * `keys` opens the address's box; without them the address is `null`.
 */
export async function exportAccount(
  client: Sql,
  accountId: string,
  { keys, now }: { readonly keys: EmailKeys | undefined; readonly now: Date },
): Promise<AccountExport | undefined> {
  if (!ACCOUNT_ID.test(accountId)) throw new RangeError("not an account ID");
  return drizzle({ client }).transaction(
    async (tx) => {
      const [user] = await tx
        .select({ createdAt: accountUsers.createdAt })
        .from(accountUsers)
        .where(eq(accountUsers.id, accountId));
      if (user === undefined) return undefined;
      const passkeys = await tx
        .select({
          createdAt: accountPasskeys.createdAt,
          deviceType: accountPasskeys.deviceType,
          backedUp: accountPasskeys.backedUp,
        })
        .from(accountPasskeys)
        .where(eq(accountPasskeys.userId, accountId))
        .orderBy(asc(accountPasskeys.createdAt), asc(accountPasskeys.id));
      const sessions = await tx
        .select({ createdAt: accountSessions.createdAt, expiresAt: accountSessions.expiresAt })
        .from(accountSessions)
        .where(eq(accountSessions.userId, accountId))
        .orderBy(asc(accountSessions.createdAt), asc(accountSessions.id));
      const credentials = await tx
        .select({
          providerId: accountCredentials.providerId,
          createdAt: accountCredentials.createdAt,
        })
        .from(accountCredentials)
        .where(eq(accountCredentials.userId, accountId))
        .orderBy(asc(accountCredentials.createdAt), asc(accountCredentials.id));
      const [email] = await tx
        .select({
          addressBox: accountEmails.addressBox,
          boxKey: accountEmails.boxKey,
          verifiedAt: accountEmails.verifiedAt,
          locale: accountEmails.locale,
        })
        .from(accountEmails)
        .where(eq(accountEmails.userId, accountId));
      const [phone] = await tx
        .select({ verifiedOn: accountPhones.verifiedOn })
        .from(accountPhones)
        .where(eq(accountPhones.userId, accountId));
      const polls = await tx
        .select({
          id: accountPolls.id,
          state: accountPolls.state,
          draft: accountPolls.draft,
          createdAt: accountPolls.createdAt,
          updatedAt: accountPolls.updatedAt,
          submittedAt: accountPolls.submittedAt,
          electionId: accountPolls.electionId,
          failure: accountPolls.failure,
        })
        .from(accountPolls)
        .where(eq(accountPolls.userId, accountId))
        .orderBy(asc(accountPolls.createdAt), asc(accountPolls.id));
      const appeals = await tx
        .select({
          pollId: accountAppeals.pollId,
          decisionSeq: accountAppeals.decisionSeq,
          filedAt: accountAppeals.filedAt,
          outcome: accountAppeals.outcome,
          reviewedAt: accountAppeals.reviewedAt,
        })
        .from(accountAppeals)
        .innerJoin(accountPolls, eq(accountPolls.id, accountAppeals.pollId))
        .where(eq(accountPolls.userId, accountId))
        .orderBy(asc(accountAppeals.decisionSeq));
      const [profile] = await tx
        .select({ handle: accountProfiles.handle, name: accountProfiles.name })
        .from(accountProfiles)
        .where(eq(accountProfiles.userId, accountId));
      const shown =
        profile === undefined
          ? []
          : await tx
              .select({ pollId: accountProfilePolls.pollId })
              .from(accountProfilePolls)
              .where(eq(accountProfilePolls.userId, accountId))
              .orderBy(asc(accountProfilePolls.pollId));
      const profileAppeals =
        profile === undefined
          ? []
          : await tx
              .select({
                decisionSeq: accountProfileAppeals.decisionSeq,
                filedAt: accountProfileAppeals.filedAt,
                outcome: accountProfileAppeals.outcome,
                reviewedAt: accountProfileAppeals.reviewedAt,
              })
              .from(accountProfileAppeals)
              .where(eq(accountProfileAppeals.handle, profile.handle))
              .orderBy(asc(accountProfileAppeals.decisionSeq));
      const [naming] = await tx
        .select({ namedOn: accountProfileNamings.namedOn })
        .from(accountProfileNamings)
        .where(eq(accountProfileNamings.userId, accountId));
      const reactions = await tx
        .select({ electionId: accountReactions.electionId, reaction: accountReactions.reaction })
        .from(accountReactions)
        .where(eq(accountReactions.userId, accountId))
        .orderBy(asc(accountReactions.electionId), asc(accountReactions.reaction));
      const tokens = await tx
        .select({
          chainId: accountTokens.chainId,
          groupRegistry: accountTokens.groupRegistry,
          region: accountTokens.region,
          keyPeriod: accountTokens.keyPeriod,
        })
        .from(accountTokens)
        .where(eq(accountTokens.userId, accountId))
        .orderBy(asc(accountTokens.chainId), asc(accountTokens.groupRegistry));
      const [moderator] = await tx
        .select({ handle: accountModerators.handle, addedAt: accountModerators.addedAt })
        .from(accountModerators)
        .where(eq(accountModerators.userId, accountId));
      return {
        version: ACCOUNT_EXPORT_VERSION,
        exportedAt: iso(now),
        account: { id: accountId, createdAt: iso(user.createdAt) },
        passkeys: passkeys.map((p) => ({ ...p, createdAt: isoOr(p.createdAt) })),
        sessions: sessions.map((s) => ({
          createdAt: iso(s.createdAt),
          expiresAt: iso(s.expiresAt),
        })),
        signInMethods: credentials.map((c) => ({ ...c, createdAt: iso(c.createdAt) })),
        email:
          email === undefined
            ? null
            : {
                address: opened(keys, accountId, email.addressBox, email.boxKey),
                verifiedOn: iso(dayOf(email.verifiedAt)),
                locale: email.locale,
              },
        phone: phone === undefined ? null : { verifiedOn: iso(phone.verifiedOn) },
        polls: polls.map((p) => ({
          id: p.id,
          state: p.state,
          draft: p.draft,
          createdAt: iso(p.createdAt),
          updatedAt: iso(p.updatedAt),
          submittedAt: isoOr(p.submittedAt),
          electionId: p.electionId === null ? null : hex(p.electionId),
          failure: p.failure,
          appeals: appeals.filter((a) => a.pollId === p.id).map(appealOf),
        })),
        profile:
          profile === undefined
            ? null
            : {
                handle: profile.handle,
                name: profile.name,
                pollIds: shown.map((s) => s.pollId),
                appeals: profileAppeals.map(appealOf),
              },
        profileNamedOn: naming === undefined ? null : iso(naming.namedOn),
        reactions: reactions.map((r) => ({ electionId: hex(r.electionId), reaction: r.reaction })),
        tier0Tokens: tokens.map((t) => ({
          chainId: t.chainId.toString(),
          groupRegistry: hex(t.groupRegistry),
          region: t.region,
          keyPeriod: t.keyPeriod,
        })),
        moderator:
          moderator === undefined
            ? null
            : { handle: moderator.handle, addedAt: iso(moderator.addedAt) },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
