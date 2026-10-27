import { bigint, boolean, integer, pgTable, text } from "drizzle-orm/pg-core";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0046_archive.sql and 0048_archive_contract_events.sql;
// a test checks the two agree. Operational: the worker's record of what it
// archived on Arweave, its manifest chain, the transactions it posted
// (P4-3 part 4b-1) and the contract-event evidence and runs it wrote
// (part 4b-3a; T-51).

export const archiveManifests = pgTable("archive_manifests", {
  sequence: bigint("sequence", { mode: "bigint" }).primaryKey(),
  cid: bytea("cid").notNull().unique(),
  manifest: bytea("manifest").notNull(),
});

export const archiveObjects = pgTable("archive_objects", {
  cid: bytea("cid").primaryKey(),
  electionId: bytea("election_id").notNull(),
  kind: text("kind").notNull(),
  first: bigint("first", { mode: "bigint" }).notNull(),
  size: bigint("size", { mode: "bigint" }).notNull(),
  listedIn: bigint("listed_in", { mode: "bigint" }).references(() => archiveManifests.sequence),
});

export const archiveTransactions = pgTable("archive_transactions", {
  transaction: bytea("transaction").primaryKey(),
  cid: bytea("cid").notNull(),
  postedAt: bigint("posted_at", { mode: "bigint" }).notNull(),
  confirmed: boolean("confirmed").notNull().default(false),
});

export const archiveEvidence = pgTable("archive_evidence", {
  cid: bytea("cid").primaryKey(),
  contract: bytea("contract").notNull(),
  segment: bigint("segment", { mode: "bigint" }).notNull(),
  l2Block: bigint("l2_block", { mode: "bigint" }).notNull(),
  count: bigint("count", { mode: "bigint" }).notNull(),
  record: bytea("record").notNull(),
  listedIn: bigint("listed_in", { mode: "bigint" }).references(() => archiveManifests.sequence),
});

export const archiveRuns = pgTable("archive_runs", {
  cid: bytea("cid").primaryKey(),
  contract: bytea("contract").notNull(),
  first: bigint("first", { mode: "bigint" }).notNull(),
  count: integer("count").notNull(),
  evidence: bytea("evidence")
    .notNull()
    .references(() => archiveEvidence.cid),
  run: bytea("run").notNull(),
  listedIn: bigint("listed_in", { mode: "bigint" }).references(() => archiveManifests.sequence),
});

export const archiveEventProgress = pgTable("archive_event_progress", {
  contract: bytea("contract").primaryKey(),
  segment: bigint("segment", { mode: "bigint" }).notNull(),
  count: bigint("count", { mode: "bigint" }).notNull(),
  accumulator: bytea("accumulator").notNull(),
  l2Block: bigint("l2_block", { mode: "bigint" }).notNull(),
  lastBlock: bigint("last_block", { mode: "bigint" }).notNull(),
  lastTimestamp: bigint("last_timestamp", { mode: "bigint" }).notNull(),
});
