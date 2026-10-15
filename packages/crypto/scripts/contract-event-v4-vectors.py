#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event-v4.json.

A second implementation of docs/spec/contracts.md (Contract-event record,
Event tables (version 4)): record type 0x0008 version 4, its strict decoding,
and the event check under version 4's tables, which are version 3's with one
board events added: `ShareReceiptBatchSubmitted`, carrying a share-receipt
batch (0x0016, version 1), and `ShareComplaintBatchSubmitted`, carrying a
share-complaint batch (0x0017, version 1) framed as the board frames it, each
with its `definition_hash` and `seat` as the topics.

It reuses only this folder's other independent generators:
contract-event-v3-vectors.py (version 3, from the same spec) for version 3's
event check of every event version 4 keeps, and through it
contract-event-v2-vectors.py's framing and contract-event-vectors.py's
Keccak-256, ABI reader and accumulator; and delivery-batch-vectors.py's
strict decoding of a batch. It shares no code with packages/crypto or
packages/contracts.

Batches and their decode rejections come from delivery-batch.json, ballots
from ballot.json.

Usage: python3 -I -B packages/crypto/scripts/contract-event-v4-vectors.py <repo-root>,
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


v3 = _load("contract_event_v3_vectors", "contract-event-v3-vectors.py")
db = _load("delivery_batch_vectors", "delivery-batch-vectors.py")
v2, v1 = v3.v2, v3.v1

word, abi_bytes, uint_of, abi_tail, sig_topic = v1.word, v1.abi_bytes, v1.uint_of, v1.abi_tail, v1.sig_topic
Reject = v1.Reject

RECORD_TYPE = 0x0008
VERSION = 4
MAX_EVENT_DATA = v1.MAX_EVENT_DATA
MAX_EVENT_TOPICS = v1.MAX_EVENT_TOPICS


# ----------------------------------------------------------- the record

def encode(contract, n, block, timestamp, topics, data):
    return v1.encode(contract, n, block, timestamp, topics, data, version=VERSION)


def decode(b):
    """Strict decoding with version 4 pinned: version 3's layout, field for field."""
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE and b[2] == VERSION:
        return v3.decode(b[:2] + bytes([v3.VERSION]) + b[3:])
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE:
        raise Reject("profile-mismatch", 2)
    return v3.decode(b)


# ----------------------------------------------------------- the event check

BATCH = "ShareReceiptBatchSubmitted(bytes32,uint8,bytes)"
COMPLAINT_BATCH = "ShareComplaintBatchSubmitted(bytes32,uint8,bytes)"

SIGNATURES = {role: list(sigs) for role, sigs in v3.SIGNATURES.items()}
SIGNATURES["board"] += [BATCH, COMPLAINT_BATCH]

INDEXED = dict(v3.INDEXED)
INDEXED["ShareReceiptBatchSubmitted"] = ["definitionHash", "seat"]
INDEXED["ShareComplaintBatchSubmitted"] = ["definitionHash", "seat"]

# Each batch as the event check reads it: a receipt batch decodes strictly;
# a complaint batch is framed as the board frames it, its D never decoded
# (contracts.md, What the board frames; T-53).
PARSE = {
    "ShareReceiptBatchSubmitted": db.parse_batch,
    "ShareComplaintBatchSubmitted": lambda b: db.parse_complaint_batch(b, framed=True),
}


def event_check(rec, contracts, definitions):
    """Version 4's event check: (role, event, fields) or the first failing code."""
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
    if name in PARSE:
        seat = uint_of(topics[2], 8)
        if seat is None:
            return "event-topics"
        body = abi_tail(data, 1, 0, 1)
        if body is None or not isinstance(PARSE[name](body), dict):
            return "event-data"
        if body[3:35] != topics[1] or body[35] != seat:
            return "event-data"
        return {"event": name, "definitionHash": topics[1].hex(), "seat": seat, "record": body.hex()}
    # Every other event is checked as version 3 checks it.
    return v3.event_check(rec, contracts, definitions)


# ----------------------------------------------------------- vectors

def det(label, n):
    return v1.det(f"v4/{label}", n)


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

    # --- version 3's records keep their verdicts: version 4 changes none of its rows.
    old = load("contract-event-v3.json")
    v3_contracts = {r: bytes.fromhex(a) for r, a in old["contracts"].items()}
    for e in old["records"]:
        assert not isinstance(event_check(as_rec(e["fields"]), v3_contracts, definitions), str), e["id"]
    for e in old["eventFailures"]:
        assert event_check(as_rec(e["fields"]), v3_contracts, definitions) == e["error"], e["id"]

    batches = load("delivery-batch.json")
    honest_batches = {r["id"]: bytes.fromhex(r["encoding"]) for r in batches["records"]}
    for rid, b in honest_batches.items():
        assert isinstance(db.parse_batch(b), dict), rid
    ballot = bytes.fromhex(next(b for b in load("ballot.json")["ballots"] if b["id"] == "ok-tier-0")["encoding"])

    chain_id = 84532
    contracts = {r: det(r, 20) for r in ("election-registry", "trustee-registry", "group-registry", "board")}
    T = {s.split("(")[0]: sig_topic(s) for sigs in SIGNATURES.values() for s in sigs}
    er, board = contracts["election-registry"], contracts["board"]

    records, failures, v3_unknown = [], [], []
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
            # Version 3 names no batch event: under it the same record fails unknown-event.
            if result["event"] in PARSE:
                assert v3.event_check(rec, contracts, definitions) == "unknown-event", rid
                v3_unknown.append(rid)

    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, topics, data, honest=False)

    framed = v2.frame_ballot(ballot)
    record("ballot-submitted", "BallotSubmitted, as in versions 2 and 3", board,
           [T["BallotSubmitted"], framed[0], framed[1]], word(32) + abi_bytes(ballot))

    def batch_topics(b):
        return [T["ShareReceiptBatchSubmitted"], b[3:35], word(b[35])]

    for rid, b in honest_batches.items():
        record(f"batch-{rid}", f"ShareReceiptBatchSubmitted carrying delivery-batch.json's {rid}", board,
               batch_topics(b), word(32) + abi_bytes(b))

    complaint_batches = {r["id"]: bytes.fromhex(r["encoding"]) for r in batches["complaintRecords"]}

    def complaint_topics(b):
        return [T["ShareComplaintBatchSubmitted"], b[3:35], word(b[35])]

    for rid, b in complaint_batches.items():
        record(f"complaint-batch-{rid}", f"ShareComplaintBatchSubmitted carrying delivery-batch.json's {rid}", board,
               complaint_topics(b), word(32) + abi_bytes(b))
    k2 = complaint_batches["two-entries"]
    # D framed but not a point: the board emits it (it never decodes D), so the
    # event check must pass it too, or one seat could fail every election (T-53).
    not_point = None
    for v in range(2, 1 << 12, 2):
        cand = v.to_bytes(32, "little")
        if db.grp.decode(cand) is None:
            not_point = cand
            break
    # Re-signed by seat 2, as delivery-batch.json's panel lists its secret, so
    # the board, which checks the signature, emits it.
    body = k2[3:72] + not_point + k2[104:-64]
    seat2 = next(p for p in batches["panel"] if p["seat"] == 2)
    framed_only = k2[:3] + body + db.sr.sign(int(seat2["signingSecret"], 16), body, db.COMPLAINT_BATCH_TAG)
    record("complaint-batch-d-not-a-point", "ShareComplaintBatchSubmitted whose first D frames (even, below 2^255 - 19) but isn't a ristretto255 point: the board emits it, and the event check passes it; the delivery check rejects the record", board,
           complaint_topics(framed_only), word(32) + abi_bytes(framed_only))
    kt, kd = complaint_topics(k2), word(32) + abi_bytes(k2)
    fail("event-topics-complaint-batch-seat-high", "ShareComplaintBatchSubmitted whose seat word has a bit above 8 set", board,
         [kt[0], kt[1], word(256 + k2[35])], kd)
    fail("event-data-complaint-batch-seat-topic", "ShareComplaintBatchSubmitted whose seat topic isn't its record's", board,
         [kt[0], kt[1], word(k2[35] + 1)], kd)
    fail("event-data-complaint-batch-odd-d", "ShareComplaintBatchSubmitted whose first D is odd, which the board's framing refuses", board,
         kt, word(32) + abi_bytes(k2[:72] + (1).to_bytes(32, "little") + k2[104:]))
    for d in batches["complaintDecode"]:
        b = bytes.fromhex(d["encoding"])
        # A D that frames but isn't a point decodes nowhere but frames, as the
        # board frames it: it passes, as the record above shows.
        if isinstance(db.parse_complaint_batch(b, framed=True), dict):
            continue
        topics = [T["ShareComplaintBatchSubmitted"], b[3:35].ljust(32, b"\x00"), word(b[35] if len(b) > 35 else 0)]
        fail(f"event-data-complaint-batch-{d['id']}", f"ShareComplaintBatchSubmitted carrying delivery-batch.json's {d['id']} "
             f"({d['description']})", board, topics, word(32) + abi_bytes(b))
    fail("event-data-receipt-batch-carrying-complaints", "ShareReceiptBatchSubmitted carrying a complaint batch", board,
         [T["ShareReceiptBatchSubmitted"], k2[3:35], word(k2[35])], kd)

    b1 = honest_batches["three-pairs"]
    b_topics, b_data = batch_topics(b1), word(32) + abi_bytes(b1)
    fail("unknown-event-batch-from-registry", "ShareReceiptBatchSubmitted from the election registry's address", er,
         b_topics, b_data)
    fail("unknown-event-batch-bytes32-seat", "A batch event whose seat is a bytes32, a signature version 4 doesn't "
         "declare", board, [sig_topic("ShareReceiptBatchSubmitted(bytes32,bytes32,bytes)"), b_topics[1], b_topics[2]],
         b_data)
    fail("event-topics-batch-two", "ShareReceiptBatchSubmitted without its seat topic", board, b_topics[:2], b_data)
    fail("event-topics-batch-four", "ShareReceiptBatchSubmitted with a fourth topic", board, b_topics + [word(0)],
         b_data)
    fail("event-topics-batch-seat-high", "ShareReceiptBatchSubmitted whose seat word has a bit above 8 set", board,
         [b_topics[0], b_topics[1], word(256 + b1[35])], b_data)
    fail("event-data-batch-definition-topic", "ShareReceiptBatchSubmitted whose definition topic isn't its record's",
         board, [b_topics[0], det("other-definition", 32), b_topics[2]], b_data)
    fail("event-data-batch-seat-topic", "ShareReceiptBatchSubmitted whose seat topic isn't its record's", board,
         [b_topics[0], b_topics[1], word(b1[35] + 1)], b_data)
    fail("event-data-batch-offset", "ShareReceiptBatchSubmitted whose record offset is 0x40", board, b_topics,
         word(64) + word(0) + abi_bytes(b1))
    fail("event-data-batch-trailing-word", "ShareReceiptBatchSubmitted with a word after the record", board,
         b_topics, b_data + word(0))
    fail("event-data-batch-padding", "ShareReceiptBatchSubmitted with a non-zero padding byte", board, b_topics,
         b_data[:-1] + b"\x01" if len(b1) % 32 else b_data + b"\x01")
    for d in batches["decode"]:
        b = bytes.fromhex(d["encoding"])
        topics = [T["ShareReceiptBatchSubmitted"], b[3:35].ljust(32, b"\x00"), word(b[35] if len(b) > 35 else 0)]
        fail(f"event-data-batch-{d['id']}", f"ShareReceiptBatchSubmitted carrying delivery-batch.json's {d['id']} "
             f"({d['description']})", board, topics, word(32) + abi_bytes(b))
    receipt = bytes.fromhex(next(r for r in load("delivery.json")["records"] if r["id"] == "receipt")["encoding"])
    fail("event-data-batch-carrying-receipt", "ShareReceiptBatchSubmitted carrying a single share receipt", board,
         [T["ShareReceiptBatchSubmitted"], receipt[3:35], word(receipt[67])], word(32) + abi_bytes(receipt))
    fail("event-data-receipt-carrying-batch", "ShareReceiptSubmitted carrying a batch", board,
         [T["ShareReceiptSubmitted"], b1[3:35], b1[40:72]], b_data)

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

    reject("version-three", "Version 3, against the pinned version 4", honest[:2] + b"\x03" + honest[3:])
    reject("version-five", "Version 5, against the pinned version 4", honest[:2] + b"\x05" + honest[3:])
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
        "format": "abolish-contract-event-vectors/4",
        "title": "Contract-event records (0x0008) version 4: the board's share-receipt and share-complaint batch events",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-v4-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event tables (version 4)) over "
            "contract-event-v3-vectors.py's version-3 check and delivery-batch-vectors.py's strict decoding of a "
            "share-receipt batch; batches from delivery-batch.json, a ballot from ballot.json, and every record of "
            "contract-event-v3.json re-checked"
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
        "unknownUnderVersion3": v3_unknown,
        "decodeErrors": decode_errors,
        "sequences": sequences,
    }
    with open(vec / "contract-event-v4.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
