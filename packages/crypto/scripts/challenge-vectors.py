#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/challenge.json.

A second implementation of docs/spec/challenge.md: the core hash (the
tracking code), the spoiled-ballot opening record (0x0003, version 1) and its
checks, which rebuild every VSS commitment and every registered seat's share
ciphertext from the opening. It is written from the spec with Python's
integers and hashlib and shares no code with packages/crypto. It reuses only
this folder's other independent generators: share-encryption-vectors.py's
ML-KEM-768 (FIPS 203) and ChaCha20-Poly1305 (RFC 8439), each checked against
published vectors before use, its ciphertexts and trustee keys;
ballot-validity-vectors.py's ristretto255 and Pedersen code (over
group-vectors.py's self-checked RFC 9496 implementation); and
definition-vectors.py's election-definition encoder and well-formedness
rules. The cast ballots whose core hashes it lists are read from the frozen
ballot.json, and parsed here from their bytes.

Every random value comes from SHA-512 or SHA-256 over a fixed label, and each
opening lists the values that made it, so any implementation can reproduce
its bytes exactly. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/challenge-vectors.py <out-dir>,
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
VECTORS = HERE.parents[3] / "docs" / "spec" / "vectors"


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


se = _load("share_encryption_vectors", "share-encryption-vectors.py")
dv = _load("definition_vectors", "definition-vectors.py")
bv = se.bv
grp = se.grp

L = grp.L
G = grp.BASE
IDENTITY = grp.IDENTITY
MAX_OPTIONS = 64
MAX_TRUSTEES = 16
OPENING = 0x0003
CORE_TAG = b"abolish/v1/ballot-core"
DEFINITION_TAG = b"abolish/v1/election-definition"


def u8(x):
    return bv.u8(x)


def u16(x):
    return bv.u16(x)


def u32(x):
    return bv.u32(x)


def scalar(x):
    return x.to_bytes(32, "little")


def H(m):
    return hashlib.sha256(m).digest()


def ds(tag, m):
    return bytes([len(tag)]) + tag + m


# --- Core hash (ballot-validity.md, Core hash) ----------------------------------


def enc_core(definition_hash, tier, vss, share_hashes):
    """The core hash's input after the tag: definition, ballot type and version, tier, vss, share hashes."""
    return definition_hash + u16(0x0002) + u8(1) + u8(tier) + bv.enc_vss(vss) + bv.enc_share_hashes(share_hashes)


def core_hash(definition_hash, tier, vss, share_hashes):
    return H(ds(CORE_TAG, enc_core(definition_hash, tier, vss, share_hashes)))


def core_hash_of_ballot(record):
    """A cast ballot record's core hash, read at the record's fixed offsets (ballot-validity.md, Ballot record)."""
    assert record[:3] == u16(0x0002) + u8(1)
    definition_hash, tier = record[3:35], record[35]
    pos = 364
    m = int.from_bytes(record[pos : pos + 4], "big")
    pos += 4
    for _ in range(m):
        k = int.from_bytes(record[pos : pos + 4], "big")
        pos += 4 + 32 * k
    n = int.from_bytes(record[pos : pos + 4], "big")
    pos += 4 + 32 * n
    core_bytes = record[364:pos]
    return H(ds(CORE_TAG, definition_hash + u16(0x0002) + u8(1) + u8(tier) + core_bytes))


# --- Opening record (challenge.md, Spoiled-ballot opening record) ---------------


def enc_opening(o, version=1, record_type=OPENING):
    out = u16(record_type) + u8(version) + o["definitionHash"] + u8(o["tier"])
    out += bv.enc_vss(o["vss"]) + bv.enc_share_hashes(o["shareHashes"])
    out += u32(len(o["polynomials"]))
    for p in o["polynomials"]:
        out += u32(len(p["f"])) + b"".join(scalar(c) for c in p["f"])
        out += u32(len(p["g"])) + b"".join(scalar(c) for c in p["g"])
    out += u32(len(o["seats"]))
    for s in o["seats"]:
        out += u8(s["seat"]) + s["m"] + scalar(s["e"]) + scalar(s["w"])
    return out


# --- Checks (challenge.md, Checks) ---------------------------------------------


def evaluate(coeffs, x):
    return bv.evaluate(coeffs, x)


def check_opening(election, o):
    """The checks in order; returns ("ok", coreHash, votes, withinRules) or (code, option, seat)."""
    if o["definitionHash"] != election["definitionHash"]:
        return ("opening-stray", None, None)
    if o["tier"] not in election["tiers"]:
        return ("opening-tier", None, None)
    m, k, n = election["optionCount"], election["threshold"], election["panelSize"]
    reg = election["registered"]
    if not (
        len(o["vss"]) == m
        and all(len(e) == k for e in o["vss"])
        and len(o["shareHashes"]) == n
        and len(o["polynomials"]) == m
        and all(len(p["f"]) == k and len(p["g"]) == k for p in o["polynomials"])
        and [s["seat"] for s in o["seats"]] == sorted(reg)
    ):
        return ("opening-shape", None, None)
    for seat in range(1, n + 1):
        if seat not in reg and o["shareHashes"][seat - 1] != bytes(32):
            return ("opening-unqualified", None, None)
    for j, (row, p) in enumerate(zip(o["vss"], o["polynomials"])):
        for t in range(k):
            if not grp.equal(bv.pedersen(p["f"][t], p["g"][t]), row[t]):
                return ("opening-vss", j, None)
    for s in o["seats"]:
        i = s["seat"]
        if s["e"] == 0 or s["w"] == 0:
            return ("opening-ciphertext", None, i)
        shares = [{"v": evaluate(p["f"], i), "r": evaluate(p["g"], i)} for p in o["polynomials"]]
        ct, _ = se.encrypt(election["definitionHash"], i, election["keys"][i], o["vss"], bv.enc_shares(shares), s["m"], s["e"], s["w"])
        if se.share_hash(ct) != o["shareHashes"][i - 1]:
            return ("opening-ciphertext", None, i)
    votes = [p["f"][0] for p in o["polynomials"]]
    within = all(v in (0, 1) for v in votes) and election["min"] <= sum(votes) <= election["max"]
    return ("ok", core_hash(o["definitionHash"], o["tier"], o["vss"], o["shareHashes"]), votes, within)


# --- Elections -----------------------------------------------------------------


def det(label):
    return hashlib.sha256(b"abolish challenge vectors " + label.encode()).digest()


VK_HASH = bytes.fromhex(json.loads((VECTORS / "membership-proof.json").read_text())["verificationKey"]["hash"])
PINS = [(t, 4 if t == 7 else 1) for t in range(1, 10)]
KEYS = {
    "panel-3": se.trustee_keys("panel-3", 3),
    "panel-2": se.trustee_keys("panel-2", 2),
    "panel-16": se.trustee_keys("panel-16", 16),
    "challenge-panel-4": se.trustee_keys("challenge-panel-4", 4),
}


def election(label, election_type, m, lo, hi, k, n, tiers, panel, registered):
    d = dv.variant(
        dv.TYPICAL,
        profile={"protocol_major": 1, "pins": PINS},
        election_id=det("election " + label),
        election_type=election_type,
        option_count=m,
        min_selections=lo,
        max_selections=hi,
        electorate=[
            {"tier": t, "group_id": i + 1, "root": int.from_bytes(det(f"root {label} {t}"), "big") % bv.R, "root_l2_block": 1000, "group_size": 1000}
            for i, t in enumerate(tiers)
        ],
        membership_vk_hash=VK_HASH,
        threshold=k,
        panel_size=n,
        ceremony_transcript_hash=det("transcript " + label),
    )
    assert dv.definition_rule(d) is None, label
    enc = dv.enc_definition(d)
    keys = KEYS[panel]
    assert len(keys) == n
    return {
        "label": label,
        "encoding": enc,
        "definitionHash": H(ds(DEFINITION_TAG, enc)),
        "optionCount": m,
        "min": lo,
        "max": hi,
        "threshold": k,
        "panelSize": n,
        "tiers": tiers,
        "panel": panel,
        "registered": registered,
        # Seat number to key; only registered seats' keys are used.
        "keys": {i + 1: key for i, key in enumerate(keys)},
    }


# --- Openings, made as a client makes them --------------------------------------


def make_opening(label, e, tier, votes, cheat=None):
    """An honest client's core and opening for `votes`; `cheat(seat, shares)` may change what one seat's ciphertext seals."""
    rng = bv.Rng("challenge/" + label)
    k, n = e["threshold"], e["panelSize"]
    polys = []
    for v in votes:
        f = [v % L] + [rng.scalar() for _ in range(k - 1)]
        g = [rng.scalar() for _ in range(k)]
        polys.append({"f": f, "g": g})
    vss = [[bv.pedersen(p["f"][t], p["g"][t]) for t in range(k)] for p in polys]
    assert all(not grp.equal(x, IDENTITY) for row in vss for x in row)
    enc_rand = {}
    share_hashes = []
    for seat in range(1, n + 1):
        # Every seat draws, registered or not, as the client's encryption does.
        m, ee, w = rng.bytes32(), se.nonzero_scalar(rng), se.nonzero_scalar(rng)
        enc_rand[seat] = {"m": m, "e": ee, "w": w}
        if seat not in e["registered"]:
            share_hashes.append(bytes(32))
            continue
        shares = [{"v": bv.evaluate(p["f"], seat), "r": bv.evaluate(p["g"], seat)} for p in polys]
        if cheat is not None:
            shares = cheat(seat, shares)
        ct, _ = se.encrypt(e["definitionHash"], seat, e["keys"][seat], vss, bv.enc_shares(shares), m, ee, w)
        share_hashes.append(se.share_hash(ct))
    opening = {
        "definitionHash": e["definitionHash"],
        "tier": tier,
        "vss": vss,
        "shareHashes": share_hashes,
        "polynomials": polys,
        "seats": [{"seat": s, **enc_rand[s]} for s in sorted(e["registered"])],
    }
    randomness = {
        "polynomials": [{"f": [str(x) for x in p["f"]], "g": [str(x) for x in p["g"]]} for p in polys],
        "encapsulation": [{"m": enc_rand[s]["m"].hex(), "e": str(enc_rand[s]["e"]), "w": str(enc_rand[s]["w"])} for s in range(1, n + 1)],
    }
    return opening, randomness


def hexs(b):
    return b.hex()


def main():
    grp.self_check()
    se.aead_self_check()
    se.mlkem_self_check(100)
    out_dir = sys.argv[1]

    plural = election("plurality", 1, 3, 0, 1, 2, 3, [0, 2], "panel-3", [1, 2, 3])
    approval = election("approval", 2, 4, 1, 2, 3, 4, [1], "challenge-panel-4", [1, 2, 4])
    wide = election("options-max", 2, 64, 0, 64, 2, 2, [0], "panel-2", [1, 2])
    many = election("trustees-max", 1, 2, 0, 1, 16, 16, [0], "panel-16", list(range(1, 17)))
    elections = {e["label"]: e for e in (plural, approval, wide, many)}

    openings = []

    def add(id_, desc, e, o, randomness=None, expect=None, option=None, seat=None):
        enc = enc_opening(o)
        got = check_opening(e, o)
        entry = {"id": id_, "description": desc, "election": e["label"], "encoding": hexs(enc)}
        if randomness is not None:
            entry["randomness"] = randomness
        entry["coreHash"] = hexs(core_hash(o["definitionHash"], o["tier"], o["vss"], o["shareHashes"]))
        if got[0] == "ok":
            assert expect in ("ok", "ok-outside"), (id_, got)
            entry["result"] = "ok"
            entry["votes"] = [str(v) for v in got[2]]
            entry["withinRules"] = got[3]
            assert got[3] == (expect == "ok"), id_
            assert got[1].hex() == entry["coreHash"]
        else:
            assert got[0] == expect, (id_, got, expect)
            entry["result"] = got[0]
            if got[1] is not None:
                assert got[1] == option, (id_, got)
                entry["option"] = got[1]
            if got[2] is not None:
                assert got[2] == seat, (id_, got)
                entry["seat"] = got[2]
        openings.append(entry)

    honest = {}

    def opening(id_, desc, e, tier, votes, expect="ok"):
        o, r = make_opening(id_, e, tier, votes)
        honest[id_] = o
        add(id_, desc, e, o, r, expect=expect)

    opening("plurality", "Plurality, 3 options, k = 2, n = 3, every seat registered, tier 0", plural, 0, [0, 1, 0])
    opening("plurality-blank", "A blank plurality vote at tier 2", plural, 2, [0, 0, 0])
    opening("approval-unqualified-seat", "Approval, 4 options, k = 3, n = 4; seat 3 is outside the registered key set, so its share hash is zero and it reveals nothing", approval, 1, [1, 0, 1, 0])
    opening("options-max", "MAX_OPTIONS: 64 options, k = n = 2", wide, 0, [1 if j % 7 == 0 else 0 for j in range(64)])
    opening("trustees-max", "MAX_TRUSTEES: k = n = 16", many, 0, [0, 1])
    opening("vote-two", "A vote of 2 for option 1: the opening passes and shows what the client committed to, outside the rules", plural, 0, [0, 2, 0], expect="ok-outside")
    opening("over-vote", "Two options selected in a plurality election: passes, outside the rules", plural, 0, [1, 1, 0], expect="ok-outside")

    base = honest["plurality"]

    def variant(id_, desc, e, src, change, expect, option=None, seat=None):
        o = copy.deepcopy(src)
        change(o)
        add(id_, desc, e, o, expect=expect, option=option, seat=seat)

    variant("stray", "The plurality opening checked against the approval election", approval, base, lambda o: None, "opening-stray")
    variant("tier", "Tier 1, which the plurality election doesn't list", plural, base, lambda o: o.__setitem__("tier", 1), "opening-tier")

    def poly_degree(o):
        o["polynomials"][0]["f"].append(5)

    def drop_vss(o):
        o["vss"][2] = o["vss"][2][:1]

    def drop_hash(o):
        o["shareHashes"] = o["shareHashes"][:2]

    def drop_seat(o):
        o["seats"] = o["seats"][:2]

    def swap_seats(o):
        o["seats"][0], o["seats"][1] = o["seats"][1], o["seats"][0]

    def repeat_seat(o):
        o["seats"][2] = copy.deepcopy(o["seats"][1])

    variant("shape-polynomial", "Option 0's f has k + 1 coefficients", plural, base, poly_degree, "opening-shape")
    variant("shape-vss", "Option 2 has one VSS commitment for k = 2", plural, base, drop_vss, "opening-shape")
    variant("shape-share-hashes", "Two share hashes for n = 3", plural, base, drop_hash, "opening-shape")
    variant("shape-missing-seat", "Seat 3's randomness is left out", plural, base, drop_seat, "opening-shape")
    variant("shape-seat-order", "Seats 1 and 2 swapped", plural, base, swap_seats, "opening-shape")
    variant("shape-repeated-seat", "Seat 2 listed twice and seat 3 not at all", plural, base, repeat_seat, "opening-shape")

    unq = honest["approval-unqualified-seat"]

    def add_unregistered(o):
        r = bv.Rng("unregistered seat")
        o["seats"].insert(2, {"seat": 3, "m": r.bytes32(), "e": se.nonzero_scalar(r), "w": se.nonzero_scalar(r)})

    variant("shape-unregistered-seat", "Randomness for seat 3, which is outside the registered key set", approval, unq, add_unregistered, "opening-shape")
    variant("unqualified", "Seat 3, outside the registered key set, has a share hash other than zero", approval, unq, lambda o: o["shareHashes"].__setitem__(2, det("chosen bytes")), "opening-unqualified")

    def claim_other_vote(o):
        # The cheat Benaloh's challenge catches: the opening claims option 0
        # where the core commits to option 1.
        o["polynomials"][0]["f"][0] = 1
        o["polynomials"][1]["f"][0] = 0

    def bump(j, t, field):
        def change(o):
            o["polynomials"][j][field][t] = (o["polynomials"][j][field][t] + 1) % L

        return change

    variant("vss-other-vote", "The opening claims a vote for option 0 over a core committing to option 1", plural, base, claim_other_vote, "opening-vss", option=0)
    variant("vss-coefficient", "Option 1's a_1 plus 1", plural, base, bump(1, 1, "f"), "opening-vss", option=1)
    variant("vss-randomness", "Option 2's r plus 1", plural, base, bump(2, 0, "g"), "opening-vss", option=2)

    def seat_field(i, field, value):
        def change(o):
            o["seats"][i][field] = value(o["seats"][i][field])

        return change

    variant("ciphertext-m", "Seat 2's ML-KEM message with its first byte flipped", plural, base, seat_field(1, "m", lambda m: bytes([m[0] ^ 1]) + m[1:]), "opening-ciphertext", seat=2)
    variant("ciphertext-e", "Seat 1's ephemeral plus 1", plural, base, seat_field(0, "e", lambda x: (x + 1) % L), "opening-ciphertext", seat=1)
    variant("ciphertext-w", "Seat 3's proof nonce plus 1", plural, base, seat_field(2, "w", lambda x: (x + 1) % L), "opening-ciphertext", seat=3)
    variant("ciphertext-e-zero", "Seat 2's ephemeral is 0", plural, base, seat_field(1, "e", lambda x: 0), "opening-ciphertext", seat=2)
    variant("ciphertext-w-zero", "Seat 1's proof nonce is 0", plural, base, seat_field(0, "w", lambda x: 0), "opening-ciphertext", seat=1)
    variant("ciphertext-unqualified-seat-key", "Approval: seat 4's ML-KEM message changed, after the unqualified seat 3", approval, unq, seat_field(2, "m", lambda m: bytes([m[0] ^ 0x80]) + m[1:]), "opening-ciphertext", seat=4)

    # A dishonest client: seat 2's ciphertext seals shares other than the
    # sharing's, so the core's share hash isn't the one its polynomials rebuild.
    def bad_shares(seat, shares):
        if seat == 2:
            shares = copy.deepcopy(shares)
            shares[0]["v"] = (shares[0]["v"] + 1) % L
        return shares

    o, r = make_opening("dishonest-shares", plural, 0, [1, 0, 0], cheat=bad_shares)
    add("ciphertext-dishonest-shares", "A client sealed wrong shares for seat 2: the rebuilt ciphertext differs", plural, o, r, expect="opening-ciphertext", seat=2)

    def two(*changes):
        def change(o):
            for c in changes:
                c(o)

        return change

    variant("order-tier-before-shape", "An unlisted tier and a missing seat: tier first", plural, base, two(lambda o: o.__setitem__("tier", 1), drop_seat), "opening-tier")
    variant("order-shape-before-unqualified", "Randomness for the unregistered seat 3 and a non-zero hash for it: shape first", approval, unq, two(add_unregistered, lambda o: o["shareHashes"].__setitem__(2, det("chosen bytes"))), "opening-shape")
    variant("order-unqualified-before-vss", "A non-zero hash for the unregistered seat 3 and a changed coefficient: unqualified first", approval, unq, two(lambda o: o["shareHashes"].__setitem__(2, det("chosen bytes")), bump(0, 1, "f")), "opening-unqualified")
    variant("order-stray-before-shape", "Another election and a missing seat: stray first", approval, base, drop_seat, "opening-stray")
    variant("order-vss-before-ciphertext", "A changed coefficient and a changed ML-KEM message: vss first", plural, base, two(bump(2, 1, "f"), seat_field(0, "m", lambda m: bytes(32))), "opening-vss", option=2)

    # Decode rejections, from the plurality opening's bytes and its fixed offsets.
    enc = enc_opening(base)
    vss_start = 36
    first_f = 36 + len(bv.enc_vss(base["vss"])) + len(bv.enc_share_hashes(base["shareHashes"])) + 4 + 4
    decode = [
        {"id": "truncated", "description": "The plurality opening without its last byte", "encoding": hexs(enc[:-1]), "error": "truncated"},
        {"id": "trailing-byte", "description": "The plurality opening with a byte after its last seat", "encoding": hexs(enc + b"\x00"), "error": "trailing-bytes", "offset": len(enc)},
        {"id": "header-only", "description": "An opening record header with nothing after it", "encoding": hexs(enc[:3]), "error": "truncated", "offset": 3},
        {"id": "tier-3", "description": "Tier 3, which no definition can list", "encoding": hexs(enc[:35] + b"\x03" + enc[36:]), "error": "invalid-enum", "offset": 35},
        {"id": "vss-identity", "description": "A first VSS commitment that is the identity", "encoding": hexs(enc[: vss_start + 8] + bytes(32) + enc[vss_start + 40 :]), "error": "non-canonical", "offset": vss_start + 8},
        {"id": "coefficient-l", "description": "Option 0's v_0 equal to the group order ℓ", "encoding": hexs(enc[:first_f] + scalar(L) + enc[first_f + 32 :]), "error": "non-canonical", "offset": first_f},
        {"id": "seat-e-l", "description": "The last seat's e equal to ℓ", "encoding": hexs(enc[: len(enc) - 64] + scalar(L) + enc[len(enc) - 32 :]), "error": "non-canonical", "offset": len(enc) - 64},
        {"id": "polynomials-over-max", "description": "A polynomial list count of 65, over MAX_OPTIONS", "encoding": hexs(enc[: first_f - 8] + u32(65) + enc[first_f - 4 :]), "error": "length-over-max", "offset": first_f - 8},
        {"id": "version-2", "description": "Version 2, which no profile can pin yet (the pinned version is 1)", "encoding": hexs(enc[:2] + b"\x02" + enc[3:]), "error": "profile-mismatch", "offset": 2},
        {"id": "other-type", "description": "Record type 0x0002, a ballot's: in this file the only known type is 0x0003 (notation.md, Strict decoding)", "encoding": hexs(u16(0x0002) + enc[2:]), "error": "unknown-record-type", "offset": 0},
    ]
    # Each mutation really is at the stated field: check the bytes it replaced.
    assert enc[vss_start : vss_start + 4] == u32(3) and enc[vss_start + 4 : vss_start + 8] == u32(2)
    assert enc[first_f : first_f + 32] == scalar(0) and enc[first_f - 8 : first_f - 4] == u32(3)
    assert enc[len(enc) - 64 : len(enc) - 32] == scalar(base["seats"][2]["e"])

    def core_json(c):
        return {"definitionHash": hexs(c["definitionHash"]), "tier": c["tier"], "vss": hexs(bv.enc_vss(c["vss"])), "shareHashes": [hexs(h) for h in c["shareHashes"]]}

    # Opened commitments under other tracking codes (challenge.md, Opened
    # commitments): the opened core's C_j re-used with fresh share hashes,
    # another tier, re-blinded higher coefficients or at another option, or
    # an opened r_j under the other vote, are opened; fresh r_j for the same
    # vote, another vote, a shifted r_j or another election's hash aren't.
    def encrypt_all(label, polys, vss):
        r = bv.Rng("re-encrypted/" + label)
        hashes = []
        for seat in range(1, plural["panelSize"] + 1):
            shares = [{"v": bv.evaluate(p["f"], seat), "r": bv.evaluate(p["g"], seat)} for p in polys]
            ct, _ = se.encrypt(plural["definitionHash"], seat, plural["keys"][seat], vss, bv.enc_shares(shares), r.bytes32(), se.nonzero_scalar(r), se.nonzero_scalar(r))
            hashes.append(se.share_hash(ct))
        return hashes

    def core_from(label, polys, tier=0):
        vss = [[bv.pedersen(p["f"][t], p["g"][t]) for t in range(len(p["f"]))] for p in polys]
        return {"definitionHash": base["definitionHash"], "tier": tier, "vss": vss, "shareHashes": encrypt_all(label, polys, vss)}

    def reblinded(label, polys, keep):
        """New sharings: option j keeps (v_j, r_j) when keep(j), else draws a fresh r_j; every higher coefficient is fresh."""
        r = bv.Rng("reblinded/" + label)
        out = []
        for j, p in enumerate(polys):
            f = [p["f"][0]] + [r.scalar() for _ in p["f"][1:]]
            g = [p["g"][0] if keep(j) else r.scalar()] + [r.scalar() for _ in p["g"][1:]]
            out.append({"f": f, "g": g})
        return out

    bp = base["polynomials"]
    flip = reblinded("flip", bp, lambda j: False)
    flipped = [{"f": [(1 - bp[0]["f"][0]) % L] + flip[0]["f"][1:], "g": [bp[0]["g"][0]] + flip[0]["g"][1:]}] + flip[1:]
    shift = reblinded("shift", bp, lambda j: False)
    coef_r = reblinded("coef", bp, lambda j: False)
    coef = [{"f": [bp[0]["f"][0]] + coef_r[0]["f"][1:], "g": [bp[0]["g"][1]] + coef_r[0]["g"][1:]}] + coef_r[1:]
    seat_r = reblinded("seatshare", bp, lambda j: False)
    fcoef_r = reblinded("fcoef", bp, lambda j: False)
    fcoef = [{"f": [bp[0]["f"][0]] + fcoef_r[0]["f"][1:], "g": [bp[1]["f"][1]] + fcoef_r[0]["g"][1:]}] + fcoef_r[1:]
    eph_r = reblinded("eph", bp, lambda j: False)
    eph = [{"f": [bp[0]["f"][0]] + eph_r[0]["f"][1:], "g": [base["seats"][0]["e"]] + eph_r[0]["g"][1:]}] + eph_r[1:]
    seatshare = [{"f": [bp[0]["f"][0]] + seat_r[0]["f"][1:], "g": [bv.evaluate(bp[0]["g"], 2)] + seat_r[0]["g"][1:]}] + seat_r[1:]
    shifted = [{"f": [bp[0]["f"][0]] + shift[0]["f"][1:], "g": [(bp[0]["g"][0] + 1) % L] + shift[0]["g"][1:]}] + shift[1:]
    moved = reblinded("moved", [bp[1], bp[0], bp[2]], lambda j: j == 0)
    cases = (
        ("fresh-share-hashes", "The plurality opening's commitments encrypted again with fresh randomness: another code", core_from("fresh", bp), True),
        ("other-tier", "The same core under tier 2: another code", {**base, "tier": 2}, True),
        ("same-core", "The opened core itself", base, True),
        ("reblinded", "The same v_j and r_j with every higher coefficient fresh: new E_{j,t} for t ≥ 1, new shares and share hashes, the same C_j", core_from("reblinded", reblinded("all", bp, lambda j: True)), True),
        ("moved-option", "Option 1's C_j cast at option 0 (with option 0's vote there), every other commitment fresh", core_from("moved", moved), True),
        ("same-randomness-other-vote", "Option 0's r_0 under the other vote (1 − v_0), every other commitment fresh: opened by testing C' · h^{−r_0}", core_from("flip", flipped), True),
        ("shifted-randomness", "Option 0 under r_0 + 1, every other commitment fresh: derived by a chosen relation, not caught (a residual)", core_from("shift", shifted), False),
        ("fresh-randomness", "The same votes with a fresh r_j for every option: no commitment in common", core_from("fresh-r", reblinded("none", bp, lambda j: False)), False),
        ("other-vote", "The blank opening's core", honest["plurality-blank"], False),
        ("other-election", "The same commitments named under the approval election's definition hash (an opened C_j cast in another election is a residual, challenge.md)", {**base, "definitionHash": approval["definitionHash"]}, False),
        ("higher-coefficient", "Option 0's vote under b_{0,1}, g_0's revealed higher coefficient, every other commitment fresh", core_from("coef", coef), True),
        ("seat-share", "Option 0's vote under g_0(2), seat 2's revealed share, every other commitment fresh", core_from("seatshare", seatshare), True),
        ("vote-coefficient", "Option 0's vote under a_{1,1}, f_1's revealed higher coefficient, every other commitment fresh", core_from("fcoef", fcoef), True),
        ("seat-ephemeral", "Option 0's vote under seat 1's revealed e_1, every other commitment fresh", core_from("eph", eph), True),
    )
    opened_commitments = []
    base_code = core_hash(base["definitionHash"], base["tier"], base["vss"], base["shareHashes"])
    for id_, desc, c, want in cases:
        # What the opening opens: each C_j, and h^{r_j} and g · h^{r_j}.
        opened_set = set()
        for row, p in zip(base["vss"], bp):
            opened_set.add(grp.encode(row[0]))

        # Every scalar the opening reveals: each coefficient of every f_j
        # and g_j, each seat's shares f_j(i) and g_j(i), each seat's e and w.
        revealed = set()
        for p in bp:
            for poly in (p["f"], p["g"]):
                revealed.update(poly)
                revealed.update(bv.evaluate(poly, i) for i in range(1, plural["panelSize"] + 1))
        for st in base["seats"]:
            revealed.update((st["e"], st["w"]))
        for sc in revealed:
            opened_set.add(grp.encode(bv.pedersen(0, sc)))
            opened_set.add(grp.encode(bv.pedersen(1, sc)))
        shared = c["definitionHash"] == base["definitionHash"] and any(grp.encode(row[0]) in opened_set for row in c["vss"])
        assert shared == want, id_
        code = core_hash(c["definitionHash"], c["tier"], c["vss"], c["shareHashes"])
        assert (code == base_code) == (id_ == "same-core"), id_
        assert (bv.enc_vss(c["vss"]) == bv.enc_vss(base["vss"])) == (id_ in ("fresh-share-hashes", "other-tier", "same-core", "other-election")), id_
        opened_commitments.append({"id": id_, "description": desc, "opening": "plurality", "core": core_json(c), "coreHash": hexs(code), "opened": shared})

    # Cast ballots' core hashes, from the frozen ballot.json.
    ballots = json.loads((VECTORS / "ballot.json").read_text())
    cast = [
        {"ballot": b["id"], "coreHash": hexs(core_hash_of_ballot(bytes.fromhex(b["encoding"])))}
        for b in ballots["ballots"]
        if b["id"] in ("ok-tier-0", "ok-reproved", "ok-revote", "ok-tier-2-blank", "ok-every-seat", "ok-approval")
    ]

    out = {
        "format": "abolish-challenge-vectors/1",
        "title": "Benaloh challenge: core hashes and spoiled-ballot openings",
        "spec": "docs/spec/challenge.md",
        "generator": "packages/crypto/scripts/challenge-vectors.py: an independent Python implementation of docs/spec/challenge.md and ballot-validity.md (Core hash), reusing share-encryption-vectors.py's self-checked ML-KEM-768 and ChaCha20-Poly1305, ballot-validity-vectors.py's ristretto255 and definition-vectors.py's definitions; nothing from packages/crypto",
        "recordType": "0x0003",
        "version": 1,
        "tag": CORE_TAG.decode(),
        "panels": {
            name: [{"seat": i + 1, **se.key_json(key)} for i, key in enumerate(keys)]
            for name, keys in KEYS.items()
        },
        "elections": {
            name: {
                "definition": hexs(e["encoding"]),
                "definitionHash": hexs(e["definitionHash"]),
                "panel": e["panel"],
                "registered": e["registered"],
            }
            for name, e in elections.items()
        },
        "openings": openings,
        "decode": decode,
        "openedCommitments": opened_commitments,
        "castBallots": cast,
    }
    (pathlib.Path(out_dir) / "challenge.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
