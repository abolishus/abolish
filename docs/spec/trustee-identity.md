# Trustee identity

Every trustee seat has a long-term identity key, pinned in the verifier's and the ballot client's releases. It is the root of everything a trustee says in the protocol: it signs the trustee's ceremony registration and the trustee's own ceremony entry, which registers that trustee's per-election keys, so every later statement can be attributed to its seat and to nothing else, and the trustee registry on L2 can check a panel's signatures instead of trusting who sent a transaction. This page fixes the identity key and signature encodings, how a message is signed and verified, the panel identifier and the signed statements specified so far. The scheme is ECDSA over P-256 with SHA-256 ([[0012-trustee-identity-signatures]]). Notation and decoding rules are from [[notation]]. Threats: T-37, T-14, T-29, T-31, T-30, T-71.

## Curve

NIST P-256 (`secp256r1`), as in FIPS 186-5 and SEC 2 v2 §2.4.2:

```
p = 2^256 − 2^224 + 2^192 + 2^96 − 1
a = −3,  b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b
n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551
G = (0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296,
     0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5)
```

The cofactor is 1: every point on the curve except the identity has order `n`, so no subgroup check exists or is needed.

## Identity key

A trustee's identity key is a P-256 public key `Q = d · G` for a secret scalar `d` in `[1, n − 1]`. Its encoding, `p256-key`, is `bytes[33]`: the SEC 1 v2 §2.3.3 compressed form,

```
p256-key = u8(0x02 + (y mod 2)) ‖ x
```

with `x` as 32 bytes big-endian. A decoder MUST reject, with `non-canonical` ([[notation]], Strict decoding):

- a first byte other than `0x02` or `0x03` (the identity `0x00`, the uncompressed form `0x04` and SEC 1's hybrid forms `0x06`, `0x07` are never accepted);
- `x ≥ p`;
- an `x` for which `x³ − 3x + b` is not a square modulo `p` (no point on the curve).

A shorter input is `truncated`; a valid encoding followed by more bytes is `trailing-bytes` (the 33 bytes are validated first, so a 65-byte uncompressed key is `non-canonical`). Every point but the identity has exactly one encoding, so equal keys have equal bytes and a key can be compared, hashed and deduplicated as bytes.

The secret key has no protocol encoding: it never leaves the trustee's node or hardware, and nothing in the protocol serialises it.

## Signatures

A trustee signs a statement `m` under a registered signature tag `tag` ([[domain-separation]], primitive Signature) as ECDSA with SHA-256 over the message

```
M = DS(tag, m)
```

so the ECDSA digest is `e = int(H(M))`, the protocol hash of [[group]] read big-endian. `n` has 256 bits, so `e` is used whole, with no truncation (SEC 1 v2 §4.1.3, step 5), and is then reduced modulo `n` like every other operand: a digest at or above `n` (probability about 2⁻³²) is valid, never rejected.

The encoding, `p256-sig`, is `bytes[64]`: `r ‖ s`, each 32 bytes big-endian (IEEE P1363). A decoder MUST reject with `non-canonical`:

- `r = 0` or `r ≥ n`;
- `s = 0` or `s > (n − 1) / 2` (the **low-s rule**).

**Verification.** `Verify(Q, tag, m, sig)` decodes `Q` and `sig` as above, rejecting on any failure, then computes, with all arithmetic modulo `n` except the point operations:

```
e  = int(H(DS(tag, m)))
w  = s⁻¹
u1 = e · w,  u2 = r · w
R  = u1 · G + u2 · Q
```

and accepts if and only if `R` is not the identity and `x(R) mod n = r`. `x(R)` is an integer below `p`, which is larger than `n`, so the reduction matters: an `R` with `x(R) ≥ n` verifies against `r = x(R) − n`. Both edge cases have vectors (`trustee.json`). This is SEC 1 v2 §4.1.4 and FIPS 186-5 §6.4.2, plus the decoding rules above. A conforming verifier MUST reject exactly the inputs this rule rejects.

**Which key signs what.** The identity key signs every trustee message of the ceremony phase, before the trustee's per-election keys are registered: the ceremony registration (below), the trustee's own ceremony entry, which registers its per-election keys with their proofs of possession, and its other messages in the ceremony's rounds ([[ceremony]], Rounds). Statements made after registration, during and after an election (share receipts, close statements ([[close]]), summed-share messages, tally openings and a live poll's running openings ([[tally]]), destruction statements; availability attestations and availability complaints ([[availability]]); [[0002-everlasting-privacy]], [[verifier]] 3.1 and 7.2) are signed with the per-election signing key that the ceremony entry registers, under this page's scheme and encodings, and checked against that registered key, never against the identity key directly. A per-election key bounds what a stolen key can sign to one election; the identity key, which a release pins, makes the registered key attributable to its seat (T-37). The Tier 2 keyed nullifier's key is the other case of the identity key's use between elections ([[nullifier-key]]): the identity key signs the seat's messages in the key's rounds and its approval of the key, and registers a **registration signing key** that signs the seat's keyed-nullifier answers ([[keyed-nullifier]], Answer record). Registration happens between elections, when no per-election key exists, and answers are signed automatically, so they never use the identity key (T-37). A reshare of that key ([[nullifier-reshare]]) is a ceremony of the same kind: the old seats' identity keys sign their dealings and responses, and the new seats' sign their registration keys, complaints and approval of the successor.

**Signing.** A signer computes a standard ECDSA signature on `M` with SHA-256 and a nonce that is secret, uniform and never reused (an HSM's generator, or RFC 6979's deterministic nonce), then, if `s > (n − 1) / 2`, replaces `s` with `n − s`. `packages/crypto` signs with RFC 6979 §3.2 nonces and HMAC-SHA-256, so it never depends on a random number generator at signing time.

Why the low-s rule: `(r, n − s)` verifies whenever `(r, s)` does. Without the rule, anyone who sees a signature can make a second one, and a record carrying it a second encoding and a second hash (T-31). With it, only the signer can produce another valid signature on the same statement (by using another nonce). So a signature never identifies the statement it signs: where uniqueness matters, the protocol hashes the statement, not the signature.

Why `DS`: the tag makes a signature valid for one statement type only. A signature on a ceremony registration can never be replayed as a receipt or a destruction statement, even if their byte layouts happened to coincide (T-30, T-31). Every statement also binds the context it is valid in (chain, contract, election, panel, seat), so a signature can't be moved to another election either.

## Panel identifier

A panel is an ordered list of `n` identity keys and a threshold `k`. Seat `i` (1-based) is the `i`-th key; the seat number is the trustee's index everywhere in the protocol (its share index in voter-side sharing, [[0002-everlasting-privacy]], and the index in every ceremony and tally message). The panel identifier is

```
panel_id = H(DS("abolish/v1/panel", u8(k) ‖ u8(n) ‖ Q_1 ‖ … ‖ Q_n))
```

with each `Q_i` as its 33-byte `p256-key` encoding. A panel is valid only if (checked in this order, which fixes the error code `packages/crypto` and the vectors report; a third party MUST reject the same panels and SHOULD report the same code):

1. `n ≤ MAX_TRUSTEES` ([[parameters]]) (`size`);
2. `2 ≤ k ≤ n` (`threshold`): with `k = 1` one trustee could open every voter's sharing alone (T-14);
3. for each seat in order, `Q_i` decodes as a `p256-key` (`key`) and differs from every earlier key (`duplicate-key`). A key in two seats would give its holder two shares of every ballot, so `k − 1` parties could open what needs `k` (T-14).

`panel_id` binds `k`, `n`, every key and its seat, so a definition can't name a known panel with a lower threshold, a reordered seat list or a substituted key and keep the same identifier (T-37, T-14). It is the value the election definition carries as `panel_id` (P1-10b). Releases pin panels by their keys and `k`; the verifier and the ballot client recompute `panel_id` from what they pin and never take it from election data ([[verifier]], Pinned trust roots).

### Author panel identifier

Under election-definition version 6 a poll may have an **author panel** beside the default panel: trustees its author chose, listed in the definition rather than pinned in a release, holding one additive half of each ballot's opening so that a ballot opens only with both panels' thresholds ([[0027-trustee-panels-and-live-results]], Part 1; [[election-definition]], Author panel). It is an ordered list of `n_A` identity keys and a threshold `k_A`, with seats numbered as for a default panel, and its identifier is

```
author_panel_id = H(DS("abolish/v1/author-panel", u8(k_A) ‖ u8(n_A) ‖ Q_1 ‖ … ‖ Q_{n_A}))
```

under its own tag, so an author panel never has the identifier of a pinned default panel with the same keys and threshold, and a statement bound to one can't stand for the other (T-37). It is never stored: the verifier, the ballot client and every seat recompute it from the definition's `author_threshold` and `author_keys`. An author panel is valid only if (checked in this order, with these codes):

1. `n_A ≤ MAX_TRUSTEES` ([[parameters]]) (`size`);
2. `1 ≤ k_A ≤ n_A` (`threshold`). Unlike a default panel, `k_A = 1` is allowed: an author panel is never alone, since its half of a ballot's opening is worthless without the default half, so one author trustee holding a whole half lowers nothing (T-14);
3. for each seat in order, `Q_i` decodes as a `p256-key` (`key`) and differs from every earlier key (`duplicate-key`), for the reason a default panel's keys are distinct;
4. against the default panel the election names, no `Q_i` equals a default seat's key (`default-seat`). A key in both panels would let the default trustees holding it stand in for author trustees: with `k_A` such seats, `k` default trustees open ballots alone, so the author panel adds nothing against them while the author believes their own trustees are needed (T-14, T-37). Rules 1 to 3 need only the definition and are its `author-panel` well-formedness rule ([[election-definition]], Well-formedness); rule 4 needs the pinned default panel and is [[verifier]] 2.5's.

`docs/spec/vectors/election-definition-v6.json` (`authorPanels`) holds valid author panels with their identifiers and one failing each rule.

## Signed statements

Each statement type has its own tag under `abolish/v1/sig/` and a fixed layout. The layouts below are complete: `m` is exactly the concatenation shown, with no header or length prefix of its own, and its length is fixed.

### Ceremony registration

`abolish/v1/sig/ceremony-registration-2`: trustee `i` approves the outcome of a key ceremony for one election, and the key set it registers. The trustee registry on L2 records a ceremony transcript hash for a definition stub only with this signature from at least the panel's quorum `q` of its seats (`k ≤ q ≤ n`, fixed for each panel when the registry is deployed, and `q = max(k, n − 1)` in every deployment under [[0006-trustees]] rule 7; [[contracts]], Trustee registry), never on `msg.sender` alone (T-71, T-37). The count is of **distinct seats**: each `index` counts at most once, and only with a signature that verifies under that seat's pinned key. ECDSA lets one signer make any number of distinct valid signatures on one statement, so a contract or verifier that counted signatures would let one seat, or one stolen key, reach the quorum alone (T-14, T-37).

| Field                      | Type        | Meaning                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `l2_chain_id`              | `u64`       | EIP-155 chain ID of the L2 the trustee registry is on ([[0004-l2-choice]]). EIP-155 chain IDs are 256-bit; a registry on a chain whose ID doesn't fit `u64` MUST refuse every registration (Base's do fit).                                                                                                                          |
| `trustee_registry`         | `bytes[20]` | The registry's address.                                                                                                                                                                                                                                                                                                              |
| `panel_id`                 | `bytes[32]` | The panel the signer sits on (Panel identifier).                                                                                                                                                                                                                                                                                     |
| `index`                    | `u8`        | The signer's seat, `1 ≤ index ≤ n`.                                                                                                                                                                                                                                                                                                  |
| `stub_hash`                | `bytes[32]` | Hash of the election definition with its ceremony transcript hash zeroed (P1-10b), which fixes the election; under version 6 the default panel's, which keeps `author_transcript_hash`; an author panel's approval, under `author_panel_id`, signs `author_stub_hash` instead ([[election-definition]], Stub hash and the ceremony). |
| `ceremony_transcript_hash` | `bytes[32]` | Hash of the ceremony transcript the signer approves ([[ceremony]], Transcript).                                                                                                                                                                                                                                                      |
| `key_set_hash`             | `bytes[32]` | Hash of the registered key set the signer's own check of that transcript returned ([[ceremony]], Key set hash), never one supplied to it.                                                                                                                                                                                            |

`m` is 157 bytes. The chain ID and registry address let a contract check that a signature was made for it (`block.chainid`, `address(this)`) without decoding the stub. The panel and index stop a signature from counting for another seat or panel, and `stub_hash` binds the election, its definition and its `election_id`, so a registration can't be replayed for another election or another definition of the same one (T-37, T-34). `key_set_hash` makes the quorum that approves the transcript also approve which seats qualified and their keys, which the trustee registry records and the board takes signing keys and qualified seats from, since no contract can run the transcript check ([[0028-board-contract-checks]], 2B; T-37, T-14). A seat that signs a key set other than its own check's breaks [[ceremony]] (Approval and re-runs), and [[verifier]] 3.1 fails an election whose recorded set isn't the one its transcript gives. A verifier checks the registration signatures it finds on the board against the pinned panel; a missing or failing signature is attributed to no one.

The first layout, 125 bytes without `key_set_hash`, under `abolish/v1/sig/ceremony-registration`, was superseded before any trustee registry was deployed; that tag is retired, and its statements in `vectors/trustee.json` (`registrations`) are frozen and read by nothing.

Further statements are specified with their items: the ceremony's messages and the signing key's proof of possession in [[ceremony]]; a cell's opening of the tally in [[tally]] (Opening record); the summed-share message and the destruction statement in [[tally]] (Summed-share message, Destruction); the close statement in [[close]]; share receipts with P1-12; the Tier 2 key's round messages, registration signing key's proof of possession and approval in [[nullifier-key]], and their counterparts for a reshare of it in [[nullifier-reshare]].

## On chain

Contracts check signatures with the `P256VERIFY` precompile (RIP-7212 on Base since Fjord, EIP-7951 on Ethereum since Fusaka; address `0x100`), through OpenZeppelin's audited `P256` library. The precompile takes the digest, `r`, `s` and the key's uncompressed coordinates and doesn't apply the low-s rule. OpenZeppelin's `P256.verify` checks the ranges and low `s` before calling it; a contract MUST NOT call the precompile any other way, and checks `1 ≤ r < n` and `1 ≤ s ≤ (n − 1) / 2` itself as well, as defence in depth against a library change. It holds each pinned key as `(x, y)`, checked at deployment against the 33-byte encoding, and computes the digest `H(DS(tag, m))` itself from the decoded fields. The trustee registry does this ([[contracts]], Trustee registry).

## Security notes

- **P-256's parameters come from an unexplained seed** ([[0007-group-and-hash]]). No weakness is known, but an adversary holding an undisclosed break could forge `k` seats' ceremony entries and register KEM keys it holds ([[0012-trustee-identity-signatures]], option B). secp256k1, or requiring both a P-256 and a secp256k1 signature on ceremony-phase messages, would avoid this at the cost of custody choices or a second key per trustee; the ADR weighs them.
- **Not post-quantum.** A quantum adversary able to break P-256 during an election could forge a trustee's statements live. Forging after the fact changes nothing anchored at the time ([[board]]). A hybrid suite would be a new set of tags ([[0012-trustee-identity-signatures]], option D).
- **A stolen identity key speaks for its seat** in every election until a release unpins it. Keys belong in hardware ([[0006-trustees]], rule 6; T-37). Per-election keys limit what a stolen _per-election_ key can decrypt or sign to one election; a stolen _identity_ key can still register keys of the thief's choosing for every election that follows, so per-election keys don't contain it.
- **One key, one use, and the signer builds the message.** An identity key (and a per-election signing key) MUST be used for Abolish statements only, never shared with TLS, code signing, PIV authentication or another protocol, and the node that signs MUST build `m` from fields it has validated and compute `H(DS(tag, m))` itself. Hardware interfaces often sign a raw 32-byte digest; a node that signs a digest handed to it, or a key that another system can be made to sign with, yields valid Abolish statements for whoever chooses the digest, since the tag protects only parties that frame the message themselves.
- **Nonces.** A biased or repeated ECDSA nonce reveals `d`. RFC 6979, or an HSM's generator, is required. With a sound nonce, ECDSA is unforgeable under chosen-message attack, so signing hashes another party chose (such as `stub_hash`) is safe.

## Sources

- FIPS 186-5, Digital Signature Standard, §6 (ECDSA); SEC 1 v2, §2.3.3–2.3.4 (point compression), §4.1 (ECDSA); SEC 2 v2, §2.4.2 (secp256r1).
- RFC 6979, Deterministic Usage of DSA and ECDSA, §3.2 and Appendix A.2.5 (P-256 vectors); NIST CAVP ECDSA SigVer (FIPS 186-3), section `[P-256,SHA-256]`. Both are vendored in `packages/crypto/test-vectors/`.
- RIP-7212 and EIP-7951 (`P256VERIFY`).
