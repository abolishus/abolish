#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/delivery-v5.json.

A second implementation of docs/spec/contracts.md, Board, Delivery records
(ballot version 5): the board's checks of the delivery records of a rolling
poll (definition version 7, `electorate_mode` 2), which ballot version 5 fixes
at version 2 as ballot version 4 does, and the rolling posting call,
`submitRollingPosting(bytes32 root, bytes posting, bytes ballot)`, whose
ballot is checked as the rolling call checks a ballot, its membership proof
against the root the sender supplies. Every case is one call on a fresh board,
judged by the board's steps in order: the posting's delivery steps (header,
`delivery-stray`, the version ballot version 5 fixes, the fields,
`delivery-seat`), `posting-length`, the ballot check (`ballot-stray`, the
version, `ballot-cell`, `validity-shape`, `share-hash-unqualified`,
`membership-proof` against the supplied root under the rolling scope), then
`posting-ballot` and `posting-hash`; and, for the other records, the delivery
steps with `delivery-signature` under the seat's own panel key.

It is written from the spec with Python's integers and hashlib and shares no
code with packages/crypto or any @noble library. It reuses only this folder's
other independent generators: ballot-v5-records-vectors.py's rolling elections,
group events, step trees, record encoder, hashes, rolling scope and witnesses
(the elections are that file's, from the same labels);
share-encryption-v4-vectors.py's version-4 encryption, which ballot version 5
keeps, over its self-checked ML-KEM-768, ChaCha20-Poly1305 and ristretto255;
delivery-v2-vectors.py's and delivery-batch-v2-vectors.py's version-2 records
and their strict decoding; intake-v4-vectors.py's receipt statement over
trustee-vectors.py's RFC 6979 P-256 ECDSA; and relay-vectors.py's Keccak-256
for the selector. The fixed poll's version-4 ballot, which the rolling call
refuses, is intake-v4.json's, read from the committed file.

Membership proofs need a Groth16 prover, so generation has three steps, as
for ballot-v5-records-vectors.py:

  python3 -I -B delivery-v5-vectors.py statements <constants> <work>/statements.json
  vp node ballot-proofs.mjs <artifacts-dir> <work>/statements.json <work>/proofs.json
  python3 -I -B delivery-v5-vectors.py assemble <constants> <work>/proofs.json <out-dir>

where <constants> is packages/crypto/test-vectors/iden3/poseidon_constants.json.
Every value but the proofs is deterministic from fixed labels (test data,
never keys); Groth16 proving is randomised, so the committed file is the
record. Then `vp check --fix` formats it.
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


r5 = _load("ballot_v5_records_vectors", "ballot-v5-records-vectors.py")
db2 = _load("delivery_batch_v2_vectors", "delivery-batch-v2-vectors.py")
rl = _load("relay_vectors", "relay-vectors.py")
d2, iv4, sev4, dv, sr, ecdsa = db2.d2, db2.iv4, db2.sev4, db2.dv, db2.sr, db2.ecdsa
se, bv = sev4.se, sev4.bv
b3, b4, rev, mem = r5.b3, r5.b4, r5.rev, r5.mem

R = r5.R
N0 = r5.N0
DEFAULT, AUTHOR = 1, 2
PANEL_NAMES = {DEFAULT: "default", AUTHOR: "author"}
RECEIPT, POSTING, COMPLAINT = dv.RECEIPT, dv.POSTING, dv.COMPLAINT
BATCH, COMPLAINT_BATCH, ROOT = db2.BATCH, db2.COMPLAINT_BATCH, db2.ROOT
TYPE_NAMES = {RECEIPT: "share-receipt", POSTING: "share-posting", COMPLAINT: "share-complaint", BATCH: "share-receipt-batch", COMPLAINT_BATCH: "share-complaint-batch", ROOT: "obligation-root"}
TAGS = {RECEIPT: iv4.RECEIPT_TAG_2, COMPLAINT: d2.COMPLAINT_TAG_2, BATCH: db2.BATCH_TAG_2, COMPLAINT_BATCH: db2.COMPLAINT_BATCH_TAG_2, ROOT: db2.ROOT_TAG_2}
ROLLING_POSTING = "submitRollingPosting(bytes32,bytes,bytes)"
POSTING_CALL = "submitPosting(bytes,bytes)"
# The ciphertext's sealed field: ct_m (1088), ct_dh (32), pok_c and pok_z (64), then its u32 length.
SEALED_AT = 1184


def det(label):
    return hashlib.sha256(b"abolish delivery v5 vectors " + label.encode()).digest()


def signing_secret(panel, seat):
    return ecdsa.secret(f"delivery-v5/{PANEL_NAMES[panel]}/signing/{seat}".encode())


# --- Calldata (contracts.md, Board, Calls) ----------------------------------------


def rolling_posting_calldata(root, posting, ballot):
    """The canonical ABI encoding of (bytes32 root, bytes posting, bytes ballot)."""
    p = rl.pad32(posting)
    return rl.selector(ROLLING_POSTING) + rl.word(root) + rl.word(0x60) + rl.word(0x80 + len(p)) + rl.word(len(posting)) + p + rl.word(len(ballot)) + rl.pad32(ballot)


def check_rolling_calldata(calldata):
    """The call's canonical-calldata rule: (root, posting, ballot), or None."""
    if len(calldata) < 4 + 32 * 5 or calldata[:4] != rl.selector(ROLLING_POSTING):
        return None
    body = calldata[4:]
    word = lambda at: int.from_bytes(body[at : at + 32], "big")  # noqa: E731
    root, first, second = word(0), word(32), word(64)
    if first != 0x60:
        return None
    p_len = word(0x60)
    posting = body[0x80 : 0x80 + p_len]
    if len(posting) != p_len or second != 0x80 + len(rl.pad32(posting)) or len(body) < second + 32:
        return None
    b_len = word(second)
    ballot = body[second + 32 : second + 32 + b_len]
    if len(ballot) != b_len or body[0x60:second] != rl.word(p_len) + rl.pad32(posting) or body[second:] != rl.word(b_len) + rl.pad32(ballot):
        return None
    return root.to_bytes(32, "big"), posting, ballot


# --- The board's checks -------------------------------------------------------------


def fixed_version(pinned):
    """delivery.md, Versions: ballot versions 1 to 3 fix every delivery type at 1, versions 4 and 5 at 2."""
    return 2 if pinned in (4, 5) else 1


def delivery_steps(registry, rec, call_type):
    """Delivery records' steps 1 to 6 on one record, under the version its election's ballot version fixes:
    None, or (code, offset). The records here frame, so step 4's decode errors are delivery-v2.json's."""
    t = int.from_bytes(rec[:2], "big")
    assert t == call_type and len(rec) >= 35
    e = registry.get(rec[3:35])
    if e is None:
        return "delivery-stray", None
    if e["ballotVersion"] > 5:
        return "unknown-version", 2
    if rec[2] != fixed_version(e["ballotVersion"]):
        return "profile-mismatch", 2
    assert rec[2] == 2
    if call_type in (RECEIPT, POSTING, COMPLAINT):
        _, f = d2.parse_record(rec, TYPE_NAMES[call_type])
        f["statement"] = rec[3:-64]
    else:
        f = db2.parse_root(rec) if call_type == ROOT else db2.parse_batch(rec, call_type)
        assert isinstance(f, dict)
    seats = e["seats"][f["panel"]]
    if f["seat"] not in seats:
        return "delivery-seat", None
    if call_type != POSTING and not ecdsa.verify(seats[f["seat"]], bv.ds(TAGS[call_type], f["statement"]), rec[-64:]):
        return "delivery-signature", None
    return None


def ballot_check(registry, b, root, rolling, verdict):
    """Ballots in order, as the rolling call reads them (Rolling ballots) or as submitPosting does (Ballots,
    Ballots (version 4)): None, or (code, offset). `verdict` is snarkjs's pairing check on the signals."""
    e = registry.get(b["definitionHash"])
    if e is None:
        return "ballot-stray", None
    if b["version"] != e["ballotVersion"]:
        return "profile-mismatch", 2
    if (rolling and e["ballotVersion"] != 5) or (not rolling and e["ballotVersion"] not in (1, 2, 3, 4)):
        return "unknown-version", 2
    assert 0 <= b["nullifier"] < R and 0 <= b["step"] < 2**32
    rules = e["election"]
    if b["cell"] >= len(rules["cells"]):
        return "ballot-cell", None
    v = r5.check_validity(rules, b)
    if v != "ok" and v["code"] == "validity-shape":
        return "validity-shape", None
    if r5.unqualified(rules, e["seats"][DEFAULT], e["seats"][AUTHOR], b["vote"]) is not None:
        return "share-hash-unqualified", None
    if root == 0 or root >= R or not verdict:
        return "membership-proof", None
    return None


def rolling_posting(registry, root, posting, b, verdict, rolling=True):
    """submitRollingPosting's steps after its calldata (or submitPosting's, `rolling` false): the result."""
    err = delivery_steps(registry, posting, POSTING)
    if err:
        return {"check": "delivery", "code": err[0], **({"offset": err[1]} if err[1] is not None else {})}
    e = registry[posting[3:35]]
    _, f = d2.parse_record(posting, "share-posting")
    if int.from_bytes(f["ciphertext"][SEALED_AT : SEALED_AT + 4], "big") != 4 + 64 * e["election"]["optionTotal"] + 16:
        return {"check": "delivery", "code": "posting-length"}
    err = ballot_check(registry, b, root, rolling, verdict)
    if err:
        return {"check": "ballot", "code": err[0], **({"offset": err[1]} if err[1] is not None else {})}
    if f["definitionHash"] != b["definitionHash"] or f["ballotHash"] != r5.ballot_hash(b):
        return {"check": "delivery", "code": "posting-ballot"}
    hashes = b["vote"]["shareHashes"] if f["panel"] == DEFAULT else b["vote"]["authorShareHashes"]
    if se.share_hash(f["ciphertext"]) != hashes[f["seat"] - 1]:
        return {"check": "delivery", "code": "posting-hash"}
    return {"result": "accepted"}


# --- Elections, ballots and cases ----------------------------------------------------


def build(constants):
    """Everything but the proofs' bytes, deterministically."""
    ecdsa.self_check()
    se.aead_self_check()
    se.mlkem_self_check(100)
    s5 = r5.build(constants)
    els = s5["elections"]
    e, plain, other = els["rolling"], els["default-only"], els["other"]

    # The fixed poll: intake-v4.json's election with an author panel, pinning ballot version 4.
    fixed_rules = iv4.r4.build(constants)["elections"]["panels"]
    intake = json.loads((VECTORS / "intake-v4.json").read_text())
    assert bytes.fromhex(intake["elections"]["panels"]["definitionHash"]) == fixed_rules["definitionHash"]
    fixed_case = next(c for c in intake["cases"] if c["id"] == "intake-ok-default-1")
    fixed_record = bytes.fromhex(fixed_case["record"])
    assert fixed_record[:3] == b"\x00\x02\x04" and fixed_record[3:35] == fixed_rules["definitionHash"]
    fixed_ballot = {"definitionHash": fixed_record[3:35], "version": 4, "encoding": fixed_record}
    fixed_posting = d2.posting_record(fixed_rules["definitionHash"], bytes.fromhex(fixed_case["ballotHash"]), DEFAULT, 1, det("fixed m"), bytes.fromhex(fixed_case["ciphertext"]))

    keys = {DEFAULT: se.trustee_keys("delivery-v5/default", 3), AUTHOR: se.trustee_keys("delivery-v5/author", 3)}

    def seats(default=(1, 2, 3), author=(1, 2, 3)):
        return {panel: {s: sr.p256_key(signing_secret(panel, s)) for s in ss} for panel, ss in ((DEFAULT, default), (AUTHOR, author))}

    def entry(election, version, default=(1, 2, 3), author=(1, 2, 3)):
        return {"election": election, "ballotVersion": version, "seats": seats(default, author)}

    elections = {"rolling": e, "default-only": plain, "fixed": fixed_rules}
    registry = {
        e["definitionHash"]: entry(e, 5),
        plain["definitionHash"]: entry(plain, 5, author=()),
        fixed_rules["definitionHash"]: entry(fixed_rules, 4),
    }
    assert other["definitionHash"] not in registry

    proofs = {}

    def prove(pid, label, election, b, tree_step=None):
        """r5's witness: `label`'s live leaf in the step tree of `b`'s cell (at `tree_step`, else `b`'s own step)."""
        cell = b["cell"]
        tier = election["cells"][cell]["tier"]
        step = r5.step_of(election, cell, b["step"] if tree_step is None else tree_step)
        s = r5.SECRETS[label]
        leaf = r5.POS.commitment(s)
        i = step["leaves"].index(leaf)
        sib = r5.tt.path_of(r5.POS.z, step["levels"], i)
        root = r5.b2.root_from_path(r5.POS, leaf, i, sib)
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
            "expect": {"root": str(root), "nullifier": str(r5.POS(sc, s))},
        }
        return root

    ballots = {}

    def encrypted(name, election, cell, member, step, answers, tree_step=None):
        """A member's version-5 ballot with real ciphertexts to every seat of both panels, proved against
        the step tree of `tree_step` (its own step's by default)."""
        defh = election["definitionHash"]
        tier = election["cells"][cell]["tier"]
        nul = r5.POS(r5.rolling_scope_field(defh, tier), r5.SECRETS[member])
        ctx = {"definitionHash": defh, "cell": cell, "nullifier": nul}
        votes = b3.flat(answers)
        n, n_a = election["panelSize"], election["authorPanelSize"]
        # make_ballot draws the polynomials first, so the second call, with
        # the real share hashes, keeps the same halves and shares.
        first, _, shares, author_shares = b4.make_ballot("delivery-v5/" + name, election, ctx, votes, version=5, share_hashes=[bytes(32)] * n, author_share_hashes=[bytes(32)] * n_a)
        halves = {"vss": first["vss"], "authorVss": first["authorVss"]}
        rng = bv.Rng("delivery-v5/encapsulation/" + name)
        cts, ms = {}, {}
        for panel, seat_shares in ((DEFAULT, shares), (AUTHOR, author_shares)):
            cts[panel], ms[panel] = [], []
            for seat in range(1, len(seat_shares) + 1):
                m, ee, w = rng.bytes32(), sev4.nonzero_scalar(rng), sev4.nonzero_scalar(rng)
                ct, _ = sev4.encrypt(defh, panel, seat, keys[panel][seat - 1], halves, bv.enc_shares(seat_shares[seat - 1]), m, ee, w)
                cts[panel].append(ct)
                ms[panel].append(m)
        vote, _, _, _ = b4.make_ballot(
            "delivery-v5/" + name,
            election,
            ctx,
            votes,
            version=5,
            share_hashes=[se.share_hash(ct) for ct in cts[DEFAULT]],
            author_share_hashes=[se.share_hash(ct) for ct in cts[AUTHOR]],
        )
        assert vote["vss"] == first["vss"] and vote["authorVss"] == first["authorVss"], name
        r = (21_000_000 + int.from_bytes(det("ref " + name)[:2], "big"), det("ref hash " + name))
        b = {"definitionHash": defh, "version": 5, "cell": cell, "nullifier": nul, "step": step, "l1RefNumber": r[0], "l1RefHash": r[1], "vote": vote, "committedVote": b4.enc_committed_vote(vote)}
        assert r5.check_validity(election, b) == "ok", name
        for panel in cts:
            for seat, ct in enumerate(cts[panel], 1):
                assert sev4.decrypt(defh, panel, seat, keys[panel][seat - 1], vote, ct) == "ok", (name, panel, seat)
        proved = prove(name, member, election, b, tree_step)
        b = dict(b, name=name, proof=name, election=election, cts=cts, ms=ms, provedRoot=proved)
        ballots[name] = b
        return b

    step_root = lambda election, cell, n: r5.step_of(election, cell, n)["root"]  # noqa: E731
    dan = encrypted("dan", e, 0, "dan", N0, [(3, [1]), (4, [0, 3]), (2, [1])])
    tess = encrypted("tess", e, 1, "tess", N0, [(3, []), (4, [2]), (2, [0])])
    # Named step N0, proved against step N0 − 1's root: the board accepts it with that root, the verifier
    # rejects the ballot (root-step-mismatch), so a posting for it delivers nothing.
    ada = encrypted("ada-root-mismatch", e, 0, "ada", N0, [(3, [2]), (4, []), (2, [0])], tree_step=N0 - 1)
    assert step_root(e, 0, N0 - 1) != step_root(e, 0, N0)
    cleo = encrypted("cleo-default-only", plain, 0, "cleo", N0 + 2, [(3, [0]), (4, [1, 2]), (2, [1])])

    def posting(b, panel, seat, as_=None, ct=None, definition_hash=None, version=2):
        p, s = as_ or (panel, seat)
        rec = d2.posting_record(definition_hash or b["definitionHash"], r5.ballot_hash(b), p, s, b["ms"][panel][seat - 1], ct or b["cts"][panel][seat - 1])
        return rec[:2] + bytes([version]) + rec[3:]

    cases = []

    def case(cid, description, b, root, rec, expect, call="submitRollingPosting", registered=None, timestamp=None):
        cases.append(
            {
                "id": cid,
                "description": description,
                "call": call,
                "ballot": b,
                "root": root,
                "posting": rec,
                "registered": registered,
                "timestamp": timestamp,
                "expect": expect,
            }
        )

    ok = {"result": "accepted"}
    dan_root, tess_root = step_root(e, 0, N0), step_root(e, 1, N0)
    for panel in (DEFAULT, AUTHOR):
        for seat in (1, 2, 3):
            case(f"ok-{PANEL_NAMES[panel]}-{seat}", f"Dan's posting to {PANEL_NAMES[panel]} seat {seat}, with the root of step N0, which his ballot names", dan, dan_root, posting(dan, panel, seat), ok)
    case("ok-tier-2", "Tess's posting to author seat 2, her tier 2 ballot carrying step N0's root of her tier's tree", tess, tess_root, posting(tess, AUTHOR, 2), ok)
    case("ok-default-only", "Cleo's posting to default seat 3 in the rolling poll without an author panel, at step N0 + 2", cleo, step_root(plain, 0, N0 + 2), posting(cleo, DEFAULT, 3), ok)
    case("ok-after-close", "Dan's posting to default seat 1 a day after closes_at: no window applies to a posting", dan, dan_root, posting(dan, DEFAULT, 1), ok, timestamp=e["closesAt"] + 86_400)
    case(
        "ok-root-mismatch",
        "Ada's ballot names step N0 but was proved against step N0 − 1's root, which the call supplies: the board accepts the posting, and the verifier rejects the ballot (root-step-mismatch), so it delivers nothing",
        ada,
        step_root(e, 0, N0 - 1),
        posting(ada, DEFAULT, 2),
        ok,
    )

    # The supplied root: the proof fixes it (Rolling ballots, One root per record).
    case("membership-step-root-for-mismatch", "Ada's posting with the root of the step her ballot names, which isn't the root her proof was made against", ada, dan_root, posting(ada, DEFAULT, 2), {"check": "ballot", "code": "membership-proof"})
    case("membership-other-step-root", "Dan's posting with step N0 − 1's root", dan, step_root(e, 0, N0 - 1), posting(dan, DEFAULT, 1), {"check": "ballot", "code": "membership-proof"})
    case("membership-other-tier-root", "Tess's posting with tier 0's root of step N0", tess, dan_root, posting(tess, AUTHOR, 2), {"check": "ballot", "code": "membership-proof"})
    case("membership-root-zero", "Dan's posting with a supplied root of 0, which any secret can prove membership of", dan, 0, posting(dan, DEFAULT, 1), {"check": "ballot", "code": "membership-proof"})
    case("membership-root-r", "Dan's posting with a supplied root equal to the BN254 scalar field order", dan, R, posting(dan, DEFAULT, 1), {"check": "ballot", "code": "membership-proof"})
    case("membership-root-aliased", "Dan's posting with the root of step N0 plus r: a check that reduced the supplied root rather than refusing it would pass the pairing", dan, dan_root + R, posting(dan, DEFAULT, 1), {"check": "ballot", "code": "membership-proof"})
    case("membership-root-max", "Dan's posting with the supplied root 2²⁵⁶ − 1", dan, 2**256 - 1, posting(dan, DEFAULT, 1), {"check": "ballot", "code": "membership-proof"})

    # The versions: a rolling poll's posting has this call alone, and this call takes a rolling poll's alone.
    case("submit-posting-version-5", "Dan's posting and ballot through submitPosting, which takes no root and reads ballot versions 1 to 4 only", dan, None, posting(dan, DEFAULT, 1), {"check": "ballot", "code": "unknown-version", "offset": 2}, call="submitPosting")
    case(
        "fixed-poll",
        "A fixed poll's version-2 posting with its version-4 ballot (intake-v4.json's, which pins ballot version 4) and a root: the rolling call never replaces a registered root with a supplied one",
        fixed_ballot,
        1,
        fixed_posting,
        {"check": "ballot", "code": "unknown-version", "offset": 2},
    )
    case("posting-version-1", "Dan's posting labelled version 1: ballot version 5 fixes version 2", dan, dan_root, posting(dan, DEFAULT, 1, version=1), {"check": "delivery", "code": "profile-mismatch", "offset": 2})

    # The posting's own steps.
    other_hash = other["definitionHash"]
    case("delivery-stray", "Dan's posting naming the definition hash of an election the registry holds no parameters for", dan, dan_root, posting(dan, DEFAULT, 1, definition_hash=other_hash), {"check": "delivery", "code": "delivery-stray"})
    case("delivery-seat-no-author-panel", "Cleo's default seat 1 ciphertext posted to author seat 1 in the poll without an author panel", cleo, step_root(plain, 0, N0 + 2), posting(cleo, DEFAULT, 1, as_=(AUTHOR, 1)), {"check": "delivery", "code": "delivery-seat"})
    case("delivery-seat-unregistered", "Dan's posting to author seat 3 when the author key set holds seats 1 and 2 only", dan, dan_root, posting(dan, AUTHOR, 3), {"check": "delivery", "code": "delivery-seat"}, registered={"default": [1, 2, 3], "author": [1, 2]})
    ct1 = dan["cts"][DEFAULT][0]
    n_sealed = int.from_bytes(ct1[SEALED_AT : SEALED_AT + 4], "big")
    short = ct1[:SEALED_AT] + (n_sealed - 1).to_bytes(4, "big") + ct1[SEALED_AT + 4 : -1]
    case("posting-length", "Dan's default seat 1 posting with its sealed field one byte short: it frames, but its length isn't 4 + 64 · T + 16", dan, dan_root, posting(dan, DEFAULT, 1, ct=short), {"check": "delivery", "code": "posting-length"})

    # The ballot's steps, which come before the posting is compared with it.
    case("ballot-stray", "Dan's posting with his ballot relabelled to an election the registry holds no parameters for", dict(dan, definitionHash=other_hash, variant="dan-stray"), dan_root, posting(dan, DEFAULT, 1), {"check": "ballot", "code": "ballot-stray"})
    case(
        "ballot-profile-mismatch",
        "The fixed poll's posting with Dan's version-5 ballot relabelled to the fixed poll, which pins version 4: the record's version is checked against the pin before the pin against this call",
        dict(dan, definitionHash=fixed_rules["definitionHash"], variant="dan-fixed"),
        dan_root,
        fixed_posting,
        {"check": "ballot", "code": "profile-mismatch", "offset": 2},
    )
    no_half = dict(dan["vote"], authorVss=[], authorShareHashes=[])
    case(
        "validity-shape",
        "Dan's posting with his ballot stripped of its author half, in a poll with an author panel",
        dict(dan, vote=no_half, committedVote=b4.enc_committed_vote(no_half), variant="dan-no-author-half"),
        dan_root,
        posting(dan, DEFAULT, 1),
        {"check": "ballot", "code": "validity-shape"},
    )
    case("ballot-cell", "Dan's ballot relabelled to cell 2: the partition has one cell per rolling tier", dict(dan, cell=2, variant="dan-cell-2"), dan_root, posting(dan, DEFAULT, 1), {"check": "ballot", "code": "ballot-cell"})
    case(
        "share-hash-unqualified",
        "Dan's posting to default seat 1 when the default key set lacks seat 3, whose share hash his ballot fills",
        dan,
        dan_root,
        posting(dan, DEFAULT, 1),
        {"check": "ballot", "code": "share-hash-unqualified"},
        registered={"default": [1, 2], "author": [1, 2, 3]},
    )

    # The posting against its ballot.
    case("posting-ballot-hash", "Tess's posting to author seat 2 sent with Dan's ballot and root", dan, dan_root, posting(tess, AUTHOR, 2), {"check": "delivery", "code": "posting-ballot"})
    case(
        "posting-ballot-definition",
        "Dan's posting relabelled to the poll without an author panel, whose option count is the same, sent with his own ballot",
        dan,
        dan_root,
        posting(dan, DEFAULT, 1, definition_hash=plain["definitionHash"]),
        {"check": "delivery", "code": "posting-ballot"},
    )
    case("posting-hash-other-seat", "Dan's default seat 2 ciphertext posted as default seat 1's", dan, dan_root, posting(dan, DEFAULT, 2, as_=(DEFAULT, 1)), {"check": "delivery", "code": "posting-hash"})
    case("posting-hash-other-panel", "Dan's author seat 1 ciphertext posted as default seat 1's", dan, dan_root, posting(dan, AUTHOR, 1, as_=(DEFAULT, 1)), {"check": "delivery", "code": "posting-hash"})

    # The order of the checks.
    case("order-version-before-ballot", "A version-1 posting with a supplied root of 0: the posting's version comes first", dan, 0, posting(dan, DEFAULT, 1, version=1), {"check": "delivery", "code": "profile-mismatch", "offset": 2})
    case("order-length-before-ballot", "A posting whose sealed field is a byte short, with a supplied root of 0: posting-length comes first", dan, 0, posting(dan, DEFAULT, 1, ct=short), {"check": "delivery", "code": "posting-length"})
    case("order-ballot-before-posting", "Tess's posting with Dan's ballot and a root of 0: the ballot's membership-proof comes before posting-ballot", dan, 0, posting(tess, AUTHOR, 2), {"check": "ballot", "code": "membership-proof"})

    checks = []
    for c in cases:
        b = c["ballot"]
        # Only the cases whose ballot check reaches the pairing: a relabelled ballot is refused before it.
        if c["call"] != "submitRollingPosting" or "name" not in b or "variant" in b or not 0 < c["root"] < R:
            continue
        tier = b["election"]["cells"][b["cell"]]["tier"]
        msg = rev.message(b["definitionHash"], tier, r5.ballot_hash(b), b["l1RefNumber"], b["l1RefHash"])
        signals = {"root": c["root"], "nullifier": b["nullifier"], "message": mem.field_map(msg), "scope": r5.rolling_scope_field(b["definitionHash"], tier)}
        checks.append({"case": c["id"], "proof": b["proof"], "signals": {k: str(v) for k, v in signals.items()}})

    return {"elections": elections, "registry": registry, "keys": keys, "ballots": ballots, "fixedBallot": fixed_ballot, "cases": cases, "proofs": proofs, "checks": checks, "stepRoot": step_root}


def statements(constants, out):
    s = build(constants)
    pathlib.Path(out).write_text(json.dumps({"proofs": list(s["proofs"].values()), "checks": s["checks"]}, indent=2) + "\n")


# --- Assembly ------------------------------------------------------------------------


def assemble(constants, proofs_path, out_dir):
    s = build(constants)
    got = json.loads(pathlib.Path(proofs_path).read_text())
    proof_bytes = {k: bytes.fromhex(v) for k, v in got["proofs"].items()}
    verdicts = got["verdicts"]
    assert set(proof_bytes) == set(s["proofs"])
    registry, keys = s["registry"], s["keys"]
    e = s["elections"]["rolling"]
    ok = {"result": "accepted"}

    def encoding(b):
        return b["encoding"] if "encoding" in b else r5.enc_ballot(dict(b, proof=proof_bytes[b["proof"]]))

    def with_seats(registered):
        if registered is None:
            return registry
        out = dict(registry)
        out[e["definitionHash"]] = dict(
            registry[e["definitionHash"]],
            seats={panel: {x: sr.p256_key(signing_secret(panel, x)) for x in registered[name]} for panel, name in ((DEFAULT, "default"), (AUTHOR, "author"))},
        )
        return out

    # Each ballot once, so each case names the one it carries.
    ballots_json, seen = [], set()

    def ballot_id(b):
        if "name" not in b:
            bid = "fixed-poll"
        elif "variant" in b:
            bid = b["variant"]
        else:
            bid = b["name"]
        if bid not in seen:
            seen.add(bid)
            enc = encoding(b)
            # A variant's proof was made for the ballot it was relabelled from, and a stray one names no election here.
            v = {"id": bid, "election": next((k for k, x in s["elections"].items() if x["definitionHash"] == enc[3:35]), None), "encoding": enc.hex()}
            if "name" in b:
                v.update(ballotHash=r5.ballot_hash(b).hex(), cell=b["cell"], step=b["step"])
            if "name" in b and "variant" not in b:
                v["provedRoot"] = str(b["provedRoot"])
            ballots_json.append(v)
        return bid

    for name in ("dan", "tess", "ada-root-mismatch", "cleo-default-only"):
        ballot_id(s["ballots"][name])

    cases_json = []
    for c in s["cases"]:
        b = c["ballot"]
        verdict = verdicts.get(c["id"])
        rolling = c["call"] == "submitRollingPosting"
        result = rolling_posting(with_seats(c["registered"]), c["root"] or 0, c["posting"], b, verdict, rolling)
        assert result == c["expect"], (c["id"], result)
        enc = encoding(b)
        v = {"id": c["id"], "description": c["description"], "call": c["call"], "ballot": ballot_id(b), "posting": c["posting"].hex()}
        if rolling:
            v["root"] = str(c["root"])
            assert check_rolling_calldata(rolling_posting_calldata(c["root"], c["posting"], enc)) == (c["root"].to_bytes(32, "big"), c["posting"], enc)
        if c["registered"] is not None:
            v["registered"] = c["registered"]
        if c["timestamp"] is not None:
            v["timestamp"] = str(c["timestamp"])
        if verdict is not None:
            v["snarkjs"] = verdict
        if "result" in result:
            # What the verifier makes of an accepted posting's ballot on its own path (root-step-mismatch).
            named = s["stepRoot"](b["election"], b["cell"], b["step"])
            v["rootCheck"] = "match" if c["root"] == named else "root-step-mismatch"
        v.update(result)
        cases_json.append(v)

    # The calldata: canonical, and each way it can depart from that.
    dan = s["ballots"]["dan"]
    root = s["stepRoot"](e, 0, N0)
    p = next(c["posting"] for c in s["cases"] if c["id"] == "ok-default-1")
    ballot = encoding(dan)
    good = rolling_posting_calldata(root, p, ballot)
    sel = rl.selector(ROLLING_POSTING)
    pp = rl.pad32(p)
    assert len(p) % 32 != 0 and len(ballot) % 32 != 0, "both records end inside a word, so both have padding to test"
    second = 0x80 + len(pp)
    body = good[4:]
    calldata_in = [
        ("canonical", "The canonical encoding of Dan's default seat 1 call", good),
        ("first-offset", "The posting's offset 0x80 rather than 0x60", sel + body[:32] + rl.word(0x80) + body[64:]),
        ("second-offset", "The ballot's offset 32 bytes past where the posting's padding ends", sel + body[:64] + rl.word(second + 32) + body[96:second] + bytes(32) + body[second:]),
        ("posting-padding", "A non-zero byte in the posting's padding", good[: 4 + 0x80 + len(p)] + b"\x01" + good[4 + 0x80 + len(p) + 1 :]),
        ("ballot-padding", "A non-zero byte in the ballot's padding", good[:-1] + b"\x01"),
        ("trailing-word", "A zero word after the ballot's padding", good + bytes(32)),
        ("short", "The calldata without its last byte", good[:-1]),
        ("other-selector", "submitRollingBallot's selector with this call's arguments", rl.selector("submitRollingBallot(bytes32,bytes)") + body),
    ]
    calldata = []
    for cid, desc, cd in calldata_in:
        decoded = check_rolling_calldata(cd)
        assert (decoded is not None) == (cid == "canonical"), cid
        calldata.append({"id": cid, "description": desc, "calldata": cd.hex(), "canonical": decoded is not None})

    # The other delivery records of a rolling poll: version 2, as under ballot version 4.
    def pair(b, panel, seat):
        return r5.ballot_hash(b), se.share_hash(b["cts"][panel][seat - 1])

    def receipt(b, panel, seat, secret=None, as_=None):
        p_, s_ = as_ or (panel, seat)
        bh, sh = pair(b, panel, seat)
        m = iv4.statement(b["definitionHash"], bh, p_, s_, sh)
        return d2.receipt_record(b["definitionHash"], bh, p_, s_, sh, sr.sign(secret or signing_secret(p_, s_), m, iv4.RECEIPT_TAG_2))

    complaint_rng = bv.Rng("delivery-v5/complaint")

    def raw_complaint(b, panel, seat):
        ct = b["cts"][panel][seat - 1]
        return sev4.raw_complaint(b["definitionHash"], panel, seat, keys[panel][seat - 1], ct, sev4.nonzero_scalar(complaint_rng))

    def relabel(rec, version):
        return rec[:2] + bytes([version]) + rec[3:]

    tess, ada, cleo = s["ballots"]["tess"], s["ballots"]["ada-root-mismatch"], s["ballots"]["cleo-default-only"]
    defh = e["definitionHash"]
    complaint, _ = d2.complaint_record(defh, r5.ballot_hash(dan), AUTHOR, 2, raw_complaint(dan, AUTHOR, 2), signing_secret(AUTHOR, 2))
    batch = db2.batch_record(BATCH, defh, DEFAULT, 1, [pair(x, DEFAULT, 1) for x in (dan, tess, ada)], signing_secret(DEFAULT, 1))
    complaint_batch = db2.batch_record(COMPLAINT_BATCH, defh, AUTHOR, 2, [(r5.ballot_hash(x), raw_complaint(x, AUTHOR, 2)) for x in (dan, tess)], signing_secret(AUTHOR, 2))
    root_rec, leaf_object = db2.root_record(defh, DEFAULT, 2, db2.RECEIPTS, [pair(x, DEFAULT, 2) for x in (dan, tess, ada)], signing_secret(DEFAULT, 2))
    v1_sig = sr.sign(signing_secret(DEFAULT, 1), sr.statement(defh, r5.ballot_hash(dan), 1, pair(dan, DEFAULT, 1)[1]))
    v1_receipt = dv.receipt_record(defh, r5.ballot_hash(dan), 1, pair(dan, DEFAULT, 1)[1], v1_sig)
    assert len(v1_receipt) == 164
    records_in = [
        ("receipt-default", "Default seat 1's version-2 receipt for Dan's ballot", "submitReceipts", [receipt(dan, DEFAULT, 1)], ok),
        ("receipt-author", "Author seat 3's version-2 receipt for Tess's ballot", "submitReceipts", [receipt(tess, AUTHOR, 3)], ok),
        ("receipts-both-panels", "Both panels' receipts for Dan's ballot in one call", "submitReceipts", [receipt(dan, DEFAULT, 2), receipt(dan, AUTHOR, 2)], ok),
        ("receipt-root-mismatch-ballot", "Default seat 3's receipt for Ada's ballot: the board can't see the ballot or its root, and the delivery check ignores a receipt for a ballot it doesn't admit", "submitReceipts", [receipt(ada, DEFAULT, 3)], ok),
        ("receipt-version-1", "A version-1 receipt (164 bytes) for Dan's ballot: ballot version 5 fixes version 2", "submitReceipts", [v1_receipt], {"check": "delivery", "code": "profile-mismatch", "offset": 2, "position": 0}),
        ("receipt-version-1-second", "Dan's default seat 1 version-2 receipt, then the version-1 receipt", "submitReceipts", [receipt(dan, DEFAULT, 1), v1_receipt], {"check": "delivery", "code": "profile-mismatch", "offset": 2, "position": 1}),
        ("receipt-other-panel-key", "Author seat 1's receipt signed with default seat 1's key", "submitReceipts", [receipt(dan, AUTHOR, 1, secret=signing_secret(DEFAULT, 1))], {"check": "delivery", "code": "delivery-signature", "position": 0}),
        ("receipt-no-author-panel", "A receipt naming author seat 1 for Cleo's ballot, in the poll without an author panel", "submitReceipts", [receipt(cleo, DEFAULT, 1, as_=(AUTHOR, 1))], {"check": "delivery", "code": "delivery-seat", "position": 0}),
        ("complaint-author", "Author seat 2's version-2 complaint about Dan's author seat 2 posting: the board frames and signs it, never proves it", "submitComplaint", [complaint], ok),
        ("complaint-version-1", "The same complaint labelled version 1", "submitComplaint", [relabel(complaint, 1)], {"check": "delivery", "code": "profile-mismatch", "offset": 2, "position": 0}),
        ("receipt-batch", "Default seat 1's version-2 batch of three pairs, Ada's among them", "submitReceiptBatch", [batch], ok),
        ("receipt-batch-version-1", "The same batch labelled version 1", "submitReceiptBatch", [relabel(batch, 1)], {"check": "delivery", "code": "profile-mismatch", "offset": 2, "position": 0}),
        ("complaint-batch", "Author seat 2's version-2 complaint batch about Dan's and Tess's ballots", "submitComplaintBatch", [complaint_batch], ok),
        ("obligation-root", "Default seat 2's version-2 receipt root over three pairs", "submitObligationRoot", [root_rec], ok),
        ("obligation-root-version-1", "The same root labelled version 1", "submitObligationRoot", [relabel(root_rec, 1)], {"check": "delivery", "code": "profile-mismatch", "offset": 2, "position": 0}),
    ]
    call_types = {"submitReceipts": RECEIPT, "submitComplaint": COMPLAINT, "submitReceiptBatch": BATCH, "submitComplaintBatch": COMPLAINT_BATCH, "submitObligationRoot": ROOT}
    records = []
    for rid, desc, call, recs, expect in records_in:
        result = ok
        for i, rec in enumerate(recs):
            err = delivery_steps(registry, rec, call_types[call])
            if err:
                result = {"check": "delivery", "code": err[0], **({"offset": err[1]} if err[1] is not None else {}), "position": i}
                break
        assert result == expect, (rid, result)
        records.append({"id": rid, "description": desc, "call": call, "records": [r.hex() for r in recs], **result})

    def panel_json(panel):
        return [
            {
                "seat": x,
                "kemKey": se.enc_kem_key(keys[panel][x - 1]).hex(),
                "signingSecret": f"{signing_secret(panel, x):064x}",
                "signingKey": sr.p256_key(signing_secret(panel, x)).hex(),
            }
            for x in (1, 2, 3)
        ]

    def election_json(name, el):
        entry = registry[el["definitionHash"]]
        out = {
            "definitionHash": el["definitionHash"].hex(),
            "ballotVersion": entry["ballotVersion"],
            "optionTotal": el["optionTotal"],
            "panelSize": el["panelSize"],
            "authorPanelSize": el["authorPanelSize"],
            "registered": {"default": sorted(entry["seats"][DEFAULT]), "author": sorted(entry["seats"][AUTHOR])},
        }
        if entry["ballotVersion"] == 5:
            out["closesAt"] = str(el["closesAt"])
            out["cells"] = [{"cell": i, "tier": c["tier"]} for i, c in enumerate(el["cells"])]
        return out

    out = {
        "format": "abolish-delivery-contract-vectors/1",
        "title": "The board's delivery records under ballot version 5: the rolling posting call with its supplied root, and the version-2 receipts, complaints, batches and roots of a rolling poll",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/crypto/scripts/delivery-v5-vectors.py, an implementation of contracts.md's Board, Delivery records "
            "(ballot version 5) in Python's integers and hashlib, sharing no code with packages/crypto or any @noble library. "
            "It reuses ballot-v5-records-vectors.py's rolling elections, step trees, record encoder, hashes and witnesses, "
            "share-encryption-v4-vectors.py's version-4 encryption (over its self-checked ML-KEM-768, ChaCha20-Poly1305 and "
            "ristretto255), delivery-v2-vectors.py's and delivery-batch-v2-vectors.py's version-2 records, RFC 6979 P-256 "
            "ECDSA and relay-vectors.py's Keccak-256; membership proofs by packages/crypto/scripts/ballot-proofs.mjs, run "
            "outside the workspace with Semaphore 4.14.3's depth-32 circuit artifacts and snarkjs 0.7.5, and every pairing "
            "verdict snarkjs's groth16.verify on the signals derived here from the record, the definition and the supplied "
            "root. The fixed poll's ballot and ciphertext are intake-v4.json's. Secrets are SHA-256 of fixed labels: test data only"
        ),
        "selectors": {
            "submitRollingPosting": rl.selector(ROLLING_POSTING).hex(),
            "submitPosting": rl.selector(POSTING_CALL).hex(),
        },
        "panels": {"default": DEFAULT, "author": AUTHOR},
        "seats": {"default": panel_json(DEFAULT), "author": panel_json(AUTHOR)},
        "elections": {name: election_json(name, el) for name, el in s["elections"].items()},
        "ballots": ballots_json,
        "postings": cases_json,
        "calldata": calldata,
        "records": records,
        "leafObjects": [{"root": "obligation-root", "bytes": leaf_object.hex(), "cid": root_rec[74:110].hex()}],
    }
    (pathlib.Path(out_dir) / "delivery-v5.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote delivery-v5.json: {len(ballots_json)} ballots, {len(cases_json)} postings, {len(calldata)} calldata, {len(records)} records")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "statements":
        statements(sys.argv[2], sys.argv[3])
    elif cmd == "assemble":
        assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit("usage: delivery-v5-vectors.py statements <constants> <out> | assemble <constants> <proofs> <out-dir>")


if __name__ == "__main__":
    main()
