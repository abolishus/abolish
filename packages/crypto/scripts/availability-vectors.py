#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/availability.json.

A second implementation of docs/spec/availability.md: the availability
attestation (record type 0x001b, version 1) and the availability complaint (0x001c,
version 1), their signed messages and signatures, their strict decoders, the
windows (c_I, t_A, c_A', t_A' and t_A' + R), and the availability check
(verifier 4.6) over the board contract's records, with every record code and
each panel's verdict at both points. It is written from the spec with
Python's integers and hashlib; signatures come from trustee-vectors.py's P-256
ECDSA, which reproduces RFC 6979 Appendix A.2.5 first. Nothing here shares
code with packages/crypto or any @noble library.

Every secret comes from SHA-256 over a fixed label, and each record lists the
signing secret that made it, so any RFC 6979 implementation reproduces its
bytes. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/availability-vectors.py <out-dir>
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

ATTESTATION = 0x001B
COMPLAINT = 0x001C
VERSION = 1
ATTESTATION_TAG = b"abolish/v1/sig/availability-attestation"
COMPLAINT_TAG = b"abolish/v1/sig/availability-complaint"
MAX_ROOTS = 32
CID_PREFIXES = (bytes([0x01, 0x55, 0x12, 0x20]), bytes([0x01, 0x70, 0x12, 0x20]))

# docs/spec/availability.md, Windows; docs/spec/delivery.md, Windows.
BALLOT_FETCH_ALLOWANCE = 43_200
COUNTED_FETCH_ALLOWANCE = 43_200
DELIVERY_WINDOW = 172_800


def u8(x):
    return bytes([x])


def u16(x):
    return x.to_bytes(2, "big")


def u32(x):
    return x.to_bytes(4, "big")


# --- The records -------------------------------------------------------------------


def attestation_message(f, record_type=ATTESTATION, version=VERSION):
    """u16(0x001b) ‖ u8(1) ‖ definition_hash ‖ u8(panel) ‖ u8(seat) ‖ u8(point) ‖ checkpoint_hash ‖ u32(r) ‖ roots."""
    return (
        u16(record_type)
        + u8(version)
        + f["definitionHash"]
        + u8(f["panel"])
        + u8(f["seat"])
        + u8(f["point"])
        + f["checkpointHash"]
        + u32(len(f["roots"]))
        + b"".join(f["roots"])
    )


def complaint_message(f, record_type=COMPLAINT, version=VERSION):
    """u16(0x001c) ‖ u8(1) ‖ definition_hash ‖ u8(panel) ‖ u8(seat) ‖ u8(point) ‖ checkpoint_hash ‖ cid."""
    return (
        u16(record_type)
        + u8(version)
        + f["definitionHash"]
        + u8(f["panel"])
        + u8(f["seat"])
        + u8(f["point"])
        + f["checkpointHash"]
        + f["cid"]
    )


def message(kind, f):
    return attestation_message(f) if kind == "attestation" else complaint_message(f)


def tag(kind):
    return ATTESTATION_TAG if kind == "attestation" else COMPLAINT_TAG


def sign(d, kind, f, as_tag=None):
    _, r, s = ecdsa.ecdsa_sign(d, ecdsa.ds(as_tag or tag(kind), message(kind, f)))
    return ecdsa.sig_bytes(r, s)


def p256_key(d):
    return ecdsa.compress(ecdsa.mul(d, ecdsa.G))


class Reject(Exception):
    def __init__(self, code, offset):
        super().__init__(code, offset)
        self.code, self.offset = code, offset


def decode(b, expected):
    """docs/spec/notation.md, Strict decoding, for a file whose known types are 0x001b and 0x001c, version 1 each."""
    at = 0

    def take(n):
        nonlocal at
        if len(b) - at < n:
            raise Reject("truncated", at)
        out = b[at : at + n]
        at += n
        return out

    def enum(values):
        v_at = at
        v = take(1)[0]
        if v not in values:
            raise Reject("invalid-enum", v_at)
        return v

    t = int.from_bytes(take(2), "big")
    if t not in (ATTESTATION, COMPLAINT):
        raise Reject("unknown-record-type", 0)
    if t != expected:
        raise Reject("unexpected-record-type", 0)
    v_at = at
    if take(1)[0] != VERSION:
        raise Reject("profile-mismatch", v_at)
    f = {"definitionHash": take(32)}
    f["panel"] = enum((1, 2))
    f["seat"] = take(1)[0]
    f["point"] = enum((1, 2))
    f["checkpointHash"] = take(32)
    if t == ATTESTATION:
        c_at = at
        count = int.from_bytes(take(4), "big")
        if count > MAX_ROOTS:
            raise Reject("length-over-max", c_at)
        if f["point"] == 1 and count != 0:
            raise Reject("non-canonical", c_at)
        roots = []
        for _ in range(count):
            h_at = at
            h = take(32)
            if roots and h <= roots[-1]:
                raise Reject("non-canonical", h_at)
            roots.append(h)
        f["roots"] = roots
    else:
        c_at = at
        cid = take(36)
        if cid[:4] not in CID_PREFIXES:
            raise Reject("non-canonical", c_at)
        f["cid"] = cid
    sig_at = at
    sig = take(64)
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if not (1 <= r < ecdsa.N and 1 <= s <= ecdsa.HALF_N):
        raise Reject("non-canonical", sig_at)
    if at != len(b):
        raise Reject("trailing-bytes", at)
    f["signature"] = sig
    return f


def encode(kind, f):
    return message(kind, f) + f["signature"]


# --- The windows ---------------------------------------------------------------------


def windows(closes_at, bound, counted_due, forced, margin):
    c_i = closes_at + bound + DELIVERY_WINDOW - forced - margin
    c_a2 = counted_due + COUNTED_FETCH_ALLOWANCE
    return {
        "ballotCutoff": c_i,
        "ballotDeadline": c_i + forced,
        "countedCutoff": c_a2,
        "countedDeadline": c_a2 + forced,
        "summing": c_a2 + forced + margin,
    }


# --- The check -------------------------------------------------------------------------


def check(election, events):
    """docs/spec/availability.md, Availability check."""
    panels = {p["panel"]: p for p in election["panels"]}
    records, rejected = [], []
    filled, attested, complained = set(), {}, {}
    # The contract's event order is block order, so submission times never decrease.
    assert all(a[1] <= b[1] for a, b in zip(events, events[1:]))
    for at, (payload, submitted) in enumerate(events):
        kind = "complaint" if payload[:2] == u16(COMPLAINT) else "attestation"
        try:
            f = decode(payload, COMPLAINT if kind == "complaint" else ATTESTATION)
        except Reject as e:
            rejected.append({"at": at, "error": e.code})
            continue
        panel = panels.get(f["panel"])
        key = None if panel is None else panel["registered"].get(f["seat"])
        signed = key is not None and ecdsa.verify(key, ecdsa.ds(tag(kind), message(kind, f)), f["signature"])
        if f["definitionHash"] != election["definitionHash"]:
            records.append({"at": at, "kind": kind, "code": "availability-stray", "signer": f["seat"] if signed else None})
            continue
        if key is None:
            records.append({"at": at, "kind": kind, "code": "availability-seat"})
            continue
        if not signed:
            records.append({"at": at, "kind": kind, "code": "availability-signature"})
            continue
        who = {"panel": f["panel"], "seat": f["seat"], "point": f["point"]}
        slot = (kind, f["panel"], f["seat"], f["point"])
        name = "ballot" if f["point"] == 1 else "counted"
        if slot in filled:
            code = "availability-repeat"
        else:
            filled.add(slot)
            if submitted > election["deadlines"][name]:
                code = "availability-late"
            elif election["checkpoints"][name] is None or f["checkpointHash"] != election["checkpoints"][name]:
                code = "availability-checkpoint"
            else:
                code = "valid"
                seat_key = (f["panel"], f["seat"], f["point"])
                if kind == "attestation":
                    attested[seat_key] = f["roots"]
                else:
                    complained[seat_key] = f["cid"]
        records.append({"at": at, "kind": kind, "code": code, **who})
    failures, points = [], []
    for point, name in ((1, "ballot"), (2, "counted")):
        out = []
        for p in election["panels"]:
            seats = sorted(p["registered"])
            att = [{"seat": s, "roots": attested[(p["panel"], s, point)]} for s in seats if (p["panel"], s, point) in attested]
            com = [
                {"seat": s, "cid": complained[(p["panel"], s, point)]}
                for s in seats
                if (p["panel"], s, point) in complained and (p["panel"], s, point) not in attested
            ]
            silent = [s for s in seats if (p["panel"], s, point) not in attested and (p["panel"], s, point) not in complained]
            holds = len(att) >= p["threshold"]
            if not holds:
                failures.append({"point": point, "panel": p["panel"]})
            out.append({"panel": p["panel"], "holds": holds, "attested": att, "complained": com, "silent": silent})
        points.append({"point": point, "checkpoint": election["checkpoints"][name], "panels": out})
    return {
        "verdict": "unavailable" if failures else "available",
        "failures": failures,
        "points": points,
        "records": records,
        "rejected": rejected,
    }


def hexed(v):
    """Bytes as hex, recursively, for the JSON file."""
    if isinstance(v, bytes):
        return v.hex()
    if isinstance(v, dict):
        return {k: hexed(x) for k, x in v.items()}
    if isinstance(v, list):
        return [hexed(x) for x in v]
    return v


# --- Vectors ---------------------------------------------------------------------------


def main():
    out = sys.argv[1]
    ecdsa.self_check()

    def secret(label):
        return ecdsa.secret(f"availability/{label}".encode())

    # A default panel of five seats, threshold 3, seats 1 to 4 qualified; and
    # an author panel of three, threshold 2, seats 1 to 3 qualified.
    secrets = {(1, i): secret(f"default-{i}") for i in range(1, 6)}
    secrets.update({(2, i): secret(f"author-{i}") for i in range(1, 4)})
    keys = {k: p256_key(d) for k, d in secrets.items()}
    default_registered = {i: keys[(1, i)] for i in (1, 2, 3, 4)}
    author_registered = {i: keys[(2, i)] for i in (1, 2, 3)}
    definition = ecdsa.sha256(b"availability/definition")
    other_definition = ecdsa.sha256(b"availability/other-definition")
    c_a = ecdsa.sha256(b"availability/checkpoint-ballot-extent")
    c_s = ecdsa.sha256(b"availability/checkpoint-counted-extent")
    other_checkpoint = ecdsa.sha256(b"availability/checkpoint-other")
    roots = sorted(ecdsa.sha256(f"availability/root-{i}".encode()) for i in range(3))
    cid_raw = bytes([0x01, 0x55, 0x12, 0x20]) + ecdsa.sha256(b"availability/segment-raw")
    cid_pb = bytes([0x01, 0x70, 0x12, 0x20]) + ecdsa.sha256(b"availability/segment-dag-pb")

    def attestation(panel, seat, point, *, checkpoint=None, roots_=(), d=None, definition_=definition, as_tag=None):
        f = {
            "definitionHash": definition_,
            "panel": panel,
            "seat": seat,
            "point": point,
            "checkpointHash": checkpoint if checkpoint is not None else (c_a if point == 1 else c_s),
            "roots": list(roots_),
        }
        f["signature"] = sign(secrets[(panel, seat)] if d is None else d, "attestation", f, as_tag)
        return f

    def complaint(panel, seat, point, *, checkpoint=None, cid=cid_raw, d=None, definition_=definition):
        f = {
            "definitionHash": definition_,
            "panel": panel,
            "seat": seat,
            "point": point,
            "checkpointHash": checkpoint if checkpoint is not None else (c_a if point == 1 else c_s),
            "cid": cid,
        }
        f["signature"] = sign(secrets[(panel, seat)] if d is None else d, "complaint", f)
        return f

    # --- Records, re-made byte for byte

    published = []

    def publish(id_, desc, kind, f):
        b = encode(kind, f)
        assert decode(b, ATTESTATION if kind == "attestation" else COMPLAINT) == f, id_
        if kind == "attestation":
            assert len(b) == 138 + 32 * len(f["roots"]), id_
        else:
            assert len(b) == 170, id_
        published.append(
            {
                "id": id_,
                "description": desc,
                "kind": kind,
                "signingSecret": secrets[(f["panel"], f["seat"])].to_bytes(32, "big").hex(),
                "signingKey": keys[(f["panel"], f["seat"])].hex(),
                "fields": hexed({k: v for k, v in f.items() if k != "signature"}),
                "message": message(kind, f).hex(),
                "signature": f["signature"].hex(),
                "encoding": b.hex(),
            }
        )
        return b

    a1 = publish("attestation-ballot-extent", "Default seat 1 attests the ballot extent: no roots, 138 bytes", "attestation", attestation(1, 1, 1))
    publish("attestation-counted-no-roots", "Default seat 2 attests the counted extent, holding no root", "attestation", attestation(1, 2, 2))
    publish("attestation-counted-one-root", "Default seat 3 attests the counted extent naming one root: 170 bytes", "attestation", attestation(1, 3, 2, roots_=roots[:1]))
    a_roots = publish("attestation-counted-three-roots", "Default seat 4 attests the counted extent naming three roots, ascending: 234 bytes", "attestation", attestation(1, 4, 2, roots_=roots))
    publish("attestation-author", "Author seat 2 attests the ballot extent: the panel byte is 2", "attestation", attestation(2, 2, 1))
    c1 = publish("complaint-raw", "Default seat 1 complains of the counted extent, naming a raw block's CID", "complaint", complaint(1, 1, 2))
    publish("complaint-dag-pb", "Author seat 3 complains of the ballot extent, naming a dag-pb root's CID", "complaint", complaint(2, 3, 1, cid=cid_pb))

    # --- Decode rejections

    decode_errors = []

    def rejected(id_, desc, kind, b, code, offset):
        expected = ATTESTATION if kind == "attestation" else COMPLAINT
        try:
            decode(b, expected)
        except Reject as e:
            assert (e.code, e.offset) == (code, offset), (id_, e.code, e.offset)
        else:
            raise AssertionError(id_)
        decode_errors.append({"id": id_, "description": desc, "kind": kind, "encoding": b.hex(), "error": code, "offset": offset})

    def at(b, i, v):
        c = bytearray(b)
        c[i] = v
        return bytes(c)

    rejected("empty", "No bytes", "attestation", b"", "truncated", 0)
    rejected("header-only", "A header and nothing else", "attestation", a1[:3], "truncated", 3)
    rejected("destruction-type", "Record type 0x000f, which this file doesn't know", "attestation", u16(0x000F) + a1[2:], "unknown-record-type", 0)
    rejected("complaint-as-attestation", "A complaint where an attestation is read", "attestation", c1, "unexpected-record-type", 0)
    rejected("attestation-as-complaint", "An attestation where a complaint is read", "complaint", a1, "unexpected-record-type", 0)
    rejected("version-2", "Version 2, which no contract-event version fixes", "attestation", at(a1, 2, 2), "profile-mismatch", 2)
    rejected("truncated-definition", "The definition hash cut short", "attestation", a1[:20], "truncated", 3)
    rejected("panel-0", "A panel byte of 0", "attestation", at(a1, 35, 0), "invalid-enum", 35)
    rejected("panel-3", "A panel byte of 3", "complaint", at(c1, 35, 3), "invalid-enum", 35)
    rejected("point-0", "A point of 0", "attestation", at(a1, 37, 0), "invalid-enum", 37)
    rejected("point-3", "A point of 3", "complaint", at(c1, 37, 3), "invalid-enum", 37)
    rejected("truncated-checkpoint", "The checkpoint hash cut short", "attestation", a1[:50], "truncated", 38)
    rejected("truncated-count", "Two bytes of the root count", "attestation", a1[:72], "truncated", 70)
    ballot_with_root = attestation_message({**attestation(1, 1, 1), "roots": roots[:1]})
    rejected("ballot-extent-with-root", "A root named at the ballot extent: non-canonical at the count", "attestation", ballot_with_root + a1[-64:], "non-canonical", 70)
    over = a_roots[:70] + u32(MAX_ROOTS + 1) + a_roots[74:]
    rejected("roots-over-max", "A count of 33 roots", "attestation", over, "length-over-max", 70)
    swapped = a_roots[:74] + roots[1] + roots[0] + a_roots[74 + 64 :]
    rejected("roots-unordered", "The first two roots swapped: non-canonical at the second", "attestation", swapped, "non-canonical", 106)
    repeated = a_roots[:74] + roots[0] + roots[0] + a_roots[74 + 64 :]
    rejected("roots-repeated", "The first root twice: non-canonical at the second", "attestation", repeated, "non-canonical", 106)
    rejected("truncated-in-roots", "The count promises three roots and two follow", "attestation", a_roots[: 74 + 64], "truncated", 138)
    rejected("cid-dag-cbor", "A complaint CID with the dag-cbor codec (0x71)", "complaint", at(c1, 71, 0x71), "non-canonical", 70)
    rejected("cid-version-0", "A complaint CID whose version byte is 0", "complaint", at(c1, 70, 0x00), "non-canonical", 70)
    rejected("cid-blake3", "A complaint CID naming blake3 (0x1e) as its hash", "complaint", at(c1, 72, 0x1E), "non-canonical", 70)
    rejected("cid-length-31", "A complaint CID whose digest length byte is 31", "complaint", at(c1, 73, 0x1F), "non-canonical", 70)
    rejected("truncated-cid", "The CID cut short", "complaint", c1[:90], "truncated", 70)
    rejected("truncated-in-signature", "The last byte of the signature missing", "attestation", a1[:-1], "truncated", 74)
    sig_at = len(c1) - 64
    high_s = bytearray(c1)
    s_val = int.from_bytes(c1[sig_at + 32 :], "big")
    high_s[sig_at + 32 :] = (ecdsa.N - s_val).to_bytes(32, "big")
    rejected("signature-high-s", "The signature's s replaced by n − s", "complaint", bytes(high_s), "non-canonical", sig_at)
    rejected("signature-r-zero", "The signature's r is 0", "attestation", a1[:74] + bytes(32) + a1[106:], "non-canonical", 74)
    rejected("trailing-byte", "One byte after the signature", "complaint", c1 + b"\x00", "trailing-bytes", len(c1))

    # --- Windows

    window_cases = []
    hour = 3600

    def window(id_, desc, closes_at, bound, counted_due, forced, margin):
        window_cases.append(
            {
                "id": id_,
                "description": desc,
                "closesAt": str(closes_at),
                "l1InclusionBound": str(bound),
                "countedDue": str(counted_due),
                "forcedInclusion": str(forced),
                "margin": str(margin),
                "result": {k: str(v) for k, v in windows(closes_at, bound, counted_due, forced, margin).items()},
            }
        )

    window("deployed", "F of 13 hours, R of one hour, a 10-minute inclusion bound: c_I 34 hours after closes_at + δ", 1_800_000_000, 600, 1_800_000_000 + 7 * 24 * hour, 13 * hour, hour)
    window("margin-9-hours", "R of 9 hours, the most the deployed windows allow: c_I 26 hours after closes_at + δ", 1_800_000_000, 3600, 1_800_500_000, 13 * hour, 9 * hour)
    window("no-forced-inclusion", "F and R of 0: every cutoff is its deadline", 0, 0, 0, 0, 0)

    # --- The check

    checks = []
    deadlines = {"ballot": 1_000_000, "counted": 2_000_000}
    t_a, t_a2 = deadlines["ballot"], deadlines["counted"]
    default_panel = {"panel": 1, "threshold": 3, "registered": default_registered}
    author_panel = {"panel": 2, "threshold": 2, "registered": author_registered}
    base = {
        "definitionHash": definition,
        "panels": [default_panel],
        "checkpoints": {"ballot": c_a, "counted": c_s},
        "deadlines": deadlines,
    }

    def case(id_, desc, events, expect, election=None):
        el = election or base
        # In submission-time order, as the contract's events are; records of
        # one time keep the order the case lists them in.
        evs = sorted(((encode(k, f) if not isinstance(f, bytes) else f, t) for k, f, t in events), key=lambda e: e[1])
        got = check(el, evs)
        for key, want in expect.items():
            assert got[key] == want, (id_, key, got[key], want)
        checks.append(
            {
                "id": id_,
                "description": desc,
                "election": {
                    "definitionHash": el["definitionHash"].hex(),
                    "panels": [
                        {
                            "panel": p["panel"],
                            "threshold": p["threshold"],
                            "registered": [{"index": i, "signingKey": p["registered"][i].hex()} for i in sorted(p["registered"])],
                        }
                        for p in el["panels"]
                    ],
                    "checkpoints": hexed(el["checkpoints"]),
                    "deadlines": {k: str(v) for k, v in el["deadlines"].items()},
                },
                "events": [{"payload": p.hex(), "submittedAt": str(t)} for p, t in evs],
                "result": hexed(got),
            }
        )

    A, C = "attestation", "complaint"
    honest = [(A, attestation(1, s, 1), t_a - 10) for s in (1, 2, 3, 4)] + [
        (A, attestation(1, s, 2, roots_=roots[:2]), t_a2 - 10) for s in (1, 2, 3, 4)
    ]
    case("all-attest", "Every qualified default seat attests both points in time: available", honest, {"verdict": "available", "failures": []})
    case(
        "quorum-exactly",
        "Three of four seats attest each point, the threshold: available, the fourth silent",
        [e for e in honest if e[1]["seat"] != 4],
        {"verdict": "available"},
    )
    case(
        "quorum-short-ballot",
        "Two seats attest the ballot extent, one complains and one is silent: unavailable at point 1",
        [(A, attestation(1, 1, 1), t_a), (A, attestation(1, 2, 1), t_a), (C, complaint(1, 3, 1), t_a)] + honest[4:],
        {"verdict": "unavailable", "failures": [{"point": 1, "panel": 1}]},
    )
    case(
        "complain-then-attest",
        "Seat 3 complains of the ballot extent and then attests it in time: its attestation counts and it isn't listed as complaining",
        [(C, complaint(1, 3, 1), t_a - 100)] + honest,
        {"verdict": "available"},
    )
    case(
        "late",
        "Two ballot-extent attestations a second past t_A and one counted-extent attestation a second past t_A': late, unavailable at point 1; point 2 still holds with three",
        [(A, attestation(1, 1, 1), t_a), (A, attestation(1, 2, 1), t_a + 1), (A, attestation(1, 3, 1), t_a + 1)]
        + [(A, attestation(1, s, 2), t_a2) for s in (1, 2, 3)]
        + [(A, attestation(1, 4, 2), t_a2 + 1)],
        {"verdict": "unavailable", "failures": [{"point": 1, "panel": 1}]},
    )
    case(
        "wrong-checkpoint",
        "Seats 1 and 2 attest the counted extent naming another checkpoint, and seat 3 names the ballot extent's: availability-checkpoint, unavailable at point 2",
        honest[:4]
        + [(A, attestation(1, 1, 2, checkpoint=other_checkpoint), t_a2), (A, attestation(1, 2, 2, checkpoint=other_checkpoint), t_a2)]
        + [(A, attestation(1, 3, 2, checkpoint=c_a), t_a2), (A, attestation(1, 4, 2), t_a2)],
        {"verdict": "unavailable", "failures": [{"point": 2, "panel": 1}]},
    )
    case(
        "no-checkpoint",
        "No counted checkpoint is at or before s_A: every ballot-extent attestation is availability-checkpoint",
        honest,
        {"verdict": "unavailable", "failures": [{"point": 1, "panel": 1}]},
        {**base, "checkpoints": {"ballot": None, "counted": c_s}},
    )
    case(
        "stray-seat-signature",
        "Beside three honest records per point: seat 1's key over another definition (stray, attributed), seat 5, which isn't qualified (seat), seat 4's fields signed by seat 2's key and seat 4's fields signed under the complaint tag (signature): none counts, and seat 4 is silent",
        honest[:3]
        + [
            (A, attestation(1, 1, 1, definition_=other_definition), t_a),
            (A, attestation(1, 5, 1), t_a),
            (A, attestation(1, 4, 1, d=secrets[(1, 2)]), t_a),
            (A, attestation(1, 4, 1, as_tag=COMPLAINT_TAG), t_a),
        ]
        + honest[4:7],
        {"verdict": "available"},
    )
    case(
        "stray-unattributed",
        "Another definition signed by a key this election never registered: stray, attributed to no one",
        [(A, attestation(1, 1, 1, definition_=other_definition, d=secret("stranger")), t_a)] + honest,
        {"verdict": "available"},
    )
    case(
        "repeats",
        "Seat 1's first ballot-extent attestation names another checkpoint and fills its slot, so its right one after it is a repeat; a byte-identical copy of seat 2's and seat 3's second complaint are repeats too. Only seats 2 and 4 attest the ballot extent: unavailable at point 1",
        [(A, attestation(1, 1, 1, checkpoint=other_checkpoint), t_a), (A, attestation(1, 1, 1), t_a), (A, attestation(1, 2, 1), t_a), (A, attestation(1, 2, 1), t_a)]
        + [(C, complaint(1, 3, 1), t_a), (C, complaint(1, 3, 1, cid=cid_pb), t_a), (A, attestation(1, 4, 1), t_a)]
        + honest[4:],
        {"verdict": "unavailable", "failures": [{"point": 1, "panel": 1}]},
    )
    case(
        "author-panel",
        "With an author panel of three, threshold 2: the default seats and author seats 1 and 2 attest both points, author seat 3 complains of the ballot extent: available",
        honest
        + [(A, attestation(2, s, 1), t_a) for s in (1, 2)]
        + [(C, complaint(2, 3, 1, cid=cid_pb), t_a)]
        + [(A, attestation(2, s, 2), t_a2) for s in (1, 2)],
        {"verdict": "available"},
        {**base, "panels": [default_panel, author_panel]},
    )
    case(
        "author-panel-without-key-set",
        "An author panel the board contract has no key set for: its seats' attestations are availability-seat, and it holds neither point",
        honest + [(A, attestation(2, s, 1), t_a) for s in (1, 2, 3)] + [(A, attestation(2, s, 2), t_a2) for s in (1, 2, 3)],
        {"verdict": "unavailable", "failures": [{"point": 1, "panel": 2}, {"point": 2, "panel": 2}]},
        {**base, "panels": [default_panel, {"panel": 2, "threshold": 2, "registered": {}}]},
    )
    case(
        "author-record-without-author-panel",
        "A record naming the author panel in a poll without one is availability-seat",
        honest + [(A, attestation(2, 1, 1), t_a)],
        {"verdict": "available"},
    )
    case(
        "rejected",
        "A version-2 copy of seat 1's attestation, a 3-byte payload and a destruction statement's header are rejected entries; the honest records beside them count",
        [(A, at(encode(A, attestation(1, 1, 1)), 2, 2), t_a), (A, bytes.fromhex("001b01"), t_a), (A, bytes.fromhex("000f01"), t_a)] + honest,
        {"verdict": "available"},
    )
    case("empty", "No records at all: every seat silent, unavailable at both points", [], {"verdict": "unavailable", "failures": [{"point": 1, "panel": 1}, {"point": 2, "panel": 1}]})
    case(
        "order",
        "The all-attest records in reverse order within each block give the same verdict",
        list(reversed(honest[:4])) + list(reversed(honest[4:])),
        {"verdict": "available"},
    )

    data = {
        "format": "abolish-availability-vectors/1",
        "title": "Availability attestations and availability complaints: the records, their windows and the availability check",
        "spec": "docs/spec/availability.md",
        "generator": (
            "packages/crypto/scripts/availability-vectors.py: an independent Python implementation of "
            "docs/spec/availability.md (Records, Windows, Availability check), with trustee-vectors.py's P-256 ECDSA, "
            "which reproduces RFC 6979 Appendix A.2.5 first"
        ),
        "tags": {"attestation": ATTESTATION_TAG.decode(), "complaint": COMPLAINT_TAG.decode()},
        "recordTypes": {"attestation": "0x001b", "complaint": "0x001c"},
        "version": VERSION,
        "allowances": {"ballot": str(BALLOT_FETCH_ALLOWANCE), "counted": str(COUNTED_FETCH_ALLOWANCE)},
        "records": published,
        "decodeErrors": decode_errors,
        "windows": window_cases,
        "checks": checks,
    }
    with open(f"{out}/availability.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
