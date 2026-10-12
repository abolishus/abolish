#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/event-accumulator-2.json.

A second implementation of the event accumulator in docs/spec/contracts.md
(tag abolish/v1/event-accumulator-2, each step binding its log's L2 block
number and timestamp; docs/adr/0025-contract-event-evidence.md), written from
the spec with Python's hashlib only and sharing no code with packages/crypto
or packages/contracts, so the vectors it prints check both instead of
restating either (docs/spec/vectors/README.md, Rules).

Usage: python3 -I packages/crypto/scripts/event-accumulator-2-vectors.py > docs/spec/vectors/event-accumulator-2.json
"""

import hashlib
import json
import sys

TAG = b"abolish/v1/event-accumulator-2"
MAX_U64 = 2**64 - 1


def h(m):
    return hashlib.sha256(bytes([len(TAG)]) + TAG + m).digest()


def u64(v):
    assert 0 <= v <= MAX_U64
    return v.to_bytes(8, "big")


def genesis(chain_id, address):
    assert len(address) == 20
    return h(b"\x00" + u64(chain_id) + address)


def step(acc, n, block, timestamp, topics, data):
    assert 1 <= len(topics) <= 4 and all(len(t) == 32 for t in topics)
    return h(
        b"\x01"
        + acc
        + u64(n)
        + u64(block)
        + u64(timestamp)
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
    """An event's topic 0. hashlib's sha3_256 is not keccak, so use a fixed stand-in."""
    return det("topic0/" + signature, 32)


def check(chain_id, address, events, proven_count, proven_block, proven_acc):
    """Verification of docs/spec/contracts.md (Event accumulator): the code of the first failing rule, or None."""
    for i, e in enumerate(events):
        if e["n"] != i:
            return "index"
        if i > 0 and (e["block"] < events[i - 1]["block"] or e["timestamp"] < events[i - 1]["timestamp"]):
            return "order"
    if len(events) < proven_count:
        return "accumulator"
    if any(e["block"] > proven_block for e in events[:proven_count]):
        return "block-range"
    if len(events) > proven_count and events[proven_count]["block"] <= proven_block:
        return "block-range"
    acc = genesis(chain_id, address)
    for e in events[:proven_count]:
        acc = step(acc, e["n"], e["block"], e["timestamp"], e["topics"], e["data"])
    return None if acc == proven_acc else "accumulator"


# Spec-check: the genesis input is 1 + 8 + 20 bytes and the step input for k
# topics and len(d) data bytes is 1 + 32 + 8 + 8 + 8 + 1 + 32k + 4 + len(d), so
# the two layouts never share a length-and-prefix and each parses one way.
assert len(TAG) == 30

BASE = 84532  # Base Sepolia
ADDR = bytes.fromhex("5fbdb2315678afecb367f032d93f642f64180aa3")
T0 = 1_760_000_000

genesis_vectors = [
    ("zero", "Chain ID 0 and the zero address", 0, bytes(20)),
    ("base-sepolia", "Base Sepolia, an Anvil-style first deployment address", BASE, ADDR),
    ("anvil", "Anvil's default chain ID, same address", 31337, ADDR),
    ("max-chain-id", "The largest chain ID with a u64 encoding", MAX_U64, bytes([0xFF] * 20)),
]


def ev(block, timestamp, topics, data):
    return {"block": block, "timestamp": timestamp, "topics": topics, "data": data}


sequences = [
    ("one-topic-empty-data", "One log with only topic 0 and no data", BASE, ADDR, [ev(1, T0, [sig("Ping()")], b"")]),
    (
        "every-topic-count",
        "Logs with 1, 2, 3 and 4 topics, then 1 again, two of them in one block",
        BASE,
        ADDR,
        [
            ev(100, T0, [sig("A(uint256)")], det("data/a", 32)),
            ev(100, T0, [sig("B(bytes32,uint256)"), det("t/b1", 32)], det("data/b", 32)),
            ev(101, T0 + 2, [sig("C(bytes32,bytes32,bytes)"), det("t/c1", 32), det("t/c2", 32)], det("data/c", 96)),
            ev(
                250,
                T0 + 300,
                [sig("D(bytes32,bytes32,bytes32)"), det("t/d1", 32), det("t/d2", 32), det("t/d3", 32)],
                b"",
            ),
            ev(251, T0 + 302, [sig("A(uint256)")], det("data/a2", 32)),
        ],
    ),
    (
        "odd-data-lengths",
        "Data lengths that aren't a multiple of 32, including 1 and 33 bytes",
        31337,
        ADDR,
        [
            ev(7, T0, [sig("E(bytes)")], det("data/e1", 1)),
            ev(8, T0 + 1, [sig("E(bytes)")], det("data/e33", 33)),
            ev(9, T0 + 2, [sig("E(bytes)")], det("data/e300", 300)),
        ],
    ),
    (
        "same-log-twice",
        "The same log twice in one block gives two different accumulators: the index changes",
        BASE,
        ADDR,
        [ev(5, T0, [sig("Ping()")], b""), ev(5, T0, [sig("Ping()")], b"")],
    ),
    (
        "same-log-other-block",
        "The one-topic-empty-data log in another block: the block number alone changes the accumulator",
        BASE,
        ADDR,
        [ev(2, T0, [sig("Ping()")], b"")],
    ),
    (
        "same-log-other-timestamp",
        "The one-topic-empty-data log at another timestamp: the timestamp alone changes the accumulator",
        BASE,
        ADDR,
        [ev(1, T0 + 1, [sig("Ping()")], b"")],
    ),
    (
        "max-block-and-timestamp",
        "The largest block number and timestamp with a u64 encoding",
        BASE,
        ADDR,
        [ev(MAX_U64, MAX_U64, [sig("Ping()")], b"")],
    ),
    (
        "other-address",
        "The first every-topic-count logs from another address on the same chain, so every value differs",
        BASE,
        bytes.fromhex("e7f1725e7734ce288f8367e1bb143e90bb3f0512"),
        [
            ev(100, T0, [sig("A(uint256)")], det("data/a", 32)),
            ev(100, T0, [sig("B(bytes32,uint256)"), det("t/b1", 32)], det("data/b", 32)),
        ],
    ),
]

rejected = [
    ("chain-id-too-large", "A chain ID of 2^64 has no u64 encoding; deployment reverts", {"kind": "genesis", "chainId": str(2**64), "address": ADDR.hex()}),
    ("no-topics", "An anonymous log (no topics) is never accumulated", {"kind": "step", "block": "1", "timestamp": str(T0), "topics": [], "data": ""}),
    ("five-topics", "A log has at most 4 topics", {"kind": "step", "block": "1", "timestamp": str(T0), "topics": [det(f"t/five{i}", 32).hex() for i in range(5)], "data": ""}),
    ("short-topic", "A topic is exactly 32 bytes", {"kind": "step", "block": "1", "timestamp": str(T0), "topics": [det("t/short", 31).hex()], "data": ""}),
    ("block-too-large", "A block number of 2^64 has no u64 encoding; the emitting call reverts", {"kind": "step", "block": str(2**64), "timestamp": str(T0), "topics": [sig("Ping()").hex()], "data": ""}),
    ("timestamp-too-large", "A timestamp of 2^64 has no u64 encoding; the emitting call reverts", {"kind": "step", "block": "1", "timestamp": str(2**64), "topics": [sig("Ping()").hex()], "data": ""}),
]


def numbered(events):
    return [dict(e, n=i) for i, e in enumerate(events)]


def accumulators(chain_id, address, events):
    acc = genesis(chain_id, address)
    out = []
    for e in events:
        acc = step(acc, e["n"], e["block"], e["timestamp"], e["topics"], e["data"])
        out.append(acc)
    return out


out_sequences = []
all_accs = []
for sid, desc, chain_id, address, events in sequences:
    events = numbered(events)
    accs = accumulators(chain_id, address, events)
    all_accs += accs
    out_sequences.append(
        {
            "id": sid,
            "description": desc,
            "chainId": str(chain_id),
            "address": address.hex(),
            "genesis": genesis(chain_id, address).hex(),
            "events": [
                {"block": str(e["block"]), "timestamp": str(e["timestamp"]), "topics": [t.hex() for t in e["topics"]], "data": e["data"].hex()}
                for e in events
            ],
            "accumulators": [a.hex() for a in accs],
        }
    )
# Every step of every sequence gives a distinct value: block, timestamp, index,
# chain and address each enter the hash.
assert len(set(all_accs)) == len(all_accs)

# Proof checks (Verification, rules 1 to 3): an archive of events, a storage
# proof (count, block, accumulator), and the first failing rule or null.
HIST = numbered(sequences[1][4])  # every-topic-count: blocks 100, 100, 101, 250, 251
HIST_ACCS = accumulators(BASE, ADDR, HIST)


def moved(events, i, **changes):
    out = [dict(e) for e in events]
    out[i].update(changes)
    return out


proof_cases = [
    ("whole-at-last-block", "The whole archive against a proof at its last block", HIST, 5, 251, HIST_ACCS[4]),
    ("prefix-at-boundary", "A proof at block 101 covers the first three logs; the fourth, at block 250, is after it", HIST, 3, 101, HIST_ACCS[2]),
    ("prefix-between-blocks", "A proof at block 200, between the third and fourth logs' blocks", HIST, 3, 200, HIST_ACCS[2]),
    ("both-logs-of-a-block", "A proof at block 100 covers both of its logs", HIST, 2, 100, HIST_ACCS[1]),
    ("empty-before-first", "A proof at block 99 with count 0 covers nothing; the first log is after it", HIST, 0, 99, genesis(BASE, ADDR)),
    ("log-left-out", "The archive leaves out the third log", [dict(e, n=i) for i, e in enumerate(HIST[:2] + HIST[3:])], 4, 251, HIST_ACCS[4]),
    ("index-gap", "The archive numbers the logs 0, 1, 3, …", moved(HIST, 2, n=3), 5, 251, HIST_ACCS[4]),
    ("block-decreases", "The fourth log is placed in block 99, before the third", moved(HIST, 3, block=99), 5, 251, HIST_ACCS[4]),
    ("timestamp-decreases", "The fourth log's timestamp is set below the third's", moved(HIST, 3, timestamp=T0), 5, 251, HIST_ACCS[4]),
    ("moved-block", "The third log is moved from block 101 to block 102, keeping the order", moved(HIST, 2, block=102), 5, 251, HIST_ACCS[4]),
    ("moved-timestamp", "The third log's timestamp is moved by one second, keeping the order", moved(HIST, 2, timestamp=T0 + 3), 5, 251, HIST_ACCS[4]),
    ("counted-after-proof", "A proof at block 101 claiming four logs: the fourth is after it", HIST, 4, 101, HIST_ACCS[3]),
    ("uncounted-before-proof", "A proof at block 250 claiming three logs while the fourth is at block 250", HIST, 3, 250, HIST_ACCS[2]),
    ("archive-short", "A proof claiming five logs against an archive of four", HIST[:4], 5, 251, HIST_ACCS[4]),
    ("other-address", "The archive's logs against another contract's proof", HIST, 5, 251, accumulators(BASE, bytes.fromhex("e7f1725e7734ce288f8367e1bb143e90bb3f0512"), HIST)[4]),
]

out_proofs = []
for pid, desc, events, count, block, acc in proof_cases:
    out_proofs.append(
        {
            "id": pid,
            "description": desc,
            "chainId": str(BASE),
            "address": ADDR.hex(),
            "events": [
                {"n": str(e["n"]), "block": str(e["block"]), "timestamp": str(e["timestamp"]), "topics": [t.hex() for t in e["topics"]], "data": e["data"].hex()}
                for e in events
            ],
            "proof": {"count": str(count), "block": str(block), "accumulator": acc.hex()},
            "error": check(BASE, ADDR, events, count, block, acc),
        }
    )
assert [p["error"] for p in out_proofs[:5]] == [None] * 5
assert all(p["error"] for p in out_proofs[5:])

doc = {
    "format": "abolish-event-accumulator-vectors/2",
    "title": "Event accumulator binding each log's block: genesis, steps, proof checks and rejected inputs",
    "spec": "docs/spec/contracts.md",
    "generator": "packages/crypto/scripts/event-accumulator-2-vectors.py: an independent Python implementation of docs/spec/contracts.md (Event accumulator) using hashlib only, sharing no code with packages/crypto or packages/contracts. Topic values are deterministic stand-ins (SHA-256 of a label), not real event signature hashes: the accumulator treats topics as opaque bytes.",
    "tag": TAG.decode(),
    "genesis": [
        {"id": gid, "description": desc, "chainId": str(c), "address": a.hex(), "accumulator": genesis(c, a).hex()}
        for gid, desc, c, a in genesis_vectors
    ],
    "sequences": out_sequences,
    "proofs": out_proofs,
    "rejected": [{"id": rid, "description": desc, **body} for rid, desc, body in rejected],
}
json.dump(doc, sys.stdout, indent=2)
sys.stdout.write("\n")
