#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/ballot.json.

A second implementation of docs/spec/ballot-validity.md (Ballot record): the
ballot record's encoding, its admission checks in order, and the public
signals a ballot's membership proof is checked against. It is written from
the spec with Python's integers and hashlib and shares no code with
packages/crypto. It reuses this folder's other independent generators:
ballot-validity-vectors.py's committed votes and validity check (over
group-vectors.py's self-checked ristretto255), membership-vectors.py's
Keccak-256 and scope, revoting-vectors.py's message M, tier-tree-vectors.py's
circomlib Poseidon2 and tier trees, and definition-vectors.py's election
definition encoder and well-formedness rules. Baby Jubjub (EIP-2494) is
carried here, for identity commitments, and checks itself first.

Membership proofs need a Groth16 prover, so generation has three steps:

  python3 -I -B ballot-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B ballot-vectors.py assemble <constants> <work>/proofs.json <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json.
The first lists each proof's witness and the public signals this script
expects from it, and each admission case's signals as a verifier derives them
from the record; the second (outside the workspace, with Semaphore's circuit
artifacts and snarkjs) proves, checks that the circuit's outputs equal the
expected root and nullifier, and records snarkjs's verdict on every case's
signals; the third assembles the records and decides each case with this
file's own admission check, taking the pairing's verdict from snarkjs. The decode
rejections are labelled by hand from the strict-decoding rules and the
record's fixed offsets. Every
value but the proofs is deterministic from fixed labels (test data, never
keys); Groth16 proving is randomised, so the committed file is the record.
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


bv = _load("ballot_validity_vectors", "ballot-validity-vectors.py")
mem = _load("membership_vectors", "membership-vectors.py")
rev = _load("revoting_vectors", "revoting-vectors.py")
tt = _load("tier_tree_vectors", "tier-tree-vectors.py")
dv = _load("definition_vectors", "definition-vectors.py")

R = bv.R
DEPTH = 32
BALLOT_TAG = b"abolish/v1/ballot"
TIERS = (0, 1, 2)
PROOF_LEN = 256

# --- Baby Jubjub (EIP-2494) --------------------------------------------------

BJJ_A, BJJ_D = 168700, 168696
BJJ_L = 2736030358979909402780800718157159386076813972158567259200215660948447373041
B8 = (
    5299619240641551281634865583518297030282874472190772894086521144482721001553,
    16950150798460657717958625567821834550301663161624707787222815936182638968203,
)


def bjj_on_curve(p):
    x, y = p
    return (BJJ_A * x * x + y * y - 1 - BJJ_D * x * x * y * y) % R == 0


def bjj_add(p, q):
    (x1, y1), (x2, y2) = p, q
    t = BJJ_D * x1 * x2 * y1 * y2 % R
    x3 = (x1 * y2 + y1 * x2) * pow(1 + t, -1, R) % R
    y3 = (y1 * y2 - BJJ_A * x1 * x2) * pow(1 - t, -1, R) % R
    return (x3, y3)


def bjj_mul(k, p):
    acc = (0, 1)
    while k:
        if k & 1:
            acc = bjj_add(acc, p)
        p = bjj_add(p, p)
        k >>= 1
    return acc


def bjj_self_check():
    assert bjj_on_curve(B8)
    assert bjj_mul(BJJ_L, B8) == (0, 1)
    assert bjj_mul(BJJ_L - 1, B8) == ((-B8[0]) % R, B8[1])
    two = bjj_add(B8, B8)
    assert bjj_on_curve(two) and bjj_mul(2, B8) == two and bjj_add(two, B8) == bjj_mul(3, B8)


# --- Members, trees and the scope --------------------------------------------


def det(label):
    return hashlib.sha256(b"abolish ballot vectors " + label.encode()).digest()


def secret(label):
    s = int.from_bytes(det("identity " + label), "big") % BJJ_L
    assert s != 0
    return s


class Poseidon:
    def __init__(self, constants):
        self.c, self.m = tt.load_constants(constants)
        self.z = tt.zeros(self.c, self.m)

    def __call__(self, a, b):
        return tt.poseidon2(self.c, self.m, a, b)

    def commitment(self, s):
        x, y = bjj_mul(s, B8)
        return self(x, y)

    def tree(self, leaves):
        lv = tt.levels(self.c, self.m, self.z, leaves)
        return tt.root_of(self.z, lv), lambda i: tt.path_of(self.z, lv, i)


def scope_field(definition_hash, tier, root):
    return mem.field_map(mem.scope(definition_hash, tier, root))


def ballot_hash(definition_hash, tier, nullifier, committed_vote):
    m = definition_hash + bv.u16(0x0002) + bv.u8(1) + bv.u8(tier) + bv.field(nullifier) + committed_vote
    return bv.H(bv.ds(BALLOT_TAG, m))


# --- The ballot record (docs/spec/ballot-validity.md, Ballot record) ---------


def enc_ballot(b, version=1, record_type=0x0002):
    out = bv.u16(record_type) + bv.u8(version)
    out += b["definitionHash"] + bv.u8(b["tier"]) + b["nullifier"].to_bytes(32, "big")
    out += b["l1RefNumber"].to_bytes(8, "big") + b["l1RefHash"]
    assert len(b["proof"]) == PROOF_LEN
    out += b["proof"] + b["committedVote"]
    return out


def admission(election, registered, b, verdict):
    """The admission checks in the spec's order; `verdict` is snarkjs's on the signals derived here."""
    if b["definitionHash"] != election["definitionHash"]:
        return "ballot-stray", None
    if b["tier"] not in election["tiers"]:
        return "ballot-tier", None
    vote = b["vote"]
    ctx = validity_ctx(election, b["tier"], b["nullifier"])
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


def validity_ctx(election, tier, nullifier):
    return {
        "definitionHash": election["definitionHash"],
        "optionCount": election["optionCount"],
        "min": election["min"],
        "max": election["max"],
        "threshold": election["threshold"],
        "panelSize": election["panelSize"],
        "tier": tier,
        "nullifier": nullifier,
    }


def verifier_signals(election, b):
    """[ρ, ν, m̂, ŝ] as a verifier derives them from the record, or None before the membership step."""
    if b["definitionHash"] != election["definitionHash"] or b["tier"] not in election["tiers"]:
        return None
    root = election["tiers"][b["tier"]]["root"]
    bh = ballot_hash(b["definitionHash"], b["tier"], b["nullifier"], bv.enc_committed_vote(b["vote"]))
    msg = rev.message(b["definitionHash"], b["tier"], bh, b["l1RefNumber"], b["l1RefHash"])
    return {
        "root": root,
        "nullifier": b["nullifier"],
        "message": mem.field_map(msg),
        "scope": scope_field(b["definitionHash"], b["tier"], root),
    }


# --- Elections and cases -----------------------------------------------------


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    bjj_self_check()
    mem.self_check()
    pos = Poseidon(constants)
    vk_hash = bytes.fromhex(json.loads((VECTORS / "membership-proof.json").read_text())["verificationKey"]["hash"])

    groups = {}
    for name, tier, count in (("tier-0", 0, 5), ("tier-1", 1, 4), ("tier-2", 2, 3), ("outsiders", 0, 2)):
        members = [f"{name}/{i}" for i in range(count)]
        secrets = [secret(m) for m in members]
        leaves = [pos.commitment(s) for s in secrets]
        root, path = pos.tree(leaves)
        groups[name] = {"tier": tier, "members": members, "secrets": secrets, "leaves": leaves, "root": root, "path": path}

    pins = [(t, 4 if t == 7 else 1) for t in range(1, 10)]

    def definition(label, election_type, m, lo, hi, k, n, tiers):
        d = dv.variant(
            dv.TYPICAL,
            profile={"protocol_major": 1, "pins": pins},
            election_id=det("election " + label),
            election_type=election_type,
            option_count=m,
            min_selections=lo,
            max_selections=hi,
            electorate=[
                {"tier": groups[g]["tier"], "group_id": i + 1, "root": groups[g]["root"], "root_l2_block": 1000, "group_size": len(groups[g]["leaves"])}
                for i, g in enumerate(tiers)
            ],
            membership_vk_hash=vk_hash,
            threshold=k,
            panel_size=n,
            ceremony_transcript_hash=det("transcript " + label),
        )
        assert dv.definition_rule(d) is None, label
        enc = dv.enc_definition(d)
        h = bv.H(bv.ds(b"abolish/v1/election-definition", enc))
        return {
            "label": label,
            "encoding": enc,
            "definitionHash": h,
            "optionCount": m,
            "min": lo,
            "max": hi,
            "threshold": k,
            "panelSize": n,
            "tiers": {groups[g]["tier"]: {"group": g, "root": groups[g]["root"]} for g in tiers},
        }

    plurality = definition("plurality", 1, 3, 0, 1, 2, 3, ["tier-0", "tier-2"])
    approval = definition("approval", 2, 4, 1, 2, 3, 4, ["tier-1"])
    elections = {"plurality": plurality, "approval": approval}

    proofs = {}

    def prove(pid, group, index, election, tier, bh, ref):
        """A witness proving member `index` of `group` against its own root, for message M over `bh`."""
        g = groups[group]
        s = g["secrets"][index]
        sc = scope_field(election["definitionHash"], tier, g["root"])
        msg = rev.message(election["definitionHash"], tier, bh, ref[0], ref[1])
        proofs[pid] = {
            "id": pid,
            "witness": {
                "secret": str(s),
                "merkleProofLength": DEPTH,
                "merkleProofIndex": index,
                "merkleProofSiblings": [str(x) for x in g["path"](index)],
                "message": str(mem.field_map(msg)),
                "scope": str(sc),
            },
            "expect": {"root": str(g["root"]), "nullifier": str(pos(sc, s))},
        }

    def nullifier(group, index, election, tier):
        g = groups[group]
        return pos(scope_field(election["definitionHash"], tier, g["root"]), g["secrets"][index])

    def ref(label):
        return (21_000_000 + int.from_bytes(det("ref " + label)[:2], "big"), det("ref hash " + label))

    def ballot(label, election, tier, nul, votes, share_hashes=None, ref_label=None, vote_election=None, cheat=None):
        e = vote_election or election
        ctx = validity_ctx(e, tier, nul)
        vote, _, _ = bv.make_ballot("ballot/" + label, ctx, votes, share_hashes=share_hashes, cheat=cheat)
        r = ref(ref_label or label)
        return {
            "definitionHash": election["definitionHash"],
            "tier": tier,
            "nullifier": nul,
            "l1RefNumber": r[0],
            "l1RefHash": r[1],
            "vote": vote,
            "committedVote": bv.enc_committed_vote(vote),
        }

    def bh_of(b):
        return ballot_hash(b["definitionHash"], b["tier"], b["nullifier"], b["committedVote"])

    zero3 = [det("share 1"), det("share 2"), bytes(32)]
    full3 = [det("share 1"), det("share 2"), det("share 3")]
    cases = []

    def case(cid, description, election, registered, b, proof, expect=None):
        cases.append(
            {"id": cid, "description": description, "election": election, "registered": registered, "ballot": b, "proof": proof, "expect": expect or cid}
        )

    # Honest ballots.
    p, a2 = plurality, approval
    n_a = nullifier("tier-0", 1, p, 0)
    b1 = ballot("tier-0", p, 0, n_a, [0, 1, 0], zero3)
    prove("tier-0", "tier-0", 1, p, 0, bh_of(b1), (b1["l1RefNumber"], b1["l1RefHash"]))
    case("ok-tier-0", "A tier 0 member's plurality ballot; seat 3 isn't registered and its share hash is zero", "plurality", [1, 2], b1, "tier-0", "ok")
    prove("tier-0-again", "tier-0", 1, p, 0, bh_of(b1), (b1["l1RefNumber"], b1["l1RefHash"]))
    case("ok-reproved", "The same ballot with a second proof of the same statement: other proof bytes, the same M (a repeat, decided by selection)", "plurality", [1, 2], b1, "tier-0-again", "ok")

    b_rev = ballot("revote", p, 0, n_a, [1, 0, 0], zero3)
    prove("revote", "tier-0", 1, p, 0, bh_of(b_rev), (b_rev["l1RefNumber"], b_rev["l1RefHash"]))
    case("ok-revote", "The same member's re-vote: the same nullifier under another L1 block and vote", "plurality", [1, 2], b_rev, "revote", "ok")

    n_b = nullifier("tier-2", 2, p, 2)
    b2 = ballot("tier-2", p, 2, n_b, [0, 0, 0], zero3)
    prove("tier-2", "tier-2", 2, p, 2, bh_of(b2), (b2["l1RefNumber"], b2["l1RefHash"]))
    case("ok-tier-2-blank", "A tier 2 member's blank plurality ballot", "plurality", [1, 2], b2, "tier-2", "ok")

    n_c = nullifier("tier-0", 4, p, 0)
    b3 = ballot("all-seats", p, 0, n_c, [0, 0, 1], full3)
    prove("all-seats", "tier-0", 4, p, 0, bh_of(b3), (b3["l1RefNumber"], b3["l1RefHash"]))
    case("ok-every-seat", "A ballot with a share hash at every seat, under a key set that registers all three", "plurality", [1, 2, 3], b3, "all-seats", "ok")
    case("share-hash-unqualified", "The same ballot when seat 3 isn't registered: its share hash isn't 32 zero bytes", "plurality", [1, 2], b3, "all-seats")

    n_d = nullifier("tier-1", 0, a2, 1)
    b4 = ballot("approval", a2, 1, n_d, [1, 0, 1, 0], [det("share a1"), det("share a2"), det("share a3"), det("share a4")])
    prove("approval", "tier-1", 0, a2, 1, bh_of(b4), (b4["l1RefNumber"], b4["l1RefHash"]))
    case("ok-approval", "An approval ballot selecting two of four options", "approval", [1, 2, 3, 4], b4, "approval", "ok")

    # Rejected before the membership proof.
    case("ballot-stray", "The approval election's ballot, checked as a ballot of the plurality election", "plurality", [1, 2], b4, "approval")
    b5 = dict(b1, tier=1)
    case("ballot-tier", "A ballot naming tier 1, which the plurality election doesn't list", "plurality", [1, 2], b5, "tier-0")
    b6 = ballot("shape", p, 0, n_a, [0, 1, 0, 0], zero3, vote_election=dict(p, optionCount=4))
    case("validity-shape", "A committed vote with four options in a three-option election", "plurality", [1, 2], b6, "tier-0")

    # Membership failures.
    b7 = dict(b1, l1RefNumber=b1["l1RefNumber"] + 1)
    case("membership-ref-changed", "The tier 0 ballot naming the next L1 block: M changes, so its proof fails", "plurality", [1, 2], b7, "tier-0", "membership-proof")
    b8 = dict(b1, l1RefHash=det("ref hash other"))
    case("membership-ref-hash-changed", "The tier 0 ballot naming another hash for its block", "plurality", [1, 2], b8, "tier-0", "membership-proof")
    case("membership-other-proof", "The tier 0 ballot carrying the tier 2 ballot's valid proof", "plurality", [1, 2], b1, "tier-2", "membership-proof")

    # A tier 0 member's proof (tier 0's root and scope) on a ballot labelled tier 2.
    n_e = nullifier("tier-0", 2, p, 0)
    b9 = ballot("other-tier", p, 2, n_e, [1, 0, 0], zero3)
    prove("other-tier", "tier-0", 2, p, 0, bh_of(b9), (b9["l1RefNumber"], b9["l1RefHash"]))
    # The message names tier 2, as the record does; only the root and scope are tier 0's.
    msg = rev.message(p["definitionHash"], 2, bh_of(b9), b9["l1RefNumber"], b9["l1RefHash"])
    proofs["other-tier"]["witness"]["message"] = str(mem.field_map(msg))
    case("membership-other-tier", "A tier 0 member's proof under tier 0's root and scope, on a ballot labelled tier 2", "plurality", [1, 2], b9, "other-tier", "membership-proof")

    # The record's nullifier isn't the one the circuit outputs.
    n_fake = (n_a + 1) % R
    b10 = ballot("other-nullifier", p, 0, n_fake, [0, 1, 0], zero3)
    prove("other-nullifier", "tier-0", 1, p, 0, bh_of(b10), (b10["l1RefNumber"], b10["l1RefHash"]))
    case("membership-other-nullifier", "A proof over the record's M whose circuit nullifier isn't the record's (the record's is one more)", "plurality", [1, 2], b10, "other-nullifier", "membership-proof")

    # Someone outside the tier proving against their own tree.
    n_f = nullifier("outsiders", 0, p, 0)
    b11 = ballot("outsider", p, 0, n_f, [0, 1, 0], zero3)
    prove("outsider", "outsiders", 0, p, 0, bh_of(b11), (b11["l1RefNumber"], b11["l1RefHash"]))
    case("membership-non-member", "A non-member's proof against a tree of their own, under that tree's scope", "plurality", [1, 2], b11, "outsider", "membership-proof")

    # Validity failures behind a valid membership proof.
    n_g = nullifier("tier-0", 3, p, 0)
    b12 = ballot("vote-of-two", p, 0, n_g, [0, 2, 0], zero3)
    prove("vote-of-two", "tier-0", 3, p, 0, bh_of(b12), (b12["l1RefNumber"], b12["l1RefHash"]))
    case("option-proof", "A member's ballot with a vote of 2 for option 1", "plurality", [1, 2], b12, "vote-of-two")
    b13 = ballot("over-vote", p, 0, n_g, [1, 1, 0], zero3)
    prove("over-vote", "tier-0", 3, p, 0, bh_of(b13), (b13["l1RefNumber"], b13["l1RefHash"]))
    case("sum-proof", "A member's plurality over-vote: two options, each proved 0 or 1", "plurality", [1, 2], b13, "over-vote")

    # The order of the checks, where two would fail: the earlier code is the result.
    case("order-unqualified-before-membership", "An unregistered seat's share hash and another ballot's proof: share-hash-unqualified comes first", "plurality", [1, 2], b3, "tier-2", "share-hash-unqualified")
    case("order-membership-before-option", "A vote of 2 and another ballot's proof: membership-proof comes first", "plurality", [1, 2], b12, "tier-0", "membership-proof")

    checks = []
    for c in cases:
        e = elections[c["election"]]
        sig = verifier_signals(e, c["ballot"])
        if sig is not None:
            checks.append({"case": c["id"], "proof": c["proof"], "signals": {k: str(v) for k, v in sig.items()}})
    return {"groups": groups, "elections": elections, "proofs": proofs, "cases": cases, "checks": checks}


def hexb(b):
    return b.hex()


def statements(constants, out):
    s = build(constants)
    pathlib.Path(out).write_text(
        json.dumps({"proofs": list(s["proofs"].values()), "checks": s["checks"]}, indent=2) + "\n"
    )


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
            "tiers": [
                {"tier": t, "group": v["group"], "root": str(v["root"]), "scope": str(scope_field(e["definitionHash"], t, v["root"]))}
                for t, v in sorted(e["tiers"].items())
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
        v = {
            "id": c["id"],
            "description": c["description"],
            "election": c["election"],
            "registered": c["registered"],
            "encoding": hexb(record(c)),
            "ballotHash": hexb(ballot_hash(b["definitionHash"], b["tier"], b["nullifier"], b["committedVote"])),
        }
        if sig is not None:
            msg = rev.message(b["definitionHash"], b["tier"], bytes.fromhex(v["ballotHash"]), b["l1RefNumber"], b["l1RefHash"])
            v["message"] = hexb(msg)
            v["signals"] = {k: str(x) for k, x in sig.items()}
            v["snarkjs"] = verdict
        v["result"] = code
        if option is not None:
            v["option"] = option
        ballots.append(v)

    good = bytes.fromhex(ballots[0]["encoding"])
    assert ballots[0]["id"] == "ok-tier-0"
    proof_at = 3 + 32 + 1 + 32 + 8 + 32
    vote_at = proof_at + PROOF_LEN

    def with_bytes(at, new):
        return good[:at] + new + good[at + len(new):]

    vss_count = int.from_bytes(good[vote_at:vote_at + 4], "big")
    assert vss_count == 3
    first_element = vote_at + 4 + 4
    decode = [
        ("truncated", "The tier 0 ballot without its last byte", good[:-1], "truncated", None),
        ("trailing-byte", "The tier 0 ballot with a byte after its sum proof", good + b"\x00", "trailing-bytes", len(good)),
        ("header-only", "A ballot record header with nothing after it", good[:3], "truncated", 3),
        ("tier-3", "Tier 3, which no definition can list", with_bytes(35, b"\x03"), "invalid-enum", 35),
        ("nullifier-r", "A nullifier equal to the BN254 scalar field order", with_bytes(36, R.to_bytes(32, "big")), "non-canonical", 36),
        ("proof-a-identity", "A membership proof whose A is all zeros (the identity)", with_bytes(proof_at, bytes(64)), "non-canonical", proof_at),
        ("proof-a-off-curve", "A membership proof whose A is (1, 1), not on the curve", with_bytes(proof_at, (1).to_bytes(32, "big") * 2), "non-canonical", proof_at),
        ("proof-c-coordinate-p", "A membership proof whose C has x at the base field order", with_bytes(proof_at + 192, bytes.fromhex("30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47")), "non-canonical", proof_at + 192),
        ("vss-identity", "A committed vote whose first VSS commitment is the identity", with_bytes(first_element, bytes(32)), "non-canonical", first_element),
        ("version-2", "Version 2, which no profile can pin yet (the pinned version is 1)", with_bytes(2, b"\x02"), "profile-mismatch", 2),
        ("other-type", "Record type 0x000c, a share receipt's: in this file the only known type is 0x0002 (notation.md, Strict decoding)", with_bytes(0, b"\x00\x0c"), "unknown-record-type", 0),
    ]
    decode_vectors = []
    for did, desc, enc, err, at in decode:
        dvec = {"id": did, "description": desc, "encoding": hexb(enc), "error": err}
        if at is not None:
            dvec["offset"] = at
        decode_vectors.append(dvec)

    out = {
        "format": "abolish-ballot-vectors/1",
        "title": "Ballot record, version 1: encodings, admission checks and decode rejections",
        "spec": "docs/spec/ballot-validity.md",
        "generator": (
            "packages/crypto/scripts/ballot-vectors.py, an implementation of the Ballot record section with Python's integers "
            "and hashlib, reusing this folder's independent ballot-validity, membership, revoting, tier-tree and definition "
            "generators and its own self-checked Baby Jubjub; membership proofs by packages/crypto/scripts/ballot-proofs.mjs, "
            "run outside the workspace with Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5's fullProve, which "
            "checks that each proof's outputs equal the root and nullifier computed here; every pairing verdict is snarkjs's "
            "groth16.verify on the signals derived here from the record. Decode errors and their offsets are labelled by hand "
            "from the strict-decoding rules and the layout's fixed offsets"
        ),
        "recordType": "0x0002",
        "version": 1,
        "groups": [
            {"id": name, "tier": g["tier"], "secrets": [str(x) for x in g["secrets"]], "leaves": [str(x) for x in g["leaves"]], "root": str(g["root"])}
            for name, g in s["groups"].items()
        ],
        "elections": elections,
        "ballots": ballots,
        "decode": decode_vectors,
    }
    (pathlib.Path(out_dir) / "ballot.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    cmd = sys.argv[1]
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: ballot-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
