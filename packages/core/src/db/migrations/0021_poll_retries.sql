-- Rule 10's retry and the setup deadlines ([[0032-poll-creation-operations]],
-- rules 10 and 14; P2-22 part 5d; src/poll-stubs.ts and src/poll-opening.ts):
-- a poll whose registration can no longer land before its stub's `opens_at`
-- gets a new stub for the same election identifier, up to STUBS_PER_POLL,
-- and fails `ceremony-timeout` after the last; a registered poll that is
-- still not open when its `closes_at` passes fails `open-timeout`. Both go
-- back to the author with the stub they failed with.
ALTER TABLE account_polls
  DROP CONSTRAINT account_polls_failure_check,
  ADD CONSTRAINT account_polls_failure_check CHECK (
    failure IN (
      'closes-too-soon', 'creation-reverted', 'creation-replaced', 'creation-timeout',
      'creation-anchored', 'tier-unavailable', 'electorate-empty', 'stub-refused',
      'registration-refused', 'registration-reverted', 'registration-replaced',
      'registration-timeout', 'registration-mismatch', 'open-mismatch', 'ceremony-timeout',
      'open-timeout'
    )
  );
