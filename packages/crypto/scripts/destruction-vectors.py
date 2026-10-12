#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/destruction.json.

A second implementation of docs/spec/tally.md, Destruction: the destruction
statement (record type 0x000f, version 1), its signed message and signature,
its strict decoder, and the verifier's report over every statement on a board
(Destruction checks, verifier 8.5): the destruction segment, each registered
seat's first attributed statement, duplicates, unattributed and stray
statements, and rejected payloads. It is written from the spec with Python's
integers and hashlib; signatures come from trustee-vectors.py's P-256 ECDSA,
which reproduces RFC 6979 Appendix A.2.5 first. Nothing here shares code with
packages/crypto or any @noble library.

Every secret comes from SHA-256 over a fixed label, and each statement lists
the signing secret that made it, so any RFC 6979 implementation reproduces its
bytes. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/destruction-vectors.py <out-dir>
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


ecdsa = _load("trustee_vectors", "trustee-vectors.py")

RECORD_TYPE = 0x000F
VERSION = 1
TAG = b"abolish/v1/sig/destruction"
OPENING_TAG = b"abolish/v1/sig/tally-opening"


def u8(x):
    return bytes([x])


# --- Board entries ---------------------------------------------------------------

BOARD_ENTRY = 0x0007
# docs/spec/board.md, Allowed payloads: version 3 adds share receipts (0x000c) and
# complaints (0x000e) to version 1's set; version 4 adds the destruction statement.
ALLOWED = {1: {0x0002, 0x0003, 0x0005, 0x0006, 0x0008}}
ALLOWED[3] = ALLOWED[1] | {0x000C, 0x000E}
ALLOWED[4] = ALLOWED[3] | {RECORD_TYPE}


def board_entry(version, election_id, index, segment, payload):
    return (
        BOARD_ENTRY.to_bytes(2, "big")
        + u8(version)
        + election_id
        + index.to_bytes(8, "big")
        + segment.to_bytes(4, "big")
        + len(payload).to_bytes(4, "big")
        + payload
    )


def entry_error(b):
    """The board-entry envelope's own check of its payload's type."""
    payload = b[3 + 32 + 8 + 4 + 4 :]
    return None if int.from_bytes(payload[:2], "big") in ALLOWED[b[2]] else "unexpected-record-type"


# --- The record ------------------------------------------------------------------


def message(definition_hash, signer, record_type=RECORD_TYPE, version=VERSION):
    """u16(0x000f) ‖ u8(1) ‖ definition_hash ‖ u8(signer): the record without its signature."""
    assert len(definition_hash) == 32
    return record_type.to_bytes(2, "big") + u8(version) + definition_hash + u8(signer)


def sign(d, m, tag=TAG):
    _, r, s = ecdsa.ecdsa_sign(d, ecdsa.ds(tag, m))
    return ecdsa.sig_bytes(r, s)


def p256_key(d):
    return ecdsa.compress(ecdsa.mul(d, ecdsa.G))


def encode(st, record_type=RECORD_TYPE, version=VERSION):
    return message(st["definitionHash"], st["signer"], record_type, version) + st["signature"]


class Reject(Exception):
    def __init__(self, code, offset):
        super().__init__(code, offset)
        self.code, self.offset = code, offset


def decode(b, pinned=VERSION):
    """docs/spec/notation.md, Strict decoding, for a file whose only known type is 0x000f version 1."""
    at = 0

    def take(n):
        nonlocal at
        if len(b) - at < n:
            raise Reject("truncated", at)
        out = b[at : at + n]
        at += n
        return out

    if int.from_bytes(take(2), "big") != RECORD_TYPE:
        raise Reject("unknown-record-type", 0)
    v_at = at
    if take(1)[0] != pinned:
        raise Reject("profile-mismatch", v_at)
    definition_hash = take(32)
    signer = take(1)[0]
    sig_at = at
    sig = take(64)
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if not (1 <= r < ecdsa.N and 1 <= s <= ecdsa.HALF_N):
        raise Reject("non-canonical", sig_at)
    if at != len(b):
        raise Reject("trailing-bytes", at)
    return {"definitionHash": definition_hash, "signer": signer, "signature": sig}


# --- The report --------------------------------------------------------------------


def attribution(registered, st):
    key = registered.get(st["signer"])
    if key is None:
        return None
    m = message(st["definitionHash"], st["signer"])
    return st["signer"] if ecdsa.verify(key, ecdsa.ds(TAG, m), st["signature"]) else None


def destruction_segment(first_passing, window_segment):
    """min(s_O + 1, s_T), or s_T if some cell has no passing opening."""
    if any(s is None for s in first_passing):
        return window_segment
    return min(max(first_passing) + 1, window_segment)


def check(definition_hash, registered, entries, first_passing, window_segment):
    frm = destruction_segment(first_passing, window_segment)
    first, duplicates, unattributed, stray, rejected = {}, [], [], [], []
    for at, (segment, payload) in enumerate(entries):
        try:
            st = decode(payload)
        except Reject as e:
            rejected.append({"at": at, "error": e.code})
            continue
        seat = attribution(registered, st)
        if st["definitionHash"] != definition_hash:
            stray.append({"at": at, "signer": seat})
        elif seat is None:
            unattributed.append({"at": at})
        elif seat in first:
            duplicates.append({"at": at, "seat": seat})
        else:
            first[seat] = (at, segment)
    seats = []
    for i in sorted(registered):
        if i not in first:
            seats.append({"seat": i, "code": "destruction-missing"})
        else:
            at, segment = first[i]
            seats.append({"seat": i, "code": "destroyed" if segment >= frm else "destruction-early", "at": at})
    return {"from": frm, "seats": seats, "duplicates": duplicates, "unattributed": unattributed, "stray": stray, "rejected": rejected}


# --- Vectors ------------------------------------------------------------------------


def main():
    out = sys.argv[1]
    ecdsa.self_check()

    def secret(label):
        return ecdsa.secret(f"destruction/{label}".encode())

    # Seats 1, 2 and 4 of a panel are registered; seat 3 took part but wasn't
    # qualified, so its per-election key isn't.
    secrets = {i: secret(f"seat-{i}") for i in (1, 2, 3, 4)}
    keys = {i: p256_key(d) for i, d in secrets.items()}
    registered = {i: keys[i] for i in (1, 2, 4)}
    definition_hash = ecdsa.sha256(b"destruction/definition")
    other_definition = ecdsa.sha256(b"destruction/other-definition")

    def statement(signer, d=None, definition=definition_hash, signed_as=None, tag=TAG):
        d = secrets[signer] if d is None else d
        m = message(*(signed_as or (definition, signer)))
        return {"definitionHash": definition, "signer": signer, "signature": sign(d, m, tag)}

    statements = []

    def published(id_, desc, signer, definition=definition_hash):
        st = statement(signer, definition=definition)
        b = encode(st)
        assert decode(b) == st and len(b) == 100
        statements.append(
            {
                "id": id_,
                "description": desc,
                "signingSecret": secrets[signer].to_bytes(32, "big").hex(),
                "signingKey": keys[signer].hex(),
                "definitionHash": definition.hex(),
                "signer": signer,
                "message": message(definition, signer).hex(),
                "signature": st["signature"].hex(),
                "encoding": b.hex(),
            }
        )
        return b

    honest_b = published("seat-1", "Seat 1's statement", 1)
    published("seat-2", "Seat 2's statement", 2)
    published("seat-4-other-election", "Seat 4's key over another definition", 4, other_definition)

    decode_errors = []

    def rejected(id_, desc, b, code, offset):
        try:
            decode(b)
        except Reject as e:
            assert (e.code, e.offset) == (code, offset), (id_, e.code, e.offset)
        else:
            raise AssertionError(id_)
        decode_errors.append({"id": id_, "description": desc, "encoding": b.hex(), "error": code, "offset": offset})

    sig_at = 3 + 32 + 1
    rejected("empty", "No bytes", b"", "truncated", 0)
    rejected("header-only", "A header and nothing else", honest_b[:3], "truncated", 3)
    rejected("tally-opening-type", "Record type 0x0006 where a destruction statement is read", b"\x00\x06" + honest_b[2:], "unknown-record-type", 0)
    rejected("version-2", "Version 2, which tally opening 1 doesn't fix", honest_b[:2] + b"\x02" + honest_b[3:], "profile-mismatch", 2)
    rejected("truncated-before-signer", "The definition hash and nothing after it", honest_b[:sig_at - 1], "truncated", sig_at - 1)
    rejected("truncated-in-signature", "The last byte of the signature missing", honest_b[:-1], "truncated", sig_at)
    rejected("trailing-byte", "One byte after the signature", honest_b + b"\x00", "trailing-bytes", len(honest_b))
    high_s = bytearray(honest_b)
    s_val = int.from_bytes(honest_b[sig_at + 32 :], "big")
    high_s[sig_at + 32 :] = (ecdsa.N - s_val).to_bytes(32, "big")
    rejected("signature-high-s", "The signature's s replaced by n − s", bytes(high_s), "non-canonical", sig_at)
    rejected("signature-r-zero", "The signature's r is 0", honest_b[:sig_at] + bytes(32) + honest_b[sig_at + 32 :], "non-canonical", sig_at)
    r_is_n = honest_b[:sig_at] + ecdsa.N.to_bytes(32, "big") + honest_b[sig_at + 32 :]
    rejected("signature-r-order", "The signature's r is n", r_is_n, "non-canonical", sig_at)

    reports = []

    def report(id_, desc, entries, first_passing, window_segment, expect):
        payloads = [(seg, p if isinstance(p, bytes) else encode(p)) for seg, p in entries]
        got = check(definition_hash, registered, payloads, first_passing, window_segment)
        for key, want in expect.items():
            assert got[key] == want, (id_, key, got[key], want)
        reports.append(
            {
                "id": id_,
                "description": desc,
                "firstPassing": first_passing,
                "windowSegment": window_segment,
                "entries": [{"segment": seg, "payload": p.hex()} for seg, p in payloads],
                "result": got,
            }
        )

    s1, s2, s4 = statement(1), statement(2), statement(4)
    # Two cells whose first passing openings are in segments 10 and 12; the
    # tally window ends in segment 40, so the destruction segment is 13.
    tally = ([10, 12], 40)
    all_destroyed = [{"seat": 1, "code": "destroyed", "at": 0}, {"seat": 2, "code": "destroyed", "at": 1}, {"seat": 4, "code": "destroyed", "at": 2}]

    report("all-destroyed", "Every registered seat's statement in the destruction segment or later", [(13, s1), (14, s2), (20, s4)], *tally, {"from": 13, "seats": all_destroyed})
    report(
        "early",
        "Seat 2's statement is in segment 12, the segment of cell 1's first passing opening, before its checkpoint could be anchored: destruction-early",
        [(13, s1), (12, s2), (13, s4)],
        *tally,
        {"seats": [all_destroyed[0], {"seat": 2, "code": "destruction-early", "at": 1}, all_destroyed[2]]},
    )
    report(
        "missing",
        "Only seat 1 made a statement: seats 2 and 4 are destruction-missing",
        [(30, s1)],
        *tally,
        {"seats": [{"seat": 1, "code": "destroyed", "at": 0}, {"seat": 2, "code": "destruction-missing"}, {"seat": 4, "code": "destruction-missing"}]},
    )
    report(
        "tally-incomplete",
        "Cell 1 has no passing opening, so the destruction segment is the tally window's, 40: seat 1's statement in 40 is on time, seat 2's in 39 early",
        [(40, s1), (39, s2), (41, s4)],
        [10, None],
        40,
        {"from": 40, "seats": [all_destroyed[0], {"seat": 2, "code": "destruction-early", "at": 1}, all_destroyed[2]]},
    )
    report(
        "tally-after-window",
        "Cell 1's first passing opening is in segment 45, after the tally window's segment 40: trustees destroyed at t_D, so the destruction segment is 40",
        [(40, s1), (41, s2), (46, s4)],
        [10, 45],
        40,
        {"from": 40, "seats": all_destroyed},
    )
    report(
        "unattributed",
        "Beside seat 1's statement: one by seat 3, which isn't registered; seat 4's fields signed with seat 2's key; seat 1's signature with the signer changed to 2; and seat 1's key signing the same bytes under the tally-opening tag. None is attributed, so seats 2 and 4 are missing",
        [
            (13, s1),
            (13, statement(3)),
            (13, statement(4, d=secrets[2])),
            (13, {**s1, "signer": 2}),
            (13, statement(1, tag=OPENING_TAG)),
        ],
        *tally,
        {
            "seats": [all_destroyed[0], {"seat": 2, "code": "destruction-missing"}, {"seat": 4, "code": "destruction-missing"}],
            "unattributed": [{"at": 1}, {"at": 2}, {"at": 3}, {"at": 4}],
        },
    )
    report(
        "stray",
        "Seat 4's key over another definition (attributed, stray) and another definition signed by a key this election never registered (unattributed, stray); seat 4 has no statement of its own",
        [(13, s1), (13, statement(4, definition=other_definition)), (14, s2), (14, statement(1, d=secret("other-election-seat-1"), definition=other_definition))],
        *tally,
        {"stray": [{"at": 1, "signer": 4}, {"at": 3, "signer": None}], "seats": [all_destroyed[0], {"seat": 2, "code": "destroyed", "at": 2}, {"seat": 4, "code": "destruction-missing"}]},
    )
    report(
        "duplicates",
        "Seat 1 signed early and again later: its first statement decides (destruction-early) and the second is a duplicate; a byte-identical copy of seat 2's is a duplicate too",
        [(5, s1), (13, s2), (20, statement(1)), (21, s2), (22, s4)],
        *tally,
        {
            "seats": [{"seat": 1, "code": "destruction-early", "at": 0}, {"seat": 2, "code": "destroyed", "at": 1}, {"seat": 4, "code": "destroyed", "at": 4}],
            "duplicates": [{"at": 2, "seat": 1}, {"at": 3, "seat": 2}],
        },
    )
    report(
        "rejected",
        "A version-2 copy of seat 2's statement and a 3-byte payload are rejected entries; seat 2's version-1 statement after them counts",
        [(13, s1), (13, encode(s2, version=2)), (13, bytes.fromhex("000f01")), (14, s2), (14, s4)],
        *tally,
        {"seats": [all_destroyed[0], {"seat": 2, "code": "destroyed", "at": 3}, {"seat": 4, "code": "destroyed", "at": 4}], "rejected": [{"at": 1, "error": "profile-mismatch"}, {"at": 2, "error": "truncated"}]},
    )
    report("empty-board", "No statements at all", [], *tally, {"seats": [{"seat": i, "code": "destruction-missing"} for i in (1, 2, 4)]})

    entries = []

    def entry(id_, desc, version, payload, error):
        enc = board_entry(version, ecdsa.sha256(b"destruction/election-id"), 9, 13, payload)
        assert entry_error(enc) == error, id_
        entries.append({"id": id_, "description": desc, "version": version, "encoding": enc.hex(), "error": error})

    s1_bytes = encode(s1)
    entry("v4-statement", "A version-4 entry carrying a destruction statement", 4, s1_bytes, None)
    entry("v3-statement", "A version-3 entry can't carry a destruction statement", 3, s1_bytes, "unexpected-record-type")
    entry("v1-statement", "A version-1 entry can't carry a destruction statement", 1, s1_bytes, "unexpected-record-type")
    entry("v4-receipt-type", "A version-4 entry carrying a share-receipt header, as version 3 allows", 4, bytes.fromhex("000c0100"), None)
    entry("v4-complaint-type", "A version-4 entry carrying a share-complaint header, as version 3 allows", 4, bytes.fromhex("000e0100"), None)
    entry("v4-ballot-type", "A version-4 entry carrying a ballot header, as version 1 allows", 4, bytes.fromhex("00020100"), None)
    entry("v4-posting-type", "A version-4 entry still refuses a share posting (0x000d): postings reach the board only as contract events", 4, bytes.fromhex("000d0100"), "unexpected-record-type")
    entry("v4-receipt-record-type", "A version-4 entry still refuses the voter's receipt (0x0004), which stays with its voter", 4, bytes.fromhex("00040100"), "unexpected-record-type")
    entry("v4-definition-type", "A version-4 entry refuses an election definition (0x0001), which reaches the board only as its registration's contract event", 4, bytes.fromhex("00010100"), "unexpected-record-type")
    entry("v4-summed-share-type", "A version-4 entry refuses a summed-share message (0x000b), which never leaves the trustees", 4, bytes.fromhex("000b0100"), "unexpected-record-type")

    data = {
        "format": "abolish-destruction-vectors/1",
        "title": "Destruction statements: the record, its signature and the report over a board's statements",
        "spec": "docs/spec/tally.md",
        "generator": (
            "packages/crypto/scripts/destruction-vectors.py: an independent Python implementation of "
            "docs/spec/tally.md (Destruction, Destruction checks), with trustee-vectors.py's P-256 ECDSA, "
            "which reproduces RFC 6979 Appendix A.2.5 first"
        ),
        "tag": TAG.decode(),
        "recordType": "0x000f",
        "version": VERSION,
        "election": {
            "definitionHash": definition_hash.hex(),
            "registered": [{"index": i, "signingKey": keys[i].hex()} for i in sorted(registered)],
        },
        "statements": statements,
        "decodeErrors": decode_errors,
        "reports": reports,
        "boardEntries": entries,
    }
    with open(f"{out}/destruction.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
