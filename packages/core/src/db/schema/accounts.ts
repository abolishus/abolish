import { bigint, boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Drizzle view of migrations/0004_accounts.sql; a test checks the two agree.
// The property names are better-auth's field names, which its Drizzle adapter
// maps to these columns (src/accounts.ts).

const at = (name: string) => timestamp(name, { withTimezone: true });

export const accountUsers = pgTable("account_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull(),
  name: text("name").notNull(),
  image: text("image"),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const accountSessions = pgTable("account_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  expiresAt: at("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const accountPasskeys = pgTable("account_passkeys", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  credentialID: text("credential_id").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  aaguid: text("aaguid"),
  createdAt: at("created_at"),
});

/** Passwords and OAuth tokens: never written (the migration refuses every row). */
export const accountCredentials = pgTable("account_credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: at("access_token_expires_at"),
  refreshTokenExpiresAt: at("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const accountVerifications = pgTable("account_verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: at("expires_at").notNull(),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});
