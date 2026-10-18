#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/deployment-record.json.

A second implementation of docs/spec/deployment.md: the deployment record
(record type 0x0020, version 1), its strict decoding, its well-formedness
rules in their order, the deployment hash, and the rules a release record and
the deployment it names meet together. Standard library only; it shares no
code with packages/crypto. It reuses trustee-vectors.py's P-256 key decoding
and panel identifier, and release-record-vectors.py's reader, origin grammar,
release record and sites, which it rebuilds from site-directory.json before
writing anything, as that generator does.

Every key is a P-256 point from a labelled test secret and every address a
SHA-256 prefix of a label, so any implementation can reproduce each encoding.

Usage: python3 -I packages/crypto/scripts/deployment-record-vectors.py <vectors-dir>
(reads site-directory.json from it and writes deployment-record.json beside it)
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


tv = _load("trustee_vectors", "trustee-vectors.py")
rr = _load("release_record_vectors", "release-record-vectors.py")
sha256, h, u8, u32, u64, var, lst = rr.sha256, rr.h, rr.u8, rr.u32, rr.u64, rr.var, rr.lst
DecodeError, Reader = rr.DecodeError, rr.Reader

RECORD_TYPE = 0x0020
VERSION = 1
TAG = b"abolish/v1/deployment"

MAX_GAME_TYPES = 8
MAX_REGISTRARS = 16
MAX_PANELS = 8
MAX_SEATS = 16
MAX_GROUPS = 64
MAX_ORIGINS = 4
MAX_ORIGIN = 267
MAX_RP_ID = 253
MAX_SEQUENCER_DRIFT = 1800

ORIGIN_LISTS = ["api", "l2_rpc", "l1_rpc"]
RP_IDS = ["backup_rp_id", "account_rp_id"]


def deployment_hash(encoding):
    return sha256(rr.ds(TAG, encoding))


# --- Encoding ----------------------------------------------------------------


def enc_panel(p):
    return u8(p["kind"]) + u8(p["threshold"]) + lst(p["seats"], lambda s: s["key"] + u8(1 if s["ours"] else 0))


def enc_group(g):
    return u64(g["group_id"]) + u8(g["tier"]) + u8(1 if g["self_paid"] else 0) + u32(g["region"])


def encode(d, record_type=RECORD_TYPE, version=VERSION):
    return b"".join(
        [
            rr.u16(record_type),
            u8(version),
            u64(d["l1_chain_id"]),
            u64(d["l2_chain_id"]),
            d["election_registry"],
            d["board"],
            d["trustee_registry"],
            d["group_registry"],
            u64(d["l2_from_block"]),
            u64(d["l2_max_sequencer_drift"]),
            d["l1_anchor"],
            d["l1_relay"],
            d["l1_portal"],
            lst(d["dispute_game_types"], u32),
            u64(d["anchor_epoch"]),
            u64(d["anchor_period"]),
            u64(d["anchor_deadline"]),
            d["anchor_authority"],
            d["contracts_commit"],
            u8(d["registrar_threshold"]),
            lst(d["registrars"], lambda a: a),
            d["initial_panel"],
            lst(d["panels"], enc_panel),
            lst(d["groups"], enc_group),
            *[lst(d[name], var) for name in ORIGIN_LISTS],
            var(d["backup_rp_id"]),
            u8(1 if d["backups"] else 0),
            var(d["account_rp_id"]),
            d["membership_zkey_sha256"],
            d["membership_wasm_sha256"],
        ]
    )


def decode(b):
    r = Reader(b)
    if r.int(2) != RECORD_TYPE:
        raise DecodeError("unknown-record-type")
    if r.int(1) != VERSION:
        raise DecodeError("unknown-version")
    d = {
        "l1_chain_id": r.int(8),
        "l2_chain_id": r.int(8),
        "election_registry": r.take(20),
        "board": r.take(20),
        "trustee_registry": r.take(20),
        "group_registry": r.take(20),
        "l2_from_block": r.int(8),
        "l2_max_sequencer_drift": r.int(8),
        "l1_anchor": r.take(20),
        "l1_relay": r.take(20),
        "l1_portal": r.take(20),
        "dispute_game_types": r.lst(MAX_GAME_TYPES, lambda r: r.int(4)),
        "anchor_epoch": r.int(8),
        "anchor_period": r.int(8),
        "anchor_deadline": r.int(8),
        "anchor_authority": r.take(20),
        "contracts_commit": r.take(20),
        "registrar_threshold": r.int(1),
        "registrars": r.lst(MAX_REGISTRARS, lambda r: r.take(20)),
        "initial_panel": r.take(32),
        "panels": r.lst(
            MAX_PANELS,
            lambda r: {
                "kind": r.enum({1, 2}),
                "threshold": r.int(1),
                "seats": r.lst(MAX_SEATS, lambda r: {"key": r.take(33), "ours": r.enum({0, 1}) == 1}),
            },
        ),
        "groups": r.lst(
            MAX_GROUPS,
            lambda r: {"group_id": r.int(8), "tier": r.enum({0, 1}), "self_paid": r.enum({0, 1}) == 1, "region": r.int(4)},
        ),
    }
    for name in ORIGIN_LISTS:
        d[name] = r.lst(MAX_ORIGINS, lambda r: r.var(MAX_ORIGIN))
    d["backup_rp_id"] = r.var(MAX_RP_ID)
    d["backups"] = r.enum({0, 1}) == 1
    d["account_rp_id"] = r.var(MAX_RP_ID)
    d["membership_zkey_sha256"] = r.take(32)
    d["membership_wasm_sha256"] = r.take(32)
    if r.at != len(b):
        raise DecodeError("trailing-bytes")
    return d


# --- Well-formedness, from docs/spec/deployment.md ---------------------------

ZERO = bytes(20)
PANEL_RULES = ["panel-threshold", "panel-key", "panel-duplicate-key", "panel-kind"]
ORIGIN_RULES = ["origin", "origin-order", "origin-missing"]
RULES = [
    "chain-id",
    "address",
    "clock",
    "drift",
    "game-types",
    "registrar-size",
    "registrar-threshold",
    "registrar-order",
    "panels-empty",
    *PANEL_RULES,
    "panel-order",
    "initial-panel",
    "groups-empty",
    "group-self-paid",
    "group-order",
    "group-repeated",
    "group-region",
    *ORIGIN_RULES,
    "origin-shared",
    "rp-id",
    "rp-id-shared",
]
PAIR_RULES = ["deployment-hash", "prover-files", "backup-origin", "challenge-rp"]


def distinct(xs):
    return len(set(xs)) == len(xs)


def panel_id(p):
    return tv.panel_id(p["threshold"], [s["key"] for s in p["seats"]])


def host_ok(x):
    # An origin's host: the origin grammar with nothing after the host.
    return b":" not in x and rr.origin_ok(b"https://" + x)


def under(a, b):
    """Whether host a is b or a subdomain of it."""
    return a == b or a.endswith(b"." + b)


def ill_formed(d):
    """The first well-formedness rule the record breaks, in the spec's order, with where, or None."""
    l2 = [d["election_registry"], d["board"], d["trustee_registry"], d["group_registry"]]
    l1 = [d["l1_anchor"], d["l1_relay"], d["l1_portal"], d["anchor_authority"]]
    n = len(d["registrars"])
    head = [
        ("chain-id", 0 in (d["l1_chain_id"], d["l2_chain_id"]) or d["l1_chain_id"] == d["l2_chain_id"]),
        ("address", ZERO in l2 + l1 or not distinct(l2) or not distinct(l1)),
        ("clock", d["anchor_period"] == 0 or d["anchor_deadline"] == 0),
        ("drift", not 1 <= d["l2_max_sequencer_drift"] <= MAX_SEQUENCER_DRIFT),
        ("game-types", not d["dispute_game_types"] or not rr.ascending(d["dispute_game_types"])),
        ("registrar-size", n < 2),
        ("registrar-threshold", not 2 <= d["registrar_threshold"] <= n),
        ("registrar-order", ZERO in d["registrars"] or not rr.ascending(d["registrars"])),
        ("panels-empty", not d["panels"]),
    ]
    for code, broken in head:
        if broken:
            return code, {}
    for i, p in enumerate(d["panels"]):
        keys = [s["key"] for s in p["seats"]]
        checks = [
            ("panel-threshold", not 2 <= p["threshold"] <= len(p["seats"])),
            ("panel-key", any(tv.decompress(k) is None for k in keys)),
            ("panel-duplicate-key", not distinct(keys)),
            ("panel-kind", p["kind"] == 1 and sum(s["ours"] for s in p["seats"]) > 1),
        ]
        assert [c for c, _ in checks] == PANEL_RULES
        for code, broken in checks:
            if broken:
                return code, {"panel": i}
    ids = [panel_id(p) for p in d["panels"]]
    if not rr.ascending(ids):
        return "panel-order", {}
    if d["initial_panel"] not in ids:
        return "initial-panel", {}
    groups = d["groups"]
    if not groups:
        return "groups-empty", {}
    for i, g in enumerate(groups):
        if g["self_paid"] and g["tier"] != 0:
            return "group-self-paid", {"group": i}
    if not rr.ascending([g["group_id"] for g in groups]):
        return "group-order", {}
    kinds = [(g["region"], g["tier"], g["self_paid"]) for g in groups]
    if not distinct(kinds):
        return "group-repeated", {}
    for region in {g["region"] for g in groups}:
        if (region, 0, False) not in kinds or (region, 0, True) not in kinds:
            return "group-region", {}
    for name in ORIGIN_LISTS:
        origins = d[name]
        checks = [
            ("origin", any(not rr.origin_ok(o) for o in origins)),
            ("origin-order", not rr.ascending(origins)),
            ("origin-missing", not origins),
        ]
        assert [c for c, _ in checks] == ORIGIN_RULES
        for code, broken in checks:
            if broken:
                return code, {"list": name}
    every = [o for name in ORIGIN_LISTS for o in d[name]]
    if not distinct(every):
        return "origin-shared", {}
    for name in RP_IDS:
        if not host_ok(d[name]):
            return "rp-id", {"field": name}
    if under(d["backup_rp_id"], d["account_rp_id"]) or under(d["account_rp_id"], d["backup_rp_id"]):
        return "rp-id-shared", {}
    return None


def inconsistent(release, d):
    """The first rule of Against its release the pair breaks, or None; both records well formed."""
    assert rr.ill_formed(release) is None and ill_formed(d) is None
    ballot = release["sites"][0]
    hashes = {f["sha256"] for f in ballot["files"]}
    challenge = [s for s in release["sites"] if s["kind"] == 2]
    host = challenge[0]["origins"][0][len(b"https://") :].partition(b":")[0] if challenge else None
    checks = [
        ("deployment-hash", release["deployment_hash"] != deployment_hash(encode(d))),
        ("prover-files", d["membership_zkey_sha256"] not in hashes or d["membership_wasm_sha256"] not in hashes),
        ("backup-origin", d["backups"] and b"https://" + d["backup_rp_id"] not in ballot["origins"]),
        ("challenge-rp", host is not None and any(under(host, d[name]) for name in RP_IDS)),
    ]
    assert [c for c, _ in checks] == PAIR_RULES
    for code, broken in checks:
        if broken:
            return code
    return None


# --- Vectors -----------------------------------------------------------------

SEPOLIA = 11155111
BASE_SEPOLIA = 84532


def address(label):
    return sha256(b"deployment address " + label.encode())[:20]


def key(label):
    return tv.compress(tv.mul(tv.secret(label.encode()), tv.G))


def panel(kind, k, label, n, ours):
    return {"kind": kind, "threshold": k, "seats": [{"key": key(f"{label} {i}"), "ours": i in ours} for i in range(1, n + 1)]}


def by_id(panels):
    return sorted(panels, key=panel_id)


def group(group_id, tier, self_paid, region):
    return {"group_id": group_id, "tier": tier, "self_paid": self_paid, "region": region}


def typical(zkey, wasm):
    transitional = panel(2, 4, "transitional", 7, set(range(1, 8)))
    panels = by_id([transitional])
    return {
        "l1_chain_id": SEPOLIA,
        "l2_chain_id": BASE_SEPOLIA,
        "election_registry": address("election registry"),
        "board": address("board"),
        "trustee_registry": address("trustee registry"),
        "group_registry": address("group registry"),
        "l2_from_block": 25_000_000,
        "l2_max_sequencer_drift": 1800,
        "l1_anchor": address("l1 anchor"),
        "l1_relay": address("l1 relay"),
        "l1_portal": address("l1 portal"),
        "dispute_game_types": [0, 1],
        "anchor_epoch": 1_767_225_600,
        "anchor_period": 3600,
        "anchor_deadline": 43_200,
        "anchor_authority": address("anchoring safe"),
        "contracts_commit": sha256(b"contracts commit typical")[:20],
        "registrar_threshold": 2,
        "registrars": sorted(address(f"registrar {i}") for i in range(3)),
        "initial_panel": panel_id(panels[0]),
        "panels": panels,
        "groups": [group(0, 0, False, 0), group(1, 0, True, 0), group(2, 1, False, 0)],
        "api": [b"https://api.abolish.us"],
        "l2_rpc": [b"https://base-sepolia-rpc.publicnode.com", b"https://sepolia.base.org"],
        "l1_rpc": [b"https://ethereum-sepolia-rpc.publicnode.com"],
        "backup_rp_id": b"ballot-staging.up.railway.app",
        "backups": True,
        "account_rp_id": b"abolish.us",
        "membership_zkey_sha256": zkey,
        "membership_wasm_sha256": wasm,
    }


def clone(d):
    return json.loads(json.dumps(d, default=lambda b: {"__b": b.hex()}), object_hook=lambda x: bytes.fromhex(x["__b"]) if "__b" in x else x)


def value_json(d):
    out = {}
    for name, v in d.items():
        if name == "panels":
            out[name] = [
                {"kind": str(p["kind"]), "threshold": str(p["threshold"]), "seats": [{"key": h(s["key"]), "ours": s["ours"]} for s in p["seats"]]}
                for p in v
            ]
        elif name == "groups":
            out[name] = [
                {"group_id": str(g["group_id"]), "tier": str(g["tier"]), "self_paid": g["self_paid"], "region": str(g["region"])} for g in v
            ]
        elif name == "dispute_game_types":
            out[name] = [str(x) for x in v]
        elif name in ("registrars", *ORIGIN_LISTS):
            out[name] = [h(x) for x in v]
        elif isinstance(v, bool):
            out[name] = v
        elif isinstance(v, int):
            out[name] = str(v)
        else:
            out[name] = h(v)
    return out


def types():
    def b(n=None, m=None):
        return {"kind": "bytes", "length": n} if n is not None else {"kind": "bytes", "max": m}

    def origins():
        return {"kind": "list", "max": MAX_ORIGINS, "of": b(m=MAX_ORIGIN)}

    seat = {"kind": "struct", "fields": [{"name": "key", "type": b(n=33)}, {"name": "ours", "type": {"kind": "bool"}}]}
    return {
        "panel": {
            "kind": "struct",
            "fields": [
                {"name": "kind", "type": {"kind": "enum8", "values": ["1", "2"]}},
                {"name": "threshold", "type": {"kind": "u8"}},
                {"name": "seats", "type": {"kind": "list", "max": MAX_SEATS, "of": seat}},
            ],
        },
        "group": {
            "kind": "struct",
            "fields": [
                {"name": "group_id", "type": {"kind": "u64"}},
                {"name": "tier", "type": {"kind": "enum8", "values": ["0", "1"]}},
                {"name": "self_paid", "type": {"kind": "bool"}},
                {"name": "region", "type": {"kind": "u32"}},
            ],
        },
        "deployment": {
            "kind": "record",
            "recordType": f"{RECORD_TYPE:04x}",
            "version": VERSION,
            "fields": [
                {"name": "l1_chain_id", "type": {"kind": "u64"}},
                {"name": "l2_chain_id", "type": {"kind": "u64"}},
                {"name": "election_registry", "type": b(n=20)},
                {"name": "board", "type": b(n=20)},
                {"name": "trustee_registry", "type": b(n=20)},
                {"name": "group_registry", "type": b(n=20)},
                {"name": "l2_from_block", "type": {"kind": "u64"}},
                {"name": "l2_max_sequencer_drift", "type": {"kind": "u64"}},
                {"name": "l1_anchor", "type": b(n=20)},
                {"name": "l1_relay", "type": b(n=20)},
                {"name": "l1_portal", "type": b(n=20)},
                {"name": "dispute_game_types", "type": {"kind": "list", "max": MAX_GAME_TYPES, "of": {"kind": "u32"}}},
                {"name": "anchor_epoch", "type": {"kind": "u64"}},
                {"name": "anchor_period", "type": {"kind": "u64"}},
                {"name": "anchor_deadline", "type": {"kind": "u64"}},
                {"name": "anchor_authority", "type": b(n=20)},
                {"name": "contracts_commit", "type": b(n=20)},
                {"name": "registrar_threshold", "type": {"kind": "u8"}},
                {"name": "registrars", "type": {"kind": "list", "max": MAX_REGISTRARS, "of": b(n=20)}},
                {"name": "initial_panel", "type": b(n=32)},
                {"name": "panels", "type": {"kind": "list", "max": MAX_PANELS, "of": {"kind": "ref", "name": "panel"}}},
                {"name": "groups", "type": {"kind": "list", "max": MAX_GROUPS, "of": {"kind": "ref", "name": "group"}}},
                {"name": "api", "type": origins()},
                {"name": "l2_rpc", "type": origins()},
                {"name": "l1_rpc", "type": origins()},
                {"name": "backup_rp_id", "type": b(m=MAX_RP_ID)},
                {"name": "backups", "type": {"kind": "bool"}},
                {"name": "account_rp_id", "type": b(m=MAX_RP_ID)},
                {"name": "membership_zkey_sha256", "type": b(n=32)},
                {"name": "membership_wasm_sha256", "type": b(n=32)},
            ],
        },
    }


def boundaries(base):
    d = clone(base)
    d["l1_chain_id"] = 2**64 - 1
    d["l2_chain_id"] = 1
    d["l2_from_block"] = 2**64 - 1
    d["l2_max_sequencer_drift"] = MAX_SEQUENCER_DRIFT
    d["dispute_game_types"] = [0, 1, 2, 3, 4, 5, 6, 2**32 - 1]
    d["anchor_epoch"] = 2**64 - 1
    d["anchor_period"] = 1
    d["anchor_deadline"] = 2**64 - 1
    d["registrars"] = sorted(address(f"registrar {i}") for i in range(MAX_REGISTRARS))
    d["registrar_threshold"] = MAX_REGISTRARS
    # Eight panels of sixteen seats; one independent with exactly one seat ours.
    panels = [panel(1, 16, "independent", 16, {16})] + [panel(2, 2, f"wide {j}", 16, set()) for j in range(7)]
    d["panels"] = by_id(panels)
    d["initial_panel"] = panel_id(d["panels"][-1])
    # Twenty regions with all three published groups and two with only the
    # Tier 0 pair: sixty-four groups, the last at the largest group_id.
    kinds = [(region, tier, self_paid) for region in range(20) for tier, self_paid in [(0, False), (0, True), (1, False)]]
    kinds += [(20, 0, False), (20, 0, True), (2**32 - 1, 0, False), (2**32 - 1, 0, True)]
    d["groups"] = [group(i, tier, self_paid, region) for i, (region, tier, self_paid) in enumerate(kinds)]
    d["groups"][-1]["group_id"] = 2**64 - 1
    host = ".".join(["a" * 63, "b" * 63, "c" * 63, "d" * 61])
    d["api"] = sorted([f"https://{host}:65535".encode(), b"https://api.abolish.us", b"https://api.x.y:1", b"https://xn--bcher-kva.example"])
    d["l2_rpc"] = sorted([b"https://l2-a.example", b"https://l2-b.example", b"https://l2-c.example", b"https://l2-d.example"])
    d["l1_rpc"] = sorted([b"https://l1-a.example", b"https://l1-b.example", b"https://l1-c.example", b"https://l1-d.example"])
    d["backup_rp_id"] = host.encode()
    d["account_rp_id"] = b"a.b"
    d["backups"] = False
    return d


def ill_formed_cases(base):
    def set_(field, value):
        return lambda d: d.__setitem__(field, value)

    def seat(i, j, field, value):
        return lambda d: d["panels"][i]["seats"][j].__setitem__(field, value)

    k1, k2 = key("transitional 1"), key("transitional 2")
    # A 33-byte string that isn't a key: an x with no point, a bad prefix, x ≥ p.
    no_point = next(b for b in (bytes([2]) + i.to_bytes(32, "big") for i in range(1, 100)) if tv.decompress(b) is None)
    other = by_id([panel(2, 2, "other", 3, set())])[0]

    def two_panels(d):
        d["panels"] = by_id([d["panels"][0], clone(other)])

    def swapped_panels(d):
        two_panels(d)
        d["panels"].reverse()

    P0, P1 = {"panel": 0}, {"panel": 1}
    G = lambda i: {"group": i}  # noqa: E731
    API, L2, L1 = {"list": "api"}, {"list": "l2_rpc"}, {"list": "l1_rpc"}
    BK, AC = {"field": "backup_rp_id"}, {"field": "account_rp_id"}
    groups = lambda gs: set_("groups", [group(*g) for g in gs])  # noqa: E731
    return [
        ("l1-chain-zero", "An L1 chain ID of 0", set_("l1_chain_id", 0), "chain-id", {}),
        ("l2-chain-zero", "An L2 chain ID of 0", set_("l2_chain_id", 0), "chain-id", {}),
        ("chains-equal", "The same chain for L1 and L2", set_("l2_chain_id", SEPOLIA), "chain-id", {}),
        ("board-zero", "A zero board address", set_("board", ZERO), "address", {}),
        ("authority-zero", "A zero anchoring authority", set_("anchor_authority", ZERO), "address", {}),
        ("l2-repeated", "The board at the group registry's address", lambda d: d.__setitem__("board", d["group_registry"]), "address", {}),
        ("l1-repeated", "The relay at the portal's address", lambda d: d.__setitem__("l1_relay", d["l1_portal"]), "address", {}),
        ("authority-is-anchor", "The anchoring Safe at the anchor's address", lambda d: d.__setitem__("anchor_authority", d["l1_anchor"]), "address", {}),
        ("period-zero", "An anchoring period of 0", set_("anchor_period", 0), "clock", {}),
        ("deadline-zero", "An anchoring deadline of 0", set_("anchor_deadline", 0), "clock", {}),
        ("drift-zero", "A sequencer drift of 0", set_("l2_max_sequencer_drift", 0), "drift", {}),
        ("drift-high", "A sequencer drift one second over MAX_SEQUENCER_DRIFT", set_("l2_max_sequencer_drift", MAX_SEQUENCER_DRIFT + 1), "drift", {}),
        ("game-types-empty", "No dispute-game type", set_("dispute_game_types", []), "game-types", {}),
        ("game-types-unsorted", "Dispute-game types out of order", set_("dispute_game_types", [1, 0]), "game-types", {}),
        ("game-types-repeated", "A dispute-game type listed twice", set_("dispute_game_types", [0, 0]), "game-types", {}),
        ("registrars-one", "One registrar", lambda d: (d.__setitem__("registrars", d["registrars"][:1]), d.__setitem__("registrar_threshold", 1)), "registrar-size", {}),
        ("registrars-none", "No registrar", lambda d: d.__setitem__("registrars", []), "registrar-size", {}),
        ("registrar-threshold-one", "A registrar threshold of 1", set_("registrar_threshold", 1), "registrar-threshold", {}),
        ("registrar-threshold-high", "A registrar threshold above the number of registrars", set_("registrar_threshold", 4), "registrar-threshold", {}),
        ("registrars-unsorted", "Registrars out of order", lambda d: d["registrars"].reverse(), "registrar-order", {}),
        ("registrars-repeated", "A registrar listed twice", lambda d: d["registrars"].__setitem__(1, d["registrars"][0]), "registrar-order", {}),
        ("registrar-zero", "A zero registrar", lambda d: d["registrars"].__setitem__(0, ZERO), "registrar-order", {}),
        ("panels-empty", "No panel", set_("panels", []), "panels-empty", {}),
        ("panel-threshold-one", "A panel of threshold 1", lambda d: d["panels"][0].__setitem__("threshold", 1), "panel-threshold", P0),
        ("panel-threshold-high", "A panel threshold above its seats", lambda d: d["panels"][0].__setitem__("threshold", 8), "panel-threshold", P0),
        ("panel-no-seats", "A panel with no seat", lambda d: d["panels"][0].__setitem__("seats", []), "panel-threshold", P0),
        ("panel-key-no-point", "A seat key whose x is on no point", seat(0, 2, "key", no_point), "panel-key", P0),
        ("panel-key-prefix", "A seat key with an uncompressed prefix", seat(0, 0, "key", bytes([4]) + k1[1:]), "panel-key", P0),
        ("panel-key-x-high", "A seat key with x at the field prime", seat(0, 0, "key", bytes([2]) + tv.P.to_bytes(32, "big")), "panel-key", P0),
        ("panel-duplicate-key", "A key in two seats", seat(0, 1, "key", k1), "panel-duplicate-key", P0),
        ("panel-kind", "An independent panel with two seats ours", lambda d: d["panels"][0].__setitem__("kind", 1), "panel-kind", P0),
        (
            "panel-second",
            "A bad key in the second panel",
            lambda d: (two_panels(d), d["panels"][1]["seats"][0].__setitem__("key", no_point)),
            "panel-key",
            P1,
        ),
        ("panels-unsorted", "Panels out of panel_id order", swapped_panels, "panel-order", {}),
        ("panels-repeated", "A panel listed twice", lambda d: d.__setitem__("panels", [d["panels"][0], d["panels"][0]]), "panel-order", {}),
        ("initial-panel-unlisted", "An initial panel that isn't listed", lambda d: d.__setitem__("initial_panel", panel_id(other)), "initial-panel", {}),
        ("initial-panel-reordered", "The initial panel's identifier with two seats swapped", lambda d: d.__setitem__("initial_panel", tv.panel_id(4, [k2, k1] + [s["key"] for s in d["panels"][0]["seats"][2:]])), "initial-panel", {}),
        ("groups-empty", "No published group", set_("groups", []), "groups-empty", {}),
        ("group-self-paid-tier1", "A self-paid Tier 1 group", groups([(0, 0, False, 0), (1, 0, True, 0), (2, 1, True, 0)]), "group-self-paid", G(2)),
        ("groups-unsorted", "Groups out of group_id order", groups([(1, 0, False, 0), (0, 0, True, 0)]), "group-order", {}),
        ("groups-same-id", "Two groups with one group_id", groups([(0, 0, False, 0), (0, 0, True, 0)]), "group-order", {}),
        ("groups-two-signed", "Two signed Tier 0 groups for one region", groups([(0, 0, False, 0), (1, 0, True, 0), (2, 0, False, 0)]), "group-repeated", {}),
        ("groups-two-tier1", "Two Tier 1 groups for one region", groups([(0, 0, False, 0), (1, 0, True, 0), (2, 1, False, 0), (3, 1, False, 0)]), "group-repeated", {}),
        ("group-region-no-self-paid", "A region with no self-paid group", groups([(0, 0, False, 0)]), "group-region", {}),
        ("group-region-no-signed", "A region with only a self-paid group", groups([(0, 0, True, 0)]), "group-region", {}),
        ("group-region-tier1-only", "A second region with only a Tier 1 group", groups([(0, 0, False, 0), (1, 0, True, 0), (2, 1, False, 7)]), "group-region", {}),
        ("api-http", "An http API origin", set_("api", [b"http://api.abolish.us"]), "origin", API),
        ("api-path", "An API origin with a path", set_("api", [b"https://api.abolish.us/v1"]), "origin", API),
        ("api-default-port", "An API origin naming port 443", set_("api", [b"https://api.abolish.us:443"]), "origin", API),
        ("api-upper", "An upper-case API host", set_("api", [b"https://API.abolish.us"]), "origin", API),
        ("l2-ipv4", "An L2 endpoint at an IPv4 address", set_("l2_rpc", [b"https://127.0.0.1"]), "origin", L2),
        ("l1-trailing-dot", "An L1 endpoint ending in a dot", set_("l1_rpc", [b"https://rpc.example."]), "origin", L1),
        ("l2-unsorted", "L2 endpoints out of order", lambda d: d["l2_rpc"].reverse(), "origin-order", L2),
        ("l1-rpc-repeated", "An L1 endpoint listed twice", lambda d: d.__setitem__("l1_rpc", d["l1_rpc"] * 2), "origin-order", L1),
        ("api-missing", "No API origin", set_("api", []), "origin-missing", API),
        ("l2-missing", "No L2 endpoint", set_("l2_rpc", []), "origin-missing", L2),
        ("l1-missing", "No L1 endpoint", set_("l1_rpc", []), "origin-missing", L1),
        ("origin-shared", "One origin as both an L2 and an L1 endpoint", set_("l1_rpc", [b"https://sepolia.base.org"]), "origin-shared", {}),
        ("api-is-rpc", "The API's origin also an L1 endpoint", set_("l1_rpc", [b"https://api.abolish.us"]), "origin-shared", {}),
        ("rp-id-empty", "An empty backup RP ID", set_("backup_rp_id", b""), "rp-id", BK),
        ("rp-id-port", "A backup RP ID with a port", set_("backup_rp_id", b"ballot.example:8443"), "rp-id", BK),
        ("rp-id-scheme", "A backup RP ID with a scheme", set_("backup_rp_id", b"https://ballot.example"), "rp-id", BK),
        ("rp-id-one-label", "An account RP ID of one label", set_("account_rp_id", b"localhost"), "rp-id", AC),
        ("rp-id-upper", "An upper-case account RP ID", set_("account_rp_id", b"Abolish.us"), "rp-id", AC),
        ("rp-id-same", "One RP ID for the backup and the accounts", set_("backup_rp_id", b"abolish.us"), "rp-id-shared", {}),
        ("rp-id-backup-under", "The backup's RP ID under the accounts'", set_("backup_rp_id", b"ballot.abolish.us"), "rp-id-shared", {}),
        ("rp-id-account-under", "The accounts' RP ID under the backup's", set_("account_rp_id", b"www.ballot-staging.up.railway.app"), "rp-id-shared", {}),
        ("rp-id-suffix-only", "A backup RP ID that only ends in the accounts' bytes: not under it", set_("backup_rp_id", b"notabolish.us"), None, {}),
        ("rule-order", "A bad chain ID and no panel: chain-id comes first", lambda d: (d.__setitem__("l1_chain_id", 0), d.__setitem__("panels", [])), "chain-id", {}),
        (
            "rule-order-panels",
            "A key in two seats of the first panel and a threshold of 1 in the second: the first panel's comes first",
            lambda d: (two_panels(d), d["panels"][0]["seats"][1].__setitem__("key", d["panels"][0]["seats"][0]["key"]), d["panels"][1].__setitem__("threshold", 1)),
            "panel-duplicate-key",
            P0,
        ),
        ("rule-order-origins", "A missing L1 endpoint and an http API origin: the API's list comes first", lambda d: (d.__setitem__("l1_rpc", []), d.__setitem__("api", [b"http://x.y"])), "origin", API),
        ("rule-order-groups", "Groups out of order and a self-paid Tier 1 group: group-self-paid comes first", groups([(1, 0, False, 0), (0, 1, True, 0)]), "group-self-paid", G(1)),
    ]


def decode_cases(d):
    enc = encode(d)
    header = 3
    games = header + 8 + 8 + 80 + 8 + 8 + 60
    after_games = games + 4 + 4 * len(d["dispute_game_types"])
    registrars = after_games + 24 + 20 + 20 + 1
    panels = registrars + 4 + 20 * len(d["registrars"]) + 32
    panel0 = panels + 4
    seats0 = panel0 + 2
    ours0 = seats0 + 4 + 33
    groups_at = panels + 4 + sum(len(enc_panel(p)) for p in d["panels"])
    tier0 = groups_at + 4 + 8
    api = groups_at + 4 + 14 * len(d["groups"])
    backup = api + sum(len(lst(d[name], var)) for name in ORIGIN_LISTS)
    backups = backup + 4 + len(d["backup_rp_id"])
    account = backups + 1

    def at(i, b):
        return enc[:i] + b + enc[i + len(b) :]

    return [
        ("truncated-header", "Two bytes", enc[:2], "truncated"),
        ("truncated-fixed", "Cut inside the board's address", enc[: header + 16 + 30], "truncated"),
        ("truncated-last-byte", "The last byte missing", enc[:-1], "truncated"),
        ("trailing-byte", "A byte after the last field", enc + b"\x00", "trailing-bytes"),
        ("unknown-version", "Version 2", at(2, b"\x02"), "unknown-version"),
        ("version-zero", "Version 0", at(2, b"\x00"), "unknown-version"),
        ("release-type", "The release record's type", at(0, b"\x00\x1f"), "unknown-record-type"),
        ("test-type", "A test-range type", at(0, b"\xff\x00"), "unknown-record-type"),
        ("game-types-over-max", "Nine dispute-game types", at(games, u32(9)), "length-over-max"),
        ("registrars-over-max", "Seventeen registrars", at(registrars, u32(17)), "length-over-max"),
        ("panels-over-max", "Nine panels", at(panels, u32(9)), "length-over-max"),
        ("panel-kind-zero", "Panel kind 0", at(panel0, b"\x00"), "invalid-enum"),
        ("panel-kind-three", "Panel kind 3", at(panel0, b"\x03"), "invalid-enum"),
        ("seats-over-max", "Seventeen seats", at(seats0, u32(17)), "length-over-max"),
        ("ours-two", "A seat's ours byte of 2", at(ours0, b"\x02"), "invalid-enum"),
        ("groups-over-max", "Sixty-five groups", at(groups_at, u32(65)), "length-over-max"),
        ("tier-two", "Group tier 2", at(tier0, b"\x02"), "invalid-enum"),
        ("self-paid-two", "A self_paid byte of 2", at(tier0 + 1, b"\x02"), "invalid-enum"),
        ("api-over-max", "Five API origins", at(api, u32(5)), "length-over-max"),
        ("origin-over-max", "An origin of 268 bytes", at(api + 4, u32(268)), "length-over-max"),
        ("origin-past-end", "An origin longer than the input", enc[: api + 4] + u32(267) + b"https://", "truncated"),
        ("rp-id-over-max", "A 254-byte backup RP ID", at(backup, u32(254)), "length-over-max"),
        ("backups-two", "A backups byte of 2", at(backups, b"\x02"), "invalid-enum"),
        ("account-rp-id-over-max", "A 254-byte account RP ID", at(account, u32(254)), "length-over-max"),
    ]


def pair_cases(site_vectors, d, zkey, wasm):
    def ballot(origins=("https://abolishus.eth.limo", "https://ballot-staging.up.railway.app")):
        return rr.site_from(site_vectors, "ballot-like", 1, origins, True, rr.BALLOT_HEADERS)

    def challenge(origin="https://challenge-staging.up.railway.app"):
        return rr.site_from(site_vectors, "challenge-like", 2, (origin,), False, rr.CHALLENGE_HEADERS)

    def release(dep, sites, label):
        r = rr.strip(rr.base(sites, 0, bytes(32), label))
        r["deployment_hash"] = deployment_hash(encode(dep))
        return r

    no_backups = dict(clone(d), backups=False)
    other_zkey = dict(clone(d), membership_zkey_sha256=sha256(b"another proving key"))
    swapped = dict(clone(d), membership_zkey_sha256=wasm, membership_wasm_sha256=zkey)
    cases = [
        ("consistent", "A release and the deployment it names", release(d, [ballot(), challenge()], "pair"), d, None),
        ("consistent-ballot-only", "A release with no challenge page", release(d, [ballot()], "pair-ballot"), d, None),
        ("consistent-no-backups", "No backups offered, at origins without the RP ID's host", release(no_backups, [ballot(("https://abolishus.eth.limo",))], "pair-no-backups"), no_backups, None),
        ("consistent-swapped-prover", "The key's and calculator's hashes swapped: each is still a file of the site", release(swapped, [ballot()], "pair-swapped"), swapped, None),
    ]
    other_hash = release(d, [ballot(), challenge()], "pair-other")
    other_hash["deployment_hash"] = deployment_hash(encode(no_backups))
    cases += [
        ("deployment-hash", "A release naming another deployment's hash", other_hash, d, "deployment-hash"),
        ("deployment-hash-zero", "A release naming a zero deployment hash", dict(release(d, [ballot()], "pair-zero"), deployment_hash=bytes(32)), d, "deployment-hash"),
        ("prover-files", "A deployment pinning a proving key the release doesn't serve", release(other_zkey, [ballot()], "pair-zkey"), other_zkey, "prover-files"),
        ("backup-origin", "Backups offered, but the ballot site isn't at the RP ID's host", release(d, [ballot(("https://abolishus.eth.limo",))], "pair-backup"), d, "backup-origin"),
        ("challenge-rp-backup", "The challenge page under the backup's RP ID", release(d, [ballot(), challenge("https://c.ballot-staging.up.railway.app")], "pair-challenge"), d, "challenge-rp"),
        ("challenge-rp-account", "The challenge page at the accounts' RP ID itself", release(d, [ballot(), challenge("https://abolish.us")], "pair-account"), d, "challenge-rp"),
        ("challenge-rp-port", "The challenge page under the accounts' RP ID, with a port", release(d, [ballot(), challenge("https://challenge.abolish.us:8443")], "pair-port"), d, "challenge-rp"),
        ("challenge-rp-suffix-only", "A challenge host that only ends in the RP ID's bytes: not under it", release(d, [ballot(), challenge("https://notabolish.us")], "pair-suffix"), d, None),
        ("pair-rule-order", "Another deployment's hash and no prover files: deployment-hash comes first", release(no_backups, [ballot()], "pair-order"), other_zkey, "deployment-hash"),
    ]
    return cases


def main():
    vectors_dir = pathlib.Path(sys.argv[1])
    site_vectors = json.loads((vectors_dir / "site-directory.json").read_text())["vectors"]
    rr.check_sites(site_vectors)

    ballot_like = rr.site_from(site_vectors, "ballot-like", 1, (), True, [])
    by_path = {f["path"]: f["sha256"] for f in ballot_like["files"]}
    # site-directory.json's ballot site has a proving key but no witness
    # calculator, so its worker script stands in for one.
    zkey = by_path[b"assets/semaphore-32-0123.zkey"]
    wasm = by_path[b"assets/worker-77b0.js"]

    base = typical(zkey, wasm)
    independent = clone(base)
    independent["panels"] = by_id([base["panels"][0], panel(1, 4, "independent", 7, {7})])
    bounds = boundaries(base)
    valid = [
        ("typical", "A deployment on Sepolia and Base Sepolia with the transitional panel, one region and backups at the client's host", base),
        ("independent-panel", "A transitional panel and an independent one with exactly one seat ours", independent),
        ("boundaries", "Every list at its maximum (eight panels of sixteen seats, sixteen registrars, four origins per list), u64 fields at their largest, a 253-byte RP ID", bounds),
    ]
    assert len(bounds["groups"]) == MAX_GROUPS

    out_vectors = []
    for vid, description, d in valid:
        enc = encode(d)
        assert decode(enc) == d, vid
        assert ill_formed(d) is None, (vid, ill_formed(d))
        out_vectors.append(
            {
                "id": vid,
                "description": description,
                "type": {"kind": "ref", "name": "deployment"},
                "encoding": h(enc),
                "value": value_json(d),
                "deploymentHash": h(deployment_hash(enc)),
            }
        )

    cases = ill_formed_cases(base)
    for vid, description, mutate, code, where in cases:
        d = clone(base)
        mutate(d)
        enc = encode(d)
        assert decode(enc) == d, vid
        got = ill_formed(d)
        assert got == ((code, where) if code is not None else None), (vid, got, code)
        v = {
            "id": vid,
            "description": description,
            "type": {"kind": "ref", "name": "deployment"},
            "encoding": h(enc),
            "value": value_json(d),
            "deploymentHash": h(deployment_hash(enc)),
        }
        if code is not None:
            v["illFormed"] = code
            if where:
                v["illFormedAt"] = {k: str(x) for k, x in where.items()}
        out_vectors.append(v)
    assert {v["illFormed"] for v in out_vectors if "illFormed" in v} == set(RULES)

    for vid, description, enc, code in decode_cases(base):
        try:
            decode(enc)
        except DecodeError as e:
            assert str(e) == code, (vid, str(e), code)
        else:
            raise AssertionError(f"{vid} decoded")
        out_vectors.append({"id": vid, "description": description, "type": {"kind": "ref", "name": "deployment"}, "encoding": h(enc), "error": code})

    pairs = []
    for vid, description, release, d, code in pair_cases(site_vectors, base, zkey, wasm):
        got = inconsistent(release, d)
        assert got == code, (vid, got, code)
        p = {"id": vid, "description": description, "release": h(rr.encode(release)), "deployment": h(encode(d))}
        if code is not None:
            p["inconsistent"] = code
        pairs.append(p)
    assert {p["inconsistent"] for p in pairs if "inconsistent" in p} == set(PAIR_RULES)
    assert len({v["id"] for v in out_vectors}) == len(out_vectors)
    assert len({p["id"] for p in pairs}) == len(pairs)

    largest = max(len(bytes.fromhex(v["encoding"])) for v in out_vectors if "value" in v)
    out = {
        "format": "abolish-deployment-record-vectors/1",
        "title": "Deployment record: encoding, strict decoding, well-formedness, the deployment hash and the rules against its release",
        "spec": "docs/spec/deployment.md",
        "generator": (
            "packages/crypto/scripts/deployment-record-vectors.py: an independent Python implementation (standard library only) "
            "of the record, its decoder and its rules, reusing trustee-vectors.py's P-256 key decoding and panel identifier and "
            "release-record-vectors.py's release record, whose sites it rebuilds against site-directory.json first"
        ),
        "tag": TAG.decode(),
        "maxSequencerDrift": str(MAX_SEQUENCER_DRIFT),
        "largestEncoding": largest,
        "rules": RULES,
        "pairRules": PAIR_RULES,
        "types": types(),
        "vectors": out_vectors,
        "pairs": pairs,
    }
    (vectors_dir / "deployment-record.json").write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main()
