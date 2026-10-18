# ADR 0035: Where the author panel's key set is registered on L2

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-18
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-25, T-54, T-37, T-14, T-17, T-52 (see [[THREAT_MODEL]])

## Context

A poll with an author panel ([[0027-trustee-panels-and-live-results]], Part 1) shares each ballot's opening to two panels. The board contract checks a direct-submitted ballot's `share-hash-unqualified` over both panels' seats and accepts each seat's share receipts and complaints under its registered per-election signing key ([[contracts]], Board; [[delivery]], Version 2). For the default panel both come from the trustee registry, which records the key set a quorum of a **pinned** panel signed ([[contracts]], Trustee registry). An author panel is never pinned: its keys and threshold are in the definition, and its seats' approvals of their transcript travel only in the author approvals record on the board ([[ceremony]], Author panel). So the board has no author key set to check against, and until it has one the election registry must refuse every definition with an author panel ([[delivery]], Version 2, Boarding, direct submit and client rules; T-25, T-54).

[[delivery]] already fixes what the registered set is: the author panel's key set, registered under a quorum of approvals by the definition's `author_keys` over the ceremony registration statement ([[trustee-identity]], Ceremony registration), which the author seats already sign. [[0034-author-transcript-bytes]] fixes what it may carry: only each seat's `kem_key_hash` and signing key, never the transcript or its `ek`s. What is left is which contract records it and when, which is fixed in bytecode once any registry is deployed.

The registration costs one P-256 verification per approval, and its record carries bytes the author seats choose (about 64 per seat: a `kem_key_hash` no contract can check and a signing key that need only be a point). The trustee registry's own registrations need a quorum of pinned trustees, so only they can add to its shared event sequence, which every verifier replays whole ([[contracts]], Trustee registry, Events). An author panel's keys are whatever its creator lists.

## Options

### A. A new trustee-registry call, open to any panel

`registerAuthorCeremony(panel, registration)` takes the panel's threshold and keys with the registration record, recomputes `author_panel_id` from them, checks the approvals as `registerCeremony` does with the quorum `max(k_A, n_A − 1)`, and records the set under (`author_stub_hash`, `author_panel_id`), where the board reads it with the `keySetOf` it already calls.

- Pros: one code path for both panels' key sets; the board reads one registry.
- Cons: anyone can make up keys, sign for a stub no election will ever register, and append about 1 KB of chosen bytes to the trustee registry's shared sequence per call, for gas alone, with no bound on calls (T-17, T-52). The trustee registry knows no definition, so it can't tell a real author panel from a made-up one. And registration is a separate step from the definition's, so a definition could be registered before its author key set exists, and its ballots would then be checked against an empty author set.

### B. The election registry records it with the definition

A definition with an author panel is registered by `registerDefinitionWithAuthorPanel(definition, authorRegistration)`, which runs every rule of `registerDefinition` and then checks the author registration against the definition it has just decoded: the record's panel, stub and transcript must be the definition's `author_panel_id`, `author_stub_hash` and `author_transcript_hash`, at least `max(k_A, n_A − 1)` distinct author seats must have approved, each signature verifying under its seat's key in `author_keys`, and the key set must pass the trustee registry's key-set checks against `k_A` and `n_A`. It records the set under the definition hash, where the board reads it (`authorKeySetOf`, `authorSigningKeyOf`), and emits the registration record whole. `registerDefinition` refuses any definition with an author panel.

- Pros: the key set exists exactly when the election does, never before or without it, so no author-panel ballot is ever checked against an empty set (T-25, T-54). It is written once per registered election by its creator, so the shared sequence grows only with real elections, by at most one record each (T-17, T-52). The registry already decodes `author_keys` into points (rule 2), and computes stub hashes (rule 8). The default quorum's registration already exists only for an author transcript its seats checked off chain ([[ceremony]], Stub checks, step 5); this makes the registry check it too, so a default quorum that skips step 5 can't get such a definition registered.
- Cons: the board reads two registries for one election's seats. `registerDefinition`'s gas grows by one P-256 verification per author approval, for elections with an author panel only. The election registry's event tables gain an event, so the contract-event version that frames ballot version 4 must carry it too ([[P2-16]] part 5).

### C. The trustee registry, restricted to registered definitions

As A, but the trustee registry pins the election registry (both addresses fixed before deployment, as the board's are) and records an author set only for a definition the election registry has registered with that author panel.

- Pros: bounds A's junk to real elections.
- Cons: the set can only be registered after the definition, so ballots can arrive before it and the board must refuse them, which is a window an operator or a delayed registration controls (T-25). A new cross-contract dependency in both directions, and two transactions where B needs one.

## Recommendation

B. It binds the author key set to the one definition that names it, in the same transaction, so every check that reads it can rely on its existence, and nobody but a creator registering a real election can add to the archive through it. The board reading two registries is a small cost: it already reads the election registry for every check, and the key set is keyed by the definition hash it already has.

What would change it: an author panel that must register after its definition (a re-run of the author ceremony after registration, which [[ceremony]] forbids), or a need to share one author key set between definitions, which no protocol rule has.

## Consequences

- [[contracts]] specifies the call and its checks (Election registry, Author panel registration), the board's ballot-version-4 and delivery-version-2 checks against both panels' sets, and the event, in [[P2-16]] part 5a; part 5's later PRs build them, the contract-event version that frames them and the trustee node's and verifier's reading of them.
- [[ceremony]] (Author panel): the author approvals are now checked on chain at registration, as well as off chain by every default seat, seat and client. The author approvals record on the board stays: clients, seats and the verifier keep reading it, and it costs nothing more.
- Chosen bytes: about 64 per author seat in its key set, plus the approvals' ECDSA nonces, once per registered election, attributable to the author seats' identity keys (T-17). That is within what [[0034-author-transcript-bytes]] accepted for the author transcript, which the same seats fill.
- The approvals sign the 157-byte ceremony registration statement unchanged, naming the deployment's `trustee_registry` though the election registry checks them. The statement binds the chain and the deployment's trustee registry, which rule 4 makes the definition's, and the panel identifier under the author tag, so a default seat's approval never counts for an author panel or the reverse (T-37).
- The election registry doesn't compare author seats' signing keys with the default panel's identity keys, which [[ceremony]]'s cross-panel `duplicate-key` disqualifies: it doesn't hold them. [[verifier]] 3.1 compares the recorded set with its own transcript check, as it does for the default panel.

## Decision

Under rule A (`AGENTS.md`): option B, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto in favour of A or C changes [[contracts]] before any registry is deployed; nothing built from this decision is deployed before the rest of [[P2-16]] part 5.

## Amendment (P2-16 part 5c-1)

Building option B showed that the election registry can't hold the approval and key-set checks in its own code: with OpenZeppelin's P-256 verification and the key-set loop its runtime code is about 26,200 bytes, past EIP-170's 24,576. The election registry still decides and records everything option B describes, in the same transaction: it checks the record's length, its header against the definition and the quorum itself, and has the trustee registry run the key-set and signature checks through a view, `checkAuthorRegistration` ([[contracts]], Trustee registry, Author registration check), passing the definition's author keys as points and `k_A`, and records the set the view returns. The view reads no pinned panel and records nothing. This trusts nothing new: the trustee registry is the deployment's immutable contract the definition names, rule 8 already trusts it with the default panel's ceremony, and its address is the one every author seat's statement names. The checks, their order, their errors and what is recorded are unchanged. Moving the code to a contract the election registry creates was rejected, since verifier 1.2 would then have to bind a further address; splitting the definition decoder out was rejected as a far larger change for the same effect.
