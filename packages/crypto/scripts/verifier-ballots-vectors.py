#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-ballots.json.

Elections for the verifier's ballot admission (docs/spec/verifier.md, Ballot
admission; 5.1 to 5.4): each is an election definition, a board copy and the
panel a bundle pins, with the rows 1.3, 2.3, 3.2 and 5.1 to 5.4 a verifier reports
and the report's `ballots`. Every transcript is made for the stub of the
definition it is checked against, and every ballot proves membership under
that definition's hash, so a verifier checks them with nothing but the bundle.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ceremony-vectors.py
(the definitions, transcripts, board entries and the ceremony rows) and
ballot-vectors.py (Baby Jubjub, tier trees, the ballot record and its
admission checks in order).

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
vc = _load("verifier_ceremony_vectors", "verifier-ceremony-vectors.py")
cv, dv, bv, rev, mem = vc.cv, vc.dv, bal.bv, bal.rev, bal.mem

H, ds = cv.H, cv.ds
BALLOT_TYPE = 0x0002
BOARD_ENTRY_TYPE = 0x0007
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


def decode_ballot(payload):
    """Strict decoding of a version-1 ballot record (ballot-validity.md, Decoding), as far as these vectors need it."""
    if int.from_bytes(payload[0:2], "big") != BALLOT_TYPE:
        return "unknown-record-type", 0
    if payload[2] != 1:
        return "profile-mismatch", 2
    return None


def combination(d):
    """2.3's profile-combination for a definition version 1, from docs/spec/verifier.md 2.3: ballot version 2 pairs only with definition versions 3 and 4, and an unknown ballot version is a later release's to judge."""
    pins = dict(d["profile"]["pins"])
    board, ballot, opening = pins[BOARD_ENTRY_TYPE], pins.get(BALLOT_TYPE), pins.get(0x0006)
    if ballot not in (1, 2):
        # A version this verifier doesn't know: a later release judges it.
        return NOT_IMPLEMENTED
    fits = ballot == 1 and board in (3, 4) and (opening != 1 or board == 4)
    return NOT_IMPLEMENTED if fits else outcome("fail", "profile-combination", {})


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
    pins = [(t, 4 if t == BOARD_ENTRY_TYPE else 1) for t, _ in dv.ALL_PINS]
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
        """`payloads` is the board in order: a transcript's bytes, or (ballot, proof id) or (raw bytes, None)."""
        board = []
        for i, p in enumerate(payloads):
            # A record that doesn't decode (a 3-tuple) never reaches the proof.
            if isinstance(p, tuple) and len(p) == 2:
                b, pid = p
                if pid is not None:
                    sig = bal.verifier_signals(e, b)
                    if sig is not None:
                        checks.append({"case": f"{bid}/{i}", "proof": pid, "signals": {k: str(v) for k, v in sig.items()}})
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
        "Seat 4 sends nothing, so seats 1 to 3 are registered. The board holds the transcript, then two admitted ballots, a ballot of each admission failure, a record that doesn't decode, a second admitted ballot by the first voter (a re-vote, not this part's to decide) and a byte-identical repeat of the first.",
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
        "The same election with only admitted ballots after the transcript: 5.1 to 5.4 pass.",
        d, t, e, [1, 2, 3],
        [t, (ok0, p_ok0), (ok2, p_ok2), (revote, p_revote)],
        "admitted",
    )
    bundle("no-ballots", "The transcript and no ballot: 5.1 to 5.4 pass, with nothing admitted.", d, t, e, [1, 2, 3], [t], "admitted")
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
    v3_key_pins = [(ty, 3 if ty == BALLOT_TYPE else v) for ty, v in pins]
    d_v3, t_v3, e_v3 = election_for("ballot-v3-other-key", [1, 2, 3], profile={"protocol_major": 1, "pins": v3_key_pins}, membership_vk_hash=bal.det("verifier other key"))
    bundle("ballot-v3-other-key", "The profile pins ballot version 3, unknown here, with another membership key: 1.3 isn't failed, since a later release may pin that key for version 3, and 5.1 to 5.4 are unsupported.", d_v3, t_v3, e_v3, [1, 2, 3], [t_v3, (ok0, None)], "unsupported")

    zero_root = [dict(g, root=0) if g["tier"] == 2 else g for g in base["electorate"]]
    d_z, t_z, e_z = election_for("root-zero", [1, 2, 3], electorate=zero_root)
    bundle("root-zero", "The definition gives tier 2 a root of 0, which anyone can prove membership of (T-04): no ballot is checked under it.", d_z, t_z, e_z, [1, 2, 3], [t_z, (ok0, None)], "not-reached")

    v2_pins = [(ty, 2 if ty == BALLOT_TYPE else v) for ty, v in pins]
    d_v2, t_v2, e_v2 = election_for("ballot-v2", [1, 2, 3], profile={"protocol_major": 1, "pins": v2_pins})
    bundle("ballot-v2", "The profile pins ballot version 2 under definition version 1, which no ballot context reads: 5.1 to 5.4 are unsupported.", d_v2, t_v2, e_v2, [1, 2, 3], [t_v2, (ok0, None)], "unsupported")

    return {"groups": groups, "panels": panels, "proofs": proofs, "checks": checks, "bundles": bundles, "eid": eid}


def rows_for(kind, rejected):
    """5.1 to 5.4 from the rejected entries: each row fails at the first entry whose code is one of its own."""
    if kind == "not-reached":
        return {r: NOT_REACHED for r in ADMISSION_ROWS}
    if kind == "unsupported":
        return {r: outcome("unverifiable", "unsupported-version", {}) for r in ADMISSION_ROWS}
    rows = {}
    for r in ADMISSION_ROWS:
        first = next((x for x in rejected if r in ROWS_OF.get(x["code"], ())), None)
        rows[r] = outcome("pass") if first is None else outcome("fail", first["code"], {"entry": first["entry"]})
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
                payloads.append(("transcript", p, None, None))
                continue
            if len(p) == 3:
                how, b, pid = p
                rec = bal.enc_ballot(dict(b, proof=proof_bytes[pid]))
                rec = rec + b"\x00" if how == "trailing" else rec[:2] + b"\x02" + rec[3:]
                payloads.append(("raw", rec, b, pid))
                continue
            b, pid = p
            proof = proof_bytes[pid] if pid is not None else proof_bytes["ok-tier-0"]
            payloads.append(("ballot", bal.enc_ballot(dict(b, proof=proof)), b, pid))
        entries = [vc.entry(4, eid, i, 0, rec) for i, (_, rec, _, _) in enumerate(payloads)]
        panel = s["panels"][e["panel"]]
        ceremony_rows, ceremony = vc.expected(panel, d, entries, panel, 4)
        assert ceremony_rows["3.2"] == (outcome("pass") if bnd["registered"] is not None else ceremony_rows["3.2"])
        if bnd["registered"] is not None and ceremony is not None:
            assert [x["index"] for x in ceremony["registered"]] == bnd["registered"], bnd["id"]
        else:
            assert ceremony_rows["3.2"]["status"] == "fail"
        expect = bnd["expect"]
        # 1.3 knows only ballot version 1's key (docs/spec/verifier.md, Procedure, step 7).
        vk_fails = dict(d["profile"]["pins"]).get(BALLOT_TYPE) == 1 and d["membership_vk_hash"] != MEMBERSHIP_VK_HASH
        rows = {"1.3": outcome("fail", "membership-key", {}) if vk_fails else NOT_IMPLEMENTED, "2.3": combination(d)}
        rows.update({k: v for k, v in ceremony_rows.items() if k == "3.2"})
        ballots = None
        if expect in ("mixed", "admitted"):
            admitted, rejected = [], []
            for i, (kind, rec, b, pid) in enumerate(payloads):
                if kind == "transcript":
                    continue
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
                if code == "ok":
                    admitted.append(i)
                else:
                    r = {"entry": i, "code": code}
                    if option is not None:
                        r["option"] = option
                    rejected.append(r)
            rows.update(rows_for("mixed", rejected))
            ballots = {"admitted": len(admitted), "rejected": rejected}
            if expect == "admitted":
                assert rejected == [], bnd["id"]
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
    assert {r["code"] for r in mixed["ballots"]["rejected"]} == set(ROWS_OF) | {"decode"}
    assert mixed["ballots"]["admitted"] == 4

    doc = {
        "format": "abolish-verifier-ballots-vectors/1",
        "title": "The verifier's ballot admission: definitions, boards and pinned panels, with the rows 1.3, 2.3, 3.2 and 5.1 to 5.4 and the report's ballots",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-ballots-vectors.py, from verifier-ceremony-vectors.py and ballot-vectors.py "
            "(independent Python implementations); membership proofs by packages/crypto/scripts/ballot-proofs.mjs, run outside "
            "the workspace with Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5, whose groth16.verify gives "
            "every pairing verdict on the signals derived here from each record"
        ),
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
