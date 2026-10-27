#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-openings-v3-author.json.

Elections for the verifier's spoiled-ballot openings beside an author panel
(docs/spec/verifier.md, Key ceremony, step 5, and Spoiled-ballot openings;
6.2; challenge.md, Opening version 3): a version-6 definition, or, for
docs/spec/vectors/verifier-openings-v3-author-definition-v7.json, the same
election under definition version 7 with a fixed electorate, which the
verifier reads as version 6 under version 7's own hashes and stubs
(docs/spec/verifier.md, Definition), with a 2-of-3 author panel whose seat
3 sent nothing, beside the 3-of-4 default panel whose seat 4 sent nothing,
its board carrying both runs' transcripts and the author approvals record. Each opening's author half is checked against the author
panel's registered key set, the output of its own run, approved on the
board, and each author seat's ciphertext rebuilt under its key there, never a
key the opening or the default panel names (T-37, T-17). Each case is a
definition, a clock, a board copy and the default panel a bundle pins, with
the rows 2.3 and 6.2 a verifier reports and the report's `openings`.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier:
verifier-ballots-v4-author-vectors.py (the election, both runs, the
approvals record and the ballots, rebuilt from their labels),
verifier-ceremony-vectors.py and ceremony-vectors.py (board entries and both
runs' checks, which give the registered seats' KEM keys),
spoiled-opening-v3-vectors.py (opening version 3: its record, its checks in
order over both halves, the core hash and what a passing opening opens) and
verifier-openings-v3-vectors.py (6.2's expected row and report, from the
floor of `s_S`, `period(closes_at) + 1`, and challenge.md's Publication
rules).

The ballots' membership proofs are randomised, so their records are read
from the committed verifier-ballots-v4-author.json (its "author-mixed" case),
or verifier-ballots-v4-author-definition-v7.json for version 7, and checked
against the ballots rebuilt here; nothing else needs a prover. Every other
value comes from fixed labels (test data, never keys).

Usage: python3 -I -B verifier-openings-v3-author-vectors.py <constants> <out-dir> [7],
where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json
and a final `7` makes the definition-version-7 file; then `vp check --fix`
(the committed file is formatted).
"""

import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)
VECTORS = HERE.parents[3] / "docs" / "spec" / "vectors"


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


vba = _load("verifier_ballots_v4_author_vectors", "verifier-ballots-v4-author-vectors.py")
vo3 = _load("verifier_openings_v3_vectors", "verifier-openings-v3-vectors.py")
so3, vo, vb4 = vo3.so3, vo3.vo, vo3.vb4
vc, cv, r4, b3 = vba.vc, vba.cv, vba.r4, vba.b3
sev4, se, bv, grp = so3.sev4, so3.se, so3.bv, so3.grp
L = so3.L
DEFAULT, AUTHOR = so3.DEFAULT, so3.AUTHOR
OPENING_TYPE = vo3.OPENING_TYPE

# Board-entry version 7, which carries the author approvals (board.md,
# Allowed payloads); verifier-openings-v3-vectors.py reads entries under the
# version it is given here.
BOARD_VERSION = vba.BOARD_VERSION
vo3.BOARD_VERSION = BOARD_VERSION
vo3.vc.ALLOWED[BOARD_VERSION] = vba.vc.ALLOWED[BOARD_VERSION]
PERIOD = 3600
outcome = vc.outcome


def main(constants, out_dir, version=6):
    s = vba.build(constants, version)
    src = next(b for b in s["bundles"] if b["id"] == "author-mixed")
    d, ev, run = src["definition"], src["election"], src["run"]
    panel, author = s["panel"], s["author"]
    eid = d["election_id"]
    t_a, t_d, approved = src["board"][:3]
    assert t_a == run["transcript"] and run["registered"] == [1, 2]
    assert vc.own_version(d) == version

    source = "verifier-ballots-v4-author.json" if version == 6 else "verifier-ballots-v4-author-definition-v7.json"
    committed = next(c for c in json.loads((VECTORS / source).read_text())["cases"] if c["id"] == "author-mixed")
    records = [vc.decode_entry(x, BOARD_VERSION)["payload"] for x in vo.split(bytes.fromhex(committed["board"]))]
    assert records[:3] == [t_a, t_d, approved]
    ballots = [p[0] for p in src["board"][3:]]
    assert len(records) == len(ballots) + 3
    for rec, b in zip(records[3:], ballots):
        core = vo3.ballot_core(rec)
        assert core["definitionHash"] == b["definitionHash"]
        for half in ("vss", "authorVss"):
            assert [[grp.encode(x) for x in row] for row in core[half]] == [[grp.encode(x) for x in row] for row in b["vote"][half]]

    # Both panels' registered seats' KEM keys, from their own runs: the
    # default run over the default stub, the author run over the author stub.
    own = vc.cv.check(dict(panel, otherKeys=list(author["keys"])), t_d, vc.election_of(d))
    theirs = cv.check(author, t_a, vba.context(d, vba.author_stub_hash(d)))
    assert own["ok"] and [k["index"] for k in own["registered"]] == [1, 2, 3]
    assert theirs["ok"] and [k["index"] for k in theirs["registered"]] == [1, 2]

    def kem_keys(checked, n):
        by = {}
        for k in checked["registered"]:
            raw = bytes.fromhex(k["kemKey"])
            by[k["index"]] = {"ek": raw[:1184], "dh": grp.decode(raw[1184:])}
        return [by.get(i) for i in range(1, n + 1)]

    keys = {DEFAULT: kem_keys(own, ev["panelSize"]), AUTHOR: kem_keys(theirs, ev["authorPanelSize"])}
    e = {
        "definitionHash": ev["definitionHash"],
        "questions": ev["questions"],
        "offsets": ev["offsets"],
        "optionTotal": ev["optionTotal"],
        "threshold": ev["threshold"],
        "panelSize": ev["panelSize"],
        "authorThreshold": ev["authorThreshold"],
        "authorPanelSize": ev["authorPanelSize"],
        "cells": len(ev["cells"]),
        "registered": {DEFAULT: [1, 2, 3], AUTHOR: [1, 2]},
    }
    # Pick one of three, pick up to two of four, pick exactly one of two;
    # cells 0 to 2; a 3-of-4 default panel and a 2-of-3 author panel.
    assert [q["optionCount"] for q in e["questions"]] == [3, 4, 2] and e["cells"] == 3
    assert (e["threshold"], e["panelSize"], e["authorThreshold"], e["authorPanelSize"]) == (3, 4, 2, 3)

    def opening(label, cell, votes, bind=None):
        o, _ = so3.make_opening("verifier-openings-v3-author/" + label, e, keys, cell, votes, bind)
        return o

    def opening_of(label, polys, author_polys, cell):
        """An honest opening of these halves' polynomials: fresh encapsulation randomness, real ciphertexts to each panel's registered seats."""
        rng = bv.Rng("verifier-openings-v3-author/encapsulation/" + label)
        vss = [[bv.pedersen(p["f"][i], p["g"][i]) for i in range(len(p["f"]))] for p in polys]
        avss = [[bv.pedersen(p["f"][i], p["g"][i]) for i in range(len(p["f"]))] for p in author_polys]
        both = {"vss": vss, "authorVss": avss}
        out = {}
        for p, ps, n in ((DEFAULT, polys, e["panelSize"]), (AUTHOR, author_polys, e["authorPanelSize"])):
            hashes, seats = [], []
            for seat in range(1, n + 1):
                if seat not in e["registered"][p]:
                    hashes.append(bytes(32))
                    continue
                m, ee, w = rng.bytes32(), se.nonzero_scalar(rng), se.nonzero_scalar(rng)
                shares = [{"v": bv.evaluate(q["f"], seat), "r": bv.evaluate(q["g"], seat)} for q in ps]
                ct, _ = sev4.encrypt(e["definitionHash"], p, seat, keys[p][seat - 1], both, bv.enc_shares(shares), m, ee, w)
                hashes.append(se.share_hash(ct))
                seats.append({"seat": seat, "m": m, "e": ee, "w": w})
            out[p] = (hashes, seats)
        return {
            "definitionHash": e["definitionHash"],
            "cell": cell,
            "vss": vss,
            "shareHashes": out[DEFAULT][0],
            "authorVss": avss,
            "authorShareHashes": out[AUTHOR][0],
            "polynomials": polys,
            "authorPolynomials": author_polys,
            "seats": out[DEFAULT][1],
            "authorSeats": out[AUTHOR][1],
        }

    def constants_of(label, votes):
        """A cast ballot's constant terms per option, drawn as ballot-v4-vectors.py's make_ballot drew them from its label: r_j, the author half's (a_j, s_j), then the halves' other coefficients; the default half's are (v_j − a_j, r_j − s_j)."""
        k, k_a = e["threshold"], e["authorThreshold"]
        rng = bv.Rng("ballot-v4/verifier-ballot-v4-author/" + ev["label"] + "/" + label)
        out = []
        for v in votes:
            r = rng.scalar()
            a, s_ = rng.scalar(), rng.scalar()
            for _ in range(2 * (k - 1) + 2 * (k_a - 1)):
                rng.scalar()
            out.append({"v": v % L, "r": r, "a": a, "s": s_})
        return out

    def fresh_polys(rng, k, f0, g0):
        return {"f": [f0 % L] + [rng.scalar() for _ in range(k - 1)], "g": [g0 % L] + [rng.scalar() for _ in range(k - 1)]}

    def recast(label, ballot, votes, option, cell, keep):
        """A core that re-uses one cast ballot's commitment at flat `option`, every other value fresh: with `keep` "product", its (v_j, r_j) split afresh between the halves, so only C_j = E^D_{j,0} · E^A_{j,0} is the ballot's; with "author", its author half's constant terms (a_j, s_j), so only E^A_{j,0} is, beside a fresh default half (challenge.md, Opening version 3, Opened commitments)."""
        k, k_a = e["threshold"], e["authorThreshold"]
        cast = constants_of(label, votes)[option]
        c = cast
        product = grp.add(bv.pedersen((c["v"] - c["a"]) % L, (c["r"] - c["s"]) % L), bv.pedersen(c["a"], c["s"]))
        assert grp.equal(bv.pedersen(c["a"], c["s"]), ballot["vote"]["authorVss"][option][0])
        assert grp.equal(product, grp.add(ballot["vote"]["vss"][option][0], ballot["vote"]["authorVss"][option][0]))
        rng = bv.Rng(f"verifier-openings-v3-author/recast/{keep}/{label}")
        polys, author_polys = [], []
        for j in range(len(votes)):
            if j == option and keep == "product":
                a, s_ = rng.scalar(), rng.scalar()
                v, r = c["v"], c["r"]
            elif j == option:
                a, s_ = c["a"], c["s"]
                v, r = rng.scalar(), rng.scalar()
            else:
                a, s_ = rng.scalar(), rng.scalar()
                v, r = 0, rng.scalar()
            polys.append(fresh_polys(rng, k, v - a, r - s_))
            author_polys.append(fresh_polys(rng, k_a, a, s_))
        o = opening_of(f"recast/{keep}/{label}", polys, author_polys, cell)
        assert so3.opens(o, {"definitionHash": e["definitionHash"], "vss": ballot["vote"]["vss"], "authorVss": ballot["vote"]["authorVss"]})
        return o

    b_a, _, b_t2 = ballots[:3]
    assert (b_a["cell"], b_t2["cell"]) == (0, 2)
    rec_a, rec_t2 = records[3], records[5]
    votes_a = b3.flat([(3, [1]), (4, [0, 3]), (2, [1])])
    votes_t2 = b3.flat([(3, []), (4, []), (2, [1])])
    honest = opening("honest", 0, b3.flat([(3, [1]), (4, [0, 3]), (2, [1])]))
    honest2 = opening("honest-2", 2, b3.flat([(3, []), (4, [2]), (2, [0])]))
    early = opening("early", 1, b3.flat([(3, [0]), (4, []), (2, [1])]))
    # The cell-0 ballot's question 1 option 3 (flat 6) by its product, and its
    # question 0 option 1 (flat 1) by its author half alone; the tier-2
    # ballot's question 2 option 1 (flat 8) by its author half alone.
    cast_a = recast("cell-0", b_a, votes_a, 6, 0, "product")
    cast_a_author = recast("cell-0", b_a, votes_a, 1, 0, "author")
    cast_t2_author = recast("tier-2", b_t2, votes_t2, 8, 2, "author")
    outside = opening("outside", 1, b3.flat([(3, [2]), (4, [0, 1, 2]), (2, [0])]))
    stray = dict(honest2, definitionHash=vb4.det("verifier-openings-v3-author other definition"))
    # Author halves of the wrong shape: one registered author seat's
    # randomness missing; none at all on a poll with an author panel, whose
    # shape is the definition's, never the opening's (T-17, T-37).
    author_seat_missing = dict(honest2, authorSeats=honest2["authorSeats"][:1])
    no_author_half = dict(honest2, authorVss=[], authorShareHashes=[], authorPolynomials=[], authorSeats=[])
    # A share hash at author seat 3, which isn't registered.
    author_unqualified = dict(honest2, authorShareHashes=honest2["authorShareHashes"][:2] + [vb4.det("verifier-openings-v3-author unqualified")])
    author_vss = opening("author-vss", 0, b3.flat([(3, [0]), (4, [1]), (2, [0])]))
    author_vss["authorPolynomials"] = [dict(p) for p in author_vss["authorPolynomials"]]
    p4 = author_vss["authorPolynomials"][4]
    author_vss["authorPolynomials"][4] = {"f": [p4["f"][0], (p4["f"][1] + 1) % L], "g": p4["g"]}
    # Author seat 2's ciphertext bound to the default panel: it decrypts, but
    # isn't the author seat's (share-encryption.md, Associated data; T-37).
    author_ciphertext = opening("author-ciphertext", 2, b3.flat([(3, [1]), (4, []), (2, [0])]), bind=lambda p, seat: DEFAULT if p == AUTHOR and seat == 2 else p)
    enc = so3.enc_opening

    clock = {"epoch": d["closes_at"] - 2 * PERIOD, "period": PERIOD, "deadline": 7200, "lastSegment": 8}
    assert vo.floor_of(d["closes_at"], clock) == 3

    def board(segments):
        """`segments`: (segment, [payload]) in order; openings go last in their segment, sorted (board.md, Spoiled-ballot openings)."""
        out = []
        for seg, payloads in segments:
            others = [p for p in payloads if int.from_bytes(p[:2], "big") != OPENING_TYPE]
            opens = sorted(p for p in payloads if int.from_bytes(p[:2], "big") == OPENING_TYPE)
            assert len(set(opens)) == len(opens)
            for p in others + opens:
                out.append(vc.entry(BOARD_VERSION, eid, len(out), seg, p))
        return out

    runs = [t_a, t_d]
    cases = []

    def case(id_, description, segments, want_status):
        if version == 7:
            description = description.replace("Definition version 6", "Definition version 7 under a fixed electorate")
        entries = board(segments)
        ceremony_rows, _ = vc.expected(panel, d, entries, panel, BOARD_VERSION)
        assert ceremony_rows["3.2"] == outcome("pass"), id_
        payloads = [p for _, ps in segments for p in ps]
        seats = vba.approving(d, author, run["hash"], run["keySetHash"], [p for p in payloads if int.from_bytes(p[:2], "big") == vba.ac.APPROVALS_TYPE])
        if seats is not None and len(seats) >= max(author["k"], len(author["keys"]) - 1):
            row, report = vo3.expected(d, e, keys, entries, clock)
        else:
            # No approved author key set: admission, and so 6.2, isn't reached.
            row, report = vc.NOT_REACHED, None
        assert row["status"] == want_status, (id_, row)
        c = {
            "id": id_,
            "description": description,
            "panel": "panel-4",
            "definition": vc.encode(d).hex(),
            "clock": {k: str(v) for k, v in clock.items()},
            "board": b"".join(entries).hex(),
            "expected": {"2.3": vb4.COMBINATION_FAILS, "6.2": row},
        }
        if report is not None:
            c["openings"] = report
        cases.append(c)
        return c

    mixed = case(
        "mixed",
        "Definition version 6 with a 2-of-3 author panel whose seat 3 sent nothing; close falls in period 2, so s_S is at least 3. Both transcripts, the approvals record and the cell-0 ballot in segment 0 (counted whatever s_S is), the tier-2 ballot in segment 4 (rejected as boarded late, 5.5, so never counted); an honest opening in segment 3 (early); in segment 5 an honest opening, one of three picks in question 1 (outside at question 1), a stray one, one failing each check over the author half (opening-shape twice, for a registered author seat's missing randomness and for no author half at all; opening-unqualified for a share hash at author seat 3; opening-vss at flat option 4 of the author half; opening-ciphertext for author seat 2's ciphertext bound to the default panel), and three that re-use a ballot's commitment under other share hashes: the segment-0 ballot's C_j (cast), its author half's E^A_{j,0} alone (cast), and the segment-4 ballot's author half (not cast: that ballot isn't admitted, and the opening is undecided until s_S is known); in segment 6 a byte-identical copy of the honest one (a repeat). The honest openings above the floor may still be early or late once s_S is known, so 6.2 is unverifiable.",
        [
            (0, runs + [approved, rec_a]),
            (3, [enc(early)]),
            (4, [rec_t2]),
            (
                5,
                [
                    enc(honest),
                    enc(outside),
                    enc(stray),
                    enc(author_seat_missing),
                    enc(no_author_half),
                    enc(author_unqualified),
                    enc(author_vss),
                    enc(author_ciphertext),
                    enc(cast_a),
                    enc(cast_a_author),
                    enc(cast_t2_author),
                ],
            ),
            (6, [enc(honest)]),
        ],
        "unverifiable",
    )
    codes = [o.get("code") for o in mixed["openings"]]
    assert set(codes) == {None, "opening-stray", "opening-shape", "opening-unqualified", "opening-vss", "opening-ciphertext"}, codes
    assert codes.count("opening-shape") == 2
    assert [(o["option"], o["panel"]) for o in mixed["openings"] if o.get("code") == "opening-vss"] == [(4, AUTHOR)]
    assert [(o["seat"], o["panel"]) for o in mixed["openings"] if o.get("code") == "opening-ciphertext"] == [(2, AUTHOR)]
    breaks = [b["code"] for o in mixed["openings"] for b in o["breaks"]]
    assert breaks.count("opening-cast") == 2 and breaks.count("opening-early") == 1 and breaks.count("opening-repeat") == 1, breaks
    # The recast cores leave every other option 0 (question 2, pick exactly
    # one, blank) or give a random vote (question 0); three picks fall
    # outside at question 1.
    assert sorted(o["question"] for o in mixed["openings"] if o.get("voteOutside")) == [0, 1, 2, 2]

    case(
        "author-cast",
        "Every opening breaks a rule the floor decides: in segment 5 one re-using only the segment-0 ballot's author half (cast), in segment 6 one re-using its C_j (cast) and in segment 7 a copy of the first (repeat). 6.2 fails at the first, opening-cast: an author half's commitment is the ballot's as much as the product is.",
        [(0, runs + [approved, rec_a]), (5, [enc(cast_a_author)]), (6, [enc(cast_a)]), (7, [enc(cast_a_author)])],
        "fail",
    )
    case(
        "author-ciphertext-first",
"An opening in segment 2 whose author seat 2 ciphertext is bound to the default panel, ahead of an honest one in segment 3: both are early, and 6.2 fails at the first with its check's code, opening-ciphertext with panel 2 and seat 2.",
        [(0, runs + [approved, rec_a]), (2, [enc(author_ciphertext)]), (3, [enc(early)])],
        "fail",
    )
    case(
        "author-cast-at-floor",
        "An opening re-using the tier-2 ballot's author half, with that ballot in segment 3, the floor itself: counted whatever s_S is, so the opening is cast and 6.2 fails.",
        [(0, runs + [approved, rec_a]), (3, [rec_t2]), (5, [enc(cast_t2_author)])],
        "fail",
    )
    case(
        "author-cast-above-floor",
        "The same opening with the tier-2 ballot in segment 4, above the floor: 5.5 rejects that ballot as boarded late, so the opening re-uses no admitted ballot's commitment, and it is undecided until s_S is known, so 6.2 is unverifiable.",
        [(0, runs + [approved, rec_a]), (4, [rec_t2]), (5, [enc(cast_t2_author)])],
        "unverifiable",
    )
    case(
        "approvals-missing",
        "The mixed case's honest openings with no approvals record on the copy: the author panel's key set isn't approved, so no ballot is admitted and no opening is judged; 6.2 is not reached.",
        [(0, runs + [rec_a]), (3, [enc(early)]), (5, [enc(honest), enc(author_ciphertext)])],
        "unverifiable",
    )
    case("none", "Both runs, the approvals and ballots, and no opening: 6.2 passes.", [(0, runs + [approved, rec_a]), (4, [rec_t2])], "pass")
    by = {c["id"]: c for c in cases}
    assert by["author-cast"]["expected"]["6.2"] == outcome("fail", "opening-cast", {"entry": 4})
    assert [o["breaks"] for o in by["author-cast"]["openings"]][2] == [{"code": "opening-cast", "ballot": 3}, {"code": "opening-repeat", "of": 4}]
    assert by["author-ciphertext-first"]["expected"]["6.2"]["code"] == "opening-ciphertext"
    assert by["approvals-missing"]["expected"]["6.2"] == vc.NOT_REACHED

    if version == 7:
        # An honest opening made for the same election read as version 6
        # binds that reading's hash, another election's, into the core and
        # every ciphertext's associated data under both panels' keys (T-12,
        # T-34, T-37).
        v6_hash = vb4.H(vb4.ds(vb4.DEFINITION_TAG, vc.encode(vb4.v6_reading(d))))
        assert v6_hash != e["definitionHash"]
        e6 = dict(e, definitionHash=v6_hash)
        v6_reading, _ = so3.make_opening("verifier-openings-v3-author/v6-reading", e6, keys, 2, b3.flat([(3, []), (4, [2]), (2, [0])]), None)
        assert so3.check_opening(e6, v6_reading, keys)[0] == "ok"
        c = case(
            "v6-reading",
            "Definition version 7 under a fixed electorate, beside the author panel, with an opening in segment 5 made honestly for the same election read as version 6 (its version-6 hash, in the core and in both halves' ciphertexts' associated data): it is opening-stray, so 6.2 fails.",
            [(0, runs + [approved, rec_a]), (5, [enc(v6_reading)])],
            "fail",
        )
        assert [o.get("code") for o in c["openings"]] == ["opening-stray"], c["openings"]

    doc = {
        "format": "abolish-verifier-openings-vectors/1",
        "title": f"The verifier's spoiled-ballot openings beside an author panel (definition version {'6' if version == 6 else '7 with a fixed electorate'}, opening version 3): definitions, clocks, boards carrying both panels' transcripts and the author approvals, and the pinned default panel, with the rows 2.3 and 6.2 and the report's openings",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-openings-v3-author-vectors.py, from verifier-ballots-v4-author-vectors.py, "
            "verifier-ceremony-vectors.py, ceremony-vectors.py, spoiled-opening-v3-vectors.py and verifier-openings-v3-vectors.py "
            f"(independent Python implementations); the ballot records are {source}'s"
        ),
        "panels": {"panel-4": {"threshold": str(panel["k"]), "keys": [k.hex() for k in panel["keys"]]}},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-openings-v3-author.json" if version == 6 else "verifier-openings-v3-author-definition-v7.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4) or sys.argv[3:] not in ([], ["7"]):
        raise SystemExit("usage: verifier-openings-v3-author-vectors.py <constants> <out-dir> [7]")
    main(sys.argv[1], sys.argv[2], 7 if sys.argv[3:] else 6)
