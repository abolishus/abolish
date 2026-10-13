#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/key-set.json.

A second implementation of the registered key set's hashes
(docs/spec/ceremony.md, Key set hash) and of the second ceremony
registration statement (docs/spec/trustee-identity.md, Ceremony
registration), written from the spec with Python's standard library only and
sharing no code with packages/crypto. The P-256 arithmetic and RFC 6979
signing are trustee-vectors.py's (itself independent of packages/crypto, and
checked there against RFC 6979 Appendix A.2.5 before it signs anything), so
the identity keys are trustee.json's. The KEM keys are share-encryption.json's
`panel-16` keys, read as bytes: hashing a key needs only its encoding.

Usage: python3 -I packages/crypto/scripts/key-set-vectors.py <out-dir>
"""

import hashlib
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
VECTORS = HERE.parents[2] / "docs" / "spec" / "vectors"

_spec = importlib.util.spec_from_file_location("trustee_vectors", HERE / "trustee-vectors.py")
tv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tv)

KEM_KEY_TAG = b"abolish/v1/kem-key"
KEY_SET_TAG = b"abolish/v1/key-set"
REGISTRATION_TAG = b"abolish/v1/sig/ceremony-registration-2"
MAX_TRUSTEES = 16
KEM_KEY_LEN = 1184 + 32


def sha256(b):
    return hashlib.sha256(b).digest()


def ds(tag, m):
    assert 12 <= len(tag) <= 255
    return bytes([len(tag)]) + tag + m


def h(b):
    return b.hex()


def u32(v):
    return v.to_bytes(4, "big")


def kem_key_hash(kem_key):
    assert len(kem_key) == KEM_KEY_LEN
    return sha256(ds(KEM_KEY_TAG, kem_key))


def key_set_encoding(entries):
    """`list<key_set_entry, MAX_TRUSTEES>`: u32 count, then 66 bytes per seat."""
    out = u32(len(entries))
    for index, kh, signing_key in entries:
        assert len(kh) == 32 and len(signing_key) == 33
        out += bytes([index]) + kh + signing_key
    assert len(out) == 4 + 66 * len(entries)
    return out


def key_set_hash(entries):
    return sha256(ds(KEY_SET_TAG, key_set_encoding(entries)))


def statement(chain, registry, pid, index, stub, transcript, ksh):
    m = tv.u64(chain) + registry + pid + bytes([index]) + stub + transcript + ksh
    assert len(m) == 157
    return m


def main(out_dir):
    tv.self_check()
    trustee = json.loads((VECTORS / "trustee.json").read_text())
    panel_keys = {k["id"]: k for k in trustee["keys"]}
    identity_secrets = [int(panel_keys[f"key-{i}"]["secretKey"], 16) for i in range(1, 8)]
    identity_keys = [tv.compress(tv.mul(d, tv.G)) for d in identity_secrets]
    # trustee.json's keys are the ones these secrets give.
    for i, key in enumerate(identity_keys):
        assert key.hex() == panel_keys[f"key-{i + 1}"]["encoding"]
    pid = tv.panel_id(4, identity_keys)
    assert pid.hex() == next(p["panelId"] for p in trustee["panels"] if p["id"] == "panel-4-of-7")

    share = json.loads((VECTORS / "share-encryption.json").read_text())
    kem_keys = [bytes.fromhex(k["publicKey"]) for k in share["panels"]["panel-16"]]
    assert len(kem_keys) == MAX_TRUSTEES and all(len(k) == KEM_KEY_LEN for k in kem_keys)

    # Per-election signing keys, one per seat: test secrets, never real keys.
    signing_points = [tv.mul(tv.secret(b"signing-" + bytes([i])), tv.G) for i in range(1, 17)]
    signing_keys = [tv.compress(q) for q in signing_points]
    assert len(set(signing_keys)) == 16 and not set(signing_keys) & set(identity_keys)

    kem_vectors = []
    # Seat i's KEM key is kem-key-i in every set; entries carry only its hash.
    for i, k in enumerate(kem_keys):
        kem_vectors.append({"id": f"kem-key-{i + 1}", "kemKey": h(k), "kemKeyHash": h(kem_key_hash(k))})

    def entry(seat):
        return (seat, kem_key_hash(kem_keys[seat - 1]), signing_keys[seat - 1])

    def entry_json(seat):
        q = signing_points[seat - 1]
        return {
            "index": seat,
            "kemKeyHash": h(kem_key_hash(kem_keys[seat - 1])),
            "signingKey": h(signing_keys[seat - 1]),
            "x": h(q[0].to_bytes(32, "big")),
            "y": h(q[1].to_bytes(32, "big")),
        }

    sets = {}
    set_vectors = []
    for vid, desc, seats in [
        ("key-set-7", "every seat of a 7-seat panel", list(range(1, 8))),
        ("key-set-6-of-7", "seat 4 disqualified: n - 1 seats, the fewest rule 7 opens with", [1, 2, 3, 5, 6, 7]),
        ("key-set-gaps", "seats 3 and 6 disqualified", [1, 2, 4, 5, 7]),
        ("key-set-2", "the smallest threshold's set, seats 1 and 2", [1, 2]),
        ("key-set-16", "MAX_TRUSTEES seats", list(range(1, 17))),
        ("key-set-last-seats", "seats 15 and 16 only", [15, 16]),
    ]:
        entries = [entry(s) for s in seats]
        sets[vid] = entries
        set_vectors.append(
            {
                "id": vid,
                "description": desc,
                "entries": [entry_json(s) for s in seats],
                "encoding": h(key_set_encoding(entries)),
                "keySetHash": h(key_set_hash(entries)),
            }
        )
    # Order matters: the same seats listed another way are another set, and
    # so is one with another seat's KEM key.
    assert key_set_hash(sets["key-set-2"]) != key_set_hash(list(reversed(sets["key-set-2"])))
    swapped = [(1, sets["key-set-2"][1][1], signing_keys[0]), sets["key-set-2"][1]]
    assert key_set_hash(swapped) != key_set_hash(sets["key-set-2"])

    rejected = []
    for vid, desc, seats, err in [
        ("key-set-empty", "no seats: a valid transcript has at least k >= 2", [], "empty"),
        ("key-set-unordered", "seats 2 then 1", [2, 1], "seat-order"),
        ("key-set-repeated-seat", "seat 2 twice", [1, 2, 2], "seat-order"),
        ("key-set-seat-0", "seat 0", [0, 1], "seat-order"),
        ("key-set-seat-17", "seat 17, above MAX_TRUSTEES", [16, 17], "seat-order"),
    ]:
        rejected.append(
            {
                "id": vid,
                "description": desc,
                "entries": [
                    {
                        "index": s,
                        "kemKeyHash": h(kem_key_hash(kem_keys[(s - 1) % 16])),
                        "signingKey": h(signing_keys[(s - 1) % 16]),
                    }
                    for s in seats
                ],
                "error": err,
            }
        )
    bad = entry_json(1)
    bad["signingKey"] = "04" + bad["x"]
    rejected.append(
        {
            "id": "key-set-bad-signing-key",
            "description": "a signing key with prefix 0x04, not a p256-key",
            "entries": [bad, entry_json(2)],
            "error": "non-canonical",
        }
    )

    registry = bytes.fromhex("5fbdb2315678afecb367f032d93f642f64180aa3")
    statements = []
    for vid, chain, index, stub_label, tr_label, set_id in [
        ("statement-seat-1", 84532, 1, b"stub-a", b"transcript-a", "key-set-7"),
        ("statement-seat-7", 84532, 7, b"stub-a", b"transcript-a", "key-set-7"),
        ("statement-gaps", 84532, 3, b"stub-a", b"transcript-a", "key-set-gaps"),
        ("statement-anvil", 31337, 4, b"stub-b", b"transcript-b", "key-set-6-of-7"),
        ("statement-max-chain-id", 2**64 - 1, 2, b"stub-c", b"transcript-c", "key-set-2"),
    ]:
        stub, tr = sha256(stub_label), sha256(tr_label)
        ksh = key_set_hash(sets[set_id])
        m = statement(chain, registry, pid, index, stub, tr, ksh)
        M = ds(REGISTRATION_TAG, m)
        _k, r, s = tv.ecdsa_sign(identity_secrets[index - 1], M)
        sig = tv.sig_bytes(r, s)
        assert tv.verify(identity_keys[index - 1], M, sig)
        # Another key set makes another statement, which the signature doesn't cover.
        other = statement(chain, registry, pid, index, stub, tr, key_set_hash(sets["key-set-2"] if set_id != "key-set-2" else sets["key-set-7"]))
        assert not tv.verify(identity_keys[index - 1], ds(REGISTRATION_TAG, other), sig)
        statements.append(
            {
                "id": vid,
                "panel": "panel-4-of-7",
                "l2ChainId": str(chain),
                "trusteeRegistry": h(registry),
                "index": index,
                "stubHash": h(stub),
                "ceremonyTranscriptHash": h(tr),
                "keySet": set_id,
                "keySetHash": h(ksh),
                "message": h(m),
                "digest": h(sha256(M)),
                "signature": h(sig),
            }
        )

    out = {
        "format": "abolish-key-set-vectors/1",
        "title": "Registered key set: KEM-key and key-set hashes, and the ceremony registration statement that signs them",
        "spec": "docs/spec/ceremony.md",
        "generator": (
            "packages/crypto/scripts/key-set-vectors.py: an independent Python implementation (standard library only), "
            "signing with trustee-vectors.py's P-256 and RFC 6979 code; identity keys from trustee.json, KEM keys from "
            "share-encryption.json's panel-16"
        ),
        "tags": {
            "kemKey": KEM_KEY_TAG.decode(),
            "keySet": KEY_SET_TAG.decode(),
            "registration": REGISTRATION_TAG.decode(),
        },
        "kemKeys": kem_vectors,
        "keySets": set_vectors,
        "rejectedKeySets": rejected,
        "statements": statements,
    }
    path = pathlib.Path(out_dir) / "key-set.json"
    path.write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
