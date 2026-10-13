#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/nullifier-reshare.json.

A second implementation of docs/spec/nullifier-reshare.md: the reshare
context, the four rounds and their signatures by two panels, the reshared-share
message (0x0014, version 1) with its hybrid-KEM encryption and the recipient's
check, the reshare transcript (0x0013, version 1), key_id, the transcript check
with every dealer's and new seat's reasons, the Lagrange recombination of the
successor's share commitments, each new seat's share, and the approval
statement. It is written from the spec with Python's integers and hashlib, on
nullifier-key-vectors.py's independent code (which makes the predecessor key
with the initial sharing's rounds, and through which the Baby Jubjub,
ML-KEM-768, ChaCha20-Poly1305, ristretto255 and P-256 code it reuses, each
checked against published vectors first, comes). Nothing here shares code with
packages/crypto or any @noble library.

Every secret comes from SHA-512 or SHA-256 over a fixed label, and each honest
party lists the values it used, so any implementation reproduces its messages
byte for byte (ECDSA nonces are RFC 6979's). The values are test data, never
keys.

Usage: python3 -I -B packages/crypto/scripts/nullifier-reshare-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import importlib.util
import itertools
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


nk = _load("nullifier_key_vectors", "nullifier-key-vectors.py")
se, kn, grp, ecdsa = nk.se, nk.kn, nk.grp, nk.ecdsa
u8, u16, u32, element, ds, H = nk.u8, nk.u16, nk.u32, nk.element, nk.ds, nk.H
u64, lst, bjj_scalar, poly, commitment_at, opening = nk.u64, nk.lst, nk.bjj_scalar, nk.poly, nk.commitment_at, nk.opening
Rng, sign, verify, p256_key, panel_id, make_panel = nk.Rng, nk.sign, nk.verify, nk.p256_key, nk.panel_id, nk.make_panel

BL, BG, BID, RG = nk.BL, nk.BG, nk.BID, nk.RG
MAX_TRUSTEES = 16
TRANSCRIPT_TYPE = 0x0013
SHARE_TYPE = 0x0014
VERSION = 1
CT_LEN = 1088
SEALED_LEN = 80
NONCE = bytes(12)
SCOPE = nk.SCOPE

CONTEXT_TAG = b"abolish/v1/keyed-nullifier/reshare-context"
ROUND_TAG = b"abolish/v1/keyed-nullifier/reshare-round"
KEY_TAG = b"abolish/v1/keyed-nullifier/reshared-key"
SHARE_HASH_TAG = b"abolish/v1/keyed-nullifier/reshare-share"
KEM_TAG = b"abolish/v1/kem/nullifier-reshare-share"
AAD_TAG = b"abolish/v1/kem/nullifier-reshare-share-aad"
MESSAGE_TAG = b"abolish/v1/sig/nullifier-reshare-message"
SIGNING_KEY_TAG = b"abolish/v1/sig/nullifier-reshare-signing-key"
APPROVAL_TAG = b"abolish/v1/sig/nullifier-reshare-approval"


def pid(panel):
    return panel_id(panel["k"], panel["keys"])


def context(old, pred_id, new, run_id, scope=SCOPE):
    return H(ds(CONTEXT_TAG, u64(scope["l2ChainId"]) + scope["groupRegistry"] + pid(old) + pred_id + pid(new) + run_id))


def lagrange(i, q):
    num = den = 1
    for m in q:
        if m != i:
            num = num * m % BL
            den = den * (m - i) % BL
    return num * pow(den, BL - 2, BL) % BL


# --- Messages and the reshared share --------------------------------------------------


def signed(round_, prev, index, body, d):
    return sign(d, MESSAGE_TAG, u8(round_) + prev + u8(index) + body)


def round_hash(prev, round_, encoded):
    return H(ds(ROUND_TAG, prev + u8(round_) + encoded))


def enc_round(msgs):
    return lst([u8(m["index"]) + m["body"] + m["sig"] for m in msgs])


def enc_transcript(run_id, pred_id, rounds, record_type=TRANSCRIPT_TYPE, version=VERSION):
    return u16(record_type) + u8(version) + run_id + pred_id + b"".join(enc_round(r) for r in rounds)


def enc_commitments(points):
    return lst([kn.enc_point(p) for p in points])


def aad(ctx, dealer, recipient, commitments):
    return ds(AAD_TAG, u16(SHARE_TYPE) + u8(VERSION) + ctx + u8(dealer) + u8(recipient) + enc_commitments(commitments))


def seal_share(ctx, dealer, recipient, kem_key, commitments, plain, mu, e, aad_ctx=None):
    ss_m, ct_m = se.encaps_internal(kem_key["ek"], mu)
    ct_dh = se.pt_mul(e, RG)
    ss_dh = se.pt_mul(e, kem_key["dh"])
    k = H(ds(KEM_TAG, ss_m + element(ss_dh) + element(ct_dh) + element(kem_key["dh"])))
    sealed = se.aead_seal(k, NONCE, aad(ctx if aad_ctx is None else aad_ctx, dealer, recipient, commitments), plain)
    return u16(SHARE_TYPE) + u8(VERSION) + ctx + u8(dealer) + u8(recipient) + ct_m + element(ct_dh) + sealed


def share_hash(b):
    return H(ds(SHARE_HASH_TAG, b))


# --- The run, with ways for a party to cheat -------------------------------------------------


def new_seat_secrets(label, j):
    rng = Rng(f"nullifier-reshare-seat/{label}/{j}")
    seed = rng.bytes32() + rng.bytes32()
    x = rng.ristretto_scalar()
    d = rng.p256_secret()
    ek, dk = se.keygen_internal(seed[:32], seed[32:])
    return {"index": j, "seed": seed, "x": x, "dh": se.pt_mul(x, RG), "signing": d, "ek": ek, "dk": dk}


def dealer_secrets(label, i, share, k_new):
    """`share` is the old seat's; a seat with none (a cheat) reshares a value of its own."""
    rng = Rng(f"nullifier-reshare-dealer/{label}/{i}")
    if share is None:
        share = {"sk": rng.bjj_scalar(), "s": rng.bjj_scalar()}
    f = [share["sk"]] + [rng.bjj_scalar() for _ in range(k_new - 1)]
    g = [share["s"]] + [rng.bjj_scalar() for _ in range(k_new - 1)]
    return {"index": i, "f": f, "g": g, "rng": rng}


def kem_secret(s):
    return {"dk": s["dk"], "x": s["x"], "dh": s["dh"]}


def reshare(label, old, pred, new, dealers, seats, cheat=None, scope=SCOPE):
    """The four rounds: `dealers` are old seats, `seats` new seats taking part; `cheat` maps a hook to a function."""
    cheat = cheat or {}
    k_new = new["k"]
    run_id = H(f"nullifier-reshare-run/{label}".encode())
    ctx = context(old, pred["keyId"], new, run_id, scope)
    news = {j: new_seat_secrets(label, j) for j in seats}
    olds = {i: dealer_secrets(label, i, pred["shares"].get(i), k_new) for i in dealers}
    for s in news.values():
        if "seat" in cheat:
            cheat["seat"](s["index"], s, news)
    for s in olds.values():
        if "dealer" in cheat:
            cheat["dealer"](s["index"], s)

    r1 = []
    for j in sorted(seats):
        s = news[j]
        kem_key = s["ek"] + element(s["dh"])
        signing_key = p256_key(s["signing"])
        pop = sign(s.get("popSigner", s["signing"]), SIGNING_KEY_TAG, ctx + u8(j) + kem_key + signing_key)
        body = kem_key + signing_key + pop
        r1.append({"index": j, "body": body, "sig": signed(1, ctx, j, body, new["secrets"][j - 1])})
    h1 = round_hash(ctx, 1, enc_round(r1))
    s1 = [m["index"] for m in r1]
    kem = {j: {"ek": news[j]["ek"], "dh": news[j]["dh"]} for j in s1}

    r2, dealt, randomness = [], {}, {}
    for i in sorted(dealers):
        s = olds[i]
        comm = [opening(s["f"][t], s["g"][t]) for t in range(k_new)]
        assert all(c != BID for c in comm)
        hashes, randomness[i] = [], []
        for j in s1:
            mu, e = s["rng"].bytes32(), s["rng"].ristretto_scalar()
            plain = bjj_scalar(poly(s["f"], j)) + bjj_scalar(poly(s["g"], j))
            if "plain" in cheat:
                plain = cheat["plain"](i, j, plain)
            aad_ctx = cheat["seal"](i, j, ctx) if "seal" in cheat else ctx
            b = seal_share(ctx, i, j, kem[j], comm, plain, mu, e, aad_ctx)
            dealt[(i, j)] = b
            randomness[i].append({"recipient": j, "mu": mu.hex(), "e": str(e)})
            hashes.append(share_hash(b))
        body = enc_commitments(comm) + lst(hashes)
        r2.append({"index": i, "body": body, "sig": signed(2, h1, i, body, old["secrets"][i - 1]), "commitments": comm, "hashes": hashes})
    h2 = round_hash(h1, 2, enc_round(r2))
    s2 = [m["index"] for m in r2]

    r3 = []
    for j in s1:
        complaints = [i for i in s2 if check_share(ctx, j, kem_secret(news[j]), r1, r2, dealt[(i, j)])[0] in ("share-decrypt", "share-verify")]
        complaints = sorted(set(complaints + cheat.get("complain", {}).get(j, [])))
        if not complaints:
            continue
        body = lst([u8(c) for c in complaints])
        r3.append({"index": j, "body": body, "sig": signed(3, h2, j, body, new["secrets"][j - 1]), "complaints": complaints})
    h3 = round_hash(h2, 3, enc_round(r3))

    r4 = []
    for i in s2:
        complainers = [m["index"] for m in r3 if i in m["complaints"]]
        if not complainers or i in cheat.get("skip4", []):
            continue
        s = olds[i]
        reveals = []
        for c in complainers:
            share, blind = poly(s["f"], c), poly(s["g"], c)
            if "reveal" in cheat:
                share, blind = cheat["reveal"](i, c, share, blind)
            reveals.append(u8(c) + bjj_scalar(share) + bjj_scalar(blind))
        body = lst(reveals)
        r4.append({"index": i, "body": body, "sig": signed(4, h3, i, body, old["secrets"][i - 1])})

    rounds = [r1, r2, r3, r4]
    if "rounds" in cheat:
        rounds = cheat["rounds"](rounds, ctx)
    return {"runId": run_id, "context": ctx, "rounds": rounds, "news": news, "olds": olds, "dealt": dealt, "randomness": randomness}


# --- Decoding ----------------------------------------------------------------------------


DecodeFail, Reader, read_list = nk.DecodeFail, nk.Reader, nk.read_list


def read_dealing_msg(r):
    start = r.o
    index = r.uint(1)
    comm = read_list(r, MAX_TRUSTEES, nk.read_bjj_point)
    hashes = read_list(r, MAX_TRUSTEES, lambda rr: rr.take(32))
    return {"index": index, "commitments": comm, "hashes": hashes, "body": r.b[start + 1 : r.o], "sig": nk.read_sig(r)}


def read_complaints_msg(r):
    start = r.o
    index = r.uint(1)
    complaints = read_list(r, MAX_TRUSTEES, lambda rr: rr.uint(1))
    return {"index": index, "complaints": complaints, "body": r.b[start + 1 : r.o], "sig": nk.read_sig(r)}


def read_responses_msg(r):
    start = r.o
    index = r.uint(1)
    reveals = read_list(r, MAX_TRUSTEES, nk.read_reveal)
    return {"index": index, "reveals": reveals, "body": r.b[start + 1 : r.o], "sig": nk.read_sig(r)}


def decode_transcript(b):
    r = Reader(b)
    # In this vector file the known types are 0x0013 and 0x0014 (notation.md).
    t = r.uint(2)
    if t not in (TRANSCRIPT_TYPE, SHARE_TYPE):
        raise DecodeFail("unknown-record-type")
    if t != TRANSCRIPT_TYPE:
        raise DecodeFail("unexpected-record-type")
    if r.uint(1) != VERSION:
        raise DecodeFail("profile-mismatch")
    run_id, pred_id = r.take(32), r.take(32)
    rounds = [
        read_list(r, MAX_TRUSTEES, nk.read_keys_msg),
        read_list(r, MAX_TRUSTEES, read_dealing_msg),
        read_list(r, MAX_TRUSTEES, read_complaints_msg),
        read_list(r, MAX_TRUSTEES, read_responses_msg),
    ]
    if r.o != len(b):
        raise DecodeFail("trailing-bytes")
    return run_id, pred_id, rounds


def decode_share(b):
    r = Reader(b)
    t = r.uint(2)
    if t not in (TRANSCRIPT_TYPE, SHARE_TYPE):
        raise DecodeFail("unknown-record-type")
    if t != SHARE_TYPE:
        raise DecodeFail("unexpected-record-type")
    if r.uint(1) != VERSION:
        raise DecodeFail("profile-mismatch")
    out = {"ctx": r.take(32), "dealer": r.uint(1), "recipient": r.uint(1), "ctM": r.take(CT_LEN), "ctDh": nk.read_element(r), "sealed": r.take(SEALED_LEN)}
    if r.o != len(b):
        raise DecodeFail("trailing-bytes")
    return out


# --- The reshared-share check and the transcript check --------------------------------------


def check_share(ctx, recipient, secret, r1, r2, b):
    """docs/spec/nullifier-reshare.md, Reshared-share check, in order: (code, dealer, share, blind)."""
    try:
        msg = decode_share(b)
    except DecodeFail:
        return ("share-malformed", None, None, None)
    s1 = [m["index"] for m in r1]
    dealings = {m["index"]: m for m in r2}
    i = msg["dealer"]
    if msg["ctx"] != ctx or msg["recipient"] != recipient or i not in dealings:
        return ("share-context", None, None, None)
    hashes = dealings[i]["hashes"]
    at = s1.index(recipient) if recipient in s1 else None
    if at is None or at >= len(hashes) or hashes[at] != share_hash(b):
        return ("share-hash", None, None, None)
    ss_m = se.decaps_internal(secret["dk"], msg["ctM"])
    ss_dh = se.pt_mul(secret["x"], msg["ctDh"])
    k = H(ds(KEM_TAG, ss_m + element(ss_dh) + element(msg["ctDh"]) + element(secret["dh"])))
    pt = se.aead_open(k, NONCE, aad(ctx, i, recipient, dealings[i]["commitments"]), msg["sealed"])
    if pt is None or len(pt) != 64:
        return ("share-decrypt", i, None, None)
    share, blind = kn.dec_scalar(pt[:32]), kn.dec_scalar(pt[32:])
    if share is None or blind is None:
        return ("share-decrypt", i, None, None)
    if opening(share, blind) != commitment_at(dealings[i]["commitments"], recipient):
        return ("share-verify", i, None, None)
    return ("ok", i, share, blind)


def check(old, pred, new, b, scope=SCOPE):
    try:
        run_id, pred_id, rounds = decode_transcript(b)
    except DecodeFail as e:
        return {"ok": False, "code": e.code}
    n_old, n, k_old, k = len(old["keys"]), len(new["keys"]), old["k"], new["k"]
    ctx = context(old, pred["keyId"], new, run_id, scope)
    r1, r2, r3, r4 = rounds
    s1 = [m["index"] for m in r1]
    s2 = [m["index"] for m in r2]
    holders = pred["commitments"]  # old seat -> C_i, qualified seats only

    def increasing(xs, top):
        return all(1 <= x <= top for x in xs) and all(a < c for a, c in zip(xs, xs[1:]))

    def complainers(i):
        return [m["index"] for m in r3 if i in m["complaints"]]

    # 1. Predecessor.
    if pred_id != pred["keyId"]:
        return {"ok": False, "code": "key-predecessor"}
    # 2. Order.
    tops = [n, n_old, n, n_old]
    if not all(increasing([m["index"] for m in rr], top) for rr, top in zip(rounds, tops)):
        return {"ok": False, "code": "key-order"}
    if not all(i in holders for i in s2) or not all(m["index"] in s1 for m in r3) or not all(m["index"] in s2 for m in r4):
        return {"ok": False, "code": "key-order"}
    # 3. Shape.
    for m in r2:
        if len(m["commitments"]) != k or len(m["hashes"]) != len(s1):
            return {"ok": False, "code": "key-shape"}
    for m in r3:
        c = m["complaints"]
        if not c or not increasing(c, n_old) or any(x not in s2 for x in c):
            return {"ok": False, "code": "key-shape"}
    for m in r4:
        want = complainers(m["index"])
        if not want or [x["complainer"] for x in m["reveals"]] != want:
            return {"ok": False, "code": "key-shape"}
    # 4. Signatures: new seats sign rounds 1 and 3, old seats rounds 2 and 4.
    h = [ctx]
    for rnum in (1, 2, 3):
        h.append(round_hash(h[-1], rnum, enc_round(rounds[rnum - 1])))
    for rnum, rr in enumerate(rounds, start=1):
        keys = new["keys"] if rnum % 2 == 1 else old["keys"]
        for m in rr:
            if not verify(keys[m["index"] - 1], MESSAGE_TAG, u8(rnum) + h[rnum - 1] + u8(m["index"]) + m["body"], m["sig"]):
                return {"ok": False, "code": "key-signature"}
    # 5. Dealers.
    responses = {m["index"]: m for m in r4}
    dealer_results = []
    for m in r2:
        i, reasons = m["index"], []
        if m["commitments"][0] != holders[i]:
            reasons.append("constant")
        if complainers(i):
            if i not in responses:
                reasons.append("unanswered")
            elif any(opening(x["share"], x["blind"]) != commitment_at(m["commitments"], x["complainer"]) for x in responses[i]["reveals"]):
                reasons.append("bad-reveal")
        dealer_results.append({"index": i, "reasons": reasons})
    q = [d["index"] for d in dealer_results if not d["reasons"]]
    # 6. Dealer quorum.
    if len(q) < k_old:
        return {"ok": False, "code": "key-dealers", "dealerResults": dealer_results}
    # 7. New seats.
    dealings = {m["index"]: m for m in r2}
    keys = {m["index"]: m for m in r1}
    passing = [m["index"] for m in r1 if verify(m["signingKey"], SIGNING_KEY_TAG, ctx + u8(m["index"]) + m["kemKey"] + m["signingKey"], m["pop"])]
    sks = [keys[j]["signingKey"] for j in passing]
    taken = set(old["keys"]) | set(new["keys"]) | set(pred["signingKeys"].values())
    seats, commitments = [], {}
    for j in range(1, n + 1):
        if j not in keys:
            seats.append({"index": j, "reasons": ["absent"]})
            continue
        reasons = []
        if j not in passing:
            reasons.append("possession")
        elif sks.count(keys[j]["signingKey"]) > 1 or keys[j]["signingKey"] in taken:
            reasons.append("duplicate-key")
        if not reasons:
            c = BID
            for i in q:
                c = kn.add(c, kn.mul(lagrange(i, q), commitment_at(dealings[i]["commitments"], j)))
            if c == BID:
                reasons.append("identity-commitment")
            else:
                commitments[j] = c
        seats.append({"index": j, "reasons": reasons})
    qualified = sorted(commitments)
    # 8. Quorum.
    if len(qualified) < k:
        return {"ok": False, "code": "key-quorum", "dealerResults": dealer_results, "seats": seats}
    return {
        "ok": True,
        "keyId": H(ds(KEY_TAG, b)).hex(),
        "predecessor": pred_id.hex(),
        "dealerResults": dealer_results,
        "dealers": q,
        "seats": seats,
        "qualified": [
            {"index": j, "kemKey": keys[j]["kemKey"].hex(), "signingKey": keys[j]["signingKey"].hex(), "commitment": kn.enc_point(commitments[j]).hex()}
            for j in qualified
        ],
    }


def seat_shares(result, r):
    """Each qualified new seat's share: Σ_{i ∈ Q} λ_i · (g_i(j), g'_i(j)), from its shares and the reveals, checked against C'_j."""
    q = result["dealers"]
    r1, r2, _, r4 = r["rounds"]
    reveals = {}
    for m in r4:
        for x in read_list(Reader(m["body"]), MAX_TRUSTEES, nk.read_reveal):
            reveals[(m["index"], x["complainer"])] = (x["share"], x["blind"])
    out = []
    for qq in result["qualified"]:
        j = qq["index"]
        sk = s = 0
        for i in q:
            if (i, j) in reveals:
                v = reveals[(i, j)]
            else:
                code, _, share, blind = check_share(r["context"], j, kem_secret(r["news"][j]), r1, r2, r["dealt"][(i, j)])
                assert code == "ok", (i, j, code)
                v = (share, blind)
            lam = lagrange(i, q)
            sk, s = (sk + lam * v[0]) % BL, (s + lam * v[1]) % BL
        assert kn.enc_point(opening(sk, s)).hex() == qq["commitment"] and sk != 0
        out.append({"index": j, "sk": sk, "s": s})
    return out


def interpolate(points):
    return sum(v * lagrange(i, [x for x, _ in points]) for i, v in points) % BL


def resign(m, round_, prev, d):
    return {**m, "sig": signed(round_, prev, m["index"], m["body"], d)}


def approval_message(new, index, pred_id, key_id, scope=SCOPE):
    return u64(scope["l2ChainId"]) + scope["groupRegistry"] + pid(new) + u8(index) + pred_id + key_id


# --- Vectors ------------------------------------------------------------------------------


def main(out):
    kn.self_check()
    grp.self_check()
    se.mlkem_self_check(100)
    se.aead_self_check()
    nk.J, _ = kn.derive_j()

    panels = {
        "old-4": make_panel("reshare-old-4", 2, 4),
        "new-4": make_panel("reshare-new-4", 3, 4),
    }
    old, new = panels["old-4"], panels["new-4"]

    # The predecessor: nullifier-key.md's rounds on the old 2-of-4 panel, seat 4 absent,
    # so seats 1 to 3 hold shares and seat 4 doesn't.
    pr = nk.run("reshare-predecessor", old, [1, 2, 3])
    pb = nk.enc_transcript(pr["runId"], pr["rounds"])
    pres = nk.check(old, pb)
    assert pres["ok"] and [q["index"] for q in pres["qualified"]] == [1, 2, 3]
    pshares = {x["index"]: {"sk": int(x["sk"]), "s": int(x["s"])} for x in nk.seat_shares(pres, pr)}
    sk = sum(pr["secrets"][d]["f"][0] for d in pres["dealers"]) % BL
    assert interpolate([(i, v["sk"]) for i, v in pshares.items()][:2]) == sk
    pred = {
        "keyId": bytes.fromhex(pres["keyId"]),
        "shares": pshares,
        "commitments": {q["index"]: kn.dec_point(bytes.fromhex(q["commitment"]), False) for q in pres["qualified"]},
        "signingKeys": {q["index"]: bytes.fromhex(q["signingKey"]) for q in pres["qualified"]},
    }

    vectors, share_checks, runs = [], [], {}

    def add(id_, desc, new_name, dealers, seats, cheat=None, honest=False, expect=None, mutate=None, pred_=pred):
        np_ = panels[new_name]
        r = reshare(id_, old, pred_, np_, dealers, seats, cheat)
        b = enc_transcript(r["runId"], pred["keyId"], r["rounds"])
        if mutate is not None:
            b = mutate(b, r)
        result = check(old, pred, np_, b)
        if result["ok"]:
            got = ([(d["index"], d["reasons"]) for d in result["dealerResults"] if d["reasons"]], [(s["index"], s["reasons"]) for s in result["seats"] if s["reasons"]])
        else:
            got = result["code"]
        if expect is not None:
            assert got == expect, (id_, got, expect)
        v = {"id": id_, "description": desc, "newPanel": new_name, "transcript": b.hex(), "result": result}
        if result["ok"] and mutate is None and "rounds" not in (cheat or {}):
            shares = seat_shares(result, r)
            # Any k' of the new shares interpolate to the predecessor's sk.
            for subset in itertools.combinations(shares, np_["k"]):
                assert interpolate([(x["index"], x["sk"]) for x in subset]) == sk, id_
            v["shares"] = [{"index": x["index"], "sk": str(x["sk"]), "s": str(x["s"])} for x in shares]
        if honest:
            v["runId"] = r["runId"].hex()
            v["context"] = r["context"].hex()
            v["dealers"] = [
                {
                    "index": i,
                    "f": [str(x) for x in s["f"]],
                    "g": [str(x) for x in s["g"]],
                    "shareRandomness": r["randomness"][i],
                    "resharedShares": [{"recipient": j, "bytes": bb.hex(), "hash": share_hash(bb).hex()} for (ii, j), bb in sorted(r["dealt"].items()) if ii == i],
                }
                for i, s in sorted(r["olds"].items())
            ]
            v["seats"] = [{"index": j, "kemSeed": s["seed"].hex(), "kemX": str(s["x"]), "signingSecret": f"{s['signing']:064x}"} for j, s in sorted(r["news"].items())]
        vectors.append(v)
        runs[id_] = r
        return r

    none = ([], [])
    add("honest", "Seats 1 to 3 of the predecessor's 2-of-4 panel reshare to a new 3-of-4 panel; every new seat qualifies.", "new-4", [1, 2, 3], [1, 2, 3, 4], honest=True, expect=none)
    add("two-dealers", "Only seats 1 and 3 deal, the predecessor's threshold: the new shares still give sk.", "new-4", [1, 3], [1, 2, 3, 4], honest=True, expect=none)
    add("refresh", "Seats 2 and 3 reshare to the predecessor's own panel: seat 4, absent from the predecessor, now holds a share.", "old-4", [2, 3], [1, 2, 3, 4], honest=True, expect=none)
    add("absent", "New seat 2 sends nothing; the other three qualify.", "new-4", [1, 2, 3], [1, 3, 4], honest=True, expect=([], [(2, ["absent"])]))

    def bad_share_to_2(i, j, plain):
        if (i, j) != (2, 2):
            return plain
        return bjj_scalar((int.from_bytes(plain[:32], "big") + 1) % BL) + plain[32:]

    def bad_seal_to_4(i, j, ctx):
        return H(b"another run") if (i, j) == (2, 4) else ctx

    cheats = {"plain": bad_share_to_2, "seal": bad_seal_to_4}
    add(
        "complaint-answered",
        "Dealer 2 seals a wrong share to new seat 2 (share-verify) and one that doesn't open to new seat 4 (share-decrypt), and signs both hashes; both complain and dealer 2 reveals both shares correctly, so it stays qualified.",
        "new-4",
        [1, 2, 3],
        [1, 2, 3, 4],
        cheats,
        honest=True,
        expect=none,
    )

    def wrong_reveal(i, c, share, blind):
        return ((share + 1) % BL, blind) if (i, c) == (2, 2) else (share, blind)

    add("bad-reveal", "As complaint-answered, but dealer 2 reveals a wrong share for new seat 2.", "new-4", [1, 2, 3], [1, 2, 3, 4], {**cheats, "reveal": wrong_reveal}, expect=([(2, ["bad-reveal"])], []))
    add("unanswered", "As complaint-answered, but dealer 2 sends no round-4 message.", "new-4", [1, 2, 3], [1, 2, 3, 4], {**cheats, "skip4": [2]}, expect=([(2, ["unanswered"])], []))
    add("corrupt-complaint", "New seat 3 complains about honest dealer 1 without cause: dealer 1 reveals seat 3's own share, which checks.", "new-4", [1, 2, 3], [1, 2, 3, 4], {"complain": {3: [1]}}, expect=none)

    def other_constant(i, s):
        # Dealer 3 reshares a value of its own choosing, not its share.
        if i == 3:
            s["f"][0] = (s["f"][0] + 1) % BL

    add("constant", "Dealer 3 reshares something other than its own share: B_{3,0} isn't C_3, and the other two dealers carry the key.", "new-4", [1, 2, 3], [1, 2, 3, 4], {"dealer": other_constant}, expect=([(3, ["constant"])], []))
    add("dealers", "Dealers 1 and 3 only, and dealer 3 reshares something other than its share: one qualified dealer, below k = 2.", "new-4", [1, 3], [1, 2, 3, 4], {"dealer": other_constant}, expect="key-dealers")

    def other_pop(j, s, all_):
        if j == 4:
            s["popSigner"] = all_[1]["signing"]

    add("possession", "New seat 4's signing-key signature is made by seat 1's signing key.", "new-4", [1, 2, 3], [1, 2, 3, 4], {"seat": other_pop}, expect=([], [(4, ["possession"])]))

    old_signing = {i: pr["secrets"][i]["signing"] for i in (1, 2, 3)}

    def reuse_predecessor_key(j, s, all_):
        # The refresh's seat 1 keeps the signing key it registered for the predecessor.
        if j == 1:
            s["signing"] = old_signing[1]

    add("duplicate-predecessor-key", "In a refresh, new seat 1 registers the signing key its seat registered for the predecessor.", "old-4", [2, 3], [1, 2, 3, 4], {"seat": reuse_predecessor_key}, expect=([], [(1, ["duplicate-key"])]))

    def old_identity(j, s, all_):
        if j == 3:
            s["signing"] = old["secrets"][0]

    add("duplicate-old-identity", "New seat 3 registers the old panel's seat 1 identity key as its signing key.", "new-4", [1, 2, 3], [1, 2, 3, 4], {"seat": old_identity}, expect=([], [(3, ["duplicate-key"])]))
    add("quorum", "Only new seats 1 and 2 take part: two qualified seats, below k' = 3.", "new-4", [1, 2, 3], [1, 2], expect="key-quorum")

    # Transcript-level failures.
    add("predecessor", "The transcript names another predecessor.", "new-4", [1, 2, 3], [1, 2, 3, 4], expect="key-predecessor", mutate=lambda b, r: b[:35] + H(b"another key") + b[67:])

    add(
        "order-dealer",
        "Old seat 4, which holds no share of the predecessor, deals as well (signed under its identity key).",
        "new-4",
        [1, 2, 4],
        [1, 2, 3, 4],
        expect="key-order",
    )

    def complaint_from_absent(rounds, ctx):
        r1, r2, r3, r4 = rounds
        h2 = round_hash(round_hash(ctx, 1, enc_round(r1)), 2, enc_round(r2))
        body = lst([u8(1)])
        return [r1, r2, r3 + [{"index": 2, "body": body, "sig": signed(3, h2, 2, body, new["secrets"][1])}], r4]

    add("order-complaint", "New seat 2, absent from round 1, complains about dealer 1 in round 3.", "new-4", [1, 2, 3], [1, 3, 4], {"rounds": complaint_from_absent}, expect="key-order")

    def short_hashes(rounds, ctx):
        r1, r2, r3, r4 = rounds
        h1 = round_hash(ctx, 1, enc_round(r1))
        m = r2[0]
        body = enc_commitments(m["commitments"]) + lst(m["hashes"][:-1])
        return [r1, [resign({**m, "body": body}, 2, h1, old["secrets"][m["index"] - 1])] + r2[1:], r3, r4]

    add("shape-hashes", "Dealer 1 omits its hash for the last new seat (signed as sent).", "new-4", [1, 2, 3], [1, 2, 3, 4], {"rounds": short_hashes}, expect="key-shape")

    def signed_by_new_panel(rounds, ctx):
        r1, r2, r3, r4 = rounds
        h1 = round_hash(ctx, 1, enc_round(r1))
        return [r1, [resign(m, 2, h1, new["secrets"][0]) if m["index"] == 1 else m for m in r2], r3, r4]

    add("signature-panel", "Dealer 1's round-2 message is signed by the new panel's seat 1 instead of the old panel's.", "new-4", [1, 2, 3], [1, 2, 3, 4], {"rounds": signed_by_new_panel}, expect="key-signature")
    add("signature-run", "The run identifier is changed: every message was signed under the original context.", "new-4", [1, 2, 3], [1, 2, 3, 4], expect="key-signature", mutate=lambda b, r: b[:3] + bytes(32) + b[35:])

    # Reshared-share checks, as new seat `recipient` of a run sees them.
    def share_check(id_, desc, run_id, recipient, b, want):
        r = runs[run_id]
        code, dealer, share, blind = check_share(r["context"], recipient, kem_secret(r["news"][recipient]), r["rounds"][0], r["rounds"][1], b)
        assert code == want, (id_, code, want)
        entry = {"id": id_, "description": desc, "run": run_id, "recipient": recipient, "bytes": b.hex(), "result": code}
        if dealer is not None:
            entry["dealer"] = dealer
        if code == "ok":
            entry["share"], entry["blind"] = str(share), str(blind)
        share_checks.append(entry)

    good = runs["honest"]["dealt"][(1, 2)]

    def relabel(b, at, v):
        return b[:at] + u8(v) + b[at + 1 :]

    share_check("ok", "Dealer 1's reshared share for new seat 2.", "honest", 2, good, "ok")
    share_check("malformed-truncated", "Without its last byte.", "honest", 2, good[:-1], "share-malformed")
    share_check("malformed-type", "Record type 0x0012, the initial sharing's dealt share.", "honest", 2, u16(0x0012) + good[2:], "share-malformed")
    share_check("context-recipient", "Dealer 1's share for new seat 2, checked by new seat 3.", "honest", 3, good, "share-context")
    share_check("context-run", "Dealer 1's share for new seat 2 of another run (two-dealers).", "honest", 2, runs["two-dealers"]["dealt"][(1, 2)], "share-context")
    share_check("context-dealer", "Dealer 1's share for new seat 2 of two-dealers, relabelled as dealt by old seat 2, which didn't deal there.", "two-dealers", 2, relabel(runs["two-dealers"]["dealt"][(1, 2)], 35, 2), "share-context")
    share_check("hash", "Dealer 1's share for new seat 3, relabelled as for new seat 2.", "honest", 2, relabel(runs["honest"]["dealt"][(1, 3)], 36, 2), "share-hash")
    share_check("decrypt", "Dealer 2's share for new seat 4, sealed under another context and signed.", "complaint-answered", 4, runs["complaint-answered"]["dealt"][(2, 4)], "share-decrypt")
    share_check("verify", "Dealer 2's wrong share for new seat 2, sealed correctly and signed.", "complaint-answered", 2, runs["complaint-answered"]["dealt"][(2, 2)], "share-verify")

    # Approvals of honest's successor by every new seat, and two that don't count.
    honest = next(v for v in vectors if v["id"] == "honest")
    key_id = bytes.fromhex(honest["result"]["keyId"])
    approvals = []
    for j in range(1, 5):
        m = approval_message(new, j, pred["keyId"], key_id)
        assert len(m) == 125
        approvals.append({"index": j, "message": m.hex(), "signature": sign(new["secrets"][j - 1], APPROVAL_TAG, m).hex()})
    extra = [
        {"id": "other-predecessor", "description": "Seat 1's approval of this key as a successor of another key", "index": 1, "signature": sign(new["secrets"][0], APPROVAL_TAG, approval_message(new, 1, H(b"another key"), key_id)).hex(), "counts": False},
        {"id": "initial-tag", "description": "Seat 2's signature over the same statement under the initial key's approval tag", "index": 2, "signature": sign(new["secrets"][1], nk.APPROVAL_TAG, approval_message(new, 2, pred["keyId"], key_id)).hex(), "counts": False},
    ]

    # Decoding.
    base = bytes.fromhex(honest["transcript"])
    decode = []

    def dec(id_, desc, b):
        res = check(old, pred, new, b)
        assert not res["ok"], id_
        decode.append({"id": id_, "description": desc, "transcript": b.hex(), "error": res["code"]})

    dec("truncated", "The honest transcript without its last byte.", base[:-1])
    dec("trailing", "The honest transcript with one more byte.", base + b"\x00")
    dec("version-2", "Version 2, which doesn't exist.", base[:2] + u8(2) + base[3:])
    dec("record-type", "Record type 0x0014, the reshared share, where a transcript is expected.", u16(0x0014) + base[2:])
    dec("initial-type", "Record type 0x0011, the initial key's transcript, which this file doesn't list.", u16(0x0011) + base[2:])
    dec("keys-over-max", "Round 1 claims 17 messages.", base[:67] + u32(17) + base[71:])
    r1_len = 4 + 4 * (1 + 1216 + 33 + 64 + 64)
    at_c = 67 + r1_len + 4 + 1 + 4
    dec("commitment-identity", "Dealer 1's first coefficient commitment is the identity.", base[:at_c] + kn.enc_point(BID) + base[at_c + 64 :])
    at_h = at_c + 64 * 3
    dec("hashes-over-max", "Dealer 1 claims 17 share hashes.", base[:at_h] + u32(17) + base[at_h + 4 :])

    doc = {
        "format": "abolish-nullifier-reshare-vectors/1",
        "title": "Tier 2 nullifier key resharing: transcripts, reshared shares, their checks, key_id and approvals",
        "spec": "docs/spec/nullifier-reshare.md",
        "generator": "packages/crypto/scripts/nullifier-reshare-vectors.py: an independent Python implementation (standard library only) on nullifier-key-vectors.py's, and through it keyed-nullifier-vectors.py's Baby Jubjub, share-encryption-vectors.py's ML-KEM-768 and ChaCha20-Poly1305, group-vectors.py's ristretto255 and trustee-vectors.py's P-256 ECDSA, each checked against published vectors first. Every value is test data, never keys",
        "tags": {t.decode(): t.decode() for t in [CONTEXT_TAG, ROUND_TAG, KEY_TAG, SHARE_HASH_TAG, KEM_TAG, AAD_TAG, MESSAGE_TAG, SIGNING_KEY_TAG, APPROVAL_TAG]},
        "recordTypes": {"transcript": TRANSCRIPT_TYPE, "resharedShare": SHARE_TYPE},
        "scope": {"l2ChainId": str(SCOPE["l2ChainId"]), "groupRegistry": SCOPE["groupRegistry"].hex()},
        "panels": {
            name: {"threshold": p["k"], "identitySecrets": [f"{d:064x}" for d in p["secrets"]], "keys": [k.hex() for k in p["keys"]]}
            for name, p in panels.items()
        },
        "predecessor": {
            "panel": "old-4",
            "transcript": pb.hex(),
            "keyId": pres["keyId"],
            "sk": str(sk),
            "shares": [{"index": i, "sk": str(v["sk"]), "s": str(v["s"])} for i, v in sorted(pshares.items())],
        },
        "transcripts": vectors,
        "resharedShareChecks": share_checks,
        "approvals": {"newPanel": "new-4", "keyId": key_id.hex(), "approvals": approvals, "notCounted": extra},
        "decode": decode,
    }
    pathlib.Path(out, "nullifier-reshare.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
