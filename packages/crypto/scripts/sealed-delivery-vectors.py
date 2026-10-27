#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/sealed-delivery.json.

A second implementation of docs/spec/sealed-delivery.md: the sealed delivery
(0x0027, version 1), which seals a padded delivery envelope to one seat's
per-election KEM key and names that key by its hash, the sealed answer
(0x0028, version 1), sealed under a key derived from the request's, the
padding buckets, request_hash, and the node's and the client's checks up to
intake and the share-receipt check. It is written from the spec with Python's
integers and hashlib. ML-KEM-768, ChaCha20-Poly1305 and ristretto255 come
from share-encryption-vectors.py and group-vectors.py (checked against Go's
accumulated FIPS 203 vectors, RFC 8439 §2.8.2 and their own self-checks
first). The seats' KEM keys, the ballot records, the share ciphertexts and the
receipts are read from docs/spec/vectors/intake.json and intake-v4.json, so a
delivery carries a ballot and ciphertext that intake vector admits, sealed to
the seat whose receipt for it the answer carries. Nothing here shares code
with packages/crypto or any @noble library.

The envelope's stub and transcript are stand-ins of fixed lengths: the sealed
layer reads them only as the envelope's framing does, and intake's own vectors
cover what they hold. Every secret comes from SHA-512 or SHA-256 over a fixed
label, and each record lists the values it was sealed with, so any
implementation reproduces it byte for byte. The values are test data, never
keys.

Usage: python3 -I -B packages/crypto/scripts/sealed-delivery-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

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
grp, bv = se.grp, se.bv
u8, u16, u32, element, ds, H = bv.u8, bv.u16, bv.u32, bv.element, bv.ds, bv.H

RL = grp.L
RG = grp.BASE

REQUEST_TYPE = 0x0027
ANSWER_TYPE = 0x0028
RECEIPT_TYPE = 0x000C
VERSION = 1
CT_LEN = 1088
EK_LEN = 1184
NONCE = bytes(12)
TAG_LEN = 16

# The envelope: four bytes<2^20> fields, as apps/trustee-node's intake
# endpoint takes them.
MAX_FIELD = 1 << 20
MAX_DELIVERY = 4 * (4 + MAX_FIELD)
MIN_ENVELOPE = 4 * 4
PAD_BUCKETS = [1 << k for k in range(14, 23)] + [MAX_DELIVERY]
MAX_SEALED = MAX_DELIVERY + TAG_LEN
REQUEST_FIXED = 3 + 32 + CT_LEN + 32 + 4
MAX_REQUEST = REQUEST_FIXED + MAX_SEALED

ANSWER_PLAIN = 256
MAX_ANSWER_BODY = ANSWER_PLAIN - 1 - 4
ANSWER_LEN = 3 + 32 + ANSWER_PLAIN + TAG_LEN
OUTCOMES = {"receipt": 1, "refused": 2, "busy": 3}
MAX_CODE = 64

KEM_KEY_TAG = b"abolish/v1/kem-key"
REQUEST_KEM_TAG = b"abolish/v1/kem/sealed-delivery"
REQUEST_AAD_TAG = b"abolish/v1/kem/sealed-delivery-aad"
ANSWER_KEY_TAG = b"abolish/v1/kem/sealed-delivery-answer"
ANSWER_AAD_TAG = b"abolish/v1/kem/sealed-delivery-answer-aad"
REQUEST_HASH_TAG = b"abolish/v1/sealed-delivery/request"


class Rng:
    """Values from SHA-512(label ‖ counter) or SHA-256: test data only."""

    def __init__(self, label):
        self.label = label.encode()
        self.i = 0

    def ristretto_scalar(self):
        self.i += 1
        v = int.from_bytes(hashlib.sha512(self.label + self.i.to_bytes(4, "big")).digest(), "little") % RL
        assert v != 0
        return v

    def bytes32(self):
        self.i += 1
        return hashlib.sha256(self.label + b"/bytes/" + self.i.to_bytes(4, "big")).digest()


def filler(label, n):
    out = b""
    i = 0
    while len(out) < n:
        out += hashlib.sha256(label.encode() + i.to_bytes(4, "big")).digest()
        i += 1
    return out[:n]


def kem_key_hash(pair):
    return H(ds(KEM_KEY_TAG, se.enc_kem_key(pair)))


# --- The envelope and its padding ------------------------------------------------------


def enc_envelope(stub, transcript, record, ciphertext):
    return b"".join(u32(len(f)) + f for f in (stub, transcript, record, ciphertext))


def padded_length(n):
    return next(b for b in PAD_BUCKETS if b >= n)


def pad(envelope):
    return envelope + bytes(padded_length(len(envelope)) - len(envelope))


def read_envelope(pt):
    """The envelope's four fields if `pt` is one padded as the spec pads it, else None."""
    o, fields = 0, []
    for _ in range(4):
        if o + 4 > len(pt):
            return None
        n = int.from_bytes(pt[o : o + 4], "big")
        if n > MAX_FIELD or o + 4 + n > len(pt):
            return None
        fields.append(pt[o + 4 : o + 4 + n])
        o += 4 + n
    if any(pt[o:]) or len(pt) != padded_length(o):
        return None
    return fields


# --- Sealing ---------------------------------------------------------------------------


def combine(ss_m, ss_dh, ct_dh, dh):
    return H(ds(REQUEST_KEM_TAG, ss_m + element(ss_dh) + element(ct_dh) + element(dh)))


def request_aad(key_hash):
    return ds(REQUEST_AAD_TAG, u16(REQUEST_TYPE) + u8(VERSION) + key_hash)


def answer_key(k, rh, answer_nonce):
    return H(ds(ANSWER_KEY_TAG, k + rh + answer_nonce))


def answer_aad(rh):
    return ds(ANSWER_AAD_TAG, u16(ANSWER_TYPE) + u8(VERSION) + rh)


def enc_request(key_hash, ct_m, ct_dh_bytes, sealed):
    return u16(REQUEST_TYPE) + u8(VERSION) + key_hash + ct_m + ct_dh_bytes + u32(len(sealed)) + sealed


def request_hash(b):
    return H(ds(REQUEST_HASH_TAG, b))


def make_request(seat_pair, plain, label, aad_key_hash=None):
    """A request with every value it was sealed with; `aad_key_hash` lets a case seal under another one."""
    rng = Rng(label)
    mu, e = rng.bytes32(), rng.ristretto_scalar()
    kh = kem_key_hash(seat_pair)
    ss_m, ct_m = se.encaps_internal(seat_pair["ek"], mu)
    ct_dh = se.pt_mul(e, RG)
    ss_dh = se.pt_mul(e, seat_pair["dh"])
    k = combine(ss_m, ss_dh, ct_dh, seat_pair["dh"])
    a = request_aad(kh if aad_key_hash is None else aad_key_hash)
    sealed = se.aead_seal(k, NONCE, a, plain)
    b = enc_request(kh, ct_m, element(ct_dh), sealed)
    inter = {"mu": mu.hex(), "e": str(e), "ssM": ss_m.hex(), "ssDh": element(ss_dh).hex(), "key": k.hex(), "aad": a.hex()}
    return b, k, inter


def enc_answer_plain(outcome, body):
    head = u8(outcome) + u32(len(body)) + body
    return head + bytes(ANSWER_PLAIN - len(head))


def make_answer(k, rh, plain, label):
    answer_nonce = Rng(label).bytes32()
    ak = answer_key(k, rh, answer_nonce)
    a = answer_aad(rh)
    sealed = se.aead_seal(ak, NONCE, a, plain)
    b = u16(ANSWER_TYPE) + u8(VERSION) + answer_nonce + sealed
    return b, {"answerNonce": answer_nonce.hex(), "answerKey": ak.hex(), "aad": a.hex()}


# --- Decoding and the checks -----------------------------------------------------------


def read_element(b):
    p = grp.decode(b)
    if p is None or b == bytes(32):
        return None
    return p


def decode_request(b):
    if len(b) < REQUEST_FIXED or b[:3] != u16(REQUEST_TYPE) + u8(VERSION):
        return None
    ct_dh = read_element(b[35 + CT_LEN : 67 + CT_LEN])
    n = int.from_bytes(b[67 + CT_LEN : REQUEST_FIXED], "big")
    if ct_dh is None or n - TAG_LEN not in PAD_BUCKETS or len(b) != REQUEST_FIXED + n:
        return None
    return {"keyHash": b[3:35], "ctM": b[35 : 35 + CT_LEN], "ctDh": ct_dh, "sealed": b[REQUEST_FIXED:]}


def check_request(held, b):
    """docs/spec/sealed-delivery.md, Request check, up to intake: (code, K, envelope fields).

    `held` maps each key hash the node holds a secret for to that secret.
    """
    msg = decode_request(b)
    if msg is None:
        return ("sealed-malformed", None, None)
    secret = held.get(msg["keyHash"])
    if secret is None:
        return ("sealed-key", None, None)
    ss_m = se.decaps_internal(secret["dk"], msg["ctM"])
    k = combine(ss_m, se.pt_mul(secret["x"], msg["ctDh"]), msg["ctDh"], secret["dh"])
    pt = se.aead_open(k, NONCE, request_aad(msg["keyHash"]), msg["sealed"])
    if pt is None:
        return ("sealed-decrypt", None, None)
    fields = read_envelope(pt)
    if fields is None:
        return ("sealed-envelope", k, None)
    return ("ok", k, fields)


def is_code(body):
    if not 1 <= len(body) <= MAX_CODE:
        return False
    s = body.decode("ascii", "replace")
    return all(c.isdigit() or "a" <= c <= "z" or c == "-" for c in s) and not s.startswith("-") and not s.endswith("-") and "--" not in s


def check_answer(k, rh, b):
    """docs/spec/sealed-delivery.md, Answer check: (code, outcome, body)."""
    if len(b) != ANSWER_LEN or b[:3] != u16(ANSWER_TYPE) + u8(VERSION):
        return ("answer-malformed", None, None)
    pt = se.aead_open(answer_key(k, rh, b[3:35]), NONCE, answer_aad(rh), b[35:])
    if pt is None:
        return ("answer-decrypt", None, None)
    outcome, n = pt[0], int.from_bytes(pt[1:5], "big")
    if n > MAX_ANSWER_BODY or any(pt[5 + n :]):
        return ("answer-body", None, None)
    body = pt[5 : 5 + n]
    names = {v: name for name, v in OUTCOMES.items()}
    if outcome not in names:
        return ("answer-body", None, None)
    name = names[outcome]
    if (name == "receipt" and n == 0) or (name == "refused" and not is_code(body)) or (name == "busy" and n != 0):
        return ("answer-body", None, None)
    return ("ok", name, body)


def flip(b, at):
    return b[:at] + bytes([b[at] ^ 1]) + b[at + 1 :]


# --- The vectors -----------------------------------------------------------------------


def seat_json(seat, pair):
    return {"seat": seat, "kemKey": se.enc_kem_key(pair).hex(), "kemKeyHash": kem_key_hash(pair).hex(), "seed": pair["seed"].hex(), "x": str(pair["x"])}


def main(out):
    grp.self_check()
    se.mlkem_self_check(100)
    se.aead_self_check()
    assert REQUEST_FIXED == 1159 and ANSWER_LEN == 307 and MAX_DELIVERY == 4_194_320

    intake = json.loads((VECTORS / "intake.json").read_text())
    intake4 = json.loads((VECTORS / "intake-v4.json").read_text())
    seats = {}
    for s in intake["panel"]:
        pair = se.kem_keypair(bytes.fromhex(s["kem"]["seed"]), int(s["kem"]["x"]))
        assert se.enc_kem_key(pair).hex() == s["kem"]["publicKey"]
        seats[s["seat"]] = pair
    held = {i: {kem_key_hash(p): p} for i, p in seats.items()}

    stub = filler("sealed-delivery/stub", 495)
    small_transcript = filler("sealed-delivery/transcript/4", 5_653)
    large_transcript = filler("sealed-delivery/transcript/7", 20_471)

    def case(cid):
        return next(c for c in intake["cases"] if c["id"] == cid)

    def receipt_record(c, version):
        return u16(RECEIPT_TYPE) + u8(version) + bytes.fromhex(c["statement"]) + bytes.fromhex(c["receipt"])

    deliveries = []
    sent = {}
    plan = [
        ("ok-seat-1", "small", small_transcript, "A ballot to seat 1 beside a transcript of 5,653 bytes: the envelope pads to the smallest bucket, 16 KiB"),
        ("ok-seat-2", "large", large_transcript, "A ballot to seat 2 beside a transcript of 20,471 bytes: the envelope pads to 32 KiB"),
    ]
    for cid, size, transcript, description in plan:
        c = case(cid)
        seat = c["seat"]
        record, ct = bytes.fromhex(c["record"]), bytes.fromhex(c["ciphertext"])
        envelope = enc_envelope(stub, transcript, record, ct)
        plain = pad(envelope)
        b, k, inter = make_request(seats[seat], plain, f"sealed-delivery-request/{cid}")
        code, k2, fields = check_request(held[seat], b)
        assert code == "ok" and k2 == k and fields == [stub, transcript, record, ct]
        rh = request_hash(b)
        receipt = receipt_record(c, 1)
        assert len(receipt) == 164
        answers = []
        for kind, body, label in [
            ("receipt", receipt, "receipt"),
            ("refused", b"intake-closed", "refused"),
            ("busy", b"", "busy"),
        ]:
            ab, ainter = make_answer(k, rh, enc_answer_plain(OUTCOMES[kind], body), f"sealed-delivery-answer/{cid}/{label}")
            got = check_answer(k, rh, ab)
            assert got == ("ok", kind, body), got
            answers.append({"outcome": kind, "body": body.hex(), "sealing": ainter, "record": ab.hex()})
        sent[cid] = (b, k, rh)
        deliveries.append(
            {
                "id": f"{cid}-{size}",
                "description": description,
                "seat": seat,
                "envelope": {
                    "stub": stub.hex(),
                    "transcript": {"length": len(transcript), "label": f"sealed-delivery/transcript/{'4' if size == 'small' else '7'}"},
                    "intakeCase": cid,
                    "length": len(envelope),
                    "paddedLength": len(plain),
                },
                "sealing": inter,
                "record": b.hex(),
                "requestHash": rh.hex(),
                "answers": answers,
            }
        )

    # A version-2 receipt in the answer, as a ballot version 4 delivery gets.
    c4 = next(c for c in intake4["cases"] if c["id"] == "intake-ok-default-1")
    receipt4 = receipt_record(c4, 2)
    assert len(receipt4) == 165
    b0, k0, rh0 = sent["ok-seat-1"]
    a4, a4inter = make_answer(k0, rh0, enc_answer_plain(1, receipt4), "sealed-delivery-answer/v2-receipt")
    assert check_answer(k0, rh0, a4) == ("ok", "receipt", receipt4)

    padding = []
    edges = sorted({MIN_ENVELOPE} | {n + d for b in PAD_BUCKETS for d in (-1, 0, 1) for n in [b] if MIN_ENVELOPE <= n + d <= MAX_DELIVERY})
    for n in edges:
        padding.append({"envelopeLength": n, "paddedLength": padded_length(n)})

    def request_case(description, code, record, seat=1, opener=1):
        got, _, _ = check_request(held[opener] if opener else {}, record)
        assert got == code, (description, got)
        return {"description": description, "code": code, "seat": seat, "openedBy": opener, "record": record.hex()}

    c1 = case("ok-seat-1")
    env1 = enc_envelope(stub, small_transcript, bytes.fromhex(c1["record"]), bytes.fromhex(c1["ciphertext"]))
    plain1 = pad(env1)
    sealed_at = REQUEST_FIXED
    ct_dh_at = 35 + CT_LEN
    other_hash = flip(kem_key_hash(seats[1]), 0)

    def sealed_plain(plain, label, seat=1, aad_key_hash=None):
        return make_request(seats[seat], plain, f"sealed-delivery-case/{label}", aad_key_hash)[0]

    unpadded = sealed_plain(env1 + bytes((1 << 15) - len(env1)), "next-bucket")
    nonzero = sealed_plain(plain1[:-1] + b"\x01", "nonzero-padding")
    long_field = u32(MAX_FIELD + 1) + bytes((1 << 14) - 4)
    over_field = sealed_plain(long_field, "field-over-max")
    first_past = sealed_plain(u32((1 << 14) - 3) + bytes((1 << 14) - 4), "first-past")
    # Three empty fields and a fourth whose length runs past the bucket's end.
    runs_past = sealed_plain(u32(0) * 3 + u32((1 << 14) - 12) + bytes((1 << 14) - 16), "runs-past")
    off_bucket = enc_request(kem_key_hash(seats[1]), b0[35 : 35 + CT_LEN], b0[ct_dh_at : ct_dh_at + 32], b0[sealed_at:] + b"\x00")
    aad_other = sealed_plain(plain1, "aad-other-key", aad_key_hash=other_hash)
    below_bucket = enc_request(kem_key_hash(seats[1]), b0[35 : 35 + CT_LEN], b0[ct_dh_at : ct_dh_at + 32], b0[sealed_at:][: (1 << 13) + TAG_LEN])
    share_ct = bytes.fromhex(c1["ciphertext"])
    copied = b0[:35] + share_ct[: CT_LEN + 32] + b0[ct_dh_at + 32 :]
    rejected_requests = [
        request_case("A trailing byte", "sealed-malformed", b0 + b"\x00"),
        request_case("One byte short", "sealed-malformed", b0[:-1]),
        request_case("Another record type", "sealed-malformed", u16(0x0022) + b0[2:]),
        request_case("Version 2", "sealed-malformed", b0[:2] + u8(2) + b0[3:]),
        request_case("ct_dh is the identity", "sealed-malformed", b0[:ct_dh_at] + bytes(32) + b0[ct_dh_at + 32 :]),
        request_case("ct_dh isn't a canonical encoding", "sealed-malformed", b0[:ct_dh_at] + b"\xff" * 32 + b0[ct_dh_at + 32 :]),
        request_case("sealed's length is one byte past a bucket and its tag", "sealed-malformed", off_bucket),
        request_case("sealed's length is below the smallest bucket and its tag", "sealed-malformed", below_bucket),
        request_case("A key hash the node holds no secret for", "sealed-key", b0[:3] + other_hash + b0[35:]),
        request_case("Seat 1's request at seat 2's node", "sealed-key", b0, seat=1, opener=2),
        request_case("Seat 1's request relabelled with seat 2's key hash, at seat 2's node", "sealed-decrypt", b0[:3] + kem_key_hash(seats[2]) + b0[35:], seat=2, opener=2),
        request_case("Sealed to seat 1's key with the aad naming another key hash", "sealed-decrypt", aad_other),
        request_case("ct_mlkem and ct_dh copied from intake.json's ciphertext to seat 1", "sealed-decrypt", copied),
        request_case("A bit flipped in ct_mlkem", "sealed-decrypt", flip(b0, 35)),
        request_case("A bit flipped in sealed", "sealed-decrypt", flip(b0, sealed_at + 4)),
        request_case("A bit flipped in the tag", "sealed-decrypt", flip(b0, len(b0) - 1)),
        request_case("The envelope padded to the next bucket rather than the smallest", "sealed-envelope", unpadded),
        request_case("A padding byte that isn't zero", "sealed-envelope", nonzero),
        request_case("A field longer than 2^20 bytes", "sealed-envelope", over_field),
        request_case("The first field runs past the plaintext's end", "sealed-envelope", first_past),
        request_case("The last field runs past the plaintext's end", "sealed-envelope", runs_past),
    ]

    def answer_case(description, code, record, k=k0, rh=rh0, sent_to="ok-seat-1"):
        got, _, _ = check_answer(k, rh, record)
        assert got == code, (description, got)
        return {"description": description, "code": code, "request": sent_to, "record": record.hex()}

    ab0 = bytes.fromhex(deliveries[0]["answers"][0]["record"])
    b2, k2, rh2 = sent["ok-seat-2"]

    def sealed_answer(plain, label):
        return make_answer(k0, rh0, plain, f"sealed-delivery-answer-case/{label}")[0]

    def raw_plain(outcome, n, body, tail=b""):
        head = u8(outcome) + u32(n) + body
        return (head + tail + bytes(ANSWER_PLAIN))[:ANSWER_PLAIN]

    rejected_answers = [
        answer_case("A trailing byte", "answer-malformed", ab0 + b"\x00"),
        answer_case("One byte short", "answer-malformed", ab0[:-1]),
        answer_case("Another record type", "answer-malformed", u16(0x0023) + ab0[2:]),
        answer_case("Version 2", "answer-malformed", ab0[:2] + u8(2) + ab0[3:]),
        answer_case("The answer nonce changed", "answer-decrypt", flip(ab0, 3)),
        answer_case("A bit flipped in sealed", "answer-decrypt", flip(ab0, 35)),
        answer_case("Seat 1's answer checked as the answer to the request sent to seat 2", "answer-decrypt", ab0, k=k2, rh=rh2, sent_to="ok-seat-2"),
        answer_case(
            "Sealed under the request's key but another request hash",
            "answer-decrypt",
            make_answer(k0, rh2, enc_answer_plain(1, receipt_record(c1, 1)), "sealed-delivery-answer-case/other-hash")[0],
        ),
        answer_case("Outcome 0", "answer-body", sealed_answer(raw_plain(0, 0, b""), "outcome-0")),
        answer_case("Outcome 4", "answer-body", sealed_answer(raw_plain(4, 0, b""), "outcome-4")),
        answer_case("A body longer than the plaintext allows", "answer-body", sealed_answer(raw_plain(1, MAX_ANSWER_BODY + 1, b""), "body-over-max")),
        answer_case("A receipt with no body", "answer-body", sealed_answer(raw_plain(1, 0, b""), "empty-receipt")),
        answer_case("A refusal with no code", "answer-body", sealed_answer(raw_plain(2, 0, b""), "empty-code")),
        answer_case("A refusal code in upper case", "answer-body", sealed_answer(enc_answer_plain(2, b"INTAKE-CLOSED"), "upper-code")),
        answer_case("A refusal code of 65 bytes", "answer-body", sealed_answer(enc_answer_plain(2, b"a" * 65), "long-code")),
        answer_case("A refusal code ending in a hyphen", "answer-body", sealed_answer(enc_answer_plain(2, b"intake-"), "hyphen-code")),
        answer_case("A refusal code starting with a hyphen", "answer-body", sealed_answer(enc_answer_plain(2, b"-intake"), "leading-hyphen-code")),
        answer_case("A refusal code with two hyphens together", "answer-body", sealed_answer(enc_answer_plain(2, b"intake--closed"), "double-hyphen-code")),
        answer_case("Busy with a body", "answer-body", sealed_answer(enc_answer_plain(3, b"x"), "busy-body")),
        answer_case("A padding byte that isn't zero", "answer-body", sealed_answer(raw_plain(3, 0, b"", b"\x01"), "nonzero-padding")),
    ]
    assert len(raw_plain(3, 0, b"", b"\x01")) == ANSWER_PLAIN
    accepted_answers = []
    for description, kind, body, label in [
        ("A refusal carrying the node's own sealed-envelope code", "refused", b"sealed-envelope", "sealed-envelope"),
        ("A receipt body of exactly MAX_ANSWER_BODY bytes, accepted here: the share-receipt check comes after", "receipt", filler("sealed-delivery/longest-body", MAX_ANSWER_BODY), "longest-body"),
    ]:
        ab, ainter = make_answer(k0, rh0, enc_answer_plain(OUTCOMES[kind], body), f"sealed-delivery-answer-case/{label}")
        assert check_answer(k0, rh0, ab) == ("ok", kind, body)
        accepted_answers.append({"description": description, "request": "ok-seat-1", "outcome": kind, "body": body.hex(), "sealing": ainter, "record": ab.hex()})

    doc = {
        "format": "abolish-sealed-delivery-vectors/1",
        "title": "A ballot's delivery sealed to a seat's per-election KEM key for a relay to carry, and the node's answer sealed under a key derived from the request's",
        "spec": "docs/spec/sealed-delivery.md",
        "generator": "packages/crypto/scripts/sealed-delivery-vectors.py: an independent Python implementation (standard library only), with share-encryption-vectors.py's ML-KEM-768, ChaCha20-Poly1305 and group-vectors.py's ristretto255 (checked against Go's accumulated FIPS 203 vectors and RFC 8439 §2.8.2 first), and the seats' keys, ballots, ciphertexts and receipts of intake.json and intake-v4.json",
        "tags": {
            "kemKey": KEM_KEY_TAG.decode(),
            "requestKem": REQUEST_KEM_TAG.decode(),
            "requestAad": REQUEST_AAD_TAG.decode(),
            "answerKey": ANSWER_KEY_TAG.decode(),
            "answerAad": ANSWER_AAD_TAG.decode(),
            "request": REQUEST_HASH_TAG.decode(),
        },
        "recordTypes": {"request": REQUEST_TYPE, "answer": ANSWER_TYPE},
        "maxDelivery": MAX_DELIVERY,
        "padBuckets": PAD_BUCKETS,
        "maxRequest": MAX_REQUEST,
        "answerLength": ANSWER_LEN,
        "answerPlaintext": ANSWER_PLAIN,
        "outcomes": OUTCOMES,
        "seats": [seat_json(i, seats[i]) for i in sorted(seats)],
        "stub": stub.hex(),
        "transcripts": "Each transcript is filler of its length: SHA-256(label ‖ u32(i)) for i = 0, 1, … concatenated and cut to the length",
        "deliveries": deliveries,
        "versionTwoReceipt": {
            "request": "ok-seat-1-small",
            "intakeCase": "intake-v4.json/intake-ok-default-1",
            "body": receipt4.hex(),
            "sealing": a4inter,
            "record": a4.hex(),
        },
        "padding": padding,
        "rejectedRequests": rejected_requests,
        "acceptedAnswers": accepted_answers,
        "rejectedAnswers": rejected_answers,
    }
    pathlib.Path(out, "sealed-delivery.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
