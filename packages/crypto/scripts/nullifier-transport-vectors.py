#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/nullifier-transport.json.

A second implementation of docs/spec/nullifier-transport.md: the nullifier
request (0x0022, version 1), which seals a query record to one seat's
registration KEM key and names a fresh client key, the nullifier reply
(0x0023, version 1), which seals that seat's answer record to the client key,
request_hash, and the request and reply checks up to the query and answer
checks. It is written from the spec with Python's integers and hashlib.
ML-KEM-768, ChaCha20-Poly1305 and ristretto255 come from
share-encryption-vectors.py and group-vectors.py (checked against Go's
accumulated FIPS 203 vectors, RFC 8439 §2.8.2 and their own self-checks
first). The key, the queries and the answers are read from
docs/spec/vectors/nullifier-query.json, so the plaintexts are that file's
records byte for byte. Nothing here shares code with packages/crypto or any
@noble library.

Every secret comes from SHA-512 or SHA-256 over a fixed label, and each
record lists the values it was sealed with, so any implementation reproduces
it byte for byte. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/nullifier-transport-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import hashlib
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)
QUERY_VECTORS = HERE.parents[3] / "docs" / "spec" / "vectors" / "nullifier-query.json"


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

REQUEST_TYPE = 0x0022
REPLY_TYPE = 0x0023
QUERY_TYPE = 0x001D
ANSWER_TYPE = 0x0010
VERSION = 1
CT_LEN = 1088
EK_LEN = 1184
KEM_KEY_LEN = EK_LEN + 32
ANSWER_LEN = 356
REPLY_SEALED = ANSWER_LEN + 16
# The longest query record version 1 encodes (header, fields, the proof's
# length and at most 65,536 bytes), and the tag.
MAX_REQUEST_SEALED = 3 + 228 + 4 + 65536 + 16
NONCE = bytes(12)

REQUEST_KEM_TAG = b"abolish/v1/kem/nullifier-request"
REQUEST_AAD_TAG = b"abolish/v1/kem/nullifier-request-aad"
REPLY_KEM_TAG = b"abolish/v1/kem/nullifier-reply"
REPLY_AAD_TAG = b"abolish/v1/kem/nullifier-reply-aad"
REQUEST_HASH_TAG = b"abolish/v1/keyed-nullifier/request"


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


def kem_pair(label):
    rng = Rng(label)
    return se.kem_keypair(rng.bytes32() + rng.bytes32(), rng.ristretto_scalar())


def kem_json(pair):
    return {"kemKey": se.enc_kem_key(pair).hex(), "seed": pair["seed"].hex(), "x": str(pair["x"])}


# --- Sealing --------------------------------------------------------------------------


def combine(tag, ss_m, ss_dh, ct_dh, dh):
    return H(ds(tag, ss_m + element(ss_dh) + element(ct_dh) + element(dh)))


def request_aad(key_id, seat, reply_key_bytes):
    return ds(REQUEST_AAD_TAG, u16(REQUEST_TYPE) + u8(VERSION) + key_id + u8(seat) + reply_key_bytes)


def reply_aad(request_hash, seat):
    return ds(REPLY_AAD_TAG, u16(REPLY_TYPE) + u8(VERSION) + request_hash + u8(seat))


def seal(kem_tag, recipient, a, plain, mu, e):
    ss_m, ct_m = se.encaps_internal(recipient["ek"], mu)
    ct_dh = se.pt_mul(e, RG)
    ss_dh = se.pt_mul(e, recipient["dh"])
    k = combine(kem_tag, ss_m, ss_dh, ct_dh, recipient["dh"])
    sealed = se.aead_seal(k, NONCE, a, plain)
    inter = {"ssM": ss_m.hex(), "ssDh": element(ss_dh).hex(), "key": k.hex(), "aad": a.hex()}
    return ct_m, ct_dh, sealed, inter


def enc_request(key_id, seat, reply_key_bytes, ct_m, ct_dh_bytes, sealed):
    return (
        u16(REQUEST_TYPE)
        + u8(VERSION)
        + key_id
        + u8(seat)
        + reply_key_bytes
        + ct_m
        + ct_dh_bytes
        + u32(len(sealed))
        + sealed
    )


def enc_reply(request_hash, seat, ct_m, ct_dh_bytes, sealed):
    return u16(REPLY_TYPE) + u8(VERSION) + request_hash + u8(seat) + ct_m + ct_dh_bytes + sealed


def request_hash(b):
    return H(ds(REQUEST_HASH_TAG, b))


def make_request(key_id, seat, seat_pair, client_pair, query, label, aad_seat=None, aad_key=None):
    """A request with every value it was sealed with; `aad_*` let a case seal under other values."""
    rng = Rng(label)
    mu, e = rng.bytes32(), rng.ristretto_scalar()
    reply_bytes = se.enc_kem_key(client_pair)
    a = request_aad(key_id if aad_key is None else aad_key, seat if aad_seat is None else aad_seat, reply_bytes)
    ct_m, ct_dh, sealed, inter = seal(REQUEST_KEM_TAG, seat_pair, a, query, mu, e)
    b = enc_request(key_id, seat, reply_bytes, ct_m, element(ct_dh), sealed)
    return b, {"mu": mu.hex(), "e": str(e), **inter}


def make_reply(rh, seat, client_pair, answer, label):
    rng = Rng(label)
    mu, e = rng.bytes32(), rng.ristretto_scalar()
    ct_m, ct_dh, sealed, inter = seal(REPLY_KEM_TAG, client_pair, reply_aad(rh, seat), answer, mu, e)
    return enc_reply(rh, seat, ct_m, element(ct_dh), sealed), {"mu": mu.hex(), "e": str(e), **inter}


# --- Decoding and the checks ----------------------------------------------------------


class DecodeFail(Exception):
    def __init__(self, code):
        self.code = code


class Reader:
    def __init__(self, b):
        self.b, self.o = b, 0

    def take(self, n):
        if self.o + n > len(self.b):
            raise DecodeFail("truncated")
        out = self.b[self.o : self.o + n]
        self.o += n
        return out

    def uint(self, n):
        return int.from_bytes(self.take(n), "big")


def read_element(r):
    b = r.take(32)
    p = grp.decode(b)
    if p is None or b == bytes(32):
        raise DecodeFail("non-canonical")
    return p


def read_kem_key(r):
    ek = r.take(EK_LEN)
    if not se.ek_ok(ek):
        raise DecodeFail("non-canonical")
    return {"ek": ek, "dh": read_element(r)}


def header(r, expected):
    t = r.uint(2)
    if t not in (REQUEST_TYPE, REPLY_TYPE):
        raise DecodeFail("unknown-record-type")
    if t != expected:
        raise DecodeFail("unexpected-record-type")
    if r.uint(1) != VERSION:
        raise DecodeFail("profile-mismatch")


def decode_request(b):
    r = Reader(b)
    header(r, REQUEST_TYPE)
    out = {"keyId": r.take(32), "seat": r.uint(1)}
    at = r.o
    out["replyKey"] = read_kem_key(r)
    out["replyKeyBytes"] = b[at : r.o]
    out["ctM"] = r.take(CT_LEN)
    out["ctDh"] = read_element(r)
    n = r.uint(4)
    if n > MAX_REQUEST_SEALED:
        raise DecodeFail("length-over-max")
    out["sealed"] = r.take(n)
    if r.o != len(b):
        raise DecodeFail("trailing-bytes")
    return out


def decode_reply(b):
    r = Reader(b)
    header(r, REPLY_TYPE)
    out = {"requestHash": r.take(32), "seat": r.uint(1), "ctM": r.take(CT_LEN), "ctDh": read_element(r), "sealed": r.take(REPLY_SEALED)}
    if r.o != len(b):
        raise DecodeFail("trailing-bytes")
    return out


def open_sealed(kem_tag, secret, msg, a):
    ss_m = se.decaps_internal(secret["dk"], msg["ctM"])
    k = combine(kem_tag, ss_m, se.pt_mul(secret["x"], msg["ctDh"]), msg["ctDh"], secret["dh"])
    return se.aead_open(k, NONCE, a, msg["sealed"])


def plain_query_key(pt):
    """The query record's key_id if `pt` frames as a version-1 query of a plausible length, else None.

    The full strict decoding of a query is nullifier-query-vectors.py's; the
    cases here differ from a valid query only in framing or in key_id.
    """
    if len(pt) < 3 + 228 + 4 or pt[:3] != u16(QUERY_TYPE) + u8(VERSION):
        return None
    n = int.from_bytes(pt[231:235], "big")
    if n > 65536 or len(pt) != 235 + n:
        return None
    return pt[3:35]


def check_request(keys, seat, secret, b):
    """docs/spec/nullifier-transport.md, Request check, up to the query check: (code, query bytes)."""
    try:
        msg = decode_request(b)
    except DecodeFail:
        return ("request-malformed", None)
    if msg["keyId"] not in keys or msg["seat"] != seat:
        return ("request-key", None)
    pt = open_sealed(REQUEST_KEM_TAG, secret, msg, request_aad(msg["keyId"], seat, msg["replyKeyBytes"]))
    if pt is None:
        return ("request-decrypt", None)
    if plain_query_key(pt) != msg["keyId"]:
        return ("request-query", None)
    return ("ok", pt)


def check_reply(sent_hash, seat, client_secret, b):
    """docs/spec/nullifier-transport.md, Reply check, up to the answer check: (code, answer bytes)."""
    try:
        msg = decode_reply(b)
    except DecodeFail:
        return ("reply-malformed", None)
    if msg["requestHash"] != sent_hash or msg["seat"] != seat:
        return ("reply-request", None)
    pt = open_sealed(REPLY_KEM_TAG, client_secret, msg, reply_aad(sent_hash, seat))
    if pt is None:
        return ("reply-decrypt", None)
    # The answer's seat is at offset 67: after the header, key_id and query_hash.
    if len(pt) != ANSWER_LEN or pt[:3] != u16(ANSWER_TYPE) + u8(VERSION) or pt[67] != seat:
        return ("reply-answer", None)
    return ("ok", pt)


def flip(b, at):
    return b[:at] + bytes([b[at] ^ 1]) + b[at + 1 :]


# --- The vectors ----------------------------------------------------------------------


def main(out):
    grp.self_check()
    se.mlkem_self_check(100)
    se.aead_self_check()
    qv = json.loads(QUERY_VECTORS.read_text())
    key_id = bytes.fromhex(qv["key"]["keyId"])
    n = qv["key"]["n"]
    seats = {i: kem_pair(f"nullifier-transport-seat/{i}") for i in range(1, n + 1)}
    queries = {q["id"]: bytes.fromhex(q["record"]) for q in qv["queries"]}
    answers = {o["query"]: {a["seat"]: bytes.fromhex(a["record"]) for a in o["answers"]} for o in qv["outputs"]}
    assert all(plain_query_key(q) == key_id for q in queries.values())

    clients = {}
    query_vectors = []
    sent = {}
    for qid, query in queries.items():
        client = kem_pair(f"nullifier-transport-client/{qid}")
        clients[qid] = client
        requests = []
        for i in range(1, n + 1):
            b, inter = make_request(key_id, i, seats[i], client, query, f"nullifier-transport-request/{qid}/{i}")
            code, pt = check_request({key_id}, i, seats[i], b)
            assert code == "ok" and pt == query
            rh = request_hash(b)
            answer = answers[qid][i]
            rb, rinter = make_reply(rh, i, client, answer, f"nullifier-transport-reply/{qid}/{i}")
            code, apt = check_reply(rh, i, client, rb)
            assert code == "ok" and apt == answer
            assert len(rb) == 3 + 32 + 1 + CT_LEN + 32 + REPLY_SEALED == 1528
            sent[(qid, i)] = (b, rh, rb)
            requests.append(
                {
                    "seat": i,
                    "sealing": inter,
                    "record": b.hex(),
                    "requestHash": rh.hex(),
                    "reply": {"sealing": rinter, "answer": answer.hex(), "record": rb.hex()},
                }
            )
        query_vectors.append({"id": qid, "query": query.hex(), "client": kem_json(client), "requests": requests})

    q0 = queries["query-0"]
    c0 = clients["query-0"]
    b0, rh0, rb0 = sent[("query-0", 1)]
    msg0 = decode_request(b0)
    sealed_at = len(b0) - len(msg0["sealed"])
    ct_dh_at = sealed_at - 4 - 32
    reply_key_at = 3 + 32 + 1

    def request_case(description, code, record, seat=1, opener=1):
        got, _ = check_request({key_id}, seat, seats[opener], record)
        assert got == code, (description, got)
        return {"description": description, "code": code, "seat": seat, "openedBy": opener, "record": record.hex()}

    other = kem_pair("nullifier-transport-other-client")
    bad_ek = bytes([0xFF, 0xFF]) + c0["ek"][2:]
    assert not se.ek_ok(bad_ek)
    over = enc_request(key_id, 1, se.enc_kem_key(c0), msg0["ctM"], element(msg0["ctDh"]), bytes(MAX_REQUEST_SEALED + 1))
    other_key = flip(key_id, 0)
    not_query, _ = make_request(key_id, 1, seats[1], c0, bytes.fromhex(qv["outputs"][0]["record"]), "nullifier-transport-case/not-query")
    wrong_key_query = q0[:3] + other_key + q0[35:]
    moved_query, _ = make_request(key_id, 1, seats[1], c0, wrong_key_query, "nullifier-transport-case/moved-query")
    aad_seat_2, _ = make_request(key_id, 1, seats[1], c0, q0, "nullifier-transport-case/aad-seat", aad_seat=2)
    aad_other_key, _ = make_request(key_id, 1, seats[1], c0, q0, "nullifier-transport-case/aad-key", aad_key=other_key)
    swapped = b0[:reply_key_at] + se.enc_kem_key(other) + b0[reply_key_at + KEM_KEY_LEN :]
    to_seat_2 = b0[:35] + u8(2) + b0[36:]
    rejected_requests = [
        request_case("A trailing byte", "request-malformed", b0 + b"\x00"),
        request_case("ct_dh is the identity", "request-malformed", b0[:ct_dh_at] + bytes(32) + b0[ct_dh_at + 32 :]),
        request_case(
            "reply_key's dh is the identity",
            "request-malformed",
            b0[: reply_key_at + EK_LEN] + bytes(32) + b0[reply_key_at + KEM_KEY_LEN :],
        ),
        request_case("reply_key's ek fails the modulus check", "request-malformed", b0[:reply_key_at] + bad_ek + b0[reply_key_at + EK_LEN :]),
        request_case("sealed's length is over MAX_REQUEST_SEALED", "request-malformed", over),
        request_case("A key the seat holds no share of", "request-key", b0[:3] + other_key + b0[35:]),
        request_case("Sealed to seat 1, checked by seat 2 as its own", "request-key", b0, seat=2, opener=2),
        request_case("Seat 1's request relabelled for seat 2, checked by seat 2", "request-decrypt", to_seat_2, seat=2, opener=2),
        request_case("Sealed to seat 1's key with the aad naming seat 2", "request-decrypt", aad_seat_2),
        request_case("Sealed to seat 1's key with the aad naming another key_id", "request-decrypt", aad_other_key),
        request_case("The reply key swapped after sealing", "request-decrypt", swapped),
        request_case("A bit flipped in sealed", "request-decrypt", flip(b0, sealed_at + 4)),
        request_case("Opened with another seat's registration secret", "request-decrypt", b0, seat=1, opener=2),
        request_case("The plaintext is an output record, not a query", "request-query", not_query),
        request_case("The query names another key_id than the request", "request-query", moved_query),
    ]

    def reply_case(description, code, record, seat=1, sent_seat=1, opener="query-0"):
        sent_hash = sent[("query-0", sent_seat)][1]
        got, _ = check_reply(sent_hash, seat, clients[opener], record)
        assert got == code, (description, got)
        return {
            "description": description,
            "code": code,
            "seat": seat,
            "requestHash": sent_hash.hex(),
            "openedBy": opener,
            "record": record.hex(),
        }

    r_sealed_at = len(rb0) - REPLY_SEALED
    _, rh2, _ = sent[("query-0", 2)]
    relabelled = u16(QUERY_TYPE) + u8(VERSION) + answers["query-0"][1][3:]
    not_answer, _ = make_reply(rh0, 1, c0, relabelled, "nullifier-transport-case/not-answer")
    seat_2_answer, _ = make_reply(rh0, 1, c0, answers["query-0"][2], "nullifier-transport-case/seat-2-answer")
    rejected_replies = [
        reply_case("A trailing byte", "reply-malformed", rb0 + b"\x00"),
        reply_case(
            "ct_dh is the identity",
            "reply-malformed",
            rb0[: r_sealed_at - 32] + bytes(32) + rb0[r_sealed_at:],
        ),
        reply_case("A reply to another request of the same query", "reply-request", rb0, seat=1, sent_seat=2),
        reply_case("Seat 1's reply relabelled as seat 2's", "reply-request", rb0[:35] + u8(2) + rb0[36:], seat=2, sent_seat=2),
        reply_case("The request hash rewritten to the request sent to seat 2", "reply-decrypt", rb0[:3] + rh2 + u8(2) + rb0[36:], seat=2, sent_seat=2),
        reply_case("A bit flipped in sealed", "reply-decrypt", flip(rb0, r_sealed_at)),
        reply_case("Opened with another query's client secret", "reply-decrypt", rb0, opener="query-1"),
        reply_case("Seat 2's genuine answer sealed as the reply to the request sent to seat 1", "reply-answer", seat_2_answer),
        reply_case("The plaintext is seat 1's answer under the query's record type", "reply-answer", not_answer),
    ]

    doc = {
        "format": "abolish-nullifier-transport-vectors/1",
        "title": "Tier 2 nullifier transport: requests sealed to the seats' registration KEM keys and replies sealed to a fresh client key",
        "spec": "docs/spec/nullifier-transport.md",
        "generator": "packages/crypto/scripts/nullifier-transport-vectors.py: an independent Python implementation (standard library only), with share-encryption-vectors.py's ML-KEM-768, ChaCha20-Poly1305 and group-vectors.py's ristretto255 (checked against Go's accumulated FIPS 203 vectors and RFC 8439 §2.8.2 first), and the key, queries and answers of nullifier-query.json",
        "tags": {
            "requestKem": REQUEST_KEM_TAG.decode(),
            "requestAad": REQUEST_AAD_TAG.decode(),
            "replyKem": REPLY_KEM_TAG.decode(),
            "replyAad": REPLY_AAD_TAG.decode(),
            "request": REQUEST_HASH_TAG.decode(),
        },
        "recordTypes": {"request": REQUEST_TYPE, "reply": REPLY_TYPE},
        "maxRequestSealed": MAX_REQUEST_SEALED,
        "key": {
            "keyId": key_id.hex(),
            "k": qv["key"]["k"],
            "n": n,
            "seats": [{"index": i, **kem_json(seats[i])} for i in range(1, n + 1)],
        },
        "queries": query_vectors,
        "rejectedRequests": rejected_requests,
        "rejectedReplies": rejected_replies,
    }
    pathlib.Path(out, "nullifier-transport.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
