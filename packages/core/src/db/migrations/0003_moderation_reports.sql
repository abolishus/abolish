-- Reports of polls to the moderators (docs/moderation-policy.md, Reports;
-- T-68, T-52). Anyone can report a poll under one of the policy's removal
-- grounds, and a report stores only the poll and that ground: never the
-- reporter's account, address, contact details or any text (T-10, T-11,
-- T-17). Reports are counted rather than kept one row each, so the table holds
-- at most one row per election and ground however many reports arrive: a
-- flood of anonymous reports grows two counters, never the table (T-52).
--
-- `total` counts every report under the ground; `pending` counts those no
-- moderator has reviewed yet. Report volume is not a ground for moderation:
-- the counts only order the moderators' queue. `last_reported_at` is the
-- database clock at the hour, so the table can't time a report closely
-- enough to match it to a request in any log (T-11).
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
  last_reported_at timestamptz NOT NULL,
  PRIMARY KEY (election_id, reason)
);

CREATE INDEX moderation_reports_pending ON moderation_reports (last_reported_at)
  WHERE pending > 0;

REVOKE ALL ON moderation_reports FROM PUBLIC;
-- UPDATE to count a report and to mark reports reviewed; no DELETE or
-- TRUNCATE, so the app can't make a poll's reports disappear.
GRANT SELECT, INSERT, UPDATE ON moderation_reports TO abolish_app;
