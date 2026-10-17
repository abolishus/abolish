#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event-v7.json.

A second implementation of docs/spec/contracts.md (Contract-event record,
Event tables (version 7)): record type 0x0008 version 7, its strict decoding,
and the event check under version 7's tables, which are version 6's with the
group registry's two self-paid events added (Group registry, Self-paid
additions): `SelfPaidGroupCreated`, with the group as its one indexed
parameter and no data, and `SelfPaidMemberAdded`, with the group and the
index the registry assigned as topics, carrying the self-paid record
`u64(group_id) ‖ field<bn254>(commitment)`, exactly 40 bytes, whose
commitment isn't forbidden (rules 2 and 6).

It reuses only this folder's other independent generators:
contract-event-v6-vectors.py (version 6, from the same spec) for version 6's
event check of every event version 7 keeps, and through it the earlier
versions' framing, Keccak-256, ABI reader and accumulator. The self-paid
record's checks are written here from contracts.md. It shares no code with
packages/crypto or packages/contracts.

Usage: python3 -I -B packages/crypto/scripts/contract-event-v7-vectors.py <repo-root>,
then `vp check --fix`.
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


v6 = _load("contract_event_v6_vectors", "contract-event-v6-vectors.py")
v1 = v6.v1

word, abi_bytes, abi_tail, sig_topic, uint_of = v1.word, v1.abi_bytes, v1.abi_tail, v1.sig_topic, v1.uint_of
Reject = v1.Reject

RECORD_TYPE = 0x0008
VERSION = 7
MAX_EVENT_DATA = v1.MAX_EVENT_DATA
MAX_EVENT_TOPICS = v1.MAX_EVENT_TOPICS

# contracts.md, Group registry, Additions (rule 6) and Self-paid additions.
R = v1.BN254_R
POSEIDON2_0_1 = 0x1BD20834F5DE9830C643778A2E88A3A1363C8B9AC083D36D75BF87C49953E65E
SELF_PAID_LENGTH = 8 + 32


def forbidden(c):
    return c >= R or c in (0, 1, POSEIDON2_0_1)


# ----------------------------------------------------------- the record

def encode(contract, n, block, timestamp, topics, data):
    return v1.encode(contract, n, block, timestamp, topics, data, version=VERSION)


def decode(b):
    """Strict decoding with version 7 pinned: version 6's layout, field for field."""
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE and b[2] == VERSION:
        return v6.decode(b[:2] + bytes([v6.VERSION]) + b[3:])
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE:
        raise Reject("profile-mismatch", 2)
    return v6.decode(b)


# ----------------------------------------------------------- the event check

CREATED = "SelfPaidGroupCreated(uint64)"
ADDED = "SelfPaidMemberAdded(uint64,uint64,bytes)"

SIGNATURES = {role: list(sigs) for role, sigs in v6.SIGNATURES.items()}
SIGNATURES["group-registry"] += [CREATED, ADDED]

INDEXED = dict(v6.INDEXED)
INDEXED["SelfPaidGroupCreated"] = ["groupId"]
INDEXED["SelfPaidMemberAdded"] = ["groupId", "index"]


def event_check(rec, contracts, definitions):
    """Version 7's event check: (role, event, fields) or the first failing code."""
    role = next((r for r, a in contracts.items() if a == rec["contract"]), None)
    if role is None:
        return "unknown-contract"
    topics, data = rec["topics"], rec["data"]
    names = {sig_topic(s): s for s in SIGNATURES[role]}
    if not topics or topics[0] not in names:
        return "unknown-event"
    name = names[topics[0]].split("(")[0]
    if len(topics) != 1 + len(INDEXED[name]):
        return "event-topics"
    if name == "SelfPaidGroupCreated":
        group = uint_of(topics[1], 64)
        if group is None:
            return "event-topics"
        if data:
            return "event-data"
        return {"event": name, "groupId": str(group)}
    if name == "SelfPaidMemberAdded":
        group, index = uint_of(topics[1], 64), uint_of(topics[2], 64)
        if group is None or index is None:
            return "event-topics"
        body = abi_tail(data, 1, 0, 1)
        if body is None or len(body) != SELF_PAID_LENGTH:
            return "event-data"
        commitment = int.from_bytes(body[8:], "big")
        if forbidden(commitment):
            return "event-data"
        # The record's own group_id against the topic, and the index against
        # the group's count, are 2.4's replay, never the event check's.
        return {"event": name, "groupId": str(group), "index": str(index), "record": body.hex(),
                "commitment": f"{commitment:064x}"}
    # Every other event is checked as version 6 checks it.
    return v6.event_check(rec, contracts, definitions)


# ----------------------------------------------------------- vectors

def det(label, n):
    return v1.det(f"v7/{label}", n)


def commitment(label):
    c = int.from_bytes(det(f"commitment/{label}", 32), "big") % R
    assert not forbidden(c)
    return c


def self_paid(group, c):
    return group.to_bytes(8, "big") + c.to_bytes(32, "big")


def main(root):
    vec = root / "docs/spec/vectors"

    def load(name):
        return json.loads((vec / name).read_text())

    def as_rec(fields):
        return {
            "contract": bytes.fromhex(fields["contract"]),
            "n": int(fields["n"]),
            "block": int(fields["l2Block"]),
            "timestamp": int(fields["l2Timestamp"]),
            "topics": [bytes.fromhex(t) for t in fields["topics"]],
            "data": bytes.fromhex(fields["data"]),
        }

    definitions = {}
    for name in ("election-definition.json", "election-definition-v3.json", "election-definition-v4.json",
                 "election-definition-v5.json", "election-definition-v6.json"):
        for v in load(name)["vectors"]:
            definitions[v["encoding"]] = "error" not in v

    # --- version 6's records keep their verdicts: version 7 changes none of its rows.
    old = load("contract-event-v6.json")
    v6_contracts = {r: bytes.fromhex(a) for r, a in old["contracts"].items()}
    for e in old["records"]:
        assert not isinstance(event_check(as_rec(e["fields"]), v6_contracts, definitions), str), e["id"]
    for e in old["eventFailures"]:
        assert event_check(as_rec(e["fields"]), v6_contracts, definitions) == e["error"], e["id"]

    members_added = bytes.fromhex(load("group-registry.json")["additions"][0]["record"])

    chain_id = 84532
    contracts = {r: det(r, 20) for r in ("election-registry", "trustee-registry", "group-registry", "board")}
    T = {s.split("(")[0]: sig_topic(s) for sigs in SIGNATURES.values() for s in sigs}
    gr, board = contracts["group-registry"], contracts["board"]
    last = (1 << 64) - 1

    records, failures, v6_unknown = [], [], []
    counters = {r: 0 for r in contracts}
    clock = [1_760_000_000]

    def record(rid, description, contract, topics, data, honest_record=True):
        role = next((r for r, a in contracts.items() if a == contract), None)
        if honest_record:
            n, block = counters[role], 100 + len(records)
            counters[role] += 1
        else:
            n, block = 0, 1
        ts = clock[0] + 2 * block
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
            assert not honest_record, (rid, result)
            entry["error"] = result
            failures.append(entry)
        else:
            assert honest_record, (rid, result)
            entry["role"] = role
            entry["event"] = result
            records.append((entry, rec))
            # Version 6 names no self-paid event: under it the same record fails unknown-event.
            if result["event"] in ("SelfPaidGroupCreated", "SelfPaidMemberAdded"):
                assert v6.event_check(rec, contracts, definitions) == "unknown-event", rid
                v6_unknown.append(rid)

    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, topics, data, honest_record=False)

    created = lambda g: [T["SelfPaidGroupCreated"], word(g)]
    added = lambda g, i: [T["SelfPaidMemberAdded"], word(g), word(i)]

    # --- honest records: a deployment's sequence with both kinds of group.
    record("group-created-signed", "GroupCreated for signed Tier 0 group 0, as in versions 1 to 6", gr,
           [T["GroupCreated"], word(0), word(0)], b"")
    record("self-paid-group-created", "SelfPaidGroupCreated for group 1, from the same counter", gr, created(1), b"")
    for i in range(3):
        c = commitment(f"group-1/{i}")
        record(f"self-paid-member-added-{i}", f"SelfPaidMemberAdded for group 1 at index {i}", gr, added(1, i),
               word(32) + abi_bytes(self_paid(1, c)))
    record("self-paid-member-added-repeat", "SelfPaidMemberAdded repeating index 0's commitment at index 3: the "
           "registry has no duplicate check", gr, added(1, 3), word(32) + abi_bytes(self_paid(1, commitment("group-1/0"))))
    record("self-paid-member-added-r-minus-one", "SelfPaidMemberAdded whose commitment is r − 1, the largest "
           "allowed", gr, added(1, 4), word(32) + abi_bytes(self_paid(1, R - 1)))
    record("self-paid-member-added-two", "SelfPaidMemberAdded whose commitment is 2, the smallest allowed", gr,
           added(1, 5), word(32) + abi_bytes(self_paid(1, 2)))
    record("self-paid-group-created-last", "SelfPaidGroupCreated for group 2⁶⁴ − 1, the last", gr, created(last), b"")
    record("self-paid-member-added-last-leaf", "SelfPaidMemberAdded at index 2³² − 1, the last leaf of a tier "
           "tree, in group 2⁶⁴ − 1", gr, added(last, (1 << 32) - 1),
           word(32) + abi_bytes(self_paid(last, commitment("last"))))
    record("self-paid-member-added-group-mismatch", "SelfPaidMemberAdded whose record names group 2 under the "
           "group-1 topic: it passes the event check, and 2.4's replay fails it (group-history)", gr, added(1, 6),
           word(32) + abi_bytes(self_paid(2, commitment("mismatch"))))
    record("self-paid-member-added-index-beyond", "SelfPaidMemberAdded whose index topic is 2⁶⁴ − 1: it passes "
           "the event check, and 2.4's replay fails it (position)", gr, added(1, last),
           word(32) + abi_bytes(self_paid(1, commitment("beyond"))))
    record("members-added", "MembersAdded carrying group-registry.json's first addition, as in versions 1 to 6", gr,
           [T["MembersAdded"], word(0), word(0)], word(32) + abi_bytes(members_added))

    # --- records failing each check.
    good = self_paid(1, commitment("good"))
    good_data = word(32) + abi_bytes(good)
    assert len(good) % 32
    fail("unknown-event-created-from-board", "SelfPaidGroupCreated from the board's address", board, created(1), b"")
    fail("unknown-event-added-from-board", "SelfPaidMemberAdded from the board's address", board, added(1, 0),
         good_data)
    fail("unknown-event-created-with-tier", "A self-paid creation event with the tier as a second parameter, a "
         "signature version 7 doesn't declare", gr,
         [sig_topic("SelfPaidGroupCreated(uint64,uint8)"), word(1), word(0)], b"")
    fail("unknown-event-added-unindexed-index", "A self-paid addition event with the index as data, a signature "
         "version 7 doesn't declare", gr, [sig_topic("SelfPaidMemberAdded(uint64,bytes)"), word(1)],
         word(32) + abi_bytes(good))
    fail("event-topics-created-tier-topic", "SelfPaidGroupCreated with a tier as a third topic", gr,
         created(1) + [word(0)], b"")
    fail("event-topics-created-no-group", "SelfPaidGroupCreated without its group topic", gr,
         [T["SelfPaidGroupCreated"]], b"")
    fail("event-topics-created-group-above-u64", "SelfPaidGroupCreated whose group word has bit 64 set", gr,
         created(1 << 64), b"")
    fail("event-data-created-with-data", "SelfPaidGroupCreated with a data word", gr, created(1), word(0))
    fail("event-topics-added-no-index", "SelfPaidMemberAdded without its index topic", gr,
         [T["SelfPaidMemberAdded"], word(1)], good_data)
    fail("event-topics-added-extra-topic", "SelfPaidMemberAdded with a fourth topic", gr,
         added(1, 0) + [word(0)], good_data)
    fail("event-topics-added-group-above-u64", "SelfPaidMemberAdded whose group word has bit 64 set", gr,
         added(1 << 64, 0), good_data)
    fail("event-topics-added-index-above-u64", "SelfPaidMemberAdded whose index word has bit 64 set", gr,
         added(1, 1 << 64), good_data)
    fail("event-data-added-short", "SelfPaidMemberAdded carrying 39 bytes", gr, added(1, 0),
         word(32) + abi_bytes(good[:39]))
    fail("event-data-added-long", "SelfPaidMemberAdded carrying 41 bytes", gr, added(1, 0),
         word(32) + abi_bytes(good + b"\x00"))
    fail("event-data-added-empty", "SelfPaidMemberAdded carrying an empty record", gr, added(1, 0),
         word(32) + abi_bytes(b""))
    for label, c in (("zero", 0), ("one", 1), ("poseidon2-0-1", POSEIDON2_0_1), ("r", R),
                     ("max", (1 << 256) - 1)):
        fail(f"event-data-added-forbidden-{label}", f"SelfPaidMemberAdded whose commitment is forbidden ({label})",
             gr, added(1, 0), word(32) + abi_bytes(self_paid(1, c)))
    fail("event-data-added-offset", "SelfPaidMemberAdded whose record offset is 0x40", gr, added(1, 0),
         word(64) + word(0) + abi_bytes(good))
    fail("event-data-added-trailing-word", "SelfPaidMemberAdded with a word after the record", gr, added(1, 0),
         good_data + word(0))
    fail("event-data-added-padding", "SelfPaidMemberAdded with a non-zero padding byte", gr, added(1, 0),
         good_data[:-1] + b"\x01")
    fail("event-data-added-length-short", "SelfPaidMemberAdded whose length word is one short of the record, the "
         "last byte left as padding", gr, added(1, 0), word(32) + word(len(good) - 1) + good_data[64:])
    fail("event-data-added-no-data", "SelfPaidMemberAdded with no data", gr, added(1, 0), b"")
    fail("event-data-added-carrying-members-added", "SelfPaidMemberAdded carrying a signed addition record", gr,
         added(1, 0), word(32) + abi_bytes(members_added))
    fail("event-data-members-added-carrying-self-paid", "MembersAdded carrying a self-paid record", gr,
         [T["MembersAdded"], word(1), word(0)], good_data)
    fail("event-topics-group-created-carrying-self-paid", "GroupCreated with only a group topic, as "
         "SelfPaidGroupCreated logs it", gr, [T["GroupCreated"], word(1)], b"")

    ids = [e["id"] for e, _ in records] + [e["id"] for e in failures]
    assert len(ids) == len(set(ids))

    first = bytes.fromhex(records[0][0]["encoding"])
    decode_errors = []

    def reject(rid, description, b):
        try:
            decode(b)
        except Reject as e:
            decode_errors.append({"id": rid, "description": description, "encoding": b.hex(), "error": e.code,
                                  "offset": e.offset})
            return
        raise AssertionError(rid)

    reject("version-six", "Version 6, against the pinned version 7", first[:2] + b"\x06" + first[3:])
    reject("version-eight", "Version 8, against the pinned version 7", first[:2] + b"\x08" + first[3:])
    reject("truncated-data", "The data one byte short of its length", first[:-1])
    reject("trailing-bytes", "A byte after the data", first + b"\x00")

    recs = [(e, r) for e, r in records if e["role"] == "group-registry"]
    assert [r["n"] for _, r in recs] == list(range(len(recs)))
    acc = v1.genesis(chain_id, gr)
    accs = []
    for _, r in recs:
        acc = v1.step(acc, r)
        accs.append(acc.hex())
    sequences = [{"role": "group-registry", "records": [e["id"] for e, _ in recs], "accumulators": accs,
                  "count": str(len(recs))}]

    out = {
        "format": "abolish-contract-event-vectors/7",
        "title": "Contract-event records (0x0008) version 7: the group registry's self-paid events",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-v7-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event tables (version 7)) over "
            "contract-event-v6-vectors.py's version-6 check and its own checks of the self-paid record "
            "(Group registry, Self-paid additions); every record of contract-event-v6.json re-checked"
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
        "unknownUnderVersion6": v6_unknown,
        "decodeErrors": decode_errors,
        "sequences": sequences,
    }
    with open(vec / "contract-event-v7.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
