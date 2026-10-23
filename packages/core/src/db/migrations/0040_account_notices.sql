-- Notices waiting to be e-mailed to an account ([[P2-27]] part 3;
-- src/account-notices.ts): what a moderation decision, or a moderator's
-- review of an appeal, did to the account's poll or profile. Written in the
-- decision's own transaction, so a decision that commits always has its
-- notice and one that rolls back never does; deleted once sent, or once its
-- tries run out.
--
-- T-10: the account class. A row names an account and what moderation
-- decided (a subject, an event and a reason code), never which poll or
-- profile, a decision's sequence number, a ballot, a nullifier, a receipt
-- or the fact of having answered; nothing on the ballot path reads it, and
-- no foreign key reaches the moderation log. Deleting an account deletes its
-- notices.
--
-- T-73: the provider is sent the address and the notice's words, which name
-- no poll either, so it can't tie an address to a poll.
--
-- Operational: a wipe loses notices waiting to go, never a result or a
-- decision (the log keeps those).

CREATE TABLE account_notices (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (subject IN ('poll', 'profile')),
  event text NOT NULL CHECK (event IN ('delist', 'hide', 'restore', 'appeal-rejected')),
  reason text NOT NULL CHECK (
    reason IN (
      'illegal', 'personal-data', 'threat', 'harassment', 'spam', 'impersonation',
      'legal-notice', 'appeal-upheld', 'error', 'notice-withdrawn'
    )
  ),
  -- A profile is only ever hidden, never delisted.
  CHECK (subject = 'poll' OR event <> 'delist'),
  -- A restore cites a restore's reason; anything else, a removal's.
  CHECK (
    (event = 'restore') = (reason IN ('appeal-upheld', 'error', 'notice-withdrawn'))
  ),
  not_before timestamptz NOT NULL,
  tries smallint NOT NULL DEFAULT 0 CHECK (tries BETWEEN 0 AND 5)
);
CREATE INDEX account_notices_due ON account_notices (not_before, id);
CREATE INDEX account_notices_user ON account_notices (user_id);

REVOKE ALL ON account_notices FROM PUBLIC;
-- UPDATE of the try count and the next try's time, as a send claims a notice.
GRANT SELECT, INSERT, DELETE ON account_notices TO abolish_app;
GRANT UPDATE (not_before, tries) ON account_notices TO abolish_app;
