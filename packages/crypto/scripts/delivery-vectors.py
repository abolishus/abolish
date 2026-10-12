#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/delivery.json.

A second implementation of docs/spec/delivery.md: the share-receipt,
share-posting and share-complaint records (0x000c to 0x000e, version 1),
the complaint's signed message, board entries under version 3 (receipts and
complaints only), the deadline segments and deadlines, and the delivery check
over selected ballots, with records through the board path and the contract
path (postings only through the contract path). It is written from the
spec with Python's integers and hashlib, and shares no code with
packages/crypto or any @noble library. It reuses share-receipt-vectors.py's
ballot hash, intake and P-256 ECDSA (from trustee-vectors.py, which reproduces
RFC 6979 Appendix A.2.5 first) and share-encryption-vectors.py's ballots,
posting check and complaints (over ballot-validity-vectors.py and
group-vectors.py's self-checked ristretto255).

Every secret comes from SHA-256 over a fixed label, and the panel lists its
signing secrets, so any RFC 6979 implementation reproduces every signature.
The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/delivery-vectors.py <out-dir>
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


sr = _load("share_receipt_vectors", "share-receipt-vectors.py")
se, ecdsa, bv, grp = sr.se, sr.ecdsa, sr.bv, sr.grp

L = grp.L
COMPLAINT_TAG = b"abolish/v1/sig/share-complaint"
RECEIPT_TAG = sr.RECEIPT_TAG
DELIVERY_WINDOW = 86_400
COMPLAINT_WINDOW = 345_600

RECEIPT, POSTING, COMPLAINT, BOARD_ENTRY = 0x000C, 0x000D, 0x000E, 0x0007
BALLOT = 0x0002

u8, u16, u32 = bv.u8, bv.u16, bv.u32


def u64(x):
    return x.to_bytes(8, "big")


def header(record_type, version=1):
    return u16(record_type) + u8(version)


# --- Records ----------------------------------------------------------------------


def receipt_record(definition_hash, b_hash, seat, share_hash, sig):
    return header(RECEIPT) + sr.statement(definition_hash, b_hash, seat, share_hash) + sig


def posting_record(definition_hash, b_hash, seat, m, ct):
    return header(POSTING) + definition_hash + b_hash + u8(seat) + m + ct


def complaint_statement(definition_hash, b_hash, seat, proof):
    """m = definition_hash ‖ ballot_hash ‖ u8(seat) ‖ encode(proof): 161 bytes."""
    m = definition_hash + b_hash + u8(seat) + se.enc_complaint(proof)
    assert len(m) == 161
    return m


def complaint_record(definition_hash, b_hash, seat, proof, d):
    m = complaint_statement(definition_hash, b_hash, seat, proof)
    return header(COMPLAINT) + m + sr.sign(d, m, COMPLAINT_TAG), m


TYPES = {"share-receipt": RECEIPT, "share-posting": POSTING, "share-complaint": COMPLAINT}


def parse_record(b, expect=None):
    """Strict decoding of the three records, as `expect` (a TYPES key) or as whichever of them `b` is; returns (kind, fields) or the decode error code."""
    if len(b) < 3:
        return "truncated"
    t, v = int.from_bytes(b[:2], "big"), b[2]
    if t not in (RECEIPT, POSTING, COMPLAINT) or (expect is not None and t != TYPES[expect]):
        return "unexpected-record-type"
    if v != 1:
        return "profile-mismatch"
    body = b[3:]
    if len(body) < 65:
        return "truncated"
    f = {"definitionHash": body[:32], "ballotHash": body[32:64], "seat": body[64]}
    rest = body[65:]
    if t == RECEIPT:
        if len(rest) < 96:
            return "truncated"
        if len(rest) > 96:
            return "trailing-bytes"
        f["shareHash"], f["signature"] = rest[:32], rest[32:]
        if not sig_canonical(f["signature"]):
            return "non-canonical"
        return "receipt", f
    if t == POSTING:
        if len(rest) < 32:
            return "truncated"
        f["m"] = rest[:32]
        ct = rest[32:]
        err = ciphertext_error(ct)
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
    if not sig_canonical(sig):
        return "non-canonical"
    f["proof"], f["signature"] = {"dh": d, "c": c, "z": z}, sig
    return "complaint", f


def sig_canonical(sig):
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    return 1 <= r < ecdsa.N and 1 <= s <= (ecdsa.N - 1) // 2


def ciphertext_error(ct):
    """share_ciphertext's strict decoding, as a field inside the posting: truncated, over the maximum, or non-canonical."""
    fixed = 1088 + 32 + 32 + 32
    if len(ct) < fixed + 4:
        return "truncated"
    n = int.from_bytes(ct[fixed : fixed + 4], "big")
    if n > se.MAX_SEALED:
        return "length-over-max"
    if len(ct) < fixed + 4 + n:
        return "truncated"
    if len(ct) > fixed + 4 + n:
        return "trailing-bytes"
    if se.dec_ciphertext(ct) is None:
        return "non-canonical"
    return None


def board_entry(version, election_id, index, segment, payload):
    return header(BOARD_ENTRY, version) + election_id + u64(index) + u32(segment) + u32(len(payload)) + payload


# Version 3 adds receipts and complaints, never postings: a posting delivers only through the contract path.
ALLOWED = {1: {0x0002, 0x0003, 0x0005, 0x0006, 0x0008}, 3: {0x0002, 0x0003, 0x0005, 0x0006, 0x0008, RECEIPT, COMPLAINT}}


def entry_error(b):
    """The board-entry envelope's own check of its payload's type, under versions 1 and 3."""
    v = b[2]
    payload = b[3 + 32 + 8 + 4 + 4 :]
    t = int.from_bytes(payload[:2], "big")
    return None if t in ALLOWED[v] else "unexpected-record-type"


# --- Windows ----------------------------------------------------------------------


def segments(epoch, period, closes_at, bound):
    end = closes_at + bound
    assert end >= epoch
    return (end + DELIVERY_WINDOW - epoch) // period, (end + COMPLAINT_WINDOW - epoch) // period


def deadlines(closes_at, bound):
    """The deadlines a contract-path record's submission time is compared with, in seconds."""
    end = closes_at + bound
    return end + DELIVERY_WINDOW, end + COMPLAINT_WINDOW


# --- The delivery check -----------------------------------------------------------


def check_delivery(definition_hash, registered, seg_d, seg_k, t_d, t_k, ballots, entries):
    """docs/spec/delivery.md, Delivery check, from the spec's text. Each entry is (path, segment or submission time, payload)."""
    hashes = [sr.ballot_hash(b["ctx"], bv.enc_committed_vote(b["vote"])) for b in ballots]
    index = {h: i for i, h in enumerate(hashes)}
    delivered = [set() for _ in ballots]
    reports, rejected = [], []
    receipts, complaints = [], []
    postings = [dict() for _ in ballots]
    for at, (path, when, payload) in enumerate(entries):
        parsed = parse_record(payload)
        # Board-entry version 3 never carries a posting: one through the board path is a rejected entry.
        if not isinstance(parsed, str) and parsed[0] == "posting" and path != "contract":
            parsed = "unexpected-record-type"
        if isinstance(parsed, str):
            rejected.append({"at": at, "error": parsed})
            continue
        kind, f = parsed
        if f["definitionHash"] != definition_hash:
            reports.append({"at": at, "code": "delivery-stray"})
            continue
        i = index.get(f["ballotHash"])
        if i is None:
            continue
        seat = f["seat"]
        key = registered.get(seat)
        if key is None:
            reports.append({"at": at, "code": "delivery-seat"})
            continue
        if path == "board":
            late = when > (seg_k if kind == "complaint" else seg_d)
        else:
            late = when > (t_k if kind == "complaint" else t_d)
        if late:
            reports.append({"at": at, "code": "delivery-late"})
            continue
        b = ballots[i]
        shares = b["vote"]["shareHashes"]
        if kind == "receipt":
            ok = f["shareHash"] == shares[seat - 1] and ecdsa.verify(
                key["signingKey"], bv.ds(RECEIPT_TAG, sr.statement(definition_hash, hashes[i], seat, shares[seat - 1])), f["signature"]
            )
            if not ok:
                own = sr.statement(definition_hash, f["ballotHash"], seat, f["shareHash"])
                signer = seat if ecdsa.verify(key["signingKey"], bv.ds(RECEIPT_TAG, own), f["signature"]) else None
                reports.append({"at": at, "code": "share-receipt", "signer": signer})
                continue
            delivered[i].add(seat)
            receipts.append((at, i, seat))
        elif kind == "posting":
            code, _ = se.check_posting(definition_hash, seat, key["kem"], b["vote"]["vss"], shares, f["ciphertext"], f["m"])
            if code != "ok":
                reports.append({"at": at, "code": code})
                continue
            delivered[i].add(seat)
            postings[i][seat] = f
        else:
            complaints.append((at, i, f))
    excluded = [[] for _ in ballots]
    for at, i, f in complaints:
        seat = f["seat"]
        posting = postings[i].get(seat)
        if posting is None:
            reports.append({"at": at, "code": "complaint-void"})
            continue
        b = ballots[i]
        key = registered[seat]
        code = se.check_complaint(definition_hash, seat, key["kem"], b["vote"]["vss"], b["vote"]["shareHashes"], posting["ciphertext"], posting["m"], f["proof"])
        m = complaint_statement(definition_hash, f["ballotHash"], seat, f["proof"])
        signer = seat if ecdsa.verify(key["signingKey"], bv.ds(COMPLAINT_TAG, m), f["signature"]) else None
        if code == "ok":
            excluded[i].append({"at": at, "seat": seat, "signer": signer})
        elif code == "complaint-unfounded":
            reports.append({"at": at, "code": code, "signer": signer})
        else:
            reports.append({"at": at, "code": "complaint-proof"})
    for at, i, seat in receipts:
        if any(c["seat"] == seat for c in excluded[i]):
            reports.append({"at": at, "code": "receipt-contradicted", "signer": seat})
    reports.sort(key=lambda r: r["at"])
    out = []
    for i, h in enumerate(hashes):
        missing = sorted(s for s in registered if s not in delivered[i])
        ex = sorted(excluded[i], key=lambda c: c["at"])
        out.append({"ballotHash": h.hex(), "counted": not missing and not ex, "delivered": not missing, "missing": missing, "excludedBy": ex})
    return {"ballots": out, "records": reports, "rejected": rejected}


# --- Vectors ----------------------------------------------------------------------


def main():
    grp.self_check()
    ecdsa.self_check()
    se.aead_self_check()
    se.mlkem_self_check(100)
    out = sys.argv[1]

    keys = se.trustee_keys("panel-3", 3)
    base = bv.context("delivery", 3, 0, 1, 2, 3)
    definition_hash = base["definitionHash"]
    other_definition = bv.H(b"another election")

    def signing_secret(seat):
        return ecdsa.secret(f"delivery/panel-3/signing/{seat}".encode())

    def identity_secret(seat):
        return ecdsa.secret(f"delivery/panel-3/identity/{seat}".encode())

    panel = [
        {
            "seat": s,
            "kemKey": se.enc_kem_key(keys[s - 1]).hex(),
            "signingSecret": f"{signing_secret(s):064x}",
            "signingKey": sr.p256_key(signing_secret(s)).hex(),
            "identityKey": sr.p256_key(identity_secret(s)).hex(),
        }
        for s in (1, 2, 3)
    ]

    def registered(seats=(1, 2, 3)):
        return {s: {"kem": keys[s - 1], "signingKey": sr.p256_key(signing_secret(s))} for s in seats}

    # Four voters' ballots under one definition, each with its own nullifier.
    # Carol's client is dishonest: seat 2's first share has v + 1, sealed correctly.
    def bad_share(ctx):
        def cheat(seat, sb, key, vss, m, e, w):
            if seat == 2:
                v = (int.from_bytes(sb[4:36], "little") + 1) % L
                sb = sb[:4] + bv.scalar(v) + sb[36:]
            return se.encrypt(ctx["definitionHash"], seat, key, vss, sb, m, e, w)

        return cheat

    ballots = {}
    for i, (name, votes, dishonest) in enumerate((("alice", [0, 1, 0], False), ("bob", [1, 0, 0], False), ("carol", [0, 0, 1], True), ("dave", [0, 1, 0], False))):
        ctx = dict(base, nullifier=int.from_bytes(bv.H(f"delivery/nullifier/{name}".encode()), "big") % bv.R)
        b = se.make_encrypted_ballot("delivery/" + name, ctx, votes, keys, bad_share(ctx) if dishonest else None)
        b["name"] = name
        b["hash"] = sr.ballot_hash(ctx, bv.enc_committed_vote(b["vote"]))
        ballots[name] = b

    def ballot_json(b):
        return {"id": b["name"], "tier": b["ctx"]["tier"], "nullifier": str(b["ctx"]["nullifier"]), "committedVote": bv.enc_committed_vote(b["vote"]).hex(), "ballotHash": b["hash"].hex()}

    # Every honest seat's receipt, from intake; posting and complaint material.
    def R(name, seat):
        b = ballots[name]
        result, r = sr.intake(b["ctx"], seat, keys[seat - 1], signing_secret(seat), b["vote"], b["cts"][seat - 1])
        assert result == "ok", (name, seat, result)
        return receipt_record(definition_hash, r["ballotHash"], seat, r["shareHash"], r["receipt"])

    def P(name, seat, m=None, ct=None, as_seat=None):
        b = ballots[name]
        m = m or bytes.fromhex(b["encRand"][seat - 1]["m"])
        return posting_record(definition_hash, b["hash"], as_seat or seat, m, ct or b["cts"][seat - 1])

    complaint_rng = bv.Rng("delivery/complaint")

    def proof_for(name, seat, honest=True):
        b = ballots[name]
        w = se.nonzero_scalar(complaint_rng)
        ct = b["cts"][seat - 1]
        m = bytes.fromhex(b["encRand"][seat - 1]["m"])
        hashes = b["vote"]["shareHashes"]
        if honest:
            return se.prove_complaint(definition_hash, seat, keys[seat - 1], b["vote"]["vss"], hashes, ct, m, w), w
        return se.raw_complaint(definition_hash, seat, keys[seat - 1], ct, w), w

    def C(name, seat, proof, secret=None):
        return complaint_record(definition_hash, ballots[name]["hash"], seat, proof, secret or signing_secret(seat))[0]

    carol_proof, carol_w = proof_for("carol", 2)
    alice_unfounded, _ = proof_for("alice", 2, honest=False)

    # --- Records re-made byte for byte ---
    records = []

    def record(id_, desc, type_, enc, extra):
        parsed = parse_record(enc, type_)
        assert not isinstance(parsed, str), (id_, parsed)
        records.append(dict({"id": id_, "description": desc, "type": type_, "encoding": enc.hex()}, **extra))

    a1 = R("alice", 1)
    record("receipt", "Seat 1's share receipt for Alice's ballot: its 97-byte statement, then its signature", "share-receipt", a1, {"seat": 1, "statement": a1[3:100].hex()})
    record("posting", "Alice's client posts seat 3's ciphertext with its ML-KEM message", "share-posting", P("alice", 3), {"seat": 3})
    cc, cm = complaint_record(definition_hash, ballots["carol"]["hash"], 2, carol_proof, signing_secret(2))
    record("complaint", "Seat 2's proven complaint about Carol's posted seat 2 share, signed with its per-election key", "share-complaint", cc, {"seat": 2, "statement": cm.hex(), "w": str(carol_w)})

    # --- Decode rejections ---
    decode = []

    def reject(id_, desc, type_, enc, error):
        got = parse_record(enc, type_)
        assert got == error, (id_, got)
        decode.append({"id": id_, "description": desc, "type": type_, "encoding": enc.hex(), "error": error})

    p3 = P("alice", 3)
    reject("receipt-truncated", "A share receipt one byte short", "share-receipt", a1[:-1], "truncated")
    reject("receipt-trailing", "A share receipt with a trailing byte", "share-receipt", a1 + b"\x00", "trailing-bytes")
    reject("receipt-as-posting", "A share receipt's bytes read as a posting", "share-posting", a1, "unexpected-record-type")
    reject("receipt-version-2", "A share receipt labelled version 2: ballot version 1 fixes version 1", "share-receipt", a1[:2] + b"\x02" + a1[3:], "profile-mismatch")
    r_, s_ = int.from_bytes(a1[-64:-32], "big"), int.from_bytes(a1[-32:], "big")
    reject("receipt-high-s", "A share receipt whose signature has s replaced by n − s", "share-receipt", a1[:-64] + ecdsa.sig_bytes(r_, ecdsa.N - s_), "non-canonical")
    reject("posting-truncated", "A posting one byte short", "share-posting", p3[:-1], "truncated")
    reject("posting-trailing", "A posting with a trailing byte", "share-posting", p3 + b"\x00", "trailing-bytes")
    ct3 = ballots["alice"]["cts"][2]
    reject("posting-identity-dh", "A posting whose ciphertext's ct_dh is the identity", "share-posting", P("alice", 3, ct=ct3[:1088] + bytes(32) + ct3[1120:]), "non-canonical")
    reject("posting-pok-z-l", "A posting whose ciphertext's proof response is ℓ", "share-posting", P("alice", 3, ct=ct3[:1152] + L.to_bytes(32, "little") + ct3[1184:]), "non-canonical")
    over = ct3[:1184] + u32(se.MAX_SEALED + 1) + bytes(se.MAX_SEALED + 1)
    reject("posting-sealed-over-max", "A posting whose ciphertext's sealed field is one byte over the 4116-byte maximum", "share-posting", P("alice", 3, ct=over), "length-over-max")
    reject("complaint-truncated", "A complaint one byte short", "share-complaint", cc[:-1], "truncated")
    reject("complaint-trailing", "A complaint with a trailing byte", "share-complaint", cc + b"\x00", "trailing-bytes")
    c_at = 3 + 65 + 32
    reject("complaint-c-l", "A complaint whose challenge is ℓ", "share-complaint", cc[:c_at] + L.to_bytes(32, "little") + cc[c_at + 32 :], "non-canonical")
    reject("complaint-identity-dh", "A complaint whose D is the identity", "share-complaint", cc[: 3 + 65] + bytes(32) + cc[3 + 65 + 32 :], "non-canonical")
    reject("complaint-as-receipt", "A complaint's bytes read as a share receipt", "share-receipt", cc, "unexpected-record-type")

    # --- Board entries ---
    election_id = bv.H(b"delivery/election")
    entries_json = []

    def entry(id_, desc, version, payload, error):
        enc = board_entry(version, election_id, 5, 7, payload)
        assert entry_error(enc) == error, id_
        entries_json.append({"id": id_, "description": desc, "version": version, "encoding": enc.hex(), "error": error})

    for name, payload in (("receipt", a1), ("complaint", cc)):
        entry(f"v3-{name}", f"A version-3 entry carrying a share {name}", 3, payload, None)
        entry(f"v1-{name}", f"A version-1 entry can't carry a share {name}", 1, payload, "unexpected-record-type")
    entry("v3-posting", "A version-3 entry can't carry a share posting: postings reach the board only as contract events", 3, p3, "unexpected-record-type")
    entry("v1-posting", "A version-1 entry can't carry a share posting", 1, p3, "unexpected-record-type")
    entry("v3-ballot-type", "A version-3 entry carrying a ballot header, as version 1 allows", 3, header(BALLOT) + b"\x00", None)
    entry("v3-receipt-type-0x0004", "A version-3 entry still refuses the voter's receipt (0x0004)", 3, header(0x0004) + b"\x00", "unexpected-record-type")

    # --- Deadline segments ---
    seg_json = []
    for id_, epoch, period, closes_at, bound in (
        ("hourly", 1_700_000_000, 3600, 1_700_360_000, 0),
        ("hourly-bound", 1_700_000_000, 3600, 1_700_360_000, 1800),
        ("boundary", 0, 3600, 3600 * 30 - 86_400, 0),
        ("one-before-boundary", 0, 3600, 3600 * 30 - 86_400 - 1, 0),
        ("daily", 1_000, 86_400, 1_000 + 86_400 * 3 + 5, 7),
    ):
        d, k = segments(epoch, period, closes_at, bound)
        td, tk = deadlines(closes_at, bound)
        seg_json.append(
            {
                "id": id_,
                "epoch": str(epoch),
                "period": str(period),
                "closesAt": str(closes_at),
                "l1InclusionBound": str(bound),
                "delivery": str(d),
                "complaint": str(k),
                "deliveryDeadline": str(td),
                "complaintDeadline": str(tk),
            }
        )

    # --- Elections ---
    elections = []
    SD, SK = 40, 112
    # The deadlines of a close at 1,700,000,000 with no inclusion bound, for contract-path records.
    TD, TK = deadlines(1_700_000_000, 0)

    def election(id_, desc, names, entries, seats=(1, 2, 3)):
        sel = [ballots[n] for n in names]
        result = check_delivery(definition_hash, registered(seats), SD, SK, TD, TK, sel, entries)
        elections.append(
            {
                "id": id_,
                "description": desc,
                "registered": list(seats),
                "segments": {"delivery": str(SD), "complaint": str(SK)},
                "deadlines": {"delivery": str(TD), "complaint": str(TK)},
                "ballots": [ballot_json(b) for b in sel],
                "entries": [{"path": "board", "segment": w, "payload": p.hex()} if path == "board" else {"path": "contract", "submittedAt": str(w), "payload": p.hex()} for path, w, p in entries],
                "result": result,
            }
        )
        return result

    def at(seg, *payloads):
        """Board-path records boarded in segment `seg`."""
        return [("board", seg, p) for p in payloads]

    def by(t, *payloads):
        """Contract-path records submitted at time `t`."""
        return [("contract", t, p) for p in payloads]

    T0 = TD - 86_400  # the close

    r = election("all-receipted", "Every seat receipts Alice's ballot; the last in the deadline's own segment", ["alice"], at(3, R("alice", 1), R("alice", 2)) + at(SD, R("alice", 3)))
    assert r["ballots"][0]["counted"]
    r = election("contract-receipts", "Seat 3's receipt reaches the board only through the contract path, as trustee nodes send them, submitted at the delivery deadline itself", ["alice"], at(3, R("alice", 1), R("alice", 2)) + by(TD, R("alice", 3)))
    assert r["ballots"][0]["counted"]
    r = election("late-contract-receipt", "Seat 3's contract-path receipt is submitted one second after the delivery deadline, though its contract event is in an early segment's counted extent", ["alice"], at(3, R("alice", 1), R("alice", 2)) + by(TD + 1, R("alice", 3)))
    assert r["ballots"][0]["missing"] == [3] and r["records"] == [{"at": 2, "code": "delivery-late"}]
    r = election("posting-fallback", "Seats 1 and 2 receipt; the voter chooses to post seat 3's ciphertext through the contract path", ["alice"], at(3, R("alice", 1), R("alice", 2)) + by(T0 + 60, P("alice", 3)))
    assert r["ballots"][0]["counted"]
    r = election("board-path-posting", "Seat 3's posting reaches the board through the board path: a rejected entry, which delivers nothing", ["alice"], at(3, R("alice", 1), R("alice", 2), P("alice", 3)))
    assert r["ballots"][0]["missing"] == [3] and r["rejected"] == [{"at": 2, "error": "unexpected-record-type"}]
    r = election("missing-seat", "Seat 3 neither receipted nor posted", ["alice"], at(3, R("alice", 1), R("alice", 2)))
    assert r["ballots"][0]["missing"] == [3]
    r = election("late-receipt", "Seat 3's receipt is boarded one segment after s_D", ["alice"], at(3, R("alice", 1), R("alice", 2)) + at(SD + 1, R("alice", 3)))
    assert r["ballots"][0]["missing"] == [3] and r["records"] == [{"at": 2, "code": "delivery-late"}]
    r = election("posting-at-deadline", "Seat 3's posting is submitted through the contract path at the delivery deadline itself", ["alice"], at(3, R("alice", 1), R("alice", 2)) + by(TD, P("alice", 3)))
    assert r["ballots"][0]["counted"]
    r = election("late-posting", "Seat 3's posting is submitted through the contract path one second after the delivery deadline", ["alice"], at(3, R("alice", 1), R("alice", 2)) + by(TD + 1, P("alice", 3)))
    assert r["ballots"][0]["missing"] == [3] and r["records"] == [{"at": 2, "code": "delivery-late"}]

    b_ = ballots["alice"]
    sh = b_["vote"]["shareHashes"]
    other_def_receipt = receipt_record(other_definition, b_["hash"], 3, sh[2], sr.sign(signing_secret(3), sr.statement(other_definition, b_["hash"], 3, sh[2])))
    r = election("stray", "Alice's ballot fully receipted, next to seat 3's receipt for another definition", ["alice"], at(3, R("alice", 1), R("alice", 2), other_def_receipt, R("alice", 3)))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 2, "code": "delivery-stray"}]

    m1 = sr.statement(definition_hash, b_["hash"], 1, sh[0])
    wrong_field = receipt_record(definition_hash, b_["hash"], 1, sh[1], sr.sign(signing_secret(1), m1))
    wrong_key = receipt_record(definition_hash, b_["hash"], 1, sh[0], sr.sign(signing_secret(2), m1))
    identity = receipt_record(definition_hash, b_["hash"], 1, sh[0], sr.sign(identity_secret(1), m1))
    m_other_ct = sr.statement(definition_hash, b_["hash"], 1, sh[1])
    other_ct = receipt_record(definition_hash, b_["hash"], 1, sh[1], sr.sign(signing_secret(1), m_other_ct))
    r = election(
        "failing-receipts",
        "Seat 1's receipt fails four ways: a share_hash field that isn't the ballot's (over a signature on the right statement), another seat's key, the identity key, and seat 1's own signature over seat 2's ciphertext (attributed to seat 1), the last through the contract path",
        ["alice"],
        at(3, wrong_field, wrong_key, identity) + by(T0 + 60, other_ct) + at(3, R("alice", 2), R("alice", 3)),
    )
    assert r["ballots"][0]["missing"] == [1] and [x["code"] for x in r["records"]] == ["share-receipt"] * 4
    # Only the last is seat 1's signature over its own fields: a share hash other than the ballot's, attributed.
    assert [x["signer"] for x in r["records"]] == [None, None, None, 1]

    r = election("unqualified-seat", "Seat 3 isn't qualified: seats 1 and 2 deliver the ballot, and seat 3's receipt names an unregistered seat", ["alice"], at(3, R("alice", 1), R("alice", 2), R("alice", 3)), seats=(1, 2))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 2, "code": "delivery-seat"}]

    m_alice1 = bytes.fromhex(b_["encRand"][0]["m"])
    r = election(
        "failing-postings",
        "Seat 3's contract-path postings fail: seat 1's m with seat 3's ciphertext (posting-encapsulation), seat 1's ciphertext posted as seat 3's (posting-hash)",
        ["alice"],
        at(3, R("alice", 1), R("alice", 2)) + by(T0 + 60, P("alice", 3, m=m_alice1), P("alice", 1, as_seat=3)),
    )
    assert r["ballots"][0]["missing"] == [3] and [x["code"] for x in r["records"]] == ["posting-encapsulation", "posting-hash"]

    carol_posted = at(3, R("carol", 1), R("carol", 3)) + by(T0 + 60, P("carol", 2))
    r = election("proven-complaint", "Carol's dishonest seat 2 share is posted through the contract path; seat 2 proves it invalid on the board, and the ballot is excluded though delivered", ["carol"], carol_posted + at(60, C("carol", 2, carol_proof)))
    assert r["ballots"][0]["delivered"] and not r["ballots"][0]["counted"] and r["ballots"][0]["excludedBy"] == [{"at": 3, "seat": 2, "signer": 2}]
    r = election("unattributed-complaint", "The same proof signed with seat 1's key: still proven, and the ballot is excluded, attributed to no one", ["carol"], carol_posted + at(60, C("carol", 2, carol_proof, secret=signing_secret(1))))
    assert r["ballots"][0]["excludedBy"] == [{"at": 3, "seat": 2, "signer": None}]
    r = election("complaint-in-its-segment", "The complaint is boarded in s_K itself", ["carol"], carol_posted + at(SK, C("carol", 2, carol_proof)))
    assert not r["ballots"][0]["counted"]
    r = election("late-complaint", "The complaint is boarded one segment after s_K: ignored, and Carol's ballot stays counted", ["carol"], carol_posted + at(SK + 1, C("carol", 2, carol_proof)))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 3, "code": "delivery-late"}]
    r = election("contract-complaint", "The complaint is submitted through the contract path at the end of the complaint window itself", ["carol"], carol_posted + by(TK, C("carol", 2, carol_proof)))
    assert not r["ballots"][0]["counted"]
    r = election("late-contract-complaint", "The complaint is submitted through the contract path one second after the complaint window: ignored", ["carol"], carol_posted + by(TK + 1, C("carol", 2, carol_proof)))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 3, "code": "delivery-late"}]
    r = election("void-complaint", "A complaint with no passing posting for its seat: void, and Carol's ballot lacks seat 2", ["carol"], at(3, R("carol", 1), R("carol", 3)) + at(60, C("carol", 2, carol_proof)))
    assert r["ballots"][0]["missing"] == [2] and r["records"] == [{"at": 2, "code": "complaint-void"}]
    r = election(
        "complaint-on-board-path-posting",
        "Carol's seat 2 posting reaches the board only through the board path, so it is rejected and delivers nothing: a complaint about it is void, and the ballot lacks seat 2",
        ["carol"],
        at(3, R("carol", 1), R("carol", 3), P("carol", 2)) + at(60, C("carol", 2, carol_proof)),
    )
    assert r["ballots"][0]["missing"] == [2] and r["records"] == [{"at": 3, "code": "complaint-void"}] and r["rejected"] == [{"at": 2, "error": "unexpected-record-type"}]
    r = election("unfounded-complaint", "Seat 2 complains about Alice's valid posted share: unfounded, attributed to seat 2, and the ballot stands", ["alice"], at(3, R("alice", 1), R("alice", 3)) + by(T0 + 60, P("alice", 2)) + at(60, C("alice", 2, alice_unfounded)))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 3, "code": "complaint-unfounded", "signer": 2}]
    bad = dict(carol_proof, z=(carol_proof["z"] + 1) % L)
    r = election("complaint-proof-fails", "Seat 2's complaint with z + 1, re-signed: its proof fails, and Carol's ballot stays counted", ["carol"], carol_posted + at(60, C("carol", 2, bad)))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 3, "code": "complaint-proof"}]
    bc = ballots["carol"]
    sh_c = bc["vote"]["shareHashes"]
    false_receipt = receipt_record(definition_hash, bc["hash"], 2, sh_c[1], sr.sign(signing_secret(2), sr.statement(definition_hash, bc["hash"], 2, sh_c[1])))
    r = election(
        "contradicted-receipt",
        "Seat 2 signs a receipt for Carol's invalid share, and its complaint about the posting is proven: excluded, and the receipt is reported against seat 2",
        ["carol"],
        at(3, R("carol", 1), false_receipt, R("carol", 3)) + by(T0 + 60, P("carol", 2)) + at(60, C("carol", 2, carol_proof)),
    )
    assert not r["ballots"][0]["counted"] and r["records"] == [{"at": 1, "code": "receipt-contradicted", "signer": 2}]

    # Three ballots, with duplicates, a record for Dave's ballot (not selected) and two orders.
    mixed = (
        at(2, R("alice", 2), R("bob", 1), R("dave", 1), R("alice", 1), R("carol", 1))
        + by(T0 + 300, P("carol", 2))
        + at(5, R("alice", 2), R("bob", 3), R("carol", 3))
        + by(T0 + 600, P("alice", 3))
        + at(SD, R("alice", 1))
        + at(70, C("carol", 2, carol_proof))
    )
    first = election("three-ballots", "Alice counted, Bob missing seat 2, Carol excluded; duplicates and a record for Dave's unselected ballot decide nothing", ["alice", "bob", "carol"], mixed)
    assert [x["counted"] for x in first["ballots"]] == [True, False, False] and first["ballots"][1]["missing"] == [2] and first["records"] == []
    # The same records in reverse board order (board-path segments made non-decreasing again): the same verdicts.
    rev = list(reversed(mixed))
    segs = iter(sorted(w for path, w, _ in mixed if path == "board"))
    reordered = [(path, next(segs) if path == "board" else w, p) for path, w, p in rev]
    second = election("three-ballots-reordered", "The same records in reverse order: the same verdicts", ["alice", "bob", "carol"], reordered)
    strip = lambda res: [{k: v for k, v in b.items() if k != "excludedBy"} | {"excludedBy": [c["seat"] for c in b["excludedBy"]]} for b in res["ballots"]]
    assert strip(first) == strip(second)

    junk_ct = ct3[:1088] + bytes(32) + ct3[1120:]
    r = election(
        "rejected-entries",
        "A truncated receipt, a contract-path posting whose ciphertext doesn't decode, a ballot header and a payload shorter than a record header are rejected entries; the ballot is delivered by the rest",
        ["alice"],
        at(3, a1[:-1], R("alice", 1)) + by(T0 + 60, P("alice", 3, ct=junk_ct)) + at(3, R("alice", 2), header(BALLOT) + b"\x00", R("alice", 3), b"\x00\x0c"),
    )
    assert r["ballots"][0]["counted"] and r["rejected"] == [
        {"at": 0, "error": "truncated"},
        {"at": 2, "error": "non-canonical"},
        {"at": 4, "error": "unexpected-record-type"},
        {"at": 6, "error": "truncated"},
    ]

    data = {
        "format": "abolish-delivery-vectors/1",
        "title": "Share delivery on the board: receipts, postings, complaints and the delivery check",
        "spec": "docs/spec/delivery.md",
        "generator": (
            "Printed by packages/crypto/scripts/delivery-vectors.py, an implementation of "
            "docs/spec/delivery.md in Python's integers and hashlib, sharing no code with "
            "packages/crypto or any @noble library. It reuses share-receipt-vectors.py's ballot hash, "
            "intake and P-256 ECDSA (checked against RFC 6979 Appendix A.2.5 first) and "
            "share-encryption-vectors.py's ballots, posting check and complaints. Secrets are SHA-256 "
            "of fixed labels: test data only."
        ),
        "tags": {"receipt": RECEIPT_TAG.decode(), "complaint": COMPLAINT_TAG.decode()},
        "windows": {"delivery": str(DELIVERY_WINDOW), "complaint": str(COMPLAINT_WINDOW)},
        "definitionHash": definition_hash.hex(),
        "panel": panel,
        "records": records,
        "decode": decode,
        "boardEntries": entries_json,
        "segments": seg_json,
        "elections": elections,
    }
    with open(f"{out}/delivery.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
