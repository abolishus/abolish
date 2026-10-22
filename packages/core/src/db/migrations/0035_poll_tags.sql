-- A poll's listing tags ([[0041-poll-topics-and-places]]; P2-26 part 1c;
-- src/poll-tags.ts): the topic and place its author chose on the draft,
-- carried here when the poll opens, so the listing can filter by them. One
-- row per tagged poll, keyed by its election ID; an untagged poll has none.
--
-- Operational: the operator's claim, not the definition's (T-68), and a wipe
-- loses them but no result (T-53). The row names an election and two
-- strings, never an account, a ballot, a nullifier or anything a voter did
-- (T-10). No foreign key reaches election_definitions (no-join test: no key
-- touches a board table); the opening step writes the row only for a poll
-- whose definition it has read back.
--
-- `place_key` is the place as the listing matches it: NFKC, lower case,
-- single-spaced (placeKey), written beside the place by the code that stores
-- it, so a filter compares one indexed column.

CREATE TABLE poll_tags (
  election_id bytea PRIMARY KEY CHECK (octet_length(election_id) = 32),
  topic text CHECK (topic ~ '^[a-z]{1,16}$'),
  place text CHECK (char_length(place) BETWEEN 1 AND 80),
  place_key text CHECK (place_key <> ''),
  CHECK (topic IS NOT NULL OR place IS NOT NULL),
  CHECK ((place IS NULL) = (place_key IS NULL))
);
CREATE INDEX poll_tags_by_topic ON poll_tags (topic) WHERE topic IS NOT NULL;
CREATE INDEX poll_tags_by_place ON poll_tags (place_key) WHERE place_key IS NOT NULL;

REVOKE ALL ON poll_tags FROM PUBLIC;
-- No UPDATE or DELETE yet: a poll keeps the tags it was filed under until
-- moderation's refiling, which comes with its own log (P2-26 part 1c-2).
GRANT SELECT, INSERT ON poll_tags TO abolish_app;
