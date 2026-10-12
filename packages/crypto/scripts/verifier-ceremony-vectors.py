#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-ceremony.json.

Elections for the verifier's key-ceremony checks (docs/spec/verifier.md,
Key ceremony): each is an election definition, a board copy and the panel a
bundle pins, with the rows 2.5, 3.1 and 3.2 a verifier reports and what its
transcript check found. Unlike ceremony.json, whose transcripts bind an
arbitrary stub hash, every transcript here is made for the stub of the
definition it is checked against, so the verifier rebuilds its context from
the definition alone.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: ceremony-vectors.py (the
rounds, the transcript and its check), definition-vectors.py (the definition
encoding and its rules) and board-vectors.py (the board-entry envelope).

Usage: python3 -I -B packages/crypto/scripts/verifier-ceremony-vectors.py <out-dir>
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


cv = _load("ceremony_vectors", "ceremony-vectors.py")
dv = _load("definition_vectors", "definition-vectors.py")
bdv = _load("board_vectors", "board-vectors.py")

H, ds = cv.H, cv.ds
TRANSCRIPT_TAG = b"abolish/v1/ceremony-transcript"
STUB_TAG = b"abolish/v1/election-stub"


def stub_hash(d):
    return H(ds(STUB_TAG, dv.enc_definition(dict(d, ceremony_transcript_hash=bytes(32)))))


def election_of(d):
    """The ceremony context's election fields, every one taken from the definition."""
    return {
        "l2ChainId": d["l2_chain_id"],
        "trusteeRegistry": d["trustee_registry"],
        "electionId": d["election_id"],
        "stubHash": stub_hash(d),
    }


def definition_for(panel, transcript_hash, **changes):
    d = dict(
        dv.TYPICAL,
        panel_id=cv.panel_id(panel["k"], panel["keys"]),
        threshold=panel["k"],
        panel_size=len(panel["keys"]),
        ceremony_transcript_hash=transcript_hash,
        **changes,
    )
    assert dv.definition_rule(d) is None, dv.definition_rule(d)
    return d


BOARD_ENTRY_TYPE = 0x0007
BALLOT_TYPE = 0x0002
TALLY_OPENING_TYPE = 0x0006
# docs/spec/board.md, Allowed payloads: version 3 adds share receipts (0x000c)
# and complaints (0x000e) to version 1's set; version 4 adds the destruction
# statement (0x000f). Every version has the same layout.
ALLOWED = {1: set(bdv.PAYLOAD_TYPES)}
ALLOWED[3] = ALLOWED[1] | {0x000C, 0x000E}
ALLOWED[4] = ALLOWED[3] | {0x000F}


def entry(version, election_id, index, segment, payload):
    if version == 1:
        return bdv.entry(election_id, index, segment, payload)
    assert int.from_bytes(payload[:2], "big") in ALLOWED[version]
    return bdv.entry(election_id, index, segment, payload)[:2] + bytes([version]) + bdv.entry(election_id, index, segment, payload)[3:]


def decode_entry(b, pinned):
    """The envelope under the pinned version: board-vectors.py's strict decoder, with the version's own allowed set."""
    if len(b) < 3 or b[2] != pinned:
        return "version"
    d = bdv.decode_entry(b[:2] + b"\x01" + b[3:])
    if isinstance(d, str) and d != "unexpected-record-type":
        return d
    t = int.from_bytes(b[51:53], "big")
    if t not in ALLOWED[pinned]:
        return "unexpected-record-type"
    return d


def combination(defn):
    """2.3's profile-combination (docs/spec/verifier.md, 2.3), from the spec's text."""
    pins = dict(defn["profile"]["pins"])
    board, ballot, opening = pins[BOARD_ENTRY_TYPE], pins.get(BALLOT_TYPE), pins.get(TALLY_OPENING_TYPE)
    fits = (ballot != 1 or board in (3, 4)) and (opening != 1 or board == 4)
    return NOT_IMPLEMENTED if fits else outcome("fail", "profile-combination", {})


def transcript(label, panel, seats, election, cheat=None):
    r = cv.run(label, panel, seats, cheat, election)
    return cv.enc_transcript(r["runId"], r["rounds"])


def outcome(status, code=None, at=None):
    o = {"status": status}
    if code is not None:
        o["code"] = code
    if at is not None:
        o["at"] = at
    return o


NOT_REACHED = outcome("unverifiable", "not-reached")
NOT_IMPLEMENTED = outcome("unverifiable", "not-implemented")


def expected(panel, defn, entries, bundle_panel, board_version=1):
    """The rows a verifier reports (docs/spec/verifier.md, Key ceremony), computed here independently."""
    if cv.panel_id(bundle_panel["k"], bundle_panel["keys"]) != defn["panel_id"] or (
        bundle_panel["k"],
        len(bundle_panel["keys"]),
    ) != (defn["threshold"], defn["panel_size"]):
        return {"2.5": outcome("fail", "panel-unpinned", {}), "3.1": NOT_REACHED, "3.2": NOT_REACHED}, None
    rows = {"2.5": NOT_IMPLEMENTED}
    if dict(defn["profile"]["pins"]).get(cv.TRANSCRIPT_TYPE) != 1:
        unsupported = outcome("unverifiable", "unsupported-version", {})
        return dict(rows, **{"3.1": unsupported, "3.2": unsupported}), None
    found = None
    for at, e in enumerate(entries):
        d = decode_entry(e, board_version)
        if isinstance(d, str) or d["electionId"] != defn["election_id"]:
            continue
        payload = d["payload"]
        if H(ds(TRANSCRIPT_TAG, payload)) == defn["ceremony_transcript_hash"]:
            found = (at, payload)
            break
    if found is None:
        return dict(rows, **{"3.1": outcome("unverifiable", "ceremony-transcript-missing", {}), "3.2": NOT_REACHED}), None
    at, payload = found
    result = cv.check(panel, payload, election_of(defn))
    if not result["ok"] and "seats" not in result:
        where = {"entry": at}
        if result["code"] not in ("ceremony-order", "ceremony-shape", "ceremony-signature"):
            where["decodeError"] = result["code"]
            return dict(rows, **{"3.1": outcome("fail", "decode", where), "3.2": NOT_REACHED}), None
        return dict(rows, **{"3.1": outcome("fail", result["code"], where), "3.2": NOT_REACHED}), None
    ceremony = {
        "entry": at,
        "seats": result["seats"],
        "registered": [{"index": s["index"], "signingKey": s["signingKey"]} for s in result.get("registered", [])],
    }
    if not result["ok"]:
        return dict(rows, **{"3.1": NOT_IMPLEMENTED, "3.2": outcome("fail", "ceremony-quorum", {"entry": at})}), ceremony
    # ADR 0006 rule 7 (owner, 2026-10-12): an election opens only if at least n − 1 seats took part.
    n = len(panel["keys"])
    if len(result["registered"]) < max(panel["k"], n - 1):
        return dict(rows, **{"3.1": NOT_IMPLEMENTED, "3.2": outcome("fail", "ceremony-participation", {"entry": at})}), ceremony
    return dict(rows, **{"3.1": NOT_IMPLEMENTED, "3.2": outcome("pass")}), ceremony


def main(out):
    panels = {
        "panel-4": cv.make_panel("panel-4", 3, 4),
        "panel-4-k2": cv.make_panel("panel-4-k2", 2, 4),
        "panel-7": cv.make_panel("panel-7", 4, 7),
    }
    panel = panels["panel-4"]
    seats = [1, 2, 3, 4]
    # Every definition here is TYPICAL for panel-4 with its own transcript
    # hash, so they all share one stub, and one stub hash.
    election = election_of(definition_for(panel, bytes(32)))
    other_election = election_of(definition_for(panel, bytes(32), option_count=4))
    eid = dv.TYPICAL["election_id"]
    # A transcript for this stub from an abandoned run: valid, but not the one
    # the definitions name, so the verifier must pick by hash.
    stray = transcript("verifier/abandoned", panel, seats, election)
    cases = []

    def add(id_, desc, t, payloads, bundle_panel="panel-4", entry_election=eid, named="panel-4", board_version=None, entry_version=None, **changes):
        named = panels[named]
        if board_version is not None:
            pins = [(ty, board_version if ty == BOARD_ENTRY_TYPE else v) for ty, v in dv.TYPICAL["profile"]["pins"]]
            changes = dict(changes, profile={"protocol_major": 1, "pins": pins})
        pinned = 1 if board_version is None else board_version
        written = pinned if entry_version is None else entry_version
        defn = definition_for(named, H(ds(TRANSCRIPT_TAG, t)), **changes)
        entries = [entry(written, entry_election if p is t else eid, i, 0, p) for i, p in enumerate(payloads)]
        rows, ceremony = expected(named, defn, entries, panels[bundle_panel], pinned)
        # Cases from P1-19 part 4b on also give 2.3's combination row.
        if board_version is not None:
            rows = dict(rows, **{"2.3": combination(defn)})
        case = {
            "id": id_,
            "description": desc,
            "panel": bundle_panel,
            "definition": dv.enc_definition(defn).hex(),
            "board": b"".join(entries).hex(),
            "expected": rows,
        }
        if ceremony is not None:
            case["ceremony"] = ceremony
        cases.append(case)
        return rows

    honest = transcript("verifier/honest", panel, seats, election)
    assert add("honest", "Every seat qualifies; the board carries an abandoned run's transcript first, which the verifier passes over by hash.", honest, [stray, honest])["3.2"] == outcome("pass")

    absent = transcript("verifier/absent", panel, [1, 2, 3], election)
    add("absent", "Seat 4 sends nothing; three qualified seats meet k = 3.", absent, [absent])

    def two_bad(i, answers, *_):
        return [bytes(32)] * len(answers) if i in (3, 4) else answers

    quorum = transcript("verifier/quorum", panel, seats, election, {"answers": two_bad})
    assert add("quorum", "Seats 3 and 4 answer wrongly: two qualified seats are below k = 3.", quorum, [quorum])["3.2"]["code"] == "ceremony-quorum"

    other = transcript("verifier/other-stub", panel, seats, other_election)
    assert add("other-stub", "The definition names a transcript made for another definition's stub (four options): every signature fails under this definition's context (T-37).", other, [other])["3.1"]["code"] == "ceremony-signature"

    def swap_round1(rounds, ctx, d):
        r1 = rounds[0]
        return [[r1[1], r1[0], *r1[2:]], *rounds[1:]]

    order = transcript("verifier/order", panel, seats, election, {"rounds": swap_round1})
    assert add("order", "Round 1 lists seat 2 before seat 1.", order, [order])["3.1"]["code"] == "ceremony-order"

    trailing = honest + b"\x00"
    assert add("decode", "The transcript the definition names has a trailing byte.", trailing, [trailing])["3.1"] == outcome("fail", "decode", {"entry": 0, "decodeError": "trailing-bytes"})

    # A ballot's header (0x0002, reserved: no layout yet, so every decoder
    # reports it unknown) and a byte: allowed on the board, but not a transcript.
    opening = bytes([0x00, 0x02, 0x01, 0x00])
    assert add("not-a-transcript", "The definition binds a boarded payload of another record type: it fails decoding as a transcript, not missing.", opening, [opening])["3.1"] == outcome("fail", "decode", {"entry": 0, "decodeError": "unknown-record-type"})

    assert add("missing", "The board carries only the abandoned run's transcript.", honest, [stray])["3.1"]["code"] == "ceremony-transcript-missing"

    assert add("other-board", "The transcript is boarded only in an entry of another election.", honest, [honest], entry_election=bytes(32))["3.1"]["code"] == "ceremony-transcript-missing"

    assert add("panel-unpinned", "The bundle pins a 2-of-4 panel; the definition names the 3-of-4 one.", honest, [honest], bundle_panel="panel-4-k2")["2.5"]["code"] == "panel-unpinned"

    pins = [(t, 2 if t == cv.TRANSCRIPT_TYPE else 1) for t, _ in dv.ALL_PINS]
    assert add(
        "transcript-version-2",
        "The profile pins transcript version 2, which this verifier can't read.",
        honest,
        [honest],
        profile={"protocol_major": 1, "pins": pins},
    )["3.1"]["code"] == "unsupported-version"

    # ADR 0006 rule 7: a 4-of-7 panel opens only with at least n − 1 = 6 qualified seats.
    panel7 = panels["panel-7"]
    election7 = election_of(definition_for(panel7, bytes(32)))
    six = transcript("verifier/panel-7-six", panel7, [1, 2, 3, 4, 5, 6], election7)
    assert add("participation-six", "A 4-of-7 panel where seat 7 sends nothing: six qualified seats meet n − 1 (ADR 0006, rule 7).", six, [six], bundle_panel="panel-7", named="panel-7")["3.2"] == outcome("pass")
    five = transcript("verifier/panel-7-five", panel7, [1, 2, 3, 4, 5], election7)
    assert add("participation-five", "A 4-of-7 panel where seats 6 and 7 send nothing: five qualified seats meet k = 4 but not n − 1 = 6.", five, [five], bundle_panel="panel-7", named="panel-7")["3.2"]["code"] == "ceremony-participation"
    def six_seven_bad(i, answers, *_):
        return [bytes(32)] * len(answers) if i in (6, 7) else answers

    disqualified = transcript("verifier/panel-7-disqualified", panel7, [1, 2, 3, 4, 5, 6, 7], election7, {"answers": six_seven_bad})
    assert add("participation-disqualified", "A 4-of-7 panel where all seven seats send every round but seats 6 and 7 answer wrongly: five qualified seats, below n − 1, though seven took part in the messages.", disqualified, [disqualified], bundle_panel="panel-7", named="panel-7")["3.2"]["code"] == "ceremony-participation"
    four = transcript("verifier/panel-7-four", panel7, [1, 2, 3, 4], election7)
    assert add("participation-four", "A 4-of-7 panel where only seats 1 to 4 take part: exactly k, two short of n − 1.", four, [four], bundle_panel="panel-7", named="panel-7")["3.2"]["code"] == "ceremony-participation"

    # Board-entry versions 3 and 4 (P1-19 part 4b): the transcript is found
    # under the pinned version, and 2.3 reports whether the pins fit. The
    # profile is part of the stub, so each version has its own transcripts.
    def for_board(version):
        pins = [(ty, version if ty == BOARD_ENTRY_TYPE else v) for ty, v in dv.TYPICAL["profile"]["pins"]]
        e = election_of(definition_for(panel, bytes(32), profile={"protocol_major": 1, "pins": pins}))
        return transcript(f"verifier/board-v{version}", panel, seats, e), transcript(f"verifier/board-v{version}-abandoned", panel, seats, e)

    v4, v4_stray = for_board(4)
    assert add("board-v4", "The profile pins board-entry version 4, which carries destruction statements: the pins fit, and the transcript is found in a version-4 entry after an abandoned run's.", v4, [v4_stray, v4], board_version=4)["3.2"] == outcome("pass")
    v3, _ = for_board(3)
    r = add("board-v3", "The profile pins board-entry version 3 beside tally-opening version 1: 2.3 fails profile-combination, and the transcript check still runs under version 3.", v3, [v3], board_version=3)
    assert r["2.3"]["code"] == "profile-combination" and r["3.2"] == outcome("pass")
    r = add("board-v1-pinned", "The profile pins board-entry version 1 beside ballot version 1: 2.3 fails profile-combination; the transcript check still runs.", honest, [honest], board_version=1)
    assert r["2.3"]["code"] == "profile-combination" and r["3.2"] == outcome("pass")
    assert add("board-v4-entry-v1", "The profile pins board-entry version 4, but the transcript was boarded in a version-1 entry, which doesn't decode under the pinned version: missing.", v4, [v4], board_version=4, entry_version=1)["3.1"]["code"] == "ceremony-transcript-missing"

    doc = {
        "format": "abolish-verifier-ceremony-vectors/1",
        "title": "The verifier's key-ceremony checks: definitions, boards and pinned panels, with the rows 2.5, 3.1 and 3.2",
        "spec": "docs/spec/verifier.md",
        "generator": "packages/crypto/scripts/verifier-ceremony-vectors.py, from ceremony-vectors.py, definition-vectors.py and board-vectors.py (independent Python implementations)",
        "panels": {
            name: {"threshold": str(p["k"]), "keys": [k.hex() for k in p["keys"]]} for name, p in panels.items()
        },
        "cases": cases,
    }
    path = pathlib.Path(out, "verifier-ceremony.json")
    path.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    main(sys.argv[1])
