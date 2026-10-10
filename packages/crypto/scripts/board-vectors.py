#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/board.json.

A second implementation of docs/spec/board.md: the board-entry envelope, the
entry hash, the RFC 9162 Merkle tree with tagged hashes, its inclusion and
consistency proofs, checkpoints and the board checks. It is written from the
spec and RFC 9162 with Python's hashlib only, and shares no code with
packages/crypto, so the vectors it prints check that code instead of restating
it (docs/spec/vectors/README.md, Rules). Before printing anything it checks
its tree, run with RFC 6962's hashes, against the vendored transparency-dev
vectors (packages/crypto/test-vectors/transparency-dev/).

Usage: python3 -I packages/crypto/scripts/board-vectors.py <out-dir>
"""

import hashlib
import json
import pathlib
import re
import sys

MAX_BOARD_PAYLOAD = 1048576
BOARD_ENTRY = 0x0007
PAYLOAD_TYPES = (0x0002, 0x0003, 0x0005, 0x0006, 0x0008)
OPENING = 0x0003


def sha256(b):
    return hashlib.sha256(b).digest()


def ds(tag, m):
    t = tag.encode("ascii")
    return bytes([len(t)]) + t + m


def tagged(tag):
    return lambda m: sha256(ds(tag, m))


class Tree:
    """RFC 9162 Section 2.1 over a leaf hash and a node hash."""

    def __init__(self, leaf, node):
        self.leaf = leaf
        self.node = node

    def mth(self, d):
        n = len(d)
        if n == 1:
            return self.leaf(d[0])
        k = 1
        while k * 2 < n:
            k *= 2
        return self.node(self.mth(d[:k]) + self.mth(d[k:]))

    def path(self, m, d):
        """PATH(m, D[n]), Section 2.1.3.1."""
        n = len(d)
        if n == 1:
            return []
        k = 1
        while k * 2 < n:
            k *= 2
        if m < k:
            return self.path(m, d[:k]) + [self.mth(d[k:])]
        return self.path(m - k, d[k:]) + [self.mth(d[:k])]

    def subproof(self, m, d, b):
        """SUBPROOF(m, D[n], b), Section 2.1.4.1."""
        n = len(d)
        if m == n:
            return [] if b else [self.mth(d)]
        k = 1
        while k * 2 < n:
            k *= 2
        if m <= k:
            return self.subproof(m, d[:k], b) + [self.mth(d[k:])]
        return self.subproof(m - k, d[k:], False) + [self.mth(d[:k])]

    def proof(self, m, d):
        return [] if m == len(d) else self.subproof(m, d, True)

    def verify_inclusion(self, i, n, leaf_data, path, root):
        """Section 2.1.3.2."""
        if i >= n:
            return False
        fn, sn = i, n - 1
        r = self.leaf(leaf_data)
        for p in path:
            if sn == 0:
                return False
            if fn & 1 or fn == sn:
                r = self.node(p + r)
                if not fn & 1:
                    while not fn & 1 and fn != 0:
                        fn >>= 1
                        sn >>= 1
            else:
                r = self.node(r + p)
            fn >>= 1
            sn >>= 1
        return sn == 0 and r == root

    def verify_consistency(self, m, n, root_m, root_n, path):
        """Section 2.1.4.2, with m = 0 and m = n handled as docs/spec/board.md says."""
        if m == 0:
            return False
        if m == n:
            return not path and root_m == root_n
        if m > n or not path:
            return False
        path = list(path)
        if m & (m - 1) == 0:
            path = [root_m] + path
        fn, sn = m - 1, n - 1
        while fn & 1:
            fn >>= 1
            sn >>= 1
        fr = sr = path[0]
        for c in path[1:]:
            if sn == 0:
                return False
            if fn & 1 or fn == sn:
                fr = self.node(c + fr)
                sr = self.node(c + sr)
                if not fn & 1:
                    while not fn & 1 and fn != 0:
                        fn >>= 1
                        sn >>= 1
            else:
                sr = self.node(sr + c)
            fn >>= 1
            sn >>= 1
        return fr == root_m and sr == root_n and sn == 0


RFC6962 = Tree(lambda d: sha256(b"\x00" + d), lambda lr: sha256(b"\x01" + lr))
BOARD = Tree(tagged("abolish/v1/merkle/leaf"), tagged("abolish/v1/merkle/node"))


def go_hex_list(text, start, end):
    body = text[text.index(start) : text.index(end, text.index(start))]
    return re.findall(r'(?:hd|dh)\("([0-9a-f]*)"', body)


def self_check(vectors_dir):
    """RFC 6962 hashing, against transparency-dev/merkle v0.0.2."""
    consts = (vectors_dir / "constants.go").read_text()
    verify = (vectors_dir / "verify_test.go").read_text()
    leaves = [bytes.fromhex(h) for h in go_hex_list(consts, "func LeafInputs", "\n}\n")]
    # RootHashes() starts with EmptyRootHash(), the hash of the empty string.
    empty = go_hex_list(consts, "func EmptyRootHash", "\n}\n")
    roots = [bytes.fromhex(h) for h in empty + go_hex_list(consts, "func RootHashes", "\n}\n")]
    assert len(leaves) == 8 and len(roots) == 9, (len(leaves), len(roots))
    assert roots[0] == sha256(b"")
    for n in range(1, 9):
        assert RFC6962.mth(leaves[:n]) == roots[n], n
    checked = 0
    for kind in ("inclusionProofs", "consistencyProofs"):
        start = verify.index(f"\t{kind} = ")
        block = verify[start : verify.index("\n\t}\n", start)]
        for a, b, body in re.findall(r"\{(\d+), (\d+), (nil|\[\]\[\]byte\{.*?\n\t\t\})\}", block, re.S):
            a, b = int(a), int(b)
            path = [bytes.fromhex(h) for h in re.findall(r'dh\("([0-9a-f]+)"', body)]
            if kind == "inclusionProofs":
                if a == 0:
                    continue  # the empty tree: no leaf to prove
                assert RFC6962.path(a - 1, leaves[:b]) == path, (a, b)
                assert RFC6962.verify_inclusion(a - 1, b, leaves[a - 1], path, roots[b])
            else:
                assert RFC6962.proof(a, leaves[:b]) == path, (a, b)
                assert RFC6962.verify_consistency(a, b, roots[a], roots[b], path)
            checked += 1
    assert checked == 10, checked
    # Every pair over the 8 leaves, both ways round, and tampered proofs.
    for n in range(1, 9):
        for i in range(n):
            p = RFC6962.path(i, leaves[:n])
            assert RFC6962.verify_inclusion(i, n, leaves[i], p, roots[n])
            assert not RFC6962.verify_inclusion(i, n, leaves[i] + b"x", p, roots[n])
        for m in range(1, n + 1):
            p = RFC6962.proof(m, leaves[:n])
            assert RFC6962.verify_consistency(m, n, roots[m], roots[n], p)
            if p:
                assert not RFC6962.verify_consistency(m, n, roots[m], roots[n], p[:-1])
                assert not RFC6962.verify_consistency(m, n, roots[m], roots[n], p + [p[0]])


def u(width, x):
    return x.to_bytes(width, "big")


def entry(election_id, index, segment, payload):
    return u(2, BOARD_ENTRY) + u(1, 1) + election_id + u(8, index) + u(4, segment) + u(4, len(payload)) + payload


def decode_entry(b):
    """Strict decoding per docs/spec/notation.md and board.md; returns a dict or an error code."""
    if len(b) < 2:
        return "truncated"
    if int.from_bytes(b[0:2], "big") != BOARD_ENTRY:
        return "unknown-record-type"
    if len(b) < 3:
        return "truncated"
    if b[2] != 1:
        return "unknown-version"
    if len(b) < 3 + 32 + 8 + 4 + 4:
        return "truncated"
    n = int.from_bytes(b[47:51], "big")
    if n > MAX_BOARD_PAYLOAD:
        return "length-over-max"
    if len(b) < 51 + n:
        return "truncated"
    payload = b[51 : 51 + n]
    if n < 3:
        return "truncated"
    if int.from_bytes(payload[0:2], "big") not in PAYLOAD_TYPES:
        return "unexpected-record-type"
    if len(b) != 51 + n:
        return "trailing-bytes"
    return {
        "electionId": b[3:35],
        "index": int.from_bytes(b[35:43], "big"),
        "segment": int.from_bytes(b[43:47], "big"),
        "payload": payload,
    }


def entry_hash(b):
    return tagged("abolish/v1/board-entry")(b)


def chain_links(entries):
    """link_i = H(DS(board-chain, link_{i-1} || entry_hash_i)), from 32 zero bytes."""
    links = []
    prev = bytes(32)
    for b in entries:
        prev = tagged("abolish/v1/board-chain")(prev + entry_hash(b))
        links.append(prev)
    return links


def checkpoint_hash(election_id, segment, size, head, root):
    return tagged("abolish/v1/board-checkpoint")(election_id + u(4, segment) + u(8, size) + head + root)


def check_board(election_id, entries, checkpoints):
    """docs/spec/board.md, Board checks. Returns None or (code, where)."""
    decoded = []
    for i, b in enumerate(entries):
        e = decode_entry(b)
        if isinstance(e, str):
            return ("decode", {"entry": i, "decodeError": e})
        if e["electionId"] != election_id:
            return ("wrong-election", {"entry": i})
        if e["index"] != i:
            return ("wrong-index", {"entry": i})
        if decoded and e["segment"] < decoded[-1]["segment"]:
            return ("segment-decreased", {"entry": i})
        if decoded and decoded[-1]["segment"] == e["segment"]:
            prev = decoded[-1]["payload"]
            prev_open = int.from_bytes(prev[0:2], "big") == OPENING
            this_open = int.from_bytes(e["payload"][0:2], "big") == OPENING
            if prev_open and (not this_open or not prev < e["payload"]):
                return ("opening-order", {"entry": i})
        decoded.append(e)
    hashes = [entry_hash(b) for b in entries]
    links = chain_links(entries)
    anchored = set()
    for j, (cid, seg, size, head, root) in enumerate(checkpoints):
        if cid != election_id:
            return ("wrong-election", {"checkpoint": j})
        if size == 0:
            return ("checkpoint-size", {"checkpoint": j})
        if size > len(entries):
            return ("checkpoint-missing", {"checkpoint": j})
        if decoded[size - 1]["segment"] > seg or (size < len(entries) and decoded[size]["segment"] <= seg):
            return ("checkpoint-boundary", {"checkpoint": j})
        if links[size - 1] != head:
            return ("checkpoint-head", {"checkpoint": j})
        if BOARD.mth(hashes[:size]) != root:
            return ("checkpoint-root", {"checkpoint": j})
        anchored.add(seg)
    for e in decoded:
        if e["segment"] not in anchored:
            return ("unanchored", {"segment": e["segment"]})
    return None


def h(b):
    return b.hex()


def payload(record_type, body):
    return u(2, record_type) + u(1, 1) + body


def main(out_dir):
    here = pathlib.Path(__file__).resolve().parent
    self_check(here.parent / "test-vectors" / "transparency-dev")

    eid = sha256(b"abolish board vectors: election A")
    other = sha256(b"abolish board vectors: election B")

    # --- Envelope codec vectors.
    entry_vectors = []

    def valid(id_, description, e):
        d = decode_entry(e)
        assert isinstance(d, dict), (id_, d)
        entry_vectors.append(
            {
                "id": id_,
                "description": description,
                "encoding": h(e),
                "value": {
                    "election_id": h(d["electionId"]),
                    "index": str(d["index"]),
                    "segment": str(d["segment"]),
                    "payload": h(d["payload"]),
                },
                "entryHash": h(entry_hash(e)),
            }
        )

    def invalid(id_, description, e, error):
        assert decode_entry(e) == error, (id_, decode_entry(e), error)
        entry_vectors.append({"id": id_, "description": description, "encoding": h(e), "error": error})

    for t, name in zip(PAYLOAD_TYPES, ("ballot", "opening", "ceremony", "tally", "event")):
        valid(f"payload-{name}", f"A payload of record type 0x{t:04x}", entry(eid, 3, 7, payload(t, b"\xaa\xbb")))
    valid("payload-header-only", "The shortest payload: a bare record header", entry(eid, 0, 0, payload(0x0002, b"")))
    valid(
        "max-index-and-segment",
        "index = 2^64 - 1 and segment = 2^32 - 1",
        entry(b"\xff" * 32, 2**64 - 1, 2**32 - 1, payload(0x0006, b"\x00")),
    )
    valid(
        "payload-unknown-version",
        "The envelope reads only the payload's type; its version is checked when the record is used",
        entry(eid, 1, 0, u(2, 0x0002) + b"\xff" + b"\x01"),
    )
    base = entry(eid, 1, 0, payload(0x0002, b"\x01\x02"))
    invalid("empty", "No bytes at all", b"", "truncated")
    invalid("header-truncated", "Only the record type", base[:2], "truncated")
    invalid("wrong-record-type", "A ballot header where a board entry is expected", u(2, 0x0002) + base[2:], "unknown-record-type")
    invalid("unknown-version", "Version 2 doesn't exist", base[:2] + b"\x02" + base[3:], "unknown-version")
    invalid("fields-truncated", "Ends inside the segment field", base[:45], "truncated")
    invalid("payload-truncated", "The payload length runs past the end", base[:-1], "truncated")
    invalid("trailing-bytes", "A byte after the payload", base + b"\x00", "trailing-bytes")
    invalid(
        "payload-over-max",
        "A payload length of MAX_BOARD_PAYLOAD + 1, rejected before reading it",
        base[:47] + u(4, MAX_BOARD_PAYLOAD + 1),
        "length-over-max",
    )
    invalid("payload-empty", "An empty payload has no record header", entry(eid, 1, 0, b""), "truncated")
    invalid("payload-two-bytes", "A payload shorter than a record header", entry(eid, 1, 0, u(2, 0x0002)), "truncated")
    for t, name in (
        (0x0000, "none"),
        (0x0001, "election-definition"),
        (0x0004, "receipt"),
        (0x0007, "board-entry"),
        (0x0009, "display-text"),
        (0x000A, "unassigned"),
        (0xFF00, "test-range"),
    ):
        invalid(
            f"payload-type-{name}",
            f"Record type 0x{t:04x} isn't allowed on the board",
            entry(eid, 1, 0, payload(t, b"\x00")),
            "unexpected-record-type",
        )

    # --- Tree vectors: every prefix root, every inclusion and consistency proof.
    leaves = [sha256(b"abolish board vectors: leaf " + u(4, i)) for i in range(13)]
    roots = [None] + [BOARD.mth(leaves[:n]) for n in range(1, 14)]
    inclusion = []
    consistency = []
    for n in range(1, 14):
        for i in range(n):
            p = BOARD.path(i, leaves[:n])
            assert BOARD.verify_inclusion(i, n, leaves[i], p, roots[n])
            inclusion.append({"index": str(i), "size": str(n), "path": [h(x) for x in p]})
        for m in range(1, n + 1):
            p = BOARD.proof(m, leaves[:n])
            assert BOARD.verify_consistency(m, n, roots[m], roots[n], p)
            consistency.append({"size1": str(m), "size2": str(n), "path": [h(x) for x in p]})
    leaf0 = leaves[0]
    rejected = [
        {
            "id": "inclusion-index-at-size",
            "kind": "inclusion",
            "index": "5",
            "size": "5",
            "leaf": h(leaves[5]),
            "path": [h(x) for x in BOARD.path(4, leaves[:5])],
            "root": h(roots[5]),
        },
        {
            "id": "inclusion-wrong-leaf",
            "kind": "inclusion",
            "index": "2",
            "size": "7",
            "leaf": h(leaves[3]),
            "path": [h(x) for x in BOARD.path(2, leaves[:7])],
            "root": h(roots[7]),
        },
        {
            "id": "inclusion-extra-hash",
            "kind": "inclusion",
            "index": "0",
            "size": "8",
            "leaf": h(leaf0),
            "path": [h(x) for x in BOARD.path(0, leaves[:8]) + [leaf0]],
            "root": h(roots[8]),
        },
        {
            "id": "inclusion-missing-hash",
            "kind": "inclusion",
            "index": "6",
            "size": "13",
            "leaf": h(leaves[6]),
            "path": [h(x) for x in BOARD.path(6, leaves[:13])[:-1]],
            "root": h(roots[13]),
        },
        {
            "id": "inclusion-rfc6962-hashing",
            "kind": "inclusion",
            "index": "1",
            "size": "3",
            "leaf": h(leaves[1]),
            "path": [h(x) for x in RFC6962.path(1, leaves[:3])],
            "root": h(RFC6962.mth(leaves[:3])),
        },
        {
            "id": "inclusion-index-at-size-minimal",
            "kind": "inclusion",
            "index": "1",
            "size": "1",
            "leaf": h(leaf0),
            "path": [],
            "root": h(BOARD.leaf(leaf0)),
        },
        {
            "id": "consistency-size1-zero-nonempty-path",
            "kind": "consistency",
            "size1": "0",
            "size2": "3",
            "root1": h(roots[3]),
            "root2": h(roots[3]),
            "path": [h(roots[3])],
        },
        {
            "id": "consistency-both-zero",
            "kind": "consistency",
            "size1": "0",
            "size2": "0",
            "root1": h(roots[1]),
            "root2": h(roots[1]),
            "path": [],
        },
        {
            "id": "consistency-equal-sizes-nonempty-path",
            "kind": "consistency",
            "size1": "4",
            "size2": "4",
            "root1": h(roots[4]),
            "root2": h(roots[4]),
            "path": [h(leaf0)],
        },
        {
            "id": "consistency-size1-zero",
            "kind": "consistency",
            "size1": "0",
            "size2": "3",
            "root1": h(roots[3]),
            "root2": h(roots[3]),
            "path": [],
        },
        {
            "id": "consistency-size1-over-size2",
            "kind": "consistency",
            "size1": "6",
            "size2": "5",
            "root1": h(roots[6]),
            "root2": h(roots[5]),
            "path": [h(x) for x in BOARD.proof(5, leaves[:6])],
        },
        {
            "id": "consistency-empty-path",
            "kind": "consistency",
            "size1": "3",
            "size2": "7",
            "root1": h(roots[3]),
            "root2": h(roots[7]),
            "path": [],
        },
        {
            "id": "consistency-wrong-root2",
            "kind": "consistency",
            "size1": "3",
            "size2": "7",
            "root1": h(roots[3]),
            "root2": h(roots[6]),
            "path": [h(x) for x in BOARD.proof(3, leaves[:7])],
        },
        {
            "id": "consistency-extra-hash",
            "kind": "consistency",
            "size1": "5",
            "size2": "13",
            "root1": h(roots[5]),
            "root2": h(roots[13]),
            "path": [h(x) for x in BOARD.proof(5, leaves[:13]) + [leaf0]],
        },
    ]
    for r in rejected:
        p = [bytes.fromhex(x) for x in r["path"]]
        if r["kind"] == "inclusion":
            ok = BOARD.verify_inclusion(
                int(r["index"]), int(r["size"]), bytes.fromhex(r["leaf"]), p, bytes.fromhex(r["root"])
            )
        else:
            ok = BOARD.verify_consistency(
                int(r["size1"]), int(r["size2"]), bytes.fromhex(r["root1"]), bytes.fromhex(r["root2"]), p
            )
        assert not ok, r["id"]

    # --- Board vectors.
    def ballot(i):
        return payload(0x0002, b"ballot" + u(2, i))

    def opening(tag):
        return payload(OPENING, tag)

    def board_of(spec):
        return [entry(eid, i, seg, p) for i, (seg, p) in enumerate(spec)]

    good = [
        (0, payload(0x0005, b"ceremony")),
        (0, payload(0x0008, b"registration")),
        (1, ballot(1)),
        (1, ballot(2)),
        (1, opening(b"\x01")),
        (1, opening(b"\x01\x00")),
        (1, opening(b"\x02")),
        (4, ballot(3)),
        (6, payload(0x0006, b"tally")),
        (6, opening(b"\x00")),
    ]

    def cps(entries, segments, election=None):
        out = []
        links = chain_links(entries)
        for s in segments:
            size = sum(1 for b in entries if decode_entry(b)["segment"] <= s)
            hashes = [entry_hash(b) for b in entries[:size]]
            out.append((election or eid, s, size, links[size - 1], BOARD.mth(hashes)))
        return out

    board_vectors = []

    def board(id_, description, entries, checkpoints, result):
        got = check_board(eid, entries, checkpoints)
        want = None if result == "ok" else result
        assert got == want, (id_, got, want)
        board_vectors.append(
            {
                "id": id_,
                "description": description,
                "electionId": h(eid),
                "entries": [h(b) for b in entries],
                "checkpoints": [
                    {
                        "electionId": h(c),
                        "segment": str(s),
                        "size": str(n),
                        "head": h(hd),
                        "root": h(r),
                        "hash": h(checkpoint_hash(c, s, n, hd, r)),
                    }
                    for c, s, n, hd, r in checkpoints
                ],
                "result": "ok" if result == "ok" else {"code": result[0], **result[1]},
            }
        )
        if result == "ok":
            board_vectors[-1]["links"] = [h(x) for x in chain_links(entries)]

    g = board_of(good)
    board("valid", "Segments 0, 1, 4 and 6, with openings sorted at the end of segments 1 and 6", g, cps(g, [0, 1, 4, 6]), "ok")
    board(
        "valid-reanchored-and-gaps",
        "Checkpoints for empty periods (2, 3, 5) and a checkpoint repeated",
        g,
        cps(g, [0, 1, 2, 3, 4, 4, 5, 6]),
        "ok",
    )
    board("valid-single-entry", "One entry, one checkpoint", g[:1], cps(g[:1], [0]), "ok")
    board("valid-only-openings", "A segment holding only openings", board_of([(0, opening(b"\x05")), (0, opening(b"\x06"))]), cps(board_of([(0, opening(b"\x05")), (0, opening(b"\x06"))]), [0]), "ok")
    bad = list(g)
    bad[3] = entry(other, 3, 1, ballot(2))
    board("wrong-election", "Entry 3 names another election", bad, [], ("wrong-election", {"entry": 3}))
    bad = list(g)
    bad[3] = entry(eid, 4, 1, ballot(2))
    board("wrong-index", "Entry 3 claims index 4", bad, [], ("wrong-index", {"entry": 3}))
    swapped = list(g)
    swapped[2], swapped[3] = swapped[3], swapped[2]
    board("reordered", "Entries 2 and 3 swapped: their indices no longer match", swapped, [], ("wrong-index", {"entry": 2}))
    dropped = g[:3] + g[4:]
    board("dropped", "Entry 3 dropped", dropped, [], ("wrong-index", {"entry": 3}))
    bad = board_of(good[:7] + [(0, ballot(3))])
    board("segment-decreased", "Segment 0 after segment 1", bad, [], ("segment-decreased", {"entry": 7}))
    bad = board_of(good[:5] + [(1, ballot(9))])
    board("opening-before-ballot", "A ballot after an opening in the same segment", bad, [], ("opening-order", {"entry": 5}))
    bad = board_of(good[:5] + [(1, opening(b"\x00"))])
    board("openings-unsorted", "Openings out of byte order", bad, [], ("opening-order", {"entry": 5}))
    bad = board_of(good[:5] + [(1, opening(b"\x01"))])
    board("opening-duplicate", "The same opening twice in a segment", bad, [], ("opening-order", {"entry": 5}))
    bad = board_of(good[:5] + [(1, opening(b"\x01\x00")), (1, opening(b"\x01"))])
    board("opening-prefix-order", "A payload sorts before every payload it is a prefix of", bad, [], ("opening-order", {"entry": 6}))
    ok_next = board_of(good[:5] + [(2, ballot(9))])
    board("opening-then-next-segment", "A ballot after an opening is fine in a later segment", ok_next, cps(ok_next, [0, 1, 2]), "ok")
    for t, name in ((0x0005, "ceremony"), (0x0008, "event")):
        bad = board_of(good[:5] + [(1, payload(t, b"\xff"))])
        board(f"opening-before-{name}", f"A record of type 0x{t:04x} after an opening in the same segment", bad, [], ("opening-order", {"entry": 5}))
    bad = list(g)
    bad[5] = entry(eid, 5, 1, payload(0x0009, b"text"))
    board("display-text-on-board", "Display text in a payload", bad, [], ("decode", {"entry": 5, "decodeError": "unexpected-record-type"}))
    bad = list(g)
    bad[1] = bad[1] + b"\x00"
    board("entry-trailing-bytes", "An envelope with a trailing byte", bad, [], ("decode", {"entry": 1, "decodeError": "trailing-bytes"}))
    c = cps(g, [0, 1, 4, 6])
    board("checkpoint-other-election", "A checkpoint for another election", g, [c[0], (other,) + c[1][1:]], ("wrong-election", {"checkpoint": 1}))
    board("checkpoint-size-zero", "A checkpoint of an empty board", g, [(eid, 0, 0, bytes(32), bytes(32))] + c, ("checkpoint-size", {"checkpoint": 0}))
    board("checkpoint-missing", "The anchored board is longer than the one held", g[:8], cps(g, [6]), ("checkpoint-missing", {"checkpoint": 0}))
    mid = cps(g, [1])[0]
    board(
        "checkpoint-mid-segment",
        "A checkpoint that ends inside segment 1",
        g,
        [(eid, 1, 3, chain_links(g)[2], BOARD.mth([entry_hash(b) for b in g[:3]]))] + c,
        ("checkpoint-boundary", {"checkpoint": 0}),
    )
    board(
        "checkpoint-segment-too-early",
        "Segment 0's checkpoint claiming segment 1's size",
        g,
        [(eid, 0) + mid[2:]] + c,
        ("checkpoint-boundary", {"checkpoint": 0}),
    )
    seg0 = cps(g, [0])[0]
    board("checkpoint-wrong-head", "A checkpoint with another size's chain head", g, [mid[:3] + (seg0[3], mid[4])] + c, ("checkpoint-head", {"checkpoint": 0}))
    board("checkpoint-wrong-root", "A checkpoint with another size's root", g, [mid[:4] + (seg0[4],)] + c, ("checkpoint-root", {"checkpoint": 0}))
    board(
        "checkpoint-errors-in-order",
        "Checkpoint 0 has a wrong root and checkpoint 1 ends mid-segment: checkpoints are checked one at a time, in order",
        g,
        [mid[:4] + (seg0[4],), (eid, 1, 3, chain_links(g)[2], BOARD.mth([entry_hash(b) for b in g[:3]]))] + c,
        ("checkpoint-root", {"checkpoint": 0}),
    )
    forked = list(g)
    forked[2] = entry(eid, 2, 1, ballot(7))
    board("checkpoint-forked", "The board held differs from the anchored one in entry 2", forked, c, ("checkpoint-head", {"checkpoint": 1}))
    board("unanchored", "Entries after the last checkpoint", g, cps(g, [0, 1, 4]), ("unanchored", {"segment": 6}))
    board("unanchored-skipped-segment", "Segment 1 holds entries but was never anchored", g, cps(g, [0, 4, 6]), ("unanchored", {"segment": 1}))
    board("no-checkpoints", "No anchored checkpoint at all", g, [], ("unanchored", {"segment": 0}))

    out = {
        "format": "abolish-board-vectors/1",
        "title": "Bulletin board: envelope, Merkle tree, proofs, checkpoints and board checks",
        "spec": "docs/spec/board.md",
        "generator": (
            "packages/crypto/scripts/board-vectors.py: an independent Python implementation of docs/spec/board.md "
            "and RFC 9162 Section 2.1 using hashlib only, sharing no code with packages/crypto. Before printing, "
            "it checks its tree with RFC 6962 hashing against the vendored transparency-dev/merkle v0.0.2 vectors "
            "(every root, inclusion proof and consistency proof there), and every vector here is checked by it."
        ),
        "maxBoardPayload": str(MAX_BOARD_PAYLOAD),
        "entries": entry_vectors,
        "tree": {
            "leaves": [h(x) for x in leaves],
            "roots": [h(x) for x in roots[1:]],
            "inclusion": inclusion,
            "consistency": consistency,
            "rejected": rejected,
        },
        "boards": board_vectors,
    }
    path = pathlib.Path(out_dir) / "board.json"
    path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {path}: {len(entry_vectors)} entries, {len(inclusion)} inclusion and "
          f"{len(consistency)} consistency proofs, {len(rejected)} rejected proofs, {len(board_vectors)} boards")


if __name__ == "__main__":
    main(sys.argv[1])
