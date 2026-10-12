# Abolish protocol specification

This folder specifies everything a third party needs to write an independent verifier for Abolish elections in any language: the bytes, the hashes, the proofs and the checks. It is normative. Where the code in `packages/crypto` or `packages/verifier` disagrees with it, the code is wrong (T-36). See [[PROJECT_BRIEF]] for the requirements and [[THREAT_MODEL]] for the threat IDs cited throughout.

## Conformance

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in capitals.

A conforming verifier implements every check in [[verifier]] and decodes every record strictly as [[notation]] requires. A conforming encoder produces only the encodings this spec defines. There are no implementation-defined choices: if two conforming implementations can produce different bytes for the same value, or accept different sets of bytes, that is a bug in this spec (T-31).

## Documents

| Document                    | Defines                                                                                                                                 | Status                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [[notation]]                | Notation, primitive types, record framing, strict decoding rules, decode error codes                                                    | Specified                                                                                                                                                            |
| [[domain-separation]]       | Tag grammar, how a tag is applied to each kind of hash, the tag registry                                                                | Framing specified; most tags reserved for their owning item                                                                                                          |
| [[group]]                   | The group (ristretto255), `scalar` and `element` codecs, `H`, hash-to-scalar and `h`                                                    | Specified                                                                                                                                                            |
| [[board]]                   | The board-entry envelope, the board tree, inclusion and consistency proofs, segments, checkpoints and board checks                      | Specified; anchoring is P4-1's                                                                                                                                       |
| [[versioning]]              | Protocol and record versions, the record-type registry, change rules, election profiles                                                 | Specified                                                                                                                                                            |
| [[parameters]]              | Protocol-wide limits                                                                                                                    | Specified for version 1; P1-18 may lower                                                                                                                             |
| [[contracts]]               | The event accumulator every Abolish contract keeps over its own events                                                                  | Event accumulator, election and trustee registries and the board anchor specified; the group registry, direct submit, contract events and the close rule are P1-18's |
| [[display-text]]            | The split between display text and result-critical data, the commitment and the record                                                  | Specified                                                                                                                                                            |
| [[membership]]              | The membership statement (Semaphore v4), the nullifier scope, the field mapping, tree depth and membership checks                       | Specified; verification keys and Groth16 verification are P1-17b's                                                                                                   |
| [[election-definition]]     | The election definition record, its hash, decoding against its own profile, well-formedness                                             | Version 1 specified                                                                                                                                                  |
| [[revoting]]                | The re-vote rule: the membership message, the L1 reference admission checks and the selection of the counted ballot                     | Specified; the ballot record that carries it is P1-12's                                                                                                              |
| [[receipts]]                | The receipt record, its signed statement and the check at cast                                                                          | Specified; the later checks are P1-13b's                                                                                                                             |
| [[ballot-validity]]         | Ballot commitments, Pedersen VSS shares and the trustees' share check, the statement hash and the validity proofs                       | Specified; the ballot record is P1-12's part 3                                                                                                                       |
| [[share-encryption]]        | Share encryption: the hybrid KEM (ML-KEM-768 with DH in ristretto255), the ciphertext and its hash, decryption, postings and complaints | Specified; key registration is [[ceremony]]'s, the board records P1-12 part 3's                                                                                      |
| [[tally]]                   | The homomorphic tally: cell aggregates, trustees' summed shares and their check, the combination, the opening record and its checks     | Specified; the summed-share message and destruction are P1-15's parts 2b and 3                                                                                       |
| [[trustee-identity]]        | Trustee identity keys and signatures (ECDSA P-256), the panel identifier and the ceremony-registration statement                        | Specified; the ceremony transcript and key possession are in [[ceremony]]                                                                                            |
| [[ceremony]]                | The key ceremony: rounds, possession proofs and challenges, the transcript record and its check, the registered key set                 | Version 1 specified                                                                                                                                                  |
| [[content-addressing]]      | How board data becomes IPFS blocks, CIDs and CAR files                                                                                  | Provisional until P4-3's vectors                                                                                                                                     |
| [[verifier]]                | What a third-party verifier must check, stage by stage                                                                                  | Checklist; each check is specified by its owning item                                                                                                                |
| [[vectors/README\|vectors]] | The test-vector file format (`docs/spec/vectors/*.json`)                                                                                | Specified                                                                                                                                                            |

Sections still to be written, by the STATUS item that owns them:

- Record layouts: the rest of the record-type registry, by each record's owning item. The election definition and display text are specified (P1-10b).
- The ballot record, and receipts, postings and complaints as board records: P1-12 part 3 ([[ballot-validity]] has the commitments and validity proofs, [[share-encryption]] the share KEM and its checks).
- Benaloh challenge/spoil: P1-13 (re-vote resolution is in [[revoting]], receipts in [[receipts]]; their later checks are P1-13b's).
- The tally transcript and destruction statements: P1-15, parts 2 and 3 ([[tally]] has the summed shares and openings).
- Membership verification keys, proof encoding and Groth16 verification: P1-17b.
- Contracts, events and the close rule: P1-18 ([[contracts]] has the event accumulator, the election and trustee registries and the board anchor so far).
- Verifier procedure and report format: P1-19 (extends [[verifier]]).

## Decisions this spec depends on

The spec follows the ADRs below. Under rule A (`AGENTS.md`) the agent's choices are accepted and stand unless the owner vetoes them; a section marked specified below changes if the owner vetoes an ADR it names.

- [[0001-canonical-encoding]] (accepted by the agent, owner may veto): explicit byte layouts (option A). [[notation]], [[versioning]] and the vectors follow it.
- [[0003-tally-scheme]] (accepted by the agent, owner may veto): homomorphic tally for plurality and approval, commitment-consistent mixnet for ranked choice (per [[0002-everlasting-privacy]]). Sets the option limit in [[parameters]] and the tally checks in [[verifier]].
- [[0004-l2-choice]] (accepted by the agent for development and testnet, owner may veto; mainnet waits for the owner): the L2, its close rule and finality. Shapes the timing and L2-evidence checks in [[verifier]].
- [[0005-permanent-archive]] (accepted by the agent, owner may veto; the first real upload waits for the owner): the display-text split ([[display-text]]), the result-critical field rule ([[notation]]) and the CID parameters ([[content-addressing]]).
- [[0007-group-and-hash]] (accepted by the owner on 2026-10-10: option A): ristretto255, SHA-256 as `H`, RFC 9380 `hash_to_ristretto255` and RFC 9497 `HashToScalar`. [[group]] follows it.
- [[0009-membership-proof]] (accepted by the agent, owner may veto): Semaphore v4's circuit and Groth16 proofs for membership, with a per-poll, per-tier-group scope. [[membership]] follows it.
- [[0011-revote-rule]] (accepted by the agent, owner may veto): the newest L1 block reference counts, and exact ties count nothing. [[revoting]] follows it.
- [[0012-trustee-identity-signatures]] (accepted by the agent, owner may veto): trustee identity keys and signatures are ECDSA over P-256 with SHA-256, low-s, checkable on chain through `P256VERIFY`. [[trustee-identity]] follows it.
- [[0013-ballot-receipts]] (accepted by the agent, owner may veto): a receipt is the operator's signature, under the trustee suite, on the board it showed with the voter's entry last, plus the entry's audit path. [[receipts]] follows it; the later checks are P1-13b's.
- [[0006-trustees]] (open; owner-only: the owner decides): the panel bound into each election definition.
- [[0002-everlasting-privacy]] (accepted by the owner on 2026-10-10: option B, perfectly hiding commitments on the board; three owner questions in its Decision section still block ballot encryption (P1-12) and, through trustee duties and the election-key wording, the ceremony and the tally with its destruction step (P1-15)): the ballot, ceremony and tally sections follow it once written; [[verifier]] marks the checks it changes.

## Prior art

The layout style follows the ElectionGuard Design Specification 2.0 (Benaloh and Naehrig, Microsoft Research), which fixes the byte layout of every hash input. The verifier checklist draws on ElectionGuard's verification steps, Helios (Adida, USENIX Security 2008) and Belenios (Cortier, Gaudry and Glondu). Protocol sections cite their sources where they compose them.
