#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/delivery-root.json.

A second implementation of docs/spec/delivery.md's obligation root (0x001a,
version 1): the record and its signed message, its strict decoding, the leaf
object with its canonical CID, the obligation tree with its inclusion proofs,
leaf availability, and the delivery check reading each leaf of a root that is
available and consistent as the receipt or complaint it states; and Capacity
for elections that commit roots. It is written from the spec with Python's
integers and hashlib, and shares no code with packages/crypto or any @noble
library. It reuses delivery-batch-vectors.py's records and through it
delivery-vectors.py's, share-receipt-vectors.py's and
share-encryption-vectors.py's ballots, P-256 ECDSA (checked against RFC 6979
Appendix A.2.5 first), postings and complaints; board-vectors.py's RFC 9162
tree, checked against the vendored transparency-dev vectors first; and
delivery-obligation-vectors.py's intervals and sweep. Its CIDs are its own
dag-pb UnixFS writer, checked against every vector of
docs/spec/vectors/content-addressing.json (Kubo's and ipfs-unixfs-importer's
CIDs) first. The panel and ballots are delivery.json's, made from the same
labels.

Every secret comes from SHA-256 over a fixed label. The values are test
data, never keys.

Usage: python3 -I -B packages/crypto/scripts/delivery-root-vectors.py <out-dir>
"""

import hashlib
import importlib.util
import json
import pathlib
import sys
from fractions import Fraction

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


db = _load("delivery_batch_vectors", "delivery-batch-vectors.py")
bd = _load("board_vectors", "board-vectors.py")
ob = _load("delivery_obligation_vectors", "delivery-obligation-vectors.py")
dv, sr, se, ecdsa, bv, grp = db.dv, db.sr, db.se, db.ecdsa, db.bv, db.grp

L = grp.L
ROOT = 0x001A
ROOT_TAG = b"abolish/v1/sig/obligation-root"
ROOT_HASH_TAG = b"abolish/v1/obligation-root"
LEAF_TAG = "abolish/v1/obligation/leaf"
NODE_TAG = "abolish/v1/obligation/node"
RECEIPTS, COMPLAINTS = 1, 2
LEAF_SIZE = {RECEIPTS: 64, COMPLAINTS: 128}
ROOT_CALL_GAS = 200_000
u8, u32 = bv.u8, bv.u32

TREE = bd.Tree(bd.tagged(LEAF_TAG), bd.tagged(NODE_TAG))

# --- Content addressing (docs/spec/content-addressing.md) -------------------------


def varint(x):
    out = b""
    while True:
        b = x & 0x7F
        x >>= 7
        if x:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def object_cid(obj, chunk=1_048_576, max_links=1024):
    """objectCid: fixed-size raw leaves, then a balanced tree of dag-pb UnixFS File nodes."""
    assert obj, "nothing the protocol stores is empty"
    # Each node: (cid, tsize, filesize).
    level = []
    for o in range(0, len(obj), chunk):
        c = obj[o : o + chunk]
        level.append((bytes([0x01, 0x55, 0x12, 0x20]) + hashlib.sha256(c).digest(), len(c), len(c)))
    if len(level) == 1:
        return level[0][0]
    while len(level) > 1:
        up = []
        for g in range(0, len(level), max_links):
            kids = level[g : g + max_links]
            size = sum(k[2] for k in kids)
            data = b"\x08\x02" + b"\x18" + varint(size) + b"".join(b"\x20" + varint(k[2]) for k in kids)
            node = b""
            for cid, tsize, _ in kids:
                link = b"\x0a" + varint(len(cid)) + cid + b"\x12\x00" + b"\x18" + varint(tsize)
                node += b"\x12" + varint(len(link)) + link
            node += b"\x0a" + varint(len(data)) + data
            up.append((bytes([0x01, 0x70, 0x12, 0x20]) + hashlib.sha256(node).digest(), len(node) + sum(k[1] for k in kids), size))
        level = up
    return level[0][0]


def cid_self_check():
    """Every CID of content-addressing.json, which Kubo and ipfs-unixfs-importer agree on."""
    doc = json.loads((HERE.parents[3] / "docs/spec/vectors/content-addressing.json").read_text())
    for v in doc["vectors"]:
        p = doc["profiles"][v["profile"]]
        label = v["label"].encode()
        if v["label"].startswith("zeros"):
            obj = bytes(v["length"])
        else:
            obj, i = b"", 0
            while len(obj) < v["length"]:
                obj += hashlib.sha256(label + i.to_bytes(4, "big")).digest()
                i += 1
            obj = obj[: v["length"]]
        assert object_cid(obj, p["chunkSize"], p["maxLinks"]).hex() == v["cidHex"], v["id"]
    assert len(doc["vectors"]) == 15


# --- The record -------------------------------------------------------------------


def leaf_bytes(kind, leaf):
    bh, x = leaf
    out = bh + (x if kind == RECEIPTS else se.enc_complaint(x))
    assert len(out) == LEAF_SIZE[kind]
    return out


def leaf_object(kind, leaves):
    return b"".join(leaf_bytes(kind, x) for x in leaves)


def root_statement(definition_hash, seat, kind, count, root, cid):
    """m = definition_hash ‖ u8(seat) ‖ u8(kind) ‖ u32(c) ‖ root ‖ leaves_cid: 106 bytes."""
    m = definition_hash + u8(seat) + u8(kind) + u32(count) + root + cid
    assert len(m) == 106
    return m


def root_record(definition_hash, seat, kind, leaves, d, sort=True, count=None, root=None, cid=None):
    """A root over (ballot_hash, share_hash or proof) leaves, signed with secret `d`; returns the
    record and its leaf object. `count`, `root` and `cid` override what the leaves give."""
    if sort:
        leaves = sorted(leaves, key=lambda x: x[0])
    obj = leaf_object(kind, leaves)
    count = len(leaves) if count is None else count
    root = TREE.mth([leaf_bytes(kind, x) for x in leaves]) if root is None else root
    cid = object_cid(obj) if cid is None else cid
    m = root_statement(definition_hash, seat, kind, count, root, cid)
    rec = dv.header(ROOT) + m + sr.sign(d, m, ROOT_TAG)
    assert len(rec) == 173
    return rec, obj


def record_hash(rec):
    return bv.H(bv.ds(ROOT_HASH_TAG, rec))


def parse_root(b):
    """Strict decoding under version 1 (docs/spec/delivery.md, Obligation root, Decoding), in field
    order; returns the fields or (error, offset)."""
    if len(b) < 2:
        return "truncated", 0
    t = int.from_bytes(b[:2], "big")
    if t != ROOT:
        # Every other type versioning.md lists, 0x0001 to this one, is unexpected; any other unknown.
        return ("unexpected-record-type" if 0 < t <= ROOT else "unknown-record-type"), 0
    if len(b) < 3:
        return "truncated", 2
    if b[2] != 1:
        return "profile-mismatch", 2
    for start, end in ((3, 35), (35, 36), (36, 37)):
        if len(b) < end:
            return "truncated", start
    if b[36] not in (RECEIPTS, COMPLAINTS):
        return "invalid-enum", 36
    if len(b) < 41:
        return "truncated", 37
    c = int.from_bytes(b[37:41], "big")
    if c == 0:
        return "non-canonical", 37
    for start, end in ((41, 73), (73, 109), (109, 173)):
        if len(b) < end:
            return "truncated", start
    # The CID's framing follows from the signed kind and count alone (content-addressing.md).
    raw = LEAF_SIZE[b[36]] * c <= 1_048_576
    if b[73:77] != bytes([0x01, 0x55 if raw else 0x70, 0x12, 0x20]):
        return "non-canonical", 73
    if not dv.sig_canonical(b[109:173]):
        return "non-canonical", 109
    if len(b) > 173:
        return "trailing-bytes", 173
    return {"definitionHash": b[3:35], "seat": b[35], "kind": b[36], "count": c, "root": b[41:73], "cid": b[73:109], "signature": b[109:173], "statement": b[3:109]}


def is_root(payload):
    return len(payload) >= 3 and int.from_bytes(payload[:2], "big") == ROOT


def read_leaves(f, obj):
    """Leaf availability, Consistency: the leaves, or None for an inconsistent root."""
    size = LEAF_SIZE[f["kind"]]
    # A dag-pb DAG whose blocks hash to the CID but isn't objectCid's layout would be
    # inconsistent too; every leaf object here is canonical or a single raw block.
    if object_cid(obj) != f["cid"] or len(obj) != size * f["count"]:
        return None
    leaves = []
    for j in range(f["count"]):
        raw = obj[size * j : size * (j + 1)]
        bh = raw[:32]
        if leaves and bh <= leaves[-1][0]:
            return None
        if f["kind"] == RECEIPTS:
            leaves.append((bh, raw[32:]))
            continue
        d_raw, cc, z = raw[32:64], int.from_bytes(raw[64:96], "little"), int.from_bytes(raw[96:128], "little")
        d = None if d_raw == bytes(32) else grp.decode(d_raw)
        if d is None or cc >= L or z >= L:
            return None
        leaves.append((bh, {"dh": d, "c": cc, "z": z}))
    if TREE.mth([obj[size * j : size * (j + 1)] for j in range(f["count"])]) != f["root"]:
        return None
    return leaves


# --- The delivery check, with roots --------------------------------------------------


def check_delivery(definition_hash, registered, threshold, bound, seg_d, seg_k, t_d, t_k, ballots, entries, attestations, objects):
    """docs/spec/delivery.md, Delivery check, from the spec's text, with batches and obligation
    roots. Each entry is (path, segment or submission time, payload); `attestations` maps each
    seat that attested the counted extent to the record hashes of the roots it named; `objects`
    maps a CID to the bytes a source served for it; bytes that don't hash to their CID, or none,
    are a failed fetch, and leave the election unverifiable from these sources."""
    hashes = [sr.ballot_hash(b["ctx"], bv.enc_committed_vote(b["vote"])) for b in ballots]
    index = {h: i for i, h in enumerate(hashes)}
    delivered = [set() for _ in ballots]
    reports, rejected = [], []
    receipts, complaints = [], []
    postings = [dict() for _ in ballots]
    slots = set()
    unverifiable = []

    def place(at, where):
        return dict({"at": at}, **({} if where is None else {where[0]: where[1]}))

    def in_time(path, when, kind):
        if path == "board":
            return when <= (seg_k if kind == "complaint" else seg_d)
        return when <= (t_k if kind == "complaint" else t_d)

    def receipt(at, where, i, seat, share_hash, signed_ballot, signed_own):
        shares = ballots[i]["vote"]["shareHashes"]
        if not (share_hash == shares[seat - 1] and signed_ballot):
            reports.append(dict(place(at, where), code="share-receipt", signer=seat if signed_own else None))
            return
        delivered[i].add(seat)
        receipts.append((at, where, i, seat))

    for at, (path, when, payload) in enumerate(entries):
        if is_root(payload):
            # No board-entry version allows a root: through the board path it is a rejected entry.
            if path != "contract":
                rejected.append({"at": at, "error": "unexpected-record-type"})
                continue
            f = parse_root(payload)
            if isinstance(f, tuple):
                rejected.append({"at": at, "error": f[0]})
                continue
            if f["definitionHash"] != definition_hash:
                reports.append({"at": at, "code": "delivery-stray"})
                continue
            seat, kind = f["seat"], f["kind"]
            key = registered.get(seat)
            if key is None:
                reports.append({"at": at, "code": "delivery-seat"})
                continue
            if not ecdsa.verify(key["signingKey"], bv.ds(ROOT_TAG, f["statement"]), f["signature"]):
                reports.append({"at": at, "code": "root-signature", "signer": None})
                continue
            # Only a root whose signature verifies fills its seat's slot for its kind.
            if (seat, kind) in slots:
                reports.append({"at": at, "code": "root-repeat"})
                continue
            slots.add((seat, kind))
            if when > (t_d if kind == RECEIPTS else t_k):
                reports.append({"at": at, "code": "delivery-late"})
                continue
            if f["count"] > bound:
                reports.append({"at": at, "code": "root-count", "signer": seat})
                continue
            rh = record_hash(payload)
            named = sorted(s for s, roots in attestations.items() if rh in roots)
            if len(named) < threshold:
                without = sorted(s for s in attestations if s not in named)
                reports.append({"at": at, "code": "root-withheld", "signer": seat, "namedBy": named, "attestedWithout": without})
                continue
            obj = objects.get(f["cid"])
            # Leaf availability, Fetched: a source's wrong bytes are its failure, never the root's.
            if obj is None or object_cid(obj) != f["cid"]:
                unverifiable.append({"at": at})
                continue
            leaves = read_leaves(f, obj)
            if leaves is None:
                reports.append({"at": at, "code": "root-inconsistent", "signer": seat})
                continue
            for j, (bh, x) in enumerate(leaves):
                i = index.get(bh)
                if i is None:
                    continue
                if kind == RECEIPTS:
                    # The root's signature has verified: each leaf's statement is the seat's own.
                    receipt(at, ("leaf", j), i, seat, x, True, True)
                else:
                    complaints.append((at, ("leaf", j), i, {"seat": seat, "proof": x, "signed": True}))
            continue
        if db.is_complaint_batch(payload):
            if path != "contract":
                rejected.append({"at": at, "error": "unexpected-record-type"})
                continue
            f = db.parse_complaint_batch(payload)
            if isinstance(f, tuple):
                rejected.append({"at": at, "error": f[0]})
                continue
            if f["definitionHash"] != definition_hash:
                reports.append({"at": at, "code": "delivery-stray"})
                continue
            seat = f["seat"]
            key = registered.get(seat)
            signed = key is not None and ecdsa.verify(key["signingKey"], bv.ds(db.COMPLAINT_BATCH_TAG, f["statement"]), f["signature"])
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
                complaints.append((at, ("pair", j), i, {"seat": seat, "proof": proof, "signed": signed}))
            continue
        if db.is_batch(payload):
            if path != "contract":
                rejected.append({"at": at, "error": "unexpected-record-type"})
                continue
            f = db.parse_batch(payload)
            if isinstance(f, tuple):
                rejected.append({"at": at, "error": f[0]})
                continue
            if f["definitionHash"] != definition_hash:
                reports.append({"at": at, "code": "delivery-stray"})
                continue
            seat = f["seat"]
            key = registered.get(seat)
            signed = key is not None and ecdsa.verify(key["signingKey"], bv.ds(db.BATCH_TAG, f["statement"]), f["signature"])
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
                receipt(at, ("pair", j), i, seat, sh, signed, signed)
            continue
        if path != "contract" and len(payload) >= 3 and int.from_bytes(payload[:2], "big") == dv.POSTING:
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
    for at, where, i, f in complaints:
        seat = f["seat"]
        posting = postings[i].get(seat)
        if posting is None:
            reports.append(dict(place(at, where), code="complaint-void"))
            continue
        b = ballots[i]
        key = registered[seat]
        code = se.check_complaint(definition_hash, seat, key["kem"], b["vote"]["vss"], b["vote"]["shareHashes"], posting["ciphertext"], posting["m"], f["proof"])
        if where is None:
            m = dv.complaint_statement(definition_hash, f["ballotHash"], seat, f["proof"])
            signed = ecdsa.verify(key["signingKey"], bv.ds(dv.COMPLAINT_TAG, m), f["signature"])
        else:
            signed = f["signed"]
        signer = seat if signed else None
        if code == "ok":
            excluded[i].append(dict(place(at, where), seat=seat, signer=signer))
        elif code == "complaint-unfounded":
            reports.append(dict(place(at, where), code=code, signer=signer))
        else:
            reports.append(dict(place(at, where), code="complaint-proof"))
    for at, where, i, seat in receipts:
        if any(c["seat"] == seat for c in excluded[i]):
            reports.append(dict(place(at, where), code="receipt-contradicted", signer=seat))
    order = lambda r: (r["at"], r.get("pair", r.get("leaf", -1)))
    reports.sort(key=order)
    out = []
    for i, h in enumerate(hashes):
        missing = sorted(s for s in registered if s not in delivered[i])
        ex = sorted(excluded[i], key=order)
        out.append({"ballotHash": h.hex(), "counted": not missing and not ex, "delivered": not missing, "missing": missing, "excludedBy": ex})
    if unverifiable:
        return {"unverifiable": unverifiable}
    return {"ballots": out, "records": reports, "rejected": rejected}


# --- Capacity, for elections that commit roots -------------------------------------


def commits_roots(e, w):
    """What a node owes, Elections that commit roots: a rolling election always
    does, decided from the definition alone; a fixed one when, alone, with
    batches, it doesn't fit."""
    return bool(e.get("rolling")) or not ob.fits([e], w)


def root_intervals(e, w):
    """An election's two intervals, each one root call per seat if it commits roots."""
    if not commits_roots(e, w):
        return ob.intervals(e, w)
    return [(start, end, e["seats"] * ROOT_CALL_GAS, kind) for start, end, kind in ob.spans(e, w)]


def fits(elections, w):
    """ob.fits's sweep, with each election's intervals decided alone first."""
    events = []
    for e in elections:
        for start, stop, gas, _ in root_intervals(e, w):
            rate = Fraction(gas, stop - start)
            events.append((start, 1, rate))
            events.append((stop, 0, -rate))
    limit = Fraction(ob.FORCED_PATH["depositGasTarget"], ob.FORCED_PATH["l1BlockSeconds"])
    rate = Fraction(0)
    for _, _, delta in sorted(events, key=lambda x: (x[0], x[1])):
        rate += delta
        if rate > limit:
            return False
    return True


# --- Vectors ----------------------------------------------------------------------


def main():
    grp.self_check()
    ecdsa.self_check()
    se.aead_self_check()
    se.mlkem_self_check(100)
    bd.self_check(HERE.parent.parent / "test-vectors" / "transparency-dev")
    cid_self_check()
    out = sys.argv[1]

    # delivery.json's panel, definition and ballots, from the same labels.
    keys = se.trustee_keys("panel-3", 3)
    base = bv.context("delivery", 3, 0, 1, 2, 3)
    definition_hash = base["definitionHash"]
    other_definition = bv.H(b"another election")
    # Leaf availability: q − k + 1 of the default panel's q = 3 qualified seats, k = 2.
    threshold = 3 - base["threshold"] + 1
    assert threshold == 2

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
        b = ballots[name]
        result, r = sr.intake(b["ctx"], seat, keys[seat - 1], signing_secret(seat), b["vote"], b["cts"][seat - 1])
        assert result == "ok", (name, seat, result)
        return (r["ballotHash"], r["shareHash"]), dv.receipt_record(definition_hash, r["ballotHash"], seat, r["shareHash"], r["receipt"])

    def pair(name, seat):
        return receipted(name, seat)[0]

    def R(name, seat):
        return receipted(name, seat)[1]

    def B(seat, names):
        return db.batch_record(definition_hash, seat, [pair(n, seat) for n in names], signing_secret(seat))

    def P(name, seat):
        b = ballots[name]
        return dv.posting_record(definition_hash, b["hash"], seat, bytes.fromhex(b["encRand"][seat - 1]["m"]), b["cts"][seat - 1])

    # Every root an election carries, with its leaf object, so each election lists what it needs.
    made = {}

    def root(seat, kind, leaves, secret=None, definition=None, **kw):
        rec, obj = root_record(definition or definition_hash, seat, kind, leaves, secret or signing_secret(seat), **kw)
        made[rec] = obj
        return rec

    def RR(seat, names, **kw):
        return root(seat, RECEIPTS, [pair(n, seat) for n in names], **kw)

    complaint_rng = bv.Rng("delivery-root/complaint")
    bc, ba_, bd_ = ballots["carol"], ballots["alice"], ballots["dave"]
    carol_proof = se.prove_complaint(definition_hash, 2, keys[1], bc["vote"]["vss"], bc["vote"]["shareHashes"], bc["cts"][1], bytes.fromhex(bc["encRand"][1]["m"]), se.nonzero_scalar(complaint_rng))
    alice_unfounded = se.raw_complaint(definition_hash, 2, keys[1], ba_["cts"][1], se.nonzero_scalar(complaint_rng))
    bad_proof = dict(carol_proof, z=(carol_proof["z"] + 1) % L)

    # --- Records re-made byte for byte ---
    records = []

    def record(id_, desc, rec, listed=True):
        f = parse_root(rec)
        assert isinstance(f, dict), (id_, f)
        obj = made[rec]
        size = LEAF_SIZE[f["kind"]]
        r = {
            "id": id_,
            "description": desc,
            "encoding": rec.hex(),
            "seat": f["seat"],
            "kind": f["kind"],
            "count": f["count"],
            "root": f["root"].hex(),
            "leavesCid": f["cid"].hex(),
            "statement": f["statement"].hex(),
            "recordHash": record_hash(rec).hex(),
            "objectLength": len(obj),
            "objectSha256": hashlib.sha256(obj).hexdigest(),
        }
        if listed:
            r["leafObject"] = obj.hex()
            r["leafHashes"] = [bd.tagged(LEAF_TAG)(obj[size * j : size * (j + 1)]).hex() for j in range(f["count"])]
        assert read_leaves(f, obj) is not None
        records.append(r)

    receipt_root = RR(1, ["alice", "bob", "carol"])
    record("receipt-root", "Seat 1's receipt root over its receipts for Alice's, Bob's and Carol's ballots, ascending by ballot hash", receipt_root)
    one_root = RR(1, ["alice"])
    record("one-leaf", "Seat 1's receipt root over its one receipt for Alice's ballot: the root is the leaf's hash", one_root)
    complaint_root = root(2, COMPLAINTS, [(bc["hash"], carol_proof), (ba_["hash"], alice_unfounded)])
    record("complaint-root", "Seat 2's complaint root over a proven complaint about Carol's posted share and an unfounded one about Alice's", complaint_root)
    # The most receipt leaves one raw block holds, and one more, which takes a dag-pb root.
    made_up = [(bv.H(f"delivery-root/full/{j}".encode()), bv.H(f"delivery-root/full/share/{j}".encode())) for j in range(16_385)]
    one_block = root(2, RECEIPTS, made_up[:16_384])
    assert len(made[one_block]) == 1_048_576 and parse_root(one_block)["cid"][:2] == b"\x01\x55"
    record("one-block", "Seat 2's receipt root over 16,384 made-up leaves: a 1 MiB leaf object, one raw block; leaf j is H(\"delivery-root/full/j\") and H(\"delivery-root/full/share/j\"), sorted", one_block, listed=False)
    two_blocks = root(2, RECEIPTS, made_up)
    assert parse_root(two_blocks)["cid"][:2] == b"\x01\x70"
    record("two-blocks", "The same with one more made-up leaf: two chunks under a dag-pb root", two_blocks, listed=False)

    # --- Inclusion proofs ---
    proofs = []
    tree_leaves = [leaf_bytes(RECEIPTS, (bv.H(f"delivery-root/tree/{j}".encode()), bv.H(f"delivery-root/tree/share/{j}".encode()))) for j in range(9)]
    for n in range(1, 10):
        d = tree_leaves[:n]
        rt = TREE.mth(d)
        for j in range(n):
            path = TREE.path(j, d)
            assert TREE.verify_inclusion(j, n, d[j], path, rt)
            proofs.append({"id": f"n{n}-leaf{j}", "size": n, "index": j, "leaf": d[j].hex(), "root": rt.hex(), "path": [p.hex() for p in path], "valid": True})
    d7 = tree_leaves[:7]
    r7, r8 = TREE.mth(d7), TREE.mth(tree_leaves[:8])
    p3 = TREE.path(3, d7)
    board_tree = bd.Tree(bd.tagged("abolish/v1/merkle/leaf"), bd.tagged("abolish/v1/merkle/node"))
    bad = [
        ("another-leaf", "Leaf 3's path offered for leaf 4", 7, 4, d7[4], r7, p3),
        ("another-size", "Leaf 3's path in the tree of 7 offered for the tree of 8, with that tree's root", 8, 3, d7[3], r8, p3),
        ("another-root", "Leaf 3's path against the root of the tree of 8", 7, 3, d7[3], r8, p3),
        ("truncated", "Leaf 3's path without its last hash", 7, 3, d7[3], r7, p3[:-1]),
        ("extended", "Leaf 3's path with its first hash appended", 7, 3, d7[3], r7, p3 + [p3[0]]),
        ("index-out-of-range", "An index equal to the size", 7, 7, d7[3], r7, p3),
        ("board-tree", "The path and root of the board tree's tags over the same leaves, checked under the obligation tree's", 7, 3, d7[3], board_tree.mth(d7), board_tree.path(3, d7)),
    ]
    for id_, desc, n, j, leaf, rt, path in bad:
        assert not TREE.verify_inclusion(j, n, leaf, path, rt), id_
        proofs.append({"id": id_, "description": desc, "size": n, "index": j, "leaf": leaf.hex(), "root": rt.hex(), "path": [p.hex() for p in path], "valid": False})

    # --- Decode rejections ---
    decode = []

    def reject(id_, desc, enc, error, offset):
        got = parse_root(enc)
        assert got == (error, offset), (id_, got)
        decode.append({"id": id_, "description": desc, "encoding": enc.hex(), "error": error, "offset": offset})

    def resign(body):
        """The record's header and `body` (the 106 signed bytes), signed by seat 1."""
        return receipt_root[:3] + body + sr.sign(signing_secret(1), body, ROOT_TAG)

    body = receipt_root[3:109]
    reject("truncated-header", "The type alone: a record ending before its version", receipt_root[:2], "truncated", 2)
    reject("another-type", "A share-receipt batch's bytes read as a root", B(1, ["alice"]), "unexpected-record-type", 0)
    reject("version-2", "A root labelled version 2: ballot versions 1 to 3 fix version 1", receipt_root[:2] + b"\x02" + receipt_root[3:], "profile-mismatch", 2)
    reject("truncated-definition", "A root ending inside its definition hash", receipt_root[:20], "truncated", 3)
    reject("truncated-seat", "A root ending after its definition hash", receipt_root[:35], "truncated", 35)
    reject("truncated-kind", "A root ending after its seat", receipt_root[:36], "truncated", 36)
    reject("kind-0", "A root of kind 0, signed", resign(body[:33] + b"\x00" + body[34:]), "invalid-enum", 36)
    reject("kind-3", "A root of kind 3, signed", resign(body[:33] + b"\x03" + body[34:]), "invalid-enum", 36)
    reject("truncated-count", "A root ending inside its count", receipt_root[:39], "truncated", 37)
    reject("count-0", "A root of no leaves, signed", resign(body[:34] + u32(0) + body[38:]), "non-canonical", 37)
    reject("truncated-root", "A root ending inside its root", receipt_root[:60], "truncated", 41)
    reject("truncated-cid", "A root ending inside its CID", receipt_root[:100], "truncated", 73)
    reject("truncated-signature", "A root one byte short", receipt_root[:-1], "truncated", 109)
    reject("cid-dag-pb-small", "A three-leaf root whose CID has the dag-pb codec, signed: its 192-byte object is one raw block", resign(body[:70] + b"\x01\x70" + body[72:]), "non-canonical", 73)
    reject("cid-version-0", "A root whose CID's version byte is 0, signed", resign(body[:70] + b"\x00" + body[71:]), "non-canonical", 73)
    reject("cid-other-hash", "A root whose CID names another multihash, signed", resign(body[:72] + b"\x13" + body[73:]), "non-canonical", 73)
    big = two_blocks[3:109]
    raw_big = big[:70] + b"\x01\x55" + big[72:]
    reject("cid-raw-large", "The 16,385-leaf root with a raw codec, signed: its object is over 1 MiB", two_blocks[:3] + raw_big + sr.sign(signing_secret(2), raw_big, ROOT_TAG), "non-canonical", 73)
    r_, s_ = int.from_bytes(receipt_root[-64:-32], "big"), int.from_bytes(receipt_root[-32:], "big")
    reject("high-s", "The signature with s replaced by n − s", receipt_root[:-64] + ecdsa.sig_bytes(r_, ecdsa.N - s_), "non-canonical", 109)
    reject("zero-r", "The signature with r of 0", receipt_root[:-64] + ecdsa.sig_bytes(0, s_), "non-canonical", 109)
    reject("trailing", "A root with a trailing byte", receipt_root + b"\x00", "trailing-bytes", 173)
    reject("unknown-type", "A root's bytes under type 0x001b, which versioning.md doesn't list", b"\x00\x1b" + receipt_root[2:], "unknown-record-type", 0)
    reject("type-0", "A root's bytes under type 0", b"\x00\x00" + receipt_root[2:], "unknown-record-type", 0)
    # Two faults in one record: the first in field order wins, every field
    # present before the CID's framing is judged, and the framing before the
    # signature's range and the record's end.
    kind3 = resign(body[:33] + b"\x03" + body[34:])
    reject("kind-3-count-truncated", "A root of kind 3 ending inside its count: the kind is judged first", kind3[:39], "invalid-enum", 36)
    count0 = resign(body[:34] + u32(0) + body[38:])
    reject("count-0-root-truncated", "A root of no leaves ending inside its root: the count is judged first", count0[:60], "non-canonical", 37)
    dag_small = resign(body[:70] + b"\x01\x70" + body[72:])
    reject("cid-dag-pb-small-signature-truncated", "The dag-pb CID of a three-leaf root, the record one byte short: every field is present before the CID's framing is judged", dag_small[:-1], "truncated", 109)
    r2, s2 = int.from_bytes(dag_small[-64:-32], "big"), int.from_bytes(dag_small[-32:], "big")
    reject("cid-dag-pb-small-high-s", "The dag-pb CID of a three-leaf root with s replaced by n − s: the CID is judged before the signature", dag_small[:-64] + ecdsa.sig_bytes(r2, ecdsa.N - s2), "non-canonical", 73)
    reject("high-s-trailing", "The signature with s replaced by n − s and a trailing byte: the signature is judged before the end", receipt_root[:-64] + ecdsa.sig_bytes(r_, ecdsa.N - s_) + b"\x00", "non-canonical", 109)

    # --- Elections ---
    elections = []
    SD, SK = 40, 112
    TD, TK = dv.deadlines(1_700_000_000, 0)
    T0 = TD - dv.DELIVERY_WINDOW
    BOUND = 8  # 2M for the vectors' four members

    def election(id_, desc, names, entries, seats=(1, 2, 3), attestations=None, objects=None):
        sel = [ballots[n] for n in names]
        roots = [p for _, _, p in entries if is_root(p) and p in made]
        if attestations is None:
            # Every registered seat attested the counted extent and named every root it carries.
            attestations = {s: {record_hash(p) for p in roots} for s in seats}
        if objects is None:
            objects = {parse_root(p)["cid"]: made[p] for p in roots}
        result = check_delivery(definition_hash, registered(seats), threshold, BOUND, SD, SK, TD, TK, sel, entries, attestations, objects)
        elections.append(
            {
                "id": id_,
                "description": desc,
                "registered": list(seats),
                "threshold": threshold,
                "bound": BOUND,
                "segments": {"delivery": str(SD), "complaint": str(SK)},
                "deadlines": {"delivery": str(TD), "complaint": str(TK)},
                "ballots": [ballot_json(b) for b in sel],
                "entries": [{"path": "board", "segment": w, "payload": p.hex()} if path == "board" else {"path": "contract", "submittedAt": str(w), "payload": p.hex()} for path, w, p in entries],
                "attestations": [{"seat": s, "roots": sorted(h.hex() for h in attestations[s])} for s in sorted(attestations)],
                "leafObjects": [{"cid": c.hex(), "object": o.hex()} for c, o in sorted(objects.items())],
                "result": result,
            }
        )
        return result

    def at(seg, *payloads):
        return [("board", seg, p) for p in payloads]

    def by(t, *payloads):
        return [("contract", t, p) for p in payloads]

    honest = ["alice", "bob"]
    abd = ["alice", "bob", "dave"]
    roots3 = by(T0 + 60, RR(1, honest), RR(2, honest), RR(3, honest))
    r = election("roots-deliver", "Each seat sends one receipt root over Alice's and Bob's receipts, named by every seat: both are delivered", honest, roots3)
    assert all(b["counted"] for b in r["ballots"]) and r["records"] == []
    r = election("root-at-deadline", "Seat 3's root is submitted at the delivery deadline itself", honest, by(T0 + 60, RR(1, honest), RR(2, honest)) + by(TD, RR(3, honest)))
    assert all(b["counted"] for b in r["ballots"])
    r = election("late-root", "Seat 3's root is submitted a second after the delivery deadline: reported once, and seat 3 is missing", honest, by(T0 + 60, RR(1, honest), RR(2, honest)) + by(TD + 1, RR(3, honest)))
    assert [b["missing"] for b in r["ballots"]] == [[3], [3]] and r["records"] == [{"at": 2, "code": "delivery-late"}], r
    r = election("board-path-root", "Seat 3's root through the board path: a rejected entry", honest, by(T0 + 60, RR(1, honest), RR(2, honest)) + at(3, RR(3, honest)))
    assert [b["missing"] for b in r["ballots"]] == [[3], [3]] and r["rejected"] == [{"at": 2, "error": "unexpected-record-type"}]
    r = election("stray-root", "Seat 3's root names another definition: reported once", honest, by(T0 + 60, RR(1, honest), RR(2, honest), RR(3, honest, definition=other_definition)))
    assert r["records"] == [{"at": 2, "code": "delivery-stray"}]
    r = election("unqualified-root", "Seat 3 isn't qualified: its root is delivery-seat, once, and both ballots are delivered by seats 1 and 2", honest, roots3, seats=(1, 2))
    assert all(b["counted"] for b in r["ballots"]) and r["records"] == [{"at": 2, "code": "delivery-seat"}]
    r = election("wrong-key", "Seat 3's root signed with seat 2's key: root-signature, attributed to no one", honest, by(T0 + 60, RR(1, honest), RR(2, honest), RR(3, honest, secret=signing_secret(2))))
    assert r["records"] == [{"at": 2, "code": "root-signature", "signer": None}] and [b["missing"] for b in r["ballots"]] == [[3], [3]]
    r = election("identity-key", "Seat 3's root signed with its identity key: never its per-election key", honest, by(T0 + 60, RR(1, honest), RR(2, honest), RR(3, honest, secret=identity_secret(3))))
    assert r["records"] == [{"at": 2, "code": "root-signature", "signer": None}]
    r = election("repeat", "Seat 3 sends a root over Alice's receipt, then one over both: the second is root-repeat, so Bob lacks seat 3", honest, by(T0 + 60, RR(1, honest), RR(2, honest), RR(3, ["alice"]), RR(3, honest)))
    assert [b["missing"] for b in r["ballots"]] == [[], [3]] and r["records"] == [{"at": 3, "code": "root-repeat"}], r
    r = election(
        "repeat-after-unsigned",
        "Seat 3's first root is signed with another key and fills no slot; its second, signed, is read",
        honest,
        by(T0 + 60, RR(1, honest), RR(2, honest), RR(3, ["alice"], secret=signing_secret(1)), RR(3, honest)),
    )
    assert all(b["counted"] for b in r["ballots"]) and r["records"] == [{"at": 2, "code": "root-signature", "signer": None}], r
    r = election("kinds-apart", "Seat 2's complaint root doesn't take its receipt root's slot", honest, by(T0 + 60, RR(1, honest), root(2, COMPLAINTS, [(ba_["hash"], alice_unfounded)]), RR(2, honest), RR(3, honest)))
    assert all(b["counted"] for b in r["ballots"]) and r["records"] == [{"at": 1, "leaf": 0, "code": "complaint-void"}], r
    over = RR(3, honest, count=BOUND + 1)
    r = election("over-bound", "Seat 3's root claims 2M + 1 leaves: root-count against seat 3, before anything is fetched", honest, by(T0 + 60, RR(1, honest), RR(2, honest), over))
    assert r["records"] == [{"at": 2, "code": "root-count", "signer": 3}], r
    at_bound = RR(3, abd)
    assert parse_root(at_bound)["count"] <= BOUND
    seat3 = RR(3, honest)
    others = {record_hash(RR(1, honest)), record_hash(RR(2, honest))}
    held = {parse_root(p)["cid"]: made[p] for p in (RR(1, honest), RR(2, honest))}
    r = election(
        "withheld",
        "Only seat 3 names its own root: below the threshold of 2, so it is withheld, and both ballots lack seat 3",
        honest,
        by(T0 + 60, RR(1, honest), RR(2, honest), seat3),
        attestations={1: others, 2: others, 3: others | {record_hash(seat3)}},
        objects=held,
    )
    assert [b["missing"] for b in r["ballots"]] == [[3], [3]]
    assert r["records"] == [{"at": 2, "code": "root-withheld", "signer": 3, "namedBy": [3], "attestedWithout": [1, 2]}], r
    r = election(
        "available-at-threshold",
        "Seats 1 and 3 name seat 3's root and seat 2 doesn't attest at all: two is the threshold, so it is available",
        honest,
        by(T0 + 60, RR(1, honest), RR(2, honest), seat3),
        attestations={1: others | {record_hash(seat3)}, 3: others | {record_hash(seat3)}},
    )
    assert all(b["counted"] for b in r["ballots"]) and r["records"] == []
    r = election(
        "withheld-beside-receipts",
        "Seat 3's root is withheld, but its single receipts reached the board through the board path: both ballots are delivered",
        honest,
        by(T0 + 60, RR(1, honest), RR(2, honest), seat3) + at(3, R("alice", 3), R("bob", 3)),
        attestations={1: others, 2: others, 3: others},
        objects=held,
    )
    assert all(b["counted"] for b in r["ballots"]) and [x["code"] for x in r["records"]] == ["root-withheld"]

    def inconsistent(id_, desc, rec, obj):
        made[rec] = obj
        r = election(id_, desc, honest, by(T0 + 60, RR(1, honest), RR(2, honest), rec))
        assert [b["missing"] for b in r["ballots"]] == [[3], [3]] and r["records"] == [{"at": 2, "code": "root-inconsistent", "signer": 3}], (id_, r)

    pairs3 = sorted([pair(n, 3) for n in honest])
    good_obj = leaf_object(RECEIPTS, pairs3)
    inconsistent("wrong-root", "Seat 3's root signs a root its leaves don't give", root(3, RECEIPTS, pairs3, root=bv.H(b"not the root")), good_obj)
    inconsistent("wrong-count", "Seat 3's root says three leaves over an object of two", root(3, RECEIPTS, pairs3, count=3), good_obj)
    unordered = [pairs3[1], pairs3[0]]
    inconsistent("unordered", "Seat 3's leaves out of order, the root and CID over them as they stand", root(3, RECEIPTS, unordered, sort=False), leaf_object(RECEIPTS, unordered))
    sources = by(T0 + 60, RR(1, honest), RR(2, honest), seat3)
    served = dict(held)
    served[parse_root(seat3)["cid"]] = leaf_object(RECEIPTS, sorted([pair("alice", 2), pair("bob", 2)]))
    r = election("wrong-bytes", "A source serves seat 2's leaves for seat 3's available root: a failed fetch, so the election is unverifiable from these sources, never seat 3's root inconsistent", honest, sources, objects=served)
    assert r == {"unverifiable": [{"at": 2}]}, r
    r = election("unfetched", "No source serves seat 3's available root: unverifiable, never failed", honest, sources, objects=held)
    assert r == {"unverifiable": [{"at": 2}]}, r
    # A complaint leaf whose D is the identity, root and CID over the object as it stands.
    bad_leaves = [(bc["hash"], carol_proof)]
    bad_obj = bytearray(leaf_object(COMPLAINTS, bad_leaves))
    bad_obj[32:64] = bytes(32)
    bad_obj = bytes(bad_obj)
    bad_root = root(2, COMPLAINTS, bad_leaves, root=TREE.mth([bad_obj]), cid=object_cid(bad_obj))
    made[bad_root] = bad_obj
    carol_posted = by(T0 + 60, RR(1, ["carol"]), RR(3, ["carol"]), P("carol", 2))
    r = election("undecodable-complaint-leaf", "Seat 2's complaint root whose one leaf has the identity as D: inconsistent, and Carol stays counted", ["carol"], carol_posted + by(T0 + 120, bad_root))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 3, "code": "root-inconsistent", "signer": 2}], r

    ba, bb = ballots["alice"], ballots["bob"]
    wrong_share = root(3, RECEIPTS, [pair("alice", 3), (bb["hash"], bb["vote"]["shareHashes"][0])])
    r = election("wrong-share-hash", "Seat 3's root pairs Bob's ballot with seat 1's share hash: that leaf is share-receipt, attributed to seat 3", honest, by(T0 + 60, RR(1, honest), RR(2, honest), wrong_share))
    assert r["ballots"][0]["counted"] and r["ballots"][1]["missing"] == [3]
    bob_leaf = sorted([ba["hash"], bb["hash"]]).index(bb["hash"])
    assert r["records"] == [{"at": 2, "leaf": bob_leaf, "code": "share-receipt", "signer": 3}], r
    r = election("unselected-leaf", "Seat 3's root also carries a leaf for Dave's ballot, which isn't selected: set aside", ["alice"], by(T0 + 60, RR(1, ["alice"]), RR(2, ["alice"]), RR(3, ["alice", "dave"])))
    assert r["ballots"][0]["counted"] and r["records"] == []
    r = election(
        "mixed",
        "Seat 1 receipts through the board path, seat 2 by a batch, seat 3 by a root: delivered whichever path",
        honest,
        at(3, R("alice", 1), R("bob", 1)) + by(T0 + 60, B(2, honest), RR(3, honest)),
    )
    assert all(b["counted"] for b in r["ballots"]) and r["records"] == []
    r = election("duplicates", "Seat 3's receipt for Alice as a leaf, a batch pair and a single receipt: delivered once, nothing reported", ["alice"], by(T0 + 60, RR(1, ["alice"]), RR(2, ["alice"]), RR(3, ["alice"]), B(3, ["alice"]), R("alice", 3)))
    assert r["ballots"][0]["counted"] and r["records"] == []

    k_root = root(2, COMPLAINTS, [(bc["hash"], carol_proof)])
    r = election("complaint-root-proven", "Carol's dishonest seat-2 share is posted, and seat 2's complaint root proves it: Carol is excluded, attributed to seat 2", ["carol"], carol_posted + by(T0 + 120, k_root))
    assert not r["ballots"][0]["counted"] and r["ballots"][0]["excludedBy"] == [{"at": 3, "leaf": 0, "seat": 2, "signer": 2}], r
    r = election("complaint-root-at-end", "The complaint root is submitted at the end of the complaint window itself", ["carol"], carol_posted + by(TK, k_root))
    assert not r["ballots"][0]["counted"]
    r = election("complaint-root-late", "The complaint root is submitted a second after the complaint window: reported once, and Carol stays counted", ["carol"], carol_posted + by(TK + 1, k_root))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 3, "code": "delivery-late"}], r
    r = election(
        "complaint-root-receipt-deadline",
        "A complaint root submitted after the delivery deadline but within the complaint window is in time",
        ["carol"],
        carol_posted + by(TD + 1, k_root),
    )
    assert not r["ballots"][0]["counted"]
    alice_posted = by(T0 + 60, RR(1, ["alice", "carol"]), RR(3, ["alice", "carol"]), P("alice", 2), P("carol", 2))
    r = election(
        "complaint-root-mixed",
        "Alice's and Carol's seat-2 shares posted; seat 2's complaint root complains about both: Carol excluded, Alice's complaint unfounded and attributed to seat 2",
        ["alice", "carol"],
        alice_posted + by(T0 + 120, complaint_root),
    )
    assert r["ballots"][0]["counted"] and not r["ballots"][1]["counted"], r
    assert [(x["code"], x["signer"]) for x in r["records"]] == [("complaint-unfounded", 2)], r
    r = election("complaint-root-proof-fails", "Seat 2's complaint root with a proof whose z is changed: complaint-proof, and Carol stays counted", ["carol"], carol_posted + by(T0 + 120, root(2, COMPLAINTS, [(bc["hash"], bad_proof)])))
    assert r["ballots"][0]["counted"] and r["records"] == [{"at": 3, "leaf": 0, "code": "complaint-proof"}], r
    r = election("complaint-root-void", "Seat 2's complaint root about Carol with no passing posting: void, and Carol lacks seat 2", ["carol"], by(T0 + 60, RR(1, ["carol"]), RR(3, ["carol"])) + by(T0 + 120, k_root))
    assert r["ballots"][0]["missing"] == [2] and r["records"] == [{"at": 2, "leaf": 0, "code": "complaint-void"}], r
    contradicting = root(2, RECEIPTS, [(bc["hash"], bc["vote"]["shareHashes"][1])])
    r = election(
        "complaint-root-contradicts",
        "Seat 2 receipts Carol's invalid share in its receipt root, and its complaint root about the posting is proven: the receipt leaf is reported against seat 2",
        ["carol"],
        by(T0 + 60, RR(1, ["carol"]), contradicting, RR(3, ["carol"]), P("carol", 2)) + by(T0 + 120, k_root),
    )
    assert not r["ballots"][0]["counted"] and r["records"] == [{"at": 1, "leaf": 0, "code": "receipt-contradicted", "signer": 2}], r
    # Reordering the records changes no verdict (R3), the repeat rule aside: roots appear once per seat and kind here.
    mixed = by(T0 + 60, RR(3, abd), R("alice", 2)) + at(5, R("bob", 2), R("dave", 2)) + by(T0 + 90, RR(1, abd))
    first = election("three-ballots", "Roots and single receipts deliver all three ballots", abd, mixed)
    assert all(b["counted"] for b in first["ballots"])
    second = election("three-ballots-reordered", "The same records in reverse order: the same verdicts", abd, list(reversed(mixed)))
    assert first["ballots"] == second["ballots"]

    # --- Capacity ---
    w1 = ob.windows(1)
    capacity = []

    def cap(id_, desc, elections_, w):
        result = fits(elections_, w)
        capacity.append(
            {
                "id": id_,
                "description": desc,
                "windows": {k: str(v) for k, v in w.items()},
                "elections": [
                    dict(
                        {k: v if k == "rolling" else str(v) for k, v in e.items()},
                        commitsRoots=commits_roots(e, w),
                        **{kind: {"start": str(s), "end": str(t), "gas": str(g)} for s, t, g, kind in root_intervals(e, w)},
                    )
                    for e in elections_
                ],
                "fits": result,
            }
        )
        return result

    limits = []
    for seats in range(1, 17):
        lim = ob.lone_limit(seats, w1)
        below, above = ob.election(lim, seats), ob.election(lim + 1, seats)
        assert not commits_roots(below, w1) and commits_roots(above, w1)
        assert cap(f"cap-{seats}", f"{seats} seats at the batch cap of {lim} members: batches, and it fits", [below], w1)
        assert cap(f"over-cap-{seats}", f"{seats} seats one member over the batch cap: it commits roots, and fits", [above], w1)
        limits.append({"seats": seats, "membersLimit": str(lim)})
    national = ob.election(150_000_000, 16)
    assert cap("national", "A national referendum of 150 million members with 16 seats commits roots and fits", [national], w1)
    # Roots of 16 seats closing together: the receipt intervals bind.
    target = Fraction(ob.FORCED_PATH["depositGasTarget"], ob.FORCED_PATH["l1BlockSeconds"])
    most = int(target * w1["margin"] / (16 * ROOT_CALL_GAS))
    big = ob.election(1_000_000, 16)
    assert cap("roots-together", f"{most} elections of 16 seats that commit roots, closing together", [big] * most, w1)
    assert not cap("roots-together-over", f"{most + 1} of them: the receipt intervals overflow the target", [big] * (most + 1), w1)
    lim3 = ob.lone_limit(3, w1)
    assert not cap("batches-beside-roots", "An election at the 3-seat batch cap beside one that commits roots, closing together: the batched one takes the whole target, so they don't fit together", [ob.election(lim3, 3), big], w1)
    later = ob.election(1_000_000, 16, closes_at=1_800_000_000 + 2 * ob.HOUR)
    assert cap("roots-apart", f"{most + 1} elections that commit roots, the last closing two hours later, after the others' receipt intervals end", [big] * most + [later], w1)
    # Rolling elections (definition version 7, electorate_mode 2) commit roots
    # whatever their size, with no M (ADR 0045).
    assert cap("rolling-small", "A rolling election of 3 seats commits roots with no member count, and fits", [ob.rolling_election(3)], w1)
    assert cap("rolling-beside-fixed", "A rolling election beside a fixed one of 1,000 members closing together: batches for the fixed one, roots for the rolling one, and they fit", [ob.election(1_000, 3), ob.rolling_election(3)], w1)
    assert not cap("rolling-beside-cap", "A rolling election beside one at the 3-seat batch cap, closing together: the batched one takes the whole target, so they don't fit together", [ob.election(lim3, 3), ob.rolling_election(3)], w1)
    assert cap("rolling-beside-cap-apart", "The same two, the rolling one closing two hours later, after the batched one's receipt interval ends: they fit", [ob.election(lim3, 3), ob.rolling_election(3, closes_at=1_800_000_000 + 2 * ob.HOUR)], w1)

    data = {
        "format": "abolish-delivery-root-vectors/1",
        "title": "Obligation roots: the record, its leaf object and tree, its decoding, leaf availability, the delivery check reading its leaves, and the forced path for elections that commit roots",
        "spec": "docs/spec/delivery.md",
        "generator": (
            "Printed by packages/crypto/scripts/delivery-root-vectors.py, an implementation of "
            "docs/spec/delivery.md in Python's integers and hashlib, sharing no code with "
            "packages/crypto or any @noble library. It reuses delivery-batch-vectors.py's records and "
            "delivery-vectors.py's ballots, P-256 ECDSA (checked against RFC 6979 Appendix A.2.5 first), "
            "postings and complaints; board-vectors.py's RFC 9162 tree (checked against transparency-dev "
            "first); and delivery-obligation-vectors.py's intervals and sweep. Its CIDs come from its own "
            "dag-pb writer, checked against every CID of content-addressing.json first. Secrets are "
            "SHA-256 of fixed labels: test data only."
        ),
        "tag": ROOT_TAG.decode(),
        "recordHashTag": ROOT_HASH_TAG.decode(),
        "leafTag": LEAF_TAG,
        "nodeTag": NODE_TAG,
        "rootCallGas": str(ROOT_CALL_GAS),
        "definitionHash": definition_hash.hex(),
        "panel": panel,
        "records": records,
        "proofs": proofs,
        "decode": decode,
        "elections": elections,
        "capacity": capacity,
        "limits": limits,
    }
    with open(f"{out}/delivery-root.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
