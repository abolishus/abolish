#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/share-encryption.json.

A second implementation of docs/spec/share-encryption.md: the trustee KEM key,
the hybrid KEM (ML-KEM-768 with Diffie–Hellman in ristretto255, combined
X-Wing style), ChaCha20-Poly1305, the ciphertext and its hash, a trustee's
decryption, the public check of a posting and the complaint proof. ML-KEM-768
is written here from FIPS 203 and ChaCha20-Poly1305 from RFC 8439, with
Python's integers and hashlib. It shares no code with packages/crypto or any
@noble library; it reuses only group-vectors.py's ristretto255 and RFC 9380
code and ballot-validity-vectors.py's ballot code, both independent of
packages/crypto, and its self-checks run first:

- ML-KEM-768 against the accumulated FIPS 203 vectors of Go's crypto/mlkem
  tests (go1.25.0, src/crypto/mlkem/mlkem_test.go, TestAccumulated): 100
  iterations by default, 10 000 with --full (about five minutes);
- ChaCha20-Poly1305 against RFC 8439 §2.8.2 and Appendix A.5, parsed from the
  vendored RFC text.

Every random value comes from SHA-512 or SHA-256 over a fixed label, and each
vector lists the values it used, so any implementation can reproduce its bytes
exactly. The values are test data, never keys.

Usage: python3 -I packages/crypto/scripts/share-encryption-vectors.py <out-dir> [--full]
"""

import hashlib
import importlib.util
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


grp = _load("group_vectors", "group-vectors.py")
bv = _load("ballot_validity_vectors", "ballot-validity-vectors.py")

L = grp.L
G = grp.BASE
IDENTITY = grp.IDENTITY
MAX_OPTIONS = 64
MAX_TRUSTEES = 16
MAX_SEALED = 4 + 64 * MAX_OPTIONS + 16

KEM_TAG = b"abolish/v1/kem/share"
AAD_TAG = b"abolish/v1/kem/share-aad"
CT_TAG = b"abolish/v1/share-ciphertext"
EPHEMERAL_TAG = b"abolish/v1/fs/share-ephemeral"
COMPLAINT_TAG = b"abolish/v1/fs/share-complaint"

u8, u16, u32, scalar, element, ds, H = bv.u8, bv.u16, bv.u32, bv.scalar, bv.element, bv.ds, bv.H


def pt_mul(k, p):
    return grp.mul(k % L, p)


# --- ML-KEM-768 (FIPS 203) ----------------------------------------------------

Q = 3329
N = 256
K = 3
ETA1 = 2
ETA2 = 2
DU = 10
DV = 4
ZETA = 17


def _bitrev7(i):
    return int(f"{i:07b}"[::-1], 2)


ZETAS = [pow(ZETA, _bitrev7(i), Q) for i in range(128)]
GAMMAS = [pow(ZETA, 2 * _bitrev7(i) + 1, Q) for i in range(128)]


def kem_H(s):
    return hashlib.sha3_256(s).digest()


def kem_J(s):
    return hashlib.shake_256(s).digest(32)


def kem_G(s):
    d = hashlib.sha3_512(s).digest()
    return d[:32], d[32:]


def PRF(eta, s, b):
    return hashlib.shake_256(s + bytes([b])).digest(64 * eta)


def byte_encode(f, d):
    bits = 0
    nbits = 0
    out = bytearray()
    for a in f:
        bits |= a << nbits
        nbits += d
        while nbits >= 8:
            out.append(bits & 0xFF)
            bits >>= 8
            nbits -= 8
    return bytes(out)


def byte_decode(b, d):
    m = (1 << d) if d < 12 else Q
    x = int.from_bytes(b, "little")
    return [((x >> (d * i)) & ((1 << d) - 1)) % m for i in range(N)]


def compress(x, d):
    return ((x << d) + Q // 2) // Q % (1 << d)


def decompress(y, d):
    return (y * Q + (1 << (d - 1))) >> d


def sample_ntt(seed):
    xof = hashlib.shake_128(seed)
    # Read generously; rejection sampling consumes 3 bytes per step.
    stream = xof.digest(3 * 1024)
    a = []
    i = 0
    while len(a) < N:
        if i + 3 > len(stream):
            stream = xof.digest(len(stream) * 2)
        c0, c1, c2 = stream[i], stream[i + 1], stream[i + 2]
        i += 3
        d1 = c0 + 256 * (c1 % 16)
        d2 = c1 // 16 + 16 * c2
        if d1 < Q:
            a.append(d1)
        if d2 < Q and len(a) < N:
            a.append(d2)
    return a


def sample_cbd(b, eta):
    bits = int.from_bytes(b, "little")
    f = []
    for i in range(N):
        x = sum((bits >> (2 * i * eta + j)) & 1 for j in range(eta))
        y = sum((bits >> (2 * i * eta + eta + j)) & 1 for j in range(eta))
        f.append((x - y) % Q)
    return f


def ntt(f):
    f = list(f)
    i = 1
    length = 128
    while length >= 2:
        for start in range(0, N, 2 * length):
            z = ZETAS[i]
            i += 1
            for j in range(start, start + length):
                t = z * f[j + length] % Q
                f[j + length] = (f[j] - t) % Q
                f[j] = (f[j] + t) % Q
        length //= 2
    return f


def ntt_inv(f):
    f = list(f)
    i = 127
    length = 2
    while length <= 128:
        for start in range(0, N, 2 * length):
            z = ZETAS[i]
            i -= 1
            for j in range(start, start + length):
                t = f[j]
                f[j] = (t + f[j + length]) % Q
                f[j + length] = z * (f[j + length] - t) % Q
        length *= 2
    return [x * 3303 % Q for x in f]


def mul_ntt(f, g):
    h = [0] * N
    for i in range(128):
        a0, a1, b0, b1 = f[2 * i], f[2 * i + 1], g[2 * i], g[2 * i + 1]
        h[2 * i] = (a0 * b0 + a1 * b1 * GAMMAS[i]) % Q
        h[2 * i + 1] = (a0 * b1 + a1 * b0) % Q
    return h


def poly_add(f, g):
    return [(a + b) % Q for a, b in zip(f, g)]


def kpke_keygen(d):
    rho, sigma = kem_G(d + bytes([K]))
    A = [[sample_ntt(rho + bytes([j, i])) for j in range(K)] for i in range(K)]
    s = [ntt(sample_cbd(PRF(ETA1, sigma, i), ETA1)) for i in range(K)]
    e = [ntt(sample_cbd(PRF(ETA1, sigma, K + i), ETA1)) for i in range(K)]
    t = []
    for i in range(K):
        acc = e[i]
        for j in range(K):
            acc = poly_add(acc, mul_ntt(A[i][j], s[j]))
        t.append(acc)
    ek = b"".join(byte_encode(x, 12) for x in t) + rho
    dk = b"".join(byte_encode(x, 12) for x in s)
    return ek, dk


def kpke_encrypt(ek, m, r):
    t = [byte_decode(ek[384 * i : 384 * (i + 1)], 12) for i in range(K)]
    rho = ek[384 * K :]
    A = [[sample_ntt(rho + bytes([j, i])) for j in range(K)] for i in range(K)]
    y = [ntt(sample_cbd(PRF(ETA1, r, i), ETA1)) for i in range(K)]
    e1 = [sample_cbd(PRF(ETA2, r, K + i), ETA2) for i in range(K)]
    e2 = sample_cbd(PRF(ETA2, r, 2 * K), ETA2)
    u = []
    for i in range(K):
        acc = [0] * N
        for j in range(K):
            acc = poly_add(acc, mul_ntt(A[j][i], y[j]))
        u.append(poly_add(ntt_inv(acc), e1[i]))
    mu = [decompress(b, 1) for b in byte_decode(m, 1)]
    acc = [0] * N
    for i in range(K):
        acc = poly_add(acc, mul_ntt(t[i], y[i]))
    v = poly_add(poly_add(ntt_inv(acc), e2), mu)
    c1 = b"".join(byte_encode([compress(x, DU) for x in u[i]], DU) for i in range(K))
    c2 = byte_encode([compress(x, DV) for x in v], DV)
    return c1 + c2


def kpke_decrypt(dk, c):
    c1, c2 = c[: 32 * DU * K], c[32 * DU * K :]
    u = [[decompress(x, DU) for x in byte_decode(c1[32 * DU * i : 32 * DU * (i + 1)], DU)] for i in range(K)]
    v = [decompress(x, DV) for x in byte_decode(c2, DV)]
    s = [byte_decode(dk[384 * i : 384 * (i + 1)], 12) for i in range(K)]
    acc = [0] * N
    for i in range(K):
        acc = poly_add(acc, mul_ntt(s[i], ntt(u[i])))
    w = [(a - b) % Q for a, b in zip(v, ntt_inv(acc))]
    return byte_encode([compress(x, 1) for x in w], 1)


def keygen_internal(d, z):
    ek, dkp = kpke_keygen(d)
    return ek, dkp + ek + kem_H(ek) + z


def ek_ok(ek):
    """FIPS 203 §7.2 modulus check."""
    if len(ek) != 384 * K + 32:
        return False
    return all(byte_encode(byte_decode(ek[384 * i : 384 * (i + 1)], 12), 12) == ek[384 * i : 384 * (i + 1)] for i in range(K))


def encaps_internal(ek, m):
    assert ek_ok(ek)
    key, r = kem_G(m + kem_H(ek))
    return key, kpke_encrypt(ek, m, r)


def decaps_internal(dk, c):
    dkp = dk[: 384 * K]
    ek = dk[384 * K : 768 * K + 32]
    h = dk[768 * K + 32 : 768 * K + 64]
    z = dk[768 * K + 64 :]
    m2 = kpke_decrypt(dkp, c)
    key2, r2 = kem_G(m2 + h)
    kbar = kem_J(z + c)
    c2 = kpke_encrypt(ek, m2, r2)
    return key2 if c2 == c else kbar


# --- ChaCha20-Poly1305 (RFC 8439) ----------------------------------------------

M32 = 0xFFFFFFFF


def _rotl(v, c):
    return ((v << c) & M32) | (v >> (32 - c))


def _quarter(s, a, b, c, d):
    s[a] = (s[a] + s[b]) & M32
    s[d] = _rotl(s[d] ^ s[a], 16)
    s[c] = (s[c] + s[d]) & M32
    s[b] = _rotl(s[b] ^ s[c], 12)
    s[a] = (s[a] + s[b]) & M32
    s[d] = _rotl(s[d] ^ s[a], 8)
    s[c] = (s[c] + s[d]) & M32
    s[b] = _rotl(s[b] ^ s[c], 7)


def chacha20_block(key, counter, nonce):
    """RFC 8439 §2.3."""
    words = lambda b: [int.from_bytes(b[i : i + 4], "little") for i in range(0, len(b), 4)]
    state = [0x61707865, 0x3320646E, 0x79622D32, 0x6B206574] + words(key) + [counter] + words(nonce)
    s = list(state)
    for _ in range(10):
        _quarter(s, 0, 4, 8, 12)
        _quarter(s, 1, 5, 9, 13)
        _quarter(s, 2, 6, 10, 14)
        _quarter(s, 3, 7, 11, 15)
        _quarter(s, 0, 5, 10, 15)
        _quarter(s, 1, 6, 11, 12)
        _quarter(s, 2, 7, 8, 13)
        _quarter(s, 3, 4, 9, 14)
    return b"".join(((x + y) & M32).to_bytes(4, "little") for x, y in zip(s, state))


def chacha20(key, counter, nonce, data):
    """RFC 8439 §2.4."""
    out = bytearray()
    for i in range(0, len(data), 64):
        block = chacha20_block(key, counter + i // 64, nonce)
        out += bytes(x ^ y for x, y in zip(data[i : i + 64], block))
    return bytes(out)


def poly1305(key, msg):
    """RFC 8439 §2.5."""
    r = int.from_bytes(key[:16], "little") & 0x0FFFFFFC0FFFFFFC0FFFFFFC0FFFFFFF
    s = int.from_bytes(key[16:], "little")
    p = (1 << 130) - 5
    acc = 0
    for i in range(0, len(msg), 16):
        n = int.from_bytes(msg[i : i + 16] + b"\x01", "little")
        acc = (acc + n) * r % p
    return ((acc + s) % (1 << 128)).to_bytes(16, "little")


def _pad16(b):
    return b"\x00" * (-len(b) % 16)


def _aead_tag(key, nonce, aad, ct):
    otk = chacha20_block(key, 0, nonce)[:32]
    mac = aad + _pad16(aad) + ct + _pad16(ct) + len(aad).to_bytes(8, "little") + len(ct).to_bytes(8, "little")
    return poly1305(otk, mac)


def aead_seal(key, nonce, aad, pt):
    """RFC 8439 §2.8: ciphertext ‖ tag."""
    ct = chacha20(key, 1, nonce, pt)
    return ct + _aead_tag(key, nonce, aad, ct)


def aead_open(key, nonce, aad, sealed):
    if len(sealed) < 16:
        return None
    ct, tag = sealed[:-16], sealed[-16:]
    if _aead_tag(key, nonce, aad, ct) != tag:
        return None
    return chacha20(key, 1, nonce, ct)


# --- Self-checks ---------------------------------------------------------------

# Go's crypto/mlkem TestAccumulated (go1.25.0), FIPS 203 final: a SHAKE-128
# stream with empty input gives each iteration's 64-byte seed, 32-byte message
# and 1088-byte random ciphertext; a second SHAKE-128 absorbs ek, ct, k and the
# implicit-rejection key, and its first 32 bytes are compared.
ACCUMULATED = {
    100: "1114b1b6699ed191734fa339376afa7e285c9e6acf6ff0177d346696ce564415",
    10000: "8a518cc63da366322a8e7a818c7a0d63483cb3528d34a4cf42f35d5ad73f22fc",
}


def mlkem_self_check(n):
    stream = hashlib.shake_128(b"").digest(n * (64 + 32 + 1088))
    acc = hashlib.shake_128()
    o = 0
    for _ in range(n):
        seed, m, ct1 = stream[o : o + 64], stream[o + 64 : o + 96], stream[o + 96 : o + 1184]
        o += 1184
        ek, dk = keygen_internal(seed[:32], seed[32:])
        k, ct = encaps_internal(ek, m)
        assert decaps_internal(dk, ct) == k
        acc.update(ek + ct + k + decaps_internal(dk, ct1))
    assert acc.digest(32).hex() == ACCUMULATED[n], "ML-KEM-768 accumulated vectors"


def _rfc_blocks(lines):
    """Labelled hex blocks of an RFC 8439 section: a label line (its colon optional) then hex-dump or colon-hex lines."""
    out = {}
    label = None
    for line in lines:
        dump = re.match(r" {2,3}\d{3}  ((?:[0-9a-f]{2} )*[0-9a-f]{2})(?:  |$)", line)
        colon = re.fullmatch(r" {2,3}((?:[0-9a-f]{2}:)*[0-9a-f]{2}):?", line)
        head = re.fullmatch(r" {2,3}([A-Za-z0-9][A-Za-z0-9 -]*?):{0,2}\s*", line)
        if dump or colon:
            if label is not None:
                out[label] += (dump or colon).group(1).replace(" ", "").replace(":", "")
        elif head:
            label = head.group(1)
            out[label] = ""
        elif line.strip():
            label = None
    return {k: bytes.fromhex(v) for k, v in out.items()}


def aead_self_check():
    text = (HERE.parent.parent / "test-vectors" / "rfc" / "rfc8439.txt").read_text("ascii").split("\n")

    def section(start, end):
        i = text.index(start)
        return text[i + 1 : text.index(end, i + 1)]

    a = _rfc_blocks(section("2.8.2.  Example and Test Vector for AEAD_CHACHA20_POLY1305", "3.  Implementation Advice"))
    nonce = a["32-bit fixed-common part"] + a["IV"]
    sealed = aead_seal(a["Key"], nonce, a["AAD"], a["Plaintext"])
    assert sealed == a["Ciphertext"] + a["Tag"], "RFC 8439 2.8.2"
    b = _rfc_blocks(section("A.5.  ChaCha20-Poly1305 AEAD Decryption", "Appendix B.  Performance Measurements of ChaCha20"))
    pt = aead_open(b["The ChaCha20 Key"], b["The nonce"], b["The AAD"], b["Ciphertext"] + b["Received Tag"])
    assert pt == b["Plaintext"], "RFC 8439 A.5"
    tampered = b["Ciphertext"] + bytes([b["Received Tag"][0] ^ 1]) + b["Received Tag"][1:]
    assert aead_open(b["The ChaCha20 Key"], b["The nonce"], b["The AAD"], tampered) is None


# --- Share encryption (docs/spec/share-encryption.md) ----------------------------

NONCE = bytes(12)


def kem_keypair(seed, x):
    assert len(seed) == 64 and 0 < x < L
    ek, dk = keygen_internal(seed[:32], seed[32:])
    return {"ek": ek, "dh": pt_mul(x, G), "seed": seed, "x": x, "dk": dk}


def enc_kem_key(key):
    return key["ek"] + element(key["dh"])


def combine(ss_m, ss_dh, ct_dh, dh):
    return H(ds(KEM_TAG, ss_m + element(ss_dh) + element(ct_dh) + element(dh)))


def aad(definition_hash, seat, vss):
    return ds(AAD_TAG, definition_hash + u16(bv.BALLOT_RECORD_TYPE) + u8(bv.BALLOT_VERSION) + u8(seat) + bv.enc_vss(vss))


def enc_ciphertext(ct_m, ct_dh, c, z, sealed):
    return ct_m + element(ct_dh) + scalar(c) + scalar(z) + u32(len(sealed)) + sealed


def dec_ciphertext(b):
    """Strict decode of share_ciphertext; None on any failure."""
    head = 1088 + 32 + 64 + 4
    if len(b) < head:
        return None
    ct_m, dh_b = b[:1088], b[1088:1120]
    c, z = int.from_bytes(b[1120:1152], "little"), int.from_bytes(b[1152:1184], "little")
    n = int.from_bytes(b[1184:1188], "big")
    if c >= L or z >= L or n > MAX_SEALED or len(b) != head + n:
        return None
    if dh_b == bytes(32):
        return None
    p = grp.decode(dh_b)
    if p is None:
        return None
    return {"ct_m": ct_m, "ct_dh": p, "c": c, "z": z, "sealed": b[head:]}


def share_hash(ct):
    return H(ds(CT_TAG, ct))


def ephemeral_challenge(definition_hash, seat, dh, vss, ct_m, ct_dh, sealed, a):
    t = (
        definition_hash
        + u16(bv.BALLOT_RECORD_TYPE)
        + u8(bv.BALLOT_VERSION)
        + u8(seat)
        + element(dh)
        + bv.enc_vss(vss)
        + ct_m
        + element(ct_dh)
        + u32(len(sealed))
        + sealed
        + element(a, True)
    )
    return bv.hash_to_scalar(t, EPHEMERAL_TAG)


def pok_ok(definition_hash, seat, dh, vss, ct):
    a = grp.add(pt_mul(ct["z"], G), grp.neg(pt_mul(ct["c"], ct["ct_dh"])))
    return ephemeral_challenge(definition_hash, seat, dh, vss, ct["ct_m"], ct["ct_dh"], ct["sealed"], a) == ct["c"]


def encrypt(definition_hash, seat, key, vss, shares_bytes, m, e, w, dh_scalar=None):
    """One seat's ciphertext; returns the encoding and the intermediate values. `dh_scalar` (a cheat) seals under another DH value."""
    ss_m, ct_m = encaps_internal(key["ek"], m)
    ct_dh = pt_mul(e, G)
    ss_dh = pt_mul(e if dh_scalar is None else dh_scalar, key["dh"])
    k = combine(ss_m, ss_dh, ct_dh, key["dh"])
    a = aad(definition_hash, seat, vss)
    sealed = aead_seal(k, NONCE, a, shares_bytes)
    c = ephemeral_challenge(definition_hash, seat, key["dh"], vss, ct_m, ct_dh, sealed, pt_mul(w, G))
    ct = enc_ciphertext(ct_m, ct_dh, c, (w + c * e) % L, sealed)
    return ct, {"kemSharedSecret": ss_m.hex(), "dhSharedSecret": element(ss_dh).hex(), "aeadKey": k.hex(), "associatedDataHash": H(a).hex()}


def dec_shares(b, m):
    """`list<share, MAX_OPTIONS>` with exactly m entries; None otherwise."""
    if len(b) < 4:
        return None
    n = int.from_bytes(b[:4], "big")
    if n > MAX_OPTIONS or n != m or len(b) != 4 + 64 * n:
        return None
    out = []
    for j in range(n):
        v = int.from_bytes(b[4 + 64 * j : 36 + 64 * j], "little")
        r = int.from_bytes(b[36 + 64 * j : 68 + 64 * j], "little")
        if v >= L or r >= L:
            return None
        out.append({"v": v, "r": r})
    return out


def open_with(k, definition_hash, seat, vss, sealed):
    """Decryption steps 4 and 5 with a known AEAD key: None if they pass, else the code."""
    pt = aead_open(k, NONCE, aad(definition_hash, seat, vss), sealed)
    shares = None if pt is None else dec_shares(pt, len(vss))
    if shares is None:
        return "share-decrypt"
    if not bv.check_shares(vss, seat, shares):
        return "share-check"
    return None


def decrypt(definition_hash, seat, key, vss, ct_bytes):
    ct = dec_ciphertext(ct_bytes)
    if ct is None:
        return "share-malformed"
    if not pok_ok(definition_hash, seat, key["dh"], vss, ct):
        return "share-proof"
    ss_m = decaps_internal(key["dk"], ct["ct_m"])
    k = combine(ss_m, pt_mul(key["x"], ct["ct_dh"]), ct["ct_dh"], key["dh"])
    return open_with(k, definition_hash, seat, vss, ct["sealed"]) or "ok"


def check_posting(definition_hash, seat, key, vss, share_hashes, ct_bytes, m):
    if len(m) != 32:
        return "posting-malformed", None
    ct = dec_ciphertext(ct_bytes)
    if ct is None:
        return "posting-malformed", None
    if share_hash(ct_bytes) != share_hashes[seat - 1]:
        return "posting-hash", None
    if not pok_ok(definition_hash, seat, key["dh"], vss, ct):
        return "posting-proof", None
    ss_m, ct_m = encaps_internal(key["ek"], m)
    if ct_m != ct["ct_m"]:
        return "posting-encapsulation", None
    return "ok", (ct, ss_m)


def complaint_challenge(definition_hash, seat, dh, sh, ct_dh, d, a1, a2):
    t = definition_hash + u8(seat) + element(dh) + sh + element(ct_dh) + element(d) + element(a1, True) + element(a2, True)
    return bv.hash_to_scalar(t, COMPLAINT_TAG)


def raw_complaint(definition_hash, seat, key, ct_bytes, w):
    """The complaint proof's arithmetic alone, without the trustee's preconditions (for invalid vectors)."""
    ct = dec_ciphertext(ct_bytes)
    d = pt_mul(key["x"], ct["ct_dh"])
    c = complaint_challenge(definition_hash, seat, key["dh"], share_hash(ct_bytes), ct["ct_dh"], d, pt_mul(w, G), pt_mul(w, ct["ct_dh"]))
    return {"dh": d, "c": c, "z": (w + c * key["x"]) % L}


def prove_complaint(definition_hash, seat, key, vss, share_hashes, ct_bytes, m, w):
    """A trustee's complaint: only for a posting that passes and whose shares fail its intake."""
    code, _ = check_posting(definition_hash, seat, key, vss, share_hashes, ct_bytes, m)
    assert code == "ok"
    assert decrypt(definition_hash, seat, key, vss, ct_bytes) in ("share-decrypt", "share-check")
    return raw_complaint(definition_hash, seat, key, ct_bytes, w)


def enc_complaint(p):
    return element(p["dh"]) + scalar(p["c"]) + scalar(p["z"])


def check_complaint(definition_hash, seat, key, vss, share_hashes, ct_bytes, m, proof):
    code, passed = check_posting(definition_hash, seat, key, vss, share_hashes, ct_bytes, m)
    if code != "ok":
        return code
    ct, ss_m = passed
    c, z, d = proof["c"], proof["z"], proof["dh"]
    a1 = grp.add(pt_mul(z, G), grp.neg(pt_mul(c, key["dh"])))
    a2 = grp.add(pt_mul(z, ct["ct_dh"]), grp.neg(pt_mul(c, d)))
    if complaint_challenge(definition_hash, seat, key["dh"], share_hashes[seat - 1], ct["ct_dh"], d, a1, a2) != c:
        return "complaint-proof"
    k = combine(ss_m, d, ct["ct_dh"], key["dh"])
    return "ok" if open_with(k, definition_hash, seat, vss, ct["sealed"]) else "complaint-unfounded"


# --- Vectors ---------------------------------------------------------------------


def nonzero_scalar(rng):
    x = rng.scalar()
    assert x != 0
    return x


def trustee_keys(label, n):
    keys = []
    for i in range(1, n + 1):
        rng = bv.Rng(f"kem-key/{label}/{i}")
        keys.append(kem_keypair(rng.bytes32() + rng.bytes32(), nonzero_scalar(rng)))
    return keys


def key_json(key):
    return {"seed": key["seed"].hex(), "x": str(key["x"]), "publicKey": enc_kem_key(key).hex()}


def make_encrypted_ballot(label, ctx, votes, keys, cheat=None):
    """A ballot whose share hashes are its real ciphertexts' hashes; `cheat(seat, shares_bytes, key)` may alter one seat's ciphertext."""
    _, _, shares = bv.make_ballot("ballot/" + label, ctx, votes, share_hashes=[bytes(32)] * ctx["panelSize"])
    # make_ballot draws the polynomials first, so both calls share them.
    vote, randomness, shares2 = bv.make_ballot("ballot/" + label, ctx, votes, share_hashes=[bytes(32)] * ctx["panelSize"])
    assert shares == shares2
    rng = bv.Rng("encapsulation/" + label)
    cts, inter, enc_rand = [], [], []
    for seat in range(1, ctx["panelSize"] + 1):
        m, e, w = rng.bytes32(), nonzero_scalar(rng), nonzero_scalar(rng)
        sb = bv.enc_shares(shares[seat - 1])
        if cheat is not None:
            ct, iv = cheat(seat, sb, keys[seat - 1], vote["vss"], m, e, w)
        else:
            ct, iv = encrypt(ctx["definitionHash"], seat, keys[seat - 1], vote["vss"], sb, m, e, w)
        cts.append(ct)
        inter.append(iv)
        enc_rand.append({"m": m.hex(), "e": str(e), "w": str(w)})
    hashes = [share_hash(ct) for ct in cts]
    vote, randomness, _ = bv.make_ballot("ballot/" + label, ctx, votes, share_hashes=hashes)
    assert bv.check_validity(ctx, vote) == "ok"
    return {"ctx": ctx, "vote": vote, "randomness": randomness, "shares": shares, "cts": cts, "inter": inter, "encRand": enc_rand, "keys": keys}


def main():
    grp.self_check()
    aead_self_check()
    mlkem_self_check(10000 if "--full" in sys.argv[2:] else 100)
    out = sys.argv[1]

    keys3 = trustee_keys("panel-3", 3)
    keys16 = trustee_keys("panel-16", 16)
    keys2 = trustee_keys("panel-2", 2)
    plural = bv.context("share-plurality", 3, 0, 1, 2, 3)
    wide = bv.context("share-options-max", 64, 0, 64, 2, 2, 1)
    many = bv.context("share-trustees-max", 2, 0, 1, 16, 16)

    made = {}
    ballots = []

    panels = {"panel-3": keys3, "panel-2": keys2, "panel-16": keys16}

    def ballot(id_, desc, ctx, votes, panel, cheat=None, result=None):
        keys = panels[panel]
        b = make_encrypted_ballot(id_, ctx, votes, keys, cheat)
        made[id_] = b
        entry = {
            "id": id_,
            "description": desc,
            "context": bv.ctx_json(ctx),
            "panel": panel,
            "votes": votes,
            "randomness": b["randomness"],
            "encapsulation": b["encRand"],
            "ciphertexts": [ct.hex() for ct in b["cts"]],
            "intermediate": b["inter"],
            "shareHashes": [share_hash(ct).hex() for ct in b["cts"]],
            "committedVote": bv.enc_committed_vote(b["vote"]).hex(),
            "decryptions": [],
        }
        for seat in range(1, ctx["panelSize"] + 1):
            got = decrypt(ctx["definitionHash"], seat, keys[seat - 1], b["vote"]["vss"], b["cts"][seat - 1])
            want = "ok" if result is None else result(seat)
            assert got == want, (id_, seat, got, want)
            d = {"seat": seat, "result": got}
            if got == "ok":
                d["shares"] = bv.enc_shares(b["shares"][seat - 1]).hex()
            entry["decryptions"].append(d)
        ballots.append(entry)

    ballot("plurality", "Plurality, 3 options, k = 2, n = 3: every seat decrypts and checks", plural, [0, 1, 0], "panel-3")
    ballot("options-max", "MAX_OPTIONS: 64 options, k = n = 2; each sealed field is the 4116-byte maximum", wide, [1 if j % 5 == 0 else 0 for j in range(64)], "panel-2")
    ballot("trustees-max", "MAX_TRUSTEES: k = n = 16, seat 16 in the associated data", many, [1, 0], "panel-16")

    def bad_shares(seat, sb, key, vss, m, e, w):
        # Seat 2's shares with v + 1 in the first option, sealed correctly.
        if seat == 2:
            v = (int.from_bytes(sb[4:36], "little") + 1) % L
            sb = sb[:4] + scalar(v) + sb[36:]
        return encrypt(plural["definitionHash"], seat, key, vss, sb, m, e, w)

    def wrong_key(seat, sb, key, vss, m, e, w):
        # Seat 2's ciphertext sealed under a key from the wrong DH value, so no one can open it.
        return encrypt(plural["definitionHash"], seat, key, vss, sb, m, e, w, dh_scalar=e + 1 if seat == 2 else None)

    def short_list(seat, sb, key, vss, m, e, w):
        # Seat 1's plaintext lists m − 1 shares.
        if seat == 1:
            sb = u32(2) + sb[4 : 4 + 128]
        return encrypt(plural["definitionHash"], seat, key, vss, sb, m, e, w)

    ballot("bad-share", "A dishonest client: seat 2's first share has v + 1, sealed correctly", plural, [1, 0, 0], "panel-3", bad_shares, lambda s: "share-check" if s == 2 else "ok")
    ballot("bad-seal", "A dishonest client: seat 2's shares sealed under a key from the wrong DH value", plural, [0, 0, 1], "panel-3", wrong_key, lambda s: "share-decrypt" if s == 2 else "ok")
    ballot("short-list", "A dishonest client: seat 1's plaintext has m − 1 shares", plural, [0, 0, 0], "panel-3", short_list, lambda s: "share-decrypt" if s == 1 else "ok")

    victim = made["plurality"]["cts"][0]

    def copy_ephemeral(seat, sb, key, vss, m, e, w):
        # The attack the proof of knowledge stops: seat 1's ciphertext reuses the
        # plurality ballot's ct_dh and proof with its own ML-KEM part and garbage,
        # so that an honest complaint would reveal the victim's DH value.
        ct, iv = encrypt(plural["definitionHash"], seat, key, vss, sb, m, e, w)
        if seat != 1:
            return ct, iv
        _, ct_m = encaps_internal(key["ek"], m)
        return ct_m + victim[1088:1184] + u32(len(sb) + 16) + bytes(len(sb) + 16), dict(iv, aeadKey=None)

    ballot("copied-ephemeral", "An attacker's ballot: seat 1's ciphertext copies the plurality ballot's ct_dh and proof over its own ML-KEM part and a garbage seal", plural, [0, 1, 0], "panel-3", copy_ephemeral, lambda s: "share-proof" if s == 1 else "ok")

    # Decryptions under the wrong context or of altered ciphertexts.
    p = made["plurality"]
    other = made["bad-seal"]
    decrypt_failures = []

    def fail(id_, desc, seat, key_seat, ct, definition_hash=None, vss=None, expect="share-proof"):
        dh_ = definition_hash or plural["definitionHash"]
        got = decrypt(dh_, seat, keys3[key_seat - 1], vss or p["vote"]["vss"], ct)
        assert got == expect, (id_, got)
        decrypt_failures.append(
            {
                "id": id_,
                "description": desc,
                "definitionHash": dh_.hex(),
                "seat": seat,
                "keySeat": key_seat,
                "vss": bv.enc_vss(vss or p["vote"]["vss"]).hex(),
                "ciphertext": ct.hex(),
                "result": expect,
            }
        )

    ct1 = p["cts"][0]
    fail("other-seat", "Seat 2 opens seat 1's ciphertext with its own key", 2, 2, ct1)
    fail("other-seat-aad", "Seat 1's key, but the associated data names seat 2", 2, 1, ct1)
    fail("other-definition", "Seat 1's ciphertext under another definition hash", 1, 1, ct1, definition_hash=H(b"another election"))
    fail("other-vss", "Seat 1's ciphertext against another ballot's VSS commitments", 1, 1, ct1, vss=other["vote"]["vss"])
    flip = lambda b, i: b[:i] + bytes([b[i] ^ 1]) + b[i + 1 :]
    fail("flipped-tag", "The last byte of the AEAD tag flipped", 1, 1, flip(ct1, len(ct1) - 1))
    fail("flipped-mlkem", "The first byte of the ML-KEM ciphertext flipped: implicit rejection, then the AEAD fails", 1, 1, flip(ct1, 0))
    fail("flipped-dh", "ct_dh replaced by another valid element", 1, 1, ct1[:1088] + element(pt_mul(5, G)) + ct1[1120:])
    fail("flipped-pok", "The proof's response z + 1", 1, 1, ct1[:1152] + scalar((int.from_bytes(ct1[1152:1184], "little") + 1) % L) + ct1[1184:])
    fail("pok-z-l", "The proof's response is ℓ", 1, 1, ct1[:1152] + L.to_bytes(32, "little") + ct1[1184:], expect="share-malformed")
    fail("identity-dh", "ct_dh is the identity", 1, 1, ct1[:1088] + bytes(32) + ct1[1120:], expect="share-malformed")
    fail("truncated", "One byte short", 1, 1, ct1[:-1], expect="share-malformed")

    # Postings.
    postings = []

    def posting(id_, desc, b, seat, ct, m, expect):
        got, _ = check_posting(b["ctx"]["definitionHash"], seat, b["keys"][seat - 1], b["vote"]["vss"], [share_hash(c) for c in b["cts"]], ct, m)
        assert got == expect, (id_, got)
        postings.append({"id": id_, "description": desc, "ballot": b["id"] if "id" in b else None, "seat": seat, "ciphertext": ct.hex(), "m": m.hex(), "result": expect})

    for b_id in made:
        made[b_id]["id"] = b_id
    m1 = bytes.fromhex(p["encRand"][0]["m"])
    m2 = bytes.fromhex(p["encRand"][1]["m"])
    posting("pass", "Seat 1's ciphertext with its own m", p, 1, p["cts"][0], m1, "ok")
    posting("pass-seat-3", "Seat 3's ciphertext with its own m", p, 3, p["cts"][2], bytes.fromhex(p["encRand"][2]["m"]), "ok")
    posting("wrong-m", "Seat 1's ciphertext with seat 2's m", p, 1, p["cts"][0], m2, "posting-encapsulation")
    posting("wrong-seat", "Seat 1's ciphertext and m posted for seat 2", p, 2, p["cts"][0], m1, "posting-hash")
    posting("short-m", "A 31-byte m", p, 1, p["cts"][0], m1[:31], "posting-malformed")
    posting("malformed", "ct_dh is the identity", p, 1, p["cts"][0][:1088] + bytes(32) + p["cts"][0][1120:], m1, "posting-malformed")
    posting("altered", "A flipped tag byte: the hash no longer matches", p, 1, flip(p["cts"][0], len(p["cts"][0]) - 1), m1, "posting-hash")
    cp = made["copied-ephemeral"]
    posting("copied-ephemeral", "The attacker's seat 1 ciphertext with its own m: its copied proof fails", cp, 1, cp["cts"][0], bytes.fromhex(cp["encRand"][0]["m"]), "posting-proof")
    bs = made["bad-share"]
    posting("pass-bad-share", "The dishonest client's seat 2 ciphertext: the public check passes", bs, 2, bs["cts"][1], bytes.fromhex(bs["encRand"][1]["m"]), "ok")

    # Complaints.
    complaints = []

    def complaint(id_, desc, b, seat, ct, m, proof, expect, w=None):
        hashes = [share_hash(c) for c in b["cts"]]
        got = check_complaint(b["ctx"]["definitionHash"], seat, b["keys"][seat - 1], b["vote"]["vss"], hashes, ct, m, proof)
        assert got == expect, (id_, got)
        entry = {"id": id_, "description": desc, "ballot": b["id"], "seat": seat, "ciphertext": ct.hex(), "m": m.hex(), "proof": enc_complaint(proof).hex(), "result": expect}
        if w is not None:
            entry["w"] = str(w)
        complaints.append(entry)

    rng = bv.Rng("complaint")
    for b_id, seat, desc, expect in (
        ("bad-share", 2, "Proven: seat 2's posted shares fail the share check", "ok"),
        ("bad-seal", 2, "Proven: seat 2's posted ciphertext doesn't open", "ok"),
        ("short-list", 1, "Proven: seat 1's posted plaintext has m − 1 shares", "ok"),
        ("plurality", 1, "Unfounded: seat 1's posted shares are valid", "complaint-unfounded"),
    ):
        b = made[b_id]
        w = nonzero_scalar(rng)
        ct = b["cts"][seat - 1]
        mm = bytes.fromhex(b["encRand"][seat - 1]["m"])
        hashes = [share_hash(c) for c in b["cts"]]
        if expect == "ok":
            proof = prove_complaint(b["ctx"]["definitionHash"], seat, b["keys"][seat - 1], b["vote"]["vss"], hashes, ct, mm, w)
        else:
            # An honest trustee never makes this one: its preconditions fail.
            proof = raw_complaint(b["ctx"]["definitionHash"], seat, b["keys"][seat - 1], ct, w)
            w = None
        complaint(b_id + "-complaint", desc, b, seat, ct, bytes.fromhex(b["encRand"][seat - 1]["m"]), proof, expect, w)

    b = made["bad-share"]
    ct, m = b["cts"][1], bytes.fromhex(b["encRand"][1]["m"])
    good = prove_complaint(plural["definitionHash"], 2, b["keys"][1], b["vote"]["vss"], [share_hash(c) for c in b["cts"]], ct, m, nonzero_scalar(rng))
    complaint("proof-z", "The response z + 1", b, 2, ct, m, dict(good, z=(good["z"] + 1) % L), "complaint-proof")
    complaint("proof-c", "The challenge c + 1", b, 2, ct, m, dict(good, c=(good["c"] + 1) % L), "complaint-proof")
    complaint("proof-dh", "Another DH value with the same proof", b, 2, ct, m, dict(good, dh=grp.add(good["dh"], G)), "complaint-proof")
    forged = raw_complaint(plural["definitionHash"], 2, b["keys"][0], ct, nonzero_scalar(rng))
    complaint("other-key", "Proved with seat 1's key for seat 2's posting", b, 2, ct, m, forged, "complaint-proof")
    complaint("bad-posting", "A complaint about a posting that fails the public check", b, 2, ct, bytes.fromhex(b["encRand"][0]["m"]), good, "posting-encapsulation")
    other_def = raw_complaint(H(b"another election"), 2, b["keys"][1], ct, nonzero_scalar(rng))
    complaint("other-definition", "Proved under another definition hash", b, 2, ct, m, other_def, "complaint-proof")
    complaint("copied-ephemeral", "A complaint about the attacker's copied-ephemeral posting: void, so nothing is revealed", cp, 1, cp["cts"][0], bytes.fromhex(cp["encRand"][0]["m"]), raw_complaint(plural["definitionHash"], 1, cp["keys"][0], cp["cts"][0], nonzero_scalar(rng)), "posting-proof")

    # Codec rejections.
    decode = []

    def rej(id_, desc, kind, enc, err):
        decode.append({"id": id_, "description": desc, "type": kind, "encoding": enc.hex(), "error": err})

    def accept(id_, desc, kind, enc):
        decode.append({"id": id_, "description": desc, "type": kind, "encoding": enc.hex(), "error": None})

    k0 = enc_kem_key(keys3[0])
    accept("kem-key", "Seat 1's key", "kem-key", k0)

    def set_coeff(ek, idx, value):
        """ek with 12-bit coefficient `idx` set to `value` (FIPS 203 ByteEncode12 layout)."""
        b = bytearray(ek)
        j = (idx // 2) * 3
        if idx % 2 == 0:
            b[j] = value & 0xFF
            b[j + 1] = (b[j + 1] & 0xF0) | (value >> 8)
        else:
            b[j + 1] = (b[j + 1] & 0x0F) | ((value & 0x0F) << 4)
            b[j + 2] = value >> 4
        return bytes(b)

    for idx, value, label in ((0, 3329, "first-q"), (767, 4095, "last-4095"), (300, 3329, "even-q"), (301, 3329, "odd-q")):
        bad = set_coeff(keys3[0]["ek"], idx, value)
        assert not ek_ok(bad)
        rej(f"kem-key-modulus-{label}", f"Coefficient {idx} set to {value}: fails the modulus check", "kem-key", bad + element(keys3[0]["dh"]), "non-canonical")
    edge = set_coeff(keys3[0]["ek"], 767, 3328)
    assert ek_ok(edge)
    accept("kem-key-modulus-edge", "Coefficient 767 set to 3328, the largest allowed", "kem-key", edge + element(keys3[0]["dh"]))
    rej("kem-key-identity", "dh is the identity", "kem-key", keys3[0]["ek"] + bytes(32), "non-canonical")
    rej("kem-key-truncated", "One byte short", "kem-key", k0[:-1], "truncated")
    rej("kem-key-trailing", "One byte after the last field", "kem-key", k0 + b"\x00", "trailing-bytes")
    sk = keys3[0]["seed"] + scalar(keys3[0]["x"])
    accept("kem-secret", "Seat 1's secret key", "kem-secret", sk)
    rej("kem-secret-zero", "x = 0", "kem-secret", keys3[0]["seed"] + bytes(32), "non-canonical")
    rej("kem-secret-l", "x = ℓ", "kem-secret", keys3[0]["seed"] + L.to_bytes(32, "little"), "non-canonical")
    wct = made["options-max"]["cts"][0]
    assert int.from_bytes(wct[1184:1188], "big") == MAX_SEALED
    accept("ciphertext-max", "A ciphertext whose sealed field is the 4116-byte maximum", "share-ciphertext", wct)
    rej("ciphertext-over-max", "A sealed field of 4117 bytes", "share-ciphertext", wct[:1184] + u32(MAX_SEALED + 1) + wct[1188:] + b"\x00", "length-over-max")
    rej("ciphertext-identity", "ct_dh is the identity", "share-ciphertext", ct1[:1088] + bytes(32) + ct1[1120:], "non-canonical")
    rej("ciphertext-pok-c-l", "The proof's challenge is ℓ", "share-ciphertext", ct1[:1120] + L.to_bytes(32, "little") + ct1[1152:], "non-canonical")
    rej("ciphertext-non-canonical", "ct_dh is a non-canonical encoding (field element p)", "share-ciphertext", ct1[:1088] + (2**255 - 19).to_bytes(32, "little") + ct1[1120:], "non-canonical")
    rej("ciphertext-truncated", "One byte short", "share-ciphertext", ct1[:-1], "truncated")
    rej("ciphertext-trailing", "One byte after the last field", "share-ciphertext", ct1 + b"\x00", "trailing-bytes")
    cpp = bytes.fromhex(complaints[0]["proof"])
    accept("complaint", "A proven complaint's proof", "complaint-proof", cpp)
    rej("complaint-identity", "dh is the identity", "complaint-proof", bytes(32) + cpp[32:], "non-canonical")
    rej("complaint-c-l", "c = ℓ", "complaint-proof", cpp[:32] + L.to_bytes(32, "little") + cpp[64:], "non-canonical")
    rej("complaint-z-l", "z = ℓ", "complaint-proof", cpp[:64] + L.to_bytes(32, "little"), "non-canonical")

    data = {
        "format": "abolish-share-encryption-vectors/1",
        "title": "Share encryption: hybrid KEM, ciphertexts, decryption, postings and complaints",
        "spec": "docs/spec/share-encryption.md",
        "generator": (
            "Printed by packages/crypto/scripts/share-encryption-vectors.py, an implementation of "
            "docs/spec/share-encryption.md with ML-KEM-768 written from FIPS 203 and ChaCha20-Poly1305 "
            "from RFC 8439 in Python's integers and hashlib, sharing no code with packages/crypto or any "
            "@noble library; it reuses only group-vectors.py's ristretto255 and RFC 9380 code and "
            "ballot-validity-vectors.py's ballot code. Its ML-KEM-768 is checked first against the "
            "accumulated FIPS 203 vectors of Go's crypto/mlkem tests and its AEAD against RFC 8439 "
            "§2.8.2 and A.5. Every ballot's committed vote passes the validity check, and every "
            "decryption, posting and complaint is checked to give the result it lists. The randomness is "
            "SHA-512 and SHA-256 of fixed labels: test data only."
        ),
        "tags": {
            "kem": KEM_TAG.decode(),
            "aad": AAD_TAG.decode(),
            "ciphertext": CT_TAG.decode(),
            "ephemeral": EPHEMERAL_TAG.decode(),
            "complaint": COMPLAINT_TAG.decode(),
        },
        "panels": {name: [key_json(k) for k in keys] for name, keys in panels.items()},
        "ballots": ballots,
        "decryptFailures": decrypt_failures,
        "postings": postings,
        "complaints": complaints,
        "decode": decode,
    }
    with open(f"{out}/share-encryption.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
