-- The e-mail keyrings' rotation (P2-31 part 3d; src/account-emails.ts,
-- rotateEmailKeys; [[0038-verified-accounts]], Email). Unlike a phone
-- number, an address can be read back, so a rotation re-hashes and re-seals
-- each verified address under the current keys, and re-seals each waiting
-- code's address; then an older key can leave the keyrings for good, and a
-- dump taken after it is useless with that key (T-73).
--
-- A check value per e-mail key, as account_phone_key_checks keeps per phone
-- key (migrations/0030): `HMAC(key, "abolish/email/keycheck/v1")` for a hash
-- key and `HMAC(key, "abolish/email-box/keycheck/v1")` for a box key,
-- written by the first instance that holds the key. An instance whose keys
-- don't all reproduce their checks rotates nothing, so a key retyped under
-- its ID can't rewrite every address under bytes no other instance holds.
-- Account class: names no account. Never updated or deleted by the app.
CREATE TABLE account_email_key_checks (
  keyring text NOT NULL CHECK (keyring IN ('hash', 'box')),
  key_id text NOT NULL CHECK (key_id ~ '^[a-z0-9-]{1,32}$'),
  key_check bytea NOT NULL CHECK (octet_length(key_check) = 32),
  PRIMARY KEY (keyring, key_id)
);
REVOKE ALL ON account_email_key_checks FROM PUBLIC;
GRANT SELECT, INSERT ON account_email_key_checks TO abolish_app;
