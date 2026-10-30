# ADR 0044: What a testnet deployment needs before the pre-deployment conditions are met

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-30
- Deciders: agent, owner may veto (rule A). Two things stay the owner's: accepting [[delivery]]'s three owner-reserved residuals for a testnet, and any deployment beyond a testnet (mainnet).
- Threats addressed: T-25, T-34, T-53, T-54, T-26, T-64 (see [[THREAT_MODEL]])

## Context

The owner's top priority (2026-10-29, [[P2-32]]) is the contracts on Base Sepolia (84532) and Sepolia (11155111), so that staging can create, open and count a real poll. The spec gives many conditions as "before any registry is deployed" or "before any deployment". Most are met on `main` (the list is in [[P2-32]], Part 1a). Seven are open and the agent can decide on them:

1. **Definition versions 1 and 3 are still admitted** ([[contracts]], Election registry, Known-weak). Neither lists receipt keys, so receipts under them are judged by the keys the client's release pinned ([[receipts]]).
2. **The registry's decoder isn't budgeted to the record's limits** under an L2 transaction gas cap (same section, Large definitions). A definition near its list limits could never be registered.
3. **Tier 2 has no addition path** ([[P3-4]]; [[contracts]], Group registry, Known-weak). No Tier 2 group can exist, so every Tier 1 addition reverts.
4. **The nullifier-key events aren't in a contract-event version** (same section). A quorum of the initial panel recording a key would put a log in the group registry's sequence that every reader under version 12 refuses, stopping sealing for every election naming its groups.
5. **Tally openings have no contract path** ([[tally]], Residuals). An operator that boards no opening fails the election, and nothing attributes the failure to it.
6. **Verifier 1.2's binding of a deployment to the release creation code isn't specified** ([[verifier]] 1.2; T-64). Until it is, 1.2 is `not-implemented` for every deployment, and a deployer's initcode could write storage or logs that forge failures blamed on others.
7. **Groups carry no region** ([[0019-regional-cells]], Consequences): `createGroup` takes a tier only, and `GroupCreated` logs none, so until it does the registration service serves region 0 only, with one published group ([[registration]]).

Three more are [[delivery]]'s residuals, which "MUST be closed, or accepted by the owner, before any election registry is deployed": a newest ballot that never reached the board, approved stubs holding a seat's capacity, and withheld board data keeping a ballot out of a node's complaint scope. The spec reserves accepting them to the owner, so this ADR doesn't decide them.

Each condition guards elections that matter: once a registry holds real polls it can't change, so a condition it fails is failed for good. [[P3-4]] is deferred until [[P2-29]] is done (the owner, 2026-10-21, [[STATUS]], Queue), so "every condition first" puts staging behind the whole everyday app.

What is one-way here is the deployment itself: a deployed registry and board are immutable. A testnet deployment, though, holds only staging's polls, which are tests. A later deployment replaces it with new addresses, and nothing carries its elections forward.

## Options

### A. Every condition first, testnets included

Close all seven (and the three residuals) before any deployment. Pros: one rule everywhere, and the first deployment has production's shape. Cons: [[P3-4]] is a large item the owner has deferred, and so is [[P4-3]]'s data availability, which closes two of the residuals. Retiring versions 1 and 3 also means moving the reference election's single-question elections and much of the Foundry suite onto version 4. Staging waits on all of it, against the owner's stated priority.

### B. A testnet waiver for the seven, named and enforced, with the residuals put to the owner

The seven stay binding on any deployment beyond a testnet. A deployment to Base Sepolia, Sepolia or a local Anvil may go ahead with them open, on these terms:

- **The deploy script refuses any other chain** while any of the seven is open.
- **No release offered for real polls pins a testnet deployment.** This is a release-procedure rule ([[release]]), since anyone can deploy the same bytecode on any chain without the script.
- **Staging's own path never depends on what is open.**
  - Poll creation registers definition version 5 only ([[poll-creation]]), which binds receipt keys.
  - Staging's polls are a few hundred bytes, far below any gas cap.
  - Staging uses Tier 0 groups only, and its registration serves region 0 only, with one published group, so no result depends on a group's region.
  - The launch panel's seats are ours, and they never record a nullifier key.
  - Staging's operator is the only board path for openings, and also the party whose failure the missing contract path would leave unattributed.
  - Staging's verifier runs report 1.2 `not-implemented`, as any run does today.
- **The runbook names the waiver** ([[staging-testnet]]).
- **The owner decides the three residuals.** No testnet deployment is made until the owner has accepted them for testnets or they are closed. The deploy itself is the owner's in any case: part 3's workflow is a `ci:` PR the owner reviews and runs.

Pros: staging gets real contracts as soon as the owner runs the workflow. Every open condition still binds production. Cons: the testnet contracts aren't production's bytecode, so staging's verifier runs check a registry that will be replaced. Anyone may still register a version-1 or version-3 poll on the testnet registry, or a large definition that fails. These are liveness and fidelity costs on a testnet, not risks to real polls.

### C. Close the cheap ones first, waive only the large ones

Retire versions 1 and 3, budget the decoder and specify 1.2's binding, then deploy with only Tier 2's two and the openings' path waived. Pros: the testnet registry is closer to production. Cons: retiring 1 and 3 is the migration described in A. The decoder budget needs a measured gas cap for Base Sepolia that an upgrade may change. The 1.2 binding is a specification of its own (P4-1). Each delays staging, and none of them protects anything a testnet holds.

## Recommendation

B. The conditions protect elections that can't be redone. A testnet holds none of those, and the script's chain check and the release rule keep the waiver from reaching anything else. B would change if the owner wanted staging to exercise production's exact bytecode (then C or A), or if a waived condition ever touched staging's own path. For example, if poll creation moved to version 3, condition 1 would bind the testnet too.

## Consequences

- [[contracts]] gains a Testnet deployments section that lists the seven and the owner's three. Each condition's own statement names that section.
- [[P2-32]] part 1b's deploy script checks the chain ID against 84532, 11155111 and 31337 and stops otherwise.
- The owner is asked to accept, for testnets only, [[delivery]]'s three residuals. This is listed in [[STATUS]] beside the owner's other decisions. Parts 1b and 2 (the script and the record) go ahead meanwhile, and only the deploy waits.
- Closing the seven is still owed before production:
  - versions 1 and 3 and the decoder budget, with [[P1-18]]'s remaining deployment needs;
  - Tier 2 and the nullifier-key events, with [[P3-4]];
  - the openings' path, with [[P1-18]];
  - the 1.2 binding, with [[P4-1]];
  - regions at group creation, with [[P3-2]]'s group registry ([[0019-regional-cells]]).

  So are the two conditions [[contracts]] already gives as before any registry is deployed beyond a testnet: the operator's boarding throughput against self-paid floods ([[P4-3]]) and the review of `SELF_PAID_FEE` (Group registry, Known-weak, Paid floods of self-paid additions). The chain check covers them too.

  Each one closed comes off the list. Once the list is empty, the chain check goes, at the owner's mainnet decision.

- Known-weak:
  - A testnet registry admits versions 1 and 3, and has the decoder's gas limits.
  - A quorum of our own launch seats could record a nullifier key and stop sealing on the testnet. Only procedure prevents it.
  - Staging's operator could withhold openings unattributed.
  - A testnet group's region is only the release's word, so staging can't show regional results.

## Decision

Under rule A (`AGENTS.md`): option B, status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. The three [[delivery]] residuals are the owner's, asked in [[STATUS]]. A veto in favour of A or C puts those parts first in [[P2-32]] before the deploy script runs on any testnet. Nothing has been deployed meanwhile.
