-- The ceremony coordinator ([[0032-poll-creation-operations]], rules 5 to
-- 7; P2-22 part 4c; src/ceremony-coordinator.ts): one run of the key
-- ceremony per recorded stub, the seats' messages it relays and the
-- approvals it collects. The coordinator holds nothing secret and is
-- trusted for liveness only (docs/spec/ceremony.md, Parties and keys):
-- every message here is signed by its seat and checked again by every
-- other seat and the verifier (T-37, T-54).
--
-- T-10: operational. Every value is public once the poll registers (the
-- transcript is the board's first entry, the approvals are the
-- registration's signatures); nothing names an account, a poll or a voter.
--
-- Operational: a wipe loses the ceremonies in progress, never a result.

-- One run per stub: a retry under rule 10 builds a new stub, and so a new
-- run. `round` 1 to 4 is the open round, 5 the approvals, 6 closed with an
-- outcome.
CREATE TABLE ceremony_runs (
  run_id bytea PRIMARY KEY CHECK (octet_length(run_id) = 32),
  stub_hash bytea NOT NULL UNIQUE REFERENCES ceremony_stubs (stub_hash),
  round smallint NOT NULL CHECK (round BETWEEN 1 AND 6),
  round_opened_at timestamptz NOT NULL,
  -- The rounds closed so far, a complete record of type 0x0005 at version
  -- 1, bounded as the seats' transport bounds a record.
  transcript bytea NOT NULL CHECK (
    octet_length(transcript) BETWEEN 3 AND 1048576
    AND substring(transcript FROM 1 FOR 3) = '\x000501'
  ),
  -- Once round 4 closed with a transcript that checks: its hash, the
  -- registered key set's hash and its qualified seats, in order.
  transcript_hash bytea CHECK (octet_length(transcript_hash) = 32),
  key_set_hash bytea CHECK (octet_length(key_set_hash) = 32),
  qualified smallint[] CHECK (cardinality(qualified) BETWEEN 1 AND 16),
  outcome text CHECK (
    outcome IN ('approved', 'too-few-messages', 'transcript-refused', 'too-few-approvals')
  ),
  created_at timestamptz NOT NULL,
  -- Checked exactly when the approvals opened: in round 5, and closed
  -- after it.
  CONSTRAINT ceremony_runs_checked CHECK (
    (transcript_hash IS NULL) = (key_set_hash IS NULL)
    AND (transcript_hash IS NULL) = (qualified IS NULL)
    AND (round < 5) <= (transcript_hash IS NULL)
    AND (round = 5) <= (transcript_hash IS NOT NULL)
    AND (round = 6) = (outcome IS NOT NULL)
    AND ((outcome IN ('approved', 'too-few-approvals')) IS NOT TRUE OR transcript_hash IS NOT NULL)
  )
);

-- A seat's message for one round, as it posted it: a version-1 transcript
-- of the run holding only that message. The first that fits is kept: a
-- second would be equivocation, and the transcript holds one per seat.
CREATE TABLE ceremony_messages (
  run_id bytea NOT NULL REFERENCES ceremony_runs (run_id),
  round smallint NOT NULL CHECK (round BETWEEN 1 AND 4),
  seat smallint NOT NULL CHECK (seat BETWEEN 1 AND 16),
  message bytea NOT NULL CHECK (
    octet_length(message) BETWEEN 3 AND 1048576
    AND substring(message FROM 1 FOR 3) = '\x000501'
  ),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, round, seat)
);

-- A qualified seat's ceremony registration signature over the run's
-- transcript and key set (docs/spec/trustee-identity.md, Ceremony
-- registration), checked before it is kept.
CREATE TABLE ceremony_approvals (
  run_id bytea NOT NULL REFERENCES ceremony_runs (run_id),
  seat smallint NOT NULL CHECK (seat BETWEEN 1 AND 16),
  signature bytea NOT NULL CHECK (octet_length(signature) = 64),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, seat)
);

REVOKE ALL ON ceremony_runs, ceremony_messages, ceremony_approvals FROM PUBLIC;
-- A run advances in place; what a seat sent is never changed.
GRANT SELECT, INSERT, UPDATE ON ceremony_runs TO abolish_app;
GRANT SELECT, INSERT ON ceremony_messages, ceremony_approvals TO abolish_app;
