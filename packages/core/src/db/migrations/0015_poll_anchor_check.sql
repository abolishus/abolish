-- The creator's per-slot check of a created poll's identifier
-- (docs/spec/contracts.md, Board anchor, Verification, Pre-creation anchors;
-- [[0032-poll-creation-operations]], rule 12; P2-22 part 3b-1;
-- src/poll-anchor-check.ts): the L1 origin its `ElectionCreated` event
-- names, which fixes its first segment, the finalized L1 block at which every
-- checkpoint word from that segment on was proven zero, and how many
-- identifiers the poll has abandoned because one wasn't.
--
-- T-10: still the account class, and none of these names a voter, a ballot
-- or anyone's participation: a public event's field, a public L1 block
-- number and a count.
--
-- Operational: a wipe loses the polls in setup, never a result (rule 16).

-- A poll created before this migration has no recorded origin, so its
-- identifier can't be checked: it is abandoned, and the creation step
-- creates another. An abandoned identifier gets no definition, so it holds
-- nothing; abandoning is always safe.
UPDATE account_polls
SET state = 'submitted', creator_address = NULL, create_tx_hash = NULL,
  election_id = NULL, created_block = NULL
WHERE state = 'created';

ALTER TABLE account_polls
  -- `l1OriginTimestamp` of the finalized `ElectionCreated` event.
  ADD COLUMN l1_origin_timestamp bigint CHECK (l1_origin_timestamp >= 0),
  -- The finalized L1 block whose state proved every checkpoint word from
  -- the first segment to the last period ended before it zero.
  ADD COLUMN anchors_checked_block bigint CHECK (anchors_checked_block >= 0),
  -- Identifiers abandoned for an anchor found at the check; the third fails
  -- the poll.
  ADD COLUMN abandoned_ids smallint NOT NULL DEFAULT 0 CHECK (abandoned_ids BETWEEN 0 AND 3),
  DROP CONSTRAINT account_polls_failure_check,
  ADD CONSTRAINT account_polls_failure_check CHECK (
    failure IN (
      'closes-too-soon', 'creation-reverted', 'creation-replaced', 'creation-timeout',
      'creation-anchored'
    )
  ),
  ADD CONSTRAINT account_polls_origin CHECK ((l1_origin_timestamp IS NULL) = (election_id IS NULL)),
  -- Nothing past `created` runs on an identifier that wasn't checked: a
  -- ceremony for one that a compelled quorum anchored ahead of its creation
  -- would make an election no verifier passes (T-69).
  ADD CONSTRAINT account_polls_anchors_checked CHECK (
    (anchors_checked_block IS NULL OR election_id IS NOT NULL)
    AND (anchors_checked_block IS NOT NULL OR state IN ('drafted', 'submitted', 'created', 'failed'))
  );
