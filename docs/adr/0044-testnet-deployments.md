# ADR 0044: What a testnet deployment needs before the pre-deployment conditions are met

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-30
- Deciders: agent, owner may veto (rule A); any deployment beyond a testnet stays the owner's (mainnet)
- Threats addressed: T-25, T-34, T-53, T-54, T-26, T-64 (see [[THREAT_MODEL]])

## Context

The owner's top priority (2026-10-29, [[P2-32]]) is the contracts on Base Sepolia (84532) and Sepolia (11155111), so that staging can create, open and count a real poll. The spec gives several conditions as "before any registry is deployed". Those written for one contract were each met before that contract was deployable: the close rule ([[close]], [[0030-close-rule]]), membership-checked intake ([[P1-12c]], [[0002-everlasting-privacy]]), retiring every contract-event version up to 11 (rule 9 pins version 12), the superseded tags (`board-checkpoint`, `event-accumulator`, `sig/ceremony-registration`, the version-1 nullifier-key approvals), the self-paid path ([[0024-tier0-registration]], D), regions on groups ([[0019-regional-cells]]) and the contract side of [[P2-16]] part 5. Four are still open on `main`:

1. **Definition versions 1 and 3 are still admitted** ([[contracts]], Election registry, Known-weak). Neither lists receipt keys, so receipts under them are judged by the keys the client's release pinned ([[receipts]]).
2. **The registry's decoder isn't budgeted to the record's limits** under an L2 transaction gas cap ([[contracts]], Election registry, Known-weak, Large definitions). A definition near its list limits could never be registered.
3. **Tier 2 has no addition path** ([[P3-4]]; [[contracts]], Group registry, Known-weak). No Tier 2 group can exist, so every Tier 1 addition reverts.
4. **The nullifier-key events aren't in a contract-event version** (same section). A quorum of the initial panel recording a key would put a log in the group registry's sequence that every reader under version 12 refuses, stopping sealing for every election naming its groups.

Each guards elections that matter: once a registry holds real polls it can't change, so a condition it fails is failed for good. [[P3-4]] is deferred until [[P2-29]] is done (the owner, 2026-10-21, [[STATUS]], Queue), so "every condition first" puts staging behind the whole everyday app.

What is one-way here is the deployment itself: a deployed registry and board are immutable. A testnet deployment, though, holds only staging's polls, which are tests, and a later deployment replaces it with new addresses. Nothing carries its elections forward.

## Options

### A. Every condition first, testnets included

Close all four before any deployment. Pros: one rule everywhere, and the first deployment is the shape production will have. Cons: [[P3-4]] is a large item the owner has deferred. Retiring versions 1 and 3 also means moving the reference election's single-question elections and much of the Foundry suite onto version 4. Staging waits on all of it, against the owner's stated priority.

### B. A testnet waiver for the four open conditions, named and enforced

The conditions stay "before any registry is deployed beyond a testnet". A deployment to Base Sepolia, Sepolia or a local Anvil may go ahead with the four open, on these terms:

- **The deploy script refuses any other chain** while any of them is open. Mainnet stays the owner's.
- **Staging's own path never depends on what is open.** Poll creation registers definition version 5 only ([[poll-creation]]), which binds receipt keys. Staging's polls are a few hundred bytes, far below any gas cap. Staging uses Tier 0 groups only. The launch panel's seats are ours, and they never record a nullifier key.
- **The deployment record and the runbook name the waiver.** [[staging-testnet]] lists the four, and a testnet deployment's record is never pinned by a release offered for real polls.

Pros: staging gets real contracts now. Every open condition still binds production. Cons: the testnet contracts aren't production's bytecode, so staging's verifier runs check a registry that will be replaced. Anyone may still register a version-1 or version-3 poll on the testnet registry, or a large definition that fails. These are liveness and fidelity costs on a testnet, not risks to real polls.

### C. Close the cheap two first, waive only Tier 2's

Retire versions 1 and 3 and budget the decoder, then deploy with only conditions 3 and 4 waived. Pros: the testnet registry is closer to production. Cons: retiring 1 and 3 is the large migration described in A, and the decoder budget needs a measured gas cap for Base Sepolia that may change with an upgrade. Both delay staging, and neither protects anything a testnet holds.

## Recommendation

B. The conditions protect elections that can't be redone. A testnet holds none, and the script's chain check keeps the waiver from reaching anything else. B would change if the owner wanted staging to exercise production's exact bytecode (then C or A), or if a waived condition ever touched staging's own path. For example, if poll creation moved to version 3, condition 1 would bind the testnet too.

## Consequences

- [[contracts]] gains a Testnet deployments section with the four conditions, and each one's own Known-weak line names it.
- [[P2-32]] part 1's deploy script checks the chain ID against the allowed list (84532, 11155111, 31337) and stops otherwise. That check is what keeps the waiver from reaching any chain beyond a testnet.
- Closing the four is still owed before production: versions 1 and 3 and the decoder budget with [[P1-18]]'s remaining deployment needs, Tier 2 and the nullifier-key events with [[P3-4]]. Each one closed comes off the list, and once the list is empty the chain check goes, at the owner's mainnet decision.
- Known-weak: a testnet registry admits versions 1 and 3, and has the decoder's gas limits. A quorum of our own launch seats could record a nullifier key and stop sealing on the testnet, which procedure alone prevents.

## Decision

Under rule A (`AGENTS.md`): option B, status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto in favour of A or C puts those parts first in [[P2-32]] before the deploy script runs on any testnet. Nothing has been deployed meanwhile.
