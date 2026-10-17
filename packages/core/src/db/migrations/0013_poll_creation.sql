-- The creation step of a poll's setup ([[0032-poll-creation-operations]],
-- rules 4, 12, 15 and 18; P2-22 part 3a; src/poll-creation.ts): the creation
-- key's `createElection()` transactions, each recorded before it is sent,
-- and on the creator record, which one is its poll's and the election
-- identifier its finalized `ElectionCreated` event gave.

-- The key's sent transactions, one per nonce, kept whatever becomes of the
-- poll or its author's account: the daily ceiling counts them (rule 18), so
-- deleting an account can't free a slot, and a run sends every one the node
-- hasn't included, so deleting one can't leave a gap in the key's nonces
-- that holds every later creation.
--
-- T-10: operational. It holds only the key's public transactions, never an
-- account, a poll or an election, and nothing references it by key.
CREATE TABLE poll_creation_txs (
  creator_address bytea NOT NULL CHECK (octet_length(creator_address) = 20),
  nonce bigint NOT NULL CHECK (nonce >= 0),
  -- The signed bytes, so a rerun sends the same transaction again rather
  -- than sign a second creation (rule 12). Public once sent.
  tx bytea NOT NULL CHECK (octet_length(tx) BETWEEN 1 AND 1024),
  tx_hash bytea NOT NULL UNIQUE CHECK (octet_length(tx_hash) = 32),
  sent_at timestamptz NOT NULL,
  PRIMARY KEY (creator_address, nonce)
);
CREATE INDEX poll_creation_txs_sent_at ON poll_creation_txs (sent_at);

REVOKE ALL ON poll_creation_txs FROM PUBLIC;
-- Append-only: a recorded transaction may already be on its way.
GRANT SELECT, INSERT ON poll_creation_txs TO abolish_app;

-- T-10: still the account class. `election_id` is rule 15's creator record,
-- whose poll an election is, which P2-10's appeals need; it names the
-- author's own election, never a voter, a ballot, a nullifier or anyone's
-- participation, and the no-join test allows exactly this column.
--
-- Operational: a wipe loses the polls in setup, never a result (rule 16).
ALTER TABLE account_polls
  -- The creation key that signed, and so the only one that can register
  -- (rule 4), and its transaction in poll_creation_txs.
  ADD COLUMN creator_address bytea CHECK (octet_length(creator_address) = 20),
  ADD COLUMN create_tx_hash bytea UNIQUE CHECK (octet_length(create_tx_hash) = 32),
  ADD COLUMN election_id bytea UNIQUE CHECK (octet_length(election_id) = 32),
  -- The L2 block holding the finalized `ElectionCreated` event.
  ADD COLUMN created_block bigint CHECK (created_block >= 0),
  -- Why a poll failed, as a fixed code the website words (rule 14).
  ADD COLUMN failure text CHECK (
    failure IN ('closes-too-soon', 'creation-reverted', 'creation-replaced', 'creation-timeout')
  ),
  -- A creation is never a draft's: a retry that returns a poll to its
  -- author must clear it, or the old transaction's election could become
  -- the new draft's.
  ADD CONSTRAINT account_polls_creation CHECK (
    (creator_address IS NULL) = (create_tx_hash IS NULL)
    AND (creator_address IS NULL OR state <> 'drafted')
    AND (creator_address IS NOT NULL OR state IN ('drafted', 'submitted', 'failed'))
  ),
  ADD CONSTRAINT account_polls_created CHECK (
    (election_id IS NULL) = (created_block IS NULL)
    AND (election_id IS NULL OR creator_address IS NOT NULL)
    AND (election_id IS NOT NULL OR state IN ('drafted', 'submitted', 'failed'))
  ),
  ADD CONSTRAINT account_polls_failure CHECK ((failure IS NOT NULL) = (state = 'failed'));
