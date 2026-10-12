# ADR 0018: Proving possession of per-election trustee keys

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-12
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-37, T-40, T-14, T-54, T-31 (see [[THREAT_MODEL]])

## Context

[[0002-everlasting-privacy]] (option B, accepted by the owner) replaces the DKG with key registration: for each election every trustee registers a fresh hybrid KEM key ([[share-encryption]], Trustee KEM key) and a per-election signing key ([[trustee-identity]], Which key signs what), "with proofs of possession: a challenge encapsulated to the KEM key that the trustee must answer, and a signature", in a public, anchored transcript. [[verifier]] 3.1 recomputes the qualified set and the registered keys from that transcript, never from its claims. P1-14 part 2 has to fix how possession is proven. The transcript is anchored and its hash is bound into every election definition, so the protocol and its record layout are a one-way door ([[versioning]], Frozen).

The KEM key has two halves, and possession means different things for each:

- **The Diffie–Hellman key** `dh = g^x`. A Schnorr proof of knowledge of `x` is standard and non-interactive. It matters because a trustee's complaint is a Chaum–Pedersen proof under `x` ([[share-encryption]], Complaints), and because it stops one seat registering another's `dh` as its own.
- **The ML-KEM-768 encapsulation key** `ek`. ML-KEM has no proof of knowledge of `dk` short of a general zero-knowledge proof (a new proof system, which the `crypto-review` skill forbids). Encapsulation is deterministic given its 32-byte message `m` (FIPS 203, `Encaps_internal`), so whoever knows `m` knows the shared secret. A non-interactive challenge (coins from a Fiat–Shamir hash) therefore proves nothing: anyone can compute the answer. A meaningful challenge needs coins the trustee doesn't know until after it has answered.

What possession buys here is narrower than in a DKG. There is no joint key, so there is no rogue-key attack on an aggregate (T-40). What remains is: a seat registering a key it can't open (its shares are then lost, which is as bad as an offline trustee, T-54), a seat copying another seat's key, and making failures attributable (T-29, T-37).

## Options

### A. Pairwise encapsulated challenges, answered before they are revealed

Four rounds, each message signed by the seat's pinned identity key and binding the hash of every earlier round:

1. Each seat posts its KEM key, its per-election signing key, a Schnorr proof of knowledge of `x` and a signature by the signing key.
2. Each seat draws a fresh secret `μ` for every other seat, hashes it with the run's context and the (challenger, target) pair into the ML-KEM message `m`, encapsulates `m` to the target's `ek` and posts the ciphertexts.
3. Each seat decapsulates every challenge addressed to it and posts, for each, a hash of the shared secret with the context and the (challenger, target) pair.
4. Each seat reveals its `μ`s. Anyone recomputes each `m`, re-encapsulates and checks both the challenge (it is a real encapsulation under the target's key, or the challenger is at fault) and the answer (it is that hash of the shared secret, or the target is at fault).

Because round 3's messages are fixed in the hash round 4 signs, a challenger reveals only after every answer is fixed, so a seat can't wait for the reveal and compute its answer. Within a round a seat can wait for the others (rushing), sign two different messages, and have a coordinator show different seats different ones. A seat holding a copied `ek` could then send a challenge it received to the key's real holder as its own and copy the holder's answer. Binding every answer to its pair stops that whatever view the holder was shown: the holder publishes only answers to challenges addressed to itself, so a qualified seat challenged by an honest qualified seat holds its key, and with at least `k` qualified seats and fewer than `k` corrupt (the threshold assumption, T-14) every corrupt qualified seat has such a challenger ([[ceremony]], Soundness). Binding the pair into `m` also makes a relayed challenge fail its reveal, which attributes the relay. The in-session review found the relay against a draft that bound neither; `crypto-review` on the PR found the view-split variant against a draft that bound only `m`.

- Pros: follows [[0002-everlasting-privacy]] literally. Publicly verifiable after the fact, with attribution of every failure to one seat. Uses only ML-KEM, ristretto255 Schnorr and ECDSA, all already in the protocol. No coordinator or creator is trusted for anything but liveness.
- Cons: four rounds and `n(n − 1)` ML-KEM ciphertexts, about 261 KB at `MAX_TRUSTEES` (16), well within [[parameters]]' `MAX_BOARD_PAYLOAD`. Every seat has to be online for all four rounds, which nodes run automatically when an election opens ([[0006-trustees]], rule 7, adopted by the owner on 2026-10-12, needs `max(k, n − 1)` of them). Decapsulating chosen ciphertexts is a decapsulation oracle, which ML-KEM's IND-CCA2 security covers.

### B. One challenger (the election's creator or a coordinator)

Two rounds: keys, then a challenge from the creator, answered and revealed. Pros: cheaper. Cons: a creator colluding with one trustee proves nothing about that trustee's key, and the creator is the party T-37 and T-34 are written against. Possession would rest on an untrusted party.

### C. Proof of knowledge of `x` only; no ML-KEM challenge

One round. Pros: simplest. Cons: an unopenable `ek` shows up only at intake, when that trustee fails to receipt shares and every ballot's share to it is posted, weakening post-quantum privacy for every ballot (the "offline trustee" cost of [[0002-everlasting-privacy]], Cons), with nothing attributable at the ceremony. It also departs from the ADR's text.

## Recommendation

A. It is the only option that proves possession of both halves without trusting the creator, it attributes every failure, and its costs are bounded by `MAX_TRUSTEES` and paid once per election. B trusts the party the threat model distrusts; C defers the failure to voting, where it costs privacy.

What would change it: a published, audited proof of possession for ML-KEM keys (then round 2 to 4 would shrink to one round), or an owner decision that trustees can't be online for four rounds (then B with a trustee rather than the creator as challenger is the fallback, at a weaker assurance).

## Consequences

- [[ceremony]] (new spec page) specifies the rounds, the ceremony context, the transcript record (`0x0005`, version 1), its hash, and the transcript check of [[verifier]] 3.1 and 3.2: which failures make the transcript invalid (anything a coordinator could have caused or avoided: bad signatures, wrong order, a message that doesn't bind the rounds before it) and which only disqualify a seat (a failed proof, a bad challenge, a wrong or missing answer, a duplicate key).
- **The qualified set has at least `k` seats.** That is the protocol's floor. [[0006-trustees]] rule 7, adopted by the owner on 2026-10-12, requires `max(k, n − 1)` on top of it: an honest seat approves no transcript with fewer, [[verifier]] 3.2 fails one (`ceremony-participation`), and every deployment's registry quorum is `q = max(k, n − 1)` ([[contracts]], Trustee registry). When `k ≤ n − 2`, a ceremony in which `n − k` seats were absent or disqualified, which would leave a tally no failure margin (T-54), therefore never opens an election. When `k ≥ n − 1` rule 7 doesn't protect the margin: with `k = n − 1` a coordinator that withholds one seat leaves exactly `k` qualified seats, which pass, and with `k = n` the full ceremony has no margin. The decided 4-of-7 panel is in the first case.
- **A seat that isn't qualified gets no shares.** How a ballot treats a seat outside the qualified set (a ciphertext slot it leaves out) is the ballot record's (P1-12 part 3). Shares are still made over all `n` seats, so an unqualified seat costs the tally one of its `n − k` spare seats, as an offline trustee does.
- A coordinator (in practice the creator's node) relays messages and assembles the transcript. It can withhold a seat's message, which disqualifies that seat, and it can show a seat the other messages of a round before that seat sends its own, or show different seats different messages of a seat that signed two in one round (a seat shown a view the transcript doesn't hold is left out, as if withheld), which the soundness argument allows for; it can't forge, reorder or add a message once a later round began, since every message signs the hash of the rounds before it. Withholding is visible only to the seat withheld; that seat's node refuses to sign the ceremony registration, and so does every honest seat that saw the message ([[trustee-identity]], Ceremony registration).
- Every seat's node keeps its challenge secrets `μ` only until it reveals them, and never reuses keys or `μ` across runs; a re-run uses a fresh `run_id`, and nodes refuse one they have seen.
- Ranked choice, if its follow-up ADR needs a threshold key, adds its DKG rounds to the same transcript under a new record version ([[0003-tally-scheme]]).

## Decision

Under rule A (`AGENTS.md`): option A, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].
