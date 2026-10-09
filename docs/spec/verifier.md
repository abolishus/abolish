# Verifier

What an independent verifier must check to accept an Abolish election result, using chain and IPFS data alone, with our servers and domains offline (G-9, T-36). `packages/verifier` implements this list, and a third party can implement it from this spec in any language. P1-19 extends this page with the verifier's procedure, inputs and report format.

Each check names the threats it closes and the STATUS item that specifies it. A check whose section isn't written yet is still required: until it exists, no verifier can claim the election verified. Checks marked **(P1-3)** change shape with the everlasting-privacy ADR, which is still open.

## Principles

- **Trust nothing served.** Every input comes from L1, the L2, IPFS, the permanent archive or local files, and is checked against L1 anchors or the evidence it carries. Nothing is accepted because an Abolish server said so, and no Abolish server or domain is contacted (T-24, T-49, T-69).
- **Fail loudly.** Each check ends in pass, fail or unverifiable (data missing, a source unreachable, a root not yet settled). The election is verified only if every check passes. Unverifiable is never reported as pass.
- **Strict decoding first.** Every record is decoded strictly ([[notation]]) before any other check uses it, and rejected entries are reported, never skipped silently (T-31, T-52).
- **Pinned trust roots.** The verifier's release pins what can't be derived from data: the L1 and L2 chain IDs, the addresses of the anchor contract and our L2 contracts, the canonical L2 portal on L1, the L2 derivation rules it applies, and the release-signing identities. Changing any of them is a new verifier release (T-64, T-71).

## Checks

### 1. Ballot client and contracts

- 1.1 A served ballot client matches a signed, reproducible release: its bytes hash to a release hash signed by the release identity (T-41, G-13; P1-19, P2-8).
- 1.2 The bytecode at every contract address the election uses matches the release build of reviewed source (T-64; P1-18, P1-19).

### 2. Election definition

- 2.1 The definition decodes strictly, and its hash (`abolish/v1/election-definition`) equals the hash registered on L2 before voting opened (T-34; P1-10, P1-18).
- 2.2 It binds the chain ID and contract addresses the ballots were submitted to, so nothing can be replayed from another chain or deployment (T-30, T-32; P1-10).
- 2.3 Its election type and tally scheme are ones this verifier supports, its profile pins a version for every record type the election uses, and every record of the election (board entries, ballots, openings, transcripts) uses exactly the version its profile pins (`profile-mismatch` otherwise) ([[versioning]]; T-31, T-34, [[0003-tally-scheme]]).
- 2.4 Its electorate is a group root per tier at a fixed L2 block, and that root matches the root computed from the board's record of signed group additions, never the L2 state alone (T-08, T-13, T-06, T-71; P1-18, P3-2).
- 2.5 Its trustee panel (keys, `k`, `n`, panel identifier) matches the ceremony transcript and the keys registered on L2 (T-37, [[0006-trustees]]; P1-14, P1-18).
- 2.6 Its timing (open, close, drift bound δ and the L2 sequencing bounds it assumes) is well formed, and the L2's configuration stayed within those bounds for the whole poll (T-35, T-50, [[0004-l2-choice]]; P1-18).
- 2.7 Where display text is available, it matches the definition's commitment ([[display-text]]; T-17, T-53).

### 3. Key ceremony

- 3.1 The ceremony transcript decodes strictly, its hash matches the one registered with the trustee keys on L2, and every proof in it verifies (T-37, T-40; P1-14). **(P1-3)**
- 3.2 At least the number of trustees the panel rules require took part, and every complaint and disqualification in the transcript is resolved as the spec says ([[0006-trustees]]; T-40, T-54; P1-14).

### 4. Board, anchors and archive

- 4.1 Every board entry decodes strictly, and the hash chain is unbroken from the first entry to the last (T-23, T-31; P1-16).
- 4.2 Every Merkle root anchored on L1 is recomputed from the board, and every entry falls under an anchored root (T-23, T-24; P1-16, P4-1).
- 4.3 Every archive manifest reachable from L1 `archiveLocator` fields and from the manifest chain is found and matches what it names; any missing link is reported ([[0005-permanent-archive]]; T-51; P1-19, P4-3).
- 4.4 Every one of our contracts' L2 events has a board entry with its inclusion evidence, and the archived event sequence reproduces each contract's on-chain event accumulator at every anchored period and at close. The check passes with an annotation naming which proof type settled each output root it relied on (TEE-only or ZK), and the report lists every TEE-only root (8.3) ([[0005-permanent-archive]], T-71; P1-18, P1-19).
- 4.5 Every deposit or forced transaction reaching our contracts traces to an ordinary call on L1 to the pinned portal or our relay (T-71, [[0004-l2-choice]]; P1-18, P1-19).

### 5. Ballots

- 5.1 Every ballot's membership proof verifies against the electorate root for its tier in the election definition (T-04, T-05, T-13; P1-17).
- 5.2 Its nullifier uses the scope derived from the election-definition hash (`abolish/v1/nullifier-scope`), never a scope from anywhere else (T-12, T-04; P1-17).
- 5.3 The proof's signal binds the ballot hash, the election definition and the re-vote sequence number, so the proof can't be moved to another ballot or replayed (T-38, T-32; P1-12, P1-17).
- 5.4 Every validity proof verifies, with its Fiat–Shamir challenge recomputed from the full statement table ([[domain-separation]]), and constrains the ballot to the election's rules: no over-vote, no negative vote, the approval limit if any (T-28, T-30, T-32; P1-12). **(P1-3)**
- 5.5 The ballot counts as inside the poll's window under the close rule, using only L2 data derived from finalized L1 data (T-35, T-50, [[0004-l2-choice]]; P1-18).
- 5.6 Direct-submitted ballots on L2 are on the board; a ballot found on L2 but missing from the board fails the check (T-25; P1-18, P3-5).
- 5.7 A byte-identical repeat of an earlier ballot entry is rejected (T-38; P1-13).

### 6. Re-voting and spoiled ballots

- 6.1 For each nullifier, at most one ballot is counted, chosen by the re-vote rule P1-13 specifies: the voter's last ballot in board order ([[0003-tally-scheme]]). The rule MUST NOT let any ballot field freeze a ballot as last: a coercer who watches one cast must not be able to stop later re-votes, for example by choosing a maximal sequence number (T-45). One construction that does this: the sequence number is dense, each ballot's being exactly one more than the number of earlier accepted ballots for its nullifier, and any other value is rejected, so a replayed earlier ballot carries a stale number and fails (T-38). P1-13 also pins: whether a last ballot that fails a later check falls back to an earlier one or counts nothing (the open everlasting-privacy ADR proposes counting nothing, so complaints can't revert a re-vote); that spoiled ballots never take part in selection; and whether selection is per nullifier or per tier and nullifier, since one secret in two tier groups yields one nullifier (T-33, T-38, T-45; P1-13). **(P1-3)**
- 6.2 Every spoiled ballot's opening verifies against the ballot it opens, and no spoiled ballot is counted (T-42, T-47; P1-13). **(P1-3)**

### 7. Tally

- 7.1 The aggregates are recomputed from the selected ballots alone, per tier and per option (T-29, T-08, [[0003-tally-scheme]]; P1-15). **(P1-3)**
- 7.2 Every decryption or opening share verifies against its trustee's registered key, at least `k` valid shares are combined, and the combination gives the published result (T-29, T-14; P1-15). **(P1-3)**
- 7.3 The tally transcript decodes strictly and its hash matches its board entry (T-29; P1-15).

### 8. Report

- 8.1 Results are reported per tier, each with its anonymity-set size (group size at the definition's root) and its turnout. Tier 0 results are labelled as not Sybil-resistant (T-01, T-13, T-16; P1-19, P3-6).
- 8.2 Small counts are flagged next to the result: a tally over few voters can reveal individual votes (T-16; P3-6).
- 8.3 Everything reported unverifiable, every missing archive link, every TEE-only root and every rejected entry is listed with its reason (P1-19).
