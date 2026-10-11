-- Reports of polls to the moderators (docs/moderation-policy.md, Reports;
-- T-68, T-52). Anyone can report a poll under one of the policy's removal
-- grounds, and a report stores only the poll and that ground: never the
-- reporter's account, address, contact details or any text (T-10, T-11,
-- T-17). Reports are counted rather than kept one row each, so the table holds
-- at most one row per election and ground however many reports arrive: a
-- flood of anonymous reports grows two counters, never the table (T-52).
--
-- `total` counts every report under the ground; `pending` counts those no
-- moderator has reviewed yet. Report volume is not a ground for moderation.
-- `pending_since` is the hour, by the database clock, when the oldest
-- unreviewed report arrived (null when none is pending): the queue is ordered
-- by it, so reporting a poll again never moves it back (T-68). It changes
-- only when a report starts a pending run, so the row doesn't record when
-- later reports arrived (T-11; what still can, see docs/moderation-policy.md).
--
-- Operational data: a wipe loses the queue and changes no result. No foreign
-- key reaches election_definitions (no-join test: no key touches a board
-- table); the tooling checks the election exists before counting a report.

CREATE TABLE moderation_reports (
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  reason text NOT NULL CHECK (
    reason IN (
      'illegal', 'personal-data', 'threat', 'harassment', 'spam', 'impersonation', 'legal-notice'
    )
  ),
  total bigint NOT NULL CHECK (total >= 1),
  pending bigint NOT NULL CHECK (pending >= 0 AND pending <= total),
  pending_since timestamptz CHECK ((pending = 0) = (pending_since IS NULL)),
  PRIMARY KEY (election_id, reason)
);

CREATE INDEX moderation_reports_queue ON moderation_reports (pending_since, election_id, reason)
  WHERE pending > 0;

REVOKE ALL ON moderation_reports FROM PUBLIC;
-- UPDATE to count a report and to mark reports reviewed; no DELETE or
-- TRUNCATE, so the app can't make a poll's reports disappear.
GRANT SELECT, INSERT, UPDATE ON moderation_reports TO abolish_app;
