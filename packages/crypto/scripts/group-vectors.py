#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/group.json and hash.json.

A second implementation of ristretto255 (RFC 9496), expand_message_xmd
(RFC 9380, Section 5.3.1) and HashToScalar (RFC 9497, Section 4.1), written
from the RFC texts with Python's integers and hashlib only. It shares no code
with packages/crypto or @noble/curves, so the vectors it prints check that
code instead of restating it (docs/spec/vectors/README.md, Rules). It checks
itself against the RFC 9496 Appendix A and RFC 9380 Appendix K.3 vectors
before printing anything.

Usage: python3 -I packages/crypto/scripts/group-vectors.py <out-dir>
"""

import hashlib
import json
import sys

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, -1, P)) % P
SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752
SQRT_AD_MINUS_ONE = 25063068953384623474111414158702152701244531502492656460079210482610430750235
INVSQRT_A_MINUS_D = 54469307008909316920995813868745141605393597292927456921205312896311721017578
ONE_MINUS_D_SQ = 1159843021668779879193775521855586647937357759715417654439879720876111806838
D_MINUS_ONE_SQ = 40440834346308536858101042469323190826248399146238708352240133220865137265952


def is_negative(x):
    return x % P % 2 == 1


def ct_abs(x):
    return (-x) % P if is_negative(x) else x % P


def sqrt_ratio_m1(u, v):
    """RFC 9496, Section 4.2."""
    u %= P
    v %= P
    r = (u * v**3 * pow(u * v**7, (P - 5) // 8, P)) % P
    check = (v * r * r) % P
    correct = check == u
    flipped = check == (-u) % P
    flipped_i = check == (-u * SQRT_M1) % P
    r_prime = (SQRT_M1 * r) % P
    if flipped or flipped_i:
        r = r_prime
    return correct or flipped, ct_abs(r)


# Points in extended coordinates (X, Y, Z, T) on edwards25519, a = -1.
IDENTITY = (0, 1, 1, 0)


def add(p, q):
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = (y1 - x1) * (y2 - x2) % P
    b = (y1 + x1) * (y2 + x2) % P
    c = 2 * D * t1 * t2 % P
    d = 2 * z1 * z2 % P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def neg(p):
    x, y, z, t = p
    return ((-x) % P, y, z, (-t) % P)


def mul(k, p):
    out = IDENTITY
    while k:
        if k & 1:
            out = add(out, p)
        p = add(p, p)
        k >>= 1
    return out


def decode(b):
    """RFC 9496, Section 4.3.1. Returns None for an invalid encoding."""
    assert len(b) == 32
    s = int.from_bytes(b, "little")
    if s >= P or is_negative(s):
        return None
    ss = s * s % P
    u1 = (1 - ss) % P
    u2 = (1 + ss) % P
    u2_sqr = u2 * u2 % P
    v = (-(D * u1 * u1) - u2_sqr) % P
    was_square, invsqrt = sqrt_ratio_m1(1, v * u2_sqr)
    den_x = invsqrt * u2 % P
    den_y = invsqrt * den_x * v % P
    x = ct_abs(2 * s * den_x)
    y = u1 * den_y % P
    t = x * y % P
    if not was_square or is_negative(t) or y == 0:
        return None
    return (x, y, 1, t)


def encode(p):
    """RFC 9496, Section 4.3.2."""
    x0, y0, z0, t0 = p
    u1 = (z0 + y0) * (z0 - y0) % P
    u2 = x0 * y0 % P
    _, invsqrt = sqrt_ratio_m1(1, u1 * u2 * u2)
    den1 = invsqrt * u1 % P
    den2 = invsqrt * u2 % P
    z_inv = den1 * den2 * t0 % P
    ix0 = x0 * SQRT_M1 % P
    iy0 = y0 * SQRT_M1 % P
    enchanted_denominator = den1 * INVSQRT_A_MINUS_D % P
    rotate = is_negative(t0 * z_inv)
    x = iy0 if rotate else x0
    y = ix0 if rotate else y0
    den_inv = enchanted_denominator if rotate else den2
    y = (-y) % P if is_negative(x * z_inv) else y
    s = ct_abs(den_inv * (z0 - y))
    return s.to_bytes(32, "little")


def equal(p, q):
    x1, y1, _, _ = p
    x2, y2, _, _ = q
    return (x1 * y2 - y1 * x2) % P == 0 or (y1 * y2 - x1 * x2) % P == 0


def map_to_point(t):
    """MAP of RFC 9496, Section 4.3.4."""
    r = SQRT_M1 * t * t % P
    u = (r + 1) * ONE_MINUS_D_SQ % P
    v = (-1 - r * D) * (r + D) % P
    was_square, s = sqrt_ratio_m1(u, v)
    s_prime = (-ct_abs(s * t)) % P
    s = s if was_square else s_prime
    c = -1 if was_square else r
    n = (c * (r - 1) * D_MINUS_ONE_SQ - v) % P
    w0 = 2 * s * v % P
    w1 = n * SQRT_AD_MINUS_ONE % P
    w2 = (1 - s * s) % P
    w3 = (1 + s * s) % P
    return (w0 * w3 % P, w2 * w1 % P, w1 * w3 % P, w0 * w2 % P)


def derive(b):
    """Element derivation from 64 uniform bytes, RFC 9496, Section 4.3.4."""
    assert len(b) == 64
    r0 = int.from_bytes(b[:32], "little") % 2**255 % P
    r1 = int.from_bytes(b[32:], "little") % 2**255 % P
    return add(map_to_point(r0), map_to_point(r1))


def expand_message_xmd(msg, dst, length):
    """RFC 9380, Section 5.3.1, over SHA-512 (b = 512, s = 1024 bits)."""
    assert 16 <= len(dst) <= 255 or dst.startswith(b"QUUX")
    ell = -(-length // 64)
    assert ell <= 255 and length <= 65535
    dst_prime = dst + bytes([len(dst)])
    z_pad = bytes(128)
    msg_prime = z_pad + msg + length.to_bytes(2, "big") + b"\x00" + dst_prime
    b0 = hashlib.sha512(msg_prime).digest()
    b1 = hashlib.sha512(b0 + b"\x01" + dst_prime).digest()
    out = [b1]
    for i in range(2, ell + 1):
        prev = bytes(x ^ y for x, y in zip(b0, out[-1]))
        out.append(hashlib.sha512(prev + bytes([i]) + dst_prime).digest())
    return b"".join(out)[:length]


def hash_to_ristretto255(msg, dst):
    """RFC 9380, Appendix B."""
    uniform = expand_message_xmd(msg, dst, 64)
    return uniform, derive(uniform)


def hash_to_scalar(msg, dst):
    """RFC 9497, Section 4.1 (ristretto255-SHA512), with an explicit DST."""
    uniform = expand_message_xmd(msg, dst, 64)
    return uniform, int.from_bytes(uniform, "little") % L


BASE = decode(bytes.fromhex("e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76"))


def self_check():
    # RFC 9496 A.1 (first entries) and A.3 (first entry), RFC 9380 K.3 (first entry).
    b2 = "6a493210f7499cd17fecb510ae0cea23a110e8d5b901f8acadd3095c73a3b919"
    assert encode(mul(2, BASE)).hex() == b2
    assert encode(add(BASE, BASE)).hex() == b2
    assert encode(IDENTITY) == bytes(32)
    b15 = "e0c418f7c8d9c4cdd7395b93ea124f3ad99021bb681dfc3302a9d99a2e53e64e"
    assert encode(mul(15, BASE)).hex() == b15
    assert encode(mul(L, BASE)) == bytes(32)
    i = bytes.fromhex(
        "5d1be09e3d0c82fc538112490e35701979d99e06ca3e2b5b54bffe8b4dc772c1"
        "4d98b696a1bbfb5ca32c436cc61c16563790306c79eaca7705668b47dffe5bb6"
    )
    assert encode(derive(i)).hex() == "3066f82a1a747d45120d1740f14358531a8f04bbffe6a819f86dfe50f44a0a46"
    for bad in [
        "00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "0100000000000000000000000000000000000000000000000000000000000000",
        "26948d35ca62e643e26a83177332e6b6afeb9d08e4268b650f1f5bbd8d81d371",
        "3eb858e78f5a7254d8c9731174a94f76755fd3941c0ac93735c07ba14579630e",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ]:
        assert decode(bytes.fromhex(bad)) is None, bad
    dst = b"QUUX-V01-CS02-with-expander-SHA512-256"
    assert expand_message_xmd(b"", dst, 32).hex() == (
        "6b9a7312411d92f921c6f68ca0b6380730a1a4d982c507211a90964c394179ba"
    )
    assert expand_message_xmd(b"abc", dst, 32).hex() == (
        "0da749f12fbe5483eb066a5f595055679b976e93abe9be6f0f6318bce7aca8dc"
    )


def le(n):
    return n.to_bytes(32, "little").hex()


def scalar_vectors():
    t = {"kind": "scalar"}
    v = []

    def ok(id_, n, description=None):
        e = {"id": id_}
        if description:
            e["description"] = description
        e |= {"type": t, "value": str(n), "encoding": le(n)}
        v.append(e)

    def bad(id_, enc, error, description):
        v.append({"id": id_, "description": description, "type": t, "encoding": enc, "error": error})

    ok("scalar-zero", 0)
    ok("scalar-one", 1, "Little-endian: the least significant byte comes first")
    ok("scalar-256", 256)
    ok("scalar-2-pow-248", 2**248, "Reads as 1 in big-endian; little-endian gives 2^248")
    ok("scalar-2-pow-252", 2**252, "Below the group order, which is 2^252 plus a 125-bit value")
    ok("scalar-order-minus-one", L - 1, "The largest scalar")
    bad("scalar-order", le(L), "non-canonical", "The group order itself is never reduced to 0")
    bad("scalar-order-plus-one", le(L + 1), "non-canonical", "Would reduce to 1")
    bad("scalar-2-pow-253", le(2**253), "non-canonical", "Above the order")
    bad("scalar-2-pow-255", le(2**255), "non-canonical", "Top bit set")
    bad("scalar-max", "ff" * 32, "non-canonical", "2^256 - 1")
    bad(
        "scalar-order-big-endian",
        L.to_bytes(32, "big").hex(),
        "non-canonical",
        "The order written big-endian reads little-endian as a value above it",
    )
    bad("scalar-truncated", "00" * 31, "truncated", "31 bytes")
    bad("scalar-empty", "", "truncated", "No bytes")
    bad("scalar-trailing", "00" * 33, "trailing-bytes", "33 bytes")
    return v


def element_vectors(h):
    rejected = {"kind": "element", "identity": "rejected"}
    allowed = {"kind": "element", "identity": "allowed"}
    v = []

    def ok(id_, t, enc, description):
        v.append({"id": id_, "description": description, "type": t, "value": enc, "encoding": enc})

    def bad(id_, t, enc, error, description):
        v.append({"id": id_, "description": description, "type": t, "encoding": enc, "error": error})

    g = encode(BASE).hex()
    ok("element-generator", rejected, g, "g, the RFC 9496 generator (Appendix A.1, B[1])")
    ok("element-2g", rejected, encode(mul(2, BASE)).hex(), "2g (RFC 9496 Appendix A.1, B[2])")
    ok("element-minus-g", rejected, encode(neg(BASE)).hex(), "-g")
    ok("element-h", rejected, encode(h).hex(), "h, the second generator (hash.json)")
    ok("element-identity-allowed", allowed, "00" * 32, "The identity, in a field that allows it")
    ok("element-generator-identity-allowed", allowed, g, "g, in a field that allows the identity")
    bad("element-identity-rejected", rejected, "00" * 32, "non-canonical", "The identity, where it isn't allowed")
    for t, suffix in ((rejected, ""), (allowed, "-identity-allowed")):
        for id_, enc, description in (
            ("element-non-canonical-field", "ed" + "ff" * 30 + "7f", "s = p, a non-canonical field encoding (RFC 9496 A.2)"),
            ("element-non-canonical-field-high-bit", "00" + "ff" * 31, "Top bit set (RFC 9496 A.2)"),
            ("element-negative", "01" + "00" * 31, "s = 1 is negative (RFC 9496 A.2)"),
            ("element-non-square", "26948d35ca62e643e26a83177332e6b6afeb9d08e4268b650f1f5bbd8d81d371", "Non-square x^2 (RFC 9496 A.2)"),
            ("element-negative-xy", "3eb858e78f5a7254d8c9731174a94f76755fd3941c0ac93735c07ba14579630e", "Negative x*y (RFC 9496 A.2)"),
            ("element-s-minus-one", "ec" + "ff" * 30 + "7f", "s = -1, so y = 0 (RFC 9496 A.2)"),
        ):
            assert decode(bytes.fromhex(enc)) is None
            bad(id_ + suffix, t, enc, "non-canonical", description)
    bad("element-truncated", rejected, g[:62], "truncated", "31 bytes")
    bad("element-trailing", rejected, g + "00", "trailing-bytes", "33 bytes")
    return v


FS_TAGS = [
    "abolish/v1/fs/ballot-validity/option",
    "abolish/v1/fs/ballot-validity/sum",
    "abolish/v1/fs/ceremony/possession",
    "abolish/v1/fs/tally-share",
]


def main():
    self_check()
    out = sys.argv[1]
    dst_h = b"abolish/v1/generator-h"
    uniform_h, h = hash_to_ristretto255(b"", dst_h)
    h_enc = encode(h)
    assert decode(h_enc) is not None
    assert not equal(h, IDENTITY) and not equal(h, BASE) and not equal(h, neg(BASE))

    group = {
        "format": "abolish-vectors/1",
        "title": "Group scalars and elements (ristretto255)",
        "spec": "docs/spec/group.md",
        "generator": (
            "Printed by packages/crypto/scripts/group-vectors.py, an implementation of RFC 9496 "
            "written from the RFC with Python's integers, sharing no code with packages/crypto or "
            "@noble/curves, which checks itself against RFC 9496 Appendix A first. The invalid "
            "element encodings are taken from RFC 9496 Appendix A.2."
        ),
        "vectors": scalar_vectors() + element_vectors(h),
    }

    hashes = []
    for id_, msg in (("h-empty", b""), ("h-abc", b"abc")):
        hashes.append(
            {"id": id_, "function": "H", "message": msg.hex(), "output": hashlib.sha256(msg).hexdigest()}
        )
    hashes.append(
        {
            "id": "generator-h",
            "description": "h = hash_to_ristretto255(\"\", DST = \"abolish/v1/generator-h\")",
            "function": "hash-to-group",
            "dst": dst_h.decode(),
            "message": "",
            "uniformBytes": uniform_h.hex(),
            "output": h_enc.hex(),
            "notEqual": {
                "identity": "00" * 32,
                "g": encode(BASE).hex(),
                "minusG": encode(neg(BASE)).hex(),
            },
        }
    )
    for tag in FS_TAGS:
        for id_, msg in (("empty", b""), ("abc", b"abc"), ("0x00-x-200", bytes(200))):
            uniform, s = hash_to_scalar(msg, tag.encode())
            hashes.append(
                {
                    "id": f"{tag.removeprefix('abolish/v1/fs/').replace('/', '-')}-{id_}",
                    "function": "hash-to-scalar",
                    "dst": tag,
                    "message": msg.hex(),
                    "uniformBytes": uniform.hex(),
                    "output": le(s),
                }
            )
    hash_file = {
        "format": "abolish-hash-vectors/1",
        "title": "Protocol hash, hash-to-scalar and the generator h",
        "spec": "docs/spec/group.md",
        "generator": (
            "Printed by packages/crypto/scripts/group-vectors.py: H with Python's hashlib; "
            "expand_message_xmd, HashToScalar and hash_to_ristretto255 written from RFC 9380, "
            "RFC 9497 and RFC 9496 with Python's integers and hashlib, checked against RFC 9380 "
            "Appendix K.3 and RFC 9496 Appendix A first, sharing no code with packages/crypto or "
            "@noble/curves. The Fiat-Shamir messages are arbitrary bytes: they test the "
            "construction under each tag, not a statement layout."
        ),
        "vectors": hashes,
    }
    for name, data in (("group.json", group), ("hash.json", hash_file)):
        with open(f"{out}/{name}", "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")


if __name__ == "__main__":
    main()
