# Threat model

What Abolish protects, from whom, and how. This file is the overview and index; each threat lives in its own file, `docs/threats/T-xx.md`, so parallel changes don't conflict. Every design decision, ADR, spec section and security-relevant code comment cites the threat IDs here (`T-xx`). See [[PROJECT_BRIEF]] for the requirements this derives from and [[STATUS]] for the work items named below.

Last updated: 2026-10-10 (P0-ops: threats moved to `docs/threats/`). Nothing below the CI pipeline is built yet, so almost every mitigation is **planned**: each threat's status says so, and [Not mitigated](#not-mitigated) lists what no planned work addresses.

## How to use this document

- IDs are stable and append-only. A new threat takes the next free number, whatever section it belongs in, gets its own `docs/threats/T-xx.md` (same layout as the others) and a row in its section's index table here. Never renumber or reuse one. A threat that no longer applies is marked `Retired (reason, date)`, not deleted.
- A change that adds, weakens or removes a mitigation updates the threat's file in the same PR, including its status, and the status in its index row here if that changes. Add a dated line under a `## History` heading at the end of that file saying what changed and which item changed it. Weakening a mitigation without saying so there is a blocking review finding.
- A threat with no mitigation is still listed, with status **Not mitigated** and the reason. Hiding a gap is worse than having one.
- Status values:
  - **In place**: implemented and tested on `main`.
  - **Partial**: some of the mitigation is in place; the threat's file says what is missing.
  - **Planned**: designed in the brief or an ADR and scheduled in STATUS, not built.
  - **Needs decision**: depends on an open ADR.
  - **Needs design**: no design exists yet; the STATUS item named must produce one.
  - **Not mitigated**: no planned work removes it; the residual risk is stated.
  - **Accepted**: a deliberate, documented trade-off.

## System summary

Abolish is a non-binding, publicly verifiable voting platform. Its authority comes only from anyone being able to recompute and check every result. The components that matter for security:

- **Ballot client** (`apps/ballot`): a static, reproducible, signed, hash-addressed SPA, the only place votes are cast. It encrypts the ballot and proves eligibility on the voter's device.
- **Voting identity**: a Semaphore secret held on the voter's device, recoverable via a key derived with the WebAuthn PRF extension. Its commitment sits in the on-chain group for the voter's identity tier.
- **Account** (better-auth + passkeys): who you are to the app (poll creation, moderation, notifications). Kept strictly separate from the voting identity.
- **Public bulletin board**: append-only, hash-chained entries (encrypted ballots, proofs, ceremony and tally transcripts) stored in Postgres, mirrored to IPFS and a permanent archive, with Merkle roots anchored hourly to Ethereum L1.
- **L2 contracts**: Semaphore groups, election-definition hashes, trustee public keys and direct-submitted ballots.
- **Trustees**: k-of-n holders of the election decryption key, produced by a DKG ceremony with a public transcript.
- **Verifier** (`packages/verifier`): recomputes and checks everything from chain + IPFS alone, and checks a served ballot client against a signed release.
- **Servers** (`apps/api`, `apps/worker`, `apps/web`, `apps/indexer`): convenience and availability only. Wiping Postgres must lose no result.
- **The autonomous build pipeline**: agent sessions write the code; CI and two model reviews gate it; the owner reviews `.github/` and other CODEOWNERS paths.

## Security goals

Threats are grouped by the goal they attack.

| ID   | Goal                    | Meaning                                                                                                                                              |
| ---- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-1  | Eligibility             | Only members of a poll's electorate (per tier) can cast a counted ballot.                                                                            |
| G-2  | One person, one vote    | At most one counted ballot per person per poll per tier; weight never depends on tokens or wealth.                                                   |
| G-3  | Ballot secrecy          | No one, including us, learns how a voter voted. No plaintext vote touches a server, log, analytics or chain.                                         |
| G-4  | Unlinkability           | No public or server-side data reveals which person voted in which poll, or links a voter's participation across polls.                               |
| G-5  | Everlasting privacy     | Ballot secrecy survives future cryptanalysis (including quantum) of data published today, to the extent the privacy ADR achieves.                    |
| G-6  | Cast as intended        | The voter can check their encrypted ballot contains their choice.                                                                                    |
| G-7  | Recorded as cast        | The voter can check their ballot is on the public board, unaltered.                                                                                  |
| G-8  | Counted as recorded     | Anyone can check the tally is the correct function of the recorded valid ballots.                                                                    |
| G-9  | Universal verifiability | Anyone can verify G-1, G-2, G-7 and G-8 from chain + IPFS alone, without trusting our servers, domain or code.                                       |
| G-10 | Censorship resistance   | Voting, publication and verification survive takedown of abolish.us, our hosting and our servers.                                                    |
| G-11 | Coercion resistance     | A coercer can't verify compliance. Only re-voting (last ballot counts) is in scope; what remains open is listed below.                               |
| G-12 | No PII on-chain         | No personal data on any chain or IPFS, ever.                                                                                                         |
| G-13 | Client integrity        | The ballot client a voter runs is the published, reviewed, reproducible build.                                                                       |
| G-14 | Development integrity   | No one (an external attacker, a dependency, a prompt injection, an agent or us) can land unreviewed changes to code that decides results or privacy. |

## Assets

| Asset                                                         | Where                                   | Goals         |
| ------------------------------------------------------------- | --------------------------------------- | ------------- |
| Plaintext vote and encryption randomness                      | Voter's device only, transiently        | G-3, G-5      |
| Voting identity secret (Semaphore)                            | Voter's device; PRF-encrypted backup    | G-1, G-2, G-4 |
| Identity documents (passport, mDL) and their data             | Voter's device and the proof app only   | G-4, G-12     |
| Account records (passkeys, email if any)                      | Postgres                                | G-4           |
| Trustee key shares                                            | Each trustee's own custody              | G-3, G-8      |
| Bulletin-board entries and their hash chain                   | Postgres, IPFS, archive; roots on L1    | G-7, G-8, G-9 |
| Election definitions                                          | Board; hash on L2                       | G-8, G-9      |
| Semaphore groups (identity commitments per tier)              | L2                                      | G-1, G-2      |
| Ballot receipts                                               | Voter's device                          | G-7           |
| Ballot client release (bytes, hash, signature)                | IPFS, ENS, domains, release signatures  | G-13          |
| Source, dependencies, toolchain binaries, CI and review gates | GitHub, npm registry, upstream releases | G-14          |
| Contract deployer and admin keys (Safe signers)               | GitHub environment secrets; signers     | G-9, G-10     |
| Domains, DNS, hosting and CDN accounts                        | Registrars, Railway, Cloudflare         | G-10, G-13    |
| Network metadata (IP addresses, timing)                       | Servers, CDN, RPC providers, relayers   | G-4           |

## Adversaries

| ID   | Adversary                        | Capabilities assumed                                                                                                                                                                                                                                                                                             |
| ---- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1  | State actor                      | Legal compulsion of us, registrars, hosts and CDNs; domain seizure; network-wide traffic observation in its jurisdiction; large-scale Sybil creation; disinformation; possibly forged identity documents of its own citizens. Wants results suppressed, discredited or flooded with fakes, or voters identified. |
| A-2  | Malicious insider (including us) | Full control of our servers, database, logs, deploys, domains and contract admin roles we hold; can serve different content to different users. Includes a malicious or coerced maintainer, operator or trustee.                                                                                                 |
| A-3  | Compromised voter device         | Malware or a malicious browser extension on the voter's device: reads and alters what the voter sees and sends.                                                                                                                                                                                                  |
| A-4  | Coercer or vote buyer            | Pressures or pays voters; can watch them vote, demand receipts, secrets or devices.                                                                                                                                                                                                                              |
| A-5  | Availability attacker            | DDoS on web, API and RPC endpoints; spam through every public write path, including the contracts.                                                                                                                                                                                                               |
| A-6  | Supply-chain attacker            | Publishes or hijacks npm packages, GitHub Actions or toolchain releases; compromises an upstream maintainer account.                                                                                                                                                                                             |
| A-7  | Hosting and domain seizure       | Takes down abolish.us, our Railway and Cloudflare accounts, or our GitHub organisation.                                                                                                                                                                                                                          |
| A-8  | Prompt injector                  | Writes issues, PR comments, dependency READMEs, web pages or test data that our agents read, aiming to make them weaken the system.                                                                                                                                                                              |
| A-9  | Dishonest voter                  | Tries to vote twice, vote outside their electorate, forge proofs, replay others' ballots or submit malformed ballots.                                                                                                                                                                                            |
| A-10 | Passive observer                 | Reads everything public: chain, IPFS, board, transaction metadata, published results.                                                                                                                                                                                                                            |
| A-11 | Future cryptanalyst              | Holds today's public data and, later, a cryptographically relevant quantum computer or a break of a hardness assumption ("harvest now, decrypt later").                                                                                                                                                          |

## Threats

Each threat's file holds its description, mitigation and full status; the tables below index them. Mitigations cite the STATUS items that build them. A mitigation is only real once the reference election (P1-20) exercises it.

### Eligibility and Sybil resistance (G-1, G-2)

Sybil resistance is the core problem: if one person can vote many times, results are meaningless.

| ID       | Threat                                           | Adversary | Status         |
| -------- | ------------------------------------------------ | --------- | -------------- |
| [[T-01]] | Sybil accounts at Tier 0                         | A-1, A-9  | Not mitigated  |
| [[T-02]] | Sybil rings at Tier 1                            | A-1, A-9  | Planned        |
| [[T-03]] | Forged, stolen or duplicated documents at Tier 2 | A-1, A-9  | Partial        |
| [[T-04]] | Double voting in one poll                        | A-9       | Planned        |
| [[T-05]] | Unsound circuit or proof verification            | A-9, A-1  | Planned        |
| [[T-06]] | Group stuffing by the operator                   | A-2       | Needs decision |
| [[T-07]] | Setup compromise of a proving system             | A-1       | Accepted       |
| [[T-08]] | Electorate definition manipulation               | A-2       | Planned        |

### Ballot secrecy, unlinkability and privacy (G-3, G-4, G-5, G-12)

| ID       | Threat                                                   | Adversary      | Status         |
| -------- | -------------------------------------------------------- | -------------- | -------------- |
| [[T-09]] | Plaintext vote reaches a server, log, analytics or chain | A-2, A-1       | Planned        |
| [[T-10]] | Account-to-ballot linkage on the server                  | A-2, A-1       | Planned        |
| [[T-11]] | Network-level linkage                                    | A-2, A-1, A-10 | Not mitigated  |
| [[T-12]] | Cross-poll linkability                                   | A-10           | Planned        |
| [[T-13]] | Anonymity-set narrowing                                  | A-10, A-2      | Partial        |
| [[T-14]] | Trustee collusion                                        | A-2, A-1       | Needs decision |
| [[T-15]] | Harvest now, decrypt later                               | A-11           | Partial        |
| [[T-16]] | Small-count disclosure                                   | A-10           | Not mitigated  |
| [[T-17]] | PII on-chain or on IPFS                                  | A-2, A-9, A-10 | Planned        |
| [[T-18]] | Voting-identity secret theft                             | A-3, A-4       | Partial        |
| [[T-19]] | Third-party proof app privacy                            | A-1, A-2       | Needs decision |
| [[T-20]] | Account-to-identity linkage through the recovery backup  | A-2, A-1       | Needs design   |
| [[T-21]] | Tier 2 proof front-running and trust roots               | A-9, A-1, A-6  | Needs decision |
| [[T-22]] | Tier 1 social graph exposure                             | A-2, A-1, A-10 | Needs design   |

### Integrity and verifiability (G-7, G-8, G-9)

| ID       | Threat                                      | Adversary     | Status       |
| -------- | ------------------------------------------- | ------------- | ------------ |
| [[T-23]] | Board tampering                             | A-2           | Planned      |
| [[T-24]] | Equivocation (split view)                   | A-2, A-1      | Planned      |
| [[T-25]] | Ballot or registration censorship           | A-2, A-1, A-7 | Planned      |
| [[T-26]] | Unprovable drops and false complaints       | A-2, A-1      | Planned      |
| [[T-27]] | Wealth-gated paths                          | A-1, A-9      | Partial      |
| [[T-28]] | Invalid ballots                             | A-9           | Planned      |
| [[T-29]] | Tally or decryption manipulation            | A-2           | Planned      |
| [[T-30]] | Weak Fiat–Shamir binding ("Frozen Heart")   | A-9, A-2      | Planned      |
| [[T-31]] | Encoding ambiguity and parser differentials | A-2, A-9      | Planned      |
| [[T-32]] | Ballot copying and replay                   | A-9, A-4      | Planned      |
| [[T-33]] | Re-vote resolution manipulation             | A-2           | Needs design |
| [[T-34]] | Election definition substitution            | A-2           | Planned      |
| [[T-35]] | Time manipulation                           | A-2, A-1      | Planned      |
| [[T-36]] | Verifier monoculture                        | A-2           | Planned      |
| [[T-37]] | Trustee key substitution                    | A-2           | Planned      |
| [[T-38]] | Ballot substitution and re-vote replay      | A-4, A-2, A-9 | Planned      |
| [[T-39]] | Cryptographic implementation flaws          | A-9, A-2, A-6 | Planned      |
| [[T-40]] | DKG manipulation                            | A-2, A-1      | Planned      |

### Client integrity and cast as intended (G-6, G-13)

| ID       | Threat                                    | Adversary     | Status  |
| -------- | ----------------------------------------- | ------------- | ------- |
| [[T-41]] | Targeted malicious client                 | A-2, A-1, A-7 | Planned |
| [[T-42]] | Compromised voter device changes the vote | A-3           | Partial |
| [[T-43]] | Script injection in the ballot client     | A-3           | Partial |
| [[T-44]] | Benaloh challenges are rare               | A-2, A-3      | Partial |

### Coercion and vote buying (G-11)

| ID       | Threat                                                       | Adversary | Status        |
| -------- | ------------------------------------------------------------ | --------- | ------------- |
| [[T-45]] | Observed coercion                                            | A-4       | Partial       |
| [[T-46]] | Vote buying by secret sale                                   | A-4       | Not mitigated |
| [[T-47]] | Proof of vote                                                | A-4       | Planned       |
| [[T-70]] | Pattern ("Italian") attack on individually decrypted ballots | A-4       | Planned       |

### Availability and censorship resistance (G-10)

| ID       | Threat                                              | Adversary                                                       | Status         |
| -------- | --------------------------------------------------- | --------------------------------------------------------------- | -------------- |
| [[T-48]] | DDoS                                                | A-5, A-1                                                        | Planned        |
| [[T-49]] | Domain or hosting seizure                           | A-7, A-1                                                        | Planned        |
| [[T-50]] | L2 censorship, reorg or failure                     | A-1, A-7                                                        | Planned        |
| [[T-71]] | L2 governance rewrites state or forges transactions | A-1 (and third-party L2 governance, not yet an adversary class) | Planned        |
| [[T-51]] | Data loss                                           | A-7, A-2                                                        | Planned        |
| [[T-52]] | Spam and flooding                                   | A-5, A-1                                                        | Planned        |
| [[T-53]] | Discreditation                                      | A-1                                                             | Partial        |
| [[T-54]] | Trustee unavailability                              | A-1, A-7                                                        | Needs decision |

### Development, supply chain and operations (G-14)

| ID       | Threat                                           | Adversary | Status  |
| -------- | ------------------------------------------------ | --------- | ------- |
| [[T-55]] | Malicious or hijacked npm dependency             | A-6       | Partial |
| [[T-56]] | Compromised GitHub Action or CI runner           | A-6       | Partial |
| [[T-57]] | Malicious insider change                         | A-2, A-8  | Partial |
| [[T-58]] | Prompt injection against the autonomous pipeline | A-8       | Partial |
| [[T-59]] | A PR weakens the gate that judges it             | A-8, A-2  | Partial |
| [[T-60]] | Compromised toolchain binary                     | A-6       | Partial |
| [[T-61]] | Release or publishing compromise                 | A-6, A-2  | Partial |
| [[T-62]] | Contract admin abuse                             | A-2, A-1  | Planned |
| [[T-63]] | Contract bug                                     | A-9, A-1  | Planned |
| [[T-64]] | Deployed bytecode differs from reviewed source   | A-2, A-6  | Planned |
| [[T-65]] | Deployer or service credential leak              | A-6, A-2  | Partial |
| [[T-66]] | Database loss or corruption                      | A-2, A-7  | Planned |
| [[T-67]] | Analytics and error-tracking leakage             | A-2, A-1  | Planned |
| [[T-68]] | Moderation abuse                                 | A-2, A-1  | Planned |
| [[T-69]] | Legal compulsion                                 | A-1, A-7  | Partial |

## Not mitigated

No planned work removes these. Each is stated wherever the affected feature appears.

- **T-01** Tier 0 is not Sybil-resistant. It is labelled as such and reported separately.
- **T-03 (part)** Holding two valid documents yields two Tier 2 identities; a document-issuing state can mint identities.
- **T-06 (Tier 0/1)** The operator can add members to Tier 0 and Tier 1 groups with no external check beyond public counts.
- **T-11** Network observers can correlate a voter's IP across registration and voting. Anonymity networks are the voter's only defence.
- **T-13 (part)** The registration paymaster links whoever requested sponsorship to an identity commitment.
- **T-14 / T-15** k colluding trustees can read ballots under every option. They can do it during the election, and afterwards for as long as they, or anyone who seizes or compels them, keep their key material: the DKG shares under ElGamal, or the KEM keys and share ciphertexts under P1-3 (option B). Option B requires that material to be destroyed after the tally, but destruction can't be proven, and shares posted on the board are permanent. A future cryptanalyst reads every ballot under threshold ElGamal; under P1-3's option B (accepted), only harvested share ciphertexts (post-quantum conjectured, or classical if ML-KEM is not used) and publicly posted shares (classical) remain exposed. Participation privacy rests on Poseidon's preimage resistance under every option.
- **T-16** Small per-tier counts reveal individual votes.
- **T-18 (part)** A stolen voting secret lets the thief vote and learn the victim's participation; revocation is undesigned.
- **T-42 / T-43 (part)** A fully compromised device or a malicious extension defeats the web client.
- **T-45 / T-46** Coercion beyond re-voting, forced abstention and vote buying by selling the secret.
- **T-53 (part)** Verifiability persuades only people who check.
- **T-71** The L2's governance can change its rules and state (instantly, on Base); we can only detect it.

## Change log

Closed on 2026-10-10. Later changes are recorded in each threat's own file (`## History`), so parallel PRs don't conflict here.

- 2026-10-09: first version (P1-1).
- 2026-10-09: T-70 added (pattern attack on decrypted ballots), and T-14, T-45 and T-54 updated, with the tally-scheme ADR (P1-4).
- 2026-10-09: T-71 added (L2 governance power over state), and T-35 and T-50 updated, with the L2-choice ADR (P1-5).
- 2026-10-09: T-17 and T-51 updated with the permanent-archive ADR (P1-6).
- 2026-10-09: T-14 and T-54 updated with the trustees ADR (P1-7).
- 2026-10-09: T-12, T-13, T-17, T-25, T-33, T-34, T-38, T-45 and T-47 updated with the spec skeleton (P1-8): the re-vote rule's requirements (no replay, no freezing, independence from the operator's ordering) replace the old "sequence number, then first appearance" ordering, which a maximal sequence number could freeze; display text is checked by the ballot client; chosen bytes in random fields are a stated residual.
- 2026-10-09: T-11, T-14, T-15, T-25, T-27, T-41, T-42, T-54 and the T-14 / T-15 not-mitigated entry updated with the everlasting-privacy ADR (P1-3).
- 2026-10-09: T-55 updated with the `packages/crypto` scaffold (P1-9): the gated-package dependency, import, symlink and bundle checks.
- 2026-10-10: P1-3 accepted (option B): T-14, T-15, T-28, T-29, T-37 and T-40 rewritten for commitments, summed shares and key registration; T-65 records the CI Docker Hub token (#19).
- 2026-10-10: T-60 updated with the toolchain-consistency check (P1-16b).
- 2026-10-10: each threat moved, unchanged, to its own file under `docs/threats/`; this file became the overview and index (P0-ops).
