# Protocol parameters

Limits that apply across record types in protocol version 1. A record version may set a lower maximum for its own field, never a higher one. Raising a protocol-wide limit is a new record version of every record type it affects, with this page recording which versions use the new limit ([[versioning]]); lowering one before it is frozen is an ordinary spec change. Threats: T-52 (bounded input sizes, so flooding and hostile lengths stay cheap to reject), T-28 (ballot shape), T-50 (direct-submitted ballots must fit the L2's forced-deposit limits).

| Name                    | Value | Meaning                                                                                                      |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `MAX_TAG_LEN`           | 255   | Maximum length of a domain-separation tag in bytes ([[domain-separation]]); fixed by its `u8` length prefix. |
| `MAX_OPTIONS`           | 64    | Maximum number of options in one question of a plurality or approval election ([[0003-tally-scheme]]).       |
| `MAX_TRUSTEES`          | 16    | Maximum `n` of a trustee panel ([[0006-trustees]] proposes `n = 7`).                                         |
| `DISPLAY_TEXT_SALT_LEN` | 32    | Length of the salt in a display-text commitment ([[display-text]], [[0005-permanent-archive]]).              |

## Why these values

- **`MAX_OPTIONS`.** A plurality or approval ballot carries one ciphertext or commitment and one validity proof per option, plus a proof for the sum ([[0003-tally-scheme]]), so its size grows linearly with the option count. Under perfectly hiding commitments (P1-3, open), the open ADR estimates about 320 bytes of public data per option at k = 4, so 64 options is about 20 KB, plus per-trustee data. Most real contests have far fewer options; a civic contest with more candidates than this (the 2003 California recall had 135) would need a new record version with a higher limit, or a ranked-choice or multi-question design. P1-18 checks that a ballot at this limit fits a direct submission through the L2's forced-deposit path and its calldata cap ([[0004-l2-choice]]), and lowers the limit here if it doesn't, before anything is frozen.
- **`MAX_TRUSTEES`.** Bounds per-ballot and per-ceremony data that grows with `n` (per-trustee shares and receipts under P1-3's option B, per-trustee transcript entries under either option). Sixteen leaves room above the proposed panel of seven for a second panel or replacements without a new version.
- Questions per election, ballots per election, board entries per segment and the lengths of every variable-length field are set by the record tables that use them (P1-10 to P1-16), each within these limits.
