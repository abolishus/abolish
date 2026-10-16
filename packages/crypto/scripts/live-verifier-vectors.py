#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/live-verifier.json.

A second implementation of docs/spec/verifier.md, Releases (checks 7.5, 7.6
and 8.2's live-final-batch) over docs/spec/tally.md, Live results: each
snapshot's L1 head from a run of finalized L1 headers; ballot by ballot, which
of a nullifier's ballots count towards the one-ballot rule and which is
admitted at a snapshot's head, pending ballots (an L1 reference above the
head, or a rolling step not yet final) included; the running sets and the
release choice; the running openings sorted into a release's or outside the
schedule, with every break of the boarding rule and whom it is reported
against; the 7.5 and 7.6 rows; and each cell's least positive directed cut of
its chosen releases with the final tally, with the side the report lists.

It is written from the spec with Python's standard library only and shares no
code with packages/crypto or live-release-vectors.py. Ballots, votes and
openings are a model: a ballot's admission results are given (its membership
proof, any other admission failure, its L1 reference), and an opening by its
fields, the set its aggregate is over and its counts, so the byte-level codecs
stay in running-opening.json.

Each final cut is computed three ways, by the closed form the verifier spec
states, by the least maximum flow along an edge and by trying every vertex
set, and the generator stops if they disagree.

Usage: python3 -I -B packages/crypto/scripts/live-verifier-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import collections
import itertools
import json
import pathlib
import sys

MIN_LIVE_BATCH = 20


# Snapshots (verifier.md, Releases, step 2; tally.md, Live results: Schedule).


def snapshot_segments(epoch, period, opens_at, closes_at, live_every):
    s_open = (opens_at - epoch) // period
    s_close = (closes_at - epoch) // period
    out = []
    r = 1
    while s_open + r * live_every - 1 < s_close:
        out.append(s_open + r * live_every - 1)
        r += 1
    return out


def l1_head(epoch, period, sigma, blocks):
    """The last block whose timestamp is before the end of period sigma, or
    None (l1-blocks-short) unless the run starts before that time and holds a
    block at or after it."""
    end = epoch + (sigma + 1) * period
    if not blocks or blocks[0]["timestamp"] >= end or blocks[-1]["timestamp"] < end:
        return None
    return max((b for b in blocks if b["timestamp"] < end), key=lambda b: b["number"])


# Ballots at a snapshot (verifier.md, Releases, step 3; tally.md, Running set,
# condition 1).


def status(b, segment, head):
    """A ballot's standing in snapshot S_r, read with `head` as the L1 head:
    absent, pending, non-member, rejected or admitted. Pending and rejected
    ballots count towards the one-ballot rule; non-members don't."""
    if b["segment"] > segment:
        return "absent"
    step = b.get("stepFinalAt")
    if step is not None and step > head:
        return "pending"
    if not b.get("member", True):
        return "non-member"
    if b.get("invalid") is not None:
        return "rejected"
    if b["ref"] > head:
        return "pending"
    if not b.get("refKnown", True):
        return "rejected"
    return "admitted"


def counts_toward(st):
    return st in ("pending", "rejected", "admitted")


def entering(ballots, segment, head):
    """The ballot a nullifier enters with at a snapshot, or None. Copies with
    the same message are one ballot (repeats): it counts if any copy counts
    and is admitted if any copy is, since a failed copy is never an earlier
    ballot (R4); its first admitted copy, else its first counting one, stands
    for it. A receipt batch's pair (`batchReceipted`) never counts: ballot
    versions 4 and 5 fix no batch version."""
    by_message = {}
    for b in sorted(ballots, key=lambda x: x["segment"]):
        st = status(b, segment, head)
        if counts_toward(st):
            by_message.setdefault(b["message"], []).append((b, st))
    if len(by_message) != 1:
        return None
    (copies,) = by_message.values()
    admitted = [b for b, st in copies if st == "admitted"]
    if not admitted:
        return None
    b = admitted[0]
    if b.get("receipted") is None or b["receipted"] > segment:
        return None
    return b


def running_sets(case):
    """Per cell, R_{r,c} for r = 0..N as objects from nullifier to ballot id."""
    cells = case["cellTiers"]
    snaps = case["snapshots"]
    out = [[{}] for _ in cells]
    entered = set()
    for snap in snaps:
        for c in range(len(cells)):
            out[c].append(dict(out[c][-1]))
        new = []
        for nid, n in sorted(case["nullifiers"].items()):
            if nid in entered:
                continue
            b = entering(n["ballots"], snap["segment"], snap["head"])
            if b is not None:
                new.append((nid, b))
        for nid, b in new:
            entered.add(nid)
            out[b["cell"]][-1][nid] = b["id"]
    return out


def final_ballots(case):
    """Per cell, the final tally's counted ballots: per nullifier, the admitted
    ballot with the highest reference, none on a tie or if delivery excludes it."""
    out = [{} for _ in case["cellTiers"]]
    for nid, n in sorted(case["nullifiers"].items()):
        msgs = {}
        for b in n["ballots"]:
            if status(b, 1 << 62, case["finalHead"]) == "admitted":
                msgs.setdefault(b["message"], b)
        if not msgs:
            continue
        top = max(b["ref"] for b in msgs.values())
        best = [b for b in msgs.values() if b["ref"] == top]
        if len(best) != 1 or not best[0].get("delivered", True):
            continue
        out[best[0]["cell"]][nid] = best[0]["id"]
    return out


# Release choice (tally.md, Release choice).


def change(a, b):
    return sum(1 for n in set(a) | set(b) if a.get(n) != b.get(n))


def entries(earlier, later):
    return sum(1 for n in later if n not in earlier)


def choose(case, sets):
    b = case["batch"]
    tiers = sorted(set(case["cellTiers"]))
    out = {}
    for t in tiers:
        cells = [c for c, ct in enumerate(case["cellTiers"]) if ct == t]
        chosen, decisions = [], []
        for r in range(2, len(case["snapshots"]) + 1):
            last = chosen[-1] if chosen else 0
            refused, pick = {}, None
            for q in range(r - 1, last, -1):
                why = None
                for c in cells:
                    if any(change(sets[c][q], sets[c][i]) < b for i in [0] + chosen):
                        why = "batch"
                        break
                    if entries(sets[c][q], sets[c][r]) < b:
                        why = "lag"
                        break
                if why is None:
                    pick = q
                    break
                refused[str(q)] = why
            decisions.append({"at": r, "release": pick, "refused": refused})
            if pick is not None:
                chosen.append(pick)
        out[t] = (chosen, decisions)
    return out


# Running openings (verifier.md, Releases, steps 5 and 6; tally.md, Running
# opening record).


def ballot_votes(case):
    return {b["id"]: b["votes"] for n in case["nullifiers"].values() for b in n["ballots"]}


def totals(case, s):
    votes = ballot_votes(case)
    out = [0] * case["options"]
    for ballot in s.values():
        for j, v in enumerate(votes[ballot]):
            out[j] += v
    return out


def judge_openings(case, sets, chosen):
    m = case["options"]
    ncells = len(case["cellTiers"])
    out = []
    seen = {}
    for o in case["openings"]:
        row = {"entry": o["entry"], "cell": o["cell"], "snapshot": o["snapshot"], "signer": o.get("signer")}
        breaks = []
        n_entries = o.get("entries", m)
        if not o.get("thisDefinition", True) or o["cell"] >= ncells:
            row["kind"] = "outside-schedule"
            breaks.append({"code": "running-stray"})
        else:
            c, q = o["cell"], o["snapshot"]
            tier = case["cellTiers"][c]
            over = o.get("aggregateOf", q)
            aggregate_set = sets[c][over] if over is not None and 0 <= over < len(sets[c]) else None
            counts = o.get("counts")
            if q not in chosen[tier][0]:
                row["kind"] = "outside-schedule"
                breaks.append({"code": "running-unscheduled"})
                if n_entries != m:
                    breaks.append({"code": "running-missing"})
                # Whether it opens the running set its snapshot names: a
                # disclosure the batch rule never bounded.
                if 1 <= q < len(sets[c]):
                    target = sets[c][q]
                    want = totals(case, target)
                    row["discloses"] = (
                        n_entries == m
                        and aggregate_set is not None
                        and aggregate_set == target
                        and (counts if counts is not None else want) == want
                        and o.get("badR") is None
                    )
                else:
                    row["discloses"] = False
            else:
                row["kind"] = "release"
                target = sets[c][q]
                want = totals(case, target)
                if counts is None:
                    counts = totals(case, aggregate_set) if aggregate_set is not None else want
                if n_entries != m:
                    breaks.append({"code": "running-missing"})
                elif aggregate_set is None or aggregate_set != target:
                    breaks.append({"code": "running-aggregate"})
                else:
                    # `bindingBroken`: (V, R) that open the aggregate with
                    # other counts, which only a known log_g h allows.
                    bad = [] if o.get("bindingBroken") else [j for j in range(m) if counts[j] != want[j]]
                    if o.get("badR") is not None:
                        bad.append(o["badR"])
                    if bad:
                        breaks.append({"code": "running-opening", "option": min(bad)})
                row["passes"] = not breaks
                if row["passes"]:
                    row["counts"] = [str(v) for v in counts]
                    row["randomness"] = o.get("randomness", "summed")
        if o.get("signer") is None:
            breaks.append({"code": "running-unattributed"})
        elif row["kind"] == "release":
            key = (o["cell"], o["snapshot"], o["signer"])
            if key in seen:
                first_entry, first_msg = seen[key]
                code = "running-repeat" if o.get("message") == first_msg else "running-second"
                breaks.append({"code": code, "of": first_entry})
            else:
                seen[key] = (o["entry"], o.get("message"))
        row["breaks"] = breaks
        # Every break is the operator's; all but a replay also the signer's.
        blamed = o.get("signer") is not None and any(x["code"] != "running-repeat" for x in breaks)
        row["blamed"] = o.get("signer") if blamed else None
        out.append(row)
    return out


def releases_per_cell(case, sets, chosen, judged):
    out = []
    for c, t in enumerate(case["cellTiers"]):
        rows = []
        prev = 0
        for q in chosen[t][0]:
            passing = [r for r in judged if r["kind"] == "release" and r["cell"] == c and r["snapshot"] == q and r["passes"]]
            rows.append(
                {
                    "snapshot": q,
                    "size": len(sets[c][q]),
                    "entered": entries(sets[c][prev], sets[c][q]),
                    "counts": passing[0]["counts"] if passing else None,
                    # Openings differ by their (V, R) lists, never by signer
                    # or signature.
                    "conflict": len({(tuple(r["counts"]), r["randomness"]) for r in passing}) > 1,
                    "signers": sorted({r["signer"] for r in passing if r["signer"] is not None}),
                }
            )
            prev = q
        out.append({"cell": c, "tier": t, "releases": rows})
    return out


def row_75(case, per_cell):
    """7.5: the first passing opening whose counts the binding rules out."""
    for cell in per_cell:
        for rel in cell["releases"]:
            if rel["counts"] is None:
                continue
            if rel["conflict"]:
                return {"status": "fail", "code": "running-conflict", "at": {"cell": cell["cell"], "snapshot": rel["snapshot"]}}
            counts = [int(v) for v in rel["counts"]]
            size = rel["size"]
            for j, v in enumerate(counts):
                if v > size:
                    return {"status": "fail", "code": "running-range", "at": {"cell": cell["cell"], "snapshot": rel["snapshot"], "option": j}}
            start = 0
            for qi, q in enumerate(case["questions"]):
                s = sum(counts[start : start + q["options"]])
                if not q["min"] * size <= s <= q["max"] * size:
                    return {"status": "fail", "code": "running-question-range", "at": {"cell": cell["cell"], "snapshot": rel["snapshot"], "question": qi}}
                start += q["options"]
    return {"status": "pass"}


def row_76(judged):
    for r in judged:
        if r["breaks"]:
            return {"status": "fail", "code": r["breaks"][0]["code"], "at": {"entry": r["entry"]}}
    return {"status": "pass"}


# The final tally against releases (verifier.md, Releases, step 7; tally.md,
# The final tally against releases).


def graph(release_sets, final):
    """Vertices 0..m+1; each ballot in any set is an edge from the vertex
    before its first set to its last."""
    seen = {}
    for i, s in enumerate(release_sets + [final], start=1):
        for ballot in s.values():
            seen.setdefault(ballot, []).append(i)
    edges = []
    for ballot in sorted(seen):
        idx = seen[ballot]
        assert idx == list(range(idx[0], idx[-1] + 1)), "a ballot's run is unbroken"
        edges.append((idx[0] - 1, idx[-1], ballot))
    return len(release_sets) + 2, edges


def max_flow(edges, s, t):
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
            cap[(prev[v], v)] -= 1
            cap[(v, prev[v])] += 1
            v = prev[v]
        flow += 1


def cut_by_flow(edges):
    vals = [max_flow(edges, u, v) for u, v in sorted({(u, v) for u, v, _ in edges})]
    return min(vals) if vals else None


def cut_by_search(nv, edges):
    best = None
    for size in range(0, nv + 1):
        for members in itertools.combinations(range(nv), size):
            u = set(members)
            k = sum(1 for a, b, _ in edges if a not in u and b in u)
            if k > 0 and (best is None or k < best):
                best = k
    return best


def final_batch(release_sets, final):
    """The closed form: x_u (entered at release u + 1, counted), y_u (entered
    there, not counted), z (counted, in no release). Candidates in the
    report's order: each y_u, then z (or each x_u when z is 0), then each
    x_u + y_u."""
    m = len(release_sets)
    first = {}
    for i, s in enumerate(release_sets):
        for ballot in s.values():
            first.setdefault(ballot, i)
    counted = set(final.values())
    x = [[] for _ in range(m)]
    y = [[] for _ in range(m)]
    for ballot, u in first.items():
        (x if ballot in counted else y)[u].append(ballot)
    z = sorted(b for b in counted if b not in first)
    candidates = []
    for u in range(m):
        candidates.append(("uncounted", u + 1, sorted(y[u])))
    if z:
        candidates.append(("unreleased", None, z))
    else:
        for u in range(m):
            candidates.append(("counted", u + 1, sorted(x[u])))
    for u in range(m):
        candidates.append(("entered", u + 1, sorted(x[u] + y[u])))
    positive = [c for c in candidates if c[2]]
    if not positive:
        return None, None
    d = min(len(c[2]) for c in positive)
    side = next(c for c in positive if len(c[2]) == d)
    nv, edges = graph(release_sets, final)
    assert cut_by_flow(edges) == d, (cut_by_flow(edges), d)
    if nv <= 9:
        assert cut_by_search(nv, edges) == d
    return d, {"kind": side[0], "release": side[1], "ballots": side[2]}


# Cases.


def run(case):
    sets = running_sets(case)
    final = final_ballots(case)
    chosen = choose(case, sets)
    judged = judge_openings(case, sets, chosen)
    per_cell = releases_per_cell(case, sets, chosen, judged)
    for cell in per_cell:
        rels = chosen[cell["tier"]][0]
        if not rels:
            cell["finalBatch"] = None
            continue
        d, side = final_batch([sets[cell["cell"]][q] for q in rels], final[cell["cell"]])
        cell["finalBatch"] = {"cut": d, "flagged": d is not None and d < case["batch"], "side": side}
    tiers = []
    for t in sorted(chosen):
        rels, decisions = chosen[t]
        cells = [c for c in per_cell if c["tier"] == t]
        tier_rels = []
        for i, q in enumerate(rels):
            got = [c["releases"][i]["counts"] for c in cells]
            counts = None
            if all(g is not None for g in got):
                counts = [str(sum(int(g[j]) for g in got)) for j in range(case["options"])]
            tier_rels.append({"snapshot": q, "counts": counts})
        tiers.append({"tier": t, "decisions": decisions, "releases": tier_rels})
    statuses = {}
    for nid, n in sorted(case["nullifiers"].items()):
        statuses[nid] = {
            b["id"]: [status(b, s["segment"], s["head"]) for s in case["snapshots"]] for b in n["ballots"]
        }
    return {
        "statuses": statuses,
        "runningSets": [[dict(sorted(s.items())) for s in cs[1:]] for cs in sets],
        "finalBallots": [dict(sorted(f.items())) for f in final],
        "tiers": tiers,
        "cells": per_cell,
        "openings": judged,
        "rows": {"7.5": row_75(case, per_cell), "7.6": row_76(judged)},
    }


def ballot(nid, k=1, cell=0, segment=10, ref=100, receipted=None, votes=(1, 0), **extra):
    b = {
        "id": f"{nid}/{k}",
        "message": f"{nid}/{k}",
        "cell": cell,
        "segment": segment,
        "ref": ref,
        "receipted": segment if receipted is None else receipted,
        "votes": list(votes),
    }
    b.update(extra)
    if b["receipted"] == -1:
        b["receipted"] = None
    return b


def crowd(prefix, count, segment, cell=0, ref=None, votes=None, tier=0):
    """`count` voters each casting one ballot, admitted and receipted in `segment`."""
    out = {}
    for i in range(count):
        nid = f"{prefix}{i:02d}"
        v = votes if votes is not None else ((1, 0) if i % 3 else (0, 1))
        out[nid] = {"tier": tier, "ballots": [ballot(nid, cell=cell, segment=segment, ref=ref or 100 + segment, votes=v)]}
    return out


def base_case(id_, description, nullifiers, snapshots, openings, cell_tiers=(0,), batch=MIN_LIVE_BATCH):
    return {
        "id": id_,
        "description": description,
        "batch": batch,
        "options": 2,
        "questions": [{"options": 2, "min": 1, "max": 1}],
        "cellTiers": list(cell_tiers),
        "snapshots": snapshots,
        "finalHead": 10_000,
        "nullifiers": nullifiers,
        "openings": openings,
    }


def snaps(n, first=10):
    """Snapshots at segments first..first+n-1; each head is 100 + its segment."""
    return [{"segment": first + i, "head": 100 + first + i} for i in range(n)]


def openings_for(releases, cells=(0,), signers=(1,), start=1000):
    out = []
    e = start
    for q in releases:
        for c in cells:
            for s in signers:
                out.append({"entry": e, "cell": c, "snapshot": q, "signer": s, "message": f"{c}/{q}/{s}"})
                e += 1
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: live-verifier-vectors.py <out-dir>")
    out = pathlib.Path(sys.argv[1])

    # Snapshot heads.
    epoch, period = 1_800_000_000, 3_600
    run_blocks = [{"number": 500 + i, "timestamp": epoch + 10 * period - 30 + 12 * i} for i in range(0, 2400)]
    heads = []
    for name, opens, closes, every, blocks in [
        ("hourly", epoch + 10 * period, epoch + 14 * period, 1, run_blocks),
        ("short-run", epoch + 10 * period, epoch + 14 * period, 1, run_blocks[:600]),
        ("starts-late", epoch + 10 * period, epoch + 14 * period, 1, run_blocks[400:]),
        ("missed-slot-at-boundary", epoch + 10 * period, epoch + 13 * period, 1,
         [b for b in run_blocks if b["timestamp"] not in (epoch + 11 * period - 6, epoch + 11 * period + 6)]),
    ]:
        segs = snapshot_segments(epoch, period, opens, closes, every)
        rows = []
        for s in segs:
            h = l1_head(epoch, period, s, blocks)
            rows.append({"segment": s, "head": None if h is None else {"number": str(h["number"]), "timestamp": str(h["timestamp"])}})
        heads.append(
            {
                "id": name,
                "epoch": str(epoch),
                "period": str(period),
                "opensAt": str(opens),
                "closesAt": str(closes),
                "liveEvery": every,
                "blocks": {"first": {"number": str(blocks[0]["number"]), "timestamp": str(blocks[0]["timestamp"])},
                           "last": {"number": str(blocks[-1]["number"]), "timestamp": str(blocks[-1]["timestamp"])},
                           "spacing": "12", "missing": [str(t) for t in (epoch + 11 * period - 6, epoch + 11 * period + 6)] if name == "missed-slot-at-boundary" else []},
                "snapshots": rows,
            }
        )

    # Ballot-level cases: three snapshots at segments 10, 11 and 12, with
    # heads 110, 111 and 112, and one cell.
    three = snaps(3)
    adm = {
        "plain": {"tier": 0, "ballots": [ballot("plain")]},
        "ref-above-head": {"tier": 0, "ballots": [ballot("ref-above-head", ref=111)]},
        "future-first": {
            "tier": 0,
            "ballots": [
                ballot("future-first", ref=5_000, refKnown=False),
                ballot("future-first", 2, segment=11, ref=111),
            ],
        },
        "reorged-first": {
            "tier": 0,
            "ballots": [
                ballot("reorged-first", ref=105, refKnown=False),
                ballot("reorged-first", 2, segment=11, ref=111),
            ],
        },
        "invalid-first": {
            "tier": 0,
            "ballots": [
                ballot("invalid-first", invalid="option-proof"),
                ballot("invalid-first", 2, segment=11, ref=111),
            ],
        },
        "non-member-first": {
            "tier": 0,
            "ballots": [ballot("non-member-first", member=False), ballot("non-member-first", 2, segment=11, ref=111)],
        },
        "step-pending": {"tier": 0, "ballots": [ballot("step-pending", stepFinalAt=112)]},
        "junk-step": {
            "tier": 0,
            "ballots": [
                ballot("junk-step", stepFinalAt=9_000, member=False),
                ballot("junk-step", 2, segment=11, ref=111),
            ],
        },
        "junk-step-settles": {
            "tier": 0,
            "ballots": [
                ballot("junk-step-settles", stepFinalAt=111, member=False),
                ballot("junk-step-settles", 2, ref=110),
            ],
        },
        "repeat": {
            "tier": 0,
            "ballots": [ballot("repeat"), dict(ballot("repeat", segment=11), id="repeat/1-copy")],
        },
        "broken-copy-first": {
            "tier": 0,
            "ballots": [
                dict(ballot("broken-copy-first", member=False), id="broken-copy-first/1-broken"),
                dict(ballot("broken-copy-first", segment=11), receipted=10),
            ],
        },
        "early-copy-first": {
            "tier": 0,
            "ballots": [
                dict(ballot("early-copy-first", invalid="window-before-open"), id="early-copy-first/1-early"),
                dict(ballot("early-copy-first", segment=11), receipted=10),
            ],
        },
        "batch-receipts-only": {
            "tier": 0,
            "ballots": [ballot("batch-receipts-only", receipted=-1, batchReceipted=10, delivered=False)],
        },
        "late-receipts": {"tier": 0, "ballots": [ballot("late-receipts", receipted=12)]},
        "never-receipted": {"tier": 0, "ballots": [ballot("never-receipted", receipted=-1, delivered=False)]},
        "revote-before-entry": {
            "tier": 0,
            "ballots": [ballot("revote-before-entry", receipted=11), ballot("revote-before-entry", 2, segment=11, ref=111)],
        },
        "revote-after-entry": {
            "tier": 0,
            "ballots": [ballot("revote-after-entry"), ballot("revote-after-entry", 2, segment=11, ref=111)],
        },
    }
    admission = base_case(
        "ballot-level",
        "One nullifier per rule of condition 1 over three snapshots of one cell (heads 110, 111, 112); no releases.",
        adm,
        three,
        [],
        batch=MIN_LIVE_BATCH,
    )
    admission_result = run(admission)
    admission_view = {
        "id": admission["id"],
        "description": admission["description"],
        "snapshots": admission["snapshots"],
        "finalHead": admission["finalHead"],
        "nullifiers": admission["nullifiers"],
        "statuses": admission_result["statuses"],
        "runningSets": admission_result["runningSets"],
        "finalBallots": admission_result["finalBallots"],
    }

    # Elections. B = 20, segments 10.. with one snapshot per segment.
    cases = []

    steady = {}
    for i, seg in enumerate(range(10, 16)):
        steady.update(crowd(f"s{i + 1}-", 25, seg))
    cases.append(
        base_case(
            "steady-published",
            "25 voters per snapshot; every chosen release is published by seat 1 and passes.",
            steady,
            snaps(6),
            openings_for([1, 2, 3, 4, 5]),
        )
    )

    skipped = dict(steady)
    cases.append(
        base_case(
            "skipped-release",
            "Release 2 is chosen but nothing opens it: it reports no counts, and later decisions still count it.",
            skipped,
            snaps(6),
            openings_for([1, 3, 4, 5]),
        )
    )

    revoters = dict(steady)
    for i in range(3):
        nid = f"rv-{i}"
        revoters[nid] = {"tier": 0, "ballots": [ballot(nid, segment=10, ref=110), ballot(nid, 2, segment=12, ref=112, votes=(0, 1))]}
    revoters["tie-0"] = {"tier": 0, "ballots": [ballot("tie-0", segment=10, ref=110), ballot("tie-0", 2, segment=13, ref=110, votes=(0, 1))]}
    cases.append(
        base_case(
            "re-voters-and-a-tie",
            "Three released voters re-vote and one ties: they stay in the running sets with their first ballots, and the final tally's side of four uncounted released ballots is flagged.",
            revoters,
            snaps(6),
            openings_for([1, 2, 3, 4, 5]),
        )
    )

    within = {}
    within.update(crowd("a-", 25, 10))
    within.update(crowd("b-", 25, 11))
    # 20 entrants after the release at snapshot 1 meet the lag; 5 of them
    # later tie, so the final tally holds 15 that no release does.
    within.update(crowd("c-", 20, 12))
    for i in range(5):
        nid = f"c-{i:02d}"
        within[nid]["ballots"].append(ballot(nid, 2, segment=13, ref=112, votes=(0, 1)))
    cases.append(
        base_case(
            "final-within-batch",
            "The lag's 20 entrants include 5 that tie before the close, so the final tally less the last release has 15 ballots alone on one side: flagged, never withheld.",
            within,
            snaps(3),
            openings_for([1, 2]),
        )
    )

    late = {}
    late.update(crowd("a-", 25, 10))
    for i in range(25):
        nid = f"late-{i:02d}"
        late[nid] = {"tier": 0, "ballots": [ballot(nid, segment=10, ref=110, receipted=12)]}
    late.update(crowd("c-", 25, 13))
    cases.append(
        base_case(
            "late-receipts",
            "25 ballots boarded at snapshot 1 are fully receipted only at 3, so they enter there: they are the lag that lets the decision at 3 release snapshot 2, which holds only the 25 others, and release 3 adds them.",
            late,
            snaps(5),
            openings_for([2, 3]),
        )
    )

    breaches = dict(steady)
    ops = openings_for([1, 2, 3, 4, 5], signers=(1, 2))
    e = 2000
    extra = [
        {"entry": e, "cell": 0, "snapshot": 2, "signer": 3, "thisDefinition": False, "message": "other"},
        {"entry": e + 1, "cell": 4, "snapshot": 2, "signer": 3, "message": "no-cell"},
        {"entry": e + 2, "cell": 0, "snapshot": 6, "signer": 3, "message": "unscheduled-6"},
        {"entry": e + 3, "cell": 0, "snapshot": 6, "signer": None, "message": "unscheduled-6-unsigned"},
        {"entry": e + 4, "cell": 0, "snapshot": 3, "signer": 3, "aggregateOf": 2, "message": "older-set"},
        {"entry": e + 5, "cell": 0, "snapshot": 3, "signer": 3, "entries": 3, "message": "three-entries"},
        {"entry": e + 6, "cell": 0, "snapshot": 3, "signer": 4, "counts": [99, 0], "message": "wrong-count"},
        {"entry": e + 7, "cell": 0, "snapshot": 3, "signer": 4, "badR": 1, "message": "wrong-r"},
        {"entry": e + 8, "cell": 0, "snapshot": 3, "signer": None, "message": "unsigned"},
        {"entry": e + 9, "cell": 0, "snapshot": 3, "signer": 1, "message": "0/3/1"},
        {"entry": e + 10, "cell": 0, "snapshot": 3, "signer": 2, "message": "0/3/2-again"},
    ]
    cases.append(
        base_case(
            "boarding-breaches",
            "Every break of the boarding rule, with whom each is reported against; the unscheduled openings at snapshot 6 open its running set, a disclosure the batch rule never bounded.",
            breaches,
            snaps(6),
            ops + extra,
        )
    )

    conflict = dict(steady)
    cases.append(
        base_case(
            "conflict",
            "Seats 1 and 2 each publish a passing opening of every release, the same (V, R) under different signatures, which is no conflict; at release 2 an unattributed opening with other counts also opens the aggregate, which only a known log_g h allows, and 7.5 fails running-conflict.",
            conflict,
            snaps(3),
            openings_for([1, 2], signers=(1, 2))
            + [{"entry": 3000, "cell": 0, "snapshot": 2, "signer": None, "counts": [31, 19], "randomness": "forged", "bindingBroken": True, "message": "forged"}],
        )
    )

    rng = dict(steady)
    rng["over"] = {"tier": 0, "ballots": [ballot("over", segment=10, ref=110, votes=(2, 0))]}
    cases.append(
        base_case(
            "range",
            "A ballot no validity check would admit counts 2 at option 0; the totals of release 1 then exceed its running set's size at the question, and 7.5 fails running-question-range (each option's count stays within the size).",
            rng,
            snaps(3),
            openings_for([1, 2]),
        )
    )

    two = {}
    for i, seg in enumerate(range(10, 15)):
        two.update(crowd(f"big{i + 1}-", 30, seg, cell=0))
    two.update(crowd("small-", 12, 10, cell=1))
    two.update(crowd("small-mid-", 12, 12, cell=1))
    two.update(crowd("small-late-", 20, 14, cell=1))
    two.update(crowd("other-tier-", 25, 10, cell=2, tier=1))
    two.update(crowd("other-tier-b-", 25, 11, cell=2, tier=1))
    two.update(crowd("other-tier-c-", 25, 12, cell=2, tier=1))
    cases.append(
        base_case(
            "two-tiers",
            "Tier 0 has two cells, the small one holding the tier back until the decision at 5 releases snapshot 4; tier 1 releases on its own. Cell 1's opening of release 4 is missing, so tier 0 has no totals for it.",
            two,
            snaps(5),
            openings_for([4], cells=(0,)) + openings_for([1, 2], cells=(2,), start=1100),
            cell_tiers=(0, 0, 1),
        )
    )

    elections = []
    for c in cases:
        res = run(c)
        res.pop("statuses")
        elections.append({**c, "result": res})

    doc = {
        "format": "abolish-live-verifier-vectors/1",
        "title": "Live results in the verifier: snapshot heads, ballots at a snapshot, running sets, the release choice, running openings with their boarding breaches, the 7.5 and 7.6 rows and the final tally's least side",
        "spec": "docs/spec/verifier.md",
        "generator": "packages/crypto/scripts/live-verifier-vectors.py: an independent Python implementation of docs/spec/verifier.md (Releases) over docs/spec/tally.md (Live results), computing each final cut by the closed form, by maximum flow along every edge and by trying every vertex set",
        "minLiveBatch": str(MIN_LIVE_BATCH),
        "heads": heads,
        "ballots": admission_view,
        "elections": elections,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "live-verifier.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
