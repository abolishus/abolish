#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/panel-tally.json.

A second implementation of docs/spec/tally.md, Author panel: each panel's
aggregates and summed shares over the one counted set, its partial opening
from `k_P` of its own seats, the tally opening version 3 (record type 0x0006)
that publishes it, its signed message under abolish/v1/sig/partial-opening and
its strict decoder, the opening checks of version 3 (the author panel first,
tally-author-late, the range checks on the sum of both partial openings) with
the boarding rule's tally-early, the summed-share message version 2 (record
type 0x000b) with the panel in its associated data and signature, and the
destruction statement version 2 (record type 0x000f) with the per-panel
destruction report. It is written from the spec with Python's integers and
hashlib. Ballots of version 4 come from ballot-v4-vectors.py (its two
sharings), sums and combination from tally-vectors.py, ML-KEM-768 and
ChaCha20-Poly1305 from share-encryption-vectors.py (checked against Go's
accumulated FIPS 203 vectors and RFC 8439 first), ristretto255 from
group-vectors.py (self-checked) and P-256 ECDSA from trustee-vectors.py, which
reproduces RFC 6979 Appendix A.2.5 first. Nothing here shares code with
packages/crypto or any @noble library.

Every secret comes from SHA-256 over a fixed label, and each record lists the
randomness or signing secret that made it, so any implementation reproduces
its bytes. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/panel-tally-vectors.py <out-dir> [--full]
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


b4 = _load("ballot_v4_vectors", "ballot-v4-vectors.py")
tv = _load("tally_vectors", "tally-vectors.py")
se = _load("share_encryption_vectors", "share-encryption-vectors.py")
ecdsa = _load("trustee_vectors", "trustee-vectors.py")
bv, grp, d6 = tv.bv, tv.grp, b4.d6

L = grp.L
G = grp.BASE
MAX_OPTIONS = 64
MAX_SEALED = 4 + 64 * MAX_OPTIONS + 16
NONCE = bytes(12)

TALLY_OPENING, OPENING_VERSION = 0x0006, 3
SUMMED_SHARE, SUMMED_VERSION = 0x000B, 2
DESTRUCTION, DESTRUCTION_VERSION = 0x000F, 2
PARTIAL_TAG = b"abolish/v1/sig/partial-opening"
V1_OPENING_TAG = b"abolish/v1/sig/tally-opening"
AGGREGATE_TAG = b"abolish/v1/tally-aggregate"
KEM_TAG = b"abolish/v1/kem/summed-share"
AAD_TAG = b"abolish/v1/kem/summed-share-aad"
SUMMED_TAG = b"abolish/v1/sig/summed-share"
DESTRUCTION_TAG = b"abolish/v1/sig/destruction"

u8, u16, u32 = bv.u8, bv.u16, bv.u32
H, ds = bv.H, bv.ds
DEFAULT, AUTHOR = 1, 2


def scalar(x):
    return x.to_bytes(32, "little")


def header(record_type, version):
    return record_type.to_bytes(2, "big") + u8(version)


def sign(tag, d, m):
    _, r, s = ecdsa.ecdsa_sign(d, ds(tag, m))
    return ecdsa.sig_bytes(r, s)


def p256_key(d):
    return ecdsa.compress(ecdsa.mul(d, ecdsa.G))


def shares_json(opening):
    return [{"v": str(s["v"]), "r": str(s["r"])} for s in opening]


class Reject(Exception):
    def __init__(self, code, offset):
        super().__init__(code, offset)
        self.code, self.offset = code, offset


class Reader:
    """docs/spec/notation.md, Strict decoding: fixed fields, offsets of the first failing byte."""

    def __init__(self, b):
        self.b, self.at = b, 0

    def take(self, n):
        if len(self.b) - self.at < n:
            raise Reject("truncated", self.at)
        out = self.b[self.at : self.at + n]
        self.at += n
        return out

    def header(self, record_type, pinned):
        if int.from_bytes(self.take(2), "big") != record_type:
            raise Reject("unknown-record-type", 0)
        v_at = self.at
        if self.take(1)[0] != pinned:
            raise Reject("profile-mismatch", v_at)

    def enum(self, allowed):
        at = self.at
        v = self.take(1)[0]
        if v not in allowed:
            raise Reject("invalid-enum", at)
        return v

    def signature(self):
        at = self.at
        sig = self.take(64)
        r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
        if not (1 <= r < ecdsa.N and 1 <= s <= ecdsa.HALF_N):
            raise Reject("non-canonical", at)
        return sig

    def end(self):
        if self.at != len(self.b):
            raise Reject("trailing-bytes", self.at)


# --- Panel aggregates (Panel aggregates and summed shares) -------------------------


def aggregate_hash(agg):
    """H(DS("abolish/v1/tally-aggregate", list<element, MAX_OPTIONS> of each option's Ĉ^P)), identity allowed."""
    return H(ds(AGGREGATE_TAG, u32(len(agg)) + b"".join(grp.encode(row[0]) for row in agg)))


# --- Tally opening version 3 (Opening record (version 3)) ---------------------------


def enc_opening_list(opening):
    return u32(len(opening)) + b"".join(scalar(s["v"]) + scalar(s["r"]) for s in opening)


def opening_message(o):
    """u16(0x0006) ‖ u8(3) ‖ definition_hash ‖ u8(cell) ‖ u8(panel) ‖ aggregate_hash ‖ u8(signer) ‖ encode(opening)."""
    return (
        header(TALLY_OPENING, OPENING_VERSION)
        + o["definitionHash"]
        + u8(o["cell"])
        + u8(o["panel"])
        + o["aggregateHash"]
        + u8(o["signer"])
        + enc_opening_list(o["opening"])
    )


def encode_opening(o):
    return opening_message(o) + o["signature"]


def decode_opening(b):
    """Version 3 only; `panel` is a plain u8, compared with the election only when sorted."""
    r = Reader(b)
    r.header(TALLY_OPENING, OPENING_VERSION)
    o = {"definitionHash": r.take(32), "cell": r.take(1)[0], "panel": r.take(1)[0], "aggregateHash": r.take(32), "signer": r.take(1)[0]}
    count_at = r.at
    count = int.from_bytes(r.take(4), "big")
    if count > MAX_OPTIONS:
        raise Reject("length-over-max", count_at)
    opening = []
    for _ in range(count):
        pair = {}
        for key in ("v", "r"):
            x_at = r.at
            x = int.from_bytes(r.take(32), "little")
            if x >= L:
                raise Reject("non-canonical", x_at)
            pair[key] = x
        opening.append(pair)
    o["opening"] = opening
    o["signature"] = r.signature()
    r.end()
    return o


def attribution(registered, o):
    """Signature: seat (panel, signer) if panel is 1 or 2, signer is in that panel's set and the key verifies."""
    keys = registered.get(o["panel"], {})
    key = keys.get(o["signer"])
    if key is None:
        return None
    return o["signer"] if ecdsa.verify(key, ds(PARTIAL_TAG, opening_message(o)), o["signature"]) else None


def opens(agg, opening):
    for j, s in enumerate(opening):
        if not grp.equal(bv.pedersen(s["v"], s["r"]), agg[j][0]):
            return j
    return None


def panel_openings(m, agg, openings):
    expected = aggregate_hash(agg)
    passing, failing = [], []
    for at, seg, signer, o in openings:
        if len(o["opening"]) != m:
            failing.append({"at": at, "signer": signer, "code": "tally-missing"})
        elif o["aggregateHash"] != expected:
            failing.append({"at": at, "signer": signer, "code": "tally-aggregate"})
        else:
            j = opens(agg, o["opening"])
            if j is None:
                passing.append((at, seg, signer, o["opening"]))
            else:
                failing.append({"at": at, "signer": signer, "code": "tally-opening", "option": j})
    return passing, failing


def report(p):
    passing, failing = p
    return {"passing": [{"at": at, "signer": s} for at, _, s, _ in passing], "failing": failing}


def verdict(e, n_ballots, author, default, author_late):
    out = {"default": report(default), "author": report(author)}
    panels = [(AUTHOR, author), (DEFAULT, default)]
    # 1. tally-missing, the author panel first; Whose failure: tally-author-late.
    for panel, (passing, failing) in panels:
        if not passing and all(f["code"] == "tally-missing" for f in failing):
            if panel == DEFAULT and author_late:
                return {"ok": False, "code": "tally-author-late", **out}
            return {"ok": False, "code": "tally-missing", "panel": panel, **out}
    # 2. tally-opening.
    for panel, (passing, failing) in panels:
        if not passing:
            bad = next(f for f in failing if f["code"] != "tally-missing")
            extra = {"option": bad["option"]} if "option" in bad else {}
            return {"ok": False, "code": "tally-opening", "panel": panel, **extra, **out}
    # 3. tally-conflict.
    for panel, (passing, _) in panels:
        if any(p[3] != passing[0][3] for p in passing):
            return {"ok": False, "code": "tally-conflict", "panel": panel, **out}
    # 4. tally-range on V = V^D + V^A mod ℓ.
    counts = [(d["v"] + a["v"]) % L for d, a in zip(default[0][0][3], author[0][0][3])]
    for j, v in enumerate(counts):
        if v > n_ballots:
            return {"ok": False, "code": "tally-range", "option": j, **out}
    # 5. tally-question-range.
    for q, (qq, o) in enumerate(zip(e["questions"], e["offsets"])):
        total = sum(counts[o : o + qq["optionCount"]])
        if total < qq["min"] * n_ballots or total > qq["max"] * n_ballots:
            return {"ok": False, "code": "tally-question-range", "question": q, **out}
    return {"ok": True, "counts": [str(v) for v in counts], **out}


def check_partial_tally(e, registered, cells, entries, s_a):
    """Opening checks (version 3) and Boarding (version 3)'s tally-early, over (segment, payload) entries in board order."""
    m = e["optionTotal"]
    by_cell = [{DEFAULT: [], AUTHOR: []} for _ in cells]
    stray, rejected = [], []
    for at, (seg, b) in enumerate(entries):
        try:
            o = decode_opening(b)
        except Reject as err:
            rejected.append({"at": at, "error": err.code})
            continue
        signer = attribution(registered, o)
        if o["definitionHash"] == e["definitionHash"] and o["cell"] < len(cells) and o["panel"] in (DEFAULT, AUTHOR):
            by_cell[o["cell"]][o["panel"]].append((at, seg, signer, o))
        else:
            stray.append({"at": at, "signer": signer, "panel": o["panel"]})
    evaluated = []
    for c, ballots in enumerate(cells):
        agg_a = tv.aggregate(m, e["authorThreshold"], [b["authorVss"] for b in ballots])
        agg_d = tv.aggregate(m, e["threshold"], [b["vss"] for b in ballots])
        evaluated.append((panel_openings(m, agg_a, by_cell[c][AUTHOR]), panel_openings(m, agg_d, by_cell[c][DEFAULT])))
    author_late = any(not any(seg <= s_a for _, seg, _, _ in a[0]) for a, _ in evaluated)
    firsts = [a[0][0][0] if a[0] else None for a, _ in evaluated]
    all_author = None if None in firsts else max(firsts)
    early = sorted(
        ({"at": at, "signer": s} for c in by_cell for at, _, s, _ in c[DEFAULT] if all_author is None or at < all_author),
        key=lambda x: x["at"],
    )
    checked = [verdict(e, len(cells[c]), a, d, author_late) for c, (a, d) in enumerate(evaluated)]
    result = {"ok": all(c["ok"] for c in checked), "cells": checked, "stray": stray, "early": early, "rejected": rejected}
    for c, r in enumerate(checked):
        if not r["ok"]:
            result["failure"] = {"cell": c, "code": r["code"], **{k: r[k] for k in ("panel", "option", "question") if k in r}}
            break
    return result


# --- Summed-share message version 2 ------------------------------------------------


def summed_body(msg):
    return (
        msg["definitionHash"]
        + u8(msg["cell"])
        + u8(msg["panel"])
        + msg["aggregateHash"]
        + u8(msg["sender"])
        + u8(msg["recipient"])
        + msg["ctM"]
        + grp.encode(msg["ctDh"])
        + u32(len(msg["sealed"]))
        + msg["sealed"]
    )


def summed_signed(msg):
    return header(SUMMED_SHARE, SUMMED_VERSION) + summed_body(msg)


def encode_summed(msg):
    return summed_signed(msg) + msg["signature"]


def decode_summed(b):
    r = Reader(b)
    r.header(SUMMED_SHARE, SUMMED_VERSION)
    msg = {"definitionHash": r.take(32), "cell": r.take(1)[0], "panel": r.enum((DEFAULT, AUTHOR)), "aggregateHash": r.take(32), "sender": r.take(1)[0], "recipient": r.take(1)[0], "ctM": r.take(1088)}
    dh_at = r.at
    dh_b = r.take(32)
    p = grp.decode(dh_b)
    if dh_b == bytes(32) or p is None:
        raise Reject("non-canonical", dh_at)
    msg["ctDh"] = p
    n_at = r.at
    n = int.from_bytes(r.take(4), "big")
    if n > MAX_SEALED:
        raise Reject("length-over-max", n_at)
    msg["sealed"] = r.take(n)
    msg["signature"] = r.signature()
    r.end()
    return msg


def combine(ss_m, ss_dh, ct_dh, dh):
    return H(ds(KEM_TAG, ss_m + grp.encode(ss_dh) + grp.encode(ct_dh) + grp.encode(dh)))


def summed_aad(definition_hash, cell, panel, agg_hash, sender, recipient):
    return ds(AAD_TAG, u16(SUMMED_SHARE) + u8(SUMMED_VERSION) + definition_hash + u8(cell) + u8(panel) + agg_hash + u8(sender) + u8(recipient))


def seal(definition_hash, cell, panel, agg_hash, sender, recipient, kem_key, plain, mu, e, signing_secret, aad_panel=None):
    ss_m, ct_m = se.encaps_internal(kem_key["ek"], mu)
    ct_dh = grp.mul(e % L, G)
    k = combine(ss_m, grp.mul(e % L, kem_key["dh"]), ct_dh, kem_key["dh"])
    a = summed_aad(definition_hash, cell, panel if aad_panel is None else aad_panel, agg_hash, sender, recipient)
    msg = {
        "definitionHash": definition_hash,
        "cell": cell,
        "panel": panel,
        "aggregateHash": agg_hash,
        "sender": sender,
        "recipient": recipient,
        "ctM": ct_m,
        "ctDh": ct_dh,
        "sealed": se.aead_seal(k, NONCE, a, plain),
    }
    msg["signature"] = sign(SUMMED_TAG, signing_secret, summed_signed(msg))
    return msg, {"ssM": ss_m.hex(), "key": k.hex(), "aad": a.hex(), "signed": summed_signed(msg).hex()}


def receive(election, panel, recipient, kem_key, b):
    """Summed-share message (version 2), the receiving checks in version 1's order, at seat (panel, recipient)."""
    try:
        msg = decode_summed(b)
    except Reject:
        return ("summed-malformed",)
    aggregates = election["aggregates"][panel]
    key = election["registered"][panel].get(msg["sender"])
    if (
        msg["definitionHash"] != election["definitionHash"]
        or msg["panel"] != panel
        or msg["cell"] >= len(aggregates)
        or msg["recipient"] != recipient
        or msg["sender"] == recipient
        or key is None
        or msg["aggregateHash"] != aggregate_hash(aggregates[msg["cell"]])
    ):
        return ("summed-context",)
    if not ecdsa.verify(key, ds(SUMMED_TAG, summed_signed(msg)), msg["signature"]):
        return ("summed-signature",)
    ss_m = se.decaps_internal(kem_key["dk"], msg["ctM"])
    k = combine(ss_m, grp.mul(kem_key["x"], msg["ctDh"]), msg["ctDh"], kem_key["dh"])
    pt = se.aead_open(k, NONCE, summed_aad(msg["definitionHash"], msg["cell"], msg["panel"], msg["aggregateHash"], msg["sender"], msg["recipient"]), msg["sealed"])
    shares = None if pt is None else se.dec_shares(pt, election["m"])
    if shares is None:
        return ("summed-decrypt",)
    if not bv.check_shares(aggregates[msg["cell"]], msg["sender"], shares):
        return ("summed-check",)
    return ("ok", msg["cell"], msg["sender"], shares)


# --- Destruction statement version 2 -------------------------------------------------


def destruction_message(definition_hash, panel, signer):
    return header(DESTRUCTION, DESTRUCTION_VERSION) + definition_hash + u8(panel) + u8(signer)


def decode_destruction(b):
    r = Reader(b)
    r.header(DESTRUCTION, DESTRUCTION_VERSION)
    s = {"definitionHash": r.take(32), "panel": r.enum((DEFAULT, AUTHOR)), "signer": r.take(1)[0]}
    s["signature"] = r.signature()
    r.end()
    return s


def destruction_segment(first_passing, s_t):
    """min(s_O + 1, s_T), s_O the latest over cells and both panels; s_T if any cell lacks either panel's."""
    segs = [x for c in first_passing for x in (c["default"], c["author"])]
    if None in segs:
        return s_t
    return min(max(segs) + 1, s_t)


def check_destruction(definition_hash, registered, entries, first_passing, s_t):
    frm = destruction_segment(first_passing, s_t)
    first, duplicates, unattributed, stray, rejected = {}, [], [], [], []
    for at, (seg, b) in enumerate(entries):
        try:
            s = decode_destruction(b)
        except Reject as err:
            rejected.append({"at": at, "error": err.code})
            continue
        key = registered[s["panel"]].get(s["signer"])
        msg = destruction_message(s["definitionHash"], s["panel"], s["signer"])
        seat = s["signer"] if key is not None and ecdsa.verify(key, ds(DESTRUCTION_TAG, msg), s["signature"]) else None
        if s["definitionHash"] != definition_hash:
            stray.append({"at": at, "panel": s["panel"], "signer": seat})
        elif seat is None:
            unattributed.append({"at": at})
        elif (s["panel"], seat) in first:
            duplicates.append({"at": at, "panel": s["panel"], "seat": seat})
        else:
            first[(s["panel"], seat)] = (at, seg)
    seats = []
    for panel in (DEFAULT, AUTHOR):
        for i in sorted(registered[panel]):
            if (panel, i) not in first:
                seats.append({"panel": panel, "seat": i, "code": "destruction-missing"})
            else:
                at, seg = first[(panel, i)]
                seats.append({"panel": panel, "seat": i, "code": "destroyed" if seg >= frm else "destruction-early", "at": at})
    return {"from": frm, "seats": seats, "duplicates": duplicates, "unattributed": unattributed, "stray": stray, "rejected": rejected}


# --- Elections ------------------------------------------------------------------------

# Definition version 6 with an author panel pins tally-opening version 3 and
# board-entry version 7 (verifier.md, 2.3), with ballot-v4-vectors.py's other pins.
PINS = [(1, 6), (2, 4), (3, 3), (4, 1), (5, 1), (6, 3), (7, 7), (8, 1), (9, 2)]


def election(label, questions, k, n, k_a, n_a):
    d = d6.variant(
        d6.TYPICAL,
        profile={"protocol_major": 1, "pins": PINS},
        election_id=b4.det("panel-tally election " + label),
        questions=[d6.d5.q(*x) for x in questions],
        threshold=k,
        panel_size=n,
        ceremony_transcript_hash=b4.det("panel-tally transcript " + label),
        **d6.SEALED_EVERYDAY,
        author_threshold=k_a,
        author_keys=d6.AUTHOR_KEYS[:n_a],
        author_transcript_hash=b4.det("panel-tally author transcript " + label),
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
        "definitionHash": H(ds(b4.DEFINITION_TAG, enc)),
        "ceremonyTranscriptHash": d["ceremony_transcript_hash"],
        "authorTranscriptHash": d["author_transcript_hash"],
        "questions": qs,
        "offsets": offsets,
        "optionTotal": o,
        "threshold": k,
        "panelSize": n,
        "authorThreshold": k_a,
        "authorPanelSize": n_a,
        "cells": b4.b3.cells_of(d),
    }


def seats_of(label, n, registered):
    kem = se.trustee_keys(f"panel-tally/{label}", n)
    signing = {i: ecdsa.secret(f"panel-tally/{label}/seat-{i}".encode()) for i in range(1, n + 1)}
    keys = {i: p256_key(d) for i, d in signing.items()}
    return {"kem": kem, "signing": signing, "keys": keys, "registered": {i: keys[i] for i in registered}}


def make_cell(e, label, cell, votes_list):
    """Counted ballots of version 4 and each panel's aggregate, every seat's sums and the honest partial opening."""
    m = e["optionTotal"]
    ballots, default_shares, author_shares = [], [], []
    for b, votes in enumerate(votes_list):
        ctx = b4.context(e, f"panel-tally/{label}/{b}", cell)
        vote, _, shares, a_shares = b4.make_ballot(f"panel-tally/{e['label']}/{label}/{b}", e, ctx, votes)
        ballots.append(vote)
        default_shares.append(shares)
        author_shares.append(a_shares)
    out = {"ballots": ballots}
    for panel, k, n, key, per in ((DEFAULT, e["threshold"], e["panelSize"], "vss", default_shares), (AUTHOR, e["authorThreshold"], e["authorPanelSize"], "authorVss", author_shares)):
        agg = tv.aggregate(m, k, [b[key] for b in ballots])
        summed = {i: tv.sum_shares(m, [s[i - 1] for s in per]) for i in range(1, n + 1)}
        for i in summed:
            assert bv.check_shares(agg, i, summed[i])
        out[panel] = {"aggregate": agg, "hash": aggregate_hash(agg), "summed": summed, "opening": tv.honest_opening(m, summed, k)}
    # The two partial openings sum to the count, and each opens its own panel's aggregate.
    for panel in (DEFAULT, AUTHOR):
        assert opens(out[panel]["aggregate"], out[panel]["opening"]) is None
    counts = [(d["v"] + a["v"]) % L for d, a in zip(out[DEFAULT]["opening"], out[AUTHOR]["opening"])]
    assert counts == [sum(v[j] for v in votes_list) for j in range(m)], (label, counts)
    out["counts"] = counts
    return out


def halves_json(cell):
    return [{"vss": bv.enc_vss(b["vss"]).hex(), "authorVss": bv.enc_vss(b["authorVss"]).hex()} for b in cell["ballots"]]


def bump(opening, j, key="v"):
    return [dict(s, **{key: (s[key] + 1) % L}) if i == j else s for i, s in enumerate(opening)]


def main():
    out = pathlib.Path(sys.argv[1])
    grp.self_check()
    ecdsa.self_check()
    se.aead_self_check()
    se.mlkem_self_check(10000 if "--full" in sys.argv[2:] else 100)

    # The main election: one pick-up-to-one question over 3 options, a 2-of-3
    # default panel and a 2-of-3 author panel whose seat 3 took part but
    # wasn't qualified, so its keys aren't registered. Four cells.
    e = election("main", [(3, 0, 1)], 2, 3, 2, 3)
    dseats = seats_of("main/default", 3, (1, 2, 3))
    aseats = seats_of("main/author", 3, (1, 2))
    registered = {DEFAULT: dseats["registered"], AUTHOR: aseats["registered"]}
    secrets = {DEFAULT: dseats["signing"], AUTHOR: aseats["signing"]}
    m = e["optionTotal"]
    assert e["cells"] == 4
    other_definition = bv.Rng("panel-tally/other-definition").bytes32()

    cells = [
        make_cell(e, "cell-0", 0, [[1, 0, 0], [0, 0, 1], [1, 0, 0]]),
        make_cell(e, "cell-1", 1, [[0, 1, 0], [0, 1, 0]]),
        make_cell(e, "cell-2", 2, []),
        make_cell(e, "cell-3", 3, [[0, 0, 1]]),
    ]
    assert cells[2][DEFAULT]["opening"] == [{"v": 0, "r": 0}] * 3
    # A partial opening's V is uniform: it is no count, and never range-checked.
    assert any(s["v"] > 3 for c in cells for p in (DEFAULT, AUTHOR) for s in c[p]["opening"])

    # --- Combination: each panel's partial opening from k_P of its own seats.
    combinations = []
    for c, cell in enumerate(cells[:2]):
        for panel, k, n in ((DEFAULT, e["threshold"], e["panelSize"]), (AUTHOR, e["authorThreshold"], e["authorPanelSize"])):
            summed = cell[panel]["summed"]
            agg, got = tv.open_cell(m, k, n, [b["vss" if panel == DEFAULT else "authorVss"] for b in cell["ballots"]], {i: summed[i] for i in (3, 2)})
            # open_cell's range checks are version 1's; here only the opening of Ĉ^P matters.
            q = [2, 3][:k]
            lam = tv.lagrange(q)
            opening = [{"v": sum(l * summed[i][j]["v"] for l, i in zip(lam, q)) % L, "r": sum(l * summed[i][j]["r"] for l, i in zip(lam, q)) % L} for j in range(m)]
            assert opening == cell[panel]["opening"] and opens(agg, opening) is None
            combinations.append(
                {
                    "id": f"cell-{c}-panel-{panel}",
                    "description": f"Cell {c}'s {'default' if panel == DEFAULT else 'author'} half combined by seats 2 and 3 of its panel",
                    "cell": c,
                    "panel": panel,
                    "summed": {str(i): shares_json(summed[i]) for i in (2, 3)},
                    "combined": q,
                    "opening": shares_json(opening),
                }
            )
    wrong = {2: bump(cells[0][AUTHOR]["summed"][2], 1), 3: cells[0][AUTHOR]["summed"][3]}
    combinations.append(
        {
            "id": "author-quorum",
            "description": "Cell 0's author half with seat 2's option-1 sum one more: seat 2 is excluded and seat 3 alone is short of k_A = 2 (tally-quorum)",
            "cell": 0,
            "panel": AUTHOR,
            "summed": {str(i): shares_json(s) for i, s in wrong.items()},
            "result": {"ok": False, "code": "tally-quorum", "excluded": [2]},
        }
    )
    assert not bv.check_shares(cells[0][AUTHOR]["aggregate"], 2, wrong[2])

    # --- Partial openings, reproduced byte for byte.
    def record(cell, panel, signer, opening=None, agg=None, definition=None, d=None, signed_as=None, cell_set=cells):
        if opening is None:
            opening = cell_set[cell][panel if panel in (DEFAULT, AUTHOR) else DEFAULT]["opening"]
        if agg is None:
            agg = cell_set[cell][panel if panel in (DEFAULT, AUTHOR) else DEFAULT]["hash"] if cell < len(cell_set) else bv.Rng("panel-tally/no-cell").bytes32()
        o = {"definitionHash": definition or e["definitionHash"], "cell": cell, "panel": panel, "aggregateHash": agg, "signer": signer, "opening": opening}
        if d is None:
            d = secrets[panel if panel in (DEFAULT, AUTHOR) else DEFAULT][signer]
        o["signature"] = sign(PARTIAL_TAG, d, opening_message(signed_as or o))
        return o

    openings = []

    def published(id_, desc, cell, panel, signer):
        o = record(cell, panel, signer)
        b = encode_opening(o)
        assert decode_opening(b) == o and attribution(registered, o) == signer
        openings.append(
            {
                "id": id_,
                "description": desc,
                "signingSecret": secrets[panel][signer].to_bytes(32, "big").hex(),
                "signingKey": (dseats if panel == DEFAULT else aseats)["keys"][signer].hex(),
                "definitionHash": e["definitionHash"].hex(),
                "cell": cell,
                "panel": panel,
                "aggregateHash": o["aggregateHash"].hex(),
                "signer": signer,
                "opening": shares_json(o["opening"]),
                "message": opening_message(o).hex(),
                "signature": o["signature"].hex(),
                "encoding": b.hex(),
            }
        )
        return o, b

    author0, author0_b = published("cell-0-author-seat-1", "Cell 0's author partial opening, signed by author seat 1", 0, AUTHOR, 1)
    published("cell-0-default-seat-1", "Cell 0's default partial opening, signed by default seat 1: same cell and index, another panel", 0, DEFAULT, 1)
    published("cell-2-author-seat-2", "The empty cell 2's author partial opening: every (V, R) is (0, 0), over the identity aggregate", 2, AUTHOR, 2)
    # A version-1 signer and a version-3 signer of one key never share a
    # message: version 3's starts with its header and carries the panel.
    v1_message = author0["definitionHash"] + u8(0) + author0["aggregateHash"] + u8(1) + enc_opening_list(author0["opening"])
    assert opening_message(author0)[3:] != v1_message

    decode_errors = []

    def rejected(id_, desc, b, code, offset):
        try:
            decode_opening(b)
        except Reject as err:
            assert (err.code, err.offset) == (code, offset), (id_, err.code, err.offset)
        else:
            raise AssertionError(id_)
        decode_errors.append({"id": id_, "description": desc, "encoding": b.hex(), "error": code, "offset": offset})

    count_at = 3 + 32 + 1 + 1 + 32 + 1
    sig_at = len(author0_b) - 64
    rejected("empty", "No bytes", b"", "truncated", 0)
    rejected("version-1", "A version-1 header where version 3 is pinned", author0_b[:2] + b"\x01" + author0_b[3:], "profile-mismatch", 2)
    rejected("summed-share-type", "Record type 0x000b where a tally opening is read", b"\x00\x0b" + author0_b[2:], "unknown-record-type", 0)
    rejected("truncated-in-signature", "The last byte of the signature missing", author0_b[:-1], "truncated", sig_at)
    rejected("trailing-byte", "One byte after the signature", author0_b + b"\x00", "trailing-bytes", len(author0_b))
    rejected("options-over-max", "A count of MAX_OPTIONS + 1", author0_b[:count_at] + u32(MAX_OPTIONS + 1) + author0_b[count_at + 4 :], "length-over-max", count_at)
    v_l = author0_b[: count_at + 4] + scalar(L) + author0_b[count_at + 4 + 32 :]
    rejected("v-equals-order", "Option 0's V encoded as ℓ", v_l, "non-canonical", count_at + 4)
    high_s = bytearray(author0_b)
    high_s[sig_at + 32 :] = (ecdsa.N - int.from_bytes(author0_b[sig_at + 32 :], "big")).to_bytes(32, "big")
    rejected("signature-high-s", "The signature's s replaced by n − s", bytes(high_s), "non-canonical", sig_at)
    panel0 = record(0, 0, 1)
    assert decode_opening(encode_opening(panel0))["panel"] == 0

    # --- The opening checks over a board.
    S_A = 6
    tallies = []

    def board(*items):
        """Each item: (segment, record or raw bytes)."""
        return [(seg, o if isinstance(o, bytes) else encode_opening(o)) for seg, o in items]

    def tally(id_, desc, entries, expect, cell_set=cells, s_a=S_A):
        cs = [c["ballots"] for c in cell_set]
        got = check_partial_tally(e, registered, cs, entries, s_a)
        for key, want in expect.items():
            assert got.get(key) == want, (id_, key, got.get(key), want)
        tallies.append(
            {
                "id": id_,
                "description": desc,
                "cells": [halves_json(c) for c in cell_set],
                "authorDeadline": s_a,
                "entries": [{"segment": seg, "payload": b.hex()} for seg, b in entries],
                "result": got,
            }
        )
        return got

    authors = [(5, record(c, AUTHOR, 1 + c % 2)) for c in range(4)]
    defaults = [(7, record(c, DEFAULT, 1 + c % 3)) for c in range(4)]
    honest = tally("honest", "Every cell's author partial opening in segment 5, then every default one in segment 7: each cell's count is the sum of its two partial openings", board(*authors, *defaults), {"ok": True})
    assert [c["counts"] for c in honest["cells"]] == [[str(x) for x in c["counts"]] for c in cells]
    tally(
        "author-missing",
        "Cell 1 has no author partial opening: tally-missing for the author panel, and every default partial opening was boarded early (tally-early, the operator's)",
        board(*[a for i, a in enumerate(authors) if i != 1], *defaults),
        {"ok": False, "failure": {"cell": 1, "code": "tally-missing", "panel": AUTHOR}, "early": [{"at": i, "signer": 1 + (i - 3) % 3} for i in range(3, 7)]},
    )
    tally("default-missing", "Cell 2 has no default partial opening while every author one was timely: tally-missing for the default panel", board(*authors, *[x for i, x in enumerate(defaults) if i != 2]), {"ok": False, "failure": {"cell": 2, "code": "tally-missing", "panel": DEFAULT}})
    late_authors = [authors[0], authors[1], authors[2], (8, authors[3][1])]
    tally(
        "default-missing-author-late",
        "Cell 3's author partial opening reaches the board in segment 8, after s_A = 6, and cell 2 has no default one: cell 2 fails tally-author-late (the author panel's or the operator's, never the default panel's)",
        board(*late_authors, *[x for i, x in enumerate(defaults) if i != 2]),
        {"ok": False, "failure": {"cell": 2, "code": "tally-author-late"}},
    )
    tally(
        "author-late-counted",
        "Cell 3's author partial opening is late (segment 8), but every default one still made it, boarded after it: the count stands whoever was late",
        board(*late_authors, *[(9, o) for _, o in defaults]),
        {"ok": True, "early": []},
    )
    tally(
        "author-missing-late",
        "Cell 3 has no author partial opening at all: tally-missing for the author panel, not tally-author-late, since the author panel is checked first",
        board(*authors[:3], *defaults[:3]),
        {"ok": False, "failure": {"cell": 3, "code": "tally-missing", "panel": AUTHOR}},
    )
    tally(
        "default-failing",
        "Cell 0's only default partial opening, by default seat 2, has option 1's V one more: tally-opening for the default panel at option 1, attributed to default seat 2",
        board(*authors, (7, record(0, DEFAULT, 2, bump(cells[0][DEFAULT]["opening"], 1))), *defaults[1:]),
        {"ok": False, "failure": {"cell": 0, "code": "tally-opening", "panel": DEFAULT, "option": 1}},
    )
    tally(
        "author-failing-beside-honest",
        "Cell 0's author partial opening by author seat 1 has option 2's R one more, then author seat 2's honest one: the cell passes, the failure reported against author seat 1",
        board((5, record(0, AUTHOR, 1, bump(cells[0][AUTHOR]["opening"], 2, "r"))), (5, record(0, AUTHOR, 2)), *authors[1:], *defaults),
        {"ok": True},
    )
    stale = make_cell(e, "cell-1", 1, [[0, 1, 0]])
    tally(
        "author-other-counted-set",
        "Cell 1's only author partial opening is over a counted set without its last ballot: tally-aggregate, so cell 1 fails tally-opening for the author panel with no option",
        board(authors[0], (5, record(1, AUTHOR, 2, stale[AUTHOR]["opening"], agg=stale[AUTHOR]["hash"])), *authors[2:], *defaults),
        {"ok": False, "failure": {"cell": 1, "code": "tally-opening", "panel": AUTHOR}},
    )
    relabelled = dict(author0, panel=DEFAULT)
    tally(
        "panel-relabel",
        "Author seat 1's signed partial opening of cell 0, its panel byte changed to 1, is cell 0's only default one: over the author aggregate (tally-aggregate) and unattributed, so no default seat is framed, and cell 0 fails tally-opening for the default panel",
        board(*authors, (7, relabelled), *defaults[1:]),
        {"ok": False, "failure": {"cell": 0, "code": "tally-opening", "panel": DEFAULT}},
    )
    tally(
        "author-key-as-default-seat",
        "Cell 0's default partial opening names default seat 1 but is signed by author seat 1's key: it passes, unattributed",
        board(*authors, (7, record(0, DEFAULT, 1, d=secrets[AUTHOR][1])), *defaults[1:]),
        {"ok": True},
    )
    tally(
        "stray",
        "Honest openings plus strays: panel 0 and panel 3 (no panel the election has, so no seat is attributed), cell 4 (attributed to author seat 1) and another definition (attributed to default seat 2)",
        board(*authors, *defaults, (7, record(0, 0, 1, d=secrets[DEFAULT][1])), (7, record(0, 3, 1, d=secrets[AUTHOR][1])), (7, record(4, AUTHOR, 1, cells[0][AUTHOR]["opening"])), (7, record(1, DEFAULT, 2, definition=other_definition))),
        {"ok": True, "stray": [{"at": 8, "signer": None, "panel": 0}, {"at": 9, "signer": None, "panel": 3}, {"at": 10, "signer": 1, "panel": AUTHOR}, {"at": 11, "signer": 2, "panel": DEFAULT}]},
    )
    tally(
        "early",
        "Cell 0's default partial opening is boarded before cell 3's author one: tally-early, the operator's, and it still counts",
        board(*authors[:3], defaults[0], authors[3], *defaults[1:]),
        {"ok": True, "early": [{"at": 3, "signer": 1}]},
    )
    tally(
        "short-default",
        "Cell 1's only default partial opening has two entries for three options: tally-missing for the default panel, reported against default seat 2",
        board(*authors, defaults[0], (7, record(1, DEFAULT, 2, cells[1][DEFAULT]["opening"][:2])), *defaults[2:]),
        {"ok": False, "failure": {"cell": 1, "code": "tally-missing", "panel": DEFAULT}},
    )
    over = [make_cell(e, "range", 0, [[2, 0, 0]]), cells[1], cells[2], cells[3]]
    tally(
        "range",
        "Cell 0's only ballot holds a vote of 2: both partial openings pass, and their sum opens a count of 2 over 1 ballot (tally-range)",
        board(*[(5, record(c, AUTHOR, 1, cell_set=over)) for c in range(4)], *[(7, record(c, DEFAULT, 1, cell_set=over)) for c in range(4)]),
        {"ok": False, "failure": {"cell": 0, "code": "tally-range", "option": 0}},
        cell_set=over,
    )
    two = [make_cell(e, "question-range", 0, [[1, 1, 0]]), cells[1], cells[2], cells[3]]
    tally(
        "question-range",
        "Cell 0's only ballot selects two options of a pick-up-to-one question: every count is at most 1, but the question's total is 2 (tally-question-range)",
        board(*[(5, record(c, AUTHOR, 1, cell_set=two)) for c in range(4)], *[(7, record(c, DEFAULT, 1, cell_set=two)) for c in range(4)]),
        {"ok": False, "failure": {"cell": 0, "code": "tally-question-range", "question": 0}},
        cell_set=two,
    )
    v1 = header(TALLY_OPENING, 1) + v1_message + sign(V1_OPENING_TAG, secrets[AUTHOR][1], v1_message)
    tally(
        "rejected",
        "Beside honest openings, a version-1 opening and a three-byte payload: rejected entries, and the election passes",
        board(*authors, (7, v1), *defaults, (7, bytes.fromhex("000603"))),
        {"ok": True, "rejected": [{"at": 4, "error": "profile-mismatch"}, {"at": 9, "error": "truncated"}]},
    )

    # A 1-of-1 author panel: its one seat's summed shares are its partial opening.
    single = election("single", [(2, 0, 1)], 2, 3, 1, 1)
    s_cell = make_cell(single, "single", 0, [[1, 0], [0, 1], [1, 0]])
    assert s_cell[AUTHOR]["opening"] == s_cell[AUTHOR]["summed"][1]
    single_combination = {
        "description": "A 1-of-1 author panel over 2 options and cell 0 of 4: author seat 1's summed shares are its panel's partial opening (λ = 1)",
        "definition": single["encoding"].hex(),
        "cell": halves_json(s_cell),
        "summed": shares_json(s_cell[AUTHOR]["summed"][1]),
        "opening": shares_json(s_cell[AUTHOR]["opening"]),
        "counts": [str(x) for x in s_cell["counts"]],
    }

    # --- Summed-share messages, version 2.
    s_election = {
        "definitionHash": e["definitionHash"],
        "m": m,
        "aggregates": {p: [c[p]["aggregate"] for c in cells] for p in (DEFAULT, AUTHOR)},
        "registered": registered,
    }
    kems = {DEFAULT: dseats["kem"], AUTHOR: aseats["kem"]}

    def randomness(label):
        rng = bv.Rng(f"panel-tally/encapsulation/{label}")
        return rng.bytes32(), se.nonzero_scalar(rng)

    def make(label, cell, panel, sender, recipient, summed=None, plain=None, agg=None, signer=None, kem_to=None, aad_panel=None):
        mu, ee = randomness(label)
        summed = cells[cell][panel]["summed"][sender] if summed is None else summed
        plain = bv.enc_shares(summed) if plain is None else plain
        agg = cells[cell][panel]["hash"] if agg is None else agg
        sk = signer or secrets[panel][sender]
        to = kem_to or (panel, recipient)
        msg, inter = seal(e["definitionHash"], cell, panel, agg, sender, recipient, kems[to[0]][to[1] - 1], plain, mu, ee, sk, aad_panel)
        return msg, inter, mu, ee, summed

    messages = []

    def message(id_, desc, cell, panel, sender, recipient):
        msg, inter, mu, ee, summed = make(id_, cell, panel, sender, recipient)
        b = encode_summed(msg)
        assert receive(s_election, panel, recipient, kems[panel][recipient - 1], b) == ("ok", cell, sender, summed)
        messages.append(
            {
                "id": id_,
                "description": desc,
                "cell": cell,
                "panel": panel,
                "aggregateHash": cells[cell][panel]["hash"].hex(),
                "sender": sender,
                "recipient": recipient,
                "summed": shares_json(summed),
                "mu": mu.hex(),
                "e": str(ee),
                **inter,
                "signature": msg["signature"].hex(),
                "encoding": b.hex(),
            }
        )
        return msg, b

    d_msg, d_b = message("default-cell-0-seat-1-to-2", "Default seat 1's summed shares of cell 0's default half, to default seat 2", 0, DEFAULT, 1, 2)
    a_msg, a_b = message("author-cell-0-seat-1-to-2", "Author seat 1's summed shares of cell 0's author half, to author seat 2", 0, AUTHOR, 1, 2)
    message("author-cell-1-seat-2-to-1", "Author seat 2's summed shares of cell 1's author half, to author seat 1", 1, AUTHOR, 2, 1)
    assert len(d_b) == 3 + 32 + 1 + 1 + 32 + 1 + 1 + 1088 + 32 + 4 + 4 + 64 * m + 16 + 64

    summed_decode_errors = []

    def summed_rejected(id_, desc, b, code, offset):
        try:
            decode_summed(b)
        except Reject as err:
            assert (err.code, err.offset) == (code, offset), (id_, err.code, err.offset)
        else:
            raise AssertionError(id_)
        summed_decode_errors.append({"id": id_, "description": desc, "encoding": b.hex(), "error": code, "offset": offset})

    panel_at = 3 + 32 + 1
    summed_rejected("version-1", "A version-1 header where tally opening 3 fixes version 2", a_b[:2] + b"\x01" + a_b[3:], "profile-mismatch", 2)
    summed_rejected("panel-0", "Panel 0", a_b[:panel_at] + b"\x00" + a_b[panel_at + 1 :], "invalid-enum", panel_at)
    summed_rejected("panel-3", "Panel 3", a_b[:panel_at] + b"\x03" + a_b[panel_at + 1 :], "invalid-enum", panel_at)
    summed_rejected("trailing-byte", "One byte after the signature", a_b + b"\x00", "trailing-bytes", len(a_b))

    receiving = []

    def case(id_, desc, panel, recipient, b, code):
        got = receive(s_election, panel, recipient, kems[panel][recipient - 1], b)
        assert got[0] == code, (id_, got)
        receiving.append({"id": id_, "description": desc, "panel": panel, "recipient": recipient, "encoding": b.hex(), "result": code})

    def resign(msg, d):
        msg = dict(msg)
        msg["signature"] = sign(SUMMED_TAG, d, summed_signed(msg))
        return encode_summed(msg)

    case("ok", "Author seat 1's message for cell 0, at author seat 2", AUTHOR, 2, a_b, "ok")
    case("other-panel", "Author seat 1's message for cell 0, at default seat 2: another panel's message", DEFAULT, 2, a_b, "summed-context")
    case("relabelled-panel", "Default seat 1's message relabelled panel 2 and re-signed by default seat 1, at author seat 2: author seat 1's key doesn't verify it", AUTHOR, 2, resign(dict(d_msg, panel=AUTHOR, aggregateHash=cells[0][AUTHOR]["hash"]), secrets[DEFAULT][1]), "summed-signature")
    case("default-aggregate", "An author message naming the default panel's aggregate hash", AUTHOR, 2, encode_summed(make("default-aggregate", 0, AUTHOR, 1, 2, agg=cells[0][DEFAULT]["hash"])[0]), "summed-context")
    case("unregistered-author-seat", "Sent and signed by author seat 3, whose keys aren't registered", AUTHOR, 2, encode_summed(make("author-seat-3", 0, AUTHOR, 3, 2)[0]), "summed-context")
    case("version-1", "A version-1 header", AUTHOR, 2, a_b[:2] + b"\x01" + a_b[3:], "summed-malformed")
    case("sealed-to-default-seat", "Addressed to author seat 2 but sealed to default seat 2's KEM key", AUTHOR, 2, encode_summed(make("default-kem", 0, AUTHOR, 1, 2, kem_to=(DEFAULT, 2))[0]), "summed-decrypt")
    case("aad-of-default-panel", "Sealed under the associated data of panel 1 and labelled panel 2: the AEAD binds the panel", AUTHOR, 2, encode_summed(make("aad-panel", 0, AUTHOR, 1, 2, aad_panel=DEFAULT)[0]), "summed-decrypt")
    case("default-sums-as-author", "Default seat 1's correct sums sent as author seat 1's: they lie on the default half's polynomials", AUTHOR, 2, encode_summed(make("default-sums", 0, AUTHOR, 1, 2, summed=cells[0][DEFAULT]["summed"][1])[0]), "summed-check")

    # --- Destruction statements, version 2.
    statements = []

    def statement(id_, desc, panel, signer, definition=None, d=None):
        definition = definition or e["definitionHash"]
        msg = destruction_message(definition, panel, signer)
        b = msg + sign(DESTRUCTION_TAG, d or secrets[panel][signer], msg)
        return {"id": id_, "description": desc, "panel": panel, "signer": signer, "message": msg.hex(), "encoding": b.hex()}, b

    for panel, seats in ((DEFAULT, (1, 2, 3)), (AUTHOR, (1, 2))):
        for i in seats:
            s, b = statement(f"panel-{panel}-seat-{i}", f"{'Default' if panel == DEFAULT else 'Author'} seat {i}'s statement", panel, i)
            s["signingSecret"] = secrets[panel][i].to_bytes(32, "big").hex()
            statements.append(s)
    by_seat = {(s["panel"], s["signer"]): bytes.fromhex(s["encoding"]) for s in statements}

    destruction_decode_errors = []

    def destruction_rejected(id_, desc, b, code, offset):
        try:
            decode_destruction(b)
        except Reject as err:
            assert (err.code, err.offset) == (code, offset), (id_, err.code, err.offset)
        else:
            raise AssertionError(id_)
        destruction_decode_errors.append({"id": id_, "description": desc, "encoding": b.hex(), "error": code, "offset": offset})

    a1 = by_seat[(AUTHOR, 1)]
    assert len(a1) == 101
    destruction_rejected("version-1", "A version-1 header where tally opening 3 fixes version 2", a1[:2] + b"\x01" + a1[3:], "profile-mismatch", 2)
    destruction_rejected("panel-0", "Panel 0", a1[:35] + b"\x00" + a1[36:], "invalid-enum", 35)
    destruction_rejected("truncated", "The last byte of the signature missing", a1[:-1], "truncated", 37)

    reports = []

    def destruction(id_, desc, entries, first_passing, s_t, expect):
        got = check_destruction(e["definitionHash"], registered, entries, first_passing, s_t)
        for key, want in expect.items():
            assert got.get(key) == want, (id_, key, got.get(key), want)
        reports.append({"id": id_, "description": desc, "entries": [{"segment": seg, "payload": b.hex()} for seg, b in entries], "firstPassing": first_passing, "windowSegment": s_t, "result": got})

    timely = [{"default": 7, "author": 5}, {"default": 7, "author": 5}, {"default": 8, "author": 5}, {"default": 7, "author": 6}]
    every = [(9, by_seat[k]) for k in sorted(by_seat)]
    destruction("all-destroyed", "Every seat of both panels states destruction in segment 9, after the last cell's first passing default opening (segment 8)", every, timely, 20, {"from": 9})
    destruction(
        "waits-for-the-other-panel",
        "Author seat 1 states destruction in segment 7, once every author opening is boarded but before cell 2's default one (segment 8): destruction-early",
        [(7, by_seat[(AUTHOR, 1)]), *[x for x in every if x[1] != by_seat[(AUTHOR, 1)]]],
        timely,
        20,
        {"from": 9},
    )
    missing_author = [dict(c) for c in timely]
    missing_author[3]["author"] = None
    destruction("author-opening-missing", "Cell 3 never has a passing author opening: the destruction segment is s_T = 12, so statements in segment 9 are early", every, missing_author, 12, {"from": 12})
    v1_msg = header(DESTRUCTION, 1) + e["definitionHash"] + u8(1)
    v1_statement = v1_msg + sign(DESTRUCTION_TAG, secrets[AUTHOR][1], v1_msg)
    destruction(
        "mixed",
        "Author seat 1's key signing as default seat 1 (unattributed), default seat 2 twice (a duplicate), author seat 2 for another definition (stray), a version-1 statement (rejected) and author seat 1, default seat 1 and default seat 3 missing",
        [
            (9, statement("as-default", "", DEFAULT, 1, d=secrets[AUTHOR][1])[1]),
            (9, by_seat[(DEFAULT, 2)]),
            (10, by_seat[(DEFAULT, 2)]),
            (9, statement("other", "", AUTHOR, 2, definition=other_definition)[1]),
            (9, v1_statement),
        ],
        timely,
        20,
        {"unattributed": [{"at": 0}], "duplicates": [{"at": 2, "panel": DEFAULT, "seat": 2}], "stray": [{"at": 3, "panel": AUTHOR, "signer": 2}], "rejected": [{"at": 4, "error": "profile-mismatch"}]},
    )

    def panel_json(seats, n, k):
        return {
            "threshold": k,
            "panelSize": n,
            "registered": [{"index": i, "signingKey": key.hex(), "kem": se.key_json(seats["kem"][i - 1])} for i, key in sorted(seats["registered"].items())],
            "seats": [{"index": i, "signingSecret": seats["signing"][i].to_bytes(32, "big").hex(), "signingKey": seats["keys"][i].hex(), "kem": se.key_json(seats["kem"][i - 1])} for i in range(1, n + 1)],
        }

    doc = {
        "format": "abolish-panel-tally-vectors/1",
        "title": "The per-panel tally under an author panel: partial openings, tally opening version 3, summed-share message version 2 and destruction statement version 2",
        "spec": "docs/spec/tally.md",
        "generator": (
            "packages/crypto/scripts/panel-tally-vectors.py: an independent Python implementation of docs/spec/tally.md "
            "(Author panel), with ballot-v4-vectors.py's two sharings, tally-vectors.py's sums and combination, "
            "share-encryption-vectors.py's ML-KEM-768 and ChaCha20-Poly1305 and trustee-vectors.py's P-256 ECDSA"
        ),
        "tags": {"partialOpening": PARTIAL_TAG.decode(), "summedShare": SUMMED_TAG.decode(), "summedShareAad": AAD_TAG.decode(), "summedShareKem": KEM_TAG.decode(), "destruction": DESTRUCTION_TAG.decode()},
        "versions": {"tallyOpening": OPENING_VERSION, "summedShare": SUMMED_VERSION, "destruction": DESTRUCTION_VERSION},
        "election": {
            "definition": e["encoding"].hex(),
            "definitionHash": e["definitionHash"].hex(),
            "ceremonyTranscriptHash": e["ceremonyTranscriptHash"].hex(),
            "authorTranscriptHash": e["authorTranscriptHash"].hex(),
            "optionCount": m,
            "default": panel_json(dseats, 3, 2),
            "author": panel_json(aseats, 3, 2),
            "cells": [halves_json(c) for c in cells],
            "counts": [[str(x) for x in c["counts"]] for c in cells],
            "partialOpenings": [{"default": shares_json(c[DEFAULT]["opening"]), "author": shares_json(c[AUTHOR]["opening"])} for c in cells],
            "aggregateHashes": [{"default": c[DEFAULT]["hash"].hex(), "author": c[AUTHOR]["hash"].hex()} for c in cells],
        },
        "combinations": combinations,
        "singleAuthorSeat": single_combination,
        "openings": openings,
        "decodeErrors": decode_errors,
        "tallies": tallies,
        "summedShares": {"messages": messages, "decodeErrors": summed_decode_errors, "receiving": receiving},
        "destruction": {"statements": statements, "decodeErrors": destruction_decode_errors, "reports": reports},
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "panel-tally.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
