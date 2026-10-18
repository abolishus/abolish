#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/release-registry.json.

A second implementation of docs/spec/contracts.md (Release registry) and of
docs/spec/verifier.md (Served client): the registry's ERC-7201 namespace and
slots, its calls' selectors, calldata framing and state rules, its events'
topics, and check 1.1 over a registry's proven words, a set of release
records and a host's responses. Standard library only; it shares no code
with packages/crypto, packages/verifier or packages/contracts.

It reuses only this folder's other independent generators:
contract-event-vectors.py's Keccak-256 (checked there against hashlib's
SHA-3 and the published empty-string digest) and release-record-vectors.py's
release record (encoding, strict decoder, well-formedness rules, release
hash, the object rule and the sites' directory DAG). Before writing anything
it rebuilds every site of site-directory.json, as that generator does.

Reading the registry's words from an L1 header and trie nodes is Anchors
from L1's walk (verifier.md), which l1-anchor.json covers; these vectors give
the words as proven, keyed by slot.

Usage: python3 -I -B packages/crypto/scripts/release-registry-vectors.py <vectors-dir>
(reads site-directory.json from it and writes release-registry.json beside
it), then `vp check --fix`.
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


ce = _load("contract_event_vectors", "contract-event-vectors.py")
rr = _load("release_record_vectors", "release-record-vectors.py")
keccak256 = ce.keccak256
sha256, h, obj = rr.sha256, rr.h, rr.obj

NAMESPACE = "abolish.release-registry"
MASK64 = (1 << 64) - 1


def word(v):
    return v.to_bytes(32, "big")


def erc7201(namespace):
    n = int.from_bytes(keccak256(namespace.encode()), "big") - 1
    return int.from_bytes(keccak256(word(n)), "big") & ~0xFF


A = erc7201(NAMESPACE)
COUNT_SLOT = A


def hash_slot(s):
    return int.from_bytes(keccak256(word(s) + word(A + 1)), "big")


def times_slot(s):
    return hash_slot(s) + 1


def selector(signature):
    return keccak256(signature.encode())[:4]


PUBLISH = "publish(bytes32,bytes32)"
REVOKE = "revoke(uint64)"
PUBLISHED = "ReleasePublished(uint64,bytes32,bytes32)"
REVOKED = "ReleaseRevoked(uint64,bytes32)"


def times_word(published_at, revoked_at=0):
    return word(published_at | revoked_at << 64)


# --- The registry's calls (contracts.md, Release registry) -----------------


class Registry:
    """The registry's state rules, as storage words; a refused call changes nothing."""

    def __init__(self):
        self.storage = {}

    def get(self, slot):
        return int.from_bytes(self.storage.get(slot, bytes(32)), "big")

    def put(self, slot, v):
        if v:
            self.storage[slot] = word(v)
        else:
            self.storage.pop(slot, None)

    def call(self, caller_is_authority, calldata, timestamp):
        """Returns (None, logs) or (rule, None): the first rule of the call the call breaks."""
        sel, args = calldata[:4], calldata[4:]
        if sel == selector(PUBLISH):
            if not caller_is_authority:
                return 1, None
            if len(args) != 64:
                return 2, None
            release_hash, previous = args[:32], args[32:]
            if release_hash == bytes(32):
                return 3, None
            c = self.get(COUNT_SLOT)
            latest = word(self.get(hash_slot(c - 1))) if c else bytes(32)
            if previous != latest:
                return 4, None
            self.put(hash_slot(c), int.from_bytes(release_hash, "big"))
            self.put(times_slot(c), timestamp)
            self.put(COUNT_SLOT, c + 1)
            topics = [keccak256(PUBLISHED.encode()), word(c), release_hash]
            return None, [{"topics": topics, "data": previous}]
        if sel == selector(REVOKE):
            if not caller_is_authority:
                return 1, None
            if len(args) != 32 or int.from_bytes(args, "big") >> 64:
                return 2, None
            s = int.from_bytes(args, "big")
            if s >= self.get(COUNT_SLOT):
                return 3, None
            t = self.get(times_slot(s))
            if t >> 64:
                return 4, None
            self.put(times_slot(s), t | timestamp << 64)
            topics = [keccak256(REVOKED.encode()), word(s), word(self.get(hash_slot(s)))]
            return None, [{"topics": topics, "data": b""}]
        return 0, None


def publish_data(release_hash, previous):
    return selector(PUBLISH) + release_hash + previous


def revoke_data(s):
    return selector(REVOKE) + word(s)


# --- Check 1.1 (verifier.md, Served client) --------------------------------

LOOPBACK_HOSTS = ("http://127.0.0.1:", "http://[::1]:", "http://localhost:")


def is_loopback(origin):
    for p in LOOPBACK_HOSTS:
        if origin.startswith(p):
            port = origin[len(p) :]
            return port.isdigit() and port[0] != "0" and 1 <= int(port) <= 65535 and int(port) != 80
    return False


def combined(headers, name):
    """RFC 9110 §5.3: a field's lines, in order, joined by ", ", or None if absent."""
    lines = [v for n, v in headers if n.lower() == name]
    return ", ".join(lines) if lines else None


# Headers a host may add beside the site's own (verifier.md, Served client):
# dates, caching, validators, transfer framing and the hosts' trace headers.
# Any other unlisted header can change what the page does (`refresh`,
# `clear-site-data`, `link`, reporting), so it fails.
HOST_HEADERS = {
    "accept-ranges", "age", "alt-svc", "cache-control", "cf-cache-status", "cf-ray", "connection",
    "content-encoding", "content-length", "date", "etag", "expires", "keep-alive", "last-modified",
    "proxy-connection", "server", "strict-transport-security", "transfer-encoding", "upgrade", "vary",
    "via", "x-cache", "x-railway-edge", "x-railway-request-id", "x-served-by",
}
MAX_STALENESS = 3600


def judge(v, records, chain_id, registry, now):
    """Check 1.1's row for one vector: (status, code, at, release)."""
    words = {int(k, 16): bytes.fromhex(w) for k, w in v["storage"].items()}

    def read(slot):
        return int.from_bytes(words.get(slot, bytes(32)), "big")

    run_at = int(v["runAt"])
    if run_at < now or run_at - now > MAX_STALENESS:
        return "unverifiable", "l1-stale", {}, None
    c = read(COUNT_SLOT)
    if c >> 64:
        return "fail", "release-registry-state", {"slot": "count"}, None
    if c == 0:
        return "unverifiable", "release-none", {}, None
    s = int(v["sequence"]) if "sequence" in v else c - 1
    if s >= c:
        return "unverifiable", "release-unpublished", {"sequence": str(s)}, None
    for q in [s, s - 1] if s else [s]:
        if read(hash_slot(q)) == 0:
            return "fail", "release-registry-state", {"sequence": str(q)}, None
    t = read(times_slot(s))
    published_at, revoked_at = t & MASK64, t >> 64 & MASK64
    if (
        t >> 128
        or published_at == 0
        or published_at > now
        or (revoked_at and (revoked_at < published_at or revoked_at > now))
    ):
        return "fail", "release-registry-state", {"sequence": str(s)}, None
    release_hash = word(read(hash_slot(s)))
    previous = word(read(hash_slot(s - 1))) if s else bytes(32)
    release = {
        "sequence": str(s),
        "hash": h(release_hash),
        "latest": str(c - 1),
        "behind": str(c - 1 - s),
        "publishedAt": str(published_at),
    }
    if revoked_at:
        release["revokedAt"] = str(revoked_at)
        return "fail", "release-revoked", {}, release
    enc = next((e for e in records if rr.release_hash(e) == release_hash), None)
    if enc is None:
        return "unverifiable", "release-record-missing", {}, release
    try:
        r = rr.decode(enc)
    except rr.DecodeError as e:
        return "fail", "release-record", {"decodeError": e.args[0]}, release
    bad = rr.ill_formed(r)
    if bad:
        rule, at = bad
        return "fail", "release-record", {"rule": rule, **{k: str(x) for k, x in at.items()}}, release
    if r["l1_chain_id"] != chain_id or r["registry"] != registry or r["sequence"] != s or r["previous"] != previous:
        return "fail", "release-chain", {}, release
    origin = v["origin"].encode()
    if is_loopback(v["origin"]):
        site = next((x for x in r["sites"] if x["kind"] == 1 and x["loopback"]), None)
    else:
        site = next((x for x in r["sites"] if origin in x["origins"]), None)
    if site is None:
        return "fail", "origin-unlisted", {}, release
    v["_site"] = str(site["kind"])
    responses = {x["path"]: x for x in v["responses"]}
    by_path = {f["path"]: f for f in site["files"]}
    requests = [("/", by_path[b"index.html"])] + [("/" + f["path"].decode(), f) for f in site["files"]]
    first_unverifiable = None
    bodies = {}
    for path, f in requests:
        x = responses.get(path)
        outcome = served(x, f, site)
        if outcome is None:
            bodies[f["path"]] = body_of(x)
            continue
        status, code, extra = outcome
        if status == "fail":
            return "fail", code, {"path": path, **extra}, release
        first_unverifiable = first_unverifiable or (code, {"path": path, **extra})
    if first_unverifiable:
        return "unverifiable", first_unverifiable[0], first_unverifiable[1], release
    blocks = {}
    root, _ = rr.directory_dag(rr.tree(sorted(bodies.items())), blocks)
    if root != site["directory"]:
        return "fail", "release-directory", {}, release
    return "pass", None, None, release


def body_of(x):
    b = x["body"]
    return bytes.fromhex(b["hex"]) if "hex" in b else obj(b["label"], b["length"])


def served(x, f, site):
    """One response against one file: None if it matches, or (status, code, at)."""
    if x is None or x["status"] in (408, 429) or x["status"] >= 500:
        return "unverifiable", "fetch-failed", {}
    if x["status"] != 200:
        return "fail", "served-status", {"httpStatus": x["status"]}
    headers = [(n, val) for n, val in x["headers"]]
    encoding = combined(headers, "content-encoding")
    if encoding is not None and encoding.lower() != "identity":
        return "unverifiable", "served-encoding", {}
    if body_of(x) != obj_of(f):
        return "fail", "file-mismatch", {}
    if combined(headers, "content-type") != f["media_type"].decode():
        return "fail", "media-type-mismatch", {}
    for hd in site["headers"]:
        got = combined(headers, hd["name"].decode())
        if got is None:
            return "fail", "header-missing", {"header": hd["name"].decode()}
        if got != hd["value"].decode():
            return "fail", "header-mismatch", {"header": hd["name"].decode()}
    listed = {hd["name"].decode() for hd in site["headers"]} | {"content-type"}
    for n, _ in headers:
        if n.lower() not in listed and n.lower() not in HOST_HEADERS:
            return "fail", "header-unlisted", {"header": n.lower()}
    return None


FILE_BYTES = {}


def obj_of(f):
    return FILE_BYTES[f["sha256"]]


# --- Vectors ----------------------------------------------------------------

T0 = 1800000000
NOW = 1800100000


def main():
    vectors_dir = pathlib.Path(sys.argv[1])
    site_vectors = json.loads((vectors_dir / "site-directory.json").read_text())["vectors"]
    rr.check_sites(site_vectors)
    for sv in site_vectors:
        for f in sv["files"]:
            data = obj(f["label"], f["length"])
            FILE_BYTES[sha256(data)] = data
    labels = {sv["id"]: {f["path"]: f["label"] for f in sv["files"]} for sv in site_vectors}

    def ballot(sid="ballot-like", origins=("https://abolishus.eth.limo", "https://ballot-staging.up.railway.app"), loopback=True):
        return rr.site_from(site_vectors, sid, 1, origins, loopback, rr.BALLOT_HEADERS)

    def challenge():
        return rr.site_from(site_vectors, "challenge-like", 2, ("https://challenge-staging.up.railway.app",), False, rr.CHALLENGE_HEADERS)

    def enc(r):
        return rr.encode(rr.strip(r))

    only_csp = [("content-security-policy", "default-src 'none'; frame-ancestors 'none'")]
    first = rr.base([rr.site_from(site_vectors, "index-only", 1, ("https://ballot-staging.up.railway.app",), False, only_csp)])
    e0 = enc(first)
    h0 = rr.release_hash(e0)
    second = rr.base([ballot(), challenge()], 1, h0, "typical")
    e1 = enc(second)
    h1 = rr.release_hash(e1)
    third = rr.base([ballot(), challenge()], 2, h1, "third")
    e2 = enc(third)
    h2 = rr.release_hash(e2)
    assert e0 == bytes.fromhex(next(x for x in release_vectors(vectors_dir) if x["id"] == "first")["encoding"])
    assert e1 == bytes.fromhex(next(x for x in release_vectors(vectors_dir) if x["id"] == "typical")["encoding"])

    # The registry's own history: three releases, as the generator's rules write them.
    reg = Registry()
    history = []

    def step(desc, data, ts, authority=True):
        rule, logs = reg.call(authority, data, ts)
        entry = {"description": desc, "caller": "authority" if authority else "other", "calldata": h(data), "timestamp": str(ts)}
        if rule is None:
            entry["logs"] = [{"topics": [h(t) for t in lg["topics"]], "data": h(lg["data"])} for lg in logs]
        else:
            entry["refused"] = rule
        history.append(entry)
        return rule

    other = sha256(b"another release")
    assert step("publish from an account that isn't the authority", publish_data(h0, bytes(32)), T0, False) == 1
    assert step("publish with a byte after the arguments", publish_data(h0, bytes(32)) + b"\x00", T0) == 2
    assert step("publish with the second argument cut short", publish_data(h0, bytes(32))[:-1], T0) == 2
    assert step("publish a zero release hash", publish_data(bytes(32), bytes(32)), T0) == 3
    assert step("the first release with a non-zero previous", publish_data(h0, other), T0) == 4
    assert step("the first release", publish_data(h0, bytes(32)), T0) is None
    assert step("a second release whose previous isn't the latest", publish_data(h1, bytes(32)), T0 + 3600) == 4
    assert step("the second release", publish_data(h1, h0), T0 + 3600) is None
    assert step("a release built against a stale head (previous is release 0)", publish_data(other, h0), T0 + 3700) == 4
    assert step("the third release", publish_data(h2, h1), T0 + 7200) is None
    assert step("revoke from an account that isn't the authority", revoke_data(1), T0 + 7300, False) == 1
    assert step("revoke with a sequence word above 64 bits", revoke_data(1 | 1 << 64), T0 + 7300) == 2
    assert step("revoke with a byte after the argument", revoke_data(1) + b"\x00", T0 + 7300) == 2
    assert step("revoke a sequence not yet published", revoke_data(3), T0 + 7300) == 3
    assert step("revoke the second release", revoke_data(1), T0 + 7300) is None
    assert step("revoke the second release again", revoke_data(1), T0 + 7400) == 4
    assert step("empty calldata", b"", T0 + 7400) == 0
    assert step("an unknown selector", selector("owner()"), T0 + 7400) == 0
    history_storage = {h(word(k)): h(w) for k, w in sorted(reg.storage.items())}

    honest = {
        h(word(COUNT_SLOT)): h(word(3)),
        h(word(hash_slot(0))): h(h0),
        h(word(times_slot(0))): h(times_word(T0)),
        h(word(hash_slot(1))): h(h1),
        h(word(times_slot(1))): h(times_word(T0 + 3600)),
        h(word(hash_slot(2))): h(h2),
        h(word(times_slot(2))): h(times_word(T0 + 7200)),
    }
    revoked = dict(history_storage)
    assert {k: x for k, x in revoked.items() if k != h(word(times_slot(1)))} == {
        k: x for k, x in honest.items() if k != h(word(times_slot(1)))
    }

    def site_of(r, kind):
        return next(s for s in r["sites"] if s["kind"] == kind)

    def responses(r, kind, change=None, extra=()):
        s = site_of(r, kind)
        sid = s["_site"]
        out = []
        for path, f in [("/", next(f for f in s["files"] if f["path"] == b"index.html"))] + [
            ("/" + f["path"].decode(), f) for f in s["files"]
        ]:
            hs = [(n.decode(), val.decode()) for n, val in ((x["name"], x["value"]) for x in s["headers"])]
            hs.append(("content-type", f["media_type"].decode()))
            hs.extend(extra)
            x = {
                "path": path,
                "status": 200,
                "headers": hs,
                "body": {"label": labels[sid][f["path"].decode()], "length": f["length"]},
            }
            if change:
                x = change(path, x)
            if x is not None:
                out.append(x)
        return out

    def with_case():
        def change(path, x):
            hs = [(n.title() if n != "content-type" else "Content-Type", val) for n, val in x["headers"]]
            return {**x, "headers": hs + [("Content-Encoding", "IDENTITY")]}

        return change

    def at(target, fn):
        return lambda path, x: fn(x) if path == target else x

    def with_headers(fn):
        return lambda x: {**x, "headers": fn(x["headers"])}

    ballot_files = [f["path"].decode() for f in site_of(third, 1)["files"]]
    second_file = "/" + ballot_files[1]
    csp = rr.BALLOT_HEADERS[0][1]

    # A published record whose directory isn't its files' (well formed, its CID another site's).
    wrong_dir = rr.base([ballot(), challenge()], 2, h1, "third")
    other_site = next(sv for sv in site_vectors if sv["id"] == "index-only")
    wrong_dir["sites"][0] = {**wrong_dir["sites"][0], "directory": bytes.fromhex(other_site["cidHex"])}
    ew = enc(wrong_dir)
    hw = rr.release_hash(ew)

    # Published records that break the chain against the registry.
    misnumbered = rr.base([ballot(), challenge()], 1, h1, "misnumbered")
    em = enc(misnumbered)
    unchained = rr.base([ballot(), challenge()], 2, h0, "unchained")
    eu = enc(unchained)
    elsewhere = {**rr.base([ballot(), challenge()], 2, h1, "elsewhere"), "registry": sha256(b"another registry")[:20]}
    ee = enc(elsewhere)
    ill = rr.base([ballot(origins=("https://ballot-staging.up.railway.app", "https://abolishus.eth.limo")), challenge()], 2, h1, "ill")
    ei = enc(ill)
    truncated = e2[:-1]

    def replace_latest(enc_, extra_storage=None):
        st = dict(honest)
        st[h(word(hash_slot(2)))] = h(rr.release_hash(enc_))
        st.update(extra_storage or {})
        return st

    ballot_origin = "https://ballot-staging.up.railway.app"
    all_records = [e0, e1, e2]
    vectors = [
        {"id": "latest", "description": "The latest release at its ballot origin, every file and header as listed", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1)},
        {"id": "named-older", "description": "The run names release 1 of 3: it passes and reports one release behind", "storage": honest, "records": all_records, "sequence": "1", "origin": ballot_origin, "responses": responses(second, 1)},
        {"id": "first-release", "description": "Release 0 named, a site of one file whose only header is its CSP", "storage": honest, "records": [e0], "sequence": "0", "origin": ballot_origin, "responses": responses(first, 1)},
        {"id": "challenge-page", "description": "The challenge page at its one origin", "storage": honest, "records": all_records, "origin": "https://challenge-staging.up.railway.app", "responses": responses(third, 2)},
        {"id": "loopback", "description": "The ballot client at a loopback origin of apps/node, its site's loopback true", "storage": honest, "records": all_records, "origin": "http://127.0.0.1:8080", "responses": responses(third, 1)},
        {"id": "loopback-ipv6", "description": "The same at the IPv6 loopback origin", "storage": honest, "records": all_records, "origin": "http://[::1]:5173", "responses": responses(third, 1)},
        {"id": "extra-headers", "description": "The host adds headers the site doesn't list: reported, never judged", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, extra=[("server", "railway-edge"), ("x-cache", "HIT"), ("content-encoding", "identity")])},
        {"id": "records-in-any-order", "description": "Records given in any order, with unpublished ones among them", "storage": honest, "records": [ew, e2, em, e0], "origin": ballot_origin, "responses": responses(third, 1)},
        {"id": "none", "description": "A registry with no release", "storage": {}, "records": all_records, "origin": ballot_origin, "responses": []},
        {"id": "unpublished", "description": "The run names a sequence the registry hasn't reached at B", "storage": honest, "records": all_records, "sequence": "3", "origin": ballot_origin, "responses": []},
        {"id": "record-missing", "description": "No given record has the published hash", "storage": honest, "records": [e0, e1], "origin": ballot_origin, "responses": responses(third, 1)},
        {"id": "count-high-bits", "description": "A count word with a bit above 64 set: no release code writes it", "storage": {**honest, h(word(COUNT_SLOT)): h(word(3 | 1 << 64))}, "records": all_records, "origin": ballot_origin, "responses": []},
        {"id": "hash-zero", "description": "A count of 3 with no hash at sequence 2", "storage": {k: x for k, x in honest.items() if k != h(word(hash_slot(2)))}, "records": all_records, "origin": ballot_origin, "responses": []},
        {"id": "previous-zero", "description": "A count of 3 with no hash at sequence 1, the latest's predecessor", "storage": {k: x for k, x in honest.items() if k != h(word(hash_slot(1)))}, "records": all_records, "origin": ballot_origin, "responses": []},
        {"id": "published-zero", "description": "A release with no publication time", "storage": {k: x for k, x in honest.items() if k != h(word(times_slot(2)))}, "records": all_records, "origin": ballot_origin, "responses": []},
        {"id": "published-after-b", "description": "A publication time after B's timestamp", "storage": {**honest, h(word(times_slot(2))): h(times_word(NOW + 1))}, "records": all_records, "origin": ballot_origin, "responses": []},
        {"id": "revoked-before-published", "description": "A revocation time before the publication time", "storage": {**honest, h(word(times_slot(2))): h(times_word(T0 + 7200, T0 + 7199))}, "records": all_records, "origin": ballot_origin, "responses": []},
        {"id": "times-high-bits", "description": "A times word with a bit above 128 set", "storage": {**honest, h(word(times_slot(2))): h(word(T0 + 7200 | 1 << 128))}, "records": all_records, "origin": ballot_origin, "responses": []},
        {"id": "revoked", "description": "Release 1 named after the registry revoked it (the history's final state)", "storage": revoked, "records": all_records, "sequence": "1", "origin": ballot_origin, "responses": responses(second, 1)},
        {"id": "revoked-latest-unaffected", "description": "The same registry: release 2, never revoked, still passes", "storage": revoked, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1)},
        {"id": "record-truncated", "description": "The published hash is of bytes that don't decode", "storage": replace_latest(truncated), "records": [truncated], "origin": ballot_origin, "responses": []},
        {"id": "record-ill-formed", "description": "The published record breaks a well-formedness rule (its origins out of order)", "storage": replace_latest(ei), "records": [ei], "origin": ballot_origin, "responses": []},
        {"id": "chain-sequence", "description": "The record at sequence 2 says sequence 1", "storage": replace_latest(em), "records": [em], "origin": ballot_origin, "responses": []},
        {"id": "chain-previous", "description": "The record at sequence 2 names release 0 as its previous", "storage": replace_latest(eu), "records": [eu], "origin": ballot_origin, "responses": []},
        {"id": "chain-registry", "description": "The record names another registry", "storage": replace_latest(ee), "records": [ee], "origin": ballot_origin, "responses": []},
        {"id": "origin-unlisted", "description": "An origin no site of the release lists", "storage": honest, "records": all_records, "origin": "https://ballot.example", "responses": responses(third, 1)},
        {"id": "origin-other-release", "description": "abolishus.eth.limo against release 0, which doesn't list it", "storage": honest, "records": all_records, "sequence": "0", "origin": "https://abolishus.eth.limo", "responses": responses(first, 1)},
        {"id": "loopback-not-allowed", "description": "A loopback origin against release 0, whose ballot site has loopback false", "storage": honest, "records": all_records, "sequence": "0", "origin": "http://localhost:8080", "responses": responses(first, 1)},
        {"id": "file-mismatch", "description": "One file's bytes differ", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at(second_file, lambda x: {**x, "body": {"label": "tampered", "length": x["body"]["length"]}}))},
        {"id": "file-longer", "description": "One file with a byte appended", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at(second_file, lambda x: {**x, "body": {"hex": h(obj(x["body"]["label"], x["body"]["length"]) + b"\x0a")}}))},
        {"id": "root-mismatch", "description": "`/` serves other bytes than index.html", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at("/", lambda x: {**x, "body": {"label": "another index", "length": 64}}))},
        {"id": "media-type-mismatch", "description": "A file served with another content-type", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at(second_file, with_headers(lambda hs: [(n, "text/plain" if n == "content-type" else val) for n, val in hs])))},
        {"id": "header-missing", "description": "A listed header not sent on one file", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at(second_file, with_headers(lambda hs: [(n, val) for n, val in hs if n != "referrer-policy"])))},
        {"id": "header-mismatch", "description": "The CSP sent with another value", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at("/", with_headers(lambda hs: [(n, csp.replace("frame-ancestors 'none'", "frame-ancestors *") if n == "content-security-policy" else val) for n, val in hs])))},
        {"id": "header-twice", "description": "A second CSP field line: the combined value isn't the listed one", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at("/", with_headers(lambda hs: hs + [("content-security-policy", "default-src *")])))},
        {"id": "served-status", "description": "A listed file answered 404", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at(second_file, lambda x: {**x, "status": 404}))},
        {"id": "served-redirect", "description": "A listed file answered with a redirect, never followed", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at("/", lambda x: {**x, "status": 302, "headers": x["headers"] + [("location", "https://ballot.example/")]}))},
        {"id": "fetch-unavailable", "description": "A listed file answered 503: unsettled, never failed", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at(second_file, lambda x: {**x, "status": 503}))},
        {"id": "fetch-no-response", "description": "No response for one file (a network failure)", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at(second_file, lambda x: None))},
        {"id": "fail-beats-unverifiable", "description": "One file unanswered and a later one tampered: the mismatch is final", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, lambda path, x: None if path == "/" else ({**x, "body": {"label": "tampered", "length": x["body"]["length"]}} if path == second_file else x))},
        {"id": "header-names-any-case", "description": "Header names in mixed case and a coding of IDENTITY: names and codings compare without case", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, with_case())},
        {"id": "header-unlisted-refresh", "description": "The host adds `refresh`, which navigates the page away: fails", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at("/", with_headers(lambda hs: hs + [("refresh", "0; url=https://ballot.example/")])))},
        {"id": "header-unlisted-clear-site-data", "description": "The host adds `clear-site-data`, which wipes the voter's stored identity: fails", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at(second_file, with_headers(lambda hs: hs + [("Clear-Site-Data", '"storage"')])))},
        {"id": "l1-stale", "description": "B more than an hour before the run: revocations since B could be missed", "runAt": str(NOW + 3601), "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1)},
        {"id": "l1-after-run", "description": "B after the run's own clock", "runAt": str(NOW - 1), "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1)},
        {"id": "l1-hour-old", "description": "B exactly an hour before the run: still fresh", "runAt": str(NOW + 3600), "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1)},
        {"id": "revoked-record-missing", "description": "A revoked release fails from L1 alone, with no record given", "storage": revoked, "records": [], "sequence": "1", "origin": ballot_origin, "responses": []},
        {"id": "served-encoding", "description": "A file sent gzip-coded although the run asked for identity", "storage": honest, "records": all_records, "origin": ballot_origin, "responses": responses(third, 1, at(second_file, with_headers(lambda hs: hs + [("content-encoding", "gzip")])))},
        {"id": "release-directory", "description": "Every file matches, but the published record's directory isn't the CID its files make", "storage": replace_latest(ew), "records": [ew], "origin": ballot_origin, "responses": responses(wrong_dir, 1)},
    ]

    out = []
    for v in vectors:
        v.setdefault("runAt", str(NOW + 600))
        status, code, where, release = judge(v, v["records"], rr.SEPOLIA, rr.REGISTRY, NOW)
        row = {
            "id": v["id"],
            "description": v["description"],
            "storage": v["storage"],
            "records": [h(e) for e in v["records"]],
        }
        if "sequence" in v:
            row["sequence"] = v["sequence"]
        row["runAt"] = v.get("runAt", str(NOW + 600))
        row["origin"] = v["origin"]
        row["responses"] = [
            {"path": x["path"], "status": x["status"], "headers": [[n, val] for n, val in x["headers"]], "body": x["body"]}
            for x in v["responses"]
        ]
        expect = {"status": status}
        if code:
            expect["code"] = code
            expect["at"] = where
        if release:
            expect["release"] = release
        if "_site" in v:
            expect["site"] = v["_site"]
        row["expect"] = expect
        out.append(row)

    statuses = {r["id"]: r["expect"]["status"] for r in out}
    for i in ("latest", "revoked-latest-unaffected", "header-names-any-case", "l1-hour-old", "extra-headers"):
        assert statuses[i] == "pass", i
    codes = {r["expect"].get("code") for r in out}
    for c in [
        "release-registry-state", "release-none", "release-unpublished", "release-record-missing", "release-record",
        "release-chain", "release-revoked", "origin-unlisted", "fetch-failed", "served-status", "served-encoding",
        "file-mismatch", "media-type-mismatch", "header-missing", "header-mismatch", "header-unlisted",
        "release-directory", "l1-stale",
    ]:
        assert c in codes, c

    doc = {
        "format": "abolish-release-registry-vectors/1",
        "title": "The L1 release registry: its slots, calls and events, and verifier check 1.1 over its proven words",
        "spec": "docs/spec/contracts.md, docs/spec/verifier.md",
        "generator": "packages/crypto/scripts/release-registry-vectors.py: standard library only; reuses contract-event-vectors.py's Keccak-256 and release-record-vectors.py's release record, and rebuilds every site of site-directory.json before writing",
        "namespace": {
            "id": NAMESPACE,
            "base": h(word(A)),
            "count": h(word(COUNT_SLOT)),
            "releases": h(word(A + 1)),
        },
        "selectors": {PUBLISH: h(selector(PUBLISH)), REVOKE: h(selector(REVOKE))},
        "topics": {PUBLISHED: h(keccak256(PUBLISHED.encode())), REVOKED: h(keccak256(REVOKED.encode()))},
        "slots": [{"sequence": str(s), "hash": h(word(hash_slot(s))), "times": h(word(times_slot(s)))} for s in (0, 1, 2, MASK64)],
        "history": {"steps": history, "storage": history_storage},
        "pins": {"l1ChainId": str(rr.SEPOLIA), "registry": h(rr.REGISTRY)},
        "now": str(NOW),
        "vectors": out,
    }
    (vectors_dir / "release-registry.json").write_text(json.dumps(doc, indent=2) + "\n")


def release_vectors(vectors_dir):
    return json.loads((vectors_dir / "release-record.json").read_text())["vectors"]


if __name__ == "__main__":
    main()
