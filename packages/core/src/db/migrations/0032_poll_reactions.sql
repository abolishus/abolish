-- Reactions on a poll ([[P2-25]] part 5; src/reactions.ts): a signed-in,
-- verified account may set each of a fixed set of reactions on a poll once,
-- and take it back. The counts per poll are public; who set which is not.
--
-- T-10: the account class. A row names an account, a poll's election and a
-- reaction, never a ballot, a nullifier, a receipt, a voting identity or the
-- fact of having answered, and nothing on the ballot path reads it. Reacting
-- is not answering. Deleting an account deletes its rows. No foreign key
-- reaches election_definitions (no-join test: no key touches a board table);
-- core checks the election exists before a reaction is set.
--
-- T-11: no column keeps a time. The database still orders and dates rows
-- (`xmin`, the WAL, backups, statement logs), the residual T-11 states.
-- `account_reaction_hours` keeps how many changes an account made in each
-- UTC hour, for its limit (T-52), and never which poll or reaction.
--
-- Operational: a wipe loses reactions, never a result.

CREATE TABLE account_reactions (
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  reaction text NOT NULL CHECK (
    reaction IN ('heart', 'laugh', 'wow', 'thinking', 'sad', 'clap')
  ),
  PRIMARY KEY (user_id, election_id, reaction)
);
CREATE INDEX account_reactions_counts ON account_reactions (election_id, reaction);

CREATE TABLE account_reaction_hours (
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  hour timestamptz NOT NULL CHECK (hour = date_trunc('hour', hour, 'UTC')),
  changes integer NOT NULL CHECK (changes BETWEEN 1 AND 60),
  PRIMARY KEY (user_id, hour)
);

REVOKE ALL ON account_reactions, account_reaction_hours FROM PUBLIC;
-- A reaction is set or taken back, never changed in place.
GRANT SELECT, INSERT, DELETE ON account_reactions TO abolish_app;
-- UPDATE to count a change; DELETE to prune hours gone by.
GRANT SELECT, INSERT, UPDATE, DELETE ON account_reaction_hours TO abolish_app;
