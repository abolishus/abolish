#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/close-statement.json.

A second implementation of docs/spec/close.md: each ballot path's window
(verifier 5.5), L_δ found in L1 headers, the close statement (record type
0x0015, version 1) with its signed message, signature and strict decoder, the
close head over a board's statements, and the close check (verifier 6.3) over
admitted ballots, with its own re-vote selection (docs/spec/revoting.md,
Selection). It is written from the spec with Python's integers and hashlib;
signatures come from trustee-vectors.py's P-256 ECDSA, which reproduces RFC
6979 Appendix A.2.5 first. Nothing here shares code with packages/crypto or any
@noble library.

Every secret comes from SHA-256 over a fixed label, and each statement lists
the signing secret that made it, so any RFC 6979 implementation reproduces its
bytes. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/close-statement-vectors.py <out-dir>
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

RECORD_TYPE = 0x0015
VERSION = 1
TAG = b"abolish/v1/sig/close-statement"
DESTRUCTION_TAG = b"abolish/v1/sig/destruction"
CLOSE_WINDOW = 172_800
U64_MAX = 2**64 - 1


def u8(x):
    return bytes([x])


def u64(x):
    assert 0 <= x <= U64_MAX
    return x.to_bytes(8, "big")


# --- Window (verifier 5.5) -----------------------------------------------------------


def window(path, value, opens_at, closes_at, s_a):
    """An ordinary ballot's τ_b, a relayed ballot's stamp, or a board-path entry's segment."""
    if path == "board":
        return "admitted" if value <= s_a else "window-boarded-late"
    if value < opens_at:
        return "window-before-open"
    if value > closes_at:
        return "window-after-close"
    return "admitted"


# --- L_δ ------------------------------------------------------------------------------


def l_delta(blocks, closes_at, bound):
    """The last block with a timestamp at or before closes_at + δ, or None while
    no finalized block is after it. `blocks` is [(number, timestamp)], every
    finalized block from one at or before the bound to the head."""
    t = closes_at + bound
    assert blocks[0][1] <= t
    if blocks[-1][1] <= t:
        return None
    last = None
    for number, ts in blocks:
        if ts <= t:
            last = number
    return last


# --- The record ------------------------------------------------------------------------


def message(st, record_type=RECORD_TYPE, version=VERSION):
    """u16(0x0015) ‖ u8(1) ‖ definition_hash ‖ u8(signer) ‖ u64(l1_number) ‖ l1_hash ‖ u64(l2_number) ‖ l2_hash."""
    for k in ("definitionHash", "l1Hash", "l2Hash"):
        assert len(st[k]) == 32
    return (
        record_type.to_bytes(2, "big")
        + u8(version)
        + st["definitionHash"]
        + u8(st["signer"])
        + u64(st["l1Number"])
        + st["l1Hash"]
        + u64(st["l2Number"])
        + st["l2Hash"]
    )


def sign(d, m, tag=TAG):
    _, r, s = ecdsa.ecdsa_sign(d, ecdsa.ds(tag, m))
    return ecdsa.sig_bytes(r, s)


def p256_key(d):
    return ecdsa.compress(ecdsa.mul(d, ecdsa.G))


def encode(st, record_type=RECORD_TYPE, version=VERSION):
    return message(st, record_type, version) + st["signature"]


class Reject(Exception):
    def __init__(self, code, offset):
        super().__init__(code, offset)
        self.code, self.offset = code, offset


def decode(b, pinned=VERSION):
    """docs/spec/notation.md, Strict decoding, for a file whose only known type is 0x0015 version 1."""
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
    st = {"definitionHash": take(32), "signer": take(1)[0]}
    st["l1Number"] = int.from_bytes(take(8), "big")
    st["l1Hash"] = take(32)
    st["l2Number"] = int.from_bytes(take(8), "big")
    st["l2Hash"] = take(32)
    sig_at = at
    sig = take(64)
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if not (1 <= r < ecdsa.N and 1 <= s <= ecdsa.HALF_N):
        raise Reject("non-canonical", sig_at)
    if at != len(b):
        raise Reject("trailing-bytes", at)
    st["signature"] = sig
    return st


# --- Close head ------------------------------------------------------------------------


def attribution(registered, st):
    key = registered.get(st["signer"])
    if key is None:
        return None
    return st["signer"] if ecdsa.verify(key, ecdsa.ds(TAG, message(st)), st["signature"]) else None


def in_time(entry, deadline):
    if entry["path"] == "board":
        return entry["segment"] <= deadline["segment"]
    return entry["submittedAt"] <= deadline["time"]


def close_head(election, entries, floor):
    """docs/spec/close.md, Close head: each entry's code, each seat's, and B."""
    registered = election["registered"]
    statements = []
    valid = {}
    for at, entry in enumerate(entries):
        try:
            st = decode(entry["payload"])
        except Reject as e:
            statements.append({"at": at, "code": "decode", "error": e.code})
            continue
        seat = attribution(registered, st)
        if st["definitionHash"] != election["definitionHash"]:
            statements.append({"at": at, "code": "close-stray", "signer": seat})
        elif seat is None:
            statements.append({"at": at, "code": "close-unattributed"})
        elif (st["l1Number"], st["l1Hash"]) != election["lDelta"]:
            statements.append({"at": at, "code": "close-l1", "seat": seat})
        elif not in_time(entry, election["deadline"]):
            # The operator may have held a board-path statement back, so it is
            # attributed only through the contract path.
            statements.append({"at": at, "code": "close-late", "seat": seat if entry["path"] == "contract" else None})
        else:
            statements.append({"at": at, "code": "valid", "seat": seat})
            valid.setdefault(seat, set()).add((st["l2Number"], st["l2Hash"]))
    seats, counted, below = [], [], []
    for i in sorted(registered):
        claims = valid.get(i)
        if claims is None:
            seats.append({"seat": i, "code": "close-missing"})
        elif len(claims) > 1:
            seats.append({"seat": i, "code": "close-equivocation"})
        else:
            (claim,) = claims
            seats.append({"seat": i, "code": "close-counted", "claim": claim})
            counted.append(claim[0])
            # The floor only reports: a claim below it still counts.
            if floor is not None and claim[0] < floor:
                below.append(i)
    k = election["threshold"]
    head = sorted(counted, reverse=True)[k - 1] if len(counted) >= k else None
    claims = sorted(set().union(*valid.values())) if valid else []
    return {"head": head, "statements": statements, "seats": seats, "claims": claims, "belowFloor": below}


# --- Close check -----------------------------------------------------------------------


def select(ballots):
    """docs/spec/revoting.md, Selection: repeats, then the single highest block per (tier, ν)."""
    standing = {}
    for b in sorted(ballots, key=lambda b: b["index"]):
        standing.setdefault((b["tier"], b["nullifier"], b["message"]), b)
    groups = {}
    for b in standing.values():
        groups.setdefault((b["tier"], b["nullifier"]), []).append(b)
    selected = []
    for group in groups.values():
        top = max(b["l1RefNumber"] for b in group)
        best = [b for b in group if b["l1RefNumber"] == top]
        if len(best) == 1:
            selected.append(best[0])
    return selected


def counted_sets(ballots, undelivered):
    cells = {}
    for b in select(ballots):
        if b["ballotHash"] in undelivered:
            continue
        cells.setdefault(b["cell"], set()).add((b["tier"], b["nullifier"], b["message"]))
    return cells


def close_check(ballots, head, undelivered):
    if head is None:
        counted = counted_sets(ballots, undelivered)
        keys = set().union(*counted.values()) if counted else set()
        unchecked = []
        for key in keys:
            copies = [b for b in ballots if (b["tier"], b["nullifier"], b["message"]) == key]
            if all(b["path"] == "ordinary" for b in copies):
                unchecked.append(min(b["index"] for b in copies))
        return {"status": "unchecked", "unchecked": sorted(unchecked)}
    late = [b for b in ballots if b["path"] == "ordinary" and b["l2Block"] > head]
    kept = [b for b in ballots if not (b["path"] == "ordinary" and b["l2Block"] > head)]
    before, after = counted_sets(ballots, undelivered), counted_sets(kept, undelivered)
    late_indices = sorted(b["index"] for b in late)
    for cell in sorted(set(before) | set(after)):
        if before.get(cell, set()) != after.get(cell, set()):
            return {"status": "fail", "code": "close-contested", "cell": cell, "late": late_indices}
    return {"status": "pass", "late": late_indices}


# --- Vectors ---------------------------------------------------------------------------


def main():
    out = sys.argv[1]
    ecdsa.self_check()

    def secret(label):
        return ecdsa.secret(f"close-statement/{label}".encode())

    def h(label):
        return ecdsa.sha256(f"close-statement/{label}".encode())

    # A panel of five with k = 3. Seats 1, 2, 3 and 5 are registered; seat 4
    # took part but wasn't qualified, so its per-election key isn't.
    secrets = {i: secret(f"seat-{i}") for i in (1, 2, 3, 4, 5)}
    keys = {i: p256_key(d) for i, d in secrets.items()}
    registered = {i: keys[i] for i in (1, 2, 3, 5)}
    definition_hash = h("definition")
    other_definition = h("other-definition")
    # Close at 1,800,000,000 with δ = 1,800 s; hourly periods from epoch 1,700,000,000.
    closes_at, bound, epoch, period = 1_800_000_000, 1_800, 1_700_000_000, 3_600
    t_c = closes_at + bound + CLOSE_WINDOW
    s_c = (t_c - epoch) // period
    l1 = (20_000_150, h("l1-block-20000150"))
    election = {
        "definitionHash": definition_hash,
        "registered": registered,
        "threshold": 3,
        "lDelta": l1,
        "deadline": {"time": t_c, "segment": s_c},
    }
    honest = (40_001_000, h("l2-block-40001000"))

    def statement(signer, claim=honest, d=None, definition=definition_hash, l1_block=l1, tag=TAG):
        st = {
            "definitionHash": definition,
            "signer": signer,
            "l1Number": l1_block[0],
            "l1Hash": l1_block[1],
            "l2Number": claim[0],
            "l2Hash": claim[1],
        }
        st["signature"] = sign(secrets[signer] if d is None else d, message(st), tag)
        return st

    statements = []

    def published(id_, desc, signer, **kw):
        st = statement(signer, **kw)
        b = encode(st)
        assert decode(b) == st and len(b) == 180
        statements.append(
            {
                "id": id_,
                "description": desc,
                "signingSecret": secrets[signer].to_bytes(32, "big").hex(),
                "signingKey": keys[signer].hex(),
                "definitionHash": st["definitionHash"].hex(),
                "signer": signer,
                "l1Number": str(st["l1Number"]),
                "l1Hash": st["l1Hash"].hex(),
                "l2Number": str(st["l2Number"]),
                "l2Hash": st["l2Hash"].hex(),
                "message": message(st).hex(),
                "signature": st["signature"].hex(),
                "encoding": b.hex(),
            }
        )
        return b

    honest_b = published("seat-1", "Seat 1's statement of the honest head", 1)
    published("seat-2", "Seat 2's statement of the same head", 2)
    published("seat-5-high", "Seat 5's statement of a head above the honest one", 5, claim=(40_001_900, h("l2-block-40001900")))
    published("seat-3-extremes", "Seat 3's statement at the u64 extremes: block 0 claimed, L1 block 2^64 − 1", 3, claim=(0, bytes(32)), l1_block=(U64_MAX, bytes([0xFF]) * 32))

    decode_errors = []

    def rejected(id_, desc, b, code, offset):
        try:
            decode(b)
        except Reject as e:
            assert (e.code, e.offset) == (code, offset), (id_, e.code, e.offset)
        else:
            raise AssertionError(id_)
        decode_errors.append({"id": id_, "description": desc, "encoding": b.hex(), "error": code, "offset": offset})

    sig_at = 3 + 32 + 1 + 8 + 32 + 8 + 32
    rejected("empty", "No bytes", b"", "truncated", 0)
    rejected("header-only", "A header and nothing else", honest_b[:3], "truncated", 3)
    rejected("destruction-type", "Record type 0x000f where a close statement is read", b"\x00\x0f" + honest_b[2:], "unknown-record-type", 0)
    rejected("version-2", "Version 2, which no board-entry version fixes", honest_b[:2] + b"\x02" + honest_b[3:], "profile-mismatch", 2)
    rejected("truncated-in-l2-hash", "The record cut inside l2_hash", honest_b[: 3 + 32 + 1 + 8 + 32 + 8 + 10], "truncated", 3 + 32 + 1 + 8 + 32 + 8)
    rejected("truncated-in-signature", "The last byte of the signature missing", honest_b[:-1], "truncated", sig_at)
    rejected("trailing-byte", "One byte after the signature", honest_b + b"\x00", "trailing-bytes", len(honest_b))
    high_s = bytearray(honest_b)
    s_val = int.from_bytes(honest_b[sig_at + 32 :], "big")
    high_s[sig_at + 32 :] = (ecdsa.N - s_val).to_bytes(32, "big")
    rejected("signature-high-s", "The signature's s replaced by n − s", bytes(high_s), "non-canonical", sig_at)
    rejected("signature-r-zero", "The signature's r is 0", honest_b[:sig_at] + bytes(32) + honest_b[sig_at + 32 :], "non-canonical", sig_at)

    windows = []

    def win(id_, desc, path, value, result):
        s_a = (closes_at - epoch) // period + 1
        got = window(path, value, closes_at - 86_400, closes_at, s_a)
        assert got == result, (id_, got)
        windows.append({"id": id_, "description": desc, "path": path, "value": str(value), "result": result})

    s_a = (closes_at - epoch) // period + 1
    win("ordinary-at-open", "An ordinary ballot in a block stamped exactly opens_at", "ordinary", closes_at - 86_400, "admitted")
    win("ordinary-before-open", "An ordinary ballot one second before opens_at", "ordinary", closes_at - 86_401, "window-before-open")
    win("ordinary-at-close", "An ordinary ballot in a block stamped exactly closes_at", "ordinary", closes_at, "admitted")
    win("ordinary-after-close", "An ordinary ballot one second after closes_at, however soon its batch reached L1", "ordinary", closes_at + 1, "window-after-close")
    win("relayed-at-close", "A relayed ballot whose relay call is in an L1 block stamped closes_at, its L2 block hours later", "relayed", closes_at, "admitted")
    win("relayed-after-close", "A relayed ballot whose relay call is one slot after closes_at", "relayed", closes_at + 12, "window-after-close")
    win("relayed-before-open", "A relayed ballot stamped before opens_at", "relayed", closes_at - 86_401, "window-before-open")
    win("board-at-s-a", "A board-path ballot in segment s_A = period(closes_at) + 1", "board", s_a, "admitted")
    win("board-after-s-a", "A board-path ballot in segment s_A + 1: the operator's breach", "board", s_a + 1, "window-boarded-late")
    win("board-early", "A board-path ballot in the election's first segment: the board path has no opening test", "board", 0, "admitted")

    deltas = []

    def delta(id_, desc, first, stamps, result):
        blocks = [(first + i, ts) for i, ts in enumerate(stamps)]
        got = l_delta(blocks, closes_at, bound)
        assert got == result, (id_, got)
        deltas.append(
            {
                "id": id_,
                "description": desc,
                "closesAt": str(closes_at),
                "bound": bound,
                "blocks": [{"number": str(n), "timestamp": str(ts), "hash": h(f"l1-{n}").hex()} for n, ts in blocks],
                "result": None if result is None else str(result),
            }
        )

    t = closes_at + bound
    delta("between-slots", "The bound falls between two blocks: L_δ is the earlier", 100, [t - 24, t - 12, t - 1, t + 11, t + 23], 102)
    delta("at-a-slot", "A block stamped exactly closes_at + δ is L_δ", 100, [t - 24, t - 12, t, t + 12], 102)
    delta("missed-slots", "Missed slots before the bound: L_δ is the last block that exists", 100, [t - 60, t + 24], 100)
    delta("not-yet", "No finalized block after the bound yet: L_δ isn't known", 100, [t - 24, t - 12, t], None)
    delta("first-is-it", "The earliest block read is L_δ", 7, [t - 5, t + 7, t + 19], 7)

    heads = []
    floor_block = 40_000_500

    def entry_of(e):
        path, where, payload = e
        b = payload if isinstance(payload, bytes) else encode(payload)
        d = {"path": path, "payload": b}
        d["segment" if path == "board" else "submittedAt"] = where
        return d

    def head_case(id_, desc, entries, floor, expect_head):
        es = [entry_of(e) for e in entries]
        got = close_head(election, es, floor)
        assert got["head"] == expect_head, (id_, got["head"], expect_head)
        heads.append(
            {
                "id": id_,
                "description": desc,
                "floor": None if floor is None else str(floor),
                "entries": [
                    {"path": e["path"], ("segment" if e["path"] == "board" else "submittedAt"): (e["segment"] if e["path"] == "board" else str(e["submittedAt"])), "payload": e["payload"].hex()}
                    for e in es
                ],
                "result": {
                    "head": None if got["head"] is None else str(got["head"]),
                    "statements": got["statements"],
                    "seats": [
                        {**s, "claim": {"number": str(s["claim"][0]), "hash": s["claim"][1].hex()}} if "claim" in s else s for s in got["seats"]
                    ],
                    "claims": [{"number": str(n), "hash": hb.hex()} for n, hb in got["claims"]],
                    "belowFloor": got["belowFloor"],
                },
            }
        )
        return got

    low = (40_000_100, h("l2-block-40000100"))
    high = (40_001_900, h("l2-block-40001900"))
    higher = (40_002_500, h("l2-block-40002500"))
    on_time = s_c - 5
    s1, s2, s3, s5 = statement(1), statement(2), statement(3), statement(5)

    head_case("all-honest", "Every registered seat states the honest head through the board path: B is it", [("board", on_time, s1), ("board", on_time, s2), ("board", on_time, s3), ("board", on_time, s5)], None, honest[0])
    head_case(
        "liars-high-below-k",
        "Two seats state heads above the honest one: fewer than k = 3 liars, so the third largest claim is still the honest head",
        [("board", on_time, s1), ("board", on_time, s2), ("board", on_time, statement(3, claim=high)), ("board", on_time, statement(5, claim=higher))],
        None,
        honest[0],
    )
    head_case(
        "liars-high-k",
        "Three seats, k of them, state heads above the honest one: B is the lowest of their claims, which can hide a rebuild",
        [("board", on_time, s1), ("board", on_time, statement(2, claim=high)), ("board", on_time, statement(3, claim=high)), ("board", on_time, statement(5, claim=higher))],
        None,
        high[0],
    )
    head_case(
        "liar-low",
        "One seat states a low head: with three honest claims above it, B is the honest head",
        [("board", on_time, s1), ("board", on_time, s2), ("board", on_time, s3), ("board", on_time, statement(5, claim=low))],
        None,
        honest[0],
    )
    head_case(
        "liars-low-honest-silent",
        "Seat 5 is silent and seats 2 and 3 state low: with one honest claim counted, the third largest is low, so B is the low claim, which may fail the election but never drops a ballot",
        [("board", on_time, s1), ("board", on_time, statement(2, claim=low)), ("contract", t_c, statement(3, claim=low))],
        None,
        low[0],
    )
    head_case(
        "floor-reports-low",
        "A permissionless game shows block 40,000,500 derivable by L_δ: seat 5's claim below it is listed, but still counts, and the honest claims above it give B",
        [("board", on_time, s1), ("board", on_time, s2), ("board", on_time, statement(5, claim=low)), ("board", on_time, s3)],
        floor_block,
        honest[0],
    )
    head_case(
        "floor-never-removes",
        "Seats 1 and 2 state the honest head and seat 5 a low one, below the floor: all three count, so B is the low claim. A floor that removed it would leave the close unchecked, which whoever controls one false game could force",
        [("board", on_time, s1), ("board", on_time, s2), ("board", on_time, statement(5, claim=low))],
        floor_block,
        low[0],
    )
    head_case(
        "false-floor",
        "A floor above every honest claim (a false game) lists every seat, and changes nothing: B is still the honest head",
        [("board", on_time, s1), ("board", on_time, s2), ("board", on_time, s3)],
        higher[0],
        honest[0],
    )
    head_case(
        "equivocation",
        "Seat 3 states the honest head through the board path and a high one through the contract path: neither counts, leaving seats 1, 2 and 5",
        [("board", on_time, s1), ("board", on_time, s3), ("contract", t_c - 100, statement(3, claim=higher)), ("board", on_time, s2), ("board", on_time, statement(5, claim=high))],
        None,
        honest[0],
    )
    head_case(
        "same-claim-twice",
        "Seat 1's statement through both paths and seat 2's twice through the board path: statements that agree are one",
        [("board", on_time, s1), ("contract", t_c, s1), ("board", on_time, s2), ("board", on_time + 1, s2), ("board", on_time, s3)],
        None,
        honest[0],
    )
    head_case(
        "late",
        "Seat 3's statement through the board path in segment s_C + 1 (late, the operator may have held it), seat 5's through the contract path one second after t_C (late, its own): two counted seats, no close head",
        [("board", on_time, s1), ("board", on_time, s2), ("board", s_c + 1, s3), ("contract", t_c + 1, s5)],
        None,
        None,
    )
    head_case(
        "at-the-deadline",
        "Statements in segment s_C and submitted exactly at t_C are in time",
        [("board", s_c, s1), ("contract", t_c, s2), ("board", s_c, s3)],
        None,
        honest[0],
    )
    head_case(
        "wrong-l1",
        "Seat 5 signs against the L1 block after L_δ: close-l1, attributed to it, and its claim doesn't count",
        [("board", on_time, s1), ("board", on_time, s2), ("board", on_time, s3), ("board", on_time, statement(5, claim=high, l1_block=(l1[0] + 1, h("l1-block-20000151"))))],
        None,
        honest[0],
    )
    head_case(
        "wrong-l1-hash",
        "Seat 5 signs L_δ's number with another hash: close-l1",
        [("board", on_time, s1), ("board", on_time, s2), ("board", on_time, statement(5, l1_block=(l1[0], h("l1-reorged")))), ("board", on_time, s3)],
        None,
        honest[0],
    )
    head_case(
        "unattributed-and-stray",
        "Beside three honest statements: one by seat 4, which isn't registered; seat 5's fields signed with seat 1's key; seat 1's fields under the destruction tag; seat 2's key over another definition (stray, attributed); another definition signed by a key this election never registered (stray, unattributed)",
        [
            ("board", on_time, s1),
            ("board", on_time, statement(4)),
            ("board", on_time, statement(5, d=secrets[1])),
            ("board", on_time, statement(1, tag=DESTRUCTION_TAG)),
            ("board", on_time, statement(2, definition=other_definition)),
            ("board", on_time, statement(5, d=secret("other-election-seat-5"), definition=other_definition)),
            ("board", on_time, s2),
            ("board", on_time, s3),
        ],
        None,
        honest[0],
    )
    head_case(
        "rejected",
        "A version-2 copy of seat 5's statement and a 3-byte payload are rejected entries; three honest statements give B",
        [("board", on_time, encode(s5, version=2)), ("board", on_time, bytes.fromhex("001501")), ("board", on_time, s1), ("board", on_time, s2), ("board", on_time, s3)],
        None,
        honest[0],
    )
    head_case("empty", "No statements: every seat is missing and there is no close head", [], None, None)

    checks = []

    def ballot(index, cell, nullifier, l1_ref, path, l2_block=None, content="", tier=None):
        b = {
            "index": index,
            "cell": cell,
            "tier": cell if tier is None else tier,
            "nullifier": nullifier,
            "l1RefNumber": l1_ref,
            "path": path,
        }
        # The ballot hash is fixed by the content; M also binds the L1 reference.
        b["ballotHash"] = h(f"ballot-{cell}-{nullifier}-{content}")
        b["message"] = h(f"message-{cell}-{nullifier}-{content}-{l1_ref}")
        if path == "ordinary":
            b["l2Block"] = l2_block
        return b

    def check(id_, desc, ballots, head, expect, undelivered=()):
        und = {u if isinstance(u, bytes) else u["ballotHash"] for u in undelivered}
        got = close_check(ballots, head, und)
        assert got == expect, (id_, got, expect)
        checks.append(
            {
                "id": id_,
                "description": desc,
                "head": None if head is None else str(head),
                "ballots": [
                    {
                        "index": str(b["index"]),
                        "cell": b["cell"],
                        "tier": b["tier"],
                        "nullifier": str(b["nullifier"]),
                        "message": b["message"].hex(),
                        "l1RefNumber": str(b["l1RefNumber"]),
                        "ballotHash": b["ballotHash"].hex(),
                        "path": b["path"],
                        **({"l2Block": str(b["l2Block"])} if b["path"] == "ordinary" else {}),
                    }
                    for b in ballots
                ],
                "undelivered": sorted(u.hex() for u in und),
                "result": {**got, **({"late": [str(i) for i in got["late"]]} if "late" in got else {}), **({"unchecked": [str(i) for i in got["unchecked"]]} if "unchecked" in got else {})},
            }
        )

    B = honest[0]
    early = B - 400
    after = B + 30
    check(
        "no-late",
        "Every ordinary ballot is in a block at or before B: nothing to remove",
        [ballot(0, 0, 11, 500, "ordinary", early), ballot(1, 1, 12, 501, "ordinary", B), ballot(2, 0, 13, 502, "board")],
        B,
        {"status": "pass", "late": []},
    )
    check(
        "late-changes-cell",
        "Voter 11's re-vote is an ordinary ballot in a block after B: without it their earlier ballot counts, so cell 0 differs and the election fails close-contested",
        [ballot(0, 0, 11, 500, "board", content="first"), ballot(1, 0, 11, 520, "ordinary", after, content="second"), ballot(2, 1, 12, 501, "ordinary", early)],
        B,
        {"status": "fail", "code": "close-contested", "cell": 0, "late": [1]},
    )
    check(
        "late-new-voter",
        "A voter's only ballot is a late ordinary one: removing it empties their place in cell 1",
        [ballot(0, 0, 11, 500, "ordinary", early), ballot(1, 1, 12, 501, "ordinary", after)],
        B,
        {"status": "fail", "code": "close-contested", "cell": 1, "late": [1]},
    )
    check(
        "late-outranked",
        "A late ordinary ballot that a newer timely ballot of the same voter outranks changes nothing",
        [ballot(0, 0, 11, 510, "ordinary", after, content="older"), ballot(1, 0, 11, 530, "board", content="newer")],
        B,
        {"status": "pass", "late": [0]},
    )
    check(
        "relayed-copy-stands",
        "The voter's ballot reached L2 late as an ordinary transaction and also through the L1 relay: the late copy is removed before repeats, the relayed copy stands, and nothing changes",
        [ballot(0, 0, 11, 500, "ordinary", after, content="x"), ballot(1, 0, 11, 500, "relayed", content="x")],
        B,
        {"status": "pass", "late": [0]},
    )
    check(
        "board-copy-stands",
        "A late ordinary copy at a smaller index than the voter's board-path copy: the board-path copy stands once the late one is removed",
        [ballot(0, 0, 11, 500, "ordinary", after, content="x"), ballot(1, 0, 11, 500, "board", content="x")],
        B,
        {"status": "pass", "late": [0]},
    )
    check(
        "timely-ordinary-copy-stands",
        "Two ordinary copies of one ballot (a re-randomised proof), one at or before B and one after: the timely copy stands",
        [ballot(0, 0, 11, 500, "ordinary", after, content="x"), ballot(1, 0, 11, 500, "ordinary", B, content="x")],
        B,
        {"status": "pass", "late": [0]},
    )
    check(
        "late-undelivered-only",
        "A voter's only ballot is a late ordinary one that was never delivered: it counts nothing either way, so nothing changes",
        [ballot(0, 0, 11, 500, "board"), ballot(1, 0, 12, 520, "ordinary", after)],
        B,
        {"status": "pass", "late": [1]},
        undelivered=[ballot(1, 0, 12, 520, "ordinary", after)],
    )
    check(
        "late-undelivered-revote",
        "A late ordinary re-vote that was never delivered makes its voter's group count nothing (no fallback); without it the earlier ballot counts, so cell 0 differs",
        [ballot(0, 0, 11, 500, "board", content="first"), ballot(1, 0, 11, 520, "ordinary", after, content="second")],
        B,
        {"status": "fail", "code": "close-contested", "cell": 0, "late": [1]},
        undelivered=[ballot(1, 0, 11, 520, "ordinary", after, content="second")],
    )
    check(
        "late-breaks-tie",
        "Two ballots of voter 11 on the same block tie and count nothing; removing the late one makes the other count, so cell 0 differs",
        [ballot(0, 0, 11, 520, "board", content="a"), ballot(1, 0, 11, 520, "ordinary", after, content="b")],
        B,
        {"status": "fail", "code": "close-contested", "cell": 0, "late": [1]},
    )
    check(
        "late-makes-tie",
        "A late ordinary ballot ties a timely one on the same block, so with it the group counts nothing; removing it makes the timely one count",
        [ballot(0, 0, 11, 520, "ordinary", after, content="a"), ballot(1, 0, 11, 520, "ordinary", early, content="b"), ballot(2, 1, 12, 500, "board")],
        B,
        {"status": "fail", "code": "close-contested", "cell": 0, "late": [0]},
    )
    check(
        "first-cell-reported",
        "Late ballots change cells 2 and 1: the first in partition order, 1, is named",
        [ballot(0, 2, 21, 500, "ordinary", after), ballot(1, 1, 12, 500, "ordinary", after), ballot(2, 0, 11, 500, "board")],
        B,
        {"status": "fail", "code": "close-contested", "cell": 1, "late": [0, 1]},
    )
    check(
        "regional-cells",
        "Two cells of tier 0 (regions): a late ballot in the second cell changes it",
        [ballot(0, 0, 11, 500, "board", tier=0), ballot(1, 1, 12, 500, "ordinary", after, tier=0)],
        B,
        {"status": "fail", "code": "close-contested", "cell": 1, "late": [1]},
    )
    check(
        "unchecked",
        "No close head: the check passes and lists the counted ballots with only ordinary copies (voters 11 and 13); voter 12 has a board-path copy, voter 14 a relayed one, and voter 15's ballot isn't delivered",
        [
            ballot(0, 0, 11, 500, "ordinary", early),
            ballot(1, 0, 12, 500, "ordinary", after, content="y"),
            ballot(2, 0, 12, 500, "board", content="y"),
            ballot(3, 1, 13, 500, "ordinary", after),
            ballot(4, 1, 14, 500, "relayed"),
            ballot(5, 1, 15, 500, "ordinary", early),
        ],
        None,
        {"status": "unchecked", "unchecked": [0, 3]},
        undelivered=[ballot(5, 1, 15, 500, "ordinary", early)],
    )
    check("empty", "No ballots at all", [], B, {"status": "pass", "late": []})

    data = {
        "format": "abolish-close-statement-vectors/1",
        "title": "The close rule: windows, L_δ, close statements, the close head and the close check",
        "spec": "docs/spec/close.md",
        "generator": (
            "packages/crypto/scripts/close-statement-vectors.py: an independent Python implementation of "
            "docs/spec/close.md with its own re-vote selection, and trustee-vectors.py's P-256 ECDSA, "
            "which reproduces RFC 6979 Appendix A.2.5 first"
        ),
        "tag": TAG.decode(),
        "recordType": "0x0015",
        "version": VERSION,
        "closeWindow": CLOSE_WINDOW,
        "clock": {"epoch": str(epoch), "period": str(period)},
        "window": {"opensAt": str(closes_at - 86_400), "closesAt": str(closes_at), "boardSegment": s_a},
        "election": {
            "definitionHash": definition_hash.hex(),
            "registered": [{"index": i, "signingKey": keys[i].hex()} for i in sorted(registered)],
            "threshold": election["threshold"],
            "closesAt": str(closes_at),
            "l1InclusionBound": bound,
            "lDelta": {"number": str(l1[0]), "hash": l1[1].hex()},
            "deadline": {"time": str(t_c), "segment": s_c},
        },
        "statements": statements,
        "decodeErrors": decode_errors,
        "windows": windows,
        "lDelta": deltas,
        "heads": heads,
        "checks": checks,
    }
    with open(f"{out}/close-statement.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
