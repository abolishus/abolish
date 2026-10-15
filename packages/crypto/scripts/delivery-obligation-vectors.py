#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/delivery-obligation.json.

A second implementation of docs/spec/delivery.md's What a node owes and
Capacity: the receipts a trustee node owes through the contract path, its
complaint scope, and whether a set of elections fits the forced path at the
portal's target. It is written from the spec with Python's standard library
only and shares no code with packages/crypto. Selection and the L1 reference
check are revoting-vectors.py's (selection by sorting, not packages/crypto's
scan); the capacity check here sweeps every interval's start and end in time
order with exact fractions, where packages/crypto compares cross-multiplied
integers at the starts only.

Usage: python3 -I -B packages/crypto/scripts/delivery-obligation-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import hashlib
import importlib.util
import json
import pathlib
import sys
from fractions import Fraction

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rv = _load("revoting_vectors", "revoting-vectors.py")

DELIVERY_WINDOW = 172_800
COMPLAINT_WINDOW = 432_000
MAX_TRUSTEES = 16
HOUR = 3600

# The portal's metering as Base's and Base Sepolia's SystemConfig set it
# (resourceConfig(): maxResourceLimit, elasticityMultiplier), and its cap on a
# deposit's data (docs/adr/0004-l2-choice.md, Forced inclusion).
MAX_RESOURCE_LIMIT = 20_000_000
ELASTICITY = 10
MAX_DEPOSIT_DATA = 120_000

# The forced path's figures (docs/spec/delivery.md, Capacity).
FORCED_PATH = {
    "depositGasTarget": MAX_RESOURCE_LIMIT // ELASTICITY,
    "l1BlockSeconds": 13,
    "receiptsPerCall": 256,
    "receiptCallGas": 17_000_000,
    "complaintCallGas": 150_000,
}
RECEIPT_LENGTH = 164

# Hourly periods, a 12-hour anchoring deadline, F and W_C of 13 hours.
DEPLOYED = {
    "period": HOUR,
    "deadline": 12 * HOUR,
    "contractEventWindow": 13 * HOUR,
    "forcedInclusion": 13 * HOUR,
}


def det(label, i=0):
    return hashlib.sha256(f"abolish delivery-obligation vectors {label} {i}".encode()).digest()


# --- What a node owes -------------------------------------------------------

# A finalized L1: blocks 0 to HEAD, 12 seconds apart; the poll closes at
# block 10's time and block 11, after close, is final, so no reference is
# pending. Ballots name blocks REF_MIN to 10 to be admitted.
HEAD = 11
REF_MIN = 2
CHAIN = {n: (det("block", n), 1_700_000_000 + 12 * n) for n in range(0, HEAD + 1)}
CLOSES_AT = CHAIN[10][1]
# The close rule's window (docs/spec/close.md, Window): an ordinary copy's L2
# timestamp or a relayed copy's stamp within [OPENS_AT, CLOSES_AT], a
# board-path copy's segment at most S_A.
OPENS_AT = CHAIN[3][1]
S_A = 50


def in_window(entry):
    """Verifier 5.5 for the entry that carries a copy; None for a copy held only from intake."""
    if entry is None:
        return True
    path, value = entry
    if path == "board":
        return value <= S_A
    assert path in ("ordinary", "relayed")
    return OPENS_AT <= value <= CLOSES_AT


def obligations(view, receipts, head=HEAD):
    """Owed receipts and the complaint scope, from the spec's reading.

    view: ballots, each a dict with hash, tier, nullifier, message, ref,
    refHash and entry ((path, value), or None for a copy held only from
    intake). receipts: the ballot hashes the node receipted. Returns (owed,
    scope), each a sorted list of ballot hashes, or raises ValueError.
    """
    for b in view:
        if b["tier"] not in (0, 1, 2):
            raise ValueError("tier")
        if not 0 <= b["nullifier"] < rv.R:
            raise ValueError("nullifier")
    # 5.5 before 5.8 and selection: a copy outside the window never counts or
    # displaces another.
    view = [b for b in view if in_window(b["entry"])]
    verdict = {
        id(b): rv.check_reference(b["ref"], b["refHash"], CHAIN, head, REF_MIN, CLOSES_AT) for b in view
    }
    if "pending" in verdict.values():
        raise ValueError("pending")
    admitted = [b for b in view if verdict[id(b)] == "admitted"]
    others = [b for b in view if verdict[id(b)] != "admitted"]
    hash_of = {}
    for b in admitted:
        if hash_of.setdefault(b["message"], b["hash"]) != b["hash"]:
            raise ValueError("message")
    chosen = rv.select(
        [rv.ballot(b["tier"], b["nullifier"], b["message"], b["ref"], i) for i, b in enumerate(admitted)]
    )["selected"]
    selected = [admitted[i]["hash"] for i in chosen]

    def newest_unadmitted(counts):
        # Per tier and nullifier: the highest reference, the smaller hash on a tie.
        best = {}
        for b in sorted(others, key=lambda b: (-b["ref"], b["hash"])):
            if counts(b["hash"]):
                best.setdefault((b["tier"], b["nullifier"]), b["hash"])
        return set(best.values())

    receipted = set(receipts)
    owed = {h for h in selected if h in receipted} | newest_unadmitted(lambda h: h in receipted)
    scope = set(selected) | newest_unadmitted(lambda h: True)
    return sorted(owed), sorted(scope)


def vb(core, cast, ref, tier=0, nullifier=7, ref_hash=None, entry=None):
    """A view ballot: `core` names its ballot hash, `cast` its message."""
    return {
        "entry": entry,
        "hash": det("ballot", core),
        "tier": tier,
        "nullifier": nullifier,
        "message": det("message", cast),
        "ref": ref,
        "refHash": CHAIN[ref][0] if ref_hash is None and ref <= HEAD else (ref_hash or det("other", ref)),
    }


def obligation_cases():
    reorged = det("reorganised")
    return [
        ("newest", "The newest of two ballots is owed and is the scope", [vb(1, 1, 4), vb(2, 2, 6)], [1, 2]),
        (
            "per-group",
            "One per tier and nullifier",
            [vb(1, 1, 4), vb(2, 2, 5, nullifier=8), vb(3, 3, 6, tier=2)],
            [1, 2, 3],
        ),
        ("tie", "A tie at the newest block selects nothing", [vb(1, 1, 4), vb(2, 2, 6), vb(3, 3, 6)], [1, 2, 3]),
        (
            "not-receipted",
            "A newer ballot this seat didn't receipt supersedes: nothing owed, the newer ballot in scope",
            [vb(1, 1, 4), vb(2, 2, 6)],
            [1],
        ),
        (
            "board-copy",
            "A copy from the board of a receipted ballot is the same ballot",
            [vb(1, 1, 4), vb(1, 1, 4)],
            [1],
        ),
        (
            "recast",
            "A receipt for a ballot hash covers its core cast again under another block after a reorganisation",
            [vb(9, 1, 4, ref_hash=reorged), vb(9, 2, 6)],
            [9],
        ),
        (
            "recast-shown-absent",
            "The receipted copy was shown absent; the receipt still covers the copy cast again",
            [vb(9, 2, 6)],
            [9],
        ),
        (
            "recast-withheld",
            "Only the reorganised copy is held: it is owed, and in scope",
            [vb(9, 1, 4, ref_hash=reorged)],
            [9],
        ),
        (
            "unadmitted",
            "References before the window, after close and unknown neither count nor supersede",
            [vb(1, 1, 4), vb(2, 2, 8, ref_hash=det("unknown")), vb(3, 3, 1), vb(4, 4, 11), vb(5, 5, 12)],
            [1, 2, 3, 4],
        ),
        (
            "unadmitted-tie",
            "Two unadmitted ballots at one block: the smaller ballot hash is owed",
            [vb(1, 1, 11), vb(2, 2, 11)],
            [1, 2],
        ),
        ("empty", "Nothing receipted, nothing held", [], []),
        (
            "scope-only",
            "Held from the board, never receipted: nothing owed, the selected ballot in scope",
            [vb(1, 1, 4), vb(2, 2, 6), vb(3, 3, 5, nullifier=8)],
            [],
        ),
        (
            "late-board-newer",
            "A newer ballot boarded after s_A never displaces the counted one, which stays in scope",
            [vb(1, 1, 4, entry=("board", 40)), vb(2, 2, 6, entry=("board", S_A + 1))],
            [],
        ),
        (
            "late-board-tie",
            "A late board-path ballot naming the counted one's block doesn't make a tie",
            [vb(1, 1, 4, entry=("board", S_A)), vb(2, 2, 4, entry=("board", S_A + 1))],
            [1, 2],
        ),
        (
            "late-copy",
            "A late copy of a timely ballot: the timely copy stands",
            [vb(1, 1, 4, entry=("board", 40)), vb(1, 1, 4, entry=("board", S_A + 9))],
            [1],
        ),
        (
            "ordinary-window",
            "An ordinary copy at close counts; one a second after close, and a relayed one stamped before opening, don't",
            [
                vb(1, 1, 4, entry=("ordinary", CLOSES_AT)),
                vb(2, 2, 6, entry=("ordinary", CLOSES_AT + 1)),
                vb(3, 3, 5, nullifier=8, entry=("relayed", OPENS_AT - 1)),
                vb(4, 4, 4, nullifier=8, entry=("relayed", OPENS_AT)),
            ],
            [1, 2, 3, 4],
        ),
        (
            "late-only",
            "Every copy outside the window: nothing owed, nothing in scope, not even as unadmitted",
            [vb(1, 1, 11, entry=("board", S_A + 1)), vb(2, 2, 4, entry=("ordinary", CLOSES_AT + 1))],
            [1, 2],
        ),
        (
            "intake-copy-newer",
            "A newer ballot held only from intake, not shown absent, still displaces (the withheld-data residual)",
            [vb(1, 1, 4, entry=("board", 40)), vb(2, 2, 6)],
            [1, 2],
        ),
    ]


def error_cases():
    two = vb(1, 1, 4)
    return [
        ("pending", "L1 has finalized only up to block 9, before close", [vb(1, 1, 10)], "pending", 9),
        ("message", "One message names two ballot hashes", [two, dict(two, hash=det("ballot", 2))], "message", HEAD),
        ("tier", "Tier 3, on a reference before the window", [vb(1, 1, 1, tier=3)], "tier", HEAD),
        (
            "nullifier",
            "A nullifier of r, on a reference before the window",
            [vb(1, 1, 1, nullifier=rv.R)],
            "nullifier",
            HEAD,
        ),
    ]


# --- Capacity ---------------------------------------------------------------


def intervals(e, w):
    """(start, end, gas, kind) of one election's receipts and complaints."""
    end = e["closesAt"] + e["l1InclusionBound"]
    t_d, t_k = end + DELIVERY_WINDOW, end + COMPLAINT_WINDOW
    c_d = t_d - w["forcedInclusion"]
    owed = 2 * e["members"]
    calls = -(-owed // FORCED_PATH["receiptsPerCall"])
    return [
        (c_d - w["margin"], c_d, e["seats"] * calls * FORCED_PATH["receiptCallGas"], "receipts"),
        (
            t_d + w["contractEventWindow"],
            t_k - w["forcedInclusion"],
            e["seats"] * owed * FORCED_PATH["complaintCallGas"],
            "complaints",
        ),
    ]


def fits(elections, w):
    """Sweep the intervals in time order, tracking the summed rate exactly."""
    events = []
    for e in elections:
        assert e["members"] >= 0 and 1 <= e["seats"] <= 2 * MAX_TRUSTEES
        for start, stop, gas, _ in intervals(e, w):
            assert stop > start
            rate = Fraction(gas, stop - start)
            events.append((start, 1, rate))
            events.append((stop, 0, -rate))
    limit = Fraction(FORCED_PATH["depositGasTarget"], FORCED_PATH["l1BlockSeconds"])
    rate = Fraction(0)
    # Ends sort before starts at one moment: the intervals are half-open.
    for _, _, delta in sorted(events, key=lambda x: (x[0], x[1])):
        rate += delta
        if rate > limit:
            return False
    return True


def lone_limit(seats, w):
    """The largest M a lone election fits with, by linear search from a closed-form guess."""
    one = lambda m: fits([{"members": m, "seats": seats, "closesAt": 0, "l1InclusionBound": 0}], w)
    per_second = Fraction(FORCED_PATH["depositGasTarget"], FORCED_PATH["l1BlockSeconds"])
    m = 0
    # Complaints alone bound M by rate · L_K / (2 · s · gas) (R ≤ L_K, so receipts
    # never allow more per second than this guess's ceiling).
    l_k = COMPLAINT_WINDOW - DELIVERY_WINDOW - w["contractEventWindow"] - w["forcedInclusion"]
    guess = int(per_second * l_k / (2 * seats * FORCED_PATH["complaintCallGas"]))
    m = guess
    while m > 0 and not one(m):
        m -= 1
    while one(m + 1):
        m += 1
    return m


def windows(margin_hours):
    return {
        "contractEventWindow": DEPLOYED["contractEventWindow"],
        "forcedInclusion": DEPLOYED["forcedInclusion"],
        "margin": margin_hours * HOUR,
    }


def election(members, seats, closes_at=1_800_000_000, bound=600):
    return {"members": members, "seats": seats, "closesAt": closes_at, "l1InclusionBound": bound}


def capacity_cases():
    w1, w21 = windows(1), windows(21)
    l3 = lone_limit(3, w1)
    half = l3 // 2
    cases = [
        ("lone-at-limit", "Three seats at the largest electorate R of one hour fits", w1, [election(l3, 3)]),
        ("lone-over-limit", "One member more", w1, [election(l3 + 1, 3)]),
        ("empty-electorate", "No members: nothing to force", w1, [election(0, 32)]),
        ("one-seat", "One seat, its limit", w1, [election(lone_limit(1, w1), 1)]),
        ("sixteen-seats", "Sixteen seats over the limit", w1, [election(lone_limit(16, w1) + 1, 16)]),
        (
            "author-panel",
            "A default panel of 3 and an author panel of 2: five seats share the target",
            w1,
            [election(lone_limit(5, w1), 5)],
        ),
        (
            "complaints-bind",
            "With R of 21 hours the complaints bind first: one member over their limit",
            w21,
            [election(lone_limit(3, w21) + 1, 3)],
        ),
        ("long-margin", "R of 21 hours at its limit", w21, [election(lone_limit(3, w21), 3)]),
        (
            "same-close-halves",
            "Two elections closing together, each with half the limit",
            w1,
            [election(half, 3), election(half, 3)],
        ),
        (
            "same-close-over",
            "Two elections closing together, each at the limit",
            w1,
            [election(l3, 3), election(l3, 3)],
        ),
        (
            "receipts-abut",
            "Closing R apart: one's receipts end where the other's start",
            w1,
            [election(l3, 3), election(l3, 3, closes_at=1_800_000_000 + HOUR)],
        ),
        (
            "receipts-overlap",
            "Closing R less a second apart: the receipts overlap for one second",
            w1,
            [election(l3, 3), election(l3, 3, closes_at=1_800_000_000 + HOUR - 1)],
        ),
        (
            "receipts-in-complaints",
            "One election's receipts inside another's complaints, each at its limit",
            w1,
            [election(l3, 3), election(l3, 3, closes_at=1_800_000_000 + 40 * HOUR)],
        ),
    ]
    out = []
    for cid, description, w, es in cases:
        out.append(
            {
                "id": cid,
                "description": description,
                "windows": {k: str(v) for k, v in w.items()},
                "elections": [
                    {
                        "members": str(e["members"]),
                        "seats": e["seats"],
                        "closesAt": str(e["closesAt"]),
                        "l1InclusionBound": str(e["l1InclusionBound"]),
                        "receipts": {
                            "start": str(i[0][0]),
                            "end": str(i[0][1]),
                            "gas": str(i[0][2]),
                        },
                        "complaints": {
                            "start": str(i[1][0]),
                            "end": str(i[1][1]),
                            "gas": str(i[1][2]),
                        },
                    }
                    for e in es
                    for i in [intervals(e, w)]
                ],
                "fits": fits(es, w),
            }
        )
    assert [c["fits"] for c in out] == [
        True, False, True, True, False, True, False, True, True, False, True, False, True
    ], [c["fits"] for c in out]
    limits = [
        {"seats": s, "margin": str(m * HOUR), "members": str(lone_limit(s, windows(m)))}
        for m in (1, 21)
        for s in (1, 3, 5, 7, 16, 32)
    ]
    return out, limits


def main():
    out = pathlib.Path(sys.argv[1])
    # The portal's data cap and per-deposit gas hold for a full receipt call:
    # its calldata is the selector, the offset, the length and the receipts
    # padded to a word.
    calldata = 4 + 32 + 32 + -(-FORCED_PATH["receiptsPerCall"] * RECEIPT_LENGTH // 32) * 32
    assert calldata <= MAX_DEPOSIT_DATA and FORCED_PATH["receiptCallGas"] <= MAX_RESOURCE_LIMIT

    def hx(b):
        return b.hex()

    def ballot_json(b):
        entry = {} if b["entry"] is None else {"entry": {"path": b["entry"][0], "value": str(b["entry"][1])}}
        return {
            **entry,
            "ballotHash": hx(b["hash"]),
            "tier": b["tier"],
            "nullifier": str(b["nullifier"]),
            "message": hx(b["message"]),
            "l1RefNumber": str(b["ref"]),
            "l1RefHash": hx(b["refHash"]),
        }

    owed_cases = []
    for cid, description, view, receipted in obligation_cases():
        receipts = [det("ballot", c) for c in receipted]
        owed, scope = obligations(view, receipts)
        assert len(owed) <= 2 * len({(b["tier"], b["nullifier"]) for b in view})
        assert set(owed) <= set(receipts) and len(scope) >= 0
        owed_cases.append(
            {
                "id": cid,
                "description": description,
                "head": str(HEAD),
                "view": [ballot_json(b) for b in view],
                "receipts": [hx(h) for h in receipts],
                "owedReceipts": [hx(h) for h in owed],
                "complaintScope": [hx(h) for h in scope],
            }
        )
    for cid, description, view, error, head in error_cases():
        try:
            obligations(view, [], head)
        except ValueError as e:
            assert str(e) == error, (cid, e)
        else:
            raise AssertionError(cid)
        owed_cases.append(
            {
                "id": cid,
                "description": description,
                "head": str(head),
                "view": [ballot_json(b) for b in view],
                "receipts": [],
                "error": True,
            }
        )
    capacity, limits = capacity_cases()
    doc = {
        "format": "abolish-delivery-obligation-vectors/1",
        "title": "What a trustee node owes through the contract path, its complaint scope, and the forced path's capacity",
        "spec": "docs/spec/delivery.md",
        "generator": (
            "packages/crypto/scripts/delivery-obligation-vectors.py: an independent Python implementation "
            "(revoting-vectors.py's selection by sorting and its L1 reference check; the capacity check by a "
            "time-ordered sweep with exact fractions)"
        ),
        "windows": {"delivery": str(DELIVERY_WINDOW), "complaint": str(COMPLAINT_WINDOW)},
        "portal": {
            "maxResourceLimit": str(MAX_RESOURCE_LIMIT),
            "elasticityMultiplier": ELASTICITY,
            "maxDepositData": MAX_DEPOSIT_DATA,
        },
        "forcedPath": {k: str(v) for k, v in FORCED_PATH.items()},
        "l1": {
            "l1RefMin": str(REF_MIN),
            "closesAt": str(CLOSES_AT),
            "opensAt": str(OPENS_AT),
            "boardSegment": str(S_A),
            "blocks": [{"number": str(n), "hash": hx(h), "timestamp": str(t)} for n, (h, t) in sorted(CHAIN.items())],
        },
        "obligations": owed_cases,
        "capacity": capacity,
        "limits": limits,
    }
    (out / "delivery-obligation.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
