#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/identity-chain.json.

A second implementation of docs/spec/identity-chain.md: an anchor set's root
(zkPassport's version-1 certificate registry root over our CSCA leaves), the
two disclosure circuits' parameter commitments, the identity-chain record
(0x0024, version 1), each proof's public inputs, and the identity-chain check
up to its proofs. Poseidon2's sponge is keyed-nullifier-hashes-vectors.py's,
which checks itself against Noir's published answer; the leaf, tree and root
formulas are written from zkPassport's source (zkpassport/circuits at c7da418,
src/noir/lib/commitment/common; zkpassport/zkpassport-packages at 2cfe793,
packages/zkpassport-utils/src/registry) and checked against that source's own
fixtures before anything is printed. Nothing here shares code with
packages/crypto, packages/circuits or any @noble library.

The certificates are stand-ins: their DER is labelled test bytes and their keys
are zkPassport's test keys, not any issuer's. The proofs are stand-ins too, and
the circuit keys are hashes of labels: verifying the proofs is a later part's.

Usage: python3 -I -B packages/crypto/scripts/identity-chain-vectors.py <out-dir>
"""

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


hashes = _load("keyed_nullifier_hashes_vectors", "keyed-nullifier-hashes-vectors.py")

P = hashes.P
sponge = hashes.sponge

CHAIN_TYPE = 0x0024
VERSION = 1
FINGERPRINT_TAG = b"abolish/v1/identity-chain/csca"
MAX_PROOF = 65536
STAND_IN_PROOF = 96
DAY = 86400

CSC_CERT_TYPE = 1
SCHEMA_VERSION = 1
CERTIFICATE_TREE_HEIGHT = 16
REVOCATION_TREE_HEIGHT = 14
MASTERLIST_TREE_HEIGHT = 8

PROOF_TYPE_AGE = 1
PROOF_TYPE_NATIONALITY_INCLUSION = 4
COUNTRY_LIST_LENGTH = 200
MIN_AGE = 18
NONE_NULLIFIER = 4
NON_SALTED_MOCK_NULLIFIER = 2

# zkPassport's test keys (src/noir/lib/commitment/common/src/tests.nr at c7da418), used
# here first to reproduce that file's fixtures and then as stand-in CSCA keys.
RSA_TEST_KEY = bytes.fromhex(
    "9fc356d37179e527f8b6f40c93628df420ec32d781ade2611e67e3e501f84635860f0c7e5e2b069990ccc6e92509f095"
    "0a06ca955f69625ac7da788003d29d726ff9f00a97ffd562d24b3c9c491463583e09bde83f4959651d10295ad2c83ec2"
    "d7dd5df7f7800235eb62095950af9cab67f5cd7a8a70f72536190ea686fd7b6f5094b3cee4d9667e4e9924a554839f9e"
    "c50bd2188de40c84ba89ee1c3b5f1c2cbd2b55d1bc279d1642e1caf39762fcffd4bd68d73197ce10f4548afee8c0a679"
    "4b3f6764263cc879457020da8f0674d0bd8e79731b8c37defd62d2b318cf44b72f0ca3540fb09ee412738fe120337cf6"
    "04c20236121fb22e91e5e9b1bb73d682e257adf9fa615b26a24b10d7178a7651aef9ec448b9f07beac7c58916cc92064"
    "cf4b3feddd6b7fc151aa1975deabf81b6bf439f0b52ed1bd2f7b8e151d19c235a068b34cabadfdd10decd22e178b3cac"
    "93c68e376523b6ba99792a29240a2cf44e3e4c6b3e4a9db53ea89e11e62d103b933771723bc87a8e58ecc8439d4dc99b"
    "014206a452b2d64ee8afc284799912bb6a8e0f9cc936628c7af7b2b4f9809c20b8c1101461408b6eac5e0519d6c6bd5b"
    "ed931761e34c0da2b909e87d3034c1ea40a95026fddc7ddcb155f586ec514e04a5413f7d52fc08f4063bd69cc673ad5d"
    "3ef5ad4750a7542ae31b576baebd27c43453daf7895312bb95dfc3ded41d06b5"
)
EC_TEST_KEY = bytes.fromhex(
    "79de28b1dd437cfa696542d4dc0efa49f0e1deff5cdd00a871da06d93be469b90a02d0613959e72ac4b16d45ffd70f83"
    "6cf6214443e2551171317c02b555afda6257869b4ca9dbea220113eff4d5d554a65f69ba4a726fef84594ae3453e6b95"
)


def sha256(b):
    return hashlib.sha256(b).digest()


def ds(tag, m):
    return bytes([len(tag)]) + tag + m


def label_bytes(label, n=32):
    """n deterministic test bytes: SHA-256 in counter mode over a fixed label."""
    out = b""
    ctr = 0
    while len(out) < n:
        out += sha256(b"abolish test identity chain " + label + u32(ctr))
        ctr += 1
    return out[:n]


def field(label):
    """A deterministic non-zero test field element (never a real secret)."""
    return int.from_bytes(sha256(b"abolish test identity chain field " + label), "big") % (P - 1) + 1


def u16(v):
    return v.to_bytes(2, "big")


def u32(v):
    return v.to_bytes(4, "big")


def u64(v):
    return v.to_bytes(8, "big")


def f32(v):
    return v.to_bytes(32, "big")


def hexf(v):
    return f"0x{v:064x}"


# --- zkPassport's packing, leaf, tree and root ---------------------------------------


def pack_be_31(data):
    """pack_be_bytes_into_fields::<_, _, 31>: the bytes read as one big-endian integer,
    split into 31-byte limbs, least significant limb first (the short limb, if any, holds
    the leading bytes and comes last)."""
    n = -(-len(data) // 31)
    v = int.from_bytes(data, "big")
    return [(v >> (248 * i)) & ((1 << 248) - 1) for i in range(n)]


def leaf_v1(tags, cert_type, country, expiry, fingerprint, public_key):
    """calculate_certificate_registry_leaf_v1."""
    assert len(tags) == 3 and len(country) == 3 and 0 <= expiry < 1 << 32
    packed = int.from_bytes(bytes([cert_type]) + country + u32(expiry), "big")
    return sponge(list(tags) + [packed, fingerprint] + pack_be_31(public_key))[0]


def zeroes(height):
    """The per-level zero values of AsyncMerkleTree.initialize(0, ...): level 0 is the zero
    leaf, and each level above hashes two of the level below."""
    z = [0]
    for _ in range(height):
        z.append(sponge([z[-1], z[-1]])[0])
    return z


def tree_root(leaves, height):
    """An arity-2 Poseidon2 tree of the given height over the leaves sorted ascending, empty
    slots filled with the zero leaf (buildMerkleTreeFromCerts)."""
    assert len(leaves) <= 1 << height
    z = zeroes(height)
    level = sorted(leaves)
    for h in range(height):
        if len(level) % 2:
            level = level + [z[h]]
        level = [sponge([level[i], level[i + 1]])[0] for i in range(0, len(level), 2)]
    return level[0] if level else z[height]


def tree_path(leaves, height, leaf):
    """compute_merkle_root's index and hash path for one leaf of tree_root's tree."""
    z = zeroes(height)
    level = sorted(leaves)
    index = level.index(leaf)
    path = []
    i = index
    for h in range(height):
        if len(level) % 2:
            level = level + [z[h]]
        sibling = i ^ 1
        path.append(level[sibling] if sibling < len(level) else z[h])
        level = [sponge([level[j], level[j + 1]])[0] for j in range(0, len(level), 2)]
        i //= 2
    return index, path


def merkle_root_from_path(leaf, index, path):
    """compute_merkle_root."""
    cur = leaf
    for i, sibling in enumerate(path):
        cur = sponge([sibling, cur] if (index >> i) & 1 else [cur, sibling])[0]
    return cur


def certificate_root_v1(schema_version, timestamp, cert_root, revocation_root, masterlist_root):
    """calculate_certificate_root_v1."""
    meta = int.from_bytes(u16(schema_version) + u32(timestamp), "big")
    state_root = sponge([cert_root, revocation_root, masterlist_root])[0]
    return sponge([meta, state_root])[0]


def zkpassport_cross_check():
    """Reproduce zkPassport's own fixtures (common/src/tests.nr at c7da418), so the packing,
    leaf, zero values, tree and root above are theirs."""
    tags = [1 << 82, 0, 1 << 27]  # ["UN", "DE"]
    rsa_leaf = leaf_v1(tags, 1, b"XYZ", 2000000000, int("01" + "11" * 31, 16), RSA_TEST_KEY)
    assert rsa_leaf == 0x299C5A1CDA1B1D1AF3B88E02E8E9E4AACCC7E4A91A36C40D581F8EB5B6C75B36
    ec_leaf = leaf_v1(tags, 1, b"XYZ", 2000000000, int("02" + "22" * 31, 16), EC_TEST_KEY)
    z = zeroes(CERTIFICATE_TREE_HEIGHT)
    assert z[1] == 0x0B63A53787021A4A962A452C2921B3663AFF1FFD8D5510540F8E659E782956F1
    assert z[15] == 0x2B9CDD484C5BA1E4D6EFCC3F18734B5AC4C4A0B9102E2AEB48521A661D3FEEE9
    index, path = tree_path([rsa_leaf, ec_leaf], CERTIFICATE_TREE_HEIGHT, ec_leaf)
    assert index == 0 and path[0] == rsa_leaf and path[1:] == z[1:16]
    cert_root = tree_root([rsa_leaf, ec_leaf], CERTIFICATE_TREE_HEIGHT)
    assert cert_root == merkle_root_from_path(ec_leaf, index, path)
    assert cert_root == 0x2CC6D5BBA2957520FE874578F49C5DA18306C1F8FD635CC9A7AEE4F1F3930872
    root = certificate_root_v1(
        1,
        1700000000,
        cert_root,
        0x2FB75C45991BB2B257712C225DFFA4F66A740795A7CB708BB32EDF4917BF00B2,
        0x26C5A3B813C6E608C414262037C1B538F1D7FD62E31C60C1098281597EFFBECA,
    )
    assert root == 0x172A1B36046D20A9C05C9E620338487DB32A3BC64C08268B5228FD685393EA50
    # test_compute_merkle_root2: Poseidon2::hash([1], 1).
    assert sponge([1])[0] == 0x168758332D5B3E2D13BE8048C8011B454590E06C44BCE7F702F09103EEF5A373


# --- Anchor sets ----------------------------------------------------------------------


def fingerprint(der):
    return int.from_bytes(sha256(ds(FINGERPRINT_TAG, der)), "big") >> 8


def anchor_leaf(issuer, cert):
    return leaf_v1([0, 0, 0], CSC_CERT_TYPE, issuer, cert["not_after"], fingerprint(cert["der"]), cert["public_key"])


def anchor_root(anchor):
    issuer = anchor["issuer"]
    for cert in anchor["certificates"]:
        assert cert["not_before"] <= anchor["valid_from"] < anchor["valid_until"] <= cert["not_after"] + 1
    assert anchor["valid_from"] % DAY == 0 and anchor["valid_until"] % DAY == 0
    leaves = [anchor_leaf(issuer, c) for c in anchor["certificates"]]
    assert len(set(leaves)) == len(leaves)
    cert_root = tree_root(leaves, CERTIFICATE_TREE_HEIGHT)
    revocation_root = zeroes(REVOCATION_TREE_HEIGHT)[-1]
    masterlist_root = zeroes(MASTERLIST_TREE_HEIGHT)[-1]
    return leaves, cert_root, certificate_root_v1(SCHEMA_VERSION, anchor["valid_from"], cert_root, revocation_root, masterlist_root)


# --- Parameter commitments ------------------------------------------------------------


def age_commitment(min_age, max_age):
    """compare_age's calculate_param_commitment."""
    return sponge([PROOF_TYPE_AGE, 2, min_age, max_age])[0]


def country_code(c):
    return int.from_bytes(c, "big") if c else 0


def nationality_commitment(countries):
    """inclusion_check_country's calculate_param_commitment over a list padded with the
    empty code to 200 entries."""
    codes = [country_code(c) for c in countries] + [0] * (COUNTRY_LIST_LENGTH - len(countries))
    return sponge([PROOF_TYPE_NATIONALITY_INCLUSION, COUNTRY_LIST_LENGTH] + codes)[0]


# --- Records --------------------------------------------------------------------------

PROOFS = ["dsc_proof", "id_proof", "integrity_proof", "age_proof", "nationality_proof"]


def encode_chain(c):
    def var(b):
        return u32(len(b)) + b

    return (
        u16(CHAIN_TYPE)
        + bytes([c.get("version", VERSION)])
        + u64(c["proof_date"])
        + f32(c["anchor_root"])
        + c["dsc_key"]
        + f32(c["comm_dsc"])
        + var(c["dsc_proof"])
        + c["id_key"]
        + f32(c["comm_id"])
        + var(c["id_proof"])
        + c["integrity_key"]
        + var(c["integrity_proof"])
        + var(c["age_proof"])
        + var(c["nationality_proof"])
    )


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

    def header(self):
        if int.from_bytes(self.take(2), "big") != CHAIN_TYPE:
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

    def var(self, limit):
        n = int.from_bytes(self.take(4), "big")
        if n > limit:
            raise Reject("length-over-max")
        return self.take(n)

    def end(self):
        if self.off != len(self.data):
            raise Reject("trailing-bytes")


def decode_chain(data):
    r = Reader(data)
    r.header()
    c = {"proof_date": r.u64(), "anchor_root": r.field(), "dsc_key": r.take(32), "comm_dsc": r.field()}
    c["dsc_proof"] = r.var(MAX_PROOF)
    c["id_key"] = r.take(32)
    c["comm_id"] = r.field()
    c["id_proof"] = r.var(MAX_PROOF)
    c["integrity_key"] = r.take(32)
    c["integrity_proof"] = r.var(MAX_PROOF)
    c["age_proof"] = r.var(MAX_PROOF)
    c["nationality_proof"] = r.var(MAX_PROOF)
    r.end()
    return c


def public_inputs(deployment, comm_in, c):
    """Each proof's public inputs in its circuit's order, outputs last, as the checker
    supplies them: the record's values, the query's comm_in, and its own recomputation."""
    p_age = age_commitment(MIN_AGE, 0)
    p_nat = nationality_commitment([deployment["issuer"]])
    t = deployment["nullifier_type"]
    return {
        "dsc": [c["anchor_root"], c["comm_dsc"]],
        "id": [c["comm_dsc"], c["comm_id"]],
        "integrity": [c["comm_id"], comm_in],
        "age": [comm_in, c["proof_date"], 0, 0, p_age, t, 0, 0],
        "nationality": [comm_in, c["proof_date"], 0, 0, p_nat, t, 0, 0],
    }


def check_chain(deployment, now, data):
    """The identity-chain check up to the proofs (decode, chain-date, chain-anchor,
    chain-circuit); the proofs' checks are a later part's."""
    c = decode_chain(data)
    today = now - now % DAY
    if c["proof_date"] % DAY != 0 or not today - DAY <= c["proof_date"] <= today + DAY:
        raise Reject("chain-date")
    if not any(
        a["root"] == c["anchor_root"] and a["valid_from"] <= c["proof_date"] < a["valid_until"]
        for a in deployment["anchors"]
    ):
        raise Reject("chain-anchor")
    keys = deployment["circuits"]
    if c["dsc_key"] not in keys["dsc"] or c["id_key"] not in keys["id"] or c["integrity_key"] not in keys["integrity"]:
        raise Reject("chain-circuit")
    return c


def self_check():
    zkpassport_cross_check()
    # pack_be_31 against the transcription of pack_be_bytes_into_fields: the leading short
    # limb last.
    data = bytes(range(1, 66))
    limbs = pack_be_31(data)
    assert limbs[2] == int.from_bytes(data[:3], "big")
    assert limbs[1] == int.from_bytes(data[3:34], "big")
    assert limbs[0] == int.from_bytes(data[34:], "big")
    # Our sponge is noir-lang/poseidon's Poseidon2::hash for these lengths too
    # (nullifier-query-vectors.py transcribes it): 3, a full last block, and 202.
    nq = _load("nullifier_query_vectors", "nullifier-query-vectors.py")
    for n in (2, 3, 4, 202):
        vals = [field(b"len %d %d" % (n, i)) for i in range(n)]
        assert sponge(vals)[0] == nq.poseidon_lib_hash(vals)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = pathlib.Path(sys.argv[1])
    hashes.self_check()
    self_check()

    t2026 = 1767225600  # 2026-01-01T00:00:00Z
    t2027 = 1798761600
    t2028 = 1830297600
    now = 1792324800 + 12 * 3600  # 2026-10-18T12:00:00Z
    today = now - now % DAY

    cert_rsa = {
        "label": "stand-in RSA-4096 CSCA",
        "der": label_bytes(b"der rsa", 900),
        "public_key": RSA_TEST_KEY,
        "not_before": 1577836800,  # 2020-01-01
        "not_after": 2524607999,  # 2049-12-31T23:59:59Z
    }
    cert_ec = {
        "label": "stand-in P-384 CSCA",
        "der": label_bytes(b"der ec", 600),
        "public_key": EC_TEST_KEY,
        "not_before": 1704067200,  # 2024-01-01
        "not_after": 2208988799,  # 2039-12-31T23:59:59Z
    }
    cert_old = {
        "label": "stand-in RSA-4096 CSCA expiring at the end of 2026",
        "der": label_bytes(b"der old", 900),
        "public_key": bytes([RSA_TEST_KEY[0]]) + label_bytes(b"old modulus", 511),
        "not_before": 1420070400,  # 2015-01-01
        "not_after": 1798761599,  # 2026-12-31T23:59:59Z
    }
    cert_mock = {
        "label": "stand-in ZKR CSCA",
        "der": label_bytes(b"der mock", 600),
        "public_key": label_bytes(b"mock key", 64),
        "not_before": 1704067200,
        "not_after": 2208988799,
    }

    def make_anchor(label, issuer, certs, valid_from, valid_until):
        a = {"label": label, "issuer": issuer, "certificates": certs, "valid_from": valid_from, "valid_until": valid_until}
        a["leaves"], a["cert_root"], a["root"] = anchor_root(a)
        return a

    anchors_usa = [
        make_anchor("usa-2026", b"USA", [cert_rsa, cert_ec, cert_old], t2026, t2027),
        make_anchor("usa-2027", b"USA", [cert_rsa, cert_ec], t2027, t2028),
    ]
    anchors_zkr = [make_anchor("zkr", b"ZKR", [cert_mock], t2026, t2028)]
    # An issuer's sets never overlap.
    for anchors in (anchors_usa, anchors_zkr):
        for a, b in zip(anchors, anchors[1:]):
            assert a["valid_until"] <= b["valid_from"]

    circuits = {
        "dsc": [label_bytes(b"key dsc rsa pkcs 4096 sha256"), label_bytes(b"key dsc ecdsa p384 sha384")],
        "id": [label_bytes(b"key id rsa pkcs 2048 sha256"), label_bytes(b"key id ecdsa p256 sha256")],
        "integrity": [label_bytes(b"key integrity sa sha256 dg sha256")],
    }
    disclosure_keys = {"age": label_bytes(b"key compare age"), "nationality": label_bytes(b"key inclusion nationality")}
    usa = {"issuer": b"USA", "nullifier_type": NONE_NULLIFIER, "anchors": anchors_usa, "circuits": circuits}
    zkr = {"issuer": b"ZKR", "nullifier_type": NON_SALTED_MOCK_NULLIFIER, "anchors": anchors_zkr, "circuits": circuits}

    def proof(label):
        return label_bytes(b"stand-in proof " + label, STAND_IN_PROOF)

    def make_chain(label, anchor, proof_date, dsc=0, idk=0):
        return {
            "proof_date": proof_date,
            "anchor_root": anchor["root"],
            "dsc_key": circuits["dsc"][dsc],
            "comm_dsc": field(label + b" comm_dsc"),
            "dsc_proof": proof(label + b" dsc"),
            "id_key": circuits["id"][idk],
            "comm_id": field(label + b" comm_id"),
            "id_proof": proof(label + b" id"),
            "integrity_key": circuits["integrity"][0],
            "integrity_proof": proof(label + b" integrity"),
            "age_proof": proof(label + b" age"),
            "nationality_proof": proof(label + b" nationality"),
        }

    def chain_json(c):
        return {
            "proofDate": str(c["proof_date"]),
            "anchorRoot": hexf(c["anchor_root"]),
            "dscKey": c["dsc_key"].hex(),
            "commDsc": hexf(c["comm_dsc"]),
            "idKey": c["id_key"].hex(),
            "commId": hexf(c["comm_id"]),
            "integrityKey": c["integrity_key"].hex(),
            "proofs": {name: c[name].hex() for name in PROOFS},
        }

    accepted = []
    for label, deployment, anchor, date, dsc, idk in [
        (b"usa", usa, anchors_usa[0], today, 0, 0),
        (b"usa yesterday ec", usa, anchors_usa[0], today - DAY, 1, 1),
        (b"usa tomorrow", usa, anchors_usa[0], today + DAY, 0, 1),
        (b"zkr", zkr, anchors_zkr[0], today, 1, 0),
        (b"usa last day", usa, anchors_usa[0], t2027 - DAY, 0, 0),
        (b"usa longest proof", usa, anchors_usa[0], today, 0, 0),
    ]:
        c = make_chain(label, anchor, date, dsc, idk)
        if label == b"usa longest proof":
            c["age_proof"] = label_bytes(b"longest proof", MAX_PROOF)
        at = date + 12 * 3600 if label == b"usa last day" else now
        data = encode_chain(c)
        assert decode_chain(data) == c and check_chain(deployment, at, data) == c
        comm_in = field(label + b" comm_in")
        accepted.append(
            {
                "id": label.decode().replace(" ", "-"),
                "deployment": deployment["issuer"].decode(),
                "now": str(at),
                "commIn": hexf(comm_in),
                "fields": chain_json(c),
                "encoded": data.hex(),
                "publicInputs": {k: [hexf(v) for v in vs] for k, vs in public_inputs(deployment, comm_in, c).items()},
            }
        )

    base = make_chain(b"base", anchors_usa[0], today)
    base_data = encode_chain(base)
    rejected = []

    def reject(rid, data, code, deployment=usa, at=now, note=None):
        try:
            check_chain(deployment, at, data)
        except Reject as e:
            assert e.code == code, (rid, e.code, code)
        else:
            raise AssertionError(rid)
        entry = {"id": rid, "deployment": deployment["issuer"].decode(), "now": str(at), "encoded": data.hex(), "code": code}
        if note:
            entry["note"] = note
        rejected.append(entry)

    def with_(**kw):
        return encode_chain({**base, **kw})

    reject("trailing-byte", base_data + b"\x00", "trailing-bytes")
    reject("truncated", base_data[:-1], "truncated")
    reject("version-2", with_(version=2), "profile-mismatch", note="the Tier 2 key fixes version 1")
    reject("wrong-record-type", u16(0x001D) + base_data[2:], "unknown-record-type")
    off_anchor = 3 + 8
    reject("anchor-root-at-p", base_data[:off_anchor] + f32(P) + base_data[off_anchor + 32 :], "non-canonical")
    off_dsc = off_anchor + 32 + 32
    reject("comm-dsc-at-p", base_data[:off_dsc] + f32(P) + base_data[off_dsc + 32 :], "non-canonical")
    off_id = off_dsc + 32 + 4 + STAND_IN_PROOF + 32
    reject("comm-id-at-p", base_data[:off_id] + f32(P + 1) + base_data[off_id + 32 :], "non-canonical")
    over = encode_chain({**base, "age_proof": b"\x00" * (MAX_PROOF + 1)})
    reject("proof-over-bound", over, "length-over-max", note="the age proof's length field is 65,537, with its bytes present")
    reject("date-not-midnight", with_(proof_date=today + 3600), "chain-date")
    reject("date-two-days-old", with_(proof_date=today - 2 * DAY), "chain-date")
    reject("date-two-days-ahead", with_(proof_date=today + 2 * DAY), "chain-date")
    reject("anchor-unknown", with_(anchor_root=field(b"unknown root")), "chain-anchor")
    reject(
        "anchor-outside-interval",
        with_(anchor_root=anchors_usa[1]["root"]),
        "chain-anchor",
        note="usa-2027's root under a 2026 proof date",
    )
    reject(
        "anchor-at-interval-end",
        with_(proof_date=t2027),
        "chain-anchor",
        at=t2027 + 12 * 3600,
        note="usa-2026's root under a proof date equal to its valid_until",
    )
    reject("anchor-mock-on-usa", with_(anchor_root=anchors_zkr[0]["root"]), "chain-anchor")
    reject("anchor-usa-on-mock", base_data, "chain-anchor", deployment=zkr)
    reject("dsc-key-unpinned", with_(dsc_key=label_bytes(b"key dsc rsa pkcs 1024 sha1")), "chain-circuit")
    reject("dsc-key-of-another-role", with_(dsc_key=circuits["id"][0]), "chain-circuit")
    reject("id-key-of-another-role", with_(id_key=circuits["integrity"][0]), "chain-circuit")
    reject("integrity-key-of-another-role", with_(integrity_key=circuits["dsc"][0]), "chain-circuit")
    reject("id-key-unpinned", with_(id_key=label_bytes(b"key id unpinned")), "chain-circuit")
    reject("integrity-key-unpinned", with_(integrity_key=label_bytes(b"key integrity sa sha1 dg sha1")), "chain-circuit")

    def cert_json(issuer, cert):
        return {
            "label": cert["label"],
            "der": cert["der"].hex(),
            "publicKey": cert["public_key"].hex(),
            "notBefore": str(cert["not_before"]),
            "notAfter": str(cert["not_after"]),
            "fingerprint": hexf(fingerprint(cert["der"])),
            "leaf": hexf(anchor_leaf(issuer, cert)),
        }

    def anchor_json(a):
        return {
            "id": a["label"],
            "issuer": a["issuer"].decode(),
            "validFrom": str(a["valid_from"]),
            "validUntil": str(a["valid_until"]),
            "certificates": [cert_json(a["issuer"], c) for c in a["certificates"]],
            "certificateTreeRoot": hexf(a["cert_root"]),
            "root": hexf(a["root"]),
        }

    def deployment_json(d):
        return {
            "issuer": d["issuer"].decode(),
            "nullifierType": d["nullifier_type"],
            "anchors": [a["label"] for a in d["anchors"]],
        }

    data = {
        "format": "abolish-identity-chain-vectors/1",
        "title": "Tier 2's identity chain: anchor-set roots, the disclosure circuits' parameter commitments, the identity-chain record, each proof's public inputs and the check before the proofs",
        "spec": "docs/spec/identity-chain.md",
        "generator": (
            "packages/crypto/scripts/identity-chain-vectors.py: an independent Python implementation reusing "
            "keyed-nullifier-hashes-vectors.py's sponge, with zkPassport's leaf, tree and root from "
            "zkpassport/circuits at c7da418 and zkpassport/zkpassport-packages at 2cfe793, checked against "
            "that source's fixtures"
        ),
        "tags": {"fingerprint": FINGERPRINT_TAG.decode()},
        "recordType": CHAIN_TYPE,
        "maxProofLength": MAX_PROOF,
        "standInProofLength": STAND_IN_PROOF,
        "constants": {
            "schemaVersion": SCHEMA_VERSION,
            "certificateTreeHeight": CERTIFICATE_TREE_HEIGHT,
            "emptyRevocationRoot": hexf(zeroes(REVOCATION_TREE_HEIGHT)[-1]),
            "emptyMasterlistRoot": hexf(zeroes(MASTERLIST_TREE_HEIGHT)[-1]),
            "certificateTreeZeroes": [hexf(v) for v in zeroes(CERTIFICATE_TREE_HEIGHT)],
        },
        "parameterCommitments": {
            "age": {"minAge": MIN_AGE, "maxAge": 0, "commitment": hexf(age_commitment(MIN_AGE, 0))},
            "nationality": [
                {"countries": [c], "commitment": hexf(nationality_commitment([c.encode()]))} for c in ("USA", "ZKR")
            ],
        },
        "anchors": [anchor_json(a) for a in anchors_usa + anchors_zkr],
        "deployments": [deployment_json(usa), deployment_json(zkr)],
        "circuits": {
            "dsc": [k.hex() for k in circuits["dsc"]],
            "id": [k.hex() for k in circuits["id"]],
            "integrity": [k.hex() for k in circuits["integrity"]],
            "age": disclosure_keys["age"].hex(),
            "nationality": disclosure_keys["nationality"].hex(),
        },
        "accepted": accepted,
        "rejected": rejected,
    }
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "identity-chain.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
