# ADR 0029: Board data availability

- Status: Accepted (agent) — owner may veto (2026-10-13, rule A): option D
- Date: 2026-10-13
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-24, T-53, T-25, T-51, T-49, T-69, T-54 (see [[THREAT_MODEL]])

## Context

Every hour the anchoring authority puts a checkpoint of each running election's board on L1 ([[board]], Segments and checkpoints; [[contracts]], Board anchor). A checkpoint is 108 bytes (`election_id ‖ u32(segment) ‖ u64(size) ‖ head ‖ root`): it commits to the board's entries but says nothing about where they are, and nothing makes anyone publish them. Three open residuals come from that:

- **Withheld or forked tails** ([[board]], Residuals). The authority can anchor a seal that extends every voter's receipt with entries it never publishes, or one of the honest size that forks only after the last receipt. Every receipt check passes, every published copy fails `checkpoint-missing` or `copy-mismatch`, and the election stays unverifiable for good, never failed, with nothing naming the key (T-24, T-53, T-69). Receipts it leaves `unresolved` stay evidence of nothing in particular ([[receipts]], Residuals).
- **A newest ballot that never reached the board** ([[delivery]], Residuals; [[P1-12c]]). A trustee node owes contract-path receipts only for what it selects from its view at the intake cutoff `c_I`, and it can show a receipted ballot absent only from the board's data. If the operator withholds that data, the older ballot the delivery check selects keeps only its board-path receipts. STATUS Known-weak says this MUST be closed (by this item) or accepted by the owner before any election registry is deployed (T-25, T-54).
- **Anchored encodings a copy can't carry** ([[verifier]], Inputs): with no content address on L1, a verifier needs our archive manifests (behind the locator) or our servers to know which bytes to fetch. The brief requires verification from chain + IPFS alone, with our servers and domain offline.

[[0002-everlasting-privacy]] (Decision, 2026-10-12) left "a content address per anchored segment and a publication deadline" to P4-3 as the complement of membership-checked intake.

The core difficulty is that **non-publication of off-chain data can't be proven.** Anyone holding bytes can show they were published; nobody can show that bytes exist nowhere. Only data the chain itself carries is guaranteed available, and the board (tens of kilobytes per ballot, a few hundred megabytes per 10,000 entries, [[0005-permanent-archive]]) is too large for that. So the choice is how close to "provable" we can get, and who has to misbehave for withholding to go unattributed.

It is one-way because the checkpoint is anchored on L1 for good, its encoding and the anchor contract are fixed once deployed (`BoardAnchor` is immutable), and every verifier must judge every past election by the rule chosen now. Nothing is deployed yet ([[contracts]], Board anchor, Known-weak), so changing the checkpoint now costs only a new version and a redeploy.

## Options

### A. A publication deadline judged by reachability

[[board]]'s first candidate: an anchored extent that is still unpublished once the seal's deadline plus an archive grace period has passed counts as a failure of the anchoring authority. No contract change.

Pros: simple; turns "unverifiable for good" into a verdict.

Cons: "unpublished" here means "this verifier couldn't fetch it". Verdicts then depend on the verifier's network: a state actor that blocks a verifier's access to IPFS and Arweave makes an honest election read as failed (T-53, discreditation), and the verdict can flip from failed to verified when the data turns up. A failure verdict must be reproducible by anyone from public data, and this isn't. Rejected.

### B. A content address per segment in the checkpoint, with archive listing as the publication proof

The checkpoint gains the CID of the segment's object and of its entry-hash list ([[content-addressing]]; 36 bytes each), so L1 names the exact bytes behind every anchor. Publication is then judged against the permanent archive: every anchored CID must be listed, with its Arweave location, in a manifest named by an L1 locator ([[0005-permanent-archive]]) before a deadline, and a missing listing fails the election, attributably to the authority.

Pros: verification from chain + IPFS alone (the CID is on L1); one exact object per anchor, so no `copy-mismatch` guessing; a missing listing is checkable from L1 and the manifest chain.

Cons: a listing proves the authority **claimed** to archive the data, not that anyone can get it. An Arweave transaction's header can be mined without its data ever being seeded, and the manifests themselves can be withheld, so the authority can still list and withhold. Within the election it gives trustee nodes nothing at `c_I`. It narrows the attack to a dishonest authority writing false listings, which is exactly the authority this residual is about.

### C. On-chain data availability: EIP-4844 blobs

The anchoring transaction carries each segment's object (or only its entry-hash list) as [EIP-4844](https://eips.ethereum.org/EIPS/eip-4844) blobs, and the anchor records their versioned hashes (`BLOBHASH`). Consensus nodes accept a block only if its blobs were available, so for the retention period (4,096 epochs, about 18 days) anyone with a beacon node can fetch them, and the archive keeps them afterwards.

Pros: availability is guaranteed by L1 consensus, not by anyone's honesty, for the window that matters (the election and its tally).

Cons:

- **Capacity and cost.** A blob is 128 KiB. Ethereum's whole blob space is a few blobs per 12-second block, shared by every rollup, at a market price. A ballot with its membership proof is tens of kilobytes, so a 10,000-voter election spread over 12 hours needs hundreds of blobs an hour, a significant share of all Ethereum blob space; a national one is impossible. Mainnet blob fees are spending (owner-only).
- **Entry-hash lists only.** At 32 bytes per entry these fit (100,000 entries an hour is about 25 blobs). They make every anchored extent's entry hashes public, so a tail can't hide its size. But hashes aren't payloads: a counted ballot whose payload is withheld still can't be checked, and a trustee node still can't recognise a ballot from its entry hash (the header holds fields the operator chose).
- **Tooling.** The anchoring job needs KZG commitments over the Ethereum trusted setup (an audited library such as c-kzg, in the worker, never in `packages/crypto`). The verifier needn't verify KZG, since it checks any copy against the anchored root, but a beacon node or blob archive becomes an input.

Kept as a later upgrade for entry-hash lists (Consequences), not chosen now.

### D. Content addresses in the checkpoint, plus the trustee panels as an availability committee

B's checkpoint, plus a rule that makes the election's own trustees hold the board. After the seal is anchored, every qualified seat's node fetches every anchored segment object by its CID (from IPFS, the archive, the operator or another seat), recomputes each counted checkpoint's root and head from it, and, if they all match, signs an **availability attestation** with its per-election signing key ([[trustee-identity]]) over the definition hash and the seal checkpoint's hash. An attestation states that the seat holds every segment object and entry-hash list of every counted checkpoint through the seal, and binds the seat to serving them. It is posted through the board or, since the operator is the adversary here, directly through the L2 contract path, like a share posting ([[delivery]], Direct submit). It counts if recorded by the **attestation deadline** `t_A`, which falls after the seal's anchoring deadline and no later than the intake cutoff `c_I`.

The verifier adds a check after the anchoring checks: for each panel, at least its threshold of qualified seats (`k_D` for the default panel, and `k_A` for an author panel, [[0027-trustee-panels-and-live-results]]) must have attested the seal checkpoint by `t_A`. Otherwise the election **fails `unavailable`**, attributed to the anchoring authority. The verdict lists the seats that attested and those that didn't, so trustee absence is visible too.

This is a data availability committee, the pattern of Arbitrum AnyTrust ([docs](https://docs.arbitrum.io/how-arbitrum-works/anytrust-protocol)) and other DACs, with the committee chosen as the trustees we already trust for secrecy:

- **The trust assumption doesn't grow.** For the authority to have a withheld extent counted, a panel's threshold of seats must attest to data they don't have. A coalition that large can already open individual ballots. So availability now rests on the same assumption as ballot secrecy, and no weaker one.
- **Liveness doesn't shrink much.** A panel's threshold must be online after close anyway to publish the tally ([[tally]]), and `t_A` falls in the same window.
- **Failure becomes a verdict.** A withheld tail can no longer reach a quorum, so the election fails `unavailable`, reproducibly from public data (L1 and the L2's events), instead of staying unverifiable for good. That closes [[board]]'s residual and [[receipts]]' `unresolved` limbo, except under a colluding threshold.
- **It closes P1-12c's residual.** At `c_I` an honest attesting node holds the whole counted board, so it can show a receipted ballot absent (the delivery rule of [[delivery]], What a node owes). Either a threshold of seats held the board by `t_A ≤ c_I`, and an honest node that couldn't fetch it gets it from them, or the election fails `unavailable` and nothing is dropped silently.
- **Attestation becomes attributable evidence.** If, after a quorum, no copy can be found, the signed attestations name who claimed to hold it.

Pros: everything B gives; availability failures become verdicts; it closes all three residuals under the secrecy assumption; one attestation per seat per election, on the L2 (cheap); no new primitives (ECDSA P-256 statements, as receipts and complaints use).

Cons:

- **The transitional panel.** Until independent trustees are named ([[P1-7]]), the default panel is the operator's alone ([[0027-trustee-panels-and-live-results]], decision 4). Its attestations are the operator vouching for itself. Under that panel this option gives only B's guarantees plus signed self-attestations. An author panel restores it for that author's polls.
- **Trustees fetch the whole board.** Hundreds of megabytes to gigabytes per election, before `t_A`. That is heavier than intake alone, but every seat already reads the board for the tally.
- **Withholding before the seal isn't caught until the seal.** Within an election, B's CIDs and the receipt checks are what a voter has; the quorum judges the seal.
- **More parts.** A new checkpoint version and anchor deployment, a new record and contract call, a new verifier check and window, and a fetch-and-check job on every trustee node.

## Recommendation

**D.** It is the only option that turns withholding into a reproducible failure without putting the board on chain, and it does so under the assumption the system already makes for secrecy. B on its own leaves the authority able to claim and withhold. C makes the commitment layer available but not the payloads, at a cost that grows with turnout. A judges by the verifier's network.

What would change it:

- If the transitional panel lasts long enough to matter for real elections, C's entry-hash-list blobs become worth their cost: they make an extent's size public under the operator-only panel.
- If L1 blob capacity grows by orders of magnitude, or an L2 with guaranteed availability can carry the payloads, C becomes worth revisiting for the payloads too.

## Consequences

- **Checkpoint version 2** ([[board]], [[contracts]]; P4-3 part 2b, with P4-1):
  - Fields: `election_id ‖ u32(segment) ‖ u64(size) ‖ head ‖ root ‖ object_cid ‖ hashes_cid`, 180 bytes, with each CID the 36-byte binary CIDv1 of [[content-addressing]].
  - Empty segments: a checkpoint for a period with no new entries (a re-anchor, or an empty seal) carries the previous segment's CIDs, never zeros.
  - Its own hash tag, so a version 1 and a version 2 encoding can never collide.
  - A new `BoardAnchor` deployment taking 180-byte checkpoints and logging the CIDs. Nothing is deployed yet.
  - Gas: about 1,200 more per checkpoint for calldata.
- **The verifier fetches by CID from L1 alone.** A board copy is assembled from the anchored CIDs, every fetched object is checked against its CID and against the anchored roots, and sizes are capped (T-49, T-24, [[content-addressing]], Still to come). `board.bin` stays as a local input.
- **Availability attestations** ([[board]] or [[delivery]]; P4-3 part 2c):
  - A new record type, signed under its own tag by the seat's per-election signing key.
  - A direct-submit call on the L2 board contract (P1-18).
  - `t_A`, with the window relations `deliveryWindowFits` checks extended to `t_A ≤ c_I`.
  - A verifier check after 4.2 that fails `unavailable` below a panel's threshold.
  - The fetch-and-attest job on trustee nodes, which also pins what it attested until the archive confirms it (P4-5).
- **Reference election.** Stage 8 rebuilds from L1 CIDs and IPFS, stage 9 verifies with our servers offline, and a run where the authority withholds the seal's tail must fail `unavailable` naming the authority.
- **Residuals closed once built** (each closes when 2b and 2c merge, not before):
  - [[board]]'s withheld or forked tails, except under a colluding panel threshold;
  - [[receipts]]' unresolved evidence, which then resolves to `unavailable`;
  - [[delivery]]'s newest-ballot residual, which also needs the transitional panel to end, as below;
  - [[verifier]]'s anchored-encoding residual.
- **New known-weak:**
  - Under the transitional panel, D reduces to B plus the operator's self-attestation. The [[P1-12c]] residual stays open until [[P1-7]] names independent trustees, or the owner accepts it for polls under the transitional panel.
  - Withholding detected only at the seal, not during the election.
  - A colluding panel threshold can attest to withheld data, as it can open ballots.
- **Follow-up items:** P4-3 part 2b (checkpoint version 2 and the anchor), part 2c (attestations, the window and the verifier check), and part 2d (the reference election's withholding run). Part 3 (archive manifests) and part 4 (mirroring) keep their places in the plan.

## Decision

Under rule A (`AGENTS.md`): option D, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. The owner may prefer to accept the [[P1-12c]] residual for polls under the transitional panel instead of waiting for [[P1-7]]; that acceptance is the owner's (STATUS Known-weak already says so), and nothing here decides it. Mainnet blob fees, if C is ever added, are spending and wait for the owner.
