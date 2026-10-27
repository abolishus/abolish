-- The worker's contract-event evidence and runs (docs/spec/archive.md,
-- Contract-event evidence, Contract-event run, Who writes them; P4-3 part
-- 4b-3a; src/archiving.ts).
--
-- archive_evidence: each evidence record the worker wrote, by its CID, for
-- one L2 contract at the first L2 block after an anchored period's end that
-- a respected dispute game claims, with the count it proves and the manifest
-- that listed it. archive_runs: the runs of that contract's events from the
-- count its previous record proved to this record's, each naming the record
-- whose manifest lists it. archive_event_progress: for each contract, the
-- last anchored period the worker examined and the accumulator, count and
-- last event's block and timestamp its last record proved, which the next
-- record's runs are replayed from before upload.
--
-- What only grows stays grown, as in 0046: a record or run is never changed
-- and is listed once, and a contract's progress only moves forward, so no
-- run is written twice from one count (T-51, T-49).
--
-- Operational: every record and run is on Arweave under the anchor's
-- locator, and is rebuilt from the L2 and the index, so a wipe loses the
-- worker's place, never a result (T-53).

CREATE TABLE archive_evidence (
  -- Every record is one raw block (docs/spec/archive.md, Contract-event
  -- evidence), so its CID is fixed by its bytes.
  cid bytea PRIMARY KEY CHECK (cid = '\x01551220'::bytea || sha256(record)),
  contract bytea NOT NULL CHECK (octet_length(contract) = 20),
  -- The anchored period it was written for.
  segment bigint NOT NULL CHECK (segment >= 0),
  l2_block bigint NOT NULL CHECK (l2_block >= 0),
  count bigint NOT NULL CHECK (count > 0),
  record bytea NOT NULL CHECK (octet_length(record) BETWEEN 1 AND 35459),
  listed_in bigint REFERENCES archive_manifests (sequence),
  UNIQUE (contract, count)
);
CREATE INDEX archive_evidence_unlisted ON archive_evidence (cid) WHERE listed_in IS NULL;

CREATE TABLE archive_runs (
  cid bytea PRIMARY KEY CHECK (octet_length(cid) = 36),
  contract bytea NOT NULL CHECK (octet_length(contract) = 20),
  first bigint NOT NULL CHECK (first >= 0),
  count integer NOT NULL CHECK (count BETWEEN 1 AND 65536),
  -- The record whose count it ends at or below, listed in the same manifest.
  evidence bytea NOT NULL REFERENCES archive_evidence (cid),
  run bytea NOT NULL CHECK (octet_length(run) BETWEEN 1 AND 16777216),
  listed_in bigint REFERENCES archive_manifests (sequence),
  UNIQUE (contract, first)
);
CREATE INDEX archive_runs_evidence ON archive_runs (evidence);

CREATE TABLE archive_event_progress (
  contract bytea PRIMARY KEY CHECK (octet_length(contract) = 20),
  segment bigint NOT NULL CHECK (segment >= 0),
  count bigint NOT NULL CHECK (count >= 0),
  accumulator bytea NOT NULL CHECK (octet_length(accumulator) = 32),
  l2_block bigint NOT NULL CHECK (l2_block >= 0),
  -- The block and timestamp of the last event counted, which the next
  -- record's first event may not precede; both 0 while none is.
  last_block bigint NOT NULL CHECK (last_block >= 0),
  last_timestamp bigint NOT NULL CHECK (last_timestamp >= 0)
);

-- A record's or run's fields never change, and it is listed once.
CREATE FUNCTION archive_evidence_check_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.listed_in IS NOT NULL OR NEW.listed_in IS NULL
      OR (NEW.cid, NEW.contract, NEW.segment, NEW.l2_block, NEW.count, NEW.record)
        IS DISTINCT FROM (OLD.cid, OLD.contract, OLD.segment, OLD.l2_block, OLD.count, OLD.record) THEN
    RAISE EXCEPTION 'archive_evidence: only an unlisted record is listed, once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION archive_runs_check_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.listed_in IS NOT NULL OR NEW.listed_in IS NULL
      OR (NEW.cid, NEW.contract, NEW.first, NEW.count, NEW.evidence, NEW.run)
        IS DISTINCT FROM (OLD.cid, OLD.contract, OLD.first, OLD.count, OLD.evidence, OLD.run) THEN
    RAISE EXCEPTION 'archive_runs: only an unlisted run is listed, once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

-- A contract's progress moves forward only: a later period, and a count,
-- block and last event never below the last.
CREATE FUNCTION archive_event_progress_check_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.contract IS DISTINCT FROM OLD.contract
      OR NEW.segment <= OLD.segment
      OR NEW.count < OLD.count
      OR NEW.l2_block < OLD.l2_block
      OR NEW.last_block < OLD.last_block
      OR NEW.last_timestamp < OLD.last_timestamp
      OR (NEW.count = OLD.count AND NEW.accumulator IS DISTINCT FROM OLD.accumulator) THEN
    RAISE EXCEPTION 'archive_event_progress: only moves forward'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER archive_evidence_no_delete
  BEFORE DELETE ON archive_evidence
  FOR EACH ROW EXECUTE FUNCTION archive_reject_change();
CREATE TRIGGER archive_evidence_no_truncate
  BEFORE TRUNCATE ON archive_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION archive_reject_change();
CREATE TRIGGER archive_evidence_listed_once
  BEFORE UPDATE ON archive_evidence
  FOR EACH ROW EXECUTE FUNCTION archive_evidence_check_update();
CREATE TRIGGER archive_runs_no_delete
  BEFORE DELETE ON archive_runs
  FOR EACH ROW EXECUTE FUNCTION archive_reject_change();
CREATE TRIGGER archive_runs_no_truncate
  BEFORE TRUNCATE ON archive_runs
  FOR EACH STATEMENT EXECUTE FUNCTION archive_reject_change();
CREATE TRIGGER archive_runs_listed_once
  BEFORE UPDATE ON archive_runs
  FOR EACH ROW EXECUTE FUNCTION archive_runs_check_update();
CREATE TRIGGER archive_event_progress_no_delete
  BEFORE DELETE ON archive_event_progress
  FOR EACH ROW EXECUTE FUNCTION archive_reject_change();
CREATE TRIGGER archive_event_progress_no_truncate
  BEFORE TRUNCATE ON archive_event_progress
  FOR EACH STATEMENT EXECUTE FUNCTION archive_reject_change();
CREATE TRIGGER archive_event_progress_forward
  BEFORE UPDATE ON archive_event_progress
  FOR EACH ROW EXECUTE FUNCTION archive_event_progress_check_update();

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION archive_evidence_check_update() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION archive_runs_check_update() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION archive_event_progress_check_update() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON archive_evidence, archive_runs, archive_event_progress FROM PUBLIC;
REVOKE ALL ON FUNCTION archive_evidence_check_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION archive_runs_check_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION archive_event_progress_check_update() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE (listed_in) ON archive_evidence TO abolish_app;
GRANT SELECT, INSERT, UPDATE (listed_in) ON archive_runs TO abolish_app;
GRANT SELECT, INSERT,
  UPDATE (segment, count, accumulator, l2_block, last_block, last_timestamp)
  ON archive_event_progress TO abolish_app;
