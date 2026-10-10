"""Prints docs/spec/vectors/election-definition.json and display-text.json.

Written from the tables in docs/spec/election-definition.md and
docs/spec/display-text.md alone, independently of packages/crypto, with only
the Python standard library, so the vectors check the TypeScript codecs
rather than restate them (docs/spec/vectors/README.md, Rules).

    python3 -I packages/crypto/scripts/definition-vectors.py docs/spec/vectors

then `vp check --fix` to format the JSON.
"""

import copy
import hashlib
import json
import struct as st
import sys
from pathlib import Path

R = 0x30644E72E131A029B85045B68181585D2833E84879B9709143E1F593F0000001
U64_MAX = 2**64 - 1
U32_MAX = 2**32 - 1

# --- primitive encoders (docs/spec/notation.md) -----------------------------


def u8(x):
    assert 0 <= x <= 0xFF
    return bytes([x])


def u16(x):
    assert 0 <= x <= 0xFFFF
    return st.pack(">H", x)


def u32(x):
    assert 0 <= x <= U32_MAX
    return st.pack(">I", x)


def u64(x):
    assert 0 <= x <= U64_MAX
    return st.pack(">Q", x)


def fixed(b, n):
    assert len(b) == n
    return b


def var(b, m):
    assert len(b) <= m
    return u32(len(b)) + b


def utf8(s, m):
    b = s.encode("utf-8") if isinstance(s, str) else s
    return var(b, m)


def field(x):
    assert 0 <= x < R
    return x.to_bytes(32, "big")


def lst(items, m, enc):
    assert len(items) <= m
    return u32(len(items)) + b"".join(enc(i) for i in items)


def ds(tag, m):
    t = tag.encode("ascii")
    return bytes([len(t)]) + t + m


def H(m):
    return hashlib.sha256(m).digest()


# --- type descriptors (docs/spec/vectors/README.md) -------------------------

ADDR = {"kind": "bytes", "length": 20}
HASH = {"kind": "bytes", "length": 32}
U8 = {"kind": "u8"}
U16 = {"kind": "u16"}
U32 = {"kind": "u32"}
U64 = {"kind": "u64"}


def ref(name):
    return {"kind": "ref", "name": name}


DEF_TYPES = {
    "record-pin": {
        "kind": "struct",
        "fields": [{"name": "record_type", "type": U16}, {"name": "version", "type": U8}],
    },
    "profile": {
        "kind": "struct",
        "fields": [
            {"name": "protocol_major", "type": U8},
            {"name": "pins", "type": {"kind": "list", "max": 64, "of": ref("record-pin")}},
        ],
    },
    "tier-group": {
        "kind": "struct",
        "fields": [
            {"name": "tier", "type": {"kind": "enum8", "values": ["0", "1", "2"]}},
            {"name": "group_id", "type": U64},
            {"name": "root", "type": {"kind": "field", "field": "bn254"}},
            {"name": "root_l2_block", "type": U64},
            {"name": "group_size", "type": U64},
        ],
    },
}

DEF_FIELDS = [
    ("profile", ref("profile")),
    ("election_id", HASH),
    ("l2_chain_id", U64),
    ("l1_chain_id", U64),
    ("election_registry", ADDR),
    ("board", ADDR),
    ("trustee_registry", ADDR),
    ("group_registry", ADDR),
    ("l1_anchor", ADDR),
    ("l1_relay", ADDR),
    ("election_type", {"kind": "enum8", "values": ["1", "2"]}),
    ("tally_scheme", {"kind": "enum8", "values": ["1"]}),
    ("option_count", U16),
    ("min_selections", U16),
    ("max_selections", U16),
    ("electorate", {"kind": "list", "max": 3, "of": ref("tier-group")}),
    ("membership_vk_hash", HASH),
    ("panel_id", HASH),
    ("threshold", U8),
    ("panel_size", U8),
    ("ceremony_transcript_hash", HASH),
    ("opens_at", U64),
    ("closes_at", U64),
    ("l1_inclusion_bound", U32),
    ("sequencing_window", U64),
    ("max_sequencer_drift", U64),
    ("display_text_commitment", HASH),
]

DEF_TYPES["election-definition-v1"] = {
    "kind": "record",
    "recordType": "0001",
    "version": 1,
    "fields": [{"name": n, "type": t} for n, t in DEF_FIELDS],
}

DT_TYPES = {
    "option-text": {
        "kind": "struct",
        "fields": [
            {"name": "label", "type": {"kind": "utf8", "max": 512}},
            {"name": "description", "type": {"kind": "utf8", "max": 1024}},
        ],
    },
    "translation": {
        "kind": "struct",
        "fields": [
            {"name": "language", "type": {"kind": "utf8", "max": 35}},
            {"name": "question", "type": {"kind": "utf8", "max": 1024}},
            {"name": "description", "type": {"kind": "utf8", "max": 8192}},
            {"name": "options", "type": {"kind": "list", "max": 64, "of": ref("option-text")}},
        ],
    },
    "display-text-v1": {
        "kind": "record",
        "recordType": "0009",
        "version": 1,
        "fields": [
            {"name": "salt", "type": HASH},
            {"name": "translations", "type": {"kind": "list", "max": 32, "of": ref("translation")}},
        ],
    },
}

# --- election definition (docs/spec/election-definition.md) -----------------

ALL_PINS = [(t, 1) for t in range(1, 10)]


def enc_definition(d, version=1):
    out = u16(0x0001) + u8(version)
    p = d["profile"]
    out += u8(p["protocol_major"])
    out += lst(p["pins"], 64, lambda x: u16(x[0]) + u8(x[1]))
    out += fixed(d["election_id"], 32)
    out += u64(d["l2_chain_id"]) + u64(d["l1_chain_id"])
    for k in ["election_registry", "board", "trustee_registry", "group_registry", "l1_anchor", "l1_relay"]:
        out += fixed(d[k], 20)
    out += u8(d["election_type"]) + u8(d["tally_scheme"])
    out += u16(d["option_count"]) + u16(d["min_selections"]) + u16(d["max_selections"])
    out += lst(
        d["electorate"],
        3,
        lambda g: u8(g["tier"]) + u64(g["group_id"]) + field(g["root"]) + u64(g["root_l2_block"]) + u64(g["group_size"]),
    )
    out += fixed(d["membership_vk_hash"], 32) + fixed(d["panel_id"], 32)
    out += u8(d["threshold"]) + u8(d["panel_size"])
    out += fixed(d["ceremony_transcript_hash"], 32)
    out += u64(d["opens_at"]) + u64(d["closes_at"]) + u32(d["l1_inclusion_bound"])
    out += u64(d["sequencing_window"]) + u64(d["max_sequencer_drift"])
    out += fixed(d["display_text_commitment"], 32)
    return out


def def_json(d):
    """The vector-file value of a definition: integers as decimal strings, bytes as hex."""
    j = {}
    for k, v in d.items():
        if k == "profile":
            j[k] = {
                "protocol_major": str(v["protocol_major"]),
                "pins": [{"record_type": str(t), "version": str(x)} for t, x in v["pins"]],
            }
        elif k == "electorate":
            j[k] = [
                {
                    "tier": str(g["tier"]),
                    "group_id": str(g["group_id"]),
                    "root": field(g["root"]).hex(),
                    "root_l2_block": str(g["root_l2_block"]),
                    "group_size": str(g["group_size"]),
                }
                for g in v
            ]
        elif isinstance(v, bytes):
            j[k] = v.hex()
        else:
            j[k] = str(v)
    return j


def b(n, fill):
    return bytes([fill]) * n


def seq(n, start):
    return bytes((start + i) % 256 for i in range(n))


TYPICAL = {
    "profile": {"protocol_major": 1, "pins": ALL_PINS},
    "election_id": seq(32, 0x10),
    "l2_chain_id": 84532,
    "l1_chain_id": 11155111,
    "election_registry": b(20, 0x11),
    "board": b(20, 0x12),
    "trustee_registry": b(20, 0x13),
    "group_registry": b(20, 0x14),
    "l1_anchor": b(20, 0x21),
    "l1_relay": b(20, 0x22),
    "election_type": 1,
    "tally_scheme": 1,
    "option_count": 3,
    "min_selections": 0,
    "max_selections": 1,
    "electorate": [
        {"tier": 0, "group_id": 1, "root": 0x0123456789ABCDEF, "root_l2_block": 1000, "group_size": 5000},
        {"tier": 2, "group_id": 3, "root": R - 1, "root_l2_block": 1000, "group_size": 120},
    ],
    "membership_vk_hash": seq(32, 0x40),
    "panel_id": seq(32, 0x60),
    "threshold": 4,
    "panel_size": 7,
    "ceremony_transcript_hash": seq(32, 0x80),
    "opens_at": 1767225600,
    "closes_at": 1767830400,
    "l1_inclusion_bound": 3600,
    "sequencing_window": 3600,
    "max_sequencer_drift": 1800,
    "display_text_commitment": seq(32, 0xA0),
}

MINIMAL = {
    "profile": {"protocol_major": 1, "pins": ALL_PINS},
    "election_id": b(32, 0),
    "l2_chain_id": 1,
    "l1_chain_id": 2,
    "election_registry": b(19, 0) + b"\x01",
    "board": b(19, 0) + b"\x02",
    "trustee_registry": b(19, 0) + b"\x03",
    "group_registry": b(19, 0) + b"\x04",
    "l1_anchor": b(19, 0) + b"\x01",
    "l1_relay": b(19, 0) + b"\x02",
    "election_type": 1,
    "tally_scheme": 1,
    "option_count": 2,
    "min_selections": 0,
    "max_selections": 1,
    "electorate": [{"tier": 0, "group_id": 0, "root": 0, "root_l2_block": 0, "group_size": 1}],
    "membership_vk_hash": b(32, 0),
    "panel_id": b(32, 0),
    "threshold": 2,
    "panel_size": 2,
    "ceremony_transcript_hash": b(32, 0),
    "opens_at": 0,
    "closes_at": 1,
    "l1_inclusion_bound": 0,
    "sequencing_window": 0,
    "max_sequencer_drift": 0,
    "display_text_commitment": b(32, 0),
}

MAXIMAL = {
    "profile": {"protocol_major": 1, "pins": [(1, 1)] + [(t, 255) for t in range(2, 10)]},
    "election_id": b(32, 0xFF),
    "l2_chain_id": U64_MAX,
    "l1_chain_id": U64_MAX - 1,
    "election_registry": b(20, 0xFF),
    "board": b(20, 0xFE),
    "trustee_registry": b(20, 0xFD),
    "group_registry": b(20, 0xFC),
    "l1_anchor": b(20, 0xFF),
    "l1_relay": b(20, 0xFE),
    "election_type": 2,
    "tally_scheme": 1,
    "option_count": 64,
    "min_selections": 64,
    "max_selections": 64,
    "electorate": [
        {"tier": t, "group_id": U64_MAX - t, "root": R - 1 - t, "root_l2_block": U64_MAX, "group_size": U64_MAX}
        for t in range(3)
    ],
    "membership_vk_hash": b(32, 0xFF),
    "panel_id": b(32, 0xFF),
    "threshold": 16,
    "panel_size": 16,
    "ceremony_transcript_hash": b(32, 0xFF),
    "opens_at": U64_MAX - 1,
    "closes_at": U64_MAX,
    "l1_inclusion_bound": U32_MAX,
    "sequencing_window": U64_MAX,
    "max_sequencer_drift": U64_MAX,
    "display_text_commitment": b(32, 0xFF),
}

APPROVAL = dict(copy.deepcopy(TYPICAL), election_type=2, option_count=5, min_selections=1, max_selections=3)


def variant(base, **changes):
    d = copy.deepcopy(base)
    for k, v in changes.items():
        d[k] = v
    return d


def with_pins(pins, major=1):
    return {"protocol_major": major, "pins": pins}


# Well-formedness, from the rule table of docs/spec/election-definition.md, in
# its order. Every vector's label is checked against these, so a hand-written
# label can't disagree with the table.


def definition_rule(d):
    pins = d["profile"]["pins"]
    types = [t for t, _ in pins]
    if d["profile"]["protocol_major"] != 1:
        return "protocol-major"
    if any(types[i - 1] >= types[i] for i in range(1, len(types))):
        return "profile-order"
    if types != list(range(1, 10)):
        return "profile-types"
    if any(v < 1 for _, v in pins):
        return "profile-version"
    if not 2 <= d["option_count"] <= 64:
        return "option-count"
    mn, mx = d["min_selections"], d["max_selections"]
    if not (mn <= mx <= d["option_count"] and mx >= 1) or (d["election_type"] == 1 and mx != 1):
        return "selections"
    e = d["electorate"]
    tiers = [g["tier"] for g in e]
    if (
        not e
        or any(tiers[i - 1] >= tiers[i] for i in range(1, len(tiers)))
        or len({g["group_id"] for g in e}) != len(e)
        or len({g["root"] for g in e}) != len(e)
        or any(g["group_size"] < 1 for g in e)
    ):
        return "electorate"
    if not 2 <= d["threshold"] <= d["panel_size"] <= 16:
        return "panel"
    l2 = [d[k] for k in ["election_registry", "board", "trustee_registry", "group_registry"]]
    l1 = [d["l1_anchor"], d["l1_relay"]]
    if (
        d["l2_chain_id"] == 0
        or d["l1_chain_id"] == 0
        or d["l2_chain_id"] == d["l1_chain_id"]
        or any(a == bytes(20) for a in l2 + l1)
        or len(set(l2)) != 4
        or len(set(l1)) != 2
    ):
        return "chain"
    if d["opens_at"] >= d["closes_at"]:
        return "timing"
    return None


def display_text_rule(t, option_count, commitment):
    if H(ds("abolish/v1/display-text", enc_display_text(t))) != commitment:
        return "commitment"
    langs = [raw(x["language"]) for x in t["translations"]]
    if not langs or any(langs[i - 1] >= langs[i] for i in range(1, len(langs))):
        return "translations"
    ok = set(b"abcdefghijklmnopqrstuvwxyz0123456789-")
    if any(not 1 <= len(lang) <= 35 or any(c not in ok for c in lang) for lang in langs):
        return "language-tag"
    if any(len(x["options"]) != option_count for x in t["translations"]):
        return "option-count"
    if any(raw(x["question"]) == b"" or any(raw(o["label"]) == b"" for o in x["options"]) for x in t["translations"]):
        return "question"
    if any(len({raw(o["label"]) for o in x["options"]}) != len(x["options"]) for x in t["translations"]):
        return "labels"
    return None


def def_vectors():
    T = ref("election-definition-v1")
    vs = []

    def valid(id_, d, desc, rule=None):
        e = enc_definition(d)
        v = {"id": id_, "description": desc, "type": T, "value": def_json(d), "encoding": e.hex()}
        v["hash"] = H(ds("abolish/v1/election-definition", e)).hex()
        assert definition_rule(d) == rule, (id_, definition_rule(d), rule)
        if rule is not None:
            v["illFormed"] = rule
        vs.append(v)

    def invalid(id_, enc, err, desc):
        vs.append({"id": id_, "description": desc, "type": T, "encoding": enc.hex(), "error": err})

    valid("definition-typical", TYPICAL, "Plurality, Tier 0 and Tier 2, 4-of-7 panel, Base Sepolia and Sepolia chain IDs")
    valid("definition-approval", APPROVAL, "Approval of 1 to 3 of 5 options")
    valid("definition-minimal", MINIMAL, "Every field at its smallest well-formed value")
    valid("definition-maximal", MAXIMAL, "Every field at its largest value: 64 options, 3 tiers, 16-of-16, every u64 at 2^64 - 1, roots at r - 1 down to r - 3, every pin but its own at version 255")

    te = enc_definition(TYPICAL)
    invalid("definition-truncated", te[:-1], "truncated", "The last byte of display_text_commitment is missing")
    invalid("definition-trailing", te + b"\x00", "trailing-bytes", "One byte after display_text_commitment")
    invalid("definition-empty", b"", "truncated", "No header")
    invalid("definition-type-zero", b"\x00\x00" + te[2:], "unknown-record-type", "Record type 0x0000")
    invalid("definition-type-unassigned", b"\x00\x0a" + te[2:], "unknown-record-type", "Record type 0x000a, which the registry doesn't assign")
    invalid("definition-version-zero", te[:2] + b"\x00" + te[3:], "unknown-version", "Version 0 is never valid")
    invalid(
        "definition-version-unknown",
        enc_definition(variant(TYPICAL, profile=with_pins([(1, 2)] + ALL_PINS[1:])), version=2),
        "unknown-version",
        "Version 2, which has no layout; its profile pins 0x0001 at 2, but no pin is known before the definition is read",
    )
    invalid(
        "definition-profile-pins-other-version",
        enc_definition(variant(TYPICAL, profile=with_pins([(1, 2)] + ALL_PINS[1:]))),
        "profile-mismatch",
        "A version-1 definition whose own profile pins 0x0001 at version 2",
    )
    invalid(
        "definition-profile-pins-own-type-twice",
        enc_definition(variant(TYPICAL, profile=with_pins([(1, 1), (1, 1)] + ALL_PINS[1:]))),
        "profile-mismatch",
        "0x0001 pinned twice, both at the record's version: exactly one pin is required, so this is a mismatch before any well-formedness rule",
    )
    invalid(
        "definition-profile-pins-own-type-twice-other-first",
        enc_definition(variant(TYPICAL, profile=with_pins([(1, 2), (1, 1)] + ALL_PINS[1:]))),
        "profile-mismatch",
        "0x0001 pinned at 2 then at 1: the result doesn't depend on which pin a decoder finds first",
    )
    invalid(
        "definition-profile-no-pin",
        enc_definition(variant(TYPICAL, profile=with_pins(ALL_PINS[1:]))),
        "profile-mismatch",
        "A definition whose profile pins no version for 0x0001",
    )
    # Offsets into the typical encoding, from the layout table.
    pins_len = 4 + 3 * len(ALL_PINS)
    off_type = 3 + 1 + pins_len + 32 + 16 + 6 * 20
    invalid("definition-election-type-zero", te[:off_type] + b"\x00" + te[off_type + 1 :], "invalid-enum", "election_type 0")
    invalid("definition-election-type-ranked", te[:off_type] + b"\x03" + te[off_type + 1 :], "invalid-enum", "election_type 3, which version 1 doesn't list")
    invalid("definition-tally-scheme-two", te[: off_type + 1] + b"\x02" + te[off_type + 2 :], "invalid-enum", "tally_scheme 2, which version 1 doesn't list")
    off_electorate = off_type + 2 + 6
    off_tier = off_electorate + 4
    invalid("definition-tier-three", te[:off_tier] + b"\x03" + te[off_tier + 1 :], "invalid-enum", "A tier_group with tier 3")
    off_root = off_tier + 1 + 8
    invalid("definition-root-r", te[:off_root] + R.to_bytes(32, "big") + te[off_root + 32 :], "non-canonical", "A root equal to r")
    invalid(
        "definition-electorate-over-max",
        te[:off_electorate] + u32(4) + te[off_electorate + 4 :],
        "length-over-max",
        "An electorate count of 4, over its maximum of 3, rejected before any entry is read",
    )
    off_pins = 3 + 1
    invalid(
        "definition-pins-over-max",
        te[:off_pins] + u32(65) + te[off_pins + 4 :],
        "length-over-max",
        "A pins count of 65, over its maximum of 64",
    )

    ill = [
        ("protocol-major", "definition-protocol-major-two", variant(TYPICAL, profile=with_pins(ALL_PINS, 2)), "profile.protocol_major 2"),
        ("profile-order", "definition-pins-unsorted", variant(TYPICAL, profile=with_pins([ALL_PINS[0], ALL_PINS[2], ALL_PINS[1]] + ALL_PINS[3:])), "Pins for 0x0003 before 0x0002"),
        ("profile-order", "definition-pins-duplicate", variant(TYPICAL, profile=with_pins(ALL_PINS[:2] + [ALL_PINS[1]] + ALL_PINS[2:])), "0x0002 pinned twice"),
        ("profile-types", "definition-pins-missing-type", variant(TYPICAL, profile=with_pins(ALL_PINS[:4] + ALL_PINS[5:])), "No pin for 0x0005"),
        ("profile-types", "definition-pins-test-type", variant(TYPICAL, profile=with_pins(ALL_PINS + [(0xFF00, 1)])), "An extra pin for the test type 0xff00"),
        ("profile-version", "definition-pin-version-zero", variant(TYPICAL, profile=with_pins([ALL_PINS[0], (2, 0)] + ALL_PINS[2:])), "0x0002 pinned at version 0"),
        ("option-count", "definition-one-option", variant(TYPICAL, option_count=1), "option_count 1"),
        ("option-count", "definition-65-options", variant(APPROVAL, option_count=65), "option_count 65, over MAX_OPTIONS"),
        ("selections", "definition-plurality-two", variant(TYPICAL, max_selections=2), "A plurality definition with max_selections 2"),
        ("selections", "definition-min-over-max", variant(APPROVAL, min_selections=4), "min_selections 4 over max_selections 3"),
        ("selections", "definition-max-over-options", variant(APPROVAL, max_selections=6), "max_selections 6 over option_count 5"),
        ("selections", "definition-max-zero", variant(APPROVAL, min_selections=0, max_selections=0), "max_selections 0"),
        ("electorate", "definition-electorate-empty", variant(TYPICAL, electorate=[]), "No tiers"),
        ("electorate", "definition-tiers-unsorted", variant(TYPICAL, electorate=list(reversed(TYPICAL["electorate"]))), "Tier 2 before Tier 0"),
        ("electorate", "definition-tier-repeated", variant(TYPICAL, electorate=[TYPICAL["electorate"][0], dict(TYPICAL["electorate"][0], group_id=2)]), "Tier 0 twice, in two groups, so the tiers-only partition would count it twice"),
        ("electorate", "definition-group-shared", variant(TYPICAL, electorate=[TYPICAL["electorate"][0], dict(TYPICAL["electorate"][1], group_id=1)]), "Tier 0 and Tier 2 naming the same group"),
        ("electorate", "definition-roots-equal", variant(TYPICAL, electorate=[TYPICAL["electorate"][0], dict(TYPICAL["electorate"][1], root=TYPICAL["electorate"][0]["root"])]), "Tier 0 and Tier 2 with the same root, so one membership proof would fit both cells"),
        ("electorate", "definition-group-empty", variant(TYPICAL, electorate=[dict(TYPICAL["electorate"][0], group_size=0)]), "A group of size 0"),
        ("panel", "definition-threshold-zero", variant(TYPICAL, threshold=0), "threshold 0"),
        ("panel", "definition-threshold-one", variant(TYPICAL, threshold=1), "threshold 1: one trustee could open every sharing alone"),
        ("panel", "definition-panel-one-of-one", variant(TYPICAL, threshold=1, panel_size=1), "A 1-of-1 panel"),
        ("panel", "definition-threshold-over-size", variant(TYPICAL, threshold=8), "threshold 8 over panel_size 7"),
        ("panel", "definition-panel-17", variant(TYPICAL, threshold=4, panel_size=17), "panel_size 17, over MAX_TRUSTEES"),
        ("chain", "definition-l2-chain-zero", variant(TYPICAL, l2_chain_id=0), "l2_chain_id 0"),
        ("chain", "definition-l1-chain-zero", variant(TYPICAL, l1_chain_id=0), "l1_chain_id 0"),
        ("chain", "definition-l1-addresses-repeated", variant(TYPICAL, l1_relay=TYPICAL["l1_anchor"]), "l1_relay equal to l1_anchor"),
        ("chain", "definition-group-registry-is-trustee-registry", variant(TYPICAL, group_registry=TYPICAL["trustee_registry"]), "group_registry equal to trustee_registry"),
        ("profile-types", "definition-pins-unassigned-type", variant(TYPICAL, profile=with_pins(ALL_PINS + [(0x000A, 1)])), "An extra pin for 0x000a, which the registry doesn't assign"),
        ("protocol-major", "definition-two-rules-broken", variant(TYPICAL, profile=with_pins(ALL_PINS, 2), closes_at=0), "Both protocol-major and timing fail: the first rule in the table's order is reported"),
        ("panel", "definition-panel-and-chain-broken", variant(TYPICAL, threshold=1, l1_chain_id=0), "Both panel and chain fail: panel comes first"),
        ("chain", "definition-same-chain", variant(TYPICAL, l1_chain_id=84532), "l1_chain_id equal to l2_chain_id"),
        ("chain", "definition-address-zero", variant(TYPICAL, l1_relay=b(20, 0)), "The zero address as l1_relay"),
        ("chain", "definition-l2-addresses-repeated", variant(TYPICAL, board=b(20, 0x11)), "board equal to election_registry"),
        ("timing", "definition-closes-at-open", variant(TYPICAL, closes_at=TYPICAL["opens_at"]), "closes_at equal to opens_at"),
    ]
    for rule, id_, d, desc in ill:
        valid(id_, d, desc, rule)
    return vs


# --- display text (docs/spec/display-text.md) -------------------------------


def enc_display_text(t, version=1):
    out = u16(0x0009) + u8(version) + fixed(t["salt"], 32)
    out += lst(
        t["translations"],
        32,
        lambda x: utf8(x["language"], 35)
        + utf8(x["question"], 1024)
        + utf8(x["description"], 8192)
        + lst(x["options"], 64, lambda o: utf8(o["label"], 512) + utf8(o["description"], 1024)),
    )
    return out


def raw(s):
    return s.encode("utf-8") if isinstance(s, str) else s


def dt_json(t):
    return {
        "salt": t["salt"].hex(),
        "translations": [
            {
                "language": raw(x["language"]).hex(),
                "question": raw(x["question"]).hex(),
                "description": raw(x["description"]).hex(),
                "options": [{"label": raw(o["label"]).hex(), "description": raw(o["description"]).hex()} for o in x["options"]],
            }
            for x in t["translations"]
        ],
    }


EN = {
    "language": "en",
    "question": "Should the park stay open late?",
    "description": "",
    "options": [{"label": "Yes", "description": ""}, {"label": "No", "description": ""}, {"label": "Abstain", "description": "Counted, but neither yes nor no."}],
}
ES = {
    "language": "es-419",
    "question": "¿Debe el parque abrir hasta tarde?",
    "description": "Consulta vecinal",
    "options": [{"label": "Sí", "description": ""}, {"label": "No", "description": ""}, {"label": "Abstención", "description": ""}],
}
DT = {"salt": seq(32, 0x01), "translations": [EN, ES]}


def dt_vectors():
    T = ref("display-text-v1")
    vs = []
    commitment = H(ds("abolish/v1/display-text", enc_display_text(DT)))
    ctx = {"optionCount": "3", "displayTextCommitment": commitment.hex()}

    def valid(id_, t, desc, rule=None, context=ctx):
        e = enc_display_text(t)
        v = {"id": id_, "description": desc, "type": T, "pinned": 1, "value": dt_json(t), "encoding": e.hex()}
        v["commitment"] = H(ds("abolish/v1/display-text", e)).hex()
        v["definition"] = context
        if rule is not None:
            v["illFormed"] = rule
        vs.append(v)

    def invalid(id_, enc, err, desc):
        vs.append({"id": id_, "description": desc, "type": T, "pinned": 1, "encoding": enc.hex(), "error": err})

    assert display_text_rule(DT, 3, commitment) is None
    valid("display-text-two-languages", DT, "English and Latin American Spanish, three options, multibyte text")
    one = {"salt": b(32, 0), "translations": [dict(EN, options=EN["options"][:2], description="")]}
    one_ctx = {"optionCount": "2", "displayTextCommitment": H(ds("abolish/v1/display-text", enc_display_text(one))).hex()}
    valid("display-text-one-language", one, "One language, two options, empty descriptions", context=one_ctx)

    e = enc_display_text(DT)
    invalid("display-text-truncated", e[:-1], "truncated", "The last byte is missing")
    invalid("display-text-trailing", e + b"\x00", "trailing-bytes", "One byte after the last field")
    invalid("display-text-salt-short", e[:3 + 31], "truncated", "Only 31 bytes of salt")
    invalid(
        "display-text-version-unpinned",
        u16(9) + u8(2) + e[3:],
        "profile-mismatch",
        "Version 2 against a pin of 1: profile-mismatch wins over unknown-version because the pin is checked first",
    )
    bad_label = enc_display_text({"salt": DT["salt"], "translations": [dict(EN, options=[{"label": b"\xc3\x28", "description": b""}] + EN["options"][1:])]})
    invalid("display-text-label-invalid-utf8", bad_label, "invalid-utf8", "An option label of 0xc3 0x28, an ill-formed UTF-8 sequence")
    long_label = (
        u16(9) + u8(1) + DT["salt"] + u32(1) + utf8("en", 35) + utf8("q", 1024) + utf8("", 8192) + u32(1) + u32(513) + b"a" * 513 + u32(0)
    )
    invalid("display-text-label-over-max", long_label, "length-over-max", "An option label of 513 bytes, over its maximum of 512")
    invalid("display-text-translations-over-max", u16(9) + u8(1) + DT["salt"] + u32(33), "length-over-max", "33 translations, over the maximum of 32")
    invalid(
        "display-text-language-over-max",
        u16(9) + u8(1) + DT["salt"] + u32(1) + u32(36) + b"a" * 36,
        "length-over-max",
        "A language tag of 36 bytes, over its maximum of 35",
    )

    ill = [
        ("commitment", "display-text-wrong-salt", dict(DT, salt=seq(32, 0x02)), "The definition's commitment is for a different salt"),
        ("translations", "display-text-no-translations", {"salt": DT["salt"], "translations": []}, "No translations"),
        ("translations", "display-text-unsorted", {"salt": DT["salt"], "translations": [ES, EN]}, "es-419 before en"),
        ("translations", "display-text-language-twice", {"salt": DT["salt"], "translations": [EN, EN]}, "en twice"),
        ("language-tag", "display-text-language-empty", {"salt": DT["salt"], "translations": [dict(EN, language="")]}, "An empty language tag"),
        ("language-tag", "display-text-language-underscore", {"salt": DT["salt"], "translations": [dict(EN, language="en_US")]}, "A language tag with an underscore"),
        ("option-count", "display-text-two-options", {"salt": DT["salt"], "translations": [dict(EN, options=EN["options"][:2])]}, "Two options where the definition has three"),
        ("question", "display-text-question-empty", {"salt": DT["salt"], "translations": [dict(EN, question="")]}, "An empty question"),
        ("language-tag", "display-text-language-uppercase", {"salt": DT["salt"], "translations": [dict(EN, language="EN")]}, "An uppercase tag, which could sit beside en with other labels"),
        ("labels", "display-text-labels-repeated", {"salt": DT["salt"], "translations": [dict(EN, options=[EN["options"][0], EN["options"][0], EN["options"][2]])]}, "Two options both labelled Yes"),
        ("question", "display-text-label-empty", {"salt": DT["salt"], "translations": [dict(EN, options=[{"label": "", "description": "x"}] + EN["options"][1:])]}, "An empty option label"),
    ]
    for rule, id_, t, desc in ill:
        oc = 3
        commit = commitment if rule == "commitment" else H(ds("abolish/v1/display-text", enc_display_text(t)))
        assert display_text_rule(t, oc, commit) == rule, (id_, display_text_rule(t, oc, commit), rule)
        # Every rule after `commitment` is checked against a definition that
        # commits to this exact record, so only the rule named fails.
        c = ctx if rule == "commitment" else {"optionCount": "3", "displayTextCommitment": H(ds("abolish/v1/display-text", enc_display_text(t))).hex()}
        valid(id_, t, desc, rule, c)
    return vs


def main(out_dir):
    out = Path(out_dir)
    gen = (
        "Printed by packages/crypto/scripts/definition-vectors.py, written from the tables in {spec} with only the Python "
        "standard library (hashlib for SHA-256), independently of packages/crypto: its encoders build every "
        "encoding, and its own implementation of the spec's well-formedness rules confirms every valid vector's "
        "illFormed label (or its absence). Decode errors are labelled by hand from the strict-decoding rules. The "
        "TypeScript tests check packages/crypto's codecs, hashes and rule checks against it."
    )
    files = {
        "election-definition.json": {
            "format": "abolish-vectors/1",
            "title": "Election definition, version 1 (draft)",
            "spec": "docs/spec/election-definition.md",
            "generator": gen.format(spec="docs/spec/election-definition.md"),
            "draft": True,
            "types": DEF_TYPES,
            "vectors": def_vectors(),
        },
        "display-text.json": {
            "format": "abolish-vectors/1",
            "title": "Display text, version 1 (draft)",
            "spec": "docs/spec/display-text.md",
            "generator": gen.format(spec="docs/spec/display-text.md"),
            "draft": True,
            "types": DT_TYPES,
            "vectors": dt_vectors(),
        },
    }
    for name, content in files.items():
        (out / name).write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1])
