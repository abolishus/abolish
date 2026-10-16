#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event-v5.json.

A second implementation of docs/spec/contracts.md (Contract-event record,
Event tables (version 5)): record type 0x0008 version 5, its strict decoding,
and the event check under version 5's tables, which are version 4's with one
board event added: `ObligationRootSubmitted`, carrying an obligation root
(0x001a, version 1) that decodes strictly, with its `definition_hash` and
`seat` as the topics.

It reuses only this folder's other independent generators:
contract-event-v4-vectors.py (version 4, from the same spec) for version 4's
event check of every event version 5 keeps, and through it the earlier
versions' framing, Keccak-256, ABI reader and accumulator; and
delivery-root-vectors.py's strict decoding of an obligation root and its
signing. It shares no code with packages/crypto or packages/contracts.

Roots and their decode rejections come from delivery-root.json, batches from
delivery-batch.json, a ballot from ballot.json.

Usage: python3 -I -B packages/crypto/scripts/contract-event-v5-vectors.py <repo-root>,
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


v4 = _load("contract_event_v4_vectors", "contract-event-v4-vectors.py")
dr = _load("delivery_root_vectors", "delivery-root-vectors.py")
v2, v1 = v4.v2, v4.v1

word, abi_bytes, uint_of, abi_tail, sig_topic = v1.word, v1.abi_bytes, v1.uint_of, v1.abi_tail, v1.sig_topic
Reject = v1.Reject

RECORD_TYPE = 0x0008
VERSION = 5
MAX_EVENT_DATA = v1.MAX_EVENT_DATA
MAX_EVENT_TOPICS = v1.MAX_EVENT_TOPICS


# ----------------------------------------------------------- the record

def encode(contract, n, block, timestamp, topics, data):
    return v1.encode(contract, n, block, timestamp, topics, data, version=VERSION)


def decode(b):
    """Strict decoding with version 5 pinned: version 4's layout, field for field."""
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE and b[2] == VERSION:
        return v4.decode(b[:2] + bytes([v4.VERSION]) + b[3:])
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE:
        raise Reject("profile-mismatch", 2)
    return v4.decode(b)


# ----------------------------------------------------------- the event check

ROOT = "ObligationRootSubmitted(bytes32,uint8,bytes)"

SIGNATURES = {role: list(sigs) for role, sigs in v4.SIGNATURES.items()}
SIGNATURES["board"] += [ROOT]

INDEXED = dict(v4.INDEXED)
INDEXED["ObligationRootSubmitted"] = ["definitionHash", "seat"]


def event_check(rec, contracts, definitions):
    """Version 5's event check: (role, event, fields) or the first failing code."""
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
    if name == "ObligationRootSubmitted":
        seat = uint_of(topics[2], 8)
        if seat is None:
            return "event-topics"
        body = abi_tail(data, 1, 0, 1)
        # The root decodes strictly: it has no element to frame, and its CID's
        # framing follows from its signed kind and count (delivery.md, Decoding).
        if body is None or not isinstance(dr.parse_root(body), dict):
            return "event-data"
        if body[3:35] != topics[1] or body[35] != seat:
            return "event-data"
        return {"event": name, "definitionHash": topics[1].hex(), "seat": seat, "record": body.hex()}
    # Every other event is checked as version 4 checks it.
    return v4.event_check(rec, contracts, definitions)


# ----------------------------------------------------------- vectors

def det(label, n):
    return v1.det(f"v5/{label}", n)


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

    # --- version 4's records keep their verdicts: version 5 changes none of its rows.
    old = load("contract-event-v4.json")
    v4_contracts = {r: bytes.fromhex(a) for r, a in old["contracts"].items()}
    for e in old["records"]:
        assert not isinstance(event_check(as_rec(e["fields"]), v4_contracts, definitions), str), e["id"]
    for e in old["eventFailures"]:
        assert event_check(as_rec(e["fields"]), v4_contracts, definitions) == e["error"], e["id"]

    roots = load("delivery-root.json")
    honest_roots = {r["id"]: bytes.fromhex(r["encoding"]) for r in roots["records"]}
    for rid, b in honest_roots.items():
        assert isinstance(dr.parse_root(b), dict), rid
    batch = bytes.fromhex(load("delivery-batch.json")["records"][0]["encoding"])
    ballot = bytes.fromhex(next(b for b in load("ballot.json")["ballots"] if b["id"] == "ok-tier-0")["encoding"])

    chain_id = 84532
    contracts = {r: det(r, 20) for r in ("election-registry", "trustee-registry", "group-registry", "board")}
    T = {s.split("(")[0]: sig_topic(s) for sigs in SIGNATURES.values() for s in sigs}
    er, board = contracts["election-registry"], contracts["board"]

    records, failures, v4_unknown = [], [], []
    counters = {r: 0 for r in contracts}
    clock = [1_760_000_000]

    def record(rid, description, contract, topics, data, honest=True):
        role = next((r for r, a in contracts.items() if a == contract), None)
        if honest:
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
            assert not honest, (rid, result)
            entry["error"] = result
            failures.append(entry)
        else:
            assert honest, (rid, result)
            entry["role"] = role
            entry["event"] = result
            records.append((entry, rec))
            # Version 4 names no root event: under it the same record fails unknown-event.
            if result["event"] == "ObligationRootSubmitted":
                assert v4.event_check(rec, contracts, definitions) == "unknown-event", rid
                v4_unknown.append(rid)

    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, topics, data, honest=False)

    framed = v2.frame_ballot(ballot)
    record("ballot-submitted", "BallotSubmitted, as in versions 2 to 4", board,
           [T["BallotSubmitted"], framed[0], framed[1]], word(32) + abi_bytes(ballot))
    record("batch-submitted", "ShareReceiptBatchSubmitted carrying delivery-batch.json's first batch, as in version 4",
           board, [T["ShareReceiptBatchSubmitted"], batch[3:35], word(batch[35])], word(32) + abi_bytes(batch))

    def root_topics(b):
        return [T["ObligationRootSubmitted"], b[3:35], word(b[35])]

    for rid, b in honest_roots.items():
        record(f"root-{rid}", f"ObligationRootSubmitted carrying delivery-root.json's {rid}", board,
               root_topics(b), word(32) + abi_bytes(b))

    r1 = honest_roots["receipt-root"]
    r_topics, r_data = root_topics(r1), word(32) + abi_bytes(r1)
    fail("unknown-event-root-from-registry", "ObligationRootSubmitted from the election registry's address", er,
         r_topics, r_data)
    fail("unknown-event-root-bytes32-seat", "A root event whose seat is a bytes32, a signature version 5 doesn't "
         "declare", board, [sig_topic("ObligationRootSubmitted(bytes32,bytes32,bytes)"), r_topics[1], r_topics[2]],
         r_data)
    fail("unknown-event-root-with-kind", "A root event with its kind as a third indexed parameter, a signature "
         "version 5 doesn't declare", board,
         [sig_topic("ObligationRootSubmitted(bytes32,uint8,uint8,bytes)"), r_topics[1], r_topics[2], word(r1[36])],
         r_data)
    fail("event-topics-root-two", "ObligationRootSubmitted without its seat topic", board, r_topics[:2], r_data)
    fail("event-topics-root-four", "ObligationRootSubmitted with a fourth topic", board, r_topics + [word(0)], r_data)
    fail("event-topics-root-seat-high", "ObligationRootSubmitted whose seat word has a bit above 8 set", board,
         [r_topics[0], r_topics[1], word(256 + r1[35])], r_data)
    fail("event-data-root-definition-topic", "ObligationRootSubmitted whose definition topic isn't its record's",
         board, [r_topics[0], det("other-definition", 32), r_topics[2]], r_data)
    fail("event-data-root-seat-topic", "ObligationRootSubmitted whose seat topic isn't its record's", board,
         [r_topics[0], r_topics[1], word(r1[35] + 1)], r_data)
    fail("event-data-root-offset", "ObligationRootSubmitted whose record offset is 0x40", board, r_topics,
         word(64) + word(0) + abi_bytes(r1))
    fail("event-data-root-trailing-word", "ObligationRootSubmitted with a word after the record", board,
         r_topics, r_data + word(0))
    assert len(r1) % 32
    fail("event-data-root-padding", "ObligationRootSubmitted with a non-zero padding byte", board, r_topics,
         r_data[:-1] + b"\x01")
    fail("event-data-root-length-short", "ObligationRootSubmitted whose length word is one short of the record, "
         "the last byte left as padding", board, r_topics, word(32) + word(len(r1) - 1) + r_data[64:])
    for d in roots["decode"]:
        b = bytes.fromhex(d["encoding"])
        topics = [T["ObligationRootSubmitted"], b[3:35].ljust(32, b"\x00"), word(b[35] if len(b) > 35 else 0)]
        fail(f"event-data-root-{d['id']}", f"ObligationRootSubmitted carrying delivery-root.json's {d['id']} "
             f"({d['description']})", board, topics, word(32) + abi_bytes(b))
    fail("event-data-root-carrying-batch", "ObligationRootSubmitted carrying a share-receipt batch", board,
         [T["ObligationRootSubmitted"], batch[3:35], word(batch[35])], word(32) + abi_bytes(batch))
    fail("event-data-batch-carrying-root", "ShareReceiptBatchSubmitted carrying an obligation root", board,
         [T["ShareReceiptBatchSubmitted"], r1[3:35], word(r1[35])], r_data)
    fail("event-data-complaint-batch-carrying-root", "ShareComplaintBatchSubmitted carrying an obligation root",
         board, [T["ShareComplaintBatchSubmitted"], r1[3:35], word(r1[35])], r_data)

    ids = [e["id"] for e, _ in records] + [e["id"] for e in failures]
    assert len(ids) == len(set(ids))

    honest = bytes.fromhex(records[0][0]["encoding"])
    decode_errors = []

    def reject(rid, description, b):
        try:
            decode(b)
        except Reject as e:
            decode_errors.append({"id": rid, "description": description, "encoding": b.hex(), "error": e.code,
                                  "offset": e.offset})
            return
        raise AssertionError(rid)

    reject("version-four", "Version 4, against the pinned version 5", honest[:2] + b"\x04" + honest[3:])
    reject("version-six", "Version 6, against the pinned version 5", honest[:2] + b"\x06" + honest[3:])
    reject("truncated-data", "The data one byte short of its length", honest[:-1])
    reject("trailing-bytes", "A byte after the data", honest + b"\x00")

    recs = [(e, r) for e, r in records if e["role"] == "board"]
    assert [r["n"] for _, r in recs] == list(range(len(recs)))
    acc = v1.genesis(chain_id, board)
    accs = []
    for _, r in recs:
        acc = v1.step(acc, r)
        accs.append(acc.hex())
    sequences = [{"role": "board", "records": [e["id"] for e, _ in recs], "accumulators": accs,
                  "count": str(len(recs))}]

    out = {
        "format": "abolish-contract-event-vectors/5",
        "title": "Contract-event records (0x0008) version 5: the board's obligation-root event",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-v5-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event tables (version 5)) over "
            "contract-event-v4-vectors.py's version-4 check and delivery-root-vectors.py's strict decoding of an "
            "obligation root; roots from delivery-root.json, a batch from delivery-batch.json, a ballot from "
            "ballot.json, and every record of contract-event-v4.json re-checked"
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
        "unknownUnderVersion4": v4_unknown,
        "decodeErrors": decode_errors,
        "sequences": sequences,
    }
    with open(vec / "contract-event-v5.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
