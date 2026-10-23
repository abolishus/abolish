#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event-v10.json.

A second implementation of docs/spec/contracts.md (Contract-event record,
Event tables (version 10)): record type 0x0008 version 10, its strict
decoding, and the event check under version 10's tables, which are version
9's with the board's rolling ballot event added (Board, Rolling ballots):

- `RollingBallotSubmitted(bytes32,bytes32,bytes32,bytes)`, indexed
  `definitionHash` and `ballotHash`, carries the root the submitter supplied,
  a canonical `field<bn254>` word other than 0, then a ballot record of
  version 5 framed as the board frames it (What the board frames (version
  10)): version 4's fields and committed vote with the `step` (any `u32`)
  after the membership proof, and the topics its definition hash and its
  ballot hash recomputed from its bytes;
- `BallotSubmitted` and `RelayedBallotSubmitted` still frame ballot versions
  1 to 4 only, as under version 9, so a version-5 ballot is carried by the
  rolling event alone and a ballot of any other version never by it.

The event check never judges the supplied root against the step's: that is
the verifier's `root-step-mismatch` (ballot-validity.md, Admission (version
5)). `rollingRoots` lists, for each rolling record, the root of the step its
ballot names, as ballot-v5-records.json's independent generator rebuilt it
from the group registry's events, and what comparing it with the supplied
root gives (`rootCheck`): `match`, `root-step-mismatch`, or `not-reached`
where the ballot names no election, cell or step the file has.

It reuses only this folder's other independent generators:
contract-event-v9-vectors.py (version 9, from the same spec) for version 9's
check of every event version 10 keeps unchanged, and through it the earlier
versions' framing cursor, Keccak-256, ABI reader and accumulator. Ballots
come from ballot.json, ballot-v4-records.json and ballot-v5-records.json. It
shares no code with packages/crypto or packages/contracts.

Usage: python3 -I -B packages/crypto/scripts/contract-event-v10-vectors.py <repo-root>,
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


v9 = _load("contract_event_v9_vectors", "contract-event-v9-vectors.py")
v8 = v9.v8
v2, v1 = v9.v2, v9.v1

word, abi_bytes, abi_tail, sig_topic, uint_of = v1.word, v1.abi_bytes, v1.abi_tail, v1.sig_topic, v1.uint_of
Reject = v1.Reject

RECORD_TYPE = 0x0008
VERSION = 10
MAX_EVENT_DATA = v1.MAX_EVENT_DATA
MAX_EVENT_TOPICS = v1.MAX_EVENT_TOPICS

STEP_AT, ROLLING_VOTE_AT = 364, 368


# ----------------------------------------------------------- the record

def encode(contract, n, block, timestamp, topics, data):
    return v1.encode(contract, n, block, timestamp, topics, data, version=VERSION)


def decode(b):
    """Strict decoding with version 10 pinned: version 9's layout, field for field."""
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE and b[2] == VERSION:
        return v9.decode(b[:2] + bytes([v9.VERSION]) + b[3:])
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE:
        raise Reject("profile-mismatch", 2)
    return v9.decode(b)


# ----------------------------------------------------------- what the board frames (version 10)

def frame_rolling_ballot(rec):
    """Board, Rolling ballots, the ballot check's steps 1 and 3 to 5 and the proof's points for a
    version-5 record: (definition_hash, ballot_hash) or None.

    Version 5 is version 4's record with a `u32` step between the membership proof and the
    committed vote, which any value fills (ballot-validity.md, Decoding (version 5)). So the
    record frames exactly when the same bytes without the step, labelled version 4, frame as
    version 9 frames a version-4 ballot; a record that ends inside the step has no committed
    vote and fails either way."""
    if len(rec) < ROLLING_VOTE_AT or int.from_bytes(rec[:2], "big") != v2.BALLOT or rec[2] != 5:
        return None
    if not v9.frame_ballot(rec[:2] + b"\x04" + rec[3:STEP_AT] + rec[ROLLING_VOTE_AT:]):
        return None
    # Hashes (version 5): the step follows the nullifier, so the bytes the board hashes for every
    # version, record[364:] from the step on, are version 5's ballot hash input.
    return rec[3:35], v2.H(v2.ds(v2.BALLOT_TAG, rec[3:35] + rec[0:3] + rec[35:68] + rec[STEP_AT:]))


def supplied_root(w):
    """The supplied root's word: a canonical field<bn254> value other than 0, or None."""
    root = int.from_bytes(w, "big")
    return root if 0 < root < v2.BN254_R else None


# ----------------------------------------------------------- the event check

ROLLING = "RollingBallotSubmitted(bytes32,bytes32,bytes32,bytes)"

SIGNATURES = {role: list(sigs) for role, sigs in v9.SIGNATURES.items()}
SIGNATURES["board"] += [ROLLING]

INDEXED = dict(v9.INDEXED)
INDEXED["RollingBallotSubmitted"] = ["definitionHash", "ballotHash"]


def event_check(rec, contracts, definitions):
    """Version 10's event check: (role, event, fields) or the first failing code."""
    role = next((r for r, a in contracts.items() if a == rec["contract"]), None)
    topics, data = rec["topics"], rec["data"]
    if role != "board" or not topics or topics[0] != sig_topic(ROLLING):
        # Every other event is checked as version 9 checks it, and the rolling event's topic 0 from
        # any other role is unknown there, as here.
        return v9.event_check(rec, contracts, definitions)
    if len(topics) != 1 + len(INDEXED["RollingBallotSubmitted"]):
        return "event-topics"
    body = abi_tail(data, 2, 1, 1)
    if body is None:
        return "event-data"
    root = supplied_root(data[:32])
    framed = frame_rolling_ballot(body)
    if root is None or not framed or framed != (topics[1], topics[2]):
        return "event-data"
    return {"event": "RollingBallotSubmitted", "definitionHash": topics[1].hex(), "ballotHash": topics[2].hex(),
            "root": str(root), "record": body.hex()}


# ----------------------------------------------------------- vectors

def det(label, n):
    return v1.det(f"v10/{label}", n)


def main(root):
    vec = root / "docs/spec/vectors"

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

    # --- version 9's records keep their verdicts: version 10 changes no row version 9 has, and its
    # one new event has a topic 0 no version-9 record carries.
    old = load("contract-event-v9.json")
    v9_contracts = {r: bytes.fromhex(a) for r, a in old["contracts"].items()}
    for e in old["records"]:
        assert event_check(as_rec(e["fields"]), v9_contracts, definitions) == e["event"], e["id"]
    for e in old["eventFailures"]:
        assert event_check(as_rec(e["fields"]), v9_contracts, definitions) == e["error"], e["id"]
    for name in ("contract-event-v2.json", "contract-event-v3.json", "contract-event-v4.json",
                 "contract-event-v5.json", "contract-event-v8.json"):
        f = load(name)
        cs = {r: bytes.fromhex(a) for r, a in f["contracts"].items()}
        for e in f["eventFailures"]:
            assert event_check(as_rec(e["fields"]), cs, definitions) == e["error"], (name, e["id"])

    ballot_v1 = bytes.fromhex(next(b for b in load("ballot.json")["ballots"] if b["id"] == "ok-tier-0")["encoding"])
    ballot_v4 = bytes.fromhex(next(b for b in load("ballot-v4-records.json")["ballots"]
                                   if b["id"] == "ok-cell-0")["encoding"])
    v5_file = load("ballot-v5-records.json")
    v5_ballots = {b["id"]: b for b in v5_file["ballots"]}

    def step_root(b):
        """The root of the step a version-5 ballot names, in its election's cell, as
        ballot-v5-records.json gives it, or None where the file has no such election, cell or step."""
        election = v5_file["elections"].get(b["election"])
        enc = bytes.fromhex(b["encoding"])
        cell, step = enc[35], int.from_bytes(enc[STEP_AT:ROLLING_VOTE_AT], "big")
        if election is None or enc[3:35].hex() != election["definitionHash"] or cell >= len(election["cells"]):
            return None
        return next((int(s["root"]) for s in election["cells"][cell]["steps"] if s["step"] == step), None)

    newest = v5_ballots["ok-newest-step"]
    n0 = int.from_bytes(bytes.fromhex(newest["encoding"])[STEP_AT:ROLLING_VOTE_AT], "big")
    cell0 = v5_file["elections"]["rolling"]["cells"][0]
    root_before = next(int(s["root"]) for s in cell0["steps"] if s["step"] == n0 - 1)
    root_n0 = step_root(newest)
    assert root_before != root_n0

    chain_id = 84532
    contracts = {r: det(r, 20) for r in ("election-registry", "trustee-registry", "group-registry", "board")}
    T = {s.split("(")[0]: sig_topic(s) for sigs in SIGNATURES.values() for s in sigs}
    er, gr, board = contracts["election-registry"], contracts["group-registry"], contracts["board"]

    records, failures, v9_verdicts, rolling_roots = [], [], {}, []
    counters = {r: 0 for r in contracts}
    clock = [1_779_840_000]

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
            # Under version 9 the rolling event is no event of the board's (unknown-event); every
            # other record version 10 passes, version 9 passes alike.
            old_verdict = v9.event_check(rec, contracts, definitions)
            if isinstance(old_verdict, str):
                assert old_verdict == "unknown-event" and result["event"] == "RollingBallotSubmitted", rid
                v9_verdicts[rid] = old_verdict
            else:
                assert old_verdict == result, rid

    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, topics, data, honest=False)

    def either(rid, description, contract, topics, data):
        """A record whose verdict is the check's: listed with the records or the failures."""
        probe = {"contract": contract, "n": 0, "block": 1, "timestamp": 0, "topics": topics, "data": data}
        record(rid, description, contract, topics, data, honest=not isinstance(event_check(probe, contracts,
                                                                                            definitions), str))

    def hashes_of(b):
        # A record the framing refuses still logs its definition hash and the ballot hash its bytes give.
        return frame_rolling_ballot(b) or (b[3:35].ljust(32, b"\x00"), v2.H(v2.ds(v2.BALLOT_TAG, b[3:35] + b[0:3]
                                                                                 + b[35:68] + b[STEP_AT:])))

    def rolling_event(b, root):
        dh, bh = hashes_of(b)
        return [T["RollingBallotSubmitted"], dh, bh], word(root) + word(64) + abi_bytes(b)

    def ballot_event(b):
        framed = v9.frame_ballot(b) or hashes_of(b)
        return [T["BallotSubmitted"], framed[0], framed[1]], word(32) + abi_bytes(b)

    # ---------------------------------------------------------------- honest records

    record("ballot-submitted-v1", "BallotSubmitted carrying ballot.json's ok-tier-0, as in versions 2 to 9", board,
           *ballot_event(ballot_v1))
    record("ballot-submitted-v4", "BallotSubmitted carrying ballot-v4-records.json's ok-cell-0, as in version 9",
           board, *ballot_event(ballot_v4))

    # Every ballot of ballot-v5-records.json, whatever its admission verdict (the event check is
    # stateless), with the root of the step it names as its supplied root where the file has that
    # step, and otherwise the newest step's root, which the event check can't tell from any other.
    for bid, b in v5_ballots.items():
        enc = bytes.fromhex(b["encoding"])
        framed = frame_rolling_ballot(enc)
        assert framed and framed[1].hex() == b["ballotHash"], bid
        step = int.from_bytes(enc[STEP_AT:ROLLING_VOTE_AT], "big")
        rho = step_root(b)
        supplied = rho if rho is not None else root_n0
        rid = f"rolling-ballot-{bid}"
        record(rid, f"RollingBallotSubmitted carrying ballot-v5-records.json's {bid} (admission: "
               f"{b['admission']['code']}) with " + ("the root of the step it names" if rho is not None else
                                                     "step N0's root, the file having none for its election, cell and step")
               + " as the supplied root", board, *rolling_event(enc, supplied))
        rolling_roots.append({"record": rid, "ballot": bid, "step": step, "suppliedRoot": str(supplied),
                              "stepRoot": None if rho is None else str(rho),
                              "rootCheck": "not-reached" if rho is None else "match"})

    # The supplied root the verifier rejects: membership-other-step-root's proof is against step
    # N0 - 1's root while the ballot names step N0 (ballot-v5-records.json), so the board's check of
    # the proof against the supplied root N0 - 1 passes, and the verifier, which takes step N0's
    # root, rejects it with root-step-mismatch before it checks the proof.
    other = v5_ballots["membership-other-step-root"]
    other_enc = bytes.fromhex(other["encoding"])
    assert step_root(other) == root_n0
    record("rolling-root-mismatch", "RollingBallotSubmitted carrying membership-other-step-root, a ballot naming "
           "step N0 whose membership proof is against step N0 - 1's root, with that root supplied: the board's "
           "proof check passes, and the verifier rejects the ballot with root-step-mismatch", board,
           *rolling_event(other_enc, root_before))
    rolling_roots.append({"record": "rolling-root-mismatch", "ballot": "membership-other-step-root", "step": n0,
                          "suppliedRoot": str(root_before), "stepRoot": str(root_n0),
                          "rootCheck": "root-step-mismatch"})
    # A front-runner's copy: an honest ballot with another root supplied. The event check can't tell
    # it from the honest one, but its proof doesn't verify against that root, so the board refuses it
    # (membership-proof) and it never takes the honest submission's place.
    newest_enc = bytes.fromhex(newest["encoding"])
    record("rolling-root-front-run", "RollingBallotSubmitted carrying ok-newest-step with step N0 - 1's root "
           "supplied instead of its own: the event check passes it, the board's proof check refuses it "
           "(membership-proof), so no board emits it, and the verifier would reject it with root-step-mismatch",
           board, *rolling_event(newest_enc, root_before))
    rolling_roots.append({"record": "rolling-root-front-run", "ballot": "ok-newest-step", "step": n0,
                          "suppliedRoot": str(root_before), "stepRoot": str(root_n0),
                          "rootCheck": "root-step-mismatch"})

    # The supplied root's bounds: any canonical non-zero field element passes the event check.
    for value, rid, desc in ((1, "one", "1"), (v2.BN254_R - 1, "r-minus-one", "r - 1, the largest")):
        record(f"rolling-root-{rid}", f"RollingBallotSubmitted carrying ok-newest-step with the supplied root {desc}: "
               "a canonical field element, so the event check passes it, and its proof can't verify against it",
               board, *rolling_event(newest_enc, value))

    # An element that frames but isn't a point passes, as under version 9 (T-53).
    vote_first_element = ROLLING_VOTE_AT + 8
    not_point = next(v for v in range(2, 400, 2) if v9.b2.grp.decode(v.to_bytes(32, "little")) is None)
    np_ballot = (newest_enc[:vote_first_element] + not_point.to_bytes(32, "little")
                 + newest_enc[vote_first_element + 32:])
    assert frame_rolling_ballot(np_ballot)
    record("rolling-element-not-point", f"RollingBallotSubmitted carrying ok-newest-step with its first vss element "
           f"replaced by {not_point}, even and below 2^255 - 19 but no ristretto255 encoding: framed, never decoded, "
           "so it passes, and the verifier rejects the ballot (T-53)", board, *rolling_event(np_ballot, root_n0))

    # ---------------------------------------------------------------- failures

    tp, data = rolling_event(newest_enc, root_n0)
    fail("unknown-event-rolling-from-election-registry", "RollingBallotSubmitted from the election registry's "
         "address", er, tp, data)
    fail("unknown-event-rolling-from-group-registry", "RollingBallotSubmitted from the group registry's address", gr,
         tp, data)
    fail("unknown-contract-rolling", "RollingBallotSubmitted from an address that is none of the definition's "
         "contracts", det("unknown-contract", 20), tp, data)
    fail("event-topics-rolling-root-indexed", "RollingBallotSubmitted with the root as a fourth topic, as a "
         "declaration indexing it would emit (topic 0 hashes the same text either way)", board,
         tp + [word(root_n0)], data)
    fail("unknown-event-rolling-without-root", "A rolling event declared without the root, "
         "RollingBallotSubmitted(bytes32,bytes32,bytes), a signature version 10 doesn't list", board,
         [sig_topic("RollingBallotSubmitted(bytes32,bytes32,bytes)"), tp[1], tp[2]], word(32) + abi_bytes(newest_enc))
    fail("event-topics-rolling-one", "RollingBallotSubmitted with only its signature topic", board, tp[:1], data)
    fail("event-topics-rolling-two", "RollingBallotSubmitted without its ballot-hash topic", board, tp[:2], data)
    for value, rid, desc in ((0, "zero", "0, the root anyone can prove membership of"),
                             (v2.BN254_R, "r", "r, not a canonical field element"),
                             (2**256 - 1, "max", "2^256 - 1")):
        fail(f"event-data-rolling-root-{rid}", f"RollingBallotSubmitted carrying ok-newest-step with the supplied "
             f"root {desc}, which the board refuses", board, *rolling_event(newest_enc, value))
    fail("event-data-rolling-offset-low", "RollingBallotSubmitted whose record offset is 0x20, inside the head",
         board, tp, word(root_n0) + word(32) + abi_bytes(newest_enc))
    fail("event-data-rolling-offset-high", "RollingBallotSubmitted whose record offset is 0x60, a word past the "
         "head", board, tp, word(root_n0) + word(96) + word(0) + abi_bytes(newest_enc))
    fail("event-data-rolling-trailing-word", "RollingBallotSubmitted with a word after the record", board, tp,
         data + word(0))
    assert len(newest_enc) % 32
    fail("event-data-rolling-padding", "RollingBallotSubmitted with a non-zero padding byte", board, tp,
         data[:-1] + b"\x01")
    fail("event-data-rolling-length-short", "RollingBallotSubmitted whose length word is one short of the record",
         board, tp, data[:64] + word(len(newest_enc) - 1) + data[96:])
    fail("event-data-rolling-root-only", "RollingBallotSubmitted whose data is the root word alone", board, tp,
         word(root_n0))
    fail("event-data-rolling-no-data", "RollingBallotSubmitted with no data", board, tp, b"")
    fail("event-data-rolling-record-first", "RollingBallotSubmitted with the record before the root, as "
         "(bytes, bytes32) would encode them", board, tp, word(64) + word(root_n0) + abi_bytes(newest_enc))
    fail("event-data-rolling-hash-topic", "RollingBallotSubmitted carrying ok-newest-step whose ballot-hash topic "
         "is its statement hash", board, [tp[0], tp[1], bytes.fromhex(newest["statementHash"])], data)
    fail("event-data-rolling-v4-hash-topic", "RollingBallotSubmitted carrying ok-newest-step whose ballot-hash "
         "topic is version 4's formula over its bytes without the step, the hash it would have if the step "
         "weren't bound", board,
         [tp[0], tp[1], v2.H(v2.ds(v2.BALLOT_TAG, newest_enc[3:35] + newest_enc[0:2] + b"\x04" + newest_enc[35:68]
                                   + newest_enc[ROLLING_VOTE_AT:]))], data)
    fail("event-data-rolling-definition-topic", "RollingBallotSubmitted carrying ok-newest-step whose definition "
         "topic isn't its record's", board, [tp[0], det("other-definition", 32), tp[2]], data)
    fail("event-data-rolling-v4-ballot", "RollingBallotSubmitted carrying ballot-v4-records.json's ok-cell-0, a "
         "version-4 ballot: the rolling event carries version 5 alone", board, *rolling_event(ballot_v4, root_n0))
    fail("event-data-rolling-v1-ballot", "RollingBallotSubmitted carrying ballot.json's ok-tier-0", board,
         *rolling_event(ballot_v1, root_n0))
    fail("event-data-rolling-as-v4", "ok-newest-step's bytes with the version byte 4: read as version 4, the step "
         "is taken for the committed vote's first count", board,
         *rolling_event(newest_enc[:2] + b"\x04" + newest_enc[3:], root_n0))
    fail("event-data-rolling-v6", "ok-newest-step's bytes with the version byte 6", board,
         *rolling_event(newest_enc[:2] + b"\x06" + newest_enc[3:], root_n0))
    fail("event-data-rolling-truncated", "ok-newest-step one byte short", board,
         *rolling_event(newest_enc[:-1], root_n0))
    fail("event-data-rolling-trailing", "ok-newest-step with a byte after the last range proof", board,
         *rolling_event(newest_enc + b"\x00", root_n0))
    fail("event-data-rolling-inside-step", "ok-newest-step cut two bytes into its step", board,
         *rolling_event(newest_enc[:STEP_AT + 2], root_n0))
    fail("event-data-rolling-without-step", "ok-newest-step without its step, version byte 5", board,
         *rolling_event(newest_enc[:STEP_AT] + newest_enc[ROLLING_VOTE_AT:], root_n0))
    for value, rid, desc in ((0, "zero", "0, the identity's encoding"), (1, "odd", "1, an odd value")):
        b = newest_enc[:vote_first_element] + value.to_bytes(32, "little") + newest_enc[vote_first_element + 32:]
        fail(f"event-data-rolling-element-{rid}", f"ok-newest-step whose first vss element is {desc}", board,
             [T["RollingBallotSubmitted"], tp[1], hashes_of(b)[1]], word(root_n0) + word(64) + abi_bytes(b))
    # The other ballot events still frame versions 1 to 4 only.
    fail("event-data-ballot-v5", "BallotSubmitted carrying ok-newest-step: a version-5 ballot is carried by the "
         "rolling event alone", board, [T["BallotSubmitted"], tp[1], tp[2]], word(32) + abi_bytes(newest_enc))
    fail("event-data-relayed-ballot-v5", "RelayedBallotSubmitted carrying ok-newest-step", board,
         [T["RelayedBallotSubmitted"], tp[1], tp[2]],
         word(7) + word(19_000_123) + word(1_779_840_123) + word(2_000_000) + word(160) + abi_bytes(newest_enc))
    fail("event-data-ballot-v5-with-root", "BallotSubmitted's topic 0 over the rolling event's data", board,
         [T["BallotSubmitted"], tp[1], tp[2]], data)
    # Every decode rejection of ballot-v5-records.json, carried in the rolling event: the framing
    # refuses some, and passes those whose fault needs decoding (a point's square root) or the profile.
    for d in v5_file["decode"]:
        b = bytes.fromhex(d["encoding"])
        topics, d_data = rolling_event(b, root_n0)
        either(f"rolling-decode-{d['id']}", f"RollingBallotSubmitted carrying ballot-v5-records.json's decode "
               f"rejection {d['id']} ({d['error']}): " + ("framed, so the event check passes it; the verifier "
                                                          "rejects it when it decodes the record"
                                                          if frame_rolling_ballot(b) else
                                                          "the board's framing refuses it"), board, topics, d_data)

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

    reject("version-nine", "Version 9, against the pinned version 10", first[:2] + b"\x09" + first[3:])
    reject("version-eleven", "Version 11, against the pinned version 10", first[:2] + b"\x0b" + first[3:])
    reject("truncated-data", "The data one byte short of its length", first[:-1])
    reject("trailing-bytes", "A byte after the data", first + b"\x00")

    recs = [(e, r) for e, r in records if e["role"] == "board"]
    assert len(recs) == len(records)
    assert [r["n"] for _, r in recs] == list(range(len(recs)))
    acc = v1.genesis(chain_id, board)
    accs = []
    for _, r in recs:
        acc = v1.step(acc, r)
        accs.append(acc.hex())
    sequences = [{"role": "board", "records": [e["id"] for e, _ in recs], "accumulators": accs,
                  "count": str(len(recs))}]

    out = {
        "format": "abolish-contract-event-vectors/10",
        "title": "Contract-event records (0x0008) version 10: RollingBallotSubmitted, a version-5 ballot with its "
                 "supplied root",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-v10-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event tables (version 10)) over "
            "contract-event-v9-vectors.py's version-9 check; ballots from ballot.json, ballot-v4-records.json and "
            "ballot-v5-records.json, whose step roots the supplied roots and verdicts compare against, and every "
            "record of contract-event-v9.json and every board failure of contract-event-v2.json to "
            "contract-event-v5.json and contract-event-v8.json re-checked"
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
        "underVersion9": v9_verdicts,
        "rollingRoots": rolling_roots,
        "decodeErrors": decode_errors,
        "sequences": sequences,
    }
    with open(vec / "contract-event-v10.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
