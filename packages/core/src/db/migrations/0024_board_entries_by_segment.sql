-- Each board's entries by segment, for discovery's `answered` order, which
-- counts the voters whose ballots were boarded in the last week's segments
-- (P2-23 part 1b; src/listing.ts), and for takeCheckpoints, which reads a
-- board's segments past its last checkpoint. An index only: the table, its
-- grants and its append-only triggers are unchanged (T-23). Built inside the
-- migration's transaction, so appends wait while it builds; the board is
-- small enough at this stage for that to take moments.

CREATE INDEX board_entries_by_segment ON board_entries (election_id, segment);
