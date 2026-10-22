-- The board path for share receipts (docs/spec/delivery.md, Boarding; P2-8
-- part 3c-1b-2b-2b-2d-1). Two indexes over board_entries, each written by
-- appendEntry in the transaction that appends the entry it names:
--
-- - board_ballot_hashes: each boarded ballot's ballot hash, as the
--   verifier's admission recomputed it from the entry's own payload, so a
--   receipt finds the ballot it names (rule 2) without a scan of the board
--   (T-52). Several entries may share one: a ballot cast again with the same
--   core after its block was reorganised away has another M and one ballot
--   hash (docs/spec/revoting.md, Client rule 4).
-- - board_share_receipts: each boarded share receipt's (ballot hash, panel,
--   seat), written only for a receipt the verifier's check passed against
--   that ballot, so the operator boards at most one passing receipt per seat
--   of a boarded ballot through the board path (rule 5; T-17, T-52).
--
-- Every column is public board data, derived from board_entries alone and
-- rebuilt with it (T-23, T-53). Neither decides what counts: the delivery
-- check reads every record the board holds. Ballots boarded before this
-- migration have no row, so a receipt for one is refused as naming no ballot
-- until the board is rebuilt; Postgres isn't authoritative.

-- The board's own payload check takes share receipts (0x000c) too, which
-- board-entry versions 3 to 7 allow (docs/spec/board.md, Allowed payloads).
-- The other types those versions add get theirs with their writers; the
-- entry's encoder refuses any type its version doesn't allow either way
-- (T-17). Every stored payload passes the old check, so the new one, its
-- superset, validates; the scan holds the table's lock for moments at this
-- stage.
ALTER TABLE board_entries DROP CONSTRAINT board_entries_payload_check;
ALTER TABLE board_entries ADD CONSTRAINT board_entries_payload_check CHECK (
  octet_length(payload) BETWEEN 3 AND 1048576
  AND substring(payload FROM 1 FOR 2) IN ('\x0002', '\x0003', '\x0005', '\x0006', '\x0008', '\x000c')
);

CREATE TABLE board_ballot_hashes (
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  idx bigint NOT NULL CHECK (idx >= 0),
  ballot_hash bytea NOT NULL CHECK (octet_length(ballot_hash) = 32),
  PRIMARY KEY (election_id, idx)
);

CREATE INDEX board_ballot_hashes_by_hash ON board_ballot_hashes (election_id, ballot_hash);

CREATE TABLE board_share_receipts (
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  ballot_hash bytea NOT NULL CHECK (octet_length(ballot_hash) = 32),
  -- 1 for the default panel; 2, an author panel, for delivery records of
  -- version 2 (docs/spec/delivery.md, Version 2).
  panel smallint NOT NULL CHECK (panel BETWEEN 1 AND 2),
  seat smallint NOT NULL CHECK (seat BETWEEN 1 AND 255),
  idx bigint NOT NULL CHECK (idx >= 0),
  PRIMARY KEY (election_id, ballot_hash, panel, seat),
  UNIQUE (election_id, idx)
);

CREATE FUNCTION board_share_receipts_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER board_ballot_hashes_no_update_delete
  BEFORE UPDATE OR DELETE ON board_ballot_hashes
  FOR EACH ROW EXECUTE FUNCTION board_share_receipts_reject_change();

CREATE TRIGGER board_ballot_hashes_no_truncate
  BEFORE TRUNCATE ON board_ballot_hashes
  FOR EACH STATEMENT EXECUTE FUNCTION board_share_receipts_reject_change();

CREATE TRIGGER board_share_receipts_no_update_delete
  BEFORE UPDATE OR DELETE ON board_share_receipts
  FOR EACH ROW EXECUTE FUNCTION board_share_receipts_reject_change();

CREATE TRIGGER board_share_receipts_no_truncate
  BEFORE TRUNCATE ON board_share_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION board_share_receipts_reject_change();

-- What holds without hashing: a ballot hash names an entry on the board that
-- carries a ballot record, and a receipt row one that carries a share
-- receipt, after an entry carrying a ballot of that ballot hash.
CREATE FUNCTION board_ballot_hashes_check_append() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM board_entries
      WHERE election_id = NEW.election_id AND idx = NEW.idx
        AND substring(payload FROM 1 FOR 2) = '\x0002') THEN
    RAISE EXCEPTION 'board_ballot_hashes: entry % is not a ballot on the board', NEW.idx
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION board_share_receipts_check_append() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM board_entries
      WHERE election_id = NEW.election_id AND idx = NEW.idx
        AND substring(payload FROM 1 FOR 2) = '\x000c') THEN
    RAISE EXCEPTION 'board_share_receipts: entry % is not a share receipt on the board', NEW.idx
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM board_ballot_hashes
      WHERE election_id = NEW.election_id AND ballot_hash = NEW.ballot_hash
        AND idx < NEW.idx) THEN
    RAISE EXCEPTION 'board_share_receipts: no ballot before entry % has its ballot hash', NEW.idx
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER board_ballot_hashes_append_after_entry
  BEFORE INSERT ON board_ballot_hashes
  FOR EACH ROW EXECUTE FUNCTION board_ballot_hashes_check_append();

CREATE TRIGGER board_share_receipts_append_after_entry
  BEFORE INSERT ON board_share_receipts
  FOR EACH ROW EXECUTE FUNCTION board_share_receipts_check_append();

-- As for board_entries: a fixed search_path with pg_temp last, so a temporary
-- table can't stand in for the board.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION board_share_receipts_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION board_ballot_hashes_check_append() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION board_share_receipts_check_append() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON board_ballot_hashes FROM PUBLIC;
REVOKE ALL ON board_share_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION board_share_receipts_reject_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION board_ballot_hashes_check_append() FROM PUBLIC;
REVOKE ALL ON FUNCTION board_share_receipts_check_append() FROM PUBLIC;
GRANT SELECT, INSERT ON board_ballot_hashes TO abolish_app;
GRANT SELECT, INSERT ON board_share_receipts TO abolish_app;
