#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-ballots-v5-author.json.

Elections for the verifier's ballot admission under a rolling definition
(definition version 7, `electorate_mode` 2; ballot version 5) beside an
author panel (docs/spec/verifier.md, Key ceremony, step 5, and Ballot
admission; 2.5, 3.1, 3.2, 5.1 to 5.5, 5.7): verifier-ballots-v5.json's
rolling poll with a 2-of-3 author panel, whose board carries the author
panel's transcript, the default panel's and the author approvals record, and
ballots whose author halves are judged against the author panel's registered
key set, the output of its own run over version 7's author stub, approved on
the board (T-37, T-17). Each case is a definition, a board copy and the
default panel a bundle pins, beside the group registry's events and the
definition's registration time, with the rows 2.5, 3.1, 3.2, 5.1 to 5.5 and
5.7 a verifier reports and the report's `ballots`.

The author run binds the definition's own author stub (both transcript
hashes zeroed) and the default run its default stub (which keeps
`author_transcript_hash`), so both runs are of the definition they're
checked against (election-definition.md, Author panel). It reuses this
folder's independent Python implementations, which share no code with
packages/crypto or packages/verifier: verifier-ballots-v5-vectors.py (the
rolling electorate, its events and step roots, the version-5 record and its
admission order, through ballot-v5-records-vectors.py, and version 7's
layout, through rolling-electorate-vectors.py), verifier-ceremony-vectors.py
and ceremony-vectors.py (both runs and their transcript check),
key-set-vectors.py (the key set hash and the registration statement) and
author-ceremony-vectors.py (the author panel and the approvals record).

Membership proofs need a Groth16 prover, so generation has three steps, as
for verifier-ballots-v5.json:

  python3 -I -B verifier-ballots-v5-author-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B verifier-ballots-v5-author-vectors.py assemble <constants> <work>/proofs.json <out-dir>

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


vb5 = _load("verifier_ballots_v5_vectors", "verifier-ballots-v5-vectors.py")
ac = _load("author_ceremony_vectors", "author-ceremony-vectors.py")
r5, vc, vb, cv = vb5.r5, vb5.vc, vb5.vb, vb5.cv
b1, b2, b3, b4, rv, mem, rev, d6 = r5.b1, r5.b2, r5.b3, r5.b4, r5.rv, r5.mem, r5.rev, r5.d6
ks = ac.ks
H, ds = cv.H, cv.ds
outcome, NOT_REACHED, NOT_IMPLEMENTED = vc.outcome, vc.NOT_REACHED, vc.NOT_IMPLEMENTED

STUB_TAG = b"abolish/v1/election-stub"
# Board-entry version 7: version 5's payloads and the author approvals
# (docs/spec/board.md, Allowed payloads).
BOARD_VERSION = 7
vc.ALLOWED[BOARD_VERSION] = vc.ALLOWED[5] | {ac.APPROVALS_TYPE}
AUTHOR = {"panel": "author"}
# verifier-ballots-v5.json's profile beside an author panel: board-entry
# version 7, which carries the approvals, and tally-opening version 3, which
# sums the author half beside the default half (verifier.md, 2.3).
PINS = [(t, BOARD_VERSION if t == vc.BOARD_ENTRY_TYPE else 3 if t == 6 else v) for t, v in vb5.PINS]
assert (6, 3) in PINS and (vc.BOARD_ENTRY_TYPE, BOARD_VERSION) in PINS

N0, T0 = r5.N0, r5.T0
SEATS = vb5.SEATS


def det(label):
    return hashlib.sha256(b"abolish verifier ballots v5 author vectors " + label.encode()).digest()


def author_stub_hash(d):
    """The author panel's stub: the definition, under version 7's layout, with both transcript hashes zeroed (election-definition.md, Stub hash)."""
    return H(ds(STUB_TAG, vc.encode(dict(d, ceremony_transcript_hash=bytes(32), author_transcript_hash=bytes(32)))))


def context(d, stub):
    return {"l2ChainId": d["l2_chain_id"], "trusteeRegistry": d["trustee_registry"], "electionId": d["election_id"], "stubHash": stub}


def key_set_hash(result):
    return ks.key_set_hash([(s["index"], ks.kem_key_hash(bytes.fromhex(s["kemKey"])), bytes.fromhex(s["signingKey"])) for s in result["registered"]])


def approval(d, author, index, transcript_hash, ksh):
    """Author seat `index`'s signature on its ceremony registration statement (ceremony.md, Author panel, Approvals), naming `d`'s author stub."""
    pid = cv.panel_id(author["k"], author["keys"], ac.AUTHOR_PANEL_TAG)
    m = ks.statement(d["l2_chain_id"], d["trustee_registry"], pid, index, author_stub_hash(d), transcript_hash, ksh)
    return (index, cv.sign(author["secrets"][index - 1], ac.REGISTRATION_TAG, m))


def approving(d, author, transcript_hash, ksh, records):
    """Author panel, Check, over the copy's records: the seats counted, each once, from records naming the transcript with strictly increasing seats in range; None when no record names it."""
    n = len(author["keys"])
    named, counted = False, set()
    pid = cv.panel_id(author["k"], author["keys"], ac.AUTHOR_PANEL_TAG)
    for b in records:
        rec = ac.decode_record(b)
        if rec["transcriptHash"] != transcript_hash:
            continue
        named = True
        seats = [i for i, _ in rec["approvals"]]
        if not all(1 <= i <= n for i in seats) or any(a >= c for a, c in zip(seats, seats[1:])):
            continue
        for i, sig in rec["approvals"]:
            m = ks.statement(d["l2_chain_id"], d["trustee_registry"], pid, i, author_stub_hash(d), transcript_hash, ksh)
            if cv.verify(author["keys"][i - 1], ac.REGISTRATION_TAG, m, sig):
                counted.add(i)
    return sorted(counted) if named else None


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    b1.bjj_self_check()
    mem.self_check()
    pos = b1.Poseidon(constants)
    r5.POS = pos
    r5.EVENTS = r5.build_events()
    panel = cv.make_panel("panel-4", 3, 4)
    author = ac.author_panel("verifier-ballots-v5-author/author-3", 2, 3, panel)

    rolling = []
    for tier, groups in r5.TIERS:
        leaves = rv.rolling_leaves(r5.EVENTS, groups, lambda ev: ev["block"] <= r5.ROOT_L2_BLOCK)
        root = r5.tt.root_of(pos.z, r5.tt.levels(pos.c, pos.m, pos.z, leaves))
        rolling.append({"tier": tier, "root_l2_block": r5.ROOT_L2_BLOCK, "groups": groups, "root": root, "group_size": rv.member_count(leaves)})

    base = rv.variant(
        rv.TYPICAL,
        profile={"protocol_major": 1, "pins": PINS},
        election_id=det("election"),
        questions=[d6.d5.q(*x) for x in r5.QUESTIONS],
        rolling_electorate=rolling,
        membership_vk_hash=vb5.MEMBERSHIP_VK_HASH,
        opens_at=r5.REGISTERED_AT + 60,
        closes_at=r5.CLOSES_AT,
        **d6.SEALED_EVERYDAY,
        author_threshold=author["k"],
        author_keys=list(author["keys"]),
        author_transcript_hash=bytes(32),
    )
    proofs, checks, bundles = {}, [], []

    def election_for(label, author_seats, author_stub_of=None):
        """The definition, both runs' transcripts and the author run's check: the author run first, over the author stub (or the stub of `author_stub_of`, a function of the zeroed definition, where given), then the default run over the default stub, which binds the author transcript."""
        zeroed = dict(base, panel_id=cv.panel_id(panel["k"], panel["keys"]), threshold=panel["k"], panel_size=len(panel["keys"]), ceremony_transcript_hash=bytes(32))
        stub = author_stub_hash(author_stub_of(zeroed) if author_stub_of else zeroed)
        t_a = vc.transcript(f"verifier-ballots-v5-author/{label}/author", author, author_seats, context(zeroed, stub))
        fields = dict(base, author_transcript_hash=H(ds(vc.TRANSCRIPT_TAG, t_a)))
        # The default run's `duplicate-key` reads the author keys (ceremony.md, Author panel).
        own = dict(panel, otherKeys=list(author["keys"]))
        t_d = vc.transcript(f"verifier-ballots-v5-author/{label}/default", own, SEATS, vc.election_of(vc.definition_for(panel, bytes(32), fields)))
        d = vc.definition_for(panel, H(ds(vc.TRANSCRIPT_TAG, t_d)), fields)
        assert vc.own_version(d) == 7 and d["electorate_mode"] == rv.ROLLING and author_stub_hash(d) == author_stub_hash(zeroed)
        assert rv.definition_rule(d) is None, rv.definition_rule(d)
        checked = cv.check(author, t_a, context(d, author_stub_hash(d)))
        # A transcript made for another stub fails the author run's check (T-37).
        assert (checked["ok"] and [s["index"] for s in checked["registered"]] == author_seats) != bool(author_stub_of), checked
        enc = vc.encode(d)
        e = dict(
            r5.rules(r5.QUESTIONS, d["threshold"], d["panel_size"], d["author_threshold"], len(d["author_keys"])),
            label=label,
            definition=d,
            encoding=enc,
            definitionHash=H(ds(b3.DEFINITION_TAG, enc)),
            cells=[{"tier": t["tier"], "groups": t["groups"]} for t in rolling],
            registeredAt=r5.REGISTERED_AT,
            closesAt=r5.CLOSES_AT,
        )
        run = {"transcript": t_a, "hash": H(ds(vc.TRANSCRIPT_TAG, t_a)), "keySetHash": key_set_hash(checked) if checked["ok"] else None, "registered": author_seats}
        return d, t_d, e, run

    def records(d, run, seats):
        return ac.enc_record(run["hash"], [approval(d, author, i, run["hash"], run["keySetHash"]) for i in seats])

    def nullifier(who, election, cell):
        return pos(r5.rolling_scope_field(election["definitionHash"], election["cells"][cell]["tier"]), r5.SECRETS[who])

    def ballot(label, election, cell, who, step, answers, hashes, author_hashes, vote_rules=None):
        """A ballot of `who` at `step` answering `answers`, with its nullifier under the tier's rolling scope."""
        ctx = {"definitionHash": election["definitionHash"], "cell": cell, "nullifier": nullifier(who, election, cell)}
        vote, _, _, _ = b4.make_ballot(
            "verifier-ballots-v5-author/" + election["label"] + "/" + label,
            vote_rules or election,
            ctx,
            b3.flat(answers),
            version=5,
            share_hashes=hashes,
            author_share_hashes=list(author_hashes),
        )
        r = (21_000_000 + int.from_bytes(det("ref " + label)[:2], "big"), det("ref hash " + label))
        return dict(ctx, step=step, l1RefNumber=r[0], l1RefHash=r[1], vote=vote, committedVote=b4.enc_committed_vote(vote))

    def prove(pid, who, election, b):
        """A witness proving `who`'s live leaf in the tree of `b`'s cell at `b`'s step, for M over `b`'s ballot hash."""
        pid = election["label"] + "/" + pid
        cell = b["cell"]
        tier = election["cells"][cell]["tier"]
        step = r5.step_of(election, cell, b["step"])
        s = r5.SECRETS[who]
        leaf = pos.commitment(s)
        i = step["leaves"].index(leaf)
        sib = r5.tt.path_of(pos.z, step["levels"], i)
        root = b2.root_from_path(pos, leaf, i, sib)
        assert root == step["root"], pid
        sc = r5.rolling_scope_field(election["definitionHash"], tier)
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

    def bundle(bid, description, d, e, run, board, approvals):
        """`board` is the board in order: bytes (a transcript or an approvals record) or (ballot, proof id). `approvals` is the author part of 3.1: "pass", "missing" or "short", or "run" where the author run's check fails before any approval is read."""
        for i, p in enumerate(board):
            if isinstance(p, tuple):
                b, pid = p
                sig = r5.verifier_signals(e, b)
                if sig is not None:
                    checks.append({"case": f"{bid}/{i}", "proof": pid, "signals": {k: str(v) for k, v in sig.items()}})
        bundles.append({"id": bid, "description": description, "definition": d, "election": e, "run": run, "board": board, "approvals": approvals})

    zero4 = [det("share 1"), det("share 2"), det("share 3"), bytes(32)]
    a12 = [det("author share 1"), det("author share 2"), bytes(32)]
    a123 = a12[:2] + [det("author share 3")]

    # Author seat 3 sends nothing, so seats 1 and 2 register (participation
    # max(2, 3 − 1) = 2) and both approve; default seat 4 sends nothing.
    d, t_d, e, run = election_for("author", [1, 2])
    b_dan = ballot("dan", e, 0, "dan", N0, [(3, [1]), (4, [0, 3]), (2, [1])], zero4, a12)
    p_dan = prove("dan", "dan", e, b_dan)
    b_ada = ballot("ada", e, 0, "ada", N0 - 1, [(3, [0]), (4, []), (2, [0])], zero4, a12)
    p_ada = prove("ada", "ada", e, b_ada)
    b_tess = ballot("tess", e, 1, "tess", N0, [(3, []), (4, []), (2, [1])], zero4, a12)
    p_tess = prove("tess", "tess", e, b_tess)
    b_rev = ballot("ada-revote", e, 0, "ada", N0 + 1, [(3, [2]), (4, [1]), (2, [1])], zero4, a12)
    p_rev = prove("ada-revote", "ada", e, b_rev)
    # Author seat 3, which isn't registered, with a share hash.
    b_aq = ballot("author-unqualified", e, 0, "cleo", N0, [(3, [0]), (4, [1]), (2, [0])], zero4, a123)
    p_aq = prove("author-unqualified", "cleo", e, b_aq)
    # Default seat 4 and author seat 3 both unregistered: the default seat is named.
    b_both = ballot("both-unqualified", e, 0, "eve", N0 + 2, [(3, [1]), (4, []), (2, [1])], zero4[:3] + [det("share 4")], a123)
    p_both = prove("both-unqualified", "eve", e, b_both)
    # No author half where the poll has an author panel, and an author half
    # of one commitment per option where its threshold is 2: the shape is the
    # definition's, never the ballot's (T-17, T-37).
    b_none = ballot("no-author-half", e, 0, "dan", N0, [(3, [0]), (4, []), (2, [0])], zero4, [], vote_rules=r5.rules(r5.QUESTIONS, 3, 4, 0, 0))
    p_none = prove("no-author-half", "dan", e, b_none)
    b_k1 = ballot("author-threshold-1", e, 0, "dan", N0, [(3, [0]), (4, []), (2, [0])], zero4, a12, vote_rules=r5.rules(r5.QUESTIONS, 3, 4, 1, 3))
    p_k1 = prove("author-threshold-1", "dan", e, b_k1)
    # Step N0's ballot with the re-vote's author half: the ballot hash binds
    # it, so M, and with it the proof, fail.
    swapped_vote = dict(b_dan["vote"], authorVss=b_rev["vote"]["authorVss"])
    b_swap = dict(b_dan, vote=swapped_vote, committedVote=b4.enc_committed_vote(swapped_vote))
    approved = records(d, run, [1, 2])
    bundle(
        "author-mixed",
        "A sealed rolling poll with a 2-of-3 author panel whose seat 3 sent nothing, beside the 3-of-4 default panel whose seat 4 sent nothing; both author seats approve. The board holds the author transcript, the default transcript and the approvals record, three admitted ballots (a member who joined during the poll at step N0, an opening member at N0 − 1 and tier 2's member in cell 1), an unregistered author seat's share hash, an unregistered default seat's beside it (named first), a ballot without an author half, an author half of the wrong threshold, an author half swapped after proving, a re-vote at N0 + 1 and a byte-identical repeat of the first ballot.",
        d, e, run,
        [
            run["transcript"],
            t_d,
            approved,
            (b_dan, p_dan),
            (b_ada, p_ada),
            (b_tess, p_tess),
            (b_aq, p_aq),
            (b_both, p_both),
            (b_none, p_none),
            (b_k1, p_k1),
            (b_swap, p_dan),
            (b_rev, p_rev),
            (b_dan, p_dan),
        ],
        "pass",
    )
    bundle(
        "approvals-missing",
        "The same election and ballots with no approvals record on the copy: 3.1 is unverifiable with author-approvals-missing, so no key set is registered and no ballot is judged.",
        d, e, run,
        [run["transcript"], t_d, (b_dan, p_dan), (b_aq, p_aq)],
        "missing",
    )
    bundle(
        "approvals-short",
        "Only author seat 1 approves, short of q_A = 2: 3.1 fails with author-approvals, and no ballot is judged.",
        d, e, run,
        [run["transcript"], t_d, records(d, run, [1]), (b_dan, p_dan)],
        "short",
    )

    # Every author seat registered and approving: author seat 3's share hash is admitted.
    d_all, t_all, e_all, run_all = election_for("author-every-seat", [1, 2, 3])
    b_all = ballot("every-seat", e_all, 0, "cleo", N0, [(3, [2]), (4, [3]), (2, [0])], zero4, a123)
    p_all = prove("every-seat", "cleo", e_all, b_all)
    bundle(
        "author-every-seat",
        "Every author seat registers and approves: a share hash at author seat 3 is admitted.",
        d_all, e_all, run_all,
        [run_all["transcript"], t_all, records(d_all, run_all, [1, 2, 3]), (b_all, p_all)],
        "pass",
    )

    # The author transcript made for another definition's author stub (a
    # later close), which the definition and its default run bind anyway:
    # the author run's check fails, so no author key set is registered (T-37).
    d_o, t_o, e_o, run_o = election_for("author-other-stub", [1, 2], author_stub_of=lambda z: dict(z, closes_at=z["closes_at"] + 1))
    bundle(
        "author-other-stub",
        "The author transcript was made for another definition's author stub (the same poll closing a second later), and the definition and its default run bind it: the author run's check fails 3.1 with ceremony-signature, so no author key set is registered and no ballot is judged.",
        d_o, e_o, run_o,
        [run_o["transcript"], t_o, (b_dan, p_dan)],
        "run",
    )
    return {"panel": panel, "author": author, "proofs": proofs, "checks": checks, "bundles": bundles}


def rows_for(rejected):
    """5.1 to 5.5 and 5.7: each fails at the first entry whose code is one of its own."""

    def first(codes):
        x = next((x for x in rejected if x["code"] in codes), None)
        return outcome("pass") if x is None else outcome("fail", x["code"], {"entry": x["entry"]})

    rows = {r: first([c for c, rs in vb5.ROWS_OF.items() if r in rs]) for r in vb5.ADMISSION_ROWS}
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
    panel, author = s["panel"], s["author"]
    cases = []
    for bnd in s["bundles"]:
        d, e, run = bnd["definition"], bnd["election"], bnd["run"]
        payloads = []
        for p in bnd["board"]:
            if isinstance(p, bytes):
                payloads.append(p)
            else:
                b, pid = p
                payloads.append(r5.enc_ballot(dict(b, proof=proof_bytes[pid])))
        entries = [vc.entry(BOARD_VERSION, d["election_id"], i, 0, rec) for i, rec in enumerate(payloads)]
        # The default panel's rows, as for a poll without one; the author
        # panel's run is the generator's own (Key ceremony, step 5).
        ceremony_rows, ceremony = vc.expected(panel, d, entries, panel, BOARD_VERSION)
        assert ceremony_rows["3.2"] == outcome("pass") and [x["index"] for x in ceremony["registered"]] == SEATS, bnd["id"]
        records = [p for p in payloads if int.from_bytes(p[:2], "big") == ac.APPROVALS_TYPE]
        # The author run's check comes first: its transcript, found by
        # `author_transcript_hash`, against the definition's own author stub.
        at_a = next(i for i, p in enumerate(payloads) if H(ds(vc.TRANSCRIPT_TAG, p)) == d["author_transcript_hash"])
        checked = cv.check(author, payloads[at_a], context(d, author_stub_hash(d)))
        if not checked["ok"]:
            # A transcript made for another stub fails at its first seat's signature.
            assert checked["code"] == "ceremony-signature", checked
            part, run_row = "run", outcome("fail", checked["code"], {"entry": at_a, **AUTHOR})
        else:
            seats = approving(d, author, run["hash"], run["keySetHash"], records)
            quorum = max(author["k"], len(author["keys"]) - 1)
            part = "missing" if seats is None else "pass" if len(seats) >= quorum else "short"
        assert part == bnd["approvals"], bnd["id"]
        rows = {
            # The bundle's panel stands in for the pins, and no author seat is a default seat.
            "2.5": NOT_IMPLEMENTED,
            # 3.1's last part, the default panel's registration on L2, is never read.
            "3.1": {
                "pass": NOT_IMPLEMENTED,
                "missing": outcome("unverifiable", "author-approvals-missing", AUTHOR),
                "short": outcome("fail", "author-approvals", AUTHOR),
            }[part]
            if part != "run"
            else run_row,
            # The author run's 3.2 isn't reached where its check failed.
            "3.2": NOT_REACHED if part == "run" else outcome("pass"),
        }
        ballots = None
        if part == "pass":
            admitted, rejected, repeats, firsts = [], [], [], set()
            for i, p in enumerate(bnd["board"]):
                if isinstance(p, bytes):
                    continue
                b, _ = p
                verdict = verdicts.get(f"{bnd['id']}/{i}")
                assert (r5.verifier_signals(e, b) is None) == (verdict is None), (bnd["id"], i)
                result = r5.admission(e, SEATS, run["registered"], b, verdict)
                code = result["code"]
                late = vb.window(d, {"kind": "board", "segment": 0}) if code == "ok" else None
                if late is not None:
                    rejected.append({"entry": i, "code": late})
                elif code == "ok":
                    admitted.append(i)
                    # Step 1 of revoting.md's Selection: (tier, ν, M); the step never ranks.
                    k = (result["tier"], b["nullifier"], result["message"])
                    if k in firsts:
                        repeats.append({"entry": i})
                    firsts.add(k)
                else:
                    r = {"entry": i, "code": code}
                    for key in ("option", "question", "panel", "seat"):
                        if key in result:
                            r[key] = result[key]
                    rejected.append(r)
            rejected = sorted(rejected + [{"entry": r["entry"], "code": "repeat"} for r in repeats], key=lambda r: r["entry"])
            admitted = [i for i in admitted if {"entry": i} not in repeats]
            rows.update(rows_for(rejected))
            ballots = {"admitted": len(admitted), "rejected": rejected, "repeats": []}
        else:
            rows.update({r: NOT_REACHED for r in vb5.ADMISSION_ROWS + ("5.5", "5.7")})
        case = {
            "id": bnd["id"],
            "description": bnd["description"],
            "definition": vc.encode(d).hex(),
            "board": b"".join(entries).hex(),
            "expected": rows,
        }
        if ballots is not None:
            case["ballots"] = ballots
        cases.append(case)

    by = {c["id"]: c for c in cases}
    mixed = by["author-mixed"]["ballots"]
    assert mixed["admitted"] == 4, mixed
    assert [(r["entry"], r["panel"], r["seat"]) for r in mixed["rejected"] if r["code"] == "share-hash-unqualified"] == [(6, 2, 3), (7, 1, 4)], mixed
    assert [r["entry"] for r in mixed["rejected"] if r["code"] == "validity-shape"] == [8, 9], mixed
    assert [r["entry"] for r in mixed["rejected"] if r["code"] == "membership-proof"] == [10], mixed
    assert [r["entry"] for r in mixed["rejected"] if r["code"] == "repeat"] == [12], mixed
    assert by["author-every-seat"]["ballots"] == {"admitted": 1, "rejected": [], "repeats": []}
    assert by["approvals-missing"]["expected"]["5.1"] == NOT_REACHED and by["approvals-short"]["expected"]["3.1"]["status"] == "fail"
    assert by["author-other-stub"]["expected"]["3.1"] == outcome("fail", "ceremony-signature", {"entry": 0, **AUTHOR})
    assert by["author-other-stub"]["expected"]["5.1"] == NOT_REACHED

    doc = {
        "format": "abolish-verifier-ballots-vectors/1",
        "title": "The verifier's ballot admission under a rolling definition (definition version 7, electorate_mode 2; ballot version 5) beside an author panel: definitions, boards carrying both panels' transcripts and the author approvals, and the pinned default panel, beside the group registry's events and the registration time, with the rows 2.5, 3.1, 3.2, 5.1 to 5.5 and 5.7 and the report's ballots",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-ballots-v5-author-vectors.py, from verifier-ballots-v5-vectors.py, ballot-v5-records-vectors.py, "
            "verifier-ceremony-vectors.py, ceremony-vectors.py, key-set-vectors.py, author-ceremony-vectors.py and rolling-electorate-vectors.py "
            "(independent Python implementations; every step root is rebuilt there from the listed groups' events); membership proofs by "
            "packages/crypto/scripts/ballot-proofs.mjs, run outside the workspace with Semaphore 4.14.3's depth-32 circuit artifacts and "
            "snarkjs 0.7.5, whose groth16.verify gives every pairing verdict on the signals derived here from each record"
        ),
        "clock": {k: str(v) for k, v in vb.CLOCK.items()},
        "panel": {"threshold": str(panel["k"]), "keys": [k.hex() for k in panel["keys"]]},
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
    path = pathlib.Path(out_dir, "verifier-ballots-v5-author.json")
    path.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {path}: {len(cases)} cases")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements" and len(sys.argv) == 4:
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble" and len(sys.argv) == 5:
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: verifier-ballots-v5-author-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
