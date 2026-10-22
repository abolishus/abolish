-- Verified phone numbers ([[0038-verified-accounts]], The number's keyed hash
-- and A number an account leaves; P2-31 part 3; src/account-phones.ts). One
-- account per number, so a second account costs a second number (T-01). The
-- number itself is never stored, not even sealed: only `phone_hash`, a nested
-- HMAC chain over its E.164 form, made under the phone-hash keyring's keys up
-- to `hash_key`, whose later keys the rotation job applies in turn without
-- the number. The provider holds the codes (Twilio Verify), so no code is
-- stored either. A dump or backup of this database alone yields no number;
-- one with every phone-hash key yields every number (T-73).
--
-- Times are kept to the day (`verified_on`, `freed_on`) or the hour
-- (`account_phone_recipients`), as the ADR says: the cooling-off arithmetic
-- needs no more, and a coarser time joins less (T-11, T-73).
--
-- T-10: the account class. These tables name an account, a number's hash
-- and days, never a poll, an election, a voter or anyone's participation, and
-- nothing on the ballot path reads them.
--
-- Operational: a wipe loses verified numbers and holds, never a result.

CREATE TABLE account_phones (
  user_id text PRIMARY KEY REFERENCES account_users (id) ON DELETE CASCADE,
  phone_hash bytea NOT NULL UNIQUE CHECK (octet_length(phone_hash) = 32),
  hash_key text NOT NULL CHECK (hash_key ~ '^[a-z0-9-]{1,32}$'),
  -- The day the number was last verified by this account or moved to it: a
  -- number is movable to another account only 90 days after.
  verified_on timestamptz NOT NULL CHECK (verified_on = date_trunc('day', verified_on, 'UTC'))
);

-- Numbers no account holds that no account may verify yet: freed by an
-- account's deletion or change of number, for 90 days from `freed_on`, so a
-- number can't be cycled through accounts. No account column: who freed it
-- is not kept.
CREATE TABLE account_phone_holds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone_hash bytea NOT NULL CHECK (octet_length(phone_hash) = 32),
  hash_key text NOT NULL CHECK (hash_key ~ '^[a-z0-9-]{1,32}$'),
  freed_on timestamptz NOT NULL CHECK (freed_on = date_trunc('day', freed_on, 'UTC'))
);
CREATE INDEX account_phone_holds_phone_hash ON account_phone_holds (phone_hash);

-- At most one code waiting per account, for the number whose hash is here;
-- the page sends the number again with the code, since nothing here can give
-- it back. `tries` counts wrong answers; the row goes at the last one.
CREATE TABLE account_phone_codes (
  user_id text PRIMARY KEY REFERENCES account_users (id) ON DELETE CASCADE,
  phone_hash bytea NOT NULL CHECK (octet_length(phone_hash) = 32),
  hash_key text NOT NULL CHECK (hash_key ~ '^[a-z0-9-]{1,32}$'),
  tries smallint NOT NULL DEFAULT 0 CHECK (tries BETWEEN 0 AND 4),
  expires_at timestamptz NOT NULL
);

-- Every request that reached the provider (a lookup, and a code unless the
-- number was capped), for each account's hourly and daily limits and the
-- global daily ceiling (T-52). Keyed by the account alone, never the number.
CREATE TABLE account_phone_sends (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL
);
CREATE INDEX account_phone_sends_user_id ON account_phone_sends (user_id, sent_at);
CREATE INDEX account_phone_sends_sent_at ON account_phone_sends (sent_at);

-- Every code a number was sent, for its daily cap (T-52): keyed by the
-- number's hash alone, never an account, and timed to the hour only, so it
-- can't be joined to `account_phone_sends` on the instant of the send.
CREATE TABLE account_phone_recipients (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone_hash bytea NOT NULL CHECK (octet_length(phone_hash) = 32),
  sent_at timestamptz NOT NULL CHECK (sent_at = date_trunc('hour', sent_at, 'UTC'))
);
CREATE INDEX account_phone_recipients_phone_hash ON account_phone_recipients (phone_hash, sent_at);

-- An account's deletion (better-auth's, cascading here) holds its number for
-- 90 days, whatever path deleted it. The code's own deletions, of a number
-- moved to another account, set `abolish.phone_moving` for their transaction
-- and are skipped: a moved number is held by its new account, not freed.
CREATE FUNCTION account_phones_hold_on_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('abolish.phone_moving', true) IS DISTINCT FROM 'on' THEN
    INSERT INTO account_phone_holds (phone_hash, hash_key, freed_on)
    VALUES (OLD.phone_hash, OLD.hash_key, date_trunc('day', now(), 'UTC'));
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER account_phones_hold_on_delete
  AFTER DELETE ON account_phones FOR EACH ROW EXECUTE FUNCTION account_phones_hold_on_delete();

REVOKE ALL ON account_phones, account_phone_holds, account_phone_codes, account_phone_sends,
  account_phone_recipients FROM PUBLIC;
-- UPDATE for the rotation job, which extends every chain to the current key.
GRANT SELECT, INSERT, UPDATE, DELETE ON account_phones TO abolish_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON account_phone_holds TO abolish_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON account_phone_codes TO abolish_app;
-- Never updated; DELETE only for pruning rows past the daily window.
GRANT SELECT, INSERT, DELETE ON account_phone_sends TO abolish_app;
GRANT SELECT, INSERT, DELETE ON account_phone_recipients TO abolish_app;
