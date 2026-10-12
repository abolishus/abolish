#!/usr/bin/env python3
"""Prints docs/spec/vectors/election-definition-v3.json and regional-cells.json.

Written from docs/spec/election-definition.md (Layout (version 3), Regional
cells, Well-formedness) and docs/spec/membership.md (Cell tree) alone,
independently of packages/crypto, with only the Python standard library. It
reuses definition-vectors.py's primitive encoders and version-1 fields and
tier-tree-vectors.py's Poseidon2 (self-checked against circomlib's published
answers) and tier tree, both independent of packages/crypto too.

    python3 -I -B packages/crypto/scripts/regional-cells-vectors.py \
      packages/crypto/test-vectors/iden3/poseidon_constants.json docs/spec/vectors

then `vp check --fix` to format the JSON.
"""

import copy
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dv = load("definition_vectors", "definition-vectors.py")
tt = load("tier_tree_vectors", "tier-tree-vectors.py")

R = dv.R
U64_MAX = dv.U64_MAX
u8, u16, u32, u64, field, lst, fixed, ds, H = dv.u8, dv.u16, dv.u32, dv.u64, dv.field, dv.lst, dv.fixed, dv.ds, dv.H

FLOOR = 1000  # MIN_CELL_ELECTORATE, docs/spec/parameters.md
MAX_GROUPS = 1024
MAX_REGIONS = 1024
MAX_CELLS = 256

# --- the fold (election-definition.md, Regional cells, step 3) --------------


def fold(members):
    """Each cell's region indices, in order: written from the spec's prose."""
    assert members
    large = [i for i, n in enumerate(members) if n >= FLOOR]
    small = [i for i, n in enumerate(members) if n < FLOOR]
    candidates = [[i] for i in large] + ([small] if small else [])
    split = len(candidates) >= 2 and (not small or sum(members[i] for i in small) >= FLOOR)
    return candidates if split else [list(range(len(members)))]


# --- version-3 layout ---------------------------------------------------------


def enc_tier(t):
    return (
        u8(t["tier"])
        + u64(t["root_l2_block"])
        + lst(t["groups"], MAX_GROUPS, lambda g: u64(g["group_id"]) + u16(g["region"]))
        + lst(t["regions"], MAX_REGIONS, u64)
        + lst(t["cells"], MAX_CELLS, lambda c: field(c["root"]) + u64(c["members"]))
    )


def enc_definition_v3(d, version=3):
    """Version 1's encoder with the electorate swapped: the head and tail are version 1's bytes."""
    v1 = dict(d, electorate=[])
    head_tail = dv.enc_definition(v1, version)
    # A version-1 encoding of an empty electorate has u32(0) where the list goes.
    pins_len = 4 + 3 * len(d["profile"]["pins"])
    at = 3 + 1 + pins_len + 32 + 16 + 6 * 20 + 2 + 6
    assert head_tail[at : at + 4] == u32(0)
    return head_tail[:at] + lst(d["electorate"], 3, enc_tier) + head_tail[at + 4 :]


def def_json(d):
    j = dv.def_json(dict(d, electorate=[]))
    j["electorate"] = [
        {
            "tier": str(t["tier"]),
            "root_l2_block": str(t["root_l2_block"]),
            "groups": [{"group_id": str(g["group_id"]), "region": str(g["region"])} for g in t["groups"]],
            "regions": [str(n) for n in t["regions"]],
            "cells": [{"root": field(c["root"]).hex(), "members": str(c["members"])} for c in t["cells"]],
        }
        for t in d["electorate"]
    ]
    return j


U16 = {"kind": "u16"}
U64 = {"kind": "u64"}


def ref(name):
    return {"kind": "ref", "name": name}


DEF_TYPES = {
    "record-pin": dv.DEF_TYPES["record-pin"],
    "profile": dv.DEF_TYPES["profile"],
    "region-group": {
        "kind": "struct",
        "fields": [{"name": "group_id", "type": U64}, {"name": "region", "type": U16}],
    },
    "cell": {
        "kind": "struct",
        "fields": [{"name": "root", "type": {"kind": "field", "field": "bn254"}}, {"name": "members", "type": U64}],
    },
    "tier-electorate": {
        "kind": "struct",
        "fields": [
            {"name": "tier", "type": {"kind": "enum8", "values": ["0", "1", "2"]}},
            {"name": "root_l2_block", "type": U64},
            {"name": "groups", "type": {"kind": "list", "max": MAX_GROUPS, "of": ref("region-group")}},
            {"name": "regions", "type": {"kind": "list", "max": MAX_REGIONS, "of": U64}},
            {"name": "cells", "type": {"kind": "list", "max": MAX_CELLS, "of": ref("cell")}},
        ],
    },
}
DEF_TYPES["election-definition-v3"] = {
    "kind": "record",
    "recordType": "0001",
    "version": 3,
    "fields": [
        {"name": n, "type": {"kind": "list", "max": 3, "of": ref("tier-electorate")} if n == "electorate" else t}
        for n, t in dv.DEF_FIELDS
    ],
}

# --- well-formedness (election-definition.md, Well-formedness) -------------


def electorate_rule(d):
    e = d["electorate"]
    tiers = [t["tier"] for t in e]
    if not e or any(tiers[i - 1] >= tiers[i] for i in range(1, len(tiers))):
        return "electorate"
    seen = set()
    for t in e:
        ids = [g["group_id"] for g in t["groups"]]
        if not ids or not t["regions"]:
            return "electorate"
        if any(ids[i - 1] >= ids[i] for i in range(1, len(ids))) or seen & set(ids):
            return "electorate"
        seen |= set(ids)
        if any(g["region"] >= len(t["regions"]) for g in t["groups"]):
            return "electorate"
        if {g["region"] for g in t["groups"]} != set(range(len(t["regions"]))):
            return "electorate"
        if any(n < 1 for n in t["regions"]):
            return "electorate"
    return None


def cells_rule(d):
    roots = []
    for t in d["electorate"]:
        derived = fold(t["regions"])
        if len(derived) != len(t["cells"]):
            return "cells"
        for regions, c in zip(derived, t["cells"]):
            if c["members"] != sum(t["regions"][r] for r in regions):
                return "cells"
        roots += [c["root"] for c in t["cells"]]
    if len(set(roots)) != len(roots) or len(roots) > MAX_CELLS:
        return "cells"
    return None


def definition_rule(d):
    # Version 1's rules before and after the electorate, from definition-vectors.py,
    # given a version-1 electorate that passes its own rule.
    stand_in = [{"tier": 0, "group_id": 0, "root": 0, "root_l2_block": 0, "group_size": 1}]
    head = dv.definition_rule(dict(d, electorate=stand_in, threshold=2, panel_size=2, l2_chain_id=1, l1_chain_id=2,
                                   election_registry=bytes(19) + b"\x01", board=bytes(19) + b"\x02",
                                   trustee_registry=bytes(19) + b"\x03", group_registry=bytes(19) + b"\x04",
                                   l1_anchor=bytes(19) + b"\x01", l1_relay=bytes(19) + b"\x02", opens_at=0, closes_at=1,
                                   l1_inclusion_bound=0))
    if head is not None:
        return head
    rule = electorate_rule(d) or cells_rule(d)
    if rule is not None:
        return rule
    return dv.definition_rule(dict(d, electorate=stand_in))


# --- definitions ----------------------------------------------------------------

PINS_V3 = [(1, 3)] + [(t, 1) for t in range(2, 10)]


def stated(regions, roots):
    """A tier's stated cells: the fold's members, with the given roots."""
    cells = fold(regions)
    assert len(cells) == len(roots)
    return [{"root": r, "members": sum(regions[i] for i in c)} for c, r in zip(cells, roots)]


T0 = {
    "tier": 0,
    "root_l2_block": 1000,
    "groups": [
        {"group_id": 1, "region": 0},
        {"group_id": 2, "region": 1},
        {"group_id": 4, "region": 1},
        {"group_id": 5, "region": 2},
        {"group_id": 6, "region": 3},
    ],
    "regions": [5000, 1200, 40, 980],
    "cells": stated([5000, 1200, 40, 980], [0x0123456789ABCDEF, 0x0FEDCBA987654321, 0x1111]),
}
T2 = {
    "tier": 2,
    "root_l2_block": 999,
    "groups": [{"group_id": 3, "region": 0}],
    "regions": [120],
    "cells": stated([120], [R - 1]),
}
TYPICAL = dict(copy.deepcopy(dv.TYPICAL), profile={"protocol_major": 1, "pins": PINS_V3}, electorate=[T0, T2])
MINIMAL = dict(
    copy.deepcopy(dv.MINIMAL),
    profile={"protocol_major": 1, "pins": PINS_V3},
    electorate=[{"tier": 0, "root_l2_block": 0, "groups": [{"group_id": 0, "region": 0}], "regions": [1], "cells": [{"root": 0, "members": 1}]}],
)


def lists_at_max():
    # 1024 groups and regions; 255 large regions and a remainder of 769 small
    # ones summing past the floor: 256 cells, the most a definition may have.
    regions = [FLOOR] * 255 + [2] * 769
    cells = fold(regions)
    assert len(cells) == 256
    return {
        "tier": 1,
        "root_l2_block": U64_MAX,
        "groups": [{"group_id": U64_MAX - 1023 + i, "region": i} for i in range(1024)],
        "regions": regions,
        "cells": [{"root": R - 1 - i, "members": sum(regions[r] for r in c)} for i, c in enumerate(cells)],
    }


ALL_LARGE_256 = {
    "tier": 1,
    "root_l2_block": 1,
    "groups": [{"group_id": 100 + i, "region": i} for i in range(256)],
    "regions": [FLOOR] * 256,
    "cells": [{"root": 100 + i, "members": FLOOR} for i in range(256)],
}

MAXIMAL = dict(copy.deepcopy(dv.MAXIMAL), profile={"protocol_major": 1, "pins": [(1, 3)] + [(t, 255) for t in range(2, 10)]})
MAXIMAL["electorate"] = [
    {"tier": 0, "root_l2_block": U64_MAX, "groups": [{"group_id": 0, "region": 0}], "regions": [U64_MAX], "cells": [{"root": 2, "members": U64_MAX}]},
    lists_at_max(),
]


def variant(base, **changes):
    d = copy.deepcopy(base)
    d.update(changes)
    return d


def tier_variant(base, at, **changes):
    d = copy.deepcopy(base)
    d["electorate"][at].update(changes)
    return d


def def_vectors():
    T = ref("election-definition-v3")
    vs = []

    def valid(id_, d, desc, rule=None):
        e = enc_definition_v3(d)
        v = {"id": id_, "description": desc, "type": T, "value": def_json(d), "encoding": e.hex()}
        v["hash"] = H(ds("abolish/v1/election-definition", e)).hex()
        v["stubHash"] = H(ds("abolish/v1/election-stub", enc_definition_v3(dict(d, ceremony_transcript_hash=bytes(32))))).hex()
        assert definition_rule(d) == rule, (id_, definition_rule(d), rule)
        if rule is not None:
            v["illFormed"] = rule
        vs.append(v)

    def invalid(id_, enc, err, desc):
        vs.append({"id": id_, "description": desc, "type": T, "encoding": enc.hex(), "error": err})

    valid("definition-v3-typical", TYPICAL, "Tier 0 split into two large regions and a remainder of two small ones (40 + 980 members); Tier 2 one region of one group, not split")
    valid("definition-v3-minimal", MINIMAL, "Every field at its smallest well-formed value: one tier, one group, one region of one member, one cell")
    maximal = copy.deepcopy(MAXIMAL)
    maximal["electorate"] = maximal["electorate"][1:]
    valid(
        "definition-v3-lists-at-max",
        maximal,
        "Tier 1 alone, with 1024 groups and 1024 regions, 255 at the floor and 769 of 2 members folded into a remainder of 1538: 256 cells, every list at its maximum; every other field at its largest",
    )
    one_tier_split = variant(TYPICAL, electorate=[T0])
    valid("definition-v3-one-tier-split", one_tier_split, "Only Tier 0, split into three cells")

    te = enc_definition_v3(TYPICAL)
    invalid("definition-v3-truncated", te[:-1], "truncated", "The last byte of display_text_commitment is missing")
    invalid("definition-v3-trailing", te + b"\x00", "trailing-bytes", "One byte after display_text_commitment")
    invalid(
        "definition-v3-version-two",
        enc_definition_v3(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 2)] + PINS_V3[1:]}), version=2),
        "unknown-version",
        "Version 3's layout labelled version 2, which is never assigned",
    )
    invalid(
        "definition-v3-profile-pins-one",
        enc_definition_v3(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 1)] + PINS_V3[1:]})),
        "profile-mismatch",
        "A version-3 definition whose own profile pins 0x0001 at version 1",
    )
    invalid(
        "definition-v3-as-version-one",
        enc_definition_v3(TYPICAL, version=1),
        "trailing-bytes",
        "Version 3's bytes labelled version 1: decoding step 1 reads them under version 1's layout before any pin is compared: the electorate's two entries read as two 57-byte tier_groups and the fields after them from the bytes that follow, leaving the rest unread",
    )
    # Offsets into the typical encoding.
    pins_len = 4 + 3 * len(PINS_V3)
    off_electorate = 3 + 1 + pins_len + 32 + 16 + 6 * 20 + 2 + 6
    off_tier = off_electorate + 4
    invalid("definition-v3-tier-three", te[:off_tier] + b"\x03" + te[off_tier + 1 :], "invalid-enum", "A tier_electorate with tier 3")
    off_groups = off_tier + 1 + 8
    invalid(
        "definition-v3-groups-over-max",
        te[:off_groups] + u32(MAX_GROUPS + 1) + te[off_groups + 4 :],
        "length-over-max",
        "A groups count of 1025, over its maximum of 1024, rejected before any group is read",
    )
    off_regions = off_groups + 4 + 10 * len(T0["groups"])
    invalid(
        "definition-v3-regions-over-max",
        te[:off_regions] + u32(MAX_REGIONS + 1) + te[off_regions + 4 :],
        "length-over-max",
        "A regions count of 1025, over its maximum of 1024",
    )
    off_cells = off_regions + 4 + 8 * len(T0["regions"])
    invalid(
        "definition-v3-cells-over-max",
        te[:off_cells] + u32(MAX_CELLS + 1) + te[off_cells + 4 :],
        "length-over-max",
        "A cells count of 257, over its maximum of 256",
    )
    off_root = off_cells + 4
    invalid("definition-v3-cell-root-r", te[:off_root] + R.to_bytes(32, "big") + te[off_root + 32 :], "non-canonical", "A cell root equal to r")
    invalid(
        "definition-v3-electorate-over-max",
        te[:off_electorate] + u32(4) + te[off_electorate + 4 :],
        "length-over-max",
        "An electorate count of 4, over its maximum of 3",
    )

    t0 = TYPICAL["electorate"][0]
    groups = t0["groups"]
    ill = [
        ("protocol-major", "definition-v3-protocol-major-two", variant(TYPICAL, profile={"protocol_major": 2, "pins": PINS_V3}), "profile.protocol_major 2: version 1's rules come first"),
        ("selections", "definition-v3-plurality-two", variant(TYPICAL, max_selections=2), "A plurality definition with max_selections 2"),
        ("electorate", "definition-v3-electorate-empty", variant(TYPICAL, electorate=[]), "No tiers"),
        ("electorate", "definition-v3-tiers-unsorted", variant(TYPICAL, electorate=[T2, T0]), "Tier 2 before Tier 0"),
        ("electorate", "definition-v3-tier-repeated", variant(TYPICAL, electorate=[T0, dict(T2, tier=0)]), "Tier 0 twice"),
        ("electorate", "definition-v3-groups-empty", tier_variant(TYPICAL, 1, groups=[]), "A tier with no groups"),
        ("electorate", "definition-v3-regions-empty", tier_variant(TYPICAL, 1, groups=[{"group_id": 3, "region": 0}], regions=[], cells=[]), "A tier with no regions, its group naming region 0"),
        ("electorate", "definition-v3-groups-unsorted", tier_variant(TYPICAL, 0, groups=[groups[1], groups[0]] + groups[2:]), "Group 2 before group 1"),
        ("electorate", "definition-v3-group-twice", tier_variant(TYPICAL, 0, groups=groups[:2] + [dict(groups[1], region=2)] + groups[2:]), "Group 2 listed twice, in two regions"),
        ("electorate", "definition-v3-group-in-two-tiers", tier_variant(TYPICAL, 1, groups=[{"group_id": 1, "region": 0}]), "Group 1 in Tier 0 and in Tier 2"),
        ("electorate", "definition-v3-region-out-of-range", tier_variant(TYPICAL, 0, groups=groups[:4] + [dict(groups[4], region=4)]), "A group naming region 4 of a tier with 4 regions"),
        ("electorate", "definition-v3-region-without-group", tier_variant(TYPICAL, 0, groups=groups[:4] + [dict(groups[4], region=2)]), "Region 3 named by no group"),
        ("electorate", "definition-v3-region-empty", tier_variant(TYPICAL, 0, regions=[5000, 1200, 0, 980], cells=[{"root": 1, "members": 7180}]), "A region of 0 members (with the rest stated as the fold gives them)"),
        ("cells", "definition-v3-small-merged-into-large", tier_variant(TYPICAL, 0, cells=[{"root": 1, "members": 5000}, {"root": 2, "members": 2220}]), "The small regions merged into a large one, not folded into a remainder"),
        ("cells", "definition-v3-small-region-alone", tier_variant(TYPICAL, 0, cells=[{"root": 1, "members": 5000}, {"root": 2, "members": 1200}, {"root": 3, "members": 40}, {"root": 4, "members": 980}]), "Each small region its own cell, below the floor"),
        ("cells", "definition-v3-remainder-withheld", tier_variant(TYPICAL, 0, cells=[{"root": 1, "members": 5000}, {"root": 2, "members": 1200}]), "The remainder cell left out"),
        ("cells", "definition-v3-members-wrong", tier_variant(TYPICAL, 0, cells=[{"root": 1, "members": 5000}, {"root": 2, "members": 1201}, {"root": 3, "members": 1020}]), "A cell's members one more than its region's count"),
        ("cells", "definition-v3-cells-reordered", tier_variant(TYPICAL, 0, cells=[{"root": 3, "members": 1020}, {"root": 1, "members": 5000}, {"root": 2, "members": 1200}]), "The remainder first: cells follow the fold's order"),
        ("cells", "definition-v3-remainder-below-floor-split", tier_variant(TYPICAL, 0, regions=[5000, 1200, 40, 900], cells=[{"root": 1, "members": 5000}, {"root": 2, "members": 1200}, {"root": 3, "members": 940}]), "A remainder of 940, below the floor, stated as a cell: the tier isn't split"),
        ("cells", "definition-v3-unsplit-stated-split", tier_variant(TYPICAL, 1, groups=[{"group_id": 3, "region": 0}, {"group_id": 7, "region": 1}], regions=[1500, 10], cells=[{"root": 5, "members": 1500}, {"root": 6, "members": 10}]), "One large region and a remainder of 10 stated as two cells"),
        ("cells", "definition-v3-roots-equal-in-tier", tier_variant(TYPICAL, 0, cells=stated([5000, 1200, 40, 980], [7, 7, 8])), "Two cells of Tier 0 with one root"),
        ("cells", "definition-v3-roots-equal-across-tiers", tier_variant(TYPICAL, 1, cells=stated([120], [0x0123456789ABCDEF])), "A Tier 2 cell with the root of a Tier 0 cell"),
        ("cells", "definition-v3-257-cells", variant(MAXIMAL, electorate=[MAXIMAL["electorate"][0], ALL_LARGE_256]), "256 regions at the floor in Tier 1, each a cell, and one cell in Tier 0: 257, over the u8 cell of the tally opening"),
        ("cells", "definition-v3-members-overflow", variant(MAXIMAL, electorate=[dict(MAXIMAL["electorate"][0], groups=[{"group_id": 0, "region": 0}, {"group_id": 1, "region": 1}], regions=[U64_MAX, 5])]), "One region of 2^64 - 1 members and one of 5: the tier isn't split, and its one cell's 2^64 + 4 members fit no u64, so no stated count equals it"),
        ("panel", "definition-v3-threshold-one", variant(TYPICAL, threshold=1), "threshold 1: version 1's later rules still apply"),
        ("electorate", "definition-v3-electorate-and-panel-broken", variant(TYPICAL, electorate=[], threshold=1), "Both electorate and panel fail: electorate comes first"),
        ("cells", "definition-v3-cells-and-timing-broken", tier_variant(variant(TYPICAL, closes_at=0), 1, cells=[]), "Both cells and timing fail: cells comes first"),
    ]
    for rule, id_, d, desc in ill:
        valid(id_, d, desc, rule)
    return vs


# --- regional-cells.json -----------------------------------------------------


FOLDS = [
    ("one-region", "one region is one cell, however small", [3]),
    ("one-large-region", "one region above the floor is still one cell", [5000]),
    ("all-large", "every region at or above the floor: one cell each, no remainder", [1000, 2500, 1000]),
    ("remainder-at-floor", "two large regions and small ones summing to exactly the floor", [1500, 999, 2000, 1]),
    ("remainder-below-floor", "small regions summing to 999: the tier isn't split", [1500, 2000, 998, 1]),
    ("one-large-and-remainder", "one large region and a remainder at the floor: two cells", [1000, 500, 500]),
    ("only-small", "only small regions, summing past the floor: one candidate cell, so not split", [600, 600, 600]),
    ("floor-minus-one", "999 and 1000: the 999 alone is a remainder below the floor, so not split", [999, 1000]),
    ("small-first", "the remainder is last whatever the region order", [10, 3000, 995, 1200]),
    ("large-not-merged", "a remainder below the floor is never rescued by merging a large region", [1000, 1000, 1000, 999]),
]


def tier_events(c, m, spec):
    """Events for one group: ("add", value) and ("remove", index), one each."""
    return [{"add": str(v)} if k == "add" else {"remove": str(v)} for k, v in spec]


def json_events(spec):
    """The vector file's events: consecutive additions of consecutive values as one addRange, to keep the file small."""
    out = []
    for k, v in spec:
        last = out[-1] if out else None
        if k == "add" and last is not None and "addRange" in last and int(last["addRange"][0]) + int(last["addRange"][1]) == v:
            last["addRange"][1] = str(int(last["addRange"][1]) + 1)
        elif k == "add":
            out.append({"addRange": [str(v), "1"]})
        else:
            out.append({"remove": str(v)})
    return [{"add": e["addRange"][0]} if "addRange" in e and e["addRange"][1] == "1" else e for e in out]


def adds(values):
    return [("add", v) for v in values]


def build_tiers(c, m):
    z = tt.zeros(c, m)
    p01 = tt.poseidon2(c, m, 0, 1)

    def member(i):
        return 10**9 + i

    victim = member(7_000_000)
    cases = [
        (
            "one-group",
            "one region of one group: the cell tree is that group's tier tree",
            [(11, 0, adds([member(i) for i in range(5)]))],
            1,
        ),
        (
            "repeat-across-groups",
            "a commitment in two groups of one region counts once, in the lower group_id",
            [(11, 0, adds([member(0), member(1)])), (12, 0, adds([member(2), member(1), member(3)]))],
            1,
        ),
        (
            "repeat-within-group",
            "a commitment added twice to one group counts once: its second leaf is 0",
            [(11, 0, adds([member(0), member(1), member(0)]))],
            1,
        ),
        (
            "repeat-after-removal",
            "a commitment removed from a lower group counts in the higher one; removed and forbidden leaves are 0",
            [
                (11, 0, adds([member(0), member(1), 0, p01]) + [("remove", 0), ("remove", 9)]),
                (12, 1, adds([member(0), 1, member(2)])),
            ],
            2,
        ),
        (
            "groups-ordered-by-id",
            "a cell's leaves follow ascending group_id, not region order",
            [(11, 1, adds([member(0)])), (12, 0, adds([member(1)])), (13, 1, adds([member(2)]))],
            2,
        ),
        (
            "split",
            "two large regions (one of two groups) and a remainder of two small ones: three cells",
            [
                (21, 0, adds([member(i) for i in range(1000)])),
                (22, 1, adds([member(1000 + i) for i in range(700)])),
                (23, 2, adds([member(5000 + i) for i in range(10)])),
                (24, 1, adds([member(1700 + i) for i in range(500)])),
                (25, 3, adds([member(6000 + i) for i in range(995)])),
            ],
            4,
        ),
        (
            "repeat-moves-a-voter",
            "the victim's commitment, also added to a lower group in another region, counts there: its own leaf is 0",
            [
                (31, 0, adds([member(i) for i in range(999)] + [victim])),
                (32, 1, adds([member(2000 + i) for i in range(1000)])),
                (33, 2, adds([victim] + [member(4000 + i) for i in range(1000)])),
            ],
            3,
        ),
        (
            "repeat-keeps-region-below-floor",
            "1000 additions with one repeat count 999, so the region is small and folds; the remainder is below the floor, so the tier isn't split",
            [
                (41, 0, adds([member(i) for i in range(1500)])),
                (42, 1, adds([member(3000 + i) for i in range(999)] + [member(3000)])),
            ],
            2,
        ),
    ]
    out = []
    for cid, note, groups, region_count in cases:
        groups = sorted(groups)
        replayed = [tt.replay(c, m, tier_events(c, m, g[2]))[0] for g in groups]
        seen = set()
        deduped = []
        for leaves in replayed:
            row = []
            for x in leaves:
                if x != 0 and x in seen:
                    row.append(0)
                else:
                    if x != 0:
                        seen.add(x)
                    row.append(x)
            deduped.append(row)
        regions = [0] * region_count
        for (gid, region, _), leaves in zip(groups, deduped):
            regions[region] += sum(1 for x in leaves if x != 0)
        cells = []
        for cell_regions in fold(regions):
            idx = [i for i, g in enumerate(groups) if g[1] in cell_regions]
            leaves = [x for i in idx for x in deduped[i]]
            lv = tt.levels(c, m, z, leaves)
            entry = {
                "regions": cell_regions,
                "groups": [str(groups[i][0]) for i in idx],
                "root": str(tt.root_of(z, lv)),
                "members": str(sum(regions[r] for r in cell_regions)),
                "leafCount": len(leaves),
            }
            nonzero = [i for i, x in enumerate(leaves) if x != 0]
            picks = sorted({nonzero[0], nonzero[-1]}) if nonzero else []
            entry["paths"] = [
                {"index": i, "leaf": str(leaves[i]), "siblings": [str(s) for s in tt.path_of(z, lv, i)]} for i in picks
            ]
            cells.append(entry)
        if cid == "one-group":
            # The tier tree of tier-tree-vectors.py over the same group.
            assert cells[0]["root"] == str(tt.root_of(z, tt.levels(c, m, z, replayed[0])))
        out.append(
            {
                "id": cid,
                "note": note,
                "groups": [
                    {"groupId": str(g[0]), "region": g[1], "events": json_events(g[2])} for g in groups
                ],
                "regionCount": region_count,
                # Leaves are listed only for small tiers; every tier's cells carry roots and paths.
                **({"leaves": [[str(x) for x in row] for row in deduped]} if sum(map(len, deduped)) <= 32 else {}),
                "regions": [str(n) for n in regions],
                "cells": cells,
            }
        )
    return out


def main():
    c, m = tt.load_constants(sys.argv[1])
    out_dir = pathlib.Path(sys.argv[2])
    assert tt.poseidon2(c, m, 1, 2) == 7853200120776062878684798364095072458815029376092732009249414926327459813530
    gen = (
        "Printed by packages/crypto/scripts/regional-cells-vectors.py, written from docs/spec/election-definition.md "
        "(Layout (version 3), Regional cells, Well-formedness) and docs/spec/membership.md (Cell tree) with only the "
        "Python standard library, independently of packages/crypto, reusing definition-vectors.py's encoders and "
        "tier-tree-vectors.py's self-checked Poseidon2 and tier tree. Its own implementation of the rules confirms "
        "every valid vector's illFormed label (or its absence); decode errors are labelled by hand."
    )
    files = {
        "election-definition-v3.json": {
            "format": "abolish-vectors/1",
            "title": "Election definition, version 3 (regional cells)",
            "spec": "docs/spec/election-definition.md",
            "generator": gen,
            "types": DEF_TYPES,
            "vectors": def_vectors(),
        },
        "regional-cells.json": {
            "format": "abolish-regional-cells-vectors/1",
            "title": "Regional cells: the fold, first occurrence, region counts and cell trees",
            "spec": "docs/spec/election-definition.md",
            "generator": gen,
            "floor": str(FLOOR),
            "folds": [{"id": i, "note": n, "members": [str(x) for x in ms], "cells": fold(ms)} for i, n, ms in FOLDS],
            "tiers": build_tiers(c, m),
        },
    }
    for name, content in files.items():
        (out_dir / name).write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
