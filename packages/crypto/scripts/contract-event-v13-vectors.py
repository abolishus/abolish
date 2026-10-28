#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/contract-event-v13.json.

A second implementation of docs/spec/contracts.md (Contract-event record,
Event tables (version 13)): record type 0x0008 version 13, its strict
decoding, and the event check under version 13's tables, which are version
12's with the election registry's `DefinitionRegistered` reading the
definition versions a registry that registers version 7 decodes
(Election registry, Registration, rule 2):

- `DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)`,
  indexed `electionId` and `definitionHash`, carries its L1 origin and the
  definition, which decodes under the layout its version byte names,
  version 1 or 3 to 7, with its self-pin; version 12 decodes 1 and 3 to 6
  only, so a version-7 definition's registration fails it (`event-data`);
- every other event is checked as version 12 checks it.

Whether a definition decodes is each election-definition file's own verdict
(election-definition.json and -v3 to -v7, from their independent
generators), as contract-event-v2-vectors.py reads them, so nothing here
decodes a definition itself.

It reuses only this folder's other independent generators:
contract-event-v12-vectors.py (version 12, from the same spec) for version
12's check of every event version 13 keeps unchanged, and through it the
earlier versions' framing and accumulator. It shares no code with
packages/crypto or packages/contracts.

Usage: python3 -I -B packages/crypto/scripts/contract-event-v13-vectors.py <repo-root>,
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


v12 = _load("contract_event_v12_vectors", "contract-event-v12-vectors.py")
v1 = v12.v1

word, abi_bytes, sig_topic = v1.word, v1.abi_bytes, v1.sig_topic
Reject = v1.Reject

RECORD_TYPE = 0x0008
VERSION = 13
MAX_EVENT_DATA = v1.MAX_EVENT_DATA
MAX_EVENT_TOPICS = v1.MAX_EVENT_TOPICS

DEFINITION_REGISTERED = "DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)"

# The definition versions each event version's DefinitionRegistered decodes (rule 2 of the registry
# that emits it): 1 and 3 to 6 under versions 2 to 12, and 7 besides under version 13.
DECODED_V12 = (1, 3, 4, 5, 6)
DECODED = (1, 3, 4, 5, 6, 7)


# ----------------------------------------------------------- the record

def encode(contract, n, block, timestamp, topics, data):
    return v1.encode(contract, n, block, timestamp, topics, data, version=VERSION)


def decode(b):
    """Strict decoding with version 13 pinned: version 12's layout, field for field."""
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE and b[2] == VERSION:
        return v12.decode(b[:2] + bytes([v12.VERSION]) + b[3:])
    if len(b) >= 3 and int.from_bytes(b[:2], "big") == RECORD_TYPE:
        raise Reject("profile-mismatch", 2)
    return v12.decode(b)


# ----------------------------------------------------------- the event check

SIGNATURES = {role: list(sigs) for role, sigs in v12.SIGNATURES.items()}
assert DEFINITION_REGISTERED in SIGNATURES["election-registry"]
INDEXED = dict(v12.INDEXED)
assert INDEXED["DefinitionRegistered"] == ["electionId", "definitionHash"]


def event_check(rec, contracts, decodes):
    """Version 13's event check: (role, event, fields) or the first failing code.

    `decodes` maps each definition encoding (hex) to its definition version and whether it decodes
    under that version's layout and self-pin. Version 13's tables are version 12's with one row
    changed: the definition a `DefinitionRegistered` carries may be version 7 as well. The row's
    topics and ABI framing are version 2's, unchanged, so the check is version 12's given version
    13's decoding."""
    return v12.event_check(rec, contracts, registrable(decodes, DECODED))


def event_check_v12(rec, contracts, decodes):
    """Version 12's event check over the same definitions, which decodes versions 1 and 3 to 6."""
    return v12.event_check(rec, contracts, registrable(decodes, DECODED_V12))


def registrable(decodes, versions):
    """The map earlier generators' DefinitionRegistered check reads: whether rule 2 decodes it."""
    return {enc: ok and version in versions for enc, (version, ok) in decodes.items()}


# ----------------------------------------------------------- vectors

def det(label, n):
    return v1.det(f"v13/{label}", n)


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

    # --- definitions: each file's verdict under its own version's layout and self-pin.
    decodes, by_id = {}, {}
    for name, version in (
        ("election-definition.json", 1),
        ("election-definition-v3.json", 3),
        ("election-definition-v4.json", 4),
        ("election-definition-v5.json", 5),
        ("election-definition-v6.json", 6),
        ("election-definition-v7.json", 7),
    ):
        for v in load(name)["vectors"]:
            by_id[v["id"]] = bytes.fromhex(v["encoding"])
            decodes[v["encoding"]] = (version, "error" not in v)

    # --- version 12's records keep their verdicts: version 13 changes only DefinitionRegistered,
    # which no version-12 vector carries.
    old = load("contract-event-v12.json")
    v12_contracts = {r: bytes.fromhex(a) for r, a in old["contracts"].items()}
    for e in old["records"]:
        assert event_check(as_rec(e["fields"]), v12_contracts, decodes) == e["event"], e["id"]
    for e in old["eventFailures"]:
        assert event_check(as_rec(e["fields"]), v12_contracts, decodes) == e["error"], e["id"]
    # Every election-registry vector of version 2, whose rows versions 3 to 12 keep: each keeps its
    # verdict but the version-7 registration, which version 13 decodes.
    v2_file = load("contract-event-v2.json")
    v2_contracts = {r: bytes.fromhex(a) for r, a in v2_file["contracts"].items()}
    er_v2 = v2_file["contracts"]["election-registry"]
    v2_moved = []
    for e in v2_file["records"]:
        if e["fields"]["contract"] == er_v2:
            assert event_check(as_rec(e["fields"]), v2_contracts, decodes) == e["event"], e["id"]
    for e in v2_file["eventFailures"]:
        if e["fields"]["contract"] == er_v2:
            got = event_check(as_rec(e["fields"]), v2_contracts, decodes)
            if e["id"] == "event-data-definition-v7":
                assert got["event"] == "DefinitionRegistered", e["id"]
                v2_moved.append(e["id"])
            else:
                assert got == e["error"], e["id"]
    assert v2_moved == ["event-data-definition-v7"]

    chain_id = 84532
    contracts = {r: det(r, 20) for r in ("election-registry", "trustee-registry", "group-registry", "board")}
    T = {s.split("(")[0]: sig_topic(s) for sigs in SIGNATURES.values() for s in sigs}
    er = contracts["election-registry"]

    records, failures, v12_verdicts = [], [], {}
    counters = {r: 0 for r in contracts}

    def record(rid, description, contract, topics, data, honest=True, block=50):
        role = next((r for r, a in contracts.items() if a == contract), None)
        if honest:
            n = counters[role]
            counters[role] += 1
        else:
            n, block = 0, 1
        ts = 1_779_840_000 + 2 * block
        rec = {"contract": contract, "n": n, "block": block, "timestamp": ts, "topics": topics, "data": data}
        enc = encode(contract, n, block, ts, topics, data)
        assert decode(enc) == rec
        result = event_check(rec, contracts, decodes)
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
            # Under version 12 a version-7 definition doesn't decode (event-data); every other record
            # version 13 passes, version 12 passes alike.
            old_verdict = event_check_v12(rec, contracts, decodes)
            if isinstance(old_verdict, str):
                assert old_verdict == "event-data" and result["event"] == "DefinitionRegistered", rid
                assert decodes[result["definition"]][0] == 7, rid
                v12_verdicts[rid] = old_verdict
            else:
                assert old_verdict == result, rid
        return entry

    def fail(rid, description, contract, topics, data):
        record(rid, description, contract, topics, data, honest=False)

    origin = word(19_000_001) + word(1_779_839_000) + det("l1-origin-hash", 32)

    def registered(defn):
        return origin + word(0x80) + abi_bytes(defn)

    # ---------------------------------------------------------------- honest records

    record("election-created", "ElectionCreated, as in versions 1 to 12", er,
           [T["ElectionCreated"], det("election-id", 32), bytes(12) + det("creator", 20)],
           word(0) + word(19_000_000) + word(1_779_838_000) + det("l1-origin-hash-0", 32))
    for did, what in (
        ("definition-v7-rolling-typical", "a rolling version-7 definition (electorate_mode 2)"),
        ("definition-v7-rolling-minimal", "the smallest rolling version-7 definition"),
        ("definition-v7-rolling-lists-at-max", "a rolling version-7 definition with its lists at their maxima"),
        ("definition-v7-fixed-typical", "a fixed version-7 definition (electorate_mode 1)"),
        ("definition-v7-fixed-minimal", "the smallest fixed version-7 definition"),
        ("definition-v7-fixed-civic", "a fixed version-7 civic referendum"),
        ("definition-v7-rolling-with-fixed-electorate", "a rolling version-7 definition that also lists a fixed "
         "electorate, which decodes and fails well-formedness: the check reads the form only"),
        ("definition-v7-rolling-civic", "a rolling version-7 civic referendum, which decodes and fails "
         "well-formedness (rolling-class): rule 2 decodes it, and rule 3 refuses it, so no registry logs it, "
         "but the event check reads the form only, and well-formedness is 2.1's"),
        ("definition-typical", "a version-1 definition, as in versions 2 to 12"),
        ("definition-v3-typical", "a version-3 definition, as in versions 2 to 12"),
        ("definition-v4-typical", "a version-4 definition, as in versions 2 to 12"),
        ("definition-v5-typical", "a version-5 definition, as in versions 2 to 12"),
        ("definition-v6-typical", "a version-6 definition, as in versions 2 to 12"),
        ("definition-v6-lists-at-max", "a version-6 definition with its lists at their maxima, as in versions 2 "
         "to 12"),
    ):
        assert decodes[by_id[did].hex()][1], did
        record(f"definition-registered/{did}", f"DefinitionRegistered carrying {what}", er,
               [T["DefinitionRegistered"], det(f"election-id/{did}", 32), det(f"definition-hash/{did}", 32)],
               registered(by_id[did]))

    # ---------------------------------------------------------------- failures

    tp = [T["DefinitionRegistered"], det("election-id", 32), det("definition-hash", 32)]
    for did, what in (
        ("definition-v7-truncated", "a version-7 definition one byte short"),
        ("definition-v7-trailing", "a version-7 definition with a trailing byte"),
        ("definition-v7-electorate-mode-0", "a version-7 definition whose electorate_mode is 0"),
        ("definition-v7-electorate-mode-3", "a version-7 definition whose electorate_mode is 3"),
        ("definition-v7-rolling-electorate-over-max", "a rolling electorate of more tiers than the layout allows"),
        ("definition-v7-rolling-tier-three", "a rolling tier labelled tier 3"),
        ("definition-v7-rolling-root-r", "a rolling tier's root at the field's modulus, non-canonical"),
        ("definition-v7-rolling-groups-over-max", "a rolling tier listing more groups than the layout allows"),
        ("definition-v7-profile-pins-six", "a version-7 definition whose profile pins definition version 6: "
         "its self-pin fails"),
        ("definition-v7-labelled-six", "a version-7 definition's bytes labelled version 6"),
        ("definition-v6-labelled-seven", "a version-6 definition's bytes labelled version 7"),
        ("definition-v7-version-eight", "a definition labelled version 8, which no registry decodes"),
        ("definition-truncated", "a version-1 definition that doesn't decode, as in versions 2 to 12"),
    ):
        assert not decodes[by_id[did].hex()][1], did
        fail(f"event-data-definition-{did.removeprefix('definition-')}", f"DefinitionRegistered carrying {what}", er, tp,
             registered(by_id[did]))
    rolling = by_id["definition-v7-rolling-typical"]
    # definition-v7-truncated is this definition less its last byte, framed as the ABI frames it.
    assert by_id["definition-v7-truncated"] == rolling[:-1]
    data = registered(rolling)
    fail("event-data-definition-registered-trailing-word", "A word after the definition", er, tp, data + word(0))
    fail("event-data-definition-registered-offset", "The definition's offset at 0xa0, a word past the head", er,
         tp, origin + word(0xA0) + word(0) + data[128:])
    fail("event-data-definition-registered-origin-over-u64", "The L1 origin's number above a uint64", er, tp,
         word(2**64) + data[32:])
    fail("event-topics-definition-registered-no-hash", "DefinitionRegistered without its definitionHash topic",
         er, tp[:2], data)
    fail("unknown-event-definition-registered-from-board", "DefinitionRegistered from the board's address",
         contracts["board"], tp, data)
    fail("unknown-event-definition-registered-from-trustee-registry", "DefinitionRegistered from the trustee "
         "registry's address", contracts["trustee-registry"], tp, data)
    fail("unknown-contract-definition-registered", "DefinitionRegistered from an address that is none of the "
         "definition's contracts", det("unknown-contract", 20), tp, data)

    ids = [e["id"] for e, _ in records] + [e["id"] for e in failures]
    assert len(ids) == len(set(ids))
    # Every honest version-7 registration is one version 12 fails, and nothing else is.
    assert sorted(v12_verdicts) == sorted(
        e["id"] for e, _ in records
        if e["event"]["event"] == "DefinitionRegistered" and decodes[e["event"]["definition"]][0] == 7
    )

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

    reject("version-twelve", "Version 12, against the pinned version 13", first[:2] + b"\x0c" + first[3:])
    reject("version-fourteen", "Version 14, against the pinned version 13", first[:2] + b"\x0e" + first[3:])
    reject("truncated-data", "The data one byte short of its length", first[:-1])
    reject("trailing-bytes", "A byte after the data", first + b"\x00")

    recs = [(e, r) for e, r in records if e["role"] == "election-registry"]
    assert len(recs) == len(records)
    assert [r["n"] for _, r in recs] == list(range(len(recs)))
    acc = v1.genesis(chain_id, er)
    accs = []
    for _, r in recs:
        acc = v1.step(acc, r)
        accs.append(acc.hex())
    sequences = [{"role": "election-registry", "records": [e["id"] for e, _ in recs], "accumulators": accs,
                  "count": str(len(recs))}]

    out = {
        "format": "abolish-contract-event-vectors/13",
        "title": "Contract-event records (0x0008) version 13: the election registry's DefinitionRegistered "
                 "carrying a version-7 definition",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/contract-event-v13-vectors.py: an independent Python implementation of "
            "docs/spec/contracts.md (Contract-event record, Event tables (version 13)) over "
            "contract-event-v12-vectors.py's version-12 check; definitions and their decoding verdicts from "
            "election-definition.json and election-definition-v3.json to -v7.json, and every record of "
            "contract-event-v12.json and every election-registry vector of contract-event-v2.json re-checked"
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
        "underVersion12": v12_verdicts,
        "decodeErrors": decode_errors,
        "sequences": sequences,
    }
    with open(vec / "contract-event-v13.json", "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
