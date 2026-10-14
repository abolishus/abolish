#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/relay.json.

A second implementation of docs/spec/contracts.md (L1 relay): the relay's
calldata, the framing of the record it carries, the call hash it stores under
abolish/v1/relay-call, the deposit's calldata to the board, the address the
deposit comes from on L2, the relay's storage slots, its event and its event
accumulator. It is written from the spec and the Solidity ABI specification
with Python's standard library only, and shares no code with packages/crypto
or packages/contracts. Python's hashlib has no Keccak-256 (Ethereum's
padding), so this file carries its own Keccak-f[1600] sponge, checked first
against hashlib.sha3_256 (with SHA-3's padding) and against Keccak-256's
published empty-string digest.

Usage: python3 -I packages/crypto/scripts/relay-vectors.py > docs/spec/vectors/relay.json
"""

import hashlib
import json
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

# ------------------------------------------------------------- the spec

CALL_TAG = b"abolish/v1/relay-call"
ACC_TAG = b"abolish/v1/event-accumulator-2"
MAX_U64 = 2**64 - 1
PORTAL_MAX_DATA = 120_000
# The relay's deposit data is 196 bytes of head and length before the record
# and the record's zero padding after it (contracts.md, L1 relay, Relaying).
DEPOSIT_OVERHEAD = 4 + 32 * 6
MAX_RELAY_RECORD = (PORTAL_MAX_DATA - DEPOSIT_OVERHEAD) // 32 * 32
assert MAX_RELAY_RECORD == 119_776
BALLOT_TYPE = b"\x00\x02"
ALIAS_OFFSET = 0x1111000000000000000000000000000000001111

RELAY_SIGNATURE = "relayBallot(uint64,bytes)"
DEPOSIT_SIGNATURE = "submitRelayedBallot(uint64,uint64,uint64,uint64,bytes)"
EVENT_SIGNATURE = "BallotRelayed(bytes32,uint64,bytes32)"


def ds_hash(tag, m):
    return hashlib.sha256(bytes([len(tag)]) + tag + m).digest()


def u64(v):
    assert 0 <= v <= MAX_U64
    return v.to_bytes(8, "big")


def word(v):
    return v.to_bytes(32, "big")


def pad32(b):
    return b + bytes(-len(b) % 32)


def selector(signature):
    return keccak256(signature.encode())[:4]


def frame(record):
    """The relay's framing of its record, in the spec's order: the code of
    the first failing check, or None."""
    if len(record) > MAX_RELAY_RECORD:
        return "relay-too-large"
    if len(record) < 35:
        return "relay-truncated"
    if record[:2] != BALLOT_TYPE:
        return "relay-record-type"
    return None


def relay_calldata(gas_limit, record):
    return selector(RELAY_SIGNATURE) + word(gas_limit) + word(0x40) + word(len(record)) + pad32(record)


def check_calldata(calldata):
    """relayBallot's canonical-calldata rule: (gasLimit, record), or None."""
    if len(calldata) < 4 + 32 * 3 or calldata[:4] != selector(RELAY_SIGNATURE):
        return None
    body = calldata[4:]
    gas, offset, length = (int.from_bytes(body[i : i + 32], "big") for i in (0, 32, 64))
    if gas > MAX_U64 or offset != 0x40 or length > len(body):
        return None
    record = body[96 : 96 + length]
    if len(record) != length or body[96:] != pad32(record):
        return None
    return gas, record


def call_hash(chain_id, relay, index, block, timestamp, gas_limit, record):
    assert len(relay) == 20
    return ds_hash(
        CALL_TAG,
        u64(chain_id) + relay + u64(index) + u64(block) + u64(timestamp) + u64(gas_limit) + record,
    )


def deposit_data(index, block, timestamp, gas_limit, record):
    return (
        selector(DEPOSIT_SIGNATURE)
        + word(index)
        + word(block)
        + word(timestamp)
        + word(gas_limit)
        + word(0xA0)
        + word(len(record))
        + pad32(record)
    )


def l2_alias(address):
    assert len(address) == 20
    return ((int.from_bytes(address, "big") + ALIAS_OFFSET) % 2**160).to_bytes(20, "big")


def namespace(name):
    """ERC-7201's base slot for a namespace."""
    inner = int.from_bytes(keccak256(name.encode()), "big") - 1
    return int.from_bytes(keccak256(word(inner)), "big") & ~0xFF


def call_slot(base, index):
    """Solidity's mapping(uint64 => bytes32) at base + 1."""
    return int.from_bytes(keccak256(word(index) + word(base + 1)), "big")


def event(definition_hash, index, ch):
    return [keccak256(EVENT_SIGNATURE.encode()), definition_hash, word(index)], ch


def acc_genesis(chain_id, address):
    return ds_hash(ACC_TAG, b"\x00" + u64(chain_id) + address)


def acc_step(acc, n, block, timestamp, topics, data):
    return ds_hash(
        ACC_TAG,
        b"\x01"
        + acc
        + u64(n)
        + u64(block)
        + u64(timestamp)
        + bytes([len(topics)])
        + b"".join(topics)
        + len(data).to_bytes(4, "big")
        + data,
    )


def det(label, n):
    """Deterministic filler bytes, so the vectors are reproducible."""
    out = b""
    i = 0
    while len(out) < n:
        out += hashlib.sha256(f"{label}/{i}".encode()).digest()
        i += 1
    return out[:n]


def ballot(label, version, length):
    """A record the relay frames: type 0x0002, a version, a definition hash
    and filler. The relay reads nothing past the definition hash."""
    assert length >= 35
    return BALLOT_TYPE + bytes([version]) + det(label + "/definition", 32) + det(label + "/body", length - 35)


# Records longer than this are given by prefix and length, filled with
# det(label, length - len(prefix)), to keep the file small.
INLINE = 512


def record_fields(label, record):
    if len(record) <= INLINE:
        return {"record": record.hex()}
    return {"recordPrefix": record[:35].hex(), "recordLength": len(record), "recordFill": label}


def filled(prefix, label, length):
    assert len(prefix) == 35
    return prefix + det(label, length - len(prefix))


def main():
    relay = det("relay/address", 20)
    other_relay = det("relay/other-address", 20)
    l1 = 11_155_111  # Sepolia

    base = namespace("abolish.ballot-relay")
    storage = {
        "namespace": "abolish.ballot-relay",
        "base": word(base).hex(),
        "countSlot": word(base).hex(),
        "callsSlot": word(base + 1).hex(),
        "callSlots": [
            {"index": str(i), "slot": word(call_slot(base, i)).hex()} for i in (0, 1, 2, 255, 2**32, MAX_U64)
        ],
    }

    aliases = [
        {"l1": a.hex(), "l2": l2_alias(a).hex()}
        for a in (
            relay,
            bytes(20),
            bytes.fromhex("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
            # The sum wraps modulo 2^160.
            bytes.fromhex("ffffffffffffffffffffffffffffffffffffffff"),
            bytes.fromhex("eeeeffffffffffffffffffffffffffffffffeeee"),
        )
    ]

    small = ballot("call/small", 1, 35)
    typical = ballot("call/typical", 3, 400)
    largest_v4 = filled(BALLOT_TYPE + b"\x04" + det("call/v4/definition", 32), "call/v4/body", 81_932)
    largest = filled(BALLOT_TYPE + b"\x05" + det("call/max/definition", 32), "call/max/body", MAX_RELAY_RECORD)
    other_proof = typical[:200] + bytes([typical[200] ^ 1]) + typical[201:]
    calls_in = [
        ("shortest", "The shortest record the relay frames: header and definition hash only", l1, relay, 0, 6_000_000, 1_800_000_000, 5_000_000, small, "call/small"),
        ("typical", "A ballot-version-3 record of 400 bytes", l1, relay, 1, 6_000_001, 1_800_000_012, 5_000_000, typical, "call/typical"),
        ("same-record-next-call", "The same record relayed again, one slot later: another index, block and stamp, so another hash", l1, relay, 2, 6_000_002, 1_800_000_024, 5_000_000, typical, "call/typical"),
        ("other-relay", "The typical call's fields, recorded by another relay", l1, other_relay, 1, 6_000_001, 1_800_000_012, 5_000_000, typical, "call/typical"),
        ("other-chain", "The typical call's fields on another L1 (mainnet)", 1, relay, 1, 6_000_001, 1_800_000_012, 5_000_000, typical, "call/typical"),
        ("u64-extremes", "The largest index, block, stamp and gas limit", MAX_U64, relay, MAX_U64, MAX_U64, MAX_U64, MAX_U64, small, "call/small"),
        ("large-v4", "About the largest ballot-version-4 record (81,932 bytes)", l1, relay, 3, 6_000_100, 1_800_001_200, 5_000_000, largest_v4, "call/v4/body"),
        ("largest", "A record of MAX_RELAY_RECORD bytes, whose deposit data is within 32 bytes of the portal's cap", l1, relay, 4, 6_000_101, 1_800_001_212, 5_000_000, largest, "call/max/body"),
        ("other-gas", "The typical call with another gas limit", l1, relay, 1, 6_000_001, 1_800_000_012, 5_000_001, typical, "call/typical"),
        ("other-proof", "The typical call's record with one byte of its membership proof changed: the same header and ballot hash, another call hash", l1, relay, 1, 6_000_001, 1_800_000_012, 5_000_000, other_proof, "call/other-proof"),
    ]
    calls = []
    for cid, desc, chain, rel, index, block, ts, gas, record, fill in calls_in:
        assert frame(record) is None
        ch = call_hash(chain, rel, index, block, ts, gas, record)
        data = deposit_data(index, block, ts, gas, record)
        assert len(data) <= PORTAL_MAX_DATA
        topics, ev_data = event(record[3:35], index, ch)
        v = {
            "id": cid,
            "description": desc,
            "l1ChainId": str(chain),
            "relay": rel.hex(),
            "index": str(index),
            "l1Block": str(block),
            "l1Timestamp": str(ts),
            "gasLimit": str(gas),
            **record_fields(fill, record),
            "callHash": ch.hex(),
            "topics": [t.hex() for t in topics],
            "data": ev_data.hex(),
        }
        if len(record) <= INLINE:
            v["depositData"] = data.hex()
        v["depositDataLength"] = len(data)
        v["depositDataSha256"] = hashlib.sha256(data).hexdigest()
        calls.append(v)

    framing_in = [
        ("empty", "No bytes", b"", "empty"),
        ("type-only", "A ballot record's type alone", BALLOT_TYPE, "type-only"),
        ("one-short", "34 bytes: the definition hash one byte short", ballot("frame/short", 1, 35)[:34], "frame/short"),
        ("shortest", "35 bytes: type, version and definition hash", ballot("frame/ok", 1, 35), "frame/ok"),
        ("any-version", "A version the relay doesn't read (0xff): framed; the board judges the version", BALLOT_TYPE + b"\xff" + det("frame/v/def", 32) + det("frame/v/body", 100), "frame/v"),
        ("type-0001", "Record type 0x0001 (an election definition)", b"\x00\x01" + det("frame/t1", 98), "frame/t1"),
        ("type-0003", "Record type 0x0003", b"\x00\x03" + det("frame/t3", 98), "frame/t3"),
        ("type-0200", "The ballot type's bytes swapped", b"\x02\x00" + det("frame/t200", 98), "frame/t200"),
        ("short-wrong-type", "34 bytes of another type: truncated is found first", b"\x00\x01" + det("frame/st", 32), "frame/st"),
        ("max", "MAX_RELAY_RECORD bytes", filled(BALLOT_TYPE + b"\x01" + det("frame/max/def", 32), "frame/max", MAX_RELAY_RECORD), "frame/max"),
        ("max-plus-one", "One byte more than MAX_RELAY_RECORD", filled(BALLOT_TYPE + b"\x01" + det("frame/max1/def", 32), "frame/max1", MAX_RELAY_RECORD + 1), "frame/max1"),
        ("too-large-wrong-type", "Too large and of another type: too large is found first", filled(b"\x00\x01" + det("frame/big/head", 33), "frame/big", MAX_RELAY_RECORD + 32), "frame/big"),
    ]
    framing = []
    for fid, desc, record, fill in framing_in:
        code = frame(record)
        v = {"id": fid, "description": desc, **record_fields(fill, record), "result": code or "framed"}
        if code is None:
            v["definitionHash"] = record[3:35].hex()
        framing.append(v)

    rec = ballot("calldata/record", 1, 70)
    good = relay_calldata(5_000_000, rec)
    sel = selector(RELAY_SIGNATURE)
    calldata_in = [
        ("canonical", "The ABI encoding of (5,000,000, a 70-byte record)", good),
        ("canonical-aligned", "A 64-byte record: no padding", relay_calldata(5_000_000, ballot("calldata/aligned", 1, 64))),
        ("canonical-max-gas", "The largest uint64 gas limit", relay_calldata(MAX_U64, rec)),
        ("gas-above-u64", "A gas limit word with bit 64 set", sel + word(2**64) + good[36:]),
        ("offset-0x60", "The record's offset 0x60, with a junk word before it", sel + word(5_000_000) + word(0x60) + word(0) + good[68:]),
        ("dirty-padding", "A non-zero padding byte", good[:-1] + b"\x01"),
        ("trailing-word", "A zero word after the padding", good + bytes(32)),
        ("short-padding", "Padding cut short", good[:-1]),
        ("length-past-end", "A length word past the end of the calldata", sel + word(5_000_000) + word(0x40) + word(len(rec) + 32) + pad32(rec)),
        ("head-only", "The selector and two head words", good[:68]),
        ("other-selector", "Another function's selector", selector(DEPOSIT_SIGNATURE) + good[4:]),
        ("empty-record", "An empty record: canonical calldata, which the framing then refuses", relay_calldata(5_000_000, b"")),
        ("empty", "No calldata", b""),
        ("selector-only", "The selector alone", sel),
        ("short-selector", "Three bytes", sel[:3]),
        ("gas-dirty-high-byte", "A gas limit word with its top byte set", sel + b"\x01" + good[5:]),
        ("length-huge", "A length word of 2^256 - 1", sel + word(5_000_000) + word(0x40) + word(2**256 - 1) + pad32(rec)),
        ("length-2-53", "A length word of 2^53", sel + word(5_000_000) + word(0x40) + word(2**53) + pad32(rec)),
    ]
    calldata = []
    for cid, desc, cd in calldata_in:
        decoded = check_calldata(cd)
        v = {"id": cid, "description": desc, "calldata": cd.hex()}
        if decoded is None:
            v["result"] = "relay-calldata"
        else:
            v["result"] = "canonical"
            v["gasLimit"] = str(decoded[0])
            v["record"] = decoded[1].hex()
        calldata.append(v)
    assert calldata[0]["result"] == "canonical" and calldata[3]["result"] == "relay-calldata"

    # The relay's event accumulator over the first three calls of `calls`,
    # each in the L1 block it was made in.
    acc = acc_genesis(l1, relay)
    steps = []
    for n, v in enumerate(calls[:3]):
        topics = [bytes.fromhex(t) for t in v["topics"]]
        data = bytes.fromhex(v["data"])
        acc = acc_step(acc, n, int(v["l1Block"]), int(v["l1Timestamp"]), topics, data)
        steps.append({"n": n, "call": v["id"], "accumulator": acc.hex()})
    accumulator = {
        "chainId": str(l1),
        "address": relay.hex(),
        "genesis": acc_genesis(l1, relay).hex(),
        "steps": steps,
    }

    out = {
        "format": "abolish-relay-vectors/1",
        "title": "The L1 relay: its calldata, record framing, call hashes, deposit data, L2 alias, storage slots, event and event accumulator",
        "spec": "docs/spec/contracts.md",
        "generator": "packages/crypto/scripts/relay-vectors.py (Python standard library only, with its own Keccak-256)",
        "tag": CALL_TAG.decode(),
        "maxRelayRecord": MAX_RELAY_RECORD,
        "portalMaxData": PORTAL_MAX_DATA,
        "aliasOffset": ALIAS_OFFSET.to_bytes(20, "big").hex(),
        "signatures": {
            "relay": {"signature": RELAY_SIGNATURE, "selector": sel.hex()},
            "deposit": {"signature": DEPOSIT_SIGNATURE, "selector": selector(DEPOSIT_SIGNATURE).hex()},
            "event": {"signature": EVENT_SIGNATURE, "topic0": keccak256(EVENT_SIGNATURE.encode()).hex()},
        },
        "storage": storage,
        "aliases": aliases,
        "calls": calls,
        "framing": framing,
        "calldata": calldata,
        "accumulator": accumulator,
    }
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
