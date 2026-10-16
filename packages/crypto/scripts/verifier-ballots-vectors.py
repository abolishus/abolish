#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-ballots.json.

Elections for the verifier's ballot admission (docs/spec/verifier.md, Ballot
admission; 5.1 to 5.5 and 5.7): each is an election definition, a board copy and the
panel a bundle pins, with the rows 1.3, 2.3, 3.2, 5.1 to 5.5 and 5.7 a
verifier reports and the report's `ballots`. Each copy of a ballot reaches
the board by its own path, judged by the close rule's window (5.5,
docs/spec/close.md, Window) under the file's anchoring clock: a ballot record
in a board entry (the board path), the board contract's `BallotSubmitted`
event in a contract-event record (the ordinary path), or, under contract-event
version 3, its `RelayedBallotSubmitted` event (the relayed path), whose stamp
only 4.5's match with the L1 relay's call proves: a relayed ballot that passes
5.1 to 5.4 is set aside, leaves 5.5 and 5.7 unverifiable
(`not-implemented`) at its entry until 4.5 is built, and makes later copies
candidate repeats, since it may be the copy that stands. Every transcript is made for the stub of the
definition it is checked against, and every ballot proves membership under
that definition's hash, so a verifier checks them with nothing but the bundle.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ceremony-vectors.py
(the definitions, transcripts, board entries and the ceremony rows) and
ballot-vectors.py (Baby Jubjub, tier trees, the ballot record and its
admission checks in order) and contract-event-v2-vectors.py to
contract-event-v5-vectors.py (the contract-event record, versions 2 to 5,
and their event checks).

Membership proofs need a Groth16 prover, so generation has three steps, as
for ballot.json:

  python3 -I -B verifier-ballots-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B verifier-ballots-vectors.py assemble <constants> <work>/proofs.json <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json
and ballot-proofs.mjs runs outside the workspace (see its header). Every value
but the proofs is deterministic from fixed labels (test data, never keys);
Groth16 proving is randomised, so the committed file is the record.
"""

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


bal = _load("ballot_vectors", "ballot-vectors.py")
ce2 = _load("contract_event_v2_vectors", "contract-event-v2-vectors.py")
ce3 = _load("contract_event_v3_vectors", "contract-event-v3-vectors.py")
ce4 = _load("contract_event_v4_vectors", "contract-event-v4-vectors.py")
ce5 = _load("contract_event_v5_vectors", "contract-event-v5-vectors.py")
vc = _load("verifier_ceremony_vectors", "verifier-ceremony-vectors.py")
cv, dv, bv, rev, mem = vc.cv, vc.dv, bal.bv, bal.rev, bal.mem

H, ds = cv.H, cv.ds
BALLOT_TYPE = 0x0002
BOARD_ENTRY_TYPE = 0x0007
CONTRACT_EVENT_TYPE = 0x0008
# The anchoring clock every bundle here is checked under: hourly periods from
# the definitions' opening, so the board path's last segment is
# s_A = period(closes_at) + 1 = 169 (docs/spec/close.md, Window).
CLOCK = {"epoch": 1767225600, "period": 3600, "deadline": 7200, "lastSegment": 200}
BALLOT_SUBMITTED = "BallotSubmitted(bytes32,bytes32,bytes)"
# The contract-event versions this generator reads, and the relayed path's
# call fields: any, since the board carries them unjudged.
READ_EVENTS = (1, 2, 3, 4, 5)
# The board-entry version every profile here pins: 5, the one that allows the
# close statement, and reads every other record as version 4 does.
BOARD_VERSION = 5
RELAY_CALL = (7, 6_000_000, 5_000_000)
MEMBERSHIP_VK_HASH = bytes.fromhex(json.loads((VECTORS / "membership-proof.json").read_text())["verificationKey"]["hash"])
DEFINITION_TAG = b"abolish/v1/election-definition"

outcome, NOT_REACHED, NOT_IMPLEMENTED = vc.outcome, vc.NOT_REACHED, vc.NOT_IMPLEMENTED

# docs/spec/verifier.md, Ballot admission: the rows each admission code of
# docs/spec/ballot-validity.md (Admission) fails. A membership proof is
# checked once against [ρ, ν, m̂, ŝ], so its failure can't say which of the
# root (5.1), the scope (5.2) or the message (5.3) it was made under.
ROWS_OF = {
    "ballot-stray": ("5.1",),
    "ballot-tier": ("5.1",),
    "membership-proof": ("5.1", "5.2", "5.3"),
    "validity-shape": ("5.4",),
    "share-hash-unqualified": ("5.4",),
    "option-proof": ("5.4",),
    "sum-proof": ("5.4",),
}
ADMISSION_ROWS = ("5.1", "5.2", "5.3", "5.4")
WINDOW_CODES = ("window-before-open", "window-after-close", "window-boarded-late")
# BN254's base field: negating a G1 or G2 point negates its y coordinate.
BN254_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583


def decode_ballot(payload):
    """Strict decoding of a version-1 ballot record (ballot-validity.md, Decoding), as far as these vectors need it."""
    if int.from_bytes(payload[0:2], "big") != BALLOT_TYPE:
        return "unknown-record-type", 0
    if payload[2] != 1:
        return "profile-mismatch", 2
    return None


def combination(d):
    """2.3's profile-combination for a definition version 1, from docs/spec/verifier.md 2.3: it pins ballot version 1 with spoiled-ballot opening version 1, ballot versions 2 to 4 pair only with definition versions 3 to 6, and an unknown ballot version is a later release's to judge."""
    pins = dict(d["profile"]["pins"])
    board, ballot, opening = pins[BOARD_ENTRY_TYPE], pins.get(BALLOT_TYPE), pins.get(0x0006)
    events = pins.get(CONTRACT_EVENT_TYPE)
    failed = outcome("fail", "profile-combination", {})
    # Every profile pins board-entry version 5, which allows the close
    # statement, and contract-event version 5, whose tables name every board
    # event, the close rule's, the batches' and the obligation root's
    # (close.md, Version; contracts.md, Event tables (version 5)); a
    # contract-event version this verifier doesn't read is a later release's,
    # once nothing else fails.
    closes = board == 5 and events not in (1, 2, 3, 4, None)
    settled = NOT_IMPLEMENTED if events == 5 else outcome("unverifiable", "unsupported-version", {})
    # A board-entry version this verifier can't read is a later release's,
    # before any combination (verifier.md, Definition, step 2).
    if board not in (1, 3, 4, 5):
        return outcome("unverifiable", "unsupported-version", {})
    if ballot not in (1, 2, 3, 4):
        # A version this verifier doesn't know: a later release judges it.
        return settled if closes else failed
    fits = ballot == 1 and pins.get(0x0003) == 1 and board in (3, 4, 5) and (opening != 1 or board in (4, 5)) and closes
    return settled if fits else failed


def negated(proof):
    """(−A, −B, C): another valid Groth16 proof of the same statement, since e(−A, −B) = e(A, B), made without the witness (docs/spec/membership.md, Proof encoding: A's y is word 1, B's y words 4 and 5)."""
    words = [int.from_bytes(proof[i : i + 32], "big") for i in range(0, len(proof), 32)]
    for i in (1, 4, 5):
        words[i] = (BN254_P - words[i]) % BN254_P
    return b"".join(w.to_bytes(32, "big") for w in words)


def repeat_key(b):
    """(tier, ν, M), with M recomputed from the record (docs/spec/revoting.md, Selection, step 1)."""
    bh = bal.ballot_hash(b["definitionHash"], b["tier"], b["nullifier"], b["committedVote"])
    return b["tier"], b["nullifier"], rev.message(b["definitionHash"], b["tier"], bh, b["l1RefNumber"], b["l1RefHash"])


def last_board_segment(d):
    """s_A = ⌊(closes_at − epoch) / period⌋ + 1 under CLOCK (docs/spec/close.md, Window)."""
    return (d["closes_at"] - CLOCK["epoch"]) // CLOCK["period"] + 1


def window(d, path):
    """The close rule's code for a copy 5.1 to 5.4 admitted, by its own path, or None (docs/spec/close.md, Window)."""
    if path["kind"] == "board":
        return "window-boarded-late" if path["segment"] > last_board_segment(d) else None
    if path["time"] < d["opens_at"]:
        return "window-before-open"
    if path["time"] > d["closes_at"]:
        return "window-after-close"
    return None


def via(kind, inner, segment=0, time=None):
    """A board item carried another way: in an entry of `segment` (kind "board"), or as a contract-event record of the board's `BallotSubmitted` with L2 timestamp `time` ("event"), or of the same log from an address the definition doesn't name ("foreign"), or of its `RelayedBallotSubmitted` with stamp `time` ("relayed", contract-event versions 3 to 5)."""
    return {"via": kind, "item": inner, "segment": segment, "time": time}


def event_record(d, rec, n, time, contract=None, version=2, relayed=False):
    """A contract-event record of `version` (2 or 3) of the board's `BallotSubmitted` carrying `rec`, or under version 3 of its `RelayedBallotSubmitted` with stamp `time` and RELAY_CALL's other fields, framed as the board frames it (contracts.md, Board, Events)."""
    framed = ce2.frame_ballot(rec)
    assert framed is not None
    if relayed:
        assert version in (3, 4, 5)
        index, l1_block, gas = RELAY_CALL
        topics = [ce3.sig_topic(ce3.RELAYED), framed[0], framed[1]]
        data = ce3.word(index) + ce3.word(l1_block) + ce3.word(time) + ce3.word(gas) + ce3.word(0xA0) + ce3.abi_bytes(rec)
        return {3: ce3, 4: ce4, 5: ce5}[version].encode(contract or d["board"], n, 5_000_000 + n, d["opens_at"] + n, topics, data)
    topics = [ce2.sig_topic(BALLOT_SUBMITTED), framed[0], framed[1]]
    data = ce2.word(32) + ce2.abi_bytes(rec)
    encode = {2: ce2, 3: ce3, 4: ce4, 5: ce5}[version].encode
    return encode(contract or d["board"], n, 5_000_000 + n, time, topics, data)


def carried(d, payload, version):
    """The ballot a contract-event record carries, with its path: ("ordinary", L2 timestamp) for the board's `BallotSubmitted`, ("relayed", None) for its `RelayedBallotSubmitted` under version 3, or None: only a record that decodes under `version` and passes the event check as one of these (docs/spec/verifier.md, Ballot admission)."""
    if int.from_bytes(payload[:2], "big") != CONTRACT_EVENT_TYPE:
        return None
    m = {2: ce2, 3: ce3, 4: ce4, 5: ce5}[version]
    try:
        rec = m.decode(payload)
    except m.Reject:
        return None
    contracts = {"election-registry": d["election_registry"], "trustee-registry": d["trustee_registry"], "group-registry": d["group_registry"], "board": d["board"]}
    ev = m.event_check(rec, contracts, {})
    if not isinstance(ev, dict):
        return None
    if ev["event"] == "BallotSubmitted":
        return bytes.fromhex(ev["record"]), "ordinary", rec["timestamp"]
    if ev["event"] == "RelayedBallotSubmitted":
        return bytes.fromhex(ev["record"]), "relayed", None
    return None


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    bal.bjj_self_check()
    mem.self_check()
    pos = bal.Poseidon(constants)

    groups = {}
    for name, tier, count in (("tier-0", 0, 4), ("tier-2", 2, 3), ("outsiders", 0, 2)):
        secrets = [bal.secret(f"verifier/{name}/{i}") for i in range(count)]
        leaves = [pos.commitment(s) for s in secrets]
        root, path = pos.tree(leaves)
        groups[name] = {"tier": tier, "secrets": secrets, "leaves": leaves, "root": root, "path": path}

    panels = {"panel-4": cv.make_panel("panel-4", 3, 4), "panel-4-k2": cv.make_panel("panel-4-k2", 2, 4)}
    # Board-entry version 5 and contract-event version 5, which every profile
    # needs (close.md, Version), and version 1 for every other type.
    pins = [(t, {BOARD_ENTRY_TYPE: BOARD_VERSION, CONTRACT_EVENT_TYPE: 5}.get(t, 1)) for t, _ in dv.ALL_PINS]
    base = dict(
        profile={"protocol_major": 1, "pins": pins},
        electorate=[
            {"tier": groups[g]["tier"], "group_id": i + 1, "root": groups[g]["root"], "root_l2_block": 1000, "group_size": len(groups[g]["leaves"])}
            for i, g in enumerate(("tier-0", "tier-2"))
        ],
        membership_vk_hash=MEMBERSHIP_VK_HASH,
    )
    eid = dv.TYPICAL["election_id"]
    proofs = {}
    checks = []
    bundles = []

    def election_for(label, seats, cheat=None, panel_name="panel-4", **changes):
        """A definition for the panel and its transcript, made for the definition's own stub."""
        panel = panels[panel_name]
        fields = dict(base, **changes)
        ctx = vc.election_of(vc.definition_for(panel, bytes(32), **fields))
        t = vc.transcript(f"verifier-ballots/{label}", panel, seats, ctx, cheat)
        d = vc.definition_for(panel, H(ds(vc.TRANSCRIPT_TAG, t)), **fields)
        enc = dv.enc_definition(d)
        h = bv.H(bv.ds(DEFINITION_TAG, enc))
        tiers = {g["tier"]: {"root": g["root"]} for g in d["electorate"]}
        e = {
            "definitionHash": h,
            "optionCount": d["option_count"],
            "min": d["min_selections"],
            "max": d["max_selections"],
            "threshold": d["threshold"],
            "panelSize": d["panel_size"],
            "tiers": tiers,
        }
        e["panel"] = panel_name
        return d, t, e

    def nullifier(group, index, e, tier):
        g = groups[group]
        return pos(bal.scope_field(e["definitionHash"], tier, g["root"]), g["secrets"][index])

    def ref(label):
        return (21_000_000 + int.from_bytes(bal.det("verifier ref " + label)[:2], "big"), bal.det("verifier ref hash " + label))

    def ballot(label, e, tier, nul, votes, share_hashes, vote_election=None):
        ctx = bal.validity_ctx(vote_election or e, tier, nul)
        vote, _, _ = bv.make_ballot("verifier-ballot/" + label, ctx, votes, share_hashes=share_hashes)
        r = ref(label)
        return {
            "definitionHash": e["definitionHash"],
            "tier": tier,
            "nullifier": nul,
            "l1RefNumber": r[0],
            "l1RefHash": r[1],
            "vote": vote,
            "committedVote": bv.enc_committed_vote(vote),
        }

    def bh_of(b):
        return bal.ballot_hash(b["definitionHash"], b["tier"], b["nullifier"], b["committedVote"])

    def prove(pid, group, index, e, tier, b):
        """A witness proving member `index` of `group` against its own root and the scope under `tier`, for `b`'s M."""
        g = groups[group]
        s = g["secrets"][index]
        sc = bal.scope_field(e["definitionHash"], tier, g["root"])
        msg = rev.message(e["definitionHash"], b["tier"], bh_of(b), b["l1RefNumber"], b["l1RefHash"])
        proofs[pid] = {
            "id": pid,
            "witness": {
                "secret": str(s),
                "merkleProofLength": bal.DEPTH,
                "merkleProofIndex": index,
                "merkleProofSiblings": [str(x) for x in g["path"](index)],
                "message": str(mem.field_map(msg)),
                "scope": str(sc),
            },
            "expect": {"root": str(g["root"]), "nullifier": str(pos(sc, s))},
        }
        return pid

    def bundle(bid, description, d, t, e, registered, payloads, expect):
        """`payloads` is the board in order: a transcript's bytes, (ballot, proof id), or (how, ballot, proof id) with `how` "negated" (the proof re-randomised) or a way of making the record undecodable, each in an entry of segment 0 or wrapped by `via`."""
        board = []
        for i, p in enumerate(payloads):
            # A record that doesn't decode, or that no ordinary path carries, never reaches the proof.
            q = p["item"] if isinstance(p, dict) and p["via"] != "foreign" else p
            if isinstance(q, tuple) and (len(q) == 2 or q[0] == "negated"):
                b, pid = q[-2:]
                if pid is not None:
                    sig = bal.verifier_signals(e, b)
                    if sig is not None:
                        check = {"case": f"{bid}/{i}", "proof": pid, "signals": {k: str(v) for k, v in sig.items()}}
                        if len(q) == 3:
                            check["negate"] = True
                        checks.append(check)
            board.append(p)
        bundles.append({"id": bid, "description": description, "definition": d, "transcript": t, "election": e, "registered": registered, "board": board, "expect": expect})

    zero4 = [bal.det("verifier share 1"), bal.det("verifier share 2"), bal.det("verifier share 3"), bytes(32)]
    full4 = zero4[:3] + [bal.det("verifier share 4")]

    # One election whose seat 4 sends nothing, so the registered key set is
    # seats 1 to 3 and seat 4's share hash must be zero.
    d, t, e = election_for("absent", [1, 2, 3])
    n0 = nullifier("tier-0", 0, e, 0)
    ok0 = ballot("ok-tier-0", e, 0, n0, [0, 1, 0], zero4)
    p_ok0 = prove("ok-tier-0", "tier-0", 0, e, 0, ok0)
    n2 = nullifier("tier-2", 1, e, 2)
    ok2 = ballot("ok-tier-2", e, 2, n2, [0, 0, 0], zero4)
    p_ok2 = prove("ok-tier-2", "tier-2", 1, e, 2, ok2)
    stray = dict(ok0, definitionHash=bal.det("verifier other definition"))
    wrong_tier = dict(ok0, tier=1)
    n1 = nullifier("tier-0", 1, e, 0)
    shape = ballot("shape", e, 0, n1, [0, 1, 0, 0], zero4, vote_election=dict(e, optionCount=4))
    unqualified = ballot("unqualified", e, 0, n1, [1, 0, 0], full4)
    p_unq = prove("unqualified", "tier-0", 1, e, 0, unqualified)
    moved = dict(ok0, l1RefNumber=ok0["l1RefNumber"] + 1)
    n_out = nullifier("outsiders", 0, e, 0)
    outsider = ballot("outsider", e, 0, n_out, [0, 1, 0], zero4)
    p_out = prove("outsider", "outsiders", 0, e, 0, outsider)
    n3 = nullifier("tier-0", 2, e, 0)
    two = ballot("vote-of-two", e, 0, n3, [0, 2, 0], zero4)
    p_two = prove("vote-of-two", "tier-0", 2, e, 0, two)
    over = ballot("over-vote", e, 0, n3, [1, 1, 0], zero4)
    p_over = prove("over-vote", "tier-0", 2, e, 0, over)
    revote = ballot("revote", e, 0, n0, [1, 0, 0], zero4)
    p_revote = prove("revote", "tier-0", 0, e, 0, revote)
    bundle(
        "mixed",
        "Seat 4 sends nothing, so seats 1 to 3 are registered. The board holds the transcript, then two admitted ballots, a ballot of each admission failure, a record that doesn't decode, a second admitted ballot by the first voter (a re-vote, not this part's to decide) and a byte-identical repeat of the first, which 5.7 rejects.",
        d, t, e, [1, 2, 3],
        [
            t,
            (ok0, p_ok0),
            (ok2, p_ok2),
            (stray, p_ok0),
            (wrong_tier, p_ok0),
            (shape, p_ok0),
            (unqualified, p_unq),
            (moved, p_ok0),
            (outsider, p_out),
            (two, p_two),
            (over, p_over),
            ("trailing", ok0, p_ok0),
            ("version-2", ok0, p_ok0),
            (revote, p_revote),
            (ok0, p_ok0),
        ],
        "mixed",
    )

    bundle(
        "admitted",
        "The same election with only admitted ballots after the transcript: 5.1 to 5.5 and 5.7 pass.",
        d, t, e, [1, 2, 3],
        [t, (ok0, p_ok0), (ok2, p_ok2), (revote, p_revote)],
        "admitted",
    )
    bundle(
        "repeats",
        "Copies of the first voter's ballot: one with another voter's proof (rejected, so it makes no copy a repeat, R4), then the original, a copy with its proof negated (other bytes, the same tier, nullifier and M), the second voter's ballot, a byte-identical copy and the first voter's re-vote (another M, so no repeat). 5.7 rejects the two copies after the original.",
        d, t, e, [1, 2, 3],
        [t, (ok0, p_ok2), (ok0, p_ok0), ("negated", ok0, p_ok0), (ok2, p_ok2), (ok0, p_ok0), (revote, p_revote)],
        "repeats",
    )
    bundle(
        "repeat-of-rejected",
        "A copy of a ballot after a copy with another voter's proof, which is rejected: the admitted copy is no repeat (R4), so 5.7 passes.",
        d, t, e, [1, 2, 3],
        [t, (ok0, p_ok2), (ok0, p_ok0)],
        "mixed",
    )
    bundle("no-ballots", "The transcript and no ballot: 5.1 to 5.5 and 5.7 pass, with nothing admitted.", d, t, e, [1, 2, 3], [t], "admitted")
    bundle(
        "unqualified-first",
        "Two failures of 5.4 and one of 5.1 in another order: each row reports its own first failing entry.",
        d, t, e, [1, 2, 3],
        [(over, p_over), t, (outsider, p_out), (unqualified, p_unq)],
        "mixed",
    )

    # Every seat registered: seat 4's share hash may be anything.
    d_all, t_all, e_all = election_for("honest", [1, 2, 3, 4])
    m0 = nullifier("tier-0", 3, e_all, 0)
    every = ballot("every-seat", e_all, 0, m0, [0, 0, 1], full4)
    p_every = prove("every-seat", "tier-0", 3, e_all, 0, every)
    bundle("every-seat", "Every seat registered: a share hash at seat 4 is admitted.", d_all, t_all, e_all, [1, 2, 3, 4], [t_all, (every, p_every)], "admitted")

    def two_bad(i, answers, *_):
        return [bytes(32)] * len(answers) if i in (3, 4) else answers

    d_q, t_q, e_q = election_for("quorum", [1, 2, 3, 4], {"answers": two_bad})
    bundle("quorum", "Seats 3 and 4 answer wrongly: no key set is registered, so no ballot is checked.", d_q, t_q, e_q, None, [t_q, (ok0, None)], "not-reached")

    d_vk, t_vk, e_vk = election_for("other-key", [1, 2, 3], membership_vk_hash=bal.det("verifier other key"))
    bundle("other-key", "The definition names another membership key: 1.3 fails, and no ballot is checked under it.", d_vk, t_vk, e_vk, [1, 2, 3], [t_vk, (ok0, None)], "other-key")

    # A 2-of-4 panel with two qualified seats meets k but not n − 1 = 3
    # (ADR 0006 rule 7): 3.2 fails, and its key set judges no ballot.
    d_p, t_p, e_p = election_for("participation", [1, 2], panel_name="panel-4-k2")
    bundle("participation", "A 2-of-4 panel where only seats 1 and 2 take part: the transcript registers a key set (k = 2) but 3.2 fails ceremony-participation, so no ballot is checked under it.", d_p, t_p, e_p, None, [t_p, (ok0, None)], "not-reached")

    # A ballot version this verifier doesn't know may name a key a later
    # release pins for it: 1.3 can't fail (T-36).
    v5_key_pins = [(ty, 5 if ty == BALLOT_TYPE else v) for ty, v in pins]
    d_v5, t_v5, e_v5 = election_for("ballot-v5-other-key", [1, 2, 3], profile={"protocol_major": 1, "pins": v5_key_pins}, membership_vk_hash=bal.det("verifier other key"))
    bundle("ballot-v5-other-key", "The profile pins ballot version 5, unknown here, with another membership key: 1.3 isn't failed, since a later release may pin that key for version 5, and 5.1 to 5.5 and 5.7 are unsupported.", d_v5, t_v5, e_v5, [1, 2, 3], [t_v5, (ok0, None)], "unsupported")

    zero_root = [dict(g, root=0) if g["tier"] == 2 else g for g in base["electorate"]]
    d_z, t_z, e_z = election_for("root-zero", [1, 2, 3], electorate=zero_root)
    bundle("root-zero", "The definition gives tier 2 a root of 0, which anyone can prove membership of (T-04): no ballot is checked under it.", d_z, t_z, e_z, [1, 2, 3], [t_z, (ok0, None)], "not-reached")

    v2_pins = [(ty, 2 if ty == BALLOT_TYPE else v) for ty, v in pins]
    d_v2, t_v2, e_v2 = election_for("ballot-v2", [1, 2, 3], profile={"protocol_major": 1, "pins": v2_pins})
    bundle("ballot-v2", "The profile pins ballot version 2 under definition version 1, which no ballot context reads: 5.1 to 5.5 and 5.7 are unsupported.", d_v2, t_v2, e_v2, [1, 2, 3], [t_v2, (ok0, None)], "unsupported")

    # The close rule's window (5.5) on both paths, under a profile pinning
    # contract-event version 2, whose board emits `BallotSubmitted`.
    ce_pins = [(ty, 2 if ty == CONTRACT_EVENT_TYPE else v) for ty, v in pins]
    d_w, t_w, e_w = election_for("window", [1, 2, 3], profile={"protocol_major": 1, "pins": ce_pins})
    s_a = last_board_segment(d_w)
    inside = d_w["opens_at"] + 3600
    w_ok0 = ballot("window-ok-tier-0", e_w, 0, nullifier("tier-0", 0, e_w, 0), [0, 1, 0], zero4)
    p_w_ok0 = prove("window-ok-tier-0", "tier-0", 0, e_w, 0, w_ok0)
    w_ok2 = ballot("window-ok-tier-2", e_w, 2, nullifier("tier-2", 1, e_w, 2), [0, 0, 1], zero4)
    p_w_ok2 = prove("window-ok-tier-2", "tier-2", 1, e_w, 2, w_ok2)
    w_early = ballot("window-early", e_w, 0, nullifier("tier-0", 1, e_w, 0), [1, 0, 0], zero4)
    p_w_early = prove("window-early", "tier-0", 1, e_w, 0, w_early)
    w_late = ballot("window-late", e_w, 0, nullifier("tier-0", 2, e_w, 0), [0, 0, 1], zero4)
    p_w_late = prove("window-late", "tier-0", 2, e_w, 0, w_late)
    w_last = ballot("window-last", e_w, 0, nullifier("tier-0", 3, e_w, 0), [0, 1, 0], zero4)
    p_w_last = prove("window-last", "tier-0", 3, e_w, 0, w_last)
    w_stray = dict(w_ok0, definitionHash=bal.det("verifier other definition"))
    bundle(
        "window",
        f"Contract-event version 2 is pinned, so ballots arrive by the board path and the ordinary path (the board's BallotSubmitted), each copy judged by its own path (5.5): a board-path ballot; an ordinary one inside the window; ordinary ones a second before opening and after close; an ordinary copy of the first ballot at closes_at (inside, so a repeat); a board-path copy of the after-close ballot (it stands: a late copy never stands in for a timely one) and an ordinary copy of it at opens_at (inside, a repeat); an ordinary ballot naming another definition (5.1); the same log from an address the definition doesn't name, which carries no ballot; a board-path ballot in segment s_A = {s_a}, the last allowed; and in segment {s_a + 1} a copy of the first ballot and the early ballot, both boarded late, before any repeat.",
        d_w, t_w, e_w, [1, 2, 3],
        [
            t_w,
            (w_ok0, p_w_ok0),
            via("event", (w_ok2, p_w_ok2), time=inside),
            via("event", (w_early, p_w_early), time=d_w["opens_at"] - 1),
            via("event", (w_late, p_w_late), time=d_w["closes_at"] + 1),
            via("event", (w_ok0, p_w_ok0), time=d_w["closes_at"]),
            (w_late, p_w_late),
            via("event", (w_late, p_w_late), time=d_w["opens_at"]),
            via("event", (w_stray, p_w_ok0), time=inside),
            via("foreign", (w_last, p_w_last), time=inside),
            via("board", (w_last, p_w_last), segment=s_a),
            via("board", (w_ok0, p_w_ok0), segment=s_a + 1),
            via("board", ("negated", w_early, p_w_early), segment=s_a + 1),
        ],
        "mixed",
    )
    bundle(
        "window-repeat-late",
        "A copy outside its window is rejected by 5.5 and so makes no later copy a repeat: the ordinary copy after it, at closes_at, stands.",
        d_w, t_w, e_w, [1, 2, 3],
        [t_w, via("event", (w_early, p_w_early), time=d_w["opens_at"] - 1), via("event", (w_early, p_w_early), time=d_w["closes_at"])],
        "mixed",
    )
    # Contract-event version 3, whose board emits `BallotSubmitted` as
    # version 2's does, and `RelayedBallotSubmitted` for a forced ballot.
    ce3_pins = [(ty, 3 if ty == CONTRACT_EVENT_TYPE else v) for ty, v in pins]
    d_c3, t_c3, e_c3 = election_for("events-unread", [1, 2, 3], profile={"protocol_major": 1, "pins": ce3_pins})
    u_ok0 = ballot("events-unread", e_c3, 0, nullifier("tier-0", 0, e_c3, 0), [0, 1, 0], zero4)
    p_u_ok0 = prove("events-unread", "tier-0", 0, e_c3, 0, u_ok0)
    bundle(
        "events-v3",
        "The profile pins contract-event version 3, which 2.3 fails since the share-receipt batch (P1-12d), as it fails version 4 since the obligation root (P1-12f), but whose records the release still reads: a board-path ballot and its board-path copy, judged by 5.1 to 5.5, and the copy a repeat (5.7).",
        d_c3, t_c3, e_c3, [1, 2, 3],
        [t_c3, (u_ok0, p_u_ok0), (u_ok0, p_u_ok0)],
        "mixed",
    )
    bundle(
        "events-v3-relayed",
        "Contract-event version 3: the ballot relayed through L1 with a stamp after close, then an ordinary copy inside the window and a board-path copy. The relayed copy passes 5.1 to 5.4 and is set aside, since only 4.5's match with the relay's call proves its stamp: 5.5 and 5.7 are unverifiable (not-implemented) at it, whatever the other copies show, and the board-path copy stays a candidate repeat, since the relayed one may be the copy that stands.",
        d_c3, t_c3, e_c3, [1, 2, 3],
        [
            t_c3,
            via("relayed", (u_ok0, p_u_ok0), time=d_c3["closes_at"] + 1),
            via("event", (u_ok0, p_u_ok0), time=d_c3["opens_at"] + 3600),
            (u_ok0, p_u_ok0),
        ],
        "relayed",
    )
    # A contract-event version this verifier doesn't read: ordinary ballots
    # can't be found, so the window and repeats can't be decided (T-36).
    ce6_pins = [(ty, 6 if ty == CONTRACT_EVENT_TYPE else v) for ty, v in pins]
    d_c4, t_c4, e_c4 = election_for("events-unread-v6", [1, 2, 3], profile={"protocol_major": 1, "pins": ce6_pins})
    x_ok0 = ballot("events-unread-v6", e_c4, 0, nullifier("tier-0", 0, e_c4, 0), [0, 1, 0], zero4)
    p_x_ok0 = prove("events-unread-v6", "tier-0", 0, e_c4, 0, x_ok0)
    bundle(
        "events-unread",
        "The profile pins contract-event version 6, which this release doesn't read: the board-path ballot and its copy are judged by 5.1 to 5.4, but 5.5 and 5.7 are unsupported and the copy stays a candidate repeat.",
        d_c4, t_c4, e_c4, [1, 2, 3],
        [t_c4, (x_ok0, p_x_ok0), (x_ok0, p_x_ok0)],
        "candidates",
    )

    return {"groups": groups, "panels": panels, "proofs": proofs, "checks": checks, "bundles": bundles, "eid": eid}


def rows_for(kind, rejected, repeats=(), windows=True, relayed=()):
    """5.1 to 5.5 and 5.7 from the rejected entries: each row fails at the first entry whose code is one of its own. Under a contract-event version that isn't read, ordinary ballots can't be found, so 5.5 and 5.7 are unverifiable and a repeat stays a candidate; a relayed ballot that passed 5.1 to 5.4 leaves them unverifiable at the first one."""
    rows_all = ADMISSION_ROWS + ("5.5", "5.7")
    if kind == "not-reached":
        return {r: NOT_REACHED for r in rows_all}
    if kind == "unsupported":
        return {r: outcome("unverifiable", "unsupported-version", {}) for r in rows_all}
    rows = {}

    def first(codes):
        x = next((x for x in rejected if x["code"] in codes), None)
        return outcome("pass") if x is None else outcome("fail", x["code"], {"entry": x["entry"]})

    for r in ADMISSION_ROWS:
        rows[r] = first([c for c, rs in ROWS_OF.items() if r in rs])
    if relayed:
        rows["5.5"] = rows["5.7"] = outcome("unverifiable", "not-implemented", {"entry": relayed[0]})
    elif windows:
        rows["5.5"] = first(WINDOW_CODES)
        rows["5.7"] = first(("repeat",))
    else:
        rows["5.5"] = rows["5.7"] = outcome("unverifiable", "unsupported-version", {})
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
        pins = dict(d["profile"]["pins"])

        def make(p):
            if isinstance(p, bytes):
                return "transcript", p, None, None
            if len(p) == 3 and p[0] == "negated":
                _, b, pid = p
                return "ballot", bal.enc_ballot(dict(b, proof=negated(proof_bytes[pid]))), b, pid
            if len(p) == 3:
                how, b, pid = p
                rec = bal.enc_ballot(dict(b, proof=proof_bytes[pid]))
                rec = rec + b"\x00" if how == "trailing" else rec[:2] + b"\x02" + rec[3:]
                return "raw", rec, b, pid
            b, pid = p
            proof = proof_bytes[pid] if pid is not None else proof_bytes["ok-tier-0"]
            return "ballot", bal.enc_ballot(dict(b, proof=proof)), b, pid

        payloads = []
        for p in bnd["board"]:
            wrap = p if isinstance(p, dict) else {"via": "board", "item": p, "segment": 0, "time": None}
            kind, rec, b, pid = make(wrap["item"])
            if wrap["via"] != "board":
                # The record a board-path ballot of the same bytes would carry,
                # as the board's event (or the same log from an address the
                # definition doesn't name, which carries no ballot).
                version = pins[CONTRACT_EVENT_TYPE]
                assert version in (2, 3)
                contract = bal.det("verifier foreign contract")[:20] if wrap["via"] == "foreign" else d["board"]
                rec = event_record(d, rec, len(payloads), wrap["time"], contract, version, wrap["via"] == "relayed")
            payloads.append((kind, rec, b, pid, wrap["segment"]))
        entries = [vc.entry(pins[BOARD_ENTRY_TYPE], eid, i, seg, rec) for i, (_, rec, _, _, seg) in enumerate(payloads)]
        panel = s["panels"][e["panel"]]
        ceremony_rows, ceremony = vc.expected(panel, d, entries, panel, pins[BOARD_ENTRY_TYPE])
        assert ceremony_rows["3.2"] == (outcome("pass") if bnd["registered"] is not None else ceremony_rows["3.2"])
        if bnd["registered"] is not None and ceremony is not None:
            assert [x["index"] for x in ceremony["registered"]] == bnd["registered"], bnd["id"]
        else:
            assert ceremony_rows["3.2"]["status"] == "fail"
        expect = bnd["expect"]
        # 1.3 knows only ballot version 1's key (docs/spec/verifier.md, Procedure, step 7).
        vk_fails = pins.get(BALLOT_TYPE) == 1 and d["membership_vk_hash"] != MEMBERSHIP_VK_HASH
        # Under a contract-event version this generator doesn't read, ordinary
        # ballots can't be found: 5.5 and 5.7 stay unverifiable.
        windows = pins.get(CONTRACT_EVENT_TYPE) in READ_EVENTS
        rows = {"1.3": outcome("fail", "membership-key", {}) if vk_fails else NOT_IMPLEMENTED, "2.3": combination(d)}
        rows.update({k: v for k, v in ceremony_rows.items() if k == "3.2"})
        ballots = None
        if expect in ("mixed", "admitted", "repeats", "candidates", "relayed"):
            admitted, rejected, repeats, firsts, relayed = [], [], [], set(), []
            for i, (kind, rec, b, pid, seg) in enumerate(payloads):
                if kind == "transcript":
                    continue
                path = {"kind": "board", "segment": seg}
                if int.from_bytes(rec[:2], "big") == CONTRACT_EVENT_TYPE:
                    # Under contract-event version 1 the board emits no event.
                    found = carried(d, rec, pins[CONTRACT_EVENT_TYPE]) if pins[CONTRACT_EVENT_TYPE] in (2, 3, 4, 5) else None
                    if found is None:
                        continue
                    rec, kind_of, time = found
                    path = {"kind": kind_of, "segment": seg, "time": time}
                if kind == "raw":
                    if rec[-1:] == b"\x00" and rec[2] == 1:
                        rejected.append({"entry": i, "code": "decode", "decodeError": "trailing-bytes"})
                    else:
                        err = decode_ballot(rec)
                        assert err == ("profile-mismatch", 2)
                        rejected.append({"entry": i, "code": "decode", "decodeError": err[0]})
                    continue
                verdict = verdicts.get(f"{bnd['id']}/{i}")
                sig = bal.verifier_signals(e, b)
                assert (sig is None) == (verdict is None), (bnd["id"], i)
                code, option = bal.admission(e, bnd["registered"], b, verdict)
                if code == "ok" and path["kind"] == "relayed":
                    # Its stamp is the event's word until 4.5 matches the call.
                    relayed.append(i)
                    continue
                late = window(d, path) if code == "ok" and windows else None
                if late is not None:
                    rejected.append({"entry": i, "code": late})
                elif code == "ok":
                    admitted.append(i)
                    # Step 1 of revoting.md's Selection over the ballots 5.1
                    # to 5.5 admit, in board order: the first of each key stands.
                    k = repeat_key(b)
                    if k in firsts:
                        repeats.append({"entry": i})
                    firsts.add(k)
                else:
                    r = {"entry": i, "code": code}
                    if option is not None:
                        r["option"] = option
                    rejected.append(r)
            # A relayed ballot set aside may be the copy that stands, so while
            # one waits on 4.5 later copies stay candidate repeats.
            settled = windows and not relayed
            if settled:
                # Every copy left passed 5.1 to 5.5, so a repeat is rejected (5.7).
                rejected = sorted(rejected + [{"entry": r["entry"], "code": "repeat"} for r in repeats], key=lambda r: r["entry"])
                admitted = [i for i in admitted if {"entry": i} not in repeats]
            rows.update(rows_for("mixed", rejected, repeats, windows, relayed))
            ballots = {"admitted": len(admitted), "rejected": rejected, "repeats": [] if settled else repeats}
            if expect == "admitted":
                assert rejected == [] and repeats == [], bnd["id"]
            elif expect == "repeats":
                assert len(repeats) == 2, bnd["id"]
            elif expect == "candidates":
                assert not windows and rejected == [] and len(repeats) == 1, bnd["id"]
            elif expect == "relayed":
                assert relayed != [] and windows and len(repeats) == 1, bnd["id"]
            else:
                assert rejected != [], bnd["id"]
        else:
            rows.update(rows_for("not-reached" if expect in ("not-reached", "other-key") else "unsupported", []))
        case = {
            "id": bnd["id"],
            "description": bnd["description"],
            "panel": e["panel"],
            "definition": dv.enc_definition(d).hex(),
            "board": b"".join(entries).hex(),
            "expected": rows,
        }
        if ballots is not None:
            case["ballots"] = ballots
        cases.append(case)

    mixed = next(c for c in cases if c["id"] == "mixed")
    assert {r["code"] for r in mixed["ballots"]["rejected"]} == set(ROWS_OF) | {"decode", "repeat"}
    assert {r["code"] for c in cases for r in c.get("ballots", {}).get("rejected", [])} >= set(WINDOW_CODES) | {"repeat"}
    assert mixed["ballots"]["admitted"] == 3
    assert {"entry": 14, "code": "repeat"} in mixed["ballots"]["rejected"]
    assert all(r["code"] != "repeat" for r in next(c for c in cases if c["id"] == "repeat-of-rejected")["ballots"]["rejected"])

    doc = {
        "format": "abolish-verifier-ballots-vectors/1",
        "title": "The verifier's ballot admission: definitions, boards and pinned panels, with the rows 1.3, 2.3, 3.2, 5.1 to 5.5 and 5.7 and the report's ballots",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-ballots-vectors.py, from verifier-ceremony-vectors.py and ballot-vectors.py "
            "(independent Python implementations); membership proofs by packages/crypto/scripts/ballot-proofs.mjs, run outside "
            "the workspace with Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5, whose groth16.verify gives "
            "every pairing verdict on the signals derived here from each record"
        ),
        "clock": {k: str(v) for k, v in CLOCK.items()},
        "panels": {name: {"threshold": str(p["k"]), "keys": [k.hex() for k in p["keys"]]} for name, p in s["panels"].items()},
        "cases": cases,
    }
    path = pathlib.Path(out_dir, "verifier-ballots.json")
    path.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {path}: {len(cases)} cases")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: verifier-ballots-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
