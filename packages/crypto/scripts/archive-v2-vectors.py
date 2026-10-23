#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/archive-v2.json.

A second implementation of docs/spec/archive.md's version-2 parts: the archive
manifest (record type 0x0021) version 2 with its evidence references, the
contract-event evidence record (record type 0x0025, version 1), each with its
strict decoder and each rejection's code and offset, their CIDs, and how a
reader that knows locator versions 1 and 2 classifies any locator. The
version-1 manifest's encoder and the CID helpers come from archive-vectors.py,
the version-1 generator; standard library only, and nothing here shares code
with packages/crypto.

Two evidence records carry real Base Sepolia data, the game, header and trie
nodes of output-root.json (read from the vectors directory), so each is the
record a writer would make for the account and slots that file proves; every
other value comes from SHA-256 over a label or is written out. Encodings over
4 KiB are given by their recipe and their SHA-256.

Usage: python3 -I -B packages/crypto/scripts/archive-v2-vectors.py <vectors-dir>
"""

import hashlib
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

MANIFEST = 0x0021
EVIDENCE = 0x0025
MAX_OBJECTS = 8192
MAX_LINKS = 1024
MAX_EVIDENCE = 1024
MAX_HEADER = 1024
MAX_NODE = 532
MAX_NODES = 64
CHUNK = 1 << 20
LOCATOR_LENGTH = 70
U64_MAX = 2**64 - 1

sha256, u16, u32, u64 = v1.sha256, v1.u16, v1.u32, v1.u64
raw_cid, fake_raw, pb_cid, label32 = v1.raw_cid, v1.fake_raw, v1.pb_cid, v1.label32
Reject = v1.Reject


class Take:
    def __init__(self, b):
        self.b = b
        self.at = 0

    def __call__(self, n):
        if self.at + n > len(self.b):
            raise Reject("truncated", self.at)
        out = self.b[self.at : self.at + n]
        self.at += n
        return out

    def int(self, n):
        return int.from_bytes(self(n), "big")


def header(t, record_type, version):
    if t.int(2) != record_type:
        # Every type this file writes in a wrong place is an assigned one.
        raise Reject("unexpected-record-type", 0)
    if t(1)[0] != version:
        raise Reject("profile-mismatch", 2)


# --- Manifest version 2 ----------------------------------------------------------


def encode_manifest(m, version=2):
    body = v1.encode(m, version=version)
    out = bytearray(body + u32(len(m["evidence"])))
    for e in m["evidence"]:
        out += e["contract"] + u64(e["l2Block"]) + e["cid"] + e["transaction"]
    return bytes(out)


def ref_key(e):
    return (e["contract"], e["l2Block"], e["cid"])


def decode_manifest(b):
    """docs/spec/archive.md, Layout (version 2): version 1's rules at version 1's offsets, then the evidence."""
    t = Take(b)
    header(t, MANIFEST, 2)
    chain = t.int(8)
    anchor = t(20)
    sequence = t.int(8)
    objects_at = t.at
    n = t.int(4)
    if n > MAX_OBJECTS:
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
    if n > MAX_LINKS:
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
    if n > MAX_EVIDENCE:
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
        # The order is judged once the reference's three keys are read, at the reference.
        if evidence and ref_key(evidence[-1]) >= ref_key(e):
            raise Reject("non-canonical", at)
        evidence.append(e)
    if not objects and not links and not evidence:
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
    }


# --- Contract-event evidence -----------------------------------------------------


def encode_evidence(e, version=1, record_type=EVIDENCE):
    out = bytearray(u16(record_type) + bytes([version]))
    out += u64(e["l2ChainId"]) + e["contract"] + u64(e["gameIndex"]) + e["game"]
    out += e["outputRoot"] + e["messagePasserStorageRoot"]
    out += u32(len(e["header"])) + e["header"]
    out += u32(len(e["nodes"]))
    for node in e["nodes"]:
        out += u32(len(node)) + node
    return bytes(out)


def decode_evidence(b):
    """docs/spec/archive.md, Contract-event evidence, Layout (version 1)."""
    t = Take(b)
    header(t, EVIDENCE, 1)
    chain = t.int(8)
    contract = t(20)
    index = t.int(8)
    game = t(20)
    root = t(32)
    passer = t(32)
    h_at = t.at
    n = t.int(4)
    if n > MAX_HEADER:
        raise Reject("length-over-max", h_at)
    h = t(n)
    if not h:
        raise Reject("non-canonical", h_at)
    nodes_at = t.at
    count = t.int(4)
    if count > MAX_NODES:
        raise Reject("length-over-max", nodes_at)
    if count == 0:
        raise Reject("non-canonical", nodes_at)
    nodes = []
    for _ in range(count):
        at = t.at
        n = t.int(4)
        if n > MAX_NODE:
            raise Reject("length-over-max", at)
        node = t(n)
        # Python orders bytes as the spec does: bytewise, a prefix first.
        if not node or (nodes and nodes[-1] >= node):
            raise Reject("non-canonical", at)
        nodes.append(node)
    if t.at != len(b):
        raise Reject("trailing-bytes", t.at)
    return {
        "l2ChainId": chain,
        "contract": contract,
        "gameIndex": index,
        "game": game,
        "outputRoot": root,
        "messagePasserStorageRoot": passer,
        "header": h,
        "nodes": nodes,
    }


# --- Locators --------------------------------------------------------------------


def read_locator(b):
    """docs/spec/archive.md, Locator, as a reader that knows versions 1 and 2."""
    if len(b) < 3 or len(b) > 128:
        return {"kind": "locator-framing"}
    version = int.from_bytes(b[:2], "big")
    if version == 0:
        return {"kind": "locator-framing"}
    if version not in (1, 2):
        return {"kind": "locator-version", "version": version}
    if len(b) != LOCATOR_LENGTH:
        return {"kind": "locator-length"}
    if not v1.framed(b[2:38], True):
        return {"kind": "locator-cid"}
    return {"kind": "manifest", "version": version, "manifest": b[2:38].hex(), "transaction": b[38:].hex()}


# --- Vectors ---------------------------------------------------------------------


def evidence_json(e):
    return {
        "l2ChainId": str(e["l2ChainId"]),
        "contract": e["contract"].hex(),
        "gameIndex": str(e["gameIndex"]),
        "game": e["game"].hex(),
        "outputRoot": e["outputRoot"].hex(),
        "messagePasserStorageRoot": e["messagePasserStorageRoot"].hex(),
        "header": e["header"].hex(),
        "nodes": [n.hex() for n in e["nodes"]],
    }


def manifest_json(m):
    out = v1.manifest_json(m)
    out["evidence"] = [
        {"contract": e["contract"].hex(), "l2Block": str(e["l2Block"]), "cid": e["cid"].hex(), "transaction": e["transaction"].hex()}
        for e in m["evidence"]
    ]
    return out


BASE_SEPOLIA = 84532
BOARD = bytes.fromhex("e7f1725e7734ce288f8367e1bb143e90bb3f0512")
REGISTRY = bytes.fromhex("9fe46736679d2d9a65f0992f2272de9f3c7fa6e0")


def ref(contract, block, label):
    return {"contract": contract, "l2Block": block, "cid": fake_raw(f"evidence/{label}"), "transaction": label32(f"tx/evidence/{label}")}


def sorted_refs(refs):
    return sorted(refs, key=ref_key)


def full_manifest():
    # Every list full: version 1's full manifest plus 1024 references, contract i % 4 of
    # label32("contract/" + c)[:20], block i // 4, label "full-" + i, sorted.
    m = v1.full_manifest()
    contracts = [label32(f"contract/{c}")[:20] for c in range(4)]
    m["evidence"] = sorted_refs([ref(contracts[i % 4], i // 4, f"full-{i}") for i in range(MAX_EVIDENCE)])
    return m


def max_evidence():
    # Every bound: a 1024-byte header and 64 nodes of 532 bytes, each SHA-256 over its
    # label repeated and cut, sorted.
    def filled(label, length):
        out = b""
        i = 0
        while len(out) < length:
            out += sha256(f"archive-v2/{label}/{i}".encode())
            i += 1
        return out[:length]

    return {
        "l2ChainId": U64_MAX,
        "contract": b"\xff" * 20,
        "gameIndex": U64_MAX,
        "game": b"\xff" * 20,
        "outputRoot": label32("max/root"),
        "messagePasserStorageRoot": label32("max/passer"),
        "header": filled("header", MAX_HEADER),
        "nodes": sorted(filled(f"node-{i}", MAX_NODE) for i in range(MAX_NODES)),
    }


def main():
    out_dir = pathlib.Path(sys.argv[1])
    source = json.loads((out_dir / "output-root.json").read_text())
    game = source["game"]

    # Contract-event evidence records.
    records = []
    by_id = {}

    def add_record(rid, description, e, whole=True):
        enc = encode_evidence(e)
        assert decode_evidence(enc) == e, rid
        assert len(enc) <= CHUNK
        v = {"id": rid, "description": description, "length": len(enc), "cid": raw_cid(enc).hex()}
        if whole:
            v["fields"] = evidence_json(e)
            v["encoding"] = enc.hex()
        else:
            v["recipe"] = "max"
            v["sha256"] = sha256(enc).hex()
        records.append(v)
        by_id[rid] = (e, enc)
        return enc

    for vid, rid in [("message-passer", "base-sepolia-message-passer"), ("l1-block", "base-sepolia-l1-block")]:
        src = next(x for x in source["vectors"] if x["id"] == vid)
        nodes = sorted(set(bytes.fromhex(n) for n in src["nodes"]))
        e = {
            "l2ChainId": int(source["l2ChainId"]),
            "contract": bytes.fromhex(src["address"]),
            "gameIndex": int(game["index"]),
            "game": bytes.fromhex(game["address"]),
            "outputRoot": bytes.fromhex(src["outputRoot"]),
            "messagePasserStorageRoot": bytes.fromhex(src["messagePasserStorageRoot"]),
            "header": bytes.fromhex(src["header"]),
            "nodes": nodes,
        }
        add_record(
            rid,
            f"output-root.json's {vid} vector as a record: Base Sepolia game {game['index']}, its block's header and the "
            f"account and storage proof nodes of slots {', '.join(str(int(s, 16)) for s in src['slots'])} of "
            f"0x{src['address']}, sorted, each once (the decoder judges the form only; these slots aren't S and S + 1)",
            e,
        )
    least = {
        "l2ChainId": 0,
        "contract": bytes(20),
        "gameIndex": 0,
        "game": bytes(20),
        "outputRoot": bytes(32),
        "messagePasserStorageRoot": bytes(32),
        "header": b"\xc0",
        "nodes": [b"\x00"],
    }
    least_enc = add_record("least", "The least record: a one-byte header and one one-byte node, every number 0", least)
    assert len(least_enc) == 3 + 8 + 20 + 8 + 20 + 32 + 32 + 4 + 1 + 4 + 4 + 1
    prefix = {**least, "nodes": [b"\x01", b"\x01\x00", b"\x02"]}
    add_record("prefix-first", "Three nodes where one is a prefix of another: the shorter first", prefix)
    max_enc = add_record("max", "Every bound: a 1024-byte header and 64 nodes of 532 bytes, every number 2^64 - 1", max_evidence(), whole=False)
    assert len(max_enc) == 35_459

    evidence_rejections = []

    def reject_evidence(rid, description, b, code, offset):
        try:
            decode_evidence(b)
        except Reject as e:
            assert (e.code, e.offset) == (code, offset), (rid, e.code, e.offset)
        else:
            raise AssertionError(rid)
        evidence_rejections.append({"id": rid, "description": description, "encoding": b.hex(), "code": code, "offset": offset})

    p = encode_evidence(prefix)
    h_at = 3 + 8 + 20 + 8 + 20 + 32 + 32
    nodes_at = h_at + 4 + 1
    first_node = nodes_at + 4
    reject_evidence("truncated", "Cut inside the last node", p[:-1], "truncated", len(p) - 1)
    reject_evidence("trailing-bytes", "One byte after the last node", p + b"\x00", "trailing-bytes", len(p))
    reject_evidence("version-2", "Version 2, which no manifest lists", encode_evidence(prefix, version=2), "profile-mismatch", 2)
    reject_evidence("manifest-type", "A manifest's record type where evidence is read", encode_evidence(prefix, record_type=MANIFEST), "unexpected-record-type", 0)
    reject_evidence("header-empty", "An empty header", encode_evidence({**prefix, "header": b""}), "non-canonical", h_at)
    over = bytearray(p[:h_at] + u32(MAX_HEADER + 1))
    reject_evidence("header-over-max", "A header length of 1025", bytes(over), "length-over-max", h_at)
    reject_evidence("node-empty", "An empty node first", encode_evidence({**prefix, "nodes": [b"", b"\x01"]}), "non-canonical", first_node)
    reject_evidence(
        "node-over-max",
        "A node length of 533",
        p[:first_node] + u32(MAX_NODE + 1),
        "length-over-max",
        first_node,
    )
    reject_evidence("nodes-over-max", "65 nodes", p[:nodes_at] + u32(MAX_NODES + 1), "length-over-max", nodes_at)
    reject_evidence("no-nodes", "No nodes", encode_evidence({**prefix, "nodes": []}), "non-canonical", nodes_at)
    reject_evidence(
        "nodes-order",
        "The first two nodes swapped",
        encode_evidence({**prefix, "nodes": [b"\x01\x00", b"\x01", b"\x02"]}),
        "non-canonical",
        first_node + 4 + 2,
    )
    reject_evidence(
        "nodes-repeated",
        "One node listed twice",
        encode_evidence({**prefix, "nodes": [b"\x01", b"\x01", b"\x02"]}),
        "non-canonical",
        first_node + 4 + 1,
    )
    mp_e, _ = by_id["base-sepolia-message-passer"]
    reversed_nodes = {**mp_e, "nodes": list(reversed(mp_e["nodes"]))}
    rn = encode_evidence(reversed_nodes)
    reject_evidence(
        "base-sepolia-unsorted",
        "The Base Sepolia message-passer record with its nodes in descending order",
        rn,
        "non-canonical",
        h_at + 4 + len(mp_e["header"]) + 4 + 4 + len(mp_e["nodes"][-1]),
    )

    # Version-2 manifests.
    manifests = []
    mp_cid = raw_cid(by_id["base-sepolia-message-passer"][1])
    l1b_cid = raw_cid(by_id["base-sepolia-l1-block"][1])
    passer = bytes.fromhex("4200000000000000000000000000000000000016")
    l1block = bytes.fromhex("4200000000000000000000000000000000000015")
    block = int(next(x for x in source["vectors"] if x["id"] == "message-passer")["result"]["number"])

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
            {"contract": passer, "l2Block": block, "cid": mp_cid, "transaction": label32("tx/evidence/message-passer")},
            {"contract": l1block, "l2Block": block, "cid": l1b_cid, "transaction": label32("tx/evidence/l1-block")},
        ]
    )
    evidence_only = {
        "l1ChainId": v1.SEPOLIA,
        "anchor": v1.ANCHOR,
        "sequence": 0,
        "objects": [],
        "links": [],
        "evidence": real_refs,
    }
    first_enc = add_manifest("evidence-only", "Sequence 0 listing only the two Base Sepolia records, by their CIDs", evidence_only)
    period = {
        "l1ChainId": v1.SEPOLIA,
        "anchor": v1.ANCHOR,
        "sequence": 3,
        "objects": v1.sorted_objects([v1.obj_entry("segment-a"), v1.obj_entry("hashes-a"), v1.obj_entry("segment-b", 0x70)]),
        "links": [v1.link_entry(0), v1.link_entry(2)],
        "evidence": sorted_refs(
            [ref(BOARD, 7200, "board-7200"), ref(REGISTRY, 7200, "registry-7200"), ref(BOARD, 3600, "board-3600"), ref(BOARD, 7200, "board-7200-second-game")]
        ),
    }
    add_manifest(
        "period",
        "Sequence 3: objects, links to 0 and 2, and evidence for two contracts, one with two records at one block (two games), ordered by contract, block and CID",
        period,
    )
    add_manifest(
        "objects-only",
        "A version-2 manifest with no evidence: version 1's fields and an empty list",
        {**period, "evidence": []},
    )
    edge = {
        "l1ChainId": U64_MAX,
        "anchor": v1.ANCHOR,
        "sequence": U64_MAX,
        "objects": [],
        "links": [v1.link_entry(U64_MAX - 1)],
        "evidence": [ref(b"\x00" * 20, 0, "zero"), ref(b"\xff" * 20, U64_MAX, "max")],
    }
    add_manifest("edges", "The largest sequence linking a straggler, with references at the least and largest contract and block", edge)
    full = full_manifest()
    full_enc = add_manifest("full", "Every list full: 8192 objects, 1024 links and 1024 references, the largest manifest", full, whole=False)
    assert len(full_enc) == 733_235

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
    links_at = first_object + 3 * 68
    first_link = links_at + 4
    evidence_at = first_link + 2 * 76
    first_ref = evidence_at + 4
    reject("truncated", "Cut inside the last reference", p[:-1], "truncated", len(p) - 32)
    reject("trailing-bytes", "One byte after the last reference", p + b"\x00", "trailing-bytes", len(p))
    reject("version-1", "Version 1, which a version-2 locator never names", v1.encode({k: period[k] for k in v1.manifest_json(period)}), "profile-mismatch", 2)
    reject("version-3", "Version 3, unknown and unpinned", encode_manifest(period, version=3), "profile-mismatch", 2)
    reject("evidence-type", "An evidence record's type where a manifest is read", u16(EVIDENCE) + p[2:], "unexpected-record-type", 0)
    reject("evidence-truncated-count", "Cut inside the references' count", p[: evidence_at + 2], "truncated", evidence_at)
    reject("evidence-over-max", "1025 references", p[:evidence_at] + u32(MAX_EVIDENCE + 1), "length-over-max", evidence_at)
    for name, i, value in [("cid-version", 0, 0x00), ("cid-dag-pb", 1, 0x70), ("cid-hash", 2, 0x13), ("cid-length", 3, 0x1F)]:
        b = bytearray(p)
        b[first_ref + 28 + i] = value
        reject(f"evidence-{name}", f"The first reference's CID with byte {i} = {value:#04x}", bytes(b), "non-canonical", first_ref + 28)
    refs = period["evidence"]
    # The registry's address sorts before the board's: [registry 7200, board 3600, board 7200, board 7200].
    assert [r["contract"] for r in refs] == [REGISTRY, BOARD, BOARD, BOARD] and refs[1]["l2Block"] == 3600
    reject("evidence-contract-order", "The two contracts' references in descending order", encode_manifest({**period, "evidence": [refs[3], *refs[:3]]}), "non-canonical", first_ref + 96)
    reject("evidence-block-order", "One contract's blocks in descending order", encode_manifest({**period, "evidence": [refs[0], refs[2], refs[1], refs[3]]}), "non-canonical", first_ref + 2 * 96)
    reject("evidence-cid-order", "Two records at one block in descending order of CID", encode_manifest({**period, "evidence": [*refs[:2], refs[3], refs[2]]}), "non-canonical", first_ref + 3 * 96)
    reject("evidence-repeated", "One reference listed twice", encode_manifest({**period, "evidence": [refs[0], refs[0], *refs[1:]]}), "non-canonical", first_ref + 96)
    reject("empty", "No objects, no links and no evidence", encode_manifest({**evidence_only, "evidence": []}), "non-canonical", objects_at)
    # Version 1's rules, at version 1's offsets, under version 2.
    over = bytearray(p)
    over[objects_at : objects_at + 4] = u32(MAX_OBJECTS + 1)
    reject("objects-over-max", "8193 objects", bytes(over), "length-over-max", objects_at)
    reject("links-over-max", "1025 links", p[:links_at] + u32(MAX_LINKS + 1), "length-over-max", links_at)
    b = bytearray(p)
    b[first_object + 1] = 0x71
    reject("object-cid-codec", "The first object's CID with codec 0x71", bytes(b), "non-canonical", first_object)
    swapped = {**period, "objects": [period["objects"][1], period["objects"][0], period["objects"][2]]}
    reject("objects-order", "The first two objects swapped", encode_manifest(swapped), "non-canonical", first_object + 68)
    pb_link = {**period, "links": [{**v1.link_entry(0), "cid": pb_cid("manifest/0")}, v1.link_entry(2)]}
    reject("link-cid-dag-pb", "A link to a dag-pb CID", encode_manifest(pb_link), "non-canonical", first_link + 8)
    reject("link-own-sequence", "A link to its own sequence", encode_manifest({**period, "links": [v1.link_entry(3)]}), "non-canonical", first_link)
    reject("links-order", "Links in descending order", encode_manifest({**period, "links": [v1.link_entry(2), v1.link_entry(0)]}), "non-canonical", first_link + 76)
    reject(
        "first-links",
        "Sequence 0 with a link",
        encode_manifest({**evidence_only, "links": [v1.link_entry(0)]}),
        "non-canonical",
        objects_at + 4 + 4,
    )

    # Locators, as a reader that knows versions 1 and 2.
    locators = []

    def add_locator(lid, description, b):
        locators.append({"id": lid, "description": description, "locator": b.hex(), "result": read_locator(b)})

    first_cid = raw_cid(first_enc)
    first_tx = label32("tx/manifest/0")
    good = u16(2) + first_cid + first_tx
    assert len(good) == LOCATOR_LENGTH
    add_locator("v2", "Version 2 naming the evidence-only manifest", good)
    add_locator("v1", "Version 1, which names a version-1 manifest", u16(1) + first_cid + first_tx)
    add_locator("v2-short", "Version 2 one byte short", good[:-1])
    add_locator("v2-long", "Version 2 one byte long", good + b"\x00")
    add_locator("v2-dag-pb", "Version 2 naming a dag-pb CID", u16(2) + pb_cid("manifest/0") + first_tx)
    add_locator("v2-cid-hash", "Version 2 whose CID's hash code isn't SHA-256", u16(2) + first_cid[:2] + b"\x13" + first_cid[3:] + first_tx)
    add_locator("v3", "Version 3, reserved: reported, never guessed", u16(3) + first_cid + first_tx)
    add_locator("v0", "Version 0, which the anchor refuses", u16(0) + first_cid + first_tx)
    add_locator("v2-header-only", "Two bytes, no body", u16(2))
    add_locator("over-128", "129 bytes", u16(2) + bytes(127))
    kinds = {x["id"]: x["result"]["kind"] for x in locators}
    assert kinds == {
        "v2": "manifest", "v1": "manifest", "v2-short": "locator-length", "v2-long": "locator-length",
        "v2-dag-pb": "locator-cid", "v2-cid-hash": "locator-cid", "v3": "locator-version", "v0": "locator-framing",
        "v2-header-only": "locator-framing", "over-128": "locator-framing",
    }

    doc = {
        "format": "abolish-archive-vectors/2",
        "title": "Archive manifests of version 2, contract-event evidence records and locators of versions 1 and 2",
        "spec": "docs/spec/archive.md",
        "generator": "packages/crypto/scripts/archive-v2-vectors.py: an independent Python implementation (standard library only) of docs/spec/archive.md's version-2 manifest, contract-event evidence and locators, reusing archive-vectors.py's version-1 encoder, and output-root.json's Base Sepolia game, header and trie nodes",
        "manifest": {"recordType": "0x0021", "version": 2, "maxObjects": MAX_OBJECTS, "maxLinks": MAX_LINKS, "maxEvidence": MAX_EVIDENCE},
        "evidence": {"recordType": "0x0025", "version": 1, "maxHeader": MAX_HEADER, "maxNode": MAX_NODE, "maxNodes": MAX_NODES},
        "locatorLength": LOCATOR_LENGTH,
        "rules": {
            "labels": "as archive.json: label32(x) = SHA-256(\"archive/\" + x); a fake raw CID is 01551220 ‖ label32(x'); a reference (contract, block, label) has cid 01551220 ‖ label32(\"evidence/\" + label) and transaction label32(\"tx/evidence/\" + label)",
            "full": "archive.json's full manifest (l1ChainId 11155111, sequence 1024, 8192 objects, 1024 links) with 1024 references for i = 0 .. 1023: contract label32(\"contract/\" + (i mod 4))[:20], block floor(i / 4), label \"full-\" + i, sorted by contract, block and CID",
            "max": "l2ChainId and gameIndex 2^64 - 1, contract and game twenty 0xff bytes, outputRoot label32(\"max/root\"), messagePasserStorageRoot label32(\"max/passer\"); filled(x, n) is SHA-256(\"archive-v2/\" + x + \"/\" + i) for i = 0, 1, ... concatenated and cut to n; header filled(\"header\", 1024); nodes filled(\"node-\" + i, 532) for i = 0 .. 63, sorted",
        },
        "records": records,
        "recordDecode": evidence_rejections,
        "manifests": manifests,
        "manifestDecode": rejections,
        "locators": locators,
    }
    (out_dir / "archive-v2.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
