#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-ballots-v2.json.

Elections for the verifier's ballot admission under definition versions 3
and 4, whose ballots (version 2) name their cell (docs/spec/verifier.md,
Ballot admission; 5.1 to 5.5, 5.7): each is a definition, a board copy and
the panel a bundle pins, with the rows 1.3, 2.3, 3.2, 5.1 to 5.5, 5.7 and 6.2
a verifier reports and the report's `ballots`. Every transcript is made for
the stub of the definition it is checked against, under that definition's
own version, and every ballot proves membership of its cell's tree under
that definition's hash, so a verifier checks them with nothing but the
bundle.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ceremony-vectors.py
(definitions of every version, transcripts, board entries, 2.3's profile
combination and the ceremony rows) and ballot-v2-vectors.py (the regional
electorate with its cell trees by the first-occurrence rule, the version-2
record, its hashes and its admission checks in order).

Membership proofs need a Groth16 prover, so generation has three steps, as
for verifier-ballots.json:

  python3 -I -B verifier-ballots-v2-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B verifier-ballots-v2-vectors.py assemble <constants> <work>/proofs.json <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json
and ballot-proofs.mjs runs outside the workspace (see its header). Every value
but the proofs is deterministic from fixed labels (test data, never keys);
Groth16 proving is randomised, so the committed file is the record.
"""

import copy
import hashlib
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


b2 = _load("ballot_v2_vectors", "ballot-v2-vectors.py")
vc = _load("verifier_ceremony_vectors", "verifier-ceremony-vectors.py")
# The anchoring clock and the close rule's window (5.5) are verifier-ballots-vectors.py's.
vb = _load("verifier_ballots_vectors", "verifier-ballots-vectors.py")
b1, bv, mem, rev = b2.b1, b2.bv, b2.mem, b2.rev
cv, rc, d4 = vc.cv, vc.rc, vc.d4

H, ds = cv.H, cv.ds
BALLOT_TYPE = 0x0002
SPOILED_OPENING_TYPE = 0x0003
BOARD_ENTRY_TYPE = 0x0007
MEMBERSHIP_VK_HASH = bytes.fromhex(json.loads((VECTORS / "membership-proof.json").read_text())["verificationKey"]["hash"])
DEFINITION_TAG = b"abolish/v1/election-definition"
# BN254's base field: negating a G1 or G2 point negates its y coordinate.
BN254_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583

outcome, NOT_REACHED, NOT_IMPLEMENTED = vc.outcome, vc.NOT_REACHED, vc.NOT_IMPLEMENTED
UNSUPPORTED = outcome("unverifiable", "unsupported-version", {})

# docs/spec/verifier.md, Ballot admission: the rows each admission code
# fails, with version 2's `ballot-cell` in place of `ballot-tier`.
ROWS_OF = {
    "ballot-stray": ("5.1",),
    "ballot-cell": ("5.1",),
    "membership-proof": ("5.1", "5.2", "5.3"),
    "validity-shape": ("5.4",),
    "share-hash-unqualified": ("5.4",),
    "option-proof": ("5.4",),
    "sum-proof": ("5.4",),
}
ADMISSION_ROWS = ("5.1", "5.2", "5.3", "5.4")


def det(label):
    return hashlib.sha256(b"abolish verifier ballots v2 vectors " + label.encode()).digest()


def pins_for(own, ballot=2, opening=2):
    """A profile under definition version `own`: board-entry version 5, which carries every record here and the close statement, contract-event version 4, which every profile needs (close.md, Version), and the given ballot and spoiled-opening pins."""
    own_pins = {1: own, BALLOT_TYPE: ballot, SPOILED_OPENING_TYPE: opening, BOARD_ENTRY_TYPE: vb.BOARD_VERSION, vb.CONTRACT_EVENT_TYPE: 4}
    return {"protocol_major": 1, "pins": [(t, own_pins.get(t, 1)) for t in range(1, 10)]}


def negated(proof):
    """(−A, −B, C): another valid Groth16 proof of the same statement, made without the witness (docs/spec/membership.md, Proof encoding)."""
    words = [int.from_bytes(proof[i : i + 32], "big") for i in range(0, len(proof), 32)]
    for i in (1, 4, 5):
        words[i] = (BN254_P - words[i]) % BN254_P
    return b"".join(w.to_bytes(32, "big") for w in words)


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    b1.bjj_self_check()
    mem.self_check()
    pos = b1.Poseidon(constants)
    secrets, groups, tiers = b2.build_electorate(pos)
    t0, t2 = tiers
    assert [c["regions"] for c in t0["cells"]] == [[0], [1, 2]] and [c["regions"] for c in t2["cells"]] == [[0]]
    cells = t0["cells"] + t2["cells"]

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
    panels = {"panel-4": cv.make_panel("panel-4", 3, 4)}
    common = dict(electorate=electorate, membership_vk_hash=MEMBERSHIP_VK_HASH, election_type=1, option_count=3, min_selections=0, max_selections=1)
    eid = rc.TYPICAL["election_id"]
    assert d4.TYPICAL["election_id"] == eid
    proofs, checks, bundles = {}, [], []

    def election_for(label, seats, base=rc.TYPICAL, cheat=None, **changes):
        """A definition for the panel and its transcript, made for the definition's own stub under its own version."""
        panel = panels["panel-4"]
        fields = dict(copy.deepcopy(base), **common)
        fields.update(changes)
        ctx = vc.election_of(vc.definition_for(panel, bytes(32), fields))
        t = vc.transcript(f"verifier-ballots-v2/{label}", panel, seats, ctx, cheat)
        d = vc.definition_for(panel, H(ds(vc.TRANSCRIPT_TAG, t)), fields)
        h = bv.H(bv.ds(DEFINITION_TAG, vc.encode(d)))
        e = {
            "label": label,
            "definitionHash": h,
            "optionCount": 3,
            "min": 0,
            "max": 1,
            "threshold": d["threshold"],
            "panelSize": d["panel_size"],
            "cells": [dict(c, root=r["root"]) for c, r in zip(cells, [c for t in d["electorate"] for c in t["cells"]])],
        }
        return d, t, e

    def where(label, cell):
        """The member's leaf index in `cell`'s tree: its group's offset plus its index there."""
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

    def ref(label):
        return (21_000_000 + int.from_bytes(det("ref " + label)[:2], "big"), det("ref hash " + label))

    def ballot(label, e, cell, nul, votes, share_hashes, vote_election=None):
        ctx = b2.validity_ctx(vote_election or e, cell, nul)
        vote, _, _ = bv.make_ballot("verifier-ballot-v2/" + e["label"] + "/" + label, ctx, votes, share_hashes=share_hashes)
        r = ref(e["label"] + "/" + label)
        return {
            "definitionHash": e["definitionHash"],
            "cell": cell,
            "nullifier": nul,
            "l1RefNumber": r[0],
            "l1RefHash": r[1],
            "vote": vote,
            "committedVote": bv.enc_committed_vote(vote),
        }

    def prove(pid, label, e, cell, b, index=None):
        """A witness proving `label`'s leaf in `cell`'s tree (or the leaf at `index`), for `b`'s M under the cell's tier."""
        c = cells[cell]
        s = secrets[label]
        i = where(label, cell) if index is None else index
        sib = c["path"](i)
        sc = scope(e, cell)
        bh = b2.ballot_hash(b["definitionHash"], b["cell"], b["nullifier"], b["committedVote"])
        msg = rev.message(e["definitionHash"], cells[b["cell"]]["tier"] if b["cell"] < len(cells) else c["tier"], bh, b["l1RefNumber"], b["l1RefHash"])
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
            "expect": {"root": str(b2.root_from_path(pos, pos.commitment(s), i, sib)), "nullifier": str(pos(sc, s))},
        }
        return pid

    def bundle(bid, description, d, t, e, registered, payloads, expect):
        """`payloads` is the board in order: a transcript's bytes, (ballot, proof id), or (how, ballot, proof id) with `how` "negated" (the proof re-randomised) or a way of making the record undecodable."""
        for i, p in enumerate(payloads):
            if isinstance(p, tuple) and (len(p) == 2 or p[0] == "negated"):
                b, pid = p[-2:]
                if pid is not None:
                    sig = b2.verifier_signals(e, b)
                    if sig is not None:
                        check = {"case": f"{bid}/{i}", "proof": pid, "signals": {k: str(v) for k, v in sig.items()}}
                        if len(p) == 3:
                            check["negate"] = True
                        checks.append(check)
        bundles.append({"id": bid, "description": description, "definition": d, "transcript": t, "election": e, "registered": registered, "board": payloads, "expect": expect})

    zero4 = [det("share 1"), det("share 2"), det("share 3"), bytes(32)]
    full4 = zero4[:3] + [det("share 4")]

    def honest(e):
        """One admitted ballot in each cell, and a re-vote, each with its proof."""
        p = e["label"] + "/"
        b_a = ballot("cell-0", e, 0, nullifier("r0/1", e, 0), [0, 1, 0], zero4)
        b_r1 = ballot("remainder-region-1", e, 1, nullifier("r1/0", e, 1), [0, 0, 1], zero4)
        b_t2 = ballot("tier-2", e, 2, nullifier("t2/2", e, 2), [0, 0, 0], zero4)
        b_rev = ballot("revote", e, 0, nullifier("r0/1", e, 0), [1, 0, 0], zero4)
        return {
            "cell-0": (b_a, prove(p + "cell-0", "r0/1", e, 0, b_a)),
            "remainder-region-1": (b_r1, prove(p + "remainder-region-1", "r1/0", e, 1, b_r1)),
            "tier-2": (b_t2, prove(p + "tier-2", "t2/2", e, 2, b_t2)),
            "revote": (b_rev, prove(p + "revote", "r0/1", e, 0, b_rev)),
        }

    # Definition version 3 pinning ballot version 2 and spoiled-ballot opening
    # version 2, which opens its cores, so 2.3's combination passes.
    # Seat 4 sends nothing, so the registered key set is seats 1 to 3 and
    # seat 4's share hash must be zero.
    d, t, e = election_for("v3", [1, 2, 3], profile=pins_for(3))
    ok = honest(e)
    b_a, p_a = ok["cell-0"]
    b_r2 = ballot("remainder-region-2", e, 1, nullifier("r2/1", e, 1), [1, 0, 0], zero4)
    p_r2 = prove("v3/remainder-region-2", "r2/1", e, 1, b_r2)
    b_mv = ballot("moved", e, 0, nullifier("moved", e, 0), [0, 1, 0], zero4)
    p_mv = prove("v3/moved", "moved", e, 0, b_mv)
    stray = dict(b_a, definitionHash=det("other definition"))
    b_shape = ballot("shape", e, 0, nullifier("r0/0", e, 0), [0, 1, 0, 0], zero4, vote_election=dict(e, optionCount=4))
    b_unq = ballot("unqualified", e, 0, nullifier("r0/2", e, 0), [0, 0, 1], full4)
    p_unq = prove("v3/unqualified", "r0/2", e, 0, b_unq)
    # A cell 0 member's proof under cell 0's root and scope, on a ballot
    # naming cell 1 of the same tier.
    b_oc = ballot("other-cell", e, 1, nullifier("r0/0", e, 0), [1, 0, 0], zero4)
    p_oc = prove("v3/other-cell", "r0/0", e, 0, b_oc)
    # The moved commitment proving from its second leaf, in the remainder
    # cell, which first occurrence set to 0: the path gives another root.
    b_z = ballot("moved-zeroed", e, 1, nullifier("moved", e, 1), [0, 0, 1], zero4)
    p_z = prove("v3/moved-zeroed", "moved", e, 1, b_z, index=cells[1]["offsets"][3] + 2)
    assert proofs[p_z]["expect"]["root"] != str(cells[1]["root"])
    moved_ref = dict(b_a, l1RefNumber=b_a["l1RefNumber"] + 1)
    b_two = ballot("vote-of-two", e, 1, nullifier("r2/0", e, 1), [0, 2, 0], zero4)
    p_two = prove("v3/vote-of-two", "r2/0", e, 1, b_two)
    b_over = ballot("over-vote", e, 1, nullifier("r2/0", e, 1), [1, 1, 0], zero4)
    p_over = prove("v3/over-vote", "r2/0", e, 1, b_over)
    bundle(
        "mixed",
        "Definition version 3; seat 4 sends nothing, so seats 1 to 3 are registered. The board holds the transcript, an admitted ballot in each cell (both regions of the remainder), a ballot of each admission failure (another election's, cells 3 and 255, a fourth option, a share hash at seat 4, another cell's proof, a proof from a leaf first occurrence zeroed, a changed L1 reference, a vote of 2, an over-vote), two records that don't decode, a re-vote, a byte-identical repeat of the first ballot and the moved member's ballot in its counted cell.",
        d, t, e, [1, 2, 3],
        [
            t,
            ok["cell-0"],
            ok["remainder-region-1"],
            (b_r2, p_r2),
            ok["tier-2"],
            (stray, p_a),
            (dict(b_a, cell=3), p_a),
            (dict(b_a, cell=255), p_a),
            (b_shape, p_a),
            (b_unq, p_unq),
            (b_oc, p_oc),
            (b_z, p_z),
            (moved_ref, p_a),
            (b_two, p_two),
            (b_over, p_over),
            ("trailing", b_a, p_a),
            ("version-1", b_a, p_a),
            ok["revote"],
            ok["cell-0"],
            (b_mv, p_mv),
        ],
        "ballots",
    )
    bundle(
        "admitted",
        "Definition version 3 with only admitted ballots after the transcript: one in each cell and a re-vote. 5.1 to 5.5 and 5.7 pass, and so does 6.2, with no opening on the board.",
        d, t, e, [1, 2, 3],
        [t, ok["cell-0"], ok["remainder-region-1"], ok["tier-2"], ok["revote"]],
        "ballots",
    )
    bundle(
        "repeats",
        "Copies of the cell 0 ballot: one with the tier 2 ballot's proof (rejected, so it makes no copy a repeat, R4), the original, a copy with its proof negated, the tier 2 ballot, a byte-identical copy and the re-vote (another M). 5.7 rejects the two copies after the original.",
        d, t, e, [1, 2, 3],
        [t, (b_a, ok["tier-2"][1]), ok["cell-0"], ("negated", b_a, p_a), ok["tier-2"], ok["cell-0"], ok["revote"]],
        "ballots",
    )
    bundle("no-ballots", "The transcript and no ballot: 5.1 to 5.5 and 5.7 pass, with nothing admitted.", d, t, e, [1, 2, 3], [t], "ballots")

    d_all, t_all, e_all = election_for("v3-every-seat", [1, 2, 3, 4], profile=pins_for(3))
    b_all = ballot("every-seat", e_all, 0, nullifier("r0/2", e_all, 0), [0, 0, 1], full4)
    p_all = prove("v3-every-seat/every-seat", "r0/2", e_all, 0, b_all)
    bundle("every-seat", "Every seat registered: a share hash at seat 4 is admitted.", d_all, t_all, e_all, [1, 2, 3, 4], [t_all, (b_all, p_all)], "ballots")

    # Spoiled-ballot opening version 1 beside ballot version 2: 2.3 fails,
    # and, as under definition version 1, admission still runs.
    d_o1, t_o1, e_o1 = election_for("v3-opening-1", [1, 2, 3], profile=pins_for(3, opening=1))
    ok_o1 = honest(e_o1)
    bundle(
        "opening-1",
        "Definition version 3 pinning spoiled-ballot opening version 1, which can't open version-2 cores: 2.3 fails profile-combination, admission still judges every ballot, and 6.2 is not reached: no opening is judged against an election it can't open the ballots of.",
        d_o1, t_o1, e_o1, [1, 2, 3],
        [t_o1, ok_o1["cell-0"], ok_o1["tier-2"], (ok_o1["remainder-region-1"][0], ok_o1["cell-0"][1])],
        "ballots",
    )

    # Definition version 4: its hash and stub are version 4's, its partition version 3's.
    d_v4, t_v4, e_v4 = election_for("v4", [1, 2, 3], base=d4.TYPICAL, profile=pins_for(4))
    ok_v4 = honest(e_v4)
    bundle(
        "definition-v4",
        "Definition version 4 (receipt keys): ballots are hashed and proved under its version-4 hash, so an admitted version-3 ballot of the same electorate is another election's.",
        d_v4, t_v4, e_v4, [1, 2, 3],
        [t_v4, ok_v4["cell-0"], ok_v4["remainder-region-1"], ok_v4["tier-2"], ok_v4["revote"], ok["cell-0"]],
        "ballots",
    )

    def two_bad(i, answers, *_):
        return [bytes(32)] * len(answers) if i in (3, 4) else answers

    d_q, t_q, e_q = election_for("v3-quorum", [1, 2, 3, 4], cheat={"answers": two_bad}, profile=pins_for(3))
    bundle("quorum", "Seats 3 and 4 answer wrongly: no key set is registered, so no ballot or opening is checked.", d_q, t_q, e_q, None, [t_q, (b_a, None)], "not-reached")

    d_vk, t_vk, e_vk = election_for("v3-other-key", [1, 2, 3], profile=pins_for(3), membership_vk_hash=det("other key"))
    bundle("other-key", "Ballot version 2's proofs are checked under the same pinned key as version 1's: a definition naming another fails 1.3, and no ballot is checked under it.", d_vk, t_vk, e_vk, [1, 2, 3], [t_vk, (b_a, None)], "not-reached")

    zero_root = copy.deepcopy(electorate)
    zero_root[1]["cells"][0]["root"] = 0
    d_z, t_z, e_z = election_for("v3-root-zero", [1, 2, 3], profile=pins_for(3), electorate=zero_root)
    bundle("root-zero", "The definition gives tier 2's cell a root of 0, which anyone can prove membership of (T-04): no ballot is checked under it.", d_z, t_z, e_z, [1, 2, 3], [t_z, (b_a, None)], "not-reached")

    d_b1, t_b1, e_b1 = election_for("v3-ballot-1", [1, 2, 3], profile=pins_for(3, ballot=1, opening=1))
    bundle("ballot-v1", "Definition version 3 pinning ballot version 1, which names a tier, not a cell, beside opening version 1: 2.3 fails profile-combination, and no ballot or opening can be judged against the partition.", d_b1, t_b1, e_b1, [1, 2, 3], [t_b1, (b_a, None)], "not-reached")

    d_b5, t_b5, e_b5 = election_for("v3-ballot-5", [1, 2, 3], profile=pins_for(3, ballot=5))
    bundle("ballot-v5", "Definition version 3 pinning ballot version 5, which a later release may define to name its cell: 2.3, 5.1 to 5.5, 5.7 and 6.2 are unsupported.", d_b5, t_b5, e_b5, [1, 2, 3], [t_b5, (b_a, None)], "unsupported")

    return {"panels": panels, "proofs": proofs, "checks": checks, "bundles": bundles, "eid": eid, "cells": cells}


def opening_row(d, admitted):
    """6.2 (docs/spec/verifier.md, Spoiled-ballot openings, step 1): unsupported under an opening version this verifier doesn't read (it reads 1 and 2) or a ballot version other than the definition's own (2) and version 1, as admission is; not reached under any other pins but ballot version 2 beside opening version 2, the one that opens version-2 cores (a profile 2.3 fails), or where admission doesn't run; otherwise these boards carry no opening, so it passes."""
    pins = dict(d["profile"]["pins"])
    if pins[SPOILED_OPENING_TYPE] not in (1, 2) or pins[BALLOT_TYPE] not in (2, 1):
        return UNSUPPORTED
    if pins[BALLOT_TYPE] != 2 or pins[SPOILED_OPENING_TYPE] != 2 or not admitted:
        return NOT_REACHED
    return outcome("pass")


def rows_for(kind, rejected=()):
    """5.1 to 5.5 and 5.7. Each row fails at the first entry whose code is one of its own: 5.5's are the window's, 5.7's `repeat`."""
    if kind == "not-reached":
        return {r: NOT_REACHED for r in ADMISSION_ROWS + ("5.5", "5.7")}
    if kind == "unsupported":
        return {r: UNSUPPORTED for r in ADMISSION_ROWS + ("5.5", "5.7")}
    rows = {}

    def first(codes):
        x = next((x for x in rejected if x["code"] in codes), None)
        return outcome("pass") if x is None else outcome("fail", x["code"], {"entry": x["entry"]})

    for r in ADMISSION_ROWS:
        rows[r] = first([c for c, rs in ROWS_OF.items() if r in rs])
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
    eid = s["eid"]
    cases = []
    for bnd in s["bundles"]:
        d, t, e = bnd["definition"], bnd["transcript"], bnd["election"]
        payloads = []
        for p in bnd["board"]:
            if isinstance(p, bytes):
                payloads.append(("transcript", p, None))
                continue
            if len(p) == 3 and p[0] == "negated":
                _, b, pid = p
                payloads.append(("ballot", b2.enc_ballot(dict(b, proof=negated(proof_bytes[pid]))), b))
                continue
            if len(p) == 3:
                how, b, pid = p
                rec = b2.enc_ballot(dict(b, proof=proof_bytes[pid]))
                rec = rec + b"\x00" if how == "trailing" else b2.enc_ballot(dict(b, proof=proof_bytes[pid]), version=1)
                payloads.append((how, rec, b))
                continue
            b, pid = p
            # A ballot no check reaches carries some valid proof.
            proof = proof_bytes[pid] if pid is not None else next(iter(proof_bytes.values()))
            payloads.append(("ballot", b2.enc_ballot(dict(b, proof=proof)), b))
        entries = [vc.entry(vb.BOARD_VERSION, eid, i, 0, rec) for i, (_, rec, _) in enumerate(payloads)]
        panel = s["panels"]["panel-4"]
        ceremony_rows, ceremony = vc.expected(panel, d, entries, panel, vb.BOARD_VERSION)
        if bnd["registered"] is not None:
            assert ceremony_rows["3.2"] == outcome("pass"), bnd["id"]
            assert [x["index"] for x in ceremony["registered"]] == bnd["registered"], bnd["id"]
        else:
            assert ceremony_rows["3.2"]["status"] == "fail", bnd["id"]
        pins = dict(d["profile"]["pins"])
        # 1.3: ballot versions 1 and 2 are proved under the one pinned key; a
        # later version may pin another (docs/spec/verifier.md, Procedure).
        vk_fails = pins[BALLOT_TYPE] in (1, 2) and d["membership_vk_hash"] != MEMBERSHIP_VK_HASH
        rows = {"1.3": outcome("fail", "membership-key", {}) if vk_fails else NOT_IMPLEMENTED, "2.3": vc.combination(d), "3.2": ceremony_rows["3.2"]}
        ballots = None
        if bnd["expect"] == "ballots":
            admitted, rejected, repeats, firsts = [], [], [], set()
            for i, (kind, rec, b) in enumerate(payloads):
                if kind == "transcript":
                    continue
                if kind == "trailing":
                    rejected.append({"entry": i, "code": "decode", "decodeError": "trailing-bytes"})
                    continue
                if kind == "version-1":
                    assert rec[2] == 1
                    rejected.append({"entry": i, "code": "decode", "decodeError": "profile-mismatch"})
                    continue
                verdict = verdicts.get(f"{bnd['id']}/{i}")
                assert (b2.verifier_signals(e, b) is None) == (verdict is None), (bnd["id"], i)
                code, option = b2.admission(e, bnd["registered"], b, verdict)
                # Every ballot here is a board-path one in segment 0, and no
                # contract-event record carries one (the profiles pin
                # contract-event version 4, which every profile needs:
                # docs/spec/close.md, Window and Version).
                assert dict(d["profile"]["pins"])[vb.CONTRACT_EVENT_TYPE] == 4
                late = vb.window(d, {"kind": "board", "segment": 0}) if code == "ok" else None
                if late is not None:
                    rejected.append({"entry": i, "code": late})
                elif code == "ok":
                    admitted.append(i)
                    # Step 1 of revoting.md's Selection over the ballots 5.1
                    # to 5.5 admit, in board order: (tier, ν, M), the tier the cell's.
                    tier = e["cells"][b["cell"]]["tier"]
                    bh = b2.ballot_hash(b["definitionHash"], b["cell"], b["nullifier"], b["committedVote"])
                    k = (tier, b["nullifier"], rev.message(b["definitionHash"], tier, bh, b["l1RefNumber"], b["l1RefHash"]))
                    if k in firsts:
                        repeats.append({"entry": i})
                    firsts.add(k)
                else:
                    r = {"entry": i, "code": code}
                    if option is not None:
                        r["option"] = option
                    rejected.append(r)
            # Every copy left passed 5.1 to 5.5, so a repeat is rejected (5.7).
            rejected = sorted(rejected + [{"entry": r["entry"], "code": "repeat"} for r in repeats], key=lambda r: r["entry"])
            admitted = [i for i in admitted if {"entry": i} not in repeats]
            rows.update(rows_for("ballots", rejected))
            ballots = {"admitted": len(admitted), "rejected": rejected, "repeats": []}
        else:
            rows.update(rows_for(bnd["expect"]))
        rows["6.2"] = opening_row(d, bnd["expect"] == "ballots")
        case = {
            "id": bnd["id"],
            "description": bnd["description"],
            "panel": "panel-4",
            "definition": vc.encode(d).hex(),
            "board": b"".join(entries).hex(),
            "expected": rows,
        }
        if ballots is not None:
            case["ballots"] = ballots
        cases.append(case)

    by = {c["id"]: c for c in cases}
    mixed = by["mixed"]["ballots"]
    assert {r["code"] for r in mixed["rejected"]} == set(ROWS_OF) | {"decode", "repeat"}, mixed
    assert mixed["admitted"] == 6 and {"entry": 18, "code": "repeat"} in mixed["rejected"], mixed
    assert by["admitted"]["ballots"] == {"admitted": 4, "rejected": [], "repeats": []}
    assert [r for r in by["repeats"]["ballots"]["rejected"] if r["code"] == "repeat"] == [{"entry": 3, "code": "repeat"}, {"entry": 5, "code": "repeat"}]
    assert by["every-seat"]["ballots"] == {"admitted": 1, "rejected": [], "repeats": []}
    assert by["opening-1"]["expected"]["2.3"]["code"] == "profile-combination"
    assert by["opening-1"]["ballots"]["rejected"] == [{"entry": 3, "code": "membership-proof"}]
    assert by["definition-v4"]["ballots"]["rejected"] == [{"entry": 5, "code": "ballot-stray"}]
    assert by["other-key"]["expected"]["1.3"]["code"] == "membership-key"
    assert by["ballot-v1"]["expected"]["2.3"]["code"] == "profile-combination"
    assert by["ballot-v5"]["expected"]["2.3"] == UNSUPPORTED
    assert by["quorum"]["expected"]["6.2"] == NOT_REACHED and by["ballot-v1"]["expected"]["6.2"] == NOT_REACHED
    assert by["admitted"]["expected"]["6.2"] == outcome("pass") and by["opening-1"]["expected"]["6.2"] == NOT_REACHED
    assert by["ballot-v5"]["expected"]["6.2"] == UNSUPPORTED

    doc = {
        "format": "abolish-verifier-ballots-vectors/1",
        "title": "The verifier's ballot admission under definition versions 3 and 4 (ballot version 2): definitions, boards and pinned panels, with the rows 1.3, 2.3, 3.2, 5.1 to 5.5, 5.7 and 6.2 and the report's ballots",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-ballots-v2-vectors.py, from verifier-ceremony-vectors.py and ballot-v2-vectors.py "
            "(independent Python implementations); membership proofs by packages/crypto/scripts/ballot-proofs.mjs, run outside "
            "the workspace with Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5, whose groth16.verify gives "
            "every pairing verdict on the signals derived here from each record"
        ),
        "clock": {k: str(v) for k, v in vb.CLOCK.items()},
        "panels": {name: {"threshold": str(p["k"]), "keys": [k.hex() for k in p["keys"]]} for name, p in s["panels"].items()},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-ballots-v2.json")
    path.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {path}: {len(cases)} cases")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: verifier-ballots-v2-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
