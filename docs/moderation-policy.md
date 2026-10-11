# Moderation policy

How we moderate user-created polls, and the limits we hold ourselves to. The brief requires this policy and its tooling before Phase 2 goes public, and fixes its one rule: **moderation acts on poll content, never on results** ([[PROJECT_BRIEF]]). Threats: T-68 (moderation abuse), T-17 (personal data in poll text), T-10 (accounts and ballots never join), T-52 (spam). Tooling: `packages/core` (`moderate`, `moderationStatus`, `readModerationLog`; P2-10).

Status: written by the agent under rule A (P2-10 part 1). The parts that are legal matters are the owner's and are marked **Owner** below; until the owner answers them, they say what we do in the meantime.

## What moderation can and can't touch

A poll has two kinds of data ([[display-text]]):

- **Result-critical data**: the election definition, the board (ballots, proofs, transcripts), the tally and our contracts' events. Anchored on chain, mirrored to IPFS, archived permanently. **Moderation never touches it.** We don't delete, withhold or reorder board entries, refuse ballots, change an election's definition, electorate or closing time, cancel an election, or withhold or change a tally because of moderation. None of that is possible through the moderation tooling, which writes only its own log, and none of it would go unnoticed: every result is verifiable from chain + IPFS by `packages/verifier` alone, whatever our servers show (G-9).
- **Display text**: the question, option labels and descriptions, in each translation. Committed to by a salted hash in the definition, pinned on IPFS, and never archived, put on chain or boarded, so it can be taken down. **Moderation acts only on this, and on whether our front ends list the poll.**

## Actions

| Action    | What our front ends do                                                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delist`  | The poll leaves discovery, search and recommendations. Anyone with its link still sees the text, can vote and sees the result.                                                               |
| `hide`    | As `delist`, and the display text is withheld: the poll page shows a notice naming the reason code instead, and the result is shown by option number ("Option 3: 1,204"). We unpin the text. |
| `restore` | Back to listed, text shown.                                                                                                                                                                  |

An election's state is its newest decision (`visible`, `delisted` or `hidden`). A decision that wouldn't change the state is refused.

Use the least restrictive action that addresses the harm: delist unless showing the text itself does harm (personal data, a threat, illegal content, a scam link).

Hiding an open poll's text means our ballot client can't show the question, and the ballot client must refuse to show a ballot whose text it can't check against the definition ([[display-text]], Checks). So hiding an open poll stops voting through our client until it is restored. Because that comes close to suppressing a poll, a poll is hidden before it closes (until `closes_at` plus `l1_inclusion_bound`, while ballots can still land) only for `illegal`, `personal-data` or `threat`, and delisted otherwise. The tooling refuses any other hide of an open poll (`open-poll`). Voting itself stays possible: anyone holding a copy of the text can check it against the commitment, and the direct-submit path doesn't go through us (G-10).

What moderation can't do: copies of display text that others pinned on IPFS stay where they are, and community nodes (`apps/node`) decide for themselves whether to follow our log (T-17 residual, T-68 residual). We publish the log so they can.

## Reasons

Every removal cites exactly one reason code. These are the only grounds:

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

- **The log.** Every decision is a row in an append-only log: the election ID, the action, the reason code and the time. Nobody, the database owner included, can edit or delete a row; a decision is reversed only by a later one, which stays next to it. The log carries no free text, so it can't carry personal data.
- **Public.** The whole log is published (the API serves it, P2-10 part 2) and shown on each moderated poll's page. It doesn't name the moderator, the person who reported the poll or the poll's creator.
- **Internally accountable.** Each decision records an opaque moderator handle that the operator maps to a person. It isn't an account reference: no table links an account to a decision (T-10).
- **What it doesn't prove.** The log is in our database, so an insider (A-2) could withhold a row from what we serve or wipe the log. Results don't depend on it, so this can hide what we did to display text, never change an outcome. Anchoring the log (so withholding is detectable) is not built; see Known-weak.

## Reports

Anyone can report a poll, citing a reason code (P2-10 part 2). A report stores the poll and the code, never the reporter's account, address or contact details. Report volume is not a ground: a moderator judges the poll against this policy, not the number of reports.

## Appeals

The poll's creator can appeal any decision once, from their account. A different moderator from the one who decided reviews it. An upheld appeal is a `restore` with `appeal-upheld`; a rejected one leaves the state, and the log, as they are.

## Moderators

Moderators act through the tooling only, under handles. They never see or handle ballots, voting identities or anything from the ballot path, and the tooling gives them nothing from it. A moderator who created, or has a stake in, a poll doesn't decide on it.

**Owner:** who may act as a moderator, and on whose behalf, is an entity matter. Until the owner names moderators, the only moderator is the operator of the deployment, and Phase 2 doesn't go public.

## Legal matters

**Owner** (legal and entity matters are owner-only, AGENTS.md rule A). Each of these needs an answer before Phase 2 goes public:

- which jurisdiction's law decides `illegal`, and the mandatory reporting duties that come with some content (for example, child sexual abuse material in the US);
- how we receive and act on legal notices and orders (`legal-notice`), including copyright notices, and whether we publish them;
- what we do when compelled to act on results or on the board, which this policy and the system don't allow (A-1). The system's answer is that a result stays verifiable from chain + IPFS whatever we are made to do; what we say publicly is the owner's call.

Until then: content that is plainly illegal is hidden with `illegal`, and nothing else is reported to anyone.

## Known-weak

- The log lives in Postgres. A wipe loses it, and every poll goes back to visible; an insider can withhold rows from what we serve. Neither changes a result (T-68 residual).
- Hidden display text survives in copies others pinned, and in the hands of anyone who downloaded it (T-17 residual).
- Hiding an open poll stops voting through our client; voters then need the text from elsewhere, or the direct-submit path.
- Reports, appeals, the public API and the front-end behaviour above are part 2 and later (P2-9, P2-8).

See [[THREAT_MODEL]], [[display-text]], [[0005-permanent-archive]].
