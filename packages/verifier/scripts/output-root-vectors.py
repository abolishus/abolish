#!/usr/bin/env python3
"""Generator for docs/spec/vectors/output-root.json.

Reads one dispute game of Base Sepolia from Ethereum Sepolia (the factory's
game at an index, its type, root claim and L2 block, at a fixed L1 block)
and, from a Base Sepolia node, the L2 block it claims, the
L2ToL1MessagePasser's storage root and `eth_getProof` trie nodes for two
contracts' slots and for an address with no account. The root claim is the
proposer's, posted on L1; the block, the proofs and the storage words are
the node's (`eth_getStorageAt`), and the header is RLP-encoded here from the
node's fields and checked against the node's block hash (`cast keccak`).
None of it comes from packages/verifier. The negative vectors change one
input of the honest one each.

Needs cast on PATH (.github/scripts/install-toolchain.sh) and network access
to both public endpoints below.

Usage: python3 -I packages/verifier/scripts/output-root-vectors.py <out-dir>
"""

import json
import pathlib
import subprocess
import sys
import urllib.request

L1_RPC = "https://ethereum-sepolia-rpc.publicnode.com"
L2_RPC = "https://sepolia.base.org"
L1_CHAIN = 11155111
L2_CHAIN = 84532
# Base Sepolia's OptimismPortal on Sepolia, whose disputeGameFactory() names
# the factory; and the game read, at an L1 block after its creation.
PORTAL = "0x49f53e41452C74589E85cA1677426Ba426459e85"
GAME_INDEX = 28322
L1_BLOCK = 11933835
MESSAGE_PASSER = "0x4200000000000000000000000000000000000016"
L1_BLOCK_PREDEPLOY = "0x4200000000000000000000000000000000000015"
# An address with no account on Base Sepolia.
NOBODY = "0x00000000000000000000000000000000000b0a0d"


def cast(*args):
    return subprocess.run(["cast", *args], check=True, capture_output=True, text=True).stdout.strip()


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, body, {"content-type": "application/json", "user-agent": "abolish-vectors"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.load(r)
    if "error" in out:
        raise RuntimeError(f"{method}: {out['error']}")
    return out["result"]


def l1_call(to, sig, *args):
    return cast("call", to, sig, *map(str, args), "--block", str(L1_BLOCK), "--rpc-url", L1_RPC)


def strip0x(h):
    return h[2:] if h.startswith("0x") else h


def rlp_bytes(b):
    if len(b) == 1 and b[0] < 0x80:
        return b
    return length_prefix(len(b), 0x80) + b


def length_prefix(n, short):
    if n < 56:
        return bytes([short + n])
    ln = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([short + 55 + len(ln)]) + ln


def rlp_list(items):
    body = b"".join(items)
    return length_prefix(len(body), 0xC0) + body


def quantity(h):
    n = int(h, 16)
    return n.to_bytes((n.bit_length() + 7) // 8, "big")


def data(h):
    return bytes.fromhex(strip0x(h))


# The header's fields in order, through Prague: each is a quantity or bytes.
HEADER_FIELDS = [
    ("parentHash", data),
    ("sha3Uncles", data),
    ("miner", data),
    ("stateRoot", data),
    ("transactionsRoot", data),
    ("receiptsRoot", data),
    ("logsBloom", data),
    ("difficulty", quantity),
    ("number", quantity),
    ("gasLimit", quantity),
    ("gasUsed", quantity),
    ("timestamp", quantity),
    ("extraData", data),
    ("mixHash", data),
    ("nonce", data),
    ("baseFeePerGas", quantity),
    ("withdrawalsRoot", data),
    ("blobGasUsed", quantity),
    ("excessBlobGas", quantity),
    ("parentBeaconBlockRoot", data),
    ("requestsHash", data),
]


def encode_header(block):
    items = []
    for name, kind in HEADER_FIELDS:
        if name not in block:
            break
        items.append(rlp_bytes(kind(block[name])))
    return rlp_list(items)


def proof(address, slots, number):
    p = rpc(L2_RPC, "eth_getProof", [address, [hex(s) for s in slots], hex(number)])
    nodes = [strip0x(n) for n in p["accountProof"]]
    for sp in p["storageProof"]:
        nodes.extend(strip0x(n) for n in sp["proof"])
    # Each node once, in first-seen order.
    return list(dict.fromkeys(nodes)), p


def main():
    out = pathlib.Path(sys.argv[1])
    factory = l1_call(PORTAL, "disputeGameFactory()(address)")
    game_type, created_at, game = l1_call(
        factory, "gameAtIndex(uint256)(uint32,uint64,address)", GAME_INDEX
    ).split("\n")
    game_type = int(game_type.split()[0])
    created_at = int(created_at.split()[0])
    root_claim = l1_call(game, "rootClaim()(bytes32)")
    l2_number = int(l1_call(game, "l2SequenceNumber()(uint256)").split()[0])
    assert int(l1_call(game, "gameType()(uint32)").split()[0]) == game_type

    block = rpc(L2_RPC, "eth_getBlockByNumber", [hex(l2_number), False])
    header = encode_header(block)
    assert cast("keccak", "0x" + header.hex()) == block["hash"], "header encoding"
    mp_root = rpc(L2_RPC, "eth_getProof", [MESSAGE_PASSER, [], hex(l2_number)])["storageHash"]

    def words(address, slots):
        return [
            strip0x(rpc(L2_RPC, "eth_getStorageAt", [address, hex(s), hex(l2_number)]))
            for s in slots
        ]

    honest = []
    for vid, address, slots in [
        ("message-passer", MESSAGE_PASSER, [0, 1]),
        ("l1-block", L1_BLOCK_PREDEPLOY, [0, 1, 2, 3]),
    ]:
        nodes, _ = proof(address, slots, l2_number)
        honest.append(
            {
                "id": vid,
                "description": f"Slots {slots} of {address} at the game's L2 block",
                "outputRoot": strip0x(root_claim),
                "messagePasserStorageRoot": strip0x(mp_root),
                "header": header.hex(),
                "address": strip0x(address),
                "slots": [f"{s:064x}" for s in slots],
                "nodes": nodes,
                "result": {
                    "number": str(l2_number),
                    "timestamp": str(int(block["timestamp"], 16)),
                    "hash": strip0x(block["hash"]),
                    "words": words(address, slots),
                },
            }
        )

    base = honest[0]
    nobody_nodes, _ = proof(NOBODY, [0], l2_number)
    bad_mp = bytearray.fromhex(base["messagePasserStorageRoot"])
    bad_mp[31] ^= 1
    # The timestamp's last byte, an RLP quantity: another header, another hash.
    header_b = bytearray(header)
    ts = quantity(block["timestamp"])
    at = bytes(header_b).find(rlp_bytes(ts))
    header_b[at + len(rlp_bytes(ts)) - 1] ^= 1
    refused = [
        {
            **base,
            "id": "message-passer-root-altered",
            "description": "The preimage's message-passer storage root with its last bit flipped",
            "messagePasserStorageRoot": bytes(bad_mp).hex(),
            "result": {"error": "output-root"},
        },
        {
            **base,
            "id": "header-altered",
            "description": "The header with its timestamp's last bit flipped",
            "header": bytes(header_b).hex(),
            "result": {"error": "output-root"},
        },
        {
            **base,
            "id": "other-block-root",
            "description": "The honest evidence against the root claim of the factory's previous game",
            "outputRoot": strip0x(
                l1_call(
                    l1_call(factory, "gameAtIndex(uint256)(uint32,uint64,address)", GAME_INDEX - 1).split(
                        "\n"
                    )[2],
                    "rootClaim()(bytes32)",
                )
            ),
            "result": {"error": "output-root"},
        },
        {
            **base,
            "id": "header-not-rlp",
            "description": "The header with a trailing byte",
            "header": header.hex() + "00",
            "result": {"error": "l2-header"},
        },
        {
            **base,
            "id": "node-missing",
            "description": "The account proof without its last node",
            "nodes": [n for n in base["nodes"] if n != proof(MESSAGE_PASSER, [], l2_number)[0][-1]],
            "result": {"error": "l2-proof-missing"},
        },
        {
            **base,
            "id": "no-account",
            "description": "An address with no account, proven absent",
            "address": strip0x(NOBODY),
            "slots": [f"{0:064x}"],
            "nodes": nobody_nodes,
            "result": {"error": "l2-contract-absent"},
        },
    ]

    doc = {
        "format": "abolish-output-root-vectors/1",
        "title": "Storage read under an L2 output root posted on L1 (version 0)",
        "spec": "docs/spec/contracts.md",
        "generator": (
            "packages/verifier/scripts/output-root-vectors.py: reads one Base Sepolia dispute game "
            "from Ethereum Sepolia at a fixed L1 block (its root claim and L2 block), and from a "
            "Base Sepolia node the block it claims (RLP-encoded by the generator and checked "
            "against the node's hash), the L2ToL1MessagePasser's storage root, eth_getProof trie "
            "nodes and eth_getStorageAt words."
        ),
        "l1ChainId": str(L1_CHAIN),
        "l2ChainId": str(L2_CHAIN),
        "game": {
            "l1Block": str(L1_BLOCK),
            "factory": strip0x(factory).lower(),
            "index": str(GAME_INDEX),
            "address": strip0x(game).lower(),
            "gameType": str(game_type),
            "createdAt": str(created_at),
            "rootClaim": strip0x(root_claim),
            "l2SequenceNumber": str(l2_number),
        },
        "vectors": honest + refused,
    }
    (out / "output-root.json").write_text(json.dumps(doc, indent=2) + "\n")


main()
