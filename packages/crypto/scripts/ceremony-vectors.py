#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/ceremony.json.

A second implementation of docs/spec/ceremony.md: the ceremony context, the
four rounds and their signatures, the transcript record (0x0005, version 1),
its hash and the transcript check. It is written from the spec with Python's
standard library only and shares no code with packages/crypto or any @noble
library. It reuses share-encryption-vectors.py's ML-KEM-768 (written from
FIPS 203 and checked against Go's accumulated vectors first) and its
ristretto255 (group-vectors.py's, self-checked), and trustee-vectors.py's
P-256 ECDSA (which reproduces RFC 6979 Appendix A.2.5 first).

Every secret comes from SHA-512 or SHA-256 over a fixed label, and each honest
seat lists the values it used, so any implementation can reproduce its
messages byte for byte (ECDSA nonces are RFC 6979's). The values are test
data, never keys.

Usage: python3 -I -B packages/crypto/scripts/ceremony-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
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


se = _load("share_encryption_vectors", "share-encryption-vectors.py")
ecdsa = _load("trustee_vectors", "trustee-vectors.py")
grp, bv = se.grp, se.bv

L = grp.L
G = grp.BASE
MAX_TRUSTEES = 16
TRANSCRIPT_TYPE = 0x0005
VERSION = 1
CT_LEN = 1088

CONTEXT_TAG = b"abolish/v1/ceremony-context"
ROUND_TAG = b"abolish/v1/ceremony-round"
CHALLENGE_TAG = b"abolish/v1/ceremony-challenge"
TRANSCRIPT_TAG = b"abolish/v1/ceremony-transcript"
POSSESSION_TAG = b"abolish/v1/fs/ceremony/possession"
MESSAGE_TAG = b"abolish/v1/sig/ceremony-message"
SIGNING_KEY_TAG = b"abolish/v1/sig/ceremony-signing-key"
PANEL_TAG = b"abolish/v1/panel"

u8, u16, u32, scalar, element, ds, H = bv.u8, bv.u16, bv.u32, bv.scalar, bv.element, bv.ds, bv.H


def u64(x):
    return x.to_bytes(8, "big")


def lst(items):
    return u32(len(items)) + b"".join(items)


# --- Keys ---------------------------------------------------------------------------


def p256_secret(rng):
    d = int.from_bytes(rng.bytes32(), "big") % ecdsa.N
    assert d != 0
    return d


def p256_key(d):
    return ecdsa.compress(ecdsa.mul(d, ecdsa.G))


def sign(d, tag, m):
    _, r, s = ecdsa.ecdsa_sign(d, ds(tag, m))
    return ecdsa.sig_bytes(r, s)


def verify(key, tag, m, sig):
    return ecdsa.verify(key, ds(tag, m), sig)


def panel_id(k, keys):
    return H(ds(PANEL_TAG, u8(k) + u8(len(keys)) + b"".join(keys)))


def make_panel(label, k, n):
    rng = bv.Rng(f"ceremony-panel/{label}")
    secrets = [p256_secret(rng) for _ in range(n)]
    keys = [p256_key(d) for d in secrets]
    assert len(set(keys)) == n
    return {"label": label, "k": k, "secrets": secrets, "keys": keys}


ELECTION = {
    "l2ChainId": 84532,
    "trusteeRegistry": bytes.fromhex("5fbdb2315678afecb367f032d93f642f64180aa3"),
    "electionId": H(b"ceremony-vectors/election-id"),
    "stubHash": H(b"ceremony-vectors/stub-hash"),
}


def context(panel, run_id, election=ELECTION):
    return H(
        ds(
            CONTEXT_TAG,
            u64(election["l2ChainId"])
            + election["trusteeRegistry"]
            + election["electionId"]
            + election["stubHash"]
            + panel_id(panel["k"], panel["keys"])
            + run_id,
        )
    )


# --- Messages -----------------------------------------------------------------------


def enc_kem_key(ek, dh):
    return ek + element(dh)


def possession_challenge(ctx, i, kem_key, signing_key, a):
    return bv.hash_to_scalar(ctx + u8(i) + kem_key + signing_key + element(a, True), POSSESSION_TAG)


def pop_message(ctx, i, kem_key, signing_key):
    return ctx + u8(i) + kem_key + signing_key


def challenge_m(ctx, j, i, mu):
    """The ML-KEM message of seat j's challenge to seat i (spec: Round 2)."""
    return H(ds(CHALLENGE_TAG, ctx + u8(j) + u8(i) + mu))


def signed(round_, prev, index, body, d):
    return sign(d, MESSAGE_TAG, u8(round_) + prev + u8(index) + body)


def round_hash(prev, round_, encoded):
    return H(ds(ROUND_TAG, prev + u8(round_) + encoded))


def enc_msg(m):
    return u8(m["index"]) + m["body"] + m["sig"]


def enc_round(msgs):
    return lst([enc_msg(m) for m in msgs])


def enc_transcript(run_id, rounds, record_type=TRANSCRIPT_TYPE, version=VERSION):
    return u16(record_type) + u8(version) + run_id + b"".join(enc_round(r) for r in rounds)


def seat_secrets(label, index):
    rng = bv.Rng(f"ceremony-seat/{label}/{index}")
    seed = rng.bytes32() + rng.bytes32()
    x = rng.scalar()
    assert x != 0
    w = rng.scalar()
    assert w != 0
    d = p256_secret(rng)
    ek, dk = se.keygen_internal(seed[:32], seed[32:])
    return {"index": index, "seed": seed, "x": x, "w": w, "signing": d, "ek": ek, "dk": dk, "rng": rng}


def keys_body(ctx, s, panel):
    kem_key = enc_kem_key(s["ek"], se.pt_mul(s["x"], G))
    signing_key = s.get("signingKeyOverride") or p256_key(s["signing"])
    c = possession_challenge(ctx, s["index"], kem_key, signing_key, se.pt_mul(s["w"], G))
    z = (s["w"] + c * s["x"]) % L
    pop = sign(s.get("popSigner", s["signing"]), SIGNING_KEY_TAG, pop_message(ctx, s["index"], kem_key, signing_key))
    return kem_key + signing_key + scalar(c) + scalar(z) + pop


# --- The ceremony, with ways for a seat to cheat --------------------------------------


def run(label, panel, seats, cheat=None):
    """Runs the four rounds for `seats` (indices taking part); `cheat` maps a hook name to a function."""
    cheat = cheat or {}
    run_id = H(f"ceremony-run/{label}".encode())
    ctx = context(panel, run_id)
    secrets = {i: seat_secrets(label, i) for i in seats}
    for i, s in secrets.items():
        if "seat" in cheat:
            cheat["seat"](i, s, secrets)
    d = {i: panel["secrets"][i - 1] for i in seats}

    r1 = []
    for i in sorted(seats):
        body = keys_body(ctx, secrets[i], panel)
        if "keys" in cheat:
            body = cheat["keys"](i, body, ctx)
        r1.append({"index": i, "body": body, "sig": signed(1, ctx, i, body, d[i])})
    if "round1" in cheat:
        r1 = cheat["round1"](r1, ctx, d)
    h1 = round_hash(ctx, 1, enc_round(r1))
    s1 = [m["index"] for m in r1]
    eks = {m["index"]: m["body"][:1184] for m in r1}

    r2, mus = [], {}
    for j in [i for i in s1 if i in seats and cheat.get("skip2") != i]:
        cts = []
        mus[j] = []
        for t in [x for x in s1 if x != j]:
            mu = secrets[j]["rng"].bytes32()
            _, ct = se.encaps_internal(eks[t], challenge_m(ctx, j, t, mu))
            cts.append(ct)
            mus[j].append(mu)
        if "challenges" in cheat:
            cts = cheat["challenges"](j, cts, {"r2": r2, "s1": s1, "mus": mus})
        body = lst(cts)
        r2.append({"index": j, "body": body, "sig": signed(2, h1, j, body, d[j])})
    h2 = round_hash(h1, 2, enc_round(r2))
    s2 = [m["index"] for m in r2]
    cts_of = {m["index"]: split(m["body"], CT_LEN) for m in r2}

    r3 = []
    for i in [x for x in s1 if x in seats and cheat.get("skip3") != x]:
        answers = []
        for j in [x for x in s2 if x != i]:
            at = [x for x in s1 if x != j].index(i)
            # A short challenge list (the shape vector) leaves nothing to decapsulate.
            answers.append(se.decaps_internal(secrets[i]["dk"], cts_of[j][at]) if at < len(cts_of[j]) else bytes(32))
        if "answers" in cheat:
            answers = cheat["answers"](i, answers, {"r3": r3, "s1": s1, "s2": s2, "mus": mus, "ctx": ctx, "ek1": eks.get(1)})
        body = lst(answers)
        r3.append({"index": i, "body": body, "sig": signed(3, h2, i, body, d[i])})
    h3 = round_hash(h2, 3, enc_round(r3))

    r4 = []
    for j in [x for x in s2 if cheat.get("skip4") != x]:
        reveals = list(mus[j])
        if "reveals" in cheat:
            reveals = cheat["reveals"](j, reveals, {"mus": mus, "s1": s1})
        body = lst(reveals)
        r4.append({"index": j, "body": body, "sig": signed(4, h3, j, body, d[j])})

    rounds = [r1, r2, r3, r4]
    if "rounds" in cheat:
        rounds = cheat["rounds"](rounds, ctx, d)
    return {"runId": run_id, "context": ctx, "rounds": rounds, "secrets": secrets, "mus": mus}


def split(body, size):
    count = int.from_bytes(body[:4], "big")
    out = [body[4 + size * k : 4 + size * (k + 1)] for k in range(count)]
    assert 4 + size * count == len(body)
    return out


# --- The transcript check (docs/spec/ceremony.md, Transcript check) -------------------


class DecodeFail(Exception):
    def __init__(self, code):
        self.code = code


class Reader:
    def __init__(self, b):
        self.b, self.o = b, 0

    def take(self, n):
        if self.o + n > len(self.b):
            raise DecodeFail("truncated")
        out = self.b[self.o : self.o + n]
        self.o += n
        return out

    def uint(self, n):
        return int.from_bytes(self.take(n), "big")


def read_scalar(r):
    v = int.from_bytes(r.take(32), "little")
    if v >= L:
        raise DecodeFail("non-canonical")
    return v


def read_element(r):
    b = r.take(32)
    p = grp.decode(b)
    if p is None or b == bytes(32):
        raise DecodeFail("non-canonical")
    return p


def read_p256_key(r):
    b = r.take(33)
    if ecdsa.decompress(b) is None:
        raise DecodeFail("non-canonical")
    return b


def read_sig(r):
    b = r.take(64)
    rr, ss = int.from_bytes(b[:32], "big"), int.from_bytes(b[32:], "big")
    if not (1 <= rr < ecdsa.N and 1 <= ss <= ecdsa.HALF_N):
        raise DecodeFail("non-canonical")
    return b


def read_list(r, max_, item):
    count = r.uint(4)
    if count > max_:
        raise DecodeFail("length-over-max")
    return [item(r) for _ in range(count)]


def read_keys_msg(r):
    start = r.o
    index = r.uint(1)
    ek = r.take(1184)
    if not se.ek_ok(ek):
        raise DecodeFail("non-canonical")
    dh = read_element(r)
    signing_key = read_p256_key(r)
    c, z = read_scalar(r), read_scalar(r)
    pop = read_sig(r)
    body = r.b[start + 1 : r.o]
    sig = read_sig(r)
    return {"index": index, "ek": ek, "dh": dh, "kemKey": ek + element(dh), "signingKey": signing_key, "c": c, "z": z, "pop": pop, "body": body, "sig": sig}


def read_list_msg(size):
    def read(r):
        start = r.o
        index = r.uint(1)
        items = read_list(r, MAX_TRUSTEES - 1, lambda rr: rr.take(size))
        body = r.b[start + 1 : r.o]
        return {"index": index, "items": items, "body": body, "sig": read_sig(r)}

    return read


def decode_transcript(b, pinned=VERSION):
    r = Reader(b)
    # In a vector file the known types are those it lists (notation.md): here only 0x0005.
    if r.uint(2) != TRANSCRIPT_TYPE:
        raise DecodeFail("unknown-record-type")
    if r.uint(1) != pinned:
        raise DecodeFail("profile-mismatch")
    run_id = r.take(32)
    rounds = [
        read_list(r, MAX_TRUSTEES, read_keys_msg),
        read_list(r, MAX_TRUSTEES, read_list_msg(CT_LEN)),
        read_list(r, MAX_TRUSTEES, read_list_msg(32)),
        read_list(r, MAX_TRUSTEES, read_list_msg(32)),
    ]
    if r.o != len(b):
        raise DecodeFail("trailing-bytes")
    return run_id, rounds


def check(panel, b):
    try:
        run_id, rounds = decode_transcript(b)
    except DecodeFail as e:
        return {"ok": False, "code": e.code}
    n, k = len(panel["keys"]), panel["k"]
    ctx = context(panel, run_id)
    r1, r2, r3, r4 = rounds
    s1 = [m["index"] for m in r1]
    s2 = [m["index"] for m in r2]

    def increasing(xs):
        return all(1 <= x <= n for x in xs) and all(a < b for a, b in zip(xs, xs[1:]))

    # 1. Order.
    if not all(increasing([m["index"] for m in rr]) for rr in rounds):
        return {"ok": False, "code": "ceremony-order"}
    if not all(m["index"] in s1 for m in r2 + r3) or not all(m["index"] in s2 for m in r4):
        return {"ok": False, "code": "ceremony-order"}
    # 2. Shape.
    for m in r2 + r4:
        if len(m["items"]) != len([x for x in s1 if x != m["index"]]):
            return {"ok": False, "code": "ceremony-shape"}
    for m in r3:
        if len(m["items"]) != len([x for x in s2 if x != m["index"]]):
            return {"ok": False, "code": "ceremony-shape"}
    # 3. Signatures, each over the hash of the rounds before its own.
    h = [ctx]
    for rnum in (1, 2, 3):
        h.append(round_hash(h[-1], rnum, enc_round(rounds[rnum - 1])))
    for rnum, rr in enumerate(rounds, start=1):
        for m in rr:
            msg = u8(rnum) + h[rnum - 1] + u8(m["index"]) + m["body"]
            if not verify(panel["keys"][m["index"] - 1], MESSAGE_TAG, msg, m["sig"]):
                return {"ok": False, "code": "ceremony-signature"}
    # 4. Seats.
    keys = {m["index"]: m for m in r1}
    passing = []
    for m in r1:
        a = grp.add(se.pt_mul(m["z"], G), grp.neg(se.pt_mul(m["c"], m["dh"])))
        pok = possession_challenge(ctx, m["index"], m["kemKey"], m["signingKey"], a) == m["c"]
        pop = verify(m["signingKey"], SIGNING_KEY_TAG, pop_message(ctx, m["index"], m["kemKey"], m["signingKey"]), m["pop"])
        if pok and pop:
            passing.append(m["index"])
    dhs = [element(keys[i]["dh"]) for i in passing]
    sks = [keys[i]["signingKey"] for i in passing]
    ch = {m["index"]: m["items"] for m in r2}
    an = {m["index"]: m["items"] for m in r3}
    rv = {m["index"]: m["items"] for m in r4}
    shared = {}
    for j, mus in rv.items():
        for at, t in enumerate([x for x in s1 if x != j]):
            ss, ct = se.encaps_internal(keys[t]["ek"], challenge_m(ctx, j, t, mus[at]))
            shared[(j, t)] = ss if ct == ch[j][at] else None
    seats = []
    for i in range(1, n + 1):
        reasons = []
        if i not in keys:
            reasons.append("absent")
            seats.append({"index": i, "reasons": reasons})
            continue
        if i not in passing:
            reasons.append("possession")
        elif dhs.count(element(keys[i]["dh"])) > 1 or sks.count(keys[i]["signingKey"]) > 1 or keys[i]["signingKey"] in panel["keys"]:
            reasons.append("duplicate-key")
        if i not in ch:
            reasons.append("no-challenges")
        if i not in an:
            reasons.append("no-answers")
        if i in ch and i not in rv:
            reasons.append("no-reveals")
        if i in rv and any(shared[(i, t)] is None for t in s1 if t != i):
            reasons.append("bad-challenge")
        if i in an:
            for at, j in enumerate([x for x in s2 if x != i]):
                ss = shared.get((j, i))
                if ss is not None and ss != an[i][at]:
                    reasons.append("wrong-answer")
                    break
        seats.append({"index": i, "reasons": reasons})
    qualified = [s["index"] for s in seats if not s["reasons"]]
    if len(qualified) < k:
        return {"ok": False, "code": "ceremony-quorum", "seats": seats}
    return {
        "ok": True,
        "hash": H(ds(TRANSCRIPT_TAG, b)).hex(),
        "seats": seats,
        "registered": [{"index": i, "kemKey": keys[i]["kemKey"].hex(), "signingKey": keys[i]["signingKey"].hex()} for i in qualified],
    }


# --- Vectors ------------------------------------------------------------------------------


def resign(m, round_, prev, d):
    return {**m, "sig": signed(round_, prev, m["index"], m["body"], d)}


def main(out):
    ecdsa.self_check()
    grp.self_check()
    se.mlkem_self_check(100)

    panels = {
        "panel-4": make_panel("panel-4", 3, 4),
        "panel-4-k2": make_panel("panel-4-k2", 2, 4),
        "panel-2": make_panel("panel-2", 2, 2),
        "panel-16": make_panel("panel-16", 11, 16),
    }
    vectors = []

    def add(id_, desc, panel_name, seats, cheat=None, honest=False, expect=None, mutate=None):
        panel = panels[panel_name]
        r = run(id_, panel, seats, cheat)
        b = enc_transcript(r["runId"], r["rounds"])
        if mutate is not None:
            b = mutate(b, r)
        result = check(panel, b)
        if expect is not None:
            got = result["code"] if not result["ok"] else [(s["index"], s["reasons"]) for s in result["seats"] if s["reasons"]]
            assert got == expect, (id_, got, expect)
        v = {"id": id_, "description": desc, "panel": panel_name, "transcript": b.hex(), "result": result}
        if honest:
            v["context"] = r["context"].hex()
            v["runId"] = r["runId"].hex()
            v["seats"] = [
                {
                    "index": i,
                    "kemSeed": s["seed"].hex(),
                    "kemX": str(s["x"]),
                    "signingSecret": f"{s['signing']:064x}",
                    "pokNonce": str(s["w"]),
                    "challengeSecrets": [mu.hex() for mu in r["mus"].get(i, [])],
                }
                for i, s in sorted(r["secrets"].items())
            ]
        vectors.append(v)
        return r

    # Honest runs, reproduced byte for byte by packages/crypto.
    add("honest-4", "Every seat of a 3-of-4 panel takes part honestly; all four qualify.", "panel-4", [1, 2, 3, 4], honest=True, expect=[])
    add("honest-2", "The smallest panel, 2-of-2.", "panel-2", [1, 2], honest=True, expect=[])
    add("honest-16", "MAX_TRUSTEES: an 11-of-16 panel, 240 challenges.", "panel-16", list(range(1, 17)), honest=True, expect=[])
    add("absent", "Seat 4 sends nothing; the other three qualify, which meets k = 3.", "panel-4", [1, 2, 3], honest=True, expect=[(4, ["absent"])])

    # Seat disqualifications.
    def bad_z(i, body, ctx):
        if i != 2:
            return body
        z_at = 1216 + 33 + 32
        z = int.from_bytes(body[z_at : z_at + 32], "little")
        return body[:z_at] + scalar((z + 1) % L) + body[z_at + 32 :]

    add("possession-pok", "Seat 2's proof of knowledge of x has z + 1 (its message is signed as sent).", "panel-4", [1, 2, 3, 4], {"keys": bad_z}, expect=[(2, ["possession"])])

    def other_pop(i, s, all_):
        if i == 3:
            s["popSigner"] = all_[1]["signing"]

    add("possession-pop", "Seat 3's signing-key signature is made by seat 1's signing key.", "panel-4", [1, 2, 3, 4], {"seat": other_pop}, expect=[(3, ["possession"])])

    def shared_x(i, s, all_):
        if i == 3:
            s["x"] = all_[2]["x"]

    add("duplicate-dh", "Seats 2 and 3 register the same DH key, each with a valid proof: both hold x, and both are excluded.", "panel-4-k2", [1, 2, 3, 4], {"seat": shared_x}, expect=[(2, ["duplicate-key"]), (3, ["duplicate-key"])])

    def own_identity(i, s, all_):
        if i == 1:
            s["signing"] = panels["panel-4"]["secrets"][0]

    add("signing-is-identity", "Seat 1 registers its own identity key as its per-election signing key.", "panel-4", [1, 2, 3, 4], {"seat": own_identity}, expect=[(1, ["duplicate-key"])])

    def copy_entry(r1, ctx, d):
        src = next(m for m in r1 if m["index"] == 1)
        return [resign({**m, "body": src["body"]}, 1, ctx, d[4]) if m["index"] == 4 else m for m in r1]

    add("copied-entry", "Seat 4 copies seat 1's keys and proofs: the proofs bind seat 1, so seat 4 fails possession and seat 1 is unaffected.", "panel-4", [1, 2, 3, 4], {"round1": copy_entry}, expect=[(4, ["possession", "wrong-answer"])])

    def copied_ek(i, s, all_):
        if i == 4:
            s["ek"] = all_[1]["ek"]

    def garbage_answers(i, answers, *_):
        return [bv.H(b"no dk/" + bytes([i, k])) for k in range(len(answers))] if i == 4 else answers

    add("copied-ek", "Seat 4 registers seat 1's ML-KEM key with its own DH key and proofs, and can't decapsulate, so it answers its challenges wrongly. Seat 1 still qualifies: there is no duplicate rule for ek.", "panel-4", [1, 2, 3, 4], {"seat": copied_ek, "answers": garbage_answers}, expect=[(4, ["wrong-answer"])])
    add("no-challenges", "Seat 2 sends no challenges (and so no reveals).", "panel-4", [1, 2, 3, 4], {"skip2": 2}, expect=[(2, ["no-challenges"])])
    add("no-answers", "Seat 3 sends no answers.", "panel-4", [1, 2, 3, 4], {"skip3": 3}, expect=[(3, ["no-answers"])])
    add("no-reveals", "Seat 1 sends no reveals; its challenges count against no one.", "panel-4", [1, 2, 3, 4], {"skip4": 1}, expect=[(1, ["no-reveals"])])

    def wrong_mu(j, reveals, *_):
        return [bv.H(b"other mu")] + reveals[1:] if j == 2 else reveals

    add("bad-challenge", "Seat 2 reveals a μ for seat 1 that doesn't encapsulate to its challenge; seat 1, whose answer can't be checked, is unaffected.", "panel-4", [1, 2, 3, 4], {"reveals": wrong_mu}, expect=[(2, ["bad-challenge"])])

    def wrong_answer(i, answers, *_):
        return [bv.H(b"guess")] + answers[1:] if i == 4 else answers

    add("wrong-answer", "Seat 4 answers seat 1's challenge with something other than its shared secret.", "panel-4", [1, 2, 3, 4], {"answers": wrong_answer}, expect=[(4, ["wrong-answer"])])

    def shared_signing(i, s, all_):
        if i == 4:
            s["signing"] = all_[3]["signing"]

    add("duplicate-signing-key", "Seats 3 and 4 register the same per-election signing key, each with a valid signature: both hold it, and both are excluded.", "panel-4-k2", [1, 2, 3, 4], {"seat": shared_signing}, expect=[(3, ["duplicate-key"]), (4, ["duplicate-key"])])

    # The relay: a seat holding a copy of seat 1's ek sends seat 1's own challenge
    # to it back to seat 1 as its challenge, rushing, and copies seat 1's answer.
    # `relayer` puts `source`'s challenge to `victim` in its own slot to seat 1,
    # the holder of the ek the victim copied, and later reveals `source`'s μ.
    def relay_challenge(relayer, victim, source):
        def hook(j, cts, st):
            if j != relayer:
                return cts
            # Rushing: the source's round-2 message is already out.
            src = next(m for m in st["r2"] if m["index"] == source)
            relayed = split(src["body"], CT_LEN)[[x for x in st["s1"] if x != source].index(victim)]
            at = [x for x in st["s1"] if x != j].index(1)
            return cts[:at] + [relayed] + cts[at + 1 :]

        return hook

    def relay_reveal(relayer, victim, source):
        def hook(j, reveals, st):
            if j != relayer:
                return reveals
            mu = st["mus"][source][[x for x in st["s1"] if x != source].index(victim)]
            at = [x for x in st["s1"] if x != j].index(1)
            return reveals[:at] + [mu] + reveals[at + 1 :]

        return hook

    def copy_ek_of_1(target):
        def hook(i, s, all_):
            if i == target:
                s["ek"] = all_[1]["ek"]

        return hook

    def relayed_answers(victim, pairs, accomplices=()):
        # pairs: challenger -> the relayer whose challenge to seat 1 carried its
        # challenge; accomplices: corrupt challengers that hand over their μ.
        def hook(i, answers, st):
            if i != victim:
                return answers
            holder_answers = split(next(m for m in st["r3"] if m["index"] == 1)["body"], 32)
            others = [x for x in st["s2"] if x != i]
            out = list(answers)
            for challenger, relayer in pairs.items():
                out[others.index(challenger)] = holder_answers[[x for x in st["s2"] if x != 1].index(relayer)]
            for a in accomplices:
                mu = st["mus"][a][[x for x in st["s1"] if x != a].index(i)]
                out[others.index(a)] = se.encaps_internal(st["ek1"], challenge_m(st["ctx"], a, i, mu))[0]
            return out

        return hook

    add(
        "relay-2",
        "Seat 2 registers seat 1's ek, relays seat 1's challenge to it back to seat 1 as its own challenge, copies seat 1's answer and reveals seat 1's μ. The pair in m makes the relayed challenge fail its reveal: seat 2 is disqualified, and one seat is below k = 2.",
        "panel-2",
        [1, 2],
        {"seat": copy_ek_of_1(2), "challenges": relay_challenge(2, 2, 1), "answers": relayed_answers(2, {1: 2}), "reveals": relay_reveal(2, 2, 1)},
        expect="ceremony-quorum",
    )

    def both(*hooks):
        def hook(j, items, st):
            for h in hooks:
                items = h(j, items, st)
            return items

        return hook

    add(
        "relay-sacrificed",
        "Corrupt seats 3 and 4 of a 2-of-4 panel: seat 4 registers seat 1's ek; seat 3 relays seat 1's challenge to seat 4, and seat 4 relays seat 2's, each to seat 1 as its own challenge. Seat 4 answers every challenge correctly, but both relayers fail their reveals, leaving the two honest seats.",
        "panel-4-k2",
        [1, 2, 3, 4],
        {
            "seat": copy_ek_of_1(4),
            "challenges": both(relay_challenge(3, 4, 1), relay_challenge(4, 4, 2)),
            "answers": relayed_answers(4, {1: 3, 2: 4}, accomplices=(3,)),
            "reveals": both(relay_reveal(3, 4, 1), relay_reveal(4, 4, 2)),
        },
        expect=[(3, ["bad-challenge"]), (4, ["bad-challenge"])],
    )

    def two_bad(i, answers, *_):
        return [bv.H(b"guess")] + answers[1:] if i in (3, 4) else answers

    add("quorum", "Seats 3 and 4 both answer wrongly; two qualified seats are below k = 3.", "panel-4", [1, 2, 3, 4], {"answers": two_bad}, expect="ceremony-quorum")

    # Transcripts that fail as a whole.
    def swap_round1(rounds, ctx, d):
        r1 = rounds[0]
        r1 = [r1[1], r1[0]] + r1[2:]
        # Re-signed in the swapped order, so only the order is wrong.
        return [r1] + rounds[1:]

    add("order-keys", "Round 1 lists seat 2 before seat 1.", "panel-4", [1, 2, 3, 4], {"rounds": swap_round1}, expect="ceremony-order")

    def reveal_without_challenge(rounds, ctx, d):
        r1, r2, r3, r4 = rounds
        return [r1, [m for m in r2 if m["index"] != 3], r3, r4]

    add("order-reveals", "Seat 3's challenges are dropped from round 2 after the fact, but its reveals stay in round 4.", "panel-4", [1, 2, 3, 4], {"rounds": reveal_without_challenge}, expect="ceremony-order")

    def short_challenges(j, cts, *_):
        return cts[:-1] if j == 1 else cts

    add("shape-challenges", "Seat 1 sends one challenge too few.", "panel-4", [1, 2, 3, 4], {"challenges": short_challenges}, expect="ceremony-shape")

    def equivocate(rounds, ctx, d):
        # Seat 1 signs a second round-1 message with other keys; rounds 2 to 4 were signed over the first.
        other = keys_body(ctx, seat_secrets("equivocation", 1), panels["panel-4"])
        r1 = [resign({**m, "body": other}, 1, ctx, d[1]) if m["index"] == 1 else m for m in rounds[0]]
        return [r1] + rounds[1:]

    add("signature-chain", "Seat 1's round-1 message is swapped for another it also signed; every later message signed over the round 1 it replaced.", "panel-4", [1, 2, 3, 4], {"rounds": equivocate}, expect="ceremony-signature")

    def flip_answer(b, r):
        # The last byte of seat 4's last answer, inside its signed body.
        r3 = r["rounds"][2]
        enc = enc_round(r["rounds"][0]) + enc_round(r["rounds"][1])
        start = 2 + 1 + 32 + len(enc) + len(enc_round(r3)) - 64 - 1
        return b[:start] + bytes([b[start] ^ 1]) + b[start + 1 :]

    add("signature-altered", "A byte of seat 4's answers is changed after it signed.", "panel-4", [1, 2, 3, 4], expect="ceremony-signature", mutate=flip_answer)

    def wrong_run(b, r):
        return b[:3] + bytes(32) + b[35:]

    add("signature-run", "The run identifier is changed: every message was signed under the original context.", "panel-4", [1, 2, 3, 4], expect="ceremony-signature", mutate=wrong_run)

    # Decoding.
    base = bytes.fromhex(vectors[1]["transcript"])  # honest-2
    decode = []

    def dec(id_, desc, b):
        res = check(panels["panel-2"], b)
        assert not res["ok"], id_
        decode.append({"id": id_, "description": desc, "transcript": b.hex(), "error": res["code"]})

    dec("truncated", "The honest 2-of-2 transcript without its last byte.", base[:-1])
    dec("trailing", "The honest 2-of-2 transcript with one more byte.", base + b"\x00")
    dec("version-2", "Version 2, which no profile pins.", base[:2] + u8(2) + base[3:])
    dec("record-type", "Record type 0x0004 (a receipt), which this file doesn't list.", u16(0x0004) + base[2:])
    dec("keys-over-max", "Round 1 claims 17 messages.", base[:35] + u32(17) + base[39:])
    at_ek = 35 + 4 + 1
    dec("ek-modulus", "Seat 1's ek fails FIPS 203's modulus check (first coefficient 4095).", base[:at_ek] + b"\xff\x0f" + base[at_ek + 2 :])
    at_dh = at_ek + 1184
    dec("dh-identity", "Seat 1's DH key is the identity.", base[:at_dh] + bytes(32) + base[at_dh + 32 :])
    at_sk = at_dh + 32
    dec("signing-key-uncompressed", "Seat 1's signing key starts 0x04.", base[:at_sk] + b"\x04" + base[at_sk + 1 :])
    at_c = at_sk + 33
    dec("pok-c-overflow", "Seat 1's challenge is ℓ.", base[:at_c] + scalar_raw(L) + base[at_c + 32 :])
    at_sig = at_c + 64 + 64
    dec("signature-high-s", "Seat 1's signature has s > (n − 1) / 2.", base[:at_sig + 32] + (ecdsa.N - 1).to_bytes(32, "big") + base[at_sig + 64 :])

    doc = {
        "format": "abolish-ceremony-vectors/1",
        "title": "Key ceremony: transcripts, their checks and their hashes",
        "spec": "docs/spec/ceremony.md",
        "generator": "packages/crypto/scripts/ceremony-vectors.py: an independent Python implementation (standard library only), with share-encryption-vectors.py's ML-KEM-768 (checked against Go's accumulated FIPS 203 vectors first) and ristretto255, and trustee-vectors.py's P-256 ECDSA, which reproduces RFC 6979 Appendix A.2.5 first. Every value is test data, never keys",
        "tags": {t.decode(): t.decode() for t in [CONTEXT_TAG, ROUND_TAG, CHALLENGE_TAG, TRANSCRIPT_TAG, POSSESSION_TAG, MESSAGE_TAG, SIGNING_KEY_TAG]},
        "election": {
            "l2ChainId": str(ELECTION["l2ChainId"]),
            "trusteeRegistry": ELECTION["trusteeRegistry"].hex(),
            "electionId": ELECTION["electionId"].hex(),
            "stubHash": ELECTION["stubHash"].hex(),
        },
        "panels": {
            name: {"threshold": p["k"], "identitySecrets": [f"{d:064x}" for d in p["secrets"]], "keys": [k.hex() for k in p["keys"]]}
            for name, p in panels.items()
        },
        "transcripts": vectors,
        "decode": decode,
    }
    pathlib.Path(out, "ceremony.json").write_text(json.dumps(doc, indent=2) + "\n")


def scalar_raw(x):
    return x.to_bytes(32, "little")


if __name__ == "__main__":
    main(sys.argv[1])
