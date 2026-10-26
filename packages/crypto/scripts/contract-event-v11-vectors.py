#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event-v11.json.

A second implementation of docs/spec/contracts.md (Contract-event record,
Event tables (version 11)): record type 0x0008 version 11, its strict
decoding, and the event check under version 11's tables, which are version
10's with the board's relayed rolling ballot event added (Board, Relayed
rolling ballots):

- `RelayedRollingBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes32,bytes)`,
  indexed `definitionHash` and `ballotHash`, carries the relay call's index,
  L1 block, stamp and gas limit as the deposit named them, each a canonical
  `uint64` word, then the root the caller supplied, a canonical `field<bn254>`
  word other than 0, then a ballot record of version 5 framed as the rolling
  event frames one (What the board frames (version 10)), the topics its
  definition hash and its ballot hash recomputed from its bytes;
- every event version 10 names is checked as version 10 checks it, so
  `RelayedBallotSubmitted` still carries ballot versions 1 to 4 only.

`relayMatches` pairs records with calls of relay-rolling.json and gives what
verifier 4.5's match gives (contracts.md, L1 relay, Verification): the call
hash recomputed from the record's fields under abolish/v1/relay-rolling-call
against the word the relay stored, `match` or `relay-unmatched`.

It reuses only this folder's other independent generators:
contract-event-v10-vectors.py (version 10, from the same spec) for version
10's check of every event version 11 keeps unchanged and its framing of a
version-5 ballot, and through it the earlier versions'; relay-rolling-vectors.py
for the rolling call hash. Ballots come from ballot.json,
ballot-v4-records.json and ballot-v5-records.json. It shares no code with
packages/crypto or packages/contracts.

Usage: python3 -I -B packages/crypto/scripts/contract-event-v11-vectors.py <repo-root>,
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


v10 = _load("contract_event_v10_vectors", "contract-event-v10-vectors.py")
relay = _load("relay_rolling_vectors", "relay-rolling-vectors.py")
v9, v2, v1 = v10.v9, v10.v2, v10.v1

word, abi_bytes, abi_tail, sig_topic, uint_of = v1.word, v1.abi_bytes, v1.abi_tail, v1.sig_topic, v1.uint_of
Reject = v1.Reject

RECORD_TYPE = 0x0008
VERSION = 11
MAX_EVENT_DATA = v1.MAX_EVENT_DATA
MAX_EVENT_TOPICS = v1.MAX_EVENT_TOPICS
MAX_U64 = 2**64 - 1

STEP_AT, ROLLING_VOTE_AT = v10.STEP_AT, v10.ROLLING_VOTE_AT


# ----------------------------------------------------------- the record

def encode(contract, n, block, timestamp, topics, data):
    return v1.encode(contract, n, block, timestamp, topics, data, version=VERSION)


def decode(b):
    """Strict decoding with version 11 pinned: version 10's layout, field for field."""
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE and b[2] == VERSION:
        return v10.decode(b[:2] + bytes([v10.VERSION]) + b[3:])
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE:
        raise Reject("profile-mismatch", 2)
    return v10.decode(b)


# ----------------------------------------------------------- the event check

RELAYED_ROLLING = "RelayedRollingBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes32,bytes)"

SIGNATURES = {role: list(sigs) for role, sigs in v10.SIGNATURES.items()}
SIGNATURES["board"] += [RELAYED_ROLLING]

INDEXED = dict(v10.INDEXED)
INDEXED["RelayedRollingBallotSubmitted"] = ["definitionHash", "ballotHash"]


def event_check(rec, contracts, definitions):
    """Version 11's event check: (role, event, fields) or the first failing code."""
    role = next((r for r, a in contracts.items() if a == rec["contract"]), None)
    topics, data = rec["topics"], rec["data"]
    if role != "board" or not topics or topics[0] != sig_topic(RELAYED_ROLLING):
        # Every other event is checked as version 10 checks it, and the new event's topic 0 from any
        # other role is unknown there, as here.
        return v10.event_check(rec, contracts, definitions)
    if len(topics) != 1 + len(INDEXED["RelayedRollingBallotSubmitted"]):
        return "event-topics"
    # Four uint64 words, the root's word, the record's offset 0xc0: seven head words.
    body = abi_tail(data, 6, 5, 1)
    if body is None:
        return "event-data"
    fields = [uint_of(data[32 * i : 32 * i + 32], 64) for i in range(4)]
    root = v10.supplied_root(data[128:160])
    framed = v10.frame_rolling_ballot(body)
    if any(f is None for f in fields) or root is None or not framed or framed != (topics[1], topics[2]):
        return "event-data"
    index, l1_block, stamp, gas_limit = fields
    return {"event": "RelayedRollingBallotSubmitted", "definitionHash": topics[1].hex(),
            "ballotHash": topics[2].hex(), "index": str(index), "l1Block": str(l1_block), "stamp": str(stamp),
            "gasLimit": str(gas_limit), "root": str(root), "record": body.hex()}


# ----------------------------------------------------------- vectors

def det(label, n):
    return v1.det(f"v11/{label}", n)


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

    # --- version 10's records keep their verdicts: version 11 changes no row version 10 has, and its
    # one new event has a topic 0 no version-10 record carries.
    old = load("contract-event-v10.json")
    v10_contracts = {r: bytes.fromhex(a) for r, a in old["contracts"].items()}
    for e in old["records"]:
        assert event_check(as_rec(e["fields"]), v10_contracts, definitions) == e["event"], e["id"]
    for e in old["eventFailures"]:
        assert event_check(as_rec(e["fields"]), v10_contracts, definitions) == e["error"], e["id"]
    for name in ("contract-event-v2.json", "contract-event-v3.json", "contract-event-v4.json",
                 "contract-event-v5.json", "contract-event-v8.json", "contract-event-v9.json"):
        f = load(name)
        cs = {r: bytes.fromhex(a) for r, a in f["contracts"].items()}
        for e in f["eventFailures"]:
            if e["fields"]["contract"] == f["contracts"]["board"]:
                assert event_check(as_rec(e["fields"]), cs, definitions) == e["error"], (name, e["id"])

    ballot_v1 = bytes.fromhex(next(b for b in load("ballot.json")["ballots"] if b["id"] == "ok-tier-0")["encoding"])
    ballot_v4 = bytes.fromhex(next(b for b in load("ballot-v4-records.json")["ballots"]
                                   if b["id"] == "ok-cell-0")["encoding"])
    v5_file = load("ballot-v5-records.json")
    v5_ballots = {b["id"]: b for b in v5_file["ballots"]}
    relay_file = load("relay-rolling.json")
    relay_calls = {c["id"]: c for c in relay_file["calls"]}

    def step_root(b):
        election = v5_file["elections"].get(b["election"])
        enc = bytes.fromhex(b["encoding"])
        cell, step = enc[35], int.from_bytes(enc[STEP_AT:ROLLING_VOTE_AT], "big")
        if election is None or enc[3:35].hex() != election["definitionHash"] or cell >= len(election["cells"]):
            return None
        return next((int(s["root"]) for s in election["cells"][cell]["steps"] if s["step"] == step), None)

    newest = v5_ballots["ok-newest-step"]
    newest_enc = bytes.fromhex(newest["encoding"])
    n0 = int.from_bytes(newest_enc[STEP_AT:ROLLING_VOTE_AT], "big")
    cell0 = v5_file["elections"]["rolling"]["cells"][0]
    root_before = next(int(s["root"]) for s in cell0["steps"] if s["step"] == n0 - 1)
    root_n0 = step_root(newest)
    assert root_before != root_n0

    chain_id = 84532
    contracts = {r: det(r, 20) for r in ("election-registry", "trustee-registry", "group-registry", "board")}
    T = {s.split("(")[0]: sig_topic(s) for sigs in SIGNATURES.values() for s in sigs}
    er, board = contracts["election-registry"], contracts["board"]

    records, failures, v10_verdicts, relayed_roots, matches = [], [], {}, [], []
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
            # Under version 10 the relayed rolling event is no event of the board's (unknown-event);
            # every other record version 11 passes, version 10 passes alike.
            old_verdict = v10.event_check(rec, contracts, definitions)
            if isinstance(old_verdict, str):
                assert old_verdict == "unknown-event" and result["event"] == "RelayedRollingBallotSubmitted", rid
                v10_verdicts[rid] = old_verdict
            else:
                assert old_verdict == result, rid
        return entry

    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, topics, data, honest=False)

    def either(rid, description, contract, topics, data):
        probe = {"contract": contract, "n": 0, "block": 1, "timestamp": 0, "topics": topics, "data": data}
        record(rid, description, contract, topics, data, honest=not isinstance(event_check(probe, contracts,
                                                                                            definitions), str))

    def hashes_of(b):
        return v10.frame_rolling_ballot(b) or (b[3:35].ljust(32, b"\x00"), v2.H(v2.ds(v2.BALLOT_TAG, b[3:35] + b[0:3]
                                                                                     + b[35:68] + b[STEP_AT:])))

    def relayed_data(index, l1_block, stamp, gas_limit, root_word, b):
        return (word(index) + word(l1_block) + word(stamp) + word(gas_limit) + root_word + word(0xC0)
                + abi_bytes(b))

    def relayed_event(b, root, index=11, l1_block=19_000_111, stamp=1_779_840_111, gas_limit=6_000_000):
        dh, bh = hashes_of(b)
        root_word = root if isinstance(root, bytes) else word(root)
        return ([T["RelayedRollingBallotSubmitted"], dh, bh],
                relayed_data(index, l1_block, stamp, gas_limit, root_word, b))

    # ---------------------------------------------------------------- honest records

    record("rolling-ballot", "RollingBallotSubmitted carrying ok-newest-step with its step's root, as in version "
           "10", board, *v10_rolling_event(newest_enc, root_n0, T, hashes_of))
    tp_relayed_v1 = v9.frame_ballot(ballot_v1)
    record("relayed-ballot-v1", "RelayedBallotSubmitted carrying ballot.json's ok-tier-0, as in versions 3 to 10",
           board, [T["RelayedBallotSubmitted"], tp_relayed_v1[0], tp_relayed_v1[1]],
           word(7) + word(19_000_123) + word(1_779_840_123) + word(2_000_000) + word(160) + abi_bytes(ballot_v1))

    # Records carrying relay-rolling.json's calls, whose fields 4.5 matches against the word that file
    # gives (L1 relay, Verification).
    def from_call(rid, description, call_id, root_word=None, record_bytes=None, match="match"):
        c = relay_calls[call_id]
        b = record_bytes if record_bytes is not None else bytes.fromhex(c["record"])
        rw = root_word if root_word is not None else bytes.fromhex(c["root"])
        entry = record(rid, description, board, *relayed_event(b, rw, int(c["index"]), int(c["l1Block"]),
                                                               int(c["l1Timestamp"]), int(c["gasLimit"])))
        ev = entry["event"]
        recomputed = relay.call_hash(int(c["l1ChainId"]), bytes.fromhex(c["relay"]), int(ev["index"]),
                                     int(ev["l1Block"]), int(ev["stamp"]), int(ev["gasLimit"]),
                                     word(int(ev["root"])), bytes.fromhex(ev["record"]))
        got = "match" if recomputed.hex() == c["callHash"] else "relay-unmatched"
        assert got == match, rid
        matches.append({"record": rid, "call": call_id, "callHash": recomputed.hex(), "result": got})

    from_call("relayed-rolling-call", "RelayedRollingBallotSubmitted from relay-rolling.json's v5-ballot call: "
              "ok-newest-step with its step's root, matching the word the relay stored", "v5-ballot")
    from_call("relayed-rolling-call-repeat", "The same record and root from that file's v5-ballot-next-call: each "
              "relayed deposit the board accepts emits, even a byte-identical repeat", "v5-ballot-next-call")
    from_call("relayed-rolling-call-other-root", "RelayedRollingBallotSubmitted from that file's "
              "v5-ballot-other-root call: ok-newest-step with step N0 - 1's root, which the relay recorded and the "
              "board refuses (membership-proof), so no honest board emits it; it matches its own call",
              "v5-ballot-other-root")
    from_call("relayed-rolling-root-swapped", "The v5-ballot call's index, block, stamp, gas limit and record with "
              "step N0 - 1's root: the call hash binds the root, so it doesn't match that call's word "
              "(relay-unmatched), as a deposit L2 governance forged with another root wouldn't", "v5-ballot", root_word=word(root_before),
              match="relay-unmatched")

    # Every ballot of ballot-v5-records.json, whatever its admission verdict, with the root of the step
    # it names as its supplied root where the file has that step, else step N0's.
    for i, (bid, b) in enumerate(v5_ballots.items()):
        enc = bytes.fromhex(b["encoding"])
        framed = v10.frame_rolling_ballot(enc)
        assert framed and framed[1].hex() == b["ballotHash"], bid
        step = int.from_bytes(enc[STEP_AT:ROLLING_VOTE_AT], "big")
        rho = step_root(b)
        supplied = rho if rho is not None else root_n0
        rid = f"relayed-rolling-{bid}"
        record(rid, f"RelayedRollingBallotSubmitted carrying ballot-v5-records.json's {bid} (admission: "
               f"{b['admission']['code']}) with " + ("the root of the step it names" if rho is not None else
                                                     "step N0's root, the file having none for its election, "
                                                     "cell and step") + " as the supplied root", board,
               *relayed_event(enc, supplied, 20 + i, 19_000_200 + i, 1_779_840_200 + 12 * i))
        relayed_roots.append({"record": rid, "ballot": bid, "step": step, "suppliedRoot": str(supplied),
                              "stepRoot": None if rho is None else str(rho),
                              "rootCheck": "not-reached" if rho is None else "match"})

    other = v5_ballots["membership-other-step-root"]
    other_enc = bytes.fromhex(other["encoding"])
    assert step_root(other) == root_n0
    record("relayed-rolling-root-mismatch", "RelayedRollingBallotSubmitted carrying membership-other-step-root with "
           "step N0 - 1's root supplied, the root its proof is against: the board accepts it, and the verifier "
           "rejects the ballot with root-step-mismatch", board, *relayed_event(other_enc, root_before, 60))
    relayed_roots.append({"record": "relayed-rolling-root-mismatch", "ballot": "membership-other-step-root",
                          "step": n0, "suppliedRoot": str(root_before), "stepRoot": str(root_n0),
                          "rootCheck": "root-step-mismatch"})

    record("relayed-rolling-u64-max", "RelayedRollingBallotSubmitted with every call field at 2^64 - 1", board,
           *relayed_event(newest_enc, root_n0, MAX_U64, MAX_U64, MAX_U64, MAX_U64))
    record("relayed-rolling-zero", "RelayedRollingBallotSubmitted with every call field 0", board,
           *relayed_event(newest_enc, root_n0, 0, 0, 0, 0))
    for value, rid, desc in ((1, "one", "1"), (v2.BN254_R - 1, "r-minus-one", "r - 1, the largest")):
        record(f"relayed-rolling-root-{rid}", f"RelayedRollingBallotSubmitted carrying ok-newest-step with the "
               f"supplied root {desc}: a canonical field element, so the event check passes it", board,
               *relayed_event(newest_enc, value))
    vote_first_element = ROLLING_VOTE_AT + 8
    not_point = next(v for v in range(2, 400, 2) if v9.b2.grp.decode(v.to_bytes(32, "little")) is None)
    np_ballot = (newest_enc[:vote_first_element] + not_point.to_bytes(32, "little")
                 + newest_enc[vote_first_element + 32:])
    assert v10.frame_rolling_ballot(np_ballot)
    record("relayed-rolling-element-not-point", f"RelayedRollingBallotSubmitted carrying ok-newest-step with its "
           f"first vss element replaced by {not_point}, framed but no ristretto255 encoding: it passes, and the "
           "verifier rejects the ballot (T-53)", board, *relayed_event(np_ballot, root_n0))

    # ---------------------------------------------------------------- failures

    tp, data = relayed_event(newest_enc, root_n0)
    fail("unknown-event-relayed-rolling-from-election-registry", "RelayedRollingBallotSubmitted from the election "
         "registry's address", er, tp, data)
    fail("unknown-event-relayed-rolling-from-group-registry", "RelayedRollingBallotSubmitted from the group "
         "registry's address", contracts["group-registry"], tp, data)
    fail("unknown-contract-relayed-rolling", "RelayedRollingBallotSubmitted from an address that is none of the "
         "definition's contracts", det("unknown-contract", 20), tp, data)
    fail("unknown-event-relayed-rolling-without-root", "A relayed rolling event declared without the root, "
         "RelayedRollingBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes), a signature version "
         "11 doesn't list", board,
         [sig_topic("RelayedRollingBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes)"), tp[1], tp[2]],
         data[:128] + word(0xA0) + abi_bytes(newest_enc))
    fail("unknown-event-relay-event", "The relay's own BallotRelayed signature from the board", board,
         [sig_topic("BallotRelayed(bytes32,uint64,bytes32)"), tp[1], word(0)], word(0))
    fail("event-topics-relayed-rolling-two", "RelayedRollingBallotSubmitted without its ballot-hash topic", board,
         tp[:2], data)
    fail("event-topics-relayed-rolling-four", "RelayedRollingBallotSubmitted with the index as a fourth topic",
         board, tp + [word(11)], data)
    for i, label in enumerate(("index", "l1-block", "stamp", "gas-limit")):
        fail(f"event-data-relayed-rolling-{label}-over-u64", f"RelayedRollingBallotSubmitted whose "
             f"{label.replace('-', ' ')} word is 2^64", board, tp,
             data[: 32 * i] + word(2**64) + data[32 * i + 32 :])
    for value, rid, desc in ((0, "zero", "0, the root anyone can prove membership of"),
                             (v2.BN254_R, "r", "r, not a canonical field element"),
                             (2**256 - 1, "max", "2^256 - 1")):
        fail(f"event-data-relayed-rolling-root-{rid}", f"RelayedRollingBallotSubmitted with the supplied root {desc}, "
             "which the board refuses", board, *relayed_event(newest_enc, value))
    fail("event-data-relayed-rolling-without-root", "RelayedRollingBallotSubmitted's topics over "
         "RelayedBallotSubmitted's data shape: the four call fields, the offset 0xa0 and the record, no root",
         board, tp, data[:128] + word(0xA0) + abi_bytes(newest_enc))
    fail("event-data-relayed-rolling-root-first", "The root's word before the call fields", board, tp,
         data[128:160] + data[:128] + data[160:])
    fail("event-data-relayed-rolling-offset-low", "A record offset of 0xa0, inside the head", board, tp,
         data[:160] + word(0xA0) + data[192:])
    fail("event-data-relayed-rolling-offset-high", "A record offset of 0xe0, a word past the head", board, tp,
         data[:160] + word(0xE0) + word(0) + data[192:])
    fail("event-data-relayed-rolling-trailing-word", "A word after the record", board, tp, data + word(0))
    assert len(newest_enc) % 32
    fail("event-data-relayed-rolling-padding", "A non-zero padding byte", board, tp, data[:-1] + b"\x01")
    fail("event-data-relayed-rolling-length-short", "A length word one short of the record", board, tp,
         data[:192] + word(len(newest_enc) - 1) + data[224:])
    fail("event-data-relayed-rolling-head-only", "The six head words alone", board, tp, data[:192])
    fail("event-data-relayed-rolling-no-data", "No data", board, tp, b"")
    fail("event-data-relayed-rolling-hash-topic", "A ballot-hash topic that is ok-newest-step's statement hash",
         board, [tp[0], tp[1], bytes.fromhex(newest["statementHash"])], data)
    fail("event-data-relayed-rolling-definition-topic", "A definition topic that isn't its record's", board,
         [tp[0], det("other-definition", 32), tp[2]], data)
    fail("event-data-relayed-rolling-v4-ballot", "RelayedRollingBallotSubmitted carrying ballot-v4-records.json's "
         "ok-cell-0: the relayed rolling event carries version 5 alone", board, *relayed_event(ballot_v4, root_n0))
    fail("event-data-relayed-rolling-v1-ballot", "RelayedRollingBallotSubmitted carrying ballot.json's ok-tier-0",
         board, *relayed_event(ballot_v1, root_n0))
    fail("event-data-relayed-rolling-as-v4", "ok-newest-step's bytes with the version byte 4", board,
         *relayed_event(newest_enc[:2] + b"\x04" + newest_enc[3:], root_n0))
    fail("event-data-relayed-rolling-truncated", "ok-newest-step one byte short", board,
         *relayed_event(newest_enc[:-1], root_n0))
    fail("event-data-relayed-rolling-trailing", "ok-newest-step with a byte after its last field", board,
         *relayed_event(newest_enc + b"\x00", root_n0))
    fail("event-data-relayed-rolling-without-step", "ok-newest-step without its step, version byte 5", board,
         *relayed_event(newest_enc[:STEP_AT] + newest_enc[ROLLING_VOTE_AT:], root_n0))
    for value, rid, desc in ((0, "zero", "0, the identity's encoding"), (1, "odd", "1, an odd value")):
        b = newest_enc[:vote_first_element] + value.to_bytes(32, "little") + newest_enc[vote_first_element + 32:]
        fail(f"event-data-relayed-rolling-element-{rid}", f"ok-newest-step whose first vss element is {desc}", board,
             [tp[0], tp[1], hashes_of(b)[1]], relayed_data(11, 19_000_111, 1_779_840_111, 6_000_000,
                                                            word(root_n0), b))
    # Each event's data under the other's topic 0: one record, one reading (T-31).
    fail("event-data-rolling-topic-relayed-data", "RollingBallotSubmitted's topic 0 over the relayed rolling "
         "event's data", board, [T["RollingBallotSubmitted"], tp[1], tp[2]], data)
    rolling_tp, rolling_data = v10_rolling_event(newest_enc, root_n0, T, hashes_of)
    fail("event-data-relayed-rolling-topic-rolling-data", "RelayedRollingBallotSubmitted's topic 0 over "
         "RollingBallotSubmitted's data", board, [tp[0], tp[1], tp[2]], rolling_data)
    fail("event-data-relayed-topic-relayed-rolling-data", "RelayedBallotSubmitted's topic 0 over the relayed "
         "rolling event's data", board, [T["RelayedBallotSubmitted"], tp[1], tp[2]], data)
    fail("event-data-relayed-ballot-v5", "RelayedBallotSubmitted carrying ok-newest-step, as under version 10: a "
         "version-5 ballot is relayed by the rolling event alone", board, [T["RelayedBallotSubmitted"], tp[1], tp[2]],
         data[:128] + word(0xA0) + abi_bytes(newest_enc))
    for d in v5_file["decode"]:
        b = bytes.fromhex(d["encoding"])
        topics, d_data = relayed_event(b, root_n0)
        either(f"relayed-rolling-decode-{d['id']}", f"RelayedRollingBallotSubmitted carrying ballot-v5-records.json's "
               f"decode rejection {d['id']} ({d['error']}): " + ("framed, so the event check passes it; the "
                                                                 "verifier rejects it when it decodes the record"
                                                                 if v10.frame_rolling_ballot(b) else
                                                                 "the board's framing refuses it"), board, topics,
               d_data)

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

    reject("version-ten", "Version 10, against the pinned version 11", first[:2] + b"\x0a" + first[3:])
    reject("version-twelve", "Version 12, against the pinned version 11", first[:2] + b"\x0c" + first[3:])
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
        "format": "abolish-contract-event-vectors/11",
        "title": "Contract-event records (0x0008) version 11: RelayedRollingBallotSubmitted, a version-5 ballot "
                 "forced through L1 with its relay call's fields and its supplied root",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-v11-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event tables (version 11)) over "
            "contract-event-v10-vectors.py's version-10 check and relay-rolling-vectors.py's call hash; ballots "
            "from ballot.json, ballot-v4-records.json and ballot-v5-records.json, calls from relay-rolling.json, "
            "and every record of contract-event-v10.json and every board failure of contract-event-v2.json to "
            "contract-event-v5.json, contract-event-v8.json and contract-event-v9.json re-checked"
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
        "underVersion10": v10_verdicts,
        "relayedRoots": relayed_roots,
        "relayMatches": matches,
        "decodeErrors": decode_errors,
        "sequences": sequences,
    }
    with open(vec / "contract-event-v11.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


def v10_rolling_event(b, root, T, hashes_of):
    """Version 10's RollingBallotSubmitted over a version-5 ballot and its supplied root."""
    dh, bh = hashes_of(b)
    return [T["RollingBallotSubmitted"], dh, bh], word(root) + word(64) + abi_bytes(b)


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
