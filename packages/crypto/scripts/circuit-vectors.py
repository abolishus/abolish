#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/circuit.json.

A second implementation of the circuit-facing rules in docs/spec: each
registered tag's field element (domain-separation.md, In-circuit hashes) and
the two byte packings (notation.md, Circuit-facing values). It is written from
the spec with Python's standard library only and shares no code with
packages/crypto or packages/circuits. The tags are read from the registry
table in domain-separation.md, so every registered tag has a vector.

Usage: python3 -I packages/crypto/scripts/circuit-vectors.py <out-dir>
"""

import hashlib
import json
import pathlib
import re
import sys

R = 0x30644E72E131A029B85045B68181585D2833E84879B9709143E1F593F0000001
CIRCUIT_TAG = b"abolish/v1/circuit-tag"
SPEC = pathlib.Path(__file__).resolve().parents[3] / "docs" / "spec" / "domain-separation.md"


def registered_tags():
    text = SPEC.read_text()
    registry = text[text.index("\n## Registry\n") :]
    tags = re.findall(r"^\| `(abolish/v1/[a-z0-9/-]+)` +\|", registry, re.M)
    assert len(tags) == len(set(tags)) and CIRCUIT_TAG.decode() in tags
    return tags


def tag_field(tag):
    raw = tag.encode("ascii")
    digest = hashlib.sha256(bytes([len(CIRCUIT_TAG)]) + CIRCUIT_TAG + raw).digest()
    value = int.from_bytes(digest, "big") >> 8
    assert value < R
    return digest, value


def pack(data):
    return [int.from_bytes(data[i : i + 31], "big") for i in range(0, len(data), 31)]


def det(label, n):
    """Deterministic, readable-from-the-spec test bytes: SHA-256 in counter mode."""
    out = b""
    counter = 0
    while len(out) < n:
        out += hashlib.sha256(f"{label}/{counter}".encode()).digest()
        counter += 1
    return out[:n]


def main():
    out = pathlib.Path(sys.argv[1])
    tags = []
    for tag in registered_tags():
        digest, value = tag_field(tag)
        tags.append({"tag": tag, "digest": digest.hex(), "field": str(value)})

    packed = []
    for n in [0, 1, 30, 31, 32, 61, 62, 63, 93, 255]:
        data = det(f"bytes-{n}", n)
        fields = pack(data)
        assert len(fields) == -(-n // 31) and all(f < 2 ** 248 for f in fields)
        packed.append({"id": f"bytes-{n}", "bytes": data.hex(), "fields": [str(f) for f in fields]})
    for name, data in [("all-ff-31", b"\xff" * 31), ("all-ff-62", b"\xff" * 62), ("zeros-33", bytes(33))]:
        packed.append({"id": name, "bytes": data.hex(), "fields": [str(f) for f in pack(data)]})

    bounded = []
    for name, max_len, n in [
        ("empty-of-0", 0, 0),
        ("empty-of-31", 31, 0),
        ("one-of-31", 31, 1),
        ("full-31", 31, 31),
        ("short-of-32", 32, 5),
        ("full-64", 64, 64),
        ("short-of-255", 255, 200),
    ]:
        data = det(f"bounded-{name}", n)
        fields = [n] + pack(data + bytes(max_len - n))
        bounded.append({"id": name, "max": max_len, "bytes": data.hex(), "fields": [str(f) for f in fields]})
    # Content ending in zero bytes: only the length tells these apart.
    for name, data in [("a-of-4", b"a"), ("a-zero-of-4", b"a\x00"), ("a-zero-zero-of-4", b"a\x00\x00")]:
        fields = [len(data)] + pack(data + bytes(4 - len(data)))
        bounded.append({"id": name, "max": 4, "bytes": data.hex(), "fields": [str(f) for f in fields]})
    for name, max_len, n in [("over-max-0", 0, 1), ("over-max-31", 31, 32)]:
        bounded.append({"id": name, "max": max_len, "bytes": det(f"bounded-{name}", n).hex(), "error": "too-long"})

    doc = {
        "format": "abolish-circuit-vectors/1",
        "title": "Circuit-facing values: tag field elements and byte packing",
        "spec": "docs/spec/notation.md",
        "generator": (
            "packages/crypto/scripts/circuit-vectors.py: an independent Python implementation from "
            "docs/spec/domain-separation.md (In-circuit hashes) and docs/spec/notation.md "
            "(Circuit-facing values), with hashlib's SHA-256; tags read from the registry table"
        ),
        "tags": tags,
        "packBytes": packed,
        "packBoundedBytes": bounded,
    }
    (out / "circuit.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
