#!/usr/bin/env python3
"""Fetches one L1 block's header fields and raw transactions for receipt-opening-vectors.py.

Usage: python3 -I -B packages/crypto/scripts/l1-blocks-fetch.py <rpc-url> <chain-id> <block-number>

Writes scripts/l1-blocks/<chain-id>-<block-number>.json: the header fields as
`eth_getBlockByNumber` returns them, and every transaction's EIP-2718 encoding
from `eth_getRawTransactionByBlockNumberAndIndex`. Nothing in it is trusted: the
generator rebuilds the header's RLP and the transaction trie from it, and fails
unless they hash to the block's hash and its `transactionsRoot`, which anyone
can compare with any node or explorer for that chain.
"""

import json
import pathlib
import sys
import urllib.request

HEADER_FIELDS = [
    "hash",
    "parentHash",
    "sha3Uncles",
    "miner",
    "stateRoot",
    "transactionsRoot",
    "receiptsRoot",
    "logsBloom",
    "difficulty",
    "number",
    "gasLimit",
    "gasUsed",
    "timestamp",
    "extraData",
    "mixHash",
    "nonce",
    "baseFeePerGas",
    "withdrawalsRoot",
    "blobGasUsed",
    "excessBlobGas",
    "parentBeaconBlockRoot",
    "requestsHash",
]


def rpc(url, calls):
    body = [{"jsonrpc": "2.0", "id": i, "method": m, "params": p} for i, (m, p) in enumerate(calls)]
    req = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", "user-agent": "curl/8"})
    out = sorted(json.load(urllib.request.urlopen(req, timeout=120)), key=lambda r: r["id"])
    for r in out:
        if "result" not in r or r["result"] is None:
            raise SystemExit(f"RPC error: {r}")
    return [r["result"] for r in out]


def main(url, chain_id, number):
    (chain,) = rpc(url, [("eth_chainId", [])])
    if int(chain, 16) != chain_id:
        raise SystemExit(f"{url} serves chain {int(chain, 16)}, not {chain_id}")
    (block,) = rpc(url, [("eth_getBlockByNumber", [hex(number), False])])
    n = len(block["transactions"])
    raw = rpc(url, [("eth_getRawTransactionByBlockNumberAndIndex", [hex(number), hex(i)]) for i in range(n)])
    out = {
        "chainId": chain_id,
        "number": number,
        "header": {k: block[k] for k in HEADER_FIELDS if k in block},
        "extraFields": sorted(k for k in block if k not in HEADER_FIELDS and k not in ("size", "totalDifficulty", "transactions", "uncles", "withdrawals")),
        "rawTransactions": raw,
    }
    path = pathlib.Path(__file__).with_name("l1-blocks") / f"{chain_id}-{number}.json"
    path.write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
