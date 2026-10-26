-- The worker's record of what it archived on Arweave (docs/spec/archive.md,
-- Archived objects, Archive manifest, Who writes them, Locator;
-- [[0005-permanent-archive]]; P4-3 part 4b-1; src/archiving.ts).
--
-- archive_objects: each segment object and entry-hash list a taken
-- checkpoint names, by its CID, with the board run it is the bytes of
-- (entries `first` to `size − 1`), so its bytes are read again from the board
-- rather than kept twice, and the manifest that first listed it.
-- archive_manifests: the deployment's manifest chain, each manifest's
-- encoding at its sequence. archive_transactions: every Arweave transaction
-- posted, each carrying one object's or manifest's CAR, and whether it has
-- confirmed at the worker's depth.
--
-- What only grows stays grown: a manifest is never changed, an object is
-- listed once, and a transaction once confirmed is never unconfirmed, which
-- the locator's never falling rests on (src/archive-chain.ts). The triggers
-- hold that against every role, the owner included (T-51, T-49).
--
-- Operational: nothing a result depends on. Every object is the board's and
-- every manifest is on Arweave under the anchor's locator, so a wipe loses
-- the worker's place in the chain, never a result; the archive's readers
-- never read these tables (T-53). After a wipe the run refuses to start a
-- new chain while the anchor names one, since a new manifest 0 would read
-- as an overwritten locator (T-69); resuming from the anchor's chain is P4-3
-- part 4b-2's.

CREATE TABLE archive_manifests (
  sequence bigint PRIMARY KEY CHECK (sequence >= 0),
  -- Every manifest is one raw block (docs/spec/archive.md, Archive manifest),
  -- so its CID is fixed by its bytes, and no row can post other bytes under it.
  cid bytea NOT NULL UNIQUE CHECK (cid = '\x01551220'::bytea || sha256(manifest)),
  manifest bytea NOT NULL CHECK (octet_length(manifest) BETWEEN 1 AND 1048576)
);

CREATE TABLE archive_objects (
  cid bytea PRIMARY KEY CHECK (octet_length(cid) = 36),
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  kind text NOT NULL CHECK (kind IN ('segment', 'hashes')),
  first bigint NOT NULL CHECK (first >= 0),
  size bigint NOT NULL CHECK (size > first),
  listed_in bigint REFERENCES archive_manifests (sequence)
);
CREATE INDEX archive_objects_unlisted ON archive_objects (cid) WHERE listed_in IS NULL;
CREATE INDEX archive_objects_run ON archive_objects (election_id, size);

CREATE TABLE archive_transactions (
  transaction bytea PRIMARY KEY CHECK (octet_length(transaction) = 32),
  -- The object's or manifest's CID whose CAR is its data.
  cid bytea NOT NULL CHECK (octet_length(cid) = 36),
  -- When it was posted, in seconds since the epoch, by the worker's clock.
  posted_at bigint NOT NULL CHECK (posted_at >= 0),
  confirmed boolean NOT NULL DEFAULT false
);
CREATE INDEX archive_transactions_cid ON archive_transactions (cid);

CREATE FUNCTION archive_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% only grows: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- An object's run and CID never change, and it is listed once.
CREATE FUNCTION archive_objects_check_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.listed_in IS NOT NULL OR NEW.listed_in IS NULL
      OR (NEW.cid, NEW.election_id, NEW.kind, NEW.first, NEW.size)
        IS DISTINCT FROM (OLD.cid, OLD.election_id, OLD.kind, OLD.first, OLD.size) THEN
    RAISE EXCEPTION 'archive_objects: only an unlisted object is listed, once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

-- A transaction only ever goes from unconfirmed to confirmed.
CREATE FUNCTION archive_transactions_check_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.confirmed OR NOT NEW.confirmed
      OR (NEW.transaction, NEW.cid, NEW.posted_at)
        IS DISTINCT FROM (OLD.transaction, OLD.cid, OLD.posted_at) THEN
    RAISE EXCEPTION 'archive_transactions: only an unconfirmed transaction is confirmed, once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER archive_manifests_no_update_delete
  BEFORE UPDATE OR DELETE ON archive_manifests
  FOR EACH ROW EXECUTE FUNCTION archive_reject_change();
CREATE TRIGGER archive_manifests_no_truncate
  BEFORE TRUNCATE ON archive_manifests
  FOR EACH STATEMENT EXECUTE FUNCTION archive_reject_change();
CREATE TRIGGER archive_objects_no_delete
  BEFORE DELETE ON archive_objects
  FOR EACH ROW EXECUTE FUNCTION archive_reject_change();
CREATE TRIGGER archive_objects_no_truncate
  BEFORE TRUNCATE ON archive_objects
  FOR EACH STATEMENT EXECUTE FUNCTION archive_reject_change();
CREATE TRIGGER archive_objects_listed_once
  BEFORE UPDATE ON archive_objects
  FOR EACH ROW EXECUTE FUNCTION archive_objects_check_update();
CREATE TRIGGER archive_transactions_no_delete
  BEFORE DELETE ON archive_transactions
  FOR EACH ROW EXECUTE FUNCTION archive_reject_change();
CREATE TRIGGER archive_transactions_no_truncate
  BEFORE TRUNCATE ON archive_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION archive_reject_change();
CREATE TRIGGER archive_transactions_confirmed_once
  BEFORE UPDATE ON archive_transactions
  FOR EACH ROW EXECUTE FUNCTION archive_transactions_check_update();

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION archive_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION archive_objects_check_update() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION archive_transactions_check_update() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON archive_manifests, archive_objects, archive_transactions FROM PUBLIC;
REVOKE ALL ON FUNCTION archive_reject_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION archive_objects_check_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION archive_transactions_check_update() FROM PUBLIC;
GRANT SELECT, INSERT ON archive_manifests TO abolish_app;
GRANT SELECT, INSERT, UPDATE (listed_in) ON archive_objects TO abolish_app;
GRANT SELECT, INSERT, UPDATE (confirmed) ON archive_transactions TO abolish_app;
