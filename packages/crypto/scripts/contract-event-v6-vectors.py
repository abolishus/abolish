#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event-v6.json.

A second implementation of docs/spec/contracts.md (Contract-event record,
Event tables (version 6)): record type 0x0008 version 6, its strict decoding,
and the event check under version 6's tables, which are version 5's with one
group-registry event added: `Tier1MemberAdded`, with no topic beyond topic 0,
carrying a Tier 1 addition record that decodes strictly
(docs/spec/vouching.md, Tier 1 addition record).

It reuses only this folder's other independent generators:
contract-event-v5-vectors.py (version 5, from the same spec) for version 5's
event check of every event version 6 keeps, and through it the earlier
versions' framing, Keccak-256, ABI reader, accumulator and BN254 point
checks (contract-event-v2-vectors.py's `proof_ok`). The Tier 1 addition
decoder is written here from vouching.md. It shares no code with
packages/crypto or packages/contracts.

Additions and their decode rejections come from vouch.json and
vouch-count.json (written by vouch-vectors.mjs, Semaphore's own prover).

Usage: python3 -I -B packages/crypto/scripts/contract-event-v6-vectors.py <repo-root>,
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


v5 = _load("contract_event_v5_vectors", "contract-event-v5-vectors.py")
v4, v2, v1 = v5.v4, v5.v2, v5.v1

word, abi_bytes, abi_tail, sig_topic = v1.word, v1.abi_bytes, v1.abi_tail, v1.sig_topic
Reject = v1.Reject

RECORD_TYPE = 0x0008
VERSION = 6
MAX_EVENT_DATA = v1.MAX_EVENT_DATA
MAX_EVENT_TOPICS = v1.MAX_EVENT_TOPICS

# vouching.md, Parameters and Tier 1 addition record.
VOUCH_K = 3
VOUCH_LENGTH = 8 + 8 + 32 + 2 + 32 + 32 + 256 + 256
ADDITION_LENGTH = 41 + VOUCH_LENGTH * VOUCH_K


# ----------------------------------------------------------- the record

def encode(contract, n, block, timestamp, topics, data):
    return v1.encode(contract, n, block, timestamp, topics, data, version=VERSION)


def decode(b):
    """Strict decoding with version 6 pinned: version 5's layout, field for field."""
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE and b[2] == VERSION:
        return v5.decode(b[:2] + bytes([v5.VERSION]) + b[3:])
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE:
        raise Reject("profile-mismatch", 2)
    return v5.decode(b)


# ----------------------------------------------------------- a Tier 1 addition

def addition_decodes(b):
    """vouching.md's strict decoder: the exact length with k at offset 40, then
    C_V, each root and nullifier below r, and each proof's points canonical and
    in their groups (membership.md, Proof encoding)."""
    if len(b) != ADDITION_LENGTH or b[40] != VOUCH_K:
        return False
    r = v2.BN254_R
    if int.from_bytes(b[8:40], "big") >= r:
        return False
    for i in range(VOUCH_K):
        at = 41 + VOUCH_LENGTH * i
        for off in (16, 50, 82):
            if int.from_bytes(b[at + off : at + off + 32], "big") >= r:
                return False
        if not v2.proof_ok(b[at + 114 : at + 370]) or not v2.proof_ok(b[at + 370 : at + 626]):
            return False
    return True


# ----------------------------------------------------------- the event check

TIER1 = "Tier1MemberAdded(bytes)"

SIGNATURES = {role: list(sigs) for role, sigs in v5.SIGNATURES.items()}
SIGNATURES["group-registry"] += [TIER1]

INDEXED = dict(v5.INDEXED)
INDEXED["Tier1MemberAdded"] = []


def event_check(rec, contracts, definitions):
    """Version 6's event check: (role, event, fields) or the first failing code."""
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
    if name == "Tier1MemberAdded":
        body = abi_tail(data, 1, 0, 1)
        if body is None or not addition_decodes(body):
            return "event-data"
        return {"event": name, "record": body.hex()}
    # Every other event is checked as version 5 checks it.
    return v5.event_check(rec, contracts, definitions)


# ----------------------------------------------------------- vectors

def det(label, n):
    return v1.det(f"v6/{label}", n)


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

    # --- version 5's records keep their verdicts: version 6 changes none of its rows.
    old = load("contract-event-v5.json")
    v5_contracts = {r: bytes.fromhex(a) for r, a in old["contracts"].items()}
    for e in old["records"]:
        assert not isinstance(event_check(as_rec(e["fields"]), v5_contracts, definitions), str), e["id"]
    for e in old["eventFailures"]:
        assert event_check(as_rec(e["fields"]), v5_contracts, definitions) == e["error"], e["id"]

    vouch = load("vouch.json")
    honest = {}
    for a in vouch["additions"]:
        b = bytes.fromhex(a["record"])
        # Every addition of vouch.json decodes: its failures are later checks.
        assert addition_decodes(b), a["id"]
        honest[a["id"]] = b
    for d in vouch["decode"]:
        assert not addition_decodes(bytes.fromhex(d["record"])), d["name"]
    count = load("vouch-count.json")
    deployment = [bytes.fromhex(e["record"]) for e in count["cases"][0]["events"] if e["kind"] == "tier1-addition"]
    members_added = next(bytes.fromhex(e["record"]) for e in count["cases"][0]["events"]
                         if e["kind"] == "members-added")

    chain_id = 84532
    contracts = {r: det(r, 20) for r in ("election-registry", "trustee-registry", "group-registry", "board")}
    T = {s.split("(")[0]: sig_topic(s) for sigs in SIGNATURES.values() for s in sigs}
    gr, board = contracts["group-registry"], contracts["board"]

    records, failures, v5_unknown = [], [], []
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
            # Version 5 names no Tier 1 event: under it the same record fails unknown-event.
            if result["event"] == "Tier1MemberAdded":
                assert v5.event_check(rec, contracts, definitions) == "unknown-event", rid
                v5_unknown.append(rid)

    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, topics, data, honest_record=False)

    t1 = [T["Tier1MemberAdded"]]
    record("group-created", "GroupCreated for a Tier 1 group, as in versions 1 to 5", gr,
           [T["GroupCreated"], word(9), word(1)], b"")
    for aid, b in honest.items():
        record(f"tier1-{aid}", f"Tier1MemberAdded carrying vouch.json's {aid}: it decodes, and whether it "
               "counts is the counting rule's", gr, t1, word(32) + abi_bytes(b))
    for i, b in enumerate(deployment):
        if addition_decodes(b):
            record(f"tier1-deployment-{i}", f"Tier1MemberAdded carrying vouch-count.json's deployment addition {i}",
                   gr, t1, word(32) + abi_bytes(b))
        else:
            fail(f"event-data-tier1-deployment-{i}", f"Tier1MemberAdded carrying vouch-count.json's deployment "
                 f"addition {i}, which doesn't decode", gr, t1, word(32) + abi_bytes(b))

    a = honest["honest"]
    a_data = word(32) + abi_bytes(a)
    assert len(a) % 32
    fail("unknown-event-tier1-from-board", "Tier1MemberAdded from the board's address", board, t1, a_data)
    fail("unknown-event-tier1-indexed-group", "A Tier 1 event with the group as an indexed parameter, a signature "
         "version 6 doesn't declare", gr, [sig_topic("Tier1MemberAdded(uint64,bytes)"), word(9)], a_data)
    fail("event-topics-tier1-group-topic", "Tier1MemberAdded with the group as a second topic", gr,
         t1 + [word(9)], a_data)
    fail("event-data-tier1-offset", "Tier1MemberAdded whose record offset is 0x40", gr, t1,
         word(64) + word(0) + abi_bytes(a))
    fail("event-data-tier1-trailing-word", "Tier1MemberAdded with a word after the record", gr, t1,
         a_data + word(0))
    fail("event-data-tier1-padding", "Tier1MemberAdded with a non-zero padding byte", gr, t1,
         a_data[:-1] + b"\x01")
    fail("event-data-tier1-length-short", "Tier1MemberAdded whose length word is one short of the record, the "
         "last byte left as padding", gr, t1, word(32) + word(len(a) - 1) + a_data[64:])
    fail("event-data-tier1-no-data", "Tier1MemberAdded with no data", gr, t1, b"")
    for d in vouch["decode"]:
        fail(f"event-data-tier1-{d['name']}", f"Tier1MemberAdded carrying vouch.json's rejected encoding "
             f"{d['name']} ({d['error']})", gr, t1, word(32) + abi_bytes(bytes.fromhex(d["record"])))
    outside = next(bytes.fromhex(p["proof"]) for p in load("membership-proof.json")["decode"]
                   if p["name"] == "b-outside-subgroup")
    at = 41 + VOUCH_LENGTH + 370
    fail("event-data-tier1-b-outside-subgroup", "Tier1MemberAdded whose vouch 1 slot proof's B is outside the "
         "order-r subgroup, which the registry's pairing refuses (membership-proof.json's b-outside-subgroup)", gr,
         t1, word(32) + abi_bytes(a[:at] + outside + a[at + 256 :]))
    fail("event-data-tier1-carrying-members-added", "Tier1MemberAdded carrying a Tier 0 addition record", gr, t1,
         word(32) + abi_bytes(members_added))
    fail("event-data-members-added-carrying-tier1", "MembersAdded carrying a Tier 1 addition record", gr,
         [T["MembersAdded"], word(9), word(0)], a_data)

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

    reject("version-five", "Version 5, against the pinned version 6", first[:2] + b"\x05" + first[3:])
    reject("version-seven", "Version 7, against the pinned version 6", first[:2] + b"\x07" + first[3:])
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
        "format": "abolish-contract-event-vectors/6",
        "title": "Contract-event records (0x0008) version 6: the group registry's Tier 1 addition event",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-v6-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event tables (version 6)) over "
            "contract-event-v5-vectors.py's version-5 check and its own strict decoder of a Tier 1 addition "
            "(docs/spec/vouching.md); additions and rejected encodings from vouch.json and vouch-count.json, "
            "and every record of contract-event-v5.json re-checked"
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
        "unknownUnderVersion5": v5_unknown,
        "decodeErrors": decode_errors,
        "sequences": sequences,
    }
    with open(vec / "contract-event-v6.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
