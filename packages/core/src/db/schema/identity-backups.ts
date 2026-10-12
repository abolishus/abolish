import { date, pgTable } from "drizzle-orm/pg-core";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0005_identity_backups.sql; a test checks the two
// agree. Operational: no account column, keyed by a hash of the locator
// (ADR 0017; T-10, T-20).

export const identityBackups = pgTable("identity_backups", {
  id: bytea("id").primaryKey(),
  envelope: bytea("envelope").notNull(),
  writtenMonth: date("written_month", { mode: "string" }).notNull(),
});
