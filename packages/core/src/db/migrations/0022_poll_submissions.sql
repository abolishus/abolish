-- The author's side of a failed poll ([[0032-poll-creation-operations]],
-- rules 14 and 18; P2-22 part 5d-2; src/poll-drafts.ts): retrying returns a
-- failed poll to its draft, which can be submitted again, and discarding
-- deletes it. Both would let a submission stop counting against the daily
-- limit if the limit still counted `account_polls.submitted_at`: a retried
-- poll's next submission replaces the time, and a discarded poll's row is
-- gone. So every submission is now a row of its own, kept whatever becomes
-- of its poll (T-72: each one can cost the creation key a creation).
--
-- T-10: the account class. It names the author's account and a time, never
-- a poll, an election, a voter or anyone's participation. Deleting an
-- account deletes its rows (rule 16), as it does the account's polls.
--
-- Operational: a wipe forgets the last day's submissions, never a result.
CREATE TABLE account_poll_submissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  submitted_at timestamptz NOT NULL
);
CREATE INDEX account_poll_submissions_user_id ON account_poll_submissions (user_id, submitted_at);

REVOKE ALL ON account_poll_submissions FROM PUBLIC;
-- Append-only: a submission discarded or retried still counts for its 24
-- hours. The rows are small and at most MAX_SUBMISSIONS_PER_DAY an account
-- a day, so none is pruned.
GRANT SELECT, INSERT ON account_poll_submissions TO abolish_app;

-- The submissions made before this migration, so the limit's window holds
-- across it.
INSERT INTO account_poll_submissions (user_id, submitted_at)
SELECT user_id, submitted_at FROM account_polls WHERE submitted_at IS NOT NULL;

-- `account_polls.submitted_at` now dates the poll's current submission only
-- (the creation step takes polls oldest submission first), and a retry
-- clears it with the rest of the setup, since the poll is a draft again.
