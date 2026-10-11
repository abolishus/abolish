# ADR 0008: Draft record layouts

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-11
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-31, T-34, T-36 (see [[THREAT_MODEL]])

## Context

[[versioning]] freezes a record version as soon as it appears in a published vector file or is anchored on any chain. After that, a `(record_type, version)` pair means one layout forever, and any change is a new version. Every retired version must still be decoded and verified by every verifier for as long as any election that used it exists ([[0001-canonical-encoding]]).

P1-10b specifies version 1 of the election definition (`0x0001`) and display text (`0x0009`) before the items that own several of the definition's fields exist: the panel and ceremony (P1-14), the electorate and verification key (P1-17), and the contracts and timing (P1-18). Each of those is likely to change at least one field. Under the base rule, publishing P1-10b's vectors freezes version 1 now, and each later change spends a version number that verifiers then support forever, even though no election ever used the earlier ones.

Whether to relax the canonical-encoding versioning policy for this is a decision about a permanent encoding, so it gets an ADR.

## Options

### A. Freeze on publication (the base rule)

Version 1 freezes with its vectors. Changes from P1-14, P1-17 and P1-18 become versions 2, 3 and so on, and version 1 is retired.

- Pros: one `(type, version)` pair always means one layout, with no exceptions to explain (T-31). It is the simplest rule.
- Cons: every unused early version stays in every verifier forever. Retirement cutoffs pile up for versions no election ever pinned. Each version is a new layout that third-party verifiers must implement and test.

### B. Draft layouts with safeguards

A version can be marked draft when it is first specified. Its vectors don't freeze it, and the items owning its fields may change it in place. Safeguards:

- Never on a public chain, testnet included, and never in a real election. A local, throwaway chain (Anvil in the reference election) doesn't freeze a draft layout, or a tag whose input is one.
- Verifiers report any election pinning a draft as unverifiable ([[verifier]] 8.3). They have no option to accept a draft except on a local chain ID.
- The ballot client refuses to cast in an election that pins a draft, except on a local chain.
- `packages/crypto` lists the draft versions, and a test ties that list to the registry.
- The PR that freezes a draft records a freeze cutoff: an L1 block at or after that PR merges. A definition registered at or before the cutoff that pins the formerly draft version is unverifiable.
- Vector files carry `"draft": true`, so a third-party implementer knows the layout may still change.

- Pros: verifiers carry only the layouts real elections use. Cross-language vectors exist from the start, so Solidity and Noir consumers can be tested early.
- Cons: until a draft is frozen, one `(type, version)` pair can mean different layouts at different commits. A third-party decoder built from draft vectors can disagree with a later one. Only verifiers that carry the draft list and the cutoffs are protected, and contracts can't tell a draft from its frozen successor by the version byte.

### C. Hold the vectors back

Specify the layouts, but publish no vectors until P1-14, P1-17 and P1-18 are done.

- Pros: the base rule is untouched.
- Cons: it breaks "spec and vectors move together" ([[versioning]]), and leaves the codecs without cross-language vectors for weeks (T-31, T-36).

## Recommendation

A. Option B's cost looked confined to the draft period, but it weakens two freeze rules that third-party verifiers, and later the Solidity and Noir consumers of the vectors, rely on today: during the draft period one `(type, version)` pair can mean different layouts, and the safeguard rests on a draft list and a verifier check (8.3) that no verifier implements yet, while contracts can't tell a draft from its frozen successor (T-31, T-36). Option C breaks "spec and vectors move together". Option A's cost is a few early versions that verifiers carry for good, which is the price [[0001-canonical-encoding]] already accepts for every change.

## Consequences

- [[versioning]] and [[domain-separation]] keep their freeze rules unchanged: a record version or tag freezes when its vectors are published, or when it is anchored on any chain.
- The election definition (`0x0001`) and display text (`0x0009`), version 1, are frozen now. When P1-14, P1-17, P1-18 or the owner's trustee decision ([[0006-trustees]]) needs a field changed, that item specifies version 2 (or later) with its own vectors, and version 1 is retired with a cutoff as [[versioning]] describes.
- Nothing in the protocol, the verifier or `packages/crypto` distinguishes draft from frozen layouts.

## Decision

Option A, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. An earlier revision of this ADR in #35 chose B; `claude-review` blocked it for weakening the freeze rules, and A was chosen instead. Vetoing it in favour of B means reintroducing the draft rule as that revision described it.
