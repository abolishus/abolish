#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-counted-v5-rolling-author.json.

Elections for the verifier's delivery check, counted set and tally beside an
author panel under a rolling definition (definition version 7,
`electorate_mode` 2; ballot version 5, delivery records version 2,
tally-opening version 3, destruction statement version 2; docs/spec/
verifier.md, Counted set and tally and Tally openings; 5.9, 7.1 to 7.4 and
8.5; delivery.md, Versions and Delivery check (version 2); tally.md, Rolling
tiers, Author panel and Windows and destruction (version 2)):
verifier-ballots-v5-author.json's "author-mixed" election, a rolling poll
with a 2-of-3 author panel whose seat 3 sent nothing beside the 3-of-4
default panel whose seat 4 sent nothing, its board carrying both runs'
transcripts, the author approvals record and three admitted version-5
ballots: dan's (cell 0, step N0), ada's (cell 0, step N0 - 1) and tess's
(cell 1, tier 2's). Each version-2 receipt names its ballot by version 5's
ballot hash, which binds the step, so a receipt for the same fields at
another step delivers nothing for either panel (T-38). The partition is one
cell per rolling tier, each cell's count the sum of the two panels' partial
openings, each checked against its own panel's aggregate over the one counted
set delivery over both panels gives and attributed only by its own panel's
registered key set (T-29, T-37, T-54). Each case is a definition, a clock, a
board copy and the default panel a bundle pins, with the rows 5.9, 6.3, 7.1
to 7.4 and 8.5 a verifier reports, the report's `delivery`, the counted
ballots' entries and the report's `cells`, `tiers`, `tallies` and
`destruction`.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier:
verifier-ballots-v5-author-vectors.py (the election, both runs, the approvals
record and the ballots, rebuilt from their labels), ballot-v5-records-vectors.py
(version 5's ballot hash), ballot-v4-vectors.py (each ballot's shares, from
the labels it was made with), tally-vectors.py (each seat's summed shares and
the honest combination), panel-tally-vectors.py (the version-3 opening record,
its signature, the opening checks over both panels and the version-2
destruction statement and its check), verifier-ceremony-vectors.py and
ceremony-vectors.py (board entries, both runs' checks and the seats'
secrets), delivery-vectors.py and delivery-v2-vectors.py (the windows, the
version-2 receipt and the delivery check over both panels, given version 5's
hash), intake-v4-vectors.py (the receipt statement) and
verifier-openings-vectors.py (the floor of `s_S`).

The ballots' membership proofs are randomised, so their records are read from
the committed verifier-ballots-v5-author.json (its "author-mixed" case) and
checked against the ballots rebuilt here; nothing else needs a prover. Every
other value comes from fixed labels (test data, never keys).

Usage: python3 -I -B verifier-counted-v5-rolling-author-vectors.py <constants> <out-dir>,
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


vba = _load("verifier_ballots_v5_author_vectors", "verifier-ballots-v5-author-vectors.py")
dv2 = _load("delivery_v2_vectors", "delivery-v2-vectors.py")
vo = _load("verifier_openings_vectors", "verifier-openings-vectors.py")
pt = _load("panel_tally_vectors", "panel-tally-vectors.py")
r5, vc, cv, b3, b4 = vba.r5, vba.vc, vba.cv, vba.b3, vba.b4
tv = pt.tv
dv, iv4 = dv2.dv, dv2.iv4
DEFAULT, AUTHOR = dv2.DEFAULT, dv2.AUTHOR
assert (DEFAULT, AUTHOR) == (pt.DEFAULT, pt.AUTHOR) == (1, 2)
BOARD_VERSION = vba.BOARD_VERSION
TALLY_OPENING_TYPE = pt.TALLY_OPENING
DESTRUCTION_TYPE = pt.DESTRUCTION
PERIOD = 3600
DEADLINE = 7200
U32_MAX = 2**32 - 1
# tally.md, Author panel, Partial openings: a constant of tally-opening version 3.
AUTHOR_OPENING_WINDOW = 345_600
# parameters.md: a constant of tally-opening version 1, which version 3 keeps
# (tally.md, Windows and destruction (version 2)).
TALLY_WINDOW = 604_800
outcome, NOT_REACHED = vc.outcome, vc.NOT_REACHED
RECEIPT_TYPE = int.from_bytes(dv2.header(dv2.RECEIPT)[:2], "big")
# verifier-ballots-v5-author-vectors.py's admitted ballots in "author-mixed",
# by position on its board, label, cell, step offset from N0 and the answers
# it casts (its `build`): each is rebuilt below and compared, so a change
# there fails here rather than shifting the counts.
BALLOTS = [
    (3, "dan", 0, 0, [(3, [1]), (4, [0, 3]), (2, [1])]),
    (4, "ada", 0, -1, [(3, [0]), (4, []), (2, [0])]),
    (5, "tess", 1, 0, [(3, []), (4, []), (2, [1])]),
]


def main(constants, out_dir):
    s = vba.build(constants)
    src = next(b for b in s["bundles"] if b["id"] == "author-mixed")
    d, e, run = src["definition"], src["election"], src["run"]
    panel, author = s["panel"], s["author"]
    eid = d["election_id"]
    t_a, t_d, approved = src["board"][:3]
    assert vc.own_version(d) == 7 and d["electorate_mode"] == vba.rv.ROLLING and d["author_keys"]
    assert dict(d["profile"]["pins"])[TALLY_OPENING_TYPE] == 3
    m = e["optionTotal"]
    defh = e["definitionHash"]
    assert defh == vba.H(vba.ds(b3.DEFINITION_TAG, vc.encode(d)))

    committed = next(c for c in json.loads((VECTORS / "verifier-ballots-v5-author.json").read_text())["cases"] if c["id"] == "author-mixed")
    records = [vc.decode_entry(x, BOARD_VERSION)["payload"] for x in vo.split(bytes.fromhex(committed["board"]))]
    assert records[:3] == [t_a, t_d, approved]

    ballots, recs = [], []
    for at, label, cell, offset, answers in BALLOTS:
        b, _ = src["board"][at]
        rec = records[at]
        assert b["cell"] == cell and b["step"] == vba.N0 + offset, label
        assert rec[2] == 5 and b["committedVote"] in rec, label
        # The ballot's shares, from the label and share hashes it was made with.
        vote, _, shares, author_shares = b4.make_ballot(
            "verifier-ballots-v5-author/" + e["label"] + "/" + label,
            e,
            {"definitionHash": defh, "cell": cell, "nullifier": b["nullifier"]},
            b3.flat(answers),
            version=5,
            share_hashes=list(b["vote"]["shareHashes"]),
            author_share_hashes=list(b["vote"]["authorShareHashes"]),
        )
        assert vote == b["vote"], label
        ballots.append(dict(b, label=label, hash=r5.ballot_hash(b), votes=b3.flat(answers), shares={DEFAULT: shares, AUTHOR: author_shares}))
        recs.append(rec)
    dan, ada, tess = ballots

    # Both panels' registered seats from their own runs, and each seat's
    # signing secret from its run's label (ceremony-vectors.py, seat_secrets).
    own = cv.check(dict(panel, otherKeys=list(author["keys"])), t_d, vc.election_of(d))
    theirs = cv.check(author, t_a, vba.context(d, vba.author_stub_hash(d)))
    assert own["ok"] and [k["index"] for k in own["registered"]] == [1, 2, 3]
    assert theirs["ok"] and [k["index"] for k in theirs["registered"]] == [1, 2]
    labels = {DEFAULT: "verifier-ballots-v5-author/author/default", AUTHOR: "verifier-ballots-v5-author/author/author"}
    secrets, registered = {}, {}
    for p, checked in ((DEFAULT, own), (AUTHOR, theirs)):
        registered[p] = {}
        for k in checked["registered"]:
            i = k["index"]
            secrets[(p, i)] = cv.seat_secrets(labels[p], i)["signing"]
            assert cv.p256_key(secrets[(p, i)]).hex() == k["signingKey"], (p, i)
            registered[p][i] = {"signingKey": bytes.fromhex(k["signingKey"]), "kem": None}
    keys = {p: {i: k["signingKey"] for i, k in registered[p].items()} for p in registered}
    thresholds = {DEFAULT: d["threshold"], AUTHOR: d["author_threshold"]}

    def relabelled(b):
        """The same fields at the next step: another ballot hash, which names no selected ballot (T-38)."""
        return r5.ballot_hash(dict(b, step=b["step"] + 1))

    for b in ballots:
        assert b["hash"] != relabelled(b)

    def receipt(b, p, seat, ballot_hash=None):
        bh = b["hash"] if ballot_hash is None else ballot_hash
        sh = (b["vote"]["shareHashes"] if p == DEFAULT else b["vote"]["authorShareHashes"])[seat - 1]
        return dv2.receipt_record(defh, bh, p, seat, sh, iv4.sign(secrets[(p, seat)], iv4.statement(defh, bh, p, seat, sh)))

    def every(b, skip=()):
        return [receipt(b, p, seat) for p in (DEFAULT, AUTHOR) for seat in sorted(registered[p]) if (p, seat) not in skip]

    def honest(p, counted):
        """Panel `p`'s partial opening of a cell over `counted`, combined from its first k_P seats' summed shares (tally.md, Partial openings)."""
        summed = {i: tv.sum_shares(m, [b["shares"][p][i - 1] for b in counted]) for i in range(1, thresholds[p] + 1)}
        return tv.honest_opening(m, summed, thresholds[p])

    def opening(cell, p, counted, signer, signed_by=None):
        """A version-3 tally opening of `cell` for panel `p` over `counted`, by `signer`, signed with `signed_by`'s secret (the signer's own by default)."""
        agg = tv.aggregate(m, thresholds[p], [b["vote"]["vss" if p == DEFAULT else "authorVss"] for b in counted])
        o = {
            "definitionHash": defh,
            "cell": cell,
            "panel": p,
            "aggregateHash": pt.aggregate_hash(agg),
            "signer": signer,
            "opening": honest(p, counted),
        }
        o["signature"] = pt.sign(pt.PARTIAL_TAG, secrets[signed_by or (p, signer)], pt.opening_message(o))
        return pt.encode_opening(o)

    def statement(p, signer):
        """Seat (p, signer)'s version-2 destruction statement."""
        msg = pt.destruction_message(defh, p, signer)
        return msg + pt.sign(pt.DESTRUCTION_TAG, secrets[(p, signer)], msg)

    clock = {"epoch": d["closes_at"] - 2 * PERIOD, "period": PERIOD, "deadline": DEADLINE}
    seg_d, seg_k = dv.segments(clock["epoch"], PERIOD, d["closes_at"], d["l1_inclusion_bound"])
    t_dd, t_kk = dv.deadlines(d["closes_at"], d["l1_inclusion_bound"])
    floor = max(vo.floor_of(d["closes_at"], clock), seg_k)
    # s_A = period(t_S + AUTHOR_OPENING_WINDOW), t_S the end of period s_S plus
    # the deadline, so with s_S at its floor s_A is at least this.
    s_a = floor + 1 + (DEADLINE + AUTHOR_OPENING_WINDOW) // PERIOD
    timely = floor + 1
    # s_T's floor (Windows and destruction (version 2)).
    s_t = floor + 1 + (DEADLINE + TALLY_WINDOW) // PERIOD
    clock["lastSegment"] = s_t + 1
    assert 3 <= seg_d < floor

    def board(segments):
        out = []
        for seg, payloads in segments:
            for p in payloads:
                out.append(vc.entry(BOARD_VERSION, eid, len(out), seg, p))
        return out

    def tally_report(low, openings, opening_at):
        """7.4 under tally-opening version 3, with the counted set known (verifier.md, Tally openings; tally.md, Boarding (version 3)): each opening, sorted into one of the rolling tiers' cells for a panel or stray, with its breaks in the boarding rule's order, and the row at the first opening with a code or a break."""
        failing = {f["at"]: f for c in low["cells"] for half in ("default", "author") for f in c[half]["failing"]}
        early = {x["at"] for x in low["early"]}
        first, out = {}, []
        for k, (_, b) in enumerate(openings):
            entry = opening_at[k]
            try:
                o = pt.decode_opening(b)
            except pt.Reject as err:
                out.append({"entry": entry, "code": "decode", "decodeError": err.code, "breaks": []})
                continue
            signer = pt.attribution(keys, o)
            if not (o["definitionHash"] == defh and o["cell"] < len(e["cells"]) and o["panel"] in (DEFAULT, AUTHOR)):
                breaks = [{"code": "tally-stray"}] + ([{"code": "tally-unattributed"}] if signer is None else [])
                out.append({"entry": entry, "panel": o["panel"], "signer": signer, "breaks": breaks})
                continue
            breaks = []
            if len(o["opening"]) != m:
                breaks.append({"code": "tally-missing"})
            elif k in failing:
                f = failing[k]
                breaks.append({"code": f["code"], **({"option": f["option"]} if "option" in f else {})})
            if signer is None:
                breaks.append({"code": "tally-unattributed"})
            else:
                key, signed = (o["cell"], o["panel"], signer), pt.opening_message(o)
                if key in first:
                    of, earlier = first[key]
                    breaks.append({"code": "tally-repeat" if earlier == signed else "tally-second", "of": of})
                else:
                    first[key] = (entry, signed)
            if k in early:
                breaks.append({"code": "tally-early"})
            out.append({"entry": entry, "cell": o["cell"], "panel": o["panel"], "signer": signer, "breaks": breaks})
        head = next((o for o in out if "code" in o or o["breaks"]), None)
        if head is None:
            return out, outcome("pass")
        at = {"entry": head["entry"], **({"decodeError": head["decodeError"]} if "decodeError" in head else {})}
        return out, outcome("fail", head.get("code") or head["breaks"][0]["code"], at)

    def destruction_report(low, payloads, segment_of):
        """8.5 under destruction-statement version 2 (verifier.md, Counted set and tally, step 7; tally.md, Windows and destruction (version 2)), with s_T at its floor: a seat is destroyed only at or after s_O + 1, early only below the floor's destruction segment, and undecided between."""
        at = [i for i, p in enumerate(payloads) if int.from_bytes(p[:2], "big") == DESTRUCTION_TYPE]
        first_passing = [{p: (c[p]["passing"][0]["segment"] if c[p]["passing"] else None) for p in ("default", "author")} for c in low["cells"]]
        got = pt.check_destruction(defh, keys, [(segment_of[i], payloads[i]) for i in at], first_passing, s_t)
        segs = [x for c in first_passing for x in c.values()]
        latest = None if None in segs else max(segs) + 1
        seats = []
        for x in got["seats"]:
            r = {"panel": x["panel"], "seat": x["seat"]}
            if x["code"] == "destruction-missing":
                r["code"] = x["code"]
            elif x["code"] == "destruction-early":
                r.update(code=x["code"], entry=at[x["at"]])
            else:
                if latest is not None and segment_of[at[x["at"]]] >= latest:
                    r["code"] = "destroyed"
                r["entry"] = at[x["at"]]
            seats.append(r)
        report = {
            "earliest": got["from"],
            **({"latest": latest} if latest is not None else {}),
            "seats": seats,
            "duplicates": [{"entry": at[x["at"]], "panel": x["panel"], "seat": x["seat"]} for x in got["duplicates"]],
            "unattributed": [{"entry": at[x["at"]]} for x in got["unattributed"]],
            "stray": [{"entry": at[x["at"]], "panel": x["panel"], "signer": x["signer"]} for x in got["stray"]],
            "rejected": [{"entry": at[x["at"]], "decodeError": x["error"]} for x in got["rejected"]],
        }
        where = lambda x: {"panel": x["panel"], "seat": x["seat"]}
        undecided = next((x for x in seats if "code" not in x), None)
        missed = next((x for x in seats if x.get("code") not in (None, "destroyed")), None)
        if undecided is not None:
            row = outcome("unverifiable", "not-implemented", where(undecided))
        elif missed is not None:
            row = outcome("fail", missed["code"], where(missed))
        else:
            row = outcome("pass")
        return report, row

    tiers = [c["tier"] for c in e["cells"]]
    assert tiers == [0, 2]
    cases = []

    def case(id_, description, segments):
        entries = board(segments)
        ceremony_rows, _ = vc.expected(panel, d, entries, panel, BOARD_VERSION)
        assert ceremony_rows["3.2"] == outcome("pass"), id_
        payloads = [p for _, ps in segments for p in ps]
        segment_of = [seg for seg, ps in segments for _ in ps]
        seats = vba.approving(d, author, run["hash"], run["keySetHash"], [p for p in payloads if int.from_bytes(p[:2], "big") == vba.ac.APPROVALS_TYPE])
        assert seats == [1, 2], id_
        at_ballot = [payloads.index(r) for r in recs]
        delivery, at_record, openings, opening_at = [], [], [], []
        for i, p in enumerate(payloads):
            kind = int.from_bytes(p[:2], "big")
            if kind == RECEIPT_TYPE and segment_of[i] <= floor:
                delivery.append(("board", segment_of[i], p))
                at_record.append(i)
            elif kind == TALLY_OPENING_TYPE:
                openings.append((segment_of[i], p))
                opening_at.append(i)
        result = dv2.check_delivery(defh, registered, seg_d, seg_k, t_dd, t_kk, ballots, delivery, hash_of=lambda b: b["hash"])
        cells = [[] for _ in tiers]
        for b, verdict in zip(ballots, result["ballots"]):
            if verdict["counted"]:
                cells[b["cell"]].append(b["vote"])
        # Opening checks (version 3) with s_A at its floor and unbounded: a
        # cell or 7.2 is decided only where both agree (verifier.md, Counted
        # set and tally, step 5).
        low = pt.check_partial_tally(e, keys, cells, openings, s_a)
        high = pt.check_partial_tally(e, keys, cells, openings, U32_MAX)
        report = []
        for c, (x, y) in enumerate(zip(low["cells"], high["cells"])):
            assert x["ok"] == y["ok"], (id_, c)
            r = {"cell": c, "tier": tiers[c], "counted": len(cells[c])}
            if x["ok"]:
                r["counts"] = x["counts"]
            elif x["code"] == y["code"]:
                r["code"] = x["code"]
                r.update({k: x[k] for k in ("panel", "option", "question") if k in x})
            r["signers"] = sorted({p["signer"] for p in x["default"]["passing"] if p["signer"] is not None})
            r["authorSigners"] = sorted({p["signer"] for p in x["author"]["passing"] if p["signer"] is not None})
            report.append(r)
        if "failure" not in low:
            row = outcome("pass")
        elif low["failure"]["code"] == high["failure"]["code"]:
            f = low["failure"]
            row = outcome("fail", f["code"], {"cell": f["cell"], **{k: f[k] for k in ("panel", "option", "question") if k in f}})
        else:
            row = outcome("unverifiable", "not-implemented", {"cell": low["failure"]["cell"]})
        tallies, tally_row = tally_report(low, openings, opening_at)
        destruction, destruction_row = destruction_report(low, payloads, segment_of)
        # One cell per rolling tier, so each tier's totals are its cell's.
        tier_report = [dict({"tier": r["tier"], "counted": r["counted"]}, **({"counts": r["counts"]} if "counts" in r else {})) for r in report]
        cases.append(
            {
                "id": id_,
                "description": description,
                "definition": vc.encode(d).hex(),
                "clock": {k: str(v) for k, v in clock.items()},
                "board": b"".join(entries).hex(),
                # 6.3 needs the run of L1 headers these copies don't carry.
                "expected": {
                    "5.9": outcome("pass"),
                    "6.3": NOT_REACHED,
                    "7.1": outcome("pass"),
                    "7.2": row,
                    "7.3": outcome("pass"),
                    "7.4": tally_row,
                    "8.5": destruction_row,
                },
                "delivery": {
                    "excluded": [{"entry": at_ballot[i], "missing": b["missing"], "complaints": []} for i, b in enumerate(result["ballots"]) if not b["counted"]],
                    "records": [dict({"entry": at_record[r["at"]], "code": r["code"], "panel": r["panel"], "seat": r["seat"]}, **({"signer": r["signer"]} if "signer" in r else {})) for r in result["records"]],
                    "rejected": [{"entry": at_record[r["at"]], "decodeError": r["error"]} for r in result["rejected"]],
                },
                "counted": [at_ballot[i] for i, v in enumerate(result["ballots"]) if v["counted"]],
                "cells": report,
                "tiers": tier_report,
                "tallies": tallies,
                "destruction": destruction,
            }
        )
        return cases[-1]

    head = (0, [t_a, t_d, approved] + recs)
    by_cell = [[dan, ada], [tess]]

    def authors(skip=(), counted=None):
        """Author seat 1's partial opening of each cell over `counted` (each cell's ballots by default), at `timely`."""
        sets = counted or by_cell
        return [(timely, opening(c, AUTHOR, sets[c], 1)) for c in range(2) if c not in skip]

    def defaults(skip=(), counted=None):
        """Default seat 2's partial opening of each cell over `counted` (each cell's ballots by default), at `timely` + 1."""
        sets = counted or by_cell
        return [(timely + 1, opening(c, DEFAULT, sets[c], 2)) for c in range(2) if c not in skip]

    def segments(receipts, *openings):
        rows = {}
        for seg, p in (x for xs in openings for x in xs):
            rows.setdefault(seg, []).append(p)
        return [head, (3, receipts)] + sorted(rows.items())

    every_receipt = every(dan) + every(ada) + every(tess)
    # Every cell's first passing partial openings are by timely + 1 for both
    # panels, so the destruction segment is timely + 2 (s_O + 1).
    s_o1 = timely + 2
    seats = [(p, i) for p in (DEFAULT, AUTHOR) for i in sorted(registered[p])]
    counted = case(
        "counted",
        f"A sealed rolling poll (pick one of three, pick up to two of four, pick exactly one of two), one cell per rolling tier (tiers 0 and 2), beside a 2-of-3 author panel whose seat 3 sent nothing and the 3-of-4 default panel whose seat 4 sent nothing. In segment 0 both transcripts, the approvals record and three ballots of distinct nullifiers: dan's (cell 0, step N0), ada's (cell 0, step N0 - 1) and tess's (cell 1). In segment 3 every registered seat of both panels receipts each ballot by its version-5 ballot hash, beside author seat 1's receipt for dan's fields relabelled to the next step, which names no selected ballot. Author seat 1's partial opening of each cell in segment {timely}, then default seat 2's in segment {timely + 1}, and every registered seat of both panels states destruction (version 2) in segment {s_o1}. Every ballot is counted, each cell's count the sum of both panels' partial openings, and every row passes.",
        segments(every_receipt + [receipt(dan, AUTHOR, 1, relabelled(dan))], authors(), defaults(), [(s_o1, statement(p, i)) for p, i in seats]),
    )
    assert counted["expected"] == {**{r: outcome("pass") for r in ("5.9", "7.1", "7.2", "7.3", "7.4", "8.5")}, "6.3": NOT_REACHED}
    assert counted["delivery"] == {"excluded": [], "records": [], "rejected": []} and counted["counted"] == [3, 4, 5]
    sums = [[str(x + y) for x, y in zip(dan["votes"], ada["votes"])], [str(v) for v in tess["votes"]]]
    assert [c["counts"] for c in counted["cells"]] == sums
    assert [(c["signers"], c["authorSigners"]) for c in counted["cells"]] == [([2], [1]), ([2], [1])]

    relabel = case(
        "author-step-relabelled",
        "As counted without the destruction statements, but author seat 1's only receipt for dan's ballot names dan's fields at the next step: version 5's ballot hash binds the step, so it names no selected ballot, and dan's ballot misses author seat 1 and isn't counted (T-38). Both panels open cell 0 over ada's ballot alone, and 7.2 passes; no seat states destruction (8.5).",
        segments(
            [receipt(dan, AUTHOR, 1, relabelled(dan))] + every(dan, skip=[(AUTHOR, 1)]) + every(ada) + every(tess),
            authors(counted=[[ada], [tess]]),
            defaults(counted=[[ada], [tess]]),
        ),
    )
    assert [(x["entry"], x["missing"]) for x in relabel["delivery"]["excluded"]] == [(3, [{"panel": AUTHOR, "seat": 1}])]
    assert relabel["counted"] == [4, 5] and relabel["expected"]["7.2"] == outcome("pass")
    assert relabel["expected"]["8.5"] == outcome("fail", "destruction-missing", {"panel": DEFAULT, "seat": 1})

    stale = case(
        "author-over-another-set",
        "Every ballot counted, but the author panel's only partial opening of cell 0 is over dan's ballot alone, as if ada's weren't counted: its aggregate isn't cell 0's author aggregate, so cell 0 fails tally-opening for the author panel, checked first, whatever the default panel opened; 7.4 fails at it with tally-aggregate.",
        segments(every_receipt, authors(counted=[[dan], [tess]]), defaults()),
    )
    assert stale["expected"]["7.2"] == outcome("fail", "tally-opening", {"cell": 0, "panel": AUTHOR})
    assert stale["expected"]["7.4"] == outcome("fail", "tally-aggregate", {"entry": stale["tallies"][0]["entry"]})

    missing = case(
        "author-missing",
        "Every ballot counted, but no author partial opening of cell 1, tier 2's: it fails tally-missing for the author panel, though default seat 2 opened its half, and 7.2 fails at cell 1.",
        segments(every_receipt, authors(skip=(1,)), defaults()),
    )
    assert missing["expected"]["7.2"] == outcome("fail", "tally-missing", {"cell": 1, "panel": AUTHOR})

    default_missing = case(
        "default-missing",
        "Every ballot counted and every author partial opening timely, at or below s_A's floor, but no default partial opening of cell 1: it fails tally-missing for the default panel.",
        segments(every_receipt, authors(), defaults(skip=(1,))),
    )
    assert default_missing["expected"]["7.2"] == outcome("fail", "tally-missing", {"cell": 1, "panel": DEFAULT})

    version_1 = bytearray(opening(0, AUTHOR, by_cell[0], 2))
    version_1[2] = 1
    boarding = case(
        "boarding",
        "Every ballot counted, then: default seat 2's partial opening of cell 0 boarded before any author one (tally-early, the operator's, and it still counts); author seat 1's partial opening of each cell, its opening of cell 1 boarded twice byte for byte (tally-repeat) and a second of cell 0 over dan's ballot alone (tally-aggregate, and tally-second); author seat 2's partial opening naming cell 2, a stray opening, since the partition is one cell per rolling tier and there are two (tally-stray); an author partial opening of cell 1 under a version-1 header (a rejected entry); and default seat 2's partial opening of cell 1. Every cell passes; 7.4 fails at the first break, tally-early.",
        segments(
            every_receipt,
            [(timely, opening(0, DEFAULT, by_cell[0], 2))],
            authors(),
            [
                (timely, opening(1, AUTHOR, by_cell[1], 1)),
                (timely, opening(0, AUTHOR, [dan], 1)),
                (timely, opening(2, AUTHOR, [], 2)),
                (timely, bytes(version_1)),
            ],
            defaults(skip=(0,)),
        ),
    )
    assert boarding["expected"]["7.2"] == outcome("pass")
    first_opening = boarding["tallies"][0]["entry"]
    assert boarding["expected"]["7.4"] == outcome("fail", "tally-early", {"entry": first_opening})
    got = [[b["code"] for b in o["breaks"]] for o in boarding["tallies"]]
    assert got == [["tally-early"], [], [], ["tally-repeat"], ["tally-aggregate", "tally-second"], ["tally-stray"], [], []], got
    assert boarding["tallies"][6]["code"] == "decode" and boarding["tallies"][5]["panel"] == AUTHOR

    doc = {
        "format": "abolish-verifier-tally-vectors/1",
        "title": "The verifier's delivery check, counted set and tally beside an author panel under a rolling definition (definition version 7, electorate_mode 2; ballot version 5, delivery records version 2, tally-opening version 3, destruction statement version 2): definitions, clocks, boards carrying both panels' transcripts, the author approvals, ballots, share receipts, partial openings and destruction statements, and the pinned default panel, with the rows 5.9, 6.3, 7.1 to 7.4 and 8.5, the report's delivery, cells, tiers, tallies and destruction and the counted ballots' entries, beside verifier-ballots-v5-author.json's group registry events and registration time",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-counted-v5-rolling-author-vectors.py, from verifier-ballots-v5-author-vectors.py, "
            "ballot-v5-records-vectors.py, ballot-v4-vectors.py, tally-vectors.py, panel-tally-vectors.py, verifier-ceremony-vectors.py, "
            "ceremony-vectors.py, delivery-vectors.py, delivery-v2-vectors.py, intake-v4-vectors.py and verifier-openings-vectors.py "
            "(independent Python implementations); the ballot records are verifier-ballots-v5-author.json's"
        ),
        "panel": {"threshold": str(panel["k"]), "keys": [k.hex() for k in panel["keys"]]},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-counted-v5-rolling-author.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: verifier-counted-v5-rolling-author-vectors.py <constants> <out-dir>")
    main(sys.argv[1], sys.argv[2])
