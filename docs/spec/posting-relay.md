# Posting relay

How a voter's share posting reaches the board's contract path through our API, which pays its gas, as [[0042-posting-relay]] decides (option A, its rules 1 to 5): the request and its answers, the checks before the relay pays, its caps, the queue and the worker that sends from the posting key, the forced path through L1, and what the client may rely on. Notation is from [[notation]]; the posting record, its public check, the windows and the client rules are [[delivery]]'s and [[share-encryption]]'s; the board's `submitPosting` and its `SharePosted` event are [[contracts]]' (Board, Delivery records, Events). Threats: T-11, T-13, T-15, T-17, T-18, T-25, T-52, T-54, T-69.

The relay is operational, never part of an election: no verifier reads the request, the queue or the relay's state. What a verifier checks is the board's `SharePosted` events, read by [[delivery]]'s delivery check whoever sent them. So this page binds the relay, its route and the ballot client, not the verifier. It adds no record type, hash or encoding: the request carries the share posting (`0x000d`, version 1 or 2) and the ballot record it delivers unchanged, as `submitPosting(bytes posting, bytes ballot)` takes them. `packages/crypto` has every check the relay runs on the bytes (the records' decoders, the ballot hash, `checkPosting` and its version-2 counterpart).

What this page doesn't cover:

- **The voter's choice to post** ([[delivery]], Client rules, rule 4): the offer, its wording and the decline are the ballot client's ([[P2-8]] part 3c-1b-2b-2b-2d-2b-1, #578).
- **The voter's own wallet** ([[0042-posting-relay]], rule 6, option B): [[P2-8]] part 3c-1b-2b-2b-2d-2b-2d.
- **The build:** the route, the queue, the worker and the posting key's runbook ([[P2-8]] part 3c-1b-2b-2b-2d-2b-2b, after this page), and the client's `post` through it (part 2c).

## Roles

- **The voter's ballot client** holds `ct_i` and `m_i` for each seat it may post ([[delivery]], Client rules, rule 4) and the ballot record the posting delivers. It sends the pair and judges the outcome itself, from the board's events (Outcome).
- **The route** (`apps/api`) checks the request's bytes and the election, queues the pair, and answers what the worker did with it.
- **The posting worker** (`apps/worker`, in a deployment of its own, the only one holding the posting key) re-checks what can change, simulates, applies the caps, sends `submitPosting` from the **posting key**, keeps each sent posting until it is final, and forces it through L1 if the sequencer doesn't include it.

The posting key is an externally owned account used for nothing else. It has no role in any contract: a posting's authorisation is its `m_i`, which only a party that knows it can make pass ([[share-encryption]], Public posting), and the ballot it carries, which only a member can make ([[contracts]], Board, Delivery records). The key only pays, on L2 for its calls and on L1 for its deposits.

## Values

| Name                    | Value     | Meaning                                                                                                                                                          |
| ----------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTING_MAX_DATA`      | 120,000   | The most bytes of `submitPosting` calldata the relay sends: a deposit's data cap on the portal ([[delivery]], Capacity), so every posting it sends can be forced |
| `POSTING_BALLOT_CAP`    | 2         | The most ballot hashes the relay posts for, per election and (`tier`, `ν`)                                                                                       |
| `POSTING_QUEUE_MAX`     | 64        | The most pairs queued at once, across every election                                                                                                             |
| `POSTING_WAIT`          | 20        | Seconds the route waits for the worker's answer before it answers busy                                                                                           |
| `POSTING_SEND_MARGIN`   | 900       | Seconds before `c_D` after which the relay sends nothing new on L2                                                                                               |
| `POSTING_RESEND`        | 60        | Seconds between rebroadcasts of a pending transaction                                                                                                            |
| `POSTING_FORCE_AFTER`   | 600       | Seconds a sent transaction may stay out of every L2 block before its posting is forced through L1                                                                |
| `POSTING_GAS_HEADROOM`  | 5/4       | The gas limit of a relayed call over the gas its simulation used                                                                                                 |
| `POSTING_GAS_LIMIT_MAX` | 3,000,000 | The most gas limit any relayed call or deposit is given                                                                                                          |

And two settings of the worker's deployment, which the operator chooses and which change no answer's meaning: the **election budget**, the most L2 gas the relay spends on one election's postings, and the **fee cap**, the most wei per L2 gas any relayed call is signed to pay (as the Tier 1 relay's, [[tier1-relay]]).

They are values of this page, not of any record: changing one changes the relay and its clients, never an election. Why these values is below.

## Request

`POST /postings` on the API, on the ballot path: like every route it carries no account cookie or `Authorization` header and is refused with one (T-10), and CORS allows the ballot client's origins with no credentials, as `POST /ballots` does. The handler sees the body alone, never a header, cookie or address. The body is a strict JSON object of exactly:

| Field     | Value                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------- |
| `posting` | The share posting record (`0x000d`) with its header, as lowercase hex with no `0x`.                |
| `ballot`  | The ballot record (`0x0002`) the posting delivers, with its header, as lowercase hex with no `0x`. |

There is no election field: the posting's `definition_hash` names it. The route's body bound is 256 KiB, above twice `POSTING_MAX_DATA` in hex.

## Answers

The route checks, in this order, and answers the first failure:

| Step | Check                                                                                                                                                                                                                                                                                                                                                   | Answer                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | The transport: no account credential, a body within the route's bound, strict JSON with no repeated key (as every route), and the API's per-address rate limit.                                                                                                                                                                                         | 400, or 429 `RATE_LIMITED` (as every route)                                            |
| 2    | The body has exactly the fields above in their forms, and `submitPosting`'s calldata for the pair (selector, two offsets, and each record's length and bytes padded to whole words: `132 + ⌈p/32⌉·32 + ⌈b/32⌉·32` bytes for records of `p` and `b` bytes) is at most `POSTING_MAX_DATA`.                                                                | 400                                                                                    |
| 3    | The posting decodes strictly as a share posting and the ballot as a ballot record (`packages/crypto`), the posting's version is the one the ballot's version fixes ([[delivery]], Versions; Version 2), and the posting's `ballot_hash` is the ballot hash recomputed from the ballot record ([[ballot-validity]]), its `definition_hash` the ballot's. | 422 `POSTING_REFUSED`, code `malformed`                                                |
| 4    | The election is registered in the deployment's election registry, by the API's own index of it, never read per request, and the index's latest L2 block has a timestamp at most `c_D − POSTING_SEND_MARGIN` (Sending). An index that lags the L2 node by more than a minute stops here.                                                                 | 422 `POSTING_REFUSED`, code `unknown-election` or `too-late`; 503 `RELAY_UNAVAILABLE`  |
| 5    | The posting passes the public check against the election's registered key set ([[share-encryption]], Public posting, and Public posting (ballot version 4): `posting-hash`, `posting-proof`, `posting-encapsulation`), so the relay pays only for postings that deliver.                                                                                | 422 `POSTING_REFUSED`, with the check's code                                           |
| 6    | In one atomic step (one Redis script): if `keccak256(posting)` already has an outcome (Caps, Queue), answer it; else if the queue holds `POSTING_QUEUE_MAX` pairs, answer busy; else queue the pair, unless the same posting is already queued.                                                                                                         | the outcome; 503 `RELAY_BUSY`                                                          |
| 7    | The route waits up to `POSTING_WAIT` for the worker's outcome for `keccak256(posting)`.                                                                                                                                                                                                                                                                 | 200 `sent`; 422 `POSTING_REFUSED` with the worker's code; 503 `RELAY_BUSY` if none yet |

A `sent` answer is `{ "transaction": <hash>, "layer": "l2" | "l1" }`: the hash of the last transaction that carried the posting, an L2 call or, once forced, the L1 deposit. `RELAY_BUSY` means only "not sent yet": the client sends the same bytes again later, and the relay never pays twice for them (Caps). Every answer is a hint ([[0042-posting-relay]], rule 2): the client stands down only on the board's event (Outcome).

**Why the route runs the public check.** It is the relay's most expensive check (an ML-KEM re-encapsulation and a few ristretto255 operations, about a millisecond), but a pair that fails it never takes a queue place or reaches the key's process, and only the voter, who knows `m_i`, can make a pair that passes. The board can't run it ([[contracts]], Board, Delivery records), so without it the relay would pay for junk postings anyone who saw `ct_i` can make (T-52).

**What a refusal says.** Steps 2, 3 and 5 depend only on the pair and the registered key set; step 4 on the index; step 6's busy answer on the queue's size. None depends on whether the ballot was cast, receipted or posted before, except a repeat of the same bytes, which its sender already holds. The worker's refusals (Sending) depend on the chain, the caps and the budget, so a `ballot-cap` refusal says that this (`tier`, `ν`) already had postings paid for two other ballot hashes: only a member holding that nullifier's secret, or a party that saw those postings on L2, can make the pair that learns it, and those postings are public once sent (T-13).

## Queue

The queue is one Redis hash from `keccak256(posting)` to the pair, with no arrival time, order, request identifier, address or count per pair, and no BullMQ job, key or log line derived from a request: BullMQ's events stream keeps job IDs and times, so the worker drains the hash on a tick (every 2 seconds), never a job per request (T-11, T-13). An outcome is one Redis key per `keccak256(posting)` that the worker writes and that expires after `POSTING_WAIT`; the durable record of a sent posting is the worker's (Caps). The queue's store MUST NOT evict keys; it need not survive a restart, since a pair lost before it was sent was never answered `sent`, and the client sends it again.

A pair leaves the queue when the worker sends or refuses it. Nothing about a request remains then but what Caps keeps, which the chain shows once the posting is sent; a refused pair leaves nothing but its expiring outcome (T-18).

The route's log is the API's: method, route, status and duration (T-10); the worker logs per pair only the election's definition hash and an outcome code, never a record, `m`, a ballot hash, a nullifier, a transaction or an address ([[0042-posting-relay]], rule 1; T-11, T-18).

## Sending

The worker takes the queued pairs one at a time, in no order the route sets (Redis's hash order), and for each, refusing on the first failure:

1. **Decodes again** and recomputes `keccak256(posting)`, the ballot hash and the ballot's (`tier`, `ν`): its `tier`, or under ballot versions 2 to 5 its cell's tier, and its nullifier. A pair the route queued always decodes; the worker doesn't take the route's word for the fields it counts by (`malformed`).
2. **Repeat.** A posting whose bytes the relay already sent is answered `sent` with its transaction, and nothing is sent ([[0042-posting-relay]], rule 4).
3. **Time.** The L2 node's latest block has a timestamp at most `c_D − POSTING_SEND_MARGIN` (`too-late`). This reads the latest block, not the finalized one rule 3.2 of [[0042-posting-relay]] names: the latest is never earlier, so this refuses at least as much.
4. **Simulation.** `submitPosting(posting, ballot)` from the posting key, called against the latest block with gas `POSTING_GAS_LIMIT_MAX`, succeeds, so the board's own checks (the ballot check with its membership proof, `posting-length`, `posting-ballot`, `posting-hash`) pass before any gas is spent (`simulation`); the gas it used, times `POSTING_GAS_HEADROOM`, rounded up, is the call's gas limit `g`. Only a revert refuses; a node error leaves the pair queued for the next tick.
5. **Caps.** The election and (`tier`, `ν`) have postings paid for fewer than `POSTING_BALLOT_CAP` other ballot hashes (`ballot-cap`), and the election's gas spent plus `g` is within the election budget (`budget`).
6. **Sends.** Signs the call with the next nonce of the posting key, gas limit `g` and fees at most the fee cap, broadcasts it, and before answering records durably: `keccak256(posting)` with the transaction's hash, the ballot hash under the election and (`tier`, `ν`), `g` added to the election's gas spent, and the in-flight entry (below). Then it answers `sent`.

A pending transaction is rebroadcast, identical, every `POSTING_RESEND`, and replaced at its nonce with both fees raised by an eighth, carrying the same calldata, while the fee cap allows. Once included, the election's gas spent is reduced from `g` to the gas the receipt shows. A transaction whose nonce another transaction of the key consumed is judged by the posting's event (below), never sent again as a new transaction without that, so a posting is never paid for twice.

**In flight.** Each sent posting is kept, with its calldata, election, `c_I`, `c_D` and `t_D` and every transaction that carried it, until its exact bytes are in a `SharePosted` event of the board at the L2's finalized head, whoever sent them, or until the finalized head passes `t_D` without them, after which it can never be in time ([[delivery]], Windows). Nothing else of it is kept. This is the only place `m_i` outlives the request, and only until the chain holds it or never can (T-18).

**Forced through L1** ([[0042-posting-relay]], rule 5; [[0004-l2-choice]], Forced inclusion). A posting whose transactions are in no L2 block `POSTING_FORCE_AFTER` after it was first sent is deposited on L1: `depositTransaction` on the portal the release pins, from the posting key on L1, to the board, value 0, gas limit `g`, the same calldata, which `POSTING_MAX_DATA` keeps within the deposit's cap. On L2 the deposit runs as the posting key's own call ([[0004-l2-choice]], an externally owned sender keeps its address), so the board sees the same call. The relay deposits only while the deposit's L1 block can have a timestamp at most `c_I`: the deposit then reaches L2 by `c_I + F = t_D − R`, in time ([[delivery]], Direct submit), and it is never sent inside the interval from `c_I` to `c_D` in which every seat's forced receipts take the portal's target ([[delivery]], Capacity), so the relay's deposits never take gas the trustees' capacity check counted on. This is narrower than [[0042-posting-relay]]'s "by `c_D`", which didn't weigh Capacity. A posting whose force time falls after `c_I` stays on L2 alone: the relay keeps rebroadcasting it, and the client, which sees no event, may fall back to the voter's own wallet (Outcome). While a deposit is outstanding (sent on L1 and its posting's event not yet on L2) the worker sends no new L2 transaction, since a deposit from the key can consume the nonce a new one would take.

**What a posting shows.** Every posting the relay sends has the same payer, so the chain links the posting key only to postings, which are public anyway, and to their ballots, which a posting names in any case (T-13). The relay sends at once, with no batch: a posting's block says when its request came, to within a tick, which the voter's network address beside it already tells the operator ([[0042-posting-relay]], Known-weak).

## Caps

[[0042-posting-relay]], rule 4, so the relay's spend is bounded by the electorate, never by the requests (T-52):

- **Bytes.** A posting is paid for at most once: `keccak256(posting)` with its transaction is kept until the election's `t_D` passes on the L2's finalized head.
- **Ballots.** At most `POSTING_BALLOT_CAP` ballot hashes per election and (`tier`, `ν`). A member holds one nullifier per tier ([[membership]], Scope; Rolling scope), so the relay pays for at most `2 · s · M` postings in an election of `s` seats and `M` members, whatever anyone makes up: a member can make up ballots that pass the board's check and post against them without casting them ([[contracts]], Board, Known-weak), and this caps how many of them the relay pays for. It is the bound a node's receipts have ([[delivery]], What a node owes): a voter's honest postings need at most two ballots per nullifier, one selected and one cast again after a reorganisation.
- **Gas.** The election budget bounds the relay's L2 spend on one election, whatever its size, and the posting key's float, topped up by hand ([[0042-posting-relay]], Consequences), bounds it across elections.

Past a cap the relay answers `refused` with the cap's code, and the client may fall back to the voter's own wallet ([[0042-posting-relay]], Consequences, Re-votes beyond the cap go direct). What Caps keeps is public on the chain once sent (the postings, their ballots' hashes and nullifiers, the gas), except which of them the relay paid for, which the payer's address shows anyway; it is deleted once the election's `t_D` is final.

## Outcome

The client never stands down on the relay's answer ([[0042-posting-relay]], rule 2). A posting is **recorded** once the client finds its exact bytes as the `record` of a `SharePosted` event of the board, read with the posting's `definition_hash` and `ballot_hash` as topics at the L2's finalized head, through the L2 endpoint the build already uses. Only then is the ballot sent ([[delivery]], Client rules, rule 4). The client:

- sends the same pair again when the relay answers busy or can't be reached, as long as it is before `c_D − POSTING_SEND_MARGIN`;
- falls back (part 2d) when the relay answers `refused`, or when, more than `POSTING_FORCE_AFTER` plus 10 minutes after a `sent` answer, the event is in no L2 block at the latest head and the client finds no deposit of the posting on L1 itself: a `TransactionDeposited` event of the portal the release pins, from the posting key to the board, whose data is the pair's calldata, read through its own L1 endpoint. While such a deposit exists it keeps waiting, since the deposit reaches L2 within `F` of its L1 block, and a voter's own posting beside it would put their address on L2 next to the ballot for nothing (T-13). The relay's `l1` answer names the deposit, but the client looks for it on L1 whatever the relay answered;
- treats the relay as having read `m_i` whenever it answered anything but a transport error, and says so when it offers the fallback ([[0042-posting-relay]], Consequences, The operator learns `m_i`).

## Why these values

- **`POSTING_MAX_DATA`.** The portal's cap on a deposit's data, so a posting the relay sends can always be forced. The largest pair this spec defines is far within it: a version-2 posting at `MAX_OPTIONS` is 5,405 bytes, and the largest ballot record about 82 KB (version 3's 48,380 and version 4's author half at most 33,544 bytes, version 5's `step` four more; [[contracts]], L1 relay, Size), about 87.5 KB of calldata. [[0042-posting-relay]]'s "about 108 KB for their 54 KB" counted only version 3's ballots.
- **`POSTING_BALLOT_CAP`.** [[0042-posting-relay]], rule 4: the number of ballots per (`tier`, `ν`) delivery can select from or a node owes for ([[delivery]], What a node owes).
- **`POSTING_QUEUE_MAX`.** Sixty-four pairs are at most about 5.6 MB in Redis, and the worker clears a full queue in well under a minute; only pairs that pass the public check, which only their voters can make, take a place.
- **`POSTING_WAIT`.** As the ballot and receipt routes' wait: long enough for a simulation and a broadcast, short enough to keep a request from holding a connection.
- **`POSTING_SEND_MARGIN`.** Fifteen minutes for the sequencer to include a call before `c_D`, a few `POSTING_RESEND`s; a posting sent later could miss `t_D` behind a slow sequencer, and the relay can't force it by then.
- **`POSTING_FORCE_AFTER`.** Ten minutes is far beyond a live sequencer's inclusion time and short against `F` (13 hours), so a censored posting is forced with most of its window left.
- **`POSTING_GAS_HEADROOM` and `POSTING_GAS_LIMIT_MAX`.** A deposit's gas limit is fixed when it is sent on L1, against cold state on L2 ([[delivery]], Capacity), so the call's limit sits a quarter above what the simulation used. A posting with its ballot check costs about 434,000 to 544,000 gas at ordinary sizes and about a million at `MAX_OPTIONS` ([[contracts]], Board, Gas); three million covers the largest pair with room, and a call whose simulation needs more is one no honest pair makes.

## Known-weak

- **The relay reads `m_i` before the chain** (T-15): a relay that checks a posting and never sends it has read that seat's share, which the voter agreed to make public but which stays the operator's alone if the voter then declines. The client says so when it offers the fallback (Outcome); fewer than `k` seats read open nothing ([[tally]], Residuals).
- **Our proxy and hosting see each request whole** (T-11, T-69): the voter's network address beside the ballot, as the ballot route sees it when the same client sends that ballot. Nothing of ours keeps it by design.
- **The relay can refuse or delay** (T-25): it is indistinguishable from one whose checks failed. The voter's own wallet is the answer (part 2d); until it is built, a refused voter can only try again or leave the ballot.
- **No forced path after `c_I`**: a posting the voter chooses after `c_I`, or whose force time falls after it, rides the sequencer alone through the relay; a censoring sequencer leaves it to the voter's own wallet, whose deposit Capacity doesn't count either.
- **Postings archive chosen bytes at our expense** (T-17): neither the board nor the public check opens `sealed`, so a voter can put about `64·m + 36` chosen bytes per seat in a posting ([[delivery]], Residuals), and the relay pays for it, within the caps.
- **A posting can be front-run**: anyone who sees the pending call can land the same posting first; the relay's call then repeats it as a no-op ([[contracts]], Board, Repeats) and pays for that, once per posting.
- **The L1 deposit's own cost** isn't in the election budget, which counts L2 gas: deposits are bounded by the postings the caps allow and by the key's L1 float.
- **Timing at the relay.** The relay sends at once, so a posting's block says when its request came, to within a tick (Sending, What a posting shows).
