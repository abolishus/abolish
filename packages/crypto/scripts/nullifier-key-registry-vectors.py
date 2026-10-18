#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/nullifier-key-registry.json.

A second implementation of the group registry's nullifier-key records
(docs/spec/contracts.md, Group registry, Nullifier keys): the initial-key
approval statement of docs/spec/nullifier-key.md (Approval,
abolish/v1/sig/nullifier-key-approval-3), the successor's approval and the old
panel's consent of docs/spec/nullifier-reshare.md (Approval,
abolish/v1/sig/nullifier-reshare-approval-2; Consent,
abolish/v1/sig/nullifier-reshare-consent), the two records
`recordNullifierKey` and `recordNullifierReshare` take, and the registry's
checks replayed over a log of them, in its order. It is written from the spec
with Python's integers and hashlib; P-256 ECDSA comes from trustee-vectors.py,
which reproduces RFC 6979 Appendix A.2.5 first. Nothing here shares code with
packages/crypto or any @noble library.

The registry checks no transcript, so the key identifiers here are test
labels' hashes, not transcripts' key_ids. Every identity secret comes from
SHA-512 over a fixed label and every ECDSA nonce is RFC 6979's, so any
implementation reproduces each signature byte for byte. The values are test
data, never keys.

Usage: python3 -I -B packages/crypto/scripts/nullifier-key-registry-vectors.py <out-dir>,
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
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


ecdsa = _load("trustee_vectors", "trustee-vectors.py")

KEY_APPROVAL_TAG = b"abolish/v1/sig/nullifier-key-approval-3"
RESHARE_APPROVAL_TAG = b"abolish/v1/sig/nullifier-reshare-approval-2"
CONSENT_TAG = b"abolish/v1/sig/nullifier-reshare-consent"
# Retired: an approval under either never counts.
RETIRED_KEY_APPROVAL_TAG = b"abolish/v1/sig/nullifier-key-approval-2"
RETIRED_RESHARE_APPROVAL_TAG = b"abolish/v1/sig/nullifier-reshare-approval"
PANEL_TAG = b"abolish/v1/panel"

MAX_KEY_WINDOW = 302_400
MAX_RESHARE_WINDOW = 302_400

SCOPE = {"l2ChainId": 84532, "groupRegistry": bytes.fromhex("e7f1725e7734ce288f8367e1bb143e90bb3f0512")}


def u8(x):
    assert 0 <= x < 256
    return bytes([x])


def u64(x):
    return x.to_bytes(8, "big")


def ds(tag, m):
    return u8(len(tag)) + tag + m


def H(m):
    return hashlib.sha256(m).digest()


def label(s):
    return H(b"nullifier-key-registry-vectors/" + s.encode())


# --- Panels and signatures ------------------------------------------------------------------


def make_panel(name, k, n):
    secrets = []
    for i in range(1, n + 1):
        d = int.from_bytes(hashlib.sha512(f"nullifier-key-registry-panel/{name}/{i}".encode()).digest()[:32], "big") % ecdsa.N
        assert d != 0
        secrets.append(d)
    keys = [ecdsa.compress(ecdsa.mul(d, ecdsa.G)) for d in secrets]
    assert len(set(keys)) == n
    pid = H(ds(PANEL_TAG, u8(k) + u8(n) + b"".join(keys)))
    return {"name": name, "k": k, "n": n, "secrets": secrets, "keys": keys, "id": pid, "q": max(k, n - 1)}


def sign(d, tag, m):
    _, r, s = ecdsa.ecdsa_sign(d, ds(tag, m))
    assert s <= ecdsa.HALF_N
    return ecdsa.sig_bytes(r, s)


def verify(key, tag, m, sig):
    return ecdsa.verify(key, ds(tag, m), sig)


def key_approval_message(panel_id, index, key_id, deadline, scope=SCOPE):
    m = u64(scope["l2ChainId"]) + scope["groupRegistry"] + panel_id + u8(index) + key_id + u64(deadline)
    assert len(m) == 101
    return m


def reshare_approval_message(new_panel_id, index, predecessor, key_id, deadline, scope=SCOPE):
    m = u64(scope["l2ChainId"]) + scope["groupRegistry"] + new_panel_id + u8(index) + predecessor + key_id + u64(deadline)
    assert len(m) == 133
    return m


def consent_message(old_panel_id, index, predecessor, new_panel_id, key_id, deadline, scope=SCOPE):
    m = u64(scope["l2ChainId"]) + scope["groupRegistry"] + old_panel_id + u8(index) + predecessor + new_panel_id + key_id + u64(deadline)
    assert len(m) == 165
    return m


def approval(index, sig):
    assert len(sig) == 64
    return u8(index) + sig


# --- Records -------------------------------------------------------------------------------


def key_record(deadline, key_id, approvals):
    return u64(deadline) + key_id + u8(len(approvals)) + b"".join(approvals)


def reshare_record(predecessor, new_panel_id, deadline, key_id, consents, approvals):
    return (
        predecessor + new_panel_id + u64(deadline) + key_id
        + u8(len(consents)) + b"".join(consents) + u8(len(approvals)) + b"".join(approvals)
    )


def parse_approvals(b, at, count):
    out = []
    for _ in range(count):
        out.append((b[at], b[at + 1 : at + 65]))
        at += 65
    return out, at


def decode_key(b):
    """None unless the record is exactly 41 + 65 · count bytes (check 2)."""
    if len(b) < 41 or len(b) != 41 + 65 * b[40]:
        return None
    approvals, _ = parse_approvals(b, 41, b[40])
    return {"deadline": int.from_bytes(b[0:8], "big"), "keyId": b[8:40], "approvals": approvals}


def decode_reshare(b):
    """None unless the record's length is as check 2 says."""
    if len(b) < 105:
        return None
    c = b[104]
    if len(b) < 106 + 65 * c:
        return None
    count = b[105 + 65 * c]
    if len(b) != 106 + 65 * (c + count):
        return None
    consents, at = parse_approvals(b, 105, c)
    approvals, _ = parse_approvals(b, at + 1, count)
    return {
        "predecessor": b[0:32],
        "newPanelId": b[32:64],
        "deadline": int.from_bytes(b[64:72], "big"),
        "keyId": b[72:104],
        "consents": consents,
        "approvals": approvals,
    }


# --- The registry's checks, replayed --------------------------------------------------------


def seats_and_signatures(sigs, panel, message_of, tag):
    last = 0
    for index, sig in sigs:
        if index <= last or index > panel["n"]:
            return "seat"
        last = index
        if not verify(panel["keys"][index - 1], tag, message_of(index), sig):
            return "signature"
    return None


def replay(events, panels, initial):
    """The registry's checks over a log, in its order, after decoding and the topics.

    Returns the chain of recorded keys and, if a record fails, its position and code."""
    by_id = {p["id"]: p for p in panels}
    current = None  # (key_id, panel)
    recorded = set()
    keys = []

    def fail(at, code):
        return {"ok": False, "at": at, "code": code, "keys": keys}

    for at, e in enumerate(events):
        block = e["l2Block"]
        if e["kind"] == "initial":
            r = decode_key(e["record"])
            if r is None:
                return fail(at, "length")
            if e["keyId"] != r["keyId"]:
                return fail(at, "topic")
            if current is not None:
                return fail(at, "key-recorded")
            if not block <= r["deadline"] <= block + MAX_KEY_WINDOW:
                return fail(at, "deadline")
            if r["keyId"] == bytes(32):
                return fail(at, "key-id")
            if len(r["approvals"]) < initial["q"]:
                return fail(at, "quorum")
            code = seats_and_signatures(
                r["approvals"], initial, lambda i: key_approval_message(initial["id"], i, r["keyId"], r["deadline"]), KEY_APPROVAL_TAG
            )
            if code:
                return fail(at, code)
            current = (r["keyId"], initial)
            recorded.add(r["keyId"])
            keys.append({"keyId": r["keyId"].hex(), "panelId": initial["id"].hex(), "deadline": str(r["deadline"]), "l2Block": str(block), "predecessor": None})
        else:
            r = decode_reshare(e["record"])
            if r is None:
                return fail(at, "length")
            if (e["predecessor"], e["keyId"], e["newPanelId"]) != (r["predecessor"], r["keyId"], r["newPanelId"]):
                return fail(at, "topic")
            if current is None or r["predecessor"] != current[0]:
                return fail(at, "predecessor")
            new = by_id.get(r["newPanelId"])
            if new is None:
                return fail(at, "panel")
            if not block <= r["deadline"] <= block + MAX_RESHARE_WINDOW:
                return fail(at, "deadline")
            if r["keyId"] == bytes(32):
                return fail(at, "key-id")
            if r["keyId"] in recorded:
                return fail(at, "key-recorded")
            old = current[1]
            if len(r["consents"]) < old["q"] or len(r["approvals"]) < new["q"]:
                return fail(at, "quorum")
            code = seats_and_signatures(
                r["consents"], old,
                lambda i: consent_message(old["id"], i, r["predecessor"], new["id"], r["keyId"], r["deadline"]), CONSENT_TAG,
            ) or seats_and_signatures(
                r["approvals"], new,
                lambda j: reshare_approval_message(new["id"], j, r["predecessor"], r["keyId"], r["deadline"]), RESHARE_APPROVAL_TAG,
            )
            if code:
                return fail(at, code)
            current = (r["keyId"], new)
            recorded.add(r["keyId"])
            keys.append({"keyId": r["keyId"].hex(), "panelId": new["id"].hex(), "deadline": str(r["deadline"]), "l2Block": str(block), "predecessor": r["predecessor"].hex()})
    return {"ok": True, "keys": keys}


# --- Vectors -------------------------------------------------------------------------------


def main(out):
    ecdsa.self_check()

    initial = make_panel("initial-5", 3, 5)  # q = 4
    nxt = make_panel("next-4", 3, 4)  # q' = 3
    outside = make_panel("outside-3", 2, 3)  # not pinned by the trustee registry
    panels = [initial, nxt]

    B1, B2, B3 = 1_000_000, 1_150_000, 1_300_000
    D1, D2, D3 = B1 + 200_000, B2 + 250_000, B3 + 100_000
    K1, K2, K3 = label("initial key"), label("successor"), label("refresh")

    def key_sigs(panel, seats, key_id, deadline, tag=KEY_APPROVAL_TAG, panel_id=None):
        return [approval(i, sign(panel["secrets"][i - 1], tag, key_approval_message(panel_id or panel["id"], i, key_id, deadline))) for i in seats]

    def consent_sigs(old, new, seats, pred, key_id, deadline, signer=None):
        signer = signer or old
        return [approval(i, sign(signer["secrets"][i - 1], CONSENT_TAG, consent_message(old["id"], i, pred, new["id"], key_id, deadline))) for i in seats]

    def approval_sigs(new, seats, pred, key_id, deadline, tag=RESHARE_APPROVAL_TAG):
        return [approval(j, sign(new["secrets"][j - 1], tag, reshare_approval_message(new["id"], j, pred, key_id, deadline))) for j in seats]

    # Statements, each with its digest and signature.
    statements = {"keyApproval": [], "reshareApproval": [], "reshareConsent": []}
    for i in range(1, 6):
        m = key_approval_message(initial["id"], i, K1, D1)
        statements["keyApproval"].append({"panel": "initial-5", "index": i, "keyId": K1.hex(), "deadline": str(D1), "message": m.hex(), "digest": H(ds(KEY_APPROVAL_TAG, m)).hex(), "signature": sign(initial["secrets"][i - 1], KEY_APPROVAL_TAG, m).hex()})
    for j in range(1, 5):
        m = reshare_approval_message(nxt["id"], j, K1, K2, D2)
        statements["reshareApproval"].append({"panel": "next-4", "index": j, "predecessor": K1.hex(), "keyId": K2.hex(), "deadline": str(D2), "message": m.hex(), "digest": H(ds(RESHARE_APPROVAL_TAG, m)).hex(), "signature": sign(nxt["secrets"][j - 1], RESHARE_APPROVAL_TAG, m).hex()})
    for i in range(1, 6):
        m = consent_message(initial["id"], i, K1, nxt["id"], K2, D2)
        statements["reshareConsent"].append({"panel": "initial-5", "index": i, "predecessor": K1.hex(), "newPanel": "next-4", "keyId": K2.hex(), "deadline": str(D2), "message": m.hex(), "digest": H(ds(CONSENT_TAG, m)).hex(), "signature": sign(initial["secrets"][i - 1], CONSENT_TAG, m).hex()})

    # The honest chain: the initial key with seats 1, 2, 3 and 5 (seat 4 absent), a
    # reshare to next-4 with four consents and three approvals, then a refresh of
    # next-4 with every seat, each record at its own block.
    def initial_event(record, key_id=K1, block=B1):
        return {"kind": "initial", "l2Block": block, "keyId": key_id, "record": record}

    def reshare_event(record, pred, key_id, new_id, block):
        return {"kind": "reshare", "l2Block": block, "predecessor": pred, "keyId": key_id, "newPanelId": new_id, "record": record}

    rec1 = key_record(D1, K1, key_sigs(initial, [1, 2, 3, 5], K1, D1))
    rec2 = reshare_record(K1, nxt["id"], D2, K2, consent_sigs(initial, nxt, [1, 2, 3, 5], K1, K2, D2), approval_sigs(nxt, [1, 2, 4], K1, K2, D2))
    rec3 = reshare_record(K2, nxt["id"], D3, K3, consent_sigs(nxt, nxt, [1, 2, 3, 4], K2, K3, D3), approval_sigs(nxt, [1, 2, 3, 4], K2, K3, D3))
    e1 = initial_event(rec1)
    e2 = reshare_event(rec2, K1, K2, nxt["id"], B2)
    e3 = reshare_event(rec3, K2, K3, nxt["id"], B3)

    cases = []

    def case(id_, desc, events, expect):
        result = replay(events, panels, initial)
        got = "ok" if result["ok"] else (result["at"], result["code"])
        assert got == expect, (id_, got, expect)
        cases.append({
            "id": id_,
            "description": desc,
            "events": [{**{k: (v.hex() if isinstance(v, bytes) else v) for k, v in e.items()}, "l2Block": str(e["l2Block"])} for e in events],
            "result": result,
        })

    case("honest", "The initial key, a reshare to next-4, then a refresh of next-4", [e1, e2, e3], "ok")
    case("initial-only", "The initial key alone", [e1], "ok")
    case("every-approval", "The initial key approved by all five seats", [initial_event(key_record(D1, K1, key_sigs(initial, [1, 2, 3, 4, 5], K1, D1)))], "ok")
    case("deadline-same-block", "The initial key recorded in its deadline's own block", [initial_event(key_record(D1, K1, key_sigs(initial, [1, 2, 3, 4], K1, D1)), block=D1)], "ok")
    case("deadline-window-edge", "A deadline exactly MAX_KEY_WINDOW ahead", [initial_event(key_record(B1 + MAX_KEY_WINDOW, K1, key_sigs(initial, [1, 2, 3, 4], K1, B1 + MAX_KEY_WINDOW)))], "ok")
    case("reshare-window-edge", "A reshare recorded in its deadline's block", [e1, reshare_event(rec2, K1, K2, nxt["id"], D2)], "ok")

    # Encodings the registry refuses (check 2).
    case("initial-truncated", "An initial record one byte short", [initial_event(rec1[:-1])], (0, "length"))
    case("initial-trailing", "An initial record with a trailing byte", [initial_event(rec1 + b"\x00")], (0, "length"))
    case("initial-short", "40 bytes: no count", [initial_event(rec1[:40])], (0, "length"))
    case("initial-count", "A count one more than the approvals carried", [initial_event(rec1[:40] + u8(5) + rec1[41:])], (0, "length"))
    case("reshare-truncated", "A reshare record one byte short", [e1, reshare_event(rec2[:-1], K1, K2, nxt["id"], B2)], (1, "length"))
    case("reshare-trailing", "A reshare record with a trailing byte", [e1, reshare_event(rec2 + b"\x00", K1, K2, nxt["id"], B2)], (1, "length"))
    case("reshare-short", "104 bytes: no consent count", [e1, reshare_event(rec2[:104], K1, K2, nxt["id"], B2)], (1, "length"))
    case("reshare-consents-overrun", "A consent count running past the record", [e1, reshare_event(rec2[:104] + u8(200) + rec2[105:], K1, K2, nxt["id"], B2)], (1, "length"))

    # The topics against the record.
    case("initial-topic", "NullifierKeyRecorded's key_id topic isn't the record's", [initial_event(rec1, key_id=K2)], (0, "topic"))
    case("reshare-topic-predecessor", "A reshare's predecessor topic isn't the record's", [e1, reshare_event(rec2, K3, K2, nxt["id"], B2)], (1, "topic"))
    case("reshare-topic-panel", "A reshare's new_panel_id topic isn't the record's", [e1, reshare_event(rec2, K1, K2, initial["id"], B2)], (1, "topic"))

    # Initial-key checks 3 to 8.
    second = key_record(D2, K2, key_sigs(initial, [1, 2, 3, 4], K2, D2))
    case("second-initial", "A second initial key once one is recorded", [e1, initial_event(second, K2, B2)], (1, "key-recorded"))
    case("initial-after-reshare", "An initial key after a reshare", [e1, e2, initial_event(key_record(D3, K3, key_sigs(initial, [1, 2, 3, 4], K3, D3)), K3, B3)], (2, "key-recorded"))
    late = key_record(B1 - 1, K1, key_sigs(initial, [1, 2, 3, 4], K1, B1 - 1))
    case("initial-deadline-passed", "Recorded one block after its deadline", [initial_event(late)], (0, "deadline"))
    far = B1 + MAX_KEY_WINDOW + 1
    case("initial-deadline-far", "A deadline one block beyond MAX_KEY_WINDOW", [initial_event(key_record(far, K1, key_sigs(initial, [1, 2, 3, 4], K1, far)))], (0, "deadline"))
    zero = bytes(32)
    case("initial-zero-key", "key_id zero", [initial_event(key_record(D1, zero, key_sigs(initial, [1, 2, 3, 4], zero, D1)), key_id=zero)], (0, "key-id"))
    case("initial-quorum", "Three approvals of five seats, below q = 4", [initial_event(key_record(D1, K1, key_sigs(initial, [1, 2, 3], K1, D1)))], (0, "quorum"))
    s = key_sigs(initial, [1, 2, 3, 4], K1, D1)
    case("initial-repeated-seat", "One seat's approval twice among four", [initial_event(key_record(D1, K1, [s[0], s[0], s[1], s[2]]))], (0, "seat"))
    case("initial-seat-order", "Seats out of order", [initial_event(key_record(D1, K1, [s[1], s[0], s[2], s[3]]))], (0, "seat"))
    case("initial-seat-zero", "Seat 0", [initial_event(key_record(D1, K1, [approval(0, s[0][1:])] + s[1:]))], (0, "seat"))
    s6 = sign(initial["secrets"][0], KEY_APPROVAL_TAG, key_approval_message(initial["id"], 6, K1, D1))
    case("initial-seat-beyond", "Seat 6 of a five-seat panel", [initial_event(key_record(D1, K1, s + [approval(6, s6)]))], (0, "seat"))
    case("initial-other-seat", "Seat 1's signature presented as seat 2's", [initial_event(key_record(D1, K1, [s[0], approval(2, s[0][1:]), s[2], s[3]]))], (0, "signature"))
    case("initial-retired-statement", "Seat 4 signed under the retired abolish/v1/sig/nullifier-key-approval-2", [initial_event(key_record(D1, K1, s[:3] + key_sigs(initial, [4], K1, D1, tag=RETIRED_KEY_APPROVAL_TAG)))], (0, "signature"))
    case("initial-other-deadline", "Seat 4 approved another deadline", [initial_event(key_record(D1, K1, s[:3] + key_sigs(initial, [4], K1, D1 + 1)))], (0, "signature"))
    case("initial-other-panel", "Seat 4's approval names another panel_id", [initial_event(key_record(D1, K1, s[:3] + key_sigs(initial, [4], K1, D1, panel_id=nxt["id"])))], (0, "signature"))
    s5 = key_sigs(initial, [5], K2, D1)
    case("initial-extra-bad", "Four good approvals and a fifth of another key: every approval must verify", [initial_event(key_record(D1, K1, s + s5))], (0, "signature"))
    hi = s[3][:33] + (ecdsa.N - int.from_bytes(s[3][33:], "big")).to_bytes(32, "big")
    case("initial-high-s", "Seat 4's signature with s replaced by n − s", [initial_event(key_record(D1, K1, s[:3] + [hi]))], (0, "signature"))

    # Reshare checks 3 to 9.
    case("reshare-first", "A reshare with no key recorded", [e2], (0, "predecessor"))
    case("reshare-stale", "A second successor of a retired key", [e1, e2, reshare_event(reshare_record(K1, nxt["id"], D3, K3, consent_sigs(initial, nxt, [1, 2, 3, 4], K1, K3, D3), approval_sigs(nxt, [1, 2, 3], K1, K3, D3)), K1, K3, nxt["id"], B3)], (2, "predecessor"))
    out_rec = reshare_record(K1, outside["id"], D2, K2, consent_sigs(initial, outside, [1, 2, 3, 4], K1, K2, D2), approval_sigs(outside, [1, 2, 3], K1, K2, D2))
    case("reshare-unpinned-panel", "A successor panel the trustee registry doesn't pin", [e1, reshare_event(out_rec, K1, K2, outside["id"], B2)], (1, "panel"))
    case("reshare-deadline-passed", "Recorded one block after its deadline", [e1, reshare_event(rec2, K1, K2, nxt["id"], D2 + 1)], (1, "deadline"))
    farr = B2 + MAX_RESHARE_WINDOW + 1
    rec_far = reshare_record(K1, nxt["id"], farr, K2, consent_sigs(initial, nxt, [1, 2, 3, 4], K1, K2, farr), approval_sigs(nxt, [1, 2, 3], K1, K2, farr))
    case("reshare-deadline-far", "A deadline one block beyond MAX_RESHARE_WINDOW", [e1, reshare_event(rec_far, K1, K2, nxt["id"], B2)], (1, "deadline"))
    rec_zero = reshare_record(K1, nxt["id"], D2, zero, consent_sigs(initial, nxt, [1, 2, 3, 4], K1, zero, D2), approval_sigs(nxt, [1, 2, 3], K1, zero, D2))
    case("reshare-zero-key", "A successor key_id of zero", [e1, reshare_event(rec_zero, K1, zero, nxt["id"], B2)], (1, "key-id"))
    rec_back = reshare_record(K2, nxt["id"], D3, K1, consent_sigs(nxt, nxt, [1, 2, 3], K2, K1, D3), approval_sigs(nxt, [1, 2, 3], K2, K1, D3))
    case("reshare-earlier-key", "A successor whose key_id is the initial key's, making it current again", [e1, e2, reshare_event(rec_back, K2, K1, nxt["id"], B3)], (2, "key-recorded"))
    rec_c3 = reshare_record(K1, nxt["id"], D2, K2, consent_sigs(initial, nxt, [1, 2, 3], K1, K2, D2), approval_sigs(nxt, [1, 2, 3, 4], K1, K2, D2))
    case("reshare-consent-quorum", "Three consents of the old five-seat panel, below q = 4", [e1, reshare_event(rec_c3, K1, K2, nxt["id"], B2)], (1, "quorum"))
    rec_a2 = reshare_record(K1, nxt["id"], D2, K2, consent_sigs(initial, nxt, [1, 2, 3, 4, 5], K1, K2, D2), approval_sigs(nxt, [1, 2], K1, K2, D2))
    case("reshare-approval-quorum", "Two approvals of the new four-seat panel, below q' = 3", [e1, reshare_event(rec_a2, K1, K2, nxt["id"], B2)], (1, "quorum"))
    c = consent_sigs(initial, nxt, [1, 2, 3, 4], K1, K2, D2)
    a = approval_sigs(nxt, [1, 2, 3], K1, K2, D2)
    case("reshare-consent-seat", "A consent seat repeated", [e1, reshare_event(reshare_record(K1, nxt["id"], D2, K2, [c[0], c[0], c[1], c[2]], a), K1, K2, nxt["id"], B2)], (1, "seat"))
    c6 = sign(initial["secrets"][0], CONSENT_TAG, consent_message(initial["id"], 6, K1, nxt["id"], K2, D2))
    case("reshare-consent-beyond", "Consent seat 6 of a five-seat panel", [e1, reshare_event(reshare_record(K1, nxt["id"], D2, K2, c + [approval(6, c6)], a), K1, K2, nxt["id"], B2)], (1, "seat"))
    a5 = sign(nxt["secrets"][0], RESHARE_APPROVAL_TAG, reshare_approval_message(nxt["id"], 5, K1, K2, D2))
    case("reshare-approval-beyond", "Approval seat 5 of a four-seat panel", [e1, reshare_event(reshare_record(K1, nxt["id"], D2, K2, c, a + [approval(5, a5)]), K1, K2, nxt["id"], B2)], (1, "seat"))
    case("reshare-approval-seat-order", "Approvals out of order", [e1, reshare_event(reshare_record(K1, nxt["id"], D2, K2, c, [a[1], a[0], a[2]]), K1, K2, nxt["id"], B2)], (1, "seat"))
    case("reshare-consent-seat-zero", "Consent seat 0", [e1, reshare_event(reshare_record(K1, nxt["id"], D2, K2, [approval(0, c[0][1:])] + c[1:], a), K1, K2, nxt["id"], B2)], (1, "seat"))
    def high_s(sig):
        return sig[:33] + (ecdsa.N - int.from_bytes(sig[33:], "big")).to_bytes(32, "big")
    case("reshare-consent-high-s", "Consent 4's signature with s replaced by n − s", [e1, reshare_event(reshare_record(K1, nxt["id"], D2, K2, c[:3] + [high_s(c[3])], a), K1, K2, nxt["id"], B2)], (1, "signature"))
    case("reshare-approval-high-s", "Approval 3's signature with s replaced by n − s", [e1, reshare_event(reshare_record(K1, nxt["id"], D2, K2, c, a[:2] + [high_s(a[2])]), K1, K2, nxt["id"], B2)], (1, "signature"))
    by_new = consent_sigs(initial, nxt, [1, 2, 3, 4], K1, K2, D2, signer=nxt)
    case("reshare-consent-new-keys", "Consents signed by the new panel's seats", [e1, reshare_event(reshare_record(K1, nxt["id"], D2, K2, by_new, a), K1, K2, nxt["id"], B2)], (1, "signature"))
    as_approval = [approval(i, sign(initial["secrets"][i - 1], RESHARE_APPROVAL_TAG, consent_message(initial["id"], i, K1, nxt["id"], K2, D2))) for i in [1, 2, 3, 4]]
    case("reshare-consent-tag", "The consent statement signed under the approval tag", [e1, reshare_event(reshare_record(K1, nxt["id"], D2, K2, as_approval, a), K1, K2, nxt["id"], B2)], (1, "signature"))
    other_panel = consent_sigs(initial, initial, [1, 2, 3, 4], K1, K2, D2)
    case("reshare-consent-other-panel", "Consents to the same key passing to another panel", [e1, reshare_event(reshare_record(K1, nxt["id"], D2, K2, other_panel, a), K1, K2, nxt["id"], B2)], (1, "signature"))
    retired = approval_sigs(nxt, [1, 2, 3], K1, K2, D2, tag=RETIRED_RESHARE_APPROVAL_TAG)
    case("reshare-retired-approval", "Approvals under the retired abolish/v1/sig/nullifier-reshare-approval", [e1, reshare_event(reshare_record(K1, nxt["id"], D2, K2, c, retired), K1, K2, nxt["id"], B2)], (1, "signature"))
    case("reshare-approval-deadline", "An approval of another deadline", [e1, reshare_event(reshare_record(K1, nxt["id"], D2, K2, c, a[:2] + approval_sigs(nxt, [3], K1, K2, D2 + 1)), K1, K2, nxt["id"], B2)], (1, "signature"))
    case("reshare-old-consents-on-refresh", "A refresh of next-4 carrying the initial panel's consents", [e1, e2, reshare_event(reshare_record(K2, nxt["id"], D3, K3, consent_sigs(initial, nxt, [1, 2, 3, 4], K2, K3, D3), approval_sigs(nxt, [1, 2, 3], K2, K3, D3)), K2, K3, nxt["id"], B3)], (2, "signature"))
    case("stops-at-first", "A failing record stops the chain: the refresh after it isn't replayed", [e1, reshare_event(rec2[:-1], K1, K2, nxt["id"], B2), e3], (1, "length"))

    def panel_doc(p):
        points = [ecdsa.decompress(k) for k in p["keys"]]
        return {
            "threshold": p["k"],
            "identitySecrets": [f"{d:064x}" for d in p["secrets"]],
            "keys": [k.hex() for k in p["keys"]],
            "points": [{"x": f"{x:064x}", "y": f"{y:064x}"} for x, y in points],
            "panelId": p["id"].hex(),
            "quorum": p["q"],
        }

    doc = {
        "format": "abolish-nullifier-key-registry-vectors/1",
        "title": "Tier 2 nullifier keys in the group registry: approval and consent statements, the two records and the registry's checks replayed",
        "spec": "docs/spec/contracts.md (Group registry, Nullifier keys), docs/spec/nullifier-key.md (Approval), docs/spec/nullifier-reshare.md (Approval, Consent)",
        "generator": "packages/crypto/scripts/nullifier-key-registry-vectors.py: an independent Python implementation (standard library only) on trustee-vectors.py's P-256 ECDSA, checked against RFC 6979 Appendix A.2.5 first. Every value is test data, never keys; key identifiers are labels' hashes, since the registry checks no transcript",
        "tags": {t.decode(): t.decode() for t in [KEY_APPROVAL_TAG, RESHARE_APPROVAL_TAG, CONSENT_TAG, RETIRED_KEY_APPROVAL_TAG, RETIRED_RESHARE_APPROVAL_TAG]},
        "parameters": {"MAX_KEY_WINDOW": MAX_KEY_WINDOW, "MAX_RESHARE_WINDOW": MAX_RESHARE_WINDOW},
        "scope": {"l2ChainId": str(SCOPE["l2ChainId"]), "groupRegistry": SCOPE["groupRegistry"].hex()},
        "panels": {p["name"]: panel_doc(p) for p in [initial, nxt, outside]},
        "pinnedPanels": ["initial-5", "next-4"],
        "initialPanel": "initial-5",
        "statements": statements,
        "records": {
            "initial": {"deadline": str(D1), "keyId": K1.hex(), "approvals": [1, 2, 3, 5], "record": rec1.hex()},
            "reshare": {"predecessor": K1.hex(), "newPanel": "next-4", "deadline": str(D2), "keyId": K2.hex(), "consents": [1, 2, 3, 5], "approvals": [1, 2, 4], "record": rec2.hex()},
            "refresh": {"predecessor": K2.hex(), "newPanel": "next-4", "deadline": str(D3), "keyId": K3.hex(), "consents": [1, 2, 3, 4], "approvals": [1, 2, 3, 4], "record": rec3.hex()},
        },
        "replays": cases,
    }
    pathlib.Path(out, "nullifier-key-registry.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
