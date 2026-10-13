# @abolishus/trustee-node

The node each trustee runs on infrastructure it controls ([[0006-trustees]], Consequences; `docs/status/P2-13.md`). Internal and source-only; AGPL-3.0-only. It runs only what `docs/spec/` defines, calling `@abolishus/crypto` for every message and check and never reimplementing one.

So far it holds the seat's part in the key ceremony (`docs/spec/ceremony.md`). Intake, the tally and destruction come in later parts, and so does the transport to the coordinator: today the duties are a library a caller drives round by round.

## Ceremony duties

`CeremonySeat` answers the coordinator's four rounds and the approval request. Each duty is kept by a write-once record in a `SeatStore` (`FileStore` on disk, `MemoryStore` for tests), written before the node acts, so a crash, a retry or two concurrent requests can't break it:

| Duty                                                                                                                                                                                                                                                                                                                   | Spec                                           | Threats          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------- |
| Stub checks before round 1 and before approval: decoded under the node's own profile, `stub_hash` recomputed (never taken from the coordinator), the pinned panel, chain and trustee registry, [[verifier]] 2.3 and 1.3, then 2.4 through the `ElectorateCheck` the deployment supplies                                | Stub checks                                    | T-17, T-37       |
| A run whose (`stub_hash`, `run_id`) it has seen is refused, recorded before any key exists; every run gets fresh keys, nonces and challenge secrets                                                                                                                                                                    | Ceremony context                               | T-37             |
| One message per round per run: asked again over the same earlier rounds it resends the recorded one, over any other it refuses (`view`), and it answers only over earlier rounds that hold its own messages exactly as sent                                                                                            | Rounds; Security notes, Withholding            | T-14             |
| At most one round-4 message per run, recorded before it is returned, never given over another round 3                                                                                                                                                                                                                  | Soundness                                      | T-14, T-37       |
| Approval of at most one transcript per `stub_hash`, whatever the run: one that holds the rounds the node signed over and every message it sent, checks, and has at least `max(k, n − 1)` qualified seats including the node's own; signed over `key_set_hash` from its own check, never one taken from the coordinator | Approval and re-runs; [[0006-trustees]] rule 7 | T-14, T-37, T-54 |

Refusals are typed (`SeatRefusal`); a refusal sends and records nothing new.

## Known-weak

- **No production `ElectorateCheck`.** [[verifier]] 2.4 against finalized L2 state isn't implemented in `packages/verifier` yet, and the check belongs there (AGENTS.md, the verifier's trust base), so the node takes it as a required function. A deployment needs it before any real ceremony; until then the node runs only in tests.
- **Definition version 1 only.** Stubs of versions 3 and later are refused (`stub-version`) until the node reads their electorates and, for version 6, the author panel's ceremony.
- **Secrets at rest.** `FileStore` keeps the run's KEM secret, signing key and challenge secrets in files readable only by their owner, unencrypted; nothing destroys them yet ([[tally]], Destruction, is a later part). Disk encryption and the destruction duty are the deployment's until then.
- **Equivocation evidence.** The node refuses a transcript holding another message of its seat, or another view of a round it signed over, but doesn't yet publish the two messages, which the spec says it SHOULD.
- **Stricter than the spec on approval.** It approves only after sending all four rounds and only when its own seat qualified. The spec requires the transcript to hold every message the node sent and the rounds it signed over; a node that never revealed could otherwise approve a transcript it can't vouch for.

## Testing

`vp run --filter @abolishus/trustee-node test`: whole ceremonies between nodes through a coordinator that withholds messages, restarts between rounds, replays, equivocation, rule 7 at its boundary, one approval per stub, every stub refusal, and the store's write-once rule (fast-check, honouring `FC_NUM_RUNS`; whole-ceremony properties run a tenth of them).
