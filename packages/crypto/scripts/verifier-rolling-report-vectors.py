#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-rolling-report.json.

What each rolling tier of verifier-ballots-v5-tier0-sealed.json's and
verifier-ballots-v5-tier0-live.json's polls reports about its electorate
(docs/spec/verifier.md, Counted set and tally, step 8; docs/spec/membership.md,
Reported counts; P2-17 part 4e-1): its member count at opening, its eligible
count, its count at the last boundary, the smallest step its ballots used and
its growth per anchoring period.

Each poll is rebuilt by its own generator's `build` (every value but the
proofs' bytes, deterministically from fixed labels), whose ballots are every
ballot on that board, each with a membership proof snarkjs verified against
its step's root, and whose events are the group registry's. The counts are
rolling-report-vectors.py's `report`, written from membership.md alone, under
each bundle's anchoring clock. Nothing here shares code with packages/crypto
or packages/verifier.

    python3 -I -B verifier-rolling-report-vectors.py <constants> <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json.
Then `vp check --fix` formats the JSON.
"""

import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rr = _load("rolling_report_vectors", "rolling-report-vectors.py")
sv = _load("verifier_ballots_v5_tier0_sealed_vectors", "verifier-ballots-v5-tier0-sealed-vectors.py")
lv = _load("verifier_ballots_v5_tier0_live_vectors", "verifier-ballots-v5-tier0-live-vectors.py")
r5 = sv.r5


def tier_report(d, events, registered_at, epoch, period, steps):
    """rolling-report-vectors.py's report of the definition's one rolling tier, under (epoch, period)."""
    (tier,) = d["rolling_electorate"]
    # rr's periods are read from its module's clock, so it is set to the bundle's.
    rr.EPOCH, rr.PERIOD = epoch, period
    rep, releases = rr.report(
        {
            "id": "tier 0",
            "events": events,
            "groups": tier["groups"],
            "root_block": tier["root_l2_block"],
            "registered_at": registered_at,
            "closes_at": d["closes_at"],
            "ballot_steps": steps,
            "releases": [],
        }
    )
    assert releases == []
    return {"tier": tier["tier"], "electorate": rep}


def sealed(constants):
    s = sv.build(constants)
    d = s["definition"]
    # The sealed bundle's clock (verifier-ballots-v5-tier0-sealed-vectors.py, assemble).
    epoch = d["closes_at"] - 2 * sv.PERIOD
    steps = [b["step"] for _, b, _ in s["ballots"]]
    return tier_report(d, r5.EVENTS, r5.REGISTERED_AT, epoch, sv.PERIOD, steps)


def live(constants):
    s = lv.build(constants)
    steps = [b["ballot"]["step"] for b in s["ballots"]]
    return tier_report(s["definition"], lv.r5.EVENTS, lv.REGISTERED_AT, lv.EPOCH, lv.PERIOD, steps)


def main():
    constants, out_dir = sys.argv[1], pathlib.Path(sys.argv[2])
    content = {
        "format": "abolish-verifier-rolling-report-vectors/1",
        "title": "What each rolling tier of the Tier-0-only rolling polls through verifyBundle reports about its electorate",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "Printed by packages/crypto/scripts/verifier-rolling-report-vectors.py: each poll rebuilt by its own "
            "generator's build (verifier-ballots-v5-tier0-sealed-vectors.py, verifier-ballots-v5-tier0-live-vectors.py), "
            "its counts by rolling-report-vectors.py's report under the bundle's anchoring clock, independently of "
            "packages/crypto and packages/verifier."
        ),
        "description": (
            "For each vector file, its report's `tiers` electorate counts, as strings: every ballot on its board names "
            "its step with a membership proof that verifies, so every one counts toward the smallest step used."
        ),
        "polls": {
            "verifier-ballots-v5-tier0-sealed.json": [sealed(constants)],
            "verifier-ballots-v5-tier0-live.json": [live(constants)],
        },
    }
    (out_dir / "verifier-rolling-report.json").write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
