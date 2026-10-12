# ADR 0021: Challenged ballots stay off the board until their opening

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-12
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-42, T-44, T-47, T-41, T-45, T-11, T-17, T-52, T-12 (see [[THREAT_MODEL]])

## Context

The brief requires cast-as-intended by Benaloh challenge and spoil. The voter's client encrypts the vote and commits to the result before the voter chooses to cast it or to challenge it; a challenged ballot is opened (its vote and every bit of randomness revealed), checked, and never counted, and the voter then votes again (J. Benaloh, "Simple Verifiable Elections", EVT 2006; "Ballot Casting Assurance via Voter-Initiated Poll Station Auditing", EVT 2007). The client can't tell which ballots will be challenged, so a client that changes votes is caught with probability that grows with every challenge (T-42, T-44).

Most of the mechanics are already fixed. The part of a ballot a challenge can audit is its **core**: the definition, the tier, the VSS commitments `vss` and the share-ciphertext hashes `share_hashes`, all made before the nullifier is used ([[ballot-validity]], Casting step 1; [[share-encryption]], Notes). The proofs, the L1 reference and the membership proof come only after the voter chooses to cast ([[revoting]], Client rule 6), so a challenged ballot carries nothing that depends on the nullifier. An opening reveals the vote, the sharing polynomials and each seat's `(m_i, e_i, w_i)`, from which anyone rebuilds every ciphertext and so the core ([[0002-everlasting-privacy]], Consequences; [[share-encryption]]). Publishing an opening is opt-in, off by default, and sent only after close; the board sorts openings canonically within each anchoring period ([[verifier]] 6.2; [[board]], Spoiled-ballot openings).

What is still open, and what [[board]] and [[revoting]] (Residuals) require P1-13 to settle: **where the challenged core is committed, and whether it is posted to the board when it is challenged.** [[verifier]] 6.2 assumed it would be ("the challenged ballot it opens, which is itself a board entry posted in the casting session") and asked P1-13 to keep that entry from being tied to the cast ballot. A cast ballot's L1 reference publishes when it was made, to about 12 seconds, and the operator can't blur that ([[revoting]], Residuals), so anything boarded in the same session is a timing link, and an opening usually shows the voter's real choice (T-47, T-12).

This is one-way: what the board carries is permanent and archived ([[0005-permanent-archive]]), the record layouts are frozen by their vectors once anything under them is anchored, testnet included ([[versioning]]), and every pinned ballot client and verifier implements the flow.

## Options

### A. Board the challenged core at challenge time; open it later

When the voter challenges, the client posts the core (a record of its own, `0x0002`'s sibling) through our API, as ElectionGuard submits a challenged ballot to the ballot box and publishes it in the election record (J. Benaloh and M. Naehrig, ElectionGuard Design Specification 2.0). The opening, published after close if the voter opts in, names that entry.

- **Pros:** a public, anchored, timestamped commitment exists before the opening, so a published opening shows to anyone that the client committed to that core when it says it did.
- **Cons:**
  - **Timing link.** The challenged entry lands in the casting session. Its segment, and usually its neighbours, put it within the hour of a cast ballot whose L1 block fixes its time to 12 seconds. Batching challenged cores to the end of a period, as openings are, hides the order within the period but not the period, and a period holds few casts in a small election. Once the voter publishes the opening (often showing the real vote), the link reaches the cast ballot and its nullifier (T-47, T-12, T-45).
  - **Unauthenticated flood.** A challenged core has no membership proof (it can't: Client rule 6), so anyone can post any number of them, each up to about 45 KB of chosen-looking bytes kept in the permanent archive (T-17, T-52), with only an API rate limit in the way.
  - **The commitment it adds isn't the one Benaloh needs.** Benaloh's soundness rests on the client committing before it learns the voter's choice. The voter's check compares the opening against what the casting device showed before the choice, not against the board; a board entry posted after the voter pressed "challenge" proves only that the client posted something after the choice.

### B. The commitment is the tracking code; the core travels inside the opening

The casting device shows the core's hash, the **tracking code**, before the cast-or-challenge choice, always as a QR code of the full 256-bit hash (with a short human-readable rendering beside it). A challenged core is never posted on its own. The opening record (`0x0003`) carries the core and its opening together, and is published only if the voter opts in, after close, canonically ordered. Helios has the same shape: an audited ballot's randomness goes to the voter, who may post it to a public list of audited ballots afterwards (B. Adida, "Helios: Web-based Open-Audit Voting", USENIX Security 2008). The default check runs on a device or checker the voter chooses:

1. Before choosing, the voter may scan the tracking code with the second device, which records it. Scanning is passive: the casting device always shows the code and can't tell whether it was scanned (T-44). A check without a code recorded before the choice compares the opening only with what the casting device shows afterwards, which malware on it controls.
2. **Challenge:** the casting device hands over the opening (QR code or file, never through our API). The second device rebuilds the core from the opening, the definition and the registered trustee keys, recomputes the tracking code, compares it with the one it recorded, and shows the vote with the definition's display text ([[display-text]], Client rules). The casting device then makes a fresh sharing for the next attempt; it never casts a core it has opened.
3. **Cast:** the second device later finds the cast ballot on the board (or in the receipt, P1-13b) by its tracking code, which anyone can recompute from a ballot record, and checks its admission and selection ([[revoting]], Owned elsewhere).

- **Pros:**
  - **No timing link from challenging.** Nothing reaches the board when the voter challenges, so a challenge leaves no entry near the cast ballot. A published opening is linked to its period after close, never to the session (T-47, T-42).
  - **No unauthenticated traffic during voting.** Openings are accepted only after close, so the board carries nothing a non-member can post while the poll runs; after close an opening's size is bounded by the definition, as a ballot's is.
  - **The commitment is the one Benaloh needs:** made before the choice, held by a device the voter chose.
  - **The cast check reuses it.** The tracking code of the cast ballot is computed from its record, so the same code links the pre-choice commitment to the receipt check.
- **Cons:**
  - **A published opening is weaker evidence to third parties.** It shows that a core with that tracking code opens to that vote, and that the core is not a cast ballot's (below); that the casting device showed that code before the voter chose rests on the voter's word and their second device's record. Under A it rests on the same word: the voter's intent is never provable, and A's board entry follows the choice.
  - **Collisions of the short code.** A client that finds two cores, encrypting different votes, whose short codes agree can open one and cast the other. The check therefore relies only on the full hash, carried by QR code or file; the short code is a convenience and the spec says so. A 256-bit hash gives 128-bit collision resistance.
  - **The voter needs a second device** for a check that resists malware on the first (T-42's status already says so); a single-device check is a check of the software, not of the device.

### C. Board a nullifier-bound challenged ballot

The challenged ballot carries the nullifier and a membership proof, so the board can rate-limit challenges per voter.

- **Rejected:** it contradicts [[revoting]] Client rule 6 (a proof made before the choice lets whoever holds it post the challenged ballot as cast, tying the real one) and puts the voter's nullifier on every challenged ballot, which an opening then links to the vote (T-47, T-45).

## Recommendation

**B.** A's only advantage, a public timestamp, comes after the choice and so adds nothing to Benaloh's soundness, while its timing link is exactly the residual [[revoting]] asks P1-13 to remove, and its unauthenticated flood is new. B keeps the commitment where the protocol needs it (before the choice, on a device the voter chose) and puts nothing on the board until the voter opts in after close.

What would change it: a later need for publicly timestamped challenges (for instance, an audit statute requiring that challenges be counted during the election), which would need A with a design for the timing link, and a rate limit that doesn't identify the voter.

## Consequences

- **Spec (P1-13 part 3b):**
  - [[ballot-validity]] gains the **core hash** `core_hash = H(DS("abolish/v1/ballot-core", definition_hash ‖ u8(tier) ‖ encode(vss) ‖ encode(share_hashes)))`, the tracking code, computable from a cast ballot record and from an opening. The tag is registered in [[domain-separation]].
  - **Record `0x0003`, spoiled-ballot opening, version 1** ([[versioning]]): the core (`definition_hash`, `tier`, `vss`, `share_hashes`) and its opening (each option's value and sharing polynomials, and each registered seat's `(m_i, e_i, w_i)`; seats outside the registered key set carry nothing, their share hashes being zero). Its checks rebuild `vss` from the opening, each seat's shares and ciphertext under the registered keys ([[share-encryption]], Ciphertext; [[ceremony]]), and compare every `H(ct_i)` with `share_hashes[i]`. A vote outside the election's rules still opens (the opening shows what the client encrypted); the checker reports it.
  - [[verifier]] 6.2 is rewritten: an opening verifies against the core it carries, never against a board entry; an opening whose core equals an admitted ballot's core (`opening-cast`, which only a client that kept a cast ballot's randomness can make, T-47) is reported against the board operator, who MUST refuse it, and never changes what counts; an opening in a segment that ends at or before `closes_at` is reported against the operator (`opening-early`).
  - [[board]]: `0x0002` carries cast ballots only, and the Spoiled-ballot openings section states B's placement; [[revoting]]'s challenged-ballot residual is closed by it; [[share-encryption]]'s spoiled-ballot note points at the record.
  - Client rules: the tracking code is always shown, as a full-hash QR code, before the choice; an opened core is never cast; the randomness is erased on cast; the opening leaves the device only by QR code or file, and is published only at the voter's request, after close, through the board path.
- **Code (P1-13 part 3b):** `packages/crypto` gains `coreHash`, the opening's codec, `openChallenge` (the client's side, revealing only a sharing it made itself and hasn't cast) and `checkOpening`, with vectors from an independent Python implementation.
- **P1-13b:** the receipt check finds the cast ballot by its tracking code.
- **P2-8 and P5-4:** the ballot client's challenge flow and the second-device checker.
- **What stays weak:** the voter's intent is never provable to a third party; a malicious client can still remember which voters have challenged before and cheat the others (T-44, T-41); a voter without a second device checks only the software; a published opening can be linked to its publisher by network metadata and usually shows the real vote (T-11, T-12, T-47); and openings published after close are unauthenticated and bounded only by size and the API's rate limit (T-17, T-52).

## Decision

Under rule A (`AGENTS.md`): option B, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto before P1-13 part 3b's vectors are anchored anywhere costs only the spec and code of that part.
