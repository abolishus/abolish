-- Every DefinitionRegistered event on L2: the election, the definition hash
-- the event carries and its position (block number, then log index in the
-- block). Short codes (docs/design/sharing.md, Short links) go to the
-- earliest registered poll with a prefix, so resolving one needs every
-- registered hash in registration order, read by prefix through the unique
-- index on definition_hash (P2-18). Every column is public chain data: the
-- table is rebuilt from the registry's events (T-49, T-53).
--
-- A registration is recorded whether or not its definition is stored here.
-- election_definitions holds only definitions @abolishus/crypto accepts, and
-- the registry doesn't check every well-formedness rule (verifier 2.1), so a
-- code computed from stored definitions alone could differ from the one a
-- mirror computes from the events: a poll after a skipped one would take a
-- code that, elsewhere, the skipped one owns.
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

-- A registration is recorded only after every one already recorded, so the
-- table grows in chain order: a code, once it resolves, keeps resolving to
-- the same poll however many polls arrive later (T-53). The lock serializes
-- inserts, and under READ COMMITTED the check after it sees every row
-- committed before the lock was granted; a snapshot taken earlier (REPEATABLE
-- READ, SERIALIZABLE) could miss one, so those are refused.
CREATE FUNCTION election_registrations_check_append() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'election_registrations: insert under READ COMMITTED only'
      USING ERRCODE = 'invalid_transaction_state';
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
