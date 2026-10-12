#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/receipt.json.

A second implementation of docs/spec/receipts.md: the receipt record, its
signed statement and the checks at cast. It is written from the spec with
Python's standard library only and shares no code with packages/crypto. The
board's entries, chain and RFC 9162 tree are board-vectors.py's, which checks
itself against transparency-dev's RFC 6962 vectors before use; P-256 ECDSA is
trustee-vectors.py's, which reproduces RFC 6979 Appendix A.2.5 first.

Usage: python3 -I -B packages/crypto/scripts/receipt-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import hashlib
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


board = load("board_vectors", "board-vectors.py")
ecdsa = load("trustee_vectors", "trustee-vectors.py")

RECEIPT = 0x0004
TAG = b"abolish/v1/sig/receipt"
MAX_PATH = 64


def sha256(b):
    return hashlib.sha256(b).digest()


def u(width, x):
    return x.to_bytes(width, "big")


def statement(election_id, index, segment, entry_hash, link, root, key):
    m = election_id + u(8, index) + u(4, segment) + entry_hash + link + root + key
    assert len(m) == 173
    return m


def encode(election_id, index, segment, entry_hash, link, root, key, sig, path, version=1, record_type=RECEIPT):
    return (
        u(2, record_type)
        + u(1, version)
        + statement(election_id, index, segment, entry_hash, link, root, key)
        + sig
        + u(4, len(path))
        + b"".join(path)
    )


def canonical_sig(b):
    r, s = int.from_bytes(b[:32], "big"), int.from_bytes(b[32:], "big")
    return 1 <= r < ecdsa.N and 1 <= s <= ecdsa.HALF_N


def decode(b):
    """Strict decoding per notation.md; a dict, or (error code, offset)."""
    if len(b) < 2:
        return ("truncated", 0)
    if int.from_bytes(b[0:2], "big") != RECEIPT:
        return ("unknown-record-type", 0)
    if len(b) < 3:
        return ("truncated", 2)
    # The release pins version 1, and the pin is checked before the version is
    # looked up (notation.md), so any other version is profile-mismatch.
    if b[2] != 1:
        return ("profile-mismatch", 2)
    at = 3
    fields = {}
    for name, width in [("electionId", 32), ("index", 8), ("segment", 4), ("entryHash", 32), ("link", 32), ("root", 32)]:
        if len(b) < at + width:
            return ("truncated", at)
        v = b[at : at + width]
        fields[name] = int.from_bytes(v, "big") if name in ("index", "segment") else v
        at += width
    if len(b) < at + 33:
        return ("truncated", at)
    if ecdsa.decompress(b[at : at + 33]) is None:
        return ("non-canonical", at)
    fields["operatorKey"] = b[at : at + 33]
    at += 33
    if len(b) < at + 64:
        return ("truncated", at)
    if not canonical_sig(b[at : at + 64]):
        return ("non-canonical", at)
    fields["signature"] = b[at : at + 64]
    at += 64
    if len(b) < at + 4:
        return ("truncated", at)
    count = int.from_bytes(b[at : at + 4], "big")
    if count > MAX_PATH:
        return ("length-over-max", at)
    at += 4
    path = []
    for _ in range(count):
        if len(b) < at + 32:
            return ("truncated", at)
        path.append(b[at : at + 32])
        at += 32
    fields["inclusion"] = path
    if len(b) != at:
        return ("trailing-bytes", at)
    return fields


def stmt_of(f):
    return statement(f["electionId"], f["index"], f["segment"], f["entryHash"], f["link"], f["root"], f["operatorKey"])


def sign(d, election_id, index, segment, entry_hash, link, root, path, tag=TAG):
    key = ecdsa.compress(ecdsa.mul(d, ecdsa.G))
    m = statement(election_id, index, segment, entry_hash, link, root, key)
    _k, r, s = ecdsa.ecdsa_sign(d, ecdsa.ds(tag, m))
    return encode(election_id, index, segment, entry_hash, link, root, key, ecdsa.sig_bytes(r, s), path)


def check_at_cast(b, election_id, payload, keys, seg_min, seg_max):
    f = decode(b)
    if isinstance(f, tuple):
        return {"code": "decode", "decodeError": f[0], "offset": f[1]}
    if f["operatorKey"] not in keys:
        return {"code": "receipt-key"}
    if not ecdsa.verify(f["operatorKey"], ecdsa.ds(TAG, stmt_of(f)), f["signature"]):
        return {"code": "receipt-signature"}
    if f["electionId"] != election_id:
        return {"code": "receipt-election"}
    if not seg_min <= f["segment"] <= seg_max:
        return {"code": "receipt-segment"}
    try:
        e = board.entry(election_id, f["index"], f["segment"], payload)
    except OverflowError:
        return {"code": "receipt-entry"}
    if board.decode_entry(e) != {"electionId": election_id, "index": f["index"], "segment": f["segment"], "payload": payload}:
        return {"code": "receipt-entry"}
    if board.entry_hash(e) != f["entryHash"]:
        return {"code": "receipt-entry"}
    n = f["index"] + 1
    if n >= 2**64 or not board.BOARD.verify_inclusion(f["index"], n, f["entryHash"], f["inclusion"], f["root"]):
        return {"code": "receipt-inclusion"}
    return {"ok": True}


def ballot(label):
    # A ballot-typed payload with placeholder contents: the receipt treats
    # the payload as bytes, and P1-12 defines the ballot itself.
    return u(2, 0x0002) + u(1, 1) + sha256(b"receipt test ballot " + label)


def make_board(election_id, payloads, segments):
    return [board.entry(election_id, i, s, p) for i, (p, s) in enumerate(zip(payloads, segments))]

def main(out_dir):
    ecdsa.self_check()
    board.self_check(HERE.parents[1] / "test-vectors" / "transparency-dev")
    h = lambda b: b.hex()

    E = sha256(b"abolish receipt test election")
    E2 = sha256(b"abolish receipt test election 2")
    operator = ecdsa.secret(b"receipt operator")
    rotated = ecdsa.secret(b"receipt operator 2")
    stranger = ecdsa.secret(b"receipt stranger")
    key = lambda d: ecdsa.compress(ecdsa.mul(d, ecdsa.G))
    pinned = [key(operator), key(rotated)]

    payloads = [ballot(bytes([i])) for i in range(7)]
    segments = [0, 0, 1, 1, 1, 3, 4]
    honest = make_board(E, payloads, segments)
    hashes = [board.entry_hash(e) for e in honest]
    links = board.chain_links(honest)

    def receipt_for(i, d=operator, entries=honest, election_id=E, tag=TAG):
        hs = [board.entry_hash(e) for e in entries[: i + 1]]
        ls = board.chain_links(entries[: i + 1])
        seg = board.decode_entry(entries[i])["segment"]
        return sign(d, election_id, i, seg, hs[i], ls[i], board.BOARD.mth(hs), board.BOARD.path(i, hs), tag)

    # Receipts.
    receipts = {}
    receipt_vectors = []
    for i in range(7):
        b = receipt_for(i, rotated if i == 5 else operator)
        receipts[f"receipt-{i}"] = b
        f = decode(b)
        assert f["inclusion"] == board.BOARD.path(i, hashes[: i + 1])
        assert f["link"] == links[i] and f["entryHash"] == hashes[i]
        receipt_vectors.append(
            {
                "id": f"receipt-{i}",
                "secretKey": f"{rotated if i == 5 else operator:064x}",
                "electionId": h(f["electionId"]),
                "index": str(f["index"]),
                "segment": f["segment"],
                "entryHash": h(f["entryHash"]),
                "link": h(f["link"]),
                "root": h(f["root"]),
                "operatorKey": h(f["operatorKey"]),
                "signature": h(f["signature"]),
                "inclusion": [h(x) for x in f["inclusion"]],
                "statement": h(stmt_of(f)),
                "encoding": h(b),
                # A fixed salt per vector; clients draw theirs from a CSPRNG.
            }
        )

    # Rejected encodings.
    good = receipts["receipt-3"]
    f3 = decode(good)
    sig_at = 3 + 173
    key_at = 3 + 140
    r3, s3 = int.from_bytes(f3["signature"][:32], "big"), int.from_bytes(f3["signature"][32:], "big")
    high_s = good[:sig_at] + ecdsa.sig_bytes(r3, ecdsa.N - s3) + good[sig_at + 64 :]
    g_x = ecdsa.G[0].to_bytes(32, "big")
    count_at = sig_at + 64
    rejected = [
        ("decode-empty", b"", ("truncated", 0)),
        ("decode-board-entry-type", u(2, 0x0007) + good[2:], ("unknown-record-type", 0)),
        ("decode-version-2", good[:2] + b"\x02" + good[3:], ("profile-mismatch", 2)),
        ("decode-truncated-in-link", good[:100], ("truncated", 79)),
        ("decode-key-uncompressed-prefix", good[:key_at] + b"\x04" + g_x + good[key_at + 33 :], ("non-canonical", key_at)),
        ("decode-key-identity", good[:key_at] + bytes(33) + good[key_at + 33 :], ("non-canonical", key_at)),
        ("decode-signature-high-s", high_s, ("non-canonical", sig_at)),
        ("decode-signature-r-zero", good[:sig_at] + bytes(32) + good[sig_at + 32 :], ("non-canonical", sig_at)),
        ("decode-inclusion-65", good[:count_at] + u(4, 65) + bytes(32) * 65, ("length-over-max", count_at)),
        ("decode-inclusion-count-past-end", good[:count_at] + u(4, 3) + good[count_at + 4 :], ("truncated", count_at + 4 + 64)),
        ("decode-trailing-byte", good + b"\x00", ("trailing-bytes", len(good))),
    ]
    decode_vectors = []
    for vid, b, err in rejected:
        assert decode(b) == err, (vid, decode(b))
        decode_vectors.append({"id": vid, "encoding": h(b), "error": err[0], "offset": err[1]})

    # Checks at cast.
    def tamper(b, at, value):
        return b[:at] + value + b[at + len(value) :]

    flipped_path = list(f3["inclusion"])
    flipped_path[0] = bytes([flipped_path[0][0] ^ 1]) + flipped_path[0][1:]
    other_index = tamper(good, 3 + 32, u(8, 4))
    cast_cases = [
        ("cast-ok", good, E, payloads[3], pinned, (1, 1)),
        ("cast-ok-index-0", receipts["receipt-0"], E, payloads[0], pinned, (0, 0)),
        ("cast-ok-rotated-key", receipts["receipt-5"], E, payloads[5], pinned, (3, 3)),
        ("cast-ok-segment-window", good, E, payloads[3], pinned, (0, 2)),
        ("cast-decode", high_s, E, payloads[3], pinned, (1, 1)),
        ("cast-key-not-pinned", receipt_for(3, stranger), E, payloads[3], pinned, (1, 1)),
        ("cast-key-rotated-out", receipts["receipt-5"], E, payloads[5], pinned[:1], (3, 3)),
        ("cast-signature-other-index", other_index, E, payloads[3], pinned, (1, 1)),
        ("cast-signature-other-tag", receipt_for(3, tag=ecdsa.REGISTRATION_TAG), E, payloads[3], pinned, (1, 1)),
        ("cast-signature-other-key-field", tamper(good, key_at, pinned[1]), E, payloads[3], pinned, (1, 1)),
        ("cast-election", good, E2, payloads[3], pinned, (1, 1)),
        ("cast-segment-before", good, E, payloads[3], pinned, (2, 3)),
        ("cast-segment-after", good, E, payloads[3], pinned, (0, 0)),
        ("cast-entry-other-payload", good, E, payloads[4], pinned, (1, 1)),
        ("cast-entry-unboardable-payload", good, E, u(2, 0x0004) + u(1, 1), pinned, (1, 1)),
        ("cast-inclusion-flipped", encode(*[f3[k] for k in ("electionId", "index", "segment", "entryHash", "link", "root", "operatorKey", "signature")], flipped_path), E, payloads[3], pinned, (1, 1)),
        ("cast-inclusion-empty", encode(*[f3[k] for k in ("electionId", "index", "segment", "entryHash", "link", "root", "operatorKey", "signature")], []), E, payloads[3], pinned, (1, 1)),
        ("cast-inclusion-extra", encode(*[f3[k] for k in ("electionId", "index", "segment", "entryHash", "link", "root", "operatorKey", "signature")], f3["inclusion"] + [bytes(32)]), E, payloads[3], pinned, (1, 1)),
        ("cast-inclusion-max-index", sign(operator, E, 2**64 - 1, 1, board.entry_hash(board.entry(E, 2**64 - 1, 1, payloads[3])), links[3], hashes[3], []), E, payloads[3], pinned, (1, 1)),
    ]
    cast_vectors = []
    for vid, b, eid, payload, keys, (lo, hi) in cast_cases:
        result = check_at_cast(b, eid, payload, keys, lo, hi)
        cast_vectors.append(
            {
                "id": vid,
                "receipt": h(b),
                "electionId": h(eid),
                "payload": h(payload),
                "receiptKeys": [h(k) for k in keys],
                "segments": {"min": lo, "max": hi},
                **({"ok": True} if result.get("ok") else result),
            }
        )
    expected = {
        "cast-ok": True,
        "cast-ok-index-0": True,
        "cast-ok-rotated-key": True,
        "cast-ok-segment-window": True,
        "cast-decode": "decode",
        "cast-key-not-pinned": "receipt-key",
        "cast-key-rotated-out": "receipt-key",
        "cast-signature-other-index": "receipt-signature",
        "cast-signature-other-tag": "receipt-signature",
        "cast-signature-other-key-field": "receipt-signature",
        "cast-election": "receipt-election",
        "cast-segment-before": "receipt-segment",
        "cast-segment-after": "receipt-segment",
        "cast-entry-other-payload": "receipt-entry",
        "cast-entry-unboardable-payload": "receipt-entry",
        "cast-inclusion-flipped": "receipt-inclusion",
        "cast-inclusion-empty": "receipt-inclusion",
        "cast-inclusion-extra": "receipt-inclusion",
        "cast-inclusion-max-index": "receipt-inclusion",
    }
    for v in cast_vectors:
        assert v.get("ok", v.get("code")) == expected[v["id"]], v["id"]

    out = {
        "format": "abolish-receipt-vectors/1",
        "title": "Receipts: the record, its signed statement and the checks at cast",
        "spec": "docs/spec/receipts.md",
        "generator": (
            "packages/crypto/scripts/receipt-vectors.py: an independent Python implementation (standard library only), "
            "with board-vectors.py's self-checked entries, chain and RFC 9162 tree and trustee-vectors.py's P-256 "
            "ECDSA, which reproduces RFC 6979 Appendix A.2.5 first"
        ),
        "tag": TAG.decode(),
        "electionId": h(E),
        "receiptKeys": [h(k) for k in pinned],
        "payloads": [h(p) for p in payloads],
        "receipts": receipt_vectors,
        "decodeErrors": decode_vectors,
        "atCast": cast_vectors,
    }
    path = pathlib.Path(out_dir) / "receipt.json"
    path.write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
