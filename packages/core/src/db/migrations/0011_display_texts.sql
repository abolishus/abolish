-- Display text (record 0x0009, docs/spec/display-text.md), as the API serves
-- it to the ballot client and our pages. One record per election, the one its
-- definition commits to: @abolishus/crypto checks the record against the
-- stored definition's commitment and the spec's rules before it is stored, and
-- every caller checks it again against the registered definition before
-- showing it (T-34, T-41). The record is pinned on IPFS and never on the
-- board, a chain or the archive; this table stands in for the pin where a
-- client can reach only our API (the ballot client's connect-src, T-43).
--
-- Operational data: display text can be taken down without touching any
-- result (docs/moderation-policy.md; T-17, T-68), so the app role may delete
-- a row, and a wipe changes no result (T-53). Moderation decides what is
-- served, not this table. No foreign key: operational tables never point at
-- board tables (the no-join test), so the definition is checked in code.

CREATE TABLE display_texts (
  election_id bytea PRIMARY KEY CHECK (octet_length(election_id) = 32),
  -- A complete record: type 0x0009, its version and then the rest, at most
  -- MAX_DISPLAY_TEXT bytes.
  display_text bytea NOT NULL CHECK (
    octet_length(display_text) BETWEEN 3 AND 4194304
    AND substring(display_text FROM 1 FOR 2) = '\x0009'
  )
);

REVOKE ALL ON display_texts FROM PUBLIC;
-- The text a definition commits to never changes, so no UPDATE; a takedown
-- deletes the row (P4-3's unpinning), and no TRUNCATE.
GRANT SELECT, INSERT, DELETE ON display_texts TO abolish_app;
