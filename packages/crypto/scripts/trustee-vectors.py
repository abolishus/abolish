#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/trustee.json.

A second implementation of docs/spec/trustee-identity.md: the p256-key and
p256-sig encodings, ECDSA P-256/SHA-256 over DS(tag, m) with RFC 6979 nonces
and the low-s rule, the panel identifier and the ceremony-registration
statement. It is written from the spec and the standards (SEC 1 v2, FIPS
186-5, RFC 6979) with Python's standard library only, and shares no code with
packages/crypto. Before printing anything it reproduces RFC 6979 Appendix
A.2.5's two P-256/SHA-256 signatures, nonce included.

Usage: python3 -I packages/crypto/scripts/trustee-vectors.py <out-dir>
"""

import hashlib
import hmac
import json
import pathlib
import sys

P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
G = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)
HALF_N = (N - 1) // 2
MAX_TRUSTEES = 16

PANEL_TAG = b"abolish/v1/panel"
REGISTRATION_TAG = b"abolish/v1/sig/ceremony-registration"


def ds(tag, m):
    return bytes([len(tag)]) + tag + m


def sha256(b):
    return hashlib.sha256(b).digest()


# Affine arithmetic; None is the point at infinity.
def add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if p1 == p2:
        lam = (3 * x1 * x1 + A) * pow(2 * y1, -1, P) % P
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, P) % P
    x3 = (lam * lam - x1 - x2) % P
    return (x3, (lam * (x1 - x3) - y1) % P)


def mul(k, pt):
    out = None
    while k:
        if k & 1:
            out = add(out, pt)
        pt = add(pt, pt)
        k >>= 1
    return out


def on_curve(pt):
    x, y = pt
    return (y * y - (x * x * x + A * x + B)) % P == 0


assert on_curve(G) and mul(N, G) is None


def compress(pt):
    x, y = pt
    return bytes([2 + (y & 1)]) + x.to_bytes(32, "big")


def decompress(b):
    """None unless b is a canonical p256-key (spec: Identity key)."""
    if len(b) != 33 or b[0] not in (2, 3):
        return None
    x = int.from_bytes(b[1:], "big")
    if x >= P:
        return None
    rhs = (x * x * x + A * x + B) % P
    y = pow(rhs, (P + 1) // 4, P)  # p ≡ 3 (mod 4)
    if y * y % P != rhs:
        return None
    if y & 1 != b[0] - 2:
        y = P - y
    return (x, y)


def rfc6979_k(d, h1):
    """RFC 6979 §3.2 with HMAC-SHA-256, qlen = hlen = 256."""
    x = d.to_bytes(32, "big")
    h = (int.from_bytes(h1, "big") % N).to_bytes(32, "big")  # bits2octets
    v, k = b"\x01" * 32, b"\x00" * 32
    k = hmac.new(k, v + b"\x00" + x + h, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    k = hmac.new(k, v + b"\x01" + x + h, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    while True:
        v = hmac.new(k, v, hashlib.sha256).digest()
        t = int.from_bytes(v, "big")
        if 1 <= t < N:
            return t
        k = hmac.new(k, v + b"\x00", hashlib.sha256).digest()
        v = hmac.new(k, v, hashlib.sha256).digest()


def ecdsa_sign(d, message, low_s=True):
    h1 = sha256(message)
    e = int.from_bytes(h1, "big")
    k = rfc6979_k(d, h1)
    r = mul(k, G)[0] % N
    s = pow(k, -1, N) * (e + r * d) % N
    assert r and s
    if low_s and s > HALF_N:
        s = N - s
    return k, r, s


def verify(key, message, sig):
    """The spec's Verify over the complete message M = DS(tag, m)."""
    q = decompress(key)
    if q is None or len(sig) != 64:
        return False
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if not (1 <= r < N and 1 <= s <= HALF_N):
        return False
    e = int.from_bytes(sha256(message), "big")
    w = pow(s, -1, N)
    pt = add(mul(e * w % N, G), mul(r * w % N, q))
    return pt is not None and pt[0] % N == r


def sig_bytes(r, s):
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def self_check():
    # RFC 6979 Appendix A.2.5, P-256 with SHA-256 (no low-s normalisation).
    d = 0xC9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721
    assert mul(d, G) == (
        0x60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6,
        0x7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299,
    )
    for msg, k, r, s in [
        (
            b"sample",
            0xA6E3C57DD01ABE90086538398355DD4C3B17AA873382B0F24D6129493D8AAD60,
            0xEFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716,
            0xF7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8,
        ),
        (
            b"test",
            0xD16B6AE827F17175E040871A1C7EC3500192C4C92677336EC2537ACAEE0008E0,
            0xF1ABB023518351CD71D881567B1EA663ED3EFCF6C5132B354F28D3B0B7D38367,
            0x019F4113742A2B14BD25926B49C649155F267E60D3814B4C0CC84250E46F0083,
        ),
    ]:
        assert ecdsa_sign(d, msg, low_s=False) == (k, r, s), msg


def secret(label):
    """A deterministic test secret from a label (never a real key)."""
    return int.from_bytes(sha256(b"abolish test trustee " + label), "big") % (N - 1) + 1


def u64(v):
    return v.to_bytes(8, "big")


def panel_id(k, keys):
    return sha256(ds(PANEL_TAG, bytes([k, len(keys)]) + b"".join(keys)))


def main(out_dir):
    self_check()
    h = lambda b: b.hex()

    # Keys.
    secrets = [secret(bytes([i])) for i in range(1, 8)]
    keys = [compress(mul(d, G)) for d in secrets]
    key_vectors = [
        {"id": f"key-{i + 1}", "secretKey": f"{d:064x}", "encoding": h(k)}
        for i, (d, k) in enumerate(zip(secrets, keys))
    ]
    key_vectors.append({"id": "key-generator", "secretKey": f"{1:064x}", "encoding": h(compress(G))})
    key_vectors.append({"id": "key-n-minus-1", "secretKey": f"{N - 1:064x}", "encoding": h(compress(mul(N - 1, G)))})
    # Rejected encodings. x = 0 is not on P-256 (b is not a square), and
    # x = 1 neither; found by search below rather than assumed.
    off_curve = next(x for x in range(0, 100) if decompress(bytes([2]) + x.to_bytes(32, "big")) is None)
    on_curve_x = next(x for x in range(0, 100) if decompress(bytes([2]) + x.to_bytes(32, "big")) is not None)
    g_x = G[0].to_bytes(32, "big")
    g_uncompressed = b"\x04" + g_x + G[1].to_bytes(32, "big")
    rejected_keys = [
        ("key-identity", b"\x00" * 33, "non-canonical"),
        ("key-uncompressed-prefix", b"\x04" + g_x, "non-canonical"),
        ("key-hybrid-prefix", b"\x06" + g_x, "non-canonical"),
        ("key-prefix-01", b"\x01" + g_x, "non-canonical"),
        ("key-x-equals-p", b"\x02" + P.to_bytes(32, "big"), "non-canonical"),
        ("key-x-above-p", b"\x03" + (P + on_curve_x).to_bytes(32, "big"), "non-canonical"),
        ("key-all-ff", b"\x02" + b"\xff" * 32, "non-canonical"),
        ("key-off-curve", b"\x02" + off_curve.to_bytes(32, "big"), "non-canonical"),
        ("key-truncated", compress(G)[:32], "truncated"),
        ("key-uncompressed-form", g_uncompressed, "non-canonical"),
        ("key-trailing-byte", compress(G) + b"\x00", "trailing-bytes"),
    ]
    for _id, enc, err in rejected_keys:
        assert decompress(enc) is None
        # Left to right: the 33-byte field is validated before any excess.
        assert (err == "trailing-bytes") == (len(enc) > 33 and decompress(enc[:33]) is not None)
    key_vectors += [{"id": i, "encoding": h(e), "error": err} for i, e, err in rejected_keys]
    # key-x-above-p is p + x for the smallest x on the curve, so it tests
    # aliasing (x ≥ p) rather than an off-curve x.
    assert decompress(b"\x03" + on_curve_x.to_bytes(32, "big")) is not None

    # Signatures over DS(tag, m) under the registration tag.
    sig_vectors = []
    messages = [b"", b"\x00", bytes(range(129)), b"\xff" * 64]
    for i, m in enumerate(messages):
        d = secrets[i]
        M = ds(REGISTRATION_TAG, m)
        _k, r, s = ecdsa_sign(d, M)
        sig = sig_bytes(r, s)
        assert verify(keys[i], M, sig)
        sig_vectors.append(
            {
                "id": f"sig-{i + 1}",
                "key": h(keys[i]),
                "message": h(m),
                "dsMessage": h(M),
                "digest": h(sha256(M)),
                "signature": h(sig),
                "valid": True,
            }
        )
    # Find a message whose raw RFC 6979 s is high, so normalisation shows.
    for j in range(256):
        m = bytes([j])
        M = ds(REGISTRATION_TAG, m)
        _k, r, s_raw = ecdsa_sign(secrets[0], M, low_s=False)
        if s_raw > HALF_N:
            break
    else:
        raise AssertionError("no high-s message found")
    low = sig_bytes(r, N - s_raw)
    assert verify(keys[0], M, low) and ecdsa_sign(secrets[0], M)[1:] == (r, N - s_raw)
    sig_vectors.append(
        {
            "id": "sig-normalised-from-high-s",
            "description": "RFC 6979 gives s above (n - 1) / 2 here; the signature is (r, n - s)",
            "key": h(keys[0]),
            "message": h(m),
            "dsMessage": h(M),
            "digest": h(sha256(M)),
            "signature": h(low),
            "valid": True,
        }
    )
    # A digest at or above n (found by a search over 8-byte messages; about
    # 2^32 tries): verifiers must reduce e modulo n, not reject it.
    m_big = bytes.fromhex("0000000015baa733")
    M = ds(REGISTRATION_TAG, m_big)
    assert int.from_bytes(sha256(M), "big") >= N
    _k, r_big, s_big = ecdsa_sign(secrets[0], M)
    sig = sig_bytes(r_big, s_big)
    assert verify(keys[0], M, sig)
    sig_vectors.append(
        {
            "id": "sig-digest-at-least-n",
            "description": "H(DS(tag, m)) is at or above n; e is reduced modulo n",
            "key": h(keys[0]),
            "message": h(m_big),
            "dsMessage": h(M),
            "digest": h(sha256(M)),
            "signature": h(sig),
            "valid": True,
        }
    )
    # An R with x(R) ≥ n, so r = x(R) − n. No honest signer reaches this
    # (probability about 2^-128), so the key is constructed from R and has no
    # known secret: Q = (R − u1·G) / u2, as a malicious trustee could choose.
    t = 0
    while True:
        x = N + t
        rhs = (x * x * x + A * x + B) % P
        y = pow(rhs, (P + 1) // 4, P)
        if x < P and y * y % P == rhs:
            break
        t += 1
    big_r = (x, y)
    m_xr = b"x(R) at least n"
    M = ds(REGISTRATION_TAG, m_xr)
    e = int.from_bytes(sha256(M), "big")
    r_xr, s_xr = x - N, 0x1234567
    w = pow(s_xr, -1, N)
    u1, u2 = e * w % N, r_xr * w % N
    q = mul(pow(u2, -1, N), add(big_r, mul(N - u1, G)))
    sig = sig_bytes(r_xr, s_xr)
    assert verify(compress(q), M, sig)
    sig_vectors.append(
        {
            "id": "sig-x-of-r-at-least-n",
            "description": "x(R) is at or above n and r = x(R) - n; the key is constructed for it and has no known secret",
            "key": h(compress(q)),
            "message": h(m_xr),
            "dsMessage": h(M),
            "digest": h(sha256(M)),
            "signature": h(sig),
            "valid": True,
        }
    )
    base = sig_vectors[0]
    bk, bm, bs = bytes.fromhex(base["key"]), bytes.fromhex(base["message"]), bytes.fromhex(base["signature"])
    br, bss = int.from_bytes(bs[:32], "big"), int.from_bytes(bs[32:], "big")
    flipped = bytearray(bs)
    flipped[63] ^= 1
    rejected = [
        ("sig-high-s", "the same signature with s replaced by n - s", bk, bm, sig_bytes(br, N - bss)),
        ("sig-high-s-of-normalised", "high-s twin of sig-normalised-from-high-s", keys[0], m, sig_bytes(r, s_raw)),
        ("sig-r-zero", "r = 0", bk, bm, sig_bytes(0, bss)),
        ("sig-r-n", "r = n", bk, bm, sig_bytes(N, bss)),
        ("sig-s-zero", "s = 0", bk, bm, sig_bytes(br, 0)),
        ("sig-s-half-plus-one", "s = (n - 1) / 2 + 1, the smallest high s", bk, bm, sig_bytes(br, HALF_N + 1)),
        ("sig-s-n", "s = n", bk, bm, sig_bytes(br, N)),
        ("sig-bit-flip", "last bit of s flipped", bk, bm, bytes(flipped)),
        ("sig-other-message", "valid signature, message with one byte appended", bk, bm + b"\x00", bs),
        ("sig-other-key", "valid signature, verified under key-2", keys[1], bm, bs),
        ("sig-truncated", "63 bytes", bk, bm, bs[:63]),
        ("sig-trailing", "65 bytes", bk, bm, bs + b"\x00"),
        ("sig-der", "the same r and s in DER", bk, bm, b"\x30\x44\x02\x20" + bs[:32] + b"\x02\x20" + bs[32:]),
        ("sig-key-uncompressed", "valid signature, key in uncompressed form", g_uncompressed, bm, bs),
    ]
    for vid, desc, key, msg, sig in rejected:
        M = ds(REGISTRATION_TAG, msg)
        assert not verify(key, M, sig), vid
        sig_vectors.append(
            {"id": vid, "description": desc, "key": h(key), "message": h(msg), "dsMessage": h(M), "signature": h(sig), "valid": False}
        )
    # A signature under another tag: same m, framed with the panel tag.
    M_other = ds(PANEL_TAG, bm)
    _k, r2, s2 = ecdsa_sign(secrets[0], M_other)
    other = sig_bytes(r2, s2)
    assert verify(bk, M_other, other) and not verify(bk, ds(REGISTRATION_TAG, bm), other)
    sig_vectors.append(
        {
            "id": "sig-other-tag",
            "description": "valid ECDSA signature on DS(\"abolish/v1/panel\", m), checked as a registration",
            "key": h(bk),
            "message": h(bm),
            "dsMessage": h(ds(REGISTRATION_TAG, bm)),
            "signature": h(other),
            "valid": False,
        }
    )

    # Panels.
    panel_vectors = []
    for vid, k, ks in [
        ("panel-2-of-2", 2, keys[:2]),
        ("panel-4-of-7", 4, keys),
        ("panel-7-of-7", 7, keys),
        ("panel-4-of-7-reordered", 4, [keys[1], keys[0]] + keys[2:]),
        ("panel-3-of-7", 3, keys),
        ("panel-2-of-16", 2, [compress(mul(secret(b"seat" + bytes([i])), G)) for i in range(16)]),
    ]:
        panel_vectors.append({"id": vid, "threshold": k, "keys": [h(x) for x in ks], "panelId": h(panel_id(k, ks))})
    seventeen = [compress(mul(secret(b"seat" + bytes([i])), G)) for i in range(17)]
    for vid, k, ks, err in [
        ("panel-threshold-1", 1, keys[:3], "threshold"),
        ("panel-threshold-0", 0, keys[:3], "threshold"),
        ("panel-threshold-above-n", 4, keys[:3], "threshold"),
        ("panel-one-seat", 2, keys[:1], "threshold"),
        ("panel-empty", 2, [], "threshold"),
        ("panel-17-seats", 2, seventeen, "size"),
        ("panel-duplicate-key", 2, [keys[0], keys[1], keys[0]], "duplicate-key"),
        ("panel-bad-key", 2, [keys[0], b"\x04" + g_x], "key"),
    ]:
        panel_vectors.append({"id": vid, "threshold": k, "keys": [h(x) for x in ks], "error": err})

    # Ceremony registrations, signed by seats of panel-4-of-7.
    pid = panel_id(4, keys)
    registry = bytes.fromhex("5fbdb2315678afecb367f032d93f642f64180aa3")
    reg_vectors = []
    for vid, chain, index, stub_label, tr_label in [
        ("registration-seat-1", 84532, 1, b"stub-a", b"transcript-a"),
        ("registration-seat-7", 84532, 7, b"stub-a", b"transcript-a"),
        ("registration-anvil", 31337, 3, b"stub-b", b"transcript-b"),
        ("registration-max-chain-id", 2**64 - 1, 2, b"stub-c", b"transcript-c"),
    ]:
        stub, tr = sha256(stub_label), sha256(tr_label)
        m = u64(chain) + registry + pid + bytes([index]) + stub + tr
        assert len(m) == 125
        M = ds(REGISTRATION_TAG, m)
        _k, r, s = ecdsa_sign(secrets[index - 1], M)
        sig = sig_bytes(r, s)
        assert verify(keys[index - 1], M, sig)
        reg_vectors.append(
            {
                "id": vid,
                "panel": "panel-4-of-7",
                "l2ChainId": str(chain),
                "trusteeRegistry": h(registry),
                "index": index,
                "stubHash": h(stub),
                "ceremonyTranscriptHash": h(tr),
                "message": h(m),
                "signature": h(sig),
            }
        )

    out = {
        "format": "abolish-trustee-vectors/1",
        "title": "Trustee identity: keys, signatures, panel identifier and ceremony registration",
        "spec": "docs/spec/trustee-identity.md",
        "generator": (
            "packages/crypto/scripts/trustee-vectors.py: an independent Python implementation (standard library "
            "only: affine P-256 arithmetic, RFC 6979 with hmac and hashlib) that first reproduces RFC 6979 Appendix "
            "A.2.5's two P-256/SHA-256 signatures, nonces included"
        ),
        "tags": {"panel": PANEL_TAG.decode(), "registration": REGISTRATION_TAG.decode()},
        "keys": key_vectors,
        "signatures": sig_vectors,
        "panels": panel_vectors,
        "registrations": reg_vectors,
    }
    path = pathlib.Path(out_dir) / "trustee.json"
    path.write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
