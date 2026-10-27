#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-tally-v3-author.json
and verifier-tally-v3-author-definition-v7.json.

Elections for the verifier's tally beside an author panel (docs/spec/
verifier.md, Counted set and tally, steps 4 to 7; Tally openings; 7.1 to
7.4 and 8.5; tally.md, Author panel, Opening checks, Boarding (version 3) and
Windows and destruction (version 2)): verifier-ballots-v4-author.json's
"author-mixed" election under a profile that pins tally-opening version 3,
or, for the definition-version-7 file, the same election under definition
version 7 with a fixed electorate, which the verifier reads as version 6
under version 7's own hashes and stubs (docs/spec/verifier.md, Definition),
with a 2-of-3 author panel whose seat 3 sent nothing beside the 3-of-4
default panel whose seat 4 sent nothing, its board carrying both runs'
transcripts, the author approvals record, three admitted ballots (one per
cell), every registered seat's version-2 share receipt and version-3 partial
openings. Each cell's count is the sum of the two panels' partial openings,
each checked against its own panel's aggregate over the one counted set
delivery over both panels gives, and attributed only by its own panel's
registered key set (T-29, T-37, T-54). A missing default partial opening is
`tally-author-late` while some cell's author opening is late (past `s_A`), and
the default panel's `tally-missing` otherwise; the bundle knows only a floor
of `s_A`, so where the two readings differ the cell isn't decided. Every
partial opening is sorted by its panel byte and attributed only by that
panel's key set, a second or a repeat is by the same seat of the same panel,
and a default partial opening boarded before every cell had a passing author
one is `tally-early` (7.4). Every seat of both panels is judged by its first
version-2 destruction statement attributed to it, against a destruction
segment from the latest first passing opening over cells and both panels
(8.5). Each case is a definition, a clock, a board copy and the default panel
a bundle pins, with the rows 5.9, 6.3, 7.1 to 7.4 and 8.5 a verifier reports,
the counted ballots' entries and the report's `cells`, `tiers`, `tallies` and
`destruction`.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier:
verifier-ballots-v4-author-vectors.py (the election, both runs, the
approvals record and the ballots, rebuilt from their labels under this
profile), ballot-v4-vectors.py (each ballot's shares, from the same labels),
tally-vectors.py (each seat's summed shares and the honest combination),
panel-tally-vectors.py (the version-3 opening record, its signature and the
opening checks over both panels), verifier-ceremony-vectors.py and
ceremony-vectors.py (board entries, both runs' checks and the seats'
secrets), delivery-vectors.py and delivery-v2-vectors.py (the windows, the
version-2 receipt and the delivery check over both panels),
intake-v4-vectors.py (the receipt statement) and
verifier-openings-vectors.py (the floor of `s_S`).

Membership proofs need a Groth16 prover, so generation has three steps, as
for verifier-ballots-v4-author.json:

  python3 -I -B verifier-tally-v3-author-vectors.py statements <constants> <work>/statements.json [7]
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B verifier-tally-v3-author-vectors.py assemble <constants> <work>/proofs.json <out-dir> [7]

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json,
ballot-proofs.mjs runs outside the workspace (see its header) and a final `7`
makes the definition-version-7 file, with its own proofs. Every value
but the proofs is deterministic from fixed labels (test data, never keys);
Groth16 proving is randomised, so the committed file is the record. Then
`vp check --fix` formats it.
"""

import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


vba = _load("verifier_ballots_v4_author_vectors", "verifier-ballots-v4-author-vectors.py")
dv2 = _load("delivery_v2_vectors", "delivery-v2-vectors.py")
vo = _load("verifier_openings_vectors", "verifier-openings-vectors.py")
pt = _load("panel_tally_vectors", "panel-tally-vectors.py")
vc, cv, vb4, r4 = vba.vc, vba.cv, vba.vb4, vba.r4
b3, b4 = vba.b3, vba.b4
tv = pt.tv
dv, iv4 = dv2.dv, dv2.iv4
DEFAULT, AUTHOR = dv2.DEFAULT, dv2.AUTHOR
assert (DEFAULT, AUTHOR) == (pt.DEFAULT, pt.AUTHOR) == (1, 2)
BOARD_VERSION = vba.BOARD_VERSION
TALLY_OPENING_TYPE = pt.TALLY_OPENING
PERIOD = 3600
DEADLINE = 7200
U32_MAX = 2**32 - 1
# tally.md, Author panel, Partial openings: a constant of tally-opening version 3.
AUTHOR_OPENING_WINDOW = 345_600
# parameters.md: a constant of tally-opening version 1, which version 3 keeps
# (tally.md, Windows and destruction (version 2)).
TALLY_WINDOW = 604_800
DESTRUCTION_TYPE = pt.DESTRUCTION
outcome, NOT_REACHED = vc.outcome, vc.NOT_REACHED
RECEIPT_TYPE = int.from_bytes(dv2.header(dv2.RECEIPT)[:2], "big")
# verifier-ballots-v4-author-vectors.py's admitted ballots, by label, with the
# answers it casts (its `build`): each is rebuilt below and compared, so a
# change there fails here rather than shifting the counts.
BALLOTS = [
    ("cell-0", 0, [(3, [1]), (4, [0, 3]), (2, [1])]),
    ("remainder-region-1", 1, [(3, [2]), (4, []), (2, [0])]),
    ("tier-2", 2, [(3, []), (4, []), (2, [1])]),
]


def pins(version=6):
    """verifier-ballots-v4-author-vectors.py's profile with tally-opening version 3, the one an author panel pins (tally.md, Author panel)."""
    p = vba.base_pins(version)
    return dict(p, pins=[(t, 3 if t == TALLY_OPENING_TYPE else v) for t, v in p["pins"]])


vba.base_pins = vba.pins
vba.pins = pins


def build(constants, version=6):
    """The "author-mixed" election under this profile: its definition, runs, approvals and the three admitted ballots, with the proofs they need."""
    s = vba.build(constants, version)
    src = next(b for b in s["bundles"] if b["id"] == "author-mixed")
    d = src["definition"]
    assert dict(d["profile"]["pins"])[TALLY_OPENING_TYPE] == 3 and vc.own_version(d) == version
    ballots = [p for p in src["board"][3:6]]
    pids = [pid for _, pid in ballots]
    assert pids == [f"author/{label}" for label, _, _ in BALLOTS], pids
    checks = [c for c in s["checks"] if c["case"] in (f"author-mixed/{i}" for i in (3, 4, 5))]
    assert len(checks) == 3
    return s, src, ballots, checks


def statements(constants, out, version=6):
    s, _, ballots, checks = build(constants, version)
    proofs = [s["proofs"][pid] for _, pid in ballots]
    pathlib.Path(out).write_text(json.dumps({"proofs": proofs, "checks": checks}, indent=2) + "\n")


def assemble(constants, proofs_path, out_dir, version=6):
    s, src, proved, _ = build(constants, version)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    d, e, run = src["definition"], src["election"], src["run"]
    panel, author = s["panel"], s["author"]
    eid = d["election_id"]
    t_a, t_d, approved = src["board"][:3]
    m = e["optionTotal"]

    ballots, recs = [], []
    for (b, pid), (label, cell, answers), i in zip(proved, BALLOTS, (3, 4, 5)):
        assert b["cell"] == cell and got["verdicts"][f"author-mixed/{i}"] is True, pid
        # Admitted against both panels' registered seats (default seats 1 to
        # 3, author seats 1 and 2), its proof verifying under its signals.
        assert r4.admission(e, [1, 2, 3], run["registered"], b, True)["code"] == "ok", pid
        recs.append(r4.enc_ballot(dict(b, proof=bytes.fromhex(got["proofs"][pid]))))
        # The ballot's shares, from the labels it was made with.
        share_hashes = list(b["vote"]["shareHashes"])
        author_share_hashes = list(b["vote"]["authorShareHashes"])
        vote, _, shares, author_shares = b4.make_ballot(
            "verifier-ballot-v4-author/" + e["label"] + "/" + label,
            e,
            {"definitionHash": e["definitionHash"], "cell": cell, "nullifier": b["nullifier"]},
            b3.flat(answers),
            share_hashes=share_hashes,
            author_share_hashes=author_share_hashes,
        )
        assert vote == b["vote"], pid
        ctx = {"definitionHash": b["definitionHash"], "cell": cell, "nullifier": b["nullifier"]}
        ballots.append(dict(b, ctx=ctx, hash=b4.ballot_hash(ctx, b["vote"]), votes=b3.flat(answers), shares={DEFAULT: shares, AUTHOR: author_shares}))
    defh = ballots[0]["definitionHash"]
    assert defh == vb4.H(vb4.ds(vb4.DEFINITION_TAG, vc.encode(d)))

    # Both panels' registered seats from their own runs, and each seat's
    # signing secret from its run's label (ceremony-vectors.py, seat_secrets).
    own = cv.check(dict(panel, otherKeys=list(author["keys"])), t_d, vc.election_of(d))
    theirs = cv.check(author, t_a, vba.context(d, vba.author_stub_hash(d)))
    assert own["ok"] and [k["index"] for k in own["registered"]] == [1, 2, 3]
    assert theirs["ok"] and [k["index"] for k in theirs["registered"]] == [1, 2]
    labels = {DEFAULT: "verifier-ballots-v4-author/author/default", AUTHOR: "verifier-ballots-v4-author/author/author"}
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

    def receipt(b, p, seat):
        sh = (b["vote"]["shareHashes"] if p == DEFAULT else b["vote"]["authorShareHashes"])[seat - 1]
        msg = iv4.statement(defh, b["hash"], p, seat, sh)
        return dv2.receipt_record(defh, b["hash"], p, seat, sh, iv4.sign(secrets[(p, seat)], msg))

    def every(b, skip=()):
        return [receipt(b, p, seat) for p in (DEFAULT, AUTHOR) for seat in sorted(registered[p]) if (p, seat) not in skip]

    def honest(p, counted):
        """Panel `p`'s partial opening of a cell over `counted`, combined from its first k_P seats' summed shares (tally.md, Partial openings)."""
        summed = {i: tv.sum_shares(m, [b["shares"][p][i - 1] for b in counted]) for i in range(1, thresholds[p] + 1)}
        return tv.honest_opening(m, summed, thresholds[p])

    def opening(cell, p, counted, signer, signed_by=None, panel_byte=None, change=None, definition_hash=defh):
        """A version-3 tally opening of `cell` for panel `p` over `counted`, by `signer`, signed with `signed_by`'s secret (the signer's own by default)."""
        agg = tv.aggregate(m, thresholds[p], [b["vote"]["vss" if p == DEFAULT else "authorVss"] for b in counted])
        o = {
            "definitionHash": definition_hash,
            "cell": cell,
            "panel": p if panel_byte is None else panel_byte,
            "aggregateHash": pt.aggregate_hash(agg),
            "signer": signer,
            "opening": honest(p, counted) if change is None else change(honest(p, counted)),
        }
        key = secrets[signed_by if signed_by is not None else (p, signer)]
        o["signature"] = pt.sign(pt.PARTIAL_TAG, key, pt.opening_message(o))
        return pt.encode_opening(o)

    clock = {"epoch": d["closes_at"] - 2 * PERIOD, "period": PERIOD, "deadline": DEADLINE}
    seg_d, seg_k = dv.segments(clock["epoch"], PERIOD, d["closes_at"], d["l1_inclusion_bound"])
    t_d_, t_k_ = dv.deadlines(d["closes_at"], d["l1_inclusion_bound"])
    floor = max(vo.floor_of(d["closes_at"], clock), seg_k)
    # s_A = period(t_S + AUTHOR_OPENING_WINDOW), t_S the end of period s_S plus
    # the deadline, so with s_S at its floor s_A is at least this.
    s_a = floor + 1 + (DEADLINE + AUTHOR_OPENING_WINDOW) // PERIOD
    timely, late, after = floor + 1, s_a + 20, s_a + 21
    # s_T's floor (Windows and destruction (version 2)): the sealed board
    # reaches past it, so a statement there is anchored.
    s_t = floor + 1 + (DEADLINE + TALLY_WINDOW) // PERIOD
    clock["lastSegment"] = max(after, s_t) + 1
    assert seg_d < floor

    def board(segments):
        out = []
        for seg, payloads in segments:
            for p in payloads:
                out.append(vc.entry(BOARD_VERSION, eid, len(out), seg, p))
        return out

    def tally_report(low, openings, opening_at):
        """7.4 under tally-opening version 3, with the counted set known (verifier.md, Tally openings; tally.md, Boarding (version 3)): each opening's breaks in the boarding rule's order, and the row at the first opening with a code or a break."""
        failing = {f["at"]: f for c in low["cells"] for p in (DEFAULT, AUTHOR) for f in c["default" if p == DEFAULT else "author"]["failing"]}
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

    def statement(p, signer, signed_by=None, definition=None, version=2):
        """A destruction statement by seat (p, signer), signed with `signed_by`'s secret (the seat's own by default); version 1 has no panel."""
        dh = defh if definition is None else definition
        msg = pt.destruction_message(dh, p, signer) if version == 2 else pt.header(DESTRUCTION_TYPE, 1) + dh + pt.u8(signer)
        return msg + pt.sign(pt.DESTRUCTION_TAG, secrets[signed_by or (p, signer)], msg)

    tiers = [c["tier"] for c in e["cells"]]
    cases = []

    def case(id_, description, segments):
        if version == 7 and not description.startswith("Definition version 7"):
            description = "Definition version 7 under a fixed electorate. " + description
        entries = board(segments)
        ceremony_rows, _ = vc.expected(panel, d, entries, panel, BOARD_VERSION)
        assert ceremony_rows["3.2"] == outcome("pass"), id_
        payloads = [p for _, ps in segments for p in ps]
        segment_of = [seg for seg, ps in segments for _ in ps]
        seats = vba.approving(d, author, run["hash"], run["keySetHash"], [p for p in payloads if int.from_bytes(p[:2], "big") == vba.ac.APPROVALS_TYPE])
        assert seats == [1, 2], id_
        at_ballot, delivery, openings, opening_at = [], [], [], []
        for i, p in enumerate(payloads):
            if p in recs:
                at_ballot.append(i)
            elif int.from_bytes(p[:2], "big") == RECEIPT_TYPE and segment_of[i] <= floor:
                delivery.append(("board", segment_of[i], p))
            elif int.from_bytes(p[:2], "big") == TALLY_OPENING_TYPE:
                openings.append((segment_of[i], p))
                opening_at.append(i)
        assert len(at_ballot) == len(ballots), id_
        delivered = dv2.check_delivery(defh, registered, seg_d, seg_k, t_d_, t_k_, ballots, delivery)
        cells = [[] for _ in e["cells"]]
        for b, verdict in zip(ballots, delivered["ballots"]):
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
        # Coarser totals: a tier's counts are its cells' sums, only where every
        # cell of the tier passed.
        tier_report = []
        for t in dict.fromkeys(tiers):
            members = [r for r in report if r["tier"] == t]
            r = {"tier": t, "counted": sum(x["counted"] for x in members)}
            if all("counts" in x for x in members):
                r["counts"] = [str(sum(int(x["counts"][j]) for x in members)) for j in range(m)]
            tier_report.append(r)
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
                "counted": [at_ballot[i] for i, v in enumerate(delivered["ballots"]) if v["counted"]],
                "cells": report,
                "tiers": tier_report,
                "tallies": tallies,
                "destruction": destruction,
            }
        )
        return cases[-1]

    b0, b1, b2 = ballots
    head = (0, [t_a, t_d, approved] + recs)
    receipts = (3, every(b0) + every(b1) + every(b2))
    by_cell = [[b0], [b1], [b2]]

    def authors(skip=(), at=None):
        """Author seat 1's partial opening of each cell, at `timely` unless `at` moves it."""
        at = at or {}
        return [(at.get(c, timely), opening(c, AUTHOR, by_cell[c], 1)) for c in range(3) if c not in skip]

    def defaults(skip=(), change=None):
        """Default seat 2's partial opening of each cell, at `timely` + 1; `change` alters cell 0's."""
        return [(timely + 1, opening(c, DEFAULT, by_cell[c], 2, change=change if c == 0 else None)) for c in range(3) if c not in skip]

    def segments(*openings):
        rows = {}
        for seg, p in (x for xs in openings for x in xs):
            rows.setdefault(seg, []).append(p)
        return [head, receipts] + sorted(rows.items())

    version_1 = bytearray(opening(0, AUTHOR, [b0], 2))
    version_1[2] = 1
    counted = case(
        "counted",
        "Every registered seat of both panels receipts each ballot, so each cell counts its one ballot. Author seat 1's partial opening of every cell is boarded at the floor of s_S plus one, then default seat 2's; default seat 3's partial opening of cell 1 matches seat 2's, an author partial opening of cell 0 signed with default seat 1's key is unattributed and still counts, an opening naming panel 3 is stray and a version-1 header is a rejected entry. Every cell passes, its count the sum of both panels' partial openings, and each tier's counts are its cells' sums.",
        segments(
            authors(),
            defaults(),
            [
                (timely + 1, opening(1, DEFAULT, [b1], 3)),
                (timely, opening(0, AUTHOR, [b0], 1, signed_by=(DEFAULT, 1))),
                (timely, opening(2, AUTHOR, [b2], 2, panel_byte=3)),
                (timely, bytes(version_1)),
            ],
        ),
    )
    assert counted["expected"]["7.2"] == outcome("pass")
    assert [c["counts"] for c in counted["cells"]] == [[str(v) for v in b["votes"]] for b in ballots]
    assert [(c["signers"], c["authorSigners"]) for c in counted["cells"]] == [([2], [1]), ([2, 3], [1]), ([2], [1])]

    case(
        "author-missing",
        "No author partial opening of cell 1: it fails tally-missing for the author panel, checked first, though default seat 2 opened its half; cells 0 and 2 pass.",
        segments(authors(skip=(1,)), defaults()),
    )
    case(
        "author-late",
        "No author partial opening of cell 2 at all, and no default partial opening of cell 0: some cell's author opening is late whatever s_A is, so cell 0, the first failing cell, fails tally-author-late, the author panel's or the operator's, never the default panel's; cell 2 fails tally-missing for the author panel.",
        segments(authors(skip=(2,)), defaults(skip=(0,))),
    )
    undecided = case(
        "author-late-undecided",
        f"Every cell's author partial opening is on the board, but cell 2's only in segment {late}, past s_A's floor {s_a}, and cell 0 has no default partial opening: cell 0 is tally-author-late if s_A is below {late} and the default panel's tally-missing otherwise, and only s_S, which this bundle doesn't fix, decides which; cell 0 and 7.2 are undecided, never a code that may name the wrong panel.",
        segments(authors(at={2: late}), defaults(skip=(0,))),
    )
    assert undecided["expected"]["7.2"]["status"] == "unverifiable" and "code" not in undecided["cells"][0]
    # The floor's edges: an author partial opening at s_A's floor is in time
    # whatever s_S is, one a period above it may not be.
    edge = case(
        "author-at-floor",
        f"As author-late-undecided, but cell 2's author partial opening is boarded in segment {s_a}, s_A's floor: in time whatever s_S is, so cell 0's missing default partial opening is the default panel's tally-missing (the default panel's or the operator's).",
        segments(authors(at={2: s_a}), defaults(skip=(0,))),
    )
    assert edge["expected"]["7.2"] == outcome("fail", "tally-missing", {"cell": 0, "panel": DEFAULT})
    past = case(
        "author-past-floor",
        f"As author-at-floor, but cell 2's author partial opening is boarded in segment {s_a + 1}, one above s_A's floor: late if s_S is at its floor and in time otherwise, so cell 0 and 7.2 are undecided.",
        segments(authors(at={2: s_a + 1}), defaults(skip=(0,))),
    )
    assert past["expected"]["7.2"] == outcome("unverifiable", "not-implemented", {"cell": 0})
    case(
        "default-missing",
        "Every author partial opening is timely, at or below s_A's floor, and cell 1 has no default partial opening: it fails tally-missing for the default panel (the default panel's or the operator's).",
        segments(authors(), defaults(skip=(1,))),
    )
    case(
        "default-opening",
        "Default seat 2's partial opening of cell 0 is off by one at option 0 and is the cell's only default one: it fails tally-opening for the default panel at option 0, whatever the author did.",
        segments(authors(), defaults(change=lambda o: pt.bump(o, 0))),
    )
    excluded = case(
        "excluded",
        "Author seat 2 never receipts the cell-1 ballot, so delivery excludes it and cell 1 counts nothing, while both panels' partial openings of cell 1 are over that ballot: neither panel's aggregate hash is cell 1's over its counted set, so it fails tally-opening for the author panel, checked first, with no option; cells 0 and 2 pass.",
        [head, (3, every(b0) + every(b1, skip=[(AUTHOR, 2)]) + every(b2))] + segments(authors(), defaults())[2:],
    )
    assert excluded["counted"] == [3, 5] and excluded["cells"][1]["counted"] == 0
    for c in cases:
        assert c["expected"]["8.5"] == outcome("fail", "destruction-missing", {"panel": DEFAULT, "seat": 1}), c["id"]

    boarding = case(
        "boarding",
        "Default seat 2's partial opening of cell 0 is boarded before any author one (tally-early, the operator's, and it still counts); author seat 1's partial opening of cell 1 is boarded twice, byte for byte (tally-repeat, the operator's alone), and its second of cell 2 is over an empty set (tally-aggregate, and tally-second: evidence against the seat); author seat 2's partial opening of cell 0 is no second of default seat 2's, whose index it shares, since each is attributed by its own panel's key set. Every cell passes; 7.4 fails at the first break, tally-early.",
        segments(
            [(timely, opening(0, DEFAULT, [b0], 2))],
            authors(),
            [
                (timely, opening(1, AUTHOR, [b1], 1)),
                (timely, opening(2, AUTHOR, [], 1)),
                (timely, opening(0, AUTHOR, [b0], 2)),
            ],
            defaults(skip=(0,)),
        ),
    )
    assert boarding["expected"]["7.2"] == outcome("pass")
    first_opening = boarding["tallies"][0]["entry"]
    assert boarding["expected"]["7.4"] == outcome("fail", "tally-early", {"entry": first_opening})
    assert [[b["code"] for b in o["breaks"]] for o in boarding["tallies"]] == [["tally-early"], [], [], [], ["tally-repeat"], ["tally-aggregate", "tally-second"], [], [], []]

    # Every cell's first passing partial openings are by timely + 1 for both
    # panels, so the destruction segment is timely + 2 (s_O + 1).
    s_o1 = timely + 2
    honest_openings = (authors(), defaults())
    seats = [(p, i) for p in (DEFAULT, AUTHOR) for i in sorted(registered[p])]
    destroyed = case(
        "destroyed",
        f"As counted without the strays, and every registered seat of both panels states destruction (version 2) in segment {s_o1}, once every cell has both panels' partial openings: each is destroyed, and 8.5 passes.",
        segments(*honest_openings, [(s_o1, statement(p, i)) for p, i in seats]),
    )
    assert destroyed["expected"]["7.4"] == outcome("pass") and destroyed["expected"]["8.5"] == outcome("pass")
    assert destroyed["destruction"]["earliest"] == destroyed["destruction"]["latest"] == s_o1
    mixed = case(
        "destruction-mixed",
        f"Default seat 1 states destruction in segment {s_o1} (destroyed) and default seat 2 in segment {timely}, before the last cell's default partial opening (destruction-early, the seat's); author seat 1 twice (the second a duplicate); a statement for author seat 2 signed with default seat 2's key and one for default seat 2 signed with author seat 2's (each unattributed: a statement is attributed only by the key set of the panel it names); default seat 3's for another definition (stray, attributed to it) and a version-1 statement (rejected). Default seat 3 and author seat 2 are destruction-missing; 8.5 fails at the first seat that isn't destroyed, default seat 2.",
        segments(
            *honest_openings,
            [
                (s_o1, statement(DEFAULT, 1)),
                (timely, statement(DEFAULT, 2)),
                (s_o1, statement(AUTHOR, 1)),
                (s_o1 + 1, statement(AUTHOR, 1)),
                (s_o1, statement(AUTHOR, 2, signed_by=(DEFAULT, 2))),
                (s_o1, statement(DEFAULT, 2, signed_by=(AUTHOR, 2))),
                (s_o1, statement(DEFAULT, 3, definition=bytes(32))),
                (s_o1, statement(AUTHOR, 2, version=1)),
            ],
        ),
    )
    assert mixed["expected"]["8.5"] == outcome("fail", "destruction-early", {"panel": DEFAULT, "seat": 2})
    got = mixed["destruction"]
    assert [x.get("code") for x in got["seats"]] == ["destroyed", "destruction-early", "destruction-missing", "destroyed", "destruction-missing"], got
    assert (len(got["duplicates"]), len(got["unattributed"]), len(got["stray"]), len(got["rejected"])) == (1, 2, 1, 1), got
    assert got["stray"][0]["signer"] == 3 and got["rejected"][0]["decodeError"] == "profile-mismatch", got
    undecided_d = case(
        "destruction-undecided",
        f"As author-missing (cell 1 never has an author partial opening, so the destruction segment is s_T, known only from below, at least {s_t}): default seat 1's statement in segment {s_o1} is early whatever s_T is, and every other seat's in segment {s_t} is undecided, since s_T may lie above it; 8.5 is unverifiable at the first undecided seat, default seat 2.",
        segments(
            authors(skip=(1,)),
            defaults(),
            [(s_o1 if (p, i) == (DEFAULT, 1) else s_t, statement(p, i)) for p, i in seats],
        ),
    )
    assert undecided_d["expected"]["8.5"] == outcome("unverifiable", "not-implemented", {"panel": DEFAULT, "seat": 2})
    assert undecided_d["destruction"]["earliest"] == s_t and "latest" not in undecided_d["destruction"]

    if version == 7:
        # The same election read as version 6 (verifier-ballots-v4-vectors.py,
        # v6_reading) is another election: a partial opening or a destruction
        # statement made for that reading's hash names another definition, so
        # it is stray, attributed but never counted (T-14, T-29, T-37).
        v6_hash = vb4.H(vb4.ds(vb4.DEFINITION_TAG, vc.encode(vb4.v6_reading(d))))
        assert v6_hash != defh
        reading = case(
            "v6-reading",
            "Definition version 7 under a fixed electorate, beside the author panel: as counted without the strays, but both panels' partial openings of cell 0 are made for the same election read as version 6 (that reading's hash), each a tally-stray attributed to its seat. Cell 0 has no partial opening of its own, so it fails tally-missing for the author panel, checked first; cells 1 and 2 pass. Their default partial openings are tally-early, as cell 0 never has a passing author one, and 7.4 fails at the first stray.",
            segments(
                [(timely, opening(0, AUTHOR, [b0], 1, definition_hash=v6_hash))],
                authors(skip=(0,)),
                [(timely + 1, opening(0, DEFAULT, [b0], 2, definition_hash=v6_hash))],
                defaults(skip=(0,)),
            ),
        )
        assert reading["expected"]["7.2"] == outcome("fail", "tally-missing", {"cell": 0, "panel": AUTHOR})
        assert reading["expected"]["7.4"] == outcome("fail", "tally-stray", {"entry": reading["tallies"][0]["entry"]})
        got = [(o.get("cell"), o["panel"], o["signer"], [b["code"] for b in o["breaks"]]) for o in reading["tallies"]]
        assert got == [(None, AUTHOR, 1, ["tally-stray"]), (1, AUTHOR, 1, []), (2, AUTHOR, 1, []), (None, DEFAULT, 2, ["tally-stray"]), (1, DEFAULT, 2, ["tally-early"]), (2, DEFAULT, 2, ["tally-early"])], got
        assert [("counts" in c) for c in reading["cells"]] == [False, True, True]
        statements_v6 = case(
            "v6-reading-destruction",
            f"Definition version 7 under a fixed electorate, beside the author panel: as destroyed, but every registered seat of both panels states destruction in segment {s_o1} for the same election read as version 6 (that reading's hash): each statement is stray, attributed to its seat, so every seat is destruction-missing and 8.5 fails at default seat 1; every cell passes.",
            segments(*honest_openings, [(s_o1, statement(p, i, definition=v6_hash)) for p, i in seats]),
        )
        assert statements_v6["expected"]["7.2"] == outcome("pass") and statements_v6["expected"]["7.4"] == outcome("pass")
        got = statements_v6["destruction"]
        assert [x.get("code") for x in got["seats"]] == ["destruction-missing"] * len(seats), got
        assert [(x["panel"], x["signer"]) for x in got["stray"]] == seats, got

    doc = {
        "format": "abolish-verifier-tally-vectors/1",
        "title": f"The verifier's tally beside an author panel (definition version {'6' if version == 6 else '7 with a fixed electorate'}, ballot version 4, tally-opening version 3, destruction statement version 2): definitions, clocks, boards carrying both panels' transcripts, the author approvals, ballots, share receipts, partial openings and destruction statements, and the pinned default panel, with the rows 5.9, 6.3, 7.1 to 7.4 and 8.5, the counted ballots' entries and the report's cells, tiers, tallies and destruction",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-tally-v3-author-vectors.py, from verifier-ballots-v4-author-vectors.py, "
            "ballot-v4-vectors.py, tally-vectors.py, panel-tally-vectors.py, verifier-ceremony-vectors.py, ceremony-vectors.py, "
            "delivery-vectors.py, delivery-v2-vectors.py, intake-v4-vectors.py and verifier-openings-vectors.py (independent "
            "Python implementations); membership proofs by packages/crypto/scripts/ballot-proofs.mjs, run outside the workspace "
            "with Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5"
        ),
        "panel": {"threshold": str(panel["k"]), "keys": [k.hex() for k in panel["keys"]]},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-tally-v3-author.json" if version == 6 else "verifier-tally-v3-author-definition-v7.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    version = 7 if sys.argv[-1] == "7" else 6
    args = sys.argv[2:-1] if version == 7 else sys.argv[2:]
    if cmd == "statements" and len(args) == 2:
        statements(*args, version)
    elif cmd == "assemble" and len(args) == 3:
        assemble(*args, version)
    else:
        raise SystemExit("usage: verifier-tally-v3-author-vectors.py statements <constants> <out> [7] | assemble <constants> <proofs> <out-dir> [7]")


if __name__ == "__main__":
    main()
