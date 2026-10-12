#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/tally-opening.json.

A second implementation of docs/spec/tally.md, Opening record and Opening
checks: the tally opening (record type 0x0006, version 1), its signed message
and signature, its strict decoder, and the verifier's checks over every tally
opening on a board (verifier 7.2 to 7.4): which openings are a cell's and which
are stray, attribution by the registered signing keys, and the per-cell order
tally-missing, tally-opening, tally-conflict, tally-range. It is written from
the spec with Python's integers and hashlib. Cells and openings come from
tally-vectors.py (ballots from ballot-validity-vectors.py over group-vectors.py's
self-checked ristretto255), and signatures from trustee-vectors.py's P-256
ECDSA, which reproduces RFC 6979 Appendix A.2.5 first; nothing here shares
code with packages/crypto or any @noble library.

Every secret comes from SHA-256 over a fixed label, and each opening lists the
signing secret that made it, so any RFC 6979 implementation reproduces its
bytes. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/tally-opening-vectors.py <out-dir>
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


tv = _load("tally_vectors", "tally-vectors.py")
ecdsa = _load("trustee_vectors", "trustee-vectors.py")
bv, grp = tv.bv, tv.grp

L = grp.L
RECORD_TYPE = 0x0006
VERSION = 1
MAX_OPTIONS = 64
TAG = b"abolish/v1/sig/tally-opening"
AGGREGATE_TAG = b"abolish/v1/tally-aggregate"

u8, u32 = bv.u8, bv.u32


def scalar(x):
    return x.to_bytes(32, "little")


# --- The record ------------------------------------------------------------------


def enc_opening_list(opening):
    """`list<share, MAX_OPTIONS>`, each share `v ‖ r`; values are written as given, even ≥ ℓ."""
    return u32(len(opening)) + b"".join(scalar(s["v"]) + scalar(s["r"]) for s in opening)


def statement(definition_hash, cell, aggregate_hash, signer, opening):
    """m = definition_hash ‖ u8(cell) ‖ aggregate_hash ‖ u8(signer) ‖ encode(opening)."""
    assert len(definition_hash) == 32 and len(aggregate_hash) == 32
    return definition_hash + u8(cell) + aggregate_hash + u8(signer) + enc_opening_list(opening)


def aggregate_hash(agg):
    """H(DS("abolish/v1/tally-aggregate", list<element, MAX_OPTIONS> of each option's Ĉ)), identity allowed."""
    return bv.H(bv.ds(AGGREGATE_TAG, u32(len(agg)) + b"".join(grp.encode(row[0]) for row in agg)))


def sign(d, m):
    _, r, s = ecdsa.ecdsa_sign(d, bv.ds(TAG, m))
    return ecdsa.sig_bytes(r, s)


def p256_key(d):
    return ecdsa.compress(ecdsa.mul(d, ecdsa.G))


def encode(o, record_type=RECORD_TYPE, version=VERSION):
    return (
        record_type.to_bytes(2, "big")
        + u8(version)
        + statement(o["definitionHash"], o["cell"], o["aggregateHash"], o["signer"], o["opening"])
        + o["signature"]
    )


class Reject(Exception):
    def __init__(self, code, offset):
        super().__init__(code, offset)
        self.code, self.offset = code, offset


def decode(b, pinned=VERSION):
    """docs/spec/notation.md, Strict decoding, for a file whose only known type is 0x0006 version 1."""
    at = 0

    def take(n):
        nonlocal at
        if len(b) - at < n:
            raise Reject("truncated", at)
        out = b[at : at + n]
        at += n
        return out

    t = int.from_bytes(take(2), "big")
    if t != RECORD_TYPE:
        raise Reject("unknown-record-type", 0)
    v_at = at
    v = take(1)[0]
    if v != pinned:
        raise Reject("profile-mismatch", v_at)
    definition_hash = take(32)
    cell = take(1)[0]
    agg = take(32)
    signer = take(1)[0]
    count_at = at
    count = int.from_bytes(take(4), "big")
    if count > MAX_OPTIONS:
        raise Reject("length-over-max", count_at)
    opening = []
    for _ in range(count):
        pair = {}
        for key in ("v", "r"):
            x_at = at
            x = int.from_bytes(take(32), "little")
            if x >= L:
                raise Reject("non-canonical", x_at)
            pair[key] = x
        opening.append(pair)
    sig_at = at
    sig = take(64)
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if not (1 <= r < ecdsa.N and 1 <= s <= ecdsa.HALF_N):
        raise Reject("non-canonical", sig_at)
    if at != len(b):
        raise Reject("trailing-bytes", at)
    return {"definitionHash": definition_hash, "cell": cell, "aggregateHash": agg, "signer": signer, "opening": opening, "signature": sig}


# --- The checks --------------------------------------------------------------------


def attribution(registered, o):
    """docs/spec/tally.md, Signature: the seat, if `signer` is registered and its key verifies."""
    key = registered.get(o["signer"])
    if key is None:
        return None
    m = statement(o["definitionHash"], o["cell"], o["aggregateHash"], o["signer"], o["opening"])
    return o["signer"] if ecdsa.verify(key, bv.ds(TAG, m), o["signature"]) else None


def opens(agg, opening):
    """The first option whose (V, R) doesn't open the aggregate commitment, or None."""
    for j, s in enumerate(opening):
        if not grp.equal(bv.pedersen(s["v"], s["r"]), agg[j][0]):
            return j
    return None


def check_cell(m, k, registered, ballots, openings):
    agg = tv.aggregate(m, k, ballots)
    expected = aggregate_hash(agg)
    passing, failing = [], []
    for at, o in openings:
        signer = attribution(registered, o)
        if len(o["opening"]) != m:
            failing.append({"at": at, "signer": signer, "code": "tally-missing"})
            continue
        if o["aggregateHash"] != expected:
            failing.append({"at": at, "signer": signer, "code": "tally-aggregate"})
            continue
        j = opens(agg, o["opening"])
        if j is None:
            passing.append((at, signer, o["opening"]))
        else:
            failing.append({"at": at, "signer": signer, "code": "tally-opening", "option": j})
    out = {"passing": [{"at": at, "signer": s} for at, s, _ in passing], "failing": failing}
    if not passing:
        first_bad = next((f for f in failing if f["code"] != "tally-missing"), None)
        if first_bad is None:
            return {"ok": False, "code": "tally-missing", **out}
        if "option" not in first_bad:
            return {"ok": False, "code": "tally-opening", **out}
        return {"ok": False, "code": "tally-opening", "option": first_bad["option"], **out}
    first = passing[0][2]
    if any(p[2] != first for p in passing):
        return {"ok": False, "code": "tally-conflict", **out}
    for j, s in enumerate(first):
        if s["v"] > len(ballots):
            return {"ok": False, "code": "tally-range", "option": j, **out}
    return {"ok": True, "counts": [str(s["v"]) for s in first], **out}


def check_tally(definition_hash, m, k, registered, cells, payloads):
    """verifier 7.2 to 7.4 over the tally-opening payloads in board order; undecodable ones are rejected entries."""
    by_cell = [[] for _ in cells]
    stray, rejected = [], []
    for at, b in enumerate(payloads):
        try:
            o = decode(b)
        except Reject as e:
            rejected.append({"at": at, "error": e.code})
            continue
        if o["definitionHash"] == definition_hash and o["cell"] < len(cells):
            by_cell[o["cell"]].append((at, o))
        else:
            stray.append({"at": at, "signer": attribution(registered, o)})
    checked = [check_cell(m, k, registered, ballots, by_cell[c]) for c, ballots in enumerate(cells)]
    result = {"ok": all(c["ok"] for c in checked), "cells": checked, "stray": stray, "rejected": rejected}
    for c, r in enumerate(checked):
        if not r["ok"]:
            result["failure"] = {"cell": c, "code": r["code"], **({"option": r["option"]} if "option" in r else {})}
            break
    return result


# --- Vectors ------------------------------------------------------------------------


def main():
    out = sys.argv[1]
    grp.self_check()
    ecdsa.self_check()

    def secret(label):
        return ecdsa.secret(f"tally-opening/{label}".encode())

    # Seats 1 to 3 of a 2-of-3 panel; seat 3 took part but wasn't qualified,
    # so its per-election key isn't registered.
    secrets = {i: secret(f"seat-{i}") for i in (1, 2, 3)}
    keys = {i: p256_key(d) for i, d in secrets.items()}
    registered = {1: keys[1], 2: keys[2]}

    ctx = bv.context("tally-opening-plurality", 3, 0, 1, 2, 3)
    definition_hash = ctx["definitionHash"]
    other_definition = bv.Rng("tally-opening/other-definition").bytes32()
    m, k, n = ctx["optionCount"], ctx["threshold"], ctx["panelSize"]

    def make_cell(label, votes_list):
        made = [bv.make_ballot(f"tally-opening/{label}/{b}", ctx, v) for b, v in enumerate(votes_list)]
        vss = [vote["vss"] for vote, _, _ in made]
        honest = {i: tv.sum_shares(m, [shares[i - 1] for _, _, shares in made]) for i in range(1, n + 1)}
        return vss, tv.honest_opening(m, honest, k)

    tier0, open0 = make_cell("tier-0", [[1, 0, 0], [0, 0, 1], [1, 0, 0]])
    tier1, open1 = make_cell("tier-1", [[0, 1, 0], [0, 1, 0]])
    empty, open_empty = make_cell("empty", [])
    vote2, open_vote2 = make_cell("vote-of-two", [[2, 0, 0]])
    assert [s["v"] for s in open0] == [2, 0, 1] and [s["v"] for s in open1] == [0, 2, 0]
    assert open_empty == [{"v": 0, "r": 0}] * 3
    agg_of = lambda cell: aggregate_hash(tv.aggregate(m, k, cell))  # noqa: E731
    two = [tier0, tier1]

    def record(cell, signer, opening, d=None, definition=definition_hash, signed_as=None, cells=two, agg=None):
        """A tally opening over `cells[cell]`'s aggregate (or `agg`); `d` signs (default: the signer's own secret), over `signed_as` if given."""
        d = secrets[signer] if d is None else d
        if agg is None:
            agg = agg_of(cells[cell]) if cell < len(cells) else bv.Rng("tally-opening/no-cell").bytes32()
        what = signed_as or (definition, cell, agg, signer, opening)
        return {
            "definitionHash": definition,
            "cell": cell,
            "aggregateHash": agg,
            "signer": signer,
            "opening": opening,
            "signature": sign(d, statement(*what)),
        }

    def bump(opening, j, key="v"):
        return [dict(s, **{key: (s[key] + 1) % L}) if i == j else s for i, s in enumerate(opening)]

    # Records reproduced byte for byte.
    openings = []

    def published(id_, desc, cell, signer, opening, cells=two, agg=None):
        o = record(cell, signer, opening, cells=cells, agg=agg)
        definition = definition_hash
        b = encode(o)
        assert decode(b) == o
        openings.append(
            {
                "id": id_,
                "description": desc,
                "signingSecret": secrets[signer].to_bytes(32, "big").hex(),
                "signingKey": keys[signer].hex(),
                "definitionHash": definition.hex(),
                "cell": cell,
                "aggregateHash": o["aggregateHash"].hex(),
                "signer": signer,
                "opening": [{"v": str(s["v"]), "r": str(s["r"])} for s in opening],
                "message": statement(definition, cell, o["aggregateHash"], signer, opening).hex(),
                "signature": o["signature"].hex(),
                "encoding": b.hex(),
            }
        )
        return b

    honest_b = published("tier-0-seat-1", "Cell 0's opening, signed by seat 1", 0, 1, open0)
    published("tier-1-seat-2", "Cell 1's opening, signed by seat 2", 1, 2, open1)
    published("empty-cell", "An empty cell's opening: every (V, R) is (0, 0), over the identity aggregate", 0, 2, open_empty, cells=[empty])
    options_max = [{"v": j % 3, "r": (j * 0x1234567) % L} for j in range(MAX_OPTIONS)]
    max_b = published("options-max", "MAX_OPTIONS entries (any values and aggregate hash: this vector is about the bytes)", 1, 1, options_max, agg=bv.Rng("tally-opening/options-max").bytes32())

    # Decode rejections.
    decode_errors = []

    def rejected(id_, desc, b, code, offset):
        try:
            decode(b)
        except Reject as e:
            assert (e.code, e.offset) == (code, offset), (id_, e.code, e.offset)
        else:
            raise AssertionError(id_)
        decode_errors.append({"id": id_, "description": desc, "encoding": b.hex(), "error": code, "offset": offset})

    sig_at = len(honest_b) - 64
    count_at = 3 + 32 + 1 + 32 + 1
    rejected("empty", "No bytes", b"", "truncated", 0)
    rejected("header-only", "A header and nothing else", honest_b[:3], "truncated", 3)
    rejected("ceremony-type", "Record type 0x0005 where a tally opening is read", b"\x00\x05" + honest_b[2:], "unknown-record-type", 0)
    rejected("version-2", "Version 2, which the profile doesn't pin", honest_b[:2] + b"\x02" + honest_b[3:], "profile-mismatch", 2)
    rejected("truncated-in-signature", "The last byte of the signature missing", honest_b[:-1], "truncated", sig_at)
    rejected("trailing-byte", "One byte after the signature", honest_b + b"\x00", "trailing-bytes", len(honest_b))
    v_plus_l = record(0, 1, [dict(open0[0], v=open0[0]["v"] + L)] + open0[1:])
    rejected("v-plus-order", "Option 0's count encoded as V + ℓ", encode(v_plus_l), "non-canonical", count_at + 4)
    r_is_l = record(0, 1, [open0[0], dict(open0[1], r=L)] + open0[2:])
    rejected("r-equals-order", "Option 1's randomness encoded as ℓ", encode(r_is_l), "non-canonical", count_at + 4 + 64 + 32)
    over = honest_b[:count_at] + u32(MAX_OPTIONS + 1) + honest_b[count_at + 4 :]
    rejected("options-over-max", "A count of MAX_OPTIONS + 1", over, "length-over-max", count_at)
    rejected("truncated-list", "Three entries announced, one present", honest_b[: count_at + 4 + 64], "truncated", count_at + 4 + 64)
    high_s = bytearray(honest_b)
    s_val = int.from_bytes(honest_b[sig_at + 32 :], "big")
    high_s[sig_at + 32 :] = (ecdsa.N - s_val).to_bytes(32, "big")
    rejected("signature-high-s", "The signature's s replaced by n − s", bytes(high_s), "non-canonical", sig_at)
    zero_r = honest_b[:sig_at] + bytes(32) + honest_b[sig_at + 32 :]
    rejected("signature-r-zero", "The signature's r is 0", zero_r, "non-canonical", sig_at)
    assert decode(max_b)["opening"] == options_max

    # Elections: the checks over every opening on a board.
    elections = []

    def election(id_, desc, cells, records, expect, boarded_after=None):
        """`records` are tally openings, or raw payloads (bytes) that may not decode. `boarded_after`
        lists, per cell, ballots boarded after the counted extent that the re-vote rule would select:
        they never enter `cells`, and they fail the election as the operator's (`tally-late`, verifier
        7.1), though `result`, the tally check over the counted extent, still passes."""
        recs = [o if isinstance(o, bytes) else encode(o) for o in records]
        got = check_tally(definition_hash, m, k, registered, cells, recs)
        for key, want in expect.items():
            assert got.get(key) == want, (id_, key, got.get(key), want)
        entry = {"id": id_, "description": desc, "cells": [[bv.enc_vss(b).hex() for b in c] for c in cells], "openings": [b.hex() for b in recs], "result": got}
        if boarded_after is not None:
            entry["boardedAfter"] = [[bv.enc_vss(b).hex() for b in c] for c in boarded_after]
            if any(boarded_after):
                entry["election"] = {"code": "tally-late", "attributedTo": "operator"}
        elections.append(entry)

    honest0, honest1 = record(0, 1, open0), record(1, 2, open1)

    election("signed", "Two cells, each with one opening signed by a registered seat", two, [honest0, honest1], {"ok": True})
    election(
        "failing-attributed",
        "Cell 0 has seat 1's opening with option 1's count one more, then seat 2's honest one: the cell passes and the failure is seat 1's",
        two,
        [record(0, 1, bump(open0, 1)), record(0, 2, open0), honest1],
        {"ok": True},
    )
    election(
        "failing-unattributed",
        "Cell 0's failing opening carries seat 1's signature on the honest opening, so it is no one's",
        two,
        [record(0, 1, bump(open0, 0, "r"), signed_as=(definition_hash, 0, agg_of(tier0), 1, open0)), honest0, honest1],
        {"ok": True},
    )
    election(
        "only-failing",
        "Cell 0's only opening, signed by seat 2, has option 1's count one more: tally-opening at option 1, attributed to seat 2",
        two,
        [record(0, 2, bump(open0, 1)), honest1],
        {"ok": False, "failure": {"cell": 0, "code": "tally-opening", "option": 1}},
    )
    election("missing-cell", "Cell 1 has no opening: tally-missing", two, [honest0], {"ok": False, "failure": {"cell": 1, "code": "tally-missing"}})
    election(
        "short",
        "Cell 1's only opening, signed by seat 1, has two entries for three options: tally-missing, reported against seat 1",
        two,
        [honest0, record(1, 1, open1[:2])],
        {"ok": False, "failure": {"cell": 1, "code": "tally-missing"}},
    )
    election(
        "unattributed-pass",
        "Cell 0's opening is signed by seat 3, which isn't registered, and cell 1's by seat 2's key but names seat 1: both pass, unattributed",
        two,
        [record(0, 3, open0), record(1, 1, open1, d=secrets[2])],
        {"ok": True},
    )
    election(
        "replay-into-cell",
        "Seat 1's signed opening of cell 0 relabelled as cell 1, beside an honest cell 0: it is over another aggregate (tally-aggregate) and unattributed, so seat 1 isn't framed, and cell 1 fails tally-opening",
        two,
        [record(0, 2, open0), record(1, 1, open0, agg=agg_of(tier0), signed_as=(definition_hash, 0, agg_of(tier0), 1, open0))],
        {"ok": False, "failure": {"cell": 1, "code": "tally-opening"}},
    )
    election(
        "stray",
        "Honest openings plus three strays: seat 1's for cell 2, which the partition doesn't have (attributed), seat 2's naming another definition with its key (attributed), and one for another definition signed by a key this election never registered (unattributed)",
        two,
        [honest0, record(2, 1, open0), record(0, 2, open0, definition=other_definition), honest1, record(0, 1, open0, d=secret("other-election-seat-1"), definition=other_definition)],
        {"ok": True},
    )
    election(
        "duplicates",
        "Cell 0's opening signed by seats 1 and 2 and once more unattributed: all pass and agree",
        two,
        [honest0, record(0, 2, open0), record(0, 3, open0), honest1],
        {"ok": True},
    )
    election(
        "empty-cell",
        "Cell 0 is empty and its opening is all (0, 0); cell 1 is honest",
        [empty, tier1],
        [record(0, 2, open_empty, cells=[empty, tier1]), honest1],
        {"ok": True},
    )
    election(
        "range",
        "A single cell whose only ballot holds a vote of 2: the opening opens the aggregate with a count of 2 over 1 ballot (tally-range)",
        [vote2],
        [record(0, 1, open_vote2, cells=[vote2])],
        {"ok": False, "failure": {"cell": 0, "code": "tally-range", "option": 0}},
    )
    election(
        "first-failure-in-cell-order",
        "Both cells fail, cell 1 listed first on the board: the election's failure is cell 0's",
        two,
        [record(1, 1, bump(open1, 2)), record(0, 1, bump(open0, 0))],
        {"ok": False, "failure": {"cell": 0, "code": "tally-opening", "option": 0}},
    )

    election(
        "unpinned-version",
        "Beside honest openings, a copy of cell 1's opening labelled version 2 and a payload of three bytes: both are rejected entries, and the election passes",
        two,
        [honest0, encode(honest1, version=2), honest1, bytes.fromhex("000601")],
        {"ok": True, "rejected": [{"at": 1, "error": "profile-mismatch"}, {"at": 3, "error": "truncated"}]},
    )
    election(
        "two-failing-openings",
        "Cell 0's only openings both fail: seat 1's at option 2, then seat 2's at option 0. The cell reports the first failing opening in board order, option 2",
        two,
        [record(0, 1, bump(open0, 2)), record(0, 2, bump(open0, 0)), honest1],
        {"ok": False, "failure": {"cell": 0, "code": "tally-opening", "option": 2}},
    )
    election(
        "short-and-failing",
        "Cell 0 has a short opening and a full-length one that fails: tally-opening, not tally-missing",
        two,
        [record(0, 1, open0[:2]), record(0, 2, bump(open0, 1)), honest1],
        {"ok": False, "failure": {"cell": 0, "code": "tally-opening", "option": 1}},
    )

    # make_cell derives each ballot from its label and position, so these are tier 0's first two ballots.
    stale, open_stale = make_cell("tier-0", [[1, 0, 0], [0, 0, 1]])
    assert stale == tier0[:2]
    election(
        "other-counted-set",
        "Seat 1 opened cell 0 over a counted set without its last ballot: its opening is correct for that set but names another aggregate, so it is reported tally-aggregate against seat 1 (not a wrong sum), and cell 0 fails tally-opening with no option",
        two,
        [record(0, 1, open_stale, agg=agg_of(stale)), honest1],
        {"ok": False, "failure": {"cell": 0, "code": "tally-opening"}},
    )
    election(
        "other-counted-set-beside-honest",
        "Seat 1's opening over the stale counted set, then seat 2's over the right one: the cell passes",
        two,
        [record(0, 1, open_stale, agg=agg_of(stale)), record(0, 2, open0), honest1],
        {"ok": True},
    )

    late = make_cell("tier-0-late", [[0, 1, 0]])[0]
    election(
        "late-ballot",
        "Honest openings over the counted extent; a valid ballot for cell 0, which the re-vote rule would select, is boarded only after it (listed in boardedAfter). The counted set never includes it, so the tally check passes and no trustee is blamed (counting it would make both openings tally-aggregate), but the late ballot would have changed the counted set, so the election fails tally-late, attributed to the operator",
        two,
        [honest0, honest1],
        {"ok": True},
        boarded_after=[late, []],
    )
    widened = check_tally(definition_hash, m, k, registered, [tier0 + late, tier1], [encode(honest0), encode(honest1)])
    assert widened["cells"][0]["failing"] == [{"at": 0, "signer": 1, "code": "tally-aggregate"}]

    by_id = {e["id"]: e["result"] for e in elections}
    assert by_id["failing-attributed"]["cells"][0]["failing"] == [{"at": 0, "signer": 1, "code": "tally-opening", "option": 1}]
    assert by_id["failing-unattributed"]["cells"][0]["failing"][0]["signer"] is None
    assert by_id["only-failing"]["cells"][0]["failing"][0]["signer"] == 2
    assert by_id["short"]["cells"][1]["failing"] == [{"at": 1, "signer": 1, "code": "tally-missing"}]
    assert [p["signer"] for c in by_id["unattributed-pass"]["cells"] for p in c["passing"]] == [None, None]
    assert by_id["replay-into-cell"]["cells"][1]["failing"] == [{"at": 1, "signer": None, "code": "tally-aggregate"}]
    assert by_id["other-counted-set"]["cells"][0]["failing"] == [{"at": 0, "signer": 1, "code": "tally-aggregate"}]
    assert by_id["other-counted-set-beside-honest"]["cells"][0]["ok"]
    assert by_id["stray"]["stray"] == [{"at": 1, "signer": 1}, {"at": 2, "signer": 2}, {"at": 4, "signer": None}]
    assert [p["signer"] for p in by_id["duplicates"]["cells"][0]["passing"]] == [1, 2, None]

    data = {
        "format": "abolish-tally-opening-vectors/1",
        "title": "Tally openings: the record, its signature and the checks over a board's openings",
        "spec": "docs/spec/tally.md",
        "generator": (
            "packages/crypto/scripts/tally-opening-vectors.py: an independent Python implementation of "
            "docs/spec/tally.md (Opening record, Opening checks), with cells and openings from tally-vectors.py "
            "and trustee-vectors.py's P-256 ECDSA, which reproduces RFC 6979 Appendix A.2.5 first"
        ),
        "tag": TAG.decode(),
        "recordType": "0x0006",
        "version": VERSION,
        "election": {
            "definitionHash": definition_hash.hex(),
            "rules": {"optionCount": m, "threshold": k, "panelSize": n},
            "registered": [{"index": i, "signingKey": keys[i].hex()} for i in sorted(registered)],
        },
        "openings": openings,
        "decodeErrors": decode_errors,
        "elections": elections,
    }
    with open(f"{out}/tally-opening.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
