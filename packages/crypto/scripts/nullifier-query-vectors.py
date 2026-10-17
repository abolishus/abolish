#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/nullifier-query.json.

A second implementation of docs/spec/nullifier-query.md: the query record
(0x001d, version 1) with its context field and query_hash, both circuits'
statements and public inputs, the output record (0x001e, version 1), and the
query and output checks up to their proofs. Poseidon2's sponge, H1 and H2 are
keyed-nullifier-hashes-vectors.py's; Baby Jubjub's arithmetic, the generator J
and the seats' answers with their proofs are keyed-nullifier-vectors.py's,
whose P-256 ECDSA is trustee-vectors.py's. Each of those checks itself against
published answers before anything is printed. zkPassport's commitment is
written from its source (zkpassport/circuits at c7da418,
hash_salt_dg1_dg2_hash_private_nullifier and SaltedValue::get_hash) over that
sponge. Nothing here shares code with packages/crypto, packages/circuits or
any @noble library.

The proofs in the records are stand-ins: verifying them is part 2b-3b-2b's.
Every secret comes from SHA-256 over a fixed label, so any implementation
reproduces the vectors. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/nullifier-query-vectors.py <out-dir>
"""

import hashlib
import importlib.util
import itertools
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


hashes = _load("keyed_nullifier_hashes_vectors", "keyed-nullifier-hashes-vectors.py")
kn = _load("keyed_nullifier_vectors", "keyed-nullifier-vectors.py")
ecdsa = kn.ecdsa

P = kn.P
L = kn.L
ID = kn.ID
G = kn.G

QUERY_TYPE = 0x001D
OUTPUT_TYPE = 0x001E
VERSION = 1
CONTEXT_TAG = b"abolish/v1/keyed-nullifier/query-context"
QUERY_TAG = b"abolish/v1/keyed-nullifier/query"
MAX_PROOF = 65536
MAX_TRUSTEES = 16
ANSWER_LENGTH = 356


def sha256(b):
    return hashlib.sha256(b).digest()


def label_bytes(label, n=32):
    return sha256(b"abolish test nullifier query " + label)[:n]


def field(label):
    """A deterministic non-zero test field element (never a real secret)."""
    return int.from_bytes(sha256(b"abolish test nullifier query field " + label), "big") % (P - 1) + 1


def u16(v):
    return v.to_bytes(2, "big")


def u32(v):
    return v.to_bytes(4, "big")


def u64(v):
    return v.to_bytes(8, "big")


def f32(v):
    assert 0 <= v < P
    return v.to_bytes(32, "big")


def hexf(v):
    return f"0x{v:064x}"


def point(pt):
    return {"x": hexf(pt[0]), "y": hexf(pt[1])}


# --- zkPassport's commitment ---------------------------------------------------------


def salted_hash(salt, value):
    """SaltedValue::get_hash on a clear value: Poseidon2::hash([salt, value], 2), which is
    the spec's Sponge(salt, value)[0]; both must be non-zero."""
    assert salt != 0 and value != 0
    return hashes.sponge([salt, value])[0]


def comm_in(d, salt_x, x):
    """hash_salt_dg1_dg2_hash_private_nullifier: Poseidon2::hash of the five salted hashes."""
    assert len(d) == 4
    return hashes.sponge(d + [salted_hash(salt_x, x)])[0]


def poseidon_lib_hash(inputs):
    """noir-lang/poseidon v0.3.0's Poseidon2::hash, transcribed from its source (rate 3,
    IV = n * 2^64, the last permutation skipped after a full last block), to show it is
    the spec's Sponge(...)[0]."""
    n = len(inputs)
    state = [0, 0, 0, n * hashes.TWO_64 % P]
    full = n // 3
    for c in range(full):
        for i in range(3):
            state[i] = (state[i] + inputs[c * 3 + i]) % P
        state = hashes.permutation(state)
    rem = n % 3
    for j in range(rem):
        state[j] = (state[j] + inputs[full * 3 + j]) % P
    if n == 0 or rem != 0:
        state = hashes.permutation(state)
    return state[0]


# --- Records ---------------------------------------------------------------------------


def m_ctx(q):
    return (
        u16(QUERY_TYPE)
        + bytes([VERSION])
        + q["key_id"]
        + u64(q["l2_chain_id"])
        + q["group_registry"]
        + u64(q["group_id"])
        + f32(q["commitment"])
        + q["query_id"]
    )


def m_query(q):
    return m_ctx(q) + f32(q["comm_in"]) + kn.enc_point(q["b"])


def ctx_field(q):
    digest = sha256(kn.ds(CONTEXT_TAG, m_ctx(q)))
    return digest, int.from_bytes(digest, "big") >> 8


def query_hash(q):
    return sha256(kn.ds(QUERY_TAG, m_query(q)))


def encode_query(q):
    return m_query(q) + u32(len(q["proof"])) + q["proof"]


def encode_output(o):
    out = u16(OUTPUT_TYPE) + bytes([VERSION]) + o["query_hash"] + u32(len(o["answers"]))
    for a in o["answers"]:
        out += a
    return out + f32(o["n"]) + u32(len(o["proof"])) + o["proof"]


class Reject(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class Reader:
    def __init__(self, data):
        self.data = data
        self.off = 0

    def take(self, n):
        if len(self.data) - self.off < n:
            raise Reject("truncated")
        b = self.data[self.off : self.off + n]
        self.off += n
        return b

    def header(self, record_type):
        rt = int.from_bytes(self.take(2), "big")
        if rt != record_type:
            # The vector file's known types are this page's records alone.
            raise Reject("unknown-record-type")
        # The Tier 2 key fixes version 1, so any other is checked as a pin.
        if self.take(1)[0] != VERSION:
            raise Reject("profile-mismatch")

    def u64(self):
        return int.from_bytes(self.take(8), "big")

    def field(self):
        v = int.from_bytes(self.take(32), "big")
        if v >= P:
            raise Reject("non-canonical")
        return v

    def point(self):
        v = kn.dec_point(self.take(64))
        if v is None:
            raise Reject("non-canonical")
        return v

    def var(self, limit):
        n = int.from_bytes(self.take(4), "big")
        if n > limit:
            raise Reject("length-over-max")
        return self.take(n)

    def end(self):
        if self.off != len(self.data):
            raise Reject("trailing-bytes")


def decode_query(data):
    r = Reader(data)
    r.header(QUERY_TYPE)
    q = {"key_id": r.take(32), "l2_chain_id": r.u64(), "group_registry": r.take(20), "group_id": r.u64()}
    q["commitment"] = r.field()
    q["query_id"] = r.take(32)
    q["comm_in"] = r.field()
    q["b"] = r.point()
    q["proof"] = r.var(MAX_PROOF)
    r.end()
    return q


def decode_output(data):
    r = Reader(data)
    r.header(OUTPUT_TYPE)
    o = {"query_hash": r.take(32)}
    count = int.from_bytes(r.take(4), "big")
    if count > MAX_TRUSTEES:
        raise Reject("length-over-max")
    o["answers"] = []
    for _ in range(count):
        rec = r.take(ANSWER_LENGTH)
        # Each element decodes strictly as an answer record of the key's version.
        _, err = kn.decode_answer(rec)
        if err is not None:
            raise Reject("profile-mismatch" if err[0] == "unknown-version" else err[0])
        o["answers"].append(rec)
    o["n"] = r.field()
    o["proof"] = r.var(MAX_PROOF)
    r.end()
    return o


def is_forbidden(commitment):
    # membership.md: 0, 1 and circomlib Poseidon(0, 1); the vectors use only the first two.
    return commitment in (0, 1)


def check_query(context, data):
    """The query check up to `query-proof`: 'ok' or the first failing code."""
    try:
        q = decode_query(data)
    except Reject as e:
        return e.code, None
    if q["key_id"] != context["key_id"]:
        return "query-key", None
    if q["l2_chain_id"] != context["l2_chain_id"] or q["group_registry"] != context["group_registry"]:
        return "query-scope", None
    if q["group_id"] not in context["tier2_groups"]:
        return "query-group", None
    if is_forbidden(q["commitment"]):
        return "query-commitment", None
    return "ok", q


def combine(answers):
    seats = [a["seat"] for a in answers]
    z = ID
    for a in answers:
        z = kn.add(z, kn.mul(kn.lagrange(a["seat"], seats), a["z"]))
    return z


def check_output(J, key, query, data):
    """The output check up to `output-proof`: ('ok', Z) or (code, index or None)."""
    try:
        o = decode_output(data)
    except Reject as e:
        return e.code, None
    if o["query_hash"] != query["query_hash"]:
        return "output-query", None
    decoded = [kn.decode_answer(rec)[0] for rec in o["answers"]]
    seats = [a["seat"] for a in decoded]
    if len(decoded) != key["k"] or any(a >= b for a, b in zip(seats, seats[1:])):
        return "output-answers", None
    for i, rec in enumerate(o["answers"]):
        code = kn.check_answer(J, key, query, rec)
        if code != "ok":
            return code, i
    z = combine(decoded)
    if z == ID:
        return "output-combination", None
    return "ok", z


# --- The key ---------------------------------------------------------------------------


def make_key(J, label, k, n, zero=False):
    """A k-of-n key from one dealer, with its shares and commitments. `zero` makes sk = 0,
    so every k answers combine to the identity."""
    f = [0 if (zero and j == 0) else kn.scalar_from(b"%s f %d" % (label, j)) for j in range(k)]
    g = [kn.scalar_from(b"%s g %d" % (label, j)) for j in range(k)]

    def poly(coeffs, z):
        return sum(c * pow(z, j, L) for j, c in enumerate(coeffs)) % L

    shares, commitments = [], []
    for i in range(1, n + 1):
        sk_i, s_i = poly(f, i), poly(g, i)
        c_i = kn.add(kn.mul(sk_i, G), kn.mul(s_i, J))
        assert c_i != ID
        shares.append({"seat": i, "sk": sk_i, "s": s_i})
        commitments.append(c_i)
    secrets = [ecdsa.secret(b"%s seat %d" % (label, i)) for i in range(1, n + 1)]
    keys = [ecdsa.compress(ecdsa.mul(d, ecdsa.G)) for d in secrets]
    return {
        "label": label,
        "key_id": label_bytes(b"key " + label),
        "k": k,
        "n": n,
        "sk": f[0],
        "shares": shares,
        "commitments": commitments,
        "signing_secrets": secrets,
        "signing_keys": keys,
    }


def make_answer(J, key, q, seat):
    sh = key["shares"][seat - 1]
    tag = b"%s %s seat %d" % (key["label"], q["label"], seat)
    w1 = kn.scalar_from(b"nullifier query nonce w1 " + tag)
    w2 = kn.scalar_from(b"nullifier query nonce w2 " + tag)
    z_i = kn.mul(sh["sk"], q["b"])
    t1 = kn.mul(w1, q["b"])
    t2 = kn.add(kn.mul(w1, G), kn.mul(w2, J))
    c_i = key["commitments"][seat - 1]
    t = kn.evaluation_t(J, key["key_id"], q["query_hash"], seat, c_i, q["b"], z_i, t1, t2)
    c = kn.hash_to_scalar(t, kn.FS_TAG)[1]
    z1 = (w1 + c * sh["sk"]) % L
    z2 = (w2 + c * sh["s"]) % L
    msg = kn.answer_message(key["key_id"], q["query_hash"], seat, q["b"], z_i, c, z1, z2)
    _, r, s = ecdsa.ecdsa_sign(key["signing_secrets"][seat - 1], kn.ds(kn.SIG_TAG, msg))
    rec = msg + ecdsa.sig_bytes(r, s)
    assert len(rec) == ANSWER_LENGTH
    return {"seat": seat, "w1": w1, "w2": w2, "z": z_i, "record": rec}


def key_view(key):
    return {"key_id": key["key_id"], "n": key["n"], "k": key["k"], "signing_keys": key["signing_keys"], "commitments": key["commitments"]}


def key_json(key):
    return {
        "keyId": key["key_id"].hex(),
        "k": key["k"],
        "n": key["n"],
        "sk": str(key["sk"]),
        "seats": [
            {
                "seat": sh["seat"],
                "sk": str(sh["sk"]),
                "s": str(sh["s"]),
                "commitment": kn.enc_point(key["commitments"][i]).hex(),
                "signingKey": key["signing_keys"][i].hex(),
            }
            for i, sh in enumerate(key["shares"])
        ],
    }


# --- Main ------------------------------------------------------------------------------


def self_check():
    # zkPassport's Poseidon2::hash equals the spec's Sponge(...)[0] at every length.
    for n in range(1, 10):
        inputs = [field(b"lib %d %d" % (n, i)) for i in range(n)]
        assert poseidon_lib_hash(inputs) == hashes.sponge(inputs)[0], n


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = pathlib.Path(sys.argv[1])
    hashes.self_check()
    kn.self_check()
    self_check()

    J, _ = kn.derive_j()
    chain_id = 84532
    registry = bytes.fromhex("e7f1725e7734ce288f8367e1bb143e90bb3f0512")
    _, sigma = hashes.scope_field(chain_id, registry)
    tier2_groups = [3, 9]
    key = make_key(J, b"key", 2, 3)
    zero_key = make_key(J, b"zero key", 2, 3, zero=True)

    def make_query(label, doc, group_id, qkey):
        d = [field(b"%s d%d" % (doc, i)) for i in range(1, 5)]
        salt_x = field(doc + b" salt")
        x = field(doc + b" x")
        r = kn.scalar_from(b"nullifier query r " + label)
        h1, _ = hashes.h1(sigma, x)
        b = kn.mul(r, h1)
        assert b != ID and kn.in_subgroup(b)
        q = {
            "label": label,
            "key_id": qkey["key_id"],
            "l2_chain_id": chain_id,
            "group_registry": registry,
            "group_id": group_id,
            "commitment": field(label + b" commitment"),
            "query_id": label_bytes(b"query id " + label),
            "comm_in": comm_in(d, salt_x, x),
            "b": b,
            "proof": label_bytes(b"stand-in query proof " + label) * 3,
            "d": d,
            "salt_x": salt_x,
            "x": x,
            "r": r,
            "h1": h1,
        }
        q["ctx_digest"], q["ctx"] = ctx_field(q)
        q["query_hash"] = query_hash(q)
        q["q"] = int.from_bytes(q["query_hash"], "big") >> 8
        return q

    queries = [
        make_query(b"query 0", b"document 0", 3, key),
        make_query(b"query 1", b"document 1", 9, key),
    ]
    zero_query = make_query(b"zero query", b"document 0", 3, zero_key)
    context = {"key_id": key["key_id"], "l2_chain_id": chain_id, "group_registry": registry, "tier2_groups": tier2_groups}

    query_vectors = []
    output_vectors = []
    for q in queries:
        rec = encode_query(q)
        code, decoded = check_query(context, rec)
        assert code == "ok" and decoded["b"] == q["b"] and encode_query(decoded) == rec
        answers = [make_answer(J, key, q, seat) for seat in range(1, key["n"] + 1)]
        for a in answers:
            assert kn.check_answer(J, key_view(key), q, a["record"]) == "ok"
        combos = []
        z = None
        for subset in itertools.combinations(answers, key["k"]):
            zs = combine([{"seat": a["seat"], "z": a["z"]} for a in subset])
            combos.append({"seats": [a["seat"] for a in subset], "z": point(zs)})
            assert z is None or zs == z
            z = zs
        assert z == kn.mul(key["sk"], q["b"]) and z != ID
        u = kn.mul(kn.inv(q["r"], L), z)
        assert u == kn.mul(key["sk"], q["h1"])
        n = hashes.h2(sigma, q["x"], u)
        used = answers[: key["k"]]
        output = {
            "query_hash": q["query_hash"],
            "answers": [a["record"] for a in used],
            "n": n,
            "proof": label_bytes(b"stand-in output proof " + q["label"]) * 4,
        }
        orec = encode_output(output)
        code, oz = check_output(J, key_view(key), q, orec)
        assert code == "ok" and oz == z
        assert decode_output(orec)["answers"] == output["answers"]
        query_vectors.append(
            {
                "id": q["label"].decode().replace(" ", "-"),
                "statement": {
                    "d": [hexf(v) for v in q["d"]],
                    "saltX": hexf(q["salt_x"]),
                    "x": hexf(q["x"]),
                    "nullifierSlot": hexf(salted_hash(q["salt_x"], q["x"])),
                    "commIn": hexf(q["comm_in"]),
                    "r": str(q["r"]),
                    "h1": point(q["h1"]),
                    "b": point(q["b"]),
                },
                "fields": {
                    "keyId": q["key_id"].hex(),
                    "l2ChainId": str(chain_id),
                    "groupRegistry": registry.hex(),
                    "groupId": str(q["group_id"]),
                    "commitment": hexf(q["commitment"]),
                    "queryId": q["query_id"].hex(),
                    "commIn": hexf(q["comm_in"]),
                    "b": kn.enc_point(q["b"]).hex(),
                    "proof": q["proof"].hex(),
                },
                "mCtx": m_ctx(q).hex(),
                "ctxDigest": q["ctx_digest"].hex(),
                "ctx": hexf(q["ctx"]),
                "mQuery": m_query(q).hex(),
                "queryHash": q["query_hash"].hex(),
                "q": hexf(q["q"]),
                "queryPublicInputs": [hexf(v) for v in (sigma, q["ctx"], q["comm_in"], q["b"][0], q["b"][1])],
                "record": rec.hex(),
            }
        )
        output_vectors.append(
            {
                "id": "output-" + q["label"].decode().replace(" ", "-"),
                "query": q["label"].decode().replace(" ", "-"),
                "answers": [
                    {"seat": a["seat"], "w1": str(a["w1"]), "w2": str(a["w2"]), "z": point(a["z"]), "record": a["record"].hex()}
                    for a in answers
                ],
                "combinations": combos,
                "z": point(z),
                "u": point(u),
                "n": hexf(n),
                "outputPublicInputs": [hexf(v) for v in (sigma, q["q"], q["b"][0], q["b"][1], z[0], z[1], n)],
                "record": orec.hex(),
            }
        )
    assert len({v["n"] for v in output_vectors}) == 2

    # --- Rejected queries ----------------------------------------------------------
    q0 = queries[0]
    rejected_queries = []

    def reject_query(id_, desc, rec, code):
        got, _ = check_query(context, rec)
        assert got == code, (id_, got, code)
        rejected_queries.append({"id": id_, "description": desc, "record": rec.hex(), "code": code})

    def variant(**changes):
        v = dict(q0)
        v.update(changes)
        return v

    good = encode_query(q0)
    reject_query("trailing-byte", "A byte after the proof", good + b"\x00", "trailing-bytes")
    reject_query("truncated", "The proof one byte short", good[:-1], "truncated")
    reject_query("other-version", "Version 2, where the key fixes version 1", good[:2] + b"\x02" + good[3:], "profile-mismatch")
    reject_query("b-identity", "b is the identity", encode_query(variant(b=ID)), "non-canonical")
    t2 = (0, P - 1)
    reject_query("b-outside-subgroup", "b plus the point of order 2: on the curve, outside the subgroup", encode_query(variant(b=kn.add(q0["b"], t2))), "non-canonical")
    over = m_query(q0) + u32(MAX_PROOF + 1)
    reject_query("proof-over-bound", "A proof length of 65537", over, "length-over-max")
    at_p = m_ctx(q0)[: -64] + P.to_bytes(32, "big") + q0["query_id"] + f32(q0["comm_in"]) + kn.enc_point(q0["b"]) + u32(0)
    reject_query("commitment-at-p", "commitment = p", at_p, "non-canonical")
    reject_query("other-key", "Another key's key_id", encode_query(variant(key_id=zero_key["key_id"])), "query-key")
    reject_query("other-chain", "Another chain ID", encode_query(variant(l2_chain_id=31337)), "query-scope")
    reject_query("other-registry", "Another group registry", encode_query(variant(group_registry=bytes(20))), "query-scope")
    reject_query("not-tier-2", "A group that isn't a Tier 2 group of the registry", encode_query(variant(group_id=4)), "query-group")
    reject_query("commitment-zero", "commitment 0", encode_query(variant(commitment=0)), "query-commitment")
    reject_query("commitment-one", "commitment 1", encode_query(variant(commitment=1)), "query-commitment")

    # --- Rejected outputs ----------------------------------------------------------
    answers0 = [make_answer(J, key, q0, seat) for seat in range(1, 4)]
    answers1 = [make_answer(J, key, queries[1], seat) for seat in range(1, 4)]
    n0 = int(output_vectors[0]["n"], 16)
    proof0 = label_bytes(b"stand-in output proof " + q0["label"]) * 4
    rejected_outputs = []

    def reject_output(id_, desc, o, code, index=None, query=q0, k=key):
        rec = o if isinstance(o, bytes) else encode_output(o)
        got, at = check_output(J, key_view(k), query, rec)
        assert (got, at) == (code, index), (id_, got, at, code, index)
        entry = {"id": id_, "description": desc, "query": query["label"].decode().replace(" ", "-"), "key": k["label"].decode().replace(" ", "-"), "record": rec.hex(), "code": code}
        if index is not None:
            entry["index"] = index
        rejected_outputs.append(entry)

    def out_of(recs, query=q0, n=n0):
        return {"query_hash": query["query_hash"], "answers": [a["record"] for a in recs], "n": n, "proof": proof0}

    good_out = encode_output(out_of(answers0[:2]))
    reject_output("trailing-byte", "A byte after the proof", good_out + b"\x00", "trailing-bytes")
    bad_answer = bytearray(answers0[0]["record"])
    bad_answer[2] = 2
    reject_output("answer-other-version", "An answer of version 2, where the key fixes version 1", out_of([{"record": bytes(bad_answer)}, answers0[1]]), "profile-mismatch")
    over = u16(OUTPUT_TYPE) + bytes([VERSION]) + q0["query_hash"] + u32(MAX_TRUSTEES + 1)
    reject_output("answers-over-bound", "17 answers", over, "length-over-max")
    reject_output("other-query", "The output names query 1", {**out_of(answers0[:2]), "query_hash": queries[1]["query_hash"]}, "output-query")
    reject_output("too-few", "One answer where k is 2", out_of(answers0[:1]), "output-answers")
    reject_output("too-many", "Three answers where k is 2", out_of(answers0), "output-answers")
    reject_output("out-of-order", "Seats 2 then 1", out_of([answers0[1], answers0[0]]), "output-answers")
    reject_output("repeated-seat", "Seat 1 twice", out_of([answers0[0], answers0[0]]), "output-answers")
    reject_output("answer-other-query", "Seat 2's answer is to query 1", out_of([answers0[0], answers1[1]]), "answer-query", 1)
    forged = bytearray(answers0[1]["record"])
    forged[-33] ^= 1  # the last byte of the signature's r, which stays in range
    reject_output("answer-bad-signature", "Seat 2's signature with one bit changed", out_of([answers0[0], {"record": bytes(forged)}]), "answer-signature", 1)
    zero_answers = [make_answer(J, zero_key, zero_query, seat) for seat in (1, 2)]
    reject_output(
        "combination-identity",
        "A key whose sk is 0: both answers pass and combine to the identity",
        out_of(zero_answers, query=zero_query),
        "output-combination",
        query=zero_query,
        k=zero_key,
    )

    data = {
        "format": "abolish-nullifier-query-vectors/1",
        "title": "Tier 2's nullifier query and output records, their context, query_hash, the circuits' public inputs and the checks before the proofs",
        "spec": "docs/spec/nullifier-query.md",
        "generator": (
            "packages/crypto/scripts/nullifier-query-vectors.py: an independent Python implementation "
            "reusing keyed-nullifier-hashes-vectors.py's sponge, H1 and H2, keyed-nullifier-vectors.py's "
            "Baby Jubjub arithmetic and answers and trustee-vectors.py's P-256 ECDSA, with zkPassport's "
            "commitment from zkpassport/circuits at c7da418 and noir-lang/poseidon v0.3.0"
        ),
        "tags": {"queryContext": CONTEXT_TAG.decode(), "query": QUERY_TAG.decode()},
        "recordTypes": {"query": QUERY_TYPE, "output": OUTPUT_TYPE},
        "maxProofLength": MAX_PROOF,
        "scope": {"l2ChainId": str(chain_id), "groupRegistry": registry.hex(), "sigma": hexf(sigma)},
        "tier2Groups": [str(g) for g in tier2_groups],
        "key": key_json(key),
        "zeroKey": key_json(zero_key),
        "queries": query_vectors,
        "outputs": output_vectors,
        "zeroQuery": {"id": "zero-query", "queryHash": zero_query["query_hash"].hex(), "b": kn.enc_point(zero_query["b"]).hex()},
        "rejectedQueries": rejected_queries,
        "rejectedOutputs": rejected_outputs,
    }
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "nullifier-query.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
