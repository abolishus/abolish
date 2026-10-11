-- Election definitions (record 0x0001, docs/spec/election-definition.md), as
-- the API serves them. Postgres is not authoritative: each definition is
-- registered on L2 and rebuilt from the registry's DefinitionRegistered event
-- (T-34, T-53), and every caller hashes what it is served and compares the
-- hash with the registry before using it. The registry is write-once per
-- election, so this table is too: a row is never changed or removed, and an
-- election has at most one definition, so whatever stores one must take it
-- from a finalized L2 block (a reorged registration can't be taken back
-- here). @abolishus/crypto decodes and checks each definition before it is
-- stored; this table only bounds the bytes.

CREATE TABLE election_definitions (
  election_id bytea PRIMARY KEY CHECK (octet_length(election_id) = 32),
  -- A complete definition: record type 0x0001 and then the rest of the record.
  definition bytea NOT NULL CHECK (
    octet_length(definition) BETWEEN 3 AND 1048576
    AND substring(definition FROM 1 FOR 2) = '\x0001'
  )
);

CREATE FUNCTION election_definitions_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'election_definitions is write-once: % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER election_definitions_no_update_delete
  BEFORE UPDATE OR DELETE ON election_definitions
  FOR EACH ROW EXECUTE FUNCTION election_definitions_reject_change();

CREATE TRIGGER election_definitions_no_truncate
  BEFORE TRUNCATE ON election_definitions
  FOR EACH STATEMENT EXECUTE FUNCTION election_definitions_reject_change();

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION election_definitions_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON election_definitions FROM PUBLIC;
REVOKE ALL ON FUNCTION election_definitions_reject_change() FROM PUBLIC;
GRANT SELECT, INSERT ON election_definitions TO abolish_app;
