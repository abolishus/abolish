import { bigint, numeric, pgTable, primaryKey, smallint, text } from "drizzle-orm/pg-core";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0038_posting_ledger.sql and
// 0039_posting_in_flight_tending.sql; a test checks the two agree. The
// identity class: the posting relay's durable record, on the ballot side of
// the no-join rules (docs/spec/posting-relay.md, Caps and In flight; T-10,
// T-13, T-18).

export const postingSent = pgTable("posting_sent", {
  postingKey: bytea("posting_key").primaryKey(),
  electionId: bytea("election_id").notNull(),
  transaction: bytea("transaction").notNull(),
  layer: text("layer").notNull(),
  deliveryEnds: bigint("delivery_ends", { mode: "bigint" }).notNull(),
});

export const postingBallots = pgTable(
  "posting_ballots",
  {
    electionId: bytea("election_id").notNull(),
    tier: smallint("tier").notNull(),
    nullifier: bytea("nullifier").notNull(),
    ballotHash: bytea("ballot_hash").notNull(),
    deliveryEnds: bigint("delivery_ends", { mode: "bigint" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.electionId, t.tier, t.nullifier, t.ballotHash] })],
);

export const postingSpend = pgTable("posting_spend", {
  electionId: bytea("election_id").primaryKey(),
  spent: numeric("spent").notNull(),
  deliveryEnds: bigint("delivery_ends", { mode: "bigint" }).notNull(),
});

export const postingInFlight = pgTable("posting_in_flight", {
  postingKey: bytea("posting_key").primaryKey(),
  posting: bytea("posting").notNull(),
  ballot: bytea("ballot").notNull(),
  electionId: bytea("election_id").notNull(),
  intakeCutoff: bigint("intake_cutoff", { mode: "bigint" }).notNull(),
  contractCutoff: bigint("contract_cutoff", { mode: "bigint" }).notNull(),
  deliveryEnds: bigint("delivery_ends", { mode: "bigint" }).notNull(),
  firstSent: bigint("first_sent", { mode: "bigint" }).notNull(),
  nonce: bigint("nonce", { mode: "bigint" }).notNull(),
  gasLimit: bigint("gas_limit", { mode: "bigint" }).notNull(),
  maxFee: numeric("max_fee").notNull(),
  priorityFee: numeric("priority_fee").notNull(),
  cost: numeric("cost").notNull(),
  signed: bytea("signed").notNull(),
  transactions: bytea("transactions").notNull(),
  signedAt: bigint("signed_at", { mode: "bigint" }).notNull(),
  broadcastAt: bigint("broadcast_at", { mode: "bigint" }).notNull(),
  deposit: numeric("deposit").notNull(),
  landedIn: bytea("landed_in"),
  paid: numeric("paid"),
});
