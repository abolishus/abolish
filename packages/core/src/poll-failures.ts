// Why a poll failed in setup, as the author is told ([[0032-poll-creation-operations]],
// rule 14; P2-22 part 5d-2). Each step writes a fixed code to the poll's
// `failure` column; apps/web words each one (`pollFailure_<code>` in its
// messages), never showing the code, a hash or an identifier. This module
// names the codes and which of them leave an election registered on chain,
// which decides whether the author can retry or discard the poll
// (src/poll-drafts.ts).

import type { CreationFailure } from "./poll-creation.ts";
import type { OpenFailure } from "./poll-opening.ts";
import type { RegistrationFailure } from "./poll-registration.ts";
import type { RootFailure } from "./poll-roots.ts";
import type { StubFailure } from "./poll-stubs.ts";

/** Every code a step writes, in the order the migrations' check lists them. */
export const POLL_FAILURES = [
  "closes-too-soon",
  "creation-reverted",
  "creation-replaced",
  "creation-timeout",
  "creation-anchored",
  "tier-unavailable",
  "electorate-empty",
  "stub-refused",
  "registration-refused",
  "registration-reverted",
  "registration-replaced",
  "registration-timeout",
  "registration-mismatch",
  "open-mismatch",
  "ceremony-timeout",
  "open-timeout",
] as const satisfies readonly (
  | CreationFailure
  | RootFailure
  | StubFailure
  | RegistrationFailure
  | OpenFailure
)[];
export type PollFailure = (typeof POLL_FAILURES)[number];

/**
 * The failures that leave the poll's identifier registered on chain: a
 * finalized `DefinitionRegistered` named another definition
 * (`registration-mismatch`), or the registry holds a definition that never
 * opened on our side (`open-mismatch`, `open-timeout`). Nothing can
 * unregister it, so the registry's election stays public, is listed once
 * the registry sync stores it, and can be moderated: the poll's row is its
 * creator record (rule 15), which moderation's own-poll check and the
 * author's appeals need (T-68). Such a poll is neither retried (a new stub
 * can't register under a registered identifier, rule 10) nor discarded; the
 * author can start a new draft from its text.
 */
export const REGISTERED_FAILURES: readonly PollFailure[] = [
  "registration-mismatch",
  "open-mismatch",
  "open-timeout",
];

/** Whether the author can retry or discard a poll that failed with `failure`. */
export const retryableFailure = (failure: PollFailure): boolean =>
  !REGISTERED_FAILURES.includes(failure);
