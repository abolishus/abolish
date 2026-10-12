#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/ballot-v2.json.

A second implementation of docs/spec/ballot-validity.md (Ballot record
(version 2)): the version-2 ballot record, which names its cell's position in
the partition where version 1 names a tier, its statement and ballot hashes,
its admission checks in order, and the public signals its membership proof
is checked against: the cell's cell-tree root and scope, and M under the
cell's tier. It is written from the spec with Python's integers and hashlib
and shares no code with packages/crypto. It reuses this folder's other
independent generators: ballot-vectors.py's Baby Jubjub and Poseidon wrapper,
ballot-validity-vectors.py's committed votes and validity check (its
statement hash reads the version and the cell), membership-vectors.py's
Keccak-256 and scope, revoting-vectors.py's message M, tier-tree-vectors.py's
circomlib Poseidon2 and trees, and regional-cells-vectors.py's version-3
definition encoder, well-formedness rules and fold.

Membership proofs need a Groth16 prover, so generation has three steps, as
for ballot-vectors.py:

  python3 -I -B ballot-v2-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B ballot-v2-vectors.py assemble <constants> <work>/proofs.json <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json.
The cell trees are built here from each tier's groups by the first-occurrence
rule (membership.md, Cell tree), never taken from the code under test. Every
value but the proofs is deterministic from fixed labels (test data, never
keys); Groth16 proving is randomised, so the committed file is the record.
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


b1 = _load("ballot_vectors", "ballot-vectors.py")
rc = _load("regional_cells_vectors", "regional-cells-vectors.py")
bv, mem, rev, tt, dv = b1.bv, b1.mem, b1.rev, b1.tt, b1.dv

R = bv.R
DEPTH = 32
BALLOT_TAG = b"abolish/v1/ballot"
PROOF_LEN = 256
VERSION = 2


def det(label):
    return hashlib.sha256(b"abolish ballot v2 vectors " + label.encode()).digest()


def secret(label):
    s = int.from_bytes(det("identity " + label), "big") % b1.BJJ_L
    assert s != 0
    return s


def filler(label):
    """A member nobody here votes as: any canonical, allowed commitment."""
    x = int.from_bytes(det("filler " + label), "big") % R
    assert x > 1
    return x


# --- Hashes and the record (ballot-validity.md, Ballot record (version 2)) -----


def ballot_hash(definition_hash, cell, nullifier, committed_vote):
    m = definition_hash + bv.u16(0x0002) + bv.u8(VERSION) + bv.u8(cell) + bv.field(nullifier) + committed_vote
    return bv.H(bv.ds(BALLOT_TAG, m))


def enc_ballot(b, version=VERSION):
    out = bv.u16(0x0002) + bv.u8(version)
    out += b["definitionHash"] + bv.u8(b["cell"]) + b["nullifier"].to_bytes(32, "big")
    out += b["l1RefNumber"].to_bytes(8, "big") + b["l1RefHash"]
    assert len(b["proof"]) == PROOF_LEN
    out += b["proof"] + b["committedVote"]
    return out


def validity_ctx(election, cell, nullifier):
    return {
        "definitionHash": election["definitionHash"],
        "optionCount": election["optionCount"],
        "min": election["min"],
        "max": election["max"],
        "threshold": election["threshold"],
        "panelSize": election["panelSize"],
        "ballotVersion": VERSION,
        "cell": cell,
        "nullifier": nullifier,
    }


def admission(election, registered, b, verdict):
    """The admission checks in the spec's order; `verdict` is snarkjs's on the signals derived here."""
    if b["definitionHash"] != election["definitionHash"]:
        return "ballot-stray", None
    if b["cell"] >= len(election["cells"]):
        return "ballot-cell", None
    vote = b["vote"]
    ctx = validity_ctx(election, b["cell"], b["nullifier"])
    n = election["panelSize"]
    shape = (
        len(vote["vss"]) == ctx["optionCount"]
        and all(len(e) == ctx["threshold"] for e in vote["vss"])
        and len(vote["shareHashes"]) == n
        and len(vote["optionProofs"]) == ctx["optionCount"]
        and len(vote["sumProof"]) == ctx["max"] - ctx["min"] + 1
    )
    if not shape:
        return "validity-shape", None
    for seat in range(1, n + 1):
        if seat not in registered and vote["shareHashes"][seat - 1] != bytes(32):
            return "share-hash-unqualified", None
    if not verdict:
        return "membership-proof", None
    v = bv.check_validity(ctx, vote)
    if v != "ok":
        return v["code"], v.get("option")
    return "ok", None


def verifier_signals(election, b):
    """[ρ, ν, m̂, ŝ] as a verifier derives them from the record and the definition, or None before the membership step."""
    if b["definitionHash"] != election["definitionHash"] or b["cell"] >= len(election["cells"]):
        return None
    c = election["cells"][b["cell"]]
    bh = ballot_hash(b["definitionHash"], b["cell"], b["nullifier"], bv.enc_committed_vote(b["vote"]))
    msg = rev.message(b["definitionHash"], c["tier"], bh, b["l1RefNumber"], b["l1RefHash"])
    return {
        "root": c["root"],
        "nullifier": b["nullifier"],
        "message": mem.field_map(msg),
        "scope": b1.scope_field(b["definitionHash"], c["tier"], c["root"]),
    }


# --- The electorate: groups, first occurrence, regions, cells ------------------


def build_groups():
    """Tier 0 in three regions (one large, two small summing to the floor) and tier 2 in one."""
    victim = "moved"
    spec = [
        # (group_id, tier, region, members): a member is ("real", label) or ("filler", label).
        (1, 0, 0, [("real", f"r0/{i}") for i in range(3)] + [("filler", f"r0/{i}") for i in range(3, 999)] + [("real", victim)]),
        (2, 0, 1, [("real", f"r1/{i}") for i in range(2)] + [("filler", f"r1/{i}") for i in range(2, 600)]),
        # The victim's commitment again, in a higher group of another region:
        # first occurrence counts it in group 1 and zeroes this leaf, so region
        # 2 has 400 members of its 401 additions.
        (3, 0, 2, [("real", f"r2/{i}") for i in range(2)] + [("real", victim)] + [("filler", f"r2/{i}") for i in range(2, 400)]),
        (4, 2, 0, [("real", f"t2/{i}") for i in range(3)]),
    ]
    return spec


def build_electorate(pos):
    secrets = {}
    groups = []
    for gid, tier, region, members in build_groups():
        leaves = []
        for kind, label in members:
            if kind == "real":
                s = secrets.setdefault(label, secret(label))
                leaves.append(pos.commitment(s))
            else:
                leaves.append(filler(label))
        groups.append({"group_id": gid, "tier": tier, "region": region, "members": members, "leaves": leaves})
    tiers = []
    for tier in sorted({g["tier"] for g in groups}):
        tg = sorted((g for g in groups if g["tier"] == tier), key=lambda g: g["group_id"])
        # First occurrence across the tier's groups (membership.md, Cell tree).
        seen = set()
        for g in tg:
            g["counted"] = []
            for x in g["leaves"]:
                if x != 0 and x in seen:
                    g["counted"].append(0)
                else:
                    seen.add(x)
                    g["counted"].append(x)
        region_count = max(g["region"] for g in tg) + 1
        regions = [sum(1 for g in tg if g["region"] == r for x in g["counted"] if x != 0) for r in range(region_count)]
        cells = []
        for cell_regions in rc.fold(regions):
            cg = [g for g in tg if g["region"] in cell_regions]
            leaves = [x for g in cg for x in g["counted"]]
            root, path = pos.tree(leaves)
            offsets, at = {}, 0
            for g in cg:
                offsets[g["group_id"]] = at
                at += len(g["counted"])
            cells.append({
                "tier": tier,
                "regions": cell_regions,
                "groups": [g["group_id"] for g in cg],
                "root": root,
                "path": path,
                "offsets": offsets,
                "members": sum(regions[r] for r in cell_regions),
                "leafCount": len(leaves),
            })
        tiers.append({"tier": tier, "groups": tg, "regions": regions, "cells": cells})
    return secrets, groups, tiers


def root_from_path(pos, leaf, index, siblings):
    """Semaphore's binary Merkle root of `leaf` at `index` with `siblings`, bottom-up."""
    node = leaf
    for level, sib in enumerate(siblings):
        node = pos(sib, node) if (index >> level) & 1 else pos(node, sib)
    return node


# --- Elections and cases -------------------------------------------------------


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    b1.bjj_self_check()
    mem.self_check()
    pos = b1.Poseidon(constants)
    secrets, groups, tiers = build_electorate(pos)
    vk_hash = bytes.fromhex(json.loads((VECTORS / "membership-proof.json").read_text())["verificationKey"]["hash"])

    # The partition: tier 0 split into its large region and the remainder, tier 2 unsplit.
    t0, t2 = tiers
    assert t0["regions"] == [1000, 600, 400], t0["regions"]
    assert [c["regions"] for c in t0["cells"]] == [[0], [1, 2]]
    assert [c["regions"] for c in t2["cells"]] == [[0]]
    cells = t0["cells"] + t2["cells"]

    pins = [(1, 3), (2, 2)] + [(t, 4 if t == 7 else 1) for t in range(3, 10)]

    def definition(label):
        d = copy.deepcopy(rc.TYPICAL)
        d.update(
            profile={"protocol_major": 1, "pins": pins},
            election_id=det("election " + label),
            election_type=1,
            option_count=3,
            min_selections=0,
            max_selections=1,
            electorate=[
                {
                    "tier": t["tier"],
                    "root_l2_block": 1000,
                    "groups": [{"group_id": g["group_id"], "region": g["region"]} for g in t["groups"]],
                    "regions": t["regions"],
                    "cells": [{"root": c["root"], "members": c["members"]} for c in t["cells"]],
                }
                for t in tiers
            ],
            membership_vk_hash=vk_hash,
            threshold=2,
            panel_size=3,
            ceremony_transcript_hash=det("transcript " + label),
        )
        assert rc.definition_rule(d) is None, (label, rc.definition_rule(d))
        enc = rc.enc_definition_v3(d)
        h = bv.H(bv.ds(b"abolish/v1/election-definition", enc))
        return {
            "label": label,
            "encoding": enc,
            "definitionHash": h,
            "optionCount": 3,
            "min": 0,
            "max": 1,
            "threshold": 2,
            "panelSize": 3,
            "cells": cells,
        }

    regional = definition("regional")
    other = definition("regional-other")
    elections = {"regional": regional, "other": other}

    def where(label, cell):
        """The member's leaf index in `cell`'s tree: its group's offset plus its index there."""
        c = cells[cell]
        for g in groups:
            if g["group_id"] in c["offsets"]:
                for i, (kind, lab) in enumerate(g["members"]):
                    if kind == "real" and lab == label:
                        return c["offsets"][g["group_id"]] + i
        raise KeyError((label, cell))

    def scope(election, cell):
        c = cells[cell]
        return b1.scope_field(election["definitionHash"], c["tier"], c["root"])

    def nullifier(label, election, cell):
        return pos(scope(election, cell), secrets[label])

    proofs = {}

    def prove(pid, label, election, cell, bh, ref, index=None, msg_tier=None):
        """A witness proving `label`'s leaf in `cell`'s tree (or at `index`), for M over `bh`."""
        c = cells[cell]
        s = secrets[label]
        i = where(label, cell) if index is None else index
        sib = c["path"](i)
        sc = scope(election, cell)
        msg = rev.message(election["definitionHash"], c["tier"] if msg_tier is None else msg_tier, bh, ref[0], ref[1])
        root = root_from_path(pos, pos.commitment(s), i, sib)
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
            "expect": {"root": str(root), "nullifier": str(pos(sc, s))},
        }
        return root

    def ref(label):
        return (21_000_000 + int.from_bytes(det("ref " + label)[:2], "big"), det("ref hash " + label))

    def ballot(label, election, cell, nul, votes, share_hashes=None, vote_election=None):
        e = vote_election or election
        ctx = validity_ctx(e, cell, nul)
        vote, _, _ = bv.make_ballot("ballot v2/" + label, ctx, votes, share_hashes=share_hashes)
        r = ref(label)
        return {
            "definitionHash": election["definitionHash"],
            "cell": cell,
            "nullifier": nul,
            "l1RefNumber": r[0],
            "l1RefHash": r[1],
            "vote": vote,
            "committedVote": bv.enc_committed_vote(vote),
        }

    def bh_of(b):
        return ballot_hash(b["definitionHash"], b["cell"], b["nullifier"], b["committedVote"])

    def refs(b):
        return (b["l1RefNumber"], b["l1RefHash"])

    zero3 = [det("share 1"), det("share 2"), bytes(32)]
    full3 = [det("share 1"), det("share 2"), det("share 3")]
    cases = []

    def case(cid, description, election, registered, b, proof, expect=None):
        cases.append(
            {"id": cid, "description": description, "election": election, "registered": registered, "ballot": b, "proof": proof, "expect": expect or cid}
        )

    e = regional
    # Honest ballots, one in each cell.
    b_a = ballot("cell-0", e, 0, nullifier("r0/1", e, 0), [0, 1, 0], zero3)
    root = prove("cell-0", "r0/1", e, 0, bh_of(b_a), refs(b_a))
    assert root == cells[0]["root"]
    case("ok-cell-0", "A member of tier 0's large region votes in cell 0", "regional", [1, 2], b_a, "cell-0", "ok")

    b_rev = ballot("revote", e, 0, nullifier("r0/1", e, 0), [1, 0, 0], zero3)
    prove("revote", "r0/1", e, 0, bh_of(b_rev), refs(b_rev))
    case("ok-revote", "The same member's re-vote: the same nullifier under another L1 block and vote", "regional", [1, 2], b_rev, "revote", "ok")

    b_r1 = ballot("remainder-region-1", e, 1, nullifier("r1/0", e, 1), [0, 0, 1], zero3)
    root = prove("remainder-region-1", "r1/0", e, 1, bh_of(b_r1), refs(b_r1))
    assert root == cells[1]["root"]
    case("ok-remainder-region-1", "A member of small region 1 votes in the remainder cell 1", "regional", [1, 2], b_r1, "remainder-region-1", "ok")

    b_r2 = ballot("remainder-region-2", e, 1, nullifier("r2/1", e, 1), [1, 0, 0], zero3)
    root = prove("remainder-region-2", "r2/1", e, 1, bh_of(b_r2), refs(b_r2))
    assert root == cells[1]["root"]
    case("ok-remainder-region-2", "A member of small region 2 votes in the same remainder cell, at an index after region 1's group", "regional", [1, 2], b_r2, "remainder-region-2", "ok")

    b_t2 = ballot("tier-2", e, 2, nullifier("t2/2", e, 2), [0, 0, 0], zero3)
    prove("tier-2", "t2/2", e, 2, bh_of(b_t2), refs(b_t2))
    case("ok-tier-2-blank", "A tier 2 member's blank ballot in cell 2, tier 2's one unsplit cell", "regional", [1, 2], b_t2, "tier-2", "ok")

    b_mv = ballot("moved", e, 0, nullifier("moved", e, 0), [0, 1, 0], zero3)
    prove("moved", "moved", e, 0, bh_of(b_mv), refs(b_mv))
    case("ok-moved-counted", "A commitment added to group 1 and later to group 3 counts once, in cell 0 (its first occurrence)", "regional", [1, 2], b_mv, "moved", "ok")

    b_all = ballot("all-seats", e, 0, nullifier("r0/2", e, 0), [0, 0, 1], full3)
    prove("all-seats", "r0/2", e, 0, bh_of(b_all), refs(b_all))
    case("ok-every-seat", "A ballot with a share hash at every seat, under a key set that registers all three", "regional", [1, 2, 3], b_all, "all-seats", "ok")
    case("share-hash-unqualified", "The same ballot when seat 3 isn't registered: its share hash isn't 32 zero bytes", "regional", [1, 2], b_all, "all-seats")

    # Rejected before the membership proof.
    b_other = ballot("other-election", other, 0, nullifier("r0/0", other, 0), [1, 0, 0], zero3)
    prove("other-election", "r0/0", other, 0, bh_of(b_other), refs(b_other))
    case("ballot-stray", "Another election's ballot (the same electorate, another election_id)", "regional", [1, 2], b_other, "other-election")
    case("ballot-cell", "A ballot naming cell 3: the partition has cells 0 to 2", "regional", [1, 2], dict(b_a, cell=3), "cell-0")
    case("ballot-cell-255", "A ballot naming cell 255, the largest u8", "regional", [1, 2], dict(b_a, cell=255), "cell-0", "ballot-cell")
    b_shape = ballot("shape", e, 0, nullifier("r0/0", e, 0), [0, 1, 0, 0], zero3, vote_election=dict(e, optionCount=4))
    case("validity-shape", "A committed vote with four options in a three-option election", "regional", [1, 2], b_shape, "cell-0")

    # Membership failures.
    case("membership-ref-changed", "The cell 0 ballot naming the next L1 block: M changes, so its proof fails", "regional", [1, 2], dict(b_a, l1RefNumber=b_a["l1RefNumber"] + 1), "cell-0", "membership-proof")
    case("membership-other-ballot-proof", "The cell 0 ballot carrying the remainder ballot's valid proof", "regional", [1, 2], b_a, "remainder-region-1", "membership-proof")

    # A cell 0 member's proof (cell 0's root and scope) on a ballot naming cell
    # 1, with M over that ballot: only the root and scope are cell 0's.
    b_oc = ballot("other-cell", e, 1, nullifier("r0/0", e, 0), [1, 0, 0], zero3)
    prove("other-cell", "r0/0", e, 0, bh_of(b_oc), refs(b_oc))
    case("membership-other-cell", "A cell 0 member's proof under cell 0's root and scope, on a ballot naming cell 1 of the same tier", "regional", [1, 2], b_oc, "other-cell", "membership-proof")

    # The same in reverse across tiers: a tier 2 member naming tier 0's cell.
    b_ot = ballot("other-tier", e, 0, nullifier("t2/0", e, 2), [0, 1, 0], zero3)
    prove("other-tier", "t2/0", e, 2, bh_of(b_ot), refs(b_ot), msg_tier=0)
    case("membership-other-tier", "A tier 2 member's proof under cell 2's root and scope, on a ballot naming cell 0 (M under tier 0, as the record implies)", "regional", [1, 2], b_ot, "other-tier", "membership-proof")

    # The victim proving from their second, zeroed leaf: the path gives
    # another root, so the remainder cell refuses it (first occurrence).
    victim_at = cells[1]["offsets"][3] + 2
    assert cells[1]["path"] is not None
    leaves_zeroed = [x for g in groups if g["group_id"] == 3 for x in g["counted"]]
    assert leaves_zeroed[2] == 0
    b_z = ballot("moved-zeroed", e, 1, nullifier("moved", e, 1), [0, 0, 1], zero3)
    root = prove("moved-zeroed", "moved", e, 1, bh_of(b_z), refs(b_z), index=victim_at)
    assert root != cells[1]["root"]
    case("membership-repeat-not-counted", "The moved commitment proving from its second leaf in the remainder cell, which first occurrence set to 0", "regional", [1, 2], b_z, "moved-zeroed", "membership-proof")

    # Validity failures behind a valid membership proof.
    b_two = ballot("vote-of-two", e, 1, nullifier("r2/0", e, 1), [0, 2, 0], zero3)
    prove("vote-of-two", "r2/0", e, 1, bh_of(b_two), refs(b_two))
    case("option-proof", "A member's ballot with a vote of 2 for option 1", "regional", [1, 2], b_two, "vote-of-two")
    b_over = ballot("over-vote", e, 1, nullifier("r2/0", e, 1), [1, 1, 0], zero3)
    prove("over-vote", "r2/0", e, 1, bh_of(b_over), refs(b_over))
    case("sum-proof", "A member's plurality over-vote: two options, each proved 0 or 1", "regional", [1, 2], b_over, "over-vote")

    # The order of the checks, where two would fail: the earlier code is the result.
    case("order-unqualified-before-membership", "An unregistered seat's share hash and another ballot's proof: share-hash-unqualified comes first", "regional", [1, 2], b_all, "tier-2", "share-hash-unqualified")
    case("order-membership-before-option", "A vote of 2 and another ballot's proof: membership-proof comes first", "regional", [1, 2], b_two, "cell-0", "membership-proof")

    checks = []
    for c in cases:
        sig = verifier_signals(elections[c["election"]], c["ballot"])
        if sig is not None:
            checks.append({"case": c["id"], "proof": c["proof"], "signals": {k: str(v) for k, v in sig.items()}})
    return {"secrets": secrets, "groups": groups, "elections": elections, "cells": cells, "proofs": proofs, "cases": cases, "checks": checks}


def hexb(b):
    return b.hex()


def statements(constants, out):
    s = build(constants)
    pathlib.Path(out).write_text(json.dumps({"proofs": list(s["proofs"].values()), "checks": s["checks"]}, indent=2) + "\n")


def assemble(constants, proofs_path, out_dir):
    s = build(constants)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    proof_bytes = {k: bytes.fromhex(v) for k, v in got["proofs"].items()}
    verdicts = got["verdicts"]
    assert set(proof_bytes) == set(s["proofs"])

    def record(c):
        return enc_ballot(dict(c["ballot"], proof=proof_bytes[c["proof"]]))

    elections = {}
    for name, e in s["elections"].items():
        elections[name] = {
            "definition": hexb(e["encoding"]),
            "definitionHash": hexb(e["definitionHash"]),
            "cells": [
                {
                    "cell": i,
                    "tier": c["tier"],
                    "regions": c["regions"],
                    "groups": [str(g) for g in c["groups"]],
                    "root": str(c["root"]),
                    "members": str(c["members"]),
                    "scope": str(b1.scope_field(e["definitionHash"], c["tier"], c["root"])),
                }
                for i, c in enumerate(e["cells"])
            ],
        }

    ballots = []
    for c in s["cases"]:
        e = s["elections"][c["election"]]
        b = c["ballot"]
        sig = verifier_signals(e, b)
        verdict = verdicts.get(c["id"])
        assert (sig is None) == (verdict is None), c["id"]
        code, option = admission(e, c["registered"], b, verdict)
        assert code == c["expect"], (c["id"], code)
        bh = ballot_hash(b["definitionHash"], b["cell"], b["nullifier"], b["committedVote"])
        st = bv.statement_hash(validity_ctx(e, b["cell"], b["nullifier"]), b["vote"]["vss"], b["vote"]["shareHashes"])
        v = {
            "id": c["id"],
            "description": c["description"],
            "election": c["election"],
            "registered": c["registered"],
            "encoding": hexb(record(c)),
            "statementHash": hexb(st),
            "ballotHash": hexb(bh),
        }
        if sig is not None:
            tier = e["cells"][b["cell"]]["tier"]
            v["message"] = hexb(rev.message(b["definitionHash"], tier, bh, b["l1RefNumber"], b["l1RefHash"]))
            v["signals"] = {k: str(x) for k, x in sig.items()}
            v["snarkjs"] = verdict
        v["result"] = code
        if option is not None:
            v["option"] = option
        if code == "ok":
            v["tier"] = e["cells"][b["cell"]]["tier"]
        ballots.append(v)

    good = bytes.fromhex(ballots[0]["encoding"])
    assert ballots[0]["id"] == "ok-cell-0"
    proof_at = 3 + 32 + 1 + 32 + 8 + 32
    vote_at = proof_at + PROOF_LEN

    def with_bytes(at, new):
        return good[:at] + new + good[at + len(new):]

    first_element = vote_at + 4 + 4
    decode = [
        ("truncated", "The cell 0 ballot without its last byte", good[:-1], "truncated", None),
        ("trailing-byte", "The cell 0 ballot with a byte after its sum proof", good + b"\x00", "trailing-bytes", len(good)),
        ("header-only", "A version-2 ballot record header with nothing after it", good[:3], "truncated", 3),
        ("nullifier-r", "A nullifier equal to the BN254 scalar field order", with_bytes(36, R.to_bytes(32, "big")), "non-canonical", 36),
        ("proof-a-identity", "A membership proof whose A is all zeros (the identity)", with_bytes(proof_at, bytes(64)), "non-canonical", proof_at),
        ("vss-identity", "A committed vote whose first VSS commitment is the identity", with_bytes(first_element, bytes(32)), "non-canonical", first_element),
        ("version-1", "The same bytes under version 1, which a profile pinning version 2 refuses", with_bytes(2, b"\x01"), "profile-mismatch", 2),
        ("version-3", "Version 3, which no profile can pin", with_bytes(2, b"\x03"), "profile-mismatch", 2),
    ]
    decode_vectors = []
    for did, desc, enc, err, at in decode:
        dvec = {"id": did, "description": desc, "encoding": hexb(enc), "error": err}
        if at is not None:
            dvec["offset"] = at
        decode_vectors.append(dvec)

    out = {
        "format": "abolish-ballot-vectors/1",
        "title": "Ballot record, version 2 (naming its cell): encodings, admission checks and decode rejections",
        "spec": "docs/spec/ballot-validity.md",
        "generator": (
            "packages/crypto/scripts/ballot-v2-vectors.py, an implementation of the Ballot record (version 2) section with "
            "Python's integers and hashlib, reusing this folder's independent ballot, ballot-validity, membership, revoting, "
            "tier-tree and regional-cells generators; cell trees built here from each tier's groups by the first-occurrence "
            "rule; membership proofs by packages/crypto/scripts/ballot-proofs.mjs, run outside the workspace with Semaphore "
            "4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5's fullProve, which checks that each proof's outputs equal "
            "the root and nullifier computed here; every pairing verdict is snarkjs's groth16.verify on the signals derived "
            "here from the record and the definition. Decode errors and their offsets are labelled by hand from the "
            "strict-decoding rules and the layout's fixed offsets"
        ),
        "recordType": "0x0002",
        "version": VERSION,
        "groups": [
            {
                "groupId": str(g["group_id"]),
                "tier": g["tier"],
                "region": g["region"],
                # Members who vote here, by their index in the group; the rest are filler commitments.
                "voters": [
                    {"index": i, "label": lab, "secret": str(s["secrets"][lab])}
                    for i, (kind, lab) in enumerate(g["members"])
                    if kind == "real"
                ],
                "leafCount": len(g["leaves"]),
                "zeroedByFirstOccurrence": [i for i, (a, b) in enumerate(zip(g["leaves"], g["counted"])) if a != b],
            }
            for g in s["groups"]
        ],
        "elections": elections,
        "ballots": ballots,
        "decode": decode_vectors,
    }
    (pathlib.Path(out_dir) / "ballot-v2.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    cmd = sys.argv[1]
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: ballot-v2-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
