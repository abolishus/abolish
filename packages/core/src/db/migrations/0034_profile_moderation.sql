-- Moderation of creator profiles ([[0040-creator-profiles]], Moderation of
-- names; P2-27 part 1c; src/profile-moderation.ts). A profile is reported,
-- decided and appealed like a poll, under the same closed list of grounds
-- (docs/moderation-policy.md, Reasons), with one removal: `hide`, which
-- withholds the profile's name and polls from our pages and the poll pages'
-- "Asked by" until a `restore` (T-75). A hide leaves the author's polls
-- listed: their content is moderated as polls.
--
-- One log: a profile decision takes its sequence number from the poll log's
-- own sequence, under the same lock (src/moderation.ts, lockModeration), so
-- the two tables read as one append-only log in commit order and no number
-- names two decisions. The log names a profile by its public handle, never
-- its account: no foreign key leaves the account tables (T-10), and a
-- retired handle is never issued again (0033), so a handle in the log always
-- meant the one profile.
--
-- Operational, like the poll log and its reports: a wipe loses them and
-- every profile with them (0033), never a result. The appeals are account
-- class, as the polls' are (0014).

CREATE TABLE profile_moderation_actions (
  seq bigint PRIMARY KEY CHECK (seq >= 1),
  handle text NOT NULL CHECK (handle ~ '^[a-z2-7]{16}$'),
  action text NOT NULL CHECK (action IN ('hide', 'restore')),
  reason text NOT NULL CHECK (
    CASE action
      WHEN 'restore' THEN reason IN ('appeal-upheld', 'error', 'notice-withdrawn')
      ELSE reason IN (
        'illegal', 'personal-data', 'threat', 'harassment', 'spam', 'impersonation', 'legal-notice'
      )
    END
  ),
  moderator text NOT NULL CHECK (moderator ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  -- The database clock when the tooling recorded it, as for polls.
  decided_at timestamptz NOT NULL
);

CREATE INDEX profile_moderation_actions_by_handle ON profile_moderation_actions (handle, seq);

-- Every row takes the next number of the poll log's sequence, whatever the
-- insert says, as GENERATED ALWAYS does for the poll log itself.
CREATE FUNCTION profile_moderation_actions_next_seq() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.seq := nextval('moderation_actions_seq_seq');
  RETURN NEW;
END
$$;

CREATE TRIGGER profile_moderation_actions_next_seq
  BEFORE INSERT ON profile_moderation_actions
  FOR EACH ROW EXECUTE FUNCTION profile_moderation_actions_next_seq();

CREATE FUNCTION profile_moderation_actions_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'profile_moderation_actions is append-only: % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER profile_moderation_actions_no_update_delete
  BEFORE UPDATE OR DELETE ON profile_moderation_actions
  FOR EACH ROW EXECUTE FUNCTION profile_moderation_actions_reject_change();

CREATE TRIGGER profile_moderation_actions_no_truncate
  BEFORE TRUNCATE ON profile_moderation_actions
  FOR EACH STATEMENT EXECUTE FUNCTION profile_moderation_actions_reject_change();

-- Reports of profiles, counted as polls' are (0003): one row per handle and
-- ground, never the reporter or any text (T-10, T-11, T-17, T-52). No
-- foreign key reaches the account tables; the tooling checks the profile
-- exists before counting a report.
CREATE TABLE profile_reports (
  handle text NOT NULL CHECK (handle ~ '^[a-z2-7]{16}$'),
  reason text NOT NULL CHECK (
    reason IN (
      'illegal', 'personal-data', 'threat', 'harassment', 'spam', 'impersonation', 'legal-notice'
    )
  ),
  total bigint NOT NULL CHECK (total >= 1),
  pending bigint NOT NULL CHECK (pending >= 0 AND pending <= total),
  pending_since timestamptz CHECK ((pending = 0) = (pending_since IS NULL)),
  PRIMARY KEY (handle, reason)
);

CREATE INDEX profile_reports_queue ON profile_reports (pending_since, handle, reason)
  WHERE pending > 0;

-- One appeal per decision, by the profile's author, as 0014's for polls.
-- `decision_seq` is the appealed row of profile_moderation_actions (no
-- foreign key: that table is operational). Deleting the profile, or its
-- account, deletes its appeals.
CREATE TABLE account_profile_appeals (
  decision_seq bigint PRIMARY KEY CHECK (decision_seq >= 1),
  handle text NOT NULL REFERENCES account_profiles (handle) ON DELETE CASCADE,
  filed_at timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('upheld', 'rejected', 'superseded')),
  reviewer text CHECK (reviewer ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  reviewed_at timestamptz,
  CHECK ((outcome IS NULL) = (reviewer IS NULL) AND (outcome IS NULL) = (reviewed_at IS NULL))
);
CREATE INDEX account_profile_appeals_open ON account_profile_appeals (decision_seq)
  WHERE outcome IS NULL;
CREATE INDEX account_profile_appeals_handle ON account_profile_appeals (handle);

CREATE FUNCTION account_profile_appeals_review_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.outcome IS NOT NULL OR NEW.decision_seq IS DISTINCT FROM OLD.decision_seq
    OR NEW.handle IS DISTINCT FROM OLD.handle OR NEW.filed_at IS DISTINCT FROM OLD.filed_at THEN
    RAISE EXCEPTION 'account_profile_appeals: an appeal is reviewed once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER account_profile_appeals_review_once
  BEFORE UPDATE ON account_profile_appeals
  FOR EACH ROW EXECUTE FUNCTION account_profile_appeals_review_once();

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION profile_moderation_actions_next_seq() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION profile_moderation_actions_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION account_profile_appeals_review_once() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON profile_moderation_actions, profile_reports, account_profile_appeals FROM PUBLIC;
REVOKE ALL ON FUNCTION profile_moderation_actions_next_seq(),
  profile_moderation_actions_reject_change(), account_profile_appeals_review_once() FROM PUBLIC;
GRANT SELECT, INSERT ON profile_moderation_actions TO abolish_app;
-- The insert trigger draws the number as the inserting role.
GRANT USAGE ON SEQUENCE moderation_actions_seq_seq TO abolish_app;
-- UPDATE to count a report and to mark reports reviewed; no DELETE or
-- TRUNCATE, so the app can't make a profile's reports disappear.
GRANT SELECT, INSERT, UPDATE ON profile_reports TO abolish_app;
GRANT SELECT, INSERT, UPDATE (outcome, reviewer, reviewed_at) ON account_profile_appeals
  TO abolish_app;
