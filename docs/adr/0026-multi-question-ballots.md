# ADR 0026: Multi-question ballots

- Status: Accepted (owner, 2026-10-12): option B
- Date: 2026-10-12
- Deciders: owner (several questions on one ballot, cast once, tallied per question and never cross-tabulated: option B, 2026-10-12); agent, owner may veto (rule A), for the design within it: the flat option vector, the limits and the rest of Decision
- Threats addressed: T-28, T-30, T-31, T-32, T-34, T-41, T-42, T-44, T-45, T-47, T-12, T-13, T-16, T-14, T-17, T-52, T-29, T-36, T-39, T-54, T-70 (see [[THREAT_MODEL]])

## Context

On 2026-10-12 the owner added to the brief ([[PROJECT_BRIEF]], Election types): a poll can ask several questions on one ballot, cast once with one receipt, each question with its own method (pick one, pick any, pick up to N, pick exactly N, and later ranked choice); each question is tallied on its own, and answers are never cross-tabulated, since that would mean decrypting individual ballots. The owner also fixed the shape: one eligibility proof, so one nullifier per poll (per tier or cell, as today), one receipt, and one ballot.

Today an election asks exactly one question. Definition versions 1, 3 and 4 carry one `option_count`, `min_selections` and `max_selections` and an `election_type` of plurality or approval ([[election-definition]]); the display-text record has one `question` per translation ([[display-text]]); a ballot carries one 0/1 commitment and option proof per option and one sum proof over all of them ([[ballot-validity]]); the tally opens one aggregate per cell and option ([[tally]]). [[parameters]] already names a multi-question design as one way past `MAX_OPTIONS`.

What the owner left open, and this ADR decides under rule A: how several questions are laid out in the definition, the display text, the ballot and the tally; the limits on questions and options; and which checks change. What is one-way: the new definition, display-text and ballot layouts and the new Fiat–Shamir tag are frozen by their vectors once anything under them is anchored, testnet included ([[versioning]]), and every pinned ballot client and verifier implements them. And, by the owner's decision rather than by encoding: a poll tallied this way can never be cross-tabulated later, since no individual ballot is ever opened (Decision, No cross-tabulation).

## Options

### A. A poll as a bundle of single-question elections

Each question is its own election: its own definition, ceremony, board, nullifier scope, ballots, receipts and tally. The client casts one ballot per question. No protocol change.

- **Pros:** nothing new to specify, implement or verify; each question can use any version already supported.
- **Cons:**
  - **Q of everything.** Q definitions and ceremonies (a transcript is valid for exactly one definition, [[election-definition]], Stub hash and the ceremony), Q membership proofs to compute (Groth16 proving, seconds each on a phone), Q nullifiers, Q receipts to keep and check, Q tracking codes to challenge, Q tallies whose trustees must each be live (T-54). It contradicts the owner's "cast once with one receipt".
  - **Timing links the questions.** Each ballot's L1 reference fixes when it was made to about 12 seconds ([[revoting]], Residuals), so Q ballots cast together are publicly linked as one voter's, though their nullifiers are unrelated, which is participation linkage across the bundle (T-12, T-13; [[revoting]], Client rule 7). Casting them at independent times, as the client does for tiers, makes one poll take minutes and still leaks to anyone watching a small poll's board.
  - **Re-voting per question.** A coerced voter must re-vote and escape each question separately, and a coercer can freeze one of them while the voter fixes the others (T-45).
  - **Differencing across questions.** Each election has its own partition, so a creator can give the questions slightly different remainder cells and subtract results ([[0019-regional-cells]], Consequences: several elections can still difference a region; T-16).

### B. Several questions in one definition, as one flat option vector

One definition lists the questions, each with its own method, option count and selection limits. The ballot is today's committed vote over the options of every question in turn (question-major order), with today's 0/1 option proof per option and, instead of one sum proof, one range proof per question over the product of that question's commitments. Shares, share ciphertexts, delivery, summed shares and the tally opening keep their per-option form over all options. One nullifier, one membership proof, one ballot, one receipt.

- **Pros:**
  - The owner's shape exactly: cast once, one proof of eligibility, one receipt, one tracking code, one re-vote rule over the whole ballot.
  - **Per-option machinery unchanged.** VSS commitments, option proofs, shares, share ciphertexts, the delivery records, summed shares and openings already work over a list of options and are blind to where one question ends. Capping the options of all questions together at `MAX_OPTIONS` keeps every size bound and record layout of those (Decision, Limits), so the new layouts are the definition, the display text, the ballot's sum proofs and the spoiled-ballot opening's core version, and no new primitive (T-39, T-36).
  - **Per-question counts come for free.** The opening of a cell already gives each option's count; a question's result is its slice. Nothing is opened that the single-question tally doesn't open, and nothing joint.
- **Cons:**
  - All questions share one budget of 64 options; a civic ballot with many contests needs a higher `MAX_OPTIONS`, a new version of every per-option record (Decision, What remains open). Option C doesn't avoid that (below).
  - A ranked-choice question doesn't fit a 0/1 vector; it will be a separate part of the ballot (Decision, Ranked choice).

### C. Several questions in one definition, one committed vote per question (nested)

As B, but the committed vote, the shares and the tally opening are lists per question, each question's part exactly today's single-question committed vote, opened per cell and per question.

- **Pros:** each question's part is literally today's structure; a ranked question would be one more kind of part.
- **Cons:**
  - Every per-option record changes shape: share plaintexts and ciphertexts, postings, summed-share messages, the tally opening and the spoiled-ballot opening become nested lists, so new versions of all of them, with their vectors and checks, for the same values B carries flat (T-31, T-36).
  - It doesn't lift the option budget. One ciphertext per seat carries every question's shares, so a seat's plaintext still grows with the total number of options, and a total above 64 needs the same new share-encryption and delivery versions as under B.
  - Q opening records per cell, each with its own header, signature and `aggregate_hash`, where B has one.

### D. One combined question over every combination of answers

The joint answer is one question whose options are the combinations (Q1 yes and Q2 yes, Q1 yes and Q2 no, …), tallied as one plurality question.

- **Pros:** the only design that gives a cross-tabulation without opening individual ballots, and the voter sees exactly what is counted.
- **Cons:** options multiply (three yes/no questions are 8 options, six are 64), and the result shows every combination's count per cell, so a rare combination in a small cell identifies its voter, as the pattern attack does (T-16, T-70). It is what the owner ruled out. A creator who wants a joint breakdown of two questions can still ask it this way, as one question the voter sees, under B.

## Recommendation

**B**, which the owner chose. Within it the agent chose the flat vector over C because it reaches the owner's shape with the fewest new layouts and the same verifier, and the option budget C seemed to lift is bounded the same way under both. A loses on every count the owner named. D is the owner's excluded cross-tabulation and stays available only as an ordinary single question.

What would change it: a ranked-choice design (the mixnet ADR of [[0003-tally-scheme]]) whose ballot part can't sit beside a flat vector; or civic ballots far above 64 options in total (P5-1), which would raise `MAX_OPTIONS` under either encoding.

## Consequences

- **[[P2-14]]** specifies and builds it, in the parts its file lists: the spec and vectors first, then `packages/crypto`, the tally, the verifier, contracts, `packages/core` and the API, the ballot client and `apps/web`.
- **Older polls are untouched.** Definition versions 1, 3 and 4 and ballot versions 1 and 2 keep their meaning and keep verifying; a single-question poll under version 5 is its one-question case.
- **Known-weak:**
  - **Small cells reveal whole ballots.** A cell with one counted ballot, or where every ballot gave the same answers, shows every answer of those voters, all questions at once; the joint answer of a cell of one is exposed, as T-16 already says for one question. [[verifier]] 8.2's per-cell flag is unchanged.
  - **A question that forbids a blank can't be skipped.** Under pick exactly N (`min = max = N`), a voter who wants to abstain on that question can only abstain from the whole poll (What remains open).
  - **Blank counts per question are known only where `max_selections = 1`** (the cell's counted ballots less the question's selections); for other questions the number who left it blank isn't derivable.
  - **Every live release opens every question.** Live results ([[P2-15]]) release all questions' counts per cell at each interval; the minimum batch protects each question's difference as it does one question's, and no release is joint.
  - **Author trustees multiply per-seat data.** A ballot's shares go to every seat of the default panel and of any author panel ([[0027-trustee-panels-and-live-results]]); each seat's ciphertext carries all the poll's options, bounded by the same 64.

## Decision

The owner decided option B on 2026-10-12. The design within it below is the agent's, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto before [[P2-14]] part 1's vectors are published costs only this text.

### Definition (version 5)

Election definition version 5 ([[versioning]], next free version of `0x0001`) has every field of version 4, in the same order with the same types and meanings, except `election_type`, `option_count`, `min_selections` and `max_selections`, which are replaced, at `election_type`'s position, by one field:

| Field       | Type                            | Meaning                                                                        |
| ----------- | ------------------------------- | ------------------------------------------------------------------------------ |
| `questions` | `list<question, MAX_QUESTIONS>` | The poll's questions, in the order the ballot asks them, numbered from 0 (`q`) |

`question`:

| Field            | Type       | Meaning                                                                                                                                                                               |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`         | `enum8<1>` | 1, selection: each option selected or not, the number selected within `[min_selections, max_selections]`, tallied by `tally_scheme` 1. Ranked choice takes a later value and version. |
| `option_count`   | `u16`      | `m_q`, the question's options, named by index 0 to `m_q − 1` within the question                                                                                                      |
| `min_selections` | `u16`      | Least number of the question's options a counted ballot selects                                                                                                                       |
| `max_selections` | `u16`      | Greatest number                                                                                                                                                                       |

Option `j` of question `q` has the **flat index** `o_q + j`, where `o_q = m_0 + … + m_{q−1}`, and `T = Σ m_q` is the poll's total option count. The ballot, the shares and the tally use flat indices; results and display text use (question, option).

**The owner's methods are limits, not labels.** Pick one is `(0, 1)`; pick any is `(0, m_q)`; pick up to N is `(0, N)`; pick exactly N is `(N, N)`. The definition carries the limits the validity proof enforces and no separate label that could disagree with them, so the instruction a voter reads is derived from what the proof checks (T-34, T-41). The ballot client and `apps/web` render the instruction from `(min, max, m_q)`. Any other range the rules allow (pick two to four) is valid; the poll-creation screens offer the owner's four.

Well-formedness of version 5 replaces version 4's `option-count` and `selections` with these, in this order, reporting the first failing question:

| Code           | Rule                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| `questions`    | `questions` is non-empty.                                                             |
| `option-count` | Every `m_q ≥ 2`, and `T ≤ MAX_OPTIONS`.                                               |
| `selections`   | For every question, `min_selections ≤ max_selections ≤ m_q` and `max_selections ≥ 1`. |

`profile-types` is version 4's (types `0x0001` to `0x0009`), since every version-5 question is method 1. The profile pins, and [[verifier]] 2.3 (`profile-combination`) requires: ballot version 3 (and ballot version 3 only with definition version 5), display-text version 2 (and it only with definition version 5), the spoiled-ballot opening version that opens ballot-version-3 cores, tally-opening version 1 and board-entry version 4. Everything else (the electorate and cells, the panel, timing, receipt keys, the stub and ceremony binding, the definition hash) is version 4's. The question list adds a few creator-chosen bits in bounded integers, within the residual [[election-definition]] already records (T-17).

### Display text (version 2)

Display-text version 2 (`0x0009`) keeps the salted commitment unchanged (`H(DS("abolish/v1/display-text", encode(record)))`, the header's version byte keeping the two versions apart) and gives each translation a title and a list of questions:

- `translation`: `language` (`utf8<35>`), `title` (`utf8<1024>`), `description` (`utf8<8192>`, may be empty), `questions` (`list<question_text, MAX_QUESTIONS>`).
- `question_text`: `question` (`utf8<1024>`), `description` (`utf8<8192>`, may be empty), `options` (`list<option_text, MAX_OPTIONS>`, version 1's `option_text`).
- **Size.** By its list maxima a record could exceed 100 MB, so version 2 adds a whole-record cap, `MAX_DISPLAY_TEXT` = 4,194,304 bytes, checked on the length before decoding (`length-over-max`), so a hostile record stays cheap to reject (T-52). Version 1's worst case, about 3.5 MB, is under it.

Well-formedness adds to version 1's rules: every translation has exactly the definition's number of questions (`question-count`), question `q` has exactly `m_q` options (`option-count`), `title`, every `question` and every `label` are non-empty, labels are distinct within a question (they may repeat across questions: Yes and No), and question texts are distinct within a translation. [[display-text]] Checks apply per question: the cast-confirmation screen and any challenge checker show every question's chosen labels in every translation, so a swapped label on any question shows up (T-41, T-34).

### Ballot (version 3) and validity proofs

Ballot version 3 (`0x0002`) has version 2's fields, offsets and cell (the partition is version 4's), with a committed vote whose last field differs:

| Field           | Type                                             | Meaning                                                                                         |
| --------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `vss`           | `list<list<element, MAX_TRUSTEES>, MAX_OPTIONS>` | As version 1, over the `T` options in flat order                                                |
| `share_hashes`  | `list<bytes[32], MAX_TRUSTEES>`                  | As version 1                                                                                    |
| `option_proofs` | `list<bit_proof, MAX_OPTIONS>`                   | As version 1, one per flat option, binding its flat index `u16(o_q + j)`                        |
| `sum_proofs`    | `list<list<branch, 65>, MAX_QUESTIONS>`          | For each question `q` in order, the proof that `Y_q` commits to a value from `min_q` to `max_q` |

- **Question range proof.** `Y_q = C_{o_q} · … · C_{o_q + m_q − 1}`, which commits to the question's number of selections. The proof is version 1's disjunction over `min_q, …, max_q`, under a new tag, `abolish/v1/fs/ballot-validity/question-sum` (registered in [[domain-separation]]), with
  `t = statement_hash ‖ u16(q) ‖ u16(o_q) ‖ u16(m_q) ‖ u16(min_q) ‖ u16(max_q) ‖ encode(Y_q) ‖ encode(A_min) ‖ … ‖ encode(A_max)`,
  `Y_q` and every `A_b` encoded with the identity allowed, as version 1's `C_Σ`. The proof's position and allowed-value set are in its challenge, as [[domain-separation]] requires, so a proof can't move to another question, another range or another ballot (T-30, T-32).
- **How it composes.** The option proofs show each `C_j` commits to 0 or 1; the range proofs then show each question's count is within its limits. Together: no option counted twice or negatively, no over-vote on any question, and each question's minimum met (T-28). With one question it is version 1's construction with the extra position inputs.
- **Hashes.** `statement_hash`, `ballot_hash` and `core_hash` are version 2's with version input 3 (`ballot_hash` ending in `encode(option_proofs) ‖ encode(sum_proofs)`), so no proof or tracking code of one version is valid under another (T-31). The membership message `M` is unchanged and binds the whole ballot through `ballot_hash`.
- **Checks.** `validity-shape`: `vss` and `option_proofs` have `T` entries, `share_hashes` `n`, `sum_proofs` one entry per question, entry `q` exactly `max_q − min_q + 1` branches. `option-proof` reports the first failing flat option, `sum-proof` the first failing question. Admission is version 2's otherwise.
- **Shares, ciphertexts and delivery are version 1's**, over `T` options, as ballot version 2 keeps them: share plaintexts of `T` entries fit `sealed`'s 4116 bytes, and the delivery records stay at version 1. The ciphertexts bind the definition hash, which pins the ballot version.
- **Proving and casting** are version 1's, with the range proofs made after the option proofs in question order; the client erases the vote and every randomness on cast, as now.

### Tally

- **Unchanged in form.** Aggregates, summed shares, the summed-share message and the tally opening (version 1) work per cell over the `T` flat options, with [[tally]]'s `m` read as `T`. There are no per-question decryption proofs: a question's result is the slice of the cell's opening, each count checked by `tally-opening` against its aggregate as today (T-29).
- **One new check, `tally-question-range`,** after `tally-range` on the passing opening: for each question, the sum of its options' `V_{c,j}` lies between `min_q · |S_c|` and `max_q · |S_c|`. Like `tally-range` it can't fail while binding holds, and is checked because each question's result rests on it.
- **Size.** Cells and options multiply; questions don't add records. A cell's opening is `137 + 64·T` bytes (1,417 at `T = 20`); a board holds at most one per seat and cell, so `cells × n` openings at most, about 17 MB at 256 cells, 16 seats and `T = 64`, the same worst case as one 64-option question today. A national poll by state (52 cells) with five four-option questions publishes 52 × 20 counts. Summed-share messages, private between trustees, are `1278 + 64·T` bytes each, `n(n − 1)` per cell.
- **Coarser totals** are per question and option, summed over cells as today, never opened.

### Re-voting, challenge and receipts

- **Re-voting replaces the whole ballot.** Selection is [[revoting]]'s, per tier and nullifier: the ballot naming the newest L1 block counts, with every question in it; a tie voids every question. No per-question selection exists, so a voter can't keep one answer from an earlier ballot. The client keeps no record of earlier answers to pre-fill a re-vote: answers left on the device are evidence for a coercer (T-45, T-47), so a re-vote asks every question again.
- **Challenge and spoil cover the whole ballot.** One core, one tracking code; a challenge opens every question's answers, and the checker shows them all against the display text. The spoiled-ballot opening for ballot-version-3 cores (core: definition hash, cell, `vss`, `share_hashes`, the layout of a version-2 core) is [[challenge]]'s version 1 with the cell, polynomials for `T` options and `opening-vote-outside` judged per question (T-42, T-44). No version opens ballot-version-2 cores yet ([[challenge]], Versions); P2-14 part 1 specifies the version-3 one so that a version-5 poll can be challenged, and records whether the same layout should serve version-2 cores.
- **One receipt per ballot**: the receipt record (`0x0004`, version 1) is per board entry and doesn't change.

### Verifier

New or changed: 2.1 (version-5 well-formedness, first failing question named); 2.3 (`profile-combination` for definition version 5, ballot version 3, display-text version 2 and the version-3 opening); 2.7 (display-text version 2, per question); 5.4 (`validity-shape` and `sum-proof` per question, the new tag); 6.2 (openings of version-3 cores, `opening-vote-outside` per question); 7.2 (`tally-question-range`); 8.1 (results per question and option, per tier and cell, each with its scope and the question's method rendered from its limits). 8.2's small-count flag stays per cell. The report never derives a joint figure across questions, because none exists.

### Limits

- `MAX_QUESTIONS = 32`, new in [[parameters]]. Every question has at least 2 options and `T ≤ 64`, so 32 is the most the option cap allows: the list bound never binds before it and costs nothing.
- `T ≤ MAX_OPTIONS = 64` for the whole poll. It keeps every per-option bound already set (share ciphertext, summed-share message, tally opening, spoiled-ballot opening, `MAX_BOARD_PAYLOAD`), which is why no record other than those listed changes.
- **Ballot size.** Range-proof branches total `Σ (max_q − min_q + 1) ≤ T + Q ≤ 96`, against 65 today, so the largest committed vote grows from about 45 KB to about 47 KB; P1-18 checks direct submit at that size. Five four-option pick-one questions at `k = 4`, `n = 7` make a record of about 6.5 KB.
- **Proof cost.** Proving and verifying cost one Schnorr branch each for every disjunction branch: two per option proof plus the range branches, at most 128 + 96 against 128 + 65 today, about a sixth more, so a trustee's intake and the verifier's 5.4 stay within today's order of work.
- `MAX_DISPLAY_TEXT = 4,194,304` bytes (above).

### No cross-tabulation

Results report each question's counts per cell, and coarser totals summed from them. Nobody, including us and trustees following the protocol, learns how answers to two questions combine (how many who answered yes to the first answered no to the second): the only values ever opened are per-option sums over a cell's counted ballots, and the ballot's validity proofs never relate questions. Getting a joint figure needs individual ballots opened, which only `k` colluding trustees can do (T-14), and which [[tally]] forbids an honest trustee. A creator who wants a joint breakdown asks a combined question (option D), which the voter sees. No later version can cross-tabulate a poll already tallied.

### Ranked choice

A ranked-choice question waits on the mixnet ADR of [[0003-tally-scheme]] and on [[P5-1]]. Inside a multi-question ballot it would be a separate part of the ballot, beside the flat vector, under a new definition version with a new `method` value. That ADR must also mix each ranked question on its own: mixing several ranked questions of one ballot as one tuple would publish each voter's joint rankings, a cross-tabulation the owner ruled out, and widen the pattern attack (T-70). Until it exists, version 5 has selection questions only.

### What stays one-way

Definition version 5, display-text version 2, ballot version 3, the version-3 opening and `abolish/v1/fs/ballot-validity/question-sum`, once their vectors are published; the flat question-major order; and the absence of any per-ballot opening, so no poll tallied this way can ever be cross-tabulated.

### What remains open

- **Abstaining on a pick-exactly-N question** (owner's wording, `min = max = N`). If the owner wants such a question skippable, the range proof can allow `{0, N}` instead of `[N, N]` at no real cost, decided before part 1's vectors. Settled by the agent in [[P2-14]] part 1a (owner may veto): no blank. A version-5 question's range is contiguous, `[min, max]`, so pick exactly N is exactly N. A skippable form would need a field that makes the range non-contiguous, beside the limits the instruction is rendered from, and a creator who wants a skippable question can ask pick up to N; the owner's word was "exactly". A veto adds a definition version with that field; version 5 keeps its meaning ([[election-definition]], Questions).
- **Pick one with a required answer.** `(1, 1)` is allowed by the rules; whether the creation screens offer it beside the owner's `(0, 1)` is P2-9's.
- **Blank counts for multi-select questions** would need an extra committed indicator per question; not specified.
- **More than 64 options in total** (a long civic ballot) needs a higher `MAX_OPTIONS`: a new version of every per-option record, under either encoding ([[parameters]]).
- **Conditional questions** (answer the second only if yes to the first) would need proofs that relate questions; not supported.
