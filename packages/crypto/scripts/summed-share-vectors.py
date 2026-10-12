#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/summed-share.json.

A second implementation of docs/spec/tally.md, Summed-share message: the
record (type 0x000b, version 1), its strict decoder, the sender's encryption
under the hybrid KEM with the message's own tags, its signature, and the
recipient's checks in order (summed-malformed, summed-context,
summed-signature, summed-decrypt, summed-check). It is written from the spec
with Python's integers and hashlib. ML-KEM-768 and ChaCha20-Poly1305 come from
share-encryption-vectors.py, which checks them against Go's accumulated FIPS
203 vectors and RFC 8439 §2.8.2 before anything is printed; ristretto255 from
group-vectors.py (self-checked); ballots and sums from
ballot-validity-vectors.py and tally-vectors.py; P-256 ECDSA from
trustee-vectors.py, which reproduces RFC 6979 Appendix A.2.5 first. Nothing
here shares code with packages/crypto or any @noble library.

Every secret comes from SHA-256 over a fixed label, and each message lists the
randomness that made it, so any implementation reproduces its bytes. The
values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/summed-share-vectors.py <out-dir> [--full]
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
tv = _load("tally_vectors", "tally-vectors.py")
ecdsa = _load("trustee_vectors", "trustee-vectors.py")
bv, grp = tv.bv, tv.grp

L = grp.L
G = grp.BASE
RECORD_TYPE = 0x000B
VERSION = 1
MAX_OPTIONS = 64
MAX_SEALED = 4 + 64 * MAX_OPTIONS + 16
KEM_TAG = b"abolish/v1/kem/summed-share"
AAD_TAG = b"abolish/v1/kem/summed-share-aad"
SIG_TAG = b"abolish/v1/sig/summed-share"
AGGREGATE_TAG = b"abolish/v1/tally-aggregate"
NONCE = bytes(12)

u8, u16, u32 = bv.u8, bv.u16, bv.u32


def scalar(x):
    return x.to_bytes(32, "little")


def element(p):
    return grp.encode(p)


def H(m):
    return bv.H(m)


def ds(tag, m):
    return bv.ds(tag, m)


def pt_mul(k, p):
    return grp.mul(k % L, p)


# --- The record ------------------------------------------------------------------


def enc_shares(shares):
    """`list<share, MAX_OPTIONS>`, each `v ‖ r`; values are written as given, even ≥ ℓ."""
    return u32(len(shares)) + b"".join(scalar(s["v"]) + scalar(s["r"]) for s in shares)


def aggregate_hash(agg):
    return H(ds(AGGREGATE_TAG, u32(len(agg)) + b"".join(grp.encode(row[0]) for row in agg)))


def header(record_type=RECORD_TYPE, version=VERSION):
    return record_type.to_bytes(2, "big") + u8(version)


def body(msg):
    """Every field from definition_hash to sealed."""
    return (
        msg["definitionHash"]
        + u8(msg["cell"])
        + msg["aggregateHash"]
        + u8(msg["sender"])
        + u8(msg["recipient"])
        + msg["ctM"]
        + msg["ctDhBytes"]
        + u32(len(msg["sealed"]))
        + msg["sealed"]
    )


def signed_bytes(msg):
    """The record's encoding without its signature, header included."""
    return header() + body(msg)


def encode(msg, record_type=RECORD_TYPE, version=VERSION):
    return header(record_type, version) + body(msg) + msg["signature"]


class Reject(Exception):
    def __init__(self, code, offset):
        super().__init__(code, offset)
        self.code, self.offset = code, offset


def decode(b, pinned=VERSION):
    """docs/spec/notation.md, Strict decoding, for a file whose only known type is 0x000b version 1."""
    at = 0

    def take(n):
        nonlocal at
        if len(b) - at < n:
            raise Reject("truncated", at)
        out = b[at : at + n]
        at += n
        return out

    if int.from_bytes(take(2), "big") != RECORD_TYPE:
        raise Reject("unknown-record-type", 0)
    v_at = at
    if take(1)[0] != pinned:
        raise Reject("profile-mismatch", v_at)
    msg = {"definitionHash": take(32), "cell": take(1)[0], "aggregateHash": take(32), "sender": take(1)[0], "recipient": take(1)[0], "ctM": take(1088)}
    dh_at = at
    dh_b = take(32)
    p = grp.decode(dh_b)
    if dh_b == bytes(32) or p is None:
        raise Reject("non-canonical", dh_at)
    msg["ctDhBytes"], msg["ctDh"] = dh_b, p
    n_at = at
    n = int.from_bytes(take(4), "big")
    if n > MAX_SEALED:
        raise Reject("length-over-max", n_at)
    msg["sealed"] = take(n)
    sig_at = at
    sig = take(64)
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if not (1 <= r < ecdsa.N and 1 <= s <= ecdsa.HALF_N):
        raise Reject("non-canonical", sig_at)
    if at != len(b):
        raise Reject("trailing-bytes", at)
    msg["signature"] = sig
    return msg


# --- Encryption and the recipient's checks -----------------------------------------


def combine(ss_m, ss_dh, ct_dh, dh):
    return H(ds(KEM_TAG, ss_m + element(ss_dh) + element(ct_dh) + element(dh)))


def aad(definition_hash, cell, agg_hash, sender, recipient):
    return ds(AAD_TAG, u16(RECORD_TYPE) + u8(VERSION) + definition_hash + u8(cell) + agg_hash + u8(sender) + u8(recipient))


def sign(d, m):
    _, r, s = ecdsa.ecdsa_sign(d, bv.ds(SIG_TAG, m))
    return ecdsa.sig_bytes(r, s)


def seal(definition_hash, cell, agg_hash, sender, recipient, kem_key, plain, mu, e, signing_secret):
    """The sender's message, with every intermediate value. `plain` is the plaintext as given."""
    ss_m, ct_m = se.encaps_internal(kem_key["ek"], mu)
    ct_dh = pt_mul(e, G)
    ss_dh = pt_mul(e, kem_key["dh"])
    k = combine(ss_m, ss_dh, ct_dh, kem_key["dh"])
    a = aad(definition_hash, cell, agg_hash, sender, recipient)
    sealed = se.aead_seal(k, NONCE, a, plain)
    msg = {
        "definitionHash": definition_hash,
        "cell": cell,
        "aggregateHash": agg_hash,
        "sender": sender,
        "recipient": recipient,
        "ctM": ct_m,
        "ctDh": ct_dh,
        "ctDhBytes": element(ct_dh),
        "sealed": sealed,
    }
    msg["signature"] = sign(signing_secret, signed_bytes(msg))
    inter = {"ssM": ss_m.hex(), "ssDh": element(ss_dh).hex(), "key": k.hex(), "aad": a.hex(), "plaintext": plain.hex(), "signed": signed_bytes(msg).hex()}
    return msg, inter


def receive(election, recipient, kem_key, b):
    """docs/spec/tally.md, Summed-share message, Receiving, in order: ('ok', cell, sender, shares) or the failing code."""
    try:
        msg = decode(b)
    except Reject:
        return ("summed-malformed",)
    cells = election["aggregates"]
    key = election["registered"].get(msg["sender"])
    if (
        msg["definitionHash"] != election["definitionHash"]
        or msg["cell"] >= len(cells)
        or msg["recipient"] != recipient
        or msg["sender"] == recipient
        or key is None
        or msg["aggregateHash"] != aggregate_hash(cells[msg["cell"]])
    ):
        return ("summed-context",)
    if not ecdsa.verify(key, bv.ds(SIG_TAG, signed_bytes(msg)), msg["signature"]):
        return ("summed-signature",)
    ss_m = se.decaps_internal(kem_key["dk"], msg["ctM"])
    k = combine(ss_m, pt_mul(kem_key["x"], msg["ctDh"]), msg["ctDh"], kem_key["dh"])
    pt = se.aead_open(k, NONCE, aad(msg["definitionHash"], msg["cell"], msg["aggregateHash"], msg["sender"], msg["recipient"]), msg["sealed"])
    shares = None if pt is None else se.dec_shares(pt, election["m"])
    if shares is None:
        return ("summed-decrypt",)
    if not bv.check_shares(cells[msg["cell"]], msg["sender"], shares):
        return ("summed-check",)
    return ("ok", msg["cell"], msg["sender"], shares)


# --- Vectors ------------------------------------------------------------------------


def main():
    out = pathlib.Path(sys.argv[1])
    grp.self_check()
    ecdsa.self_check()
    se.aead_self_check()
    se.mlkem_self_check(10000 if "--full" in sys.argv[2:] else 100)

    # A 2-of-4 panel, plurality over 3 options, two cells. Seat 4 took part in
    # the ceremony but wasn't qualified, so its keys aren't registered.
    ctx = bv.context("summed-share-plurality", 3, 0, 1, 2, 4)
    definition_hash = ctx["definitionHash"]
    m, k, n = ctx["optionCount"], ctx["threshold"], ctx["panelSize"]
    kem = se.trustee_keys("summed-share", n)
    signing = {i: ecdsa.secret(f"summed-share/seat-{i}".encode()) for i in range(1, n + 1)}
    sig_keys = {i: ecdsa.compress(ecdsa.mul(d, ecdsa.G)) for i, d in signing.items()}
    registered = {i: sig_keys[i] for i in (1, 2, 3)}

    def make_cell(label, votes_list):
        made = [bv.make_ballot(f"summed-share/{label}/{b}", ctx, v) for b, v in enumerate(votes_list)]
        vss = [vote["vss"] for vote, _, _ in made]
        summed = {i: tv.sum_shares(m, [shares[i - 1] for _, _, shares in made]) for i in range(1, n + 1)}
        return vss, tv.aggregate(m, k, vss), summed

    cells = [make_cell("tier-0", [[1, 0, 0], [0, 0, 1], [1, 0, 0]]), make_cell("tier-1", [[0, 1, 0], [0, 1, 0]])]
    aggregates = [agg for _, agg, _ in cells]
    for _, agg, summed in cells:
        for i in range(1, n + 1):
            assert bv.check_shares(agg, i, summed[i])
    election = {"definitionHash": definition_hash, "m": m, "aggregates": aggregates, "registered": registered}
    agg_hashes = [aggregate_hash(a) for a in aggregates]
    other_definition = bv.Rng("summed-share/other-definition").bytes32()

    def randomness(label):
        rng = bv.Rng(f"summed-share/encapsulation/{label}")
        return rng.bytes32(), se.nonzero_scalar(rng)

    def make(label, cell, sender, recipient, summed=None, plain=None, definition=definition_hash, agg=None, signer=None, kem_to=None):
        mu, e = randomness(label)
        summed = cells[cell][2][sender] if summed is None else summed
        plain = enc_shares(summed) if plain is None else plain
        agg = agg_hashes[cell] if agg is None else agg
        signer = sender if signer is None else signer
        to = recipient if kem_to is None else kem_to
        msg, inter = seal(definition, cell, agg, sender, recipient, kem[to - 1], plain, mu, e, signing[signer])
        return msg, inter, mu, e, summed

    messages = []

    def published(id_, desc, cell, sender, recipient):
        msg, inter, mu, e, summed = make(id_, cell, sender, recipient)
        b = encode(msg)
        got = receive(election, recipient, kem[recipient - 1], b)
        assert got == ("ok", cell, sender, summed), (id_, got)
        messages.append(
            {
                "id": id_,
                "description": desc,
                "cell": cell,
                "aggregateHash": agg_hashes[cell].hex(),
                "sender": sender,
                "recipient": recipient,
                "summed": [{"v": str(s["v"]), "r": str(s["r"])} for s in summed],
                "mu": mu.hex(),
                "e": str(e),
                "ctM": msg["ctM"].hex(),
                "ctDh": msg["ctDhBytes"].hex(),
                **inter,
                "signature": msg["signature"].hex(),
                "encoding": b.hex(),
            }
        )
        return msg, b

    base, base_b = published("cell-0-seat-1-to-2", "Seat 1's summed shares for cell 0, to seat 2", 0, 1, 2)
    published("cell-0-seat-1-to-3", "The same sums to seat 3, under fresh randomness", 0, 1, 3)
    published("cell-1-seat-3-to-1", "Seat 3's summed shares for cell 1, to seat 1", 1, 3, 1)
    published("cell-1-seat-2-to-1", "Seat 2's summed shares for cell 1, to seat 1", 1, 2, 1)

    # Decode rejections.
    decode_errors = []

    def rejected(id_, desc, b, code, offset):
        try:
            decode(b)
        except Reject as e:
            assert (e.code, e.offset) == (code, offset), (id_, e.code, e.offset)
        else:
            raise AssertionError(id_)
        assert receive(election, 2, kem[1], b) == ("summed-malformed",)
        decode_errors.append({"id": id_, "description": desc, "encoding": b.hex(), "error": code, "offset": offset})

    dh_at = 3 + 32 + 1 + 32 + 1 + 1 + 1088
    len_at = dh_at + 32
    sig_at = len(base_b) - 64
    rejected("empty", "No bytes", b"", "truncated", 0)
    rejected("header-only", "A header and nothing else", base_b[:3], "truncated", 3)
    rejected("tally-opening-type", "Record type 0x0006 where a summed-share message is read", b"\x00\x06" + base_b[2:], "unknown-record-type", 0)
    rejected("version-2", "Version 2, which tally opening 1 doesn't fix", base_b[:2] + b"\x02" + base_b[3:], "profile-mismatch", 2)
    rejected("ct-dh-identity", "ct_dh is the identity", base_b[:dh_at] + bytes(32) + base_b[dh_at + 32 :], "non-canonical", dh_at)
    rejected("ct-dh-non-canonical", "ct_dh is not a canonical ristretto255 encoding (all 0xff)", base_b[:dh_at] + b"\xff" * 32 + base_b[dh_at + 32 :], "non-canonical", dh_at)
    rejected("sealed-over-max", "sealed announces MAX_SEALED + 1 bytes", base_b[:len_at] + u32(MAX_SEALED + 1) + base_b[len_at + 4 :], "length-over-max", len_at)
    rejected("truncated-in-signature", "The last byte of the signature missing", base_b[:-1], "truncated", sig_at)
    rejected("trailing-byte", "One byte after the signature", base_b + b"\x00", "trailing-bytes", len(base_b))
    high_s = bytearray(base_b)
    s_val = int.from_bytes(base_b[sig_at + 32 :], "big")
    high_s[sig_at + 32 :] = (ecdsa.N - s_val).to_bytes(32, "big")
    rejected("signature-high-s", "The signature's s replaced by n − s", bytes(high_s), "non-canonical", sig_at)

    # The recipient's checks, each failing in turn.
    receiving = []

    def case(id_, desc, recipient, b, code):
        got = receive(election, recipient, kem[recipient - 1], b)
        assert got[0] == code, (id_, got)
        receiving.append({"id": id_, "description": desc, "recipient": recipient, "encoding": b.hex(), "result": code})

    def resign(msg, d):
        msg = dict(msg)
        msg["signature"] = sign(d, signed_bytes(msg))
        return encode(msg)

    def flipped(field, at=0):
        msg = dict(base)
        b = bytearray(msg[field])
        b[at] ^= 1
        msg[field] = bytes(b)
        return resign(msg, signing[1])

    case("ok", "Seat 1's message for cell 0, at seat 2", 2, base_b, "ok")
    case("malformed", "A trailing byte", 2, base_b + b"\x00", "summed-malformed")
    case("other-definition", "Sealed and signed for another definition", 2, encode(make("other-definition", 0, 1, 2, definition=other_definition)[0]), "summed-context")
    case("cell-outside-partition", "Cell 2, which the partition doesn't have", 2, resign(dict(base, cell=2), signing[1]), "summed-context")
    case("other-counted-set", "Summed over another counted set: cell 0's sums with cell 1's aggregate hash", 2, encode(make("other-set", 0, 1, 2, agg=agg_hashes[1])[0]), "summed-context")
    case("other-recipient", "Seat 1's message to seat 2, received by seat 3", 3, base_b, "summed-context")
    case("sender-is-recipient", "A message naming seat 2 as both sender and recipient", 2, resign(dict(base, sender=2), signing[2]), "summed-context")
    case("unregistered-sender", "Sent and signed by seat 4, whose signing key isn't registered", 2, encode(make("seat-4", 0, 4, 2)[0]), "summed-context")
    case("other-seats-key", "Names seat 1 but signed by seat 3's key", 2, resign(base, signing[3]), "summed-signature")
    case("signature-over-other-bytes", "Seat 1's signature, with cell 0's sealed bytes replaced after signing", 2, encode(dict(base, sealed=bytes([base["sealed"][0] ^ 1]) + base["sealed"][1:])), "summed-signature")
    case("flipped-ct-mlkem", "A byte of ct_mlkem flipped and the message re-signed: implicit rejection, so the AEAD fails", 2, flipped("ctM", 5), "summed-decrypt")
    other_dh = element(pt_mul(7, G))
    case("other-ct-dh", "ct_dh replaced by another valid element and re-signed", 2, resign(dict(base, ctDh=pt_mul(7, G), ctDhBytes=other_dh), signing[1]), "summed-decrypt")
    case("flipped-tag", "The AEAD tag's last byte flipped and re-signed", 2, flipped("sealed", len(base["sealed"]) - 1), "summed-decrypt")
    case("sealed-to-other-key", "Sealed to seat 3's KEM key but addressed to seat 2", 2, encode(make("other-key", 0, 1, 2, kem_to=3)[0]), "summed-decrypt")
    summed0 = cells[0][2][1]
    case("short-plaintext", "Two summed shares for three options", 2, encode(make("short", 0, 1, 2, plain=enc_shares(summed0[:2]))[0]), "summed-decrypt")
    case("plaintext-non-canonical", "Option 0's v encoded as v + ℓ", 2, encode(make("v-plus-l", 0, 1, 2, plain=enc_shares([dict(summed0[0], v=summed0[0]["v"] + L)] + summed0[1:]))[0]), "summed-decrypt")
    case("plaintext-trailing", "A byte after the summed shares", 2, encode(make("trailing", 0, 1, 2, plain=enc_shares(summed0) + b"\x00")[0]), "summed-decrypt")
    off_by_one = [dict(summed0[0], v=(summed0[0]["v"] + 1) % L)] + summed0[1:]
    case("check-fails", "Option 0's v one more: decrypts, then fails the summed-share check", 2, encode(make("off-by-one", 0, 1, 2, summed=off_by_one)[0]), "summed-check")
    case("other-seats-sums", "Seat 3's correct sums sent as seat 1's: they lie on the polynomials at seat 3, not seat 1", 2, encode(make("other-seat", 0, 1, 2, summed=cells[0][2][3])[0]), "summed-check")
    case("other-cells-sums", "Cell 1's sums under cell 0", 2, encode(make("other-cell", 0, 1, 2, summed=cells[1][2][1])[0]), "summed-check")

    # One trustee KEM key serves both uses; the tags keep them apart. A ballot
    # share ciphertext sealed to seat 2 under abolish/v1/kem/share, its KEM
    # parts re-signed by seat 1 as a summed-share message, never opens.
    m_i, e_i, w_i = bv.Rng("summed-share/cross-use").bytes32(), 5, 9
    share_ct, _ = se.encrypt(definition_hash, 2, kem[1], aggregates[0], enc_shares(cells[0][2][2]), m_i, e_i, w_i)
    assert se.decrypt(definition_hash, 2, kem[1], aggregates[0], share_ct) == "ok"
    parsed = se.dec_ciphertext(share_ct)
    cross = dict(base, ctM=parsed["ct_m"], ctDh=parsed["ct_dh"], ctDhBytes=element(parsed["ct_dh"]), sealed=parsed["sealed"])
    case("share-ciphertext-as-message", "A share ciphertext to seat 2 that opens there (seat 2's sums of cell 0 sealed under abolish/v1/kem/share, against cell 0's aggregate as its VSS commitments), its KEM parts re-signed by seat 1 as a summed-share message", 2, resign(cross, signing[1]), "summed-decrypt")
    case("sealed-shorter-than-tag", "sealed is 15 bytes, shorter than the AEAD tag, re-signed", 2, resign(dict(base, sealed=base["sealed"][:15]), signing[1]), "summed-decrypt")

    doc = {
        "format": "abolish-summed-share-vectors/1",
        "title": "Summed-share messages: the record, its encryption and signature, and the recipient's checks",
        "spec": "docs/spec/tally.md",
        "generator": "packages/crypto/scripts/summed-share-vectors.py: an independent Python implementation of docs/spec/tally.md (Summed-share message), with share-encryption-vectors.py's ML-KEM-768 and ChaCha20-Poly1305, tally-vectors.py's sums and trustee-vectors.py's P-256 ECDSA",
        "recordType": "0x000b",
        "version": VERSION,
        "tags": {"kem": KEM_TAG.decode(), "aad": AAD_TAG.decode(), "signature": SIG_TAG.decode()},
        "election": {
            "definitionHash": definition_hash.hex(),
            "rules": {"optionCount": m, "threshold": k, "panelSize": n},
            "cells": [[bv.enc_vss(v).hex() for v in vss] for vss, _, _ in cells],
            "registered": [{"index": i, "signingKey": key.hex()} for i, key in sorted(registered.items())],
        },
        "seats": [
            {"index": i, "kem": se.key_json(kem[i - 1]), "signingSecret": signing[i].to_bytes(32, "big").hex(), "signingKey": sig_keys[i].hex()}
            for i in range(1, n + 1)
        ],
        "messages": messages,
        "decodeErrors": decode_errors,
        "receiving": receiving,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "summed-share.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
