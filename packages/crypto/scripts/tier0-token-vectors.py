#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/tier0-token.json.

A second implementation of docs/spec/tier0-token.md: the key identifier, the
group's info string, the token input, issuance (RFC 9497 POPRF mode over
ristretto255-SHA512: Blind, BlindEvaluate with its proof, Finalize with the
proof's check), the issuer's check of a blinded element, the key periods, and
the signing service's check of a redeemed token (RFC 9497 Evaluate). The group
operations, expand_message_xmd and HashToScalar are group-vectors.py's,
written from RFC 9496 and RFC 9380; the POPRF steps are written here from RFC
9497 Sections 2.2 and 3.3.3 and checked first against its Appendix A.1.3
vectors, parsed from the vendored RFC text. Nothing here shares code with
packages/crypto or any @noble library.

Every key, blind and proof scalar comes from SHA-512 over a fixed label,
reduced mod l, and each vector lists them, so any implementation can
reproduce its bytes. They are test data, never keys.

Usage: python3 -I packages/crypto/scripts/tier0-token-vectors.py <out-dir>
"""

import hashlib
import importlib.util
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


grp = _load("group_vectors", "group-vectors.py")
L = grp.L
G = grp.BASE

# BN254's scalar field, the range of a field<bn254> commitment (docs/spec/notation.md).
R = 0x30644E72E131A029B85045B68181585D2833E84879B9709143E1F593F0000001

KEY_TAG = b"abolish/v1/tier0-token/key"
INFO_TAG = b"abolish/v1/tier0-token/info"
INPUT_TAG = b"abolish/v1/tier0-token/input"
INPUT_VERSION = 1
KEY_PERIOD = 2_592_000

MODE_POPRF = 2
CONTEXT = b"OPRFV1-" + bytes([MODE_POPRF]) + b"-ristretto255-SHA512"


def ds(tag, m):
    return bytes([len(tag)]) + tag + m


def sha256(b):
    return hashlib.sha256(b).digest()


def i2osp(n, length):
    return n.to_bytes(length, "big")


def framed(b):
    return i2osp(len(b), 2) + b


def ser_scalar(k):
    return k.to_bytes(32, "little")


def de_scalar(b):
    k = int.from_bytes(b, "little")
    assert len(b) == 32 and k < L
    return k


def ser(p):
    return grp.encode(p)


def is_identity(p):
    return grp.encode(p) == bytes(32)


def hash_to_group(x):
    return grp.hash_to_ristretto255(x, b"HashToGroup-" + CONTEXT)[1]


def hash_to_scalar(x):
    return grp.hash_to_scalar(x, b"HashToScalar-" + CONTEXT)[1]


# RFC 9497, Section 2.2: the DLEQ proof, batch size 1 and the general case.


def composites(B, Cs, Ds, k=None):
    seed = hashlib.sha512(framed(ser(B)) + framed(b"Seed-" + CONTEXT)).digest()
    M = grp.IDENTITY
    Z = grp.IDENTITY
    for i, (c, d) in enumerate(zip(Cs, Ds)):
        di = hash_to_scalar(framed(seed) + i2osp(i, 2) + framed(ser(c)) + framed(ser(d)) + b"Composite")
        M = grp.add(M, grp.mul(di, c))
        Z = grp.add(Z, grp.mul(di, d))
    return M, (grp.mul(k, M) if k is not None else Z)


def challenge(B, M, Z, t2, t3):
    return hash_to_scalar(
        framed(ser(B)) + framed(ser(M)) + framed(ser(Z)) + framed(ser(t2)) + framed(ser(t3)) + b"Challenge"
    )


def generate_proof(k, A, B, Cs, Ds, r):
    M, Z = composites(B, Cs, Ds, k)
    c = challenge(B, M, Z, grp.mul(r, A), grp.mul(r, M))
    s = (r - c * k) % L
    return ser_scalar(c) + ser_scalar(s)


def verify_proof(A, B, Cs, Ds, proof):
    if len(proof) != 64:
        return False
    c = int.from_bytes(proof[:32], "little")
    s = int.from_bytes(proof[32:], "little")
    if c >= L or s >= L:
        return False
    M, Z = composites(B, Cs, Ds)
    t2 = grp.add(grp.mul(s, A), grp.mul(c, B))
    t3 = grp.add(grp.mul(s, M), grp.mul(c, Z))
    return challenge(B, M, Z, t2, t3) == c


# RFC 9497, Section 3.3.3: POPRF.


class Refused(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def tweak(info):
    return hash_to_scalar(b"Info" + framed(info))


def blind(input_, blind_scalar, pk):
    input_element = hash_to_group(input_)
    if is_identity(input_element):
        raise Refused("input-identity")
    return grp.mul(blind_scalar, input_element)


def tweaked_key(info, pk):
    T = grp.add(grp.mul(tweak(info), G), pk)
    if is_identity(T):
        raise Refused("tweaked-key-identity")
    return T


def blind_evaluate(sk, blinded, info, r):
    t = (sk + tweak(info)) % L
    if t == 0:
        raise Refused("inverse")
    evaluated = grp.mul(pow(t, -1, L), blinded)
    proof = generate_proof(t, G, grp.mul(t, G), [evaluated], [blinded], r)
    return evaluated, proof


def finalize(input_, blind_scalar, evaluated, blinded, proof, info, T):
    if not verify_proof(G, T, [evaluated], [blinded], proof):
        raise Refused("proof")
    n = grp.mul(pow(blind_scalar, -1, L), evaluated)
    return hashlib.sha512(framed(input_) + framed(info) + framed(ser(n)) + b"Finalize").digest()


def evaluate(sk, input_, info):
    input_element = hash_to_group(input_)
    if is_identity(input_element):
        raise Refused("input-identity")
    t = (sk + tweak(info)) % L
    if t == 0:
        raise Refused("inverse")
    n = grp.mul(pow(t, -1, L), input_element)
    return hashlib.sha512(framed(input_) + framed(info) + framed(ser(n)) + b"Finalize").digest()


def rfc_self_check():
    """RFC 9497 Appendix A.1.3, parsed from the vendored text."""
    text = (HERE.parent.parent / "test-vectors" / "rfc" / "rfc9497.txt").read_text()
    start = [m.start() for m in re.finditer(r"^A\.1\.3\.  POPRF Mode$", text, re.M)][-1]
    end = text.index("\nA.2.  decaf448-SHAKE256", start)
    fields = []
    for line in text[start:end].splitlines()[1:]:
        if not line.strip() or re.match(r"^A\.[\d.]+  ", line):
            continue
        f = re.match(r"^ {3}([A-Za-z]+) = (.*)$", line)
        if f:
            fields.append([f[1], f[2].strip()])
        else:
            assert re.match(r"^ {3}[0-9a-f,]+$", line), line
            fields[-1][1] += line.strip()
    key = dict(fields[:4])
    vectors = [dict(fields[i : i + 8]) for i in range(4, len(fields), 8)]
    assert len(vectors) == 3 and all(len(v) == 8 for v in vectors)
    sk = de_scalar(bytes.fromhex(key["skSm"]))
    pk = grp.mul(sk, G)
    assert ser(pk).hex() == key["pkSm"]
    checked = 0
    for v in vectors:
        inputs = [bytes.fromhex(x) for x in v["Input"].split(",")]
        if len(inputs) != 1:
            continue  # batch size 2: the proof is over both, checked through composites below
        info = bytes.fromhex(v["Info"])
        b = de_scalar(bytes.fromhex(v["Blind"]))
        blinded = blind(inputs[0], b, pk)
        assert ser(blinded).hex() == v["BlindedElement"]
        r = de_scalar(bytes.fromhex(v["ProofRandomScalar"]))
        evaluated, proof = blind_evaluate(sk, blinded, info, r)
        assert ser(evaluated).hex() == v["EvaluationElement"]
        assert proof.hex() == v["Proof"]
        T = tweaked_key(info, pk)
        out = finalize(inputs[0], b, evaluated, blinded, proof, info, T)
        assert out.hex() == v["Output"]
        assert evaluate(sk, inputs[0], info) == out
        checked += 1
    # The batch vector: its proof covers two evaluations.
    v = vectors[2]
    info = bytes.fromhex(v["Info"])
    inputs = [bytes.fromhex(x) for x in v["Input"].split(",")]
    blinds = [de_scalar(bytes.fromhex(x)) for x in v["Blind"].split(",")]
    blindeds = [blind(i, b, pk) for i, b in zip(inputs, blinds)]
    t = (sk + tweak(info)) % L
    evals = [grp.mul(pow(t, -1, L), x) for x in blindeds]
    assert ",".join(ser(e).hex() for e in evals) == v["EvaluationElement"]
    r = de_scalar(bytes.fromhex(v["ProofRandomScalar"]))
    proof = generate_proof(t, G, grp.mul(t, G), evals, blindeds, r)
    assert proof.hex() == v["Proof"]
    assert verify_proof(G, tweaked_key(info, pk), evals, blindeds, proof)
    assert checked == 2


# docs/spec/tier0-token.md.


def key_id(period, pk_bytes):
    return sha256(ds(KEY_TAG, i2osp(period, 4) + pk_bytes))


def group_info(chain_id, registry, group_id):
    assert len(registry) == 20
    return sha256(ds(INFO_TAG, i2osp(chain_id, 8) + registry + i2osp(group_id, 8)))


def token_input(kid, commitment):
    if commitment >= R:
        raise Refused("non-canonical")
    return sha256(ds(INPUT_TAG, bytes([INPUT_VERSION]) + kid + i2osp(commitment, 32)))


def decode_blinded(b):
    if len(b) != 32:
        raise Refused("blinded-element")
    p = grp.decode(b)
    if p is None or is_identity(p):
        raise Refused("blinded-element")
    return p


def period_of(now):
    return now // KEY_PERIOD


def issuing(q, now):
    return period_of(now) == q


def redeemable(q, now):
    return period_of(now) in (q, q + 1)


def scalar(label):
    k = int.from_bytes(hashlib.sha512(b"abolish tier0-token test " + label.encode()).digest(), "little") % L
    assert k != 0
    return k


def h(b):
    return b.hex()


CHAIN = 11155420  # OP Sepolia
REGISTRY = bytes.fromhex("5fbdb2315678afecb367f032d93f642f64180aa3")
COMMITMENT = int.from_bytes(sha256(b"abolish tier0-token test commitment"), "big") % R


def redeem(keys, now, kid, info, commitment, token):
    """The signing service's check: keys maps a key id to (period, sk)."""
    if kid not in keys:
        raise Refused("key-unknown")
    q, sk = keys[kid]
    if not redeemable(q, now):
        raise Refused("key-period")
    expected = evaluate(sk, token_input(kid, commitment), info)
    if len(token) != 64 or expected != token:
        raise Refused("token")


def main():
    rfc_self_check()
    out_dir = sys.argv[1]

    key_vectors = []
    for vid, q, label in [
        ("key-period-zero", 0, "key-a"),
        ("key-period-launch", 687, "key-a"),
        ("key-period-max", 2**32 - 1, "key-a"),
        ("key-other-secret", 687, "key-b"),
    ]:
        pk = ser(grp.mul(scalar(label), G))
        key_vectors.append({"id": vid, "period": str(q), "publicKey": h(pk), "keyId": h(key_id(q, pk))})

    info_vectors = []
    for vid, chain, reg, gid in [
        ("info-group-zero", CHAIN, REGISTRY, 0),
        ("info-group-one", CHAIN, REGISTRY, 1),
        ("info-other-chain", 84532, REGISTRY, 0),
        ("info-other-registry", CHAIN, bytes.fromhex("e7f1725e7734ce288f8367e1bb143e90bb3f0512"), 0),
        ("info-max", 2**64 - 1, b"\xff" * 20, 2**64 - 1),
    ]:
        info_vectors.append(
            {
                "id": vid,
                "chainId": str(chain),
                "groupRegistry": h(reg),
                "groupId": str(gid),
                "info": h(group_info(chain, reg, gid)),
            }
        )

    kid_a = bytes.fromhex(key_vectors[1]["keyId"])
    input_vectors = []
    for vid, c in [
        ("input-commitment", COMMITMENT),
        ("input-commitment-two", 2),
        ("input-commitment-max", R - 1),
    ]:
        input_vectors.append(
            {"id": vid, "keyId": h(kid_a), "commitment": h(i2osp(c, 32)), "input": h(token_input(kid_a, c))}
        )
    for vid, c in [("input-commitment-r", R), ("input-commitment-max-bytes", 2**256 - 1)]:
        try:
            token_input(kid_a, c)
            raise AssertionError(vid)
        except Refused as e:
            input_vectors.append({"id": vid, "keyId": h(kid_a), "commitment": h(i2osp(c, 32)), "error": e.code})

    # Issuances: the client's blind, the issuer's evaluation and proof, and the
    # client's finalized token, which the issuer's Evaluate reproduces.
    issuances = []
    runs = [
        ("issue-launch", "A key of period 687, group 0", "key-a", 687, (CHAIN, REGISTRY, 0), COMMITMENT, "1"),
        ("issue-other-group", "The same key and commitment, group 1", "key-a", 687, (CHAIN, REGISTRY, 1), COMMITMENT, "2"),
        ("issue-other-key", "Another key of period 687", "key-b", 687, (CHAIN, REGISTRY, 0), COMMITMENT, "3"),
        ("issue-commitment-two", "The commitment 2", "key-a", 687, (CHAIN, REGISTRY, 0), 2, "4"),
    ]
    tokens = {}
    for vid, desc, label, q, grp_ids, c, n in runs:
        sk = scalar(label)
        pk = grp.mul(sk, G)
        kid = key_id(q, ser(pk))
        info = group_info(*grp_ids)
        inp = token_input(kid, c)
        b = scalar("blind-" + n)
        r = scalar("proof-" + n)
        blinded = blind(inp, b, pk)
        T = tweaked_key(info, pk)
        evaluated, proof = blind_evaluate(sk, decode_blinded(ser(blinded)), info, r)
        token = finalize(inp, b, evaluated, blinded, proof, info, T)
        assert evaluate(sk, inp, info) == token
        tokens[vid] = (sk, q, kid, info, c, token)
        issuances.append(
            {
                "id": vid,
                "description": desc,
                "secretKey": h(ser_scalar(sk)),
                "publicKey": h(ser(pk)),
                "period": str(q),
                "keyId": h(kid),
                "chainId": str(grp_ids[0]),
                "groupRegistry": h(grp_ids[1]),
                "groupId": str(grp_ids[2]),
                "info": h(info),
                "commitment": h(i2osp(c, 32)),
                "input": h(inp),
                "blind": h(ser_scalar(b)),
                "blindedElement": h(ser(blinded)),
                "tweakedKey": h(ser(T)),
                "proofRandomScalar": h(ser_scalar(r)),
                "evaluationElement": h(ser(evaluated)),
                "proof": h(proof),
                "token": h(token),
            }
        )
    assert len({t[5] for t in tokens.values()}) == len(tokens)

    # The client's checks of an issuer's answer (Finalize), each against
    # issue-launch with one thing changed.
    base = issuances[0]
    sk, q, kid, info, c, token = tokens["issue-launch"]
    pk = grp.mul(sk, G)
    inp = bytes.fromhex(base["input"])
    b = de_scalar(bytes.fromhex(base["blind"]))
    blinded = grp.decode(bytes.fromhex(base["blindedElement"]))
    evaluated = grp.decode(bytes.fromhex(base["evaluationElement"]))
    proof = bytes.fromhex(base["proof"])
    other_pk = grp.mul(scalar("key-b"), G)
    other_info = group_info(CHAIN, REGISTRY, 1)

    def flip(bs, i):
        return bs[:i] + bytes([bs[i] ^ 1]) + bs[i + 1 :]

    finals = []
    for vid, desc, ev, pf, pkey, inf in [
        ("finalize-ok", "issue-launch's answer", evaluated, proof, pk, info),
        ("finalize-proof-c-altered", "A bit of the proof's c flipped", evaluated, flip(proof, 0), pk, info),
        ("finalize-proof-s-altered", "A bit of the proof's s flipped", evaluated, flip(proof, 32), pk, info),
        ("finalize-proof-c-unreduced", "The proof's c replaced by c + l", evaluated,
         (int.from_bytes(proof[:32], "little") + L).to_bytes(32, "little") + proof[32:], pk, info),
        ("finalize-other-evaluation", "Another element evaluated", grp.mul(2, evaluated), proof, pk, info),
        ("finalize-other-key", "Checked against another listed key: a key per account would fail here", evaluated, proof, other_pk, info),
        ("finalize-other-group", "Checked against another group's info", evaluated, proof, pk, other_info),
    ]:
        entry = {
            "id": vid,
            "description": desc,
            "publicKey": h(ser(pkey)),
            "info": h(inf),
            "input": base["input"],
            "blind": base["blind"],
            "blindedElement": base["blindedElement"],
            "evaluationElement": h(ser(ev)),
            "proof": h(pf),
        }
        try:
            entry["token"] = h(finalize(inp, b, ev, blinded, pf, inf, tweaked_key(inf, pkey)))
        except Refused as e:
            entry["error"] = e.code
        finals.append(entry)
    assert finals[0]["token"] == base["token"] and all("error" in f for f in finals[1:])
    # A public key whose tweaked key is the identity: sk = −m.
    bad_sk = (-tweak(info)) % L
    bad_pk = grp.mul(bad_sk, G)
    try:
        tweaked_key(info, bad_pk)
        raise AssertionError
    except Refused as e:
        finals.append(
            {
                "id": "finalize-tweaked-key-identity",
                "description": "A key whose tweak for this group cancels it (sk = −m): refused before blinding",
                "publicKey": h(ser(bad_pk)),
                "info": h(info),
                "error": e.code,
            }
        )
    try:
        blind_evaluate(bad_sk, blinded, info, 1)
        raise AssertionError
    except Refused as e:
        assert e.code == "inverse"

    # The issuer's decoding of a blinded element.
    blinded_vectors = [
        {"id": "blinded-ok", "encoding": base["blindedElement"]},
        {"id": "blinded-identity", "encoding": h(bytes(32)), "error": "blinded-element"},
        {"id": "blinded-non-canonical", "encoding": "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "error": "blinded-element"},
        {"id": "blinded-odd", "encoding": "0100000000000000000000000000000000000000000000000000000000000000", "error": "blinded-element"},
        {"id": "blinded-not-square", "encoding": "26948d35ca62e643e26a83177332e6b6afeb9d08e4268b650f1f5bbd8d81d371", "error": "blinded-element"},
        {"id": "blinded-short", "encoding": base["blindedElement"][:62], "error": "blinded-element"},
        {"id": "blinded-long", "encoding": base["blindedElement"] + "00", "error": "blinded-element"},
    ]
    for v in blinded_vectors:
        try:
            decode_blinded(bytes.fromhex(v["encoding"]))
            assert "error" not in v, v["id"]
        except Refused as e:
            assert v.get("error") == e.code, v["id"]

    # Key periods: which key issues and which redeem at a time.
    start = 687 * KEY_PERIOD
    period_vectors = []
    for vid, now, q in [
        ("period-first-second", start, 687),
        ("period-before", start - 1, 687),
        ("period-next-first-second", start + KEY_PERIOD, 687),
        ("period-next-last-second", start + 2 * KEY_PERIOD - 1, 687),
        ("period-after-next", start + 2 * KEY_PERIOD, 687),
        ("period-mid", start + KEY_PERIOD // 2, 687),
    ]:
        period_vectors.append(
            {"id": vid, "now": str(now), "keyPeriod": str(q), "issues": issuing(q, now), "redeems": redeemable(q, now)}
        )

    # Redemptions: the signing service's check, with both launch keys held.
    keys = {}
    for name in ["issue-launch", "issue-other-key"]:
        s, qq, k, *_ = tokens[name]
        keys[k] = (qq, s)
    kid_b = tokens["issue-other-key"][2]
    t_launch = tokens["issue-launch"][5]
    t_group1 = tokens["issue-other-group"][5]
    t_other_key = tokens["issue-other-key"][5]
    info0 = group_info(CHAIN, REGISTRY, 0)
    info1 = group_info(CHAIN, REGISTRY, 1)
    mid = start + KEY_PERIOD // 2
    redemption_runs = [
        ("redeem-ok", "issue-launch's token, in its key's period", mid, kid, info0, COMMITMENT, t_launch),
        ("redeem-next-period", "The same, in the next period", start + KEY_PERIOD + 5, kid, info0, COMMITMENT, t_launch),
        ("redeem-group-one", "issue-other-group's token for group 1", mid, kid, info1, COMMITMENT, t_group1),
        ("redeem-other-key", "issue-other-key's token under its own key", mid, kid_b, info0, COMMITMENT, t_other_key),
        ("redeem-expired", "Two periods later", start + 2 * KEY_PERIOD, kid, info0, COMMITMENT, t_launch),
        ("redeem-before-key", "Before its key's period", start - 1, kid, info0, COMMITMENT, t_launch),
        ("redeem-unknown-key", "A key the service doesn't hold", mid, key_id(687, ser(grp.mul(scalar("key-c"), G))), info0, COMMITMENT, t_launch),
        ("redeem-other-group", "Group 0's token presented for group 1", mid, kid, info1, COMMITMENT, t_launch),
        ("redeem-other-commitment", "The token presented with another commitment", mid, kid, info0, 2, t_launch),
        ("redeem-wrong-key-id", "The token presented under the other key's identifier", mid, kid_b, info0, COMMITMENT, t_launch),
        ("redeem-bit-flipped", "A bit of the token flipped", mid, kid, info0, COMMITMENT, flip(t_launch, 63)),
        ("redeem-truncated", "The token one byte short", mid, kid, info0, COMMITMENT, t_launch[:63]),
    ]
    redemptions = []
    for vid, desc, now, k, inf, c, tok in redemption_runs:
        entry = {
            "id": vid,
            "description": desc,
            "now": str(now),
            "keyId": h(k),
            "info": h(inf),
            "commitment": h(i2osp(c, 32)),
            "token": h(tok),
        }
        try:
            redeem(keys, now, k, inf, c, tok)
            entry["accepted"] = True
        except Refused as e:
            entry["error"] = e.code
        redemptions.append(entry)
    assert [r.get("accepted", False) for r in redemptions[:4]] == [True] * 4
    assert all("error" in r for r in redemptions[4:])

    out = {
        "format": "abolish-tier0-token-vectors/1",
        "title": "Tier 0 tokens: key identifiers, group info, token input, issuance, the client's and issuer's checks, key periods and redemption",
        "spec": "docs/spec/tier0-token.md",
        "generator": (
            "packages/crypto/scripts/tier0-token-vectors.py: an independent Python implementation (standard library "
            "only) of RFC 9497's POPRF mode over ristretto255-SHA512, checked against RFC 9497 Appendix A.1.3 "
            "(parsed from the vendored text), on group-vectors.py's ristretto255, expand_message_xmd and HashToScalar"
        ),
        "suite": {"name": "ristretto255-SHA512", "mode": MODE_POPRF, "contextString": h(CONTEXT)},
        "tags": {"key": KEY_TAG.decode(), "info": INFO_TAG.decode(), "input": INPUT_TAG.decode()},
        "inputVersion": INPUT_VERSION,
        "keyPeriod": str(KEY_PERIOD),
        "keys": key_vectors,
        "infos": info_vectors,
        "inputs": input_vectors,
        "issuances": issuances,
        "finalizations": finals,
        "blindedElements": blinded_vectors,
        "periods": period_vectors,
        "redemptionKeys": [base["keyId"], h(kid_b)],
        "redemptions": redemptions,
    }
    path = pathlib.Path(out_dir) / "tier0-token.json"
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
