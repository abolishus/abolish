-- Results notices for followed polls ([[P2-25]] part 4c; src/follows.ts,
-- src/account-notices.ts): once a followed poll's results are in, each of
-- its follows becomes a row of `account_follow_results`, the polls the
-- account's page lists as having results, and the account's one waiting
-- notice says results are in, beside or instead of a moderation decision.
--
-- T-10: the account class. A row names an account and a poll's election,
-- never a ballot, a nullifier, a receipt or the fact of having answered, as
-- a follow does. No foreign key reaches election_definitions.
--
-- T-11: no column keeps a time, as for follows. T-73: a notice still names
-- neither its poll nor its decision, and is due after the UTC midnight that
-- follows the newest event it carries; the two flags say only which words
-- it is sent in.
--
-- Operational: a wipe loses the lists and the notices waiting, never a result.

ALTER TABLE account_notices
  ADD COLUMN moderation boolean NOT NULL DEFAULT true,
  ADD COLUMN results boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT account_notices_about CHECK (moderation OR results);
-- UPDATE of the flags, as a later event joins the notice waiting.
GRANT UPDATE (moderation, results) ON account_notices TO abolish_app;

CREATE TABLE account_follow_results (
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  PRIMARY KEY (user_id, election_id)
);

REVOKE ALL ON account_follow_results FROM PUBLIC;
-- Written when results land, taken off the list by its account, never changed.
GRANT SELECT, INSERT, DELETE ON account_follow_results TO abolish_app;
