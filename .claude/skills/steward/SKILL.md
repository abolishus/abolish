---
name: steward
description: Repo-specific conventions for driving Abolish PRs to merge — auto-merge, required checks, review findings, flakes, blocked PRs. Load when opening a PR or handling CI/review events on one.
---

# steward

## Opening

- Title in conventional-commit style. The body covers: what changed, threats addressed (IDs), tests, known-weak and, for protocol packages, "Independent review" (see `crypto-review`).
- Open as a **draft** and iterate there; the review models don't run on drafts, and both review checks fail until the PR is marked ready. Mark it ready once, when it's complete and your own review pass is clean, then enable **auto-merge (squash)**. Subscribe to PR activity. Exception: `ci:` PRs (anything under `.github/`) wait for the owner's review, so leave auto-merge off.
- On a ready PR, batch fixes: every push cancels and restarts the reviews.
- Never have more than 2 open PRs.
- Every PR targets `main`. Stacked PRs aren't supported: each required check fails on a PR into any other branch, because retargeting a base doesn't re-run checks.

## Required checks

`ci`, `reference-election`, `repro-build`, `claude-review` and `crypto-review`. Any red required check is yours to fix before starting new work.

- **`claude-review` / `crypto-review` blocking finding:** fix it, or, if it is wrong, rebut it as described under "Never re-roll a review" below. A re-run is the reviewer's to judge; pushing a fix re-triggers it. Never edit `.github/review/*` to get a pass.
- **`repro-build` mismatch:** find the nondeterminism (timestamps, ordering, absolute paths). Never relax the comparison.
- **`ci` supply-chain failure:** a young or mismatched package means you pick an older version or drop the dependency. Never weaken the policy.
- **Flakes:** "flake" is not a root cause. Re-run at most once, and only for infrastructure deaths (checkout, install, runner loss). Make flaky tests deterministic. Never skip, disable or quarantine a test.

## Never re-roll a review

The review checks are stochastic, so re-running them until one passes defeats them.

- A blocking finding is cleared only by a change that addresses it (touching the cited lines isn't enough), or by the owner. Later runs never see the thread, so a rebuttal can't be "accepted" by one, and a later run that happens not to flag it again is a re-roll.
- To rebut instead of fixing: reply on the thread with the concrete reason, disable auto-merge (for example with the GitHub `disable_pr_auto_merge` tool) and leave the PR for the owner. A later green run doesn't clear the finding.
- Never re-trigger a review with an empty or unrelated push, a close and reopen, or a duplicate PR.
- If a run passes code that an earlier run failed, and that code hasn't changed, treat it as failed until the owner decides: disable auto-merge and say so on the PR.

## Attempts and blocking

An attempt is a pushed fix that still leaves a required check red. After **3 failed attempts** on one PR, add the `blocked` label, record the check, the error and what you tried under **Blocked** in `docs/STATUS.md` (in your next PR), and move on.

## Decisions

When a one-way-door question comes up mid-PR, stop that part. Write the ADR as its own PR labelled `needs-decision`, and continue with whatever doesn't depend on it.

## Merged

When the PR merges, unsubscribe and update STATUS.md in your next PR if this one didn't already.
