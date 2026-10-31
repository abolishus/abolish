#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-ballots-v5-tier0.json.

A live rolling poll whose only tier is Tier 0 (definition version 7,
`electorate_mode` 2, `results_mode` live; ballot version 5), so that 2.4 can
recount it and a verifier builds its chain from the group registry's records
alone (docs/spec/verifier.md, Electorate, The rolling chain): the definition,
a board copy under board-entry version 6 and the panel a bundle pins, beside
the group registry's events and the definition's registration time, with the
rows 3.2, 5.1 to 5.5 and 5.7 a verifier reports over a proven chain
(`expected`) and over the archive's word, as a run reports them until P1-19
checks the archive's output roots (`archived`; verifier.md, Electorate, The
rolling chain, From the archive, step 3), and the report's `ballots`.
verifier-ballots-v5.json's poll lists a Tier 2 tier too, which 2.4 can't
recount, so no run builds a chain for it; this one's can, end to end through
`verifyBundle` (P2-17 part 4d-2b-2b-2b-2b-2b-2a).

The definition is on group-registry.json's registry and chain, whose test
registrars sign the events as a test logs them, and is live: releases every
24 periods of at least the smallest batch, pinning tally-opening version 2
and board-entry version 6, which carries running openings (docs/spec/
board.md, Allowed payloads). Every ballot proves membership of its step's
tree under the definition's hash and Tier 0's rolling scope.

A second expectation, `shortEvents`, is the same board judged against the
events less the last addition (eve's, after step N0's boundary, before the
close), as an archive whose evidence record falsely claims completeness past
the close would give them, which only an archive forging its output root can
do until P1-19 checks them on L1 (T-71, T-53): eve's ballot and the re-vote
at N0 + 1 fail their
membership checks there, since each proves membership of a step tree with
eve in it, which the chain doesn't have. snarkjs gives the verdict on each
signal set.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ballots-v5-vectors.py
(admission in order and the rows), ballot-v5-records-vectors.py (the
version-5 record, its hashes, the step roots rebuilt from the listed groups'
events and the rolling scope, with its events and timing),
verifier-ceremony-vectors.py (transcripts, board entries and the ceremony
rows) and verifier-ballots-vectors.py (the anchoring clock and the close
rule's window).

Membership proofs need a Groth16 prover, so generation has three steps, as
for verifier-ballots-v5.json:

  python3 -I -B verifier-ballots-v5-tier0-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B verifier-ballots-v5-tier0-vectors.py assemble <constants> <work>/proofs.json <out-dir>

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


v5 = _load("verifier_ballots_v5_vectors", "verifier-ballots-v5-vectors.py")
r5, vc, vb = v5.r5, v5.vc, v5.vb
b1, b2, b3, b4, rv, mem, rev, tt, d6 = r5.b1, r5.b2, r5.b3, r5.b4, r5.rv, r5.mem, r5.rev, r5.tt, r5.d6
cv = vc.cv
H, ds = cv.H, cv.ds
outcome = vc.outcome

N0, T0, tau = r5.N0, r5.T0, r5.tau
SEATS = v5.SEATS

# docs/spec/board.md, Allowed payloads: version 6 is version 5's set and the
# running opening (0x0018), for live polls only.
RUNNING_OPENING_TYPE = 0x0018
BOARD_VERSION = 6
vc.ALLOWED[BOARD_VERSION] = vc.ALLOWED[5] | {RUNNING_OPENING_TYPE}

# A live rolling poll's profile (docs/spec/verifier.md, 2.3): the sealed
# rolling one's, with tally-opening version 2 and board-entry version 6.
PINS = [(t, {vc.TALLY_OPENING_TYPE: 2, vc.BOARD_ENTRY_TYPE: BOARD_VERSION}.get(t, v)) for t, v in v5.PINS]
assert dict(PINS)[v5.BALLOT_TYPE] == 5 and dict(PINS)[vb.CONTRACT_EVENT_TYPE] == 13

# Releases every 24 periods, of at least the smallest batch (parameters.md).
LIVE = {"poll_class": d6.EVERYDAY, "results_mode": d6.LIVE, "live_every": 24, "live_batch": d6.MIN_LIVE_BATCH}

REGISTRY = json.loads((VECTORS / "group-registry.json").read_text())["domain"]

# Tier 0 alone: groups 1 and 2. Group 3 (another tier's) and group 7 are
# unlisted here, so their events are in the log but no tree.
TIERS = [(0, [r5.G1, r5.G2])]


def det(label):
    return hashlib.sha256(b"abolish verifier ballots v5 tier0 vectors " + label.encode()).digest()


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    b1.bjj_self_check()
    mem.self_check()
    pos = b1.Poseidon(constants)
    r5.POS = pos
    r5.EVENTS = r5.build_events()
    panel = cv.make_panel("panel-4", 3, 4)

    def opening(groups):
        leaves = rv.rolling_leaves(r5.EVENTS, groups, lambda ev: ev["block"] <= r5.ROOT_L2_BLOCK)
        return tt.root_of(pos.z, tt.levels(pos.c, pos.m, pos.z, leaves)), rv.member_count(leaves)

    rolling = []
    for tier, groups in TIERS:
        root, size = opening(groups)
        rolling.append({"tier": tier, "root_l2_block": r5.ROOT_L2_BLOCK, "groups": groups, "root": root, "group_size": size})

    fields = rv.variant(
        rv.TYPICAL,
        profile={"protocol_major": 1, "pins": PINS},
        election_id=det("election"),
        l2_chain_id=REGISTRY["chainId"],
        group_registry=bytes.fromhex(REGISTRY["verifyingContract"]),
        questions=[d6.d5.q(*x) for x in r5.QUESTIONS],
        rolling_electorate=rolling,
        membership_vk_hash=v5.MEMBERSHIP_VK_HASH,
        opens_at=r5.REGISTERED_AT + 60,
        closes_at=r5.CLOSES_AT,
        **LIVE,
        **d6.NO_AUTHOR,
    )
    ctx = vc.election_of(vc.definition_for(panel, bytes(32), fields))
    t = vc.transcript("verifier-ballots-v5-tier0/live", panel, SEATS, ctx)
    d = vc.definition_for(panel, H(ds(vc.TRANSCRIPT_TAG, t)), fields)
    assert vc.own_version(d) == 7 and d["electorate_mode"] == rv.ROLLING and d["results_mode"] == d6.LIVE
    enc = vc.encode(d)
    e = dict(
        r5.rules(r5.QUESTIONS, d["threshold"], d["panel_size"], 0, 0),
        label="live",
        definition=d,
        encoding=enc,
        definitionHash=H(ds(r5.b3.DEFINITION_TAG, enc)),
        cells=[{"tier": x["tier"], "groups": x["groups"]} for x in rolling],
        registeredAt=r5.REGISTERED_AT,
        closesAt=r5.CLOSES_AT,
    )
    proofs = {}

    def ballot(label, who, step, answers):
        """`who`'s ballot in cell 0 at `step`, with its nullifier under Tier 0's rolling scope."""
        ctx = {"definitionHash": e["definitionHash"], "cell": 0, "nullifier": pos(r5.rolling_scope_field(e["definitionHash"], 0), r5.SECRETS[who])}
        vote, _, _, _ = b4.make_ballot(
            "verifier-ballots-v5-tier0/" + label,
            e,
            ctx,
            b3.flat(answers),
            version=5,
            share_hashes=[det("share 1"), det("share 2"), det("share 3"), bytes(32)],
            author_share_hashes=[],
        )
        r = (21_000_000 + int.from_bytes(det("ref " + label)[:2], "big"), det("ref hash " + label))
        return dict(ctx, step=step, l1RefNumber=r[0], l1RefHash=r[1], vote=vote, committedVote=b4.enc_committed_vote(vote))

    def prove(pid, who, b, tree_step=None):
        """A witness proving `who`'s live leaf in the step tree of `b`'s cell (at `tree_step`, else `b`'s own step), for M over `b`'s ballot hash."""
        step = r5.step_of(e, 0, b["step"] if tree_step is None else tree_step)
        s = r5.SECRETS[who]
        leaf = pos.commitment(s)
        i = step["leaves"].index(leaf)
        sib = tt.path_of(pos.z, step["levels"], i)
        root = b2.root_from_path(pos, leaf, i, sib)
        assert root == step["root"], pid
        sc = r5.rolling_scope_field(e["definitionHash"], 0)
        msg = rev.message(e["definitionHash"], 0, r5.ballot_hash(b), b["l1RefNumber"], b["l1RefHash"])
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

    def root_of(n):
        return r5.step_of(e, 0, n)["root"]

    # Honest ballots at steps the poll accepts: a member who joined during
    # the poll, an opening member at an older step and her re-vote at a newer
    # one, group 2's member, and a member added during the poll at the step
    # whose boundary is closes_at.
    b_dan = ballot("dan", "dan", N0, [(3, [1]), (4, [0, 3]), (2, [1])])
    b_ada = ballot("ada", "ada", N0 - 1, [(3, [0]), (4, []), (2, [0])])
    b_cleo = ballot("cleo", "cleo", N0, [(3, [2]), (4, [1]), (2, [0])])
    b_rev = ballot("ada-revote", "ada", N0 + 1, [(3, [2]), (4, [1]), (2, [1])])
    b_eve = ballot("eve-at-close", "eve", N0 + 3, [(3, [1]), (4, []), (2, [1])])
    # Rejections resting on the chain: a step before registration, a proof
    # against another step's root, and dan's ballot relabelled to the step
    # after eve's addition, whose tree has her.
    b_early = ballot("before-registration", "ada", N0 - 2, [(3, [0]), (4, []), (2, [0])])
    b_wrong = ballot("wrong-root", "ada", N0, [(3, [1]), (4, [2]), (2, [0])])
    assert root_of(N0 - 1) != root_of(N0) != root_of(N0 + 1)
    board = [
        t,
        (b_dan, prove("dan", "dan", b_dan)),
        (b_ada, prove("ada", "ada", b_ada)),
        (b_cleo, prove("cleo", "cleo", b_cleo)),
        (b_rev, prove("ada-revote", "ada", b_rev)),
        (b_eve, prove("eve-at-close", "eve", b_eve)),
        (b_early, prove("before-registration", "ada", b_early)),
        (b_wrong, prove("wrong-root", "ada", b_wrong, tree_step=N0 - 1)),
        (dict(b_dan, step=N0 + 1), "dan"),
        (b_dan, "dan"),
    ]
    # eve's addition is the log's last event, after step N0's boundary and
    # before N0 + 1's, so the steps from N0 + 1 have her and N0's doesn't.
    last = r5.EVENTS[-1]
    assert last["group"] == r5.G1 and last["add"] == [pos.commitment(r5.SECRETS["eve"])] and tau(N0) < last["timestamp"] <= tau(N0 + 1)
    return {"panel": panel, "definition": d, "election": e, "proofs": proofs, "board": board, "eid": d["election_id"]}


ROOT_CODES = ("root-step-range", "root-step-mismatch", "membership-proof")


def archived(rows, rejected):
    """The rows a run reports under a chain from the archive's replay (docs/spec/verifier.md, Electorate, The rolling chain, From the archive, step 3): a rejection a step root or the registration time decides leaves the rows its code fails unverifiable at the first such entry, and a row fails only through another code."""
    out = dict(rows)
    for row in ("5.1", "5.2", "5.3"):
        on = [r for r in rejected if row in v5.ROWS_OF.get(r["code"], ())]
        failing = [r for r in on if r["code"] not in ROOT_CODES]
        if failing:
            out[row] = outcome("fail", failing[0]["code"], {"entry": failing[0]["entry"]})
        elif on:
            out[row] = outcome("unverifiable", "not-implemented", {"entry": on[0]["entry"]})
    return out


def judged(s, events, verdicts=None):
    """The checks of each ballot's proof against `events`' step roots, or, given snarkjs's verdicts, the report's ballots and the rows."""
    e, saved = s["election"], r5.EVENTS
    r5.EVENTS = events
    try:
        checks, passed, rejected = [], [], []
        for i, p in enumerate(s["board"]):
            if isinstance(p, bytes):
                continue
            b, pid = p
            sig = r5.verifier_signals(e, b)
            key = f"{len(events)}/{i}"
            if sig is not None:
                checks.append({"case": key, "proof": pid, "signals": {k: str(v) for k, v in sig.items()}})
            if verdicts is None:
                continue
            verdict = verdicts.get(key)
            assert (sig is None) == (verdict is None), i
            result = v5.admission(e, b, verdict)
            if result["code"] != "ok":
                rejected.append({"entry": i, "code": result["code"]})
                continue
            late = vb.window(s["definition"], {"kind": "board", "segment": 0})
            if late is not None:
                rejected.append({"entry": i, "code": late})
                continue
            passed.append((i, (result["tier"], b["nullifier"], result["message"])))
        if verdicts is None:
            return checks
        seen, repeats = set(), []
        for i, k in passed:
            if k in seen:
                repeats.append({"entry": i, "code": "repeat"})
            seen.add(k)
        ballots = {"admitted": len(passed) - len(repeats), "rejected": sorted(rejected + repeats, key=lambda r: r["entry"]), "repeats": []}
        return ballots, v5.rows_for(ballots["rejected"], [])
    finally:
        r5.EVENTS = saved


def statements(constants, out):
    s = build(constants)
    checks = judged(s, r5.EVENTS) + judged(s, r5.EVENTS[:-1])
    pathlib.Path(out).write_text(json.dumps({"proofs": list(s["proofs"].values()), "checks": checks}, indent=2) + "\n")


def assemble(constants, proofs_path, out_dir):
    s = build(constants)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    proof_bytes = {k: bytes.fromhex(v) for k, v in got["proofs"].items()}
    assert set(proof_bytes) == set(s["proofs"])
    d, panel, eid = s["definition"], s["panel"], s["eid"]
    payloads = [p if isinstance(p, bytes) else r5.enc_ballot(dict(p[0], proof=proof_bytes[p[1]])) for p in s["board"]]
    entries = [vc.entry(BOARD_VERSION, eid, i, 0, x) for i, x in enumerate(payloads)]
    ceremony_rows, ceremony = vc.expected(panel, d, entries, panel, BOARD_VERSION)
    assert ceremony_rows["3.2"] == outcome("pass") and [x["index"] for x in ceremony["registered"]] == SEATS

    ballots, rows = judged(s, r5.EVENTS, got["verdicts"])
    assert ballots == {
        "admitted": 5,
        "rejected": [
            {"entry": 6, "code": "root-step-range"},
            {"entry": 7, "code": "membership-proof"},
            {"entry": 8, "code": "membership-proof"},
            {"entry": 9, "code": "repeat"},
        ],
        "repeats": [],
    }, ballots
    short, short_rows = judged(s, r5.EVENTS[:-1], got["verdicts"])
    # Without eve's addition her ballot and ada's re-vote, whose step's tree
    # has that addition, prove membership of trees the chain doesn't have.
    assert short == {
        "admitted": 3,
        "rejected": [
            {"entry": 4, "code": "membership-proof"},
            {"entry": 5, "code": "membership-proof"},
            {"entry": 6, "code": "root-step-range"},
            {"entry": 7, "code": "membership-proof"},
            {"entry": 8, "code": "membership-proof"},
            {"entry": 9, "code": "repeat"},
        ],
        "repeats": [],
    }, short

    def events(evs):
        return [
            {
                "block": str(ev["block"]),
                "timestamp": str(ev["timestamp"]),
                "group": str(ev["group"]),
                **({"add": [str(v) for v in ev["add"]]} if "add" in ev else {"remove": [str(i) for i in ev["remove"]]}),
            }
            for ev in evs
        ]

    doc = {
        "format": "abolish-verifier-ballots-vectors/1",
        "title": "The verifier's ballot admission under a live rolling definition whose only tier is Tier 0 (definition version 7, electorate_mode 2, results_mode live; ballot version 5): a definition, a board and its pinned panel beside the group registry's events and the registration time, with the rows 3.2, 5.1 to 5.5 and 5.7 and the report's ballots, against the whole log and against the log less its last addition",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-ballots-v5-tier0-vectors.py, from verifier-ballots-v5-vectors.py, ballot-v5-records-vectors.py, "
            "verifier-ceremony-vectors.py, verifier-ballots-vectors.py and rolling-electorate-vectors.py (independent Python implementations; "
            "every step root is rebuilt there from the listed groups' events); membership proofs by packages/crypto/scripts/ballot-proofs.mjs, "
            "run outside the workspace with Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5, whose groth16.verify gives every "
            "pairing verdict on the signals derived here from each record"
        ),
        "clock": {k: str(v) for k, v in vb.CLOCK.items()},
        "panels": {"panel-4": {"threshold": str(panel["k"]), "keys": [k.hex() for k in panel["keys"]]}},
        "events": events(r5.EVENTS),
        "registeredAt": str(r5.REGISTERED_AT),
        "case": {
            "id": "live-tier0",
            "description": "A live rolling poll without an author panel whose only tier is Tier 0 (groups 1 and 2); seat 4 sends nothing, so seats 1 to 3 are registered. On the board path: the transcript, five admitted ballots (a member who joined during the poll at step N0, an opening member at N0 − 1, group 2's member at N0, the opening member's re-vote at N0 + 1, a member added during the poll at the step whose boundary is closes_at), a step before registration, a proof against another step's root, the first ballot relabelled to N0 + 1, and a byte-identical repeat of the first ballot.",
            "panel": "panel-4",
            "definition": vc.encode(d).hex(),
            "definitionHash": s["election"]["definitionHash"].hex(),
            "board": b"".join(entries).hex(),
            "expected": {"3.2": ceremony_rows["3.2"], **rows},
            "archived": {"3.2": ceremony_rows["3.2"], **archived(rows, ballots["rejected"])},
            "ballots": ballots,
        },
        "shortEvents": {
            "description": "The same board judged against the events less the last one (eve's addition, before the close), as an archive whose evidence record falsely claims completeness past the close would give them: an archive forging its output root, possible only while no reader checks it on L1 (P1-19).",
            "events": len(r5.EVENTS) - 1,
            "expected": {"3.2": ceremony_rows["3.2"], **short_rows},
            "archived": {"3.2": ceremony_rows["3.2"], **archived(short_rows, short["rejected"])},
            "ballots": short,
        },
    }
    out = pathlib.Path(out_dir, "verifier-ballots-v5-tier0.json")
    out.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {out}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements" and len(sys.argv) == 4:
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble" and len(sys.argv) == 5:
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: verifier-ballots-v5-tier0-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
