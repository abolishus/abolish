#!/usr/bin/env python3
"""Generator for docs/spec/vectors/receipt-key-record.json.

Deploys BoardAnchor (packages/contracts, built by forge) on a local Anvil
chain with the clock of docs/spec/vectors/board.json, registers and retires
receipt keys around an election's `opens_at` through the anchor's own calls,
anchors board.json's `valid` board on the same anchor, and records what a
verifier reads back from L1 state for [[verifier]] 2.9: block headers exactly
as Anvil serves them (`debug_getRawHeader`) and the trie nodes of
`eth_getProof` for every listed key's record slot and the board's slots. The
headers' hashes, the trie nodes and the slots (`cast index`) come from Anvil
and Foundry, which share no code with packages/verifier. The expected
records are the words `eth_getStorageAt` returns, and the expected 2.9 rows
follow from docs/spec/election-definition.md (Receipt keys) as written here.

Words the release code can't write (high bits set, a retirement without a
registration or before it, a time after the block) are written with
`anvil_setStorageAt` on a third anchor, so their proofs are still Anvil's.

Needs anvil, cast and forge on PATH (.github/scripts/install-toolchain.sh).

Usage: python3 -I packages/verifier/scripts/receipt-key-vectors.py <out-dir>
"""

import json
import pathlib
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[3]
PORT = 8598
RPC = f"http://127.0.0.1:{PORT}"
GENESIS = 1_799_990_000
# Anvil's first default account: unlocked, funded, used only to deploy.
DEPLOYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
# The anchoring authority: an address given code, impersonated to send.
AUTHORITY = "0x00000000000000000000000000000000000a0701"
# An address with no account.
NOBODY = "0x00000000000000000000000000000000000b0a0d"
NAMESPACE = 0x16EBA4501D0A9DDDBFA03518D843C364BE664629E6D99EFB7169D8F090095B00
# The election's opens_at: inside segment 1 of board.json's clock.
OPENS_AT = 1_800_005_000
BEFORE_OPEN = 1_800_004_000

# Canonical P-256 keys from election-definition-v4.json, and K6, the twin of
# K1 (the other prefix with the same x, its negation), never registered.
# Named in ascending order of their encodings except K6, which sorts between
# K3 and K4.
K1 = "0251590b7a515140d2d784c85608668fdfef8c82fd1f5be52421554a0dc3d033ed"
K2 = "025ecbe4d1a6330a44c8f7ef951d4bf165e6c6b721efada985fb41661bc6e7fd6c"
K3 = "02e2534a3532d08fbba02dde659ee62bd0031fe2db785596ef509302446b030852"
K4 = "036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"
K5 = "037cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978"
K6 = "03" + K1[2:]


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


def send_together(txs, ts):
    """Mines `txs` (from, to, data) in one block at `ts`, so they share its timestamp."""
    rpc("evm_setAutomine", False)
    try:
        hashes = [
            rpc("eth_sendTransaction", {"from": f, "to": to, "data": d, "gas": h(3_000_000)})
            for f, to, d in txs
        ]
        rpc("evm_setNextBlockTimestamp", h(ts))
        rpc("evm_mine")
    finally:
        rpc("evm_setAutomine", True)
    for txh in hashes:
        if rpc("eth_getTransactionReceipt", txh)["status"] != "0x1":
            raise RuntimeError(f"transaction at {ts} reverted")


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


def key_slot(key):
    """docs/spec/contracts.md, Board anchor, Receipt keys: mapping(uint8 => mapping(bytes32 => Record)) at A + 4."""
    inner = cast("index", "uint8", str(int(key[:2], 16)), h(NAMESPACE + 4))
    return cast("index", "bytes32", "0x" + key[2:], inner)


def board_slots(election_id, block, clock, first=0):
    tag = block["number"]
    now = int(block["timestamp"], 16)
    epoch, period, last = int(clock["epoch"]), int(clock["period"]), int(clock["lastSegment"])
    low_slot = cast("index", "bytes32", "0x" + election_id, h(NAMESPACE + 1))
    slots = [low_slot]
    low = int(rpc("eth_getStorageAt", ANCHORS["honest"], low_slot, tag), 16)
    if low > 0:
        inner = cast("index", "bytes32", "0x" + election_id, h(NAMESPACE))
        s = max(low - 1, first)
        while s <= last and epoch + (s + 1) * period <= now:
            slots.append(cast("index", "uint32", str(s), inner))
            s += 1
    return slots


ANCHORS = {}


def row_29(words, opens_at, proven_at):
    """docs/spec/verifier.md, 2.9, from the words read (None for one that can't be read)."""
    unverifiable = None
    for i, w in enumerate(words):
        if w is None:
            unverifiable = unverifiable or ("l1-proof-missing", i)
            continue
        reg, ret, high = w & (2**64 - 1), (w >> 64) & (2**64 - 1), w >> 128
        if high or (ret and (reg == 0 or reg > ret)) or reg > proven_at or ret > proven_at:
            return {"status": "fail", "code": "receipt-key-record", "at": {"key": i}}
        before = 0 < reg < opens_at
        if before and ret and ret <= opens_at:
            return {"status": "fail", "code": "receipt-key-retired", "at": {"key": i}}
        if proven_at < opens_at:
            unverifiable = unverifiable or ("receipt-key-unsettled", i)
        elif not before:
            return {"status": "fail", "code": "receipt-key-unregistered", "at": {"key": i}}
    if unverifiable:
        return {"status": "unverifiable", "code": unverifiable[0], "at": {"key": unverifiable[1]}}
    return {"status": "pass"}


def main():
    out_dir = pathlib.Path(sys.argv[1])
    board_file = json.loads((ROOT / "docs/spec/vectors/board.json").read_text())
    clock = board_file["clock"]
    valid = next(b for b in board_file["boards"] if b["id"] == "valid")
    eid = valid["electionId"]
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
        args = strip(
            cast(
                "abi-encode",
                "f((uint64,uint64,uint64),address)",
                f"({clock['epoch']},{clock['period']},{clock['deadline']})",
                AUTHORITY,
            )
        )
        t = GENESIS + 100
        for name in ("honest", "boundary", "impossible"):
            ANCHORS[name] = send(DEPLOYER, None, code + args, t)["contractAddress"]
            t += 1

        def call(name, fn, key, ts):
            data = cast("calldata", f"{fn}(bytes)", "0x" + key)
            send(AUTHORITY, ANCHORS[name], data, ts)

        def anchor(cp):
            data = cast("calldata", "anchor(bytes,bytes)", "0x" + checkpoint_bytes(cp), "0x")
            send(AUTHORITY, ANCHORS["honest"], data, int(cp["anchoredAt"]))

        # The honest anchor's history, in time order. K1 and K2 judge the
        # election (K2's retirement comes after opens_at); K3 is retired at
        # opens_at and K4 before it; K5 is registered after it; K6 never is.
        call("honest", "registerReceiptKey", K1, 1_800_000_200)
        call("honest", "registerReceiptKey", K2, 1_800_000_201)
        call("honest", "registerReceiptKey", K3, 1_800_000_202)
        call("honest", "registerReceiptKey", K4, 1_800_000_300)
        call("honest", "retireReceiptKey", K4, 1_800_002_000)
        cps = valid["checkpoints"]
        anchor(cps[0])
        before = mine_at(BEFORE_OPEN)
        # At opens_at exactly: K3 retired on the honest anchor, and K5
        # registered on the boundary anchor, so not before opens_at.
        send_together(
            [
                (AUTHORITY, ANCHORS["honest"], cast("calldata", "retireReceiptKey(bytes)", "0x" + K3)),
                (AUTHORITY, ANCHORS["boundary"], cast("calldata", "registerReceiptKey(bytes)", "0x" + K5)),
            ],
            OPENS_AT,
        )
        call("honest", "retireReceiptKey", K2, OPENS_AT + 1)
        call("honest", "registerReceiptKey", K5, OPENS_AT + 100)
        for cp in cps[1:]:
            anchor(cp)
        closed_at = int(valid["now"])

        # Words no release code writes, each under its own key on the third
        # anchor: (registered_at, retired_at, high 128 bits).
        impossible = {
            K1: (1_800_000_200, 0, 1),
            K2: (0, 1_800_000_300, 0),
            K3: (1_800_000_300, 1_800_000_200, 0),
            K6: (closed_at + 1, 0, 0),
            K5: (1_800_000_200, closed_at + 1, 0),
            # Possible words beside them: registered and retired in one second.
            K4: (1_800_000_200, 1_800_000_200, 0),
        }
        for key, (reg, ret, high) in impossible.items():
            word = (high << 128) | (ret << 64) | reg
            rpc("anvil_setStorageAt", ANCHORS["impossible"], key_slot(key), "0x" + word.to_bytes(32, "big").hex())
        closed = mine_at(closed_at)

        def header(block):
            return {
                "hash": strip(block["hash"]),
                "number": str(int(block["number"], 16)),
                "timestamp": str(int(block["timestamp"], 16)),
                "header": strip(rpc("debug_getRawHeader", block["number"])),
            }

        def case(id_, description, block, name, keys, result, board=False):
            address = NOBODY if name == "nobody" else ANCHORS[name]
            slots = [key_slot(k) for k in keys]
            extra = board_slots(eid, block, clock) if board else []
            p = rpc("eth_getProof", address, slots + extra, block["number"])
            seen, nodes = set(), []
            for n in p["accountProof"] + [x for sp in p["storageProof"] for x in sp["proof"]]:
                if n not in seen:
                    seen.add(n)
                    nodes.append(strip(n))
            leaves = {sp["key"]: strip(sp["proof"][-1]) for sp in p["storageProof"] if sp["proof"]}
            v = {
                "id": id_,
                "description": description,
                "block": header(block),
                "anchor": strip(address),
                "receiptKeys": keys,
                "slots": [strip(x) for x in slots],
                "nodes": nodes,
                "records": (
                    []
                    if name == "nobody"
                    else [
                        int(rpc("eth_getStorageAt", address, s, block["number"]), 16).to_bytes(32, "big").hex()
                        for s in slots
                    ]
                ),
                "result": result,
            }
            if board:
                v["board"] = "valid"
            return v, leaves, slots

        PASS = {"status": "pass"}

        def fail(code, key):
            return {"status": "fail", "code": code, "at": {"key": key}}

        def unverifiable(code, at):
            return {"status": "unverifiable", "code": code, "at": at}

        vectors = []

        leaf_of = {}

        def add(*a, **k):
            v, leaves, slots = case(*a, **k)
            for i, slot in enumerate(slots):
                leaf_of[(v["id"], i)] = leaves[slot]
            vectors.append(v)
            return v, leaves, slots

        add(
            "closed-judges",
            "Two keys registered before opens_at, one retired after it, with the closed board's anchors: both judge",
            closed, "honest", [K1, K2], PASS, board=True,
        )
        add(
            "closed-retired-at-open",
            "A key retired at opens_at exactly is retired",
            closed, "honest", [K1, K3], fail("receipt-key-retired", 1), board=True,
        )
        add(
            "closed-unregistered-after-open",
            "A key registered after opens_at doesn't judge the election",
            closed, "honest", [K1, K2, K5], fail("receipt-key-unregistered", 2),
        )
        add(
            "closed-never-registered",
            "A key never registered (K1's twin): its word is zero",
            closed, "honest", [K1, K6], fail("receipt-key-unregistered", 1),
        )
        add(
            "closed-first-failure",
            "Keys are judged in list order: the first failing key is reported",
            closed, "honest", [K3, K6, K4], fail("receipt-key-retired", 0),
        )
        add(
            "before-open-unsettled",
            "Proven at a block before opens_at, registered keys may still be retired by then",
            before, "honest", [K1, K2], unverifiable("receipt-key-unsettled", {"key": 0}),
        )
        add(
            "before-open-unregistered-unsettled",
            "Before opens_at an unregistered key may still be registered",
            before, "honest", [K1, K6], unverifiable("receipt-key-unsettled", {"key": 0}),
        )
        add(
            "before-open-retired",
            "A retirement before opens_at is final at any block, so it fails beside an earlier unsettled key",
            before, "honest", [K1, K4], fail("receipt-key-retired", 1),
        )
        add(
            "registered-at-open",
            "A key registered at opens_at exactly isn't registered before it",
            closed, "boundary", [K5], fail("receipt-key-unregistered", 0),
        )
        v, leaves, slots = add(
            "missing-node",
            "The leaf proving the second key's word is left out",
            closed, "honest", [K1, K2], unverifiable("l1-proof-missing", {"key": 1}),
        )
        v["nodes"] = [n for n in v["nodes"] if n != leaves[slots[1]]]
        v, leaves, slots = add(
            "missing-node-beside-failure",
            "An unreadable word doesn't hide a later key's failure",
            closed, "honest", [K1, K4], fail("receipt-key-retired", 1),
        )
        v["nodes"] = [n for n in v["nodes"] if n != leaves[slots[0]]]
        add(
            "anchor-absent",
            "No account at the anchor's address: no word is read",
            closed, "nobody", [K1], unverifiable("l1-anchor-absent", {}),
        )
        add(
            "record-high-bits",
            "A word with a high bit set can't be written by the release code",
            closed, "impossible", [K1], fail("receipt-key-record", 0),
        )
        add(
            "record-retired-unregistered",
            "A retirement without a registration",
            closed, "impossible", [K2], fail("receipt-key-record", 0),
        )
        add(
            "record-retired-before-registered",
            "A retirement before the registration",
            closed, "impossible", [K3], fail("receipt-key-record", 0),
        )
        add(
            "record-after-block",
            "A registration later than the block it is proven at",
            closed, "impossible", [K6], fail("receipt-key-record", 0),
        )
        add(
            "record-retired-after-block",
            "A retirement later than the block it is proven at, after a registration before it",
            closed, "impossible", [K5], fail("receipt-key-record", 0),
        )
        add(
            "record-registered-and-retired-together",
            "Registered and retired in one second, before opens_at: a word the release code writes, and retired",
            closed, "impossible", [K4], fail("receipt-key-retired", 0),
        )
        add(
            "record-list-order",
            "An impossible word is a failure like any other, reported in list order",
            closed, "impossible", [K1, K4], fail("receipt-key-record", 0),
        )
        # The rows written above, recomputed from the words and the leaves
        # each vector keeps.
        for v in vectors:
            if v["anchor"] == strip(NOBODY):
                continue
            kept = set(v["nodes"])
            words = [
                int(w, 16) if leaf_of[(v["id"], i)] in kept else None
                for i, w in enumerate(v["records"])
            ]
            got = row_29(words, OPENS_AT, int(v["block"]["timestamp"]))
            if got != v["result"]:
                raise RuntimeError(f"{v['id']}: expected {v['result']}, recomputed {got}")
    finally:
        anvil.terminate()
        anvil.wait()

    doc = {
        "format": "abolish-receipt-key-record-vectors/1",
        "title": "Receipt-key records read from L1 state: the board anchor's record slots and verifier check 2.9",
        "spec": "docs/spec/verifier.md",
        "generator": (
            "packages/verifier/scripts/receipt-key-vectors.py: deploys packages/contracts' BoardAnchor on Anvil "
            "with board.json's clock, registers and retires receipt keys around opensAt through the anchor's own "
            "calls (and writes words no release code writes with anvil_setStorageAt on a third anchor), anchors "
            "board.json's valid board, and records Anvil's raw headers, block hashes, eth_getProof trie nodes and "
            "eth_getStorageAt words. Slots come from cast index."
        ),
        "clock": clock,
        "electionId": eid,
        "opensAt": str(OPENS_AT),
        "vectors": vectors,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "receipt-key-record.json").write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    main()
