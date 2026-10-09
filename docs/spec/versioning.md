# Versioning

Anchored data is permanent, so the protocol can only grow: a new version never changes how an existing one decodes or verifies, or every past election would stop verifying ([[0001-canonical-encoding]]). Threats: T-31 (two readings of one record), T-34 (an election's rules changing after it opens), T-36 (third-party verifiers must know exactly which rules apply).

## Three levels

1. **Protocol major version.** The `v1` in every tag ([[domain-separation]]). Record-type numbers and record versions are global across major versions: a `(record_type, version)` pair means the same layout under every major, and a new major never reuses one. A new major version is a new tag namespace, used only for a break that touches the whole protocol (a new group, say, which is itself an ADR). Elections under `v1` verify under `v1` rules forever, and a verifier supports every major version it has ever supported.
2. **Record version.** The `version` byte in each record header ([[notation]]), per record type, starting at 1. A different shape, a new field, a removed field, a different maximum or different semantics for the same bytes is a new version. Versions are never edited after they are frozen.
3. **Election profile.** Each election definition names the protocol major version and the exact version of every record type used in that election. A proof's layout and verification rule, and the tally rule, are part of the version of the record that carries them, so pinning record versions pins them too. Every record in the election MUST use the version its profile pins; a verifier rejects any other (`profile-mismatch`), even one it could decode. Without this, whoever runs the board could mix an older record version with weaker rules into a newer election (a downgrade, T-31, T-34). The profile is fixed when the definition's hash is registered on L2 and can't change after.

## Change rules

- **Frozen.** A record version's layout, and the meaning of every field in it, is frozen once any record of that version has been anchored on any chain, testnet included, or included in a published vector file. A tag freezes the same way ([[domain-separation]]). Until then, its owning STATUS item may change it in place, updating its vectors in the same PR.
- **Append-only.** New record types take the next free number in the registry below. New versions take the next free version number of their type. Numbers are never reused, including those of retired types and versions.
- **Reject the unknown.** Decoders reject unknown record types and unknown versions. They never fall back to a nearby version or skip a record they don't understand ([[notation]]).
- **Old versions stay verifiable.** An encoder may stop producing a version, which is then retired: marked so in the registry, and still decoded and verified by every verifier, for as long as any election that used it exists. Retirement records a cutoff (an L1 block). An election definition registered on L2 after the cutoff that pins a retired version fails verification ([[verifier]] check 2.3), so whoever creates an election can't downgrade a whole new election to old rules. A version retired because it was found unsound is reported as such for every election that used it (T-31, T-34).
- **Spec and vectors move together.** A PR that adds or changes a layout updates its section here, its tags and its vectors (`docs/spec/vectors/`) together. A frozen vector is never edited or removed; new vectors are added alongside it.
- **One-way doors.** Changing a frozen encoding is impossible by these rules. Anything that would need it (a new group, hash or proof system; a change to what the board makes public) needs an ADR first (`crypto-review` skill, red flags).

## Record-type registry

`record_type` values are `u16`. Each entry names the STATUS item that specifies its layout. A reserved entry has no layout yet; its owning item defines version 1. This table is the only place record-type numbers are assigned.

| `record_type`     | Name                   | Contents                                                                                                                                            | Owner        | Status             |
| ----------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------ |
| `0x0000`          | none                   | Never valid. A decoder that reads it rejects with `unknown-record-type`.                                                                            |              | Invalid            |
| `0x0001`          | election definition    | Options, election type and tally scheme, profile, electorate (group roots), panel, timing, chain ID and contract addresses, display-text commitment | P1-10        | Reserved           |
| `0x0002`          | ballot                 | Encrypted or committed vote, validity proofs, nullifier, membership proof and re-vote sequence number                                               | P1-12, P1-13 | Reserved           |
| `0x0003`          | spoiled-ballot opening | Benaloh challenge opening of a spoiled ballot                                                                                                       | P1-13        | Reserved           |
| `0x0004`          | receipt                | What the voter keeps to check inclusion                                                                                                             | P1-13        | Reserved           |
| `0x0005`          | ceremony transcript    | The key ceremony's public transcript                                                                                                                | P1-14        | Reserved           |
| `0x0006`          | tally transcript       | Aggregates, decryption or opening shares with proofs, and the result                                                                                | P1-15        | Reserved           |
| `0x0007`          | board entry            | The envelope that places any record on the board, with its hash-chain link                                                                          | P1-16        | Reserved           |
| `0x0008`          | contract event         | A record of one of our contracts' L2 events with its inclusion evidence ([[0005-permanent-archive]])                                                | P1-16, P1-18 | Reserved           |
| `0x0009`          | display text           | An election's human-readable text, with its salt as the first field ([[display-text]]); never archived                                              | P1-10        | Reserved           |
| `0xff00`–`0xffff` | test                   | Used only by vector files to exercise framing. Production decoders reject them (`unknown-record-type`).                                             | P1-8         | Reserved for tests |
