#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/group-registry.json.

A second implementation of docs/spec/contracts.md (Group registry): the
addition and removal records, their EIP-712 digests, the registrars'
secp256k1 signatures and the forbidden commitments. It is written from the
spec and the standards (EIP-712, SEC 1 v2, RFC 6979, EIP-2) with Python's
standard library only, and shares no code with packages/crypto or
packages/contracts. Python's hashlib has no Keccak-256 (Ethereum's padding),
so this file carries its own Keccak-f[1600] sponge.

Before printing anything it checks: the sponge with SHA3-256's padding against
hashlib.sha3_256 and with Keccak-256's padding against two published answers;
the address of secret key 1; RFC 6979 over secp256k1 against the widely
published "Satoshi Nakamoto" signature; and EIP-712's own example (the "Mail"
message in the EIP), its domain separator, digest and signature included.

Usage: python3 -I packages/crypto/scripts/group-registry-vectors.py <out-dir>
"""

import hashlib
import hmac
import json
import pathlib
import sys

# ---------------------------------------------------------------- Keccak-256

ROUND_CONSTANTS = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
ROTATIONS = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]
MASK = (1 << 64) - 1


def rotl(v, n):
    return ((v << n) | (v >> (64 - n))) & MASK if n else v


def keccak_f(a):
    for rc in ROUND_CONSTANTS:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ rotl(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = rotl(a[x][y], ROTATIONS[x][y])
        a = [[b[x][y] ^ (~b[(x + 1) % 5][y] & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def sponge256(msg, pad):
    rate = 136
    p = bytearray(msg)
    p.append(pad)
    while len(p) % rate:
        p.append(0)
    p[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(p), rate):
        block = p[off : off + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            a[x][y] ^= int.from_bytes(block[8 * i : 8 * i + 8], "little")
        a = keccak_f(a)
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


def keccak256(msg):
    return sponge256(msg, 0x01)


# ----------------------------------------------------------------- secp256k1

P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)
HALF_N = (N - 1) // 2


def add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if p1 == p2:
        lam = 3 * x1 * x1 * pow(2 * y1, -1, P) % P
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


assert (G[1] ** 2 - G[0] ** 3 - 7) % P == 0 and mul(N, G) is None


def address(d):
    x, y = mul(d, G)
    return keccak256(x.to_bytes(32, "big") + y.to_bytes(32, "big"))[12:]


def rfc6979_k(d, h1):
    """RFC 6979 §3.2 with HMAC-SHA-256, qlen = hlen = 256 (as Ethereum
    signers use it over a 32-byte digest)."""
    x = d.to_bytes(32, "big")
    h = (int.from_bytes(h1, "big") % N).to_bytes(32, "big")
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


def sign(d, digest):
    """ECDSA over the 32-byte digest itself, low-s, with v = 27 + the parity
    of R's y after normalising s (EIP-2). Returns (r, s, v)."""
    e = int.from_bytes(digest, "big")
    k = rfc6979_k(d, digest)
    rx, ry = mul(k, G)
    r = rx % N
    s = pow(k, -1, N) * (e + r * d) % N
    assert r and s and rx < N  # rx ≥ N happens with negligible probability
    parity = ry & 1
    if s > HALF_N:
        s, parity = N - s, parity ^ 1
    return r, s, 27 + parity


def recover(digest, r, s, v):
    """ecrecover with EIP-2's rules: the signer's address, or None."""
    if v not in (27, 28) or not (1 <= r < N) or not (1 <= s <= HALF_N):
        return None
    x = r
    rhs = (x * x * x + 7) % P
    y = pow(rhs, (P + 1) // 4, P)
    if y * y % P != rhs:
        return None
    if y & 1 != v - 27:
        y = P - y
    e = int.from_bytes(digest, "big")
    rinv = pow(r, -1, N)
    q = add(mul(s * rinv % N, (x, y)), mul((-e * rinv) % N, G))
    if q is None:
        return None
    return keccak256(q[0].to_bytes(32, "big") + q[1].to_bytes(32, "big"))[12:]


# ------------------------------------------------------------------- EIP-712

def word(i):
    assert 0 <= i < 2**256
    return i.to_bytes(32, "big")


def type_hash(t):
    return keccak256(t.encode())


DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
ADD_TYPE = "AddMembers(uint64 groupId,uint8 tier,uint64 firstIndex,uint256[] commitments)"
REMOVE_TYPE = "RemoveMembers(uint64 groupId,uint8 tier,uint64[] indices)"
NAME, VERSION = "Abolish group registry", "1"


def domain_separator(name, version, chain_id, contract):
    return keccak256(
        type_hash(DOMAIN_TYPE)
        + keccak256(name.encode())
        + keccak256(version.encode())
        + word(chain_id)
        + bytes(12)
        + contract
    )


def eip712_digest(separator, struct_hash):
    return keccak256(b"\x19\x01" + separator + struct_hash)


def add_struct_hash(group_id, tier, first_index, commitments):
    arr = keccak256(b"".join(word(c) for c in commitments))
    return keccak256(type_hash(ADD_TYPE) + word(group_id) + word(tier) + word(first_index) + arr)


def remove_struct_hash(group_id, tier, indices):
    arr = keccak256(b"".join(word(i) for i in indices))
    return keccak256(type_hash(REMOVE_TYPE) + word(group_id) + word(tier) + arr)


# --------------------------------------------------------------- self-checks

def self_check():
    for n in (0, 1, 31, 32, 64, 135, 136, 137, 271, 272, 1000):
        m = bytes((i * 7 + n) & 0xFF for i in range(n))
        assert sponge256(m, 0x06) == hashlib.sha3_256(m).digest(), n
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256(bytes(32)).hex() == "290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563"
    # The address of secret key 1.
    assert address(1).hex() == "7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    # RFC 6979 over secp256k1/SHA-256: secret key 1, message "Satoshi Nakamoto".
    h = hashlib.sha256(b"Satoshi Nakamoto").digest()
    assert rfc6979_k(1, h) == 0x8F8A276C19F4149656B280621E358CCE24F5F52542772691EE69063B74F15D15
    r, s, _ = sign(1, h)
    assert r == 0x934B1EA10A4B3C1757E2B0C017D0B6143CE3C9A7E6A4A49860D7A6AB210EE3D8
    assert s == 0x2442CE9D2B916064108014783E923EC36B49743E2FFA1C4496F01A512AAFD9E5
    # EIP-712's example: Mail from Cow to Bob, signed with keccak256("cow").
    person = "Person(string name,address wallet)"
    mail = "Mail(Person from,Person to,string contents)" + person

    def person_hash(name, wallet):
        return keccak256(type_hash(person) + keccak256(name.encode()) + bytes(12) + bytes.fromhex(wallet))

    sep = domain_separator("Ether Mail", "1", 1, bytes.fromhex("CcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"))
    assert sep.hex() == "f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f"
    mail_hash = keccak256(
        type_hash(mail)
        + person_hash("Cow", "CD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826")
        + person_hash("Bob", "bBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB")
        + keccak256(b"Hello, Bob!")
    )
    assert mail_hash.hex() == "c52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e"
    digest = eip712_digest(sep, mail_hash)
    assert digest.hex() == "be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2"
    cow = int.from_bytes(keccak256(b"cow"), "big")
    assert address(cow).hex() == "cd2a3d9f938e13cd947ec05abc7fe734df8dd826"
    assert sign(cow, digest) == (
        0x4355C47D63924E8A72E509B65029052EB6C299D53A04E167C5775FD466751C9D,
        0x07299936D304C153F6443DFA05F40FF007D72911B6F72307F996231605B91562,
        28,
    )


# ------------------------------------------------------------------- records

R_FIELD = 0x30644E72E131A029B85045B68181585D2833E84879B9709143E1F593F0000001
# circomlib's Poseidon of (0, 1): see docs/spec/contracts.md, Group registry, Vectors.
POSEIDON2_0_1 = 0x1BD20834F5DE9830C643778A2E88A3A1363C8B9AC083D36D75BF87C49953E65E
MAX_BATCH = 256
MAX_REGISTRARS = 16
CHAIN = 84532  # Base Sepolia
REGISTRY = bytes.fromhex("5fbdb2315678afecb367f032d93f642f64180aa3")
OTHER_REGISTRY = bytes.fromhex("e7f1725e7734ce288f8367e1bb143e90bb3f0512")

# Fixed test keys: the SHA-256 of a label, reduced. Never real keys.
def test_key(label):
    return int.from_bytes(hashlib.sha256(b"abolish group registry test key " + label).digest(), "big") % N


KEYS = sorted((test_key(b"%d" % i) for i in range(1, 4)), key=address)
REGISTRARS = [address(d) for d in KEYS]
THRESHOLD = 2
OUTSIDER = test_key(b"outsider")


def forbidden(c):
    return c >= R_FIELD or c in (0, 1, POSEIDON2_0_1)


def approval(seat, r, s, v):
    return bytes([seat]) + word(r) + word(s) + bytes([v])


def approvals_for(digest, seats, keys=None):
    out = []
    for seat in seats:
        d = (keys or {}).get(seat, KEYS[seat - 1] if 1 <= seat <= len(KEYS) else OUTSIDER)
        r, s, v = sign(d, digest)
        out.append((seat, r, s, v))
    return out


def add_record(group_id, first_index, commitments, approvals):
    return (
        group_id.to_bytes(8, "big")
        + first_index.to_bytes(8, "big")
        + len(commitments).to_bytes(2, "big")
        + b"".join(word(c) for c in commitments)
        + bytes([len(approvals)])
        + b"".join(approval(*a) for a in approvals)
    )


def remove_record(group_id, indices, approvals):
    return (
        group_id.to_bytes(8, "big")
        + len(indices).to_bytes(2, "big")
        + b"".join(i.to_bytes(8, "big") for i in indices)
        + bytes([len(approvals)])
        + b"".join(approval(*a) for a in approvals)
    )


SEP = domain_separator(NAME, VERSION, CHAIN, REGISTRY)


def add_digest(group_id, first_index, commitments, tier=0, sep=SEP):
    return eip712_digest(sep, add_struct_hash(group_id, tier, first_index, commitments))


def remove_digest(group_id, indices, tier=0, sep=SEP):
    return eip712_digest(sep, remove_struct_hash(group_id, tier, indices))


def check_approvals(digest, approvals):
    """The registry's rules 7 and 8 against the pinned set: None, or the
    error code and the failing seat."""
    if len(approvals) < THRESHOLD:
        return ("approvals", None)
    prev = 0
    for seat, r, s, v in approvals:
        if seat <= prev or seat > len(REGISTRARS):
            return ("seat", seat)
        prev = seat
        if recover(digest, r, s, v) != REGISTRARS[seat - 1]:
            return ("signature", seat)
    return None


def parse_add(rec):
    """The stateless checks of Additions (2, 4, 6) in the spec's order, then
    the parsed fields. Raises ValueError(code)."""
    if len(rec) < 19:
        raise ValueError("length")
    count = int.from_bytes(rec[16:18], "big")
    at = 18 + 32 * count
    if len(rec) < at + 1:
        raise ValueError("length")
    n = rec[at]
    if len(rec) != 19 + 32 * count + 66 * n:
        raise ValueError("length")
    if not 1 <= count <= MAX_BATCH:
        raise ValueError("batch")
    cs = [int.from_bytes(rec[18 + 32 * i : 50 + 32 * i], "big") for i in range(count)]
    for c in cs:
        if forbidden(c):
            raise ValueError("forbidden-commitment")
    aps = parse_approvals(rec[at + 1 :], n)
    return int.from_bytes(rec[0:8], "big"), int.from_bytes(rec[8:16], "big"), cs, aps


def parse_remove(rec):
    if len(rec) < 11:
        raise ValueError("length")
    count = int.from_bytes(rec[8:10], "big")
    at = 10 + 8 * count
    if len(rec) < at + 1:
        raise ValueError("length")
    n = rec[at]
    if len(rec) != 11 + 8 * count + 66 * n:
        raise ValueError("length")
    if not 1 <= count <= MAX_BATCH:
        raise ValueError("batch")
    idx = [int.from_bytes(rec[10 + 8 * i : 18 + 8 * i], "big") for i in range(count)]
    if any(b <= a for a, b in zip(idx, idx[1:])):
        raise ValueError("index-order")
    return int.from_bytes(rec[0:8], "big"), idx, parse_approvals(rec[at + 1 :], n)


def parse_approvals(b, n):
    return [
        (b[66 * i], int.from_bytes(b[66 * i + 1 : 66 * i + 33], "big"), int.from_bytes(b[66 * i + 33 : 66 * i + 65], "big"), b[66 * i + 65])
        for i in range(n)
    ]


def verdict_add(rec):
    try:
        g, f, cs, aps = parse_add(rec)
    except ValueError as e:
        return {"error": str(e)}
    bad = check_approvals(add_digest(g, f, cs), aps)
    return {"error": bad[0], **({"seat": bad[1]} if bad[1] is not None else {})} if bad else None


def verdict_remove(rec):
    try:
        g, idx, aps = parse_remove(rec)
    except ValueError as e:
        return {"error": str(e)}
    bad = check_approvals(remove_digest(g, idx), aps)
    return {"error": bad[0], **({"seat": bad[1]} if bad[1] is not None else {})} if bad else None


def commitments(n, seed):
    out = []
    i = 0
    while len(out) < n:
        c = int.from_bytes(keccak256(b"commitment" + bytes([seed]) + i.to_bytes(4, "big")), "big") % R_FIELD
        if not forbidden(c):
            out.append(c)
        i += 1
    return out


def hexs(b):
    return b.hex()


def ap_json(aps, digest):
    out = []
    for seat, r, s, v in aps:
        signer = recover(digest, r, s, v)
        out.append({"seat": seat, "r": "%064x" % r, "s": "%064x" % s, "v": v, "signer": signer.hex() if signer else None})
    return out


def main():
    self_check()
    out = pathlib.Path(sys.argv[1])

    additions = []

    def valid_add(id_, desc, g, f, cs, seats):
        d = add_digest(g, f, cs)
        aps = approvals_for(d, seats)
        rec = add_record(g, f, cs, aps)
        assert verdict_add(rec) is None
        additions.append({
            "id": id_, "description": desc, "groupId": g, "tier": 0, "firstIndex": f,
            "commitments": ["%064x" % c for c in cs],
            "structHash": hexs(add_struct_hash(g, 0, f, cs)), "digest": hexs(d),
            "approvals": ap_json(aps, d), "record": hexs(rec),
        })

    valid_add("one-member", "One member, signed by seats 1 and 2 of 3", 0, 0, commitments(1, 1), [1, 2])
    valid_add("all-seats", "Three members at position 1, signed by every seat", 0, 1, commitments(3, 2), [1, 2, 3])
    valid_add("seats-1-3", "Seats 1 and 3 only", 7, 4, commitments(2, 3), [1, 3])
    valid_add(
        "boundaries", "The smallest and largest allowed commitments, and Poseidon2(0, 1) ± 1",
        2**64 - 1, 2**32 - 4, [2, POSEIDON2_0_1 - 1, POSEIDON2_0_1 + 1, R_FIELD - 1], [2, 3],
    )
    valid_add("max-batch", "A full batch of MAX_BATCH members", 1, 0, commitments(MAX_BATCH, 4), [1, 2])

    removals = []

    def valid_remove(id_, desc, g, idx, seats):
        d = remove_digest(g, idx)
        aps = approvals_for(d, seats)
        rec = remove_record(g, idx, aps)
        assert verdict_remove(rec) is None
        removals.append({
            "id": id_, "description": desc, "groupId": g, "tier": 0, "indices": idx,
            "structHash": hexs(remove_struct_hash(g, 0, idx)), "digest": hexs(d),
            "approvals": ap_json(aps, d), "record": hexs(rec),
        })

    valid_remove("one-index", "Remove member 0", 0, [0], [1, 2])
    valid_remove("several", "Remove three members, signed by every seat", 3, [1, 5, 2**32 - 1], [1, 2, 3])

    # Rejected records: each breaks exactly one rule.
    rejected = []

    def reject(kind, id_, desc, rec, expect):
        got = verdict_add(rec) if kind == "add" else verdict_remove(rec)
        assert got == expect, (id_, got, expect)
        rejected.append({"id": id_, "kind": kind, "description": desc, "record": hexs(rec), **expect})

    cs1 = commitments(1, 9)
    d1 = add_digest(0, 0, cs1)
    good = approvals_for(d1, [1, 2])
    rec1 = add_record(0, 0, cs1, good)

    reject("add", "empty", "No bytes", b"", {"error": "length"})
    reject("add", "short-header", "18 bytes: no approvals byte", rec1[:18], {"error": "length"})
    reject("add", "truncated", "The last approval cut by one byte", rec1[:-1], {"error": "length"})
    reject("add", "trailing", "One byte appended", rec1 + b"\x00", {"error": "length"})
    reject("add", "count-overstates", "count says 2 with one commitment", rec1[:16] + b"\x00\x02" + rec1[18:], {"error": "length"})
    reject("add", "count-zero", "count 0", add_record(0, 0, [], approvals_for(add_digest(0, 0, []), [1, 2])), {"error": "batch"})
    big = commitments(MAX_BATCH + 1, 5)
    reject("add", "count-over-max", "MAX_BATCH + 1 members", add_record(0, 0, big, approvals_for(add_digest(0, 0, big), [1, 2])), {"error": "batch"})
    for name, c in (("zero", 0), ("one", 1), ("poseidon-0-1", POSEIDON2_0_1), ("r", R_FIELD), ("max", 2**256 - 1)):
        cs = [commitments(1, 6)[0], c]
        reject(
            "add", "forbidden-" + name, "A forbidden commitment second in the batch",
            add_record(0, 0, cs, approvals_for(add_digest(0, 0, cs), [1, 2])), {"error": "forbidden-commitment"},
        )
    reject("add", "no-approvals", "Unsigned", add_record(0, 0, cs1, []), {"error": "approvals"})
    reject("add", "below-threshold", "One approval of the two needed", add_record(0, 0, cs1, good[:1]), {"error": "approvals"})
    reject("add", "seat-zero", "Seat 0", add_record(0, 0, cs1, [(0,) + good[0][1:], good[1]]), {"error": "seat", "seat": 0})
    reject("add", "seat-beyond", "Seat 4 of 3", add_record(0, 0, cs1, [good[0], (4,) + good[1][1:]]), {"error": "seat", "seat": 4})
    reject("add", "seats-descending", "Seats 2 then 1", add_record(0, 0, cs1, [good[1], good[0]]), {"error": "seat", "seat": 1})
    reject("add", "seat-repeated", "Seat 1 twice", add_record(0, 0, cs1, [good[0], good[0]]), {"error": "seat", "seat": 1})
    s1, r1_, s1_, v1 = good[1]
    reject("add", "high-s", "Seat 2's signature malleated to its high-s twin", add_record(0, 0, cs1, [good[0], (s1, r1_, N - s1_, 55 - v1)]), {"error": "signature", "seat": 2})
    reject("add", "v-flipped", "Seat 2's v flipped: recovers another key", add_record(0, 0, cs1, [good[0], (s1, r1_, s1_, 55 - v1)]), {"error": "signature", "seat": 2})
    for name, v in (("v-0", 0), ("v-1", 1), ("v-26", 26), ("v-29", 29)):
        reject("add", name, "v outside {27, 28}", add_record(0, 0, cs1, [good[0], (s1, r1_, s1_, v)]), {"error": "signature", "seat": 2})
    reject("add", "r-zero", "r = 0", add_record(0, 0, cs1, [good[0], (s1, 0, s1_, v1)]), {"error": "signature", "seat": 2})
    reject("add", "r-order", "r = N", add_record(0, 0, cs1, [good[0], (s1, N, s1_, v1)]), {"error": "signature", "seat": 2})
    reject("add", "s-zero", "s = 0", add_record(0, 0, cs1, [good[0], (s1, r1_, 0, v1)]), {"error": "signature", "seat": 2})
    outsider = approvals_for(d1, [2], {2: OUTSIDER})[0]
    reject("add", "outsider", "Seat 2's approval signed by a key outside the set", add_record(0, 0, cs1, [good[0], outsider]), {"error": "signature", "seat": 2})
    reject("add", "seat-swapped", "Seat 1's signature presented as seat 3's", add_record(0, 0, cs1, [good[1], (3,) + good[0][1:]]), {"error": "signature", "seat": 3})
    # Signed for another message: each binding in turn.
    others = [
        ("other-group", "Signed for group 1", add_digest(1, 0, cs1)),
        ("other-tier", "Signed for tier 2", add_digest(0, 0, cs1, tier=2)),
        ("other-position", "Signed for position 1", add_digest(0, 1, cs1)),
        ("other-chain", "Signed under chain 31337", add_digest(0, 0, cs1, sep=domain_separator(NAME, VERSION, 31337, REGISTRY))),
        ("other-registry", "Signed for another registry", add_digest(0, 0, cs1, sep=domain_separator(NAME, VERSION, CHAIN, OTHER_REGISTRY))),
        ("other-name", "Signed under another domain name", add_digest(0, 0, cs1, sep=domain_separator("Abolish", VERSION, CHAIN, REGISTRY))),
        ("other-commitments", "Signed for another commitment", add_digest(0, 0, commitments(1, 10))),
    ]
    for id_, desc, d in others:
        reject("add", id_, desc, add_record(0, 0, cs1, approvals_for(d, [1, 2])), {"error": "signature", "seat": 1})
    # A removal's signature doesn't authorise an addition, and vice versa.
    rd = remove_digest(0, [0])
    reject("add", "removal-signature", "Signed as a removal", add_record(0, 0, cs1, approvals_for(rd, [1, 2])), {"error": "signature", "seat": 1})

    idx = [0]
    good_r = approvals_for(rd, [1, 2])
    rrec = remove_record(0, idx, good_r)
    reject("remove", "remove-short", "10 bytes", rrec[:10], {"error": "length"})
    reject("remove", "remove-trailing", "One byte appended", rrec + b"\x00", {"error": "length"})
    reject("remove", "remove-count-zero", "No indices", remove_record(0, [], approvals_for(remove_digest(0, []), [1, 2])), {"error": "batch"})
    reject("remove", "remove-descending", "Indices 2 then 1", remove_record(0, [2, 1], approvals_for(remove_digest(0, [2, 1]), [1, 2])), {"error": "index-order"})
    reject("remove", "remove-repeated", "Index 3 twice", remove_record(0, [3, 3], approvals_for(remove_digest(0, [3, 3]), [1, 2])), {"error": "index-order"})
    reject("remove", "remove-below-threshold", "One approval", remove_record(0, idx, good_r[:1]), {"error": "approvals"})
    reject("remove", "remove-other-index", "Signed for index 1", remove_record(0, idx, approvals_for(remove_digest(0, [1]), [1, 2])), {"error": "signature", "seat": 1})
    reject("remove", "addition-signature", "Signed as an addition", remove_record(0, idx, approvals_for(add_digest(0, 0, [0]), [1, 2])), {"error": "signature", "seat": 1})

    doc = {
        "format": "abolish-group-registry-vectors/1",
        "title": "Group registry: addition and removal records, their EIP-712 digests and approvals",
        "spec": "docs/spec/contracts.md",
        "generator": "packages/crypto/scripts/group-registry-vectors.py: an independent Python implementation (standard library only: its own Keccak-256, affine secp256k1 arithmetic, RFC 6979 with hmac and hashlib) that first reproduces EIP-712's Mail example (domain separator, digest and signature) and RFC 6979's secp256k1 'Satoshi Nakamoto' signature",
        "domain": {
            "name": NAME, "version": VERSION, "chainId": CHAIN, "verifyingContract": REGISTRY.hex(),
            "typeHash": hexs(type_hash(DOMAIN_TYPE)), "separator": hexs(SEP),
        },
        "types": {
            "AddMembers": {"type": ADD_TYPE, "typeHash": hexs(type_hash(ADD_TYPE))},
            "RemoveMembers": {"type": REMOVE_TYPE, "typeHash": hexs(type_hash(REMOVE_TYPE))},
        },
        "constants": {
            "maxBatch": MAX_BATCH, "maxRegistrars": MAX_REGISTRARS,
            "fieldModulus": "%064x" % R_FIELD, "poseidon2_0_1": "%064x" % POSEIDON2_0_1,
        },
        "registrars": {
            "description": "Test keys only: each is SHA-256 of a label, reduced mod N; ordered by address, as the registry pins them",
            "threshold": THRESHOLD,
            "secretKeys": ["%064x" % d for d in KEYS],
            "addresses": [a.hex() for a in REGISTRARS],
            "outsiderSecretKey": "%064x" % OUTSIDER,
        },
        "commitments": [
            {"value": "%064x" % c, "forbidden": forbidden(c)}
            for c in (0, 1, 2, POSEIDON2_0_1 - 1, POSEIDON2_0_1, POSEIDON2_0_1 + 1, R_FIELD - 1, R_FIELD, R_FIELD + 1, 2**256 - 1)
        ],
        "additions": additions,
        "removals": removals,
        "rejected": rejected,
    }
    assert REGISTRARS == sorted(REGISTRARS) and len(set(REGISTRARS)) == 3
    (out / "group-registry.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
