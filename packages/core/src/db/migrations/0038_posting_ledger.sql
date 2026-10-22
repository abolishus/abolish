-- The posting relay's durable record (docs/spec/posting-relay.md, Sending,
-- steps 2, 5 and 6, Caps and In flight; ADR 0042, rules 4 and 5;
-- src/posting-ledger.ts): what the posting worker sent, the ballot hashes it
-- paid for under each election and (`tier`, `ν`), each election's spend, and
-- each sent posting until the chain holds it or never can.
--
-- The identity class, on the ballot side of the no-join rules: these name
-- ballot hashes, nullifiers and postings, never an account, an address or a
-- request. Everything here but which postings the relay paid for is public on
-- the chain once sent, and the payer's address shows that (Caps; T-13).
-- `posting_in_flight` holds the posting itself, `m_i` included, the only
-- place it outlives the request (In flight; T-18), and only until it is final
-- or can never be in time.
--
-- Operational: no verifier reads any of it, and a wipe changes no result. A
-- wipe forgets what was sent, so the relay could pay for a posting a second
-- time, at most once per posting it already paid for (Caps, Bytes).
-- Every row carries `delivery_ends` (`t_D`), after which the spec deletes it
-- once the L2's finalized head passes it.

-- Caps, Bytes: a posting is paid for at most once. `transaction` is the last
-- transaction that carried it, an L2 call or, once forced, the L1 deposit.
CREATE TABLE posting_sent (
  posting_key bytea PRIMARY KEY CHECK (octet_length(posting_key) = 32),
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  transaction bytea NOT NULL CHECK (octet_length(transaction) = 32),
  layer text NOT NULL CHECK (layer IN ('l2', 'l1')),
  delivery_ends bigint NOT NULL CHECK (delivery_ends >= 0)
);

-- Caps, Ballots: at most POSTING_BALLOT_CAP ballot hashes per election and
-- (`tier`, `ν`). `nullifier` is `ν` as 32 big-endian bytes.
CREATE TABLE posting_ballots (
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  tier smallint NOT NULL CHECK (tier BETWEEN 0 AND 255),
  nullifier bytea NOT NULL CHECK (octet_length(nullifier) = 32),
  ballot_hash bytea NOT NULL CHECK (octet_length(ballot_hash) = 32),
  delivery_ends bigint NOT NULL CHECK (delivery_ends >= 0),
  PRIMARY KEY (election_id, tier, nullifier, ballot_hash)
);

-- Caps, Spend: the most each election's postings may yet cost, in wei, which
-- the receipts later reduce to what they show.
CREATE TABLE posting_spend (
  election_id bytea PRIMARY KEY CHECK (octet_length(election_id) = 32),
  spent numeric NOT NULL CHECK (spent >= 0 AND spent = trunc(spent)),
  delivery_ends bigint NOT NULL CHECK (delivery_ends >= 0)
);

-- In flight: each sent posting with its calldata, election and windows
-- (`c_I`, `c_D`, `t_D`), when it was first sent, the nonce and fees of its
-- latest transaction with that transaction's signed bytes for rebroadcasts,
-- every transaction that carried it (32-byte hashes, concatenated in order),
-- its gas limit `g` and the most cost added to its election's spend. Its
-- `posting_key` is always in `posting_sent` too, written in the same
-- transaction; no foreign key ties them, as none may touch this class.
CREATE TABLE posting_in_flight (
  posting_key bytea PRIMARY KEY CHECK (octet_length(posting_key) = 32),
  posting bytea NOT NULL,
  ballot bytea NOT NULL,
  election_id bytea NOT NULL CHECK (octet_length(election_id) = 32),
  intake_cutoff bigint NOT NULL CHECK (intake_cutoff >= 0),
  contract_cutoff bigint NOT NULL CHECK (contract_cutoff >= 0),
  delivery_ends bigint NOT NULL CHECK (delivery_ends >= 0),
  first_sent bigint NOT NULL CHECK (first_sent >= 0),
  nonce bigint NOT NULL CHECK (nonce >= 0),
  gas_limit bigint NOT NULL CHECK (gas_limit > 0),
  max_fee numeric NOT NULL CHECK (max_fee >= 0 AND max_fee = trunc(max_fee)),
  priority_fee numeric NOT NULL CHECK (
    priority_fee >= 0 AND priority_fee = trunc(priority_fee) AND priority_fee <= max_fee
  ),
  cost numeric NOT NULL CHECK (cost >= 0 AND cost = trunc(cost)),
  signed bytea NOT NULL,
  transactions bytea NOT NULL CHECK (
    octet_length(transactions) > 0 AND octet_length(transactions) % 32 = 0
  )
);
-- Two of the key's transactions never share a nonce while both are in flight.
CREATE UNIQUE INDEX posting_in_flight_nonce ON posting_in_flight (nonce);

REVOKE ALL ON posting_sent, posting_ballots, posting_spend, posting_in_flight FROM PUBLIC;
-- UPDATE for a forced posting's deposit, the spend the receipts reduce and a
-- replaced transaction; DELETE for what is final.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON posting_sent, posting_ballots, posting_spend, posting_in_flight TO abolish_app;
