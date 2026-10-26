-- The board path for destruction statements (docs/spec/tally.md,
-- Destruction, Boarding; P2-13 part 5c-3). Each destruction statement the
-- operator boards is keyed by the registered seat whose signature attributes
-- it, written by appendEntry in the transaction that appends the entry,
-- under the board lock, so the operator boards at most one statement per
-- seat however many copies race in (T-17, T-52): a second, in other bytes,
-- is answered with the first rather than boarded as a duplicate against the
-- operator (docs/spec/verifier.md, 8.5).
--
-- Written only for a statement crypto's Boarding judge passed, so every
-- row's entry is an attributed statement naming the election. Every column
-- is public board data, derived from board_entries alone and rebuilt with it
-- (T-23, T-53); the verifier's 8.5 reads every record the board holds, never
-- this table.

-- The board's own payload check takes destruction statements (0x000f) too,
-- which board-entry versions 4 to 7 allow (docs/spec/board.md, Allowed
-- payloads), now that they have a writer; the entry's encoder refuses any
-- type its version doesn't allow either way (T-17). Every stored payload
-- passes the old check, so the new one, its superset, validates; the scan
-- holds the table's lock for moments at this stage, as 0027's did.
ALTER TABLE board_entries DROP CONSTRAINT board_entries_payload_check;
ALTER TABLE board_entries ADD CONSTRAINT board_entries_payload_check CHECK (
  octet_length(payload) BETWEEN 3 AND 1048576
  AND substring(payload FROM 1 FOR 2) IN ('\x0002', '\x0003', '\x0005', '\x0006', '\x0008', '\x000c', '\x000f')
);

CREATE TABLE board_destruction_statements (
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  -- The seat the statement's signature attributes it to.
  seat smallint NOT NULL CHECK (seat BETWEEN 1 AND 255),
  idx bigint NOT NULL CHECK (idx >= 0),
  PRIMARY KEY (election_id, seat),
  UNIQUE (election_id, idx)
);

CREATE FUNCTION board_destruction_statements_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER board_destruction_statements_no_update_delete
  BEFORE UPDATE OR DELETE ON board_destruction_statements
  FOR EACH ROW EXECUTE FUNCTION board_destruction_statements_reject_change();

CREATE TRIGGER board_destruction_statements_no_truncate
  BEFORE TRUNCATE ON board_destruction_statements
  FOR EACH STATEMENT EXECUTE FUNCTION board_destruction_statements_reject_change();

-- What holds without hashing: a row names an entry on the board that
-- carries a destruction statement.
CREATE FUNCTION board_destruction_statements_check_append() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM board_entries
      WHERE election_id = NEW.election_id AND idx = NEW.idx
        AND substring(payload FROM 1 FOR 2) = '\x000f') THEN
    RAISE EXCEPTION 'board_destruction_statements: entry % is not a destruction statement on the board', NEW.idx
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER board_destruction_statements_append_after_entry
  BEFORE INSERT ON board_destruction_statements
  FOR EACH ROW EXECUTE FUNCTION board_destruction_statements_check_append();

-- As for board_entries: a fixed search_path with pg_temp last, so a temporary
-- table can't stand in for the board.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION board_destruction_statements_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION board_destruction_statements_check_append() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON board_destruction_statements FROM PUBLIC;
REVOKE ALL ON FUNCTION board_destruction_statements_reject_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION board_destruction_statements_check_append() FROM PUBLIC;
GRANT SELECT, INSERT ON board_destruction_statements TO abolish_app;
