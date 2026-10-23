-- Moderation notices waiting to be e-mailed to an account ([[P2-27]] part 3;
-- src/account-notices.ts): a moderation decision, or a moderator's review of
-- an appeal, touched the account's poll or profile. Written in the
-- decision's own transaction, so a decision that commits always has its
-- notice and one that rolls back never does; deleted once sent, or once its
-- tries run out. One row per account at most: decisions made while one
-- waits ride the same notice.
--
-- T-10: the account class. A row names an account and when its notice is
-- due, never which poll or profile, what was decided, a ballot, a nullifier,
-- a receipt or the fact of having answered; nothing on the ballot path reads
-- it, and no foreign key reaches the moderation log.
--
-- T-73: a notice is due after the UTC midnight that follows its decision,
-- not at the decision's own time, so neither this row nor the provider's
-- send time can be matched to a row of the public log closer than the day.
--
-- Operational: a wipe loses notices waiting to go, never a result or a
-- decision (the log keeps those).

CREATE TABLE account_notices (
  user_id text PRIMARY KEY REFERENCES account_users (id) ON DELETE CASCADE,
  not_before timestamptz NOT NULL,
  tries smallint NOT NULL DEFAULT 0 CHECK (tries BETWEEN 0 AND 5)
);
CREATE INDEX account_notices_due ON account_notices (not_before);

REVOKE ALL ON account_notices FROM PUBLIC;
-- UPDATE of the try count and the next try's time, as a send claims a notice.
GRANT SELECT, INSERT, DELETE ON account_notices TO abolish_app;
GRANT UPDATE (not_before, tries) ON account_notices TO abolish_app;
