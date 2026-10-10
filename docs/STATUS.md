# STATUS

The work queue, as an index. Each item's state, PR and notes live in its own file, `docs/status/<item-id>.md`, so parallel PRs don't conflict: a PR touches only its own item's file (and the threat files its change affects), plus the sections below when it changes them. Items are ordered within each phase: take the first unblocked one with no `claude/<item-id>` branch and no open PR. See [[PROJECT_BRIEF]] and the repo's `AGENTS.md`.

Last updated: 2026-10-10 (P0-ops: items split into `docs/status/`).

## Queue

Each item's state (`todo`, `in progress`, `blocked`, `needs owner decision`, `done`) is in its own file only, so starting or finishing an item never edits this index. Done as of 2026-10-10: P0-1, P0-3, P0-4, P1-1 to P1-6, P1-8, P1-9 and P1-16b.

### Phase 0: Bootstrap

- [[P0-1]] `ci: bootstrap`
- [[P0-2]] Storybook under Vite+
- [[P0-3]] `ci: release`
- [[P0-4]] Licenses

### Phase 1: Threat model, spec, crypto core, circuits, verifier, reference election (CLI only)

- [[P1-1]] Threat model
- [[P1-2]] ADR: canonical encoding
- [[P1-3]] ADR: everlasting privacy
- [[P1-4]] ADR: tally scheme
- [[P1-5]] ADR: L2 choice
- [[P1-6]] ADR: permanent archive
- [[P1-7]] ADR: trustees
- [[P1-8]] `docs/spec/` skeleton
- [[P1-9]] `packages/crypto` scaffold
- [[P1-10]] Canonical encoders and decoders
- [[P1-11]] Group and hash layer
- [[P1-12]] Ballot commitments and validity proofs
- [[P1-13]] Challenge/spoil, receipts and re-voting
- [[P1-14]] Trustee key registration
- [[P1-15]] Summed shares, tally and destruction
- [[P1-16]] Bulletin board model
- [[P1-16b]] `ci:` toolchain-consistency check
- [[P1-17]] `packages/circuits` scaffold
- [[P1-18]] `packages/contracts` scaffold
- [[P1-19]] `packages/verifier` CLI
- [[P1-20]] Reference election fixture
- [[P1-21]] Simulation surfaces in admin-cli and sdk
- [[P1-22]] Phase 1 exit

### Phase 2: Open polls end to end at Tier 0

- [[P2-1]] `packages/core` and Drizzle schema
- [[P2-2]] `packages/api-contract`
- [[P2-3]] `apps/api`
- [[P2-4]] `apps/worker`
- [[P2-5]] Accounts
- [[P2-6]] Voting identity
- [[P2-7]] `packages/ui`
- [[P2-8]] `apps/ballot`
- [[P2-9]] `apps/web`
- [[P2-10]] Moderation
- [[P2-11]] `ci: deploy`
- [[P2-12]] Phase 2 exit

### Phase 3: Tier 2 ZK identity, Semaphore groups, indexer, per-tier results

- [[P3-1]] ADR: Tier 2 identity provider
- [[P3-2]] Semaphore groups per tier
- [[P3-3]] Tier 1 vouching
- [[P3-4]] Tier 2 QR handoff
- [[P3-5]] `apps/indexer`
- [[P3-6]] Per-tier results

### Phase 4: Censorship resistance

- [[P4-1]] Hourly L1 anchoring
- [[P4-2]] Direct submit end to end
- [[P4-3]] IPFS mirroring and permanent archive
- [[P4-4]] ENS and second domain
- [[P4-5]] `apps/node`
- [[P4-6]] Verifier from chain and IPFS only

### Phase 5: US civic referendums and native app

- [[P5-1]] Referendum templates
- [[P5-2]] Capacitor shell
- [[P5-3]] `packages/capacitor-nfc-passport`
- [[P5-4]] `packages/capacitor-zk-prover`

One-off items: [[P0-ops]] split shared hot files.

## Blocked

- **P0-2 Storybook under Vite+: blocked on the supply-chain trust policy (owner decision).** Storybook 10.6.1 itself is old enough and resolves, but `@storybook/react-vite` depends on `react-docgen` 8 → `@babel/core` 7 → `semver@^6.3.1`, and `vp add` fails with `High-risk trust downgrade for "semver@6.3.1"` from `trustPolicy: no-downgrade` in `pnpm-workspace.yaml`. Registry metadata shows it is a false positive: `semver@6.3.1` (and `5.7.2`) are July 2023 security backports published by an npm maintainer without provenance, after `7.5.1`–`7.5.4` had been published with provenance. No newer 6.x exists, and `react-docgen` has no Babel-8 release. Storybook wasn't run, so whether it works under Vite+ beyond install is still unknown. Workaround (needs the owner, because it relaxes a supply-chain setting in a CODEOWNERS file): add `trustPolicyExclude: [semver@6.3.1]` to `pnpm-workspace.yaml` with a comment giving this reason. Versions picked for the retry: `storybook`, `@storybook/react-vite`, `@storybook/addon-vitest` and `@storybook/addon-a11y` 10.6.1, `@vitest/browser-playwright` 5.0.1 (matches Vite+'s bundled Vitest), `playwright` 1.63.0 (1.64.0 is under 7 days old), React 19.3.0. P2-7 (`packages/ui`) depends on this.

- **P1-12 ballot commitments and validity proofs: blocked on three owner questions** from [[0002-everlasting-privacy]] (trustee duties, the `@noble/post-quantum` audit, and the wording of the brief's threshold-trust property). See [[P1-12]].

## Decisions to review

Decisions the agent made under rule A (`AGENTS.md`). Each stands unless the owner vetoes it; a veto is recorded in the ADR and the item's file.

- [[0001-canonical-encoding]] (P1-2, #6): explicit byte layouts.
- [[0003-tally-scheme]] (P1-4, #9): homomorphic tally for plurality and approval; a mixnet only for ranked choice, by a later ADR.
- [[0004-l2-choice]] (P1-5, #10): Base, for development and testnet. Mainnet stays with the owner.
- [[0005-permanent-archive]] (P1-6, #11–#14): Arweave plus IPFS pinning. The first real upload spends money, so it waits for the owner.

These four ADRs still read `Status: needs-decision`; a follow-up docs PR marks each `Accepted (agent) — owner may veto`.

Waiting on the owner (owner-only under rule A): [[0006-trustees]] (P1-7: naming trustees), and P1-12's three questions above.

## Known-weak

- **CI pulls service images with a repository-level Docker Hub token** (#19). `DOCKERHUB_TOKEN` is read-only, and any workflow run from an in-repo branch can read it (T-65). If the token is revoked or expires, every service-container start fails with `unauthorized`. The fix is for the owner to rotate the secret, or to switch back to the ECR Public mirror (#17). Fork PRs get no secrets, so they pull anonymously.
- **`reference-election` check is a placeholder.** It passes with a warning until P1-20 adds the root `reference-election` script and sets the workflow's `EXPECT_FIXTURE` flag, so it proves nothing yet.
- **`repro-build` has nothing to compare yet.** The only build today (`.github/tools/ci`) type-checks without emitting output. The check hashes every file a build creates, rejects any build that modifies a tracked file, and requires each package to declare its outputs, so it becomes meaningful as soon as a package emits output.
- **The review workflows haven't run yet.** Two settings are unverified until the first real run: `allowed_bots: claude` (the identity Claude's PRs come from) and `--effort max` in claude-code-action. Fix in a `ci:` PR if the first run fails for either reason.
- **External (fork) PRs can't pass `claude-review` or `crypto-review`,** because forks get no secrets. A maintainer must re-open them from an in-repo branch.
- **Lockfile "review" is mechanical plus AI review,** not human review. CI enforces registry-only resolution, integrity matching the registry, and ≥ 7 days' age; `claude-review` must justify every added package. There is no human sign-off on dependency changes unless the owner adds one.
- **Non-`.github/` changes merge on CI plus model review alone.** All gate code (workflows, review prompts, `.github/tools/ci` policy code, `.github/scripts/install-toolchain.sh` pins and hashes) lives under `.github/`, which CODEOWNERS routes to the owner, so a PR can't weaken the checks that judge it. Everything else auto-merges once CI, `claude-review` and (for protocol packages, `docs/spec/` and agent instruction files) `crypto-review` pass, with no human in the loop.
- **CODEOWNERS binds only if the `main` ruleset has "Require review from Code Owners" enabled,** which agents can't verify. Since #2 it covers `/.github/`, `/.claude/`, `/AGENTS.md`, `/CLAUDE.md`, `/docs/PROJECT_BRIEF.md`, `/pnpm-workspace.yaml`, `/vite.config.ts` and `/tsconfig.base.json`. Still not covered: `/docs/THREAT_MODEL.md` and `/docs/adr/` (instruction sources per AGENTS.md), `/pnpm-lock.yaml` and the root `/package.json`. A PR that edits those is judged only by the two model reviews (CI's lockfile policy still enforces package age and integrity). Requested from the owner: add them, and enable code-owner review.
- **Two concurrently reviewed PRs can merge into a combination no review saw.** Checks are recorded against the base each PR was reviewed on, and the review jobs skip `merge_group`. Requested from the owner: enable "Require branches to be up to date before merging" and "Require conversation resolution before merging" on `main` (the reviews post an inline thread per blocking finding), so the second PR is rebased and re-reviewed on the combined tree.
- **`crypto-review` covers only the protocol packages, `docs/spec/` and agent instruction files** (the brief's scope, kept narrow so each run finishes). Changes to `packages/core`, `packages/sdk`, both Capacitor plugins, `apps/ballot`, ADRs, the threat model, STATUS, the brief and the build config get `claude-review` plus the in-session subagent review only. CI pins the brief verbatim; until the owner adds ADRs and the threat model to CODEOWNERS, nothing but `claude-review` stands between a weakening edit there and `main`.
- **Review workflow bodies run from the PR head.** The review prompts and verdict script are read from the base commit, but GitHub runs the workflow file itself from the PR, so a PR that edits `claude-review.yml` or `crypto-review.yml` could weaken its own gate. Only owner review of `/.github/` (CODEOWNERS plus code-owner review) closes this.
- **The review model's file access is limited by a deny-list.** It has no shell and can't read `/proc`, `/etc`, the runner's temp and tool directories or its home configuration, but anything else readable on the runner outside those paths isn't explicitly blocked. The job holds the review token and a `pull-requests: write` GitHub token; the verdict is decided in a separate job the model never touches.
- **Toolchain hashes are trust-on-first-use.** The sha256 pins in `.github/scripts/install-toolchain.sh` were recorded from the upstream GitHub releases on 2026-10-09; nothing cross-checks them against upstream attestations, and `repro-build` can't detect a deterministic malicious binary because both builds use the same one.
- **Merge queue:** the review checks skip `merge_group`. If the owner enables a merge queue, it must use batch size 1, or the combined tree of a batch is never model-reviewed.
- **Lockfile policy covers `packages:` only.** It checks which bytes can be installed; rewiring a `snapshots:` edge to another version already in `packages:` isn't checked. `crypto-review` doesn't run on lockfile or catalog changes (the brief scopes it to the four protocol packages). CI rejects overrides, patches and package extensions, but a catalog bump of `@noble/*` or `@aztec/bb.js`, or a rewired edge, is seen only by `claude-review` and owner review. P1-9's closure check (#18) keeps the gated packages' closure `@noble/*`-only but doesn't judge a version bump; P1-16b (#20) ties the `@aztec/bb.js` and `@noir-lang/*` pins to the toolchain.
- **Required checks and auto-merge depend on repo rulesets** that agents may not change. The owner must mark `ci`, `reference-election`, `repro-build`, `claude-review` and `crypto-review` as required on `main`.
- **Publishing is only as safe as the `npm` environment's branch policy.** npm trusted publishing binds to the repository, workflow file name and environment, not to a branch. Anyone who can push a branch (including an agent) could run a modified `release.yml` there and publish anything, bypassing every in-workflow check. Must hold **before** the trusted publisher is configured on npm: the `npm` environment allows deployments from `main` only (ideally with the owner as required reviewer). Agents can't verify this setting. Requested from the owner.
- **`release.yml` is unexercised** until the first changeset merges after #4. It needs, from the owner: the three packages existing on npm (a first publish sets `latest`) with a trusted publisher for `abolishus/abolish`, workflow `release.yml`, environment `npm`. Unverified until then: `vp node` running the npm CLI in a sparse checkout, and npm's OIDC exchange.
- **Jobs in one release run share its runner token.** Code run by Changesets or by a package build can upload and delete artifacts in the run and write Actions cache entries on `main`. So nothing trusts an artifact on its own: `verify` requires each tarball to match the hash its own build job output (job outputs can't be written by other jobs) and fails on any other `tgz-*` artifact, and `sign` and `publish` check the release against `verify`'s manifest output. Tampering with artifacts can only fail the run (denial of service). A re-run of a release fails at `verify` (its artifacts already exist), so a stuck release needs a new commit on `main`. Cache entries are a residual (T-56): a poisoned dependency cache could be restored by later `ci` runs. The `checks` job trusts check-run names from GitHub Actions; a second workflow defining a job called `ci` could mask a failing one (needs a `.github/` change, so owner-reviewed).
- **Release signatures are kept 90 days.** The cosign bundles live in the run's `release-signed` artifact; the SLSA attestations (GitHub attestations API) and npm's own provenance are permanent. A permanent home for the bundles (GitHub releases, IPFS) comes with the ballot-client release (P2-8).
- **`next` snapshot versions don't sort by time** (`<x.y.z>-next-<commit>`); the `next` dist-tag always points at the last publish, but semver ranges over prereleases are meaningless. The ballot client, OpenAPI spec and container images aren't released yet (P2-8, P2-2, P2-11).
- **The threat model's mitigations are almost all planned, not built** (see [[THREAT_MODEL]], status column). Its "Not mitigated" section lists what no planned work addresses. P1-1 merged in #3, so feature work may start.
