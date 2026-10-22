-- Tier 0 tokens: the issuer's records ([[tier0-token]], Issuance and Keys;
-- [[0039-tier0-token-issuance]]; P2-30 part 3a; src/tier0-tokens.ts).
--
-- `account_tokens` is the account's one token per deployment: the region it
-- took it for, the key it was issued under and the blinded element `B` it
-- sent. `B` is `blind · HashToGroup(input)` with `blind` uniform, so it is
-- perfectly hiding and joins the account to no commitment (T-10); it is kept
-- for as long as the row, since re-issuance after the key stops redeeming
-- checks a shown `blind` against it. `key_id` and its public period are
-- cleared together once the period after the key's own has ended (the dead
-- mark), so a dead record keeps no period either. No column keeps a time:
-- the time of issuance is what a commitment's public join time would be
-- matched against (T-11, T-13). The primary key is the atomic
-- insert-if-absent of Issuance, step 3: one row per account and deployment
-- (its `chain_id` and `group_registry`), so two concurrent requests with
-- different `B` can't both take a token (T-01), and a redeployed registry
-- starts afresh.
--
-- `tier0_token_issuances` counts the tokens issued per key and group `info`,
-- with no account, for the compromise check of [[tier0-token]], Security
-- notes: redemptions per key and group beyond these counts mean a stolen key
-- (T-74).
--
-- T-10: `account_tokens` is in the account class and nothing on the ballot
-- path reads it; deleting an account deletes its row. The counts are
-- operational. Operational both: a wipe loses who took a token, never a
-- result.

CREATE TABLE account_tokens (
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  chain_id numeric(20, 0) NOT NULL CHECK (chain_id BETWEEN 0 AND 18446744073709551615),
  group_registry bytea NOT NULL CHECK (octet_length(group_registry) = 20),
  region bigint NOT NULL CHECK (region BETWEEN 0 AND 4294967295),
  key_id bytea CHECK (octet_length(key_id) = 32),
  key_period bigint CHECK (key_period BETWEEN 0 AND 4294967295),
  blinded_element bytea NOT NULL CHECK (octet_length(blinded_element) = 32),
  PRIMARY KEY (user_id, chain_id, group_registry),
  CHECK ((key_id IS NULL) = (key_period IS NULL))
);
CREATE INDEX account_tokens_key_period ON account_tokens (key_period);

CREATE TABLE tier0_token_issuances (
  key_id bytea NOT NULL CHECK (octet_length(key_id) = 32),
  info bytea NOT NULL CHECK (octet_length(info) = 32),
  issued bigint NOT NULL CHECK (issued > 0),
  PRIMARY KEY (key_id, info)
);

REVOKE ALL ON account_tokens, tier0_token_issuances FROM PUBLIC;
-- UPDATE of the key and `B` only, for the dead mark and re-issuance's
-- replacement: a record's account, deployment and region never change.
-- DELETE for a record whose key can't evaluate for its group (Issuance,
-- step 4).
GRANT SELECT, INSERT, DELETE ON account_tokens TO abolish_app;
GRANT UPDATE (key_id, key_period, blinded_element) ON account_tokens TO abolish_app;
-- Counts only ever grow.
GRANT SELECT, INSERT, UPDATE ON tier0_token_issuances TO abolish_app;
