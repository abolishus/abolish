#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-tallies.json.

Elections for the verifier's tally openings (docs/spec/verifier.md, Tally
openings; 7.4): each is an election definition, a board copy and the panel a
bundle pins, with the row 7.4 a verifier reports and the report's `tallies`.
Every tally opening of the election on the copy is decoded, sorted into an
opening of a cell or a stray opening and attributed by the registered signing
keys the transcript gives (tally.md, Which openings are a cell's, Signature),
then judged against tally.md's Boarding rule as far as it is decided without
the counted set: stray, another number of entries than options
(`tally-missing`), unattributed, and a second opening of a cell by one seat.
The partition is the definition's: under version 1 its tiers, under versions
3 and 4 every tier's stated cells, numbered across the tiers
(election-definition.md, Layout (version 3), Notes, Tally partition).

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ceremony-vectors.py
(definitions of versions 1, 3 and 4, transcripts, board entries and the
ceremony check, which gives the registered signing keys), ceremony-vectors.py (each seat's per-election
signing secret, from the transcript's label) and tally-opening-vectors.py
(the record, its signature over trustee-vectors.py's RFC 6979 P-256 ECDSA,
its strict decoder and attribution) with tally-vectors.py's aggregate.

The openings are of empty cells, whose aggregate is the identity and whose
honest opening is (0, 0) for every option, so the board needs no ballot.
Every value comes from fixed labels (test data, never keys).

Usage: python3 -I -B verifier-tallies-vectors.py <out-dir>; then
`vp check --fix` (the committed file is formatted).
"""

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
tov = _load("tally_opening_vectors", "tally-opening-vectors.py")
cv, dv, rc, d4, d5 = vc.cv, vc.dv, vc.rc, vc.d4, vc.d5
H, ds = vc.H, vc.ds
outcome = vc.outcome

TALLY_TYPE = 0x0006
BALLOT_TYPE = 0x0002
SPOILED_OPENING_TYPE = 0x0003
BOARD_ENTRY_TYPE = 0x0007
CONTRACT_EVENT_TYPE = 0x0008
# The board-entry version every profile here pins: 5, the one that allows the
# close statement, beside contract-event version 3 (close.md, Version).
BOARD_VERSION = 5
MEMBERSHIP_VK_HASH = bytes.fromhex(json.loads((VECTORS / "membership-proof.json").read_text())["verificationKey"]["hash"])


def tally_entries(d, entries):
    """The positions and payloads of the election's tally openings, by the envelope (4.1 reports every other entry)."""
    out = []
    for at, raw in enumerate(entries):
        env = vc.decode_entry(raw, BOARD_VERSION)
        if isinstance(env, str) or env["electionId"] != d["election_id"]:
            continue
        if int.from_bytes(env["payload"][:2], "big") == TALLY_TYPE:
            out.append((at, env["payload"]))
    return out


def definition_hash_of(d):
    return H(ds(b"abolish/v1/election-definition", vc.encode(d)))


def partition_size(d):
    """Version 1's cells are its tiers; versions 3 to 5 number every tier's stated cells across the tiers."""
    if vc.own_version(d) == 1:
        return len(d["electorate"])
    return sum(len(t["cells"]) for t in d["electorate"])


def option_total(d):
    """`m`, the options an opening opens (tally.md, Context): under version 5 the total over the questions."""
    if vc.own_version(d) == 5:
        return sum(q["option_count"] for q in d["questions"])
    return d["option_count"]


def statement_of(o):
    return tov.statement(o["definitionHash"], o["cell"], o["aggregateHash"], o["signer"], o["opening"])


def expected(d, definition_hash, registered, entries):
    """7.4 and the report's tallies, computed here from tally.md and verifier.md."""
    cells = partition_size(d)
    report = []
    first = {}
    for at, payload in tally_entries(d, entries):
        try:
            o = tov.decode(payload)
        except tov.Reject as e:
            report.append({"entry": at, "code": "decode", "decodeError": e.code, "breaks": []})
            continue
        signer = tov.attribution(registered, o)
        if o["definitionHash"] != definition_hash or o["cell"] >= cells:
            breaks = [{"code": "tally-stray"}] + ([{"code": "tally-unattributed"}] if signer is None else [])
            report.append({"entry": at, "signer": signer, "breaks": breaks})
            continue
        breaks = []
        if len(o["opening"]) != option_total(d):
            breaks.append({"code": "tally-missing"})
        if signer is None:
            breaks.append({"code": "tally-unattributed"})
        elif (o["cell"], signer) in first:
            # A replay of the same signed message is the operator's alone; a
            # different one shows the seat signed twice (tally.md, Signature).
            of, m0 = first[(o["cell"], signer)]
            same = m0 == statement_of(o)
            breaks.append({"code": "tally-repeat" if same else "tally-second", "of": of})
        else:
            first[(o["cell"], signer)] = (at, statement_of(o))
        report.append({"entry": at, "cell": o["cell"], "signer": signer, "breaks": breaks})
    if any("code" not in o and not o["breaks"] for o in report):
        return outcome("unverifiable", "not-implemented"), report
    if not report:
        return outcome("pass"), report
    head = report[0]
    where = {"entry": head["entry"]}
    if "decodeError" in head:
        where["decodeError"] = head["decodeError"]
    return outcome("fail", head.get("code") or head["breaks"][0]["code"], where), report


def main(out_dir):
    vc.self_check()
    tov.grp.self_check()
    tov.ecdsa.self_check()
    panel = cv.make_panel("panel-4", 3, 4)
    eid = dv.TYPICAL["election_id"]

    def election_for(label, seats, cheat=None, tally_version=1, base=dv.TYPICAL, opening_version=1):
        """A definition of `base`'s version pinning board-entry version 5 and contract-event version 3, which every profile needs (close.md, Version), (and ballot version 2 under versions 3 and 4, which name a cell, and 3 under version 5, which carries questions), its transcript for its own stub, and the seats' per-election signing secrets."""
        own = dict(base["profile"]["pins"])[0x0001]
        ballot = {3: 2, 4: 2, 5: 3}.get(own)
        pin = {BOARD_ENTRY_TYPE: BOARD_VERSION, CONTRACT_EVENT_TYPE: 3, TALLY_TYPE: tally_version, SPOILED_OPENING_TYPE: opening_version, **({BALLOT_TYPE: ballot} if ballot is not None else {})}
        pins = [(ty, pin.get(ty, v)) for ty, v in base["profile"]["pins"]]
        fields = {"profile": {"protocol_major": 1, "pins": pins}, "membership_vk_hash": MEMBERSHIP_VK_HASH}
        ctx = vc.election_of(vc.definition_for(panel, bytes(32), base, **fields))
        t = vc.transcript(f"verifier-tallies/{label}", panel, seats, ctx, cheat)
        d = vc.definition_for(panel, H(ds(vc.TRANSCRIPT_TAG, t)), base, **fields)
        secrets = {i: cv.seat_secrets(f"verifier-tallies/{label}", i)["signing"] for i in seats}
        return d, t, secrets

    def registered_of(d, t, secrets):
        checked = cv.check(panel, t, vc.election_of(d))
        assert checked["ok"] and [k["index"] for k in checked["registered"]] == sorted(secrets)
        registered = {k["index"]: bytes.fromhex(k["signingKey"]) for k in checked["registered"]}
        for i, s in secrets.items():
            assert tov.p256_key(s) == registered[i], i
        return registered

    def opener(d, secrets):
        """Openings for `d`'s election: `opening(cell, signer, ...)` is a tally opening of `cell` signed by `key` (seat `signer`'s own secret by default), naming `claimed` (default `signer`) as its signer."""
        m, k = option_total(d), d["threshold"]
        empty = tov.aggregate_hash(tov.tv.aggregate(m, k, []))
        zeros = [{"v": 0, "r": 0} for _ in range(m)]
        own = definition_hash_of(d)

        def opening(cell, signer, values=zeros, key=None, definition=own, claimed=None):
            named = signer if claimed is None else claimed
            msg = tov.statement(definition, cell, empty, named, values)
            sig = tov.sign(secrets[signer] if key is None else key, msg)
            return tov.encode({"definitionHash": definition, "cell": cell, "aggregateHash": empty, "signer": named, "opening": values, "signature": sig})

        return opening, zeros

    d, t, secrets = election_for("election", [1, 2, 3])
    registered = registered_of(d, t, secrets)
    # Seat 4 sends nothing, so its per-election key is never registered.
    unregistered = cv.seat_secrets("verifier-tallies/election", 4)["signing"]
    opening, zeros = opener(d, secrets)

    honest0 = opening(0, 1)
    honest1 = opening(1, 2)
    other_definition = opening(0, 1, definition=H(b"verifier-tallies other definition"))
    elsewhere = opening(0, 2)
    beyond = opening(2, 3)
    beyond_unattributed = opening(2, 3, key=unregistered)
    short = opening(0, 3, values=zeros[:2])
    by_unregistered = opening(1, 4, key=unregistered)
    claimed_other = opening(1, 2, claimed=3)
    second0 = opening(0, 1, values=[{"v": 1, "r": 7}] + zeros[1:])
    third0 = opening(0, 1, values=[{"v": 2, "r": 9}] + zeros[1:])
    long = opening(1, 3, values=zeros + [{"v": 0, "r": 0}])
    trailing = honest0 + b"\x00"
    other_version = honest1[:2] + b"\x02" + honest1[3:]

    cases = []

    def case(id_, description, payloads, want, defn=d, transcript=t, keys=registered, ceremony="pass", other_election=()):
        entries = []
        for p in [transcript] + payloads:
            entries.append(vc.entry(BOARD_VERSION, b"\xee" * 32 if p in other_election else eid, len(entries), 0, p))
        rows, _ = vc.expected(panel, defn, entries, panel, BOARD_VERSION)
        assert rows["3.2"]["status"] == ceremony, (id_, rows["3.2"])
        if dict(defn["profile"]["pins"]).get(TALLY_TYPE) != 1:
            row, report = outcome("unverifiable", "unsupported-version", {}), None
        elif ceremony != "pass":
            row, report = vc.NOT_REACHED, None
        else:
            row, report = expected(defn, definition_hash_of(defn), keys, entries)
        assert row["status"] == want, (id_, row)
        c = {
            "id": id_,
            "description": description,
            "panel": "panel-4",
            "definition": vc.encode(defn).hex(),
            # Only 4.1 and 4.2 read the clock; every entry is in segment 0.
            "clock": {"epoch": str(defn["closes_at"] - 7200), "period": "3600", "deadline": "7200", "lastSegment": "8"},
            "board": b"".join(entries).hex(),
            "expected": {"7.4": row},
        }
        if report is not None:
            c["tallies"] = report
        cases.append(c)
        return c

    mixed = case(
        "mixed",
        "Seat 4 sends nothing, so seats 1 to 3 are registered and the partition has two cells (tiers 0 and 2). After the transcript: an honest opening of each cell (seats 1 and 2, undecided until the counted set is known), one naming another definition and one naming cell 2 (stray), a cell-2 opening signed by seat 4's unregistered key (stray and unattributed), a two-entry opening of cell 0 by seat 3 (tally-missing), a cell-1 opening signed by seat 4 (unattributed), seat 2's signature on a record naming seat 3 (unattributed), seat 1's second opening of cell 0 with other values (tally-second, of its first), one with a trailing byte and one of tally-opening version 2 (decode), and an opening carried by another election's entry, which is 4.1's and never read here. 7.4 is unverifiable.",
        [honest0, honest1, other_definition, beyond, beyond_unattributed, short, by_unregistered, claimed_other, second0, trailing, other_version, elsewhere],
        "unverifiable",
        other_election=(elsewhere,),
    )
    breaks = {b["code"] for o in mixed["tallies"] for b in o["breaks"]}
    assert breaks == {"tally-stray", "tally-missing", "tally-unattributed", "tally-second"}, breaks
    assert {o.get("decodeError") for o in mixed["tallies"]} >= {"trailing-bytes", "profile-mismatch"}

    case(
        "settled",
        "Every opening breaks a decided rule: one naming cell 2 (stray), a two-entry one (tally-missing), one signed by seat 4 (unattributed) and seat 1's second opening of cell 0 after its first, which itself is short. 7.4 fails at the first, tally-stray.",
        [beyond, opening(0, 1, values=zeros[:1]), by_unregistered, second0],
        "fail",
    )
    case(
        "decode-first",
        "The first opening doesn't decode (a trailing byte), and a stray one follows: 7.4 fails with decode and its decoding code.",
        [trailing, beyond],
        "fail",
    )
    case(
        "honest",
        "One honest opening of each cell, by seats 1 and 2, and another of cell 0 by seat 3: undecided until the counted set is known, so 7.4 is unverifiable.",
        [honest0, honest1, opening(0, 3)],
        "unverifiable",
    )
    case(
        "second-by-seat",
        "Seat 1 opens cell 0, then cell 1, then cell 0 again with the same signed record (a replay anyone can make: tally-repeat, the operator's alone), then twice more with other values (tally-second, each of the first, evidence against seat 1). The opening of another cell is no second; the first ones stay undecided.",
        [honest0, opening(1, 1), honest0, second0, third0],
        "unverifiable",
    )
    case(
        "too-many-entries",
        "An opening of cell 1 by seat 3 with one more entry than options: tally-missing, and 7.4 fails.",
        [long],
        "fail",
    )
    case(
        "unattributed-twice",
        "Two openings of cell 1 naming seat 3 with seat 2's signature: each is unattributed, and neither is a second, since only an attributed opening is by a seat. 7.4 fails with tally-unattributed.",
        [claimed_other, claimed_other],
        "fail",
    )
    case("none", "The transcript and no tally opening: 7.4 passes.", [], "pass")
    case(
        "other-election",
        "The only tally opening is in an entry of another election: 4.1's to report, so 7.4 passes with nothing listed.",
        [elsewhere],
        "pass",
        other_election=(elsewhere,),
    )

    # No key set registered: nothing is attributed, so nothing is judged.
    def two_bad(i, answers, *_):
        return [bytes(32)] * len(answers) if i in (3, 4) else answers

    dq, tq, _ = election_for("quorum", [1, 2, 3, 4], {"answers": two_bad})
    case("quorum", "Seats 3 and 4 answer wrongly: no key set is registered, so 7.4 is not reached.", [honest0], "unverifiable", defn=dq, transcript=tq, ceremony="fail")

    # A tally-opening version this verifier doesn't read (T-36).
    d2, t2, _ = election_for("tally-v2", [1, 2, 3], tally_version=2)
    case("tally-v2", "The profile pins tally-opening version 2, unknown here: 7.4 is unsupported.", [honest0], "unverifiable", defn=d2, transcript=t2)

    # Definition versions 3 and 4: the partition is every tier's stated
    # cells, numbered across the tiers. TYPICAL's tier 0 has three cells and
    # tier 2 one, so cells 0 to 3 are the partition's and cell 3 is tier 2's
    # one cell: counted by tiers instead, it would be stray, and cell 1 would
    # be tier 2's. Their profiles pin ballot version 2 beside spoiled-ballot
    # opening version 1, which 2.3 fails; the tally openings are read anyway.
    assert rc.TYPICAL["election_id"] == eid == d4.TYPICAL["election_id"]
    d3, t3, s3 = election_for("definition-v3", [1, 2, 3], base=rc.TYPICAL)
    assert vc.own_version(d3) == 3 and [len(x["cells"]) for x in d3["electorate"]] == [3, 1]
    r3 = registered_of(d3, t3, s3)
    open3, zeros3 = opener(d3, s3)
    unregistered3 = cv.seat_secrets("verifier-tallies/definition-v3", 4)["signing"]
    v3 = dict(defn=d3, transcript=t3, keys=r3)
    case(
        "v3-cells",
        "A version-3 definition with cells 0 to 2 in tier 0 and cell 3, tier 2's one cell. After the transcript: an honest opening of cell 0 by seat 1 and of cell 3 by seat 2 (openings of a cell, undecided until the counted set is known; cell 3 is past the number of tiers), one of cell 4 by seat 3 (stray: the partition has four cells), a two-entry opening of cell 2 by seat 1 (tally-missing), one of cell 1 signed by seat 4's unregistered key (unattributed) and seat 2's second opening of cell 3 with other values (tally-second). 7.4 is unverifiable.",
        [open3(0, 1), open3(3, 2), open3(4, 3), open3(2, 1, values=zeros3[:2]), open3(1, 4, key=unregistered3), open3(3, 2, values=[{"v": 1, "r": 5}] + zeros3[1:])],
        "unverifiable",
        **v3,
    )
    case(
        "v3-settled",
        "A version-3 definition: an opening of cell 4 by seat 1 (stray), then one of cell 3 by seat 4's unregistered key (unattributed) and one naming the version-1 election's definition (stray). 7.4 fails at the first, tally-stray.",
        [open3(4, 1), open3(3, 4, key=unregistered3), open3(0, 2, definition=definition_hash_of(d))],
        "fail",
        **v3,
    )
    case("v3-none", "A version-3 definition, the transcript and no tally opening: 7.4 passes.", [], "pass", **v3)

    d4_, t4, s4 = election_for("definition-v4", [1, 2, 3], base=d4.TYPICAL)
    assert vc.own_version(d4_) == 4 and [len(x["cells"]) for x in d4_["electorate"]] == [3, 1]
    open4, zeros4 = opener(d4_, s4)
    case(
        "v4-cells",
        "A version-4 definition (version 3's partition): an honest opening of cell 3 by seat 3, the same seat's opening of cell 3 replayed (tally-repeat), and the version-3 election's opening of cell 0 by its seat 1 (stray, naming another definition, and unattributed, since that seat's key isn't registered here). 7.4 is unverifiable.",
        [open4(3, 3), open4(3, 3), open3(0, 1)],
        "unverifiable",
        defn=d4_,
        transcript=t4,
        keys=registered_of(d4_, t4, s4),
    )

    # Spoiled-ballot opening version 2, which opens version-2 cores: 2.3's
    # combination passes beside another pin than the typical profile's (and
    # board-entry version 5 and contract-event version 3), and
    # the tally openings are judged as under it.
    do2, to2, so2 = election_for("definition-v3-opening-2", [1, 2, 3], base=rc.TYPICAL, opening_version=2)
    open_o2, _ = opener(do2, so2)
    c = case(
        "v3-opening-2",
        "A version-3 definition pinning spoiled-ballot opening version 2, whose pairing with ballot version 2 passes 2.3, beside board-entry version 5 and contract-event version 3: an opening of cell 3 by seat 1 (undecided) and one of cell 4 by seat 2 (stray). 7.4 is unverifiable.",
        [open_o2(3, 1), open_o2(4, 2)],
        "unverifiable",
        defn=do2,
        transcript=to2,
        keys=registered_of(do2, to2, so2),
    )
    # This case also gives 2.3's row, to show 7.4 runs beside it.
    c["expected"]["2.3"] = vc.combination(do2)
    assert c["expected"]["2.3"] == vc.NOT_IMPLEMENTED, c["expected"]["2.3"]
    assert [o.get("cell") for o in c["tallies"]] == [3, None]

    # Definition version 5: an opening opens every option of every question,
    # `m` the total over them (tally.md, Context), over version 3's partition.
    assert d5.TYPICAL["election_id"] == eid
    d5_, t5, s5 = election_for("definition-v5", [1, 2, 3], base=d5.TYPICAL, opening_version=2)
    assert vc.own_version(d5_) == 5 and [len(x["cells"]) for x in d5_["electorate"]] == [3, 1]
    open5, zeros5 = opener(d5_, s5)
    first_question = d5_["questions"][0]["option_count"]
    assert len(zeros5) == 18 and first_question == 3
    c = case(
        "v5-questions",
        "A version-5 definition with the owner's four questions (3, 5, 4 and 6 options, 18 in all) over version 3's partition: an honest opening of cell 3 by seat 1 (undecided), one of cell 0 by seat 2 with an entry per option of the first question only (tally-missing), one of cell 1 by seat 3 with 19 entries (tally-missing) and one of cell 4 by seat 1 (stray). 7.4 is unverifiable.",
        [open5(3, 1), open5(0, 2, values=zeros5[:first_question]), open5(1, 3, values=zeros5 + [{"v": 0, "r": 0}]), open5(4, 1)],
        "unverifiable",
        defn=d5_,
        transcript=t5,
        keys=registered_of(d5_, t5, s5),
    )
    c["expected"]["2.3"] = vc.combination(d5_)
    assert c["expected"]["2.3"] == vc.NOT_IMPLEMENTED, c["expected"]["2.3"]
    assert [[b["code"] for b in o["breaks"]] for o in c["tallies"]] == [[], ["tally-missing"], ["tally-missing"], ["tally-stray"]]

    dq3, tq3, _ = election_for("quorum-v3", [1, 2, 3, 4], {"answers": two_bad}, base=rc.TYPICAL)
    case("quorum-v3", "A version-3 definition whose seats 3 and 4 answer wrongly: no key set is registered, so 7.4 is not reached.", [open3(0, 1)], "unverifiable", defn=dq3, transcript=tq3, ceremony="fail")
    d3t, t3t, _ = election_for("tally-v2-v3", [1, 2, 3], tally_version=2, base=rc.TYPICAL)
    case("tally-v2-v3", "A version-3 definition pinning tally-opening version 2, unknown here: 7.4 is unsupported.", [open3(0, 1)], "unverifiable", defn=d3t, transcript=t3t)

    doc = {
        "format": "abolish-verifier-tallies-vectors/1",
        "title": "The verifier's tally openings: definitions, boards and pinned panels, with the row 7.4 and the report's tallies",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-tallies-vectors.py, from verifier-ceremony-vectors.py, ceremony-vectors.py "
            "and tally-opening-vectors.py (independent Python implementations)"
        ),
        "panels": {"panel-4": {"threshold": str(panel["k"]), "keys": [x.hex() for x in panel["keys"]]}},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-tallies.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: verifier-tallies-vectors.py <out-dir>")
    main(sys.argv[1])
