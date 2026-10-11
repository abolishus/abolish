#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/ballot-validity.json.

A second implementation of docs/spec/ballot-validity.md: the committed vote's
encoding, Pedersen VSS and the trustees' share check, the statement hash, and
the option and sum proofs (prover and verifier), written from the spec with
Python's integers and hashlib. It shares no code with packages/crypto or
@noble/curves; its only import is group-vectors.py's ristretto255 and
RFC 9380 code, itself written from the RFCs, whose self-check runs first.

Every random value comes from SHA-512 over a fixed label, and each valid
vector lists the values it used, so any implementation can reproduce its
bytes exactly. The values are test data, never keys.

Usage: python3 -I packages/crypto/scripts/ballot-validity-vectors.py <out-dir>
"""

import hashlib
import importlib.util
import json
import pathlib
import sys

_spec = importlib.util.spec_from_file_location(
    "group_vectors", pathlib.Path(__file__).with_name("group-vectors.py")
)
grp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(grp)

L = grp.L
R = 0x30644E72E131A029B85045B68181585D2833E84879B9709143E1F593F0000001
MAX_OPTIONS = 64
MAX_TRUSTEES = 16
BALLOT_RECORD_TYPE = 0x0002
BALLOT_VERSION = 1

STATEMENT_TAG = b"abolish/v1/ballot-statement"
OPTION_TAG = b"abolish/v1/fs/ballot-validity/option"
SUM_TAG = b"abolish/v1/fs/ballot-validity/sum"

G = grp.BASE
IDENTITY = grp.IDENTITY
_, Hgen = grp.hash_to_ristretto255(b"", b"abolish/v1/generator-h")


# --- Primitive encodings (docs/spec/notation.md, group.md) -------------------


def u8(x):
    return x.to_bytes(1, "big")


def u16(x):
    return x.to_bytes(2, "big")


def u32(x):
    return x.to_bytes(4, "big")


def scalar(x):
    assert 0 <= x < L
    return x.to_bytes(32, "little")


def element(p, identity_allowed=False):
    b = grp.encode(p)
    assert identity_allowed or b != bytes(32)
    return b


def field(x):
    assert 0 <= x < R
    return x.to_bytes(32, "big")


def ds(tag, m):
    return u8(len(tag)) + tag + m


def H(m):
    return hashlib.sha256(m).digest()


def pt_mul(k, p):
    return grp.mul(k % L, p)


def pt_sub(p, q):
    return grp.add(p, grp.neg(q))


def pedersen(v, r):
    return grp.add(pt_mul(v, G), pt_mul(r, Hgen))


# --- The committed vote ------------------------------------------------------


def enc_vss(vss):
    out = u32(len(vss))
    for e in vss:
        out += u32(len(e)) + b"".join(element(x) for x in e)
    return out


def enc_share_hashes(hs):
    return u32(len(hs)) + b"".join(hs)


def enc_committed_vote(vote):
    out = enc_vss(vote["vss"]) + enc_share_hashes(vote["shareHashes"])
    out += u32(len(vote["optionProofs"]))
    for p in vote["optionProofs"]:
        out += scalar(p["c0"]) + scalar(p["z0"]) + scalar(p["c1"]) + scalar(p["z1"])
    out += u32(len(vote["sumProof"]))
    for b in vote["sumProof"]:
        out += scalar(b["c"]) + scalar(b["z"])
    return out


def enc_shares(shares):
    return u32(len(shares)) + b"".join(scalar(s["v"]) + scalar(s["r"]) for s in shares)


def statement_hash(ctx, vss, share_hashes):
    m = (
        ctx["definitionHash"]
        + u16(BALLOT_RECORD_TYPE)
        + u8(BALLOT_VERSION)
        + u8(ctx["tier"])
        + field(ctx["nullifier"])
        + enc_vss(vss)
        + enc_share_hashes(share_hashes)
    )
    return H(ds(STATEMENT_TAG, m))


def hash_to_scalar(t, tag):
    return grp.hash_to_scalar(t, tag)[1]


def shifted(y, s):
    return pt_sub(y, pt_mul(s, G))


def announcement(y, s, c, z):
    return pt_sub(pt_mul(z, Hgen), pt_mul(c, shifted(y, s)))


def or_challenge(tag, prefix, y, a):
    t = prefix + element(y, True) + b"".join(element(x, True) for x in a)
    return hash_to_scalar(t, tag)


def verify_or(tag, prefix, y, values, branches):
    if len(branches) != len(values):
        return False
    a = [announcement(y, s, b["c"], b["z"]) for s, b in zip(values, branches)]
    return sum(b["c"] for b in branches) % L == or_challenge(tag, prefix, y, a)


def prove_or(tag, prefix, y, values, real, rho, w, simulated):
    """docs/spec/ballot-validity.md, Proving. `simulated` lists (c, z) for the false branches in order."""
    assert grp.equal(shifted(y, values[real]), pt_mul(rho, Hgen))
    return prove_or_unchecked(tag, prefix, y, values, real, rho, w, simulated)


def option_prefix(statement, j):
    return statement + u16(j)


def sum_prefix(statement, lo, hi):
    return statement + u16(lo) + u16(hi)


def commitment_sum(vss):
    acc = IDENTITY
    for e in vss:
        acc = grp.add(acc, e[0])
    return acc


def check_validity(ctx, vote):
    """docs/spec/ballot-validity.md, Checks: the first failing code, or "ok"."""
    m, lo, hi, k, n = ctx["optionCount"], ctx["min"], ctx["max"], ctx["threshold"], ctx["panelSize"]
    vss = vote["vss"]
    if (
        len(vss) != m
        or any(len(e) != k for e in vss)
        or len(vote["shareHashes"]) != n
        or len(vote["optionProofs"]) != m
        or len(vote["sumProof"]) != hi - lo + 1
    ):
        return {"code": "validity-shape"}
    st = statement_hash(ctx, vss, vote["shareHashes"])
    for j, p in enumerate(vote["optionProofs"]):
        br = [{"c": p["c0"], "z": p["z0"]}, {"c": p["c1"], "z": p["z1"]}]
        if not verify_or(OPTION_TAG, option_prefix(st, j), vss[j][0], [0, 1], br):
            return {"code": "option-proof", "option": j}
    if not verify_or(SUM_TAG, sum_prefix(st, lo, hi), commitment_sum(vss), list(range(lo, hi + 1)), vote["sumProof"]):
        return {"code": "sum-proof"}
    return "ok"


def check_shares(vss, index, shares):
    """Pedersen VSS share check, as docs/spec/ballot-validity.md (Shares) writes it, power by power."""
    if len(shares) != len(vss):
        return False
    for e, s in zip(vss, shares):
        rhs = IDENTITY
        for t, et in enumerate(e):
            rhs = grp.add(rhs, pt_mul(pow(index, t, L), et))
        if not grp.equal(pedersen(s["v"], s["r"]), rhs):
            return False
    return True


# --- Deterministic test randomness -------------------------------------------


class Rng:
    """Scalars from SHA-512(label ‖ counter), reduced mod ℓ: test data only."""

    def __init__(self, label):
        self.label = label.encode()
        self.i = 0

    def scalar(self):
        self.i += 1
        d = hashlib.sha512(self.label + self.i.to_bytes(4, "big")).digest()
        return int.from_bytes(d, "little") % L

    def bytes32(self):
        self.i += 1
        return hashlib.sha256(self.label + b"/bytes/" + self.i.to_bytes(4, "big")).digest()


def evaluate(coeffs, x):
    acc = 0
    for c in reversed(coeffs):
        acc = (acc * x + c) % L
    return acc


def make_ballot(label, ctx, votes, share_hashes=None, cheat=None):
    """An honest ballot, or a dishonest one where `cheat` says how; returns (vote, randomness, shares)."""
    rng = Rng(label)
    m, k, n = ctx["optionCount"], ctx["threshold"], ctx["panelSize"]
    polys = []
    for v in votes:
        f = [v % L] + [rng.scalar() for _ in range(k - 1)]
        g = [rng.scalar() for _ in range(k)]
        polys.append({"f": f, "g": g})
    vss = [[pedersen(p["f"][t], p["g"][t]) for t in range(k)] for p in polys]
    shares = [[{"v": evaluate(p["f"], i), "r": evaluate(p["g"], i)} for p in polys] for i in range(1, n + 1)]
    if share_hashes is None:
        share_hashes = [rng.bytes32() for _ in range(n)]
    st = statement_hash(ctx, vss, share_hashes)
    rand_opts = []
    option_proofs = []
    for j, (p, v) in enumerate(zip(polys, votes)):
        w, c, z = rng.scalar(), rng.scalar(), rng.scalar()
        rand_opts.append({"w": w, "simulated": [{"c": c, "z": z}]})
        real = v if v in (0, 1) else 1
        rho = p["g"][0]
        if v not in (0, 1):
            # A vote of 2 has no 0-or-1 opening: run the prover as if it were 1.
            br = prove_or_unchecked(OPTION_TAG, option_prefix(st, j), vss[j][0], [0, 1], real, rho, w, [(c, z)])
        else:
            br = prove_or(OPTION_TAG, option_prefix(st, j), vss[j][0], [0, 1], real, rho, w, [(c, z)])
        option_proofs.append({"c0": br[0]["c"], "z0": br[0]["z"], "c1": br[1]["c"], "z1": br[1]["z"]})
    lo, hi = ctx["min"], ctx["max"]
    values = list(range(lo, hi + 1))
    total = sum(votes) % L
    rho = sum(p["g"][0] for p in polys) % L
    w = rng.scalar()
    sims = [(rng.scalar(), rng.scalar()) for _ in range(len(values) - 1)]
    rand_sum = {"w": w, "simulated": [{"c": c, "z": z} for c, z in sims]}
    if lo <= total <= hi:
        sum_proof = prove_or(SUM_TAG, sum_prefix(st, lo, hi), commitment_sum(vss), values, total - lo, rho, w, sims)
    else:
        # Out of range: run the prover as if the sum were `hi`.
        sum_proof = prove_or_unchecked(SUM_TAG, sum_prefix(st, lo, hi), commitment_sum(vss), values, len(values) - 1, rho, w, sims)
    vote = {"vss": vss, "shareHashes": share_hashes, "optionProofs": option_proofs, "sumProof": sum_proof}
    randomness = {
        "polynomials": [{"f": [str(x) for x in p["f"]], "g": [str(x) for x in p["g"]]} for p in polys],
        "options": [{"w": str(r["w"]), "simulated": [{"c": str(s["c"]), "z": str(s["z"])} for s in r["simulated"]]} for r in rand_opts],
        "sum": {"w": str(rand_sum["w"]), "simulated": [{"c": str(s["c"]), "z": str(s["z"])} for s in rand_sum["simulated"]]},
    }
    return vote, randomness, shares


def prove_or_unchecked(tag, prefix, y, values, real, rho, w, simulated):
    """The prover's steps without the opening check, for vectors of dishonest ballots."""
    fake = {}
    it = iter(simulated)
    for b in range(len(values)):
        if b != real:
            fake[b] = next(it)
    a = [pt_mul(w, Hgen) if b == real else announcement(y, values[b], *fake[b]) for b in range(len(values))]
    c = or_challenge(tag, prefix, y, a)
    c_real = (c - sum(fc for fc, _ in fake.values())) % L
    return [
        {"c": c_real, "z": (w + c_real * rho) % L} if b == real else {"c": fake[b][0], "z": fake[b][1]}
        for b in range(len(values))
    ]


# --- Vectors -----------------------------------------------------------------


def ctx_json(ctx):
    return {
        "definitionHash": ctx["definitionHash"].hex(),
        "optionCount": ctx["optionCount"],
        "minSelections": ctx["min"],
        "maxSelections": ctx["max"],
        "threshold": ctx["threshold"],
        "panelSize": ctx["panelSize"],
        "tier": ctx["tier"],
        "nullifier": str(ctx["nullifier"]),
    }


def context(label, m, lo, hi, k, n, tier=0):
    rng = Rng("context/" + label)
    return {
        "definitionHash": rng.bytes32(),
        "optionCount": m,
        "min": lo,
        "max": hi,
        "threshold": k,
        "panelSize": n,
        "tier": tier,
        "nullifier": int.from_bytes(rng.bytes32(), "big") % R,
    }


def main():
    grp.self_check()
    out = sys.argv[1]

    valid_specs = [
        ("plurality-first", "Plurality, 3 options, the first selected; k = 2, n = 3", context("plurality", 3, 0, 1, 2, 3), [1, 0, 0]),
        ("plurality-last", "Plurality, 3 options, the last selected", context("plurality", 3, 0, 1, 2, 3), [0, 0, 1]),
        ("plurality-blank", "Plurality, a blank ballot: every option 0, sum 0", context("plurality", 3, 0, 1, 2, 3), [0, 0, 0]),
        ("approval-two", "Approval, 5 options, limit 3, two selected; k = 3, n = 5, tier 2", context("approval", 5, 0, 3, 3, 5, 2), [1, 0, 1, 0, 0]),
        ("approval-at-limit", "Approval at its limit: three of five selected", context("approval", 5, 0, 3, 3, 5, 2), [0, 1, 1, 1, 0]),
        ("approval-minimum", "Approval with a minimum of 1 and no limit below the option count: one selected", context("approval-min", 4, 1, 4, 2, 2, 1), [0, 0, 0, 1]),
        ("approval-all", "Approval with every option selected", context("approval-min", 4, 1, 4, 2, 2, 1), [1, 1, 1, 1]),
        ("trustees-max", "MAX_TRUSTEES: k = n = 16, 2 options", context("trustees-max", 2, 0, 1, 16, 16), [0, 1]),
        ("options-max", "MAX_OPTIONS: 64 options, approval with no limit, 65 sum branches", context("options-max", 64, 0, 64, 2, 3, 1), [1 if j % 3 == 0 else 0 for j in range(64)]),
    ]

    ballots = []
    made = {}
    for id_, desc, ctx, votes in valid_specs:
        vote, randomness, shares = make_ballot("ballot/" + id_, ctx, votes)
        assert check_validity(ctx, vote) == "ok", id_
        for i, s in enumerate(shares, start=1):
            assert check_shares(vote["vss"], i, s)
        made[id_] = (ctx, vote, shares)
        ballots.append(
            {
                "id": id_,
                "description": desc,
                "context": ctx_json(ctx),
                "votes": votes,
                "randomness": randomness,
                "shareHashes": [h.hex() for h in vote["shareHashes"]],
                "statementHash": statement_hash(ctx, vote["vss"], vote["shareHashes"]).hex(),
                "encoding": enc_committed_vote(vote).hex(),
                "result": "ok",
                "shares": [enc_shares(s).hex() for s in shares],
            }
        )

    def invalid(id_, desc, ctx, vote, expect):
        got = check_validity(ctx, vote)
        assert got == expect, (id_, got, expect)
        ballots.append(
            {
                "id": id_,
                "description": desc,
                "context": ctx_json(ctx),
                "encoding": enc_committed_vote(vote).hex(),
                "result": expect,
            }
        )

    p_ctx, p_vote, _ = made["plurality-first"]
    a_ctx, a_vote, _ = made["approval-two"]

    def with_(vote, **kw):
        v = dict(vote)
        v.update(kw)
        return v

    # validity-shape
    invalid("shape-options-short", "vss has one option fewer than the election", p_ctx, with_(p_vote, vss=p_vote["vss"][:-1]), {"code": "validity-shape"})
    invalid(
        "shape-degree",
        "One option has k + 1 VSS commitments",
        p_ctx,
        with_(p_vote, vss=[p_vote["vss"][0] + [pt_mul(7, G)]] + p_vote["vss"][1:]),
        {"code": "validity-shape"},
    )
    invalid("shape-share-hashes", "share_hashes has n − 1 entries", p_ctx, with_(p_vote, shareHashes=p_vote["shareHashes"][:-1]), {"code": "validity-shape"})
    invalid("shape-option-proofs", "option_proofs has m − 1 entries", p_ctx, with_(p_vote, optionProofs=p_vote["optionProofs"][:-1]), {"code": "validity-shape"})
    invalid("shape-sum-branches", "sum_proof has one branch too many", p_ctx, with_(p_vote, sumProof=p_vote["sumProof"] + [{"c": 0, "z": 0}]), {"code": "validity-shape"})
    wider = dict(p_ctx)
    wider["max"] = 2
    invalid("shape-other-range", "A plurality ballot checked against rules with max_selections 2: the sum proof has the wrong number of branches", wider, p_vote, {"code": "validity-shape"})

    # option-proof: copied or altered proofs
    for id_, desc, key, value in (
        ("copy-other-nullifier", "A valid ballot's commitments and proofs under another nullifier (T-32)", "nullifier", (p_ctx["nullifier"] + 1) % R),
        ("copy-other-election", "A valid ballot under another election's definition hash (T-30)", "definitionHash", H(b"another election")),
        ("copy-other-tier", "A valid ballot under another tier", "tier", 1),
    ):
        c = dict(p_ctx)
        c[key] = value
        invalid(id_, desc, c, p_vote, {"code": "option-proof", "option": 0})
    hs = list(p_vote["shareHashes"])
    hs[1] = H(b"another ciphertext")
    invalid("other-share-hash", "One share ciphertext's hash replaced: every challenge changes (T-30)", p_ctx, with_(p_vote, shareHashes=hs), {"code": "option-proof", "option": 0})
    op = list(p_vote["optionProofs"])
    op[0], op[1] = op[1], op[0]
    invalid("option-proofs-swapped", "Option 0's and option 1's proofs swapped: each binds its position", p_ctx, with_(p_vote, optionProofs=op), {"code": "option-proof", "option": 0})
    op = list(p_vote["optionProofs"])
    op[2] = dict(op[2])
    op[2]["c1"] = (op[2]["c1"] + 1) % L
    invalid("challenges-dont-sum", "Option 2's branch challenges don't sum to its challenge", p_ctx, with_(p_vote, optionProofs=op), {"code": "option-proof", "option": 2})
    op = list(p_vote["optionProofs"])
    op[1] = dict(op[1])
    op[1]["z0"] = (op[1]["z0"] + 1) % L
    invalid("response-altered", "Option 1's response z0 altered", p_ctx, with_(p_vote, optionProofs=op), {"code": "option-proof", "option": 1})
    op = list(p_vote["optionProofs"])
    op[0] = {"c0": op[0]["c1"], "z0": op[0]["z1"], "c1": op[0]["c0"], "z1": op[0]["z0"]}
    invalid("branches-swapped", "Option 0's two branches swapped", p_ctx, with_(p_vote, optionProofs=op), {"code": "option-proof", "option": 0})
    vote2, _, _ = make_ballot("ballot/vote-two", a_ctx, [2, 0, 0, 0, 0])
    invalid("vote-two", "Option 0 commits to 2, proved as if it were 1 (T-28)", a_ctx, vote2, {"code": "option-proof", "option": 0})
    neg, _, _ = make_ballot("ballot/vote-minus-one", a_ctx, [1, L - 1, 1, 0, 0])
    invalid("vote-minus-one", "Option 1 commits to −1 (ℓ − 1), which would cancel option 0 (T-28)", a_ctx, neg, {"code": "option-proof", "option": 1})

    # sum-proof
    over, _, _ = make_ballot("ballot/over-vote", p_ctx, [1, 1, 0])
    invalid("over-vote", "Plurality over-vote: two options of 1, each option proof valid (T-28)", p_ctx, over, {"code": "sum-proof"})
    over_limit, _, _ = make_ballot("ballot/over-limit", a_ctx, [1, 1, 1, 1, 0])
    invalid("over-limit", "Approval with four selected against a limit of 3", a_ctx, over_limit, {"code": "sum-proof"})
    mn_ctx, _, _ = made["approval-minimum"]
    under, _, _ = make_ballot("ballot/under-minimum", mn_ctx, [0, 0, 0, 0])
    invalid("under-minimum", "Approval with a minimum of 1 and nothing selected", mn_ctx, under, {"code": "sum-proof"})
    shifted_ctx = dict(p_ctx)
    shifted_ctx["min"], shifted_ctx["max"] = 1, 2
    invalid("other-range-same-size", "A plurality ballot checked against the range 1 to 2: the sum challenge binds min and max", shifted_ctx, p_vote, {"code": "sum-proof"})
    sp = list(p_vote["sumProof"])
    sp[0] = dict(sp[0])
    sp[0]["c"] = (sp[0]["c"] + 1) % L
    invalid("sum-challenges-dont-sum", "The sum proof's challenges don't sum", p_ctx, with_(p_vote, sumProof=sp), {"code": "sum-proof"})
    blank_ctx, blank_vote, _ = made["plurality-blank"]
    invalid("sum-proof-from-another-ballot", "Another ballot's sum proof", p_ctx, with_(p_vote, sumProof=blank_vote["sumProof"]), {"code": "sum-proof"})

    # Share checks
    share_checks = []
    for id_ in ("plurality-first", "approval-two", "trustees-max"):
        ctx, vote, shares = made[id_]
        for i, s in enumerate(shares, start=1):
            share_checks.append({"id": f"{id_}-trustee-{i}", "ballot": id_, "index": i, "shares": enc_shares(s).hex(), "valid": True})
    _, vote, shares = made["approval-two"]

    def bad_share(id_, desc, index, s):
        assert not check_shares(vote["vss"], index, s), id_
        share_checks.append({"id": id_, "description": desc, "ballot": "approval-two", "index": index, "shares": enc_shares(s).hex(), "valid": False})

    s = [dict(x) for x in shares[0]]
    s[3]["v"] = (s[3]["v"] + 1) % L
    bad_share("share-v-plus-one", "Trustee 1's share for option 3 with v + 1", 1, s)
    s = [dict(x) for x in shares[2]]
    s[0]["r"] = (s[0]["r"] + 1) % L
    bad_share("share-r-plus-one", "Trustee 3's share for option 0 with r + 1", 3, s)
    bad_share("share-other-trustee", "Trustee 2's shares checked as trustee 1's", 1, shares[1])
    bad_share("share-short", "Trustee 4's shares with the last option missing", 4, shares[3][:-1])
    s = [dict(x) for x in shares[4]]
    s[1], s[2] = s[2], s[1]
    bad_share("share-options-swapped", "Trustee 5's shares for options 1 and 2 swapped", 5, s)

    # Decoding of the committed vote and of shares
    enc = enc_committed_vote(p_vote)
    decode = []

    def rej(id_, desc, kind, b, err):
        decode.append({"id": id_, "description": desc, "type": kind, "encoding": b.hex(), "error": err})

    # Offsets: vss count (4), option 0's count (4), then k elements.
    first_elem = 8
    rej("vss-identity", "The first VSS commitment is the identity", "committed-vote", enc[:first_elem] + bytes(32) + enc[first_elem + 32 :], "non-canonical")
    rej("vss-non-canonical", "A VSS commitment that RFC 9496 Decode rejects (RFC 9496 Appendix A.2)", "committed-vote", enc[:first_elem] + bytes.fromhex("00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") + enc[first_elem + 32 :], "non-canonical")
    rej("vss-options-over-max", "vss with 65 options", "committed-vote", u32(65) + enc[4:], "length-over-max")
    rej("vss-degree-over-max", "An option with 17 VSS commitments", "committed-vote", enc[:4] + u32(17) + enc[8:], "length-over-max")
    hs_at = 4 + sum(4 + 32 * len(e) for e in p_vote["vss"])
    rej("share-hashes-over-max", "share_hashes with 17 entries", "committed-vote", enc[:hs_at] + u32(17) + enc[hs_at + 4 :], "length-over-max")
    op_at = hs_at + 4 + 32 * len(p_vote["shareHashes"])
    rej("option-proofs-over-max", "option_proofs with 65 entries", "committed-vote", enc[:op_at] + u32(65) + enc[op_at + 4 :], "length-over-max")
    rej("proof-scalar-l", "Option 0's c0 equal to ℓ", "committed-vote", enc[: op_at + 4] + scalar_raw(L) + enc[op_at + 36 :], "non-canonical")
    sp_at = op_at + 4 + 128 * len(p_vote["optionProofs"])
    rej("sum-proof-over-max", "sum_proof with 66 branches", "committed-vote", enc[:sp_at] + u32(66) + enc[sp_at + 4 :], "length-over-max")
    rej("sum-scalar-max", "The sum proof's first z equal to 2²⁵⁶ − 1", "committed-vote", enc[: sp_at + 36] + b"\xff" * 32 + enc[sp_at + 68 :], "non-canonical")
    rej("committed-vote-truncated", "The last byte missing", "committed-vote", enc[:-1], "truncated")
    rej("committed-vote-trailing", "One byte after the last field", "committed-vote", enc + b"\x00", "trailing-bytes")
    sh = enc_shares(made["plurality-first"][2][0])
    rej("shares-scalar-l", "A share's v equal to ℓ", "shares", sh[:4] + scalar_raw(L) + sh[36:], "non-canonical")
    rej("shares-over-max", "65 shares", "shares", u32(65) + sh[4:], "length-over-max")
    rej("shares-trailing", "One byte after the last share", "shares", sh + b"\x00", "trailing-bytes")

    data = {
        "format": "abolish-ballot-validity-vectors/1",
        "title": "Ballot commitments, Pedersen VSS shares and validity proofs",
        "spec": "docs/spec/ballot-validity.md",
        "generator": (
            "Printed by packages/crypto/scripts/ballot-validity-vectors.py, an implementation of "
            "docs/spec/ballot-validity.md with Python's integers and hashlib, sharing no code with "
            "packages/crypto or @noble/curves; it reuses only group-vectors.py's ristretto255 and "
            "RFC 9380 code (written from the RFCs and self-checked against them). Every valid "
            "ballot is checked by its verifier and every share by its share check before printing, "
            "and every invalid vector is checked to fail with the code it lists. The randomness is "
            "SHA-512 of fixed labels: test data only."
        ),
        "tags": {
            "statement": STATEMENT_TAG.decode(),
            "option": OPTION_TAG.decode(),
            "sum": SUM_TAG.decode(),
        },
        "generatorH": grp.encode(Hgen).hex(),
        "ballots": ballots,
        "shareChecks": share_checks,
        "decode": decode,
    }
    with open(f"{out}/ballot-validity.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def scalar_raw(x):
    return x.to_bytes(32, "little")


if __name__ == "__main__":
    main()
