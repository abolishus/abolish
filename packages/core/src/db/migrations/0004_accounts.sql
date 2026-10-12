-- Accounts (better-auth with passkeys, src/accounts.ts): who someone is to the
-- app (poll creation, moderation, notifications), never their voting identity
-- (docs/PROJECT_BRIEF.md; T-10, T-20). Operational, not authoritative: a wipe
-- loses accounts but no result.
--
-- T-10: no table here references, or is referenced by, anything outside the
-- account tables, and no column holds a ballot, a nullifier, a voting identity
-- or a poll. The checks below also keep out what better-auth would otherwise
-- store about a person: an address or user agent per session, a real e-mail
-- address, a name or a picture. A later migration that needs one (e-mail
-- notifications, say) relaxes its check deliberately.

CREATE TABLE account_users (
  id text PRIMARY KEY,
  -- better-auth requires a unique e-mail; a passkey account has none, so it is
  -- a random placeholder under the reserved .invalid TLD (RFC 2606).
  email text NOT NULL UNIQUE CHECK (email ~ '^[a-z0-9]{32}@account\.invalid$'),
  email_verified boolean NOT NULL CHECK (NOT email_verified),
  name text NOT NULL CHECK (name = ''),
  image text CHECK (image IS NULL),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE account_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  -- T-10, T-11: never an address or a user agent.
  ip_address text CHECK (ip_address IS NULL),
  user_agent text CHECK (user_agent IS NULL),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX account_sessions_user_id ON account_sessions (user_id);

CREATE TABLE account_passkeys (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  -- Clients label passkeys with device or owner names; none is kept.
  name text CHECK (name IS NULL),
  public_key text NOT NULL,
  credential_id text NOT NULL UNIQUE,
  counter bigint NOT NULL CHECK (counter BETWEEN 0 AND 4294967295),
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  transports text,
  aaguid text,
  created_at timestamptz
);
CREATE INDEX account_passkeys_user_id ON account_passkeys (user_id);

-- better-auth's table for passwords and OAuth tokens. Accounts here have
-- neither, so it is never written: every row is refused. better-auth still
-- reads it, and clears it when an account is deleted.
CREATE TABLE account_credentials (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (false)
);
CREATE INDEX account_credentials_user_id ON account_credentials (user_id);

-- Short-lived WebAuthn challenges, keyed by a hash of the token in the
-- challenge cookie (better-auth's "hashed" identifiers).
CREATE TABLE account_verifications (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX account_verifications_identifier ON account_verifications (identifier);
-- The passkey plugin never deletes an abandoned challenge, and anyone can make
-- one; pruneAccountVerifications deletes expired rows by this index (T-52).
CREATE INDEX account_verifications_expires_at ON account_verifications (expires_at);

REVOKE ALL
  ON account_users, account_sessions, account_passkeys, account_credentials, account_verifications
  FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON account_users, account_sessions, account_passkeys, account_verifications TO abolish_app;
GRANT SELECT, DELETE ON account_credentials TO abolish_app;
