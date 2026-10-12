#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/identity-backup.json.

A second implementation of docs/spec/identity-backup.md: the identity secret's
encoding and its sampling, the PRF salt, the HKDF-derived wrap key and
locator, the server's row identifier, the associated data and the envelope
(record type 0x000a), and how an envelope opens or fails. HKDF is written here
from RFC 5869 over Python's hmac and hashlib, and checked first against RFC
5869 Appendix A.1 to A.3 (parsed from the vendored RFC text);
ChaCha20-Poly1305 is share-encryption-vectors.py's, written from RFC 8439 and
checked against its vectors. Neither shares code with packages/crypto or any
@noble library.

Every PRF output, secret and nonce comes from SHA-256 over a fixed label, and
each vector lists them, so any implementation can reproduce its bytes. They
are test data, never keys.

Usage: python3 -I packages/crypto/scripts/identity-backup-vectors.py <out-dir>
"""

import hashlib
import hmac
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


se = _load("share_encryption_vectors", "share-encryption-vectors.py")

# Baby Jubjub's prime-subgroup order (EIP-2494), as docs/spec/membership.md gives it.
L = 2736030358979909402780800718157159386076813972158567259200215660948447373041
RECORD_TYPE = 0x000A
VERSION = 1

PRF_SALT_TAG = b"abolish/v1/identity-backup/prf-salt"
WRAP_KEY_TAG = b"abolish/v1/identity-backup/wrap-key"
LOCATOR_TAG = b"abolish/v1/identity-backup/locator"
ID_TAG = b"abolish/v1/identity-backup/id"
AAD_TAG = b"abolish/v1/identity-backup/aad"


def ds(tag, m):
    return bytes([len(tag)]) + tag + m


def H(m):
    return hashlib.sha256(m).digest()


def hkdf(ikm, salt, info, length):
    """RFC 5869 §2.2 and §2.3 with SHA-256; an empty salt is HashLen zeros."""
    prk = hmac.new(salt if salt else bytes(32), ikm, hashlib.sha256).digest()
    okm, t, i = b"", b"", 1
    while len(okm) < length:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        okm += t
        i += 1
    return okm[:length]


def hkdf_self_check():
    text = (HERE.parent.parent / "test-vectors" / "rfc" / "rfc5869.txt").read_text("ascii")
    cases = 0
    for n in (1, 2, 3):
        start = text.index(f"\nA.{n}.  Test Case {n}\n")
        body = text[start : text.index(f"\nA.{n + 1}.  Test Case {n + 1}\n")]

        def field(name):
            m = re.search(rf"^   {name} *= (?:0x((?:[0-9a-f]+\s+)+?))?\((\d+) octets\)", body, re.M)
            hexdigits = re.sub(r"\s", "", m.group(1) or "")
            assert len(hexdigits) == 2 * int(m.group(2)), name
            return bytes.fromhex(hexdigits)

        assert re.search(r"^   Hash = SHA-256$", body, re.M)
        length = int(re.search(r"^   L    = (\d+)$", body, re.M).group(1))
        assert hkdf(field("IKM"), field("salt"), field("info"), length) == field("OKM"), n
        cases += 1
    assert cases == 3


def secret_bytes(s):
    return s.to_bytes(32, "big")


def is_secret(b):
    return len(b) == 32 and 1 <= int.from_bytes(b, "big") < L


def sample(draws):
    """The spec's rejection sampling over a given sequence of 32-byte draws."""
    for i, d in enumerate(draws):
        v = bytes([d[0] & 0x07]) + d[1:]
        if is_secret(v):
            return v, i
    raise AssertionError("no draw kept")


def derive(prf):
    wrap_key = hkdf(prf, b"", ds(WRAP_KEY_TAG, b""), 32)
    locator = hkdf(prf, b"", ds(LOCATOR_TAG, b""), 32)
    return wrap_key, locator


def aad(version, locator):
    return ds(AAD_TAG, RECORD_TYPE.to_bytes(2, "big") + bytes([version]) + locator)


def envelope(nonce, sealed, record_type=RECORD_TYPE, version=VERSION):
    return record_type.to_bytes(2, "big") + bytes([version]) + nonce + sealed


def open_envelope(prf, env):
    """The spec's Opening, in its order: strict decoding, then the tag, then the secret."""
    if len(env) < 2:
        return "truncated"
    # An envelope decoder knows only 0x000a, as receipts' knows only 0x0004.
    if int.from_bytes(env[:2], "big") != RECORD_TYPE:
        return "unknown-record-type"
    if len(env) < 3:
        return "truncated"
    if env[2] != VERSION:
        return "unknown-version"
    if len(env) < 63:
        return "truncated"
    if len(env) > 63:
        return "trailing-bytes"
    nonce, sealed = env[3:15], env[15:]
    wrap_key, locator = derive(prf)
    plain = se.aead_open(wrap_key, nonce, aad(env[2], locator), sealed)
    if plain is None:
        return "backup-open"
    if not is_secret(plain):
        return "backup-secret"
    return plain


def label(name, n=32):
    out, i = b"", 0
    while len(out) < n:
        out += H(b"abolish identity-backup vectors " + name.encode() + bytes([i]))
        i += 1
    return out[:n]


def kept_label(name):
    """The first of name, name/1, name/2, … whose label the sampler keeps, so a sequence ends where it should."""
    i = 0
    while True:
        d = label(name if i == 0 else f"{name}/{i}")
        if is_secret(bytes([d[0] & 0x07]) + d[1:]):
            return d
        i += 1


def h(b):
    return b.hex()


def main():
    se.aead_self_check()
    hkdf_self_check()
    out_dir = sys.argv[1]

    prf_salt = H(ds(PRF_SALT_TAG, b""))

    secrets = [
        ("secret-zero", 0, False),
        ("secret-one", 1, True),
        ("secret-order-minus-one", L - 1, True),
        ("secret-order", L, False),
        ("secret-order-plus-one", L + 1, False),
        ("secret-2-251", 1 << 251, False),
        ("secret-max", (1 << 256) - 1, False),
        ("secret-labelled", int.from_bytes(label("secret-labelled"), "big") % L, True),
    ]
    secret_vectors = [{"id": i, "encoding": h(secret_bytes(s)), "isSecret": ok} for i, s, ok in secrets]
    for v in secret_vectors:
        assert is_secret(bytes.fromhex(v["encoding"])) == v["isSecret"]
    secret_vectors.append({"id": "secret-short", "encoding": h(secret_bytes(1)[1:]), "isSecret": False})
    secret_vectors.append({"id": "secret-long", "encoding": h(b"\x00" + secret_bytes(1)), "isSecret": False})

    # Draw sequences for the sampler: the top 5 bits are cleared, then the
    # value is kept if 1 ≤ v < l. Hand-made rejected draws exercise each way
    # out of range; the last draw of each sequence is kept.
    def set_top_bits(d):
        return bytes([d[0] | 0xF8]) + d[1:]

    above = secret_bytes(L)  # top 5 bits already clear, and v = l: rejected
    sampling = []
    for name, draws in [
        ("sample-first", [kept_label("sample-first")]),
        ("sample-top-bits-cleared", [set_top_bits(kept_label("sample-top"))]),
        ("sample-zero-then", [bytes(32), b"\xf8" + bytes(31), kept_label("sample-zero-then")]),
        ("sample-order-then", [above, set_top_bits(above), kept_label("sample-order-then")]),
        ("sample-top-bits-only-then", [b"\xf8" + bytes(31), b"\x07" + b"\xff" * 31, kept_label("sample-x")]),
    ]:
        secret, kept = sample(draws)
        assert kept == len(draws) - 1, name
        sampling.append({"id": name, "draws": [h(d) for d in draws], "secret": h(secret)})

    backups = []
    for name, description, secret in [
        ("backup-labelled", "A secret, PRF output and nonce from labels", None),
        ("backup-one", "The secret 1", 1),
        ("backup-order-minus-one", "The secret l − 1", L - 1),
        ("backup-zero-nonce", "An all-zero nonce: any 12 bytes are a nonce", None),
    ]:
        prf = label(name + "/prf")
        s = secret_bytes(secret) if secret is not None else secret_bytes(int.from_bytes(label(name + "/secret"), "big") % L)
        assert is_secret(s)
        nonce = bytes(12) if name == "backup-zero-nonce" else label(name + "/nonce", 12)
        wrap_key, locator = derive(prf)
        a = aad(VERSION, locator)
        sealed = se.aead_seal(wrap_key, nonce, a, s)
        env = envelope(nonce, sealed)
        assert len(env) == 63 and open_envelope(prf, env) == s
        backups.append(
            {
                "id": name,
                "description": description,
                "prfOutput": h(prf),
                "secret": h(s),
                "nonce": h(nonce),
                "wrapKey": h(wrap_key),
                "locator": h(locator),
                "backupId": h(H(ds(ID_TAG, locator))),
                "aad": h(a),
                "envelope": h(env),
            }
        )

    base = backups[0]
    prf = bytes.fromhex(base["prfOutput"])
    env = bytes.fromhex(base["envelope"])
    wrap_key, locator = derive(prf)

    def flip(b, i):
        return b[:i] + bytes([b[i] ^ 1]) + b[i + 1 :]

    def sealed_plain(plain, version_in_aad=VERSION, locator_in_aad=None, record_version=VERSION):
        nonce = label("open/" + h(plain)[:8], 12)
        a = aad(version_in_aad, locator if locator_in_aad is None else locator_in_aad)
        return envelope(nonce, se.aead_seal(wrap_key, nonce, a, plain), version=record_version)

    open_cases = [
        ("open-other-prf", "Another passkey's PRF output", label("other/prf"), env, "backup-open"),
        ("open-nonce-altered", "A nonce bit flipped", prf, flip(env, 3), "backup-open"),
        ("open-ciphertext-altered", "A ciphertext bit flipped", prf, flip(env, 15), "backup-open"),
        ("open-tag-altered", "A tag bit flipped", prf, flip(env, 62), "backup-open"),
        (
            "open-other-locator-in-aad",
            "Sealed with another locator in the associated data",
            prf,
            sealed_plain(bytes.fromhex(base["secret"]), locator_in_aad=label("other/locator")),
            "backup-open",
        ),
        (
            "open-other-version-in-aad",
            "Sealed with version 2 in the associated data, framed as version 1",
            prf,
            sealed_plain(bytes.fromhex(base["secret"]), version_in_aad=2),
            "backup-open",
        ),
        ("open-secret-zero", "Opens, but the plaintext is 0", prf, sealed_plain(secret_bytes(0)), "backup-secret"),
        ("open-secret-order", "Opens, but the plaintext is l", prf, sealed_plain(secret_bytes(L)), "backup-secret"),
        (
            "open-secret-max",
            "Opens, but the plaintext is 2²⁵⁶ − 1",
            prf,
            sealed_plain(secret_bytes((1 << 256) - 1)),
            "backup-secret",
        ),
        ("decode-empty", "No bytes", prf, b"", "truncated"),
        ("decode-header-only", "Only the record type", prf, env[:2], "truncated"),
        ("decode-short", "One byte short", prf, env[:-1], "truncated"),
        ("decode-trailing", "One byte more", prf, env + b"\x00", "trailing-bytes"),
        ("decode-type-zero", "Record type 0x0000", prf, b"\x00\x00" + env[2:], "unknown-record-type"),
        ("decode-type-receipt", "Record type 0x0004, a receipt", prf, b"\x00\x04" + env[2:], "unknown-record-type"),
        ("decode-type-unassigned", "Record type 0x000b, unassigned", prf, b"\x00\x0b" + env[2:], "unknown-record-type"),
        ("decode-version-zero", "Version 0", prf, env[:2] + b"\x00" + env[3:], "unknown-version"),
        ("decode-version-two", "Version 2, unknown", prf, env[:2] + b"\x02" + env[3:], "unknown-version"),
    ]
    open_vectors = []
    for name, description, p, e, code in open_cases:
        assert open_envelope(p, e) == code, name
        open_vectors.append({"id": name, "description": description, "prfOutput": h(p), "envelope": h(e), "code": code})

    out = {
        "format": "abolish-identity-backup-vectors/1",
        "title": "Identity backup: the secret's encoding and sampling, the PRF salt, keys, locator, row id and envelope",
        "spec": "docs/spec/identity-backup.md",
        "generator": (
            "packages/crypto/scripts/identity-backup-vectors.py: an independent Python implementation (standard "
            "library only), with HKDF from RFC 5869 over hmac, checked against RFC 5869 Appendix A.1 to A.3, and "
            "share-encryption-vectors.py's ChaCha20-Poly1305, checked against RFC 8439's vectors"
        ),
        "tags": {
            "prfSalt": PRF_SALT_TAG.decode(),
            "wrapKey": WRAP_KEY_TAG.decode(),
            "locator": LOCATOR_TAG.decode(),
            "id": ID_TAG.decode(),
            "aad": AAD_TAG.decode(),
        },
        "order": str(L),
        "prfSalt": h(prf_salt),
        "secrets": secret_vectors,
        "sampling": sampling,
        "backups": backups,
        "open": open_vectors,
    }
    path = pathlib.Path(out_dir) / "identity-backup.json"
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
