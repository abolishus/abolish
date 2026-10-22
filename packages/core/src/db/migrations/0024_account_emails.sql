-- Verified e-mail ([[0038-verified-accounts]], Email; P2-31 part 2;
-- src/account-emails.ts). An account's address is kept so notifications and
-- recovery can reach it (P2-27), but never in the clear: as AES-256-GCM
-- ciphertext (`address_box`, under the e-mail encryption keyring's key
-- `box_key`), and as an HMAC of the case-folded address (`address_hash`,
-- under the e-mail hash keyring's key `hash_key`) for the one-account-per-
-- address check. A dump or backup of this database alone yields no address
-- (T-66, T-69, T-73). The keys live in apps/web's environment (T-65). The
-- checks below bound lengths only: no check can tell ciphertext from a
-- cleartext address of the same length, so that rests on the code.
--
-- T-10: the account class. These tables name an account, its address and
-- times, never a poll, an election, a voter or anyone's participation, and
-- nothing on the ballot path reads them. Deleting an account deletes its rows.
--
-- Operational: a wipe loses verified addresses, never a result.

CREATE TABLE account_emails (
  user_id text PRIMARY KEY REFERENCES account_users (id) ON DELETE CASCADE,
  address_hash bytea NOT NULL UNIQUE CHECK (octet_length(address_hash) = 32),
  hash_key text NOT NULL CHECK (hash_key ~ '^[a-z0-9-]{1,32}$'),
  -- A 12-byte nonce, the ciphertext of at most 254 bytes of address, and a
  -- 16-byte tag.
  address_box bytea NOT NULL CHECK (octet_length(address_box) BETWEEN 12 + 3 + 16 AND 12 + 254 + 16),
  box_key text NOT NULL CHECK (box_key ~ '^[a-z0-9-]{1,32}$'),
  verified_at timestamptz NOT NULL
);

-- At most one code waiting per account: requesting another replaces it. The
-- address it would verify is kept sealed, as the verified one is; the code
-- only as an HMAC bound to the account, under the hash keyring's key
-- `code_key`, so a dump alone can't search the 10^8 codes for it. `tries`
-- counts wrong answers; the row goes at the last one (ADR 0038: 8 digits, 15
-- minutes, 5 tries).
CREATE TABLE account_email_codes (
  user_id text PRIMARY KEY REFERENCES account_users (id) ON DELETE CASCADE,
  address_box bytea NOT NULL CHECK (octet_length(address_box) BETWEEN 12 + 3 + 16 AND 12 + 254 + 16),
  box_key text NOT NULL CHECK (box_key ~ '^[a-z0-9-]{1,32}$'),
  code_key text NOT NULL CHECK (code_key ~ '^[a-z0-9-]{1,32}$'),
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  tries smallint NOT NULL DEFAULT 0 CHECK (tries BETWEEN 0 AND 4),
  expires_at timestamptz NOT NULL
);

-- Every code an account was sent, for its hourly and daily limits (T-52),
-- whatever became of the code. Keyed by the account alone, never by the
-- address.
CREATE TABLE account_email_sends (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL
);
CREATE INDEX account_email_sends_user_id ON account_email_sends (user_id, sent_at);

-- Every message an address was sent, for its daily cap (T-52): keyed by the
-- address's hash alone (under the hash keyring's key current at the time),
-- never by an account.
CREATE TABLE account_email_recipients (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address_hash bytea NOT NULL CHECK (octet_length(address_hash) = 32),
  sent_at timestamptz NOT NULL
);
CREATE INDEX account_email_recipients_address_hash ON account_email_recipients (address_hash, sent_at);

REVOKE ALL ON account_emails, account_email_codes, account_email_sends, account_email_recipients
  FROM PUBLIC;
-- UPDATE for the rotation job, which rewrites every row under the current keys.
GRANT SELECT, INSERT, UPDATE, DELETE ON account_emails TO abolish_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON account_email_codes TO abolish_app;
-- Never updated; DELETE only for pruning rows past the daily window.
GRANT SELECT, INSERT, DELETE ON account_email_sends TO abolish_app;
GRANT SELECT, INSERT, DELETE ON account_email_recipients TO abolish_app;
