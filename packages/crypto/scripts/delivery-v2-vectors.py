#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/delivery-v2.json.

A second implementation of docs/spec/delivery.md, Version 2: the share-receipt,
share-posting and share-complaint records (0x000c to 0x000e) at version 2,
which ballot version 4 fixes and which name the seat's panel (1 the default
panel, 2 the author panel) before its seat; the version-2 complaint's signed
message under `abolish/v1/sig/share-complaint-2`; board entries under version 4
carrying them; and the delivery check over every seat of both panels, each
record checked against its own panel's share hashes and registered key set,
with records through the board path and the contract path (postings only
through the contract path). It is written from the spec with Python's integers
and hashlib and shares no code with packages/crypto or any @noble library. It
reuses only this folder's other independent generators: delivery-vectors.py's
windows, record framing, strict-decoding helpers and board entries;
share-encryption-v4-vectors.py's version-4 ballots, encryption, decryption,
posting check and complaints (over ballot-v4-vectors.py's elections and
share-encryption-vectors.py's self-checked ML-KEM-768, ChaCha20-Poly1305 and
ristretto255); and intake-v4-vectors.py's version-4 receipt statement over
trustee-vectors.py's RFC 6979 P-256 ECDSA.

Every secret comes from SHA-256 over a fixed label, and each panel lists its
signing secrets, so any RFC 6979 implementation reproduces every signature.
The author panel's keys are test keys: its ceremony is P2-16 part 3's. The
values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/delivery-v2-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
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


dv = _load("delivery_vectors", "delivery-vectors.py")
sev4 = _load("share_encryption_v4_vectors", "share-encryption-v4-vectors.py")
iv4 = _load("intake_v4_vectors", "intake-v4-vectors.py")
se, bv, grp, b4 = sev4.se, sev4.bv, sev4.grp, sev4.b4
ecdsa, sr = dv.ecdsa, dv.sr

L = grp.L
DEFAULT, AUTHOR = sev4.DEFAULT, sev4.AUTHOR
PANEL_NAMES = {DEFAULT: "default", AUTHOR: "author"}
RECEIPT_TAG_2 = iv4.RECEIPT_TAG_2
COMPLAINT_TAG_2 = b"abolish/v1/sig/share-complaint-2"
RECEIPT, POSTING, COMPLAINT = dv.RECEIPT, dv.POSTING, dv.COMPLAINT
VERSION = 2

u8, u32 = bv.u8, bv.u32


def header(record_type, version=VERSION):
    return dv.header(record_type, version)


# --- Records (version 2) ----------------------------------------------------------


def receipt_record(definition_hash, b_hash, panel, seat, share_hash, sig):
    """The 98-byte version-4 receipt statement, then its signature: 165 bytes with the header."""
    return header(RECEIPT) + iv4.statement(definition_hash, b_hash, panel, seat, share_hash) + sig


def posting_record(definition_hash, b_hash, panel, seat, m, ct):
    return header(POSTING) + definition_hash + b_hash + u8(panel) + u8(seat) + m + ct


def complaint_statement(definition_hash, b_hash, panel, seat, proof):
    """m = definition_hash ‖ ballot_hash ‖ u8(panel) ‖ u8(seat) ‖ encode(proof): 162 bytes."""
    m = definition_hash + b_hash + u8(panel) + u8(seat) + se.enc_complaint(proof)
    assert len(m) == 162
    return m


def complaint_record(definition_hash, b_hash, panel, seat, proof, d):
    m = complaint_statement(definition_hash, b_hash, panel, seat, proof)
    return header(COMPLAINT) + m + sr.sign(d, m, COMPLAINT_TAG_2), m


def parse_record(b, expect=None):
    """Strict decoding of the three version-2 records, as `expect` (a dv.TYPES key) or as whichever of them `b` is; returns (kind, fields) or the decode error code, in reading order."""
    if len(b) < 3:
        return "truncated"
    t, v = int.from_bytes(b[:2], "big"), b[2]
    if t not in (RECEIPT, POSTING, COMPLAINT) or (expect is not None and t != dv.TYPES[expect]):
        return "unexpected-record-type"
    if v != VERSION:
        return "profile-mismatch"
    body = b[3:]
    if len(body) < 65:
        return "truncated"
    if body[64] not in (DEFAULT, AUTHOR):
        return "invalid-enum"
    if len(body) < 66:
        return "truncated"
    f = {"definitionHash": body[:32], "ballotHash": body[32:64], "panel": body[64], "seat": body[65]}
    rest = body[66:]
    if t == RECEIPT:
        if len(rest) < 96:
            return "truncated"
        if len(rest) > 96:
            return "trailing-bytes"
        f["shareHash"], f["signature"] = rest[:32], rest[32:]
        if not dv.sig_canonical(f["signature"]):
            return "non-canonical"
        return "receipt", f
    if t == POSTING:
        if len(rest) < 32:
            return "truncated"
        f["m"] = rest[:32]
        ct = rest[32:]
        err = dv.ciphertext_error(ct)
        if err is not None:
            return err
        f["ciphertext"] = ct
        return "posting", f
    if len(rest) < 160:
        return "truncated"
    if len(rest) > 160:
        return "trailing-bytes"
    d_raw, c_raw, z_raw, sig = rest[:32], rest[32:64], rest[64:96], rest[96:]
    d = None if d_raw == bytes(32) else grp.decode(d_raw)
    if d is None:
        return "non-canonical"
    c, z = int.from_bytes(c_raw, "little"), int.from_bytes(z_raw, "little")
    if c >= L or z >= L:
        return "non-canonical"
    if not dv.sig_canonical(sig):
        return "non-canonical"
    f["proof"], f["signature"] = {"dh": d, "c": c, "z": z}, sig
    return "complaint", f


# Board-entry version 4: version 3's types and the destruction statement, never a posting.
ALLOWED_V4 = dv.ALLOWED[3] | {0x000F}


def entry_error(b):
    payload = b[3 + 32 + 8 + 4 + 4 :]
    t = int.from_bytes(payload[:2], "big")
    return None if t in ALLOWED_V4 else "unexpected-record-type"


# --- The delivery check (version 2) -----------------------------------------------


def check_delivery(definition_hash, registered, seg_d, seg_k, t_d, t_k, ballots, entries, hash_of=None):
    """docs/spec/delivery.md, Delivery check (version 2), from the spec's text: version 1's check over every seat of both panels, each record against its own panel's share hashes and key set. `registered[panel]` maps each qualified seat to its keys. `hash_of` gives a ballot's hash under its own version, version 4's by default (ballot version 5's binds its step)."""
    hashes = [b4.ballot_hash(b["ctx"], b["vote"]) if hash_of is None else hash_of(b) for b in ballots]
    index = {h: i for i, h in enumerate(hashes)}
    delivered = [set() for _ in ballots]
    reports, rejected = [], []
    receipts, complaints = [], []
    postings = [dict() for _ in ballots]
    signers = {p: {s: k["signingKey"] for s, k in registered[p].items()} for p in (DEFAULT, AUTHOR)}
    for at, (path, when, payload) in enumerate(entries):
        # No board-entry version carries a posting: one through the board path is a rejected entry by its type alone.
        if path != "contract" and len(payload) >= 3 and int.from_bytes(payload[:2], "big") == POSTING:
            parsed = "unexpected-record-type"
        else:
            parsed = parse_record(payload)
        if isinstance(parsed, str):
            rejected.append({"at": at, "error": parsed})
            continue
        kind, f = parsed
        panel, seat = f["panel"], f["seat"]
        where = {"panel": panel, "seat": seat}
        if f["definitionHash"] != definition_hash:
            reports.append({"at": at, "code": "delivery-stray", **where})
            continue
        i = index.get(f["ballotHash"])
        if i is None:
            continue
        key = registered[panel].get(seat)
        if key is None:
            reports.append({"at": at, "code": "delivery-seat", **where})
            continue
        if path == "board":
            late = when > (seg_k if kind == "complaint" else seg_d)
        else:
            late = when > (t_k if kind == "complaint" else t_d)
        if late:
            reports.append({"at": at, "code": "delivery-late", **where})
            continue
        b = ballots[i]
        own = sev4.own_hashes(b["vote"], panel)
        if kind == "receipt":
            ok = f["shareHash"] == own[seat - 1] and iv4.check_receipt(signers, definition_hash, hashes[i], panel, seat, own[seat - 1], f["signature"])
            if not ok:
                signed = iv4.check_receipt(signers, definition_hash, f["ballotHash"], panel, seat, f["shareHash"], f["signature"])
                reports.append({"at": at, "code": "share-receipt", **where, "signer": seat if signed else None})
                continue
            delivered[i].add((panel, seat))
            receipts.append((at, i, panel, seat))
        elif kind == "posting":
            code, _ = sev4.check_posting(definition_hash, panel, seat, key["kem"], b["vote"], f["ciphertext"], f["m"])
            if code != "ok":
                reports.append({"at": at, "code": code, **where})
                continue
            delivered[i].add((panel, seat))
            postings[i][(panel, seat)] = f
        else:
            complaints.append((at, i, f))
    excluded = [[] for _ in ballots]
    for at, i, f in complaints:
        panel, seat = f["panel"], f["seat"]
        where = {"panel": panel, "seat": seat}
        posting = postings[i].get((panel, seat))
        if posting is None:
            reports.append({"at": at, "code": "complaint-void", **where})
            continue
        key = registered[panel][seat]
        code = sev4.check_complaint(definition_hash, panel, seat, key["kem"], ballots[i]["vote"], posting["ciphertext"], posting["m"], f["proof"])
        m = complaint_statement(definition_hash, f["ballotHash"], panel, seat, f["proof"])
        signer = seat if ecdsa.verify(key["signingKey"], bv.ds(COMPLAINT_TAG_2, m), f["signature"]) else None
        if code == "ok":
            excluded[i].append({"at": at, **where, "signer": signer})
        elif code == "complaint-unfounded":
            reports.append({"at": at, "code": code, **where, "signer": signer})
        else:
            reports.append({"at": at, "code": "complaint-proof", **where})
    for at, i, panel, seat in receipts:
        if any(c["panel"] == panel and c["seat"] == seat for c in excluded[i]):
            reports.append({"at": at, "code": "receipt-contradicted", "panel": panel, "seat": seat, "signer": seat})
    reports.sort(key=lambda r: r["at"])
    out = []
    for i, h in enumerate(hashes):
        missing = sorted((p, s) for p in (DEFAULT, AUTHOR) for s in registered[p] if (p, s) not in delivered[i])
        ex = sorted(excluded[i], key=lambda c: c["at"])
        out.append(
            {
                "ballotHash": h.hex(),
                "counted": not missing and not ex,
                "delivered": not missing,
                "missing": [{"panel": p, "seat": s} for p, s in missing],
                "excludedBy": ex,
            }
        )
    return {"ballots": out, "records": reports, "rejected": rejected}


# --- Vectors ----------------------------------------------------------------------


def main():
    grp.self_check()
    ecdsa.self_check()
    se.aead_self_check()
    se.mlkem_self_check(100)
    out = sys.argv[1]

    sizes = [3, 2]
    flat = lambda *picked: b4.b3.flat(zip(sizes, picked))  # noqa: E731
    e = b4.election("delivery-v2", [(3, 0, 1), (2, 0, 2)], 2, 3, 2, 3)
    plain = b4.election("delivery-v2-no-author", [(3, 0, 1), (2, 0, 2)], 2, 3, 0, 0)
    keys = {DEFAULT: se.trustee_keys("delivery-v2/default", 3), AUTHOR: se.trustee_keys("delivery-v2/author", 3)}

    def signing_secret(panel, seat):
        return ecdsa.secret(f"delivery-v2/{PANEL_NAMES[panel]}/signing/{seat}".encode())

    def identity_secret(panel, seat):
        return ecdsa.secret(f"delivery-v2/{PANEL_NAMES[panel]}/identity/{seat}".encode())

    def registered(default=(1, 2, 3), author=(1, 2, 3)):
        return {
            panel: {s: {"kem": keys[panel][s - 1], "signingKey": sr.p256_key(signing_secret(panel, s))} for s in seats}
            for panel, seats in ((DEFAULT, default), (AUTHOR, author))
        }

    # A dishonest client's cheat: the target seat's first share has v + 1, sealed correctly.
    def bad_share(election, target):
        def cheat(panel, seat, sb, key, halves, m, ee, w):
            if (panel, seat) == target:
                v = (int.from_bytes(sb[4:36], "little") + 1) % L
                sb = sb[:4] + bv.scalar(v) + sb[36:]
            return sev4.encrypt(election["definitionHash"], panel, seat, key, halves, sb, m, ee, w)

        return cheat

    ballots = {}
    for name, election, cell, votes, target in (
        ("alice", e, 0, flat({1}, {0, 1}), None),
        ("bob", e, 1, flat({0}, {1}), None),
        ("carol", e, 0, flat({2}, set()), (AUTHOR, 2)),
        ("dave", e, 1, flat(set(), {0}), (DEFAULT, 2)),
        ("erin", plain, 0, flat({0}, {0, 1}), None),
    ):
        author_keys = keys[AUTHOR] if election["authorPanelSize"] else []
        b = sev4.make_encrypted_ballot("delivery-v2/" + name, election, cell, votes, keys[DEFAULT], author_keys, bad_share(election, target) if target else None)
        b["name"] = name
        b["hash"] = b4.ballot_hash(b["ctx"], b["vote"])
        ballots[name] = b

    # Frank's client binds author seat 1's ciphertext as default seat 1's: it hashes into the
    # ballot, but its proof of knowledge fails for the author seat it is for.
    def as_default(panel, seat, sb, key, halves, m, ee, w):
        return sev4.encrypt(e["definitionHash"], DEFAULT if (panel, seat) == (AUTHOR, 1) else panel, seat, key, halves, sb, m, ee, w)

    b = sev4.make_encrypted_ballot("delivery-v2/frank", e, 0, flat({0}, {1}), keys[DEFAULT], keys[AUTHOR], as_default)
    b["name"], b["hash"] = "frank", b4.ballot_hash(b["ctx"], b["vote"])
    ballots["frank"] = b

    def ballot_json(b):
        return {"id": b["name"], "cell": b["ctx"]["cell"], "nullifier": str(b["ctx"]["nullifier"]), "committedVote": b4.enc_committed_vote(b["vote"]).hex(), "ballotHash": b["hash"].hex()}

    def ct_of(name, panel, seat):
        return ballots[name]["panels"][panel]["cts"][seat - 1]

    def m_of(name, panel, seat):
        return bytes.fromhex(ballots[name]["panels"][panel]["rand"][seat - 1]["m"])

    # Every honest seat's receipt, made only after its own decryption passes.
    def R(name, panel, seat):
        b = ballots[name]
        defh = b["election"]["definitionHash"]
        ct = ct_of(name, panel, seat)
        assert sev4.decrypt(defh, panel, seat, keys[panel][seat - 1], b["vote"], ct) == "ok", (name, panel, seat)
        sh = se.share_hash(ct)
        return receipt_record(defh, b["hash"], panel, seat, sh, iv4.sign(signing_secret(panel, seat), iv4.statement(defh, b["hash"], panel, seat, sh)))

    def P(name, panel, seat, m=None, ct=None, as_=None):
        b = ballots[name]
        p, s = as_ or (panel, seat)
        return posting_record(b["election"]["definitionHash"], b["hash"], p, s, m or m_of(name, panel, seat), ct or ct_of(name, panel, seat))

    complaint_rng = bv.Rng("delivery-v2/complaint")

    def proof_for(name, panel, seat, honest=True):
        b = ballots[name]
        defh = b["election"]["definitionHash"]
        w = sev4.nonzero_scalar(complaint_rng)
        ct = ct_of(name, panel, seat)
        if honest:
            return sev4.prove_complaint(defh, panel, seat, keys[panel][seat - 1], b["vote"], ct, m_of(name, panel, seat), w), w
        return sev4.raw_complaint(defh, panel, seat, keys[panel][seat - 1], ct, w), w

    def C(name, panel, seat, proof, secret=None, as_=None):
        b = ballots[name]
        p, s = as_ or (panel, seat)
        return complaint_record(b["election"]["definitionHash"], b["hash"], p, s, proof, secret or signing_secret(panel, seat))[0]

    defh = e["definitionHash"]
    carol_proof, carol_w = proof_for("carol", AUTHOR, 2)
    dave_proof, _ = proof_for("dave", DEFAULT, 2)
    alice_unfounded, _ = proof_for("alice", AUTHOR, 2, honest=False)

    # --- Records re-made byte for byte ---
    records = []

    def record(id_, desc, type_, enc, extra):
        parsed = parse_record(enc, type_)
        assert not isinstance(parsed, str), (id_, parsed)
        records.append(dict({"id": id_, "description": desc, "type": type_, "encoding": enc.hex()}, **extra))

    a_d1, a_a1 = R("alice", DEFAULT, 1), R("alice", AUTHOR, 1)
    record("receipt-default", "Default seat 1's version-2 share receipt for Alice's ballot: its 98-byte statement, then its signature", "share-receipt", a_d1, {"panel": DEFAULT, "seat": 1, "statement": a_d1[3:101].hex()})
    record("receipt-author", "Author seat 1's version-2 share receipt for the same ballot", "share-receipt", a_a1, {"panel": AUTHOR, "seat": 1, "statement": a_a1[3:101].hex()})
    a_p3 = P("alice", AUTHOR, 3)
    record("posting-author", "Alice's client posts author seat 3's ciphertext with its ML-KEM message", "share-posting", a_p3, {"panel": AUTHOR, "seat": 3})
    record("posting-default", "Alice's client posts default seat 3's ciphertext", "share-posting", P("alice", DEFAULT, 3), {"panel": DEFAULT, "seat": 3})
    cc, cm = complaint_record(defh, ballots["carol"]["hash"], AUTHOR, 2, carol_proof, signing_secret(AUTHOR, 2))
    record("complaint-author", "Author seat 2's proven complaint about Carol's posted author seat 2 share, signed with its per-election key", "share-complaint", cc, {"panel": AUTHOR, "seat": 2, "statement": cm.hex(), "w": str(carol_w)})
    dc, dm = complaint_record(defh, ballots["dave"]["hash"], DEFAULT, 2, dave_proof, signing_secret(DEFAULT, 2))
    record("complaint-default", "Default seat 2's proven complaint about Dave's posted default seat 2 share", "share-complaint", dc, {"panel": DEFAULT, "seat": 2, "statement": dm.hex()})

    # --- Decode rejections ---
    decode = []

    def reject(id_, desc, type_, enc, error):
        got = parse_record(enc, type_)
        assert got == error, (id_, got)
        decode.append({"id": id_, "description": desc, "type": type_, "encoding": enc.hex(), "error": error})

    def with_panel(enc, panel):
        return enc[:67] + bytes([panel]) + enc[68:]

    reject("receipt-truncated", "A version-2 share receipt one byte short", "share-receipt", a_a1[:-1], "truncated")
    reject("receipt-trailing", "A version-2 share receipt with a trailing byte", "share-receipt", a_a1 + b"\x00", "trailing-bytes")
    reject("receipt-version-1", "A version-2 share receipt labelled version 1: ballot version 4 fixes version 2", "share-receipt", a_a1[:2] + b"\x01" + a_a1[3:], "profile-mismatch")
    reject("receipt-v1-bytes", "A version-1 share receipt's bytes, under ballot version 4", "share-receipt", dv.receipt_record(defh, ballots["alice"]["hash"], 1, se.share_hash(ct_of("alice", DEFAULT, 1)), bytes(63) + b"\x01"), "profile-mismatch")
    reject("receipt-panel-0", "A share receipt naming panel 0", "share-receipt", with_panel(a_a1, 0), "invalid-enum")
    reject("receipt-panel-3", "A share receipt naming panel 3", "share-receipt", with_panel(a_a1, 3), "invalid-enum")
    reject("receipt-short-at-panel", "A share receipt cut off before its panel", "share-receipt", a_a1[:67], "truncated")
    r_, s_ = int.from_bytes(a_a1[-64:-32], "big"), int.from_bytes(a_a1[-32:], "big")
    reject("receipt-high-s", "A version-2 share receipt whose signature has s replaced by n − s", "share-receipt", a_a1[:-64] + ecdsa.sig_bytes(r_, ecdsa.N - s_), "non-canonical")
    reject("receipt-as-posting", "A share receipt's bytes read as a posting", "share-posting", a_a1, "unexpected-record-type")
    reject("posting-truncated", "A version-2 posting one byte short", "share-posting", a_p3[:-1], "truncated")
    reject("posting-trailing", "A version-2 posting with a trailing byte", "share-posting", a_p3 + b"\x00", "trailing-bytes")
    reject("posting-panel-3", "A posting naming panel 3", "share-posting", with_panel(a_p3, 3), "invalid-enum")
    ct3 = ct_of("alice", AUTHOR, 3)
    reject("posting-identity-dh", "A version-2 posting whose ciphertext's ct_dh is the identity", "share-posting", P("alice", AUTHOR, 3, ct=ct3[:1088] + bytes(32) + ct3[1120:]), "non-canonical")
    over = ct3[:1184] + u32(se.MAX_SEALED + 1) + bytes(se.MAX_SEALED + 1)
    reject("posting-sealed-over-max", "A version-2 posting whose ciphertext's sealed field is one byte over the 4116-byte maximum", "share-posting", P("alice", AUTHOR, 3, ct=over), "length-over-max")
    reject("posting-version-1", "A version-2 posting labelled version 1", "share-posting", a_p3[:2] + b"\x01" + a_p3[3:], "profile-mismatch")
    reject("complaint-truncated", "A version-2 complaint one byte short", "share-complaint", cc[:-1], "truncated")
    reject("complaint-trailing", "A version-2 complaint with a trailing byte", "share-complaint", cc + b"\x00", "trailing-bytes")
    reject("complaint-panel-0", "A complaint naming panel 0", "share-complaint", with_panel(cc, 0), "invalid-enum")
    c_at = 3 + 66 + 32
    reject("complaint-c-l", "A version-2 complaint whose challenge is ℓ", "share-complaint", cc[:c_at] + L.to_bytes(32, "little") + cc[c_at + 32 :], "non-canonical")
    reject("complaint-identity-dh", "A version-2 complaint whose D is the identity", "share-complaint", cc[: 3 + 66] + bytes(32) + cc[3 + 66 + 32 :], "non-canonical")
    reject("complaint-version-1", "A version-2 complaint labelled version 1", "share-complaint", cc[:2] + b"\x01" + cc[3:], "profile-mismatch")

    # --- Board entries under version 4 ---
    election_id = bv.H(b"delivery-v2/election")
    entries_json = []

    def entry(id_, desc, payload, error):
        enc = dv.board_entry(4, election_id, 5, 7, payload)
        assert entry_error(enc) == error, id_
        entries_json.append({"id": id_, "description": desc, "version": 4, "encoding": enc.hex(), "error": error})

    entry("v4-receipt", "A version-4 entry carrying a version-2 share receipt", a_a1, None)
    entry("v4-complaint", "A version-4 entry carrying a version-2 share complaint", cc, None)
    entry("v4-posting", "A version-4 entry can't carry a version-2 share posting: postings reach the board only as contract events", a_p3, "unexpected-record-type")

    # --- Elections ---
    elections = []
    SD, SK = 40, 112
    TD, TK = dv.deadlines(1_700_000_000, 0)
    T0 = TD - dv.DELIVERY_WINDOW

    def election(id_, desc, names, entries, default=(1, 2, 3), author=(1, 2, 3)):
        sel = [ballots[n] for n in names]
        el = sel[0]["election"]
        assert all(b["election"] is el for b in sel)
        reg = registered(default, author if el["authorPanelSize"] else ())
        result = check_delivery(el["definitionHash"], reg, SD, SK, TD, TK, sel, entries)
        elections.append(
            {
                "id": id_,
                "description": desc,
                "definitionHash": el["definitionHash"].hex(),
                "panelSize": el["panelSize"],
                "authorPanelSize": el["authorPanelSize"],
                "registered": list(reg[DEFAULT]),
                "authorRegistered": list(reg[AUTHOR]),
                "segments": {"delivery": str(SD), "complaint": str(SK)},
                "deadlines": {"delivery": str(TD), "complaint": str(TK)},
                "ballots": [ballot_json(b) for b in sel],
                "entries": [{"path": "board", "segment": w, "payload": p.hex()} if path == "board" else {"path": "contract", "submittedAt": str(w), "payload": p.hex()} for path, w, p in entries],
                "result": result,
            }
        )
        return result

    def at(seg, *payloads):
        return [("board", seg, p) for p in payloads]

    def by(t, *payloads):
        return [("contract", t, p) for p in payloads]

    def every(name, skip=()):
        return [R(name, p, s) for p in (DEFAULT, AUTHOR) for s in (1, 2, 3) if (p, s) not in skip]

    def seat(p, s):
        return {"panel": p, "seat": s}

    r = election("all-receipted", "Every seat of both panels receipts Alice's ballot; author seat 3's in the deadline's own segment", ["alice"], at(3, *every("alice", {(AUTHOR, 3)})) + at(SD, R("alice", AUTHOR, 3)))
    assert r["ballots"][0]["counted"]
    r = election("author-seat-missing", "Every default seat receipts, author seat 3 doesn't: the ballot isn't delivered", ["alice"], at(3, *every("alice", {(AUTHOR, 3)})))
    assert r["ballots"][0]["missing"] == [seat(AUTHOR, 3)]
    r = election("default-seat-missing", "Every author seat receipts, default seat 1 doesn't", ["alice"], at(3, *every("alice", {(DEFAULT, 1)})))
    assert r["ballots"][0]["missing"] == [seat(DEFAULT, 1)]
    r = election("contract-receipt", "Author seat 3's receipt only through the contract path, at the delivery deadline itself", ["alice"], at(3, *every("alice", {(AUTHOR, 3)})) + by(TD, R("alice", AUTHOR, 3)))
    assert r["ballots"][0]["counted"]
    r = election("late-contract-receipt", "Author seat 3's contract-path receipt one second after the delivery deadline", ["alice"], at(3, *every("alice", {(AUTHOR, 3)})) + by(TD + 1, R("alice", AUTHOR, 3)))
    assert r["ballots"][0]["missing"] == [seat(AUTHOR, 3)] and r["records"] == [{"at": 5, "code": "delivery-late", **seat(AUTHOR, 3)}]
    r = election("late-receipt", "Default seat 2's receipt boarded one segment after s_D", ["alice"], at(3, *every("alice", {(DEFAULT, 2)})) + at(SD + 1, R("alice", DEFAULT, 2)))
    assert r["ballots"][0]["missing"] == [seat(DEFAULT, 2)] and r["records"] == [{"at": 5, "code": "delivery-late", **seat(DEFAULT, 2)}]

    ba = ballots["alice"]
    sh = {p: sev4.own_hashes(ba["vote"], p) for p in (DEFAULT, AUTHOR)}

    def signed_receipt(panel, seat_, share_hash, secret, tag=RECEIPT_TAG_2, b_hash=None, definition_hash=defh):
        b_hash = b_hash or ba["hash"]
        m = iv4.statement(definition_hash, b_hash, panel, seat_, share_hash)
        return receipt_record(definition_hash, b_hash, panel, seat_, share_hash, sr.sign(secret, m, tag))

    # Author seat 2's receipt read as default seat 2's: the panel byte changed, the author seat's own signature.
    author_as_default = R("alice", AUTHOR, 2)[:67] + bytes([DEFAULT]) + R("alice", AUTHOR, 2)[68:]
    # Author seat 2's key signing a statement naming default seat 2 with the author share hash.
    author_signs_default = signed_receipt(DEFAULT, 2, sh[AUTHOR][1], signing_secret(AUTHOR, 2))
    # Default seat 2's own key over the author share hash, naming default seat 2: attributed to default seat 2.
    default_signs_author_hash = signed_receipt(DEFAULT, 2, sh[AUTHOR][1], signing_secret(DEFAULT, 2))
    v1_tag = signed_receipt(AUTHOR, 2, sh[AUTHOR][1], signing_secret(AUTHOR, 2), tag=sr.RECEIPT_TAG)
    identity = signed_receipt(AUTHOR, 2, sh[AUTHOR][1], identity_secret(AUTHOR, 2))
    r = election(
        "failing-receipts",
        "Five receipts fail and leave default seat 2 and author seat 2 undelivered: author seat 2's receipt with its panel byte changed to the default panel; author seat 2's key over a statement naming default seat 2; default seat 2's own key over the author share hash (attributed to default seat 2); author seat 2's key under version 1's tag; and author seat 2's identity key",
        ["alice"],
        at(3, *every("alice", {(DEFAULT, 2), (AUTHOR, 2)}), author_as_default, author_signs_default, default_signs_author_hash) + by(T0 + 60, v1_tag) + at(3, identity),
    )
    assert r["ballots"][0]["missing"] == [seat(DEFAULT, 2), seat(AUTHOR, 2)]
    assert [(x["code"], x["signer"]) for x in r["records"]] == [("share-receipt", None), ("share-receipt", None), ("share-receipt", 2), ("share-receipt", None), ("share-receipt", None)]

    stray = signed_receipt(AUTHOR, 3, sh[AUTHOR][2], signing_secret(AUTHOR, 3), definition_hash=plain["definitionHash"])
    r = election("stray", "Alice's ballot fully receipted, beside author seat 3's receipt naming the other election's definition", ["alice"], at(3, *every("alice"), stray))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 6, "code": "delivery-stray", **seat(AUTHOR, 3)}]
    r = election("unqualified-author-seat", "Author seat 3 isn't qualified: the other five seats deliver the ballot, and author seat 3's receipt names a seat outside the author key set", ["alice"], at(3, *every("alice")), author=(1, 2))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 5, "code": "delivery-seat", **seat(AUTHOR, 3)}]

    be = ballots["erin"]
    erin_author = receipt_record(plain["definitionHash"], be["hash"], AUTHOR, 1, sh[AUTHOR][0], iv4.sign(signing_secret(AUTHOR, 1), iv4.statement(plain["definitionHash"], be["hash"], AUTHOR, 1, sh[AUTHOR][0])))
    r = election("no-author-panel", "A poll without an author panel: the default seats deliver Erin's ballot, and a receipt naming author seat 1 is for a seat outside the empty author key set", ["erin"], at(3, R("erin", DEFAULT, 1), R("erin", DEFAULT, 2), erin_author, R("erin", DEFAULT, 3)))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 2, "code": "delivery-seat", **seat(AUTHOR, 1)}]

    r = election("posting-fallback", "Author seat 3 is posted through the contract path at the delivery deadline, default seat 3 a minute after the close", ["alice"], at(3, *every("alice", {(AUTHOR, 3), (DEFAULT, 3)})) + by(T0 + 60, P("alice", DEFAULT, 3)) + by(TD, P("alice", AUTHOR, 3)))
    assert r["ballots"][0]["counted"]
    r = election("late-posting", "Author seat 3's posting one second after the delivery deadline", ["alice"], at(3, *every("alice", {(AUTHOR, 3)})) + by(TD + 1, P("alice", AUTHOR, 3)))
    assert r["ballots"][0]["missing"] == [seat(AUTHOR, 3)] and r["records"] == [{"at": 5, "code": "delivery-late", **seat(AUTHOR, 3)}]
    r = election("posting-proof", "Frank's author seat 1 ciphertext, bound as default seat 1's, posted through the contract path: its hash matches, its proof of knowledge fails", ["frank"], at(3, *every("frank", {(AUTHOR, 1)})) + by(T0 + 60, P("frank", AUTHOR, 1)))
    assert r["ballots"][0]["missing"] == [seat(AUTHOR, 1)] and r["records"] == [{"at": 5, "code": "posting-proof", **seat(AUTHOR, 1)}]
    r = election("board-path-posting", "Author seat 3's posting through the board path: a rejected entry, which delivers nothing", ["alice"], at(3, *every("alice", {(AUTHOR, 3)}), P("alice", AUTHOR, 3)))
    assert r["ballots"][0]["missing"] == [seat(AUTHOR, 3)] and r["rejected"] == [{"at": 5, "error": "unexpected-record-type"}]
    r = election(
        "cross-panel-postings",
        "Postings for one panel's seat 3 never deliver the other's: author seat 3's ciphertext and message posted as default seat 3 (posting-hash), default seat 3's posted as author seat 3 (posting-hash), and author seat 3's ciphertext with default seat 3's message (posting-encapsulation)",
        ["alice"],
        at(3, *every("alice", {(AUTHOR, 3), (DEFAULT, 3)}))
        + by(T0 + 60, P("alice", AUTHOR, 3, as_=(DEFAULT, 3)), P("alice", DEFAULT, 3, as_=(AUTHOR, 3)), P("alice", AUTHOR, 3, m=m_of("alice", DEFAULT, 3))),
    )
    assert r["ballots"][0]["missing"] == [seat(DEFAULT, 3), seat(AUTHOR, 3)]
    assert [x["code"] for x in r["records"]] == ["posting-hash", "posting-hash", "posting-encapsulation"]

    carol_posted = at(3, *every("carol", {(AUTHOR, 2)})) + by(T0 + 60, P("carol", AUTHOR, 2))
    n = len(carol_posted)
    r = election("proven-complaint", "Carol's dishonest author seat 2 share is posted through the contract path; author seat 2 proves it invalid, and the ballot is excluded though delivered", ["carol"], carol_posted + at(60, C("carol", AUTHOR, 2, carol_proof)))
    assert r["ballots"][0]["delivered"] and not r["ballots"][0]["counted"] and r["ballots"][0]["excludedBy"] == [{"at": n, **seat(AUTHOR, 2), "signer": 2}]
    r = election("unattributed-complaint", "The same proof signed by default seat 2, the same index in the other panel: still proven, attributed to no one", ["carol"], carol_posted + at(60, C("carol", AUTHOR, 2, carol_proof, secret=signing_secret(DEFAULT, 2))))
    assert r["ballots"][0]["excludedBy"] == [{"at": n, **seat(AUTHOR, 2), "signer": None}]
    r = election("contract-complaint", "The complaint through the contract path at the end of the complaint window itself", ["carol"], carol_posted + by(TK, C("carol", AUTHOR, 2, carol_proof)))
    assert not r["ballots"][0]["counted"]
    r = election("late-complaint", "The complaint boarded one segment after s_K: ignored, and Carol's ballot stays counted", ["carol"], carol_posted + at(SK + 1, C("carol", AUTHOR, 2, carol_proof)))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": n, "code": "delivery-late", **seat(AUTHOR, 2)}]
    r = election("void-complaint", "A complaint with no passing posting for author seat 2: void, and the ballot lacks that seat", ["carol"], at(3, *every("carol", {(AUTHOR, 2)})) + at(60, C("carol", AUTHOR, 2, carol_proof)))
    assert r["ballots"][0]["missing"] == [seat(AUTHOR, 2)] and r["records"] == [{"at": 5, "code": "complaint-void", **seat(AUTHOR, 2)}]
    # The author proof in a record naming default seat 2: void beside no default posting, and failing beside default seat 2's honest one.
    as_default = C("carol", AUTHOR, 2, carol_proof, secret=signing_secret(DEFAULT, 2), as_=(DEFAULT, 2))
    r = election(
        "complaint-other-panel",
        "Author seat 2's proof in a complaint naming default seat 2, signed by it: void while only author seat 2 is posted, and the ballot stays counted",
        ["carol"],
        carol_posted + at(60, as_default),
    )
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": n, "code": "complaint-void", **seat(DEFAULT, 2)}]
    carol_both = at(3, *every("carol", {(AUTHOR, 2), (DEFAULT, 2)})) + by(T0 + 60, P("carol", AUTHOR, 2), P("carol", DEFAULT, 2))
    r = election(
        "complaint-proof-other-panel",
        "The same complaint beside default seat 2's honest posting: its proof, made for the author seat, fails for the default seat, so neither panel's seat is excluded by it",
        ["carol"],
        carol_both + at(60, as_default),
    )
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": len(carol_both), "code": "complaint-proof", **seat(DEFAULT, 2)}]
    r = election("unfounded-complaint", "Author seat 2 complains about Alice's valid posted author seat 2 share: unfounded, attributed to author seat 2, and the ballot stands", ["alice"], at(3, *every("alice", {(AUTHOR, 2)})) + by(T0 + 60, P("alice", AUTHOR, 2)) + at(60, C("alice", AUTHOR, 2, alice_unfounded)))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 6, "code": "complaint-unfounded", **seat(AUTHOR, 2), "signer": 2}]
    bad = dict(carol_proof, z=(carol_proof["z"] + 1) % L)
    r = election("complaint-proof-fails", "Author seat 2's complaint with z + 1, re-signed: its proof fails, and Carol's ballot stays counted", ["carol"], carol_posted + at(60, C("carol", AUTHOR, 2, bad)))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": n, "code": "complaint-proof", **seat(AUTHOR, 2)}]
    bc = ballots["carol"]
    false_receipt = receipt_record(defh, bc["hash"], AUTHOR, 2, sev4.own_hashes(bc["vote"], AUTHOR)[1], iv4.sign(signing_secret(AUTHOR, 2), iv4.statement(defh, bc["hash"], AUTHOR, 2, sev4.own_hashes(bc["vote"], AUTHOR)[1])))
    r = election(
        "contradicted-receipt",
        "Author seat 2 signs a receipt for Carol's invalid share and its complaint about the posting is proven: excluded, and only author seat 2's receipt is reported, not default seat 2's",
        ["carol"],
        at(3, *every("carol", {(AUTHOR, 2)}), false_receipt) + by(T0 + 60, P("carol", AUTHOR, 2)) + at(60, C("carol", AUTHOR, 2, carol_proof)),
    )
    assert not r["ballots"][0]["counted"] and r["records"] == [{"at": 5, "code": "receipt-contradicted", **seat(AUTHOR, 2), "signer": 2}]
    dave_posted = at(3, *every("dave", {(DEFAULT, 2)})) + by(T0 + 60, P("dave", DEFAULT, 2))
    r = election("default-complaint", "Dave's dishonest default seat 2 share is posted; default seat 2 proves it invalid, and author seat 2's receipt stands uncontradicted", ["dave"], dave_posted + at(60, C("dave", DEFAULT, 2, dave_proof)))
    assert not r["ballots"][0]["counted"] and r["ballots"][0]["excludedBy"] == [{"at": len(dave_posted), **seat(DEFAULT, 2), "signer": 2}] and r["records"] == []

    mixed = (
        at(2, R("alice", DEFAULT, 1), R("bob", AUTHOR, 1), R("dave", DEFAULT, 1), R("alice", AUTHOR, 1), R("carol", DEFAULT, 1))
        + by(T0 + 300, P("carol", AUTHOR, 2))
        + at(5, R("alice", DEFAULT, 2), R("alice", DEFAULT, 3), R("bob", DEFAULT, 1), R("bob", DEFAULT, 2), R("bob", DEFAULT, 3), R("bob", AUTHOR, 3))
        + at(6, R("carol", DEFAULT, 2), R("carol", DEFAULT, 3), R("carol", AUTHOR, 1), R("carol", AUTHOR, 3), R("alice", AUTHOR, 2))
        + by(T0 + 600, P("alice", AUTHOR, 3))
        + at(SD, R("alice", DEFAULT, 1))
        + at(70, C("carol", AUTHOR, 2, carol_proof))
    )
    first = election("three-ballots", "Alice counted, Bob missing author seat 2, Carol excluded; a duplicate and a record for Dave's unselected ballot decide nothing", ["alice", "bob", "carol"], mixed)
    assert [x["counted"] for x in first["ballots"]] == [True, False, False] and first["ballots"][1]["missing"] == [seat(AUTHOR, 2)] and first["records"] == []
    rev = list(reversed(mixed))
    segs = iter(sorted(w for path, w, _ in mixed if path == "board"))
    reordered = [(path, next(segs) if path == "board" else w, p) for path, w, p in rev]
    second = election("three-ballots-reordered", "The same records in reverse order: the same verdicts", ["alice", "bob", "carol"], reordered)
    strip = lambda res: [{k: v for k, v in b.items() if k != "excludedBy"} | {"excludedBy": [(c["panel"], c["seat"]) for c in b["excludedBy"]]} for b in res["ballots"]]  # noqa: E731
    assert strip(first) == strip(second)

    v1_receipt = dv.receipt_record(defh, ba["hash"], 1, sh[DEFAULT][0], sr.sign(signing_secret(DEFAULT, 1), sr.statement(defh, ba["hash"], 1, sh[DEFAULT][0])))
    r = election(
        "rejected-entries",
        "A version-1 receipt (profile-mismatch), a receipt naming panel 3 (invalid-enum), a truncated receipt and a contract-path posting whose ciphertext doesn't decode are rejected entries; the rest deliver the ballot",
        ["alice"],
        at(3, v1_receipt, with_panel(R("alice", AUTHOR, 1), 3), R("alice", DEFAULT, 2)[:-1]) + by(T0 + 60, P("alice", AUTHOR, 3, ct=ct3[:1088] + bytes(32) + ct3[1120:])) + at(3, *every("alice")),
    )
    assert r["ballots"][0]["counted"] and r["rejected"] == [
        {"at": 0, "error": "profile-mismatch"},
        {"at": 1, "error": "invalid-enum"},
        {"at": 2, "error": "truncated"},
        {"at": 3, "error": "non-canonical"},
    ]

    def panel_json(panel):
        return [
            {
                "seat": s,
                "kemKey": se.enc_kem_key(keys[panel][s - 1]).hex(),
                "signingSecret": f"{signing_secret(panel, s):064x}",
                "signingKey": sr.p256_key(signing_secret(panel, s)).hex(),
                "identityKey": sr.p256_key(identity_secret(panel, s)).hex(),
            }
            for s in (1, 2, 3)
        ]

    data = {
        "format": "abolish-delivery-vectors/2",
        "title": "Share delivery on the board under ballot version 4: version-2 receipts, postings and complaints naming the seat's panel, and the delivery check over both panels",
        "spec": "docs/spec/delivery.md",
        "generator": (
            "Printed by packages/crypto/scripts/delivery-v2-vectors.py, an implementation of "
            "docs/spec/delivery.md, Version 2, in Python's integers and hashlib, sharing no code with "
            "packages/crypto or any @noble library. It reuses delivery-vectors.py's windows, framing and "
            "decoding helpers, share-encryption-v4-vectors.py's version-4 ballots, encryption, posting check "
            "and complaints, and intake-v4-vectors.py's receipt statement over RFC 6979 P-256 ECDSA (checked "
            "against RFC 6979 Appendix A.2.5 first). Secrets are SHA-256 of fixed labels: test data only."
        ),
        "tags": {"receipt": RECEIPT_TAG_2.decode(), "complaint": COMPLAINT_TAG_2.decode()},
        "panels": {"default": DEFAULT, "author": AUTHOR},
        "seats": {"default": panel_json(DEFAULT), "author": panel_json(AUTHOR)},
        "records": records,
        "decode": decode,
        "boardEntries": entries_json,
        "elections": elections,
    }
    with open(f"{out}/delivery-v2.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote delivery-v2.json: {len(records)} records, {len(decode)} decode rejections, {len(elections)} elections")


if __name__ == "__main__":
    main()
