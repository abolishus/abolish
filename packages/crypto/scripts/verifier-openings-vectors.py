#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-openings.json.

Elections for the verifier's spoiled-ballot openings (docs/spec/verifier.md,
Spoiled-ballot openings; 6.2): each is an election definition, a clock, a
board copy and the panel a bundle pins, with the row 6.2 a verifier reports
and the report's `openings`. The openings are checked against the registered
key set the transcript gives, and against challenge.md's Publication rules as
far as the floor of `s_S`, `period(closes_at) + 1` (tally.md, Tally window),
decides them.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ballots-vectors.py
(the election, its transcript and the ballots, rebuilt from their labels),
verifier-ceremony-vectors.py (board entries and the ceremony check, which
gives the registered seats' KEM keys) and challenge-vectors.py (the opening
record, its checks, the core hash and the client's openings, over
share-encryption-vectors.py's self-checked ML-KEM-768 and
ChaCha20-Poly1305).

The ballots' membership proofs are randomised, so their records are read
from the committed verifier-ballots.json (its "admitted" case) and checked
against the ballots rebuilt here; nothing else needs a prover. Every other
value comes from fixed labels (test data, never keys).

Usage: python3 -I -B verifier-openings-vectors.py <constants> <out-dir>, where
<constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json;
then `vp check --fix` (the committed file is formatted).
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


vb = _load("verifier_ballots_vectors", "verifier-ballots-vectors.py")
ch = _load("challenge_vectors", "challenge-vectors.py")
vc, bal = vb.vc, vb.bal
bv, se, grp = ch.bv, ch.se, ch.grp

OPENING_TYPE = 0x0003
BALLOT_TYPE = 0x0002
ENVELOPE = 51
PERIOD = 3600
outcome, NOT_REACHED = vc.outcome, vc.NOT_REACHED


def split(board):
    """A board copy's entries, by their length fields (docs/spec/verifier.md, Bundle)."""
    out, at = [], 0
    while at < len(board):
        n = int.from_bytes(board[at + 47 : at + 51], "big")
        out.append(board[at : at + ENVELOPE + n])
        at += ENVELOPE + n
    return out


def opened_set(o):
    """What a passing opening opens (challenge.md, Opened commitments): each C_j, and h^s and g · h^s for every scalar it reveals but 0 and 1."""
    out = {grp.encode(row[0]) for row in o["vss"]}
    n = len(o["shareHashes"])
    revealed = set()
    for p in o["polynomials"]:
        for poly in (p["f"], p["g"]):
            revealed.update(poly)
            revealed.update(bv.evaluate(poly, i) for i in range(1, n + 1))
    for s in o["seats"]:
        revealed.update((s["e"], s["w"]))
    revealed -= {0, 1}
    for x in revealed:
        out.add(grp.encode(bv.pedersen(0, x)))
        out.add(grp.encode(bv.pedersen(1, x)))
    return out


def ballot_core(payload):
    """A version-1 ballot record's definition hash and its C_j, read at the record's fixed offsets (ballot-validity.md, Ballot record)."""
    assert payload[:3] == bytes([0, BALLOT_TYPE, 1])
    definition_hash = payload[3:35]
    pos = 364
    m = int.from_bytes(payload[pos : pos + 4], "big")
    pos += 4
    commitments = []
    for _ in range(m):
        k = int.from_bytes(payload[pos : pos + 4], "big")
        commitments.append(payload[pos + 4 : pos + 36])
        pos += 4 + 32 * k
    return definition_hash, commitments


def floor_of(closes_at, clock):
    """period(closes_at) + 1, with Python's floor division."""
    return (closes_at - clock["epoch"]) // clock["period"] + 1


def expected(d, e, entries, clock):
    """6.2 and the report's openings, computed here from challenge.md and verifier.md."""
    floor = floor_of(d["closes_at"], clock)
    envelopes = []
    for at, raw in enumerate(entries):
        env = vc.decode_entry(raw, 4)
        if not isinstance(env, str) and env["electionId"] == d["election_id"]:
            envelopes.append((at, env["payload"], env["segment"], int.from_bytes(env["payload"][:2], "big")))
    # Every admitted ballot at or below the floor, wherever it sits in the
    # copy. These vectors board only ballots verifier-ballots.json admits.
    counted = [(at, ballot_core(p)) for at, p, seg, kind in envelopes if kind == BALLOT_TYPE and seg <= floor]
    report = []
    seen = {}
    for at, payload, segment, kind in envelopes:
        if kind != OPENING_TYPE:
            continue
        early = [{"code": "opening-early"}] if segment <= floor else []
        o = decode_opening(payload)
        if isinstance(o, str):
            report.append({"entry": at, "code": "decode", "decodeError": o, "breaks": early})
            continue
        code = ch.core_hash(o["definitionHash"], o["tier"], o["vss"], o["shareHashes"])
        repeat = [{"code": "opening-repeat", "of": seen[code]}] if code in seen else []
        seen.setdefault(code, at)
        r = ch.check_opening(e, o)
        if r[0] != "ok":
            row = {"entry": at, "code": r[0]}
            if r[1] is not None:
                row["option"] = r[1]
            if r[2] is not None:
                row["seat"] = r[2]
            report.append(dict(row, breaks=early + repeat))
            continue
        _, core, votes, within = r
        opened = opened_set(o)
        cast = next((b for b, (dh, cs) in counted if dh == o["definitionHash"] and any(c in opened for c in cs)), None)
        row = {"entry": at, "coreHash": core.hex(), "votes": [str(v) for v in votes]}
        if not within:
            row["voteOutside"] = True
        row["breaks"] = early + ([{"code": "opening-cast", "ballot": cast}] if cast is not None else []) + repeat
        report.append(row)
    settled = [o for o in report if "code" in o or o["breaks"]]
    if len(settled) < len(report):
        return outcome("unverifiable", "not-implemented"), report
    if not report:
        return outcome("pass"), report
    first = report[0]
    where = {"entry": first["entry"]}
    if "decodeError" in first:
        where["decodeError"] = first["decodeError"]
    return outcome("fail", first["code"] if "code" in first else first["breaks"][0]["code"], where), report


def decode_opening(b):
    """Strict decoding of an opening record pinned at version 1 (challenge.md), as far as these vectors need it: the header, then every field, with no trailing bytes."""
    if int.from_bytes(b[:2], "big") != OPENING_TYPE:
        return "unknown-record-type"
    if b[2] != 1:
        return "profile-mismatch"
    r = Reader(b, 3)
    try:
        o = {"definitionHash": r.take(32), "tier": r.u8()}
        o["vss"] = r.list(lambda: r.list(r.element))
        o["shareHashes"] = r.list(lambda: r.take(32))
        o["polynomials"] = r.list(lambda: {"f": r.list(r.scalar), "g": r.list(r.scalar)})
        o["seats"] = r.list(lambda: {"seat": r.u8(), "m": r.take(32), "e": r.scalar(), "w": r.scalar()})
    except IndexError:
        return "truncated"
    if r.at != len(b):
        return "trailing-bytes"
    return o


class Reader:
    def __init__(self, b, at):
        self.b, self.at = b, at

    def take(self, n):
        if self.at + n > len(self.b):
            raise IndexError
        out = self.b[self.at : self.at + n]
        self.at += n
        return out

    def u8(self):
        return self.take(1)[0]

    def list(self, item):
        return [item() for _ in range(int.from_bytes(self.take(4), "big"))]

    def scalar(self):
        x = int.from_bytes(self.take(32), "little")
        assert x < ch.L
        return x

    def element(self):
        return grp.decode(self.take(32))


def main(constants, out_dir):
    s = vb.build(constants)
    src = next(b for b in s["bundles"] if b["id"] == "admitted")
    d, t, e = src["definition"], src["transcript"], src["election"]
    panel = s["panels"][e["panel"]]
    eid = s["eid"]
    assert d["election_id"] == eid

    # The ballots' records, as committed, checked against the ballots rebuilt here.
    committed = next(c for c in json.loads((VECTORS / "verifier-ballots.json").read_text())["cases"] if c["id"] == "admitted")
    records = [vc.decode_entry(x, 4)["payload"] for x in split(bytes.fromhex(committed["board"]))]
    assert records[0] == t
    (ok0, _), (ok2, _), _ = src["board"][1:]
    for rec, b in zip(records[1:3], (ok0, ok2)):
        assert ballot_core(rec) == (b["definitionHash"], [grp.encode(row[0]) for row in b["vote"]["vss"]])
    rec0, rec2 = records[1], records[2]

    # The registered seats' KEM keys, from the transcript.
    checked = vc.cv.check(panel, t, vc.election_of(d))
    assert checked["ok"] and [k["index"] for k in checked["registered"]] == src["registered"]
    keys = {}
    for k in checked["registered"]:
        raw = bytes.fromhex(k["kemKey"])
        keys[k["index"]] = {"ek": raw[:1184], "dh": grp.decode(raw[1184:])}
    election = dict(e, registered=src["registered"], keys=keys, tiers=list(e["tiers"]))

    def opening(label, votes, tier=0, cheat=None):
        o, _ = ch.make_opening("verifier-openings/" + label, election, tier, votes, cheat)
        return o

    def opening_of(label, polys, tier=0):
        """An honest opening of these polynomials: fresh encapsulation randomness, real ciphertexts."""
        rng = bv.Rng("verifier-openings/encapsulation/" + label)
        vss = [[bv.pedersen(p["f"][t_], p["g"][t_]) for t_ in range(len(p["f"]))] for p in polys]
        hashes, seats = [], []
        for seat in range(1, election["panelSize"] + 1):
            if seat not in election["registered"]:
                hashes.append(bytes(32))
                continue
            m, ee, w = rng.bytes32(), se.nonzero_scalar(rng), se.nonzero_scalar(rng)
            shares = [{"v": bv.evaluate(p["f"], seat), "r": bv.evaluate(p["g"], seat)} for p in polys]
            ct, _ = se.encrypt(election["definitionHash"], seat, keys[seat], vss, bv.enc_shares(shares), m, ee, w)
            hashes.append(se.share_hash(ct))
            seats.append({"seat": seat, "m": m, "e": ee, "w": w})
        return {"definitionHash": election["definitionHash"], "tier": tier, "vss": vss, "shareHashes": hashes, "polynomials": polys, "seats": seats}

    def recast(label, ballot_label, votes, option):
        """A core that keeps one cast ballot's (v_j, r_j) at `option`, every other coefficient fresh: other share hashes, the same C_j."""
        k = election["threshold"]
        src_rng = bv.Rng("verifier-ballot/" + ballot_label)
        cast = []
        for v in votes:
            f = [v % ch.L] + [src_rng.scalar() for _ in range(k - 1)]
            g = [src_rng.scalar() for _ in range(k)]
            cast.append({"f": f, "g": g})
        rng = bv.Rng("verifier-openings/recast/" + label)
        polys = []
        for j, p in enumerate(cast):
            f = [p["f"][0] if j == option else 0] + [rng.scalar() for _ in range(k - 1)]
            g = [p["g"][0] if j == option else rng.scalar()] + [rng.scalar() for _ in range(k - 1)]
            polys.append({"f": f, "g": g})
        return opening_of(label, polys), cast

    honest = opening("honest", [1, 0, 0])
    honest2 = opening("honest-2", [0, 0, 1])
    early = opening("early", [0, 1, 0])
    cast0, polys0 = recast("cast-ok0", "ok-tier-0", [0, 1, 0], 1)
    assert grp.equal(bv.pedersen(polys0[1]["f"][0], polys0[1]["g"][0]), ok0["vote"]["vss"][1][0])
    cast2, polys2 = recast("cast-ok2", "ok-tier-2", [0, 0, 0], 0)
    assert grp.equal(bv.pedersen(polys2[0]["f"][0], polys2[0]["g"][0]), ok2["vote"]["vss"][0][0])
    outside = opening("outside", [2, 0, 0])
    stray = dict(honest2, definitionHash=bal.det("verifier other definition"))
    tier = dict(honest2, tier=1)
    shape = dict(honest2, seats=honest2["seats"][:2])
    unqualified = dict(honest2, shareHashes=honest2["shareHashes"][:3] + [bal.det("verifier-openings unqualified")])
    vss_bad = opening("vss", [0, 1, 0])
    vss_bad["polynomials"] = [dict(p) for p in vss_bad["polynomials"]]
    vss_bad["polynomials"][1] = {"f": [vss_bad["polynomials"][1]["f"][0], (vss_bad["polynomials"][1]["f"][1] + 1) % ch.L, vss_bad["polynomials"][1]["f"][2]], "g": vss_bad["polynomials"][1]["g"]}

    def wrong_share(seat, shares):
        return [dict(x, v=(x["v"] + 1) % ch.L) for x in shares] if seat == 2 else shares

    ciphertext = opening("ciphertext", [0, 0, 1], cheat=wrong_share)
    enc = ch.enc_opening
    trailing = enc(honest2) + b"\x00"

    clock = {"epoch": d["closes_at"] - 2 * PERIOD, "period": PERIOD, "deadline": 7200, "lastSegment": 8}
    floor = floor_of(d["closes_at"], clock)
    assert floor == 3

    def board(segments):
        """`segments`: (segment, [payload]) in order; openings go last in their segment, sorted (board.md, Spoiled-ballot openings)."""
        out = []
        for seg, payloads in segments:
            others = [p for p in payloads if int.from_bytes(p[:2], "big") != OPENING_TYPE]
            opens = sorted(p for p in payloads if int.from_bytes(p[:2], "big") == OPENING_TYPE)
            assert len(set(opens)) == len(opens)
            for p in others + opens:
                out.append(vc.entry(4, eid, len(out), seg, p))
        return out

    cases = []

    def case(id_, description, segments, want_status, the_clock=clock, defn=d, transcript=t):
        entries = board([(seg, [transcript if p == "t" else p for p in ps]) for seg, ps in segments])
        ceremony_rows, _ = vc.expected(panel, defn, entries, panel, 4)
        assert ceremony_rows["3.2"] == outcome("pass"), id_
        # Step 1: opening version 2 is read, but opens other cores than
        # ballot version 1's (a profile 2.3 fails), so nothing is judged.
        pinned = dict(defn["profile"]["pins"]).get(OPENING_TYPE)
        if pinned == 2:
            row, report = NOT_REACHED, None
        else:
            assert pinned == 1, id_
            row, report = expected(defn, election, entries, the_clock)
        assert row["status"] == want_status, (id_, row)
        c = {
            "id": id_,
            "description": description,
            "panel": e["panel"],
            "definition": vc.dv.enc_definition(defn).hex(),
            "clock": {k: str(v) for k, v in the_clock.items()},
            "board": b"".join(entries).hex(),
            "expected": {"2.3": vc.combination(defn), "6.2": row},
        }
        if report is not None:
            c["openings"] = report
        cases.append(c)
        return c

    mixed = case(
        "mixed",
        "Close falls in period 2, so s_S is at least 3. A ballot in segment 0 (counted whatever s_S is) and one in segment 4 (counted only if s_S ≥ 4); an honest opening in segment 3 (early); in segment 5 an opening of every check failure, one that doesn't decode, an honest one, one of a vote outside the rules, and two that re-use one ballot's (v_j, r_j) under other share hashes: the segment-0 ballot's (cast) and the segment-4 ballot's (undecided); in segment 6 a byte-identical copy of the honest one and of the stray one, and in segment 7 a third copy of the honest one (repeats, each of the first). The honest openings above the floor may still be early or late once s_S is known, so 6.2 is unverifiable.",
        [
            (0, ["t", rec0]),
            (3, [enc(early)]),
            (4, [rec2]),
            (5, [enc(honest), enc(cast0), enc(cast2), enc(outside), enc(stray), enc(tier), enc(shape), enc(unqualified), enc(vss_bad), enc(ciphertext), trailing]),
            (6, [enc(honest), enc(stray)]),
            (7, [enc(honest)]),
        ],
        "unverifiable",
    )
    codes = {o.get("code") for o in mixed["openings"]}
    assert codes == {None, "decode", "opening-stray", "opening-tier", "opening-shape", "opening-unqualified", "opening-vss", "opening-ciphertext"}, codes
    breaks = {b["code"] for o in mixed["openings"] for b in o["breaks"]}
    assert breaks == {"opening-early", "opening-cast", "opening-repeat"}, breaks
    assert any(o.get("voteOutside") for o in mixed["openings"])

    case(
        "settled",
        "Every opening breaks a rule the floor decides: an honest one in segment 3 (early), one re-using the segment-0 ballot's commitment (cast), one failing opening-vss, and a copy of the cast one (repeat). 6.2 fails at the first, opening-early.",
        [(0, ["t", rec0]), (3, [enc(early)]), (5, [enc(cast0), enc(vss_bad)]), (6, [enc(cast0)])],
        "fail",
    )
    case(
        "decode-first",
        "The first settled opening doesn't decode (a trailing byte): 6.2 fails with decode and its decoding code.",
        [(0, ["t", rec0]), (5, [trailing, enc(stray)])],
        "fail",
    )
    case(
        "honest",
        "Only honest openings above the floor, opening no ballot on the copy: undecided until s_S is known, so 6.2 is unverifiable.",
        [(0, ["t", rec0]), (4, [rec2]), (5, [enc(honest), enc(honest2)])],
        "unverifiable",
    )
    case(
        "cast-above-floor",
        "An opening that re-uses the commitment of a ballot in segment 4, above the floor: whether that ballot is counted needs s_S, so no break is reported and 6.2 is unverifiable.",
        [(0, ["t", rec0]), (4, [rec2]), (5, [enc(cast2)])],
        "unverifiable",
    )
    case(
        "cast-at-floor",
        "An opening that re-uses the commitment of a ballot in segment 3, the floor itself (client rule 1 lets a ballot cast in close's period carry it): counted whatever s_S is, so the opening is cast and 6.2 fails.",
        [(0, ["t", rec0]), (3, [rec2]), (5, [enc(cast2)])],
        "fail",
    )
    case("none", "Ballots and no opening: 6.2 passes.", [(0, ["t", rec0]), (4, [rec2])], "pass")
    # A close before the clock's epoch puts the floor below 0, so no segment is early.
    case(
        "close-before-epoch",
        "The same board as settled under a clock whose epoch is after close: the floor is below 0, so nothing is early or counted by it, and only the repeat and the failing check settle their openings.",
        [(0, ["t", rec0]), (3, [enc(early)]), (5, [enc(cast0), enc(vss_bad)]), (6, [enc(cast0)])],
        "unverifiable",
        the_clock=dict(clock, epoch=d["closes_at"] + 10 * PERIOD),
    )

    # An opening version this verifier reads, but not beside ballot version 1.
    fields = {k: d[k] for k in ("profile", "electorate", "membership_vk_hash")}
    fields["profile"] = dict(d["profile"], pins=[(ty, 2 if ty == OPENING_TYPE else v) for ty, v in d["profile"]["pins"]])
    ctx = vc.election_of(vc.definition_for(panel, bytes(32), **fields))
    t2 = vc.transcript("verifier-openings/opening-v2", panel, src["registered"], ctx)
    d2 = vc.definition_for(panel, vb.H(vb.ds(vc.TRANSCRIPT_TAG, t2)), **fields)
    assert vc.dv.definition_rule(d2) is None
    case("opening-v2", "The profile pins spoiled-ballot opening version 2 beside ballot version 1, whose cores only opening version 1 opens: 2.3 fails, and 6.2 is not reached, since no opening is judged against an election it can't open the ballots of.", [(0, ["t"])], "unverifiable", defn=d2, transcript=t2)

    doc = {
        "format": "abolish-verifier-openings-vectors/1",
        "title": "The verifier's spoiled-ballot openings: definitions, clocks, boards and pinned panels, with the row 6.2 and the report's openings",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-openings-vectors.py, from verifier-ballots-vectors.py, verifier-ceremony-vectors.py "
            "and challenge-vectors.py (independent Python implementations); the ballot records are verifier-ballots.json's"
        ),
        "panels": {e["panel"]: {"threshold": str(panel["k"]), "keys": [k.hex() for k in panel["keys"]]}},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-openings.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: verifier-openings-vectors.py <constants> <out-dir>")
    main(sys.argv[1], sys.argv[2])
