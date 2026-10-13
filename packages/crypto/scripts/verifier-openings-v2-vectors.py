#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-openings-v2.json.

Elections for the verifier's spoiled-ballot openings under definition
versions 3 to 5, whose openings are version 2 and open the cores of ballot
versions 2 and 3 (docs/spec/verifier.md, Spoiled-ballot openings; 6.2;
challenge.md, Opening version 2): each is an election definition, a clock, a
board copy and the panel a bundle pins, with the rows 2.3 and 6.2 a verifier
reports and the report's `openings`. The openings are checked against the
definition's cells and questions and the registered key set the transcript
gives, and against challenge.md's Publication rules as far as the floor of
`s_S`, `period(closes_at) + 1` (tally.md, Tally window), decides them.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ballots-v3-vectors.py
and verifier-ballots-v2-vectors.py (the elections, their transcripts and
ballots, rebuilt from their labels), verifier-ceremony-vectors.py (board
entries, 2.3's combination and the ceremony check, which gives the registered
seats' KEM keys), ballot-v3-vectors.py (opening version 2: its record, its
checks in order, the core hash under either ballot version and the client's
openings, over share-encryption-vectors.py's self-checked ML-KEM-768 and
ChaCha20-Poly1305) and verifier-openings-vectors.py (what a passing opening
opens, the floor and the record reader).

The ballots' membership proofs are randomised, so their records are read
from the committed verifier-ballots-v3.json and verifier-ballots-v2.json
(their "admitted" cases) and checked against the ballots rebuilt here;
nothing else needs a prover. Every other value comes from fixed labels (test
data, never keys).

Usage: python3 -I -B verifier-openings-v2-vectors.py <constants> <out-dir>,
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


vb3 = _load("verifier_ballots_v3_vectors", "verifier-ballots-v3-vectors.py")
vb2 = _load("verifier_ballots_v2_vectors", "verifier-ballots-v2-vectors.py")
vo = _load("verifier_openings_vectors", "verifier-openings-vectors.py")
vc = vb3.vc
b3 = vb3.r3.b3
bv, se, grp = b3.bv, b3.se, b3.grp
L = b3.L

OPENING_TYPE = 0x0003
BALLOT_TYPE = 0x0002
PERIOD = 3600
outcome, NOT_REACHED = vc.outcome, vc.NOT_REACHED


def ballot_core(payload):
    """A version-2 or version-3 ballot record's definition hash and its C_j, read at the record's fixed offsets (ballot-validity.md, Ballot record (version 2) and (version 3)): the header, the definition hash, the cell, ν, the L1 reference and the 256-byte proof come first."""
    assert payload[:2] == BALLOT_TYPE.to_bytes(2, "big") and payload[2] in (2, 3)
    definition_hash = payload[3:35]
    pos = 3 + 32 + 1 + 32 + 8 + 32 + 256
    m = int.from_bytes(payload[pos : pos + 4], "big")
    pos += 4
    commitments = []
    for _ in range(m):
        k = int.from_bytes(payload[pos : pos + 4], "big")
        commitments.append(payload[pos + 4 : pos + 36])
        pos += 4 + 32 * k
    return definition_hash, commitments


def decode_opening(b):
    """Strict decoding of an opening record pinned at version 2 (challenge.md, Opening version 2), as far as these vectors need it: the header, then every field, with no trailing bytes."""
    if int.from_bytes(b[:2], "big") != OPENING_TYPE:
        return "unknown-record-type"
    if b[2] != 2:
        return "profile-mismatch"
    r = vo.Reader(b, 3)
    try:
        o = {"definitionHash": r.take(32), "cell": r.u8()}
        o["vss"] = r.list(lambda: r.list(r.element))
        o["shareHashes"] = r.list(lambda: r.take(32))
        o["polynomials"] = r.list(lambda: {"f": r.list(r.scalar), "g": r.list(r.scalar)})
        o["seats"] = r.list(lambda: {"seat": r.u8(), "m": r.take(32), "e": r.scalar(), "w": r.scalar()})
    except IndexError:
        return "truncated"
    if r.at != len(b):
        return "trailing-bytes"
    return o


def expected(d, e, entries, clock):
    """6.2 and the report's openings, computed here from challenge.md and verifier.md."""
    floor = vo.floor_of(d["closes_at"], clock)
    envelopes = []
    for at, raw in enumerate(entries):
        env = vc.decode_entry(raw, 4)
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
        # The tracking code under the ballot version the profile pins: the
        # opening carries none of its own.
        code = b3.core_hash(o["definitionHash"], o["cell"], o["vss"], o["shareHashes"], e["ballotVersion"])
        repeat = [{"code": "opening-repeat", "of": seen[code]}] if code in seen else []
        seen.setdefault(code, at)
        r = b3.check_opening(e, o)
        if r[0] != "ok":
            row = {"entry": at, "code": r[0]}
            if r[1] is not None:
                row["option"] = r[1]
            if r[2] is not None:
                row["seat"] = r[2]
            report.append(dict(row, breaks=early + repeat))
            continue
        _, core, votes, outside = r
        assert core == code
        opened = vo.opened_set(o)
        cast = next((b for b, (dh, cs) in counted if dh == o["definitionHash"] and any(c in opened for c in cs)), None)
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


def election_from(vb, constants, committed_file, version):
    """The "admitted" bundle of `vb`'s elections, its committed records checked against the ballots rebuilt here, and the opening context ballot-v3-vectors.py's checks take."""
    s = vb.build(constants)
    src = next(b for b in s["bundles"] if b["id"] == "admitted")
    d, t, e = src["definition"], src["transcript"], src["election"]
    panel = s["panels"]["panel-4"]
    assert d["election_id"] == s["eid"]
    committed = next(c for c in json.loads((VECTORS / committed_file).read_text())["cases"] if c["id"] == "admitted")
    records = [vc.decode_entry(x, 4)["payload"] for x in vo.split(bytes.fromhex(committed["board"]))]
    assert records[0] == t
    ballots = [p[0] for p in src["board"][1:]]
    assert len(records) == len(ballots) + 1
    for rec, b in zip(records[1:], ballots):
        assert rec[2] == version
        assert ballot_core(rec) == (b["definitionHash"], [grp.encode(row[0]) for row in b["vote"]["vss"]])

    # The registered seats' KEM keys, from the transcript.
    checked = vc.cv.check(panel, t, vc.election_of(d))
    assert checked["ok"] and [k["index"] for k in checked["registered"]] == src["registered"]
    keys = {}
    for k in checked["registered"]:
        raw = bytes.fromhex(k["kemKey"])
        keys[k["index"]] = {"ek": raw[:1184], "dh": grp.decode(raw[1184:])}
    if version == 3:
        questions = e["questions"]
        offsets, total = e["offsets"], e["optionTotal"]
    else:
        questions = [{"optionCount": e["optionCount"], "min": e["min"], "max": e["max"]}]
        offsets, total = [0], e["optionCount"]
    election = {
        "definitionHash": e["definitionHash"],
        "ballotVersion": version,
        "questions": questions,
        "offsets": offsets,
        "optionTotal": total,
        "threshold": e["threshold"],
        "panelSize": e["panelSize"],
        "cells": len(e["cells"]),
        "registered": src["registered"],
        "keys": keys,
    }
    return {"d": d, "t": t, "e": e, "election": election, "panel": panel, "eid": s["eid"], "records": records[1:], "ballots": ballots}


def main(constants, out_dir):
    v5 = election_from(vb3, constants, "verifier-ballots-v3.json", 3)
    v3 = election_from(vb2, constants, "verifier-ballots-v2.json", 2)
    assert v5["eid"] == v3["eid"]
    eid = v5["eid"]
    panel = v5["panel"]
    assert v3["panel"] == panel

    def opening(src, label, cell, votes, cheat=None):
        o, _ = b3.make_opening("verifier-openings-v2/" + label, src["election"], cell, votes, cheat)
        return o

    def polynomials(label, votes, k):
        """A ballot's polynomials, drawn as its maker drew them from its label: per option, f's coefficients after v_j, then g's."""
        rng = bv.Rng(label)
        out = []
        for v in votes:
            f = [v % L] + [rng.scalar() for _ in range(k - 1)]
            out.append({"f": f, "g": [rng.scalar() for _ in range(k)]})
        return out

    def recast(src, label, ballot, rng_label, votes, option, cell):
        """A core that keeps one cast ballot's (v_j, r_j) at flat `option`, every other coefficient fresh: other share hashes, the same C_j."""
        e = src["election"]
        k = e["threshold"]
        cast = polynomials(rng_label, votes, k)
        assert grp.equal(bv.pedersen(cast[option]["f"][0], cast[option]["g"][0]), ballot["vote"]["vss"][option][0])
        rng = bv.Rng("verifier-openings-v2/recast/" + label)
        polys = []
        for j, p in enumerate(cast):
            f = [p["f"][0] if j == option else 0] + [rng.scalar() for _ in range(k - 1)]
            g = [p["g"][0] if j == option else rng.scalar()] + [rng.scalar() for _ in range(k - 1)]
            polys.append({"f": f, "g": g})
        return opening_of(src, label, polys, cell)

    def opening_of(src, label, polys, cell):
        """An honest opening of these polynomials: fresh encapsulation randomness, real ciphertexts."""
        e = src["election"]
        rng = bv.Rng("verifier-openings-v2/encapsulation/" + label)
        vss = [[bv.pedersen(p["f"][t], p["g"][t]) for t in range(len(p["f"]))] for p in polys]
        hashes, seats = [], []
        for seat in range(1, e["panelSize"] + 1):
            if seat not in e["registered"]:
                hashes.append(bytes(32))
                continue
            m, ee, w = rng.bytes32(), se.nonzero_scalar(rng), se.nonzero_scalar(rng)
            shares = [{"v": bv.evaluate(p["f"], seat), "r": bv.evaluate(p["g"], seat)} for p in polys]
            ct, _ = se.encrypt(e["definitionHash"], seat, e["keys"][seat], vss, bv.enc_shares(shares), m, ee, w)
            hashes.append(se.share_hash(ct))
            seats.append({"seat": seat, "m": m, "e": ee, "w": w})
        return {"definitionHash": e["definitionHash"], "cell": cell, "vss": vss, "shareHashes": hashes, "polynomials": polys, "seats": seats}

    # Definition version 5: pick one of three, pick up to two of four, pick
    # exactly one of two; cells 0 to 2; seats 1 to 3 registered.
    e5 = v5["election"]
    assert [q["optionCount"] for q in e5["questions"]] == [3, 4, 2] and e5["cells"] == 3 and e5["registered"] == [1, 2, 3]
    rec_a, _, rec_t2, _ = v5["records"]
    b_a, _, b_t2, _ = v5["ballots"]
    label5 = "ballot-v3/verifier-ballot-v3/" + v5["e"]["label"] + "/"
    honest = opening(v5, "honest", 0, b3.flat([(3, [1]), (4, [0, 3]), (2, [1])]))
    honest2 = opening(v5, "honest-2", 2, b3.flat([(3, []), (4, [2]), (2, [0])]))
    early = opening(v5, "early", 1, b3.flat([(3, [0]), (4, []), (2, [1])]))
    # The cell-0 ballot's question 1 option 3 (flat 6), and the tier-2
    # ballot's question 2 option 1 (flat 8), re-used under other shares.
    cast_a = recast(v5, "cast-cell-0", b_a, label5 + "cell-0", b3.flat([(3, [1]), (4, [0, 3]), (2, [1])]), 6, 0)
    cast_t2 = recast(v5, "cast-tier-2", b_t2, label5 + "tier-2", b3.flat([(3, []), (4, []), (2, [1])]), 8, 2)
    # Three of question 1's four options where it allows two; question 0 is
    # within its rules, so the first question outside is 1.
    outside = opening(v5, "outside", 1, b3.flat([(3, [2]), (4, [0, 1, 2]), (2, [0])]))
    stray = dict(honest2, definitionHash=vb3.det("verifier-openings-v2 other definition"))
    cell = dict(honest2, cell=3)
    shape = dict(honest2, seats=honest2["seats"][:2])
    unqualified = dict(honest2, shareHashes=honest2["shareHashes"][:3] + [vb3.det("verifier-openings-v2 unqualified")])
    vss_bad = opening(v5, "vss", 0, b3.flat([(3, [0]), (4, [1]), (2, [0])]))
    vss_bad["polynomials"] = [dict(p) for p in vss_bad["polynomials"]]
    p5 = vss_bad["polynomials"][5]
    vss_bad["polynomials"][5] = {"f": [p5["f"][0], (p5["f"][1] + 1) % L, p5["f"][2]], "g": p5["g"]}

    def wrong_share(seat, shares):
        return [dict(x, v=(x["v"] + 1) % L) for x in shares] if seat == 2 else shares

    ciphertext = opening(v5, "ciphertext", 2, b3.flat([(3, [1]), (4, []), (2, [0])]), cheat=wrong_share)
    enc = b3.enc_opening
    trailing = enc(honest2) + b"\x00"
    version_1 = enc(honest2, version=1)

    d5, t5 = v5["d"], v5["t"]
    clock = {"epoch": d5["closes_at"] - 2 * PERIOD, "period": PERIOD, "deadline": 7200, "lastSegment": 8}
    assert vo.floor_of(d5["closes_at"], clock) == 3

    def board(segments, src):
        """`segments`: (segment, [payload]) in order; openings go last in their segment, sorted (board.md, Spoiled-ballot openings)."""
        out = []
        for seg, payloads in segments:
            payloads = [src["t"] if p == "t" else p for p in payloads]
            others = [p for p in payloads if int.from_bytes(p[:2], "big") != OPENING_TYPE]
            opens = sorted(p for p in payloads if int.from_bytes(p[:2], "big") == OPENING_TYPE)
            assert len(set(opens)) == len(opens)
            for p in others + opens:
                out.append(vc.entry(4, eid, len(out), seg, p))
        return out

    cases = []

    def case(id_, description, segments, want_status, src=v5, the_clock=None):
        the_clock = the_clock or dict(clock, epoch=src["d"]["closes_at"] - 2 * PERIOD)
        entries = board(segments, src)
        ceremony_rows, _ = vc.expected(panel, src["d"], entries, panel, 4)
        assert ceremony_rows["3.2"] == outcome("pass"), id_
        assert vc.combination(src["d"]) == vc.NOT_IMPLEMENTED, id_
        row, report = expected(src["d"], src["election"], entries, the_clock)
        assert row["status"] == want_status, (id_, row)
        c = {
            "id": id_,
            "description": description,
            "panel": "panel-4",
            "definition": vc.encode(src["d"]).hex(),
            "clock": {k: str(v) for k, v in the_clock.items()},
            "board": b"".join(entries).hex(),
            "expected": {"2.3": vc.combination(src["d"]), "6.2": row},
            "openings": report,
        }
        cases.append(c)
        return c

    mixed = case(
        "mixed",
        "Definition version 5; close falls in period 2, so s_S is at least 3. The cell-0 ballot in segment 0 (counted whatever s_S is) and the tier-2 ballot in segment 4 (counted only if s_S ≥ 4); an honest opening in segment 3 (early); in segment 5 an opening of every check failure (opening-cell for cell 3, the first past the partition), one that doesn't decode, one labelled version 1, an honest one, one of three picks in question 1 (outside at question 1), and two that re-use one ballot's (v_j, r_j) under other share hashes: the segment-0 ballot's (cast) and the segment-4 ballot's (undecided); in segment 6 a byte-identical copy of the honest one and of the stray one, and in segment 7 a third copy of the honest one (repeats, each of the first). The honest openings above the floor may still be early or late once s_S is known, so 6.2 is unverifiable.",
        [
            (0, ["t", rec_a]),
            (3, [enc(early)]),
            (4, [rec_t2]),
            (5, [enc(honest), enc(cast_a), enc(cast_t2), enc(outside), enc(stray), enc(cell), enc(shape), enc(unqualified), enc(vss_bad), enc(ciphertext), trailing, version_1]),
            (6, [enc(honest), enc(stray)]),
            (7, [enc(honest)]),
        ],
        "unverifiable",
    )
    codes = {o.get("code") for o in mixed["openings"]}
    assert codes == {None, "decode", "opening-stray", "opening-cell", "opening-shape", "opening-unqualified", "opening-vss", "opening-ciphertext"}, codes
    assert {o["decodeError"] for o in mixed["openings"] if o.get("code") == "decode"} == {"trailing-bytes", "profile-mismatch"}
    breaks = {b["code"] for o in mixed["openings"] for b in o["breaks"]}
    assert breaks == {"opening-early", "opening-cast", "opening-repeat"}, breaks
    # The three picks fall outside at question 1; the cast-cell-0 core, a
    # single vote at question 1, leaves question 2 (pick exactly one) blank.
    assert [o["question"] for o in mixed["openings"] if o.get("voteOutside")] == [2, 1]
    assert [o.get("option") for o in mixed["openings"] if o.get("code") == "opening-vss"] == [5]
    assert [o.get("seat") for o in mixed["openings"] if o.get("code") == "opening-ciphertext"] == [2]

    case(
        "settled",
        "Every opening breaks a rule the floor decides: an honest one in segment 3 (early), one re-using the segment-0 ballot's commitment (cast), one failing opening-vss, and a copy of the cast one (repeat). 6.2 fails at the first, opening-early.",
        [(0, ["t", rec_a]), (3, [enc(early)]), (5, [enc(cast_a), enc(vss_bad)]), (6, [enc(cast_a)])],
        "fail",
    )
    case(
        "decode-first",
        "The first settled opening is labelled version 1, which a profile pinning version 2 doesn't read: 6.2 fails with decode and profile-mismatch.",
        [(0, ["t", rec_a]), (5, [version_1, enc(stray)])],
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

    # Definition version 3: one pick-one question of three, ballot version 2,
    # whose cores opening version 2 opens under ballot version 2's core hash.
    e3 = v3["election"]
    assert e3["optionTotal"] == 3 and e3["cells"] == 3 and e3["registered"] == [1, 2, 3]
    rec3_a = v3["records"][0]
    b3_a = v3["ballots"][0]
    regional = opening(v3, "regional", 1, [0, 0, 1])
    regional_cast = recast(v3, "regional-cast", b3_a, "verifier-ballot-v2/" + v3["e"]["label"] + "/cell-0", [0, 1, 0], 1, 0)
    regional_outside = opening(v3, "regional-outside", 0, [1, 1, 0])
    regional_cell = dict(regional, cell=255)
    regional_case = case(
        "regional",
        "Definition version 3 (one pick-one question of three; ballot version 2's cores): the cell-0 ballot in segment 0; in segment 5 an honest opening in cell 1, one re-using the ballot's (v_j, r_j) (cast), one of two picks (outside at question 0) and one naming cell 255 (opening-cell). The honest one is undecided, so 6.2 is unverifiable.",
        [(0, ["t", rec3_a]), (5, [enc(regional), enc(regional_cast), enc(regional_outside), enc(regional_cell)])],
        "unverifiable",
        src=v3,
    )
    by_entry = {o["entry"]: o for o in regional_case["openings"]}
    assert any(b["code"] == "opening-cast" for o in by_entry.values() for b in o["breaks"])
    assert [o["question"] for o in by_entry.values() if o.get("voteOutside")] == [0]
    assert [o.get("code") for o in by_entry.values()].count("opening-cell") == 1
    # The same core bytes under ballot version 3 would have another code.
    assert b3.core_hash(regional["definitionHash"], 1, regional["vss"], regional["shareHashes"], 2).hex() in {o.get("coreHash") for o in by_entry.values()}

    doc = {
        "format": "abolish-verifier-openings-vectors/1",
        "title": "The verifier's spoiled-ballot openings under definition versions 3 to 5 (opening version 2): definitions, clocks, boards and pinned panels, with the rows 2.3 and 6.2 and the report's openings",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-openings-v2-vectors.py, from verifier-ballots-v3-vectors.py, verifier-ballots-v2-vectors.py, "
            "verifier-ceremony-vectors.py, ballot-v3-vectors.py and verifier-openings-vectors.py (independent Python implementations); "
            "the ballot records are verifier-ballots-v3.json's and verifier-ballots-v2.json's"
        ),
        "panels": {"panel-4": {"threshold": str(panel["k"]), "keys": [k.hex() for k in panel["keys"]]}},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-openings-v2.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: verifier-openings-v2-vectors.py <constants> <out-dir>")
    main(sys.argv[1], sys.argv[2])
