# Membership and nullifier

Every ballot proves that its voter is a member of one tier's group, at the root the election definition fixes for that tier, and carries a nullifier that is the same for every ballot the voter casts in that poll and tier, and unrelated anywhere else. This page fixes the statement, its public inputs, how Abolish derives the scope and the message, and what a verifier checks. The proof system is Semaphore v4's own circuit with its Groth16 keys ([[0009-membership-proof]]). Threats: T-04, T-05, T-07, T-12, T-13, T-38.

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

## Scope

Each tier group `g` of the election definition, with tier `t_g` and root `root_g`, has its own scope:

```
S_g = H(DS("abolish/v1/nullifier-scope", definition_hash ‖ u8(t_g) ‖ encode(root_g)))
ŝ_g = F(S_g)
```

- `definition_hash` is the election definition's hash (`bytes[32]`, [[domain-separation]], P1-10b). `t_g` is the group's tier (0, 1 or 2) as a `u8`: the tier the verifier attributes to the group from the group registry, which the definition's label must equal ([[verifier]] 2.4). `encode(root_g)` is the 32-byte `field<bn254>` encoding of the tier's root. The input after the tag is exactly 65 bytes.
- **The tier, not only the root, is bound.** Two tiers can have the same root: identical rosters added to two groups, or one shared sole member whose leaf is the root. Nothing requires roots to differ ([[verifier]] 2.4 counts each addition toward the tier its authorisation binds, whatever the membership). Binding `t_g` gives equal-root tiers different scopes, so their nullifiers stay unrelated and a proof made for one tier never verifies for the other.
- **Per poll.** The definition hash binds the poll, the chain IDs, the contract addresses and the election identifier, so a redeploy, a second chain or another poll never reuses a scope, and a nullifier reveals nothing across polls (T-12, T-30).
- **Per tier group.** A person whose secret is in two tier groups has two unrelated nullifiers in one poll, even when the two groups have the same root. Their ballots in different tiers can't be linked through the nullifier (T-13), and each tier counts at most one of their ballots (G-2).
- **Never from the ballot.** A verifier computes `ŝ_g` itself from the definition, and never takes a scope from a ballot, a relay or a server ([[verifier]] 5.2).

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

The proving key that goes with it is `semaphore-32.zkey` as Semaphore 4.14.3's prover downloads it, `https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-32.zkey`, sha256 `2e5f7a9f880c337134ee4c7fc4e53573813b4c9c6ae46221c0b56e7992304650`. Its embedded verification key equals the pinned one (checked when the vectors were made).

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

## Checks

A verifier fails the election definition if any tier's root differs from the tier tree it recomputes from the group's additions, is 0, or the group has more than 2³² additions ([[verifier]] 2.4). It also fails a definition that lists a tier whose group has no counted addition (one whose commitment isn't forbidden, Commitments and removals) still unremoved at the root's block, which is exactly when the tier tree's root is `Z_32`: which no one can prove against, so it would be a cell that can't hold a ballot (P1-10b, [[verifier]] 2.8). Then, for each ballot that claims tier group `g` ([[verifier]] 5.1–5.3), it:

1. Recomputes `ŝ_g` from the definition (Scope).
2. Takes `ρ = root_g` from the definition, never from the ballot; `ρ` is never 0 (Statement).
3. Decodes the ballot's nullifier `ν` as a `field<bn254>`, rejecting a non-canonical value (T-31).
4. Recomputes `m̂ = F(M)` from the ballot record and the definition ([[revoting]], Message).
5. Verifies the Groth16 proof under the pinned depth-32 verification key, with public signals `[ρ, ν, m̂, ŝ_g]` (Verification). Any failure rejects the ballot.

Because the scope binds the tier, a proof made for one tier never verifies as another, even if the two tiers have the same root: no relay or operator can move a ballot between tally cells ([[verifier]] 2.8).

## Security notes

- **Zero knowledge.** Groth16 proofs are perfectly zero-knowledge for a well-formed reference string (Groth, EUROCRYPT 2016), so a proof reveals nothing about `s`, the leaf or the path, even to an unbounded adversary ([[0002-everlasting-privacy]]). Against a subverted setup this holds only if the proving key's reference string is well formed (Fuchsbauer, PKC 2018), so it MUST be checked: once per pinned key, publicly (P1-17b part 2, over the proving key whose sha256 `membership_vk_hash` binds, Verification key), and the prover MUST use exactly that key. Until that check is published, zero knowledge against a subverted ceremony is not established. It also holds only if the prover's Groth16 randomisers come from a CSPRNG (P2-8, P5-4 check their prover's randomness source).
- **Nullifier privacy is computational.** `ν = Poseidon2(ŝ, s)`: linking nullifiers across scopes, or a nullifier to an identity commitment, needs `s` or a Poseidon preimage (T-12, T-15).
- **Soundness** rests on Semaphore's ceremony (T-07), on the circuit (T-05) and on BN254, whose discrete-log security is about 100–110 bits after the tower number field sieve ([[0007-group-and-hash]]): a forged proof would admit a non-member. A second nullifier for one identity would need a Poseidon collision, and a second identity for one registration a Poseidon collision or preimage (Tier tree).
- **Chosen-scope linkage.** `S_g` is public, so any other Semaphore application that holds the voter's identity could ask for a proof under scope `int(S_g)` and so learn the voter's nullifier for that poll and tier. The domain tag stops accidental collisions, not this. The prover MUST therefore use the Abolish identity secret for nothing but Abolish membership proofs, never export it to another Semaphore application, and prove only under a scope it recomputed from a definition it verified, with the tier and root taken from that definition (P2-6, P2-8, P5-4; T-12).
- **Malleability.** Anyone can re-randomise a Groth16 proof without the witness. Replay detection uses the nullifier and the message, never the proof bytes ([[verifier]] 5.7, 6.1 R1; T-38).
- **Small groups.** A tier group of one or two members gives its voters no meaningful anonymity. The group size is reported with the results (T-13, T-16).

## Owned elsewhere

- The public check of the pinned proving key's reference string: P1-17b part 2.
- `M`: specified in [[revoting]]; the ballot hash inside it is P1-12's.
- The tier encoding: the election definition's tier field (P1-10b) and the group registry's tier attribution (P1-18, P3-2) MUST use exactly the values this page binds into the scope (0, 1, 2), and the verifier takes `t_g` from the registry binding it checks in [[verifier]] 2.4, never from the definition's label alone.
- Groups and their additions and removals: P3-2, with the commitment and removal rules above (P1-18 emits them).
- On-chain membership checks (direct submit, P1-18): a contract MUST verify the ballot's Groth16 proof under the pinned depth-32 key against the tier root registered with the election's definition, with `ŝ_g` recomputed on chain from the definition hash, tier and root (SHA-256 and Keccak are EVM precompiles or opcodes), and revert otherwise, so non-members can't post at all. It MUST decode the proof as Proof encoding does, rejecting the identity in `A`, `B` and `C` (which EIP-197's precompile and stock verifiers accept), so it and the verifier accept exactly the same proofs ([[verifier]], Principles; T-52). It never verifies against a group contract's own current root, a LeanIMT root or a depth from the caller, so it needs no on-chain tree, and [[verifier]] 2.4 still checks the registered root against the board.
- The prover in the ballot client and native app: P2-8, P5-4. The client MUST build its 32-level path from the whole tier's additions (from the board, or by fetching every leaf) and check the rebuilt root against the definition; asking a server for its own path would reveal its leaf index (T-10, T-13).
