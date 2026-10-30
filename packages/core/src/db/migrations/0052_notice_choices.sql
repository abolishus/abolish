-- Notification choices ([[P2-27]] part 3c-2a; src/account-notices.ts): what
-- an account chose to be e-mailed about beyond the moderation notices, which
-- are always sent. One row per account that has chosen; an account with none
-- takes the defaults. `results`: whether results landing for a poll it
-- followed join its notice (src/follows.ts, `landResults`). With it off, the
-- poll still goes on the account page's list, and only the e-mail, and the
-- push that goes with it, are left out.
--
-- T-10: the account class. A row names an account and its choices, never a
-- poll, a ballot or the fact of having answered. T-73: a choice turned off is
-- a notice the e-mail provider and push services never see.
--
-- Operational: a wipe loses the choices, which fall back to the defaults.

CREATE TABLE account_notice_choices (
  user_id text PRIMARY KEY REFERENCES account_users (id) ON DELETE CASCADE,
  results boolean NOT NULL
);

REVOKE ALL ON account_notice_choices FROM PUBLIC;
-- A choice is made once and changed after, never deleted but with its account.
GRANT SELECT, INSERT ON account_notice_choices TO abolish_app;
GRANT UPDATE (results) ON account_notice_choices TO abolish_app;
