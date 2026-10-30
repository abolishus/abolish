-- Following a poll ([[P2-25]] part 4; src/follows.ts): a signed-in, verified
-- account may follow a poll, to be told when its results land or a live
-- batch is published, and stop following it. Who follows what is read only
-- by that account, and by the sender of its notices (part 4c).
--
-- T-10: the account class. A row names an account and a poll's election,
-- never a ballot, a nullifier, a receipt, a voting identity or the fact of
-- having answered, and nothing on the ballot path reads it. Following is not
-- answering. Deleting an account deletes its rows. No foreign key reaches
-- election_definitions (no-join test: no key touches a board table); core
-- checks the election exists before a follow is set.
--
-- T-11: no column keeps a time. The database still orders and dates rows
-- (`xmin`, the WAL, backups, statement logs), the residual T-11 states.
-- `account_follow_hours` keeps how many changes an account made in each UTC
-- hour, for its limit (T-52), and never which poll.
--
-- Operational: a wipe loses follows, never a result.

CREATE TABLE account_follows (
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  PRIMARY KEY (user_id, election_id)
);
-- For the notices' sender: a poll's followers.
CREATE INDEX account_follows_poll ON account_follows (election_id);

CREATE TABLE account_follow_hours (
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  hour timestamptz NOT NULL CHECK (hour = date_trunc('hour', hour, 'UTC')),
  changes integer NOT NULL CHECK (changes BETWEEN 1 AND 60),
  PRIMARY KEY (user_id, hour)
);

REVOKE ALL ON account_follows, account_follow_hours FROM PUBLIC;
-- A follow is set or taken back, never changed in place.
GRANT SELECT, INSERT, DELETE ON account_follows TO abolish_app;
-- UPDATE to count a change; DELETE to prune hours gone by.
GRANT SELECT, INSERT, UPDATE, DELETE ON account_follow_hours TO abolish_app;
