-- The board path for tally openings (docs/spec/tally.md, Opening record,
-- Boarding; P2-13 part 5b-2b-3b-2b). Each tally opening the operator boards
-- is keyed by the cell it opens and the registered seat whose signature
-- attributes it, written by appendEntry in the transaction that appends the
-- entry, under the board lock, so the operator boards at most one opening
-- per cell and seat however many copies race in (T-17, T-52): a second, in
-- other bytes, is refused rather than boarded as `tally-second` or
-- `tally-repeat` against the operator (docs/spec/verifier.md, 7.4).
--
-- Written only for an opening crypto's Boarding judge passed over the
-- anchored counted set, so every row's entry is a passing, attributed
-- opening. Every column is public board data, derived from board_entries
-- alone and rebuilt with it (T-23, T-53); the verifier's 7.4 reads every
-- record the board holds, never this table.

CREATE TABLE board_tally_openings (
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  -- The cell, by its position in the registered partition (u8).
  cell smallint NOT NULL CHECK (cell BETWEEN 0 AND 255),
  -- The seat the opening's signature attributes it to.
  seat smallint NOT NULL CHECK (seat BETWEEN 1 AND 255),
  idx bigint NOT NULL CHECK (idx >= 0),
  PRIMARY KEY (election_id, cell, seat),
  UNIQUE (election_id, idx)
);

CREATE FUNCTION board_tally_openings_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER board_tally_openings_no_update_delete
  BEFORE UPDATE OR DELETE ON board_tally_openings
  FOR EACH ROW EXECUTE FUNCTION board_tally_openings_reject_change();

CREATE TRIGGER board_tally_openings_no_truncate
  BEFORE TRUNCATE ON board_tally_openings
  FOR EACH STATEMENT EXECUTE FUNCTION board_tally_openings_reject_change();

-- What holds without hashing: a row names an entry on the board that
-- carries a tally opening.
CREATE FUNCTION board_tally_openings_check_append() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM board_entries
      WHERE election_id = NEW.election_id AND idx = NEW.idx
        AND substring(payload FROM 1 FOR 2) = '\x0006') THEN
    RAISE EXCEPTION 'board_tally_openings: entry % is not a tally opening on the board', NEW.idx
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER board_tally_openings_append_after_entry
  BEFORE INSERT ON board_tally_openings
  FOR EACH ROW EXECUTE FUNCTION board_tally_openings_check_append();

-- As for board_entries: a fixed search_path with pg_temp last, so a temporary
-- table can't stand in for the board.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION board_tally_openings_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION board_tally_openings_check_append() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON board_tally_openings FROM PUBLIC;
REVOKE ALL ON FUNCTION board_tally_openings_reject_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION board_tally_openings_check_append() FROM PUBLIC;
GRANT SELECT, INSERT ON board_tally_openings TO abolish_app;
