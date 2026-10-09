# Verifier

What an independent verifier must check to accept an Abolish election result, using chain and IPFS data alone, with our servers and domains offline (G-9, T-36). `packages/verifier` implements this list, and a third party can implement it from this spec in any language. P1-19 extends this page with the verifier's procedure, inputs and report format.

Each check names the threats it closes and the STATUS item that specifies it. A check whose section isn't written yet is still required: until it exists, no verifier can claim the election verified. Checks marked **(P1-3)** change shape with the everlasting-privacy ADR, which is still open.

## Principles

- **Trust nothing served.** Every input comes from L1, the L2, IPFS, the permanent archive or local files, and is checked against L1 anchors or the evidence it carries. Nothing is accepted because an Abolish server said so, and no Abolish server or domain is contacted (T-24, T-49, T-69).
- **Fail loudly.** Each check ends in pass, fail or unverifiable (data missing, a source unreachable, a root not yet settled). Unverifiable is never reported as pass.
- **Two kinds of check.** Anyone can post a ballot, so a bad ballot must never fail an election (T-52, T-53), and every conforming verifier must reach the same verdict on the same data (T-36):
  - **Admission checks** decide whether one ballot or opening counts: decoding of the record inside a board entry, 5.1 to 5.5, 5.7, 6.1's admission part and 6.2. A failure rejects that entry only. A rejected entry is listed in the report (8.3), never counted and never displaces an earlier ballot (6.1, R4).
  - **Election checks** are everything else: 1.x, 2.x, 3.x, the board-entry envelope and hash chain in 4.1, 4.2 to 4.5, 5.6, 7.1 to 7.3 and 8.x (7.4 reports only). The election is verified only if every election check passes.
  - Our contracts accept a direct submission only if it decodes strictly (and SHOULD also check its membership proof), and revert otherwise (P1-18), so nothing undecodable reaches an L2 event, the board or the permanent archive (T-17, G-12), and no one can make 4.1 or 5.6 fail by posting junk. A record that decodes but fails another admission check is boarded as a rejected entry.
- **Strict decoding first.** Every record is decoded strictly ([[notation]]) before any other check uses it, and rejected entries are reported, never skipped silently (T-31, T-52).
- **Pinned trust roots.** The verifier's release pins what can't be derived from data: the L1 and L2 chain IDs, the addresses of the anchor contract and our L2 contracts, the canonical L2 portal on L1, the L2 derivation rules it applies, the release-signing identities, and the verification key of every proof system it accepts, per ballot record version (Semaphore's per-depth keys, or the zero-knowledge UltraHonk key of our Noir circuit), built from reviewed source. Changing any of them is a new verifier release (T-64, T-71, T-05). No proof is ever verified under a key taken from election data alone.

## Checks

### 1. Ballot client and contracts

- 1.1 A served ballot client matches a signed, reproducible release: its bytes hash to a release hash signed by the release identity (T-41, G-13; P1-19, P2-8).
- 1.2 The bytecode at every contract address the election uses matches the release build of reviewed source (T-64; P1-18, P1-19).
- 1.3 The verification-key hash in the election definition, and every key inside a verifier contract the election uses, equals the pinned key for the ballot version the profile names; a definition naming any other key fails (T-05, T-04, T-64; P1-17, P1-18).

### 2. Election definition

- 2.1 The definition decodes strictly, and its hash (`abolish/v1/election-definition`) equals the hash registered on L2 before voting opened (T-34; P1-10, P1-18).
- 2.2 It binds the chain ID and contract addresses the ballots were submitted to, so nothing can be replayed from another chain or deployment (T-30, T-32; P1-10).
- 2.3 Its election type and tally scheme are ones this verifier supports, its profile pins a version for every record type the election uses, and every record the election's authors write (the definition, board-entry envelopes, ceremony and tally transcripts) uses exactly the version its profile pins (`profile-mismatch` otherwise). A record anyone can post (a ballot, a spoiled-ballot opening) with an unpinned version is rejected at admission with `profile-mismatch` and listed in 8.3, never an election failure and no version it pins was retired before the definition was registered ([[versioning]]; T-31, T-34, [[0003-tally-scheme]]).
- 2.4 Its electorate is a group root per tier at a fixed L2 block, and that root matches the root computed from the board's record of signed group additions, never the L2 state alone (T-08, T-13, T-06, T-71; P1-18, P3-2).
- 2.5 Its trustee panel (keys, `k`, `n`, panel identifier) matches the ceremony transcript and the keys registered on L2 (T-37, [[0006-trustees]]; P1-14, P1-18).
- 2.6 Its timing (open, close, drift bound δ and the L2 sequencing bounds it assumes) is well formed, and the L2's configuration stayed within those bounds for the whole poll (T-35, T-50, [[0004-l2-choice]]; P1-18).
- 2.7 Where display text is available, it matches the definition's commitment ([[display-text]]; T-17, T-53).

### 3. Key ceremony

- 3.1 The ceremony transcript decodes strictly, its hash matches the one registered with the trustee keys on L2, and every proof in it verifies, with its Fiat–Shamir context (chain ID, registry address, election identifier, panel) rebuilt from the election being verified, never read from the transcript, so one election's ceremony can't be registered for another (T-37, T-40; P1-14). **(P1-3)** A trustee whose ceremony proof fails is attributed and disqualified as 3.2 describes, not an election failure on its own.
- 3.2 At least the number of trustees the panel rules require took part, and every complaint and disqualification in the transcript is resolved as the spec says ([[0006-trustees]]; T-40, T-54; P1-14).

### 4. Board, anchors and archive

- 4.1 Every board-entry envelope decodes strictly (the record it carries is an admission check), and the hash chain is unbroken from the first entry to the last (T-23, T-31; P1-16).
- 4.2 Every Merkle root anchored on L1 is recomputed from the board, and every entry falls under an anchored root (T-23, T-24; P1-16, P4-1).
- 4.3 Every archive manifest reachable from L1 `archiveLocator` fields and from the manifest chain is found and matches what it names; any missing link is reported ([[0005-permanent-archive]]; T-51; P1-19, P4-3).
- 4.4 Every one of our contracts' L2 events has a board entry with its inclusion evidence, and the archived event sequence reproduces each contract's on-chain event accumulator at every anchored period and at close. The check passes with an annotation naming which proof type settled each output root it relied on (TEE-only or ZK), and the report lists every TEE-only root (8.3) ([[0005-permanent-archive]], T-71; P1-18, P1-19).
- 4.5 Every deposit or forced transaction reaching our contracts traces to an ordinary call on L1 to the pinned portal or our relay (T-71, [[0004-l2-choice]]; P1-18, P1-19).

### 5. Ballots

- 5.1 Every ballot's membership proof verifies against the electorate root for its tier in the election definition (T-04, T-05, T-13; P1-17).
- 5.2 Its nullifier uses the scope derived from the election-definition hash (`abolish/v1/nullifier-scope`), never a scope from anywhere else (T-12, T-04; P1-17).
- 5.3 The proof's signal binds everything P1-13 and P1-17 require it to (at least the ballot hash, the election definition and whatever the re-vote rule ranks by, such as a sequence number or an L1 reference), so the proof can't be moved to another ballot or replayed (T-38, T-32; P1-12, P1-17).
- 5.4 Every validity proof verifies, with its Fiat–Shamir challenge recomputed from the full statement table, including the ballot's nullifier ([[domain-separation]]), and constrains the ballot to the election's rules: no over-vote, no negative vote, the approval limit if any (T-28, T-30, T-32; P1-12). **(P1-3)**
- 5.5 The ballot counts as inside the poll's window under the close rule, using only L2 data derived from finalized L1 data (T-35, T-50, [[0004-l2-choice]]; P1-18).
- 5.6 Direct-submitted ballots on L2 are on the board; a ballot found on L2 but missing from the board fails the check (T-25; P1-18, P3-5).
- 5.7 A repeat of an earlier admitted ballot is rejected (rejected entries don't count as earlier ballots, R4): the same nullifier with everything the membership proof's signal binds (5.3), whatever the entry's other bytes; Groth16 proofs are malleable, so byte comparison alone isn't enough (T-38; P1-13).

### 6. Re-voting and spoiled ballots

- 6.1 For each nullifier, at most one ballot is counted, chosen by the re-vote rule P1-13 specifies. Its admission part is an admission check, and the rest is an election check. This spec doesn't fix the rule: each simple construction tried so far fails one of the requirements below. The rule MUST meet all of them (T-33, T-38, T-45, T-25, T-23):
  - **R1 Replay.** A replay of any earlier ballot of the nullifier is rejected, whatever its bytes. Groth16 membership proofs can be re-randomised by anyone without the witness, so byte comparison isn't enough (see 5.7).
  - **R2 No freezing.** No value chosen when a ballot is cast (a sequence number, say) can stop a later ballot by the same voter from counting. A coercer who watches one cast must not be able to make it final.
  - **R3 Order independence.** The counted ballot doesn't depend on the order in which the board operator writes unanchored entries, or on whether it withholds an earlier ballot until later, alone or together with a coercer. This holds whether ballots arrive through our API or by direct submit.
  - **R4 Stable admission.** An entry that fails admission never changes whether another entry is admitted. An exclusion decided later (a complaint after close, say) never re-evaluates later ballots.
  - **R5 Client state from anchors.** Whatever state the client needs to cast a valid re-vote, it takes from anchored board data it has checked against L1, or from its own records, never from a server's claim.
  - **R6 Liveness.** At any time up to close, an honest client can cast a re-vote that will count after a wait of at most a stated bound, and the close rule accounts for that bound.
  - **Candidates.** A strictly increasing sequence number with a window above the admitted count (R1, R2) fails R3 when the operator reorders more than the window of unanchored ballots. If the client limits itself to the anchored count, the operator can withhold a coerced ballot cast at the window's edge and post it at close, which fails R2. Exact (dense) numbering fails R3 outright. The leading candidate binds a recent finalized L1 block reference into each ballot's membership signal, checked against L1, and counts the admitted ballot with the highest (L1 reference, sequence number) pair. A re-vote that references a later finalized block then beats anything cast earlier, wherever the operator places it, and no ballot can be made in advance for a future block (T-45's pre-made-ballot residual). It meets R2 only once finality advances: within one reference, ballots rank by the sequence number the voter chose, so a coercer who forces a maximal number leaves a dead zone of about one finality interval, which matters just before close; P1-13 must close it or state it as a residual. Any freshness bound on the reference must be measured against a time the operator can't delay (such as L2 inclusion of a direct submit), or the operator could hold an honest re-vote past the bound so it is rejected. P1-13 specifies and reviews it, or an alternative that meets R1–R6. Choosing it may need an ADR if it changes what the membership proof binds.
  - P1-13 also pins three things:
    - whether a last ballot that fails a later check falls back to an earlier one or counts nothing (the open everlasting-privacy ADR proposes counting nothing, so complaints can't revert a re-vote);
    - that spoiled ballots never take part;
    - whether selection is per nullifier or per tier and nullifier, since one secret in two tier groups yields one nullifier. **(P1-3)**
- 6.2 Every spoiled ballot's opening verifies against the ballot it opens, and no spoiled ballot is counted (T-42, T-47; P1-13). **(P1-3)**

### 7. Tally

- 7.1 The aggregates are recomputed from the selected ballots alone, per tier and per option (T-29, T-08, [[0003-tally-scheme]]; P1-15). **(P1-3)**
- 7.2 Each decryption or opening share is checked against its trustee's registered key; an invalid one is attributed to its trustee and excluded, never a failure on its own. At least `k` valid shares exist and are combined (fewer than `k` fails the election, T-54), and the combination gives the published result (T-29, T-14; P1-15). **(P1-3)**
- 7.3 The tally transcript decodes strictly and its hash matches its board entry (T-29; P1-15).
- 7.4 Every decryption or opening share on the board is for an aggregate the spec allows (per tier and option, over the selected ballots, [[0006-trustees]]); any other share, such as one for an individual ballot or for overlapping sets whose difference is one ballot, is reported with the trustee that posted it (T-14, T-16, T-29; P1-15). This check reports and attributes; it doesn't fail the election, whose result rests on 7.1 to 7.3.

### 8. Report

- 8.1 Results are reported per tier, each with its anonymity-set size (group size at the definition's root) and its turnout. Tier 0 results are labelled as not Sybil-resistant (T-01, T-13, T-16; P1-19, P3-6).
- 8.2 Small counts are flagged next to the result: a tally over few voters can reveal individual votes (T-16; P3-6).
- 8.3 Every election that used a record version marked broken is flagged. Everything reported unverifiable, every missing archive link, every TEE-only root and every rejected entry is listed with its reason (P1-19).
