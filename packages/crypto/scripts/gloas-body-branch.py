#!/usr/bin/env python3
"""A Gloas body root and payload branch merkleized by the consensus specs' own SSZ library.

The consensus specs (v1.7.0-beta.4, pyproject.toml) pin eth-ssz-specs 0.1.0
for SSZ, EIP-7495's ProgressiveContainer and EIP-7916's progressive trees
included. This script builds, with that library alone, a container of
Gloas's BeaconBlockBody shape (13 fields, signed_execution_payload_bid at
10, a Container of message and signature, the message an ExecutionPayloadBid
of 12 fields with parent_block_hash first; the other fields are Bytes32
placeholders, whose types don't move any position), sets parent_block_hash
to the given leaf, and writes the library's generalized index, branch and
root. receipt-opening-vectors.py builds an opening on them, so one passing
Gloas vector's body root comes from outside this repository.

Usage, with Python 3.12 or later and eth-ssz-specs 0.1.0 installed from its
wheel (sha256 466c6cef854cca45022a7cdc3922dd636e30b1a1dd5385845819e3d45ddddf41,
as consensus-specs' uv.lock lists it):

    python3 -I -B packages/crypto/scripts/gloas-body-branch.py <leaf-hex> > packages/crypto/scripts/gloas-body-branch.json
"""

import hashlib
import json
import sys

from ssz import (
    ByteVector,
    Container,
    ProgressiveContainer,
    active_fields,
    build_proof,
    calculate_merkle_root,
    get_generalized_index,
    hash_tree_root,
)


class Bytes32(ByteVector):
    LENGTH = 32


def label(s):
    return Bytes32(hashlib.sha256(s.encode()).digest())


class ExecutionPayloadBid(ProgressiveContainer):
    ACTIVE_FIELDS = active_fields(width=12)
    parent_block_hash: Bytes32
    parent_block_root: Bytes32
    block_hash: Bytes32
    prev_randao: Bytes32
    fee_recipient: Bytes32
    gas_limit: Bytes32
    builder_index: Bytes32
    slot: Bytes32
    value: Bytes32
    execution_payment: Bytes32
    blob_kzg_commitments: Bytes32
    execution_requests_root: Bytes32


class SignedExecutionPayloadBid(Container):
    message: ExecutionPayloadBid
    signature: Bytes32


class BeaconBlockBody(ProgressiveContainer):
    ACTIVE_FIELDS = active_fields(width=13)
    randao_reveal: Bytes32
    eth1_data: Bytes32
    graffiti: Bytes32
    proposer_slashings: Bytes32
    attester_slashings: Bytes32
    attestations: Bytes32
    deposits: Bytes32
    voluntary_exits: Bytes32
    sync_aggregate: Bytes32
    bls_to_execution_changes: Bytes32
    signed_execution_payload_bid: SignedExecutionPayloadBid
    payload_attestations: Bytes32
    parent_execution_requests: Bytes32


def main(leaf_hex):
    leaf = Bytes32(bytes.fromhex(leaf_hex))
    fields = {n: label(n) for n in ExecutionPayloadBid.model_fields if n != "parent_block_hash"}
    bid = ExecutionPayloadBid(parent_block_hash=leaf, **fields)
    signed = SignedExecutionPayloadBid(message=bid, signature=label("signature"))
    others = {n: label(n) for n in BeaconBlockBody.model_fields if n != "signed_execution_payload_bid"}
    body = BeaconBlockBody(signed_execution_payload_bid=signed, **others)
    gindex = get_generalized_index(BeaconBlockBody, "signed_execution_payload_bid", "message", "parent_block_hash")
    branch = build_proof(body, gindex)
    root = hash_tree_root(body)
    assert calculate_merkle_root(leaf, branch, gindex) == root
    print(
        json.dumps(
            {
                "library": "eth-ssz-specs 0.1.0",
                "gindex": gindex,
                "blockHashGindex": get_generalized_index(BeaconBlockBody, "signed_execution_payload_bid", "message", "block_hash"),
                "leaf": leaf_hex,
                "branch": [bytes(b).hex() for b in branch],
                "bodyRoot": bytes(root).hex(),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main(sys.argv[1])
