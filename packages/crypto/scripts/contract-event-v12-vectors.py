#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event-v12.json.

A second implementation of docs/spec/contracts.md (Contract-event record,
Event tables (version 12)): record type 0x0008 version 12, its strict
decoding, and the event check under version 12's tables, which are version
11's with the trustee registry's `PanelPinned` replaced by the one that logs
each panel's kind (Trustee registry, Deployment and Events):

- `PanelPinned(bytes32,uint8,uint8,uint8,bytes)`, indexed `panelId`, carries
  the threshold, the quorum and the kind, each a canonical `uint8` word, the
  kind 1 (`independent`) or 2 (`transitional`), then the keys as version 1
  checks them: 1 to MAX_TRUSTEES whole 33-byte encodings, each a `p256-key`;
- version 1's `PanelPinned(bytes32,uint8,uint8,bytes)` is no event of
  version 12 (`unknown-event`), and every other event is checked as version
  11 checks it.

Panels come from trustee.json, so each `panelId` topic is its keys' real
identifier (the event check doesn't recompute it; verifier 2.5 does).

It reuses only this folder's other independent generators:
contract-event-v11-vectors.py (version 11, from the same spec) for version
11's check of every event version 12 keeps unchanged, and through it the
earlier versions' framing, `p256-key` decoding and accumulator. It shares
no code with packages/crypto or packages/contracts.

Usage: python3 -I -B packages/crypto/scripts/contract-event-v12-vectors.py <repo-root>,
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


v11 = _load("contract_event_v11_vectors", "contract-event-v11-vectors.py")
v1 = v11.v1

word, abi_bytes, abi_tail, sig_topic, uint_of = v1.word, v1.abi_bytes, v1.abi_tail, v1.sig_topic, v1.uint_of
Reject = v1.Reject

RECORD_TYPE = 0x0008
VERSION = 12
MAX_EVENT_DATA = v1.MAX_EVENT_DATA
MAX_EVENT_TOPICS = v1.MAX_EVENT_TOPICS
MAX_TRUSTEES = v1.MAX_TRUSTEES

INDEPENDENT, TRANSITIONAL = 1, 2


# ----------------------------------------------------------- the record

def encode(contract, n, block, timestamp, topics, data):
    return v1.encode(contract, n, block, timestamp, topics, data, version=VERSION)


def decode(b):
    """Strict decoding with version 12 pinned: version 11's layout, field for field."""
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE and b[2] == VERSION:
        return v11.decode(b[:2] + bytes([v11.VERSION]) + b[3:])
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE:
        raise Reject("profile-mismatch", 2)
    return v11.decode(b)


# ----------------------------------------------------------- the event check

PANEL_PINNED_V1 = "PanelPinned(bytes32,uint8,uint8,bytes)"
PANEL_PINNED = "PanelPinned(bytes32,uint8,uint8,uint8,bytes)"

SIGNATURES = {role: list(sigs) for role, sigs in v11.SIGNATURES.items()}
assert PANEL_PINNED_V1 in SIGNATURES["trustee-registry"]
SIGNATURES["trustee-registry"] = [PANEL_PINNED if s == PANEL_PINNED_V1 else s for s in SIGNATURES["trustee-registry"]]

INDEXED = dict(v11.INDEXED)
assert INDEXED["PanelPinned"] == ["panelId"]


def event_check(rec, contracts, definitions):
    """Version 12's event check: (role, event, fields) or the first failing code."""
    role = next((r for r, a in contracts.items() if a == rec["contract"]), None)
    topics, data = rec["topics"], rec["data"]
    if role == "trustee-registry" and topics and topics[0] == sig_topic(PANEL_PINNED_V1):
        # Version 12's table has the kind-carrying signature in its place.
        return "unknown-event"
    if role != "trustee-registry" or not topics or topics[0] != sig_topic(PANEL_PINNED):
        # Every other event is checked as version 11 checks it, and the new event's topic 0 from any
        # other role is unknown there, as here.
        return v11.event_check(rec, contracts, definitions)
    if len(topics) != 1 + len(INDEXED["PanelPinned"]):
        return "event-topics"
    # Threshold, quorum and kind, then the keys' offset 0x80: four head words.
    body = abi_tail(data, 4, 3, 1)
    if body is None:
        return "event-data"
    threshold, quorum, kind = (uint_of(data[32 * i : 32 * i + 32], 8) for i in range(3))
    if threshold is None or quorum is None or kind not in (INDEPENDENT, TRANSITIONAL):
        return "event-data"
    if len(body) == 0 or len(body) % 33 or len(body) > 33 * MAX_TRUSTEES:
        return "event-data"
    keys = [body[i : i + 33] for i in range(0, len(body), 33)]
    if not all(v1.is_p256_key(k) for k in keys):
        return "event-data"
    return {"event": "PanelPinned", "panelId": topics[1].hex(), "threshold": threshold, "quorum": quorum,
            "kind": kind, "keys": [k.hex() for k in keys]}


# ----------------------------------------------------------- vectors

def det(label, n):
    return v1.det(f"v12/{label}", n)


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

    # --- version 11's records keep their verdicts: version 12 changes only the trustee registry's
    # PanelPinned, which no version-11 vector carries.
    old = load("contract-event-v11.json")
    v11_contracts = {r: bytes.fromhex(a) for r, a in old["contracts"].items()}
    for e in old["records"]:
        assert event_check(as_rec(e["fields"]), v11_contracts, definitions) == e["event"], e["id"]
    for e in old["eventFailures"]:
        assert event_check(as_rec(e["fields"]), v11_contracts, definitions) == e["error"], e["id"]
    # Every trustee-registry vector of version 2, whose rows versions 3 to 11 keep: CeremonyRegistered
    # keeps its verdict, and version 1's PanelPinned is unknown-event.
    v2_file = load("contract-event-v2.json")
    v2_contracts = {r: bytes.fromhex(a) for r, a in v2_file["contracts"].items()}
    tr_v2 = v2_file["contracts"]["trustee-registry"]
    v2_panel_pinned = None
    for e in v2_file["records"]:
        if e["fields"]["contract"] == tr_v2:
            got = event_check(as_rec(e["fields"]), v2_contracts, definitions)
            if e["event"]["event"] == "PanelPinned":
                assert got == "unknown-event", e["id"]
                v2_panel_pinned = e
            else:
                assert got == e["event"], e["id"]
    for e in v2_file["eventFailures"]:
        if e["fields"]["contract"] == tr_v2:
            assert event_check(as_rec(e["fields"]), v2_contracts, definitions) == e["error"], e["id"]
    v2_ceremony = next(e for e in v2_file["records"] if e["id"] == "ceremony-registered")

    trustee = load("trustee.json")
    panels = {p["id"]: p for p in trustee["panels"] if "error" not in p}
    key_vectors = trustee["keys"]
    bad_x = next(bytes([2]) + x.to_bytes(32, "big") for x in range(1, 100)
                 if not v1.is_p256_key(bytes([2]) + x.to_bytes(32, "big")))
    assert all(v1.is_p256_key(bytes.fromhex(k["encoding"])) == ("error" not in k) for k in key_vectors)

    chain_id = 84532
    contracts = {r: det(r, 20) for r in ("election-registry", "trustee-registry", "group-registry", "board")}
    T = {s.split("(")[0]: sig_topic(s) for sigs in SIGNATURES.values() for s in sigs}
    tr = contracts["trustee-registry"]

    records, failures, v11_verdicts = [], [], {}
    counters = {r: 0 for r in contracts}

    def record(rid, description, contract, topics, data, honest=True, block=50):
        role = next((r for r, a in contracts.items() if a == contract), None)
        if honest:
            n = counters[role]
            counters[role] += 1
        else:
            n, block = 0, 1
        ts = 1_779_840_000 + 2 * block
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
            # Under version 11 the kind-carrying PanelPinned is no event of the trustee registry's
            # (unknown-event); every other record version 12 passes, version 11 passes alike.
            old_verdict = v11.event_check(rec, contracts, definitions)
            if isinstance(old_verdict, str):
                assert old_verdict == "unknown-event" and result["event"] == "PanelPinned", rid
                v11_verdicts[rid] = old_verdict
            else:
                assert old_verdict == result, rid
        return entry

    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, topics, data, honest=False)

    def pinned_data(threshold, quorum, kind, keys):
        return word(threshold) + word(quorum) + word(kind) + word(0x80) + abi_bytes(b"".join(keys))

    def panel(pid):
        p = panels[pid]
        return bytes.fromhex(p["panelId"]), p["threshold"], [bytes.fromhex(k) for k in p["keys"]]

    # ---------------------------------------------------------------- honest records

    # The deployment's panels, in its constructor's order, each with q = max(k, n - 1), all logged in the
    # deployment's block.
    for pid, kind, desc in (
        ("panel-4-of-7", TRANSITIONAL, "the launch panel's 4-of-7 shape, transitional, quorum 6"),
        ("panel-3-of-7", INDEPENDENT, "a 3-of-7 panel, independent, quorum 6"),
        ("panel-2-of-16", INDEPENDENT, "a 2-of-16 panel at MAX_TRUSTEES seats, independent, quorum 15"),
        ("panel-2-of-2", TRANSITIONAL, "a 2-of-2 panel, transitional, quorum 2"),
    ):
        panel_id, k, keys = panel(pid)
        record(f"panel-pinned-{pid.removeprefix('panel-')}", f"PanelPinned: trustee.json's {pid}, {desc}", tr,
               [T["PanelPinned"], panel_id], pinned_data(k, max(k, len(keys) - 1), kind, keys))
    panel_id, k, keys = panel("panel-4-of-7-reordered")
    record("panel-pinned-4-of-7-low-quorum", "PanelPinned: trustee.json's panel-4-of-7-reordered, independent, with "
           "quorum 4, below max(k, n - 1): the contract accepts any k <= q <= n, and the quorum the release pins is "
           "3.1's (Trustee registry, The quorum)", tr, [T["PanelPinned"], panel_id],
           pinned_data(k, k, INDEPENDENT, keys))
    # A version-2 key-set registration after the deployment, as in versions 2 to 11.
    record("ceremony-registered", "CeremonyRegistered with three seats and two approvals, contract-event-v2.json's "
           "ceremony-registered, as in versions 2 to 11", tr,
           [bytes.fromhex(t) for t in v2_ceremony["fields"]["topics"]], bytes.fromhex(v2_ceremony["fields"]["data"]), block=120)

    # ---------------------------------------------------------------- failures

    panel_id, k, keys = panel("panel-4-of-7")
    tp, data = [T["PanelPinned"], panel_id], pinned_data(4, 6, TRANSITIONAL, keys)
    v1_data = word(4) + word(6) + word(0x60) + abi_bytes(b"".join(keys))
    fail("unknown-event-panel-pinned-v1", "Version 1's PanelPinned(bytes32,uint8,uint8,bytes), without the kind, "
         "from the trustee registry: version 12 lists the kind-carrying signature in its place", tr,
         [sig_topic(PANEL_PINNED_V1), panel_id], v1_data)
    fail("unknown-event-panel-pinned-v2-record", "contract-event-v2.json's panel-pinned record's topics and data "
         "from the trustee registry", tr, [bytes.fromhex(t) for t in v2_panel_pinned["fields"]["topics"]],
         bytes.fromhex(v2_panel_pinned["fields"]["data"]))
    fail("unknown-event-panel-pinned-kind-last", "The kind after the keys, PanelPinned(bytes32,uint8,uint8,bytes,uint8), "
         "a signature version 12 doesn't list", tr, [sig_topic("PanelPinned(bytes32,uint8,uint8,bytes,uint8)"),
                                                     panel_id], word(4) + word(6) + word(0x80) + word(2)
         + abi_bytes(b"".join(keys)))
    fail("unknown-event-panel-pinned-from-election-registry", "PanelPinned from the election registry's address",
         contracts["election-registry"], tp, data)
    fail("unknown-event-panel-pinned-from-board", "PanelPinned from the board's address", contracts["board"], tp,
         data)
    fail("unknown-event-panel-pinned-from-group-registry", "PanelPinned from the group registry's address",
         contracts["group-registry"], tp, data)
    fail("unknown-contract-panel-pinned", "PanelPinned from an address that is none of the definition's contracts",
         det("unknown-contract", 20), tp, data)
    fail("event-topics-panel-pinned-no-panel", "PanelPinned without its panelId topic", tr, tp[:1], data)
    fail("event-topics-panel-pinned-kind-topic", "PanelPinned with the kind as a second indexed topic", tr,
         tp + [word(TRANSITIONAL)], data)
    for value, rid, desc in ((0, "zero", "0, no kind"), (3, "three", "3, no kind"),
                             (256, "over-u8", "256, above a uint8"),
                             (257, "257", "257, whose low byte is 1"),
                             (2**255 + 2, "high-bit", "2^255 + 2, whose low byte is 2"),
                             (2**256 - 1, "max", "2^256 - 1")):
        fail(f"event-data-panel-pinned-kind-{rid}", f"PanelPinned whose kind word is {desc}: the registry pins only "
             "kinds 1 and 2", tr, tp, pinned_data(4, 6, value, keys))
    fail("event-data-panel-pinned-threshold-over-u8", "PanelPinned's threshold word at 256", tr, tp,
         pinned_data(256, 6, TRANSITIONAL, keys))
    fail("event-data-panel-pinned-quorum-over-u8", "PanelPinned's quorum word at 256", tr, tp,
         pinned_data(4, 256, TRANSITIONAL, keys))
    fail("event-data-panel-pinned-v1-data", "Version 1's data under the kind-carrying topic: three head words, "
         "the keys' offset 0x60 read as the kind", tr, tp, v1_data)
    fail("event-data-panel-pinned-offset-low", "A keys offset of 0x60, inside the head", tr, tp,
         data[:96] + word(0x60) + data[128:])
    fail("event-data-panel-pinned-offset-high", "A keys offset of 0xa0, a word past the head", tr, tp,
         data[:96] + word(0xA0) + word(0) + data[128:])
    fail("event-data-panel-pinned-trailing-word", "A word after the keys", tr, tp, data + word(0))
    assert (33 * len(keys)) % 32
    fail("event-data-panel-pinned-padding", "A non-zero padding byte", tr, tp, data[:-1] + b"\x01")
    fail("event-data-panel-pinned-length-short", "A length word one short of the keys", tr, tp,
         data[:128] + word(33 * len(keys) - 1) + data[160:])
    fail("event-data-panel-pinned-head-only", "The four head words alone", tr, tp, data[:128])
    fail("event-data-panel-pinned-no-data", "No data", tr, tp, b"")
    fail("event-data-panel-pinned-keys-length", "Encodings one byte past a multiple of 33", tr, tp,
         word(4) + word(6) + word(TRANSITIONAL) + word(0x80) + abi_bytes(b"".join(keys) + b"\x00"))
    fail("event-data-panel-pinned-keys-empty", "No keys", tr, tp, pinned_data(4, 6, TRANSITIONAL, []))
    sixteen = panel("panel-2-of-16")[2]
    fail("event-data-panel-pinned-keys-17", "MAX_TRUSTEES + 1 keys", tr, tp,
         pinned_data(2, 16, INDEPENDENT, sixteen + keys[:1]))
    fail("event-data-panel-pinned-key-uncompressed-prefix", "A key whose prefix is 0x04", tr, tp,
         pinned_data(4, 6, TRANSITIONAL, [b"\x04" + keys[0][1:]] + keys[1:]))
    fail("event-data-panel-pinned-key-off-curve", "A key whose x has no point", tr, tp,
         pinned_data(4, 6, TRANSITIONAL, keys[:-1] + [bad_x]))
    # One record, one reading (T-31): CeremonyRegistered's data under the new topic and the other way round.
    fail("event-data-panel-pinned-ceremony-data", "PanelPinned's topics over CeremonyRegistered's data", tr, tp,
         bytes.fromhex(v2_ceremony["fields"]["data"]))
    cer_topics = [bytes.fromhex(t) for t in v2_ceremony["fields"]["topics"]]
    fail("event-data-ceremony-panel-data", "CeremonyRegistered's topics over PanelPinned's data: its record "
         "isn't a registration", tr, cer_topics, data)
    fail("event-topics-ceremony-panel-topic-count", "CeremonyRegistered's topic 0 with PanelPinned's two topics",
         tr, [cer_topics[0], panel_id], data)

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

    reject("version-eleven", "Version 11, against the pinned version 12", first[:2] + b"\x0b" + first[3:])
    reject("version-thirteen", "Version 13, against the pinned version 12", first[:2] + b"\x0d" + first[3:])
    reject("truncated-data", "The data one byte short of its length", first[:-1])
    reject("trailing-bytes", "A byte after the data", first + b"\x00")

    recs = [(e, r) for e, r in records if e["role"] == "trustee-registry"]
    assert len(recs) == len(records)
    assert [r["n"] for _, r in recs] == list(range(len(recs)))
    acc = v1.genesis(chain_id, tr)
    accs = []
    for _, r in recs:
        acc = v1.step(acc, r)
        accs.append(acc.hex())
    sequences = [{"role": "trustee-registry", "records": [e["id"] for e, _ in recs], "accumulators": accs,
                  "count": str(len(recs))}]

    out = {
        "format": "abolish-contract-event-vectors/12",
        "title": "Contract-event records (0x0008) version 12: the trustee registry's PanelPinned with each panel's "
                 "kind",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-v12-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event tables (version 12)) over "
            "contract-event-v11-vectors.py's version-11 check; panels from trustee.json, and every record of "
            "contract-event-v11.json and every trustee-registry vector of contract-event-v2.json re-checked"
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
        "underVersion11": v11_verdicts,
        "decodeErrors": decode_errors,
        "sequences": sequences,
    }
    with open(vec / "contract-event-v12.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
