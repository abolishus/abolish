#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/ballot-v4.json.

A second implementation of P2-16's split committed vote
(0027-trustee-panels-and-live-results, Part 1, option A): ballot version 4's
committed vote with a default half and, when the definition has an author
panel, an author half, the vote commitment C_j = E^D_{j,0} · E^A_{j,0}
computed and never carried, the statement, ballot and core hashes binding
both halves, the option and question range proofs over the computed C_j, its
checks, and each panel's share check (docs/spec/ballot-validity.md, Ballot
record (version 4)). It is written from the spec with Python's integers and
hashlib and shares no code with packages/crypto. It reuses only this folder's
other independent generators: ballot-v3-vectors.py's encoders, prefixes and
question products, ballot-validity-vectors.py's ristretto255, Pedersen and
disjunctive proof code (over group-vectors.py's self-checked RFC 9496
implementation), and definition-v6-vectors.py's definitions and their
well-formedness rules.

Every random value comes from SHA-512 or SHA-256 over a fixed label, and
each valid vector lists the values it used, so any implementation can
reproduce its bytes exactly. The values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/ballot-v4-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import copy
import hashlib
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


b3 = _load("ballot_v3_vectors", "ballot-v3-vectors.py")
d6 = _load("definition_v6_vectors", "definition-v6-vectors.py")
bv = b3.bv
grp = b3.grp

L = grp.L
R = bv.R
IDENTITY = grp.IDENTITY
MAX_OPTIONS = 64
MAX_TRUSTEES = 16
BALLOT = 0x0002
VERSION = 4

STATEMENT_TAG = b3.STATEMENT_TAG
BALLOT_TAG = b3.BALLOT_TAG
CORE_TAG = b3.CORE_TAG
OPTION_TAG = b3.OPTION_TAG
QUESTION_SUM_TAG = b3.QUESTION_SUM_TAG
DEFINITION_TAG = b3.DEFINITION_TAG

u8, u16, u32 = bv.u8, bv.u16, bv.u32
H, ds, hexs = b3.H, b3.ds, b3.hexs


def det(label):
    return hashlib.sha256(b"abolish ballot-v4 vectors " + label.encode()).digest()


# --- Elections ------------------------------------------------------------------

# Definition version 6 pins ballot version 4 and opening version 3, with
# version 5's other pins (verifier.md, 2.3).
PINS_V6 = [(1, 6), (2, 4), (3, 3), (4, 1), (5, 1), (6, 1), (7, 4), (8, 1), (9, 2)]


def election(label, questions, k, n, k_a, n_a):
    author = (
        {"author_threshold": k_a, "author_keys": d6.AUTHOR_KEYS[:n_a], "author_transcript_hash": det("author transcript " + label)}
        if n_a
        else dict(d6.NO_AUTHOR)
    )
    d = d6.variant(
        d6.TYPICAL,
        profile={"protocol_major": 1, "pins": PINS_V6},
        election_id=det("election " + label),
        questions=[d6.d5.q(*x) for x in questions],
        threshold=k,
        panel_size=n,
        ceremony_transcript_hash=det("transcript " + label),
        **d6.SEALED_EVERYDAY,
        **author,
    )
    assert d6.definition_rule(d) is None, (label, d6.definition_rule(d))
    enc = d6.enc_definition_v6(d)
    qs = [{"optionCount": m, "min": lo, "max": hi} for m, lo, hi in questions]
    offsets, o = [], 0
    for q in qs:
        offsets.append(o)
        o += q["optionCount"]
    return {
        "label": label,
        "encoding": enc,
        "definitionHash": H(ds(DEFINITION_TAG, enc)),
        "questions": qs,
        "offsets": offsets,
        "optionTotal": o,
        "threshold": k,
        "panelSize": n,
        "authorThreshold": k_a,
        "authorPanelSize": n_a,
        "cells": b3.cells_of(d),
    }


def election_json(e):
    return {
        "definition": hexs(e["encoding"]),
        "definitionHash": hexs(e["definitionHash"]),
        "definitionVersion": 6,
        "ballotVersion": VERSION,
        "questions": [
            {"optionCount": q["optionCount"], "minSelections": q["min"], "maxSelections": q["max"], "offset": o}
            for q, o in zip(e["questions"], e["offsets"])
        ],
        "optionTotal": e["optionTotal"],
        "threshold": e["threshold"],
        "panelSize": e["panelSize"],
        "authorThreshold": e["authorThreshold"],
        "authorPanelSize": e["authorPanelSize"],
        "cells": e["cells"],
    }


# --- Ballot version 4 (ballot-validity.md, Ballot record (version 4)) ------------


def enc_committed_vote(vote):
    """The six fields in the order of Committed vote (version 4)."""
    return (
        bv.enc_vss(vote["vss"])
        + bv.enc_share_hashes(vote["shareHashes"])
        + bv.enc_vss(vote["authorVss"])
        + bv.enc_share_hashes(vote["authorShareHashes"])
        + b3.enc_option_proofs(vote["optionProofs"])
        + b3.enc_sum_proofs(vote["sumProofs"])
    )


def head(ctx, version=VERSION):
    return ctx["definitionHash"] + u16(BALLOT) + u8(version) + u8(ctx["cell"])


def halves(vote):
    return bv.enc_vss(vote["vss"]) + bv.enc_share_hashes(vote["shareHashes"]) + bv.enc_vss(vote["authorVss"]) + bv.enc_share_hashes(vote["authorShareHashes"])


def statement_hash(ctx, vote, version=VERSION):
    return H(ds(STATEMENT_TAG, head(ctx, version) + bv.field(ctx["nullifier"]) + halves(vote)))


def ballot_hash(ctx, vote):
    return H(ds(BALLOT_TAG, head(ctx) + bv.field(ctx["nullifier"]) + enc_committed_vote(vote)))


def core_hash(ctx, vote):
    return H(ds(CORE_TAG, head(ctx) + halves(vote)))


def commitments(vote):
    """C_j = E^D_{j,0} · E^A_{j,0}, E^A_{j,0} the identity without an author half (Committed vote (version 4))."""
    out = []
    for j, row in enumerate(vote["vss"]):
        c = row[0]
        if vote["authorVss"]:
            c = grp.add(c, vote["authorVss"][j][0])
        out.append(c)
    return out


def question_commitment(cs, o, m):
    acc = IDENTITY
    for j in range(o, o + m):
        acc = grp.add(acc, cs[j])
    return acc


def check_validity(e, ctx, vote):
    """Checks (version 4) in order: the first failing code, or "ok"."""
    qs, offs, T = e["questions"], e["offsets"], e["optionTotal"]
    k, n, k_a, n_a = e["threshold"], e["panelSize"], e["authorThreshold"], e["authorPanelSize"]
    vss, avss = vote["vss"], vote["authorVss"]
    author_ok = (
        len(avss) == T and all(len(row) == k_a for row in avss) and len(vote["authorShareHashes"]) == n_a
        if n_a
        else not avss and not vote["authorShareHashes"]
    )
    if (
        len(vss) != T
        or any(len(row) != k for row in vss)
        or len(vote["shareHashes"]) != n
        or not author_ok
        or len(vote["optionProofs"]) != T
        or len(vote["sumProofs"]) != len(qs)
        or any(len(b) != q["max"] - q["min"] + 1 for b, q in zip(vote["sumProofs"], qs))
    ):
        return {"code": "validity-shape"}
    st = statement_hash(ctx, vote)
    cs = commitments(vote)
    for j, p in enumerate(vote["optionProofs"]):
        br = [{"c": p["c0"], "z": p["z0"]}, {"c": p["c1"], "z": p["z1"]}]
        if not bv.verify_or(OPTION_TAG, bv.option_prefix(st, j), cs[j], [0, 1], br):
            return {"code": "option-proof", "option": j}
    for i, (q, o, branches) in enumerate(zip(qs, offs, vote["sumProofs"])):
        prefix = b3.question_prefix(st, i, o, q["optionCount"], q["min"], q["max"])
        values = list(range(q["min"], q["max"] + 1))
        if not bv.verify_or(QUESTION_SUM_TAG, prefix, question_commitment(cs, o, q["optionCount"]), values, branches):
            return {"code": "sum-proof", "question": i}
    return "ok"


def make_ballot(label, e, ctx, votes, zero_r=(), version=VERSION, over_default_half=False):
    """An honest client's ballot for the flat `votes`; a vote outside the rules is proved as the prover would if it were in them.

    `zero_r` lists flat options whose randomness r_j is 0 rather than drawn
    (s_j is still drawn, so both halves are random-looking and C_j is
    g^{v_j}). `version` other than 4 proves over that version input, and
    `over_default_half` over E^D_{j,0} alone as if it were C_j, for the vectors
    that show neither verifies as version 4."""
    assert len(votes) == e["optionTotal"]
    rng = bv.Rng("ballot-v4/" + label)
    k, n, k_a, n_a = e["threshold"], e["panelSize"], e["authorThreshold"], e["authorPanelSize"]
    default, author, rs = [], [], []
    for j, v in enumerate(votes):
        r = 0 if j in zero_r else rng.scalar()
        a, s = (rng.scalar(), rng.scalar()) if n_a else (0, 0)
        f_d = [(v - a) % L] + [rng.scalar() for _ in range(k - 1)]
        g_d = [(r - s) % L] + [rng.scalar() for _ in range(k - 1)]
        default.append({"f": f_d, "g": g_d})
        if n_a:
            author.append({"f": [a] + [rng.scalar() for _ in range(k_a - 1)], "g": [s] + [rng.scalar() for _ in range(k_a - 1)]})
        rs.append(r)
    vss = [[bv.pedersen(p["f"][t], p["g"][t]) for t in range(k)] for p in default]
    avss = [[bv.pedersen(p["f"][t], p["g"][t]) for t in range(k_a)] for p in author]
    shares = [[{"v": bv.evaluate(p["f"], i), "r": bv.evaluate(p["g"], i)} for p in default] for i in range(1, n + 1)]
    author_shares = [[{"v": bv.evaluate(p["f"], i), "r": bv.evaluate(p["g"], i)} for p in author] for i in range(1, n_a + 1)]
    vote = {
        "vss": vss,
        "shareHashes": [rng.bytes32() for _ in range(n)],
        "authorVss": avss,
        "authorShareHashes": [rng.bytes32() for _ in range(n_a)],
    }
    st = statement_hash(ctx, vote, version)
    cs = [row[0] for row in vss] if over_default_half else commitments(vote)
    if over_default_half:
        # The prover's ρ for E^D_{j,0} alone is the default half's r_j − s_j.
        rs = [p["g"][0] for p in default]
    option_rand, option_proofs = [], []
    for j, v in enumerate(votes):
        w, c, z = rng.scalar(), rng.scalar(), rng.scalar()
        option_rand.append({"w": str(w), "simulated": [{"c": str(c), "z": str(z)}]})
        honest = v in (0, 1) and not over_default_half
        prove = bv.prove_or if honest else bv.prove_or_unchecked
        br = prove(OPTION_TAG, bv.option_prefix(st, j), cs[j], [0, 1], v if v in (0, 1) else 1, rs[j], w, [(c, z)])
        option_proofs.append({"c0": br[0]["c"], "z0": br[0]["z"], "c1": br[1]["c"], "z1": br[1]["z"]})
    sum_rand, sum_proofs = [], []
    for i, (q, o) in enumerate(zip(e["questions"], e["offsets"])):
        m, lo, hi = q["optionCount"], q["min"], q["max"]
        values = list(range(lo, hi + 1))
        total = sum(votes[o : o + m]) % L
        rho = sum(rs[o : o + m]) % L
        w = rng.scalar()
        sims = [(rng.scalar(), rng.scalar()) for _ in range(len(values) - 1)]
        sum_rand.append({"w": str(w), "simulated": [{"c": str(c), "z": str(z)} for c, z in sims]})
        prefix = b3.question_prefix(st, i, o, m, lo, hi)
        y = question_commitment(cs, o, m)
        if lo <= total <= hi and not over_default_half:
            sum_proofs.append(bv.prove_or(QUESTION_SUM_TAG, prefix, y, values, total - lo, rho, w, sims))
        else:
            real = total - lo if lo <= total <= hi else len(values) - 1
            sum_proofs.append(bv.prove_or_unchecked(QUESTION_SUM_TAG, prefix, y, values, real, rho, w, sims))
    vote.update(optionProofs=option_proofs, sumProofs=sum_proofs)
    poly = lambda p: {"f": [str(x) for x in p["f"]], "g": [str(x) for x in p["g"]]}  # noqa: E731
    randomness = {
        "polynomials": [poly(p) for p in default],
        "authorPolynomials": [poly(p) for p in author],
        "options": option_rand,
        "questions": sum_rand,
    }
    return vote, randomness, shares, author_shares


def context(e, label, cell):
    rng = bv.Rng("ballot-v4/context/" + label)
    return {"definitionHash": e["definitionHash"], "cell": cell, "nullifier": int.from_bytes(rng.bytes32(), "big") % R}


def ctx_json(ctx):
    return {"definitionHash": hexs(ctx["definitionHash"]), "cell": ctx["cell"], "nullifier": str(ctx["nullifier"])}


def ballot_vectors(elections):
    four = elections["author-four"]
    plain = elections["no-author"]
    k1 = elections["author-k1"]
    widest = elections["options-max"]
    many = elections["trustees-max"]
    sizes4 = [q["optionCount"] for q in four["questions"]]

    def answers(sizes, *picked):
        return b3.flat(zip(sizes, picked))

    valid_specs = [
        ("author-four", "The owner's four methods with an author panel: T = 18, k_D = 2, n_D = 3, k_A = 2, n_A = 3, cell 0", four, 0, answers(sizes4, {1}, {0, 2, 4}, {3}, {0, 1, 5}), ()),
        ("author-four-blanks", "Every question at its least, with an author panel; cell 3", four, 3, answers(sizes4, set(), set(), set(), {2, 3, 4}), ()),
        ("no-author", "No author panel: both author lists empty, C_j = E^D_{j,0}, one question pick one or two of 4, k_D = 3, n_D = 4", plain, 2, answers([4], {0, 3}), ()),
        ("author-k1", "An author panel of k_A = 1, n_A = 2: the author polynomials are constants and each author seat holds the whole author half", k1, 1, answers([3, 2], {2}, {0, 1}), ()),
        ("options-max", "One question of MAX_OPTIONS options, pick any (65 range branches), k_A = 2, n_A = 2", widest, 0, [1 if j % 7 == 0 else 0 for j in range(64)], ()),
        ("trustees-max", "MAX_TRUSTEES in both panels: k_D = n_D = 16 and k_A = n_A = 16, two questions (pick one of 2, exactly one of 3)", many, 0, answers([2, 3], set(), {1}), ()),
        (
            "identity-commitment",
            "Option 0 (a 0) with r_0 = 0, so C_0 = E^D_{0,0} · E^A_{0,0} is the identity, encoded in t as 32 zero bytes; both halves are random-looking and the ballot is valid",
            four,
            0,
            answers(sizes4, {1}, {0, 2, 4}, {3}, {0, 1, 5}),
            (0,),
        ),
    ]
    ballots, made = [], {}

    def valid_json(id_, desc, e, ctx, votes, vote, randomness, shares, author_shares):
        return {
            "id": id_,
            "description": desc,
            "election": e["label"],
            "context": ctx_json(ctx),
            "votes": votes,
            "randomness": randomness,
            "shareHashes": [hexs(h) for h in vote["shareHashes"]],
            "authorShareHashes": [hexs(h) for h in vote["authorShareHashes"]],
            "statementHash": hexs(statement_hash(ctx, vote)),
            "ballotHash": hexs(ballot_hash(ctx, vote)),
            "coreHash": hexs(core_hash(ctx, vote)),
            "encoding": hexs(enc_committed_vote(vote)),
            "result": "ok",
            "shares": [hexs(bv.enc_shares(s)) for s in shares],
            "authorShares": [hexs(bv.enc_shares(s)) for s in author_shares],
        }

    for id_, desc, e, cell, votes, zero_r in valid_specs:
        ctx = context(e, id_, cell)
        vote, randomness, shares, author_shares = make_ballot(id_, e, ctx, votes, zero_r)
        assert check_validity(e, ctx, vote) == "ok", id_
        for i, s in enumerate(shares, start=1):
            assert bv.check_shares(vote["vss"], i, s)
        for i, s in enumerate(author_shares, start=1):
            assert bv.check_shares(vote["authorVss"], i, s)
        # Each half's constant terms add to an opening of C_j (Binding).
        cs = commitments(vote)
        for j, v in enumerate(votes):
            r = sum(int(p["g"][0]) for p in (randomness["polynomials"][j], *randomness["authorPolynomials"][j : j + 1])) % L
            assert grp.equal(cs[j], bv.pedersen(v, r))
        if zero_r:
            assert grp.encode(cs[0]) == bytes(32)
        made[id_] = (e, ctx, vote, shares, author_shares)
        ballots.append(valid_json(id_, desc, e, ctx, votes, vote, randomness, shares, author_shares))

    def invalid(id_, desc, e, ctx, vote, expect):
        got = check_validity(e, ctx, vote)
        assert got == expect, (id_, got, expect)
        ballots.append({"id": id_, "description": desc, "election": e["label"], "context": ctx_json(ctx), "encoding": hexs(enc_committed_vote(vote)), "result": expect})

    def with_(vote, **kw):
        v = copy.deepcopy(vote)
        v.update(kw)
        return v

    _, f_ctx, f_vote, _, _ = made["author-four"]
    _, p_ctx, p_vote, _, _ = made["no-author"]

    # validity-shape: each half against its own panel, and no author half without an author panel.
    shape = {"code": "validity-shape"}
    invalid("shape-author-missing", "An author-panel poll's ballot with both author lists empty", four, f_ctx, with_(f_vote, authorVss=[], authorShareHashes=[]), shape)
    invalid("shape-author-vss-missing", "author_vss empty, author_share_hashes present", four, f_ctx, with_(f_vote, authorVss=[]), shape)
    invalid("shape-author-options-short", "author_vss with T − 1 options", four, f_ctx, with_(f_vote, authorVss=f_vote["authorVss"][:-1]), shape)
    invalid("shape-author-row-short", "Option 5's author commitments one short of k_A", four, f_ctx, with_(f_vote, authorVss=[row if j != 5 else row[:-1] for j, row in enumerate(f_vote["authorVss"])]), shape)
    invalid("shape-author-row-long", "Option 0's author commitments one over k_A (k_D's count): each half has its own panel's threshold", four, f_ctx, with_(f_vote, authorVss=[row + [row[0]] if j == 0 else row for j, row in enumerate(f_vote["authorVss"])]), shape)
    invalid("shape-author-share-hashes", "author_share_hashes with n_A − 1 entries", four, f_ctx, with_(f_vote, authorShareHashes=f_vote["authorShareHashes"][:-1]), shape)
    invalid("shape-author-in-plain-poll", "A poll with no author panel, its ballot carrying an author half (one commitment per option, one share hash)", plain, p_ctx, with_(p_vote, authorVss=[[row[0]] for row in p_vote["vss"]], authorShareHashes=[bytes(32)]), shape)
    invalid("shape-author-hashes-in-plain-poll", "A poll with no author panel, its ballot carrying only author_share_hashes", plain, p_ctx, with_(p_vote, authorShareHashes=[bytes(32)]), shape)
    invalid("shape-author-empty-rows", "A poll with no author panel, its ballot carrying T empty author lists rather than none: the one encoding is count 0", plain, p_ctx, with_(p_vote, authorVss=[[] for _ in p_vote["vss"]]), shape)
    invalid("shape-default-row-short", "Option 0's default commitments one short of k_D", four, f_ctx, with_(f_vote, vss=[row[:-1] if j == 0 else row for j, row in enumerate(f_vote["vss"])]), shape)

    # option-proof: the statement binds both halves and which is which.
    op = {"code": "option-proof", "option": 0}
    swapped = copy.deepcopy(f_vote["authorVss"])
    swapped[0], swapped[1] = swapped[1], swapped[0]
    invalid("author-halves-swapped", "Options 0 and 1's author halves swapped: C_0 and C_1 change, and so does the statement", four, f_ctx, with_(f_vote, authorVss=swapped), op)
    _, _, b_vote, _, _ = made["author-four-blanks"]
    invalid("author-half-spliced", "The author half (author_vss and author_share_hashes) of another ballot in the same election (T-30, T-32)", four, f_ctx, with_(f_vote, authorVss=b_vote["authorVss"], authorShareHashes=b_vote["authorShareHashes"]), op)
    invalid("halves-exchanged", "vss and author_vss exchanged (k_D = k_A): every C_j is unchanged, but the statement names which half is which", four, f_ctx, with_(f_vote, vss=f_vote["authorVss"], authorVss=f_vote["vss"]), op)
    hs = list(f_vote["authorShareHashes"])
    hs[2] = bytes(32)
    invalid("author-share-hash-changed", "Author seat 3's share hash zeroed: the statement binds every seat's hash of both panels", four, f_ctx, with_(f_vote, authorShareHashes=hs), op)
    for id_, desc, key, value in (
        ("copy-other-nullifier", "A valid ballot under another nullifier (T-32)", "nullifier", (f_ctx["nullifier"] + 1) % R),
        ("copy-other-cell", "A valid ballot under another cell", "cell", 1),
        ("copy-other-election", "A valid ballot under another election's definition hash (T-30)", "definitionHash", k1["definitionHash"]),
    ):
        c = dict(f_ctx)
        c[key] = value
        invalid(id_, desc, four, c, f_vote, op)
    votes0 = ballots[0]["votes"]
    v3, _, _, _ = make_ballot("author-four", four, f_ctx, votes0, version=3)
    assert halves(v3) == halves(f_vote)
    invalid("statement-version-3", "The author-four ballot with its proofs made over the same statement with version input 3 (T-31)", four, f_ctx, v3, op)
    dh, _, _, _ = make_ballot("author-four", four, f_ctx, votes0, over_default_half=True)
    assert halves(dh) == halves(f_vote)
    invalid("proved-over-default-half", "The author-four ballot proved over E^D_{j,0} alone, as if it were C_j: the vote commitment is the product of both halves", four, f_ctx, dh, op)
    pv3, _, _, _ = make_ballot("no-author", plain, p_ctx, ballots[2]["votes"], version=3)
    invalid("plain-statement-version-3", "The no-author ballot proved over version input 3: without an author panel C_j is version 3's, but the statement isn't", plain, p_ctx, pv3, op)

    # sum-proof over the products.
    ctx = dict(f_ctx)
    over, _, _, _ = make_ballot("over-vote-q0", four, ctx, answers(sizes4, {0, 1}, {0}, {3}, {0, 1, 5}))
    invalid("over-vote-question-0", "Two options of question 0 (pick one), each option proof valid over its C_j (T-28)", four, ctx, over, {"code": "sum-proof", "question": 0})
    under, _, _, _ = make_ballot("under-exact-q3", four, ctx, answers(sizes4, {1}, {0}, {3}, {0, 1}))
    invalid("under-exactly-question-3", "Two options of question 3 (pick exactly 3)", four, ctx, under, {"code": "sum-proof", "question": 3})
    sp = copy.deepcopy(f_vote["sumProofs"])
    sp[1][2] = {"c": sp[1][2]["c"], "z": (sp[1][2]["z"] + 1) % L}
    invalid("question-response-altered", "Question 1's third response altered", four, f_ctx, with_(f_vote, sumProofs=sp), {"code": "sum-proof", "question": 1})

    # Decoding of the version-4 committed vote.
    enc = enc_committed_vote(f_vote)
    hs_at = 4 + sum(4 + 32 * len(row) for row in f_vote["vss"])
    av_at = hs_at + 4 + 32 * len(f_vote["shareHashes"])
    ah_at = av_at + 4 + sum(4 + 32 * len(row) for row in f_vote["authorVss"])
    op_at = ah_at + 4 + 32 * len(f_vote["authorShareHashes"])
    assert enc[av_at : av_at + 8] == u32(18) + u32(2) and enc[ah_at : ah_at + 4] == u32(3) and enc[op_at : op_at + 4] == u32(18)
    decode = []

    def rej(id_, desc, b, err, offset):
        decode.append({"id": id_, "description": desc, "encoding": hexs(b), "error": err, "offset": offset})

    rej("author-vss-identity", "The first author commitment is the identity", enc[: av_at + 8] + bytes(32) + enc[av_at + 40 :], "non-canonical", av_at + 8)
    rej("author-vss-non-canonical", "The first author commitment's bytes are 2²⁵⁶ − 1, no element's encoding", enc[: av_at + 8] + b"\xff" * 32 + enc[av_at + 40 :], "non-canonical", av_at + 8)
    rej("author-vss-over-max", "author_vss with 65 options, over MAX_OPTIONS", enc[:av_at] + u32(65) + enc[av_at + 4 :], "length-over-max", av_at)
    rej("author-row-over-max", "Option 0's author commitments 17, over MAX_TRUSTEES", enc[: av_at + 4] + u32(17) + enc[av_at + 8 :], "length-over-max", av_at + 4)
    rej("author-share-hashes-over-max", "author_share_hashes with 17 entries, over MAX_TRUSTEES", enc[:ah_at] + u32(17) + enc[ah_at + 4 :], "length-over-max", ah_at)
    rej("truncated", "The last byte missing", enc[:-1], "truncated", len(enc) - 32)
    rej("trailing", "One byte after the last field", enc + b"\x00", "trailing-bytes", len(enc))

    # Each panel's shares checked against the other panel's commitments: a share never crosses panels.
    cross = []
    for id_ in ("author-four", "author-k1"):
        e, _, vote, shares, author_shares = made[id_]
        for i, s in enumerate(shares[: e["authorPanelSize"]], start=1):
            assert bv.check_shares(vote["authorVss"], i, s) is False
            cross.append({"id": f"{id_}-default-{i}-against-author", "ballot": id_, "commitments": "author", "seat": i, "shares": hexs(bv.enc_shares(s)), "result": False})
        for i, s in enumerate(author_shares, start=1):
            assert bv.check_shares(vote["vss"], i, s) is False
            cross.append({"id": f"{id_}-author-{i}-against-default", "ballot": id_, "commitments": "default", "seat": i, "shares": hexs(bv.enc_shares(s)), "result": False})
    return ballots, decode, cross


def main():
    grp.self_check()
    out = pathlib.Path(sys.argv[1])
    four = [(3, 0, 1), (5, 0, 5), (4, 0, 2), (6, 3, 3)]
    elections = {
        e["label"]: e
        for e in (
            election("author-four", four, 2, 3, 2, 3),
            election("no-author", [(4, 1, 2)], 3, 4, 0, 0),
            election("author-k1", [(3, 0, 1), (2, 0, 2)], 2, 3, 1, 2),
            election("options-max", [(64, 0, 64)], 2, 3, 2, 2),
            election("trustees-max", [(2, 0, 1), (3, 1, 1)], 16, 16, 16, 16),
        )
    }
    ballots, decode, shares = ballot_vectors(elections)
    data = {
        "format": "abolish-ballot-v4-vectors/1",
        "title": "Ballot version 4: the committed vote split into a default and an author half, its hashes, validity proofs and share checks",
        "spec": "docs/spec/ballot-validity.md",
        "generator": (
            "Printed by packages/crypto/scripts/ballot-v4-vectors.py, an implementation of docs/spec/ballot-validity.md "
            "(Ballot record (version 4)) with Python's integers and hashlib, sharing no code with packages/crypto; it reuses "
            "ballot-v3-vectors.py's encoders, ballot-validity-vectors.py's ristretto255, Pedersen and disjunctive-proof code "
            "and definition-v6-vectors.py's definitions. Every valid ballot is checked by its verifier, every share of both "
            "panels by the share check and each C_j against the sum of its halves' openings before printing, and every "
            "invalid vector is checked to fail with the code it lists. The randomness is SHA-512 of fixed labels: test data only."
        ),
        "recordType": "0x0002",
        "version": VERSION,
        "tags": {
            "statement": STATEMENT_TAG.decode(),
            "ballot": BALLOT_TAG.decode(),
            "core": CORE_TAG.decode(),
            "option": OPTION_TAG.decode(),
            "questionSum": QUESTION_SUM_TAG.decode(),
        },
        "elections": {name: election_json(e) for name, e in elections.items()},
        "ballots": ballots,
        "decode": decode,
        "crossPanelShares": shares,
    }
    (out / "ballot-v4.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
