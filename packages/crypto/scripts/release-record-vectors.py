#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/release-record.json.

A second implementation of docs/spec/release.md and of docs/spec/
content-addressing.md (Sites): the release record (record type 0x001f,
version 1), its strict decoding, its well-formedness rules in their order, the
release hash, and each site's directory DAG, CID and CAR. Standard library
only; it shares no code with packages/crypto or any IPFS implementation.

Before writing anything it rebuilds every site of docs/spec/vectors/
site-directory.json from the spec alone (protobuf, UnixFS, dag-pb, CIDv1 and
the CARv1 header written out here) and refuses any root block, CID, block
count or CAR that differs from what Kubo 0.36.0 and ipfs-unixfs-importer
17.1.1 both produced. Every release vector's sites are among those, so every
`directory` CID in the file was produced by three implementations.

Every file's bytes come from SHA-256 over its label (the object rule of
site-directory.json), and every other value is written out in the vector, so
any implementation can reproduce each encoding.

Usage: python3 -I packages/crypto/scripts/release-record-vectors.py <vectors-dir>
(reads site-directory.json from it and writes release-record.json beside it)
"""

import hashlib
import json
import pathlib
import re
import sys

RECORD_TYPE = 0x001F
VERSION = 1
TAG = b"abolish/v1/release"

MAX_SITES = 2
MAX_ORIGINS = 8
MAX_ORIGIN = 267
MAX_HEADERS = 16
MAX_HEADER_NAME = 64
MAX_HEADER_VALUE = 4096
MAX_FILES = 1024
MAX_PATH = 1024
MAX_MEDIA_TYPE = 127
MAX_SEGMENT = 128
MAX_SEGMENTS = 16
MAX_RELEASE_FILE = 1 << 28

CHUNK = 1 << 20
MAX_LINKS = 1024

RESERVED_HEADERS = {
    b"connection",
    b"content-encoding",
    b"content-length",
    b"content-range",
    b"content-type",
    b"keep-alive",
    b"proxy-connection",
    b"te",
    b"transfer-encoding",
    b"upgrade",
}
RESERVED_PATHS = {b"_headers", b"_redirects"}


def sha256(b):
    return hashlib.sha256(b).digest()


def h(b):
    return b.hex()


def ds(tag, m):
    return bytes([len(tag)]) + tag + m


def release_hash(encoding):
    return sha256(ds(TAG, encoding))


def obj(label, length):
    out = bytearray()
    i = 0
    while len(out) < length:
        out += sha256(label.encode() + i.to_bytes(4, "big"))
        i += 1
    return bytes(out[:length])


# --- Content addressing, from docs/spec/content-addressing.md -------------


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def pb_bytes(field, b):
    return varint(field << 3 | 2) + varint(len(b)) + b


def pb_varint(field, n):
    return varint(field << 3) + varint(n)


def cid(codec, block):
    return bytes([0x01, codec, 0x12, 0x20]) + sha256(block)


def pb_node(links, data):
    """A dag-pb node: links (field 2) before data (field 1); each link its Hash, Name (present, even empty) and Tsize."""
    out = b"".join(pb_bytes(2, pb_bytes(1, c) + pb_bytes(2, name) + pb_varint(3, tsize)) for c, name, tsize in links)
    return out + pb_bytes(1, data)


def file_dag(data, blocks):
    """The object DAG of one file; returns (cid, tsize) and records each block."""
    assert len(data) >= 1
    leaves = []
    for at in range(0, len(data), CHUNK):
        chunk = data[at : at + CHUNK]
        c = cid(0x55, chunk)
        blocks[c] = chunk
        leaves.append((c, len(chunk), len(chunk)))  # (cid, tsize, content length)
    level = leaves
    while len(level) > 1:
        parents = []
        for at in range(0, len(level), MAX_LINKS):
            group = level[at : at + MAX_LINKS]
            filesize = sum(n for _, _, n in group)
            unixfs = pb_varint(1, 2) + pb_varint(3, filesize) + b"".join(pb_varint(4, n) for _, _, n in group)
            node = pb_node([(c, b"", t) for c, t, _ in group], unixfs)
            c = cid(0x70, node)
            blocks[c] = node
            parents.append((c, len(node) + sum(t for _, t, _ in group), filesize))
        level = parents
    c, t, _ = level[0]
    return c, t


def directory_dag(entries, blocks):
    """entries: a dict from segment (bytes) to file bytes or a nested dict. Returns (cid, tsize)."""
    links = []
    for name in sorted(entries):
        e = entries[name]
        c, t = directory_dag(e, blocks) if isinstance(e, dict) else file_dag(e, blocks)
        links.append((c, name, t))
    node = pb_node(links, pb_varint(1, 1))
    c = cid(0x70, node)
    blocks[c] = node
    return c, len(node) + sum(t for _, _, t in links)


def tree(files):
    root = {}
    for path, data in files:
        parts = path.split(b"/")
        d = root
        for p in parts[:-1]:
            d = d.setdefault(p, {})
        d[parts[-1]] = data
    return root


def car(root, blocks):
    header = (
        b"\xa2\x65roots\x81\xd8\x2a\x58" + bytes([len(root) + 1]) + b"\x00" + root + b"\x67version\x01"
    )
    out = bytearray(varint(len(header)) + header)
    seen = set()
    order = []

    def walk(c):
        if c in seen:
            return
        seen.add(c)
        order.append(c)
        if c[1] == 0x70:
            for link in dag_pb_links(blocks[c]):
                walk(link)

    walk(root)
    for c in order:
        out += varint(len(c) + len(blocks[c])) + c + blocks[c]
    return bytes(out), len(order)


def read_varint(b, at):
    n = shift = 0
    while True:
        x = b[at]
        at += 1
        n |= (x & 0x7F) << shift
        shift += 7
        if not x & 0x80:
            return n, at


def dag_pb_links(node):
    links = []
    at = 0
    while at < len(node):
        key, at = read_varint(node, at)
        length, at = read_varint(node, at)
        body = node[at : at + length]
        at += length
        if key == (2 << 3 | 2):
            k, j = read_varint(body, 0)
            assert k == (1 << 3 | 2)
            n, j = read_varint(body, j)
            links.append(body[j : j + n])
    return links


def site_dag(files):
    blocks = {}
    root, _ = directory_dag(tree([(p.encode(), obj(label, length)) for p, label, length in files]), blocks)
    return root, blocks


def check_sites(site_vectors):
    for v in site_vectors:
        files = [(f["path"], f["label"], f["length"]) for f in v["files"]]
        root, blocks = site_dag(files)
        c, count = car(root, blocks)
        assert h(root) == v["cidHex"], v["id"]
        assert len(blocks[root]) == v["rootLength"] and h(sha256(blocks[root])) == v["rootSha256"], v["id"]
        if "root" in v:
            assert h(blocks[root]) == v["root"], v["id"]
        assert count == v["blocks"], v["id"]
        assert len(c) == v["carLength"] and h(sha256(c)) == v["carSha256"], v["id"]
        if "car" in v:
            assert h(c) == v["car"], v["id"]
        assert base32_cid(root) == v["cid"], v["id"]


def base32_cid(c):
    alphabet = "abcdefghijklmnopqrstuvwxyz234567"
    bits = "".join(f"{x:08b}" for x in c)
    bits += "0" * (-len(bits) % 5)
    return "b" + "".join(alphabet[int(bits[i : i + 5], 2)] for i in range(0, len(bits), 5))


# --- The record, from docs/spec/release.md --------------------------------


def u8(x):
    return x.to_bytes(1, "big")


def u16(x):
    return x.to_bytes(2, "big")


def u32(x):
    return x.to_bytes(4, "big")


def u64(x):
    return x.to_bytes(8, "big")


def var(b):
    return u32(len(b)) + b


def lst(items, enc):
    return u32(len(items)) + b"".join(enc(i) for i in items)


def enc_header(x):
    return var(x["name"]) + var(x["value"])


def enc_file(x):
    return var(x["path"]) + u64(x["length"]) + x["sha256"] + var(x["media_type"])


def enc_site(s):
    return (
        u8(s["kind"])
        + lst(s["origins"], var)
        + u8(1 if s["loopback"] else 0)
        + lst(s["headers"], enc_header)
        + lst(s["files"], enc_file)
        + s["directory"]
    )


def encode(r, record_type=RECORD_TYPE, version=VERSION):
    return (
        u16(record_type)
        + u8(version)
        + u64(r["l1_chain_id"])
        + r["registry"]
        + u64(r["sequence"])
        + r["previous"]
        + r["source_commit"]
        + r["deployment_hash"]
        + lst(r["sites"], enc_site)
    )


class DecodeError(Exception):
    pass


class Reader:
    def __init__(self, b):
        self.b = b
        self.at = 0

    def take(self, n):
        if self.at + n > len(self.b):
            raise DecodeError("truncated")
        out = self.b[self.at : self.at + n]
        self.at += n
        return out

    def int(self, n):
        return int.from_bytes(self.take(n), "big")

    def var(self, m):
        n = self.int(4)
        if n > m:
            raise DecodeError("length-over-max")
        return self.take(n)

    def lst(self, m, dec):
        n = self.int(4)
        if n > m:
            raise DecodeError("length-over-max")
        return [dec(self) for _ in range(n)]

    def enum(self, values):
        x = self.int(1)
        if x not in values:
            raise DecodeError("invalid-enum")
        return x


def dec_site(r):
    kind = r.enum({1, 2})
    origins = r.lst(MAX_ORIGINS, lambda r: r.var(MAX_ORIGIN))
    loopback = r.enum({0, 1}) == 1
    headers = r.lst(MAX_HEADERS, lambda r: {"name": r.var(MAX_HEADER_NAME), "value": r.var(MAX_HEADER_VALUE)})
    files = r.lst(
        MAX_FILES,
        lambda r: {"path": r.var(MAX_PATH), "length": r.int(8), "sha256": r.take(32), "media_type": r.var(MAX_MEDIA_TYPE)},
    )
    return {"kind": kind, "origins": origins, "loopback": loopback, "headers": headers, "files": files, "directory": r.take(36)}


def decode(b):
    r = Reader(b)
    record_type = r.int(2)
    if record_type != RECORD_TYPE:
        raise DecodeError("unknown-record-type")
    if r.int(1) != VERSION:
        raise DecodeError("unknown-version")
    out = {
        "l1_chain_id": r.int(8),
        "registry": r.take(20),
        "sequence": r.int(8),
        "previous": r.take(32),
        "source_commit": r.take(20),
        "deployment_hash": r.take(32),
        "sites": r.lst(MAX_SITES, dec_site),
    }
    if r.at != len(b):
        raise DecodeError("trailing-bytes")
    return out


LABEL = re.compile(rb"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
TCHAR = re.compile(rb"[a-z0-9!#$%&'*+.^_`|~-]+")
SEGMENT = re.compile(rb"[A-Za-z0-9._-]{1,128}")
MEDIA_PART = re.compile(rb"[a-z0-9][a-z0-9!#$&^_.+-]*")


def origin_ok(o):
    if not o.startswith(b"https://"):
        return False
    rest = o[len(b"https://") :]
    host, sep, port = rest.partition(b":")
    if sep:
        if not re.fullmatch(rb"[1-9][0-9]{0,4}", port) or int(port) > 65535 or port == b"443":
            return False
    if not 1 <= len(host) <= 253:
        return False
    labels = host.split(b".")
    if len(labels) < 2 or not all(LABEL.fullmatch(x) for x in labels):
        return False
    return b"a" <= labels[-1][:1] <= b"z"


def value_ok(v):
    return 1 <= len(v) and all(0x20 <= x <= 0x7E for x in v) and v[0] != 0x20 and v[-1] != 0x20


def path_ok(p):
    segments = p.split(b"/")
    return len(segments) <= MAX_SEGMENTS and all(
        SEGMENT.fullmatch(s) and s not in (b".", b"..") for s in segments
    )


def media_ok(m):
    base = m[: -len(b"; charset=utf-8")] if m.endswith(b"; charset=utf-8") else m
    t, sep, sub = base.partition(b"/")
    return bool(sep) and bool(MEDIA_PART.fullmatch(t)) and bool(MEDIA_PART.fullmatch(sub))


def ascending(xs):
    return all(a < b for a, b in zip(xs, xs[1:]))


# The well-formedness rules in docs/spec/release.md's order: the record's,
# then each site's, then origin-shared. The file lists them, and a test
# compares that list with the spec's table.
SITE_RULES = [
    "origin",
    "origin-order",
    "site-unreachable",
    "loopback-site",
    "challenge-origin",
    "header-name",
    "header-reserved",
    "header-value",
    "header-order",
    "site-csp",
    "path",
    "path-reserved",
    "path-order",
    "path-conflict",
    "site-index",
    "empty-file",
    "file-too-large",
    "media-type",
    "directory-cid",
]
RULES = ["release-chain", "site-order", "site-ballot", *SITE_RULES, "origin-shared"]


def ill_formed(r):
    """The first well-formedness rule the record breaks, in the spec's order, or None."""
    if (r["sequence"] == 0) != (r["previous"] == bytes(32)):
        return "release-chain", {}
    if not ascending([s["kind"] for s in r["sites"]]):
        return "site-order", {}
    if not r["sites"] or r["sites"][0]["kind"] != 1:
        return "site-ballot", {}
    for i, s in enumerate(r["sites"]):
        at = {"site": i}
        names = [x["name"] for x in s["headers"]]
        paths = [x["path"] for x in s["files"]]
        checks = [
            ("origin", any(not origin_ok(o) for o in s["origins"])),
            ("origin-order", not ascending(s["origins"])),
            ("site-unreachable", not s["origins"] and not s["loopback"]),
            ("loopback-site", s["loopback"] and s["kind"] != 1),
            ("challenge-origin", s["kind"] == 2 and len(s["origins"]) != 1),
            ("header-name", any(not TCHAR.fullmatch(n) for n in names)),
            ("header-reserved", any(n in RESERVED_HEADERS for n in names)),
            ("header-value", any(not value_ok(x["value"]) for x in s["headers"])),
            ("header-order", not ascending(names)),
            ("site-csp", b"content-security-policy" not in names),
            ("path", any(not path_ok(p) for p in paths)),
            ("path-reserved", any(p in RESERVED_PATHS for p in paths)),
            ("path-order", not ascending(paths)),
            ("path-conflict", any(q.startswith(p + b"/") for p in paths for q in paths)),
            ("site-index", b"index.html" not in paths),
            ("empty-file", any(x["length"] == 0 for x in s["files"])),
            ("file-too-large", any(x["length"] > MAX_RELEASE_FILE for x in s["files"])),
            ("media-type", any(not media_ok(x["media_type"]) for x in s["files"])),
            ("directory-cid", s["directory"][:4] != bytes([0x01, 0x70, 0x12, 0x20])),
        ]
        assert [code for code, _ in checks] == SITE_RULES
        for code, broken in checks:
            if broken:
                return code, at
    if len(r["sites"]) == 2 and set(r["sites"][0]["origins"]) & set(r["sites"][1]["origins"]):
        return "origin-shared", {}
    return None


# --- Vectors ---------------------------------------------------------------

MEDIA = {
    ".html": b"text/html; charset=utf-8",
    ".js": b"text/javascript; charset=utf-8",
    ".css": b"text/css; charset=utf-8",
    ".txt": b"text/plain; charset=utf-8",
    ".woff2": b"font/woff2",
    ".zkey": b"application/octet-stream",
    ".bin": b"application/octet-stream",
    "webauthn": b"application/json",
}


def media_of(path):
    for ext, m in MEDIA.items():
        if path.endswith(ext):
            return m
    return b"application/octet-stream"


def site_from(site_vectors, sid, kind, origins, loopback, headers):
    v = next(x for x in site_vectors if x["id"] == sid)
    files = sorted(
        (
            {
                "path": f["path"].encode(),
                "length": f["length"],
                "sha256": sha256(obj(f["label"], f["length"])),
                "media_type": media_of(f["path"]),
            }
            for f in v["files"]
        ),
        key=lambda f: f["path"],
    )
    return {
        "kind": kind,
        "origins": [o.encode() for o in origins],
        "loopback": loopback,
        "headers": [{"name": n.encode(), "value": val.encode()} for n, val in headers],
        "files": files,
        "directory": bytes.fromhex(v["cidHex"]),
        "_site": sid,
    }


CSP = (
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; "
    "img-src 'self' data:; connect-src https://api-staging.abolish.us https://sepolia.base.org; "
    "worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)
BALLOT_HEADERS = [
    ("content-security-policy", CSP),
    ("cross-origin-opener-policy", "same-origin"),
    ("cross-origin-resource-policy", "same-origin"),
    ("permissions-policy", "camera=(), microphone=(), geolocation=()"),
    ("referrer-policy", "no-referrer"),
    ("x-content-type-options", "nosniff"),
]
CHALLENGE_HEADERS = [
    ("content-security-policy", "default-src 'none'; script-src 'self'; frame-ancestors https://abolishus.eth.limo"),
    ("x-content-type-options", "nosniff"),
]

SEPOLIA = 11155111
REGISTRY = sha256(b"release registry address")[:20]


def base(sites, sequence=0, previous=bytes(32), label="first"):
    return {
        "l1_chain_id": SEPOLIA,
        "registry": REGISTRY,
        "sequence": sequence,
        "previous": previous,
        "source_commit": sha256(b"source commit " + label.encode())[:20],
        "deployment_hash": sha256(b"deployment " + label.encode()),
        "sites": sites,
    }


def value_json(r):
    def site(s):
        return {
            "kind": str(s["kind"]),
            "origins": [h(o) for o in s["origins"]],
            "loopback": s["loopback"],
            "headers": [{"name": h(x["name"]), "value": h(x["value"])} for x in s["headers"]],
            "files": [
                {"path": h(x["path"]), "length": str(x["length"]), "sha256": h(x["sha256"]), "media_type": h(x["media_type"])}
                for x in s["files"]
            ],
            "directory": h(s["directory"]),
        }

    return {
        "l1_chain_id": str(r["l1_chain_id"]),
        "registry": h(r["registry"]),
        "sequence": str(r["sequence"]),
        "previous": h(r["previous"]),
        "source_commit": h(r["source_commit"]),
        "deployment_hash": h(r["deployment_hash"]),
        "sites": [site(s) for s in r["sites"]],
    }


def types():
    def b(n=None, m=None):
        return {"kind": "bytes", "length": n} if n is not None else {"kind": "bytes", "max": m}

    site = {
        "kind": "struct",
        "fields": [
            {"name": "kind", "type": {"kind": "enum8", "values": ["1", "2"]}},
            {"name": "origins", "type": {"kind": "list", "max": MAX_ORIGINS, "of": b(m=MAX_ORIGIN)}},
            {"name": "loopback", "type": {"kind": "bool"}},
            {
                "name": "headers",
                "type": {
                    "kind": "list",
                    "max": MAX_HEADERS,
                    "of": {
                        "kind": "struct",
                        "fields": [
                            {"name": "name", "type": b(m=MAX_HEADER_NAME)},
                            {"name": "value", "type": b(m=MAX_HEADER_VALUE)},
                        ],
                    },
                },
            },
            {
                "name": "files",
                "type": {
                    "kind": "list",
                    "max": MAX_FILES,
                    "of": {
                        "kind": "struct",
                        "fields": [
                            {"name": "path", "type": b(m=MAX_PATH)},
                            {"name": "length", "type": {"kind": "u64"}},
                            {"name": "sha256", "type": b(n=32)},
                            {"name": "media_type", "type": b(m=MAX_MEDIA_TYPE)},
                        ],
                    },
                },
            },
            {"name": "directory", "type": b(n=36)},
        ],
    }
    return {
        "site": site,
        "release": {
            "kind": "record",
            "recordType": f"{RECORD_TYPE:04x}",
            "version": VERSION,
            "fields": [
                {"name": "l1_chain_id", "type": {"kind": "u64"}},
                {"name": "registry", "type": b(n=20)},
                {"name": "sequence", "type": {"kind": "u64"}},
                {"name": "previous", "type": b(n=32)},
                {"name": "source_commit", "type": b(n=20)},
                {"name": "deployment_hash", "type": b(n=32)},
                {"name": "sites", "type": {"kind": "list", "max": MAX_SITES, "of": {"kind": "ref", "name": "site"}}},
            ],
        },
    }


def clone(r):
    return json.loads(json.dumps(r, default=lambda b: {"__b": b.hex()}), object_hook=lambda d: bytes.fromhex(d["__b"]) if "__b" in d else d)


def main():
    vectors_dir = pathlib.Path(sys.argv[1])
    site_vectors = json.loads((vectors_dir / "site-directory.json").read_text())["vectors"]
    check_sites(site_vectors)

    def ballot(sid="ballot-like", origins=("https://abolishus.eth.limo", "https://ballot-staging.up.railway.app"), loopback=True, headers=BALLOT_HEADERS):
        return site_from(site_vectors, sid, 1, origins, loopback, headers)

    def challenge(sid="challenge-like", origins=("https://challenge-staging.up.railway.app",), headers=CHALLENGE_HEADERS):
        return site_from(site_vectors, sid, 2, origins, False, headers)

    only_csp = [("content-security-policy", "default-src 'none'; frame-ancestors 'none'")]
    first = base([ballot("index-only", ("https://ballot-staging.up.railway.app",), False, only_csp)])
    first_hash = release_hash(encode(strip(first)))
    typical = base([ballot(), challenge()], 1, first_hash, "typical")
    # The ill-formed vectors each break one rule of a small record that keeps
    # both sites, so every rule but the chain's is placed in a site.
    small = base(
        [
            ballot(
                "index-only",
                ("https://abolishus.eth.limo",),
                True,
                [("content-security-policy", "default-src 'none'"), ("x-content-type-options", "nosniff")],
            ),
            challenge(),
        ],
        1,
        first_hash,
        "small",
    )

    valid = [
        ("first", "The first release in a registry: sequence 0, previous all zero, one site of one file and only its CSP", first),
        ("typical", "A ballot client and a challenge page, the release after `first`", typical),
        ("loopback-only", "A ballot site with no listed origin, served only by apps/node at a loopback origin", base([ballot("index-only", (), True, only_csp)], 2, first_hash, "loopback")),
        (
            "boundaries",
            "Origins with a port and a 253-byte host, eight origins, sixteen headers, a 4,096-byte header value and a 127-byte media type",
            boundaries(ballot, site_vectors),
        ),
        ("widest-site", "1,024 files in one directory, as many as a site may have", base([ballot("widest-directory")], 3, first_hash, "widest")),
        ("longest-path", "A 1,024-byte path", base([ballot("longest-path")], 4, first_hash, "longest")),
        ("deepest-path", "A 128-byte name and a 16-segment path", base([ballot("longest-name-deepest-path")], 5, first_hash, "deepest")),
        ("name-order", "File paths in byte order across punctuation, digits and both cases", base([ballot("name-order")], 6, first_hash, "order")),
        ("identical-files", "The same bytes at two paths", base([ballot("identical-files")], 7, first_hash, "identical")),
        ("chunk-boundaries", "Files of one chunk and one chunk and a byte", base([ballot("chunk-boundaries")], 8, first_hash, "chunks")),
        ("max-sequence", "The largest sequence a u64 holds", base([ballot("index-only", ("https://ballot-staging.up.railway.app",), False, only_csp)], 2**64 - 1, first_hash, "max")),
    ]

    out_vectors = []
    for vid, description, r in valid:
        enc = encode(strip(r))
        assert decode(enc) == strip(r), vid
        assert ill_formed(strip(r)) is None, (vid, ill_formed(strip(r)))
        out_vectors.append(
            {
                "id": vid,
                "description": description,
                "type": {"kind": "ref", "name": "release"},
                "encoding": h(enc),
                "value": value_json(strip(r)),
                "sites": [s["_site"] for s in r["sites"]],
                "releaseHash": h(release_hash(enc)),
            }
        )

    for vid, description, mutate, code, at in ill_formed_cases():
        r = strip(clone(small if not vid.startswith("first-") else first))
        mutate(r)
        enc = encode(r)
        assert decode(enc) == r, vid
        got = ill_formed(r)
        assert got == (code, at), (vid, got, code)
        v = {
            "id": vid,
            "description": description,
            "type": {"kind": "ref", "name": "release"},
            "encoding": h(enc),
            "value": value_json(r),
            "releaseHash": h(release_hash(enc)),
            "illFormed": code,
        }
        if at:
            v["illFormedAt"] = {k: str(x) for k, x in at.items()}
        out_vectors.append(v)

    assert {v["illFormed"] for v in out_vectors if "illFormed" in v} == set(RULES)
    typical_enc = encode(strip(typical))
    for vid, description, enc, code in decode_cases(typical_enc, strip(first)):
        try:
            decode(enc)
        except DecodeError as e:
            assert str(e) == code, (vid, str(e), code)
        else:
            raise AssertionError(f"{vid} decoded")
        out_vectors.append({"id": vid, "description": description, "type": {"kind": "ref", "name": "release"}, "encoding": h(enc), "error": code})

    out = {
        "format": "abolish-release-record-vectors/1",
        "title": "Release record: encoding, strict decoding, well-formedness and the release hash",
        "spec": "docs/spec/release.md",
        "generator": (
            "packages/crypto/scripts/release-record-vectors.py: an independent Python implementation (standard library "
            "only) of the record, its decoder and its rules; every site's directory CID is rebuilt from "
            "docs/spec/content-addressing.md and checked against site-directory.json, which Kubo 0.36.0 and "
            "ipfs-unixfs-importer 17.1.1 both produced"
        ),
        "tag": TAG.decode(),
        "maxReleaseFile": str(MAX_RELEASE_FILE),
        "rules": RULES,
        "types": types(),
        "vectors": out_vectors,
    }
    (vectors_dir / "release-record.json").write_text(json.dumps(out, indent=2) + "\n")


def strip(r):
    out = dict(r)
    out["sites"] = [{k: v for k, v in s.items() if k != "_site"} for s in r["sites"]]
    return out


def boundaries(ballot, site_vectors):
    host = ".".join(["a" * 63, "b" * 63, "c" * 63, "d" * 61])
    assert len(host) == 253
    origins = sorted(
        [f"https://{host}", "https://x.y:1", "https://x.y:65535", "https://x.y:8443", "https://a-b.c0", "https://abolishus.eth.limo", "https://xn--bcher-kva.example", "https://9.a"]
    )
    headers = sorted(
        [("x-max", "v" * MAX_HEADER_VALUE), ("x-" + "n" * (MAX_HEADER_NAME - 2), "~")]
        + [("content-security-policy", "default-src 'none'")]
        + [(f"x-h{i:02d}", f"value {i}") for i in range(13)]
    )
    s = ballot("index-only", origins, True, headers)
    s["files"][0]["media_type"] = b"application/" + b"x" * (MAX_MEDIA_TYPE - len(b"application/"))
    return base([s], 9, sha256(b"some earlier release"), "boundaries")


def ill_formed_cases():
    def site(i, f):
        return lambda r: f(r["sites"][i])

    def file(i, j, key, value):
        return site(i, lambda s: s["files"][j].__setitem__(key, value))

    def origins(i, os):
        return site(i, lambda s: s.__setitem__("origins", os))

    def headers(i, hs):
        return site(i, lambda s: s.__setitem__("headers", [{"name": n, "value": v} for n, v in hs]))

    def paths(i, ps):
        def f(s):
            template = s["files"][0]
            s["files"] = [dict(template, path=p) for p in ps]

        return site(i, f)

    nonzero = sha256(b"x")
    S0 = {"site": 0}
    S1 = {"site": 1}
    return [
        ("chain-previous-at-zero", "Sequence 0 with a non-zero previous", lambda r: r.__setitem__("sequence", 0), "release-chain", {}),
        ("first-chain-zero-previous", "A later sequence with an all-zero previous", lambda r: r.__setitem__("sequence", 3), "release-chain", {}),
        ("sites-reversed", "The challenge page before the ballot client", lambda r: r["sites"].reverse(), "site-order", {}),
        ("sites-repeated", "Two ballot sites", lambda r: r["sites"].__setitem__(1, dict(r["sites"][0])), "site-order", {}),
        ("no-sites", "No site at all", lambda r: r.__setitem__("sites", []), "site-ballot", {}),
        ("challenge-only", "Only a challenge page", lambda r: r.__setitem__("sites", r["sites"][1:]), "site-ballot", {}),
        ("origin-http", "An http origin", origins(0, [b"http://abolishus.eth.limo"]), "origin", S0),
        ("origin-default-port", "An origin naming port 443", origins(0, [b"https://abolishus.eth.limo:443"]), "origin", S0),
        ("origin-port-zero-led", "A port with a leading zero", origins(0, [b"https://x.y:0443"]), "origin", S0),
        ("origin-port-high", "Port 65536", origins(0, [b"https://x.y:65536"]), "origin", S0),
        ("origin-port-zero", "Port 0", origins(0, [b"https://x.y:0"]), "origin", S0),
        ("origin-upper", "An upper-case host", origins(0, [b"https://Abolishus.eth.limo"]), "origin", S0),
        ("origin-one-label", "A host of one label", origins(0, [b"https://localhost"]), "origin", S0),
        ("origin-ipv4", "An IPv4 address", origins(0, [b"https://127.0.0.1"]), "origin", S0),
        ("origin-path", "An origin with a path", origins(0, [b"https://x.y/"]), "origin", S0),
        ("origin-trailing-dot", "A host ending in a dot", origins(0, [b"https://x.y."]), "origin", S0),
        ("origin-label-hyphen", "A label ending in a hyphen", origins(0, [b"https://x-.y"]), "origin", S0),
        ("origin-label-long", "A 64-byte label", origins(0, [b"https://" + b"a" * 64 + b".y"]), "origin", S0),
        ("origin-host-long", "A 254-byte host", origins(0, [b"https://" + b".".join([b"a" * 63] * 3 + [b"b" * 62])]), "origin", S0),
        ("origin-userinfo", "An origin with userinfo", origins(0, [b"https://u@x.y"]), "origin", S0),
        ("origin-hex-ipv4", "A last label a URL parser reads as a hex number, making the host an IPv4 address", origins(0, [b"https://1.2.3.0x4"]), "origin", S0),
        ("origin-0x-tld", "A last label of 0x alone", origins(0, [b"https://a.0x"]), "origin", S0),
        ("origin-digit-tld", "A last label starting with a digit", origins(0, [b"https://a.9b"]), "origin", S0),
        ("origins-unsorted", "Origins out of order", origins(0, [b"https://b.y", b"https://a.y"]), "origin-order", S0),
        ("origins-repeated", "An origin listed twice", origins(0, [b"https://a.y", b"https://a.y"]), "origin-order", S0),
        ("unreachable", "No origin and no loopback", lambda r: (r["sites"][0].__setitem__("origins", []), r["sites"][0].__setitem__("loopback", False)), "site-unreachable", S0),
        ("challenge-loopback", "A challenge page served at a loopback origin", site(1, lambda s: s.__setitem__("loopback", True)), "loopback-site", S1),
        ("challenge-two-origins", "A challenge page at two origins", origins(1, [b"https://c1.example", b"https://c2.example"]), "challenge-origin", S1),
        ("header-upper", "An upper-case header name", headers(0, [(b"X-A", b"v")]), "header-name", S0),
        ("header-empty-name", "An empty header name", headers(0, [(b"", b"v")]), "header-name", S0),
        ("header-colon", "A header name with a colon", headers(0, [(b"x:a", b"v")]), "header-name", S0),
        ("header-content-type", "content-type among the site's headers", headers(0, [(b"content-type", b"text/html")]), "header-reserved", S0),
        ("header-content-encoding", "content-encoding among the site's headers", headers(0, [(b"content-encoding", b"gzip")]), "header-reserved", S0),
        *[
            (f"header-{n}", f"{n} among the site's headers", headers(0, [(n.encode(), b"v")]), "header-reserved", S0)
            for n in ["connection", "content-length", "content-range", "keep-alive", "proxy-connection", "te", "transfer-encoding", "upgrade"]
        ],
        ("header-empty-value", "An empty header value", headers(0, [(b"x-a", b"")]), "header-value", S0),
        ("header-value-space", "A header value ending in a space", headers(0, [(b"x-a", b"v ")]), "header-value", S0),
        ("header-value-newline", "A header value with a line feed", headers(0, [(b"x-a", b"v\nx-b: w")]), "header-value", S0),
        ("header-value-tab", "A header value with a tab", headers(0, [(b"x-a", b"v\tw")]), "header-value", S0),
        ("header-value-8bit", "A header value with a byte above 0x7e", headers(0, [(b"x-a", b"v\x80")]), "header-value", S0),
        ("headers-unsorted", "Header names out of order", headers(0, [(b"x-b", b"v"), (b"x-a", b"v")]), "header-order", S0),
        ("headers-repeated", "A header listed twice", headers(0, [(b"x-a", b"v"), (b"x-a", b"w")]), "header-order", S0),
        ("no-csp", "A site without a content-security-policy header", headers(1, [(b"x-content-type-options", b"nosniff")]), "site-csp", S1),
        ("path-leading-slash", "A path with a leading slash", paths(1, [b"/index.html"]), "path", S1),
        ("path-dot", "A `.` segment", paths(1, [b"./index.html"]), "path", S1),
        ("path-dot-dot", "A `..` segment", paths(1, [b"a/../index.html"]), "path", S1),
        ("path-empty-segment", "An empty segment", paths(1, [b"a//b"]), "path", S1),
        ("path-trailing-slash", "A path ending in a slash", paths(1, [b"a/"]), "path", S1),
        ("path-space", "A space in a path", paths(1, [b"a b"]), "path", S1),
        ("path-percent", "A percent sign in a path", paths(1, [b"a%2fb"]), "path", S1),
        ("path-backslash", "A backslash in a path", paths(1, [b"a\\b"]), "path", S1),
        ("path-long-segment", "A 129-byte segment", paths(1, [b"a" * 129]), "path", S1),
        ("path-deep", "A path of 17 segments", paths(1, [b"/".join([b"d"] * 17)]), "path", S1),
        ("path-empty", "An empty path", paths(1, [b""]), "path", S1),
        ("path-redirects", "A root _redirects file, which IPFS gateways apply", paths(1, [b"_redirects", b"index.html"]), "path-reserved", S1),
        ("path-headers", "A root _headers file, which some hosts apply", paths(1, [b"_headers", b"index.html"]), "path-reserved", S1),
        ("paths-unsorted", "Paths out of order", paths(1, [b"index.html", b"assets/a.js"]), "path-order", S1),
        ("paths-repeated", "A path listed twice", paths(1, [b"index.html", b"index.html"]), "path-order", S1),
        ("path-conflict", "A path that is also a directory", paths(1, [b"a", b"a/b", b"index.html"]), "path-conflict", S1),
        ("path-conflict-distant", "A file and a directory of the same name, apart in byte order", paths(1, [b"a", b"a-b", b"a/b", b"index.html"]), "path-conflict", S1),
        ("no-index", "No index.html", paths(1, [b"assets/a.js", b"index.htm"]), "site-index", S1),
        ("index-nested", "index.html only below the root", paths(1, [b"a/index.html"]), "site-index", S1),
        ("empty-file", "A file of zero bytes", file(1, 0, "length", 0), "empty-file", S1),
        ("file-too-large", "A file one byte over MAX_RELEASE_FILE", file(1, 0, "length", MAX_RELEASE_FILE + 1), "file-too-large", S1),
        ("media-empty", "An empty media type", file(1, 0, "media_type", b""), "media-type", S1),
        ("media-no-subtype", "A media type with no subtype", file(1, 0, "media_type", b"text"), "media-type", S1),
        ("media-upper", "An upper-case media type", file(1, 0, "media_type", b"Text/html"), "media-type", S1),
        ("media-charset-other", "A charset other than utf-8", file(1, 0, "media_type", b"text/html; charset=latin1"), "media-type", S1),
        ("media-charset-spacing", "A charset parameter without its space", file(1, 0, "media_type", b"text/html;charset=utf-8"), "media-type", S1),
        ("media-parameter", "A parameter other than the charset", file(1, 0, "media_type", b"text/html; q=1"), "media-type", S1),
        ("directory-raw", "A directory CID with the raw codec", site(1, lambda s: s.__setitem__("directory", bytes([0x01, 0x55, 0x12, 0x20]) + s["directory"][4:])), "directory-cid", S1),
        ("directory-cidv0-prefix", "A directory CID that isn't CIDv1", site(1, lambda s: s.__setitem__("directory", bytes([0x00, 0x70, 0x12, 0x20]) + s["directory"][4:])), "directory-cid", S1),
        ("origin-shared", "The ballot client and the challenge page at one origin", origins(1, [b"https://abolishus.eth.limo"]), "origin-shared", {}),
        (
            "rule-order-sites",
            "A late rule in the ballot site and an early one in the challenge page: the ballot site's comes first",
            lambda r: (r["sites"][0]["files"][0].__setitem__("media_type", b"x"), r["sites"][1].__setitem__("origins", [b"http://x.y"])),
            "media-type",
            S0,
        ),
        (
            "rule-order-in-site",
            "A bad header value and a bad origin in one site: origin comes first",
            lambda r: (r["sites"][0]["headers"][0].__setitem__("value", b""), r["sites"][0].__setitem__("origins", [b"http://x.y"])),
            "origin",
            S0,
        ),
        (
            "rule-order-ballot",
            "Only a challenge page, with a bad origin: site-ballot comes first",
            lambda r: (r.__setitem__("sites", r["sites"][1:]), r["sites"][0].__setitem__("origins", [b"http://x.y"])),
            "site-ballot",
            {},
        ),
        ("rule-order", "A bad chain and a bad origin: release-chain comes first", lambda r: (r.__setitem__("sequence", 0), r["sites"][0].__setitem__("origins", [b"http://x.y"])), "release-chain", {}),
    ]


def decode_cases(typical, first):
    first_enc = encode(first)
    header = 3
    sites_at = header + 8 + 20 + 8 + 32 + 20 + 32
    site0 = sites_at + 4
    origins_count = site0 + 1

    def at(enc, i, b):
        return enc[:i] + b + enc[i + len(b) :]

    return [
        ("truncated-header", "Two bytes", typical[:2], "truncated"),
        ("truncated-fixed", "Cut inside the source commit", typical[: header + 8 + 20 + 8 + 32 + 10], "truncated"),
        ("truncated-last-byte", "The last byte missing", typical[:-1], "truncated"),
        ("trailing-byte", "A byte after the last field", typical + b"\x00", "trailing-bytes"),
        ("unknown-version", "Version 2", at(typical, 2, b"\x02"), "unknown-version"),
        ("version-zero", "Version 0", at(typical, 2, b"\x00"), "unknown-version"),
        ("reserved-deployment-type", "The deployment record's reserved type", at(typical, 0, b"\x00\x20"), "unknown-record-type"),
        ("test-type", "A test-range type", at(typical, 0, b"\xff\x00"), "unknown-record-type"),
        ("sites-over-max", "Three sites", at(first_enc, sites_at, u32(3)), "length-over-max"),
        ("kind-zero", "Site kind 0", at(first_enc, site0, b"\x00"), "invalid-enum"),
        ("kind-three", "Site kind 3", at(first_enc, site0, b"\x03"), "invalid-enum"),
        ("origins-over-max", "Nine origins", at(first_enc, origins_count, u32(9)), "length-over-max"),
        ("origin-over-max", "An origin of 268 bytes", at(first_enc, origins_count + 4, u32(268)), "length-over-max"),
        ("origin-past-end", "An origin longer than the input", at(first_enc, origins_count + 4, u32(267)), "truncated"),
        ("loopback-two", "A loopback byte of 2", loopback_two(first_enc, origins_count), "invalid-enum"),
        ("headers-over-max", "Seventeen headers", headers_count(first_enc, origins_count, u32(17)), "length-over-max"),
        ("header-name-over-max", "A 65-byte header name", header_field(first_enc, origins_count, 65, 0), "length-over-max"),
        ("header-value-over-max", "A 4,097-byte header value", header_field(first_enc, origins_count, 1, 4097), "length-over-max"),
        ("files-over-max", "1,025 files", files_count(first_enc, origins_count, u32(1025)), "length-over-max"),
        ("path-over-max", "A 1,025-byte path", path_len(first_enc, origins_count, 1025), "length-over-max"),
        ("media-type-over-max", "A 128-byte media type", media_len(first_enc, origins_count, 128), "length-over-max"),
    ]


# The first vector's single site: one origin, no headers, one file. These
# locate its fields so a rejection can be placed exactly.
def _site_offsets(enc, origins_count):
    n = int.from_bytes(enc[origins_count : origins_count + 4], "big")
    at = origins_count + 4
    for _ in range(n):
        at += 4 + int.from_bytes(enc[at : at + 4], "big")
    loopback = at
    headers = loopback + 1
    at = headers + 4
    for _ in range(int.from_bytes(enc[headers : headers + 4], "big")):
        for _field in range(2):
            at += 4 + int.from_bytes(enc[at : at + 4], "big")
    files = at
    path = files + 4
    plen = int.from_bytes(enc[path : path + 4], "big")
    media = path + 4 + plen + 8 + 32
    return loopback, headers, files, path, media


def loopback_two(enc, oc):
    lb, *_ = _site_offsets(enc, oc)
    return enc[:lb] + b"\x02" + enc[lb + 1 :]


def headers_count(enc, oc, b):
    _, hd, *_ = _site_offsets(enc, oc)
    return enc[:hd] + b + enc[hd + 4 :]


def header_field(enc, oc, name_len, value_len):
    _, hd, *_ = _site_offsets(enc, oc)
    body = u32(1) + u32(name_len) + b"x" * min(name_len, MAX_HEADER_NAME)
    if name_len <= MAX_HEADER_NAME:
        body += u32(value_len)
    return enc[:hd] + body + enc[hd + 4 :]


def files_count(enc, oc, b):
    _, _, fl, *_ = _site_offsets(enc, oc)
    return enc[:fl] + b + enc[fl + 4 :]


def path_len(enc, oc, n):
    _, _, _, p, _ = _site_offsets(enc, oc)
    return enc[:p] + u32(n) + enc[p + 4 :]


def media_len(enc, oc, n):
    *_, m = _site_offsets(enc, oc)
    return enc[:m] + u32(n) + enc[m + 4 :]


if __name__ == "__main__":
    main()
