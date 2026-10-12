-- Voting-identity recovery backups (ADR 0017, option A; docs/spec/identity-backup.md;
-- T-20, T-10, T-11, T-52, T-66). One row per backup passkey: the sealed
-- envelope (record 0x000a, 63 bytes), kept under `id = H(DS(id-tag, locator))`.
-- The client presents the locator; the server recomputes `id` and never stores
-- the locator, so a copy of the table (a leak, a seizure) can't read, replace
-- or delete a row.
--
-- No account column, no address, no request time: the ballot path carries no
-- account session (apps/api refuses one), and nothing here can name a person
-- (T-10). The only time kept is `written_month`, the UTC month of the last
-- write by the database clock, which the expiry rule needs: a month says
-- little about when a voter was active, so it can't be matched against a
-- proxy's request times (T-11). Reads don't touch it: the server keeps no
-- access time. A backup not written for 24 whole months is deleted
-- (pruneIdentityBackups); the ballot client rewrites its envelope to keep it.
-- That bounds what anonymous writes leave behind (T-52).
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
  written_month date NOT NULL CHECK (written_month = date_trunc('month', written_month)::date)
);

CREATE INDEX identity_backups_expiry ON identity_backups (written_month);

REVOKE ALL ON identity_backups FROM PUBLIC;
-- The holder of a locator can replace or delete its envelope, and expiry
-- deletes rows; no TRUNCATE.
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_backups TO abolish_app;
