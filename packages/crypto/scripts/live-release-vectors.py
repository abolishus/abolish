#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/live-release.json.

A second implementation of docs/spec/tally.md, Live results: the release
schedule, the running sets of a tier's cells over its scheduled snapshots
(which only grow), the change and the entries between two running sets, the
release graph and its least positive directed cut, the release choice with
its lag, the final tally's graph against the releases, whose cut the
verifier reports, and a node's completeness check. It is written from the spec with Python's standard library
only and shares no code with packages/crypto.

The least positive directed cut is computed twice, as the least maximum flow
along an edge (Edmonds-Karp over unit capacities) and by trying every vertex
set, and the generator stops if they disagree. For graphs of up to five
vertices it also checks the theorem the spec relies on: the smallest
non-empty side (the edges weighted positively, or those weighted negatively)
of any integer combination of the vertices' totals, every combination with
coefficients from -2 to 2 tried, is the least positive directed cut. And it
checks that every chosen set of releases has a cut of at least B, which the
spec derives from the batch rule because running sets only grow.

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
# ballot), each with the cell it names, its L1 reference's block number
# (`ref`), the first scheduled snapshot index at which it is in the snapshot
# (`boarded`, the same as `admitted` when absent), at which it is rejected
# (`rejected`, absent if never), at which it is admitted and
# at which every qualified seat of every panel has a passing receipt for it
# (`receipted`); None: never by the last snapshot. `delivered` is false for a
# ballot the delivery check excludes at the final tally (no receipt or
# passing posting for some seat by the deadline, or a proven complaint).


def status(b, r):
    """A ballot's admission at snapshot r: absent, pending, admitted or rejected."""
    boarded = b.get("boarded", b["admitted"])
    if boarded is None or boarded > r:
        return "absent"
    if b["admitted"] is not None and b["admitted"] <= r:
        return "admitted"
    if b.get("rejected") is not None and b["rejected"] <= r:
        return "rejected"
    return "pending"


def entering(ballots, r):
    """Conditions 1 and 2 at snapshot r: the one ballot that enters, or None.
    Pending ballots count towards the nullifier's distinct ballots."""
    live = [b for b in ballots if status(b, r) in ("admitted", "pending")]
    if len(live) != 1 or status(live[0], r) != "admitted":
        return None
    b = live[0]
    if b["receipted"] is None or b["receipted"] > r:
        return None
    return b


def running_sets(nullifiers, snapshots, cells):
    """Per cell, the running sets of snapshots 0..snapshots (index 0 is R_0).
    A nullifier enters once, with one ballot, and stays with it for good."""
    out = [[{}] for _ in range(cells)]
    for r in range(1, snapshots + 1):
        for c in range(cells):
            out[c].append(dict(out[c][r - 1]))
        for nid, ballots in nullifiers.items():
            if any(nid in out[c][r - 1] for c in range(cells)):
                continue
            b = entering(ballots, r)
            if b is not None:
                out[b["cell"]][r][nid] = b["id"]
    return out


def final_ballots(nullifiers, cell):
    """The final tally's counted ballots of a cell: per nullifier, the admitted
    ballot with the highest reference, none on a tie, none if excluded."""
    out = {}
    for nid, ballots in nullifiers.items():
        admitted = [b for b in ballots if b["admitted"] is not None]
        if not admitted:
            continue
        top = max(b["ref"] for b in admitted)
        best = [b for b in admitted if b["ref"] == top]
        if len(best) != 1:
            continue
        b = best[0]
        if b["cell"] != cell or not b["delivered"]:
            continue
        out[nid] = b["id"]
    return out


def change(a, b):
    return sum(1 for n in set(a) | set(b) if a.get(n) != b.get(n))


def entries(earlier, later):
    return sum(1 for n in later if n not in earlier)


# Release graph (tally.md, Live results: Change and the release graph).


def release_graph(sets):
    """sets: the sets of the vertices 1..m (vertex 0 is the empty set), each
    an object from nullifier to ballot. Each ballot in any of them is an edge
    from the vertex before its run to its last."""
    seen = {}
    for i, s in enumerate(sets, start=1):
        for n, ballot in s.items():
            seen.setdefault(ballot, []).append(i)
    edges = []
    for ballot in sorted(seen):
        idx = seen[ballot]
        assert idx == list(range(idx[0], idx[-1] + 1)), "a ballot's run is unbroken"
        edges.append((idx[0] - 1, idx[-1], ballot))
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


def qualifies(cells_sets, chosen, q, r, b):
    """cells_sets: per cell, the running sets of snapshots 0..R."""
    for sets in cells_sets:
        for e in [0] + chosen:
            if change(sets[q], sets[e]) < b:
                return "batch"
        if entries(sets[q], sets[r]) < b:
            return "lag"
    return None


def choose_releases(cells_sets, snapshots, b):
    chosen = []
    decisions = []
    for r in range(2, snapshots + 1):
        last = chosen[-1] if chosen else 0
        refused = {}
        pick = None
        for q in range(r - 1, last, -1):
            why = qualifies(cells_sets, chosen, q, r, b)
            if why is None:
                pick = q
                break
            refused[str(q)] = why
        decisions.append({"at": r, "release": pick, "refused": refused})
        if pick is not None:
            chosen.append(pick)
            # The theorem with grow-only sets: every side of every
            # combination of the chosen releases holds at least B.
            for sets in cells_sets:
                nv, edges = release_graph([sets[i] for i in chosen])
                d, _ = directed_cut(nv, edges)
                assert d is None or d >= b
    return chosen, decisions


def voters(prefix, count, enter, cell=0, revote=None, tie=False):
    """`count` nullifiers whose first ballot is receipted at snapshot `enter`;
    with `revote`, a second ballot naming a later L1 block (or the same block,
    a tie) is admitted and receipted there."""
    out = {}
    for i in range(count):
        nid = f"{prefix}{i:02d}"
        ballots = [{"id": f"{nid}/1", "cell": cell, "ref": 1, "admitted": enter, "receipted": enter, "delivered": True}]
        if revote is not None:
            ref = 1 if tie else 2
            ballots.append({"id": f"{nid}/2", "cell": cell, "ref": ref, "admitted": revote, "receipted": revote, "delivered": True})
        out[nid] = ballots
    return out


# The completeness check (tally.md, Live results: What a node does).


def completeness(receipted, boarded, earlier, pending=None):
    """receipted: the ballots the node receipted in a period before sigma_q,
    each [ballot, nullifier]; boarded: per nullifier, the distinct admitted
    ballots in S_q whose node receipts are boarded too; pending: per nullifier,
    the distinct pending ballots in S_q; earlier: nullifiers in
    a running set of the tier at an earlier snapshot. The first missing
    ballot whose absence could change R_q refuses."""
    for ballot, nid in receipted:
        if ballot in boarded.get(nid, []):
            continue
        if nid in earlier:
            continue
        others = [x for x in boarded.get(nid, []) + (pending or {}).get(nid, []) if x != ballot]
        if len(others) >= 2:
            continue
        return {"refuse": ballot}
    return {"refuse": None}


def release_case(name, note, nullifiers, cells, snapshots, b):
    cells_sets = running_sets(nullifiers, snapshots, cells)
    chosen, decisions = choose_releases(cells_sets, snapshots, b)
    final = []
    for c in range(cells):
        sets = [cells_sets[c][i] for i in chosen] + [final_ballots(nullifiers, c)]
        nv, edges = release_graph(sets)
        d, witness = directed_cut(nv, edges)
        entry = {"cell": c, "finalCut": d, "witness": None}
        if d is not None:
            members, side, part = witness
            entry["witness"] = {"set": members, "side": side, "ballots": part}
        final.append(entry)
    return {
        "id": name,
        "description": note,
        "batch": b,
        "cells": cells,
        "snapshots": snapshots,
        "nullifiers": nullifiers,
        "runningSets": [[dict(sorted(s.items())) for s in sets[1:]] for sets in cells_sets],
        "decisions": decisions,
        "releases": chosen,
        "finalBallots": [dict(sorted(final_ballots(nullifiers, c).items())) for c in range(cells)],
        "final": final,
    }


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

    # Running set: one nullifier per rule, over four snapshots of two cells.
    def ballot(nid, k, cell=0, admitted=1, receipted=1, ref=None, delivered=None):
        if delivered is None:
            delivered = receipted is not None
        return {
            "id": f"{nid}/{k}",
            "cell": cell,
            "ref": k if ref is None else ref,
            "admitted": admitted,
            "receipted": receipted,
            "delivered": delivered,
        }

    rs_nullifiers = {
        "plain": [ballot("plain", 1)],
        "late-receipts": [ballot("late-receipts", 1, receipted=3)],
        "never-delivered": [ballot("never-delivered", 1, receipted=None)],
        "posted-valid": [ballot("posted-valid", 1, receipted=None, delivered=True)],
        "posted-invalid": [ballot("posted-invalid", 1, receipted=None, delivered=False)],
        "revoter": [ballot("revoter", 1), ballot("revoter", 2, admitted=3, receipted=3)],
        "pending-revote": [ballot("pending-revote", 1), ballot("pending-revote", 2, admitted=4, receipted=2)],
        "tie-before": [ballot("tie-before", 1, admitted=2), ballot("tie-before", 2, admitted=2, ref=1)],
        "tie-after": [ballot("tie-after", 1), ballot("tie-after", 2, admitted=2, ref=1)],
        "other-cell": [ballot("other-cell", 1, cell=1)],
        "two-cells": [ballot("two-cells", 1), ballot("two-cells", 2, cell=1, admitted=2, receipted=2)],
        "unreceipted-first": [
            ballot("unreceipted-first", 1, receipted=None),
            ballot("unreceipted-first", 2, admitted=3, receipted=3),
        ],
        "admitted-later": [ballot("admitted-later", 1, admitted=2, receipted=1)],
        "pending-first": [
            dict(ballot("pending-first", 1, admitted=3), boarded=1),
            ballot("pending-first", 2, admitted=2, receipted=2),
        ],
        "rejected-first": [
            dict(ballot("rejected-first", 1, admitted=None, receipted=None), boarded=1, rejected=3),
            ballot("rejected-first", 2, admitted=2, receipted=2),
        ],
    }
    rs = running_sets(rs_nullifiers, 4, 2)
    running = {
        "nullifiers": rs_nullifiers,
        "cells": [
            {
                "cell": c,
                "runningSets": [dict(sorted(x.items())) for x in rs[c][1:]],
                "finalBallots": dict(sorted(final_ballots(rs_nullifiers, c).items())),
            }
            for c in (0, 1)
        ],
    }

    # Release graphs.
    def sets_of(spec):
        return [{n: f"{n}/1" for n in s} for s in spec]

    xs = [f"x{i:02d}" for i in range(20)]
    ys = [f"y{i:02d}" for i in range(20)]
    # Arbitrary runs, as under ADR 0027's rule, where re-voters and postings
    # leave: why running sets must only grow.
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
    revoting.update(voters("tie-", 1, 1, revote=4, tie=True))
    lone = dict(steady)
    lone.update(voters("lone-", 1, 1, revote=6))
    two_cells = {}
    for r in range(1, 6):
        two_cells.update(voters(f"big{r}-", 30, r, cell=0))
    two_cells.update(voters("small-", 12, 1, cell=1))
    two_cells.update(voters("small-mid-", 12, 3, cell=1))
    two_cells.update(voters("small-late-", 20, 5, cell=1))
    quiet_then_busy = {}
    quiet_then_busy.update(voters("q-", 21, 1))
    quiet_then_busy.update(voters("r-", 3, 2))
    quiet_then_busy.update(voters("s-", 3, 3))
    quiet_then_busy.update(voters("t-", 40, 4))
    releases = [
        release_case("steady", "25 new voters per snapshot: every decision releases the snapshot before it.", steady, 1, 6, b),
        release_case(
            "re-votes-stay",
            "Released voters re-vote at snapshot 3 and one ties at 4: each keeps its first ballot in the running sets, so the releases go on as without them; the final tally's graph has their four released ballots alone on one side.",
            revoting,
            1,
            6,
            b,
        ),
        release_case(
            "lone-revoter",
            "One released voter re-votes after the last release: the final tally less the releases isolates that voter's released ballot, a cut of 1 the verifier flags.",
            lone,
            1,
            6,
            b,
        ),
        release_case(
            "small-cell",
            "A tier of two cells whose small cell reaches 20 voters at snapshot 3 and has 20 entries after it only at 5: the busy cell waits, and snapshot 4 is the first release.",
            two_cells,
            2,
            5,
            b,
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

    checks = []
    for name, note, receipted, boarded, earlier, *pending in [
        ("all-present", "Every ballot the node receipted is boarded with its receipt.", [["a/1", "a"], ["b/1", "b"]], {"a": ["a/1"], "b": ["b/1"]}, []),
        ("withheld", "A receipted ballot is missing and its nullifier has no other ballot: refuse.", [["a/1", "a"], ["b/1", "b"]], {"a": ["a/1"]}, []),
        ("withheld-first-revote-boarded", "The first ballot is withheld and its re-vote boarded, which would enter the release alone: refuse.", [["v/1", "v"], ["v/2", "v"]], {"v": ["v/2"]}, []),
        ("withheld-after-entering", "A re-vote is missing, but the nullifier entered at an earlier snapshot with its first ballot, which it keeps: pass.", [["v/2", "v"]], {"v": ["v/1"]}, ["v"]),
        ("withheld-beside-two", "A ballot is missing, but two other distinct ballots of its nullifier are boarded, so it is held out either way: pass.", [["v/1", "v"]], {"v": ["v/2", "v/3"]}, []),
        ("withheld-beside-one", "A ballot is missing beside one other ballot of its nullifier, which would enter alone: refuse.", [["v/1", "v"]], {"v": ["v/2"]}, []),
        ("withheld-beside-pending", "A ballot is missing beside one admitted and one pending ballot of its nullifier, which is held out either way: pass.", [["v/1", "v"]], {"v": ["v/2"]}, [], {"v": ["v/3"]}),
    ]:
        pend = pending[0] if pending else {}
        checks.append(
            {
                "id": name,
                "description": note,
                "receipted": receipted,
                "boarded": boarded,
                "pending": pend,
                "earlier": earlier,
                "result": completeness(receipted, boarded, earlier, pend),
            }
        )

    doc = {
        "format": "abolish-live-release-vectors/1",
        "title": "Live results: the release schedule, running sets, release graphs and their least positive directed cuts, the release choice and the final tally against the releases",
        "spec": "docs/spec/tally.md",
        "generator": "packages/crypto/scripts/live-release-vectors.py: an independent Python implementation of docs/spec/tally.md (Live results), computing each directed cut by maximum flow along every edge and by trying every vertex set, and checking the theorem on graphs of up to five vertices by trying every combination with coefficients from -2 to 2",
        "minLiveBatch": str(MIN_LIVE_BATCH),
        "schedules": schedules,
        "running": running,
        "graphs": graphs,
        "releases": releases,
        "completeness": checks,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "live-release.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
