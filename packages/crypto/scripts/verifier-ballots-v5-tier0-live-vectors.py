#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-ballots-v5-tier0-live.json.

A live rolling poll whose only tier is Tier 0 (definition version 7,
`electorate_mode` 2, `results_mode` live; ballot version 5), sealed and long
enough for scheduled snapshots, so that a verifier's run through
`verifyBundle` chooses a release and checks its running openings (docs/spec/
verifier.md, Releases; tally.md, Live results; P2-17 part
4d-2b-2b-2b-2b-2b-3). verifier-ballots-v5-tier0-sealed.json's poll is
shorter than `live_every` periods, so its releases run over no snapshot.

The poll releases every anchoring period (`live_every` 1) in batches of at
least MIN_LIVE_BATCH, and spans three periods of a 3600-second clock: it
opens in period 1 and closes in period 3, so its scheduled snapshots are
σ_1 = 1 and σ_2 = 2 (tally.md, Schedule), and the decision at snapshot 2
chooses snapshot 1. Tier 0 is group 1: 38 members at opening and two who
join during the poll. The board holds

- in segment 0 the transcript;
- in segment 1 twenty opening members' ballots at step M, the first
  boundary after registration, each naming an L1 block in that period,
  followed by every registered seat's receipt for each: at snapshot 1's head
  `h_1` the step is final (`h_1` is ROOT_FINALITY or more after τ_M) and
  every one of them is admitted and fully receipted, so all twenty enter
  R_1 (tally.md, Running set); and, also in segment 1 with its receipts, a
  joiner's ballot at step M + 3, after the joiners' addition, naming a block
  below `h_1`, whose step isn't final at `h_1`: it is pending at snapshot 1,
  so it is held out of R_1 though admitted and fully receipted there, and
  enters R_2;
- in segment 2 the other eighteen opening members' ballots and the second
  joiner's, at step M + 6, naming a block above `h_1`, with their receipts:
  with the early joiner, twenty entries from R_1 to R_2, so snapshot 1 meets
  both the batch rule (twenty since R_0) and the lag (twenty after it);
- in segment 3 each registered seat's running opening of R_1 (record type
  0x0018), the release's;
- in segment 4 each registered seat's opening of the final tally under
  tally-opening version 2.

A run of L1 headers (`l1Blocks`, encoded as
verifier-ballots-v5-tier0-sealed-vectors.py encodes them) holds both
snapshots' heads, the blocks the ballots name and blocks past each
snapshot's end and past the close. The expected rows are the sealed
fixture's (admission, 5.8, 6.1, 5.9, 6.3, 7.1 to 7.6 pass; 8.5 is
`destruction-missing`), and the report's `releases` is computed by
live-verifier-vectors.py's model of the release rules from each ballot's
segment, L1 reference, step finality, receipts and votes, after this file
checks every opening's bytes: the running openings open R_1's aggregate,
under the running opening's tag, and the final tally's open the counted
set's. The final tally against the release has `d = 20`: the twenty
ballots that entered after it, none flagged. A verifier that read the early
joiner's step as final at `h_1` would put 21 in R_1.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: those
verifier-ballots-v5-tier0-sealed-vectors.py loads (the poll's rules,
admission, the step roots rebuilt from the events, the reference check and
the selection, receipts and the delivery check, tally openings), and
running-opening-vectors.py (the running opening's record and signature) and
live-verifier-vectors.py (snapshots, running sets, the release choice, the
openings' judgement and the final cut, which it computes three ways).

Membership proofs need a Groth16 prover, so generation has three steps, as
for verifier-ballots-v5-tier0-sealed.json:

  python3 -I -B verifier-ballots-v5-tier0-live-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B verifier-ballots-v5-tier0-live-vectors.py assemble <constants> <work>/proofs.json <out-dir>

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


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sv = _load("verifier_ballots_v5_tier0_sealed_vectors", "verifier-ballots-v5-tier0-sealed-vectors.py")
ro = _load("running_opening_vectors", "running-opening-vectors.py")
lv = _load("live_verifier_vectors", "live-verifier-vectors.py")
t0, dv2, tov, vo = sv.t0, sv.dv2, sv.tov, sv.vo
v5, r5, vc, vb, b3, b4 = sv.v5, sv.r5, sv.vc, sv.vb, sv.b3, sv.b4
cv, rev, mem, tt, tv, grp, iv4, dv = sv.cv, sv.rev, sv.mem, sv.tt, sv.tv, sv.grp, sv.iv4, sv.dv
b1, rv, d6 = r5.b1, r5.rv, r5.d6
H, ds, outcome, tau = cv.H, cv.ds, vc.outcome, r5.tau
L = grp.L
DEFAULT = dv2.DEFAULT
SEATS = t0.SEATS
BOARD_VERSION = t0.BOARD_VERSION
TALLY_OPENING_VERSION = 2
PERIOD = 3600
ROOT_FINALITY = 2400  # parameters.md
LABEL = "verifier-ballots-v5-tier0-live"
assert ro.L == L and ro.grp.L == L


def det(label):
    return hashlib.sha256(b"abolish verifier ballots v5 tier0 live vectors " + label.encode()).digest()


# --- The poll's timing --------------------------------------------------------------

# A step a week after verifier-ballots-v5-tier0.json's, and the clock's epoch
# a period before registration, so that opens_at is in period 1 and closes_at
# (τ_{M+12}, two hours after τ_M) in period 3.
M = r5.N0 + 1008
REGISTERED_AT = tau(M) - 100
EPOCH = REGISTERED_AT - PERIOD
OPENS_AT = REGISTERED_AT + 60
CLOSES_AT = tau(M + 12)
MID = M + 3  # an early joiner's step, half an hour after M
LATER = M + 6  # the second batch's step, an hour after M

G1 = r5.G1
ROOT_L2_BLOCK = 100
OPENING = [f"v{i:02d}" for i in range(38)]
JOINERS = ["j38", "j39"]
FIRST = OPENING[:20]
EARLY = JOINERS[0]
SECOND = OPENING[20:] + JOINERS[1:]

# Each batch's L1 reference, a minute after its step's boundary; each
# snapshot's head, the last block before its period ends (20 seconds before
# it), which is ROOT_FINALITY or more after its batch's step.
REF_1 = tau(M) + 60
REF_MID = tau(MID) + 60
HEAD_1 = EPOCH + 2 * PERIOD - 20
REF_2 = tau(LATER) + 60
HEAD_2 = EPOCH + 3 * PERIOD - 20


def answers(i):
    """Voter i's picks: one of three or none, one or two of four, exactly one of two (r5.QUESTIONS)."""
    q1 = [] if i % 4 == 3 else [i % 4]
    q2 = [i % 4] if i % 3 else [i % 4, (i + 1) % 4]
    return [(3, q1), (4, q2), (2, [i % 2])]


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    b1.bjj_self_check()
    mem.self_check()
    pos = b1.Poseidon(constants)
    r5.POS = pos
    c = r5.commitment
    r5.EVENTS = [
        {"block": 90, "timestamp": tau(M) - 2000, "group": G1, "add": [c(LABEL + "/" + x) for x in OPENING]},
        # The joiners, after τ_M and before τ_{M+6}: in step M + 6's tree, not M's.
        {"block": 300, "timestamp": tau(M) + 1800, "group": G1, "add": [c(LABEL + "/" + x) for x in JOINERS]},
    ]
    panel = cv.make_panel("panel-4", 3, 4)
    leaves = rv.rolling_leaves(r5.EVENTS, [G1], lambda ev: ev["block"] <= ROOT_L2_BLOCK)
    rolling = [
        {
            "tier": 0,
            "root_l2_block": ROOT_L2_BLOCK,
            "groups": [G1],
            "root": tt.root_of(pos.z, tt.levels(pos.c, pos.m, pos.z, leaves)),
            "group_size": rv.member_count(leaves),
        }
    ]
    assert rolling[0]["group_size"] == len(OPENING)
    fields = rv.variant(
        rv.TYPICAL,
        profile={"protocol_major": 1, "pins": t0.PINS},
        election_id=det("election"),
        l2_chain_id=t0.REGISTRY["chainId"],
        group_registry=bytes.fromhex(t0.REGISTRY["verifyingContract"]),
        questions=[d6.d5.q(*x) for x in r5.QUESTIONS],
        rolling_electorate=rolling,
        membership_vk_hash=v5.MEMBERSHIP_VK_HASH,
        opens_at=OPENS_AT,
        closes_at=CLOSES_AT,
        **dict(t0.LIVE, live_every=1),
        **d6.NO_AUTHOR,
    )
    ctx = vc.election_of(vc.definition_for(panel, bytes(32), fields))
    t = vc.transcript(LABEL + "/live", panel, SEATS, ctx)
    d = vc.definition_for(panel, H(ds(vc.TRANSCRIPT_TAG, t)), fields)
    assert vc.own_version(d) == 7 and d["electorate_mode"] == rv.ROLLING and d["results_mode"] == d6.LIVE
    assert d["live_every"] == 1 and d["live_batch"] == d6.MIN_LIVE_BATCH == len(FIRST) == len(SECOND) + 1
    enc = vc.encode(d)
    e = dict(
        r5.rules(r5.QUESTIONS, d["threshold"], d["panel_size"], 0, 0),
        label="live",
        definition=d,
        encoding=enc,
        definitionHash=H(ds(b3.DEFINITION_TAG, enc)),
        cells=[{"tier": 0, "groups": [G1]}],
        registeredAt=REGISTERED_AT,
        closesAt=CLOSES_AT,
    )
    defh = e["definitionHash"]
    sc = r5.rolling_scope_field(defh, 0)

    # A header an hour and a block before opening, each batch's reference,
    # each snapshot's head, the block at closes_at (the first after
    # snapshot 2's end) and one an hour and a block after close.
    headers = sv.run(sv.FIRST_BLOCK, [OPENS_AT - 3600 - 12, REF_1, REF_MID, HEAD_1, REF_2, HEAD_2, CLOSES_AT, CLOSES_AT + 3600 + 12])
    by_time = {h["timestamp"]: h for h in headers}

    ballots, proofs = [], {}
    voters = [(who, 1, M, REF_1) for who in FIRST] + [(EARLY, 1, MID, REF_MID)] + [(who, 2, LATER, REF_2) for who in SECOND]
    for n, (who, segment, step, ref_at) in enumerate(voters):
        ref = by_time[ref_at]
        secret = r5.SECRETS[LABEL + "/" + who]
        bctx = {"definitionHash": defh, "cell": 0, "nullifier": pos(sc, secret)}
        votes = b3.flat(answers(n))
        vote, randomness, _, _ = b4.make_ballot(
            LABEL + "/" + who,
            e,
            bctx,
            votes,
            version=5,
            share_hashes=[det(f"share {who} {i}") for i in SEATS] + [bytes(32)],
            author_share_hashes=[],
        )
        b = dict(bctx, step=step, l1RefNumber=ref["number"], l1RefHash=ref["hash"], vote=vote, committedVote=b4.enc_committed_vote(vote))
        assert r5.reference(b, ref["timestamp"]) == "ok", who
        # (v_j, r_j): the constant terms of the ballot's polynomials.
        pairs = [(v, int(p["g"][0])) for v, p in zip(votes, randomness["polynomials"])]
        assert all(grp.equal(tov.bv.pedersen(v, r), vss[0]) for (v, r), vss in zip(pairs, vote["vss"])), who
        st = r5.step_of(e, 0, step)
        assert st["accepted"]
        i = st["leaves"].index(pos.commitment(secret))
        msg = rev.message(defh, 0, r5.ballot_hash(b), b["l1RefNumber"], b["l1RefHash"])
        proofs[who] = {
            "id": who,
            "witness": {
                "secret": str(secret),
                "merkleProofLength": r5.DEPTH,
                "merkleProofIndex": i,
                "merkleProofSiblings": [str(x) for x in tt.path_of(pos.z, st["levels"], i)],
                "message": str(mem.field_map(msg)),
                "scope": str(sc),
            },
            "expect": {"root": str(st["root"]), "nullifier": str(b["nullifier"])},
        }
        ballots.append({"who": who, "ballot": b, "votes": votes, "pairs": pairs, "segment": segment})
    # Step M's tree lacks the joiners and M + 6's has them.
    assert r5.step_of(e, 0, M)["memberCount"] == len(OPENING) and r5.step_of(e, 0, LATER)["memberCount"] == len(OPENING) + len(JOINERS)
    return {"panel": panel, "definition": d, "election": e, "transcript": t, "headers": headers, "ballots": ballots, "proofs": proofs}


def checks_of(s):
    out = []
    for x in s["ballots"]:
        sig = r5.verifier_signals(s["election"], x["ballot"])
        assert sig is not None, x["who"]
        out.append({"case": "live/" + x["who"], "proof": x["who"], "signals": {k: str(v) for k, v in sig.items()}})
    return out


def statements(constants, out):
    s = build(constants)
    pathlib.Path(out).write_text(json.dumps({"proofs": list(s["proofs"].values()), "checks": checks_of(s)}, indent=2) + "\n")


def assemble(constants, proofs_path, out_dir):
    s = build(constants)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    proof_bytes = {k: bytes.fromhex(v) for k, v in got["proofs"].items()}
    assert set(proof_bytes) == set(s["proofs"])
    d, e, panel = s["definition"], s["election"], s["panel"]
    defh, eid = e["definitionHash"], d["election_id"]
    k, m = e["threshold"], e["optionTotal"]
    ballots, headers = s["ballots"], s["headers"]

    clock = {"epoch": EPOCH, "period": PERIOD, "deadline": 7200}
    seg_d, seg_k = dv.segments(EPOCH, PERIOD, CLOSES_AT, d["l1_inclusion_bound"])
    t_d, t_k = dv.deadlines(CLOSES_AT, d["l1_inclusion_bound"])
    floor = max(vo.floor_of(CLOSES_AT, clock), seg_k)
    clock["lastSegment"] = floor + 2
    s_open, s_close = (OPENS_AT - EPOCH) // PERIOD, (CLOSES_AT - EPOCH) // PERIOD
    assert (s_open, s_close) == (1, 3) and 3 <= seg_d < floor and 4 <= floor

    # Admission (5.1 to 5.5, 5.7) under this clock, with snarkjs's verdicts.
    saved = vb.CLOCK
    vb.CLOCK = clock
    try:
        for x in ballots:
            assert got["verdicts"]["live/" + x["who"]] is True
            result = v5.admission(e, x["ballot"], True)
            assert result["code"] == "ok", x["who"]
            assert vb.window(d, {"kind": "board", "segment": x["segment"]}) is None
            x["message"] = result["message"]
    finally:
        vb.CLOCK = saved

    # The board: the transcript; each batch's ballots, then their receipts;
    # the release's running openings; the final tally's openings.
    t = s["transcript"]
    checked = cv.check(panel, t, vc.election_of(d))
    assert checked["ok"] and [x["index"] for x in checked["registered"]] == SEATS
    secrets, signing, registered = {}, {}, {DEFAULT: {}, dv2.AUTHOR: {}}
    for x in checked["registered"]:
        i = x["index"]
        secrets[i] = cv.seat_secrets(LABEL + "/live", i)["signing"]
        assert cv.p256_key(secrets[i]).hex() == x["signingKey"], i
        signing[i] = bytes.fromhex(x["signingKey"])
        registered[DEFAULT][i] = {"signingKey": signing[i], "kem": None}

    def receipt(b, seat):
        bh = r5.ballot_hash(b)
        sh = b["vote"]["shareHashes"][seat - 1]
        return dv2.receipt_record(defh, bh, DEFAULT, seat, sh, iv4.sign(secrets[seat], iv4.statement(defh, bh, DEFAULT, seat, sh)))

    payloads = [(0, t)]
    for seg in (1, 2):
        batch = [x for x in ballots if x["segment"] == seg]
        for x in batch:
            x["entry"] = len(payloads)
            payloads.append((seg, r5.enc_ballot(dict(x["ballot"], proof=proof_bytes[x["who"]]))))
        for x in batch:
            x["receipts"] = []
            for seat in SEATS:
                x["receipts"].append(len(payloads))
                payloads.append((seg, receipt(x["ballot"], seat)))

    # 5.8: each reference against the run, the oldest block it may name
    # being the first an hour or less before opening.
    chain = {h["number"]: (h["hash"], h["timestamp"]) for h in headers}
    head = headers[-1]["number"]
    first = sv.FIRST_BLOCK
    low = rev.first_in_window({n - first: v for n, v in chain.items()}, 0, head - first, OPENS_AT) + first
    for x in ballots:
        b = x["ballot"]
        assert rev.check_reference(b["l1RefNumber"], b["l1RefHash"], chain, head, low, CLOSES_AT) == "admitted", x["who"]

    # 6.1 selects every ballot (one per nullifier); 5.9 counts every one.
    admitted = [{"tier": 0, "nullifier": x["ballot"]["nullifier"], "message": x["message"], "ref": x["ballot"]["l1RefNumber"], "index": x["entry"]} for x in ballots]
    chosen = rev.select(admitted)
    assert chosen == {"selected": [x["entry"] for x in ballots], "repeats": [], "ties": []}, chosen
    selected = [dict(x["ballot"], hash=r5.ballot_hash(x["ballot"])) for x in ballots]
    receipts = [("board", x["segment"], payloads[i][1]) for x in ballots for i in x["receipts"]]
    result = dv2.check_delivery(defh, registered, seg_d, seg_k, t_d, t_k, selected, receipts, hash_of=lambda b: b["hash"])
    assert all(x["counted"] for x in result["ballots"]) and not result["records"] and not result["rejected"]

    # The releases, by live-verifier-vectors.py's model: each ballot by its
    # entry, segment, L1 reference and the first block of the run at which
    # its step is final (tally.md, Running set, condition 1).
    def final_at(step):
        return min(h["number"] for h in headers if h["timestamp"] >= tau(step) + ROOT_FINALITY)

    snapshots = []
    for sigma in lv.snapshot_segments(EPOCH, PERIOD, OPENS_AT, CLOSES_AT, d["live_every"]):
        h = lv.l1_head(EPOCH, PERIOD, sigma, headers)
        assert h is not None
        snapshots.append({"segment": sigma, "head": h["number"], "hash": h["hash"]})
    assert [(x["segment"], x["head"]) for x in snapshots] == [(1, first + 3), (2, first + 5)]
    for x in ballots:
        # Each ballot's reference, judged with its first snapshot's head as
        # the L1 head, is admitted there: only step finality can hold one out.
        at = snapshots[x["segment"] - 1]["head"]
        b = x["ballot"]
        assert rev.check_reference(b["l1RefNumber"], b["l1RefHash"], chain, at, low, CLOSES_AT) == "admitted", x["who"]
        # The early joiner's step is final at snapshot 2's head and not at
        # snapshot 1's, so it is pending at snapshot 1 though boarded,
        # receipted and admitted there; every other ballot's step is final
        # at its first snapshot's head.
        final = final_at(b["step"])
        assert (final > snapshots[0]["head"] and final <= snapshots[1]["head"]) if x["who"] == EARLY else final <= at, x["who"]
    case = lv.base_case("live", "", {}, [{"segment": x["segment"], "head": x["head"]} for x in snapshots], [], batch=d["live_batch"])
    case.update(
        options=m,
        questions=[{"options": q["optionCount"], "min": q["min"], "max": q["max"]} for q in e["questions"]],
        finalHead=head,
        nullifiers={
            x["ballot"]["nullifier"]: {
                "tier": 0,
                "ballots": [
                    lv.ballot(
                        x["ballot"]["nullifier"],
                        segment=x["segment"],
                        ref=x["ballot"]["l1RefNumber"],
                        votes=x["votes"],
                        id=x["entry"],
                        message=x["message"].hex(),
                        stepFinalAt=final_at(x["ballot"]["step"]),
                        # The last segment holding one of its receipts.
                        receipted=max(payloads[i][0] for i in x["receipts"]),
                    )
                ],
            }
            for x in ballots
        },
    )
    sets = lv.running_sets(case)
    picks = lv.choose(case, sets)
    assert picks[0] == ([1], [{"at": 2, "release": 1, "refused": {}}]), picks
    released = [x for x in ballots if x["entry"] in set(sets[0][1].values())]
    assert released == [x for x in ballots if x["who"] in FIRST]

    def opening(signer, over, snapshot=None):
        """Seat `signer`'s honest opening of cell 0 over `over`: the release's running opening at `snapshot`, else the final tally's under tally-opening version 2."""
        agg = tv.aggregate(m, k, [x["ballot"]["vote"]["vss"] for x in over])
        values = [{"v": sum(x["pairs"][j][0] for x in over) % L, "r": sum(x["pairs"][j][1] for x in over) % L} for j in range(m)]
        assert tov.opens(agg, values) is None
        if snapshot is None:
            ah = tov.aggregate_hash(agg)
            sig = tov.sign(secrets[signer], tov.statement(defh, 0, ah, signer, values))
            return tov.encode({"definitionHash": defh, "cell": 0, "aggregateHash": ah, "signer": signer, "opening": values, "signature": sig}, version=TALLY_OPENING_VERSION)
        o = {"definitionHash": defh, "cell": 0, "snapshot": snapshot, "aggregateHash": ro.aggregate_hash(agg), "signer": signer, "opening": values}
        statement = ro.statement(o)
        o["signature"] = ro.sign(secrets[signer], statement)
        encoded = ro.encode(o)
        assert ro.decode(encoded)["opening"] == values
        return encoded, statement

    running = []
    for seat in SEATS:
        encoded, statement = opening(seat, released, snapshot=1)
        running.append({"entry": len(payloads), "cell": 0, "snapshot": 1, "signer": seat, "message": statement.hex()})
        payloads.append((3, encoded))
    first_opening = len(payloads)
    final = [opening(seat, ballots) for seat in SEATS]
    payloads += [(4, x) for x in final]
    assert 4 <= floor

    tally = tov.check_tally(defh, m, k, signing, [[x["ballot"]["vote"]["vss"] for x in ballots]], final, TALLY_OPENING_VERSION)
    assert tally["ok"], tally
    (cell,) = tally["cells"]
    counts = [str(c) for c in cell["counts"]]
    assert counts == [str(sum(x["votes"][j] for x in ballots)) for j in range(m)]

    case["openings"] = running
    model = lv.run(case)
    assert model["rows"] == {"7.5": {"status": "pass"}, "7.6": {"status": "pass"}}, model["rows"]
    want_release = [str(sum(x["votes"][j] for x in released)) for j in range(m)]
    (mcell,) = model["cells"]
    (rel,) = mcell["releases"]
    assert rel["counts"] == want_release and not rel["conflict"] and rel["size"] == rel["entered"] == len(FIRST)
    second = sorted(x["entry"] for x in ballots if x["who"] not in FIRST)
    assert mcell["finalBatch"] == {"cut": len(SECOND) + 1, "flagged": False, "side": {"kind": "unreleased", "release": None, "ballots": second}}, mcell["finalBatch"]
    (mtier,) = model["tiers"]

    entries = [vc.entry(BOARD_VERSION, eid, n, seg, p) for n, (seg, p) in enumerate(payloads)]
    assert [x for x, _ in payloads] == sorted(x for x, _ in payloads)
    ceremony_rows, _ = vc.expected(panel, d, entries, panel, BOARD_VERSION)
    assert ceremony_rows["3.2"] == outcome("pass")

    offsets = [q["optionCount"] for q in e["questions"]]
    by_question, j = [], 0
    for n in offsets:
        by_question.append(counts[j : j + n])
        j += n

    rows = {
        "3.2": ceremony_rows["3.2"],
        **{r: outcome("pass") for r in ("5.1", "5.2", "5.3", "5.4", "5.5", "5.7", "5.8", "6.1", "5.9")},
        # No close statement: the close is unchecked, and passes (close.md, Close check).
        "6.3": outcome("pass"),
        **{r: outcome("pass") for r in ("7.1", "7.2", "7.3", "7.4")},
        **model["rows"],
        # No seat states destruction (tally.md, Destruction checks).
        "8.5": outcome("fail", "destruction-missing", {"seat": SEATS[0]}),
    }

    def events(evs):
        return [{"block": str(ev["block"]), "timestamp": str(ev["timestamp"]), "group": str(ev["group"]), "add": [str(v) for v in ev["add"]]} for ev in evs]

    doc = {
        "format": "abolish-verifier-ballots-vectors/1",
        "title": "The verifier's releases under a live rolling definition whose only tier is Tier 0 (definition version 7, electorate_mode 2, results_mode live; ballot version 5): a sealed poll with two scheduled snapshots, forty honest ballots in two batches of live_batch, every registered seat's receipts, the release of snapshot 1 with each registered seat's running opening, and the final tally, with the rows and report a verifier gives",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-ballots-v5-tier0-live-vectors.py, from verifier-ballots-v5-tier0-sealed-vectors.py, "
            "running-opening-vectors.py, live-verifier-vectors.py and the modules they load (independent Python implementations; every step "
            "root is rebuilt there from the listed groups' events, every L1 header encoded there, and the release report computed by "
            "live-verifier-vectors.py's model); membership proofs by packages/crypto/scripts/ballot-proofs.mjs, run outside the workspace with "
            "Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5, whose groth16.verify gives every pairing verdict on the signals "
            "derived here from each record"
        ),
        "description": (
            "A live rolling poll (live_every 1, live_batch 20) opening in period 1 and closing in period 3, so with scheduled snapshots at "
            "segments 1 and 2. Tier 0 is group 1: 38 members at opening, two added during the poll. Segment 0: the transcript. Segment 1: "
            "twenty opening members' ballots at step M, naming a block before snapshot 1's head, at which M is final, and a joiner's at "
            "step M + 3, naming a block before that head, at which M + 3 isn't final yet, each with every registered seat's receipt: the "
            "joiner's is pending at snapshot 1, so held out of its running set. Segment 2: the other eighteen opening members' and the "
            "second joiner's ballots at step M + 6, naming a block above snapshot 1's head, with their receipts. The decision at snapshot 2 releases snapshot 1 (twenty entries since "
            "opening, twenty after, the early joiner among them); segment 3 holds each registered seat's running opening of it, segment 4 each registered seat's opening "
            "of the final tally over all forty. The final tally against the release has d = 20, the ballots that entered after it."
        ),
        "definition": vc.encode(d).hex(),
        "definitionHash": defh.hex(),
        "panel": {"threshold": str(panel["k"]), "keys": [x.hex() for x in panel["keys"]]},
        "events": events(r5.EVENTS),
        "registeredAt": str(REGISTERED_AT),
        "clock": {k_: str(v) for k_, v in clock.items()},
        "l1Blocks": [h["encoded"].hex() for h in headers],
        "board": b"".join(entries).hex(),
        "expected": rows,
        "ballots": {
            "admitted": len(ballots),
            "pending": [],
            "rejected": [],
            "repeats": [],
            "selected": [{"entry": i} for i in chosen["selected"]],
            "ties": [],
        },
        "delivery": {"excluded": [], "records": [], "rejected": []},
        "cells": [{"cell": 0, "tier": 0, "counted": len(ballots), "counts": counts, "byQuestion": by_question, "signers": SEATS}],
        "tallies": [{"entry": first_opening + n, "cell": 0, "signer": seat, "breaks": []} for n, seat in enumerate(SEATS)],
        "releases": {
            "snapshots": [{"snapshot": r + 1, "segment": x["segment"], "l1Head": {"number": str(x["head"]), "hash": x["hash"].hex()}} for r, x in enumerate(snapshots)],
            "tiers": [
                {
                    "tier": mtier["tier"],
                    "decisions": [{"at": x["at"], "release": x["release"], "refused": [{"snapshot": int(q), "rule": why} for q, why in x["refused"].items()]} for x in mtier["decisions"]],
                    "releases": mtier["releases"],
                }
            ],
            "cells": [
                {
                    "cell": mcell["cell"],
                    "tier": mcell["tier"],
                    "releases": [{"snapshot": x["snapshot"], "size": x["size"], "entered": x["entered"], "counts": x["counts"], "signers": x["signers"]} for x in mcell["releases"]],
                    "finalBatch": mcell["finalBatch"],
                }
            ],
            "openings": [
                {"entry": x["entry"], "cell": x["cell"], "snapshot": x["snapshot"], "signer": x["signer"], "kind": x["kind"], "passes": x["passes"], "breaks": x["breaks"], "blamed": x["blamed"]}
                for x in model["openings"]
            ],
        },
    }
    out = pathlib.Path(out_dir, "verifier-ballots-v5-tier0-live.json")
    out.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {out}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements" and len(sys.argv) == 4:
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble" and len(sys.argv) == 5:
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: verifier-ballots-v5-tier0-live-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
