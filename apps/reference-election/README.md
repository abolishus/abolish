# @abolishus/reference-election

The reference election (AGENTS.md, Reference election; P1-20): the single end-to-end proof that the system works. Internal and source-only; AGPL-3.0-only. It holds no domain logic: every protocol step is a call into `@abolishus/crypto`, the contracts are `packages/contracts`' own build, and the result is judged by `packages/verifier` alone.

## Running

From the repository root, with the toolchain on `PATH` (`.github/scripts/install-toolchain.sh`, for `anvil` and `forge`):

```
vp run reference-election
```

It builds `@abolishus/crypto`, `@abolishus/verifier` and `@abolishus/contracts`, starts its own Anvil on loopback, and writes `reference-election-output/`:

| File                                                            | What it is                                                                                                      |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `stages.json`                                                   | Every stage of AGENTS.md's list with its coverage (`covered`, `partial`, `not-yet`), the stubs, and any failure |
| `bundle/`                                                       | The verifier's input: `bundle.json` (format 4) and `board.bin`                                                  |
| `verifier-report.json`                                          | The verifier's report on `bundle/`                                                                              |
| `control-tampered/`                                             | The same bundle with one byte of the transcript flipped, which must not pass 3.2                                |
| `definition.bin`, `ceremony-transcript.bin`, `display-text.bin` | The records the run made                                                                                        |

It exits non-zero if any stage throws, any check of the report fails, a required check (`expectations.ts`) doesn't pass, the verdict isn't the one its inputs allow, or the control passes.

## What part 1 covers

- **Stage 1, the key ceremony:** a 4-of-7 panel with fresh identity keys runs the four rounds of `docs/spec/ceremony.md` through the production entry points, every seat taking part (ADR 0006, rule 7). The definition binds the transcript by its hash and the ceremony binds the definition's stub hash (T-37). The transcript is board entry 0, and the verifier's 3.2 must pass.
- **Stage 7, in part:** `BoardAnchor` is deployed on Anvil with the 1-hour period and 12-hour deadline of `docs/spec/contracts.md`; the ceremony's segment and the seal are anchored inside their windows. The verifier reads both back from a finalized block's header and `eth_getProof` nodes, and 4.1 and 4.2 must pass (T-23, T-24, T-53).
- **Stage 9, in part:** the verifier runs in a process of its own, from its built package, with an empty environment, over `bundle/` alone (T-36).

Everything else is listed as `not-yet` in `stages.json`, with the item that brings it.

## Stubs

`STUBS` in `src/election.ts`, written into `stages.json`: the L2 contracts are placeholder addresses (nothing is registered on L2), the electorate is one placeholder Tier 0 group, `membership_vk_hash` is a placeholder, the panel is given to the verifier as a local file, the anchoring authority is a one-byte contract Anvil lets the fixture send from rather than the Safe, and the seal is the segment after the ceremony's. Each placeholder is the Keccak-256 of a `reference-election/placeholder/…` label, so none can be taken for a deployment's.

## Keys

The fixture holds no private key (AGENTS.md, Testnets only): it sends from Anvil's unlocked development account and from an impersonated address. Trustee identity secrets are fresh random bytes for each run and never leave the process.

## Tests

`vp run --filter @abolishus/reference-election test`: the RLP encoder against the published examples and a round-trip property, the anchor calldata's one canonical layout, the header rebuilt to an Anvil block's hash, and the report expectations. The end-to-end run itself is the `reference-election` check.
