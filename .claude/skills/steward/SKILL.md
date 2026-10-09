---
name: steward
description: Repo-specific conventions for driving Abolish PRs to merge — auto-merge, required checks, review findings, flakes, blocked PRs. Load when opening a PR or handling CI/review events on one.
---

# steward

## Opening

- Title in conventional-commit style. The body covers: what changed, threats addressed (IDs), tests, known-weak and, for protocol packages, "Independent review" (see `crypto-review`).
- Enable **auto-merge (squash)** and subscribe to PR activity. Exception: `ci:` PRs (anything under `.github/`) wait for the owner's review, so leave auto-merge off.
- Never have more than 2 open PRs.

## Required checks

`ci`, `reference-election`, `repro-build`, `claude-review` and `crypto-review`. Any red required check is yours to fix before starting new work.

- **`claude-review` / `crypto-review` blocking finding:** fix it, or, if it is wrong, reply on the thread with the concrete reason it can't happen. A re-run is the reviewer's to judge; pushing a fix re-triggers it. Never edit `.github/review/*` to get a pass.
- **`repro-build` mismatch:** find the nondeterminism (timestamps, ordering, absolute paths). Never relax the comparison.
- **`ci` supply-chain failure:** a young or mismatched package means you pick an older version or drop the dependency. Never weaken the policy.
- **Flakes:** "flake" is not a root cause. Re-run at most once, and only for infrastructure deaths (checkout, install, runner loss). Make flaky tests deterministic. Never skip, disable or quarantine a test.

## Attempts and blocking

An attempt is a pushed fix that still leaves a required check red. After **3 failed attempts** on one PR, add the `blocked` label, record the check, the error and what you tried under **Blocked** in `docs/STATUS.md` (in your next PR), and move on.

## Decisions

When a one-way-door question comes up mid-PR, stop that part. Write the ADR as its own PR labelled `needs-decision`, and continue with whatever doesn't depend on it.

## Merged

When the PR merges, unsubscribe and update STATUS.md in your next PR if this one didn't already.
