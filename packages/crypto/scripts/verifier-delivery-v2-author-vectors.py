#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-delivery-v2-author.json.

Elections for the verifier's delivery check beside an author panel
(docs/spec/verifier.md, Key ceremony, step 5, and Counted set and tally;
5.9; delivery.md, Delivery check (version 2)): a version-6 definition, or,
for docs/spec/vectors/verifier-delivery-v2-author-definition-v7.json, the
same election under definition version 7 with a fixed electorate, which the
verifier reads as version 6 under version 7's own hashes and stubs
(docs/spec/verifier.md, Definition), with a 2-of-3 author panel whose seat 3
sent nothing, beside the 3-of-4 default panel whose seat 4 sent nothing, its board carrying both runs' transcripts,
the author approvals record, three admitted ballots and version-2 share
receipts. A ballot is delivered only once every registered seat of both
panels has receipted it, each receipt checked against its own panel's
share hash and its own run's signing key, and an author seat is registered
only by the author panel's own run, approved on the board, never by the
ballot, a receipt or the default panel (T-37, T-17, T-25). Each case is a
definition, a clock, a board copy and the default panel a bundle pins, with
the rows 5.9, 6.3, 7.1 to 7.3 and 8.5 a verifier reports and the report's
`delivery`; its profile pins tally-opening version 1, which can't open an
author panel's halves, so the tally rows are unsupported here, and
verifier-tally-v3-author-vectors.py judges the tally under version 3.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier:
verifier-ballots-v4-author-vectors.py (the election, both runs, the
approvals record and the ballots, rebuilt from their labels),
verifier-ceremony-vectors.py and ceremony-vectors.py (board entries, both
runs' checks, which give the registered seats' signing keys, and the seats'
secrets from the runs' labels), delivery-vectors.py (the windows),
delivery-v2-vectors.py (the version-2 receipt record and the delivery check
over both panels), intake-v4-vectors.py (the version-4 receipt statement and
its RFC 6979 P-256 ECDSA signature) and verifier-openings-vectors.py (the
floor of `s_S`, `period(closes_at) + 1`).

The ballots' membership proofs are randomised, so their records are read
from the committed verifier-ballots-v4-author.json (its "author-mixed" case),
or verifier-ballots-v4-author-definition-v7.json for version 7, and checked
against the ballots rebuilt here; nothing else needs a prover. Every other
value comes from fixed labels (test data, never keys).

Usage: python3 -I -B verifier-delivery-v2-author-vectors.py <constants> <out-dir> [7],
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
dv2 = _load("delivery_v2_vectors", "delivery-v2-vectors.py")
vo = _load("verifier_openings_vectors", "verifier-openings-vectors.py")
vc, cv, vb4 = vba.vc, vba.cv, vba.vb4
dv, iv4, b4 = dv2.dv, dv2.iv4, dv2.b4
DEFAULT, AUTHOR = dv2.DEFAULT, dv2.AUTHOR
BOARD_VERSION = vba.BOARD_VERSION
PERIOD = 3600
outcome, NOT_REACHED = vc.outcome, vc.NOT_REACHED
RECEIPT_TYPE = int.from_bytes(dv2.header(dv2.RECEIPT)[:2], "big")
TALLY_OPENING_TYPE = 0x0006


def main(constants, out_dir, version=6):
    s = vba.build(constants, version)
    src = next(b for b in s["bundles"] if b["id"] == "author-mixed")
    d, run = src["definition"], src["run"]
    panel, author = s["panel"], s["author"]
    eid = d["election_id"]
    t_a, t_d, approved = src["board"][:3]
    assert t_a == run["transcript"] and run["registered"] == [1, 2]
    assert vc.own_version(d) == version

    source = "verifier-ballots-v4-author.json" if version == 6 else "verifier-ballots-v4-author-definition-v7.json"
    committed = next(c for c in json.loads((VECTORS / source).read_text())["cases"] if c["id"] == "author-mixed")
    records = [vc.decode_entry(x, BOARD_VERSION)["payload"] for x in vo.split(bytes.fromhex(committed["board"]))]
    assert records[:3] == [t_a, t_d, approved]
    # The ballots in cells 0, 1 and 2 (entries 3 to 5 there), all admitted:
    # distinct nullifiers, each in its own cell.
    ballots = [p[0] for p in src["board"][3:6]]
    recs = records[3:6]
    for rec, b in zip(recs, ballots):
        assert b["committedVote"] in rec, "the committed record carries this ballot's committed vote"
    assert [b["cell"] for b in ballots] == [0, 1, 2]
    for b in ballots:
        b["ctx"] = {"definitionHash": b["definitionHash"], "cell": b["cell"], "nullifier": b["nullifier"]}
        b["hash"] = b4.ballot_hash(b["ctx"], b["vote"])
    defh = ballots[0]["definitionHash"]
    assert defh == vb4.H(vb4.ds(vb4.DEFINITION_TAG, vc.encode(d)))

    # Both panels' registered seats, from their own runs: the default run over
    # the default stub, the author run over the author stub; each seat's
    # signing secret from its run's label (ceremony-vectors.py, seat_secrets).
    own = vc.cv.check(dict(panel, otherKeys=list(author["keys"])), t_d, vc.election_of(d))
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
    # Author seat 3 isn't registered, but its seat secret is still a label's.
    unregistered = cv.seat_secrets(labels[AUTHOR], 3)["signing"]

    def own_hash(b, p, seat):
        hashes = b["vote"]["shareHashes"] if p == DEFAULT else b["vote"]["authorShareHashes"]
        return hashes[seat - 1]

    def receipt(b, p, seat, signer=None, share_hash=None, definition_hash=defh):
        """Seat `seat` of panel `p`'s version-2 receipt for `b`, signed by `signer`'s key (the seat's own by default)."""
        sh = share_hash if share_hash is not None else own_hash(b, p, seat)
        d_ = signer if signer is not None else secrets[(p, seat)]
        m = iv4.statement(definition_hash, b["hash"], p, seat, sh)
        return dv2.receipt_record(definition_hash, b["hash"], p, seat, sh, iv4.sign(d_, m))

    def every(b, skip=(), definition_hash=defh):
        return [receipt(b, p, seat, definition_hash=definition_hash) for p in (DEFAULT, AUTHOR) for seat in sorted(registered[p]) if (p, seat) not in skip]

    end = d["closes_at"] + d["l1_inclusion_bound"]
    clock = {"epoch": d["closes_at"] - 2 * PERIOD, "period": PERIOD, "deadline": 7200}
    seg_d, seg_k = dv.segments(clock["epoch"], PERIOD, d["closes_at"], d["l1_inclusion_bound"])
    t_d_, t_k_ = dv.deadlines(d["closes_at"], d["l1_inclusion_bound"])
    floor = max(vo.floor_of(d["closes_at"], clock), seg_k)
    clock["lastSegment"] = floor + 2
    assert end >= clock["epoch"] and seg_d < floor

    def board(segments):
        out = []
        for seg, payloads in segments:
            for p in payloads:
                out.append(vc.entry(BOARD_VERSION, eid, len(out), seg, p))
        return out

    runs = [t_a, t_d]
    cases = []

    def case(id_, description, segments, approvals=True):
        if version == 7:
            description = description.replace("Definition version 6", "Definition version 7 under a fixed electorate")
        entries = board(segments)
        ceremony_rows, _ = vc.expected(panel, d, entries, panel, BOARD_VERSION)
        assert ceremony_rows["3.2"] == outcome("pass"), id_
        payloads = [p for _, ps in segments for p in ps]
        seats = vba.approving(d, author, run["hash"], run["keySetHash"], [p for p in payloads if int.from_bytes(p[:2], "big") == vba.ac.APPROVALS_TYPE])
        assert (seats == [1, 2]) == approvals, id_
        rows = {r: NOT_REACHED for r in ("5.9", "6.3", "7.1", "7.2", "7.3", "8.5")}
        c = {
            "id": id_,
            "description": description,
            "definition": vc.encode(d).hex(),
            "clock": {k: str(v) for k, v in clock.items()},
            "board": b"".join(entries).hex(),
        }
        if approvals:
            # The board's ballots at the entries they hold, then its delivery
            # records in board order, at or below the floor (verifier.md,
            # Counted set and tally, step 3), each with its own segment.
            at_ballot, delivery, at_record = [], [], []
            segment_of = [seg for seg, ps in segments for _ in ps]
            for i, p in enumerate(payloads):
                if p in recs:
                    at_ballot.append(i)
                elif int.from_bytes(p[:2], "big") == RECEIPT_TYPE and segment_of[i] <= floor:
                    delivery.append(("board", segment_of[i], p))
                    at_record.append(i)
            assert len(at_ballot) == len(ballots), id_
            result = dv2.check_delivery(defh, registered, seg_d, seg_k, t_d_, t_k_, ballots, delivery)
            # 5.9 has no failure of its own. The close check needs the run of
            # L1 headers these copies don't carry, and this profile pins
            # tally-opening version 1, whose openings open one sharing, never
            # an author panel's two halves, so the tally and the destruction
            # statement it fixes are unsupported (verifier.md, Counted set
            # and tally, step 5; verifier-tally-v3-author-vectors.py has the
            # tally under version 3).
            assert dict(d["profile"]["pins"])[TALLY_OPENING_TYPE] == 1
            rows["5.9"] = outcome("pass")
            for r in ("7.1", "7.2", "7.3", "8.5"):
                rows[r] = outcome("unverifiable", "unsupported-version")
            c["delivery"] = {
                "excluded": [
                    {
                        "entry": at_ballot[i],
                        "missing": b["missing"],
                        "complaints": [{"entry": at_record[x["at"]], "panel": x["panel"], "seat": x["seat"], "signer": x["signer"]} for x in b["excludedBy"]],
                    }
                    for i, b in enumerate(result["ballots"])
                    if not b["counted"]
                ],
                "records": [dict({"entry": at_record[r["at"]], "code": r["code"], "panel": r["panel"], "seat": r["seat"]}, **({"signer": r["signer"]} if "signer" in r else {})) for r in result["records"]],
                "rejected": [{"entry": at_record[r["at"]], "decodeError": r["error"]} for r in result["rejected"]],
            }
            c["counted"] = [at_ballot[i] for i, b in enumerate(result["ballots"]) if b["counted"]]
        c["expected"] = rows
        cases.append(c)
        return c

    b0, b1, b2 = ballots
    head = (0, runs + [approved] + recs)
    other = vb4.det("verifier-delivery-v2-author other definition")
    delivered = case(
        "delivered",
        "Every registered seat of both panels (default seats 1 to 3, author seats 1 and 2) receipts each of the three ballots in segment 3, so every ballot is delivered and counted. Beside them in segment 3: a receipt from author seat 3, which isn't registered (delivery-seat, panel 2); author seat 1's receipt for the cell-0 ballot signed with default seat 1's key (share-receipt, no signer); default seat 1's receipt carrying author seat 1's share hash, signed by default seat 1 (share-receipt with signer 1: a receipt is checked against its own panel's share hash); and an author seat 2 receipt naming another definition (delivery-stray).",
        [
            head,
            (
                3,
                every(b0)
                + every(b1)
                + every(b2)
                + [
                    receipt(b0, AUTHOR, 3, signer=unregistered, share_hash=vb4.det("verifier-delivery-v2-author unregistered")),
                    receipt(b0, AUTHOR, 1, signer=secrets[(DEFAULT, 1)]),
                    receipt(b0, DEFAULT, 1, share_hash=own_hash(b0, AUTHOR, 1)),
                    receipt(b0, AUTHOR, 2, definition_hash=other),
                ],
            ),
        ],
    )
    assert delivered["delivery"]["excluded"] == [] and len(delivered["counted"]) == 3
    assert [(r["code"], r["panel"], r["seat"], r.get("signer", "-")) for r in delivered["delivery"]["records"]] == [
        ("delivery-seat", AUTHOR, 3, "-"),
        ("share-receipt", AUTHOR, 1, None),
        ("share-receipt", DEFAULT, 1, 1),
        ("delivery-stray", AUTHOR, 2, "-"),
    ], delivered["delivery"]["records"]

    missing = case(
        "author-seats-missing",
        f"Every default seat receipts each ballot in segment 3, but the author panel's seats don't all: author seat 2 never receipts the cell-1 ballot, and author seat 1's receipt for the tier-2 ballot is boarded in segment {seg_d + 1}, after the delivery window's last segment s_D = {seg_d} but at or below the floor (delivery-late). Neither ballot is delivered, so neither is counted, each missing its author seat; the cell-0 ballot is. A ballot opens only with both panels' thresholds, so the default panel's receipts alone never deliver one (T-37, T-54).",
        [
            head,
            (3, every(b0) + every(b1, skip=[(AUTHOR, 2)]) + every(b2, skip=[(AUTHOR, 1)])),
            (seg_d + 1, [receipt(b2, AUTHOR, 1)]),
        ],
    )
    assert [(x["entry"], x["missing"]) for x in missing["delivery"]["excluded"]] == [
        (4, [{"panel": AUTHOR, "seat": 2}]),
        (5, [{"panel": AUTHOR, "seat": 1}]),
    ], missing["delivery"]["excluded"]
    assert [r["code"] for r in missing["delivery"]["records"]] == ["delivery-late"]

    default_only = case(
        "default-only",
        "Only the default panel's seats receipt, every ballot in segment 3: each ballot misses author seats 1 and 2, so none is counted.",
        [head, (3, [r for b in ballots for r in every(b, skip=[(AUTHOR, 1), (AUTHOR, 2)])])],
    )
    assert default_only["counted"] == [] and all(x["missing"] == [{"panel": AUTHOR, "seat": 1}, {"panel": AUTHOR, "seat": 2}] for x in default_only["delivery"]["excluded"])

    lost = case(
        "default-seat-missing",
        "Every author seat receipts each ballot in segment 3, but default seat 3 never receipts the cell-0 ballot: that ballot misses it and isn't counted, as without an author panel, while the others are.",
        [head, (3, every(b0, skip=[(DEFAULT, 3)]) + every(b1) + every(b2))],
    )
    assert [(x["entry"], x["missing"]) for x in lost["delivery"]["excluded"]] == [(3, [{"panel": DEFAULT, "seat": 3}])]
    short = vba.ac.enc_record(run["hash"], [vba.approval(d, author, 1, run["hash"], run["keySetHash"])])
    case(
        "approvals-short",
        "The delivered case's receipts with only author seat 1's approval, short of q_A = 2: the author panel's key set isn't approved, so nothing is decided; 5.9 and every row after it are not reached.",
        [(0, runs + [short] + recs), (3, every(b0) + every(b1) + every(b2))],
        approvals=False,
    )
    case(
        "approvals-missing",
        "The delivered case's receipts with no approvals record on the copy: the author panel's key set isn't approved, so no ballot is admitted and nothing is decided; 5.9 and every row after it are not reached.",
        [(0, runs + recs), (3, every(b0) + every(b1) + every(b2))],
        approvals=False,
    )

    if version == 7:
        # Every seat of both panels receipts the cell-0 ballot as made for
        # the same election read as version 6: its receipts bind that
        # reading's hash, another election's, in the statement and in the
        # ballot hash they name, so none counts for the ballot boarded here,
        # which isn't delivered (T-12, T-34, T-37).
        v6_hash = vb4.H(vb4.ds(vb4.DEFINITION_TAG, vc.encode(vb4.v6_reading(d))))
        assert v6_hash != defh
        ctx6 = dict(b0["ctx"], definitionHash=v6_hash)
        b6 = dict(b0, ctx=ctx6, hash=b4.ballot_hash(ctx6, b0["vote"]))
        c = case(
            "v6-reading",
            "Definition version 7 under a fixed electorate, beside the author panel: every registered seat of both panels receipts the cell-1 and tier-2 ballots in segment 3, but its receipts for the cell-0 ballot are made for the same election read as version 6 (that reading's hash in each statement and in the ballot hash it names): each is delivery-stray, so the cell-0 ballot misses every seat of both panels and isn't counted; the others are.",
            [head, (3, every(b6, definition_hash=v6_hash) + every(b1) + every(b2))],
        )
        assert [(x["entry"], len(x["missing"])) for x in c["delivery"]["excluded"]] == [(3, 5)], c["delivery"]["excluded"]
        assert [r["code"] for r in c["delivery"]["records"]] == ["delivery-stray"] * 5, c["delivery"]["records"]

    doc = {
        "format": "abolish-verifier-delivery-vectors/1",
        "title": f"The verifier's delivery check beside an author panel (definition version {'6' if version == 6 else '7 with a fixed electorate'}, ballot version 4, delivery records version 2): definitions, clocks, boards carrying both panels' transcripts, the author approvals, ballots and share receipts, and the pinned default panel, with the rows 5.9, 6.3, 7.1 to 7.3 and 8.5, the report's delivery and the counted ballots' entries",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-delivery-v2-author-vectors.py, from verifier-ballots-v4-author-vectors.py, "
            "verifier-ceremony-vectors.py, ceremony-vectors.py, delivery-vectors.py, delivery-v2-vectors.py, intake-v4-vectors.py "
            "and verifier-openings-vectors.py (independent Python implementations); the ballot records are "
            f"{source}'s"
        ),
        "panel": {"threshold": str(panel["k"]), "keys": [k.hex() for k in panel["keys"]]},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-delivery-v2-author.json" if version == 6 else "verifier-delivery-v2-author-definition-v7.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4) or sys.argv[3:] not in ([], ["7"]):
        raise SystemExit("usage: verifier-delivery-v2-author-vectors.py <constants> <out-dir> [7]")
    main(sys.argv[1], sys.argv[2], 7 if sys.argv[3:] else 6)
