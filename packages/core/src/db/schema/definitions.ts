import { bigint, integer, numeric, pgTable } from "drizzle-orm/pg-core";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0001_election_definitions.sql; a test checks the
// two agree. Write-once: the app role can only SELECT and INSERT (T-34).

export const electionDefinitions = pgTable("election_definitions", {
  electionId: bytea("election_id").primaryKey(),
  definition: bytea("definition").notNull(),
});

// Drizzle view of migrations/0007_election_registrations.sql: each stored
// definition's hash and the position of its registration on L2, in chain
// order (P2-18; T-53). Write-once like the definitions.
export const electionRegistrations = pgTable("election_registrations", {
  electionId: bytea("election_id").primaryKey(),
  definitionHash: bytea("definition_hash").notNull().unique(),
  l2Block: bigint("l2_block", { mode: "bigint" }).notNull(),
  logIndex: integer("log_index").notNull(),
});

// Drizzle view of migrations/0023_election_schedules.sql: each stored
// definition's `opens_at` and `closes_at`, for discovery's sorts (P2-23;
// T-68). Write-once like the definitions it is copied from.
export const electionSchedules = pgTable("election_schedules", {
  electionId: bytea("election_id").primaryKey(),
  opensAt: numeric("opens_at", { precision: 20, scale: 0, mode: "bigint" }).notNull(),
  closesAt: numeric("closes_at", { precision: 20, scale: 0, mode: "bigint" }).notNull(),
});
