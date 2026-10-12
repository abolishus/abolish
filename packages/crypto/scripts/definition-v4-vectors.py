#!/usr/bin/env python3
"""Prints docs/spec/vectors/election-definition-v4.json.

Written from docs/spec/election-definition.md (Layout (version 4), Receipt
keys, Well-formedness) alone, independently of packages/crypto, with only the
Python standard library. It reuses regional-cells-vectors.py's version-3
encoder, values and rules, and trustee-vectors.py's P-256 arithmetic and
`p256-key` decoding (self-checked there against the curve's order), both
independent of packages/crypto too.

    python3 -I -B packages/crypto/scripts/definition-v4-vectors.py docs/spec/vectors

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


rc = load("regional_cells_vectors", "regional-cells-vectors.py")
tv = load("trustee_vectors", "trustee-vectors.py")
dv = rc.dv

u32, lst, ds, H = dv.u32, dv.lst, dv.ds, dv.H
U64_MAX = dv.U64_MAX
MAX_KEYS = 4

# --- version-4 layout ---------------------------------------------------------


def enc_key(k):
    # Encoded as given, so a vector can carry a key the decoder must reject.
    assert len(k) == 33
    return k


def enc_definition_v4(d, version=4):
    """Version 3's bytes, then the receipt keys: the field after display_text_commitment."""
    return rc.enc_definition_v3(d, version) + lst(d["receipt_keys"], MAX_KEYS, enc_key)


def def_json(d):
    j = rc.def_json(d)
    j["receipt_keys"] = [k.hex() for k in d["receipt_keys"]]
    return j


DEF_TYPES = {k: v for k, v in rc.DEF_TYPES.items() if k != "election-definition-v3"}
DEF_TYPES["election-definition-v4"] = {
    "kind": "record",
    "recordType": "0001",
    "version": 4,
    "fields": rc.DEF_TYPES["election-definition-v3"]["fields"]
    + [{"name": "receipt_keys", "type": {"kind": "list", "max": MAX_KEYS, "of": {"kind": "p256-key"}}}],
}

# --- well-formedness (election-definition.md, Well-formedness) -------------


def definition_rule(d):
    rule = rc.definition_rule(d)
    if rule is not None:
        return rule
    keys = d["receipt_keys"]
    # Python compares bytes lexicographically, as the spec orders encodings.
    if not keys or any(keys[i - 1] >= keys[i] for i in range(1, len(keys))):
        return "receipt-keys"
    return None


# --- receipt keys (election-definition.md, Receipt keys) --------------------


def judgement(registered_at, retired_at, opens_at, proven_at):
    """Written from the spec's prose: whether a listed key judges the election."""
    registered_before = registered_at != 0 and registered_at < opens_at
    if registered_before and retired_at != 0 and retired_at <= opens_at:
        return "retired"
    if proven_at < opens_at:
        return "unsettled"
    return "judges" if registered_before else "unregistered"


def possible(registered_at, retired_at, proven_at):
    """Whether the anchor can hold this record at a block of time proven_at."""
    if registered_at > proven_at or retired_at > proven_at:
        return False
    return retired_at == 0 or (registered_at != 0 and retired_at >= registered_at)


KEYS = sorted(tv.compress(tv.mul(k, tv.G)) for k in range(1, 6))
for k in KEYS:
    assert tv.decompress(k) is not None

# --- definitions ----------------------------------------------------------------

PINS_V4 = [(1, 4)] + [(t, 1) for t in range(2, 10)]
PROFILE = {"protocol_major": 1, "pins": PINS_V4}

TYPICAL = dict(copy.deepcopy(rc.TYPICAL), profile=PROFILE, receipt_keys=KEYS[:2])
MINIMAL = dict(copy.deepcopy(rc.MINIMAL), profile=PROFILE, receipt_keys=KEYS[:1])
MAXIMAL = dict(
    copy.deepcopy(rc.MAXIMAL),
    profile={"protocol_major": 1, "pins": [(1, 4)] + [(t, 255) for t in range(2, 10)]},
    receipt_keys=KEYS[1:],
)
MAXIMAL["electorate"] = MAXIMAL["electorate"][1:]


def variant(base, **changes):
    d = copy.deepcopy(base)
    d.update(changes)
    return d


def ref(name):
    return {"kind": "ref", "name": name}


def def_vectors():
    T = ref("election-definition-v4")
    vs = []

    def valid(id_, d, desc, rule=None):
        e = enc_definition_v4(d)
        v = {"id": id_, "description": desc, "type": T, "value": def_json(d), "encoding": e.hex()}
        v["hash"] = H(ds("abolish/v1/election-definition", e)).hex()
        v["stubHash"] = H(ds("abolish/v1/election-stub", enc_definition_v4(dict(d, ceremony_transcript_hash=bytes(32))))).hex()
        assert definition_rule(d) == rule, (id_, definition_rule(d), rule)
        if rule is not None:
            v["illFormed"] = rule
        vs.append(v)

    def invalid(id_, enc, err, desc):
        vs.append({"id": id_, "description": desc, "type": T, "encoding": enc.hex(), "error": err})

    valid("definition-v4-typical", TYPICAL, "Version 3's typical definition, with two receipt keys in ascending order")
    valid("definition-v4-minimal", MINIMAL, "Every field at its smallest well-formed value, with one receipt key")
    valid(
        "definition-v4-lists-at-max",
        MAXIMAL,
        "Version 3's definition with every list at its maximum, and four receipt keys, the most a definition may list",
    )
    # The four keys of lists-at-max carry both prefixes, ordered by whole encodings.
    assert {k[0] for k in MAXIMAL["receipt_keys"]} == {2, 3}

    te = enc_definition_v4(TYPICAL)
    keys_at = len(te) - 4 - 33 * len(TYPICAL["receipt_keys"])
    assert te[keys_at : keys_at + 4] == u32(len(TYPICAL["receipt_keys"]))
    first_key = keys_at + 4

    def with_first_key(k):
        return te[:first_key] + k + te[first_key + 33 :]

    invalid("definition-v4-truncated", te[:-1], "truncated", "The last byte of the last receipt key is missing")
    invalid("definition-v4-trailing", te + b"\x00", "trailing-bytes", "One byte after receipt_keys")
    invalid(
        "definition-v4-keys-over-max",
        te[:keys_at] + u32(MAX_KEYS + 1) + te[keys_at + 4 :],
        "length-over-max",
        "A receipt_keys count of 5, over its maximum of 4, rejected before any key is read",
    )
    off_curve_x = next(x for x in range(1, 100) if tv.decompress(b"\x02" + x.to_bytes(32, "big")) is None)
    for id_, key, desc in [
        ("definition-v4-key-prefix-04", b"\x04" + KEYS[0][1:], "A receipt key with prefix 0x04, the uncompressed form's"),
        ("definition-v4-key-prefix-00", b"\x00" + KEYS[0][1:], "A receipt key with prefix 0x00"),
        ("definition-v4-key-x-is-p", b"\x02" + tv.P.to_bytes(32, "big"), "A receipt key whose x is p, not reduced"),
        ("definition-v4-key-off-curve", b"\x02" + off_curve_x.to_bytes(32, "big"), f"A receipt key whose x ({off_curve_x}) is on no point of the curve"),
    ]:
        assert tv.decompress(key) is None
        invalid(id_, with_first_key(key), "non-canonical", desc)
    invalid(
        "definition-v4-version-five",
        enc_definition_v4(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 5)] + PINS_V4[1:]}), version=5),
        "unknown-version",
        "Version 4's layout labelled version 5, which has no layout",
    )
    invalid(
        "definition-v4-profile-pins-three",
        enc_definition_v4(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 3)] + PINS_V4[1:]})),
        "profile-mismatch",
        "A version-4 definition whose own profile pins 0x0001 at version 3",
    )
    invalid(
        "definition-v4-as-version-three",
        enc_definition_v4(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 3)] + PINS_V4[1:]}), version=3),
        "trailing-bytes",
        "Version 4's bytes labelled version 3, with a profile pinning 3: decoding step 1 reads version 3's layout and leaves the receipt keys unread",
    )
    invalid(
        "definition-v3-labelled-four",
        rc.enc_definition_v3(variant(TYPICAL, profile=PROFILE), version=4),
        "truncated",
        "Version 3's bytes labelled version 4: the receipt keys' count is missing",
    )

    ill = [
        ("receipt-keys", "definition-v4-keys-empty", variant(TYPICAL, receipt_keys=[]), "No receipt keys"),
        ("receipt-keys", "definition-v4-keys-descending", variant(TYPICAL, receipt_keys=[KEYS[1], KEYS[0]]), "Two keys in descending order"),
        ("receipt-keys", "definition-v4-key-twice", variant(TYPICAL, receipt_keys=[KEYS[0], KEYS[0]]), "One key listed twice"),
        (
            "receipt-keys",
            "definition-v4-keys-prefix-order",
            variant(TYPICAL, receipt_keys=sorted(KEYS[:4], key=lambda k: k[1:])),
            "Four keys ordered by x alone, not by their whole encodings, prefix first",
        ),
        ("protocol-major", "definition-v4-protocol-major-two", variant(TYPICAL, profile={"protocol_major": 2, "pins": PINS_V4}, receipt_keys=[]), "profile.protocol_major 2 and no keys: version 1's rules come first"),
        ("cells", "definition-v4-cells-and-keys-broken", rc.tier_variant(variant(TYPICAL, receipt_keys=[]), 0, cells=[]), "Both cells and receipt-keys fail: cells comes first"),
        ("timing", "definition-v4-timing-and-keys-broken", variant(TYPICAL, closes_at=0, receipt_keys=[KEYS[1], KEYS[0]]), "Both timing and receipt-keys fail: receipt-keys is checked last"),
    ]
    assert [k[1:] for k in ill[3][2]["receipt_keys"]] == sorted(k[1:] for k in KEYS[:4])
    assert ill[3][2]["receipt_keys"] != sorted(KEYS[:4])
    for rule, id_, d, desc in ill:
        valid(id_, d, desc, rule)
    return vs


JUDGING = [
    # id, registeredAt, retiredAt, opensAt, provenAt, note
    ("registered-before", 100, 0, 1000, 1000, "registered before opens_at, read at opens_at"),
    ("registered-one-second-before", 999, 0, 1000, 5000, "registered one second before opens_at"),
    ("registered-at-opens", 1000, 0, 1000, 5000, "registered at opens_at: too late"),
    ("registered-after", 1001, 0, 1000, 5000, "registered after opens_at"),
    ("never-registered", 0, 0, 1000, 5000, "never registered"),
    ("retired-before", 100, 500, 1000, 5000, "retired before opens_at"),
    ("retired-at-opens", 100, 1000, 1000, 5000, "retired at opens_at: by then"),
    ("retired-after", 100, 1001, 1000, 5000, "retired one second after opens_at: changes nothing for this election"),
    ("registered-and-retired-same-block", 100, 100, 1000, 5000, "registered and retired in one block before opens_at"),
    ("registered-after-and-retired", 2000, 3000, 1000, 5000, "registered and retired after opens_at"),
    ("read-before-opens", 100, 0, 1000, 999, "registered, read at a block before opens_at: a retirement may still come"),
    ("read-before-opens-unregistered", 0, 0, 1000, 999, "not registered yet, read before opens_at: a registration may still come"),
    ("read-before-opens-retired", 100, 500, 1000, 999, "retired already, read before opens_at: final"),
    ("timestamps-at-max", U64_MAX - 2, U64_MAX, U64_MAX - 1, U64_MAX, "u64 extremes: retired one second after opens_at"),
]
IMPOSSIBLE = [
    ("written-after-read", 100, 0, 1000, 99, "registered after the block it was read at"),
    ("retired-unregistered", 0, 500, 1000, 5000, "retired but never registered"),
    ("retired-before-registered", 600, 500, 1000, 5000, "retired before it was registered"),
    ("retired-after-read", 100, 6000, 1000, 5000, "retired after the block it was read at"),
]


def judging_vectors():
    out = []
    for id_, reg, ret, opens, proven, note in JUDGING:
        assert possible(reg, ret, proven), id_
        out.append(
            {
                "id": id_,
                "note": note,
                "registeredAt": str(reg),
                "retiredAt": str(ret),
                "opensAt": str(opens),
                "provenAt": str(proven),
                "judgement": judgement(reg, ret, opens, proven),
            }
        )
    for id_, reg, ret, opens, proven, note in IMPOSSIBLE:
        assert not possible(reg, ret, proven), id_
        out.append(
            {
                "id": id_,
                "note": note,
                "registeredAt": str(reg),
                "retiredAt": str(ret),
                "opensAt": str(opens),
                "provenAt": str(proven),
                "error": "impossible-record",
            }
        )
    seen = {v.get("judgement") for v in out}
    assert seen >= {"judges", "unregistered", "retired", "unsettled"}
    return out


def main():
    out_dir = pathlib.Path(sys.argv[1])
    gen = (
        "Printed by packages/crypto/scripts/definition-v4-vectors.py, written from docs/spec/election-definition.md "
        "(Layout (version 4), Receipt keys, Well-formedness) with only the Python standard library, independently of "
        "packages/crypto, reusing regional-cells-vectors.py's version-3 encoder and rules and trustee-vectors.py's "
        "P-256 arithmetic. Its own implementation of the rules confirms every valid vector's illFormed label (or its "
        "absence) and every judgement; decode errors are labelled by hand."
    )
    content = {
        "format": "abolish-vectors/1",
        "title": "Election definition, version 4 (receipt keys)",
        "spec": "docs/spec/election-definition.md",
        "generator": gen,
        "types": DEF_TYPES,
        "vectors": def_vectors(),
        "judging": judging_vectors(),
    }
    (out_dir / "election-definition-v4.json").write_text(
        json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
