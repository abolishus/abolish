#!/usr/bin/env python3
"""Generator for docs/spec/vectors/l1-anchor.json.

Deploys BoardAnchor (packages/contracts, built by forge) on a local Anvil
chain with the clock of docs/spec/vectors/board.json, anchors that file's
`valid` board, and records what a verifier reads back from L1 state: block
headers exactly as Anvil serves them (`debug_getRawHeader`), and the trie
nodes of `eth_getProof` for the slots docs/spec/contracts.md (Board anchor,
Verification) names. The headers' hashes and every trie node come from
Anvil's own Ethereum implementation, which shares no code with
packages/verifier, so the vectors check its RLP, header and trie code
instead of restating it. The expected anchors are the checkpoints this
script sent, by construction.

Needs anvil, cast and forge on PATH (.github/scripts/install-toolchain.sh).

Usage: python3 -I packages/verifier/scripts/l1-anchor-vectors.py <out-dir>
"""

import hashlib
import json
import pathlib
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[3]
PORT = 8597
RPC = f"http://127.0.0.1:{PORT}"
# A whole hour well before the vectors' epoch, so every deployment lands
# before period 0 starts.
GENESIS = 1_799_990_000
# Anvil's first default account: unlocked, funded, used only to deploy.
DEPLOYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
# The anchoring authority: an address given code, so the anchor accepts it
# (docs/spec/contracts.md, Deployment), and impersonated to send.
AUTHORITY = "0x00000000000000000000000000000000000a0701"
# An address with no account: the pinned anchor absent from state.
NOBODY = "0x00000000000000000000000000000000000b0a0d"
# keccak256(abi.encode(uint256(keccak256("abolish.board-anchor")) - 1)) & ~0xff
NAMESPACE = 0x16EBA4501D0A9DDDBFA03518D843C364BE664629E6D99EFB7169D8F090095B00


def cast(*args):
    return subprocess.run(["cast", *args], check=True, capture_output=True, text=True).stdout.strip()


def rpc(method, *params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": list(params)})
    req = urllib.request.Request(RPC, body.encode(), {"content-type": "application/json"})
    with urllib.request.urlopen(req) as r:
        out = json.load(r)
    if "error" in out:
        raise RuntimeError(f"{method}: {out['error']}")
    return out["result"]


def h(n):
    return hex(n)


def strip(x):
    return x[2:] if x.startswith("0x") else x


def mine_at(ts):
    rpc("evm_setNextBlockTimestamp", h(ts))
    rpc("evm_mine")
    return rpc("eth_getBlockByNumber", "latest", False)


def send(frm, to, data, ts):
    rpc("evm_setNextBlockTimestamp", h(ts))
    tx = {"from": frm, "data": data, "gas": h(3_000_000)}
    if to is not None:
        tx["to"] = to
    txh = rpc("eth_sendTransaction", tx)
    receipt = None
    for _ in range(100):
        receipt = rpc("eth_getTransactionReceipt", txh)
        if receipt is not None:
            break
        time.sleep(0.05)
    if receipt is None:
        raise RuntimeError(f"transaction at {ts} not mined")
    if receipt["status"] != "0x1":
        raise RuntimeError(f"transaction at {ts} reverted")
    return receipt


def checkpoint_bytes(cp):
    return (
        cp["electionId"]
        + int(cp["segment"]).to_bytes(4, "big").hex()
        + int(cp["size"]).to_bytes(8, "big").hex()
        + cp["head"]
        + cp["root"]
        + cp["objectCid"]
        + cp["hashesCid"]
    )


def checkpoint_hash(encoded):
    tag = b"abolish/v1/board-checkpoint-2"
    return hashlib.sha256(bytes([len(tag)]) + tag + bytes.fromhex(encoded)).hexdigest()


def slot_of(election_id, segment):
    inner = cast("index", "bytes32", "0x" + election_id, h(NAMESPACE))
    return cast("index", "uint32", str(segment), inner)


def lowest_slot(election_id):
    return cast("index", "bytes32", "0x" + election_id, h(NAMESPACE + 1))


def deploy(code, clock):
    args = cast(
        "abi-encode",
        "f((uint64,uint64,uint64),address)",
        f"({clock['epoch']},{clock['period']},{clock['deadline']})",
        AUTHORITY,
    )
    receipt = send(DEPLOYER, None, code + strip(args), GENESIS + 100 + len(deployed))
    deployed.append(receipt["contractAddress"])
    return receipt["contractAddress"]


def anchor(address, checkpoints, ts):
    data = cast("calldata", "anchor(bytes,bytes)", "0x" + "".join(checkpoints), "0x")
    send(AUTHORITY, address, data, ts)


deployed = []


def proof(block, address, election_id, first, clock):
    """The nodes for every slot a verifier proves, per docs/spec/contracts.md."""
    tag = block["number"]
    now = int(block["timestamp"], 16)
    epoch, period = int(clock["epoch"]), int(clock["period"])
    last = int(clock["lastSegment"])
    low = int(rpc("eth_getStorageAt", address, lowest_slot(election_id), tag), 16)
    slots = [lowest_slot(election_id)]
    if low > 0:
        s = max(low - 1, first)
        while s <= last and epoch + (s + 1) * period <= now:
            slots.append(slot_of(election_id, s))
            s += 1
    p = rpc("eth_getProof", address, slots, tag)
    nodes = list(p["accountProof"])
    by_slot = {}
    for sp in p["storageProof"]:
        by_slot[sp["key"]] = sp["proof"]
        nodes += sp["proof"]
    seen, out = set(), []
    for n in nodes:
        if n not in seen:
            seen.add(n)
            out.append(strip(n))
    return out, by_slot, slots


def main():
    out_dir = pathlib.Path(sys.argv[1])
    board_file = json.loads((ROOT / "docs/spec/vectors/board.json").read_text())
    clock = board_file["clock"]
    valid = next(b for b in board_file["boards"] if b["id"] == "valid")
    eid = valid["electionId"]
    cps = valid["checkpoints"]
    subprocess.run(["forge", "build", "--quiet"], cwd=ROOT / "packages/contracts", check=True)
    artifact = json.loads(
        (ROOT / "packages/contracts/out/BoardAnchor.sol/BoardAnchor.json").read_text()
    )
    code = artifact["bytecode"]["object"]

    anvil = subprocess.Popen(
        ["anvil", "--port", str(PORT), "--timestamp", str(GENESIS), "--silent"],
        stdout=subprocess.DEVNULL,
    )
    try:
        for _ in range(50):
            try:
                rpc("eth_chainId")
                break
            except OSError:
                time.sleep(0.1)
        rpc("anvil_setCode", AUTHORITY, "0x00")
        rpc("anvil_setBalance", AUTHORITY, h(10**20))
        rpc("anvil_impersonateAccount", AUTHORITY)
        honest = deploy(code, clock)
        forked = deploy(code, clock)
        misnamed = deploy(code, clock)

        # The forked anchor holds a checkpoint for segment 4 that no board
        # matches: the honest one with another head. The misnamed one holds
        # segment 4's honest head and root with segment 1's object CID.
        bogus = dict(cps[2], head="ee" * 32)
        wrong_cid = dict(cps[2], objectCid=cps[1]["objectCid"])
        before = mine_at(1_800_000_100)
        for i, cp in enumerate(cps):
            t = int(cp["anchoredAt"])
            anchor(honest, [checkpoint_bytes(cp)], t)
            anchor(forked, [checkpoint_bytes(bogus if i == 2 else cp)], t + 1)
            anchor(misnamed, [checkpoint_bytes(wrong_cid if i == 2 else cp)], t + 2)
            if i == 1:
                running = mine_at(1_800_010_000)
        closed = mine_at(int(valid["now"]))

        def header(block):
            raw = strip(rpc("debug_getRawHeader", block["number"]))
            return {
                "hash": strip(block["hash"]),
                "number": str(int(block["number"], 16)),
                "timestamp": str(int(block["timestamp"], 16)),
                "header": raw,
            }

        def case(id_, description, block, address, first, result, **extra):
            nodes, by_slot, slots = proof(block, address, eid, first, clock)
            v = {
                "id": id_,
                "description": description,
                "block": header(block),
                "anchor": strip(address),
                "firstSegment": str(first),
                "nodes": nodes,
                "checkpoints": [],
                "copy": "valid",
                "result": result,
            }
            v.update(extra)
            return v, by_slot, slots

        def cp_hash(cp):
            return cp["hash"]

        def anchors(*idx, source="copy"):
            return {
                "anchors": [
                    {"segment": cps[i]["segment"], "hash": cp_hash(cps[i]), "source": source}
                    for i in idx
                ]
            }

        vectors = []
        v, _, _ = case(
            "closed",
            "A closed election: every anchored segment's word matches the copy",
            closed, honest, 0, anchors(0, 1, 2, 3), board="ok",
        )
        vectors.append(v)
        v, _, _ = case(
            "running",
            "A running election proven mid-way: only segments whose periods ended are read",
            running, honest, 0, anchors(0, 1), board="ok",
        )
        vectors.append(v)
        v, _, _ = case(
            "before-any-anchor",
            "No anchor yet: the lowest-segment word is zero, so no slot is read",
            before, honest, 0, {"anchors": []}, board="ok",
        )
        vectors.append(v)
        v, _, _ = case(
            "first-segment-skips-anchors",
            "With f = 2 the anchors of segments 0 and 1 don't count, so segment 0 is unanchored",
            closed, honest, 2, anchors(2, 3), board={"code": "unanchored", "segment": 0},
        )
        vectors.append(v)
        v, _, _ = case(
            "copy-short",
            "A copy of 7 entries matches segments 0 and 1 only: segment 4's word has no checkpoint",
            closed, honest, 0, {"error": {"code": "l1-checkpoint-unknown", "segment": 4}},
            copyEntries="7",
        )
        vectors.append(v)
        v, _, _ = case(
            "copy-short-with-checkpoints",
            "The same short copy with the anchored checkpoints from their logs: the copy is short",
            closed, honest, 0,
            {
                "anchors": [
                    {"segment": cps[0]["segment"], "hash": cps[0]["hash"], "source": "copy"},
                    {"segment": cps[1]["segment"], "hash": cps[1]["hash"], "source": "copy"},
                    {"segment": cps[2]["segment"], "hash": cps[2]["hash"], "source": "checkpoint"},
                    {"segment": cps[3]["segment"], "hash": cps[3]["hash"], "source": "checkpoint"},
                ]
            },
            copyEntries="7",
            board={"code": "checkpoint-missing", "checkpoint": 2},
        )
        v["checkpoints"] = [checkpoint_bytes(cps[2]), checkpoint_bytes(cps[3])]
        vectors.append(v)
        v, _, _ = case(
            "word-no-copy-matches",
            "The forked anchor's segment-4 word matches no copy and no checkpoint is given",
            closed, forked, 0, {"error": {"code": "l1-checkpoint-unknown", "segment": 4}},
        )
        vectors.append(v)
        bogus_bytes = checkpoint_bytes(bogus)
        v, _, _ = case(
            "word-from-checkpoint-fails",
            "The forked anchor's segment-4 checkpoint, from its log, contradicts the seal's; "
            "an unneeded checkpoint is ignored",
            closed, forked, 0,
            {
                "anchors": [
                    {"segment": cps[0]["segment"], "hash": cps[0]["hash"], "source": "copy"},
                    {"segment": cps[1]["segment"], "hash": cps[1]["hash"], "source": "copy"},
                    {"segment": "4", "hash": checkpoint_hash(bogus_bytes), "source": "checkpoint"},
                    {"segment": cps[3]["segment"], "hash": cps[3]["hash"], "source": "copy"},
                ]
            },
            board={"code": "checkpoint-inconsistent", "checkpoint": 2},
        )
        v["checkpoints"] = [bogus_bytes, checkpoint_bytes(cps[0])]
        vectors.append(v)
        v, _, _ = case(
            "word-misnames-cid",
            "The misnamed anchor's segment-4 word has the copy's head and root but another object CID, "
            "so no copy matches it and, with no checkpoint given, it is unknown",
            closed, misnamed, 0, {"error": {"code": "l1-checkpoint-unknown", "segment": 4}},
        )
        vectors.append(v)
        wrong_cid_bytes = checkpoint_bytes(wrong_cid)
        v, _, _ = case(
            "word-cid-from-checkpoint-fails",
            "The misnamed anchor's segment-4 checkpoint, from its log: the copy matches its head and root, "
            "so the CID that names segment 1's object fails the election",
            closed, misnamed, 0,
            {
                "anchors": [
                    {"segment": cps[0]["segment"], "hash": cps[0]["hash"], "source": "copy"},
                    {"segment": cps[1]["segment"], "hash": cps[1]["hash"], "source": "copy"},
                    {"segment": "4", "hash": checkpoint_hash(wrong_cid_bytes), "source": "checkpoint"},
                    {"segment": cps[3]["segment"], "hash": cps[3]["hash"], "source": "copy"},
                ]
            },
            board={"code": "checkpoint-cid", "checkpoint": 2},
        )
        v["checkpoints"] = [wrong_cid_bytes]
        vectors.append(v)
        v, by_slot, slots = case(
            "missing-node",
            "The leaf proving segment 6's word is left out",
            closed, honest, 0, {"error": {"code": "l1-proof-missing"}},
        )
        leaf = strip(by_slot[slot_of(eid, 6)][-1])
        v["nodes"] = [n for n in v["nodes"] if n != leaf]
        vectors.append(v)
        v, _, _ = case(
            "header-state-root-changed",
            "A header whose state root was changed: its proof's root node isn't among the nodes",
            closed, honest, 0, {"error": {"code": "l1-proof-missing"}},
        )
        root = strip(closed["stateRoot"])
        assert v["block"]["header"].count("a0" + root) == 1
        v["block"]["header"] = v["block"]["header"].replace("a0" + root, "a0" + "5a" * 32)
        del v["block"]["hash"]
        vectors.append(v)
        v, _, _ = case(
            "anchor-absent",
            "No account at the anchor's address",
            closed, NOBODY, 0, {"error": {"code": "l1-anchor-absent"}},
        )
        vectors.append(v)
        v, _, _ = case(
            "anchor-without-code",
            "The anchor's address is an account with no code (the deployer's): read as absent",
            closed, DEPLOYER, 0, {"error": {"code": "l1-anchor-absent"}},
        )
        vectors.append(v)
    finally:
        anvil.terminate()
        anvil.wait()

    doc = {
        "format": "abolish-l1-anchor-vectors/1",
        "title": "Board anchors read from L1 state: headers, trie proofs and the slots of the board anchor",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/verifier/scripts/l1-anchor-vectors.py: deploys packages/contracts' BoardAnchor on Anvil "
            "with board.json's clock, anchors board.json's valid board (and, on a second anchor, a segment-4 "
            "checkpoint with another head, and on a third, one naming segment 1's object CID), and records Anvil's raw headers, block hashes and eth_getProof "
            "trie nodes. Expected anchors are the checkpoints it sent."
        ),
        "clock": clock,
        "electionId": eid,
        "vectors": vectors,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "l1-anchor.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
