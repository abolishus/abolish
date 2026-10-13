#!/usr/bin/env python3
"""Independent generator for docs/spec/vectors/receipt-opening.json.

A second implementation of docs/spec/receipts.md, Opening: the opening's
layout, the Merkle Patricia trie proof of a transaction (yellow paper,
Appendix D), RLP (Appendix B), the transaction types' calldata, the SSZ
branches of the consensus specs, and the six checks in order. It is written
from the spec with Python's standard library only and shares no code with
packages/crypto. Keccak-256 is group-registry-vectors.py's, the receipt and
the commitment are receipt-vectors.py's and receipt-evidence-vectors.py's.

Two real blocks, one of Ethereum mainnet and one of Sepolia, are rebuilt from
scripts/l1-blocks/ (fetched by l1-blocks-fetch.py): the header's RLP must hash
to the block's hash and the rebuilt transaction trie to its
`transactionsRoot`, so the RLP, the trie and keccak are checked against the
chains themselves. Everything on the beacon side is synthetic, since no beacon
API was reachable from the session that wrote this; the SSZ rules are the
consensus specs'.

Usage: python3 -I -B packages/crypto/scripts/receipt-opening-vectors.py <out-dir> [<configs-dir>],
then `vp check --fix` (the committed file is formatted; its values are what
this prints).
"""

import hashlib
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__)


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE.with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_keccak256 = load("group_registry_vectors", "group-registry-vectors.py").keccak256
_hashed = {}


def keccak256(b):
    # The pure-Python permutation is slow and the trie is rebuilt for each proof.
    b = bytes(b)
    if b not in _hashed:
        _hashed[b] = _keccak256(b)
    return _hashed[b]

evidence = load("receipt_evidence_vectors", "receipt-evidence-vectors.py")
rv = evidence.rv


def sha256(b):
    return hashlib.sha256(b).digest()


def h(b):
    return b.hex()


def label(s, n=32):
    return sha256(b"receipt opening " + s.encode())[:n]


# ----------------------------------------------------------------------- RLP


def rlp(x):
    if isinstance(x, list):
        payload = b"".join(rlp(i) for i in x)
        return length_prefix(len(payload), 0xC0) + payload
    if len(x) == 1 and x[0] < 0x80:
        return x
    return length_prefix(len(x), 0x80) + x


def length_prefix(n, base):
    if n < 56:
        return bytes([base + n])
    be = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([base + 55 + len(be)]) + be


def rlp_int(n):
    return b"" if n == 0 else n.to_bytes((n.bit_length() + 7) // 8, "big")


class Bad(Exception):
    pass


def rlp_decode(b):
    """Exactly one canonical item: bytes, or a list of items. Raises Bad."""

    def item(at, depth):
        if at >= len(b):
            raise Bad
        p = b[at]
        if p < 0x80:
            return b[at : at + 1], at + 1
        if p < 0xB8:
            start, n = at + 1, p - 0x80
            if n == 1 and start < len(b) and b[start] < 0x80:
                raise Bad
        elif p < 0xC0:
            start, n = long_len(at, p - 0xB7)
        elif p < 0xF8:
            start, n = at + 1, p - 0xC0
        else:
            start, n = long_len(at, p - 0xF7)
        end = start + n
        if end > len(b):
            raise Bad
        if p < 0xC0:
            return b[start:end], end
        if depth >= 16:
            raise Bad
        out, i = [], start
        while i < end:
            x, i = item(i, depth + 1)
            if i > end:
                raise Bad
            out.append(x)
        return out, end

    def long_len(at, k):
        if at + 1 + k > len(b) or b[at + 1] == 0:
            raise Bad
        n = int.from_bytes(b[at + 1 : at + 1 + k], "big")
        if n < 56:
            raise Bad
        return at + 1 + k, n

    x, end = item(0, 0)
    if end != len(b):
        raise Bad
    return x


# ---------------------------------------------------------- transaction trie


def nibbles(b):
    return [n for x in b for n in (x >> 4, x & 15)]


def hex_prefix(nibs, leaf):
    flag = 2 if leaf else 0
    if len(nibs) % 2:
        nibs = [flag + 1] + nibs
    else:
        nibs = [flag, 0] + nibs
    return bytes(nibs[i] << 4 | nibs[i + 1] for i in range(0, len(nibs), 2))


def trie_node(pairs):
    """The node over (nibbles, value) pairs with distinct, prefix-free keys."""
    if len(pairs) == 1:
        k, v = pairs[0]
        return [hex_prefix(k, True), v]
    pre = 0
    while all(len(k) > pre for k, _ in pairs) and len({k[pre] for k, _ in pairs}) == 1:
        pre += 1
    if pre:
        return [hex_prefix(pairs[0][0][:pre], False), ref(trie_node([(k[pre:], v) for k, v in pairs]))]
    branch = [b""] * 17
    for nib in range(16):
        sub = [(k[1:], v) for k, v in pairs if k and k[0] == nib]
        if sub:
            branch[nib] = ref(trie_node(sub))
    for k, v in pairs:
        if not k:
            branch[16] = v
    return branch


def ref(node):
    enc = rlp(node)
    return node if len(enc) < 32 else keccak256(enc)


def tx_pairs(txs):
    return [(nibbles(rlp(rlp_int(i))), tx) for i, tx in enumerate(txs)]


def trie_root(txs):
    return keccak256(rlp(trie_node(tx_pairs(txs))))


def trie_proof(txs, index):
    """The hashed nodes on the path to `index`, root first."""
    out = []
    assert 0 <= index < len(txs)
    pairs, key, root = tx_pairs(txs), nibbles(rlp(rlp_int(index))), True
    while True:
        node = trie_node(pairs)
        enc = rlp(node)
        if root or len(enc) >= 32:
            out.append(enc)
        root = False
        if len(pairs) == 1:
            return out
        if len(node) == 2:
            pre = len(nibbles(node[0])) - (1 if node[0][0] >> 4 & 1 else 2)
            pairs, key = [(k[pre:], v) for k, v in pairs], key[pre:]
        else:
            pairs, key = [(k[1:], v) for k, v in pairs if k and k[0] == key[0]], key[1:]


def trie_value(root, index, proof):
    """The yellow paper's lookup of key RLP(index), from the proof alone, every node used; or None."""
    key = nibbles(rlp(rlp_int(index)))
    want, used = ("hash", root), 0
    while True:
        if want[0] == "hash":
            if used >= len(proof) or keccak256(proof[used]) != want[1]:
                return None
            if used and len(proof[used]) < 32:
                return None
            try:
                node = rlp_decode(proof[used])
            except Bad:
                return None
            used += 1
        else:
            node = want[1]
        if not isinstance(node, list):
            return None
        if len(node) == 17:
            if not key:
                value = node[16]
                break
            child, key = node[key[0]], key[1:]
        elif len(node) == 2:
            path = node[0]
            if isinstance(path, list) or not path or path[0] >> 4 > 3:
                return None
            flag = path[0] >> 4
            if not flag & 1 and path[0] & 15:
                return None
            p = nibbles(path)[1 if flag & 1 else 2 :]
            if flag >= 2:
                if p != key:
                    return None
                value = node[1]
                break
            if not p or key[: len(p)] != p:
                return None
            child, key = node[1], key[len(p) :]
        else:
            return None
        if isinstance(child, list):
            if len(rlp(child)) >= 32:
                return None
            want = ("node", child)
        elif len(child) == 32:
            want = ("hash", child)
        else:
            return None
    if isinstance(value, list) or not value or used != len(proof):
        return None
    return value


DATA_AT = {0x01: (11, 6), 0x02: (12, 7), 0x03: (14, 7), 0x04: (13, 7)}


def calldata(tx):
    if not tx:
        return None
    fields, at = (9, 5) if tx[0] >= 0xC0 else DATA_AT.get(tx[0], (None, None))
    if fields is None:
        return None
    try:
        x = rlp_decode(tx if tx[0] >= 0xC0 else tx[1:])
    except Bad:
        return None
    if not isinstance(x, list) or len(x) != fields or isinstance(x[at], list):
        return None
    return x[at]


def tx(kind, data, nonce=0):
    """A transaction of each type with placeholder signature values: the opening reads only `data`."""
    to, sig = label("to", 20), [1, rlp_int(int.from_bytes(label(f"r{nonce}"), "big")), rlp_int(int.from_bytes(label(f"s{nonce}"), "big"))]
    sig = [rlp_int(sig[0])] + sig[1:]
    n = rlp_int(nonce)
    if kind == 0:
        return rlp([n, rlp_int(7), rlp_int(21000), to, b"", data, rlp_int(37), sig[1], sig[2]])
    access = [[label("al", 20), [label("slot")]]]
    if kind == 1:
        return b"\x01" + rlp([rlp_int(1), n, rlp_int(7), rlp_int(30000), to, b"", data, access] + sig)
    if kind == 2:
        return b"\x02" + rlp([rlp_int(1), n, rlp_int(1), rlp_int(9), rlp_int(30000), to, b"", data, access] + sig)
    if kind == 3:
        blob = [b"\x01" + label("blob")[1:]]
        return b"\x03" + rlp([rlp_int(1), n, rlp_int(1), rlp_int(9), rlp_int(30000), to, b"", data, [], rlp_int(3), blob] + sig)
    auth = [[rlp_int(1), label("delegate", 20), rlp_int(0), rlp_int(1), rlp_int(5), rlp_int(6)]]
    return b"\x04" + rlp([rlp_int(1), n, rlp_int(1), rlp_int(9), rlp_int(30000), to, b"", data, [], auth] + sig)


# -------------------------------------------------------------------- headers

REAL_FIELDS = [
    ("parentHash", "h"),
    ("sha3Uncles", "h"),
    ("miner", "h"),
    ("stateRoot", "h"),
    ("transactionsRoot", "h"),
    ("receiptsRoot", "h"),
    ("logsBloom", "h"),
    ("difficulty", "i"),
    ("number", "i"),
    ("gasLimit", "i"),
    ("gasUsed", "i"),
    ("timestamp", "i"),
    ("extraData", "h"),
    ("mixHash", "h"),
    ("nonce", "h"),
    ("baseFeePerGas", "i"),
    ("withdrawalsRoot", "h"),
    ("blobGasUsed", "i"),
    ("excessBlobGas", "i"),
    ("parentBeaconBlockRoot", "h"),
    ("requestsHash", "h"),
]


def real_header(fields):
    items = []
    for name, kind in REAL_FIELDS:
        v = fields[name]
        items.append(bytes.fromhex(v[2:]) if kind == "h" else rlp_int(int(v, 16)))
    return rlp(items)


def header(tx_root, timestamp, number=1, tweak=None):
    """A Prague/Osaka-shaped header (21 fields); `tweak` replaces items to build malformed ones."""
    items = [
        label("parent"),
        label("ommers"),
        label("coinbase", 20),
        label("state"),
        tx_root,
        label("receipts"),
        bytes(256),
        b"",
        rlp_int(number),
        rlp_int(36_000_000),
        rlp_int(21_000),
        rlp_int(timestamp),
        b"abolish",
        label("mix"),
        bytes(8),
        rlp_int(7),
        label("withdrawals"),
        b"",
        b"",
        label("beacon parent"),
        label("requests"),
    ]
    if tweak:
        items = tweak(items)
    return rlp(items)


# ----------------------------------------------------------------------- SSZ


def fold(leaf, branch, index):
    v = leaf
    for i, s in enumerate(branch):
        v = sha256(s + v) if index >> i & 1 else sha256(v + s)
    return v


def header_root(slot, proposer, parent, state, body):
    leaves = [slot.to_bytes(8, "little") + bytes(24), proposer.to_bytes(8, "little") + bytes(24), parent, state, body] + [bytes(32)] * 3
    while len(leaves) > 1:
        leaves = [sha256(leaves[i] + leaves[i + 1]) for i in range(0, len(leaves), 2)]
    return leaves[0]


def config(path):
    """FORK_VERSION and FORK_EPOCH lines of a consensus-specs config file."""
    out = {}
    for line in path.read_text().splitlines():
        k, _, v = line.partition(":")
        v = v.split("#")[0].strip()
        if k.endswith("_FORK_VERSION") or k.endswith("_FORK_EPOCH"):
            out[k] = v
    return out


# The schedules as pinned (docs/spec/receipts.md, Fork schedule), from the
# consensus specs' configs/mainnet.yaml and eth-clients/sepolia's
# metadata/config.yaml (fetched 2026-10-13). FAR_FUTURE forks are omitted.
SCHEDULES = {
    1: [
        ("phase0", 0, "00000000"),
        ("altair", 74240, "01000000"),
        ("bellatrix", 144896, "02000000"),
        ("capella", 194048, "03000000"),
        ("deneb", 269568, "04000000"),
        ("electra", 364032, "05000000"),
        ("fulu", 411392, "06000000"),
    ],
    11155111: [
        ("phase0", 0, "90000069"),
        ("altair", 50, "90000070"),
        ("bellatrix", 100, "90000071"),
        ("capella", 56832, "90000072"),
        ("deneb", 132608, "90000073"),
        ("electra", 222464, "90000074"),
        ("fulu", 272640, "90000075"),
        ("gloas", 353024, "90000076"),
    ],
}
GINDEX = {"capella": 412, "deneb": 812, "electra": 812, "fulu": 812}


def fork_at(chain, slot):
    active = None
    for f in SCHEDULES[chain]:
        if f[1] * 32 <= slot:
            active = f
    return active


# ------------------------------------------------------------- the opening


def u32(x):
    return x.to_bytes(4, "big")


def u64(x):
    return x.to_bytes(8, "big")


def encode_opening(o):
    return (
        o["salt"]
        + u32(o["txIndex"])
        + u32(len(o["txProof"]))
        + b"".join(u32(len(n)) + n for n in o["txProof"])
        + u32(len(o["header"]))
        + o["header"]
        + u64(o["beaconSlot"])
        + u64(o["proposerIndex"])
        + o["parentRoot"]
        + o["stateRoot"]
        + o["bodyRoot"]
        + u32(len(o["payloadProof"]))
        + b"".join(o["payloadProof"])
        + u32(len(o["summaryProof"]))
        + b"".join(o["summaryProof"])
    )


def decode_opening(b):
    at = 0

    def take(n):
        nonlocal at
        if at + n > len(b):
            raise Bad
        at += n
        return b[at - n : at]

    def count(mx):
        n = int.from_bytes(take(4), "big")
        if n > mx:
            raise Bad
        return n

    o = {"salt": take(32), "txIndex": int.from_bytes(take(4), "big")}
    o["txProof"] = [take(count(132096)) for _ in range(count(16))]
    o["header"] = take(count(1024))
    o["beaconSlot"] = int.from_bytes(take(8), "big")
    o["proposerIndex"] = int.from_bytes(take(8), "big")
    o["parentRoot"], o["stateRoot"], o["bodyRoot"] = take(32), take(32), take(32)
    o["payloadProof"] = [take(32) for _ in range(count(9))]
    o["summaryProof"] = [take(32) for _ in range(count(13))]
    if at != len(b):
        raise Bad
    return o


def check_opening(opening, receipt, t_e, chain, state):
    """docs/spec/receipts.md, Opening, steps 1 to 6, the first failure being the result."""
    try:
        o = decode_opening(opening)
        hdr = rlp_decode(o["header"])
    except Bad:
        return "opening-decode"
    # The header must be a list whose element 4 is 32 bytes and element 11 a
    # canonical integer of at most 8 bytes.
    if not isinstance(hdr, list) or len(hdr) < 12:
        return "opening-decode"
    root, ts = hdr[4], hdr[11]
    if isinstance(root, list) or len(root) != 32 or isinstance(ts, list) or len(ts) > 8 or ts[:1] == b"\x00":
        return "opening-decode"
    # 2.
    value = trie_value(root, o["txIndex"], o["txProof"])
    data = None if value is None else calldata(value)
    if data is None or len(data) % 32:
        return "opening-transaction"
    # 3.
    if not evidence.carries(data, evidence.commitment(o["salt"], receipt)):
        return "opening-commitment"
    # 4.
    if int.from_bytes(ts, "big") > t_e:
        return "opening-late"
    # 5.
    slot = o["beaconSlot"]
    if slot >= state["slot"]:
        return "opening-payload"
    if chain not in SCHEDULES:
        return "opening-fork-unknown"
    capella = [f for f in SCHEDULES[chain] if f[0] == "capella"][0][1] * 32
    if slot < capella:
        return "opening-payload"
    g = GINDEX.get(fork_at(chain, slot)[0])
    if g is None:
        return "opening-fork-unknown"
    depth = g.bit_length() - 1
    if len(o["payloadProof"]) != depth or fold(keccak256(o["header"]), o["payloadProof"], g - (1 << depth)) != o["bodyRoot"]:
        return "opening-payload"
    known = [f for f in SCHEDULES[chain] if f[2] == state["forkVersion"]]
    if not known:
        return "opening-fork-unknown"
    assert known[0] == fork_at(chain, state["slot"]), "a state's version is its slot's fork's"
    if known[0][0] not in GINDEX:
        return "opening-fork-unknown"
    # 6.
    r = header_root(slot, o["proposerIndex"], o["parentRoot"], o["stateRoot"], o["bodyRoot"])
    if len(o["summaryProof"]) == 13:
        i = slot // 8192 - capella // 8192
        if i >= state["historicalSummaryCount"]:
            return "opening-canonical"
        if fold(r, o["summaryProof"], slot % 8192) != state["blockSummaryRoots"][i]:
            return "opening-canonical"
    elif not o["summaryProof"]:
        if state["slot"] > slot + 8192 or state["blockRoots"][slot % 8192] != r:
            return "opening-canonical"
    else:
        return "opening-canonical"
    return "ok"


def main(out_dir, configs_dir=None):
    E = sha256(b"abolish receipt opening test election")
    operator = rv.ecdsa.secret(b"receipt opening operator")
    entries = rv.make_board(E, [rv.ballot(b"opening 0")], [0])
    hs = [rv.board.entry_hash(e) for e in entries]
    links = rv.board.chain_links(entries)
    receipt = rv.sign(operator, E, 0, 0, hs[0], links[0], rv.board.BOARD.mth(hs), rv.board.BOARD.path(0, hs))
    other_receipt = rv.sign(operator, E, 0, 0, hs[0], links[0], rv.board.BOARD.mth(hs), rv.board.BOARD.path(0, hs))
    assert other_receipt == receipt  # RFC 6979: one signature per statement
    salt = label("salt")
    C = evidence.commitment(salt, receipt)
    t_e = 1_790_000_000

    # With a directory holding the two config files (their sources and sha256s
    # are in the spec), the schedules are checked against them.
    for chain, file in ((1, "mainnet.yaml"), (11155111, "sepolia.yaml")):
        if configs_dir is not None:
            cfg = config(pathlib.Path(configs_dir) / file)
            for name, epoch, version in SCHEDULES[chain]:
                prefix = "GENESIS" if name == "phase0" else name.upper()
                assert cfg[f"{prefix}_FORK_VERSION"] == "0x" + version
                if name != "phase0":
                    assert int(cfg[f"{prefix}_FORK_EPOCH"]) == epoch

    # ----------------------------------------------------------- real blocks
    blocks = []
    real = {}
    for chain, number in ((1, 26000022), (11155111, 11700028)):
        data = json.loads((HERE.with_name("l1-blocks") / f"{chain}-{number}.json").read_text())
        raw = [bytes.fromhex(t[2:]) for t in data["rawTransactions"]]
        hdr = real_header(data["header"])
        assert "0x" + h(keccak256(hdr)) == data["header"]["hash"], "header RLP"
        assert "0x" + h(trie_root(raw)) == data["header"]["transactionsRoot"], "transaction trie"
        types = {}
        for i, t in enumerate(raw):
            types.setdefault(0 if t[0] >= 0xC0 else t[0], i)
        picks = sorted({i for i in (0, 1, 127, 128) if i < len(raw)} | {len(raw) - 1, *types.values()})
        proofs = []
        for i in picks:
            p = trie_proof(raw, i)
            assert trie_value(bytes.fromhex(data["header"]["transactionsRoot"][2:]), i, p) == raw[i]
            cd = calldata(raw[i])
            assert cd is not None
            proofs.append({"index": i, "proof": [h(n) for n in p], "transaction": h(raw[i]), "calldataSha256": h(sha256(cd))})
        blocks.append(
            {
                "id": f"{'mainnet' if chain == 1 else 'sepolia'}-{number}",
                "chainId": chain,
                "number": number,
                "blockHash": data["header"]["hash"][2:],
                "header": h(hdr),
                "transactionsRoot": data["header"]["transactionsRoot"][2:],
                "transactionCount": len(raw),
                "types": sorted(types),
                "proofs": proofs,
            }
        )
        real[chain] = (hdr, raw, int(data["header"]["timestamp"], 16))

    # A block of tiny legacy transactions, whose leaves are inline in their branch.
    tiny = [rlp([rlp_int(i)] + [b""] * 8) for i in range(3)]
    assert all(len(rlp([hex_prefix([0], True), t])) < 32 for t in tiny)
    tiny_root = trie_root(tiny)
    blocks.append(
        {
            "id": "synthetic-inline-leaves",
            "chainId": 0,
            "number": 0,
            "blockHash": "",
            "header": "",
            "transactionsRoot": h(tiny_root),
            "transactionCount": len(tiny),
            "types": [0],
            "proofs": [
                {"index": i, "proof": [h(n) for n in trie_proof(tiny, i)], "transaction": h(t), "calldataSha256": h(sha256(b""))}
                for i, t in enumerate(tiny)
            ],
        }
    )
    assert [len(trie_proof(tiny, i)) for i in range(3)] == [1, 2, 2]

    # Proofs that prove nothing.
    m_hdr, m_raw, _ = real[1]
    m_root = trie_root(m_raw)
    p5 = trie_proof(m_raw, 5)
    tampered = bytearray(p5[-1])
    tampered[-1] ^= 1
    trie_rejections = [
        ("wrong-index", m_root, 6, p5),
        ("extra-node", m_root, 5, p5 + [p5[-1]]),
        ("missing-node", m_root, 5, p5[:-1]),
        ("tampered-leaf", m_root, 5, p5[:-1] + [bytes(tampered)]),
        ("wrong-root", trie_root(m_raw[:-1]), 5, p5),
        ("empty", m_root, 5, []),
        ("absent-index", m_root, len(m_raw), trie_proof(m_raw, len(m_raw) - 1)),
        ("short-hashed-node", tiny_root, 0, trie_proof(tiny, 0) + [rlp([hex_prefix([0], True), tiny[0]])]),
    ]
    for _id, root, i, p in trie_rejections:
        assert trie_value(root, i, p) is None, _id

    # Calldata of each type, and what isn't a transaction.
    calldata_cases = []
    for kind in range(5):
        t = tx(kind, C)
        assert calldata(t) == C
        calldata_cases.append({"id": f"type-{kind}", "transaction": h(t), "calldata": h(C)})
    legacy8 = rlp([b""] * 8)
    calldata_cases += [
        {"id": "type-5", "transaction": h(b"\x05" + rlp([b""] * 12)), "calldata": None},
        {"id": "empty", "transaction": "", "calldata": None},
        {"id": "legacy-8-fields", "transaction": h(legacy8), "calldata": None},
        {"id": "type-2-11-fields", "transaction": h(b"\x02" + rlp([b""] * 11)), "calldata": None},
        {"id": "type-2-data-a-list", "transaction": h(b"\x02" + rlp([b""] * 7 + [[]] + [b""] * 4)), "calldata": None},
        {"id": "type-2-trailing-byte", "transaction": h(tx(2, C) + b"\x00"), "calldata": None},
        {"id": "type-0x7f", "transaction": h(b"\x7f" + rlp([b""] * 12)), "calldata": None},
        {"id": "type-1-non-canonical", "transaction": h(b"\x01" + b"\xf8\x0b" + b"\x80" * 11), "calldata": None},
    ]
    for c in calldata_cases:
        got = calldata(bytes.fromhex(c["transaction"]))
        assert (None if got is None else h(got)) == c["calldata"], c["id"]

    # -------------------------------------------------------------- openings
    openings = []

    FULU_STATE_SLOT = 411392 * 32 + 200_000

    def build(
        chain=1,
        kind=2,
        position=1,
        tx_index=3,
        filler=6,
        timestamp=t_e - 3_600,
        slot=None,
        summary=True,
        hdr_tweak=None,
        hdr_bytes=None,
        txs_override=None,
        state_slot=None,
        cd=None,
    ):
        data = cd if cd is not None else bytes(32) * position + C + bytes(32)
        txs = txs_override or [tx(2, bytes(32), nonce=n) for n in range(filler)]
        if txs_override is None:
            txs.insert(tx_index, tx(kind, data, nonce=99))
        hdr = hdr_bytes or header(trie_root(txs), timestamp, tweak=hdr_tweak)
        slot = slot if slot is not None else FULU_STATE_SLOT - 50_000
        fork = fork_at(chain, slot)
        g = GINDEX.get(fork[0], 812)
        depth = g.bit_length() - 1
        payload = [label(f"payload sibling {i}") for i in range(depth)]
        body = fold(keccak256(hdr), payload, g - (1 << depth))
        o = {
            "salt": salt,
            "txIndex": tx_index,
            "txProof": trie_proof(txs, tx_index),
            "header": hdr,
            "beaconSlot": slot,
            "proposerIndex": 1234,
            "parentRoot": label("beacon parent root"),
            "stateRoot": label("beacon state root"),
            "bodyRoot": body,
            "payloadProof": payload,
            "summaryProof": [label(f"summary sibling {i}") for i in range(13)] if summary else [],
        }
        r = header_root(slot, o["proposerIndex"], o["parentRoot"], o["stateRoot"], body)
        s_slot = state_slot if state_slot is not None else (FULU_STATE_SLOT if summary else slot + 100)
        capella = [f for f in SCHEDULES[chain] if f[0] == "capella"][0][1] * 32
        state = {
            "slot": s_slot,
            "forkVersion": fork_at(chain, s_slot)[2],
            "historicalSummaryCount": s_slot // 8192 - capella // 8192,
            "blockSummaryRoots": {},
            "blockRoots": {},
        }
        if summary:
            i = slot // 8192 - capella // 8192
            state["blockSummaryRoots"][i] = fold(r, o["summaryProof"], slot % 8192)
        else:
            state["blockRoots"][slot % 8192] = r
        return o, state

    def add(id_, o, state, expected, chain=1, rcpt=receipt, raw=None):
        enc = raw if raw is not None else encode_opening(o)
        got = check_opening(enc, rcpt, t_e, chain, state)
        assert got == expected, (id_, got, expected)
        openings.append(
            {
                "id": id_,
                "opening": h(enc),
                "receipt": h(rcpt),
                "disputeEnd": str(t_e),
                "l1ChainId": str(chain),
                "state": {
                    "slot": str(state["slot"]),
                    "forkVersion": state["forkVersion"],
                    "historicalSummaryCount": state["historicalSummaryCount"],
                    "blockSummaryRoots": {str(k): h(v) for k, v in state["blockSummaryRoots"].items()},
                    "blockRoots": {str(k): h(v) for k, v in state["blockRoots"].items()},
                },
                "expected": expected,
            }
        )

    # Passing openings.
    o, s = build()
    add("ok-summary", o, s, "ok")
    good, good_state = o, s
    o, s = build(summary=False)
    add("ok-block-roots", o, s, "ok")
    o, s = build(summary=False, state_slot=FULU_STATE_SLOT - 50_000 + 8192)
    add("ok-block-roots-oldest", o, s, "ok")
    for kind in range(5):
        o, s = build(kind=kind)
        add(f"ok-type-{kind}", o, s, "ok")
    for i, n in ((0, 1), (127, 130), (128, 130), (129, 200)):
        o, s = build(tx_index=i, filler=n)
        add(f"ok-tx-index-{i}", o, s, "ok")
    o, s = build(position=0)
    add("ok-word-first", o, s, "ok")
    o, s = build(cd=bytes(32) * 3 + C)
    add("ok-word-last", o, s, "ok")
    o, s = build(cd=C)
    add("ok-word-only", o, s, "ok")
    o, s = build(timestamp=t_e)
    add("ok-timestamp-at-dispute-end", o, s, "ok")
    for fork in ("capella", "deneb", "electra"):
        f = [x for x in SCHEDULES[1] if x[0] == fork][0]
        o, s = build(slot=f[1] * 32 + 100)
        add(f"ok-{fork}", o, s, "ok")
    o, s = build(slot=194048 * 32)
    add("ok-first-capella-slot", o, s, "ok")
    o, s = build(slot=FULU_STATE_SLOT - 1, summary=False)
    add("ok-slot-before-state", o, s, "ok")
    o, s = build(chain=11155111, slot=272640 * 32 + 5000, state_slot=272640 * 32 + 90_000)
    add("ok-sepolia-fulu", o, s, "ok", chain=11155111)

    # 1. opening-decode
    enc = encode_opening(good)
    add("decode-truncated", good, good_state, "opening-decode", raw=enc[:-1])
    add("decode-trailing-byte", good, good_state, "opening-decode", raw=enc + b"\x00")
    add("decode-empty", good, good_state, "opening-decode", raw=b"")
    over = dict(good, payloadProof=good["payloadProof"] + [bytes(32)])
    add("decode-payload-proof-10", over, good_state, "opening-decode")
    over = dict(good, txProof=(good["txProof"] * 17)[:17])
    add("decode-tx-proof-17", over, good_state, "opening-decode")
    over = dict(good, summaryProof=good["summaryProof"] + [bytes(32)])
    add("decode-summary-proof-14", over, good_state, "opening-decode")
    over = dict(good, header=good["header"] + bytes(1024))
    add("decode-header-over-1024", over, good_state, "opening-decode")
    for id_, tweak in (
        ("decode-header-11-items", lambda it: it[:11]),
        ("decode-header-root-31-bytes", lambda it: it[:4] + [it[4][:31]] + it[5:]),
        ("decode-header-root-a-list", lambda it: it[:4] + [[it[4]]] + it[5:]),
        ("decode-header-timestamp-9-bytes", lambda it: it[:11] + [b"\x01" + bytes(8)] + it[12:]),
        ("decode-header-timestamp-leading-zero", lambda it: it[:11] + [b"\x00" + it[11]] + it[12:]),
        ("decode-header-timestamp-a-list", lambda it: it[:11] + [[it[11]]] + it[12:]),
    ):
        o, s = build(hdr_tweak=tweak)
        add(id_, o, s, "opening-decode")
    o, s = build()
    add("decode-header-not-a-list", dict(o, header=rlp(label("x"))), s, "opening-decode")
    hdr = good["header"]
    add("decode-header-trailing-byte", dict(good, header=hdr + b"\x00"), good_state, "opening-decode")
    # A long-form list length below 56.
    payload_len = len(hdr) - 3
    assert hdr[0] == 0xF9
    noncanon = b"\xfa" + payload_len.to_bytes(3, "big") + hdr[3:]
    add("decode-header-length-leading-zero", dict(good, header=noncanon), good_state, "opening-decode")

    # 2. opening-transaction
    add("transaction-wrong-index", dict(good, txIndex=good["txIndex"] + 1), good_state, "opening-transaction")
    add("transaction-extra-node", dict(good, txProof=good["txProof"] + [good["txProof"][-1]]), good_state, "opening-transaction")
    add("transaction-missing-node", dict(good, txProof=good["txProof"][:-1]), good_state, "opening-transaction")
    leaf = bytearray(good["txProof"][-1])
    leaf[-1] ^= 1
    add("transaction-tampered-leaf", dict(good, txProof=good["txProof"][:-1] + [bytes(leaf)]), good_state, "opening-transaction")
    o, s = build(cd=bytes(48))
    add("transaction-calldata-48-bytes", o, s, "opening-transaction")
    o, s = build(cd=C + bytes(1))
    add("transaction-calldata-33-bytes", o, s, "opening-transaction")
    bad = b"\x05" + rlp([b""] * 7 + [C] + [b""] * 4)
    o, s = build(txs_override=[tx(2, bytes(32), nonce=1), bad], tx_index=1)
    add("transaction-type-5", o, s, "opening-transaction")
    bad = rlp([b""] * 5 + [C] + [b""] * 2)
    o, s = build(txs_override=[tx(2, bytes(32), nonce=1), bad], tx_index=1)
    add("transaction-legacy-8-fields", o, s, "opening-transaction")

    # 3. opening-commitment
    add("commitment-other-salt", dict(good, salt=label("other salt")), good_state, "opening-commitment")
    add("commitment-other-receipt", good, good_state, "opening-commitment", rcpt=receipt[:-1] + bytes([receipt[-1] ^ 1]))
    o, s = build(cd=bytes(16) + C + bytes(16))
    add("commitment-unaligned", o, s, "opening-commitment")
    o, s = build(cd=b"")
    add("commitment-empty-calldata", o, s, "opening-commitment")

    # 4. opening-late
    o, s = build(timestamp=t_e + 1)
    add("late-one-second", o, s, "opening-late")
    o, s = build(timestamp=t_e + 1, cd=bytes(64))
    add("late-but-commitment-first", o, s, "opening-commitment")

    # 5. opening-payload
    add("payload-sibling-flipped", dict(good, payloadProof=[label("flip")] + good["payloadProof"][1:]), good_state, "opening-payload")
    add("payload-depth-8-in-fulu", dict(good, payloadProof=good["payloadProof"][:8]), good_state, "opening-payload")
    add("payload-body-root", dict(good, bodyRoot=label("other body")), good_state, "opening-payload")
    o, s = build(slot=194048 * 32 + 100)
    add("payload-depth-9-in-capella", dict(o, payloadProof=o["payloadProof"] + [bytes(32)]), s, "opening-payload")
    o, s = build(slot=194048 * 32 - 1)
    add("payload-before-capella", o, s, "opening-payload")
    o, s = build(summary=False)
    add("payload-slot-at-state", o, dict(s, slot=o["beaconSlot"]), "opening-payload")
    add("payload-slot-after-state", o, dict(s, slot=o["beaconSlot"] - 1), "opening-payload")
    # Another block's header fails the trie proof first.
    other = header(trie_root([tx(2, bytes(32), nonce=n) for n in range(3)]), t_e - 3_600)
    add("order-transaction-before-payload", dict(good, header=other), good_state, "opening-transaction")

    # opening-fork-unknown: the judge's, never the opening's.
    add("fork-unknown-chain", good, good_state, "opening-fork-unknown", chain=31337)
    add("fork-unknown-state-version", good, dict(good_state, forkVersion="07000000"), "opening-fork-unknown")
    add("fork-unknown-other-chain-version", good, dict(good_state, forkVersion="90000075"), "opening-fork-unknown")
    o, s = build(chain=11155111, slot=272640 * 32 + 5000, state_slot=353024 * 32 + 10)
    add("fork-unknown-sepolia-gloas-state", o, s, "opening-fork-unknown", chain=11155111)
    o, s = build(chain=11155111, slot=353024 * 32 + 5, state_slot=353024 * 32 + 10, summary=False)
    add("fork-unknown-sepolia-gloas-block", o, s, "opening-fork-unknown", chain=11155111)
    add("payload-before-fork-unknown-state", dict(good, bodyRoot=label("other body")), dict(good_state, forkVersion="07000000"), "opening-payload")
    add("payload-slot-before-unknown-chain", dict(good, beaconSlot=good_state["slot"]), good_state, "opening-payload", chain=31337)

    # 6. opening-canonical
    add("canonical-proposer", dict(good, proposerIndex=1235), good_state, "opening-canonical")
    add("canonical-state-root", dict(good, stateRoot=label("other state")), good_state, "opening-canonical")
    add("canonical-summary-sibling", dict(good, summaryProof=good["summaryProof"][:12] + [label("flip")]), good_state, "opening-canonical")
    add("canonical-summary-proof-12", dict(good, summaryProof=good["summaryProof"][:12]), good_state, "opening-canonical")
    add("canonical-summary-proof-1", dict(good, summaryProof=good["summaryProof"][:1]), good_state, "opening-canonical")
    i = good["beaconSlot"] // 8192 - 194048 * 32 // 8192
    add("canonical-period-incomplete", good, dict(good_state, historicalSummaryCount=i), "opening-canonical")
    add("canonical-other-period", good, dict(good_state, blockSummaryRoots={i: label("other summary")}), "opening-canonical")
    o, s = build(summary=False)
    add("canonical-block-roots-other", o, dict(s, blockRoots={o["beaconSlot"] % 8192: label("other")}), "opening-canonical")
    add("canonical-block-roots-too-old", o, dict(s, slot=o["beaconSlot"] + 8193), "opening-canonical")
    # A slot whose leaf in the period isn't its own.
    add("canonical-slot-moved", dict(good, beaconSlot=good["beaconSlot"] + 1), good_state, "opening-canonical")

    # Real blocks: every check up to the commitment runs on mainnet and Sepolia data.
    for chain, (hdr, raw, ts) in real.items():
        i = next(j for j, t in enumerate(raw) if (calldata(t) is not None and len(calldata(t)) % 32 == 0))
        o = dict(good, header=hdr, txIndex=i, txProof=trie_proof(raw, i))
        add(f"real-{'mainnet' if chain == 1 else 'sepolia'}-commitment", o, good_state, "opening-commitment", chain=chain)
        j = next(j for j, t in enumerate(raw) if (calldata(t) is not None and len(calldata(t)) % 32 != 0))
        o = dict(good, header=hdr, txIndex=j, txProof=trie_proof(raw, j))
        add(f"real-{'mainnet' if chain == 1 else 'sepolia'}-calldata-unaligned", o, good_state, "opening-transaction", chain=chain)

    codes = {c["expected"] for c in openings}
    assert codes == {"ok", "opening-decode", "opening-transaction", "opening-commitment", "opening-late", "opening-payload", "opening-canonical", "opening-fork-unknown"}

    out = {
        "format": "abolish-receipt-opening-vectors/1",
        "title": "Receipt commitments' openings: the transaction trie, the execution header, the beacon block and its period",
        "spec": "docs/spec/receipts.md",
        "generator": (
            "packages/crypto/scripts/receipt-opening-vectors.py: an independent Python implementation (standard library "
            "only), with group-registry-vectors.py's keccak-256 and receipt-vectors.py's receipt; the real blocks are "
            "rebuilt from scripts/l1-blocks/ and checked against their block hashes and transaction roots"
        ),
        "forkSchedules": [
            {"chainId": str(c), "forks": [{"name": n, "epoch": str(e), "version": v} for n, e, v in fs]} for c, fs in SCHEDULES.items()
        ],
        "blocks": blocks,
        "trieRejections": [{"id": i, "root": h(r), "index": x, "proof": [h(n) for n in p]} for i, r, x, p in trie_rejections],
        "calldata": calldata_cases,
        "openings": openings,
    }
    path = pathlib.Path(out_dir) / "receipt-opening.json"
    path.write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main(*sys.argv[1:3])
