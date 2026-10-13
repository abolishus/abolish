-- Each boarded ballot's (tier, nullifier, M), the key repeats are found by
-- (docs/spec/verifier.md 5.7; docs/spec/revoting.md, Selection step 1):
-- appendEntry writes one with each ballot it boards (its `ballot` option), in the same transaction,
-- and refuses a ballot whose key is already here, so a re-randomised copy of a
-- boarded ballot costs no board entry (T-38, T-52). The values come from
-- @abolishus/verifier's admission of the entry's own payload, never from the
-- submitter. Every column is public board data: the table is derived from
-- board_entries alone and rebuilt with it (T-23, T-53). It never decides what
-- counts; the verifier finds repeats itself.

-- No write path keyed ballots before this migration, and keys can't be
-- computed in SQL. A board with ballots would take re-randomised copies of
-- them, so it is refused; Postgres isn't authoritative, so the fix is to wipe
-- it and rebuild from chain + IPFS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM board_entries WHERE substring(payload FROM 1 FOR 2) = '\x0002') THEN
    RAISE EXCEPTION 'board_ballot_keys: board_entries already has ballots; wipe and rebuild the board'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

CREATE TABLE board_ballot_keys (
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  -- The ballot's tier (under ballot versions 2 and 3, its cell's tier).
  tier smallint NOT NULL CHECK (tier BETWEEN 0 AND 255),
  -- ν, a field<bn254> element, as 32 big-endian bytes.
  nullifier bytea NOT NULL CHECK (octet_length(nullifier) = 32),
  message bytea NOT NULL CHECK (octet_length(message) = 32),
  idx bigint NOT NULL CHECK (idx >= 0),
  PRIMARY KEY (election_id, tier, nullifier, message),
  UNIQUE (election_id, idx)
);

CREATE FUNCTION board_ballot_keys_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'board_ballot_keys is append-only: % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER board_ballot_keys_no_update_delete
  BEFORE UPDATE OR DELETE ON board_ballot_keys
  FOR EACH ROW EXECUTE FUNCTION board_ballot_keys_reject_change();

CREATE TRIGGER board_ballot_keys_no_truncate
  BEFORE TRUNCATE ON board_ballot_keys
  FOR EACH STATEMENT EXECUTE FUNCTION board_ballot_keys_reject_change();

-- What holds without hashing: a key names an entry on the board that carries
-- a ballot record.
CREATE FUNCTION board_ballot_keys_check_append() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM board_entries
      WHERE election_id = NEW.election_id AND idx = NEW.idx
        AND substring(payload FROM 1 FOR 2) = '\x0002') THEN
    RAISE EXCEPTION 'board_ballot_keys: entry % is not a ballot on the board', NEW.idx
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER board_ballot_keys_append_after_entry
  BEFORE INSERT ON board_ballot_keys
  FOR EACH ROW EXECUTE FUNCTION board_ballot_keys_check_append();

-- As for board_entries: a fixed search_path with pg_temp last, so a temporary
-- table can't stand in for the board.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION board_ballot_keys_check_append() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION board_ballot_keys_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON board_ballot_keys FROM PUBLIC;
REVOKE ALL ON FUNCTION board_ballot_keys_reject_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION board_ballot_keys_check_append() FROM PUBLIC;
GRANT SELECT, INSERT ON board_ballot_keys TO abolish_app;
