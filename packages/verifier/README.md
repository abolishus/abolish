# @abolishus/verifier

The independent verifier for [Abolish](https://github.com/abolishus/abolish) elections: downloads the public bulletin board and recomputes and checks the whole election without trusting our servers.

**Status: early.** It reads a local bundle and runs the board checks (4.1 and 4.2 of [`docs/spec/verifier.md`](../../docs/spec/verifier.md)). Every other check is reported unverifiable, so no run reports an election verified yet. Prereleases are published as `next`, signed and with provenance (see the repository README, "Releases").

## Use

```ts
import { readBundle, verifyBundle } from "@abolishus/verifier";

const report = verifyBundle(readBundle("path/to/bundle"));
```

A bundle is a directory with `board.bin` (the board copy: its encoded entries in index order) and `bundle.json` (the election identifier, the pinned board-entry version, the anchoring clock, `now` and every anchor for the election). Their exact format, the procedure and the JSON report are under "Inputs, procedure and report" in `docs/spec/verifier.md`.

- **Inputs from a local file authenticate nothing.** Until anchors and `now` are read from L1 and the clock from the election definition, the report's `verdict` is always `unverifiable`. `verdictAgainstInputs` says what the checks found against the bundle's inputs. A crafted bundle can neither verify nor fail an election (T-53, T-24).
- **A bad copy is never the election's failure.** A short or altered copy (`checkpoint-missing`, `copy-mismatch`) is unverifiable from that source, and bytes past the anchored extent change nothing (T-53).
- **Malformed bundles are rejected whole** (`BundleError`), before any check runs.

The checks themselves live in `@abolishus/crypto`; this package reads inputs, maps outcomes onto the spec's checks and reports them (T-36).

## Test

```sh
vp run --filter @abolishus/verifier test
```

## License

[Apache-2.0](LICENSE).
