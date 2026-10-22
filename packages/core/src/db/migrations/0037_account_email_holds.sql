-- Addresses no account holds that no account may verify yet
-- ([[0038-verified-accounts]], Amendment (P2-31 part 6b-1); P2-31 part 6b;
-- src/account-emails.ts): freed by an account's deletion or change of
-- address, for 90 days from `freed_on`, as a number is
-- (migrations/0026). While phone verification is off an address is the whole
-- cost of a second account, so one address mustn't verify account after
-- account, each taking a Tier 0 token (T-01).
--
-- Only the address's hash, as `account_emails` kept it (`address_hash` under
-- the e-mail hash keyring's key `hash_key`), never its box: the account that
-- let it go is gone or has moved on, so nothing may read the address back.
-- Unlike a verified address, a held one can't be rewritten under a newer key,
-- so an old hash key stays in its keyring until the holds under it have ended
-- (the account-keys runbook). No account column: who freed it is not kept.
-- Timed to the day, as the phone holds are (T-11, T-73).
--
-- T-10: the account class. Names an address's hash and a day, never an
-- account, a poll, a ballot or anyone's participation.
--
-- Operational: a wipe frees every held address early, never changes a result.

CREATE TABLE account_email_holds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address_hash bytea NOT NULL CHECK (octet_length(address_hash) = 32),
  hash_key text NOT NULL CHECK (hash_key ~ '^[a-z0-9-]{1,32}$'),
  freed_on timestamptz NOT NULL CHECK (freed_on = date_trunc('day', freed_on, 'UTC'))
);
CREATE INDEX account_email_holds_address_hash ON account_email_holds (address_hash);

-- An account's deletion (better-auth's, cascading here) holds its address for
-- 90 days, whatever path deleted it. A change of address holds the old one in
-- the code (verifyEmailCode), which only ever updates the row. An operator
-- settling a row the rotation skipped sets `abolish.email_unheld` for the
-- transaction, so that account can verify its own address again (the
-- account-keys runbook).
CREATE FUNCTION account_emails_hold_on_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('abolish.email_unheld', true) IS DISTINCT FROM 'on' THEN
    INSERT INTO account_email_holds (address_hash, hash_key, freed_on)
    VALUES (OLD.address_hash, OLD.hash_key, date_trunc('day', now(), 'UTC'));
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER account_emails_hold_on_delete
  AFTER DELETE ON account_emails FOR EACH ROW EXECUTE FUNCTION account_emails_hold_on_delete();

REVOKE ALL ON account_email_holds FROM PUBLIC;
-- Never updated, since a hold can't be re-hashed; DELETE only for pruning
-- holds that have ended.
GRANT SELECT, INSERT, DELETE ON account_email_holds TO abolish_app;
