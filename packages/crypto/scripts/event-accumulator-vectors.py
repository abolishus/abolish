#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/event-accumulator.json.

A second implementation of the event accumulator in docs/spec/contracts.md,
written from the spec with Python's hashlib only and sharing no code with
packages/crypto or packages/contracts, so the vectors it prints check both
instead of restating either (docs/spec/vectors/README.md, Rules).

Usage: python3 -I packages/crypto/scripts/event-accumulator-vectors.py > docs/spec/vectors/event-accumulator.json
"""

import hashlib
import json
import sys

TAG = b"abolish/v1/event-accumulator"
MAX_U64 = 2**64 - 1


def h(m):
    return hashlib.sha256(bytes([len(TAG)]) + TAG + m).digest()


def genesis(chain_id, address):
    assert 0 <= chain_id <= MAX_U64 and len(address) == 20
    return h(b"\x00" + chain_id.to_bytes(8, "big") + address)


def step(acc, n, topics, data):
    assert 1 <= len(topics) <= 4 and all(len(t) == 32 for t in topics)
    return h(
        b"\x01"
        + acc
        + n.to_bytes(8, "big")
        + bytes([len(topics)])
        + b"".join(topics)
        + len(data).to_bytes(4, "big")
        + data
    )


def det(label, n):
    """Deterministic filler bytes, so the vectors are reproducible."""
    out = b""
    i = 0
    while len(out) < n:
        out += hashlib.sha256(f"{label}/{i}".encode()).digest()
        i += 1
    return out[:n]


def sig(signature):
    """An event's topic 0: keccak-256 of its signature. hashlib's sha3_256 is not keccak, so use a fixed stand-in."""
    return det("topic0/" + signature, 32)


# Spec-check: the genesis input is 1 + 8 + 20 bytes and the step input for k
# topics and len(d) data bytes is 1 + 32 + 8 + 1 + 32k + 4 + len(d), so the two
# layouts never share a length-and-prefix and each parses one way.
assert len(TAG) == 28

BASE = 84532  # Base Sepolia
ADDR = bytes.fromhex("5fbdb2315678afecb367f032d93f642f64180aa3")

genesis_vectors = [
    ("zero", "Chain ID 0 and the zero address", 0, bytes(20)),
    ("base-sepolia", "Base Sepolia, an Anvil-style first deployment address", BASE, ADDR),
    ("anvil", "Anvil's default chain ID, same address", 31337, ADDR),
    ("max-chain-id", "The largest chain ID with a u64 encoding", MAX_U64, bytes([0xFF] * 20)),
]

sequences = [
    (
        "one-topic-empty-data",
        "One log with only topic 0 and no data",
        BASE,
        ADDR,
        [([sig("Ping()")], b"")],
    ),
    (
        "every-topic-count",
        "Logs with 1, 2, 3 and 4 topics, then 1 again",
        BASE,
        ADDR,
        [
            ([sig("A(uint256)")], det("data/a", 32)),
            ([sig("B(bytes32,uint256)"), det("t/b1", 32)], det("data/b", 32)),
            ([sig("C(bytes32,bytes32,bytes)"), det("t/c1", 32), det("t/c2", 32)], det("data/c", 96)),
            (
                [sig("D(bytes32,bytes32,bytes32)"), det("t/d1", 32), det("t/d2", 32), det("t/d3", 32)],
                b"",
            ),
            ([sig("A(uint256)")], det("data/a2", 32)),
        ],
    ),
    (
        "odd-data-lengths",
        "Data lengths that aren't a multiple of 32, including 1 and 33 bytes",
        31337,
        ADDR,
        [([sig("E(bytes)")], det("data/e1", 1)), ([sig("E(bytes)")], det("data/e33", 33)), ([sig("E(bytes)")], det("data/e300", 300))],
    ),
    (
        "same-log-twice",
        "The same log twice gives two different accumulators: the index and the chain both change",
        BASE,
        ADDR,
        [([sig("Ping()")], b""), ([sig("Ping()")], b"")],
    ),
    (
        "other-address",
        "The every-topic-count logs from another address on the same chain, so every value differs",
        BASE,
        bytes.fromhex("e7f1725e7734ce288f8367e1bb143e90bb3f0512"),
        [
            ([sig("A(uint256)")], det("data/a", 32)),
            ([sig("B(bytes32,uint256)"), det("t/b1", 32)], det("data/b", 32)),
        ],
    ),
]

rejected = [
    ("chain-id-too-large", "A chain ID of 2^64 has no u64 encoding; deployment reverts", {"kind": "genesis", "chainId": str(2**64), "address": ADDR.hex()}),
    ("no-topics", "An anonymous log (no topics) is never accumulated", {"kind": "step", "topics": [], "data": ""}),
    ("five-topics", "A log has at most 4 topics", {"kind": "step", "topics": [det(f"t/five{i}", 32).hex() for i in range(5)], "data": ""}),
    ("short-topic", "A topic is exactly 32 bytes", {"kind": "step", "topics": [det("t/short", 31).hex()], "data": ""}),
]

out_sequences = []
for sid, desc, chain_id, address, logs in sequences:
    acc = genesis(chain_id, address)
    g = acc
    accs = []
    for n, (topics, data) in enumerate(logs):
        acc = step(acc, n, topics, data)
        accs.append(acc.hex())
    assert len(set(accs)) == len(accs)
    out_sequences.append(
        {
            "id": sid,
            "description": desc,
            "chainId": str(chain_id),
            "address": address.hex(),
            "genesis": g.hex(),
            "events": [{"topics": [t.hex() for t in topics], "data": data.hex()} for topics, data in logs],
            "accumulators": accs,
        }
    )

doc = {
    "format": "abolish-event-accumulator-vectors/1",
    "title": "Event accumulator: genesis, steps and rejected inputs",
    "spec": "docs/spec/contracts.md",
    "generator": "packages/crypto/scripts/event-accumulator-vectors.py: an independent Python implementation of docs/spec/contracts.md (Event accumulator) using hashlib only, sharing no code with packages/crypto or packages/contracts. Topic values are deterministic stand-ins (SHA-256 of a label), not real event signature hashes: the accumulator treats topics as opaque bytes.",
    "tag": TAG.decode(),
    "genesis": [
        {"id": gid, "description": desc, "chainId": str(c), "address": a.hex(), "accumulator": genesis(c, a).hex()}
        for gid, desc, c, a in genesis_vectors
    ],
    "sequences": out_sequences,
    "rejected": [{"id": rid, "description": desc, **body} for rid, desc, body in rejected],
}
json.dump(doc, sys.stdout, indent=2)
sys.stdout.write("\n")
