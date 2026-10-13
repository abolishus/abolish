#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/intake.json.

A second implementation of docs/spec/share-encryption.md (Intake and
receipts) on a delivered ballot record: strict decoding under the pinned
ballot version (labelled by hand, as ballot-vectors.py labels its decode
rejections), the admission checks of docs/spec/ballot-validity.md in their
order with `share-hash` between `share-hash-unqualified` and
`membership-proof`, then the trustee's decryption, and the share receipt it
signs. It is written from the spec with Python's integers and hashlib and
shares no code with packages/crypto. It reuses this folder's independent
generators: ballot-vectors.py and ballot-v2-vectors.py (their elections,
electorates, Baby Jubjub, Poseidon, trees, records and signals),
share-encryption-vectors.py (trustee KEM keys, encryption and decryption) and
share-receipt-vectors.py (the receipt statement and its RFC 6979 P-256
signature).

Membership proofs need a Groth16 prover, so generation has three steps, as
for ballot-vectors.py:

  python3 -I -B intake-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B intake-vectors.py assemble <constants> <work>/proofs.json <out-dir>

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


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


b1 = _load("ballot_vectors", "ballot-vectors.py")
b2 = _load("ballot_v2_vectors", "ballot-v2-vectors.py")
sr = _load("share_receipt_vectors", "share-receipt-vectors.py")
se, ecdsa = sr.se, sr.ecdsa
bv, mem, rev = b1.bv, b1.mem, b1.rev

DEPTH = 32
PANEL = 3


def det(label):
    return b1.det("intake " + label)


def signing_secret(seat):
    return ecdsa.secret(f"intake/signing/{seat}".encode())


def shape_ok(ctx, vote):
    return (
        len(vote["vss"]) == ctx["optionCount"]
        and all(len(e) == ctx["threshold"] for e in vote["vss"])
        and len(vote["shareHashes"]) == ctx["panelSize"]
        and len(vote["optionProofs"]) == ctx["optionCount"]
        and len(vote["sumProof"]) == ctx["max"] - ctx["min"] + 1
    )


def intake(election, version, registered, seat, keys, b, ct, verdict):
    """Steps 2 to 5 of intake on a decoded record, in the spec's order; `verdict` is snarkjs's on the signals derived here."""
    if b["definitionHash"] != election["definitionHash"]:
        return {"code": "ballot-stray"}
    if version == 1:
        if b["tier"] not in election["tiers"]:
            return {"code": "ballot-tier"}
        ctx = b1.validity_ctx(election, b["tier"], b["nullifier"])
    else:
        if b["cell"] >= len(election["cells"]):
            return {"code": "ballot-cell"}
        ctx = b2.validity_ctx(election, b["cell"], b["nullifier"])
    vote = b["vote"]
    if not shape_ok(ctx, vote):
        return {"code": "validity-shape"}
    for s in range(1, ctx["panelSize"] + 1):
        if s not in registered and vote["shareHashes"][s - 1] != bytes(32):
            return {"code": "share-hash-unqualified"}
    sh = se.share_hash(ct)
    if sh != vote["shareHashes"][seat - 1]:
        return {"code": "share-hash"}
    if not verdict:
        return {"code": "membership-proof"}
    v = bv.check_validity(ctx, vote)
    if v != "ok":
        return v
    got = se.decrypt(election["definitionHash"], seat, keys[seat - 1], vote["vss"], ct)
    if got != "ok":
        return {"code": got}
    if version == 1:
        bh = b1.ballot_hash(b["definitionHash"], b["tier"], b["nullifier"], b["committedVote"])
        tier = b["tier"]
    else:
        bh = b2.ballot_hash(b["definitionHash"], b["cell"], b["nullifier"], b["committedVote"])
        tier = election["cells"][b["cell"]]["tier"]
    m = sr.statement(election["definitionHash"], bh, seat, sh)
    msg = rev.message(b["definitionHash"], tier, bh, b["l1RefNumber"], b["l1RefHash"])
    return {
        "code": "ok",
        "ballotHash": bh,
        "shareHash": sh,
        "statement": m,
        "receipt": sr.sign(signing_secret(seat), m),
        "tier": tier,
        "message": msg,
    }


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    s1 = b1.build(constants)
    s2 = b2.build(constants)
    pos = b1.Poseidon(constants)
    keys = se.trustee_keys("intake", PANEL)

    proofs = {}
    cases = []

    def ref(label):
        return (21_000_000 + int.from_bytes(det("ref " + label)[:2], "big"), det("ref hash " + label))

    def encrypted(label, ctx, votes, registered, cheat=None):
        """A committed vote whose share hashes are its own ciphertexts' (zero for unregistered seats); `cheat` alters seat 1's ciphertext."""
        n = ctx["panelSize"]
        first, _, shares = bv.make_ballot("intake/" + label, ctx, votes, share_hashes=[bytes(32)] * n)
        vss = first["vss"]
        rng = bv.Rng("intake/encapsulation/" + label)
        cts = []
        for seat in range(1, n + 1):
            if seat not in registered:
                cts.append(None)
                continue
            m, e, w = rng.bytes32(), se.nonzero_scalar(rng), se.nonzero_scalar(rng)
            sb = bv.enc_shares(shares[seat - 1])
            if cheat == "other-shares" and seat == 1:
                # Seat 2's shares, sealed correctly to seat 1: they open but fail the check.
                sb = bv.enc_shares(shares[1])
            ct, _ = se.encrypt(ctx["definitionHash"], seat, keys[seat - 1], vss, sb, m, e, w)
            if cheat == "flipped-seal" and seat == 1:
                # The last byte of the AEAD tag: the proof of knowledge binds `sealed`.
                ct = ct[:-1] + bytes([ct[-1] ^ 1])
            cts.append(ct)
        hashes = [bytes(32) if ct is None else se.share_hash(ct) for ct in cts]
        vote, _, _ = bv.make_ballot("intake/" + label, ctx, votes, share_hashes=hashes)
        assert vote["vss"] == vss
        return vote, cts

    # --- Version 1: ballot-vectors.py's plurality election (tiers 0 and 2, k = 2, n = 3).

    p = s1["elections"]["plurality"]
    groups = s1["groups"]

    def nullifier1(group, index, tier):
        g = groups[group]
        return pos(b1.scope_field(p["definitionHash"], tier, g["root"]), g["secrets"][index])

    def ballot1(label, group, index, tier, votes, registered=(1, 2, 3), cheat=None, options=None):
        nul = nullifier1(group, index, tier)
        e = p if options is None else dict(p, optionCount=options)
        vote, cts = encrypted(label, b1.validity_ctx(e, tier, nul), votes, registered, cheat)
        r = ref(label)
        b = {
            "version": 1,
            "election": "plurality",
            "definitionHash": p["definitionHash"],
            "tier": tier,
            "nullifier": nul,
            "l1RefNumber": r[0],
            "l1RefHash": r[1],
            "vote": vote,
            "committedVote": bv.enc_committed_vote(vote),
            "cts": cts,
        }
        bh = b1.ballot_hash(b["definitionHash"], tier, nul, b["committedVote"])
        g = groups[group]
        sc = b1.scope_field(p["definitionHash"], tier, g["root"])
        msg = rev.message(p["definitionHash"], tier, bh, r[0], r[1])
        proofs[label] = {
            "id": label,
            "witness": {
                "secret": str(g["secrets"][index]),
                "merkleProofLength": DEPTH,
                "merkleProofIndex": index,
                "merkleProofSiblings": [str(x) for x in g["path"](index)],
                "message": str(mem.field_map(msg)),
                "scope": str(sc),
            },
            "expect": {"root": str(g["root"]), "nullifier": str(pos(sc, g["secrets"][index]))},
        }
        b["proof"] = label
        return b

    def case(cid, description, b, seat, ct, registered=(1, 2, 3), expect=None, record=None):
        cases.append({
            "id": cid,
            "description": description,
            "ballot": b,
            "seat": seat,
            "ciphertext": ct,
            "registered": list(registered),
            "expect": expect or cid,
            "record": record,
        })

    ok = ballot1("tier-0", "tier-0", 0, 0, [0, 1, 0])
    for seat in (1, 2, 3):
        case(f"ok-seat-{seat}", f"A tier 0 member's ballot, delivered to seat {seat} with its own ciphertext", ok, seat, ok["cts"][seat - 1], expect="ok")
    blank = ballot1("tier-2-blank", "tier-2", 0, 2, [0, 0, 0])
    case("ok-tier-2-blank", "A tier 2 member's blank ballot at seat 2", blank, 2, blank["cts"][1], expect="ok")

    case("delivery-malformed-truncated", "The tier 0 ballot without its last byte", ok, 1, ok["cts"][0], expect="delivery-malformed", record="truncated")
    case("delivery-malformed-version", "The tier 0 ballot under version 2, which the election doesn't pin", ok, 1, ok["cts"][0], expect="delivery-malformed", record="version-2")
    case("ballot-stray", "The tier 0 ballot naming the approval election's definition hash", dict(ok, definitionHash=s1["elections"]["approval"]["definitionHash"]), 1, ok["cts"][0])
    case("ballot-tier", "The tier 0 ballot naming tier 1, which the election doesn't list", dict(ok, tier=1), 1, ok["cts"][0])
    shape = ballot1("shape", "tier-0", 1, 0, [0, 1, 0, 0], options=4)
    case("validity-shape", "A committed vote with four options in a three-option election", shape, 1, shape["cts"][0])
    case("share-hash-unqualified", "The tier 0 ballot under a key set without seat 3, whose share hash isn't zero", ok, 1, ok["cts"][0], registered=(1, 2))
    case("share-hash", "Seat 2's ciphertext delivered to seat 1", ok, 1, ok["cts"][1])
    case("order-shape-before-share-hash", "A four-option vote and seat 2's ciphertext at seat 1: validity-shape comes first", shape, 1, shape["cts"][1], expect="validity-shape")
    case("order-unqualified-before-share-hash", "Seat 3 unregistered with a share hash, and seat 2's ciphertext at seat 1: share-hash-unqualified comes first", ok, 1, ok["cts"][1], registered=(1, 2), expect="share-hash-unqualified")
    moved = dict(ok, l1RefNumber=ok["l1RefNumber"] + 1)
    case("membership-ref-changed", "The tier 0 ballot naming the next L1 block: M changes, so its proof fails", moved, 1, ok["cts"][0], expect="membership-proof")
    case("order-share-hash-before-membership", "A failing membership proof and seat 2's ciphertext at seat 1: share-hash comes first", moved, 1, ok["cts"][1], expect="share-hash")
    outsider = ballot1("outsider", "outsiders", 0, 0, [0, 1, 0])
    case("membership-non-member", "A non-member's ballot, proved against a tree of their own under that tree's scope", outsider, 1, outsider["cts"][0], expect="membership-proof")
    case("membership-other-proof", "The tier 0 ballot carrying the tier 2 ballot's valid proof", dict(ok, proof="tier-2-blank"), 1, ok["cts"][0], expect="membership-proof")
    two = ballot1("vote-of-two", "tier-0", 2, 0, [0, 2, 0])
    case("option-proof", "A member's ballot with a vote of 2 for option 1, whose shares open", two, 1, two["cts"][0])
    over = ballot1("over-vote", "tier-0", 2, 0, [1, 1, 0])
    case("sum-proof", "A member's plurality over-vote, whose shares open", over, 1, over["cts"][0])
    seal = ballot1("flipped-seal", "tier-0", 3, 0, [1, 0, 0], cheat="flipped-seal")
    case("share-proof", "A member's valid ballot whose client flipped a tag byte of seat 1's ciphertext after proving it", seal, 1, seal["cts"][0])
    case("ok-beside-bad-seat", "The same ballot at seat 2, whose ciphertext is honest", seal, 2, seal["cts"][1], expect="ok")
    wrong = ballot1("other-shares", "tier-0", 4, 0, [0, 0, 1], cheat="other-shares")
    case("share-check", "A member's valid ballot whose client sealed seat 2's shares to seat 1", wrong, 1, wrong["cts"][0])
    case("order-membership-before-option", "A vote of 2 and a failing membership proof: membership-proof comes first", dict(two, l1RefNumber=two["l1RefNumber"] + 1), 1, two["cts"][0], expect="membership-proof")
    case("order-membership-before-decryption", "Seat 2's shares sealed to seat 1 and a failing membership proof: membership-proof comes first", dict(wrong, l1RefNumber=wrong["l1RefNumber"] + 1), 1, wrong["cts"][0], expect="membership-proof")

    # --- Version 2: ballot-v2-vectors.py's regional election (cells 0 and 1 of tier 0, cell 2 of tier 2).

    rg = s2["elections"]["regional"]
    cells = s2["cells"]
    secrets = s2["secrets"]

    def where(label, cell):
        c = cells[cell]
        for g in s2["groups"]:
            if g["group_id"] in c["offsets"]:
                for i, (kind, lab) in enumerate(g["members"]):
                    if kind == "real" and lab == label:
                        return c["offsets"][g["group_id"]] + i
        raise KeyError((label, cell))

    def ballot2(label, member, cell, votes):
        c = cells[cell]
        sc = b1.scope_field(rg["definitionHash"], c["tier"], c["root"])
        nul = pos(sc, secrets[member])
        vote, cts = encrypted("v2/" + label, b2.validity_ctx(rg, cell, nul), votes, (1, 2, 3))
        r = ref("v2/" + label)
        b = {
            "version": 2,
            "election": "regional",
            "definitionHash": rg["definitionHash"],
            "cell": cell,
            "nullifier": nul,
            "l1RefNumber": r[0],
            "l1RefHash": r[1],
            "vote": vote,
            "committedVote": bv.enc_committed_vote(vote),
            "cts": cts,
        }
        bh = b2.ballot_hash(b["definitionHash"], cell, nul, b["committedVote"])
        msg = rev.message(rg["definitionHash"], c["tier"], bh, r[0], r[1])
        i = where(member, cell)
        pid = "v2/" + label
        proofs[pid] = {
            "id": pid,
            "witness": {
                "secret": str(secrets[member]),
                "merkleProofLength": DEPTH,
                "merkleProofIndex": i,
                "merkleProofSiblings": [str(x) for x in c["path"](i)],
                "message": str(mem.field_map(msg)),
                "scope": str(sc),
            },
            "expect": {"root": str(c["root"]), "nullifier": str(pos(sc, secrets[member]))},
        }
        b["proof"] = pid
        return b

    c0 = ballot2("cell-0", "r0/0", 0, [0, 1, 0])
    case("v2-ok-cell-0", "A version-2 ballot in cell 0 (tier 0's large region), at seat 1", c0, 1, c0["cts"][0], expect="ok")
    rem = ballot2("remainder", "r2/0", 1, [1, 0, 0])
    case("v2-ok-remainder", "A version-2 ballot in the remainder cell 1, at seat 3", rem, 3, rem["cts"][2], expect="ok")
    case("v2-delivery-malformed-version", "The cell 0 ballot under version 1, which the election doesn't pin", c0, 1, c0["cts"][0], expect="delivery-malformed", record="version-1")
    case("v2-ballot-cell", "The cell 0 ballot naming cell 3: the partition has cells 0 to 2", dict(c0, cell=3), 1, c0["cts"][0], expect="ballot-cell")
    case("v2-share-hash", "Seat 3's ciphertext delivered to seat 1", c0, 1, c0["cts"][2], expect="share-hash")
    case("v2-membership-other-cell", "The cell 0 ballot relabelled as cell 1 of the same tier, with its cell 0 proof", dict(c0, cell=1), 1, c0["cts"][0], expect="membership-proof")
    case("v2-membership-ref-changed", "The cell 0 ballot naming the next L1 block", dict(c0, l1RefNumber=c0["l1RefNumber"] + 1), 1, c0["cts"][0], expect="membership-proof")

    elections = {"plurality": p, "regional": rg}
    checks = []
    for c in cases:
        if c["record"] is not None:
            continue
        sig = signals(elections[c["ballot"]["election"]], c["ballot"])
        if sig is not None:
            checks.append({"case": c["id"], "proof": c["ballot"]["proof"], "signals": {k: str(v) for k, v in sig.items()}})
    return {"elections": elections, "proofs": proofs, "cases": cases, "checks": checks, "keys": keys}


def signals(election, b):
    """[ρ, ν, m̂, ŝ] as a verifier derives them from the record, or None before the membership step."""
    if b["version"] == 1:
        return b1.verifier_signals(election, b)
    return b2.verifier_signals(election, b)


def statements(constants, out):
    s = build(constants)
    pathlib.Path(out).write_text(json.dumps({"proofs": list(s["proofs"].values()), "checks": s["checks"]}, indent=2) + "\n")


def record_of(b, proof):
    if b["version"] == 1:
        return b1.enc_ballot(dict(b, proof=proof))
    return b2.enc_ballot(dict(b, proof=proof))


def assemble(constants, proofs_path, out_dir):
    s = build(constants)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    proof_bytes = {k: bytes.fromhex(v) for k, v in got["proofs"].items()}
    verdicts = got["verdicts"]
    assert set(proof_bytes) == set(s["proofs"])
    keys = s["keys"]

    out_cases = []
    for c in s["cases"]:
        b = c["ballot"]
        e = s["elections"][b["election"]]
        rec = record_of(b, proof_bytes[b["proof"]])
        if c["record"] == "truncated":
            rec = rec[:-1]
        elif c["record"] == "version-2":
            rec = rec[:2] + b"\x02" + rec[3:]
        elif c["record"] == "version-1":
            rec = rec[:2] + b"\x01" + rec[3:]
        if c["record"] is not None:
            result = {"code": "delivery-malformed"}
        else:
            result = intake(e, b["version"], c["registered"], c["seat"], keys, b, c["ciphertext"], verdicts.get(c["id"]))
        assert result["code"] == c["expect"], (c["id"], result["code"])
        v = {
            "id": c["id"],
            "description": c["description"],
            "election": b["election"],
            "registered": c["registered"],
            "seat": c["seat"],
            "record": rec.hex(),
            "ciphertext": c["ciphertext"].hex(),
            "result": result["code"],
        }
        if "option" in result:
            v["option"] = result["option"]
        if c["id"] in verdicts:
            v["snarkjs"] = verdicts[c["id"]]
        if result["code"] == "ok":
            v.update({
                "ballotHash": result["ballotHash"].hex(),
                "shareHash": result["shareHash"].hex(),
                "statement": result["statement"].hex(),
                "receipt": result["receipt"].hex(),
                "tier": result["tier"],
                "nullifier": str(b["nullifier"]),
                "message": result["message"].hex(),
                "l1RefNumber": str(b["l1RefNumber"]),
                "l1RefHash": b["l1RefHash"].hex(),
            })
        out_cases.append(v)

    out = {
        "format": "abolish-intake-vectors/1",
        "title": "Trustee intake of a ballot record: admission with its membership proof, the share hash, decryption and the share receipt",
        "spec": "docs/spec/share-encryption.md",
        "generator": (
            "packages/crypto/scripts/intake-vectors.py, an implementation of Intake and receipts with Python's integers and hashlib, "
            "reusing this folder's independent ballot-vectors.py and ballot-v2-vectors.py (elections, electorates, records, signals), "
            "share-encryption-vectors.py (KEM keys, encryption, decryption) and share-receipt-vectors.py (the receipt and its RFC 6979 "
            "P-256 signature); membership proofs by packages/crypto/scripts/ballot-proofs.mjs, run outside the workspace with Semaphore "
            "4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5's fullProve, and every pairing verdict is snarkjs's groth16.verify on "
            "the signals derived here from the record. The delivery-malformed cases are labelled by hand from the strict-decoding rules"
        ),
        "tags": {"receipt": "abolish/v1/sig/share-receipt"},
        "elections": {
            name: {"version": 1 if name == "plurality" else 2, "definition": e["encoding"].hex(), "definitionHash": e["definitionHash"].hex()}
            for name, e in s["elections"].items()
        },
        "panel": [
            {
                "seat": seat,
                "kem": se.key_json(keys[seat - 1]),
                "signingSecret": f"{signing_secret(seat):064x}",
                "signingKey": sr.p256_key(signing_secret(seat)).hex(),
            }
            for seat in range(1, PANEL + 1)
        ],
        "cases": out_cases,
    }
    (pathlib.Path(out_dir) / "intake.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    cmd = sys.argv[1]
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: intake-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
