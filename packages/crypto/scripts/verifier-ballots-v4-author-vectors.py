#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-ballots-v4-author.json.

Elections for the verifier's ballot admission beside an author panel
(docs/spec/verifier.md, Key ceremony, step 5, and Ballot admission; 5.1 to
5.5, 5.7): a version-6 definition with a 2-of-3 author panel, whose board
carries the author panel's transcript, the default panel's and the author
approvals record, and ballots (version 4) whose author halves are judged
against the author panel's registered key set, the output of its own run,
approved on the board (T-37, T-17). Each case is a definition, a board copy
and the default panel a bundle pins, with the rows 1.3, 2.3, 2.5, 3.1, 3.2,
5.1 to 5.5, 5.7, 6.2 and 7.4 a verifier reports and the report's `ballots`.

The author run binds the definition's own author stub (both transcript
hashes zeroed) and the default run its default stub (which keeps
`author_transcript_hash`), so both runs are of the definition they're
checked against (election-definition.md, Author panel). It reuses this
folder's independent Python implementations, which share no code with
packages/crypto or packages/verifier: verifier-ballots-v4-vectors.py (the
electorate, the definition, the version-4 record and its admission order,
through ballot-v4-records-vectors.py), ceremony-vectors.py (both runs and
their transcript check), key-set-vectors.py (the key set hash and the
registration statement) and author-ceremony-vectors.py (the author panel
and the approvals record).

Membership proofs need a Groth16 prover, so generation has three steps, as
for verifier-ballots-v4.json:

  python3 -I -B verifier-ballots-v4-author-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B verifier-ballots-v4-author-vectors.py assemble <constants> <work>/proofs.json <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json
and ballot-proofs.mjs runs outside the workspace (see its header). Every value
but the proofs is deterministic from fixed labels (test data, never keys);
Groth16 proving is randomised, so the committed file is the record. Then
`vp check --fix` formats it.
"""

import copy
import hashlib
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


vb4 = _load("verifier_ballots_v4_vectors", "verifier-ballots-v4-vectors.py")
ac = _load("author_ceremony_vectors", "author-ceremony-vectors.py")
r4, vc, vb, cv = vb4.r4, vb4.vc, vb4.vb, vb4.cv
b1, b2, b3, b4, mem, rev, d6 = vb4.b1, vb4.b2, vb4.b3, vb4.b4, vb4.mem, vb4.rev, vb4.d6
ks = ac.ks
H, ds = cv.H, cv.ds
outcome, NOT_REACHED, NOT_IMPLEMENTED = vc.outcome, vc.NOT_REACHED, vc.NOT_IMPLEMENTED

STUB_TAG = b"abolish/v1/election-stub"
# Board-entry version 7: version 5's payloads and the author approvals
# (docs/spec/board.md, Allowed payloads).
BOARD_VERSION = 7
vc.ALLOWED[BOARD_VERSION] = vc.ALLOWED[5] | {ac.APPROVALS_TYPE}
AUTHOR = {"panel": "author"}


def det(label):
    return hashlib.sha256(b"abolish verifier ballots v4 author vectors " + label.encode()).digest()


def pins():
    """verifier-ballots-v4.json's version-6 profile under board-entry version 7, which carries the approvals."""
    p = vb4.pins_for()
    return dict(p, pins=[(t, BOARD_VERSION if t == vb4.BOARD_ENTRY_TYPE else v) for t, v in p["pins"]])


def author_stub_hash(d):
    """The author panel's stub: the definition with both transcript hashes zeroed (election-definition.md, Stub hash)."""
    return H(ds(STUB_TAG, d6.enc_definition_v6(dict(d, ceremony_transcript_hash=bytes(32), author_transcript_hash=bytes(32)))))


def context(d, stub):
    return {"l2ChainId": d["l2_chain_id"], "trusteeRegistry": d["trustee_registry"], "electionId": d["election_id"], "stubHash": stub}


def key_set_hash(result):
    return ks.key_set_hash([(s["index"], ks.kem_key_hash(bytes.fromhex(s["kemKey"])), bytes.fromhex(s["signingKey"])) for s in result["registered"]])


def approval(d, author, index, transcript_hash, ksh):
    """Author seat `index`'s signature on its ceremony registration statement (ceremony.md, Author panel, Approvals)."""
    pid = cv.panel_id(author["k"], author["keys"], ac.AUTHOR_PANEL_TAG)
    m = ks.statement(d["l2_chain_id"], d["trustee_registry"], pid, index, author_stub_hash(d), transcript_hash, ksh)
    return (index, cv.sign(author["secrets"][index - 1], ac.REGISTRATION_TAG, m))


def approving(d, author, transcript_hash, ksh, records):
    """Author panel, Check, over the copy's records: the seats counted, each once, from records naming the transcript with strictly increasing seats in range; None when no record names it."""
    n = len(author["keys"])
    named, counted = False, set()
    pid = cv.panel_id(author["k"], author["keys"], ac.AUTHOR_PANEL_TAG)
    for b in records:
        rec = ac.decode_record(b)
        if rec["transcriptHash"] != transcript_hash:
            continue
        named = True
        seats = [i for i, _ in rec["approvals"]]
        if not all(1 <= i <= n for i in seats) or any(a >= c for a, c in zip(seats, seats[1:])):
            continue
        for i, sig in rec["approvals"]:
            m = ks.statement(d["l2_chain_id"], d["trustee_registry"], pid, i, author_stub_hash(d), transcript_hash, ksh)
            if cv.verify(author["keys"][i - 1], ac.REGISTRATION_TAG, m, sig):
                counted.add(i)
    return sorted(counted) if named else None


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    b1.bjj_self_check()
    mem.self_check()
    pos = b1.Poseidon(constants)
    secrets, groups, tiers = b2.build_electorate(pos)
    cells = tiers[0]["cells"] + tiers[1]["cells"]
    electorate = [
        {
            "tier": t["tier"],
            "root_l2_block": 1000,
            "groups": [{"group_id": g["group_id"], "region": g["region"]} for g in t["groups"]],
            "regions": t["regions"],
            "cells": [{"root": c["root"], "members": c["members"]} for c in t["cells"]],
        }
        for t in tiers
    ]
    panel = cv.make_panel("panel-4", 3, 4)
    author = ac.author_panel("verifier-ballots-v4-author/author-3", 2, 3, panel)
    base = dict(
        copy.deepcopy(d6.TYPICAL),
        electorate=electorate,
        membership_vk_hash=vb4.MEMBERSHIP_VK_HASH,
        questions=[d6.d5.q(*x) for x in vb4.QUESTIONS],
        profile=pins(),
        **d6.SEALED_EVERYDAY,
        author_threshold=author["k"],
        author_keys=list(author["keys"]),
        author_transcript_hash=bytes(32),
    )
    proofs, checks, bundles = {}, [], []

    def election_for(label, author_seats):
        """The definition, both runs' transcripts and the author run's check: the author run first, over the author stub, then the default run over the default stub, which binds the author transcript."""
        # Both transcript hashes zeroed: the author stub, which no rule judges
        # (an author panel's transcript hash is never zero in a definition).
        zeroed = dict(base, panel_id=cv.panel_id(panel["k"], panel["keys"]), threshold=panel["k"], panel_size=len(panel["keys"]), ceremony_transcript_hash=bytes(32))
        t_a = vc.transcript(f"verifier-ballots-v4-author/{label}/author", author, author_seats, context(zeroed, author_stub_hash(zeroed)))
        fields = dict(base, author_transcript_hash=H(ds(vc.TRANSCRIPT_TAG, t_a)))
        # The default run's `duplicate-key` reads the author keys (ceremony.md, Author panel).
        own = dict(panel, otherKeys=list(author["keys"]))
        t_d = vc.transcript(f"verifier-ballots-v4-author/{label}/default", own, [1, 2, 3], vc.election_of(vc.definition_for(panel, bytes(32), fields)))
        d = vc.definition_for(panel, H(ds(vc.TRANSCRIPT_TAG, t_d)), fields)
        assert vc.own_version(d) == 6 and author_stub_hash(d) == author_stub_hash(zeroed)
        checked = cv.check(author, t_a, context(d, author_stub_hash(d)))
        assert checked["ok"] and [s["index"] for s in checked["registered"]] == author_seats, checked
        h = H(ds(vb4.DEFINITION_TAG, vc.encode(d)))
        e = dict(
            r4.rules(vb4.QUESTIONS, d["threshold"], d["panel_size"], d["author_threshold"], len(d["author_keys"])),
            label=label,
            definitionHash=h,
            cells=[dict(c, root=r["root"]) for c, r in zip(cells, [c for t in d["electorate"] for c in t["cells"]])],
        )
        run = {"transcript": t_a, "hash": H(ds(vc.TRANSCRIPT_TAG, t_a)), "keySetHash": key_set_hash(checked), "registered": author_seats}
        return d, t_d, e, run

    def records(d, run, seats):
        return ac.enc_record(run["hash"], [approval(d, author, i, run["hash"], run["keySetHash"]) for i in seats])

    def where(label, cell):
        c = cells[cell]
        for g in groups:
            if g["group_id"] in c["offsets"]:
                for i, (kind, lab) in enumerate(g["members"]):
                    if kind == "real" and lab == label:
                        return c["offsets"][g["group_id"]] + i
        raise KeyError((label, cell))

    def scope(e, cell):
        c = cells[cell]
        return b1.scope_field(e["definitionHash"], c["tier"], c["root"])

    def nullifier(label, e, cell):
        return pos(scope(e, cell), secrets[label])

    def ballot(label, e, cell, nul, answers, share_hashes, author_share_hashes, vote_rules=None):
        ctx = {"definitionHash": e["definitionHash"], "cell": cell, "nullifier": nul}
        vote, _, _, _ = b4.make_ballot(
            "verifier-ballot-v4-author/" + e["label"] + "/" + label,
            vote_rules or e,
            ctx,
            b3.flat(answers),
            share_hashes=share_hashes,
            author_share_hashes=list(author_share_hashes),
        )
        ref = (21_000_000 + int.from_bytes(det("ref " + e["label"] + label)[:2], "big"), det("ref hash " + e["label"] + label))
        return {
            "definitionHash": e["definitionHash"],
            "cell": cell,
            "nullifier": nul,
            "l1RefNumber": ref[0],
            "l1RefHash": ref[1],
            "vote": vote,
            "committedVote": b4.enc_committed_vote(vote),
        }

    def prove(label, member, e, cell, b):
        pid = e["label"] + "/" + label
        c = cells[cell]
        s = secrets[member]
        i = where(member, cell)
        sib = c["path"](i)
        sc = scope(e, cell)
        msg = rev.message(e["definitionHash"], c["tier"], r4.bh_of(b), b["l1RefNumber"], b["l1RefHash"])
        root = b2.root_from_path(pos, pos.commitment(s), i, sib)
        assert root == c["root"], pid
        proofs[pid] = {
            "id": pid,
            "witness": {
                "secret": str(s),
                "merkleProofLength": b2.DEPTH,
                "merkleProofIndex": i,
                "merkleProofSiblings": [str(x) for x in sib],
                "message": str(mem.field_map(msg)),
                "scope": str(sc),
            },
            "expect": {"root": str(root), "nullifier": str(pos(sc, s))},
        }
        return pid

    def bundle(bid, description, d, e, run, payloads, approvals):
        """`payloads` is the board in order: bytes (a transcript or an approvals record) or (ballot, proof id). `approvals` is the author part of 3.1: "pass", "missing" or "short"."""
        for i, p in enumerate(payloads):
            if isinstance(p, tuple):
                b, pid = p
                sig = r4.verifier_signals(e, b)
                if sig is not None:
                    checks.append({"case": f"{bid}/{i}", "proof": pid, "signals": {k: str(v) for k, v in sig.items()}})
        bundles.append({"id": bid, "description": description, "definition": d, "election": e, "run": run, "board": payloads, "approvals": approvals})

    zero4 = [det("share 1"), det("share 2"), det("share 3"), bytes(32)]
    a12 = [det("author share 1"), det("author share 2"), bytes(32)]
    a123 = a12[:2] + [det("author share 3")]

    # Author seat 3 sends nothing, so seats 1 and 2 register (participation
    # max(2, 3 − 1) = 2) and both approve; default seat 4 sends nothing.
    d, t_d, e, run = election_for("author", [1, 2])
    b_a = ballot("cell-0", e, 0, nullifier("r0/1", e, 0), [(3, [1]), (4, [0, 3]), (2, [1])], zero4, a12)
    p_a = prove("cell-0", "r0/1", e, 0, b_a)
    b_r1 = ballot("remainder-region-1", e, 1, nullifier("r1/0", e, 1), [(3, [2]), (4, []), (2, [0])], zero4, a12)
    p_r1 = prove("remainder-region-1", "r1/0", e, 1, b_r1)
    b_t2 = ballot("tier-2", e, 2, nullifier("t2/2", e, 2), [(3, []), (4, []), (2, [1])], zero4, a12)
    p_t2 = prove("tier-2", "t2/2", e, 2, b_t2)
    b_rev = ballot("revote", e, 0, nullifier("r0/1", e, 0), [(3, [0]), (4, [2]), (2, [0])], zero4, a12)
    p_rev = prove("revote", "r0/1", e, 0, b_rev)
    # Author seat 3, which isn't registered, with a share hash.
    b_aq = ballot("author-unqualified", e, 0, nullifier("r0/2", e, 0), [(3, [0]), (4, [1]), (2, [0])], zero4, a123)
    p_aq = prove("author-unqualified", "r0/2", e, 0, b_aq)
    # Default seat 4 and author seat 3 both unregistered: the default seat is named.
    b_both = ballot("both-unqualified", e, 1, nullifier("r2/0", e, 1), [(3, [1]), (4, []), (2, [1])], zero4[:3] + [det("share 4")], a123)
    p_both = prove("both-unqualified", "r2/0", e, 1, b_both)
    # No author half where the poll has an author panel, and an author half
    # of one commitment per option where its threshold is 2: the shape is the
    # definition's, never the ballot's (T-17, T-37).
    b_none = ballot("no-author-half", e, 0, nullifier("r0/0", e, 0), [(3, [0]), (4, []), (2, [0])], zero4, [], vote_rules=r4.rules(vb4.QUESTIONS, 3, 4, 0, 0))
    p_none = prove("no-author-half", "r0/0", e, 0, b_none)
    b_k1 = ballot("author-threshold-1", e, 0, nullifier("r0/0", e, 0), [(3, [0]), (4, []), (2, [0])], zero4, a12, vote_rules=r4.rules(vb4.QUESTIONS, 3, 4, 1, 3))
    p_k1 = prove("author-threshold-1", "r0/0", e, 0, b_k1)
    # The cell 0 ballot with the re-vote's author half: the ballot hash binds
    # it, so M, and with it the proof, fail.
    swapped_vote = dict(b_a["vote"], authorVss=b_rev["vote"]["authorVss"])
    b_swap = dict(b_a, vote=swapped_vote, committedVote=b4.enc_committed_vote(swapped_vote))
    approved = records(d, run, [1, 2])
    bundle(
        "author-mixed",
        "A 2-of-3 author panel whose seat 3 sent nothing, beside the 3-of-4 default panel whose seat 4 sent nothing; both author seats approve. The board holds the author transcript, the default transcript and the approvals record, an admitted ballot in each cell, an unregistered author seat's share hash, an unregistered default seat's beside it (named first), a ballot without an author half, an author half of the wrong threshold, an author half swapped after proving, a re-vote and a byte-identical repeat of the first ballot.",
        d, e, run,
        [
            run["transcript"],
            t_d,
            approved,
            (b_a, p_a),
            (b_r1, p_r1),
            (b_t2, p_t2),
            (b_aq, p_aq),
            (b_both, p_both),
            (b_none, p_none),
            (b_k1, p_k1),
            (b_swap, p_a),
            (b_rev, p_rev),
            (b_a, p_a),
        ],
        "pass",
    )
    bundle(
        "approvals-missing",
        "The same election and ballots with no approvals record on the copy: 3.1 is unverifiable with author-approvals-missing, so no key set is registered and no ballot is judged.",
        d, e, run,
        [run["transcript"], t_d, (b_a, p_a), (b_aq, p_aq)],
        "missing",
    )
    bundle(
        "approvals-short",
        "Only author seat 1 approves, short of q_A = 2: 3.1 fails with author-approvals, and no ballot is judged.",
        d, e, run,
        [run["transcript"], t_d, records(d, run, [1]), (b_a, p_a)],
        "short",
    )

    # Every author seat registered and approving: author seat 3's share hash is admitted.
    d_all, t_all, e_all, run_all = election_for("author-every-seat", [1, 2, 3])
    b_all = ballot("every-seat", e_all, 0, nullifier("r0/2", e_all, 0), [(3, [2]), (4, [3]), (2, [0])], zero4, a123)
    p_all = prove("every-seat", "r0/2", e_all, 0, b_all)
    bundle(
        "author-every-seat",
        "Every author seat registers and approves: a share hash at author seat 3 is admitted.",
        d_all, e_all, run_all,
        [run_all["transcript"], t_all, records(d_all, run_all, [1, 2, 3]), (b_all, p_all)],
        "pass",
    )
    return {"panel": panel, "author": author, "proofs": proofs, "checks": checks, "bundles": bundles}


def rows_for(rejected):
    """5.1 to 5.5 and 5.7: each fails at the first entry whose code is one of its own."""

    def first(codes):
        x = next((x for x in rejected if x["code"] in codes), None)
        return outcome("pass") if x is None else outcome("fail", x["code"], {"entry": x["entry"]})

    rows = {r: first([c for c, rs in vb4.ROWS_OF.items() if r in rs]) for r in vb4.ADMISSION_ROWS}
    rows["5.5"] = first(vb.WINDOW_CODES)
    rows["5.7"] = first(("repeat",))
    return rows


def statements(constants, out):
    s = build(constants)
    pathlib.Path(out).write_text(json.dumps({"proofs": list(s["proofs"].values()), "checks": s["checks"]}, indent=2) + "\n")


def assemble(constants, proofs_path, out_dir):
    s = build(constants)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    proof_bytes = {k: bytes.fromhex(v) for k, v in got["proofs"].items()}
    verdicts = got["verdicts"]
    assert set(proof_bytes) == set(s["proofs"])
    panel, author = s["panel"], s["author"]
    cases = []
    for bnd in s["bundles"]:
        d, e, run = bnd["definition"], bnd["election"], bnd["run"]
        payloads = []
        for p in bnd["board"]:
            if isinstance(p, bytes):
                payloads.append(p)
            else:
                b, pid = p
                payloads.append(r4.enc_ballot(dict(b, proof=proof_bytes[pid])))
        entries = [vc.entry(BOARD_VERSION, d["election_id"], i, 0, rec) for i, rec in enumerate(payloads)]
        # The default panel's rows, as for a poll without one; the author
        # panel's run is the generator's own (Key ceremony, step 5).
        ceremony_rows, ceremony = vc.expected(panel, d, entries, panel, BOARD_VERSION)
        assert ceremony_rows["3.2"] == outcome("pass") and [x["index"] for x in ceremony["registered"]] == [1, 2, 3], bnd["id"]
        records = [p for p in payloads if int.from_bytes(p[:2], "big") == ac.APPROVALS_TYPE]
        seats = approving(d, author, run["hash"], run["keySetHash"], records)
        quorum = max(author["k"], len(author["keys"]) - 1)
        part = "missing" if seats is None else "pass" if len(seats) >= quorum else "short"
        assert part == bnd["approvals"], bnd["id"]
        rows = {
            "1.3": NOT_IMPLEMENTED,
            "2.3": vb4.COMBINATION_FAILS,
            # The bundle's panel stands in for the pins, and no author seat is a default seat.
            "2.5": NOT_IMPLEMENTED,
            # 3.1's last part, the default panel's registration on L2, is never read.
            "3.1": {
                "pass": NOT_IMPLEMENTED,
                "missing": outcome("unverifiable", "author-approvals-missing", AUTHOR),
                "short": outcome("fail", "author-approvals", AUTHOR),
            }[part],
            "3.2": outcome("pass"),
        }
        ballots = None
        if part == "pass":
            admitted, rejected, repeats, firsts = [], [], [], set()
            for i, p in enumerate(bnd["board"]):
                if isinstance(p, bytes):
                    continue
                b, _ = p
                result = r4.admission(e, [1, 2, 3], run["registered"], b, verdicts.get(f"{bnd['id']}/{i}"))
                code = result["code"]
                late = vb.window(d, {"kind": "board", "segment": 0}) if code == "ok" else None
                if late is not None:
                    rejected.append({"entry": i, "code": late})
                elif code == "ok":
                    admitted.append(i)
                    k = (result["tier"], b["nullifier"], result["message"])
                    if k in firsts:
                        repeats.append({"entry": i})
                    firsts.add(k)
                else:
                    r = {"entry": i, "code": code}
                    if code == "share-hash-unqualified":
                        r["panel"], r["seat"] = result["panel"], result["seat"]
                    rejected.append(r)
            rejected = sorted(rejected + [{"entry": r["entry"], "code": "repeat"} for r in repeats], key=lambda r: r["entry"])
            admitted = [i for i in admitted if {"entry": i} not in repeats]
            rows.update(rows_for(rejected))
            ballots = {"admitted": len(admitted), "rejected": rejected, "repeats": []}
        else:
            rows.update({r: NOT_REACHED for r in vb4.ADMISSION_ROWS + ("5.5", "5.7")})
        # 6.2 and 7.4 judge nothing against the author panel's key set yet
        # (P2-16 part 4d-3), so both stay not reached beside one.
        rows["6.2"] = NOT_REACHED
        rows["7.4"] = NOT_REACHED
        case = {
            "id": bnd["id"],
            "description": bnd["description"],
            "definition": vc.encode(d).hex(),
            "board": b"".join(entries).hex(),
            "expected": rows,
        }
        if ballots is not None:
            case["ballots"] = ballots
        cases.append(case)

    by = {c["id"]: c for c in cases}
    mixed = by["author-mixed"]["ballots"]
    assert mixed["admitted"] == 4, mixed
    assert [(r["entry"], r["panel"], r["seat"]) for r in mixed["rejected"] if r["code"] == "share-hash-unqualified"] == [(6, 2, 3), (7, 1, 4)], mixed
    assert [r["entry"] for r in mixed["rejected"] if r["code"] == "validity-shape"] == [8, 9], mixed
    assert [r["entry"] for r in mixed["rejected"] if r["code"] == "membership-proof"] == [10], mixed
    assert [r["entry"] for r in mixed["rejected"] if r["code"] == "repeat"] == [12], mixed
    assert by["author-every-seat"]["ballots"] == {"admitted": 1, "rejected": [], "repeats": []}
    assert by["approvals-missing"]["expected"]["5.1"] == NOT_REACHED and by["approvals-short"]["expected"]["3.1"]["status"] == "fail"

    doc = {
        "format": "abolish-verifier-ballots-vectors/1",
        "title": "The verifier's ballot admission beside an author panel (definition version 6, ballot version 4): definitions, boards carrying both panels' transcripts and the author approvals, and the pinned default panel, with the rows 1.3, 2.3, 2.5, 3.1, 3.2, 5.1 to 5.5, 5.7, 6.2 and 7.4 and the report's ballots",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-ballots-v4-author-vectors.py, from verifier-ballots-v4-vectors.py, ceremony-vectors.py, "
            "key-set-vectors.py and author-ceremony-vectors.py (independent Python implementations); membership proofs by "
            "packages/crypto/scripts/ballot-proofs.mjs, run outside the workspace with Semaphore 4.14.3's depth-32 circuit artifacts "
            "and snarkjs 0.7.5, whose groth16.verify gives every pairing verdict on the signals derived here from each record"
        ),
        "clock": {k: str(v) for k, v in vb.CLOCK.items()},
        "panel": {"threshold": str(panel["k"]), "keys": [k.hex() for k in panel["keys"]]},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-ballots-v4-author.json")
    path.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {path}: {len(cases)} cases")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: verifier-ballots-v4-author-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
