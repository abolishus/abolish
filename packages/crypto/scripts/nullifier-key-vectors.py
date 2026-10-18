#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/nullifier-key.json.

A second implementation of docs/spec/nullifier-key.md: the key context, the
four rounds and their signatures, the dealt-share message (0x0012, version 1)
with its hybrid-KEM encryption and the recipient's check, the key transcript
(0x0011, version 1), key_id, the transcript check with every seat's reasons
and the qualified seats' share commitments, each qualified seat's share, and
the approval statement, under transcript version 1 and under version 2, which
binds the run's deadline in its context and approves under its own tag. It is written from the spec with Python's integers and
hashlib. Baby Jubjub and J come from keyed-nullifier-vectors.py (checked
against EIP-2494 and RFC 9380 Appendix K.1 first); ML-KEM-768,
ChaCha20-Poly1305 and ristretto255 from share-encryption-vectors.py and
group-vectors.py (checked against Go's accumulated FIPS 203 vectors, RFC 8439
§2.8.2 and their own self-checks first); P-256 ECDSA from trustee-vectors.py,
which reproduces RFC 6979 Appendix A.2.5 first. Nothing here shares code with
packages/crypto or any @noble library.

Every secret comes from SHA-512 or SHA-256 over a fixed label, and each honest
seat lists the values it used, so any implementation reproduces its messages
byte for byte (ECDSA nonces are RFC 6979's). The values are test data, never
keys.

Usage: python3 -I -B packages/crypto/scripts/nullifier-key-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import hashlib
import importlib.util
import itertools
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


se = _load("share_encryption_vectors", "share-encryption-vectors.py")
kn = _load("keyed_nullifier_vectors", "keyed-nullifier-vectors.py")
ecdsa = kn.ecdsa
grp, bv = se.grp, se.bv

# ristretto255 (the KEM's DH half) and Baby Jubjub (the sharing).
RL = grp.L
RG = grp.BASE
BL = kn.L
BG = kn.G
BID = kn.ID

MAX_TRUSTEES = 16
TRANSCRIPT_TYPE = 0x0011
SHARE_TYPE = 0x0012
VERSION = 1
CT_LEN = 1088
SEALED_LEN = 80
NONCE = bytes(12)

CONTEXT_TAG = b"abolish/v1/keyed-nullifier/key-context"
CONTEXT_TAG_2 = b"abolish/v1/keyed-nullifier/key-context-2"
ROUND_TAG = b"abolish/v1/keyed-nullifier/key-round"
KEY_TAG = b"abolish/v1/keyed-nullifier/key"
SHARE_HASH_TAG = b"abolish/v1/keyed-nullifier/key-share"
KEM_TAG = b"abolish/v1/kem/nullifier-key-share"
AAD_TAG = b"abolish/v1/kem/nullifier-key-share-aad"
MESSAGE_TAG = b"abolish/v1/sig/nullifier-key-message"
SIGNING_KEY_TAG = b"abolish/v1/sig/nullifier-key-signing-key"
APPROVAL_TAG = b"abolish/v1/sig/nullifier-key-approval"
APPROVAL_TAG_2 = b"abolish/v1/sig/nullifier-key-approval-2"
# A version-2 run's deadline in the vectors: an L2 block number.
DEADLINE = 25_000_000
PANEL_TAG = b"abolish/v1/panel"

u8, u16, u32, element, ds, H = bv.u8, bv.u16, bv.u32, bv.element, bv.ds, bv.H

SCOPE = {
    "l2ChainId": 84532,
    "groupRegistry": bytes.fromhex("e7f1725e7734ce288f8367e1bb143e90bb3f0512"),
}


def u64(x):
    return x.to_bytes(8, "big")


def lst(items):
    return u32(len(items)) + b"".join(items)


def bjj_scalar(v):
    assert 0 <= v < BL
    return v.to_bytes(32, "big")


# --- Keys ----------------------------------------------------------------------------


class Rng:
    """Values from SHA-512(label ‖ counter) or SHA-256: test data only."""

    def __init__(self, label):
        self.label = label.encode()
        self.i = 0

    def _digest(self):
        self.i += 1
        return hashlib.sha512(self.label + self.i.to_bytes(4, "big")).digest()

    def ristretto_scalar(self):
        v = int.from_bytes(self._digest(), "little") % RL
        assert v != 0
        return v

    def bjj_scalar(self):
        return int.from_bytes(self._digest(), "big") % BL

    def p256_secret(self):
        d = int.from_bytes(self._digest()[:32], "big") % ecdsa.N
        assert d != 0
        return d

    def bytes32(self):
        self.i += 1
        return hashlib.sha256(self.label + b"/bytes/" + self.i.to_bytes(4, "big")).digest()


def p256_key(d):
    return ecdsa.compress(ecdsa.mul(d, ecdsa.G))


def sign(d, tag, m):
    _, r, s = ecdsa.ecdsa_sign(d, ds(tag, m))
    return ecdsa.sig_bytes(r, s)


def verify(key, tag, m, sig):
    return ecdsa.verify(key, ds(tag, m), sig)


def panel_id(k, keys):
    return H(ds(PANEL_TAG, u8(k) + u8(len(keys)) + b"".join(keys)))


def make_panel(label, k, n):
    rng = Rng(f"nullifier-key-panel/{label}")
    secrets = [rng.p256_secret() for _ in range(n)]
    keys = [p256_key(d) for d in secrets]
    assert len(set(keys)) == n
    return {"label": label, "k": k, "secrets": secrets, "keys": keys}


def context(panel, run_id, scope=SCOPE, deadline=None):
    """Version 1's context without a deadline, version 2's with one."""
    m = u64(scope["l2ChainId"]) + scope["groupRegistry"] + panel_id(panel["k"], panel["keys"]) + run_id
    if deadline is None:
        return H(ds(CONTEXT_TAG, m))
    return H(ds(CONTEXT_TAG_2, m + u64(deadline)))


# --- Messages and the dealt share ------------------------------------------------------


def signed(round_, prev, index, body, d):
    return sign(d, MESSAGE_TAG, u8(round_) + prev + u8(index) + body)


def round_hash(prev, round_, encoded):
    return H(ds(ROUND_TAG, prev + u8(round_) + encoded))


def enc_msg(m):
    return u8(m["index"]) + m["body"] + m["sig"]


def enc_round(msgs):
    return lst([enc_msg(m) for m in msgs])


def enc_transcript(run_id, rounds, record_type=TRANSCRIPT_TYPE, version=VERSION, deadline=None):
    head = run_id if version == 1 else run_id + u64(deadline)
    return u16(record_type) + u8(version) + head + b"".join(enc_round(r) for r in rounds)


def enc_commitments(points):
    return lst([kn.enc_point(p) for p in points])


def poly(coeffs, z):
    return sum(c * pow(z, j, BL) for j, c in enumerate(coeffs)) % BL


def commitment_at(commitments, i):
    c = BID
    for j, a in enumerate(commitments):
        c = kn.add(c, kn.mul(pow(i, j, BL), a))
    return c


def opening(share, blind):
    return kn.add(kn.mul(share, BG), kn.mul(blind, J))


def combine(ss_m, ss_dh, ct_dh, dh):
    return H(ds(KEM_TAG, ss_m + element(ss_dh) + element(ct_dh) + element(dh)))


def aad(ctx, dealer, recipient, commitments):
    return ds(AAD_TAG, u16(SHARE_TYPE) + u8(VERSION) + ctx + u8(dealer) + u8(recipient) + enc_commitments(commitments))


def seal_share(ctx, dealer, recipient, kem_key, commitments, plain, mu, e, aad_ctx=None):
    """The dealt-share message's bytes, with every intermediate value; `aad_ctx` lets a cheat seal under another context."""
    ss_m, ct_m = se.encaps_internal(kem_key["ek"], mu)
    ct_dh = se.pt_mul(e, RG)
    ss_dh = se.pt_mul(e, kem_key["dh"])
    k = combine(ss_m, ss_dh, ct_dh, kem_key["dh"])
    a = aad(ctx if aad_ctx is None else aad_ctx, dealer, recipient, commitments)
    sealed = se.aead_seal(k, NONCE, a, plain)
    b = u16(SHARE_TYPE) + u8(VERSION) + ctx + u8(dealer) + u8(recipient) + ct_m + element(ct_dh) + sealed
    inter = {"ssM": ss_m.hex(), "ssDh": element(ss_dh).hex(), "key": k.hex(), "aad": a.hex()}
    return b, inter


def share_hash(b):
    return H(ds(SHARE_HASH_TAG, b))


# --- The run, with ways for a seat to cheat ----------------------------------------------


def seat_secrets(label, index, k):
    rng = Rng(f"nullifier-key-seat/{label}/{index}")
    seed = rng.bytes32() + rng.bytes32()
    x = rng.ristretto_scalar()
    d = rng.p256_secret()
    f = [rng.bjj_scalar() for _ in range(k)]
    g = [rng.bjj_scalar() for _ in range(k)]
    ek, dk = se.keygen_internal(seed[:32], seed[32:])
    return {"index": index, "seed": seed, "x": x, "dh": se.pt_mul(x, RG), "signing": d, "ek": ek, "dk": dk, "f": f, "g": g, "rng": rng}


def keys_body(ctx, s):
    kem_key = s["ek"] + element(s["dh"])
    signing_key = p256_key(s["signing"])
    pop = sign(s.get("popSigner", s["signing"]), SIGNING_KEY_TAG, ctx + u8(s["index"]) + kem_key + signing_key)
    return kem_key + signing_key + pop


def run(label, panel, seats, cheat=None, scope=SCOPE, deadline=None):
    """The four rounds for `seats` (indices taking part); `cheat` maps a hook name to a function; a deadline makes it a version-2 run."""
    cheat = cheat or {}
    k = panel["k"]
    run_id = H(f"nullifier-key-run/{label}".encode())
    ctx = context(panel, run_id, scope, deadline)
    secrets = {i: seat_secrets(label, i, k) for i in seats}
    for i, s in secrets.items():
        if "seat" in cheat:
            cheat["seat"](i, s, secrets)
    d = {i: panel["secrets"][i - 1] for i in seats}

    r1 = []
    for i in sorted(seats):
        body = keys_body(ctx, secrets[i])
        r1.append({"index": i, "body": body, "sig": signed(1, ctx, i, body, d[i])})
    h1 = round_hash(ctx, 1, enc_round(r1))
    s1 = [m["index"] for m in r1]
    kem = {m["index"]: {"ek": m["body"][:1184], "dh": grp.decode(m["body"][1184:1216])} for m in r1}

    r2, dealt, randomness = [], {}, {}
    for dd in [i for i in s1 if i in seats and i not in cheat.get("skip2", [])]:
        s = secrets[dd]
        comm = [kn.add(kn.mul(s["f"][j], BG), kn.mul(s["g"][j], J)) for j in range(k)]
        assert all(c != BID for c in comm)
        hashes, randomness[dd] = [], []
        for t in [x for x in s1 if x != dd]:
            mu, e = s["rng"].bytes32(), s["rng"].ristretto_scalar()
            share, blind = poly(s["f"], t), poly(s["g"], t)
            plain = bjj_scalar(share) + bjj_scalar(blind)
            if "plain" in cheat:
                plain = cheat["plain"](dd, t, plain)
            aad_ctx = cheat["seal"](dd, t, ctx) if "seal" in cheat else ctx
            b, inter = seal_share(ctx, dd, t, kem[t], comm, plain, mu, e, aad_ctx)
            dealt[(dd, t)] = {"bytes": b, "inter": inter}
            randomness[dd].append({"recipient": t, "mu": mu.hex(), "e": str(e)})
            hashes.append(share_hash(b))
        body = enc_commitments(comm) + lst(hashes)
        r2.append({"index": dd, "body": body, "sig": signed(2, h1, dd, body, d[dd]), "commitments": comm})
    h2 = round_hash(h1, 2, enc_round(r2))
    s2 = [m["index"] for m in r2]

    r3 = []
    for i in [x for x in s1 if x in seats]:
        complaints = [dd for dd in s2 if dd != i and check_share(ctx, i, kem_secret(secrets[i]), r1, r2, dealt[(dd, i)]["bytes"])[0] in ("share-decrypt", "share-verify")]
        complaints += cheat.get("complain", {}).get(i, [])
        complaints = sorted(set(complaints))
        if not complaints:
            continue
        body = lst([u8(c) for c in complaints])
        r3.append({"index": i, "body": body, "sig": signed(3, h2, i, body, d[i]), "complaints": complaints})
    h3 = round_hash(h2, 3, enc_round(r3))

    r4 = []
    for dd in s2:
        complainers = [m["index"] for m in r3 if dd in m["complaints"]]
        if not complainers or dd in cheat.get("skip4", []):
            continue
        s = secrets[dd]
        reveals = []
        for c in complainers:
            share, blind = poly(s["f"], c), poly(s["g"], c)
            if "reveal" in cheat:
                share, blind = cheat["reveal"](dd, c, share, blind)
            reveals.append(u8(c) + bjj_scalar(share) + bjj_scalar(blind))
        body = lst(reveals)
        r4.append({"index": dd, "body": body, "sig": signed(4, h3, dd, body, d[dd])})

    rounds = [r1, r2, r3, r4]
    if "rounds" in cheat:
        rounds = cheat["rounds"](rounds, ctx, d)
    return {"runId": run_id, "deadline": deadline, "context": ctx, "rounds": rounds, "secrets": secrets, "dealt": dealt, "randomness": randomness}


def kem_secret(s):
    return {"dk": s["dk"], "x": s["x"], "dh": s["dh"]}


# --- Decoding --------------------------------------------------------------------------------


class DecodeFail(Exception):
    def __init__(self, code):
        self.code = code


class Reader:
    def __init__(self, b):
        self.b, self.o = b, 0

    def take(self, n):
        if self.o + n > len(self.b):
            raise DecodeFail("truncated")
        out = self.b[self.o : self.o + n]
        self.o += n
        return out

    def uint(self, n):
        return int.from_bytes(self.take(n), "big")


def read_element(r):
    b = r.take(32)
    p = grp.decode(b)
    if p is None or b == bytes(32):
        raise DecodeFail("non-canonical")
    return p


def read_bjj_point(r):
    p = kn.dec_point(r.take(64), False)
    if p is None:
        raise DecodeFail("non-canonical")
    return p


def read_bjj_scalar(r):
    v = kn.dec_scalar(r.take(32))
    if v is None:
        raise DecodeFail("non-canonical")
    return v


def read_p256_key(r):
    b = r.take(33)
    if ecdsa.decompress(b) is None:
        raise DecodeFail("non-canonical")
    return b


def read_sig(r):
    b = r.take(64)
    rr, ss = int.from_bytes(b[:32], "big"), int.from_bytes(b[32:], "big")
    if not (1 <= rr < ecdsa.N and 1 <= ss <= ecdsa.HALF_N):
        raise DecodeFail("non-canonical")
    return b


def read_list(r, max_, item):
    count = r.uint(4)
    if count > max_:
        raise DecodeFail("length-over-max")
    return [item(r) for _ in range(count)]


def read_keys_msg(r):
    start = r.o
    index = r.uint(1)
    ek = r.take(1184)
    if not se.ek_ok(ek):
        raise DecodeFail("non-canonical")
    dh = read_element(r)
    signing_key = read_p256_key(r)
    pop = read_sig(r)
    body = r.b[start + 1 : r.o]
    return {"index": index, "ek": ek, "dh": dh, "kemKey": ek + element(dh), "signingKey": signing_key, "pop": pop, "body": body, "sig": read_sig(r)}


def read_dealing_msg(r):
    start = r.o
    index = r.uint(1)
    comm = read_list(r, MAX_TRUSTEES, read_bjj_point)
    hashes = read_list(r, MAX_TRUSTEES - 1, lambda rr: rr.take(32))
    body = r.b[start + 1 : r.o]
    return {"index": index, "commitments": comm, "hashes": hashes, "body": body, "sig": read_sig(r)}


def read_complaints_msg(r):
    start = r.o
    index = r.uint(1)
    complaints = read_list(r, MAX_TRUSTEES - 1, lambda rr: rr.uint(1))
    body = r.b[start + 1 : r.o]
    return {"index": index, "complaints": complaints, "body": body, "sig": read_sig(r)}


def read_reveal(r):
    return {"complainer": r.uint(1), "share": read_bjj_scalar(r), "blind": read_bjj_scalar(r)}


def read_responses_msg(r):
    start = r.o
    index = r.uint(1)
    reveals = read_list(r, MAX_TRUSTEES - 1, read_reveal)
    body = r.b[start + 1 : r.o]
    return {"index": index, "reveals": reveals, "body": body, "sig": read_sig(r)}


def decode_transcript(b, pinned=VERSION):
    r = Reader(b)
    # In a vector file the known types are those it lists (notation.md): 0x0011 and 0x0012.
    t = r.uint(2)
    if t not in (TRANSCRIPT_TYPE, SHARE_TYPE):
        raise DecodeFail("unknown-record-type")
    if t != TRANSCRIPT_TYPE:
        raise DecodeFail("unexpected-record-type")
    if r.uint(1) != pinned:
        raise DecodeFail("profile-mismatch")
    run_id = r.take(32)
    deadline = r.uint(8) if pinned == 2 else None
    rounds = [
        read_list(r, MAX_TRUSTEES, read_keys_msg),
        read_list(r, MAX_TRUSTEES, read_dealing_msg),
        read_list(r, MAX_TRUSTEES, read_complaints_msg),
        read_list(r, MAX_TRUSTEES, read_responses_msg),
    ]
    if r.o != len(b):
        raise DecodeFail("trailing-bytes")
    return run_id, deadline, rounds


def decode_share(b):
    r = Reader(b)
    t = r.uint(2)
    if t not in (TRANSCRIPT_TYPE, SHARE_TYPE):
        raise DecodeFail("unknown-record-type")
    if t != SHARE_TYPE:
        raise DecodeFail("unexpected-record-type")
    if r.uint(1) != VERSION:
        raise DecodeFail("profile-mismatch")
    out = {"ctx": r.take(32), "dealer": r.uint(1), "recipient": r.uint(1), "ctM": r.take(CT_LEN), "ctDh": read_element(r), "sealed": r.take(SEALED_LEN)}
    if r.o != len(b):
        raise DecodeFail("trailing-bytes")
    return out


# --- The dealt-share check and the transcript check -------------------------------------------


def as_dealings(r1, r2):
    """Rounds 1 and 2 as a checker reads them, whether built here or decoded."""
    s1 = [m["index"] for m in r1]
    out = {}
    for m in r2:
        if "commitments" in m and "hashes" in m:
            out[m["index"]] = m
            continue
        rr = Reader(bytes([m["index"]]) + m["body"] + m["sig"])
        out[m["index"]] = read_dealing_msg(rr)
    return s1, out


def check_share(ctx, recipient, secret, r1, r2, b):
    """docs/spec/nullifier-key.md, Dealt-share check, in order: (code, dealer, share, blind)."""
    try:
        msg = decode_share(b)
    except DecodeFail:
        return ("share-malformed", None, None, None)
    s1, dealings = as_dealings(r1, r2)
    dd = msg["dealer"]
    if msg["ctx"] != ctx or msg["recipient"] != recipient or dd == recipient or dd not in dealings:
        return ("share-context", None, None, None)
    at = [x for x in s1 if x != dd].index(recipient) if recipient in s1 else None
    hashes = dealings[dd]["hashes"]
    if at is None or at >= len(hashes) or hashes[at] != share_hash(b):
        return ("share-hash", None, None, None)
    ss_m = se.decaps_internal(secret["dk"], msg["ctM"])
    k = combine(ss_m, se.pt_mul(secret["x"], msg["ctDh"]), msg["ctDh"], secret["dh"])
    pt = se.aead_open(k, NONCE, aad(ctx, dd, recipient, dealings[dd]["commitments"]), msg["sealed"])
    if pt is None or len(pt) != 64:
        return ("share-decrypt", dd, None, None)
    share, blind = kn.dec_scalar(pt[:32]), kn.dec_scalar(pt[32:])
    if share is None or blind is None:
        return ("share-decrypt", dd, None, None)
    if opening(share, blind) != commitment_at(dealings[dd]["commitments"], recipient):
        return ("share-verify", dd, None, None)
    return ("ok", dd, share, blind)


def check(panel, b, scope=SCOPE, pinned=VERSION):
    try:
        run_id, deadline, rounds = decode_transcript(b, pinned)
    except DecodeFail as e:
        return {"ok": False, "code": e.code}
    n, k = len(panel["keys"]), panel["k"]
    ctx = context(panel, run_id, scope, deadline)
    r1, r2, r3, r4 = rounds
    s1 = [m["index"] for m in r1]
    s2 = [m["index"] for m in r2]

    def increasing(xs):
        return all(1 <= x <= n for x in xs) and all(a < c for a, c in zip(xs, xs[1:]))

    def complainers(dd):
        return [m["index"] for m in r3 if dd in m["complaints"]]

    # 1. Order.
    if not all(increasing([m["index"] for m in rr]) for rr in rounds):
        return {"ok": False, "code": "key-order"}
    if not all(m["index"] in s1 for m in r2 + r3) or not all(m["index"] in s2 for m in r4):
        return {"ok": False, "code": "key-order"}
    # 2. Shape.
    for m in r2:
        if len(m["commitments"]) != k or len(m["hashes"]) != len([x for x in s1 if x != m["index"]]):
            return {"ok": False, "code": "key-shape"}
    for m in r3:
        c = m["complaints"]
        if not c or not increasing(c) or any(x == m["index"] or x not in s2 for x in c):
            return {"ok": False, "code": "key-shape"}
    for m in r4:
        want = complainers(m["index"])
        if not want or [x["complainer"] for x in m["reveals"]] != want:
            return {"ok": False, "code": "key-shape"}
    # 3. Signatures, each over the hash of the rounds before its own.
    h = [ctx]
    for rnum in (1, 2, 3):
        h.append(round_hash(h[-1], rnum, enc_round(rounds[rnum - 1])))
    for rnum, rr in enumerate(rounds, start=1):
        for m in rr:
            if not verify(panel["keys"][m["index"] - 1], MESSAGE_TAG, u8(rnum) + h[rnum - 1] + u8(m["index"]) + m["body"], m["sig"]):
                return {"ok": False, "code": "key-signature"}
    # 4. Seats.
    keys = {m["index"]: m for m in r1}
    passing = [m["index"] for m in r1 if verify(m["signingKey"], SIGNING_KEY_TAG, ctx + u8(m["index"]) + m["kemKey"] + m["signingKey"], m["pop"])]
    sks = [keys[i]["signingKey"] for i in passing]
    dealings = {m["index"]: m for m in r2}
    responses = {m["index"]: m for m in r4}
    seats = []
    for i in range(1, n + 1):
        reasons = []
        if i not in keys:
            seats.append({"index": i, "reasons": ["absent"]})
            continue
        if i not in passing:
            reasons.append("possession")
        elif sks.count(keys[i]["signingKey"]) > 1 or keys[i]["signingKey"] in panel["keys"]:
            reasons.append("duplicate-key")
        if i not in dealings:
            reasons.append("no-dealing")
        elif complainers(i):
            if i not in responses:
                reasons.append("unanswered")
            elif any(opening(x["share"], x["blind"]) != commitment_at(dealings[i]["commitments"], x["complainer"]) for x in responses[i]["reveals"]):
                reasons.append("bad-reveal")
        seats.append({"index": i, "reasons": reasons})
    # The qualified dealers; a dealer whose own share commitment is the identity holds nothing.
    dealers = [s["index"] for s in seats if not s["reasons"]]
    commitments = {}
    for i in dealers:
        c = BID
        for dd in dealers:
            c = kn.add(c, commitment_at(dealings[dd]["commitments"], i))
        if c == BID:
            next(s for s in seats if s["index"] == i)["reasons"].append("identity-commitment")
        else:
            commitments[i] = c
    qualified = [i for i in dealers if i in commitments]
    # 5. Quorum.
    if len(qualified) < k:
        return {"ok": False, "code": "key-quorum", "seats": seats}
    out = {"ok": True, "keyId": H(ds(KEY_TAG, b)).hex()}
    if deadline is not None:
        out["deadline"] = str(deadline)
    return {
        **out,
        "seats": seats,
        "dealers": dealers,
        "qualified": [
            {"index": i, "kemKey": keys[i]["kemKey"].hex(), "signingKey": keys[i]["signingKey"].hex(), "commitment": kn.enc_point(commitments[i]).hex()}
            for i in qualified
        ],
    }


def seat_shares(result, r):
    """Each qualified seat's share, from its secrets, the dealt shares and the reveals, checked against C_i."""
    qualified = [q["index"] for q in result["qualified"]]
    dealers = result["dealers"]
    r1, r2, _, r4 = r["rounds"]
    reveals = {}
    for m in r4:
        rv = read_list(Reader(m["body"]), MAX_TRUSTEES - 1, read_reveal)
        for x in rv:
            reveals[(m["index"], x["complainer"])] = (x["share"], x["blind"])
    out = []
    for i in qualified:
        sk = s = 0
        for dd in dealers:
            if dd == i:
                v = (poly(r["secrets"][i]["f"], i), poly(r["secrets"][i]["g"], i))
            elif (dd, i) in reveals:
                v = reveals[(dd, i)]
            else:
                code, _, share, blind = check_share(r["context"], i, kem_secret(r["secrets"][i]), r1, r2, r["dealt"][(dd, i)]["bytes"])
                assert code == "ok", (dd, i, code)
                v = (share, blind)
            sk, s = (sk + v[0]) % BL, (s + v[1]) % BL
        c = next(q for q in result["qualified"] if q["index"] == i)["commitment"]
        assert kn.enc_point(opening(sk, s)).hex() == c and sk != 0
        out.append({"index": i, "sk": str(sk), "s": str(s)})
    return out


# --- Vectors -------------------------------------------------------------------------------------


def resign(m, round_, prev, d):
    return {**m, "sig": signed(round_, prev, m["index"], m["body"], d)}


def approval_message(panel, index, key_id, scope=SCOPE):
    return u64(scope["l2ChainId"]) + scope["groupRegistry"] + panel_id(panel["k"], panel["keys"]) + u8(index) + key_id


J = None


def main(out):
    global J
    kn.self_check()
    grp.self_check()
    se.mlkem_self_check(100)
    se.aead_self_check()
    J, _ = kn.derive_j()

    panels = {
        "panel-5": make_panel("panel-5", 3, 5),
        "panel-2": make_panel("panel-2", 2, 2),
    }
    vectors, shares_checks = [], []
    runs = {}

    def add(id_, desc, panel_name, seats, cheat=None, honest=False, expect=None, mutate=None):
        panel = panels[panel_name]
        r = run(id_, panel, seats, cheat)
        b = enc_transcript(r["runId"], r["rounds"])
        if mutate is not None:
            b = mutate(b, r)
        result = check(panel, b)
        got = result["code"] if not result["ok"] else [(s["index"], s["reasons"]) for s in result["seats"] if s["reasons"]]
        if expect is not None:
            assert got == expect, (id_, got, expect)
        v = {"id": id_, "description": desc, "panel": panel_name, "transcript": b.hex(), "result": result}
        if result["ok"] and mutate is None and "rounds" not in (cheat or {}):
            v["shares"] = seat_shares(result, r)
        if honest:
            v["runId"] = r["runId"].hex()
            v["context"] = r["context"].hex()
            v["seats"] = [
                {
                    "index": i,
                    "kemSeed": s["seed"].hex(),
                    "kemX": str(s["x"]),
                    "signingSecret": f"{s['signing']:064x}",
                    "f": [str(x) for x in s["f"]],
                    "g": [str(x) for x in s["g"]],
                    "shareRandomness": r["randomness"].get(i, []),
                    "dealtShares": [
                        {"recipient": t, "bytes": dl["bytes"].hex(), "hash": share_hash(dl["bytes"]).hex(), **dl["inter"]}
                        for (dd, t), dl in sorted(r["dealt"].items())
                        if dd == i
                    ],
                }
                for i, s in sorted(r["secrets"].items())
            ]
        vectors.append(v)
        runs[id_] = r
        return r

    # Honest runs, reproduced byte for byte by packages/crypto.
    add("honest-5", "Every seat of a 3-of-5 panel takes part honestly; all five qualify.", "panel-5", [1, 2, 3, 4, 5], honest=True, expect=[])
    add("honest-2", "The smallest panel, 2-of-2.", "panel-2", [1, 2], honest=True, expect=[])
    add("absent", "Seat 5 sends nothing; the other four qualify.", "panel-5", [1, 2, 3, 4], honest=True, expect=[(5, ["absent"])])

    # Complaints.
    def bad_share_to_3(dd, t, plain):
        if (dd, t) != (2, 3):
            return plain
        share = int.from_bytes(plain[:32], "big")
        return bjj_scalar((share + 1) % BL) + plain[32:]

    def bad_seal_to_4(dd, t, ctx):
        # Sealed under another run's context in the AEAD's associated data: it doesn't open for seat 4.
        return H(b"another run") if (dd, t) == (2, 4) else ctx

    add(
        "complaint-answered",
        "Dealer 2 seals a wrong share to seat 3 (share-verify) and one that doesn't open to seat 4 (share-decrypt), and signs both hashes; seats 3 and 4 complain and dealer 2 reveals both shares correctly, so it stays qualified.",
        "panel-5",
        [1, 2, 3, 4, 5],
        {"plain": bad_share_to_3, "seal": bad_seal_to_4},
        honest=True,
        expect=[],
    )

    def wrong_reveal(dd, c, share, blind):
        return ((share + 1) % BL, blind) if (dd, c) == (2, 3) else (share, blind)

    add("bad-reveal", "As complaint-answered, but dealer 2 reveals a wrong share for seat 3.", "panel-5", [1, 2, 3, 4, 5], {"plain": bad_share_to_3, "seal": bad_seal_to_4, "reveal": wrong_reveal}, expect=[(2, ["bad-reveal"])])
    add("unanswered", "As complaint-answered, but dealer 2 sends no round-4 message.", "panel-5", [1, 2, 3, 4, 5], {"plain": bad_share_to_3, "seal": bad_seal_to_4, "skip4": [2]}, expect=[(2, ["unanswered"])])
    add(
        "corrupt-complaint",
        "Seat 4 complains about honest dealer 1 without cause: dealer 1 reveals seat 4's own share, which checks, and everyone qualifies.",
        "panel-5",
        [1, 2, 3, 4, 5],
        {"complain": {4: [1]}},
        expect=[],
    )
    add("no-dealing", "Seat 3 registers keys but deals nothing; it holds no share.", "panel-5", [1, 2, 3, 4, 5], {"skip2": [3]}, honest=True, expect=[(3, ["no-dealing"])])

    def zero_own_share(i, s, all_):
        # Seat 5 picks its polynomials after seeing the others' shares to it
        # (rushing), so that its own share, and so C_5, is the identity. Its
        # dealing is honest and stays qualified; only seat 5 holds nothing.
        if i != 5:
            return
        for name in ("f", "g"):
            others = sum(poly(all_[d][name], 5) for d in all_ if d != 5) % BL
            rest = sum(c * pow(5, j, BL) for j, c in enumerate(s[name]) if j > 0) % BL
            s[name][0] = (-others - rest) % BL

    add(
        "identity-commitment",
        "Seat 5 chooses its polynomials, after seeing every other seat's share to it, so that its own share and C_5 are the identity; its dealing counts, but it holds no share.",
        "panel-5",
        [1, 2, 3, 4, 5],
        {"seat": zero_own_share},
        honest=True,
        expect=[(5, ["identity-commitment"])],
    )

    def other_pop(i, s, all_):
        if i == 3:
            s["popSigner"] = all_[1]["signing"]

    add("possession", "Seat 3's signing-key signature is made by seat 1's signing key.", "panel-5", [1, 2, 3, 4, 5], {"seat": other_pop}, expect=[(3, ["possession"])])

    def shared_signing(i, s, all_):
        if i == 3:
            s["signing"] = all_[2]["signing"]

    add("duplicate-signing-key", "Seats 2 and 3 register the same signing key, each with a valid proof: both are excluded.", "panel-5", [1, 2, 3, 4, 5], {"seat": shared_signing}, expect=[(2, ["duplicate-key"]), (3, ["duplicate-key"])])

    def own_identity(i, s, all_):
        if i == 1:
            s["signing"] = panels["panel-5"]["secrets"][0]

    add("signing-is-identity", "Seat 1 registers its own identity key as its registration signing key.", "panel-5", [1, 2, 3, 4, 5], {"seat": own_identity}, expect=[(1, ["duplicate-key"])])
    add("quorum", "Only seats 1 and 2 take part: two qualified seats, below k = 3.", "panel-5", [1, 2], expect="key-quorum")

    # Transcript-level failures.
    def swap_round1(rounds, ctx, d):
        r1 = rounds[0]
        return [[r1[1], r1[0]] + r1[2:]] + rounds[1:]

    add("order-keys", "Round 1 lists seat 2 before seat 1.", "panel-5", [1, 2, 3, 4, 5], {"rounds": swap_round1}, expect="key-order")

    def response_without_dealing(rounds, ctx, d):
        r1, r2, r3, r4 = rounds
        return [r1, [m for m in r2 if m["index"] != 2], r3, r4]

    add("order-responses", "Dealer 2's round-2 message is dropped after the fact, but its round-4 response stays.", "panel-5", [1, 2, 3, 4, 5], {"plain": bad_share_to_3, "seal": bad_seal_to_4, "rounds": response_without_dealing}, expect="key-order")

    def short_commitments(rounds, ctx, d):
        r1, r2, r3, r4 = rounds
        h1 = round_hash(ctx, 1, enc_round(r1))
        m = r2[0]
        comm = read_list(Reader(m["body"]), MAX_TRUSTEES, read_bjj_point)
        body = enc_commitments(comm[:-1]) + m["body"][4 + 64 * len(comm) :]
        return [r1, [resign({**m, "body": body}, 2, h1, d[m["index"]])] + r2[1:], r3, r4]

    add("shape-commitments", "Dealer 1 commits to k − 1 coefficients (signed as sent).", "panel-5", [1, 2, 3, 4, 5], {"rounds": short_commitments}, expect="key-shape")

    def self_complaint(rounds, ctx, d):
        r1, r2, r3, r4 = rounds
        h2 = round_hash(round_hash(ctx, 1, enc_round(r1)), 2, enc_round(r2))
        body = lst([u8(4)])
        return [r1, r2, [{"index": 4, "body": body, "sig": signed(3, h2, 4, body, d[4])}], r4]

    add("shape-complaint", "Seat 4 complains about itself.", "panel-5", [1, 2, 3, 4, 5], {"rounds": self_complaint}, expect="key-shape")

    def unasked_response(rounds, ctx, d):
        r1, r2, r3, r4 = rounds
        h3 = round_hash(round_hash(round_hash(ctx, 1, enc_round(r1)), 2, enc_round(r2)), 3, enc_round(r3))
        s = runs_secrets["shape-response"][1]
        body = lst([u8(5) + bjj_scalar(poly(s["f"], 5)) + bjj_scalar(poly(s["g"], 5))])
        return [r1, r2, r3, [{"index": 1, "body": body, "sig": signed(4, h3, 1, body, d[1])}]]

    runs_secrets = {"shape-response": {1: seat_secrets("shape-response", 1, 3)}}
    add("shape-response", "Dealer 1 publishes seat 5's share though no one complained.", "panel-5", [1, 2, 3, 4, 5], {"rounds": unasked_response}, expect="key-shape")

    def complaint_from_absent(rounds, ctx, d):
        r1, r2, r3, r4 = rounds
        h2 = round_hash(round_hash(ctx, 1, enc_round(r1)), 2, enc_round(r2))
        body = lst([u8(1)])
        sk5 = panels["panel-5"]["secrets"][4]
        return [r1, r2, r3 + [{"index": 5, "body": body, "sig": signed(3, h2, 5, body, sk5)}], r4]

    add("order-complaint", "Seat 5, absent from round 1, complains about dealer 1 in round 3.", "panel-5", [1, 2, 3, 4], {"rounds": complaint_from_absent}, expect="key-order")

    def complaint_signed_early(rounds, ctx, d):
        r1, r2, r3, r4 = rounds
        h1 = round_hash(ctx, 1, enc_round(r1))
        return [r1, r2, [resign(m, 3, h1, d[m["index"]]) if m["index"] == 3 else m for m in r3], r4]

    add("signature-complaint", "As complaint-answered, but seat 3 signs its complaint over h_1 instead of h_2.", "panel-5", [1, 2, 3, 4, 5], {"plain": bad_share_to_3, "seal": bad_seal_to_4, "rounds": complaint_signed_early}, expect="key-signature")

    def response_signed_early(rounds, ctx, d):
        r1, r2, r3, r4 = rounds
        h2 = round_hash(round_hash(ctx, 1, enc_round(r1)), 2, enc_round(r2))
        return [r1, r2, r3, [resign(m, 4, h2, d[m["index"]]) for m in r4]]

    add("signature-response", "As complaint-answered, but dealer 2 signs its response over h_2 instead of h_3.", "panel-5", [1, 2, 3, 4, 5], {"plain": bad_share_to_3, "seal": bad_seal_to_4, "rounds": response_signed_early}, expect="key-signature")

    def equivocate(rounds, ctx, d):
        other = keys_body(ctx, seat_secrets("equivocation", 1, 3))
        r1 = [resign({**m, "body": other}, 1, ctx, d[1]) if m["index"] == 1 else m for m in rounds[0]]
        return [r1] + rounds[1:]

    add("signature-chain", "Seat 1's round-1 message is swapped for another it also signed; every later message signed over the round 1 it replaced.", "panel-5", [1, 2, 3, 4, 5], {"rounds": equivocate}, expect="key-signature")

    def wrong_run(b, r):
        return b[:3] + bytes(32) + b[35:]

    add("signature-run", "The run identifier is changed: every message was signed under the original context.", "panel-5", [1, 2, 3, 4, 5], expect="key-signature", mutate=wrong_run)

    # Dealt-share checks, as seat `recipient` of a run sees them.
    def share_check(id_, desc, run_id, recipient, b, want):
        r = runs[run_id]
        code, dealer, share, blind = check_share(r["context"], recipient, kem_secret(r["secrets"][recipient]), r["rounds"][0], r["rounds"][1], b)
        assert code == want, (id_, code, want)
        entry = {"id": id_, "description": desc, "run": run_id, "recipient": recipient, "bytes": b.hex(), "result": code}
        if dealer is not None:
            entry["dealer"] = dealer
        if code == "ok":
            entry["share"], entry["blind"] = str(share), str(blind)
        shares_checks.append(entry)

    good = runs["honest-5"]["dealt"][(1, 2)]["bytes"]

    def relabel(b, recipient):
        # The recipient byte follows the header, key_context and dealer.
        return b[:36] + u8(recipient) + b[37:]

    share_check("ok", "Dealer 1's share for seat 2.", "honest-5", 2, good, "ok")
    share_check("malformed-truncated", "Dealer 1's share for seat 2 without its last byte.", "honest-5", 2, good[:-1], "share-malformed")
    share_check("malformed-version", "Version 2.", "honest-5", 2, good[:2] + u8(2) + good[3:], "share-malformed")
    share_check("malformed-dh-identity", "ct_DH is the identity.", "honest-5", 2, good[:3 + 32 + 2 + CT_LEN] + bytes(32) + good[3 + 32 + 2 + CT_LEN + 32 :], "share-malformed")
    share_check("context-recipient", "Dealer 1's share for seat 2, checked by seat 3.", "honest-5", 3, good, "share-context")
    share_check("context-run", "Dealer 1's share for seat 2 of another run (absent), checked in honest-5.", "honest-5", 2, runs["absent"]["dealt"][(1, 2)]["bytes"], "share-context")
    share_check("hash", "Dealer 1's share for seat 3, relabelled as for seat 2: its hash isn't the one dealer 1 signed for seat 2.", "honest-5", 2, relabel(runs["honest-5"]["dealt"][(1, 3)]["bytes"], 2), "share-hash")
    def relabel_dealer(b, dealer):
        # The dealer byte follows the header and key_context.
        return b[:35] + u8(dealer) + b[36:]

    share_check("context-own", "Dealer 1's share for seat 2, relabelled as dealt by seat 2 itself.", "honest-5", 2, relabel_dealer(good, 2), "share-context")
    share_check(
        "context-no-dealing",
        "Dealer 1's share for seat 2 of no-dealing, relabelled as dealt by seat 3, which dealt nothing.",
        "no-dealing",
        2,
        relabel_dealer(runs["no-dealing"]["dealt"][(1, 2)]["bytes"], 3),
        "share-context",
    )
    flipped = bytearray(good)
    flipped[-1] ^= 1
    share_check("hash-flipped", "A tag byte of dealer 1's share for seat 2 flipped.", "honest-5", 2, bytes(flipped), "share-hash")
    share_check("decrypt", "Dealer 2's share for seat 4, sealed under another context and signed.", "complaint-answered", 4, runs["complaint-answered"]["dealt"][(2, 4)]["bytes"], "share-decrypt")
    share_check("verify", "Dealer 2's wrong share for seat 3, sealed correctly and signed.", "complaint-answered", 3, runs["complaint-answered"]["dealt"][(2, 3)]["bytes"], "share-verify")

    # Approvals of honest-5's key by every seat, and two that don't count.
    panel = panels["panel-5"]
    honest = next(v for v in vectors if v["id"] == "honest-5")
    key_id = bytes.fromhex(honest["result"]["keyId"])
    approvals = []
    for i in range(1, 6):
        m = approval_message(panel, i, key_id)
        assert len(m) == 93
        approvals.append({"index": i, "message": m.hex(), "signature": sign(panel["secrets"][i - 1], APPROVAL_TAG, m).hex()})
    other_key = H(b"another key")
    extra = [
        {"id": "other-key", "description": "Seat 1's approval of another key", "index": 1, "signature": sign(panel["secrets"][0], APPROVAL_TAG, approval_message(panel, 1, other_key)).hex(), "counts": False},
        {"id": "other-seat", "description": "Seat 2's signature presented as seat 3's", "index": 3, "signature": approvals[1]["signature"], "counts": False},
    ]

    # Decoding.
    base = bytes.fromhex(next(v for v in vectors if v["id"] == "honest-2")["transcript"])
    decode = []

    def dec(id_, desc, b):
        res = check(panels["panel-2"], b)
        assert not res["ok"], id_
        decode.append({"id": id_, "description": desc, "transcript": b.hex(), "error": res["code"]})

    dec("truncated", "The honest 2-of-2 transcript without its last byte.", base[:-1])
    dec("trailing", "The honest 2-of-2 transcript with one more byte.", base + b"\x00")
    dec("version-2", "Version 2 where version 1 is pinned.", base[:2] + u8(2) + base[3:])
    dec("record-type", "Record type 0x0012, the dealt share, where a transcript is expected.", u16(0x0012) + base[2:])
    dec("unknown-type", "Record type 0x0013, which this file doesn't list.", u16(0x0013) + base[2:])
    dec("keys-over-max", "Round 1 claims 17 messages.", base[:35] + u32(17) + base[39:])
    at_ek = 35 + 4 + 1
    dec("ek-modulus", "Seat 1's ek fails FIPS 203's modulus check (first coefficient 4095).", base[:at_ek] + b"\xff\x0f" + base[at_ek + 2 :])
    at_dh = at_ek + 1184
    dec("dh-identity", "Seat 1's DH key is the identity.", base[:at_dh] + bytes(32) + base[at_dh + 32 :])
    at_sk = at_dh + 32
    dec("signing-key-uncompressed", "Seat 1's signing key starts 0x04.", base[:at_sk] + b"\x04" + base[at_sk + 1 :])
    at_sig = at_sk + 33 + 64
    dec("signature-high-s", "Seat 1's signature has s > (n − 1) / 2.", base[:at_sig + 32] + (ecdsa.N - 1).to_bytes(32, "big") + base[at_sig + 64 :])
    r1_len = 4 + 2 * (1 + 1216 + 33 + 64 + 64)
    at_c = 35 + r1_len + 4 + 1 + 4
    dec("commitment-identity", "Dealer 1's first coefficient commitment is the identity.", base[:at_c] + kn.enc_point(BID) + base[at_c + 64 :])
    dec("commitment-off-curve", "Dealer 1's first coefficient commitment is (0, 2), off the curve.", base[:at_c] + bytes(32) + (2).to_bytes(32, "big") + base[at_c + 64 :])
    order2 = (0, kn.P - 1)
    dec("commitment-small-order", "Dealer 1's first coefficient commitment has order 2.", base[:at_c] + kn.enc_point(order2) + base[at_c + 64 :])

    # Version 2: the same rounds with the run's deadline in the context and the transcript.
    v2_vectors = []

    def add_v2(id_, desc, seats, honest=False, expect=None, mutate=None, signed_as_v1=False):
        panel = panels["panel-5"]
        # signed_as_v1: every message signed under the version-1 context of the same run.
        r = run(f"v2/{id_}", panel, seats, deadline=None if signed_as_v1 else DEADLINE)
        b = enc_transcript(r["runId"], r["rounds"], version=2, deadline=DEADLINE)
        if mutate is not None:
            b = mutate(b)
        result = check(panel, b, pinned=2)
        got = result["code"] if not result["ok"] else [(x["index"], x["reasons"]) for x in result["seats"] if x["reasons"]]
        assert got == expect, (id_, got, expect)
        v = {"id": id_, "description": desc, "panel": "panel-5", "transcript": b.hex(), "result": result}
        if result["ok"]:
            v["shares"] = seat_shares(result, r)
        if honest:
            v["runId"] = r["runId"].hex()
            v["deadline"] = str(DEADLINE)
            v["context"] = r["context"].hex()
            v["seats"] = [
                {
                    "index": i,
                    "kemSeed": x["seed"].hex(),
                    "kemX": str(x["x"]),
                    "signingSecret": f"{x['signing']:064x}",
                    "f": [str(c) for c in x["f"]],
                    "g": [str(c) for c in x["g"]],
                    "shareRandomness": r["randomness"].get(i, []),
                    "dealtShares": [
                        {"recipient": t, "bytes": dl["bytes"].hex(), "hash": share_hash(dl["bytes"]).hex(), **dl["inter"]}
                        for (dd, t), dl in sorted(r["dealt"].items())
                        if dd == i
                    ],
                }
                for i, x in sorted(r["secrets"].items())
            ]
        v2_vectors.append(v)
        return b

    v2_honest = add_v2("honest-5", "Every seat of the 3-of-5 panel takes part honestly in a version-2 run; all five qualify.", [1, 2, 3, 4, 5], honest=True, expect=[])
    add_v2("absent", "Seat 5 sends nothing in a version-2 run; the other four qualify.", [1, 2, 3, 4], expect=[(5, ["absent"])])
    add_v2("quorum", "Only seats 1 and 2 take part: two qualified seats, below k = 3.", [1, 2], expect="key-quorum")

    def other_deadline(b):
        # The deadline follows the header and run_id.
        return b[:35] + u64(DEADLINE + 1) + b[43:]

    add_v2("signature-deadline", "The deadline is changed: every message was signed under the original deadline's context.", [1, 2, 3, 4, 5], expect="key-signature", mutate=other_deadline)
    add_v2(
        "signature-version-1",
        "Every message was signed under the version-1 context of the same run, without the deadline, and the rounds are framed as a version-2 transcript.",
        [1, 2, 3, 4, 5],
        expect="key-signature",
        signed_as_v1=True,
    )

    v2_key = bytes.fromhex(v2_vectors[0]["result"]["keyId"])
    v2_approvals = []
    for i in range(1, 6):
        m = approval_message(panel, i, v2_key)
        v2_approvals.append({"index": i, "message": m.hex(), "signature": sign(panel["secrets"][i - 1], APPROVAL_TAG_2, m).hex()})
    v2_extra = [
        {"id": "version-1-statement", "description": "Seat 1's approval of this key under version 1's statement", "index": 1, "signature": sign(panel["secrets"][0], APPROVAL_TAG, approval_message(panel, 1, v2_key)).hex(), "counts": False},
        {"id": "other-key", "description": "Seat 2's version-2 approval of another key", "index": 2, "signature": sign(panel["secrets"][1], APPROVAL_TAG_2, approval_message(panel, 2, other_key)).hex(), "counts": False},
    ]
    assert not any(verify(panel["keys"][e["index"] - 1], APPROVAL_TAG_2, approval_message(panel, e["index"], v2_key), bytes.fromhex(e["signature"])) for e in v2_extra)

    v2_decode = []

    def dec2(id_, desc, b, pinned):
        res = check(panels["panel-5"], b, pinned=pinned)
        assert not res["ok"], id_
        v2_decode.append({"id": id_, "description": desc, "pinned": pinned, "transcript": b.hex(), "error": res["code"]})

    dec2("truncated", "The honest version-2 transcript without its last byte.", v2_honest[:-1], 2)
    dec2("trailing", "The honest version-2 transcript with one more byte.", v2_honest + b"\x00", 2)
    dec2("pinned-1", "The honest version-2 transcript where version 1 is pinned.", v2_honest, 1)
    honest5 = bytes.fromhex(next(v for v in vectors if v["id"] == "honest-5")["transcript"])
    dec2("version-1", "The honest version-1 transcript where version 2 is pinned.", honest5, 2)
    dec2("deadline-truncated", "A version-2 header and run_id followed by four of the deadline's eight bytes.", v2_honest[:39], 2)

    doc = {
        "format": "abolish-nullifier-key-vectors/1",
        "title": "Tier 2 nullifier key: transcripts, dealt shares, their checks, key_id and approvals",
        "spec": "docs/spec/nullifier-key.md",
        "generator": "packages/crypto/scripts/nullifier-key-vectors.py: an independent Python implementation (standard library only), with keyed-nullifier-vectors.py's Baby Jubjub (checked against EIP-2494 and RFC 9380 Appendix K.1 first), share-encryption-vectors.py's ML-KEM-768 and ChaCha20-Poly1305 (checked against Go's accumulated FIPS 203 vectors and RFC 8439 first) and ristretto255, and trustee-vectors.py's P-256 ECDSA, which reproduces RFC 6979 Appendix A.2.5 first. Every value is test data, never keys",
        "tags": {t.decode(): t.decode() for t in [CONTEXT_TAG, ROUND_TAG, KEY_TAG, SHARE_HASH_TAG, KEM_TAG, AAD_TAG, MESSAGE_TAG, SIGNING_KEY_TAG, APPROVAL_TAG, CONTEXT_TAG_2, APPROVAL_TAG_2]},
        "recordTypes": {"transcript": TRANSCRIPT_TYPE, "dealtShare": SHARE_TYPE},
        "scope": {"l2ChainId": str(SCOPE["l2ChainId"]), "groupRegistry": SCOPE["groupRegistry"].hex()},
        "generatorJ": kn.enc_point(J).hex(),
        "panels": {
            name: {"threshold": p["k"], "identitySecrets": [f"{d:064x}" for d in p["secrets"]], "keys": [k.hex() for k in p["keys"]]}
            for name, p in panels.items()
        },
        "transcripts": vectors,
        "dealtShareChecks": shares_checks,
        "approvals": {"panel": "panel-5", "keyId": key_id.hex(), "approvals": approvals, "notCounted": extra},
        "decode": decode,
        "version2": {
            "description": "Transcript version 2: the run's deadline in the context and after run_id, and approvals under abolish/v1/sig/nullifier-key-approval-2; the rounds, dealt shares and checks are version 1's.",
            "transcripts": v2_vectors,
            "approvals": {"panel": "panel-5", "keyId": v2_key.hex(), "approvals": v2_approvals, "notCounted": v2_extra},
            "decode": v2_decode,
        },
    }
    pathlib.Path(out, "nullifier-key.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
