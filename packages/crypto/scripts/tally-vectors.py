#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/tally.json.

A second implementation of docs/spec/tally.md: the cell aggregates, the
trustees' summed shares and their check, the combination of k valid summed
shares and the opening checks, and coarser totals, written from the spec with
Python's integers. Ballots come from ballot-validity-vectors.py (itself built
on group-vectors.py's self-checked ristretto255), so nothing here shares code
with packages/crypto or @noble/curves.

Each opening is found by solving the Vandermonde system for every coefficient
of the summed polynomials (Gaussian elimination mod ℓ), and checked against the
Lagrange coefficients the spec writes, so the two methods cross-check.

Usage: python3 -I -B packages/crypto/scripts/tally-vectors.py <out-dir>
"""

import importlib.util
import json
import pathlib
import sys

_spec = importlib.util.spec_from_file_location(
    "ballot_validity_vectors", pathlib.Path(__file__).with_name("ballot-validity-vectors.py")
)
bv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bv)

grp = bv.grp
L = bv.L
G = bv.G
Hgen = bv.Hgen
IDENTITY = bv.IDENTITY


def enc_aggregate(agg):
    """`list<list<element, MAX_TRUSTEES>, MAX_OPTIONS>`, identity allowed (computed values)."""
    out = bv.u32(len(agg))
    for row in agg:
        out += bv.u32(len(row)) + b"".join(grp.encode(x) for x in row)
    return out


def aggregate(m, k, ballots):
    agg = [[IDENTITY] * k for _ in range(m)]
    for vss in ballots:
        assert len(vss) == m and all(len(e) == k for e in vss)
        for j in range(m):
            for t in range(k):
                agg[j][t] = grp.add(agg[j][t], vss[j][t])
    return agg


def sum_shares(m, lists):
    v = [0] * m
    r = [0] * m
    for lst in lists:
        assert len(lst) == m
        for j, s in enumerate(lst):
            v[j] = (v[j] + s["v"]) % L
            r[j] = (r[j] + s["r"]) % L
    return [{"v": v[j], "r": r[j]} for j in range(m)]


def solve_constant(points):
    """The constant term of the degree-(len − 1) polynomial through `points`, by Gaussian elimination mod ℓ."""
    k = len(points)
    rows = [[pow(x, t, L) for t in range(k)] + [y % L] for x, y in points]
    for col in range(k):
        piv = next(i for i in range(col, k) if rows[i][col] % L)
        rows[col], rows[piv] = rows[piv], rows[col]
        inv = pow(rows[col][col], L - 2, L)
        rows[col] = [(x * inv) % L for x in rows[col]]
        for i in range(k):
            if i != col and rows[i][col]:
                f = rows[i][col]
                rows[i] = [(a - f * b) % L for a, b in zip(rows[i], rows[col])]
    return rows[0][k]


def lagrange(seats):
    out = []
    for i in seats:
        num, den = 1, 1
        for l in seats:
            if l != i:
                num = num * l % L
                den = den * (l - i) % L
        out.append(num * pow(den, L - 2, L) % L)
    return out


def enc_shares_raw(shares):
    """`list<share>` with each scalar written as 32 bytes little-endian, without the < ℓ check, for rejection vectors."""
    return bv.u32(len(shares)) + b"".join(s["v"].to_bytes(32, "little") + s["r"].to_bytes(32, "little") for s in shares)


def check_opening(m, ballots, agg, opening):
    """docs/spec/tally.md, Opening checks: the verifier's check of a published opening."""
    if opening is None or len(opening) != m or not all(0 <= x < L for s in opening for x in (s["v"], s["r"])):
        return {"ok": False, "code": "tally-missing"}
    for j, s in enumerate(opening):
        if not grp.equal(bv.pedersen(s["v"], s["r"]), agg[j][0]):
            return {"ok": False, "code": "tally-opening", "option": j}
        if s["v"] > len(ballots):
            return {"ok": False, "code": "tally-range", "option": j}
    return {"ok": True, "counts": [str(s["v"]) for s in opening]}


def honest_opening(m, honest, k):
    """Each option's (F(0), G(0)) from seats 1..k's honest sums, by solving for every coefficient."""
    return [
        {
            "v": solve_constant([(i, honest[i][j]["v"]) for i in range(1, k + 1)]),
            "r": solve_constant([(i, honest[i][j]["r"]) for i in range(1, k + 1)]),
        }
        for j in range(m)
    ]


def open_cell(m, k, n, ballots, summed):
    """docs/spec/tally.md, Combination and opening; `summed` maps seat to its list."""
    agg = aggregate(m, k, ballots)
    passing, excluded = [], []
    for seat in sorted(summed):
        assert 1 <= seat <= n
        canonical = all(0 <= x < L for s in summed[seat] for x in (s["v"], s["r"]))
        (passing if canonical and bv.check_shares(agg, seat, summed[seat]) else excluded).append(seat)
    if len(passing) < k:
        return agg, {"ok": False, "code": "tally-quorum", "excluded": excluded}
    q = passing[:k]
    lam = lagrange(q)
    counts, rand = [], []
    for j in range(m):
        v = solve_constant([(i, summed[i][j]["v"]) for i in q])
        r = solve_constant([(i, summed[i][j]["r"]) for i in q])
        assert v == sum(l * summed[i][j]["v"] for l, i in zip(lam, q)) % L
        assert r == sum(l * summed[i][j]["r"] for l, i in zip(lam, q)) % L
        if not grp.equal(bv.pedersen(v, r), agg[j][0]):
            return agg, {"ok": False, "code": "tally-opening", "option": j, "excluded": excluded}
        if v > len(ballots):
            return agg, {"ok": False, "code": "tally-range", "option": j, "excluded": excluded}
        counts.append(v)
        rand.append(r)
    return agg, {
        "ok": True,
        "combined": q,
        "lagrange": [str(x) for x in lam],
        "counts": [str(x) for x in counts],
        "randomness": [str(x) for x in rand],
        "excluded": excluded,
    }


def main():
    out = sys.argv[1]
    grp.self_check()

    cells = []
    made = {}
    honest_cells = {}

    def cell(id_, desc, ctx, votes_list, tamper=None, absent=()):
        """`tamper` maps a seat to (description, function of its honest summed list → the list it sends)."""
        tamper = tamper or {}
        m, k, n = ctx["optionCount"], ctx["threshold"], ctx["panelSize"]
        made_ballots = [bv.make_ballot(f"tally/{id_}/{b}", ctx, v) for b, v in enumerate(votes_list)]
        vss = [vote["vss"] for vote, _, _ in made_ballots]
        per_seat = {i: [shares[i - 1] for _, _, shares in made_ballots] for i in range(1, n + 1)}
        honest = {i: sum_shares(m, per_seat[i]) for i in per_seat}
        summed = {}
        received = []
        for i in range(1, n + 1):
            if i in absent:
                continue
            if i in tamper:
                how, f = tamper[i]
                summed[i] = f(honest[i], per_seat[i])
            else:
                how = "honest"
                summed[i] = honest[i]
            received.append({"seat": i, "how": how, "shares": bv.enc_shares(summed[i]).hex()})
        agg, result = open_cell(m, k, n, vss, summed)
        for p in received:
            p["valid"] = bv.check_shares(agg, p["seat"], summed[p["seat"]])
            assert p["valid"] == (p["how"] == "honest"), (id_, p["seat"])
        made[id_] = result
        honest_cells[id_] = (m, vss, agg, honest_opening(m, honest, k))
        cells.append(
            {
                "id": id_,
                "description": desc,
                "rules": {"optionCount": m, "threshold": k, "panelSize": n},
                "ballots": [{"votes": v, "vss": bv.enc_vss(b).hex()} for v, b in zip(votes_list, vss)],
                "trusteeShares": [
                    {"seat": i, "ballotShares": [bv.enc_shares(s).hex() for s in per_seat[i]], "summed": bv.enc_shares(honest[i]).hex()}
                    for i in range(1, n + 1)
                ],
                "aggregate": enc_aggregate(agg).hex(),
                "received": received,
                "result": result,
            }
        )
        return result

    def bump(j):
        return lambda s, _: [dict(x, v=(x["v"] + 1) % L) if i == j else x for i, x in enumerate(s)]

    def missing_ballot(m):
        return lambda _, lists: sum_shares(m, lists[1:])

    swap01 = lambda s, _: [s[1], s[0]] + s[2:]
    short = lambda s, _: s[:-1]

    plur = bv.context("tally-plurality", 3, 0, 1, 2, 3)
    appr = bv.context("tally-approval", 5, 0, 3, 3, 5, 2)

    cell(
        "plurality-honest",
        "Plurality, 3 options, k = 2, n = 3, five ballots (one blank); every trustee sends honest sums",
        plur,
        [[1, 0, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0], [0, 0, 1]],
    )
    cell(
        "approval-excluded",
        "Approval, 5 options, k = 3, n = 5, four ballots; seat 1's first option is off by one and seat 5's list is one option short, so both are excluded and seats 2, 3 and 4 combine",
        appr,
        [[1, 0, 1, 0, 0], [0, 1, 1, 1, 0], [0, 0, 0, 0, 0], [1, 1, 0, 0, 1]],
        tamper={1: ("first option's v + 1", bump(0)), 5: ("one option short", short)},
    )
    cell(
        "approval-quorum",
        "Approval, k = 3: seat 1 sums without the first ballot, seat 3 swaps options 0 and 1, seat 4 sends nothing; two pass, fewer than k",
        appr,
        [[1, 0, 1, 0, 0], [0, 1, 1, 1, 0], [1, 1, 0, 0, 1]],
        tamper={1: ("sum missing the first ballot", missing_ballot(5)), 3: ("options 0 and 1 swapped", swap01)},
        absent=(4,),
    )
    cell(
        "plurality-high-seats",
        "Plurality, k = 2, n = 3: seat 1 sends nothing, so seats 2 and 3 combine",
        plur,
        [[0, 1, 0], [0, 1, 0], [1, 0, 0]],
        absent=(1,),
    )
    cell("empty", "A cell with no counted ballots: every aggregate is the identity and every sum (0, 0)", plur, [])
    cell("single-ballot", "A cell with one counted ballot: its opening reveals that ballot (flagged, verifier 8.2)", plur, [[0, 0, 1]])
    cell(
        "trustees-max",
        "MAX_TRUSTEES: k = n = 16, 2 options, three ballots",
        bv.context("tally-trustees-max", 2, 0, 1, 16, 16),
        [[1, 0], [0, 1], [1, 0]],
    )
    cell(
        "options-max",
        "MAX_OPTIONS: 64 options, approval with no limit, k = 2, n = 3, two ballots",
        bv.context("tally-options-max", 64, 0, 64, 2, 3, 1),
        [[1 if j % 3 == 0 else 0 for j in range(64)], [1 if j % 5 == 0 else 0 for j in range(64)]],
    )
    cell(
        "range-vote-of-two",
        "A cell whose only ballot holds a vote of 2 for option 0, which no validity check admits: the opening is 2 > 1 ballot (tally-range)",
        plur,
        [[2, 0, 0]],
    )
    cell("tier-0", "Two cells of one election: tier 0, three ballots", plur, [[1, 0, 0], [0, 0, 1], [1, 0, 0]])
    cell("tier-1", "Two cells of one election: tier 1, two ballots", plur, [[0, 1, 0], [1, 0, 0]])

    def counts(id_):
        return [int(x) for x in made[id_]["counts"]]

    openings = []

    def opening(id_, cell_id, desc, change=None, expect=None):
        m, vss, agg, honest = honest_cells[cell_id]
        sent = honest if change is None else change(honest)
        got = check_opening(m, vss, agg, sent)
        if expect is not None:
            assert got == expect, (id_, got, expect)
        openings.append(
            {
                "id": id_,
                "cell": cell_id,
                "description": desc,
                "opening": None if sent is None else enc_shares_raw(sent).hex(),
                "result": got,
            }
        )
        return got

    for cell_id, r in made.items():
        if r["ok"]:
            got = opening(f"{cell_id}-valid", cell_id, "The cell's honest opening")
            assert got == {"ok": True, "counts": r["counts"]}, cell_id

    def at(j, **kw):
        return lambda o: [dict(s, **{key: (s[key] + d) % L for key, d in kw.items()}) if i == j else s for i, s in enumerate(o)]

    opening("count-plus-one", "plurality-honest", "Option 1's count is one more than the cell's", at(1, v=1), {"ok": False, "code": "tally-opening", "option": 1})
    opening("randomness-plus-one", "plurality-honest", "Option 0's randomness is off by one", at(0, r=1), {"ok": False, "code": "tally-opening", "option": 0})
    opening("options-swapped", "tier-0", "Options 0 and 2 swapped", lambda o: [o[2], o[1], o[0]], {"ok": False, "code": "tally-opening", "option": 0})
    opening("short", "plurality-honest", "One option fewer than the election", lambda o: o[:-1], {"ok": False, "code": "tally-missing"})
    opening("missing", "plurality-honest", "No opening on the board for the cell", lambda o: None, {"ok": False, "code": "tally-missing"})
    opening("count-plus-order", "plurality-honest", "Option 0's count encoded as V + ℓ, the same value mod ℓ: no canonical encoding, so it is no opening", lambda o: [dict(o[0], v=o[0]["v"] + L)] + o[1:], {"ok": False, "code": "tally-missing"})
    opening("vote-of-two", "range-vote-of-two", "The vote-of-2 cell's opening: it opens the aggregate, with a count of 2 over 1 ballot", None, {"ok": False, "code": "tally-range", "option": 0})

    totals = [
        {
            "id": "overall-two-tiers",
            "description": "The overall result of the election with cells tier-0 and tier-1: per option, the sum of the cells' counts",
            "cells": ["tier-0", "tier-1"],
            "total": [str(a + b) for a, b in zip(counts("tier-0"), counts("tier-1"))],
        }
    ]
    assert totals[0]["total"] == ["3", "1", "1"]
    assert made["plurality-honest"]["counts"] == ["2", "1", "1"]
    assert made["approval-excluded"]["combined"] == [2, 3, 4]
    assert made["approval-quorum"]["code"] == "tally-quorum"
    assert made["range-vote-of-two"]["code"] == "tally-range"

    data = {
        "format": "abolish-tally-vectors/1",
        "title": "Tally: cell aggregates, summed shares and openings",
        "spec": "docs/spec/tally.md",
        "generator": (
            "packages/crypto/scripts/tally-vectors.py: an independent Python implementation of docs/spec/tally.md, "
            "with ballots from ballot-validity-vectors.py; openings found by solving for every coefficient and "
            "cross-checked against the Lagrange coefficients listed"
        ),
        "cells": cells,
        "openings": openings,
        "totals": totals,
    }
    with open(f"{out}/tally.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
