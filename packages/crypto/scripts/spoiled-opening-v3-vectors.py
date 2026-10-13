#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/spoiled-opening-v3.json.

A second implementation of docs/spec/challenge.md, Opening version 3: the
spoiled-ballot opening record (0x0003) at version 3, which opens a core of
ballot version 4 split between the default panel and, when the definition has
one, an author panel; its strict decoding; its checks over both halves in
order (default half first); the vote and randomness a passing opening gives;
and what a published opening opens, for version-4 ballots' commitments and
for either half's constant term. It is written from the spec with Python's
integers and hashlib and shares no code with packages/crypto or any @noble
library. It reuses only this folder's other independent generators:
share-encryption-v4-vectors.py's version-4 ciphertexts (over
share-encryption-vectors.py's self-checked ML-KEM-768, ChaCha20-Poly1305 and
ristretto255), ballot-v4-vectors.py's core hash and ballot-v3-vectors.py's
encodings and per-question rules, with definition-v6-vectors.py's definitions.

Every secret comes from SHA-512 or SHA-256 over a fixed label. The author
panel's KEM keys are test keys: its ceremony is P2-16 part 3's. The values are
test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/spoiled-opening-v3-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import copy
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


sev4 = _load("share_encryption_v4_vectors", "share-encryption-v4-vectors.py")
se, bv, grp, b4 = sev4.se, sev4.bv, sev4.grp, sev4.b4
b3, d6 = b4.b3, b4.d6

L = grp.L
G = grp.BASE
HGEN = bv.Hgen
IDENTITY = grp.IDENTITY
OPENING = 0x0003
VERSION = 3
DEFAULT, AUTHOR = sev4.DEFAULT, sev4.AUTHOR
PANEL_NAMES = {DEFAULT: "default", AUTHOR: "author"}

u8, u16, u32, scalar, hexs = bv.u8, bv.u16, bv.u32, bv.scalar, b3.hexs


def det(label):
    return hashlib.sha256(b"abolish spoiled-opening-v3 vectors " + label.encode()).digest()


# --- Elections (definition version 6) ----------------------------------------------


def election(label, questions, k, n, k_a, n_a, registered, author_registered):
    """A definition version 6 naming the published membership key, so an implementation can make its ballot context from it."""
    author = (
        {"author_threshold": k_a, "author_keys": d6.AUTHOR_KEYS[:n_a], "author_transcript_hash": det("author transcript " + label)}
        if n_a
        else dict(d6.NO_AUTHOR)
    )
    d = d6.variant(
        d6.TYPICAL,
        profile={"protocol_major": 1, "pins": b4.PINS_V6},
        election_id=det("election " + label),
        questions=[d6.d5.q(*x) for x in questions],
        membership_vk_hash=b3.MEMBERSHIP_VK_HASH,
        threshold=k,
        panel_size=n,
        ceremony_transcript_hash=det("transcript " + label),
        **d6.SEALED_EVERYDAY,
        **author,
    )
    assert d6.definition_rule(d) is None, (label, d6.definition_rule(d))
    enc = d6.enc_definition_v6(d)
    qs = [{"optionCount": m, "min": lo, "max": hi} for m, lo, hi in questions]
    offsets, o = [], 0
    for q in qs:
        offsets.append(o)
        o += q["optionCount"]
    return {
        "label": label,
        "encoding": enc,
        "definitionHash": b3.H(b3.ds(b3.DEFINITION_TAG, enc)),
        "questions": qs,
        "offsets": offsets,
        "optionTotal": o,
        "threshold": k,
        "panelSize": n,
        "authorThreshold": k_a,
        "authorPanelSize": n_a,
        "cells": b3.cells_of(d),
        "registered": {DEFAULT: list(registered), AUTHOR: list(author_registered)},
    }


def election_json(e, panels):
    return {
        "definition": hexs(e["encoding"]),
        "definitionHash": hexs(e["definitionHash"]),
        "definitionVersion": 6,
        "ballotVersion": 4,
        "questions": [
            {"optionCount": q["optionCount"], "minSelections": q["min"], "maxSelections": q["max"], "offset": o}
            for q, o in zip(e["questions"], e["offsets"])
        ],
        "optionTotal": e["optionTotal"],
        "threshold": e["threshold"],
        "panelSize": e["panelSize"],
        "authorThreshold": e["authorThreshold"],
        "authorPanelSize": e["authorPanelSize"],
        "cells": e["cells"],
        "panel": panels[DEFAULT],
        "authorPanel": panels[AUTHOR],
        "registered": e["registered"][DEFAULT],
        "authorRegistered": e["registered"][AUTHOR],
    }


# --- Record (challenge.md, Opening version 3) -------------------------------------


def enc_polynomials(polys):
    out = u32(len(polys))
    for p in polys:
        out += u32(len(p["f"])) + b"".join(scalar(c) for c in p["f"])
        out += u32(len(p["g"])) + b"".join(scalar(c) for c in p["g"])
    return out


def enc_seats(seats):
    return u32(len(seats)) + b"".join(u8(s["seat"]) + s["m"] + scalar(s["e"]) + scalar(s["w"]) for s in seats)


def enc_opening(o, version=VERSION):
    """Version 2's core fields, the author half's, then each half's polynomials and seat randomness."""
    out = u16(OPENING) + u8(version) + o["definitionHash"] + u8(o["cell"])
    out += bv.enc_vss(o["vss"]) + bv.enc_share_hashes(o["shareHashes"])
    out += bv.enc_vss(o["authorVss"]) + bv.enc_share_hashes(o["authorShareHashes"])
    out += enc_polynomials(o["polynomials"]) + enc_polynomials(o["authorPolynomials"])
    out += enc_seats(o["seats"]) + enc_seats(o["authorSeats"])
    return out


def core_hash(o):
    """Ballot version 4's core hash (ballot-validity.md, Hashes (version 4))."""
    return b4.core_hash({"definitionHash": o["definitionHash"], "cell": o["cell"]}, o)


# --- Checks -------------------------------------------------------------------------


HALF_FIELDS = {
    DEFAULT: ("vss", "shareHashes", "polynomials", "seats"),
    AUTHOR: ("authorVss", "authorShareHashes", "authorPolynomials", "authorSeats"),
}


def half(e, o, panel):
    vss, hashes, polys, seats = (o[f] for f in HALF_FIELDS[panel])
    k = e["threshold"] if panel == DEFAULT else e["authorThreshold"]
    n = e["panelSize"] if panel == DEFAULT else e["authorPanelSize"]
    m = 0 if panel == AUTHOR and e["authorPanelSize"] == 0 else e["optionTotal"]
    return vss, hashes, polys, seats, k, n, m, sorted(e["registered"][panel])


def check_opening(e, o, keys):
    """The checks in order; ("ok", coreHash, votes, randomness, outside) or (code, option, seat, panel)."""
    if o["definitionHash"] != e["definitionHash"]:
        return ("opening-stray", None, None, None)
    if o["cell"] >= e["cells"]:
        return ("opening-cell", None, None, None)
    for panel in (DEFAULT, AUTHOR):
        vss, hashes, polys, seats, k, n, m, reg = half(e, o, panel)
        if not (
            len(vss) == m
            and all(len(row) == k for row in vss)
            and len(hashes) == n
            and len(polys) == m
            and all(len(p["f"]) == k and len(p["g"]) == k for p in polys)
            and [s["seat"] for s in seats] == reg
        ):
            return ("opening-shape", None, None, None)
    for panel in (DEFAULT, AUTHOR):
        _, hashes, _, _, _, n, _, reg = half(e, o, panel)
        if any(seat not in reg and hashes[seat - 1] != bytes(32) for seat in range(1, n + 1)):
            return ("opening-unqualified", None, None, None)
    for panel in (DEFAULT, AUTHOR):
        vss, _, polys, _, k, _, _, _ = half(e, o, panel)
        for j, (row, p) in enumerate(zip(vss, polys)):
            if not all(grp.equal(bv.pedersen(p["f"][t], p["g"][t]), row[t]) for t in range(k)):
                return ("opening-vss", j, None, panel)
    both = {"vss": o["vss"], "authorVss": o["authorVss"]}
    for panel in (DEFAULT, AUTHOR):
        _, hashes, polys, seats, _, _, _, _ = half(e, o, panel)
        for s in seats:
            i = s["seat"]
            if s["e"] == 0 or s["w"] == 0:
                return ("opening-ciphertext", None, i, panel)
            shares = [{"v": bv.evaluate(p["f"], i), "r": bv.evaluate(p["g"], i)} for p in polys]
            ct, _ = sev4.encrypt(e["definitionHash"], panel, i, keys[panel][i - 1], both, bv.enc_shares(shares), s["m"], s["e"], s["w"])
            if se.share_hash(ct) != hashes[i - 1]:
                return ("opening-ciphertext", None, i, panel)
    votes, rand = vote_and_randomness(o)
    return ("ok", core_hash(o), votes, rand, b3.outside_question(e, votes))


def vote_and_randomness(o):
    """v_j = coef_0(f^D_j) + coef_0(f^A_j) and r_j = coef_0(g^D_j) + coef_0(g^A_j), each author term 0 without an author half."""
    votes, rand = [], []
    for j, p in enumerate(o["polynomials"]):
        a = o["authorPolynomials"][j] if o["authorPolynomials"] else {"f": [0], "g": [0]}
        votes.append((p["f"][0] + a["f"][0]) % L)
        rand.append((p["g"][0] + a["g"][0]) % L)
    return votes, rand


# --- Opened commitments (challenge.md, Opening version 3, Opened commitments) -------


def opened(o):
    """(has, halves): the encodings the opening opens as a ballot's C', and those it opens as a half's constant term."""
    products = []
    for j, row in enumerate(o["vss"]):
        c = row[0]
        if o["authorVss"]:
            c = grp.add(c, o["authorVss"][j][0])
        products.append(grp.encode(c))
    revealed = set()
    for polys, n in ((o["polynomials"], len(o["shareHashes"])), (o["authorPolynomials"], len(o["authorShareHashes"]))):
        for p in polys:
            for poly in (p["f"], p["g"]):
                revealed.update(poly)
                revealed.update(bv.evaluate(poly, i) for i in range(1, n + 1))
    for s in o["seats"] + o["authorSeats"]:
        revealed.update((s["e"], s["w"]))
    votes, rand = vote_and_randomness(o)
    revealed.update(votes)
    revealed.update(rand)
    revealed -= {0, 1}
    has = set(products)
    for s in revealed:
        hs = grp.mul(s, HGEN)
        has.add(grp.encode(hs))
        has.add(grp.encode(grp.add(hs, G)))
    halves = set(products)
    for row in o["vss"] + o["authorVss"]:
        halves.update(grp.encode(x) for x in row)
    return has, halves


def opens(o, ballot):
    if ballot["definitionHash"] != o["definitionHash"]:
        return False
    has, halves = opened(o)
    for j, row in enumerate(ballot["vss"]):
        d = row[0]
        a = ballot["authorVss"][j][0] if ballot["authorVss"] else IDENTITY
        if grp.encode(grp.add(d, a)) in has or grp.encode(d) in halves:
            return True
        if ballot["authorVss"] and grp.encode(a) in halves:
            return True
    return False


# --- Openings ------------------------------------------------------------------------


def make_opening(label, e, keys, cell, votes, bind=None):
    """An honest client's opening of a version-4 core for the flat `votes`, whatever they are; `bind(panel, seat)` may name another panel for a seat's ciphertext binding."""
    rng = bv.Rng("opening-v3/" + label)
    k, k_a, n_a = e["threshold"], e["authorThreshold"], e["authorPanelSize"]
    default, author = [], []
    for v in votes:
        r = rng.scalar()
        a, s = (rng.scalar(), rng.scalar()) if n_a else (0, 0)
        default.append({"f": [(v - a) % L] + [rng.scalar() for _ in range(k - 1)], "g": [(r - s) % L] + [rng.scalar() for _ in range(k - 1)]})
        if n_a:
            author.append({"f": [a] + [rng.scalar() for _ in range(k_a - 1)], "g": [s] + [rng.scalar() for _ in range(k_a - 1)]})
    vss = [[bv.pedersen(p["f"][t], p["g"][t]) for t in range(k)] for p in default]
    avss = [[bv.pedersen(p["f"][t], p["g"][t]) for t in range(k_a)] for p in author]
    assert all(not grp.equal(x, IDENTITY) for row in vss + avss for x in row)
    both = {"vss": vss, "authorVss": avss}
    hashes, seats, encapsulation = {}, {}, {}
    for panel, polys, n in ((DEFAULT, default, e["panelSize"]), (AUTHOR, author, n_a)):
        hashes[panel], seats[panel], encapsulation[panel] = [], [], []
        for seat in range(1, n + 1):
            m, ee, w = rng.bytes32(), se.nonzero_scalar(rng), se.nonzero_scalar(rng)
            encapsulation[panel].append({"m": m.hex(), "e": str(ee), "w": str(w)})
            if seat not in e["registered"][panel]:
                hashes[panel].append(bytes(32))
                continue
            shares = [{"v": bv.evaluate(p["f"], seat), "r": bv.evaluate(p["g"], seat)} for p in polys]
            bound = panel if bind is None else bind(panel, seat)
            ct, _ = sev4.encrypt(e["definitionHash"], bound, seat, keys[panel][seat - 1], both, bv.enc_shares(shares), m, ee, w)
            hashes[panel].append(se.share_hash(ct))
            seats[panel].append({"seat": seat, "m": m, "e": ee, "w": w})
    opening = {
        "definitionHash": e["definitionHash"],
        "cell": cell,
        "vss": vss,
        "shareHashes": hashes[DEFAULT],
        "authorVss": avss,
        "authorShareHashes": hashes[AUTHOR],
        "polynomials": default,
        "authorPolynomials": author,
        "seats": seats[DEFAULT],
        "authorSeats": seats[AUTHOR],
    }
    poly = lambda p: {"f": [str(x) for x in p["f"]], "g": [str(x) for x in p["g"]]}  # noqa: E731
    randomness = {
        "polynomials": [poly(p) for p in default],
        "authorPolynomials": [poly(p) for p in author],
        "encapsulation": encapsulation[DEFAULT],
        "authorEncapsulation": encapsulation[AUTHOR],
    }
    return opening, randomness


def main():
    grp.self_check()
    se.aead_self_check()
    se.mlkem_self_check(10000 if "--full" in sys.argv[2:] else 100)
    out = pathlib.Path(sys.argv[1])

    key_sets = {
        "default-4": se.trustee_keys("opening-v3-default-4", 4),
        "author-3": se.trustee_keys("opening-v3-author-3", 3),
        "default-3": se.trustee_keys("opening-v3-default-3", 3),
        "author-2": se.trustee_keys("opening-v3-author-2", 2),
    }
    elections = {
        el["label"]: (el, panels)
        for el, panels in (
            # Default seat 3 and author seat 2 are outside their panels' registered key sets.
            (election("author", [(3, 0, 1), (2, 0, 2)], 3, 4, 2, 3, [1, 2, 4], [1, 3]), {DEFAULT: "default-4", AUTHOR: "author-3"}),
            (election("no-author", [(4, 1, 2)], 2, 3, 0, 0, [1, 2, 3], []), {DEFAULT: "default-3", AUTHOR: None}),
            (election("author-k1", [(3, 0, 1)], 2, 3, 1, 2, [1, 2, 3], [1, 2]), {DEFAULT: "default-3", AUTHOR: "author-2"}),
            (election("author-other", [(3, 0, 1), (2, 0, 2)], 3, 4, 2, 3, [1, 2, 4], [1, 3]), {DEFAULT: "default-4", AUTHOR: "author-3"}),
        )
    }

    def keys_of(name):
        _, panels = elections[name]
        return {p: key_sets[panels[p]] if panels[p] else [] for p in (DEFAULT, AUTHOR)}

    openings = []
    honest = {}

    def add(id_, desc, name, o, randomness=None, expect="ok", option=None, seat=None, panel=None, question=None):
        e, _ = elections[name]
        got = check_opening(e, o, keys_of(name))
        entry = {"id": id_, "description": desc, "election": name, "encoding": hexs(enc_opening(o)), "coreHash": hexs(core_hash(o))}
        if randomness is not None:
            entry["randomness"] = randomness
        if got[0] == "ok":
            assert expect == "ok", (id_, got)
            assert got[1] == core_hash(o)
            entry["result"] = "ok"
            entry["votes"] = [str(v) for v in got[2]]
            entry["voteRandomness"] = [str(r) for r in got[3]]
            assert got[4] == question, (id_, got[4], question)
            if got[4] is not None:
                entry["voteOutside"] = {"question": got[4]}
        else:
            assert (got[0], got[1], got[2], got[3]) == (expect, option, seat, panel), (id_, got)
            entry["result"] = got[0]
            for key, value in (("option", option), ("seat", seat), ("panel", panel)):
                if value is not None:
                    entry[key] = value
        openings.append(entry)

    def opening(id_, desc, name, cell, votes, question=None, bind=None, expect="ok", seat=None, panel=None):
        e, _ = elections[name]
        o, r = make_opening(id_, e, keys_of(name), cell, votes, bind)
        honest[id_] = o
        add(id_, desc, name, o, r, expect=expect, seat=seat, panel=panel, question=question)

    sizes = [3, 2]
    flat = lambda *picked: b3.flat(zip(sizes, picked))  # noqa: E731
    opening("author", "An author panel of k_A = 2, n_A = 3 (seat 2 unregistered) beside k_D = 3, n_D = 4 (seat 3 unregistered), two questions, cell 1", "author", 1, flat({1}, {0, 1}))
    opening("author-blank", "Every question at its least, in the last cell", "author", 2, flat(set(), set()))
    opening("no-author", "No author panel: every author list empty, the default half's constant terms the vote and r_j", "no-author", 0, b3.flat(zip([4], [{0, 3}])))
    opening("author-k1", "k_A = 1, n_A = 2: each author seat's shares are the author half's constant terms", "author-k1", 0, b3.flat(zip([3], [{2}])))
    opening("author-over-vote", "Two options of question 0 (pick one): passes, outside the rules at question 0", "author", 0, flat({0, 2}, {1}), question=0)
    votes = flat({0}, set())
    votes[4] = 2
    opening("author-vote-two", "A vote of 2 at flat option 4 (question 1's option 1): within question 1's limit of 2 by count, outside since a vote is 0 or 1", "author", 0, votes, question=1)
    opening("no-author-under", "Ballot with no author panel and one option of a pick-1-to-2 question left blank: outside at question 0", "no-author", 0, [0, 0, 0, 0], question=0)
    opening(
        "author-seat-bound-default",
        "Author seat 3's ciphertext bound to the default panel's seat 3: it hashes to the share hash, but isn't the one an author seat's rebuild makes",
        "author",
        0,
        flat({1}, {0}),
        bind=lambda panel, seat: DEFAULT if (panel, seat) == (AUTHOR, 3) else panel,
        expect="opening-ciphertext",
        seat=3,
        panel=AUTHOR,
    )

    base = honest["author"]
    plain = honest["no-author"]

    def variant(id_, desc, name, src, change, expect, option=None, seat=None, panel=None):
        o = copy.deepcopy(src)
        change(o)
        add(id_, desc, name, o, expect=expect, option=option, seat=seat, panel=panel)

    def set_(key, value):
        return lambda o: o.__setitem__(key, value)

    variant("stray", "The author poll's opening checked against another poll of the same shape", "author-other", base, lambda o: None, "opening-stray")
    cells = elections["author"][0]["cells"]
    variant("cell-past-partition", f"Cell {cells}, the first past the definition's {cells} cells", "author", base, set_("cell", cells), "opening-cell")
    variant("no-author-cell-255", "Cell 255", "no-author", plain, set_("cell", 255), "opening-cell")

    def author_row(o):
        o["authorVss"] = [row[:1] for row in o["vss"]]
        o["authorPolynomials"] = [{"f": p["f"][:1], "g": p["g"][:1]} for p in o["polynomials"]]

    variant("shape-author-without-panel", "Author commitments and polynomials in a poll without an author panel", "no-author", plain, author_row, "opening-shape")
    variant("shape-author-hashes-without-panel", "One author share hash in a poll without an author panel", "no-author", plain, lambda o: o["authorShareHashes"].append(bytes(32)), "opening-shape")
    variant("shape-author-polynomial", "Flat option 4's author g has k_A + 1 coefficients", "author", base, lambda o: o["authorPolynomials"][4]["g"].append(3), "opening-shape")
    variant("shape-author-vss-short", "author_vss and author_polynomials with T − 1 options", "author", base, lambda o: (o["authorVss"].pop(), o["authorPolynomials"].pop()), "opening-shape")
    variant("shape-author-seats-missing", "author_seats without author seat 3", "author", base, lambda o: o["authorSeats"].pop(), "opening-shape")
    variant(
        "shape-author-unregistered-seat",
        "Randomness for author seat 2, outside the author panel's registered key set",
        "author",
        base,
        lambda o: o["authorSeats"].insert(1, {"seat": 2, "m": det("m"), "e": 5, "w": 7}),
        "opening-shape",
    )
    variant("shape-author-hashes-short", "author_share_hashes with n_A − 1 entries", "author", base, lambda o: o["authorShareHashes"].pop(), "opening-shape")
    variant("shape-default-polynomial", "Flat option 0's default f with k_D − 1 coefficients", "author", base, lambda o: o["polynomials"][0]["f"].pop(), "opening-shape")

    def swap_halves(o):
        o["vss"], o["authorVss"] = o["authorVss"], o["vss"]

    variant("shape-halves-swapped", "The halves' commitments swapped: k_A = 2 rows where k_D = 3 are expected", "author", base, swap_halves, "opening-shape")
    variant("unqualified-author", "Author seat 2, outside its panel's registered key set, has a share hash other than zero", "author", base, lambda o: o["authorShareHashes"].__setitem__(1, det("chosen")), "opening-unqualified")
    variant("unqualified-default", "Default seat 3, outside its registered key set, has a share hash other than zero", "author", base, lambda o: o["shareHashes"].__setitem__(2, det("chosen")), "opening-unqualified")

    def claim_other(o):
        # Question 0's opening claims option 2 where the core commits to option 1, in the author half.
        o["authorPolynomials"][1]["f"][0] = (o["authorPolynomials"][1]["f"][0] - 1) % L
        o["authorPolynomials"][2]["f"][0] = (o["authorPolynomials"][2]["f"][0] + 1) % L

    variant("vss-author-other-vote", "The author half claims question 0's option 2 over a core committing to option 1: flat option 1 fails in the author half", "author", base, claim_other, "opening-vss", option=1, panel=AUTHOR)
    variant("vss-default-last", "The default half's flat option 4 with r − s plus 1", "author", base, lambda o: o["polynomials"][4]["g"].__setitem__(0, (o["polynomials"][4]["g"][0] + 1) % L), "opening-vss", option=4, panel=DEFAULT)

    def both_fail(o):
        o["authorPolynomials"][0]["g"][1] = (o["authorPolynomials"][0]["g"][1] + 1) % L
        o["polynomials"][3]["f"][2] = (o["polynomials"][3]["f"][2] + 1) % L

    variant("vss-default-before-author", "The author half fails at flat option 0 and the default half at option 3: the default half is checked first", "author", base, both_fail, "opening-vss", option=3, panel=DEFAULT)

    def move_split(o):
        # The same vote, split otherwise: the constant terms still add to v_j and r_j, but neither half's commitment opens.
        p, a = o["polynomials"][0], o["authorPolynomials"][0]
        p["f"][0], a["f"][0] = (p["f"][0] + 5) % L, (a["f"][0] - 5) % L

    variant("vss-split-moved", "Flat option 0's split moved by 5 between the halves: the sum is the vote, but the default half no longer opens", "author", base, move_split, "opening-vss", option=0, panel=DEFAULT)
    variant("no-author-vss", "No author panel: flat option 2's v plus 1", "no-author", plain, lambda o: o["polynomials"][2]["f"].__setitem__(0, (o["polynomials"][2]["f"][0] + 1) % L), "opening-vss", option=2, panel=DEFAULT)

    def flip_m(seats, i):
        return lambda o: o[seats][i].__setitem__("m", bytes([o[seats][i]["m"][0] ^ 1]) + o[seats][i]["m"][1:])

    variant("ciphertext-author-m", "Author seat 3's ML-KEM message with a byte flipped", "author", base, flip_m("authorSeats", 1), "opening-ciphertext", seat=3, panel=AUTHOR)
    variant("ciphertext-default-e", "Default seat 4's ephemeral plus 1", "author", base, lambda o: o["seats"][2].__setitem__("e", (o["seats"][2]["e"] + 1) % L), "opening-ciphertext", seat=4, panel=DEFAULT)
    variant("ciphertext-author-e-zero", "Author seat 1's ephemeral 0", "author", base, lambda o: o["authorSeats"][0].__setitem__("e", 0), "opening-ciphertext", seat=1, panel=AUTHOR)
    variant("ciphertext-default-w-zero", "Default seat 1's proof nonce 0", "author", base, lambda o: o["seats"][0].__setitem__("w", 0), "opening-ciphertext", seat=1, panel=DEFAULT)

    def cross_randomness(o):
        o["seats"][0] = dict(o["authorSeats"][0])

    variant("ciphertext-randomness-crossed", "Default seat 1 given author seat 1's randomness", "author", base, cross_randomness, "opening-ciphertext", seat=1, panel=DEFAULT)

    def both_seats(o):
        flip_m("authorSeats", 0)(o)
        flip_m("seats", 1)(o)

    variant("ciphertext-default-before-author", "Author seat 1 and default seat 2 both fail: the default seat is reported", "author", base, both_seats, "opening-ciphertext", seat=2, panel=DEFAULT)
    variant("no-author-ciphertext-m", "No author panel: default seat 2's ML-KEM message with a byte flipped", "no-author", plain, flip_m("seats", 1), "opening-ciphertext", seat=2, panel=DEFAULT)
    variant(
        "order-vss-before-ciphertext",
        "A changed author coefficient at flat option 3 and a changed default seat ephemeral: vss first",
        "author",
        base,
        lambda o: (o["authorPolynomials"][3]["f"].__setitem__(1, 1), o["seats"][0].__setitem__("e", 9)),
        "opening-vss",
        option=3,
        panel=AUTHOR,
    )
    variant("order-cell-before-shape", "A cell past the partition and author lists without an author seat: cell first", "author", base, lambda o: (o.__setitem__("cell", cells), o["authorSeats"].pop()), "opening-cell")
    variant("order-shape-before-unqualified", "An author seat missing and a non-zero unregistered default share hash: shape first", "author", base, lambda o: (o["authorSeats"].pop(), o["shareHashes"].__setitem__(2, det("chosen"))), "opening-shape")

    # Decoding (challenge.md, Opening version 3: version 2's, field by field).
    enc = enc_opening(base)
    a_vss_at = 36 + len(bv.enc_vss(base["vss"])) + len(bv.enc_share_hashes(base["shareHashes"]))
    a_first = a_vss_at + 4 + 4
    polys_at = a_vss_at + len(bv.enc_vss(base["authorVss"])) + len(bv.enc_share_hashes(base["authorShareHashes"]))
    a_polys_at = polys_at + len(enc_polynomials(base["polynomials"]))
    a_coef = a_polys_at + 4 + 4
    assert enc[a_first : a_first + 32] == bv.element(base["authorVss"][0][0])
    assert enc[a_coef : a_coef + 32] == scalar(base["authorPolynomials"][0]["f"][0])
    a_seats_at = len(enc) - len(enc_seats(base["authorSeats"]))
    a_e = a_seats_at + 4 + 1 + 32
    assert enc[a_e : a_e + 32] == scalar(base["authorSeats"][0]["e"])
    decode = [
        {"id": "truncated", "description": "The opening without its last byte", "encoding": hexs(enc[:-1]), "error": "truncated"},
        {"id": "trailing-byte", "description": "A byte after the last author seat", "encoding": hexs(enc + b"\x00"), "error": "trailing-bytes", "offset": len(enc)},
        {"id": "author-vss-identity", "description": "The author half's first VSS commitment the identity", "encoding": hexs(enc[:a_first] + bytes(32) + enc[a_first + 32 :]), "error": "non-canonical", "offset": a_first},
        {"id": "author-coefficient-l", "description": "Flat option 0's a_0 equal to ℓ", "encoding": hexs(enc[:a_coef] + b3.scalar(L) + enc[a_coef + 32 :]), "error": "non-canonical", "offset": a_coef},
        {"id": "author-seat-e-l", "description": "Author seat 1's e equal to ℓ", "encoding": hexs(enc[:a_e] + b3.scalar(L) + enc[a_e + 32 :]), "error": "non-canonical", "offset": a_e},
        {"id": "version-2", "description": "The same bytes under version 2, which a profile pinning version 3 doesn't read", "encoding": hexs(enc[:2] + b"\x02" + enc[3:]), "error": "profile-mismatch", "offset": 2},
    ]
    decoded_cells = [
        {"id": "cell-255-decodes", "description": "Cell 255 decodes (any u8), and is refused by opening-cell", "encoding": hexs(enc[:35] + b"\xff" + enc[36:]), "cell": 255},
    ]

    # What a published opening opens (Opened commitments): version-4 ballots'
    # cores beside honest openings, each with its own verdict.
    opened_vectors = []

    def element_hex(p):
        return grp.encode(p).hex()

    def ballot_case(id_, desc, opening_id, vss, author_vss, definition_hash=None, expect=None):
        o = honest[opening_id]
        ballot = {"definitionHash": definition_hash or o["definitionHash"], "vss": vss, "authorVss": author_vss}
        got = opens(o, ballot)
        assert expect is None or got == expect, (id_, got, expect)
        opened_vectors.append(
            {
                "id": id_,
                "description": desc,
                "opening": opening_id,
                "definitionHash": hexs(ballot["definitionHash"]),
                "vss": [[element_hex(x) for x in row] for row in vss],
                "authorVss": [[element_hex(x) for x in row] for row in author_vss],
                "opens": got,
            }
        )

    rng = bv.Rng("opening-v3/opened")
    fresh = lambda: bv.pedersen(rng.scalar(), rng.scalar())  # noqa: E731
    T = elections["author"][0]["optionTotal"]

    def halves(default_first=None, author_first=None, at=0, count=T, author=True):
        d = [[fresh(), fresh(), fresh()] for _ in range(count)]
        a = [[fresh(), fresh()] for _ in range(count)] if author else []
        if default_first is not None:
            d[at][0] = default_first
        if author_first is not None:
            a[at][0] = author_first
        return d, a

    o = base
    _, rand = vote_and_randomness(o)
    products = [grp.add(o["vss"][j][0], o["authorVss"][j][0]) for j in range(T)]

    def ballot_with_product(c, at=2):
        # A ballot whose C'_{at} is c: a fresh author half, and the default half's constant term c minus it.
        d, a = halves(at=at)
        d[at][0] = grp.add(c, grp.neg(a[at][0]))
        return d, a

    ballot_case("fresh", "A version-4 ballot with fresh halves", "author", *halves(), expect=False)
    ballot_case("same-core", "The opened core cast: its C_j", "author", o["vss"], o["authorVss"], expect=True)
    ballot_case("other-election", "The opened core under another definition hash", "author", o["vss"], o["authorVss"], definition_hash=det("other"), expect=False)
    ballot_case("product-reused", "C'_2 is the opening's C_0, split otherwise between the halves", "author", *ballot_with_product(products[0]), expect=True)
    ballot_case("default-half-is-author-vss", "The ballot's default half's constant term at option 3 is the opening's author E^A_{1,1}", "author", *halves(default_first=o["authorVss"][1][1], at=3), expect=True)
    ballot_case("author-half-is-default-constant", "The ballot's author half's constant term is the opening's E^D_{4,0}", "author", *halves(author_first=o["vss"][4][0], at=1), expect=True)
    ballot_case("author-half-is-product", "The ballot's author half's constant term is the opening's C_2", "author", *halves(author_first=products[2], at=0), expect=True)
    ballot_case("default-half-is-default-higher", "The ballot's default half's constant term is the opening's E^D_{0,2}", "author", *halves(default_first=o["vss"][0][2], at=4), expect=True)
    ballot_case("product-randomness-r", "C'_1 = g · h^{r_0}, r_0 the sum of both halves' randomness, a coefficient of neither", "author", *ballot_with_product(grp.add(G, grp.mul(rand[0], HGEN)), at=1), expect=True)
    ballot_case("product-author-share", "C'_0 = h^{g^A_3(1)}, author seat 1's randomness share at flat option 3", "author", *ballot_with_product(grp.mul(bv.evaluate(o["authorPolynomials"][3]["g"], 1), HGEN), at=0), expect=True)
    ballot_case("product-unregistered-author-share", "C'_0 = g · h^{f^A_0(2)}, unregistered author seat 2's share, which the opening reveals too", "author", *ballot_with_product(grp.add(G, grp.mul(bv.evaluate(o["authorPolynomials"][0]["f"], 2), HGEN)), at=0), expect=True)
    ballot_case("product-author-e", "C'_4 = h^{e}, author seat 3's ephemeral", "author", *ballot_with_product(grp.mul(o["authorSeats"][1]["e"], HGEN), at=4), expect=True)
    ballot_case("product-default-w", "C'_3 = g · h^{w}, default seat 4's proof nonce", "author", *ballot_with_product(grp.add(G, grp.mul(o["seats"][2]["w"], HGEN)), at=3), expect=True)
    ballot_case("product-h", "C'_0 = h: the scalar 1 is public, never matched", "author", *ballot_with_product(HGEN, at=0), expect=False)
    ballot_case("product-g", "C'_0 = g: the scalar 0 is public, never matched", "author", *ballot_with_product(G, at=0), expect=False)
    ballot_case("author-half-g-h-r", "The author half's constant term g · h^{r_0}: a half, not a C', so not matched (a residual the spec names)", "author", *halves(author_first=grp.add(G, grp.mul(rand[0], HGEN)), at=1), expect=False)
    two = honest["author-vote-two"]
    two_votes, _ = vote_and_randomness(two)
    assert two_votes[4] == 2
    ballot_case("product-vote-two", "C'_0 = h^{2}: an out-of-rules vote is a revealed scalar like any other", "author-vote-two", *ballot_with_product(grp.mul(2, HGEN), at=0), expect=True)
    p = plain
    ballot_case("no-author-same-core", "No author panel: the opened core cast", "no-author", p["vss"], [], expect=True)
    ballot_case("no-author-fresh", "No author panel: a fresh ballot", "no-author", *halves(count=4, author=False), expect=False)
    ballot_case("no-author-default-higher", "No author panel: a ballot whose constant term is the opening's E^D_{3,1}", "no-author", *halves(default_first=p["vss"][3][1], count=4, author=False, at=0), expect=True)

    data = {
        "format": "abolish-spoiled-opening-v3-vectors/1",
        "title": "Spoiled-ballot opening version 3: openings of ballot version 4's cores, both halves",
        "spec": "docs/spec/challenge.md",
        "generator": (
            "Printed by packages/crypto/scripts/spoiled-opening-v3-vectors.py, an implementation of docs/spec/challenge.md "
            "(Opening version 3) with Python's integers and hashlib, reusing share-encryption-v4-vectors.py's version-4 "
            "ciphertexts over share-encryption-vectors.py's self-checked ML-KEM-768, ChaCha20-Poly1305 and ristretto255, "
            "ballot-v4-vectors.py's core hash and the version-6 definition generator; nothing from packages/crypto. The "
            "randomness is SHA-512 of fixed labels: test data only."
        ),
        "recordType": "0x0003",
        "version": VERSION,
        "tag": b4.CORE_TAG.decode(),
        "panels": {
            "default": DEFAULT,
            "author": AUTHOR,
            "keys": {name: [{"seat": i + 1, **se.key_json(key)} for i, key in enumerate(keys)] for name, keys in key_sets.items()},
        },
        "elections": {name: election_json(e, panels) for name, (e, panels) in elections.items()},
        "openings": openings,
        "decode": decode,
        "decodedCells": decoded_cells,
        "opened": opened_vectors,
    }
    (out / "spoiled-opening-v3.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
