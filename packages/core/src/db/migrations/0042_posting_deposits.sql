-- The posting relay's deposits on L1 (docs/spec/posting-relay.md, Forced
-- through L1, Depositing and Pruning; ADR 0042, rule 5;
-- src/posting-deposits.ts): one row per L1 nonce of the posting key that a
-- deposit was signed at, kept until that nonce is settled at the L1's
-- finalized head and its posting's in-flight entry is gone.
--
-- The identity class, as the rest of the relay's record: a row names a
-- posting by `keccak256(posting)` and its election, never an account, an
-- address or a request, and a deposit is public on L1 once broadcast. It
-- holds no posting: the signed deposit carries the calldata, `m_i`
-- included, so `signed` is cleared once the posting's entry is deleted (its
-- bytes final, or its election's `t_D` past), and only what tends the nonce
-- (its hashes, fees, times and a signed cancellation) outlives it (T-18).
--
-- Operational: no verifier reads it, and a wipe changes no result. A wipe
-- forgets a pending deposit, which is then neither cancelled nor counted.
--
-- `nonce` is the key's L1 nonce; the key has at most one L1 transaction
-- pending, so this is also the order deposits were signed in. `landing_from`
-- is `T`, the timestamp of the L1 head the deposit was signed on, from which
-- its landing span and its cancellation are timed. `reserve` is what this
-- nonce counts in its election's spend until it is final: the most its
-- transactions can cost. `deposits` and `cancels` are the 32-byte hashes of
-- every deposit and cancellation signed at the nonce, concatenated in the
-- order signed; `signed` is the newest of them, a cancellation once
-- `cancels` isn't empty, and `max_fee` and `priority_fee` are its fees; a
-- deposit cleared from `signed` with its entry is cancelled on the next tend.
-- `settled_in` is the hash of the one of them in an L1 block at the latest
-- L1 head, `landed` whether it was a deposit whose receipt shows success,
-- `paid` what its receipt shows it cost and `settled_block` its block;
-- `final` once that block is at the L1's finalized head, when `paid` has
-- replaced `reserve` in the spend. A nonce the key's count is past at the
-- L1's finalized head with no receipt of these seen is settled final as
-- landed with `reserve` as what it paid, and no block.
CREATE TABLE posting_deposits (
  nonce bigint PRIMARY KEY CHECK (nonce >= 0),
  posting_key bytea NOT NULL CHECK (octet_length(posting_key) = 32),
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  l1_gas_limit bigint NOT NULL CHECK (l1_gas_limit > 0),
  landing_from bigint NOT NULL CHECK (landing_from >= 0),
  reserve numeric NOT NULL CHECK (reserve >= 0 AND reserve = trunc(reserve)),
  max_fee numeric NOT NULL CHECK (max_fee >= 0 AND max_fee = trunc(max_fee)),
  priority_fee numeric NOT NULL CHECK (
    priority_fee >= 0 AND priority_fee = trunc(priority_fee) AND priority_fee <= max_fee
  ),
  signed bytea CHECK (octet_length(signed) > 0),
  deposits bytea NOT NULL CHECK (
    octet_length(deposits) > 0 AND octet_length(deposits) % 32 = 0
  ),
  cancels bytea NOT NULL CHECK (octet_length(cancels) % 32 = 0),
  signed_at bigint NOT NULL CHECK (signed_at >= 0),
  broadcast_at bigint NOT NULL CHECK (broadcast_at >= 0),
  settled_in bytea CHECK (octet_length(settled_in) = 32),
  landed boolean,
  paid numeric CHECK (paid >= 0 AND paid = trunc(paid)),
  settled_block bigint CHECK (settled_block >= 0),
  final boolean NOT NULL DEFAULT false,
  -- A settled nonce says how; an unsettled one says nothing of it.
  CONSTRAINT posting_deposits_settled CHECK (
    (settled_in IS NULL AND landed IS NULL AND paid IS NULL AND settled_block IS NULL AND NOT final)
    OR (settled_in IS NOT NULL AND landed IS NOT NULL AND paid IS NOT NULL AND settled_block IS NOT NULL)
    OR (settled_in IS NULL AND landed AND paid = reserve AND settled_block IS NULL AND final)
  )
);
CREATE INDEX posting_deposits_posting ON posting_deposits (posting_key);

REVOKE ALL ON posting_deposits FROM PUBLIC;
-- UPDATE for a replacement, a cancellation and the settling; DELETE for
-- what is final.
GRANT SELECT, INSERT, UPDATE, DELETE ON posting_deposits TO abolish_app;
