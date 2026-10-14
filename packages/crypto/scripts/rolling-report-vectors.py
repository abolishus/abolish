#!/usr/bin/env python3
"""Prints docs/spec/vectors/rolling-report.json.

Written from docs/spec/membership.md (Rolling tier tree, Root clock and steps,
Reported counts) and docs/spec/board.md (Timing) alone, independently of
packages/crypto, with only the Python standard library. It reuses
rolling-electorate-vectors.py's chain-order leaves, member count and root
clock, which are independent of packages/crypto too. Counts need no tree root,
so no Poseidon2 constants are read.

    python3 -I -B packages/crypto/scripts/rolling-report-vectors.py docs/spec/vectors

then `vp check --fix` to format the JSON.
"""

import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rv = load("rolling_electorate_vectors", "rolling-electorate-vectors.py")
tau, rolling_leaves, member_count = rv.tau, rv.rolling_leaves, rv.member_count
ROOT_PERIOD, ROOT_OFFSET = rv.ROOT_PERIOD, rv.ROOT_OFFSET

# An anchoring clock (board.md, Timing) whose periods don't line up with the
# root clock's boundaries, so a period's end falls between two of them.
EPOCH, PERIOD = 1_779_800_000, 3600


def period_of(ts):
    """The anchoring period holding a timestamp: floor division, negative before the epoch."""
    return (ts - EPOCH) // PERIOD


def period_end(s):
    """The last second of period s."""
    return EPOCH + (s + 1) * PERIOD - 1


def last_boundary(closes_at):
    """n_c: the largest n with τ_n ≤ closes_at."""
    n = (closes_at - ROOT_OFFSET) // ROOT_PERIOD
    assert tau(n) <= closes_at < tau(n + 1)
    return n


def count_through(events, groups, ts):
    return member_count(rolling_leaves(events, groups, lambda e: e["timestamp"] <= ts))


def step_count(events, groups, n):
    return count_through(events, groups, tau(n))


def accepted(events, groups, n, registered_at, closes_at):
    leaves = rolling_leaves(events, groups, lambda e: e["timestamp"] <= tau(n))
    return registered_at < tau(n) <= closes_at and len(leaves) <= 2**32 and member_count(leaves) > 0


def eligible(c, n):
    """E(n): distinct commitments live at some accepted step m <= n, one step at a time."""
    ev, groups = c["events"], c["groups"]
    seen = set()
    m = last_boundary(c["registered_at"]) + 1  # the first boundary after registration
    while m <= n:
        if accepted(ev, groups, m, c["registered_at"], c["closes_at"]):
            seen |= {x for x in rolling_leaves(ev, groups, lambda e: e["timestamp"] <= tau(m)) if x != 0}
        m += 1
    return len(seen)


def report(c):
    """membership.md, Reported counts."""
    ev, groups = c["events"], c["groups"]
    opening = member_count(rolling_leaves(ev, groups, lambda e: e["block"] <= c["root_block"]))
    n_c = last_boundary(c["closes_at"])
    if tau(n_c) > c["registered_at"]:
        close = {"step": str(n_c), "members": str(step_count(ev, groups, n_c)), "accepted": accepted(ev, groups, n_c, c["registered_at"], c["closes_at"])}
        all_eligible = eligible(c, n_c)
    else:
        close, all_eligible = None, 0
    # Every step a ballot with a verifying membership proof names is accepted
    # (verifier 5.1).
    for n in c["ballot_steps"] + [n for _, steps in c["releases"] for n in steps]:
        assert accepted(ev, groups, n, c["registered_at"], c["closes_at"]), (c["id"], n)
    assert len(set(c["ballot_steps"])) <= all_eligible
    if c["ballot_steps"]:
        smallest = min(sorted(set(c["ballot_steps"])), key=lambda n: step_count(ev, groups, n))
        smallest = {"step": str(smallest), "members": str(step_count(ev, groups, smallest))}
    else:
        smallest = None
    growth = {}
    for e in ev:
        if e["group"] not in groups or e["block"] <= c["root_block"] or e["timestamp"] > c["closes_at"]:
            continue
        row = growth.setdefault(period_of(e["timestamp"]), {"added": 0, "removed": 0})
        row["added" if "add" in e else "removed"] += len(e.get("add", e.get("remove")))
    growth = [
        {
            "period": str(s),
            "added": str(r["added"]),
            "removed": str(r["removed"]),
            "members": str(count_through(ev, groups, min(period_end(s), c["closes_at"]))),
        }
        for s, r in sorted(growth.items())
        if r["added"] + r["removed"] > 0
    ]
    releases = []
    for s, steps in c["releases"]:
        n = last_boundary(min(period_end(s), c["closes_at"]))
        terms = ([n] if tau(n) > c["registered_at"] else []) + list(steps)
        if terms:
            n_r = max(terms)
            releases.append({"segment": str(s), "snapshotSteps": [str(m) for m in steps], "step": str(n_r), "count": str(eligible(c, n_r))})
        else:
            releases.append({"segment": str(s), "snapshotSteps": [], "step": None, "count": str(opening)})
    rep = {"opening": {"members": str(opening)}, "eligible": str(all_eligible), "close": close, "smallestStep": smallest, "growth": growth}
    return rep, releases


N0 = rv.N0


def cases():
    def mem(i):
        return 10**12 + i

    t = tau(N0)
    a, b, x = 1, 2, 7  # listed groups a and b; x is never listed
    out = []
    # 1. Growth over several anchoring periods, events between the last
    # boundary and the close and after it, and ballots on several steps.
    out.append(
        {
            "id": "growth-and-steps",
            "note": "two listed groups and an unlisted one; events before and after the definition's registration, across three anchoring periods, between the last boundary and the close (counted in growth, not at close) and after the close (in neither); ballots name four steps, in no order and one twice; the two with the smallest count tie, and the lower is reported",
            "groups": [a, b],
            "root_block": 100,
            "registered_at": t - 500,
            "closes_at": tau(N0 + 12) + 250,
            "events": [
                {"block": 90, "timestamp": t - 2000, "group": a, "add": [mem(1), mem(2), mem(3)]},
                {"block": 100, "timestamp": t - 1000, "group": b, "add": [mem(4)]},
                {"block": 101, "timestamp": t - 998, "group": x, "add": [mem(900), mem(901)]},
                {"block": 102, "timestamp": t - 996, "group": a, "remove": [0]},
                {"block": 300, "timestamp": t + 100, "group": b, "add": [mem(5), mem(6)]},
                {"block": 600, "timestamp": t + 700, "group": a, "remove": [1]},
                {"block": 601, "timestamp": t + 702, "group": a, "add": [mem(7)]},
                {"block": 2000, "timestamp": tau(N0 + 6) + 10, "group": b, "add": [mem(8), mem(9), mem(10)]},
                {"block": 3500, "timestamp": tau(N0 + 12) + 100, "group": a, "add": [mem(11)]},
                {"block": 3600, "timestamp": tau(N0 + 12) + 300, "group": b, "add": [mem(12)]},
            ],
            "ballot_steps": [N0 + 7, N0 + 2, N0 + 12, N0 + 1, N0 + 2],
            "releases": [(period_of(t - 500) - 1, []), (period_of(t - 500), []), (period_of(t + 100), [N0 + 2, N0 + 7]), (period_of(tau(N0 + 7)), [N0 + 1, N0 + 7]), (period_of(tau(N0 + 12)) + 5, [N0 + 12])],
        }
    )
    # 2. No boundary between registration and close: no step, no close count.
    out.append(
        {
            "id": "no-boundary",
            "note": "the poll closes before the first boundary after its registration: no step is accepted, there is no close count and no ballot, and a release reports the opening count",
            "groups": [a],
            "root_block": 200,
            "registered_at": t + 10,
            "closes_at": t + 590,
            "events": [
                {"block": 150, "timestamp": t - 100, "group": a, "add": [mem(20), mem(21)]},
                {"block": 260, "timestamp": t + 300, "group": a, "add": [mem(22)]},
            ],
            "ballot_steps": [],
            "releases": [(period_of(t + 590), [])],
        }
    )
    # 3. Every member removed before the last boundary: the close count is 0
    # and that step isn't accepted; the smallest step is an earlier one.
    out.append(
        {
            "id": "emptied-at-close",
            "note": "every member is removed before the last boundary, so the close count is 0 at a step the poll doesn't accept, never an earlier step's count; a commitment in both groups keeps a leaf in each but counts once, so growth adds leaves and members counts identities",
            "groups": [a, b],
            "root_block": 300,
            "registered_at": t - 50,
            "closes_at": tau(N0 + 3),
            "events": [
                {"block": 300, "timestamp": t - 400, "group": a, "add": [mem(30)]},
                {"block": 400, "timestamp": t + 50, "group": b, "add": [mem(30), mem(31)]},
                {"block": 500, "timestamp": tau(N0 + 1) + 5, "group": a, "remove": [0]},
                {"block": 700, "timestamp": tau(N0 + 2) + 5, "group": b, "remove": [0, 1]},
            ],
            "ballot_steps": [N0 + 1, N0 + 2],
            "releases": [(period_of(tau(N0 + 3)), [N0 + 1])],
        }
    )
    # 4. Every inclusive and exclusive edge: registration exactly at a
    # boundary, events in the opening block and the next, at a boundary, at a
    # period's last second and the next period's first, and at the close and
    # one second after it.
    t4 = tau(N0 + 100)
    s4 = period_of(tau(N0 + 102))
    out.append(
        {
            "id": "edges",
            "note": "registered exactly at a boundary, which is never accepted, so a release whose period ends before the next boundary reports the opening count; an event in the opening block (opening) and one in the next block (growth); an event exactly at a boundary (in that step); events at a period's last second and the next period's first (two rows); and events exactly at the close (counted) and one second after (not)",
            "groups": [a],
            "root_block": 1000,
            "registered_at": t4,
            "closes_at": period_end(s4) + 700,
            "events": [
                {"block": 1000, "timestamp": t4 - 1000, "group": a, "add": [mem(40)]},
                {"block": 1001, "timestamp": t4 - 998, "group": a, "add": [mem(41)]},
                {"block": 1500, "timestamp": tau(N0 + 101), "group": a, "add": [mem(42)]},
                {"block": 1900, "timestamp": period_end(s4), "group": a, "add": [mem(43)]},
                {"block": 1901, "timestamp": period_end(s4) + 1, "group": a, "add": [mem(44)]},
                {"block": 2200, "timestamp": period_end(s4) + 700, "group": a, "add": [mem(45)]},
                {"block": 2201, "timestamp": period_end(s4) + 701, "group": a, "add": [mem(46)]},
            ],
            "ballot_steps": [N0 + 101],
            "releases": [(period_of(t4), []), (s4, [])],
        }
    )
    return out


def main():
    out_dir = pathlib.Path(sys.argv[1])
    gen = (
        "Printed by packages/crypto/scripts/rolling-report-vectors.py, written from docs/spec/membership.md (Rolling "
        "tier tree, Root clock and steps, Reported counts) and docs/spec/board.md (Timing) with only the Python "
        "standard library, independently of packages/crypto, reusing rolling-electorate-vectors.py's chain-order "
        "leaves, member count and root clock."
    )
    vectors = []
    for c in cases():
        got, releases = report(c)
        vectors.append(
            {
                "id": c["id"],
                "note": c["note"],
                "groups": [str(g) for g in c["groups"]],
                "events": [
                    {
                        "block": str(e["block"]),
                        "timestamp": str(e["timestamp"]),
                        "group": str(e["group"]),
                        **({"add": [str(v) for v in e["add"]]} if "add" in e else {"remove": [str(i) for i in e["remove"]]}),
                    }
                    for e in c["events"]
                ],
                "rootL2Block": str(c["root_block"]),
                "registeredAt": str(c["registered_at"]),
                "closesAt": str(c["closes_at"]),
                "ballotSteps": [str(n) for n in c["ballot_steps"]],
                "report": got,
                "releases": releases,
            }
        )
    content = {
        "format": "abolish-rolling-report-vectors/1",
        "title": "What a rolling tier reports: its counts at opening, at close, at the smallest step used and at live releases, and its growth",
        "spec": "docs/spec/membership.md",
        "generator": gen,
        "rootPeriod": str(ROOT_PERIOD),
        "rootOffset": str(ROOT_OFFSET),
        "clock": {"epoch": str(EPOCH), "period": str(PERIOD)},
        "cases": vectors,
    }
    (out_dir / "rolling-report.json").write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
