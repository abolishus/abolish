# Abolish protocol specification

This folder specifies everything a third party needs to write an independent verifier for Abolish elections in any language: the bytes, the hashes, the proofs and the checks. It is normative. Where the code in `packages/crypto` or `packages/verifier` disagrees with it, the code is wrong (T-36). See [[PROJECT_BRIEF]] for the requirements and [[THREAT_MODEL]] for the threat IDs cited throughout.

## Conformance

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in capitals.

A conforming verifier implements every check in [[verifier]] and decodes every record strictly as [[notation]] requires. A conforming encoder produces only the encodings this spec defines. There are no implementation-defined choices: if two conforming implementations can produce different bytes for the same value, or accept different sets of bytes, that is a bug in this spec (T-31).

## Documents

| Document                    | Defines                                                                                  | Status                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [[notation]]                | Notation, primitive types, record framing, strict decoding rules, decode error codes     | Specified                                                   |
| [[domain-separation]]       | Tag grammar, how a tag is applied to each kind of hash, the tag registry                 | Framing specified; most tags reserved for their owning item |
| [[versioning]]              | Protocol and record versions, the record-type registry, change rules, election profiles  | Specified                                                   |
| [[parameters]]              | Protocol-wide limits                                                                     | Specified for version 1; P1-18 may lower                    |
| [[display-text]]            | The split between display text and result-critical data, and the display-text commitment | Split and commitment specified; record layout is P1-10's    |
| [[content-addressing]]      | How board data becomes IPFS blocks, CIDs and CAR files                                   | Provisional until P4-3's vectors                            |
| [[verifier]]                | What a third-party verifier must check, stage by stage                                   | Checklist; each check is specified by its owning item       |
| [[vectors/README\|vectors]] | The test-vector file format (`docs/spec/vectors/*.json`)                                 | Specified                                                   |

Sections still to be written, by the STATUS item that owns them:

- Group, hash function and point/scalar codecs: P1-11.
- Record layouts (election definition, ballot, board entry and the rest of the record-type registry): P1-10, with each record's owning item.
- Ballot encryption or commitment and validity proofs: P1-12.
- Benaloh challenge/spoil, receipts and re-vote resolution: P1-13.
- Key ceremony and its transcript: P1-14.
- Decryption or opening shares and the tally transcript: P1-15.
- Bulletin board, hash chain, inclusion proofs and Merkle roots: P1-16.
- Membership and nullifier circuit: P1-17.
- Contracts, events and the close rule: P1-18.
- Verifier procedure and report format: P1-19 (extends [[verifier]]).

## Decisions this spec depends on

The spec follows the ADRs below. Several are still open (`needs-decision`) and are adopted by default 72 hours after they were opened unless the owner answers, as the brief allows. Until then, every section marked specified below is specified pending the ADRs it names, and changes if the owner picks another option.

- [[0001-canonical-encoding]] (open; adopted by default on 2026-10-12 06:15 UTC unless the owner answers): explicit byte layouts (option A). [[notation]], [[versioning]] and the vectors follow it.
- [[0003-tally-scheme]] (open; default 2026-10-12 20:01 UTC): homomorphic tally for plurality and approval, mixnet for ranked choice. Sets the option limit in [[parameters]] and the tally checks in [[verifier]].
- [[0004-l2-choice]] (open; default for testnet 2026-10-12 20:10 UTC): the L2, its close rule and finality. Shapes the timing and L2-evidence checks in [[verifier]].
- [[0005-permanent-archive]] (open; adopted by default on 2026-10-12 20:23 UTC unless the owner answers): the display-text split ([[display-text]]), the result-critical field rule ([[notation]]) and the CID parameters ([[content-addressing]]).
- [[0006-trustees]] (open; the owner decides, never defaulted): the panel bound into each election definition.
- The everlasting-privacy ADR (P1-3, `0002`, open): decides whether the board carries threshold ElGamal ciphertexts or perfectly hiding commitments. The ballot, ceremony and tally sections can't be written until it is accepted; [[verifier]] marks the checks it changes.

## Prior art

The layout style follows the ElectionGuard Design Specification 2.0 (Benaloh and Naehrig, Microsoft Research), which fixes the byte layout of every hash input. The verifier checklist draws on ElectionGuard's verification steps, Helios (Adida, USENIX Security 2008) and Belenios (Cortier, Gaudry and Glondu). Protocol sections cite their sources where they compose them.
