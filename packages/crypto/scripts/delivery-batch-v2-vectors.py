#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/delivery-batch-v2.json.

A second implementation of docs/spec/delivery.md's version-2 share-receipt
batch (0x0016), share-complaint batch (0x0017) and obligation root (0x001a),
which ballot version 4 fixes and which name the seat's panel (1 the default
panel, 2 the author panel) before its seat (Records (version 2)): the records,
their signed messages under `abolish/v1/sig/share-receipt-batch-2`,
`abolish/v1/sig/share-complaint-batch-2` and `abolish/v1/sig/obligation-root-2`,
and their strict decoding; each root's leaf object, CID and obligation tree,
which are version 1's; leaf availability judged by the root's own panel (Leaf
availability (version 2)); and the delivery check over every seat of both
panels reading each pair, entry and leaf as the version-2 receipt or complaint
it states (Delivery check (version 2)). It is written from the spec with
Python's integers and hashlib and shares no code with packages/crypto or any
@noble library. It reuses only this folder's other independent generators:
delivery-v2-vectors.py's version-2 single records, their decoding and its
version-4 ballots (through share-encryption-v4-vectors.py and
intake-v4-vectors.py, over RFC 6979 P-256 ECDSA, ML-KEM-768,
ChaCha20-Poly1305 and ristretto255, each self-checked); and
delivery-root-vectors.py's dag-pb CIDs (checked against every vector of
content-addressing.json first) and RFC 9162 tree (checked against the
vendored transparency-dev vectors first). The election and ballots are
delivery-v2.json's, made from the same labels.

Every secret comes from SHA-256 over a fixed label, and each panel lists its
signing secrets, so any RFC 6979 implementation reproduces every signature.
The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/delivery-batch-v2-vectors.py <out-dir>,
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


d2 = _load("delivery_v2_vectors", "delivery-v2-vectors.py")
dr = _load("delivery_root_vectors", "delivery-root-vectors.py")
sev4, iv4, se, bv, grp, b4, ecdsa, sr, dv = d2.sev4, d2.iv4, d2.se, d2.bv, d2.grp, d2.b4, d2.ecdsa, d2.sr, d2.dv

L = grp.L
DEFAULT, AUTHOR = d2.DEFAULT, d2.AUTHOR
PANELS = (DEFAULT, AUTHOR)
PANEL_NAMES = d2.PANEL_NAMES
BATCH, COMPLAINT_BATCH, ROOT = 0x0016, 0x0017, 0x001A
BATCH_TAG_2 = b"abolish/v1/sig/share-receipt-batch-2"
COMPLAINT_BATCH_TAG_2 = b"abolish/v1/sig/share-complaint-batch-2"
ROOT_TAG_2 = b"abolish/v1/sig/obligation-root-2"
BATCH_MAX = {BATCH: 1024, COMPLAINT_BATCH: 512}
ENTRY_SIZE = {BATCH: 64, COMPLAINT_BATCH: 128}
RECEIPTS, COMPLAINTS = dr.RECEIPTS, dr.COMPLAINTS
LEAF_SIZE = dr.LEAF_SIZE
# The highest record type versioning.md lists: any other is unknown, not unexpected.
LISTED_MAX = 0x001E
VERSION = 2
u8, u32 = bv.u8, bv.u32


def header(record_type, version=VERSION):
    return dv.header(record_type, version)


# --- The records (version 2) --------------------------------------------------------


def entry_bytes(record_type, entry):
    bh, x = entry
    out = bh + (x if record_type == BATCH else se.enc_complaint(x))
    assert len(out) == ENTRY_SIZE[record_type]
    return out


def batch_statement(record_type, definition_hash, panel, seat, entries):
    """m = definition_hash ‖ u8(panel) ‖ u8(seat) ‖ u32(c) ‖ entries: 38 + 64·c or 38 + 128·c bytes."""
    m = definition_hash + u8(panel) + u8(seat) + u32(len(entries)) + b"".join(entry_bytes(record_type, e) for e in entries)
    assert len(m) == 38 + ENTRY_SIZE[record_type] * len(entries)
    return m


def batch_record(record_type, definition_hash, panel, seat, entries, d, sort=True, tag=None):
    """A batch of (ballot_hash, share_hash) pairs or (ballot_hash, proof) entries, signed with secret `d`."""
    if sort:
        entries = sorted(entries, key=lambda e: e[0])
    m = batch_statement(record_type, definition_hash, panel, seat, entries)
    tag = tag or (BATCH_TAG_2 if record_type == BATCH else COMPLAINT_BATCH_TAG_2)
    return header(record_type) + m + sr.sign(d, m, tag)


def root_statement(definition_hash, panel, seat, kind, count, root, cid):
    """m = definition_hash ‖ u8(panel) ‖ u8(seat) ‖ u8(kind) ‖ u32(c) ‖ root ‖ leaves_cid: 107 bytes."""
    m = definition_hash + u8(panel) + u8(seat) + u8(kind) + u32(count) + root + cid
    assert len(m) == 107
    return m


def root_record(definition_hash, panel, seat, kind, leaves, d, count=None, root=None, cid=None, tag=ROOT_TAG_2):
    """A root over leaves sorted by ballot hash, signed with secret `d`; returns the record and its
    leaf object. The leaves, their object, its CID and the tree are version 1's (delivery-root)."""
    leaves = sorted(leaves, key=lambda x: x[0])
    obj = dr.leaf_object(kind, leaves)
    count = len(leaves) if count is None else count
    root = dr.TREE.mth([dr.leaf_bytes(kind, x) for x in leaves]) if root is None else root
    cid = dr.object_cid(obj) if cid is None else cid
    m = root_statement(definition_hash, panel, seat, kind, count, root, cid)
    rec = header(ROOT) + m + sr.sign(d, m, tag)
    assert len(rec) == 174
    return rec, obj


def record_hash(rec):
    """H(DS("abolish/v1/obligation-root", record)) over the whole record, as version 1's."""
    return dr.record_hash(rec)


def type_error(b, expect):
    if len(b) < 2:
        return "truncated", 0
    t = int.from_bytes(b[:2], "big")
    if t != expect:
        return ("unexpected-record-type" if 0 < t <= LISTED_MAX else "unknown-record-type"), 0
    if len(b) < 3:
        return "truncated", 2
    if b[2] != VERSION:
        return "profile-mismatch", 2
    return None


def parse_batch(b, record_type):
    """Strict decoding of either batch under version 2 (delivery.md, Records (version 2),
    Decoding), field by field; returns the fields or (error, offset)."""
    err = type_error(b, record_type)
    if err:
        return err
    for start, end in ((3, 35), (35, 36)):
        if len(b) < end:
            return "truncated", start
    if b[35] not in PANELS:
        return "invalid-enum", 35
    if len(b) < 37:
        return "truncated", 36
    if len(b) < 41:
        return "truncated", 37
    c = int.from_bytes(b[37:41], "big")
    if c > BATCH_MAX[record_type]:
        return "length-over-max", 37
    if c == 0:
        return "non-canonical", 37
    size = ENTRY_SIZE[record_type]
    entries = []
    for j in range(c):
        o = 41 + size * j
        if len(b) < o + 32:
            return "truncated", o
        bh = b[o : o + 32]
        if entries and bh <= entries[-1][0]:
            return "non-canonical", o
        if record_type == BATCH:
            if len(b) < o + 64:
                return "truncated", o + 32
            entries.append((bh, b[o + 32 : o + 64]))
            continue
        if len(b) < o + 64:
            return "truncated", o + 32
        d_raw = b[o + 32 : o + 64]
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
    s = 41 + size * c
    if len(b) < s + 64:
        return "truncated", s
    sig = b[s : s + 64]
    if not dv.sig_canonical(sig):
        return "non-canonical", s
    if len(b) > s + 64:
        return "trailing-bytes", s + 64
    return {"definitionHash": b[3:35], "panel": b[35], "seat": b[36], "entries": entries, "signature": sig, "statement": b[3:s]}


def parse_root(b):
    """Strict decoding of an obligation root under version 2, field by field; returns the fields or (error, offset)."""
    err = type_error(b, ROOT)
    if err:
        return err
    for start, end in ((3, 35), (35, 36)):
        if len(b) < end:
            return "truncated", start
    if b[35] not in PANELS:
        return "invalid-enum", 35
    for start, end in ((36, 37), (37, 38)):
        if len(b) < end:
            return "truncated", start
    if b[37] not in (RECEIPTS, COMPLAINTS):
        return "invalid-enum", 37
    if len(b) < 42:
        return "truncated", 38
    c = int.from_bytes(b[38:42], "big")
    if c == 0:
        return "non-canonical", 38
    for start, end in ((42, 74), (74, 110), (110, 174)):
        if len(b) < end:
            return "truncated", start
    # The CID's framing follows from the signed kind and count alone, as in version 1.
    raw = LEAF_SIZE[b[37]] * c <= 1_048_576
    if b[74:78] != bytes([0x01, 0x55 if raw else 0x70, 0x12, 0x20]):
        return "non-canonical", 74
    if not dv.sig_canonical(b[110:174]):
        return "non-canonical", 110
    if len(b) > 174:
        return "trailing-bytes", 174
    return {"definitionHash": b[3:35], "panel": b[35], "seat": b[36], "kind": b[37], "count": c, "root": b[42:74], "cid": b[74:110], "signature": b[110:174], "statement": b[3:110]}


def record_type(payload):
    return int.from_bytes(payload[:2], "big") if len(payload) >= 3 else None


# --- The delivery check (version 2), with batches and roots -------------------------


def check_delivery(definition_hash, registered, thresholds, bound, seg_d, seg_k, t_d, t_k, ballots, entries, attestations, objects):
    """docs/spec/delivery.md, Delivery check (version 2), from the spec's text, with both batches
    and obligation roots. `registered[panel]` maps each qualified seat to its keys; `thresholds[panel]`
    is that panel's q − k + 1; `attestations[panel]` maps each of its seats that attested the
    counted extent to the record hashes it named; `objects` maps a CID to the bytes a source served
    for it, and bytes that don't hash to it, or none, leave the election unverifiable."""
    hashes = [b4.ballot_hash(b["ctx"], b["vote"]) for b in ballots]
    index = {h: i for i, h in enumerate(hashes)}
    delivered = [set() for _ in ballots]
    reports, rejected = [], []
    receipts, complaints = [], []
    postings = [dict() for _ in ballots]
    signers = {p: {s: k["signingKey"] for s, k in registered[p].items()} for p in PANELS}
    slots = set()
    unverifiable = []

    def place(at, where):
        return dict({"at": at}, **({} if where is None else {where[0]: where[1]}))

    def in_time(path, when, kind):
        if path == "board":
            return when <= (seg_k if kind == "complaint" else seg_d)
        return when <= (t_k if kind == "complaint" else t_d)

    def signed_by(panel, seat, tag, statement, sig):
        key = registered[panel].get(seat)
        return key is not None and ecdsa.verify(key["signingKey"], bv.ds(tag, statement), sig)

    def receipt(at, where, i, panel, seat, share_hash, signed):
        # A pair's or leaf's statement is its record's, so the signature that covers it is the record's.
        if not (share_hash == sev4.own_hashes(ballots[i]["vote"], panel)[seat - 1] and signed):
            reports.append(dict(place(at, where), code="share-receipt", panel=panel, seat=seat, signer=seat if signed else None))
            return
        delivered[i].add((panel, seat))
        receipts.append((at, where, i, panel, seat))

    for at, (path, when, payload) in enumerate(entries):
        t = record_type(payload)
        if t in (BATCH, COMPLAINT_BATCH, ROOT):
            # No board-entry version allows a batch or a root: through the board path each is a rejected entry.
            if path != "contract":
                rejected.append({"at": at, "error": "unexpected-record-type"})
                continue
            f = parse_root(payload) if t == ROOT else parse_batch(payload, t)
            if isinstance(f, tuple):
                rejected.append({"at": at, "error": f[0]})
                continue
            panel, seat = f["panel"], f["seat"]
            who = {"panel": panel, "seat": seat}
            if f["definitionHash"] != definition_hash:
                reports.append({"at": at, "code": "delivery-stray", **who})
                continue
            if t == ROOT:
                kind = f["kind"]
                if seat not in registered[panel]:
                    reports.append({"at": at, "code": "delivery-seat", **who})
                    continue
                if not signed_by(panel, seat, ROOT_TAG_2, f["statement"], f["signature"]):
                    reports.append({"at": at, "code": "root-signature", **who, "signer": None})
                    continue
                # Only a root whose signature verifies fills its slot, kept per panel, seat and kind.
                if (panel, seat, kind) in slots:
                    reports.append({"at": at, "code": "root-repeat", **who})
                    continue
                slots.add((panel, seat, kind))
                if when > (t_d if kind == RECEIPTS else t_k):
                    reports.append({"at": at, "code": "delivery-late", **who})
                    continue
                if f["count"] > bound:
                    reports.append({"at": at, "code": "root-count", **who, "signer": seat})
                    continue
                # Leaf availability (version 2): only the root's own panel judges it.
                rh = record_hash(payload)
                own = attestations[panel]
                named = sorted(s for s, roots in own.items() if rh in roots)
                if len(named) < thresholds[panel]:
                    without = sorted(s for s in own if s not in named)
                    reports.append({"at": at, "code": "root-withheld", **who, "signer": seat, "namedBy": named, "attestedWithout": without})
                    continue
                obj = objects.get(f["cid"])
                if obj is None or dr.object_cid(obj) != f["cid"]:
                    unverifiable.append({"at": at})
                    continue
                leaves = dr.read_leaves(f, obj)
                if leaves is None:
                    reports.append({"at": at, "code": "root-inconsistent", **who, "signer": seat})
                    continue
                for j, (bh, x) in enumerate(leaves):
                    i = index.get(bh)
                    if i is None:
                        continue
                    if kind == RECEIPTS:
                        receipt(at, ("leaf", j), i, panel, seat, x, True)
                    else:
                        complaints.append((at, ("leaf", j), i, {"panel": panel, "seat": seat, "proof": x, "signed": True}))
                continue
            tag = BATCH_TAG_2 if t == BATCH else COMPLAINT_BATCH_TAG_2
            signed = signed_by(panel, seat, tag, f["statement"], f["signature"])
            kind = "receipt" if t == BATCH else "complaint"
            for j, (bh, x) in enumerate(f["entries"]):
                i = index.get(bh)
                if i is None:
                    continue
                if seat not in registered[panel]:
                    reports.append({"at": at, "pair": j, "code": "delivery-seat", **who})
                    continue
                if not in_time(path, when, kind):
                    reports.append({"at": at, "pair": j, "code": "delivery-late", **who})
                    continue
                if t == BATCH:
                    receipt(at, ("pair", j), i, panel, seat, x, signed)
                else:
                    complaints.append((at, ("pair", j), i, {"panel": panel, "seat": seat, "proof": x, "signed": signed}))
            continue
        if path != "contract" and t == d2.POSTING:
            parsed = "unexpected-record-type"
        else:
            parsed = d2.parse_record(payload)
        if isinstance(parsed, str):
            rejected.append({"at": at, "error": parsed})
            continue
        kind, f = parsed
        panel, seat = f["panel"], f["seat"]
        who = {"panel": panel, "seat": seat}
        if f["definitionHash"] != definition_hash:
            reports.append({"at": at, "code": "delivery-stray", **who})
            continue
        i = index.get(f["ballotHash"])
        if i is None:
            continue
        key = registered[panel].get(seat)
        if key is None:
            reports.append({"at": at, "code": "delivery-seat", **who})
            continue
        if not in_time(path, when, kind):
            reports.append({"at": at, "code": "delivery-late", **who})
            continue
        own = sev4.own_hashes(ballots[i]["vote"], panel)
        if kind == "receipt":
            on_ballot = iv4.check_receipt(signers, definition_hash, hashes[i], panel, seat, own[seat - 1], f["signature"])
            signed = iv4.check_receipt(signers, definition_hash, f["ballotHash"], panel, seat, f["shareHash"], f["signature"])
            if not (f["shareHash"] == own[seat - 1] and on_ballot):
                reports.append({"at": at, "code": "share-receipt", **who, "signer": seat if signed else None})
                continue
            delivered[i].add((panel, seat))
            receipts.append((at, None, i, panel, seat))
        elif kind == "posting":
            code, _ = sev4.check_posting(definition_hash, panel, seat, key["kem"], ballots[i]["vote"], f["ciphertext"], f["m"])
            if code != "ok":
                reports.append({"at": at, "code": code, **who})
                continue
            delivered[i].add((panel, seat))
            postings[i][(panel, seat)] = f
        else:
            m = d2.complaint_statement(definition_hash, f["ballotHash"], panel, seat, f["proof"])
            signed = ecdsa.verify(key["signingKey"], bv.ds(d2.COMPLAINT_TAG_2, m), f["signature"])
            complaints.append((at, None, i, {"panel": panel, "seat": seat, "proof": f["proof"], "signed": signed}))
    excluded = [[] for _ in ballots]
    for at, where, i, f in complaints:
        panel, seat = f["panel"], f["seat"]
        posting = postings[i].get((panel, seat))
        if posting is None:
            reports.append(dict(place(at, where), code="complaint-void", panel=panel, seat=seat))
            continue
        key = registered[panel][seat]
        code = sev4.check_complaint(definition_hash, panel, seat, key["kem"], ballots[i]["vote"], posting["ciphertext"], posting["m"], f["proof"])
        signer = seat if f["signed"] else None
        if code == "ok":
            excluded[i].append(dict(place(at, where), panel=panel, seat=seat, signer=signer))
        elif code == "complaint-unfounded":
            reports.append(dict(place(at, where), code=code, panel=panel, seat=seat, signer=signer))
        else:
            reports.append(dict(place(at, where), code="complaint-proof", panel=panel, seat=seat))
    for at, where, i, panel, seat in receipts:
        if any(c["panel"] == panel and c["seat"] == seat for c in excluded[i]):
            reports.append(dict(place(at, where), code="receipt-contradicted", panel=panel, seat=seat, signer=seat))
    order = lambda r: (r["at"], r.get("pair", r.get("leaf", -1)))  # noqa: E731
    reports.sort(key=order)
    if unverifiable:
        return {"unverifiable": unverifiable}
    out = []
    for i, h in enumerate(hashes):
        missing = sorted((p, s) for p in PANELS for s in registered[p] if (p, s) not in delivered[i])
        ex = sorted(excluded[i], key=order)
        out.append({"ballotHash": h.hex(), "counted": not missing and not ex, "delivered": not missing, "missing": [{"panel": p, "seat": s} for p, s in missing], "excludedBy": ex})
    return {"ballots": out, "records": reports, "rejected": rejected}


# --- Vectors ----------------------------------------------------------------------


def main():
    grp.self_check()
    ecdsa.self_check()
    se.aead_self_check()
    se.mlkem_self_check(100)
    dr.bd.self_check(HERE.parent.parent / "test-vectors" / "transparency-dev")
    dr.cid_self_check()
    out = sys.argv[1]

    # delivery-v2.json's elections, panels and ballots, from the same labels.
    sizes = [3, 2]
    flat = lambda *picked: b4.b3.flat(zip(sizes, picked))  # noqa: E731
    e = b4.election("delivery-v2", [(3, 0, 1), (2, 0, 2)], 2, 3, 2, 3)
    plain = b4.election("delivery-v2-no-author", [(3, 0, 1), (2, 0, 2)], 2, 3, 0, 0)
    keys = {DEFAULT: se.trustee_keys("delivery-v2/default", 3), AUTHOR: se.trustee_keys("delivery-v2/author", 3)}
    defh = e["definitionHash"]
    # Leaf availability (version 2): q − k + 1 of each panel's q = 3 qualified seats, k = 2.
    thresholds = {DEFAULT: 2, AUTHOR: 2}
    # The bound 2M, for a made-up electorate of M = 4 members.
    bound = 8

    def signing_secret(panel, seat):
        return ecdsa.secret(f"delivery-v2/{PANEL_NAMES[panel]}/signing/{seat}".encode())

    def identity_secret(panel, seat):
        return ecdsa.secret(f"delivery-v2/{PANEL_NAMES[panel]}/identity/{seat}".encode())

    def registered(default=(1, 2, 3), author=(1, 2, 3)):
        return {
            panel: {s: {"kem": keys[panel][s - 1], "signingKey": sr.p256_key(signing_secret(panel, s))} for s in seats}
            for panel, seats in ((DEFAULT, default), (AUTHOR, author))
        }

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

    def ballot_json(b):
        return {"id": b["name"], "cell": b["ctx"]["cell"], "nullifier": str(b["ctx"]["nullifier"]), "committedVote": b4.enc_committed_vote(b["vote"]).hex(), "ballotHash": b["hash"].hex()}

    def ct_of(name, panel, seat):
        return ballots[name]["panels"][panel]["cts"][seat - 1]

    def m_of(name, panel, seat):
        return bytes.fromhex(ballots[name]["panels"][panel]["rand"][seat - 1]["m"])

    # A seat's pair for a ballot, made only after its own decryption passes, as a node batches only receipts it issued.
    def pair(name, panel, seat):
        b = ballots[name]
        ct = ct_of(name, panel, seat)
        assert sev4.decrypt(b["election"]["definitionHash"], panel, seat, keys[panel][seat - 1], b["vote"], ct) == "ok", (name, panel, seat)
        return b["hash"], se.share_hash(ct)

    def R(name, panel, seat):
        b = ballots[name]
        dh = b["election"]["definitionHash"]
        bh, sh = pair(name, panel, seat)
        return d2.receipt_record(dh, bh, panel, seat, sh, iv4.sign(signing_secret(panel, seat), iv4.statement(dh, bh, panel, seat, sh)))

    def B(panel, seat, names, election=e, secret=None, tag=None, as_=None):
        p, s = as_ or (panel, seat)
        return batch_record(BATCH, election["definitionHash"], p, s, [pair(n, panel, seat) for n in names], secret or signing_secret(panel, seat), tag=tag)

    def P(name, panel, seat):
        b = ballots[name]
        return d2.posting_record(b["election"]["definitionHash"], b["hash"], panel, seat, m_of(name, panel, seat), ct_of(name, panel, seat))

    complaint_rng = bv.Rng("delivery-batch-v2/complaint")

    def proof_for(name, panel, seat, honest=True):
        b = ballots[name]
        w = sev4.nonzero_scalar(complaint_rng)
        ct = ct_of(name, panel, seat)
        if honest:
            return sev4.prove_complaint(defh, panel, seat, keys[panel][seat - 1], b["vote"], ct, m_of(name, panel, seat), w)
        return sev4.raw_complaint(defh, panel, seat, keys[panel][seat - 1], ct, w)

    def CB(panel, seat, entries, secret=None, as_=None):
        p, s = as_ or (panel, seat)
        return batch_record(COMPLAINT_BATCH, defh, p, s, [(ballots[n]["hash"], proof) for n, proof in entries], secret or signing_secret(panel, seat))

    # Every root an election carries, with its leaf object, so each election lists what it needs.
    made = {}

    def RR(panel, seat, names, kind=RECEIPTS, secret=None, as_=None, proofs=None, **over):
        p, s = as_ or (panel, seat)
        if kind == RECEIPTS:
            leaves = [pair(n, panel, seat) for n in names]
        else:
            leaves = [(ballots[n]["hash"], proofs[n]) for n in names]
        rec, obj = root_record(defh, p, s, kind, leaves, secret or signing_secret(panel, seat), **over)
        made[rec] = obj
        return rec

    carol_proof = proof_for("carol", AUTHOR, 2)
    dave_proof = proof_for("dave", DEFAULT, 2)
    alice_unfounded = proof_for("alice", AUTHOR, 2, honest=False)

    # --- Records re-made byte for byte ---
    records = []

    def record(id_, desc, rec, extra=None):
        t = record_type(rec)
        f = parse_root(rec) if t == ROOT else parse_batch(rec, t)
        assert isinstance(f, dict), (id_, f)
        out = {"id": id_, "description": desc, "type": {BATCH: "share-receipt-batch", COMPLAINT_BATCH: "share-complaint-batch", ROOT: "obligation-root"}[t], "encoding": rec.hex(), "panel": f["panel"], "seat": f["seat"], "statement": f["statement"].hex()}
        if t == ROOT:
            obj = made[rec]
            out.update(
                {
                    "kind": f["kind"],
                    "count": f["count"],
                    "root": f["root"].hex(),
                    "leavesCid": f["cid"].hex(),
                    "recordHash": record_hash(rec).hex(),
                    "leafObject": obj.hex(),
                    "leafHashes": [dr.TREE.leaf(obj[LEAF_SIZE[f["kind"]] * j : LEAF_SIZE[f["kind"]] * (j + 1)]).hex() for j in range(f["count"])],
                }
            )
        else:
            out["count"] = len(f["entries"])
        records.append(dict(out, **(extra or {})))

    b_d1 = B(DEFAULT, 1, ["alice", "bob"])
    b_a1 = B(AUTHOR, 1, ["alice", "bob"])
    record("receipt-batch-default", "Default seat 1's version-2 share-receipt batch for Alice's and Bob's ballots: its 38 + 64·2-byte statement, then its signature", b_d1)
    record("receipt-batch-author", "Author seat 1's version-2 share-receipt batch for the same two ballots", b_a1)
    one = B(AUTHOR, 3, ["alice"])
    record("receipt-batch-one", "Author seat 3's batch of one pair: 169 bytes", one)
    cb = CB(AUTHOR, 2, [("carol", carol_proof)])
    record("complaint-batch-author", "Author seat 2's version-2 share-complaint batch of its proven complaint about Carol's posted author seat 2 share", cb)
    cb_d = CB(DEFAULT, 2, [("dave", dave_proof)])
    record("complaint-batch-default", "Default seat 2's version-2 share-complaint batch about Dave's posted default seat 2 share", cb_d)
    rr_a1 = RR(AUTHOR, 1, ["alice", "bob", "carol"])
    record("receipt-root-author", "Author seat 1's version-2 receipt root over three ballots: one raw block of 192 bytes", rr_a1)
    rr_d1 = RR(DEFAULT, 1, ["alice", "bob", "carol"])
    record("receipt-root-default", "Default seat 1's version-2 receipt root over the same three ballots, with its own share hashes", rr_d1)
    cr_a2 = RR(AUTHOR, 2, ["carol"], kind=COMPLAINTS, proofs={"carol": carol_proof})
    record("complaint-root-author", "Author seat 2's version-2 complaint root of its proven complaint about Carol's posting", cr_a2)

    # Batches and roots at their size limits, over made-up pairs.
    made_up = [(bv.H(b"delivery-batch-v2/pair/%d" % j), bv.H(b"delivery-batch-v2/share/%d" % j)) for j in range(16_385)]
    full = batch_record(BATCH, defh, AUTHOR, 1, made_up[: BATCH_MAX[BATCH]], signing_secret(AUTHOR, 1))
    assert len(full) == 105 + 64 * 1024 == 65_641
    record("receipt-batch-max", "Author seat 1's batch of RECEIPT_BATCH_MAX made-up pairs: 65,641 bytes", full)
    big, big_obj = root_record(defh, AUTHOR, 1, RECEIPTS, made_up[:16_384], signing_secret(AUTHOR, 1))
    made[big] = big_obj
    big2, big2_obj = root_record(defh, AUTHOR, 1, RECEIPTS, made_up, signing_secret(AUTHOR, 1))
    made[big2] = big2_obj
    assert parse_root(big)["cid"][:2] == b"\x01\x55" and parse_root(big2)["cid"][:2] == b"\x01\x70"
    limits = []
    for rec, desc in ((big, "16,384 made-up leaves: one raw block of 1 MiB"), (big2, "16,385 made-up leaves: a dag-pb root")):
        f = parse_root(rec)
        limits.append({"description": "Author seat 1's receipt root over " + desc, "encoding": rec.hex(), "count": f["count"], "root": f["root"].hex(), "leavesCid": f["cid"].hex(), "objectLength": len(made[rec])})

    # --- Decode rejections ---
    decode = []

    def reject(id_, desc, enc, error, offset, as_type=None):
        t = as_type or record_type(enc) or BATCH
        got = parse_root(enc) if t == ROOT else parse_batch(enc, t)
        assert got == (error, offset), (id_, got)
        decode.append({"id": id_, "description": desc, "type": {BATCH: "share-receipt-batch", COMPLAINT_BATCH: "share-complaint-batch", ROOT: "obligation-root"}[t], "encoding": enc.hex(), "error": error, "offset": offset})

    def at_(enc, off, val):
        return enc[:off] + val + enc[off + len(val) :]

    reject("batch-panel-0", "A version-2 share-receipt batch naming panel 0", at_(b_a1, 35, b"\x00"), "invalid-enum", 35)
    reject("batch-panel-3", "A version-2 share-receipt batch naming panel 3", at_(b_a1, 35, b"\x03"), "invalid-enum", 35)
    reject("batch-version-1", "A version-2 batch's bytes labelled version 1: ballot version 4 fixes version 2", at_(b_a1, 2, b"\x01"), "profile-mismatch", 2)
    v1_batch = dr.db.batch_record(defh, 1, [pair("alice", DEFAULT, 1)], signing_secret(DEFAULT, 1))
    reject("batch-v1-bytes", "A version-1 share-receipt batch, under ballot version 4", v1_batch, "profile-mismatch", 2)
    reject("batch-type-only", "Two bytes: the batch's type and no version", b_a1[:2], "truncated", 2)
    reject("batch-at-panel", "A batch cut off before its panel", b_a1[:35], "truncated", 35)
    reject("batch-at-seat", "A batch cut off before its seat", b_a1[:36], "truncated", 36)
    reject("batch-in-count", "A batch cut off inside its count", b_a1[:39], "truncated", 37)
    reject("batch-empty", "A batch with no pairs: its count is 0", header(BATCH) + defh + u8(AUTHOR) + u8(1) + u32(0) + b_a1[-64:], "non-canonical", 37)
    reject("batch-over-max", "A batch whose count is 1,025, refused before any pair is read", header(BATCH) + defh + u8(AUTHOR) + u8(1) + u32(1025), "length-over-max", 37)
    descending = sorted([pair("alice", AUTHOR, 1), pair("bob", AUTHOR, 1)], reverse=True)
    swapped = batch_record(BATCH, defh, AUTHOR, 1, descending, signing_secret(AUTHOR, 1), sort=False)
    reject("batch-out-of-order", "A batch whose second pair's ballot hash is below the first's", swapped, "non-canonical", 41 + 64)
    reject("batch-repeated-pair", "A batch carrying the same pair twice", batch_record(BATCH, defh, AUTHOR, 1, [pair("alice", AUTHOR, 1)] * 2, signing_secret(AUTHOR, 1)), "non-canonical", 41 + 64)
    reject("batch-in-pair", "A batch cut off inside its second pair's share hash", b_a1[: 41 + 64 + 40], "truncated", 41 + 64 + 32)
    reject("batch-no-signature", "A batch cut off at its signature", b_a1[:-64], "truncated", len(b_a1) - 64)
    r_, s_ = int.from_bytes(b_a1[-64:-32], "big"), int.from_bytes(b_a1[-32:], "big")
    reject("batch-high-s", "A batch whose signature has s replaced by n − s", b_a1[:-64] + ecdsa.sig_bytes(r_, ecdsa.N - s_), "non-canonical", len(b_a1) - 64)
    reject("batch-trailing", "A batch with a trailing byte", b_a1 + b"\x00", "trailing-bytes", len(b_a1))
    reject("batch-as-complaint-batch", "A share-receipt batch read as a share-complaint batch", b_a1, "unexpected-record-type", 0, as_type=COMPLAINT_BATCH)
    reject("complaint-batch-panel-3", "A version-2 share-complaint batch naming panel 3", at_(cb, 35, b"\x03"), "invalid-enum", 35)
    reject("complaint-batch-version-1", "A version-2 complaint batch labelled version 1", at_(cb, 2, b"\x01"), "profile-mismatch", 2)
    reject("complaint-batch-over-max", "A complaint batch whose count is 513", header(COMPLAINT_BATCH) + defh + u8(AUTHOR) + u8(2) + u32(513), "length-over-max", 37)
    reject("complaint-batch-identity-d", "A complaint batch whose entry's D is the identity", at_(cb, 41 + 32, bytes(32)), "non-canonical", 41 + 32)
    reject("complaint-batch-c-l", "A complaint batch whose entry's challenge is ℓ", at_(cb, 41 + 64, L.to_bytes(32, "little")), "non-canonical", 41 + 64)
    reject("complaint-batch-z-l", "A complaint batch whose entry's response is ℓ", at_(cb, 41 + 96, L.to_bytes(32, "little")), "non-canonical", 41 + 96)
    reject("root-panel-0", "A version-2 obligation root naming panel 0", at_(rr_a1, 35, b"\x00"), "invalid-enum", 35)
    reject("root-panel-3", "A version-2 obligation root naming panel 3", at_(rr_a1, 35, b"\x03"), "invalid-enum", 35)
    reject("root-version-1", "A version-2 root's bytes labelled version 1", at_(rr_a1, 2, b"\x01"), "profile-mismatch", 2)
    v1_root, v1_obj = dr.root_record(defh, 1, RECEIPTS, [pair("alice", DEFAULT, 1)], signing_secret(DEFAULT, 1))
    reject("root-v1-bytes", "A version-1 obligation root, under ballot version 4", v1_root, "profile-mismatch", 2)
    reject("root-kind-0", "A root of kind 0", at_(rr_a1, 37, b"\x00"), "invalid-enum", 37)
    reject("root-kind-3", "A root of kind 3", at_(rr_a1, 37, b"\x03"), "invalid-enum", 37)
    reject("root-count-0", "A root whose count is 0", at_(rr_a1, 38, u32(0)), "non-canonical", 38)
    reject("root-at-seat", "A root cut off before its seat", rr_a1[:36], "truncated", 36)
    reject("root-in-count", "A root cut off inside its count", rr_a1[:40], "truncated", 38)
    reject("root-in-root", "A root cut off inside its tree root", rr_a1[:60], "truncated", 42)
    reject("root-in-cid", "A root cut off inside its CID", rr_a1[:100], "truncated", 74)
    reject("root-dag-pb-small", "A root whose 192-byte leaf object is named by a dag-pb CID", at_(rr_a1, 75, b"\x70"), "non-canonical", 74)
    reject("root-raw-large", "A root of 16,385 leaves whose CID is a raw block's", at_(big2, 75, b"\x55"), "non-canonical", 74)
    reject("root-cid-version-0", "A root whose CID is version 0", at_(rr_a1, 74, b"\x00"), "non-canonical", 74)
    reject("root-no-signature", "A root cut off at its signature", rr_a1[:110], "truncated", 110)
    r_, s_ = int.from_bytes(rr_a1[-64:-32], "big"), int.from_bytes(rr_a1[-32:], "big")
    reject("root-high-s", "A root whose signature has s replaced by n − s", rr_a1[:-64] + ecdsa.sig_bytes(r_, ecdsa.N - s_), "non-canonical", 110)
    reject("root-r-zero", "A root whose signature has r = 0", rr_a1[:110] + bytes(32) + rr_a1[142:], "non-canonical", 110)
    reject("root-trailing", "A root with a trailing byte", rr_a1 + b"\x00", "trailing-bytes", 174)
    reject("root-as-batch", "A root read as a share-receipt batch", rr_a1, "unexpected-record-type", 0, as_type=BATCH)
    reject("root-unknown-type", "A record of type 0x00ff read as a root", b"\x00\xff" + rr_a1[2:], "unknown-record-type", 0, as_type=ROOT)

    # --- Elections ---
    elections = []
    SD, SK = 40, 112
    TD, TK = dv.deadlines(1_700_000_000, 0)
    T0 = TD - dv.DELIVERY_WINDOW

    def election(id_, desc, names, entries, attested=None, objects=None, default=(1, 2, 3), author=(1, 2, 3), serve=True):
        sel = [ballots[n] for n in names]
        el = sel[0]["election"]
        assert all(b["election"] is el for b in sel)
        reg = registered(default, author if el["authorPanelSize"] else ())
        att = {p: {s: set(rs) for s, rs in (attested or {}).get(p, {}).items()} for p in PANELS}
        if objects is None:
            objects = {}
            if serve:
                for _, _, p in entries:
                    if record_type(p) == ROOT and p in made:
                        f = parse_root(p)
                        if isinstance(f, dict):
                            objects[f["cid"]] = made[p]
        result = check_delivery(el["definitionHash"], reg, thresholds, bound, SD, SK, TD, TK, sel, entries, att, objects)
        elections.append(
            {
                "id": id_,
                "description": desc,
                "definitionHash": el["definitionHash"].hex(),
                "panelSize": el["panelSize"],
                "authorPanelSize": el["authorPanelSize"],
                "registered": list(reg[DEFAULT]),
                "authorRegistered": list(reg[AUTHOR]),
                "thresholds": {"default": thresholds[DEFAULT], "author": thresholds[AUTHOR]},
                "bound": bound,
                "segments": {"delivery": str(SD), "complaint": str(SK)},
                "deadlines": {"delivery": str(TD), "complaint": str(TK)},
                "ballots": [ballot_json(b) for b in sel],
                "entries": [{"path": "board", "segment": w, "payload": p.hex()} if path == "board" else {"path": "contract", "submittedAt": str(w), "payload": p.hex()} for path, w, p in entries],
                "attestations": [{"panel": p, "seat": s, "roots": sorted(r.hex() for r in rs)} for p in PANELS for s, rs in sorted(att[p].items())],
                "leafObjects": [{"cid": c.hex(), "bytes": o.hex()} for c, o in objects.items()],
                "result": result,
            }
        )
        return result

    def at(seg, *payloads):
        return [("board", seg, p) for p in payloads]

    def by(t, *payloads):
        return [("contract", t, p) for p in payloads]

    def seat(p, s):
        return {"panel": p, "seat": s}

    def every_batch(names, skip=()):
        return [B(p, s, names) for p in PANELS for s in (1, 2, 3) if (p, s) not in skip]

    def every_receipt(names, skip=()):
        return [R(n, p, s) for n in names for p in PANELS for s in (1, 2, 3) if (p, s) not in skip]

    def counted(r):
        return all(b["counted"] for b in r["ballots"])

    # Batches.
    r = election("batches", "Every seat of both panels sends one version-2 batch for Alice's and Bob's ballots through the contract path", ["alice", "bob"], by(T0 + 60, *every_batch(["alice", "bob"])))
    assert counted(r) and r["records"] == []
    r = election("batch-at-deadline", "Author seat 3's batch at the delivery deadline itself; every other seat's receipts through the board path", ["alice"], at(3, *every_receipt(["alice"], {(AUTHOR, 3)})) + by(TD, B(AUTHOR, 3, ["alice"])))
    assert counted(r)
    r = election("batch-late", "Author seat 3's batch one second after the delivery deadline", ["alice", "bob"], at(3, *every_receipt(["alice", "bob"], {(AUTHOR, 3)})) + by(TD + 1, B(AUTHOR, 3, ["alice", "bob"])))
    assert [b["missing"] for b in r["ballots"]] == [[seat(AUTHOR, 3)]] * 2 and [x["code"] for x in r["records"]] == ["delivery-late"] * 2
    r = election("batch-board-path", "Author seat 3's batch through the board path: a rejected entry, which delivers nothing", ["alice"], at(3, *every_receipt(["alice"], {(AUTHOR, 3)}), B(AUTHOR, 3, ["alice"])))
    assert r["ballots"][0]["missing"] == [seat(AUTHOR, 3)] and r["rejected"] == [{"at": 5, "error": "unexpected-record-type"}]
    v1_b = dr.db.batch_record(defh, 3, [pair("alice", DEFAULT, 3)], signing_secret(DEFAULT, 3))
    r = election("batch-version-1", "Default seat 3's version-1 batch under ballot version 4: a rejected entry (profile-mismatch)", ["alice"], at(3, *every_receipt(["alice"], {(DEFAULT, 3)})) + by(T0 + 60, v1_b))
    assert r["ballots"][0]["missing"] == [seat(DEFAULT, 3)] and r["rejected"] == [{"at": 5, "error": "profile-mismatch"}]
    stray = batch_record(BATCH, plain["definitionHash"], AUTHOR, 3, [pair("alice", AUTHOR, 3)], signing_secret(AUTHOR, 3))
    r = election("batch-stray", "Alice's ballot fully receipted, beside author seat 3's batch naming the other election's definition: reported once", ["alice"], at(3, *every_receipt(["alice"])) + by(T0 + 60, stray))
    assert counted(r) and r["records"] == [{"at": 6, "code": "delivery-stray", **seat(AUTHOR, 3)}]
    r = election("batch-unqualified", "Author seat 3 isn't qualified: its batch's pairs name a seat outside the author key set", ["alice", "bob"], at(3, *every_receipt(["alice", "bob"], {(AUTHOR, 3)})) + by(T0 + 60, B(AUTHOR, 3, ["alice", "bob"])), author=(1, 2))
    assert counted(r) and r["records"] == [{"at": 10, "pair": j, "code": "delivery-seat", **seat(AUTHOR, 3)} for j in (0, 1)]
    erin_author = batch_record(BATCH, plain["definitionHash"], AUTHOR, 1, [(ballots["erin"]["hash"], sev4.own_hashes(ballots["alice"]["vote"], AUTHOR)[0])], signing_secret(AUTHOR, 1))
    r = election("batch-no-author-panel", "A poll without an author panel: the default seats' batches deliver Erin's ballot, and a batch naming author seat 1 is for a seat outside the empty author key set", ["erin"], by(T0 + 60, *(B(DEFAULT, s, ["erin"], election=plain) for s in (1, 2, 3)), erin_author))
    assert counted(r) and r["records"] == [{"at": 3, "pair": 0, "code": "delivery-seat", **seat(AUTHOR, 1)}]

    ba = ballots["alice"]
    sh = {p: sev4.own_hashes(ba["vote"], p) for p in PANELS}
    relabelled = at_(B(AUTHOR, 2, ["alice"]), 35, u8(DEFAULT))
    other_seat = B(AUTHOR, 2, ["alice"], secret=signing_secret(DEFAULT, 2))
    v1_tag = B(AUTHOR, 2, ["alice"], tag=dr.db.BATCH_TAG)
    identity = B(AUTHOR, 2, ["alice"], secret=identity_secret(AUTHOR, 2))
    cross = batch_record(BATCH, defh, DEFAULT, 2, [(ba["hash"], sh[AUTHOR][1])], signing_secret(DEFAULT, 2))
    r = election(
        "failing-batches",
        "Five batches fail and leave default seat 2 and author seat 2 undelivered: author seat 2's batch with its panel byte changed to the default panel; a batch naming author seat 2 signed by default seat 2; one signed under version 1's tag; one signed by author seat 2's identity key (each attributed to no one); and default seat 2's own batch pairing Alice's ballot with author seat 2's share hash (attributed to default seat 2)",
        ["alice"],
        at(3, *every_receipt(["alice"], {(DEFAULT, 2), (AUTHOR, 2)})) + by(T0 + 60, relabelled, other_seat, v1_tag, identity, cross),
    )
    assert r["ballots"][0]["missing"] == [seat(DEFAULT, 2), seat(AUTHOR, 2)]
    assert [(x["code"], x["panel"], x["signer"]) for x in r["records"]] == [("share-receipt", DEFAULT, None), ("share-receipt", AUTHOR, None), ("share-receipt", AUTHOR, None), ("share-receipt", AUTHOR, None), ("share-receipt", DEFAULT, 2)]

    # Complaint batches.
    carol_posted = at(3, *every_receipt(["carol"], {(AUTHOR, 2)})) + by(T0 + 60, P("carol", AUTHOR, 2))
    n = len(carol_posted)
    r = election("complaint-batch-proven", "Carol's dishonest author seat 2 share is posted; author seat 2's complaint batch proves it invalid, and the ballot is excluded though delivered", ["carol"], carol_posted + by(TD + 3600, cb))
    assert r["ballots"][0]["delivered"] and r["ballots"][0]["excludedBy"] == [{"at": n, "pair": 0, **seat(AUTHOR, 2), "signer": 2}]
    r = election("complaint-batch-unattributed", "The same entry in a batch naming author seat 2 signed by default seat 2: still proven, attributed to no one", ["carol"], carol_posted + by(TD + 3600, CB(AUTHOR, 2, [("carol", carol_proof)], secret=signing_secret(DEFAULT, 2))))
    assert r["ballots"][0]["excludedBy"] == [{"at": n, "pair": 0, **seat(AUTHOR, 2), "signer": None}]
    r = election("complaint-batch-at-deadline", "The complaint batch at the end of the complaint window itself", ["carol"], carol_posted + by(TK, cb))
    assert not r["ballots"][0]["counted"]
    r = election("complaint-batch-late", "The complaint batch one second after the complaint window: ignored, and Carol's ballot stays counted", ["carol"], carol_posted + by(TK + 1, cb))
    assert counted(r) and r["records"] == [{"at": n, "pair": 0, "code": "delivery-late", **seat(AUTHOR, 2)}]
    r = election("complaint-batch-void", "A complaint batch with no passing posting for author seat 2: void, and the ballot lacks that seat", ["carol"], at(3, *every_receipt(["carol"], {(AUTHOR, 2)})) + by(TD + 3600, cb))
    assert r["ballots"][0]["missing"] == [seat(AUTHOR, 2)] and r["records"] == [{"at": 5, "pair": 0, "code": "complaint-void", **seat(AUTHOR, 2)}]
    as_default = CB(AUTHOR, 2, [("carol", carol_proof)], secret=signing_secret(DEFAULT, 2), as_=(DEFAULT, 2))
    carol_both = at(3, *every_receipt(["carol"], {(AUTHOR, 2), (DEFAULT, 2)})) + by(T0 + 60, P("carol", AUTHOR, 2), P("carol", DEFAULT, 2))
    r = election("complaint-batch-other-panel", "Author seat 2's proof in a complaint batch naming default seat 2, beside both seats' postings: it fails for the default seat, and excludes neither", ["carol"], carol_both + by(TD + 3600, as_default))
    assert counted(r) and r["records"] == [{"at": len(carol_both), "pair": 0, "code": "complaint-proof", **seat(DEFAULT, 2)}]
    alice_posted = at(3, *every_receipt(["alice"], {(AUTHOR, 2)})) + by(T0 + 60, P("alice", AUTHOR, 2))
    r = election("complaint-batch-unfounded", "Author seat 2's complaint batch about Alice's valid posted share: unfounded, attributed to author seat 2, and the ballot stands", ["alice"], alice_posted + by(TD + 3600, CB(AUTHOR, 2, [("alice", alice_unfounded)])))
    assert counted(r) and r["records"] == [{"at": 6, "pair": 0, "code": "complaint-unfounded", **seat(AUTHOR, 2), "signer": 2}]
    bc = ballots["carol"]
    false_pair = (bc["hash"], sev4.own_hashes(bc["vote"], AUTHOR)[1])
    false_batch = batch_record(BATCH, defh, AUTHOR, 2, [false_pair], signing_secret(AUTHOR, 2))
    r = election(
        "contradicted-batch-pair",
        "Author seat 2's batch receipts Carol's invalid share and its complaint batch about the posting is proven: excluded, and the batch's pair is reported against author seat 2",
        ["carol"],
        at(3, *every_receipt(["carol"], {(AUTHOR, 2)})) + by(T0 + 60, false_batch, P("carol", AUTHOR, 2)) + by(TD + 3600, cb),
    )
    assert not r["ballots"][0]["counted"] and r["records"] == [{"at": 5, "pair": 0, "code": "receipt-contradicted", **seat(AUTHOR, 2), "signer": 2}]

    # Roots, over the two ballots whose shares pass at every seat.
    names2 = ["alice", "bob"]

    def receipt_roots(skip=()):
        return {(p, s): RR(p, s, names2) for p in PANELS for s in (1, 2, 3) if (p, s) not in skip}

    roots = receipt_roots()
    every_root = list(roots.values())

    def hashes_of(*keys_):
        return [record_hash(roots[k]) for k in keys_]

    # Every seat of each panel names every root of its own panel.
    own_names = {p: {s: hashes_of(*((p, x) for x in (1, 2, 3))) for s in (1, 2, 3)} for p in PANELS}
    r = election("roots", "Every seat of both panels sends one version-2 receipt root over two ballots, and every seat of each panel names its own panel's roots: both counted", names2, by(T0 + 60, *every_root), attested=own_names)
    assert counted(r) and r["records"] == []
    # Author seat 3's root named by the three default seats and by author seat 1 only: withheld.
    att = {DEFAULT: {s: hashes_of(*((DEFAULT, x) for x in (1, 2, 3))) + hashes_of((AUTHOR, 3)) for s in (1, 2, 3)}, AUTHOR: {1: hashes_of((AUTHOR, 1), (AUTHOR, 2), (AUTHOR, 3)), 2: hashes_of((AUTHOR, 1), (AUTHOR, 2)), 3: hashes_of((AUTHOR, 1), (AUTHOR, 2))}}
    r = election(
        "root-withheld-other-panel",
        "Author seat 3's root is named by all three default seats but by author seat 1 alone: the default panel's attestations don't count for an author root, so it is withheld, and author seat 3 is missing",
        names2,
        by(T0 + 60, *every_root),
        attested=att,
    )
    assert [b["missing"] for b in r["ballots"]] == [[seat(AUTHOR, 3)]] * 2
    assert r["records"] == [{"at": 5, "code": "root-withheld", **seat(AUTHOR, 3), "signer": 3, "namedBy": [1], "attestedWithout": [2, 3]}]
    att = {DEFAULT: own_names[DEFAULT], AUTHOR: {1: hashes_of((AUTHOR, 1), (AUTHOR, 2), (AUTHOR, 3)), 2: hashes_of((AUTHOR, 1), (AUTHOR, 2), (AUTHOR, 3)), 3: hashes_of((AUTHOR, 1), (AUTHOR, 2))}}
    r = election("root-at-threshold", "Author seat 3's root named by author seats 1 and 2, q − k + 1 of the author panel: available, and both ballots counted", names2, by(T0 + 60, *every_root), attested=att)
    assert counted(r) and r["records"] == []
    att = {
        DEFAULT: {1: hashes_of((DEFAULT, 1), (DEFAULT, 2), (DEFAULT, 3)), 2: hashes_of((DEFAULT, 2), (DEFAULT, 3)), 3: hashes_of((DEFAULT, 2), (DEFAULT, 3))},
        AUTHOR: {s: hashes_of((AUTHOR, 1), (AUTHOR, 2), (AUTHOR, 3), (DEFAULT, 1)) for s in (1, 2, 3)},
    }
    r = election("default-root-withheld", "Default seat 1's root is named by default seat 1 and by every author seat: the author panel's attestations don't count for a default root, so it is withheld, and default seat 1 is missing", names2, by(T0 + 60, *every_root), attested=att)
    assert [b["missing"] for b in r["ballots"]] == [[seat(DEFAULT, 1)]] * 2
    assert r["records"] == [{"at": 0, "code": "root-withheld", **seat(DEFAULT, 1), "signer": 1, "namedBy": [1], "attestedWithout": [2, 3]}]

    a1_again = RR(AUTHOR, 1, ["alice"])
    a2_complaints = cr_a2
    att = {p: {s: [record_hash(x) for x in every_root if parse_root(x)["panel"] == p] + [record_hash(a2_complaints)] * (p == AUTHOR) for s in (1, 2, 3)} for p in PANELS}
    carol_singles = at(3, *every_receipt(["carol"], {(AUTHOR, 2)}))
    entries = carol_singles + by(T0 + 60, *every_root, a1_again) + by(T0 + 120, P("carol", AUTHOR, 2)) + by(TD + 3600, a2_complaints)
    k = len(carol_singles)
    r = election(
        "root-repeat-per-panel",
        "Default seat 1's and author seat 1's receipt roots fill their own panels' slots; a second receipt root of author seat 1 is a repeat; and author seat 2's complaint root, about Carol's posted share, fills its own kind's slot beside author seat 2's receipt root",
        ["alice", "bob", "carol"],
        entries,
        attested=att,
    )
    assert r["records"] == [{"at": k + 6, "code": "root-repeat", **seat(AUTHOR, 1)}] and r["ballots"][2]["excludedBy"] == [{"at": k + 8, "leaf": 0, **seat(AUTHOR, 2), "signer": 2}]
    assert [b["counted"] for b in r["ballots"]] == [True, True, False]

    v1r, _ = dr.root_record(defh, 1, RECEIPTS, [pair(n, DEFAULT, 1) for n in names2], signing_secret(DEFAULT, 1))
    r = election("root-version-1", "Default seat 1's version-1 root under ballot version 4: a rejected entry (profile-mismatch), so default seat 1 is missing", names2, by(T0 + 60, v1r, *receipt_roots({(DEFAULT, 1)}).values()), attested=own_names)
    assert r["rejected"] == [{"at": 0, "error": "profile-mismatch"}] and [b["missing"] for b in r["ballots"]] == [[seat(DEFAULT, 1)]] * 2

    wrong_signer = RR(AUTHOR, 1, names2, secret=signing_secret(DEFAULT, 1))
    relabelled_root = at_(roots[(AUTHOR, 2)], 35, u8(DEFAULT))
    v1_tag_root = RR(AUTHOR, 2, names2, tag=dr.ROOT_TAG)
    late_root = RR(DEFAULT, 3, names2)
    over = RR(DEFAULT, 2, names2, count=bound + 1)
    stray_root, stray_obj = root_record(plain["definitionHash"], AUTHOR, 1, RECEIPTS, [pair("alice", AUTHOR, 1)], signing_secret(AUTHOR, 1))
    made[stray_root] = stray_obj
    unqualified = RR(AUTHOR, 3, ["alice"])
    r = election(
        "failing-roots",
        "Seven roots fail before any leaf is read, each named by every seat of both panels: author seat 1's signed by default seat 1, author seat 2's relabelled as default seat 2's, author seat 2's under version 1's tag (each root-signature, attributed to no one), default seat 3's a second after the delivery deadline (delivery-late), default seat 2's with a count over the bound (root-count), one naming the other election (delivery-stray) and one for author seat 3, which isn't qualified (delivery-seat); default seat 1's root delivers its seat",
        names2,
        by(T0 + 60, wrong_signer, relabelled_root, v1_tag_root) + by(TD + 1, late_root) + by(T0 + 60, over, stray_root, roots[(DEFAULT, 1)]) + by(T0 + 90, unqualified),
        attested={p: {s: [record_hash(x) for x in (wrong_signer, relabelled_root, v1_tag_root, late_root, over, roots[(DEFAULT, 1)], unqualified)] for s in (1, 2, 3)} for p in PANELS},
        author=(1, 2),
    )
    assert [(x["code"], x["panel"], x["seat"]) for x in r["records"]] == [
        ("root-signature", AUTHOR, 1),
        ("root-signature", DEFAULT, 2),
        ("root-signature", AUTHOR, 2),
        ("delivery-late", DEFAULT, 3),
        ("root-count", DEFAULT, 2),
        ("delivery-stray", AUTHOR, 1),
        ("delivery-seat", AUTHOR, 3),
    ], r["records"]
    assert [b["missing"] for b in r["ballots"]] == [[seat(DEFAULT, 2), seat(DEFAULT, 3), seat(AUTHOR, 1), seat(AUTHOR, 2)]] * 2

    # A root whose leaf object the sources serve wrongly, or whose leaves don't give its root.
    bad_tree = RR(AUTHOR, 2, names2, root=bytes(32))
    att = {DEFAULT: own_names[DEFAULT], AUTHOR: {s: hashes_of((AUTHOR, 1), (AUTHOR, 3)) + [record_hash(bad_tree)] for s in (1, 2, 3)}}
    entries = by(T0 + 60, *(roots[k] for k in roots if k != (AUTHOR, 2)), bad_tree)
    r = election("root-inconsistent", "Author seat 2's root signs a tree root its leaves don't give: available, inconsistent, attributed to author seat 2, and author seat 2 is missing", names2, entries, attested=att)
    assert r["records"] == [{"at": 5, "code": "root-inconsistent", **seat(AUTHOR, 2), "signer": 2}]
    served = {parse_root(p)["cid"]: made[p] for _, _, p in entries}
    served[parse_root(bad_tree)["cid"]] = b"\x00" * len(made[bad_tree])
    r = election("root-unverifiable", "The same election, with every source serving bytes that don't hash to author seat 2's CID: unverifiable from these sources, never failed", names2, entries, attested=att, objects=served)
    assert r == {"unverifiable": [{"at": 5}]}

    r = election("root-board-path", "Author seat 1's root through the board path: a rejected entry, which delivers nothing", names2, by(T0 + 60, *(roots[k] for k in roots if k != (AUTHOR, 1))) + at(3, roots[(AUTHOR, 1)]), attested=own_names)
    assert r["rejected"] == [{"at": 5, "error": "unexpected-record-type"}] and [b["missing"] for b in r["ballots"]] == [[seat(AUTHOR, 1)]] * 2

    # Mixed paths, and the order of the records.
    mixed = (
        at(2, R("alice", DEFAULT, 1), R("bob", AUTHOR, 1))
        + by(T0 + 60, B(DEFAULT, 2, ["alice", "bob"]), roots[(AUTHOR, 3)])
        + at(5, R("alice", DEFAULT, 3), R("bob", DEFAULT, 1), R("bob", DEFAULT, 3), R("alice", AUTHOR, 1))
        + by(T0 + 300, B(AUTHOR, 2, ["alice"]), P("carol", AUTHOR, 2))
        + at(6, R("carol", DEFAULT, 1), R("carol", DEFAULT, 3), R("carol", AUTHOR, 1))
        + by(T0 + 600, roots[(DEFAULT, 2)])
        + by(TD + 3600, cb)
    )
    att = {DEFAULT: {s: hashes_of((DEFAULT, 2)) for s in (1, 2, 3)}, AUTHOR: {s: hashes_of((AUTHOR, 3)) for s in (1, 2, 3)}}
    first = election("three-ballots", "Single receipts, batches, roots, a posting and a complaint batch of both panels: Alice counted, Bob missing author seat 2, Carol excluded", ["alice", "bob", "carol"], mixed, attested=att)
    assert [b["counted"] for b in first["ballots"]] == [True, False, False] and first["ballots"][1]["missing"] == [seat(AUTHOR, 2)]
    rev = list(reversed(mixed))
    segs = iter(sorted(w for path, w, _ in mixed if path == "board"))
    reordered = [(path, next(segs) if path == "board" else w, p) for path, w, p in rev]
    second = election("three-ballots-reordered", "The same records in reverse order: the same verdicts", ["alice", "bob", "carol"], reordered, attested=att)
    strip = lambda res: [{k: v for k, v in b.items() if k != "excludedBy"} | {"excludedBy": [(c["panel"], c["seat"]) for c in b["excludedBy"]]} for b in res["ballots"]]  # noqa: E731
    assert strip(first) == strip(second)

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
        "format": "abolish-delivery-batch-vectors/2",
        "title": "Share-receipt batches, share-complaint batches and obligation roots at version 2, naming the seat's panel, and the delivery check reading them over both panels with each root judged by its own panel",
        "spec": "docs/spec/delivery.md",
        "generator": (
            "Printed by packages/crypto/scripts/delivery-batch-v2-vectors.py, an implementation of "
            "docs/spec/delivery.md, Records (version 2), Leaf availability (version 2) and Delivery check "
            "(version 2), in Python's integers and hashlib, sharing no code with packages/crypto or any @noble "
            "library. It reuses delivery-v2-vectors.py's version-2 records and ballots and delivery-root-vectors.py's "
            "dag-pb CIDs (checked against content-addressing.json first) and RFC 9162 tree (checked against "
            "transparency-dev first), over RFC 6979 P-256 ECDSA (checked against RFC 6979 Appendix A.2.5 first). "
            "Secrets are SHA-256 of fixed labels: test data only."
        ),
        "tags": {"receiptBatch": BATCH_TAG_2.decode(), "complaintBatch": COMPLAINT_BATCH_TAG_2.decode(), "root": ROOT_TAG_2.decode(), "recordHash": dr.ROOT_HASH_TAG.decode(), "leaf": dr.LEAF_TAG, "node": dr.NODE_TAG},
        "maxPairs": BATCH_MAX[BATCH],
        "maxComplaints": BATCH_MAX[COMPLAINT_BATCH],
        "panels": {"default": DEFAULT, "author": AUTHOR},
        "seats": {"default": panel_json(DEFAULT), "author": panel_json(AUTHOR)},
        "records": records,
        "limits": limits,
        "decode": decode,
        "elections": elections,
    }
    with open(f"{out}/delivery-batch-v2.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote delivery-batch-v2.json: {len(records)} records, {len(limits)} limits, {len(decode)} decode rejections, {len(elections)} elections")


if __name__ == "__main__":
    main()
