#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/relay-rolling.json.

A second implementation of docs/spec/contracts.md (L1 relay, Rolling ballots):
the relay's second call, `relayRollingBallot(uint64 gasLimit, bytes32 root,
bytes record)`, which forces a rolling poll's ballot through L1 with the root
its membership proof was made against. It gives the call's calldata, the
framing of its record (bounded by MAX_ROLLING_RELAY_RECORD, 32 bytes below
MAX_RELAY_RECORD, since the deposit carries the root's word), the call hash
it stores under abolish/v1/relay-rolling-call, the deposit's calldata to the
board's `submitRelayedRollingBallot`, and the relay's one sequence of calls,
words and `BallotRelayed` events shared by both calls.

It reuses only relay-vectors.py, this folder's independent generator of the
relay's first call (Keccak-256, ABI words, the storage slots, the alias, the
event and the accumulator), and reads one real version-5 ballot and its step
root from ballot-v5-records.json. It shares no code with packages/crypto or
packages/contracts.

Usage: python3 -I -B packages/crypto/scripts/relay-rolling-vectors.py <repo-root> > docs/spec/vectors/relay-rolling.json
"""

import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


r1 = _load("relay_vectors", "relay-vectors.py")
keccak256, word, pad32, u64, selector, det = r1.keccak256, r1.word, r1.pad32, r1.u64, r1.selector, r1.det
MAX_U64 = r1.MAX_U64

ROLLING_CALL_TAG = b"abolish/v1/relay-rolling-call"
assert ROLLING_CALL_TAG != r1.CALL_TAG
# The rolling deposit's data is 228 bytes of head and length before the record
# (the selector, five words, the record's offset and its length) and the
# record's zero padding after it (contracts.md, L1 relay, Rolling ballots).
ROLLING_DEPOSIT_OVERHEAD = 4 + 32 * 7
MAX_ROLLING_RELAY_RECORD = (r1.PORTAL_MAX_DATA - ROLLING_DEPOSIT_OVERHEAD) // 32 * 32
assert MAX_ROLLING_RELAY_RECORD == 119_744 == r1.MAX_RELAY_RECORD - 32
BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617

ROLLING_SIGNATURE = "relayRollingBallot(uint64,bytes32,bytes)"
ROLLING_DEPOSIT_SIGNATURE = "submitRelayedRollingBallot(uint64,uint64,uint64,uint64,bytes32,bytes)"


def frame(record):
    """The rolling call's framing of its record, in the spec's order: the code of the first failing
    check, or None. As the first call's, with the rolling bound."""
    if len(record) > MAX_ROLLING_RELAY_RECORD:
        return "relay-too-large"
    if len(record) < 35:
        return "relay-truncated"
    if record[:2] != r1.BALLOT_TYPE:
        return "relay-record-type"
    return None


def relay_calldata(gas_limit, root, record):
    assert len(root) == 32
    return (selector(ROLLING_SIGNATURE) + word(gas_limit) + root + word(0x60) + word(len(record))
            + pad32(record))


def check_calldata(calldata):
    """relayRollingBallot's canonical-calldata rule: (gasLimit, root, record), or None. The root's
    word is any 32 bytes: the relay never judges it."""
    if len(calldata) < 4 + 32 * 4 or calldata[:4] != selector(ROLLING_SIGNATURE):
        return None
    body = calldata[4:]
    gas, offset, length = (int.from_bytes(body[i : i + 32], "big") for i in (0, 64, 96))
    if gas > MAX_U64 or offset != 0x60 or length > len(body):
        return None
    record = body[128 : 128 + length]
    if len(record) != length or body[128:] != pad32(record):
        return None
    return gas, body[32:64], record


def call_hash(chain_id, relay, index, block, timestamp, gas_limit, root, record):
    assert len(relay) == 20 and len(root) == 32
    return r1.ds_hash(
        ROLLING_CALL_TAG,
        u64(chain_id) + relay + u64(index) + u64(block) + u64(timestamp) + u64(gas_limit) + root + record,
    )


def deposit_data(index, block, timestamp, gas_limit, root, record):
    return (
        selector(ROLLING_DEPOSIT_SIGNATURE)
        + word(index)
        + word(block)
        + word(timestamp)
        + word(gas_limit)
        + root
        + word(0xC0)
        + word(len(record))
        + pad32(record)
    )


def ballot(label, version, length):
    return r1.ballot(f"rolling/{label}", version, length)


def main(repo):
    v5 = json.loads((repo / "docs/spec/vectors/ballot-v5-records.json").read_text())
    newest = next(b for b in v5["ballots"] if b["id"] == "ok-newest-step")
    v5_record = bytes.fromhex(newest["encoding"])
    election = v5["elections"][newest["election"]]
    assert v5_record[3:35].hex() == election["definitionHash"]
    step = int.from_bytes(v5_record[364:368], "big")
    step_root = int(next(s["root"] for s in election["cells"][v5_record[35]]["steps"] if s["step"] == step))
    other_root = int(next(s["root"] for s in election["cells"][v5_record[35]]["steps"] if s["step"] == step - 1))
    assert 0 < step_root < BN254_R and step_root != other_root

    relay = det("relay/address", 20)
    other_relay = det("relay/other-address", 20)
    l1 = 11_155_111  # Sepolia

    small = ballot("call/small", 5, 35)
    largest = r1.filled(r1.BALLOT_TYPE + b"\x05" + det("rolling/call/max/definition", 32), "rolling/call/max/body",
                        MAX_ROLLING_RELAY_RECORD)
    sr, orr = word(step_root), word(other_root)
    calls_in = [
        ("v5-ballot", "ballot-v5-records.json's ok-newest-step with the root of the step it names", l1, relay, 1,
         6_000_001, 1_800_000_012, 6_000_000, sr, v5_record, "ok-newest-step"),
        ("v5-ballot-other-root", "The same call with step N0 - 1's root: another call hash, since the hash binds the "
         "root", l1, relay, 1, 6_000_001, 1_800_000_012, 6_000_000, orr, v5_record, "ok-newest-step"),
        ("v5-ballot-next-call", "The same record and root relayed again, one slot later", l1, relay, 2, 6_000_002,
         1_800_000_024, 6_000_000, sr, v5_record, "ok-newest-step"),
        ("shortest", "The shortest record the relay frames, with the root 1", l1, relay, 0, 6_000_000,
         1_800_000_000, 6_000_000, word(1), small, "rolling/call/small"),
        ("root-zero", "A root of 0: recorded and deposited, since the relay never judges the root; the board refuses "
         "it (membership-proof)", l1, relay, 3, 6_000_003, 1_800_000_036, 6_000_000, word(0), small,
         "rolling/call/small"),
        ("root-r", "A root of r, not a field element: recorded, and refused by the board", l1, relay, 4, 6_000_004,
         1_800_000_048, 6_000_000, word(BN254_R), small, "rolling/call/small"),
        ("root-max", "A root word of 2^256 - 1", l1, relay, 5, 6_000_005, 1_800_000_060, 6_000_000,
         b"\xff" * 32, small, "rolling/call/small"),
        ("other-relay", "The v5-ballot call's fields, recorded by another relay", l1, other_relay, 1, 6_000_001,
         1_800_000_012, 6_000_000, sr, v5_record, "ok-newest-step"),
        ("other-chain", "The v5-ballot call's fields on another L1 (mainnet)", 1, relay, 1, 6_000_001,
         1_800_000_012, 6_000_000, sr, v5_record, "ok-newest-step"),
        ("u64-extremes", "The largest index, block, stamp and gas limit", MAX_U64, relay, MAX_U64, MAX_U64, MAX_U64,
         MAX_U64, sr, small, "rolling/call/small"),
        ("largest", "A record of MAX_ROLLING_RELAY_RECORD bytes, whose deposit data is within 32 bytes of the "
         "portal's cap", l1, relay, 6, 6_000_006, 1_800_000_072, 6_000_000, sr, largest, "rolling/call/max/body"),
    ]
    calls = []
    for cid, desc, chain, rel, index, block, ts, gas, root, record, fill in calls_in:
        assert frame(record) is None
        ch = call_hash(chain, rel, index, block, ts, gas, root, record)
        # What the first call's word would be for the same fields and record: never the same word,
        # since the tags differ, so no relayed event of one kind matches a call of the other.
        fixed = r1.call_hash(chain, rel, index, block, ts, gas, record)
        assert ch != fixed
        data = deposit_data(index, block, ts, gas, root, record)
        assert len(data) <= r1.PORTAL_MAX_DATA
        topics, ev_data = r1.event(record[3:35], index, ch)
        v = {
            "id": cid,
            "description": desc,
            "l1ChainId": str(chain),
            "relay": rel.hex(),
            "index": str(index),
            "l1Block": str(block),
            "l1Timestamp": str(ts),
            "gasLimit": str(gas),
            "root": root.hex(),
        }
        if fill == "ok-newest-step":
            v["ballot"] = fill
        v.update(r1.record_fields(fill, record) if fill != "ok-newest-step" else {"record": record.hex()})
        v.update({"callHash": ch.hex(), "fixedCallHash": fixed.hex(), "topics": [t.hex() for t in topics],
                  "data": ev_data.hex()})
        if len(record) <= r1.INLINE or fill == "ok-newest-step":
            v["depositData"] = data.hex()
        v["depositDataLength"] = len(data)
        v["depositDataSha256"] = r1.hashlib.sha256(data).hexdigest()
        calls.append(v)
    assert len({c["callHash"] for c in calls}) == len(calls)

    pre = lambda label: r1.BALLOT_TYPE + b"\x05" + det(f"rolling/frame/{label}/def", 32)  # noqa: E731
    framing_in = [
        ("empty", "No bytes", b"", "rolling/frame/empty"),
        ("one-short", "34 bytes: the definition hash one byte short", ballot("frame/short", 5, 35)[:34],
         "rolling/frame/short"),
        ("shortest", "35 bytes: type, version and definition hash", ballot("frame/ok", 5, 35), "rolling/frame/ok"),
        ("version-4", "A version-4 header: framed, since the relay reads no version; the board refuses it "
         "(unknown-version)", ballot("frame/v4", 4, 100), "rolling/frame/v4"),
        ("type-0001", "Record type 0x0001", b"\x00\x01" + det("rolling/frame/t1", 98), "rolling/frame/t1"),
        ("type-0200", "The ballot type's bytes swapped", b"\x02\x00" + det("rolling/frame/t200", 98),
         "rolling/frame/t200"),
        ("short-wrong-type", "34 bytes of another type: truncated is found first",
         b"\x00\x01" + det("rolling/frame/st", 32), "rolling/frame/st"),
        ("max", "MAX_ROLLING_RELAY_RECORD bytes", r1.filled(pre("max"), "rolling/frame/max", MAX_ROLLING_RELAY_RECORD),
         "rolling/frame/max"),
        ("max-plus-one", "One byte more than MAX_ROLLING_RELAY_RECORD",
         r1.filled(pre("max1"), "rolling/frame/max1", MAX_ROLLING_RELAY_RECORD + 1), "rolling/frame/max1"),
        ("max-relay-record", "MAX_RELAY_RECORD bytes, which the first call takes and this one doesn't: its deposit "
         "would pass the portal's cap", r1.filled(pre("fixed-max"), "rolling/frame/fixed-max", r1.MAX_RELAY_RECORD),
         "rolling/frame/fixed-max"),
        ("too-large-wrong-type", "Too large and of another type: too large is found first",
         r1.filled(b"\x00\x01" + det("rolling/frame/big/head", 33), "rolling/frame/big", MAX_ROLLING_RELAY_RECORD + 32),
         "rolling/frame/big"),
    ]
    framing = []
    for fid, desc, record, fill in framing_in:
        code = frame(record)
        v = {"id": fid, "description": desc, **r1.record_fields(fill, record), "result": code or "framed"}
        if code is None:
            v["definitionHash"] = record[3:35].hex()
        framing.append(v)
    # The largest the rolling call frames gives deposit data within the cap, and one word more wouldn't.
    assert len(deposit_data(0, 0, 0, 0, sr, b"\x00" * MAX_ROLLING_RELAY_RECORD)) == r1.PORTAL_MAX_DATA - 28
    assert len(deposit_data(0, 0, 0, 0, sr, b"\x00" * (MAX_ROLLING_RELAY_RECORD + 1))) > r1.PORTAL_MAX_DATA

    rec = ballot("calldata/record", 5, 70)
    good = relay_calldata(6_000_000, sr, rec)
    sel = selector(ROLLING_SIGNATURE)
    calldata_in = [
        ("canonical", "The ABI encoding of (6,000,000, a step root, a 70-byte record)", good),
        ("canonical-aligned", "A 64-byte record: no padding",
         relay_calldata(6_000_000, sr, ballot("calldata/aligned", 5, 64))),
        ("canonical-max-gas", "The largest uint64 gas limit", relay_calldata(MAX_U64, sr, rec)),
        ("canonical-root-max", "A root word of 2^256 - 1: any 32 bytes, since the relay never judges the root",
         relay_calldata(6_000_000, b"\xff" * 32, rec)),
        ("canonical-root-zero", "A root word of 0", relay_calldata(6_000_000, word(0), rec)),
        ("gas-above-u64", "A gas limit word with bit 64 set", sel + word(2**64) + good[36:]),
        ("offset-0x40", "The record's offset 0x40, as relayBallot's layout has it, inside the head", sel
         + word(6_000_000) + sr + word(0x40) + word(len(rec)) + pad32(rec)),
        ("offset-0x80", "The record's offset 0x80, with a junk word before it", sel + word(6_000_000) + sr
         + word(0x80) + word(0) + good[100:]),
        ("without-root", "relayBallot's arguments under this call's selector: no root word", sel
         + r1.relay_calldata(6_000_000, rec)[4:]),
        ("fixed-selector", "This call's arguments under relayBallot's selector", selector(r1.RELAY_SIGNATURE)
         + good[4:]),
        ("dirty-padding", "A non-zero padding byte", good[:-1] + b"\x01"),
        ("trailing-word", "A zero word after the padding", good + bytes(32)),
        ("short-padding", "Padding cut short", good[:-1]),
        ("length-past-end", "A length word past the end of the calldata", sel + word(6_000_000) + sr + word(0x60)
         + word(len(rec) + 32) + pad32(rec)),
        ("head-only", "The selector and three head words", good[:100]),
        ("empty-record", "An empty record: canonical calldata, which the framing then refuses",
         relay_calldata(6_000_000, sr, b"")),
        ("empty", "No calldata", b""),
        ("length-huge", "A length word of 2^256 - 1", sel + word(6_000_000) + sr + word(0x60) + word(2**256 - 1)
         + pad32(rec)),
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
            v["root"] = decoded[1].hex()
            v["record"] = decoded[2].hex()
        calldata.append(v)
    assert [c["result"] for c in calldata[:5]] == ["canonical"] * 5

    # One relay, both calls: indices are drawn from one count, each word holds the hash of its own
    # call's kind, and every call emits BallotRelayed into one accumulator (L1 relay, State).
    fixed_record = ballot("sequence/fixed", 4, 120)
    seq_in = [
        ("fixed", 6_000_100, 1_800_001_200, 5_000_000, None, fixed_record),
        ("rolling", 6_000_101, 1_800_001_212, 6_000_000, sr, v5_record),
        ("rolling", 6_000_101, 1_800_001_212, 6_000_000, orr, v5_record),
        ("fixed", 6_000_102, 1_800_001_224, 5_000_000, None, fixed_record),
    ]
    acc = r1.acc_genesis(l1, relay)
    sequence = []
    for i, (kind, block, ts, gas, root, record) in enumerate(seq_in):
        ch = (r1.call_hash(l1, relay, i, block, ts, gas, record) if root is None
              else call_hash(l1, relay, i, block, ts, gas, root, record))
        topics, data = r1.event(record[3:35], i, ch)
        acc = r1.acc_step(acc, i, block, ts, topics, data)
        step = {"index": str(i), "call": kind, "l1Block": str(block), "l1Timestamp": str(ts), "gasLimit": str(gas)}
        if root is not None:
            step["root"] = root.hex()
        step.update({"record": record.hex(), "slot": word(r1.call_slot(r1.namespace("abolish.ballot-relay"), i)).hex(),
                     "callHash": ch.hex(), "topics": [t.hex() for t in topics], "data": data.hex(),
                     "accumulator": acc.hex()})
        sequence.append(step)

    out = {
        "format": "abolish-relay-rolling-vectors/1",
        "title": "The L1 relay's rolling call: its calldata, record framing, call hashes, deposit data, and the "
                 "relay's one sequence of both calls",
        "spec": "docs/spec/contracts.md",
        "generator": "packages/crypto/scripts/relay-rolling-vectors.py (Python standard library only, over "
                     "relay-vectors.py's Keccak-256, slots and accumulator; one ballot from ballot-v5-records.json)",
        "tag": ROLLING_CALL_TAG.decode(),
        "fixedTag": r1.CALL_TAG.decode(),
        "maxRollingRelayRecord": MAX_ROLLING_RELAY_RECORD,
        "maxRelayRecord": r1.MAX_RELAY_RECORD,
        "portalMaxData": r1.PORTAL_MAX_DATA,
        "signatures": {
            "relay": {"signature": ROLLING_SIGNATURE, "selector": sel.hex()},
            "deposit": {"signature": ROLLING_DEPOSIT_SIGNATURE,
                        "selector": selector(ROLLING_DEPOSIT_SIGNATURE).hex()},
            "event": {"signature": r1.EVENT_SIGNATURE, "topic0": keccak256(r1.EVENT_SIGNATURE.encode()).hex()},
        },
        "calls": calls,
        "framing": framing,
        "calldata": calldata,
        "sequence": {
            "l1ChainId": str(l1),
            "relay": relay.hex(),
            "genesis": r1.acc_genesis(l1, relay).hex(),
            "count": str(len(sequence)),
            "calls": sequence,
        },
    }
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
