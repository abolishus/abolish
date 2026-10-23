-- The posting relay's in-flight entries as the worker tends them
-- (docs/spec/posting-relay.md, Sending, after step 6; src/posting-ledger.ts,
-- `tend`): when its latest transaction was signed, which a replacement waits
-- on, and when it was last broadcast, which a rebroadcast waits on; the
-- part of `cost` that is a deposit's L1 reserve, which stays counted until
-- the deposit is settled; and once transactions carrying it are in L2 blocks
-- at the latest head, those transactions (32-byte hashes, concatenated in
-- the order sent) and what their receipts show they cost on L2, to which its
-- election's spend is reduced, beside the reserve. `paid` without
-- `landed_in` is a posting whose nonce another transaction of the key
-- consumed while the posting's event was on the board: none of its
-- transactions ran, so it cost nothing on L2.
--
-- No deployment has run the posting worker (nothing implemented its chain),
-- so the table is empty wherever this runs; the backfill only makes the
-- columns well defined: a row's first transaction was signed and broadcast
-- when it was first sent, and its reserve is taken as none.

ALTER TABLE posting_in_flight
  ADD COLUMN signed_at bigint CHECK (signed_at >= 0),
  ADD COLUMN broadcast_at bigint CHECK (broadcast_at >= 0),
  ADD COLUMN deposit numeric CHECK (deposit >= 0 AND deposit = trunc(deposit) AND deposit <= cost),
  ADD COLUMN landed_in bytea CHECK (
    octet_length(landed_in) > 0 AND octet_length(landed_in) % 32 = 0
  ),
  ADD COLUMN paid numeric CHECK (paid >= 0 AND paid = trunc(paid)),
  ADD CONSTRAINT posting_in_flight_landed_paid CHECK (landed_in IS NULL OR paid IS NOT NULL);

UPDATE posting_in_flight SET signed_at = first_sent, broadcast_at = first_sent, deposit = 0;

ALTER TABLE posting_in_flight
  ALTER COLUMN signed_at SET NOT NULL,
  ALTER COLUMN broadcast_at SET NOT NULL,
  ALTER COLUMN deposit SET NOT NULL;
