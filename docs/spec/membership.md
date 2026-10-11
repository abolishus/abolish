# Membership and nullifier

Every ballot proves that its voter is a member of one tier's group, at the root the election definition fixes for that tier, and carries a nullifier that is the same for every ballot the voter casts in that poll and tier, and unrelated anywhere else. This page fixes the statement, its public inputs, how Abolish derives the scope and the message, and what a verifier checks. The proof system is Semaphore v4's own circuit with its Groth16 keys ([[0009-membership-proof]]). Threats: T-04, T-05, T-07, T-12, T-13, T-38.

## Source

The circuit is Semaphore v4's, unchanged:

- Repository `semaphore-protocol/semaphore`, tag `v4.14.3`, commit `4dbc39b83a4066bf5084fd7f5d336202aad2f815`.
- Circuit: `packages/circuits/src/semaphore.circom`, sha256 `d67fbae4504476569c03ce7beb23bacf4c4ebb9cbd8f49888f57ed14b288e486`.
- Field mapping of message and scope: `packages/proof/src/hash.ts` at the same commit.
- Proving and verification keys: Semaphore's multi-party trusted setup, one key pair per maximum tree depth `D` from 1 to 32. How they are pinned, hashed into the election definition and checked is P1-17b's.

A later Semaphore release is adopted only by an ADR, and only if the statement below is unchanged; otherwise it is a new ballot version ([[versioning]]).

## Statement

Notation: `r` is the BN254 scalar field order ([[notation]], `field<bn254>`); `l` = 2736030358979909402780800718157159386076813972158567259200215660948447373041 is the order of Baby Jubjub's prime subgroup and `B8` its generator (EIP-2494); `Poseidon2` is the two-input Poseidon hash over BN254 of circomlib; `LeanIMTRoot` is the root that zk-kit's `BinaryMerkleRoot(D)` computes from a leaf, a proof length, a path index and `D` siblings, with `Poseidon2` at every node.

Public inputs, in this order: `(ρ, ν, m̂, ŝ)`. Witness: `s`, the proof length `len`, the path index `index` (one field element, which the circuit decomposes into `D` bits) and `D` siblings, exactly Semaphore's `merkleProofLength`, `merkleProofIndex` and `merkleProofSiblings`. The circuit for depth `D` proves:

```
s < l
(Ax, Ay) = s · B8
C        = Poseidon2(Ax, Ay)                        identity commitment
ρ        = LeanIMTRoot(C, len, index, siblings)
ν        = Poseidon2(ŝ, s)                          nullifier
m̂ is constrained (m̂ · m̂), so the proof binds it
```

`ρ` and `ν` are the circuit's outputs and `m̂`, `ŝ` its public inputs; a Groth16 verifier takes them as the four public signals `[ρ, ν, m̂, ŝ]`. Every value is an element of the BN254 scalar field.

**The circuit doesn't constrain `len`.** For `len > D`, zk-kit's `BinaryMerkleRoot` outputs `ρ = 0` (its own documentation says to enforce `len ≤ D` outside the circuit), so anyone, with any secret and so any number of nullifiers, can prove membership of a group whose root is 0. A root of 0 is never a real tier: a verifier MUST fail a definition in which any tier's root is 0, and MUST NOT verify a membership proof whose `ρ` is 0 (Checks; T-04, T-05). A tier's root can become 0 without anyone forging it: an empty group, or a one-leaf LeanIMT whose only member was removed (Semaphore removes a member by setting its leaf to 0, and a one-leaf tree's root is its leaf).

## Scope

Each tier group `g` of the election definition, with root `root_g`, has its own scope:

```
S_g = H(DS("abolish/v1/nullifier-scope", definition_hash ‖ encode(root_g)))
ŝ_g = F(S_g)
```

- `definition_hash` is the election definition's hash (`bytes[32]`, [[domain-separation]], P1-10b), and `encode(root_g)` is the 32-byte `field<bn254>` encoding of the tier's root. The input after the tag is exactly 64 bytes.
- **Per poll.** The definition hash binds the poll, the chain IDs, the contract addresses and the election identifier, so a redeploy, a second chain or another poll never reuses a scope, and a nullifier reveals nothing across polls (T-12, T-30).
- **Per tier group.** A person whose secret is in two tier groups has two unrelated nullifiers in one poll. Their ballots in different tiers can't be linked through the nullifier (T-13), and each tier counts at most one of their ballots (G-2).
- **Never from the ballot.** A verifier computes `ŝ_g` itself from the definition, and never takes a scope from a ballot, a relay or a server ([[verifier]] 5.2).

## Message

The message is a 32-byte digest `M` that P1-12 and P1-13 define: at least the ballot hash, the election definition, the tier and whatever the re-vote rule ranks by ([[verifier]] 5.3, T-38). The circuit's public input is `m̂ = F(M)`.

## Field mapping

`F` maps 32 bytes into the field exactly as Semaphore v4's `hash` does:

```
F(x) = int(keccak256(x)) >> 8          (x: bytes[32])
```

- `keccak256` is Ethereum's Keccak-256 (Keccak with the original `0x01` padding), not FIPS 202 SHA3-256. `int` reads its 32-byte output as a big-endian integer. The shift leaves 248 bits, so `F(x) < 2²⁴⁸ < r`, and no reduction is needed.
- Semaphore's `hash(v)` hashes `v` as a 32-byte big-endian word, so `F(x)` equals Semaphore's `hash` of the integer whose 32-byte big-endian encoding is `x`. Stock Semaphore libraries and contracts, given `int(S_g)` as the scope and `int(M)` as the message, produce and check the same public inputs.
- `F` is an external format, as [[domain-separation]] allows: its inputs are already tagged digests, so it carries no tag of its own. Collisions in `F` cost about 2¹²⁴ Keccak evaluations.

## Tree depth

A tier group's proofs use the verification key for depth `D_g = max(1, ⌈log₂ n_g⌉)`, where `n_g` is the **leaf count** of the tier's LeanIMT at `root_g`: every insertion up to the root's block, removed members included (a removal sets a leaf to 0 but never shrinks the tree; Semaphore's `getMerkleTreeSize`). A verifier recomputes it from the group's additions on the board ([[verifier]] 2.4). It is not the anonymity-set size: once members are removed, the active member count reported with the results ([[verifier]] 8.1) is smaller, and using it here would give some members' paths no room, disenfranchising them by leaf position. Semaphore's keys stop at depth 32, so a tier group with more than 2³² leaves can't vote, and a verifier fails a definition that has one. That is the depth of a LeanIMT with `n_g` leaves, so every member's path fits (`len ≤ D_g`). A proof under any other depth is rejected, so all ballots of one tier use one key and the depth reveals nothing about the voter. The prover MUST pass `D_g` explicitly: Semaphore's library otherwise infers the depth from the path length, which LeanIMT shortens for some leaf positions in a tree that isn't full, so the inferred depth would narrow down the voter's position (T-13) and the proof would be rejected here.

## Checks

A verifier fails the election definition if any tier's `root_g` is 0 or its leaf count `n_g` is 0 or above 2³² ([[verifier]] 2.4). Then, for each ballot that claims tier group `g` ([[verifier]] 5.1–5.3), it:

1. Recomputes `ŝ_g` from the definition (Scope).
2. Takes `ρ = root_g` from the definition, never from the ballot; `ρ` is never 0 (Statement).
3. Decodes the ballot's nullifier `ν` as a `field<bn254>`, rejecting a non-canonical value (T-31).
4. Recomputes `m̂ = F(M)` from the ballot (P1-12, P1-13).
5. Verifies the Groth16 proof under the depth-`D_g` verification key it pins, with public signals `[ρ, ν, m̂, ŝ_g]`. Any failure rejects the ballot.

Because the root and the scope are both fixed per tier group, a proof made for one tier never verifies as another: no relay or operator can move a ballot between tally cells ([[verifier]] 2.8). The election definition's rule that no two tiers share a root (P1-10b) makes the tier unambiguous from the root alone; the scope binds it a second time.

## Security notes

- **Zero knowledge.** Groth16 proofs are perfectly zero-knowledge for a well-formed reference string (Groth, EUROCRYPT 2016), so a proof reveals nothing about `s`, the leaf or the path, even to an unbounded adversary ([[0002-everlasting-privacy]]). Against a subverted setup this holds only if the proving key's reference string is well formed (Fuchsbauer, PKC 2018), so it MUST be checked: once per pinned key, publicly, by P1-17b, which binds the checked key into `abolish/v1/membership-vk`, and the prover MUST use exactly that key. It also holds only if the prover's Groth16 randomisers come from a CSPRNG (P2-8, P5-4 check their prover's randomness source).
- **Nullifier privacy is computational.** `ν = Poseidon2(ŝ, s)`: linking nullifiers across scopes, or a nullifier to an identity commitment, needs `s` or a Poseidon preimage (T-12, T-15).
- **Soundness** rests on Semaphore's ceremony (T-07), on the circuit (T-05) and on BN254, whose discrete-log security is about 100–110 bits after the tower number field sieve ([[0007-group-and-hash]]): a forged proof would admit a non-member, and a second nullifier for one identity would need a Poseidon collision.
- **Chosen-scope linkage.** `S_g` is public, so any other Semaphore application that holds the voter's identity could ask for a proof under scope `int(S_g)` and so learn the voter's nullifier for that poll and tier. The domain tag stops accidental collisions, not this. The prover MUST therefore use the Abolish identity secret for nothing but Abolish membership proofs, never export it to another Semaphore application, and prove only under a scope it recomputed from a definition it verified (P2-6, P2-8, P5-4; T-12).
- **Malleability.** Anyone can re-randomise a Groth16 proof without the witness. Replay detection uses the nullifier and the message, never the proof bytes ([[verifier]] 5.7, 6.1 R1; T-38).
- **Small groups.** A tier group of one or two members gives its voters no meaningful anonymity. The group size is reported with the results (T-13, T-16).

## Owned elsewhere

- The verification keys, their hash in the election definition, the proof encoding and the Groth16 verification itself: P1-17b.
- `M`: P1-12 (ballot hash) and P1-13 (receipts and re-voting).
- Groups and their additions and removals: P3-2. The prover in the ballot client and native app: P2-8, P5-4.
