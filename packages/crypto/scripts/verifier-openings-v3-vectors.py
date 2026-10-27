#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-openings-v3.json.

Elections for the verifier's spoiled-ballot openings under definition
version 6, or, for docs/spec/vectors/verifier-openings-v3-definition-v7.json,
the same election under definition version 7 with a fixed electorate, which
the verifier reads as version 6 under version 7's own hash (docs/spec/verifier.md,
2.3), whose openings are version 3 and open both halves of ballot
version 4's cores (docs/spec/verifier.md, Spoiled-ballot openings; 6.2;
challenge.md, Opening version 3): each is an election definition, a clock, a
board copy and the panel a bundle pins, with the rows 2.3 and 6.2 a verifier
reports and the report's `openings`. The openings are checked against the
definition's cells and questions and the registered key set the transcript
gives, over both halves, and against challenge.md's Publication rules as far
as the floor of `s_S`, `period(closes_at) + 1` (tally.md, Tally window),
decides them. Only polls without an author panel are judged: admission
judges no ballot beside one until its ceremony is read (P2-16 part 4d).

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ballots-v4-vectors.py
(the election, its transcript and ballots, rebuilt from their labels, and
2.3's combination), verifier-ceremony-vectors.py (board entries and the
ceremony check, which gives the registered seats' KEM keys),
spoiled-opening-v3-vectors.py (opening version 3: its record, its checks in
order over both halves, the core hash, what a passing opening opens and the
client's openings, over share-encryption-v4-vectors.py's ciphertexts) and
verifier-openings-vectors.py (the floor and the record reader).

The ballots' membership proofs are randomised, so their records are read
from the committed verifier-ballots-v4.json (its "admitted" case), or
verifier-ballots-v4-definition-v7.json for version 7, and checked against
the ballots rebuilt here; nothing else needs a prover. Every other value
comes from fixed labels (test data, never keys).

Usage: python3 -I -B verifier-openings-v3-vectors.py <constants> <out-dir> [7],
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


vb4 = _load("verifier_ballots_v4_vectors", "verifier-ballots-v4-vectors.py")
so3 = _load("spoiled_opening_v3_vectors", "spoiled-opening-v3-vectors.py")
vo = _load("verifier_openings_vectors", "verifier-openings-vectors.py")
vc, b3 = vb4.vc, vb4.b3
sev4, se, bv, grp = so3.sev4, so3.se, so3.bv, so3.grp
L = so3.L
DEFAULT, AUTHOR = so3.DEFAULT, so3.AUTHOR

OPENING_TYPE = 0x0003
BALLOT_TYPE = 0x0002
BOARD_VERSION = vb4.vb.BOARD_VERSION
PERIOD = 3600
outcome = vc.outcome


def ballot_core(payload):
    """A version-4 ballot record's definition hash and both halves' VSS commitments, read at the record's fixed offsets (ballot-validity.md, Ballot record (version 4)): the header, the definition hash, the cell, ν, the L1 reference and the 256-byte proof come first, then the default half's `vss` and share hashes and the author half's `vss`."""
    assert payload[:2] == BALLOT_TYPE.to_bytes(2, "big") and payload[2] == 4
    r = vo.Reader(payload, 3 + 32 + 1 + 32 + 8 + 32 + 256)
    vss = r.list(lambda: r.list(r.element))
    r.list(lambda: r.take(32))
    author_vss = r.list(lambda: r.list(r.element))
    return {"definitionHash": payload[3:35], "vss": vss, "authorVss": author_vss}


def decode_opening(b):
    """Strict decoding of an opening record pinned at version 3 (challenge.md, Opening version 3), as far as these vectors need it: the header, then every field, with no trailing bytes."""
    if int.from_bytes(b[:2], "big") != OPENING_TYPE:
        return "unknown-record-type"
    if b[2] != 3:
        return "profile-mismatch"
    r = vo.Reader(b, 3)
    polynomials = lambda: r.list(lambda: {"f": r.list(r.scalar), "g": r.list(r.scalar)})  # noqa: E731
    seats = lambda: r.list(lambda: {"seat": r.u8(), "m": r.take(32), "e": r.scalar(), "w": r.scalar()})  # noqa: E731
    try:
        o = {"definitionHash": r.take(32), "cell": r.u8()}
        o["vss"] = r.list(lambda: r.list(r.element))
        o["shareHashes"] = r.list(lambda: r.take(32))
        o["authorVss"] = r.list(lambda: r.list(r.element))
        o["authorShareHashes"] = r.list(lambda: r.take(32))
        o["polynomials"] = polynomials()
        o["authorPolynomials"] = polynomials()
        o["seats"] = seats()
        o["authorSeats"] = seats()
    except IndexError:
        return "truncated"
    if r.at != len(b):
        return "trailing-bytes"
    return o


def expected(d, e, keys, entries, clock):
    """6.2 and the report's openings, computed here from challenge.md and verifier.md."""
    floor = vo.floor_of(d["closes_at"], clock)
    envelopes = []
    for at, raw in enumerate(entries):
        env = vc.decode_entry(raw, BOARD_VERSION)
        if not isinstance(env, str) and env["electionId"] == d["election_id"]:
            envelopes.append((at, env["payload"], env["segment"], int.from_bytes(env["payload"][:2], "big")))
    # Every admitted ballot at or below the floor, wherever it sits in the
    # copy. These vectors board only ballots their source file admits.
    counted = [(at, ballot_core(p)) for at, p, seg, kind in envelopes if kind == BALLOT_TYPE and seg <= floor]
    report = []
    seen = {}
    for at, payload, segment, kind in envelopes:
        if kind != OPENING_TYPE:
            continue
        early = [{"code": "opening-early"}] if segment <= floor else []
        o = decode_opening(payload)
        if isinstance(o, str):
            report.append({"entry": at, "code": "decode", "decodeError": o, "breaks": early})
            continue
        code = so3.core_hash(o)
        repeat = [{"code": "opening-repeat", "of": seen[code]}] if code in seen else []
        seen.setdefault(code, at)
        r = so3.check_opening(e, o, keys)
        if r[0] != "ok":
            row = {"entry": at, "code": r[0]}
            if r[1] is not None:
                row["option"] = r[1]
            if r[2] is not None:
                row["seat"] = r[2]
            if r[3] is not None:
                row["panel"] = r[3]
            report.append(dict(row, breaks=early + repeat))
            continue
        _, core, votes, _, outside = r
        assert core == code
        # Both halves of each ballot, by challenge.md's Opening version 3, Opened commitments.
        cast = next((b for b, ballot in counted if so3.opens(o, ballot)), None)
        row = {"entry": at, "coreHash": core.hex(), "votes": [str(v) for v in votes]}
        if outside is not None:
            row["voteOutside"] = True
            row["question"] = outside
        row["breaks"] = early + ([{"code": "opening-cast", "ballot": cast}] if cast is not None else []) + repeat
        report.append(row)
    settled = [o for o in report if "code" in o or o["breaks"]]
    if len(settled) < len(report):
        return outcome("unverifiable", "not-implemented"), report
    if not report:
        return outcome("pass"), report
    first = report[0]
    where = {"entry": first["entry"]}
    if "decodeError" in first:
        where["decodeError"] = first["decodeError"]
    return outcome("fail", first["code"] if "code" in first else first["breaks"][0]["code"], where), report


def main(constants, out_dir, version=6):
    s = vb4.build(constants, version)
    src = next(b for b in s["bundles"] if b["id"] == "admitted")
    d, t, ev = src["definition"], src["transcript"], src["election"]
    panel = s["panels"]["panel-4"]
    eid = s["eid"]
    assert d["election_id"] == eid and not d["author_keys"]
    assert vc.own_version(d) == version
    source = "verifier-ballots-v4.json" if version == 6 else "verifier-ballots-v4-definition-v7.json"
    committed = next(c for c in json.loads((VECTORS / source).read_text())["cases"] if c["id"] == "admitted")
    records = [vc.decode_entry(x, BOARD_VERSION)["payload"] for x in vo.split(bytes.fromhex(committed["board"]))]
    assert records[0] == t
    ballots = [p[0] for p in src["board"][1:]]
    assert len(records) == len(ballots) + 1
    for rec, b in zip(records[1:], ballots):
        core = ballot_core(rec)
        assert core["definitionHash"] == b["definitionHash"] and not core["authorVss"]
        assert [[grp.encode(x) for x in row] for row in core["vss"]] == [[grp.encode(x) for x in row] for row in b["vote"]["vss"]]

    # The registered seats' KEM keys, from the transcript.
    checked = vc.cv.check(panel, t, vc.election_of(d))
    assert checked["ok"] and [k["index"] for k in checked["registered"]] == src["registered"] == [1, 2, 3]
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
        "registered": {DEFAULT: src["registered"], AUTHOR: []},
    }
    # Pick one of three, pick up to two of four, pick exactly one of two;
    # cells 0 to 2; a 3-of-4 panel with seats 1 to 3 registered.
    assert [q["optionCount"] for q in e["questions"]] == [3, 4, 2] and e["cells"] == 3
    assert (e["threshold"], e["panelSize"]) == (3, 4)

    def opening(label, cell, votes, bind=None):
        o, _ = so3.make_opening("verifier-openings-v3/" + label, e, keys, cell, votes, bind)
        return o

    def opening_of(label, polys, cell):
        """An honest opening of these default-half polynomials, with no author half: fresh encapsulation randomness, real ciphertexts."""
        rng = bv.Rng("verifier-openings-v3/encapsulation/" + label)
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

    def recast(label, ballot, votes, option, cell):
        """A core that keeps one cast ballot's (v_j, r_j) at flat `option`, every other coefficient fresh: other share hashes, the same C_j. The ballot's constant terms are drawn as ballot-v4-vectors.py's make_ballot drew them from its label, with no author half: per option r_j, then f's and g's other coefficients."""
        k = e["threshold"]
        rng = bv.Rng("ballot-v4/verifier-ballot-v4/" + ev["label"] + "/" + label)
        cast = []
        for v in votes:
            r = rng.scalar()
            f = [v % L] + [rng.scalar() for _ in range(k - 1)]
            g = [r] + [rng.scalar() for _ in range(k - 1)]
            cast.append((f[0], g[0]))
        assert grp.equal(bv.pedersen(*cast[option]), ballot["vote"]["vss"][option][0])
        fresh = bv.Rng("verifier-openings-v3/recast/" + label)
        polys = []
        for j in range(len(votes)):
            v, r = cast[option] if j == option else (0, fresh.scalar())
            polys.append({"f": [v] + [fresh.scalar() for _ in range(k - 1)], "g": [r] + [fresh.scalar() for _ in range(k - 1)]})
        return opening_of("recast/" + label, polys, cell)

    rec_a, _, rec_t2, _ = records[1:]
    b_a, _, b_t2, _ = ballots
    assert (b_a["cell"], b_t2["cell"]) == (0, 2)
    honest = opening("honest", 0, b3.flat([(3, [1]), (4, [0, 3]), (2, [1])]))
    honest2 = opening("honest-2", 2, b3.flat([(3, []), (4, [2]), (2, [0])]))
    early = opening("early", 1, b3.flat([(3, [0]), (4, []), (2, [1])]))
    # The cell-0 ballot's question 1 option 3 (flat 6), and the tier-2
    # ballot's question 2 option 1 (flat 8), re-used under other shares.
    cast_a = recast("cell-0", b_a, b3.flat([(3, [1]), (4, [0, 3]), (2, [1])]), 6, 0)
    cast_t2 = recast("tier-2", b_t2, b3.flat([(3, []), (4, []), (2, [1])]), 8, 2)
    # Three of question 1's four options where it allows two; question 0 is
    # within its rules, so the first question outside is 1.
    outside = opening("outside", 1, b3.flat([(3, [2]), (4, [0, 1, 2]), (2, [0])]))
    stray = dict(honest2, definitionHash=vb4.det("verifier-openings-v3 other definition"))
    cell = dict(honest2, cell=3)
    shape = dict(honest2, seats=honest2["seats"][:2])
    # An author half on a poll without an author panel: the shape is the
    # definition's, never the opening's (T-17, T-37).
    author_half = dict(honest2, authorVss=[row[:2] for row in honest2["vss"]])
    unqualified = dict(honest2, shareHashes=honest2["shareHashes"][:3] + [vb4.det("verifier-openings-v3 unqualified")])
    vss_bad = opening("vss", 0, b3.flat([(3, [0]), (4, [1]), (2, [0])]))
    vss_bad["polynomials"] = [dict(p) for p in vss_bad["polynomials"]]
    p5 = vss_bad["polynomials"][5]
    vss_bad["polynomials"][5] = {"f": [p5["f"][0], (p5["f"][1] + 1) % L, p5["f"][2]], "g": p5["g"]}
    # Seat 2's ciphertext bound to the author panel: it decrypts, but isn't
    # the default seat's (share-encryption.md, Associated data; T-37).
    ciphertext = opening("ciphertext", 2, b3.flat([(3, [1]), (4, []), (2, [0])]), bind=lambda p, seat: AUTHOR if seat == 2 else p)
    enc = so3.enc_opening
    trailing = enc(honest2) + b"\x00"
    version_2 = enc(honest2, version=2)

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
        if version == 7:
            description = description.replace("Definition version 6", "Definition version 7 under a fixed electorate")
        entries = board(segments)
        ceremony_rows, _ = vc.expected(panel, d, entries, panel, BOARD_VERSION)
        assert ceremony_rows["3.2"] == outcome("pass"), id_
        assert vb4.combination(d) == vc.NOT_IMPLEMENTED, id_
        row, report = expected(d, e, keys, entries, clock)
        assert row["status"] == want_status, (id_, row)
        c = {
            "id": id_,
            "description": description,
            "panel": "panel-4",
            "definition": vc.encode(d).hex(),
            "clock": {k: str(v) for k, v in clock.items()},
            "board": b"".join(entries).hex(),
            "expected": {"2.3": vb4.combination(d), "6.2": row},
            "openings": report,
        }
        cases.append(c)
        return c

    mixed = case(
        "mixed",
        "Definition version 6 without an author panel; close falls in period 2, so s_S is at least 3. The cell-0 ballot in segment 0 (counted whatever s_S is) and the tier-2 ballot in segment 4 (counted only if s_S ≥ 4); an honest opening in segment 3 (early); in segment 5 an opening of every check failure (opening-cell for cell 3, the first past the partition; opening-shape twice, for a missing seat and for an author half the poll has no panel for; opening-ciphertext for seat 2's ciphertext bound to the author panel), one that doesn't decode, one labelled version 2, an honest one, one of three picks in question 1 (outside at question 1), and two that re-use one ballot's (v_j, r_j) under other share hashes: the segment-0 ballot's (cast) and the segment-4 ballot's (undecided); in segment 6 a byte-identical copy of the honest one and of the stray one, and in segment 7 a third copy of the honest one (repeats, each of the first). The honest openings above the floor may still be early or late once s_S is known, so 6.2 is unverifiable.",
        [
            (0, ["t", rec_a]),
            (3, [enc(early)]),
            (4, [rec_t2]),
            (
                5,
                [
                    enc(honest),
                    enc(cast_a),
                    enc(cast_t2),
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
    # The cast-cell-0 core, a single vote at question 1, leaves question 2
    # (pick exactly one) blank; the three picks fall outside at question 1.
    assert [o["question"] for o in mixed["openings"] if o.get("voteOutside")] == [2, 1]
    assert [(o.get("option"), o.get("panel")) for o in mixed["openings"] if o.get("code") == "opening-vss"] == [(5, DEFAULT)]
    assert [(o.get("seat"), o.get("panel")) for o in mixed["openings"] if o.get("code") == "opening-ciphertext"] == [(2, DEFAULT)]
    assert len([o for o in mixed["openings"] if any(b["code"] == "opening-cast" for b in o["breaks"])]) == 1

    case(
        "settled",
        "Every opening breaks a rule the floor decides: an honest one in segment 3 (early), one re-using the segment-0 ballot's commitment (cast), one failing opening-vss, and a copy of the cast one (repeat). 6.2 fails at the first, opening-early.",
        [(0, ["t", rec_a]), (3, [enc(early)]), (5, [enc(cast_a), enc(vss_bad)]), (6, [enc(cast_a)])],
        "fail",
    )
    case(
        "decode-first",
        "The first settled opening is labelled version 2, which a profile pinning version 3 doesn't read: 6.2 fails with decode and profile-mismatch.",
        [(0, ["t", rec_a]), (5, [version_2, enc(stray)])],
        "fail",
    )
    case(
        "honest",
        "Only honest openings above the floor, opening no ballot on the copy: undecided until s_S is known, so 6.2 is unverifiable.",
        [(0, ["t", rec_a]), (4, [rec_t2]), (5, [enc(honest), enc(honest2)])],
        "unverifiable",
    )
    case(
        "cast-above-floor",
        "An opening that re-uses the commitment of the tier-2 ballot in segment 4, above the floor: whether that ballot is counted needs s_S, so no break is reported and 6.2 is unverifiable.",
        [(0, ["t", rec_a]), (4, [rec_t2]), (5, [enc(cast_t2)])],
        "unverifiable",
    )
    case(
        "cast-at-floor",
        "The same opening with the tier-2 ballot in segment 3, the floor itself: counted whatever s_S is, so the opening is cast and 6.2 fails.",
        [(0, ["t", rec_a]), (3, [rec_t2]), (5, [enc(cast_t2)])],
        "fail",
    )
    case("none", "Ballots and no opening: 6.2 passes.", [(0, ["t", rec_a]), (4, [rec_t2])], "pass")

    if version == 7:
        # The same election read as version 6: its fields without the mode
        # and the empty list, pinning definition version 6. An honest opening
        # made for that reading binds its hash, another election's, into the
        # core and every ciphertext's associated data (T-12, T-34).
        pinned = dict(d["profile"]["pins"])
        pinned[1] = 6
        v6_hash = vb4.H(vb4.ds(vb4.DEFINITION_TAG, vc.encode(dict(vb4.rv.as_v6(d), profile={"protocol_major": 1, "pins": sorted(pinned.items())}))))
        assert v6_hash != e["definitionHash"]
        e6 = dict(e, definitionHash=v6_hash)
        v6_reading, _ = so3.make_opening("verifier-openings-v3/v6-reading", e6, keys, 2, b3.flat([(3, []), (4, [2]), (2, [0])]), None)
        assert so3.check_opening(e6, v6_reading, keys)[0] == "ok"
        c = case(
            "v6-reading",
            "Definition version 7 under a fixed electorate, with an opening in segment 5 made honestly for the same election read as version 6 (its version-6 hash, in the core and every ciphertext's associated data): it is opening-stray, so 6.2 fails.",
            [(0, ["t", rec_a]), (5, [enc(v6_reading)])],
            "fail",
        )
        assert [o.get("code") for o in c["openings"]] == ["opening-stray"], c["openings"]

    doc = {
        "format": "abolish-verifier-openings-vectors/1",
        "title": f"The verifier's spoiled-ballot openings under definition version {'6' if version == 6 else '7 with a fixed electorate'} (opening version 3, without an author panel): definitions, clocks, boards and pinned panels, with the rows 2.3 and 6.2 and the report's openings",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-openings-v3-vectors.py, from verifier-ballots-v4-vectors.py, verifier-ceremony-vectors.py, "
            "spoiled-opening-v3-vectors.py and verifier-openings-vectors.py (independent Python implementations); "
            f"the ballot records are {source}'s"
        ),
        "panels": {"panel-4": {"threshold": str(panel["k"]), "keys": [k.hex() for k in panel["keys"]]}},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-openings-v3.json" if version == 6 else "verifier-openings-v3-definition-v7.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4) or sys.argv[3:] not in ([], ["7"]):
        raise SystemExit("usage: verifier-openings-v3-vectors.py <constants> <out-dir> [7]")
    main(sys.argv[1], sys.argv[2], 7 if sys.argv[3:] else 6)
