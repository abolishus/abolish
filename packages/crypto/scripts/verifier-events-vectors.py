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

The records and their verdicts are contract-event.json's,
contract-event-v2.json's to contract-event-v8.json's
(contract-event-vectors.py and contract-event-v2-vectors.py to
contract-event-v8-vectors.py, independent Python implementations): a record
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
V3 = load_events("contract-event-v3.json", 3)
V4 = load_events("contract-event-v4.json", 4)
V5 = load_events("contract-event-v5.json", 5)
V6 = load_events("contract-event-v6.json", 6)
V7 = load_events("contract-event-v7.json", 7)
V8 = load_events("contract-event-v8.json", 8)
FILES = {1: V1, 2: V2, 3: V3, 4: V4, 5: V5, 6: V6, 7: V7, 8: V8}


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
    if pins.get(CONTRACT_EVENT_TYPE) not in FILES:
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

    def honest(f):
        """An honest record to open a failure case with, and how it reads: version 3's and version 8's files have only the board's records, and version 7's names its signed group creation apart from its self-paid one."""
        if "group-created" in f["verdicts"]:
            return ("group-created", "an honest group creation")
        if "group-created-signed" in f["verdicts"]:
            return ("group-created-signed", "an honest signed group creation")
        return ("ballot-submitted", "an honest ballot submission")

    d1 = definition(dv.TYPICAL, 1, V1)
    d2 = definition(d4.TYPICAL, 2, V2, board_version=4)
    d2_v1 = definition(dv.TYPICAL, 2, V2)
    d3 = definition(rc.TYPICAL, 2, V2, board_version=3)
    d3_v4 = definition(d4.TYPICAL, 3, V3, board_version=4)
    d4_v4 = definition(d4.TYPICAL, 4, V4, board_version=4)
    d5_v4 = definition(d4.TYPICAL, 5, V5, board_version=4)
    d6_v4 = definition(d4.TYPICAL, 6, V6, board_version=4)
    d7_v4 = definition(d4.TYPICAL, 7, V7, board_version=4)
    d8_v4 = definition(d4.TYPICAL, 8, V8, board_version=4)
    honest1 = [rec(V1, i) for i in V1["records"]]
    honest2 = [rec(V2, i) for i in V2["records"]]
    honest3 = [rec(V3, i) for i in V3["records"]]
    honest4 = [rec(V4, i) for i in V4["records"]]
    honest5 = [rec(V5, i) for i in V5["records"]]
    honest6 = [rec(V6, i) for i in V6["records"]]
    honest7 = [rec(V7, i) for i in V7["records"]]
    honest8 = [rec(V8, i) for i in V8["records"]]

    case("v1-records", "Definition version 1 pinning contract-event version 1: every honest record of contract-event.json, in its order, each passing the event check. 4.4 stays unverifiable (not-implemented): the required entries and the accumulator's replay wait on L2 reads and the archive.", d1, honest1, NOT_IMPLEMENTED)
    case("v2-records", "Definition version 4 pinning board-entry version 4 and contract-event version 2: every honest record of contract-event-v2.json, the board's events included, each passing. 4.4 is not-implemented.", d2, honest2, NOT_IMPLEMENTED)
    case("v3-records", "Definition version 3 pinning board-entry version 3 and contract-event version 2: a ballot, a share receipt and a group creation, each passing. 4.4 is not-implemented.", d3, [rec(V2, "ballot-v2"), rec(V2, "share-receipt"), rec(V2, "group-created")], NOT_IMPLEMENTED)
    case("events-v3-records", "Definition version 4 pinning board-entry version 4 and contract-event version 3: every honest record of contract-event-v3.json, the board's ballots, relayed ballots and close statements, each passing. 4.4 is not-implemented.", d3_v4, honest3, NOT_IMPLEMENTED)
    case("events-v4-records", "Definition version 4 pinning board-entry version 4 and contract-event version 4: every honest record of contract-event-v4.json, a ballot and the board's share-receipt batches, each passing. 4.4 is not-implemented.", d4_v4, honest4, NOT_IMPLEMENTED)
    case("events-v5-records", "Definition version 4 pinning board-entry version 4 and contract-event version 5: every honest record of contract-event-v5.json, a ballot, a share-receipt batch and the board's obligation roots of both kinds, each passing. 4.4 is not-implemented.", d5_v4, honest5, NOT_IMPLEMENTED)
    case("events-v6-records", "Definition version 4 pinning board-entry version 4 and contract-event version 6: every honest record of contract-event-v6.json, a group creation and the group registry's Tier 1 additions, those the counting rule refuses included, each passing, since version 6 checks an addition's form, not whether it counts (contracts.md, Event tables (version 6)). 4.4 is not-implemented.", d6_v4, honest6, NOT_IMPLEMENTED)
    case("events-v7-records", "Definition version 4 pinning board-entry version 4 and contract-event version 7: every honest record of contract-event-v7.json, a signed group creation, the group registry's self-paid group creations and additions (an addition naming another group in its record or an index beyond the count included: those are 2.4's replay, never the event check's) and a signed addition, each passing. 4.4 is not-implemented.", d7_v4, honest7, NOT_IMPLEMENTED)
    case("events-v8-records", "Definition version 4 pinning board-entry version 4 and contract-event version 8: every honest record of contract-event-v8.json, a ballot, an obligation root and the board's availability attestations and complaints (of the author panel, of seat 255, naming a definition no election has and signed by another seat's key included: those are the availability check's, never the event check's), each passing. 4.4 is not-implemented.", d8_v4, honest8, NOT_IMPLEMENTED)
    case("none", "No contract-event record on the copy: 4.4 is not-implemented, never a pass, since which events must be boarded isn't known yet.", d1, [], NOT_IMPLEMENTED)

    case(
        "first-failure",
        "Contract-event version 2: an honest creation, a ballot whose hash topic disagrees with its record (event-data), then a version-1 encoding, which doesn't decode under the version-2 pin (decode, profile-mismatch). The first failure in copy order decides 4.4: event-data at entry 1.",
        d2,
        [rec(V2, "election-created"), rec(V2, "event-data-ballot-hash-topic"), rec(V1, "unknown-contract")],
        outcome("unverifiable", "event-data", {"entry": 1}),
    )
    for f, d, ids in [
        (V1, d1, ["unknown-contract", "unknown-event-board", "unknown-event-no-topics", "event-topics-too-few", "event-topics-tier-over-u8", "event-data-trailing", "event-data-definition-v3", "event-data-registration-count"]),
        (V2, d2, ["unknown-event-ballot-from-registry", "event-topics-ballot-two", "event-data-ballot-element-zero", "event-data-registration-v1-layout", "event-data-receipt-high-s"]),
        (V3, d3_v4, ["unknown-event-relayed-from-registry", "event-topics-relayed-two", "event-data-relayed-stamp-over-u64", "event-data-relayed-hash-topic", "event-data-close-signer-topic", "event-data-close-signature-high-s"]),
        (V4, d4_v4, ["unknown-event-batch-from-registry", "event-topics-batch-seat-high", "event-data-batch-seat-topic", "event-data-batch-unordered", "event-data-batch-high-s"]),
        (V5, d5_v4, ["unknown-event-root-from-registry", "event-topics-root-seat-high", "event-data-root-seat-topic", "event-data-root-cid-other-hash", "event-data-root-high-s", "event-data-batch-carrying-root"]),
        (V6, d6_v4, ["unknown-event-tier1-from-board", "event-topics-tier1-group-topic", "event-data-tier1-offset", "event-data-tier1-count-says-four", "event-data-tier1-root-r", "event-data-tier1-b-outside-subgroup", "event-data-members-added-carrying-tier1"]),
        (V7, d7_v4, ["unknown-event-created-from-board", "unknown-event-added-from-board", "event-topics-created-no-group", "event-data-created-with-data", "event-topics-added-index-above-u64", "event-data-added-short", "event-data-added-forbidden-r", "event-data-added-carrying-members-added", "event-data-members-added-carrying-self-paid"]),
        (V8, d8_v4, ["unknown-event-attestation-from-election-registry", "unknown-event-complaint-bytes32-seat", "event-topics-attestation-seat-high", "event-topics-complaint-four", "event-data-attestation-definition-topic", "event-data-complaint-seat-topic", "event-data-attestation-carrying-complaint", "event-data-availability-signature-high-s", "event-data-root-carrying-attestation"]),
    ]:
        for id_ in ids:
            error = f["verdicts"][id_][1]
            case(
                f"v{f['version']}-{id_}",
                f"Contract-event version {f['version']}: {honest(f)[1]}, then {f['file']}'s `{id_}` record, the first failure: {error} at entry 1.",
                d,
                [rec(f, honest(f)[0]), rec(f, id_)],
                outcome("unverifiable", error, {"entry": 1}),
            )
    for f, d, ids in [
        (V1, d1, ["version-two", "trailing-bytes", "data-over-max"]),
        (V2, d2, ["version-one", "version-three", "truncated-data", "topics-over-max"]),
        (V3, d3_v4, ["version-one", "version-two", "version-four"]),
        (V4, d4_v4, ["version-three", "version-five"]),
        (V5, d5_v4, ["version-four", "version-six"]),
        (V6, d6_v4, ["version-five", "version-seven"]),
        (V7, d7_v4, ["version-six", "version-eight", "truncated-data", "trailing-bytes"]),
        (V8, d8_v4, ["version-seven", "version-nine", "truncated-data", "trailing-bytes"]),
    ]:
        for id_ in ids:
            code = f["verdicts"][f"decode/{id_}"][1][1]
            case(
                f"v{f['version']}-decode-{id_}",
                f"Contract-event version {f['version']}: {honest(f)[1]}, then {f['file']}'s `{id_}` encoding, which doesn't decode under the pinned version, the first failure: decode ({code}) at entry 1.",
                d,
                [rec(f, honest(f)[0]), rec(f, f"decode/{id_}")],
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
    for events in (9, 255):
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
            "contract-event.json and contract-event-v2.json to contract-event-v8.json (independent Python implementations)"
        ),
        "inputs": {f["file"]: f["sha256"] for f in FILES.values()},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-events.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: verifier-events-vectors.py <out-dir>")
    main(sys.argv[1])
