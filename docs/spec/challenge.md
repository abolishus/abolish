# Benaloh challenge

How a voter checks that their ballot client encrypts the vote they chose (cast-as-intended): the tracking code the client commits to before the voter chooses to cast or to challenge, the opening a challenge reveals, the spoiled-ballot opening record (`0x0003`, version 1) that carries it, the checks anyone runs on an opening, and how a published opening reaches the board. The design is [[0021-challenged-ballots]] (option B): a challenged ballot never reaches the board on its own; its commitment is the tracking code held by a second device the voter chooses, and its opening is published only at the voter's request, after close. Notation is from [[notation]], the group and hashes from [[group]], the committed vote from [[ballot-validity]] and the ciphertexts from [[share-encryption]]. Threats: T-42, T-44, T-47, T-41, T-45, T-11, T-12, T-17, T-52, T-31.

## Sources

- **Benaloh challenge:** J. Benaloh, "Simple Verifiable Elections", EVT 2006, and "Ballot Casting Assurance via Voter-Initiated Poll Station Auditing", EVT 2007. The client commits to an encrypted ballot before it learns whether the voter casts or challenges it; a challenged ballot is opened, checked and never counted.
- **Audited ballots published after the fact:** B. Adida, "Helios: Web-based Open-Audit Voting", USENIX Security 2008, Section 4: an audited ballot's randomness goes to the voter, who may post it afterwards.
- **What an opening rebuilds:** Pedersen VSS (T. P. Pedersen, CRYPTO 1991, Section 4) and the share ciphertext of [[share-encryption]], which is deterministic given its randomness.

## Core and tracking code

A ballot's **core** is the part made before the voter chooses: `definition_hash`, `tier`, `vss` and `share_hashes` ([[ballot-validity]], Casting step 1). Nothing in it depends on the nullifier, so a challenge reveals nothing a cast ballot of the same voter carries ([[revoting]], Client rule 6).

The **tracking code** is the core hash ([[ballot-validity]], Core hash):

```
core_hash = H(DS("abolish/v1/ballot-core",
    definition_hash ‖ u16(0x0002) ‖ u8(1) ‖ u8(tier) ‖ encode(vss) ‖ encode(share_hashes)))
```

Anyone computes it from a cast ballot record (`0x0002`, version 1) and from an opening, so the same 32 bytes name a challenged core, the opening that opens it and, for a core that was cast, the ballot on the board. It binds the ballot record type and version whose layouts `vss` and `share_hashes` use, so one code never names cores of two ballot versions. `definition_hash` binds the election, its rules and its ceremony transcript, and so the registered key set the share hashes are over.

**Shared commitments.** The tracking code names a core, but what reveals a vote is narrower: an opening gives each option's `v_j` and `r_j`, which open that option's vote commitment `C_j = E_{j,0}` ([[ballot-validity]], Committed vote), and the validity proofs speak about the `C_j` alone. Everything else in a core can change while a `C_j` stays: the share ciphertexts don't bind the tier ([[share-encryption]], Ciphertext), whoever knows the polynomials can encrypt the shares again with fresh randomness, giving new share hashes, and can re-blind the higher coefficients (`f'_j = f_j + x · a(x)`, `g'_j = g_j + x · b(x)`), giving new `E_{j,t}` for `t ≥ 1` and new shares over the same `C_j`, at the same option or another. So whether a published opening would reveal a ballot's vote is never decided by the tracking code or by the whole `vss`: an opening and a ballot **share a commitment** when their `definition_hash` fields are equal and some `C_j` of the opening equals some `C_{j'}` of the ballot, at any options `j` and `j'` (elements decode canonically, so equal encodings are equal elements). Such a ballot is opened, for that option, by the published opening, whatever its tracking code. A ballot that re-uses an opened vote with fresh `r_j` shares no commitment, and the opening reveals nothing about it (T-47, T-45, T-12).

The tracking code is always the full 32-byte hash. A client may also show a shorter rendering of it for people to read, but that is a label, never a commitment: no checker or receipt view accepts a match on fewer than 32 bytes, since a client can find two cores, one honest and one cheating, whose `b`-bit renderings agree in about `2^{b/2}` work. A 256-bit hash gives 128-bit collision resistance.

## Opening

Challenging reveals everything that made the core: for each option `j`, both sharing polynomials `f_j` and `g_j` ([[ballot-validity]], Committed vote), whose constant terms are the vote `v_j` and the commitment randomness `r_j`; and for each seat `i` of the registered key set, the encapsulation randomness `(m_i, e_i, w_i)` of its ciphertext ([[share-encryption]], Ciphertext). `w_i` is needed because the proof of knowledge inside `ct_i` depends on it. A seat outside the registered key set has no ciphertext and its share hash is 32 zero bytes ([[ballot-validity]], Admission: `share-hash-unqualified`), so it carries nothing.

From an opening anyone rebuilds every VSS commitment, every seat's shares `(f_j(i), g_j(i))`, every ciphertext under the registered keys, and so every share hash and the core. Pedersen commitments are binding under the discrete-log assumption and `H` is collision resistant, so an opening that rebuilds a core is the only one: no other vote or randomness gives the same `vss`, and no other `(m_i, e_i, w_i)` gives the same `H(ct_i)` (Security notes).

## Spoiled-ballot opening record (`0x0003`, version 1)

| Field             | Type                                             | Meaning                                                                                        |
| ----------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `definition_hash` | `bytes[32]`                                      | The election's definition hash                                                                 |
| `tier`            | `enum8<0, 1, 2>`                                 | The tier the core was made for                                                                 |
| `vss`             | `list<list<element, MAX_TRUSTEES>, MAX_OPTIONS>` | The core's VSS commitments, as the ballot carries them ([[ballot-validity]], Committed vote)   |
| `share_hashes`    | `list<bytes[32], MAX_TRUSTEES>`                  | The core's share hashes, in seat order, as the ballot carries them                             |
| `polynomials`     | `list<option_opening, MAX_OPTIONS>`              | For each option `j` in order, its two sharing polynomials                                      |
| `seats`           | `list<seat_opening, MAX_TRUSTEES>`               | For each seat of the registered key set, in increasing seat order, its ciphertext's randomness |

`option_opening`:

| Field | Type                         | Meaning                                                                          |
| ----- | ---------------------------- | -------------------------------------------------------------------------------- |
| `f`   | `list<scalar, MAX_TRUSTEES>` | The coefficients of `f_j`, constant term first: `v_j`, `a_{j,1}`, …, `a_{j,k−1}` |
| `g`   | `list<scalar, MAX_TRUSTEES>` | The coefficients of `g_j`, constant term first: `r_j`, `b_{j,1}`, …, `b_{j,k−1}` |

`seat_opening`:

| Field  | Type        | Meaning                                             |
| ------ | ----------- | --------------------------------------------------- |
| `seat` | `u8`        | The seat `i`                                        |
| `m`    | `bytes[32]` | `m_i`, the ML-KEM message                           |
| `e`    | `scalar`    | `e_i`, the DH ephemeral                             |
| `w`    | `scalar`    | `w_i`, the nonce of the proof of knowledge of `e_i` |

Notes:

- **The core comes first.** The first four fields are the core, in the order and encodings the core hash takes them, so a reader computes the tracking code from the first bytes of the record: counting the 3-byte header, `definition_hash` starts at byte 3, `tier` at 35 and `vss` at 36.
- **Decoding** is strict ([[notation]]): a `tier` other than 0, 1 or 2 is `invalid-enum`; an identity VSS commitment, a non-canonical element and a scalar at or above `ℓ` are `non-canonical`; a list over its maximum is `length-over-max`. Decoding compares nothing with the election: the checks below do, so an opening naming another election is still read, and reported. A record under a version the profile doesn't pin is `profile-mismatch` ([[verifier]] 2.3).
- **The vote is a scalar.** `f_j`'s constant term is read as the scalar it is, never as a bit, so an opening shows what the client actually committed to, even a vote outside the election's rules (Checks).
- **Sizes.** At 3 options, `k = 2` and `n = 3`, about 1.1 KB; at 10 options, `k = 4` and `n = 7`, about 4.9 KB; at `MAX_OPTIONS` and `MAX_TRUSTEES`, about 101 KB (33 KB of VSS commitments and 66 KB of coefficients), within `MAX_BOARD_PAYLOAD`.
- **Versions.** Opening version 1 opens cores of ballot version 1 only, whose record type and version its core hash binds. Every plurality or approval profile pins both ([[election-definition]], `profile-types`). Whoever specifies another ballot version specifies the opening version for its cores and adds the pairing to [[verifier]] 2.3.

## Checks

An opening is checked against a registered definition (checked by [[verifier]] 2.1 to 2.8) and the registered key set (3.1), never against a board entry. The checks run in this order, and the first failure is the result:

| Code                  | Rejects an opening when                                                                                                                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opening-stray`       | `definition_hash` isn't the election's.                                                                                                                                                                                                                                                                                                            |
| `opening-tier`        | The definition's electorate has no group of tier `tier`.                                                                                                                                                                                                                                                                                           |
| `opening-shape`       | `vss` doesn't have `m` entries of exactly `k` elements each; `share_hashes` doesn't have `n` entries; `polynomials` doesn't have `m` entries whose `f` and `g` have exactly `k` coefficients each; or `seats` isn't exactly the seats of the registered key set, each once, in increasing order.                                                   |
| `opening-unqualified` | A seat outside the registered key set has a share hash other than 32 zero bytes.                                                                                                                                                                                                                                                                   |
| `opening-vss`         | For some option `j` and `t`, `E_{j,t} ≠ g^{coef_t(f_j)} · h^{coef_t(g_j)}`. A report names the first such option.                                                                                                                                                                                                                                  |
| `opening-ciphertext`  | For some registered seat `i`, in increasing order: `e_i` or `w_i` is 0, or the ciphertext rebuilt from the seat's shares `(f_j(i), g_j(i))` for every option, its registered `(ek_i, dh_i)`, `m_i`, `e_i` and `w_i`, exactly as [[share-encryption]] (Ciphertext) makes it, doesn't hash to `share_hashes[i]`. A report names the first such seat. |

An opening that passes **opens** its core: it gives the core hash and the vote `v_j = coef_0(f_j)` for each option. It is checked whatever that vote is. If some `v_j` is neither 0 nor 1, or `Σ v_j` is outside `min` to `max`, the opening still passes, and is reported as `opening-vote-outside`: the client committed to a vote no valid ballot could carry, which is evidence against that client, not a failure of the opening.

Why this order: the first two need only the header fields, the next two only lengths and zeros, and `opening-vss` runs before the costly ML-KEM encapsulations of `opening-ciphertext`, which build each seat's shares from polynomials already checked against `vss`. An honest client's `e_i` and `w_i` are drawn from 1 to `ℓ − 1` ([[share-encryption]], Ciphertext); `e_i = 0` would make `ct_DH` the identity, which no ciphertext carries.

The checks never read the board. Whether an opening's core was cast, and where an opening was boarded, are the board checks of Publication below.

## Client rules

The ballot client (P2-8, P5-4):

1. **The code before the choice.** After building the core ([[ballot-validity]], Casting step 1) and before showing the cast-or-challenge choice, it shows the tracking code as a QR code of the full 32-byte hash, every time, whether or not the voter scans it. It makes no validity proof, L1 reference or membership proof before the choice ([[revoting]], Client rule 6).
2. **Challenge.** If the voter challenges, it reveals the opening of that core and nothing else, and hands it to the voter's checker by QR code or file, never through our API or any server. It then makes a fresh sharing for the next attempt. It never casts a core it has opened, and never opens a core it has cast: `packages/crypto` refuses to prove a sharing it has opened and to open one it has proved. That binds honest clients only: whoever holds an opening can make fresh validity proofs and cast its core under their own nullifier (Residuals).
3. **Cast.** If the voter casts, it proves and casts that core, with the share hashes the code was computed over ([[ballot-validity]], Casting), and erases the sharing's randomness, except `ct_i` and `m_i` for a seat that didn't receipt, kept until the voter decides whether to post it ([[share-encryption]], Order of construction; [[delivery]], Client rules; T-18, T-45).
4. **Publishing is the voter's choice.** It never publishes an opening on its own. At the voter's explicit request it submits the opening through the board path only once segment `s_S`, the counted extent's last ([[tally]], Tally window), has ended, and no later than `t_S + OPENING_WINDOW` (Publication), once per opening.

The checker (the voter's second device, or a checker they choose; P2-8, P5-4):

1. **Record before the choice.** It records a tracking code scanned from the casting device's screen before the choice, with the election it is for, and, once it has checked a challenge's opening against that code, the opened core's vote commitments `C_j`. An opening checked without a code recorded that way is compared only with what the casting device shows afterwards, which malware on it controls, so the checker never reports it as checked: it reports "not verified".
2. **Its own sources.** It fetches the definition, the registered key set and the display text itself, from chain and IPFS, and runs [[verifier]] 2.1 to 2.8 and 3.1 for them; never from the casting device or our API, which could otherwise show an attempt under a substituted definition.
3. **Check.** It rejects an opening whose `definition_hash` isn't the election's or whose `tier` isn't the voter's, runs the checks above, compares the opening's core hash with the recorded code, all 32 bytes, and only then shows the vote with the definition's display text ([[display-text]], Client rules). A failing opening, a mismatching code or `opening-vote-outside` is reported as evidence that the casting device misbehaved.
4. **Cast ballots.** It finds the voter's cast ballot on the board by its tracking code, reading whole segments or the whole board, never a targeted query for one code, which would link its network address to the ballot and its nullifier (T-11, T-45). It warns if a ballot under the voter's nullifier shares a commitment with a challenged attempt it recorded (Shared commitments, above), whatever that ballot's tracking code: a client that cast an opened core's commitments under fresh share hashes, another tier or re-blinded coefficients would otherwise go unnoticed. Checking the cast ballot's admission and selection is [[revoting]]'s and the receipt's (P1-13b).

## Publication

An opening reaches the board only through our API, as a board entry; never as a contract event, since nothing about it needs the contract path's guarantees (no count depends on it). The board operator holds the openings it receives in a period and appends them, sorted, when the period ends ([[board]], Spoiled-ballot openings). It MUST board an opening only if:

- it decodes strictly under the version the profile pins and passes the checks above;
- the segment it would be boarded in is after `s_S`, the last segment of the counted extent ([[tally]], Tally window), and at most the anchoring period containing `t_S + OPENING_WINDOW` ([[parameters]]);
- no ballot admitted ([[verifier]] 5.1 to 5.4) in the counted extent shares a commitment with it (Shared commitments, above), since publishing the opening would open that ballot's vote; and
- no opening with that core hash is already boarded.

A verifier ([[verifier]] 6.2) runs the same rules over the openings in the sealed extent and reports each one that breaks them. None of these ever changes what counts or fails the election: an opening is never a ballot, never enters selection ([[revoting]], Selection rule 5) and never touches the tally. They are reports, attributed as follows:

| Code                | Reported when                                                                                   | Attributed to                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| decode, `opening-*` | The opening fails to decode or fails a check above                                              | The board operator, which can run the same checks before boarding                                                             |
| `opening-early`     | Its segment is at or before `s_S`                                                               | The board operator                                                                                                            |
| `opening-late`      | Its segment is after the period containing `t_S + OPENING_WINDOW`                               | The board operator                                                                                                            |
| `opening-cast`      | A ballot admitted in the counted extent shares a commitment with it, whatever its tracking code | The board operator, which holds the counted extent before it may board any opening                                            |
| `opening-repeat`    | An earlier entry carries an opening with the same core hash                                     | The board operator. Two different passing openings of one core would also be evidence that binding is broken (Security notes) |

`opening-vote-outside` is reported for every passing opening it applies to, against no one on the board: it concerns the client that made the core.

**No window enters the counted set.** Openings can't change a counted set, so [[tally]]'s `W_S` gains nothing from them. `OPENING_WINDOW` is the openings' term in the seal's `W` ([[election-definition]], The seal). Like the tally window it starts at `t_S` and lasts seven days, so it ends when the tally window does, and never moves the seal. That holds while `OPENING_WINDOW ≤ TALLY_WINDOW`: a later opening or tally-opening version that breaks it makes the openings' window a term that moves the seal, and must say so.

**Why after the counted extent.** An opening boarded during voting would put an unauthenticated record near the cast ballots whose timing it could reveal. And until the counted extent is fixed a ballot carrying an opened core's vote can still land: a direct-submitted or force-included ballot reaches the board up to the contract-event window after close, and [[board]]'s client rule 1 lets a ballot cast in close's period carry the next segment ([[tally]], Tally window). After `s_S` nothing that lands can count, so the operator's `opening-cast` check is final and is always its own to answer for, and an opening's timing says nothing about when its voter cast ([[board]], Spoiled-ballot openings; T-42, T-47).

## Security notes

- **Soundness of the challenge** rests on the client committing before it learns the choice. The commitment is the tracking code the voter's checker records; the board adds nothing to it, since anything boarded at challenge time would follow the choice ([[0021-challenged-ballots]], option A). A client that commits to a core encrypting another vote is caught on every challenge of that core, so one that cheats with probability `p` per attempt survives `c` honest challenges with probability `(1 − p)^c`, as long as it can't tell which attempts will be challenged (T-42, T-44).
- **Binding.** Two different openings of one core need either two openings of a Pedersen commitment (`log_g h`, which no one knows) or two ciphertexts with one hash (a SHA-256 collision): `vss` fixes every coefficient, so every seat's shares; `H(ct_i)` fixes `ct_i`, so `ct_M` (which fixes `m_i`, by ML-KEM's correctness), `ct_DH` (which fixes `e_i`), and the proof `(pok_c, pok_z)` (which fixes `w_i = pok_z − pok_c · e_i`).
- **Hiding is unaffected.** An opening reveals one challenged core, which is never counted, and nothing that depends on a nullifier. It reveals the vote the client committed to in that attempt, which is usually the voter's real choice (Residuals).
- **Bytes chosen by a submitter.** Every field of a passing opening is fixed by its core and the rules above (binding), and the core is fixed by the polynomials and randomness, which look random. A submitter can choose those values, and so hide bytes in them, as in every field that must be random ([[notation]], Result-critical fields; T-17). Openings are unauthenticated: after close anyone can make a core and a passing opening for any vote, as many as the API's rate limits allow, each bounded by the definition's shape (T-17, T-52).

## Residuals

- **The voter's intent is never provable to a third party.** A published opening shows that a core with that tracking code opens to that vote, and that the core wasn't cast (`opening-cast`); that the casting device showed that code before the voter chose rests on the voter's word and their checker's record (T-42).
- **A client can guess who checks.** The casting device gets no signal from a scan, but can guess from the session (time on the screen, focus and visibility events, a first challenge's handover), or remember a voter who checked before, and cheat the others (T-44, T-41).
- **An opening is a receipt.** It gives every `r_j`, so whoever holds it (the voter, the checker, a malicious casting client) can make fresh validity proofs and cast its commitments under their own nullifier, with its own share hashes or fresh ones; a voter can sell a vote this way, and anyone given an opening during voting can cast it, after which the operator refuses the voter's own publication (`opening-cast`). A later re-vote still overrides a sold ballot unless the buyer watches until close (T-47, T-45). The generators are the same in every election, so an opened `C_j` can also be cast in another election, whose operator never sees this one's openings: publishing an opening may then open a vote there, and nothing reports it (T-47, T-12).
- **The checker's records identify the voter's ballots** to anyone who inspects the device (T-45). A voter without a second device checks only the software, not the device.
- **A published opening can be linked** to its publisher by network metadata, and it usually shows the voter's real choice (T-11, T-12, T-47).
- **Public evidence waits for close,** when the voters a cheating client misled can no longer re-vote.

## Test vectors

`docs/spec/vectors/challenge.json` ([[vectors/README|vectors]]): elections with their definitions and registered KEM keys; openings that pass (plurality, approval with a seat outside the registered key set, a blank vote, `MAX_OPTIONS`, `MAX_TRUSTEES`) with the randomness that made each, its core hash, its votes and its encoding, re-made byte for byte by `openChallenge`; passing openings of votes outside the rules; openings failing each check, and five failing two checks each, which pin the order; decode rejections; cores that share a commitment with an opening under other tracking codes (fresh share hashes, another tier, re-blinded coefficients, a commitment at another option) and cores that don't (fresh `r_j` for the same vote, another vote, another election); and the core hashes of cast ballots from `ballot.json`. They are printed by `packages/crypto/scripts/challenge-vectors.py`, an implementation of this page in Python's integers and `hashlib`, reusing only `share-encryption-vectors.py` (ML-KEM-768 from FIPS 203 and ChaCha20-Poly1305 from RFC 8439, each checked against published vectors first), `ballot-validity-vectors.py` and `definition-vectors.py`.
