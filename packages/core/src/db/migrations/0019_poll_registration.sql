-- The registration step of a poll's setup ([[0032-poll-creation-operations]],
-- rules 4, 12 and 14; P2-22 part 5a; src/poll-registration.ts): once a
-- poll's ceremony is approved, the creation key records and sends the
-- ceremony's registration with the trustee registry and the definition's
-- with the election registry, and the poll moves to `registered` once the
-- `DefinitionRegistered` event is in finalized L2 history.

-- The key's registrations share its ledger with its creations: they spend
-- the same nonces, so a run that signs either computes the next nonce from
-- every recorded transaction, and a run sends every one the node hasn't
-- included, whichever step recorded it. `kind` says which call it is, so
-- the daily ceiling of rule 18 counts creations only. A definition with its
-- questions is far larger than a creation; 128 KiB is what an L2 node's
-- transaction pool takes.
ALTER TABLE poll_creation_txs
  ADD COLUMN kind text NOT NULL DEFAULT 'create'
    CHECK (kind IN ('create', 'register-ceremony', 'register-definition')),
  DROP CONSTRAINT poll_creation_txs_tx_check,
  ADD CONSTRAINT poll_creation_txs_tx_check CHECK (octet_length(tx) BETWEEN 1 AND 131072);
ALTER TABLE poll_creation_txs ALTER COLUMN kind DROP DEFAULT;
CREATE INDEX poll_creation_txs_kind_sent_at ON poll_creation_txs (kind, sent_at);

-- T-10: still the account class. The two transactions are the creation
-- key's own, public once sent, and the block is the registry's; none names
-- a voter, a ballot, a nullifier or anyone's participation.
ALTER TABLE account_polls
  -- `registerCeremony` and `registerDefinition` for the poll's current
  -- stub, recorded together before either is sent (rule 12).
  ADD COLUMN ceremony_tx_hash bytea UNIQUE CHECK (octet_length(ceremony_tx_hash) = 32),
  ADD COLUMN register_tx_hash bytea UNIQUE CHECK (octet_length(register_tx_hash) = 32),
  -- The L2 block holding the finalized `DefinitionRegistered` event.
  ADD COLUMN registered_block bigint CHECK (registered_block >= 0),
  DROP CONSTRAINT account_polls_failure_check,
  ADD CONSTRAINT account_polls_failure_check CHECK (
    failure IN (
      'closes-too-soon', 'creation-reverted', 'creation-replaced', 'creation-timeout',
      'creation-anchored', 'tier-unavailable', 'electorate-empty', 'stub-refused',
      'registration-refused', 'registration-reverted', 'registration-replaced',
      'registration-timeout', 'registration-mismatch'
    )
  ),
  -- The registrations name the current stub, so only a state with one has
  -- them; `registered` and `open` have them and their block, `ceremony`
  -- never has the block. A failed poll keeps what it failed with; a retry
  -- under rule 10, which builds a new stub, must clear all three.
  ADD CONSTRAINT account_polls_registration CHECK (
    (ceremony_tx_hash IS NULL) = (register_tx_hash IS NULL)
    AND (register_tx_hash IS NULL OR stub_hash IS NOT NULL)
    AND (register_tx_hash IS NOT NULL OR state NOT IN ('registered', 'open'))
    AND (registered_block IS NULL OR register_tx_hash IS NOT NULL)
    AND (registered_block IS NOT NULL OR state NOT IN ('registered', 'open'))
    AND (registered_block IS NULL OR state IN ('registered', 'open', 'failed'))
  );
