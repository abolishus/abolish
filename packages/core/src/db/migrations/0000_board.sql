-- The bulletin board (docs/spec/board.md): one append-only, hash-chained run of
-- entries per election. Postgres is not authoritative: every row is rebuilt
-- from chain + IPFS (T-23, T-53). Hashes are computed by @abolishus/crypto,
-- never here; this table only enforces what holds without hashing: rows are
-- never changed or removed, indexes are contiguous from 0, segments never
-- decrease, and each row's prev_link is the previous row's link.

CREATE TABLE board_entries (
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  idx bigint NOT NULL CHECK (idx >= 0),
  segment bigint NOT NULL CHECK (segment BETWEEN 0 AND 4294967295),
  payload bytea NOT NULL CHECK (octet_length(payload) BETWEEN 3 AND 1048576),
  entry_hash bytea NOT NULL CHECK (octet_length(entry_hash) = 32),
  prev_link bytea NOT NULL CHECK (octet_length(prev_link) = 32),
  link bytea NOT NULL CHECK (octet_length(link) = 32),
  PRIMARY KEY (election_id, idx)
);

CREATE FUNCTION board_entries_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'board_entries is append-only: % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER board_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON board_entries
  FOR EACH ROW EXECUTE FUNCTION board_entries_reject_change();

CREATE TRIGGER board_entries_no_truncate
  BEFORE TRUNCATE ON board_entries
  FOR EACH STATEMENT EXECUTE FUNCTION board_entries_reject_change();

CREATE FUNCTION board_entries_check_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev board_entries%ROWTYPE;
BEGIN
  IF NEW.idx = 0 THEN
    IF NEW.prev_link <> '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea THEN
      RAISE EXCEPTION 'board_entries: entry 0 must chain from 32 zero bytes'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO prev FROM board_entries
    WHERE election_id = NEW.election_id AND idx = NEW.idx - 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'board_entries: entry % has no entry before it', NEW.idx
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.segment < prev.segment THEN
    RAISE EXCEPTION 'board_entries: segment % is below the previous entry''s %', NEW.segment, prev.segment
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.prev_link <> prev.link THEN
    RAISE EXCEPTION 'board_entries: prev_link of entry % is not the previous link', NEW.idx
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER board_entries_append_only_in_order
  BEFORE INSERT ON board_entries
  FOR EACH ROW EXECUTE FUNCTION board_entries_check_append();

REVOKE ALL ON board_entries FROM PUBLIC;
REVOKE ALL ON FUNCTION board_entries_reject_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION board_entries_check_append() FROM PUBLIC;

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO abolish_app', current_schema());
END
$$;
GRANT SELECT, INSERT ON board_entries TO abolish_app;
