-- The browsers an account asked to be told by web push ([[P2-27]] part 4;
-- src/account-push.ts): each row is one browser's push endpoint, the URL its
-- push service gave it for our VAPID key. Pushes carry no payload, so the
-- browser's keys for message encryption (`p256dh`, `auth`) are never asked
-- for or kept. An endpoint belongs to one account at a time: subscribing it
-- for another account (the browser signed into another) moves it.
--
-- T-10: the account class. A row names an account, an endpoint and when it
-- was added, never a poll, a decision, a ballot, a nullifier, a receipt or
-- the fact of having answered; nothing on the ballot path reads it.
--
-- T-76: an endpoint is a URL a browser handed us, which our server then
-- calls. Only an endpoint on a known push service is stored
-- (`parsePushEndpoint`), and the check below keeps the scheme and length
-- even against a hand-written insert.
--
-- Operational: a wipe loses which browsers to push to, never a result; each
-- browser subscribes again from the account page.

CREATE TABLE account_push_subscriptions (
  endpoint text PRIMARY KEY CHECK (endpoint LIKE 'https://%' AND length(endpoint) <= 1024),
  user_id text NOT NULL REFERENCES account_users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL
);
CREATE INDEX account_push_subscriptions_user ON account_push_subscriptions (user_id, created_at);

REVOKE ALL ON account_push_subscriptions FROM PUBLIC;
-- Never updated: a moved endpoint is deleted and inserted again.
GRANT SELECT, INSERT, DELETE ON account_push_subscriptions TO abolish_app;
