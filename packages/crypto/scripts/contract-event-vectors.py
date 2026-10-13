#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event.json.

A second implementation of docs/spec/contracts.md (Contract-event record):
record type 0x0008 version 1, its strict decoding, the event check against a
definition's L2 contracts and their event tables (the canonical ABI encoding
of each event, with every embedded record decoding as its contract decodes
it), and the event accumulator over a contract's records. It is written from
the spec, the Solidity ABI specification and SEC 1 v2 with Python's standard
library only, and shares no code with packages/crypto or packages/contracts.
Python's hashlib has no Keccak-256 (Ethereum's padding), so this file carries
its own Keccak-f[1600] sponge, checked first against hashlib.sha3_256 (with
SHA-3's padding) and against Keccak-256's published empty-string digest.

Election definitions come from docs/spec/vectors/election-definition.json and
election-definition-v3.json, whose verdicts (decodes, or the decode error)
this script takes as given: those files are produced by their own independent
generators. Trustee keys come from docs/spec/vectors/trustee.json, and this
script checks each with its own SEC 1 decompression.

Usage: python3 -I packages/crypto/scripts/contract-event-vectors.py <repo-root>
"""

import hashlib
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


for m in (b"", b"abc", bytes(200)):
    assert sponge256(m, 0x06) == hashlib.sha3_256(m).digest()
assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"

# ------------------------------------------------------------- P-256 keys

P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B


def is_p256_key(b):
    """Whether b is a canonical p256-key: SEC 1 compressed, x < p, on the curve."""
    if len(b) != 33 or b[0] not in (2, 3):
        return False
    x = int.from_bytes(b[1:], "big")
    if x >= P:
        return False
    rhs = (x * x * x + A * x + B) % P
    y = pow(rhs, (P + 1) // 4, P)  # p ≡ 3 (mod 4)
    return y * y % P == rhs


# ------------------------------------------------------------- the record

RECORD_TYPE = 0x0008
VERSION = 1
MAX_EVENT_DATA = 1 << 20
MAX_EVENT_TOPICS = 4
MAX_U64 = 2**64 - 1
MAX_TRUSTEES = 16
MAX_REGISTRARS = 16
MAX_BATCH = 256
BN254_R = 0x30644E72E131A029B85045B68181585D2833E84879B9709143E1F593F0000001
POSEIDON2_ZERO_ONE = 0x1BD20834F5DE9830C643778A2E88A3A1363C8B9AC083D36D75BF87C49953E65E
ACC_TAG = b"abolish/v1/event-accumulator-2"


def u64(v):
    assert 0 <= v <= MAX_U64
    return v.to_bytes(8, "big")


def encode(contract, n, block, timestamp, topics, data, version=VERSION, record_type=RECORD_TYPE):
    assert len(contract) == 20 and all(len(t) == 32 for t in topics)
    return (
        record_type.to_bytes(2, "big")
        + bytes([version])
        + contract
        + u64(n)
        + u64(block)
        + u64(timestamp)
        + len(topics).to_bytes(4, "big")
        + b"".join(topics)
        + len(data).to_bytes(4, "big")
        + data
    )


class Reject(Exception):
    def __init__(self, code, offset):
        super().__init__(code)
        self.code = code
        self.offset = offset


def decode(b):
    """Strict decoding with version 1 pinned (notation.md, Strict decoding)."""
    at = 0

    def take(n):
        nonlocal at
        if len(b) - at < n:
            raise Reject("truncated", at)
        out = b[at : at + n]
        at += n
        return out

    t = int.from_bytes(take(2), "big")
    if t != RECORD_TYPE:
        raise Reject("unknown-record-type", 0)
    if take(1)[0] != VERSION:
        raise Reject("profile-mismatch", 2)
    contract = take(20)
    n = int.from_bytes(take(8), "big")
    block = int.from_bytes(take(8), "big")
    timestamp = int.from_bytes(take(8), "big")
    k_at = at
    k = int.from_bytes(take(4), "big")
    if k > MAX_EVENT_TOPICS:
        raise Reject("length-over-max", k_at)
    topics = [take(32) for _ in range(k)]
    d_at = at
    d = int.from_bytes(take(4), "big")
    if d > MAX_EVENT_DATA:
        raise Reject("length-over-max", d_at)
    data = take(d)
    if at != len(b):
        raise Reject("trailing-bytes", at)
    return {"contract": contract, "n": n, "block": block, "timestamp": timestamp, "topics": topics, "data": data}


# ------------------------------------------------------------- the ABI

def word(v):
    return v.to_bytes(32, "big")


def addr_word(a):
    return bytes(12) + a


def abi_bytes(b):
    return word(len(b)) + b + bytes((-len(b)) % 32)


def uint_of(w, bits):
    v = int.from_bytes(w, "big")
    return v if v >> bits == 0 else None


def abi_tail(data, head, at, unit):
    """The one dynamic field of `data` whose offset word is head word `at`, or None.

    Canonical only: the offset is exactly 32 * head, the length word is a
    u64, the body is zero-padded to a word, and nothing follows. `unit` is 1
    for `bytes` and 32 for an array of words.
    """
    if len(data) < 32 * head + 32:
        return None
    if uint_of(data[32 * at : 32 * at + 32], 64) != 32 * head:
        return None
    count = uint_of(data[32 * head : 32 * head + 32], 64)
    if count is None:
        return None
    length = count * unit
    padded = -(-length // 32) * 32
    body_at = 32 * head + 32
    if len(data) != body_at + padded:
        return None
    if any(data[body_at + length :]):
        return None
    return data[body_at : body_at + length]


def sig_topic(signature):
    return keccak256(signature.encode())


SIGNATURES = {
    "election-registry": [
        "ElectionCreated(bytes32,address,uint64,uint64,uint64,bytes32)",
        "DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)",
    ],
    "trustee-registry": [
        "PanelPinned(bytes32,uint8,uint8,bytes)",
        "CeremonyRegistered(bytes32,bytes32,bytes32,bytes)",
    ],
    "group-registry": [
        "RegistrarsPinned(uint8,address[])",
        "GroupCreated(uint64,uint8)",
        "MembersAdded(uint64,uint64,bytes)",
        "MembersRemoved(uint64,bytes)",
    ],
    "board": [],
}

# Indexed parameters of each event, by the ABI declarations in contracts.md.
INDEXED = {
    "ElectionCreated": ["electionId", "creator"],
    "DefinitionRegistered": ["electionId", "definitionHash"],
    "PanelPinned": ["panelId"],
    "CeremonyRegistered": ["stubHash", "panelId", "transcriptHash"],
    "RegistrarsPinned": [],
    "GroupCreated": ["groupId", "tier"],
    "MembersAdded": ["groupId", "firstIndex"],
    "MembersRemoved": ["groupId"],
}


def group_record_ok(rec, item, removal):
    """The group registry's stateless checks on an addition (item 32) or removal (item 8) record."""
    if len(rec) < 19:
        return False
    count = int.from_bytes(rec[16:18], "big")
    approvals_at = 18 + item * count
    if len(rec) < approvals_at + 1 or len(rec) != approvals_at + 1 + 66 * rec[approvals_at]:
        return False
    if not 1 <= count <= MAX_BATCH:
        return False
    if not removal:
        for i in range(count):
            c = int.from_bytes(rec[18 + 32 * i : 50 + 32 * i], "big")
            if c < 2 or c >= BN254_R or c == POSEIDON2_ZERO_ONE:
                return False
        return True
    size = int.from_bytes(rec[8:16], "big")
    last = None
    for i in range(count):
        index = int.from_bytes(rec[18 + 8 * i : 26 + 8 * i], "big")
        if last is not None and index <= last:
            return False
        if index >= size:
            return False
        last = index
    return True


def event_check(rec, contracts, definitions):
    """The event check: (role, event, fields) or the first failing code."""
    role = next((r for r, a in contracts.items() if a == rec["contract"]), None)
    if role is None:
        return "unknown-contract"
    topics, data = rec["topics"], rec["data"]
    names = {sig_topic(s): s for s in SIGNATURES[role]}
    if not topics or topics[0] not in names:
        return "unknown-event"
    signature = names[topics[0]]
    name = signature.split("(")[0]
    if len(topics) != 1 + len(INDEXED[name]):
        return "event-topics"
    w = [data[i : i + 32] for i in range(0, len(data) - len(data) % 32, 32)]

    if name == "ElectionCreated":
        if uint_of(topics[2], 160) is None:
            return "event-topics"
        if len(data) != 128 or any(uint_of(w[i], 64) is None for i in range(3)):
            return "event-data"
        return {
            "event": name,
            "electionId": topics[1].hex(),
            "creator": topics[2][12:].hex(),
            "counter": str(uint_of(w[0], 64)),
            "l1Origin": {"number": str(uint_of(w[1], 64)), "timestamp": str(uint_of(w[2], 64)), "hash": w[3].hex()},
        }
    if name == "DefinitionRegistered":
        body = abi_tail(data, 4, 3, 1)
        if body is None or any(uint_of(w[i], 64) is None for i in range(2)):
            return "event-data"
        if not definitions.get(body.hex(), False):
            return "event-data"
        return {
            "event": name,
            "electionId": topics[1].hex(),
            "definitionHash": topics[2].hex(),
            "l1Origin": {"number": str(uint_of(w[0], 64)), "timestamp": str(uint_of(w[1], 64)), "hash": w[2].hex()},
            "definition": body.hex(),
        }
    if name == "PanelPinned":
        body = abi_tail(data, 3, 2, 1)
        if body is None or uint_of(w[0], 8) is None or uint_of(w[1], 8) is None:
            return "event-data"
        if len(body) == 0 or len(body) % 33 or len(body) > 33 * MAX_TRUSTEES:
            return "event-data"
        keys = [body[i : i + 33] for i in range(0, len(body), 33)]
        if not all(is_p256_key(k) for k in keys):
            return "event-data"
        return {
            "event": name,
            "panelId": topics[1].hex(),
            "threshold": uint_of(w[0], 8),
            "quorum": uint_of(w[1], 8),
            "keys": [k.hex() for k in keys],
        }
    if name == "CeremonyRegistered":
        body = abi_tail(data, 1, 0, 1)
        if body is None or len(body) < 97 or len(body) != 97 + 65 * body[96]:
            return "event-data"
        return {
            "event": name,
            "stubHash": topics[1].hex(),
            "panelId": topics[2].hex(),
            "transcriptHash": topics[3].hex(),
            "registration": body.hex(),
        }
    if name == "RegistrarsPinned":
        body = abi_tail(data, 2, 1, 32)
        if body is None or uint_of(w[0], 8) is None or len(body) > 32 * MAX_REGISTRARS:
            return "event-data"
        words = [body[i : i + 32] for i in range(0, len(body), 32)]
        if any(uint_of(x, 160) is None for x in words):
            return "event-data"
        return {"event": name, "threshold": uint_of(w[0], 8), "registrars": [x[12:].hex() for x in words]}
    if name == "GroupCreated":
        if uint_of(topics[1], 64) is None or uint_of(topics[2], 8) is None:
            return "event-topics"
        if data:
            return "event-data"
        return {"event": name, "groupId": str(uint_of(topics[1], 64)), "tier": uint_of(topics[2], 8)}
    if name == "MembersAdded":
        if uint_of(topics[1], 64) is None or uint_of(topics[2], 64) is None:
            return "event-topics"
        body = abi_tail(data, 1, 0, 1)
        if body is None or not group_record_ok(body, 32, False):
            return "event-data"
        return {
            "event": name,
            "groupId": str(uint_of(topics[1], 64)),
            "firstIndex": str(uint_of(topics[2], 64)),
            "record": body.hex(),
        }
    if name == "MembersRemoved":
        if uint_of(topics[1], 64) is None:
            return "event-topics"
        body = abi_tail(data, 1, 0, 1)
        if body is None or not group_record_ok(body, 8, True):
            return "event-data"
        return {"event": name, "groupId": str(uint_of(topics[1], 64)), "record": body.hex()}
    raise AssertionError(name)


# ------------------------------------------------------------- the accumulator

def acc_hash(m):
    return hashlib.sha256(bytes([len(ACC_TAG)]) + ACC_TAG + m).digest()


def genesis(chain_id, address):
    return acc_hash(b"\x00" + u64(chain_id) + address)


def step(acc, rec):
    t = rec["topics"]
    return acc_hash(
        b"\x01" + acc + u64(rec["n"]) + u64(rec["block"]) + u64(rec["timestamp"])
        + bytes([len(t)]) + b"".join(t) + len(rec["data"]).to_bytes(4, "big") + rec["data"]
    )


# ------------------------------------------------------------- vectors

def det(label, n):
    out = b""
    i = 0
    while len(out) < n:
        out += hashlib.sha256(f"contract-event/{label}/{i}".encode()).digest()
        i += 1
    return out[:n]


def main(root):
    vec = root / "docs/spec/vectors"
    d1 = json.loads((vec / "election-definition.json").read_text())["vectors"]
    d3 = json.loads((vec / "election-definition-v3.json").read_text())["vectors"]
    by_id = {v["id"]: bytes.fromhex(v["encoding"]) for v in d1 + d3}
    # Whether each definition decodes as version 1 with its self-pin, by its
    # own file's verdict: an `error` means it doesn't; version 3 never does
    # here, since the registry decodes version 1 only.
    definitions = {}
    for v in d1:
        definitions[v["encoding"]] = "error" not in v
    for v in d3:
        definitions[v["encoding"]] = False
    # A strict decoder consumes a whole valid encoding exactly, so every proper
    # prefix of one runs out of input: the largest definition less its last
    # byte doesn't decode.
    definitions[by_id["definition-maximal"][:-1].hex()] = False

    key_vectors = json.loads((vec / "trustee.json").read_text())["keys"]
    # This file's decompression agrees with trustee.json on every key it lists.
    for k in key_vectors:
        assert is_p256_key(bytes.fromhex(k["encoding"])) == ("error" not in k), k["id"]
    trustee_keys = [bytes.fromhex(k["encoding"]) for k in key_vectors if "secretKey" in k]
    bad_x = next(
        bytes([2]) + x.to_bytes(32, "big") for x in range(1, 100) if not is_p256_key(bytes([2]) + x.to_bytes(32, "big"))
    )

    chain_id = 84532
    contracts = {
        "election-registry": det("election-registry", 20),
        "trustee-registry": det("trustee-registry", 20),
        "group-registry": det("group-registry", 20),
        "board": det("board", 20),
    }
    other = det("l1-anchor", 20)
    T = {name.split("(")[0]: sig_topic(name) for role in SIGNATURES.values() for name in role}

    records = []
    failures = []

    def record(rid, description, contract, n, block, ts, topics, data, honest=True):
        rec = {"contract": contract, "n": n, "block": block, "timestamp": ts, "topics": topics, "data": data}
        enc = encode(contract, n, block, ts, topics, data)
        assert decode(enc) == rec
        result = event_check(rec, contracts, definitions)
        entry = {
            "id": rid,
            "description": description,
            "fields": {
                "contract": contract.hex(),
                "n": str(n),
                "l2Block": str(block),
                "l2Timestamp": str(ts),
                "topics": [t.hex() for t in topics],
                "data": data.hex(),
            },
            "encoding": enc.hex(),
        }
        if isinstance(result, str):
            assert not honest, rid
            entry["error"] = result
            failures.append(entry)
        else:
            assert honest, rid
            role = next(r for r, a in contracts.items() if a == contract)
            entry["role"] = role
            entry["event"] = result
            records.append((entry, rec))
        return entry

    er, tr, gr, board = (contracts[r] for r in ("election-registry", "trustee-registry", "group-registry", "board"))
    creator = det("creator", 20)
    eid = det("election-id", 32)
    origin = [word(19_000_000), word(1_760_000_000), det("l1-origin-hash", 32)]
    created_data = word(0) + b"".join(origin)
    defn = by_id["definition-typical"]
    reg_data = word(19_000_001) + word(1_760_000_012) + det("l1-origin-hash-2", 32) + word(128) + abi_bytes(defn)

    # --- honest records, in each contract's order of n, blocks non-decreasing.
    record("election-created", "ElectionCreated: three topics and four words", er, 0, 100, 1_760_000_100,
           [T["ElectionCreated"], eid, addr_word(creator)], created_data)
    record("definition-registered", "DefinitionRegistered carrying a well-formed version-1 definition", er, 1, 140,
           1_760_000_180, [T["DefinitionRegistered"], eid, det("definition-hash", 32)], reg_data)
    record("definition-registered-ill-formed", "DefinitionRegistered carrying a definition that decodes but breaks a "
           "well-formedness rule: the event check is form only, well-formedness is verifier 2.1's", er, 2, 140,
           1_760_000_180, [T["DefinitionRegistered"], det("election-id-2", 32), det("definition-hash-2", 32)],
           reg_data[:128] + abi_bytes(by_id["definition-one-option"]))
    record("definition-registered-maximal", "DefinitionRegistered carrying the largest definition vector", er, 3, 141,
           1_760_000_182, [T["DefinitionRegistered"], det("election-id-3", 32), det("definition-hash-3", 32)],
           reg_data[:128] + abi_bytes(by_id["definition-maximal"]))
    record("election-created-max-values", "ElectionCreated with every uint64 at 2^64 - 1 and the largest address", er,
           4, MAX_U64, MAX_U64, [T["ElectionCreated"], bytes([0xFF] * 32), addr_word(bytes([0xFF] * 20))],
           word(MAX_U64) + word(MAX_U64) + word(MAX_U64) + bytes([0xFF] * 32))

    panel_id = det("panel-id", 32)
    keys = trustee_keys[:3]
    record("panel-pinned", "PanelPinned: threshold, quorum and three key encodings", tr, 0, 50, 1_760_000_000,
           [T["PanelPinned"], panel_id], word(2) + word(2) + word(96) + abi_bytes(b"".join(keys)))
    record("panel-pinned-max", "PanelPinned with MAX_TRUSTEES keys", tr, 1, 50, 1_760_000_000,
           [T["PanelPinned"], det("panel-id-16", 32)],
           word(255) + word(255) + word(96) + abi_bytes(b"".join((trustee_keys * 16)[:16])))
    stub, transcript = det("stub", 32), det("transcript", 32)
    registration = panel_id + stub + transcript + bytes([2]) + b"".join(bytes([i]) + det(f"sig-{i}", 64) for i in (1, 2))
    record("ceremony-registered", "CeremonyRegistered with two approvals (97 + 65 * 2 bytes)", tr, 2, 160,
           1_760_000_200, [T["CeremonyRegistered"], stub, panel_id, transcript], word(32) + abi_bytes(registration))
    record("ceremony-registered-no-approvals", "CeremonyRegistered whose record has no approvals: its length is "
           "right, and the quorum is verifier 3.1's", tr, 3, 161, 1_760_000_202,
           [T["CeremonyRegistered"], stub, det("panel-id-2", 32), transcript],
           word(32) + abi_bytes(det("panel-id-2", 32) + stub + transcript + bytes([0])))
    max_registration = (det("panel-id-3", 32) + stub + transcript + bytes([255])
                        + b"".join(bytes([i % 256]) + det(f"sig-max-{i}", 64) for i in range(255)))
    record("ceremony-registered-max", "CeremonyRegistered with 255 approvals, the most its count byte names", tr, 4,
           162, 1_760_000_204, [T["CeremonyRegistered"], stub, det("panel-id-3", 32), transcript],
           word(32) + abi_bytes(max_registration))

    registrars = [det(f"registrar-{i}", 20) for i in range(3)]
    record("registrars-pinned", "RegistrarsPinned: the threshold and three addresses", gr, 0, 40, 1_759_999_980,
           [T["RegistrarsPinned"]], word(2) + word(64) + word(3) + b"".join(addr_word(a) for a in registrars))
    record("group-created", "GroupCreated: two indexed values and no data", gr, 1, 60, 1_760_000_020,
           [T["GroupCreated"], word(0), word(2)], b"")
    commitments = [word(2), word(BN254_R - 1)]
    approvals = b"".join(bytes([s]) + det(f"r-{s}", 32) + det(f"s-{s}", 32) + bytes([27]) for s in (0, 1))
    addition = u64(0) + u64(0) + (2).to_bytes(2, "big") + b"".join(commitments) + bytes([2]) + approvals
    record("members-added", "MembersAdded: two commitments at the field's boundaries, two approvals", gr, 2, 61,
           1_760_000_022, [T["MembersAdded"], word(0), word(0)], word(32) + abi_bytes(addition))
    removal = u64(0) + u64(2) + (1).to_bytes(2, "big") + u64(1) + bytes([2]) + approvals
    record("members-removed", "MembersRemoved: one index below the signed size", gr, 3, 62, 1_760_000_024,
           [T["MembersRemoved"], word(0)], word(32) + abi_bytes(removal))
    record("group-created-max", "GroupCreated with the largest group identifier and tier word: the tier's range is "
           "the registry's to refuse, not the record's", gr, 4, 62, 1_760_000_024,
           [T["GroupCreated"], word(MAX_U64), word(255)], b"")
    max_approvals = b"".join(bytes([s % 256]) + det(f"r-max-{s}", 32) + det(f"s-max-{s}", 32) + bytes([28]) for s in range(255))
    max_addition = (u64(1) + u64(0) + (MAX_BATCH).to_bytes(2, "big")
                    + b"".join(word(2 + i) for i in range(MAX_BATCH)) + bytes([255]) + max_approvals)
    max_added_data = word(32) + abi_bytes(max_addition)
    assert len(max_added_data) == 25_120
    record("members-added-max", "MembersAdded at the largest record the stateless checks accept: a full batch and "
           "255 approvals, 25,120 bytes of data", gr, 5, 63, 1_760_000_026, [T["MembersAdded"], word(1), word(0)],
           max_added_data)

    # --- records that decode but fail the event check, one code at a time.
    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, 0, 1, 1, topics, data, honest=False)

    created_topics = [T["ElectionCreated"], eid, addr_word(creator)]
    fail("unknown-contract", "An ElectionCreated log from an address the definition doesn't name", other,
         created_topics, created_data)
    fail("unknown-event-other-contract", "GroupCreated is the group registry's, not the election registry's", er,
         [T["GroupCreated"], word(0), word(2)], b"")
    fail("unknown-event-board", "The board's table is empty until direct submission specifies it", board,
         created_topics, created_data)
    fail("unknown-event-no-topics", "A log with no topics (an anonymous event)", er, [], created_data)
    fail("unknown-event-old-signature", "ElectionCreated's signature before the L1 origin was added",
         er, [sig_topic("ElectionCreated(bytes32,address,uint64)"), eid, addr_word(creator)], word(0))
    fail("event-topics-too-few", "ElectionCreated without its creator topic", er, created_topics[:2], created_data)
    fail("event-topics-too-many", "ElectionCreated with a fourth topic", er, created_topics + [word(0)], created_data)
    fail("event-topics-address-high-bits", "The creator topic with a bit set above its 160", er,
         [T["ElectionCreated"], eid, word(1 << 160)], created_data)
    fail("event-topics-group-id-over-u64", "GroupCreated's group identifier at 2^64", gr,
         [T["GroupCreated"], word(1 << 64), word(2)], b"")
    fail("event-topics-tier-over-u8", "GroupCreated's tier word at 256", gr, [T["GroupCreated"], word(0), word(256)], b"")
    fail("event-topics-first-index-over-u64", "MembersAdded's first index at 2^64", gr,
         [T["MembersAdded"], word(0), word(1 << 64)], word(32) + abi_bytes(addition))
    fail("event-data-short", "ElectionCreated with three words of data", er, created_topics, created_data[:96])
    fail("event-data-long", "ElectionCreated with a fifth word of data", er, created_topics, created_data + word(0))
    fail("event-data-counter-over-u64", "ElectionCreated's counter at 2^64", er, created_topics,
         word(1 << 64) + created_data[32:])
    fail("event-data-origin-over-u64", "ElectionCreated's L1 origin timestamp at 2^64", er, created_topics,
         created_data[:64] + word(1 << 64) + created_data[96:])
    reg_topics = [T["DefinitionRegistered"], eid, det("definition-hash", 32)]
    fail("event-data-offset", "DefinitionRegistered whose offset skips a word (0xa0, not 0x80)", er, reg_topics,
         reg_data[:96] + word(160) + word(0) + abi_bytes(defn))
    fail("event-data-padding", "DefinitionRegistered with a non-zero padding byte", er, reg_topics,
         reg_data[:-1] + b"\x01")
    fail("event-data-trailing", "DefinitionRegistered with a word after the definition", er, reg_topics,
         reg_data + word(0))
    fail("event-data-length-over-u64", "DefinitionRegistered whose length word is 2^64", er, reg_topics,
         reg_data[:128] + word(1 << 64) + reg_data[160:])
    fail("event-data-definition-truncated", "DefinitionRegistered carrying a definition that doesn't decode", er,
         reg_topics, reg_data[:128] + abi_bytes(by_id["definition-truncated"]))
    fail("event-data-definition-profile", "DefinitionRegistered carrying a definition its own profile doesn't pin",
         er, reg_topics, reg_data[:128] + abi_bytes(by_id["definition-profile-pins-other-version"]))
    fail("event-data-definition-v3", "DefinitionRegistered carrying a version-3 definition, which the registry "
         "doesn't decode", er, reg_topics, reg_data[:128] + abi_bytes(by_id["definition-v3-typical"]))
    fail("event-data-definition-maximal-short", "DefinitionRegistered carrying the largest definition less its last "
         "byte", er, reg_topics, reg_data[:128] + abi_bytes(by_id["definition-maximal"][:-1]))
    fail("event-data-registration-max-extra-byte", "CeremonyRegistered with 255 approvals and one byte more", tr,
         [T["CeremonyRegistered"], stub, det("panel-id-3", 32), transcript],
         word(32) + abi_bytes(max_registration + b"\x00"))
    fail("event-data-addition-max-extra-byte", "MembersAdded at the largest record and one byte more", gr,
         [T["MembersAdded"], word(1), word(0)], word(32) + abi_bytes(max_addition + b"\x00"))
    panel_topics = [T["PanelPinned"], panel_id]
    fail("event-data-keys-length", "PanelPinned's encodings one byte past a multiple of 33", tr, panel_topics,
         word(2) + word(2) + word(96) + abi_bytes(b"".join(keys) + b"\x00"))
    fail("event-data-keys-empty", "PanelPinned with no keys", tr, panel_topics, word(2) + word(2) + word(96) + abi_bytes(b""))
    fail("event-data-keys-17", "PanelPinned with MAX_TRUSTEES + 1 keys", tr, panel_topics,
         word(2) + word(2) + word(96) + abi_bytes(b"".join((trustee_keys * 17)[:17])))
    fail("event-data-key-uncompressed-prefix", "PanelPinned with a key whose prefix is 0x04", tr, panel_topics,
         word(2) + word(2) + word(96) + abi_bytes(keys[0] + b"\x04" + keys[1][1:]))
    fail("event-data-key-off-curve", "PanelPinned with a key whose x has no point", tr, panel_topics,
         word(2) + word(2) + word(96) + abi_bytes(keys[0] + bad_x))
    fail("event-data-threshold-over-u8", "PanelPinned's threshold word at 256", tr, panel_topics,
         word(256) + word(2) + word(96) + abi_bytes(b"".join(keys)))
    cer_topics = [T["CeremonyRegistered"], stub, panel_id, transcript]
    fail("event-data-registration-extra-byte", "CeremonyRegistered's record one byte past 97 + 65 * count", tr,
         cer_topics, word(32) + abi_bytes(registration + b"\x00"))
    fail("event-data-registration-count", "CeremonyRegistered's count byte names three approvals and two follow",
         tr, cer_topics, word(32) + abi_bytes(registration[:96] + bytes([3]) + registration[97:]))
    fail("event-data-registration-short", "CeremonyRegistered's record shorter than its 97-byte header", tr,
         cer_topics, word(32) + abi_bytes(registration[:96]))
    fail("event-data-registrars-17", "RegistrarsPinned with MAX_REGISTRARS + 1 addresses", gr, [T["RegistrarsPinned"]],
         word(2) + word(64) + word(17) + b"".join(addr_word(det(f"r{i}", 20)) for i in range(17)))
    fail("event-data-registrar-high-bits", "RegistrarsPinned with an address word that has a bit above its 160", gr,
         [T["RegistrarsPinned"]], word(2) + word(64) + word(1) + word(1 << 160))
    fail("event-data-group-created-data", "GroupCreated with a word of data", gr,
         [T["GroupCreated"], word(0), word(2)], word(0))
    fail("event-data-forbidden-commitment", "MembersAdded whose record adds the commitment 1", gr,
         [T["MembersAdded"], word(0), word(0)],
         word(32) + abi_bytes(addition[:18] + word(1) + addition[50:]))
    fail("event-data-addition-length", "MembersAdded whose record has a byte after its approvals", gr,
         [T["MembersAdded"], word(0), word(0)], word(32) + abi_bytes(addition + b"\x00"))
    fail("event-data-removal-order", "MembersRemoved whose indices repeat", gr, [T["MembersRemoved"], word(0)],
         word(32) + abi_bytes(u64(0) + u64(4) + (2).to_bytes(2, "big") + u64(1) + u64(1) + bytes([0])))

    # --- framing: rejected before any event check.
    honest = bytes.fromhex(records[0][0]["encoding"])
    k_at = 3 + 20 + 24
    decode_errors = []

    def reject(rid, description, b):
        try:
            decode(b)
        except Reject as e:
            decode_errors.append({"id": rid, "description": description, "encoding": b.hex(), "error": e.code, "offset": e.offset})
            return
        raise AssertionError(rid)

    reject("empty", "No bytes", b"")
    reject("truncated-header", "Only the record type", honest[:2])
    reject("truncated-data", "The data one byte short of its length", honest[:-1])
    reject("trailing-bytes", "A byte after the data", honest + b"\x00")
    reject("other-record-type", "The board-entry type, which this decoder doesn't read", b"\x00\x07" + honest[2:])
    reject("type-zero", "Record type 0x0000", b"\x00\x00" + honest[2:])
    reject("version-two", "Version 2, against the pinned version 1", honest[:2] + b"\x02" + honest[3:])
    reject("version-zero", "Version 0, against the pinned version 1", honest[:2] + b"\x00" + honest[3:])
    reject("topics-over-max", "Five topics", honest[:k_at] + (5).to_bytes(4, "big") + honest[k_at + 4 :])
    d_at = k_at + 4 + 32 * 3
    reject("data-over-max", "A data length of MAX_EVENT_DATA + 1, rejected before it is read",
           honest[:d_at] + (MAX_EVENT_DATA + 1).to_bytes(4, "big"))
    reject("topics-truncated", "Three topics announced and two present",
           honest[:k_at + 4 + 64])

    # --- each contract's records replayed into its accumulator.
    sequences = []
    for role in ("election-registry", "trustee-registry", "group-registry"):
        recs = [r for e, r in records if e["role"] == role]
        assert [r["n"] for r in recs] == list(range(len(recs)))
        acc = genesis(chain_id, contracts[role])
        accs = []
        for r in recs:
            acc = step(acc, r)
            accs.append(acc.hex())
        sequences.append({
            "role": role,
            "records": [e["id"] for e, r in records if e["role"] == role],
            "accumulators": accs,
            "count": str(len(recs)),
        })

    out = {
        "format": "abolish-contract-event-vectors/1",
        "title": "Contract-event records (0x0008): encoding, strict decoding, the event check and the accumulator",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event accumulator) with its own Keccak-256 and SEC 1 "
            "decompression; definitions and their verdicts from election-definition.json and "
            "election-definition-v3.json, keys from trustee.json"
        ),
        "recordType": "0x0008",
        "version": VERSION,
        "maxEventData": MAX_EVENT_DATA,
        "maxEventTopics": MAX_EVENT_TOPICS,
        "chainId": str(chain_id),
        "contracts": {r: a.hex() for r, a in contracts.items()},
        "events": [
            {"role": role, "signature": s, "indexed": INDEXED[s.split("(")[0]], "topic0": sig_topic(s).hex()}
            for role, sigs in SIGNATURES.items()
            for s in sigs
        ],
        "records": [e for e, _ in records],
        "eventFailures": failures,
        "decodeErrors": decode_errors,
        "sequences": sequences,
    }
    with open(vec / "contract-event.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
