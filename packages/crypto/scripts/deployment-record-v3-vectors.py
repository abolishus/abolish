#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/deployment-record-v3.json.

A third implementation step of docs/spec/deployment.md: version 3, which is
version 2's record with the relays that reach each seat's node appended
(`seat_relays`, for the sealed delivery of docs/spec/sealed-delivery.md), its
strict decoding of every version, the well-formedness rules of version 3 in
their order, and the rule against its release that version 3 extends (P2-8
part 3c-1b-2b-2b-2d-2b-2e-2b). Standard library only; it shares no code with
packages/crypto. It reuses deployment-record-v2-vectors.py's version 2 (and
through it version 1's fields, rules, release pairs and sites), and leaves
deployment-record.json and deployment-record-v2.json, which freeze versions 1
and 2, as they are.

Usage: python3 -I packages/crypto/scripts/deployment-record-v3-vectors.py <vectors-dir>
(reads site-directory.json from it and writes deployment-record-v3.json beside it)
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


v2 = _load("deployment_record_v2_vectors", "deployment-record-v2-vectors.py")
v1, rr = v2.v1, v2.rr
h, u8, u32, var, lst = rr.h, rr.u8, rr.u32, rr.var, rr.lst
DecodeError, Reader = rr.DecodeError, rr.Reader

VERSION = 3
# Every seat of every panel at its maximum, each with a key of its own.
MAX_SEAT_RELAYS = v1.MAX_PANELS * v1.MAX_SEATS
MAX_RELAYS = 4
MAX_RELAY_PATH = 128
# The largest version-3 encoding: version 2's largest and 128 seats of four
# relays, each at a 267-byte origin with a 128-byte path.
MAX_ENCODING = v2.MAX_ENCODING + 4 + MAX_SEAT_RELAYS * (33 + 4 + MAX_RELAYS * (4 + v1.MAX_ORIGIN + 4 + MAX_RELAY_PATH))

RELAY_RULES = [
    "seat-relays-empty",
    "relay-seat",
    "relays-empty",
    "relay-origin",
    "relay-path",
    "relay-order",
    "seat-relay-order",
    "relay-endpoint",
    "relay-rp",
]
RULES = v2.RULES + RELAY_RULES


# --- Encoding ----------------------------------------------------------------


def enc_relay(x):
    return var(x["origin"]) + var(x["path"])


def enc_seat_relay(s):
    return s["key"] + lst(s["relays"], enc_relay)


def encode(d, version=VERSION):
    if version != VERSION:
        return v2.encode(d, version)
    fields = v1.encode_fields(d) + lst(d["tier0_token_keys"], v2.enc_token_key)
    return rr.u16(v1.RECORD_TYPE) + u8(VERSION) + fields + lst(d["seat_relays"], enc_seat_relay)


def decode(b):
    """Any version, as a reader of all three decodes it."""
    r = Reader(b)
    if r.int(2) != v1.RECORD_TYPE:
        raise DecodeError("unknown-record-type")
    version = r.int(1)
    if version not in (1, 2, VERSION):
        raise DecodeError("unknown-version")
    d = v1.decode_fields(r)
    if version >= 2:
        d["tier0_token_keys"] = r.lst(
            v2.MAX_TOKEN_KEYS, lambda r: {"period": r.int(4), "key": r.take(32), "retired": r.enum({0, 1}) == 1}
        )
    if version == VERSION:
        d["seat_relays"] = r.lst(
            MAX_SEAT_RELAYS,
            lambda r: {
                "key": r.take(33),
                "relays": r.lst(MAX_RELAYS, lambda r: {"origin": r.var(v1.MAX_ORIGIN), "path": r.var(MAX_RELAY_PATH)}),
            },
        )
    if r.at != len(b):
        raise DecodeError("trailing-bytes")
    return version, d


# --- Well-formedness, from docs/spec/deployment.md ---------------------------


def path_ok(p):
    """Empty (the origin's root), or a path by release.md's grammar."""
    return p == b"" or rr.path_ok(p)


def ill_formed(d):
    """The first rule a version-3 record breaks, in the spec's order, with where, or None."""
    got = v2.ill_formed(d)
    if got is not None:
        return got
    entries = d["seat_relays"]
    if not entries:
        return "seat-relays-empty", {}
    seats = {s["key"] for p in d["panels"] for s in p["seats"]}
    for i, e in enumerate(entries):
        at = {"seat_relay": i}
        if e["key"] not in seats:
            return "relay-seat", at
        if not e["relays"]:
            return "relays-empty", at
        for x in e["relays"]:
            if not rr.origin_ok(x["origin"]):
                return "relay-origin", at
            if not path_ok(x["path"]):
                return "relay-path", at
        if not rr.ascending([x["origin"] for x in e["relays"]]):
            return "relay-order", at
    if not rr.ascending([e["key"] for e in entries]):
        return "seat-relay-order", {}
    relays = [x["origin"] for e in entries for x in e["relays"]]
    endpoints = {o for name in v1.ORIGIN_LISTS for o in d[name]}
    if any(o in endpoints for o in relays):
        return "relay-endpoint", {}
    if any(v1.under(v1.host_of(o), d["backup_rp_id"]) for o in relays):
        return "relay-rp", {}
    return None


def inconsistent(release, d):
    """The first rule of Against its release the pair breaks, or None; both records well formed.

    Against its release reads only version 1's fields but for two rules:
    `deployment-hash` hashes the version-3 encoding, and `endpoint-site`
    counts the relays' origins as endpoints too. Version 1's checker judges
    the rest over the same record's fields, given a release naming its
    version-1 hash.
    """
    assert rr.ill_formed(release) is None and ill_formed(d) is None
    if release["deployment_hash"] != v1.deployment_hash(encode(d)):
        return "deployment-hash"
    as_v1 = dict(release, deployment_hash=v1.deployment_hash(v1.encode(d)))
    got = v1.inconsistent(as_v1, d)
    order = v1.PAIR_RULES
    sites = {o for site in release["sites"] for o in site["origins"]}
    relays = {x["origin"] for e in d["seat_relays"] for x in e["relays"]}
    if relays & sites and (got is None or order.index(got) > order.index("endpoint-site")):
        return "endpoint-site"
    return got


# --- Vectors -----------------------------------------------------------------


def relay(origin, path=b""):
    return {"origin": origin, "path": path}


def with_relays(d, entries):
    out = v1.clone(d)
    out["seat_relays"] = entries
    return out


def seat_keys(d):
    """Every seat's key, each once, in ascending byte order."""
    return sorted({s["key"] for p in d["panels"] for s in p["seats"]})


RELAYS = [b"https://ohttp.example-relay.net", b"https://relay.example.org"]


def typical(base):
    # Every seat of the transitional panel, each at a resource of its own on
    # two relays: one at a path, one at its own host's root.
    return with_relays(
        base,
        [
            {"key": k, "relays": [relay(RELAYS[0], f"abolish/seat-{i}".encode()), relay(f"https://s{i}.relay.example.org".encode())]}
            for i, k in enumerate(seat_keys(base))
        ],
    )


def value_json(d):
    out = v2.value_json({k: v for k, v in d.items() if k != "seat_relays"})
    if "seat_relays" in d:
        out["seat_relays"] = [{"key": h(e["key"]), "relays": [{"origin": h(x["origin"]), "path": h(x["path"])} for x in e["relays"]]} for e in d["seat_relays"]]
    return out


def types():
    t = v2.types()
    t["relay"] = {
        "kind": "struct",
        "fields": [
            {"name": "origin", "type": {"kind": "bytes", "max": v1.MAX_ORIGIN}},
            {"name": "path", "type": {"kind": "bytes", "max": MAX_RELAY_PATH}},
        ],
    }
    t["seat_relay"] = {
        "kind": "struct",
        "fields": [
            {"name": "key", "type": {"kind": "bytes", "length": 33}},
            {"name": "relays", "type": {"kind": "list", "max": MAX_RELAYS, "of": {"kind": "ref", "name": "relay"}}},
        ],
    }
    t["deployment_v3"] = {
        "kind": "record",
        "recordType": f"{v1.RECORD_TYPE:04x}",
        "version": VERSION,
        "fields": t["deployment_v2"]["fields"]
        + [{"name": "seat_relays", "type": {"kind": "list", "max": MAX_SEAT_RELAYS, "of": {"kind": "ref", "name": "seat_relay"}}}],
    }
    return t


def boundaries(v2_bounds):
    # Version 2's largest, with every one of its 128 seats at four relays, each
    # origin 267 bytes (letters no other list of the record uses) and each path
    # 128 bytes, unique to its seat.
    def origin(c):
        return f"https://{'.'.join([c * 63, c * 63, c * 63, 'z' + c * 60])}:65535".encode()

    keys = seat_keys(v2_bounds)
    assert len(keys) == MAX_SEAT_RELAYS
    origins = sorted(origin(c) for c in "qrst")
    return with_relays(
        v2_bounds,
        [{"key": k, "relays": [relay(o, f"{i:03d}/".encode() + b"x" * (MAX_RELAY_PATH - 4)) for o in origins]} for i, k in enumerate(keys)],
    )


def ill_formed_cases(base):
    entries = lambda f: lambda d: d.__setitem__("seat_relays", f(d["seat_relays"]))  # noqa: E731

    def relays_of(i, f):
        return lambda d: d["seat_relays"][i].__setitem__("relays", f(d["seat_relays"][i]["relays"]))

    def path_at(i, j, p):
        return lambda d: d["seat_relays"][i]["relays"][j].__setitem__("path", p)

    def origin_at(i, j, o):
        return lambda d: d["seat_relays"][i]["relays"][j].__setitem__("origin", o)

    S = lambda i: {"seat_relay": i}  # noqa: E731
    stranger = v1.key("no seat of this deployment")

    def negated(i):
        def mutate(d):
            k = d["seat_relays"][i]["key"]
            d["seat_relays"][i]["key"] = bytes([5 - k[0]]) + k[1:]

        return mutate
    return [
        ("seat-relays-empty", "No seat has a relay", entries(lambda es: []), "seat-relays-empty", {}),
        ("relay-seat", "Relays for a key no panel's seat has", lambda d: d["seat_relays"][3].__setitem__("key", stranger), "relay-seat", S(3)),
        ("relay-seat-negated", "Relays for a seat's key with the other compressed prefix, the negated point", negated(2), "relay-seat", S(2)),
        ("relays-empty", "A seat listed with no relay", relays_of(1, lambda xs: []), "relays-empty", S(1)),
        ("relay-origin-http", "An http relay", origin_at(0, 0, b"http://ohttp.example-relay.net"), "relay-origin", S(0)),
        ("relay-origin-path", "A relay origin with its path written into it", origin_at(4, 0, b"https://ohttp.example-relay.net/abolish/seat-4"), "relay-origin", S(4)),
        ("relay-origin-upper", "An upper-case relay host", origin_at(2, 1, b"https://S2.relay.example.org"), "relay-origin", S(2)),
        ("relay-origin-default-port", "A relay origin naming port 443", origin_at(5, 0, b"https://ohttp.example-relay.net:443"), "relay-origin", S(5)),
        ("relay-origin-ipv4", "A relay at an IPv4 address", origin_at(6, 1, b"https://192.0.2.7"), "relay-origin", S(6)),
        ("relay-path-slash", "A relay path with a leading slash", path_at(0, 0, b"/abolish/seat-0"), "relay-path", S(0)),
        ("relay-path-trailing-slash", "A relay path ending in a slash (an empty segment)", path_at(1, 0, b"abolish/"), "relay-path", S(1)),
        ("relay-path-dot-dot", "A relay path with a .. segment", path_at(3, 0, b"abolish/../seat-3"), "relay-path", S(3)),
        ("relay-path-query", "A relay path with a query", path_at(2, 0, b"abolish?seat=2"), "relay-path", S(2)),
        ("relay-path-percent", "A relay path with a percent-encoded byte", path_at(5, 0, b"abolish%2Fseat-5"), "relay-path", S(5)),
        ("relay-path-segments", "A relay path of seventeen segments", path_at(6, 0, b"/".join([b"a"] * 17)), "relay-path", S(6)),
        ("relay-path-dot", "A relay path with a . segment", path_at(4, 0, b"abolish/./seat-4"), "relay-path", S(4)),
        ("relays-unsorted", "A seat's relays out of order", relays_of(0, lambda xs: list(reversed(xs))), "relay-order", S(0)),
        ("relays-repeated", "One relay listed twice for a seat", relays_of(3, lambda xs: [xs[0], xs[0]]), "relay-order", S(3)),
        ("relays-same-origin", "Two resources of one relay origin for a seat", relays_of(3, lambda xs: [xs[0], relay(xs[0]["origin"], b"abolish/other")]), "relay-order", S(3)),
        ("seat-relays-unsorted", "Seats out of key order", entries(lambda es: [es[1], es[0]] + es[2:]), "seat-relay-order", {}),
        ("seat-relays-repeated", "One seat listed twice", entries(lambda es: es[:2] + [v1.clone(es[1])] + es[2:]), "seat-relay-order", {}),
        ("relay-is-api", "A relay at the API's origin", origin_at(0, 0, b"https://api.abolish.us"), "relay-endpoint", {}),
        ("relay-is-l1-rpc", "A relay at an L1 endpoint's origin", origin_at(6, 0, b"https://ethereum-sepolia-rpc.publicnode.com"), "relay-endpoint", {}),
        ("relay-at-rp-id", "A relay at the backup RP ID's host", origin_at(1, 0, b"https://ballot-staging.up.railway.app"), "relay-rp", {}),
        ("relay-under-rp-id", "A relay under the backup RP ID, with a port", origin_at(6, 1, b"https://relay.ballot-staging.up.railway.app:8443"), "relay-rp", {}),
        ("relay-under-account", "A relay under the accounts' RP ID: allowed", origin_at(0, 1, b"https://s0.relay.abolish.us"), None, {}),
        ("relay-shared", "One relay resource for two seats: allowed, one node may hold both", lambda d: d["seat_relays"][1]["relays"].__setitem__(0, v1.clone(d["seat_relays"][0]["relays"][0])), None, {}),
        ("relay-one-seat", "One seat with one relay, the others with none: allowed", entries(lambda es: [dict(es[2], relays=es[2]["relays"][:1])]), None, {}),
        ("relay-path-root", "Every relay at its origin's root: allowed", lambda d: [x.__setitem__("path", b"") for e in d["seat_relays"] for x in e["relays"]], None, {}),
        ("relay-path-deep", "A relay path of sixteen segments and 128 bytes, at its bound", path_at(0, 0, b"/".join([b"a"] * 15) + b"/" + b"b" * (MAX_RELAY_PATH - 30)), None, {}),
        (
            "rule-order-relays",
            "No token key and no relay: version 2's rules come first",
            lambda d: (d.__setitem__("tier0_token_keys", []), d.__setitem__("seat_relays", [])),
            "token-keys-empty",
            {},
        ),
        (
            "rule-order-entries",
            "An http relay in the second entry and a stranger's key in the third: entry by entry, the second's comes first",
            lambda d: (origin_at(1, 0, b"http://x.example")(d), d["seat_relays"][2].__setitem__("key", stranger)),
            "relay-origin",
            S(1),
        ),
        (
            "rule-order-relay",
            "A relay with a bad path, then one with a bad origin: relay by relay, the path comes first",
            lambda d: (path_at(0, 0, b"/x")(d), origin_at(0, 1, b"http://x.example")(d)),
            "relay-path",
            S(0),
        ),
        (
            "rule-order-entry-order",
            "Seats out of order, and a seat with its relays out of order: relay-order comes first",
            lambda d: (relays_of(4, lambda xs: list(reversed(xs)))(d), d.__setitem__("seat_relays", [d["seat_relays"][1], d["seat_relays"][0]] + d["seat_relays"][2:])),
            "relay-order",
            S(4),
        ),
        (
            "rule-order-endpoint",
            "A relay under the backup RP ID and another at the API: relay-endpoint comes first",
            lambda d: (origin_at(0, 1, b"https://relay.ballot-staging.up.railway.app")(d), origin_at(5, 0, b"https://api.abolish.us")(d)),
            "relay-endpoint",
            {},
        ),
    ]


def decode_cases(d):
    enc = encode(d)
    entries_at = len(v2.encode(d))
    first = entries_at + 4
    relays0 = first + 33
    origin0 = relays0 + 4
    path0 = origin0 + 4 + len(d["seat_relays"][0]["relays"][0]["origin"])

    def at(i, b):
        return enc[:i] + b + enc[i + len(b) :]

    as_v2 = v2.encode(d)
    return [
        ("truncated-seat-relays", "Cut inside the seat relays' count", enc[: entries_at + 2], "truncated"),
        ("truncated-seat-key", "Cut inside the first seat's key", enc[: first + 20], "truncated"),
        ("truncated-relay-origin", "Cut inside the first relay's origin", enc[: origin0 + 4 + 10], "truncated"),
        ("truncated-last-byte", "The last byte missing", enc[:-1], "truncated"),
        ("trailing-byte", "A byte after the last field", enc + b"\x00", "trailing-bytes"),
        ("seat-relays-over-max", "129 seat relays", at(entries_at, u32(MAX_SEAT_RELAYS + 1)), "length-over-max"),
        ("relays-over-max", "Five relays for one seat", at(relays0, u32(MAX_RELAYS + 1)), "length-over-max"),
        ("relay-origin-over-max", "A relay origin of 268 bytes", at(origin0, u32(v1.MAX_ORIGIN + 1)), "length-over-max"),
        ("relay-path-over-max", "A relay path of 129 bytes", at(path0, u32(MAX_RELAY_PATH + 1)), "length-over-max"),
        ("relay-origin-past-end", "A relay origin longer than the input", enc[:origin0] + u32(267) + b"https://", "truncated"),
        ("version-four", "Version 3's layout labelled version 4, which has no layout", at(2, b"\x04"), "unknown-version"),
        ("version-zero", "Version 0", at(2, b"\x00"), "unknown-version"),
        ("v3-labelled-two", "Version 3's layout labelled version 2: its seat relays are trailing bytes", at(2, b"\x02"), "trailing-bytes"),
        ("v2-labelled-three", "Version 2's layout labelled version 3: no seat relays", as_v2[:2] + b"\x03" + as_v2[3:], "truncated"),
        ("release-type", "The release record's type", at(0, b"\x00\x1f"), "unknown-record-type"),
    ]


def pair_cases(site_vectors, d):
    """Pairs of a release and a version-3 record, for the rules version 3 changes."""

    def ballot(origins=("https://abolishus.eth.limo", "https://ballot-staging.up.railway.app")):
        return rr.site_from(site_vectors, "ballot-like", 1, origins, True, rr.BALLOT_HEADERS)

    def challenge(origin="https://challenge-staging.up.railway.app"):
        return rr.site_from(site_vectors, "challenge-like", 2, (origin,), False, rr.CHALLENGE_HEADERS)

    def release(dep, sites, label, hash_of=None):
        r = rr.strip(rr.base(sites, 0, bytes(32), label))
        r["deployment_hash"] = v1.deployment_hash(hash_of or encode(dep))
        return r

    def relay_at(origin):
        out = v1.clone(d)
        out["seat_relays"][0]["relays"][1]["origin"] = origin
        out["seat_relays"][0]["relays"].sort(key=lambda x: x["origin"])
        return out

    at_ballot = relay_at(b"https://abolishus.eth.limo")
    at_challenge = relay_at(b"https://challenge-staging.up.railway.app")
    return [
        ("consistent", "A release and the version-3 deployment it names", release(d, [ballot(), challenge()], "pair-v3"), d, None),
        ("deployment-hash-v2", "A release naming the version-2 hash of the same deployment's other fields", release(d, [ballot(), challenge()], "pair-v3-as-v2", v2.encode(d)), d, "deployment-hash"),
        ("endpoint-site-relay", "A relay at the ballot client's entry point", release(at_ballot, [ballot(), challenge()], "pair-v3-relay"), at_ballot, "endpoint-site"),
        ("endpoint-site-relay-challenge", "A relay at the challenge origin", release(at_challenge, [ballot(), challenge()], "pair-v3-relay-challenge"), at_challenge, "endpoint-site"),
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
    v2_base = v2.typical(v1_base)
    base = typical(v2_base)
    bounds = boundaries(v2.boundaries(v1_base))
    valid = [
        ("typical", "Version 2's typical deployment with every seat of its transitional panel at two relays", base),
        ("boundaries", "Version 2's largest record with each of its 128 seats at four relays, every origin 267 bytes and every path 128", bounds),
    ]

    out_vectors = []

    def value_vector(vid, description, d, extra=None):
        enc = encode(d)
        assert decode(enc) == (VERSION, d), vid
        v = {"id": vid, "description": description, "type": {"kind": "ref", "name": "deployment_v3"}, "encoding": h(enc), "value": value_json(d)}
        v["deploymentHash"] = h(v1.deployment_hash(enc))
        v.update(extra or {})
        out_vectors.append(v)

    for vid, description, d in valid:
        assert ill_formed(d) is None, (vid, ill_formed(d))
        value_vector(vid, description, d)
    # Version 2's and version 1's typical records, which a reader of every
    # version still decodes, each under its own version.
    for vid, version, d, name in [("version-2", 2, v2_base, "deployment_v2"), ("version-1", 1, v1_base, "deployment")]:
        enc = encode(d, version)
        assert decode(enc) == (version, d)
        out_vectors.append(
            {
                "id": vid,
                "description": f"Version {version}'s typical deployment, which a reader of every version decodes as version {version}",
                "type": {"kind": "ref", "name": name},
                "encoding": h(enc),
                "value": v2.value_json(d),
                "deploymentHash": h(v1.deployment_hash(enc)),
            }
        )
    assert len(encode(bounds)) == MAX_ENCODING

    # Version 2's ill-formed records (version 1's among them), each with the
    # typical seat relays, then the seat relays' own: a version-3 record
    # breaks the earlier versions' rules first.
    earlier = [(f"v1-{c[0]}", *c[1:]) for c in v1.ill_formed_cases(v1_base)] + v2.ill_formed_cases(v2_base)
    cases = [(f"v2-{vid}", description, mutate, code, where) for vid, description, mutate, code, where in earlier if code is not None]
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
        value_vector(vid, description, d, extra)
    assert {v["illFormed"] for v in out_vectors if "illFormed" in v} == set(RULES)

    for vid, description, enc, code in decode_cases(base):
        try:
            decode(enc)
        except DecodeError as e:
            assert str(e) == code, (vid, str(e), code)
        else:
            raise AssertionError(f"{vid} decoded")
        out_vectors.append({"id": vid, "description": description, "type": {"kind": "ref", "name": "deployment_v3"}, "encoding": h(enc), "error": code})

    pairs = []
    for vid, description, release, d, code in pair_cases(site_vectors, base):
        got = inconsistent(release, d)
        assert got == code, (vid, got, code)
        p = {"id": vid, "description": description, "release": h(rr.encode(release)), "deployment": h(encode(d))}
        if code is not None:
            p["inconsistent"] = code
        pairs.append(p)
    assert len({v["id"] for v in out_vectors}) == len(out_vectors)
    assert len({p["id"] for p in pairs}) == len(pairs)

    largest = max(len(bytes.fromhex(v["encoding"])) for v in out_vectors if "value" in v)
    assert largest == MAX_ENCODING, largest
    out = {
        "format": "abolish-deployment-record-vectors/3",
        "title": "Deployment record version 3: the relays that reach each seat's node, their well-formedness and the rule against its release they extend",
        "spec": "docs/spec/deployment.md",
        "generator": (
            "packages/crypto/scripts/deployment-record-v3-vectors.py: an independent Python implementation (standard library only) "
            "of version 3 of the record, its decoder and its rules, reusing deployment-record-v2-vectors.py's version 2 and, "
            "through it, deployment-record-vectors.py's version 1, release pairs and sites"
        ),
        "tag": v1.TAG.decode(),
        "largestEncoding": largest,
        "rules": RULES,
        "pairRules": v1.PAIR_RULES,
        "types": types(),
        "vectors": out_vectors,
        "pairs": pairs,
    }
    (vectors_dir / "deployment-record-v3.json").write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main()
