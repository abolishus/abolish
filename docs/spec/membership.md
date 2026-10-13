# Membership and nullifier

Every ballot proves that its voter is a member of one tier's group, at the root the election definition fixes for that tier, and carries a nullifier that is the same for every ballot the voter casts in that poll and tier, and unrelated anywhere else. This page fixes the statement, its public inputs, how Abolish derives the scope and the message, and what a verifier checks. The proof system is Semaphore v4's own circuit with its Groth16 keys ([[0009-membership-proof]]). Under definition version 7 a poll's electorate may instead be rolling, so people who register after it opens can answer it: each tier's ballots then prove membership at a step of a public root clock under a scope with no root in it (Rolling tier tree; [[0028-rolling-electorates]]). Threats: T-04, T-05, T-07, T-12, T-13, T-38, T-01, T-16.

## Source

The circuit is Semaphore v4's, unchanged:

- Repository `semaphore-protocol/semaphore`, tag `v4.14.3`, commit `4dbc39b83a4066bf5084fd7f5d336202aad2f815`.
- Circuit: `packages/circuits/src/semaphore.circom`, sha256 `d67fbae4504476569c03ce7beb23bacf4c4ebb9cbd8f49888f57ed14b288e486`.
- Field mapping of message and scope: `packages/proof/src/hash.ts` at the same commit.
- Proving and verification keys: Semaphore's multi-party trusted setup, which produced one key pair per maximum tree depth from 1 to 32. Abolish uses only the depth-32 pair (Tree depth), pinned as Verification key below.

A later Semaphore release is adopted only by an ADR, and only if the statement below is unchanged; otherwise it is a new ballot version ([[versioning]]).

## Statement

Notation: `r` is the BN254 scalar field order ([[notation]], `field<bn254>`); `l` = 2736030358979909402780800718157159386076813972158567259200215660948447373041 is the order of Baby Jubjub's prime subgroup and `B8` its generator (EIP-2494); `Poseidon2` is the two-input Poseidon hash over BN254 of circomlib (`Poseidon(2)`: width 3, 8 full and 57 partial rounds, S-box `x⁵`, state `[0, a, b]`, output its first element, with the round constants and MDS matrix of the Poseidon authors' Grain LFSR as circomlibjs v0.1.7 publishes them in `src/poseidon_constants.json`, vendored under `packages/crypto/test-vectors/iden3/` with circomlib's known answers); `MerkleRoot` is the root that zk-kit's `BinaryMerkleRoot(D)` computes from a leaf, a proof length, a path index and `D` siblings, with `Poseidon2` at every node.

Public inputs, in this order: `(ρ, ν, m̂, ŝ)`. Witness: `s`, the proof length `len`, the path index `index` (one field element, which the circuit decomposes into `D` bits) and `D` siblings, exactly Semaphore's `merkleProofLength`, `merkleProofIndex` and `merkleProofSiblings`. The circuit for depth `D` proves:

```
s < l
(Ax, Ay) = s · B8
C        = Poseidon2(Ax, Ay)                        identity commitment
ρ        = MerkleRoot(C, len, index, siblings)
ν        = Poseidon2(ŝ, s)                          nullifier
m̂ is constrained (m̂ · m̂), so the proof binds it
```

`ρ` and `ν` are the circuit's outputs and `m̂`, `ŝ` its public inputs; a Groth16 verifier takes them as the four public signals `[ρ, ν, m̂, ŝ]`. Every value is an element of the BN254 scalar field.

**The circuit doesn't constrain `len`.** For `len > D`, zk-kit's `BinaryMerkleRoot` outputs `ρ = 0` (its own documentation says to enforce `len ≤ D` outside the circuit), so anyone, with any secret and so any number of nullifiers, can prove membership of a group whose root is 0. A root of 0 is never a real tier: a verifier MUST fail a definition in which any tier's root is 0, and MUST NOT verify a membership proof whose `ρ` is 0 (Checks; T-04, T-05). A tier tree (below) never has root 0, so this rule rejects only forgeries.

**Nor does it constrain where the path starts.** `MerkleRoot` hashes leaves and inner nodes alike, so a proof with `len < D` treats `C` as an inner node, and one through a registered value treats that value as the root of a private subtree. In Semaphore v4's LeanIMT, whose leaves sit at varying heights and whose verifier accepts any depth, one registration can therefore be the root of a private tree of `2^k` identities, each with its own nullifier. The tier tree below closes this.

## Tier tree

Each tier group's root `root_g` is the root of its **tier tree**, not of Semaphore v4's LeanIMT:

- A complete binary tree of depth exactly 32 over `Poseidon2`: `node(0, i)` is the `i`-th leaf, `node(h+1, j) = Poseidon2(node(h, 2j), node(h, 2j+1))`, and `root_g = node(32, 0)`.
- Leaf `i` is the identity commitment of the group's `i`-th addition (counted as [[verifier]] 2.4 counts additions), or 0 if that member was removed, or 0 beyond the last addition. Empty subtrees are therefore the chain `Z_0 = 0`, `Z_{h+1} = Poseidon2(Z_h, Z_h)`, as in zk-kit's incremental Merkle tree with zero value 0. A group with more than 2³² additions has no tier tree.
- A verifier computes `root_g` itself from the group's additions on the board ([[verifier]] 2.4); the root a group contract keeps (a LeanIMT, P1-18, P3-2) is never used in its place. The definition's root for the tier must equal it.
- An honest member proves with `len = 32`, its leaf index and its 32 siblings.

**One registration, at most one identity.** Let a proof verify with `ρ = root_g`:

- `len > 32` gives `ρ = 0`, rejected (above).
- `len = 32` puts `C` at height 0, so `C` is a leaf: a registered commitment, of exactly one secret (`s < l` and Poseidon's collision resistance).
- `len < 32` puts `C = Poseidon2(Ax, Ay)` at a height `h > 0`, so `C` equals the inner node over two children, which by collision resistance are `Ax` and `Ay`. For `h = 1` those are two leaves, at least one of them registered: a prime-subgroup point never has `Ay = 0`, and `Ax = 0` only for the identity point `(0, 1)`, the public secret `s = 0`, so one registration of the value `1` next to an empty leaf would make `s = 0` a voting identity that anyone can use. That still adds at most one identity per registration, and the commitment rules below forbid it. For `h > 1` they are inner nodes, and `Ax` (a coordinate of `s · B8`) would have to equal a Poseidon output, a preimage the attacker can't find.

So the identities that can vote in a tier are at most its registrations, short of a Poseidon collision or preimage (T-03, T-04, T-06). This changes the group's tree, not Semaphore's circuit or keys.

**Commitments and removals.** A **forbidden** commitment is one that isn't a canonical `field<bn254>`, or is `0`, `1` or `Poseidon2(0, 1)` (the commitment of the public secret `s = 0`). An addition with a forbidden commitment keeps its index in the tier tree, but its leaf is 0 and it isn't counted in the group size; it never fails the definition, so no registrant can break later elections by registering one ([[verifier]] 2.4; T-25, T-53). With its leaf at 0, the `s = 0` path above is closed (`Poseidon2(0, 0) = Z_1`). Group contracts (P1-18, P3-2) MUST revert additions with forbidden commitments, and the Tier 0 and Tier 1 signing path MUST refuse to sign them; the zero leaf is what keeps one that slips through harmless. A removal counts only under the same binding as an addition (the group's identifier, the chain ID and the registry address) and names a leaf index in the tier tree's numbering (every addition 2.4 counts, forbidden ones included), never a commitment, since commitments can repeat; it sets that leaf to 0. A removal naming an index no counted addition before it has reached, or a leaf already removed, changes nothing and never fails the definition, so no stray removal can make two verifiers rebuild different roots. Group contracts emit both in that form. These lenient rules are for group contracts whose records carry no signed sequence. The group registry ([[contracts]], Group registry) refuses forbidden commitments and stray removals itself and signs each record's position, so a verifier replays its groups strictly instead, and a record that breaks the replay fails every definition naming the group (`group-history`): on an honest chain no such record exists, so no registrant can trigger it.

## Cell tree

Under definition version 3 a tier may be split into regional cells ([[election-definition]], Regional cells; [[0019-regional-cells]]), and a ballot proves membership of its cell, not of one group. A cell's root `root_c` is the root of its **cell tree**:

- The tier tree above (depth exactly 32, `Poseidon2`, empty leaves 0), whose leaves are the cell's groups' leaves concatenated in ascending `group_id`, each group's leaves in its own index order, with at most 2³² leaves in all. A cell with more has no cell tree, and a definition naming it fails ([[verifier]] 2.4).
- Each group's leaves are its tier-tree leaves at the tier's `root_l2_block`, replayed as above (Commitments and removals; strictly for a group in the group registry), and then the **first-occurrence rule**: walking all the tier's groups, not only the cell's, in ascending `group_id`, each group's leaves in index order, a nonzero leaf equal to a nonzero leaf earlier in the walk is set to 0 and isn't counted.
- A member proves with `len = 32`, its leaf's index in the cell tree (its group's leaves are offset by the leaves of the cell's groups before it) and the 32 siblings of the cell tree.

So a cell tree is a tier tree over a list of leaves, and everything Tier tree says holds for it: one registration is at most one identity, and a cell tree never has root 0. A cell of one group whose commitments don't repeat has exactly that group's tier tree.

**Why first occurrence.** Commitments are public and can repeat across groups (anyone can register a commitment someone else holds). Without the rule one secret could have a leaf in two cells of one tier, with two scopes and so two nullifiers, and vote twice in the tier (G-2); and a repeat could inflate a region past the floor. The rule resolves a repeat rather than failing it, so no registrant can stop a tier from being split, and no two cells of a tier hold the same commitment: one secret registered in a tier is in exactly one cell and has one nullifier for the tier, and [[revoting]], which ranks per tier and nullifier, is unchanged. The cost: registrars who break the no-repeat rule (T-06) can add a victim's commitment to a lower-numbered group in another region, zeroing the victim's own leaf and moving them to a cell they didn't register in. The ballot client MUST check, before casting, that its own leaf is the counted occurrence, in the region it registered in, and alarm otherwise (P2-8; [[0019-regional-cells]], Consequences).

## Rolling tier tree

Under definition version 7 with `electorate_mode` 2 (rolling; [[election-definition]], Layout (version 7)), a tier lists its groups and has no regions or cells, and its ballots prove membership of its **rolling tier tree** at a step of the root clock (below), never of a root the definition states ([[0028-rolling-electorates]], option B):

- The tier tree above (depth exactly 32, `Poseidon2`, empty leaves 0, at most 2³² leaves), whose leaves are the tier's listed groups' additions in **chain order**: walking the group registry's event sequence in log order (L2 block number, then log index; [[contracts]], Group registry, Verification), each `MembersAdded` of a listed group appends its record's commitments, in record order, from the group's creation on. Groups the tier doesn't list are skipped, whatever their tier.
- Each listed group is replayed strictly, as [[contracts]] (Group registry, Verification) replays it, and a record that fails the replay fails every definition naming the group (`group-history`). The registry refuses forbidden commitments, so every leaf an addition appends is a commitment.
- A `MembersRemoved` of a listed group sets to 0 the leaf its named index's addition appended: member `i` of group `g` is the leaf appended for `g`'s `i`-th commitment, never another occurrence of the same value.
- **No first-occurrence rule.** A commitment added twice to a group, added to two listed groups, or removed and added again keeps a leaf per occurrence. Every occurrence is the same secret and so has the same nullifier in the poll (Scope), so a repeat gives no second ballot. The rule exists to keep one secret in one cell of a tier (Cell tree), and a rolling tier is one cell.
- The **member count** of a rolling tier tree is the number of distinct values among its nonzero leaves, so a repeated commitment never inflates a reported anonymity set (T-16). A fixed tier's `group_size` counts additions; this one counts identities.

Everything Tier tree proves holds for a rolling tier tree, which is a tier tree over a list of leaves: one registration is at most one identity, and its root is never 0.

**Why chain order.** The cell tree concatenates groups by `group_id`, so an addition to a lower group shifts every later group's leaves, and each step's root would be a rebuild of the whole tier. In chain order a step's tree is the previous step's with its own additions appended and its removals zeroed, 32 hashes each, so computing every step of a poll costs 32 hashes per event of its groups, the same as replaying them once ([[0028-rolling-electorates]], The rolling tier tree; T-36, T-53). The listed groups share one registry, so their events have one total order.

### Root clock and steps

Boundary `n` of the **root clock**, for `n` a `u32`, is

```
τ_n = n · ROOT_PERIOD + ROOT_OFFSET
```

in seconds of UNIX time, compared with L2 `block.timestamp` and L1 block timestamps as numbers ([[parameters]]; the same clock for every poll and every deployment, never chosen per poll, T-34).

- **Step `n`'s tree** for a rolling tier is its rolling tier tree over the events in L2 blocks whose timestamp is at most `τ_n`; its **step root** `ρ_n` is that tree's root and its **step count** that tree's member count. L2 timestamps never decrease along the chain, and the event accumulator binds each event's L2 block number and timestamp ([[contracts]], Event accumulator; [[0025-contract-event-evidence]]), so every verifier derives the same step from the archived events alone, with no headers.
- **The opening state.** A rolling tier's `root` and `group_size` in the definition are the root and member count of its rolling tier tree over the events in L2 blocks up to and including `root_l2_block`, a block number. They report the electorate the poll opened with ([[verifier]] 2.4, 8.1); no ballot proves against the opening root as such.
- **Accepted steps.** A rolling poll accepts step `n` for tier `t` if `τ_n` is later than the timestamp of the L2 block that registered the definition (its `DefinitionRegistered` event's, which the event accumulator binds, so the bound needs no header) and at most `closes_at`, step `n`'s tree has at most 2³² leaves, and at least one of them is nonzero (its root isn't `Z_32`, the root no one can prove against). A step after the tier's tree has outgrown 2³² leaves is never accepted, and neither is any later one.
- **Settled and final.** Step `n` is **settled** once the L2 chain derived from L1 data (the safe chain, not merely batches posted to L1, which derivation may drop or replace with deposit-only blocks after the sequencing window) contains a block whose timestamp is later than `τ_n`, since no later block of that chain can carry an earlier timestamp; it is **final** once that derivation is from finalized L1 ([[0004-l2-choice]], Finality). An honest client proves only against a settled step, checks it again once it is final, and makes a new ballot if the final root differs. So an insider who sequences hidden additions before a boundary can only invalidate ballots whose clients didn't wait for L1, and a root that only the insider's own commitments could prove against needs an L1 reorganisation (T-08, T-13, T-25).
- **The window.** A ballot whose L1 reference ([[revoting]], Message) has timestamp `t` may name step `n` only if `t − ROOT_WINDOW < τ_n ≤ t`; ballot version 5 carries the step ([[ballot-validity]], Ballot record (version 5)), a step outside the accepted ones is rejected at admission (`root-step-range`), and one outside the window with the L1 reference (`root-step-stale`, `root-step-future`, [[revoting]], Admission). The window depends only on the ballot, the definition and finalized L1, like every other admission check ([[revoting]], Admission).
- **The client's step.** A conforming client names the newest settled step whose `τ_n` is at or before its L1 reference's timestamp and whose tree holds its own live leaf: for anyone who joined before that step, the newest settled step, whoever they are. So ballots made at about the same time name the same step or two, and the step says no more about a voter than the L1 reference already does, in particular not when they joined (T-13; [[0028-rolling-electorates]], Anonymity). A client that names an older step is limited to `ROOT_WINDOW` of its reference, which bounds what its choice can reveal.
- **Removals don't stop a ballot in an open poll.** A removed member's leaf is 0 in every later step, but nothing ties a ballot's L1 reference to when it is boarded ([[revoting]], Admission, only bounds it below by `l1_ref_min` and above by the close), so a removed member can still make a ballot with an older reference naming a step from before its removal, until close, as a member removed after a fixed poll's `root_l2_block` can. The window bounds how far a step may lag its reference, not how old the reference may be. So a removal or revocation protects only polls opened after it, and replacing a secret needs the constraint T-18 records.

## Scope

Each tier group `g` of the election definition, with tier `t_g` and root `root_g`, has its own scope (under definition version 3, each cell `c`, with its tier `t_c` and its cell-tree root `root_c` in place of `t_g` and `root_g`):

```
S_g = H(DS("abolish/v1/nullifier-scope", definition_hash ‖ u8(t_g) ‖ encode(root_g)))
ŝ_g = F(S_g)
```

- `definition_hash` is the election definition's hash (`bytes[32]`, [[domain-separation]], P1-10b). `t_g` is the group's tier (0, 1 or 2) as a `u8`: the tier the verifier attributes to the group from the group registry, which the definition's label must equal ([[verifier]] 2.4). `encode(root_g)` is the 32-byte `field<bn254>` encoding of the tier's root. The input after the tag is exactly 65 bytes.
- **The tier, not only the root, is bound.** Two tiers can have the same root: identical rosters added to two groups, or one shared sole member whose leaf is the root. Nothing requires roots to differ ([[verifier]] 2.4 counts each addition toward the tier its authorisation binds, whatever the membership). Binding `t_g` gives equal-root tiers different scopes, so their nullifiers stay unrelated and a proof made for one tier never verifies for the other.
- **Per poll.** The definition hash binds the poll, the chain IDs, the contract addresses and the election identifier, so a redeploy, a second chain or another poll never reuses a scope, and a nullifier reveals nothing across polls (T-12, T-30).
- **Per cell.** Under definition version 3 each cell has its own scope, and the cells of one tier never hold the same commitment (Cell tree), so a member has one nullifier per tier. The definition's cells have distinct roots ([[election-definition]], `cells`), and the scope binds the tier, so no proof made for one cell verifies for another.
- **Per tier group.** A person whose secret is in two tier groups has two unrelated nullifiers in one poll, even when the two groups have the same root. Their ballots in different tiers can't be linked through the nullifier (T-13), and each tier counts at most one of their ballots (G-2).
- **Never from the ballot.** A verifier computes `ŝ_g` itself from the definition, and never takes a scope from a ballot, a relay or a server ([[verifier]] 5.2).

**Rolling scope.** Under a rolling electorate (Rolling tier tree), every ballot of tier `t` uses one scope, with no root in it:

```
S_t = H(DS("abolish/v1/rolling-nullifier-scope", definition_hash ‖ u8(t)))
ŝ_t = F(S_t)
```

- The input after the tag is exactly 33 bytes. The tag is its own, so a rolling scope never equals a fixed one, even by construction, and no reader can mistake which formula an election uses; `definition_hash` binds the electorate mode as well as the poll, so the two never apply to one election.
- **One nullifier per secret, per tier, per poll.** Every admitted ballot of tier `t` verifies with public inputs `[ρ_n, ν, m̂, ŝ_t]`, `ρ_n` the root the verifier computed for its step and `ŝ_t` the same for every ballot of the tier. By the proof's soundness and Tier tree's argument, its prover knows a secret `s` whose commitment is a leaf of `ρ_n`, and `ν = Poseidon2(ŝ_t, s)`. So one secret has the same `ν` at every step, in every listed group, at every leaf, and after a removal and a re-addition; two secrets with one `ν` would need a Poseidon collision. [[revoting]] selects at most one ballot per tier and `ν`, so a tier's counted ballots are at most the distinct secrets live at some accepted step: the tier's own registration bound, over the poll's span ([[0028-rolling-electorates]], Nullifier scope; T-01, T-02, T-03).
- **The tier is still bound,** so two tiers with equal trees have different scopes, as above, and a ballot can't move between them ([[verifier]] 2.8).
- **Never from the ballot,** as above: the verifier computes `ŝ_t` from the definition (5.2).

## Message

The message is the 32-byte digest `M` of [[revoting]] (Message): a tagged hash of the election-definition hash, the tier, the ballot hash (P1-12) and the L1 block the re-vote rule ranks by ([[verifier]] 5.3, T-38). The circuit's public input is `m̂ = F(M)`.

## Field mapping

`F` maps 32 bytes into the field exactly as Semaphore v4's `hash` does:

```
F(x) = int(keccak256(x)) >> 8          (x: bytes[32])
```

- `keccak256` is Ethereum's Keccak-256 (Keccak with the original `0x01` padding), not FIPS 202 SHA3-256. `int` reads its 32-byte output as a big-endian integer. The shift leaves 248 bits, so `F(x) < 2²⁴⁸ < r`, and no reduction is needed.
- Semaphore's `hash(v)` hashes `v` as a 32-byte big-endian word, so `F(x)` equals Semaphore's `hash` of the integer whose 32-byte big-endian encoding is `x`. Stock Semaphore libraries and contracts, given `int(S_g)` as the scope and `int(M)` as the message, produce and check the same public inputs.
- `F` is an external format, as [[domain-separation]] allows: its inputs are already tagged digests, so it carries no tag of its own. Collisions in `F` cost about 2¹²⁴ Keccak evaluations.

## Tree depth

Every membership proof, in every tier and every election, uses the verification key for one protocol-wide depth, `D = 32`, Semaphore's maximum. The prover MUST pass `D = 32` explicitly, never a depth it computes or is told:

- **Nothing to steer.** A per-tier depth would have to come from the tier's leaf count, which the root doesn't determine and a client can't cheaply recompute, so in practice a server would supply it. An operator could then serve one voter a wrong count: the voter's proof verifies locally under the wrong key, every verifier rejects it, and it is the only ballot under that key, so it is both suppressed and identifiable (T-10, T-13). A fixed depth removes the input.
- **Nothing to reveal.** Semaphore's library otherwise infers the depth from the path length; with one fixed key and every path 32 long, the key used says nothing about the voter or their leaf.
- **The tier tree's own depth.** The tier tree has depth exactly 32, so every member's path has exactly 32 levels (Tier tree). A tier group with more than 2³² additions (removed members included: a removal sets a leaf to 0 but never frees it) has no tier tree, and a verifier fails a definition that has one.
- **Cost.** The depth-32 proving key is Semaphore's largest, and a proof hashes 32 levels whatever the group size. P2-8 and P5-4 measure proving time on target devices; if it is too slow, a later ballot version can fix a smaller protocol-wide depth or carry a depth in the election definition that the verifier checks, never one a server supplies.

## Verification key

The pinned key is Semaphore's depth-32 Groth16 verification key: entry 31 of `vk_delta_2` and `IC` in `packages/proof/src/verification-keys.json` at the commit above (sha256 `d96ec60593b6fc2334f1f04e008e07425d5536d7777f6ac21d996fc80779b3c9`), with the `vk_alpha_1`, `vk_beta_2` and `vk_gamma_2` every depth shares. `packages/crypto` vendors that file ([[vectors/README|vectors]]; `packages/crypto/test-vectors/semaphore/`) and carries the key as constants a test compares with it. Its `IC` has exactly 5 points, one more than the 4 public signals.

The proving key that goes with it is `semaphore-32.zkey` as Semaphore 4.14.3's prover downloads it, `https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-32.zkey`, sha256 `2e5f7a9f880c337134ee4c7fc4e53573813b4c9c6ae46221c0b56e7992304650`. Its embedded verification key equals the pinned one, and its reference string is well formed (Reference-string check).

```
vk                = G1(α) ‖ G2(β) ‖ G2(γ) ‖ G2(δ) ‖ G1(IC_0) ‖ … ‖ G1(IC_4)        768 bytes
membership_vk_hash = H(DS("abolish/v1/membership-vk", u8(32) ‖ vk ‖ zkey_sha256))
```

`G1` and `G2` are the point encodings of Proof encoding below, and `zkey_sha256` is the proving key's sha256 above (32 bytes). The input after the tag is exactly 801 bytes. The election definition's `membership_vk_hash` carries it ([[election-definition]]). A verifier compares the two and never verifies under a key a definition, a ballot or a server names ([[verifier]] 1.3). The hash binds the proving key too, so a prover can check that it holds exactly the key whose reference string was checked (Security notes) and that the election uses it; a prover whose proving key's sha256 differs MUST NOT prove (P2-8, P5-4; T-07, T-12). A new key, at any depth, is a new hash and a new ballot version ([[versioning]]).

## Proof encoding

`membership_proof` is a fixed 256-byte structure, `A ‖ B ‖ C`, in the encoding Ethereum's precompiles and Semaphore's Solidity verifier use (EIP-196, EIP-197):

| Field | Type     | Bytes | Encoding                                                                    |
| ----- | -------- | ----- | --------------------------------------------------------------------------- |
| `A`   | G1 point | 64    | `x ‖ y`, each 32 bytes big-endian                                           |
| `B`   | G2 point | 128   | `x.c1 ‖ x.c0 ‖ y.c1 ‖ y.c0`, each 32 bytes big-endian, imaginary part first |
| `C`   | G1 point | 64    | `x ‖ y`                                                                     |

`x = x.c0 + x.c1·u` in `Fp² = Fp[u]/(u² + 1)`. Every coordinate is a base-field element below `p` = 21888242871839275222246405745257275088696311157297823662689037894645226208583. A decoder rejects, with `non-canonical` at the point's offset ([[notation]], Strict decoding):

- a coordinate at or above `p`;
- the identity, whose only would-be encodings are all zeros;
- a G1 point not on `y² = x³ + 3`, or a G2 point not on the twist `y² = x³ + 3/(u + 9)`;
- a G2 point outside the order-`r` subgroup (G1's cofactor is 1). Without this check a forger could move the pairing into a small subgroup (T-05).

Semaphore's packed proof (`packGroth16Proof`) lists the same eight values in the same order as decimal strings, so a stock proof converts by writing each as 32 bytes. snarkjs's own JSON lists `B`'s components real part first; the decoder never guesses an order, and a swapped `B` fails decoding (vector `b-component-order`) or verification.

## Verification

For a proof `(A, B, C)` and public signals `[ρ, ν, m̂, ŝ]`, the verifier checks Groth16's equation (Groth, EUROCRYPT 2016, §3.2) under the pinned key:

```
L = IC_0 + ρ·IC_1 + ν·IC_2 + m̂·IC_3 + ŝ·IC_4
e(A, B) = e(α, β) · e(L, γ) · e(C, δ)
```

over the BN254 optimal ate pairing, computed with `@noble/curves`' audited implementation ([[0009-membership-proof]], Consequences). It rejects first, without pairing, if the proof doesn't decode, any signal is at or above `r` (signals are never reduced, so one proof can't stand for two values; T-31), or `ρ = 0` (Statement). A Groth16 verifier that reduces signals modulo `r`, or skips the subgroup check, isn't conforming.

## Reference-string check

Groth16's zero knowledge against a subverted setup needs a well-formed reference string (Fuchsbauer, PKC 2018; Abdolmaleki, Baghery, Lipmaa and Zając, ASIACRYPT 2017). It was checked once, publicly, for the pinned proving key (P1-17b part 2; T-07, T-12). The check is `packages/crypto/scripts/membership-crs-check.ts`, which uses only `@noble/curves`' BN254 group, MSM and pairing code, and its tests (`packages/crypto/tests/membership-crs-check.test.ts`) build an honest key for a toy circuit and show that breaking each relation below fails exactly the check that names it.

Inputs, each pinned by sha256 in the script:

| Input               | Source                                                                                                                                                          | sha256                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `semaphore-32.zkey` | Verification key above                                                                                                                                          | `2e5f7a9f880c337134ee4c7fc4e53573813b4c9c6ae46221c0b56e7992304650` |
| `ppot_0080_14.ptau` | `https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_14.ptau`, the Perpetual Powers of Tau (contribution 80) cut to 2¹⁴, prepared | `3ca1149e9349b22b0ee0649399cfb787677129b7b1189d1899fc0d615d9583db` |
| `semaphore-32.r1cs` | compiled below                                                                                                                                                  | `82ffde9b18278ae0881a6fcfcc7884ad97fd69db94534779a8923182e9f4780b` |

The R1CS comes from the circuit file Source pins (the same sha256 in `@semaphore-protocol/circuits` 4.13.0 on npm), with `circomlib` 2.0.5 and `@zk-kit/binary-merkle-root.circom` 2.0.0 from npm (Semaphore's pinned dependencies), compiled by circom 2.1.9 (the `circom-linux-amd64` release binary, sha256 `e5575829252d763b7818049df9de2ef9304df834697de77fa63ce7babc23c967`) with Semaphore's `circomkit.json` setting `--O2`, from a main file `component main {public [message, scope]} = Semaphore(32);` under `pragma circom 2.1.5;` and `include "semaphore.circom";`. It has 9418 wires, 4 public signals and 9383 constraints, so the key's domain is `N = 2¹⁴`.

The ptau isn't trusted: the check proves its points are powers of one `τ`. It passes when the key is an honest Groth16 key for that R1CS, up to a component of `H` no proof uses (check 18): there are `α`, `β`, `γ ≠ 0`, `δ ≠ 0` and `τ` with `τ^N ≠ 1` such that every point equals its formula. Every point is decoded canonically and checked in its order-`r` group first, and each family of equations is checked as one random linear combination with fresh CSPRNG scalars (small-exponent batching, Bellare, Garay and Rabin, EUROCRYPT 1998), so a wrong point passes with probability at most `1/r` per family. In order:

1. R1CS shape matches the key: wires, public signals, and room for the constraints and snarkjs's `nPublic + 1` extra rows in the domain.
2. A matrix equals the R1CS's: the key's A coefficients are the R1CS's plus `A[nConstraints + i][i] = 1` for the constant and each public signal.
3. B matrix equals the R1CS's.
4. powers start at the generators: `[τ⁰]₁` and `[τ⁰]₂`.
5. τ ≠ 0.
6. [τ]_1 and [τ]_2 agree.
7. G1 powers are consecutive: `[τ^i]₁` for `i ≤ 2N − 2`.
8. G2 powers are consecutive: `[τ^i]₂` for `i ≤ N − 1`.
9. τ isn't on the domain: `τ^N ≠ 1`.
10. α, β, γ, δ are nonzero.
11. [β]_1 and [β]_2 agree.
12. [δ]_1 and [δ]_2 agree.
13. A points are [u_i(τ)]_1, with `u_i`, `v_i` and `w_i` the Lagrange interpolations of the A, B and C columns over the domain `ω^j`, `ω` snarkjs's root of unity (ffjavascript's `Fr.w`).
14. B points in G1 are [v_i(τ)]_1.
15. B points in G2 are [v_i(τ)]_2.
16. IC points are [(β·u_i + α·v_i + w_i)(τ)/γ]_1, for the constant and the public signals (the pinned `IC`).
17. L points are [(β·u_i + α·v_i + w_i)(τ)/δ]_1, for the private signals.
18. H points are [L_{2i+1}(τ)/δ]_1: the Lagrange basis on the `2N` domain at its odd points, where snarkjs's prover evaluates `A·B − C`. The ptau has no `τ^{2N−1}`, so this basis carries some fixed point in its place, adding `κ_i·Z` to `H_i` with `κ_i = ω₂ₙ^{2i+1}/(2N)`. A proof never uses it: the prover computes `C` as `A·B` on the `N`-point domain, so `A·B − C` vanishes there and has degree at most `2N − 2`, and so `Σ h_i·κ_i = 0`, its coefficient of `X^{2N−1}`; the check tests `H` up to exactly that direction.

Then for every witness of the circuit an honest proof's `A` and `B` are uniform and independent of the witness (through the prover's `r` and `s`, as `δ ≠ 0`), and `C` is fixed by `A`, `B` and the public signals through the verification equation, so a proof reveals nothing about the witness whoever ran the ceremony.

**Result (2026-10-12): well formed.** All 18 checks pass (`MEMBERSHIP_CRS_DIR=<dir> vp test run tests/membership-crs-check.test.ts` in `packages/crypto`, or `vp node --experimental-transform-types packages/crypto/scripts/membership-crs-check.ts <zkey> <ptau> <r1cs>`, about 4 minutes). As an independent cross-check, snarkjs 0.7.5's `zkey verify` with the same three files reports `ZKey Ok!`: the key is the one snarkjs derives from that R1CS and ptau, followed by 320 recorded phase-2 contributions and a beacon.

## Checks

Under a rolling electorate, 2.4 and the checks below change as Rolling checks (below) says. Otherwise, a verifier fails the election definition if any tier's root differs from the tier tree it recomputes from the group's additions, is 0, or the group has more than 2³² additions ([[verifier]] 2.4); under definition version 3, the same for each cell's root and its cell tree. It also fails a definition that lists a tier whose group has no counted addition (one whose commitment isn't forbidden, Commitments and removals) still unremoved at the root's block, which is exactly when the tier tree's root is `Z_32`: which no one can prove against, so it would be a cell that can't hold a ballot (P1-10b, [[verifier]] 2.8). Then, for each ballot that claims tier group `g` ([[verifier]] 5.1–5.3), or under definition version 3 cell `c` (the `cell` of ballot version 2, [[ballot-validity]]), with its tier and root in place of the group's, it:

1. Recomputes `ŝ_g` from the definition (Scope).
2. Takes `ρ = root_g` from the definition, never from the ballot; `ρ` is never 0 (Statement).
3. Decodes the ballot's nullifier `ν` as a `field<bn254>`, rejecting a non-canonical value (T-31).
4. Recomputes `m̂ = F(M)` from the ballot record and the definition ([[revoting]], Message).
5. Verifies the Groth16 proof under the pinned depth-32 verification key, with public signals `[ρ, ν, m̂, ŝ_g]` (Verification). Any failure rejects the ballot.

Because the scope binds the tier, a proof made for one tier never verifies as another, even if the two tiers have the same root: no relay or operator can move a ballot between tally cells ([[verifier]] 2.8).

**Rolling checks.** Under a rolling electorate a verifier replays each tier's listed groups through the last accepted step (Rolling tier tree), and fails the definition if a tier's `root` or `group_size` differs from the root or member count of its rolling tier tree at `root_l2_block` ([[verifier]] 2.4). A rolling tier with no live member at opening states `Z_32` and a count of 0; it holds no ballot until a step has a member. Then, for each ballot of tier `t`, it:

1. Recomputes `ŝ_t` from the definition (Scope, Rolling scope).
2. Takes `ρ = ρ_n`, the step root it computed itself for the step `n` the ballot names, once that step is accepted and inside the ballot's window (Root clock and steps); never a root from the ballot, a relay or a submitter.
3. Decodes `ν`, recomputes `m̂` and verifies the proof as steps 3 to 5 above do, with public signals `[ρ_n, ν, m̂, ŝ_t]`.

The verifier computes a step's root only for steps some ballot names, from the same replay, so its work stays linear in the groups' events ([[0028-rolling-electorates]], requirement 6).

## Security notes

- **Zero knowledge.** Groth16 proofs are perfectly zero-knowledge for a well-formed reference string (Groth, EUROCRYPT 2016), so a proof reveals nothing about `s`, the leaf or the path, even to an unbounded adversary ([[0002-everlasting-privacy]]). Against a subverted setup this holds only if the proving key's reference string is well formed (Fuchsbauer, PKC 2018), so it MUST be checked once per pinned key, publicly, and the prover MUST use exactly that key, whose sha256 `membership_vk_hash` binds (Verification key). The pinned key passed that check (Reference-string check), so zero knowledge holds even if every participant in Semaphore's ceremony colluded. A new key, at any depth, needs the check again before any election uses it. It also holds only if the prover's Groth16 randomisers come from a CSPRNG, and only for proofs that verify: a witness that doesn't satisfy the circuit (a faulty witness generator, which the check doesn't cover) or a prover with other basis conventions leaves a witness-dependent term in `C`. So the prover MUST verify its own proof under the pinned key before it leaves the device (P2-8, P5-4 check their prover's randomness source and add that check).
- **Nullifier privacy is computational.** `ν = Poseidon2(ŝ, s)`: linking nullifiers across scopes, or a nullifier to an identity commitment, needs `s` or a Poseidon preimage (T-12, T-15).
- **Soundness** rests on Semaphore's ceremony (T-07), on the circuit (T-05) and on BN254, whose discrete-log security is about 100–110 bits after the tower number field sieve ([[0007-group-and-hash]]): a forged proof would admit a non-member. A second nullifier for one identity would need a Poseidon collision, and a second identity for one registration a Poseidon collision or preimage (Tier tree).
- **Chosen-scope linkage.** `S_g` is public, so any other Semaphore application that holds the voter's identity could ask for a proof under scope `int(S_g)` and so learn the voter's nullifier for that poll and tier. The domain tag stops accidental collisions, not this. The prover MUST therefore use the Abolish identity secret for nothing but Abolish membership proofs, never export it to another Semaphore application, and prove only under a scope it recomputed from a definition it verified, with the tier and root taken from that definition (P2-6, P2-8, P5-4; T-12).
- **Malleability.** Anyone can re-randomise a Groth16 proof without the witness. Replay detection uses the nullifier and the message, never the proof bytes ([[verifier]] 5.7, 6.1 R1; T-38).
- **Small groups.** A tier group of one or two members gives its voters no meaningful anonymity. The group size is reported with the results (T-13, T-16).

## Owned elsewhere

- `M`: specified in [[revoting]]; the ballot hash inside it is P1-12's.
- The tier encoding: the election definition's tier field (P1-10b) and the group registry's tier attribution (P1-18, P3-2) MUST use exactly the values this page binds into the scope (0, 1, 2), and the verifier takes `t_g` from the registry binding it checks in [[verifier]] 2.4, never from the definition's label alone.
- Groups and their additions and removals: P3-2, with the commitment and removal rules above (P1-18 emits them).
- On-chain membership checks (direct submit, P1-18): a contract MUST verify the ballot's Groth16 proof under the pinned depth-32 key against the tier root registered with the election's definition, with `ŝ_g` recomputed on chain from the definition hash, tier and root (SHA-256 and Keccak are EVM precompiles or opcodes), and revert otherwise, so non-members can't post at all. It MUST decode the proof as Proof encoding does, rejecting the identity in `A`, `B` and `C` (which EIP-197's precompile and stock verifiers accept), so it and the verifier accept exactly the same proofs ([[verifier]], Principles; T-52). It never verifies against a group contract's own current root, a LeanIMT root or a depth from the caller, so it needs no on-chain tree, and [[verifier]] 2.4 still checks the registered root against the board.
- On-chain checks of rolling ballots (direct submit, P1-18, [[P2-17]] part 5): no root of a rolling poll is registered anywhere, so the submitter supplies the root it proved against beside the ballot; the contract recomputes `ŝ_t` from the definition hash and tier, verifies the proof with that root under the strict decoding above, and logs the root. The verifier rejects a ballot whose supplied root isn't its own step root, and the board still carries it as a rejected entry ([[0028-rolling-electorates]], Direct submission). So direct submission works with nothing but the chain (T-25), and its spam control in a rolling poll is gas only (T-52).
- The prover in the ballot client and native app: P2-8, P5-4. The client MUST build its 32-level path from the whole tier's additions (from the board, or by fetching every leaf) and check the rebuilt root against the definition; asking a server for its own path would reveal its leaf index (T-10, T-13).
