-- Where each stored definition was registered: its definition hash and the
-- position of its DefinitionRegistered event on L2 (block number, then log
-- index in the block). Short codes (docs/design/sharing.md, Short links) go
-- to the earliest registered poll with a prefix, so resolving one needs the
-- hashes in registration order, read by prefix through the unique index on
-- definition_hash (P2-18). Every column is public chain data: the table is
-- rebuilt from the registry's events with election_definitions (T-49, T-53).
--
-- A table of its own, not columns on election_definitions: that table is
-- write-once, so its existing rows could never be given a position, and a
-- definition stored before this migration simply has no code until the
-- indexer records its registration.
--
-- @abolishus/core computes definition_hash from the stored definition, since
-- the database can't hash; what holds here without hashing is below.

CREATE TABLE election_registrations (
  election_id bytea PRIMARY KEY CHECK (octet_length(election_id) = 32),
  definition_hash bytea NOT NULL UNIQUE CHECK (octet_length(definition_hash) = 32),
  l2_block bigint NOT NULL CHECK (l2_block >= 0),
  log_index integer NOT NULL CHECK (log_index >= 0),
  UNIQUE (l2_block, log_index)
);

CREATE FUNCTION election_registrations_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'election_registrations is write-once: % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER election_registrations_no_update_delete
  BEFORE UPDATE OR DELETE ON election_registrations
  FOR EACH ROW EXECUTE FUNCTION election_registrations_reject_change();

CREATE TRIGGER election_registrations_no_truncate
  BEFORE TRUNCATE ON election_registrations
  FOR EACH STATEMENT EXECUTE FUNCTION election_registrations_reject_change();

-- A registration is recorded only for a stored definition (no foreign key
-- may touch a board table; T-10), and only after every one already recorded,
-- so the table grows in chain order: a code, once it resolves, keeps
-- resolving to the same poll however many polls arrive later (T-53). The
-- lock serializes inserts, so two at once can't both pass the check.
CREATE FUNCTION election_registrations_check_append() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM election_definitions WHERE election_id = NEW.election_id) THEN
    RAISE EXCEPTION 'election_registrations: no stored definition'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA || '.election_registrations'));
  IF EXISTS (SELECT 1 FROM election_registrations
      WHERE (l2_block, log_index) >= (NEW.l2_block, NEW.log_index)) THEN
    RAISE EXCEPTION 'election_registrations: recorded out of chain order'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER election_registrations_append
  BEFORE INSERT ON election_registrations
  FOR EACH ROW EXECUTE FUNCTION election_registrations_check_append();

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION election_registrations_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION election_registrations_check_append() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON election_registrations FROM PUBLIC;
REVOKE ALL ON FUNCTION election_registrations_reject_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION election_registrations_check_append() FROM PUBLIC;
GRANT SELECT, INSERT ON election_registrations TO abolish_app;
