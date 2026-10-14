#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/live-release.json.

A second implementation of docs/spec/tally.md, Live results: the release
schedule, the running sets of a tier's cells over its scheduled snapshots,
the change and the entries between two running sets, the release graph and
its least positive directed cut, and the release choice with its lag. It is
written from the spec with Python's standard library only and shares no code
with packages/crypto.

The least positive directed cut is computed twice, as the least maximum flow
along an edge (Edmonds-Karp over unit capacities) and by trying every vertex
set, and the generator stops if they disagree. For graphs of up to five
vertices it also checks the theorem the spec relies on: the smallest
non-empty side (the nullifiers weighted positively, or those weighted
negatively) of any integer combination of the releases, every combination
with coefficients from -2 to 2 tried, is the least positive directed cut.

Usage: python3 -I -B packages/crypto/scripts/live-release-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import collections
import itertools
import json
import pathlib
import sys

MIN_LIVE_BATCH = 20


# Schedule (tally.md, Live results: Schedule).


def period_of(t, epoch, period):
    return (t - epoch) // period


def scheduled_snapshots(epoch, period, opens_at, closes_at, live_every):
    s_open = period_of(opens_at, epoch, period)
    s_close = period_of(closes_at, epoch, period)
    out = []
    r = 1
    while True:
        sigma = s_open + r * live_every - 1
        if sigma >= s_close:
            return out
        out.append(sigma)
        r += 1


# Running sets (tally.md, Live results: Running set).
#
# Each nullifier of a tier is given as its distinct ballots (repeats are one
# ballot), each with the cell it names and the first scheduled snapshot index
# at which it is admitted, at which every qualified seat of every panel has a
# passing receipt for it, and at which a passing posting names it (None:
# never by the last snapshot).


def qualifying(ballots, r):
    """Conditions 1 to 3 at snapshot r: the one ballot that qualifies, or None."""
    admitted = [b for b in ballots if b["admitted"] is not None and b["admitted"] <= r]
    if len(admitted) != 1:
        return None
    b = admitted[0]
    if b["receipted"] is None or b["receipted"] > r:
        return None
    if b["posted"] is not None and b["posted"] <= r:
        return None
    return b


def running_sets(nullifiers, snapshots, cells):
    """Per cell, the running sets of snapshots 0..snapshots (index 0 is R_0).

    A nullifier enters with the one ballot that qualifies (conditions 1 to 3),
    stays with it after a re-vote or tie, and leaves for good once a passing
    posting for that ballot is boarded (condition 4)."""
    out = [[{}] for _ in range(cells)]
    for r in range(1, snapshots + 1):
        for c in range(cells):
            out[c].append({})
        for nid, ballots in nullifiers.items():
            held = [(c, out[c][r - 1][nid]) for c in range(cells) if nid in out[c][r - 1]]
            if held:
                c, bid = held[0]
                b = next(x for x in ballots if x["id"] == bid)
                if b["posted"] is None or b["posted"] > r:
                    out[c][r][nid] = bid
                continue
            if any(nid in out[c][i] for c in range(cells) for i in range(1, r)):
                continue
            b = qualifying(ballots, r)
            if b is not None:
                out[b["cell"]][r][nid] = b["id"]
    return out


def change(a, b):
    return sum(1 for n in set(a) | set(b) if a.get(n) != b.get(n))


def entries(earlier, later):
    return sum(1 for n in later if n not in earlier)


# Release graph (tally.md, Live results: Change and the release graph).


def release_graph(sets):
    """sets: running sets of the vertices 1..m (vertex 0 is the empty set).
    Each nullifier is an edge from the vertex before its run to its last."""
    seen = {}
    for i, s in enumerate(sets, start=1):
        for n, ballot in s.items():
            seen.setdefault(n, []).append((i, ballot))
    edges = []
    for n in sorted(seen):
        idx = [i for i, _ in seen[n]]
        assert len({b for _, b in seen[n]}) == 1, "a nullifier's entry never changes ballot"
        assert idx == list(range(idx[0], idx[-1] + 1)), "a nullifier's run is unbroken"
        edges.append((idx[0] - 1, idx[-1], n))
    return len(sets) + 1, edges


def max_flow(nv, edges, s, t):
    cap = collections.defaultdict(int)
    adj = collections.defaultdict(set)
    for u, v, _ in edges:
        cap[(u, v)] += 1
        adj[u].add(v)
        adj[v].add(u)
    flow = 0
    while True:
        prev = {s: None}
        queue = collections.deque([s])
        while queue and t not in prev:
            u = queue.popleft()
            for v in sorted(adj[u]):
                if v not in prev and cap[(u, v)] > 0:
                    prev[v] = u
                    queue.append(v)
        if t not in prev:
            return flow
        v = t
        while prev[v] is not None:
            u = prev[v]
            cap[(u, v)] -= 1
            cap[(v, u)] += 1
            v = u
        flow += 1


def sides(edges, members):
    entering = [n for u, v, n in edges if u not in members and v in members]
    leaving = [n for u, v, n in edges if u in members and v not in members]
    return entering, leaving


def directed_cut_bruteforce(nv, edges):
    best = None
    witness = None
    for size in range(1, nv):
        for u in itertools.combinations(range(1, nv), size):
            for side, part in zip(("entering", "leaving"), sides(edges, set(u))):
                if part and (best is None or len(part) < best):
                    best, witness = len(part), (list(u), side, sorted(part))
    return best, witness


def directed_cut(nv, edges):
    best = None
    for u, v in sorted({(u, v) for u, v, _ in edges}):
        f = max_flow(nv, edges, u, v)
        if best is None or f < best:
            best = f
    brute, witness = directed_cut_bruteforce(nv, edges)
    assert best == brute, (best, brute)
    return best, witness


def smallest_side(nv, edges):
    """The smallest non-empty side of any combination of releases 1..nv-1, by search."""
    best = None
    for coeffs in itertools.product(range(-2, 3), repeat=nv - 1):
        prefix = [0]
        for c in coeffs:
            prefix.append(prefix[-1] + c)
        pos = sum(1 for u, v, _ in edges if prefix[v] > prefix[u])
        neg = sum(1 for u, v, _ in edges if prefix[v] < prefix[u])
        for part in (pos, neg):
            if part > 0 and (best is None or part < best):
                best = part
    return best


def graph_case(name, note, sets):
    nv, edges = release_graph(sets)
    d, witness = directed_cut(nv, edges)
    if nv <= 5:
        assert smallest_side(nv, edges) == d, name
    pair = {}
    full = [{}] + sets
    for i in range(nv):
        for j in range(i + 1, nv):
            pair[f"{i}-{j}"] = change(full[i], full[j])
    case = {
        "id": name,
        "description": note,
        "runningSets": [dict(sorted(s.items())) for s in sets],
        "edges": [[u, v, n] for u, v, n in edges],
        "changes": pair,
        "minPairwiseChange": min(pair.values()),
        "directedCut": d,
        "cutWitness": None,
        "combination": None,
        "isolated": None,
    }
    if d is not None:
        members, side, part = witness
        ind = [1 if i in members else 0 for i in range(nv)]
        coeffs = [ind[i] - ind[i - 1] for i in range(1, nv)]
        prefix = [0]
        for c in coeffs:
            prefix.append(prefix[-1] + c)
        sign = 1 if side == "entering" else -1
        isolated = sorted(n for u, v, n in edges if (prefix[v] - prefix[u]) * sign > 0)
        assert isolated == part and len(part) == d
        case["cutWitness"] = {"set": members, "side": side}
        case["combination"] = coeffs
        case["isolated"] = {"sign": sign, "nullifiers": part}
    return case


# Release choice (tally.md, Live results: Release choice).


def qualifies(cells_sets, chosen, q, r, b, rules):
    """cells_sets: per cell, the running sets of snapshots 0..R."""
    for sets in cells_sets:
        for e in [0] + chosen:
            if change(sets[q], sets[e]) < b:
                return "batch"
        if "combination" in rules:
            nv, edges = release_graph([sets[i] for i in chosen] + [sets[q]])
            d, _ = directed_cut(nv, edges)
            if d is not None and d < b:
                return "combination"
        if entries(sets[q], sets[r]) < b:
            return "lag"
    return None


def choose_releases(cells_sets, snapshots, b, rules=("combination",)):
    chosen = []
    decisions = []
    for r in range(2, snapshots + 1):
        last = chosen[-1] if chosen else 0
        refused = {}
        pick = None
        for q in range(r - 1, last, -1):
            why = qualifies(cells_sets, chosen, q, r, b, rules)
            if why is None:
                pick = q
                break
            refused[str(q)] = why
        decisions.append({"at": r, "release": pick, "refused": refused})
        if pick is not None:
            chosen.append(pick)
    return chosen, decisions


def voters(prefix, count, enter, leave=None, cell=0, revote=None):
    """`count` nullifiers whose first ballot enters at snapshot `enter`; if
    `leave` is given, a passing posting for it is boarded there, and if
    `revote` is, a second ballot is admitted and receipted there."""
    out = {}
    for i in range(count):
        nid = f"{prefix}{i:02d}"
        ballots = [{"id": f"{nid}/1", "cell": cell, "admitted": enter, "receipted": enter, "posted": leave}]
        if revote is not None:
            ballots.append({"id": f"{nid}/2", "cell": cell, "admitted": revote, "receipted": revote, "posted": None})
        out[nid] = ballots
    return out


def release_case(name, note, nullifiers, cells, snapshots, b, compare_pairwise=False):
    cells_sets = running_sets(nullifiers, snapshots, cells)
    chosen, decisions = choose_releases(cells_sets, snapshots, b)
    case = {
        "id": name,
        "description": note,
        "batch": b,
        "cells": cells,
        "snapshots": snapshots,
        "nullifiers": nullifiers,
        "runningSets": [[dict(sorted(s.items())) for s in sets[1:]] for sets in cells_sets],
        "decisions": decisions,
        "releases": chosen,
    }
    if compare_pairwise:
        pw, _ = choose_releases(cells_sets, snapshots, b, rules=())
        assert pw != chosen
        case["pairwiseOnlyReleases"] = pw
    return case


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: live-release-vectors.py <out-dir>")
    out = pathlib.Path(sys.argv[1])

    epoch, period = 1_800_000_000, 3_600
    schedules = []
    for name, opens, closes, every in [
        ("hourly", epoch + 10 * period + 600, epoch + 16 * period + 1_200, 1),
        ("every-3", epoch + 10 * period, epoch + 22 * period, 3),
        ("close-on-boundary", epoch + 10 * period, epoch + 14 * period, 1),
        ("shorter-than-interval", epoch + 10 * period, epoch + 12 * period + 5, 4),
    ]:
        schedules.append(
            {
                "id": name,
                "epoch": str(epoch),
                "period": str(period),
                "opensAt": str(opens),
                "closesAt": str(closes),
                "liveEvery": every,
                "snapshotSegments": scheduled_snapshots(epoch, period, opens, closes, every),
            }
        )

    # Running set: one nullifier per rule, over four snapshots of cell 0.
    def ballot(nid, k, cell=0, admitted=1, receipted=1, posted=None):
        return {"id": f"{nid}/{k}", "cell": cell, "admitted": admitted, "receipted": receipted, "posted": posted}

    rs_nullifiers = {
        "plain": [ballot("plain", 1)],
        "late-receipts": [ballot("late-receipts", 1, receipted=3)],
        "never-receipted": [ballot("never-receipted", 1, receipted=None)],
        "revoter": [ballot("revoter", 1), ballot("revoter", 2, admitted=3, receipted=3)],
        "pending-revote": [ballot("pending-revote", 1), ballot("pending-revote", 2, admitted=4, receipted=2)],
        "posted": [ballot("posted", 1, posted=2)],
        "tie": [ballot("tie", 1, admitted=2), ballot("tie", 2, admitted=2)],
        "other-cell": [ballot("other-cell", 1, cell=1)],
        "two-cells": [ballot("two-cells", 1), ballot("two-cells", 2, cell=1, admitted=2, receipted=2)],
        "unreceipted-first": [
            ballot("unreceipted-first", 1, receipted=None),
            ballot("unreceipted-first", 2, admitted=3, receipted=3),
        ],
        "admitted-later": [ballot("admitted-later", 1, admitted=2, receipted=1)],
    }
    rs = running_sets(rs_nullifiers, 4, 2)
    running = {
        "nullifiers": rs_nullifiers,
        "cells": [{"cell": c, "runningSets": [dict(sorted(x.items())) for x in rs[c][1:]]} for c in (0, 1)],
    }

    # Release graphs.
    def sets_of(spec):
        return [{n: f"{n}/1" for n in s} for s in spec]

    xs = [f"x{i:02d}" for i in range(20)]
    ys = [f"y{i:02d}" for i in range(20)]
    graphs = [
        graph_case(
            "three-releases-isolate-one",
            "Every pairwise change is at least 20, yet T1 - T2 + T3 is z's ballot alone; already T1 - T2 has z alone on its positive side.",
            sets_of([xs + ["z"], xs + ys, ys]),
        ),
        graph_case(
            "one-departure",
            "z leaves as 19 new voters enter: the change is 20 and every undirected cut at least 20, yet T2 - T1 is the 19 entrants' ballots less z's, so the leaving side is z alone.",
            sets_of([xs + ["z"], xs + ys[:19]]),
        ),
        graph_case(
            "only-entries",
            "No nullifier leaves: the least positive directed cut is the least positive number of entries between two consecutive releases.",
            sets_of([xs[:5], xs[:12], xs]),
        ),
        graph_case(
            "zero-combination",
            "T1 - T2 + T3 is identically zero, which discloses nothing: no positive directed cut is below 20.",
            sets_of([xs, xs + ys, ys]),
        ),
        graph_case(
            "single-release",
            "One release against the empty set: its directed cut is its size.",
            sets_of([xs[:7]]),
        ),
    ]

    # Release choices with B = MIN_LIVE_BATCH.
    b = MIN_LIVE_BATCH
    steady = {}
    for r in range(1, 7):
        steady.update(voters(f"s{r}-", 25, r))
    revoting = dict(steady)
    revoting.update(voters("rv-", 3, 1, revote=3))
    revoting.update(voters("tie-", 1, 1, revote=4))
    revoting["tie-00"].append({"id": "tie-00/3", "cell": 0, "admitted": 4, "receipted": 4, "posted": None})
    two_cells = {}
    for r in range(1, 6):
        two_cells.update(voters(f"big{r}-", 30, r, cell=0))
    two_cells.update(voters("small-", 12, 1, cell=1))
    two_cells.update(voters("small-mid-", 12, 3, cell=1))
    two_cells.update(voters("small-late-", 20, 5, cell=1))
    combo = {}
    combo.update(voters("x", 20, 1, leave=3))
    combo.update(voters("z", 1, 1, leave=2))
    combo.update(voters("y", 20, 2))
    combo.update(voters("w", 20, 3))
    combo.update(voters("v", 20, 4))
    combo.update(voters("u", 20, 5))
    combo.update(voters("t", 20, 6))
    departing = {}
    departing.update(voters("a", 10, 1))
    departing.update(voters("z", 1, 1, leave=2))
    departing.update(voters("d", 19, 1, leave=4))
    for r in range(2, 7):
        departing.update(voters(f"e{r}-", 25, r))
    quiet_then_busy = {}
    quiet_then_busy.update(voters("q-", 21, 1))
    quiet_then_busy.update(voters("r-", 3, 2))
    quiet_then_busy.update(voters("s-", 3, 3))
    quiet_then_busy.update(voters("t-", 40, 4))
    releases = [
        release_case("steady", "25 new voters per snapshot: every decision releases the snapshot before it.", steady, 1, 6, b),
        release_case(
            "re-votes-stay",
            "Released voters re-vote at snapshot 3 and one ties at 4: each keeps its first ballot in the running sets, so nothing leaves and the releases go on as without them.",
            revoting,
            1,
            6,
            b,
        ),
        release_case(
            "small-cell",
            "A tier of two cells whose small cell reaches 20 voters at snapshot 3 and has 20 changes after it only at 5: the busy cell waits, and snapshot 4 is the first release.",
            two_cells,
            2,
            5,
            b,
        ),
        release_case(
            "combination",
            "z's ballot is posted while 20 enter: the ADR's pairwise rules would release snapshot 2, whose T2 - T1 has z alone on its leaving side; the combination rule waits for snapshot 3, where 20 more have left.",
            combo,
            1,
            7,
            b,
            compare_pairwise=True,
        ),
        release_case(
            "departures",
            "One released voter's ballot is posted before snapshot 2: no later snapshot is released until 19 more have left, so that the departures since release 1 are 20, at snapshot 4.",
            departing,
            1,
            6,
            b,
            compare_pairwise=True,
        ),
        release_case(
            "latest-qualifying",
            "Snapshots 2 and 3 add too few voters for the lag; at 4 both 2 and 3 qualify and the latest, 3, is released.",
            quiet_then_busy,
            1,
            5,
            b,
        ),
        release_case(
            "empty-cell",
            "A cell nobody voted in never reaches the batch, so its tier never releases.",
            {k: v for k, v in steady.items() if k.startswith(("s1-", "s2-", "s3-"))},
            2,
            3,
            b,
        ),
    ]

    doc = {
        "format": "abolish-live-release-vectors/1",
        "title": "Live results: the release schedule, running sets, the release graph and its least positive directed cut, and the release choice",
        "spec": "docs/spec/tally.md",
        "generator": "packages/crypto/scripts/live-release-vectors.py: an independent Python implementation of docs/spec/tally.md (Live results), computing each directed cut by maximum flow along every edge and by trying every vertex set, and checking the theorem on graphs of up to five vertices by trying every combination with coefficients from -2 to 2",
        "minLiveBatch": str(MIN_LIVE_BATCH),
        "schedules": schedules,
        "running": running,
        "graphs": graphs,
        "releases": releases,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "live-release.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
