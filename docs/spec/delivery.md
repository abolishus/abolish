# Share delivery on the board

How a ballot's delivery to each trustee is shown on the board, and how anyone decides from the board which ballots were delivered and which a proven complaint excludes: the share-receipt record (`0x000c`), the share-posting record (`0x000d`) and the share-complaint record (`0x000e`), each version 1; the delivery deadline and the complaint window; the board operator's boarding rules; and the delivery check that the counted set of [[tally]] applies. This is the delivery and counting step of [[0002-everlasting-privacy]] (option B, accepted by the owner: Deadline, Complaints, Complaint window). What each record proves is in [[share-encryption]] (Intake and receipts, Public posting, Complaints); this page puts it on the board. Notation is from [[notation]], the ballot hash from [[ballot-validity]]. Threats: T-41, T-29, T-25, T-17, T-15, T-31, T-34, T-52, T-54.

## Versions

None of the three types is pinned in an election's profile. Version 1 of the ballot record (`0x0002`) fixes all three at version 1, together with the windows below ([[versioning]], Three levels), so delivery can't drift from the ballots it delivers: the ciphertexts' associated data and the ballot hash name ballot version 1 already ([[share-encryption]], Ciphertext; [[ballot-validity]], Ballot hash).

The three types reach the board only under board-entry version 3, which allows them ([[board]], Allowed payloads); version 2 is never assigned, since a frozen vector of `board.json` uses it as the version that doesn't exist. Under board-entry version 1 no ballot could be delivered, so a profile that pins ballot version 1 MUST pin board-entry version 3: [[verifier]] 2.3 fails a profile pinning ballot version 1 with any other board-entry version (`profile-combination`), the ballot client refuses to cast in such an election, and P1-18's election registry MUST refuse to register such a definition, so the mistake is caught before the election exists rather than after. A later board-entry version that also allows the three types adds itself to this rule.

## Records

### Share receipt (`0x000c`, version 1)

A trustee's share receipt ([[share-encryption]], Intake and receipts) as a record: its signed statement, then its signature.

| Field             | Type        | Meaning                                                                         |
| ----------------- | ----------- | ------------------------------------------------------------------------------- |
| `definition_hash` | `bytes[32]` | The election's definition hash                                                  |
| `ballot_hash`     | `bytes[32]` | The ballot hash of the public part the trustee checked ([[ballot-validity]])    |
| `seat`            | `u8`        | The trustee's seat, `i`                                                         |
| `share_hash`      | `bytes[32]` | `H(ct_i)`                                                                       |
| `signature`       | `p256-sig`  | The seat's signature under `abolish/v1/sig/share-receipt` over the first fields |

The fields before `signature` are exactly the 97-byte statement `m` the trustee signs ([[share-encryption]], Intake and receipts), so a node's receipt becomes a record with no new signature. 164 bytes with its header.

### Share posting (`0x000d`, version 1)

The client's public posting of one ciphertext with its ML-KEM message ([[share-encryption]], Public posting).

| Field             | Type               | Meaning                                                                 |
| ----------------- | ------------------ | ----------------------------------------------------------------------- |
| `definition_hash` | `bytes[32]`        | The election's definition hash                                          |
| `ballot_hash`     | `bytes[32]`        | The ballot hash of the ballot the posting delivers                      |
| `seat`            | `u8`               | The seat the ciphertext is for, `i`                                     |
| `m`               | `bytes[32]`        | `m_i`, the ML-KEM message                                               |
| `ciphertext`      | `share_ciphertext` | `ct_i`, decoded strictly as [[share-encryption]] (Ciphertext) specifies |

A posting carries no signature: only a party that knows `m_i` can make one that passes, and a passing posting is the same whoever boards it ([[share-encryption]], Public posting). Since `ciphertext` decodes strictly, a ciphertext that doesn't decode makes the record fail to decode, so `posting-malformed` never arises for a record that decodes. Its check hashes `ct_i` as encoded in the record, which is `ct_i`'s one encoding. 1,308 + 64·`m` bytes with its header, for `m` options: 1,948 bytes at 10 options, 5,404 at `MAX_OPTIONS`.

### Share complaint (`0x000e`, version 1)

A trustee's complaint about a posting ([[share-encryption]], Complaints), signed so that an unfounded one is attributed.

| Field             | Type              | Meaning                                                     |
| ----------------- | ----------------- | ----------------------------------------------------------- |
| `definition_hash` | `bytes[32]`       | The election's definition hash                              |
| `ballot_hash`     | `bytes[32]`       | The ballot hash of the ballot whose posting it is about     |
| `seat`            | `u8`              | The complaining seat, `i`                                   |
| `proof`           | `complaint_proof` | `D` and its Chaum–Pedersen proof                            |
| `signature`       | `p256-sig`        | The seat's signature under `abolish/v1/sig/share-complaint` |

The signature is an ECDSA P-256 signature by seat `i`'s per-election signing key ([[trustee-identity]], Which key signs what), under `abolish/v1/sig/share-complaint`, over

```
m = definition_hash ‖ ballot_hash ‖ u8(seat) ‖ encode(proof)
```

161 bytes: the record's fields without its header and signature. It **attributes** the complaint to seat `seat` if and only if `seat` has registered keys ([[ceremony]], Transcript check) and the signature verifies under that seat's registered signing key, never its identity key; any other complaint is **unattributed**. 228 bytes with its header.

A proven complaint excludes its ballot whether or not it is attributed: its proof shows `D = ct_DH^x` for seat `i`'s registered `dh_i`, which needs `x`, and with it anyone sees the shares fail. The signature only decides whom an unfounded complaint is attributed to (T-29). `m` binds the definition, the ballot and the seat, so a complaint replayed against another election, ballot or seat is unattributed, never framing its signer; the proof itself binds the definition, the seat, the trustee's key and the ciphertext's hash ([[share-encryption]], Complaints).

### Decoding

Each record decodes strictly ([[notation]]): every `element` is canonical and not the identity where its table says so, every `scalar` is below `ℓ`, and nothing trails. Decoding doesn't compare `definition_hash`, `ballot_hash` or `seat` with the election; the delivery check does, so a record naming another election, ballot or seat is still read, and reported. A delivery record that fails to decode, including one under a version ballot version 1 doesn't fix (`profile-mismatch`), is a rejected entry ([[board]], Allowed payloads; [[verifier]] 2.3), listed in the report, never an election failure and never a receipt, posting or complaint.

## Windows

Version 1 of the three records fixes two windows, counted from `closes_at + l1_inclusion_bound` (the close rule's deadline, [[election-definition]]):

| Name               | Value   | Meaning                                                                                         |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------- |
| `DELIVERY_WINDOW`  | 86,400  | Seconds by which a ballot's share receipts and postings must be sent: the **delivery deadline** |
| `COMPLAINT_WINDOW` | 345,600 | Seconds by which a complaint must be sent: the end of the **complaint window**                  |

A record's window is applied by its submission time ([[tally]], Tally window). A record that reached the board through the board path has its segment's anchoring period as its submission time, so it is **in time** if its entry's `segment` is at most

```
s_D = period(closes_at + l1_inclusion_bound + DELIVERY_WINDOW)    for receipts and postings
s_K = period(closes_at + l1_inclusion_bound + COMPLAINT_WINDOW)   for complaints
```

where `period(t) = ⌊(t − epoch) / period⌋` under the anchoring clock ([[board]], Timing), so a record boarded in the deadline's own period is in time. That period can end moments after the deadline, so a client or trustee node MUST send its records by the deadline less the operator's boarding latency, and retry through the contract path if no board entry appears in time. A record sent through the contract path (Direct submit, below) is in time if its submission time is at or before `closes_at + l1_inclusion_bound + DELIVERY_WINDOW` (or `COMPLAINT_WINDOW`). A record that is not in time is ignored: it delivers nothing and excludes nothing, wherever it is on the board.

Both windows, each followed by the contract-event window (a contract-path record sent at a window's end still has to reach the board), are in [[tally]]'s `W_S`, so `s_S ≥ s_K ≥ s_D` and every record that is in time, by either path, is in the counted extent, and the counted set is fixed before any summed share is sent ([[0002-everlasting-privacy]], Tally liveness). Receipts, postings and complaints are the board-path records that can change a counted set: a receipt or a passing posting can complete a ballot's delivery, and a proven complaint excludes it ([[tally]], Tally window).

Why these values:

- **One day for delivery.** A ballot cast at the close normally holds every receipt already (intake runs before the client shows "cast"). The day covers a client that falls back to posting because a trustee or the relay is down at the close, and a receipt that reaches the board after its ballot. A longer window postpones the counted set and the tally (T-54).
- **Three more days for complaints.** A trustee that was offline during voting must process every posting addressed to it before the window closes, or it can't complain about an invalid one, and its summed shares then fail ([[tally]], Summed-share check), so it can't contribute to the tally. Three days after the last possible posting covers a weekend; more would postpone every election's seal ([[election-definition]], The seal).

## Boarding

The board operator boards a delivery record only if all of the following hold, and refuses every other:

1. It names this election's definition, and `seat` is a seat of the registered key set.
2. A ballot whose ballot hash is the record's `ballot_hash` is already on the board, as a ballot entry or a contract event.
3. It is in time (Windows), boarded in a segment no later than `s_D`, or `s_K` for a complaint.
4. For a share receipt: its signature attributes it to `seat` (the `share-receipt` check against that ballot, with `share_hash` equal to the ballot's `share_hashes[seat]`). For a posting: it passes the public check against that ballot (`posting-hash`, `posting-proof`, `posting-encapsulation`). For a complaint: a posting for that ballot and seat is on the board and passes, the complaint is proven against it (`complaint-proof`, then decryption failing), and its signature attributes it to `seat`.
5. No record of the same type for the same ballot hash and seat is on the board yet; and for a posting, no share receipt for that ballot hash and seat is on the board either, since a posting publishes `m_i` and drops that share to classical privacy for nothing once the trustee's receipt is boarded (T-15).

So a boarded receipt or complaint carries no chosen bytes beyond a registered trustee's choice of ECDSA nonce, and there is at most one record of each type per seat per boarded ballot (T-17, T-52). A posting is different: its `sealed` field is checked only through its hash, never opened by the public check, so a dishonest client chooses its whole plaintext, `4 + 64·m` bytes, and `m_i`, and the posting passes as long as the ballot commits to it. A voter can therefore archive about `n · (64·m + 36)` chosen bytes per ballot, about 66 KB at `MAX_OPTIONS` and `n = 16`, and again with every re-vote, bounded only by its membership in the electorate; the trustees' complaints exclude such a ballot but can't remove its postings (T-17, Residuals). Without rule 2, anyone could archive that much without any ballot at all, without limit, and a corrupt trustee could archive chosen bytes in receipts for ballot hashes of its choosing. Refusing an unfounded complaint also keeps a readable share out of the permanent archive: its `D` and the posted `m_i` open the share at once (T-15). An unfounded complaint can't change a counted set, so refusing it costs the result nothing; it only loses the evidence against its signer, which the trustee could have published elsewhere anyway.

The verifier still reads whatever the board holds, as the delivery check below says: a record the operator should have refused is read like any other and, where it fails, ignored. Reporting such a record against the operator is [[verifier]]'s (P1-19).

### Direct submit

A voter who bypasses our servers delivers to the trustees' intake directly (T-25), and its ballot reaches the board as a contract event. Its receipts and postings must reach the board too, or the ballot is never delivered, and an operator that withholds board-path delivery records silently keeps ballots out of the counted set. A contract path for share receipts, postings and complaints, emitted as events under the event accumulator ([[contracts]]), MUST exist before any election registry is deployed (P1-18; T-25, T-54). The contract-event window MUST be shorter than `DELIVERY_WINDOW`, so a ballot forced through L1 at the close is recorded by the contract, and so can be delivered through it, before its delivery deadline (P1-18). It accepts a receipt or complaint only if signed by a registered seat's per-election key naming this definition, and a posting only for a ballot already recorded by the contract, at most one of each per seat and ballot hash. A record it accepted is boarded as a contract event, late or not ([[verifier]] 4.4), and is in time by its submission time (Windows). P1-18 defines how the contract-event record carries it; the delivery check reads it as if it were the record itself, on the board where its contract event is.

## Delivery check

The verifier ([[verifier]] 5.9) takes the election's definition hash, its registered key set (each qualified seat's KEM key and signing key, [[ceremony]], Transcript check), `s_D` and `s_K`, the ballots [[revoting]] selects for each cell from the counted extent ([[tally]], Context), and every delivery record in the counted extent, in board order. For each selected ballot `b`, with `bh = ballot_hash(b)` recomputed from the decoded ballot:

- **Seat `i` is delivered** if it isn't in the registered key set, or if some record in time names this definition, `bh` and seat `i`, and is either a share receipt whose `share_hash` is `b`'s `share_hashes[i]` and which passes `share-receipt` against `b`, or a posting that passes the public check against `b` (`posting-hash`, `posting-proof`, `posting-encapsulation`).
- **The ballot is delivered** if every seat `1, …, n` is: every qualified seat has a receipt or a passing posting in time.
- **A complaint about seat `i` is proven** if it names this definition, `bh` and seat `i`, is in time for `s_K`, a posting for `b` and seat `i` that is in time for `s_D` passes the public check, wherever it is on the board, and the complaint passes `complaint-proof` and doesn't fail `complaint-unfounded` against that posting ([[share-encryption]], Complaints). Every passing posting for `b` and seat `i` carries the same `ct_i` (its hash is `share_hashes[i]`) and the same `m_i` (unique for `ct_M`), so which one is used doesn't matter.
- **The ballot is excluded** if any complaint about any of its seats is proven, attributed or not.

`b` stays in the counted set exactly when it is delivered and not excluded; otherwise it counts nothing, with no fallback to an earlier ballot of its nullifier ([[revoting]], No fallback). Neither outcome depends on the order of the records, on duplicates or on records for other ballots, so the operator's ordering decides nothing ([[verifier]] 6.1, R3).

The report lists, for each selected ballot, whether it was delivered, which seats were missing, and each proven complaint with its attribution; and, for the records:

| Code                   | Reported for                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delivery-stray`       | A record naming another definition. Ignored                                                                                                                                           |
| `delivery-seat`        | A record naming this definition and a selected ballot, for a seat that isn't in the registered key set. Ignored                                                                       |
| `delivery-late`        | A record naming this definition and a selected ballot that isn't in time. Ignored                                                                                                     |
| `share-receipt`        | A share receipt for a selected ballot that fails the check, or whose `share_hash` isn't the ballot's for its seat. Ignored                                                            |
| `posting-*`            | A posting for a selected ballot that fails the public check, with its first failing code. Ignored; a complaint about it is void                                                       |
| `complaint-void`       | A complaint for a selected ballot with no passing posting in time for its seat. Ignored                                                                                               |
| `complaint-proof`      | A complaint for a selected ballot whose proof fails. Ignored                                                                                                                          |
| `complaint-unfounded`  | A complaint whose proof verifies but whose shares open and pass. The ballot stands; the complaint is attributed to its signer if its signature attributes it, and otherwise no one's  |
| `receipt-contradicted` | A share receipt that passes, for a seat whose complaint about the same ballot is proven: the seat signed that shares passed which a public proof shows don't. Attributed to that seat |

Each record is reported with the first of these codes that applies, in table order, so a late record is reported late whatever else is wrong with it. Records naming a ballot that isn't selected (an earlier ballot of a re-voting nullifier, a ballot outside the counted extent) are read and set aside: they decide nothing, and nothing is reported for them. A record that doesn't decode is a rejected entry (Decoding).

Notes:

- **Seats that aren't qualified.** A ceremony can end with fewer than `n` qualified seats ([[ceremony]], Transcript check), and shares are encrypted only to qualified seats' keys. For a seat outside the registered key set the client encrypts nothing and sets the ballot's `share_hashes[i]` to 32 zero bytes; that seat needs no delivery and is never summed, and its share of the vote is simply never sent, so the tally needs `k` of the qualified seats. The ballot record's admission checks (P1-12, with the ballot record) MUST reject any other value there; until they exist, a ballot can carry `32 · (n − q)` chosen bytes in the share hashes of the `n − q` seats that aren't qualified (T-17).
- **A receipt and a proven complaint for one seat.** A trustee receipts only shares that pass its own intake, and a proven complaint shows publicly that the same ciphertext's shares don't, so both can't be honest. The ballot is excluded, since the proof is public and the trustee can't sum it correctly either, and the receipt is reported against its seat (T-29).
- **Postings next to receipts.** A passing posting for a seat that also has a receipt is redundant: the operator refuses it (Boarding), but one found on the board still delivers, and [[verifier]] 8.2 counts it as readable ([[tally]], Residuals).

## Residuals

- **The operator can withhold board-path delivery records** until the contract path exists (Direct submit): a ballot whose receipts or postings it refuses is silently left undelivered, and a complaint it refuses keeps an invalid ballot counted, so the complaining trustee's summed shares fail and the tally needs `k` other trustees (T-25, T-54). Nothing on the board attributes either.
- **A cheating client can still exclude its own voter's ballot** by posting an invalid share: a proven complaint excludes it after the close, too late to re-vote ([[0002-everlasting-privacy]], Re-voting; T-41, T-42).
- **A trustee that misses the complaint window** can't complain about an invalid posted share, so its summed shares fail and it can't contribute to the tally ([[0002-everlasting-privacy]], Tally liveness; T-54).
- **A voter can archive chosen bytes in postings**, about `n · (64·m + 36)` per ballot and re-vote, since the public check never opens `sealed` (Boarding; T-17).
- **Receipts don't prove eligibility.** A receipt says only that the trustee's shares pass for this public part ([[share-encryption]], Intake and receipts); membership is checked on the ballot (5.1).

## Test vectors

`docs/spec/vectors/delivery.json` ([[vectors/README|vectors]]): share receipts, postings and complaints as records, re-made byte for byte, with the complaint's signed message; decode rejections (truncation, trailing bytes, another record type, an unpinned version, a non-canonical scalar, an identity element, a ciphertext that doesn't decode); board entries under version 3 carrying each type, and the same payloads rejected under version 1; the deadline segments for several clocks and closes; and elections with selected ballots and delivery records, each with the delivery check's verdict per ballot and its reports: every seat receipted, a seat posted, a seat missing, a late receipt, a receipt for another definition, ballot, seat or ciphertext, a failing posting, a proven complaint (attributed and unattributed), an unfounded complaint, a late complaint, a complaint without a passing posting, a receipt contradicted by a proven complaint, duplicates, and records in another order giving the same verdicts. They are printed by `packages/crypto/scripts/delivery-vectors.py`, which reuses `share-receipt-vectors.py`'s ballots, receipts and P-256 ECDSA and `share-encryption-vectors.py`'s posting and complaint checks, and so shares nothing with `packages/crypto`.
