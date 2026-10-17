#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event-v8.json.

A second implementation of docs/spec/contracts.md (Contract-event record,
Event tables (version 8)): record type 0x0008 version 8, its strict decoding,
and the event check under version 8's tables, which are version 7's with the
board's two availability events added (Board, Availability records and
Events): `AvailabilityAttestationSubmitted` and
`AvailabilityComplaintSubmitted`, each with the record's `definition_hash`
and `seat` as its topics, the seat's word a canonical `uint8`, carrying an
availability attestation (0x001b) or complaint (0x001c) of version 1 that
decodes strictly (availability.md, Decoding). A record of the other type, of
another version, or failing the decoder fails `event-data`, as does a topic
disagreeing with the record; a seat word above 8 bits fails `event-topics`
before the data is read, as version 5 orders `ObligationRootSubmitted`'s
checks.

It reuses only this folder's other independent generators:
contract-event-v7-vectors.py (version 7, from the same spec) for version 7's
event check of every event version 8 keeps, and through it the earlier
versions' framing, Keccak-256, ABI reader and accumulator; and
availability-vectors.py's strict decoder of both availability records and
its signing (trustee-vectors.py's RFC 6979 P-256 ECDSA). The event check
verifies no signature, but every record this file makes is signed anyway, by
a secret from trustee-vectors.py's `secret` over the label its description
names. It shares no code with packages/crypto or packages/contracts.

Availability records and their decode rejections come from availability.json,
obligation roots from delivery-root.json, a ballot from ballot.json.

Usage: python3 -I -B packages/crypto/scripts/contract-event-v8-vectors.py <repo-root>,
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


v7 = _load("contract_event_v7_vectors", "contract-event-v7-vectors.py")
av = _load("availability_vectors", "availability-vectors.py")
v6 = v7.v6
v5, v2, v1 = v6.v5, v6.v2, v6.v1

word, abi_bytes, abi_tail, sig_topic, uint_of = v1.word, v1.abi_bytes, v1.abi_tail, v1.sig_topic, v1.uint_of
Reject = v1.Reject

RECORD_TYPE = 0x0008
VERSION = 8
MAX_EVENT_DATA = v1.MAX_EVENT_DATA
MAX_EVENT_TOPICS = v1.MAX_EVENT_TOPICS


# ----------------------------------------------------------- the record

def encode(contract, n, block, timestamp, topics, data):
    return v1.encode(contract, n, block, timestamp, topics, data, version=VERSION)


def decode(b):
    """Strict decoding with version 8 pinned: version 7's layout, field for field."""
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE and b[2] == VERSION:
        return v7.decode(b[:2] + bytes([v7.VERSION]) + b[3:])
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE:
        raise Reject("profile-mismatch", 2)
    return v7.decode(b)


# ----------------------------------------------------------- the event check

ATTESTED = "AvailabilityAttestationSubmitted(bytes32,uint8,bytes)"
COMPLAINED = "AvailabilityComplaintSubmitted(bytes32,uint8,bytes)"

SIGNATURES = {role: list(sigs) for role, sigs in v7.SIGNATURES.items()}
SIGNATURES["board"] += [ATTESTED, COMPLAINED]

INDEXED = dict(v7.INDEXED)
INDEXED["AvailabilityAttestationSubmitted"] = ["definitionHash", "seat"]
INDEXED["AvailabilityComplaintSubmitted"] = ["definitionHash", "seat"]

CARRIES = {"AvailabilityAttestationSubmitted": av.ATTESTATION, "AvailabilityComplaintSubmitted": av.COMPLAINT}


def event_check(rec, contracts, definitions):
    """Version 8's event check: (role, event, fields) or the first failing code."""
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
    if name in CARRIES:
        seat = uint_of(topics[2], 8)
        if seat is None:
            return "event-topics"
        body = abi_tail(data, 1, 0, 1)
        if body is None:
            return "event-data"
        # Version 1 of the event's own record type only, decoded strictly; the
        # decoder's every rejection (another type or version included) is event-data.
        try:
            f = av.decode(body, CARRIES[name])
        except av.Reject:
            return "event-data"
        if f["definitionHash"] != topics[1] or f["seat"] != seat:
            return "event-data"
        return {"event": name, "definitionHash": topics[1].hex(), "seat": seat, "record": body.hex()}
    # Every other event is checked as version 7 checks it.
    return v7.event_check(rec, contracts, definitions)


# ----------------------------------------------------------- vectors

def det(label, n):
    return v1.det(f"v8/{label}", n)


def secret(label):
    return av.ecdsa.secret(f"contract-event/v8/{label}".encode())


def attestation(label, definition, panel, seat, point, checkpoint, roots):
    f = {"definitionHash": definition, "panel": panel, "seat": seat, "point": point, "checkpointHash": checkpoint,
         "roots": list(roots)}
    f["signature"] = av.sign(secret(label), "attestation", f)
    return av.encode("attestation", f)


def complaint(label, definition, panel, seat, point, checkpoint, cid):
    f = {"definitionHash": definition, "panel": panel, "seat": seat, "point": point, "checkpointHash": checkpoint,
         "cid": cid}
    f["signature"] = av.sign(secret(label), "complaint", f)
    return av.encode("complaint", f)


def main(root):
    vec = root / "docs/spec/vectors"
    av.ecdsa.self_check()

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

    # --- version 7's records keep their verdicts: version 8 changes none of its rows.
    old = load("contract-event-v7.json")
    v7_contracts = {r: bytes.fromhex(a) for r, a in old["contracts"].items()}
    for e in old["records"]:
        assert event_check(as_rec(e["fields"]), v7_contracts, definitions) == e["event"], e["id"]
    for e in old["eventFailures"]:
        assert event_check(as_rec(e["fields"]), v7_contracts, definitions) == e["error"], e["id"]

    availability = load("availability.json")
    published = {r["id"]: bytes.fromhex(r["encoding"]) for r in availability["records"]}
    kinds = {r["id"]: r["kind"] for r in availability["records"]}
    for rid, b in published.items():
        av.decode(b, av.ATTESTATION if kinds[rid] == "attestation" else av.COMPLAINT)
    obligation_root = bytes.fromhex(load("delivery-root.json")["records"][0]["encoding"])
    ballot = bytes.fromhex(next(b for b in load("ballot.json")["ballots"] if b["id"] == "ok-tier-0")["encoding"])

    chain_id = 84532
    contracts = {r: det(r, 20) for r in ("election-registry", "trustee-registry", "group-registry", "board")}
    T = {s.split("(")[0]: sig_topic(s) for sigs in SIGNATURES.values() for s in sigs}
    er, gr, board = contracts["election-registry"], contracts["group-registry"], contracts["board"]

    records, failures, v7_unknown = [], [], []
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
            # Version 7 names no availability event: under it the same record fails unknown-event.
            if result["event"] in CARRIES:
                assert v7.event_check(rec, contracts, definitions) == "unknown-event", rid
                v7_unknown.append(rid)

    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, topics, data, honest=False)

    def topics_of(event, b):
        """The topics an event carrying `b` logs: its definition hash and its seat."""
        return [T[event], b[3:35].ljust(32, b"\x00"), word(b[36] if len(b) > 36 else 0)]

    A, C = "AvailabilityAttestationSubmitted", "AvailabilityComplaintSubmitted"

    def carry(event, b):
        return topics_of(event, b), word(32) + abi_bytes(b)

    # --- honest records: rows version 8 keeps, then both availability events.
    framed = v2.frame_ballot(ballot)
    record("ballot-submitted", "BallotSubmitted, as in versions 2 to 7", board,
           [T["BallotSubmitted"], framed[0], framed[1]], word(32) + abi_bytes(ballot))
    record("root-receipt-root", "ObligationRootSubmitted carrying delivery-root.json's receipt-root, as in "
           "versions 5 to 7", board, [T["ObligationRootSubmitted"], obligation_root[3:35], word(obligation_root[35])],
           word(32) + abi_bytes(obligation_root))
    for rid, b in published.items():
        event = A if kinds[rid] == "attestation" else C
        record(f"availability-{rid}", f"{event} carrying availability.json's {rid}", board, *carry(event, b))

    definition = bytes.fromhex(availability["records"][0]["fields"]["definitionHash"])
    c_s = bytes.fromhex(next(r for r in availability["records"] if r["id"] == "attestation-counted-no-roots")
                        ["fields"]["checkpointHash"])
    c_a = bytes.fromhex(availability["records"][0]["fields"]["checkpointHash"])
    roots = sorted(det(f"root-{i}", 32) for i in range(av.MAX_ROOTS))
    max_roots = attestation("max-roots", definition, 1, 5, 2, c_s, roots)
    assert len(max_roots) == 1_162
    record("availability-attestation-max-roots", "AvailabilityAttestationSubmitted carrying an attestation naming "
           "32 roots, the most: 1,162 bytes (signed by the secret of label contract-event/v8/max-roots)", board,
           *carry(A, max_roots))
    seat_max_att = attestation("seat-255", definition, 1, 255, 1, c_a, ())
    record("availability-attestation-seat-255", "AvailabilityAttestationSubmitted for seat 255, the uint8 maximum, "
           "in topic and record (signed by the secret of label contract-event/v8/seat-255)", board,
           *carry(A, seat_max_att))
    cid_raw = bytes.fromhex(next(r for r in availability["records"] if r["id"] == "complaint-raw")["fields"]["cid"])
    seat_max_com = complaint("seat-255", definition, 2, 255, 2, c_s, cid_raw)
    record("availability-complaint-seat-255", "AvailabilityComplaintSubmitted for author seat 255 (signed by the "
           "secret of label contract-event/v8/seat-255)", board, *carry(C, seat_max_com))
    stray = attestation("no-election", det("no-election", 32), 1, 1, 1, c_a, ())
    record("availability-attestation-no-election", "AvailabilityAttestationSubmitted naming a definition no "
           "election has: the event check is stateless, and the availability check reads it as stray (signed by "
           "the secret of label contract-event/v8/no-election)", board, *carry(A, stray))
    stray_c = complaint("no-election", det("no-election", 32), 1, 1, 1, c_a, cid_raw)
    record("availability-complaint-no-election", "AvailabilityComplaintSubmitted naming a definition no election "
           "has (signed by the secret of label contract-event/v8/no-election)", board, *carry(C, stray_c))
    other_key = attestation("another-seat", definition, 1, 2, 1, c_a, ())
    record("availability-attestation-another-key", "AvailabilityAttestationSubmitted for seat 2 signed by a key "
           "that isn't seat 2's (the secret of label contract-event/v8/another-seat): the event check verifies no "
           "signature, the availability check does", board, *carry(A, other_key))

    # --- records failing each check.
    a1 = published["attestation-ballot-extent"]
    c1 = published["complaint-raw"]
    assert len(a1) % 32 and len(c1) % 32
    for event, short, b in ((A, "attestation", a1), (C, "complaint", c1)):
        tp, data = carry(event, b)
        fail(f"unknown-event-{short}-from-election-registry", f"{event} from the election registry's address", er,
             tp, data)
        fail(f"unknown-event-{short}-from-group-registry", f"{event} from the group registry's address", gr, tp,
             data)
        fail(f"unknown-contract-{short}", f"{event} from an address that is none of the definition's contracts",
             det("unknown-contract", 20), tp, data)
        fail(f"unknown-event-{short}-bytes32-seat", f"{event} with its seat as a bytes32, a signature version 8 "
             "doesn't declare", board, [sig_topic(f"{event}(bytes32,bytes32,bytes)"), tp[1], tp[2]], data)
        fail(f"event-topics-{short}-seat-high", f"{event} whose seat word has bit 8 set", board,
             [tp[0], tp[1], word(256 + b[36])], data)
        fail(f"event-topics-{short}-seat-top-bit", f"{event} whose seat word has bit 255 set", board,
             [tp[0], tp[1], word((1 << 255) + b[36])], data)
        fail(f"event-topics-{short}-one", f"{event} with only its signature topic", board, tp[:1], data)
        fail(f"event-topics-{short}-two", f"{event} without its seat topic", board, tp[:2], data)
        fail(f"event-topics-{short}-four", f"{event} with a fourth topic", board, tp + [word(0)], data)
        fail(f"event-data-{short}-definition-topic", f"{event} whose definition topic isn't its record's", board,
             [tp[0], det("other-definition", 32), tp[2]], data)
        fail(f"event-data-{short}-seat-topic", f"{event} whose seat topic isn't its record's", board,
             [tp[0], tp[1], word(b[36] + 1)], data)
        fail(f"event-data-{short}-offset", f"{event} whose record offset is 0x40", board, tp,
             word(64) + word(0) + abi_bytes(b))
        fail(f"event-data-{short}-trailing-word", f"{event} with a word after the record", board, tp,
             data + word(0))
        fail(f"event-data-{short}-padding", f"{event} with a non-zero padding byte", board, tp, data[:-1] + b"\x01")
        fail(f"event-data-{short}-length-short", f"{event} whose length word is one short of the record, the last "
             "byte left as padding", board, tp, word(32) + word(len(b) - 1) + data[64:])
        fail(f"event-data-{short}-length-long", f"{event} whose length word is one past the record", board, tp,
             word(32) + word(len(b) + 1) + data[64:])
        fail(f"event-data-{short}-no-data", f"{event} with no data", board, tp, b"")
        fail(f"event-data-{short}-empty-record", f"{event} carrying an empty record", board, tp,
             word(32) + abi_bytes(b""))
    # A seat topic read from the panel byte (offset 35, where an obligation root keeps its seat) instead of 36.
    for event, rid in ((A, "attestation-counted-no-roots"), (C, "complaint-dag-pb")):
        b = published[rid]
        assert b[35] != b[36]
        tp, data = carry(event, b)
        fail(f"event-data-{rid}-panel-as-seat", f"{event} carrying availability.json's {rid}, whose seat topic is "
             "its panel byte (offset 35), not its seat (offset 36)", board, [tp[0], tp[1], word(b[35])], data)
    fail("event-data-attestation-carrying-complaint", "AvailabilityAttestationSubmitted carrying a complaint", board,
         *carry(A, c1))
    fail("event-data-complaint-carrying-attestation", "AvailabilityComplaintSubmitted carrying an attestation", board,
         *carry(C, a1))
    for d in availability["decodeErrors"]:
        b = bytes.fromhex(d["encoding"])
        event = A if d["kind"] == "attestation" else C
        fail(f"event-data-availability-{d['id']}", f"{event} carrying availability.json's {d['id']} "
             f"({d['description']})", board, *carry(event, b))
    tp_root = [T["ObligationRootSubmitted"], obligation_root[3:35], word(obligation_root[35])]
    fail("event-data-attestation-carrying-root", "AvailabilityAttestationSubmitted carrying an obligation root",
         board, [T[A], tp_root[1], tp_root[2]], word(32) + abi_bytes(obligation_root))
    fail("event-data-complaint-carrying-root", "AvailabilityComplaintSubmitted carrying an obligation root", board,
         [T[C], tp_root[1], tp_root[2]], word(32) + abi_bytes(obligation_root))
    fail("event-data-root-carrying-attestation", "ObligationRootSubmitted carrying an availability attestation",
         board, [T["ObligationRootSubmitted"], a1[3:35], word(a1[36])], word(32) + abi_bytes(a1))
    fail("event-data-root-carrying-complaint", "ObligationRootSubmitted carrying an availability complaint", board,
         [T["ObligationRootSubmitted"], c1[3:35], word(c1[36])], word(32) + abi_bytes(c1))
    fail("event-data-close-statement-carrying-attestation", "CloseStatementSubmitted carrying an availability "
         "attestation", board, [T["CloseStatementSubmitted"], a1[3:35], word(a1[36])], word(32) + abi_bytes(a1))

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

    reject("version-seven", "Version 7, against the pinned version 8", first[:2] + b"\x07" + first[3:])
    reject("version-nine", "Version 9, against the pinned version 8", first[:2] + b"\x09" + first[3:])
    reject("truncated-data", "The data one byte short of its length", first[:-1])
    reject("trailing-bytes", "A byte after the data", first + b"\x00")

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
        "format": "abolish-contract-event-vectors/8",
        "title": "Contract-event records (0x0008) version 8: the board's availability events",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-v8-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event tables (version 8)) over "
            "contract-event-v7-vectors.py's version-7 check and availability-vectors.py's strict decoding and "
            "signing of availability records; records from availability.json, a root from delivery-root.json, a "
            "ballot from ballot.json, and every record of contract-event-v7.json re-checked"
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
        "unknownUnderVersion7": v7_unknown,
        "decodeErrors": decode_errors,
        "sequences": sequences,
    }
    with open(vec / "contract-event-v8.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
