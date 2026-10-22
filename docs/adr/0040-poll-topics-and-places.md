# ADR 0040: Poll topics and places: listing tags beside the definition

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-22
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-34, T-41, T-67, T-68, T-52, T-72, T-10 (see [[THREAT_MODEL]])

## Context

[[P2-23]]'s stream needs ways in by topic and by place ("Transport", "Riverside"), and [[P2-26]] sets them when a poll is created. The mockups (`everyday-create-ask.tsx`, `everyday-discover-page.tsx`) give each poll one optional topic and one optional place, typed by the author, and show both on the card and in the review step.

Everything a card says today comes from display text the definition commits to: the stream checks it with `checkElectionRecordToShow` against the definition's hash before showing a word of it (T-34, T-41). [[P2-26]]'s plan put the topic and place in that display text too. That is the one-way part: display-text version 2 is frozen by its vectors ([[display-text]], Layout (version 2)), and [[verifier]] 2.3 (`profile-combination`) says a later display-text version comes with a later definition version that pins it, so releases never split on it. Committing a topic and a place means display-text version 3 and definition version 8, with new vectors, codecs in `packages/crypto`, the verifier's and the ballot client's support, and the registry's profile checks, for two words that decide where a poll is listed and nothing about its result.

## Options

### A. In the display text: display-text version 3 with definition version 8

Each translation gains `topic` and `place` strings; definition version 8 is version 7 pinning display-text version 3.

- Pros: the author's words are committed with the rest of the text, so no one serving it can refile a poll without breaking the commitment, and a wipe rebuilds them with the display text from its pinned copy.
- Cons:
  - A definition version, a display-text version and every gated consumer of both, for discovery tags. [[P2-16]] part 7 already needs a later display-text version for the author trustees' names; doing this first means two version bumps where one would do.
  - Free text per translation gives no topic shared across languages: "Transport" and "Verkehr" are two topics.
  - A commitment binds the author, not the listing: the operator decides what the stream lists anyway (its orders, moderation's delisting, [[P2-10]]), so committing the tags protects little the operator couldn't already do by not listing a poll.

### B. Listing tags kept by the operator beside the definition

The topic is a code from a fixed list ([[P2-26]]'s `POLL_TOPICS`), which the website words in its own messages; the place is the author's own short line of text. The draft holds both; once the poll is registered they are the listing's, kept in an operational table keyed by the election ID, which the stream and the topic and place pages read.

- Pros:
  - No protocol change: nothing gated changes, and nothing a verifier checks depends on them.
  - A topic is the same in every language and has one page, and no author can make up a topic, so the topic list can't fill with spam or with words chosen to provoke (T-52, T-67).
  - Moderation can refile a misfiled poll, or clear a misleading place, without taking the poll down ([[P2-10]], T-68: logged like every other moderation action).
- Cons:
  - The definition doesn't commit to them, so they are the operator's claim, not the author's: the operator could refile a poll, as it could delist it (T-68).
  - A wipe of Postgres loses them; polls rebuilt from the chain and IPFS come back untagged until their authors' tags are restored from a backup. No result depends on them.

### C. A topic code in the definition, the place left out

Definition version 8 gains a `u8` topic code, with no free text, so the definition still carries none ([[election-definition]]; T-17).

- Pros: the topic is committed and survives a wipe, with no free text on chain.
- Cons: a definition version for a discovery field, the topic list frozen into the protocol (a new topic is a new definition version or a code no verifier names), and places, the more useful of the two for "near me", still need B.

## Recommendation

B. The tags are discovery, not content: they decide which page lists a poll, which the operator decides anyway, and nothing about what the poll asks or how it is counted. A fixed topic list serves the stream better than any free-text topic, committed or not. If the owner wants the author's tags committed, they can join the display-text version [[P2-16]] part 7 brings, once, and the operational copy becomes a cache checked against it.

What would change it: a need for third parties to list polls by topic or place from the chain and IPFS alone, with no operator, which would favour A, folded into [[P2-16]] part 7's version.

## Consequences

Rules, which [[P2-26]] part 1 and [[P2-23]] part 3 build:

1. **The topic** is optional and, when given, one of `POLL_TOPICS` in `packages/core` (`poll-draft-rules.ts`): community, culture, economy, education, environment, food, government, health, housing, safety, science, sport, technology, transport. The website words each one in its own messages and translations. Codes are only ever added, never renamed or removed, since a poll keeps the code it was filed under.
2. **The place** is optional and, when given, 1 to 80 code points with no control characters, line or paragraph separators, or bidi embeddings, overrides or isolates, no space at either end, and words separated by single ordinary spaces (`placeIsWellFormed`), so two places that look alike are the same string and no place can reorder the card around it (T-67). Places are matched for their pages as search matches text ([[P2-23]] part 4a: NFKC, lower-cased), never ranked.
3. **Both are the author's choice before submission only.** They are part of the draft (`account_polls.draft`, the account class, T-10), checked by `pollDraftProblem` (rules `topic` and `place`) at every write, and fixed at submission like the rest of the draft. After registration only moderation changes them.
4. **They are labelled as the listing's**, never as words of the poll: a card or page shows them as where the poll is filed, apart from the checked display text, and the ballot client never shows them (T-34, T-41).
5. **They name no voter.** Nothing about who answers is stored, logged or keyed with them, and a topic or place page's requests carry nothing of the visitor's beyond the page itself; page views keep the route's template, never the topic or place (T-10, T-11, T-67).
6. **A place is public.** The form says so, as it does for the poll's text, since an author may type their own street.

Known-weak: the tags are the operator's to keep and can be refiled by it (T-68, logged); a wipe loses them (rule 16 of [[0032-poll-creation-operations]] already accepts losing who wrote which poll); a place is free text, so two spellings of one town are two places until moderation merges them.

Follow-ups: [[P2-26]] part 1b (the form's topic and place fields, and the review step), part 1c (the tags carried to the listing at registration, the listing's `topic` and `place` filters, moderation's refiling); [[P2-23]] part 3 (topic and place pages).

## Decision

Under rule A (`AGENTS.md`): option B, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].
