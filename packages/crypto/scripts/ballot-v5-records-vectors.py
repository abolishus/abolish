#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/ballot-v5-records.json.

A second implementation of docs/spec/ballot-validity.md (Ballot record
(version 5)) and of the reference check of docs/spec/revoting.md (Admission,
under ballot version 5): the version-5 ballot record of a rolling election
(definition version 7, `electorate_mode` 2), which is version 4's record with
the root-clock step its membership proof used after the proof; its hashes
(version input 5, the step bound by the ballot hash only); its admission
checks in order, with `root-step-range` before the membership proof; the
public signals a verifier derives (the step root it computes itself from the
listed groups' events in chain order, and the rolling scope); and the window
`t − ROOT_WINDOW < τ_n ≤ t` against the named L1 block's timestamp.

It is written from the spec with Python's integers and hashlib and shares no
code with packages/crypto. It reuses this folder's other independent
generators: rolling-electorate-vectors.py's version-7 encoder and rules, root
clock, chain-order leaves and rolling scope; tier-tree-vectors.py's tree;
ballot-vectors.py's Baby Jubjub and Poseidon wrapper; ballot-v2-vectors.py's
Merkle path check; membership-vectors.py's field map; revoting-vectors.py's
message M; and ballot-v3-vectors.py's and ballot-v4-vectors.py's committed
votes, proofs and checks, which take the version input as a parameter.

Membership proofs need a Groth16 prover, so generation has three steps, as
for ballot-v4-records-vectors.py:

  python3 -I -B ballot-v5-records-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B ballot-v5-records-vectors.py assemble <constants> <work>/proofs.json <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json.
Every value but the proofs is deterministic from fixed labels (test data,
never keys); Groth16 proving is randomised, so the committed file is the
record. Then `vp check --fix` formats it.
"""

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


b2 = _load("ballot_v2_vectors", "ballot-v2-vectors.py")
b3 = _load("ballot_v3_vectors", "ballot-v3-vectors.py")
b4 = _load("ballot_v4_vectors", "ballot-v4-vectors.py")
rv = _load("rolling_electorate_vectors", "rolling-electorate-vectors.py")
b1, rev, mem = b2.b1, b2.rev, b2.mem
tt, d6, bv = rv.tt, rv.d6, b4.bv

R = b2.R
DEPTH = b2.DEPTH
PROOF_LEN = b2.PROOF_LEN
VERSION = 5
DEFAULT, AUTHOR = 1, 2
tau = rv.tau
ROOT_WINDOW = rv.ROOT_WINDOW

# Definition version 7 under mode 2 pins ballot version 5, opening version 3
# and display-text version 2, with version 6's other pins (verifier.md, 2.3).
PINS_V7_ROLLING = [(1, 7), (2, 5), (3, 3), (4, 1), (5, 1), (6, 1), (7, 4), (8, 1), (9, 2)]


def det(label):
    return hashlib.sha256(b"abolish ballot v5 records vectors " + label.encode()).digest()


def secret(label):
    s = int.from_bytes(det("identity " + label), "big") % b1.BJJ_L
    assert s != 0
    return s


# --- The record and its hashes (ballot-validity.md, Ballot record (version 5)) ---


def enc_ballot(b, version=VERSION):
    """Version 4's header and fields, then the step after the membership proof, then version 4's committed vote."""
    out = b3.u16(0x0002) + b3.u8(version)
    out += b["definitionHash"] + b3.u8(b["cell"]) + b["nullifier"].to_bytes(32, "big")
    out += b["l1RefNumber"].to_bytes(8, "big") + b["l1RefHash"]
    assert len(b["proof"]) == PROOF_LEN
    out += b["proof"] + b["step"].to_bytes(4, "big") + b["committedVote"]
    return out


def ctx_of(b):
    return {"definitionHash": b["definitionHash"], "cell": b["cell"], "nullifier": b["nullifier"]}


def statement_hash(b):
    """Version 4's statement with version input 5: the step isn't in it."""
    return b4.statement_hash(ctx_of(b), b["vote"], VERSION)


def ballot_hash(b):
    """The record's fields in record order, without the membership proof and the L1 reference: the step after the nullifier."""
    head = b["definitionHash"] + b3.u16(0x0002) + b3.u8(VERSION) + b3.u8(b["cell"])
    return b3.H(b3.ds(b4.BALLOT_TAG, head + bv.field(b["nullifier"]) + bv.u32(b["step"]) + b4.enc_committed_vote(b["vote"])))


def core_hash(b):
    """Version 4's core with version input 5: no nullifier and no step, both chosen at cast."""
    head = b["definitionHash"] + b3.u16(0x0002) + b3.u8(VERSION) + b3.u8(b["cell"])
    return b3.H(b3.ds(b4.CORE_TAG, head + b4.halves(b["vote"])))


def check_validity(e, b):
    """Checks (version 4) in order over version 5's statement hash: the first failing code, or "ok"."""
    vote = b["vote"]
    qs, offs, T = e["questions"], e["offsets"], e["optionTotal"]
    k, n, k_a, n_a = e["threshold"], e["panelSize"], e["authorThreshold"], e["authorPanelSize"]
    author_ok = (
        len(vote["authorVss"]) == T and all(len(row) == k_a for row in vote["authorVss"]) and len(vote["authorShareHashes"]) == n_a
        if n_a
        else not vote["authorVss"] and not vote["authorShareHashes"]
    )
    if (
        len(vote["vss"]) != T
        or any(len(row) != k for row in vote["vss"])
        or len(vote["shareHashes"]) != n
        or not author_ok
        or len(vote["optionProofs"]) != T
        or len(vote["sumProofs"]) != len(qs)
        or any(len(br) != q["max"] - q["min"] + 1 for br, q in zip(vote["sumProofs"], qs))
    ):
        return {"code": "validity-shape"}
    st = statement_hash(b)
    cs = b4.commitments(vote)
    for j, p in enumerate(vote["optionProofs"]):
        br = [{"c": p["c0"], "z": p["z0"]}, {"c": p["c1"], "z": p["z1"]}]
        if not bv.verify_or(b4.OPTION_TAG, bv.option_prefix(st, j), cs[j], [0, 1], br):
            return {"code": "option-proof", "option": j}
    for i, (q, o, branches) in enumerate(zip(qs, offs, vote["sumProofs"])):
        prefix = b3.question_prefix(st, i, o, q["optionCount"], q["min"], q["max"])
        values = list(range(q["min"], q["max"] + 1))
        if not bv.verify_or(b4.QUESTION_SUM_TAG, prefix, b4.question_commitment(cs, o, q["optionCount"]), values, branches):
            return {"code": "sum-proof", "question": i}
    return "ok"


# --- Rolling cells, steps and admission ----------------------------------------


def step_of(e, cell, n):
    """The verifier's own step n for `cell`'s tier: its leaves, root, member count, and whether the poll accepts it."""
    c = e["cells"][cell]
    leaves = rv.rolling_leaves(EVENTS, c["groups"], lambda ev: ev["timestamp"] <= tau(n))
    lv = tt.levels(POS.c, POS.m, POS.z, leaves)
    root = tt.root_of(POS.z, lv)
    live = rv.member_count(leaves)
    accepted = tau(n) > e["registeredAt"] and tau(n) <= e["closesAt"] and len(leaves) <= 2**32 and live > 0
    assert (root == POS.z[DEPTH]) == (live == 0)
    return {"leaves": leaves, "levels": lv, "root": root, "memberCount": live, "accepted": accepted}


def rolling_scope_field(definition_hash, tier):
    return mem.field_map(rv.rolling_scope(definition_hash, tier))


def unqualified(e, registered, author_registered, vote):
    for panel, size, reg, hashes in (
        (DEFAULT, e["panelSize"], registered, vote["shareHashes"]),
        (AUTHOR, e["authorPanelSize"], author_registered, vote["authorShareHashes"]),
    ):
        for seat in range(1, size + 1):
            if seat not in reg and hashes[seat - 1] != bytes(32):
                return {"code": "share-hash-unqualified", "panel": panel, "seat": seat}
    return None


def admission(e, registered, author_registered, b, verdict):
    """Admission (version 5) in order. `verdict` is snarkjs's on the signals below."""
    if b["definitionHash"] != e["definitionHash"]:
        return {"code": "ballot-stray"}
    if b["cell"] >= len(e["cells"]):
        return {"code": "ballot-cell"}
    v = check_validity(e, b)
    if v != "ok" and v["code"] == "validity-shape":
        return v
    u = unqualified(e, registered, author_registered, b["vote"])
    if u is not None:
        return u
    if not step_of(e, b["cell"], b["step"])["accepted"]:
        return {"code": "root-step-range"}
    if not verdict:
        return {"code": "membership-proof"}
    if v != "ok":
        return v
    tier = e["cells"][b["cell"]]["tier"]
    bh = ballot_hash(b)
    return {"code": "ok", "ballotHash": bh, "tier": tier, "message": rev.message(b["definitionHash"], tier, bh, b["l1RefNumber"], b["l1RefHash"])}


def verifier_signals(e, b):
    """[ρ_n, ν, m̂, ŝ_t] as a verifier derives them, or None where admission never reaches the membership proof's root."""
    if b["definitionHash"] != e["definitionHash"] or b["cell"] >= len(e["cells"]):
        return None
    step = step_of(e, b["cell"], b["step"])
    if not step["accepted"]:
        return None
    tier = e["cells"][b["cell"]]["tier"]
    msg = rev.message(b["definitionHash"], tier, ballot_hash(b), b["l1RefNumber"], b["l1RefHash"])
    return {"root": step["root"], "nullifier": b["nullifier"], "message": mem.field_map(msg), "scope": rolling_scope_field(b["definitionHash"], tier)}


def reference(b, l1_timestamp):
    """revoting.md, Admission, under ballot version 5: the window after the L1 reference's own checks."""
    t = tau(b["step"])
    if t <= l1_timestamp - ROOT_WINDOW:
        return "root-step-stale"
    if t > l1_timestamp:
        return "root-step-future"
    return "ok"


# --- The electorate ----------------------------------------------------------------

N0 = 2_966_400  # a step of 2026, as in rolling-tier-tree.json
T0 = tau(N0)
G1, G2, G3, UNLISTED = 1, 2, 3, 7
POS = None
EVENTS = None
SECRETS = {}


def commitment(label):
    SECRETS.setdefault(label, secret(label))
    return POS.commitment(SECRETS[label])


def build_events():
    """The group registry's events in log order: tier 0 lists groups 1 and 2, tier 2 group 3; group 7 is unlisted."""
    c = commitment
    return [
        {"block": 90, "timestamp": T0 - 1500, "group": G1, "add": [c("ada"), c("ben")]},
        {"block": 92, "timestamp": T0 - 1480, "group": UNLISTED, "add": [c("unlisted")]},
        {"block": 95, "timestamp": T0 - 1400, "group": G3, "add": [c("tess")]},
        {"block": 120, "timestamp": T0 - 900, "group": G2, "add": [c("cleo")]},
        {"block": 200, "timestamp": T0 - 100, "group": G1, "add": [c("dan")]},
        {"block": 210, "timestamp": T0 - 50, "group": G1, "remove": [1]},
        {"block": 300, "timestamp": T0 + 200, "group": G3, "remove": [0]},
        {"block": 400, "timestamp": T0 + 300, "group": G1, "add": [c("eve")]},
    ]


ROOT_L2_BLOCK = 100  # the opening state: ada, ben and tess
REGISTERED_AT = T0 - 1000  # the DefinitionRegistered event's L2 timestamp
CLOSES_AT = tau(N0 + 3)
STEPS = [N0 - 2, N0 - 1, N0, N0 + 1, N0 + 2, N0 + 3, N0 + 4]

# Pick one of three, pick up to two of four, pick exactly one of two, as in
# ballot-v4-records.json.
QUESTIONS = [(3, 0, 1), (4, 0, 2), (2, 1, 1)]
TIERS = [(0, [G1, G2]), (2, [G3])]


def rules(questions, k, n, k_a, n_a):
    qs = [{"optionCount": m, "min": lo, "max": hi} for m, lo, hi in questions]
    offsets, o = [], 0
    for q in qs:
        offsets.append(o)
        o += q["optionCount"]
    return {"questions": qs, "offsets": offsets, "optionTotal": o, "threshold": k, "panelSize": n, "authorThreshold": k_a, "authorPanelSize": n_a}


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    global POS, EVENTS
    b1.bjj_self_check()
    mem.self_check()
    POS = b1.Poseidon(constants)
    EVENTS = build_events()
    vk_hash = bytes.fromhex(json.loads((VECTORS / "membership-proof.json").read_text())["verificationKey"]["hash"])

    def opening(groups):
        leaves = rv.rolling_leaves(EVENTS, groups, lambda ev: ev["block"] <= ROOT_L2_BLOCK)
        return tt.root_of(POS.z, tt.levels(POS.c, POS.m, POS.z, leaves)), rv.member_count(leaves)

    def definition(label, k_a, n_a):
        author = (
            {"author_threshold": k_a, "author_keys": d6.AUTHOR_KEYS[:n_a], "author_transcript_hash": det("author transcript " + label)}
            if n_a
            else dict(d6.NO_AUTHOR)
        )
        rolling = []
        for tier, groups in TIERS:
            root, size = opening(groups)
            rolling.append({"tier": tier, "root_l2_block": ROOT_L2_BLOCK, "groups": groups, "root": root, "group_size": size})
        d = rv.variant(
            rv.TYPICAL,
            profile={"protocol_major": 1, "pins": PINS_V7_ROLLING},
            election_id=det("election " + label),
            questions=[d6.d5.q(*x) for x in QUESTIONS],
            rolling_electorate=rolling,
            membership_vk_hash=vk_hash,
            threshold=2,
            panel_size=3,
            ceremony_transcript_hash=det("transcript " + label),
            opens_at=REGISTERED_AT + 60,
            closes_at=CLOSES_AT,
            **d6.SEALED_EVERYDAY,
            **author,
        )
        assert d["opens_at"] < d["closes_at"], label
        assert rv.definition_rule(d) is None, (label, rv.definition_rule(d))
        enc = rv.enc_definition_v7(d)
        return dict(
            rules(QUESTIONS, 2, 3, k_a, n_a),
            label=label,
            definition=d,
            encoding=enc,
            definitionHash=b3.H(b3.ds(b3.DEFINITION_TAG, enc)),
            cells=[{"tier": t["tier"], "groups": t["groups"], "openingRoot": t["root"], "openingCount": t["group_size"]} for t in rolling],
            registeredAt=REGISTERED_AT,
            closesAt=CLOSES_AT,
        )

    panels = definition("rolling", 2, 3)
    default_only = definition("rolling-default-only", 0, 0)
    other = definition("rolling-other", 2, 3)
    elections = {"rolling": panels, "default-only": default_only, "other": other}

    proofs = {}

    def nullifier(label, election, cell):
        return POS(rolling_scope_field(election["definitionHash"], election["cells"][cell]["tier"]), SECRETS[label])

    def prove(pid, label, election, b, tree_step=None, scope=None):
        """A witness proving `label`'s live leaf in the step tree of `b`'s cell (at `tree_step`, else `b`'s own step), for M over `b`'s ballot hash."""
        cell = b["cell"]
        tier = election["cells"][cell]["tier"]
        step = step_of(election, cell, b["step"] if tree_step is None else tree_step)
        s = SECRETS[label]
        leaf = POS.commitment(s)
        i = step["leaves"].index(leaf)
        sib = tt.path_of(POS.z, step["levels"], i)
        root = b2.root_from_path(POS, leaf, i, sib)
        assert root == step["root"], pid
        sc = rolling_scope_field(election["definitionHash"], tier) if scope is None else scope
        msg = rev.message(election["definitionHash"], tier, ballot_hash(b), b["l1RefNumber"], b["l1RefHash"])
        proofs[pid] = {
            "id": pid,
            "witness": {
                "secret": str(s),
                "merkleProofLength": DEPTH,
                "merkleProofIndex": i,
                "merkleProofSiblings": [str(x) for x in sib],
                "message": str(mem.field_map(msg)),
                "scope": str(sc),
            },
            "expect": {"root": str(root), "nullifier": str(POS(sc, s))},
        }

    def with_vote(b, vote):
        return dict(b, vote=vote, committedVote=b4.enc_committed_vote(vote))

    def ballot(label, election, cell, nul, step, answers, hashes, author_hashes, vote_rules=None, votes=None, version=VERSION):
        votes = votes or b3.flat(answers)
        ctx = {"definitionHash": election["definitionHash"], "cell": cell, "nullifier": nul}
        vote, _, _, _ = b4.make_ballot(
            "v5-records/" + label, vote_rules or election, ctx, votes, version=version, share_hashes=hashes, author_share_hashes=author_hashes
        )
        r = (21_000_000 + int.from_bytes(det("ref " + label)[:2], "big"), det("ref hash " + label))
        return with_vote(
            {"definitionHash": election["definitionHash"], "cell": cell, "nullifier": nul, "step": step, "l1RefNumber": r[0], "l1RefHash": r[1]},
            vote,
        )

    def hashes(panel, seats, n=3):
        return [det(f"{panel} share {i}") if i in seats else bytes(32) for i in range(1, n + 1)]

    d12, d123 = hashes("default", (1, 2)), hashes("default", (1, 2, 3))
    a12, a123 = hashes("author", (1, 2)), hashes("author", (1, 2, 3))
    cases = []
    references = []

    def case(cid, description, election, registered, author_registered, b, proof, expect=None, l1_timestamp=None):
        cases.append(
            {
                "id": cid,
                "description": description,
                "election": election,
                "registered": list(registered),
                "authorRegistered": list(author_registered),
                "ballot": b,
                "proof": proof,
                "expect": expect or cid,
            }
        )
        if l1_timestamp is not None:
            ref_case(cid, "Its own L1 reference", cid, l1_timestamp, "ok")

    def ref_case(rid, description, ballot_case, l1_timestamp, expect):
        references.append({"id": rid, "description": description, "ballot": ballot_case, "l1Timestamp": l1_timestamp, "expect": expect})

    e = panels
    # Honest ballots.
    b_dan = ballot("dan", e, 0, nullifier("dan", e, 0), N0, [(3, [1]), (4, [0, 3]), (2, [1])], d12, a12)
    prove("dan", "dan", e, b_dan)
    case("ok-newest-step", "A member who joined during the poll (step N0's additions) answers at step N0, the newest settled step at its L1 reference; seat 3 of each panel is unregistered", "rolling", [1, 2], [1, 2], b_dan, "dan", "ok", T0 + 30)

    b_ada = ballot("ada", e, 0, nullifier("ada", e, 0), N0 - 1, [(3, [0]), (4, []), (2, [0])], d12, a12)
    prove("ada", "ada", e, b_ada)
    case("ok-older-step", "An opening member answers at step N0 − 1 with a reference after step N0: an older step inside the window", "rolling", [1, 2], [1, 2], b_ada, "ada", "ok", T0 + 30)

    b_ada2 = ballot("ada-revote", e, 0, nullifier("ada", e, 0), N0 + 1, [(3, [2]), (4, [1]), (2, [1])], d12, a12)
    prove("ada-revote", "ada", e, b_ada2)
    case("ok-revote-newer-step", "The same member's re-vote at step N0 + 1: the same nullifier at another step and root", "rolling", [1, 2], [1, 2], b_ada2, "ada-revote", "ok", tau(N0 + 1) + 12)

    b_ben = ballot("ben-back-dated", e, 0, nullifier("ben", e, 0), N0 - 1, [(3, []), (4, [3]), (2, [0])], d12, a12)
    prove("ben-back-dated", "ben", e, b_ben)
    case("ok-removed-back-dated", "A member removed before step N0 answers at step N0 − 1 under a reference before the removal: a removal doesn't stop a ballot in an open poll (membership.md, Root clock and steps)", "rolling", [1, 2], [1, 2], b_ben, "ben-back-dated", "ok", tau(N0 - 1) + 10)

    b_tess = ballot("tess", e, 1, nullifier("tess", e, 1), N0, [(3, []), (4, []), (2, [1])], d12, a12)
    prove("tess", "tess", e, b_tess)
    case("ok-tier-2", "Tier 2's member in cell 1 at step N0, answering only the pick-exactly-one question", "rolling", [1, 2], [1, 2], b_tess, "tess", "ok", T0 + 60)

    b_all = ballot("every-seat", e, 0, nullifier("cleo", e, 0), N0, [(3, [0]), (4, [1, 2]), (2, [0])], d123, a123)
    prove("every-seat", "cleo", e, b_all)
    case("ok-every-seat", "A member of tier 0's second group with a share hash at every seat of both panels, under key sets that register all three of each", "rolling", [1, 2, 3], [1, 2, 3], b_all, "every-seat", "ok", T0 + 300)
    case("share-hash-unqualified", "The same ballot when default seat 3 isn't registered", "rolling", [1, 2], [1, 2, 3], b_all, "every-seat")
    case("share-hash-unqualified-author", "The same ballot when author seat 2 isn't registered", "rolling", [1, 2, 3], [1, 3], b_all, "every-seat", "share-hash-unqualified")

    b_d = ballot("default-only", default_only, 0, nullifier("cleo", default_only, 0), N0 + 2, [(3, [2]), (4, [3]), (2, [0])], d12, [])
    prove("default-only", "cleo", default_only, b_d)
    case("ok-default-only", "A rolling poll without an author panel, at step N0 + 2", "default-only", [1, 2], [], b_d, "default-only", "ok", tau(N0 + 2) + 5)

    b_close = ballot("eve-at-close", e, 0, nullifier("eve", e, 0), N0 + 3, [(3, [1]), (4, []), (2, [1])], d12, a12)
    prove("eve-at-close", "eve", e, b_close)
    case("ok-close-step", "A member added at step N0 + 1 answers at step N0 + 3, whose boundary is closes_at", "rolling", [1, 2], [1, 2], b_close, "eve-at-close", "ok", CLOSES_AT)

    # Rejected before the step.
    b_other = ballot("other-election", other, 0, nullifier("dan", other, 0), N0, [(3, [0]), (4, []), (2, [0])], d12, a12)
    prove("other-election", "dan", other, b_other)
    case("ballot-stray", "Another election's ballot (the same electorate, questions and panels, another election_id)", "rolling", [1, 2], [1, 2], b_other, "other-election")
    case("ballot-cell", "A ballot naming cell 2: the partition has one cell per rolling tier, cells 0 and 1", "rolling", [1, 2], [1, 2], dict(b_dan, cell=2), "dan")
    b_none = ballot("no-author-half", e, 0, nullifier("dan", e, 0), N0, [(3, [0]), (4, []), (2, [0])], d12, [], vote_rules=rules(QUESTIONS, 2, 3, 0, 0))
    case("validity-shape", "A ballot without an author half in a poll with an author panel", "rolling", [1, 2], [1, 2], b_none, "dan")

    # Steps the poll doesn't accept (root-step-range).
    b_early = ballot("before-registration", e, 0, nullifier("ada", e, 0), N0 - 2, [(3, [0]), (4, []), (2, [0])], d12, a12)
    prove("before-registration", "ada", e, b_early)
    case("root-step-range-before-registration", "An opening member at step N0 − 2, whose boundary is before the definition's registration: its tree holds the member, but the poll doesn't accept it", "rolling", [1, 2], [1, 2], b_early, "before-registration", "root-step-range")
    b_late = ballot("after-close", e, 0, nullifier("ada", e, 0), N0 + 4, [(3, [0]), (4, []), (2, [0])], d12, a12)
    prove("after-close", "ada", e, b_late)
    case("root-step-range-after-close", "An opening member at step N0 + 4, whose boundary is after closes_at", "rolling", [1, 2], [1, 2], b_late, "after-close", "root-step-range")
    b_empty = dict(b_tess, step=N0 + 1)
    case("root-step-range-no-member", "Tier 2's ballot relabelled to step N0 + 1, when its only member has been removed: a step with no live leaf (root Z_32) is never accepted", "rolling", [1, 2], [1, 2], b_empty, "tess", "root-step-range")
    b_max = dict(b_dan, step=2**32 - 1)
    case("root-step-range-u32-max", "The newest-step ballot relabelled to step 2³² − 1", "rolling", [1, 2], [1, 2], b_max, "dan", "root-step-range")

    # Membership failures.
    case("membership-step-relabelled", "The newest-step ballot relabelled to step N0 + 1, which also holds its member: the ballot hash binds the step, so M and the proof fail", "rolling", [1, 2], [1, 2], dict(b_dan, step=N0 + 1), "dan", "membership-proof")
    # Relabelled to a step with the same root: only the ballot hash's binding of the step fails them (T-38).
    assert step_of(e, 0, N0 + 1)["root"] == step_of(e, 0, N0 + 2)["root"]
    case("membership-step-relabelled-same-root", "The re-vote relabelled from step N0 + 1 to N0 + 2, whose tree and root are the same: the root passes, but M binds the step through the ballot hash", "rolling", [1, 2], [1, 2], dict(b_ada2, step=N0 + 2), "ada-revote", "membership-proof")
    assert step_of(e, 1, N0 - 1)["root"] == step_of(e, 1, N0)["root"]
    case("membership-step-relabelled-same-root-tier-2", "Tier 2's ballot relabelled from step N0 to N0 − 1, whose root is the same", "rolling", [1, 2], [1, 2], dict(b_tess, step=N0 - 1), "tess", "membership-proof")
    b_wrong_root = ballot("wrong-root", e, 0, nullifier("ada", e, 0), N0, [(3, [1]), (4, [2]), (2, [0])], d12, a12)
    prove("wrong-root", "ada", e, b_wrong_root, tree_step=N0 - 1)
    case("membership-other-step-root", "A ballot naming step N0 whose proof is against step N0 − 1's root, with M over this ballot: the verifier takes the root of the step the ballot names", "rolling", [1, 2], [1, 2], b_wrong_root, "wrong-root", "membership-proof")
    fixed_scope = b1.scope_field(e["definitionHash"], 0, step_of(e, 0, N0)["root"])
    b_fixed = ballot("fixed-scope", e, 0, POS(fixed_scope, SECRETS["dan"]), N0, [(3, [0]), (4, [0]), (2, [1])], d12, a12)
    prove("fixed-scope", "dan", e, b_fixed, scope=fixed_scope)
    case("membership-fixed-scope", "A ballot proved under a fixed poll's scope (with the step root in it) rather than the rolling scope", "rolling", [1, 2], [1, 2], b_fixed, "fixed-scope", "membership-proof")
    case("membership-ref-changed", "The newest-step ballot naming the next L1 block: M changes, so its proof fails", "rolling", [1, 2], [1, 2], dict(b_dan, l1RefNumber=b_dan["l1RefNumber"] + 1), "dan", "membership-proof")
    case("membership-other-ballot-proof", "The older-step ballot carrying the re-vote's valid proof", "rolling", [1, 2], [1, 2], b_ada, "ada-revote", "membership-proof")

    # Validity failures behind a valid membership proof.
    two = b3.flat([(3, []), (4, []), (2, [1])])
    two[4] = 2
    b_two = ballot("vote-of-two", e, 0, nullifier("cleo", e, 0), N0 + 1, None, d12, a12, votes=two)
    prove("vote-of-two", "cleo", e, b_two)
    case("option-proof", "A vote of 2 for flat option 4, question 1's second option", "rolling", [1, 2], [1, 2], b_two, "vote-of-two")
    b_q1 = ballot("question-1-over", e, 0, nullifier("eve", e, 0), N0 + 2, [(3, []), (4, [0, 1, 2]), (2, [0])], d12, a12)
    prove("question-1-over", "eve", e, b_q1)
    case("sum-proof", "Three of question 1's options where it allows two", "rolling", [1, 2], [1, 2], b_q1, "question-1-over")
    b_v4 = ballot("statement-version-4", e, 0, nullifier("dan", e, 0), N0, [(3, [0]), (4, [1]), (2, [0])], d12, a12, version=4)
    prove("statement-version-4", "dan", e, b_v4)
    case("option-proof-statement-version-4", "Validity proofs made over version 4's statement (version input 4), under a valid membership proof: no proof made under one version verifies under another (T-31)", "rolling", [1, 2], [1, 2], b_v4, "statement-version-4", "option-proof")

    # The order of the checks.
    case("order-unqualified-before-step", "An unregistered seat's share hash and a step after close: share-hash-unqualified comes first", "rolling", [1, 2], [1, 2, 3], dict(b_all, step=N0 + 4), "every-seat", "share-hash-unqualified")
    case("order-step-before-membership", "A step before registration and another ballot's proof: root-step-range comes first", "rolling", [1, 2], [1, 2], dict(b_ada, step=N0 - 2), "dan", "root-step-range")
    case("order-membership-before-option", "A vote of 2 and another ballot's proof: membership-proof comes first", "rolling", [1, 2], [1, 2], b_two, "dan", "membership-proof")

    # The window against the named L1 block's timestamp (revoting.md, Admission).
    t = tau(N0)
    ref_case("window-at-boundary", "The reference's timestamp equals τ_n", "ok-newest-step", t, "ok")
    ref_case("window-one-second-early", "The reference is one second before τ_n: a step not yet reached", "ok-newest-step", t - 1, "root-step-future")
    ref_case("window-last-second", "ROOT_WINDOW − 1 seconds after τ_n", "ok-newest-step", t + ROOT_WINDOW - 1, "ok")
    ref_case("window-edge", "Exactly ROOT_WINDOW after τ_n: the window is open at its old end", "ok-newest-step", t + ROOT_WINDOW, "root-step-stale")
    ref_case("window-older-step-stale", "The older-step ballot (step N0 − 1) with a reference ROOT_WINDOW after its boundary", "ok-older-step", tau(N0 - 1) + ROOT_WINDOW, "root-step-stale")
    ref_case("window-close-step-future", "The close-step ballot with a reference a second before closes_at", "ok-close-step", CLOSES_AT - 1, "root-step-future")

    checks = []
    for c in cases:
        sig = verifier_signals(elections[c["election"]], c["ballot"])
        if sig is not None:
            checks.append({"case": c["id"], "proof": c["proof"], "signals": {k: str(v) for k, v in sig.items()}})
    return {"elections": elections, "proofs": proofs, "cases": cases, "checks": checks, "references": references}




def hexb(b):
    return b.hex()


def statements(constants, out):
    s = build(constants)
    pathlib.Path(out).write_text(json.dumps({"proofs": list(s["proofs"].values()), "checks": s["checks"]}, indent=2) + "\n")


def election_json(e):
    cells = []
    for i, c in enumerate(e["cells"]):
        steps = []
        for n in STEPS:
            st = step_of(e, i, n)
            steps.append({"step": n, "tau": str(tau(n)), "root": str(st["root"]), "memberCount": st["memberCount"], "accepted": st["accepted"]})
        cells.append(
            {
                "cell": i,
                "tier": c["tier"],
                "groups": [str(g) for g in c["groups"]],
                "openingRoot": str(c["openingRoot"]),
                "openingCount": c["openingCount"],
                "scope": str(rolling_scope_field(e["definitionHash"], c["tier"])),
                "steps": steps,
            }
        )
    return {
        "definition": hexb(e["encoding"]),
        "definitionHash": hexb(e["definitionHash"]),
        "questions": [
            {"optionCount": q["optionCount"], "minSelections": q["min"], "maxSelections": q["max"], "offset": o}
            for q, o in zip(e["questions"], e["offsets"])
        ],
        "threshold": e["threshold"],
        "panelSize": e["panelSize"],
        "authorThreshold": e["authorThreshold"],
        "authorPanelSize": e["authorPanelSize"],
        "rootL2Block": str(ROOT_L2_BLOCK),
        "registeredAt": str(e["registeredAt"]),
        "closesAt": str(e["closesAt"]),
        "cells": cells,
    }


def result_json(result, b):
    out = {"code": result["code"]}
    for key in ("option", "question", "panel", "seat"):
        if key in result:
            out[key] = result[key]
    if result["code"] == "ok":
        out.update(ballotHash=hexb(result["ballotHash"]), message=hexb(result["message"]), tier=result["tier"], cell=b["cell"], step=b["step"])
    return {"admission": out}


def assemble(constants, proofs_path, out_dir):
    s = build(constants)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    proof_bytes = {k: bytes.fromhex(v) for k, v in got["proofs"].items()}
    verdicts = got["verdicts"]
    assert set(proof_bytes) == set(s["proofs"])

    def record(b, proof):
        return enc_ballot(dict(b, proof=proof_bytes[proof]))

    ballots = []
    by_id = {}
    for c in s["cases"]:
        e = s["elections"][c["election"]]
        b = c["ballot"]
        sig = verifier_signals(e, b)
        verdict = verdicts.get(c["id"])
        assert (sig is None) == (verdict is None), c["id"]
        result = admission(e, c["registered"], c["authorRegistered"], b, verdict)
        assert result["code"] == c["expect"], (c["id"], result)
        v = {
            "id": c["id"],
            "description": c["description"],
            "election": c["election"],
            "registered": c["registered"],
            "authorRegistered": c["authorRegistered"],
            "encoding": hexb(record(b, c["proof"])),
            "statementHash": hexb(statement_hash(b)),
            "ballotHash": hexb(ballot_hash(b)),
            "coreHash": hexb(core_hash(b)),
        }
        if sig is not None:
            v["signals"] = {k: str(x) for k, x in sig.items()}
            v["snarkjs"] = verdict
        v.update(result_json(result, b))
        ballots.append(v)
        by_id[c["id"]] = (b, result)

    refs = []
    for r in s["references"]:
        b, result = by_id[r["ballot"]]
        assert result["code"] == "ok", r["id"]
        got_ref = reference(b, r["l1Timestamp"])
        assert got_ref == r["expect"], (r["id"], got_ref)
        refs.append({"id": r["id"], "description": r["description"], "ballot": r["ballot"], "step": b["step"], "l1Timestamp": str(r["l1Timestamp"]), "expect": got_ref})

    good_case = next(c for c in s["cases"] if c["id"] == "ok-every-seat")
    gb = good_case["ballot"]
    good = record(gb, good_case["proof"])
    proof_at = 3 + 32 + 1 + 32 + 8 + 32
    step_at = proof_at + PROOF_LEN
    vote_at = step_at + 4
    assert (proof_at, step_at, vote_at) == (108, 364, 368)
    assert good[step_at:vote_at] == gb["step"].to_bytes(4, "big")
    assert good[vote_at:] == gb["committedVote"]

    def with_bytes(at, new):
        return good[:at] + new + good[at + len(new) :]

    first_element = vote_at + 4 + 4
    decode = [
        ("truncated", "The every-seat ballot without its last byte", good[:-1], "truncated", None),
        ("trailing-byte", "The every-seat ballot with a byte after its last range proof", good + b"\x00", "trailing-bytes", len(good)),
        ("header-only", "A version-5 ballot record header with nothing after it", good[:3], "truncated", 3),
        ("before-step", "The every-seat ballot cut after its membership proof, before the step", good[:step_at], "truncated", step_at),
        ("inside-step", "The every-seat ballot cut two bytes into the step", good[: step_at + 2], "truncated", step_at),
        ("nullifier-r", "A nullifier equal to the BN254 scalar field order", with_bytes(36, R.to_bytes(32, "big")), "non-canonical", 36),
        ("vss-identity", "A committed vote whose first default VSS commitment is the identity, at its version-5 offset", with_bytes(first_element, bytes(32)), "non-canonical", first_element),
        ("version-4", "The same bytes under version 4, which a profile pinning version 5 refuses", with_bytes(2, b"\x04"), "profile-mismatch", 2),
        ("version-6", "The same bytes under version 6, which no profile pins", with_bytes(2, b"\x06"), "profile-mismatch", 2),
    ]
    decode_vectors = []
    for did, desc, enc, err, at in decode:
        dvec = {"id": did, "description": desc, "encoding": hexb(enc), "error": err}
        if at is not None:
            dvec["offset"] = at
        decode_vectors.append(dvec)

    out = {
        "format": "abolish-ballot-vectors/1",
        "title": "Ballot record, version 5 (a rolling poll's ballot, naming its root-clock step): encodings, hashes, admission checks, the step window against the L1 reference, and decode rejections",
        "spec": "docs/spec/ballot-validity.md",
        "generator": (
            "packages/crypto/scripts/ballot-v5-records-vectors.py, an implementation of the Ballot record (version 5) "
            "section and of revoting.md's window check with Python's integers and hashlib, reusing this folder's "
            "independent rolling-electorate (version-7 definitions, root clock, chain-order rolling tier trees, rolling "
            "scope), tier-tree, ballot-v2, ballot-v3, ballot-v4, membership and revoting generators; every step root is "
            "rebuilt here from the listed groups' events; membership proofs by packages/crypto/scripts/ballot-proofs.mjs, "
            "run outside the workspace with Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5's fullProve, "
            "which checks that each proof's outputs equal the root and nullifier computed here; every pairing verdict is "
            "snarkjs's groth16.verify on the signals derived here from the record and the definition. Share hashes are "
            "labels, not ciphertext hashes. Decode errors and their offsets are labelled by hand from the strict-decoding "
            "rules and the layout's offsets"
        ),
        "recordType": "0x0002",
        "version": VERSION,
        "rootPeriod": str(rv.ROOT_PERIOD),
        "rootOffset": str(rv.ROOT_OFFSET),
        "rootWindow": str(ROOT_WINDOW),
        "panels": {"default": DEFAULT, "author": AUTHOR},
        "events": [
            {
                "block": str(ev["block"]),
                "timestamp": str(ev["timestamp"]),
                "group": str(ev["group"]),
                **({"add": [str(v) for v in ev["add"]]} if "add" in ev else {"remove": [str(i) for i in ev["remove"]]}),
            }
            for ev in EVENTS
        ],
        "elections": {name: election_json(e) for name, e in s["elections"].items()},
        "ballots": ballots,
        "references": refs,
        "decode": decode_vectors,
    }
    (pathlib.Path(out_dir) / "ballot-v5-records.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote ballot-v5-records.json: {len(ballots)} ballots, {len(refs)} references, {len(decode_vectors)} decode")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: ballot-v5-records-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
