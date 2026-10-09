# STATUS

The work queue. Every session reads it, and every PR updates it. Items are ordered within each phase: take the first unblocked one. Each item is meant to fit in one PR. ADR items open as `needs-decision` PRs and don't block unrelated work. See [[PROJECT_BRIEF]] and the repo's `AGENTS.md`.

Last updated: 2026-10-09 (bootstrap session).

## In progress

- **P0-1 `ci: bootstrap`** (this PR): AGENTS.md, CLAUDE.md, project skills, SessionStart hook, this STATUS, root `LICENSE` (AGPL-3.0-only), the root Vite+ workspace, `.github/tools/ci`, `.github/scripts/install-toolchain.sh`, and the workflows `ci`, `reference-election`, `repro-build`, `claude-review` and `crypto-review`. It waits for the owner's review because it changes `.github/`.

## Blocked

- Nothing yet.

## Known-weak

- **`reference-election` check is a placeholder.** It passes with a warning until the root `reference-election` script exists (P1-20), so it proves nothing yet.
- **`repro-build` has nothing to compare yet.** The only build today (`.github/tools/ci`) type-checks without emitting output. The check hashes every file a build creates, rejects any build that modifies a tracked file, and requires each package to declare its outputs, so it becomes meaningful as soon as a package emits output.
- **The review workflows haven't run yet.** Two settings are unverified until the first real run: `allowed_bots: claude` (the identity Claude's PRs come from) and `--effort max` in claude-code-action. Fix in a `ci:` PR if the first run fails for either reason.
- **External (fork) PRs can't pass `claude-review` or `crypto-review`,** because forks get no secrets. A maintainer must re-open them from an in-repo branch.
- **Lockfile "review" is mechanical plus AI review,** not human review. CI enforces registry-only resolution, integrity matching the registry, and ≥ 7 days' age; `claude-review` must justify every added package. There is no human sign-off on dependency changes unless the owner adds one.
- **Non-`.github/` changes merge on CI plus model review alone.** All gate code (workflows, review prompts, `.github/tools/ci` policy code, `.github/scripts/install-toolchain.sh` pins and hashes) lives under `.github/`, which CODEOWNERS routes to the owner, so a PR can't weaken the checks that judge it. Everything else auto-merges once CI, `claude-review` and (for protocol paths) `crypto-review` pass, with no human in the loop.
- **CODEOWNERS covers only `/.github/`, and it binds only if the `main` ruleset has "Require review from Code Owners" enabled.** Agents can't verify or change either. Without owner review, an auto-merged PR could change `.claude/` (the SessionStart hooks run in every agent session), `AGENTS.md`/`CLAUDE.md` (agent instructions), `pnpm-workspace.yaml`, or `vite.config.ts` and `tsconfig.base.json` (which decide what `vp check` proves). CI's lockfile policy still enforces package age and integrity independently of `pnpm-workspace.yaml`. Requested from the owner on the bootstrap PR: add `/.claude/`, `/AGENTS.md`, `/CLAUDE.md`, `/pnpm-workspace.yaml`, `/vite.config.ts` and `/tsconfig.base.json` to CODEOWNERS, and enable code-owner review.
- **Toolchain hashes are trust-on-first-use.** The sha256 pins in `.github/scripts/install-toolchain.sh` were recorded from the upstream GitHub releases on 2026-10-09; nothing cross-checks them against upstream attestations, and `repro-build` can't detect a deterministic malicious binary because both builds use the same one.
- **Merge queue:** the review checks skip `merge_group`. If the owner enables a merge queue, it must use batch size 1, or the combined tree of a batch is never model-reviewed.
- **Lockfile policy covers `packages:` only.** It checks which bytes can be installed; rewiring a `snapshots:` edge to another version already in `packages:` isn't checked.
- **Required checks and auto-merge depend on repo rulesets** that agents may not change. The owner must mark `ci`, `reference-election`, `repro-build`, `claude-review` and `crypto-review` as required on `main`.
- **No threat model yet.** No feature code may land before P1-1.

## Done

- 2026-10-09: project brief saved (`docs/PROJECT_BRIEF.md`).

---

## Phase 0: Bootstrap

- [ ] P0-1 `ci: bootstrap` (in progress, above)
- [ ] P0-2 Storybook under Vite+ smoke test: confirm on day one that Storybook works under Vite+. Use a minimal `packages/ui` with one component, a story, an interaction test and an axe check, wired to `test:storybook`. If it doesn't work, record exactly why under Blocked, along with the workaround.
- [ ] P0-3 `ci: release` (needs owner review): `release.yml` with Changesets, `vp pack`, a double build plus hash comparison, cosign keyless signing, SLSA provenance, and `npm publish --tag next` via OIDC trusted publishing in the `npm` environment (GitHub-hosted runner, `id-token: write`, pinned npm ≥ 11.5). Also add placeholder `@abolishus/crypto`, `@abolishus/verifier` and `@abolishus/sdk` package metadata.
- [ ] P0-4 Licenses: `LICENSE` (Apache-2.0) in each published package as it's created, and a README section explaining the AGPL/Apache split.

## Phase 1: Threat model, spec, crypto core, circuits, verifier, reference election (CLI only)

- [ ] P1-1 `docs/THREAT_MODEL.md`: assets, adversaries (state actor, insiders including us, compromised devices, coercion and vote buying, DDoS, supply chain, domain or hosting seizure, prompt injection against this pipeline), threat IDs, mitigations, and an explicit list of what isn't mitigated yet. No feature code before this merges.
- [ ] P1-2 ADR: canonical encoding (explicit byte layouts vs deterministic CBOR). `needs-decision`.
- [ ] P1-3 ADR: everlasting privacy (perfectly hiding commitments on the board vs standard threshold ElGamal), with a post-quantum "harvest now, decrypt later" analysis. `needs-decision`. Must be accepted before tally work (P1-12).
- [ ] P1-4 ADR: ballot tally scheme (homomorphic exponential ElGamal vs verifiable mixnet) per election type (plurality, approval, ranked choice). `needs-decision`.
- [ ] P1-5 ADR: L2 choice (Arbitrum One vs Base): L2BEAT stage at decision time, sequencer jurisdiction, forced-inclusion path, paymaster tooling. `needs-decision`.
- [ ] P1-6 ADR: permanent archive (Arweave vs pinning-only). `needs-decision`.
- [ ] P1-7 ADR: trustees, k-of-n and named trustees. **Owner decides; never defaults.** Until then, development uses a test ceremony.
- [ ] P1-8 `docs/spec/` skeleton: notation, domain-separation tag registry, versioning rules, vector format (`docs/spec/vectors/*.json`), and the list of what a third-party verifier must check.
- [ ] P1-9 `packages/crypto` scaffold: `@noble/*` only, `vp pack`, Apache-2.0, fast-check, and the published-vector harness (`test-vectors/` with source URLs and sha256s).
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
- [ ] P1-20 Reference election fixture (`vp run reference-election`), CLI only: ceremony → tiers (stubbed until Phase 3, with the stubs clearly marked) → cast/challenge/re-vote → direct submit → close → threshold decrypt → tally → anchor (Anvil) → wipe + rebuild → independent verification offline. Makes the `reference-election` check real.
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
