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

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ceremony-vectors.py
(definitions, transcripts, board entries and the ceremony check, which gives
the registered signing keys), ceremony-vectors.py (each seat's per-election
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
cv, dv = vc.cv, vc.dv
H, ds = vc.H, vc.ds
outcome = vc.outcome

TALLY_TYPE = 0x0006
BOARD_ENTRY_TYPE = 0x0007
MEMBERSHIP_VK_HASH = bytes.fromhex(json.loads((VECTORS / "membership-proof.json").read_text())["verificationKey"]["hash"])


def tally_entries(d, entries):
    """The positions and payloads of the election's tally openings, by the envelope (4.1 reports every other entry)."""
    out = []
    for at, raw in enumerate(entries):
        env = vc.decode_entry(raw, 4)
        if isinstance(env, str) or env["electionId"] != d["election_id"]:
            continue
        if int.from_bytes(env["payload"][:2], "big") == TALLY_TYPE:
            out.append((at, env["payload"]))
    return out


def expected(d, definition_hash, registered, entries):
    """7.4 and the report's tallies, computed here from tally.md and verifier.md."""
    cells = len(d["electorate"])
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
        if len(o["opening"]) != d["option_count"]:
            breaks.append({"code": "tally-missing"})
        if signer is None:
            breaks.append({"code": "tally-unattributed"})
        elif (o["cell"], signer) in first:
            breaks.append({"code": "tally-second", "of": first[(o["cell"], signer)]})
        else:
            first[(o["cell"], signer)] = at
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

    def election_for(label, seats, cheat=None, tally_version=1):
        """A version-1 definition pinning board-entry version 4, its transcript for its own stub, and the seats' per-election signing secrets."""
        pins = [(ty, 4 if ty == BOARD_ENTRY_TYPE else tally_version if ty == TALLY_TYPE else v) for ty, v in dv.ALL_PINS]
        fields = {"profile": {"protocol_major": 1, "pins": pins}, "membership_vk_hash": MEMBERSHIP_VK_HASH}
        ctx = vc.election_of(vc.definition_for(panel, bytes(32), **fields))
        t = vc.transcript(f"verifier-tallies/{label}", panel, seats, ctx, cheat)
        d = vc.definition_for(panel, H(ds(vc.TRANSCRIPT_TAG, t)), **fields)
        secrets = {i: cv.seat_secrets(f"verifier-tallies/{label}", i)["signing"] for i in seats}
        return d, t, secrets

    d, t, secrets = election_for("election", [1, 2, 3])
    definition_hash = H(ds(b"abolish/v1/election-definition", dv.enc_definition(d)))
    checked = cv.check(panel, t, vc.election_of(d))
    assert checked["ok"] and [k["index"] for k in checked["registered"]] == [1, 2, 3]
    registered = {k["index"]: bytes.fromhex(k["signingKey"]) for k in checked["registered"]}
    for i, s in secrets.items():
        assert tov.p256_key(s) == registered[i], i
    # Seat 4 sends nothing, so its per-election key is never registered.
    unregistered = cv.seat_secrets("verifier-tallies/election", 4)["signing"]

    m, k = d["option_count"], d["threshold"]
    empty = tov.aggregate_hash(tov.tv.aggregate(m, k, []))
    zeros = [{"v": 0, "r": 0} for _ in range(m)]

    def opening(cell, signer, values=zeros, key=None, definition=definition_hash, claimed=None):
        """A tally opening of `cell` signed by `key` (seat `signer`'s own secret by default), naming `claimed` (default `signer`) as its signer."""
        named = signer if claimed is None else claimed
        msg = tov.statement(definition, cell, empty, named, values)
        sig = tov.sign(secrets[signer] if key is None else key, msg)
        return tov.encode({"definitionHash": definition, "cell": cell, "aggregateHash": empty, "signer": named, "opening": values, "signature": sig})

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
    trailing = honest0 + b"\x00"
    other_version = honest1[:2] + b"\x02" + honest1[3:]

    cases = []

    def case(id_, description, payloads, want, defn=d, transcript=t, keys=registered, ceremony="pass", other_election=()):
        entries = []
        for p in [transcript] + payloads:
            entries.append(vc.entry(4, b"\xee" * 32 if p in other_election else eid, len(entries), 0, p))
        rows, _ = vc.expected(panel, defn, entries, panel, 4)
        assert rows["3.2"]["status"] == ceremony, (id_, rows["3.2"])
        if dict(defn["profile"]["pins"]).get(TALLY_TYPE) != 1:
            row, report = outcome("unverifiable", "unsupported-version", {}), None
        elif ceremony != "pass":
            row, report = vc.NOT_REACHED, None
        else:
            row, report = expected(defn, H(ds(b"abolish/v1/election-definition", dv.enc_definition(defn))), keys, entries)
        assert row["status"] == want, (id_, row)
        c = {
            "id": id_,
            "description": description,
            "panel": "panel-4",
            "definition": dv.enc_definition(defn).hex(),
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
        "Seat 1 opens cell 0 twice with the same values, then cell 1 once: the copy of cell 0 is tally-second; the opening of another cell is not; the first ones stay undecided.",
        [honest0, opening(1, 1), honest0],
        "unverifiable",
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
