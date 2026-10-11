-- The moderation log (docs/moderation-policy.md; T-68). Moderation acts on a
-- poll's display text and on whether our front ends list the poll, never on
-- its result: nothing here is read by the board, the tally or the verifier,
-- and no result depends on it. Each row is one decision about one election:
-- delist it (kept off discovery and search, text still shown by link), hide
-- its display text in our front ends, or restore it. An election's state is
-- its newest decision. The log is append-only, like the board, so a decision
-- is reversed by a later one, never edited away, and the public log keeps
-- every one (T-68: moderation used to suppress polls, then covered up).
--
-- Operational data: a wipe loses the log (every election goes back to
-- visible), and no result changes. No free text: a decision carries a reason
-- code, never a note, so the log can't carry personal data (T-17). The
-- moderator is an opaque handle, not an account: no foreign key leaves the
-- account tables, and the public log never names who decided (T-10).

CREATE TABLE moderation_actions (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  action text NOT NULL CHECK (action IN ('delist', 'hide', 'restore')),
  -- The policy's reason codes (docs/moderation-policy.md, Reasons): a removal
  -- cites a ground for removing, a restoration a ground for restoring.
  reason text NOT NULL CHECK (
    CASE action
      WHEN 'restore' THEN reason IN ('appeal-upheld', 'error', 'notice-withdrawn')
      ELSE reason IN (
        'illegal', 'personal-data', 'threat', 'harassment', 'spam', 'impersonation', 'legal-notice'
      )
    END
  ),
  moderator text NOT NULL CHECK (moderator ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  -- The database clock when the tooling recorded it (src/moderation.ts).
  decided_at timestamptz NOT NULL
);

CREATE INDEX moderation_actions_by_election ON moderation_actions (election_id, seq);

CREATE FUNCTION moderation_actions_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'moderation_actions is append-only: % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Fires for every role, the table owner included.
CREATE TRIGGER moderation_actions_no_update_delete
  BEFORE UPDATE OR DELETE ON moderation_actions
  FOR EACH ROW EXECUTE FUNCTION moderation_actions_reject_change();

CREATE TRIGGER moderation_actions_no_truncate
  BEFORE TRUNCATE ON moderation_actions
  FOR EACH STATEMENT EXECUTE FUNCTION moderation_actions_reject_change();

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION moderation_actions_reject_change() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON moderation_actions FROM PUBLIC;
REVOKE ALL ON FUNCTION moderation_actions_reject_change() FROM PUBLIC;
GRANT SELECT, INSERT ON moderation_actions TO abolish_app;
