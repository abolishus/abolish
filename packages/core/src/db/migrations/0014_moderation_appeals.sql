-- Moderators' accounts and creators' appeals (docs/moderation-policy.md,
-- Appeals and Moderators; P2-10 part 3b; src/appeals.ts). Two rules need to
-- know who a moderator is: a moderator doesn't decide on a poll they created,
-- and an appeal goes to a different moderator from the one who decided.
--
-- T-10: both tables are in the account class. Their only foreign keys are to
-- account_users and account_polls, and nothing here names a voter, a ballot,
-- a nullifier, a receipt or anyone's participation. A moderator's handle in
-- the moderation log names its account here, so whoever reads both learns
-- which account made a decision; the public log still omits the handle.
--
-- Operational: a wipe loses who moderates and the appeals, never a result.

-- One handle per moderator's account. A handle is never rebound: retiring
-- one (or deleting its account) clears `user_id` for good, so a handle in the
-- log always meant the one account, and the appeal rule compares handles.
CREATE TABLE account_moderators (
  handle text PRIMARY KEY CHECK (handle ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  user_id text UNIQUE REFERENCES account_users (id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL
);

CREATE FUNCTION account_moderators_retire_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.handle IS DISTINCT FROM OLD.handle OR NEW.added_at IS DISTINCT FROM OLD.added_at
    OR NEW.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'account_moderators: a handle can only be retired'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

-- Fires for every role, the table owner included, and for ON DELETE SET NULL.
CREATE TRIGGER account_moderators_retire_only
  BEFORE UPDATE ON account_moderators
  FOR EACH ROW EXECUTE FUNCTION account_moderators_retire_only();

-- One appeal per decision, by the poll's creator. `decision_seq` is the
-- appealed row of moderation_actions (no foreign key: that table is
-- operational, and none leaves the account tables). An appeal is open until
-- a moderator records its outcome, after which it never changes.
CREATE TABLE account_appeals (
  decision_seq bigint PRIMARY KEY CHECK (decision_seq >= 1),
  poll_id text NOT NULL REFERENCES account_polls (id) ON DELETE CASCADE,
  filed_at timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('upheld', 'rejected', 'superseded')),
  reviewer text CHECK (reviewer ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  reviewed_at timestamptz,
  CHECK ((outcome IS NULL) = (reviewer IS NULL) AND (outcome IS NULL) = (reviewed_at IS NULL))
);
CREATE INDEX account_appeals_open ON account_appeals (filed_at, decision_seq)
  WHERE outcome IS NULL;
CREATE INDEX account_appeals_poll_id ON account_appeals (poll_id);

CREATE FUNCTION account_appeals_review_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.outcome IS NOT NULL OR NEW.decision_seq IS DISTINCT FROM OLD.decision_seq
    OR NEW.poll_id IS DISTINCT FROM OLD.poll_id OR NEW.filed_at IS DISTINCT FROM OLD.filed_at THEN
    RAISE EXCEPTION 'account_appeals: an appeal is reviewed once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER account_appeals_review_once
  BEFORE UPDATE ON account_appeals
  FOR EACH ROW EXECUTE FUNCTION account_appeals_review_once();

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION account_moderators_retire_only() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION account_appeals_review_once() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON account_moderators, account_appeals FROM PUBLIC;
REVOKE ALL ON FUNCTION account_moderators_retire_only(), account_appeals_review_once() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE (user_id) ON account_moderators TO abolish_app;
GRANT SELECT, INSERT, UPDATE (outcome, reviewer, reviewed_at) ON account_appeals TO abolish_app;
