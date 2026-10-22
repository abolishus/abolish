# ADR 0040: Creator profiles

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-22
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-10, T-17, T-52, T-67, T-68, T-75 (new) (see [[THREAT_MODEL]])

## Context

[[P2-27]] part 1 is "a creator's public profile: the polls they asked, nothing else", and the everyday mockups put "Asked by Riverside Neighbours" on every poll, card, share image and stream item (`apps/web/src/mockups/everyday-*.tsx`, `share-*.tsx`). Today no poll says who asked it, by design so far:

- Website polls are created and registered on chain by the operator's creation key, never by the author ([[0032-poll-creation-operations]], option A), so nothing public links two polls by the same author: B was rejected partly for "a permanent on-chain link between an author's polls".
- Who wrote a poll is kept only on the account side, in `account_polls` (rule 15), for appeals and the moderator's own-poll refusal, and is lost in a wipe or with the account (rule 16).
- The account record holds no name: better-auth's `name` column is a fixed placeholder and the migration refuses anything else ([[P2-5]]).

A profile changes that: it publishes a name and links an author's polls to it. What is one-way is not the code but the publication. Once a name has been shown beside a poll, copies of it (search engines' caches, link previews other sites fetched, web archives, screenshots) are out of our reach, so removing it later only removes it from our pages. And whatever the profile is keyed on is a public identifier that links every poll it lists. So the decision fixes:

1. whether an author's polls name their author at all, and on whose choice;
2. where the link lives: on chain, in the display text on IPFS, or only in our database;
3. what the profile shows, and what identifies it;
4. how names are moderated, since a name can impersonate, harass or carry someone else's personal data;
5. what happens to the link when a poll is unlinked, an account is deleted or Postgres is wiped.

## Options

### Whether polls name their author

**A. Never.** Polls stay anonymous, as today. Most private, and no new moderation surface. But it leaves a voter no way to tell a neighbourhood group's poll from a stranger's, and the author no way to build the standing that makes people answer; the brief's everyday app is built around "who asked" ([[PROJECT_BRIEF]], Priority).

**B. Opt-in, per poll** (chosen). An account may make a profile: a name it chooses and a random public handle. Each poll is shown on the profile only if its author chose that for it, and the author can change the choice for any of their polls at any time; a poll not shown names no author anywhere. With no profile, every poll is anonymous, as today.

- Pros: an author who needs to ask something without their name on it still can, from the same account; nothing links polls the author didn't link.
- Cons: a choice at each poll, which the creation form must explain in a sentence. An author can show a poll and unlink it later, but copies made in between stay (above).

**C. Always.** Every poll links to its account's profile, a handle given to every account. Rejected: it publicly links every poll an account asks, including ones on sensitive subjects, and turns a stolen or compelled account list into a public map of authors (T-75); an author who needs anonymity would need a second account, which [[0038-verified-accounts]]'s one account per phone number forbids.

### Where the link lives

**A. On chain or in the display text** (the author's name in the definition's display-text record, pinned on IPFS and committed to by the definition). Verifiable: anyone can check that the definition's own text names its author. Rejected: a name is personal data, which never goes on chain or into anything permanent ([[PROJECT_BRIEF]], Non-negotiable properties; G-12, T-17); display text can be taken down but not edited, so an author could never unlink a poll without hiding its question; and it couldn't be changed after registration at all.

**B. Only in our database, on the account side** (chosen). The profile and each poll's choice are account-class rows beside the creator record of [[0032-poll-creation-operations]] (rule 15). Our pages show them; nothing on chain, on IPFS, in the board or in the archive does.

- Pros: deletable and changeable; no personal data anywhere permanent; nothing new for the verifier.
- Cons: "Asked by" is our word, like the listing and the moderation log: an insider (A-2) can attach a poll to the wrong profile or drop it from one, and no one outside can check it. Pages say so plainly: who asked is what the author told the website, not part of the poll anyone can verify. A wipe loses every profile and link (rule 16 already loses who wrote which poll); polls survive it, anonymous.

An author who wants their authorship checkable can still write it into the question itself, which then is part of the committed text, with everything that implies.

### What the profile is

**The handle.** 16 characters of lowercase RFC 4648 base32 (80 bits) from the CSPRNG, made with the profile, never derived from the account ID, the name or anything else, and never chosen by the author: a chosen handle invites squatting and reads as verified. The profile's page is `/by/<handle>`. A handle is never given to another profile: deleting a profile retires its handle (kept, with nothing else, so it can't be issued again), and 80 random bits make a collision negligible anyway. An author who wants a fresh handle deletes the profile and makes a new one, which links nothing from before.

**The name.** What the author chooses to be called: a person, a group or a pseudonym. After Unicode NFC and trimming, 1 to 60 code points, internal whitespace runs collapsed to one space, and no control, format, private-use, unassigned or separator characters other than the space (so no bidi overrides or invisible characters, T-75). Names aren't unique and aren't verified, and the profile page says so: uniqueness would invite squatting and suggest a check we don't make. A name changes at most once a day, so a profile can't flip between names faster than moderation can look (T-75). There is no picture, description, link or location: "nothing else".

**What the page shows.** The name, and the polls the author chose to show that are registered (the registry sync has stored their definition) and neither delisted nor hidden, each as the stream's card shows it ([[P2-23]]). Not when the profile was made, how many polls were drafted, failed, discarded or unlinked, nor anything about the account (its sign-in, verification, tokens or sessions). A poll's page and card show "Asked by" with the name, linking to the profile, only for a poll its author chose to show.

**Search and analytics.** Profile pages are `noindex` and left out of any sitemap, so unlinking a poll or deleting a profile takes effect wherever we can make it; poll pages stay indexable, so a poll's "Asked by" can still be copied while it is shown. Page views count the route template `/by/$handle`, never the handle (T-67). The profile isn't searchable by name in the listing's `q`, which searches question text only ([[P2-23]] part 4a).

### Moderation of names

**A. None: names are the author's.** Rejected: a name can impersonate a real group or authority on every poll it asks, carry a private person's details, or harass.

**B. The moderation policy's grounds, applied to profiles** (chosen). A profile is reported and decided like a poll, under the same closed list of grounds ([[moderation-policy]], Reasons) and the same append-only public log, with a new target: the log names a profile by its handle where it names a poll by its election ID. The one removal is `hide`: the profile's page shows a notice with the reason code instead of the name and polls, and its polls show no "Asked by" while it stands. `restore` brings it back. Viewpoint, criticism and report volume are never grounds, as for polls. A hidden profile's author sees the decision and appeals it from their account, under the policy's Appeals. A hide leaves the author's polls listed: their content is moderated as polls, separately.

Profiles are not shown anywhere on our pages until this moderation is built (see Consequences), so no unmoderatable name is ever public.

### Unlinking, deletion and wipes

- **Unlinking a poll** removes its "Asked by" and its card on the profile at once. The page that offers the choice says that copies others made while it was shown may remain.
- **Deleting the profile** deletes its name and every poll's choice; its handle is retired. Polls stay, anonymous.
- **Deleting the account** deletes its profile with it (a foreign key on `account_users`, as for every account table), and its handle is retired.
- **A wipe** loses profiles and choices (operational class, as rule 16); polls are rebuilt from chain and IPFS, anonymous until each author makes a profile again.

## Recommendation

B throughout: opt-in per poll, the link only on the account side, a random handle with an author-chosen, unverified name and nothing else, profile pages `noindex`, and names moderated under the existing policy before any is shown.

What would change it: authors needing verified names (an organisation's own domain proving its profile) would add a verification step on top of B, not change it; evidence that renames are used to mislead faster than once a day allows would lengthen the interval or show a profile's previous names.

## Consequences

**Separation** (T-10): the profile, retired-handle and per-poll choice tables are account class in the no-join tests. Nothing about voters, ballots, nullifiers, receipts or participation is in them, and nothing a profile shows depends on who answered: a profile is about asking, never answering. Public reads (a profile's page, a poll's "Asked by") are served by `apps/web`'s own server from core, with no session, never by the API: the API, which carries the ballot path, still reads no account table. Writes are account routes on `apps/web`'s origin, signed in, as drafts are.

**Abuse** (T-52): one profile per account; making, renaming and deleting are account routes with the per-account limits above, and a profile can't be made faster than an account can (Turnstile and the verified phone of [[0038-verified-accounts]]).

**What becomes public** (T-75, new): the name, which polls an author chose to link, and so that those polls share an author. The operator already knows every poll's author (rule 15); a profile publishes only what the author chose.

**Known-weak:**

- "Asked by" is our database's word: an insider can attach a poll to a profile its author didn't choose, or drop it, and only the author would notice (T-75, A-2).
- A rename changes the name on every linked poll, including old ones; a once-a-day limit and impersonation moderation bound it, nothing prevents it.
- Copies made while a poll was linked outlive unlinking or deletion: search caches of poll pages, link previews on other sites, archives.
- Names aren't checked for confusable characters: "Clty of Riverside" passes, and only `impersonation` moderation answers it.

**Parts of [[P2-27]]** that follow (part 1 is split):

- 1b, `packages/core`: the tables, making, renaming, deleting and reading a profile, and each poll's choice.
- 1c, moderation of profiles: the log's profile target, reports, decisions and appeals in core, the public log and reports on the API (profile handles only), and `apps/admin-cli`.
- 1d, the website: the profile settings on the account page, the choice on the creation form and each of the author's polls, the profile page at `/by/<handle>`, and "Asked by" on the poll page and the stream's cards. Nothing is shown before 1c merges.

## Decision

Under rule A (`AGENTS.md`): the options chosen above, status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].
