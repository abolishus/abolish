import {
  accountCredentials,
  accountPasskeys,
  accountSessions,
  accountUsers,
  accountVerifications,
} from "./accounts.ts";
import { boardEntries } from "./board.ts";
import { electionDefinitions } from "./definitions.ts";
import { identityBackups } from "./identity-backups.ts";
import { moderationActions, moderationReports } from "./moderation.ts";

export {
  accountCredentials,
  accountPasskeys,
  accountSessions,
  accountUsers,
  accountVerifications,
  boardEntries,
  electionDefinitions,
  identityBackups,
  moderationActions,
  moderationReports,
};

/**
 * Every table in the schema, by class. Board tables hold public bulletin-board
 * data and are rebuilt from chain + IPFS. Account tables hold accounts
 * (better-auth): who someone is to the app, never how they voted. Operational
 * tables (drafts, moderation, identity backups, caches) hold nothing a result depends on. A test
 * fails on any table not listed here, on any foreign key that leaves its
 * class's tables (board or account), and on a column of either class that
 * could name the other (.claude/skills/migrations; T-10, T-13).
 */
export const TABLE_CLASSES = {
  board: ["board_entries", "election_definitions"],
  account: [
    "account_credentials",
    "account_passkeys",
    "account_sessions",
    "account_users",
    "account_verifications",
  ],
  operational: [
    "identity_backups",
    "moderation_actions",
    "moderation_reports",
    "schema_migrations",
  ],
} as const;
