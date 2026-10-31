#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/verifier-ballots-v5-tier0-sealed.json.

verifier-ballots-v5-tier0.json's live rolling poll (definition version 7,
`electorate_mode` 2, `results_mode` live, Tier 0 alone; ballot version 5),
sealed with no rejection resting on the chain, so that a verifier's run
reaches selection (6.1), delivery (5.9) and the counted set (7.1 to 7.4),
and with them the releases (7.5, 7.6), through `verifyBundle` (docs/spec/
verifier.md, Selection, Counted set and tally and Releases; P2-17 part
4d-2b-2b-2b-2b-2b-2b): the same definition, transcript, panel and group
registry's events, beside

- a run of L1 headers (`l1Blocks`), each encoded here from the Yellow Paper's
  Appendix B with Keccak-256, whose blocks the five ballots name, so 5.8
  judges each L1 reference against finalized L1 (revoting.md, Admission;
  membership.md, Root clock and steps);
- the five honest ballots of verifier-ballots-v5-tier0.json's board, cast
  again naming those blocks, with fresh membership proofs, since M binds the
  reference: a member who joined during the poll (dan, step N0), an opening
  member (ada, N0 − 1) and her re-vote (N0 + 1), boarded before it, group
  2's member (cleo, N0)
  and a member added during the poll at the step whose boundary is closes_at
  (eve, naming the block at closes_at itself);
- every registered seat's receipt for each selected ballot by its version-5
  ballot hash, and each registered seat's honest opening of the one cell
  (Tier 0's) over the counted ballots under tally-opening version 2;
- a clock under which the board is sealed and every entry in the counted
  extent: the transcript in segment 0, the ballots in segment 1, which holds
  opens_at, the receipts in segment 3 (at or below s_D) and the openings in
  segment 4.

The expected rows are 5.1 to 5.5, 5.7 and 5.8 (admission), 6.1 (ada's
re-vote names the higher block, so it is selected over her first ballot),
5.9 (nothing excluded), 6.3 (no close statement: the close is unchecked),
7.1 to 7.4 (the counted set and each seat's opening of it), 8.5 (no seat
states destruction) and 7.5 and 7.6, which pass with no release: the poll
is shorter than `live_every` periods, so it has no scheduled snapshot
(tally.md, Schedule). The report's `ballots`, `delivery`, `cells` and
`tallies` follow.

It reuses this folder's independent Python implementations, which share no
code with packages/crypto or packages/verifier: verifier-ballots-v5-tier0-
vectors.py (the poll, its transcript and ballots, rebuilt from their
labels), verifier-ballots-v5-vectors.py and ballot-v5-records-vectors.py
(admission, version 5's ballot hash and every step root rebuilt from the
events), revoting-vectors.py (the reference check and the selection),
ceremony-vectors.py (the seats' signing secrets from the transcript's label),
delivery-vectors.py and delivery-v2-vectors.py (the windows, the version-2
receipt and the delivery check), intake-v4-vectors.py (the receipt
statement), tally-opening-vectors.py with tally-vectors.py's aggregate (the
opening record, its signature and the opening checks),
verifier-openings-vectors.py (the floor of `s_S`) and group-registry-
vectors.py (Keccak-256).

Membership proofs need a Groth16 prover, so generation has three steps, as
for verifier-ballots-v5-tier0.json:

  python3 -I -B verifier-ballots-v5-tier0-sealed-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B verifier-ballots-v5-tier0-sealed-vectors.py assemble <constants> <work>/proofs.json <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json
and ballot-proofs.mjs runs outside the workspace (see its header). Every
value but the proofs is deterministic from fixed labels (test data, never
keys); Groth16 proving is randomised, so the committed file is the record.
Then `vp check --fix` formats it.
"""

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


t0 = _load("verifier_ballots_v5_tier0_vectors", "verifier-ballots-v5-tier0-vectors.py")
dv2 = _load("delivery_v2_vectors", "delivery-v2-vectors.py")
tov = _load("tally_opening_vectors", "tally-opening-vectors.py")
vo = _load("verifier_openings_vectors", "verifier-openings-vectors.py")
keccak256 = _load("group_registry_vectors", "group-registry-vectors.py").keccak256
v5, r5, vc, vb, b3, b4 = t0.v5, t0.r5, t0.vc, t0.vb, t0.b3, t0.b4
cv, rev, mem, tt = vc.cv, r5.rev, t0.mem, t0.tt
dv, iv4 = dv2.dv, dv2.iv4
tv, bv, grp = tov.tv, tov.bv, tov.grp
L = grp.L
DEFAULT = dv2.DEFAULT
N0, tau, outcome = t0.N0, t0.tau, t0.outcome
SEATS = t0.SEATS
BOARD_VERSION = t0.BOARD_VERSION
TALLY_OPENING_VERSION = 2
PERIOD = 3600

# --- L1 headers -------------------------------------------------------------------


def rlp(x):
    """Yellow Paper, Appendix B."""
    if isinstance(x, list):
        body = b"".join(rlp(i) for i in x)
        return _prefix(len(body), 0xC0) + body
    if len(x) == 1 and x[0] < 0x80:
        return x
    return _prefix(len(x), 0x80) + x


def _prefix(n, short):
    if n < 56:
        return bytes([short + n])
    be = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([short + 55 + len(be)]) + be


def uint(n):
    return b"" if n == 0 else n.to_bytes((n.bit_length() + 7) // 8, "big")


def header(parent, number, timestamp):
    """A header with the 15 fields every fork has; only the parent, number and time vary."""
    z = bytes
    encoded = rlp([parent, z(32), z(20), z(32), z(32), z(32), z(256), uint(0), uint(number), uint(30_000_000), uint(0), uint(timestamp), b"", z(32), z(8)])
    return {"encoded": encoded, "hash": keccak256(encoded), "number": number, "timestamp": timestamp}


def run(first, timestamps):
    """A linked run from `first`, one header per timestamp; the first's parent is zero."""
    out = []
    for i, t in enumerate(timestamps):
        out.append(header(out[-1]["hash"] if out else bytes(32), first + i, t))
    return out


# --- The poll ---------------------------------------------------------------------

FIRST_BLOCK = 21_000_000

# Each ballot of verifier-ballots-v5-tier0.json's board that admission passed,
# by its entry there, with its label and the L1 timestamp of the block it now
# names: at or after its step's boundary, inside ROOT_WINDOW, at or before
# closes_at (membership.md, Root clock and steps; revoting.md, Admission),
# in the order they are boarded here: ada's re-vote before her first ballot,
# so only the higher block it names, never its place on the board, selects it.
BALLOTS = [
    (1, "dan", tau(N0) + 12),
    (4, "ada-revote", tau(N0 + 1) + 12),
    (3, "cleo", tau(N0) + 24),
    (2, "ada", tau(N0 - 1) + 12),
    (5, "eve-at-close", r5.CLOSES_AT),
]


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    s = t0.build(constants)
    d, e, panel = s["definition"], s["election"], s["panel"]
    pos = r5.POS
    transcript = s["board"][0]
    assert isinstance(transcript, bytes) and d["opens_at"] < tau(N0 - 1) + 12
    k, m = e["threshold"], e["optionTotal"]

    # A header an hour and a block before opening, one per ballot's
    # reference, and one an hour and a block after close.
    times = sorted(t for _, _, t in BALLOTS)
    headers = run(FIRST_BLOCK, [d["opens_at"] - 3600 - 12] + times + [d["closes_at"] + 3600 + 12])
    by_time = {h["timestamp"]: h for h in headers}

    ballots, proofs, constants_of = [], {}, {}
    for at, label, t in BALLOTS:
        old, _ = s["board"][at]
        h = by_time[t]
        b = dict(old, l1RefNumber=h["number"], l1RefHash=h["hash"])
        assert r5.reference(b, t) == "ok", label
        # The ballot's constant terms (v_j, r_j), drawn as ballot-v4-vectors.py's
        # make_ballot drew them, with no author half: per option r_j, then f's
        # and g's other coefficients; v_j is the bit whose commitment matches.
        rng = bv.Rng("ballot-v4/verifier-ballots-v5-tier0/" + label)
        pairs = []
        for j in range(m):
            r = rng.scalar()
            for _ in range(2 * (k - 1)):
                rng.scalar()
            vs = [v for v in (0, 1) if grp.equal(bv.pedersen(v, r), b["vote"]["vss"][j][0])]
            assert len(vs) == 1, (label, j)
            pairs.append((vs[0], r))
        constants_of[label] = pairs
        # A witness for the step tree of the ballot's own step, for M over the new reference.
        step = r5.step_of(e, 0, b["step"])
        secret = r5.SECRETS[label.split("-")[0]]
        i = step["leaves"].index(pos.commitment(secret))
        sib = tt.path_of(pos.z, step["levels"], i)
        sc = r5.rolling_scope_field(e["definitionHash"], 0)
        assert pos(sc, secret) == b["nullifier"]
        msg = rev.message(e["definitionHash"], 0, r5.ballot_hash(b), b["l1RefNumber"], b["l1RefHash"])
        pid = "sealed/" + label
        proofs[pid] = {
            "id": pid,
            "witness": {
                "secret": str(secret),
                "merkleProofLength": r5.DEPTH,
                "merkleProofIndex": i,
                "merkleProofSiblings": [str(x) for x in sib],
                "message": str(mem.field_map(msg)),
                "scope": str(sc),
            },
            "expect": {"root": str(step["root"]), "nullifier": str(b["nullifier"])},
        }
        ballots.append((label, b, pid))
    return {**s, "transcript": transcript, "headers": headers, "ballots": ballots, "proofs": proofs, "constants": constants_of}


def checks_of(s):
    out = []
    for label, b, pid in s["ballots"]:
        sig = r5.verifier_signals(s["election"], b)
        assert sig is not None, label
        out.append({"case": "sealed/" + label, "proof": pid, "signals": {k: str(v) for k, v in sig.items()}})
    return out


def statements(constants, out):
    s = build(constants)
    pathlib.Path(out).write_text(json.dumps({"proofs": list(s["proofs"].values()), "checks": checks_of(s)}, indent=2) + "\n")


def assemble(constants, proofs_path, out_dir):
    s = build(constants)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    proof_bytes = {k: bytes.fromhex(v) for k, v in got["proofs"].items()}
    assert set(proof_bytes) == set(s["proofs"])
    d, e, panel, eid = s["definition"], s["election"], s["panel"], s["eid"]
    defh = e["definitionHash"]
    k, m = e["threshold"], e["optionTotal"]

    # A clock under which the board is sealed and every entry is in the
    # counted extent (verifier-counted-v5-rolling-vectors.py's): segment 1
    # holds opens_at, segment 2 starts at closes_at.
    clock = {"epoch": d["closes_at"] - 2 * PERIOD, "period": PERIOD, "deadline": 7200}
    seg_d, seg_k = dv.segments(clock["epoch"], PERIOD, d["closes_at"], d["l1_inclusion_bound"])
    t_d, t_k = dv.deadlines(d["closes_at"], d["l1_inclusion_bound"])
    floor = max(vo.floor_of(d["closes_at"], clock), seg_k)
    clock["lastSegment"] = floor + 2
    assert clock["epoch"] + PERIOD <= d["opens_at"] < clock["epoch"] + 2 * PERIOD == d["closes_at"]
    assert 3 <= seg_d < floor

    # Admission (5.1 to 5.5, 5.7) under this clock, with snarkjs's verdicts.
    saved = vb.CLOCK
    vb.CLOCK = clock
    try:
        records, admitted = [], []
        for n, (label, b, pid) in enumerate(s["ballots"]):
            entry = 1 + n
            result = v5.admission(e, b, got["verdicts"]["sealed/" + label])
            assert result["code"] == "ok", label
            assert vb.window(d, {"kind": "board", "segment": 1}) is None
            records.append(r5.enc_ballot(dict(b, proof=proof_bytes[pid])))
            admitted.append({"tier": result["tier"], "nullifier": b["nullifier"], "message": result["message"], "ref": b["l1RefNumber"], "index": entry})
    finally:
        vb.CLOCK = saved

    # 5.8: each reference against the run, the oldest block it may name
    # being the first an hour or less before opening.
    headers = s["headers"]
    chain = {h["number"]: (h["hash"], h["timestamp"]) for h in headers}
    head = headers[-1]["number"]
    low = rev.first_in_window({n - FIRST_BLOCK: v for n, v in chain.items()}, 0, head - FIRST_BLOCK, d["opens_at"]) + FIRST_BLOCK
    for (label, b, _), t in zip(s["ballots"], (t for _, _, t in BALLOTS)):
        assert rev.check_reference(b["l1RefNumber"], b["l1RefHash"], chain, head, low, d["closes_at"]) == "admitted", label
        assert r5.reference(b, chain[b["l1RefNumber"]][1]) == "ok" and chain[b["l1RefNumber"]][1] == t

    # 6.1: ada's re-vote names the higher block.
    chosen = rev.select(admitted)
    assert chosen == {"selected": [1, 2, 3, 5], "repeats": [], "ties": []}, chosen
    labels = {1 + n: label for n, (label, _, _) in enumerate(s["ballots"])}
    selected = [dict(b, ctx=r5.ctx_of(b), hash=r5.ballot_hash(b)) for n, (label, b, _) in enumerate(s["ballots"]) if 1 + n in chosen["selected"]]

    # The registered seats, from the transcript, each seat's signing secret
    # from the transcript's label (ceremony-vectors.py, seat_secrets).
    t = s["transcript"]
    checked = cv.check(panel, t, vc.election_of(d))
    assert checked["ok"] and [x["index"] for x in checked["registered"]] == SEATS
    secrets, signing, registered = {}, {}, {DEFAULT: {}, dv2.AUTHOR: {}}
    for x in checked["registered"]:
        i = x["index"]
        secrets[i] = cv.seat_secrets("verifier-ballots-v5-tier0/live", i)["signing"]
        assert cv.p256_key(secrets[i]).hex() == x["signingKey"], i
        signing[i] = bytes.fromhex(x["signingKey"])
        registered[DEFAULT][i] = {"signingKey": signing[i], "kem": None}

    def receipt(b, seat):
        sh = b["vote"]["shareHashes"][seat - 1]
        return dv2.receipt_record(defh, b["hash"], DEFAULT, seat, sh, iv4.sign(secrets[seat], iv4.statement(defh, b["hash"], DEFAULT, seat, sh)))

    receipts = [receipt(b, seat) for b in selected for seat in SEATS]
    result = dv2.check_delivery(defh, registered, seg_d, seg_k, t_d, t_k, selected, [("board", 3, r) for r in receipts], hash_of=lambda b: b["hash"])
    assert all(x["counted"] for x in result["ballots"]) and not result["records"] and not result["rejected"]
    counted = [labels[i] for i in chosen["selected"]]

    def opening(signer):
        """Seat `signer`'s honest opening of cell 0 over the counted ballots, under tally-opening version 2."""
        agg = tv.aggregate(m, k, [b["vote"]["vss"] for b in selected])
        values = [{"v": sum(s["constants"][w][j][0] for w in counted) % L, "r": sum(s["constants"][w][j][1] for w in counted) % L} for j in range(m)]
        ah = tov.aggregate_hash(agg)
        sig = tov.sign(secrets[signer], tov.statement(defh, 0, ah, signer, values))
        o = {"definitionHash": defh, "cell": 0, "aggregateHash": ah, "signer": signer, "opening": values, "signature": sig}
        return tov.encode(o, version=TALLY_OPENING_VERSION)

    openings = [opening(seat) for seat in SEATS]
    tally = tov.check_tally(defh, m, k, signing, [[b["vote"]["vss"] for b in selected]], openings, TALLY_OPENING_VERSION)
    assert tally["ok"], tally
    (cell,) = tally["cells"]
    counts = [str(c) for c in cell["counts"]]
    assert counts == [str(sum(s["constants"][w][j][0] for w in counted)) for j in range(m)]

    segments = [(0, [t]), (1, records), (3, receipts), (4, openings)]
    entries = []
    for seg, payloads in segments:
        for p in payloads:
            entries.append(vc.entry(BOARD_VERSION, eid, len(entries), seg, p))
    ceremony_rows, _ = vc.expected(panel, d, entries, panel, BOARD_VERSION)
    assert ceremony_rows["3.2"] == outcome("pass")
    first_opening = 1 + len(records) + len(receipts)

    # No scheduled snapshot: σ_1 = s_open + live_every − 1 isn't below s_close
    # (tally.md, Schedule), so no release is chosen and the releases pass.
    s_open = (d["opens_at"] - clock["epoch"]) // PERIOD
    s_close = (d["closes_at"] - clock["epoch"]) // PERIOD
    assert s_open + d["live_every"] - 1 >= s_close

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
        **{r: outcome("pass") for r in ("7.1", "7.2", "7.3", "7.4", "7.5", "7.6")},
        # No seat states destruction: each registered seat is
        # destruction-missing, decided whatever s_T is (tally.md, Destruction checks).
        "8.5": outcome("fail", "destruction-missing", {"seat": SEATS[0]}),
    }
    doc = {
        "format": "abolish-verifier-ballots-vectors/1",
        "title": "The verifier's selection, delivery, counted set and releases under a live rolling definition whose only tier is Tier 0 (definition version 7, electorate_mode 2, results_mode live; ballot version 5): verifier-ballots-v5-tier0.json's poll sealed, its honest ballots naming a run of L1 headers, with every registered seat's receipts and openings, and the rows and report a verifier gives through the counted set",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/crypto/scripts/verifier-ballots-v5-tier0-sealed-vectors.py, from verifier-ballots-v5-tier0-vectors.py, revoting-vectors.py, "
            "delivery-v2-vectors.py, tally-opening-vectors.py and the modules they load (independent Python implementations; every step root is "
            "rebuilt there from the listed groups' events, every L1 header encoded here); membership proofs by packages/crypto/scripts/ballot-proofs.mjs, "
            "run outside the workspace with Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5, whose groth16.verify gives every "
            "pairing verdict on the signals derived here from each record"
        ),
        "description": (
            "verifier-ballots-v5-tier0.json's live-tier0 poll, with its definition, panel, transcript and events, sealed: in segment 0 the transcript; "
            "in segment 1 the five honest ballots (dan at step N0, ada's re-vote at N0 + 1, cleo at N0, ada's first ballot at N0 − 1, boarded after her re-vote, and eve at N0 + 3, whose boundary "
            "is closes_at), each naming a block of l1Blocks inside its step's window, eve's the block at closes_at itself; in segment 3 every registered "
            "seat's receipt for each selected ballot; in segment 4 each registered seat's honest opening of Tier 0's cell under tally-opening version 2. "
            "ada's re-vote names the higher block, so it is selected over her first ballot, which the board holds after it; every selected ballot is delivered and counted. "
            "The poll is shorter than live_every periods, so it has no scheduled snapshot and no release."
        ),
        "definition": vc.encode(d).hex(),
        "definitionHash": defh.hex(),
        "panel": {"threshold": str(panel["k"]), "keys": [x.hex() for x in panel["keys"]]},
        "clock": {k_: str(v) for k_, v in clock.items()},
        "l1Blocks": [h["encoded"].hex() for h in headers],
        "board": b"".join(entries).hex(),
        "expected": rows,
        "ballots": {
            "admitted": len(records),
            "pending": [],
            "rejected": [],
            "repeats": [],
            "selected": [{"entry": i} for i in chosen["selected"]],
            "ties": [],
        },
        "delivery": {"excluded": [], "records": [], "rejected": []},
        "cells": [{"cell": 0, "tier": 0, "counted": len(selected), "counts": counts, "byQuestion": by_question, "signers": SEATS}],
        "tallies": [{"entry": first_opening + n, "cell": 0, "signer": seat, "breaks": []} for n, seat in enumerate(SEATS)],
        # No snapshot, so no decision, release or running opening; with no
        # release there is no final batch to flag (verifier.md, Releases).
        "releases": {
            "snapshots": [],
            "tiers": [{"tier": 0, "decisions": [], "releases": []}],
            "cells": [{"cell": 0, "tier": 0, "releases": [], "finalBatch": None}],
            "openings": [],
        },
    }
    assert first_opening == 1 + len(BALLOTS) + len(SEATS) * len(selected)
    assert all(int.from_bytes(vc.decode_entry(x, BOARD_VERSION)["payload"][:2], "big") == 0x0006 for x in entries[first_opening:])
    out = pathlib.Path(out_dir, "verifier-ballots-v5-tier0-sealed.json")
    out.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {out}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements" and len(sys.argv) == 4:
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble" and len(sys.argv) == 5:
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: verifier-ballots-v5-tier0-sealed-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
