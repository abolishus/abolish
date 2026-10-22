import { bigint, numeric, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0029_account_tokens.sql; a test checks the two
// agree. `account_tokens` is in the account class: an account's one Tier 0
// token per deployment, with no time. `tier0_token_issuances` is
// operational: tokens issued per key and group, with no account
// ([[tier0-token]]; T-10, T-74).

export const accountTokens = pgTable(
  "account_tokens",
  {
    userId: text("user_id")
      .notNull()
      .references(() => accountUsers.id, { onDelete: "cascade" }),
    chainId: numeric("chain_id", { precision: 20, scale: 0, mode: "bigint" }).notNull(),
    groupRegistry: bytea("group_registry").notNull(),
    region: bigint("region", { mode: "number" }).notNull(),
    keyId: bytea("key_id"),
    keyPeriod: bigint("key_period", { mode: "number" }),
    blindedElement: bytea("blinded_element").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.chainId, t.groupRegistry] })],
);

export const tier0TokenIssuances = pgTable(
  "tier0_token_issuances",
  {
    keyId: bytea("key_id").notNull(),
    info: bytea("info").notNull(),
    issued: bigint("issued", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.info] })],
);
