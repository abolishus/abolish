#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-tally-v3-author.json.

Elections for the verifier's tally beside an author panel (docs/spec/
verifier.md, Counted set and tally, steps 4 and 5; 7.1 to 7.3; tally.md,
Author panel, Opening checks (version 3)): verifier-ballots-v4-author.json's
"author-mixed" election under a profile that pins tally-opening version 3,
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
of `s_A`, so where the two readings differ the cell isn't decided. Each case
is a definition, a clock, a board copy and the default panel a bundle pins,
with the rows 5.9, 6.3, 7.1 to 7.3 and 8.5 a verifier reports, the counted
ballots' entries and the report's `cells` and `tiers`.

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

  python3 -I -B verifier-tally-v3-author-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B verifier-tally-v3-author-vectors.py assemble <constants> <work>/proofs.json <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json
and ballot-proofs.mjs runs outside the workspace (see its header). Every value
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


def pins():
    """verifier-ballots-v4-author-vectors.py's profile with tally-opening version 3, the one an author panel pins (tally.md, Author panel)."""
    p = vba.base_pins()
    return dict(p, pins=[(t, 3 if t == TALLY_OPENING_TYPE else v) for t, v in p["pins"]])


vba.base_pins = vba.pins
vba.pins = pins


def build(constants):
    """The "author-mixed" election under this profile: its definition, runs, approvals and the three admitted ballots, with the proofs they need."""
    s = vba.build(constants)
    src = next(b for b in s["bundles"] if b["id"] == "author-mixed")
    d = src["definition"]
    assert dict(d["profile"]["pins"])[TALLY_OPENING_TYPE] == 3
    ballots = [p for p in src["board"][3:6]]
    pids = [pid for _, pid in ballots]
    assert pids == [f"author/{label}" for label, _, _ in BALLOTS], pids
    checks = [c for c in s["checks"] if c["case"] in (f"author-mixed/{i}" for i in (3, 4, 5))]
    assert len(checks) == 3
    return s, src, ballots, checks


def statements(constants, out):
    s, _, ballots, checks = build(constants)
    proofs = [s["proofs"][pid] for _, pid in ballots]
    pathlib.Path(out).write_text(json.dumps({"proofs": proofs, "checks": checks}, indent=2) + "\n")


def assemble(constants, proofs_path, out_dir):
    s, src, proved, _ = build(constants)
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

    def opening(cell, p, counted, signer, signed_by=None, panel_byte=None, change=None):
        """A version-3 tally opening of `cell` for panel `p` over `counted`, by `signer`, signed with `signed_by`'s secret (the signer's own by default)."""
        agg = tv.aggregate(m, thresholds[p], [b["vote"]["vss" if p == DEFAULT else "authorVss"] for b in counted])
        o = {
            "definitionHash": defh,
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
    clock["lastSegment"] = after + 1
    assert seg_d < floor

    def board(segments):
        out = []
        for seg, payloads in segments:
            for p in payloads:
                out.append(vc.entry(BOARD_VERSION, eid, len(out), seg, p))
        return out

    tiers = [c["tier"] for c in e["cells"]]
    cases = []

    def case(id_, description, segments):
        entries = board(segments)
        ceremony_rows, _ = vc.expected(panel, d, entries, panel, BOARD_VERSION)
        assert ceremony_rows["3.2"] == outcome("pass"), id_
        payloads = [p for _, ps in segments for p in ps]
        segment_of = [seg for seg, ps in segments for _ in ps]
        seats = vba.approving(d, author, run["hash"], run["keySetHash"], [p for p in payloads if int.from_bytes(p[:2], "big") == vba.ac.APPROVALS_TYPE])
        assert seats == [1, 2], id_
        at_ballot, delivery, openings = [], [], []
        for i, p in enumerate(payloads):
            if p in recs:
                at_ballot.append(i)
            elif int.from_bytes(p[:2], "big") == RECEIPT_TYPE and segment_of[i] <= floor:
                delivery.append(("board", segment_of[i], p))
            elif int.from_bytes(p[:2], "big") == TALLY_OPENING_TYPE:
                openings.append((segment_of[i], p))
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
                # 6.3 needs the run of L1 headers these copies don't carry;
                # destruction per panel (8.5) is P2-16 part 4d-3d-2's.
                "expected": {
                    "5.9": outcome("pass"),
                    "6.3": NOT_REACHED,
                    "7.1": outcome("pass"),
                    "7.2": row,
                    "7.3": outcome("pass"),
                    "8.5": NOT_REACHED,
                },
                "counted": [at_ballot[i] for i, v in enumerate(delivered["ballots"]) if v["counted"]],
                "cells": report,
                "tiers": tier_report,
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

    doc = {
        "format": "abolish-verifier-tally-vectors/1",
        "title": "The verifier's tally beside an author panel (definition version 6, ballot version 4, tally-opening version 3): definitions, clocks, boards carrying both panels' transcripts, the author approvals, ballots, share receipts and partial openings, and the pinned default panel, with the rows 5.9, 6.3, 7.1 to 7.3 and 8.5, the counted ballots' entries and the report's cells and tiers",
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
    path = pathlib.Path(out_dir, "verifier-tally-v3-author.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: verifier-tally-v3-author-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
