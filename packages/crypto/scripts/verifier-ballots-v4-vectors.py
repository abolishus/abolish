#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-ballots-v4.json.

Elections for the verifier's ballot admission under definition version 6,
whose ballots (version 4) name their cell, carry one range proof per question
and split each vote into a default half and an author half (docs/spec/verifier.md,
Ballot admission; 5.1 to 5.5, 5.7): each is a definition, a board copy and the
panel a bundle pins, with the rows 1.3, 2.3, 3.2, 5.1 to 5.5, 5.7, 6.2 and 7.4
a verifier reports and the report's `ballots`. Every transcript is made for
the default panel's stub of the definition it is checked against, under
definition version 6, and every ballot proves membership of its cell's tree
under that definition's hash, so a verifier checks them with nothing but the
bundle.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ceremony-vectors.py
(transcripts, board entries and the ceremony rows; its encoders and rules are
given definition-v6-vectors.py's version 6 here), ballot-v4-records-vectors.py
(the version-4 record, its signals and its admission checks in order) and,
through it, ballot-v4-vectors.py (the committed vote with both halves),
ballot-v3-vectors.py (the flat answers) and ballot-v2-vectors.py (the
regional electorate with its cell trees by the first-occurrence rule).

Membership proofs need a Groth16 prover, so generation has three steps, as
for verifier-ballots-v3.json:

  python3 -I -B verifier-ballots-v4-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B verifier-ballots-v4-vectors.py assemble <constants> <work>/proofs.json <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json
and ballot-proofs.mjs runs outside the workspace (see its header). Every value
but the proofs is deterministic from fixed labels (test data, never keys);
Groth16 proving is randomised, so the committed file is the record. Then
`vp check --fix` formats it.
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


r4 = _load("ballot_v4_records_vectors", "ballot-v4-records-vectors.py")
vc = _load("verifier_ceremony_vectors", "verifier-ceremony-vectors.py")
# The anchoring clock and the close rule's window (5.5) are verifier-ballots-vectors.py's.
vb = _load("verifier_ballots_vectors", "verifier-ballots-vectors.py")
b1, b2, b3, b4, mem, rev, d6 = r4.b1, r4.b2, r4.b3, r4.b4, r4.mem, r4.rev, r4.d6
cv = vc.cv

# verifier-ceremony-vectors.py reads definition versions 1 to 5; version 6's
# layout and rules are definition-v6-vectors.py's. The default panel's stub
# is the whole definition with `ceremony_transcript_hash` zeroed, which
# keeps `author_transcript_hash` (election-definition.md, Author panel), as
# `vc.stub_hash` makes it.
vc.ENCODE[6] = d6.enc_definition_v6
vc.RULE[6] = d6.definition_rule

H, ds = cv.H, cv.ds
BALLOT_TYPE = 0x0002
SPOILED_OPENING_TYPE = 0x0003
TALLY_OPENING_TYPE = 0x0006
BOARD_ENTRY_TYPE = 0x0007
DISPLAY_TEXT_TYPE = 0x0009
MEMBERSHIP_VK_HASH = bytes.fromhex(json.loads((VECTORS / "membership-proof.json").read_text())["verificationKey"]["hash"])
DEFINITION_TAG = b"abolish/v1/election-definition"
# BN254's base field: negating a G1 or G2 point negates its y coordinate.
BN254_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583

outcome, NOT_REACHED, NOT_IMPLEMENTED = vc.outcome, vc.NOT_REACHED, vc.NOT_IMPLEMENTED
UNSUPPORTED = outcome("unverifiable", "unsupported-version", {})
COMBINATION_FAILS = outcome("fail", "profile-combination", {})

# docs/spec/verifier.md, Ballot admission: the rows each admission code
# fails, with `ballot-cell` in place of `ballot-tier` (versions 2 to 4).
ROWS_OF = {
    "ballot-stray": ("5.1",),
    "ballot-cell": ("5.1",),
    "membership-proof": ("5.1", "5.2", "5.3"),
    "validity-shape": ("5.4",),
    "share-hash-unqualified": ("5.4",),
    "option-proof": ("5.4",),
    "sum-proof": ("5.4",),
}
ADMISSION_ROWS = ("5.1", "5.2", "5.3", "5.4")

# Pick one of three, pick up to two of four, pick exactly one of two
# (ballot-v4-records-vectors.py's questions).
QUESTIONS = r4.QUESTIONS


def det(label):
    return hashlib.sha256(b"abolish verifier ballots v4 vectors " + label.encode()).digest()


def pins_for(ballot=4, opening=3):
    """A version-6 profile: board-entry version 5, contract-event version 7 (close.md, Version), display-text version 2, tally-opening version 1, and the given ballot and spoiled-opening pins."""
    own = {1: 6, BALLOT_TYPE: ballot, SPOILED_OPENING_TYPE: opening, BOARD_ENTRY_TYPE: vb.BOARD_VERSION, vb.CONTRACT_EVENT_TYPE: 7, DISPLAY_TEXT_TYPE: 2}
    return {"protocol_major": 1, "pins": [(t, own.get(t, 1)) for t in range(1, 10)]}


def combination(d):
    """2.3 under definition version 6 (docs/spec/verifier.md, 2.3), from the spec's text, for the pins these cases use: a sealed poll without an author panel fits with display-text 2, ballot 4, spoiled-ballot opening 3, tally-opening 1, board-entry 5 and contract-event 7 (and, fitting, 2.3 is unverifiable with `not-implemented`, as under every version); a live poll or an author panel fails whatever it pins; a ballot version this verifier doesn't read is unsupported once nothing else fails; any other pin fails."""
    pins = dict(d["profile"]["pins"])
    if d["results_mode"] != d6.SEALED or d["author_keys"]:
        return COMBINATION_FAILS
    if pins[BALLOT_TYPE] not in (1, 2, 3, 4):
        return UNSUPPORTED
    wanted = {DISPLAY_TEXT_TYPE: 2, BALLOT_TYPE: 4, SPOILED_OPENING_TYPE: 3, TALLY_OPENING_TYPE: 1, BOARD_ENTRY_TYPE: 5, vb.CONTRACT_EVENT_TYPE: 7}
    if any(pins[t] != v for t, v in wanted.items()):
        return COMBINATION_FAILS
    return NOT_IMPLEMENTED


def negated(proof):
    """(−A, −B, C): another valid Groth16 proof of the same statement, made without the witness (docs/spec/membership.md, Proof encoding)."""
    words = [int.from_bytes(proof[i : i + 32], "big") for i in range(0, len(proof), 32)]
    for i in (1, 4, 5):
        words[i] = (BN254_P - words[i]) % BN254_P
    return b"".join(w.to_bytes(32, "big") for w in words)


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    b1.bjj_self_check()
    mem.self_check()
    pos = b1.Poseidon(constants)
    secrets, groups, tiers = b2.build_electorate(pos)
    t0, t2 = tiers
    assert [c["regions"] for c in t0["cells"]] == [[0], [1, 2]] and [c["regions"] for c in t2["cells"]] == [[0]]
    cells = t0["cells"] + t2["cells"]

    electorate = [
        {
            "tier": t["tier"],
            "root_l2_block": 1000,
            "groups": [{"group_id": g["group_id"], "region": g["region"]} for g in t["groups"]],
            "regions": t["regions"],
            "cells": [{"root": c["root"], "members": c["members"]} for c in t["cells"]],
        }
        for t in tiers
    ]
    panels = {"panel-4": cv.make_panel("panel-4", 3, 4)}
    base = dict(
        copy.deepcopy(d6.TYPICAL),
        electorate=electorate,
        membership_vk_hash=MEMBERSHIP_VK_HASH,
        questions=[d6.d5.q(*x) for x in QUESTIONS],
        **d6.SEALED_EVERYDAY,
        **d6.NO_AUTHOR,
    )
    eid = base["election_id"]
    proofs, checks, bundles = {}, [], []

    def election_for(label, seats, cheat=None, **changes):
        """A version-6 definition for the panel and its transcript, made for the definition's own default stub."""
        panel = panels["panel-4"]
        fields = dict(copy.deepcopy(base))
        fields.update(changes)
        ctx = vc.election_of(vc.definition_for(panel, bytes(32), fields))
        t = vc.transcript(f"verifier-ballots-v4/{label}", panel, seats, ctx, cheat)
        d = vc.definition_for(panel, H(ds(vc.TRANSCRIPT_TAG, t)), fields)
        assert vc.own_version(d) == 6
        h = H(ds(DEFINITION_TAG, vc.encode(d)))
        e = dict(
            r4.rules(
                [(q["option_count"], q["min_selections"], q["max_selections"]) for q in d["questions"]],
                d["threshold"],
                d["panel_size"],
                d["author_threshold"],
                len(d["author_keys"]),
            ),
            label=label,
            definitionHash=h,
            cells=[dict(c, root=r["root"]) for c, r in zip(cells, [c for t in d["electorate"] for c in t["cells"]])],
        )
        return d, t, e

    def where(label, cell):
        """The member's leaf index in `cell`'s tree: its group's offset plus its index there."""
        c = cells[cell]
        for g in groups:
            if g["group_id"] in c["offsets"]:
                for i, (kind, lab) in enumerate(g["members"]):
                    if kind == "real" and lab == label:
                        return c["offsets"][g["group_id"]] + i
        raise KeyError((label, cell))

    def scope(e, cell):
        c = cells[cell]
        return b1.scope_field(e["definitionHash"], c["tier"], c["root"])

    def nullifier(label, e, cell):
        return pos(scope(e, cell), secrets[label])

    def ref(label):
        return (21_000_000 + int.from_bytes(det("ref " + label)[:2], "big"), det("ref hash " + label))

    def ballot(label, e, cell, nul, answers, share_hashes, author_share_hashes=(), vote_rules=None, votes=None):
        """A ballot of `answers` (per question, the option count and the options picked), or of the flat `votes` as given."""
        ctx = {"definitionHash": e["definitionHash"], "cell": cell, "nullifier": nul}
        flat = votes if votes is not None else b3.flat(answers)
        vote, _, _, _ = b4.make_ballot(
            "verifier-ballot-v4/" + e["label"] + "/" + label,
            vote_rules or e,
            ctx,
            flat,
            share_hashes=share_hashes,
            author_share_hashes=list(author_share_hashes),
        )
        r = ref(e["label"] + "/" + label)
        return {
            "definitionHash": e["definitionHash"],
            "cell": cell,
            "nullifier": nul,
            "l1RefNumber": r[0],
            "l1RefHash": r[1],
            "vote": vote,
            "committedVote": b4.enc_committed_vote(vote),
        }

    def prove(pid, label, e, cell, b):
        """A witness proving `label`'s leaf in `cell`'s tree, for `b`'s M under the tier of the cell `b` names."""
        c = cells[cell]
        s = secrets[label]
        i = where(label, cell)
        sib = c["path"](i)
        sc = scope(e, cell)
        named = cells[b["cell"]]["tier"] if b["cell"] < len(cells) else c["tier"]
        msg = rev.message(e["definitionHash"], named, r4.bh_of(b), b["l1RefNumber"], b["l1RefHash"])
        root = b2.root_from_path(pos, pos.commitment(s), i, sib)
        assert root == c["root"], pid
        proofs[pid] = {
            "id": pid,
            "witness": {
                "secret": str(s),
                "merkleProofLength": b2.DEPTH,
                "merkleProofIndex": i,
                "merkleProofSiblings": [str(x) for x in sib],
                "message": str(mem.field_map(msg)),
                "scope": str(sc),
            },
            "expect": {"root": str(root), "nullifier": str(pos(sc, s))},
        }
        return pid

    def bundle(bid, description, d, t, e, registered, payloads, expect, ceremony_row=None):
        """`payloads` is the board in order: a transcript's bytes, (ballot, proof id), or (how, ballot, proof id) with `how` "negated" (the proof re-randomised) or a way of making the record undecodable. `ceremony_row` overrides 3.2 where verifier-ceremony-vectors.py's model doesn't reach (an author panel)."""
        for i, p in enumerate(payloads):
            if isinstance(p, tuple) and (len(p) == 2 or p[0] == "negated"):
                b, pid = p[-2:]
                if pid is not None:
                    sig = r4.verifier_signals(e, b)
                    if sig is not None:
                        check = {"case": f"{bid}/{i}", "proof": pid, "signals": {k: str(v) for k, v in sig.items()}}
                        if len(p) == 3:
                            check["negate"] = True
                        checks.append(check)
        bundles.append(
            {"id": bid, "description": description, "definition": d, "transcript": t, "election": e, "registered": registered, "board": payloads, "expect": expect, "ceremonyRow": ceremony_row}
        )

    zero4 = [det("share 1"), det("share 2"), det("share 3"), bytes(32)]
    full4 = zero4[:3] + [det("share 4")]

    def honest(e):
        """One admitted ballot in each cell, and a re-vote answering every question again, each with its proof."""
        p = e["label"] + "/"
        b_a = ballot("cell-0", e, 0, nullifier("r0/1", e, 0), [(3, [1]), (4, [0, 3]), (2, [1])], zero4)
        b_r1 = ballot("remainder-region-1", e, 1, nullifier("r1/0", e, 1), [(3, [2]), (4, []), (2, [0])], zero4)
        b_t2 = ballot("tier-2", e, 2, nullifier("t2/2", e, 2), [(3, []), (4, []), (2, [1])], zero4)
        b_rev = ballot("revote", e, 0, nullifier("r0/1", e, 0), [(3, [0]), (4, [2]), (2, [0])], zero4)
        return {
            "cell-0": (b_a, prove(p + "cell-0", "r0/1", e, 0, b_a)),
            "remainder-region-1": (b_r1, prove(p + "remainder-region-1", "r1/0", e, 1, b_r1)),
            "tier-2": (b_t2, prove(p + "tier-2", "t2/2", e, 2, b_t2)),
            "revote": (b_rev, prove(p + "revote", "r0/1", e, 0, b_rev)),
        }

    # Definition version 6, a sealed everyday poll without an author panel,
    # pinning ballot version 4, spoiled-ballot opening version 3,
    # tally-opening version 1, display-text version 2, board-entry version 5
    # and contract-event version 7, so 2.3's combination passes. Seat 4 sends
    # nothing, so the registered key set is seats 1 to 3 and seat 4's share
    # hash must be zero.
    d, t, e = election_for("v6", [1, 2, 3], profile=pins_for())
    assert e["authorPanelSize"] == 0
    ok = honest(e)
    b_a, p_a = ok["cell-0"]
    b_r2 = ballot("remainder-region-2", e, 1, nullifier("r2/1", e, 1), [(3, [0]), (4, [1, 2]), (2, [1])], zero4)
    p_r2 = prove("v6/remainder-region-2", "r2/1", e, 1, b_r2)
    d_o, _, e_o = election_for("v6-other", [1, 2, 3], profile=pins_for(), election_id=det("other election"))
    assert e_o["definitionHash"] != e["definitionHash"]
    b_stray = ballot("stray", e_o, 0, nullifier("r0/0", e_o, 0), [(3, [0]), (4, []), (2, [0])], zero4)
    p_stray = prove("v6/stray", "r0/0", e_o, 0, b_stray)
    # The same flat width, but question 2 made as pick up to one: its range
    # proof has two branches where the election's has one.
    b_shape = ballot("shape", e, 0, nullifier("r0/0", e, 0), [(3, [0]), (4, []), (2, [0])], zero4, vote_rules=r4.rules([(3, 0, 1), (4, 0, 2), (2, 0, 1)], 3, 4, 0, 0))
    # An author half (2 of 3) on a poll without an author panel: its shape
    # is the election's, never the ballot's (T-17, T-37).
    b_author = ballot(
        "author-half",
        e,
        0,
        nullifier("r0/0", e, 0),
        [(3, [0]), (4, []), (2, [0])],
        zero4,
        [det("author share 1"), det("author share 2"), bytes(32)],
        vote_rules=r4.rules(QUESTIONS, 3, 4, 2, 3),
    )
    b_unq = ballot("unqualified", e, 0, nullifier("r0/2", e, 0), [(3, [2]), (4, [3]), (2, [0])], full4)
    p_unq = prove("v6/unqualified", "r0/2", e, 0, b_unq)
    # A cell 0 member's proof under cell 0's root and scope, on a ballot
    # naming cell 1 of the same tier.
    b_oc = ballot("other-cell", e, 1, nullifier("r0/0", e, 0), [(3, [1]), (4, []), (2, [0])], zero4)
    p_oc = prove("v6/other-cell", "r0/0", e, 0, b_oc)
    moved_ref = dict(b_a, l1RefNumber=b_a["l1RefNumber"] + 1)
    # A vote of 2 at flat option 4, question 1's second option.
    two = b3.flat([(3, []), (4, []), (2, [1])])
    two[4] = 2
    b_two = ballot("vote-of-two", e, 1, nullifier("r2/0", e, 1), None, zero4, votes=two)
    p_two = prove("v6/vote-of-two", "r2/0", e, 1, b_two)
    # Three of question 1's options where it allows two.
    b_over = ballot("question-1-over", e, 1, nullifier("r2/0", e, 1), [(3, []), (4, [0, 1, 2]), (2, [0])], zero4)
    p_over = prove("v6/question-1-over", "r2/0", e, 1, b_over)
    # Question 2, pick exactly one, left blank: it can't be skipped.
    b_blank = ballot("question-2-blank", e, 2, nullifier("t2/0", e, 2), [(3, [0]), (4, [1]), (2, [])], zero4)
    p_blank = prove("v6/question-2-blank", "t2/0", e, 2, b_blank)
    bundle(
        "mixed",
        "Definition version 6 without an author panel (pick one of three, pick up to two of four, pick exactly one of two); seat 4 sends nothing, so seats 1 to 3 are registered. The board holds the transcript, an admitted ballot in each cell (both regions of the remainder), a ballot of each admission failure (another election's, cells 3 and 255, a range proof of the wrong shape, an author half the poll has no panel for, a share hash at seat 4, another cell's proof, a changed L1 reference, a vote of 2, question 1 over its maximum, question 2 under its minimum), two records that don't decode, a re-vote and a byte-identical repeat of the first ballot.",
        d, t, e, [1, 2, 3],
        [
            t,
            ok["cell-0"],
            ok["remainder-region-1"],
            (b_r2, p_r2),
            ok["tier-2"],
            (b_stray, p_stray),
            (dict(b_a, cell=3), p_a),
            (dict(b_a, cell=255), p_a),
            (b_shape, p_a),
            (b_author, p_a),
            (b_unq, p_unq),
            (b_oc, p_oc),
            (moved_ref, p_a),
            (b_two, p_two),
            (b_over, p_over),
            (b_blank, p_blank),
            ("trailing", b_a, p_a),
            ("version-3", b_a, p_a),
            ok["revote"],
            ok["cell-0"],
        ],
        "ballots",
    )
    bundle(
        "admitted",
        "Definition version 6 with only admitted ballots after the transcript: one in each cell and a re-vote. 5.1 to 5.5 and 5.7 pass, and so does 6.2, with no opening on the board; 7.4, whose check of the default half's tally comes later, is not implemented.",
        d, t, e, [1, 2, 3],
        [t, ok["cell-0"], ok["remainder-region-1"], ok["tier-2"], ok["revote"]],
        "ballots",
    )
    bundle(
        "repeats",
        "Copies of the cell 0 ballot: one with the tier 2 ballot's proof (rejected, so it makes no copy a repeat, R4), the original, a copy with its proof negated, the tier 2 ballot, a byte-identical copy and the re-vote (another M). 5.7 rejects the two copies after the original.",
        d, t, e, [1, 2, 3],
        [t, (b_a, ok["tier-2"][1]), ok["cell-0"], ("negated", b_a, p_a), ok["tier-2"], ok["cell-0"], ok["revote"]],
        "ballots",
    )
    bundle("no-ballots", "The transcript and no ballot: 5.1 to 5.5 and 5.7 pass, with nothing admitted.", d, t, e, [1, 2, 3], [t], "ballots")

    d_all, t_all, e_all = election_for("v6-every-seat", [1, 2, 3, 4], profile=pins_for())
    b_all = ballot("every-seat", e_all, 0, nullifier("r0/2", e_all, 0), [(3, [2]), (4, [3]), (2, [0])], full4)
    p_all = prove("v6-every-seat/every-seat", "r0/2", e_all, 0, b_all)
    bundle("every-seat", "Every seat registered: a share hash at seat 4 is admitted.", d_all, t_all, e_all, [1, 2, 3, 4], [t_all, (b_all, p_all)], "ballots")

    # Spoiled-ballot opening version 2 beside ballot version 4: 2.3 fails,
    # and, as under definition versions 1 and 3 to 5, admission still runs.
    d_o2, t_o2, e_o2 = election_for("v6-opening-2", [1, 2, 3], profile=pins_for(opening=2))
    ok_o2 = honest(e_o2)
    bundle(
        "opening-2",
        "Definition version 6 pinning spoiled-ballot opening version 2, which can't open version-4 cores: 2.3 fails profile-combination, admission still judges every ballot, and 6.2 is not reached.",
        d_o2, t_o2, e_o2, [1, 2, 3],
        [t_o2, ok_o2["cell-0"], ok_o2["tier-2"], (ok_o2["remainder-region-1"][0], ok_o2["cell-0"][1])],
        "ballots",
    )

    # A live poll: 2.3 fails it until the live release's checks exist
    # (P2-15 part 3), but its key set is registered, so admission runs.
    d_l, t_l, e_l = election_for("v6-live", [1, 2, 3], profile=pins_for(), results_mode=d6.LIVE, live_every=3600, live_batch=d6.MIN_LIVE_BATCH)
    ok_l = honest(e_l)
    bundle(
        "live",
        "A live version-6 poll: 2.3 fails profile-combination whatever it pins, and admission still judges every ballot.",
        d_l, t_l, e_l, [1, 2, 3],
        [t_l, ok_l["cell-0"], ok_l["tier-2"]],
        "ballots",
    )

    # An author panel: 3.2 is unverifiable beside it and no key set is
    # registered, since the author panel's own ceremony isn't read yet, so no
    # ballot is judged (T-37).
    d_ap, t_ap, e_ap = election_for(
        "v6-author-panel",
        [1, 2, 3],
        profile=pins_for(),
        author_threshold=2,
        author_keys=d6.AUTHOR_KEYS[:3],
        author_transcript_hash=det("author transcript"),
    )
    bundle(
        "author-panel",
        "A poll with an author panel of 2 of 3: 2.3 fails profile-combination, 3.2 is unverifiable beside the author panel and registers no key set, so 5.1 to 5.5 and 5.7 are not reached.",
        d_ap, t_ap, e_ap, None, [t_ap, (b_a, None)], "not-reached", NOT_IMPLEMENTED,
    )

    def two_bad(i, answers, *_):
        return [bytes(32)] * len(answers) if i in (3, 4) else answers

    d_qu, t_qu, e_qu = election_for("v6-quorum", [1, 2, 3, 4], cheat={"answers": two_bad}, profile=pins_for())
    bundle("quorum", "Seats 3 and 4 answer wrongly: no key set is registered, so no ballot is checked.", d_qu, t_qu, e_qu, None, [t_qu, (b_a, None)], "not-reached")

    d_vk, t_vk, e_vk = election_for("v6-other-key", [1, 2, 3], profile=pins_for(), membership_vk_hash=det("other key"))
    bundle("other-key", "Ballot version 4's proofs are checked under the same pinned key as versions 1 to 3's: a definition naming another fails 1.3, and no ballot is checked under it.", d_vk, t_vk, e_vk, [1, 2, 3], [t_vk, (b_a, None)], "not-reached")

    zero_root = copy.deepcopy(electorate)
    zero_root[1]["cells"][0]["root"] = 0
    d_z, t_z, e_z = election_for("v6-root-zero", [1, 2, 3], profile=pins_for(), electorate=zero_root)
    bundle("root-zero", "The definition gives tier 2's cell a root of 0, which anyone can prove membership of (T-04): no ballot is checked under it.", d_z, t_z, e_z, [1, 2, 3], [t_z, (b_a, None)], "not-reached")

    d_b1, t_b1, e_b1 = election_for("v6-ballot-1", [1, 2, 3], profile=pins_for(ballot=1, opening=1))
    bundle("ballot-v1", "Definition version 6 pinning ballot version 1, which names a tier and carries one range, beside opening version 1: 2.3 fails profile-combination, and no ballot or opening can be judged against the cells and questions.", d_b1, t_b1, e_b1, [1, 2, 3], [t_b1, (b_a, None)], "not-reached")

    d_b3, t_b3, e_b3 = election_for("v6-ballot-3", [1, 2, 3], profile=pins_for(ballot=3, opening=2))
    bundle("ballot-v3", "Definition version 6 pinning ballot version 3, which carries no author half: 2.3 fails profile-combination, and, as for any ballot version but the definition's own and version 1, 5.1 to 5.5, 5.7 and 6.2 are unsupported.", d_b3, t_b3, e_b3, [1, 2, 3], [t_b3, (b_a, None)], "unsupported")

    d_b5, t_b5, e_b5 = election_for("v6-ballot-5", [1, 2, 3], profile=pins_for(ballot=5))
    bundle("ballot-v5", "Definition version 6 pinning ballot version 5, which this release doesn't read: 2.3, 5.1 to 5.5, 5.7 and 6.2 are unsupported.", d_b5, t_b5, e_b5, [1, 2, 3], [t_b5, (b_a, None)], "unsupported")

    return {"panels": panels, "proofs": proofs, "checks": checks, "bundles": bundles, "eid": eid, "cells": cells}


def opening_row(d, admitted):
    """6.2 (docs/spec/verifier.md, Spoiled-ballot openings, step 1): unsupported under an opening version this verifier doesn't read (it reads 1 to 3) or a ballot version other than the definition's own (4) and version 1, as admission is; not reached under any other pins but ballot version 4 beside opening version 3, the one that opens version-4 cores (a profile 2.3 fails), or where admission doesn't run; otherwise it passes, since these boards carry no opening (verifier-openings-v3.json has them)."""
    pins = dict(d["profile"]["pins"])
    if pins[SPOILED_OPENING_TYPE] not in (1, 2, 3) or pins[BALLOT_TYPE] not in (4, 1):
        return UNSUPPORTED
    if pins[BALLOT_TYPE] != 4 or pins[SPOILED_OPENING_TYPE] != 3 or not admitted:
        return NOT_REACHED
    return outcome("pass")


def tally_row(d, registered):
    """7.4 (docs/spec/verifier.md, Tally openings, step 1): under tally-opening version 1 with a key set registered, not implemented under definition version 6, whose default half's tally this release doesn't read yet."""
    if dict(d["profile"]["pins"])[TALLY_OPENING_TYPE] != 1:
        return UNSUPPORTED
    return NOT_REACHED if registered is None else NOT_IMPLEMENTED


def rows_for(kind, rejected=()):
    """5.1 to 5.5 and 5.7. Each row fails at the first entry whose code is one of its own: 5.5's are the window's, 5.7's `repeat`."""
    if kind == "not-reached":
        return {r: NOT_REACHED for r in ADMISSION_ROWS + ("5.5", "5.7")}
    if kind == "unsupported":
        return {r: UNSUPPORTED for r in ADMISSION_ROWS + ("5.5", "5.7")}
    rows = {}

    def first(codes):
        x = next((x for x in rejected if x["code"] in codes), None)
        return outcome("pass") if x is None else outcome("fail", x["code"], {"entry": x["entry"]})

    for r in ADMISSION_ROWS:
        rows[r] = first([c for c, rs in ROWS_OF.items() if r in rs])
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
    eid = s["eid"]
    cases = []
    for bnd in s["bundles"]:
        d, t, e = bnd["definition"], bnd["transcript"], bnd["election"]
        payloads = []
        for p in bnd["board"]:
            if isinstance(p, bytes):
                payloads.append(("transcript", p, None))
                continue
            if len(p) == 3 and p[0] == "negated":
                _, b, pid = p
                payloads.append(("ballot", r4.enc_ballot(dict(b, proof=negated(proof_bytes[pid]))), b))
                continue
            if len(p) == 3:
                how, b, pid = p
                rec = r4.enc_ballot(dict(b, proof=proof_bytes[pid]))
                rec = rec + b"\x00" if how == "trailing" else r4.enc_ballot(dict(b, proof=proof_bytes[pid]), version=3)
                payloads.append((how, rec, b))
                continue
            b, pid = p
            # A ballot no membership check reaches carries some valid proof.
            proof = proof_bytes[pid] if pid is not None else next(iter(proof_bytes.values()))
            payloads.append(("ballot", r4.enc_ballot(dict(b, proof=proof)), b))
        entries = [vc.entry(vb.BOARD_VERSION, eid, i, 0, rec) for i, (_, rec, _) in enumerate(payloads)]
        panel = s["panels"]["panel-4"]
        ceremony_rows, ceremony = vc.expected(panel, d, entries, panel, vb.BOARD_VERSION)
        if bnd["ceremonyRow"] is not None:
            # The default run passes; beside an author panel 3.2 can't, and
            # registers nothing (Key ceremony, 3.2 note).
            assert ceremony_rows["3.2"] == outcome("pass"), bnd["id"]
            ceremony_rows = dict(ceremony_rows, **{"3.2": bnd["ceremonyRow"]})
        elif bnd["registered"] is not None:
            assert ceremony_rows["3.2"] == outcome("pass"), bnd["id"]
            assert [x["index"] for x in ceremony["registered"]] == bnd["registered"], bnd["id"]
        else:
            assert ceremony_rows["3.2"]["status"] == "fail", bnd["id"]
        pins = dict(d["profile"]["pins"])
        # 1.3: ballot versions 1 to 4 are proved under the one pinned key; a
        # later version may pin another (docs/spec/verifier.md, Procedure).
        vk_fails = pins[BALLOT_TYPE] in (1, 2, 3, 4) and d["membership_vk_hash"] != MEMBERSHIP_VK_HASH
        rows = {
            "1.3": outcome("fail", "membership-key", {}) if vk_fails else NOT_IMPLEMENTED,
            "2.3": combination(d),
            "3.2": ceremony_rows["3.2"],
        }
        ballots = None
        if bnd["expect"] == "ballots":
            admitted, rejected, repeats, firsts = [], [], [], set()
            for i, (kind, rec, b) in enumerate(payloads):
                if kind == "transcript":
                    continue
                if kind == "trailing":
                    rejected.append({"entry": i, "code": "decode", "decodeError": "trailing-bytes"})
                    continue
                if kind == "version-3":
                    assert rec[2] == 3
                    rejected.append({"entry": i, "code": "decode", "decodeError": "profile-mismatch"})
                    continue
                verdict = verdicts.get(f"{bnd['id']}/{i}")
                sig = r4.verifier_signals(e, b)
                # Without an author panel no author seat is registered.
                result = r4.admission(e, bnd["registered"], [], b, verdict)
                code = result["code"]
                assert verdict is not None or code not in ("ok", "option-proof", "sum-proof"), (bnd["id"], i)
                assert sig is not None or verdict is None, (bnd["id"], i)
                # Every ballot here is a board-path one in segment 0, and no
                # contract-event record carries one.
                assert pins[vb.CONTRACT_EVENT_TYPE] == 7
                late = vb.window(d, {"kind": "board", "segment": 0}) if code == "ok" else None
                if late is not None:
                    rejected.append({"entry": i, "code": late})
                elif code == "ok":
                    admitted.append(i)
                    # Step 1 of revoting.md's Selection over the ballots 5.1
                    # to 5.5 admit, in board order: (tier, ν, M), the tier the cell's.
                    k = (result["tier"], b["nullifier"], result["message"])
                    if k in firsts:
                        repeats.append({"entry": i})
                    firsts.add(k)
                else:
                    r = {"entry": i, "code": code}
                    if code == "option-proof":
                        r["option"] = result["option"]
                    elif code == "sum-proof":
                        r["question"] = result["question"]
                    elif code == "share-hash-unqualified":
                        r["panel"], r["seat"] = result["panel"], result["seat"]
                    rejected.append(r)
            # Every copy left passed 5.1 to 5.5, so a repeat is rejected (5.7).
            rejected = sorted(rejected + [{"entry": r["entry"], "code": "repeat"} for r in repeats], key=lambda r: r["entry"])
            admitted = [i for i in admitted if {"entry": i} not in repeats]
            rows.update(rows_for("ballots", rejected))
            ballots = {"admitted": len(admitted), "rejected": rejected, "repeats": []}
        else:
            rows.update(rows_for(bnd["expect"]))
        rows["6.2"] = opening_row(d, bnd["expect"] == "ballots")
        rows["7.4"] = tally_row(d, bnd["registered"])
        case = {
            "id": bnd["id"],
            "description": bnd["description"],
            "panel": "panel-4",
            "definition": vc.encode(d).hex(),
            "board": b"".join(entries).hex(),
            "expected": rows,
        }
        if ballots is not None:
            case["ballots"] = ballots
        cases.append(case)

    by = {c["id"]: c for c in cases}
    mixed = by["mixed"]["ballots"]
    assert {r["code"] for r in mixed["rejected"]} == set(ROWS_OF) | {"decode", "repeat"}, mixed
    assert mixed["admitted"] == 5 and {"entry": 19, "code": "repeat"} in mixed["rejected"], mixed
    assert [r["entry"] for r in mixed["rejected"] if r["code"] == "validity-shape"] == [8, 9], mixed
    assert [(r["panel"], r["seat"]) for r in mixed["rejected"] if r["code"] == "share-hash-unqualified"] == [(1, 4)], mixed
    assert [r.get("option") for r in mixed["rejected"] if r["code"] == "option-proof"] == [4], mixed
    assert [r.get("question") for r in mixed["rejected"] if r["code"] == "sum-proof"] == [1, 2], mixed
    assert by["admitted"]["ballots"] == {"admitted": 4, "rejected": [], "repeats": []}
    assert [r for r in by["repeats"]["ballots"]["rejected"] if r["code"] == "repeat"] == [{"entry": 3, "code": "repeat"}, {"entry": 5, "code": "repeat"}]
    assert by["every-seat"]["ballots"] == {"admitted": 1, "rejected": [], "repeats": []}
    assert by["admitted"]["expected"]["2.3"] == NOT_IMPLEMENTED
    assert by["opening-2"]["expected"]["2.3"] == COMBINATION_FAILS
    assert by["opening-2"]["ballots"]["rejected"] == [{"entry": 3, "code": "membership-proof"}]
    assert by["live"]["expected"]["2.3"] == COMBINATION_FAILS and by["live"]["ballots"]["admitted"] == 2
    assert by["author-panel"]["expected"]["2.3"] == COMBINATION_FAILS and by["author-panel"]["expected"]["5.1"] == NOT_REACHED
    assert by["other-key"]["expected"]["1.3"]["code"] == "membership-key"
    assert by["ballot-v1"]["expected"]["2.3"] == COMBINATION_FAILS
    assert by["ballot-v3"]["expected"]["2.3"] == COMBINATION_FAILS
    assert by["ballot-v5"]["expected"]["2.3"] == UNSUPPORTED
    assert by["quorum"]["expected"]["6.2"] == NOT_REACHED and by["ballot-v1"]["expected"]["6.2"] == NOT_REACHED
    assert by["admitted"]["expected"]["6.2"] == outcome("pass") and by["opening-2"]["expected"]["6.2"] == NOT_REACHED
    assert by["ballot-v5"]["expected"]["6.2"] == UNSUPPORTED
    assert by["quorum"]["expected"]["7.4"] == NOT_REACHED and by["admitted"]["expected"]["7.4"] == NOT_IMPLEMENTED

    doc = {
        "format": "abolish-verifier-ballots-vectors/1",
        "title": "The verifier's ballot admission under definition version 6 (ballot version 4): definitions, boards and pinned panels, with the rows 1.3, 2.3, 3.2, 5.1 to 5.5, 5.7, 6.2 and 7.4 and the report's ballots",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-ballots-v4-vectors.py, from verifier-ceremony-vectors.py, ballot-v4-records-vectors.py "
            "and definition-v6-vectors.py (independent Python implementations); membership proofs by packages/crypto/scripts/ballot-proofs.mjs, "
            "run outside the workspace with Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5, whose groth16.verify gives "
            "every pairing verdict on the signals derived here from each record"
        ),
        "clock": {k: str(v) for k, v in vb.CLOCK.items()},
        "panels": {name: {"threshold": str(p["k"]), "keys": [k.hex() for k in p["keys"]]} for name, p in s["panels"].items()},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-ballots-v4.json")
    path.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {path}: {len(cases)} cases")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: verifier-ballots-v4-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
