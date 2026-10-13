#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/ballot-v3-records.json and
intake-v3.json.

A second implementation of docs/spec/ballot-validity.md (Ballot record
(version 3), Decoding and Admission (version 3)): the version-3 ballot record,
which has version 2's fields, offsets and cell with a committed vote carrying
one range proof per question, its admission checks in order, and the public
signals its membership proof is checked against: the cell's cell-tree root
and scope, and M under the cell's tier over the version-3 ballot hash. It is
written from the spec with Python's integers and hashlib and shares no code
with packages/crypto. It reuses this folder's other independent generators:
ballot-v2-vectors.py's electorate (its groups, first occurrence, regions,
fold and cell trees) and Merkle paths, ballot-vectors.py's Baby Jubjub and
Poseidon wrapper, membership-vectors.py's scope and field map,
revoting-vectors.py's message M, ballot-v3-vectors.py's version-3 committed
votes, hashes and checks, and definition-v5-vectors.py's version-5
definition encoder and well-formedness rules. For intake-v3.json, trustee
intake of whole version-3 records (docs/spec/share-encryption.md, Intake and
receipts; Shares and delivery (version 3)), it also reuses
share-encryption-vectors.py's KEM keys, encryption and decryption and
share-receipt-vectors.py's receipt statement and RFC 6979 P-256 signature.

Membership proofs need a Groth16 prover, so generation has three steps, as
for ballot-v2-vectors.py:

  python3 -I -B ballot-v3-records-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B ballot-v3-records-vectors.py assemble <constants> <work>/proofs.json <out-dir>

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
sr = _load("share_receipt_vectors", "share-receipt-vectors.py")
b1, rev, mem = b2.b1, b2.rev, b2.mem
d5, bv = b3.d5, b3.bv
se, ecdsa = sr.se, sr.ecdsa

R = b2.R
DEPTH = b2.DEPTH
PROOF_LEN = b2.PROOF_LEN
VERSION = 3


def det(label):
    return hashlib.sha256(b"abolish ballot v3 records vectors " + label.encode()).digest()


# --- The record (ballot-validity.md, Ballot record (version 3)) ----------------


def enc_ballot(b, version=VERSION):
    """Version 2's header and fields with version 3's committed vote."""
    out = b3.u16(0x0002) + b3.u8(version)
    out += b["definitionHash"] + b3.u8(b["cell"]) + b["nullifier"].to_bytes(32, "big")
    out += b["l1RefNumber"].to_bytes(8, "big") + b["l1RefHash"]
    assert len(b["proof"]) == PROOF_LEN
    out += b["proof"] + b["committedVote"]
    return out


def ctx_of(b):
    return {"definitionHash": b["definitionHash"], "cell": b["cell"], "nullifier": b["nullifier"]}


def bh_of(b):
    return b3.ballot_hash(ctx_of(b), b["vote"])


def admission(election, registered, b, verdict):
    """Admission (version 3): version 2's order with version 3's shape and proofs; `verdict` is snarkjs's."""
    if b["definitionHash"] != election["definitionHash"]:
        return "ballot-stray", None
    if b["cell"] >= len(election["cells"]):
        return "ballot-cell", None
    vote = b["vote"]
    v = b3.check_validity(election, ctx_of(b), vote)
    if v != "ok" and v["code"] == "validity-shape":
        return "validity-shape", None
    for seat in range(1, election["panelSize"] + 1):
        if seat not in registered and vote["shareHashes"][seat - 1] != bytes(32):
            return "share-hash-unqualified", None
    if not verdict:
        return "membership-proof", None
    if v != "ok":
        return v["code"], v.get("option", v.get("question"))
    return "ok", None


def intake(election, registered, seat, keys, b, ct, verdict):
    """Intake steps 2 to 5 on a decoded version-3 record: admission with `share-hash` before the membership proof, then decryption."""
    if b["definitionHash"] != election["definitionHash"]:
        return {"code": "ballot-stray"}
    if b["cell"] >= len(election["cells"]):
        return {"code": "ballot-cell"}
    vote = b["vote"]
    v = b3.check_validity(election, ctx_of(b), vote)
    if v != "ok" and v["code"] == "validity-shape":
        return {"code": "validity-shape"}
    for s in range(1, election["panelSize"] + 1):
        if s not in registered and vote["shareHashes"][s - 1] != bytes(32):
            return {"code": "share-hash-unqualified"}
    sh = se.share_hash(ct)
    if sh != vote["shareHashes"][seat - 1]:
        return {"code": "share-hash"}
    if not verdict:
        return {"code": "membership-proof"}
    if v != "ok":
        return v
    # The shares are version 1's over the T flat options, under associated
    # data naming ballot version 1 (Shares and delivery (version 3)).
    got = se.decrypt(election["definitionHash"], seat, keys[seat - 1], vote["vss"], ct)
    if got != "ok":
        return {"code": got}
    bh = bh_of(b)
    tier = election["cells"][b["cell"]]["tier"]
    m = sr.statement(election["definitionHash"], bh, seat, sh)
    return {
        "code": "ok",
        "ballotHash": bh,
        "shareHash": sh,
        "statement": m,
        "receipt": sr.sign(signing_secret(seat), m),
        "tier": tier,
        "message": rev.message(b["definitionHash"], tier, bh, b["l1RefNumber"], b["l1RefHash"]),
    }


def signing_secret(seat):
    return ecdsa.secret(f"intake-v3/signing/{seat}".encode())


PANEL = 3


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

# Pick one of three, pick up to two of four, pick exactly one of two: the
# owner's methods as limits (election-definition.md, Questions).
QUESTIONS = [(3, 0, 1), (4, 0, 2), (2, 1, 1)]
# Definition version 5 pins ballot version 3, opening version 2, board-entry
# version 4 and display-text version 2 (verifier.md, 2.3).
PINS_V5 = [(1, 5), (2, 3), (3, 2), (4, 1), (5, 1), (6, 1), (7, 4), (8, 1), (9, 2)]


def rules(questions, k, n):
    qs = [{"optionCount": m, "min": lo, "max": hi} for m, lo, hi in questions]
    offsets, o = [], 0
    for q in qs:
        offsets.append(o)
        o += q["optionCount"]
    return {"questions": qs, "offsets": offsets, "optionTotal": o, "threshold": k, "panelSize": n}


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

    def definition(label):
        d = d5.variant(
            d5.TYPICAL,
            profile={"protocol_major": 1, "pins": PINS_V5},
            election_id=det("election " + label),
            questions=[d5.q(*x) for x in QUESTIONS],
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
        )
        assert d5.definition_rule(d) is None, (label, d5.definition_rule(d))
        enc = d5.enc_definition_v5(d)
        return dict(
            rules(QUESTIONS, 2, 3),
            label=label,
            encoding=enc,
            definitionHash=b3.H(b3.ds(b3.DEFINITION_TAG, enc)),
            cells=cells,
        )

    questions = definition("questions")
    other = definition("questions-other")
    elections = {"questions": questions, "other": other}

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

    def ballot(label, election, cell, nul, answers, share_hashes, vote_rules=None):
        votes = b3.flat(answers)
        ctx = {"definitionHash": election["definitionHash"], "cell": cell, "nullifier": nul}
        vote, _, _, _ = b3.make_ballot("records/" + label, vote_rules or election, ctx, votes, share_hashes=share_hashes)
        r = (21_000_000 + int.from_bytes(det("ref " + label)[:2], "big"), det("ref hash " + label))
        return {
            "definitionHash": election["definitionHash"],
            "cell": cell,
            "nullifier": nul,
            "l1RefNumber": r[0],
            "l1RefHash": r[1],
            "vote": vote,
            "committedVote": b3.enc_committed_vote(vote),
        }

    zero3 = [det("share 1"), det("share 2"), bytes(32)]
    full3 = [det("share 1"), det("share 2"), det("share 3")]
    cases = []

    def case(cid, description, election, registered, b, proof, expect=None):
        cases.append(
            {"id": cid, "description": description, "election": election, "registered": registered, "ballot": b, "proof": proof, "expect": expect or cid}
        )

    e = questions
    # Honest ballots, one in each cell.
    b_a = ballot("cell-0", e, 0, nullifier("r0/1", e, 0), [(3, [1]), (4, [0, 3]), (2, [1])], zero3)
    prove("cell-0", "r0/1", e, 0, b_a)
    case("ok-cell-0", "A member of tier 0's large region answers all three questions in cell 0", "questions", [1, 2], b_a, "cell-0", "ok")

    b_rev = ballot("revote", e, 0, nullifier("r0/1", e, 0), [(3, []), (4, [2]), (2, [0])], zero3)
    prove("revote", "r0/1", e, 0, b_rev)
    case("ok-revote", "The same member's re-vote: the same nullifier, every question answered again", "questions", [1, 2], b_rev, "revote", "ok")

    b_r = ballot("remainder", e, 1, nullifier("r2/1", e, 1), [(3, [2]), (4, []), (2, [0])], zero3)
    prove("remainder", "r2/1", e, 1, b_r)
    case("ok-remainder", "A member of small region 2 in the remainder cell 1, skipping the pick-up-to-two question", "questions", [1, 2], b_r, "remainder", "ok")

    b_t2 = ballot("tier-2", e, 2, nullifier("t2/2", e, 2), [(3, []), (4, []), (2, [1])], zero3)
    prove("tier-2", "t2/2", e, 2, b_t2)
    case("ok-tier-2-least", "A tier 2 member in cell 2 answering only the pick-exactly-one question", "questions", [1, 2], b_t2, "tier-2", "ok")

    b_all = ballot("all-seats", e, 0, nullifier("r0/2", e, 0), [(3, [0]), (4, [1, 2]), (2, [0])], full3)
    prove("all-seats", "r0/2", e, 0, b_all)
    case("ok-every-seat", "A ballot with a share hash at every seat, under a key set that registers all three", "questions", [1, 2, 3], b_all, "all-seats", "ok")
    case("share-hash-unqualified", "The same ballot when seat 3 isn't registered: its share hash isn't 32 zero bytes", "questions", [1, 2], b_all, "all-seats")

    # Rejected before the membership proof.
    b_other = ballot("other-election", other, 0, nullifier("r0/0", other, 0), [(3, [0]), (4, []), (2, [0])], zero3)
    prove("other-election", "r0/0", other, 0, b_other)
    case("ballot-stray", "Another election's ballot (the same electorate and questions, another election_id)", "questions", [1, 2], b_other, "other-election")
    case("ballot-cell", "A ballot naming cell 3: the partition has cells 0 to 2", "questions", [1, 2], dict(b_a, cell=3), "cell-0")
    case("ballot-cell-255", "A ballot naming cell 255, the largest u8", "questions", [1, 2], dict(b_a, cell=255), "cell-0", "ballot-cell")
    # The same flat width, but question 2 made as pick up to one: its range
    # proof has two branches where the election's has one.
    b_shape = ballot("shape", e, 0, nullifier("r0/0", e, 0), [(3, [0]), (4, []), (2, [0])], zero3, vote_rules=rules([(3, 0, 1), (4, 0, 2), (2, 0, 1)], 2, 3))
    case("validity-shape", "A ballot whose last range proof has two branches: question 2 is pick exactly one, a range of one value", "questions", [1, 2], b_shape, "cell-0")
    b_shape_q = ballot("shape-questions", e, 0, nullifier("r0/0", e, 0), [(3, [0]), (6, [])], zero3, vote_rules=rules([(3, 0, 1), (6, 0, 3)], 2, 3))
    case("validity-shape-questions", "A ballot over two questions of the same nine flat options: one range proof too few", "questions", [1, 2], b_shape_q, "cell-0", "validity-shape")

    # Membership failures.
    case("membership-ref-changed", "The cell 0 ballot naming the next L1 block: M changes, so its proof fails", "questions", [1, 2], dict(b_a, l1RefNumber=b_a["l1RefNumber"] + 1), "cell-0", "membership-proof")
    case("membership-other-ballot-proof", "The cell 0 ballot carrying the re-vote's valid proof", "questions", [1, 2], b_a, "revote", "membership-proof")
    b_oc = ballot("other-cell", e, 1, nullifier("r0/0", e, 0), [(3, [1]), (4, []), (2, [0])], zero3)
    prove("other-cell", "r0/0", e, 0, b_oc)
    case("membership-other-cell", "A cell 0 member's proof under cell 0's root and scope, on a ballot naming cell 1 of the same tier", "questions", [1, 2], b_oc, "other-cell", "membership-proof")

    # Validity failures behind a valid membership proof.
    b_two = ballot("vote-of-two", e, 1, nullifier("r1/0", e, 1), [(3, []), (4, []), (2, [1])], zero3)
    b_two_votes = b3.flat([(3, []), (4, []), (2, [1])])
    b_two_votes[4] = 2
    vote, _, _, _ = b3.make_ballot("records/vote-of-two", e, ctx_of(b_two), b_two_votes, share_hashes=zero3)
    b_two = dict(b_two, vote=vote, committedVote=b3.enc_committed_vote(vote))
    prove("vote-of-two", "r1/0", e, 1, b_two)
    case("option-proof", "A vote of 2 for flat option 4, question 1's second option: the first failing flat option", "questions", [1, 2], b_two, "vote-of-two")
    b_q1 = ballot("question-1-over", e, 1, nullifier("r1/1", e, 1), [(3, []), (4, [0, 1, 2]), (2, [0])], zero3)
    prove("question-1-over", "r1/1", e, 1, b_q1)
    case("sum-proof", "Three of question 1's options where it allows two, with question 0 blank: the poll's total would fit, question 1 doesn't", "questions", [1, 2], b_q1, "question-1-over")
    b_q2 = ballot("question-2-blank", e, 1, nullifier("r1/1", e, 1), [(3, [0]), (4, [1]), (2, [])], zero3)
    prove("question-2-blank", "r1/1", e, 1, b_q2)
    case("sum-proof-exactly", "Question 2, pick exactly one, left blank: a pick-exactly-N question can't be skipped", "questions", [1, 2], b_q2, "question-2-blank", "sum-proof")

    # The order of the checks, where two would fail: the earlier code is the result.
    case("order-unqualified-before-membership", "An unregistered seat's share hash and another ballot's proof: share-hash-unqualified comes first", "questions", [1, 2], b_all, "tier-2", "share-hash-unqualified")
    case("order-membership-before-option", "A vote of 2 and another ballot's proof: membership-proof comes first", "questions", [1, 2], b_two, "cell-0", "membership-proof")
    case("order-shape-before-unqualified", "The wrong range-proof shape beside an unregistered seat's share hash: validity-shape comes first", "questions", [1, 2], dict(b_shape, vote=dict(b_shape["vote"], shareHashes=full3), committedVote=b3.enc_committed_vote(dict(b_shape["vote"], shareHashes=full3))), "cell-0", "validity-shape")

    # --- Intake (intake-v3.json): ballots whose share hashes are their own ciphertexts'.

    keys = se.trustee_keys("intake-v3", PANEL)
    intakes = []

    def encrypted(label, cell, member, answers, cheat=None, vote_rules=None, votes=None):
        """A member's ballot with real ciphertexts for seats 1 to 3; `cheat` alters seat 1's ciphertext."""
        nul = nullifier(member, e, cell)
        ctx = {"definitionHash": e["definitionHash"], "cell": cell, "nullifier": nul}
        votes = votes or b3.flat(answers)
        r_ = vote_rules or e
        first, _, shares, _ = b3.make_ballot("intake/" + label, r_, ctx, votes, share_hashes=[bytes(32)] * PANEL)
        rng = bv.Rng("intake-v3/encapsulation/" + label)
        cts = []
        for seat in range(1, PANEL + 1):
            m, e_, w = rng.bytes32(), se.nonzero_scalar(rng), se.nonzero_scalar(rng)
            sb = bv.enc_shares(shares[(1 if cheat == "other-shares" and seat == 1 else seat - 1)])
            ct, _ = se.encrypt(e["definitionHash"], seat, keys[seat - 1], first["vss"], sb, m, e_, w)
            if cheat == "flipped-seal" and seat == 1:
                # The last byte of the AEAD tag: the proof of knowledge binds `sealed`.
                ct = ct[:-1] + bytes([ct[-1] ^ 1])
            cts.append(ct)
        vote, _, _, _ = b3.make_ballot("intake/" + label, r_, ctx, votes, share_hashes=[se.share_hash(ct) for ct in cts])
        assert vote["vss"] == first["vss"]
        r = (21_000_000 + int.from_bytes(det("intake ref " + label)[:2], "big"), det("intake ref hash " + label))
        b = {
            "definitionHash": e["definitionHash"],
            "cell": cell,
            "nullifier": nul,
            "l1RefNumber": r[0],
            "l1RefHash": r[1],
            "vote": vote,
            "committedVote": b3.enc_committed_vote(vote),
            "cts": cts,
            "proof": "intake/" + label,
        }
        prove("intake/" + label, member, e, cell, b)
        return b

    def intake_case(cid, description, b, seat, ct, registered=(1, 2, 3), expect=None, record=None):
        intakes.append({
            "id": "intake-" + cid,
            "description": description,
            "ballot": b,
            "seat": seat,
            "ciphertext": ct,
            "registered": list(registered),
            "expect": expect or cid,
            "record": record,
        })

    ok = encrypted("cell-0", 0, "r0/0", [(3, [2]), (4, [1, 3]), (2, [0])])
    for seat in (1, 2, 3):
        intake_case(f"ok-seat-{seat}", f"A cell 0 member's three answers, delivered to seat {seat} with its own ciphertext", ok, seat, ok["cts"][seat - 1], expect="ok")
    rem = encrypted("remainder", 1, "r1/1", [(3, []), (4, []), (2, [1])])
    intake_case("ok-remainder", "A remainder-cell member answering only the pick-exactly-one question, at seat 2", rem, 2, rem["cts"][1], expect="ok")
    intake_case("delivery-malformed-version", "The cell 0 ballot under version 2, which the election doesn't pin", ok, 1, ok["cts"][0], expect="delivery-malformed", record="version-2")
    intake_case("delivery-malformed-truncated", "The cell 0 ballot without its last byte", ok, 1, ok["cts"][0], expect="delivery-malformed", record="truncated")
    intake_case("ballot-stray", "The cell 0 ballot naming the other election's definition hash", dict(ok, definitionHash=other["definitionHash"]), 1, ok["cts"][0])
    intake_case("ballot-cell", "The cell 0 ballot naming cell 3: the partition has cells 0 to 2", dict(ok, cell=3), 1, ok["cts"][0])
    shape = encrypted("shape", 0, "r0/1", [(3, [0]), (4, []), (2, [0])], vote_rules=rules([(3, 0, 1), (4, 0, 2), (2, 0, 1)], 2, 3))
    intake_case("validity-shape", "A ballot whose last range proof has two branches where question 2's range has one value", shape, 1, shape["cts"][0])
    intake_case("share-hash-unqualified", "The cell 0 ballot under a key set without seat 3, whose share hash isn't zero", ok, 1, ok["cts"][0], registered=(1, 2))
    intake_case("share-hash", "Seat 2's ciphertext delivered to seat 1", ok, 1, ok["cts"][1])
    moved = dict(ok, l1RefNumber=ok["l1RefNumber"] + 1)
    intake_case("membership-ref-changed", "The cell 0 ballot naming the next L1 block: M changes, so its proof fails", moved, 1, ok["cts"][0], expect="membership-proof")
    intake_case("order-share-hash-before-membership", "A failing membership proof and seat 2's ciphertext at seat 1: share-hash comes first", moved, 1, ok["cts"][1], expect="share-hash")
    two_votes = b3.flat([(3, []), (4, [0]), (2, [1])])
    two_votes[0] = 2
    two = encrypted("vote-of-two", 0, "r0/2", None, votes=two_votes)
    intake_case("option-proof", "A vote of 2 at flat option 0, whose shares open", two, 1, two["cts"][0])
    over = encrypted("question-1-over", 1, "r2/0", [(3, [0]), (4, [0, 1, 2]), (2, [0])])
    intake_case("sum-proof", "Three of question 1's options where it allows two, whose shares open", over, 3, over["cts"][2])
    seal = encrypted("flipped-seal", 2, "t2/0", [(3, [1]), (4, [3]), (2, [1])], cheat="flipped-seal")
    intake_case("share-proof", "A tier 2 member's valid ballot whose client flipped a tag byte of seat 1's ciphertext after proving it", seal, 1, seal["cts"][0])
    intake_case("ok-beside-bad-seat", "The same ballot at seat 2, whose ciphertext is honest", seal, 2, seal["cts"][1], expect="ok")
    wrong = encrypted("other-shares", 2, "t2/1", [(3, [0]), (4, []), (2, [0])], cheat="other-shares")
    intake_case("share-check", "A valid ballot whose client sealed seat 2's shares to seat 1", wrong, 1, wrong["cts"][0])
    intake_case("order-membership-before-sum", "An over-limit question and a failing membership proof: membership-proof comes first", dict(over, l1RefNumber=over["l1RefNumber"] + 1), 3, over["cts"][2], expect="membership-proof")

    checks = []
    for c in cases:
        sig = verifier_signals(elections[c["election"]], c["ballot"])
        if sig is not None:
            checks.append({"case": c["id"], "proof": c["proof"], "signals": {k: str(v) for k, v in sig.items()}})
    for c in intakes:
        if c["record"] is not None:
            continue
        sig = verifier_signals(e, c["ballot"])
        if sig is not None:
            checks.append({"case": c["id"], "proof": c["ballot"]["proof"], "signals": {k: str(v) for k, v in sig.items()}})
    return {"secrets": secrets, "groups": groups, "elections": elections, "cells": cells, "proofs": proofs, "cases": cases, "checks": checks, "intakes": intakes, "keys": keys}


def hexb(b):
    return b.hex()


def statements(constants, out):
    s = build(constants)
    pathlib.Path(out).write_text(json.dumps({"proofs": list(s["proofs"].values()), "checks": s["checks"]}, indent=2) + "\n")


def assemble(constants, proofs_path, out_dir):
    s = build(constants)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    proof_bytes = {k: bytes.fromhex(v) for k, v in got["proofs"].items()}
    verdicts = got["verdicts"]
    assert set(proof_bytes) == set(s["proofs"])

    def record(c):
        return enc_ballot(dict(c["ballot"], proof=proof_bytes[c["proof"]]))

    elections = {}
    for name, e in s["elections"].items():
        elections[name] = {
            "definition": hexb(e["encoding"]),
            "definitionHash": hexb(e["definitionHash"]),
            "questions": [
                {"optionCount": q["optionCount"], "minSelections": q["min"], "maxSelections": q["max"], "offset": o}
                for q, o in zip(e["questions"], e["offsets"])
            ],
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

    ballots = []
    for c in s["cases"]:
        e = s["elections"][c["election"]]
        b = c["ballot"]
        sig = verifier_signals(e, b)
        verdict = verdicts.get(c["id"])
        assert (sig is None) == (verdict is None), c["id"]
        code, at = admission(e, c["registered"], b, verdict)
        assert code == c["expect"], (c["id"], code)
        v = {
            "id": c["id"],
            "description": c["description"],
            "election": c["election"],
            "registered": c["registered"],
            "encoding": hexb(record(c)),
            "statementHash": hexb(b3.statement_hash(ctx_of(b), b["vote"]["vss"], b["vote"]["shareHashes"])),
            "ballotHash": hexb(bh_of(b)),
        }
        if sig is not None:
            tier = e["cells"][b["cell"]]["tier"]
            v["message"] = hexb(rev.message(b["definitionHash"], tier, bh_of(b), b["l1RefNumber"], b["l1RefHash"]))
            v["signals"] = {k: str(x) for k, x in sig.items()}
            v["snarkjs"] = verdict
        v["result"] = code
        if code == "option-proof":
            v["option"] = at
        if code == "sum-proof":
            v["question"] = at
        if code == "ok":
            v["tier"] = e["cells"][b["cell"]]["tier"]
        ballots.append(v)

    good = bytes.fromhex(ballots[0]["encoding"])
    assert ballots[0]["id"] == "ok-cell-0"
    proof_at = 3 + 32 + 1 + 32 + 8 + 32
    vote_at = proof_at + PROOF_LEN

    def with_bytes(at, new):
        return good[:at] + new + good[at + len(new):]

    # The last range proof's last scalar, z, set to ℓ: the end of the record.
    last_z = len(good) - 32
    first_element = vote_at + 4 + 4
    decode = [
        ("truncated", "The cell 0 ballot without its last byte", good[:-1], "truncated", None),
        ("trailing-byte", "The cell 0 ballot with a byte after its last range proof", good + b"\x00", "trailing-bytes", len(good)),
        ("header-only", "A version-3 ballot record header with nothing after it", good[:3], "truncated", 3),
        ("nullifier-r", "A nullifier equal to the BN254 scalar field order", with_bytes(36, R.to_bytes(32, "big")), "non-canonical", 36),
        ("vss-identity", "A committed vote whose first VSS commitment is the identity", with_bytes(first_element, bytes(32)), "non-canonical", first_element),
        ("range-z-order", "The last range proof's last z equal to the group order ℓ", with_bytes(last_z, b3.L.to_bytes(32, "little")), "non-canonical", last_z),
        ("version-2", "The same bytes under version 2, which a profile pinning version 3 refuses", with_bytes(2, b"\x02"), "profile-mismatch", 2),
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
        "title": "Ballot record, version 3 (questions, naming its cell): encodings, admission checks and decode rejections",
        "spec": "docs/spec/ballot-validity.md",
        "generator": (
            "packages/crypto/scripts/ballot-v3-records-vectors.py, an implementation of the Ballot record (version 3) "
            "section with Python's integers and hashlib, reusing this folder's independent ballot-v2, ballot-v3, "
            "membership, revoting and definition-v5 generators; cell trees built by ballot-v2-vectors.py from each "
            "tier's groups by the first-occurrence rule; membership proofs by packages/crypto/scripts/ballot-proofs.mjs, "
            "run outside the workspace with Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5's fullProve, "
            "which checks that each proof's outputs equal the root and nullifier computed here; every pairing verdict is "
            "snarkjs's groth16.verify on the signals derived here from the record and the definition. Decode errors and "
            "their offsets are labelled by hand from the strict-decoding rules and the layout's fixed offsets"
        ),
        "recordType": "0x0002",
        "version": VERSION,
        "elections": elections,
        "ballots": ballots,
        "decode": decode_vectors,
    }
    (pathlib.Path(out_dir) / "ballot-v3-records.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    e = s["elections"]["questions"]
    keys = s["keys"]
    out_cases = []
    for c in s["intakes"]:
        b = c["ballot"]
        rec = enc_ballot(dict(b, proof=proof_bytes[b["proof"]]))
        if c["record"] == "truncated":
            rec = rec[:-1]
        elif c["record"] == "version-2":
            rec = rec[:2] + b"\x02" + rec[3:]
        if c["record"] is not None:
            result = {"code": "delivery-malformed"}
        else:
            result = intake(e, c["registered"], c["seat"], keys, b, c["ciphertext"], verdicts.get(c["id"]))
        assert result["code"] == c["expect"], (c["id"], result["code"])
        v = {
            "id": c["id"],
            "description": c["description"],
            "election": "questions",
            "registered": c["registered"],
            "seat": c["seat"],
            "record": rec.hex(),
            "ciphertext": c["ciphertext"].hex(),
            "result": result["code"],
        }
        for key in ("option", "question"):
            if key in result:
                v[key] = result[key]
        if c["id"] in verdicts:
            v["snarkjs"] = verdicts[c["id"]]
        if result["code"] == "ok":
            v.update({
                "ballotHash": result["ballotHash"].hex(),
                "shareHash": result["shareHash"].hex(),
                "statement": result["statement"].hex(),
                "receipt": result["receipt"].hex(),
                "tier": result["tier"],
                "nullifier": str(b["nullifier"]),
                "message": result["message"].hex(),
                "l1RefNumber": str(b["l1RefNumber"]),
                "l1RefHash": b["l1RefHash"].hex(),
            })
        out_cases.append(v)
    out = {
        "format": "abolish-intake-vectors/1",
        "title": "Trustee intake of a version-3 ballot record: admission over the questions with its membership proof, the share hash, decryption and the share receipt",
        "spec": "docs/spec/share-encryption.md",
        "generator": (
            "packages/crypto/scripts/ballot-v3-records-vectors.py, as for ballot-v3-records.json, with Intake and receipts "
            "implemented over version 3's admission, reusing share-encryption-vectors.py (KEM keys, encryption, decryption) "
            "and share-receipt-vectors.py (the receipt and its RFC 6979 P-256 signature); membership proofs and pairing "
            "verdicts from snarkjs as for ballot-v3-records.json. The delivery-malformed cases are labelled by hand from "
            "the strict-decoding rules"
        ),
        "tags": {"receipt": "abolish/v1/sig/share-receipt"},
        "elections": {"questions": {"version": 3, "definition": e["encoding"].hex(), "definitionHash": e["definitionHash"].hex()}},
        "panel": [
            {
                "seat": seat,
                "kem": se.key_json(keys[seat - 1]),
                "signingSecret": f"{signing_secret(seat):064x}",
                "signingKey": sr.p256_key(signing_secret(seat)).hex(),
            }
            for seat in range(1, PANEL + 1)
        ],
        "cases": out_cases,
    }
    (pathlib.Path(out_dir) / "intake-v3.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    cmd = sys.argv[1]
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: ballot-v3-records-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
