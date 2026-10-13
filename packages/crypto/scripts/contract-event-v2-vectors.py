#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event-v2.json.

A second implementation of docs/spec/contracts.md (Contract-event record,
Event tables (version 2)): record type 0x0008 version 2, its strict decoding,
and the event check under version 2's tables, which read the election
registry's definitions of versions 1 and 3 to 6, the trustee registry's
key-set registration layout, and the board's four events, each carrying a
record the board frames (Board, Ballots steps 1 and 3 to 5 and the proof's
points; Delivery records steps 1, 3 and 4) whose topics are the record's
`definition_hash` and `ballot_hash`, a ballot's recomputed from its bytes.

It reuses only this folder's other independent generators:
contract-event-vectors.py (version 1, from the same spec) for its Keccak-256,
ABI reader, version-1 checks of the events version 2 keeps unchanged, and
accumulator; group-vectors.py's self-checked RFC 9496 decoder, only to show
that an element this file frames is not a point. The BN254 G1 and G2 point
checks (on the curve or twist, the order-r subgroup) and the board's framing
are written here from the spec, EIP-196 and EIP-197, with Python's integers
and hashlib, and share no code with packages/crypto or packages/contracts.
The G2 checks are first run against every point verdict of
membership-proof.json, which snarkjs and @noble/curves agree on.

Election definitions come from the election-definition vector files of
versions 1 and 3 to 7, whose verdicts (decodes, or the decode error) this
script takes as given, as version 1's generator does. Ballots come from
ballot.json, ballot-v2.json and ballot-v3.json (version-3 records are built
from the file's committed votes and contexts, with a version-2 record's
membership proof and L1 reference, and their ballot hashes compared with the
file's), and delivery records from delivery.json.

Usage: python3 -I -B packages/crypto/scripts/contract-event-v2-vectors.py <repo-root>,
then `vp check --fix`.
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


v1 = _load("contract_event_vectors", "contract-event-vectors.py")
grp = _load("group_vectors", "group-vectors.py")

word, abi_bytes, uint_of, abi_tail, sig_topic, u64 = (
    v1.word, v1.abi_bytes, v1.uint_of, v1.abi_tail, v1.sig_topic, v1.u64,
)
Reject = v1.Reject

RECORD_TYPE = 0x0008
VERSION = 2
MAX_EVENT_DATA = v1.MAX_EVENT_DATA
MAX_EVENT_TOPICS = v1.MAX_EVENT_TOPICS
MAX_U64 = v1.MAX_U64

MAX_OPTIONS = 64
MAX_TRUSTEES = 16
MAX_QUESTIONS = 32
MAX_BRANCHES = MAX_OPTIONS + 1
MAX_SEALED = 4 + 64 * MAX_OPTIONS + 16
MLKEM_CT_LEN = 1088

P25519 = 2**255 - 19
ELL = 2**252 + 27742317777372353535851937790883648493
BN254_P = 0x30644E72E131A029B85045B68181585D97816A916871CA8D3C208C16D87CFD47
BN254_R = 0x30644E72E131A029B85045B68181585D2833E84879B9709143E1F593F0000001
P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551

BALLOT, RECEIPT, POSTING, COMPLAINT = 0x0002, 0x000C, 0x000D, 0x000E
BALLOT_TAG = b"abolish/v1/ballot"


def H(m):
    return hashlib.sha256(m).digest()


def ds(tag, m):
    return bytes([len(tag)]) + tag + m


# ----------------------------------------------------------- the record

def encode(contract, n, block, timestamp, topics, data):
    return v1.encode(contract, n, block, timestamp, topics, data, version=VERSION)


def decode(b):
    """Strict decoding with version 2 pinned (notation.md, Strict decoding)."""
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
    if take(1)[0] != VERSION:
        raise Reject("profile-mismatch", 2)
    contract = take(20)
    n = int.from_bytes(take(8), "big")
    block = int.from_bytes(take(8), "big")
    timestamp = int.from_bytes(take(8), "big")
    k_at = at
    k = int.from_bytes(take(4), "big")
    if k > MAX_EVENT_TOPICS:
        raise Reject("length-over-max", k_at)
    topics = [take(32) for _ in range(k)]
    d_at = at
    d = int.from_bytes(take(4), "big")
    if d > MAX_EVENT_DATA:
        raise Reject("length-over-max", d_at)
    data = take(d)
    if at != len(b):
        raise Reject("trailing-bytes", at)
    return {"contract": contract, "n": n, "block": block, "timestamp": timestamp, "topics": topics, "data": data}


# ----------------------------------------------------------- BN254 points

def g1_ok(x, y):
    """A G1 point from canonical coordinates: below p, on y^2 = x^3 + 3, not (0, 0)."""
    if x >= BN254_P or y >= BN254_P or (x == 0 and y == 0):
        return False
    return (y * y - x * x * x - 3) % BN254_P == 0


# Fp2 = Fp[u] / (u^2 + 1), elements (c0, c1).
def f2_add(a, b):
    return ((a[0] + b[0]) % BN254_P, (a[1] + b[1]) % BN254_P)


def f2_sub(a, b):
    return ((a[0] - b[0]) % BN254_P, (a[1] - b[1]) % BN254_P)


def f2_mul(a, b):
    return ((a[0] * b[0] - a[1] * b[1]) % BN254_P, (a[0] * b[1] + a[1] * b[0]) % BN254_P)


def f2_inv(a):
    norm = (a[0] * a[0] + a[1] * a[1]) % BN254_P
    i = pow(norm, BN254_P - 2, BN254_P)
    return (a[0] * i % BN254_P, -a[1] * i % BN254_P)


TWIST_B = f2_mul((3, 0), f2_inv((9, 1)))  # 3 / (9 + u), EIP-197


def g2_add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0]:
        if f2_add(p[1], q[1]) == (0, 0):
            return None
        lam = f2_mul(f2_mul((3, 0), f2_mul(p[0], p[0])), f2_inv(f2_mul((2, 0), p[1])))
    else:
        lam = f2_mul(f2_sub(q[1], p[1]), f2_inv(f2_sub(q[0], p[0])))
    x = f2_sub(f2_sub(f2_mul(lam, lam), p[0]), q[0])
    return (x, f2_sub(f2_mul(lam, f2_sub(p[0], x)), p[1]))


def g2_mul(k, p):
    out = None
    while k:
        if k & 1:
            out = g2_add(out, p)
        p = g2_add(p, p)
        k >>= 1
    return out


def g2_ok(x1, x0, y1, y0):
    """A G2 point (imaginary parts first): canonical, not 0, on the twist, in the order-r subgroup."""
    if any(c >= BN254_P for c in (x1, x0, y1, y0)) or not (x1 or x0 or y1 or y0):
        return False
    x, y = (x0, x1), (y0, y1)
    if f2_sub(f2_mul(y, y), f2_add(f2_mul(f2_mul(x, x), x), TWIST_B)) != (0, 0):
        return False
    return g2_mul(BN254_R, (x, y)) is None


def proof_ok(b):
    """membership.md, Proof encoding: A, B and C each canonical and in its group."""
    w = [int.from_bytes(b[i : i + 32], "big") for i in range(0, 256, 32)]
    return len(b) == 256 and g1_ok(w[0], w[1]) and g2_ok(w[2], w[3], w[4], w[5]) and g1_ok(w[6], w[7])


# ----------------------------------------------------------- the board's framing

class Frame(Exception):
    pass


class Cursor:
    def __init__(self, b, at):
        self.b, self.at = b, at

    def take(self, n):
        if len(self.b) - self.at < n:
            raise Frame("truncated")
        out = self.b[self.at : self.at + n]
        self.at += n
        return out

    def count(self, most):
        c = int.from_bytes(self.take(4), "big")
        if c > most:
            raise Frame("length-over-max")
        return c

    def element(self):
        s = int.from_bytes(self.take(32), "little")
        if s == 0 or s >= P25519 or s & 1:
            raise Frame("element")

    def scalar(self):
        if int.from_bytes(self.take(32), "little") >= ELL:
            raise Frame("scalar")

    def sig(self):
        r = int.from_bytes(self.take(32), "big")
        s = int.from_bytes(self.take(32), "big")
        if not (1 <= r < P256_N and 1 <= s <= (P256_N - 1) // 2):
            raise Frame("signature")

    def end(self):
        if self.at != len(self.b):
            raise Frame("trailing-bytes")


def frame_ballot(rec):
    """Board, Ballots, steps 1 and 3 to 5 and the proof's points: (definition_hash, ballot_hash) or None."""
    try:
        c = Cursor(rec, 0)
        if int.from_bytes(c.take(2), "big") != BALLOT:
            raise Frame("type")
        version = c.take(1)[0]
        if version not in (1, 2, 3):
            raise Frame("version")
        c.take(32)
        if version == 1 and c.take(1)[0] > 2:
            raise Frame("tier")
        if version != 1:
            c.take(1)
        if int.from_bytes(c.take(32), "big") >= BN254_R:
            raise Frame("nullifier")
        c.take(8 + 32)
        if not proof_ok(c.take(256)):
            raise Frame("proof")
        for _ in range(c.count(MAX_OPTIONS)):
            for _ in range(c.count(MAX_TRUSTEES)):
                c.element()
        for _ in range(c.count(MAX_TRUSTEES)):
            c.take(32)
        for _ in range(4 * c.count(MAX_OPTIONS)):
            c.scalar()
        if version < 3:
            for _ in range(2 * c.count(MAX_BRANCHES)):
                c.scalar()
        else:
            for _ in range(c.count(MAX_QUESTIONS)):
                for _ in range(2 * c.count(MAX_BRANCHES)):
                    c.scalar()
        c.end()
    except Frame:
        return None
    return rec[3:35], H(ds(BALLOT_TAG, rec[3:35] + rec[0:3] + rec[35:68] + rec[364:]))


def frame_delivery(t, rec):
    """Board, Delivery records, steps 1, 3 and 4: (definition_hash, ballot_hash) or None."""
    try:
        c = Cursor(rec, 0)
        if int.from_bytes(c.take(2), "big") != t or c.take(1)[0] != 1:
            raise Frame("header")
        c.take(32 + 32 + 1)
        if t == RECEIPT:
            c.take(32)
            c.sig()
        elif t == POSTING:
            c.take(32 + MLKEM_CT_LEN)
            c.element()
            c.scalar()
            c.scalar()
            c.take(c.count(MAX_SEALED))
        else:
            c.element()
            c.scalar()
            c.scalar()
            c.sig()
        c.end()
    except Frame:
        return None
    return rec[3:35], rec[35:67]


# ----------------------------------------------------------- the event check

SIGNATURES = {
    "election-registry": list(v1.SIGNATURES["election-registry"]),
    "trustee-registry": list(v1.SIGNATURES["trustee-registry"]),
    "group-registry": list(v1.SIGNATURES["group-registry"]),
    "board": [
        "BallotSubmitted(bytes32,bytes32,bytes)",
        "ShareReceiptSubmitted(bytes32,bytes32,bytes)",
        "SharePosted(bytes32,bytes32,bytes)",
        "ShareComplaintSubmitted(bytes32,bytes32,bytes)",
    ],
}

INDEXED = dict(v1.INDEXED)
for _s in SIGNATURES["board"]:
    INDEXED[_s.split("(")[0]] = ["definitionHash", "ballotHash"]

BOARD_FRAMES = {
    "BallotSubmitted": frame_ballot,
    "ShareReceiptSubmitted": lambda r: frame_delivery(RECEIPT, r),
    "SharePosted": lambda r: frame_delivery(POSTING, r),
    "ShareComplaintSubmitted": lambda r: frame_delivery(COMPLAINT, r),
}


def event_check(rec, contracts, definitions):
    """Version 2's event check: (role, event, fields) or the first failing code."""
    role = next((r for r, a in contracts.items() if a == rec["contract"]), None)
    if role is None:
        return "unknown-contract"
    topics, data = rec["topics"], rec["data"]
    names = {sig_topic(s): s for s in SIGNATURES[role]}
    if not topics or topics[0] not in names:
        return "unknown-event"
    name = names[topics[0]].split("(")[0]
    if len(topics) != 1 + len(INDEXED[name]):
        return "event-topics"

    if name == "DefinitionRegistered":
        w = [data[i : i + 32] for i in range(0, min(len(data), 128), 32)]
        body = abi_tail(data, 4, 3, 1)
        if body is None or any(uint_of(w[i], 64) is None for i in range(2)):
            return "event-data"
        # Versions 1 and 3 to 6, as the registry decodes them (rule 2).
        if not definitions.get(body.hex(), False):
            return "event-data"
        return {
            "event": name,
            "electionId": topics[1].hex(),
            "definitionHash": topics[2].hex(),
            "l1Origin": {"number": str(uint_of(w[0], 64)), "timestamp": str(uint_of(w[1], 64)), "hash": w[2].hex()},
            "definition": body.hex(),
        }
    if name == "CeremonyRegistered":
        body = abi_tail(data, 1, 0, 1)
        if body is None or len(body) < 97:
            return "event-data"
        count_at = 97 + 97 * body[96]
        if len(body) < count_at + 1 or len(body) != count_at + 1 + 65 * body[count_at]:
            return "event-data"
        return {
            "event": name,
            "stubHash": topics[1].hex(),
            "panelId": topics[2].hex(),
            "transcriptHash": topics[3].hex(),
            "registration": body.hex(),
        }
    if name in BOARD_FRAMES:
        body = abi_tail(data, 1, 0, 1)
        framed = body is not None and BOARD_FRAMES[name](body)
        if not framed or framed != (topics[1], topics[2]):
            return "event-data"
        return {"event": name, "definitionHash": topics[1].hex(), "ballotHash": topics[2].hex(), "record": body.hex()}
    # Every other event is checked as version 1 checks it.
    return v1.event_check(rec, contracts, {})


# ----------------------------------------------------------- vectors

def det(label, n):
    return v1.det(f"v2/{label}", n)


def main(root):
    vec = root / "docs/spec/vectors"

    def load(name):
        return json.loads((vec / name).read_text())

    # --- the G2 checks agree with membership-proof.json on every point.
    mp = load("membership-proof.json")
    for p in mp["proofs"]:
        assert proof_ok(bytes.fromhex(p["proof"])), p["name"]
    for p in mp["decode"]:
        assert not proof_ok(bytes.fromhex(p["proof"])), p["name"]
    outside = next(bytes.fromhex(p["proof"]) for p in mp["decode"] if p["name"] == "b-outside-subgroup")
    off_twist = next(bytes.fromhex(p["proof"]) for p in mp["decode"] if p["name"] == "b-off-curve")

    # --- definitions: each file's verdict; versions 1 and 3 to 6 decode, 7 never does.
    definitions = {}
    by_id = {}
    for name, version in (
        ("election-definition.json", 1),
        ("election-definition-v3.json", 3),
        ("election-definition-v4.json", 4),
        ("election-definition-v5.json", 5),
        ("election-definition-v6.json", 6),
        ("election-definition-v7.json", 7),
    ):
        for v in load(name)["vectors"]:
            enc = bytes.fromhex(v["encoding"])
            by_id[v["id"]] = enc
            definitions[v["encoding"]] = version != 7 and "error" not in v
    definitions[by_id["definition-maximal"][:-1].hex()] = False

    # --- ballots and their hashes, each compared with its own file's.
    b1 = load("ballot.json")
    b2 = load("ballot-v2.json")
    b3 = load("ballot-v3.json")
    ballots = {}
    for prefix, f in (("v1/", b1), ("v2/", b2)):
        for b in f["ballots"]:
            rec = bytes.fromhex(b["encoding"])
            framed = frame_ballot(rec)
            assert framed is not None and framed[1].hex() == b["ballotHash"], b["id"]
            ballots[prefix + b["id"]] = rec
        # Each decode rejection but a pin's: a record of another version is
        # framed under its own, and its election's pin is the board's to check.
        for b in f["decode"]:
            if b["error"] != "profile-mismatch":
                assert frame_ballot(bytes.fromhex(b["encoding"])) is None, b["id"]
    donor = next(r for i, r in ballots.items() if r[2] == 2)
    for b in b3["ballots"]:
        if "ballotHash" not in b:
            continue
        ctx = b["context"]
        rec = (
            bytes([0, 2, 3]) + bytes.fromhex(ctx["definitionHash"]) + bytes([ctx["cell"]])
            + int(ctx["nullifier"]).to_bytes(32, "big") + donor[68:364] + bytes.fromhex(b["encoding"])
        )
        framed = frame_ballot(rec)
        assert framed is not None and framed[1].hex() == b["ballotHash"], b["id"]
        ballots["v3/" + b["id"]] = rec

    dl = load("delivery.json")
    delivery = {r["id"]: bytes.fromhex(r["encoding"]) for r in dl["records"]}
    for r in delivery.values():
        assert frame_delivery(int.from_bytes(r[:2], "big"), r) is not None
    types = {"share-receipt": RECEIPT, "share-posting": POSTING, "share-complaint": COMPLAINT}
    for r in dl["decode"]:
        assert frame_delivery(types[r["type"]], bytes.fromhex(r["encoding"])) is None, r["id"]

    chain_id = 84532
    contracts = {r: det(r, 20) for r in ("election-registry", "trustee-registry", "group-registry", "board")}
    T = {s.split("(")[0]: sig_topic(s) for sigs in SIGNATURES.values() for s in sigs}
    er, tr, gr, board = (contracts[r] for r in ("election-registry", "trustee-registry", "group-registry", "board"))

    records = []
    failures = []
    counters = {r: 0 for r in contracts}
    clock = [1_760_000_000]

    def record(rid, description, contract, topics, data, honest=True):
        role = next((r for r, a in contracts.items() if a == contract), None)
        if honest:
            n, block = counters[role], 100 + len(records)
            counters[role] += 1
        else:
            n, block = 0, 1
        ts = clock[0] + 2 * block
        rec = {"contract": contract, "n": n, "block": block, "timestamp": ts, "topics": topics, "data": data}
        enc = encode(contract, n, block, ts, topics, data)
        assert decode(enc) == rec
        result = event_check(rec, contracts, definitions)
        entry = {
            "id": rid,
            "description": description,
            "fields": {
                "contract": contract.hex(),
                "n": str(n),
                "l2Block": str(block),
                "l2Timestamp": str(ts),
                "topics": [t.hex() for t in topics],
                "data": data.hex(),
            },
            "encoding": enc.hex(),
        }
        if isinstance(result, str):
            assert not honest, (rid, result)
            entry["error"] = result
            failures.append(entry)
        else:
            assert honest, rid
            entry["role"] = role
            entry["event"] = result
            records.append((entry, rec))

    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, topics, data, honest=False)

    # --- the election registry: every definition version the registry decodes.
    eid = det("election-id", 32)
    origin = word(19_000_001) + word(1_760_000_012) + det("l1-origin-hash", 32)
    record("election-created", "ElectionCreated, as in version 1", er,
           [T["ElectionCreated"], eid, bytes(12) + det("creator", 20)],
           word(0) + word(19_000_000) + word(1_760_000_000) + det("l1-origin-hash-0", 32))

    def registered(defn):
        return origin + word(128) + abi_bytes(defn)

    for did, what in (
        ("definition-typical", "a version-1 definition"),
        ("definition-v3-typical", "a version-3 definition, which version 1 refuses"),
        ("definition-v4-typical", "a version-4 definition with its receipt keys"),
        ("definition-v5-typical", "a version-5 definition with its questions"),
        ("definition-v6-typical", "a version-6 definition with its author panel"),
        ("definition-maximal", "the largest version-1 definition vector"),
        ("definition-v6-lists-at-max", "a version-6 definition with its lists at their maxima, past version 1's "
         "4,096-byte bound"),
    ):
        assert did in by_id, did
        record(f"definition-registered/{did}", f"DefinitionRegistered carrying {what}", er,
               [T["DefinitionRegistered"], det(f"election-id/{did}", 32), det(f"definition-hash/{did}", 32)],
               registered(by_id[did]))
    reg_topics = [T["DefinitionRegistered"], eid, det("definition-hash", 32)]
    v7 = "definition-v7-rolling-typical"
    assert definitions[by_id[v7].hex()] is False
    fail("event-data-definition-v7", "DefinitionRegistered carrying a version-7 definition, which the registry "
         "doesn't decode", er, reg_topics, registered(by_id[v7]))
    fail("event-data-definition-truncated", "DefinitionRegistered carrying a definition that doesn't decode", er,
         reg_topics, registered(by_id["definition-truncated"]))
    fail("event-data-definition-profile", "DefinitionRegistered carrying a definition its own profile doesn't pin",
         er, reg_topics, registered(by_id["definition-profile-pins-other-version"]))
    fail("event-data-definition-maximal-short", "DefinitionRegistered carrying the largest version-1 definition "
         "less its last byte", er, reg_topics, registered(by_id["definition-maximal"][:-1]))

    # --- the trustee registry: the key-set registration layout.
    panel_id, stub, transcript = det("panel-id", 32), det("stub", 32), det("transcript", 32)
    keys = [bytes.fromhex(k["encoding"]) for k in load("trustee.json")["keys"] if "secretKey" in k][:3]
    record("panel-pinned", "PanelPinned, as in version 1", tr, [T["PanelPinned"], panel_id],
           word(2) + word(2) + word(96) + abi_bytes(b"".join(keys)))

    def registration(seats, count, label="sig"):
        head = panel_id + stub + transcript + bytes([seats])
        body = b"".join(bytes([i + 1]) + det(f"seat-{i}", 96) for i in range(seats))
        approvals = b"".join(bytes([i + 1]) + det(f"{label}-{i}", 64) for i in range(count))
        return head + body + bytes([count]) + approvals

    cer_topics = [T["CeremonyRegistered"], stub, panel_id, transcript]
    reg3 = registration(3, 2)
    assert len(reg3) == 98 + 97 * 3 + 65 * 2
    record("ceremony-registered", "CeremonyRegistered with three seats and two approvals (98 + 97 * 3 + 65 * 2 "
           "bytes)", tr, cer_topics, word(32) + abi_bytes(reg3))
    record("ceremony-registered-empty", "CeremonyRegistered with no seats and no approvals: its length is right, "
           "and the key set's size and the quorum are the registry's and verifier 3.1's", tr,
           [T["CeremonyRegistered"], stub, det("panel-id-2", 32), transcript],
           word(32) + abi_bytes(registration(0, 0)))
    reg_max = registration(255, 255)
    record("ceremony-registered-max", "CeremonyRegistered with 255 seats and 255 approvals, the most its count "
           "bytes name", tr, [T["CeremonyRegistered"], stub, det("panel-id-3", 32), transcript],
           word(32) + abi_bytes(reg_max))
    v1_layout = panel_id + stub + transcript + bytes([2]) + b"".join(bytes([i]) + det(f"v1-sig-{i}", 64) for i in (1, 2))
    fail("event-data-registration-v1-layout", "CeremonyRegistered in the first registration layout, which version "
         "1 reads: under version 2 its count byte is the seats", tr, cer_topics, word(32) + abi_bytes(v1_layout))
    fail("event-data-registration-extra-byte", "CeremonyRegistered's record one byte past 98 + 97 * seats + 65 * "
         "count", tr, cer_topics, word(32) + abi_bytes(reg3 + b"\x00"))
    fail("event-data-registration-max-extra-byte", "CeremonyRegistered at its largest and one byte more", tr,
         [T["CeremonyRegistered"], stub, det("panel-id-3", 32), transcript], word(32) + abi_bytes(reg_max + b"\x00"))
    count_at = 97 + 97 * 3
    fail("event-data-registration-count", "CeremonyRegistered whose count byte names three approvals and two "
         "follow", tr, cer_topics, word(32) + abi_bytes(reg3[:count_at] + bytes([3]) + reg3[count_at + 1:]))
    fail("event-data-registration-seats", "CeremonyRegistered whose seats byte names four seats and three follow",
         tr, cer_topics, word(32) + abi_bytes(reg3[:96] + bytes([4]) + reg3[97:]))
    fail("event-data-registration-no-count", "CeremonyRegistered ending after its seats, with no count byte", tr,
         cer_topics, word(32) + abi_bytes(reg3[:count_at]))
    fail("event-data-registration-short", "CeremonyRegistered's record shorter than its 97-byte header", tr,
         cer_topics, word(32) + abi_bytes(reg3[:96]))

    # --- the group registry: unchanged from version 1.
    record("group-created", "GroupCreated, as in version 1", gr, [T["GroupCreated"], word(0), word(2)], b"")

    # --- the board: each record whole, its definition and ballot hashes as the topics.
    def board_event(name, rec):
        framed = BOARD_FRAMES[name](rec)
        assert framed is not None
        return [T[name], framed[0], framed[1]], word(32) + abi_bytes(rec)

    def boarded(rid, description, name, rec):
        topics, data = board_event(name, rec)
        record(rid, description, board, topics, data)

    honest_v1 = "v1/ok-tier-0"
    boarded("ballot-v1", "BallotSubmitted carrying ballot.json's ok-tier-0", "BallotSubmitted", ballots[honest_v1])
    boarded("ballot-v1-option-proof", "BallotSubmitted carrying ballot.json's option-proof, which the verifier "
            "rejects at a validity proof: the board doesn't check those, so its event passes", "BallotSubmitted",
            ballots["v1/option-proof"])
    boarded("ballot-v2", "BallotSubmitted carrying ballot-v2.json's ok-cell-0", "BallotSubmitted",
            ballots["v2/ok-cell-0"])
    boarded("ballot-v3", "BallotSubmitted carrying a version-3 record of ballot-v3.json's owners-four",
            "BallotSubmitted", ballots["v3/owners-four"])
    v3_max = "v3/questions-max"
    boarded("ballot-v3-questions-max", "BallotSubmitted carrying a version-3 record of ballot-v3.json's "
            "questions-max: 32 questions and 64 options", "BallotSubmitted", ballots[v3_max])

    # An element that frames (even, below p, not 0) but isn't a point: the
    # board admits it and the verifier rejects the ballot, so its event passes.
    v1_rec = ballots[honest_v1]
    elem_at = 364 + 4 + 4  # the first commitment
    not_point = next(
        x.to_bytes(32, "little") for x in range(2, 1000, 2) if grp.decode(x.to_bytes(32, "little")) is None
    )
    unframed = v1_rec[:elem_at] + not_point + v1_rec[elem_at + 32:]
    boarded("ballot-element-not-a-point", "BallotSubmitted whose first commitment is an even value below p that "
            "isn't a ristretto255 point: framed, not decoded, as the board frames it", "BallotSubmitted", unframed)

    boarded("share-receipt", "ShareReceiptSubmitted carrying delivery.json's receipt", "ShareReceiptSubmitted",
            delivery["receipt"])
    boarded("share-posting", "SharePosted carrying delivery.json's posting", "SharePosted", delivery["posting"])
    boarded("share-complaint", "ShareComplaintSubmitted carrying delivery.json's complaint",
            "ShareComplaintSubmitted", delivery["complaint"])
    post = delivery["posting"]
    dh_at = 3 + 32 + 32 + 1 + 32 + MLKEM_CT_LEN
    boarded("share-posting-dh-not-a-point", "SharePosted whose ct_dh frames but isn't a point", "SharePosted",
            post[:dh_at] + not_point + post[dh_at + 32:])

    # Board events that fail.
    def ballot_fail(rid, description, rec, topics=None):
        framed = frame_ballot(v1_rec)
        tp = topics or [T["BallotSubmitted"], framed[0], framed[1]]
        fail(rid, description, board, tp, word(32) + abi_bytes(rec))

    b_topics, b_data = board_event("BallotSubmitted", v1_rec)
    fail("unknown-event-board-other-role", "ElectionCreated from the board's address", board,
         [T["ElectionCreated"], eid, bytes(12) + det("creator", 20)], word(0) * 4)
    fail("unknown-event-ballot-from-registry", "BallotSubmitted from the election registry's address", er,
         b_topics, b_data)
    fail("unknown-event-old-signature", "A ballot event without its ballot-hash topic",
         board, [sig_topic("BallotSubmitted(bytes32,bytes)"), b_topics[1]], b_data)
    fail("event-topics-ballot-two", "BallotSubmitted without its ballot-hash topic", board, b_topics[:2], b_data)
    fail("event-topics-ballot-four", "BallotSubmitted with a fourth topic", board, b_topics + [word(0)], b_data)
    fail("event-data-ballot-definition-topic", "BallotSubmitted whose definition topic isn't its record's", board,
         [b_topics[0], det("other-definition", 32), b_topics[2]], b_data)
    fail("event-data-ballot-hash-topic", "BallotSubmitted whose ballot-hash topic isn't its record's", board,
         [b_topics[0], b_topics[1], det("other-ballot", 32)], b_data)
    fail("event-data-ballot-padding", "BallotSubmitted with a non-zero padding byte", board, b_topics,
         b_data[:-1] + b"\x01" if len(v1_rec) % 32 else b_data + b"\x01")
    fail("event-data-ballot-trailing-word", "BallotSubmitted with a word after the record", board, b_topics,
         b_data + word(0))

    def mutated(rid, description, rec):
        framed = frame_ballot(rec)
        assert framed is None, rid
        ballot_fail(rid, description, rec)

    mutated("event-data-ballot-receipt", "BallotSubmitted carrying a share receipt", delivery["receipt"])
    mutated("event-data-ballot-version-4", "BallotSubmitted carrying a ballot of version 4", v1_rec[:2] + b"\x04" + v1_rec[3:])
    mutated("event-data-ballot-version-0", "BallotSubmitted carrying a ballot of version 0", v1_rec[:2] + b"\x00" + v1_rec[3:])
    mutated("event-data-ballot-tier-3", "BallotSubmitted carrying a version-1 ballot naming tier 3",
            v1_rec[:35] + b"\x03" + v1_rec[36:])
    mutated("event-data-ballot-nullifier-r", "BallotSubmitted whose nullifier is r",
            v1_rec[:36] + BN254_R.to_bytes(32, "big") + v1_rec[68:])
    mutated("event-data-ballot-a-off-curve", "BallotSubmitted whose proof's A isn't on the curve",
            v1_rec[:108] + v1_rec[108:140] + ((int.from_bytes(v1_rec[140:172], "big") + 1) % BN254_P).to_bytes(32, "big") + v1_rec[172:])
    mutated("event-data-ballot-b-off-twist", "BallotSubmitted whose proof's B isn't on the twist (membership-proof.json's b-off-curve)",
            v1_rec[:108] + off_twist + v1_rec[364:])
    mutated("event-data-ballot-b-outside-subgroup", "BallotSubmitted whose proof's B is outside the order-r subgroup, "
            "which the board's pairing refuses (membership-proof.json's b-outside-subgroup)",
            v1_rec[:108] + outside + v1_rec[364:])

    def at_element(rec, value):
        return rec[:elem_at] + value + rec[elem_at + 32:]

    mutated("event-data-ballot-element-odd", "BallotSubmitted whose first commitment is odd (a negative field element)",
            at_element(v1_rec, (3).to_bytes(32, "little")))
    mutated("event-data-ballot-element-p-plus-1", "BallotSubmitted whose first commitment is p + 1, even but not "
            "below p", at_element(v1_rec, (P25519 + 1).to_bytes(32, "little")))
    mutated("event-data-ballot-element-zero", "BallotSubmitted whose first commitment is 0, the identity",
            at_element(v1_rec, bytes(32)))
    k_count = int.from_bytes(v1_rec[368:372], "big")
    t_count = int.from_bytes(v1_rec[364:368], "big")
    n_at = 364 + 4 + t_count * (4 + 32 * k_count)
    n_count = int.from_bytes(v1_rec[n_at : n_at + 4], "big")
    proofs_at = n_at + 4 + 32 * n_count + 4
    mutated("event-data-ballot-scalar-ell", "BallotSubmitted whose first option proof scalar is ℓ",
            v1_rec[:proofs_at] + ELL.to_bytes(32, "little") + v1_rec[proofs_at + 32:])
    mutated("event-data-ballot-options-over-max", "BallotSubmitted whose option count is MAX_OPTIONS + 1",
            v1_rec[:364] + (MAX_OPTIONS + 1).to_bytes(4, "big") + v1_rec[368:])
    mutated("event-data-ballot-trailing", "BallotSubmitted whose record has a byte after its last field",
            v1_rec + b"\x00")
    mutated("event-data-ballot-truncated", "BallotSubmitted whose record ends a byte early", v1_rec[:-1])
    v3_rec = ballots["v3/owners-four"]
    mutated("event-data-ballot-v3-as-v2", "BallotSubmitted carrying a version-3 committed vote labelled version 2",
            v3_rec[:2] + b"\x02" + v3_rec[3:])

    r_topics, r_data = board_event("ShareReceiptSubmitted", delivery["receipt"])
    fail("event-data-receipt-topic", "ShareReceiptSubmitted whose ballot-hash topic isn't its record's", board,
         [r_topics[0], r_topics[1], det("other-ballot", 32)], r_data)
    fail("event-data-receipt-as-complaint", "ShareComplaintSubmitted carrying a share receipt", board,
         [T["ShareComplaintSubmitted"], r_topics[1], r_topics[2]], r_data)

    def delivery_fail(rid, description, name, rec):
        t = {"ShareReceiptSubmitted": RECEIPT, "SharePosted": POSTING, "ShareComplaintSubmitted": COMPLAINT}[name]
        assert frame_delivery(t, rec) is None, rid
        fail(rid, description, board, [T[name], rec[3:35], rec[35:67]], word(32) + abi_bytes(rec))

    for r in dl["decode"]:
        name = {"share-receipt": "ShareReceiptSubmitted", "share-posting": "SharePosted",
                "share-complaint": "ShareComplaintSubmitted"}[r["type"]]
        delivery_fail(f"event-data-{r['id']}", f"{name} carrying delivery.json's {r['id']} ({r['description']})",
                      name, bytes.fromhex(r["encoding"]))
    cp = delivery["complaint"]
    delivery_fail("event-data-complaint-dh-odd", "ShareComplaintSubmitted whose D is odd", "ShareComplaintSubmitted",
                  cp[:68] + (3).to_bytes(32, "little") + cp[100:])

    ids = [e["id"] for e, _ in records] + [e["id"] for e in failures]
    assert len(ids) == len(set(ids))

    # --- framing: rejected before any event check.
    honest = bytes.fromhex(records[0][0]["encoding"])
    decode_errors = []

    def reject(rid, description, b):
        try:
            decode(b)
        except Reject as e:
            decode_errors.append({"id": rid, "description": description, "encoding": b.hex(), "error": e.code,
                                  "offset": e.offset})
            return
        raise AssertionError(rid)

    reject("version-one", "Version 1, against the pinned version 2", honest[:2] + b"\x01" + honest[3:])
    reject("version-three", "Version 3, against the pinned version 2", honest[:2] + b"\x03" + honest[3:])
    reject("truncated-data", "The data one byte short of its length", honest[:-1])
    reject("trailing-bytes", "A byte after the data", honest + b"\x00")
    k_at = 3 + 20 + 24
    reject("topics-over-max", "Five topics", honest[:k_at] + (5).to_bytes(4, "big") + honest[k_at + 4:])

    # --- each contract's records replayed into its accumulator.
    sequences = []
    for role in contracts:
        recs = [(e, r) for e, r in records if e["role"] == role]
        assert [r["n"] for _, r in recs] == list(range(len(recs)))
        acc = v1.genesis(chain_id, contracts[role])
        accs = []
        for _, r in recs:
            acc = v1.step(acc, r)
            accs.append(acc.hex())
        sequences.append({"role": role, "records": [e["id"] for e, _ in recs], "accumulators": accs,
                          "count": str(len(recs))})

    out = {
        "format": "abolish-contract-event-vectors/2",
        "title": "Contract-event records (0x0008) version 2: the event check with the board's events",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-v2-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event tables (version 2)) with its own BN254 point "
            "checks and the board's framing, over contract-event-vectors.py's Keccak-256, ABI reader and "
            "accumulator; definitions and their verdicts from the election-definition files of versions 1 and 3 "
            "to 7, ballots from ballot.json, ballot-v2.json and ballot-v3.json, delivery records from delivery.json"
        ),
        "recordType": "0x0008",
        "version": VERSION,
        "maxEventData": MAX_EVENT_DATA,
        "maxEventTopics": MAX_EVENT_TOPICS,
        "chainId": str(chain_id),
        "contracts": {r: a.hex() for r, a in contracts.items()},
        "events": [
            {"role": role, "signature": s, "indexed": INDEXED[s.split("(")[0]], "topic0": sig_topic(s).hex()}
            for role, sigs in SIGNATURES.items()
            for s in sigs
        ],
        "records": [e for e, _ in records],
        "eventFailures": failures,
        "decodeErrors": decode_errors,
        "sequences": sequences,
    }
    with open(vec / "contract-event-v2.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
