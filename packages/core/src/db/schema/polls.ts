import { bigint, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0012_account_polls.sql and
// 0013_poll_creation.sql; a test checks the two agree. `account_polls` is in
// the account class: whose poll it is, never who answered it (ADR 0032, rule
// 15; T-10). `poll_creation_txs` is operational: the creation key's public
// transactions, naming no account, poll or election.

const at = (name: string) => timestamp(name, { withTimezone: true });

export const accountPolls = pgTable("account_polls", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  state: text("state").notNull(),
  draft: jsonb("draft").notNull(),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
  submittedAt: at("submitted_at"),
  creatorAddress: bytea("creator_address"),
  createTxHash: bytea("create_tx_hash"),
  electionId: bytea("election_id"),
  createdBlock: bigint("created_block", { mode: "bigint" }),
  failure: text("failure"),
});

export const pollCreationTxs = pgTable(
  "poll_creation_txs",
  {
    creatorAddress: bytea("creator_address").notNull(),
    nonce: bigint("nonce", { mode: "bigint" }).notNull(),
    tx: bytea("tx").notNull(),
    txHash: bytea("tx_hash").notNull(),
    sentAt: at("sent_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.creatorAddress, t.nonce] })],
);
