-- Each stored definition's opening and closing times, copied out of the
-- record so discovery can list the polls open now, newest or closing soonest
-- first, without decoding every definition (P2-23 part 1a; src/listing.ts).
-- The times are the definition's own `opens_at` and `closes_at`
-- (docs/spec/election-definition.md), written by storeDefinition beside the
-- definition, so the table is public chain data like election_definitions:
-- rebuilt from the registry's events and write-once (T-53, T-68).
--
-- No foreign key: board-class tables carry none (the no-join test). A
-- definition stored before this migration gets its row from
-- fillElectionSchedules, which the API's migrate step runs after the SQL.

CREATE TABLE election_schedules (
  election_id bytea PRIMARY KEY CHECK (octet_length(election_id) = 32),
  -- u64 seconds, so numeric: bigint stops at 2^63 − 1, and a definition may
  -- carry any u64. The spec's well-formedness rule `timing` (opens_at <
  -- closes_at) holds for every definition storeDefinition accepts.
  opens_at numeric(20, 0) NOT NULL CHECK (opens_at >= 0),
  closes_at numeric(20, 0) NOT NULL CHECK (
    closes_at > opens_at AND closes_at <= 18446744073709551615
  )
);
CREATE INDEX election_schedules_closes_at ON election_schedules (closes_at, election_id);

CREATE FUNCTION election_schedules_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'election_schedules is write-once: % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER election_schedules_no_update_delete
  BEFORE UPDATE OR DELETE ON election_schedules
  FOR EACH ROW EXECUTE FUNCTION election_schedules_reject_change();

CREATE TRIGGER election_schedules_no_truncate
  BEFORE TRUNCATE ON election_schedules
  FOR EACH STATEMENT EXECUTE FUNCTION election_schedules_reject_change();

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION election_schedules_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON election_schedules FROM PUBLIC;
REVOKE ALL ON FUNCTION election_schedules_reject_change() FROM PUBLIC;
GRANT SELECT, INSERT ON election_schedules TO abolish_app;
