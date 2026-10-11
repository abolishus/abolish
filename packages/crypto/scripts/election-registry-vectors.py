#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/election-registry.json.

A second implementation of the election identifier in docs/spec/contracts.md
(Election registry), written from the spec with Python's hashlib only and
sharing no code with packages/crypto or packages/contracts, so the vectors it
prints check both instead of restating either (docs/spec/vectors/README.md,
Rules).

Usage: python3 -I packages/crypto/scripts/election-registry-vectors.py > docs/spec/vectors/election-registry.json
"""

import hashlib
import json
import sys

TAG = b"abolish/v1/election-id"
MAX_U64 = 2**64 - 1


def election_id(chain_id, registry, counter):
    assert 0 <= chain_id <= MAX_U64 and 0 <= counter <= MAX_U64 and len(registry) == 20
    m = chain_id.to_bytes(8, "big") + registry + counter.to_bytes(8, "big")
    # Spec-check: the input after the tag is exactly 36 bytes.
    assert len(m) == 36
    return hashlib.sha256(bytes([len(TAG)]) + TAG + m).digest()


BASE = 84532  # Base Sepolia
REG = bytes.fromhex("5fbdb2315678afecb367f032d93f642f64180aa3")
OTHER = bytes.fromhex("e7f1725e7734ce288f8367e1bb143e90bb3f0512")

ids = [
    ("first", "The first election a registry on Base Sepolia creates", BASE, REG, 0),
    ("second", "The registry's next election", BASE, REG, 1),
    ("other-registry", "Counter 0 at another registry address on the same chain", BASE, OTHER, 0),
    ("other-chain", "Counter 0 at the same address on Anvil's default chain", 31337, REG, 0),
    ("counter-bytes", "A counter whose bytes are all distinct, to pin the byte order", BASE, REG, 0x0102030405060708),
    ("max", "The largest chain ID and counter with a u64 encoding", MAX_U64, bytes([0xFF] * 20), MAX_U64),
]

rejected = [
    ("chain-id-over-u64", "A chain ID of 2^64 has no u64 encoding", 2**64, REG, 0),
    ("counter-over-u64", "A counter of 2^64 has no u64 encoding", BASE, REG, 2**64),
]

out = {
    "format": "abolish-election-registry-vectors/1",
    "title": "Election registry: election identifiers",
    "spec": "docs/spec/contracts.md",
    "generator": (
        "Printed by packages/crypto/scripts/election-registry-vectors.py, an independent "
        "implementation of docs/spec/contracts.md (Election registry) with Python's hashlib only. "
        "packages/crypto and packages/contracts both check it."
    ),
    "tag": TAG.decode("ascii"),
    "electionIds": [
        {
            "id": i,
            "description": d,
            "chainId": str(c),
            "registry": r.hex(),
            "counter": str(n),
            "electionId": election_id(c, r, n).hex(),
        }
        for i, d, c, r, n in ids
    ],
    "rejected": [
        {"id": i, "description": d, "chainId": str(c), "registry": r.hex(), "counter": str(n)}
        for i, d, c, r, n in rejected
    ],
}

# Spec-check: distinct inputs give distinct identifiers.
assert len({v["electionId"] for v in out["electionIds"]}) == len(ids)
json.dump(out, sys.stdout, indent=2)
sys.stdout.write("\n")
