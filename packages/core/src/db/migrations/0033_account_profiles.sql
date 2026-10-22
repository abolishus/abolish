-- Creator profiles ([[0040-creator-profiles]]; P2-27 part 1b;
-- src/profiles.ts): an account may make one profile, an unverified name it
-- chooses and a random public handle, and choose for each of its polls
-- whether the profile shows it. With no profile, or for a poll not chosen,
-- nothing names the poll's author.
--
-- T-10: the account class. These tables name an account, its handle and
-- name, and its own polls by their creator record (`account_polls`, rule
-- 15), never a ballot, a nullifier, a receipt, a voting identity or anyone's
-- participation, and nothing on the ballot path reads them. Deleting an
-- account deletes its profile and choices; deleting a profile deletes its
-- choices.
--
-- T-75: the link lives only here, never on chain, on IPFS, on the board or
-- in the archive. `profile_handles` keeps every handle ever issued, and
-- nothing else, so a deleted profile's handle is never issued again: the app
-- may add a handle, never remove one.
--
-- T-11: the only time is the day an account last set a name, kept to the
-- day, for the once-a-day limit; it outlives the profile, so deleting and
-- making one again doesn't reset it.
--
-- Operational: a wipe loses every profile and choice, never a result; polls
-- are rebuilt anonymous.

CREATE TABLE profile_handles (
  -- 16 characters of lowercase RFC 4648 base32: 80 random bits.
  handle text PRIMARY KEY CHECK (handle ~ '^[a-z2-7]{16}$')
);

CREATE TABLE account_profiles (
  user_id text PRIMARY KEY REFERENCES account_users (id) ON DELETE CASCADE,
  handle text NOT NULL UNIQUE REFERENCES profile_handles (handle),
  -- Checked by core (src/profiles.ts, profileName); bounded here too, so no
  -- write path stores an unnormalised or unbounded name.
  name text NOT NULL CHECK (
    char_length(name) BETWEEN 1 AND 60
    AND name IS NFC NORMALIZED
    AND name !~ '^ | $|  '
    AND name !~ '[[:cntrl:]]'
  )
);

CREATE TABLE account_profile_namings (
  user_id text PRIMARY KEY REFERENCES account_users (id) ON DELETE CASCADE,
  named_on timestamptz NOT NULL CHECK (named_on = date_trunc('day', named_on, 'UTC'))
);

-- A choice can name only a poll of the profile's own account.
ALTER TABLE account_polls ADD CONSTRAINT account_polls_id_user UNIQUE (id, user_id);

CREATE TABLE account_profile_polls (
  poll_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES account_profiles (user_id) ON DELETE CASCADE,
  FOREIGN KEY (poll_id, user_id) REFERENCES account_polls (id, user_id) ON DELETE CASCADE
);
CREATE INDEX account_profile_polls_user_id ON account_profile_polls (user_id);

REVOKE ALL ON profile_handles, account_profiles, account_profile_namings, account_profile_polls
  FROM PUBLIC;
-- A handle is issued, never reissued or removed.
GRANT SELECT, INSERT ON profile_handles TO abolish_app;
-- A rename updates the name; the handle never changes.
GRANT SELECT, INSERT, DELETE ON account_profiles TO abolish_app;
GRANT UPDATE (name) ON account_profiles TO abolish_app;
GRANT SELECT, INSERT, UPDATE ON account_profile_namings TO abolish_app;
-- A choice is made or taken back, never changed in place.
GRANT SELECT, INSERT, DELETE ON account_profile_polls TO abolish_app;
