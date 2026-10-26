#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/destruction-moment.json.

A second implementation of docs/spec/tally.md's Destruction, When: s_T, the
anchoring period holding the tally window's end t_S + TALLY_WINDOW, and t_D,
the later of that end and segment s_T - 1's anchoring deadline, from a close,
its l1_inclusion_bound and the anchoring clock. It is written from the spec
with Python's integers only and shares no code with packages/crypto (nor with
tally-window-vectors.py). Where packages/crypto divides, this finds each
moment's anchoring period by walking the clock's periods, so the two agree
only if both read the spec alike.

Usage: python3 -I -B packages/crypto/scripts/destruction-moment-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import json
import pathlib
import sys

HOUR = 3600
DAY = 24 * HOUR

# docs/spec/parameters.md.
COMPLAINT_WINDOW = 5 * DAY
TALLY_WINDOW = 7 * DAY
# docs/spec/tally.md, Tally window: forced inclusion at 3,600 12-second L1
# slots, an hour of missed slots, half an hour of finality, then boarding.
CONTRACT_EVENT_WINDOW = 3600 * 12 + HOUR + 1800 + 1800
assert CONTRACT_EVENT_WINDOW == 50_400
W_S = COMPLAINT_WINDOW + CONTRACT_EVENT_WINDOW


def period_of(clock, t):
    """The anchoring period holding t: the s with epoch + s·period ≤ t < epoch + (s+1)·period."""
    epoch, period = clock["epoch"], clock["period"]
    assert t >= epoch
    s = 0
    step = 1
    while epoch + (s + step) * period <= t:
        step *= 2
    while step >= 1:
        if epoch + (s + step) * period <= t:
            s += step
        step //= 2
    assert epoch + s * period <= t < epoch + (s + 1) * period
    return s


def segment_end(clock, s):
    """The first second after segment s."""
    return clock["epoch"] + (s + 1) * clock["period"]


def destruction_moment(clock, closes_at, bound):
    # t_S: segment s_S's anchoring deadline, s_S the later of the segment
    # after close's and the one holding the counted window's end.
    s_s = max(period_of(clock, closes_at) + 1, period_of(clock, closes_at + bound + W_S))
    t_s = segment_end(clock, s_s) + clock["deadline"]
    window_end = t_s + TALLY_WINDOW
    s_t = period_of(clock, window_end)
    # Segment s_T - 1 ends where s_T begins (s_T ≥ 1, as s_T > s_S ≥ 1).
    assert s_t >= 1
    previous_deadline = segment_end(clock, s_t - 1) + clock["deadline"]
    t_d = previous_deadline if previous_deadline > window_end else window_end
    binds = "window" if window_end > previous_deadline else "anchoring" if previous_deadline > window_end else "tie"
    return s_s, t_s, s_t, t_d, binds


DEPLOYED = {"epoch": 1_700_000_000, "period": HOUR, "deadline": 12 * HOUR}

CASES = [
    (
        "deployed",
        "Hourly periods and a 12-hour deadline: segment s_T - 1's anchoring deadline is the later",
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
        "close-at-epoch",
        "A close at the epoch itself",
        DEPLOYED,
        1_700_000_000,
        600,
    ),
    (
        "window-binds",
        "A deadline shorter than the window's end's offset in its period: t_D is t_S + TALLY_WINDOW",
        {"epoch": 0, "period": 7000, "deadline": 100},
        1_000_000,
        600,
    ),
    (
        "tie",
        "Deadline 0 and a window ending on a period's first second: both moments are the same second",
        {"epoch": 0, "period": 1, "deadline": 0},
        1_234_567,
        3600,
    ),
    (
        "window-on-boundary",
        "The tally window ends on s_T's first second, so t_D is the deadline past the window's end",
        {"epoch": 0, "period": 100_000, "deadline": 95_200},
        3_000_000,
        0,
    ),
    (
        "floor-binds",
        "A period longer than W_S: s_S is the floor period(closes_at) + 1",
        {"epoch": 0, "period": 1_000_000, "deadline": 0},
        2_000_000,
        0,
    ),
    (
        "long-period",
        "A period longer than the tally window: s_T is s_S + 1 and the window's end binds",
        {"epoch": 5, "period": 2_000_000, "deadline": 7},
        2_000_005,
        0,
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
    bound_by = set()
    for name, description, clock, closes_at, bound in CASES:
        s_s, t_s, s_t, t_d, binds = destruction_moment(clock, closes_at, bound)
        bound_by.add(binds)
        cases.append(
            {
                "id": name,
                "description": description,
                "clock": {k: str(v) for k, v in clock.items()},
                "closesAt": str(closes_at),
                "l1InclusionBound": str(bound),
                "countedSegment": str(s_s),
                "countedDue": str(t_s),
                "segment": str(s_t),
                "due": str(t_d),
            }
        )
    # Each side of the maximum is strictly the later in some case, and some case ties.
    assert bound_by == {"window", "anchoring", "tie"}
    doc = {
        "format": "abolish-destruction-moment-vectors/1",
        "title": "Destruction's fallback moment: s_T and t_D",
        "spec": "docs/spec/tally.md, Destruction, When; Tally window; docs/spec/parameters.md",
        "generator": "packages/crypto/scripts/destruction-moment-vectors.py: an independent Python implementation (each moment's period found by walking the clock, never by division)",
        "windows": {
            "counted": str(W_S),
            "tally": str(TALLY_WINDOW),
        },
        "cases": cases,
    }
    (out / "destruction-moment.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
