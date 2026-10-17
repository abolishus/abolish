-- The opening step of a poll's setup ([[0032-poll-creation-operations]],
-- rules 12 to 14; P2-22 part 5c; src/poll-opening.ts): once the registry
-- sync has stored the registered definition, the worker compares it, field
-- by field, with the author's draft, boards the ceremony transcript as the
-- board's first entry and stores the display text, and the poll moves to
-- `open`. A definition that isn't the draft's fails the poll (T-34).
ALTER TABLE account_polls
  DROP CONSTRAINT account_polls_failure_check,
  ADD CONSTRAINT account_polls_failure_check CHECK (
    failure IN (
      'closes-too-soon', 'creation-reverted', 'creation-replaced', 'creation-timeout',
      'creation-anchored', 'tier-unavailable', 'electorate-empty', 'stub-refused',
      'registration-refused', 'registration-reverted', 'registration-replaced',
      'registration-timeout', 'registration-mismatch', 'open-mismatch'
    )
  );
