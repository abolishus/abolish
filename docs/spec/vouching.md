# Vouching

A Tier 1 member is admitted by vouches from `k` distinct Tier 2 members, each spending one of a lifetime budget of `L` slots, anonymously and checkably from the board ([[0014-tier1-vouching]], option C). Each vouch is a pair of Semaphore proofs under the pinned depth-32 key ([[membership]]): one under a scope per vouchee, so the vouchers are distinct, and one under a scope per slot, so each voucher's budget is bounded. This page fixes the parameters, the binding, both scopes, both messages, the vouch and the Tier 1 addition record, and the checks of one addition on its own. Threats: T-02, T-06, T-22, T-13, T-12, T-31, T-52.

What one addition can't show on its own is decided across the deployment (Counting across the deployment, below): that each vouch's Tier 2 root is the root of a tier-2 group of the same registry at a block on the root grid within the root window of the addition, that no earlier counted vouch in the deployment used its slot nullifiers, that its commitment isn't already a leaf of the group, the rule for MOCK Tier 2 members, the total order over additions, and batched verification ([[0014-tier1-vouching]], Rules for P3-3 part 2). That rule replaces the Safe's signature for Tier 1 in [[verifier]] 2.4. The group registry's call that logs an addition, and the checks it makes as spam control, are [[contracts]] (Group registry, Tier 1 additions). The call is built in P3-3 part 3b, and every vouch names a Tier 2 group, which waits for P3-4, so no vouched addition counts toward any tier today.

## Parameters

| Name          | Value | Meaning                                                                                                    |
| ------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `VOUCH_K`     | 3     | `k`: the vouches a Tier 1 addition carries, from pairwise-distinct vouchers and slots                      |
| `VOUCH_SLOTS` | 12    | `L`: the slots of each Tier 2 secret, numbered `0` to `L − 1`, across every Tier 1 group of the deployment |

Both are constants of the deployment's registry and of the addition record's layout below; the root grid's `VOUCH_ROOT_INTERVAL` and `VOUCH_ROOT_WINDOW` are in [[parameters]] (Counting across the deployment). Changing either needs a new registry and full re-admission to Tier 1, never a second rule alongside the first, so no budget is spent twice ([[0014-tier1-vouching]], Recommendation). [[parameters]] lists them.

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
- **The root is named.** The group and block naming the root are in both messages, so a relay can't rewrite which root a vouch claims, even to another block with the same root: one vouch has one reading, and the window check (Counting across the deployment) judges the block the voucher chose.
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

`root` is carried so that a vouch can be checked, and a contract can check it as spam control, without rebuilding Tier 2; a verifier never trusts it, and requires it to equal the root it rebuilds for `tier2_group_id` at `root_block` (`root-mismatch`, Counting across the deployment). Both proofs prove against one root: a vouch from pooled secrets still names one Tier 2 group and block.

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

**A failing addition never fails anything else.** An addition that fails any check, here or in Counting across the deployment, doesn't count: it takes no leaf of the tier tree and consumes no slot, and it never fails the group or any definition naming it. That differs from the group registry's signed Tier 0 records, whose failure means a rewritten history (`group-history`, [[contracts]], Group registry, Verification): anyone can submit a Tier 1 addition, so treating a bad one as a fault would let anyone fail every election naming the group (T-25, T-53). The one exception is a logged addition that doesn't decode, which fails contract-event version 6's, 7's and 8's event check and so 4.4 ([[contracts]], Event tables (version 6)); the release's registry never logs one (rules 2, 4, 5 and 7), so only a rewritten chain or other bytecode can (T-71). A Tier 1 group's leaves are numbered by its counted additions alone (Counting across the deployment, Counted additions), so an addition the registry logs but the verifier doesn't count takes no index. Proofs are malleable: a re-randomised proof is the same vouch, with the same nullifiers, and its nullifiers, never its bytes, are what the slot accounting counts ([[membership]], Malleability; T-38).

`checkTier1Addition` in `packages/crypto` runs exactly these checks, the check of one addition alone; `vouchScope`, `vouchSlotScope` and `vouchMessage` compute the scopes and messages for the prover (P2-8) and the verifier.

## Counting across the deployment

Which Tier 1 additions count, and so which leaves every Tier 1 group's tier tree holds, is decided over the whole registry at once, because slots are deployment-wide ([[0014-tier1-vouching]], Order). This is how [[verifier]] 2.4 counts an addition toward Tier 1. Threats: T-06, T-02, T-13, T-22, T-52, T-71.

### Order

Every Tier 1 addition the registry logs, in every Tier 1 group, is taken in one total order: the registry's log order, L2 block number and then position in the block, which is the order of its event sequence ([[contracts]], Group registry, Verification; Event accumulator). "Earlier" below means earlier in this order, and `b_A` is the L2 block of an addition's log, which the event accumulator binds.

- **Reordering cancels no honest vouch.** Only a voucher's own secret makes its slot nullifiers, so whoever orders the chain can only choose which of one voucher's own double-spent vouches counts (T-71).
- **One replay for every group.** To decide the additions up to an L2 block `b`, a verifier replays every Tier 1 addition of the registry in blocks up to `b`, in every Tier 1 group, junk groups included; no later addition changes an earlier one's verdict. A Tier 1 group's tier tree at a definition's `root_l2_block` therefore needs the registry's whole Tier 1 history up to that block (Known-weak, Replay cost).

### The root a vouch names

A vouch names its Tier 2 root by `tier2_group_id` and `root_block`, and the verifier judges that root itself:

- **The group.** `tier2_group_id` is a group of the same registry (the chain ID and registry of the binding, never anything the vouch carries) whose `GroupCreated` logs tier 2, in a block at or before `root_block`.
- **The root.** The group's tier tree ([[membership]], Tier tree) over its records in L2 blocks up to and including `root_block`, counted and replayed as [[verifier]] 2.4 counts and replays a Tier 2 group, outside any election. The vouch's `ρ` must equal it. Every record the tree needs carries its L2 block number in the event accumulator, so the root at a block number is a function of the archived events alone, with no header.
- **The root grid.** `root_block` is a multiple of `VOUCH_ROOT_INTERVAL` ([[parameters]]). A grid of block numbers coarsens what `root_block` says about when the voucher's client synced (T-22), and makes every voucher who syncs within the same interval name the same root, so a vouch's root says no more about its voucher than the interval does (T-13), while needing no block header or anchoring clock to judge ([[0014-tier1-vouching]], Amendment).
- **The root window.** `root_block ≤ b_A ≤ root_block + VOUCH_ROOT_WINDOW`. A removed Tier 2 member stops vouching once every grid block before their removal is out of the window, and a vouch held back past the window can never count.
- **No tree past 2³².** A Tier 2 group with more than 2³² additions by `root_block` has no tier tree, and a vouch naming it fails `root-mismatch`.
- **A broken Tier 2 history.** Tier 1 counting rests on every Tier 2 group of the registry, so a Tier 2 record that breaks its group's strict replay ([[contracts]], Group registry, Verification) breaks Tier 1, whatever any vouch names. Let `b_R` be the L2 block of the earliest such record in the registry's log order. Every definition naming a Tier 1 group of the registry whose Tier 1 replay reaches `b_R` (a fixed tier's `root_l2_block`, or a rolling tier's last accepted step, at or after `b_R`) fails as `group-history`, naming that record; additions in blocks before `b_R` count as above, since no root they name depends on it. Two other events break it the same way, at their own blocks: a members record (`MembersAdded`, `MembersRemoved` or `SelfPaidMemberAdded`) naming a group with no earlier creation (`GroupCreated` or `SelfPaidGroupCreated`), of any tier or kind, and a second creation of either kind for a group identifier already created. A `SelfPaidMemberAdded` naming a Tier 2 group fails that group's strict replay at `group` ([[contracts]], Group registry, Verification), so it breaks Tier 1 as any such record does; a self-paid group is of tier 0, so no vouch names it and no Tier 1 addition enters it. Each is judged when it is logged, from earlier events alone, so no later event moves a break earlier and a replay that stops sooner agrees on everything before its end. The registry numbers groups in creation order and refuses records for a group that doesn't exist ([[contracts]], Group registry, Groups), so neither comes from the release's bytecode. The trigger depends only on the registry's events, never on which vouch names what, so conforming verifiers agree. The Tier 2 addition path (P3-4) MUST make the registry refuse every Tier 2 record the strict replay refuses, and MUST make a Tier 2 group's tier tree at a block depend only on data fixed by that block (revocation lists among it), so that on the release's bytecode, on an honest chain, no logged record breaks the replay and no voucher, registrant or relay can trigger this (T-71, T-25, T-53).

### MOCK Tier 2 members

Tier 2's nullifier type (non-salted, salted or MOCK) is fixed per deployment ([[0010-tier2-identity-provider]], Nullifier uniqueness). The Tier 2 addition path (P3-4) MUST make it an immutable constant of the group registry's deployment, logged at deployment and pinned by the release like the registrars, so every Tier 2 group of a registry has the same type and no registry holds MOCK and real groups side by side. [[verifier]] 2.4 reads it from there. In a registry whose type is MOCK every counted Tier 1 addition may rest on mock vouchers, and 2.4 fails a definition naming any of the registry's Tier 1 groups unless it carries the test flag and its chain is on the pinned allow-list (P3-4 specifies both), exactly as for its Tier 2 groups. Counting itself is the same either way, so one replay serves every definition.

### Checks

Each Tier 1 addition, in order, counts if it passes all of the following. A verifier reports the first failure in this order, each check run over the vouches in record order before the next, with the failing vouch's position where there is one, so conforming verifiers name the same reason. `g` is the record's `group_id`:

1. **`decode`** to **`duplicate-slot`**: checks 1 to 6 of Checks of one addition, with the binding's `chain_id` and `registry` those of the registry that logged it.
2. **`group`**: `g` is a group of this registry whose `GroupCreated`, earlier in the registry's event sequence, logs tier 1. The group is the record's own `group_id`: the registry's `Tier1MemberAdded` names no other ([[contracts]], Group registry, Events).
3. **`root-grid`**: each vouch's `root_block` is a multiple of `VOUCH_ROOT_INTERVAL`.
4. **`root-window`**: each vouch's `root_block ≤ b_A` and `b_A − root_block ≤ VOUCH_ROOT_WINDOW`.
5. **`tier2-group`**: each vouch's `tier2_group_id` is a group of this registry whose `GroupCreated` logs tier 2, in a block at or before its `root_block`.
6. **`root-mismatch`**: each vouch's `ρ` equals that group's tier-tree root at its `root_block` (The root a vouch names).
7. **`slot-spent`**: no vouch's slot nullifier equals a slot nullifier of a vouch of an earlier counted addition, in any Tier 1 group of the registry.
8. **`member`**: `C_V` isn't the leaf of an earlier counted addition of `g` (Tier 1 has no removals, below).
9. **`proof`**: check 7 of Checks of one addition.

The checks that need no pairing and no counting state come first, so most junk is refused cheaply; `root-mismatch` needs the Tier 2 trees, which one pass over the registry's events builds for every grid block at once (T-52). Slot nullifiers are compared as values, never as proof bytes, so a re-randomised copy of a counted vouch fails `slot-spent` ([[membership]], Malleability; T-38).

### Counted additions

A counted addition appends `C_V` as `g`'s next leaf, whose index is the number of earlier counted additions of `g`, and consumes its `k` slot nullifiers, for good ([[0014-tier1-vouching]], Rules for P3-2). An addition that fails consumes nothing and takes no index (Checks of one addition). So a Tier 1 group's tier tree at a block `b` has one leaf per counted addition in blocks up to `b`, in order, and its member count at `b` is the number of those leaves.

There are no Tier 1 removals: the registry refuses `removeMembers` for a Tier 1 group, and a verifier applies none to it ([[contracts]], Group registry, Tier 1 additions, No Tier 1 removals; [[0014-tier1-vouching]], Amendment 2). So no Tier 1 leaf is ever 0. A `MembersAdded` or `MembersRemoved` naming a Tier 1 group, which the registry refuses, adds or removes nothing in it.

### Batched verification

The `2k` Groth16 verifications of each addition are where the cost lies ([[0014-tier1-vouching]], Cost). A verifier MAY check many proofs together with the small-exponent batch test (Bellare, Garay and Rabin, "Fast batch verification for modular exponentiation and digital signatures", EUROCRYPT 1998), applied to Groth16's verification equation as Zcash's `bellman` batch verifier applies it: with independent random scalars `r_i`, the products over the batch of `e(A_i, B_i)^{r_i}` and of the right-hand sides raised to the same `r_i` are compared, which costs `N + 3` pairings for `N` proofs rather than four per proof, the public-input terms folded into one multi-scalar multiplication. Batching changes cost, and a verdict only with negligible probability:

- **One key.** A batch holds only proofs under the pinned depth-32 key ([[membership]], Verification key); the shared key is what lets the `e(α, β)`, `γ` and `δ` terms fold into three pairings.
- **Strict decoding first.** Every proof in a batch has passed [[membership]]'s Proof encoding, so each point is on its curve and in its prime-order subgroup; the batch test is sound only in a group of prime order.
- **Coefficients from the verifier.** Each `r_i` is a uniform scalar of at least 128 bits from a CSPRNG, drawn by the verifier after it holds every proof of the batch, never derived from the proofs, the board or anything a submitter controls; `r_1` may be 1. A batch holding an invalid proof then passes with probability at most `2^−128`.
- **A failed batch is resolved.** A batch that passes accepts every proof in it; one that fails is split, or its proofs verified one at a time, until each proof's own verdict is known. So the reported first failure is the one individual verification gives.
- **Any grouping.** A proof's verdict doesn't depend on counting state, so a batch may hold proofs of any additions; a verifier can check every proof of the replay in batches first and then walk the order.
- **Proofs last.** A verifier SHOULD instead walk the order first, taking each addition that passes checks 1 to 8 as counted provisionally, then batch the proofs of the provisional additions only. If an addition's proof fails, it doesn't count, and the walk is redone with the failure known, since an addition that fails consumes nothing; the verdicts are those of the order above. The registry logs no addition with a failing proof ([[contracts]], Group registry, Tier 1 additions), so on an honest chain one walk suffices and pairings are spent only on additions that count, which the Tier 2 members' slots bound, never on copies of counted additions, which fail `slot-spent` or `member` first and which anyone can log without bound. `countTier1Additions` checks proofs this way: it batches the proofs of the additions the first walk counts; if all pass, that walk is the count, and otherwise it walks once more from the start, checking each addition's proofs as it reaches `proof` (the batch's verdicts where it has them). So whatever a rewritten history logs, a replay takes at most two walks, each proof is checked at most once, and pairings go only to additions that reach `proof` in one of the two walks; the second walk, and its proofs checked an addition at a time, follow only a failed proof, which the release's registry never logs.

Individual verification ([[membership]], Verification) remains the reference: a verifier that never batches reaches the same verdicts. Batching relieves honest load, not flooding: anyone can cheaply build junk additions that reach `proof` (random nullifiers against a public Tier 2 root), and every such batch fails and falls back (T-52). The registry refuses them, since it checks every proof before it logs an addition ([[contracts]], Group registry, Tier 1 additions), so on the release's bytecode, on an honest chain, no logged addition carries a failing proof and no batch falls back; only a rewritten history or a registry from other code logs one.

`verifyDecodedMembershipProofs` in `packages/crypto` batches this way. It takes the proofs in order in batches of at most 64, so an invalid proof can cost batching only within its own batch. A batch that fails is split in halves, each batched again with fresh coefficients, and a part below 33 proofs that fails, or any part below 5, is checked proof by proof. Measured on one core of a 2.8 GHz Xeon under Node 24 with `@noble/curves` 2.4.0, over real vouch proofs (`vectors/vouch.json`):

| Proofs | One at a time | Batched, all valid | Batched, one invalid in every 64 | Batched, all invalid |
| ------ | ------------- | ------------------ | -------------------------------- | -------------------- |
| 6      | about 0.35 s  | about 0.14 s       |                                  | about 0.4 s          |
| 64     | about 3.0 s   | about 0.55 s       | about 2.6 s                      | about 4.1 s          |
| 640    | about 30 s    | about 5.1 s        | about 25 s                       | about 40 s           |

So batching cuts an honest replay's proof checks to about a sixth of checking them one at a time, about 8 ms a proof. One invalid proof in every 64 leaves about 85% of the one-at-a-time cost, and a flood of junk costs about 1.35 times it. An addition carries six proofs, so junk additions about one in ten of the replay's would take most of the gain away; the registry keeps them off the chain (above). Absolute times depend on the machine; the ratios are what the choice rests on.

## Prover rules

These bind the ballot client (P2-6, P2-8), and part 3 builds them. How the vouchee's addition reaches the registry through our API, or directly, is [[tier1-relay]]'s:

- **The root.** Prove only against a Tier 2 root the client rebuilt itself from the group's additions ([[membership]], Owned elsewhere), at the newest block on the root grid that the L2 chain derived from L1 data contains, so the root can't change under the vouch short of an L1 reorganisation ([[0004-l2-choice]], Finality); refuse to vouch once that block is too old for the vouchee to submit within `VOUCH_ROOT_WINDOW`; check the root again once that block's L1 data is final, and tell the vouchee to ask for a new vouch if it changed, as for rolling steps ([[membership]], Root clock and steps).
- **The slot.** Pick an unused `j` uniformly at random from `[0, L)` rather than counting up, so `j` doesn't reveal how many vouches the voucher has made; keep a slot spent until its slot nullifier is consumed by a counted addition, or until L2 block `root_block + VOUCH_ROOT_WINDOW` is final, after which the vouch can never count; then check whether it was consumed by fetching every consumed slot nullifier (or the whole board) and matching its own locally, never by asking about its own values (T-10, T-22); never reuse a slot whose slot nullifier appears in any logged addition, counted or not, since a second vouch from it would show the same `ν_S` and `j` beside a second vouchee's `C_V` and link the two vouchees to one voucher (T-22); never store `C_V` next to the slot spent ([[0014-tier1-vouching]], Slots).
- **The group.** Vouch only for a Tier 1 group whose `GroupCreated` is in finalized L2 history. Group identifiers are a counter, so a reorganisation that reorders two creations swaps them, and a vouch made for an unfinalized group could land in a stranger's group of the same tier, spending its slot there ([[contracts]], Group registry, Groups; T-71).
- **The vouchee.** Refuse to vouch for a forbidden commitment, or for one already in any Tier 1 or Tier 2 group ([[0014-tier1-vouching]], Fresh commitment).
- **Self-check.** Verify both proofs under the pinned key before the vouch leaves the device ([[membership]], Security notes).

`vouchProverInput` in `packages/crypto` builds both proofs' circuit inputs from the voucher's own secret and the Tier 2 leaves its client rebuilt, on one path, with both scopes, both nullifiers and the cross-bound messages computed there, never taken from the vouchee or a server; it refuses a forbidden vouchee commitment, one among the Tier 2 leaves (the voucher's own included), a slot outside `[0, L)` and a root block off the grid. `finishVouch` verifies the prover's two proofs under the pinned key against those signals, re-randomises each with the client's CSPRNG and verifies it again, as a ballot's proof is finished ([[membership]], Security notes), and gives the vouch; `pickVouchSlot` draws `j` uniformly from the slots the client hasn't marked unavailable. Whether the root block is the newest derived from L1 data and inside the window, whether the Tier 1 group is final, whether the vouchee is in any other group, and which slots are unavailable are the client's own state (P2-8).

## Vectors

`vectors/vouch.json` (format `abolish-vouch-vectors/1`, see [[vectors/README|vectors]]), printed by `packages/crypto/scripts/vouch-vectors.mjs`, gives the scopes and messages, a Tier 2 tier tree, honest additions (a pooled vouch and re-randomised proofs among them) and additions each check refuses, with real Semaphore proofs. `vectors/vouch-count.json` (format `abolish-vouch-count-vectors/1`), printed by the same script, gives whole registry event sequences for Counting across the deployment: Tier 2 groups whose additions and removals the test registrars sign, Tier 1 additions refused by each counting check (one whose first vouch fails a later check than its second), additions that count after refused ones reusing their slots (a refused addition consumes nothing), a slot spent in one Tier 1 group and reused in another, a re-randomised copy of a counted addition, a commitment counted in two groups, a Tier 2 member who joined after the first grid block, a Tier 2 group created and filled in the root block itself, a root after a removal, both edges of the window, a Tier 1 group created in the addition's block but after it, and a Tier 2 history broken by a misplaced record, by a repeated `GroupCreated`, by a record before its group's creation and by a record naming no group, each with the additions decided, the break and each Tier 1 group's leaves at chosen blocks. The generator shares no code with `packages/crypto`: proofs come from Semaphore 4.14.3's own prover and are checked by snarkjs, hashes from `node:crypto` and Semaphore's own field mapping, the tier tree from `poseidon-lite`, and the Tier 2 records' EIP-712 digests, signatures and recovery from ethers. Each counting case's verdicts, break and leaves are written by hand, and the script refuses to print one its own replay of the rule doesn't reproduce.

`vectors/vouch-prover.json` (format `abolish-vouch-prover-vectors/1`), printed by `packages/crypto/scripts/vouch-prover-vectors.mjs`, gives `vouch.json`'s vouchers with their secrets, a root block on the grid, both proofs' circuit inputs as Semaphore 4.14.3's own `generateProof` builds them, its proofs, each vouch's bytes and an addition of three, for the Prover rules; it shares no code with `packages/crypto` either.

`countTier1Additions` in `packages/crypto` runs Counting across the deployment over a registry's events, with the proofs checked last by `verifyDecodedMembershipProofs` (Batched verification, Proofs last); `groupRegistryEvents` reads those events from the registry's contract-event records under the pinned version, reporting the first that fails the event check, and gives each `MembersAdded` its `firstIndex` topic, so an addition whose own `first_index` differs breaks its group as `position` ([[contracts]], Group registry, Verification); and `tier1Leaves` gives a Tier 1 group's leaves at a block, or `group-history` once the replay reaches a break.

## Known-weak

- **Nothing counts yet.** The group registry's Tier 1 call is built ([[contracts]], Group registry, Tier 1 additions; [[P3-3]] part 3b-1), but every vouch names a Tier 2 group, which no registry can create before P3-4. The counting rule has code and vectors (`countTier1Additions`), but no verifier calls it until [[verifier]] 2.4 reads Tier 1 groups.
- **A held vouch can link two vouchees.** A vouch handed to a vouchee who holds it past its window can never count, so its voucher's client releases the slot (Prover rules) and may spend it on a second vouchee. The registry refuses an addition outside any of its vouches' root windows ([[contracts]], Group registry, Tier 1 additions, rule 5), so the stale vouch can't be logged on the release's registry; but the first vouchee can still publish it anywhere else, and its `ν_S` and `j` then match the second vouch's, showing that one voucher vouched for both (T-22). Never reusing a slot whose vouch was handed out would close it, at the cost of locking the slot for good.
- **The vouchee's IP address.** Whoever receives an addition sees the sender's network address next to `C_V` (T-11, T-22); [[0014-tier1-vouching]] states it. A vouchee who submits directly pays from an address, whose funding is then linked to `C_V` on chain (T-11, T-13).
- **Sync time.** Each vouch's public `root_block` shows when the voucher's client last synced Tier 2, to within the root grid's `VOUCH_ROOT_INTERVAL` (T-22).
- **The grid follows L2 block time.** `VOUCH_ROOT_INTERVAL` and `VOUCH_ROOT_WINDOW` are counted in L2 blocks and sized for Base's 2-second blocks ([[parameters]]). If the chain shortens its block time the interval and window shrink in seconds; they are constants of the registry's deployment, so changing them is a new registry.
- **Held vouches lock slots.** A vouch handed to a vouchee who never submits it holds its slot for up to `VOUCH_ROOT_WINDOW` after its root block is final, a week, before the voucher's client releases it.
- **Replay cost.** Slots are deployment-wide, so rebuilding any one Tier 1 group means replaying every Tier 1 addition of the registry up to its root block, junk groups included, and checking `2k` proofs for each that reaches `proof`; batching lowers the pairing count, not the replay (Batched verification; T-52, [[0014-tier1-vouching]], Cost). The registry checks every proof, so on an honest chain an addition that reaches `proof` counts, and a verifier that checks proofs last spends pairings only on counted additions, bounded by the slots the Tier 2 members have (Batched verification, Proofs last); one that batches every proof first also checks the proofs of copies of counted additions, which anyone can log without bound. Junk additions naming made-up roots, and copies, stay unbounded in number, at about 1.5 million gas each to their senders, and cost a verifier their decoding and a lookup each ([[contracts]], Group registry, Known-weak). Each Tier 2 group a vouch names is replayed once, its root taken at every block named.
- **A rewritten Tier 2 history stops Tier 1.** A Tier 2 record that breaks the strict replay, which only a rewritten chain shows once P3-4 meets its MUSTs, fails every definition whose Tier 1 replay reaches it, not only those whose vouches name it (The root a vouch names; T-71).
- **Released slots can still link.** A vouch that reached the board in an addition that didn't count shows its `ν_S` and `j` publicly, so the client never reuses that slot (Prover rules); a voucher whose client loses that record and reuses the slot links the two vouchees (T-22).
- **Size.** An addition is 1,919 bytes at `k = 3`, and checking one costs `2k = 6` Groth16 verifications.
