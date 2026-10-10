# Domain separation

Every hash in the protocol, including every Fiat–Shamir challenge, is computed under a registered tag, so an output computed for one purpose can never be valid for another (T-30, T-31, T-32, T-38). This page defines the tag grammar, how a tag is applied to each kind of hash, and the registry. Notation is from [[notation]].

## Tag grammar

A tag is an ASCII string:

```
tag     = "abolish/v" major "/" purpose
major   = "1"                           ; protocol major version, see [[versioning]]
purpose = segment *("/" segment)
segment = word *("-" word)
word    = 1*(%x61-7A / %x30-39)         ; a-z, 0-9
```

A tag is 12 to 255 bytes long (the shortest possible is `abolish/v1/` plus one character). Examples: `abolish/v1/display-text`, `abolish/v1/fs/ballot-validity/option`.

## Applying a tag

How the tag enters the hash depends on the primitive. In every case the tag is the exact registered string.

- **Plain hashes** (record hashes, hash-chain links, Merkle nodes, commitments to data): the hash input is

  ```
  DS(tag, m) = u8(len(tag)) ‖ tag ‖ m
  ```

  and the hash is `H(DS(tag, m))`. A section MAY name a different hash function for a tag (keccak-256 inside a contract, say); the registry then says so, and the `DS` framing still applies. Because the tag carries its own length, the set of prefixes `u8(len(tag)) ‖ tag` is prefix-free: two different tags can never produce the same input, whatever `m` is. Where `m` is a record, it is the record's full canonical encoding, header included ([[notation]]), so the record type and version are hashed too.

- **Fiat–Shamir challenges**: the challenge is derived from `H(DS(tag, t))`, where `t` is the canonical encoding of the whole statement and every prover commitment, laid out as a table in the proof's own section. That table MUST include, at minimum: the election-definition hash (which binds the poll ID, chain ID and contract addresses, [[0003-tally-scheme]]), or, for key-ceremony proofs made before the definition exists (keys are per election and the ceremony runs as it opens, [[0006-trustees]]), a ceremony context binding the chain ID, the registry contract address, the election identifier, the panel and an identifier unique to each run of the ceremony, so proofs from an aborted run don't verify in the next (P1-14 states the order of construction); every generator the spec doesn't fix as a constant; the public key or keys, every ciphertext or commitment the proof is about, every prover commitment; every value the proof asserts a relation about (a decryption or opening share, the allowed-value set, an approval limit; Bernhard, Pereira and Warinschi, ASIACRYPT 2012); for every proof carried in a ballot, the ballot's nullifier, so a ballot's proofs can't be copied into another voter's ballot (T-32; the attack on Helios in Cortier and Smyth, "Attacking and Fixing Helios", CSF 2011); and the proof's position: which option or the sum for ballot proofs, the trustee's index for ceremony and tally-share proofs. A proof whose table leaves out any part of its statement is a specification bug (T-30, "Frozen Heart"). How the hash output is reduced to a scalar without bias is specified by P1-11. A verifier takes every element of the statement (prover commitments excepted) from context it has already verified (the registered definition, pinned trust roots, the board), never from the object being checked.

- **Hash-to-curve** ([RFC 9380](https://www.rfc-editor.org/rfc/rfc9380)): the tag is the `DST` argument, unchanged. RFC 9380 applies its own length framing.

- **Key derivation and AEAD**: the tag is the KDF's `info` or label input, and an AEAD's associated data starts with `DS(tag, ·)`. The protocol section that uses them gives the exact layout.

- **In-circuit hashes** (Poseidon in Noir circuits): a tag is mapped to a field element by a rule P1-11 and P1-17 specify, and that rule is applied to the registered string, so the in-circuit and off-circuit tags can't diverge. Semaphore v4's own internal hashes keep Semaphore's definitions; Abolish's tags apply to what we derive around it (such as the nullifier scope).

- **External formats** that carry their own domain separation (EIP-712 signatures, Ethereum transaction and receipt hashes, Arweave and IPFS identifiers) are used as their standards define them, and aren't registered here.

## Rules

- Every hash input in the protocol uses exactly one registered tag, and every tag is used for exactly one input layout. Two purposes never share a tag, even when their layouts look alike.
- A tag is registered here, in the same PR that first uses it, with its input layout or a link to the section that defines it.
- A tag's string and input layout are **frozen** once any value hashed under it has been anchored on any chain, testnet included. A frozen tag is never reused, renamed or given a new layout: a new layout gets a new tag. Until then, the owning STATUS item may rename or re-scope a reserved tag, updating this registry in the same PR.
- A tag no longer used is marked retired, never deleted or reassigned.
- Implementations take tags from one constant table generated from, or checked against, this registry; a test in `packages/crypto` (P1-10) asserts the table matches it byte for byte, and that no tag is a duplicate.

## Registry

Status values: **specified** (input layout defined, link given), **reserved** (purpose fixed, layout to be specified by the owning item), **conditional** (needed only if the open ADR named goes one way).

| Tag                                    | Purpose                                                                                                                                                            | Primitive     | Owner  | Status                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------ | --------------------------------------------------------- |
| `abolish/v1/display-text`              | Salted commitment to an election's display text                                                                                                                    | Plain hash    | P1-8   | Specified ([[display-text]])                              |
| `abolish/v1/election-definition`       | Election-definition hash, registered on L2 and bound into every ballot and proof (T-34)                                                                            | Plain hash    | P1-10b | Reserved                                                  |
| `abolish/v1/board-entry`               | Board entry hash (T-23)                                                                                                                                            | Plain hash    | P1-16  | Reserved                                                  |
| `abolish/v1/board-chain`               | Hash-chain link over the previous link and the entry hash (T-23)                                                                                                   | Plain hash    | P1-16  | Reserved                                                  |
| `abolish/v1/merkle/leaf`               | Merkle leaf over a board entry (separate from nodes, against second-preimage attacks)                                                                              | Plain hash    | P1-16  | Reserved                                                  |
| `abolish/v1/merkle/node`               | Merkle interior node                                                                                                                                               | Plain hash    | P1-16  | Reserved                                                  |
| `abolish/v1/ballot`                    | Ballot hash, bound into the membership proof's signal (T-38)                                                                                                       | Plain hash    | P1-12  | Reserved                                                  |
| `abolish/v1/receipt`                   | Ballot receipt (T-26)                                                                                                                                              | Plain hash    | P1-13  | Reserved                                                  |
| `abolish/v1/nullifier-scope`           | Per-poll Semaphore scope, derived from the election-definition hash (T-12)                                                                                         | In-circuit    | P1-17  | Reserved                                                  |
| `abolish/v1/fs/ballot-validity/option` | Fiat–Shamir challenge of the per-option validity proof (T-28, T-30, T-32)                                                                                          | Fiat–Shamir   | P1-12  | Reserved                                                  |
| `abolish/v1/fs/ballot-validity/sum`    | Fiat–Shamir challenge of the sum or approval-range proof (T-28, T-30)                                                                                              | Fiat–Shamir   | P1-12  | Reserved                                                  |
| `abolish/v1/fs/ceremony/possession`    | Fiat–Shamir challenge of a trustee's proof of possession in the key ceremony (T-40); P1-14 adds one tag per further ceremony proof                                 | Fiat–Shamir   | P1-14  | Reserved                                                  |
| `abolish/v1/fs/tally-share`            | Fiat–Shamir challenge of a trustee's decryption-share proof (ElGamal) or opening-share proof (commitments); only one exists per election, by P1-3's outcome (T-29) | Fiat–Shamir   | P1-15  | Reserved                                                  |
| `abolish/v1/ceremony-transcript`       | Ceremony transcript hash, registered with trustee keys on L2 (T-37)                                                                                                | Plain hash    | P1-14  | Reserved                                                  |
| `abolish/v1/tally-transcript`          | Tally transcript hash (T-29)                                                                                                                                       | Plain hash    | P1-15  | Reserved                                                  |
| `abolish/v1/event-accumulator`         | Running hash of a contract's own events ([[0005-permanent-archive]], T-71)                                                                                         | Plain hash    | P1-18  | Reserved                                                  |
| `abolish/v1/generator-h`               | Second Pedersen generator `h`, with no known discrete log relative to `g` (T-15)                                                                                   | Hash-to-curve | P1-11  | Conditional on P1-3 adopting perfectly hiding commitments |
| `abolish/v1/kem/share`                 | Hybrid KEM combiner and AEAD for trustee shares                                                                                                                    | KDF and AEAD  | P1-12  | Conditional on P1-3 adopting perfectly hiding commitments |
