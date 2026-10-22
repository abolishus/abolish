-- Search over question text (P2-23 part 4; src/search.ts): each display
-- text's titles and questions in every translation, normalised (NFKC, lower
-- case) by the code that stores the text, so a query matches by substring
-- without decoding records. Written beside the display text from the record
-- @abolishus/crypto checked, so search finds only words a voter would be shown.
--
-- Operational, like display_texts: takedown-able text, never a result (T-17,
-- T-68), and a wipe changes no result (T-53). The foreign key deletes the row
-- with its display text, so a takedown leaves nothing of the text behind in
-- search. Both tables are operational, so the key joins nothing the no-join
-- rules forbid. A display text stored before this migration gets its row
-- from fillDisplayTextSearch, which the API's migrate step runs after the SQL.

CREATE TABLE display_text_search (
  election_id bytea PRIMARY KEY
    REFERENCES display_texts (election_id) ON DELETE CASCADE,
  search_text text NOT NULL
);

REVOKE ALL ON display_text_search FROM PUBLIC;
-- No UPDATE: the text a definition commits to never changes. No DELETE or
-- TRUNCATE: a row goes only with its display text, through the key, whose
-- cascade runs as the table's owner.
GRANT SELECT, INSERT ON display_text_search TO abolish_app;
