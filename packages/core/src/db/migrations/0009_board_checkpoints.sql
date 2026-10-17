-- The checkpoints the anchoring job has taken of each board
-- (docs/spec/board.md, Segments and checkpoints; P4-1): each one is the
-- board's state after an ended anchoring period, computed by
-- @abolishus/crypto's copyCheckpoints from the board's own bytes under the
-- board lock, and the bytes the job then anchors on L1. Every column is
-- public board data, rebuilt with the board from chain + IPFS (T-23, T-53).
--
-- Taking a checkpoint fences its segment: no entry is boarded afterwards with
-- a segment at or below it. An entry labelled with a period whose checkpoint
-- was already taken would make that checkpoint, once anchored, invalid for
-- the board (checkpoint-boundary), and the election would fail (T-24). The
-- fence is enforced here as well as in appendEntry, for any writer.

CREATE TABLE board_checkpoints (
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  segment bigint NOT NULL CHECK (segment BETWEEN 0 AND 4294967295),
  size bigint NOT NULL CHECK (size >= 1),
  -- encode(checkpoint), checkpoint version 2: 180 bytes.
  checkpoint bytea NOT NULL CHECK (octet_length(checkpoint) = 180),
  PRIMARY KEY (election_id, segment)
);

CREATE FUNCTION board_checkpoints_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'board_checkpoints is append-only: % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER board_checkpoints_no_update_delete
  BEFORE UPDATE OR DELETE ON board_checkpoints
  FOR EACH ROW EXECUTE FUNCTION board_checkpoints_reject_change();

CREATE TRIGGER board_checkpoints_no_truncate
  BEFORE TRUNCATE ON board_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION board_checkpoints_reject_change();

-- What holds without hashing (the root and CIDs are crypto's): segments only
-- increase; the encoding's election, segment and size are the row's; the
-- checkpoint ends at a segment boundary of the stored board; and its head is
-- the link of its last entry.
CREATE FUNCTION board_checkpoints_check_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_entry board_entries%ROWTYPE;
BEGIN
  -- The board lock appendEntry and takeCheckpoints take (board.ts,
  -- BOARD_LOCK_CLASS), taken here too, so a writer that skips it is still
  -- serialised with them: otherwise a checkpoint and an entry behind it,
  -- each inserted while the other is uncommitted, would both pass their
  -- checks. Each statement after it reads committed rows afresh.
  PERFORM pg_advisory_xact_lock(723533, ('x' || encode(substring(NEW.election_id FROM 1 FOR 4), 'hex'))::bit(32)::int);
  IF EXISTS (SELECT 1 FROM board_checkpoints
      WHERE election_id = NEW.election_id AND segment >= NEW.segment) THEN
    RAISE EXCEPTION 'board_checkpoints: segment % is not after every taken checkpoint', NEW.segment
      USING ERRCODE = 'check_violation';
  END IF;
  IF substring(NEW.checkpoint FROM 1 FOR 32) <> NEW.election_id
      OR substring(NEW.checkpoint FROM 33 FOR 4) <> decode(lpad(to_hex(NEW.segment), 8, '0'), 'hex')
      OR substring(NEW.checkpoint FROM 37 FOR 8) <> decode(lpad(to_hex(NEW.size), 16, '0'), 'hex') THEN
    RAISE EXCEPTION 'board_checkpoints: the encoding does not carry the row''s election, segment and size'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO last_entry FROM board_entries
    WHERE election_id = NEW.election_id AND idx = NEW.size - 1;
  IF NOT FOUND OR last_entry.segment > NEW.segment
      OR EXISTS (SELECT 1 FROM board_entries
        WHERE election_id = NEW.election_id AND idx = NEW.size AND segment <= NEW.segment) THEN
    RAISE EXCEPTION 'board_checkpoints: size % does not end segment % of the board', NEW.size, NEW.segment
      USING ERRCODE = 'check_violation';
  END IF;
  IF substring(NEW.checkpoint FROM 45 FOR 32) <> last_entry.link THEN
    RAISE EXCEPTION 'board_checkpoints: head is not the link of entry %', NEW.size - 1
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER board_checkpoints_append_in_order
  BEFORE INSERT ON board_checkpoints
  FOR EACH ROW EXECUTE FUNCTION board_checkpoints_check_append();

-- The fence on the board itself.
CREATE FUNCTION board_entries_check_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The board lock appendEntry and takeCheckpoints take (board.ts,
  -- BOARD_LOCK_CLASS), taken here too, so a writer that skips it is still
  -- serialised with them: otherwise a checkpoint and an entry behind it,
  -- each inserted while the other is uncommitted, would both pass their
  -- checks. Each statement after it reads committed rows afresh.
  PERFORM pg_advisory_xact_lock(723533, ('x' || encode(substring(NEW.election_id FROM 1 FOR 4), 'hex'))::bit(32)::int);
  IF EXISTS (SELECT 1 FROM board_checkpoints
      WHERE election_id = NEW.election_id AND segment >= NEW.segment) THEN
    RAISE EXCEPTION 'board_entries: segment % already has a checkpoint', NEW.segment
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER board_entries_after_checkpoints
  BEFORE INSERT ON board_entries
  FOR EACH ROW EXECUTE FUNCTION board_entries_check_fence();

-- As for board_entries: a fixed search_path with pg_temp last, so a temporary
-- table can't stand in for the board or its checkpoints.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION board_checkpoints_check_append() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION board_checkpoints_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION board_entries_check_fence() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON board_checkpoints FROM PUBLIC;
REVOKE ALL ON FUNCTION board_checkpoints_reject_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION board_checkpoints_check_append() FROM PUBLIC;
REVOKE ALL ON FUNCTION board_entries_check_fence() FROM PUBLIC;
GRANT SELECT, INSERT ON board_checkpoints TO abolish_app;
