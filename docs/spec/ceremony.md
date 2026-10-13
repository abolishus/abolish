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

The panel is the one the verifier's release pins ([[trustee-identity]], Panel identifier): `k`, `n` and the identity keys `Q_1 … Q_n`. Each seat `i` that takes part generates, fresh for this election and this run, from the CSPRNG:

- a KEM key pair (`kem_key_i`, `kem_secret_i`) ([[share-encryption]], Trustee KEM key);
- a per-election signing key `P_i = d_i · G` on P-256, `d_i` uniform on 1 to `n_P256 − 1` ([[trustee-identity]], Which key signs what).

A **coordinator** (in practice the creator's node) relays messages and assembles the transcript. It is trusted for nothing but liveness: it can withhold a message, and nothing else (Security notes).

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

## Stub checks

The stub's contents reach the permanent archive once the definition is registered, so a trustee node checks them before it lends its keys to the election. Before it sends its round-1 message, and again before it signs the ceremony registration, a node MUST:

1. decode the stub as an election definition under the node's own pinned profile ([[election-definition]], Decoding), with `ceremony_transcript_hash` zero (and, for a version-6 author panel's ceremony, `author_transcript_hash` zero too, [[election-definition]], Stub hash and the ceremony), and recompute `stub_hash` (or `author_stub_hash`) from it, never taking it from the coordinator;
2. check that the stub names the panel its release pins (`panel_id`, `threshold`, `panel_size`), the chain its deployment pins, and the `trustee_registry` it registers with;
3. run [[verifier]] 1.3, 2.3 and 2.4 on the stub, against its own pins and finalized L2 state at each tier's `root_l2_block`: the verification-key hash equals the pinned one, every pinned version is supported and not retired, and every tier's `root`, `group_id` and `group_size` match the tier tree it rebuilds from that tier's additions.

A node refuses a run whose stub fails any of these, and never signs a registration for it. These are the fields only the verifier would otherwise compare with the chain and the pins, so a creator can't use them to put chosen bytes, a person's name or number say, into the archive with the trustees' help (T-17, G-12). Until P1-17b specifies `abolish/v1/membership-vk` and the tier tree's Poseidon2 hash, a node can't run the `membership_vk_hash` and `root` parts of these checks, and refuses every stub (no ceremony runs before then); the residual in T-17 says so.

## Approval and re-runs

A seat signs the ceremony registration ([[trustee-identity]], Ceremony registration) only for a stub that passes the stub checks (above) and a transcript that passes this check with at least `max(k, n − 1)` qualified seats ([[0006-trustees]] rule 7, adopted by the owner on 2026-10-12; [[verifier]] 3.2 fails any other with `ceremony-participation`), that holds every message it sent as it sent it, and whose round chain it signed over. It approves **at most one transcript per `stub_hash`**, whatever the run, and its node keeps that record for as long as the stub can be registered.

A run that stops before a quorum approves it is abandoned: the creator starts another with a fresh `run_id` and the same stub, and every seat generates fresh keys. A run whose transcript a quorum has approved is final for that stub. With a quorum `q > n / 2` ([[contracts]], Trustee registry) two quorums share a seat, so a second approved transcript for one stub needs a seat that broke the rule above; [[verifier]] 3.1 still accepts only the transcript the definition binds. The trustee registry records at most one transcript per `stub_hash` and panel and refuses any other once one has its quorum ([[contracts]], Trustee registry), so a quorum can't hold a second set of keys in reserve for the same definition. Only the panel can register a transcript, so this first-come rule can't be raced by anyone outside it ([[election-definition]], Stub hash and the ceremony).

## Vectors

`docs/spec/vectors/ceremony.json`, from an independent implementation: complete transcripts (honest panels, every disqualification reason, and transcripts that fail each of the four transcript-level codes) with each one's expected result, the registered key set or the reason per seat, and its hash.

## Security notes

- **Withholding.** The coordinator can drop a seat's message, which makes that seat `absent` or disqualifies it, and nothing in the transcript shows it. The seat's node, and every honest seat that saw the message, refuses to sign the ceremony registration. A coordinator could therefore shrink the qualified set to any `k` seats that will sign; under [[0006-trustees]] rule 7, adopted by the owner on 2026-10-12, a transcript with fewer than `max(k, n − 1)` qualified seats is never approved by an honest seat and fails [[verifier]] 3.2 (`ceremony-participation`), so withholding more than one seat (when `k < n − 1`) stalls the election rather than shrinking its margin. It can also let a seat see the other messages of a round before sending its own, and, when a seat signs two different messages in one round, show different seats different ones; a seat shown a view the transcript doesn't hold is left out, as if withheld (Soundness covers both). An honest node SHOULD keep every message it signed over; if the transcript holds another message signed by the same seat in the same round, it refuses to approve and can publish both, which shows that seat equivocated. It can't add a message to a round once a later round has begun, change one, or qualify a seat that didn't prove possession. The transcript check's own floor stays `k` qualified seats (`ceremony-quorum`); rule 7's `n − 1` is checked on top of it, since a set of only `k` would leave the tally no failure margin (T-54).
- **No joint key.** Plurality and approval have no aggregate key, so there is no rogue-key attack to stop (T-40). The proofs show possession: of `x_i`, so a seat can complain ([[share-encryption]], Complaints) and can't take another's `dh`; of `dk_i`, so shares to it can be opened; of `d_i`, so later statements are its own.
- **Corrupt challengers.** A corrupt seat can give a corrupt target the answers to its own challenges. That proves nothing about the target, but the target must still answer every honest qualified seat's challenge. If all qualified seats but the target are corrupt, the corrupt set already has `k` seats (T-14).
- **Decapsulation is chosen-ciphertext access.** A trustee decapsulates at most `n − 1` ciphertexts that other seats chose, and publishes only hashes of the results, each bound to its pair. ML-KEM-768 is IND-CCA2 ([[share-encryption]], Sources), which covers this.
- **The challenge secrets.** `μ_{j→i}`, `m_{j→i}` and `ss_{j→i}` protect nothing after the ceremony; `ss'_{j→i}` is overwritten once hashed. A node draws them from the CSPRNG and never reuses them: a `μ` known before round 3 closes would let its target answer without `dk`.
- **Per-election keys.** Keys are fresh for each election and each run; a node destroys the KEM secret after the tally and the signing key once it has signed its destruction statement, that key's last use ([[tally]], Destruction). [[0012-trustee-identity-signatures]]'s residuals for the identity key apply: a stolen identity key can register keys of the thief's choosing for every later election.
