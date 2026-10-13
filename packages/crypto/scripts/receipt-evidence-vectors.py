#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/receipt-evidence.json.

A second implementation of docs/spec/receipts.md, Later checks: the dispute
end, the receipt commitment, its place in calldata, and the verdicts. It is
written from the spec with Python's standard library only and shares no code
with packages/crypto. Receipts, the checks at cast and P-256 ECDSA are
receipt-vectors.py's; the board's entries, chain and RFC 9162 tree (with its
consistency proofs) are board-vectors.py's, which checks itself against
transparency-dev's RFC 6962 vectors before use.

Usage: python3 -I -B packages/crypto/scripts/receipt-evidence-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import hashlib
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


rv = load("receipt_vectors", "receipt-vectors.py")
board = rv.board
ecdsa = rv.ecdsa

COMMIT_TAG = "abolish/v1/receipt-commitment"
DISPUTE_WINDOW = 2_592_000


def sha256(b):
    return hashlib.sha256(b).digest()


def h(b):
    return b.hex()


def window_end(clock, s):
    return clock["epoch"] + (s + 1) * clock["period"] + clock["deadline"]


def dispute_end(clock):
    return window_end(clock, clock["lastSegment"]) + DISPUTE_WINDOW


def commitment(salt, receipt):
    assert len(salt) == 32
    return sha256(board.ds(COMMIT_TAG, salt + receipt))


def carries(calldata, c):
    if len(calldata) % 32:
        return False
    return any(calldata[i : i + 32] == c for i in range(0, len(calldata), 32))


def timely(clock, segment, at):
    if segment > clock["lastSegment"]:
        return False
    end = clock["epoch"] + (segment + 1) * clock["period"]
    return end <= at <= end + clock["deadline"]


def l1_checks(election_id, anchors, clock, now):
    """Board checks steps 1 and 2, then `unsealed`; the counted checkpoints, or a code."""
    counted = [a for a in anchors if timely(clock, a["segment"], a["anchoredAt"]) and a["anchoredAt"] <= now]
    first = {}
    for a in counted:
        if a["electionId"] != election_id:
            return "wrong-election"
        key = (a["size"], a["head"], a["root"])
        if first.setdefault(a["segment"], key) != key:
            return "checkpoint-equivocation"
    for a in counted:
        if a["size"] == 0:
            return "checkpoint-size"
        for o in counted:
            if o["segment"] < a["segment"] and (
                o["size"] > a["size"] or (o["size"] == a["size"] and (o["head"], o["root"]) != (a["head"], a["root"]))
            ):
                return "checkpoint-inconsistent"
    if window_end(clock, clock["lastSegment"]) < now and not any(a["segment"] == clock["lastSegment"] for a in counted):
        return "unsealed"
    return counted


def judge(case):
    """docs/spec/receipts.md, Verdicts, in order."""
    clock, now, f = case["clock"], case["now"], case["firstSegment"]
    keys = case["keys"]
    if keys["kind"] == "definition":
        judgements = [j for _, j in keys["keys"]]
        if "unsettled" in judgements:
            return {"verdict": "unjudged", "reason": "receipt-key-unsettled"}
        judging = [k for k, j in keys["keys"] if j == "judges"]
        failed = next(
            ({"retired": "receipt-key-retired", "unregistered": "receipt-key-unregistered"}[j] for j in judgements if j != "judges"),
            None,
        )
    else:
        judging, failed = keys["keys"], None
    cast = rv.check_at_cast(case["receipt"], case["electionId"], case["payload"], judging, f, clock["lastSegment"])
    if not cast.get("ok"):
        return {"verdict": "not-evidence", "reason": cast["code"]}
    r = rv.decode(case["receipt"])
    if now >= dispute_end(clock):
        openings = case.get("openings", [])
        if not any(o == "ok" for o in openings):
            if "opening-fork-unknown" in openings:
                return {"verdict": "unjudged", "reason": "opening-fork-unknown"}
            out = {"verdict": "not-evidence", "reason": "expired"}
            if openings:
                out["opening"] = openings[0]
            return out
    counted = l1_checks(case["electionId"], [a for a in case["anchors"] if a["segment"] >= f], clock, now)
    if isinstance(counted, str):
        return {"verdict": "board-failed", "reason": counted}
    if failed:
        return {"verdict": "board-failed", "reason": failed}
    s, index = r["segment"], r["index"]
    if now <= window_end(clock, s):
        return {"verdict": "pending"}
    if not any(a["segment"] == s for a in counted):
        return {"verdict": "unanchored"}
    for a in counted:
        if (a["segment"] < s and a["size"] > index) or (a["segment"] >= s and a["size"] <= index):
            return {"verdict": "forked", "by": "l1", "checkpoint": a}
    later = [a for a in counted if a["segment"] >= s]
    n = index + 1
    included = None
    for source in case.get("sources", []):
        if len(source) % 32 or len(source) // 32 < n:
            continue
        hashes = [source[i : i + 32] for i in range(0, len(source), 32)]
        r_prime = board.BOARD.mth(hashes[:n])
        matched = [a for a in later if a["size"] <= len(hashes) and board.BOARD.mth(hashes[: a["size"]]) == a["root"]]
        proofs = [(a, board.BOARD.proof(n, hashes[: a["size"]])) for a in matched]
        for a, p in proofs:
            assert board.BOARD.verify_consistency(n, a["size"], r_prime, a["root"], p)
        if r_prime != r["root"]:
            if proofs:
                a, p = proofs[0]
                return {"verdict": "forked", "by": "copy", "rootAtIndex": r_prime, "consistency": [(a, p)]}
        elif included is None and len(matched) == len(later):
            included = proofs
    if included is not None:
        return {"verdict": "included", "consistency": included}
    return {"verdict": "unresolved"}


def main(out_dir):
    ecdsa.self_check()
    board.self_check(HERE.parents[1] / "test-vectors" / "transparency-dev")

    E = sha256(b"abolish receipt evidence test election")
    operator = ecdsa.secret(b"receipt evidence operator")
    stranger = ecdsa.secret(b"receipt evidence stranger")
    key = lambda d: ecdsa.compress(ecdsa.mul(d, ecdsa.G))
    pinned = [key(operator)]

    clock = {"epoch": 1_000_000, "period": 3_600, "deadline": 1_800, "lastSegment": 4}
    payloads = [rv.ballot(b"evidence " + bytes([i])) for i in range(8)]
    segments = [0, 0, 1, 1, 1, 3, 4]
    honest = rv.make_board(E, payloads[:7], segments)
    hashes = [board.entry_hash(e) for e in honest]
    links = board.chain_links(honest)

    def receipt_for(i, entries=honest, d=operator):
        hs = [board.entry_hash(e) for e in entries[: i + 1]]
        ls = board.chain_links(entries[: i + 1])
        seg = board.decode_entry(entries[i])["segment"]
        return rv.sign(d, E, i, seg, hs[i], ls[i], board.BOARD.mth(hs), board.BOARD.path(i, hs))

    def checkpoint(segment, entries=honest, election_id=E):
        size = sum(1 for e in entries if board.decode_entry(e)["segment"] <= segment)
        hs = [board.entry_hash(e) for e in entries[:size]]
        return {
            "electionId": election_id,
            "segment": segment,
            "size": size,
            "head": board.chain_links(entries[:size])[-1],
            "root": board.BOARD.mth(hs),
        }

    def anchor(segment, entries=honest, late=0, **over):
        cp = {**checkpoint(segment, entries), **over}
        cp["anchoredAt"] = clock["epoch"] + (segment + 1) * clock["period"] + 60 + late
        return cp

    honest_anchors = [anchor(s) for s in (0, 1, 3, 4)]
    honest_list = b"".join(hashes)
    closed = window_end(clock, 4) + 1
    t_e = dispute_end(clock)

    # Disputes ends.
    dispute_cases = [
        {"id": "dispute-end-typical", "clock": clock},
        {"id": "dispute-end-zero", "clock": {"epoch": 0, "period": 1, "deadline": 0, "lastSegment": 0}},
        {"id": "dispute-end-u32-seal", "clock": {"epoch": 1_700_000_000, "period": 3_600, "deadline": 43_200, "lastSegment": 2**32 - 1}},
    ]
    for c in dispute_cases:
        c["disputeEnd"] = dispute_end(c["clock"])

    # Commitments.
    r3 = receipt_for(3)
    salts = [sha256(b"receipt evidence salt " + bytes([i])) for i in range(3)]
    commit_cases = [
        {"id": "commitment-receipt-3", "salt": salts[0], "receipt": r3},
        {"id": "commitment-other-salt", "salt": salts[1], "receipt": r3},
        {"id": "commitment-receipt-0", "salt": salts[0], "receipt": receipt_for(0)},
        {"id": "commitment-zero-salt-empty", "salt": bytes(32), "receipt": b""},
    ]
    for c in commit_cases:
        c["commitment"] = commitment(c["salt"], c["receipt"])
    C = commit_cases[0]["commitment"]
    other = commit_cases[1]["commitment"]
    calldata_cases = [
        ("calldata-only-word", C, True),
        ("calldata-batched-middle", other + C + other, True),
        ("calldata-batched-last", other * 3 + C, True),
        ("calldata-empty", b"", False),
        ("calldata-absent", other * 2, False),
        ("calldata-unaligned", bytes(1) + C + bytes(31), False),
        ("calldata-length-not-multiple", C + bytes(1), False),
        ("calldata-selector-prefixed", bytes.fromhex("a9059cbb") + C, False),
        ("calldata-split-across-words", C[16:] + C[:16] + C[16:] + C[:16], False),
    ]
    calldata_vectors = []
    for vid, data, want in calldata_cases:
        assert carries(data, C) == want, vid
        calldata_vectors.append({"id": vid, "calldata": h(data), "commitment": h(C), "carries": want})

    # Verdicts.
    fork_late = rv.make_board(E, payloads[:3] + [payloads[7]], [0, 0, 1, 1])  # index 3 differs
    fork_early = rv.make_board(E, [payloads[0], payloads[7]], [0, 1])  # index 1 in segment 1
    retired_key = key(stranger)
    base = {
        "electionId": E,
        "payload": payloads[3],
        "receipt": r3,
        "keys": {"kind": "pinned", "keys": pinned},
        "firstSegment": 0,
        "clock": clock,
        "anchors": honest_anchors,
        "now": closed,
        "sources": [honest_list],
    }
    wrong_list = bytearray(honest_list)
    wrong_list[6 * 32] ^= 1  # matches segments 0 to 3, not the seal
    cases = [
        ("included", {}),
        ("included-definition-keys", {"keys": {"kind": "definition", "keys": [(pinned[0], "judges")]}}),
        ("included-after-bad-sources", {"sources": [honest_list[:-1], honest_list[: 2 * 32], bytes(wrong_list), honest_list]}),
        ("included-index-0", {"receipt": receipt_for(0), "payload": payloads[0]}),
        ("included-seal-entry", {"receipt": receipt_for(6), "payload": payloads[6]}),
        ("included-before-seal", {"now": window_end(clock, 1) + 1, "anchors": honest_anchors[:2]}),
        ("included-seal-window-open", {"now": window_end(clock, 4), "anchors": honest_anchors[:3]}),
        ("included-later-anchors-after-now", {"now": window_end(clock, 1) + 1}),
        ("included-anchor-before-first-ignored", {"firstSegment": 1, "anchors": [anchor(0, size=1000)] + honest_anchors[1:]}),
        ("included-opening-passes", {"now": t_e, "openings": ["opening-late", "ok"]}),
        ("not-evidence-key", {"keys": {"kind": "pinned", "keys": [retired_key]}}),
        ("not-evidence-key-not-judging", {"keys": {"kind": "definition", "keys": [(pinned[0], "unregistered")]}}),
        ("not-evidence-signature-stranger", {"receipt": (lambda b: b[:143] + pinned[0] + b[176:])(receipt_for(3, d=stranger))}),
        ("not-evidence-entry", {"payload": payloads[4]}),
        ("not-evidence-election", {"receipt": rv.sign(operator, sha256(b"other election"), 3, 1, hashes[3], links[3], board.BOARD.mth(hashes[:4]), board.BOARD.path(3, hashes[:4]))}),
        ("not-evidence-inclusion", {"receipt": rv.sign(operator, E, 3, 1, hashes[3], links[3], board.BOARD.mth(hashes[:4]), board.BOARD.path(2, hashes[:4]))}),
        ("not-evidence-segment-before-first", {"firstSegment": 2}),
        ("not-evidence-decode", {"receipt": r3 + b"\x00"}),
        ("not-evidence-expired", {"now": t_e}),
        ("not-evidence-expired-opening-code", {"now": t_e + 1, "openings": ["opening-commitment", "opening-late"]}),
        ("unjudged-fork-unknown", {"now": t_e, "openings": ["opening-late", "opening-fork-unknown"]}),
        ("unjudged-key-unsettled", {"keys": {"kind": "definition", "keys": [(pinned[0], "judges"), (retired_key, "unsettled")]}}),
        ("board-failed-equivocation", {"anchors": honest_anchors + [anchor(1, fork_late, late=5)]}),
        ("board-failed-inconsistent", {"anchors": [anchor(0), anchor(1, size=1), anchor(3), anchor(4)]}),
        ("board-failed-size", {"anchors": honest_anchors + [anchor(2, size=0, head=bytes(32), root=bytes(32))]}),
        ("board-failed-wrong-election", {"anchors": [anchor(0, electionId=sha256(b"other"))] + honest_anchors[1:]}),
        ("board-failed-unsealed", {"anchors": honest_anchors[:3]}),
        ("board-failed-key-unregistered", {"keys": {"kind": "definition", "keys": [(pinned[0], "judges"), (retired_key, "unregistered")]}}),
        ("board-failed-key-retired", {"keys": {"kind": "definition", "keys": [(pinned[0], "judges"), (retired_key, "retired")]}}),
        ("pending", {"now": window_end(clock, 1)}),
        ("unanchored", {"anchors": [honest_anchors[0]] + honest_anchors[2:]}),
        ("unanchored-late-anchor-ignored", {"anchors": [honest_anchors[0], anchor(1, late=clock["deadline"])] + honest_anchors[2:]}),
        ("forked-l1-earlier-covers", {"receipt": receipt_for(1, fork_early), "payload": payloads[7]}),
        ("forked-l1-later-short", {"receipt": receipt_for(6), "payload": payloads[6], "anchors": honest_anchors[:3] + [anchor(4, size=6, head=links[5], root=board.BOARD.mth(hashes[:6]))]}),
        ("forked-copy", {"receipt": receipt_for(3, fork_late), "payload": payloads[7]}),
        ("forked-copy-partial-source", {"receipt": receipt_for(3, fork_late), "payload": payloads[7], "sources": [bytes(wrong_list), honest_list]}),
        ("unresolved-no-source", {"sources": []}),
        ("unresolved-short-source", {"sources": [honest_list[: 4 * 32]]}),
        ("unresolved-later-mismatch", {"sources": [bytes(wrong_list)]}),
    ]
    anchors_of = lambda xs: [
        {
            "checkpoint": {"electionId": h(a["electionId"]), "segment": a["segment"], "size": str(a["size"]), "head": h(a["head"]), "root": h(a["root"])},
            "anchoredAt": str(a["anchoredAt"]),
        }
        for a in xs
    ]
    cp_of = lambda a: {"segment": a["segment"], "size": str(a["size"])}
    verdict_vectors = []
    expected = {}
    for vid, over in cases:
        case = {**base, **over}
        v = judge(case)
        prefix = vid.split("-")[0]
        if prefix in ("not", "board", "forked"):
            prefix = {"not": "not-evidence", "board": "board-failed", "forked": "forked"}[prefix]
        assert v["verdict"] == prefix, (vid, v)
        out = {"verdict": v["verdict"]}
        for k in ("reason", "opening", "by"):
            if k in v:
                out[k] = v[k]
        if "checkpoint" in v:
            out["checkpoint"] = cp_of(v["checkpoint"])
        if "rootAtIndex" in v:
            out["rootAtIndex"] = h(v["rootAtIndex"])
        if "consistency" in v:
            out["consistency"] = [{**cp_of(a), "proof": [h(x) for x in p]} for a, p in v["consistency"]]
        expected[vid] = out
        keys = case["keys"]
        verdict_vectors.append(
            {
                "id": vid,
                "receipt": h(case["receipt"]),
                "payload": h(case["payload"]),
                "keys": {
                    "kind": keys["kind"],
                    "keys": [{"key": h(k), "judgement": j} for k, j in keys["keys"]] if keys["kind"] == "definition" else [h(k) for k in keys["keys"]],
                },
                "firstSegment": case["firstSegment"],
                "anchors": anchors_of(case["anchors"]),
                "now": str(case["now"]),
                **({"openings": case["openings"]} if "openings" in case else {}),
                "sources": [h(s) for s in case["sources"]],
                "expected": out,
            }
        )
    assert expected["not-evidence-key"]["reason"] == "receipt-key"
    assert expected["not-evidence-segment-before-first"]["reason"] == "receipt-segment"
    assert expected["not-evidence-signature-stranger"]["reason"] == "receipt-signature"
    assert expected["not-evidence-expired-opening-code"]["opening"] == "opening-commitment"
    assert expected["board-failed-unsealed"]["reason"] == "unsealed"
    assert expected["not-evidence-election"]["reason"] == "receipt-election"
    assert expected["not-evidence-inclusion"]["reason"] == "receipt-inclusion"
    assert len(expected["included-later-anchors-after-now"]["consistency"]) == 1
    assert expected["forked-copy"]["by"] == "copy" and expected["forked-l1-earlier-covers"]["by"] == "l1"
    assert len(expected["included"]["consistency"]) == 3  # segments 1, 3 and 4

    out = {
        "format": "abolish-receipt-evidence-vectors/1",
        "title": "Receipts' later checks: the dispute end, the commitment and the verdicts",
        "spec": "docs/spec/receipts.md",
        "generator": (
            "packages/crypto/scripts/receipt-evidence-vectors.py: an independent Python implementation (standard "
            "library only), with receipt-vectors.py's receipts and checks at cast and board-vectors.py's self-checked "
            "entries, chain and RFC 9162 tree"
        ),
        "tag": COMMIT_TAG,
        "disputeWindow": DISPUTE_WINDOW,
        "electionId": h(E),
        "boardEntryVersion": 1,
        "clock": {k: (v if k == "lastSegment" else str(v)) for k, v in clock.items()},
        "disputeEnds": [
            {"id": c["id"], "clock": {k: (v if k == "lastSegment" else str(v)) for k, v in c["clock"].items()}, "disputeEnd": str(c["disputeEnd"])}
            for c in dispute_cases
        ],
        "commitments": [
            {"id": c["id"], "salt": h(c["salt"]), "receipt": h(c["receipt"]), "commitment": h(c["commitment"])} for c in commit_cases
        ],
        "calldata": calldata_vectors,
        "verdicts": verdict_vectors,
    }
    path = pathlib.Path(out_dir) / "receipt-evidence.json"
    path.write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
