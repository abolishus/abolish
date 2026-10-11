#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/revoting.json.

A second implementation of docs/spec/revoting.md: the membership message M,
its field mapping F(M), the admission check on the L1 reference, and the selection of counted ballots. It is written
from the spec with Python's standard library only and shares no code with
packages/crypto. The Keccak-256 sponge behind F is membership-vectors.py's,
which checks itself against hashlib.sha3_256 and published answers before
use. Selection here sorts each group by block number instead of scanning for
a maximum, so the two implementations don't share a structure either.

Usage: python3 -I -B packages/crypto/scripts/revoting-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
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


def check_reference(number, ref_hash, chain, head, ref_min, closes_at):
    """chain: {number: (hash, timestamp)} for the finalized blocks from ref_min to head."""
    if number < ref_min:
        return "l1-ref-before-open"
    # Timestamps strictly increase with the number, so a block after close at
    # or below the named number puts the named block after close too.
    if chain[min(number, head)][1] > closes_at:
        return "l1-ref-after-close"
    if number > head:
        return "pending"
    if chain[number][0] != ref_hash:
        return "l1-ref-unknown"
    return "admitted"


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

    # Blocks 100 to 109, 12 seconds apart, with one missed slot after 104.
    chain = {}
    t = 1_800_000_000
    for n in range(100, 110):
        chain[n] = (det("chain", n), t)
        t += 24 if n == 104 else 12
    ts = lambda n: chain[n][1]
    assert all(ts(n) < ts(n + 1) for n in range(100, 109))
    # Verifiers whose heads are both past close agree on every verdict.
    for number in [0, 100, 101, 103, 106, 107, 108, 112, U64_MAX]:
        for h in [(107, 109), (108, 109)]:
            verdicts = {
                check_reference(number, det("other"), {n: chain[n] for n in chain if 101 <= n <= hd}, hd, 101, ts(106))
                for hd in h
            }
            assert len(verdicts) == 1, (number, h)
    ref_min = 101
    reference_cases = [
        ("admitted", "A finalized block before close, with its hash", 103, None, 109, ts(106)),
        ("at-close", "A block whose timestamp equals closes_at is admitted", 106, None, 109, ts(106)),
        ("at-minimum", "The first block of the window is admitted", ref_min, None, 109, ts(106)),
        ("before-open", "A block before l1_ref_min is rejected by number alone", ref_min - 1, None, 109, ts(106)),
        ("ancient", "An ancient block is rejected with no lookup, whatever its hash", 0, det("other"), 109, ts(106)),
        ("wrong-hash", "The number is finalized with another hash: reorganised away or never existed", 103, det("other"), 109, ts(106)),
        ("wrong-hash-after-close", "Time is checked before the hash", 108, det("other"), 109, ts(106)),
        ("wrong-hash-after-close-short-head", "The same ballot gets the same verdict from a verifier whose head is just past close", 108, det("other"), 107, ts(106)),
        ("after-close", "A finalized block after closes_at", 108, None, 109, ts(106)),
        ("pending", "Beyond the finalized head while the head is before close", 107, None, 105, ts(106)),
        ("pending-head-at-close", "A head exactly at closes_at isn't after it, so beyond it is still pending", 108, None, 106, ts(106)),
        ("beyond-head-after-close", "Beyond the head once the head is after close", 112, det("future"), 109, ts(106)),
        ("far-future-pending", "2^64 - 1 is pending while the head is before close", U64_MAX, det("future"), 104, ts(106)),
        ("far-future-rejected", "2^64 - 1 is rejected once a block after close is finalized, never pending for good", U64_MAX, det("future"), 107, ts(106)),
    ]
    references = []
    for name, description, number, ref_hash, head, closes_at in reference_cases:
        ref_hash = chain[number][0] if ref_hash is None else ref_hash
        visible = {n: chain[n] for n in chain if ref_min <= n <= head}
        references.append(
            {
                "id": f"reference-{name}",
                "description": description,
                "l1RefNumber": str(number),
                "l1RefHash": ref_hash.hex(),
                "head": str(head),
                "l1RefMin": str(ref_min),
                "closesAt": str(closes_at),
                "verdict": check_reference(number, ref_hash, visible, head, ref_min, closes_at),
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
        "title": "Re-voting: the membership message, the L1 reference check and the selection of counted ballots",
        "spec": "docs/spec/revoting.md",
        "generator": (
            "packages/crypto/scripts/revoting-vectors.py: an independent Python implementation "
            "(hashlib SHA-256; membership-vectors.py's self-checked Keccak-256 for F), with "
            "selection by sorting rather than packages/crypto's scan"
        ),
        "messages": messages,
        "l1Chain": [
            {"number": str(n), "hash": h.hex(), "timestamp": str(t)} for n, (h, t) in sorted(chain.items())
        ],
        "references": references,
        "selections": selections,
    }
    (out / "revoting.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
