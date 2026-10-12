-- The board tree's perfect subtrees (docs/spec/board.md, Board tree; T-52):
-- for each election, the hash of every complete block of 2^level entries from
-- entry idx * 2^level. appendEntry writes the ones each entry completes, in
-- its own transaction, from hashes @abolishus/crypto computes. Heads and
-- proofs then read O(log n) rows rather than every entry hash. A subtree never
-- changes once its entries exist, so the table is append-only like the board.
-- Derived from board_entries alone: rebuilt with it (T-23, T-53), and checked
-- against it by auditBoard, since the database can't hash.

-- No write path boards anything before this migration: ballots.submit refuses
-- every ballot (P2-3 part 1), and appendEntry has no other caller. A board
-- written by hand has no subtrees, and appending to it would fail; Postgres
-- isn't authoritative, so the fix is to wipe it and rebuild from chain + IPFS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM board_entries) THEN
    RAISE EXCEPTION 'board_subtrees: board_entries already has rows; wipe and rebuild the board'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

CREATE TABLE board_subtrees (
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  -- Board indexes are below 2^63 (a bigint), so no subtree is taller.
  level smallint NOT NULL CHECK (level BETWEEN 0 AND 62),
  idx bigint NOT NULL CHECK (idx >= 0),
  hash bytea NOT NULL CHECK (octet_length(hash) = 32),
  PRIMARY KEY (election_id, level, idx)
);

CREATE FUNCTION board_subtrees_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'board_subtrees is append-only: % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER board_subtrees_no_update_delete
  BEFORE UPDATE OR DELETE ON board_subtrees
  FOR EACH ROW EXECUTE FUNCTION board_subtrees_reject_change();

CREATE TRIGGER board_subtrees_no_truncate
  BEFORE TRUNCATE ON board_subtrees
  FOR EACH STATEMENT EXECUTE FUNCTION board_subtrees_reject_change();

-- What holds without hashing: a leaf's entry is on the board, and a parent's
-- two children are stored, so no subtree can be written ahead of its entries.
CREATE FUNCTION board_subtrees_check_append() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.level = 0 THEN
    IF NOT EXISTS (SELECT 1 FROM board_entries
        WHERE election_id = NEW.election_id AND idx = NEW.idx) THEN
      RAISE EXCEPTION 'board_subtrees: entry % is not on the board', NEW.idx
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (SELECT count(*) FROM board_subtrees
      WHERE election_id = NEW.election_id AND level = NEW.level - 1
        AND idx IN (2 * NEW.idx, 2 * NEW.idx + 1)) <> 2 THEN
    RAISE EXCEPTION 'board_subtrees: subtree (%, %) is missing a child', NEW.level, NEW.idx
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER board_subtrees_append_after_children
  BEFORE INSERT ON board_subtrees
  FOR EACH ROW EXECUTE FUNCTION board_subtrees_check_append();

-- As for board_entries: a fixed search_path with pg_temp last, so a temporary
-- table can't stand in for the board or a child.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION board_subtrees_check_append() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION board_subtrees_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON board_subtrees FROM PUBLIC;
REVOKE ALL ON FUNCTION board_subtrees_reject_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION board_subtrees_check_append() FROM PUBLIC;
GRANT SELECT, INSERT ON board_subtrees TO abolish_app;
