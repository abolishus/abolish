#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-events.json.

Elections for check 4.4's per-record part (docs/spec/verifier.md, Contract
events): each is an election definition and a board copy, with the row 4.4 a
verifier reports. Every contract-event record (0x0008) of the election on
the copy is decoded under the contract-event version the profile pins and
judged by the event check against the definition's L2 contracts
(contracts.md, Contract-event record, Event check); the first that fails, in
copy order, decides 4.4 at its entry, and otherwise 4.4 stays unverifiable
(`not-implemented`): which events must be boarded, and the accumulator's
replay, wait on L2 reads and the archive.

A failing record fails 4.4 only inside the extent 4.1 and 4.2 authenticated;
on a copy they don't authenticate it leaves 4.4 unverifiable with its code
(verifier.md, Contract events, step 3; T-53). No board here is anchored: a
bundle gives it with another election's L1 evidence, which anchors none of
it, so every failing case is `unverifiable` with the failing record's code.
The verifier's tests show the `fail` status over l1-anchor.json's anchored
boards, whose entry 1 is a placeholder of type 0x0008 that doesn't decode.

The records and their verdicts are contract-event.json's and
contract-event-v2.json's (contract-event-vectors.py and
contract-event-v2-vectors.py, independent Python implementations): a record
of `records` passes, one of `eventFailures` fails with its `error`, and one
of `decodeErrors` doesn't decode, with its `error`, each under its own file's
version and against its own file's contracts. The only verdict computed here
is `unknown-contract` for a record whose contract the definition doesn't
name, which the event check reports first. The definitions and envelopes come
from verifier-ceremony-vectors.py (definition-vectors.py,
regional-cells-vectors.py, definition-v4-vectors.py and board-vectors.py),
which share no code with packages/crypto or packages/verifier.

Usage: python3 -I -B verifier-events-vectors.py <out-dir>; then
`vp check --fix` (the committed file is formatted).
"""

import hashlib
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)
VECTORS = HERE.parents[3] / "docs" / "spec" / "vectors"


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


vc = _load("verifier_ceremony_vectors", "verifier-ceremony-vectors.py")
dv, rc, d4 = vc.dv, vc.rc, vc.d4
outcome = vc.outcome

CONTRACT_EVENT_TYPE = 0x0008
BOARD_ENTRY_TYPE = 0x0007
ROLES = {
    "election-registry": "election_registry",
    "trustee-registry": "trustee_registry",
    "group-registry": "group_registry",
    "board": "board",
}
NOT_IMPLEMENTED = outcome("unverifiable", "not-implemented")
UNSUPPORTED = outcome("unverifiable", "unsupported-version", {})


def load_events(name, version):
    """One contract-event vector file: its contracts by role, and every record encoding with its verdict under `version`."""
    raw = (VECTORS / name).read_bytes()
    doc = json.loads(raw)
    assert doc["version"] == version
    contracts = {role: bytes.fromhex(a) for role, a in doc["contracts"].items()}
    assert set(contracts) == set(ROLES)
    verdicts = {}
    for r in doc["records"]:
        verdicts[r["id"]] = (bytes.fromhex(r["encoding"]), None)
    for r in doc["eventFailures"]:
        verdicts[r["id"]] = (bytes.fromhex(r["encoding"]), r["error"])
    for r in doc["decodeErrors"]:
        verdicts[f"decode/{r['id']}"] = (bytes.fromhex(r["encoding"]), ("decode", r["error"]))
    order = [r["id"] for r in doc["records"]]
    return {"file": name, "sha256": hashlib.sha256(raw).hexdigest(), "version": version, "contracts": contracts, "verdicts": verdicts, "records": order}


V1 = load_events("contract-event.json", 1)
V2 = load_events("contract-event-v2.json", 2)
FILES = {1: V1, 2: V2}


def pins_of(d):
    return dict(d["profile"]["pins"])


def verdict(d, payload):
    """The event check's verdict on one boarded record: decode, then unknown-contract, then the vector file's (contracts.md, Event check)."""
    version = pins_of(d)[CONTRACT_EVENT_TYPE]
    f = FILES[version]
    found = [v for p, v in f["verdicts"].values() if p == payload]
    assert found, "every record here is one of its version's vectors"
    assert all(x == found[0] for x in found), "one encoding, one verdict"
    v = found[0]
    if isinstance(v, tuple):
        return v
    # The record decodes: its contract is bytes 3 to 23, after the record
    # header (notation.md, Record header).
    contract = payload[3:23]
    named = {d[k] for k in ROLES.values()}
    if contract not in named:
        return "unknown-contract"
    # Judged against the file's own contracts, role for role; nothing here
    # models a definition that names them under other roles.
    assert all(d[k] == f["contracts"][role] for role, k in ROLES.items())
    return v


def expected(d, entries, anchored=None):
    """4.4 as far as the copy decides it, computed here from verifier.md and contracts.md; `anchored` is the extent 4.1 and 4.2 authenticated, if they pass."""
    status = "unverifiable" if anchored is None else "fail"
    pins = pins_of(d)
    if pins.get(CONTRACT_EVENT_TYPE) not in (1, 2):
        return UNSUPPORTED
    for at, raw in enumerate(entries):
        if anchored is not None and at >= anchored:
            break
        env = vc.decode_entry(raw, pins[BOARD_ENTRY_TYPE])
        if isinstance(env, str) or env["electionId"] != d["election_id"]:
            continue
        if int.from_bytes(env["payload"][:2], "big") != CONTRACT_EVENT_TYPE:
            continue
        v = verdict(d, env["payload"])
        if v is None:
            continue
        if isinstance(v, tuple):
            return outcome(status, "decode", {"entry": at, "decodeError": v[1]})
        return outcome(status, v, {"entry": at})
    return NOT_IMPLEMENTED


def main(out_dir):
    vc.self_check()
    eid = dv.TYPICAL["election_id"]
    assert rc.TYPICAL["election_id"] == eid == d4.TYPICAL["election_id"]
    other_eid = b"\xee" * 32

    def definition(base, events, contracts_of, board_version=None):
        """`base` pinning contract-event version `events` (and board-entry version `board_version`), naming `contracts_of`'s contracts."""
        pin = {CONTRACT_EVENT_TYPE: events, **({BOARD_ENTRY_TYPE: board_version} if board_version else {})}
        pins = [(ty, pin.get(ty, v)) for ty, v in base["profile"]["pins"]]
        d = dict(base, profile={"protocol_major": 1, "pins": pins}, **{k: contracts_of["contracts"][role] for role, k in ROLES.items()})
        assert vc.RULE[vc.own_version(d)](d) is None, vc.RULE[vc.own_version(d)](d)
        return d

    cases = []

    def case(id_, description, d, payloads, want, entry_version=None, elections=None):
        board_version = pins_of(d)[BOARD_ENTRY_TYPE]
        entries = []
        for i, p in enumerate(payloads):
            election = eid if elections is None else elections[i]
            entries.append(vc.entry(entry_version or board_version, election, len(entries), 0, p))
        row = expected(d, entries)
        assert row == want, (id_, row)
        cases.append(
            {
                "id": id_,
                "description": description,
                "definition": vc.encode(d).hex(),
                # Only 4.1 and 4.2 read the clock; every entry is in segment 0.
                "clock": {"epoch": str(d["closes_at"] - 7200), "period": "3600", "deadline": "7200", "lastSegment": "8"},
                "board": b"".join(entries).hex(),
                "expected": {"4.4": row},
            }
        )

    def rec(f, id_):
        return f["verdicts"][id_][0]

    d1 = definition(dv.TYPICAL, 1, V1)
    d2 = definition(d4.TYPICAL, 2, V2, board_version=4)
    d2_v1 = definition(dv.TYPICAL, 2, V2)
    d3 = definition(rc.TYPICAL, 2, V2, board_version=3)
    honest1 = [rec(V1, i) for i in V1["records"]]
    honest2 = [rec(V2, i) for i in V2["records"]]

    case("v1-records", "Definition version 1 pinning contract-event version 1: every honest record of contract-event.json, in its order, each passing the event check. 4.4 stays unverifiable (not-implemented): the required entries and the accumulator's replay wait on L2 reads and the archive.", d1, honest1, NOT_IMPLEMENTED)
    case("v2-records", "Definition version 4 pinning board-entry version 4 and contract-event version 2: every honest record of contract-event-v2.json, the board's events included, each passing. 4.4 is not-implemented.", d2, honest2, NOT_IMPLEMENTED)
    case("v3-records", "Definition version 3 pinning board-entry version 3 and contract-event version 2: a ballot, a share receipt and a group creation, each passing. 4.4 is not-implemented.", d3, [rec(V2, "ballot-v2"), rec(V2, "share-receipt"), rec(V2, "group-created")], NOT_IMPLEMENTED)
    case("none", "No contract-event record on the copy: 4.4 is not-implemented, never a pass, since which events must be boarded isn't known yet.", d1, [], NOT_IMPLEMENTED)

    case(
        "first-failure",
        "Contract-event version 2: an honest creation, a ballot whose hash topic disagrees with its record (event-data), then a log from an address the definition doesn't name (unknown-contract). The first failure in copy order decides 4.4: event-data at entry 1.",
        d2,
        [rec(V2, "election-created"), rec(V2, "event-data-ballot-hash-topic"), rec(V1, "unknown-contract")],
        outcome("unverifiable", "event-data", {"entry": 1}),
    )
    for f, d, ids in [
        (V1, d1, ["unknown-contract", "unknown-event-board", "unknown-event-no-topics", "event-topics-too-few", "event-topics-tier-over-u8", "event-data-trailing", "event-data-definition-v3", "event-data-registration-count"]),
        (V2, d2, ["unknown-event-ballot-from-registry", "event-topics-ballot-two", "event-data-ballot-element-zero", "event-data-registration-v1-layout", "event-data-receipt-high-s"]),
    ]:
        for id_ in ids:
            error = f["verdicts"][id_][1]
            case(
                f"v{f['version']}-{id_}",
                f"Contract-event version {f['version']}: an honest group creation, then {f['file']}'s `{id_}` record, the first failure: {error} at entry 1.",
                d,
                [rec(f, "group-created"), rec(f, id_)],
                outcome("unverifiable", error, {"entry": 1}),
            )
    for f, d, ids in [(V1, d1, ["version-two", "trailing-bytes", "data-over-max"]), (V2, d2, ["version-one", "version-three", "truncated-data", "topics-over-max"])]:
        for id_ in ids:
            code = f["verdicts"][f"decode/{id_}"][1][1]
            case(
                f"v{f['version']}-decode-{id_}",
                f"Contract-event version {f['version']}: an honest group creation, then {f['file']}'s `{id_}` encoding, which doesn't decode under the pinned version, the first failure: decode ({code}) at entry 1.",
                d,
                [rec(f, "group-created"), rec(f, f"decode/{id_}")],
                outcome("unverifiable", "decode", {"entry": 1, "decodeError": code}),
            )

    case(
        "board-event-under-v1",
        "Definition version 1 pinning contract-event version 1, whose tables name no board event: contract-event.json's board log fails unknown-event, so a profile pinning version 1 fails 4.4 at its first boarded board event (contracts.md, Event tables (version 2)).",
        d1,
        [rec(V1, "election-created"), rec(V1, "unknown-event-board")],
        outcome("unverifiable", "unknown-event", {"entry": 1}),
    )
    case(
        "other-contracts",
        "Contract-event version 2 against a definition naming contract-event.json's contracts: contract-event-v2.json's honest records name none of them, so the first fails unknown-contract.",
        definition(d4.TYPICAL, 2, V1, board_version=4),
        [rec(V2, "group-created"), rec(V2, "election-created")],
        outcome("unverifiable", "unknown-contract", {"entry": 0}),
    )
    case(
        "definition-v1-events-v2",
        "Definition version 1 pinning contract-event version 2: the registries' events pass under version 2's tables, and a version-1 record doesn't decode (profile-mismatch) at entry 2.",
        d2_v1,
        [rec(V2, "election-created"), rec(V2, "ceremony-registered"), rec(V2, "decode/version-one")],
        outcome("unverifiable", "decode", {"entry": 2, "decodeError": "profile-mismatch"}),
    )
    case(
        "other-election",
        "Failing records in entries of another election, which 4.1 reports and 4.4 never reads, around an honest one of this election: 4.4 is not-implemented.",
        d2,
        [rec(V2, "event-data-ballot-hash-topic"), rec(V2, "election-created"), rec(V1, "unknown-contract")],
        NOT_IMPLEMENTED,
        elections=[other_eid, eid, other_eid],
    )
    case(
        "other-record-types",
        "Entries of this election carrying other records (a ceremony transcript's and a tally opening's record headers with two bytes, which 4.4 doesn't decode), around an honest contract-event record: only type 0x0008 is 4.4's, so it is not-implemented.",
        d1,
        [b"\x00\x05\x01\xaa\xbb", rec(V1, "group-created"), b"\x00\x06\x01\xaa\xbb"],
        NOT_IMPLEMENTED,
    )
    case(
        "envelope-undecodable",
        "Definition version 1 pins board-entry version 1; the only entries are version-3 envelopes carrying a failing record, which don't decode under the pin (4.1's to report): 4.4 reads no record and is not-implemented.",
        d1,
        [rec(V1, "unknown-contract"), rec(V1, "event-data-trailing")],
        NOT_IMPLEMENTED,
        entry_version=3,
    )
    for events in (3, 255):
        case(
            f"events-v{events}",
            f"The profile pins contract-event version {events}, unknown here: 4.4 is unverifiable (unsupported-version) whatever the copy holds, failing records included (T-36).",
            definition(dv.TYPICAL, events, V1),
            [rec(V1, "unknown-contract"), rec(V1, "decode/trailing-bytes")],
            UNSUPPORTED,
        )

    doc = {
        "format": "abolish-verifier-events-vectors/1",
        "title": "The verifier's contract-event check over the board: definitions and boards, with the row 4.4",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-events-vectors.py, from verifier-ceremony-vectors.py and the records of "
            "contract-event.json and contract-event-v2.json (independent Python implementations)"
        ),
        "inputs": {f["file"]: f["sha256"] for f in (V1, V2)},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-events.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: verifier-events-vectors.py <out-dir>")
    main(sys.argv[1])
