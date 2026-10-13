#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/intake-v4.json.

A second implementation of docs/spec/share-encryption.md, Ballot version 4:
trustee intake of a whole version-4 ballot record at a seat of either panel
(Decryption and intake (ballot version 4): Intake and receipts' order, with
`share-hash-unqualified` over both panels and `share-hash` against the seat's
own panel's list, then decryption against its own panel's commitments), and
the seat's share receipt under `abolish/v1/sig/share-receipt-2` over
`definition_hash ‖ ballot_hash ‖ u8(panel) ‖ u8(i) ‖ H(ct_i)` (Share receipt
(ballot version 4)), with receipt checks passing and failing. It is written
from the spec with Python's integers and hashlib and shares no code with
packages/crypto. It reuses only this folder's other independent generators:
ballot-v4-records-vectors.py's elections (definition version 6, with a 2-of-3
author panel and without one), record encoder, admission in order and
membership signals; ballot-v2-vectors.py's electorate and Merkle paths;
ballot-v4-vectors.py's version-4 ballots; share-encryption-v4-vectors.py's
version-4 encryption and decryption; and trustee-vectors.py's RFC 6979 P-256
ECDSA, through share-receipt-vectors.py.

Membership proofs need a Groth16 prover, so generation has three steps, as
for ballot-v4-records-vectors.py:

  python3 -I -B intake-v4-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B intake-v4-vectors.py assemble <constants> <work>/proofs.json <out-dir>

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


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


r4 = _load("ballot_v4_records_vectors", "ballot-v4-records-vectors.py")
sev4 = _load("share_encryption_v4_vectors", "share-encryption-v4-vectors.py")
sr = _load("share_receipt_vectors", "share-receipt-vectors.py")
b1, b2, b3, b4, rev, mem = r4.b1, r4.b2, r4.b3, r4.b4, r4.rev, r4.mem
se, bv, ecdsa = sev4.se, sev4.bv, sr.ecdsa

DEFAULT, AUTHOR = r4.DEFAULT, r4.AUTHOR
DEPTH = r4.DEPTH
RECEIPT_TAG_2 = b"abolish/v1/sig/share-receipt-2"
PANEL_NAMES = {DEFAULT: "default", AUTHOR: "author"}


def det(label):
    return hashlib.sha256(b"abolish intake v4 vectors " + label.encode()).digest()


# --- Share receipt (ballot version 4) ---------------------------------------------


def statement(definition_hash, b_hash, panel, seat, share_hash):
    """m = definition_hash ‖ ballot_hash ‖ u8(panel) ‖ u8(i) ‖ H(ct_i): 98 bytes."""
    m = definition_hash + b_hash + bv.u8(panel) + bv.u8(seat) + share_hash
    assert len(m) == 98
    return m


def sign(d, m, tag=RECEIPT_TAG_2):
    return sr.sign(d, m, tag)


def check_receipt(signers, definition_hash, b_hash, panel, seat, share_hash, sig):
    """`share-receipt` under version 4: the seat's signing key from its own panel's registered key set."""
    if panel not in (DEFAULT, AUTHOR) or not 1 <= seat <= se.MAX_TRUSTEES:
        return False
    key = signers[panel].get(seat)
    if key is None:
        return False
    return ecdsa.verify(key, bv.ds(RECEIPT_TAG_2, statement(definition_hash, b_hash, panel, seat, share_hash)), sig)


def signing_secret(panel, seat):
    return ecdsa.secret(f"intake-v4/{PANEL_NAMES[panel]}/signing/{seat}".encode())


def identity_secret(panel, seat):
    return ecdsa.secret(f"intake-v4/{PANEL_NAMES[panel]}/identity/{seat}".encode())


# --- Intake (ballot version 4) ----------------------------------------------------


def intake(election, registered, author_registered, panel, seat, keys, b, ct, verdict):
    """Intake steps 2 to 5 on a decoded version-4 record at a seat of `panel`: admission with `share-hash` against the seat's own panel's list before the membership proof, then decryption against its own panel's commitments."""
    sh = se.share_hash(ct)
    a = r4.admission(election, registered, author_registered, b, verdict, (panel, seat, sh))
    if a["code"] != "ok":
        return a
    got = sev4.decrypt(election["definitionHash"], panel, seat, keys[panel][seat - 1], b["vote"], ct)
    if got != "ok":
        return {"code": got}
    m = statement(election["definitionHash"], a["ballotHash"], panel, seat, sh)
    return dict(a, shareHash=sh, statement=m, receipt=sign(signing_secret(panel, seat), m))


PANEL = 3


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    b1.bjj_self_check()
    mem.self_check()
    ecdsa.self_check()
    se.aead_self_check()
    se.mlkem_self_check(100)
    pos = b1.Poseidon(constants)
    secrets, groups, _ = b2.build_electorate(pos)
    elections = r4.build(constants)["elections"]
    e = elections["panels"]
    plain = elections["default-only"]
    assert (e["authorThreshold"], e["authorPanelSize"]) == (2, PANEL)
    assert (plain["authorThreshold"], plain["authorPanelSize"]) == (0, 0)
    cells = e["cells"]

    # Each panel's KEM keys. An author panel's keys come from its own ceremony
    # (P2-16 part 3); these are test keys for its seats.
    keys = {DEFAULT: se.trustee_keys("intake-v4/default", PANEL), AUTHOR: se.trustee_keys("intake-v4/author", PANEL)}

    def where(label, cell):
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

    proofs = {}

    def prove(pid, label, election, cell, b):
        c = cells[cell]
        s = secrets[label]
        i = where(label, cell)
        sib = c["path"](i)
        sc = scope(election, cell)
        msg = rev.message(election["definitionHash"], c["tier"], r4.bh_of(b), b["l1RefNumber"], b["l1RefHash"])
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

    def encrypted(label, election, cell, member, answers=None, votes=None, cheat=None, vote_rules=None):
        """A member's ballot with real ciphertexts to every seat of both panels; `cheat(panel, seat, shares_bytes, all_shares, key, halves, m, e, w)` may alter a seat's ciphertext."""
        nul = pos(scope(election, cell), secrets[member])
        ctx = {"definitionHash": election["definitionHash"], "cell": cell, "nullifier": nul}
        votes = votes or b3.flat(answers)
        r_ = vote_rules or election
        n, n_a = r_["panelSize"], r_["authorPanelSize"]
        # make_ballot draws the polynomials first, so the second call, with
        # the real share hashes, keeps the same halves and shares.
        first, _, shares, author_shares = b4.make_ballot("intake-v4/" + label, r_, ctx, votes, share_hashes=[bytes(32)] * n, author_share_hashes=[bytes(32)] * n_a)
        halves = {"vss": first["vss"], "authorVss": first["authorVss"]}
        all_shares = {DEFAULT: shares, AUTHOR: author_shares}
        rng = bv.Rng("intake-v4/encapsulation/" + label)
        cts = {}
        for panel, seat_shares in all_shares.items():
            cts[panel] = []
            for seat in range(1, len(seat_shares) + 1):
                m, ee, w = rng.bytes32(), se.nonzero_scalar(rng), se.nonzero_scalar(rng)
                sb = bv.enc_shares(seat_shares[seat - 1])
                key = keys[panel][seat - 1]
                if cheat is not None:
                    ct = cheat(panel, seat, sb, all_shares, key, halves, m, ee, w)
                else:
                    ct, _ = sev4.encrypt(election["definitionHash"], panel, seat, key, halves, sb, m, ee, w)
                cts[panel].append(ct)
        vote, _, _, _ = b4.make_ballot(
            "intake-v4/" + label,
            r_,
            ctx,
            votes,
            share_hashes=[se.share_hash(ct) for ct in cts[DEFAULT]],
            author_share_hashes=[se.share_hash(ct) for ct in cts[AUTHOR]],
        )
        assert vote["vss"] == first["vss"] and vote["authorVss"] == first["authorVss"], label
        r = (21_000_000 + int.from_bytes(det("ref " + label)[:2], "big"), det("ref hash " + label))
        b = {
            "definitionHash": election["definitionHash"],
            "cell": cell,
            "nullifier": nul,
            "l1RefNumber": r[0],
            "l1RefHash": r[1],
            "vote": vote,
            "committedVote": b4.enc_committed_vote(vote),
            "cts": cts,
            "proof": label,
        }
        prove(label, member, election, cell, b)
        return b

    intakes = []

    def intake_case(cid, description, b, panel, seat, ct, election="panels", registered=(1, 2, 3), author_registered=(1, 2, 3), expect=None, record=None):
        intakes.append(
            {
                "id": "intake-" + cid,
                "description": description,
                "election": election,
                "ballot": b,
                "panel": panel,
                "seat": seat,
                "ciphertext": ct,
                "registered": list(registered),
                "authorRegistered": list(author_registered),
                "expect": expect or cid,
                "record": record,
            }
        )

    def cheat_at(target, make):
        """A cheat that changes only `target`'s (panel, seat) ciphertext, through `make`."""

        def cheat(panel, seat, sb, all_shares, key, halves, m, ee, w):
            if (panel, seat) == target:
                return make(panel, seat, sb, all_shares, key, halves, m, ee, w)
            ct, _ = sev4.encrypt(e["definitionHash"], panel, seat, key, halves, sb, m, ee, w)
            return ct

        return cheat

    defh = e["definitionHash"]
    ok = encrypted("cell-0", e, 0, "r0/1", [(3, [1]), (4, [0, 3]), (2, [1])])
    for seat in (1, 2, 3):
        intake_case(f"ok-default-{seat}", f"A cell 0 member's ballot at default seat {seat}, with that seat's own ciphertext", ok, DEFAULT, seat, ok["cts"][DEFAULT][seat - 1], expect="ok")
        intake_case(f"ok-author-{seat}", f"The same ballot at author seat {seat}, with that seat's own ciphertext", ok, AUTHOR, seat, ok["cts"][AUTHOR][seat - 1], expect="ok")
    plain_b = encrypted("default-only", plain, 1, "r2/1", [(3, []), (4, [2]), (2, [0])])
    for seat in (1, 3):
        intake_case(f"ok-default-only-{seat}", f"A poll without an author panel: a remainder-cell ballot at default seat {seat}", plain_b, DEFAULT, seat, plain_b["cts"][DEFAULT][seat - 1], election="default-only", author_registered=(), expect="ok")

    # Before decryption: intake's admission, as ballot-v4-records.json's intakes, on real ciphertexts.
    intake_case("delivery-malformed-version", "The cell 0 ballot under version 3, which the election doesn't pin", ok, AUTHOR, 1, ok["cts"][AUTHOR][0], expect="delivery-malformed", record="version-3")
    intake_case("delivery-malformed-truncated", "The cell 0 ballot without its last byte", ok, AUTHOR, 1, ok["cts"][AUTHOR][0], expect="delivery-malformed", record="truncated")
    intake_case("ballot-stray", "The cell 0 ballot naming the other election's definition hash", dict(ok, definitionHash=elections["other"]["definitionHash"]), AUTHOR, 1, ok["cts"][AUTHOR][0])
    intake_case("ballot-cell", "The cell 0 ballot naming cell 3: the partition has cells 0 to 2", dict(ok, cell=3), AUTHOR, 1, ok["cts"][AUTHOR][0])
    no_half = encrypted("no-author-half", e, 0, "r0/0", [(3, [0]), (4, []), (2, [0])], vote_rules=r4.rules(r4.QUESTIONS, 2, 3, 0, 0))
    intake_case("validity-shape", "A ballot without an author half in a poll with an author panel, at default seat 1", no_half, DEFAULT, 1, no_half["cts"][DEFAULT][0])
    intake_case("share-hash-unqualified", "The cell 0 ballot at default seat 1 under an author key set without seat 3, whose share hash isn't zero", ok, DEFAULT, 1, ok["cts"][DEFAULT][0], author_registered=(1, 2), expect="share-hash-unqualified")
    intake_case("share-hash-author-at-default", "Author seat 1's ciphertext delivered to default seat 1: a seat of one panel never takes the other's", ok, DEFAULT, 1, ok["cts"][AUTHOR][0], expect="share-hash")
    intake_case("share-hash-default-at-author", "Default seat 2's ciphertext delivered to author seat 2", ok, AUTHOR, 2, ok["cts"][DEFAULT][1], expect="share-hash")
    intake_case("share-hash", "Author seat 3's ciphertext delivered to author seat 1", ok, AUTHOR, 1, ok["cts"][AUTHOR][2])
    moved = dict(ok, l1RefNumber=ok["l1RefNumber"] + 1)
    intake_case("membership-ref-changed", "The cell 0 ballot naming the next L1 block, at author seat 2: M changes, so its proof fails", moved, AUTHOR, 2, ok["cts"][AUTHOR][1], expect="membership-proof")
    intake_case("order-share-hash-before-membership", "A failing membership proof and default seat 2's ciphertext at author seat 2: share-hash comes first", moved, AUTHOR, 2, ok["cts"][DEFAULT][1], expect="share-hash")
    two_votes = b3.flat([(3, []), (4, [0]), (2, [1])])
    two_votes[0] = 2
    two = encrypted("vote-of-two", e, 0, "r0/2", votes=two_votes)
    intake_case("option-proof", "A vote of 2 at flat option 0, whose shares open, at author seat 1", two, AUTHOR, 1, two["cts"][AUTHOR][0])
    over = encrypted("question-1-over", e, 1, "r2/0", [(3, [0]), (4, [0, 1, 2]), (2, [0])])
    intake_case("sum-proof", "Three of question 1's options where it allows two, whose shares open, at author seat 3", over, AUTHOR, 3, over["cts"][AUTHOR][2])

    # Decryption at a seat of either panel: each step's failure.
    def truncated(panel, seat, sb, all_shares, key, halves, m, ee, w):
        ct, _ = sev4.encrypt(defh, panel, seat, key, halves, sb, m, ee, w)
        return ct[:-1]

    malformed = encrypted("author-malformed", e, 2, "t2/0", [(3, [2]), (4, [1]), (2, [1])], cheat=cheat_at((AUTHOR, 1), truncated))
    intake_case("share-malformed", "A valid ballot whose client cut the last byte off author seat 1's ciphertext and hashed what was left", malformed, AUTHOR, 1, malformed["cts"][AUTHOR][0])
    intake_case("ok-beside-malformed", "The same ballot at author seat 2, whose ciphertext is honest", malformed, AUTHOR, 2, malformed["cts"][AUTHOR][1], expect="ok")

    def as_default(panel, seat, sb, all_shares, key, halves, m, ee, w):
        ct, _ = sev4.encrypt(defh, DEFAULT, seat, key, halves, sb, m, ee, w)
        return ct

    named = encrypted("author-as-default", e, 2, "t2/1", [(3, []), (4, [3]), (2, [0])], cheat=cheat_at((AUTHOR, 1), as_default))
    intake_case("share-proof", "Author seat 1's shares to its own key, but bound as default seat 1", named, AUTHOR, 1, named["cts"][AUTHOR][0])

    def version_one(panel, seat, sb, all_shares, key, halves, m, ee, w):
        ct, _ = sev4.encrypt(defh, panel, seat, key, halves, sb, m, ee, w, version=1)
        return ct

    v1 = encrypted("author-version-one", e, 0, "r0/2", [(3, [0]), (4, [1]), (2, [1])], cheat=cheat_at((AUTHOR, 2), version_one))
    intake_case("share-proof-version-one", "Author seat 2's ciphertext made under ballot version 1's rules", v1, AUTHOR, 2, v1["cts"][AUTHOR][1], expect="share-proof")

    def short_list(panel, seat, sb, all_shares, key, halves, m, ee, w):
        n = int.from_bytes(sb[:4], "big") - 1
        ct, _ = sev4.encrypt(defh, panel, seat, key, halves, bv.u32(n) + sb[4 : 4 + 64 * n], m, ee, w)
        return ct

    short = encrypted("author-short-list", e, 1, "r1/0", [(3, [1]), (4, []), (2, [1])], cheat=cheat_at((AUTHOR, 3), short_list))
    intake_case("share-decrypt", "Author seat 3's plaintext lists T − 1 shares", short, AUTHOR, 3, short["cts"][AUTHOR][2])

    def default_shares(panel, seat, sb, all_shares, key, halves, m, ee, w):
        # The default half's shares for the same index, sealed honestly to the author seat.
        ct, _ = sev4.encrypt(defh, panel, seat, key, halves, bv.enc_shares(all_shares[DEFAULT][seat - 1]), m, ee, w)
        return ct

    swapped = encrypted("author-default-shares", e, 1, "r1/1", [(3, [2]), (4, [0, 1]), (2, [0])], cheat=cheat_at((AUTHOR, 1), default_shares))
    intake_case("share-check", "Author seat 1 sealed default seat 1's shares: they fail against the author half's commitments", swapped, AUTHOR, 1, swapped["cts"][AUTHOR][0])
    intake_case("ok-beside-swapped", "The same ballot at default seat 1, whose shares those are", swapped, DEFAULT, 1, swapped["cts"][DEFAULT][0], expect="ok")

    def author_shares(panel, seat, sb, all_shares, key, halves, m, ee, w):
        ct, _ = sev4.encrypt(defh, panel, seat, key, halves, bv.enc_shares(all_shares[AUTHOR][seat - 1]), m, ee, w)
        return ct

    reverse = encrypted("default-author-shares", e, 0, "r0/0", [(3, [1]), (4, [2]), (2, [1])], cheat=cheat_at((DEFAULT, 2), author_shares))
    intake_case("share-check-default", "Default seat 2 sealed author seat 2's shares: they fail against the default half's commitments", reverse, DEFAULT, 2, reverse["cts"][DEFAULT][1], expect="share-check")
    intake_case("order-membership-before-decryption", "Author seat 1's swapped shares and a failing membership proof: membership-proof comes first", dict(swapped, l1RefNumber=swapped["l1RefNumber"] + 1), AUTHOR, 1, swapped["cts"][AUTHOR][0], expect="membership-proof")

    checks = []
    for c in intakes:
        if c["record"] is not None:
            continue
        sig = r4.verifier_signals(elections[c["election"]], c["ballot"])
        if sig is not None:
            checks.append({"case": c["id"], "proof": c["ballot"]["proof"], "signals": {k: str(v) for k, v in sig.items()}})
    return {"elections": elections, "proofs": proofs, "checks": checks, "intakes": intakes, "keys": keys}


def statements(constants, out):
    s = build(constants)
    pathlib.Path(out).write_text(json.dumps({"proofs": list(s["proofs"].values()), "checks": s["checks"]}, indent=2) + "\n")


def assemble(constants, proofs_path, out_dir):
    s = build(constants)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    proof_bytes = {k: bytes.fromhex(v) for k, v in got["proofs"].items()}
    verdicts = got["verdicts"]
    assert set(proof_bytes) == set(s["proofs"])
    keys = s["keys"]

    out_cases = []
    receipts = {}
    for c in s["intakes"]:
        e = s["elections"][c["election"]]
        b = c["ballot"]
        rec = r4.enc_ballot(dict(b, proof=proof_bytes[b["proof"]]))
        if c["record"] == "truncated":
            rec = rec[:-1]
        elif c["record"] == "version-3":
            rec = rec[:2] + b"\x03" + rec[3:]
        verdict = verdicts.get(c["id"])
        if c["record"] is not None:
            result = {"code": "delivery-malformed"}
        else:
            assert (r4.verifier_signals(e, b) is None) == (verdict is None), c["id"]
            result = intake(e, c["registered"], c["authorRegistered"], c["panel"], c["seat"], keys, b, c["ciphertext"], verdict)
        assert result["code"] == c["expect"], (c["id"], result["code"])
        v = {
            "id": c["id"],
            "description": c["description"],
            "election": c["election"],
            "registered": c["registered"],
            "authorRegistered": c["authorRegistered"],
            "panel": c["panel"],
            "seat": c["seat"],
            "record": rec.hex(),
            "ciphertext": c["ciphertext"].hex(),
            "result": result["code"],
        }
        for key, name in (("option", "option"), ("question", "question"), ("panel", "unqualifiedPanel"), ("seat", "unqualifiedSeat")):
            if key in result:
                v[name] = result[key]
        if verdict is not None:
            v["snarkjs"] = verdict
        if result["code"] == "ok":
            v.update(
                ballotHash=result["ballotHash"].hex(),
                shareHash=result["shareHash"].hex(),
                statement=result["statement"].hex(),
                receipt=result["receipt"].hex(),
                tier=result["tier"],
                cell=b["cell"],
                nullifier=str(b["nullifier"]),
                message=result["message"].hex(),
                l1RefNumber=str(b["l1RefNumber"]),
                l1RefHash=b["l1RefHash"].hex(),
            )
            receipts[c["id"]] = (e, result)
        out_cases.append(v)

    # Receipt checks over the statement's fields, as share-receipt.json's.
    signers = {panel: {seat: sr.p256_key(signing_secret(panel, seat)) for seat in range(1, PANEL + 1)} for panel in (DEFAULT, AUTHOR)}
    e, a2 = receipts["intake-ok-author-2"]
    _, d2 = receipts["intake-ok-default-2"]
    _, a3 = receipts["intake-ok-author-3"]
    defh = e["definitionHash"]
    other_defh = s["elections"]["other"]["definitionHash"]
    checks = []

    def check(cid, description, panel, seat, ballot_hash, share_hash, sig, valid, definition_hash=defh, author_registered=(1, 2, 3)):
        reg = {DEFAULT: signers[DEFAULT], AUTHOR: {k: v for k, v in signers[AUTHOR].items() if k in author_registered}}
        got = check_receipt(reg, definition_hash, ballot_hash, panel, seat, share_hash, sig)
        assert got == valid, cid
        checks.append(
            {
                "id": cid,
                "description": description,
                "definitionHash": definition_hash.hex(),
                "ballotHash": ballot_hash.hex(),
                "panel": panel,
                "seat": seat,
                "shareHash": share_hash.hex(),
                "authorRegistered": list(author_registered),
                "signature": sig.hex(),
                "valid": valid,
            }
        )

    bh, sh, rc = a2["ballotHash"], a2["shareHash"], a2["receipt"]
    check("author-2", "Author seat 2's receipt from its intake", AUTHOR, 2, bh, sh, rc, True)
    check("default-2", "Default seat 2's receipt from its intake", DEFAULT, 2, bh, d2["shareHash"], d2["receipt"], True)
    check("author-as-default", "Author seat 2's receipt checked as default seat 2's, with its own share hash", DEFAULT, 2, bh, sh, rc, False)
    check("default-as-author", "Default seat 2's receipt checked as author seat 2's", AUTHOR, 2, bh, d2["shareHash"], d2["receipt"], False)
    check("other-seat", "Author seat 2's receipt checked as author seat 3's, with seat 3's share hash", AUTHOR, 3, bh, a3["shareHash"], rc, False)
    check("unregistered", "Author seat 2's receipt under an author key set without seat 2", AUTHOR, 2, bh, sh, rc, False, author_registered=(1, 3))
    check("seat-0", "A statement naming author seat 0", AUTHOR, 0, bh, sh, sign(signing_secret(AUTHOR, 2), statement(defh, bh, AUTHOR, 0, sh)), False)
    check("seat-17", "A statement naming author seat 17, past MAX_TRUSTEES", AUTHOR, 17, bh, sh, sign(signing_secret(AUTHOR, 2), statement(defh, bh, AUTHOR, 17, sh)), False)
    check("panel-3", "Author seat 2's key signing a statement naming panel 3", 3, 2, bh, sh, sign(signing_secret(AUTHOR, 2), statement(defh, bh, 3, 2, sh)), False)
    check("other-definition", "Author seat 2's receipt checked against the other election's definition hash", AUTHOR, 2, bh, sh, rc, False, definition_hash=other_defh)
    check("other-ballot", "Author seat 2's receipt checked against a ballot hash with its first bit flipped", AUTHOR, 2, bytes(b ^ 1 for b in bh[:1]) + bh[1:], sh, rc, False)
    check("other-share-hash", "Author seat 2's receipt checked with author seat 3's share hash", AUTHOR, 2, bh, a3["shareHash"], rc, False)
    v1 = sr.statement(defh, bh, 2, sh)
    check("version-one-tag", "Author seat 2's key signing the 97-byte version-1 statement under abolish/v1/sig/share-receipt", AUTHOR, 2, bh, sh, sr.sign(signing_secret(AUTHOR, 2), v1), False)
    check("version-one-tag-same-statement", "Author seat 2's key signing the 98-byte statement under version 1's tag", AUTHOR, 2, bh, sh, sr.sign(signing_secret(AUTHOR, 2), statement(defh, bh, AUTHOR, 2, sh)), False)
    check("identity-key", "The statement signed by author seat 2's identity key, not its signing key", AUTHOR, 2, bh, sh, sign(identity_secret(AUTHOR, 2), statement(defh, bh, AUTHOR, 2, sh)), False)
    r_, s_ = int.from_bytes(rc[:32], "big"), int.from_bytes(rc[32:], "big")
    check("high-s", "Author seat 2's receipt with s replaced by n − s", AUTHOR, 2, bh, sh, ecdsa.sig_bytes(r_, ecdsa.N - s_), False)
    check("altered", "Author seat 2's receipt with its last byte changed", AUTHOR, 2, bh, sh, rc[:-1] + bytes([rc[-1] ^ 1]), False)

    out = {
        "format": "abolish-intake-vectors/2",
        "title": "Trustee intake of a version-4 ballot record at a seat of either panel: admission over both panels with its membership proof, the share hash, decryption, the version-2 share receipt and its checks",
        "spec": "docs/spec/share-encryption.md",
        "generator": (
            "packages/crypto/scripts/intake-v4-vectors.py, an implementation of Decryption and intake (ballot version 4) "
            "and Share receipt (ballot version 4) with Python's integers and hashlib, reusing this folder's independent "
            "ballot-v4-records generator (elections, records, admission, membership signals), the share-encryption-v4 "
            "generator (encryption and decryption) and trustee-vectors.py's RFC 6979 P-256 ECDSA; membership proofs by "
            "packages/crypto/scripts/ballot-proofs.mjs, run outside the workspace with Semaphore 4.14.3's depth-32 "
            "circuit artifacts and snarkjs 0.7.5's fullProve, which checks that each proof's outputs equal the root and "
            "nullifier computed here; every pairing verdict is snarkjs's groth16.verify on the signals derived here from "
            "the record and the definition. The delivery-malformed cases are labelled by hand from the strict-decoding rules"
        ),
        "tags": {"receipt": RECEIPT_TAG_2.decode()},
        "panels": {"default": DEFAULT, "author": AUTHOR},
        "elections": {
            name: {"version": 6, "definition": s["elections"][name]["encoding"].hex(), "definitionHash": s["elections"][name]["definitionHash"].hex()}
            for name in ("panels", "default-only")
        },
        "seats": {
            PANEL_NAMES[panel]: [
                {
                    "seat": seat,
                    "kem": se.key_json(keys[panel][seat - 1]),
                    "signingSecret": f"{signing_secret(panel, seat):064x}",
                    "signingKey": sr.p256_key(signing_secret(panel, seat)).hex(),
                    "identityKey": sr.p256_key(identity_secret(panel, seat)).hex(),
                }
                for seat in range(1, PANEL + 1)
            ]
            for panel in (DEFAULT, AUTHOR)
        },
        "cases": out_cases,
        "checks": checks,
    }
    (pathlib.Path(out_dir) / "intake-v4.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote intake-v4.json: {len(out_cases)} intakes, {len(checks)} receipt checks")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: intake-v4-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
