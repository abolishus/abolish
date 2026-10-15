#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/delivery-batch.json.

A second implementation of docs/spec/delivery.md's share-receipt batch
(0x0016, version 1) and share-complaint batch (0x0017, version 1): the
records, their signed messages and their strict decoding, and the delivery
check reading each entry of a contract-path batch as the receipt or complaint
it states, beside single receipts, postings and complaints. It
is written from the spec with Python's integers and hashlib, and shares no
code with packages/crypto or any @noble library. It reuses
delivery-vectors.py's records, decoding and windows, and through it
share-receipt-vectors.py's ballot hash, intake and P-256 ECDSA (checked
against RFC 6979 Appendix A.2.5 first) and share-encryption-vectors.py's
ballots, posting check and complaints. The panel and ballots are
delivery.json's, made from the same labels.

Every secret comes from SHA-256 over a fixed label. The values are test
data, never keys.

Usage: python3 -I -B packages/crypto/scripts/delivery-batch-vectors.py <out-dir>
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
sr, se, ecdsa, bv, grp = dv.sr, dv.se, dv.ecdsa, dv.bv, dv.grp

L = grp.L
BATCH = 0x0016
BATCH_TAG = b"abolish/v1/sig/share-receipt-batch"
BATCH_MAX = 1024
COMPLAINT_BATCH = 0x0017
COMPLAINT_BATCH_TAG = b"abolish/v1/sig/share-complaint-batch"
COMPLAINT_BATCH_MAX = 512
P25519 = 2**255 - 19
POSTING = dv.POSTING
u8, u32 = bv.u8, bv.u32

# --- The record -------------------------------------------------------------------


def batch_statement(definition_hash, seat, pairs):
    """m = definition_hash ‖ u8(seat) ‖ u32(c) ‖ (ballot_hash ‖ share_hash) × c: 37 + 64·c bytes."""
    m = definition_hash + u8(seat) + u32(len(pairs)) + b"".join(bh + sh for bh, sh in pairs)
    assert len(m) == 37 + 64 * len(pairs)
    return m


def batch_record(definition_hash, seat, pairs, d, sort=True):
    """A batch signed with secret `d`; pairs sorted ascending by ballot hash unless `sort` is False."""
    if sort:
        pairs = sorted(pairs)
    m = batch_statement(definition_hash, seat, pairs)
    return dv.header(BATCH) + m + sr.sign(d, m, BATCH_TAG)


def parse_batch(b):
    """Strict decoding of a batch under version 1 (docs/spec/delivery.md, Share-receipt batch,
    Decoding), in field order; returns the fields or (error, offset)."""
    if len(b) < 2:
        return "truncated", 0
    if int.from_bytes(b[:2], "big") != BATCH:
        return "unexpected-record-type", 0
    if len(b) < 3:
        return "truncated", 2
    if b[2] != 1:
        return "profile-mismatch", 2
    if len(b) < 35:
        return "truncated", 3
    if len(b) < 36:
        return "truncated", 35
    if len(b) < 40:
        return "truncated", 36
    c = int.from_bytes(b[36:40], "big")
    if c > BATCH_MAX:
        return "length-over-max", 36
    if c == 0:
        return "non-canonical", 36
    pairs = []
    for j in range(c):
        o = 40 + 64 * j
        if len(b) < o + 32:
            return "truncated", o
        bh = b[o : o + 32]
        if pairs and bh <= pairs[-1][0]:
            return "non-canonical", o
        if len(b) < o + 64:
            return "truncated", o + 32
        pairs.append((bh, b[o + 32 : o + 64]))
    s = 40 + 64 * c
    if len(b) < s + 64:
        return "truncated", s
    sig = b[s : s + 64]
    if not dv.sig_canonical(sig):
        return "non-canonical", s
    if len(b) > s + 64:
        return "trailing-bytes", s + 64
    return {"definitionHash": b[3:35], "seat": b[35], "pairs": pairs, "signature": sig, "statement": b[3:s]}


def is_batch(payload):
    return len(payload) >= 3 and int.from_bytes(payload[:2], "big") == BATCH


# --- The share-complaint batch (0x0017) ----------------------------------------------


def complaint_batch_statement(definition_hash, seat, entries):
    """m = definition_hash ‖ u8(seat) ‖ u32(c) ‖ (ballot_hash ‖ encode(proof)) × c: 37 + 128·c bytes."""
    m = definition_hash + u8(seat) + u32(len(entries)) + b"".join(bh + se.enc_complaint(p) for bh, p in entries)
    assert len(m) == 37 + 128 * len(entries)
    return m


def complaint_batch_record(definition_hash, seat, entries, d, sort=True):
    """A complaint batch of (ballot_hash, proof) entries, signed with secret `d`."""
    if sort:
        entries = sorted(entries, key=lambda e: e[0])
    m = complaint_batch_statement(definition_hash, seat, entries)
    return dv.header(COMPLAINT_BATCH) + m + sr.sign(d, m, COMPLAINT_BATCH_TAG)


def parse_complaint_batch(b, framed=False):
    """Strict decoding of a complaint batch under version 1 (docs/spec/delivery.md, Share-complaint
    batch, Decoding), in field order; returns the fields or (error, offset). With `framed`, each D is
    only framed as the board frames an element (even, nonzero, below 2^255 - 19), never decoded
    (contracts.md, What the board frames)."""
    if len(b) < 2:
        return "truncated", 0
    if int.from_bytes(b[:2], "big") != COMPLAINT_BATCH:
        return "unexpected-record-type", 0
    if len(b) < 3:
        return "truncated", 2
    if b[2] != 1:
        return "profile-mismatch", 2
    if len(b) < 35:
        return "truncated", 3
    if len(b) < 36:
        return "truncated", 35
    if len(b) < 40:
        return "truncated", 36
    c = int.from_bytes(b[36:40], "big")
    if c > COMPLAINT_BATCH_MAX:
        return "length-over-max", 36
    if c == 0:
        return "non-canonical", 36
    entries = []
    for j in range(c):
        o = 40 + 128 * j
        if len(b) < o + 32:
            return "truncated", o
        bh = b[o : o + 32]
        if entries and bh <= entries[-1][0]:
            return "non-canonical", o
        if len(b) < o + 64:
            return "truncated", o + 32
        d_raw = b[o + 32 : o + 64]
        if framed:
            v = int.from_bytes(d_raw, "little")
            d = d_raw if 0 < v < P25519 and v % 2 == 0 else None
        else:
            d = None if d_raw == bytes(32) else grp.decode(d_raw)
        if d is None:
            return "non-canonical", o + 32
        if len(b) < o + 96:
            return "truncated", o + 64
        cc = int.from_bytes(b[o + 64 : o + 96], "little")
        if cc >= L:
            return "non-canonical", o + 64
        if len(b) < o + 128:
            return "truncated", o + 96
        z = int.from_bytes(b[o + 96 : o + 128], "little")
        if z >= L:
            return "non-canonical", o + 96
        entries.append((bh, {"dh": d, "c": cc, "z": z}))
    s = 40 + 128 * c
    if len(b) < s + 64:
        return "truncated", s
    sig = b[s : s + 64]
    if not dv.sig_canonical(sig):
        return "non-canonical", s
    if len(b) > s + 64:
        return "trailing-bytes", s + 64
    return {"definitionHash": b[3:35], "seat": b[35], "entries": entries, "signature": sig, "statement": b[3:s]}


def is_complaint_batch(payload):
    return len(payload) >= 3 and int.from_bytes(payload[:2], "big") == COMPLAINT_BATCH


# --- The delivery check, with batches ------------------------------------------------


def check_delivery(definition_hash, registered, seg_d, seg_k, t_d, t_k, ballots, entries):
    """docs/spec/delivery.md, Delivery check, from the spec's text, with each pair of a
    contract-path batch read as the receipt it states. Each entry is (path, segment or
    submission time, payload)."""
    hashes = [sr.ballot_hash(b["ctx"], bv.enc_committed_vote(b["vote"])) for b in ballots]
    index = {h: i for i, h in enumerate(hashes)}
    delivered = [set() for _ in ballots]
    reports, rejected = [], []
    receipts, complaints = [], []
    postings = [dict() for _ in ballots]

    def in_time(path, when, kind):
        if path == "board":
            return when <= (seg_k if kind == "complaint" else seg_d)
        return when <= (t_k if kind == "complaint" else t_d)

    def receipt(at, pair, i, seat, share_hash, signed_ballot, signed_own):
        """One receipt, single or a batch's pair: `signed_ballot` whether its signature covers the
        statement rebuilt from ballot i, `signed_own` whether it covers the record's own fields."""
        extra = {} if pair is None else {"pair": pair}
        shares = ballots[i]["vote"]["shareHashes"]
        if not (share_hash == shares[seat - 1] and signed_ballot):
            reports.append(dict({"at": at}, **extra, code="share-receipt", signer=seat if signed_own else None))
            return
        delivered[i].add(seat)
        receipts.append((at, pair, i, seat))

    for at, (path, when, payload) in enumerate(entries):
        if is_complaint_batch(payload):
            if path != "contract":
                rejected.append({"at": at, "error": "unexpected-record-type"})
                continue
            f = parse_complaint_batch(payload)
            if isinstance(f, tuple):
                rejected.append({"at": at, "error": f[0]})
                continue
            if f["definitionHash"] != definition_hash:
                reports.append({"at": at, "code": "delivery-stray"})
                continue
            seat = f["seat"]
            key = registered.get(seat)
            signed = key is not None and ecdsa.verify(key["signingKey"], bv.ds(COMPLAINT_BATCH_TAG, f["statement"]), f["signature"])
            for j, (bh, proof) in enumerate(f["entries"]):
                i = index.get(bh)
                if i is None:
                    continue
                if key is None:
                    reports.append({"at": at, "pair": j, "code": "delivery-seat"})
                    continue
                if not in_time(path, when, "complaint"):
                    reports.append({"at": at, "pair": j, "code": "delivery-late"})
                    continue
                complaints.append((at, j, i, {"seat": seat, "proof": proof, "signed": signed}))
            continue
        if is_batch(payload):
            # No board-entry version allows a batch: through the board path it is a rejected entry.
            if path != "contract":
                rejected.append({"at": at, "error": "unexpected-record-type"})
                continue
            f = parse_batch(payload)
            if isinstance(f, tuple):
                rejected.append({"at": at, "error": f[0]})
                continue
            if f["definitionHash"] != definition_hash:
                reports.append({"at": at, "code": "delivery-stray"})
                continue
            seat = f["seat"]
            key = registered.get(seat)
            # The one signature, over the batch's own fields: each pair's statement, at once.
            signed = key is not None and ecdsa.verify(key["signingKey"], bv.ds(BATCH_TAG, f["statement"]), f["signature"])
            for j, (bh, sh) in enumerate(f["pairs"]):
                i = index.get(bh)
                if i is None:
                    continue
                if key is None:
                    reports.append({"at": at, "pair": j, "code": "delivery-seat"})
                    continue
                if not in_time(path, when, "receipt"):
                    reports.append({"at": at, "pair": j, "code": "delivery-late"})
                    continue
                # A pair names its ballot by hash, so the statement rebuilt from ballot i is its own.
                receipt(at, j, i, seat, sh, signed, signed)
            continue
        if path != "contract" and len(payload) >= 3 and int.from_bytes(payload[:2], "big") == POSTING:
            parsed = "unexpected-record-type"
        else:
            parsed = dv.parse_record(payload)
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
        if not in_time(path, when, kind):
            reports.append({"at": at, "code": "delivery-late"})
            continue
        b = ballots[i]
        shares = b["vote"]["shareHashes"]
        if kind == "receipt":
            on_ballot = ecdsa.verify(key["signingKey"], bv.ds(dv.RECEIPT_TAG, sr.statement(definition_hash, hashes[i], seat, shares[seat - 1])), f["signature"])
            own = ecdsa.verify(key["signingKey"], bv.ds(dv.RECEIPT_TAG, sr.statement(definition_hash, f["ballotHash"], seat, f["shareHash"])), f["signature"])
            receipt(at, None, i, seat, f["shareHash"], on_ballot, own)
        elif kind == "posting":
            code, _ = se.check_posting(definition_hash, seat, key["kem"], b["vote"]["vss"], shares, f["ciphertext"], f["m"])
            if code != "ok":
                reports.append({"at": at, "code": code})
                continue
            delivered[i].add(seat)
            postings[i][seat] = f
        else:
            complaints.append((at, None, i, f))
    excluded = [[] for _ in ballots]
    for at, pair, i, f in complaints:
        extra = {} if pair is None else {"pair": pair}
        seat = f["seat"]
        posting = postings[i].get(seat)
        if posting is None:
            reports.append(dict({"at": at}, **extra, code="complaint-void"))
            continue
        b = ballots[i]
        key = registered[seat]
        code = se.check_complaint(definition_hash, seat, key["kem"], b["vote"]["vss"], b["vote"]["shareHashes"], posting["ciphertext"], posting["m"], f["proof"])
        if pair is None:
            m = dv.complaint_statement(definition_hash, f["ballotHash"], seat, f["proof"])
            signed = ecdsa.verify(key["signingKey"], bv.ds(dv.COMPLAINT_TAG, m), f["signature"])
        else:
            # A batch entry is attributed by the batch's one signature.
            signed = f["signed"]
        signer = seat if signed else None
        if code == "ok":
            excluded[i].append(dict({"at": at}, **extra, seat=seat, signer=signer))
        elif code == "complaint-unfounded":
            reports.append(dict({"at": at}, **extra, code=code, signer=signer))
        else:
            reports.append(dict({"at": at}, **extra, code="complaint-proof"))
    for at, pair, i, seat in receipts:
        if any(c["seat"] == seat for c in excluded[i]):
            reports.append(dict({"at": at}, **({} if pair is None else {"pair": pair}), code="receipt-contradicted", signer=seat))
    reports.sort(key=lambda r: (r["at"], r.get("pair", -1)))
    out = []
    for i, h in enumerate(hashes):
        missing = sorted(s for s in registered if s not in delivered[i])
        ex = sorted(excluded[i], key=lambda c: (c["at"], c.get("pair", -1)))
        out.append({"ballotHash": h.hex(), "counted": not missing and not ex, "delivered": not missing, "missing": missing, "excludedBy": ex})
    return {"ballots": out, "records": reports, "rejected": rejected}


# --- Vectors ----------------------------------------------------------------------


def main():
    grp.self_check()
    ecdsa.self_check()
    se.aead_self_check()
    se.mlkem_self_check(100)
    out = sys.argv[1]

    # delivery.json's panel, definition and ballots, from the same labels.
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

    def bad_share(ctx):
        def cheat(seat, sb, key, vss, m, e, w):
            if seat == 2:
                v = (int.from_bytes(sb[4:36], "little") + 1) % L
                sb = sb[:4] + bv.scalar(v) + sb[36:]
            return se.encrypt(ctx["definitionHash"], seat, key, vss, sb, m, e, w)

        return cheat

    ballots = {}
    for name, votes, dishonest in (("alice", [0, 1, 0], False), ("bob", [1, 0, 0], False), ("carol", [0, 0, 1], True), ("dave", [0, 1, 0], False)):
        ctx = dict(base, nullifier=int.from_bytes(bv.H(f"delivery/nullifier/{name}".encode()), "big") % bv.R)
        b = se.make_encrypted_ballot("delivery/" + name, ctx, votes, keys, bad_share(ctx) if dishonest else None)
        b["name"] = name
        b["hash"] = sr.ballot_hash(ctx, bv.enc_committed_vote(b["vote"]))
        ballots[name] = b

    def ballot_json(b):
        return {"id": b["name"], "tier": b["ctx"]["tier"], "nullifier": str(b["ctx"]["nullifier"]), "committedVote": bv.enc_committed_vote(b["vote"]).hex(), "ballotHash": b["hash"].hex()}

    def receipted(name, seat):
        """Seat `seat`'s intake of the ballot: its (ballot_hash, share_hash) pair and its single receipt."""
        b = ballots[name]
        result, r = sr.intake(b["ctx"], seat, keys[seat - 1], signing_secret(seat), b["vote"], b["cts"][seat - 1])
        assert result == "ok", (name, seat, result)
        return (r["ballotHash"], r["shareHash"]), dv.receipt_record(definition_hash, r["ballotHash"], seat, r["shareHash"], r["receipt"])

    def pair(name, seat):
        return receipted(name, seat)[0]

    def R(name, seat):
        return receipted(name, seat)[1]

    def B(seat, names, secret=None, definition=None):
        return batch_record(definition or definition_hash, seat, [pair(n, seat) for n in names], secret or signing_secret(seat))

    def P(name, seat):
        b = ballots[name]
        return dv.posting_record(definition_hash, b["hash"], seat, bytes.fromhex(b["encRand"][seat - 1]["m"]), b["cts"][seat - 1])

    complaint_rng = bv.Rng("delivery-batch/complaint")
    bc = ballots["carol"]
    carol_proof = se.prove_complaint(definition_hash, 2, keys[1], bc["vote"]["vss"], bc["vote"]["shareHashes"], bc["cts"][1], bytes.fromhex(bc["encRand"][1]["m"]), se.nonzero_scalar(complaint_rng))
    carol_complaint = dv.complaint_record(definition_hash, bc["hash"], 2, carol_proof, signing_secret(2))[0]

    # --- Records re-made byte for byte ---
    records = []

    def record(id_, desc, enc, listed=True):
        """A batch, with its pairs and signed statement listed unless it is too long to repeat."""
        f = parse_batch(enc)
        assert isinstance(f, dict), (id_, f)
        r = {"id": id_, "description": desc, "encoding": enc.hex(), "seat": f["seat"], "count": len(f["pairs"])}
        if listed:
            r["pairs"] = [{"ballotHash": bh.hex(), "shareHash": sh.hex()} for bh, sh in f["pairs"]]
            r["statement"] = f["statement"].hex()
        records.append(r)

    one = B(1, ["alice"])
    record("one-pair", "Seat 1's batch of its one receipt for Alice's ballot: 168 bytes", one)
    three = B(1, ["alice", "bob", "carol"])
    record("three-pairs", "Seat 1's batch of its receipts for Alice's, Bob's and Carol's ballots, ascending by ballot hash", three)
    # The most pairs a batch carries: made-up pairs, never receipted, ascending by construction.
    full_pairs = [(bv.H(f"delivery-batch/full/{j}".encode()), bv.H(f"delivery-batch/full/share/{j}".encode())) for j in range(BATCH_MAX)]
    full = batch_record(definition_hash, 2, full_pairs, signing_secret(2))
    assert len(full) == 104 + 64 * BATCH_MAX == 65_640
    record("max-pairs", "Seat 2's batch of RECEIPT_BATCH_MAX made-up pairs: 65,640 bytes; pair j is H(\"delivery-batch/full/j\") and H(\"delivery-batch/full/share/j\")", full, listed=False)

    # --- Decode rejections ---
    decode = []

    def reject(id_, desc, enc, error, offset):
        got = parse_batch(enc)
        assert got == (error, offset), (id_, got)
        decode.append({"id": id_, "description": desc, "encoding": enc.hex(), "error": error, "offset": offset})

    sig_at = len(three) - 64
    reject("truncated-header", "The type alone: a record ending before its version", three[:2], "truncated", 2)
    reject("another-type", "A share receipt's bytes read as a batch", R("alice", 1), "unexpected-record-type", 0)
    reject("version-2", "A batch labelled version 2: ballot versions 1 to 3 fix version 1", three[:2] + b"\x02" + three[3:], "profile-mismatch", 2)
    reject("truncated-definition", "A batch ending inside its definition hash", three[:20], "truncated", 3)
    reject("truncated-seat", "A batch ending after its definition hash", three[:35], "truncated", 35)
    reject("truncated-count", "A batch ending inside its count", three[:38], "truncated", 36)
    empty = dv.header(BATCH) + batch_statement(definition_hash, 1, [])
    empty += sr.sign(signing_secret(1), empty[3:], BATCH_TAG)
    reject("empty", "A signed batch of no pairs", empty, "non-canonical", 36)
    over = three[:36] + u32(BATCH_MAX + 1) + three[40:]
    reject("over-max", "A count of RECEIPT_BATCH_MAX + 1, refused before any pair is read", over, "length-over-max", 36)
    ps = sorted([pair("alice", 1), pair("bob", 1), pair("carol", 1)])
    unordered = batch_record(definition_hash, 1, [ps[1], ps[0], ps[2]], signing_secret(1), sort=False)
    reject("unordered", "Seat 1's three pairs with the first two swapped, signed as they stand", unordered, "non-canonical", 104)
    repeated = batch_record(definition_hash, 1, [ps[0], ps[0]], signing_secret(1), sort=False)
    reject("repeated", "The same pair twice, signed: equal ballot hashes aren't ascending", repeated, "non-canonical", 104)
    reject("truncated-pair", "A batch whose count says three pairs, ending inside the third's ballot hash", three[: 40 + 64 * 2 + 10], "truncated", 168)
    reject("truncated-share-hash", "A batch ending inside its second pair's share hash", three[: 40 + 64 + 40], "truncated", 136)
    reject("truncated-signature", "A batch one byte short", three[:-1], "truncated", sig_at)
    r_, s_ = int.from_bytes(three[-64:-32], "big"), int.from_bytes(three[-32:], "big")
    reject("high-s", "The signature with s replaced by n − s", three[:-64] + ecdsa.sig_bytes(r_, ecdsa.N - s_), "non-canonical", sig_at)
    reject("zero-r", "The signature with r of 0", three[:-64] + ecdsa.sig_bytes(0, s_), "non-canonical", sig_at)
    reject("trailing", "A batch with a trailing byte", three + b"\x00", "trailing-bytes", len(three))

    # --- Elections ---
    elections = []
    SD, SK = 40, 112
    TD, TK = dv.deadlines(1_700_000_000, 0)
    T0 = TD - dv.DELIVERY_WINDOW

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
        return [("board", seg, p) for p in payloads]

    def by(t, *payloads):
        return [("contract", t, p) for p in payloads]

    abd = ["alice", "bob", "dave"]
    honest = ["alice", "bob"]
    r = election("batches-deliver", "Each seat sends one batch for Alice's and Bob's ballots through the contract path: both are delivered", honest, by(T0 + 60, B(1, honest), B(2, honest), B(3, honest)))
    assert all(b["counted"] for b in r["ballots"]) and r["records"] == []
    r = election("batch-at-deadline", "Seat 3's batch is submitted at the delivery deadline itself", honest, by(T0 + 60, B(1, honest), B(2, honest)) + by(TD, B(3, honest)))
    assert all(b["counted"] for b in r["ballots"])
    r = election("late-batch", "Seat 3's batch is submitted one second after the delivery deadline: each of its pairs is late", honest, by(T0 + 60, B(1, honest), B(2, honest)) + by(TD + 1, B(3, honest)))
    assert [b["missing"] for b in r["ballots"]] == [[3], [3]] and [x["code"] for x in r["records"]] == ["delivery-late"] * 2
    r = election("mixed", "Seat 1 receipts through the board path, seat 2 by batch, seat 3 by a single contract-path receipt for Alice and a batch for Bob", honest, at(3, R("alice", 1), R("bob", 1)) + by(T0 + 60, B(2, honest), R("alice", 3), B(3, ["bob"])))
    assert all(b["counted"] for b in r["ballots"])
    r = election("board-path-batch", "Seat 3's batch reaches the board through the board path: a rejected entry, which delivers nothing", honest, by(T0 + 60, B(1, honest), B(2, honest)) + at(3, B(3, honest)))
    assert [b["missing"] for b in r["ballots"]] == [[3], [3]] and r["rejected"] == [{"at": 2, "error": "unexpected-record-type"}]
    r = election("stray-batch", "Seat 3's batch names another definition: reported once, and delivers nothing", ["alice"], by(T0 + 60, B(1, ["alice"]), B(2, ["alice"]), B(3, ["alice"], definition=other_definition)))
    assert r["ballots"][0]["missing"] == [3] and r["records"] == [{"at": 2, "code": "delivery-stray"}]
    r = election("unqualified-batch", "Seat 3 isn't qualified: its batch is delivery-seat for each pair naming a selected ballot", honest, by(T0 + 60, B(1, honest), B(2, honest), B(3, honest)), seats=(1, 2))
    assert all(b["counted"] for b in r["ballots"]) and [x["code"] for x in r["records"]] == ["delivery-seat"] * 2
    r = election("wrong-key", "Seat 3's batch signed with seat 2's key: share-receipt for each pair, attributed to no one", honest, by(T0 + 60, B(1, honest), B(2, honest), B(3, honest, secret=signing_secret(2))))
    assert [b["missing"] for b in r["ballots"]] == [[3], [3]] and [(x["code"], x["signer"]) for x in r["records"]] == [("share-receipt", None)] * 2
    r = election("identity-key", "Seat 3's batch signed with its identity key: never its per-election key, so attributed to no one", honest, by(T0 + 60, B(1, honest), B(2, honest), B(3, honest, secret=identity_secret(3))))
    assert [(x["code"], x["signer"]) for x in r["records"]] == [("share-receipt", None)] * 2
    ba, bb = ballots["alice"], ballots["bob"]
    wrong_share = batch_record(definition_hash, 3, [pair("alice", 3), (bb["hash"], bb["vote"]["shareHashes"][0])], signing_secret(3))
    r = election("wrong-share-hash", "Seat 3's signed batch pairs Bob's ballot with seat 1's share hash: that pair is share-receipt, attributed to seat 3, and Alice's pair delivers", honest, by(T0 + 60, B(1, honest), B(2, honest), wrong_share))
    assert r["ballots"][0]["counted"] and r["ballots"][1]["missing"] == [3] and [(x["code"], x["signer"]) for x in r["records"]] == [("share-receipt", 3)]
    unselected = B(3, ["alice", "dave"])
    r = election("unselected-pair", "Seat 3's batch also carries a pair for Dave's ballot, which isn't selected: set aside, reporting nothing", ["alice"], by(T0 + 60, B(1, ["alice"]), B(2, ["alice"]), unselected))
    assert r["ballots"][0]["counted"] and r["records"] == []
    r = election("duplicates", "Seat 3's pair for Alice in two batches and a single receipt: delivered once, nothing reported", ["alice"], by(T0 + 60, B(1, ["alice"]), B(2, ["alice"]), B(3, ["alice"]), B(3, ["alice", "bob"]), R("alice", 3)))
    assert r["ballots"][0]["counted"] and r["records"] == []
    bad_batch = B(3, honest)
    bad_batch = bad_batch[:-1]
    r = election("malformed-batch", "Seat 3's batch one byte short is a rejected entry", honest, by(T0 + 60, B(1, honest), B(2, honest), bad_batch))
    assert r["rejected"] == [{"at": 2, "error": "truncated"}]
    false_pairs = [pair("alice", 2), (bc["hash"], bc["vote"]["shareHashes"][1])]
    false_batch = batch_record(definition_hash, 2, false_pairs, signing_secret(2))
    r = election(
        "contradicted-pair",
        "Seat 2's batch receipts Carol's invalid share beside Alice's, and its complaint about Carol's posting is proven: Carol is excluded and the pair is reported against seat 2",
        ["alice", "carol"],
        by(T0 + 60, B(1, ["alice", "carol"]), false_batch, B(3, ["alice", "carol"]), P("carol", 2)) + at(60, carol_complaint),
    )
    assert r["ballots"][0]["counted"] and not r["ballots"][1]["counted"]
    contradicted = [x for x in r["records"] if x["code"] == "receipt-contradicted"]
    assert len(contradicted) == 1 and contradicted[0]["signer"] == 2 and contradicted[0]["at"] == 1
    # Reordering the records changes no verdict (R3).
    mixed = by(T0 + 60, B(3, abd), R("alice", 2)) + at(5, R("bob", 2), R("dave", 2)) + by(T0 + 90, B(1, abd))
    first = election("three-ballots", "Batches and single receipts deliver all three ballots", abd, mixed)
    assert all(b["counted"] for b in first["ballots"])
    rev = list(reversed(mixed))
    second = election("three-ballots-reordered", "The same records in reverse order: the same verdicts", abd, rev)
    assert first["ballots"] == second["ballots"]

    # --- Share-complaint batches ---
    ba_ = ballots["alice"]
    alice_unfounded = se.raw_complaint(definition_hash, 2, keys[1], ba_["cts"][1], se.nonzero_scalar(complaint_rng))
    bad_proof = dict(carol_proof, z=(carol_proof["z"] + 1) % L)

    def K(seat, entries, secret=None, definition=None):
        return complaint_batch_record(definition or definition_hash, seat, entries, secret or signing_secret(seat))

    complaint_records, complaint_decode = [], []

    def crecord(id_, desc, enc):
        f = parse_complaint_batch(enc)
        assert isinstance(f, dict), (id_, f)
        complaint_records.append({"id": id_, "description": desc, "encoding": enc.hex(), "seat": f["seat"], "count": len(f["entries"]), "statement": f["statement"].hex()})

    k_one = K(2, [(bc["hash"], carol_proof)])
    crecord("one-entry", "Seat 2's batch of its one proven complaint, about Carol's posted seat-2 share: 232 bytes", k_one)
    k_two = K(2, [(bc["hash"], carol_proof), (ba_["hash"], alice_unfounded)])
    crecord("two-entries", "Seat 2's batch of a proven complaint about Carol's share and an unfounded one about Alice's, ascending by ballot hash", k_two)

    def creject(id_, desc, enc, error, offset):
        got = parse_complaint_batch(enc)
        assert got == (error, offset), (id_, got)
        complaint_decode.append({"id": id_, "description": desc, "encoding": enc.hex(), "error": error, "offset": offset})

    csig = len(k_two) - 64
    creject("truncated-header", "The type alone: a record ending before its version", k_two[:2], "truncated", 2)
    creject("another-type", "A share-receipt batch's bytes read as a complaint batch", one, "unexpected-record-type", 0)
    creject("version-2", "A complaint batch labelled version 2: ballot versions 1 to 3 fix version 1", k_two[:2] + b"\x02" + k_two[3:], "profile-mismatch", 2)
    creject("truncated-count", "A complaint batch ending inside its count", k_two[:38], "truncated", 36)
    cempty = dv.header(COMPLAINT_BATCH) + complaint_batch_statement(definition_hash, 2, [])
    cempty += sr.sign(signing_secret(2), cempty[3:], COMPLAINT_BATCH_TAG)
    creject("empty", "A signed complaint batch of no entries", cempty, "non-canonical", 36)
    creject("over-max", "A count of COMPLAINT_BATCH_MAX + 1, refused before any entry is read", k_two[:36] + u32(COMPLAINT_BATCH_MAX + 1) + k_two[40:], "length-over-max", 36)
    es = sorted([(bc["hash"], carol_proof), (ba_["hash"], alice_unfounded)], key=lambda e: e[0])
    creject("unordered", "Seat 2's two entries swapped, signed as they stand", complaint_batch_record(definition_hash, 2, [es[1], es[0]], signing_secret(2), sort=False), "non-canonical", 168)
    creject("repeated", "One ballot's complaint twice, signed", complaint_batch_record(definition_hash, 2, [es[0], es[0]], signing_secret(2), sort=False), "non-canonical", 168)
    creject("identity-d", "The first entry's D is the identity", k_two[:72] + bytes(32) + k_two[104:], "non-canonical", 72)
    # A D that frames as the board frames an element (even, below 2^255 - 19) but isn't a point.
    not_point = next(v.to_bytes(32, "little") for v in range(2, 1 << 12, 2) if grp.decode(v.to_bytes(32, "little")) is None)
    np_body = k_two[3:72] + not_point + k_two[104:-64]
    k_not_point = k_two[:3] + np_body + sr.sign(signing_secret(2), np_body, COMPLAINT_BATCH_TAG)
    creject("d-not-a-point", "The first entry's D frames but isn't a ristretto255 point, signed: the board accepts it, decoding refuses it", k_not_point, "non-canonical", 72)
    creject("c-ell", "The first entry's c is ℓ", k_two[:104] + L.to_bytes(32, "little") + k_two[136:], "non-canonical", 104)
    creject("z-ell", "The second entry's z is ℓ", k_two[:264] + L.to_bytes(32, "little") + k_two[296:], "non-canonical", 264)
    creject("truncated-entry", "A batch ending inside its second entry's proof", k_two[:40 + 128 + 70], "truncated", 232)
    creject("truncated-signature", "A complaint batch one byte short", k_two[:-1], "truncated", csig)
    cr_, cs_ = int.from_bytes(k_two[-64:-32], "big"), int.from_bytes(k_two[-32:], "big")
    creject("high-s", "The signature with s replaced by n − s", k_two[:-64] + ecdsa.sig_bytes(cr_, ecdsa.N - cs_), "non-canonical", csig)
    creject("trailing", "A complaint batch with a trailing byte", k_two + b"\x00", "trailing-bytes", len(k_two))

    carol_posted = by(T0 + 60, B(1, ["carol"]), B(3, ["carol"]), P("carol", 2))
    r = election("complaint-batch-proven", "Carol's dishonest seat-2 share is posted; seat 2's complaint batch proves it invalid: Carol is excluded, attributed to seat 2", ["carol"], carol_posted + by(T0 + 120, k_one))
    assert not r["ballots"][0]["counted"] and r["ballots"][0]["excludedBy"] == [{"at": 3, "pair": 0, "seat": 2, "signer": 2}], r
    r = election("complaint-batch-unattributed", "The same batch signed with seat 1's key: still proven, and Carol is excluded, attributed to no one", ["carol"], carol_posted + by(T0 + 120, K(2, [(bc["hash"], carol_proof)], secret=signing_secret(1))))
    assert r["ballots"][0]["excludedBy"] == [{"at": 3, "pair": 0, "seat": 2, "signer": None}], r
    r = election("complaint-batch-at-end", "The batch is submitted at the end of the complaint window itself", ["carol"], carol_posted + by(TK, k_one))
    assert not r["ballots"][0]["counted"]
    r = election("complaint-batch-late", "The batch is submitted a second after the complaint window: each entry is late, and Carol stays counted", ["carol"], carol_posted + by(TK + 1, k_one))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 3, "pair": 0, "code": "delivery-late"}], r
    alice_posted = by(T0 + 60, B(1, ["alice"]), B(3, ["alice"]), P("alice", 2))
    r = election(
        "complaint-batch-mixed",
        "Alice's and Carol's seat-2 shares posted; seat 2's batch complains about both: Carol excluded, Alice's complaint unfounded, attributed to seat 2, and Alice counted",
        ["alice", "carol"],
        alice_posted + by(T0 + 61, B(1, ["carol"]), B(3, ["carol"]), P("carol", 2)) + by(T0 + 120, k_two),
    )
    assert r["ballots"][0]["counted"] and not r["ballots"][1]["counted"], r
    assert [x["code"] for x in r["records"]] == ["complaint-unfounded"] and r["records"][0]["signer"] == 2, r
    r = election("complaint-batch-proof-fails", "Seat 2's batch with a proof whose z is changed: complaint-proof, and Carol stays counted", ["carol"], carol_posted + by(T0 + 120, K(2, [(bc["hash"], bad_proof)])))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 3, "pair": 0, "code": "complaint-proof"}], r
    r = election("complaint-batch-void", "Seat 2's batch about Carol with no passing posting: void, and Carol lacks seat 2", ["carol"], by(T0 + 60, B(1, ["carol"]), B(3, ["carol"])) + by(T0 + 120, k_one))
    assert r["ballots"][0]["missing"] == [2] and r["records"] == [{"at": 2, "pair": 0, "code": "complaint-void"}], r
    r = election("complaint-batch-board-path", "Seat 2's batch through the board path: a rejected entry, and Carol stays counted", ["carol"], carol_posted + at(60, k_one))
    assert r["ballots"][0]["counted"] and r["rejected"] == [{"at": 3, "error": "unexpected-record-type"}], r
    r = election("complaint-batch-unqualified", "Seat 2 isn't qualified: its batch is delivery-seat for Carol", ["carol"], by(T0 + 60, B(1, ["carol"]), B(3, ["carol"])) + by(T0 + 120, k_one), seats=(1, 3))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 2, "pair": 0, "code": "delivery-seat"}], r
    r = election("complaint-batch-stray", "Seat 2's batch for another definition: reported once", ["carol"], carol_posted + by(T0 + 120, K(2, [(bc["hash"], carol_proof)], definition=other_definition)))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 3, "code": "delivery-stray"}], r
    r = election("complaint-batch-d-not-a-point", "Seat 2's batch whose first D isn't a point: a rejected entry, so neither of its complaints counts, and Carol stays counted", ["carol"], carol_posted + by(T0 + 120, k_not_point))
    assert r["ballots"][0]["counted"] and r["rejected"] == [{"at": 3, "error": "non-canonical"}], r
    bd = ballots["dave"]
    dave_unfounded = se.raw_complaint(definition_hash, 2, keys[1], bd["cts"][1], se.nonzero_scalar(complaint_rng))
    r = election("complaint-batch-unselected-entry", "Seat 2's batch also complains about Dave's ballot, which isn't selected: that entry is set aside, reporting nothing", ["carol"], carol_posted + by(T0 + 120, K(2, [(bc["hash"], carol_proof), (bd["hash"], dave_unfounded)])))
    assert not r["ballots"][0]["counted"] and r["records"] == [], r
    r = election("complaint-batch-duplicates", "The same proven complaint in two batches and as a single complaint: Carol is excluded, each listed, and nothing else reported", ["carol"], carol_posted + by(T0 + 120, k_one, K(2, [(bc["hash"], carol_proof), (bd["hash"], dave_unfounded)])) + at(60, carol_complaint))
    assert not r["ballots"][0]["counted"] and r["records"] == [] and len(r["ballots"][0]["excludedBy"]) == 3, r
    r = election("complaint-batch-contradicts", "Seat 2 receipts Carol's invalid share in a receipt batch, and its complaint batch about the posting is proven: the receipt pair is reported against seat 2", ["carol"], by(T0 + 60, B(1, ["carol"]), batch_record(definition_hash, 2, [(bc["hash"], bc["vote"]["shareHashes"][1])], signing_secret(2)), B(3, ["carol"]), P("carol", 2)) + by(T0 + 120, k_one))
    assert not r["ballots"][0]["counted"] and r["records"] == [{"at": 1, "pair": 0, "code": "receipt-contradicted", "signer": 2}], r

    data = {
        "format": "abolish-delivery-batch-vectors/1",
        "title": "Share-receipt and share-complaint batches: the records, their decoding and the delivery check reading their entries",
        "spec": "docs/spec/delivery.md",
        "generator": (
            "Printed by packages/crypto/scripts/delivery-batch-vectors.py, an implementation of "
            "docs/spec/delivery.md in Python's integers and hashlib, sharing no code with "
            "packages/crypto or any @noble library. It reuses delivery-vectors.py's records, decoding and "
            "windows, and through it share-receipt-vectors.py's ballot hash, intake and P-256 ECDSA "
            "(checked against RFC 6979 Appendix A.2.5 first) and share-encryption-vectors.py's ballots, "
            "posting check and complaints. Secrets are SHA-256 of fixed labels: test data only."
        ),
        "tag": BATCH_TAG.decode(),
        "maxPairs": BATCH_MAX,
        "complaintTag": COMPLAINT_BATCH_TAG.decode(),
        "maxComplaints": COMPLAINT_BATCH_MAX,
        "definitionHash": definition_hash.hex(),
        "panel": panel,
        "records": records,
        "decode": decode,
        "complaintRecords": complaint_records,
        "complaintDecode": complaint_decode,
        "elections": elections,
    }
    with open(f"{out}/delivery-batch.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
