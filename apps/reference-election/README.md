# @abolishus/reference-election

The reference election (AGENTS.md, Reference election; P1-20): the single end-to-end proof that the system works. Internal and source-only; AGPL-3.0-only. It holds no domain logic: every protocol step is a call into `@abolishus/crypto`, the contracts are `packages/contracts`' own build, and the result is judged by `packages/verifier` alone.

## Running

From the repository root, with the toolchain on `PATH` (`.github/scripts/install-toolchain.sh`, for `anvil` and `forge`):

```
vp run reference-election
```

It builds `@abolishus/crypto`, `@abolishus/verifier` and `@abolishus/contracts`, starts its own Anvil on loopback, and writes `reference-election-output/`. The verifier's built package and forge's `BoardAnchor` artifact are read by path, not as workspace dependencies, so the verifier runs as a third party would install it; only the root script's `--filter … build` orders those builds.

| Path                                                                  | What it is                                                                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `stages.json`                                                         | Every stage of AGENTS.md's list with its coverage (`covered`, `partial`, `not-yet`), the stubs, and every failure; written however the run ends |
| `honest/bundle/`                                                      | The honest election's verifier input: `bundle.json` (format 4) and `board.bin`; its report is `honest/bundle-report.json`                       |
| `honest/control-tampered-copy/`                                       | The same bundle with one byte of the transcript flipped in the board copy                                                                       |
| `rule-7/bundle/`                                                      | A control election whose ceremony two of the seven seats sat out                                                                                |
| `*/definition.bin`, `*/ceremony-transcript.bin`, `*/display-text.bin` | The records each election's run made                                                                                                            |

It exits non-zero if any stage throws, any check of the honest report fails, a required check (`expectations.ts`) doesn't pass, the verdict isn't the one its inputs allow, or a control's report differs from the rows it pins.

## Controls

A control is something the verifier must not pass, with the rows and codes it must show, so the honest run's passes can't be vacuous or pass for an unrelated reason:

- **`rule-7`:** a second election through the same anchor whose ceremony only 5 of the 7 seats took part in. It is anchored and its quorum of 4 is met, so 4.1 and 4.2 pass, but 3.2 must fail with `ceremony-participation` (ADR 0006, rule 7; T-54).
- **`tampered-copy`:** the honest bundle with its board copy altered. The copy no longer matches its anchors (4.2 `l1-checkpoint-unknown`) or the definition's transcript hash (3.1 `ceremony-transcript-missing`), so 3.2 isn't reached.

## What part 1 covers

- **Stage 1, the key ceremony (partial):** a 4-of-7 panel with fresh identity keys runs the four rounds of `docs/spec/ceremony.md` through the production entry points, every seat taking part (ADR 0006, rule 7). The definition binds the transcript by its hash and the ceremony binds the definition's stub hash (T-37). The transcript is board entry 0, and the verifier's 3.2 must pass. The panel isn't pinned and nothing is registered on L2, so 3.1 can't pass yet.
- **Stage 7, in part:** `BoardAnchor` is deployed on Anvil with the 1-hour period and 12-hour deadline of `docs/spec/contracts.md`; the ceremony's segment and the seal are anchored inside their windows. The verifier reads both back from a finalized block's header and `eth_getProof` nodes, and 4.1 and 4.2 must pass (T-23, T-24, T-53).
- **Stage 9, in part:** the verifier runs in a process of its own, from its built package, with an empty environment, over `bundle/` alone (T-36).

Everything else is listed as `not-yet` in `stages.json`, with the item that brings it.

## Stubs

`STUBS` in `src/election.ts`, written into `stages.json`: the L2 contracts are placeholder addresses (nothing is registered on L2), the electorate is one placeholder Tier 0 group, `membership_vk_hash` is a placeholder, the panel is given to the verifier as a local file, the anchoring authority is a one-byte contract Anvil lets the fixture send from rather than the Safe, and the seal is the segment after the ceremony's. Each placeholder is the Keccak-256 of a `reference-election/placeholder/…` label, so none can be taken for a deployment's.

## Keys

The fixture holds no private key (AGENTS.md, Testnets only): it sends from Anvil's unlocked development account and from an impersonated address. Trustee identity secrets are fresh random bytes for each run and never leave the process.

## Tests

`vp run --filter @abolishus/reference-election test`: the RLP encoder against the published examples and a round-trip property, the anchor calldata's one canonical layout, the header rebuilt to an Anvil block's hash, and the report and control expectations. The end-to-end run itself is the `reference-election` check.
