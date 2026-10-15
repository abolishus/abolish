# ADR 0031: National-scale delivery obligation

- Status: Accepted (agent) — owner may veto (2026-10-15, rule A): option C
- Date: 2026-10-15
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-25, T-52, T-54, T-17, T-24, T-53 (see [[THREAT_MODEL]])

## Context

A trustee node owes, through the contract path, at most two share receipts and two complaints per (`tier`, `ν`) of an election ([[delivery]], What a node owes), and lends its keys only to elections whose obligation it can force through L1 by the deadlines at the portal's sustainable deposit target, 2,000,000 gas per L1 block shared with every depositor ([[delivery]], Capacity). Every record per receipt or complaint costs L1 deposit gas, so the cap grows only linearly with what each record costs:

- one record per receipt (P1-12c): 1,152 members with 3 seats at `R` of one hour;
- share-receipt batches ([[P1-12d]], about 4,100 gas a receipt) and share-complaint batches (P1-12e, about 3,300 gas a complaint): 20,992 members with 3 seats at `R` of one hour, and about 441,000 at `R` of 21 hours, the most the windows allow.

A national referendum has over 150 million eligible members. At 4,100 gas a receipt, two receipts a member and 7 seats, its receipts alone are about 8.6 × 10¹² gas, some 4.3 million L1 blocks of the whole deposit target, about two years. No per-receipt record on L1, or in L2 data forced through L1, carries it. The brief requires civic referendums at national scale ([[PROJECT_BRIEF]]), so the per-receipt forced path can't be the only one.

What is one-way: the delivery check is part of every verifier's judgement of every past election, the records and the board's calls are immutable once deployed, and the windows (`DELIVERY_WINDOW`, `COMPLAINT_WINDOW`) are constants of the delivery records' version. Nothing is deployed yet.

## Options

### A. Per-record batches only

Keep the forced path as P1-12d and P1-12e leave it, and cap civic elections at what it carries. Pros: built; no new availability assumption; every receipt is in L2 data, which every trustee's L2 node reads. Cons: about 440,000 members with 3 seats at best, shared with every other election and depositor, so no national referendum (T-25, T-54).

### B. Receipts in L1 blobs

At `c_I` each node posts its owed receipts as batches in EIP-4844 blobs of its own L1 transactions to an immutable L1 contract that records each blob's versioned hash; blobs live about 18 days, longer than the windows, and are archived afterwards with their KZG openings so verifiers check them against the hashes on L1. Pros: L1 inclusion, not a sequencer's; blob gas is far cheaper than calldata. Cons: a blob holds about 2,000 pairs, so 2.1 × 10⁹ pairs (150 million members, two receipts, 7 seats) is about a million blobs, months at the blob target; and blob prices rise with demand. It moves the cap by a constant, as A does.

### C. A committed obligation root

At `c_I` each node commits to what it owes as one record: a Merkle root over its owed receipts, sorted by ballot hash, with their count, signed by the seat's per-election key and sent through the contract path (one forced deposit per seat, whatever the electorate). Its leaves (the receipts themselves) are published in the board archive under [[0029-board-data-availability]]'s availability rule, and the root's record names their content address. The delivery check reads a seat as delivered for a ballot when a receipt in time for it is on the board or in L2 data as today, or is a leaf of that seat's root with an inclusion proof against it; complaints work the same way over a second root. A seat whose root's leaves are unavailable at the seal's deadline is reported against that seat, and the ballots it would deliver count only through the other paths.

Pros: the forced path carries a constant per seat, so the cap is lifted for the electorate size; the leaves cost archive storage, not L1 gas; a client can still check its own receipt's inclusion from the node's proof before close of the windows. Cons: a new availability assumption for the leaves, though no weaker than the board's own under [[0029-board-data-availability]]; a seat that withholds its leaves drops the ballots it alone would deliver, which it could already do by refusing intake, and here it is attributed (T-25, T-54); the root binds the node's view at `c_I`, so its contents must be exactly what What a node owes selects, which the verifier can't recompute from the board alone where the operator withheld data (as today).

## Recommendation

C, with A kept as the path for small elections and for clients' own receipts. Only C's forced-path cost is independent of the electorate; B and A only move a linear cap. C rests the leaves' availability on the rule the board already rests on, and attributes withholding to the seat that does it. What would change this: a data-availability layer whose availability the verifier can check from chain alone (data-availability sampling on L1 at the needed scale), which would make B's or C's leaves cheaper to guarantee, not change the shape.

## Consequences

- [[P1-12e]] builds the complaint batches (which also raise A's cap at long `R`); a new item builds C: the obligation-root record and its signed tag, its leaves' layout and content address, the board call and its event in a new contract-event version, the delivery check's inclusion path, the report code for unavailable leaves, and the capacity check reduced to a constant per seat for elections that use it. It must be decided before any election registry is deployed, together with any change to the windows it needs.
- The trustee node's intake and decision at `c_I` are unchanged: only how it delivers what it owes changes.
- Known-weak: until C is built, civic elections are capped at what A carries.

## Decision

Under rule A (`AGENTS.md`): option C, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. Nothing is built yet.
