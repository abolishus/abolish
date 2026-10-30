#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-counted-v5-rolling.json.

Elections for the verifier's delivery check and counted set under a rolling
definition (definition version 7, `electorate_mode` 2), whose ballots are
version 5 (docs/spec/verifier.md, Counted set and tally; 5.9, 7.1 to 7.3;
delivery.md, Versions and Delivery check (version 2); tally.md, Rolling
tiers): each is a definition, a clock, a board copy and the panel a bundle
pins, with the rows 5.9, 6.3, 7.1 to 7.3 and 8.5 a verifier reports, the
report's `delivery`, the counted ballots' entries and the report's `cells`.
Ballot version 5 fixes its delivery records at version 2, as version 4 does,
and each names the ballot by version 5's ballot hash, which binds the step,
so a receipt for the same fields at another step, or read as version 4,
delivers nothing (T-38). The partition is one cell per rolling tier, each
opened under tally-opening version 1 against the aggregate of its counted
ballots' default halves. The poll has no author panel, as
verifier-ballots-v5.json's has none.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ballots-v5-vectors.py
(the rolling election, its transcript and ballots, rebuilt from their labels),
ballot-v5-records-vectors.py (version 5's ballot hash),
verifier-ceremony-vectors.py and ceremony-vectors.py (board entries, the
ceremony check, which gives the registered seats' signing keys, and the seats'
secrets from the transcript's label), delivery-vectors.py (the windows),
delivery-v2-vectors.py (the version-2 receipt record and the delivery check,
given version 5's hash), intake-v4-vectors.py (the version-2 receipt
statement and its RFC 6979 P-256 ECDSA signature), tally-opening-vectors.py
(the opening record, its signature and the opening checks) with
tally-vectors.py's aggregate, and verifier-openings-vectors.py (the floor of
`s_S`, `period(closes_at) + 1`).

The ballots' membership proofs are randomised, so their records are read
from the committed verifier-ballots-v5.json (its "board" case) and checked
against the ballots rebuilt here; nothing else needs a prover. Every other
value comes from fixed labels (test data, never keys).

Usage: python3 -I -B verifier-counted-v5-rolling-vectors.py <constants> <out-dir>,
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
dv2 = _load("delivery_v2_vectors", "delivery-v2-vectors.py")
tov = _load("tally_opening_vectors", "tally-opening-vectors.py")
vo = _load("verifier_openings_vectors", "verifier-openings-vectors.py")
r5, vc, b3, b4 = vb5.r5, vb5.vc, vb5.b3, vb5.b4
cv = vc.cv
dv, iv4 = dv2.dv, dv2.iv4
tv, bv, grp = tov.tv, tov.bv, tov.grp
L = grp.L
DEFAULT, AUTHOR = dv2.DEFAULT, dv2.AUTHOR
BOARD_VERSION = vb5.vb.BOARD_VERSION
PERIOD = 3600
outcome, NOT_REACHED = vc.outcome, vc.NOT_REACHED
RECEIPT_TYPE = int.from_bytes(dv2.header(dv2.RECEIPT)[:2], "big")
TALLY_OPENING_TYPE = 0x0006


def main(constants, out_dir):
    s = vb5.build(constants)
    src = next(b for b in s["bundles"] if b["id"] == "board")
    d, ev, panel, eid = s["definition"], s["election"], s["panel"], s["eid"]
    t = src["board"][0]
    assert d["election_id"] == eid and not d["author_keys"] and vc.own_version(d) == 7
    assert dict(d["profile"]["pins"])[TALLY_OPENING_TYPE] == 1
    committed = next(c for c in json.loads((VECTORS / "verifier-ballots-v5.json").read_text())["cases"] if c["id"] == "board")
    records = [vc.decode_entry(x, BOARD_VERSION)["payload"] for x in vo.split(bytes.fromhex(committed["board"]))]
    assert records[0] == t

    # Three admitted ballots with distinct nullifiers, so each is selected
    # whatever the L1 references rank: dan (cell 0, at step N0), tess (cell 1,
    # tier 2's) and eve (cell 0, at the step whose boundary is closes_at),
    # with the votes and labels verifier-ballots-v5-vectors.py made them from.
    made = {
        "dan": (1, "dan", [(3, [1]), (4, [0, 3]), (2, [1])]),
        "tess": (3, "tess", [(3, []), (4, []), (2, [1])]),
        "eve": (5, "eve-at-close", [(3, [1]), (4, []), (2, [1])]),
    }
    k, m = ev["threshold"], ev["optionTotal"]
    ballots, recs, constants_of = {}, {}, {}
    for who, (at, label, answers) in made.items():
        b = src["board"][at]["ballot"]
        rec = records[at]
        assert rec[2] == 5 and b["committedVote"] in rec
        # The ballot's constant terms (v_j, r_j), drawn as ballot-v4-vectors.py's
        # make_ballot drew them, with no author half: per option r_j, then
        # f's and g's other coefficients.
        rng = bv.Rng("ballot-v4/verifier-ballots-v5/" + ev["label"] + "/" + label)
        pairs = []
        for j, v in enumerate(b3.flat(answers)):
            r = rng.scalar()
            for _ in range(2 * (k - 1)):
                rng.scalar()
            assert grp.equal(bv.pedersen(v, r), b["vote"]["vss"][j][0]), (who, j)
            pairs.append((v, r))
        b = dict(b, ctx={"definitionHash": b["definitionHash"], "cell": b["cell"], "nullifier": b["nullifier"]})
        b["hash"] = r5.ballot_hash(b)
        ballots[who], recs[who], constants_of[who] = b, rec, pairs
    assert (ballots["dan"]["cell"], ballots["tess"]["cell"], ballots["eve"]["cell"]) == (0, 1, 0)
    defh = ev["definitionHash"]
    assert all(b["definitionHash"] == defh for b in ballots.values())

    # The registered seats, from the transcript, each seat's signing secret
    # from the transcript's label (ceremony-vectors.py, seat_secrets).
    checked = cv.check(panel, t, vc.election_of(d))
    assert checked["ok"] and [x["index"] for x in checked["registered"]] == vb5.SEATS
    secrets, registered, signing = {}, {DEFAULT: {}, AUTHOR: {}}, {}
    for x in checked["registered"]:
        i = x["index"]
        secrets[i] = cv.seat_secrets("verifier-ballots-v5/" + ev["label"], i)["signing"]
        assert cv.p256_key(secrets[i]).hex() == x["signingKey"], i
        signing[i] = bytes.fromhex(x["signingKey"])
        registered[DEFAULT][i] = {"signingKey": signing[i], "kem": None}

    def receipt(b, seat, ballot_hash=None):
        """Seat `seat`'s version-2 receipt for `b`, naming `ballot_hash` (`b`'s own by default)."""
        bh = b["hash"] if ballot_hash is None else ballot_hash
        sh = b["vote"]["shareHashes"][seat - 1]
        return dv2.receipt_record(defh, bh, DEFAULT, seat, sh, iv4.sign(secrets[seat], iv4.statement(defh, bh, DEFAULT, seat, sh)))

    def every(b, skip=()):
        return [receipt(b, seat) for seat in vb5.SEATS if seat not in skip]

    # The same fields at the next step, and read as version 4: other ballot
    # hashes, which name no selected ballot (T-38).
    def relabelled(b):
        return r5.ballot_hash(dict(b, step=b["step"] + 1))

    def as_v4(b):
        return b4.ballot_hash(b["ctx"], b["vote"])

    for b in ballots.values():
        assert len({b["hash"], relabelled(b), as_v4(b)}) == 3

    def opening(cell, signer, counted):
        """An honest tally opening of `cell` over the ballots `counted`, signed by seat `signer`."""
        agg = tv.aggregate(m, k, [ballots[w]["vote"]["vss"] for w in counted])
        values = [{"v": sum(constants_of[w][j][0] for w in counted) % L, "r": sum(constants_of[w][j][1] for w in counted) % L} for j in range(m)]
        ah = tov.aggregate_hash(agg)
        sig = tov.sign(secrets[signer], tov.statement(defh, cell, ah, signer, values))
        return tov.encode({"definitionHash": defh, "cell": cell, "aggregateHash": ah, "signer": signer, "opening": values, "signature": sig})

    clock = {"epoch": d["closes_at"] - 2 * PERIOD, "period": PERIOD, "deadline": 7200}
    seg_d, seg_k = dv.segments(clock["epoch"], PERIOD, d["closes_at"], d["l1_inclusion_bound"])
    t_d, t_k = dv.deadlines(d["closes_at"], d["l1_inclusion_bound"])
    floor = max(vo.floor_of(d["closes_at"], clock), seg_k)
    clock["lastSegment"] = floor + 2
    assert 3 <= seg_d < floor

    def board(segments):
        out = []
        for seg, payloads in segments:
            for p in payloads:
                out.append(vc.entry(BOARD_VERSION, eid, len(out), seg, p))
        return out

    head = (0, [t, recs["dan"], recs["tess"], recs["eve"]])
    order = ["dan", "tess", "eve"]
    cases = []

    def slices(counts):
        out, at = [], 0
        for q in ev["questions"]:
            out.append(counts[at : at + q["optionCount"]])
            at += q["optionCount"]
        return out

    def case(id_, description, segments):
        entries = board(segments)
        ceremony_rows, _ = vc.expected(panel, d, entries, panel, BOARD_VERSION)
        assert ceremony_rows["3.2"] == outcome("pass"), id_
        payloads = [p for _, ps in segments for p in ps]
        segment_of = [seg for seg, ps in segments for _ in ps]
        at_ballot = [payloads.index(recs[w]) for w in order]
        delivery, at_record, openings = [], [], []
        for i, p in enumerate(payloads):
            kind = int.from_bytes(p[:2], "big")
            if kind == RECEIPT_TYPE and segment_of[i] <= floor:
                delivery.append(("board", segment_of[i], p))
                at_record.append(i)
            elif kind == TALLY_OPENING_TYPE:
                openings.append(p)
        selected = [ballots[w] for w in order]
        result = dv2.check_delivery(defh, registered, seg_d, seg_k, t_d, t_k, selected, delivery, hash_of=lambda b: b["hash"])
        counted = [w for w, b in zip(order, result["ballots"]) if b["counted"]]
        # One cell per rolling tier, in rolling_electorate's order.
        tiers = [c["tier"] for c in ev["cells"]]
        cells = [[ballots[w]["vote"]["vss"] for w in counted if ballots[w]["cell"] == c] for c in range(len(tiers))]
        tally = tov.check_tally(defh, m, k, signing, cells, openings)
        rows = {
            # 5.9 has no failure of its own; 7.1 and 7.3 pass once the counted
            # set is known; the close check needs the run of L1 headers these
            # copies don't carry.
            "5.9": outcome("pass"),
            "6.3": NOT_REACHED,
            "7.1": outcome("pass"),
            "7.2": outcome("pass") if tally["ok"] else outcome("fail", tally["failure"]["code"], dict({"cell": tally["failure"]["cell"]}, **({"option": tally["failure"]["option"]} if "option" in tally["failure"] else {}))),
            "7.3": outcome("pass"),
            # No seat states destruction: each registered seat is
            # destruction-missing, decided whatever s_T is, so 8.5 fails at
            # the first (tally.md, Destruction checks).
            "8.5": outcome("fail", "destruction-missing", {"seat": vb5.SEATS[0]}),
        }
        report_cells = []
        for c, r in enumerate(tally["cells"]):
            signers = sorted({p["signer"] for p in r["passing"] if p["signer"] is not None})
            base = {"cell": c, "tier": tiers[c], "counted": len(cells[c])}
            if r["ok"]:
                counts = r["counts"]
                report_cells.append(dict(base, counts=counts, byQuestion=slices(counts), signers=signers))
            else:
                report_cells.append(dict(base, code=r["code"], **({"option": r["option"]} if "option" in r else {}), signers=signers))
        c = {
            "id": id_,
            "description": description,
            "definition": vc.encode(d).hex(),
            "clock": {k_: str(v) for k_, v in clock.items()},
            "board": b"".join(entries).hex(),
            "expected": rows,
            "delivery": {
                "excluded": [
                    {
                        "entry": at_ballot[i],
                        "missing": b["missing"],
                        "complaints": [],
                    }
                    for i, b in enumerate(result["ballots"])
                    if not b["counted"]
                ],
                "records": [dict({"entry": at_record[r["at"]], "code": r["code"], "panel": r["panel"], "seat": r["seat"]}, **({"signer": r["signer"]} if "signer" in r else {})) for r in result["records"]],
                "rejected": [{"entry": at_record[r["at"]], "decodeError": r["error"]} for r in result["rejected"]],
            },
            "counted": [at_ballot[order.index(w)] for w in counted],
            "cells": report_cells,
        }
        cases.append(c)
        return c

    dan, tess, eve = ballots["dan"], ballots["tess"], ballots["eve"]
    every_receipt = every(dan) + every(tess) + every(eve)
    delivered = case(
        "delivered",
        "A sealed rolling poll without an author panel (pick one of three, pick up to two of four, pick exactly one of two), one cell per rolling tier (tiers 0 and 2); seats 1 to 3 registered. In segment 0 the transcript and three ballots of distinct nullifiers: dan's (cell 0, step N0), tess's (cell 1) and eve's (cell 0, the step whose boundary is closes_at). In segment 3 every registered seat receipts each ballot by its version-5 ballot hash, beside seat 1's receipt for dan's fields relabelled to the next step and seat 2's for tess's fields read as version 4, each naming no selected ballot, so neither is reported. In segment 4 an honest opening of each cell (cell 0 over dan's and eve's ballots by seat 1, cell 1 over tess's by seat 2). Every ballot is delivered and counted, and 7.2 passes; no seat states destruction (8.5).",
        [
            head,
            (3, every_receipt + [receipt(dan, 1, relabelled(dan)), receipt(tess, 2, as_v4(tess))]),
            (4, [opening(0, 1, ["dan", "eve"]), opening(1, 2, ["tess"])]),
        ],
    )
    assert delivered["delivery"] == {"excluded": [], "records": [], "rejected": []} and len(delivered["counted"]) == 3
    assert delivered["expected"]["7.2"] == outcome("pass")

    relabel = case(
        "step-relabelled",
        "As delivered, but seat 1's only receipt for dan's ballot names dan's fields at the next step: version 5's ballot hash binds the step, so it names no selected ballot and dan's ballot misses seat 1 and isn't counted (T-38). Cell 0 is opened over eve's ballot alone, and 7.2 passes.",
        [
            head,
            (3, [receipt(dan, 1, relabelled(dan))] + every(dan, skip=[1]) + every(tess) + every(eve)),
            (4, [opening(0, 1, ["eve"]), opening(1, 2, ["tess"])]),
        ],
    )
    assert [(x["entry"], x["missing"]) for x in relabel["delivery"]["excluded"]] == [(1, [{"panel": DEFAULT, "seat": 1}])]

    v4 = case(
        "version-4-hash",
        "As delivered, but every receipt for tess's ballot names its fields' version-4 ballot hash: none names a selected ballot, so tess's ballot misses seats 1 to 3 and isn't counted. Cell 1 is empty, its honest opening (0, 0) for every option against the identity aggregate, and 7.2 passes with a count of 0.",
        [
            head,
            (3, every(dan) + [receipt(tess, seat, as_v4(tess)) for seat in vb5.SEATS] + every(eve)),
            (4, [opening(0, 1, ["dan", "eve"]), opening(1, 2, [])]),
        ],
    )
    assert [(x["entry"], len(x["missing"])) for x in v4["delivery"]["excluded"]] == [(2, 3)]
    assert v4["cells"][1]["counted"] == 0 and v4["cells"][1]["counts"] == ["0"] * m

    stale = case(
        "opening-over-another-set",
        "Every ballot delivered, but cell 0's only opening is over eve's ballot alone, as if dan's weren't counted: its aggregate isn't cell 0's, so 7.2 fails at cell 0 with tally-opening.",
        [head, (3, every_receipt), (4, [opening(0, 1, ["eve"]), opening(1, 2, ["tess"])])],
    )
    assert stale["expected"]["7.2"]["status"] == "fail" and stale["expected"]["7.2"]["at"] == {"cell": 0}

    missing = case(
        "cell-missing",
        "Every ballot delivered and cell 0 opened, but no opening of cell 1, tier 2's: 7.2 fails at cell 1 with tally-missing.",
        [head, (3, every_receipt), (4, [opening(0, 1, ["dan", "eve"])])],
    )
    assert missing["expected"]["7.2"] == outcome("fail", "tally-missing", {"cell": 1})

    doc = {
        "format": "abolish-verifier-counted-vectors/1",
        "title": "The verifier's delivery check and counted set under a rolling definition (definition version 7, electorate_mode 2; ballot version 5, delivery records version 2, tally-opening version 1, without an author panel): definitions, clocks, boards and the pinned panel, with the rows 5.9, 6.3, 7.1 to 7.3 and 8.5, the report's delivery and cells and the counted ballots' entries, beside verifier-ballots-v5.json's group registry events and registration time",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-counted-v5-rolling-vectors.py, from verifier-ballots-v5-vectors.py, ballot-v5-records-vectors.py, "
            "verifier-ceremony-vectors.py, ceremony-vectors.py, delivery-vectors.py, delivery-v2-vectors.py, intake-v4-vectors.py, "
            "tally-opening-vectors.py, tally-vectors.py and verifier-openings-vectors.py (independent Python implementations); "
            "the ballot records are verifier-ballots-v5.json's"
        ),
        "panel": {"threshold": str(panel["k"]), "keys": [x.hex() for x in panel["keys"]]},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-counted-v5-rolling.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: verifier-counted-v5-rolling-vectors.py <constants> <out-dir>")
    main(sys.argv[1], sys.argv[2])
