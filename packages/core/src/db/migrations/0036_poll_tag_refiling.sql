-- Moderation's refiling of a poll's listing tags ([[0041-poll-topics-and-places]];
-- P2-26 part 1c-2; src/poll-tags.ts, refilePoll): a moderator may change a
-- poll's topic, or change or clear its place, without taking the poll down
-- (T-68). Each refiling is a row of poll_tag_actions, numbered from the poll
-- log's own sequence under the same lock (src/moderation.ts, lockModeration),
-- so the poll, profile and refiling logs read as one log in commit order.
--
-- A row records the tags the poll was refiled under, never the ones it
-- replaces: a place cleared for personal data must not survive in the log.
--
-- Operational, like the rest of the moderation log and poll_tags: a wipe
-- loses them, never a result (T-53). The log names an election and two
-- tags, never an account, a ballot or anything a voter did (T-10).

-- A refiling may clear both tags. The row stays, empty, so the poll keeps
-- the filing moderation gave it: the opening step's write and the fill
-- (fillPollTags) both leave a poll with a row alone.
ALTER TABLE poll_tags DROP CONSTRAINT poll_tags_check;

CREATE TABLE poll_tag_actions (
  seq bigint PRIMARY KEY CHECK (seq >= 1),
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  topic text CHECK (topic ~ '^[a-z]{1,16}$'),
  place text CHECK (char_length(place) BETWEEN 1 AND 80),
  reason text NOT NULL CHECK (
    reason IN (
      'misfiled', 'illegal', 'personal-data', 'threat', 'harassment', 'spam', 'impersonation',
      'legal-notice'
    )
  ),
  moderator text NOT NULL CHECK (moderator ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  -- The database clock when the tooling recorded it, as for polls.
  decided_at timestamptz NOT NULL
);

CREATE INDEX poll_tag_actions_by_election ON poll_tag_actions (election_id, seq);

-- Every row takes the next number of the poll log's sequence, whatever the
-- insert says, as for profile_moderation_actions (0034).
CREATE FUNCTION poll_tag_actions_next_seq() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.seq := nextval('moderation_actions_seq_seq');
  RETURN NEW;
END
$$;

CREATE TRIGGER poll_tag_actions_next_seq
  BEFORE INSERT ON poll_tag_actions
  FOR EACH ROW EXECUTE FUNCTION poll_tag_actions_next_seq();

CREATE FUNCTION poll_tag_actions_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'poll_tag_actions is append-only: % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER poll_tag_actions_no_update_delete
  BEFORE UPDATE OR DELETE ON poll_tag_actions
  FOR EACH ROW EXECUTE FUNCTION poll_tag_actions_reject_change();

CREATE TRIGGER poll_tag_actions_no_truncate
  BEFORE TRUNCATE ON poll_tag_actions
  FOR EACH STATEMENT EXECUTE FUNCTION poll_tag_actions_reject_change();

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION poll_tag_actions_next_seq() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION poll_tag_actions_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON poll_tag_actions FROM PUBLIC;
REVOKE ALL ON FUNCTION poll_tag_actions_next_seq(), poll_tag_actions_reject_change() FROM PUBLIC;
GRANT SELECT, INSERT ON poll_tag_actions TO abolish_app;
-- The insert trigger draws the number as the inserting role (granted in 0034).
-- The tags themselves, so a refiling can change them; still no DELETE or
-- TRUNCATE, so a poll's row, once written, stays (above).
GRANT UPDATE (topic, place, place_key) ON poll_tags TO abolish_app;
