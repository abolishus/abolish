#!/usr/bin/env python3
"""Prints docs/spec/vectors/election-definition-v6.json.

Written from docs/spec/election-definition.md (Layout (version 6), Poll class
and results, Author panel, Stub hash and the ceremony, Well-formedness) and docs/spec/trustee-identity.md
(Author panel identifier) alone, independently of packages/crypto, with only
the Python standard library. It reuses definition-v5-vectors.py's version-5
encoder, values and rules (and through it definition-v4-vectors.py's and
trustee-vectors.py's P-256 arithmetic and panel identifier), all independent of
packages/crypto too.

    python3 -I -B packages/crypto/scripts/definition-v6-vectors.py docs/spec/vectors

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


d5 = load("definition_v5_vectors", "definition-v5-vectors.py")
d4 = d5.d4
tv = d4.tv
dv = d5.dv

u8, u32, fixed, lst, ds, H = dv.u8, dv.u32, dv.fixed, dv.lst, dv.ds, dv.H
MAX_TRUSTEES = 16  # parameters.md
MIN_LIVE_BATCH = 20  # parameters.md
AUTHOR_PANEL_TAG = "abolish/v1/author-panel"
EVERYDAY, ORGANISATIONAL, CIVIC = 1, 2, 3
SEALED, LIVE = 1, 2

# --- version-6 layout ---------------------------------------------------------


def enc_definition_v6(d, version=6):
    """Written from Layout (version 6): version 5's fields, then seven more."""
    out = d5.enc_definition_v5(d, version)
    out += u8(d["poll_class"]) + u8(d["results_mode"]) + u32(d["live_every"]) + u32(d["live_batch"])
    out += u8(d["author_threshold"]) + lst(d["author_keys"], MAX_TRUSTEES, d4.enc_key)
    out += fixed(d["author_transcript_hash"], 32)
    return out


NEW_FIELDS = ["poll_class", "results_mode", "live_every", "live_batch", "author_threshold", "author_keys", "author_transcript_hash"]


def as_v5(d):
    return {k: v for k, v in d.items() if k not in NEW_FIELDS}


def def_json(d):
    j = d5.def_json(as_v5(d))
    for k in ["poll_class", "results_mode", "live_every", "live_batch", "author_threshold"]:
        j[k] = str(d[k])
    j["author_keys"] = [k.hex() for k in d["author_keys"]]
    j["author_transcript_hash"] = d["author_transcript_hash"].hex()
    order = [f["name"] for f in DEF_TYPES["election-definition-v6"]["fields"]]
    assert order == list(j), "the layout's field order"
    return j


DEF_TYPES = {k: v for k, v in d5.DEF_TYPES.items() if k != "election-definition-v5"}
DEF_TYPES["election-definition-v6"] = {
    "kind": "record",
    "recordType": "0001",
    "version": 6,
    "fields": d5.DEF_TYPES["election-definition-v5"]["fields"]
    + [
        {"name": "poll_class", "type": {"kind": "enum8", "values": ["1", "2", "3"]}},
        {"name": "results_mode", "type": {"kind": "enum8", "values": ["1", "2"]}},
        {"name": "live_every", "type": {"kind": "u32"}},
        {"name": "live_batch", "type": {"kind": "u32"}},
        {"name": "author_threshold", "type": {"kind": "u8"}},
        {"name": "author_keys", "type": {"kind": "list", "max": MAX_TRUSTEES, "of": {"kind": "p256-key"}}},
        {"name": "author_transcript_hash", "type": {"kind": "bytes", "length": 32}},
    ],
}

# --- author panel (trustee-identity.md, Author panel identifier) -------------


def author_panel_id(k, keys):
    return H(ds(AUTHOR_PANEL_TAG, bytes([k, len(keys)]) + b"".join(keys)))


def author_panel_rule(k, keys, default_keys=None):
    """The validity rules in their order: size, threshold, key and duplicate-key per seat, then default-seat."""
    if len(keys) > MAX_TRUSTEES:
        return "size"
    if not 1 <= k <= len(keys):
        return "threshold"
    for i, key in enumerate(keys):
        if tv.decompress(key) is None:
            return "key"
        if key in keys[:i]:
            return "duplicate-key"
    if default_keys is not None and any(key in default_keys for key in keys):
        return "default-seat"
    return None


# --- well-formedness (election-definition.md, Well-formedness) -------------


def v6_rule(d):
    """`results`, `civic-sealed` and `author-panel`, in that order."""
    if d["results_mode"] == SEALED:
        if d["live_every"] != 0 or d["live_batch"] != 0:
            return "results"
    elif d["live_every"] < 1 or d["live_batch"] < MIN_LIVE_BATCH:
        return "results"
    if d["poll_class"] == CIVIC and d["results_mode"] != SEALED:
        return "civic-sealed"
    k, keys = d["author_threshold"], d["author_keys"]
    if k == 0 and not keys:
        if d["author_transcript_hash"] != bytes(32):
            return "author-panel"
    elif d["author_transcript_hash"] == bytes(32) or author_panel_rule(k, keys) is not None:
        return "author-panel"
    return None


def definition_rule(d):
    """(code, question) of the first failing rule, or None: version 5's, then version 6's."""
    return d5.definition_rule(as_v5(d)) or ((lambda r: r and (r, None))(v6_rule(d)))


# --- definitions ----------------------------------------------------------------

PINS_V6 = [(1, 6)] + d5.PINS_V5[1:]
PROFILE = {"protocol_major": 1, "pins": PINS_V6}
# Author keys: P-256 points of scalars no default seat or receipt key uses.
AUTHOR_KEYS = [tv.compress(tv.mul(tv.secret(b"author seat " + bytes([i])), tv.G)) for i in range(MAX_TRUSTEES + 1)]
for _k in AUTHOR_KEYS:
    assert tv.decompress(_k) is not None and _k not in d4.KEYS
assert len(set(AUTHOR_KEYS)) == len(AUTHOR_KEYS)
TRANSCRIPT = dv.seq(32, 0xc0)
NO_AUTHOR = {"author_threshold": 0, "author_keys": [], "author_transcript_hash": bytes(32)}
SEALED_EVERYDAY = {"poll_class": EVERYDAY, "results_mode": SEALED, "live_every": 0, "live_batch": 0}

TYPICAL = dict(
    copy.deepcopy(d5.TYPICAL),
    profile=PROFILE,
    poll_class=EVERYDAY,
    results_mode=LIVE,
    live_every=6,
    live_batch=50,
    author_threshold=2,
    author_keys=AUTHOR_KEYS[:3],
    author_transcript_hash=TRANSCRIPT,
)
MINIMAL = dict(copy.deepcopy(d5.MINIMAL), profile=PROFILE, **SEALED_EVERYDAY, **NO_AUTHOR)
MAXIMAL = dict(
    copy.deepcopy(d5.MAXIMAL),
    profile={"protocol_major": 1, "pins": [(1, 6)] + d5.MAXIMAL["profile"]["pins"][1:]},
    poll_class=ORGANISATIONAL,
    results_mode=LIVE,
    live_every=2**32 - 1,
    live_batch=2**32 - 1,
    author_threshold=MAX_TRUSTEES,
    author_keys=AUTHOR_KEYS[:MAX_TRUSTEES],
    author_transcript_hash=b"\xff" * 32,
)


def variant(base, **changes):
    d = copy.deepcopy(base)
    d.update(changes)
    return d


def def_vectors():
    T = d4.ref("election-definition-v6")
    vs = []

    def valid(id_, d, desc, rule=None, at=None):
        e = enc_definition_v6(d)
        v = {"id": id_, "description": desc, "type": T, "value": def_json(d), "encoding": e.hex()}
        v["hash"] = H(ds("abolish/v1/election-definition", e)).hex()
        # The default panel's stub keeps author_transcript_hash; the author panel's zeroes it too.
        stub = dict(d, ceremony_transcript_hash=bytes(32))
        v["stubHash"] = H(ds("abolish/v1/election-stub", enc_definition_v6(stub))).hex()
        author_stub = dict(stub, author_transcript_hash=bytes(32))
        v["authorStubHash"] = H(ds("abolish/v1/election-stub", enc_definition_v6(author_stub))).hex()
        assert (v["authorStubHash"] == v["stubHash"]) == (d["author_transcript_hash"] == bytes(32))
        want = None if rule is None else (rule, at)
        assert definition_rule(d) == want, (id_, definition_rule(d), want)
        if rule is not None:
            v["illFormed"] = rule
        if at is not None:
            v["illFormedQuestion"] = str(at)
        if d["author_keys"]:
            v["authorPanelId"] = author_panel_id(d["author_threshold"], d["author_keys"]).hex()
        vs.append(v)

    def invalid(id_, enc, err, desc):
        vs.append({"id": id_, "description": desc, "type": T, "encoding": enc.hex(), "error": err})

    # Cross-check against version 5's encoder: version 6's bytes are version
    # 5's, labelled 6, followed by the new fields.
    tail = u8(1) + u8(2) + u32(6) + u32(50) + u8(2) + u32(3) + b"".join(AUTHOR_KEYS[:3]) + TRANSCRIPT
    assert enc_definition_v6(TYPICAL) == d5.enc_definition_v5(as_v5(TYPICAL), version=6) + tail

    valid(
        "definition-v6-typical",
        TYPICAL,
        "Version 5's typical definition as an everyday poll with live results every 6 anchoring periods in batches of 50, and a 2-of-3 author panel",
    )
    valid("definition-v6-minimal", MINIMAL, "Version 5's minimal definition, sealed and everyday, with no author panel")
    valid(
        "definition-v6-lists-at-max",
        MAXIMAL,
        "Version 5's definition with every list at its maximum and a 16-of-16 author panel, live with live_every and live_batch at the u32 maximum",
    )
    civic = variant(MINIMAL, poll_class=CIVIC)
    valid("definition-v6-civic-sealed", civic, "A civic referendum, sealed, with no author panel")
    valid(
        "definition-v6-civic-author-panel",
        variant(civic, author_threshold=1, author_keys=AUTHOR_KEYS[:1], author_transcript_hash=TRANSCRIPT),
        "A civic referendum with a 1-of-1 author panel: an author panel is never alone, so k_A = 1 is allowed",
    )
    valid(
        "definition-v6-organisational-live",
        variant(MINIMAL, poll_class=ORGANISATIONAL, results_mode=LIVE, live_every=1, live_batch=MIN_LIVE_BATCH),
        "An organisational vote with live results at the floor: every anchoring period, batches of 20",
    )

    te = enc_definition_v6(TYPICAL)
    end5 = len(d5.enc_definition_v5(as_v5(TYPICAL)))
    invalid("definition-v6-truncated", te[:-1], "truncated", "The last byte of author_transcript_hash is missing")
    invalid("definition-v6-trailing", te + b"\x00", "trailing-bytes", "One byte after author_transcript_hash")
    for value in (0, 4):
        invalid(
            f"definition-v6-poll-class-{value}",
            te[:end5] + u8(value) + te[end5 + 1 :],
            "invalid-enum",
            f"poll_class {value}; version 6 allows 1, 2 and 3",
        )
    for value in (0, 3):
        invalid(
            f"definition-v6-results-mode-{value}",
            te[: end5 + 1] + u8(value) + te[end5 + 2 :],
            "invalid-enum",
            f"results_mode {value}; version 6 allows 1 and 2",
        )
    keys_at = end5 + 1 + 1 + 4 + 4 + 1
    assert te[keys_at : keys_at + 4] == u32(3)
    invalid(
        "definition-v6-author-keys-over-max",
        te[:keys_at] + u32(MAX_TRUSTEES + 1) + te[keys_at + 4 :],
        "length-over-max",
        "An author_keys count of 17, over its maximum of 16, rejected before any key is read",
    )
    invalid(
        "definition-v6-author-key-uncompressed",
        te[:keys_at] + u32(3) + b"\x04" + te[keys_at + 5 :],
        "non-canonical",
        "The first author key's prefix byte is 0x04, the uncompressed form p256-key never accepts",
    )
    invalid(
        "definition-v6-version-seven",
        enc_definition_v6(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 7)] + PINS_V6[1:]}), version=7),
        "unknown-version",
        "Version 6's layout labelled version 7, which has no layout",
    )
    invalid(
        "definition-v6-profile-pins-five",
        enc_definition_v6(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 5)] + PINS_V6[1:]})),
        "profile-mismatch",
        "A version-6 definition whose own profile pins 0x0001 at version 5",
    )
    invalid(
        "definition-v6-labelled-five",
        enc_definition_v6(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 5)] + PINS_V6[1:]}), version=5),
        "trailing-bytes",
        "Version 6's bytes labelled version 5, with a profile pinning 5: version 5's layout ends at receipt_keys, before poll_class",
    )
    v5_as_6 = d5.enc_definition_v5(as_v5(variant(TYPICAL, profile=PROFILE)), version=6)
    invalid(
        "definition-v5-labelled-six",
        v5_as_6,
        "truncated",
        "Version 5's bytes labelled version 6, with a profile pinning 6: the record ends where poll_class begins. (election-definition-v5.json's definition-v5-version-six, unknown-version, is read by a decoder of versions 4 and 5 only.)",
    )

    ill = [
        ("results", "definition-v6-sealed-with-schedule", variant(MINIMAL, live_every=6), "Sealed, with live_every 6"),
        ("results", "definition-v6-sealed-with-batch", variant(MINIMAL, live_batch=50), "Sealed, with live_batch 50"),
        ("results", "definition-v6-live-every-zero", variant(TYPICAL, live_every=0), "Live, with live_every 0: no schedule"),
        ("results", "definition-v6-live-batch-under-floor", variant(TYPICAL, live_batch=MIN_LIVE_BATCH - 1), "Live, with live_batch 19, one under MIN_LIVE_BATCH"),
        ("results", "definition-v6-live-batch-zero", variant(TYPICAL, live_batch=0), "Live, with live_batch 0"),
        ("civic-sealed", "definition-v6-civic-live", variant(TYPICAL, poll_class=CIVIC), "A civic referendum with live results"),
        (
            "results",
            "definition-v6-civic-live-and-batch-broken",
            variant(TYPICAL, poll_class=CIVIC, live_batch=1),
            "A civic referendum with live results in batches of 1: results comes before civic-sealed",
        ),
        ("author-panel", "definition-v6-author-threshold-zero", variant(TYPICAL, author_threshold=0), "Three author keys with author_threshold 0"),
        ("author-panel", "definition-v6-author-threshold-over-n", variant(TYPICAL, author_threshold=4), "A 4-of-3 author panel"),
        ("author-panel", "definition-v6-author-threshold-no-keys", variant(MINIMAL, author_threshold=1), "author_threshold 1 with no author keys"),
        (
            "author-panel",
            "definition-v6-author-transcript-no-panel",
            variant(MINIMAL, author_transcript_hash=TRANSCRIPT),
            "No author panel, but a non-zero author_transcript_hash: 32 chosen bytes with nothing to check them against",
        ),
        (
            "author-panel",
            "definition-v6-author-panel-zero-transcript",
            variant(MINIMAL, author_threshold=2, author_keys=AUTHOR_KEYS[:2], author_transcript_hash=bytes(32)),
            "A 2-of-2 author panel whose transcript hash is zero: its author stub would be its default stub",
        ),
        (
            "author-panel",
            "definition-v6-author-duplicate-key",
            variant(TYPICAL, author_keys=[AUTHOR_KEYS[0], AUTHOR_KEYS[1], AUTHOR_KEYS[0]]),
            "The first author key again at seat 3",
        ),
        (
            "civic-sealed",
            "definition-v6-civic-live-and-author-broken",
            variant(TYPICAL, poll_class=CIVIC, author_threshold=4),
            "A live civic referendum with a 4-of-3 author panel: civic-sealed comes before author-panel",
        ),
        (
            "receipt-keys",
            "definition-v6-keys-and-results-broken",
            variant(TYPICAL, live_every=0, receipt_keys=[d4.KEYS[1], d4.KEYS[0]]),
            "Receipt keys in descending order and live_every 0: version 5's rules come first",
        ),
        (
            "selections",
            "definition-v6-selections-and-author-broken",
            variant(TYPICAL, questions=[d5.q(3, 0, 0)], author_threshold=0),
            "A question no ballot can answer and a broken author panel: the question is reported",
        ),
    ]
    for rule, id_, d, desc in ill:
        valid(id_, d, desc, rule, 0 if rule == "selections" else None)
    return vs


def author_panel_vectors():
    out = []
    default = d4.KEYS[2:5]  # stand-in default seats, for default-seat
    k3 = AUTHOR_KEYS[:3]
    cases = [
        ("author-panel-1-of-1", 1, AUTHOR_KEYS[:1], None, "k_A = 1 is allowed: an author panel is never alone"),
        ("author-panel-2-of-3", 2, k3, None, "The typical definition's author panel"),
        ("author-panel-2-of-3-reordered", 2, [k3[1], k3[0], k3[2]], None, "The same keys with seats 1 and 2 swapped: another panel"),
        ("author-panel-16-of-16", MAX_TRUSTEES, AUTHOR_KEYS[:MAX_TRUSTEES], None, "MAX_TRUSTEES seats"),
        ("author-panel-17-seats", 2, AUTHOR_KEYS, None, "17 seats, over MAX_TRUSTEES"),
        ("author-panel-threshold-0", 0, k3, None, "k_A = 0"),
        ("author-panel-threshold-over-n", 4, k3, None, "k_A above n_A"),
        ("author-panel-empty", 1, [], None, "No seats"),
        ("author-panel-bad-key", 1, [k3[0], b"\x04" + k3[1][1:]], None, "A seat whose key isn't a p256-key"),
        ("author-panel-duplicate-key", 1, [k3[0], k3[1], k3[0]], None, "One key at seats 1 and 3"),
        ("author-panel-default-seat", 2, [k3[0], default[1]], default, "Seat 2 holds a default seat's key"),
        ("author-panel-default-seat-after-duplicate", 2, [default[0], default[0]], default, "A repeated key that is also a default seat's: duplicate-key comes first"),
        ("author-panel-disjoint", 2, k3, default, "No key in common with the default panel"),
    ]
    for id_, k, keys, default_keys, desc in cases:
        v = {"id": id_, "description": desc, "threshold": str(k), "keys": [x.hex() for x in keys]}
        if default_keys is not None:
            v["defaultKeys"] = [x.hex() for x in default_keys]
        err = author_panel_rule(k, keys, default_keys)
        if err is None:
            v["authorPanelId"] = author_panel_id(k, keys).hex()
            # The default panel's identifier over the same k and keys differs: the tags differ.
            assert v["authorPanelId"] != tv.panel_id(k, keys).hex()
        else:
            v["error"] = err
        out.append(v)
    return out


def main():
    out_dir = pathlib.Path(sys.argv[1])
    content = {
        "format": "abolish-vectors/1",
        "title": "Election definition, version 6 (poll class, results mode and author panel)",
        "spec": "docs/spec/election-definition.md",
        "generator": (
            "Printed by packages/crypto/scripts/definition-v6-vectors.py, written from docs/spec/election-definition.md "
            "(Layout (version 6), Well-formedness) and docs/spec/trustee-identity.md (Author panel identifier) with only the "
            "Python standard library, independently of packages/crypto, reusing definition-v5-vectors.py's version-5 values "
            "and rules and trustee-vectors.py's P-256 arithmetic. Its encoder is checked against version 5's: version 6's "
            "bytes are version 5's followed by the new fields. Its own implementation of the rules confirms every valid "
            "vector's illFormed label (or its absence) and every author panel's error; decode errors are labelled by hand."
        ),
        "tags": {"authorPanel": AUTHOR_PANEL_TAG},
        "minLiveBatch": str(MIN_LIVE_BATCH),
        "types": DEF_TYPES,
        "vectors": def_vectors(),
        "authorPanels": author_panel_vectors(),
    }
    (out_dir / "election-definition-v6.json").write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
