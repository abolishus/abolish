# ADR 0036: The signed release record

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-18
- Deciders: agent, owner may veto (rule A); deploying the release registry on Ethereum mainnet, paying for each release's transaction there and naming the release Safe's signers are the owner's (mainnet, real funds, [[0020-entry-points]])
- Threats addressed: T-41, T-64, T-69, T-49, T-43, T-36, T-59 (see [[THREAT_MODEL]])

## Context

The brief asks the verifier to check "that a served ballot client matches a signed release, without trusting our servers" ([[verifier]] 1.1), and [[0020-entry-points]] puts the list of entry points in "one place, in the signed release record". Nothing defines that record yet, and several items already lean on it:

- [[verifier]] 1.1 needs a release hash "signed by the release identity", and the verifier's pinned trust roots include "the release-signing identities" without saying what they are.
- [[registration]] pins the challenge origin "in the signed release next to the entry points"; [[0017-identity-recovery-backup]] puts the RP ID's `/.well-known/webauthn` in it.
- [[P2-21]] pins the membership prover and its key "in the release record"; [[P2-8]] builds the client against a deployment (chain IDs, contract addresses, registrars, origins) that "the signed release pins".
- [[P4-5]] part 4 (`apps/node` serving the client) waits on it, and [[P2-22]] waits on it to compare the registry's code and profile with a pinned one.

Release signing today is CI's: `release.yml` and `deploy.yml` sign npm tarballs and images with Sigstore keyless signatures and SLSA provenance. That proves which workflow built an artifact, which is what the brief asks of CI. It doesn't say what the verifier should accept as a release.

What is one-way: the trust root that 1.1 and `apps/node` check (every verifier release pins it, and receipts and third-party verifiers cite releases by it), and the record's canonical bytes once the first release is signed. Two facts shape the choice:

- **The attack is targeted** (T-41): whoever serves the JavaScript serves a modified client to one voter. A signature only helps if a release signed for one voter can't stay hidden from everyone else. A check that passes for a release no one else has seen proves little.
- **The verifier's trust base is `@noble/*` and the gated packages** (AGENTS.md, Architecture). It already proves L1 storage slots from a finalized header with Keccak-256 and strict RLP ([[verifier]], Anchors from L1). Anything 1.1 adds is code in that trust base.

## Options

### A. Sigstore keyless signatures as the release signature

`release.yml` signs the record with cosign keyless, as it signs tarballs: a short-lived key, a Fulcio certificate binding it to the workflow's GitHub OIDC identity (`release.yml` on `main` of `abolishus/abolish`), and a Rekor transparency-log entry. 1.1 checks the bundle offline: the certificate chain to a pinned Fulcio root, the certificate's workflow identity, its SCT, and the Rekor inclusion proof and signed checkpoint under a pinned Rekor key.

- Pros: no human key custody; already in CI; Rekor is a public append-only log, so a signed release is visible to anyone who looks.
- Cons: the trust root is whoever can run `release.yml` on `main`, which includes GitHub itself and anyone who compels it (T-69; the brief distrusts US-administered names for the same reason), and a workflow or Action compromise that reaches the OIDC token (T-59). The verifier would carry a hand-written X.509, DER, SCT and Rekor parser in its trust base, the largest parser it has, for a report-only check. Sigstore rotates Fulcio and Rekor keys through its own TUF root, so a pinned verifier goes stale and old releases verify only against Sigstore's root history. Rekor's visibility is only real if someone monitors it for our identity.

### B. A release registry on L1, written by the release Safe

The record is published to IPFS (and the archive) and its hash is appended to a small immutable L1 contract, the **release registry**, whose only writer is the release Safe that [[0020-entry-points]] already requires for `abolishus.eth`. The registry keeps each release's hash and sequence number in storage and refuses any record whose `previous` isn't its latest, so releases form one public chain with no forks. The same Safe can append a revocation of an earlier release; it can't delete one. 1.1 and `apps/node` prove the registry's slots at a finalized L1 header, with the code the verifier already runs for anchors. Sigstore and SLSA stay as CI evidence: the Safe's signers check a release's two reproducible builds and its provenance before signing, and 1.1 may later report the provenance as well, never instead.

- Pros: every release is public on L1, in order, before any check passes it, so a release built for one voter must be published to everyone, and a served client that isn't on the chain fails 1.1 (T-41). The trust root is a threshold of named people on hardware keys, the same body that already controls the ENS name, so taking the client means taking one Safe, not a Safe or GitHub (T-69). It needs nothing outside chain and IPFS, and its state survives L1 log expiry ([EIP-4444](https://eips.ethereum.org/EIPS/eip-4444)), as the anchor's locator does ([[contracts]], Archive locator). The verifier adds no parser: a storage proof and the record's own canonical decoder. Revocation and "which release is current" both come from the same state.
- Cons: a new L1 contract, immutable, whose deployment 1.2's creation-code binding must cover like every other (T-64); one L1 transaction per release, and on mainnet a payment the owner makes; a compromised or compelled Safe quorum can still publish a malicious release, but only in public. Until the owner deploys on mainnet, releases are signed on Sepolia only.

### C. A pinned set of release keys signing off chain

`k` of `n` maintainers' hardware keys (Ed25519 or P-256) sign the record; the signatures travel beside it on IPFS, and the verifier pins the keys.

- Pros: the simplest verifier code (`@noble`), no gas, no contract.
- Cons: nothing makes a signed release public: a quorum, or whoever compels one, can sign a release, serve it to one voter and never publish it, which is exactly T-41's attack. Nothing says which release is current or revokes a bad one. Rotating a key needs a new verifier release.

## Recommendation

B. T-41 is a targeted attack, and only B makes every release public by construction and verifiable from chain and IPFS alone with code the verifier already trusts. A keeps a transparency log but puts GitHub, Sigstore's keys and a large parser in the trust base for a report-only check. C has no transparency at all.

The record binds what a served client is checked against, and what a client or node needs that its bytes don't make easy to read. Its exact bytes are [[P4-4]] part 2b's, a new record type in [[versioning]] under [[notation]]'s encoding, with vectors. It carries:

1. `previous` (the hash of the release before it, or zero) and `sequence`, which the registry checks.
2. The source commit on `main` it was built from.
3. Each site it serves, the ballot client and the challenge page ([[registration]], Origin): every file's path and sha256 in sorted order, the directory's CID under [[content-addressing]] (which part 2b extends with the directory layout), and the response headers each must be served with (the CSP header with `frame-ancestors`, which a `<meta>` can't set and from which a dedicated worker takes its policy).
4. The ballot client's entry points (the second domain, `abolishus.eth`, and the rule for `apps/node`'s local origin) and the challenge origin.
5. The deployment the client is built for: the L1 and L2 chain IDs, the contract addresses, the registrars, the API and RPC origins its `connect-src` lists, and the membership prover's and key's hashes. The build reads them from the record, so the client and its record can't disagree.

1.1 then reads, for a served origin: the record by its hash, the registry's slots proving that hash published and not revoked at a finalized header, every listed file fetched from the origin and hashed, and the headers it sends. Its client-integrity verdict passes only if every file matches; a served release older than the registry's latest is reported with how far behind it is, and a revoked one fails.

What would change it: an L1-native way to commit to a release that a light client checks without a contract; the owner choosing not to run an L1 Safe for releases (then A, with its trust-base cost); or the native app (P5-2) becoming the only client, whose store signing would then sit beside this record.

## Consequences

- [[P4-4]] part 2 splits into: 2b, the record's bytes and the registry's storage layout in the spec (with [[contracts]], Release registry, and [[verifier]] 1.1's procedure), with vectors; 2c, the record in `packages/crypto` and 1.1 in `packages/verifier`; 2d, the registry in `packages/contracts`; 2e, the release workflow building the record and the Safe transaction it asks the signers to make, in a `ci:` PR. Part 3 sets the ENS `contenthash` in the same Safe transaction as the registry's append, so the name never points at a release the registry doesn't hold.
- `apps/node` ([[P4-5]] part 4) serves only a release it has proven published and not revoked, and can be configured to serve a new one only after a delay, so a release published under compulsion has an audience before it has users.
- The release Safe's signers verify a release before signing: the two reproducible builds, the Sigstore signature and SLSA provenance from `release.yml`, and the record against the commit. That is a runbook ([[P4-4]] part 2e), and the signers are the owner's to name.
- A monitoring job alerts on every append to the registry (P2-11), so a release nobody here meant to make is seen at once.
- **Gateways don't send our headers.** `abolishus.eth.limo` serves the bytes but not the record's headers, so a client reached there has no `frame-ancestors` and its workers run without the header CSP (T-43). 1.1 reports each entry point's headers against the record's, and part 3 must establish what the gateway can be made to send before the name is listed.
- **A Safe quorum can still publish a bad release**, publicly. The registry makes it visible, not impossible; revocation stops checks from passing it, not voters who already ran it.
- **Mainnet is the owner's.** Until the owner deploys the registry on mainnet and funds the Safe, releases are recorded on Sepolia only, and the verifier's pinned registry is Sepolia's. Nothing is listed or promoted until then ([[0020-entry-points]], Owner actions).

## Decision

Under rule A (`AGENTS.md`): option B, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto in favour of A or C changes only part 2b onwards: nothing is built from this decision before the spec. Deploying the registry on mainnet, paying for releases there and naming the Safe's signers are owner-only, like the rest of [[0020-entry-points]]'s owner actions, and nothing before mainnet waits on them.
