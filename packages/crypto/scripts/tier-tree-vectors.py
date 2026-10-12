#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/tier-tree.json.

A second implementation of docs/spec/membership.md, Tier tree, and of
circomlib's two-input Poseidon, written with Python's standard library only
and sharing no code with packages/crypto. Poseidon follows circomlibjs's
reference implementation (src/poseidon_reference.js: t = 3, 8 full rounds,
57 partial rounds, x^5, state [0, a, b], output state[0]) with the round
constants and MDS matrix read from the vendored circomlibjs
src/poseidon_constants.json. Before printing anything it checks itself
against circomlib's published answers for Poseidon(1, 2) and Poseidon(3, 4).

Usage: python3 -I packages/crypto/scripts/tier-tree-vectors.py \
  packages/crypto/test-vectors/iden3/poseidon_constants.json <out-dir>
"""

import json
import pathlib
import sys

R = 0x30644E72E131A029B85045B68181585D2833E84879B9709143E1F593F0000001
DEPTH = 32
FULL, PARTIAL, T = 8, 57, 3


def load_constants(path):
    data = json.loads(pathlib.Path(path).read_text())
    c = [int(x, 16) for x in data["C"][T - 2]]
    m = [[int(x, 16) for x in row] for row in data["M"][T - 2]]
    assert len(c) == T * (FULL + PARTIAL) and len(m) == T
    return c, m


def poseidon2(c, m, a, b):
    assert 0 <= a < R and 0 <= b < R
    state = [0, a, b]
    for r in range(FULL + PARTIAL):
        state = [(x + c[r * T + i]) % R for i, x in enumerate(state)]
        if r < FULL // 2 or r >= FULL // 2 + PARTIAL:
            state = [pow(x, 5, R) for x in state]
        else:
            state[0] = pow(state[0], 5, R)
        state = [sum(m[i][j] * state[j] for j in range(T)) % R for i in range(T)]
    return state[0]


def forbidden(c, m, value):
    return value < 2 or value >= R or value == poseidon2(c, m, 0, 1)


def replay(c, m, events):
    """The lenient replay of Commitments and removals: leaves and group size."""
    leaves = []
    for e in events:
        if "add" in e:
            v = int(e["add"])
            leaves.append(0 if forbidden(c, m, v) else v)
        else:
            i = int(e["remove"])
            if i < len(leaves):
                leaves[i] = 0
    return leaves, sum(1 for x in leaves if x != 0)


def zeros(c, m):
    z = [0]
    for h in range(DEPTH):
        z.append(poseidon2(c, m, z[h], z[h]))
    return z


def levels(c, m, z, leaves):
    out = [list(leaves)]
    for h in range(DEPTH):
        below = out[h]
        up = []
        for j in range((len(below) + 1) // 2):
            left = below[2 * j]
            right = below[2 * j + 1] if 2 * j + 1 < len(below) else z[h]
            up.append(poseidon2(c, m, left, right))
        out.append(up)
    return out


def root_of(z, lv):
    return lv[DEPTH][0] if lv[DEPTH] else z[DEPTH]


def path_of(z, lv, index):
    return [lv[h][(index >> h) ^ 1] if (index >> h) ^ 1 < len(lv[h]) else z[h] for h in range(DEPTH)]


def main():
    c, m = load_constants(sys.argv[1])
    out_dir = pathlib.Path(sys.argv[2])
    # circomlib test/poseidoncircuit.js, "hash([1, 2]) t=3" and "hash([3, 4]) t=3".
    assert poseidon2(c, m, 1, 2) == 7853200120776062878684798364095072458815029376092732009249414926327459813530
    assert poseidon2(c, m, 3, 4) == 14763215145315200506921711489642608356394854266165572616578112107564877678998

    z = zeros(c, m)
    p01 = poseidon2(c, m, 0, 1)
    members = [poseidon2(c, m, 1000 + i, 2000 + i) for i in range(8)]

    hashes = [
        {"id": "one-two", "inputs": ["1", "2"]},
        {"id": "three-four", "inputs": ["3", "4"]},
        {"id": "zero-one", "inputs": ["0", "1"]},
        {"id": "zero-zero", "inputs": ["0", "0"]},
        {"id": "max", "inputs": [str(R - 1), str(R - 1)]},
    ]
    for h in hashes:
        h["output"] = str(poseidon2(c, m, int(h["inputs"][0]), int(h["inputs"][1])))

    add = lambda v: {"add": str(v)}
    rm = lambda i: {"remove": str(i)}
    trees = [
        ("empty", "no additions: the root is Z_32", []),
        ("one", "one member", [add(members[0])]),
        ("three", "three members", [add(x) for x in members[:3]]),
        ("eight", "a full subtree of height 3", [add(x) for x in members]),
        (
            "forbidden",
            "forbidden commitments keep their index with leaf 0 and aren't counted",
            [add(members[0]), add(0), add(1), add(p01), add(R), add(2**256 - 1), add(members[1])],
        ),
        ("only-forbidden", "every addition forbidden: the root is Z_32", [add(0), add(1), add(p01), add(R)]),
        ("removed", "a removal sets its leaf to 0", [add(x) for x in members[:4]] + [rm(1)]),
        (
            "removed-all",
            "every member removed: the root is Z_32",
            [add(members[0]), add(members[1]), rm(0), rm(1)],
        ),
        (
            "stray-removals",
            "removals of an index not yet added, of a removed leaf and far out of range change nothing",
            [add(members[0]), rm(1), add(members[1]), rm(0), rm(0), rm(2**40), add(members[2])],
        ),
        (
            "removal-not-reused",
            "an index freed by a removal is never reused",
            [add(members[0]), rm(0), add(members[1])],
        ),
        ("repeated", "a repeated commitment takes a second leaf", [add(members[0]), add(members[0])]),
    ]
    out_trees = []
    for tid, note, events in trees:
        leaves, size = replay(c, m, events)
        lv = levels(c, m, z, leaves)
        root = root_of(z, lv)
        entry = {
            "id": tid,
            "note": note,
            "events": events,
            "leaves": [str(x) for x in leaves],
            "groupSize": size,
            "root": str(root),
            "emptyRoot": root == z[DEPTH],
        }
        entry["paths"] = [
            {"index": i, "siblings": [str(s) for s in path_of(z, lv, i)]}
            for i in range(len(leaves))
            if leaves[i] != 0
        ][:3]
        out_trees.append(entry)

    out = {
        "format": "abolish-tier-tree-vectors/1",
        "title": "Tier trees: circomlib's Poseidon2, the empty-subtree chain, roots and paths",
        "spec": "docs/spec/membership.md",
        "generator": "packages/crypto/scripts/tier-tree-vectors.py: an independent Python implementation of circomlibjs's reference Poseidon over the vendored circomlibjs constants, checked against circomlib's published answers for Poseidon(1, 2) and Poseidon(3, 4)",
        "depth": DEPTH,
        "poseidon2": hashes,
        "zeros": [str(x) for x in z],
        "trees": out_trees,
    }
    (out_dir / "tier-tree.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
