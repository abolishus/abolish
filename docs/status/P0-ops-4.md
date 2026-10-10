# P0-ops-4: reconcile accepted ADRs and their dependants

- State: done when #27 merges
- Branch: `claude/p0-ops-4`

## Scope

Non-blocking follow-ups from the reviews on #25 (P0-ops-3): a Decision section in [[0003-tally-scheme]] carrying option C over to the commitments of [[0002-everlasting-privacy]]; the spec files and threat files that still call the now-accepted ADRs open; and the tally/destruction work in the spec README's list of what 0002's open questions block.

## Notes

- [[0003-tally-scheme]] gains a Decision section: option C on 0002's commitments (summed shares, the full Fiat–Shamir statement with the key-registration transcript hash, one aggregate per partition cell, openings under the hybrid KEM or Diffie–Hellman only), with the ElGamal-specific Consequences pointing to it.
- Spec: `verifier.md`, `parameters.md` and `domain-separation.md` stop calling 0002 open; the README names P1-15 among the work 0002's owner questions block.
- `generator-h` and `kem/share` move from conditional to reserved in both the spec table and `TAG_REGISTRY` (`packages/crypto`), which a test keeps equal; neither tag frames a hash input until specified, so behaviour is unchanged.
- Threats T-28, T-50, T-51 and T-70 move from Needs decision to Planned, and T-31 to Partial (P1-10 built part of it), with History lines; owner-only limits (mainnet, funded upload) stay in their statuses.
- Tested: `vp check`; an in-session subagent review with the `crypto-review` checklist found nothing blocking, and its non-blocking findings are applied.
- Known-weak: T-14 still reads Needs decision (P1-4, P1-7), which stays right while P1-7 is the owner's.
- `crypto-review` on #27 (non-blocking, applied): the tally partition is fixed in the registered election definition (T-16); verifier check 7.2 checks summed shares against the VSS commitments and each cell's opening, 7.4, 8.1 and 8.2 work per cell; `generator-h` cites binding (T-28, T-29, T-39); 0003's known-weak note names the fallback and Diffie–Hellman-only exceptions to T-15.
