#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/revoting.json.

A second implementation of docs/spec/revoting.md: the membership message M,
its field mapping F(M), and the selection of counted ballots. It is written
from the spec with Python's standard library only and shares no code with
packages/crypto. The Keccak-256 sponge behind F is membership-vectors.py's,
which checks itself against hashlib.sha3_256 and published answers before
use. Selection here sorts each group by block number instead of scanning for
a maximum, so the two implementations don't share a structure either.

Usage: python3 -I packages/crypto/scripts/revoting-vectors.py <out-dir>
"""

import hashlib
import importlib.util
import json
import pathlib
import sys

R = 0x30644E72E131A029B85045B68181585D2833E84879B9709143E1F593F0000001
U64_MAX = 2**64 - 1
TAG = b"abolish/v1/membership-message"

_spec = importlib.util.spec_from_file_location(
    "membership_vectors", pathlib.Path(__file__).with_name("membership-vectors.py")
)
membership = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(membership)


def message(definition_hash, tier, ballot_hash, ref_number, ref_hash):
    if tier not in (0, 1, 2):
        raise ValueError("unknown-tier")
    if not 0 <= ref_number <= U64_MAX:
        raise ValueError("not-u64")
    assert len(definition_hash) == len(ballot_hash) == len(ref_hash) == 32
    m = definition_hash + bytes([tier]) + ballot_hash + ref_number.to_bytes(8, "big") + ref_hash
    assert len(m) == 105
    return hashlib.sha256(bytes([len(TAG)]) + TAG + m).digest()


def select(ballots):
    """ballots: list of dicts with tier, nullifier, message (bytes), ref, index."""
    seen_index = set()
    for b in ballots:
        if b["tier"] not in (0, 1, 2):
            raise ValueError("unknown-tier")
        if not 0 <= b["nullifier"] < R:
            raise ValueError("non-canonical-nullifier")
        if b["index"] in seen_index:
            raise ValueError("duplicate-index")
        seen_index.add(b["index"])

    # Repeats: the smallest index of each (tier, nullifier, message) stands.
    by_key = {}
    for b in sorted(ballots, key=lambda b: b["index"]):
        by_key.setdefault((b["tier"], b["nullifier"], b["message"]), []).append(b)
    standing, repeats = [], []
    for copies in by_key.values():
        if len({c["ref"] for c in copies}) != 1:
            raise ValueError("inconsistent-message")
        standing.append(copies[0])
        repeats.extend(copies[1:])

    groups = {}
    for b in standing:
        groups.setdefault((b["tier"], b["nullifier"]), []).append(b)
    selected, ties = [], []
    for group in groups.values():
        group = sorted(group, key=lambda b: b["ref"], reverse=True)
        top = [b for b in group if b["ref"] == group[0]["ref"]]
        (selected if len(top) == 1 else ties).extend(top)
    idx = lambda xs: sorted(b["index"] for b in xs)
    return {"selected": idx(selected), "repeats": idx(repeats), "ties": idx(ties)}


def det(label, i=0):
    return hashlib.sha256(f"abolish revoting vectors {label} {i}".encode()).digest()


def ballot(tier, nullifier, msg, ref, index):
    return {"tier": tier, "nullifier": nullifier, "message": msg, "ref": ref, "index": index}


def main():
    membership.self_check()
    out = pathlib.Path(sys.argv[1])

    messages = []
    cases = [
        ("tier-0", det("definition"), 0, det("ballot", 0), 21_000_000, det("block", 0)),
        ("tier-1", det("definition"), 1, det("ballot", 0), 21_000_000, det("block", 0)),
        ("tier-2", det("definition"), 2, det("ballot", 0), 21_000_000, det("block", 0)),
        ("next-block", det("definition"), 0, det("ballot", 0), 21_000_001, det("block", 1)),
        ("other-ballot", det("definition"), 0, det("ballot", 1), 21_000_000, det("block", 0)),
        ("other-definition", det("definition", 1), 0, det("ballot", 0), 21_000_000, det("block", 0)),
        ("same-number-other-hash", det("definition"), 0, det("ballot", 0), 21_000_000, det("block", 2)),
        ("block-zero", bytes(32), 0, bytes(32), 0, bytes(32)),
        ("block-u64-max", b"\xff" * 32, 2, b"\xff" * 32, U64_MAX, b"\xff" * 32),
    ]
    for name, d, tier, bh, n, rh in cases:
        m = message(d, tier, bh, n, rh)
        messages.append(
            {
                "id": f"message-{name}",
                "definitionHash": d.hex(),
                "tier": tier,
                "ballotHash": bh.hex(),
                "l1RefNumber": str(n),
                "l1RefHash": rh.hex(),
                "message": m.hex(),
                "messageField": str(membership.field_map(m)),
            }
        )
    for name, description, tier, n, error in [
        ("unknown-tier", "Tier 3 doesn't exist", 3, 1, "unknown-tier"),
        ("number-above-u64", "2^64 doesn't fit a u64", 0, U64_MAX + 1, "not-u64"),
    ]:
        try:
            message(det("definition"), tier, det("ballot", 0), n, det("block", 0))
        except ValueError as e:
            assert str(e) == error
        else:
            raise AssertionError(name)
        messages.append(
            {
                "id": f"message-{name}",
                "description": description,
                "definitionHash": det("definition").hex(),
                "tier": tier,
                "ballotHash": det("ballot", 0).hex(),
                "l1RefNumber": str(n),
                "l1RefHash": det("block", 0).hex(),
                "error": error,
            }
        )

    nu = [int.from_bytes(det("nullifier", i), "big") % R for i in range(4)]
    m = [det("message", i) for i in range(8)]
    selection_cases = [
        ("single", "One ballot is selected", [ballot(0, nu[0], m[0], 100, 0)]),
        (
            "newer-block-posted-first",
            "The re-vote naming the newer block counts although the operator posted it first (R3)",
            [ballot(0, nu[0], m[1], 101, 3), ballot(0, nu[0], m[0], 100, 7)],
        ),
        (
            "withheld-coerced-ballot",
            "A coerced ballot withheld and posted last still ranks by its own, older block (R3, R2)",
            [ballot(0, nu[0], m[1], 140, 2), ballot(0, nu[0], m[0], 120, 9)],
        ),
        (
            "tie-voids-group",
            "Two distinct ballots naming the top block tie; the older ballot doesn't count in their place",
            [ballot(1, nu[0], m[0], 100, 0), ballot(1, nu[0], m[1], 105, 1), ballot(1, nu[0], m[2], 105, 2)],
        ),
        (
            "tie-below-top",
            "A tie at a lower block doesn't stop the newest ballot counting",
            [ballot(0, nu[0], m[0], 100, 0), ballot(0, nu[0], m[1], 100, 1), ballot(0, nu[0], m[2], 101, 2)],
        ),
        (
            "repeat-stands-once",
            "A re-randomised copy has the same message: the smaller index stands, the other is a repeat (R1)",
            [ballot(0, nu[0], m[0], 100, 5), ballot(0, nu[0], m[0], 100, 2)],
        ),
        (
            "replay-after-revote",
            "Replaying an earlier ballot after a re-vote is a repeat and can't make it last (R1)",
            [ballot(2, nu[1], m[0], 100, 0), ballot(2, nu[1], m[1], 130, 1), ballot(2, nu[1], m[0], 100, 2)],
        ),
        (
            "repeat-of-tied-ballot",
            "A repeat doesn't count as a distinct ballot, so it neither causes nor breaks a tie",
            [ballot(0, nu[0], m[0], 100, 0), ballot(0, nu[0], m[0], 100, 1), ballot(0, nu[0], m[1], 100, 2)],
        ),
        (
            "same-message-other-tier",
            "Tiers are separate groups, even with equal nullifier and message values",
            [ballot(0, nu[2], m[3], 100, 0), ballot(1, nu[2], m[3], 90, 1)],
        ),
        (
            "many-voters",
            "Several voters across tiers, with re-votes, a tie, a repeat and a lone ballot",
            [
                ballot(0, nu[0], m[0], 100, 0),
                ballot(0, nu[1], m[1], 100, 1),
                ballot(0, nu[0], m[2], 102, 2),
                ballot(1, nu[0], m[3], 99, 3),
                ballot(0, nu[1], m[4], 101, 4),
                ballot(0, nu[1], m[5], 101, 5),
                ballot(2, nu[3], m[6], 50, 6),
                ballot(0, nu[0], m[2], 102, 7),
                ballot(1, nu[2], m[7], 0, 8),
            ],
        ),
    ]
    selections = []
    for name, description, bs in selection_cases:
        selections.append(
            {
                "id": f"select-{name}",
                "description": description,
                "ballots": [
                    {
                        "tier": b["tier"],
                        "nullifier": str(b["nullifier"]),
                        "message": b["message"].hex(),
                        "l1RefNumber": str(b["ref"]),
                        "index": str(b["index"]),
                    }
                    for b in bs
                ],
                **{k: [str(i) for i in v] for k, v in select(bs).items()},
            }
        )
    rejected = [
        (
            "duplicate-index",
            "Two ballots at one board position",
            [ballot(0, nu[0], m[0], 100, 4), ballot(0, nu[1], m[1], 100, 4)],
        ),
        (
            "inconsistent-message",
            "Equal messages naming different blocks: M binds the number, so one was decoded wrongly",
            [ballot(0, nu[0], m[0], 100, 0), ballot(0, nu[0], m[0], 101, 1)],
        ),
        ("unknown-tier", "Tier 3 doesn't exist", [ballot(3, nu[0], m[0], 100, 0)]),
        ("non-canonical-nullifier", "A nullifier equal to r", [ballot(0, R, m[0], 100, 0)]),
    ]
    for name, description, bs in rejected:
        try:
            select(bs)
        except ValueError as e:
            assert str(e) == name
        else:
            raise AssertionError(name)
        selections.append(
            {
                "id": f"select-{name}",
                "description": description,
                "ballots": [
                    {
                        "tier": b["tier"],
                        "nullifier": str(b["nullifier"]),
                        "message": b["message"].hex(),
                        "l1RefNumber": str(b["ref"]),
                        "index": str(b["index"]),
                    }
                    for b in bs
                ],
                "error": name,
            }
        )

    doc = {
        "format": "abolish-revoting-vectors/1",
        "title": "Re-voting: the membership message and the selection of counted ballots",
        "spec": "docs/spec/revoting.md",
        "generator": (
            "packages/crypto/scripts/revoting-vectors.py: an independent Python implementation "
            "(hashlib SHA-256; membership-vectors.py's self-checked Keccak-256 for F), with "
            "selection by sorting rather than packages/crypto's scan"
        ),
        "messages": messages,
        "selections": selections,
    }
    (out / "revoting.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
