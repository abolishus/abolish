-- The creator record and the author's drafts ([[0032-poll-creation-operations]],
-- rules 12 and 15; P2-22 part 2; src/poll-drafts.ts). One row per poll an
-- account wrote, from its first draft through setup: whose poll it is, its
-- state, and the draft the worker builds the definition from.
--
-- T-10: in the account class of the no-join tests. The only foreign key is to
-- account_users, and nothing here names a voter, a ballot, a nullifier, a
-- receipt or anyone's participation; the draft is the author's own text,
-- which becomes public display text once the poll is set up. Deleting an
-- account deletes its rows (rule 16).
--
-- Operational: a wipe loses who wrote which poll and the polls still in
-- setup, never a result (rule 16).

CREATE TABLE account_polls (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9]{32}$'),
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  state text NOT NULL CHECK (
    state IN ('drafted', 'submitted', 'created', 'rooted', 'ceremony', 'registered', 'open', 'failed')
  ),
  -- Checked by core before every write; bounded here too, so no write path
  -- can store an unbounded document (T-52).
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object' AND octet_length(draft::text) <= 262144),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- Kept once set, whatever the state becomes: the per-account daily limit
  -- counts submissions by it (rule 18).
  submitted_at timestamptz CHECK (submitted_at IS NOT NULL OR state = 'drafted')
);
CREATE INDEX account_polls_user_id ON account_polls (user_id, submitted_at);

REVOKE ALL ON account_polls FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON account_polls TO abolish_app;
