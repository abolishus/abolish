import {
  accountCredentials,
  accountPasskeys,
  accountSessions,
  accountUsers,
  accountVerifications,
} from "./accounts.ts";
import { accountAppeals, accountModerators } from "./appeals.ts";
import {
  boardBallotHashes,
  boardBallotKeys,
  boardCheckpoints,
  boardEntries,
  boardShareReceipts,
  boardSubtrees,
} from "./board.ts";
import { electionDefinitions, electionRegistrations, electionSchedules } from "./definitions.ts";
import { displayTexts, displayTextSearch } from "./display-texts.ts";
import {
  accountEmailCodes,
  accountEmailRecipients,
  accountEmails,
  accountEmailSends,
} from "./emails.ts";
import { identityBackups } from "./identity-backups.ts";
import { moderationActions, moderationReports } from "./moderation.ts";
import {
  accountPhoneCodes,
  accountPhoneHolds,
  accountPhoneRecipients,
  accountPhones,
  accountPhoneSends,
} from "./phones.ts";
import {
  accountPolls,
  accountPollSubmissions,
  ceremonyApprovals,
  ceremonyMessages,
  ceremonyRuns,
  ceremonyStubs,
  pollCreationTxs,
} from "./polls.ts";

export {
  accountAppeals,
  accountCredentials,
  accountEmailCodes,
  accountEmailRecipients,
  accountEmails,
  accountEmailSends,
  accountModerators,
  accountPhoneCodes,
  accountPhoneHolds,
  accountPhoneRecipients,
  accountPhones,
  accountPhoneSends,
  accountPolls,
  accountPollSubmissions,
  accountPasskeys,
  accountSessions,
  accountUsers,
  accountVerifications,
  boardBallotHashes,
  boardBallotKeys,
  boardCheckpoints,
  boardEntries,
  boardShareReceipts,
  boardSubtrees,
  ceremonyApprovals,
  ceremonyMessages,
  ceremonyRuns,
  ceremonyStubs,
  displayTexts,
  displayTextSearch,
  electionDefinitions,
  electionRegistrations,
  electionSchedules,
  identityBackups,
  moderationActions,
  moderationReports,
  pollCreationTxs,
};

/**
 * Every table in the schema, by class. Board tables hold public bulletin-board
 * data and are rebuilt from chain + IPFS. Account tables hold accounts
 * (better-auth) and the polls each account wrote (ADR 0032): who someone is
 * to the app, never how they voted. Operational tables (moderation, caches)
 * hold nothing a result depends on.
 * Identity tables hold voting-identity backups (ADR 0017): operational, since
 * a wipe changes no result, but on the ballot side of the no-join rules. A
 * test fails on any table not listed here, on any foreign key that touches a
 * board or identity table or leaves the account tables, on a column of the
 * board or identity class that could name an account and an account column
 * that could name a ballot, and on a function that reads an account table
 * with a board or identity table (.claude/skills/migrations; T-10, T-13, T-20).
 */
export const TABLE_CLASSES = {
  board: [
    "board_ballot_hashes",
    "board_ballot_keys",
    "board_checkpoints",
    "board_entries",
    "board_share_receipts",
    "board_subtrees",
    "election_definitions",
    "election_registrations",
    "election_schedules",
  ],
  account: [
    "account_appeals",
    "account_credentials",
    "account_email_codes",
    "account_email_recipients",
    "account_email_sends",
    "account_emails",
    "account_moderators",
    "account_passkeys",
    "account_phone_codes",
    "account_phone_holds",
    "account_phone_recipients",
    "account_phone_sends",
    "account_phones",
    "account_poll_submissions",
    "account_polls",
    "account_sessions",
    "account_users",
    "account_verifications",
  ],
  identity: ["identity_backups"],
  operational: [
    "ceremony_approvals",
    "ceremony_messages",
    "ceremony_runs",
    "ceremony_stubs",
    "display_text_search",
    "display_texts",
    "moderation_actions",
    "moderation_reports",
    "poll_creation_txs",
    "schema_migrations",
  ],
} as const;
