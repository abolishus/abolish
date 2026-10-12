#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/share-receipt.json.

A second implementation of docs/spec/ballot-validity.md (Ballot hash) and
docs/spec/share-encryption.md (Intake and receipts): the ballot hash, a
trustee's intake of one ciphertext (validity, share-hash, then decryption),
the share receipt's 97-byte statement and its signature, and the receipt
check. It is written from the spec with Python's integers and hashlib, and
shares no code with packages/crypto or any @noble library. It reuses
share-encryption-vectors.py's ballots, ML-KEM-768, AEAD and decryption (over
ballot-validity-vectors.py and group-vectors.py's self-checked ristretto255)
and trustee-vectors.py's P-256 ECDSA, which reproduces RFC 6979 Appendix A.2.5
first. The ballots of share-encryption.json are re-made from their labels and
checked byte for byte against that file; the valid ballots of
ballot-validity.json are read from it.

Every secret comes from SHA-256 over a fixed label, and each panel lists its
signing secrets, so any RFC 6979 implementation reproduces every receipt. The
values are test data, never keys.

Usage: python3 -I -B packages/crypto/scripts/share-receipt-vectors.py <out-dir>
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


se = _load("share_encryption_vectors", "share-encryption-vectors.py")
ecdsa = _load("trustee_vectors", "trustee-vectors.py")
bv, grp = se.bv, se.grp

L = grp.L
BALLOT_TAG = b"abolish/v1/ballot"
RECEIPT_TAG = b"abolish/v1/sig/share-receipt"
OTHER_TAG = b"abolish/v1/sig/tally-opening"

u8, u16 = bv.u8, bv.u16


# --- Ballot hash -----------------------------------------------------------------


def ballot_hash(ctx, committed_vote):
    """H(DS("abolish/v1/ballot", definition_hash ‖ u16(0x0002) ‖ u8(1) ‖ u8(tier) ‖ encode(ν) ‖ encode(committed vote)))."""
    m = ctx["definitionHash"] + u16(0x0002) + u8(1) + u8(ctx["tier"]) + bv.field(ctx["nullifier"]) + committed_vote
    return bv.H(bv.ds(BALLOT_TAG, m))


# --- Intake and receipts ---------------------------------------------------------


def statement(definition_hash, b_hash, seat, share_hash):
    """m = definition_hash ‖ ballot_hash ‖ u8(i) ‖ H(ct_i): 97 bytes."""
    m = definition_hash + b_hash + u8(seat) + share_hash
    assert len(m) == 97
    return m


def sign(d, m, tag=RECEIPT_TAG):
    _, r, s = ecdsa.ecdsa_sign(d, bv.ds(tag, m))
    return ecdsa.sig_bytes(r, s)


def p256_key(d):
    return ecdsa.compress(ecdsa.mul(d, ecdsa.G))


def intake(ctx, seat, kem_key, signing_secret, vote, ct):
    """Validity, then share-hash, then decryption steps 1 to 5; the receipt only if all pass."""
    v = bv.check_validity(ctx, vote)
    if v != "ok":
        return v, None
    sh = se.share_hash(ct)
    if sh != vote["shareHashes"][seat - 1]:
        return {"code": "share-hash"}, None
    got = se.decrypt(ctx["definitionHash"], seat, kem_key, vote["vss"], ct)
    if got != "ok":
        return {"code": got}, None
    b_hash = ballot_hash(ctx, bv.enc_committed_vote(vote))
    m = statement(ctx["definitionHash"], b_hash, seat, sh)
    return "ok", {"ballotHash": b_hash, "shareHash": sh, "statement": m, "receipt": sign(signing_secret, m)}


def check_receipt(signers, definition_hash, b_hash, seat, share_hash, sig):
    """share-receipt: the seat has a registered signing key and the signature verifies under it."""
    key = signers.get(seat)
    if key is None:
        return False
    return ecdsa.verify(key, bv.ds(RECEIPT_TAG, statement(definition_hash, b_hash, seat, share_hash)), sig)


# --- Vectors ---------------------------------------------------------------------


def main():
    grp.self_check()
    ecdsa.self_check()
    se.aead_self_check()
    se.mlkem_self_check(100)
    out = sys.argv[1]

    # Ballot hashes of ballot-validity.json's valid ballots, from their encodings.
    validity = json.loads((VECTORS / "ballot-validity.json").read_text())
    hashes = []
    for b in validity["ballots"]:
        if b["result"] != "ok":
            continue
        c = b["context"]
        ctx = {"definitionHash": bytes.fromhex(c["definitionHash"]), "tier": c["tier"], "nullifier": int(c["nullifier"])}
        enc = bytes.fromhex(b["encoding"])
        hashes.append({"source": "ballot-validity.json", "ballot": b["id"], "ballotHash": ballot_hash(ctx, enc).hex()})

    # share-encryption.json's ballots, re-made from their labels.
    shared = json.loads((VECTORS / "share-encryption.json").read_text())
    keys = {name: se.trustee_keys(name, n) for name, n in (("panel-3", 3), ("panel-2", 2), ("panel-16", 16))}
    for name, ks in keys.items():
        assert [se.key_json(k) for k in ks] == shared["panels"][name], name
    plural = bv.context("share-plurality", 3, 0, 1, 2, 3)
    wide = bv.context("share-options-max", 64, 0, 64, 2, 2, 1)
    many = bv.context("share-trustees-max", 2, 0, 1, 16, 16)
    contexts = {"plurality": plural, "options-max": wide, "trustees-max": many}
    for id_ in ("bad-share", "bad-seal", "short-list", "copied-ephemeral"):
        contexts[id_] = plural
    made = {}
    by_id = {b["id"]: b for b in shared["ballots"]}
    for id_, entry in by_id.items():
        ctx = contexts[id_]
        cts = [bytes.fromhex(c) for c in entry["ciphertexts"]]
        _, _, shares = bv.make_ballot("ballot/" + id_, ctx, entry["votes"], share_hashes=[se.share_hash(c) for c in cts])
        vote, _, _ = bv.make_ballot("ballot/" + id_, ctx, entry["votes"], share_hashes=[se.share_hash(c) for c in cts])
        assert bv.enc_committed_vote(vote).hex() == entry["committedVote"], id_
        made[id_] = {"ctx": ctx, "vote": vote, "cts": cts, "keys": keys[entry["panel"]], "panel": entry["panel"]}
        hashes.append({"source": "share-encryption.json", "ballot": id_, "ballotHash": ballot_hash(ctx, bytes.fromhex(entry["committedVote"])).hex()})

    # Each seat's per-election signing secret, and the identity secret it doesn't sign receipts with.
    def signing_secret(panel, seat):
        return ecdsa.secret(f"share-receipt/{panel}/signing/{seat}".encode())

    def identity_secret(panel, seat):
        return ecdsa.secret(f"share-receipt/{panel}/identity/{seat}".encode())

    panels = {}
    for name, ks in keys.items():
        panels[name] = [
            {
                "seat": seat,
                "signingSecret": f"{signing_secret(name, seat):064x}",
                "signingKey": p256_key(signing_secret(name, seat)).hex(),
                "identityKey": p256_key(identity_secret(name, seat)).hex(),
            }
            for seat in range(1, len(ks) + 1)
        ]

    def signers(panel):
        return {s["seat"]: bytes.fromhex(s["signingKey"]) for s in panels[panel]}

    # Every seat's intake of every ballot.
    intakes = []
    receipts = {}
    for id_, b in made.items():
        for seat in range(1, b["ctx"]["panelSize"] + 1):
            want = by_id[id_]["decryptions"][seat - 1]["result"]
            result, r = intake(b["ctx"], seat, b["keys"][seat - 1], signing_secret(b["panel"], seat), b["vote"], b["cts"][seat - 1])
            assert (result if result == "ok" else result["code"]) == want, (id_, seat, result, want)
            entry = {"ballot": id_, "seat": seat, "result": want}
            if r is not None:
                receipts[(id_, seat)] = r
                entry.update(
                    ballotHash=r["ballotHash"].hex(),
                    shareHash=r["shareHash"].hex(),
                    statement=r["statement"].hex(),
                    receipt=r["receipt"].hex(),
                )
                assert check_receipt(signers(b["panel"]), b["ctx"]["definitionHash"], r["ballotHash"], seat, r["shareHash"], r["receipt"])
            intakes.append(entry)

    # Intakes failing before decryption: delivered under another context, or with an altered committed vote.
    p = made["plurality"]
    failures = []

    def fail(id_, desc, seat, ct, expect, ctx=None, vote=None, option=None):
        ctx = ctx or p["ctx"]
        vote = vote or p["vote"]
        result, r = intake(ctx, seat, p["keys"][seat - 1], signing_secret("panel-3", seat), vote, ct)
        want = {"code": expect} if option is None else {"code": expect, "option": option}
        assert r is None and result == want, (id_, result)
        entry = {
            "id": id_,
            "description": desc,
            "context": bv.ctx_json(ctx),
            "seat": seat,
            "committedVote": bv.enc_committed_vote(vote).hex(),
            "ciphertext": ct.hex(),
            "result": expect,
        }
        if option is not None:
            entry["option"] = option
        failures.append(entry)

    def ctx_with(**kw):
        return dict(p["ctx"], **kw)

    def vote_with(**kw):
        return dict(p["vote"], **kw)

    ct1, ct2 = p["cts"][0], p["cts"][1]
    fail("other-options", "Delivered under a definition with 4 options", 1, ct1, "validity-shape", ctx=ctx_with(optionCount=4))
    fail("other-panel", "Delivered under a panel of 4 seats: 3 share hashes", 1, ct1, "validity-shape", ctx=ctx_with(panelSize=4))
    fail("other-tier", "Delivered under tier 1: every proof binds tier 0", 1, ct1, "option-proof", ctx=ctx_with(tier=1), option=0)
    fail("other-nullifier", "Delivered under another nullifier", 1, ct1, "option-proof", ctx=ctx_with(nullifier=(p["ctx"]["nullifier"] + 1) % bv.R), option=0)
    proofs = p["vote"]["optionProofs"]
    fail("swapped-proofs", "Options 0 and 1 carry each other's proofs", 1, ct1, "option-proof", vote=vote_with(optionProofs=[proofs[1], proofs[0], proofs[2]]), option=0)
    sp = [dict(x) for x in p["vote"]["sumProof"]]
    sp[0]["z"] = (sp[0]["z"] + 1) % L
    fail("altered-sum-proof", "The sum proof's first response + 1", 1, ct1, "sum-proof", vote=vote_with(sumProof=sp))
    fail("other-seat-ciphertext", "Seat 1 is delivered seat 2's ciphertext", 1, ct2, "share-hash")
    fail("altered-ciphertext", "Seat 1's ciphertext with its last byte flipped", 1, ct1[:-1] + bytes([ct1[-1] ^ 1]), "share-hash")

    # A ballot whose share hash for seat 1 is the hash of bytes that aren't a ciphertext.
    junk = bytes(range(40))

    def junk_ct(seat, sb, key, vss, m, e, w):
        ct, iv = se.encrypt(plural["definitionHash"], seat, key, vss, sb, m, e, w)
        return (junk, {}) if seat == 1 else (ct, iv)

    jb = se.make_encrypted_ballot("receipt-junk-ciphertext", plural, [1, 0, 0], keys["panel-3"], junk_ct)
    result, r = intake(plural, 1, keys["panel-3"][0], signing_secret("panel-3", 1), jb["vote"], junk)
    assert r is None and result == {"code": "share-malformed"}
    failures.append(
        {
            "id": "malformed-ciphertext",
            "description": "A dishonest client: seat 1's share hash is the hash of 40 bytes that aren't a ciphertext",
            "context": bv.ctx_json(plural),
            "seat": 1,
            "committedVote": bv.enc_committed_vote(jb["vote"]).hex(),
            "ciphertext": junk.hex(),
            "result": "share-malformed",
        }
    )

    # Receipt checks against plurality's seat 1 receipt.
    r1 = receipts[("plurality", 1)]
    r2 = receipts[("plurality", 2)]
    dh_ = plural["definitionHash"]
    bh, sh1, sh2 = r1["ballotHash"], r1["shareHash"], r2["shareHash"]
    other_bh = receipts[("bad-share", 1)]["ballotHash"]
    checks = []

    def check(id_, desc, seat, sig, expect, definition_hash=dh_, b_hash=bh, share_hash=sh1, panel="panel-3"):
        got = check_receipt(signers(panel), definition_hash, b_hash, seat, share_hash, sig)
        assert got == expect, (id_, got)
        checks.append(
            {
                "id": id_,
                "description": desc,
                "panel": panel,
                "definitionHash": definition_hash.hex(),
                "ballotHash": b_hash.hex(),
                "seat": seat,
                "shareHash": share_hash.hex(),
                "signature": sig.hex(),
                "valid": expect,
            }
        )

    m1 = statement(dh_, bh, 1, sh1)
    sig1 = r1["receipt"]
    rr, ss = int.from_bytes(sig1[:32], "big"), int.from_bytes(sig1[32:], "big")
    check("valid", "Seat 1's receipt for the plurality ballot", 1, sig1, True)
    check("valid-seat-2", "Seat 2's receipt for the plurality ballot", 2, r2["receipt"], True, share_hash=sh2)
    check("other-seat", "Seat 1's receipt presented as seat 2's", 2, sig1, False, share_hash=sh2)
    check("other-seat-key", "Seat 1's statement signed with seat 2's signing key", 1, sign(signing_secret("panel-3", 2), m1), False)
    check("identity-key", "Seat 1's statement signed with seat 1's identity key, not its per-election key", 1, sign(identity_secret("panel-3", 1), m1), False)
    m4 = statement(dh_, bh, 4, sh1)
    check("unregistered-seat", "A receipt for seat 4 of a 3-seat panel, signed with seat 1's key", 4, sign(signing_secret("panel-3", 1), m4), False)
    check("other-definition", "Seat 1's receipt checked under another definition hash", 1, sig1, False, definition_hash=bv.H(b"another election"))
    check("other-ballot", "Seat 1's receipt checked against the bad-share ballot", 1, sig1, False, b_hash=other_bh)
    check("other-ciphertext", "Seat 1's receipt checked against seat 2's share hash", 1, sig1, False, share_hash=sh2)
    check("other-tag", "Seat 1's statement signed under abolish/v1/sig/tally-opening", 1, sign(signing_secret("panel-3", 1), m1, OTHER_TAG), False)
    check("altered", "Seat 1's receipt with its last byte flipped", 1, sig1[:-1] + bytes([sig1[-1] ^ 1]), False)
    check("high-s", "Seat 1's receipt with s replaced by n − s", 1, ecdsa.sig_bytes(rr, ecdsa.N - ss), False)
    check("short", "Seat 1's receipt one byte short", 1, sig1[:-1], False)
    check("other-panel", "Seat 1's receipt checked against the 2-seat panel's keys", 1, sig1, False, panel="panel-2")

    data = {
        "format": "abolish-share-receipt-vectors/1",
        "title": "Ballot hash, trustee intake and share receipts",
        "spec": "docs/spec/share-encryption.md",
        "generator": (
            "Printed by packages/crypto/scripts/share-receipt-vectors.py, an implementation of "
            "docs/spec/ballot-validity.md (Ballot hash) and docs/spec/share-encryption.md (Intake and "
            "receipts) in Python's integers and hashlib, sharing no code with packages/crypto or any "
            "@noble library. It reuses share-encryption-vectors.py's ballots and decryption, re-made "
            "from their labels and checked against share-encryption.json byte for byte, and "
            "trustee-vectors.py's P-256 ECDSA, checked against RFC 6979 Appendix A.2.5 first. "
            "Signing secrets are SHA-256 of fixed labels: test data only."
        ),
        "tags": {"ballot": BALLOT_TAG.decode(), "receipt": RECEIPT_TAG.decode()},
        "panels": panels,
        "ballotHashes": hashes,
        "intakes": intakes,
        "intakeFailures": failures,
        "receiptChecks": checks,
    }
    with open(f"{out}/share-receipt.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
