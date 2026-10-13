# @abolishus/verifier

The independent verifier for [Abolish](https://github.com/abolishus/abolish) elections: downloads the public bulletin board and recomputes and checks the whole election without trusting our servers.

**Status: early.** It reads a local bundle, can read an election's anchors from the board anchor's L1 state, can check an election definition's decoding and well-formedness, and runs the board checks (4.1 and 4.2 of [`docs/spec/verifier.md`](../../docs/spec/verifier.md)). Every other check is reported unverifiable, so no run reports an election verified yet. Prereleases are published as `next`, signed and with provenance (see the repository README, "Releases").

## Use

```ts
import { readBundle, verifyBundle } from "@abolishus/verifier";

const report = verifyBundle(readBundle("path/to/bundle"));
```

A bundle is a directory with `board.bin` (the board copy: its encoded entries in index order) and `bundle.json` (the election identifier, the pinned board-entry version, the anchoring clock, and either `now` and every anchor for the election (format 1) or the L1 evidence they are read from (format 2): an L1 block header, the `eth_getProof` trie nodes of the board anchor's slots, and any checkpoints no copy matches). Format 3 gives the election definition instead of the election identifier, the version and the anchor's address, and takes all three from it; decoding it (definition versions 1, 3 and 4, each under its own layout and rules) and its well-formedness are reported under 2.1, a board-entry version (1, 3 or 4) that doesn't fit its ballot and tally-opening versions fails 2.3, and the report gives its hash, to compare with the one the L2 election registry holds. Format 4 adds the trustee panel the release pins, and runs the key-ceremony transcript check against it: the transcript is the board entry whose hash the definition names, checked with its context rebuilt from the definition and the panel (3.2, and the parts of 2.5 and 3.1 that need no L2 state). Once 3.2 passes, every ballot of the election on the copy is admitted or rejected against the definition and the registered key set (5.1 to 5.4), and the report lists each rejected ballot; a rejected ballot never fails the election. Admitted ballots with the same tier, nullifier and membership message (re-randomised proofs included) are listed as candidate repeats (5.7), rejected once the close rule can run. Every spoiled-ballot opening on the copy is then checked against the same key set (6.2): the report lists each one's failed check, or its tracking code and vote, and the publication rules it is known to break (boarded at or before the counted extent's earliest possible end, opening an admitted ballot's commitment from before then, or repeating an earlier opening's core); an opening never counts or fails anything. Every tally opening on the copy is sorted into a cell or stray and attributed by the same key set's signing keys (7.4), and the report lists each one with the boarding-rule breaches decided without the counted set (stray, another number of entries than options, unattributed, or a seat's second opening of a cell); whether an opening is over the counted set and opens it waits on selection. A definition pinning ballot version 1 with a membership key other than the pinned one fails 1.3. Their exact format, the procedure and the JSON report are under "Inputs, procedure and report" in `docs/spec/verifier.md`.

- **Inputs from a local file authenticate nothing.** Anchors and `now` read from L1 state are only as authentic as the header, the anchor's address and the first segment they are proven from, which are still local files, and so is the definition; until those and the clock come from trusted sources, the report's `verdict` is always `unverifiable`. The report names the L1 block (`l1.blockHash`), so it can be compared with a node you trust. `verdictAgainstInputs` says what the checks found against the bundle's inputs. A crafted bundle can neither verify nor fail an election (T-53, T-24).
- **A bad copy is never the election's failure.** A short or altered copy (`checkpoint-missing`, `copy-mismatch`) is unverifiable from that source, and bytes past the anchored extent change no verdict (T-53); they can change the ballot admission rows, 6.2, 7.4 and the report's `ballots`, `openings` and `tallies`, which report what the copy holds.
- **Malformed bundles are rejected whole** (`BundleError`), before any check runs.

### Command line

```sh
vp node packages/verifier/src/bin.ts path/to/bundle   # from a checkout
```

It prints the JSON report on stdout and a summary on stderr, and exits on `verdict` alone: 0 verified, 20 failed, 21 unverifiable, 22 bundle rejected, 64 usage. Any other code is the verifier's own error, not a verdict. `runCli(args, { stdout, stderr })` runs the same from code. The package doesn't install an `abolish-verify` binary yet: a published gated package may not declare `bin` until CI's policy allows it.

The checks themselves live in `@abolishus/crypto`; this package reads inputs, maps outcomes onto the spec's checks and reports them (T-36).

## Test

```sh
vp run --filter @abolishus/verifier test
```

## License

[Apache-2.0](LICENSE).
