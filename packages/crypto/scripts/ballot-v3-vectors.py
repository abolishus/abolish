#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/ballot-v3.json,
spoiled-opening-v2.json and tally-questions.json.

A second implementation of P2-14's multi-question parts of the spec
(0026-multi-question-ballots): ballot version 3's committed vote, its
statement, ballot and core hashes, the per-option proofs over the flat option
vector and one question range proof per question (docs/spec/ballot-validity.md,
Ballot record (version 3)); the spoiled-ballot opening version 2, which opens
the cores of ballot versions 2 and 3 (docs/spec/challenge.md, Opening
version 2); and the tally's per-question range check (docs/spec/tally.md,
`tally-question-range`). It is written from the spec with Python's integers
and hashlib and shares no code with packages/crypto. It reuses only this
folder's other independent generators: ballot-validity-vectors.py's
ristretto255, Pedersen and disjunctive proof code (over group-vectors.py's
self-checked RFC 9496 implementation), share-encryption-vectors.py's
ML-KEM-768 and ChaCha20-Poly1305 (each checked against published vectors
first) and its ciphertexts, and definition-v5-vectors.py's and
definition-v4-vectors.py's definition encoders and well-formedness rules.

Every random value comes from SHA-512 or SHA-256 over a fixed label, and
each valid vector lists the values it used, so any implementation can
reproduce its bytes exactly. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/ballot-v3-vectors.py <out-dir>,
then `vp check --fix` (the committed files are formatted; their values are
what this prints).
"""

import copy
import hashlib
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)
VECTORS = HERE.parents[3] / "docs" / "spec" / "vectors"


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


se = _load("share_encryption_vectors", "share-encryption-vectors.py")
d5 = _load("definition_v5_vectors", "definition-v5-vectors.py")
d4 = d5.d4
bv = se.bv
grp = se.grp

L = grp.L
R = bv.R
G = grp.BASE
IDENTITY = grp.IDENTITY
Hgen = bv.Hgen
MAX_OPTIONS = 64
MAX_TRUSTEES = 16
MAX_QUESTIONS = 32
MAX_BRANCHES = MAX_OPTIONS + 1
BALLOT = 0x0002
OPENING = 0x0003

STATEMENT_TAG = b"abolish/v1/ballot-statement"
BALLOT_TAG = b"abolish/v1/ballot"
CORE_TAG = b"abolish/v1/ballot-core"
OPTION_TAG = b"abolish/v1/fs/ballot-validity/option"
SUM_TAG = b"abolish/v1/fs/ballot-validity/sum"
QUESTION_SUM_TAG = b"abolish/v1/fs/ballot-validity/question-sum"
DEFINITION_TAG = b"abolish/v1/election-definition"

u8, u16, u32 = bv.u8, bv.u16, bv.u32


def scalar(x):
    return x.to_bytes(32, "little")


def H(m):
    return hashlib.sha256(m).digest()


def ds(tag, m):
    return bytes([len(tag)]) + tag + m


def hexs(b):
    return b.hex()


# --- Elections ------------------------------------------------------------------


def det(label):
    return hashlib.sha256(b"abolish ballot-v3 vectors " + label.encode()).digest()


PANELS = {
    "panel-3": se.trustee_keys("questions-panel-3", 3),
    "panel-4": se.trustee_keys("questions-panel-4", 4),
    "panel-2": se.trustee_keys("questions-panel-2", 2),
    "panel-16": se.trustee_keys("questions-panel-16", 16),
}
# Definition version 5 pins ballot version 3, opening version 2, board-entry
# version 4 and display-text version 2 (verifier.md, 2.3).
PINS_V5 = [(1, 5), (2, 3), (3, 2), (4, 1), (5, 1), (6, 1), (7, 4), (8, 1), (9, 2)]
# Definition version 4 pins ballot version 2 and, now that one exists, the
# opening version that opens its cores.
PINS_V4 = [(1, 4), (2, 2), (3, 2), (4, 1), (5, 1), (6, 1), (7, 4), (8, 1), (9, 1)]


def cells_of(d):
    return sum(len(t["cells"]) for t in d["electorate"])


# The membership key the published Semaphore circuit's verification key
# hashes to (membership-proof.json). The openings' elections name it, so an
# implementation can make its ballot context from them, which refuses a
# definition naming another key; the other elections keep the typical
# definition's placeholder.
MEMBERSHIP_VK_HASH = bytes.fromhex(json.loads((VECTORS / "membership-proof.json").read_text())["verificationKey"]["hash"])


def election_v5(label, questions, k, n, panel, registered, vk_hash=None):
    d = d5.variant(
        d5.TYPICAL,
        profile={"protocol_major": 1, "pins": PINS_V5},
        election_id=det("election " + label),
        questions=[d5.q(*x) for x in questions],
        threshold=k,
        panel_size=n,
        ceremony_transcript_hash=det("transcript " + label),
        **({} if vk_hash is None else {"membership_vk_hash": vk_hash}),
    )
    assert d5.definition_rule(d) is None, (label, d5.definition_rule(d))
    enc = d5.enc_definition_v5(d)
    return finish(label, 5, d, enc, [{"optionCount": m, "min": lo, "max": hi} for m, lo, hi in questions], k, n, panel, registered)


def election_v4(label, election_type, m, lo, hi, k, n, panel, registered, vk_hash=None):
    d = d4.variant(
        d4.TYPICAL,
        profile={"protocol_major": 1, "pins": PINS_V4},
        election_id=det("election " + label),
        election_type=election_type,
        option_count=m,
        min_selections=lo,
        max_selections=hi,
        threshold=k,
        panel_size=n,
        ceremony_transcript_hash=det("transcript " + label),
        **({} if vk_hash is None else {"membership_vk_hash": vk_hash}),
    )
    assert d4.definition_rule(d) is None, (label, d4.definition_rule(d))
    enc = d4.enc_definition_v4(d)
    return finish(label, 4, d, enc, [{"optionCount": m, "min": lo, "max": hi}], k, n, panel, registered)


def finish(label, version, d, enc, questions, k, n, panel, registered):
    keys = PANELS[panel]
    assert len(keys) == n
    offsets, o = [], 0
    for q in questions:
        offsets.append(o)
        o += q["optionCount"]
    return {
        "label": label,
        "definitionVersion": version,
        # The ballot version the profile pins: 3 under definition version 5, 2 under 3 and 4.
        "ballotVersion": 3 if version == 5 else 2,
        "encoding": enc,
        "definitionHash": H(ds(DEFINITION_TAG, enc)),
        "questions": questions,
        "offsets": offsets,
        "optionTotal": o,
        "threshold": k,
        "panelSize": n,
        "cells": cells_of(d),
        "panel": panel,
        "registered": registered,
        "keys": {i + 1: key for i, key in enumerate(keys)},
    }


def election_json(e, panel=True):
    out = {
        "definition": hexs(e["encoding"]),
        "definitionHash": hexs(e["definitionHash"]),
        "definitionVersion": e["definitionVersion"],
        "ballotVersion": e["ballotVersion"],
        "questions": [
            {"optionCount": q["optionCount"], "minSelections": q["min"], "maxSelections": q["max"], "offset": o}
            for q, o in zip(e["questions"], e["offsets"])
        ],
        "optionTotal": e["optionTotal"],
        "threshold": e["threshold"],
        "panelSize": e["panelSize"],
        "cells": e["cells"],
    }
    if panel:
        out.update(panel=e["panel"], registered=e["registered"])
    return out


# --- Ballot version 3 (ballot-validity.md, Ballot record (version 3)) ------------


def enc_sum_proofs(sum_proofs):
    out = u32(len(sum_proofs))
    for branches in sum_proofs:
        out += u32(len(branches)) + b"".join(scalar(b["c"]) + scalar(b["z"]) for b in branches)
    return out


def enc_option_proofs(proofs):
    return u32(len(proofs)) + b"".join(scalar(p["c0"]) + scalar(p["z0"]) + scalar(p["c1"]) + scalar(p["z1"]) for p in proofs)


def enc_committed_vote(vote):
    return bv.enc_vss(vote["vss"]) + bv.enc_share_hashes(vote["shareHashes"]) + enc_option_proofs(vote["optionProofs"]) + enc_sum_proofs(vote["sumProofs"])


def head(ctx, version=3):
    return ctx["definitionHash"] + u16(BALLOT) + u8(version) + u8(ctx["cell"])


def statement_hash(ctx, vss, share_hashes, version=3):
    return H(ds(STATEMENT_TAG, head(ctx, version) + bv.field(ctx["nullifier"]) + bv.enc_vss(vss) + bv.enc_share_hashes(share_hashes)))


def ballot_hash(ctx, vote):
    return H(ds(BALLOT_TAG, head(ctx) + bv.field(ctx["nullifier"]) + enc_committed_vote(vote)))


def core_hash(definition_hash, cell, vss, share_hashes, version):
    return H(ds(CORE_TAG, definition_hash + u16(BALLOT) + u8(version) + u8(cell) + bv.enc_vss(vss) + bv.enc_share_hashes(share_hashes)))


def question_prefix(statement, q, o, m, lo, hi):
    return statement + u16(q) + u16(o) + u16(m) + u16(lo) + u16(hi)


def question_commitment(vss, o, m):
    acc = IDENTITY
    for j in range(o, o + m):
        acc = grp.add(acc, vss[j][0])
    return acc


def check_validity(e, ctx, vote):
    """The checks of Ballot record (version 3) in order: the first failing code, or "ok"."""
    qs, offs, T = e["questions"], e["offsets"], e["optionTotal"]
    k, n = e["threshold"], e["panelSize"]
    vss = vote["vss"]
    if (
        len(vss) != T
        or any(len(row) != k for row in vss)
        or len(vote["shareHashes"]) != n
        or len(vote["optionProofs"]) != T
        or len(vote["sumProofs"]) != len(qs)
        or any(len(b) != q["max"] - q["min"] + 1 for b, q in zip(vote["sumProofs"], qs))
    ):
        return {"code": "validity-shape"}
    st = statement_hash(ctx, vss, vote["shareHashes"])
    for j, p in enumerate(vote["optionProofs"]):
        br = [{"c": p["c0"], "z": p["z0"]}, {"c": p["c1"], "z": p["z1"]}]
        if not bv.verify_or(OPTION_TAG, bv.option_prefix(st, j), vss[j][0], [0, 1], br):
            return {"code": "option-proof", "option": j}
    for i, (q, o, branches) in enumerate(zip(qs, offs, vote["sumProofs"])):
        prefix = question_prefix(st, i, o, q["optionCount"], q["min"], q["max"])
        values = list(range(q["min"], q["max"] + 1))
        if not bv.verify_or(QUESTION_SUM_TAG, prefix, question_commitment(vss, o, q["optionCount"]), values, branches):
            return {"code": "sum-proof", "question": i}
    return "ok"


def make_ballot(label, e, ctx, votes, share_hashes=None, version=3):
    """An honest client's ballot for the flat `votes`; a vote outside the rules is proved as the prover would if it were in them.

    `version` other than 3 proves over that version's statement hash, for the vectors that show it doesn't verify as version 3."""
    assert len(votes) == e["optionTotal"]
    rng = bv.Rng("ballot-v3/" + label)
    k, n = e["threshold"], e["panelSize"]
    polys = []
    for v in votes:
        f = [v % L] + [rng.scalar() for _ in range(k - 1)]
        g = [rng.scalar() for _ in range(k)]
        polys.append({"f": f, "g": g})
    vss = [[bv.pedersen(p["f"][t], p["g"][t]) for t in range(k)] for p in polys]
    shares = [[{"v": bv.evaluate(p["f"], i), "r": bv.evaluate(p["g"], i)} for p in polys] for i in range(1, n + 1)]
    if share_hashes is None:
        share_hashes = [rng.bytes32() for _ in range(n)]
    st = statement_hash(ctx, vss, share_hashes, version)
    option_rand, option_proofs = [], []
    for j, (p, v) in enumerate(zip(polys, votes)):
        w, c, z = rng.scalar(), rng.scalar(), rng.scalar()
        option_rand.append({"w": str(w), "simulated": [{"c": str(c), "z": str(z)}]})
        prove = bv.prove_or if v in (0, 1) else bv.prove_or_unchecked
        br = prove(OPTION_TAG, bv.option_prefix(st, j), vss[j][0], [0, 1], v if v in (0, 1) else 1, p["g"][0], w, [(c, z)])
        option_proofs.append({"c0": br[0]["c"], "z0": br[0]["z"], "c1": br[1]["c"], "z1": br[1]["z"]})
    # The range proofs come after the option proofs, in question order.
    sum_rand, sum_proofs = [], []
    for i, (q, o) in enumerate(zip(e["questions"], e["offsets"])):
        m, lo, hi = q["optionCount"], q["min"], q["max"]
        values = list(range(lo, hi + 1))
        total = sum(votes[o : o + m]) % L
        rho = sum(p["g"][0] for p in polys[o : o + m]) % L
        w = rng.scalar()
        sims = [(rng.scalar(), rng.scalar()) for _ in range(len(values) - 1)]
        sum_rand.append({"w": str(w), "simulated": [{"c": str(c), "z": str(z)} for c, z in sims]})
        prefix = question_prefix(st, i, o, m, lo, hi)
        y = question_commitment(vss, o, m)
        if lo <= total <= hi:
            sum_proofs.append(bv.prove_or(QUESTION_SUM_TAG, prefix, y, values, total - lo, rho, w, sims))
        else:
            # Out of range: the prover's steps as if the count were `hi`.
            sum_proofs.append(bv.prove_or_unchecked(QUESTION_SUM_TAG, prefix, y, values, len(values) - 1, rho, w, sims))
    vote = {"vss": vss, "shareHashes": share_hashes, "optionProofs": option_proofs, "sumProofs": sum_proofs}
    randomness = {
        "polynomials": [{"f": [str(x) for x in p["f"]], "g": [str(x) for x in p["g"]]} for p in polys],
        "options": option_rand,
        "questions": sum_rand,
    }
    return vote, randomness, shares, polys


def context(e, label, cell):
    rng = bv.Rng("ballot-v3/context/" + label)
    return {"definitionHash": e["definitionHash"], "cell": cell, "nullifier": int.from_bytes(rng.bytes32(), "big") % R}


def ctx_json(ctx):
    return {"definitionHash": hexs(ctx["definitionHash"]), "cell": ctx["cell"], "nullifier": str(ctx["nullifier"])}


def flat(answers):
    """Per-question lists of selected option indices as the flat 0/1 vector over `sizes`."""
    out = []
    for m, picked in answers:
        out += [1 if j in picked else 0 for j in range(m)]
    return out


def ballot_vectors(elections):
    four = elections["owners-four"]
    one = elections["one-question"]
    widest = elections["questions-max"]
    ranged = elections["range-max"]
    many = elections["trustees-max"]
    sizes4 = [q["optionCount"] for q in four["questions"]]

    def answers(sizes, *picked):
        return flat(zip(sizes, picked))

    valid_specs = [
        ("owners-four", "The owner's four methods (pick one of 3, pick any of 5, pick up to 2 of 4, pick exactly 3 of 6); T = 18, k = 2, n = 3, cell 0", four, 0, answers(sizes4, {1}, {0, 2, 4}, {3}, {0, 1, 5})),
        ("owners-four-blanks", "Every question at its least: blank where the minimum is 0, three where it is exactly 3; cell 3", four, 3, answers(sizes4, set(), set(), set(), {2, 3, 4})),
        ("owners-four-most", "Every question at its most: one, all five, two, three", four, 1, answers(sizes4, {2}, {0, 1, 2, 3, 4}, {0, 3}, {3, 4, 5})),
        ("one-question", "One question, pick one or two of 4 (min 1): version 1's construction with the question's position in each challenge; k = 3, n = 4", one, 2, answers([4], {0, 3})),
        ("questions-max", "MAX_QUESTIONS: 32 yes-or-no questions of 2 options each, T = MAX_OPTIONS = 64, k = n = 2", widest, 0, flat([(2, {i % 2} if i % 3 else set()) for i in range(32)])),
        ("range-max", "One question of MAX_OPTIONS options, pick any: 65 range branches", ranged, 0, [1 if j % 5 == 0 else 0 for j in range(64)]),
        ("trustees-max", "MAX_TRUSTEES: k = n = 16, two questions (pick one of 2, exactly one of 3)", many, 0, answers([2, 3], set(), {1})),
    ]
    ballots = []
    made = {}
    for id_, desc, e, cell, votes in valid_specs:
        ctx = context(e, id_, cell)
        vote, randomness, shares, polys = make_ballot(id_, e, ctx, votes)
        assert check_validity(e, ctx, vote) == "ok", id_
        for i, s in enumerate(shares, start=1):
            assert bv.check_shares(vote["vss"], i, s)
        made[id_] = (e, ctx, vote, polys)
        ballots.append(
            {
                "id": id_,
                "description": desc,
                "election": e["label"],
                "context": ctx_json(ctx),
                "votes": votes,
                "randomness": randomness,
                "shareHashes": [hexs(h) for h in vote["shareHashes"]],
                "statementHash": hexs(statement_hash(ctx, vote["vss"], vote["shareHashes"])),
                "ballotHash": hexs(ballot_hash(ctx, vote)),
                "coreHash": hexs(core_hash(ctx["definitionHash"], cell, vote["vss"], vote["shareHashes"], 3)),
                "encoding": hexs(enc_committed_vote(vote)),
                "result": "ok",
                "shares": [hexs(se.bv.enc_shares(s)) for s in shares],
            }
        )

    def invalid(id_, desc, e, ctx, vote, expect):
        got = check_validity(e, ctx, vote)
        assert got == expect, (id_, got, expect)
        ballots.append({"id": id_, "description": desc, "election": e["label"], "context": ctx_json(ctx), "encoding": hexs(enc_committed_vote(vote)), "result": expect})

    _, f_ctx, f_vote, _ = made["owners-four"]

    def with_(vote, **kw):
        v = copy.deepcopy(vote)
        v.update(kw)
        return v

    # validity-shape: one entry per question, each with its own branch count.
    invalid("shape-question-missing", "sum_proofs without the last question's proof", four, f_ctx, with_(f_vote, sumProofs=f_vote["sumProofs"][:-1]), {"code": "validity-shape"})
    invalid("shape-question-extra", "sum_proofs with a fifth entry for four questions", four, f_ctx, with_(f_vote, sumProofs=f_vote["sumProofs"] + [f_vote["sumProofs"][0]]), {"code": "validity-shape"})
    sp = copy.deepcopy(f_vote["sumProofs"])
    sp[3] = sp[3] + [{"c": 0, "z": 0}]
    invalid("shape-question-branches", "Question 3 (exactly 3, one branch) with a second branch", four, f_ctx, with_(f_vote, sumProofs=sp), {"code": "validity-shape"})
    sp = copy.deepcopy(f_vote["sumProofs"])
    sp[1], sp[2] = sp[2], sp[1]
    invalid("shape-questions-swapped", "Questions 1 (6 branches) and 2 (3 branches) swapped: each entry's length is its question's", four, f_ctx, with_(f_vote, sumProofs=sp), {"code": "validity-shape"})
    invalid("shape-options-short", "vss with T − 1 options", four, f_ctx, with_(f_vote, vss=f_vote["vss"][:-1]), {"code": "validity-shape"})
    invalid("shape-option-proofs-short", "option_proofs with T − 1 entries", four, f_ctx, with_(f_vote, optionProofs=f_vote["optionProofs"][:-1]), {"code": "validity-shape"})
    invalid("shape-share-hashes", "share_hashes with n − 1 entries", four, f_ctx, with_(f_vote, shareHashes=f_vote["shareHashes"][:-1]), {"code": "validity-shape"})

    # option-proof: flat indices and the version-3 statement.
    op = copy.deepcopy(f_vote["optionProofs"])
    op[2], op[3] = op[3], op[2]
    invalid("option-proofs-across-questions", "Option proofs 2 (question 0's last) and 3 (question 1's first) swapped: each binds its flat index", four, f_ctx, with_(f_vote, optionProofs=op), {"code": "option-proof", "option": 2})
    for id_, desc, key, value in (
        ("copy-other-nullifier", "A valid ballot under another nullifier (T-32)", "nullifier", (f_ctx["nullifier"] + 1) % R),
        ("copy-other-cell", "A valid ballot under another cell", "cell", 1),
        ("copy-other-election", "A valid ballot under another election's definition hash (T-30)", "definitionHash", one["definitionHash"]),
    ):
        c = dict(f_ctx)
        c[key] = value
        invalid(id_, desc, four, c, f_vote, {"code": "option-proof", "option": 0})

    # The owner's-four ballot proved over version 2's statement hash (version
    # input 2), checked as version 3: no proof of one version verifies under
    # the other (T-31).
    v2, _, _, _ = make_ballot("owners-four", four, f_ctx, ballots[0]["votes"], version=2)
    assert bv.enc_vss(v2["vss"]) == bv.enc_vss(f_vote["vss"])
    invalid("statement-version-2", "The owner's-four ballot with its proofs made over version 2's statement hash: version 3's differs", four, f_ctx, v2, {"code": "option-proof", "option": 0})

    # sum-proof: per question, with its position and range in the challenge.
    def dishonest(label, votes, cell=0):
        ctx = dict(f_ctx, cell=cell) if cell else f_ctx
        vote, _, _, _ = make_ballot(label, four, ctx, votes)
        return ctx, vote

    ctx, vote = dishonest("over-vote-q0", answers(sizes4, {0, 1}, {0}, {3}, {0, 1, 5}))
    invalid("over-vote-question-0", "Two options of question 0 (pick one), each option proof valid (T-28)", four, ctx, vote, {"code": "sum-proof", "question": 0})
    ctx, vote = dishonest("over-limit-q2", answers(sizes4, {1}, {0}, {0, 1, 2}, {0, 1, 5}))
    invalid("over-limit-question-2", "Three options of question 2 (pick up to 2); questions 0 and 1 valid", four, ctx, vote, {"code": "sum-proof", "question": 2})
    ctx, vote = dishonest("under-exact-q3", answers(sizes4, {1}, {0}, {3}, {0, 1}))
    invalid("under-exactly-question-3", "Two options of question 3 (pick exactly 3): no blank, and no fewer", four, ctx, vote, {"code": "sum-proof", "question": 3})
    ctx, vote = dishonest("blank-exact-q3", answers(sizes4, set(), set(), set(), set()))
    invalid("blank-exactly-question-3", "Question 3 (pick exactly 3) left blank", four, ctx, vote, {"code": "sum-proof", "question": 3})
    ctx, vote = dishonest("over-exact-q3", answers(sizes4, {1}, {0}, {3}, {0, 1, 2, 5}))
    invalid("over-exactly-question-3", "Four options of question 3 (pick exactly 3)", four, ctx, vote, {"code": "sum-proof", "question": 3})
    ctx, vote = dishonest("two-questions", answers(sizes4, {0, 2}, {0}, {0, 1, 2}, {0, 1, 5}))
    invalid("two-questions-over", "Questions 0 and 2 both over their limits: the first is reported", four, ctx, vote, {"code": "sum-proof", "question": 0})

    # Moving one count between questions: the totals over all options would
    # pass a single sum proof (0 to T), but each question's range binds.
    ctx, vote = dishonest("moved-count", answers(sizes4, {0, 1}, {0}, set(), {0, 1, 5}))
    invalid("count-moved-between-questions", "Question 0 over by one and question 2 one fewer than the honest ballot's: the count over all options is unchanged, and each question is checked on its own", four, ctx, vote, {"code": "sum-proof", "question": 0})

    sp = copy.deepcopy(f_vote["sumProofs"])
    sp[0][1] = {"c": (sp[0][1]["c"] + 1) % L, "z": sp[0][1]["z"]}
    invalid("question-challenges-dont-sum", "Question 0's branch challenges don't sum to its challenge", four, f_ctx, with_(f_vote, sumProofs=sp), {"code": "sum-proof", "question": 0})
    sp = copy.deepcopy(f_vote["sumProofs"])
    sp[2][1] = {"c": sp[2][1]["c"], "z": (sp[2][1]["z"] + 1) % L}
    invalid("question-response-altered", "Question 2's second response altered", four, f_ctx, with_(f_vote, sumProofs=sp), {"code": "sum-proof", "question": 2})

    # A range proof moved to another question with the same range and option
    # count: the challenge binds q and o_q, so it fails.
    two_same = elections["same-shape"]
    s_ctx = context(two_same, "same-shape", 0)
    s_vote, s_rand, _, _ = make_ballot("same-shape", two_same, s_ctx, flat([(3, {0}), (3, {0})]))
    assert check_validity(two_same, s_ctx, s_vote) == "ok"
    made["same-shape"] = (two_same, s_ctx, s_vote, None)
    ballots.append(
        {
            "id": "same-shape",
            "description": "Two questions with the same shape (pick one of 3), the same answer in each",
            "election": two_same["label"],
            "context": ctx_json(s_ctx),
            "votes": flat([(3, {0}), (3, {0})]),
            "randomness": s_rand,
            "shareHashes": [hexs(h) for h in s_vote["shareHashes"]],
            "statementHash": hexs(statement_hash(s_ctx, s_vote["vss"], s_vote["shareHashes"])),
            "ballotHash": hexs(ballot_hash(s_ctx, s_vote)),
            "coreHash": hexs(core_hash(s_ctx["definitionHash"], 0, s_vote["vss"], s_vote["shareHashes"], 3)),
            "encoding": hexs(enc_committed_vote(s_vote)),
            "result": "ok",
        }
    )
    sp = copy.deepcopy(s_vote["sumProofs"])
    sp[0], sp[1] = sp[1], sp[0]
    invalid("question-proofs-swapped-same-shape", "The two same-shaped questions' range proofs swapped: each question's Y_q differs, and the valid ballots pin t's layout, its question number and offset included", two_same, s_ctx, with_(s_vote, sumProofs=sp), {"code": "sum-proof", "question": 0})

    # A proof under version 1's sum tag in place of the question-sum tag.
    o_e, o_ctx, o_vote, o_polys = made["one-question"]
    st = statement_hash(o_ctx, o_vote["vss"], o_vote["shareHashes"])
    q = o_e["questions"][0]
    rng = bv.Rng("ballot-v3/sum-tag")
    w = rng.scalar()
    sims = [(rng.scalar(), rng.scalar())]
    rho = sum(p["g"][0] for p in o_polys) % L
    y = question_commitment(o_vote["vss"], 0, q["optionCount"])
    old = bv.prove_or(SUM_TAG, bv.sum_prefix(st, q["min"], q["max"]), y, [1, 2], 1, rho, w, sims)
    invalid("version-1-sum-proof", "The one question's range proof made as version 1's sum proof (its tag and t): the question-sum tag and the position inputs differ", o_e, o_ctx, with_(o_vote, sumProofs=[old]), {"code": "sum-proof", "question": 0})

    # Decoding of the version-3 committed vote.
    enc = enc_committed_vote(f_vote)
    hs_at = 4 + sum(4 + 32 * len(row) for row in f_vote["vss"])
    op_at = hs_at + 4 + 32 * len(f_vote["shareHashes"])
    sp_at = op_at + 4 + 128 * len(f_vote["optionProofs"])
    assert enc[sp_at : sp_at + 4] == u32(4) and enc[sp_at + 4 : sp_at + 8] == u32(2)
    decode = []

    def rej(id_, desc, b, err, offset):
        decode.append({"id": id_, "description": desc, "encoding": hexs(b), "error": err, "offset": offset})

    rej("sum-proofs-over-max", "sum_proofs with 33 entries, over MAX_QUESTIONS", enc[:sp_at] + u32(33) + enc[sp_at + 4 :], "length-over-max", sp_at)
    rej("question-branches-over-max", "Question 0's proof with 66 branches, over MAX_OPTIONS + 1", enc[: sp_at + 4] + u32(66) + enc[sp_at + 8 :], "length-over-max", sp_at + 4)
    rej("question-scalar-l", "Question 0's first c equal to ℓ", enc[: sp_at + 8] + scalar(L) + enc[sp_at + 40 :], "non-canonical", sp_at + 8)
    rej("question-scalar-max", "Question 3's z equal to 2²⁵⁶ − 1", enc[:-32] + b"\xff" * 32, "non-canonical", len(enc) - 32)
    rej("vss-identity", "The first VSS commitment is the identity", enc[:8] + bytes(32) + enc[40:], "non-canonical", 8)
    rej("truncated", "The last byte missing", enc[:-1], "truncated", len(enc) - 32)
    rej("trailing", "One byte after the last field", enc + b"\x00", "trailing-bytes", len(enc))

    return ballots, decode


# --- Opening version 2 (challenge.md, Opening version 2) -----------------------


def enc_opening(o, version=2):
    out = u16(OPENING) + u8(version) + o["definitionHash"] + u8(o["cell"])
    out += bv.enc_vss(o["vss"]) + bv.enc_share_hashes(o["shareHashes"])
    out += u32(len(o["polynomials"]))
    for p in o["polynomials"]:
        out += u32(len(p["f"])) + b"".join(scalar(c) for c in p["f"])
        out += u32(len(p["g"])) + b"".join(scalar(c) for c in p["g"])
    out += u32(len(o["seats"]))
    for s in o["seats"]:
        out += u8(s["seat"]) + s["m"] + scalar(s["e"]) + scalar(s["w"])
    return out


def outside_question(e, votes):
    """The first question no valid ballot could answer with these votes, or None."""
    for i, (q, o) in enumerate(zip(e["questions"], e["offsets"])):
        part = votes[o : o + q["optionCount"]]
        if any(v not in (0, 1) for v in part) or not q["min"] <= sum(part) <= q["max"]:
            return i
    return None


def check_opening(e, o):
    """The checks in order; ("ok", coreHash, votes, outside) or (code, option, seat)."""
    if o["definitionHash"] != e["definitionHash"]:
        return ("opening-stray", None, None)
    if o["cell"] >= e["cells"]:
        return ("opening-cell", None, None)
    T, k, n, reg = e["optionTotal"], e["threshold"], e["panelSize"], e["registered"]
    if not (
        len(o["vss"]) == T
        and all(len(row) == k for row in o["vss"])
        and len(o["shareHashes"]) == n
        and len(o["polynomials"]) == T
        and all(len(p["f"]) == k and len(p["g"]) == k for p in o["polynomials"])
        and [s["seat"] for s in o["seats"]] == sorted(reg)
    ):
        return ("opening-shape", None, None)
    for seat in range(1, n + 1):
        if seat not in reg and o["shareHashes"][seat - 1] != bytes(32):
            return ("opening-unqualified", None, None)
    for j, (row, p) in enumerate(zip(o["vss"], o["polynomials"])):
        for t in range(k):
            if not grp.equal(bv.pedersen(p["f"][t], p["g"][t]), row[t]):
                return ("opening-vss", j, None)
    for s in o["seats"]:
        i = s["seat"]
        if s["e"] == 0 or s["w"] == 0:
            return ("opening-ciphertext", None, i)
        shares = [{"v": bv.evaluate(p["f"], i), "r": bv.evaluate(p["g"], i)} for p in o["polynomials"]]
        ct, _ = se.encrypt(e["definitionHash"], i, e["keys"][i], o["vss"], bv.enc_shares(shares), s["m"], s["e"], s["w"])
        if se.share_hash(ct) != o["shareHashes"][i - 1]:
            return ("opening-ciphertext", None, i)
    votes = [p["f"][0] for p in o["polynomials"]]
    return ("ok", core_hash(o["definitionHash"], o["cell"], o["vss"], o["shareHashes"], e["ballotVersion"]), votes, outside_question(e, votes))


def make_opening(label, e, cell, votes, cheat=None):
    rng = bv.Rng("opening-v2/" + label)
    k, n = e["threshold"], e["panelSize"]
    polys = []
    for v in votes:
        f = [v % L] + [rng.scalar() for _ in range(k - 1)]
        g = [rng.scalar() for _ in range(k)]
        polys.append({"f": f, "g": g})
    vss = [[bv.pedersen(p["f"][t], p["g"][t]) for t in range(k)] for p in polys]
    assert all(not grp.equal(x, IDENTITY) for row in vss for x in row)
    enc_rand, share_hashes = {}, []
    for seat in range(1, n + 1):
        m, ee, w = rng.bytes32(), se.nonzero_scalar(rng), se.nonzero_scalar(rng)
        enc_rand[seat] = {"m": m, "e": ee, "w": w}
        if seat not in e["registered"]:
            share_hashes.append(bytes(32))
            continue
        shares = [{"v": bv.evaluate(p["f"], seat), "r": bv.evaluate(p["g"], seat)} for p in polys]
        if cheat is not None:
            shares = cheat(seat, shares)
        ct, _ = se.encrypt(e["definitionHash"], seat, e["keys"][seat], vss, bv.enc_shares(shares), m, ee, w)
        share_hashes.append(se.share_hash(ct))
    opening = {
        "definitionHash": e["definitionHash"],
        "cell": cell,
        "vss": vss,
        "shareHashes": share_hashes,
        "polynomials": polys,
        "seats": [{"seat": s, **enc_rand[s]} for s in sorted(e["registered"])],
    }
    randomness = {
        "polynomials": [{"f": [str(x) for x in p["f"]], "g": [str(x) for x in p["g"]]} for p in polys],
        "encapsulation": [{"m": enc_rand[s]["m"].hex(), "e": str(enc_rand[s]["e"]), "w": str(enc_rand[s]["w"])} for s in range(1, n + 1)],
    }
    return opening, randomness


def opening_vectors(elections):
    four = elections["opening-four"]
    regional = elections["opening-regional"]
    sizes4 = [q["optionCount"] for q in four["questions"]]
    openings = []

    def add(id_, desc, e, o, randomness=None, expect="ok", option=None, seat=None, question=None):
        got = check_opening(e, o)
        entry = {"id": id_, "description": desc, "election": e["label"], "encoding": hexs(enc_opening(o))}
        if randomness is not None:
            entry["randomness"] = randomness
        entry["coreHash"] = hexs(core_hash(o["definitionHash"], o["cell"], o["vss"], o["shareHashes"], e["ballotVersion"]))
        if got[0] == "ok":
            assert expect == "ok", (id_, got)
            assert got[1].hex() == entry["coreHash"]
            entry["result"] = "ok"
            entry["votes"] = [str(v) for v in got[2]]
            assert got[3] == question, (id_, got[3], question)
            if got[3] is not None:
                entry["voteOutside"] = {"question": got[3]}
        else:
            assert got[0] == expect, (id_, got, expect)
            entry["result"] = got[0]
            assert got[1] == option and got[2] == seat, (id_, got)
            if option is not None:
                entry["option"] = option
            if seat is not None:
                entry["seat"] = seat
        openings.append(entry)

    honest = {}

    def opening(id_, desc, e, cell, votes, question=None):
        o, r = make_opening(id_, e, cell, votes)
        honest[id_] = o
        add(id_, desc, e, o, r, question=question)

    def answers(*picked):
        return flat(zip(sizes4, picked))

    opening("questions", "Ballot version 3's core: the owner's four methods, T = 18, k = 3, n = 4 with seat 3 outside the registered key set, cell 1", four, 1, answers({0}, {1, 2}, {3}, {0, 2, 4}))
    opening("questions-blank", "Every question at its least, in the last cell", four, 3, answers(set(), set(), set(), {1, 2, 3}))
    opening("regional", "Ballot version 2's core: definition version 4, one plurality question of 3, k = 2, n = 3, cell 2", regional, 2, [0, 0, 1])
    opening("regional-blank", "Ballot version 2's core, a blank vote in cell 0", regional, 0, [0, 0, 0])
    opening("questions-over-vote", "Two options of question 0 (pick one): passes, outside the rules at question 0", four, 0, answers({0, 1}, {1}, {3}, {0, 2, 4}), question=0)
    opening("questions-under-exactly", "Question 3 (pick exactly 3) answered with two: passes, outside at question 3", four, 0, answers({0}, {1}, {3}, {0, 2}), question=3)
    votes = answers({0}, {1}, set(), {0, 2, 4})
    votes[8] = 2
    opening("questions-vote-two", "A vote of 2 at flat option 8 (question 2's option 0) and nothing else there: within question 2's limit of 2 by count, outside since a vote is 0 or 1", four, 0, votes, question=2)
    opening("regional-over-vote", "Ballot version 2's core with two options selected in its pick-one question: outside at question 0", regional, 1, [1, 1, 0], question=0)

    base = honest["questions"]
    reg = honest["regional"]

    def variant(id_, desc, e, src, change, expect, option=None, seat=None):
        o = copy.deepcopy(src)
        change(o)
        add(id_, desc, e, o, expect=expect, option=option, seat=seat)

    def set_(key, value):
        return lambda o: o.__setitem__(key, value)

    variant("stray", "The version-3 core's opening checked against the regional election", regional, base, lambda o: None, "opening-stray")
    variant("cell-past-partition", "Cell 4, the first past the definition's four cells", four, base, set_("cell", 4), "opening-cell")
    variant("cell-255", "Cell 255", four, base, set_("cell", 255), "opening-cell")
    variant("regional-cell-past-partition", "Ballot version 2's core in cell 4", regional, reg, set_("cell", 4), "opening-cell")

    def drop_option(o):
        o["vss"] = o["vss"][:-1]
        o["polynomials"] = o["polynomials"][:-1]

    def first_question_only(o):
        o["vss"] = o["vss"][:3]
        o["polynomials"] = o["polynomials"][:3]

    variant("shape-option-short", "vss and polynomials with T − 1 options", four, base, drop_option, "opening-shape")
    variant("shape-first-question-only", "Only question 0's three options, as if the poll had one question", four, base, first_question_only, "opening-shape")
    variant("shape-polynomial", "Flat option 17's g has k + 1 coefficients", four, base, lambda o: o["polynomials"][17]["g"].append(3), "opening-shape")
    variant("shape-unregistered-seat", "Randomness for seat 3, outside the registered key set", four, base, lambda o: o["seats"].insert(2, {"seat": 3, "m": det("m"), "e": 5, "w": 7}), "opening-shape")
    variant("unqualified", "Seat 3, outside the registered key set, has a share hash other than zero", four, base, lambda o: o["shareHashes"].__setitem__(2, det("chosen")), "opening-unqualified")

    def claim_other(o):
        # Question 1's opening claims option 3 where the core commits to option 2.
        o["polynomials"][3 + 2]["f"][0] = 0
        o["polynomials"][3 + 3]["f"][0] = 1

    variant("vss-other-vote", "The opening claims question 1's option 3 over a core committing to its option 2: flat option 5 fails first", four, base, claim_other, "opening-vss", option=5)
    variant("vss-last-option", "Flat option 17's r plus 1", four, base, lambda o: o["polynomials"][17]["g"].__setitem__(0, (o["polynomials"][17]["g"][0] + 1) % L), "opening-vss", option=17)
    variant("ciphertext-m", "Seat 4's ML-KEM message with a byte flipped", four, base, lambda o: o["seats"][2].__setitem__("m", bytes([o["seats"][2]["m"][0] ^ 1]) + o["seats"][2]["m"][1:]), "opening-ciphertext", seat=4)
    variant("regional-ciphertext-e", "Ballot version 2's core: seat 1's ephemeral plus 1", regional, reg, lambda o: o["seats"][0].__setitem__("e", (o["seats"][0]["e"] + 1) % L), "opening-ciphertext", seat=1)
    variant("order-cell-before-shape", "Cell 4 and a missing option: cell first", four, base, lambda o: (o.__setitem__("cell", 4), drop_option(o)), "opening-cell")
    variant("order-vss-before-ciphertext", "A changed coefficient at flat option 9 and a changed seat ephemeral: vss first", four, base, lambda o: (o["polynomials"][9]["f"].__setitem__(1, 1), o["seats"][0].__setitem__("e", 9)), "opening-vss", option=9)

    # The tracking code names the ballot version: the same core bytes under
    # ballot versions 2 and 3 have different codes, and a cast version-3
    # ballot's core hash is the one its opening would give.
    cross = []
    for id_ in ("questions", "regional"):
        o = honest[id_]
        cross.append(
            {
                "opening": id_,
                "coreHashVersion2": hexs(core_hash(o["definitionHash"], o["cell"], o["vss"], o["shareHashes"], 2)),
                "coreHashVersion3": hexs(core_hash(o["definitionHash"], o["cell"], o["vss"], o["shareHashes"], 3)),
            }
        )
        assert cross[-1]["coreHashVersion2"] != cross[-1]["coreHashVersion3"]

    enc = enc_opening(base)
    first_f = 36 + len(bv.enc_vss(base["vss"])) + len(bv.enc_share_hashes(base["shareHashes"])) + 4 + 4
    assert enc[first_f : first_f + 32] == scalar(base["polynomials"][0]["f"][0])
    decode = [
        {"id": "truncated", "description": "The opening without its last byte", "encoding": hexs(enc[:-1]), "error": "truncated"},
        {"id": "trailing-byte", "description": "A byte after the last seat", "encoding": hexs(enc + b"\x00"), "error": "trailing-bytes", "offset": len(enc)},
        {"id": "coefficient-l", "description": "Flat option 0's v_0 equal to ℓ", "encoding": hexs(enc[:first_f] + scalar(L) + enc[first_f + 32 :]), "error": "non-canonical", "offset": first_f},
        {"id": "vss-identity", "description": "A first VSS commitment that is the identity", "encoding": hexs(enc[:44] + bytes(32) + enc[76:]), "error": "non-canonical", "offset": 44},
        {"id": "version-1", "description": "The same bytes under version 1, which a profile pinning version 2 doesn't read", "encoding": hexs(enc[:2] + b"\x01" + enc[3:]), "error": "profile-mismatch", "offset": 2},
    ]
    decoded_cells = [
        {"id": "cell-255-decodes", "description": "Cell 255 decodes (any u8), and is refused by opening-cell", "encoding": hexs(enc[:35] + b"\xff" + enc[36:]), "cell": 255},
    ]
    return openings, decode, decoded_cells, cross


# --- The tally's per-question range (tally.md, Opening checks) ----------------


def tally_vectors(elections):
    e = elections["tally"]
    k = e["threshold"]
    T = e["optionTotal"]
    sizes = [q["optionCount"] for q in e["questions"]]
    cells = []

    def check(agg_c, opening, counted):
        if len(opening) != T:
            return {"code": "tally-missing"}
        for j, (v, r) in enumerate(opening):
            if not grp.equal(bv.pedersen(v, r), agg_c[j]):
                return {"code": "tally-opening", "option": j}
        for j, (v, _) in enumerate(opening):
            if v > counted:
                return {"code": "tally-range", "option": j}
        for i, (q, o) in enumerate(zip(e["questions"], e["offsets"])):
            total = sum(v for v, _ in opening[o : o + q["optionCount"]])
            if not q["min"] * counted <= total <= q["max"] * counted:
                return {"code": "tally-question-range", "question": i}
        return "ok"

    def cell(id_, desc, votes_list, expect, mutate=None):
        rng = bv.Rng("tally-questions/" + id_)
        ballots = []
        v_sum = [0] * T
        r_sum = [0] * T
        for b, votes in enumerate(votes_list):
            row = []
            for j, v in enumerate(votes):
                f = [v % L] + [rng.scalar() for _ in range(k - 1)]
                g = [rng.scalar() for _ in range(k)]
                row.append([bv.pedersen(f[t], g[t]) for t in range(k)])
                v_sum[j] = (v_sum[j] + v) % L
                r_sum[j] = (r_sum[j] + g[0]) % L
            ballots.append(row)
        agg = [IDENTITY] * T
        for row in ballots:
            for j in range(T):
                agg[j] = grp.add(agg[j], row[j][0])
        opening = list(zip(v_sum, r_sum))
        if mutate is not None:
            opening = mutate(opening)
        got = check(agg, opening, len(votes_list))
        assert got == expect, (id_, got, expect)
        cells.append(
            {
                "id": id_,
                "description": desc,
                "ballots": [hexs(bv.enc_vss(row)) for row in ballots],
                "aggregate": [hexs(grp.encode(x)) for x in agg],
                "opening": [{"v": str(v), "r": str(r)} for v, r in opening],
                "result": expect,
            }
        )

    def a(*picked):
        return flat(zip(sizes, picked))

    cell("honest", "Three ballots within every question's limits", [a({0}, {0, 1}, {2}, {0, 1}), a(set(), {2}, {0, 1}, {1, 2}), a({1}, set(), set(), {0, 2})], "ok")
    cell("empty", "No counted ballots: every count 0, and 0 is within [min · 0, max · 0]", [], "ok")
    cell("exactly-n", "Two ballots, question 3 (pick exactly 2) at exactly 2 · 2", [a(set(), set(), set(), {0, 1}), a({1}, {0}, {0}, {1, 2})], "ok")
    cell("over-question-0", "One ballot selecting both options of question 0 (pick one): each count is at most |S_c| = 1, so tally-range passes, but question 0's total is 2 > 1 · 1", [a({0, 1}, set(), set(), {0, 1})], {"code": "tally-question-range", "question": 0})
    cell("under-question-3", "Two ballots, one answering question 3 (pick exactly 2) with one option: its total is 3 < 2 · 2", [a(set(), set(), set(), {0, 1}), a(set(), set(), set(), {2})], {"code": "tally-question-range", "question": 3})
    two = [0] * T
    two[0] = 2
    cell("range-before-question-range", "A vote of 2 at option 0 in a cell of one: tally-range fails before the question's range is checked", [two], {"code": "tally-range", "option": 0})
    cell("short-opening", "An opening of question 0's options only: tally-missing", [a({0}, set(), set(), {0, 1})], {"code": "tally-missing"}, mutate=lambda op: op[:2])
    return cells


def main():
    grp.self_check()
    se.aead_self_check()
    se.mlkem_self_check(100)
    out = pathlib.Path(sys.argv[1])

    elections = {
        e["label"]: e
        for e in (
            election_v5("owners-four", [(3, 0, 1), (5, 0, 5), (4, 0, 2), (6, 3, 3)], 2, 3, "panel-3", [1, 2, 3]),
            election_v5("one-question", [(4, 1, 2)], 3, 4, "panel-4", [1, 2, 3, 4]),
            election_v5("same-shape", [(3, 0, 1), (3, 0, 1)], 2, 3, "panel-3", [1, 2, 3]),
            election_v5("questions-max", [(2, 0, 1)] * MAX_QUESTIONS, 2, 2, "panel-2", [1, 2]),
            election_v5("range-max", [(64, 0, 64)], 2, 2, "panel-2", [1, 2]),
            election_v5("trustees-max", [(2, 0, 1), (3, 1, 1)], 16, 16, "panel-16", list(range(1, 17))),
            election_v5(
                "opening-four", [(3, 0, 1), (5, 0, 5), (4, 0, 2), (6, 3, 3)], 3, 4, "panel-4", [1, 2, 4], MEMBERSHIP_VK_HASH
            ),
            election_v4("opening-regional", 1, 3, 0, 1, 2, 3, "panel-3", [1, 2, 3], MEMBERSHIP_VK_HASH),
            election_v5("tally", [(2, 0, 1), (3, 0, 3), (3, 0, 2), (3, 2, 2)], 2, 3, "panel-3", [1, 2, 3]),
        )
    }

    ballots, decode = ballot_vectors(elections)
    ballot_elections = ("owners-four", "one-question", "same-shape", "questions-max", "range-max", "trustees-max")
    data = {
        "format": "abolish-ballot-v3-vectors/1",
        "title": "Ballot version 3: the committed vote over a poll's questions, its hashes and validity proofs",
        "spec": "docs/spec/ballot-validity.md",
        "generator": (
            "Printed by packages/crypto/scripts/ballot-v3-vectors.py, an implementation of docs/spec/ballot-validity.md "
            "(Ballot record (version 3)) with Python's integers and hashlib, sharing no code with packages/crypto; it reuses "
            "ballot-validity-vectors.py's ristretto255, Pedersen and disjunctive-proof code and definition-v5-vectors.py's "
            "definitions. Every valid ballot is checked by its verifier and every share by the share check before printing, "
            "and every invalid vector is checked to fail with the code it lists. The randomness is SHA-512 of fixed labels: "
            "test data only."
        ),
        "recordType": "0x0002",
        "version": 3,
        "tags": {
            "statement": STATEMENT_TAG.decode(),
            "ballot": BALLOT_TAG.decode(),
            "core": CORE_TAG.decode(),
            "option": OPTION_TAG.decode(),
            "questionSum": QUESTION_SUM_TAG.decode(),
        },
        "elections": {name: election_json(elections[name], panel=False) for name in ballot_elections},
        "ballots": ballots,
        "decode": decode,
    }
    (out / "ballot-v3.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    openings, o_decode, o_cells, cross = opening_vectors(elections)
    opening_elections = ("opening-four", "opening-regional")
    data = {
        "format": "abolish-spoiled-opening-v2-vectors/1",
        "title": "Spoiled-ballot opening version 2: openings of ballot versions 2 and 3's cores",
        "spec": "docs/spec/challenge.md",
        "generator": (
            "Printed by packages/crypto/scripts/ballot-v3-vectors.py, an implementation of docs/spec/challenge.md (Opening "
            "version 2) with Python's integers and hashlib, reusing share-encryption-vectors.py's self-checked ML-KEM-768 and "
            "ChaCha20-Poly1305, ballot-validity-vectors.py's ristretto255 and the version-4 and version-5 definition generators; "
            "nothing from packages/crypto"
        ),
        "recordType": "0x0003",
        "version": 2,
        "tag": CORE_TAG.decode(),
        "panels": {name: [{"seat": i + 1, **se.key_json(key)} for i, key in enumerate(PANELS[name])] for name in ("panel-3", "panel-4")},
        "elections": {name: election_json(elections[name]) for name in opening_elections},
        "openings": openings,
        "decode": o_decode,
        "decodedCells": o_cells,
        "coreHashVersions": cross,
    }
    (out / "spoiled-opening-v2.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    data = {
        "format": "abolish-tally-questions-vectors/1",
        "title": "The tally's per-question range check over a version-5 definition",
        "spec": "docs/spec/tally.md",
        "generator": (
            "Printed by packages/crypto/scripts/ballot-v3-vectors.py from docs/spec/tally.md (Opening checks), with "
            "ballot-validity-vectors.py's ristretto255 and Pedersen code; nothing from packages/crypto. Each cell's ballots "
            "are their VSS commitments (vss, encoded as the committed vote encodes it), each opening is the sum of the "
            "ballots' votes and randomness, and some cells hold votes no admission check would let through, to exercise "
            "the checks."
        ),
        "election": election_json(elections["tally"], panel=False),
        "cells": tally_vectors(elections),
    }
    (out / "tally-questions.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
