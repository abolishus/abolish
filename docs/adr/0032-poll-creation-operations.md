# ADR 0032: Poll creation operations

- Status: Accepted (agent) — owner may veto (2026-10-17, rule A): option A for the creator, the coordinator in `packages/core` behind `apps/api`, and the rules below. Funding the creation key with real funds is the owner's (mainnet).
- Date: 2026-10-17
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-08, T-10, T-13, T-14, T-17, T-25, T-34, T-37, T-50, T-52, T-54, T-65, T-67, T-68, T-69, T-72 (see [[THREAT_MODEL]])

## Context

[[P2-22]] builds the path from a question an author writes on the website to an election the registry has admitted and the API lists. The contracts and the protocol are specified; the operations around them aren't, and every later part of P2-22 builds on them:

- `createElection()` makes its caller the election's **creator**, the only account that can register its definition, and a creator MUST wait until its `ElectionCreated` event is in finalized L2 history before putting the identifier in a stub ([[contracts]], Election identifier; T-25, T-50).
- An author signs in with a passkey account (better-auth, [[0024-tier0-registration]]'s account side), which can't sign L2 transactions, and registration comes after the ceremony, minutes to tens of minutes after the author pressed submit.
- The brief: "Gas sponsorship covers registration only; voters never transact to vote." "The account ... is who you are to the app: poll creation, moderation, notifications. It lives in Postgres." "No PII on-chain, ever."
- [[ceremony]]: the coordinator "relays messages and assembles the transcript. It is trusted for nothing but liveness." [[P2-13]]'s node polls a coordinator over HTTPS and nothing listens on it; only `LocalCoordinator` exists.
- [[0027-trustee-panels-and-live-results]], The transitional panel: until independent trustees are named ([[P1-7]]), every seat of the default panel is ours, and only everyday polls run under it.
- [[contracts]], Registration: rule 7 (every tier's `root_l2_block` is below the registering block), rule 8 (a ceremony a quorum of the pinned panel signed) and rule 9 (the profile pins exactly what the deployment serves: today definition version 5 with ballot version 3; version 6 is refused until [[P2-16]] part 5).

What is one-way: the creator of every election is public and permanent on L2. If authors' own addresses create their polls, that address links every poll an author ever created, for good, and no later release can unlink them. A registered definition can't change either, so whatever the worker builds from a draft is the poll.

## Options

### A. The operator creates and registers, from a creation key it pays for itself

A dedicated key of ours (an externally owned account, the **creation key**) calls `createElection()` and `registerDefinition()` for every poll made on our website, and pays their gas from its own balance. The author is never on chain: the account-side record in Postgres says whose poll it is (Decision, The creator record). On chain, the creator of every website poll is the same public address, "the account that runs the election, not a voter".

Pros: the chain shows nothing about who wrote which poll (T-10's spirit for authors; T-13 doesn't arise). Registration needs no author present, so the state machine runs unattended after submit. No sponsorship: the operator pays for its own transactions, so the brief's "Gas sponsorship covers registration only" holds as written. One sender keeps nonce handling simple. The key can do little harm alone: rule 8 means it registers nothing a quorum didn't approve (T-72).

Cons: the operator can refuse to create any poll (T-25), and while the transitional panel is ours, no one else can get a ceremony either, so refusal has no technical answer until independent seats serve other coordinators (Consequences). The key is hot and online in a worker (T-65, T-69). Authorship is the operator's word: nothing signed by the author binds the definition to their draft (T-34, T-72).

### B. The author's own account on L2, sponsored

Each author gets a smart account controlled by their passkey (P-256 verification through RIP-7212, which Base supports), and a creation paymaster sponsors its `createElection()` and `registerDefinition()` calls.

Pros: the creator is the author, so the operator can't register a poll under an author's name without their passkey, and the author's signature binds what is registered.

Cons: registration follows the ceremony, so the author would have to come back and sign a second time, or delegate a session key that we hold, which is option A with more code. Sponsoring creation is gas sponsorship beyond registration, which the brief excludes. The author's account address is public and links every poll they create, permanently, across the deployment (one-way). It needs a P-256 account contract and a second paymaster in the `crypto-review` gate, both new attack surface (T-63, T-62).

### C. Bring your own wallet only

The website stops at a draft; the author creates and registers from their own wallet through the SDK, paying their own gas.

Pros: no operator key; the operator can't refuse creation.

Cons: an everyday poll would need a funded wallet, which nearly nobody answering "anyone can ask anything" has. The author's address links their polls, as in B. And it doesn't remove the operator's power during launch: a definition registers only with a quorum of the pinned panel (rule 8), and every seat is ours and answers only our coordinator, so the author still needs us for the ceremony.

## Recommendation

**A**, with C kept as the self-run path for later. A is the only option that keeps authors off the chain, needs no author presence after submit and stays inside the brief's sponsorship rule. B's one real gain, the author's signature over what is registered, comes at a permanent cross-poll linkage of authors and a second signing step at an unpredictable time; the residual it closes (the operator registering something other than the draft) is detectable by the author on the poll's page and is written down in T-72. C doesn't remove refusal while the panel is ours, and costs everyday authors a wallet.

What would change it: independent seats serving coordinators other than ours (then C becomes a real direct-creation path and the SDK should document it), or a cheap author signature over the display-text hash (see Consequences), which A can add without changing who the creator is.

## Decision

### The creator and who pays

1. Polls made on our website are created and registered by the **creation key**, an externally owned account used for nothing else: not the deployer, not a registrar, not the registration account's owner. It pays its own gas. No paymaster sponsors creation.
2. The creation key lives only in a dedicated worker deployment (`worker-create`: the `apps/worker` image, run with only the poll-creation queues enabled and only the creation key and the RPC URL among its secrets), never in the API, the web front, a trustee seat's host or a session. Custody, funding, rotation and compromise are in [[poll-creation]] (`docs/runbooks/poll-creation.md`).
3. Its balance is a float of a few days' creations, topped up by hand from a funding account; on testnet from a faucet or the deployer's workflow, on mainnet only once the owner decides to fund it (real funds, owner-only).
4. The worker records which creation key's address created each poll (the poll row's `creator_address`), and only that key registers that poll. Rotation keeps the old key until no poll it created is still between `created` and `registered` ([[poll-creation]], Rotation).

### The coordinator

5. The coordinator is ours, as [[ceremony]] expects ("in practice the creator's node"), and holds nothing secret. Its state (each run's stub, rounds and deadlines) lives in Postgres and its logic in `packages/core`, beside the trustee node's `LocalCoordinator` contract; `apps/api` serves the seats' side of `HttpCoordinator`'s protocol under its own path prefix and rate limits, and the worker opens runs and closes rounds at their deadlines. A separate service would add a deployable and a runbook and protect nothing, since the coordinator can only withhold (T-54). A seat acting as coordinator is refused: it would need an inbound port, which no node has (T-14), and would put the coordinator's state beside a seat's keys.
6. During the transitional panel our seats poll only our coordinator, from their own hosts at their own providers ([[0027-trustee-panels-and-live-results]], Part 3), each holding only its own identity key. No seat key is ever in `worker-create`, the API or the coordinator's database. [[P2-16]] part 6's runbook records the seats' layout; this ADR adds nothing to it.
7. The coordinator hands seats only stubs the worker built from a submitted draft. Seats check every stub themselves ([[ceremony]], Stub checks); the coordinator's choice of stubs is admission, which is P2-13's rule for stub capacity (T-25, "approved stubs nobody registers").

### The definition

8. The worker builds the newest definition version the deployed registry serves: a setting of `worker-create`, checked at startup against the profiles the release pins for that deployment, never inferred. Today that is version 5 with ballot version 3; it moves to version 6 with [[P2-16]] part 5 and to rolling electorates with [[P2-17]]. Until version 6, a definition carries no poll class, so "everyday only" under the transitional panel holds because the creation flow offers nothing else (civic referendums are [[P5-1]]'s), not because a verifier can check it; the website and receipts carry the transitional label either way.
9. The electorate is fixed and in the past: at the `rooted` step the worker takes each tier's root and member count at one finalized L2 block, `root_l2_block`, through `packages/crypto`'s tier tree from the group registry's records. The website says so in plain words before submit: people who joined before setup can answer, people who join later can't, until rolling electorates land.
10. `opens_at` is set when the stub is built, far enough ahead for the ceremony and registration (a worker setting, 30 minutes to start); if registration can't land before it, the worker builds a new stub for the same `election_id` with a later `opens_at` and runs a new ceremony. Seats approve at most one transcript per `stub_hash`, and a new `opens_at` is a new stub, so a retry never asks a seat to approve twice; the election identifier is reused, since nothing was registered under it.
11. Nothing about the author goes into the definition or its display text: no name, handle or account identifier. The display text is the author's question as written, committed by salted hash and takedown-able under [[moderation-policy]]; the form says before submit that the question is public.

### The state machine

12. A poll is a row in Postgres with the states `drafted`, `submitted`, `created`, `rooted`, `ceremony`, `registered`, `open` and `failed`, advanced by idempotent worker jobs. Each chain write is recorded before it is sent (the sender, nonce and transaction hash), and a rerun first looks for that transaction's receipt and event rather than send again, so a crash never makes a second creation or a second registration. `created` means the `ElectionCreated` event is in finalized L2 history (the `finalized` block tag), never merely included. The creation key's jobs run one at a time, so its nonces never race.
13. Before `open`, the worker reads back what the registry holds (`DefinitionRegistered` and the stored hash), decodes the definition it registered and compares it, field by field, with the draft; a mismatch fails the poll and alerts, it never opens it (T-34). The poll's page shows the author their question and the registered definition's hash and fingerprint.
14. A step that misses its deadline (finality, the ceremony's rounds, registration before `opens_at` after the retries of rule 10) moves the poll to `failed` with a plain reason, and the author can retry or discard it. The website shows these states in words ("Setting up your poll"), never a hash or code.

### The creator record

15. The account-side record of who created a poll is one table in the `account_*` class of the T-10 no-join test: the poll's internal ID, the author's account ID, the `election_id` once created, the state and its times. It holds nothing about any voter, and no foreign key or view joins it to a board, ballot, nullifier, receipt, identity or queue table; the test is extended in the same PR that adds the table ([[P2-22]] part 2). It is what [[P2-10]] part 3b needs for appeals and for refusing a moderator's decision on their own poll.
16. The record is operational: wiping Postgres loses who wrote which poll and the polls still in setup, never a result. A registered poll is rebuilt from chain and IPFS like any other; one created but never registered is left as an unused identifier. Deleting an account deletes its creator rows; its registered polls stay, unattributed.
17. Analytics records that a poll was created, never its text or `election_id` (T-67).

### Abuse

18. Creation needs a signed-in account and a Turnstile solve on submit (action `poll-create`). Per account: at most 3 polls between `submitted` and `open` at once, and 10 submitted per rolling 24 hours. Globally: a ceiling of creations per day (`CREATE_DAILY_CEILING`, 200 on staging), checked before the creation transaction is sent, so a flood of accounts spends at most the ceiling's gas a day. The limits live in Dragonfly; refusals are plain ("You can set up 3 polls at a time"). These are starting values, settings rather than protocol (T-52, T-01: an account is cheap).
19. Every poll in setup holds seat capacity until its `opens_at` (P1-12c part 2's `forcedPathFits`); the global ceiling also bounds that.

## Consequences

- **Refusal has no technical answer during launch.** The operator can refuse to create a poll, and since every seat is ours and answers only our coordinator, nobody else can get a ceremony from the pinned panel either. We don't pre-moderate: the worker refuses a submitted draft only for the abuse limits (rule 18) or a definition the registry would refuse, each with its plain reason, and moderation acts on a poll once it is registered, under [[moderation-policy]]'s public log and appeals (T-68). Any other refusal is A-2's power, stated in T-72. Once independent seats are named, a seat may serve other coordinators, and the SDK's self-run path (option C) becomes the direct-creation answer to T-25.
- **Authorship is the operator's word.** Nothing the author signs binds the registered definition to their draft. The author sees the registered question and hash on the poll's page and can check them with the verifier; a passkey assertion over the display-text hash, stored beside the creator record, is a possible later addition that doesn't change who the creator is (T-72).
- **A stolen creation key** can spend the float, create elections (costing gas and shared event-sequence space, [[contracts]], Events) and register any definition a quorum of the pinned panel approved for an election it created, which during launch means only stubs our coordinator handed our seats. It can't register a definition for anyone else's identifier or change one. [[poll-creation]] has the response (T-65, T-72).
- **Setup takes tens of minutes**, mostly waiting for finalized L2 history twice (creation, and the registration block before `open` is reported) and for the ceremony's rounds. The website says so.
- **Fixed electorates only**, until [[P2-17]]: a voter must be in a Tier 0 group before the poll is set up.
- **Definition version 5** until [[P2-16]] part 5: no poll class in the definition, so "everyday only" rests on the creation flow (rule 8).
- Follow-ups are [[P2-22]] parts 2 to 7, in its file.

Decisions to review in [[STATUS]]: this ADR, listed under the agent's decisions.
