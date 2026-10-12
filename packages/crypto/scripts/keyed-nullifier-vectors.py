#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/keyed-nullifier.json.

A second implementation of docs/spec/keyed-nullifier.md: Baby Jubjub's
prime-order subgroup (EIP-2494) and its bjj-scalar and bjj-point encodings,
HashToScalarBJJ (RFC 9380 hash_to_field over SHA-256's expand_message_xmd),
the generator J, share commitments, a seat's evaluation and its proof, the
answer record (0x0010, version 1) with its signature, the answer check, and
the combination and unblinding. It is written from the spec and from EIP-2494
and RFC 9380 with Python's integers and hashlib; it checks its curve against
EIP-2494's generator and base point and its expand_message_xmd against RFC 9380
Appendix K.1 first. Signatures come from trustee-vectors.py's P-256 ECDSA,
which reproduces RFC 6979 Appendix A.2.5 first. Nothing here shares code with
packages/crypto or any @noble library.

Every secret comes from SHA-256 over a fixed label, and each vector lists the
secrets and nonces that made it, so any implementation reproduces its bytes.
The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/keyed-nullifier-vectors.py <out-dir>
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


ecdsa = _load("trustee_vectors", "trustee-vectors.py")

# --- Baby Jubjub (EIP-2494) --------------------------------------------------------

P = 21888242871839275222246405745257275088548364400416034343698204186575808495617
L = 2736030358979909402780800718157159386076813972158567259200215660948447373041
A = 168700
D = 168696
ID = (0, 1)
# EIP-2494's generator of the whole group, and its base point B8 = 8 * G_EIP.
G_EIP = (
    995203441582195749578291179787384436505546430278305826713579947235728471134,
    5472060717959818805561601436314318772137091100104008585924551046643952123905,
)
B8 = (
    5299619240641551281634865583518297030282874472190772894086521144482721001553,
    16950150798460657717958625567821834550301663161624707787222815936182638968203,
)
G = B8

J_TAG = b"abolish/v1/keyed-nullifier/generator-j"
FS_TAG = b"abolish/v1/fs/keyed-nullifier/evaluation"
SIG_TAG = b"abolish/v1/sig/nullifier-answer"
RECORD_TYPE = 0x0010
VERSION = 1


def inv(v, m):
    return pow(v, -1, m)


def on_curve(pt):
    x, y = pt
    return (A * x * x + y * y - 1 - D * x * x * y * y) % P == 0


def add(p1, p2):
    # The twisted Edwards addition law, complete on Baby Jubjub (a square, d not).
    x1, y1 = p1
    x2, y2 = p2
    t = D * x1 * x2 * y1 * y2 % P
    x3 = (x1 * y2 + y1 * x2) * inv((1 + t) % P, P) % P
    y3 = (y1 * y2 - A * x1 * x2) * inv((1 - t) % P, P) % P
    return (x3, y3)


def neg(pt):
    return ((-pt[0]) % P, pt[1])


def mul(k, pt):
    out = ID
    while k:
        if k & 1:
            out = add(out, pt)
        pt = add(pt, pt)
        k >>= 1
    return out


def in_subgroup(pt):
    return mul(L, pt) == ID


def is_square(v):
    return v % P == 0 or pow(v, (P - 1) // 2, P) == 1


def sqrt(v):
    """Tonelli-Shanks: a square root of a square v mod P."""
    v %= P
    if v == 0:
        return 0
    q, s = P - 1, 0
    while q % 2 == 0:
        q //= 2
        s += 1
    z = 2
    while is_square(z):
        z += 1
    m, c, t, r = s, pow(z, q, P), pow(v, q, P), pow(v, (q + 1) // 2, P)
    while t != 1:
        i, t2 = 0, t
        while t2 != 1:
            t2 = t2 * t2 % P
            i += 1
        b = pow(c, 1 << (m - i - 1), P)
        m, c, t, r = i, b * b % P, t * b * b % P, r * b % P
    assert r * r % P == v
    return r


def enc_point(pt):
    return pt[0].to_bytes(32, "big") + pt[1].to_bytes(32, "big")


def enc_scalar(v):
    assert 0 <= v < L
    return v.to_bytes(32, "big")


def dec_scalar(b):
    v = int.from_bytes(b, "big")
    return v if v < L else None


def dec_point(b, identity=False):
    """The spec's bjj-point decoding: None for every rejected input."""
    x, y = int.from_bytes(b[:32], "big"), int.from_bytes(b[32:], "big")
    if x >= P or y >= P or not on_curve((x, y)) or not in_subgroup((x, y)):
        return None
    if (x, y) == ID and not identity:
        return None
    return (x, y)


# --- Hashes ------------------------------------------------------------------------


def sha256(b):
    return hashlib.sha256(b).digest()


def ds(tag, m):
    return bytes([len(tag)]) + tag + m


def expand_message_xmd(msg, dst, n):
    """RFC 9380 §5.3.1 over SHA-256 (b_in_bytes 32, s_in_bytes 64)."""
    assert len(dst) <= 255
    ell = -(-n // 32)
    assert ell <= 255 and n <= 65535
    dst_prime = dst + bytes([len(dst)])
    b0 = sha256(bytes(64) + msg + n.to_bytes(2, "big") + b"\x00" + dst_prime)
    b = [sha256(b0 + b"\x01" + dst_prime)]
    for i in range(2, ell + 1):
        b.append(sha256(bytes(x ^ y for x, y in zip(b0, b[-1])) + bytes([i]) + dst_prime))
    return b"".join(b)[:n]


def hash_to_scalar(msg, dst):
    """HashToScalarBJJ: RFC 9380 hash_to_field over F_l, m = 1, k = 128, so L = 48."""
    uniform = expand_message_xmd(msg, dst, 48)
    return uniform, int.from_bytes(uniform, "big") % L


# --- The generator J ---------------------------------------------------------------


def derive_j():
    steps = []
    for ctr in range(256):
        digest = sha256(ds(J_TAG, bytes([ctr])))
        y = int.from_bytes(digest, "big") % P
        u = (1 - y * y) % P
        v = (A - D * y * y) % P
        step = {"ctr": ctr, "digest": digest.hex(), "y": str(y)}
        if v == 0 or not is_square(u * inv(v, P)):
            step["square"] = False
            steps.append(step)
            continue
        x = sqrt(u * inv(v, P))
        if x % 2:
            x = P - x
        pt = mul(8, (x, y))
        step.update({"square": True, "x": str(x), "point": enc_point(pt).hex()})
        steps.append(step)
        if pt != ID:
            return pt, steps
    raise AssertionError("no counter gives J")


# --- Self-checks -------------------------------------------------------------------


def self_check():
    ecdsa.self_check()
    # EIP-2494: G_EIP is on the curve with order 8l, and B8 = 8 * G_EIP has order l.
    assert on_curve(G_EIP) and on_curve(B8)
    assert mul(8, G_EIP) == B8
    assert mul(L, B8) == ID and mul(L, G_EIP) != ID and mul(8 * L, G_EIP) == ID
    # RFC 9380 Appendix K.1, expand_message_xmd(SHA-256).
    dst = b"QUUX-V01-CS02-with-expander-SHA256-128"
    for msg, want in [
        (b"", "68a985b87eb6b46952128911f2a4412bbc302a9d759667f87f7a21d803f07235"),
        (b"abc", "d8ccab23b5985ccea865c6c97b6e5b8350e794e603b4b97902f53a8a0d605615"),
        (
            b"abcdef0123456789",
            "eff31487c770a893cfb36f912fbfcbff40d5661771ca4b2cb4eafe524333f5c1",
        ),
    ]:
        assert expand_message_xmd(msg, dst, 32).hex() == want, msg


# --- Test data ---------------------------------------------------------------------


def scalar_from(label):
    """A deterministic test scalar in 1 to l - 1 (never a real secret)."""
    return int.from_bytes(sha256(b"abolish test keyed nullifier " + label), "big") % (L - 1) + 1


def bytes32(label):
    return sha256(b"abolish test keyed nullifier id " + label)


def lagrange(i, seats):
    num, den = 1, 1
    for j in seats:
        if j != i:
            num = num * j % L
            den = den * (j - i) % L
    return num * inv(den, L) % L


def evaluation_t(J, key_id, query_hash, seat, c_i, b, z_i, t1, t2):
    return (
        enc_point(G)
        + enc_point(J)
        + key_id
        + query_hash
        + bytes([seat])
        + enc_point(c_i)
        + enc_point(b)
        + enc_point(z_i)
        + enc_point(t1)
        + enc_point(t2)
    )


def answer_message(key_id, query_hash, seat, b, z, c, z1, z2):
    return (
        RECORD_TYPE.to_bytes(2, "big")
        + bytes([VERSION])
        + key_id
        + query_hash
        + bytes([seat])
        + enc_point(b)
        + enc_point(z)
        + enc_scalar(c)
        + enc_scalar(z1)
        + enc_scalar(z2)
    )


def verify_proof(J, key_id, query_hash, seat, c_i, b, z_i, c, z1, z2):
    t1 = add(mul(z1, b), neg(mul(c, z_i)))
    t2 = add(add(mul(z1, G), mul(z2, J)), neg(mul(c, c_i)))
    t = evaluation_t(J, key_id, query_hash, seat, c_i, b, z_i, t1, t2)
    return hash_to_scalar(t, FS_TAG)[1] == c


def decode_answer(rec):
    """Strict decoding of an answer record: (fields, None) or (None, (code, offset))."""
    fixed = [("key_id", 32), ("query_hash", 32), ("seat", 1), ("b", 64), ("z", 64)]
    fixed += [("c", 32), ("z1", 32), ("z2", 32), ("signature", 64)]
    if len(rec) < 2:
        return None, ("truncated", 0)
    rt = int.from_bytes(rec[:2], "big")
    if rt != RECORD_TYPE:
        # The vector file's known types are this record's alone.
        return None, ("unknown-record-type", 0)
    if len(rec) < 3:
        return None, ("truncated", 2)
    if rec[2] != VERSION:
        return None, ("unknown-version", 2)
    off, out = 3, {}
    for name, n in fixed:
        if len(rec) - off < n:
            return None, ("truncated", off)
        b = rec[off : off + n]
        if name in ("b", "z"):
            v = dec_point(b)
            if v is None:
                return None, ("non-canonical", off)
        elif name in ("c", "z1", "z2"):
            v = dec_scalar(b)
            if v is None:
                return None, ("non-canonical", off)
        elif name == "seat":
            v = b[0]
        elif name == "signature":
            r, s = int.from_bytes(b[:32], "big"), int.from_bytes(b[32:], "big")
            if not (1 <= r < ecdsa.N and 1 <= s <= ecdsa.HALF_N):
                return None, ("non-canonical", off)
            v = b
        else:
            v = b
        out[name] = v
        off += n
    if off != len(rec):
        return None, ("trailing-bytes", off)
    return out, None


def check_answer(J, key, query, rec):
    a, err = decode_answer(rec)
    if err is not None:
        return err[0]
    if a["key_id"] != key["key_id"]:
        return "answer-key"
    if a["query_hash"] != query["query_hash"] or a["b"] != query["b"]:
        return "answer-query"
    if not 1 <= a["seat"] <= key["n"]:
        return "answer-seat"
    seat_key = key["identity_keys"][a["seat"] - 1]
    if not ecdsa.verify(seat_key, ds(SIG_TAG, rec[:-64]), a["signature"]):
        return "answer-signature"
    c_i = key["commitments"][a["seat"] - 1]
    if not verify_proof(
        J, a["key_id"], a["query_hash"], a["seat"], c_i, a["b"], a["z"], a["c"], a["z1"], a["z2"]
    ):
        return "answer-proof"
    return "ok"


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = pathlib.Path(sys.argv[1])
    self_check()

    J, j_steps = derive_j()
    assert J not in (G, neg(G), ID) and in_subgroup(J)

    # --- Codec vectors -----------------------------------------------------------
    codecs = []

    def scalar_vec(id_, desc, b):
        v = dec_scalar(b)
        entry = {"id": id_, "description": desc, "type": {"kind": "bjj-scalar"}, "encoding": b.hex()}
        if v is None:
            entry["error"] = "non-canonical"
        else:
            entry["value"] = str(v)
        codecs.append(entry)

    scalar_vec("scalar-zero", "0", bytes(32))
    scalar_vec("scalar-one", "1", (1).to_bytes(32, "big"))
    scalar_vec("scalar-max", "l - 1", (L - 1).to_bytes(32, "big"))
    scalar_vec("scalar-order", "l itself: never reduced to 0", L.to_bytes(32, "big"))
    scalar_vec("scalar-order-plus-one", "l + 1", (L + 1).to_bytes(32, "big"))
    scalar_vec("scalar-all-ones", "2^256 - 1", b"\xff" * 32)

    def point_vec(id_, desc, b, identity):
        v = dec_point(b, identity)
        kind = {"kind": "bjj-point", "identity": "allowed" if identity else "rejected"}
        entry = {"id": id_, "description": desc, "type": kind, "encoding": b.hex()}
        if v is None:
            entry["error"] = "non-canonical"
        else:
            entry["value"] = {"x": str(v[0]), "y": str(v[1])}
        codecs.append(entry)

    def raw(x, y):
        return x.to_bytes(32, "big") + y.to_bytes(32, "big")

    # Points of small order: (0, -1) has order 2; (±sqrt(1/a), 0) order 4; and
    # G_EIP's multiples l * G_EIP have order 8.
    t2 = (0, P - 1)
    t4 = (sqrt(inv(A, P)), 0)
    t8 = mul(L, G_EIP)
    assert on_curve(t4) and mul(2, t4) == t2 and mul(4, t8) == t2
    point_vec("point-g", "G = B8", enc_point(G), False)
    point_vec("point-j", "J", enc_point(J), False)
    point_vec("point-neg-g", "-G", enc_point(neg(G)), False)
    point_vec("point-multiple", "5 * G", enc_point(mul(5, G)), False)
    point_vec("point-identity-rejected", "The identity, in a field that rejects it", enc_point(ID), False)
    point_vec("point-identity-allowed", "The identity, in a field that allows it", enc_point(ID), True)
    point_vec("point-order-2", "(0, -1), of order 2", enc_point(t2), True)
    point_vec("point-order-4", "A point of order 4", enc_point(t4), True)
    point_vec("point-order-8", "l * G_EIP, of order 8", enc_point(t8), True)
    point_vec("point-g-eip", "EIP-2494's G_EIP, of order 8l", enc_point(G_EIP), False)
    point_vec("point-g-plus-order-2", "G + (0, -1): on the curve, outside the subgroup", enc_point(add(G, t2)), False)
    point_vec("point-off-curve", "G with y + 1: not on the curve", raw(G[0], G[1] + 1), False)
    point_vec("point-x-at-p", "G's x plus p", raw(G[0] + P, G[1]), False)
    point_vec("point-y-at-p", "The identity's y plus p, x = 0", raw(0, 1 + P), True)
    point_vec("point-x-is-p", "x = p, y = 1", raw(P, 1), True)

    # --- HashToScalarBJJ ---------------------------------------------------------
    h2s = []
    for id_, msg, dst in [
        ("fs-empty", b"", FS_TAG),
        ("fs-abc", b"abc", FS_TAG),
        ("fs-long", bytes(range(256)) * 3, FS_TAG),
        ("rfc-dst", b"abc", b"QUUX-V01-CS02-with-expander-SHA256-128"),
    ]:
        uniform, s = hash_to_scalar(msg, dst)
        h2s.append({"id": id_, "dst": dst.decode(), "message": msg.hex(), "uniform": uniform.hex(), "scalar": str(s)})

    # --- The key: k = 3 of n = 5, three qualified dealers --------------------------
    k, n = 3, 5
    dealers = []
    for d in range(1, 4):
        f = [scalar_from(b"dealer %d f %d" % (d, j)) for j in range(k)]
        g = [scalar_from(b"dealer %d g %d" % (d, j)) for j in range(k)]
        comm = [add(mul(f[j], G), mul(g[j], J)) for j in range(k)]
        dealers.append({"f": f, "g": g, "commitments": comm})

    def poly(coeffs, z):
        return sum(c * pow(z, j, L) for j, c in enumerate(coeffs)) % L

    sk = sum(dl["f"][0] for dl in dealers) % L
    shares = []
    commitments = []
    for i in range(1, n + 1):
        sk_i = sum(poly(dl["f"], i) for dl in dealers) % L
        s_i = sum(poly(dl["g"], i) for dl in dealers) % L
        c_i = ID
        for dl in dealers:
            for j in range(k):
                c_i = add(c_i, mul(pow(i, j, L), dl["commitments"][j]))
        assert c_i == add(mul(sk_i, G), mul(s_i, J)) and c_i != ID
        shares.append({"seat": i, "sk": sk_i, "s": s_i, "commitment": c_i})
        commitments.append(c_i)

    id_secrets = [ecdsa.secret(b"keyed nullifier seat %d" % i) for i in range(1, n + 1)]
    id_keys = [ecdsa.compress(ecdsa.mul(d, ecdsa.G)) for d in id_secrets]
    key_id = bytes32(b"key")
    key = {"key_id": key_id, "n": n, "identity_keys": id_keys, "commitments": commitments}

    # --- Queries: B = r * P, with P a stand-in for H1(x) (part 2b-3) ---------------
    queries = []
    for q in range(2):
        m = scalar_from(b"query %d base" % q)
        r = scalar_from(b"query %d r" % q)
        base = mul(m, G)
        b = mul(r, base)
        queries.append({"id": "query-%d" % q, "m": m, "r": r, "base": base, "b": b, "query_hash": bytes32(b"query %d" % q)})

    def make_answer(q, seat, label, sk_i=None, s_i=None):
        sh = shares[seat - 1]
        sk_i = sh["sk"] if sk_i is None else sk_i
        s_i = sh["s"] if s_i is None else s_i
        w1 = scalar_from(b"nonce %s w1" % label)
        w2 = scalar_from(b"nonce %s w2" % label)
        z_i = mul(sk_i, q["b"])
        t1 = mul(w1, q["b"])
        t2 = add(mul(w1, G), mul(w2, J))
        t = evaluation_t(J, key_id, q["query_hash"], seat, sh["commitment"], q["b"], z_i, t1, t2)
        c = hash_to_scalar(t, FS_TAG)[1]
        z1 = (w1 + c * sk_i) % L
        z2 = (w2 + c * s_i) % L
        msg = answer_message(key_id, q["query_hash"], seat, q["b"], z_i, c, z1, z2)
        _, rr, ss = ecdsa.ecdsa_sign(id_secrets[seat - 1], ds(SIG_TAG, msg))
        rec = msg + ecdsa.sig_bytes(rr, ss)
        return {
            "w1": w1,
            "w2": w2,
            "z": z_i,
            "t1": t1,
            "t2": t2,
            "t": t,
            "c": c,
            "z1": z1,
            "z2": z2,
            "message": msg,
            "record": rec,
        }

    answers = []
    by_query = []
    for q in queries:
        recs = {}
        for seat in range(1, n + 1):
            label = b"%s seat %d" % (q["id"].encode(), seat)
            a = make_answer(q, seat, label)
            assert len(a["t"]) == 513 and len(a["record"]) == 356
            assert check_answer(J, key, q, a["record"]) == "ok"
            recs[seat] = a
            answers.append(
                {
                    "id": "%s-seat-%d" % (q["id"], seat),
                    "query": q["id"],
                    "seat": seat,
                    "w1": str(a["w1"]),
                    "w2": str(a["w2"]),
                    "z": enc_point(a["z"]).hex(),
                    "t1": enc_point(a["t1"]).hex(),
                    "t2": enc_point(a["t2"]).hex(),
                    "t": a["t"].hex(),
                    "c": str(a["c"]),
                    "z1": str(a["z1"]),
                    "z2": str(a["z2"]),
                    "message": a["message"].hex(),
                    "record": a["record"].hex(),
                }
            )
        by_query.append(recs)

    # --- Combinations: every k-subset gives sk * B ---------------------------------
    combinations = []
    for q, recs in zip(queries, by_query):
        want = mul(sk, q["b"])
        u_want = mul(sk, q["base"])
        for seats in itertools.combinations(range(1, n + 1), k):
            lambdas = [lagrange(i, seats) for i in seats]
            z = ID
            for lam, i in zip(lambdas, seats):
                z = add(z, mul(lam, recs[i]["z"]))
            assert z == want
            u = mul(inv(q["r"], L), z)
            assert u == u_want
            combinations.append(
                {
                    "query": q["id"],
                    "seats": list(seats),
                    "lambdas": [str(x) for x in lambdas],
                    "z": enc_point(z).hex(),
                    "u": enc_point(u).hex(),
                }
            )

    # --- Answer checks -------------------------------------------------------------
    q0 = queries[0]
    good = by_query[0][2]["record"]
    checks = []

    def check(id_, desc, rec, query=q0, k_=key):
        code = check_answer(J, k_, query, rec)
        checks.append({"id": id_, "description": desc, "query": query["id"], "record": rec.hex(), "result": code})

    def resign(msg, seat):
        _, rr, ss = ecdsa.ecdsa_sign(id_secrets[seat - 1], ds(SIG_TAG, msg))
        return msg + ecdsa.sig_bytes(rr, ss)

    def splice(rec, off, b):
        return rec[:off] + b + rec[off + len(b) :]

    OFF_KEY, OFF_QUERY, OFF_SEAT, OFF_B, OFF_Z = 3, 35, 67, 68, 132
    OFF_C, OFF_Z1, OFF_Z2, OFF_SIG = 196, 228, 260, 292
    msg = good[:OFF_SIG]

    check("ok", "Seat 2's honest answer", good)
    check("ok-other-query", "Seat 4's honest answer to the second query", by_query[1][4]["record"], queries[1])
    check("other-key", "Signed by the seat, for another key", resign(splice(msg, OFF_KEY, bytes32(b"other key")), 2))
    check("other-query-hash", "Signed by the seat, naming another query", resign(splice(msg, OFF_QUERY, bytes32(b"other query")), 2))
    check("answer-to-other-query", "Seat 2's honest answer to the second query, checked as the first's", by_query[1][2]["record"])
    check("other-b", "Signed by the seat, with another B", resign(splice(msg, OFF_B, enc_point(queries[1]["b"])), 2))
    check("seat-zero", "Seat 0", resign(splice(msg, OFF_SEAT, b"\x00"), 2))
    check("seat-over-n", "Seat n + 1", resign(splice(msg, OFF_SEAT, bytes([n + 1])), 2))
    check("seat-relabelled", "Seat 2's answer relabelled as seat 3, unsigned by seat 3", splice(good, OFF_SEAT, b"\x03"))
    check("signed-by-other-seat", "Seat 2's answer signed by seat 3's key", resign(msg, 3))
    check("signature-altered", "A signature byte flipped", splice(good, OFF_SIG + 40, bytes([good[OFF_SIG + 40] ^ 1])))
    wrong = make_answer(q0, 2, b"wrong share", sk_i=(shares[1]["sk"] + 1) % L)
    check("wrong-share", "Seat 2 answers with sk_2 + 1 and an honest-looking proof, signed: attributed", wrong["record"])
    swapped = make_answer(q0, 2, b"swapped share", sk_i=shares[2]["sk"], s_i=shares[2]["s"])
    check("other-seat-share", "Seat 2 answers with seat 3's share, signed: attributed", swapped["record"])
    z_bad = enc_point(mul(shares[1]["sk"] + 1, q0["b"]))
    check("z-replaced", "Signed by the seat, Z replaced and the proof kept", resign(splice(msg, OFF_Z, z_bad), 2))
    c_bad = enc_scalar((by_query[0][2]["c"] + 1) % L)
    check("c-altered", "Signed by the seat, c + 1", resign(splice(msg, OFF_C, c_bad), 2))
    z1_bad = enc_scalar((by_query[0][2]["z1"] + 1) % L)
    check("z1-altered", "Signed by the seat, z1 + 1", resign(splice(msg, OFF_Z1, z1_bad), 2))
    z2_bad = enc_scalar((by_query[0][2]["z2"] + 1) % L)
    check("z2-altered", "Signed by the seat, z2 + 1", resign(splice(msg, OFF_Z2, z2_bad), 2))
    check("b-small-order", "B with a component of order 2", splice(good, OFF_B, enc_point(add(q0["b"], t2))))
    check("z-identity", "Z the identity", splice(good, OFF_Z, enc_point(ID)))
    check("c-at-order", "c = l", splice(good, OFF_C, L.to_bytes(32, "big")))
    check("signature-high-s", "The signature with s replaced by n - s", splice(good, OFF_SIG + 32, (ecdsa.N - int.from_bytes(good[OFF_SIG + 32 :], "big")).to_bytes(32, "big")))
    for c_ in checks:
        assert (c_["result"] == "ok") == c_["id"].startswith("ok"), c_["id"]

    # --- Decode rejections ---------------------------------------------------------
    decode_errors = []
    for id_, desc, rec in [
        ("truncated-header", "One byte", good[:1]),
        ("truncated-body", "Cut inside z2", good[: OFF_Z2 + 5]),
        ("trailing", "One byte after the signature", good + b"\x00"),
        ("wrong-type", "Record type 0x000f", b"\x00\x0f" + good[2:]),
        ("unknown-version", "Version 2", good[:2] + b"\x02" + good[3:]),
        ("b-off-curve", "B off the curve", splice(good, OFF_B, raw(G[0], G[1] + 1))),
        ("b-identity", "B the identity", splice(good, OFF_B, enc_point(ID))),
        ("z1-at-order", "z1 = l", splice(good, OFF_Z1, L.to_bytes(32, "big"))),
        ("signature-r-zero", "Signature r = 0", splice(good, OFF_SIG, bytes(32))),
    ]:
        _, err = decode_answer(rec)
        assert err is not None, id_
        decode_errors.append({"id": id_, "description": desc, "encoding": rec.hex(), "error": err[0], "offset": err[1]})

    data = {
        "format": "abolish-keyed-nullifier-vectors/1",
        "title": "Keyed nullifier: Baby Jubjub encodings, J, share commitments, the seats' evaluation, answers and combination",
        "spec": "docs/spec/keyed-nullifier.md",
        "generator": (
            "packages/crypto/scripts/keyed-nullifier-vectors.py: an independent Python implementation of "
            "docs/spec/keyed-nullifier.md, with Baby Jubjub checked against EIP-2494 and expand_message_xmd "
            "against RFC 9380 Appendix K.1 first, and trustee-vectors.py's P-256 ECDSA, which reproduces "
            "RFC 6979 Appendix A.2.5 first"
        ),
        "tags": {"generatorJ": J_TAG.decode(), "evaluation": FS_TAG.decode(), "answer": SIG_TAG.decode()},
        "recordType": "0x0010",
        "version": VERSION,
        "group": {
            "p": str(P),
            "l": str(L),
            "a": str(A),
            "d": str(D),
            "cofactor": "8",
            "g": enc_point(G).hex(),
            "j": enc_point(J).hex(),
        },
        "generatorJ": {"steps": j_steps, "j": enc_point(J).hex()},
        "codecs": codecs,
        "hashToScalar": h2s,
        "key": {
            "k": k,
            "n": n,
            "keyId": key_id.hex(),
            "sk": str(sk),
            "dealers": [
                {
                    "f": [str(x) for x in dl["f"]],
                    "g": [str(x) for x in dl["g"]],
                    "commitments": [enc_point(c).hex() for c in dl["commitments"]],
                }
                for dl in dealers
            ],
            "seats": [
                {
                    "seat": sh["seat"],
                    "sk": str(sh["sk"]),
                    "s": str(sh["s"]),
                    "commitment": enc_point(sh["commitment"]).hex(),
                    "identitySecret": id_secrets[sh["seat"] - 1].to_bytes(32, "big").hex(),
                    "identityKey": id_keys[sh["seat"] - 1].hex(),
                }
                for sh in shares
            ],
        },
        "queries": [
            {
                "id": q["id"],
                "queryHash": q["query_hash"].hex(),
                "m": str(q["m"]),
                "base": enc_point(q["base"]).hex(),
                "r": str(q["r"]),
                "b": enc_point(q["b"]).hex(),
            }
            for q in queries
        ],
        "answers": answers,
        "combinations": combinations,
        "checks": checks,
        "decodeErrors": decode_errors,
    }
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "keyed-nullifier.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
