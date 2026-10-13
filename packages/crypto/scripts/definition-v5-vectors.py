#!/usr/bin/env python3
"""Prints docs/spec/vectors/election-definition-v5.json and display-text-v2.json.

Written from docs/spec/election-definition.md (Layout (version 5), Questions,
Well-formedness) and docs/spec/display-text.md (Layout (version 2)) alone,
independently of packages/crypto, with only the Python standard library. It
reuses definition-v4-vectors.py's version-4 values, keys and rules (and through
it regional-cells-vectors.py's electorate encoder and definition-vectors.py's
primitive encoders), all independent of packages/crypto too.

    python3 -I -B packages/crypto/scripts/definition-v5-vectors.py docs/spec/vectors

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


d4 = load("definition_v4_vectors", "definition-v4-vectors.py")
rc = d4.rc
dv = d4.dv

u8, u16, u32, u64, fixed, utf8, lst, ds, H = dv.u8, dv.u16, dv.u32, dv.u64, dv.fixed, dv.utf8, dv.lst, dv.ds, dv.H
raw = dv.raw
U64_MAX = dv.U64_MAX
MAX_OPTIONS = 64  # parameters.md
MAX_QUESTIONS = 32  # parameters.md
MAX_DISPLAY_TEXT = 4_194_304  # parameters.md
HEAD_RULES = {"protocol-major", "profile-order", "profile-types", "profile-version"}

# --- version-5 layout ---------------------------------------------------------


def enc_question(q):
    return u8(q["method"]) + u16(q["option_count"]) + u16(q["min_selections"]) + u16(q["max_selections"])


def enc_definition_v5(d, version=5):
    """Written field by field from Layout (version 5)."""
    out = u16(0x0001) + u8(version)
    p = d["profile"]
    out += u8(p["protocol_major"]) + lst(p["pins"], 64, lambda x: u16(x[0]) + u8(x[1]))
    out += fixed(d["election_id"], 32) + u64(d["l2_chain_id"]) + u64(d["l1_chain_id"])
    for k in ["election_registry", "board", "trustee_registry", "group_registry", "l1_anchor", "l1_relay"]:
        out += fixed(d[k], 20)
    out += lst(d["questions"], MAX_QUESTIONS, enc_question)
    out += u8(d["tally_scheme"])
    out += lst(d["electorate"], 3, rc.enc_tier)
    out += fixed(d["membership_vk_hash"], 32) + fixed(d["panel_id"], 32)
    out += u8(d["threshold"]) + u8(d["panel_size"]) + fixed(d["ceremony_transcript_hash"], 32)
    out += u64(d["opens_at"]) + u64(d["closes_at"]) + u32(d["l1_inclusion_bound"])
    out += u64(d["sequencing_window"]) + u64(d["max_sequencer_drift"])
    out += fixed(d["display_text_commitment"], 32)
    out += lst(d["receipt_keys"], d4.MAX_KEYS, d4.enc_key)
    return out


def as_v4(d, election_type=2):
    """The version-4 definition with the same other fields and one stand-in question."""
    v4 = {k: v for k, v in d.items() if k != "questions"}
    return dict(v4, election_type=election_type, option_count=2, min_selections=0, max_selections=1)


def def_json(d):
    j = d4.def_json(as_v4(d))
    for k in ["election_type", "option_count", "min_selections", "max_selections"]:
        del j[k]
    j["questions"] = [{k: str(v) for k, v in q.items()} for q in d["questions"]]
    # The field order of the layout, so the file reads as the table does.
    order = [f["name"] for f in DEF_TYPES["election-definition-v5"]["fields"]]
    assert sorted(order) == sorted(j)
    return {k: j[k] for k in order}


QUESTION_TYPE = {
    "kind": "struct",
    "fields": [
        {"name": "method", "type": {"kind": "enum8", "values": ["1"]}},
        {"name": "option_count", "type": {"kind": "u16"}},
        {"name": "min_selections", "type": {"kind": "u16"}},
        {"name": "max_selections", "type": {"kind": "u16"}},
    ],
}


def v5_fields():
    out = []
    for f in d4.DEF_TYPES["election-definition-v4"]["fields"]:
        if f["name"] == "election_type":
            out.append({"name": "questions", "type": {"kind": "list", "max": MAX_QUESTIONS, "of": d4.ref("question")}})
        elif f["name"] not in ("option_count", "min_selections", "max_selections"):
            out.append(f)
    return out


DEF_TYPES = {k: v for k, v in d4.DEF_TYPES.items() if k != "election-definition-v4"}
DEF_TYPES["question"] = QUESTION_TYPE
DEF_TYPES["election-definition-v5"] = {"kind": "record", "recordType": "0001", "version": 5, "fields": v5_fields()}

# --- well-formedness (election-definition.md, Well-formedness) -------------


def questions_rule(d):
    """`questions`, `option-count` and `selections`, with the first failing question."""
    qs = d["questions"]
    if not qs:
        return "questions", None
    total = 0
    for i, q in enumerate(qs):
        total += q["option_count"]
        if q["option_count"] < 2 or total > MAX_OPTIONS:
            return "option-count", i
    for i, q in enumerate(qs):
        mn, mx, m = q["min_selections"], q["max_selections"], q["option_count"]
        if not (mn <= mx <= m and mx >= 1):
            return "selections", i
    return None


def definition_rule(d):
    """(code, question) of the first failing rule, or None."""
    # Version 4's rules on the same fields with an approval stand-in question
    # that passes its own two rules, so only the head and the tail can fail.
    r4 = d4.definition_rule(as_v4(d))
    assert r4 not in ("option-count", "selections")
    if r4 in HEAD_RULES:
        return r4, None
    return questions_rule(d) or ((r4, None) if r4 is not None else None)


# --- definitions ----------------------------------------------------------------

PINS_V5 = [(1, 5), (2, 3)] + [(t, 1) for t in range(3, 7)] + [(7, 4), (8, 1), (9, 2)]
PROFILE = {"protocol_major": 1, "pins": PINS_V5}


def q(m, mn, mx, method=1):
    return {"method": method, "option_count": m, "min_selections": mn, "max_selections": mx}


def strip_v4(base):
    d = copy.deepcopy(base)
    for k in ["election_type", "option_count", "min_selections", "max_selections"]:
        del d[k]
    return d


# The owner's four methods, as limits: pick one, pick any, pick up to two, pick exactly three.
OWNERS_FOUR = [q(3, 0, 1), q(5, 0, 5), q(4, 0, 2), q(6, 3, 3)]
TYPICAL = dict(strip_v4(d4.TYPICAL), profile=PROFILE, questions=OWNERS_FOUR)
MINIMAL = dict(strip_v4(d4.MINIMAL), profile=PROFILE, questions=[q(2, 0, 1)])
MAXIMAL = dict(
    strip_v4(d4.MAXIMAL),
    profile={"protocol_major": 1, "pins": [(1, 5)] + [(t, 255) for t in range(2, 10)]},
    questions=[q(2, 2, 2)] * MAX_QUESTIONS,
)


def variant(base, **changes):
    d = copy.deepcopy(base)
    d.update(changes)
    return d


def def_vectors():
    T = d4.ref("election-definition-v5")
    vs = []

    def valid(id_, d, desc, rule=None, at=None):
        e = enc_definition_v5(d)
        v = {"id": id_, "description": desc, "type": T, "value": def_json(d), "encoding": e.hex()}
        v["hash"] = H(ds("abolish/v1/election-definition", e)).hex()
        v["stubHash"] = H(ds("abolish/v1/election-stub", enc_definition_v5(dict(d, ceremony_transcript_hash=bytes(32))))).hex()
        want = None if rule is None else (rule, at)
        assert definition_rule(d) == want, (id_, definition_rule(d), want)
        if rule is not None:
            v["illFormed"] = rule
        if at is not None:
            v["illFormedQuestion"] = str(at)
        vs.append(v)

    def invalid(id_, enc, err, desc):
        vs.append({"id": id_, "description": desc, "type": T, "encoding": enc.hex(), "error": err})

    # Cross-check against version 4's encoder: a one-question version-5
    # definition is version 4's bytes with the four question fields moved into
    # a one-entry list ahead of tally_scheme.
    one = variant(TYPICAL, questions=[q(3, 0, 1)])
    e4 = d4.enc_definition_v4(as_v4(one, election_type=1) | {"option_count": 3}, version=5)
    at = 3 + 1 + 4 + 3 * len(PINS_V5) + 32 + 16 + 6 * 20
    assert e4[at : at + 8] == u8(1) + u8(1) + u16(3) + u16(0) + u16(1)
    assert enc_definition_v5(one) == e4[:at] + u32(1) + u8(1) + u16(3) + u16(0) + u16(1) + u8(1) + e4[at + 8 :]

    valid("definition-v5-typical", TYPICAL, "Version 4's typical definition with the owner's four methods as limits: pick one of 3, any of 5, up to 2 of 4, exactly 3 of 6")
    valid("definition-v5-minimal", MINIMAL, "Every field at its smallest well-formed value: one question, pick one of 2")
    valid(
        "definition-v5-lists-at-max",
        MAXIMAL,
        "Version 4's definition with every list at its maximum: 32 questions of 2 options each, pick exactly 2, so 64 options in all",
    )
    valid("definition-v5-one-question-64-options", variant(TYPICAL, questions=[q(64, 64, 64)]), "One question of 64 options, every one selected: the whole option budget in one question")
    valid("definition-v5-pick-one-required", variant(TYPICAL, questions=[q(2, 1, 1), q(3, 0, 1)]), "Pick one with an answer required, (1, 1), then pick one or none")
    valid("definition-v5-range", variant(TYPICAL, questions=[q(6, 2, 4)]), "Pick two to four of six, a range beyond the owner's four methods")
    valid("definition-v5-budget-at-max", variant(TYPICAL, questions=[q(62, 0, 1), q(2, 0, 2)]), "62 options and 2 options: 64 in all, the most a poll may have")

    te = enc_definition_v5(TYPICAL)
    at = 3 + 1 + 4 + 3 * len(PINS_V5) + 32 + 16 + 6 * 20
    assert te[at : at + 4] == u32(len(OWNERS_FOUR))
    first_method = at + 4
    invalid("definition-v5-truncated", te[:-1], "truncated", "The last byte of the last receipt key is missing")
    invalid("definition-v5-trailing", te + b"\x00", "trailing-bytes", "One byte after receipt_keys")
    invalid(
        "definition-v5-questions-over-max",
        te[:at] + u32(MAX_QUESTIONS + 1) + te[at + 4 :],
        "length-over-max",
        "A questions count of 33, over its maximum of 32, rejected before any question is read",
    )
    for method in (0, 2):
        invalid(
            f"definition-v5-method-{method}",
            te[:first_method] + u8(method) + te[first_method + 1 :],
            "invalid-enum",
            f"The first question's method is {method}; version 5 allows only 1, selection",
        )
    invalid(
        "definition-v5-version-six",
        enc_definition_v5(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 6)] + PINS_V5[1:]}), version=6),
        "unknown-version",
        "Version 5's layout labelled version 6, which has no layout",
    )
    invalid(
        "definition-v5-profile-pins-four",
        enc_definition_v5(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 4)] + PINS_V5[1:]})),
        "profile-mismatch",
        "A version-5 definition whose own profile pins 0x0001 at version 4",
    )
    v4_as_5 = d4.enc_definition_v4(as_v4(TYPICAL, election_type=1) | {"option_count": 3}, version=5)
    assert v4_as_5[at : at + 4] == bytes.fromhex("01010003")
    invalid(
        "definition-v4-labelled-five",
        v4_as_5,
        "length-over-max",
        "Version 4's bytes labelled version 5, with a profile pinning 5: election_type, tally_scheme and option_count (1, 1, 3) read as a questions count of 16842755",
    )
    invalid(
        "definition-v5-labelled-four",
        enc_definition_v5(variant(TYPICAL, profile={"protocol_major": 1, "pins": [(1, 4)] + PINS_V5[1:]}), version=4),
        "invalid-enum",
        "Version 5's bytes labelled version 4, with a profile pinning 4: the questions count's first byte, 0, read as election_type",
    )

    keys_rev = [d4.KEYS[1], d4.KEYS[0]]
    ill = [
        ("questions", None, "definition-v5-no-questions", variant(TYPICAL, questions=[]), "No questions"),
        ("option-count", 0, "definition-v5-one-option", variant(TYPICAL, questions=[q(1, 0, 1)]), "A question of one option"),
        ("option-count", 1, "definition-v5-zero-options", variant(TYPICAL, questions=[q(3, 0, 1), q(0, 0, 0)]), "A second question of no options"),
        ("option-count", 0, "definition-v5-65-options-in-one", variant(TYPICAL, questions=[q(65, 0, 1)]), "One question of 65 options, over MAX_OPTIONS"),
        ("option-count", 1, "definition-v5-budget-over", variant(TYPICAL, questions=[q(33, 0, 1), q(32, 0, 1)]), "33 and 32 options: 65 in all, over MAX_OPTIONS at the second question"),
        (
            "option-count",
            2,
            "definition-v5-budget-over-at-third",
            variant(TYPICAL, questions=[q(30, 0, 1), q(30, 0, 1), q(5, 0, 1), q(1, 0, 1)]),
            "30, 30 and 5 options, then a question of 1: the budget is passed at the third question, before the fourth's own count fails",
        ),
        (
            "option-count",
            0,
            "definition-v5-option-count-u16-max",
            variant(TYPICAL, questions=[q(65535, 0, 65535)]),
            "A question of 65535 options, which decodes and fails option-count",
        ),
        ("option-count", 31, "definition-v5-budget-over-at-last", variant(TYPICAL, questions=[q(2, 0, 1)] * 31 + [q(3, 0, 1)]), "31 questions of 2 options and one of 3: 65 in all, over at the last question"),
        ("selections", 0, "definition-v5-max-zero", variant(TYPICAL, questions=[q(3, 0, 0)]), "max_selections 0: a question no ballot can answer"),
        ("selections", 1, "definition-v5-min-over-max", variant(TYPICAL, questions=[q(3, 0, 1), q(4, 3, 2)]), "A second question with min_selections 3 over max_selections 2"),
        ("selections", 3, "definition-v5-max-over-count", variant(TYPICAL, questions=OWNERS_FOUR[:3] + [q(6, 3, 7)]), "Pick exactly 7 of 6, at the fourth question"),
        (
            "option-count",
            2,
            "definition-v5-counts-before-selections",
            variant(TYPICAL, questions=[q(3, 2, 1), q(3, 0, 1), q(1, 0, 1)]),
            "selections fails at the first question and option-count at the third: every option count is checked before any selection",
        ),
        ("protocol-major", None, "definition-v5-protocol-major-two", variant(TYPICAL, profile={"protocol_major": 2, "pins": PINS_V5}, questions=[]), "profile.protocol_major 2 and no questions: the profile's rules come first"),
        (
            "profile-types",
            None,
            "definition-v5-pins-type-ten",
            variant(TYPICAL, profile={"protocol_major": 1, "pins": PINS_V5 + [(10, 1)]}),
            "A profile pinning 0x000a as well: version 5 pins exactly 0x0001 to 0x0009, as version 4",
        ),
        ("selections", 0, "definition-v5-selections-and-cells-broken", rc.tier_variant(variant(TYPICAL, questions=[q(3, 0, 0)]), 0, cells=[]), "Both selections and cells fail: the questions come first"),
        ("cells", None, "definition-v5-cells-broken", rc.tier_variant(TYPICAL, 0, cells=[]), "cells fails, after every question passes"),
        ("receipt-keys", None, "definition-v5-keys-descending", variant(TYPICAL, receipt_keys=keys_rev), "Two receipt keys in descending order: receipt-keys is still checked last"),
        ("timing", None, "definition-v5-timing-and-keys-broken", variant(TYPICAL, closes_at=0, receipt_keys=keys_rev), "Both timing and receipt-keys fail: timing comes first"),
    ]
    for rule, q_at, id_, d, desc in ill:
        valid(id_, d, desc, rule, q_at)
    return vs


# --- display text (display-text.md, Layout (version 2)) ---------------------


def enc_display_text_v2(t, version=2):
    def enc_option(o):
        return utf8(o["label"], 512) + utf8(o["description"], 1024)

    def enc_question_text(x):
        return utf8(x["question"], 1024) + utf8(x["description"], 8192) + lst(x["options"], MAX_OPTIONS, enc_option)

    def enc_translation(x):
        return (
            utf8(x["language"], 35)
            + utf8(x["title"], 1024)
            + utf8(x["description"], 8192)
            + lst(x["questions"], MAX_QUESTIONS, enc_question_text)
        )

    return u16(0x0009) + u8(version) + fixed(t["salt"], 32) + lst(t["translations"], 32, enc_translation)


def commit(t):
    return H(ds("abolish/v1/display-text", enc_display_text_v2(t)))


def dt_json(t):
    def opt(o):
        return {"label": raw(o["label"]).hex(), "description": raw(o["description"]).hex()}

    def qt(x):
        return {"question": raw(x["question"]).hex(), "description": raw(x["description"]).hex(), "options": [opt(o) for o in x["options"]]}

    return {
        "salt": t["salt"].hex(),
        "translations": [
            {
                "language": raw(x["language"]).hex(),
                "title": raw(x["title"]).hex(),
                "description": raw(x["description"]).hex(),
                "questions": [qt(y) for y in x["questions"]],
            }
            for x in t["translations"]
        ],
    }


def display_text_rule(t, option_counts, commitment):
    """Written from the version-2 rule table, in its order."""
    if len(enc_display_text_v2(t)) > MAX_DISPLAY_TEXT:
        raise AssertionError("over MAX_DISPLAY_TEXT: a decode error, never a rule")
    if commit(t) != commitment:
        return "commitment"
    langs = [raw(x["language"]) for x in t["translations"]]
    if not langs or any(langs[i - 1] >= langs[i] for i in range(1, len(langs))):
        return "translations"
    ok = set(b"abcdefghijklmnopqrstuvwxyz0123456789-")
    if any(not 1 <= len(lang) <= 35 or any(c not in ok for c in lang) for lang in langs):
        return "language-tag"
    if any(len(x["questions"]) != len(option_counts) for x in t["translations"]):
        return "question-count"
    if any(len(y["options"]) != m for x in t["translations"] for y, m in zip(x["questions"], option_counts)):
        return "option-count"
    for x in t["translations"]:
        texts = [raw(x["title"])] + [raw(y["question"]) for y in x["questions"]] + [raw(o["label"]) for y in x["questions"] for o in y["options"]]
        if b"" in texts:
            return "question"
    for x in t["translations"]:
        if any(len({raw(o["label"]) for o in y["options"]}) != len(y["options"]) for y in x["questions"]):
            return "labels"
    for x in t["translations"]:
        if len({raw(y["question"]) for y in x["questions"]}) != len(x["questions"]):
            return "question-texts"
    return None


def opt(label, description=""):
    return {"label": label, "description": description}


EN = {
    "language": "en",
    "title": "Park and library",
    "description": "",
    "questions": [
        {"question": "Should the park stay open late?", "description": "", "options": [opt("Yes"), opt("No"), opt("Abstain", "Counted, but neither yes nor no.")]},
        {"question": "Should the library open on Sundays?", "description": "From next spring.", "options": [opt("Yes"), opt("No")]},
    ],
}
ES = {
    "language": "es-419",
    "title": "Parque y biblioteca",
    "description": "Consulta vecinal",
    "questions": [
        {"question": "¿Debe el parque abrir hasta tarde?", "description": "", "options": [opt("Sí"), opt("No"), opt("Abstención")]},
        {"question": "¿Debe la biblioteca abrir los domingos?", "description": "", "options": [opt("Sí"), opt("No")]},
    ],
}
DT = {"salt": dv.seq(32, 0x01), "translations": [EN, ES]}
DT_COUNTS = [3, 2]


def one_question(x, i=0):
    return dict(x, questions=[x["questions"][i]])


def dt_vectors():
    T = d4.ref("display-text-v2")
    vs = []

    def context(counts, commitment):
        return {"optionCounts": [str(m) for m in counts], "displayTextCommitment": commitment.hex()}

    def valid(id_, t, desc, counts, rule=None, commitment=None):
        e = enc_display_text_v2(t)
        c = commit(t) if commitment is None else commitment
        assert display_text_rule(t, counts, c) == rule, (id_, display_text_rule(t, counts, c), rule)
        v = {"id": id_, "description": desc, "type": T, "pinned": 2, "value": dt_json(t), "encoding": e.hex()}
        v["commitment"] = commit(t).hex()
        v["definition"] = context(counts, c)
        if rule is not None:
            v["illFormed"] = rule
        vs.append(v)

    def invalid(id_, enc, err, desc, pinned=2):
        vs.append({"id": id_, "description": desc, "type": T, "pinned": pinned, "encoding": enc.hex(), "error": err})

    valid("display-text-v2-two-questions", DT, "English and Latin American Spanish, two questions of three and two options, Yes and No in both, multibyte text", DT_COUNTS)
    minimal = {"salt": bytes(32), "translations": [{"language": "en", "title": "T", "description": "", "questions": [{"question": "Q", "description": "", "options": [opt("A"), opt("B")]}]}]}
    valid("display-text-v2-minimal", minimal, "One language, one question of two options, every optional text empty", [2])
    long_fields = {
        "salt": b"\xff" * 32,
        "translations": [
            {
                "language": "a" * 35,
                "title": "t" * 1024,
                "description": "d" * 8192,
                "questions": [{"question": "q" * 1024, "description": "e" * 8192, "options": [opt("x" * 512, "y" * 1024), opt("z" * 512)]}],
            }
        ],
    }
    valid("display-text-v2-every-length-at-max", long_fields, "Tag, title, description, question, question description, label and option description each at its maximum length", [2])
    many_q = {"salt": bytes(32), "translations": [dict(EN, questions=[{"question": f"Q{i}", "description": "", "options": [opt("Yes"), opt("No")]} for i in range(MAX_QUESTIONS)])]}
    valid("display-text-v2-32-questions", many_q, "32 questions of Yes and No, the most a record lists", [2] * MAX_QUESTIONS)
    many_o = {"salt": bytes(32), "translations": [dict(EN, questions=[{"question": "Q", "description": "", "options": [opt(f"o{i}") for i in range(MAX_OPTIONS)]}])]}
    valid("display-text-v2-64-options", many_o, "One question of 64 options, the most a question lists", [MAX_OPTIONS])
    many_l = {"salt": bytes(32), "translations": [dict(one_question(EN, 1), language=f"x{i:02d}") for i in range(32)]}
    valid("display-text-v2-32-translations", many_l, "32 translations, the most a record lists", [2])

    e = enc_display_text_v2(DT)
    hdr = u16(9) + u8(2) + DT["salt"] + u32(1) + utf8("en", 35)
    invalid("display-text-v2-truncated", e[:-1], "truncated", "The last byte is missing")
    invalid("display-text-v2-trailing", e + b"\x00", "trailing-bytes", "One byte after the last field")
    invalid("display-text-v2-title-over-max", hdr + u32(1025) + b"t" * 1025, "length-over-max", "A title of 1025 bytes, over its maximum of 1024")
    invalid("display-text-v2-description-over-max", hdr + utf8("t", 1024) + u32(8193) + b"d" * 8193, "length-over-max", "A translation description of 8193 bytes, over its maximum of 8192")
    tq = hdr + utf8("t", 1024) + utf8("", 8192)
    invalid("display-text-v2-questions-over-max", tq + u32(MAX_QUESTIONS + 1), "length-over-max", "33 questions, over the maximum of 32, rejected before any is read")
    invalid("display-text-v2-question-over-max", tq + u32(1) + u32(1025) + b"q" * 1025, "length-over-max", "A question of 1025 bytes, over its maximum of 1024")
    invalid(
        "display-text-v2-question-description-over-max",
        tq + u32(1) + utf8("q", 1024) + u32(8193) + b"e" * 8193,
        "length-over-max",
        "A question description of 8193 bytes, over its maximum of 8192",
    )
    invalid("display-text-v2-options-over-max", tq + u32(1) + utf8("q", 1024) + utf8("", 8192) + u32(MAX_OPTIONS + 1), "length-over-max", "65 options in one question, over the maximum of 64")
    invalid(
        "display-text-v2-question-invalid-utf8",
        tq + u32(1) + utf8(b"\xc3\x28", 1024) + utf8("", 8192) + u32(0),
        "invalid-utf8",
        "A question of 0xc3 0x28, an ill-formed UTF-8 sequence",
    )
    invalid("display-text-v2-version-three", u16(9) + u8(3) + e[3:], "profile-mismatch", "Version 3 against a pin of 2: the pin is checked before the version is looked up")
    v1 = dv.enc_display_text(dv.DT)
    invalid("display-text-v1-against-two", v1, "profile-mismatch", "A version-1 record where the election's profile pins version 2")
    invalid("display-text-v2-against-one", e, "profile-mismatch", "A version-2 record where the election's profile pins version 1", pinned=1)

    def ill(rule, id_, t, desc, counts=DT_COUNTS):
        valid(id_, t, desc, counts, rule, commit(DT) if rule == "commitment" else None)

    S = DT["salt"]
    en0, en1 = EN["questions"]
    ill("commitment", "display-text-v2-wrong-salt", dict(DT, salt=dv.seq(32, 0x02)), "The definition's commitment is for a different salt")
    ill("translations", "display-text-v2-no-translations", {"salt": S, "translations": []}, "No translations")
    ill("translations", "display-text-v2-unsorted", {"salt": S, "translations": [ES, EN]}, "es-419 before en")
    ill("language-tag", "display-text-v2-language-uppercase", {"salt": S, "translations": [dict(EN, language="EN")]}, "An uppercase tag")
    ill("question-count", "display-text-v2-one-question-of-two", {"salt": S, "translations": [one_question(EN)]}, "One question where the definition has two")
    ill("question-count", "display-text-v2-no-questions", {"salt": S, "translations": [dict(EN, questions=[])]}, "No questions")
    ill("question-count", "display-text-v2-one-translation-short", {"salt": S, "translations": [EN, one_question(ES)]}, "The second translation has one question of two")
    ill("option-count", "display-text-v2-second-question-three-options", {"salt": S, "translations": [dict(EN, questions=[en0, dict(en1, options=en0["options"])])]}, "The second question has three options where the definition has two")
    ill("option-count", "display-text-v2-questions-swapped", {"salt": S, "translations": [dict(EN, questions=[en1, en0])]}, "The two questions in the other order: 2 and 3 options against the definition's 3 and 2")
    ill("question", "display-text-v2-title-empty", {"salt": S, "translations": [dict(EN, title="")]}, "An empty title")
    ill("question", "display-text-v2-question-empty", {"salt": S, "translations": [dict(EN, questions=[en0, dict(en1, question="")])]}, "An empty second question")
    ill("question", "display-text-v2-label-empty", {"salt": S, "translations": [dict(EN, questions=[en0, dict(en1, options=[opt("Yes"), opt("", "x")])])]}, "An empty option label")
    ill("labels", "display-text-v2-labels-repeated", {"salt": S, "translations": [dict(EN, questions=[en0, dict(en1, options=[opt("Yes"), opt("Yes")])])]}, "Both options of the second question labelled Yes")
    ill("question-texts", "display-text-v2-question-repeated", {"salt": S, "translations": [dict(EN, questions=[en0, dict(en1, question=en0["question"])])]}, "Two questions with the same text")
    ill(
        "option-count",
        "display-text-v2-count-and-labels-broken",
        {"salt": S, "translations": [dict(EN, questions=[dict(en0, options=[opt("Yes"), opt("Yes"), opt("No"), opt("Abstain")]), en1])]},
        "Four options of which two are both Yes, where the definition has three: option-count comes first",
    )
    ill(
        "question",
        "display-text-v2-empty-and-repeated",
        {"salt": S, "translations": [dict(EN, title="", questions=[en0, dict(en1, question=en0["question"])])]},
        "An empty title and a repeated question: question comes first",
    )
    return vs


def main():
    out_dir = pathlib.Path(sys.argv[1])
    gen = (
        "Printed by packages/crypto/scripts/definition-v5-vectors.py, written from {spec} with only the Python standard "
        "library, independently of packages/crypto, reusing definition-v4-vectors.py's version-4 values and rules and the "
        "primitive encoders of definition-vectors.py. {extra}Its own implementation of the rules confirms every valid "
        "vector's illFormed label (or its absence); decode errors are labelled by hand."
    )
    files = {
        "election-definition-v5.json": {
            "format": "abolish-vectors/1",
            "title": "Election definition, version 5 (questions)",
            "spec": "docs/spec/election-definition.md",
            "generator": gen.format(
                spec="docs/spec/election-definition.md (Layout (version 5), Well-formedness)",
                extra="Its encoder is checked against version 4's: a one-question definition is version 4's bytes with the question's fields moved into a one-entry list. ",
            ),
            "types": DEF_TYPES,
            "vectors": def_vectors(),
        },
        "display-text-v2.json": {
            "format": "abolish-vectors/1",
            "title": "Display text, version 2 (questions)",
            "spec": "docs/spec/display-text.md",
            "generator": gen.format(spec="docs/spec/display-text.md (Layout (version 2))", extra=""),
            "maxDisplayText": str(MAX_DISPLAY_TEXT),
            "types": DT_TYPES,
            "vectors": dt_vectors(),
        },
    }
    for name, content in files.items():
        (out_dir / name).write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


QUESTION_TEXT = {
    "kind": "struct",
    "fields": [
        {"name": "question", "type": {"kind": "utf8", "max": 1024}},
        {"name": "description", "type": {"kind": "utf8", "max": 8192}},
        {"name": "options", "type": {"kind": "list", "max": MAX_OPTIONS, "of": d4.ref("option-text")}},
    ],
}
DT_TYPES = {
    "option-text": dv.DT_TYPES["option-text"],
    "question-text": QUESTION_TEXT,
    "translation-v2": {
        "kind": "struct",
        "fields": [
            {"name": "language", "type": {"kind": "utf8", "max": 35}},
            {"name": "title", "type": {"kind": "utf8", "max": 1024}},
            {"name": "description", "type": {"kind": "utf8", "max": 8192}},
            {"name": "questions", "type": {"kind": "list", "max": MAX_QUESTIONS, "of": d4.ref("question-text")}},
        ],
    },
    "display-text-v2": {
        "kind": "record",
        "recordType": "0009",
        "version": 2,
        "fields": [
            {"name": "salt", "type": {"kind": "bytes", "length": 32}},
            {"name": "translations", "type": {"kind": "list", "max": 32, "of": d4.ref("translation-v2")}},
        ],
    },
}

if __name__ == "__main__":
    main()
