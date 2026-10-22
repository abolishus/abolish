#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/deployment-record-v2.json.

A second implementation of docs/spec/deployment.md's version 2: version 1's
record with the Tier 0 token issuer's period keys appended
(`tier0_token_keys`), its strict decoding of both versions, the
well-formedness rules of version 2 in their order, and the rules two
releases' records meet across releases (P2-30 part 3c). Standard library
only; it shares no code with packages/crypto. It reuses
deployment-record-vectors.py's version-1 fields, rules and vectors,
group-vectors.py's ristretto255 decoding and tier0-token-vectors.py's key
identifier, and leaves deployment-record.json, which freezes version 1, as it
is.

Every token key is `skS · g` for a scalar from a labelled test secret, so any
implementation can reproduce each encoding.

Usage: python3 -I packages/crypto/scripts/deployment-record-v2-vectors.py <vectors-dir>
(reads site-directory.json from it and writes deployment-record-v2.json beside it)
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


v1 = _load("deployment_record_vectors", "deployment-record-vectors.py")
grp = _load("group_vectors", "group-vectors.py")
tok = _load("tier0_token_vectors", "tier0-token-vectors.py")
rr = v1.rr
h, u8, u32, lst = rr.h, rr.u8, rr.u32, rr.lst
DecodeError, Reader = rr.DecodeError, rr.Reader

VERSION = 2
MAX_TOKEN_KEYS = 16
TOKEN_KEY_PERIOD = tok.KEY_PERIOD
# The largest version-2 encoding: version 1's largest and sixteen token keys.
MAX_ENCODING = v1.MAX_ENCODING + 4 + MAX_TOKEN_KEYS * (4 + 32 + 1)

TOKEN_RULES = ["token-keys-empty", "token-key", "token-key-repeated", "token-key-order"]
RULES = v1.RULES + TOKEN_RULES
ACROSS_RULES = ["token-key-changed", "token-key-unretired"]


# --- Encoding ----------------------------------------------------------------


def enc_token_key(k):
    return u32(k["period"]) + k["key"] + u8(1 if k["retired"] else 0)


def encode(d, version=VERSION):
    head = rr.u16(v1.RECORD_TYPE) + u8(version) + v1.encode_fields(d)
    return head + lst(d["tier0_token_keys"], enc_token_key) if version == VERSION else head


def decode(b):
    """Either version, as a reader of both decodes it."""
    r = Reader(b)
    if r.int(2) != v1.RECORD_TYPE:
        raise DecodeError("unknown-record-type")
    version = r.int(1)
    if version not in (1, VERSION):
        raise DecodeError("unknown-version")
    d = v1.decode_fields(r)
    if version == VERSION:
        d["tier0_token_keys"] = r.lst(
            MAX_TOKEN_KEYS, lambda r: {"period": r.int(4), "key": r.take(32), "retired": r.enum({0, 1}) == 1}
        )
    if r.at != len(b):
        raise DecodeError("trailing-bytes")
    return version, d


# --- Well-formedness, from docs/spec/deployment.md ---------------------------


def element_ok(b):
    """A canonical ristretto255 encoding of an element other than the identity ([[group]], Encodings)."""
    return b != bytes(32) and grp.decode(b) is not None


def ill_formed(d):
    """The first rule a version-2 record breaks, in the spec's order, with where, or None."""
    got = v1.ill_formed(d)
    if got is not None:
        return got
    keys = d["tier0_token_keys"]
    if not keys:
        return "token-keys-empty", {}
    seen = set()
    for i, k in enumerate(keys):
        if not element_ok(k["key"]):
            return "token-key", {"key": i}
        if k["key"] in seen:
            return "token-key-repeated", {"key": i}
        seen.add(k["key"])
    periods = [k["period"] for k in keys]
    if any(b != a + 1 for a, b in zip(periods, periods[1:])):
        return "token-key-order", {}
    return None


def across(earlier, later):
    """The first rule of Across releases two well-formed version-2 records break, with the period, or None."""
    assert ill_formed(earlier) is None and ill_formed(later) is None
    before = {k["period"]: k for k in earlier["tier0_token_keys"]}
    for k in later["tier0_token_keys"]:
        e = before.get(k["period"])
        if e is not None and e["key"] != k["key"]:
            return "token-key-changed", {"period": k["period"]}
    for k in later["tier0_token_keys"]:
        e = before.get(k["period"])
        if e is not None and e["retired"] and not k["retired"]:
            return "token-key-unretired", {"period": k["period"]}
    return None


# --- Vectors -----------------------------------------------------------------

# The period of 2026-10-22, when this item was written.
Q = 1_792_627_200 // TOKEN_KEY_PERIOD


def secret(label):
    k = int.from_bytes(hashlib.sha512(b"abolish deployment token key " + label.encode()).digest(), "little") % grp.L
    assert k != 0
    return k


def token_key(q, label=None, retired=False):
    pk = grp.encode(grp.mul(secret(label or f"period {q}"), grp.BASE))
    return {"period": q, "key": pk, "retired": retired}


def with_keys(d, keys):
    out = v1.clone(d)
    out["tier0_token_keys"] = keys
    return out


def typical(base):
    # The period before, the current one and six ahead (Token keys).
    return with_keys(base, [token_key(q) for q in range(Q - 1, Q + 7)])


def value_json(d):
    out = v1.value_json({k: v for k, v in d.items() if k != "tier0_token_keys"})
    if "tier0_token_keys" in d:
        out["tier0_token_keys"] = [{"period": str(k["period"]), "key": h(k["key"]), "retired": k["retired"]} for k in d["tier0_token_keys"]]
    return out


def key_ids(d):
    """Each listed key's key_id ([[tier0-token]], Keys), for a reader to check its own against."""
    return [h(tok.key_id(k["period"], k["key"])) for k in d["tier0_token_keys"]]


def types():
    t = v1.types()
    t["deployment"]["version"] = 1
    t["token_key"] = {
        "kind": "struct",
        "fields": [
            {"name": "period", "type": {"kind": "u32"}},
            {"name": "key", "type": {"kind": "bytes", "length": 32}},
            {"name": "retired", "type": {"kind": "bool"}},
        ],
    }
    t["deployment_v2"] = {
        "kind": "record",
        "recordType": f"{v1.RECORD_TYPE:04x}",
        "version": VERSION,
        "fields": t["deployment"]["fields"]
        + [{"name": "tier0_token_keys", "type": {"kind": "list", "max": MAX_TOKEN_KEYS, "of": {"kind": "ref", "name": "token_key"}}}],
    }
    return t


def boundaries(base):
    # Version 1's largest, with sixteen keys ending at the last u32 period.
    last = 2**32 - 1
    return with_keys(v1.boundaries(base), [token_key(q, retired=q == last - 15) for q in range(last - 15, last + 1)])


def ill_formed_cases(base):
    def key_at(i, value):
        return lambda d: d["tier0_token_keys"][i].__setitem__("key", value)

    first = base["tier0_token_keys"][0]["key"]
    # A 32-byte string that isn't an element: the first odd s, then s = p (not canonical), then a negative s.
    no_point = next(b for b in (i.to_bytes(32, "little") for i in range(2, 200, 2)) if grp.decode(b) is None)
    at_p = grp.P.to_bytes(32, "little")
    negative = (1).to_bytes(32, "little")
    K = lambda i: {"key": i}  # noqa: E731
    keys = lambda f: lambda d: d.__setitem__("tier0_token_keys", f(d["tier0_token_keys"]))  # noqa: E731
    return [
        ("token-keys-empty", "No token key", keys(lambda ks: []), "token-keys-empty", {}),
        ("token-key-identity", "The identity as a token key", key_at(0, bytes(32)), "token-key", K(0)),
        ("token-key-no-point", "A token key that decodes to no element", key_at(3, no_point), "token-key", K(3)),
        ("token-key-non-canonical", "A token key with s at the field prime", key_at(1, at_p), "token-key", K(1)),
        ("token-key-negative", "A token key with a negative s", key_at(7, negative), "token-key", K(7)),
        ("token-key-repeated", "One key for two periods", key_at(2, first), "token-key-repeated", K(2)),
        (
            "token-key-repeated-retired",
            "A retired period's key again for the next period",
            lambda d: (d["tier0_token_keys"][1].__setitem__("retired", True), key_at(2, d["tier0_token_keys"][1]["key"])(d)),
            "token-key-repeated",
            K(2),
        ),
        ("token-key-gap", "A period with no key between two that have one", keys(lambda ks: ks[:3] + ks[4:]), "token-key-order", {}),
        ("token-key-unsorted", "Two periods out of order", keys(lambda ks: [ks[1], ks[0]] + ks[2:]), "token-key-order", {}),
        ("token-key-same-period", "Two keys for one period", keys(lambda ks: ks[:2] + [token_key(ks[1]["period"], "second key")] + ks[2:]), "token-key-order", {}),
        ("token-key-retired", "A key retired early, listed with its period: well formed", lambda d: d["tier0_token_keys"][2].__setitem__("retired", True), None, {}),
        ("token-key-one", "One key, for the current period: well formed", keys(lambda ks: [token_key(Q)]), None, {}),
        ("token-key-all-retired", "Every key retired: well formed (the release offers no token)", keys(lambda ks: [dict(k, retired=True) for k in ks]), None, {}),
        (
            "rule-order-token-keys",
            "No panel and no token key: version 1's rules come first",
            lambda d: (d.__setitem__("panels", []), d.__setitem__("tier0_token_keys", [])),
            "panels-empty",
            {},
        ),
        (
            "rule-order-token-key",
            "A repeated key before an invalid one, and a gap: key by key, the repeat comes first",
            lambda d: (key_at(1, first)(d), key_at(2, bytes(32))(d), d.__setitem__("tier0_token_keys", d["tier0_token_keys"][:4] + d["tier0_token_keys"][5:])),
            "token-key-repeated",
            K(1),
        ),
        ("rule-order-key-before-order", "Two periods out of order, the second key the identity: token-key comes first", keys(lambda ks: [ks[1], dict(ks[0], key=bytes(32))] + ks[2:]), "token-key", K(1)),
    ]


def decode_cases(d):
    enc = encode(d)
    keys_at = len(encode(d, version=1))
    first = keys_at + 4

    def at(i, b):
        return enc[:i] + b + enc[i + len(b) :]

    return [
        ("truncated-token-keys", "Cut inside the token keys' count", enc[: keys_at + 2], "truncated"),
        ("truncated-token-key", "Cut inside the first token key", enc[: first + 20], "truncated"),
        ("truncated-last-byte", "The last byte missing", enc[:-1], "truncated"),
        ("trailing-byte", "A byte after the last field", enc + b"\x00", "trailing-bytes"),
        ("token-keys-over-max", "Seventeen token keys", at(keys_at, u32(MAX_TOKEN_KEYS + 1)), "length-over-max"),
        ("retired-two", "A retired byte of 2", at(first + 4 + 32, b"\x02"), "invalid-enum"),
        ("version-three", "Version 2's layout labelled version 3, which has no layout", at(2, b"\x03"), "unknown-version"),
        ("version-zero", "Version 0", at(2, b"\x00"), "unknown-version"),
        ("v2-labelled-one", "Version 2's layout labelled version 1: its token keys are trailing bytes", at(2, b"\x01"), "trailing-bytes"),
        ("v1-labelled-two", "Version 1's layout labelled version 2: no token keys", encode(d, version=1)[:2] + b"\x02" + encode(d, version=1)[3:], "truncated"),
        ("release-type", "The release record's type", at(0, b"\x00\x1f"), "unknown-record-type"),
    ]


def across_cases(base):
    ks = base["tier0_token_keys"]

    def later(keys):
        return with_keys(base, keys)

    def retire(keys, q):
        return [dict(k, retired=True) if k["period"] == q else dict(k) for k in keys]

    retired = retire(ks, Q + 1)
    return [
        ("same", "The same keys in both releases", base, later([dict(k) for k in ks]), None),
        ("later-moves-on", "A later release that drops the oldest periods and lists two more", base, later(ks[2:] + [token_key(Q + 7), token_key(Q + 8)]), None),
        ("disjoint", "Releases with no period in common", base, later([token_key(q) for q in range(Q + 10, Q + 12)]), None),
        ("retired-later", "A key retired in the later release", base, later(retired), None),
        ("retired-kept", "A key retired in both", with_keys(base, retired), later(retired), None),
        ("changed", "Another key for a period both list", base, later(ks[:3] + [token_key(ks[3]["period"], "replacement")] + ks[4:]), "token-key-changed"),
        ("changed-retired", "A retired key replaced within its period", with_keys(base, retired), later(ks[:2] + [token_key(Q + 1, "replacement", True)] + ks[3:]), "token-key-changed"),
        ("unretired", "A key retired in the earlier release listed as live in the later", with_keys(base, retired), later(ks), "token-key-unretired"),
        (
            "across-rule-order",
            "One period's key unretired and a later period's key changed: token-key-changed comes first",
            with_keys(base, retired),
            later(ks[:5] + [token_key(ks[5]["period"], "replacement")] + ks[6:]),
            "token-key-changed",
        ),
    ]


def main():
    vectors_dir = pathlib.Path(sys.argv[1])
    site_vectors = json.loads((vectors_dir / "site-directory.json").read_text())["vectors"]
    rr.check_sites(site_vectors)

    ballot_like = rr.site_from(site_vectors, "ballot-like", 1, (), True, [])
    by_path = {f["path"]: f["sha256"] for f in ballot_like["files"]}
    zkey = by_path[b"assets/semaphore-32-0123.zkey"]
    wasm = by_path[b"assets/worker-77b0.js"]

    v1_base = v1.typical(zkey, wasm)
    base = typical(v1_base)
    bounds = boundaries(v1_base)
    valid = [
        ("typical", "Version 1's typical deployment with the token keys of the period before, the current one and six ahead", base),
        ("boundaries", "Version 1's largest record with sixteen token keys, the last at the largest period", bounds),
    ]

    out_vectors = []

    def valid_vector(vid, description, d, extra=None):
        enc = encode(d)
        assert decode(enc) == (VERSION, d), vid
        v = {"id": vid, "description": description, "type": {"kind": "ref", "name": "deployment_v2"}, "encoding": h(enc), "value": value_json(d)}
        v["deploymentHash"] = h(v1.deployment_hash(enc))
        v.update(extra or {})
        out_vectors.append(v)

    for vid, description, d in valid:
        assert ill_formed(d) is None, (vid, ill_formed(d))
        valid_vector(vid, description, d, {"keyIds": key_ids(d)})
    # Version 1's typical record, which a reader of both versions still
    # decodes, and whose hash differs from any version-2 record's.
    enc1 = encode(v1_base, version=1)
    assert decode(enc1) == (1, v1_base) and v1.ill_formed(v1_base) is None
    out_vectors.append(
        {
            "id": "version-1",
            "description": "Version 1's typical deployment, which a reader of both versions decodes as version 1",
            "type": {"kind": "ref", "name": "deployment"},
            "encoding": h(enc1),
            "value": value_json(v1_base),
            "deploymentHash": h(v1.deployment_hash(enc1)),
        }
    )
    assert len(encode(bounds)) == MAX_ENCODING

    # Version 1's ill-formed records, each with the typical token keys, then
    # the token keys' own: a version-2 record breaks version 1's rules first.
    cases = [(f"v1-{vid}", description, mutate, code, where) for vid, description, mutate, code, where in v1.ill_formed_cases(v1_base) if code is not None]
    cases += ill_formed_cases(base)
    for vid, description, mutate, code, where in cases:
        d = v1.clone(base)
        mutate(d)
        got = ill_formed(d)
        assert got == ((code, where) if code is not None else None), (vid, got, code)
        extra = {}
        if code is not None:
            extra["illFormed"] = code
            if where:
                extra["illFormedAt"] = {k: str(x) for k, x in where.items()}
        valid_vector(vid, description, d, extra)
    assert {v["illFormed"] for v in out_vectors if "illFormed" in v} == set(RULES)

    for vid, description, enc, code in decode_cases(base):
        try:
            decode(enc)
        except DecodeError as e:
            assert str(e) == code, (vid, str(e), code)
        else:
            raise AssertionError(f"{vid} decoded")
        out_vectors.append({"id": vid, "description": description, "type": {"kind": "ref", "name": "deployment_v2"}, "encoding": h(enc), "error": code})

    successions = []
    for vid, description, earlier, later, code in across_cases(base):
        got = across(earlier, later)
        assert (got[0] if got else None) == code, (vid, got, code)
        s = {"id": vid, "description": description, "earlier": h(encode(earlier)), "later": h(encode(later))}
        if code is not None:
            s["across"] = code
            s["acrossAt"] = {"period": str(got[1]["period"])}
        successions.append(s)
    assert {s["across"] for s in successions if "across" in s} == set(ACROSS_RULES)
    assert len({v["id"] for v in out_vectors}) == len(out_vectors)
    assert len({s["id"] for s in successions}) == len(successions)

    largest = max(len(bytes.fromhex(v["encoding"])) for v in out_vectors if "value" in v)
    assert largest == MAX_ENCODING, largest
    out = {
        "format": "abolish-deployment-record-vectors/2",
        "title": "Deployment record version 2: the Tier 0 token keys, their well-formedness and the rules across releases",
        "spec": "docs/spec/deployment.md",
        "generator": (
            "packages/crypto/scripts/deployment-record-v2-vectors.py: an independent Python implementation (standard library only) "
            "of version 2 of the record, its decoder and its rules, reusing deployment-record-vectors.py's version 1, "
            "group-vectors.py's ristretto255 decoding and tier0-token-vectors.py's key identifier"
        ),
        "tag": v1.TAG.decode(),
        "tokenKeyPeriod": str(TOKEN_KEY_PERIOD),
        "largestEncoding": largest,
        "rules": RULES,
        "acrossRules": ACROSS_RULES,
        "types": types(),
        "vectors": out_vectors,
        "successions": successions,
    }
    (vectors_dir / "deployment-record-v2.json").write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main()
