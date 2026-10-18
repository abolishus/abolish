#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event-v9.json.

A second implementation of docs/spec/contracts.md (Contract-event record,
Event tables (version 9)): record type 0x0008 version 9, its strict decoding,
and the event check under version 9's tables, which are version 8's with the
election registry's `AuthorPanelRegistered` added and the board's framing
(What the board frames (version 9)) reading ballot version 4 and every
delivery record at version 2 beside what version 8 reads:

- `BallotSubmitted` and `RelayedBallotSubmitted` frame a ballot record of
  versions 1 to 4, version 4's committed vote with its author half
  (`author_vss`, `author_share_hashes`) framed as the default half is;
- `ShareReceiptSubmitted`, `SharePosted` and `ShareComplaintSubmitted` frame
  their record at version 1 or 2, version 2 with `panel` (1 or 2) at offset 67;
- both batch events and the root event read their record at version 1 or 2,
  version 2 with `panel` at offset 35 and the seat, which the `seat` topic
  repeats, at 36: a receipt batch and a root decode strictly, a complaint
  batch is framed, its `D` never decoded;
- `AuthorPanelRegistered(bytes32,bytes32,bytes)`, indexed `definitionHash`
  and `authorPanelId`, carries an author registration in the trustee
  registry's key-set layout whose `panel_id` is the `authorPanelId` topic.

It reuses only this folder's other independent generators:
contract-event-v8-vectors.py (version 8, from the same spec) for version 8's
check of every event version 9 keeps unchanged, and through it the earlier
versions' framing cursor, Keccak-256, ABI reader and accumulator;
delivery-batch-vectors.py's (through version 4's) and delivery-root-vectors.py's
(through version 5's) version-1 batch and root decoders;
delivery-batch-v2-vectors.py's strict decoding of version-2 receipt batches
and roots; and author-ceremony-vectors.py's author panels, approvals and
ceremony registration statement (over key-set-vectors.py and
trustee-vectors.py's RFC 6979 P-256 ECDSA). The event check verifies no
signature, but every registration this file makes is signed by its panel.
It shares no code with packages/crypto or packages/contracts.

Ballots come from ballot.json, ballot-v4-records.json and ballot-v5-records.json,
version-2 receipts, postings and complaints from delivery-v2.json, version-2
batches and roots from delivery-batch-v2.json, version-1 ones from
delivery.json, delivery-batch.json and delivery-root.json, and the author
panels' transcripts from author-ceremony.json.

Usage: python3 -I -B packages/crypto/scripts/contract-event-v9-vectors.py <repo-root>,
then `vp check --fix`.
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


v8 = _load("contract_event_v8_vectors", "contract-event-v8-vectors.py")
b2 = _load("delivery_batch_v2_vectors", "delivery-batch-v2-vectors.py")
ac = _load("author_ceremony_vectors", "author-ceremony-vectors.py")
v7 = v8.v7
v6 = v7.v6
v5, v2, v1 = v6.v5, v6.v2, v6.v1
v4 = v5.v4
v3 = v4.v3
ks, tv = ac.ks, ac.ecdsa

word, abi_bytes, abi_tail, sig_topic, uint_of = v1.word, v1.abi_bytes, v1.abi_tail, v1.sig_topic, v1.uint_of
Reject = v1.Reject
Cursor, Frame = v2.Cursor, v2.Frame

RECORD_TYPE = 0x0008
VERSION = 9
MAX_EVENT_DATA = v1.MAX_EVENT_DATA
MAX_EVENT_TOPICS = v1.MAX_EVENT_TOPICS

DEFAULT, AUTHOR = 1, 2


# ----------------------------------------------------------- the record

def encode(contract, n, block, timestamp, topics, data):
    return v1.encode(contract, n, block, timestamp, topics, data, version=VERSION)


def decode(b):
    """Strict decoding with version 9 pinned: version 8's layout, field for field."""
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE and b[2] == VERSION:
        return v8.decode(b[:2] + bytes([v8.VERSION]) + b[3:])
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE:
        raise Reject("profile-mismatch", 2)
    return v8.decode(b)


# ----------------------------------------------------------- what the board frames (version 9)

def frame_ballot(rec):
    """Board, Ballots and Ballots (version 4), steps 1 and 3 to 5 and the proof's points:
    (definition_hash, ballot_hash) or None. Versions 1 to 3 as version 8 frames them."""
    if len(rec) < 3 or rec[2] != 4:
        return v2.frame_ballot(rec)
    try:
        c = Cursor(rec, 0)
        if int.from_bytes(c.take(2), "big") != v2.BALLOT:
            raise Frame("type")
        c.take(1)
        c.take(32)
        c.take(1)  # cell: any u8
        if int.from_bytes(c.take(32), "big") >= v2.BN254_R:
            raise Frame("nullifier")
        c.take(8 + 32)
        if not v2.proof_ok(c.take(256)):
            raise Frame("proof")
        # vss and share_hashes, then the author half framed the same way.
        for _ in range(2):
            for _ in range(c.count(v2.MAX_OPTIONS)):
                for _ in range(c.count(v2.MAX_TRUSTEES)):
                    c.element()
            for _ in range(c.count(v2.MAX_TRUSTEES)):
                c.take(32)
        for _ in range(4 * c.count(v2.MAX_OPTIONS)):
            c.scalar()
        for _ in range(c.count(v2.MAX_QUESTIONS)):
            for _ in range(2 * c.count(v2.MAX_BRANCHES)):
                c.scalar()
        c.end()
    except Frame:
        return None
    # Hashes (version 4): the same bytes as versions 1 to 3, the version byte 4.
    return rec[3:35], v2.H(v2.ds(v2.BALLOT_TAG, rec[3:35] + rec[0:3] + rec[35:68] + rec[364:]))


def frame_delivery(t, rec):
    """Board, Delivery records (version 2), steps 1, 3 and 4 without the election: version 1 as
    version 8 frames it, version 2 with `panel` at 67. (definition_hash, ballot_hash) or None."""
    if len(rec) < 3 or rec[2] != 2:
        return v2.frame_delivery(t, rec)
    try:
        c = Cursor(rec, 0)
        if int.from_bytes(c.take(2), "big") != t:
            raise Frame("header")
        c.take(1 + 32 + 32)
        if c.take(1)[0] not in (DEFAULT, AUTHOR):
            raise Frame("panel")
        c.take(1)
        if t == v2.RECEIPT:
            c.take(32)
            c.sig()
        elif t == v2.POSTING:
            c.take(32 + v2.MLKEM_CT_LEN)
            c.element()
            c.scalar()
            c.scalar()
            c.take(c.count(v2.MAX_SEALED))
        else:
            c.element()
            c.scalar()
            c.scalar()
            c.sig()
        c.end()
    except Frame:
        return None
    return rec[3:35], rec[35:67]


def frame_complaint_batch_v2(rec):
    """A share-complaint batch of version 2 framed as the board frames it: panel at 35, seat at
    36, 1 to 512 entries strictly ascending by ballot hash, each D framed (never decoded), c and
    z below l, a canonical low-s signature, nothing after. True or False."""
    try:
        c = Cursor(rec, 0)
        if int.from_bytes(c.take(2), "big") != b2.COMPLAINT_BATCH or c.take(1)[0] != 2:
            raise Frame("header")
        c.take(32)
        if c.take(1)[0] not in (DEFAULT, AUTHOR):
            raise Frame("panel")
        c.take(1)
        count = c.count(b2.BATCH_MAX[b2.COMPLAINT_BATCH])
        if count == 0:
            raise Frame("count")
        last = None
        for _ in range(count):
            bh = c.take(32)
            if last is not None and bh <= last:
                raise Frame("order")
            last = bh
            c.element()
            c.scalar()
            c.scalar()
        c.sig()
        c.end()
    except Frame:
        return False
    return True


def read_batch_or_root(name, rec):
    """The seat a batch or root event's record names, or None: version 1 as versions 4 and 5
    read it (seat at 35), version 2 with the panel at 35 and the seat at 36."""
    if len(rec) < 3:
        return None
    version = rec[2]
    if name == "ObligationRootSubmitted":
        ok = isinstance((v5.dr.parse_root if version == 1 else b2.parse_root)(rec), dict)
    elif name == "ShareReceiptBatchSubmitted":
        ok = isinstance(v4.db.parse_batch(rec), dict) if version == 1 else isinstance(b2.parse_batch(rec, b2.BATCH), dict)
    else:
        ok = isinstance(v4.db.parse_complaint_batch(rec, framed=True), dict) if version == 1 else frame_complaint_batch_v2(rec)
    if not ok or version not in (1, 2):
        return None
    return rec[35] if version == 1 else rec[36]


# ----------------------------------------------------------- the event check

AUTHOR_PANEL = "AuthorPanelRegistered(bytes32,bytes32,bytes)"

SIGNATURES = {role: list(sigs) for role, sigs in v8.SIGNATURES.items()}
SIGNATURES["election-registry"] += [AUTHOR_PANEL]

INDEXED = dict(v8.INDEXED)
INDEXED["AuthorPanelRegistered"] = ["definitionHash", "authorPanelId"]

BALLOT_FRAMES = {
    "BallotSubmitted": frame_ballot,
    "ShareReceiptSubmitted": lambda r: frame_delivery(v2.RECEIPT, r),
    "SharePosted": lambda r: frame_delivery(v2.POSTING, r),
    "ShareComplaintSubmitted": lambda r: frame_delivery(v2.COMPLAINT, r),
}
SEAT_EVENTS = ("ShareReceiptBatchSubmitted", "ShareComplaintBatchSubmitted", "ObligationRootSubmitted")


def registration_layout_ok(b):
    """The trustee registry's key-set layout (Registration, check 2)."""
    if len(b) < 97:
        return False
    count_at = 97 + 97 * b[96]
    return len(b) >= count_at + 1 and len(b) == count_at + 1 + 65 * b[count_at]


def event_check(rec, contracts, definitions):
    """Version 9's event check: (role, event, fields) or the first failing code."""
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
    if name == "AuthorPanelRegistered":
        body = abi_tail(data, 1, 0, 1)
        if body is None or not registration_layout_ok(body) or body[:32] != topics[2]:
            return "event-data"
        return {"event": name, "definitionHash": topics[1].hex(), "authorPanelId": topics[2].hex(),
                "registration": body.hex()}
    if name in BALLOT_FRAMES:
        body = abi_tail(data, 1, 0, 1)
        framed = body is not None and BALLOT_FRAMES[name](body)
        if not framed or framed != (topics[1], topics[2]):
            return "event-data"
        return {"event": name, "definitionHash": topics[1].hex(), "ballotHash": topics[2].hex(), "record": body.hex()}
    if name == "RelayedBallotSubmitted":
        body = abi_tail(data, 5, 4, 1)
        if body is None:
            return "event-data"
        fields = [uint_of(data[32 * i : 32 * i + 32], 64) for i in range(4)]
        if any(f is None for f in fields):
            return "event-data"
        framed = frame_ballot(body)
        if not framed or framed != (topics[1], topics[2]):
            return "event-data"
        index, l1_block, stamp, gas_limit = fields
        return {"event": name, "definitionHash": topics[1].hex(), "ballotHash": topics[2].hex(), "index": str(index),
                "l1Block": str(l1_block), "stamp": str(stamp), "gasLimit": str(gas_limit), "record": body.hex()}
    if name in SEAT_EVENTS:
        seat = uint_of(topics[2], 8)
        if seat is None:
            return "event-topics"
        body = abi_tail(data, 1, 0, 1)
        if body is None:
            return "event-data"
        named = read_batch_or_root(name, body)
        if named is None or body[3:35] != topics[1] or named != seat:
            return "event-data"
        return {"event": name, "definitionHash": topics[1].hex(), "seat": seat, "record": body.hex()}
    # Every other event is checked as version 8 checks it.
    return v8.event_check(rec, contracts, definitions)


# ----------------------------------------------------------- vectors

def det(label, n):
    return v1.det(f"v9/{label}", n)


def main(root):
    vec = root / "docs/spec/vectors"
    tv.self_check()

    def load(name):
        return json.loads((vec / name).read_text())

    def as_rec(fields):
        return {
            "contract": bytes.fromhex(fields["contract"]),
            "n": int(fields["n"]),
            "block": int(fields["l2Block"]),
            "timestamp": int(fields["l2Timestamp"]),
            "topics": [bytes.fromhex(t) for t in fields["topics"]],
            "data": bytes.fromhex(fields["data"]),
        }

    definitions = {}
    for name in ("election-definition.json", "election-definition-v3.json", "election-definition-v4.json",
                 "election-definition-v5.json", "election-definition-v6.json"):
        for v in load(name)["vectors"]:
            definitions[v["encoding"]] = "error" not in v

    # --- version 8's records keep their verdicts: version 9 changes none of its rows' verdicts on
    # them, since each reads what version 8 reads exactly as version 8 does.
    old = load("contract-event-v8.json")
    v8_contracts = {r: bytes.fromhex(a) for r, a in old["contracts"].items()}
    for e in old["records"]:
        assert event_check(as_rec(e["fields"]), v8_contracts, definitions) == e["event"], e["id"]
    for e in old["eventFailures"]:
        assert event_check(as_rec(e["fields"]), v8_contracts, definitions) == e["error"], e["id"]
    # And the earlier files' board failures that version 8 still reads under its own tables: every
    # framing failure of versions 2 to 5 keeps its verdict under version 9.
    for name, mod in (("contract-event-v2.json", v2), ("contract-event-v3.json", v3), ("contract-event-v4.json", v4),
                      ("contract-event-v5.json", v5)):
        f = load(name)
        cs = {r: bytes.fromhex(a) for r, a in f["contracts"].items()}
        for e in f["eventFailures"]:
            assert event_check(as_rec(e["fields"]), cs, definitions) == e["error"], (name, e["id"])
        for e in f["records"]:
            assert not isinstance(event_check(as_rec(e["fields"]), cs, definitions), str), (name, e["id"])

    ballot_v1 = bytes.fromhex(next(b for b in load("ballot.json")["ballots"] if b["id"] == "ok-tier-0")["encoding"])
    v4_file = load("ballot-v4-records.json")
    v4_ballots = {b["id"]: b for b in v4_file["ballots"]}
    v5_ballot = bytes.fromhex(load("ballot-v5-records.json")["ballots"][0]["encoding"])
    d2_file = load("delivery-v2.json")
    db2_file = load("delivery-batch-v2.json")
    batch_v1 = bytes.fromhex(load("delivery-batch.json")["records"][0]["encoding"])
    root_v1 = bytes.fromhex(load("delivery-root.json")["records"][0]["encoding"])
    receipt_v1 = bytes.fromhex(next(r for r in load("delivery.json")["records"] if r["type"] == "share-receipt")
                               ["encoding"])
    ceremony = load("author-ceremony.json")

    chain_id = 84532
    contracts = {r: det(r, 20) for r in ("election-registry", "trustee-registry", "group-registry", "board")}
    T = {s.split("(")[0]: sig_topic(s) for sigs in SIGNATURES.values() for s in sigs}
    er, trr, board = contracts["election-registry"], contracts["trustee-registry"], contracts["board"]

    records, failures, v8_verdicts = [], [], {}
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
            assert honest, (rid, result)
            entry["role"] = role
            entry["event"] = result
            records.append((entry, rec))
            # Under version 8 a record version 9 reads anew fails: AuthorPanelRegistered is no event
            # of version 8's (unknown-event), and a version-4 ballot or a version-2 delivery record
            # isn't framed by it (event-data).
            old_verdict = v8.event_check(rec, contracts, definitions)
            if isinstance(old_verdict, str):
                v8_verdicts[rid] = old_verdict

    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, topics, data, honest=False)

    def either(rid, description, contract, topics, data):
        """A record whose verdict is the check's: listed with the records or the failures."""
        probe = {"contract": contract, "n": 0, "block": 1, "timestamp": 0, "topics": topics, "data": data}
        record(rid, description, contract, topics, data, honest=not isinstance(event_check(probe, contracts,
                                                                                            definitions), str))

    def ballot_event(b, hashed=None):
        # A record the framing refuses still logs its definition hash and the ballot hash its bytes give.
        framed = frame_ballot(b) or (b[3:35].ljust(32, b"\x00"), v2.H(v2.ds(v2.BALLOT_TAG, b[3:35] + b[0:3]
                                                                            + b[35:68] + b[364:])))
        return [T["BallotSubmitted"], framed[0], hashed or framed[1]], word(32) + abi_bytes(b)

    def delivery_event(event, b):
        return [T[event], b[3:35].ljust(32, b"\x00"), b[35:67].ljust(32, b"\x00")], word(32) + abi_bytes(b)

    def seat_event(event, b, seat_at=None):
        at = seat_at if seat_at is not None else (36 if len(b) > 2 and b[2] == 2 else 35)
        return [T[event], b[3:35].ljust(32, b"\x00"), word(b[at] if len(b) > at else 0)], word(32) + abi_bytes(b)

    # ---------------------------------------------------------------- honest records

    # The author panel's registrations: author-ceremony.json's panels and transcripts, the registration
    # in the trustee registry's layout, signed by the panel's seats over ceremony-registration-2.
    default = ac.cv.make_panel("author-vectors/default-4", 3, 4)
    panels = {
        "author-3": ac.author_panel("author-vectors/author-3", 2, 3, default),
        "author-1": ac.author_panel("author-vectors/author-1", 1, 1, default),
    }
    for name, p in panels.items():
        assert ac.panel_id(p).hex() == ceremony["panels"][name]["panelId"], name
    transcripts = {t["id"]: t for t in ceremony["transcripts"]}
    stub = ac.ELECTION["authorStubHash"]

    def seat_bytes(index, kem_key_hash, signing_key):
        x, y = tv.decompress(signing_key)
        return bytes([index]) + kem_key_hash + x.to_bytes(32, "big") + y.to_bytes(32, "big")

    def registration(panel, transcript_hash, entries, approving, signer=None):
        ksh = ks.key_set_hash(entries)
        approvals = [ac.approve(panel, i, transcript_hash, ksh, signer=signer) for i in approving]
        return (ac.panel_id(panel) + stub + transcript_hash + bytes([len(entries)])
                + b"".join(seat_bytes(*e) for e in entries) + bytes([len(approvals)])
                + b"".join(bytes([i]) + sig for i, sig in approvals))

    def entries_of(tid):
        result = transcripts[tid]["result"]
        return bytes.fromhex(result["hash"]), [
            (s["index"], ks.kem_key_hash(bytes.fromhex(s["kemKey"])), bytes.fromhex(s["signingKey"]))
            for s in result["registered"]]

    h3, e3 = entries_of("author-honest-3")
    h1, e1 = entries_of("author-lone")
    definition = det("definition-with-author-panel", 32)

    def author_event(b, definition_hash=definition, panel_topic=None):
        return [T["AuthorPanelRegistered"], definition_hash, panel_topic or b[:32].ljust(32, b"\x00")], \
            word(32) + abi_bytes(b)

    reg3 = registration(panels["author-3"], h3, e3, [1, 2, 3])
    assert len(reg3) == 98 + 97 * 3 + 65 * 3
    record("author-panel-registered-3", "AuthorPanelRegistered carrying the 2-of-3 author panel of "
           "author-ceremony.json's author-honest-3: its three qualified seats, approved by all three seats over "
           "the author stub hash. The definition hash is made up: the event check reads no definition, and "
           "verifier 3.1 compares it", er, *author_event(reg3))
    reg3_quorum = registration(panels["author-3"], h3, e3, [1, 3])
    record("author-panel-registered-quorum", "AuthorPanelRegistered carrying author-honest-3's key set approved by "
           "seats 1 and 3, the quorum max(k_A, n_A - 1) = 2", er, *author_event(reg3_quorum))
    reg1 = registration(panels["author-1"], h1, e1, [1])
    record("author-panel-registered-1", "AuthorPanelRegistered carrying the 1-of-1 author panel of author-lone, "
           "the shortest honest registration (98 + 97 + 65 bytes)", er, *author_event(reg1))
    panel16 = ac.author_panel("contract-event/v9/author-16", 9, 16, default)
    signing16 = ac.cv.make_panel("contract-event/v9/author-16-signing", 1, 16)["keys"]
    e16 = [(i, det(f"kem-key-hash-{i}", 32), signing16[i - 1]) for i in range(1, 17)]
    h16 = det("author-16-transcript", 32)
    reg16 = registration(panel16, h16, e16, list(range(1, 17)))
    assert len(reg16) == 2_690
    record("author-panel-registered-16", "AuthorPanelRegistered carrying a 9-of-16 author panel's sixteen seats "
           "approved by all sixteen, 2,690 bytes, the most MAX_TRUSTEES allows (the panel's secrets from "
           "ceremony-vectors.py's make_panel over the label contract-event/v9/author-16, its signing keys over "
           "contract-event/v9/author-16-signing, its KEM-key hashes and transcript hash made up)", er,
           *author_event(reg16))
    reg_empty = registration(panels["author-3"], h3, [], [])
    assert len(reg_empty) == 98
    record("author-panel-registered-empty", "AuthorPanelRegistered carrying a registration of no seat and no "
           "approval, 98 bytes, the layout's least: the event check passes it, and the election registry never "
           "emits it (KeySetTooSmall, quorum)", er, *author_event(reg_empty))
    reg_none = registration(panels["author-3"], h3, e3, [])
    record("author-panel-registered-no-approvals", "AuthorPanelRegistered carrying author-honest-3's key set with no "
           "approval: the layout holds, so the event check passes it; the election registry never emits it "
           "(quorum), and verifier 3.1 counts no approval", er, *author_event(reg_none))

    # Ballots: version 1 as version 8 reads it, then every ballot of ballot-v4-records.json, each framed
    # whatever its admission verdict (the event check is stateless).
    record("ballot-submitted-v1", "BallotSubmitted carrying ballot.json's ok-tier-0, as in versions 2 to 8", board,
           *ballot_event(ballot_v1))
    for bid, b in v4_ballots.items():
        enc = bytes.fromhex(b["encoding"])
        framed = frame_ballot(enc)
        assert framed and framed[1].hex() == b["ballotHash"], bid
        record(f"ballot-submitted-v4-{bid}", f"BallotSubmitted carrying ballot-v4-records.json's {bid} (admission: "
               f"{b['admission']['code']}): framed, its topics its definition hash and its version-4 ballot hash",
               board, *ballot_event(enc))
    with_author = bytes.fromhex(v4_ballots["ok-cell-0"]["encoding"])
    relayed_fields = word(7) + word(19_000_123) + word(1_760_000_123) + word(2_000_000)
    framed = frame_ballot(with_author)
    record("relayed-ballot-v4", "RelayedBallotSubmitted carrying ok-cell-0, a version-4 ballot with its author half",
           board, [T["RelayedBallotSubmitted"], framed[0], framed[1]],
           relayed_fields + word(160) + abi_bytes(with_author))
    without_author = bytes.fromhex(v4_ballots["ok-default-only"]["encoding"])
    framed = frame_ballot(without_author)
    record("relayed-ballot-v4-default-only", "RelayedBallotSubmitted carrying ok-default-only, a version-4 ballot "
           "of a poll with no author panel (both author lists empty)", board,
           [T["RelayedBallotSubmitted"], framed[0], framed[1]], relayed_fields + word(160) + abi_bytes(without_author))

    # Delivery records at version 1 and 2.
    events_of = {"share-receipt": "ShareReceiptSubmitted", "share-posting": "SharePosted",
                 "share-complaint": "ShareComplaintSubmitted"}
    record("receipt-v1", "ShareReceiptSubmitted carrying delivery.json's first receipt, version 1, as in versions 2 "
           "to 8", board, *delivery_event("ShareReceiptSubmitted", receipt_v1))
    for r in d2_file["records"]:
        b = bytes.fromhex(r["encoding"])
        record(f"delivery-v2-{r['id']}", f"{events_of[r['type']]} carrying delivery-v2.json's {r['id']}, version 2, "
               f"panel {r['panel']}", board, *delivery_event(events_of[r["type"]], b))
    batch_events = {"share-receipt-batch": "ShareReceiptBatchSubmitted",
                    "share-complaint-batch": "ShareComplaintBatchSubmitted", "obligation-root": "ObligationRootSubmitted"}
    record("receipt-batch-v1", "ShareReceiptBatchSubmitted carrying delivery-batch.json's first batch, version 1 "
           "(its seat at 35), as in versions 4 to 8", board, *seat_event("ShareReceiptBatchSubmitted", batch_v1))
    record("root-v1", "ObligationRootSubmitted carrying delivery-root.json's first root, version 1 (its seat at 35), "
           "as in versions 5 to 8", board, *seat_event("ObligationRootSubmitted", root_v1))
    for r in db2_file["records"]:
        b = bytes.fromhex(r["encoding"])
        record(f"delivery-batch-v2-{r['id']}", f"{batch_events[r['type']]} carrying delivery-batch-v2.json's "
               f"{r['id']}, version 2, panel {r['panel']} seat {r['seat']} (the seat topic its byte at 36)", board,
               *seat_event(batch_events[r["type"]], b))

    # ---------------------------------------------------------------- failures

    # AuthorPanelRegistered.
    tp, data = author_event(reg3)
    fail("unknown-event-author-panel-from-trustee-registry", "AuthorPanelRegistered from the trustee registry's "
         "address", trr, tp, data)
    fail("unknown-event-author-panel-from-board", "AuthorPanelRegistered from the board's address", board, tp, data)
    fail("unknown-contract-author-panel", "AuthorPanelRegistered from an address that is none of the definition's "
         "contracts", det("unknown-contract", 20), tp, data)
    fail("unknown-event-ceremony-registered-from-election-registry", "author-honest-3's registration as "
         "CeremonyRegistered from the election registry, which declares no such event", er,
         [T["CeremonyRegistered"], reg3[32:64], reg3[:32], reg3[64:96]], data)
    fail("unknown-event-author-panel-unindexed", "AuthorPanelRegistered declared with no indexed parameter, a "
         "signature version 9 doesn't list", er, [sig_topic("AuthorPanelRegistered(bytes)")], data)
    fail("event-topics-author-panel-one", "AuthorPanelRegistered with only its signature topic", er, tp[:1], data)
    fail("event-topics-author-panel-two", "AuthorPanelRegistered without its panel topic", er, tp[:2], data)
    fail("event-topics-author-panel-four", "AuthorPanelRegistered with a fourth topic", er, tp + [reg3[32:64]], data)
    fail("event-data-author-panel-topic", "AuthorPanelRegistered whose authorPanelId topic isn't the record's "
         "panel_id", er, [tp[0], tp[1], bytes.fromhex(ceremony["panels"]["author-1"]["panelId"])], data)
    fail("event-data-author-panel-default-panel-topic", "AuthorPanelRegistered whose authorPanelId topic is the "
         "default panel's identifier, the record's panel_id still the author panel's", er,
         [tp[0], tp[1], bytes.fromhex(ceremony["panels"]["default-4"]["panelId"])], data)
    fail("event-data-author-panel-header-short", "AuthorPanelRegistered carrying the first 96 bytes of a "
         "registration, short of the 97-byte header", er, *author_event(reg3[:96]))
    fail("event-data-author-panel-header-only", "AuthorPanelRegistered carrying the 97-byte header alone, with no "
         "approval count", er, *author_event(reg3[:97]))
    fail("event-data-author-panel-one-short", "AuthorPanelRegistered carrying a registration one byte short", er,
         *author_event(reg3[:-1]))
    fail("event-data-author-panel-one-past", "AuthorPanelRegistered carrying a registration with a byte after the "
         "last approval", er, *author_event(reg3 + b"\x00"))
    fail("event-data-author-panel-seats-high", "AuthorPanelRegistered whose seat count is one more than the seats "
         "it carries", er, *author_event(reg3[:96] + bytes([4]) + reg3[97:]))
    fail("event-data-author-panel-count-high", "AuthorPanelRegistered whose approval count is one more than the "
         "approvals it carries", er, *author_event(reg3[:388] + bytes([4]) + reg3[389:]))
    assert reg3[388] == 3
    fail("event-data-author-panel-offset", "AuthorPanelRegistered whose record offset is 0x40", er, tp,
         word(64) + word(0) + abi_bytes(reg3))
    fail("event-data-author-panel-trailing-word", "AuthorPanelRegistered with a word after the record", er, tp,
         data + word(0))
    assert len(reg3) % 32
    fail("event-data-author-panel-padding", "AuthorPanelRegistered with a non-zero padding byte", er, tp,
         data[:-1] + b"\x01")
    fail("event-data-author-panel-length-short", "AuthorPanelRegistered whose length word is one short of the "
         "record", er, tp, word(32) + word(len(reg3) - 1) + data[64:])
    fail("event-data-author-panel-no-data", "AuthorPanelRegistered with no data", er, tp, b"")
    fail("event-data-author-panel-empty", "AuthorPanelRegistered carrying an empty record", er,
         *author_event(b"", panel_topic=reg3[:32]))

    # Ballots version 9 still doesn't frame, and version-4 ballots broken in their framing.
    tp5, data5 = ballot_event(v5_ballot)
    fail("event-data-ballot-v5", "BallotSubmitted carrying ballot-v5-records.json's first ballot: version 9 frames "
         "ballot versions 1 to 4 only, and version 5 waits on a later version", board, tp5, data5)
    fail("event-data-relayed-ballot-v5", "RelayedBallotSubmitted carrying the same version-5 ballot", board,
         [T["RelayedBallotSubmitted"], tp5[1], tp5[2]], relayed_fields + word(160) + abi_bytes(v5_ballot))
    ok_tp, ok_data = ballot_event(with_author)
    fail("event-data-ballot-v4-hash-topic", "BallotSubmitted carrying ok-cell-0 whose ballot-hash topic is its "
         "statement hash", board, [ok_tp[0], ok_tp[1], bytes.fromhex(v4_ballots["ok-cell-0"]["statementHash"])],
         ok_data)
    fail("event-data-ballot-v4-definition-topic", "BallotSubmitted carrying ok-cell-0 whose definition topic isn't "
         "its record's", board, [ok_tp[0], det("other-definition", 32), ok_tp[2]], ok_data)
    fail("event-data-ballot-v4-as-v3", "ok-cell-0's bytes with the version byte 3: read as version 3, the author "
         "half's counts are taken for the option proofs'", board,
         *ballot_event(with_author[:2] + b"\x03" + with_author[3:]))
    fail("event-data-ballot-v4-trailing", "ok-cell-0 with a byte after the last range proof", board,
         *ballot_event(with_author + b"\x00"))
    fail("event-data-ballot-v4-truncated", "ok-cell-0 one byte short", board, *ballot_event(with_author[:-1]))

    # Locate the author half in ok-cell-0 to break it field by field.
    def author_half_at(b):
        at = 364
        t = int.from_bytes(b[at : at + 4], "big")
        at += 4
        for _ in range(t):
            at += 4 + 32 * int.from_bytes(b[at : at + 4], "big")
        at += 4 + 32 * int.from_bytes(b[at : at + 4], "big")
        return at

    ah = author_half_at(with_author)
    t_opts = int.from_bytes(with_author[ah : ah + 4], "big")
    k_a = int.from_bytes(with_author[ah + 4 : ah + 8], "big")
    assert t_opts > 0 and k_a > 0
    first_author_element = ah + 8

    def broken(rid, description, b):
        fail(rid, description, board, [T["BallotSubmitted"], b[3:35], frame_ballot(with_author)[1]],
             word(32) + abi_bytes(b))

    for value, rid, desc in ((0, "zero", "0, the identity's encoding"), (1, "odd", "1, an odd value"),
                             (v2.P25519 + 1, "above-p", "2^255 - 18, even and not below 2^255 - 19")):
        b = with_author[:first_author_element] + value.to_bytes(32, "little") + with_author[first_author_element + 32:]
        broken(f"event-data-ballot-v4-author-element-{rid}", f"ok-cell-0 whose first author_vss element is {desc}, "
               "which the board's framing refuses as it refuses one of vss", b)
    not_point = next(v for v in range(2, 400, 2) if b2.grp.decode(v.to_bytes(32, "little")) is None)
    np_ballot = (with_author[:first_author_element] + not_point.to_bytes(32, "little")
                 + with_author[first_author_element + 32:])
    framed = frame_ballot(np_ballot)
    assert framed
    record("ballot-v4-author-element-not-point", f"BallotSubmitted carrying ok-cell-0 with its first author_vss "
           f"element replaced by {not_point}, even and below 2^255 - 19 but no ristretto255 encoding: framed, never "
           "decoded, so it passes, and the verifier rejects the ballot (T-53)", board,
           [T["BallotSubmitted"], framed[0], framed[1]], word(32) + abi_bytes(np_ballot))
    record("relayed-ballot-v4-author-element-not-point", "RelayedBallotSubmitted carrying the same ballot", board,
           [T["RelayedBallotSubmitted"], framed[0], framed[1]], relayed_fields + word(160) + abi_bytes(np_ballot))
    b = with_author[:ah] + (v2.MAX_OPTIONS + 1).to_bytes(4, "big") + with_author[ah + 4:]
    broken("event-data-ballot-v4-author-options-over-max", "ok-cell-0 whose author_vss count is MAX_OPTIONS + 1",
           b)
    b = with_author[:ah + 4] + (v2.MAX_TRUSTEES + 1).to_bytes(4, "big") + with_author[ah + 8:]
    broken("event-data-ballot-v4-author-row-over-max", "ok-cell-0 whose first author_vss row count is "
           "MAX_TRUSTEES + 1", b)
    sh_at = ah + 4 + t_opts * (4 + 32 * k_a)
    b = with_author[:sh_at] + (v2.MAX_TRUSTEES + 1).to_bytes(4, "big") + with_author[sh_at + 4:]
    broken("event-data-ballot-v4-author-share-hashes-over-max", "ok-cell-0 whose author_share_hashes count is "
           "MAX_TRUSTEES + 1", b)
    # Every decode rejection of ballot-v4-records.json, carried in BallotSubmitted: the framing refuses
    # some, and passes those whose fault needs decoding (a point's square root) or the profile.
    for d in v4_file["decode"]:
        b = bytes.fromhex(d["encoding"])
        topics, data = ballot_event(b)
        either(f"ballot-v4-decode-{d['id']}", f"BallotSubmitted carrying ballot-v4-records.json's decode rejection "
               f"{d['id']} ({d['error']}): " + ("framed, so the event check passes it; the verifier rejects it "
                                                "when it decodes the record" if frame_ballot(b) else
                                                "the board's framing refuses it"), board, topics, data)

    # Delivery records at version 2 that fail the framing, and decode rejections of delivery-v2.json.
    receipt2 = bytes.fromhex(next(r for r in d2_file["records"] if r["type"] == "share-receipt")["encoding"])
    for value in (0, 3):
        b = receipt2[:67] + bytes([value]) + receipt2[68:]
        fail(f"event-data-receipt-v2-panel-{value}", f"ShareReceiptSubmitted carrying a version-2 receipt whose panel "
             f"is {value}", board, *delivery_event("ShareReceiptSubmitted", b))
    complaint2 = bytes.fromhex(next(r for r in d2_file["records"] if r["type"] == "share-complaint")["encoding"])
    posting2 = bytes.fromhex(next(r for r in d2_file["records"] if r["type"] == "share-posting")["encoding"])
    for event, short, b, at, field in (("ShareComplaintSubmitted", "complaint", complaint2, 69, "D"),
                                       ("SharePosted", "posting", posting2, 3 + 66 + 32 + v2.MLKEM_CT_LEN, "ct_dh")):
        changed = b[:at] + not_point.to_bytes(32, "little") + b[at + 32:]
        assert frame_delivery(v2.COMPLAINT if short == "complaint" else v2.POSTING, changed)
        record(f"{short}-v2-{field.lower()}-not-point", f"{event} carrying a version-2 {short} whose {field} is "
               f"{not_point}, even and in range but no ristretto255 encoding: framed, so it passes, and the delivery "
               "check rejects it (T-53)", board, *delivery_event(event, changed))
    fail("event-data-receipt-v2-as-v1-length", "ShareReceiptSubmitted carrying a version-2 receipt without its "
         "panel byte (164 bytes, version byte 2)", board,
         *delivery_event("ShareReceiptSubmitted", receipt2[:67] + receipt2[68:]))
    fail("event-data-receipt-v2-version-3", "ShareReceiptSubmitted carrying a version-2 receipt with the version "
         "byte 3", board, *delivery_event("ShareReceiptSubmitted", receipt2[:2] + b"\x03" + receipt2[3:]))
    fail("event-data-receipt-v2-ballot-topic", "ShareReceiptSubmitted whose ballot-hash topic isn't its record's",
         board, *(lambda tpd: ([tpd[0][0], tpd[0][1], det("other-ballot", 32)], tpd[1]))(
             delivery_event("ShareReceiptSubmitted", receipt2)))
    fail("event-data-receipt-v2-as-posting", "SharePosted carrying a version-2 receipt", board,
         *delivery_event("SharePosted", receipt2))
    for d in d2_file["decode"]:
        b = bytes.fromhex(d["encoding"])
        event = events_of[d["type"]]
        topics, data = delivery_event(event, b)
        probe = BALLOT_FRAMES[event](b)
        either(f"delivery-v2-decode-{d['id']}", f"{event} carrying delivery-v2.json's decode rejection {d['id']} "
               f"({d['error']}): " + ("framed, so the event check passes it, and the delivery check rejects it"
                                      if probe else "the board's framing refuses it"), board, topics, data)

    # Batches and roots at version 2.
    rb = bytes.fromhex(next(r for r in db2_file["records"] if r["id"] == "receipt-batch-author")["encoding"])
    cb = bytes.fromhex(next(r for r in db2_file["records"] if r["id"] == "complaint-batch-default")["encoding"])
    rt = bytes.fromhex(next(r for r in db2_file["records"] if r["id"] == "receipt-root-author")["encoding"])
    for event, short, b in (("ShareReceiptBatchSubmitted", "receipt-batch", rb),
                            ("ShareComplaintBatchSubmitted", "complaint-batch", cb),
                            ("ObligationRootSubmitted", "root", rt)):
        assert b[35] != b[36]
        tp, data = seat_event(event, b)
        fail(f"event-data-{short}-v2-panel-as-seat", f"{event} carrying a version-2 record whose seat topic is its "
             "panel byte (offset 35, where version 1 keeps the seat), not its seat (offset 36)", board,
             [tp[0], tp[1], word(b[35])], data)
        fail(f"event-data-{short}-v2-definition-topic", f"{event} carrying a version-2 record whose definition "
             "topic isn't its record's", board, [tp[0], det("other-definition", 32), tp[2]], data)
        fail(f"event-topics-{short}-v2-seat-high", f"{event} carrying a version-2 record whose seat word has bit 8 "
             "set", board, [tp[0], tp[1], word(256 + b[36])], data)
        fail(f"event-data-{short}-v2-version-3", f"{event} carrying a version-2 record with the version byte 3",
             board, *seat_event(event, b[:2] + b"\x03" + b[3:], seat_at=36))
        fail(f"event-data-{short}-v2-panel-3", f"{event} carrying a version-2 record whose panel is 3", board,
             *seat_event(event, b[:35] + b"\x03" + b[36:]))
    fail("event-data-receipt-batch-v2-by-complaint-batch-event", "ShareComplaintBatchSubmitted carrying a version-2 "
         "receipt batch", board, *seat_event("ShareComplaintBatchSubmitted", rb))
    fail("event-data-complaint-batch-v2-by-receipt-batch-event", "ShareReceiptBatchSubmitted carrying a version-2 "
         "complaint batch", board, *seat_event("ShareReceiptBatchSubmitted", cb))
    fail("event-data-root-v2-by-receipt-batch-event", "ShareReceiptBatchSubmitted carrying a version-2 root", board,
         *seat_event("ShareReceiptBatchSubmitted", rt))
    fail("event-data-receipt-batch-v2-by-root-event", "ObligationRootSubmitted carrying a version-2 receipt batch",
         board, *seat_event("ObligationRootSubmitted", rb))
    # A complaint batch's D is framed, never decoded: one that frames but isn't a point passes.
    d_at = 41 + 32
    d_raw = cb[d_at : d_at + 32]
    not_point = next(v for v in range(2, 400, 2) if b2.grp.decode(v.to_bytes(32, "little")) is None)
    cb_np = cb[:d_at] + not_point.to_bytes(32, "little") + cb[d_at + 32:]
    assert d_raw != cb_np[d_at : d_at + 32] and frame_complaint_batch_v2(cb_np)
    record("complaint-batch-v2-d-not-point", f"ShareComplaintBatchSubmitted carrying complaint-batch-default with its "
           f"first D replaced by {not_point}, even and in range but no ristretto255 encoding: framed, so it "
           "passes, and the delivery check rejects it (T-53)", board, *seat_event("ShareComplaintBatchSubmitted",
                                                                                 cb_np))
    fail("event-data-complaint-batch-v2-d-odd", "complaint-batch-default with its first D odd", board,
         *seat_event("ShareComplaintBatchSubmitted", cb[:d_at] + (1).to_bytes(32, "little") + cb[d_at + 32:]))
    for d in db2_file["decode"]:
        b = bytes.fromhex(d["encoding"])
        event = batch_events[d["type"]]
        topics, data = seat_event(event, b)
        probe = {"contract": board, "n": 0, "block": 1, "timestamp": 0, "topics": topics, "data": data}
        passes = not isinstance(event_check(probe, contracts, definitions), str)
        either(f"delivery-batch-v2-decode-{d['id']}", f"{event} carrying delivery-batch-v2.json's decode rejection "
               f"{d['id']} ({d['error']} at {d['offset']}): " + (
                   "read as the version its byte names, so the event check passes it, and the delivery check "
                   "rejects it" if passes else "refused"), board, topics, data)
    fail("event-data-receipt-v1-panel-topic-version-2", "ShareReceiptBatchSubmitted carrying delivery-batch.json's "
         "first batch, version 1, with its version byte changed to 2: read as version 2, its seat byte is taken "
         "for the panel", board, *seat_event("ShareReceiptBatchSubmitted", batch_v1[:2] + b"\x02" + batch_v1[3:],
                                             seat_at=35))

    ids = [e["id"] for e, _ in records] + [e["id"] for e in failures]
    assert len(ids) == len(set(ids))

    first = bytes.fromhex(records[0][0]["encoding"])
    decode_errors = []

    def reject(rid, description, b):
        try:
            decode(b)
        except Reject as e:
            decode_errors.append({"id": rid, "description": description, "encoding": b.hex(), "error": e.code,
                                  "offset": e.offset})
            return
        raise AssertionError(rid)

    reject("version-eight", "Version 8, against the pinned version 9", first[:2] + b"\x08" + first[3:])
    reject("version-ten", "Version 10, against the pinned version 9", first[:2] + b"\x0a" + first[3:])
    reject("truncated-data", "The data one byte short of its length", first[:-1])
    reject("trailing-bytes", "A byte after the data", first + b"\x00")

    sequences = []
    for role, address in (("election-registry", er), ("board", board)):
        recs = [(e, r) for e, r in records if e["role"] == role]
        assert [r["n"] for _, r in recs] == list(range(len(recs)))
        acc = v1.genesis(chain_id, address)
        accs = []
        for _, r in recs:
            acc = v1.step(acc, r)
            accs.append(acc.hex())
        sequences.append({"role": role, "records": [e["id"] for e, _ in recs], "accumulators": accs,
                          "count": str(len(recs))})

    out = {
        "format": "abolish-contract-event-vectors/9",
        "title": "Contract-event records (0x0008) version 9: ballot version 4, version-2 delivery records and "
                 "AuthorPanelRegistered",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-v9-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event tables (version 9)) over "
            "contract-event-v8-vectors.py's version-8 check, delivery-batch-v2-vectors.py's version-2 batch and "
            "root decoders and author-ceremony-vectors.py's panels and approvals; ballots from ballot.json, "
            "ballot-v4-records.json and ballot-v5-records.json, delivery records from delivery.json, "
            "delivery-batch.json, delivery-root.json, delivery-v2.json and delivery-batch-v2.json, and every "
            "record of contract-event-v8.json and every board failure of contract-event-v2.json to "
            "contract-event-v5.json re-checked"
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
        "underVersion8": v8_verdicts,
        "decodeErrors": decode_errors,
        "sequences": sequences,
    }
    with open(vec / "contract-event-v9.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
