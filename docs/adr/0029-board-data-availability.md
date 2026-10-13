# ADR 0029: Board data availability

- Status: Accepted (agent) — owner may veto (2026-10-13, rule A): option D
- Date: 2026-10-13
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-24, T-53, T-25, T-54, T-51, T-49, T-69, T-17 (see [[THREAT_MODEL]])

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

- **Capacity and cost.** A blob is 128 KiB. Ethereum's whole blob space is a handful of blobs per 12-second block (a target of 6 and maximum of 9 since Pectra, raised by later forks), shared by every rollup, at a market price. A ballot with its membership proof is tens of kilobytes, so a 10,000-voter election spread over 12 hours needs hundreds of blobs an hour, a significant share of all Ethereum blob space; a national one is impossible. Mainnet blob fees are spending (owner-only).
- **Entry-hash lists only.** At 32 bytes per entry these fit (100,000 entries an hour is about 25 blobs). They make every anchored extent's entry hashes public, so a tail can't hide its size. But hashes aren't payloads: a counted ballot whose payload is withheld still can't be checked, and a trustee node still can't recognise a ballot from its entry hash (the header holds fields the operator chose).
- **Tooling.** The anchoring job needs KZG commitments over the Ethereum trusted setup (an audited library such as c-kzg, in the worker, never in `packages/crypto`). The verifier needn't verify KZG, since it checks any copy against the anchored root, but a beacon node or blob archive becomes an input.

Kept as a later upgrade for entry-hash lists (Consequences), not chosen now.

### D. Content addresses in the checkpoint, plus the trustee panels as an availability committee before the result

B's checkpoint, plus a rule that makes the election's own trustees hold the board. The attestations come at two points, both before any result exists and while every seat still holds its per-election signing key. The key is destroyed only once every cell has a passing opening, or at the tally's own `t_D` after its window ([[tally]], Destruction).

1. **The ballot extent, held by `c_I`.** This is the board's segments through `s_A = period(closes_at) + 1`, which hold every ballot cast through the operator by the close. A ballot cast by the close is in a segment at most one period after it ([[delivery]], Direct submit), so that segment's checkpoint is due by `closes_at + 2 · period + deadline`. Direct-submitted ballots aren't in it: a node reads those from its own L2 node, as its view already does ([[delivery]], What a node owes). A ballot the operator boards after `s_A` is late, and this ADR makes lateness count against it, not the voter's other ballots: **a ballot that reached the board through the operator, first boarded in a segment after `s_A`, is never selected**, and the verifier reports it as boarded late, attributed to the operator. That gap isn't covered today: 5.6 covers only direct-submitted ballots, `tally-late` only entries after `s_S`, and the close rule (5.5) is still P1-18's. Without the rule, an operator could leave a voter's newest ballot out of the ballot extent, so every node shows it absent at `c_I` and owes only the older one's receipt, then board it after `c_I` where selection would pick it, undelivered. With it, the older ballot is selected and delivered, and the voter's client, holding no anchored receipt for the newest one by the ballot extent's deadline, falls back to direct submission ([[delivery]], Client rules), as it does whenever the operator refuses.

   The attestation states that the seat held the extent by `c_I`. It is submitted by `c_I` and counts if recorded by `t_A = c_I + F`, so a sequencer can delay it but not exclude it. The window bound becomes `DELIVERY_WINDOW ≥ max(2 · period + deadline + A, W_C) + F + R`, with `A` the fetch allowance. The deployed constants (hourly periods, a 12-hour deadline, `F` = 13 hours, `R` = 1 hour, 48 hours) leave `A` up to about 20 hours.

2. **The counted extent, before any summed share.** This is the extent through `s_S`, due at `t_S`, which fixes the counted set ([[tally]], Tally window). Here the attestation states that the seat held the extent by `t_S + A'`, where `A'` is a fixed fetch allowance. It is submitted by then and counts if recorded by `t_A' = t_S + A' + F`. A seat sends its summed share only after it has read each panel's quorum of counted-extent attestations from its own L2 node and finalized L1, never from the operator, so no one attests knowing a result. `A' + F + R` comes out of the 7-day tally window.

At each point, every qualified seat's node fetches every anchored segment object of the extent by its CID, from IPFS, the archive, the operator or another seat. It recomputes each counted checkpoint's root and head from those objects. If they all match, it signs an **availability attestation** with its per-election signing key ([[trustee-identity]]), under its own tag, over:

- the definition hash;
- the panel and seat;
- the attested checkpoint's hash.

An attestation states that the seat holds every segment object and entry-hash list of that extent. It binds the seat to publishing them: pinned on IPFS and served, through the archive's confirmation and the verification period after it.

A seat that can't fetch posts a signed **fetch complaint** naming the CID instead. Both records count **only through the L2 contract path** ([[delivery]], Direct submit), never through the board. The board copy is exactly what may be withheld, and the verdict must be decidable without it. The verifier reads these events from any L2 node and checks them against the board contract's event accumulator ([[0025-contract-event-evidence]]). The L2's batcher posts its data to L1, where it can be retrieved for about 18 days, and anyone can re-derive the L2 chain from it, so the anchoring authority can't withhold these events while it controls the board. The qualified seats and each panel's threshold are read the same way, from the L2's key and ceremony registration events (2.5, 3.1), never from the board's ceremony transcript, which may be withheld too.

The attesting seat MUST serve what it attested from the moment it attests, to other seats first and publicly, and keep it pinned through the archive's confirmation and the verification period after it.

The verifier adds a check that needs only L1 and the L2's events. It runs only if the attestation contract's events replay to an accumulator proven at or after `t_A`'s block (and `t_A'`'s). If that replay doesn't match ([[verifier]] 4.4), the result is unverifiable, never `unavailable`, so a withheld or erased attestation event can't fail an honest election. For each point and each panel, at least the panel's threshold of qualified seats (`k_D` for the default panel, and `k_A` for an author panel, [[0027-trustee-panels-and-live-results]]) must have attested in time. Otherwise the election **fails `unavailable`**. That failure takes precedence over the unverifiable verdicts a missing board copy gives (`checkpoint-missing`, `copy-mismatch`). The verdict is attributed to no single party, like `tally-missing`. It lists:

- the seats that attested;
- those that complained, each complaint being that seat's signed word against the authority;
- those that did nothing.

The registered key set bounds who can post. The board and the contract refuse a second attestation or complaint from a seat for the same checkpoint, so nobody can flood the archive (T-17).

This is a data availability committee, the pattern of Arbitrum AnyTrust ([docs](https://docs.arbitrum.io/how-arbitrum-works/anytrust-protocol)) and other DACs, with the committee chosen as the trustees we already trust for secrecy:

- **The trust assumption doesn't grow.** To get a withheld extent counted, the authority needs a panel's threshold of seats to attest to data they don't have. A coalition that large can already open individual ballots, since every seat still holds its shares at both points. Availability now rests on the same assumption as ballot secrecy, and no weaker one.
- **No veto over a result.** Both points come before any summed share exists. A seat that refuses to attest aborts the election before anyone knows its outcome, which its panel's threshold could do anyway by withholding the tally. The exception is a live poll ([[0027-trustee-panels-and-live-results]], Part 2): its running totals are public during voting, so a panel threshold can refuse a poll whose trend it dislikes. 0027 already accepts this for the tally, and attestation adds nothing new. [[tally]] (Destruction checks) rejects any rule that hands trustees a veto after the result, and this rule hands none (T-54). The new liveness duty does fall on the same seats, earlier: by `c_I` for the first point and by `t_A'` for the second.
- **Failure becomes a verdict.** A withheld ballot or counted extent can no longer reach a quorum. The election then fails `unavailable`, reproducibly from L1 and the L2's events, instead of staying unverifiable for good. That closes [[board]]'s withheld-tail residual for everything the counted set depends on, and [[receipts]]' `unresolved` limbo for ballots, except under a colluding threshold.
- **It closes P1-12c's residual.** At `c_I`, an honest node that attested the ballot extent holds every ballot, so it can show a receipted newest ballot absent ([[delivery]], What a node owes). Suppose the operator withholds until after `c_I` and releases later: honest seats couldn't attest in time, the election fails `unavailable`, and nothing is dropped silently. An honest node that couldn't fetch, while a quorum did, fetches from the quorum, which MUST serve it from the moment it attests. If the operator serves exactly a quorum and those seats then refuse to serve another, the quorum is colluding (below).
- **Attestations are evidence.** If a quorum attested and no public copy can be found, the signed attestations name who claimed to hold it.

Pros:

- Everything B gives.
- The ballots and the counted set become available or the election fails, under the secrecy assumption.
- Two attestations per seat per election (cheap).
- No new primitives: ECDSA P-256 statements, as receipts and complaints already use.

Cons:

- **The transitional panel.** Until independent trustees are named ([[P1-7]]), the default panel is the operator's alone ([[0027-trustee-panels-and-live-results]], decision 4). Its attestations are the operator vouching for itself, so under that panel this option gives only B's guarantees plus signed self-attestations. An author panel restores the protection for that author's polls.
- **Trustees fetch on a deadline.** Hundreds of megabytes to gigabytes, within `A` (up to about 20 hours under the deployed constants) and `A'`. Part 2c fixes `A` and `A'` and adds `A` to `deliveryWindowFits`. If it lengthens `DELIVERY_WINDOW`, `COMPLAINT_WINDOW` moves with it (their gap must stay at least `W_C + F + R`), and so does the seal. Both are constants of delivery version 1, still unfrozen because no election can be registered yet.
- **The L2's own data is a dependency.** The verdict rests on the L2's events being retrievable. They are, from any L2 node, for as long as the L2's history is kept: its batches sit in L1 blobs for about 18 days, and after that in archive nodes and our archive. That is the same dependency every contract event already has ([[0025-contract-event-evidence]]).
- **The tally window shrinks** by `A' + F + R` before the first summed share.
- **The tail after the counted extent isn't covered.** That tail holds spoiled-ballot openings, tally openings and destruction statements. A quorum over it would come after the result, so it stays as today: a withheld or forked tail there leaves the election unverifiable, never failed (T-54). The result rests on the tally openings in that tail, but anyone holding them, the publishing seats included, can complete the record.
- **Withholding during the election isn't judged until the ballot extent.** Within an election, B's CIDs and the receipt checks are what a voter has.
- **Attest, then withhold.** A quorum can attest, then every attesting seat and the authority can withhold. The election then stays unverifiable, with the attesters named; it isn't failed.
- **More parts.** A new checkpoint version and anchor deployment, two records and a contract call, a new verifier check and a window term, and a fetch-and-check job on every trustee node.

## Recommendation

**D.** It is the only option that turns withholding of the ballots and the counted set into a reproducible failure without putting the board on chain. It does so under the assumption the system already makes for secrecy, and before any result, so it adds no veto. B on its own leaves the authority able to claim and withhold. C makes the commitment layer available but not the payloads, at a cost that grows with turnout. A judges by the verifier's network.

What would change it:

- If the transitional panel lasts long enough to matter for real elections, C's entry-hash-list blobs become worth their cost: they make an extent's size public under the operator-only panel.
- If L1 blob capacity grows by orders of magnitude, or an L2 with guaranteed availability can carry the payloads, C becomes worth revisiting for the payloads too.

## Consequences

- **Checkpoint version 2** ([[board]], [[contracts]]; P4-3 part 2b, with P4-1):
  - **Fields.** `election_id ‖ u32(segment) ‖ u64(size) ‖ head ‖ root ‖ object_cid ‖ hashes_cid`, 180 bytes, with each CID the 36-byte binary CIDv1 of [[content-addressing]].
  - **Its own hash tag,** so no encoding of version 1 and version 2 can collide.
  - **CID rules,** each violation a failure attributed to the anchoring authority, like `checkpoint-inconsistent`:
    - each CID is `objectCid` of exactly the bytes whose entries give the anchored root and head, under [[content-addressing]]'s parameters, so no non-canonical CID (such as a single raw block over 1 MiB, which IPFS peers won't transfer) is valid;
    - `hashes_cid` is the entry-hash list of the bytes `object_cid` names;
    - a checkpoint with no new entries (a re-anchor, or an empty seal) carries the previous checkpoint's CIDs, and one with new entries carries fresh ones.
  - **A new `BoardAnchor` deployment** taking 180-byte checkpoints and logging the CIDs. Nothing is deployed yet.
  - **Gas:** about 2,000 more per checkpoint (calldata, log data, and the accumulator hashing them).
- **The verifier fetches by CID from L1 alone.** A board copy is assembled from the anchored CIDs. Every fetched object is checked against its CID and the anchored roots, with sizes capped (T-49, T-24; [[content-addressing]], Still to come). `board.bin` stays as a local input.
- **Availability attestations and fetch complaints** ([[board]] or [[delivery]]; P4-3 part 2c):
  - two record types, signed under their own tags by the seat's per-election signing key;
  - the direct-submit call on the L2 board contract (P1-18), refusing unregistered seats and repeats, the only path these records count through;
  - `s_A`, `A`, `A'`, `t_A = c_I + F` and `t_A' = t_S + A' + F`, all fixed by the definition and the pinned constants, with `deliveryWindowFits` extended as above. `A` starts once the `s_A` checkpoint is final on L1;
  - the rule that a board-path ballot first boarded after `s_A` is never selected, reported as late and attributed to the operator ([[revoting]], [[verifier]] 5.x, with P1-18's close rule);
  - the amendments to [[tally]] (no summed share before `t_A' + R`, out of `TALLY_WINDOW`) and [[delivery]] (the bound with `A`, and the "28 hours" figure);
  - the rule that a seat sends no summed share before it reads the counted extent's quorum from its own L2 node and finalized L1 ([[tally]]);
  - a verifier check, from L1 and the L2's events alone, that fails `unavailable` below a panel's threshold at either point, ahead of any unverifiable verdict from a missing board copy;
  - the fetch, attest and publish job on trustee nodes, which pins what it attested at least until the archive confirms it and the verification period after the seal (P4-5).
- **Reference election.** Stage 8 rebuilds from L1 CIDs and IPFS. Stage 9 verifies with our servers offline. A run where the authority withholds part of the ballot extent must fail `unavailable`, with the seats' complaints.
- **Residuals closed once built** (each closes when 2b and 2c merge, not before):
  - [[board]]'s withheld or forked tails, through the counted extent, except under a colluding panel threshold;
  - [[receipts]]' unresolved evidence for ballots;
  - [[delivery]]'s newest-ballot residual (also needs the transitional panel to end, as below);
  - [[verifier]]'s anchored-encoding residual.
- **New known-weak:**
  - Under the transitional panel, D reduces to B plus the operator's self-attestation. The [[P1-12c]] residual stays open until [[P1-7]] names independent trustees, or the owner accepts it for polls under the transitional panel.
  - The tail after the counted extent stays unverifiable, never failed, when withheld.
  - Under a live poll, a panel threshold that dislikes the running trend can refuse to attest, as it can refuse the tally ([[0027-trustee-panels-and-live-results]]).
  - The verdict depends on the L2's history staying retrievable: from L1 blobs for about 18 days, and after that from L2 archive nodes, or from our archive, which the operator may run. The accumulator proof also rests on the L2's output root, so a false root from the proposer (T-71, T-50) can make the check unverifiable, though never `unavailable`.
  - A board-path ballot first boarded after `s_A` is never counted. A voter whose newest ballot the operator holds back keeps the older one counted, and must direct-submit to change it.
  - The tally window shrinks by `A' + F + R`, and a longer `DELIVERY_WINDOW` moves `COMPLAINT_WINDOW` and the seal later.
  - Attest-then-withhold leaves the election unverifiable, with the attesters named.
  - A colluding panel threshold can attest to withheld data, as it can open ballots.
  - Compelling a threshold to sign a false attestation needs the same coalition as opening ballots, but leaves less trace than a decryption.
- **Follow-up items:**
  - P4-3 part 2b: checkpoint version 2 and the anchor.
  - Part 2c: attestations, the window and the verifier check.
  - Part 2d: the reference election's withholding run.
  - Part 3 (archive manifests) and part 4 (mirroring) keep their places in the plan.

## Decision

Under rule A (`AGENTS.md`): option D, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].

- The owner may prefer to accept the [[P1-12c]] residual for polls under the transitional panel rather than wait for [[P1-7]]. That acceptance is the owner's (STATUS Known-weak already says so), and nothing here decides it.
- Mainnet blob fees, if C is ever added, are spending and wait for the owner.
