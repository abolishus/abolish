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
| [[group]]                   | The group (ristretto255), `scalar` and `element` codecs, `H`, hash-to-scalar and `h`     | Specified                                                   |
| [[versioning]]              | Protocol and record versions, the record-type registry, change rules, election profiles  | Specified                                                   |
| [[parameters]]              | Protocol-wide limits                                                                     | Specified for version 1; P1-18 may lower                    |
| [[display-text]]            | The split between display text and result-critical data, and the display-text commitment | Split and commitment specified; record layout is P1-10b's   |
| [[content-addressing]]      | How board data becomes IPFS blocks, CIDs and CAR files                                   | Provisional until P4-3's vectors                            |
| [[verifier]]                | What a third-party verifier must check, stage by stage                                   | Checklist; each check is specified by its owning item       |
| [[vectors/README\|vectors]] | The test-vector file format (`docs/spec/vectors/*.json`)                                 | Specified                                                   |

Sections still to be written, by the STATUS item that owns them:

- Record layouts: the election definition and display text by P1-10b, the rest of the record-type registry by each record's owning item. The primitive codecs, record framing and `DS` framing they build on are implemented in `packages/crypto` (P1-10).
- Ballot encryption or commitment and validity proofs: P1-12.
- Benaloh challenge/spoil, receipts and re-vote resolution: P1-13.
- Key ceremony and its transcript: P1-14.
- Decryption or opening shares and the tally transcript: P1-15.
- Bulletin board, hash chain, inclusion proofs and Merkle roots: P1-16.
- Membership and nullifier circuit: P1-17.
- Contracts, events and the close rule: P1-18.
- Verifier procedure and report format: P1-19 (extends [[verifier]]).

## Decisions this spec depends on

The spec follows the ADRs below. Under rule A (`AGENTS.md`) the agent's choices are accepted and stand unless the owner vetoes them; a section marked specified below changes if the owner vetoes an ADR it names.

- [[0001-canonical-encoding]] (accepted by the agent, owner may veto): explicit byte layouts (option A). [[notation]], [[versioning]] and the vectors follow it.
- [[0003-tally-scheme]] (accepted by the agent, owner may veto): homomorphic tally for plurality and approval, commitment-consistent mixnet for ranked choice (per [[0002-everlasting-privacy]]). Sets the option limit in [[parameters]] and the tally checks in [[verifier]].
- [[0004-l2-choice]] (accepted by the agent for development and testnet, owner may veto; mainnet waits for the owner): the L2, its close rule and finality. Shapes the timing and L2-evidence checks in [[verifier]].
- [[0005-permanent-archive]] (accepted by the agent, owner may veto; the first real upload waits for the owner): the display-text split ([[display-text]]), the result-critical field rule ([[notation]]) and the CID parameters ([[content-addressing]]).
- [[0007-group-and-hash]] (accepted by the owner on 2026-10-10: option A): ristretto255, SHA-256 as `H`, RFC 9380 `hash_to_ristretto255` and RFC 9497 `HashToScalar`. [[group]] follows it.
- [[0006-trustees]] (open; owner-only: the owner decides): the panel bound into each election definition.
- [[0002-everlasting-privacy]] (accepted by the owner on 2026-10-10: option B, perfectly hiding commitments on the board; three owner questions in its Decision section still block ballot encryption (P1-12) and, through trustee duties and the election-key wording, the ceremony): the ballot, ceremony and tally sections follow it once written; [[verifier]] marks the checks it changes.

## Prior art

The layout style follows the ElectionGuard Design Specification 2.0 (Benaloh and Naehrig, Microsoft Research), which fixes the byte layout of every hash input. The verifier checklist draws on ElectionGuard's verification steps, Helios (Adida, USENIX Security 2008) and Belenios (Cortier, Gaudry and Glondu). Protocol sections cite their sources where they compose them.
