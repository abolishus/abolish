# Display text

An election has two kinds of data, kept apart so personal data never reaches permanent storage while every result stays verifiable ([[0005-permanent-archive]]). Threats: T-17 (PII on-chain or on IPFS), T-52 (a record's size), T-41 and T-34 (labels shown to a voter), T-68 (content that can't be moderated), T-51 and T-53 (text that is lost leaves a result verifiable but not interpretable), G-12.

## The split

- **Result-critical data**: everything a verifier needs to recompute and check a result. Election definitions, board entries, ceremony and tally transcripts, and our contracts' events. It is anchored, mirrored to IPFS and archived permanently. Its fields are fixed formats only, never free text ([[notation]], Result-critical fields).
- **Display text**: everything that exists only for people to read. The question, option labels, descriptions and their translations. It is stored in display-text records (record type `0x0009`, [[versioning]]), pinned on IPFS, and **never** written to the permanent archive, a chain or the board. It can be taken down (moderation acts on it, P2-10) without touching any result.

A result names its options by index. Only the display-text record says what option 3 meant.

## Commitment

The election definition binds its display text with a salted commitment:

```
display_text_commitment = H(DS("abolish/v1/display-text", encode(display_text_record)))
```

- The display-text record (record type `0x0009`) has `salt`, a `bytes[32]` (`DISPLAY_TEXT_SALT_LEN`, [[parameters]]), as its first field after the header, followed by the text fields. The salt is drawn from a CSPRNG when the definition is created, through `packages/crypto` (T-39), and is never reused across definitions.
- `encode(display_text_record)` is the record's full canonical encoding, header and salt included. The salt is hashed exactly once, as part of the record.
- The record, salt included, is the IPFS object that is pinned. The salt never appears in any result-critical record.
- The election definition carries only `display_text_commitment` (`bytes[32]`).

Why the salt: display text is often short and guessable, such as a candidate's name or a yes/no question. Without a salt, anyone holding the permanent record could confirm a guess by hashing it, so the archive would keep the text in effect even after it was taken down. With a 32-byte random salt, confirming a guess means also guessing the salt, which takes about 2²⁵⁶ hash evaluations, or about 2¹²⁸ with a quantum search (G-12, A-11). This hiding is computational, resting on `H` behaving as a random oracle; it isn't perfect hiding. The salt isn't a secret from anyone who has the text: whoever holds both can prove to anyone what each option meant.

## Layout (version 1)

Record type `0x0009`, version 1, frozen by its vectors ([[versioning]], Frozen).

| Field          | Type                    | Meaning                                                                                     |
| -------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `salt`         | `bytes[32]`             | The commitment's salt (above). Always the first field.                                      |
| `translations` | `list<translation, 32>` | The text in each language it is offered in, in strictly ascending byte order of `language`. |

`translation`:

| Field         | Type                    | Meaning                                                                                                                                                          |
| ------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `language`    | `utf8<35>`              | A [BCP 47](https://www.rfc-editor.org/info/bcp47) language tag in lowercase, such as `en` or `es-419`: 1 to 35 bytes of lowercase ASCII letters, digits and `-`. |
| `question`    | `utf8<1024>`            | The question.                                                                                                                                                    |
| `description` | `utf8<8192>`            | Longer text about the question. May be empty.                                                                                                                    |
| `options`     | `list<option_text, 64>` | One entry per option, in option index order.                                                                                                                     |

`option_text`:

| Field         | Type         | Meaning                             |
| ------------- | ------------ | ----------------------------------- |
| `label`       | `utf8<512>`  | The option's label.                 |
| `description` | `utf8<1024>` | Longer text about it. May be empty. |

The maxima bound a record at about 3.5 MB (32 languages of 64 options at every maximum), so a hostile record is cheap to reject (T-52). Text is compared and hashed as its exact bytes, never normalised ([[notation]]). Its translations are equal in standing: a voter-facing client shows the one the voter picks, and none is the authoritative one. Nothing checks that translations agree with each other. Two translations, or two near-identical tags such as `en` and `en-us`, can give an option different meanings, and each voter sees only the one they pick. The commitment makes such a record public and permanent evidence against whoever published it, but doesn't prevent it (T-41, T-34). A client MUST show the voter which translation they are reading, and the cast-confirmation screen and any challenge checker MUST show the chosen option's label in every translation, so a swapped translation shows up next to the others. Display text isn't archived, so a divergent record stays evidence only while someone keeps a copy.

A display-text record is well formed, for the definition it is checked against, when:

| Code           | Rule                                                                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commitment`   | `H(DS("abolish/v1/display-text", encode(record)))` equals the definition's `display_text_commitment`.                                                                                                                                                                                                                          |
| `translations` | `translations` is non-empty and in strictly ascending byte order of `language`, so no language appears twice.                                                                                                                                                                                                                  |
| `language-tag` | Every `language` is 1 to 35 bytes, each a lowercase ASCII letter, a digit or `-`. Lowercase only, so `en` and `EN` can't both appear (BCP 47 tags are case-insensitive).                                                                                                                                                       |
| `option-count` | Every translation has exactly the definition's `option_count` options.                                                                                                                                                                                                                                                         |
| `question`     | Every `question` and every option `label` is non-empty.                                                                                                                                                                                                                                                                        |
| `labels`       | Within each translation, no two options have the same `label`. Text isn't normalised, so this catches exact repeats only: `Yes` and `Yes` followed by an invisible character are different bytes that render alike. Like divergent translations, such a record is public evidence against its publisher, not prevented (T-41). |

The record is pinned by the election's profile like any other ([[versioning]]): a decoder that knows the election reads it against the pinned version. Vectors: `docs/spec/vectors/display-text.json`.

## Layout (version 2)

Record type `0x0009`, version 2, for definition version 5's questions ([[election-definition]], Layout (version 5); [[0026-multi-question-ballots]]), frozen by its vectors. The commitment is unchanged: the same tag over the record's full encoding, whose header's version byte keeps the two versions apart. A profile pins display-text version 2 with definition versions 5, 6 and 7 only, and those definition versions pin it only ([[verifier]] 2.3, `profile-combination`).

| Field          | Type                       | Meaning                                                                                     |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `salt`         | `bytes[32]`                | The commitment's salt, as version 1. Always the first field.                                |
| `translations` | `list<translation_v2, 32>` | The text in each language it is offered in, in strictly ascending byte order of `language`. |

`translation_v2`:

| Field         | Type                                 | Meaning                                                                       |
| ------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| `language`    | `utf8<35>`                           | A BCP 47 language tag in lowercase, as version 1.                             |
| `title`       | `utf8<1024>`                         | The poll's title.                                                             |
| `description` | `utf8<8192>`                         | Longer text about the poll. May be empty.                                     |
| `questions`   | `list<question_text, MAX_QUESTIONS>` | One entry per question of the definition, in question order ([[parameters]]). |

`question_text`:

| Field         | Type                             | Meaning                                                                                  |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| `question`    | `utf8<1024>`                     | The question.                                                                            |
| `description` | `utf8<8192>`                     | Longer text about it. May be empty.                                                      |
| `options`     | `list<option_text, MAX_OPTIONS>` | One entry per option of the question, in option index order (version 1's `option_text`). |

**Size.** By its list maxima a version-2 record could exceed 100 MB, so version 2 caps the whole record: an input longer than `MAX_DISPLAY_TEXT` bytes ([[parameters]]) is rejected with `length-over-max` before its header is read, whenever version 2 is the pinned version, so a hostile record stays cheap to reject (T-52). The cap is on the record's encoding, header and salt included; version 1's worst case, about 3.5 MB, is under it. A record within the cap decodes strictly as version 1's rules say ([[notation]]). The cap is also the creator's: no definition may commit to a version-2 record over it, and `packages/crypto`'s builder refuses to make one ([[P2-14]] part 2; P2-9's creation screens use it), since the registry can't see the text and a ballot client refuses to show it, so such a poll would register and could never be voted on through our client (T-53).

Everything version 1 says about translations applies per question: they are equal in standing, nothing checks that they agree, and a client MUST show the voter which translation they are reading. The cast-confirmation screen and any challenge checker MUST show, for every question, the chosen options' labels in every translation, so a swapped label or a swapped question on any of them shows up next to the others (T-41, T-34).

A version-2 record is well formed, for the definition it is checked against, when, in this order:

| Code             | Rule                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commitment`     | As version 1.                                                                                                                                                                                                                |
| `translations`   | As version 1.                                                                                                                                                                                                                |
| `language-tag`   | As version 1.                                                                                                                                                                                                                |
| `question-count` | Every translation has exactly as many questions as the definition's `questions`.                                                                                                                                             |
| `option-count`   | In every translation, question `q` has exactly the definition's `m_q` options.                                                                                                                                               |
| `question`       | Every `title`, every `question` and every option `label` is non-empty.                                                                                                                                                       |
| `labels`         | Within each question of each translation, no two options have the same `label`. Labels may repeat across questions (Yes and No under each), since a label is always shown with its question. Exact bytes only, as version 1. |
| `question-texts` | Within each translation, no two questions have the same `question`, so a voter can always tell which question an answer belongs to. Exact bytes only.                                                                        |

Vectors: `docs/spec/vectors/display-text-v2.json`, which also gives `MAX_DISPLAY_TEXT` as `maxDisplayText`; a consumer checks the cap with an input it builds one byte over it, since a vector that large would be most of the file.

## Checks

A verifier ([[verifier]]):

- MUST verify every result without the display text. Missing display text is reported (the result is then verifiable but not interpretable, T-53), never a verification failure.
- MUST, when it has a display-text record, recompute the commitment and reject the text if it doesn't match the election definition, so a forged text can't relabel the options of a verified result.
- MUST check that the display-text record names exactly as many options per question as the election definition has, and under version 2 exactly as many questions.

Software that shows an election to a voter (the ballot client, and anything that labels a Benaloh opening, such as a challenge checker):

- MUST recompute the commitment from the display-text record it shows, compare it with the commitment in the election definition whose hash is registered on L2, and check that the record is well formed for the definition (under version 2, exactly the definition's questions, each with exactly its options). On any mismatch it MUST refuse to show the ballot or label the opening. Otherwise whoever serves the text could swap option labels for one voter: the client would honestly encrypt the index the voter picked under a false label, and a challenge labelled from the same text would not catch it (T-34, T-41, G-6). A version-7 definition's questions are read as version 5's, under its own hash and well-formedness rules (so its electorate under its mode, and a rolling poll only if it is everyday); showing an election this way never implies a client can cast in it, and a client that can't build the ballot version the profile pins refuses that separately ([[election-definition]], Layout (version 7); [[P2-17]]).

## Owned elsewhere

- Where the record is pinned and how it is found from the election definition: P4-3.
- What may be taken down, and by whom: the moderation policy (P2-10).
