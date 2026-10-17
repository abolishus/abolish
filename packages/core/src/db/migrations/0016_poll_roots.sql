-- The roots step of a poll's setup ([[0032-poll-creation-operations]],
-- rules 9, 12 and 14; P2-22 part 3b-2; src/poll-roots.ts): the electorate
-- the poll's definition will state, every tier's groups, region counts and
-- cells at one proven L2 block, recorded as the poll moves to `rooted`.
--
-- T-10: still the account class, and nothing here names a voter, a ballot
-- or anyone's participation: public group identifiers, counts and roots,
-- the same for every poll rooted at that block.
--
-- Operational: a wipe loses the polls in setup, never a result (rule 16).

ALTER TABLE account_polls
  -- The definition's `electorate`, integers as decimal strings
  -- (`StoredTierElectorate`). Bounded, as the draft is (T-52): three tiers
  -- of at most 1,024 groups and regions and 256 cells fit well within it.
  ADD COLUMN electorate jsonb CHECK (
    jsonb_typeof(electorate) = 'array' AND octet_length(electorate::text) <= 262144
  ),
  DROP CONSTRAINT account_polls_failure_check,
  ADD CONSTRAINT account_polls_failure_check CHECK (
    failure IN (
      'closes-too-soon', 'creation-reverted', 'creation-replaced', 'creation-timeout',
      'creation-anchored', 'tier-unavailable', 'electorate-empty'
    )
  ),
  -- Every state past `created` states its electorate, and none before it
  -- has one: an identifier abandoned at the per-slot check is never rooted,
  -- and a later retry from `failed` must clear it with the identifier.
  ADD CONSTRAINT account_polls_electorate CHECK (
    (electorate IS NULL OR anchors_checked_block IS NOT NULL)
    AND (electorate IS NOT NULL OR state IN ('drafted', 'submitted', 'created', 'failed'))
  );
