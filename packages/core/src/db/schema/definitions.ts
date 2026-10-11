import { pgTable } from "drizzle-orm/pg-core";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0001_election_definitions.sql; a test checks the
// two agree. Write-once: the app role can only SELECT and INSERT (T-34).

export const electionDefinitions = pgTable("election_definitions", {
  electionId: bytea("election_id").primaryKey(),
  definition: bytea("definition").notNull(),
  definitionHash: bytea("definition_hash").notNull(),
});
