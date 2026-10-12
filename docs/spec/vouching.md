# Vouching

A Tier 1 member is admitted by vouches from `k` distinct Tier 2 members, each spending one of a lifetime budget of `L` slots, anonymously and checkably from the board ([[0014-tier1-vouching]], option C). Each vouch is a pair of Semaphore proofs under the pinned depth-32 key ([[membership]]): one under a scope per vouchee, so the vouchers are distinct, and one under a scope per slot, so each voucher's budget is bounded. This page fixes the parameters, the binding, both scopes, both messages, the vouch and the Tier 1 addition record, and the checks of one addition on its own. Threats: T-02, T-06, T-22, T-13, T-12, T-31, T-52.

What one addition can't show on its own is P3-3 part 2b's, and is added here before any group registry accepts Tier 1 additions ([[contracts]], Group registry): that each vouch's Tier 2 root is the root of a tier-2 group of the same registry at an anchoring period boundary within the root window `W` of the addition, that no earlier counted vouch in the deployment used its slot nullifiers, that its commitment isn't already an unremoved leaf, the rule for MOCK Tier 2 members, the total order over additions, and batched verification ([[0014-tier1-vouching]], Rules for P3-3 part 2). Until then no vouched addition counts toward Tier 1, and no Tier 1 group can be created: the group registry refuses tier 1 until its addition path exists ([[contracts]], Group registry, Groups), so [[verifier]] 2.4's Safe wording for Tier 1, which 2b replaces, applies to no group.

## Parameters

| Name          | Value | Meaning                                                                                                    |
| ------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `VOUCH_K`     | 3     | `k`: the vouches a Tier 1 addition carries, from pairwise-distinct vouchers and slots                      |
| `VOUCH_SLOTS` | 12    | `L`: the slots of each Tier 2 secret, numbered `0` to `L − 1`, across every Tier 1 group of the deployment |

Both are constants of the deployment's registry and of the addition record's layout below. Changing either needs a new registry and full re-admission to Tier 1, never a second rule alongside the first, so no budget is spent twice ([[0014-tier1-vouching]], Recommendation). [[parameters]] lists them.

## Binding

A Tier 1 group is named by its **binding**, the same three values [[verifier]] 2.4 binds every addition to:

```
binding = u64(chain_id) ‖ bytes[20](registry) ‖ u64(group_id)          36 bytes
```

`chain_id` is the L2's chain ID, `registry` the group registry's address and `group_id` the Tier 1 group's identifier in it ([[contracts]], Group registry, Groups).

## Scopes

Each vouch has two proofs, each under its own scope (`H` is SHA-256 and `F` the field mapping of [[membership]], Field mapping):

```
S_V  = H(DS("abolish/v1/vouch", binding ‖ encode(C_V)))                       68-byte input
S_j  = H(DS("abolish/v1/vouch-slot", u64(chain_id) ‖ bytes[20](registry) ‖ u16(j)))   30-byte input
ŝ_V  = F(S_V),  ŝ_j = F(S_j)
```

- `C_V` is the vouchee's commitment, the one the addition inserts, as a `field<bn254>`.
- **Per vouchee.** The vouchee proof's nullifier `ν_V = Poseidon2(ŝ_V, s)` is one value per voucher secret `s` and vouchee in that group, so `k` distinct `ν_V` mean `k` distinct Tier 2 secrets, by Semaphore's soundness ([[membership]], Security notes).
- **Per slot.** The slot proof's nullifier `ν_S = Poseidon2(ŝ_j, s)` is one value per secret and slot `j`. The slot scope binds the chain and the registry and nothing else: binding the group would let an operator hand every voucher `L` fresh slots by creating another Tier 1 group ([[0014-tier1-vouching]], Budget).
- **Never from the record.** A verifier recomputes both scopes from the binding, `C_V` and `j`, never takes a scope from a record, a relay or a server.
- **Separate from voting.** Both tags differ from `abolish/v1/nullifier-scope`, so a voucher's vouch nullifiers are unrelated to their vote nullifiers ([[membership]], Chosen-scope linkage).

## Messages

Each proof's message binds the vouchee, the Tier 2 root it proves against, and the other proof's nullifier:

```
M_V = H(DS("abolish/v1/vouch-message", u8(0) ‖ binding ‖ encode(C_V) ‖ u64(tier2_group_id) ‖ u64(root_block) ‖ encode(ν_S)))
M_S = H(DS("abolish/v1/vouch-message", u8(1) ‖ binding ‖ encode(C_V) ‖ u64(tier2_group_id) ‖ u64(root_block) ‖ encode(ν_V)))
m̂_V = F(M_V),  m̂_S = F(M_S)
```

Each input after the tag is exactly 117 bytes. The first byte is the proof's role, `0` for the vouchee proof and `1` for the slot proof, so neither message can stand for the other. `tier2_group_id` and `root_block` name the Tier 2 root (The vouch, below).

- **Cross-binding.** Each nullifier depends only on the secret and a public scope, so the voucher computes both before proving either. Because each message names the other proof's nullifier and `C_V`, nobody holding a vouch can pair its slot proof with another vouchee proof, or move either proof to another vouchee, group, registry or chain ([[0014-tier1-vouching]], Cross-binding).
- **The root is named.** The group and block naming the root are in both messages, so a relay can't rewrite which root a vouch claims, even to another block with the same root: one vouch has one reading, and part 2b's window check judges the block the voucher chose.
- **Pooling stays possible.** Unmodified Semaphore can't show that a vouch's two proofs come from one secret. Colluders can make a vouch from one member's vouchee proof and another's slot proof, each binding the other's nullifier; such a vouch is valid, and the bound of [[0014-tier1-vouching]] counts every secret that contributes either proof (T-02). The vectors include one.

## The vouch

A vouch is a fixed 626-byte structure:

| Field               | Type               | Bytes | Meaning                                                              |
| ------------------- | ------------------ | ----- | -------------------------------------------------------------------- |
| `tier2_group_id`    | `u64`              | 8     | The Tier 2 group both proofs prove membership of                     |
| `root_block`        | `u64`              | 8     | The L2 block at which that group's tier-tree root is taken           |
| `root`              | `field<bn254>`     | 32    | `ρ`, that root: the public input both proofs use                     |
| `slot`              | `u16`              | 2     | `j`, the slot spent                                                  |
| `vouchee_nullifier` | `field<bn254>`     | 32    | `ν_V`                                                                |
| `slot_nullifier`    | `field<bn254>`     | 32    | `ν_S`                                                                |
| `vouchee_proof`     | `membership_proof` | 256   | Public signals `[ρ, ν_V, m̂_V, ŝ_V]` ([[membership]], Proof encoding) |
| `slot_proof`        | `membership_proof` | 256   | Public signals `[ρ, ν_S, m̂_S, ŝ_j]`                                  |

`root` is carried so that a vouch can be checked, and a contract can check it as spam control, without rebuilding Tier 2; a verifier never trusts it, and part 2b requires it to equal the root it rebuilds for `tier2_group_id` at `root_block`. Both proofs prove against one root: a vouch from pooled secrets still names one Tier 2 group and block.

## Tier 1 addition record

A Tier 1 addition carries its vouchee's commitment and exactly `k` vouches:

```
tier1_addition = u64(group_id) ‖ field<bn254>(C_V) ‖ u8(k) ‖ vouch × k
```

so a record is exactly `41 + 626 · k` bytes, 1,919 at `k = 3`, and the byte at offset 40 is `k`. Exactly `k` leaves no choice of subset, so every verifier reaches the same answer, and a vouchee's spare vouches can't be split into a second addition that burns honest slots ([[0014-tier1-vouching]], Authorisation); the count byte makes the record self-describing, never variable. `group_id` is the Tier 1 group; the chain ID and the registry's address come from where the record was logged ([[contracts]], Group registry, Verification), never from the record. Like the group registry's other records, it is contract calldata with no record header ([[notation]]): its layout is fixed by the registry deployment that accepts it (the release pins the registry), and a new layout is a new registry, never a second layout in one. So it takes no entry in [[versioning]]'s record-type registry, which [[0014-tier1-vouching]] listed among the pages part 2 changes: the group registry's records never have.

A strict decoder refuses, with these codes:

- a record whose length isn't exactly `41 + 626 · k`, or whose count byte isn't `k` (`length`, as for the group registry's other records). Both are checked before any field is read, so a short addition, or one padded with 255 vouches' worth of points to check, costs nothing to refuse (T-52), and a contract that mirrors the decoder archives nothing longer (T-17). An addition with more or fewer than `k` vouches is refused here and consumes nothing;
- `C_V`, a `root` or either nullifier at or above `r` (`non-canonical`, at the field's offset);
- a proof that doesn't decode as a `membership_proof` (`non-canonical`, at the broken point's offset within the record; [[membership]], Proof encoding).

Offsets are from the start of the record, and the first failing field in record order is reported.

## Checks of one addition

Given the binding's `chain_id` and `registry`, an addition passes if all of the following hold. A verifier reports the first failure in this order, with the failing vouch's position in the record where there is one, so conforming verifiers name the same reason:

1. **`decode`**: the record decodes strictly (above).
2. **`forbidden-commitment`**: `C_V` isn't forbidden ([[membership]], Commitments and removals). A vouch for a forbidden commitment counts for nothing, and a voucher's client refuses to make one.
3. **`slot`**: each vouch's `j < L`.
4. **`root`**: each vouch's `ρ ≠ 0`. Semaphore's circuit proves membership of root 0 for any secret ([[membership]], Statement).
5. **`duplicate-voucher`**: the `k` vouchee nullifiers are pairwise distinct; the position reported is that of the first vouch whose nullifier equals an earlier vouch's.
6. **`duplicate-slot`**: the `k` slot nullifiers are pairwise distinct, reported likewise. One slot can't fund two vouches of one addition.
7. **`proof`**: in record order, each vouch's vouchee proof (reported as `vouchee`) verifies under the pinned key with signals `[ρ, ν_V, m̂_V, ŝ_V]`, and then its slot proof (`slot`) with `[ρ, ν_S, m̂_S, ŝ_j]`, every scope and message recomputed from the binding, `C_V` and the vouch's own fields ([[membership]], Verification).

The cheap checks come first, so a malformed or duplicated addition is refused before any pairing (T-52).

**A failing addition never fails anything else.** An addition that fails any check, here or in part 2b, doesn't count: it takes no leaf of the tier tree and consumes no slot, and it never fails the group or any definition naming it. That differs from the group registry's signed Tier 0 records, whose failure means a rewritten history (`group-history`, [[contracts]], Group registry, Verification): anyone can submit a Tier 1 addition, so treating a bad one as a fault would let anyone fail every election naming the group (T-25, T-53). How the registry numbers additions it logs but the verifier doesn't count is part 3's, with part 2b. Proofs are malleable: a re-randomised proof is the same vouch, with the same nullifiers, and its nullifiers, never its bytes, are what part 2b's slot accounting counts ([[membership]], Malleability; T-38).

`checkTier1Addition` in `packages/crypto` runs exactly these checks; `vouchScope`, `vouchSlotScope` and `vouchMessage` compute the scopes and messages for the prover (P2-8) and the verifier.

## Prover rules

These bind the ballot client (P2-6, P2-8), and part 3 builds them:

- **The root.** Prove only against a Tier 2 root the client rebuilt itself from the group's additions ([[membership]], Owned elsewhere), at a block part 2b's window allows.
- **The slot.** Pick an unused `j` uniformly at random from `[0, L)` rather than counting up, so `j` doesn't reveal how many vouches the voucher has made; keep a slot spent until part 2b's rule releases it; never store `C_V` next to the slot spent ([[0014-tier1-vouching]], Slots).
- **The vouchee.** Refuse to vouch for a forbidden commitment, or for one already in any Tier 1 or Tier 2 group ([[0014-tier1-vouching]], Fresh commitment).
- **Self-check.** Verify both proofs under the pinned key before the vouch leaves the device ([[membership]], Security notes).

## Vectors

`vectors/vouch.json` (format `abolish-vouch-vectors/1`, see [[vectors/README|vectors]]), printed by `packages/crypto/scripts/vouch-vectors.mjs`, gives the scopes and messages, a Tier 2 tier tree, honest additions (a pooled vouch and re-randomised proofs among them) and additions each check refuses, with real Semaphore proofs. The generator shares no code with `packages/crypto`: proofs come from Semaphore 4.14.3's own prover and are checked by snarkjs, hashes from `node:crypto` and Semaphore's own field mapping, and the tier tree from `poseidon-lite`.

## Known-weak

- **One addition proves nothing about the deployment.** Until part 2b, a vouch's root isn't checked against Tier 2, its slot nullifiers aren't checked against earlier additions, and no addition counts toward Tier 1.
- **The vouchee's IP address.** Whoever receives an addition sees the sender's network address next to `C_V` (T-11, T-22); [[0014-tier1-vouching]] states it.
- **Sync time.** Each vouch's public `root_block` shows when the voucher's client last synced Tier 2 to that block; part 2b's rule that it be an anchoring period boundary coarsens this to the period (T-22).
- **Size.** An addition is 1,919 bytes at `k = 3`, and checking one costs `2k = 6` Groth16 verifications; part 2b batches them.
