#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-openings-v3-rolling.json.

Elections for the verifier's spoiled-ballot openings under a rolling
definition (definition version 7, `electorate_mode` 2), whose openings are
version 3 and open both halves of ballot version 5's cores, each tracking
code the core hash under version input 5 (docs/spec/verifier.md,
Spoiled-ballot openings; 6.2; challenge.md, Opening version 3, Core and
tracking code): each is an election definition, a clock, a board copy and
the panel a bundle pins, with the row 6.2 a verifier reports and the
report's `openings`. The openings are checked against the definition's cells
(one per rolling tier) and questions and the registered key set the
transcript gives, over both halves, and against challenge.md's Publication
rules as far as the floor of `s_S`, `period(closes_at) + 1` (tally.md, Tally
window), decides them. The poll has no author panel, as
verifier-ballots-v5.json's has none.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ballots-v5-vectors.py
(the rolling election, its transcript and ballots, rebuilt from their
labels), ballot-v5-records-vectors.py (version 5's core hash),
verifier-ceremony-vectors.py (board entries and the ceremony check, which
gives the registered seats' KEM keys), spoiled-opening-v3-vectors.py (opening
version 3: its record, its checks in order over both halves, what a passing
opening opens and the client's openings, over share-encryption-v4-vectors.py's
ciphertexts) and verifier-openings-v3-vectors.py (the record reader and 6.2's
rules over a board).

The ballots' membership proofs are randomised, so their records are read
from the committed verifier-ballots-v5.json (its "board" case) and checked
against the ballots rebuilt here; nothing else needs a prover. Every other
value comes from fixed labels (test data, never keys).

Usage: python3 -I -B verifier-openings-v3-rolling-vectors.py <constants> <out-dir>,
where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json;
then `vp check --fix` (the committed file is formatted).
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


vb5 = _load("verifier_ballots_v5_vectors", "verifier-ballots-v5-vectors.py")
vo3 = _load("verifier_openings_v3_vectors", "verifier-openings-v3-vectors.py")
r5, vc, b3 = vb5.r5, vb5.vc, vb5.b3
so3, vo = vo3.so3, vo3.vo
sev4, se, bv, grp = so3.sev4, so3.se, so3.bv, so3.grp
L = so3.L
DEFAULT, AUTHOR = so3.DEFAULT, so3.AUTHOR

OPENING_TYPE = vo3.OPENING_TYPE
BOARD_VERSION = vb5.vb.BOARD_VERSION
PERIOD = vo3.PERIOD
outcome = vc.outcome


def core_v5(o):
    """Ballot version 5's core hash of an opening's core: version 4's core fields under version input 5 (ballot-validity.md, Hashes (version 5))."""
    return r5.core_hash({"definitionHash": o["definitionHash"], "cell": o["cell"], "vote": o})


def main(constants, out_dir):
    s = vb5.build(constants)
    src = next(b for b in s["bundles"] if b["id"] == "board")
    d, ev, panel, eid = s["definition"], s["election"], s["panel"], s["eid"]
    t = src["board"][0]
    assert d["election_id"] == eid and not d["author_keys"] and vc.own_version(d) == 7
    committed = next(c for c in json.loads((VECTORS / "verifier-ballots-v5.json").read_text())["cases"] if c["id"] == "board")
    records = [vc.decode_entry(x, BOARD_VERSION)["payload"] for x in vo.split(bytes.fromhex(committed["board"]))]
    assert records[0] == t
    # The board case's first five ballots are the ones it admits: dan (cell
    # 0), ada, tess (cell 1), ada's re-vote and eve, each a version-5 record.
    admitted = {"dan": 1, "ada": 2, "tess": 3}
    assert committed["ballots"]["admitted"] == 5
    assert all(r["entry"] > 5 for r in committed["ballots"]["rejected"])
    ballots = {}
    for who, at in admitted.items():
        b = src["board"][at]["ballot"]
        rec = records[at]
        assert rec[2] == 5 and rec == r5.enc_ballot(dict(b, proof=rec[3 + 32 + 1 + 32 + 8 + 32 : 3 + 32 + 1 + 32 + 8 + 32 + 256]))
        core = vo3.ballot_core(rec)
        assert core["definitionHash"] == ev["definitionHash"] and not core["authorVss"]
        assert [[grp.encode(x) for x in row] for row in core["vss"]] == [[grp.encode(x) for x in row] for row in b["vote"]["vss"]]
        ballots[who] = (rec, b)
    assert (ballots["dan"][1]["cell"], ballots["tess"][1]["cell"]) == (0, 1)

    # The registered seats' KEM keys, from the transcript.
    checked = vc.cv.check(panel, t, vc.election_of(d))
    assert checked["ok"] and [k["index"] for k in checked["registered"]] == vb5.SEATS
    registered = {}
    for k in checked["registered"]:
        raw = bytes.fromhex(k["kemKey"])
        registered[k["index"]] = {"ek": raw[:1184], "dh": grp.decode(raw[1184:])}
    keys = {DEFAULT: [registered.get(i) for i in range(1, ev["panelSize"] + 1)], AUTHOR: []}
    e = {
        "definitionHash": ev["definitionHash"],
        "questions": ev["questions"],
        "offsets": ev["offsets"],
        "optionTotal": ev["optionTotal"],
        "threshold": ev["threshold"],
        "panelSize": ev["panelSize"],
        "authorThreshold": 0,
        "authorPanelSize": 0,
        "cells": len(ev["cells"]),
        "registered": {DEFAULT: vb5.SEATS, AUTHOR: []},
    }
    # Pick one of three, pick up to two of four, pick exactly one of two;
    # one cell per rolling tier (tiers 0 and 2); a 3-of-4 panel with seats 1
    # to 3 registered.
    assert [q["optionCount"] for q in e["questions"]] == [3, 4, 2] and e["cells"] == 2
    assert (e["threshold"], e["panelSize"]) == (3, 4)

    def opening(label, cell, votes, bind=None):
        o, _ = so3.make_opening("verifier-openings-v3-rolling/" + label, e, keys, cell, votes, bind)
        return o

    def opening_of(label, polys, cell):
        """An honest opening of these default-half polynomials, with no author half: fresh encapsulation randomness, real ciphertexts."""
        rng = bv.Rng("verifier-openings-v3-rolling/encapsulation/" + label)
        vss = [[bv.pedersen(p["f"][i], p["g"][i]) for i in range(len(p["f"]))] for p in polys]
        both = {"vss": vss, "authorVss": []}
        hashes, seats = [], []
        for seat in range(1, e["panelSize"] + 1):
            if seat not in e["registered"][DEFAULT]:
                hashes.append(bytes(32))
                continue
            m, ee, w = rng.bytes32(), se.nonzero_scalar(rng), se.nonzero_scalar(rng)
            shares = [{"v": bv.evaluate(p["f"], seat), "r": bv.evaluate(p["g"], seat)} for p in polys]
            ct, _ = sev4.encrypt(e["definitionHash"], DEFAULT, seat, keys[DEFAULT][seat - 1], both, bv.enc_shares(shares), m, ee, w)
            hashes.append(se.share_hash(ct))
            seats.append({"seat": seat, "m": m, "e": ee, "w": w})
        return {
            "definitionHash": e["definitionHash"],
            "cell": cell,
            "vss": vss,
            "shareHashes": hashes,
            "authorVss": [],
            "authorShareHashes": [],
            "polynomials": polys,
            "authorPolynomials": [],
            "seats": seats,
            "authorSeats": [],
        }

    def recast(label, who, votes, option, cell):
        """A core that keeps one cast ballot's (v_j, r_j) at flat `option`, every other coefficient fresh: other share hashes, the same C_j. The ballot's constant terms are drawn as ballot-v4-vectors.py's make_ballot drew them from verifier-ballots-v5-vectors.py's label, with no author half: per option r_j, then f's and g's other coefficients."""
        k = e["threshold"]
        rng = bv.Rng("ballot-v4/verifier-ballots-v5/" + ev["label"] + "/" + who)
        cast = []
        for v in votes:
            r = rng.scalar()
            f = [v % L] + [rng.scalar() for _ in range(k - 1)]
            g = [r] + [rng.scalar() for _ in range(k - 1)]
            cast.append((f[0], g[0]))
        assert grp.equal(bv.pedersen(*cast[option]), ballots[who][1]["vote"]["vss"][option][0])
        fresh = bv.Rng("verifier-openings-v3-rolling/recast/" + label)
        polys = []
        for j in range(len(votes)):
            v, r = cast[option] if j == option else (0, fresh.scalar())
            polys.append({"f": [v] + [fresh.scalar() for _ in range(k - 1)], "g": [r] + [fresh.scalar() for _ in range(k - 1)]})
        return opening_of("recast/" + label, polys, cell)

    rec_dan, rec_tess = ballots["dan"][0], ballots["tess"][0]
    honest = opening("honest", 0, b3.flat([(3, [1]), (4, [0, 3]), (2, [1])]))
    honest_t2 = opening("honest-tier-2", 1, b3.flat([(3, []), (4, [2]), (2, [0])]))
    early = opening("early", 1, b3.flat([(3, [0]), (4, []), (2, [1])]))
    # dan's question 1 option 3 (flat 6), and tess's question 2 option 1
    # (flat 8), re-used under other shares.
    cast_dan = recast("dan", "dan", b3.flat([(3, [1]), (4, [0, 3]), (2, [1])]), 6, 0)
    cast_tess = recast("tess", "tess", b3.flat([(3, []), (4, []), (2, [1])]), 8, 1)
    # Three of question 1's four options where it allows two; question 0 is
    # within its rules, so the first question outside is 1.
    outside = opening("outside", 1, b3.flat([(3, [2]), (4, [0, 1, 2]), (2, [0])]))
    stray = dict(honest_t2, definitionHash=vb5.det("verifier-openings-v3-rolling other definition"))
    # Cell 2, the first past a partition of one cell per rolling tier.
    cell = dict(honest_t2, cell=2)
    shape = dict(honest_t2, seats=honest_t2["seats"][:2])
    # An author half on a poll without an author panel: the shape is the
    # definition's, never the opening's (T-17, T-37).
    author_half = dict(honest_t2, authorVss=[row[:2] for row in honest_t2["vss"]])
    unqualified = dict(honest_t2, shareHashes=honest_t2["shareHashes"][:3] + [vb5.det("verifier-openings-v3-rolling unqualified")])
    vss_bad = opening("vss", 0, b3.flat([(3, [0]), (4, [1]), (2, [0])]))
    vss_bad["polynomials"] = [dict(p) for p in vss_bad["polynomials"]]
    p5 = vss_bad["polynomials"][5]
    vss_bad["polynomials"][5] = {"f": [p5["f"][0], (p5["f"][1] + 1) % L, p5["f"][2]], "g": p5["g"]}
    # Seat 2's ciphertext bound to the author panel: it decrypts, but isn't
    # the default seat's (share-encryption.md, Associated data; T-37).
    ciphertext = opening("ciphertext", 0, b3.flat([(3, [1]), (4, []), (2, [0])]), bind=lambda p, seat: AUTHOR if seat == 2 else p)
    enc = so3.enc_opening
    trailing = enc(honest_t2) + b"\x00"
    version_2 = enc(honest_t2, version=2)
    # The tracking code is version 5's core hash, never version 4's, so one
    # code never names cores of two ballot versions (challenge.md, Opening
    # version 3, Core and tracking code; T-42, T-47).
    assert core_v5(honest) != so3.core_hash(honest)

    clock = {"epoch": d["closes_at"] - 2 * PERIOD, "period": PERIOD, "deadline": 7200, "lastSegment": 8}
    assert vo.floor_of(d["closes_at"], clock) == 3

    def board(segments):
        """`segments`: (segment, [payload]) in order; openings go last in their segment, sorted (board.md, Spoiled-ballot openings)."""
        out = []
        for seg, payloads in segments:
            payloads = [t if p == "t" else p for p in payloads]
            others = [p for p in payloads if int.from_bytes(p[:2], "big") != OPENING_TYPE]
            opens = sorted(p for p in payloads if int.from_bytes(p[:2], "big") == OPENING_TYPE)
            assert len(set(opens)) == len(opens)
            for p in others + opens:
                out.append(vc.entry(BOARD_VERSION, eid, len(out), seg, p))
        return out

    cases = []

    def case(id_, description, segments, want_status):
        entries = board(segments)
        ceremony_rows, _ = vc.expected(panel, d, entries, panel, BOARD_VERSION)
        assert ceremony_rows["3.2"] == outcome("pass"), id_
        row, report = vo3.expected(d, e, keys, entries, clock, core_v5)
        assert row["status"] == want_status, (id_, row)
        c = {
            "id": id_,
            "description": description,
            "panel": "panel-4",
            "definition": vc.encode(d).hex(),
            "clock": {k: str(v) for k, v in clock.items()},
            "board": b"".join(entries).hex(),
            "expected": {"6.2": row},
            "openings": report,
        }
        cases.append(c)
        return c

    mixed = case(
        "mixed",
        "A sealed rolling poll without an author panel; close falls in period 2, so s_S is at least 3. Tier 0's ballot (cell 0) in segment 0 (counted whatever s_S is) and tier 2's (cell 1) in segment 4 (counted only if s_S ≥ 4); an honest opening in segment 3 (early); in segment 5 an opening of every check failure (opening-cell for cell 2, the first past a partition of one cell per rolling tier; opening-shape twice, for a missing seat and for an author half the poll has no panel for; opening-ciphertext for seat 2's ciphertext bound to the author panel), one that doesn't decode, one labelled version 2, an honest one, one of three picks in question 1 (outside at question 1), and two that re-use one ballot's (v_j, r_j) under other share hashes: the segment-0 ballot's (cast) and the segment-4 ballot's (undecided); in segment 6 a byte-identical copy of the honest one and of the stray one, and in segment 7 a third copy of the honest one (repeats, each of the first). Each passing opening's tracking code is version 5's core hash. The honest openings above the floor may still be early or late once s_S is known, so 6.2 is unverifiable.",
        [
            (0, ["t", rec_dan]),
            (3, [enc(early)]),
            (4, [rec_tess]),
            (
                5,
                [
                    enc(honest),
                    enc(cast_dan),
                    enc(cast_tess),
                    enc(outside),
                    enc(stray),
                    enc(cell),
                    enc(shape),
                    enc(author_half),
                    enc(unqualified),
                    enc(vss_bad),
                    enc(ciphertext),
                    trailing,
                    version_2,
                ],
            ),
            (6, [enc(honest), enc(stray)]),
            (7, [enc(honest)]),
        ],
        "unverifiable",
    )
    codes = {o.get("code") for o in mixed["openings"]}
    assert codes == {None, "decode", "opening-stray", "opening-cell", "opening-shape", "opening-unqualified", "opening-vss", "opening-ciphertext"}, codes
    assert [o.get("code") for o in mixed["openings"]].count("opening-shape") == 2
    assert {o["decodeError"] for o in mixed["openings"] if o.get("code") == "decode"} == {"trailing-bytes", "profile-mismatch"}
    breaks = {b["code"] for o in mixed["openings"] for b in o["breaks"]}
    assert breaks == {"opening-early", "opening-cast", "opening-repeat"}, breaks
    assert [(o.get("option"), o.get("panel")) for o in mixed["openings"] if o.get("code") == "opening-vss"] == [(5, DEFAULT)]
    assert [(o.get("seat"), o.get("panel")) for o in mixed["openings"] if o.get("code") == "opening-ciphertext"] == [(2, DEFAULT)]
    assert len([o for o in mixed["openings"] if any(b["code"] == "opening-cast" for b in o["breaks"])]) == 1
    assert core_v5(honest).hex() in {o.get("coreHash") for o in mixed["openings"]}

    case(
        "settled",
        "Every opening breaks a rule the floor decides: an honest one in segment 3 (early), one re-using the segment-0 ballot's commitment (cast), one failing opening-vss, and a copy of the cast one (repeat). 6.2 fails at the first, opening-early.",
        [(0, ["t", rec_dan]), (3, [enc(early)]), (5, [enc(cast_dan), enc(vss_bad)]), (6, [enc(cast_dan)])],
        "fail",
    )
    case(
        "decode-first",
        "The first settled opening is labelled version 2, which a profile pinning version 3 doesn't read: 6.2 fails with decode and profile-mismatch.",
        [(0, ["t", rec_dan]), (5, [version_2, enc(stray)])],
        "fail",
    )
    case(
        "honest",
        "Only honest openings above the floor, one per cell, opening no ballot on the copy: undecided until s_S is known, so 6.2 is unverifiable.",
        [(0, ["t", rec_dan]), (4, [rec_tess]), (5, [enc(honest), enc(honest_t2)])],
        "unverifiable",
    )
    case(
        "cast-above-floor",
        "An opening that re-uses the commitment of tier 2's ballot in segment 4, above the floor: whether that ballot is counted needs s_S, so no break is reported and 6.2 is unverifiable.",
        [(0, ["t", rec_dan]), (4, [rec_tess]), (5, [enc(cast_tess)])],
        "unverifiable",
    )
    case(
        "cast-at-floor",
        "The same opening with tier 2's ballot in segment 3, the floor itself: counted whatever s_S is, so the opening is cast and 6.2 fails.",
        [(0, ["t", rec_dan]), (3, [rec_tess]), (5, [enc(cast_tess)])],
        "fail",
    )
    case("none", "Ballots and no opening: 6.2 passes.", [(0, ["t", rec_dan]), (4, [rec_tess])], "pass")

    doc = {
        "format": "abolish-verifier-openings-vectors/1",
        "title": "The verifier's spoiled-ballot openings under a rolling definition (definition version 7, electorate_mode 2; opening version 3 over ballot version 5's cores, without an author panel): definitions, clocks, boards and pinned panels, with the row 6.2 and the report's openings, beside verifier-ballots-v5.json's group registry events and registration time",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-openings-v3-rolling-vectors.py, from verifier-ballots-v5-vectors.py, ballot-v5-records-vectors.py, "
            "verifier-ceremony-vectors.py, spoiled-opening-v3-vectors.py and verifier-openings-v3-vectors.py (independent Python implementations); "
            "the ballot records are verifier-ballots-v5.json's"
        ),
        "panels": {"panel-4": {"threshold": str(panel["k"]), "keys": [k.hex() for k in panel["keys"]]}},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-openings-v3-rolling.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: verifier-openings-v3-rolling-vectors.py <constants> <out-dir>")
    main(sys.argv[1], sys.argv[2])
