import { bigint, jsonb, pgTable, primaryKey, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0012_account_polls.sql, 0013_poll_creation.sql,
// 0015_poll_anchor_check.sql, 0016_poll_roots.sql, 0017_poll_stubs.sql and
// 0018_ceremony_runs.sql; a test checks the two agree. `account_polls` is in the account class: whose poll it is, never
// who answered it (ADR 0032, rule 15; T-10). `poll_creation_txs` is
// operational: the creation key's public transactions, naming no account,
// poll or election. `ceremony_stubs` is operational: the coordinator's
// stubs, public once registered, naming no account or poll; so are
// `ceremony_runs`, `ceremony_messages` and `ceremony_approvals`, what it
// relays and collects for each stub's run.

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
  l1OriginTimestamp: bigint("l1_origin_timestamp", { mode: "bigint" }),
  anchorsCheckedBlock: bigint("anchors_checked_block", { mode: "bigint" }),
  abandonedIds: smallint("abandoned_ids").notNull().default(0),
  electorate: jsonb("electorate"),
  stubHash: bytea("stub_hash"),
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

export const ceremonyStubs = pgTable("ceremony_stubs", {
  stubHash: bytea("stub_hash").primaryKey(),
  electionId: bytea("election_id").notNull(),
  stub: bytea("stub").notNull(),
  displayText: bytea("display_text").notNull(),
  opensAt: bigint("opens_at", { mode: "bigint" }).notNull(),
  createdAt: at("created_at").notNull(),
});

export const ceremonyRuns = pgTable("ceremony_runs", {
  runId: bytea("run_id").primaryKey(),
  stubHash: bytea("stub_hash")
    .notNull()
    .unique()
    .references(() => ceremonyStubs.stubHash),
  round: smallint("round").notNull(),
  roundOpenedAt: at("round_opened_at").notNull(),
  transcript: bytea("transcript").notNull(),
  eligible: smallint("eligible").array().notNull(),
  transcriptHash: bytea("transcript_hash"),
  keySetHash: bytea("key_set_hash"),
  qualified: smallint("qualified").array(),
  outcome: text("outcome"),
  createdAt: at("created_at").notNull(),
});

export const ceremonyMessages = pgTable(
  "ceremony_messages",
  {
    runId: bytea("run_id")
      .notNull()
      .references(() => ceremonyRuns.runId),
    round: smallint("round").notNull(),
    seat: smallint("seat").notNull(),
    message: bytea("message").notNull(),
    receivedAt: at("received_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.round, t.seat] })],
);

export const ceremonyApprovals = pgTable(
  "ceremony_approvals",
  {
    runId: bytea("run_id")
      .notNull()
      .references(() => ceremonyRuns.runId),
    seat: smallint("seat").notNull(),
    signature: bytea("signature").notNull(),
    receivedAt: at("received_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seat] })],
);
