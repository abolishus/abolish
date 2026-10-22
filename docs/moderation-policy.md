# Moderation policy

How we moderate user-created polls, and the limits we hold ourselves to. The brief requires this policy and its tooling before Phase 2 goes public, and fixes its one rule: **moderation acts on poll content, never on results** ([[PROJECT_BRIEF]]). Threats: T-68 (moderation abuse), T-17 (personal data in poll text), T-10 (accounts and ballots never join), T-52 (spam), T-75 (creator profile misuse). Tooling: `packages/core` (`moderate`, `moderationStatus`, `readModerationLog`, `listPolls`, `report`, `readReportQueue`, `reviewReports`; P2-10), the public API (`GET /elections`, the listing, which leaves out delisted and hidden polls; `GET /moderation/log`, `GET /moderation/status`, `POST /moderation/reports`) and the operator's commands in `apps/admin-cli` (`moderation queue`, `review`, `decide`, `status`, `log`, `appeals`, `appeal-decide`, and the same for profiles under `profile-`).

Status: written by the agent under rule A (P2-10 part 1); Open polls narrowed by the owner's decision of 2026-10-12 (P2-10 part 5). The parts that are legal matters are the owner's and are marked **Owner** below; until the owner answers them, they say what we do in the meantime.

## What moderation can and can't touch

A poll has two kinds of data ([[display-text]]):

- **Result-critical data**: the election definition, the board (ballots, proofs, transcripts), the tally and our contracts' events. Anchored on chain, mirrored to IPFS, archived permanently. **Moderation never touches it.** We don't delete, withhold or reorder board entries, refuse ballots, change an election's definition, electorate or closing time, cancel an election, or withhold or change a tally because of moderation. None of that is possible through the moderation tooling, which writes only its own log, and none of it would go unnoticed: every result is verifiable from chain + IPFS by `packages/verifier` alone, whatever our servers show (G-9).
- **Display text**: the question, option labels and descriptions, in each translation. Committed to by a salted hash in the definition, pinned on IPFS, and never archived, put on chain or boarded, so it can be taken down. **Moderation acts only on this, and on whether our front ends list the poll.**

## Actions

| Action    | What our front ends do                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `delist`  | The poll leaves discovery, search and recommendations. Anyone with its link still sees the text, can vote and sees the result.                                                                                                       |
| `hide`    | As `delist`, and the display text is withheld: the poll page shows a notice naming the reason code instead, and the result is shown by option number ("Option 3: 1,204"). We unpin the text, except as Open polls says for `threat`. |
| `restore` | Back to listed, text shown.                                                                                                                                                                                                          |

An election's state is its newest decision (`visible`, `delisted` or `hidden`). A decision that neither changes the state nor cites a new reason is refused.

Use the least restrictive action that addresses the harm: delist unless showing the text itself does harm (personal data, a threat, illegal content, a scam link).

What moderation can't do: copies of display text that others pinned on IPFS stay where they are, and community nodes (`apps/node`) decide for themselves whether to follow our log (T-17 residual, T-68 residual). We publish the log so they can.

## Open polls

A poll is open from when it is registered until `closes_at` plus `l1_inclusion_bound`, while ballots can still land. Our ballot client must refuse to show a ballot whose text it can't check against the definition ([[display-text]], Checks), so withholding an open poll's text from it stops voting through our client. Because that comes close to suppressing a poll, an open poll is hidden only for `illegal`, `personal-data` or `threat`, and delisted otherwise; the tooling refuses any other hide of an open poll (`open-poll`).

Of those three, only `illegal` and `personal-data` stop voting through our client. The owner decided on 2026-10-12 that a `threat` hide must not ([[STATUS]], Decisions to review). Our reading of why: a threat shown to someone who has chosen to vote on that poll does far less harm than one broadcast through discovery and our pages, and `threat` is the code a compelled operator (A-1) could most easily stretch over political speech. So, while a poll is open:

- **`threat`.** Our web pages withhold the text as for any hide. Our ballot client keeps showing the committed text: it fetches the display-text record from IPFS, checks it against the definition as it always does, and shows it under a notice that the text was hidden on our pages as a threat. We keep the text pinned until the poll closes, so the client can fetch it, and unpin it then.
- **`illegal` and `personal-data`.** Our ballot client withholds the text, as our web pages do, shows the notice, and points to the direct-submit path. We unpin the text at once. Here showing the text is itself the harm (hosting illegal content; exposing a private person), so the trade-off stays: voting through our client stops until the poll is restored.
- **The newest decision decides.** A `threat`-hidden poll re-cited under `personal-data` is withheld from the ballot client from then on, and the re-citation is in the public log like any decision. A re-citation adds a ground rather than replacing one, so the reverse doesn't release text: a poll hidden as `illegal` or `personal-data` and then re-cited as `threat` stays withheld until it is restored. The text is shown only while every ground cited since the poll was hidden is `threat`.
- **The ballot client reads the state from `GET /moderation/status`.** If it can't get an answer it treats the poll as visible: a moderation outage, or someone blocking that route, must not stop voting. The text it can show is then whatever it can fetch from IPFS and check, and the text of an `illegal` or `personal-data` hide is no longer pinned by us.

Once a poll has closed, voting is over and a `threat` hide withholds the text everywhere, our ballot client included, like any other hide.

Voting itself always stays possible: anyone holding a copy of the text can check it against the commitment, and the direct-submit path doesn't go through us (G-10). Even so, an open-poll hide for `illegal` or `personal-data` lowers turnout through our client, and so can change an outcome, on a reason code nobody outside can check; a compelled operator (A-1) could misuse either. That is the one place moderation still reaches a result, indirectly, and it is listed for the owner under Decisions to review in [[STATUS]].

## Reasons

Every removal cites exactly one reason code. A removal can be re-cited under a different code (a poll hidden for `spam` later found to carry `personal-data`), so the log can show a further ground; a ground already cited since the poll's state last changed can't be cited again. These are the only grounds:

| Code            | Ground                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `illegal`       | Content that is illegal to host or distribute where we operate, such as child sexual abuse material. See Legal matters.                                 |
| `personal-data` | Personal data of a private individual: a home address, phone number, identity number, health or financial details, or anything that identifies a voter. |
| `threat`        | A credible threat of violence, or incitement to violence against a person or group.                                                                     |
| `harassment`    | Text that targets a private individual for abuse.                                                                                                       |
| `spam`          | Bulk or automated polls, scams, phishing or malware links.                                                                                              |
| `impersonation` | A poll presented as coming from a person, organization or authority that didn't create it.                                                              |
| `legal-notice`  | A notice or order we are legally bound to act on. See Legal matters.                                                                                    |

**Never grounds for moderation**, whatever the pressure: a poll's political or religious viewpoint; its subject being controversial; criticism of any person, government or organization, us included; a public figure's objection to a poll about their public role; a poll being unpopular or reported many times; and above all **the poll's result or turnout**, actual or expected. A decision may never depend on how people voted.

Every restoration cites one of: `appeal-upheld` (the creator's appeal succeeded), `error` (the removal was wrong on its face) or `notice-withdrawn` (the legal notice behind it was withdrawn or overturned).

## Transparency

- **The log.** Every decision is a row in an append-only log: the election ID, the action, the reason code and the time, read from the database's clock rather than given by the moderator. The app role can't edit or delete a row, and triggers stop even the owner's ordinary `UPDATE`, `DELETE` and `TRUNCATE`; a decision is reversed only by a later one, which stays next to it. An owner running DDL could still drop the triggers, and the app role could insert a row without going through the tooling's checks: the log binds the tooling, not an insider (A-2; see What it doesn't prove). The log carries no free text, so it can't carry personal data.
- **Public.** The whole log is published (the API serves it at `GET /moderation/log`, and each poll's state at `GET /moderation/status`) and shown on each moderated poll's page. It doesn't name the moderator, the person who reported the poll or the poll's creator. Decisions about creator profiles are in the same log and the same numbering, naming the profile by its public handle, never its name or account (Profiles).
- **Internally accountable.** Each decision records an opaque moderator handle that the operator maps to a person. It isn't an account reference: no table links an account to a decision (T-10).
- **What it doesn't prove.** The log is in our database, so an insider (A-2) could withhold a row from what we serve or wipe the log. Results don't depend on it, so this can hide what we did to display text, never change an outcome. Anchoring the log (so withholding is detectable) is not built; see Known-weak.

## Reports

Anyone can report a poll, citing one of the removal grounds above (`POST /moderation/reports`, no account). A report stores the poll and the code, never the reporter's account, address, contact details or any text. Reports are counted, one row per poll and ground, so a flood of reports grows two counters and never the table (T-52). The row keeps no time for a report, only the hour the oldest unreviewed report under its ground arrived, which orders the queue (reporting a poll again never moves it back). That stops the stored row from timing a report. It doesn't stop everything: an insider who reads the counters repeatedly, or who holds the database's write-ahead log or backups, can time a report, and the proxy's or platform's logs can hold the reporter's address with that time (T-11). Report volume is not a ground: a moderator judges the poll against this policy, not the number of reports. The counts only order the moderators' queue, which the API never serves.

A moderator reviews a poll's reports under a ground by marking the ones they saw as reviewed (`reviewReports`, given the count the queue showed them), so a report that arrives meanwhile stays pending. Reviewing is not a decision: any action is a separate entry in the log, and reviewing without one leaves the poll as it is. Reports and reviews never enter the public log.

## Appeals

The poll's creator can appeal any decision once, from their account. A different moderator from the one who decided reviews it (and from anyone who re-cited the removal since), and never one whose account created the poll. An upheld appeal is a `restore` with `appeal-upheld`, and no other decision may cite that reason; a rejected one leaves the state, and the log, as they are. Only the poll's newest decision can be appealed, and only a removal; if a later decision changes the poll's state before the review, the appeal is closed as superseded and the creator can appeal the new one; a removal re-cited under another ground leaves the appeal standing. Moderators see an appeal's poll and decision, never who filed it. While there is only one moderator (Moderators, below), appeals wait for a second one, and Phase 2 doesn't go public before one is named.

In the tooling (`packages/core` `src/appeals.ts`, the `apps/admin-cli` commands `appeals` and `appeal-decide`): `fileAppeal`, `readAppealQueue` and `decideAppeal`. A creator files one from their account on the website, where the account lives, never through the API ([[T-10]]): `POST /drafts/appeal` on `apps/web`'s origin appeals their poll's newest decision, and `POST /drafts/moderation` shows them the poll's state, its newest decision, whether it can be appealed and their appeals with each outcome (`readPollModeration`), never a moderator. The account page shows this under each of the author's polls, with the appeal's button while the newest decision can be appealed.

## Profiles

A creator's profile ([[0040-creator-profiles]]) is moderated under the same grounds (Reasons), by the same moderators, in the same log, with appeals as above. The one removal is `hide`: our pages show the reason code instead of the profile's name and polls, and none of its polls says "Asked by" while it stands. A `restore` brings it back. A hide leaves the author's polls listed: their content is moderated as polls, separately. There is no `delist` for a profile, which is reached only through its polls, and no open-poll rule, since hiding a profile stops nobody voting. A hidden profile can't be renamed until it is restored, so a restore shows the name a moderator judged.

The log names a profile by its public handle where it names a poll by its election ID, never its account. Profile decisions take their numbers from the poll log's own sequence under the same lock, so the two read as one log in commit order. Anyone can report a profile under a removal ground, counted per handle and ground as for polls; its author appeals a hide from their account, and a moderator whose account holds the profile neither decides on it nor reviews its appeal.

In the tooling (`packages/core` `src/profile-moderation.ts`): `moderateProfile`, `profileModerationStatus`, `readProfileModerationLog`, `reportProfile`, `readProfileReportQueue`, `reviewProfileReports`, `fileProfileAppeal`, `readProfileModeration`, `readProfileAppealQueue` and `decideProfileAppeal`. The API's `GET /moderation/log` serves both halves of the log, read from one snapshot and merged by number (`readPublicModerationLog`; [[P2-27]] part 1c-2a). Reporting a profile and the author's appeal are routes on the website's origin, not the API's, since checking a handle reads an account table, which the API never does (T-10); they come in part 1c-2c, and no profile is shown anywhere before then. The operator's commands (`apps/admin-cli`, [[P2-27]] part 1c-2b) are `moderation profile-queue`, `profile-review`, `profile-decide` (`hide` or `restore`), `profile-status`, `profile-appeals` and `profile-appeal-decide`, each naming a profile by its handle; `moderation log` prints the whole log, a profile's entries by handle.

## Refiling

A poll's topic and place ([[0041-poll-topics-and-places]]) are where it is listed, not words of the poll, so moderation can refile a poll without delisting or hiding it: change its topic, change its place, or clear either or both. A refiling cites one ground: `misfiled`, when a tag doesn't fit the poll (or an earlier refiling got it wrong), or a removal ground the place itself breaks, most often `personal-data` for a street address or a private person's name. The same limits hold as for every decision: never for a poll's viewpoint, subject or result (Reasons), never by a moderator whose account created the poll, and a refiling that changes nothing is refused. A refiling isn't a change of state: a delisted or hidden poll stays so, and a hidden poll can be refiled, since its place may be why it was hidden.

Refilings take their numbers from the poll log's sequence under the same lock, so they sit in the one log in commit order. Each records only what it changed: which tags it set, and the new value of each (none when cleared), never a tag it kept or the value it replaced, so a place cleared for personal data survives in no entry of the log. Once moderation has refiled a poll, nothing puts its author's tags back: a poll cleared of both keeps an empty filing. A hidden poll's tags are withheld with its text.

The public log shows each refiling in its place among the decisions, with its ground, the topic it filed the poll under (or that it cleared the topic) and only whether it changed or cleared the place, never the place's words. The log carries no free text, and a place one refiling sets may be one a later refiling clears for personal data, which an entry naming it would keep public for good. The place a poll is filed under now is served beside it (`GET /elections/tags`), withheld while the poll is hidden.

In the tooling: `refilePoll` and `readPollTags` in `packages/core` (`src/poll-tags.ts`; [[P2-26]] part 1c-2a); refilings in `GET /moderation/log` and on the website's `/moderation` page, and `GET /elections/tags` ([[P2-26]] part 1c-2b-1). The operator's command, `moderation refile` in `apps/admin-cli`, which takes each tag as set, cleared or kept, so a moderator never clears a tag by leaving it out and can keep a hidden poll's place without reading it ([[P2-26]] part 1c-2b-2).

## Moderators

Moderators act through the tooling only, under handles. They never see or handle ballots, voting identities or anything from the ballot path, and the tooling gives them nothing from it. A moderator who created, or has a stake in, a poll doesn't decide on it.

Each handle belongs to one account (`moderator-add`), for good: a retired handle, or one whose account is deleted, is never given to anyone else, so a handle in the log always meant the same person. The tooling refuses a decision by a handle that isn't active and by a moderator whose account created the poll; a stake other than authorship is the moderator's to declare, since nothing records it.

**Owner:** who may act as a moderator, and on whose behalf, is an entity matter. Until the owner names moderators, the only moderator is the operator of the deployment, and Phase 2 doesn't go public.

## Legal matters

**Owner** (legal and entity matters are owner-only, AGENTS.md rule A). Each of these needs an answer before Phase 2 goes public:

- which jurisdiction's law decides `illegal`, and the mandatory reporting duties that come with some content (for example, child sexual abuse material in the US);
- how we receive and act on legal notices and orders (`legal-notice`), including copyright notices, and whether we publish them;
- what we do when compelled to act on results or on the board, which this policy and the system don't allow (A-1). The system's answer is that a result stays verifiable from chain + IPFS whatever we are made to do; what we say publicly is the owner's call.

Until then, content that appears illegal is hidden with `illegal` and escalated to the owner at once. Whether, and to whom, it is reported is the owner's decision, and Phase 2 doesn't go public before it is made.

## Known-weak

- The log lives in Postgres. A wipe loses it, and every poll goes back to visible; an insider can withhold rows from what we serve. Neither changes a result (T-68 residual).
- Hidden display text survives in copies others pinned, and in the hands of anyone who downloaded it (T-17 residual).
- Hiding an open poll for `illegal` or `personal-data` stops voting through our client; voters then need the text from elsewhere, or the direct-submit path. A `threat` hide doesn't (Open polls).
- While a poll is open, the text of a `threat` hide stays pinned by us and shown in our ballot client, so anyone can read it there; our web pages only stop broadcasting it.
- If the ballot client can't read a poll's state it shows whatever text it can fetch and check, so during an outage of `GET /moderation/status` it can show the text of an `illegal` or `personal-data` hide that someone else still pins.
- The account page doesn't show a poll's moderation or offer its appeal yet: the routes exist (Appeals), the page comes with the creator's poll pages ([[P2-22]]). The front-end behaviour above is a later part (P2-9, P2-8), and keeping a `threat`-hidden open poll's text pinned until it closes is the pinning job's (P4-3). The moderators' tooling is a command line for the operator (`apps/admin-cli`), the only moderator until the owner names others.
- A moderator's stake in a poll other than having created it isn't recorded, so the tooling can't refuse it; the operator's records of who holds each handle are what stand behind the rule.
- A moderator can keep closing appeals as superseded by switching a closed poll between delisted and hidden. Each switch is a decision in the public log, so the pattern is visible, but nothing stops it.
- Anyone can report any poll as often as the proxy lets them, so the pending counts can be inflated; volume is never a ground, and the queue is ordered by how long reports have waited, not by count. A poll's reports can't be withdrawn, and the app role can't delete them.
- A report can be timed by an insider (counters read repeatedly, the write-ahead log, backups) and matched to an address in proxy or platform logs (T-11).
- A hidden profile's author can delete it and make another, under a new handle and at most one name a day, which sheds the hide; the new profile links none of the old one's polls until its author chooses each again. A decision judges the name it saw: a rename after a restore isn't looked at again unless someone reports it.
- A refiling can't be appealed yet, and it is the operator's word against the author's: the definition commits to neither tag, so an author can't prove what they chose, and a wipe loses both the tags and their refilings. An insider can write the tags directly, past the tooling's rules and its log (T-68).

See [[THREAT_MODEL]], [[display-text]], [[0005-permanent-archive]].
