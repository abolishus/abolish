-- The language an account's e-mail is written in (P2-28 part 4c-3;
-- src/account-emails.ts, EMAIL_LOCALES): the one the account's request was
-- in when it verified the address, which its moderation notices use, since
-- the timer that sends them has no request to take one from
-- (src/account-notices.ts). Codes and the notices for a held address take
-- the language of the request that asked for them, and keep nothing.
--
-- T-10: the account class, as the rest of the row. T-73: the provider
-- learns the language from the text anyway; the row adds nothing it
-- doesn't. Addresses verified before this migration read English, as they
-- were sent until now. A constant default adds the column without
-- rewriting the table.
ALTER TABLE account_emails
  ADD COLUMN locale text NOT NULL DEFAULT 'en-US' CHECK (locale IN ('en-US', 'es-US'));
