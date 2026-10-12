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


def board(election_id, payloads):
    return b"".join(bdv.entry(election_id, i, 0, p) for i, p in enumerate(payloads))


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


def expected(panel, defn, entries, bundle_panel):
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
        d = bdv.decode_entry(e)
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

    def add(id_, desc, t, payloads, bundle_panel="panel-4", entry_election=eid, named="panel-4", **changes):
        named = panels[named]
        defn = definition_for(named, H(ds(TRANSCRIPT_TAG, t)), **changes)
        entries = [bdv.entry(entry_election if p is t else eid, i, 0, p) for i, p in enumerate(payloads)]
        rows, ceremony = expected(named, defn, entries, panels[bundle_panel])
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
    four = transcript("verifier/panel-7-four", panel7, [1, 2, 3, 4], election7)
    assert add("participation-four", "A 4-of-7 panel where only seats 1 to 4 take part: exactly k, two short of n − 1.", four, [four], bundle_panel="panel-7", named="panel-7")["3.2"]["code"] == "ceremony-participation"

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
