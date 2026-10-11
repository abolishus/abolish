import { boardEntries } from "./board.ts";
import { electionDefinitions } from "./definitions.ts";

export { boardEntries, electionDefinitions };

/**
 * Every table in the schema, by class. Board tables hold public bulletin-board
 * data and are rebuilt from chain + IPFS; operational tables (accounts, drafts,
 * moderation, caches; none yet) hold nothing a result depends on. A test fails
 * on any table not listed here, and on any foreign key or account-like column
 * that could link the two classes (.claude/skills/migrations; T-10, T-13).
 */
export const TABLE_CLASSES = {
  board: ["board_entries", "election_definitions"],
  operational: ["schema_migrations"],
} as const;
