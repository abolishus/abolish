-- The stub step of a poll's setup ([[0032-poll-creation-operations]], rules
-- 5, 7, 10 and 12; P2-22 part 4a; src/poll-stubs.ts): the stub the key
-- ceremony binds, built from a rooted poll's draft and electorate, and the
-- display text its commitment opens to, recorded as the poll moves to
-- `ceremony`.

-- The coordinator's stubs (rule 5): its state lives in Postgres, and it
-- hands seats only stubs the worker built from a submitted draft (rule 7).
-- One row per stub; a retry under rule 10 builds a new stub, with a later
-- `opens_at`, for the same election identifier, so an identifier can have
-- several. A stub is never changed once built: seats approve at most one
-- transcript per `stub_hash`, so changed bytes under a recorded hash would
-- be a stub no seat checked (T-17, T-37).
--
-- T-10: operational. Every value is public once the poll is registered:
-- the stub, which the definition becomes, and the display text, which is
-- pinned beside it. It names no account, and no poll but by the election
-- identifier the poll's own row already holds; nothing references it by
-- key. A stub whose author deletes their account stays, unattributed, like
-- an unused identifier (rule 16).
--
-- Operational: a wipe loses the ceremonies in setup, never a result.
CREATE TABLE ceremony_stubs (
  stub_hash bytea PRIMARY KEY CHECK (octet_length(stub_hash) = 32),
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  -- A complete record of type 0x0001 at version 5, its transcript hash
  -- zeroed, bounded as the coordinator's transport bounds a record.
  stub bytea NOT NULL CHECK (
    octet_length(stub) BETWEEN 3 AND 1048576 AND substring(stub FROM 1 FOR 3) = '\x000105'
  ),
  -- A complete record of type 0x0009 at version 2, salt included, at most
  -- MAX_DISPLAY_TEXT bytes, as display_texts holds it.
  display_text bytea NOT NULL CHECK (
    octet_length(display_text) BETWEEN 3 AND 4194304
    AND substring(display_text FROM 1 FOR 3) = '\x000902'
  ),
  -- The stub's `opens_at`, UNIX seconds: when its ceremony and registration
  -- must be done by.
  opens_at bigint NOT NULL CHECK (opens_at >= 0),
  created_at timestamptz NOT NULL
);
CREATE INDEX ceremony_stubs_election_id ON ceremony_stubs (election_id);

REVOKE ALL ON ceremony_stubs FROM PUBLIC;
-- Append-only: a stub may already be in a seat's hands.
GRANT SELECT, INSERT ON ceremony_stubs TO abolish_app;

-- T-10: still the account class. The stub's hash names the poll's current
-- stub, public once registered, never a voter, a ballot, a nullifier or
-- anyone's participation.
ALTER TABLE account_polls
  ADD COLUMN stub_hash bytea CHECK (octet_length(stub_hash) = 32),
  DROP CONSTRAINT account_polls_failure_check,
  ADD CONSTRAINT account_polls_failure_check CHECK (
    failure IN (
      'closes-too-soon', 'creation-reverted', 'creation-replaced', 'creation-timeout',
      'creation-anchored', 'tier-unavailable', 'electorate-empty', 'stub-refused'
    )
  ),
  -- Every state from `ceremony` on has a stub, built from the electorate,
  -- and none before it does. A failed poll keeps the stub it failed with; a
  -- retry from `failed` must clear it with the electorate.
  ADD CONSTRAINT account_polls_stub CHECK (
    (stub_hash IS NULL OR electorate IS NOT NULL)
    AND (stub_hash IS NOT NULL OR state NOT IN ('ceremony', 'registered', 'open'))
    AND (stub_hash IS NULL OR state IN ('ceremony', 'registered', 'open', 'failed'))
  );
