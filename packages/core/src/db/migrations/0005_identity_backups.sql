-- Voting-identity recovery backups (ADR 0017, option A; docs/spec/identity-backup.md;
-- T-20, T-10, T-11, T-52, T-66). One row per backup passkey: the sealed
-- envelope (record 0x000a, 63 bytes), kept under `id = H(DS(id-tag, locator))`.
-- The client presents the locator; the server recomputes `id` and never stores
-- the locator, so a copy of the table (a leak, a seizure) can't read, replace
-- or delete a row.
--
-- No account column, no address, no request time: the ballot path carries no
-- account session (apps/api refuses one), and nothing here can name a person
-- (T-10). The only time the table stores is `written_month`, the UTC month
-- of the last write by the database clock, which the expiry rule needs. That
-- narrows, but doesn't close, timing (T-11): system columns such as `xmin`
-- still order writes, and Postgres's own logs could date them, so the
-- deployment must keep statement logging and commit timestamps off (P2-11).
-- What closes it is the ADR's argument: joining an id to an address gives
-- nothing usable without a PRF evaluation. Reads don't touch the row: no
-- access time. A backup not written for 24 whole months is deleted
-- (pruneIdentityBackups), which bounds what anonymous writes leave behind
-- (T-52). Rewriting needs a backup-passkey ceremony, since the
-- client keeps no locator or key (docs/spec/identity-backup.md, Keys), so the
-- ballot client must re-seal during every such ceremony and ask for one well
-- before 24 months pass (P2-8).
--
-- Operational data: a wipe loses every backup and changes no result (T-66).
-- Never on the board, the chain, IPFS or the archive.

CREATE TABLE identity_backups (
  id bytea PRIMARY KEY CHECK (octet_length(id) = 32),
  -- A version-1 envelope: the record header (type 0x000a, version 1), a
  -- 12-byte nonce and 48 sealed bytes. The API decodes it strictly first.
  envelope bytea NOT NULL CHECK (
    octet_length(envelope) = 63 AND substring(envelope FROM 1 FOR 3) = '\x000a01'::bytea
  ),
  written_month date NOT NULL CHECK (extract(day FROM written_month) = 1)
);

CREATE INDEX identity_backups_expiry ON identity_backups (written_month);

REVOKE ALL ON identity_backups FROM PUBLIC;
-- The holder of a locator can replace or delete its envelope, and expiry
-- deletes rows; no TRUNCATE.
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_backups TO abolish_app;
