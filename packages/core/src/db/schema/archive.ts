import { bigint, boolean, pgTable, text } from "drizzle-orm/pg-core";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0046_archive.sql; a test checks the two agree.
// Operational: the worker's record of what it archived on Arweave, its
// manifest chain and the transactions it posted (P4-3 part 4b-1; T-51).

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
