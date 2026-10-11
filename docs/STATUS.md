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
- [[P1-10b]] Election-definition and display-text records
- [[P1-11]] Group and hash layer
- [[P1-12]] Ballot commitments and validity proofs
- [[P1-13]] Challenge/spoil, receipts and re-voting
- [[P1-14]] Trustee key registration
- [[P1-15]] Summed shares, tally and destruction
- [[P1-16]] Bulletin board model
- [[P1-16b]] `ci:` toolchain-consistency check
- [[P1-17]] `packages/circuits` scaffold
- [[P1-17b]] Membership verification keys and Groth16 verification
- [[P1-17c]] `packages/circuits` Noir scaffold
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

One-off items: [[P0-ops]] split shared hot files; [[P0-ops-2]] P0-ops review follow-ups; [[P0-ops-3]] apply rule A to the open ADRs; [[P0-ops-4]] reconcile accepted ADRs and their dependants; [[P0-ops-5]] partition and verifier follow-ups; [[P0-ops-6]] one cell per electorate tier; [[P0-ops-7]] no merged tiers in 2.8; [[P0-ops-8]] a ballot's cell is its own tier.

## Blocked

- [[P1-13]] part 2, receipts (#48): labelled `blocked` after three pushes that each left `crypto-review` with a new blocking finding in the receipt's evidence model. It waits on the owner's review of ADR 0013 (in #48) as it stands, or on binding receipt keys per election first; see [[P1-13]].
- [[P1-12]] part 2, share encryption (#58), and so P1-14 part 2, P1-12 part 3 and P1-15 parts 2 and 3: waiting on the owner's answer on [[0016-share-kem-dh-group]] (Waiting on the owner, below).
- On 2026-10-11 the owner unblocked [[P0-2]] (`trustPolicyExclude: [semver@6.3.1]`), [[P1-12]] and [[P1-14]] part 2 (answers recorded in [[0002-everlasting-privacy]], Decision).

## Decisions to review

Decisions the agent made under rule A (`AGENTS.md`). Each stands unless the owner vetoes it; a veto is recorded in the ADR and the item's file.

- [[0001-canonical-encoding]] (P1-2, #6): explicit byte layouts.
- [[0003-tally-scheme]] (P1-4, #9): homomorphic tally for plurality and approval; a commitment-consistent mixnet only for ranked choice, by a later ADR (naming the mixers, and any design that isn't commitment-consistent, stay with the owner).
- [[0004-l2-choice]] (P1-5, #10): Base, for development and testnet. Mainnet stays with the owner.
- [[0005-permanent-archive]] (P1-6, #11–#14): Arweave plus IPFS pinning. The first real upload spends money, so it waits for the owner.
- [[0008-draft-record-layouts]] (P1-10b, #35): no draft record layouts. Published vectors freeze the election definition and display text, version 1, now; changes from P1-14, P1-17 and P1-18 become new versions. A veto reintroduces a draft rule.
- [[0009-membership-proof]] (P1-17): Semaphore v4's own circuit and Groth16 proofs for membership (the fallback [[0002-everlasting-privacy]] names, since statistical zero knowledge of bb's UltraHonk can't be shown today), with a nullifier scope per poll and tier group, and tier trees of fixed depth 32. **Owner to confirm before P1-17b starts:** the ADR reads verifying Groth16 over `@noble/curves`' BN254 pairing as composing a published protocol, not implementing a proof system (the `crypto-review` skill forbids the latter); the skill is owner-reviewed, so an agent ADR alone doesn't settle that reading.
- [[0010-tier2-identity-provider]] (P3-1): zkPassport for Tier 2, verified locally with the inner-circuit set and the US CSCA anchors pinned by us, never through zkPassport's hosted verifier or upgradeable contracts. Self is rejected (Celo dependency, proving in a TEE) and so is longfellow-zk (no uniqueness nullifier). No real document is registered on a public chain until its published proof is shown statistically zero-knowledge (fallback: trustee-attested additions) and the owner has answered the nullifier question below.
- [[0011-revote-rule]] (P1-13): for each tier and nullifier, the ballot naming the newest L1 block counts (its membership proof binds the block's number and hash); two distinct ballots naming that block tie and count nothing. Board order, segments and arrival times never decide. Costs 40 bytes per ballot and a wait for L1 finality before a closed election verifies.
- [[0012-trustee-identity-signatures]] (P1-14): trustee identity keys and every trustee statement use ECDSA over P-256 with SHA-256 and the low-s rule, chosen over secp256k1 for hardware custody (FIPS HSMs, PIV cards, cloud KMS); both are checkable on chain with audited OpenZeppelin code, and secp256k1's rigid curve parameters are the trade-off the owner may prefer (P-256's come from an unexplained seed). Ed25519 has no audited on-chain verifier; a post-quantum suite waits on the `@noble/post-quantum` question.
- [[0014-tier1-vouching]] (P3-3): Tier 1 admits a commitment vouched for by 3 distinct Tier 2 (document-verified) members, anonymously. Each vouch is two Semaphore proofs: one per vouchee (distinct vouchers) and one per budget slot (12 per member across the deployment, ever). The verifier checks it from the board, which replaces the Safe's signature for Tier 1. Nothing on the board or any server records who vouched for whom, though a voucher's secret recomputes their own vouches. The costs: Tier 1 can't admit real people before Tier 2 can, vouchers aren't accountable, and collusion is bounded at 4 fake identities per colluding document rather than prevented. A transitive web of trust, a public signed graph and an operator-held graph were rejected.
- [[0015-tally-publication]] (P1-15): the tally publishes only each cell's opening; trustees exchange summed shares privately under the hybrid KEM. Publishing them, as [[0002-everlasting-privacy]] had it, fixes the summed polynomials at every seat, so a later break of posted shares' classical encryption would complete ballots with fewer than `k` posted shares. Costs public attribution of a trustee's wrong summed share (a wrong opening is still attributed), and a corrupt trustee keeps that power. Re-randomising the sums (option B) would keep attribution at the cost of a new round; publishing them anyway (option A) narrows ADR 0002 and is the owner's.
- [[0017-identity-recovery-backup]] (P2-6): the voting identity's recovery backup opens only with a user-verified WebAuthn PRF evaluation of a separate passkey on a dedicated ballot RP ID (never the account passkey; never same-site with `apps/web`; its well-known file signed with the client release), and we store the envelope under a PRF-derived locator through the ballot path, with no account session or account column. Joining a backup to an account gives nothing usable without that evaluation. Costs: whoever serves the ballot RP ID reaches the secret on every device the passkey syncs to (T-41), anyone can write rows (flooding bounded at the proxy), a database wipe loses backups, and voters without PRF support get none. Keyed by account with the account passkey's PRF (T-20) was rejected; a plaintext recovery code was rejected because the brief keeps the secret on the device, and the owner may still ask for one.
- [[moderation-policy]] (P2-10): moderation acts only on display text and listing, never on the board, a definition, a tally or an election's timing, with a closed list of grounds and an append-only public log. One trade-off reaches results indirectly: hiding an open poll (allowed only for `illegal`, `personal-data` or `threat`) stops voting through our ballot client, which won't show text it can't check, so it can lower turnout on a reason code nobody outside can check; voters keep the direct-submit path. Delisting only, or letting the ballot client fetch the committed text from IPFS for some grounds, were the alternatives.

Waiting on the owner (owner-only under rule A): [[0006-trustees]] (P1-7: naming trustees); the legal and entity questions in [[moderation-policy]] (P2-10: which law decides `illegal` and the reporting duties that come with it, how legal notices are received and published, what we say if compelled to act on results, and who may moderate), needed before Phase 2 goes public; [[0016-share-kem-dh-group]] (P1-12 part 2, #58): the brief allows unaudited ML-KEM only in a hybrid "with X25519", and #58 pairs it with Curve25519 DH in ristretto255 encoding (same curve and hardness, and the trustee's complaint stays a standard Chaum–Pedersen proof), so the owner either extends the exception to that encoding or keeps RFC 7748 X25519, which needs a new complaint proof; and two from [[0010-tier2-identity-provider]]: whether a Tier 2 nullifier that anyone holding the passport chip's data can recompute counts as PII on-chain, and whether `@aztec/bb.js` may sit in the verifier's trust base as the runtime for circuit artifacts. The nullifier answer is needed before any real document is registered; the bb.js reading is needed before P3-4 builds the verifier side.

## Injection attempts

Where and when untrusted content tried to redirect an agent (AGENTS.md, Untrusted input), never quoting it. None recorded yet.

## Known-weak

- **`@noble/post-quantum` (ML-KEM-768) is unaudited** (P1-12 part 2, #58). It is self-audited at 0.6.1, and the pinned 0.7.1 has changes since. The brief allows it on testnets only, in a hybrid KEM; an independent audit of the code in use is a mainnet prerequisite, and funding it is the owner's ([[0002-everlasting-privacy]], Decision).
- **The API has no cache or metrics no-join test yet** (T-10). P2-1 covers tables, P2-3 part 1 the API's request log and P2-4 part 1 queue job data, Redis and the worker's log. The API part that adds a cache or metrics extends its test, and so does each new queue (by its side and fields). The proxy in front of the API logs on its own; [[P2-11]] must configure it to keep no addresses or query strings (T-11).
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
- **Voting-identity recovery is designed, not built** ([[0017-identity-recovery-backup]], P2-6). Once built: whoever serves the ballot RP ID can read a voter's secret on any device the backup passkey syncs to (T-41, T-20); the backup routes are an anonymous write surface bounded only at the proxy (T-52); a Postgres wipe loses every backup (T-66); and voters without PRF support have no backup.
- **The threat model's mitigations are almost all planned, not built** (see [[THREAT_MODEL]], status column). Its "Not mitigated" section lists what no planned work addresses. P1-1 merged in #3, so feature work may start.
