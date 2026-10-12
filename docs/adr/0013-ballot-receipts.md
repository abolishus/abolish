# ADR 0013: Ballot receipts

- Status: Accepted (agent) — owner may veto (2026-10-11, rule A): option A
- Date: 2026-10-11
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-25, T-26, T-23, T-24, T-31, T-30 (see [[THREAT_MODEL]])

## Context

A voter who casts through our API needs something to keep that later shows whether the board that was anchored on L1 still holds the ballot ([[board]], Client checks), and that lets anyone else check the claim (T-26). [[board]] already fixes most of what that is: the entry hash and index, the chain link, and the operator's signature on the size and root the voter was shown, checked against anchored checkpoints with RFC 9162 consistency proofs. What is left open, and decided here:

- **What the operator signs, and when.** Whether a receipt is issued once the entry is in the tree (with an inclusion proof), or as a promise to include it later.
- **The signature scheme of the board operator's receipt key, and how a client learns that key.**
- **What the client checks at cast,** and what is left to the later checks.

What is one-way: receipts are kept by voters for as long as an election can be disputed, and the record layout, the signed message and the key encoding are part of every pinned ballot client and verifier. A change is a new record version and a new tag, and both must stay checkable for every past election.

## Options

### A. A signed tree head per entry, under the trustee signature suite

Right after appending entry `i`, the operator signs `(election_id, i, segment, entry_hash_i, link_i, root_{i+1})`, the state of its board with the voter's entry last, with ECDSA over P-256, SHA-256 and the low-s rule, under a signature tag ([[0012-trustee-identity-signatures]]'s suite). The receipt carries the signature, the operator's key, and the audit path of entry `i` in the tree of `i + 1` entries. The voter checks inclusion at once, and checks consistency from `(i + 1, root_{i+1})` to the anchored checkpoints later. The ballot client's release pins the receipt keys for the check at cast; the key set that judges an election later is P1-13b's.

- **Pros:**
  - **Inclusion is checked at cast,** not promised: a receipt the client accepts already proves the entry is in the board the operator signed.
  - **Drops and forks become attributable** once the later checks (P1-13b) compare the signed size, root and head with the anchored checkpoints, or with a copy of the anchored board.
  - **One signature suite in the trust base.** The verifier already needs P-256 ECDSA for the trustees, with published vectors and the low-s rule; the same code and vectors cover receipts. Cloud KMS and HSMs hold P-256 keys, so the online operator key can be non-extractable.
  - The signed state needs no new board structure: `link_i` and `root_{i+1}` are what [[board]] already defines.
- **Cons:**
  - The operator signs once per entry and must keep its tree current per append (an incremental computation; signing is under a millisecond in a KMS). Appends are serialised, which the board's index already requires.
  - A receipt names the voter's entry, and so the nullifier: anyone the voter shows it to learns which ballots are the voter's (T-45, already true of any ballot the voter shows).

### B. A signed promise, CT-style

The operator signs `(election_id, entry_hash, segment)` as a promise to include the entry in that segment, like a Certificate Transparency SCT (RFC 9162 §4.8), and gives no proof until the segment's checkpoint is anchored.

- **Pros:** no per-append tree work; the signature can be made before the entry has an index.
- **Cons:** the client can't check anything at cast beyond the signature, so a voter learns of a drop only after the deadline, and has to fetch an inclusion proof from someone then. The receipt doesn't commit to the board the voter was shown, so it can't show a fork that drops other voters' entries before this one (T-24): [[board]]'s client rule 2 needs a signed size and root.

### C. An Ethereum-account signature (EIP-712 over secp256k1)

As A, but the operator signs with an Ethereum account, so a contract could check a receipt with `ecrecover`.

- **Pros:** the operator's Safe owners already use such keys ([[0004-l2-choice]]).
- **Cons:** a second signature suite in the verifier's trust base, with its own malleability and recovery rules; nothing on chain needs to check a receipt today (a receipt is evidence for people and verifiers, not a contract input). If a dispute contract ever needs to, OpenZeppelin's `P256` checks A's signatures on Base and L1 as well.

### D. No signature: inclusion in L2 only

Every ballot goes through the direct-submit path, so the L2 transaction receipt is the voter's evidence (T-26's second option).

- **Pros:** no operator key to trust or lose.
- **Cons:** gas for every voter, and funding an address can link a voter (T-25's residual). Direct submit stays as the fallback (P4-2), not the only path.

## Recommendation

**A.** It is the only option that lets the client check inclusion at cast and gives the later checks (P1-13b) a signed size, root and head to hold the anchored board to, for the drops and forks [[board]] says a receipt must catch (T-23, T-24, T-25, T-26), and it adds no primitive to the trust base. B fails client rule 2; C adds a second suite for no current need; D is kept as the fallback path.

What would change it: a dispute contract that must check receipts on a chain without P-256 support (C); binding receipt keys per election (P1-13b), which changes the election definition, not the receipt.

## Consequences

- [[receipts]] specifies the receipt record (`0x0004`, version 1), its signed statement under `abolish/v1/sig/receipt` and the checks a client runs when it gets one. `abolish/v1/receipt` (reserved as a plain hash) is replaced by the signature tag.
- **The later checks are a separate item, P1-13b.** Review of a first draft, which also specified the checks after the deadline and a 30-day dispute period with L1 commitments, found five problems that the later checks must solve together, and some depend on work not done yet ([[receipts]], Later checks): a receipt carries no time, so a key obtained later could forge evidence for good; an operator can withhold a forked board until any time bound has passed; the key set that judges an election must be fixed before voting starts, or a later release could void receipts and keys not bound to the election could forge against it; showing a dropped ballot needs presence defined as an admitted entry with the same `(tier, ν, M)`, which needs P1-12's ballot record; and posting or fetching evidence must not name the entry (T-45). Binding receipt keys per election in the election definition is the likely base.
- **Receipt keys are pinned by the ballot client's release** for the check at cast; standby keys get the active key's custody, and retired keys are destroyed.
- **What stays the voter's to judge:** whether the ballot inside the entry is admitted and is the one that counts for its tier and nullifier ([[revoting]], Residuals). That needs P1-12's ballot record.
- **Known-weak:** the check at cast shows only the operator's signed claim: the operator or a holder of a receipt key can sign a receipt over a made-up tree for a ballot on no board, caught only by the later checks; the operator's key is online; a receipt names the voter's entry and nullifier (T-45); until P1-13b, a receipt is the voter's own check at cast, not evidence a third party can check later.

## Decision

Option A, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. Nothing has been signed or pinned yet, so a veto changes [[receipts]] and the receipt code only. The evidence model of the later checks is decided in P1-13b.
