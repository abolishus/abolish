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
rounds, the transcript and its check), definition-vectors.py,
regional-cells-vectors.py and definition-v4-vectors.py (the definition
encodings of versions 1, 3 and 4 and their rules) and board-vectors.py (the
board-entry envelope).

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
rc = _load("regional_cells_vectors", "regional-cells-vectors.py")
d4 = _load("definition_v4_vectors", "definition-v4-vectors.py")
d5 = _load("definition_v5_vectors", "definition-v5-vectors.py")

H, ds = cv.H, cv.ds
TRANSCRIPT_TAG = b"abolish/v1/ceremony-transcript"
STUB_TAG = b"abolish/v1/election-stub"


# Each definition version's encoding and rules, by the version its own
# profile pins for 0x0001 (election-definition.md, Decoding).
ENCODE = {1: dv.enc_definition, 3: rc.enc_definition_v3, 4: d4.enc_definition_v4, 5: d5.enc_definition_v5}
RULE = {1: dv.definition_rule, 3: rc.definition_rule, 4: d4.definition_rule, 5: d5.definition_rule}


def own_version(d):
    return dict(d["profile"]["pins"])[0x0001]


def encode(d):
    return ENCODE[own_version(d)](d)


def stub_hash(d):
    """The stub hash under the definition's own version: the stub is the whole definition with the transcript hash zeroed."""
    return H(ds(STUB_TAG, encode(dict(d, ceremony_transcript_hash=bytes(32)))))


def election_of(d):
    """The ceremony context's election fields, every one taken from the definition."""
    return {
        "l2ChainId": d["l2_chain_id"],
        "trusteeRegistry": d["trustee_registry"],
        "electionId": d["election_id"],
        "stubHash": stub_hash(d),
    }


def definition_for(panel, transcript_hash, base=dv.TYPICAL, **changes):
    d = dict(
        base,
        panel_id=cv.panel_id(panel["k"], panel["keys"]),
        threshold=panel["k"],
        panel_size=len(panel["keys"]),
        ceremony_transcript_hash=transcript_hash,
        **changes,
    )
    assert RULE[own_version(d)](d) is None, RULE[own_version(d)](d)
    return d


BOARD_ENTRY_TYPE = 0x0007
BALLOT_TYPE = 0x0002
SPOILED_OPENING_TYPE = 0x0003
TALLY_OPENING_TYPE = 0x0006
CONTRACT_EVENT_TYPE = 0x0008
# docs/spec/board.md, Allowed payloads: version 3 adds share receipts (0x000c)
# and complaints (0x000e) to version 1's set; version 4 adds the destruction
# statement (0x000f); version 5 the close statement (0x0015). Every version
# has the same layout.
ALLOWED = {1: set(bdv.PAYLOAD_TYPES)}
ALLOWED[3] = ALLOWED[1] | {0x000C, 0x000E}
ALLOWED[4] = ALLOWED[3] | {0x000F}
ALLOWED[5] = ALLOWED[4] | {0x0015}


def entry(version, election_id, index, segment, payload):
    if version == 1:
        return bdv.entry(election_id, index, segment, payload)
    assert int.from_bytes(payload[:2], "big") in ALLOWED[version]
    return bdv.entry(election_id, index, segment, payload)[:2] + bytes([version]) + bdv.entry(election_id, index, segment, payload)[3:]


def decode_entry(b, pinned):
    """Strict decoding of a board entry under the pinned version (docs/spec/notation.md, board.md), with that version's allowed set."""
    if len(b) < 2:
        return "truncated"
    if int.from_bytes(b[0:2], "big") != BOARD_ENTRY_TYPE:
        return "unknown-record-type"
    if len(b) < 3:
        return "truncated"
    if b[2] != pinned:
        return "version"
    if len(b) < 51:
        return "truncated"
    n = int.from_bytes(b[47:51], "big")
    if n > bdv.MAX_BOARD_PAYLOAD:
        return "length-over-max"
    if len(b) < 51 + n:
        return "truncated"
    payload = b[51 : 51 + n]
    if n < 3:
        return "truncated"
    if int.from_bytes(payload[0:2], "big") not in ALLOWED[pinned]:
        return "unexpected-record-type"
    if len(b) != 51 + n:
        return "trailing-bytes"
    return {
        "electionId": b[3:35],
        "index": int.from_bytes(b[35:43], "big"),
        "segment": int.from_bytes(b[43:47], "big"),
        "payload": payload,
    }


def combination(defn):
    """2.3's profile-combination (docs/spec/verifier.md, 2.3), from the spec's text."""
    pins = dict(defn["profile"]["pins"])
    board, ballot, opening = pins[BOARD_ENTRY_TYPE], pins.get(BALLOT_TYPE), pins.get(TALLY_OPENING_TYPE)
    spoiled = pins.get(SPOILED_OPENING_TYPE)
    failed = outcome("fail", "profile-combination", {})
    unsupported = outcome("unverifiable", "unsupported-version", {})
    # A board-entry version this verifier can't read is a later release's,
    # before any combination (verifier.md, Definition, step 2).
    if board not in ALLOWED:
        return unsupported
    definition = pins[0x0001]
    # Every profile pins board-entry version 5, the one that allows the close
    # statement, and contract-event version 8 to 13, whose tables name every
    # board event, the close rule's, the batches', the obligation root's and
    # the availability records', and the group registry's Tier 1 and
    # self-paid additions; versions 1 to 7 don't, and a later one may
    # (close.md, Version; contracts.md, Event tables (versions 8 to 13)).
    # Judged with the other
    # failures; an unknown contract-event version is unsupported only once
    # nothing fails.
    events = pins.get(CONTRACT_EVENT_TYPE)
    if board != 5 or events in (1, 2, 3, 4, 5, 6, 7, None):
        return failed
    # Definition versions 1, 3 and 4 pin display-text version 1, version 5
    # display-text version 2; an unknown one fails.
    if pins.get(0x0009) != (2 if definition == 5 else 1):
        return failed
    # Each definition version pins one ballot version, and only it: 2 under
    # 3 and 4 (regional cells), 3 under 5 (questions), 1 under 1; ballot
    # version 4 (an author half) only under definition version 6, and 5 (a
    # step) only under a rolling version 7, which this model never sees. Any
    # other ballot version may be a later release's, which might name its
    # cell or carry questions (T-36).
    wanted = {3: 2, 4: 2, 5: 3}.get(definition, 1)
    known = ballot in (1, 2, 3, 4, 5)
    if known and ballot != wanted:
        return failed
    # Ballot versions 1 to 3 need the opening version that opens their
    # cores: 1 for version 1, 2 for versions 2 and 3 (challenge.md, Versions).
    if known and spoiled is None:
        return failed
    if ballot == 1 and spoiled != 1:
        return failed
    if not ((not known or board in (3, 4, 5)) and (opening != 1 or board in (4, 5))):
        return failed
    if not known and wanted != 1:
        return unsupported
    if ballot in (2, 3) and spoiled != 2:
        # Opening version 1 opens version 1's cores only; version 2 opens
        # theirs, and any other is one a later release may read.
        return failed if spoiled == 1 else unsupported
    if events not in (8, 9, 10, 11, 12, 13):
        return unsupported
    return NOT_IMPLEMENTED


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


def self_check():
    eid = bytes(32)
    for t in sorted(ALLOWED[5] | {0x0004, 0x000D}):
        p = t.to_bytes(2, "big") + b"\x01\x00"
        for v in (1, 3, 4, 5):
            ok = t in ALLOWED[v]
            raw = bdv.entry(eid, 0, 0, p)
            e = raw[:2] + bytes([v]) + raw[3:]
            d = decode_entry(e, v)
            assert isinstance(d, dict) == ok and (ok or d == "unexpected-record-type"), (t, v, d)
            assert decode_entry(e + b"\x00", v) == ("trailing-bytes" if ok else "unexpected-record-type")
            if v == 1:
                assert bdv.decode_entry(e) == d, (t, d)


def main(out):
    self_check()
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

    def add(id_, desc, t, payloads, bundle_panel="panel-4", entry_election=eid, named="panel-4", board_version=None, entry_version=None, base=dv.TYPICAL, events=None, **changes):
        named = panels[named]
        if board_version is not None:
            pin = {BOARD_ENTRY_TYPE: board_version, **({CONTRACT_EVENT_TYPE: events} if events is not None else {})}
            pins = [(ty, pin.get(ty, v)) for ty, v in base["profile"]["pins"]]
            changes = dict(changes, profile={"protocol_major": 1, "pins": pins})
        pinned = 1 if board_version is None else board_version
        written = pinned if entry_version is None else entry_version
        defn = definition_for(named, H(ds(TRANSCRIPT_TAG, t)), base, **changes)
        entries = [entry(written, entry_election if p is t else eid, i, 0, p) for i, p in enumerate(payloads)]
        rows, ceremony = expected(named, defn, entries, panels[bundle_panel], pinned)
        # Cases from P1-19 part 4b on also give 2.3's combination row.
        if board_version is not None:
            rows = dict(rows, **{"2.3": combination(defn)})
        case = {
            "id": id_,
            "description": desc,
            "panel": bundle_panel,
            "definition": encode(defn).hex(),
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
    def for_board(version, events=None, label=None):
        pin = {BOARD_ENTRY_TYPE: version, **({CONTRACT_EVENT_TYPE: events} if events is not None else {})}
        pins = [(ty, pin.get(ty, v)) for ty, v in dv.TYPICAL["profile"]["pins"]]
        e = election_of(definition_for(panel, bytes(32), profile={"protocol_major": 1, "pins": pins}))
        label = label or f"verifier/board-v{version}"
        return transcript(label, panel, seats, e), transcript(f"{label}-abandoned", panel, seats, e)

    v4, v4_stray = for_board(4)
    r = add("board-v4", "The profile pins board-entry version 4, which carries destruction statements but not the close statement: 2.3 fails profile-combination (close.md, Version), and the transcript is found in a version-4 entry after an abandoned run's.", v4, [v4_stray, v4], board_version=4)
    assert r["2.3"]["code"] == "profile-combination" and r["3.2"] == outcome("pass")
    v3, _ = for_board(3)
    r = add("board-v3", "The profile pins board-entry version 3 beside tally-opening version 1: 2.3 fails profile-combination, and the transcript check still runs under version 3.", v3, [v3], board_version=3)
    assert r["2.3"]["code"] == "profile-combination" and r["3.2"] == outcome("pass")
    r = add("board-v1-pinned", "The profile pins board-entry version 1 beside ballot version 1: 2.3 fails profile-combination; the transcript check still runs.", honest, [honest], board_version=1)
    assert r["2.3"]["code"] == "profile-combination" and r["3.2"] == outcome("pass")
    # Board-entry version 5 and contract-event version 8 (P1-19 part 4p,
    # P1-12d, P1-12f, P3-3, P3-2, P4-3): the close statement and every board
    # and registry event, which every profile needs; contract-event versions
    # 1 and 2 name none of the close rule's events, version 3 not the
    # batches', version 4 not the obligation root's, version 5 not the Tier 1
    # addition, version 6 not the self-paid addition and version 7 not the
    # availability records, and one this verifier doesn't read may be a later
    # release's.
    v5, v5_stray = for_board(5, 8)
    r = add("board-v5", "The profile pins board-entry version 5, which carries the close statement, and contract-event version 8, which archives every board and registry event: the pins fit, and the transcript is found in a version-5 entry after an abandoned run's.", v5, [v5_stray, v5], board_version=5, events=8)
    assert r["2.3"] == NOT_IMPLEMENTED and r["3.2"] == outcome("pass"), r
    for ev in (1, 2, 3, 4, 5, 6, 7):
        t_ev, _ = for_board(5, ev, f"verifier/board-v5-events-v{ev}")
        r = add(f"board-v5-events-v{ev}", f"The profile pins board-entry version 5 beside contract-event version {ev}, whose tables don't name every board and registry event: 2.3 fails profile-combination; the transcript check still runs.", t_ev, [t_ev], board_version=5, events=ev)
        assert r["2.3"]["code"] == "profile-combination" and r["3.2"] == outcome("pass"), r
    t_ev, _ = for_board(5, 9, "verifier/board-v5-events-v9")
    r = add("board-v5-events-v9", "The profile pins board-entry version 5 beside contract-event version 9, which reads every record version 8 passes as version 8 does: the pins fit, and the transcript check runs.", t_ev, [t_ev], board_version=5, events=9)
    assert r["2.3"] == NOT_IMPLEMENTED and r["3.2"] == outcome("pass"), r
    for ev, before in ((10, 9), (11, 10)):
        t_ev, _ = for_board(5, ev, f"verifier/board-v5-events-v{ev}")
        r = add(f"board-v5-events-v{ev}", f"The profile pins board-entry version 5 beside contract-event version {ev}, which reads every record version {before} passes as version {before} does: the pins fit, and the transcript check runs.", t_ev, [t_ev], board_version=5, events=ev)
        assert r["2.3"] == NOT_IMPLEMENTED and r["3.2"] == outcome("pass"), r
    t_ev, _ = for_board(5, 12, "verifier/board-v5-events-v12")
    r = add("board-v5-events-v12", "The profile pins board-entry version 5 beside contract-event version 12, which reads every record version 11 passes as version 11 does but version 1's `PanelPinned`, which it replaces with the one that logs each panel's kind: the pins fit, and the transcript check runs.", t_ev, [t_ev], board_version=5, events=12)
    assert r["2.3"] == NOT_IMPLEMENTED and r["3.2"] == outcome("pass"), r
    t_ev, _ = for_board(5, 13, "verifier/board-v5-events-v13")
    r = add("board-v5-events-v13", "The profile pins board-entry version 5 beside contract-event version 13, which reads every record version 12 passes as version 12 does, and a version-7 definition's registration besides: the pins fit, and the transcript check runs.", t_ev, [t_ev], board_version=5, events=13)
    assert r["2.3"] == NOT_IMPLEMENTED and r["3.2"] == outcome("pass"), r
    t_ev, _ = for_board(5, 14, "verifier/board-v5-events-v14")
    r = add("board-v5-events-v14", "The profile pins board-entry version 5 beside contract-event version 14, which this verifier doesn't read: 2.3 is unverifiable (unsupported-version), since a later release may read it; the transcript check still runs.", t_ev, [t_ev], board_version=5, events=14)
    assert r["2.3"] == outcome("unverifiable", "unsupported-version", {}) and r["3.2"] == outcome("pass"), r
    t_ev, _ = for_board(4, 8, "verifier/board-v4-events-v8")
    r = add("board-v4-events-v8", "The profile pins contract-event version 8 beside board-entry version 4, which doesn't allow the close statement: 2.3 fails profile-combination.", t_ev, [t_ev], board_version=4, events=8)
    assert r["2.3"]["code"] == "profile-combination" and r["3.2"] == outcome("pass"), r
    assert add("board-v4-entry-v1", "The profile pins board-entry version 4, but the transcript was boarded in a version-1 entry, which doesn't decode under the pinned version: missing.", v4, [v4], board_version=4, entry_version=1)["3.1"]["code"] == "ceremony-transcript-missing"

    # Definition versions 3 and 4 (P1-15 part 4b-2b): the transcript binds the
    # stub under the definition's own version, so a transcript made for
    # another version's stub of the same election fails its signatures. Their
    # typical profiles pin ballot version 2 beside spoiled-ballot opening
    # version 1, which can't challenge it, so 2.3 fails, and the ceremony
    # checks still run.
    def regional(base, label):
        pins = [(ty, {BOARD_ENTRY_TYPE: 4, BALLOT_TYPE: 2}.get(ty, v)) for ty, v in base["profile"]["pins"]]
        b = dict(base, profile={"protocol_major": 1, "pins": pins})
        return b, transcript(label, panel, seats, election_of(definition_for(panel, bytes(32), b)))

    v3_base, v3_t = regional(rc.TYPICAL, "verifier/definition-v3")
    r = add("definition-v3", "A version-3 definition (regional cells) whose transcript binds its version-3 stub: every seat qualifies; 2.3 fails, since its opening version 1 can't challenge ballot version 2.", v3_t, [v3_t], board_version=4, base=v3_base)
    assert r["3.2"] == outcome("pass") and r["2.3"]["code"] == "profile-combination", r
    r = add("definition-v3-v1-stub", "A version-3 definition naming a transcript made for a version-1 stub of the same election, chain and panel: every signature fails (T-37).", v4, [v4], board_version=4, base=v3_base)
    assert r["3.1"]["code"] == "ceremony-signature", r
    v4_base, v4_t = regional(d4.TYPICAL, "verifier/definition-v4")
    r = add("definition-v4", "A version-4 definition (receipt keys) whose transcript binds its version-4 stub: every seat qualifies.", v4_t, [v4_t], board_version=4, base=v4_base)
    assert r["3.2"] == outcome("pass"), r
    r = add("definition-v4-v3-stub", "A version-4 definition naming a transcript made for the version-3 stub without its receipt keys: every signature fails, since the stub binds the keys (T-26, T-37).", v3_t, [v3_t], board_version=4, base=v4_base)
    assert r["3.1"]["code"] == "ceremony-signature", r
    opening2 = [(ty, 2 if ty == SPOILED_OPENING_TYPE else v) for ty, v in v3_base["profile"]["pins"]]
    v3_o2_base = dict(v3_base, profile={"protocol_major": 1, "pins": opening2})
    _, v3_o2_t = regional(v3_o2_base, "verifier/definition-v3-opening-2")
    r = add("definition-v3-opening-2", "A version-3 definition pinning spoiled-ballot opening version 2, which opens version-2 cores, beside board-entry version 4: the ballot and opening pins fit, but 2.3 fails profile-combination for want of the close statement (close.md, Version); every seat qualifies.", v3_o2_t, [v3_o2_t], board_version=4, base=v3_o2_base)
    assert r["2.3"]["code"] == "profile-combination" and r["3.2"] == outcome("pass"), r
    closing = [(ty, {BOARD_ENTRY_TYPE: 5, CONTRACT_EVENT_TYPE: 8}.get(ty, v)) for ty, v in v3_o2_base["profile"]["pins"]]
    v3_c_base = dict(v3_o2_base, profile={"protocol_major": 1, "pins": closing})
    # Not through regional(), which pins board-entry version 4.
    v3_c_t = transcript("verifier/definition-v3-board-v5", panel, seats, election_of(definition_for(panel, bytes(32), v3_c_base)))
    r = add("definition-v3-board-v5", "A version-3 definition pinning spoiled-ballot opening version 2, board-entry version 5 and contract-event version 8: 2.3's combination passes, and every seat qualifies.", v3_c_t, [v3_c_t], board_version=5, events=8, base=v3_c_base)
    assert r["2.3"] == NOT_IMPLEMENTED and r["3.2"] == outcome("pass"), r

    doc = {
        "format": "abolish-verifier-ceremony-vectors/1",
        "title": "The verifier's key-ceremony checks: definitions, boards and pinned panels, with the rows 2.5, 3.1 and 3.2",
        "spec": "docs/spec/verifier.md",
        "generator": "packages/crypto/scripts/verifier-ceremony-vectors.py, from ceremony-vectors.py, definition-vectors.py, regional-cells-vectors.py, definition-v4-vectors.py and board-vectors.py (independent Python implementations)",
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
