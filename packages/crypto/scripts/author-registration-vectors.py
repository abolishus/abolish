#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/author-registration.json.

The author panel's approvals counted from the election registry's
`AuthorPanelRegistered` (docs/spec/ceremony.md, Author panel, The
registration's approvals; docs/spec/verifier.md, Key ceremony, step 5;
P2-16 part 5d-3a): registrations in the trustee registry's record layout
(docs/spec/contracts.md, Author panel registration), each logged as a
contract-event record under version 9 (Event tables (version 9)), and cases
that decide 3.1's author part from author approvals records and
registrations together, as the spec's check does (T-37, T-14, T-17).

It reads author-ceremony.json's election, transcripts and approvals records,
remakes the author panels from their labels (author-ceremony-vectors.py),
and frames each event with contract-event-v9-vectors.py's encoder and event
check. The registration's decoding and the check below are written from the
spec with the standard library; nothing here shares code with packages/crypto
or packages/verifier. ECDSA nonces are RFC 6979's and every other value comes
from fixed labels: test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/author-registration-vectors.py <repo-root>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import hashlib
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


cev9 = _load("contract_event_v9_vectors", "contract-event-v9-vectors.py")
ac = cev9.ac
ks, tv = ac.ks, ac.ecdsa
word, abi_bytes, sig_topic = cev9.word, cev9.abi_bytes, cev9.sig_topic

MAX_TRUSTEES = 16
ELECTION = ac.ELECTION


def det(label, n=32):
    return hashlib.sha256(b"abolish author registration vectors " + label.encode()).digest()[:n]


# --- The registration (contracts.md, Trustee registry, Registration) ---------------


def seat_bytes(index, kem_key_hash, signing_key):
    x, y = tv.decompress(signing_key)
    return bytes([index]) + kem_key_hash + x.to_bytes(32, "big") + y.to_bytes(32, "big")


def enc_registration(panel_id, stub_hash, transcript_hash, seats, approvals):
    """`panel_id ‖ stub_hash ‖ ceremony_transcript_hash ‖ u8(seats) ‖ seat × seats ‖ u8(count) ‖ approval × count`."""
    return (panel_id + stub_hash + transcript_hash + bytes([len(seats)]) + b"".join(seats)
            + bytes([len(approvals)]) + b"".join(bytes([i]) + sig for i, sig in approvals))


def decode_registration(b):
    """Strict decoding as the trustee registry's record: its layout and the forms of checks 7 to 9 (at least
    one seat, seats and approvals strictly increasing from 1, each key a point of P-256 with x, y < p, each
    signature with 1 <= r < n and 1 <= s <= (n - 1) / 2). None when it doesn't decode."""
    if len(b) < 97:
        return None
    seats_n, at, seats, prev = b[96], 97, [], 0
    if seats_n == 0 or seats_n > MAX_TRUSTEES:
        return None
    for _ in range(seats_n):
        if len(b) < at + 97:
            return None
        index, kem, x, y = b[at], b[at + 1 : at + 33], int.from_bytes(b[at + 33 : at + 65], "big"), int.from_bytes(b[at + 65 : at + 97], "big")
        if index <= prev or x >= tv.P or y >= tv.P or not tv.on_curve((x, y)):
            return None
        seats.append((index, kem, tv.compress((x, y))))
        prev, at = index, at + 97
    if len(b) < at + 1:
        return None
    count, at, approvals, prev = b[at], at + 1, [], 0
    if count > MAX_TRUSTEES:
        return None
    for _ in range(count):
        if len(b) < at + 65:
            return None
        index, sig = b[at], b[at + 1 : at + 65]
        r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
        if index <= prev or not (1 <= r < tv.N and 1 <= s <= (tv.N - 1) // 2):
            return None
        approvals.append((index, sig))
        prev, at = index, at + 65
    if len(b) != at:
        return None
    return {"panelId": b[:32], "stubHash": b[32:64], "transcriptHash": b[64:96], "seats": seats, "approvals": approvals}


# --- Author panel, Check, with the registrations -----------------------------------


def check(panel, transcript, records, registrations):
    """The approvals records and registrations of this definition, decided as Author panel, Check, and The
    registration's approvals say: participation first, then any registration of this run (this run's header and
    q_A seats approving its own key set, as the registry requires) whose key set isn't the checker's, then the
    seats counted across both."""
    q = max(panel["k"], len(panel["keys"]) - 1)
    if len(transcript["registered"]) < q:
        return {"ok": False, "code": "ceremony-participation"}
    thash, ksh = transcript["hash"], transcript["keySetHash"]
    named = []
    for b in records:
        try:
            rec = ac.decode_record(b)
        except ac.DecodeFail:
            continue
        if rec["transcriptHash"] == thash:
            named.append(rec)
    for b in registrations:
        reg = decode_registration(b)
        # The registry's check 6 bounds the seats by n_A.
        if reg is None or reg["seats"][-1][0] > len(panel["keys"]):
            continue
        if (reg["panelId"], reg["stubHash"], reg["transcriptHash"]) != (ac.panel_id(panel), ELECTION["authorStubHash"], thash):
            continue
        own = ks.key_set_hash(reg["seats"])
        if len(ac.counting(panel, {"approvals": reg["approvals"]}, thash, own) or []) < q:
            continue
        if own != ksh:
            return {"ok": False, "code": "key-set-mismatch"}
        named.append({"transcriptHash": thash, "approvals": reg["approvals"]})
    counted = set()
    for rec in named:
        counted.update(ac.counting(panel, rec, thash, ksh) or [])
    seats = sorted(counted)
    if len(seats) >= q:
        return {"ok": True, "seats": seats}
    return {"ok": False, "code": "author-approvals" if named else "author-approvals-missing", "seats": seats}


def main(root):
    vec = root / "docs/spec/vectors"
    tv.self_check()
    ceremony = json.loads((vec / "author-ceremony.json").read_text())
    assert {k: v for k, v in ceremony["election"].items()} == {
        "l2ChainId": str(ELECTION["l2ChainId"]),
        "trusteeRegistry": ELECTION["trusteeRegistry"].hex(),
        "electionId": ELECTION["electionId"].hex(),
        "stubHash": ELECTION["stubHash"].hex(),
        "authorStubHash": ELECTION["authorStubHash"].hex(),
    }

    default = ac.cv.make_panel("author-vectors/default-4", 3, 4)
    panels = {
        "author-3": ac.author_panel("author-vectors/author-3", 2, 3, default),
        "author-4": ac.author_panel("author-vectors/author-4", 2, 4, default),
    }
    for name, p in panels.items():
        assert ac.panel_id(p).hex() == ceremony["panels"][name]["panelId"], name

    transcripts = {}
    for t in ceremony["transcripts"]:
        if t["id"] in ("author-honest-3", "author-short"):
            registered = t["result"]["registered"]
            entries = [(s["index"], ks.kem_key_hash(bytes.fromhex(s["kemKey"])), bytes.fromhex(s["signingKey"])) for s in registered]
            transcripts[t["id"]] = {
                "panel": panels[t["panel"]],
                "hash": bytes.fromhex(t["result"]["hash"]),
                "keySetHash": ks.key_set_hash(entries),
                "registered": registered,
                "entries": entries,
            }
    approvals_records = {r["id"]: bytes.fromhex(r["record"]) for r in ceremony["records"]}

    # The definition's L2 contracts: author-ceremony.json's trustee registry, the others made up.
    contracts = {
        "election-registry": det("election-registry", 20),
        "trustee-registry": ELECTION["trusteeRegistry"],
        "group-registry": det("group-registry", 20),
        "board": det("board", 20),
    }
    definition_hash = det("definition")
    topic0 = sig_topic(cev9.AUTHOR_PANEL)

    registrations, events = {}, {}

    def reg(id_, desc, tid, approving, entries=None, thash=None, stub=None, tag=None, signer=None, tamper=None):
        t = transcripts[tid]
        p = t["panel"]
        entries = t["entries"] if entries is None else entries
        thash = thash or t["hash"]
        ksh = ks.key_set_hash(entries)
        # `approving` lists seats, or (seat, signing seat) pairs signing that other seat's statement; `signer`
        # signs seat 2's statement with another seat's key.
        approvals = []
        for a in approving:
            index, sign_as = a if isinstance(a, tuple) else (a, a)
            approvals.append((index, ac.approve(p, sign_as, thash, ksh, stub_hash=stub, tag=tag, signer=signer if index == 2 else None)[1]))
        pid = ac.cv.panel_id(p["k"], p["keys"], tag or ac.AUTHOR_PANEL_TAG)
        b = enc_registration(pid, stub or ELECTION["authorStubHash"], thash, [seat_bytes(*e) for e in entries], approvals)
        if tamper is not None:
            b = tamper(b)
        registrations[id_] = {"id": id_, "description": desc, "transcript": tid, "registration": b.hex()}
        return b

    n = [0]

    def event(id_, desc, b, contract="election-registry", definition=definition_hash):
        """`AuthorPanelRegistered` as the election registry logs it, framed under contract-event version 9."""
        address = contracts[contract]
        topics, data = [topic0, definition, b[:32]], word(32) + abi_bytes(b)
        n[0] += 1
        rec = {"contract": address, "n": n[0], "block": 200 + n[0], "timestamp": 1_760_000_000 + 2 * n[0], "topics": topics, "data": data}
        enc = cev9.encode(address, rec["n"], rec["block"], rec["timestamp"], topics, data)
        assert cev9.decode(enc) == rec
        checked = cev9.event_check(rec, contracts, {})
        passes = not isinstance(checked, str) and checked["event"] == "AuthorPanelRegistered"
        # The verifier reads a registration only from an event that passes and names this definition.
        reads = passes and definition == definition_hash
        events[id_] = {"id": id_, "description": desc, "record": enc.hex(), "registration": b.hex(), "read": reads}
        return id_

    T = "author-honest-3"
    t3 = transcripts[T]
    e3 = t3["entries"]
    event("all", "Every author seat approves, as the election registry records the panel.",
          reg("all", "author-honest-3's key set, approved by all three seats.", T, [1, 2, 3]))
    event("quorum", "Seats 1 and 3, the quorum max(k_A, n_A - 1) = 2.",
          reg("quorum", "author-honest-3's key set, approved by seats 1 and 3.", T, [1, 3]))
    event("seat-1", "Seat 1 alone.", reg("seat-1", "author-honest-3's key set, approved by seat 1.", T, [1]))
    event("seat-2", "Seat 2 alone.", reg("seat-2", "author-honest-3's key set, approved by seat 2.", T, [2]))
    event("no-approvals", "The key set with no approval: it names the transcript and counts no one.",
          reg("no-approvals", "author-honest-3's key set with no approval.", T, []))
    event("other-key-set", "Every seat approves a key set of seats 1 and 2 only, which isn't the transcript's.",
          reg("other-key-set", "Seats 1 and 2 of author-honest-3's key set, approved by all three seats over that set.",
              T, [1, 2, 3], entries=e3[:2]))
    event("other-key-set-unsigned", "A key set of seats 1 and 2 only with no approval: no quorum signed it, so it "
          "carries nothing.", reg("other-key-set-unsigned", "Seats 1 and 2 of author-honest-3's key set with no approval.",
                                  T, [], entries=e3[:2]))
    event("other-key-set-short", "A key set of seats 1 and 2 only approved by seat 1 alone, short of q_A: it carries "
          "nothing.", reg("other-key-set-short", "Seats 1 and 2 of author-honest-3's key set, approved by seat 1 over "
                          "that set.", T, [1], entries=e3[:2]))
    event("other-signer-quorum", "Seats 1, 2 and 3, seat 2's slot carrying seat 3's signature: seats 1 and 3 still "
          "make the quorum.", reg("other-signer-quorum", "author-honest-3's key set, seat 2's approval signed by seat "
                                  "3's key.", T, [1, 2, 3], signer=3))
    other = det("other-transcript")
    event("seat-above-n", "A key set whose last seat is 4, above n_A = 3, every seat approving: no registration of "
          "this run (the registry's check 6), so it carries nothing.",
          reg("seat-above-n", "author-honest-3's key set with seat 3 renumbered 4, approved by all three seats over it.",
              T, [1, 2, 3], entries=e3[:2] + [(4,) + tuple(e3[2][1:])]))
    event("other-transcript", "Seats 1 and 2 approve another transcript hash: no registration of this run.",
          reg("other-transcript", "author-honest-3's key set under another transcript hash.", T, [1, 2], thash=other))
    event("default-stub", "Seats 1 and 2 approve over the default panel's stub: no registration of this run.",
          reg("default-stub", "author-honest-3's key set over the default stub hash.", T, [1, 2], stub=ELECTION["stubHash"]))
    event("default-panel-id", "Seats 1 and 2 under the panel's identifier with abolish/v1/panel: no registration of this run.",
          reg("default-panel-id", "author-honest-3's key set under the default-panel form of the identifier.", T, [1, 2],
              tag=ac.PANEL_TAG))
    event("other-signer", "Seat 2's slot carries seat 3's signature over seat 2's statement: only seat 1 counts.",
          reg("other-signer", "author-honest-3's key set, seat 1's approval and seat 2's signed by seat 3's key.", T, [1, 2],
              signer=3))
    event("seat-4", "Seats 1, 2 and 4 of a 3-seat panel: out of range, so the registration counts for no one.",
          reg("seat-4", "author-honest-3's key set with approvals at seats 1, 2 and 4 (seat 4 carrying seat 3's signature).",
              T, [1, 2, (4, 3)]))

    def off_curve(b):
        # Seat 1's y moved off the curve: the layout holds, the record doesn't decode.
        y_at = 97 + 65
        y = (int.from_bytes(b[y_at : y_at + 32], "big") + 1) % tv.P
        return b[:y_at] + y.to_bytes(32, "big") + b[y_at + 32 :]

    event("not-a-point", "Seat 1's signing key isn't a point: the event check's layout passes, the record doesn't decode.",
          reg("not-a-point", "author-honest-3's key set approved by all three seats, seat 1's y coordinate plus 1.", T,
              [1, 2, 3], tamper=off_curve))
    event("other-definition", "The full registration under another definition's hash: the verifier doesn't read it.",
          bytes.fromhex(registrations["all"]["registration"]), definition=det("other-definition"))
    event("from-trustee-registry", "The full registration logged by the trustee registry's address, which has no "
          "such event: it fails the event check (unknown-event), so carries nothing.",
          bytes.fromhex(registrations["all"]["registration"]), contract="trustee-registry")
    s = transcripts["author-short"]
    event("short", "Seats 1 to 3 of author-short's panel approve its key set of two qualified seats.",
          reg("short", "author-short's key set, approved by seats 1 to 3.", "author-short", [1, 2, 3]))
    event("short-other-key-set", "Seats 1 to 3 of author-short's panel approve a key set of its seat 1 alone.",
          reg("short-other-key-set", "Seat 1 of author-short's key set, approved by seats 1 to 3 over that set.",
              "author-short", [1, 2, 3], entries=transcripts["author-short"]["entries"][:1]))
    assert decode_registration(bytes.fromhex(registrations["not-a-point"]["registration"])) is None
    assert cev9.registration_layout_ok(bytes.fromhex(registrations["not-a-point"]["registration"]))
    assert s["registered"] and len(s["registered"]) == 2

    cases = []

    def case(id_, desc, tid, record_ids, event_ids, expect):
        t = transcripts[tid]
        read = [bytes.fromhex(events[e]["registration"]) for e in event_ids if events[e]["read"]]
        res = check(t["panel"], t, [approvals_records[r] for r in record_ids], read)
        assert (res["seats"] if res["ok"] else res["code"]) == expect, (id_, res, expect)
        cases.append({"id": id_, "description": desc, "transcript": tid, "records": list(record_ids),
                      "events": list(event_ids), "result": res})

    case("all", "Only the registration, every seat approving: 3.1's author part holds without any approvals record.",
         T, [], ["all"], [1, 2, 3])
    case("quorum", "Only the registration, the quorum approving.", T, [], ["quorum"], [1, 3])
    case("with-record", "The quorum's registration beside every seat's approvals record: seats count across both.",
         T, ["all"], ["quorum"], [1, 2, 3])
    case("below-quorum", "A registration short of q_A is none the registry emits: it carries nothing.", T, [],
         ["seat-1"], "author-approvals-missing")
    case("below-quorum-beside-record", "Beside seat 1's approvals record, which names the transcript: one seat of two.",
         T, ["seat-1"], ["seat-2"], "author-approvals")
    case("across-registrations", "Two registrations of one seat each aren't pooled: neither is the registry's.", T, [],
         ["seat-1", "seat-2"], "author-approvals-missing")
    case("no-approvals", "A registration with no approval carries nothing.", T, [], ["no-approvals"],
         "author-approvals-missing")
    case("no-approvals-and-record", "Beside the quorum's approvals record it changes nothing.", T, ["quorum"],
         ["no-approvals"], [1, 3])
    case("other-key-set", "A registration of this run whose key set q_A seats approved isn't the transcript's: it fails, "
         "whatever approves.", T, ["all"], ["all", "other-key-set"], "key-set-mismatch")
    case("other-key-set-alone", "The same registration alone.", T, [], ["other-key-set"], "key-set-mismatch")
    case("other-key-set-unsigned", "Another key set no one approved, beside every seat's record: it carries nothing, so "
         "it can't fail the check (T-53).", T, ["all"], ["other-key-set-unsigned"], [1, 2, 3])
    case("other-key-set-short", "Another key set one seat approved, beside every seat's record: it carries nothing.", T,
         ["all"], ["other-key-set-short"], [1, 2, 3])
    case("other-transcript", "A registration naming another transcript is none of this run's.", T, [],
         ["other-transcript"], "author-approvals-missing")
    case("default-stub", "Over the default stub: none of this run's.", T, [], ["default-stub"], "author-approvals-missing")
    case("default-panel-id", "Under the default-panel identifier: none of this run's.", T, [], ["default-panel-id"],
         "author-approvals-missing")
    case("other-signer", "Another seat's key signing for seat 2 counts for no one, leaving one seat: it carries nothing.",
         T, [], ["other-signer"], "author-approvals-missing")
    case("other-signer-quorum", "The same beside seat 3's valid approval: seats 1 and 3 count, seat 2 doesn't.", T, [],
         ["other-signer-quorum"], [1, 3])
    case("seat-4", "A seat beyond n_A spoils the whole registration.", T, [], ["seat-4"], "author-approvals-missing")
    case("seat-above-n", "A key set with a seat above n_A is none of this run's.", T, [], ["seat-above-n"],
         "author-approvals-missing")
    case("not-a-point", "A registration that doesn't decode carries nothing.", T, [], ["not-a-point"],
         "author-approvals-missing")
    case("not-a-point-and-record", "Beside the quorum's approvals record the record approves.", T, ["quorum"],
         ["not-a-point"], [1, 3])
    case("other-definition", "Another definition's registration isn't read.", T, [], ["other-definition"],
         "author-approvals-missing")
    case("from-trustee-registry", "An event failing the event check isn't read.", T, [], ["from-trustee-registry"],
         "author-approvals-missing")
    case("short", "Two qualified seats where rule 7 needs three: refused whatever the registration.", "author-short", [],
         ["short"], "ceremony-participation")
    case("short-other-key-set", "Participation is decided before a registration's key set.", "author-short", [],
         ["short-other-key-set"], "ceremony-participation")

    doc = {
        "format": "abolish-author-registration-vectors/1",
        "title": "The author panel's approvals from the election registry's AuthorPanelRegistered: registrations in the "
                 "trustee registry's layout, their events under contract-event version 9, and the check over approvals "
                 "records and registrations together",
        "spec": "docs/spec/ceremony.md (Author panel, The registration's approvals), docs/spec/verifier.md (Key ceremony, "
                "step 5), docs/spec/contracts.md (Author panel registration)",
        "generator": "packages/crypto/scripts/author-registration-vectors.py: an independent Python implementation "
                     "(standard library only), from author-ceremony.json and author-ceremony-vectors.py's panels, with "
                     "contract-event-v9-vectors.py's encoder and event check. Every value is test data, never keys",
        "election": {
            **ceremony["election"],
            "definitionHash": definition_hash.hex(),
            "contracts": {k: v.hex() for k, v in contracts.items()},
        },
        "registrations": list(registrations.values()),
        "events": list(events.values()),
        "cases": cases,
    }
    out = vec / "author-registration.json"
    out.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {out}: {len(registrations)} registrations, {len(events)} events, {len(cases)} cases")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
