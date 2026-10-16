#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/running-opening.json.

A second implementation of docs/spec/tally.md, Live results, Running opening
record: the running opening (record type 0x0018, version 1), its signed
message and signature, its strict decoder, attribution by the registered
signing keys, which running openings on a board are a chosen release's and
which are outside the schedule, when one passes against its release's
aggregate, and the board operator's boarding rule. It is written from the
spec with Python's integers and hashlib. Running sets and their openings come
from tally-vectors.py (ballots from ballot-validity-vectors.py over
group-vectors.py's self-checked ristretto255), and signatures from
trustee-vectors.py's P-256 ECDSA, which reproduces RFC 6979 Appendix A.2.5
first; nothing here shares code with packages/crypto or any @noble library.

Which snapshots a tier releases is an input here: live-release.json covers the
release choice and running sets from the board, this file the record that
publishes a release.

Every secret comes from SHA-256 over a fixed label, and each record lists the
signing secret that made it, so any RFC 6979 implementation reproduces its
bytes. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/running-opening-vectors.py <out-dir>
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
RECORD_TYPE = 0x0018
VERSION = 1
TALLY_OPENING = 0x0006
MAX_OPTIONS = 64
TAG = b"abolish/v1/sig/running-opening"
TALLY_OPENING_TAG = b"abolish/v1/sig/tally-opening"
AGGREGATE_TAG = b"abolish/v1/tally-aggregate"

u8, u32 = bv.u8, bv.u32


def scalar(x):
    return x.to_bytes(32, "little")


# --- The record ------------------------------------------------------------------


def enc_opening_list(opening):
    """`list<share, MAX_OPTIONS>`, each share `v ‖ r`; values are written as given, even ≥ ℓ."""
    return u32(len(opening)) + b"".join(scalar(s["v"]) + scalar(s["r"]) for s in opening)


def fields(o):
    """definition_hash ‖ u8(cell) ‖ u32(snapshot) ‖ aggregate_hash ‖ u8(signer) ‖ encode(opening)."""
    assert len(o["definitionHash"]) == 32 and len(o["aggregateHash"]) == 32
    return o["definitionHash"] + u8(o["cell"]) + u32(o["snapshot"]) + o["aggregateHash"] + u8(o["signer"]) + enc_opening_list(o["opening"])


def header(record_type=RECORD_TYPE, version=VERSION):
    return record_type.to_bytes(2, "big") + u8(version)


def statement(o):
    """m: the record's encoding without its signature, header included."""
    return header() + fields(o)


def aggregate_hash(agg):
    """H(DS("abolish/v1/tally-aggregate", list<element, MAX_OPTIONS> of each option's Ĉ)), identity allowed."""
    return bv.H(bv.ds(AGGREGATE_TAG, u32(len(agg)) + b"".join(grp.encode(row[0]) for row in agg)))


def sign(d, m, tag=TAG):
    _, r, s = ecdsa.ecdsa_sign(d, bv.ds(tag, m))
    return ecdsa.sig_bytes(r, s)


def p256_key(d):
    return ecdsa.compress(ecdsa.mul(d, ecdsa.G))


def encode(o, record_type=RECORD_TYPE, version=VERSION):
    return header(record_type, version) + fields(o) + o["signature"]


class Reject(Exception):
    def __init__(self, code, offset):
        super().__init__(code, offset)
        self.code, self.offset = code, offset


def decode(b, pinned=VERSION):
    """docs/spec/notation.md, Strict decoding, for a reader whose only known type is 0x0018 version 1."""
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
    snapshot = int.from_bytes(take(4), "big")
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
    return {
        "definitionHash": definition_hash,
        "cell": cell,
        "snapshot": snapshot,
        "aggregateHash": agg,
        "signer": signer,
        "opening": opening,
        "signature": sig,
    }


# --- The rules -----------------------------------------------------------------------


def attribution(registered, o):
    """docs/spec/tally.md, Running opening record, Signature: the seat, if `signer` is registered and its key verifies."""
    key = registered.get(o["signer"])
    if key is None:
        return None
    return o["signer"] if ecdsa.verify(key, bv.ds(TAG, statement(o)), o["signature"]) else None


def judge(election, o):
    """Which running openings are a release's, and whether one passes against its release's aggregate."""
    cells, chosen = election["runningSets"], election["chosen"]
    signer = attribution(election["registered"], o)
    q, c = o["snapshot"], o["cell"]
    if o["definitionHash"] != election["definitionHash"] or c >= len(cells) or q not in chosen[cells[c]["tier"]]:
        return {"kind": "outside-schedule", "signer": signer}
    m, k = election["optionCount"], election["threshold"]
    ballots = cells[c]["sets"][q]
    out = {"kind": "release", "snapshot": q, "cell": c, "signer": signer}
    if len(o["opening"]) != m:
        return {**out, "passes": False, "reason": "entries"}
    agg = tv.aggregate(m, k, ballots)
    if o["aggregateHash"] != aggregate_hash(agg):
        return {**out, "passes": False, "reason": "aggregate"}
    for j, s in enumerate(o["opening"]):
        if not grp.equal(bv.pedersen(s["v"], s["r"]), agg[j][0]):
            return {**out, "passes": False, "reason": "opening", "option": j}
    # Binding and the option proofs every entering ballot passed keep each count within the set.
    assert all(s["v"] <= len(ballots) for s in o["opening"])
    return {**out, "passes": True}


def read_board(election, payloads):
    """Every running-opening payload of the sealed extent in board order: undecodable ones are rejected
    entries; each chosen release's totals per cell, from its first passing opening (all agree under binding)."""
    entries, totals = [], {}
    for at, b in enumerate(payloads):
        try:
            o = decode(b)
        except Reject as e:
            entries.append({"at": at, "kind": "rejected", "error": e.code})
            continue
        verdict = judge(election, o)
        entries.append({"at": at, **verdict})
        if verdict.get("passes"):
            totals.setdefault((verdict["snapshot"], verdict["cell"]), [str(s["v"]) for s in o["opening"]])
    releases = []
    for c, cell in enumerate(election["runningSets"]):
        for q in sorted(election["chosen"][cell["tier"]]):
            releases.append({"snapshot": q, "cell": c, "counts": totals.get((q, c))})
    return {"entries": entries, "releases": releases}


def board(election, offered):
    """The operator's boarding rule over running openings offered in this order: it boards one only if it is
    a chosen release's opening in a cell, passes, is attributed to a registered seat, and that seat has no
    running opening of that release and cell on the board yet."""
    seen, out = set(), []
    for b in offered:
        try:
            o = decode(b)
        except Reject:
            out.append(False)
            continue
        v = judge(election, o)
        key = (v.get("snapshot"), v.get("cell"), v["signer"])
        ok = v["kind"] == "release" and v["passes"] and v["signer"] is not None and key not in seen
        if ok:
            seen.add(key)
        out.append(ok)
    return out


# --- Vectors ------------------------------------------------------------------------


def main():
    out = sys.argv[1]
    grp.self_check()
    ecdsa.self_check()

    def secret(label):
        return ecdsa.secret(f"running-opening/{label}".encode())

    # Seats 1 to 3 of a 2-of-3 panel; seat 3 took part but wasn't qualified,
    # so its per-election key isn't registered.
    secrets = {i: secret(f"seat-{i}") for i in (1, 2, 3)}
    keys = {i: p256_key(d) for i, d in secrets.items()}
    registered = {1: keys[1], 2: keys[2]}

    ctx = bv.context("running-opening-plurality", 3, 0, 1, 2, 3)
    definition_hash = ctx["definitionHash"]
    other_definition = bv.Rng("running-opening/other-definition").bytes32()
    m, k, n = ctx["optionCount"], ctx["threshold"], ctx["panelSize"]

    # One tier of two cells over four snapshots. Each nullifier's entering
    # ballot, in order of entry, with the snapshot at which it entered: running
    # sets only grow, so R_q is every ballot that entered at or before q.
    entries = {
        0: [(1, [1, 0, 0]), (1, [0, 1, 0]), (2, [1, 0, 0]), (2, [0, 0, 1]), (3, [0, 1, 0]), (4, [1, 0, 0])],
        1: [(1, [0, 0, 1]), (2, [0, 0, 1]), (2, [0, 1, 0]), (4, [1, 0, 0])],
    }
    snapshots = [1, 2, 3, 4]
    chosen = {0: [2, 4]}
    made = {c: [bv.make_ballot(f"running-opening/cell-{c}/{b}", ctx, v) for b, (_, v) in enumerate(es)] for c, es in entries.items()}

    def members(c, q):
        return [i for i, (at, _) in enumerate(entries[c]) if at <= q]

    def running_set(c, q):
        return [made[c][i][0]["vss"] for i in members(c, q)]

    def summed(c, q, seat):
        return tv.sum_shares(m, [made[c][i][2][seat - 1] for i in members(c, q)])

    def opening_of(c, q):
        honest = {i: summed(c, q, i) for i in range(1, n + 1)}
        return tv.honest_opening(m, honest, k)

    for c in entries:
        for q in snapshots:
            # Each seat's summed shares pass the summed-share check against the release's aggregate.
            agg = tv.aggregate(m, k, running_set(c, q))
            for seat in range(1, n + 1):
                for j, s in enumerate(summed(c, q, seat)):
                    rhs = tv.IDENTITY
                    for t in range(k):
                        rhs = grp.add(rhs, grp.mul(pow(seat, t, L), agg[j][t]))
                    assert grp.equal(bv.pedersen(s["v"], s["r"]), rhs)
            counts = [sum(entries[c][i][1][j] for i in members(c, q)) for j in range(m)]
            assert [s["v"] for s in opening_of(c, q)] == counts

    election = {
        "definitionHash": definition_hash,
        "optionCount": m,
        "threshold": k,
        "registered": registered,
        "chosen": chosen,
        "runningSets": [{"tier": 0, "sets": {q: running_set(c, q) for q in snapshots}} for c in entries],
    }
    agg_of = lambda c, q: aggregate_hash(tv.aggregate(m, k, running_set(c, q)))  # noqa: E731

    def record(cell, snapshot, signer, opening=None, d=None, definition=definition_hash, agg=None, signed_as=None, tag=TAG):
        """A running opening of `cell` at `snapshot` (by default the honest opening over its running set),
        signed with `d` (default: the signer's own secret) over `signed_as` (default: its own message) under `tag`."""
        d = secrets[signer] if d is None else d
        if opening is None:
            opening = opening_of(cell, snapshot)
        if agg is None:
            agg = agg_of(cell, snapshot) if cell in entries else bv.Rng("running-opening/no-cell").bytes32()
        o = {"definitionHash": definition, "cell": cell, "snapshot": snapshot, "aggregateHash": agg, "signer": signer, "opening": opening}
        m_ = signed_as if signed_as is not None else statement(o)
        return {**o, "signature": sign(d, m_, tag)}

    def bump(opening, j, key="v"):
        return [dict(s, **{key: (s[key] + 1) % L}) if i == j else s for i, s in enumerate(opening)]

    # Records reproduced byte for byte.
    records = []

    def published(id_, desc, o):
        b = encode(o)
        assert decode(b) == o
        assert attribution(registered, o) == o["signer"] or o["signer"] not in registered
        records.append(
            {
                "id": id_,
                "description": desc,
                "signingSecret": secrets[o["signer"]].to_bytes(32, "big").hex(),
                "signingKey": keys[o["signer"]].hex(),
                "definitionHash": o["definitionHash"].hex(),
                "cell": o["cell"],
                "snapshot": o["snapshot"],
                "aggregateHash": o["aggregateHash"].hex(),
                "signer": o["signer"],
                "opening": [{"v": str(s["v"]), "r": str(s["r"])} for s in o["opening"]],
                "message": statement(o).hex(),
                "signature": o["signature"].hex(),
                "encoding": b.hex(),
            }
        )
        return b

    honest_b = published("cell-0-release-2-seat-1", "Cell 0's opening of release 2 (four ballots), signed by seat 1", record(0, 2, 1))
    published("cell-1-release-4-seat-2", "Cell 1's opening of release 4 (four ballots), signed by seat 2", record(1, 4, 2))
    big_q = record(0, 0xFFFFFFFF, 1, opening=opening_of(0, 4), agg=agg_of(0, 4))
    published("snapshot-max", "Snapshot 2^32 − 1, written big-endian (any opening: this vector is about the bytes)", big_q)
    options_max = [{"v": j % 3, "r": (j * 0x1234567) % L} for j in range(MAX_OPTIONS)]
    max_b = published(
        "options-max",
        "MAX_OPTIONS entries (any values and aggregate hash: this vector is about the bytes)",
        record(1, 2, 2, opening=options_max, agg=bv.Rng("running-opening/options-max").bytes32()),
    )
    assert len(honest_b) == 141 + 64 * m

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

    honest = record(0, 2, 1)
    sig_at = len(honest_b) - 64
    count_at = 3 + 32 + 1 + 4 + 32 + 1
    rejected("empty", "No bytes", b"", "truncated", 0)
    rejected("header-only", "A header and nothing else", honest_b[:3], "truncated", 3)
    rejected("tally-opening-type", "The same bytes labelled record type 0x0006 (tally opening)", b"\x00\x06" + honest_b[2:], "unknown-record-type", 0)
    rejected("version-2", "Version 2, which no tally-opening version fixes", honest_b[:2] + b"\x02" + honest_b[3:], "profile-mismatch", 2)
    rejected("truncated-in-snapshot", "Cut inside the snapshot", honest_b[: 3 + 32 + 1 + 2], "truncated", 3 + 32 + 1)
    rejected("truncated-in-signature", "The last byte of the signature missing", honest_b[:-1], "truncated", sig_at)
    rejected("trailing-byte", "One byte after the signature", honest_b + b"\x00", "trailing-bytes", len(honest_b))
    first = honest["opening"]
    v_plus_l = dict(honest, opening=[dict(first[0], v=first[0]["v"] + L)] + first[1:])
    rejected("v-plus-order", "Option 0's count encoded as V + ℓ", encode(v_plus_l), "non-canonical", count_at + 4)
    r_is_l = dict(honest, opening=[first[0], dict(first[1], r=L)] + first[2:])
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
    r_is_n = honest_b[:sig_at] + ecdsa.N.to_bytes(32, "big") + honest_b[sig_at + 32 :]
    rejected("signature-r-order", "The signature's r is n", r_is_n, "non-canonical", sig_at)
    assert decode(max_b)["opening"] == options_max

    # Attribution: which seat, if any, each signature attributes a record to.
    attributions = []

    def attributed(id_, desc, o, want):
        got = attribution(registered, o)
        assert got == want, (id_, got, want)
        attributions.append({"id": id_, "description": desc, "encoding": encode(o).hex(), "signer": want})

    tally_fields = definition_hash + u8(0) + agg_of(0, 2) + u8(1) + enc_opening_list(opening_of(0, 2))
    attributed("registered", "Seat 1's own signature", honest, 1)
    attributed("unregistered-seat", "Seat 3 signs with its own key, but no key of seat 3 is registered", record(0, 2, 3), None)
    attributed("another-seats-key", "Names seat 1, signed with seat 2's key", record(0, 2, 1, d=secrets[2]), None)
    attributed("seat-zero", "Names seat 0, which no key set has", record(0, 2, 0, d=secrets[1]), None)
    moved = dict(honest, snapshot=4, aggregateHash=agg_of(0, 4), opening=opening_of(0, 4))
    attributed("moved-to-another-snapshot", "Seat 1's signed release 2 relabelled as release 4, with release 4's aggregate and opening", moved, None)
    attributed("moved-to-another-cell", "Seat 1's signed opening of cell 0 relabelled as cell 1", dict(honest, cell=1), None)
    attributed("other-definition", "Seat 1's signed opening with another definition hash", dict(honest, definitionHash=other_definition), None)
    attributed(
        "tally-opening-signature",
        "Seat 1's signature, under the tally opening's tag, over the tally opening's message with the same definition, cell, aggregate and opening",
        record(0, 2, 1, signed_as=tally_fields, tag=TALLY_OPENING_TAG),
        None,
    )
    attributed(
        "header-unsigned",
        "Seat 1's signature over the message without its header",
        record(0, 2, 1, signed_as=fields(honest)),
        None,
    )
    attributed("tag-over-other-version", "Seat 1's signature over the message with version byte 2", record(0, 2, 1, signed_as=header(version=2) + fields(honest)), None)

    # Boards: every running opening in a sealed extent, judged.
    boards = []

    def board_vector(id_, desc, records_, expect_entries=None, expect_releases=None):
        payloads = [o if isinstance(o, bytes) else encode(o) for o in records_]
        got = read_board(election, payloads)
        if expect_entries is not None:
            for at, want in expect_entries.items():
                for key, value in want.items():
                    assert got["entries"][at].get(key) == value, (id_, at, key, got["entries"][at])
        if expect_releases is not None:
            assert [r["counts"] is not None for r in got["releases"]] == expect_releases, (id_, got["releases"])
        boards.append({"id": id_, "description": desc, "payloads": [b.hex() for b in payloads], "result": got})

    full = [record(0, 2, 1), record(0, 4, 2), record(1, 2, 2), record(1, 4, 1)]
    board_vector("every-release", "Each chosen release (2 and 4) of each cell, one opening each", full, expect_releases=[True, True, True, True])
    board_vector(
        "release-missing",
        "Cell 1's release 4 has no opening: that cell has no totals for it, and every other release stands",
        full[:3],
        expect_releases=[True, True, True, False],
    )
    board_vector(
        "unchosen-snapshot",
        "A passing opening of cell 0 over snapshot 3's running set, which the release choice didn't choose, signed by seat 1: outside the schedule, attributed to seat 1, and never a release",
        [record(0, 3, 1)] + full,
        expect_entries={0: {"kind": "outside-schedule", "signer": 1}},
        expect_releases=[True, True, True, True],
    )
    board_vector(
        "outside-the-partition",
        "Openings naming cell 2, which the partition doesn't have, and another definition: outside the schedule",
        [record(2, 2, 1, opening=opening_of(0, 2)), record(0, 2, 2, definition=other_definition)] + full,
        expect_entries={0: {"kind": "outside-schedule", "signer": 1}, 1: {"kind": "outside-schedule", "signer": 2}},
    )
    board_vector(
        "snapshot-zero",
        "Snapshot 0, which no schedule has: outside the schedule",
        [record(0, 0, 1, opening=opening_of(0, 2), agg=agg_of(0, 2))] + full,
        expect_entries={0: {"kind": "outside-schedule"}},
    )
    board_vector(
        "another-set",
        "Seat 1's opening of release 4 in cell 0 over release 2's running set: correct for that set, but over another aggregate, so it doesn't pass; seat 2's honest one does",
        [record(0, 4, 1, opening=opening_of(0, 2), agg=agg_of(0, 2))] + full,
        expect_entries={0: {"kind": "release", "passes": False, "reason": "aggregate", "signer": 1}},
        expect_releases=[True, True, True, True],
    )
    one_less = [i for i in range(len(entries[0])) if entries[0][i][0] <= 2][:-1]
    near_vss = [made[0][i][0]["vss"] for i in one_less]
    near_opening = tv.honest_opening(m, {i: tv.sum_shares(m, [made[0][b][2][i - 1] for b in one_less]) for i in range(1, n + 1)}, k)
    near_agg = aggregate_hash(tv.aggregate(m, k, near_vss))
    board_vector(
        "one-ballot-apart",
        "Release 2's running set of cell 0 less its last ballot, opened and signed by seat 2 as release 2: it would disclose that ballot against release 2, so it doesn't pass (another aggregate) and the operator never boards it",
        [record(0, 2, 2, opening=near_opening, agg=near_agg)] + full,
        expect_entries={0: {"kind": "release", "passes": False, "reason": "aggregate", "signer": 2}},
    )
    board_vector(
        "wrong-count",
        "Seat 2's opening of release 2 in cell 0 with option 1's count one more: it fails at option 1, and seat 1's honest one passes",
        [record(0, 2, 2, opening=bump(opening_of(0, 2), 1))] + full,
        expect_entries={0: {"kind": "release", "passes": False, "reason": "opening", "option": 1, "signer": 2}},
    )
    board_vector(
        "short",
        "An opening of release 2 in cell 0 with two entries for three options",
        [record(0, 2, 1, opening=opening_of(0, 2)[:2])] + full[1:],
        expect_entries={0: {"kind": "release", "passes": False, "reason": "entries"}},
        expect_releases=[False, True, True, True],
    )
    board_vector(
        "unattributed-pass",
        "Release 2 in cell 0 opened only by seat 3, which isn't registered: it passes, unattributed, and the release stands",
        [record(0, 2, 3)] + full[1:],
        expect_entries={0: {"kind": "release", "passes": True, "signer": None}},
        expect_releases=[True, True, True, True],
    )
    board_vector(
        "tally-opening-beside",
        "Beside the releases, a tally opening (record type 0x0006) and a running opening labelled version 2: both are rejected entries here",
        full + [b"\x00\x06\x01" + fields(honest) + honest["signature"], encode(honest, version=2)],
        expect_entries={4: {"kind": "rejected", "error": "unknown-record-type"}, 5: {"kind": "rejected", "error": "profile-mismatch"}},
    )

    # Boarding: what the operator boards when running openings are offered in this order.
    boardings = []

    def boarding_vector(id_, desc, offered, want):
        payloads = [o if isinstance(o, bytes) else encode(o) for o in offered]
        got = board(election, payloads)
        assert got == want, (id_, got, want)
        boardings.append({"id": id_, "description": desc, "offered": [b.hex() for b in payloads], "boarded": got})

    boarding_vector(
        "first-per-seat",
        "Seat 1's opening of release 2 in cell 0 is boarded; the same bytes again are refused; seat 2's is boarded; seat 1's opening of release 4 is boarded",
        [honest, honest, record(0, 2, 2), record(0, 4, 1)],
        [True, False, True, True],
    )
    boarding_vector(
        "refused",
        "Each refused: unattributed (seat 3), another seat's key, an unchosen snapshot, another set's aggregate, a wrong count, a short list, another definition, a cell outside the partition, an undecodable payload",
        [
            record(0, 2, 3),
            record(0, 2, 1, d=secrets[2]),
            record(0, 3, 1),
            record(0, 4, 1, opening=opening_of(0, 2), agg=agg_of(0, 2)),
            record(0, 2, 2, opening=bump(opening_of(0, 2), 0)),
            record(0, 2, 2, opening=opening_of(0, 2)[:2]),
            record(0, 2, 1, definition=other_definition),
            record(2, 2, 1, opening=opening_of(0, 2)),
            honest_b[:-1],
        ],
        [False] * 9,
    )
    boarding_vector("releases-and-cells", "Every chosen release of every cell, each by one seat", full, [True] * 4)

    data = {
        "format": "abolish-running-opening-vectors/1",
        "title": "Running openings: the record, its signature, which openings are a release's, and the boarding rule",
        "spec": "docs/spec/tally.md",
        "generator": (
            "packages/crypto/scripts/running-opening-vectors.py: an independent Python implementation of "
            "docs/spec/tally.md (Live results, Running opening record), with running sets and openings from "
            "tally-vectors.py and trustee-vectors.py's P-256 ECDSA, which reproduces RFC 6979 Appendix A.2.5 first"
        ),
        "tag": TAG.decode(),
        "recordType": "0x0018",
        "version": VERSION,
        "election": {
            "definitionHash": definition_hash.hex(),
            "rules": {"optionCount": m, "threshold": k, "panelSize": n},
            "registered": [{"index": i, "signingKey": keys[i].hex()} for i in sorted(registered)],
            "chosen": [{"tier": t, "snapshots": qs} for t, qs in sorted(chosen.items())],
            "cells": [
                {
                    "cell": c,
                    "tier": 0,
                    "ballots": [{"enters": at, "vss": bv.enc_vss(made[c][i][0]["vss"]).hex()} for i, (at, _) in enumerate(entries[c])],
                    "aggregateHashes": [{"snapshot": q, "aggregateHash": agg_of(c, q).hex()} for q in snapshots],
                }
                for c in entries
            ],
        },
        "records": records,
        "decodeErrors": decode_errors,
        "attributions": attributions,
        "boards": boards,
        "boardings": boardings,
    }
    with open(f"{out}/running-opening.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
