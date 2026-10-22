-- The phone-hash rotation (P2-31 part 3c; src/account-phones.ts,
-- rotatePhoneHashes; [[0038-verified-accounts]], The number's keyed hash).
-- Rotating to a new key extends every stored chain by one HMAC, so a dump
-- taken after it is useless with the old keys alone (T-73). Each row says the
-- key its chain ends under; the per-number send counts didn't, so a chain
-- there couldn't be extended, and a dump in the day after a rotation would
-- still hold the numbers sent codes that day under the old keys.
--
-- Nullable, so this is safe on a populated table: a row from before it is
-- matched as before and pruned within a day (pruneAccountPhones), and only
-- rows from after it are rotated.
ALTER TABLE account_phone_recipients
  ADD COLUMN hash_key text CHECK (hash_key ~ '^[a-z0-9-]{1,32}$');

-- The rotation finds the rows not yet under the current key by `hash_key`:
-- few distinct values, of which the current one is nearly every row, so the
-- index serves the rare older ones. Codes and per-number counts are pruned
-- within a day and stay small.
CREATE INDEX account_phones_hash_key ON account_phones (hash_key);
CREATE INDEX account_phone_holds_hash_key ON account_phone_holds (hash_key);

-- UPDATE of the hash columns for the rotation alone, never of `sent_at`, the
-- cap's clock.
GRANT UPDATE (phone_hash, hash_key) ON account_phone_recipients TO abolish_app;

-- A check value per phone-hash key, `HMAC(key, "abolish/phone/keycheck/v1")`,
-- written by the first instance that holds the key. A rotation is one way:
-- once every chain runs through a key, an instance with that key's ID but
-- other bytes (a mistyped or re-pasted key) matches none of them, and every
-- verified number could verify a second account (T-01). So an instance
-- refuses to rotate unless each of its keys reproduces its stored check. A
-- PRF's output on a fixed input says nothing about a 256-bit key (T-73).
-- Account class: names no account. Never updated or deleted, so a check
-- once written stands for the key's ID for good, as the key does.
CREATE TABLE account_phone_key_checks (
  key_id text PRIMARY KEY CHECK (key_id ~ '^[a-z0-9-]{1,32}$'),
  key_check bytea NOT NULL CHECK (octet_length(key_check) = 32)
);
REVOKE ALL ON account_phone_key_checks FROM PUBLIC;
GRANT SELECT, INSERT ON account_phone_key_checks TO abolish_app;
