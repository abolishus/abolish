#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-ballots-v5.json.

Elections for the verifier's ballot admission under a rolling definition
(definition version 7, `electorate_mode` 2), whose ballots (version 5) name
their cell and the root-clock step their membership proof used
(docs/spec/verifier.md, Ballot admission; 5.1 to 5.5, 5.7): each is a
definition, a board copy and the panel a bundle pins, beside the group
registry's events and the definition's registration time, from which a
verifier computes every step root itself, with the rows 3.2, 5.1 to 5.5 and
5.7 a verifier reports and the report's `ballots`. Every transcript is made
for the default panel's stub of the definition it is checked against, and
every ballot proves membership of its step's tree under that definition's
hash and its tier's rolling scope, so a verifier checks them with nothing
but the bundle and the events. Ballots come by every path a rolling poll
has: the board path, and the board's `RollingBallotSubmitted` and
`RelayedRollingBallotSubmitted` under contract-event version 13, each with
the root its submitter supplied, which `root-step-mismatch` holds to the
step's own (docs/spec/ballot-validity.md, Admission (version 5)).

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: ballot-v5-records-vectors.py
(the version-5 record, its hashes, its admission checks in order, the step
roots rebuilt from the listed groups' events and the rolling scope, with its
events and timing), verifier-ceremony-vectors.py (transcripts, board entries
and the ceremony rows; its encoders and rules are given
rolling-electorate-vectors.py's version 7 here) and
verifier-ballots-vectors.py (the anchoring clock, the close rule's window and
the board's rolling events, framed by contract-event-v10-vectors.py and
contract-event-v11-vectors.py and read under contract-event-v13-vectors.py's
version 13).

Membership proofs need a Groth16 prover, so generation has three steps, as
for verifier-ballots-v4.json:

  python3 -I -B verifier-ballots-v5-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B verifier-ballots-v5-vectors.py assemble <constants> <work>/proofs.json <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json
and ballot-proofs.mjs runs outside the workspace (see its header). Every
value but the proofs is deterministic from fixed labels (test data, never
keys); Groth16 proving is randomised, so the committed file is the record.
Then `vp check --fix` formats it.
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


r5 = _load("ballot_v5_records_vectors", "ballot-v5-records-vectors.py")
vc = _load("verifier_ceremony_vectors", "verifier-ceremony-vectors.py")
vb = _load("verifier_ballots_vectors", "verifier-ballots-vectors.py")
b1, b2, b3, b4, rv, mem, rev, tt, d6 = r5.b1, r5.b2, r5.b3, r5.b4, r5.rv, r5.mem, r5.rev, r5.tt, r5.d6
cv = vc.cv

# verifier-ceremony-vectors.py reads definition versions 1 to 5; version 7's
# layout and rules are rolling-electorate-vectors.py's. The default panel's
# stub is the whole definition with `ceremony_transcript_hash` zeroed, as
# `vc.stub_hash` makes it.
vc.ENCODE[7] = rv.enc_definition_v7
vc.RULE[7] = rv.definition_rule

H, ds = cv.H, cv.ds
BALLOT_TYPE = 0x0002
MEMBERSHIP_VK_HASH = bytes.fromhex(json.loads((VECTORS / "membership-proof.json").read_text())["verificationKey"]["hash"])
EVENTS_VERSION = 13
# Definition version 7 under mode 2: ballot version 5, spoiled-ballot opening
# version 3, tally-opening version 1 and display-text version 2, as a sealed
# rolling poll without an author panel pins them, with board-entry version 5
# (the close statement) and contract-event version 13, the only one whose
# tables name the relayed rolling ballot and read the definition's own
# registration (docs/spec/verifier.md, 2.3).
PINS = [(1, 7), (BALLOT_TYPE, 5), (3, 3), (4, 1), (5, 1), (6, 1), (vc.BOARD_ENTRY_TYPE, vb.BOARD_VERSION), (vb.CONTRACT_EVENT_TYPE, EVENTS_VERSION), (9, 2)]

outcome, NOT_IMPLEMENTED = vc.outcome, vc.NOT_IMPLEMENTED

# docs/spec/verifier.md, Ballot admission: the rows each admission code
# fails. `root-step-range` and `root-step-mismatch` leave no root to check
# the proof against, as `ballot-cell` leaves no cell.
ROWS_OF = {
    "ballot-stray": ("5.1",),
    "ballot-cell": ("5.1",),
    "root-step-range": ("5.1",),
    "root-step-mismatch": ("5.1",),
    "membership-proof": ("5.1", "5.2", "5.3"),
    "validity-shape": ("5.4",),
    "share-hash-unqualified": ("5.4",),
    "option-proof": ("5.4",),
    "sum-proof": ("5.4",),
}
ADMISSION_ROWS = ("5.1", "5.2", "5.3", "5.4")

N0, T0, tau = r5.N0, r5.T0, r5.tau
# A panel of four, threshold three: seat 4 sends nothing, so seats 1 to 3
# are registered and seat 4's share hash must be zero.
SEATS = [1, 2, 3]


def det(label):
    return hashlib.sha256(b"abolish verifier ballots v5 vectors " + label.encode()).digest()


def admission(e, b, verdict, supplied=None):
    """Admission (version 5) in order, ballot-v5-records-vectors.py's, with `root-step-mismatch` after `root-step-range` on a rolling path: a supplied root other than the step's own rejects the ballot before its proof (ballot-validity.md, Admission (version 5))."""
    result = r5.admission(e, SEATS, [], b, verdict)
    if supplied is not None and result["code"] in ("ok", "membership-proof", "option-proof", "sum-proof"):
        if supplied != r5.step_of(e, b["cell"], b["step"])["root"]:
            return {"code": "root-step-mismatch"}
    return result


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    b1.bjj_self_check()
    mem.self_check()
    pos = b1.Poseidon(constants)
    # ballot-v5-records-vectors.py's electorate: its events, secrets and
    # timing, which its step roots are rebuilt from.
    r5.POS = pos
    r5.EVENTS = r5.build_events()
    panel = cv.make_panel("panel-4", 3, 4)

    def opening(groups):
        leaves = rv.rolling_leaves(r5.EVENTS, groups, lambda ev: ev["block"] <= r5.ROOT_L2_BLOCK)
        return tt.root_of(pos.z, tt.levels(pos.c, pos.m, pos.z, leaves)), rv.member_count(leaves)

    rolling = []
    for tier, groups in r5.TIERS:
        root, size = opening(groups)
        rolling.append({"tier": tier, "root_l2_block": r5.ROOT_L2_BLOCK, "groups": groups, "root": root, "group_size": size})

    def election_for(label):
        """A rolling definition for the panel and its transcript, made for the definition's own default stub."""
        fields = rv.variant(
            rv.TYPICAL,
            profile={"protocol_major": 1, "pins": PINS},
            election_id=det("election " + label),
            questions=[d6.d5.q(*x) for x in r5.QUESTIONS],
            rolling_electorate=rolling,
            membership_vk_hash=MEMBERSHIP_VK_HASH,
            opens_at=r5.REGISTERED_AT + 60,
            closes_at=r5.CLOSES_AT,
            **d6.SEALED_EVERYDAY,
            **d6.NO_AUTHOR,
        )
        ctx = vc.election_of(vc.definition_for(panel, bytes(32), fields))
        t = vc.transcript(f"verifier-ballots-v5/{label}", panel, SEATS, ctx)
        d = vc.definition_for(panel, H(ds(vc.TRANSCRIPT_TAG, t)), fields)
        assert vc.own_version(d) == 7 and d["electorate_mode"] == rv.ROLLING
        enc = vc.encode(d)
        e = dict(
            r5.rules(r5.QUESTIONS, d["threshold"], d["panel_size"], 0, 0),
            label=label,
            definition=d,
            encoding=enc,
            definitionHash=H(ds(b3.DEFINITION_TAG, enc)),
            cells=[{"tier": t["tier"], "groups": t["groups"]} for t in rolling],
            registeredAt=r5.REGISTERED_AT,
            closesAt=r5.CLOSES_AT,
        )
        return d, t, e

    d, t, e = election_for("rolling")
    _, _, e_o = election_for("rolling-other")
    assert e_o["definitionHash"] != e["definitionHash"]
    eid = d["election_id"]
    proofs, checks, bundles = {}, [], []

    def nullifier(who, election, cell):
        return pos(r5.rolling_scope_field(election["definitionHash"], election["cells"][cell]["tier"]), r5.SECRETS[who])


    def ballot(label, election, cell, who, step, answers, hashes, vote_rules=None, votes=None, version=5, author_hashes=(), nul=None):
        """A ballot of `who` at `step` answering `answers` (per question, the option count and the options picked), or the flat `votes` as given, with its nullifier under the tier's rolling scope unless `nul` gives another."""
        ctx = {"definitionHash": election["definitionHash"], "cell": cell, "nullifier": nullifier(who, election, cell) if nul is None else nul}
        vote, _, _, _ = b4.make_ballot(
            "verifier-ballots-v5/" + election["label"] + "/" + label,
            vote_rules or election,
            ctx,
            votes or b3.flat(answers),
            version=version,
            share_hashes=hashes,
            author_share_hashes=list(author_hashes),
        )
        r = (21_000_000 + int.from_bytes(det("ref " + label)[:2], "big"), det("ref hash " + label))
        return dict(ctx, step=step, l1RefNumber=r[0], l1RefHash=r[1], vote=vote, committedVote=b4.enc_committed_vote(vote))

    def prove(pid, who, election, b, tree_step=None, scope=None):
        """A witness proving `who`'s live leaf in the step tree of `b`'s cell (at `tree_step`, else `b`'s own step), for M over `b`'s ballot hash."""
        cell = b["cell"]
        tier = election["cells"][cell]["tier"]
        step = r5.step_of(election, cell, b["step"] if tree_step is None else tree_step)
        s = r5.SECRETS[who]
        leaf = pos.commitment(s)
        i = step["leaves"].index(leaf)
        sib = tt.path_of(pos.z, step["levels"], i)
        root = b2.root_from_path(pos, leaf, i, sib)
        assert root == step["root"], pid
        sc = r5.rolling_scope_field(election["definitionHash"], tier) if scope is None else scope
        msg = rev.message(election["definitionHash"], tier, r5.ballot_hash(b), b["l1RefNumber"], b["l1RefHash"])
        proofs[pid] = {
            "id": pid,
            "witness": {
                "secret": str(s),
                "merkleProofLength": r5.DEPTH,
                "merkleProofIndex": i,
                "merkleProofSiblings": [str(x) for x in sib],
                "message": str(mem.field_map(msg)),
                "scope": str(sc),
            },
            "expect": {"root": str(root), "nullifier": str(pos(sc, s))},
        }
        return pid

    def root_of(cell, n):
        return r5.step_of(e, cell, n)["root"]

    def item(b, pid, path="board", how=None, root=None, time=None):
        """One board item: a ballot with its proof by `path` ("board", or "rolling" and "relayed-rolling" with the root they supply and the event's L2 timestamp or the relay call's stamp), as made or as `how` changes it ("negated": the proof re-randomised; "trailing": a byte after the record; "version-4": the record's version byte 4)."""
        assert (path == "board") == (root is None)
        return {"ballot": b, "proof": pid, "path": path, "how": how, "root": root, "time": time}

    def bundle(bid, description, board):
        for i, p in enumerate(board):
            if isinstance(p, bytes) or p["how"] in ("trailing", "version-4"):
                continue
            sig = r5.verifier_signals(e, p["ballot"])
            if sig is not None:
                check = {"case": f"{bid}/{i}", "proof": p["proof"], "signals": {k: str(v) for k, v in sig.items()}}
                if p["how"] == "negated":
                    check["negate"] = True
                checks.append(check)
        bundles.append({"id": bid, "description": description, "board": board})

    zero4 = [det("share 1"), det("share 2"), det("share 3"), bytes(32)]
    full4 = zero4[:3] + [det("share 4")]

    # Honest ballots, each at a step the poll accepts: a member who joined
    # during the poll, an opening member at an older step and her re-vote at
    # a newer one, tier 2's member in cell 1, and a member added at step
    # N0 + 1 answering at the step whose boundary is closes_at.
    b_dan = ballot("dan", e, 0, "dan", N0, [(3, [1]), (4, [0, 3]), (2, [1])], zero4)
    p_dan = prove("dan", "dan", e, b_dan)
    b_ada = ballot("ada", e, 0, "ada", N0 - 1, [(3, [0]), (4, []), (2, [0])], zero4)
    p_ada = prove("ada", "ada", e, b_ada)
    b_rev = ballot("ada-revote", e, 0, "ada", N0 + 1, [(3, [2]), (4, [1]), (2, [1])], zero4)
    p_rev = prove("ada-revote", "ada", e, b_rev)
    b_tess = ballot("tess", e, 1, "tess", N0, [(3, []), (4, []), (2, [1])], zero4)
    p_tess = prove("tess", "tess", e, b_tess)
    b_eve = ballot("eve-at-close", e, 0, "eve", N0 + 3, [(3, [1]), (4, []), (2, [1])], zero4)
    p_eve = prove("eve-at-close", "eve", e, b_eve)

    # Rejected before the step: another election's ballot, an author half
    # (2 of 3) on a poll without an author panel, whose shape is the
    # election's, never the ballot's (T-17, T-37), and a share hash at the
    # unregistered seat 4.
    b_stray = ballot("stray", e_o, 0, "dan", N0, [(3, [0]), (4, []), (2, [0])], zero4)
    p_stray = prove("stray", "dan", e_o, b_stray)
    b_author = ballot(
        "author-half", e, 0, "dan", N0, [(3, [0]), (4, []), (2, [0])], zero4,
        vote_rules=r5.rules(r5.QUESTIONS, 3, 4, 2, 3), author_hashes=[det("author share 1"), det("author share 2"), bytes(32)],
    )
    b_unq = ballot("unqualified", e, 0, "cleo", N0, [(3, [0]), (4, [1, 2]), (2, [0])], full4)
    p_unq = prove("unqualified", "cleo", e, b_unq)

    # Steps the poll doesn't accept (root-step-range): before registration
    # and after close, each with a proof of the step's own tree; tier 2's
    # ballot relabelled to a step after its only member's removal; and the
    # last u32.
    b_early = ballot("before-registration", e, 0, "ada", N0 - 2, [(3, [0]), (4, []), (2, [0])], zero4)
    p_early = prove("before-registration", "ada", e, b_early)
    b_late = ballot("after-close", e, 0, "ada", N0 + 4, [(3, [0]), (4, []), (2, [0])], zero4)
    p_late = prove("after-close", "ada", e, b_late)
    assert r5.step_of(e, 1, N0 + 1)["memberCount"] == 0

    # Membership failures behind an accepted step: a proof against another
    # step's root, and one under a fixed poll's scope (with the step root in
    # it), whose nullifier the ballot carries.
    assert root_of(0, N0 - 1) != root_of(0, N0) and root_of(0, N0 + 1) == root_of(0, N0 + 2)
    b_wrong = ballot("wrong-root", e, 0, "ada", N0, [(3, [1]), (4, [2]), (2, [0])], zero4)
    p_wrong = prove("wrong-root", "ada", e, b_wrong, tree_step=N0 - 1)
    fixed_scope = b1.scope_field(e["definitionHash"], 0, root_of(0, N0))
    b_fixed = ballot("fixed-scope", e, 0, "dan", N0, [(3, [0]), (4, [0]), (2, [1])], zero4, nul=pos(fixed_scope, r5.SECRETS["dan"]))
    p_fixed = prove("fixed-scope", "dan", e, b_fixed, scope=fixed_scope)

    # Validity failures behind a valid membership proof: a vote of 2 for
    # flat option 4, three of question 1's options where it allows two, and
    # proofs made over version 4's statement (T-31).
    two = b3.flat([(3, []), (4, []), (2, [1])])
    two[4] = 2
    b_two = ballot("vote-of-two", e, 0, "cleo", N0 + 1, None, zero4, votes=two)
    p_two = prove("vote-of-two", "cleo", e, b_two)
    b_over = ballot("question-1-over", e, 0, "eve", N0 + 2, [(3, []), (4, [0, 1, 2]), (2, [0])], zero4)
    p_over = prove("question-1-over", "eve", e, b_over)
    b_v4 = ballot("statement-version-4", e, 0, "dan", N0, [(3, [0]), (4, [1]), (2, [0])], zero4, version=4)
    p_v4 = prove("statement-version-4", "dan", e, b_v4)

    bundle(
        "board",
        "A sealed rolling poll without an author panel (pick one of three, pick up to two of four, pick exactly one of two); seat 4 sends nothing, so seats 1 to 3 are registered. On the board path: the transcript, five admitted ballots (a member who joined during the poll at step N0, an opening member at N0 − 1 and her re-vote at N0 + 1, tier 2's member in cell 1, a member added during the poll at the step whose boundary is closes_at), a ballot of each admission failure (another election's, cell 2, an author half the poll has no panel for, a share hash at seat 4, steps before registration, after close, with no live member and 2³² − 1, a step relabelled, a step relabelled to one with the same root, a proof against another step's root, a fixed poll's scope, a vote of 2, question 1 over its maximum, version 4's statement), two records that don't decode, a byte-identical repeat of the first ballot and a copy with its proof negated.",
        [
            t,
            item(b_dan, p_dan),
            item(b_ada, p_ada),
            item(b_tess, p_tess),
            item(b_rev, p_rev),
            item(b_eve, p_eve),
            item(b_stray, p_stray),
            item(dict(b_dan, cell=2), p_dan),
            item(b_author, p_dan),
            item(b_unq, p_unq),
            item(b_early, p_early),
            item(b_late, p_late),
            item(dict(b_tess, step=N0 + 1), p_tess),
            item(dict(b_dan, step=2**32 - 1), p_dan),
            item(dict(b_dan, step=N0 + 1), p_dan),
            item(dict(b_rev, step=N0 + 2), p_rev),
            item(b_wrong, p_wrong),
            item(b_fixed, p_fixed),
            item(b_two, p_two),
            item(b_over, p_over),
            item(b_v4, p_v4),
            item(b_dan, p_dan, how="trailing"),
            item(b_dan, p_dan, how="version-4"),
            item(b_dan, p_dan),
            item(b_dan, p_dan, how="negated"),
        ],
    )
    bundle(
        "rolling-path",
        "The same poll's ballots by the board's RollingBallotSubmitted (contract-event version 13), each with the root its submitter supplied: step N0's ballot with step N0's root (admitted), step N0 − 1's with step N0's root (root-step-mismatch), the re-vote at N0 + 1 with step N0 + 2's root, the same tree's (admitted: the supplied root is compared with the step's root, not its number), a board-path copy of the first (a repeat), tier 2's ballot boarded after close (window-after-close), a step before registration (root-step-range, before the supplied root is read), a relabelled step with that step's own root (membership-proof), the close step's ballot at closes_at (admitted) and a second event of the first ballot (a repeat).",
        [
            t,
            item(b_dan, p_dan, "rolling", root=root_of(0, N0), time=T0 + 40),
            item(b_ada, p_ada, "rolling", root=root_of(0, N0), time=T0 + 41),
            item(b_rev, p_rev, "rolling", root=root_of(0, N0 + 2), time=tau(N0 + 1) + 12),
            item(b_dan, p_dan),
            item(b_tess, p_tess, "rolling", root=root_of(1, N0), time=r5.CLOSES_AT + 1),
            item(b_early, p_early, "rolling", root=root_of(0, N0), time=T0 + 42),
            item(dict(b_dan, step=N0 + 1), p_dan, "rolling", root=root_of(0, N0 + 1), time=T0 + 43),
            item(b_eve, p_eve, "rolling", root=root_of(0, N0 + 3), time=r5.CLOSES_AT),
            item(b_dan, p_dan, "rolling", root=root_of(0, N0), time=T0 + 44),
        ],
    )
    bundle(
        "relayed-rolling-path",
        "Ballots by the board's RelayedRollingBallotSubmitted beside the board path: step N0 − 1's ballot with step N0's root is rejected (root-step-mismatch) before it could be set aside; tier 2's with its step's root passes 5.1 to 5.4 and is set aside until 4.5 proves its stamp, so 5.5 and 5.7 are unverifiable at it and a later copy of the board's first ballot is only a candidate repeat; another election's ballot is still rejected.",
        [
            t,
            item(b_dan, p_dan),
            item(b_ada, p_ada, "relayed-rolling", root=root_of(0, N0), time=T0 + 50),
            item(b_tess, p_tess, "relayed-rolling", root=root_of(1, N0), time=T0 + 51),
            item(b_dan, p_dan),
            item(b_stray, p_stray),
        ],
    )
    bundle("no-ballots", "The transcript and no ballot: 5.1 to 5.5 and 5.7 pass, with nothing admitted.", [t])
    return {"panel": panel, "definition": d, "election": e, "proofs": proofs, "checks": checks, "bundles": bundles, "eid": eid}


def rows_for(rejected, relayed):
    """5.1 to 5.5 and 5.7 from the rejected entries: each row fails at the first entry whose code is one of its own; a relayed ballot that passed 5.1 to 5.4 leaves 5.5 and 5.7 unverifiable at the first one."""

    def first(codes):
        x = next((x for x in rejected if x["code"] in codes), None)
        return outcome("pass") if x is None else outcome("fail", x["code"], {"entry": x["entry"]})

    rows = {r: first([c for c, rs in ROWS_OF.items() if r in rs]) for r in ADMISSION_ROWS}
    if relayed:
        rows["5.5"] = rows["5.7"] = outcome("unverifiable", "not-implemented", {"entry": relayed[0]})
    else:
        rows["5.5"] = first(vb.WINDOW_CODES)
        rows["5.7"] = first(("repeat",))
    return rows


def statements(constants, out):
    s = build(constants)
    pathlib.Path(out).write_text(json.dumps({"proofs": list(s["proofs"].values()), "checks": s["checks"]}, indent=2) + "\n")


def assemble(constants, proofs_path, out_dir):
    s = build(constants)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    proof_bytes = {k: bytes.fromhex(v) for k, v in got["proofs"].items()}
    verdicts = got["verdicts"]
    assert set(proof_bytes) == set(s["proofs"])
    d, e, panel, eid = s["definition"], s["election"], s["panel"], s["eid"]
    cases = []
    for bnd in s["bundles"]:
        payloads = []
        for i, p in enumerate(bnd["board"]):
            if isinstance(p, bytes):
                payloads.append(p)
                continue
            b, how = p["ballot"], p["how"]
            proof = vb.negated(proof_bytes[p["proof"]]) if how == "negated" else proof_bytes[p["proof"]]
            rec = r5.enc_ballot(dict(b, proof=proof))
            if how == "trailing":
                rec += b"\x00"
            elif how == "version-4":
                rec = rec[:2] + b"\x04" + rec[3:]
            if p["path"] == "board":
                payloads.append(rec)
                continue
            relayed = p["path"] == "relayed-rolling"
            payload = vb.rolling_event_record(d, {"record": rec, "root": p["root"]}, i, p["time"], EVENTS_VERSION, relayed=relayed)
            # The event check passes it as the board's own, carrying this record.
            assert vb.carried(d, payload, EVENTS_VERSION) == (rec, "relayed" if relayed else "ordinary", None if relayed else p["time"]), (bnd["id"], i)
            payloads.append(payload)
        entries = [vc.entry(vb.BOARD_VERSION, eid, i, 0, x) for i, x in enumerate(payloads)]
        ceremony_rows, ceremony = vc.expected(panel, d, entries, panel, vb.BOARD_VERSION)
        assert ceremony_rows["3.2"] == outcome("pass") and [x["index"] for x in ceremony["registered"]] == SEATS, bnd["id"]

        passed, rejected, relayed_at = [], [], []
        for i, p in enumerate(bnd["board"]):
            if isinstance(p, bytes):
                continue
            if p["how"] == "trailing":
                rejected.append({"entry": i, "code": "decode", "decodeError": "trailing-bytes"})
                continue
            if p["how"] == "version-4":
                rejected.append({"entry": i, "code": "decode", "decodeError": "profile-mismatch"})
                continue
            b = p["ballot"]
            verdict = verdicts.get(f"{bnd['id']}/{i}")
            assert (r5.verifier_signals(e, b) is None) == (verdict is None), (bnd["id"], i)
            result = admission(e, b, verdict, p["root"])
            code = result["code"]
            if code != "ok":
                r = {"entry": i, "code": code}
                for key in ("option", "question", "panel", "seat"):
                    if key in result:
                        r[key] = result[key]
                rejected.append(r)
                continue
            # A relayed ballot's window is its matched call's stamp, which
            # 4.5 must prove first: it is set aside (docs/spec/close.md, Window).
            if p["path"] == "relayed-rolling":
                relayed_at.append(i)
                continue
            late = vb.window(d, {"kind": "board", "segment": 0} if p["path"] == "board" else {"kind": "event", "time": p["time"]})
            if late is not None:
                rejected.append({"entry": i, "code": late})
                continue
            # Step 1 of revoting.md's Selection over the ballots 5.1 to 5.5
            # admit, in board order: (tier, ν, M), the tier the cell's; the
            # step never ranks.
            passed.append((i, (result["tier"], b["nullifier"], result["message"])))
        seen, repeats = set(), []
        for i, k in passed:
            if k in seen:
                repeats.append({"entry": i})
            seen.add(k)
        if relayed_at:
            # A relayed ballot set aside may be the copy that stands, so a
            # later copy is only a candidate repeat.
            ballots = {"admitted": len(passed), "rejected": sorted(rejected, key=lambda r: r["entry"]), "repeats": repeats}
        else:
            rejected = sorted(rejected + [{"entry": r["entry"], "code": "repeat"} for r in repeats], key=lambda r: r["entry"])
            ballots = {"admitted": len(passed) - len(repeats), "rejected": rejected, "repeats": []}
        rows = {"3.2": ceremony_rows["3.2"], **rows_for(ballots["rejected"], relayed_at)}
        cases.append(
            {
                "id": bnd["id"],
                "description": bnd["description"],
                "panel": "panel-4",
                "definition": vc.encode(d).hex(),
                "board": b"".join(entries).hex(),
                "expected": rows,
                "ballots": ballots,
            }
        )

    by = {c["id"]: c for c in cases}
    board = by["board"]["ballots"]
    assert board["admitted"] == 5 and {r["code"] for r in board["rejected"]} == set(ROWS_OF) - {"root-step-mismatch"} | {"decode", "repeat"}, board
    assert [r["entry"] for r in board["rejected"] if r["code"] == "root-step-range"] == [10, 11, 12, 13], board
    assert [r["entry"] for r in board["rejected"] if r["code"] == "membership-proof"] == [14, 15, 16, 17], board
    assert [r["entry"] for r in board["rejected"] if r["code"] == "repeat"] == [23, 24], board
    assert [(r["panel"], r["seat"]) for r in board["rejected"] if r["code"] == "share-hash-unqualified"] == [(1, 4)], board
    path = by["rolling-path"]["ballots"]
    assert path == {
        "admitted": 3,
        "rejected": [
            {"entry": 2, "code": "root-step-mismatch"},
            {"entry": 4, "code": "repeat"},
            {"entry": 5, "code": "window-after-close"},
            {"entry": 6, "code": "root-step-range"},
            {"entry": 7, "code": "membership-proof"},
            {"entry": 9, "code": "repeat"},
        ],
        "repeats": [],
    }, path
    relayed = by["relayed-rolling-path"]
    assert relayed["ballots"] == {"admitted": 2, "rejected": [{"entry": 2, "code": "root-step-mismatch"}, {"entry": 5, "code": "ballot-stray"}], "repeats": [{"entry": 4}]}, relayed
    assert relayed["expected"]["5.5"] == outcome("unverifiable", "not-implemented", {"entry": 3})
    assert by["no-ballots"]["ballots"] == {"admitted": 0, "rejected": [], "repeats": []}

    doc = {
        "format": "abolish-verifier-ballots-vectors/1",
        "title": "The verifier's ballot admission under a rolling definition (definition version 7, electorate_mode 2; ballot version 5): definitions, boards and pinned panels beside the group registry's events and the registration time, with the rows 3.2, 5.1 to 5.5 and 5.7 and the report's ballots",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-ballots-v5-vectors.py, from ballot-v5-records-vectors.py, verifier-ceremony-vectors.py, "
            "verifier-ballots-vectors.py and rolling-electorate-vectors.py (independent Python implementations; every step root is rebuilt "
            "there from the listed groups' events); membership proofs by packages/crypto/scripts/ballot-proofs.mjs, run outside the "
            "workspace with Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5, whose groth16.verify gives every pairing "
            "verdict on the signals derived here from each record"
        ),
        "clock": {k: str(v) for k, v in vb.CLOCK.items()},
        "panels": {"panel-4": {"threshold": str(panel["k"]), "keys": [k.hex() for k in panel["keys"]]}},
        "events": [
            {
                "block": str(ev["block"]),
                "timestamp": str(ev["timestamp"]),
                "group": str(ev["group"]),
                **({"add": [str(v) for v in ev["add"]]} if "add" in ev else {"remove": [str(i) for i in ev["remove"]]}),
            }
            for ev in r5.EVENTS
        ],
        "registeredAt": str(r5.REGISTERED_AT),
        "cases": cases,
    }
    out = pathlib.Path(out_dir, "verifier-ballots-v5.json")
    out.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {out}: {len(cases)} cases")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements" and len(sys.argv) == 4:
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble" and len(sys.argv) == 5:
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: verifier-ballots-v5-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
