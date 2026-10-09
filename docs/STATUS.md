# STATUS

The work queue. Every session reads it, and every PR updates it. Items are ordered within each phase: take the first unblocked one. Each item is meant to fit in one PR. ADR items open as `needs-decision` PRs and don't block unrelated work. See [[PROJECT_BRIEF]] and the repo's `AGENTS.md`.

Last updated: 2026-10-09 (P1-1 threat model).

## In progress

- **P1-1 `docs/THREAT_MODEL.md`** (this PR): goals G-1–G-14, assets, adversaries A-1–A-11, threats T-01–T-69 with mitigations mapped to STATUS items, and the list of what isn't mitigated. Nearly every mitigation is marked planned, because nothing below the CI pipeline exists yet.

## Blocked

- **P0-2 Storybook under Vite+: blocked on the supply-chain trust policy (owner decision).** Storybook 10.6.1 itself is old enough and resolves, but `@storybook/react-vite` depends on `react-docgen` 8 → `@babel/core` 7 → `semver@^6.3.1`, and `vp add` fails with `High-risk trust downgrade for "semver@6.3.1"` from `trustPolicy: no-downgrade` in `pnpm-workspace.yaml`. Registry metadata shows it is a false positive: `semver@6.3.1` (and `5.7.2`) are July 2023 security backports published by an npm maintainer without provenance, after `7.5.1`–`7.5.4` had been published with provenance. No newer 6.x exists, and `react-docgen` has no Babel-8 release. Storybook wasn't run, so whether it works under Vite+ beyond install is still unknown. Workaround (needs the owner, because it relaxes a supply-chain setting in a CODEOWNERS file): add `trustPolicyExclude: [semver@6.3.1]` to `pnpm-workspace.yaml` with a comment giving this reason. Versions picked for the retry: `storybook`, `@storybook/react-vite`, `@storybook/addon-vitest` and `@storybook/addon-a11y` 10.6.1, `@vitest/browser-playwright` 5.0.1 (matches Vite+'s bundled Vitest), `playwright` 1.63.0 (1.64.0 is under 7 days old), React 19.3.0. P2-7 (`packages/ui`) depends on this.

## Known-weak

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
- **Lockfile policy covers `packages:` only.** It checks which bytes can be installed; rewiring a `snapshots:` edge to another version already in `packages:` isn't checked. `crypto-review` doesn't run on lockfile or catalog changes (the brief scopes it to the four protocol packages). CI rejects overrides, patches and package extensions, but a catalog bump of `@noble/*` or `@aztec/bb.js`, or a rewired edge, is seen only by `claude-review` and owner review until P1-9's lockfile-closure check and P1-16b land.
- **Required checks and auto-merge depend on repo rulesets** that agents may not change. The owner must mark `ci`, `reference-election`, `repro-build`, `claude-review` and `crypto-review` as required on `main`.
- **The threat model's mitigations are almost all planned, not built** (see [[THREAT_MODEL]], status column). Its "Not mitigated" section lists what no planned work addresses. No feature code may land before P1-1 merges.

## Done

- 2026-10-09: P0-1 `ci: bootstrap` merged (#1): AGENTS.md, CLAUDE.md, project skills, SessionStart hook, STATUS, root `LICENSE` (AGPL-3.0-only), the root Vite+ workspace, `.github/tools/ci`, `.github/scripts/install-toolchain.sh`, and the workflows `ci`, `reference-election`, `repro-build`, `claude-review` and `crypto-review`.
- 2026-10-09: the owner extended CODEOWNERS (#2) to `/.claude/`, `/AGENTS.md`, `/CLAUDE.md`, `/docs/PROJECT_BRIEF.md`, `/pnpm-workspace.yaml`, `/vite.config.ts` and `/tsconfig.base.json`.
- 2026-10-09: project brief saved (`docs/PROJECT_BRIEF.md`).

---

## Phase 0: Bootstrap

- [x] P0-1 `ci: bootstrap` (#1), with CODEOWNERS extended by the owner (#2)
- [ ] P0-2 (blocked, above) Storybook under Vite+ smoke test: confirm on day one that Storybook works under Vite+. Use a minimal `packages/ui` with one component, a story, an interaction test and an axe check, wired to `test:storybook`. If it doesn't work, record exactly why under Blocked, along with the workaround.
- [ ] P0-3 `ci: release` (needs owner review): `release.yml` with Changesets, `vp pack`, a double build plus hash comparison, cosign keyless signing, SLSA provenance, and `npm publish --tag next` via OIDC trusted publishing in the `npm` environment (GitHub-hosted runner, `id-token: write`, pinned npm ≥ 11.5). Also add placeholder `@abolishus/crypto`, `@abolishus/verifier` and `@abolishus/sdk` package metadata.
- [ ] P0-4 Licenses: `LICENSE` (Apache-2.0) in each published package as it's created, and a README section explaining the AGPL/Apache split.

## Phase 1: Threat model, spec, crypto core, circuits, verifier, reference election (CLI only)

- [ ] P1-1 (in progress, above) `docs/THREAT_MODEL.md`: assets, adversaries (state actor, insiders including us, compromised devices, coercion and vote buying, DDoS, supply chain, domain or hosting seizure, prompt injection against this pipeline), threat IDs, mitigations, and an explicit list of what isn't mitigated yet. No feature code before this merges.
- [ ] P1-2 ADR: canonical encoding (explicit byte layouts vs deterministic CBOR). `needs-decision`.
- [ ] P1-3 ADR: everlasting privacy (perfectly hiding commitments on the board vs standard threshold ElGamal), with a post-quantum "harvest now, decrypt later" analysis. `needs-decision`. Must be accepted before tally work (P1-12).
- [ ] P1-4 ADR: ballot tally scheme (homomorphic exponential ElGamal vs verifiable mixnet) per election type (plurality, approval, ranked choice). `needs-decision`.
- [ ] P1-5 ADR: L2 choice (Arbitrum One vs Base): L2BEAT stage at decision time, sequencer jurisdiction, forced-inclusion path, paymaster tooling. `needs-decision`.
- [ ] P1-6 ADR: permanent archive (Arweave vs pinning-only). `needs-decision`.
- [ ] P1-7 ADR: trustees, k-of-n and named trustees. **Owner decides; never defaults.** Until then, development uses a test ceremony.
- [ ] P1-8 `docs/spec/` skeleton: notation, domain-separation tag registry, versioning rules, vector format (`docs/spec/vectors/*.json`), and the list of what a third-party verifier must check.
- [ ] P1-9 `packages/crypto` scaffold: `@noble/*` only, `vp pack`, Apache-2.0, fast-check, and the published-vector harness (`packages/crypto/test-vectors/` with source URLs and sha256s). Same PR (`ci:` part): replace the name-only `@noble/*` check with one that reads `importers['packages/crypto']` from the lockfile, requires every runtime dependency to resolve to a registry `@noble/*` package with an `@noble`-only closure, rejects `npm:`/`link:`/`file:`/`workspace:` specs, lints `src` imports against declared dependencies, and asserts the packed bundle inlines no `node_modules` code. Same `ci:` part: an import lint for `packages/verifier` and `packages/crypto` that fails on any workspace dependency or import outside `packages/{crypto,circuits,contracts,verifier}` (plus `@noble/*`, generated ABIs and circuit artifacts), and on any symlink under a gated path (AGENTS.md, Architecture → Rules).
- [ ] P1-10 Canonical encoders and decoders per the encoding ADR, with property tests and cross-language vectors.
- [ ] P1-11 Group and hash layer: point/scalar codecs with subgroup checks, hash-to-field and domain separation, plus published vectors.
- [ ] P1-12 Ballot encryption and validity proofs (per the tally ADR): disjunctive Chaum–Pedersen, Fiat–Shamir with full statement binding.
- [ ] P1-13 Benaloh challenge/spoil, ballot receipts, and re-voting semantics (last ballot counts).
- [ ] P1-14 Threshold key ceremony: Pedersen/Feldman DKG, a public transcript format, and verification of the transcript.
- [ ] P1-15 Threshold decryption shares with proofs, tally combination, and the tally transcript.
- [ ] P1-16 Bulletin board model: append-only hash-chained entries, inclusion proofs, and Merkle roots for anchoring.
- [ ] P1-16b `ci:` toolchain-consistency check: CI fails unless `NOIR_VERSION`/`BB_VERSION` in `.github/scripts/install-toolchain.sh` match the `@noir-lang/noir_js` / `@aztec/bb.js` catalog pins and bbup's `bb-versions.json` mapping. Must land before P1-17.
- [ ] P1-17 `packages/circuits` scaffold (Noir 1.0.0-beta.22, bb 5.0.0-nightly.20260522): a membership + per-poll nullifier circuit compatible with Semaphore groups, with soundness tests.
- [ ] P1-18 `packages/contracts` scaffold (Foundry 1.8.3): an immutable bulletin-board contract, election-definition registry, trustee key registry and direct-submit path; fuzz + invariant tests; PII-ban tests; wagmi bindings.
- [ ] P1-19 `packages/verifier` CLI: download the board (from local files first), recompute and check everything, and check a served ballot client against a signed release. Spec in `docs/spec/verifier.md`.
- [ ] P1-20 Reference election fixture (`vp run reference-election`), CLI only: ceremony → tiers (stubbed until Phase 3, with the stubs clearly marked) → cast/challenge/re-vote → direct submit → close → threshold decrypt → tally → anchor (Anvil) → wipe + rebuild → independent verification offline. Makes the `reference-election` check real. The same PR sets `EXPECT_FIXTURE: "true"` in `.github/workflows/reference-election.yml` (a `ci:` change), so removing the script later fails the check. The workflow must call a fixed, owner-reviewed entry point rather than whatever the root script says, independently run `packages/verifier` over `reference-election-output/`, and require the transcript to cover every stage the brief lists.
- [ ] P1-21 `apps/admin-cli` and `packages/sdk` surfaces for simulations (for example "10,000 voters, 7 trustees, 2 offline, mixed tiers, servers down halfway").
- [ ] P1-22 Phase 1 exit: reference election green in CI and `crypto-review` green on every Phase 1 change. Update STATUS with what's tested and what's known-weak.

## Phase 2: Open polls end to end at Tier 0

- [ ] P2-1 `packages/core` + Drizzle schema: append-only board tables (grants + triggers), the account/ballot no-join test, and migrations roles.
- [ ] P2-2 `packages/api-contract` (oRPC, `zod/mini`) + OpenAPI generation.
- [ ] P2-3 `apps/api` (Hono + oRPC): board read, ballot submit, election definitions.
- [ ] P2-4 `apps/worker` (BullMQ, hashtagged queues): proof batch verification, IPFS pinning, tally coordination.
- [ ] P2-5 Accounts: better-auth + passkeys (accounts only), and Turnstile on Tier 0 actions.
- [ ] P2-6 Voting identity: a device-held Semaphore secret, encrypted with a WebAuthn PRF-derived key for recovery.
- [ ] P2-7 `packages/ui`: shadcn/ui + Tailwind, i18n, and Storybook stories with interaction and a11y tests for every component.
- [ ] P2-8 `apps/ballot`: a static, reproducible build; encryption and proving in a Web Worker; strict CSP; a no-analytics bundle test.
- [ ] P2-9 `apps/web`: TanStack Start SSR (discovery, results, poll creation), and PostHog proxied via our domain.
- [ ] P2-10 Moderation policy (written) and moderation tooling for poll content (never results).
- [ ] P2-11 `ci: deploy`: signed images to Railway (PR environments + staging), and Cloudflare in front.
- [ ] P2-12 Phase 2 exit: reference election against staging.

## Phase 3: Tier 2 ZK identity, Semaphore groups, indexer, per-tier results

- [ ] P3-1 ADR: zkPassport vs Self vs longfellow-zk. Must confirm proofs verify off-chain or on the chosen L2, with no third-chain dependency. `needs-decision`.
- [ ] P3-2 Semaphore groups per tier on L2, and a test that no on-chain data links a member to any poll.
- [ ] P3-3 Tier 1 vouching / web of trust.
- [ ] P3-4 Tier 2 QR handoff to the chosen proof app.
- [ ] P3-5 `apps/indexer` (Ponder), including direct-submitted ballots.
- [ ] P3-6 Per-tier results everywhere (API, web, verifier).

## Phase 4: Censorship resistance

- [ ] P4-1 Hourly L1 anchoring of board roots (worker + contract).
- [ ] P4-2 Direct-submit path, end to end, with servers refusing.
- [ ] P4-3 IPFS mirroring of board + ballot client, plus the permanent archive per ADR.
- [ ] P4-4 `abolishus.eth` + the second non-US-TLD domain (ADR), listed everywhere.
- [ ] P4-5 `apps/node`: a one-command community node (verifier + IPFS + chain reader, no DB).
- [ ] P4-6 Verifier running against chain + IPFS only, in the reference election with servers and domain offline.

## Phase 5: US civic referendums and native app

- [ ] P5-1 Referendum templates (national/state/district; plurality, approval, ranked choice).
- [ ] P5-2 Capacitor shell around `apps/ballot` (macOS runners for native builds).
- [ ] P5-3 `packages/capacitor-nfc-passport` (passport + ISO 18013-5 mDL).
- [ ] P5-4 `packages/capacitor-zk-prover` (evaluate mopro).
