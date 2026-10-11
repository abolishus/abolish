#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/membership.json.

A second implementation of docs/spec/membership.md: the nullifier scope, the
Semaphore field mapping F and the tree depth. It is written from the spec with
Python's standard library only and shares no code with packages/crypto.
Python's hashlib has no Keccak-256 (Ethereum's padding), so this file carries
its own Keccak-f[1600] sponge. Before printing anything it checks that sponge
with SHA3-256's padding against hashlib.sha3_256, which exercises the same
permutation, and with Keccak-256's padding against two published answers.

Usage: python3 -I packages/crypto/scripts/membership-vectors.py <out-dir>
"""

import hashlib
import json
import pathlib
import sys

R = 0x30644E72E131A029B85045B68181585D2833E84879B9709143E1F593F0000001
TAG = b"abolish/v1/nullifier-scope"

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
    out = b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out


def keccak256(msg):
    return sponge256(msg, 0x01)


def self_check():
    for n in (0, 1, 31, 32, 64, 135, 136, 137, 271, 272, 1000):
        m = bytes((i * 7 + n) & 0xFF for i in range(n))
        assert sponge256(m, 0x06) == hashlib.sha3_256(m).digest(), n
    # Published Keccak-256 answers: the empty string, and the 32-byte zero word
    # (Solidity's keccak256(abi.encode(uint256(0)))).
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256(bytes(32)).hex() == "290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563"


def field_map(x):
    assert len(x) == 32
    return int.from_bytes(keccak256(x), "big") >> 8


def scope(definition_hash, tier, root):
    assert len(definition_hash) == 32 and tier in (0, 1, 2) and 0 < root < R
    m = definition_hash + bytes([tier]) + root.to_bytes(32, "big")
    return hashlib.sha256(bytes([len(TAG)]) + TAG + m).digest()


def det(label, i=0):
    return hashlib.sha256(f"abolish membership vectors {label} {i}".encode()).digest()


def main():
    self_check()
    out = pathlib.Path(sys.argv[1])

    field = []
    inputs = [
        ("zero", bytes(32)),
        ("one", bytes(31) + b"\x01"),
        ("all-ff", b"\xff" * 32),
        ("r-minus-1", (R - 1).to_bytes(32, "big")),
    ] + [(f"deterministic-{i}", det("field", i)) for i in range(4)]
    for name, x in inputs:
        field.append(
            {
                "id": f"field-{name}",
                "input": x.hex(),
                "keccak256": keccak256(x).hex(),
                "output": str(field_map(x)),
            }
        )

    scopes = []
    shared = int.from_bytes(det("root", 1), "big") % R
    cases = [
        ("min-root", det("definition", 0), 0, 1),
        ("max-root", det("definition", 0), 0, R - 1),
        ("tier-1", det("definition", 0), 1, shared),
        ("tier-2", det("definition", 0), 2, shared),
        ("other-definition", det("definition", 1), 2, shared),
        ("zero-definition", bytes(32), 0, 2),
    ]
    for name, d, tier, root in cases:
        s = scope(d, tier, root)
        scopes.append(
            {
                "id": f"scope-{name}",
                "definitionHash": d.hex(),
                "tier": tier,
                "root": root.to_bytes(32, "big").hex(),
                "scope": s.hex(),
                "scopeField": str(field_map(s)),
            }
        )
    # Two tiers with the same root (identical rosters) still get different scopes.
    assert scope(det("definition", 0), 1, shared) != scope(det("definition", 0), 2, shared)
    rejected = [
        ("root-equal-to-r", "a root that isn't a canonical field<bn254> is rejected", 0, R, "non-canonical"),
        ("zero-root", "a tier root of 0 is provable by anyone (proof length above the depth), so it has no scope", 0, 0, "zero-root"),
        ("unknown-tier", "only tiers 0, 1 and 2 exist", 3, 1, "unknown-tier"),
    ]
    for name, description, tier, root, error in rejected:
        scopes.append(
            {
                "id": f"scope-{name}",
                "description": description,
                "definitionHash": det("definition", 0).hex(),
                "tier": tier,
                "root": root.to_bytes(32, "big").hex(),
                "error": error,
            }
        )

    doc = {
        "format": "abolish-membership-vectors/1",
        "title": "Membership: nullifier scope, Semaphore field mapping and tree depth",
        "spec": "docs/spec/membership.md",
        "generator": (
            "packages/crypto/scripts/membership-vectors.py: an independent Python implementation "
            "with its own Keccak-256, checked against hashlib.sha3_256 (same permutation, SHA3 "
            "padding) and the published Keccak-256 of the empty string and of 32 zero bytes"
        ),
        "fieldMap": field,
        "depth": 32,
        "scopes": scopes,
    }
    (out / "membership.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
