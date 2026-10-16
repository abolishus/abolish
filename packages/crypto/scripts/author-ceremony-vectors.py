#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/author-ceremony.json.

A second implementation of docs/spec/ceremony.md, Author panel: the author
run's context (the author panel identifier under `abolish/v1/author-panel`
and the author stub hash), `duplicate-key` across both panels, the author
panel's quorum `k_A`, the ceremony registration an author seat signs, the
author approvals record (0x0019, version 1), its check and the operator's
boarding rule, and board-entry version 7 (docs/spec/board.md). It is written
from the spec with Python's standard library only and shares no code with
packages/crypto or any @noble library. It reuses ceremony-vectors.py's rounds
and transcript check (parametrized by the panel identifier's tag and the
other panel's identity keys, which leaves ceremony.json unchanged) and
key-set-vectors.py's key set hash and registration statement.

Every secret comes from SHA-512 or SHA-256 over a fixed label (ECDSA nonces
are RFC 6979's); the values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/author-ceremony-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
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


cv = _load("ceremony_vectors", "ceremony-vectors.py")
ks = _load("key_set_vectors", "key-set-vectors.py")
ecdsa, H, ds, u8, u16, u32 = cv.ecdsa, cv.H, cv.ds, cv.u8, cv.u16, cv.u32

MAX_TRUSTEES = 16
AUTHOR_PANEL_TAG = b"abolish/v1/author-panel"
PANEL_TAG = b"abolish/v1/panel"
REGISTRATION_TAG = b"abolish/v1/sig/ceremony-registration-2"
ENTRY_TAG = b"abolish/v1/board-entry"
APPROVALS_TYPE = 0x0019
BOARD_ENTRY = 0x0007
RUNNING_OPENING = 0x0018

# Board-entry version 5's payload types, and version 7's: version 5's and the
# author approvals (docs/spec/board.md, Allowed payloads).
PAYLOADS_V5 = (0x0002, 0x0003, 0x0005, 0x0006, 0x0008, 0x000C, 0x000E, 0x000F, 0x0015)
PAYLOADS_V7 = PAYLOADS_V5 + (APPROVALS_TYPE,)

ELECTION = {
    "l2ChainId": 84532,
    "trusteeRegistry": bytes.fromhex("5fbdb2315678afecb367f032d93f642f64180aa3"),
    "electionId": H(b"author-ceremony-vectors/election-id"),
    # The default panel's stub keeps author_transcript_hash; the author
    # panel's zeroes it, so the two differ (election-definition.md).
    "stubHash": H(b"author-ceremony-vectors/stub-hash"),
    "authorStubHash": H(b"author-ceremony-vectors/author-stub-hash"),
}
AUTHOR_ELECTION = {**ELECTION, "stubHash": ELECTION["authorStubHash"]}


def author_panel(label, k, n, default):
    p = cv.make_panel(label, k, n)
    # A seat in both panels is 2.5's default-seat, never a ceremony's.
    assert not set(p["keys"]) & set(default["keys"])
    return {**p, "tag": AUTHOR_PANEL_TAG, "otherKeys": default["keys"]}


def panel_id(p):
    return cv.panel_id(p["k"], p["keys"], p.get("tag", PANEL_TAG))


# --- The author approvals record (ceremony.md, Author approvals record) --------------


def enc_record(transcript_hash, approvals, version=1, record_type=APPROVALS_TYPE):
    body = b"".join(u8(i) + sig for i, sig in approvals)
    return u16(record_type) + u8(version) + transcript_hash + u32(len(approvals)) + body


class DecodeFail(Exception):
    def __init__(self, code):
        self.code = code


def decode_record(b):
    """Strict decoding under version 1, the one board-entry version 7 fixes."""
    if len(b) < 2:
        raise DecodeFail("truncated")
    if int.from_bytes(b[:2], "big") != APPROVALS_TYPE:
        raise DecodeFail("unknown-record-type")
    if len(b) < 3:
        raise DecodeFail("truncated")
    if b[2] != 1:
        raise DecodeFail("profile-mismatch")
    if len(b) < 39:
        raise DecodeFail("truncated")
    count = int.from_bytes(b[35:39], "big")
    if count > MAX_TRUSTEES:
        raise DecodeFail("length-over-max")
    approvals, at = [], 39
    for _ in range(count):
        if len(b) < at + 65:
            raise DecodeFail("truncated")
        sig = b[at + 1 : at + 65]
        r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
        if not (1 <= r < ecdsa.N and 1 <= s <= (ecdsa.N - 1) // 2):
            raise DecodeFail("non-canonical")
        approvals.append((b[at], sig))
        at += 65
    if len(b) != at:
        raise DecodeFail("trailing-bytes")
    assert len(b) == 39 + 65 * count
    return {"transcriptHash": b[3:35], "approvals": approvals}


def statement(panel, index, stub_hash, transcript_hash, key_set_hash, tag=None):
    pid = cv.panel_id(panel["k"], panel["keys"], tag or panel["tag"])
    return ks.statement(ELECTION["l2ChainId"], ELECTION["trusteeRegistry"], pid, index, stub_hash, transcript_hash, key_set_hash)


def approve(panel, index, transcript_hash, key_set_hash, stub_hash=None, tag=None, signer=None):
    m = statement(panel, index, stub_hash or ELECTION["authorStubHash"], transcript_hash, key_set_hash, tag)
    d = panel["secrets"][(signer or index) - 1]
    return (index, cv.sign(d, REGISTRATION_TAG, m))


def counting(panel, rec, transcript_hash, key_set_hash):
    """The seats whose approvals count in one decoded record, or None if the record counts for no one."""
    n = len(panel["keys"])
    seats = [i for i, _ in rec["approvals"]]
    if not all(1 <= i <= n for i in seats) or any(a >= b for a, b in zip(seats, seats[1:])):
        return None
    out = []
    for i, sig in rec["approvals"]:
        m = statement(panel, i, ELECTION["authorStubHash"], transcript_hash, key_set_hash)
        if cv.verify(panel["keys"][i - 1], REGISTRATION_TAG, m, sig):
            out.append(i)
    return out


def check_approvals(panel, transcript, records):
    """Author panel, Check: whether a set of records approves an author transcript that passed the transcript check."""
    k, n = panel["k"], len(panel["keys"])
    q = max(k, n - 1)
    if len(transcript["registered"]) < q:
        return {"ok": False, "code": "ceremony-participation"}
    thash, ksh = transcript["hash"], transcript["keySetHash"]
    named, counted = False, set()
    for b in records:
        try:
            rec = decode_record(b)
        except DecodeFail:
            continue
        if rec["transcriptHash"] != thash:
            continue
        named = True
        counted.update(counting(panel, rec, thash, ksh) or [])
    seats = sorted(counted)
    if len(seats) >= q:
        return {"ok": True, "seats": seats}
    return {"ok": False, "code": "author-approvals" if named else "author-approvals-missing", "seats": seats}


def boarding(panel, transcript, b, boarded):
    """The operator's boarding rule (Author panel, Boarding): None, or why it refuses."""
    if len(transcript["registered"]) < max(panel["k"], len(panel["keys"]) - 1):
        return "ceremony-participation"
    try:
        rec = decode_record(b)
    except DecodeFail as e:
        return e.code
    if rec["transcriptHash"] != transcript["hash"]:
        return "transcript"
    c = counting(panel, rec, transcript["hash"], transcript["keySetHash"])
    if c is None:
        return "seats"
    if len(c) != len(rec["approvals"]):
        return "signature"
    if len(c) < max(panel["k"], len(panel["keys"]) - 1):
        return "quorum"
    if boarded:
        return "boarded"
    return None


# --- Board-entry version 7 ----------------------------------------------------------


def entry(version, index, segment, payload):
    return u16(BOARD_ENTRY) + u8(version) + ELECTION["electionId"] + index.to_bytes(8, "big") + u32(segment) + u32(len(payload)) + payload


def entry_error(version, payload):
    allowed = PAYLOADS_V7 if version == 7 else PAYLOADS_V5
    return None if int.from_bytes(payload[:2], "big") in allowed else "unexpected-record-type"


# --- Vectors ------------------------------------------------------------------------


def main(out):
    ecdsa.self_check()
    cv.grp.self_check()
    cv.se.mlkem_self_check(100)

    default = cv.make_panel("author-vectors/default-4", 3, 4)
    panels = {
        "default-4": default,
        "author-3": author_panel("author-vectors/author-3", 2, 3, default),
        "author-1": author_panel("author-vectors/author-1", 1, 1, default),
        "author-2-k1": author_panel("author-vectors/author-2-k1", 1, 2, default),
        "author-4": author_panel("author-vectors/author-4", 2, 4, default),
    }
    transcripts, checked = [], {}

    def add(id_, desc, name, seats, cheat=None, kind="author", expect=None):
        p = panels[name]
        if kind == "default":
            # The default run of an election with an author panel: duplicate-key reads the author keys too.
            p = {**p, "otherKeys": panels["author-3"]["keys"]}
        election = AUTHOR_ELECTION if kind == "author" else ELECTION
        r = cv.run(id_, p, seats, cheat, election)
        b = cv.enc_transcript(r["runId"], r["rounds"])
        result = cv.check(p, b, election)
        got = result["code"] if not result["ok"] else [(s["index"], s["reasons"]) for s in result["seats"] if s["reasons"]]
        assert got == expect, (id_, got, expect)
        if result["ok"]:
            entries = [(s["index"], ks.kem_key_hash(bytes.fromhex(s["kemKey"])), bytes.fromhex(s["signingKey"])) for s in result["registered"]]
            result["keySetHash"] = ks.key_set_hash(entries).hex()
            checked[id_] = {
                "panel": p,
                "hash": bytes.fromhex(result["hash"]),
                "keySetHash": bytes.fromhex(result["keySetHash"]),
                "registered": result["registered"],
                "bytes": b,
            }
        transcripts.append(
            {
                "id": id_,
                "description": desc,
                "panel": name,
                "kind": kind,
                "context": r["context"].hex(),
                "transcript": b.hex(),
                "result": result,
            }
        )

    def borrow(key_owner, at):
        """A cheat making a seat register another panel's identity key as its signing key (and sign its pop with it)."""

        def seat(i, s, _secrets):
            if i == at:
                s["signingKeyOverride"] = key_owner["keys"][0]
                s["popSigner"] = key_owner["secrets"][0]

        return {"seat": seat}

    add("author-honest-3", "A 2-of-3 author panel, every seat honest: all three qualify.", "author-3", [1, 2, 3], expect=[])
    add("author-lone", "A 1-of-1 author panel: one seat, no challenges, qualified with k_A = 1.", "author-1", [1], expect=[])
    add("author-k1-absent", "A 1-of-2 author panel with seat 2 absent: one qualified seat meets k_A = 1 and max(k_A, n_A - 1) = 1.", "author-2-k1", [1], expect=[(2, ["absent"])])
    add("author-short", "A 2-of-4 author panel with seats 3 and 4 absent: the transcript check passes with k_A = 2, but rule 7 needs 3.", "author-4", [1, 2], expect=[(3, ["absent"]), (4, ["absent"])])
    add(
        "author-duplicate-default",
        "Author seat 2 registers the default panel's seat-1 identity key as its signing key: duplicate-key across panels.",
        "author-3",
        [1, 2, 3],
        cheat=borrow(default, 2),
        expect=[(2, ["duplicate-key"])],
    )
    add(
        "default-duplicate-author",
        "In the default panel's run of the same election, seat 3 registers author seat 1's identity key as its signing key.",
        "default-4",
        [1, 2, 3, 4],
        cheat=borrow(panels["author-3"], 3),
        kind="default",
        expect=[(3, ["duplicate-key"])],
    )

    # The same transcript under another run's context: its signatures fail.
    honest = checked["author-honest-3"]
    contexts = []
    for id_, desc, tag, stub in [
        ("default-tag", "author-honest-3 checked with the panel's identifier under abolish/v1/panel", PANEL_TAG, ELECTION["authorStubHash"]),
        ("default-stub", "author-honest-3 checked over the default panel's stub hash", AUTHOR_PANEL_TAG, ELECTION["stubHash"]),
    ]:
        p = {**honest["panel"], "tag": tag}
        res = cv.check(p, honest["bytes"], {**ELECTION, "stubHash": stub})
        assert res == {"ok": False, "code": "ceremony-signature"}, id_
        contexts.append({"id": id_, "description": desc, "transcript": "author-honest-3", "kind": "default" if tag == PANEL_TAG else "author", "stubHash": stub.hex(), "code": res["code"]})

    # Approvals.
    records, approvals = {}, []

    def rec(id_, desc, tid, approvals_, thash=None, **kw):
        t = checked[tid]
        b = enc_record(thash or t["hash"], approvals_, **kw)
        records[id_] = {"id": id_, "description": desc, "transcript": tid, "record": b.hex()}
        return b

    def sig(tid, i, **kw):
        t = checked[tid]
        return approve(t["panel"], i, t["hash"], t["keySetHash"], **kw)

    T = "author-honest-3"
    good = [sig(T, i) for i in (1, 2, 3)]
    rec("all", "Every author seat approves.", T, good)
    rec("quorum", "Seats 1 and 3: q_A = max(2, 2) = 2.", T, [good[0], good[2]])
    rec("seat-1", "Seat 1 alone.", T, [good[0]])
    rec("seat-3", "Seat 3 alone.", T, [good[2]])
    rec("unordered", "Seats 2 then 1, each signature valid: the record counts for no one.", T, [good[1], good[0]])
    rec("repeated", "Seat 1 twice: not strictly increasing, so the record counts for no one.", T, [good[0], good[0]])
    rec("seat-4", "Seats 1, 2 and 4 of a 3-seat panel: out of range, so the record counts for no one.", T, [good[0], good[1], (4, good[2][1])])
    rec("seat-0", "Seat 0 then seat 1.", T, [(0, good[0][1]), good[1]])
    rec("swapped", "Seats 1 and 2 in order, each carrying the other's signature: neither verifies.", T, [(1, good[1][1]), (2, good[0][1])])
    rec(
        "wrong-key-set",
        "Seat 2 signs another key set hash: only seat 1 counts.",
        T,
        [good[0], approve(honest["panel"], 2, honest["hash"], H(b"author-ceremony-vectors/other-key-set"))],
    )
    rec("default-panel-id", "Seats 1 and 2 sign with the panel's identifier under abolish/v1/panel.", T, [sig(T, 1, tag=PANEL_TAG), sig(T, 2, tag=PANEL_TAG)])
    rec("default-stub", "Seats 1 and 2 sign over the default panel's stub hash.", T, [sig(T, 1, stub_hash=ELECTION["stubHash"]), sig(T, 2, stub_hash=ELECTION["stubHash"])])
    rec("other-signer", "Seat 2's slot carries a signature by seat 3's key over seat 2's statement.", T, [good[0], sig(T, 2, signer=3)])
    rec("other-transcript", "Seats 1 and 2 approve, naming another transcript hash (and signing over it).", T, [approve(honest["panel"], i, H(b"author-ceremony-vectors/other-transcript"), honest["keySetHash"]) for i in (1, 2)], thash=H(b"author-ceremony-vectors/other-transcript"))
    rec("lone", "The 1-of-1 panel's seat approves: q_A = max(1, 0) = 1.", "author-lone", [sig("author-lone", 1)])
    rec("k1-absent", "The 1-of-2 panel's seat 1 approves: q_A = max(1, 1) = 1.", "author-k1-absent", [sig("author-k1-absent", 1)])
    rec("short", "Both qualified seats of the short 2-of-4 run approve.", "author-short", [sig("author-short", 1), sig("author-short", 2)])
    b_all = bytes.fromhex(records["all"]["record"])

    cases = []

    def case(id_, desc, tid, names, extra=(), expect=None):
        t = checked[tid]
        bs = [bytes.fromhex(records[x]["record"]) for x in names] + list(extra)
        res = check_approvals(t["panel"], t, bs)
        assert (res["code"] if not res["ok"] else res["seats"]) == expect, (id_, res, expect)
        cases.append({"id": id_, "description": desc, "transcript": tid, "records": [b.hex() for b in bs], "result": res})

    case("all", "Every seat in one record.", T, ["all"], expect=[1, 2, 3])
    case("quorum", "Two seats, the quorum.", T, ["quorum"], expect=[1, 3])
    case("split", "Two records of one seat each: approvals count across records.", T, ["seat-1", "seat-3"], expect=[1, 3])
    case("below-quorum", "One seat of the two needed.", T, ["seat-1"], expect="author-approvals")
    case("seat-counts-once", "Seat 1 in two records, and alone: it counts once.", T, ["seat-1", "seat-1"], expect="author-approvals")
    case("unordered", "A record out of seat order counts for no one.", T, ["unordered"], expect="author-approvals")
    case("unordered-and-valid", "The out-of-order record beside a valid one: the valid one approves.", T, ["unordered", "quorum"], expect=[1, 3])
    case("repeated", "A repeated seat.", T, ["repeated"], expect="author-approvals")
    case("seat-4", "A seat beyond n_A spoils the whole record.", T, ["seat-4"], expect="author-approvals")
    case("seat-0", "Seat 0 spoils the whole record.", T, ["seat-0"], expect="author-approvals")
    case("swapped", "Signatures at the wrong seats count for no one.", T, ["swapped"], expect="author-approvals")
    case("wrong-key-set", "An approval over another key set hash counts for no one.", T, ["wrong-key-set"], expect="author-approvals")
    case("default-panel-id", "Approvals naming the default-panel form of the identifier.", T, ["default-panel-id"], expect="author-approvals")
    case("default-stub", "Approvals over the default panel's stub.", T, ["default-stub"], expect="author-approvals")
    case("other-signer", "Another seat's key signing for seat 2.", T, ["other-signer"], expect="author-approvals")
    case("other-transcript", "Only a record naming another transcript: none names this one.", T, ["other-transcript"], expect="author-approvals-missing")
    case("none", "No records at all.", T, [], expect="author-approvals-missing")
    case("undecodable", "A truncated copy of the full record beside the quorum record.", T, ["quorum"], extra=[b_all[:-1]], expect=[1, 3])
    case("undecodable-alone", "Only a truncated record: nothing names the transcript.", T, [], extra=[b_all[:-1]], expect="author-approvals-missing")
    case("lone", "The 1-of-1 panel.", "author-lone", ["lone"], expect=[1])
    case("k1-absent", "The 1-of-2 panel with one qualified seat.", "author-k1-absent", ["k1-absent"], expect=[1])
    case("short", "Two qualified seats where rule 7 needs three: refused whatever the records.", "author-short", ["short"], expect="ceremony-participation")

    boards = []
    for id_, tid, name, boarded, expect in [
        ("all", T, "all", False, None),
        ("quorum", T, "quorum", False, None),
        ("already-boarded", T, "all", True, "boarded"),
        ("below-quorum", T, "seat-1", False, "quorum"),
        ("unordered", T, "unordered", False, "seats"),
        ("seat-4", T, "seat-4", False, "seats"),
        ("wrong-key-set", T, "wrong-key-set", False, "signature"),
        ("other-signer", T, "other-signer", False, "signature"),
        ("other-transcript", T, "other-transcript", False, "transcript"),
        ("lone", "author-lone", "lone", False, None),
        ("repeated", T, "repeated", False, "seats"),
        ("seat-0", T, "seat-0", False, "seats"),
        ("short", "author-short", "short", False, "ceremony-participation"),
    ]:
        t = checked[tid]
        got = boarding(t["panel"], t, bytes.fromhex(records[name]["record"]), boarded)
        assert got == expect, (id_, got, expect)
        boards.append({"id": id_, "transcript": tid, "record": name, "boarded": boarded, "refusal": got})

    decode = []

    def dec(id_, desc, b, code):
        try:
            decode_record(b)
            raise AssertionError(id_)
        except DecodeFail as e:
            assert e.code == code, (id_, e.code)
        decode.append({"id": id_, "description": desc, "record": b.hex(), "error": code})

    dec("truncated", "The full record without its last byte.", b_all[:-1], "truncated")
    dec("trailing", "The full record with one more byte.", b_all + b"\x00", "trailing-bytes")
    dec("version-2", "Version 2: board-entry version 7 fixes version 1.", b_all[:2] + u8(2) + b_all[3:], "profile-mismatch")
    dec("record-type", "Record type 0x0005, a transcript.", u16(0x0005) + b_all[2:], "unknown-record-type")
    dec("over-max", "The count claims 17 approvals.", b_all[:35] + u32(17) + b_all[39:], "length-over-max")
    hi = b_all[:39 + 1 + 32] + (ecdsa.N - 1).to_bytes(32, "big") + b_all[39 + 65 :]
    dec("high-s", "Seat 1's signature has s > (n - 1) / 2.", hi, "non-canonical")
    dec("r-zero", "Seat 1's signature has r = 0.", b_all[:40] + bytes(32) + b_all[72:], "non-canonical")

    entries = []
    running = u16(RUNNING_OPENING) + u8(1) + bytes(8)
    for id_, desc, version, payload in [
        ("v7-approvals", "The full approvals record at index 3, segment 0, under version 7.", 7, b_all),
        ("v5-approvals", "The same payload under version 5, which doesn't allow it.", 5, b_all),
        ("v7-running-opening", "A running opening under version 7, which allows only version 5's types and the approvals.", 7, running),
        ("v7-transcript", "The author transcript under version 7.", 7, honest["bytes"]),
    ]:
        b = entry(version, 3, 0, payload)
        v = {"id": id_, "description": desc, "version": version, "entry": b.hex(), "error": entry_error(version, payload)}
        if v["error"] is None:
            v["entryHash"] = H(ds(ENTRY_TAG, b)).hex()
        entries.append(v)

    doc = {
        "format": "abolish-author-ceremony-vectors/1",
        "title": "The author panel's ceremony: its context and transcript check, the author approvals record, its check and boarding, and board-entry version 7",
        "spec": "docs/spec/ceremony.md (Author panel), docs/spec/board.md",
        "generator": "packages/crypto/scripts/author-ceremony-vectors.py: an independent Python implementation (standard library only), reusing ceremony-vectors.py's rounds and transcript check and key-set-vectors.py's key set hash and registration statement. Every value is test data, never keys",
        "tags": {t.decode(): t.decode() for t in [AUTHOR_PANEL_TAG, REGISTRATION_TAG, ENTRY_TAG]},
        "election": {
            "l2ChainId": str(ELECTION["l2ChainId"]),
            "trusteeRegistry": ELECTION["trusteeRegistry"].hex(),
            "electionId": ELECTION["electionId"].hex(),
            "stubHash": ELECTION["stubHash"].hex(),
            "authorStubHash": ELECTION["authorStubHash"].hex(),
        },
        "panels": {
            name: {
                "kind": "author" if "tag" in p else "default",
                "threshold": p["k"],
                "identitySecrets": [f"{d:064x}" for d in p["secrets"]],
                "keys": [k.hex() for k in p["keys"]],
                "panelId": panel_id(p).hex(),
            }
            for name, p in panels.items()
        },
        "transcripts": transcripts,
        "contexts": contexts,
        "records": list(records.values()),
        "approvals": cases,
        "boarding": boards,
        "decode": decode,
        "boardEntries": entries,
    }
    pathlib.Path(out, "author-ceremony.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
