# Key ceremony

How a panel's trustees register their per-election keys for one election: the ceremony context, the four rounds, the ceremony transcript (record type `0x0005`, version 1), its hash, and the transcript check of [[verifier]] 3.1 and 3.2, which yields the qualified seats and their registered keys. The protocol is option A of [[0018-ceremony-possession]], under [[0002-everlasting-privacy]] (option B: key registration instead of a DKG). Notation is from [[notation]], the group and hashes from [[group]], identity keys and signatures from [[trustee-identity]], and the KEM key from [[share-encryption]]. Threats: T-37, T-40, T-14, T-54, T-29, T-31, T-39.

What this page doesn't cover:

- **Approving the transcript.** Each seat that accepts the outcome signs the ceremony registration ([[trustee-identity]], Ceremony registration) over the transcript hash below; the trustee registry records the transcript once the panel's quorum of seats has signed ([[contracts]], Trustee registry).
- **Using the keys.** Shares are encrypted only to the registered KEM keys of qualified seats; a ballot leaves out a seat that isn't qualified with a zero share hash, and needs no delivery to it ([[delivery]], Delivery check). Statements signed with the registered per-election keys (share receipts and complaints, tally openings and summed-share messages, the destruction statement) are specified with their items ([[delivery]]; [[tally]]).
- **A ranked-choice mix key.** If the follow-up ADR of [[0003-tally-scheme]] needs one, its DKG is a new record version.

## Sources

- **Proof of knowledge of the DH key:** Schnorr's identification protocol (C. P. Schnorr, "Efficient Signature Generation by Smart Cards", J. Cryptology 1991) under Fiat–Shamir, in compact form `(c, z)`, with the whole statement hashed ([[domain-separation]]).
- **Possession of the ML-KEM key:** challenge and response with ML-KEM-768's own encapsulation (NIST FIPS 203, `ML-KEM.Encaps_internal` and `ML-KEM.Decaps_internal`), the challenge's message revealed only after every answer is fixed ([[0018-ceremony-possession]]).
- **Signatures:** ECDSA P-256 as [[trustee-identity]] specifies, for the identity key and for the per-election signing key.

## Parties and keys

The panel is the one the verifier's release pins ([[trustee-identity]], Panel identifier): `k`, `n` and the identity keys `Q_1 … Q_n`; in an author panel's run, the author panel the definition names (Author panel, below). Each seat `i` that takes part generates, fresh for this election and this run, from the CSPRNG:

- a KEM key pair (`kem_key_i`, `kem_secret_i`) ([[share-encryption]], Trustee KEM key);
- a per-election signing key `P_i = d_i · G` on P-256, `d_i` uniform on 1 to `n_P256 − 1` ([[trustee-identity]], Which key signs what).

A **coordinator** (in practice the creator's node) relays messages and assembles the transcript. It is trusted for nothing but liveness: it can withhold a message, and nothing else (Security notes).

An honest coordinator relays a seat's message for a round only if, with the rounds it has already closed, that message alone in its round passes the transcript check's structure (checks 1 to 3: order, shape and every signature over the round chain), and only the first such message per seat and round. Seats don't authenticate to the coordinator otherwise, so without the signature check anyone could take a seat's place in a round, and without the shape check one seat's malformed message could make the whole transcript fail check 2. Messages that pass one at a time pass together, since each seat sends one per round and both the shape and each signature depend only on the closed rounds. A coordinator that skips this only stalls the run, as withholding does (T-54).

## Ceremony context

The creator fixes every field of the definition except `ceremony_transcript_hash` first ([[election-definition]], Stub hash and the ceremony), and picks `run_id`, 32 bytes from the CSPRNG, fresh for every run of the ceremony. Every message and proof of the run binds

```
ceremony_context = H(DS("abolish/v1/ceremony-context",
    u64(l2_chain_id) ‖ trustee_registry ‖ election_id ‖ stub_hash ‖ panel_id ‖ run_id))
```

| Field              | Type        | Source                                                                                                                                                                                                                              |
| ------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `l2_chain_id`      | `u64`       | The definition's L2 chain ID                                                                                                                                                                                                        |
| `trustee_registry` | `bytes[20]` | The definition's `trustee_registry`                                                                                                                                                                                                 |
| `election_id`      | `bytes[32]` | The definition's `election_id`                                                                                                                                                                                                      |
| `stub_hash`        | `bytes[32]` | `H(DS("abolish/v1/election-stub", stub))` of the definition ([[election-definition]]); for a version-6 author panel's ceremony, `author_stub_hash`                                                                                  |
| `panel_id`         | `bytes[32]` | Recomputed from the pinned panel, never taken from data; for a version-6 author panel's ceremony, `author_panel_id` recomputed from the stub's `author_threshold` and `author_keys` ([[trustee-identity]], Author panel identifier) |
| `run_id`           | `bytes[32]` | The run identifier, from the transcript                                                                                                                                                                                             |

A verifier rebuilds the context from the definition it is verifying, the panel its release pins and the transcript's `run_id` ([[verifier]] 3.1), so a transcript made for one election, definition, registry, panel or run never checks for another (T-37, T-34). A trustee node refuses to take part in a run whose (`stub_hash`, `run_id`) it has seen before, and never reuses a key, a nonce or a challenge message across runs: an aborted run's messages then never check in the next (the run identifier of [[domain-separation]], Fiat–Shamir).

## Rounds

The ceremony has four rounds. In each round every taking-part seat sends at most one message, which carries its seat `index` and an identity signature. The rounds are chained: with `R_r` the list of round `r`'s messages as the transcript encodes it (below, Transcript),

```
h_0 = ceremony_context
h_r = H(DS("abolish/v1/ceremony-round", h_{r−1} ‖ u8(r) ‖ encode(R_r)))     for r = 1, 2, 3
```

and each message of round `r` is signed over `h_{r−1}`. So a message of round `r` commits to every message of the rounds before it, as the transcript lists them: no one can add, drop or change a message of an earlier round once a later round has begun, and every seat that signed in round `r` saw the same earlier rounds.

**Signed message.** Seat `i`'s round-`r` message is signed with its pinned identity key `Q_i` under `abolish/v1/sig/ceremony-message` ([[trustee-identity]], Signatures) over

```
m = u8(r) ‖ h_{r−1} ‖ u8(i) ‖ body
```

where `body` is the encoding of the message's fields between `index` and `signature`, in the order the tables below list them. Its length follows from the round and the number of seats taking part.

Below, `S_1` is the set of seats with a round-1 message and `S_2` those with a round-2 message, each in increasing seat order.

### Round 1: keys

Seat `i` sends:

| Field         | Type       | Meaning                                                 |
| ------------- | ---------- | ------------------------------------------------------- |
| `index`       | `u8`       | `i`                                                     |
| `kem_key`     | `kem_key`  | Its per-election KEM key ([[share-encryption]])         |
| `signing_key` | `p256-key` | `P_i`, its per-election signing key                     |
| `pok_c`       | `scalar`   | Proof of knowledge of `x_i` (`dh = g^{x_i}`): challenge |
| `pok_z`       | `scalar`   | Proof of knowledge of `x_i`: response                   |
| `signing_pop` | `p256-sig` | `P_i`'s signature on the entry (below)                  |
| `signature`   | `p256-sig` | `Q_i`'s signature on the round-1 message                |

**Proof of knowledge of `x_i`** (Schnorr, compact form). The prover draws `w` uniform on 1 to `ℓ − 1` from the CSPRNG and computes `A = g^w`, `c = HashToScalar(t, DST = "abolish/v1/fs/ceremony/possession")` and `z = w + c · x_i mod ℓ`, with

| `t`, in order      | Type        | Why                                                                              |
| ------------------ | ----------- | -------------------------------------------------------------------------------- |
| `ceremony_context` | `bytes[32]` | Binds the election, definition stub, registry, panel and run (T-37)              |
| `index`            | `u8`        | The seat: another seat can't present the proof as its own, so it can't copy `dh` |
| `kem_key`          | `kem_key`   | The whole key: `ek` and `dh` are registered together                             |
| `signing_key`      | `p256-key`  | The entry's signing key                                                          |
| `A`                | `element`   | The prover commitment, encoded with the identity allowed                         |

A verifier recomputes `A = g^z · dh^{−c}` (which may be the identity) and accepts if and only if `c` equals the challenge over `t` with that `A`.

**Signing key's proof of possession.** `signing_pop` is `P_i`'s signature under `abolish/v1/sig/ceremony-signing-key` over

```
ceremony_context ‖ u8(i) ‖ encode(kem_key) ‖ signing_key
```

(1,282 bytes), so a seat can't register another seat's signing key (its signature would have to name the other's key and this seat).

### Round 2: challenges

After round 1 closes, each seat `j` in `S_1` draws, for every other seat `i` in `S_1` in increasing order, 32 bytes `μ_{j→i}` from the CSPRNG, and computes

```
m_{j→i}            = H(DS("abolish/v1/ceremony-challenge", ceremony_context ‖ u8(j) ‖ u8(i) ‖ μ_{j→i}))
(ss_{j→i}, ct_{j→i}) = ML-KEM-768.Encaps_internal(ek_i, m_{j→i})
```

with `ek_i` from seat `i`'s round-1 message. The hash binds the challenge to its run, its challenger and its target: a ciphertext re-encapsulates as `j`'s challenge to `i` only from a `μ` that `j` drew for that pair, so no seat can pass off another seat's challenge as its own (Soundness, below). It sends:

| Field        | Type                                  | Meaning                                                               |
| ------------ | ------------------------------------- | --------------------------------------------------------------------- |
| `index`      | `u8`                                  | `j`                                                                   |
| `challenges` | `list<bytes[1088], MAX_TRUSTEES − 1>` | `ct_{j→i}` for every `i` in `S_1` other than `j`, in increasing order |
| `signature`  | `p256-sig`                            | `Q_j`'s signature over `h_1`                                          |

It keeps every `μ_{j→i}` secret until round 4. A challenge is sent to every seat with a round-1 message, whether or not its proofs check: the rule is the same for everyone, and challenging costs nothing.

### Round 3: answers

After round 2 closes, each seat `i` in `S_1` decapsulates every challenge addressed to it, `ss'_{j→i} = ML-KEM-768.Decaps_internal(dk_i, ct_{j→i})`, with `dk_i` from its `seed`, and computes its answer

```
a_{j→i} = H(DS("abolish/v1/ceremony-answer", ceremony_context ‖ u8(j) ‖ u8(i) ‖ ss'_{j→i}))
```

It sends:

| Field       | Type                                | Meaning                                                              |
| ----------- | ----------------------------------- | -------------------------------------------------------------------- |
| `index`     | `u8`                                | `i`                                                                  |
| `answers`   | `list<bytes[32], MAX_TRUSTEES − 1>` | `a_{j→i}` for every `j` in `S_2` other than `i`, in increasing order |
| `signature` | `p256-sig`                          | `Q_i`'s signature over `h_2`                                         |

Each answer is bound to its pair, so what seat `i` publishes counts only as `i`'s own answer to `j`. A seat can sign two different messages in one round, and a coordinator can show different seats different ones; whichever ciphertext a seat was shown, nothing it publishes answers a challenge to another seat (Soundness). Raw decapsulations are never published.

### Round 4: reveals

After round 3 closes, each seat `j` in `S_2` sends:

| Field       | Type                                | Meaning                                                              |
| ----------- | ----------------------------------- | -------------------------------------------------------------------- |
| `index`     | `u8`                                | `j`                                                                  |
| `reveals`   | `list<bytes[32], MAX_TRUSTEES − 1>` | `μ_{j→i}` for every `i` in `S_1` other than `j`, in increasing order |
| `signature` | `p256-sig`                          | `Q_j`'s signature over `h_3`                                         |

Signing over `h_3` fixes every answer before any `μ` is public, so no seat can compute an answer from a revealed `μ` instead of decapsulating. An honest seat sends its reveals only once it holds round 3 as the coordinator closed it, and only if they re-encapsulate to the challenges round 2 holds for it (a restarted node could otherwise reveal secrets of a round 2 it didn't send, and be disqualified); it refuses to sign the ceremony registration for a transcript whose round 3 differs.

## Transcript

The transcript is record type `0x0005`, version 1:

| Field        | Type                                  | Meaning                         |
| ------------ | ------------------------------------- | ------------------------------- |
| `run_id`     | `bytes[32]`                           | The run identifier              |
| `keys`       | `list<round-1 message, MAX_TRUSTEES>` | `R_1`, in increasing seat order |
| `challenges` | `list<round-2 message, MAX_TRUSTEES>` | `R_2`, in increasing seat order |
| `answers`    | `list<round-3 message, MAX_TRUSTEES>` | `R_3`, in increasing seat order |
| `reveals`    | `list<round-4 message, MAX_TRUSTEES>` | `R_4`, in increasing seat order |

Each message is its table's fields in order, `index` first and `signature` last. `encode(R_r)` in the round chain is the encoding of that list field, count included. At `n = 16` the transcript is about 303 KB, 261 KB of it the 240 ML-KEM ciphertexts.

```
ceremony_transcript_hash = H(DS("abolish/v1/ceremony-transcript", encode(transcript)))
```

over the record's full encoding, header included. It is the value the definition carries as `ceremony_transcript_hash` and that each seat's ceremony registration approves.

## Transcript check

[[verifier]] 3.1 and 3.2. The verifier decodes the transcript under the version the election's profile pins (`profile-mismatch` otherwise, [[versioning]]), rebuilds `ceremony_context` (above) and then checks, in order. The first four checks make the whole transcript invalid, and with it the election: each is something an honest coordinator never produces, and none can be attributed to a single seat.

1. **Order** (`ceremony-order`). In each round, seats are strictly increasing and from 1 to `n`. A round-2 or round-3 message comes from a seat in `S_1`; a round-4 message from a seat in `S_2`.
2. **Shape** (`ceremony-shape`). Seat `j`'s `challenges` and `reveals` have one element for each seat in `S_1` other than `j`; seat `i`'s `answers` has one for each seat in `S_2` other than `i`.
3. **Signatures** (`ceremony-signature`). Every message's `signature` verifies under its seat's pinned identity key over `m` above, with `h_{r−1}` computed from this transcript. A signature that fails can't be attributed to anyone, so it isn't a seat's failure.
4. **Seats.** Each seat is qualified or not, by the rules below, computed by the verifier from the transcript alone.
5. **Quorum** (`ceremony-quorum`). At least `k` seats are qualified ([[verifier]] 3.2). With fewer the panel can't open any ballot, so no definition can use the transcript.

A seat `i` is **qualified** if and only if none of these holds. Each is a reason, reported in this order, and a seat may have several. Every one is attributed to seat `i`, because each rests only on messages `Q_i` signed, or on its absence where the rules required a message.

| Reason          | Holds when                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `absent`        | `i` has no round-1 message                                                                                                                                                                                                          |
| `possession`    | Its proof of knowledge of `x_i` fails, or `signing_pop` doesn't verify under `signing_key`                                                                                                                                          |
| `duplicate-key` | It passes `possession` and its `dh` equals another passing seat's, or its `signing_key` equals another passing seat's or any seat's pinned identity key                                                                             |
| `no-challenges` | It is in `S_1` and has no round-2 message                                                                                                                                                                                           |
| `no-answers`    | It is in `S_1` and has no round-3 message                                                                                                                                                                                           |
| `no-reveals`    | It is in `S_2` and has no round-4 message                                                                                                                                                                                           |
| `bad-challenge` | It has a round-4 message and, for some seat `t`, `ML-KEM-768.Encaps_internal(ek_t, m_{i→t})`, with `m_{i→t}` from its revealed `μ_{i→t}`, gives a ciphertext other than `ct_{i→t}`                                                  |
| `wrong-answer`  | It has a round-3 message and, for some seat `j` with a round-4 message whose challenge to `i` is valid (re-encapsulates to `ct_{j→i}`), its answer to `j` differs from `a_{j→i}` over the shared secret that re-encapsulation gives |

Why each rule:

- **`duplicate-key`** applies only among seats whose proofs pass. Both proofs bind the seat, so a seat that copies another's `dh` or `P` can't make them pass: a duplicate among passing seats means both seats hold the secret, and both are excluded, as the panel rule excludes a repeated identity key (T-14). A seat whose signing key is an identity key would fold the two roles that [[trustee-identity]] keeps apart. There is no rule for `ek`: a seat that copies another's `ek` can't answer its challenges (Soundness), while a rule would let it exclude the honest seat it copied.
- **`bad-challenge`** is the challenger's: its reveal doesn't encapsulate to what it sent. ML-KEM's ciphertext determines its message `m` (up to a decryption failure, probability below 2⁻¹⁶⁴), and `m` determines `μ` up to a SHA-256 collision, so a challenger can't reveal a second `μ` for one ciphertext. A bad challenge never counts against its target.
- **`wrong-answer`** is the target's: the challenge was a real encapsulation under its registered `ek`, and it didn't produce the answer over its shared secret. A challenge from a seat that sent no reveals can't be checked and counts against no one but its sender (`no-reveals`).

**Soundness.** To qualify, seat `i` must have published, in round 3, `a_{j→i}` for every challenge from every other qualified seat `j`, before `j` revealed `μ_{j→i}` in round 4 (whose messages sign over round 3). Computing it needs `ss_{j→i}`, which only the holder of `dk_i` can get from `ct_{j→i}` (ML-KEM-768 is IND-CCA2), or `μ_{j→i}`, which an honest `j` keeps until round 4 and reveals once: a node MUST sign at most one round-4 message per run, recorded before it is sent, and never reveal again over another round 3 (otherwise a coordinator could collect its reveals and then ask again over a round 3 rebuilt from them). An honest holder `o` publishes only answers bound to itself as target, `a_{·→o}`, never a raw shared secret and never a value bound to target `i`, so nothing it publishes answers a challenge to `i`. That holds whatever `o` was shown: rushing within a round, a seat that signs two different messages in one round, and a coordinator that shows seats different views change nothing (a view the transcript doesn't hold only leaves its seat out, as withholding does). So if `i` is qualified and was challenged by an honest qualified seat, `i` holds `dk_i`, or shares it with a corrupt seat, which gives the corrupt seats nothing they don't already hold (T-14). With at least `k` qualified seats and fewer than `k` corrupt, every corrupt qualified seat has an honest qualified challenger. A shared `ek` among corrupt seats is therefore harmless and has no rule; a shared `dh` or signing key is excluded (`duplicate-key`) because there the rule costs no honest seat anything, which a rule on `ek` would (Why each rule).

The challenge hash `m` adds attribution: a seat that relays another pair's ciphertext as its own challenge, to have the holder decapsulate it, fails its reveal (`bad-challenge`). An in-session review found that relay against a draft that hashed neither the challenge nor the answer, and CI review found the variant in which the relaying round 2 is shown only to the holder, against a draft that hashed only the challenge (vectors `relay-2`, `relay-sacrificed`, `relay-view-split`).

The check's output is the **registered key set**: for each qualified seat in increasing order, its `index`, `kem_key` and `signing_key`. [[verifier]] 3.1 compares it with what the definition and L2 bind; [[verifier]] 2.5 and the ballot client's panel check use it before any share is made ([[election-definition]], The panel is checked before any share exists).

### Key set hash

The registered key set is bound on L2 by its hash, which every seat signs in its ceremony registration ([[trustee-identity]], Ceremony registration; [[0028-board-contract-checks]], 2B):

```
kem_key_hash = H(DS("abolish/v1/kem-key", encode(kem_key)))
key_set_hash = H(DS("abolish/v1/key-set", encode(key_set)))
```

| Field     | Type                                | Meaning                                                |
| --------- | ----------------------------------- | ------------------------------------------------------ |
| `key_set` | `list<key_set_entry, MAX_TRUSTEES>` | One entry per qualified seat, in increasing seat order |

| `key_set_entry` field | Type        | Meaning                                                         |
| --------------------- | ----------- | --------------------------------------------------------------- |
| `index`               | `u8`        | The seat                                                        |
| `kem_key_hash`        | `bytes[32]` | `kem_key_hash` of its `kem_key`, over the 1,216 bytes `ek ‖ dh` |
| `signing_key`         | `p256-key`  | Its per-election signing key `P_i`                              |

An entry is 66 bytes, and the hashed input `4 + 66 · c` bytes for `c` qualified seats. A valid transcript has at least `k` qualified seats (Transcript check, 5), `k ≥ 2` for a pinned panel and `k_A ≥ 1` for an author panel (Author panel), so a key set is never empty, and its seats are distinct and increasing because the check returns them so.

**Why each KEM key is hashed on its own.** The trustee registry recomputes `key_set_hash` from what a registration carries ([[contracts]], Trustee registry), and the board needs only the seats and their signing keys. Carrying each seat's 32-byte `kem_key_hash` instead of its 1,216-byte key keeps a registration of all 16 seats, approvals included, near 2.7 KB rather than 22 KB, in calldata and in the archived event every verifier replays (T-17, T-52), while still binding every KEM key: whoever needs one (the ballot client, a trustee, the verifier) takes it from the transcript the definition binds, and the transcript check's set hashes to the registered one exactly when its keys are the registered keys (SHA-256's collision resistance).

## Stub checks

The stub's contents reach the permanent archive once the definition is registered, so a trustee node checks them before it lends its keys to the election. Before it sends its round-1 message, and again before it signs the ceremony registration, a node MUST:

1. decode the stub as an election definition under the node's own pinned profile ([[election-definition]], Decoding), with `ceremony_transcript_hash` zero (and, for a version-6 author panel's ceremony, `author_transcript_hash` zero too, [[election-definition]], Stub hash and the ceremony), and recompute `stub_hash` (or `author_stub_hash`) from it, never taking it from the coordinator;
2. check that the stub names the panel its release pins (`panel_id`, `threshold`, `panel_size`), the chain its deployment pins, and the `trustee_registry` it registers with;
3. run [[verifier]] 1.3, 2.3 and 2.4 on the stub, against its own pins and finalized L2 state at each tier's `root_l2_block`: the verification-key hash equals the pinned one, every pinned version is supported and not retired, and every tier's `root`, `group_id` and `group_size` (under definition version 3 and later, its regions and cells) match the tier tree it rebuilds from that tier's additions ([[verifier]], Electorate), with a tier it can't recount (Tier 1, Tier 2, a rolling electorate) refused;
4. check that the election fits the forced path together with every election its seat has approved a transcript for whose forced-path intervals can overlap it ([[delivery]], Capacity), with the member counts step 3 checked and every seat of the stub's panels, a rolling stub counted with the root figure, since it commits roots whatever its size ([[delivery]], Elections that commit roots), and so refused while every election that commits roots is;
5. for a default seat's run on a stub with an author panel, check the author panel's ceremony (Author panel): decode the author transcript as version 1 and check that it hashes to the stub's `author_transcript_hash`, rebuild the author run's context from the stub (`author_stub_hash` recomputed from it as in step 1, `author_panel_id` from its `author_threshold` and `author_keys`), run the transcript check over it and require at least `max(k_A, n_A − 1)` qualified seats, and check that the author approvals records it was given approve the transcript (Author panel, Check). It also runs [[verifier]] 2.5's `panel-kind` and `default-seat` against its own pins (step 3 runs only 1.3, 2.3 and 2.4), so it never lends its keys to a poll whose author keys include a default seat's, or whose class its panel's kind doesn't allow (T-14).

An author seat runs these checks on the author stub, except that step 2 checks that the stub names the seat's own identity key at its own index of `author_keys`, and a default panel its release pins, rather than its own panel as the default one; it runs 2.5's `panel-kind` and `default-seat` as step 5 says; and step 5's author-ceremony check doesn't apply. So an author seat never lends its key to a stub that lists it at another seat or beside a default panel no release pins. It can't notice a stub that leaves it out: a creator who substitutes an author key simply never asks that seat, and only the author comparing the key fingerprints the creation flow and the evidence view show finds it ([[0027-trustee-panels-and-live-results]], Key substitution; T-37).

A node refuses a run whose stub fails any of these, or that it can't run, and never signs a registration for it. Step 4 keeps a seat from lending its keys to an election whose contract-path receipts and complaints it couldn't force through L1 in time ([[delivery]], What a node owes; T-25, T-52, T-54); the trustee node runs it, recording each election it approves with what the check reads before it signs, and approving one stub at a time, so no two approvals each pass against a record the other is about to add; it stops counting an approved election only once finalized L2 shows it can never be registered ([[delivery]], Capacity). Steps 1 to 3 check the fields only the verifier would otherwise compare with the chain and the pins, so a creator can't use the stub to put chosen bytes, a person's name or number say, into the archive with the trustees' help (T-17, G-12). They don't bound what a panel's own transcript carries: a colluding panel can fill its seats' ML-KEM keys and revealed challenges, which an author panel, chosen by the creator, makes the creator's channel (Author panel, Residuals). The trustee node runs step 3's 2.4 over the group registry's log its own L2 node shows in finalized history, from the registry's deployment block, under the registry and registrars its configuration pins from the release, and only once that whole log, every event of the registry up to a block at or after the stub's latest `root_l2_block`, replays to the registry's accumulator proven under an output root a game of the type the L2's portal respects claims on its own L1 node (the highest claimed block its L2 node proves) ([[contracts]], Event accumulator, Output root). So the L2 node is trusted for nothing but availability; the root is trusted as [[verifier]] 4.4 trusts it ([[verifier]], Electorate, Residuals; T-71).

## Approval and re-runs

A seat signs the ceremony registration ([[trustee-identity]], Ceremony registration) only for a stub that passes the stub checks (above) and a transcript that passes this check with at least `max(k, n − 1)` qualified seats ([[0006-trustees]] rule 7, adopted by the owner on 2026-10-12; [[verifier]] 3.2 fails any other with `ceremony-participation`), that holds every message it sent as it sent it, and whose round chain it signed over. It signs with `key_set_hash` computed from the registered key set its own transcript check returned, never one taken from the coordinator or another seat, so the quorum that approves a transcript also approves exactly the keys it registers ([[trustee-identity]], Ceremony registration; T-37, T-14). It approves **at most one transcript per `stub_hash`**, whatever the run, and its node keeps that record for as long as the stub can be registered.

A run that stops before a quorum approves it is abandoned: the creator starts another with a fresh `run_id` and the same stub, and every seat generates fresh keys. A run whose transcript a quorum has approved is final for that stub. With a quorum `q > n / 2` ([[contracts]], Trustee registry) two quorums share a seat, so a second approved transcript for one stub needs a seat that broke the rule above; [[verifier]] 3.1 still accepts only the transcript the definition binds. The trustee registry records at most one transcript per `stub_hash` and panel and refuses any other once one has its quorum ([[contracts]], Trustee registry), so a quorum can't hold a second set of keys in reserve for the same definition. Only the panel can register a transcript, so this first-come rule can't be raced by anyone outside it ([[election-definition]], Stub hash and the ceremony).

## Author panel

Under definition versions 6 and 7 a poll with an author panel ([[election-definition]], Author panel) has two ceremonies, the author panel's first, each on its own stub ([[election-definition]], Stub hash and the ceremony; [[0027-trustee-panels-and-live-results]], How the ceremonies compose). The author panel's run is the ceremony above with the substitutions below, and nothing else changes: its rounds, messages, transcript (record type `0x0005`, version 1, which the profile pins for both runs), transcript check, registered key set and key set hash are the ones this page specifies. Threats: T-37, T-14, T-54, T-17.

**The panel.** `k_A` is the definition's `author_threshold`, `n_A` the length of its `author_keys`, and seat `i`'s identity key the `i`-th of `author_keys`, read from the stub, never from a release's pins or the coordinator. Wherever this page says a seat's pinned identity key, the author run reads that key. The context binds `author_panel_id`, recomputed from those two fields, and `author_stub_hash` (Ceremony context), so no message or proof of one panel's run checks in the other's, or in another election's.

**`duplicate-key` across panels.** In either run of an election with an author panel, the rule's identity keys are both panels', not only the run's own: the author keys the stub lists and the default panel's keys from the pins its `panel_id` names. So a seat's `signing_key` equal to any identity key of either panel disqualifies it, as one equal to its own panel's does. A default seat's run can also read the author panel's registered key set (Stub checks, step 5), but no rule compares the two sets: a seat that registers another panel's `dh` or signing key can't prove possession of it unless it holds the secret, and the same party holding a seat in each panel is the `default-seat` question, which only distinct identity keys can settle ([[trustee-identity]], Author panel identifier, rule 4).

**Quorum and participation.** The transcript check's quorum (5, `ceremony-quorum`) is `k_A`, and the participation rule of Approval and re-runs is `max(k_A, n_A − 1)` qualified seats, as [[0027-trustee-panels-and-live-results]] (Verifier checks, 3.1 and 3.2 per panel) applies [[0006-trustees]] rule 7 to the author panel too, so an outage or a withheld message at the author run can't silently shrink the panel that must be live at the tally (T-54). `k_A = 1` is allowed ([[trustee-identity]], Author panel identifier, rule 2), and then Soundness's argument doesn't cover a lone seat: with `n_A = 1`, or when every challenger of a seat is corrupt, nothing shows the seat holds the `dk` of the `ek` it registered, so its trustee could register a key someone else holds. That gives no one more than the trustee could hand over anyway, and the author half alone opens no ballot (T-14).

**Approval.** An author seat signs the ceremony registration ([[trustee-identity]], Ceremony registration) under the rules of Approval and re-runs: with `panel_id` the author panel's identifier, `stub_hash` the `author_stub_hash` it recomputed itself, `ceremony_transcript_hash` the author transcript's hash, `key_set_hash` from its own transcript check, and the stub's `l2_chain_id` and `trustee_registry`; and at most once per `author_stub_hash`, whatever the run. The trustee registry doesn't record it, since it holds only panels its deployment pins ([[contracts]], Trustee registry): the election registry checks `q_A` of them and records the key set they sign in the transaction that registers the definition ([[contracts]], Election registry, Author panel registration; [[0035-author-key-set-on-l2]]). Before that the approvals travel in the author approvals record (below), and each checker counts them itself. The author panel's **approval quorum** is `q_A = max(k_A, n_A − 1)` distinct seats, the rule every trustee registry deployment applies to its own panels (which never have `k = 1`). For `n_A ≥ 3` it is more than half the seats, so two approved author transcripts for one author stub need a seat that approved twice, as Approval and re-runs argues; with `n_A ≤ 2` it isn't (one seat of two can approve alone), so two transcripts can each be approved. That gives no one a choice after the fact: the default panel's stub fixes `author_transcript_hash` before its run, and its registration binds the one it names (Stub hash and the ceremony).

### Author approvals record

The **author approvals** record, record type `0x0019`, version 1 ([[versioning]]), carries an author panel's approvals of its transcript:

| Field             | Type                                  | Meaning                                                                   |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `transcript_hash` | `bytes[32]`                           | The approved transcript's hash: the definition's `author_transcript_hash` |
| `approvals`       | `list<author approval, MAX_TRUSTEES>` | One entry per approving seat, in strictly increasing seat order           |

| `author approval` field | Type       | Meaning                                                                                                |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `index`                 | `u8`       | The seat, `1 ≤ index ≤ n_A`                                                                            |
| `signature`             | `p256-sig` | Its ceremony registration's signature over the 157-byte statement above, under the seat's identity key |

The record is `39 + 65·c` bytes for `c` approvals. Each statement's other fields aren't carried: every checker rebuilds them from the definition (or stub) and its own transcript check, so a record can't name a key set, stub or panel of its own, and decoding needs no context. The board carries the record under board-entry version 7 ([[board]], Allowed payloads), beside the author transcript itself. No profile pins its version: the board-entry version that allows it fixes it, as for the close statement, and version 7 fixes version 1, so a record of any other version on such a board is a rejected entry (`profile-mismatch`) the operator must never board ([[versioning]], Three levels).

**Check.** Given the stub (or the registered definition), and the author transcript that hashes to its `author_transcript_hash` and passes the transcript check with at least `max(k_A, n_A − 1)` qualified seats, a set of author approvals records **approves** the transcript when, counting every record that decodes strictly and names that `transcript_hash`, at least `q_A` distinct seats have an approval whose `signature` verifies under that seat's key in `author_keys` over the statement rebuilt as above, with the `key_set_hash` of the checker's own transcript check. A seat counts once, however many valid signatures it has (ECDSA lets it make any number); an approval whose signature fails counts for no one, and neither does any approval of a record whose seats aren't strictly increasing and within `1` to `n_A`. So an approval can't be replayed for another seat, panel, stub, transcript or key set (T-37), and the coordinator, the operator or the author can't make it say anything else.

**The registration's approvals.** Once the definition is registered, the election registry's `AuthorPanelRegistered` carries the approvals it counted, in its `registration`, the trustee registry's record layout, and the registry records the key set they sign, whose `key_set_hash` `authorKeySetOf` returns ([[contracts]], Election registry, Author panel registration; contract-event version 9, [[P2-16]] part 5d-3a). A checker that reads the election's events counts the registrations' approvals with the records, and one that has the **recorded key set hash**, authenticated by reading `authorKeySetOf` on L2 or by recomputing it from an event the accumulator replay proves ([[contracts]], Event accumulator), checks the key set against it:

1. **The recorded key set.** If the checker has the recorded key set hash and it isn't the one its own transcript check gives (Key set hash), the check fails with `key-set-mismatch`, whatever approves: the board takes the author seats' signing keys and qualified seats from that recorded set ([[contracts]], Board, Delivery records (version 2)), so a recorded set that isn't the transcript's fails the election rather than passing, as the default panel's does in [[verifier]] 3.1 (T-37, T-14). It is judged by the hash alone, never by whether the checker can verify the approvals the registry counted for it: a recorded set the registry should have refused (a bug, or a verifier and the registry disagreeing about a signature) fails closed. The recorded hash carries no approval of its own.
2. **Registrations found on a copy.** The `registration` of every `AuthorPanelRegistered` whose `definitionHash` is the registered definition's hash, wherever the checker finds it, is never known to be the recorded one, so it can only add approvals: it counts only if it decodes strictly as the trustee registry's record ([[contracts]], Trustee registry, Registration: the layout, at least one seat, seats and approvals strictly increasing from `1`, the last seat at most `n_A`, each signing key a point of P-256 with `x, y < p`, each signature with `1 ≤ r < n` and `1 ≤ s ≤ (n − 1) / 2`), its `panel_id`, `stub_hash` and `ceremony_transcript_hash` are `author_panel_id`, `author_stub_hash` and `author_transcript_hash`, its key set's hash is the checker's own, and at least `q_A` distinct seats have an approval in it that verifies, as in the check above, which is what the registry requires before it emits one (its checks 2 to 9). Any other registration counts for no one and names nothing: one over another key set, which `q_A` author seats, all the author's choice, can sign at any time, changes no key the board or any client used, and bytes anyone can frame as an event and place on a copy never fail the check (T-53).
3. A registration that counts names the transcript, and each of its approvals is counted as an approval of a record naming the transcript, under the same rules: each seat once across every record and registration, and an approval whose signature fails for no one. Such a registration alone approves the transcript.

The check's outcomes are then, in order: `ceremony-participation`, `key-set-mismatch`, approved, `author-approvals` (something names the transcript), `author-approvals-missing`. `docs/spec/vectors/author-registration.json` gives registrations, their events under version 9 and cases over records and registrations together, from an independent implementation.

**Who checks it.** The author panel's on-chain registration exists only once the definition is registered, and checks no transcript, so this check is run by everyone who would otherwise trust a registry:

1. **Every default seat, before its round-1 message** in the default panel's run, and again before it signs its ceremony registration (Stub checks, step 5), with the author transcript and approvals records taken from the coordinator: the board has no entries before the definition is registered. So the default quorum's registration, which binds `author_transcript_hash` through `stub_hash`, exists only for an author transcript a quorum of the author panel approved, and no definition naming author keys nobody holds, or an author transcript its panel never approved, can be registered by an honest default quorum (T-17, T-37).
2. **Every seat of either panel, before intake** ([[share-encryption]], Ballot version 4), and **the ballot client, before making any share** ([[ballot-validity]], Casting (version 4)), from the board: the author transcript found by its hash, as [[verifier]] (Key ceremony, step 3) finds the default panel's, and the approvals records on the board, with the election registry's registrations (The registration's approvals, above) where it reads the election's events. Either refuses the election until the transcript is there and the approvals approve it. The author panel's registered key set, the KEM keys every author share is encrypted to and the signing keys every author seat's statement is checked under, is that transcript's, and never comes from any other source (T-37).
3. **The verifier**, in 3.1 and 3.2 for the author panel ([[verifier]], Key ceremony).

**Boarding.** The coordinator gives the author transcript and the approvals records it gave the default seats to the board operator, and every default seat that checked them sends them too, so no single party can keep them from the board. Once the definition is registered, the operator boards the author transcript and one author approvals record, both before `opens_at`. It boards an approvals record only for an election with an author panel, only if the record names the definition's `author_transcript_hash`, its seats are strictly increasing and within `1` to `n_A`, every approval in it counts under the check above and they number at least `q_A`, and no approvals record is on the board yet; it refuses every other. A boarded record then carries no chosen bytes beyond the approving seats' ECDSA nonces, at most 64 bytes per seat ([[notation]], Result-critical fields; T-17). The verifier still reads every approvals record the board holds: one the operator should have refused is reported against the operator, never trusted, and the approvals in it that count under the check still count, since an approval is a seat's signed statement whoever boarded it. If the verifier's copy of the board holds no set that approves the transcript, 3.1 is unverifiable for the author panel (`author-approvals-missing`), as it is when the copy lacks a transcript ([[verifier]], Key ceremony, step 3): that may be the copy's problem, never alone the election's failure (T-53). Records that are there but name the transcript and fail to approve it fail 3.1 (`author-approvals`).

**Residuals.**

- **The author transcript is the author's byte channel (T-17).** The board and the archive carry the author transcript whole, and its contents are the author seats' choice: an ML-KEM `ek` whose `t` is arbitrary coefficients below `q` passes FIPS 203's modulus check (about 1.1 KB per seat), and a challenger's revealed `μ` is 32 free bytes per pair of seats. Possession doesn't bound it when the challengers collude, and the author picks every author trustee, so they can: with `n_A = 1` nobody challenges at all. That is up to about 1.2 KB with one author seat and about 25 KB at 16, of chosen bytes in the permanent archive, signed by the author trustees' identity keys and so attributable to them, which no moderation can remove ([[display-text]] is the channel that can be). The default panel's transcript has the same room, but its seats are pinned trustees bound by [[0006-trustees]]. A seat that fails its own possession checks on purpose is disqualified alone, and rule 7 lets one seat be unqualified, so its round-2 challenges, raw ciphertexts nothing decodes before the reveal, add about 16 KB at 16 seats, for about 43 KB in all; the same unqualified slot can instead carry the unheld key below. Accepted under [[0034-author-transcript-bytes]] (option C): having the default seats challenge each author seat's `ek` would leave a few hundred chosen bytes per seat (a key with secret `s = 0` publishes its noise as `t`) and the unqualified seat's challenges and make every default seat part of the author run's liveness, and keeping the author transcript off the archive with only its key set boarded would cost the verifier's own possession check and the complaints' `dh` for good. The channel is at most one transcript per election, smaller than one ballot's share postings, which a voter can fill anonymously ([[delivery]], Direct submit), and it reaches the archive only when the operator boards it. The channel stays off any contract path: [[P2-16]] part 5 registers only the author panel's key set. Since [[P2-16]] part 5e-5c, [[verifier]] 2.3 lets a sealed definition with an author panel through, and the election registry registers one since part 5e-5d ([[contracts]], Election registry, rule 9).
- **One author key may be held by no one (T-17).** Rule 7 lets one seat be unqualified, so when `n_A − 1 ≥ k_A` a creator can list an author key whose `x` coordinate it chose (about 32 bytes) for a seat that never takes part: the seat is `absent`, the transcript still has `n_A − 1` qualified seats and `q_A` approvals, and step 5 passes. The definition then archives those bytes. At most one such key fits per definition, and [[0034-author-transcript-bytes]] accepts it with the transcript channel above, in place of the unqualified seat's challenges.
- **The operator can keep an author-panel poll from opening.** Clients and seats read the approvals from the board record, and the transcript has no contract path, so an operator that never boards either leaves every client and seat refusing the election (T-25, T-54). The election registry's `AuthorPanelRegistered` carries the same approvals, and since [[P2-16]] part 5d-3a the verifier counts them from it (The registration's approvals), so the approvals no longer depend on the operator's approvals record once clients and seats read that event from L2 too (the ballot client and the trustee node read only the records so far); the verifier still reads the event from the board, where 4.4 requires it, and the transcript still depends on the operator. It can already refuse to board ballots; a voter's direct submission bypasses that, but no one casts without the approvals on the board.
- An author panel's approvals were counted off chain only until [[0035-author-key-set-on-l2]]: the election registry now registers a definition with an author panel only with `q_A` author seats' approvals of its `author_transcript_hash` and the key set they sign (once [[P2-16]] part 5 builds it), so a default quorum that skips step 5 can no longer get such a definition registered. The registry still can't run the transcript check, so a key set `q_A` corrupt author seats sign is recorded until 3.1 fails the election, as for the default panel ([[contracts]], Trustee registry, Known-weak), and every ballot client and seat refuses it first.
- The author panel's possession checks need two seats (Quorum and participation, above).

## Vectors

`docs/spec/vectors/ceremony.json`, from an independent implementation: complete transcripts (honest panels, every disqualification reason, and transcripts that fail each of the four transcript-level codes) with each one's expected result, the registered key set or the reason per seat, and its hash. `docs/spec/vectors/key-set.json` gives KEM-key and key-set hashes, key sets no seat should sign, and ceremony registration statements over key-set hashes ([[contracts]], Trustee registry). `docs/spec/vectors/author-ceremony.json`, from an independent implementation, covers the Author panel section: author runs under the author context, `duplicate-key` across both panels, `k_A = 1`, author approvals records with their check, the operator's boarding rule and decode rejections, and board-entry version 7.

## Security notes

- **Withholding.** The coordinator can drop a seat's message, which makes that seat `absent` or disqualifies it, and nothing in the transcript shows it. The seat's node, and every honest seat that saw the message, refuses to sign the ceremony registration. A coordinator could therefore shrink the qualified set to any `k` seats that will sign; under [[0006-trustees]] rule 7, adopted by the owner on 2026-10-12, a transcript with fewer than `max(k, n − 1)` qualified seats is never approved by an honest seat and fails [[verifier]] 3.2 (`ceremony-participation`), so withholding more than one seat (when `k < n − 1`) stalls the election rather than shrinking its margin. It can also let a seat see the other messages of a round before sending its own, and, when a seat signs two different messages in one round, show different seats different ones; a seat shown a view the transcript doesn't hold is left out, as if withheld (Soundness covers both). An honest node SHOULD keep every message it signed over; if the transcript holds another message signed by the same seat in the same round, it refuses to approve and can publish both, which shows that seat equivocated. It can't add a message to a round once a later round has begun, change one, or qualify a seat that didn't prove possession. The transcript check's own floor stays `k` qualified seats (`ceremony-quorum`); rule 7's `n − 1` is checked on top of it, since a set of only `k` would leave the tally no failure margin (T-54).
- **No joint key.** Plurality and approval have no aggregate key, so there is no rogue-key attack to stop (T-40). The proofs show possession: of `x_i`, so a seat can complain ([[share-encryption]], Complaints) and can't take another's `dh`; of `dk_i`, so shares to it can be opened; of `d_i`, so later statements are its own.
- **Corrupt challengers.** A corrupt seat can give a corrupt target the answers to its own challenges. That proves nothing about the target, but the target must still answer every honest qualified seat's challenge. If all qualified seats but the target are corrupt, the corrupt set already has `k` seats (T-14).
- **Decapsulation is chosen-ciphertext access.** A trustee decapsulates at most `n − 1` ciphertexts that other seats chose, and publishes only hashes of the results, each bound to its pair. ML-KEM-768 is IND-CCA2 ([[share-encryption]], Sources), which covers this.
- **The challenge secrets.** `μ_{j→i}`, `m_{j→i}` and `ss_{j→i}` protect nothing after the ceremony; `ss'_{j→i}` is overwritten once hashed. A node draws them from the CSPRNG and never reuses them: a `μ` known before round 3 closes would let its target answer without `dk`.
- **Per-election keys.** Keys are fresh for each election and each run; a node destroys the KEM secret after the tally and the signing key once it has signed its destruction statement, that key's last use ([[tally]], Destruction). [[0012-trustee-identity-signatures]]'s residuals for the identity key apply: a stolen identity key can register keys of the thief's choosing for every later election.
