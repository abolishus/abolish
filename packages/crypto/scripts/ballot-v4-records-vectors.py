#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/ballot-v4-records.json.

A second implementation of docs/spec/ballot-validity.md (Ballot record
(version 4), Decoding and Admission (version 4)): the version-4 ballot record,
which has version 3's fields, offsets and cell with a committed vote carrying
the author half after the default half, its admission checks in order (with
`share-hash-unqualified` over both panels' seats, default seats first, naming
the first such seat and its panel), the public signals its membership proof
is checked against (the cell's root and scope, and M under the cell's tier
over the version-4 ballot hash), and the admission part of trustee intake at
a seat of either panel (docs/spec/share-encryption.md, Intake and receipts;
Ballot version 4: `share-hash` against the seat's own panel's list, between
`share-hash-unqualified` and the membership proof). It is written from the
spec with Python's integers and hashlib and shares no code with
packages/crypto. It reuses this folder's other independent generators:
ballot-v2-vectors.py's electorate (its groups, regions, fold and cell trees)
and Merkle paths, ballot-vectors.py's Baby Jubjub and Poseidon wrapper,
membership-vectors.py's scope and field map, revoting-vectors.py's message M,
ballot-v3-vectors.py's flat answers, ballot-v4-vectors.py's version-4
committed votes, hashes and checks, and definition-v6-vectors.py's version-6
definition encoder and well-formedness rules.

The share hashes are labels, not ciphertext hashes: version 4's ciphertexts
are P2-16 part 2b-3's, so these vectors stop at intake's admission.

Membership proofs need a Groth16 prover, so generation has three steps, as
for ballot-v3-records-vectors.py:

  python3 -I -B ballot-v4-records-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B ballot-v4-records-vectors.py assemble <constants> <work>/proofs.json <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json.
Every value but the proofs is deterministic from fixed labels (test data,
never keys); Groth16 proving is randomised, so the committed file is the
record. Then `vp check --fix` formats it.
"""

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
b3 = _load("ballot_v3_vectors", "ballot-v3-vectors.py")
b4 = _load("ballot_v4_vectors", "ballot-v4-vectors.py")
b1, rev, mem = b2.b1, b2.rev, b2.mem
d6, bv = b4.d6, b4.bv

R = b2.R
DEPTH = b2.DEPTH
PROOF_LEN = b2.PROOF_LEN
VERSION = 4
DEFAULT, AUTHOR = 1, 2


def det(label):
    return hashlib.sha256(b"abolish ballot v4 records vectors " + label.encode()).digest()


# --- The record (ballot-validity.md, Ballot record (version 4)) ----------------


def enc_ballot(b, version=VERSION):
    """Version 3's header and fields with version 4's committed vote."""
    out = b3.u16(0x0002) + b3.u8(version)
    out += b["definitionHash"] + b3.u8(b["cell"]) + b["nullifier"].to_bytes(32, "big")
    out += b["l1RefNumber"].to_bytes(8, "big") + b["l1RefHash"]
    assert len(b["proof"]) == PROOF_LEN
    out += b["proof"] + b["committedVote"]
    return out


def ctx_of(b):
    return {"definitionHash": b["definitionHash"], "cell": b["cell"], "nullifier": b["nullifier"]}


def bh_of(b):
    return b4.ballot_hash(ctx_of(b), b["vote"])


def unqualified(election, registered, author_registered, vote):
    """The first seat outside its panel's registered key set with a non-zero share hash: default seats first, each panel in seat order."""
    for panel, size, reg, hashes in (
        (DEFAULT, election["panelSize"], registered, vote["shareHashes"]),
        (AUTHOR, election["authorPanelSize"], author_registered, vote["authorShareHashes"]),
    ):
        for seat in range(1, size + 1):
            if seat not in reg and hashes[seat - 1] != bytes(32):
                return {"code": "share-hash-unqualified", "panel": panel, "seat": seat}
    return None


def admission(election, registered, author_registered, b, verdict, delivered=None):
    """Admission (version 4) in order; with `delivered` (panel, seat, share hash), intake's, with `share-hash` before the membership proof. `verdict` is snarkjs's."""
    if b["definitionHash"] != election["definitionHash"]:
        return {"code": "ballot-stray"}
    if b["cell"] >= len(election["cells"]):
        return {"code": "ballot-cell"}
    vote = b["vote"]
    v = b4.check_validity(election, ctx_of(b), vote)
    if v != "ok" and v["code"] == "validity-shape":
        return {"code": "validity-shape"}
    u = unqualified(election, registered, author_registered, vote)
    if u is not None:
        return u
    if delivered is not None:
        panel, seat, share_hash = delivered
        own = vote["shareHashes"] if panel == DEFAULT else vote["authorShareHashes"]
        if own[seat - 1] != share_hash:
            return {"code": "share-hash"}
    if not verdict:
        return {"code": "membership-proof"}
    if v != "ok":
        return v
    tier = election["cells"][b["cell"]]["tier"]
    bh = bh_of(b)
    return {
        "code": "ok",
        "ballotHash": bh,
        "tier": tier,
        "message": rev.message(b["definitionHash"], tier, bh, b["l1RefNumber"], b["l1RefHash"]),
    }


def verifier_signals(election, b):
    """[ρ, ν, m̂, ŝ] as a verifier derives them from the record and the definition, or None before the membership step."""
    if b["definitionHash"] != election["definitionHash"] or b["cell"] >= len(election["cells"]):
        return None
    c = election["cells"][b["cell"]]
    msg = rev.message(b["definitionHash"], c["tier"], bh_of(b), b["l1RefNumber"], b["l1RefHash"])
    return {
        "root": c["root"],
        "nullifier": b["nullifier"],
        "message": mem.field_map(msg),
        "scope": b1.scope_field(b["definitionHash"], c["tier"], c["root"]),
    }


# --- Elections and cases -------------------------------------------------------

# Pick one of three, pick up to two of four, pick exactly one of two, as in
# ballot-v3-records.json.
QUESTIONS = [(3, 0, 1), (4, 0, 2), (2, 1, 1)]


def rules(questions, k, n, k_a, n_a):
    qs = [{"optionCount": m, "min": lo, "max": hi} for m, lo, hi in questions]
    offsets, o = [], 0
    for q in qs:
        offsets.append(o)
        o += q["optionCount"]
    return {
        "questions": qs,
        "offsets": offsets,
        "optionTotal": o,
        "threshold": k,
        "panelSize": n,
        "authorThreshold": k_a,
        "authorPanelSize": n_a,
    }


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    b1.bjj_self_check()
    mem.self_check()
    pos = b1.Poseidon(constants)
    secrets, groups, tiers = b2.build_electorate(pos)
    vk_hash = bytes.fromhex(json.loads((VECTORS / "membership-proof.json").read_text())["verificationKey"]["hash"])

    # ballot-v2-vectors.py's partition: tier 0 split into its large region and
    # the remainder, tier 2 unsplit.
    t0, t2 = tiers
    assert [c["regions"] for c in t0["cells"]] == [[0], [1, 2]]
    assert [c["regions"] for c in t2["cells"]] == [[0]]
    cells = t0["cells"] + t2["cells"]

    def definition(label, k_a, n_a):
        author = (
            {"author_threshold": k_a, "author_keys": d6.AUTHOR_KEYS[:n_a], "author_transcript_hash": det("author transcript " + label)}
            if n_a
            else dict(d6.NO_AUTHOR)
        )
        d = d6.variant(
            d6.TYPICAL,
            profile={"protocol_major": 1, "pins": b4.PINS_V6},
            election_id=det("election " + label),
            questions=[d6.d5.q(*x) for x in QUESTIONS],
            electorate=[
                {
                    "tier": t["tier"],
                    "root_l2_block": 1000,
                    "groups": [{"group_id": g["group_id"], "region": g["region"]} for g in t["groups"]],
                    "regions": t["regions"],
                    "cells": [{"root": c["root"], "members": c["members"]} for c in t["cells"]],
                }
                for t in tiers
            ],
            membership_vk_hash=vk_hash,
            threshold=2,
            panel_size=3,
            ceremony_transcript_hash=det("transcript " + label),
            **d6.SEALED_EVERYDAY,
            **author,
        )
        assert d6.definition_rule(d) is None, (label, d6.definition_rule(d))
        enc = d6.enc_definition_v6(d)
        return dict(
            rules(QUESTIONS, 2, 3, k_a, n_a),
            label=label,
            encoding=enc,
            definitionHash=b3.H(b3.ds(b3.DEFINITION_TAG, enc)),
            cells=cells,
        )

    panels = definition("panels", 2, 3)
    default_only = definition("default-only", 0, 0)
    other = definition("panels-other", 2, 3)
    elections = {"panels": panels, "default-only": default_only, "other": other}

    def where(label, cell):
        """The member's leaf index in `cell`'s tree: its group's offset plus its index there."""
        c = cells[cell]
        for g in groups:
            if g["group_id"] in c["offsets"]:
                for i, (kind, lab) in enumerate(g["members"]):
                    if kind == "real" and lab == label:
                        return c["offsets"][g["group_id"]] + i
        raise KeyError((label, cell))

    def scope(election, cell):
        c = cells[cell]
        return b1.scope_field(election["definitionHash"], c["tier"], c["root"])

    def nullifier(label, election, cell):
        return pos(scope(election, cell), secrets[label])

    proofs = {}

    def prove(pid, label, election, cell, b):
        """A witness proving `label`'s leaf in `cell`'s tree, for M over `b`'s ballot hash."""
        c = cells[cell]
        s = secrets[label]
        i = where(label, cell)
        sib = c["path"](i)
        sc = scope(election, cell)
        msg = rev.message(election["definitionHash"], c["tier"], bh_of(b), b["l1RefNumber"], b["l1RefHash"])
        root = b2.root_from_path(pos, pos.commitment(s), i, sib)
        assert root == c["root"], pid
        proofs[pid] = {
            "id": pid,
            "witness": {
                "secret": str(s),
                "merkleProofLength": DEPTH,
                "merkleProofIndex": i,
                "merkleProofSiblings": [str(x) for x in sib],
                "message": str(mem.field_map(msg)),
                "scope": str(sc),
            },
            "expect": {"root": str(root), "nullifier": str(pos(sc, s))},
        }

    def with_vote(b, vote):
        return dict(b, vote=vote, committedVote=b4.enc_committed_vote(vote))

    def ballot(label, election, cell, nul, answers, hashes, author_hashes, vote_rules=None, votes=None):
        votes = votes or b3.flat(answers)
        ctx = {"definitionHash": election["definitionHash"], "cell": cell, "nullifier": nul}
        vote, _, _, _ = b4.make_ballot(
            "records/" + label, vote_rules or election, ctx, votes, share_hashes=hashes, author_share_hashes=author_hashes
        )
        r = (21_000_000 + int.from_bytes(det("ref " + label)[:2], "big"), det("ref hash " + label))
        return with_vote(
            {"definitionHash": election["definitionHash"], "cell": cell, "nullifier": nul, "l1RefNumber": r[0], "l1RefHash": r[1]},
            vote,
        )

    def hashes(panel, seats, n=3):
        """Share hashes for seats 1 to n: a label at each seat in `seats`, 32 zero bytes elsewhere."""
        return [det(f"{panel} share {i}") if i in seats else bytes(32) for i in range(1, n + 1)]

    d12, d123 = hashes("default", (1, 2)), hashes("default", (1, 2, 3))
    a12, a123 = hashes("author", (1, 2)), hashes("author", (1, 2, 3))
    cases = []

    def case(cid, description, election, registered, author_registered, b, proof, expect=None):
        cases.append(
            {
                "id": cid,
                "description": description,
                "election": election,
                "registered": list(registered),
                "authorRegistered": list(author_registered),
                "ballot": b,
                "proof": proof,
                "expect": expect or cid,
            }
        )

    e = panels
    # Honest ballots.
    b_a = ballot("cell-0", e, 0, nullifier("r0/1", e, 0), [(3, [1]), (4, [0, 3]), (2, [1])], d12, a12)
    prove("cell-0", "r0/1", e, 0, b_a)
    case("ok-cell-0", "A member of tier 0's large region answers all three questions in cell 0, with a 2-of-3 author panel; seat 3 of each panel is unregistered", "panels", [1, 2], [1, 2], b_a, "cell-0", "ok")

    b_rev = ballot("revote", e, 0, nullifier("r0/1", e, 0), [(3, []), (4, [2]), (2, [0])], d12, a12)
    prove("revote", "r0/1", e, 0, b_rev)
    case("ok-revote", "The same member's re-vote: the same nullifier, every question answered again", "panels", [1, 2], [1, 2], b_rev, "revote", "ok")

    b_t2 = ballot("tier-2", e, 2, nullifier("t2/2", e, 2), [(3, []), (4, []), (2, [1])], d12, a12)
    prove("tier-2", "t2/2", e, 2, b_t2)
    case("ok-tier-2-least", "A tier 2 member in cell 2 answering only the pick-exactly-one question", "panels", [1, 2], [1, 2], b_t2, "tier-2", "ok")

    b_all = ballot("all-seats", e, 1, nullifier("r2/1", e, 1), [(3, [0]), (4, [1, 2]), (2, [0])], d123, a123)
    prove("all-seats", "r2/1", e, 1, b_all)
    case("ok-every-seat", "A remainder-cell ballot with a share hash at every seat of both panels, under key sets that register all three of each", "panels", [1, 2, 3], [1, 2, 3], b_all, "all-seats", "ok")
    case("share-hash-unqualified", "The same ballot when default seat 3 isn't registered: its share hash isn't 32 zero bytes", "panels", [1, 2], [1, 2, 3], b_all, "all-seats")
    case("share-hash-unqualified-author", "The same ballot when author seat 2 isn't registered: the author half's seat 2 hash isn't zero", "panels", [1, 2, 3], [1, 3], b_all, "all-seats", "share-hash-unqualified")
    case("share-hash-unqualified-default-first", "Default seat 3 and author seat 1 both unregistered: the default seat is named", "panels", [1, 2], [2, 3], b_all, "all-seats", "share-hash-unqualified")

    b_d = ballot("default-only", default_only, 0, nullifier("r0/2", default_only, 0), [(3, [2]), (4, [3]), (2, [0])], d12, [])
    prove("default-only", "r0/2", default_only, 0, b_d)
    case("ok-default-only", "A poll without an author panel: both author lists are empty", "default-only", [1, 2], [], b_d, "default-only", "ok")

    # Rejected before the membership proof.
    b_other = ballot("other-election", other, 0, nullifier("r0/0", other, 0), [(3, [0]), (4, []), (2, [0])], d12, a12)
    prove("other-election", "r0/0", other, 0, b_other)
    case("ballot-stray", "Another election's ballot (the same electorate, questions and panels, another election_id)", "panels", [1, 2], [1, 2], b_other, "other-election")
    case("ballot-cell", "A ballot naming cell 3: the partition has cells 0 to 2", "panels", [1, 2], [1, 2], dict(b_a, cell=3), "cell-0")
    b_k1 = ballot("author-k1", e, 0, nullifier("r0/0", e, 0), [(3, [0]), (4, []), (2, [0])], d12, a12, vote_rules=rules(QUESTIONS, 2, 3, 1, 3))
    case("validity-shape-author-threshold", "An author half of one commitment per option where the author panel's threshold is 2", "panels", [1, 2], [1, 2], b_k1, "cell-0", "validity-shape")
    b_none = ballot("no-author-half", e, 0, nullifier("r0/0", e, 0), [(3, [0]), (4, []), (2, [0])], d12, [], vote_rules=rules(QUESTIONS, 2, 3, 0, 0))
    case("validity-shape-missing-author-half", "A ballot without an author half in a poll with an author panel", "panels", [1, 2], [1, 2], b_none, "cell-0", "validity-shape")
    b_extra = ballot("extra-author-half", default_only, 0, nullifier("r0/0", default_only, 0), [(3, [0]), (4, []), (2, [0])], d12, a12, vote_rules=rules(QUESTIONS, 2, 3, 2, 3))
    case("validity-shape-stray-author-half", "A ballot with an author half in a poll without an author panel", "default-only", [1, 2], [], b_extra, "default-only", "validity-shape")
    b_n2 = ballot("author-n2", e, 0, nullifier("r0/0", e, 0), [(3, [0]), (4, []), (2, [0])], d12, a12[:2], vote_rules=rules(QUESTIONS, 2, 3, 2, 2))
    case("validity-shape-author-seats", "Two author share hashes where the author panel has three seats", "panels", [1, 2], [1, 2], b_n2, "cell-0", "validity-shape")

    # Membership failures.
    case("membership-ref-changed", "The cell 0 ballot naming the next L1 block: M changes, so its proof fails", "panels", [1, 2], [1, 2], dict(b_a, l1RefNumber=b_a["l1RefNumber"] + 1), "cell-0", "membership-proof")
    case("membership-other-ballot-proof", "The cell 0 ballot carrying the re-vote's valid proof", "panels", [1, 2], [1, 2], b_a, "revote", "membership-proof")
    swapped = dict(b_a["vote"], authorVss=b_rev["vote"]["authorVss"])
    case("membership-author-half-swapped", "The cell 0 ballot with the re-vote's author half: the ballot hash binds it, so M and the proof fail", "panels", [1, 2], [1, 2], with_vote(b_a, swapped), "cell-0", "membership-proof")

    # Validity failures behind a valid membership proof.
    two = b3.flat([(3, []), (4, []), (2, [1])])
    two[4] = 2
    b_two = ballot("vote-of-two", e, 1, nullifier("r1/0", e, 1), None, d12, a12, votes=two)
    prove("vote-of-two", "r1/0", e, 1, b_two)
    case("option-proof", "A vote of 2 for flat option 4, question 1's second option: the first failing flat option", "panels", [1, 2], [1, 2], b_two, "vote-of-two")
    b_q1 = ballot("question-1-over", e, 1, nullifier("r1/1", e, 1), [(3, []), (4, [0, 1, 2]), (2, [0])], d12, a12)
    prove("question-1-over", "r1/1", e, 1, b_q1)
    case("sum-proof", "Three of question 1's options where it allows two: the first failing question", "panels", [1, 2], [1, 2], b_q1, "question-1-over")
    # An author higher coefficient replaced after proving, with a membership
    # proof over the changed ballot: C_j is unchanged, but the statement
    # binds the whole author half, so every proof fails (T-30).
    hc = [list(row) for row in b_a["vote"]["authorVss"]]
    hc[0][1] = b_rev["vote"]["authorVss"][0][1]
    b_hc = with_vote(dict(b_a), dict(b_a["vote"], authorVss=hc))
    prove("author-coefficient", "r0/1", e, 0, b_hc)
    case("option-proof-author-coefficient", "The cell 0 ballot with another author higher coefficient at option 0, proved for membership afresh: every C_j is unchanged, but the statement binds the author half", "panels", [1, 2], [1, 2], b_hc, "author-coefficient", "option-proof")

    # The order of the checks, where two would fail: the earlier code is the result.
    case("order-unqualified-before-membership", "An unregistered author seat's share hash and another ballot's proof: share-hash-unqualified comes first", "panels", [1, 2, 3], [1, 2], b_all, "tier-2", "share-hash-unqualified")
    case("order-shape-before-unqualified", "A missing author half beside an unregistered default seat's share hash: validity-shape comes first", "panels", [1], [1, 2], b_none, "cell-0", "validity-shape")
    case("order-membership-before-option", "A vote of 2 and another ballot's proof: membership-proof comes first", "panels", [1, 2], [1, 2], b_two, "cell-0", "membership-proof")

    # --- Intake admission at a seat of either panel.
    intakes = []

    def intake_case(cid, description, b, proof, panel, seat, share_hash, registered=(1, 2, 3), author_registered=(1, 2, 3), expect=None, record=None, election="panels"):
        intakes.append(
            {
                "id": "intake-" + cid,
                "description": description,
                "election": election,
                "ballot": b,
                "proof": proof,
                "panel": panel,
                "seat": seat,
                "shareHash": share_hash,
                "registered": list(registered),
                "authorRegistered": list(author_registered),
                "expect": expect or cid,
                "record": record,
            }
        )

    ok = b_all
    sh = ok["vote"]["shareHashes"]
    ash = ok["vote"]["authorShareHashes"]
    for seat in (1, 2, 3):
        intake_case(f"ok-default-{seat}", f"The every-seat ballot at default seat {seat}, with that seat's share hash", ok, "all-seats", DEFAULT, seat, sh[seat - 1], expect="ok")
        intake_case(f"ok-author-{seat}", f"The every-seat ballot at author seat {seat}, with the author half's seat {seat} hash", ok, "all-seats", AUTHOR, seat, ash[seat - 1], expect="ok")
    intake_case("ok-default-only", "The poll without an author panel, at default seat 2", b_d, "default-only", DEFAULT, 2, b_d["vote"]["shareHashes"][1], registered=(1, 2), author_registered=(), expect="ok", election="default-only")
    intake_case("share-hash-author-as-default", "Default seat 1's ciphertext hash delivered to author seat 1: a seat of one panel never stands for the same index of the other", ok, "all-seats", AUTHOR, 1, sh[0], expect="share-hash")
    intake_case("share-hash-default-as-author", "Author seat 2's ciphertext hash delivered to default seat 2", ok, "all-seats", DEFAULT, 2, ash[1], expect="share-hash")
    intake_case("share-hash", "Author seat 3's ciphertext hash delivered to author seat 1", ok, "all-seats", AUTHOR, 1, ash[2])
    intake_case("delivery-malformed-version", "The every-seat ballot under version 3, which the election doesn't pin", ok, "all-seats", AUTHOR, 1, ash[0], expect="delivery-malformed", record="version-3")
    intake_case("delivery-malformed-truncated", "The every-seat ballot without its last byte", ok, "all-seats", AUTHOR, 1, ash[0], expect="delivery-malformed", record="truncated")
    intake_case("ballot-stray", "The every-seat ballot naming the other election's definition hash", dict(ok, definitionHash=other["definitionHash"]), "all-seats", AUTHOR, 1, ash[0])
    intake_case("ballot-cell", "The every-seat ballot naming cell 3", dict(ok, cell=3), "all-seats", AUTHOR, 1, ash[0])
    intake_case("validity-shape", "A ballot without an author half, at default seat 1", b_none, "cell-0", DEFAULT, 1, d12[0])
    intake_case("share-hash-unqualified", "The every-seat ballot at author seat 1 under an author key set without seat 3", ok, "all-seats", AUTHOR, 1, ash[0], author_registered=(1, 2))
    moved = dict(ok, l1RefNumber=ok["l1RefNumber"] + 1)
    intake_case("membership-ref-changed", "The every-seat ballot naming the next L1 block, at author seat 2", moved, "all-seats", AUTHOR, 2, ash[1], expect="membership-proof")
    intake_case("order-share-hash-before-membership", "A failing membership proof and default seat 2's hash at author seat 2: share-hash comes first", moved, "all-seats", AUTHOR, 2, sh[1], expect="share-hash")
    intake_case("sum-proof", "Three of question 1's options where it allows two, at author seat 2", b_q1, "question-1-over", AUTHOR, 2, b_q1["vote"]["authorShareHashes"][1], registered=(1, 2), author_registered=(1, 2))

    checks = []
    for c in cases:
        sig = verifier_signals(elections[c["election"]], c["ballot"])
        if sig is not None:
            checks.append({"case": c["id"], "proof": c["proof"], "signals": {k: str(v) for k, v in sig.items()}})
    for c in intakes:
        if c["record"] is not None:
            continue
        sig = verifier_signals(elections[c["election"]], c["ballot"])
        if sig is not None:
            checks.append({"case": c["id"], "proof": c["proof"], "signals": {k: str(v) for k, v in sig.items()}})
    return {"elections": elections, "proofs": proofs, "cases": cases, "checks": checks, "intakes": intakes}


def hexb(b):
    return b.hex()


def statements(constants, out):
    s = build(constants)
    pathlib.Path(out).write_text(json.dumps({"proofs": list(s["proofs"].values()), "checks": s["checks"]}, indent=2) + "\n")


def election_json(e):
    return {
        "definition": hexb(e["encoding"]),
        "definitionHash": hexb(e["definitionHash"]),
        "questions": [
            {"optionCount": q["optionCount"], "minSelections": q["min"], "maxSelections": q["max"], "offset": o}
            for q, o in zip(e["questions"], e["offsets"])
        ],
        "threshold": e["threshold"],
        "panelSize": e["panelSize"],
        "authorThreshold": e["authorThreshold"],
        "authorPanelSize": e["authorPanelSize"],
        "cells": [
            {
                "cell": i,
                "tier": c["tier"],
                "root": str(c["root"]),
                "scope": str(b1.scope_field(e["definitionHash"], c["tier"], c["root"])),
            }
            for i, c in enumerate(e["cells"])
        ],
    }


def result_json(result, b):
    """The outcome, under its own key so it never collides with a vector's inputs."""
    out = {"code": result["code"]}
    for key in ("option", "question", "panel", "seat"):
        if key in result:
            out[key] = result[key]
    if result["code"] == "ok":
        out.update(
            ballotHash=hexb(result["ballotHash"]),
            message=hexb(result["message"]),
            tier=result["tier"],
            cell=b["cell"],
        )
    return {"admission": out}


def assemble(constants, proofs_path, out_dir):
    s = build(constants)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    proof_bytes = {k: bytes.fromhex(v) for k, v in got["proofs"].items()}
    verdicts = got["verdicts"]
    assert set(proof_bytes) == set(s["proofs"])

    def record(b, proof):
        return enc_ballot(dict(b, proof=proof_bytes[proof]))

    ballots = []
    for c in s["cases"]:
        e = s["elections"][c["election"]]
        b = c["ballot"]
        sig = verifier_signals(e, b)
        verdict = verdicts.get(c["id"])
        assert (sig is None) == (verdict is None), c["id"]
        result = admission(e, c["registered"], c["authorRegistered"], b, verdict)
        assert result["code"] == c["expect"], (c["id"], result)
        v = {
            "id": c["id"],
            "description": c["description"],
            "election": c["election"],
            "registered": c["registered"],
            "authorRegistered": c["authorRegistered"],
            "encoding": hexb(record(b, c["proof"])),
            "statementHash": hexb(b4.statement_hash(ctx_of(b), b["vote"])),
            "ballotHash": hexb(bh_of(b)),
        }
        if sig is not None:
            v["signals"] = {k: str(x) for k, x in sig.items()}
            v["snarkjs"] = verdict
        v.update(result_json(result, b))
        ballots.append(v)

    intakes = []
    for c in s["intakes"]:
        e = s["elections"][c["election"]]
        b = c["ballot"]
        rec = record(b, c["proof"])
        if c["record"] == "truncated":
            rec = rec[:-1]
        elif c["record"] == "version-3":
            rec = rec[:2] + b"\x03" + rec[3:]
        verdict = verdicts.get(c["id"])
        if c["record"] is not None:
            result = {"code": "delivery-malformed"}
        else:
            assert (verifier_signals(e, b) is None) == (verdict is None), c["id"]
            result = admission(e, c["registered"], c["authorRegistered"], b, verdict, (c["panel"], c["seat"], c["shareHash"]))
        assert result["code"] == c["expect"], (c["id"], result)
        v = {
            "id": c["id"],
            "description": c["description"],
            "election": c["election"],
            "registered": c["registered"],
            "authorRegistered": c["authorRegistered"],
            "panel": c["panel"],
            "seat": c["seat"],
            "shareHash": hexb(c["shareHash"]),
            "record": hexb(rec),
        }
        if verdict is not None:
            v["snarkjs"] = verdict
        v.update(result_json(result, b))
        intakes.append(v)

    good_case = s["cases"][[c["id"] for c in s["cases"]].index("ok-every-seat")]
    gb = good_case["ballot"]
    good = record(gb, good_case["proof"])
    assert hexb(good) == next(x["encoding"] for x in ballots if x["id"] == "ok-every-seat")
    proof_at = 3 + 32 + 1 + 32 + 8 + 32
    vote_at = proof_at + PROOF_LEN
    vote = gb["vote"]
    author_vss_at = vote_at + len(bv.enc_vss(vote["vss"])) + len(bv.enc_share_hashes(vote["shareHashes"]))
    author_hashes_at = author_vss_at + len(bv.enc_vss(vote["authorVss"]))
    assert good[author_hashes_at : author_hashes_at + 4] == (3).to_bytes(4, "big")

    def with_bytes(at, new):
        return good[:at] + new + good[at + len(new) :]

    first_element = vote_at + 4 + 4
    first_author_element = author_vss_at + 4 + 4
    last_z = len(good) - 32
    decode = [
        ("truncated", "The every-seat ballot without its last byte", good[:-1], "truncated", None),
        ("trailing-byte", "The every-seat ballot with a byte after its last range proof", good + b"\x00", "trailing-bytes", len(good)),
        ("header-only", "A version-4 ballot record header with nothing after it", good[:3], "truncated", 3),
        ("nullifier-r", "A nullifier equal to the BN254 scalar field order", with_bytes(36, R.to_bytes(32, "big")), "non-canonical", 36),
        ("vss-identity", "A committed vote whose first default VSS commitment is the identity", with_bytes(first_element, bytes(32)), "non-canonical", first_element),
        ("author-vss-identity", "A committed vote whose first author VSS commitment is the identity", with_bytes(first_author_element, bytes(32)), "non-canonical", first_author_element),
        ("author-vss-non-canonical", "A committed vote whose first author VSS commitment is 32 bytes of 0xff, no canonical encoding", with_bytes(first_author_element, b"\xff" * 32), "non-canonical", first_author_element),
        ("author-vss-row-over-max", "An author half whose first option claims 17 commitments, one over MAX_TRUSTEES", with_bytes(author_vss_at + 4, (17).to_bytes(4, "big")), "length-over-max", author_vss_at + 4),
        ("author-vss-options-over-max", "An author half claiming 65 options, one over MAX_OPTIONS", with_bytes(author_vss_at, (65).to_bytes(4, "big")), "length-over-max", author_vss_at),
        ("author-share-hashes-over-max", "An author share-hash list claiming 17 seats, one over MAX_TRUSTEES", with_bytes(author_hashes_at, (17).to_bytes(4, "big")), "length-over-max", author_hashes_at),
        ("range-z-order", "The last range proof's last z equal to the group order ℓ", with_bytes(last_z, b4.L.to_bytes(32, "little")), "non-canonical", last_z),
        ("version-3", "The same bytes under version 3, which a profile pinning version 4 refuses", with_bytes(2, b"\x03"), "profile-mismatch", 2),
        ("version-1", "The same bytes under version 1", with_bytes(2, b"\x01"), "profile-mismatch", 2),
    ]
    decode_vectors = []
    for did, desc, enc, err, at in decode:
        dvec = {"id": did, "description": desc, "encoding": hexb(enc), "error": err}
        if at is not None:
            dvec["offset"] = at
        decode_vectors.append(dvec)

    out = {
        "format": "abolish-ballot-vectors/1",
        "title": "Ballot record, version 4 (two panels, naming its cell): encodings, admission checks, intake admission at a seat of either panel, and decode rejections",
        "spec": "docs/spec/ballot-validity.md",
        "generator": (
            "packages/crypto/scripts/ballot-v4-records-vectors.py, an implementation of the Ballot record (version 4) "
            "section and of intake's admission steps (share-encryption.md, Intake and receipts; Ballot version 4) with "
            "Python's integers and hashlib, reusing this folder's independent ballot-v2, ballot-v3, ballot-v4, membership, "
            "revoting and definition-v6 generators; cell trees built by ballot-v2-vectors.py from each tier's groups; "
            "membership proofs by packages/crypto/scripts/ballot-proofs.mjs, run outside the workspace with Semaphore "
            "4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5's fullProve, which checks that each proof's outputs "
            "equal the root and nullifier computed here; every pairing verdict is snarkjs's groth16.verify on the signals "
            "derived here from the record and the definition. Share hashes are labels, not ciphertext hashes (version 4's "
            "ciphertexts are P2-16 part 2b-3's). Decode errors and their offsets are labelled by hand from the "
            "strict-decoding rules and the layout's offsets"
        ),
        "recordType": "0x0002",
        "version": VERSION,
        "panels": {"default": DEFAULT, "author": AUTHOR},
        "elections": {name: election_json(e) for name, e in s["elections"].items()},
        "ballots": ballots,
        "intakes": intakes,
        "decode": decode_vectors,
    }
    (pathlib.Path(out_dir) / "ballot-v4-records.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote ballot-v4-records.json: {len(ballots)} ballots, {len(intakes)} intakes, {len(decode_vectors)} decode")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: ballot-v4-records-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
