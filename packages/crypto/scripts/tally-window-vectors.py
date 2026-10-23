#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/tally-window.json.

A second implementation of docs/spec/tally.md's Tally window: the counted
extent's last segment s_S and the time its checkpoint is due, t_S, from a
close, its l1_inclusion_bound and the anchoring clock. It is written from the
spec with Python's integers only and shares no code with packages/crypto. Where
packages/crypto divides, this finds each moment's anchoring period by walking
the clock's periods, so the two agree only if both read the spec alike.

Usage: python3 -I -B packages/crypto/scripts/tally-window-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import json
import pathlib
import sys

HOUR = 3600

# docs/spec/parameters.md.
COMPLAINT_WINDOW = 432_000
MAX_SEQUENCING_WINDOW = 3600
L1_SLOT = 12
MISSED_SLOTS = HOUR
L1_FINALITY = 1800
BOARDING_WINDOW = 1800
# docs/spec/tally.md, Tally window: forced inclusion, missed slots, finality
# and boarding, one after another.
CONTRACT_EVENT_WINDOW = MAX_SEQUENCING_WINDOW * L1_SLOT + MISSED_SLOTS + L1_FINALITY + BOARDING_WINDOW
assert CONTRACT_EVENT_WINDOW == 50_400
# The complaint window is the latest that must close before the counted set
# is fixed, each window followed by the contract-event window.
W_S = COMPLAINT_WINDOW + CONTRACT_EVENT_WINDOW


def period_of(clock, t):
    """The anchoring period holding t: the s with epoch + s·period ≤ t < epoch + (s+1)·period."""
    epoch, period = clock["epoch"], clock["period"]
    assert t >= epoch
    s = 0
    # Jump by powers of two, then step, so no division decides it.
    step = 1
    while epoch + (s + step) * period <= t:
        step *= 2
    while step >= 1:
        if epoch + (s + step) * period <= t:
            s += step
        step //= 2
    assert epoch + s * period <= t < epoch + (s + 1) * period
    return s


def counted_extent(clock, closes_at, bound):
    floor = period_of(clock, closes_at) + 1
    s_s = max(floor, period_of(clock, closes_at + bound + W_S))
    end = clock["epoch"] + (s_s + 1) * clock["period"]
    return s_s, end + clock["deadline"]


DEPLOYED = {"epoch": 1_700_000_000, "period": HOUR, "deadline": 12 * HOUR}

CASES = [
    (
        "deployed",
        "Hourly periods and a 12-hour deadline, a close on a period's start and the least bound",
        DEPLOYED,
        1_800_000_000 - (1_800_000_000 - 1_700_000_000) % HOUR,
        600,
    ),
    (
        "deployed-mid-period",
        "The same clock, a close inside a period and the greatest bound",
        DEPLOYED,
        1_800_001_234,
        3600,
    ),
    (
        "window-on-boundary",
        "closes_at + l1_inclusion_bound + W_S is a period's first second, so it is in that period",
        DEPLOYED,
        1_700_000_000 + 1000 * HOUR - 600 - W_S,
        600,
    ),
    (
        "window-before-boundary",
        "One second earlier: the period before",
        DEPLOYED,
        1_700_000_000 + 1000 * HOUR - 601 - W_S,
        600,
    ),
    (
        "close-at-epoch",
        "A close at the epoch itself",
        DEPLOYED,
        1_700_000_000,
        600,
    ),
    (
        "floor-binds",
        "A period longer than W_S: the window ends in close's own period, so s_S is the floor period(closes_at) + 1",
        {"epoch": 0, "period": 1_000_000, "deadline": 0},
        2_000_000,
        0,
    ),
    (
        "floor-binds-at-edge",
        "The window's end on the last second of close's period: still the floor",
        {"epoch": 0, "period": 1_000_000, "deadline": 7},
        3_000_000 - 1 - W_S,
        0,
    ),
    (
        "floor-equals-window",
        "The window's end in the period after close's, which the floor names too",
        {"epoch": 0, "period": 1_000_000, "deadline": 7},
        3_000_000 - W_S,
        0,
    ),
    (
        "one-second-periods",
        "Periods of one second from epoch 0: s_S is closes_at + l1_inclusion_bound + W_S",
        {"epoch": 0, "period": 1, "deadline": 0},
        1_234_567,
        3600,
    ),
    (
        "large",
        "Values beyond 2^53, so an implementation using floating point gets them wrong",
        {"epoch": 2**60, "period": 7 * HOUR + 13, "deadline": 2**40},
        2**60 + 2**58 + 12_345,
        2**33,
    ),
]


def main():
    out = pathlib.Path(sys.argv[1])
    cases = []
    for name, description, clock, closes_at, bound in CASES:
        s_s, t_s = counted_extent(clock, closes_at, bound)
        cases.append(
            {
                "id": name,
                "description": description,
                "clock": {k: str(v) for k, v in clock.items()},
                "closesAt": str(closes_at),
                "l1InclusionBound": str(bound),
                "segment": str(s_s),
                "due": str(t_s),
            }
        )
    doc = {
        "format": "abolish-tally-window-vectors/1",
        "title": "The counted extent: s_S and t_S",
        "spec": "docs/spec/tally.md, Tally window; docs/spec/parameters.md",
        "generator": "packages/crypto/scripts/tally-window-vectors.py: an independent Python implementation (each moment's period found by walking the clock, never by division)",
        "windows": {
            "complaint": str(COMPLAINT_WINDOW),
            "contractEvent": str(CONTRACT_EVENT_WINDOW),
            "boarding": str(BOARDING_WINDOW),
            "counted": str(W_S),
        },
        "cases": cases,
    }
    (out / "tally-window.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
