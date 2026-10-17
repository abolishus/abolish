#!/usr/bin/env python3
"""Prints docs/spec/vectors/self-paid.json.

Written from docs/spec/contracts.md (Group registry, Self-paid additions;
Verification, Self-paid groups) and docs/spec/membership.md (Cell tree, the
first-occurrence rule with signed groups first, then self-paid additions in
chain order) alone, independently of packages/crypto, with only the Python
standard library. It reuses tier-tree-vectors.py's Poseidon2 (self-checked
against circomlib's published answers) and tier tree, and
regional-cells-vectors.py's fold, both independent of packages/crypto too.

    python3 -I -B packages/crypto/scripts/self-paid-vectors.py \
      packages/crypto/test-vectors/iden3/poseidon_constants.json docs/spec/vectors

then `vp check --fix` to format the JSON.
"""

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


tt = load("tier_tree_vectors", "tier-tree-vectors.py")
rc = load("regional_cells_vectors", "regional-cells-vectors.py")

R = tt.R
U64_MAX = 2**64 - 1


def record(group_id, commitment):
    """u64(group_id) ‖ field<bn254>(commitment): exactly 40 bytes."""
    return group_id.to_bytes(8, "big") + commitment.to_bytes(32, "big")


def decode(c, m, b):
    """The self-paid record's stateless checks, in order: length, then commitment."""
    if len(b) != 40:
        return "length", None
    group_id = int.from_bytes(b[:8], "big")
    commitment = int.from_bytes(b[8:], "big")
    if tt.forbidden(c, m, commitment):
        return "forbidden-commitment", None
    return None, (group_id, commitment)


def replay(c, m, group_id, entries):
    """Verification, Self-paid groups: decoding, then group, then position (index = c)."""
    leaves = []
    for at, (index, b) in enumerate(entries):
        err, value = decode(c, m, b)
        if err is not None:
            return {"at": at, "reason": err}
        if value[0] != group_id:
            return {"at": at, "reason": "group"}
        if index != len(leaves) or len(leaves) >= 2**32:
            return {"at": at, "reason": "position"}
        leaves.append(value[1])
    return {"leaves": [str(x) for x in leaves]}


def records_vectors(c, m):
    p01 = tt.poseidon2(c, m, 0, 1)
    valid = [
        ("smallest", "group 0 and the smallest commitment that isn't forbidden", 0, 2),
        ("largest", "the last u64 group and the largest canonical field element", U64_MAX, R - 1),
        ("typical", "a group and a commitment in the middle of their ranges", 7, 0x1234567890ABCDEF << 128),
    ]
    out = {"valid": [], "rejected": []}
    for id_, note, g, v in valid:
        b = record(g, v)
        assert decode(c, m, b) == (None, (g, v))
        out["valid"].append({"id": id_, "note": note, "groupId": str(g), "commitment": str(v), "record": b.hex()})
    good = record(7, 1000)
    rejected = [
        ("empty", "no bytes", b"", "length"),
        ("short", "39 bytes", good[:-1], "length"),
        ("long", "41 bytes", good + b"\x00", "length"),
        ("signed-shape", "an addMembers header and one commitment, 50 bytes", good[:8] + bytes(10) + good[8:], "length"),
        ("zero", "commitment 0", record(7, 0), "forbidden-commitment"),
        ("one", "commitment 1", record(7, 1), "forbidden-commitment"),
        ("public-secret", "Poseidon2(0, 1), the commitment of the public secret 0", record(7, p01), "forbidden-commitment"),
        ("modulus", "the field modulus r, not canonical", record(7, R), "forbidden-commitment"),
        ("all-ones", "2^256 - 1, not canonical", record(7, 2**256 - 1), "forbidden-commitment"),
        ("short-and-forbidden", "39 bytes whose commitment would also be forbidden: length first", record(7, 0)[:-1], "length"),
    ]
    for id_, note, b, err in rejected:
        assert decode(c, m, b)[0] == err
        out["rejected"].append({"id": id_, "note": note, "record": b.hex(), "error": err})
    return out


def replay_vectors(c, m):
    g = 3
    p01 = tt.poseidon2(c, m, 0, 1)
    a, b, d = 10**9 + 1, 10**9 + 2, 10**9 + 3
    cases = [
        ("honest", "three additions at indices 0, 1 and 2, one of them a repeat", [(0, record(g, a)), (1, record(g, b)), (2, record(g, a))], {"leaves": None}),
        ("empty", "no additions: no leaves", [], {"leaves": None}),
        ("first-not-zero", "the first addition logs index 1", [(1, record(g, a))], {"at": 0, "reason": "position"}),
        ("skipped-index", "indices 0 then 2", [(0, record(g, a)), (2, record(g, b))], {"at": 1, "reason": "position"}),
        ("repeated-index", "indices 0 then 0", [(0, record(g, a)), (0, record(g, b))], {"at": 1, "reason": "position"}),
        ("other-group", "a record naming group 4 under group 3's topic", [(0, record(g, a)), (1, record(4, b))], {"at": 1, "reason": "group"}),
        ("length-before-group", "41 bytes naming group 4: decoding is reported first", [(0, record(4, a) + b"\x00")], {"at": 0, "reason": "length"}),
        ("forbidden-before-group", "a forbidden commitment naming group 4", [(0, record(4, p01))], {"at": 0, "reason": "forbidden-commitment"}),
        ("forbidden-before-position", "a forbidden commitment at the wrong index", [(0, record(g, a)), (5, record(g, 1))], {"at": 1, "reason": "forbidden-commitment"}),
        ("group-before-position", "group 4 at the wrong index: group is reported first", [(0, record(g, a)), (5, record(4, d))], {"at": 1, "reason": "group"}),
    ]
    out = []
    for id_, note, entries, expected in cases:
        result = replay(c, m, g, entries)
        if "leaves" in expected:
            assert "leaves" in result, id_
        else:
            assert result == expected, (id_, result)
        out.append(
            {
                "id": id_,
                "note": note,
                "groupId": str(g),
                "records": [{"index": str(i), "record": rec.hex()} for i, rec in entries],
                **result,
            }
        )
    return out


# --- the ranking (membership.md, Cell tree) -----------------------------------
#
# A case is a group list (id, region, kind) and the registry's log in chain
# order: ("add", group, [commitments]) a signed batch, ("remove", group,
# [indices]) a signed removal, ("self", group, commitment) a self-paid addition.


def leaves_of(groups, log):
    """Each group's tier-tree leaves (removed ones 0) and, for self-paid groups, each leaf's chain position."""
    leaves = {g: [] for g, _, _ in groups}
    chain = {g: [] for g, _, kind in groups if kind == "self-paid"}
    kinds = {g: kind for g, _, kind in groups}
    for pos, (op, g, arg) in enumerate(log):
        if op == "add":
            assert kinds[g] == "signed"
            leaves[g].extend(arg)
        elif op == "remove":
            assert kinds[g] == "signed"
            for i in arg:
                assert leaves[g][i] != 0
                leaves[g][i] = 0
        else:
            assert kinds[g] == "self-paid"
            leaves[g].append(arg)
            chain[g].append(pos)
    return leaves, chain


def rank(groups, leaves, chain):
    """First occurrence: signed groups by group_id, then self-paid leaves by chain position."""
    out = {g: list(v) for g, v in leaves.items()}
    seen = set()

    def visit(g, i):
        x = out[g][i]
        if x == 0:
            return
        if x in seen:
            out[g][i] = 0
        else:
            seen.add(x)

    for g, _, kind in sorted(groups):
        if kind == "signed":
            for i in range(len(out[g])):
                visit(g, i)
    order = sorted((pos, g, i) for g, ps in chain.items() for i, pos in enumerate(ps))
    for _, g, i in order:
        visit(g, i)
    return out


def json_log(log):
    out = []
    for op, g, arg in log:
        if op == "add":
            out.append({"group": str(g), "add": [str(x) for x in arg]})
        elif op == "remove":
            out.append({"group": str(g), "remove": [str(x) for x in arg]})
        else:
            out.append({"group": str(g), "selfPaid": str(arg)})
    return out


def member(i):
    return 10**9 + i


def batches(g, values):
    return [("add", g, values[i : i + 256]) for i in range(0, len(values), 256)]


def tier_cases():
    a, b, c_, d, e = (member(i) for i in range(5))
    return [
        (
            "copy-after-signed",
            "a self-paid copy of a signed member, in a lower group_id of another region, never displaces it",
            [(5, 1, "self-paid"), (10, 0, "signed")],
            [("add", 10, [a, b]), ("self", 5, c_), ("self", 5, a)],
            2,
        ),
        (
            "signed-copy-wins",
            "a signed copy landing after a self-paid registration still ranks first: the self-paid leaf is 0",
            [(5, 1, "self-paid"), (10, 0, "signed")],
            [("self", 5, a), ("self", 5, b), ("add", 10, [a, c_])],
            2,
        ),
        (
            "chain-order",
            "between self-paid copies the earlier addition counts, whatever the group_id",
            [(4, 0, "self-paid"), (9, 1, "self-paid")],
            [("self", 9, a), ("self", 4, b), ("self", 4, a), ("self", 9, c_)],
            2,
        ),
        (
            "removed-no-precedence",
            "a commitment removed from a signed group counts at its self-paid copy",
            [(2, 0, "signed"), (8, 1, "self-paid")],
            [("add", 2, [a, b]), ("remove", 2, [0]), ("self", 8, a)],
            2,
        ),
        (
            "repeat-within-self-paid",
            "a commitment added twice to one self-paid group counts once, at its first index",
            [(6, 0, "self-paid")],
            [("self", 6, a), ("self", 6, b), ("self", 6, a)],
            1,
        ),
        (
            "interleaved",
            "two signed and two self-paid groups over three regions: signed by group_id, then self-paid by chain order",
            [(1, 2, "self-paid"), (3, 0, "signed"), (7, 1, "self-paid"), (12, 1, "signed")],
            [
                ("self", 7, d),
                ("self", 1, d),
                ("add", 12, [b, e]),
                ("self", 1, a),
                ("add", 3, [a, c_]),
                ("self", 7, e),
                ("self", 7, member(5)),
                ("self", 1, member(6)),
                ("add", 12, [member(6)]),
                ("self", 1, member(7)),
            ],
            3,
        ),
        (
            "self-paid-split",
            "a self-paid region of 1000 distinct commitments is a cell of its own beside a signed one",
            [(1, 0, "signed"), (2, 1, "self-paid")],
            batches(1, [member(i) for i in range(1000)]) + [("self", 2, member(5000 + i)) for i in range(1000)],
            2,
        ),
        (
            "self-paid-copy-keeps-region-below-floor",
            "one of a self-paid region's 1000 additions copies a signed member, so it counts 999 and the tier isn't split",
            [(1, 0, "signed"), (2, 1, "self-paid")],
            batches(1, [member(i) for i in range(1000)])
            + [("self", 2, member(5000 + i)) for i in range(999)]
            + [("self", 2, member(17))],
            2,
        ),
    ]


def build_tiers(c, m):
    z = tt.zeros(c, m)
    out = []
    for id_, note, groups, log, region_count in tier_cases():
        groups = sorted(groups)
        leaves, chain = leaves_of(groups, log)
        ranked = rank(groups, leaves, chain)
        regions = [0] * region_count
        for g, region, _ in groups:
            regions[region] += sum(1 for x in ranked[g] if x != 0)
        cells = []
        for cell_regions in rc.fold(regions):
            ids = [g for g, region, _ in groups if region in cell_regions]
            cell_leaves = [x for g in ids for x in ranked[g]]
            lv = tt.levels(c, m, z, cell_leaves)
            nonzero = [i for i, x in enumerate(cell_leaves) if x != 0]
            picks = sorted({nonzero[0], nonzero[-1]}) if nonzero else []
            cells.append(
                {
                    "regions": cell_regions,
                    "groups": [str(g) for g in ids],
                    "root": str(tt.root_of(z, lv)),
                    "members": str(sum(regions[r] for r in cell_regions)),
                    "leafCount": len(cell_leaves),
                    "paths": [
                        {"index": i, "leaf": str(cell_leaves[i]), "siblings": [str(s) for s in tt.path_of(z, lv, i)]}
                        for i in picks
                    ],
                }
            )
        small = sum(len(v) for v in leaves.values()) <= 32
        out.append(
            {
                "id": id_,
                "note": note,
                "groups": [{"groupId": str(g), "region": region, "kind": kind} for g, region, kind in groups],
                "log": json_log(log),
                "regionCount": region_count,
                # Leaves are listed only for small tiers; every tier's cells carry roots and paths.
                **(
                    {
                        "leaves": [[str(x) for x in leaves[g]] for g, _, _ in groups],
                        "chainOrder": [[str(p) for p in chain[g]] if g in chain else None for g, _, _ in groups],
                        "ranked": [[str(x) for x in ranked[g]] for g, _, _ in groups],
                    }
                    if small
                    else {}
                ),
                "regions": [str(n) for n in regions],
                "cells": cells,
            }
        )
    return out


def main():
    c, m = tt.load_constants(sys.argv[1])
    out_dir = pathlib.Path(sys.argv[2])
    assert tt.poseidon2(c, m, 1, 2) == 7853200120776062878684798364095072458815029376092732009249414926327459813530
    content = {
        "format": "abolish-self-paid-vectors/1",
        "title": "Self-paid Tier 0 additions: the record, a self-paid group's replay and the first-occurrence ranking",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "Printed by packages/crypto/scripts/self-paid-vectors.py, written from docs/spec/contracts.md (Group "
            "registry, Self-paid additions; Verification, Self-paid groups) and docs/spec/membership.md (Cell tree) "
            "with only the Python standard library, independently of packages/crypto, reusing tier-tree-vectors.py's "
            "self-checked Poseidon2 and tier tree and regional-cells-vectors.py's fold. Each replay failure is written "
            "by hand and the script refuses to print one its own replay doesn't reproduce."
        ),
        "records": records_vectors(c, m),
        "replays": replay_vectors(c, m),
        "tiers": build_tiers(c, m),
    }
    (out_dir / "self-paid.json").write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
