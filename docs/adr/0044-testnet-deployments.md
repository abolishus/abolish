# ADR 0044: What the staging deployment needs before the pre-deployment conditions are met

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-30
- Deciders: agent, owner may veto (rule A). Two things stay the owner's: accepting [[delivery]]'s three owner-reserved residuals for the staging deployment, and any deployment other than the staging one, mainnet included.
- Threats addressed: T-25, T-34, T-53, T-54, T-26, T-64 (see [[THREAT_MODEL]])

## Context

The owner's top priority (2026-10-29, [[P2-32]]) is the contracts on Base Sepolia (84532) and Sepolia (11155111), so that staging can create, open and count a real poll. The spec gives many conditions as "before any registry is deployed" or "before any deployment". Most are met on `main` (the list is in [[P2-32]], Part 1a). Nine are open and the agent can decide on them:

1. **Definition versions 1 and 3 are still admitted** ([[contracts]], Election registry, Known-weak). Neither lists receipt keys, so receipts under them are judged by the keys the client's release pinned ([[receipts]]).
2. **The registry's decoder isn't budgeted to the record's limits** under an L2 transaction gas cap (same section, Large definitions). A definition near its list limits could never be registered.
3. **Tier 2 has no addition path** ([[P3-4]]; [[contracts]], Group registry, Known-weak). No Tier 2 group can exist, so every Tier 1 addition reverts.
4. **The nullifier-key events aren't in a contract-event version** (same section). A quorum of the initial panel recording a key would put a log in the group registry's sequence that every reader under version 12 refuses, stopping sealing for every election naming its groups.
5. **Tally openings have no contract path** ([[tally]], Residuals). An operator that boards no opening fails the election, and nothing attributes the failure to it.
6. **Verifier 1.2's binding of a deployment to the release creation code isn't specified** ([[verifier]] 1.2; T-64). Until it is, 1.2 is `not-implemented` for every deployment, and a deployer's initcode could write storage or logs that forge failures blamed on others.
7. **Groups carry no region** ([[0019-regional-cells]], Consequences): `createGroup` takes a tier only, and `GroupCreated` logs none, so until it does the registration service serves region 0 only, with one published group ([[registration]]).
8. **An obligation root holds an election's counted set open** ([[P1-12f]] part 3; [[STATUS]], Known-weak). The board has the root call, but the verifier doesn't read a root's leaves yet, so one registered seat, or anyone holding its per-election key, can send a root that leaves an election's 5.9 and tally unverifiable, never failed (T-25).
9. **`tally-late` isn't built** ([[verifier]] 5.6, 7.1; [[STATUS]], Known-weak). The contract-event window is fixed in the registry's bytecode ([[P1-18b]]), so what is left is the verifier's, but the gate is written as "no election registry is deployed before it". Until it is built, a board with a contract-path delivery record or an ordinary ballot leaves 7.1 unverifiable.

Three more are [[delivery]]'s residuals, which "MUST be closed, or accepted by the owner, before any election registry is deployed": a newest ballot that never reached the board, approved stubs holding a seat's capacity, and withheld board data keeping a ballot out of a node's complaint scope. The spec reserves accepting them to the owner, so this ADR doesn't decide them.

Each condition guards elections that matter: once a registry holds real polls it can't change, so a condition it fails is failed for good. [[P3-4]] is deferred until [[P2-29]] is done (the owner, 2026-10-21, [[STATUS]], Queue), so "every condition first" puts staging behind the whole everyday app.

What is one-way here is the deployment itself: a deployed registry and board are immutable. The staging deployment, though, holds only staging's polls, which are tests, and this ADR waives nothing for any other. A later deployment replaces it with new addresses, and nothing carries its elections forward.

## Options

### A. Every condition first, testnets included

Close all nine (and the three residuals) before any deployment. Pros: one rule everywhere, and the first deployment has production's shape. Cons: [[P3-4]] is a large item the owner has deferred, and so is [[P4-3]]'s data availability, which closes two of the residuals. Retiring versions 1 and 3 also means moving the reference election's single-question elections and much of the Foundry suite onto version 4. Staging waits on all of it, against the owner's stated priority.

### B. A waiver for the staging deployment only, named and enforced, with the residuals put to the owner

The waiver is scoped to staging's deployment, not to chain IDs: every deployment before mainnet runs on Base Sepolia and Sepolia, a public or production one included (the brief allows testnets only until mainnet). The staging deployment is the one made for the `staging` environment: the deploy workflow's input names it, its deployment files record it, and only staging releases bind it. It may go ahead with the nine open, on these terms:

- **Any other deployment meets all nine and the owner's three residuals,** whatever chain it is on. That includes a public or production deployment on a testnet before mainnet.
- **The deploy script requires the explicit staging target** while any of the nine is open, refuses any other target, and refuses every chain but 84532, 11155111 and 31337.
- **A release offered for real polls is any release not built for the staging environment.** None binds the staging deployment. This is a release-procedure rule ([[release]]), since anyone can deploy the same bytecode on any chain without the script.
- **Staging's own path never depends on what is open.**
  - Poll creation registers definition version 5 only ([[0032-poll-creation-operations]]; `packages/core/src/poll-registration.ts`), which binds receipt keys. Moving it to version 6 ([[P2-16]] part 5) doesn't reopen condition 1, which concerns versions 1 and 3 only.
  - Staging's polls are a few hundred bytes, far below any gas cap.
  - Staging uses Tier 0 groups only, and its registration serves region 0 only, with one published group, so no result depends on a group's region.
  - The launch panel's seats are ours, and they never record a nullifier key.
  - Staging's operator is the only board path for openings, and also the party whose failure the missing contract path would leave unattributed.
  - Staging's seats are ours and send no roots ([[P1-12f]] part 3c builds them). A leaked seat key could hold a staging poll unverifiable, which costs a test.
  - Staging's verifier runs report 1.2 `not-implemented`, as any run does today.
- **The runbook names the waiver** ([[staging-testnet]]).
- **The owner decides the three residuals.** The staging deployment isn't made until the owner has accepted them for it or they are closed. The deploy itself is the owner's in any case: part 3's workflow is a `ci:` PR the owner reviews and runs.

Pros: staging gets real contracts as soon as the owner runs the workflow. Every open condition still binds production. Cons: the testnet contracts aren't production's bytecode, so staging's verifier runs check a registry that will be replaced. Anyone may still register a version-1 or version-3 poll on the testnet registry, or a large definition that fails. These are liveness and fidelity costs on staging, not risks to real polls. If 1.2's binding is later specified in a form an earlier deployment can't meet (a pinned factory, say), the staging deployment never passes 1.2, which costs only its tests.

### C. Close the cheap ones first, waive only the large ones

Retire versions 1 and 3, budget the decoder and specify 1.2's binding, then deploy with only Tier 2's two and the openings' path waived. Pros: the testnet registry is closer to production. Cons: retiring 1 and 3 is the migration described in A. The decoder budget needs a measured gas cap for Base Sepolia that an upgrade may change. The 1.2 binding is a specification of its own (P4-1). Each delays staging, and none of them protects anything a testnet holds.

## Recommendation

B. The conditions protect elections that can't be redone. The staging deployment holds none of those. The script's staging target and the release rule keep the waiver from reaching any other deployment, a public one on a testnet included. B would change if the owner wanted staging to exercise production's exact bytecode (then C or A), or if a waived condition ever touched staging's own path. For example, if poll creation moved to version 3, condition 1 would bind the testnet too.

## Consequences

- [[contracts]] gains a Testnet deployments section that lists the nine and the owner's three. Each condition's own statement names that section.
- [[P2-32]] part 1b's deploy script takes an explicit target, and while any of the nine is open it deploys only the staging target, and only on 84532, 11155111 or 31337. Its deployment files record the target.
- The owner is asked to accept, for the staging deployment only, [[delivery]]'s three residuals. This is listed in [[STATUS]] beside the owner's other decisions. Parts 1b and 2 (the script and the record) go ahead meanwhile, and only the deploy waits.
- Closing the nine is still owed before production:
  - versions 1 and 3 and the decoder budget, with [[P1-18]]'s remaining deployment needs;
  - Tier 2 and the nullifier-key events, with [[P3-4]];
  - the openings' path, with [[P1-18]];
  - the 1.2 binding, with [[P4-1]];
  - regions at group creation, with [[P3-2]]'s group registry ([[0019-regional-cells]]);
  - the obligation roots' leaves, with [[P1-12f]] part 3;
  - `tally-late`, with [[P1-19]].

  So are the two conditions [[contracts]] already gives as "before any registry is deployed beyond a testnet", read as binding every deployment but the staging one: the operator's boarding throughput against self-paid floods ([[P4-3]]) and the review of `SELF_PAID_FEE` (Group registry, Known-weak, Paid floods of self-paid additions). The chain check covers them too.

  Each one closed comes off the list. Once the list is empty, the staging-only check goes.

- Known-weak:
  - The staging registry admits versions 1 and 3, and has the decoder's gas limits.
  - A quorum of our own launch seats could record a nullifier key and stop sealing on the staging deployment. Only procedure prevents it.
  - Staging's operator could withhold openings unattributed.
  - A staging group's region is only the release's word, so staging can't show regional results.
  - A root sent for a staging poll leaves it unverifiable.
- Nothing but release procedure checks the rule that no release for real polls binds the staging deployment, or any deployment on chain 84532, 11155111 or 31337 while one of the nine is open. A release offered for real polls is defined now, as any release not built for the staging environment, so a reviewer can apply the rule. A verifier or release-builder check is owed before the first such release ([[P4-4]]'s release checks, or [[P1-19]] 2.3). It needs the distinction recorded where the check can read it, for example a field of the release or deployment record, or the registry it is published in. Until then only a reviewer reading the deployment record tells the two apart, and verifier 1.2, which stays `not-implemented`, keeps any election on the staging deployment from verifying.

## Decision

Under rule A (`AGENTS.md`): option B, status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. The three [[delivery]] residuals are the owner's, asked in [[STATUS]]. A veto in favour of A or C puts those parts first in [[P2-32]] before the deploy script runs on any testnet. Nothing has been deployed meanwhile.
