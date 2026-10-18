#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/archive.json.

A second implementation of docs/spec/archive.md: the archive manifest (record
type 0x0021, version 1) with its strict decoder and each rejection's code and
offset, the manifest's CID, the version-1 locator and how a reader classifies
any locator, and the reading of an object from an Arweave transaction's data.
The DAGs and CARs come from release-record-vectors.py's implementation of
docs/spec/content-addressing.md, which rebuilds every site Kubo 0.36.0 and
ipfs-unixfs-importer 17.1.1 produced. Standard library only; nothing here
shares code with packages/crypto.

Every object's bytes come from SHA-256 over its label (the object rule of
site-directory.json), every CID and transaction ID from SHA-256 over a label,
and every other value is written out, so any implementation can reproduce each
encoding. Data over 4 KiB is given by its recipe and its SHA-256.

Usage: python3 -I -B packages/crypto/scripts/archive-vectors.py <vectors-dir>
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


ca = _load("release_record_vectors", "release-record-vectors.py")

RECORD_TYPE = 0x0021
VERSION = 1
MAX_OBJECTS = 8192
MAX_LINKS = 1024
CHUNK = 1 << 20
LOCATOR_V1_LENGTH = 70
U64_MAX = 2**64 - 1


def sha256(b):
    return hashlib.sha256(b).digest()


def label32(label):
    return sha256(f"archive/{label}".encode())


def raw_cid(block):
    return bytes([0x01, 0x55, 0x12, 0x20]) + sha256(block)


def pb_cid(label):
    return bytes([0x01, 0x70, 0x12, 0x20]) + label32(label)


def fake_raw(label):
    return bytes([0x01, 0x55, 0x12, 0x20]) + label32(label)


def u16(x):
    return x.to_bytes(2, "big")


def u32(x):
    return x.to_bytes(4, "big")


def u64(x):
    assert 0 <= x <= U64_MAX
    return x.to_bytes(8, "big")


# --- The manifest ----------------------------------------------------------------


def encode(m, record_type=RECORD_TYPE, version=VERSION):
    out = bytearray(u16(record_type) + bytes([version]))
    out += u64(m["l1ChainId"]) + m["anchor"] + u64(m["sequence"])
    out += u32(len(m["objects"]))
    for o in m["objects"]:
        out += o["cid"] + o["transaction"]
    out += u32(len(m["links"]))
    for link in m["links"]:
        out += u64(link["sequence"]) + link["cid"] + link["transaction"]
    return bytes(out)


class Reject(Exception):
    def __init__(self, code, offset):
        super().__init__(f"{code} at {offset}")
        self.code = code
        self.offset = offset


def framed(c, raw_only):
    return c[0] == 0x01 and (c[1] == 0x55 or (not raw_only and c[1] == 0x70)) and c[2] == 0x12 and c[3] == 0x20


def decode(b):
    """docs/spec/archive.md, Layout (version 1): framing, then each rule as soon as its fields are read."""
    at = 0

    def take(n):
        nonlocal at
        if at + n > len(b):
            raise Reject("truncated", at)
        out = b[at : at + n]
        at += n
        return out

    if int.from_bytes(take(2), "big") != RECORD_TYPE:
        # Every assigned type other than 0x0021 is unexpected here; this file only uses assigned ones.
        raise Reject("unexpected-record-type", 0)
    if take(1)[0] != VERSION:
        raise Reject("profile-mismatch", 2)
    chain = int.from_bytes(take(8), "big")
    anchor = take(20)
    sequence = int.from_bytes(take(8), "big")
    objects_at = at
    n = int.from_bytes(take(4), "big")
    if n > MAX_OBJECTS:
        raise Reject("length-over-max", objects_at)
    objects = []
    for _ in range(n):
        o_at = at
        c = take(36)
        if not framed(c, False) or (objects and objects[-1]["cid"] >= c):
            raise Reject("non-canonical", o_at)
        objects.append({"cid": c, "transaction": take(32)})
    links_at = at
    n = int.from_bytes(take(4), "big")
    if n > MAX_LINKS:
        raise Reject("length-over-max", links_at)
    links = []
    for _ in range(n):
        l_at = at
        s = int.from_bytes(take(8), "big")
        if s >= sequence or (links and s <= links[-1]["sequence"]):
            raise Reject("non-canonical", l_at)
        c_at = at
        c = take(36)
        if not framed(c, True):
            raise Reject("non-canonical", c_at)
        links.append({"sequence": s, "cid": c, "transaction": take(32)})
    if not objects and not links:
        raise Reject("non-canonical", objects_at)
    if at != len(b):
        raise Reject("trailing-bytes", at)
    return {"l1ChainId": chain, "anchor": anchor, "sequence": sequence, "objects": objects, "links": links}


# --- Locators --------------------------------------------------------------------


def locator(manifest_cid, transaction):
    return u16(1) + manifest_cid + transaction


def read_locator(b):
    """docs/spec/archive.md, Locator, with the anchor's framing from contracts.md, Archive locator."""
    if len(b) < 3 or len(b) > 128:
        return {"kind": "locator-framing"}
    version = int.from_bytes(b[:2], "big")
    if version == 0:
        return {"kind": "locator-framing"}
    if version != 1:
        return {"kind": "locator-version", "version": version}
    if len(b) != LOCATOR_V1_LENGTH:
        return {"kind": "locator-length"}
    if not framed(b[2:38], True):
        return {"kind": "locator-cid"}
    return {"kind": "manifest", "version": 1, "manifest": b[2:38].hex(), "transaction": b[38:].hex()}


# --- Reading an object from a transaction's data ---------------------------------


def car_header(root):
    header = b"\xa2\x65roots\x81\xd8\x2a\x58\x25\x00" + root + b"\x67version\x01"
    return ca.varint(len(header)) + header


def minimal_varint(b, at):
    n = shift = 0
    for i in range(8):
        if at + i >= len(b):
            return None
        x = b[at + i]
        n |= (x & 0x7F) << shift
        shift += 7
        if not x & 0x80:
            if x == 0 and i > 0:
                return None
            return n, at + i + 1
    return None


def unixfs_filesize(node):
    """The filesize a dag-pb root claims, or None; the final CAR comparison judges the rest."""
    at = 0
    while at < len(node):
        key, at = ca.read_varint(node, at)
        length, at = ca.read_varint(node, at)
        body = node[at : at + length]
        at += length
        if key == (1 << 3 | 2):
            j = 0
            while j < len(body):
                k, j = ca.read_varint(body, j)
                v, j = ca.read_varint(body, j)
                if k == (3 << 3):
                    return v
            return None
    return None


def read_archived(data, root, bound):
    """docs/spec/archive.md, Archived objects, steps 1 to 4."""
    inconsistent = {"ok": False, "reason": "inconsistent"}
    if not framed(root, False):
        return inconsistent
    header = car_header(root)
    if data[: len(header)] != header:
        return inconsistent
    blocks = {}
    at = len(header)
    while at < len(data):
        v = minimal_varint(data, at)
        if v is None:
            return inconsistent
        n, at = v
        if n < 36 or at + n > len(data):
            return inconsistent
        c = data[at : at + 36]
        if not framed(c, False):
            return inconsistent
        blocks.setdefault(c, data[at + 36 : at + n])
        at += n
    if root not in blocks or sha256(blocks[root]) != root[4:]:
        return inconsistent
    top = blocks[root]
    if root[1] == 0x55:
        length = len(top)
        if length > CHUNK:
            return inconsistent
    else:
        length = unixfs_filesize(top)
        if length is None or length <= CHUNK:
            return inconsistent
    if length > bound:
        return {"ok": False, "reason": "over-bound", "length": length}

    def leaves(c, depth):
        if c not in blocks or sha256(blocks[c]) != c[4:] or depth > 4:
            return None
        if c[1] == 0x55:
            return blocks[c]
        out = b""
        for link in ca.dag_pb_links(blocks[c]):
            part = leaves(link, depth + 1)
            if part is None:
                return None
            out += part
        return out

    obj = leaves(root, 0)
    if obj is None or len(obj) != length:
        return inconsistent
    expected, _ = object_car(obj)
    if expected != data:
        return inconsistent
    return {"ok": True, "length": length}


def object_car(obj):
    blocks = {}
    root, _ = ca.file_dag(obj, blocks)
    car, count = ca.car(root, blocks)
    return car, root


# --- Vectors ---------------------------------------------------------------------


def manifest_json(m):
    return {
        "l1ChainId": str(m["l1ChainId"]),
        "anchor": m["anchor"].hex(),
        "sequence": str(m["sequence"]),
        "objects": [{"cid": o["cid"].hex(), "transaction": o["transaction"].hex()} for o in m["objects"]],
        "links": [
            {"sequence": str(x["sequence"]), "cid": x["cid"].hex(), "transaction": x["transaction"].hex()}
            for x in m["links"]
        ],
    }


ANCHOR = bytes.fromhex("5fbdb2315678afecb367f032d93f642f64180aa3")
SEPOLIA = 11155111


def obj_entry(label, codec=0x55):
    c = (fake_raw if codec == 0x55 else pb_cid)(f"object/{label}")
    return {"cid": c, "transaction": label32(f"tx/{label}")}


def link_entry(sequence):
    return {
        "sequence": sequence,
        "cid": fake_raw(f"manifest/{sequence}"),
        "transaction": label32(f"tx/manifest/{sequence}"),
    }


def sorted_objects(entries):
    return sorted(entries, key=lambda o: o["cid"])


def full_manifest():
    # The bound: MAX_OBJECTS objects (half dag-pb) and MAX_LINKS links 0 .. 1023 below sequence 1024.
    objects = sorted_objects([obj_entry(f"full-{i}", 0x70 if i % 2 else 0x55) for i in range(MAX_OBJECTS)])
    links = [link_entry(s) for s in range(MAX_LINKS)]
    return {"l1ChainId": SEPOLIA, "anchor": ANCHOR, "sequence": MAX_LINKS, "objects": objects, "links": links}


def main():
    out_dir = pathlib.Path(sys.argv[1])
    manifests = []

    def add_manifest(mid, description, m, whole=True):
        enc = encode(m)
        assert decode(enc) == m, mid
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

    first = {
        "l1ChainId": SEPOLIA,
        "anchor": ANCHOR,
        "sequence": 0,
        "objects": [obj_entry("segment-0")],
        "links": [],
    }
    first_enc = add_manifest("first", "The first manifest: one segment object, no links", first)
    period = {
        "l1ChainId": SEPOLIA,
        "anchor": ANCHOR,
        "sequence": 3,
        "objects": sorted_objects(
            [obj_entry("segment-a"), obj_entry("hashes-a"), obj_entry("segment-b", 0x70), obj_entry("hashes-b")]
        ),
        "links": [link_entry(0), link_entry(2)],
    }
    add_manifest(
        "period",
        "Sequence 3: two elections' objects (one dag-pb), linking manifests 0 and 2, which confirmed after 1 was linked",
        period,
    )
    closing = {
        "l1ChainId": SEPOLIA,
        "anchor": ANCHOR,
        "sequence": U64_MAX,
        "objects": [],
        "links": [link_entry(U64_MAX - 1)],
    }
    add_manifest("closing", "A closing manifest that only links a straggler, at the largest sequence", closing)
    full = full_manifest()
    full_enc = add_manifest(
        "full",
        "Both lists full: 8192 objects (odd i dag-pb) and 1024 links, the largest manifest",
        full,
        whole=False,
    )
    assert len(full_enc) == 634_927

    # Decode rejections, each with its code and offset.
    rejections = []

    def reject(rid, description, b, code, offset):
        try:
            decode(b)
        except Reject as e:
            assert (e.code, e.offset) == (code, offset), (rid, e.code, e.offset)
        else:
            raise AssertionError(rid)
        rejections.append({"id": rid, "description": description, "encoding": b.hex(), "code": code, "offset": offset})

    p = encode(period)
    objects_at = 3 + 36
    first_object = objects_at + 4
    links_at = first_object + 4 * 68
    first_link = links_at + 4
    reject("truncated", "Cut inside the last link", p[:-1], "truncated", len(p) - 32)
    reject("trailing-bytes", "One byte after the last link", p + b"\x00", "trailing-bytes", len(p))
    reject("version-2", "Version 2, which a version-1 locator never names", encode(period, version=2), "profile-mismatch", 2)
    over = bytearray(first_enc)
    over[objects_at : objects_at + 4] = u32(MAX_OBJECTS + 1)
    reject("objects-over-max", "8193 objects", bytes(over), "length-over-max", objects_at)
    links_over = encode({**first, "sequence": 5}) [:-4] + u32(MAX_LINKS + 1)
    reject("links-over-max", "1025 links", links_over, "length-over-max", len(links_over) - 4)
    for name, i, value in [("cid-version", 0, 0x00), ("cid-codec", 1, 0x71), ("cid-hash", 2, 0x13), ("cid-length", 3, 0x1F)]:
        b = bytearray(p)
        b[first_object + i] = value
        reject(f"object-{name}", f"The first object's CID with byte {i} = {value:#04x}", bytes(b), "non-canonical", first_object)
    swapped = {**period, "objects": [period["objects"][1], period["objects"][0], *period["objects"][2:]]}
    reject("objects-order", "The first two objects swapped", encode(swapped), "non-canonical", first_object + 68)
    dup = {**period, "objects": [period["objects"][0], *period["objects"]][:4]}
    reject("objects-repeated", "The first object listed twice", encode(dup), "non-canonical", first_object + 68)
    pb_link = {**period, "links": [{**link_entry(0), "cid": pb_cid("manifest/0")}, link_entry(2)]}
    reject("link-cid-dag-pb", "A link to a dag-pb CID: a manifest is one raw block", encode(pb_link), "non-canonical", first_link + 8)
    reject("link-own-sequence", "A link to its own sequence", encode({**period, "links": [link_entry(3)]}), "non-canonical", first_link)
    reject("link-later", "A link to a later sequence", encode({**period, "links": [link_entry(0), link_entry(4)]}), "non-canonical", first_link + 76)
    reject("links-order", "Links in descending order", encode({**period, "links": [link_entry(2), link_entry(0)]}), "non-canonical", first_link + 76)
    reject("links-repeated", "One sequence linked twice", encode({**period, "links": [link_entry(2), link_entry(2)]}), "non-canonical", first_link + 76)
    reject("first-links", "Sequence 0 with a link", encode({**first, "links": [link_entry(0)]}), "non-canonical", objects_at + 4 + 68 + 4)
    reject("empty", "No objects and no links", encode({**first, "objects": []}), "non-canonical", objects_at)

    # Locators.
    locators = []

    def add_locator(lid, description, b):
        locators.append({"id": lid, "description": description, "locator": b.hex(), "result": read_locator(b)})

    first_cid = raw_cid(first_enc)
    first_tx = label32("tx/manifest/0")
    good = locator(first_cid, first_tx)
    assert len(good) == LOCATOR_V1_LENGTH
    add_locator("v1", "Version 1 naming the first manifest", good)
    add_locator("v1-short", "Version 1 one byte short", good[:-1])
    add_locator("v1-long", "Version 1 one byte long", good + b"\x00")
    add_locator("v1-dag-pb", "Version 1 naming a dag-pb CID", u16(1) + pb_cid("manifest/0") + first_tx)
    add_locator("v1-cid-version", "Version 1 whose CID starts 0x00", u16(1) + b"\x00" + first_cid[1:] + first_tx)
    add_locator("v2", "Version 2, reserved: reported, never guessed", u16(2) + first_cid + first_tx)
    add_locator("v65535", "Version 0xffff at the anchor's largest length", u16(0xFFFF) + bytes(126))
    add_locator("v0", "Version 0, which the anchor refuses", u16(0) + first_cid + first_tx)
    add_locator("header-only", "Two bytes, no body", u16(1))
    add_locator("over-128", "129 bytes", u16(2) + bytes(127))

    # Reading objects from transaction data.
    reads = []

    def obj_bytes(label, length):
        return ca.obj(label, length)

    def add_read(rid, description, data, root, bound, recipe):
        result = read_archived(data, root, bound)
        v = {"id": rid, "description": description, "cid": root.hex(), "maxLength": bound, "result": result}
        if len(data) <= 4096:
            v["data"] = data.hex()
        else:
            v["recipe"] = recipe
            v["sha256"] = sha256(data).hex()
            v["length"] = len(data)
        reads.append(v)

    small = obj_bytes("archive/small", 100)
    small_car, small_root = object_car(small)
    add_read("small", "A 100-byte object's CAR", small_car, small_root, CHUNK, None)
    add_read("small-at-bound", "Read within exactly its length", small_car, small_root, 100, None)
    add_read("small-over-bound", "Read within 99 bytes", small_car, small_root, 99, None)
    other = obj_bytes("archive/other", 100)
    other_car, other_root = object_car(other)
    add_read("other-cid", "Another object's CAR for this CID", other_car, small_root, CHUNK, None)
    add_read("trailing-byte", "A zero byte after the block", small_car + b"\x00", small_root, CHUNK, None)
    hdr = len(car_header(small_root))
    block = small_car[hdr:]
    add_read("block-repeated", "The block twice", small_car + block, small_root, CHUNK, None)
    padded = small_car[:hdr] + bytes([block[0] | 0x80, 0x00]) + block[1:]
    add_read("varint-non-minimal", "The block's length as a two-byte varint", padded, small_root, CHUNK, None)
    add_read("header-only", "The header and no block", small_car[:hdr], small_root, CHUNK, None)
    add_read("cut", "The block cut short", small_car[:-1], small_root, CHUNK, None)
    tampered = bytearray(small_car)
    tampered[-1] ^= 1
    add_read("block-flipped", "The block's last byte flipped", bytes(tampered), small_root, CHUNK, None)
    add_read("extra-block", "Another object's block after this one", small_car + other_car[hdr:], small_root, CHUNK, None)
    add_read("manifest", "The first manifest's CAR, read within one chunk", object_car(first_enc)[0], first_cid, CHUNK, None)

    big = obj_bytes("archive/big", CHUNK + 1)
    big_car, big_root = object_car(big)
    assert big_root[1] == 0x70
    add_read("two-chunks", "A 1 MiB + 1 byte object: a dag-pb root and two raw leaves", big_car, big_root, 2 * CHUNK, {"object": "big", "mutation": "none"})
    add_read("two-chunks-over-bound", "Read within one chunk: over-bound before any leaf", big_car, big_root, CHUNK, {"object": "big", "mutation": "none"})
    big_hdr = len(car_header(big_root))
    parts = []
    at = big_hdr
    while at < len(big_car):
        n, nxt = minimal_varint(big_car, at)
        parts.append(big_car[at : nxt + n])
        at = nxt + n
    assert len(parts) == 3
    root_part, leaf1, leaf2 = parts
    add_read("leaves-swapped", "The two leaves in the other order", big_car[:big_hdr] + root_part + leaf2 + leaf1, big_root, 2 * CHUNK, {"object": "big", "mutation": "leaves-swapped"})
    add_read("leaf-missing", "The second leaf left out", big_car[:big_hdr] + root_part + leaf1, big_root, 2 * CHUNK, {"object": "big", "mutation": "leaf-missing"})

    expected = {
        "small": True, "small-at-bound": True, "manifest": True, "two-chunks": True,
        "small-over-bound": "over-bound", "two-chunks-over-bound": "over-bound",
    }
    for r in reads:
        want = expected.get(r["id"], "inconsistent")
        got = True if r["result"]["ok"] else r["result"]["reason"]
        assert got == want, (r["id"], got)

    doc = {
        "format": "abolish-archive-vectors/1",
        "title": "Archive manifests, locators and objects read from Arweave transaction data",
        "spec": "docs/spec/archive.md",
        "generator": "packages/crypto/scripts/archive-vectors.py: an independent Python implementation (standard library only) of docs/spec/archive.md, with release-record-vectors.py's DAGs and CARs from docs/spec/content-addressing.md",
        "recordType": "0x0021",
        "version": VERSION,
        "maxObjects": MAX_OBJECTS,
        "maxLinks": MAX_LINKS,
        "locatorLength": LOCATOR_V1_LENGTH,
        "rules": {
            "labels": "label32(x) = SHA-256(\"archive/\" + x); a fake raw CID is 01551220 ‖ label32(\"object/\" + x) or label32(\"manifest/\" + s), a dag-pb one 01701220 ‖ label32(\"object/\" + x), a transaction label32(\"tx/\" + x)",
            "full": "l1ChainId 11155111, the anchor above, sequence 1024; objects for i = 0 .. 8191 with label \"full-\" + i, dag-pb when i is odd, sorted by CID; links for s = 0 .. 1023",
            "objects": "an object (label, length) is SHA-256(label ‖ u32be(i)) for i = 0, 1, ..., concatenated and cut to length; \"big\" is (\"archive/big\", 1048577)",
            "mutations": "none: the object's CAR; leaves-swapped: its root block, then the second leaf, then the first; leaf-missing: its root block and the first leaf",
        },
        "manifests": manifests,
        "decode": rejections,
        "locators": locators,
        "reads": reads,
    }
    (out_dir / "archive.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
