#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/archive-v3.json.

A second implementation of docs/spec/archive.md's version-3 parts: the archive
manifest (record type 0x0021) version 3 with its run references, the
contract-event run (record type 0x0026, version 1), each with its strict
decoder and each rejection's code and offset, their CIDs, and how a reader that
knows locator versions 1 to 3 classifies any locator. The version-1 and
version-2 encoders and the CID helpers come from archive-vectors.py and
archive-v2-vectors.py; standard library only, and nothing here shares code
with packages/crypto.

One run carries contract-event-v9.json's election-registry sequence (read from
the vectors directory), so its events, framed as contract-event records, are
that file's records and replay to its accumulators; every other value comes
from SHA-256 over a label or is written out. Encodings over 4 KiB are given by
their recipe and their SHA-256.

Usage: python3 -I -B packages/crypto/scripts/archive-v3-vectors.py <vectors-dir>
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


v1 = _load("archive_vectors", "archive-vectors.py")
v2 = _load("archive_v2_vectors", "archive-v2-vectors.py")

MANIFEST = 0x0021
EVIDENCE = 0x0025
RUN = 0x0026
CONTRACT_EVENT = 0x0008
MAX_RUNS = 1024
MAX_RUN_EVENTS = 65_536
MAX_RUN_LENGTH = 1 << 24
MAX_EVENT_DATA = 1 << 20
MAX_TOPICS = 4
CHUNK = 1 << 20
LOCATOR_LENGTH = 70
U64_MAX = 2**64 - 1

sha256, u16, u32, u64 = v1.sha256, v1.u16, v1.u32, v1.u64
raw_cid, fake_raw, pb_cid, label32 = v1.raw_cid, v1.fake_raw, v1.pb_cid, v1.label32
# Take raises archive-v2-vectors.py's own Reject, so every rejection here is that class.
Reject, Take, header = v2.Reject, v2.Take, v2.header


def object_cid(obj):
    """The object's CID under content-addressing.md: raw up to one chunk, dag-pb past it."""
    c, _ = v1.ca.file_dag(obj, {})
    return c


# --- Contract-event run ----------------------------------------------------------


def encode_run(r, version=1, record_type=RUN):
    out = bytearray(u16(record_type) + bytes([version]))
    out += u64(r["l2ChainId"]) + r["contract"] + u64(r["first"]) + u32(len(r["events"]))
    for e in r["events"]:
        out += u64(e["l2Block"]) + u64(e["l2Timestamp"]) + u32(len(e["topics"]))
        for t in e["topics"]:
            out += t
        out += u32(len(e["data"])) + e["data"]
    return bytes(out)


def decode_run(b):
    """docs/spec/archive.md, Contract-event run, Layout (version 1)."""
    t = Take(b)
    header(t, RUN, 1)
    chain = t.int(8)
    contract = t(20)
    first = t.int(8)
    events_at = t.at
    n = t.int(4)
    if n > MAX_RUN_EVENTS:
        raise Reject("length-over-max", events_at)
    # A run says something, and its last index is a u64.
    if n == 0 or first + n - 1 > U64_MAX:
        raise Reject("non-canonical", events_at)
    events = []
    for _ in range(n):
        block = t.int(8)
        stamp = t.int(8)
        topics_at = t.at
        k = t.int(4)
        if k > MAX_TOPICS:
            raise Reject("length-over-max", topics_at)
        topics = [t(32) for _ in range(k)]
        data_at = t.at
        length = t.int(4)
        if length > MAX_EVENT_DATA:
            raise Reject("length-over-max", data_at)
        events.append({"l2Block": block, "l2Timestamp": stamp, "topics": topics, "data": t(length)})
    if t.at != len(b):
        raise Reject("trailing-bytes", t.at)
    return {"l2ChainId": chain, "contract": contract, "first": first, "events": events}


def run_record(r, i, version=9):
    """Event i as its contract-event record (0x0008) under `version`: contracts.md, Layout (versions 1 to 9)."""
    e = r["events"][i]
    out = bytearray(u16(CONTRACT_EVENT) + bytes([version]))
    out += r["contract"] + u64(r["first"] + i) + u64(e["l2Block"]) + u64(e["l2Timestamp"])
    out += u32(len(e["topics"])) + b"".join(e["topics"]) + u32(len(e["data"])) + e["data"]
    return bytes(out)


# --- Manifest version 3 ----------------------------------------------------------


def encode_manifest(m, version=3):
    out = bytearray(v2.encode_manifest(m, version=version) + u32(len(m["runs"])))
    for r in m["runs"]:
        out += r["contract"] + u64(r["first"]) + u32(r["count"]) + r["cid"] + r["transaction"]
    return bytes(out)


def run_key(r):
    return (r["contract"], r["first"], r["cid"])


def decode_manifest(b):
    """docs/spec/archive.md, Layout (version 3): version 2's rules at version 2's offsets, then the runs."""
    t = Take(b)
    header(t, MANIFEST, 3)
    chain = t.int(8)
    anchor = t(20)
    sequence = t.int(8)
    objects_at = t.at
    n = t.int(4)
    if n > v1.MAX_OBJECTS:
        raise Reject("length-over-max", objects_at)
    objects = []
    for _ in range(n):
        at = t.at
        c = t(36)
        if not v1.framed(c, False) or (objects and objects[-1]["cid"] >= c):
            raise Reject("non-canonical", at)
        objects.append({"cid": c, "transaction": t(32)})
    links_at = t.at
    n = t.int(4)
    if n > v1.MAX_LINKS:
        raise Reject("length-over-max", links_at)
    links = []
    for _ in range(n):
        at = t.at
        s = t.int(8)
        if s >= sequence or (links and s <= links[-1]["sequence"]):
            raise Reject("non-canonical", at)
        c_at = t.at
        c = t(36)
        if not v1.framed(c, True):
            raise Reject("non-canonical", c_at)
        links.append({"sequence": s, "cid": c, "transaction": t(32)})
    evidence_at = t.at
    n = t.int(4)
    if n > v2.MAX_EVIDENCE:
        raise Reject("length-over-max", evidence_at)
    evidence = []
    for _ in range(n):
        at = t.at
        contract = t(20)
        block = t.int(8)
        c_at = t.at
        c = t(36)
        if not v1.framed(c, True):
            raise Reject("non-canonical", c_at)
        e = {"contract": contract, "l2Block": block, "cid": c, "transaction": t(32)}
        if evidence and v2.ref_key(evidence[-1]) >= v2.ref_key(e):
            raise Reject("non-canonical", at)
        evidence.append(e)
    runs_at = t.at
    n = t.int(4)
    if n > MAX_RUNS:
        raise Reject("length-over-max", runs_at)
    runs = []
    for _ in range(n):
        at = t.at
        contract = t(20)
        first = t.int(8)
        count_at = t.at
        count = t.int(4)
        if count == 0 or count > MAX_RUN_EVENTS or first + count > 2**64:
            raise Reject("non-canonical", count_at)
        c_at = t.at
        c = t(36)
        if not v1.framed(c, False):
            raise Reject("non-canonical", c_at)
        r = {"contract": contract, "first": first, "count": count, "cid": c, "transaction": t(32)}
        # The order is judged once the whole reference is read, at the reference's offset.
        if runs and run_key(runs[-1]) >= run_key(r):
            raise Reject("non-canonical", at)
        runs.append(r)
    if not objects and not links and not evidence and not runs:
        raise Reject("non-canonical", objects_at)
    if t.at != len(b):
        raise Reject("trailing-bytes", t.at)
    return {
        "l1ChainId": chain,
        "anchor": anchor,
        "sequence": sequence,
        "objects": objects,
        "links": links,
        "evidence": evidence,
        "runs": runs,
    }


# --- Locators --------------------------------------------------------------------


def read_locator(b):
    """docs/spec/archive.md, Locator, as a reader that knows versions 1 to 3."""
    if len(b) < 3 or len(b) > 128:
        return {"kind": "locator-framing"}
    version = int.from_bytes(b[:2], "big")
    if version == 0:
        return {"kind": "locator-framing"}
    if version not in (1, 2, 3):
        return {"kind": "locator-version", "version": version}
    if len(b) != LOCATOR_LENGTH:
        return {"kind": "locator-length"}
    if not v1.framed(b[2:38], True):
        return {"kind": "locator-cid"}
    return {"kind": "manifest", "version": version, "manifest": b[2:38].hex(), "transaction": b[38:].hex()}


# --- Vectors ---------------------------------------------------------------------


def run_json(r):
    return {
        "l2ChainId": str(r["l2ChainId"]),
        "contract": r["contract"].hex(),
        "first": str(r["first"]),
        "events": [
            {"l2Block": str(e["l2Block"]), "l2Timestamp": str(e["l2Timestamp"]), "topics": [x.hex() for x in e["topics"]], "data": e["data"].hex()}
            for e in r["events"]
        ],
    }


def manifest_json(m):
    out = v2.manifest_json(m)
    out["runs"] = [
        {"contract": r["contract"].hex(), "first": str(r["first"]), "count": r["count"], "cid": r["cid"].hex(), "transaction": r["transaction"].hex()}
        for r in m["runs"]
    ]
    return out


def ref(contract, first, count, label, codec=0x55):
    return {
        "contract": contract,
        "first": first,
        "count": count,
        "cid": bytes([0x01, codec, 0x12, 0x20]) + label32(f"run/{label}"),
        "transaction": label32(f"tx/run/{label}"),
    }


def sorted_refs(refs):
    return sorted(refs, key=run_key)


def full_manifest():
    # Every list full: archive-v2.json's full manifest plus 1024 run references, contract
    # label32("contract/" + (i mod 4))[:20], first 1000 * floor(i / 4), count 1000, label "full-" + i, sorted.
    m = v2.full_manifest()
    contracts = [label32(f"contract/{c}")[:20] for c in range(4)]
    m["runs"] = sorted_refs([ref(contracts[i % 4], 1000 * (i // 4), 1000, f"full-{i}") for i in range(MAX_RUNS)])
    return m


def max_events_run():
    # 65,536 events, event i at block and timestamp i with no topics and no data.
    return {
        "l2ChainId": 84532,
        "contract": label32("max-events")[:20],
        "first": 0,
        "events": [{"l2Block": i, "l2Timestamp": i, "topics": [], "data": b""} for i in range(MAX_RUN_EVENTS)],
    }


def max_length_run():
    # 16 events at blocks 0 .. 15, each one topic label32("topic/" + i); event i's data is
    # the byte i repeated, 2^20 bytes for i < 15 and what is left of 2^24 for i = 15.
    events = [{"l2Block": i, "l2Timestamp": 1000 + i, "topics": [label32(f"topic/{i}")], "data": bytes([i]) * MAX_EVENT_DATA} for i in range(16)]
    head = 3 + 8 + 20 + 8 + 4
    each = 8 + 8 + 4 + 32 + 4
    events[15]["data"] = bytes([15]) * (MAX_RUN_LENGTH - head - 16 * each - 15 * MAX_EVENT_DATA)
    return {"l2ChainId": 84532, "contract": label32("max-length")[:20], "first": 7, "events": events}


def main():
    out_dir = pathlib.Path(sys.argv[1])
    source = json.loads((out_dir / "contract-event-v9.json").read_text())
    by_record = {r["id"]: r for r in source["records"]}

    runs = []
    by_id = {}

    def add_run(rid, description, r, whole=True, recipe=None):
        enc = encode_run(r)
        assert len(enc) <= MAX_RUN_LENGTH, rid
        if whole:
            assert decode_run(enc) == r, rid
        cid = object_cid(enc)
        v = {"id": rid, "description": description, "length": len(enc), "cid": cid.hex()}
        if whole:
            v["fields"] = run_json(r)
            v["encoding"] = enc.hex()
            v["records"] = [run_record(r, i).hex() for i in range(len(r["events"]))]
        else:
            v["recipe"] = recipe
            v["sha256"] = sha256(enc).hex()
        runs.append(v)
        by_id[rid] = (r, enc, cid)
        return enc

    seq = next(s for s in source["sequences"] if s["role"] == "election-registry")
    registry = bytes.fromhex(source["contracts"]["election-registry"])
    records = [by_record[x] for x in seq["records"]]
    first = int(records[0]["fields"]["n"])
    assert first == 0 and [int(x["fields"]["n"]) for x in records] == list(range(len(records)))
    registry_run = {
        "l2ChainId": int(source["chainId"]),
        "contract": registry,
        "first": first,
        "events": [
            {
                "l2Block": int(x["fields"]["l2Block"]),
                "l2Timestamp": int(x["fields"]["l2Timestamp"]),
                "topics": [bytes.fromhex(t) for t in x["fields"]["topics"]],
                "data": bytes.fromhex(x["fields"]["data"]),
            }
            for x in records
        ],
    }
    for x in records:
        assert bytes.fromhex(x["fields"]["contract"]) == registry
    add_run(
        "election-registry-sequence",
        f"contract-event-v9.json's election-registry sequence, {len(records)} events from n = 0, whose records are that file's and replay to its accumulators",
        registry_run,
    )
    # Each event framed under version 9 is the source file's record, byte for byte.
    for i, x in enumerate(records):
        assert run_record(registry_run, i).hex() == x["encoding"], x["id"]
    one = {
        "l2ChainId": 84532,
        "contract": label32("one")[:20],
        "first": 41,
        "events": [{"l2Block": 7200, "l2Timestamp": 1_760_000_000, "topics": [label32("topic/one"), label32("topic/two")], "data": bytes(range(64))}],
    }
    add_run("one-event", "One event at n = 41 with two topics and 64 bytes of data", one)
    edges = {
        "l2ChainId": U64_MAX,
        "contract": b"\xff" * 20,
        "first": U64_MAX,
        "events": [{"l2Block": U64_MAX, "l2Timestamp": U64_MAX, "topics": [label32(f"topic/{i}") for i in range(4)], "data": b""}],
    }
    add_run("last-index", "One event at n = 2^64 - 1, the last index, with four topics and no data, every number 2^64 - 1", edges)
    two = {
        "l2ChainId": 0,
        "contract": bytes(20),
        "first": U64_MAX - 1,
        "events": [
            {"l2Block": 0, "l2Timestamp": 0, "topics": [], "data": b""},
            {"l2Block": 0, "l2Timestamp": 0, "topics": [], "data": b"\x00"},
        ],
    }
    add_run("ends-at-last-index", "Two events from n = 2^64 - 2, ending at the last index; no topics (which the event check refuses, not the decoder)", two)
    decreasing = {
        "l2ChainId": 84532,
        "contract": label32("decreasing")[:20],
        "first": 0,
        "events": [
            {"l2Block": 9, "l2Timestamp": 90, "topics": [label32("topic/a")], "data": b"a"},
            {"l2Block": 3, "l2Timestamp": 30, "topics": [label32("topic/b")], "data": b"b"},
        ],
    }
    add_run("blocks-decreasing", "Two events whose blocks and timestamps decrease: the form decodes, and the replay's `order` rule refuses it", decreasing)
    me = add_run("max-events", "65,536 events, the most a run holds, past one chunk", max_events_run(), whole=False, recipe="max-events")
    assert len(me) == 43 + MAX_RUN_EVENTS * 24 and len(me) > CHUNK
    ml = add_run("max-length", "16 events filling 2^24 bytes, the longest run", max_length_run(), whole=False, recipe="max-length")
    assert len(ml) == MAX_RUN_LENGTH

    run_rejections = []

    def reject_run(rid, description, b, code, offset):
        try:
            decode_run(b)
        except Reject as e:
            assert (e.code, e.offset) == (code, offset), (rid, e.code, e.offset)
        else:
            raise AssertionError(rid)
        run_rejections.append({"id": rid, "description": description, "encoding": b.hex(), "code": code, "offset": offset})

    p = encode_run(one)
    events_at = 3 + 8 + 20 + 8
    first_event = events_at + 4
    topics_at = first_event + 16
    data_at = topics_at + 4 + 2 * 32
    reject_run("truncated", "Cut inside the data", p[:-1], "truncated", data_at + 4)
    reject_run("trailing-bytes", "One byte after the last event", p + b"\x00", "trailing-bytes", len(p))
    reject_run("version-2", "Version 2, which no manifest lists", encode_run(one, version=2), "profile-mismatch", 2)
    reject_run("manifest-type", "A manifest's record type where a run is read", encode_run(one, record_type=MANIFEST), "unexpected-record-type", 0)
    reject_run("evidence-type", "An evidence record's type where a run is read", encode_run(one, record_type=EVIDENCE), "unexpected-record-type", 0)
    reject_run("no-events", "No events", encode_run({**one, "events": []}), "non-canonical", events_at)
    reject_run("events-over-max", "65,537 events", p[:events_at] + u32(MAX_RUN_EVENTS + 1), "length-over-max", events_at)
    reject_run(
        "past-last-index",
        "Two events from n = 2^64 - 1, the second past the last index",
        encode_run({**two, "first": U64_MAX}),
        "non-canonical",
        events_at,
    )
    reject_run("topics-over-max", "Five topics", p[:topics_at] + u32(MAX_TOPICS + 1), "length-over-max", topics_at)
    reject_run("data-over-max", "Data of 2^20 + 1 bytes", p[:data_at] + u32(MAX_EVENT_DATA + 1), "length-over-max", data_at)
    reject_run("truncated-count", "Cut inside the events' count", p[: events_at + 2], "truncated", events_at)
    reject_run("count-past-events", "A count of 2 with one event", p[:events_at] + u32(2) + p[first_event:], "truncated", len(p))

    # Version-3 manifests.
    manifests = []
    registry_cid = by_id["election-registry-sequence"][2]
    one_cid = by_id["one-event"][2]
    me_cid = by_id["max-events"][2]
    assert registry_cid[1] == 0x55 and me_cid[1] == 0x70

    def add_manifest(mid, description, m, whole=True):
        enc = encode_manifest(m)
        assert decode_manifest(enc) == m, mid
        assert len(enc) <= CHUNK
        v = {"id": mid, "description": description, "length": len(enc), "cid": raw_cid(enc).hex()}
        if whole:
            v["fields"] = manifest_json(m)
            v["encoding"] = enc.hex()
        else:
            v["recipe"] = "full"
            v["sha256"] = sha256(enc).hex()
        manifests.append(v)
        return enc

    real_refs = sorted_refs(
        [
            {"contract": registry, "first": 0, "count": len(records), "cid": registry_cid, "transaction": label32("tx/run/registry")},
            {"contract": one["contract"], "first": 41, "count": 1, "cid": one_cid, "transaction": label32("tx/run/one")},
            {"contract": max_events_run()["contract"], "first": 0, "count": MAX_RUN_EVENTS, "cid": me_cid, "transaction": label32("tx/run/max-events")},
        ]
    )
    runs_only = {"l1ChainId": v1.SEPOLIA, "anchor": v1.ANCHOR, "sequence": 0, "objects": [], "links": [], "evidence": [], "runs": real_refs}
    first_enc = add_manifest("runs-only", "Sequence 0 listing only three of this file's runs, by their CIDs (one dag-pb)", runs_only)
    board = v2.BOARD
    reg2 = v2.REGISTRY
    period = {
        "l1ChainId": v1.SEPOLIA,
        "anchor": v1.ANCHOR,
        "sequence": 3,
        "objects": v1.sorted_objects([v1.obj_entry("segment-a"), v1.obj_entry("hashes-a")]),
        "links": [v1.link_entry(1), v1.link_entry(2)],
        "evidence": v2.sorted_refs([v2.ref(board, 7200, "board-7200"), v2.ref(reg2, 7200, "registry-7200")]),
        "runs": sorted_refs(
            [
                ref(board, 120, 30, "board-120"),
                ref(board, 0, 120, "board-0", codec=0x70),
                ref(reg2, 5, 2, "registry-5"),
                ref(board, 120, 30, "board-120-second"),
            ]
        ),
    }
    add_manifest(
        "period",
        "Sequence 3: objects, links, evidence and runs for two contracts, one with two runs from one index, ordered by contract, first index and CID",
        period,
    )
    add_manifest("no-runs", "A version-3 manifest with no runs: version 2's fields and an empty list", {**period, "runs": []})
    edge = {
        "l1ChainId": U64_MAX,
        "anchor": v1.ANCHOR,
        "sequence": U64_MAX,
        "objects": [],
        "links": [v1.link_entry(U64_MAX - 1)],
        "evidence": [],
        "runs": [ref(bytes(20), 0, MAX_RUN_EVENTS, "zero"), ref(b"\xff" * 20, U64_MAX, 1, "last")],
    }
    add_manifest("edges", "The largest sequence linking a straggler, with runs of 65,536 events from 0 and of one event at the last index", edge)
    full_enc = add_manifest("full", "Every list full: 8192 objects, 1024 links, 1024 evidence references and 1024 run references, the largest manifest", full_manifest(), whole=False)
    assert len(full_enc) == 835_639

    rejections = []

    def reject(rid, description, b, code, offset):
        try:
            decode_manifest(b)
        except Reject as e:
            assert (e.code, e.offset) == (code, offset), (rid, e.code, e.offset)
        else:
            raise AssertionError(rid)
        rejections.append({"id": rid, "description": description, "encoding": b.hex(), "code": code, "offset": offset})

    p = encode_manifest(period)
    objects_at = 3 + 36
    first_object = objects_at + 4
    links_at = first_object + 2 * 68
    first_link = links_at + 4
    evidence_at = first_link + 2 * 76
    first_evidence = evidence_at + 4
    runs_at = first_evidence + 2 * 96
    first_run = runs_at + 4
    reject("truncated", "Cut inside the last run reference", p[:-1], "truncated", len(p) - 32)
    reject("trailing-bytes", "One byte after the last run reference", p + b"\x00", "trailing-bytes", len(p))
    v2_period = {k: period[k] for k in ("l1ChainId", "anchor", "sequence", "objects", "links", "evidence")}
    reject("version-2", "Version 2, which a version-3 locator never names", v2.encode_manifest(v2_period), "profile-mismatch", 2)
    reject("version-4", "Version 4, unknown and unpinned", encode_manifest(period, version=4), "profile-mismatch", 2)
    reject("run-type", "A run's record type where a manifest is read", u16(RUN) + p[2:], "unexpected-record-type", 0)
    reject("runs-truncated-count", "Cut inside the run references' count", p[: runs_at + 2], "truncated", runs_at)
    reject("runs-over-max", "1025 run references", p[:runs_at] + u32(MAX_RUNS + 1), "length-over-max", runs_at)
    refs = period["runs"]
    # The registry's address sorts before the board's: [registry 5, board 0, board 120, board 120].
    assert [r["contract"] for r in refs] == [reg2, board, board, board] and refs[1]["first"] == 0
    count_at = first_run + 28
    for name, count, first_value, what in [
        ("run-count-zero", 0, 5, "A count of 0"),
        ("run-count-over-max", MAX_RUN_EVENTS + 1, 5, "A count of 65,537"),
        ("run-past-last-index", 2, U64_MAX, "A run of two events from n = 2^64 - 1"),
    ]:
        b = bytearray(p)
        b[first_run + 20 : first_run + 28] = u64(first_value)
        b[count_at : count_at + 4] = u32(count)
        reject(name, f"{what} in the first run reference", bytes(b), "non-canonical", count_at)
    for name, i, value in [("cid-version", 0, 0x00), ("cid-codec", 1, 0x71), ("cid-hash", 2, 0x13), ("cid-length", 3, 0x1F)]:
        b = bytearray(p)
        b[first_run + 32 + i] = value
        reject(f"run-{name}", f"The first run reference's CID with byte {i} = {value:#04x}", bytes(b), "non-canonical", first_run + 32)
    reject("run-contract-order", "The two contracts' runs in descending order", encode_manifest({**period, "runs": [refs[3], *refs[:3]]}), "non-canonical", first_run + 100)
    reject("run-first-order", "One contract's runs in descending order of first index", encode_manifest({**period, "runs": [refs[0], refs[2], refs[1], refs[3]]}), "non-canonical", first_run + 2 * 100)
    reject("run-cid-order", "Two runs from one index in descending order of CID", encode_manifest({**period, "runs": [*refs[:2], refs[3], refs[2]]}), "non-canonical", first_run + 3 * 100)
    reject("run-repeated", "One run reference listed twice", encode_manifest({**period, "runs": [refs[0], refs[0], *refs[1:]]}), "non-canonical", first_run + 100)
    reject("empty", "No objects, no links, no evidence and no runs", encode_manifest({**runs_only, "runs": []}), "non-canonical", objects_at)
    # Version 2's rules, at version 2's offsets, under version 3.
    reject("evidence-over-max", "1025 evidence references", p[:evidence_at] + u32(v2.MAX_EVIDENCE + 1), "length-over-max", evidence_at)
    b = bytearray(p)
    b[first_evidence + 28 + 1] = 0x70
    reject("evidence-cid-dag-pb", "The first evidence reference's CID dag-pb", bytes(b), "non-canonical", first_evidence + 28)
    ev = period["evidence"]
    reject("evidence-order", "Evidence references in descending order", encode_manifest({**period, "evidence": [ev[1], ev[0]]}), "non-canonical", first_evidence + 96)
    over = bytearray(p)
    over[objects_at : objects_at + 4] = u32(v1.MAX_OBJECTS + 1)
    reject("objects-over-max", "8193 objects", bytes(over), "length-over-max", objects_at)
    reject("link-own-sequence", "A link to its own sequence", encode_manifest({**period, "links": [v1.link_entry(3)]}), "non-canonical", first_link)
    reject("first-links", "Sequence 0 with a link", encode_manifest({**runs_only, "links": [v1.link_entry(0)]}), "non-canonical", objects_at + 4 + 4)

    # Locators, as a reader that knows versions 1 to 3.
    locators = []

    def add_locator(lid, description, b):
        locators.append({"id": lid, "description": description, "locator": b.hex(), "result": read_locator(b)})

    first_cid = raw_cid(first_enc)
    first_tx = label32("tx/manifest/0")
    good = u16(3) + first_cid + first_tx
    assert len(good) == LOCATOR_LENGTH
    add_locator("v3", "Version 3 naming the runs-only manifest", good)
    add_locator("v2", "Version 2, which names a version-2 manifest", u16(2) + first_cid + first_tx)
    add_locator("v1", "Version 1, which names a version-1 manifest", u16(1) + first_cid + first_tx)
    add_locator("v3-short", "Version 3 one byte short", good[:-1])
    add_locator("v3-long", "Version 3 one byte long", good + b"\x00")
    add_locator("v3-dag-pb", "Version 3 naming a dag-pb CID", u16(3) + pb_cid("manifest/0") + first_tx)
    add_locator("v4", "Version 4, reserved: reported, never guessed", u16(4) + first_cid + first_tx)
    add_locator("v0", "Version 0, which the anchor refuses", u16(0) + first_cid + first_tx)
    add_locator("v3-header-only", "Two bytes, no body", u16(3))
    kinds = {x["id"]: x["result"]["kind"] for x in locators}
    assert kinds == {
        "v3": "manifest", "v2": "manifest", "v1": "manifest", "v3-short": "locator-length", "v3-long": "locator-length",
        "v3-dag-pb": "locator-cid", "v4": "locator-version", "v0": "locator-framing", "v3-header-only": "locator-framing",
    }

    doc = {
        "format": "abolish-archive-vectors/3",
        "title": "Archive manifests of version 3, contract-event runs and locators of versions 1 to 3",
        "spec": "docs/spec/archive.md",
        "generator": "packages/crypto/scripts/archive-v3-vectors.py: an independent Python implementation (standard library only) of docs/spec/archive.md's version-3 manifest, contract-event run and locators, reusing archive-vectors.py's and archive-v2-vectors.py's encoders and CIDs, and contract-event-v9.json's election-registry sequence",
        "manifest": {"recordType": "0x0021", "version": 3, "maxRuns": MAX_RUNS},
        "run": {"recordType": "0x0026", "version": 1, "maxEvents": MAX_RUN_EVENTS, "maxLength": MAX_RUN_LENGTH, "recordsVersion": 9},
        "locatorLength": LOCATOR_LENGTH,
        "rules": {
            "labels": "as archive.json: label32(x) = SHA-256(\"archive/\" + x); a run reference (contract, first, count, label) has cid 01 ‖ codec ‖ 1220 ‖ label32(\"run/\" + label), codec 55 unless stated, and transaction label32(\"tx/run/\" + label)",
            "records": "each run's `records` are its events framed as contract-event records (0x0008) under version 9: contract, n = first + i, and the event's fields",
            "full": "archive-v2.json's full manifest with 1024 run references for i = 0 .. 1023: contract label32(\"contract/\" + (i mod 4))[:20], first 1000 * floor(i / 4), count 1000, label \"full-\" + i, sorted by contract, first and CID",
            "max-events": "l2ChainId 84532, contract label32(\"max-events\")[:20], first 0, 65,536 events, event i at l2Block and l2Timestamp i with no topics and no data",
            "max-length": "l2ChainId 84532, contract label32(\"max-length\")[:20], first 7, 16 events, event i at l2Block i and l2Timestamp 1000 + i with the one topic label32(\"topic/\" + i) and data the byte i repeated, 2^20 times for i < 15 and for i = 15 as many times as brings the encoding to 2^24 bytes (1,048,149)",
        },
        "runs": runs,
        "runDecode": run_rejections,
        "manifests": manifests,
        "manifestDecode": rejections,
        "locators": locators,
    }
    (out_dir / "archive-v3.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
