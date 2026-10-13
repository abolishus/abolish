#!/usr/bin/env python3
"""Prints docs/spec/vectors/election-definition-v7.json and rolling-tier-tree.json.

Written from docs/spec/election-definition.md (Layout (version 7), Rolling
electorates, Well-formedness), docs/spec/membership.md (Rolling tier tree, Root
clock and steps, Scope) and docs/spec/parameters.md alone, independently of
packages/crypto, with only the Python standard library. It reuses
definition-v6-vectors.py's version-6 encoder, values and rules,
tier-tree-vectors.py's Poseidon2 (self-checked against circomlib's published
answers) and tier tree, and membership-vectors.py's Keccak-256 and field
mapping, all independent of packages/crypto too.

    python3 -I -B packages/crypto/scripts/rolling-electorate-vectors.py \
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


d6 = load("definition_v6_vectors", "definition-v6-vectors.py")
d5, d4, dv = d6.d5, d6.d4, d6.dv
tt = load("tier_tree_vectors", "tier-tree-vectors.py")
mv = load("membership_vectors", "membership-vectors.py")

R = dv.R
U64_MAX = dv.U64_MAX
u8, u64, field, lst, ds, H = dv.u8, dv.u64, dv.field, dv.lst, dv.ds, dv.H
MAX_GROUPS = 1024
FIXED, ROLLING = 1, 2
EVERYDAY, ORGANISATIONAL, CIVIC = d6.EVERYDAY, d6.ORGANISATIONAL, d6.CIVIC
ROOT_PERIOD, ROOT_OFFSET, ROOT_WINDOW = 600, 300, 7200  # parameters.md
ROLLING_SCOPE_TAG = "abolish/v1/rolling-nullifier-scope"


def tau(n):
    """Membership, Root clock and steps: boundary n in UNIX seconds."""
    assert 0 <= n < 2**32
    return n * ROOT_PERIOD + ROOT_OFFSET


# --- version-7 layout ---------------------------------------------------------


def enc_rolling_tier(t):
    return u8(t["tier"]) + u64(t["root_l2_block"]) + lst(t["groups"], MAX_GROUPS, u64) + field(t["root"]) + u64(t["group_size"])


def enc_definition_v7(d, version=7):
    """Written from Layout (version 7): version 6's fields, then two more."""
    return d6.enc_definition_v6(d, version) + u8(d["electorate_mode"]) + lst(d["rolling_electorate"], 3, enc_rolling_tier)


NEW_FIELDS = ["electorate_mode", "rolling_electorate"]


def as_v6(d):
    return {k: v for k, v in d.items() if k not in NEW_FIELDS}


def def_json(d):
    j = d6.def_json(as_v6(d))
    j["electorate_mode"] = str(d["electorate_mode"])
    j["rolling_electorate"] = [
        {
            "tier": str(t["tier"]),
            "root_l2_block": str(t["root_l2_block"]),
            "groups": [str(g) for g in t["groups"]],
            "root": field(t["root"]).hex(),
            "group_size": str(t["group_size"]),
        }
        for t in d["rolling_electorate"]
    ]
    order = [f["name"] for f in DEF_TYPES["election-definition-v7"]["fields"]]
    assert order == list(j), "the layout's field order"
    return j


U64 = {"kind": "u64"}
DEF_TYPES = {k: v for k, v in d6.DEF_TYPES.items() if k != "election-definition-v6"}
DEF_TYPES["rolling-tier"] = {
    "kind": "struct",
    "fields": [
        {"name": "tier", "type": {"kind": "enum8", "values": ["0", "1", "2"]}},
        {"name": "root_l2_block", "type": U64},
        {"name": "groups", "type": {"kind": "list", "max": MAX_GROUPS, "of": U64}},
        {"name": "root", "type": {"kind": "field", "field": "bn254"}},
        {"name": "group_size", "type": U64},
    ],
}
DEF_TYPES["election-definition-v7"] = {
    "kind": "record",
    "recordType": "0001",
    "version": 7,
    "fields": d6.DEF_TYPES["election-definition-v6"]["fields"]
    + [
        {"name": "electorate_mode", "type": {"kind": "enum8", "values": ["1", "2"]}},
        {"name": "rolling_electorate", "type": {"kind": "list", "max": 3, "of": d4.ref("rolling-tier")}},
    ],
}

# --- well-formedness (election-definition.md, Well-formedness) -------------

BEFORE_ELECTORATE = {"protocol-major", "profile-order", "profile-types", "profile-version", "questions", "option-count", "selections"}
# A version-3 electorate that passes `electorate` and `cells`, standing in for
# a rolling definition's empty one so version 6's other rules can be read.
STAND_IN = copy.deepcopy(d5.TYPICAL["electorate"])


def mode_electorate_rule(d):
    """Version 7's part of `electorate`: the list the mode doesn't use is empty, and the rolling list's own shape."""
    rolling = d["rolling_electorate"]
    if d["electorate_mode"] == FIXED:
        return "electorate" if rolling else None
    tiers = [t["tier"] for t in rolling]
    if d["electorate"] or not rolling or any(tiers[i - 1] >= tiers[i] for i in range(1, len(tiers))):
        return "electorate"
    return None


def rolling_tier_rule(d):
    if d["electorate_mode"] != ROLLING:
        return None
    seen = set()
    for t in d["rolling_electorate"]:
        g = t["groups"]
        if not g or any(g[i - 1] >= g[i] for i in range(1, len(g))) or seen & set(g):
            return "rolling-tier"
        seen |= set(g)
    return None


def definition_rule(d):
    """(code, question) of the first failing rule, or None: version 6's, with `electorate` reading the mode, then version 7's."""
    v6 = as_v6(d)
    if d["electorate_mode"] == ROLLING and mode_electorate_rule(d) is None:
        v6 = dict(v6, electorate=STAND_IN)
    r6 = d6.definition_rule(v6)
    if r6 is not None and r6[0] in BEFORE_ELECTORATE:
        return r6
    own = mode_electorate_rule(d)
    if own is not None:
        return own, None
    if r6 is not None:
        return r6
    if d["electorate_mode"] == ROLLING and d["poll_class"] != EVERYDAY:
        return "rolling-class", None
    r = rolling_tier_rule(d)
    return (r, None) if r else None


# --- definitions ----------------------------------------------------------------

PINS_V7 = [(1, 7)] + d6.PINS_V6[1:]
PROFILE = {"protocol_major": 1, "pins": PINS_V7}

ROLLING_T0 = {"tier": 0, "root_l2_block": 41_000_000, "groups": [1, 2, 5], "root": 0x1D2C3B4A5968778695A4B3C2D1E0F00112233445566778899AABBCCDDEEFF00, "group_size": 9104}
ROLLING_T2 = {"tier": 2, "root_l2_block": 41_000_000, "groups": [3], "root": 0x0ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF01234567, "group_size": 318}

FIXED_TYPICAL = dict(copy.deepcopy(d6.TYPICAL), profile=PROFILE, electorate_mode=FIXED, rolling_electorate=[])
TYPICAL = dict(copy.deepcopy(FIXED_TYPICAL), electorate=[], electorate_mode=ROLLING, rolling_electorate=[ROLLING_T0, ROLLING_T2])
MINIMAL = dict(copy.deepcopy(d6.MINIMAL), profile=PROFILE, electorate_mode=FIXED, rolling_electorate=[])
ROLLING_MINIMAL = dict(
    copy.deepcopy(MINIMAL),
    electorate=[],
    electorate_mode=ROLLING,
    rolling_electorate=[{"tier": 0, "root_l2_block": 0, "groups": [0], "root": 0, "group_size": 0}],
)
MAXIMAL = dict(
    copy.deepcopy(d6.MAXIMAL),
    profile={"protocol_major": 1, "pins": [(1, 7)] + d6.MAXIMAL["profile"]["pins"][1:]},
    poll_class=EVERYDAY,
    electorate=[],
    electorate_mode=ROLLING,
    rolling_electorate=[
        {"tier": t, "root_l2_block": U64_MAX, "groups": [U64_MAX - 3 * MAX_GROUPS + t * MAX_GROUPS + i for i in range(MAX_GROUPS)], "root": R - 1 - t, "group_size": U64_MAX}
        for t in range(3)
    ],
)


def variant(base, **changes):
    d = copy.deepcopy(base)
    d.update(changes)
    return d


def tier_variant(base, at, **changes):
    d = copy.deepcopy(base)
    d["rolling_electorate"][at].update(changes)
    return d


def def_vectors():
    T = d4.ref("election-definition-v7")
    vs = []

    def valid(id_, d, desc, rule=None, at=None):
        e = enc_definition_v7(d)
        v = {"id": id_, "description": desc, "type": T, "value": def_json(d), "encoding": e.hex()}
        v["hash"] = H(ds("abolish/v1/election-definition", e)).hex()
        stub = dict(d, ceremony_transcript_hash=bytes(32))
        v["stubHash"] = H(ds("abolish/v1/election-stub", enc_definition_v7(stub))).hex()
        v["authorStubHash"] = H(ds("abolish/v1/election-stub", enc_definition_v7(dict(stub, author_transcript_hash=bytes(32))))).hex()
        want = None if rule is None else (rule, at)
        assert definition_rule(d) == want, (id_, definition_rule(d), want)
        if rule is not None:
            v["illFormed"] = rule
        if at is not None:
            v["illFormedQuestion"] = str(at)
        if d["electorate_mode"] == ROLLING:
            # Membership, Rolling scope: one per tier, from the definition hash alone.
            v["rollingScopes"] = [
                {"tier": str(t["tier"]), "scope": rolling_scope(bytes.fromhex(v["hash"]), t["tier"]).hex()} for t in d["rolling_electorate"]
            ]
        vs.append(v)

    def invalid(id_, enc, err, desc):
        vs.append({"id": id_, "description": desc, "type": T, "encoding": enc.hex(), "error": err})

    # Version 7's bytes are version 6's, labelled 7, followed by the new fields.
    assert enc_definition_v7(FIXED_TYPICAL) == d6.enc_definition_v6(as_v6(FIXED_TYPICAL), version=7) + u8(1) + dv.u32(0)

    valid("definition-v7-rolling-typical", TYPICAL, "Version 6's typical definition with a rolling electorate: Tier 0 over groups 1, 2 and 5 and Tier 2 over group 3, both opening at one block")
    valid("definition-v7-fixed-typical", FIXED_TYPICAL, "Version 6's typical definition under electorate_mode 1: its regional electorate, and rolling_electorate empty")
    valid("definition-v7-fixed-minimal", MINIMAL, "Version 6's minimal definition under electorate_mode 1")
    valid(
        "definition-v7-rolling-minimal",
        ROLLING_MINIMAL,
        "A rolling Tier 0 over group 0 that opens with no live member: root 0 and size 0 decode and are well formed (the verifier, not well-formedness, requires the empty tree's root, Z_32)",
    )
    valid(
        "definition-v7-rolling-lists-at-max",
        MAXIMAL,
        "Three rolling tiers of 1024 groups each, every integer at its largest, beside version 6's lists at their maximum: an everyday poll",
    )
    valid(
        "definition-v7-fixed-civic",
        variant(MINIMAL, poll_class=CIVIC),
        "A civic referendum with a fixed electorate: rolling-class reads only rolling definitions",
    )

    te = enc_definition_v7(TYPICAL)
    end6 = len(d6.enc_definition_v6(as_v6(TYPICAL)))
    invalid("definition-v7-truncated", te[:-1], "truncated", "The last byte of the last rolling tier's group_size is missing")
    invalid("definition-v7-trailing", te + b"\x00", "trailing-bytes", "One byte after rolling_electorate")
    for value in (0, 3):
        invalid(
            f"definition-v7-electorate-mode-{value}",
            te[:end6] + u8(value) + te[end6 + 1 :],
            "invalid-enum",
            f"electorate_mode {value}; version 7 allows 1 and 2",
        )
    list_at = end6 + 1
    assert te[list_at : list_at + 4] == dv.u32(2)
    invalid(
        "definition-v7-rolling-electorate-over-max",
        te[:list_at] + dv.u32(4) + te[list_at + 4 :],
        "length-over-max",
        "A rolling_electorate count of 4, over its maximum of 3",
    )
    invalid("definition-v7-rolling-tier-three", te[: list_at + 4] + u8(3) + te[list_at + 5 :], "invalid-enum", "A rolling tier with tier 3")
    groups_at = list_at + 4 + 1 + 8
    assert te[groups_at : groups_at + 4] == dv.u32(3)
    invalid(
        "definition-v7-rolling-groups-over-max",
        te[:groups_at] + dv.u32(MAX_GROUPS + 1) + te[groups_at + 4 :],
        "length-over-max",
        "A rolling tier's groups count of 1025, over its maximum of 1024, rejected before any group is read",
    )
    root_at = groups_at + 4 + 8 * 3
    invalid("definition-v7-rolling-root-r", te[:root_at] + R.to_bytes(32, "big") + te[root_at + 32 :], "non-canonical", "A rolling tier's root equal to r")
    invalid(
        "definition-v7-version-eight",
        enc_definition_v7(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 8)] + PINS_V7[1:]}), version=8),
        "unknown-version",
        "Version 7's layout labelled version 8, which has no layout",
    )
    invalid(
        "definition-v7-profile-pins-six",
        enc_definition_v7(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 6)] + PINS_V7[1:]})),
        "profile-mismatch",
        "A version-7 definition whose own profile pins 0x0001 at version 6",
    )
    invalid(
        "definition-v7-labelled-six",
        enc_definition_v7(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 6)] + PINS_V7[1:]}), version=6),
        "trailing-bytes",
        "Version 7's bytes labelled version 6, with a profile pinning 6: version 6's layout ends at author_transcript_hash, before electorate_mode",
    )
    invalid(
        "definition-v6-labelled-seven",
        d6.enc_definition_v6(as_v6(FIXED_TYPICAL), version=7),
        "truncated",
        "Version 6's bytes labelled version 7, with a profile pinning 7: the record ends where electorate_mode begins. (election-definition-v6.json's definition-v6-version-seven, unknown-version, is read by a decoder of versions 5 and 6 only.)",
    )

    rt0 = TYPICAL["rolling_electorate"][0]
    ill = [
        ("electorate", "definition-v7-rolling-with-fixed-electorate", variant(TYPICAL, electorate=copy.deepcopy(STAND_IN)), "Rolling, with a regional electorate beside the rolling one"),
        ("electorate", "definition-v7-rolling-empty", variant(TYPICAL, rolling_electorate=[]), "Rolling, with no rolling tiers"),
        ("electorate", "definition-v7-rolling-tiers-unsorted", variant(TYPICAL, rolling_electorate=[ROLLING_T2, ROLLING_T0]), "Tier 2 before Tier 0"),
        ("electorate", "definition-v7-rolling-tier-repeated", variant(TYPICAL, rolling_electorate=[ROLLING_T0, dict(ROLLING_T2, tier=0)]), "Tier 0 twice"),
        ("electorate", "definition-v7-fixed-with-rolling", variant(FIXED_TYPICAL, rolling_electorate=[ROLLING_T0]), "Fixed, with a rolling tier beside its electorate"),
        ("electorate", "definition-v7-fixed-empty", variant(FIXED_TYPICAL, electorate=[]), "Fixed, with no tiers: version 6's rule"),
        ("rolling-class", "definition-v7-rolling-organisational", variant(TYPICAL, poll_class=ORGANISATIONAL), "A rolling organisational vote"),
        ("rolling-class", "definition-v7-rolling-civic", variant(TYPICAL, poll_class=CIVIC, results_mode=1, live_every=0, live_batch=0), "A rolling civic referendum, sealed"),
        ("rolling-tier", "definition-v7-rolling-no-groups", tier_variant(TYPICAL, 1, groups=[]), "A rolling tier with no groups"),
        ("rolling-tier", "definition-v7-rolling-groups-unsorted", tier_variant(TYPICAL, 0, groups=[2, 1, 5]), "Group 2 before group 1"),
        ("rolling-tier", "definition-v7-rolling-group-twice", tier_variant(TYPICAL, 0, groups=[1, 2, 2, 5]), "Group 2 listed twice in one tier"),
        ("rolling-tier", "definition-v7-rolling-group-in-two-tiers", tier_variant(TYPICAL, 1, groups=[2]), "Group 2 in Tier 0 and in Tier 2"),
        ("rolling-class", "definition-v7-rolling-civic-and-groups-broken", tier_variant(variant(TYPICAL, poll_class=ORGANISATIONAL), 1, groups=[]), "A rolling organisational vote with a tier of no groups: rolling-class comes before rolling-tier"),
        ("author-panel", "definition-v7-author-and-class-broken", variant(TYPICAL, poll_class=ORGANISATIONAL, author_threshold=4), "A rolling organisational vote with a 4-of-3 author panel: version 6's rules come first"),
        ("civic-sealed", "definition-v7-civic-live-rolling", variant(TYPICAL, poll_class=CIVIC), "A live rolling civic referendum: civic-sealed comes before rolling-class"),
        ("electorate", "definition-v7-electorate-and-panel-broken", variant(TYPICAL, rolling_electorate=[], threshold=1), "Rolling with no tiers and threshold 1: electorate comes before panel"),
        ("selections", "definition-v7-selections-and-electorate-broken", variant(TYPICAL, questions=[d5.q(3, 0, 0)], rolling_electorate=[]), "A question no ballot can answer and no rolling tiers: the question is reported first"),
        ("panel", "definition-v7-panel-and-groups-broken", tier_variant(variant(TYPICAL, threshold=1), 0, groups=[]), "threshold 1 and a tier with no groups: panel, a version-1 rule, comes before rolling-tier"),
    ]
    for rule, id_, d, desc in ill:
        valid(id_, d, desc, rule, 0 if rule == "selections" else None)
    assert rt0 is TYPICAL["rolling_electorate"][0]
    return vs


# --- scopes (membership.md, Scope, Rolling scope) ---------------------------


def rolling_scope(definition_hash, tier):
    assert len(definition_hash) == 32 and tier in (0, 1, 2)
    return H(ds(ROLLING_SCOPE_TAG, definition_hash + bytes([tier])))


def scope_vectors():
    out = []
    hashes = [("zeros", bytes(32)), ("ones", b"\xff" * 32), ("counting", bytes(range(32)))]
    for name, h in hashes:
        for t in (0, 1, 2):
            s = rolling_scope(h, t)
            fixed_scope = mv.scope(h, t, 1)
            assert s != fixed_scope
            out.append({"id": f"rolling-scope-{name}-tier-{t}", "definitionHash": h.hex(), "tier": t, "scope": s.hex(), "scopeField": str(mv.field_map(s))})
    return out


# --- rolling tier trees (membership.md, Rolling tier tree, Root clock and steps)


def rolling_leaves(events, groups, through):
    """Leaves in chain order over `events` (already in log order) that `through` admits, the listed groups only."""
    leaves = []
    where = {}  # (group, member index) -> leaf index
    counts = {}
    for e in events:
        if not through(e) or e["group"] not in groups:
            continue
        g = e["group"]
        if "add" in e:
            for c in e["add"]:
                where[(g, counts.get(g, 0))] = len(leaves)
                counts[g] = counts.get(g, 0) + 1
                leaves.append(c)
        else:
            for i in e["remove"]:
                assert (g, i) in where and leaves[where[(g, i)]] != 0, "a strictly replayed removal"
                leaves[where[(g, i)]] = 0
    return leaves


def member_count(leaves):
    return len({x for x in leaves if x != 0})


def tree_root(c, m, z, leaves):
    return tt.root_of(z, tt.levels(c, m, z, leaves))


N0 = 2_966_400  # a step of 2026, so the numbers look like the real clock's


def tree_cases():
    def mem(i):
        return 10**12 + i

    t = tau(N0)
    a, b, x, u = 1, 2, 7, 9  # listed groups a and b; x and u not listed
    cases = []
    # 1. Chain order across two listed groups, an unlisted group skipped, and
    # events at, just before and just after boundaries.
    ev = [
        {"block": 100, "timestamp": t - 1200, "group": a, "add": [mem(1), mem(2)]},
        {"block": 101, "timestamp": t - 898, "group": x, "add": [mem(900)]},
        {"block": 101, "timestamp": t - 898, "group": b, "add": [mem(3)]},
        {"block": 150, "timestamp": t - 1, "group": a, "add": [mem(4)]},
        {"block": 151, "timestamp": t, "group": b, "add": [mem(5), mem(6)]},
        {"block": 152, "timestamp": t + 1, "group": a, "add": [mem(7)]},
        {"block": 450, "timestamp": t + 599, "group": u, "add": [mem(901)]},
        {"block": 451, "timestamp": t + 600, "group": a, "add": [mem(8)]},
        {"block": 452, "timestamp": t + 601, "group": b, "add": [mem(9)]},
    ]
    cases.append(("chain-order", "two listed groups interleaved in log order, an unlisted group skipped, and additions at, one second before and one second after boundaries; the opening block's timestamp is a boundary, which is never accepted", [a, b], (100, t - 1200), ev, [N0 - 2, N0 - 1, N0, N0 + 1, N0 + 2]))
    # 2. Repeats, removal and re-addition: one leaf per occurrence, one member.
    ev = [
        {"block": 200, "timestamp": t - 700, "group": a, "add": [mem(10), mem(11)]},
        {"block": 201, "timestamp": t - 650, "group": b, "add": [mem(11), mem(12)]},
        {"block": 202, "timestamp": t - 640, "group": a, "add": [mem(10)]},
        {"block": 260, "timestamp": t - 10, "group": a, "remove": [0]},
        {"block": 400, "timestamp": t + 300, "group": b, "remove": [0]},
        {"block": 410, "timestamp": t + 400, "group": a, "remove": [2]},
        {"block": 700, "timestamp": t + 900, "group": b, "add": [mem(10), mem(11)]},
    ]
    cases.append(("repeats-and-re-additions", "a commitment in both groups and twice in one, removals by member index that zero one occurrence only, and re-additions: the member count counts distinct live commitments", [a, b], (200, t - 700), ev, [N0 - 1, N0, N0 + 1, N0 + 2]))
    # 3. Opening empty; the first step with a member; every member removed.
    ev = [
        {"block": 300, "timestamp": t - 300, "group": x, "add": [mem(30)]},
        {"block": 320, "timestamp": t - 200, "group": a, "add": [mem(31)]},
        {"block": 600, "timestamp": t + 500, "group": a, "remove": [0]},
        {"block": 900, "timestamp": t + 1100, "group": a, "add": [mem(32)]},
    ]
    cases.append(("empty-opening", "a tier that opens with no live member (Z_32, count 0), gains one, loses it to a removal, and gains another: steps with no live leaf are never accepted", [a], (310, t - 250), ev, [N0 - 1, N0, N0 + 1, N0 + 2]))
    return cases


def build_trees(c, m):
    z = tt.zeros(c, m)
    out = []
    for cid, note, groups, (root_block, root_ts), events, steps in tree_cases():
        # The opening block's timestamp sits between its neighbours' events.
        assert all((e["block"] <= root_block) == (e["timestamp"] <= root_ts) for e in events)
        closes_at = tau(steps[-2])  # the last step but one closes the poll
        opening = rolling_leaves(events, groups, lambda e: e["block"] <= root_block)
        entry = {
            "id": cid,
            "note": note,
            "groups": [str(g) for g in groups],
            "events": [
                {
                    "block": str(e["block"]),
                    "timestamp": str(e["timestamp"]),
                    "group": str(e["group"]),
                    **({"add": [str(v) for v in e["add"]]} if "add" in e else {"remove": [str(i) for i in e["remove"]]}),
                }
                for e in events
            ],
            "rootL2Block": str(root_block),
            "rootL2Timestamp": str(root_ts),
            "closesAt": str(closes_at),
            "opening": {"leaves": [str(v) for v in opening], "root": str(tree_root(c, m, z, opening)), "memberCount": str(member_count(opening))},
            "steps": [],
        }
        for n in steps:
            leaves = rolling_leaves(events, groups, lambda e, n=n: e["timestamp"] <= tau(n))
            root = tree_root(c, m, z, leaves)
            live = member_count(leaves)
            accepted = tau(n) > root_ts and tau(n) <= closes_at and len(leaves) <= 2**32 and live > 0
            assert (root == z[32]) == (live == 0)
            entry["steps"].append(
                {"step": str(n), "tau": str(tau(n)), "leaves": [str(v) for v in leaves], "root": str(root), "memberCount": str(live), "accepted": accepted}
            )
        out.append(entry)
    return out


def window_vectors():
    """Membership, Root clock and steps, The window: t − ROOT_WINDOW < τ_n ≤ t."""
    n = N0
    t = tau(n)
    cases = [
        ("at-boundary", t, "in", "the reference's timestamp equals τ_n"),
        ("one-second-early", t - 1, "future", "the reference is one second before τ_n"),
        ("inside", t + 1800, "in", "half an hour after τ_n"),
        ("last-second", t + ROOT_WINDOW - 1, "in", "ROOT_WINDOW − 1 seconds after τ_n"),
        ("window-edge", t + ROOT_WINDOW, "stale", "exactly ROOT_WINDOW after τ_n: the window is open at its old end"),
        ("long-after", t + 10 * ROOT_WINDOW, "stale", "ten windows after τ_n"),
    ]
    out = []
    for cid, l1, verdict, note in cases:
        got = "future" if t > l1 else ("stale" if t <= l1 - ROOT_WINDOW else "in")
        assert got == verdict, cid
        out.append({"id": cid, "note": note, "step": str(n), "l1Timestamp": str(l1), "window": verdict})
    return out


def main():
    c, m = tt.load_constants(sys.argv[1])
    out_dir = pathlib.Path(sys.argv[2])
    assert tt.poseidon2(c, m, 1, 2) == 7853200120776062878684798364095072458815029376092732009249414926327459813530
    mv.self_check()
    gen = (
        "Printed by packages/crypto/scripts/rolling-electorate-vectors.py, written from docs/spec/election-definition.md "
        "(Layout (version 7), Rolling electorates, Well-formedness), docs/spec/membership.md (Rolling tier tree, Root clock "
        "and steps, Scope) and docs/spec/parameters.md with only the Python standard library, independently of "
        "packages/crypto, reusing definition-v6-vectors.py's version-6 encoder, values and rules, tier-tree-vectors.py's "
        "self-checked Poseidon2 and tier tree, and membership-vectors.py's self-checked Keccak-256. Its encoder is checked "
        "against version 6's: version 7's bytes are version 6's followed by the new fields. Its own implementation of the "
        "rules confirms every valid vector's illFormed label (or its absence); decode errors are labelled by hand."
    )
    files = {
        "election-definition-v7.json": {
            "format": "abolish-vectors/1",
            "title": "Election definition, version 7 (electorate mode and rolling electorates)",
            "spec": "docs/spec/election-definition.md",
            "generator": gen,
            "tags": {"rollingScope": ROLLING_SCOPE_TAG},
            "types": DEF_TYPES,
            "vectors": def_vectors(),
        },
        "rolling-tier-tree.json": {
            "format": "abolish-rolling-tier-tree-vectors/1",
            "title": "Rolling tier trees, the root clock, accepted steps, the window and rolling scopes",
            "spec": "docs/spec/membership.md",
            "generator": gen,
            "rootPeriod": str(ROOT_PERIOD),
            "rootOffset": str(ROOT_OFFSET),
            "rootWindow": str(ROOT_WINDOW),
            "trees": build_trees(c, m),
            "windows": window_vectors(),
            "scopes": scope_vectors(),
        },
    }
    for name, content in files.items():
        (out_dir / name).write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
