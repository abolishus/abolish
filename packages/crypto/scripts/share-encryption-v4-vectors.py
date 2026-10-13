#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/share-encryption-v4.json.

A second implementation of docs/spec/share-encryption.md, Ballot version 4:
each seat's ciphertext of a version-4 ballot, for a seat of the default panel
or of the author panel, with the associated data and the proof of knowledge's
challenge input naming ballot version 4, the seat's panel and both halves'
commitments; a seat's decryption against its own panel's commitments; the
public check of a posting against its own panel's share-hash list and key;
and the complaint proof under `abolish/v1/fs/share-complaint-2`, with the
panel in its challenge input. It is written from the spec with Python's
integers and hashlib and shares no code with packages/crypto or any @noble
library. It reuses only this folder's other independent generators:
share-encryption-vectors.py's ML-KEM-768 (FIPS 203), ChaCha20-Poly1305
(RFC 8439), combiner, ciphertext codec and share decoding, whose self-checks
run first, and ballot-v4-vectors.py's elections and version-4 ballots.

Every random value comes from SHA-512 or SHA-256 over a fixed label, and each
vector lists the values it used, so any implementation can reproduce its bytes
exactly. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/share-encryption-v4-vectors.py <out-dir> [--full],
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
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


se = _load("share_encryption_vectors", "share-encryption-vectors.py")
b4 = _load("ballot_v4_vectors", "ballot-v4-vectors.py")
bv = se.bv
grp = se.grp

L = grp.L
G = grp.BASE
BALLOT = 0x0002
VERSION = 4
DEFAULT, AUTHOR = 1, 2

COMPLAINT_TAG_2 = b"abolish/v1/fs/share-complaint-2"

u8, u16, u32, scalar, element, ds, H = bv.u8, bv.u16, bv.u32, bv.scalar, bv.element, bv.ds, bv.H
pt_mul = se.pt_mul


# --- Ballot version 4 (share-encryption.md, Ballot version 4) ---------------------


def head(definition_hash, panel, seat, version=VERSION):
    """What aad and t_e start with: version 4 names the panel before the seat; versions 1 to 3 name ballot version 1's rules and the seat."""
    if version == VERSION:
        return definition_hash + u16(BALLOT) + u8(VERSION) + u8(panel) + u8(seat)
    return definition_hash + u16(BALLOT) + u8(1) + u8(seat)


def commitments(halves, version=VERSION):
    if version == VERSION:
        return bv.enc_vss(halves["vss"]) + bv.enc_vss(halves["authorVss"])
    return bv.enc_vss(halves["vss"])


def aad(definition_hash, panel, seat, halves, version=VERSION):
    return ds(se.AAD_TAG, head(definition_hash, panel, seat, version) + commitments(halves, version))


def ephemeral_challenge(definition_hash, panel, seat, dh, halves, ct_m, ct_dh, sealed, a, version=VERSION):
    t = (
        head(definition_hash, panel, seat, version)
        + element(dh)
        + commitments(halves, version)
        + ct_m
        + element(ct_dh)
        + u32(len(sealed))
        + sealed
        + element(a, True)
    )
    return bv.hash_to_scalar(t, se.EPHEMERAL_TAG)


def own_vss(halves, panel):
    return halves["authorVss"] if panel == AUTHOR else halves["vss"]


def own_hashes(vote, panel):
    return vote["authorShareHashes"] if panel == AUTHOR else vote["shareHashes"]


def encrypt(definition_hash, panel, seat, key, halves, shares_bytes, m, e, w, dh_scalar=None, version=VERSION):
    """One seat's ciphertext; `dh_scalar` (a cheat) seals under another DH value, `version` 1 (a cheat) binds as ballot version 1 does."""
    ss_m, ct_m = se.encaps_internal(key["ek"], m)
    ct_dh = pt_mul(e, G)
    ss_dh = pt_mul(e if dh_scalar is None else dh_scalar, key["dh"])
    k = se.combine(ss_m, ss_dh, ct_dh, key["dh"])
    a = aad(definition_hash, panel, seat, halves, version)
    sealed = se.aead_seal(k, se.NONCE, a, shares_bytes)
    c = ephemeral_challenge(definition_hash, panel, seat, key["dh"], halves, ct_m, ct_dh, sealed, pt_mul(w, G), version)
    ct = se.enc_ciphertext(ct_m, ct_dh, c, (w + c * e) % L, sealed)
    return ct, {"kemSharedSecret": ss_m.hex(), "dhSharedSecret": element(ss_dh).hex(), "aeadKey": k.hex(), "associatedDataHash": H(a).hex()}


def pok_ok(definition_hash, panel, seat, dh, halves, ct, version=VERSION):
    a = grp.add(pt_mul(ct["z"], G), grp.neg(pt_mul(ct["c"], ct["ct_dh"])))
    return ephemeral_challenge(definition_hash, panel, seat, dh, halves, ct["ct_m"], ct["ct_dh"], ct["sealed"], a, version) == ct["c"]


def open_with(k, definition_hash, panel, seat, halves, sealed, version=VERSION):
    """Decryption steps 4 and 5 with a known AEAD key, against the seat's own panel's commitments: None if they pass, else the code."""
    vss = own_vss(halves, panel)
    pt = se.aead_open(k, se.NONCE, aad(definition_hash, panel, seat, halves, version), sealed)
    shares = None if pt is None else se.dec_shares(pt, len(vss))
    if shares is None:
        return "share-decrypt"
    if not bv.check_shares(vss, seat, shares):
        return "share-check"
    return None


def decrypt(definition_hash, panel, seat, key, halves, ct_bytes, version=VERSION):
    ct = se.dec_ciphertext(ct_bytes)
    if ct is None:
        return "share-malformed"
    if not pok_ok(definition_hash, panel, seat, key["dh"], halves, ct, version):
        return "share-proof"
    ss_m = se.decaps_internal(key["dk"], ct["ct_m"])
    k = se.combine(ss_m, pt_mul(key["x"], ct["ct_dh"]), ct["ct_dh"], key["dh"])
    return open_with(k, definition_hash, panel, seat, halves, ct["sealed"], version) or "ok"


def check_posting(definition_hash, panel, seat, key, vote, ct_bytes, m):
    if len(m) != 32:
        return "posting-malformed", None
    ct = se.dec_ciphertext(ct_bytes)
    if ct is None:
        return "posting-malformed", None
    if se.share_hash(ct_bytes) != own_hashes(vote, panel)[seat - 1]:
        return "posting-hash", None
    if not pok_ok(definition_hash, panel, seat, key["dh"], vote, ct):
        return "posting-proof", None
    ss_m, ct_m = se.encaps_internal(key["ek"], m)
    if ct_m != ct["ct_m"]:
        return "posting-encapsulation", None
    return "ok", (ct, ss_m)


def complaint_challenge(definition_hash, panel, seat, dh, sh, ct_dh, d, a1, a2, version=VERSION):
    """Version 4's challenge names the panel under its own tag; `version` 1 (a cheat) is version 1's layout and tag."""
    if version == VERSION:
        t = definition_hash + u8(panel) + u8(seat) + element(dh) + sh + element(ct_dh) + element(d) + element(a1, True) + element(a2, True)
        return bv.hash_to_scalar(t, COMPLAINT_TAG_2)
    return se.complaint_challenge(definition_hash, seat, dh, sh, ct_dh, d, a1, a2)


def raw_complaint(definition_hash, panel, seat, key, ct_bytes, w, version=VERSION):
    """The complaint proof's arithmetic alone, without the trustee's preconditions (for invalid vectors)."""
    ct = se.dec_ciphertext(ct_bytes)
    d = pt_mul(key["x"], ct["ct_dh"])
    c = complaint_challenge(definition_hash, panel, seat, key["dh"], se.share_hash(ct_bytes), ct["ct_dh"], d, pt_mul(w, G), pt_mul(w, ct["ct_dh"]), version)
    return {"dh": d, "c": c, "z": (w + c * key["x"]) % L}


def prove_complaint(definition_hash, panel, seat, key, vote, ct_bytes, m, w):
    """A trustee's complaint: only for a posting that passes and whose shares fail its own decryption."""
    code, _ = check_posting(definition_hash, panel, seat, key, vote, ct_bytes, m)
    assert code == "ok"
    assert decrypt(definition_hash, panel, seat, key, vote, ct_bytes) in ("share-decrypt", "share-check")
    return raw_complaint(definition_hash, panel, seat, key, ct_bytes, w)


def check_complaint(definition_hash, panel, seat, key, vote, ct_bytes, m, proof):
    code, passed = check_posting(definition_hash, panel, seat, key, vote, ct_bytes, m)
    if code != "ok":
        return code
    ct, ss_m = passed
    c, z, d = proof["c"], proof["z"], proof["dh"]
    a1 = grp.add(pt_mul(z, G), grp.neg(pt_mul(c, key["dh"])))
    a2 = grp.add(pt_mul(z, ct["ct_dh"]), grp.neg(pt_mul(c, d)))
    if complaint_challenge(definition_hash, panel, seat, key["dh"], own_hashes(vote, panel)[seat - 1], ct["ct_dh"], d, a1, a2) != c:
        return "complaint-proof"
    k = se.combine(ss_m, d, ct["ct_dh"], key["dh"])
    return "ok" if open_with(k, definition_hash, panel, seat, vote, ct["sealed"]) else "complaint-unfounded"


# --- Vectors ---------------------------------------------------------------------


def nonzero_scalar(rng):
    x = rng.scalar()
    assert x != 0
    return x


def make_encrypted_ballot(label, e, cell, votes, keys, author_keys, cheat=None):
    """A version-4 ballot whose share hashes are its real ciphertexts' hashes; `cheat(panel, seat, shares_bytes, key, halves, m, e, w)` may alter a seat's ciphertext."""
    ctx = b4.context(e, "share-v4/" + label, cell)
    n, n_a = e["panelSize"], e["authorPanelSize"]
    # make_ballot draws the polynomials before anything else, so a second call
    # with the real share hashes keeps the same halves and shares.
    first, _, shares, author_shares = b4.make_ballot("share-v4/" + label, e, ctx, votes, share_hashes=[bytes(32)] * n, author_share_hashes=[bytes(32)] * n_a)
    halves = {"vss": first["vss"], "authorVss": first["authorVss"]}
    rng = bv.Rng("share-v4/encapsulation/" + label)
    out = {}
    for panel, seat_shares, panel_keys in ((DEFAULT, shares, keys), (AUTHOR, author_shares, author_keys)):
        cts, inter, rand = [], [], []
        for seat in range(1, len(seat_shares) + 1):
            m, ee, w = rng.bytes32(), nonzero_scalar(rng), nonzero_scalar(rng)
            sb = bv.enc_shares(seat_shares[seat - 1])
            if cheat is not None:
                ct, iv = cheat(panel, seat, sb, panel_keys[seat - 1], halves, m, ee, w)
            else:
                ct, iv = encrypt(e["definitionHash"], panel, seat, panel_keys[seat - 1], halves, sb, m, ee, w)
            cts.append(ct)
            inter.append(iv)
            rand.append({"m": m.hex(), "e": str(ee), "w": str(w)})
        out[panel] = {"cts": cts, "inter": inter, "rand": rand}
    hashes = [se.share_hash(ct) for ct in out[DEFAULT]["cts"]]
    author_hashes = [se.share_hash(ct) for ct in out[AUTHOR]["cts"]]
    vote, randomness, shares2, author_shares2 = b4.make_ballot("share-v4/" + label, e, ctx, votes, share_hashes=hashes, author_share_hashes=author_hashes)
    assert (shares2, author_shares2) == (shares, author_shares) and vote["vss"] == first["vss"] and vote["authorVss"] == first["authorVss"]
    assert b4.check_validity(e, ctx, vote) == "ok", label
    return {
        "id": label,
        "election": e,
        "ctx": ctx,
        "vote": vote,
        "randomness": randomness,
        "shares": {DEFAULT: shares, AUTHOR: author_shares},
        "panels": out,
        "keys": {DEFAULT: keys, AUTHOR: author_keys},
    }


def main():
    grp.self_check()
    se.aead_self_check()
    se.mlkem_self_check(10000 if "--full" in sys.argv[2:] else 100)
    out = pathlib.Path(sys.argv[1])

    elections = {
        el["label"]: el
        for el in (
            b4.election("share-author", [(3, 0, 1), (2, 0, 2)], 2, 3, 2, 3),
            b4.election("share-no-author", [(4, 1, 2)], 2, 3, 0, 0),
            b4.election("share-author-k1", [(3, 0, 1)], 2, 3, 1, 2),
            b4.election("share-options-max", [(64, 0, 64)], 2, 2, 2, 2),
            b4.election("share-trustees-max", [(2, 0, 1)], 16, 16, 16, 16),
        )
    }
    key_sets = {
        "default-3": se.trustee_keys("v4-default-3", 3),
        "author-3": se.trustee_keys("v4-author-3", 3),
        "author-2": se.trustee_keys("v4-author-2", 2),
        "default-2": se.trustee_keys("v4-default-2", 2),
        "default-16": se.trustee_keys("v4-default-16", 16),
        "author-16": se.trustee_keys("v4-author-16", 16),
    }
    panels_of = {
        "share-author": ("default-3", "author-3"),
        "share-no-author": ("default-3", None),
        "share-author-k1": ("default-3", "author-2"),
        "share-options-max": ("default-2", "author-2"),
        "share-trustees-max": ("default-16", "author-16"),
    }

    made = {}
    ballots = []

    def ballot(id_, desc, election, cell, votes, cheat=None, result=None):
        e = elections[election]
        dk, ak = panels_of[election]
        b = make_encrypted_ballot(id_, e, cell, votes, key_sets[dk], key_sets[ak] if ak else [], cheat)
        made[id_] = b
        entry = {
            "id": id_,
            "description": desc,
            "election": election,
            "definitionHash": b4.hexs(e["definitionHash"]),
            "cell": cell,
            "nullifier": str(b["ctx"]["nullifier"]),
            "keys": dk,
            "authorKeys": ak,
            "votes": votes,
            "randomness": b["randomness"],
            "committedVote": b4.enc_committed_vote(b["vote"]).hex(),
            "seats": [],
        }
        for panel in (DEFAULT, AUTHOR):
            p = b["panels"][panel]
            for seat in range(1, len(p["cts"]) + 1):
                ct = p["cts"][seat - 1]
                got = decrypt(e["definitionHash"], panel, seat, b["keys"][panel][seat - 1], b["vote"], ct)
                want = "ok" if result is None else result(panel, seat)
                assert got == want, (id_, panel, seat, got, want)
                assert se.share_hash(ct) == own_hashes(b["vote"], panel)[seat - 1]
                s = {
                    "panel": panel,
                    "seat": seat,
                    "shares": bv.enc_shares(b["shares"][panel][seat - 1]).hex(),
                    "encapsulation": p["rand"][seat - 1],
                    "intermediate": p["inter"][seat - 1],
                    "ciphertext": ct.hex(),
                    "shareHash": se.share_hash(ct).hex(),
                    "decryption": got,
                }
                entry["seats"].append(s)
        ballots.append(entry)

    sizes = [3, 2]
    flat = lambda *picked: b4.b3.flat(zip(sizes, picked))  # noqa: E731
    ballot("author", "An author panel of k_A = 2, n_A = 3 beside k_D = 2, n_D = 3, two questions: every seat of both panels decrypts and checks", "share-author", 0, flat({1}, {0, 1}))
    ballot("no-author", "No author panel: both author lists empty, encode(author_vss) a zero count in the associated data", "share-no-author", 1, b4.b3.flat(zip([4], [{0, 3}])))
    ballot("author-k1", "k_A = 1, n_A = 2: each author seat's shares are the whole author half", "share-author-k1", 0, b4.b3.flat(zip([3], [{2}])))
    ballot("options-max", "MAX_OPTIONS flat options in both halves: each sealed field is the 4116-byte maximum", "share-options-max", 0, [1 if j % 9 == 0 else 0 for j in range(64)])
    ballot("trustees-max", "MAX_TRUSTEES seats in both panels: seat 16 of each panel in the associated data", "share-trustees-max", 0, b4.b3.flat(zip([2], [{1}])))

    author_e = elections["share-author"]
    defh = author_e["definitionHash"]

    def alter_first_share(sb):
        v = (int.from_bytes(sb[4:36], "little") + 1) % L
        return sb[:4] + scalar(v) + sb[36:]

    def bad_author_share(panel, seat, sb, key, halves, m, e, w):
        # Author seat 2's first share has v + 1, sealed correctly.
        if (panel, seat) == (AUTHOR, 2):
            sb = alter_first_share(sb)
        return encrypt(defh, panel, seat, key, halves, sb, m, e, w)

    def bad_default_seal(panel, seat, sb, key, halves, m, e, w):
        # Default seat 2's shares sealed under a key from the wrong DH value.
        return encrypt(defh, panel, seat, key, halves, sb, m, e, w, dh_scalar=e + 1 if (panel, seat) == (DEFAULT, 2) else None)

    def author_as_default(panel, seat, sb, key, halves, m, e, w):
        # Author seat 1's shares under its own key, but bound as default seat 1.
        return encrypt(defh, DEFAULT if (panel, seat) == (AUTHOR, 1) else panel, seat, key, halves, sb, m, e, w)

    def version_one_rules(panel, seat, sb, key, halves, m, e, w):
        # Author seat 3's ciphertext made under ballot version 1's rules: u8(1), the seat, the default half only.
        return encrypt(defh, panel, seat, key, halves, sb, m, e, w, version=1 if (panel, seat) == (AUTHOR, 3) else VERSION)

    def default_half_only(panel, seat, sb, key, halves, m, e, w):
        # Default seat 1's ciphertext binds the default half's commitments and an empty author half.
        if (panel, seat) == (DEFAULT, 1):
            return encrypt(defh, panel, seat, key, {"vss": halves["vss"], "authorVss": []}, sb, m, e, w)
        return encrypt(defh, panel, seat, key, halves, sb, m, e, w)

    def author_short_list(panel, seat, sb, key, halves, m, e, w):
        # Author seat 1's plaintext lists T − 1 shares.
        if (panel, seat) == (AUTHOR, 1):
            n = int.from_bytes(sb[:4], "big") - 1
            sb = u32(n) + sb[4 : 4 + 64 * n]
        return encrypt(defh, panel, seat, key, halves, sb, m, e, w)

    answers = flat({0}, {1})
    ballot("bad-author-share", "A dishonest client: author seat 2's first share has v + 1, sealed correctly", "share-author", 0, answers, bad_author_share, lambda p, s: "share-check" if (p, s) == (AUTHOR, 2) else "ok")
    ballot("bad-default-seal", "A dishonest client: default seat 2's shares sealed under a key from the wrong DH value", "share-author", 0, answers, bad_default_seal, lambda p, s: "share-decrypt" if (p, s) == (DEFAULT, 2) else "ok")
    ballot("author-short-list", "A dishonest client: author seat 1's plaintext has T − 1 shares", "share-author", 0, answers, author_short_list, lambda p, s: "share-decrypt" if (p, s) == (AUTHOR, 1) else "ok")
    ballot("author-as-default", "A dishonest client: author seat 1's ciphertext names the default panel", "share-author", 0, answers, author_as_default, lambda p, s: "share-proof" if (p, s) == (AUTHOR, 1) else "ok")
    ballot("version-one-rules", "A dishonest client: author seat 3's ciphertext made under ballot version 1's rules", "share-author", 0, answers, version_one_rules, lambda p, s: "share-proof" if (p, s) == (AUTHOR, 3) else "ok")
    ballot("default-half-only", "A dishonest client: default seat 1's ciphertext binds only the default half's commitments", "share-author", 0, answers, default_half_only, lambda p, s: "share-proof" if (p, s) == (DEFAULT, 1) else "ok")

    # Decryptions under the wrong panel, seat, context or rules.
    a = made["author"]
    other = made["bad-default-seal"]
    halves_a = {"vss": a["vote"]["vss"], "authorVss": a["vote"]["authorVss"]}
    decrypt_failures = []

    def ct_of(b, panel, seat):
        return b["panels"][panel]["cts"][seat - 1]

    def fail(id_, desc, panel, seat, key_panel, key_seat, ct, halves=None, definition_hash=None, version=VERSION, expect="share-proof"):
        h = halves or halves_a
        dh_ = definition_hash or defh
        key = a["keys"][key_panel][key_seat - 1]
        got = decrypt(dh_, panel, seat, key, h, ct, version)
        assert got == expect, (id_, got)
        decrypt_failures.append(
            {
                "id": id_,
                "description": desc,
                "ballotVersion": version,
                "definitionHash": dh_.hex(),
                "panel": panel,
                "seat": seat,
                "keyPanel": key_panel,
                "keySeat": key_seat,
                "vss": bv.enc_vss(h["vss"]).hex(),
                "authorVss": bv.enc_vss(h["authorVss"]).hex(),
                "ciphertext": ct.hex(),
                "result": expect,
            }
        )

    flip = lambda b, i: b[:i] + bytes([b[i] ^ 1]) + b[i + 1 :]  # noqa: E731
    da1, aa1 = ct_of(a, DEFAULT, 1), ct_of(a, AUTHOR, 1)
    fail("author-as-default", "Author seat 1's ciphertext opened as default seat 1, with author seat 1's key", DEFAULT, 1, AUTHOR, 1, aa1)
    fail("default-as-author", "Default seat 1's ciphertext opened as author seat 1, with default seat 1's key", AUTHOR, 1, DEFAULT, 1, da1)
    fail("author-other-seat", "Author seat 1's ciphertext opened by author seat 2 with its own key", AUTHOR, 2, AUTHOR, 2, aa1)
    fail("author-other-definition", "Author seat 1's ciphertext under another definition hash", AUTHOR, 1, AUTHOR, 1, aa1, definition_hash=H(b"another election"))
    fail("author-other-default-half", "Author seat 1's ciphertext next to another ballot's default half", AUTHOR, 1, AUTHOR, 1, aa1, halves={"vss": other["vote"]["vss"], "authorVss": halves_a["authorVss"]})
    fail("default-other-author-half", "Default seat 1's ciphertext next to another ballot's author half", DEFAULT, 1, DEFAULT, 1, da1, halves={"vss": halves_a["vss"], "authorVss": other["vote"]["authorVss"]})
    fail("default-under-version-one", "Default seat 1's version-4 ciphertext decrypted under ballot version 1's rules", DEFAULT, 1, DEFAULT, 1, da1, version=1)
    fail("author-flipped-tag", "The last byte of author seat 1's AEAD tag flipped", AUTHOR, 1, AUTHOR, 1, flip(aa1, len(aa1) - 1))
    fail("author-flipped-mlkem", "The first byte of author seat 1's ML-KEM ciphertext flipped", AUTHOR, 1, AUTHOR, 1, flip(aa1, 0))
    fail("author-identity-dh", "Author seat 1's ct_dh is the identity", AUTHOR, 1, AUTHOR, 1, aa1[:1088] + bytes(32) + aa1[1120:], expect="share-malformed")

    # Postings.
    postings = []

    def posting(id_, desc, b, panel, seat, ct, m, expect, key_panel=None, key_seat=None):
        kp, ks = key_panel or panel, key_seat or seat
        got, _ = check_posting(b["election"]["definitionHash"], panel, seat, b["keys"][kp][ks - 1], b["vote"], ct, m)
        assert got == expect, (id_, got)
        postings.append({"id": id_, "description": desc, "ballot": b["id"], "panel": panel, "seat": seat, "keyPanel": kp, "keySeat": ks, "ciphertext": ct.hex(), "m": m.hex(), "result": expect})

    def m_of(b, panel, seat):
        return bytes.fromhex(b["panels"][panel]["rand"][seat - 1]["m"])

    posting("default-pass", "Default seat 1's ciphertext with its own m", a, DEFAULT, 1, da1, m_of(a, DEFAULT, 1), "ok")
    posting("author-pass", "Author seat 1's ciphertext with its own m", a, AUTHOR, 1, aa1, m_of(a, AUTHOR, 1), "ok")
    posting("author-pass-seat-3", "Author seat 3's ciphertext with its own m", a, AUTHOR, 3, ct_of(a, AUTHOR, 3), m_of(a, AUTHOR, 3), "ok")
    posting("author-as-default", "Author seat 1's ciphertext and m posted for default seat 1", a, DEFAULT, 1, aa1, m_of(a, AUTHOR, 1), "posting-hash")
    posting("default-as-author", "Default seat 1's ciphertext and m posted for author seat 1", a, AUTHOR, 1, da1, m_of(a, DEFAULT, 1), "posting-hash")
    posting("author-default-key", "Author seat 1's posting checked with default seat 1's key", a, AUTHOR, 1, aa1, m_of(a, AUTHOR, 1), "posting-proof", DEFAULT, 1)
    posting("author-wrong-m", "Author seat 1's ciphertext with author seat 2's m", a, AUTHOR, 1, aa1, m_of(a, AUTHOR, 2), "posting-encapsulation")
    posting("author-short-m", "A 31-byte m for author seat 1", a, AUTHOR, 1, aa1, m_of(a, AUTHOR, 1)[:31], "posting-malformed")
    af = made["author-as-default"]
    posting("author-named-default", "The dishonest author seat 1 ciphertext that names the default panel: its proof fails", af, AUTHOR, 1, ct_of(af, AUTHOR, 1), m_of(af, AUTHOR, 1), "posting-proof")
    bs = made["bad-author-share"]
    posting("author-pass-bad-share", "The dishonest client's author seat 2 ciphertext: the public check passes", bs, AUTHOR, 2, ct_of(bs, AUTHOR, 2), m_of(bs, AUTHOR, 2), "ok")

    # Complaints.
    complaints = []

    def complaint(id_, desc, b, panel, seat, ct, m, proof, expect, w=None, key_panel=None):
        kp = key_panel or panel
        got = check_complaint(b["election"]["definitionHash"], panel, seat, b["keys"][kp][seat - 1], b["vote"], ct, m, proof)
        assert got == expect, (id_, got)
        entry = {"id": id_, "description": desc, "ballot": b["id"], "panel": panel, "seat": seat, "keyPanel": kp, "ciphertext": ct.hex(), "m": m.hex(), "proof": se.enc_complaint(proof).hex(), "result": expect}
        if w is not None:
            entry["w"] = str(w)
        complaints.append(entry)

    rng = bv.Rng("share-v4/complaint")
    for b_id, panel, seat, desc, expect in (
        ("bad-author-share", AUTHOR, 2, "Proven: author seat 2's posted shares fail the share check against the author half", "ok"),
        ("bad-default-seal", DEFAULT, 2, "Proven: default seat 2's posted ciphertext doesn't open", "ok"),
        ("author-short-list", AUTHOR, 1, "Proven: author seat 1's posted plaintext has T − 1 shares", "ok"),
        ("author", AUTHOR, 1, "Unfounded: author seat 1's posted shares are valid", "complaint-unfounded"),
    ):
        b = made[b_id]
        w = nonzero_scalar(rng)
        ct, mm = ct_of(b, panel, seat), m_of(b, panel, seat)
        key = b["keys"][panel][seat - 1]
        if expect == "ok":
            proof = prove_complaint(defh, panel, seat, key, b["vote"], ct, mm, w)
        else:
            # An honest trustee never makes this one: its preconditions fail.
            proof = raw_complaint(defh, panel, seat, key, ct, w)
            w = None
        complaint(b_id + "-complaint", desc, b, panel, seat, ct, mm, proof, expect, w)

    ct, mm = ct_of(bs, AUTHOR, 2), m_of(bs, AUTHOR, 2)
    key = bs["keys"][AUTHOR][1]
    good = prove_complaint(defh, AUTHOR, 2, key, bs["vote"], ct, mm, nonzero_scalar(rng))
    complaint("proof-z", "The response z + 1", bs, AUTHOR, 2, ct, mm, dict(good, z=(good["z"] + 1) % L), "complaint-proof")
    complaint("proof-dh", "Another DH value with the same proof", bs, AUTHOR, 2, ct, mm, dict(good, dh=grp.add(good["dh"], G)), "complaint-proof")
    complaint("default-panel-byte", "Proved with the default panel's byte in the challenge for author seat 2", bs, AUTHOR, 2, ct, mm, raw_complaint(defh, DEFAULT, 2, key, ct, nonzero_scalar(rng)), "complaint-proof")
    complaint("version-one-challenge", "Proved under version 1's challenge layout and tag", bs, AUTHOR, 2, ct, mm, raw_complaint(defh, AUTHOR, 2, key, ct, nonzero_scalar(rng), version=1), "complaint-proof")
    complaint("other-panel-key", "Proved with default seat 2's key for author seat 2's posting", bs, AUTHOR, 2, ct, mm, raw_complaint(defh, AUTHOR, 2, bs["keys"][DEFAULT][1], ct, nonzero_scalar(rng)), "complaint-proof")
    complaint("bad-posting", "A complaint about a posting with another seat's m", bs, AUTHOR, 2, ct, m_of(bs, AUTHOR, 1), good, "posting-encapsulation")

    data = {
        "format": "abolish-share-encryption-v4-vectors/1",
        "title": "Share encryption under ballot version 4: ciphertexts of both panels, decryption, postings and complaints",
        "spec": "docs/spec/share-encryption.md",
        "generator": (
            "Printed by packages/crypto/scripts/share-encryption-v4-vectors.py, an implementation of "
            "docs/spec/share-encryption.md (Ballot version 4) with Python's integers and hashlib, sharing no code with "
            "packages/crypto or any @noble library; it reuses share-encryption-vectors.py's ML-KEM-768 (checked first "
            "against the accumulated FIPS 203 vectors of Go's crypto/mlkem tests), ChaCha20-Poly1305 (checked against "
            "RFC 8439 §2.8.2 and A.5) and ciphertext codec, and ballot-v4-vectors.py's elections and ballots. Every "
            "ballot's committed vote passes version 4's validity check with its real share hashes, and every decryption, "
            "posting and complaint is checked to give the result it lists. The randomness is SHA-512 and SHA-256 of fixed "
            "labels: test data only."
        ),
        "recordType": "0x0002",
        "version": VERSION,
        "tags": {
            "kem": se.KEM_TAG.decode(),
            "aad": se.AAD_TAG.decode(),
            "ciphertext": se.CT_TAG.decode(),
            "ephemeral": se.EPHEMERAL_TAG.decode(),
            "complaint": COMPLAINT_TAG_2.decode(),
        },
        "elections": {name: b4.election_json(e) for name, e in elections.items()},
        "keySets": {name: [se.key_json(k) for k in keys] for name, keys in key_sets.items()},
        "ballots": ballots,
        "decryptFailures": decrypt_failures,
        "postings": postings,
        "complaints": complaints,
    }
    (out / "share-encryption-v4.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
