#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event-v3.json.

A second implementation of docs/spec/contracts.md (Contract-event record,
Event tables (version 3)): record type 0x0008 version 3, its strict decoding,
and the event check under version 3's tables, which are version 2's with two
board events added: `RelayedBallotSubmitted`, carrying a ballot forced
through the L1 relay with the relay call's index, L1 block, stamp and gas
limit, and `CloseStatementSubmitted`, carrying a close statement (0x0015,
version 1) whose topics are its `definition_hash` and `signer`.

It reuses only this folder's other independent generators:
contract-event-v2-vectors.py (version 2, from the same spec) for the board's
framing, version 2's event check of every event version 3 keeps, and through
it contract-event-vectors.py's Keccak-256, ABI reader and accumulator. The
close statement's strict decoding is written here from docs/spec/close.md
(Close statement) and trustee-identity.md (Signatures), and shares no code
with packages/crypto or packages/contracts.

Ballots come from ballot.json, ballot-v2.json and ballot-v3.json (through
version 2's generator), relay calls' fields from relay.json, and close
statements and their decode rejections from close-statement.json.

Usage: python3 -I -B packages/crypto/scripts/contract-event-v3-vectors.py <repo-root>,
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


v2 = _load("contract_event_v2_vectors", "contract-event-v2-vectors.py")
v1 = v2.v1

word, abi_bytes, uint_of, abi_tail, sig_topic = v1.word, v1.abi_bytes, v1.uint_of, v1.abi_tail, v1.sig_topic
Reject = v1.Reject

RECORD_TYPE = 0x0008
VERSION = 3
MAX_EVENT_DATA = v1.MAX_EVENT_DATA
MAX_EVENT_TOPICS = v1.MAX_EVENT_TOPICS
MAX_U64 = v1.MAX_U64
P256_N = v2.P256_N

CLOSE_STATEMENT = 0x0015
CLOSE_STATEMENT_LEN = 180


# ----------------------------------------------------------- the record

def encode(contract, n, block, timestamp, topics, data):
    return v1.encode(contract, n, block, timestamp, topics, data, version=VERSION)


def decode(b):
    """Strict decoding with version 3 pinned: version 2's layout, field for field."""
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE and b[2] == VERSION:
        return v2.decode(b[:2] + bytes([v2.VERSION]) + b[3:])
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE:
        raise Reject("profile-mismatch", 2)
    # Shorter headers and other types fail as version 2 fails them.
    return v2.decode(b)


# ----------------------------------------------------------- a close statement

def close_statement_ok(rec):
    """close.md, Close statement, Decoding: version 1, strictly. True or False."""
    if len(rec) != CLOSE_STATEMENT_LEN:
        return False
    if int.from_bytes(rec[:2], "big") != CLOSE_STATEMENT or rec[2] != 1:
        return False
    r = int.from_bytes(rec[116:148], "big")
    s = int.from_bytes(rec[148:180], "big")
    # trustee-identity.md, Signatures: 1 ≤ r < n, 1 ≤ s ≤ (n − 1) / 2.
    return 1 <= r < P256_N and 1 <= s <= (P256_N - 1) // 2


# ----------------------------------------------------------- the event check

RELAYED = "RelayedBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes)"
CLOSE = "CloseStatementSubmitted(bytes32,uint8,bytes)"

SIGNATURES = {role: list(sigs) for role, sigs in v2.SIGNATURES.items()}
SIGNATURES["board"] += [RELAYED, CLOSE]

INDEXED = dict(v2.INDEXED)
INDEXED["RelayedBallotSubmitted"] = ["definitionHash", "ballotHash"]
INDEXED["CloseStatementSubmitted"] = ["definitionHash", "signer"]


def event_check(rec, contracts, definitions):
    """Version 3's event check: (role, event, fields) or the first failing code."""
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

    if name == "RelayedBallotSubmitted":
        body = abi_tail(data, 5, 4, 1)
        if body is None:
            return "event-data"
        fields = [uint_of(data[32 * i : 32 * i + 32], 64) for i in range(4)]
        if any(f is None for f in fields):
            return "event-data"
        framed = v2.frame_ballot(body)
        if not framed or framed != (topics[1], topics[2]):
            return "event-data"
        index, l1_block, stamp, gas_limit = fields
        return {
            "event": name,
            "definitionHash": topics[1].hex(),
            "ballotHash": topics[2].hex(),
            "index": str(index),
            "l1Block": str(l1_block),
            "stamp": str(stamp),
            "gasLimit": str(gas_limit),
            "record": body.hex(),
        }
    if name == "CloseStatementSubmitted":
        signer = uint_of(topics[2], 8)
        if signer is None:
            return "event-topics"
        body = abi_tail(data, 1, 0, 1)
        if body is None or not close_statement_ok(body):
            return "event-data"
        if body[3:35] != topics[1] or body[35] != signer:
            return "event-data"
        return {"event": name, "definitionHash": topics[1].hex(), "signer": signer, "record": body.hex()}
    # Every other event is checked as version 2 checks it.
    return v2.event_check(rec, contracts, definitions)


# ----------------------------------------------------------- vectors

def det(label, n):
    return v1.det(f"v3/{label}", n)


def main(root):
    vec = root / "docs/spec/vectors"

    def load(name):
        return json.loads((vec / name).read_text())

    # --- version 2's records keep their verdicts: version 3 changes none of its rows.
    old = load("contract-event-v2.json")
    v2_contracts = {r: bytes.fromhex(a) for r, a in old["contracts"].items()}
    definitions = {}
    for name in ("election-definition.json", "election-definition-v3.json", "election-definition-v4.json",
                 "election-definition-v5.json", "election-definition-v6.json"):
        for v in load(name)["vectors"]:
            definitions[v["encoding"]] = "error" not in v

    def as_rec(fields):
        return {
            "contract": bytes.fromhex(fields["contract"]),
            "n": int(fields["n"]),
            "block": int(fields["l2Block"]),
            "timestamp": int(fields["l2Timestamp"]),
            "topics": [bytes.fromhex(t) for t in fields["topics"]],
            "data": bytes.fromhex(fields["data"]),
        }

    for e in old["records"]:
        assert not isinstance(event_check(as_rec(e["fields"]), v2_contracts, definitions), str), e["id"]
    for e in old["eventFailures"]:
        assert event_check(as_rec(e["fields"]), v2_contracts, definitions) == e["error"], e["id"]

    # --- the inputs, each re-checked here.
    ballots = {}
    for prefix, name in (("v1/", "ballot.json"), ("v2/", "ballot-v2.json")):
        for b in load(name)["ballots"]:
            rec = bytes.fromhex(b["encoding"])
            framed = v2.frame_ballot(rec)
            assert framed is not None and framed[1].hex() == b["ballotHash"], b["id"]
            ballots[prefix + b["id"]] = rec
    relay = load("relay.json")
    cs = load("close-statement.json")
    statements = {s["id"]: bytes.fromhex(s["encoding"]) for s in cs["statements"]}
    for sid, s in statements.items():
        assert close_statement_ok(s), sid
    for d in cs["decodeErrors"]:
        assert not close_statement_ok(bytes.fromhex(d["encoding"])), d["id"]

    chain_id = 84532
    contracts = {r: det(r, 20) for r in ("election-registry", "trustee-registry", "group-registry", "board")}
    T = {s.split("(")[0]: sig_topic(s) for sigs in SIGNATURES.values() for s in sigs}
    er, board = contracts["election-registry"], contracts["board"]

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
            assert honest, (rid, result)
            entry["role"] = role
            entry["event"] = result
            records.append((entry, rec))

    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, topics, data, honest=False)

    # --- version 2's board events, unchanged.
    v1_rec = ballots["v1/ok-tier-0"]
    framed = v2.frame_ballot(v1_rec)
    record("ballot-submitted", "BallotSubmitted, as in version 2", board,
           [T["BallotSubmitted"], framed[0], framed[1]], word(32) + abi_bytes(v1_rec))

    # --- relayed ballots: the relay call's fields, then the record.
    def relayed_data(index, l1_block, stamp, gas_limit, rec):
        return word(index) + word(l1_block) + word(stamp) + word(gas_limit) + word(160) + abi_bytes(rec)

    def relayed(rid, description, rec, index, l1_block, stamp, gas_limit):
        f = v2.frame_ballot(rec)
        record(rid, description, board, [T["RelayedBallotSubmitted"], f[0], f[1]],
               relayed_data(index, l1_block, stamp, gas_limit, rec))

    call = relay["calls"][0]
    c_i, c_b, c_t, c_g = (int(call[k]) for k in ("index", "l1Block", "l1Timestamp", "gasLimit"))
    relayed("relayed-v1", "RelayedBallotSubmitted carrying ballot.json's ok-tier-0 with relay.json's first call's "
            "index, L1 block, stamp and gas limit", v1_rec, c_i, c_b, c_t, c_g)
    relayed("relayed-v1-repeat", "The same record relayed by another call: each relayed deposit the board accepts "
            "emits, even a byte-identical repeat", v1_rec, c_i + 1, c_b + 1, c_t + 12, c_g)
    relayed("relayed-v2", "RelayedBallotSubmitted carrying ballot-v2.json's ok-cell-0", ballots["v2/ok-cell-0"],
            7, 21_000_000, 1_760_100_000, 3_000_000)
    relayed("relayed-u64-max", "RelayedBallotSubmitted with every call field at 2^64 - 1", v1_rec,
            MAX_U64, MAX_U64, MAX_U64, MAX_U64)
    relayed("relayed-zero", "RelayedBallotSubmitted with every call field 0", v1_rec, 0, 0, 0, 0)
    relayed("relayed-option-proof", "RelayedBallotSubmitted carrying ballot.json's option-proof, which the "
            "verifier rejects at a validity proof: the board doesn't check those, so its event passes",
            ballots["v1/option-proof"], 9, 21_000_001, 1_760_100_012, 3_000_000)

    r_topics = [T["RelayedBallotSubmitted"], framed[0], framed[1]]
    r_data = relayed_data(c_i, c_b, c_t, c_g, v1_rec)
    fail("unknown-event-relayed-from-registry", "RelayedBallotSubmitted from the election registry's address", er,
         r_topics, r_data)
    fail("unknown-event-relayed-no-gas-limit", "A relayed-ballot event without the gas limit, a signature version 3 "
         "doesn't declare", board,
         [sig_topic("RelayedBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,bytes)"), framed[0], framed[1]],
         r_data)
    fail("unknown-event-relay-event", "The relay's own BallotRelayed signature from the board", board,
         [sig_topic("BallotRelayed(bytes32,uint64,bytes32)"), framed[0], word(0)], word(0))
    fail("event-topics-relayed-two", "RelayedBallotSubmitted without its ballot-hash topic", board, r_topics[:2],
         r_data)
    fail("event-topics-relayed-four", "RelayedBallotSubmitted with the index as a fourth topic", board,
         r_topics + [word(c_i)], r_data)
    fail("event-data-relayed-definition-topic", "RelayedBallotSubmitted whose definition topic isn't its record's",
         board, [r_topics[0], det("other-definition", 32), r_topics[2]], r_data)
    fail("event-data-relayed-hash-topic", "RelayedBallotSubmitted whose ballot-hash topic isn't its record's",
         board, [r_topics[0], r_topics[1], det("other-ballot", 32)], r_data)
    for i, label in enumerate(("index", "l1-block", "stamp", "gas-limit")):
        bad = r_data[: 32 * i] + (1 << 64).to_bytes(32, "big") + r_data[32 * i + 32 :]
        fail(f"event-data-relayed-{label}-over-u64", f"RelayedBallotSubmitted whose {label.replace('-', ' ')} word "
             "is 2^64", board, r_topics, bad)
    fail("event-data-relayed-offset", "RelayedBallotSubmitted whose record offset is 0x80, as if a field were "
         "missing", board, r_topics, r_data[:128] + word(128) + r_data[160:])
    fail("event-data-relayed-missing-field", "RelayedBallotSubmitted without its gas limit: the version-2 shape "
         "of four head words", board, r_topics, word(c_i) + word(c_b) + word(c_t) + word(128) + abi_bytes(v1_rec))
    fail("event-data-relayed-trailing-word", "RelayedBallotSubmitted with a word after the record", board, r_topics,
         r_data + word(0))
    fail("event-data-relayed-padding", "RelayedBallotSubmitted with a non-zero padding byte", board, r_topics,
         r_data[:-1] + b"\x01" if len(v1_rec) % 32 else r_data + b"\x01")
    receipt = bytes.fromhex(next(r for r in load("delivery.json")["records"] if r["id"] == "receipt")["encoding"])
    for rid, description, rec in (
        ("event-data-relayed-receipt", "RelayedBallotSubmitted carrying a share receipt", receipt),
        ("event-data-relayed-version-4", "RelayedBallotSubmitted carrying a ballot of version 4, which version 3's "
         "framing doesn't read", v1_rec[:2] + b"\x04" + v1_rec[3:]),
        ("event-data-relayed-tier-3", "RelayedBallotSubmitted carrying a version-1 ballot naming tier 3",
         v1_rec[:35] + b"\x03" + v1_rec[36:]),
        ("event-data-relayed-truncated", "RelayedBallotSubmitted whose record ends a byte early", v1_rec[:-1]),
        ("event-data-relayed-trailing", "RelayedBallotSubmitted whose record has a byte after its last field",
         v1_rec + b"\x00"),
    ):
        assert v2.frame_ballot(rec) is None, rid
        fail(rid, description, board, r_topics, relayed_data(c_i, c_b, c_t, c_g, rec))
    fail("event-data-ballot-submitted-relayed-shape", "BallotSubmitted carrying a relayed-ballot event's data",
         board, [T["BallotSubmitted"], framed[0], framed[1]], r_data)

    # --- close statements: the record whole, its definition and signer as the topics.
    def close_topics(st):
        return [T["CloseStatementSubmitted"], st[3:35], word(st[35])]

    def closed(rid, description, st):
        record(rid, description, board, close_topics(st), word(32) + abi_bytes(st))

    for sid, st in statements.items():
        closed(f"close-{sid}", f"CloseStatementSubmitted carrying close-statement.json's {sid}", st)
    s1 = statements["seat-1"]
    c_topics, c_data = close_topics(s1), word(32) + abi_bytes(s1)
    fail("unknown-event-close-from-registry", "CloseStatementSubmitted from the election registry's address", er,
         c_topics, c_data)
    fail("unknown-event-close-bytes32-signer", "A close-statement event whose signer is a bytes32", board,
         [sig_topic("CloseStatementSubmitted(bytes32,bytes32,bytes)"), c_topics[1], c_topics[2]], c_data)
    fail("event-topics-close-two", "CloseStatementSubmitted without its signer topic", board, c_topics[:2], c_data)
    fail("event-topics-close-four", "CloseStatementSubmitted with a fourth topic", board, c_topics + [word(0)],
         c_data)
    fail("event-topics-close-signer-high", "CloseStatementSubmitted whose signer word has a bit above 8 set",
         board, [c_topics[0], c_topics[1], word(256 + s1[35])], c_data)
    fail("event-data-close-definition-topic", "CloseStatementSubmitted whose definition topic isn't its record's",
         board, [c_topics[0], det("other-definition", 32), c_topics[2]], c_data)
    fail("event-data-close-signer-topic", "CloseStatementSubmitted whose signer topic isn't its record's", board,
         [c_topics[0], c_topics[1], word(s1[35] + 1)], c_data)
    fail("event-data-close-trailing-word", "CloseStatementSubmitted with a word after the record", board, c_topics,
         c_data + word(0))
    fail("event-data-close-padding", "CloseStatementSubmitted with a non-zero padding byte", board, c_topics,
         c_data[:-1] + b"\x01")
    for d in cs["decodeErrors"]:
        st = bytes.fromhex(d["encoding"])
        topics = [T["CloseStatementSubmitted"], st[3:35].ljust(32, b"\x00"), word(st[35] if len(st) > 35 else 0)]
        fail(f"event-data-close-{d['id']}", f"CloseStatementSubmitted carrying close-statement.json's {d['id']} "
             f"({d['description']})", board, topics, word(32) + abi_bytes(st))
    fail("event-data-close-as-ballot", "BallotSubmitted carrying a close statement", board,
         [T["BallotSubmitted"], c_topics[1], det("ballot", 32)], c_data)
    fail("event-data-close-carrying-ballot", "CloseStatementSubmitted carrying a ballot", board,
         [T["CloseStatementSubmitted"], framed[0], word(0)], word(32) + abi_bytes(v1_rec))

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

    reject("version-one", "Version 1, against the pinned version 3", honest[:2] + b"\x01" + honest[3:])
    reject("version-two", "Version 2, against the pinned version 3", honest[:2] + b"\x02" + honest[3:])
    reject("version-four", "Version 4, against the pinned version 3", honest[:2] + b"\x04" + honest[3:])
    reject("truncated-data", "The data one byte short of its length", honest[:-1])
    reject("trailing-bytes", "A byte after the data", honest + b"\x00")
    k_at = 3 + 20 + 24
    reject("topics-over-max", "Five topics", honest[:k_at] + (5).to_bytes(4, "big") + honest[k_at + 4:])

    # --- the board's records replayed into its accumulator.
    recs = [(e, r) for e, r in records if e["role"] == "board"]
    assert [r["n"] for _, r in recs] == list(range(len(recs)))
    acc = v1.genesis(chain_id, board)
    accs = []
    for _, r in recs:
        acc = v1.step(acc, r)
        accs.append(acc.hex())
    sequences = [{"role": "board", "records": [e["id"] for e, _ in recs], "accumulators": accs,
                  "count": str(len(recs))}]

    out = {
        "format": "abolish-contract-event-vectors/3",
        "title": "Contract-event records (0x0008) version 3: the board's relayed-ballot and close-statement events",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-v3-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event tables (version 3)) and of docs/spec/close.md's "
            "strict decoding of a close statement, over contract-event-v2-vectors.py's framing and version-2 "
            "check; ballots from ballot.json and ballot-v2.json, relay call fields from relay.json, close "
            "statements from close-statement.json, and every record of contract-event-v2.json re-checked"
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
    with open(vec / "contract-event-v3.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
