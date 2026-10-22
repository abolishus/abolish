-- The posting relay's in-flight entries as the worker tends them
-- (docs/spec/posting-relay.md, Sending, after step 6; src/posting-ledger.ts,
-- `tend`): when its latest transaction was signed, which a replacement waits
-- on, when it was last broadcast, which a rebroadcast waits on, and once a
-- transaction carrying it is in an L2 block at the latest head, that
-- transaction and what its receipt shows it cost, to which its election's
-- spend is reduced. `paid` without `landed_in` is a posting whose nonce
-- another transaction of the key consumed while the posting's event was on
-- the board: none of its transactions ran, so it cost nothing on L2.
--
-- The table is new and holds at most the postings in flight; each row's
-- first transaction was signed and broadcast when it was first sent.

ALTER TABLE posting_in_flight
  ADD COLUMN signed_at bigint CHECK (signed_at >= 0),
  ADD COLUMN broadcast_at bigint CHECK (broadcast_at >= 0),
  ADD COLUMN landed_in bytea CHECK (octet_length(landed_in) = 32),
  ADD COLUMN paid numeric CHECK (paid >= 0 AND paid = trunc(paid)),
  ADD CONSTRAINT posting_in_flight_landed_paid CHECK (landed_in IS NULL OR paid IS NOT NULL);

UPDATE posting_in_flight SET signed_at = first_sent, broadcast_at = first_sent;

ALTER TABLE posting_in_flight
  ALTER COLUMN signed_at SET NOT NULL,
  ALTER COLUMN broadcast_at SET NOT NULL;
