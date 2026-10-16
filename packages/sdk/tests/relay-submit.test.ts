// The forced-path client (P4-2 part 2): its revert decoding, its handling of
// both providers' answers, and a run against the real relay on one Anvil
// chain (L1, with the relay tests' recording portal) and the real board on
// another (L2), both built by forge from packages/contracts. The portal's
// recorded deposit is replayed on L2 from the relay's alias with exactly the
// gas limit the client chose, as the L2's derivation would run it, so the
// client's limit is shown to be enough and its search finds the event with
// the call's fields (T-50, T-25, T-71). Anvil's unlocked development
// accounts sign: no key is held here (AGENTS.md).

import {
  frameBallot,
  l2Alias,
  RELAY_EVENT_SIGNATURE,
  relayBallotCalldata,
  relayCallHash,
  relayDepositData,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  decodeRelayedBallotRevert,
  decodeRelayRevert,
  type Eip1193Provider,
  findRelayedBallot,
  MAX_TRANSACTION_GAS,
  portalMinimumGasLimit,
  RELAYED_BALLOT_SUBMITTED_SIGNATURE,
  relayBallot,
  type RelayBallotOptions,
} from "../src/index.ts";
import {
  type Anvil,
  boardRegistries,
  hex,
  parametersOf,
  selector,
  startAnvil,
  unhex,
  vectors,
  word,
} from "./anvil.ts";

const numRuns = Number(process.env.FC_NUM_RUNS ?? 100);
const BALLOT_RELAYED = keccak_256(new TextEncoder().encode(RELAY_EVENT_SIGNATURE));
const RELAYED_BALLOT_SUBMITTED = keccak_256(
  new TextEncoder().encode(RELAYED_BALLOT_SUBMITTED_SIGNATURE),
);
const errorData = (signature: string, ...words: bigint[]) =>
  concatBytes(selector(signature), ...words.map(word));

describe("decodeRelayRevert", () => {
  it("reads each of the relay's errors", () => {
    expect(decodeRelayRevert(selector("NonCanonicalCalldata()"))).toEqual({ kind: "calldata" });
    expect(decodeRelayRevert(errorData("RelayTooLarge(uint256)", 119_777n))).toEqual({
      kind: "relay-too-large",
      length: 119_777n,
    });
    expect(decodeRelayRevert(errorData("RelayTruncated(uint256)", 34n))).toEqual({
      kind: "relay-truncated",
      length: 34n,
    });
    expect(decodeRelayRevert(errorData("RelayRecordType(uint16)", 3n))).toEqual({
      kind: "relay-record-type",
      recordType: 3,
    });
  });

  it("calls anything else unknown: a type past 16 bits, wrong lengths, other errors", () => {
    for (const data of [
      errorData("RelayRecordType(uint16)", 0x10000n),
      concatBytes(errorData("RelayTooLarge(uint256)", 1n), new Uint8Array(1)),
      selector("RelayTruncated(uint256)"),
      concatBytes(selector("NonCanonicalCalldata()"), new Uint8Array(32)),
      errorData("Error(string)", 32n),
      new Uint8Array(),
    ])
      expect(decodeRelayRevert(data)).toEqual({ kind: "unknown", data });
  });

  it("never throws on any bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 100 }), (data) => {
        decodeRelayRevert(data);
        decodeRelayedBallotRevert(data);
      }),
      { numRuns },
    );
  });
});

describe("decodeRelayedBallotRevert", () => {
  it("reads the relayed path's own errors and the ballot check's", () => {
    expect(decodeRelayedBallotRevert(errorData("RelaySender(address)", 0x1234n))).toEqual({
      kind: "sender",
    });
    expect(
      decodeRelayedBallotRevert(errorData("RelayWindow(uint64,uint64,uint64)", 5n, 10n, 20n)),
    ).toEqual({ kind: "window", timestamp: 5n, opensAt: 10n, closesAt: 20n });
    expect(decodeRelayedBallotRevert(errorData("BallotRefused(uint8)", 5n))).toEqual({
      kind: "refused",
      code: "membership-proof",
    });
    expect(decodeRelayedBallotRevert(selector("InsufficientGas()"))).toEqual({ kind: "gas" });
  });

  it("takes neither the ordinary path's window nor words past their types", () => {
    for (const data of [
      errorData("BallotWindow(uint256,uint64,uint64)", 5n, 10n, 20n),
      errorData("RelaySender(address)", 1n << 160n),
      errorData("RelayWindow(uint64,uint64,uint64)", 1n << 64n, 10n, 20n),
    ])
      expect(decodeRelayedBallotRevert(data)).toEqual({ kind: "unknown", data });
  });
});

describe("portalMinimumGasLimit", () => {
  it("is 21,000 and 40 a byte", () => {
    expect(portalMinimumGasLimit(0)).toBe(21_000n);
    expect(portalMinimumGasLimit(196 + 352)).toBe(21_000n + 40n * 548n);
    expect(() => portalMinimumGasLimit(-1)).toThrow(RangeError);
  });
});

function scripted(answers: Record<string, (params: readonly unknown[]) => unknown>) {
  const requests: { method: string; params: readonly unknown[] }[] = [];
  const provider: Eip1193Provider = {
    async request({ method, params = [] }) {
      requests.push({ method, params });
      const answer = answers[method];
      if (answer === undefined) throw new Error(`unexpected ${method}`);
      return answer(params);
    },
  };
  return { provider, requests };
}

const revert = (signature: string, ...words: bigint[]) =>
  Object.assign(new Error("execution reverted"), {
    code: 3,
    data: hex(errorData(signature, ...words)),
  });

describe("relayBallot against scripted providers", () => {
  const relay = new Uint8Array(20).fill(0xcc);
  const board = new Uint8Array(20).fill(0xbb);
  const from = new Uint8Array(20).fill(0xaa);
  const [honest] = vectors.ballots;
  if (honest === undefined) throw new Error("ballot.json has its ballots");
  const record = unhex(honest.encoding);
  const framed = frameBallot(record);
  if (framed === undefined) throw new Error("the vector ballot frames");
  const L1 = 11_155_111n;
  const L2 = 84_532n;
  const txHash = `0x${"77".repeat(32)}`;
  const blockHash = `0x${"88".repeat(32)}`;
  const head = { number: "0x64", timestamp: "0x6553f100", hash: `0x${"99".repeat(32)}` };
  const mined = { number: "0x65", timestamp: "0x6553f10c", hash: blockHash };
  // The board's estimate, and the limit a quarter over it.
  const gasLimit = 1_250_000n;
  const callHash = relayCallHash({
    l1ChainId: L1,
    relay,
    index: 5n,
    l1Block: 0x65n,
    l1Timestamp: 0x6553f10cn,
    gasLimit,
    record,
  });
  const relayedLog = (changes: Record<string, unknown> = {}) => ({
    address: hex(relay),
    topics: [hex(BALLOT_RELAYED), hex(framed.definitionHash), hex(word(5n))],
    data: hex(callHash),
    transactionHash: txHash,
    blockNumber: "0x65",
    blockHash,
    logIndex: "0x0",
    removed: false,
    ...changes,
  });
  const receipt = (logs: unknown[], status = "0x1") => ({
    transactionHash: txHash,
    status,
    blockHash,
    blockNumber: "0x65",
    logs,
  });
  const l1 = (changes: Record<string, (params: readonly unknown[]) => unknown> = {}) =>
    scripted({
      eth_chainId: () => "0xaa36a7",
      eth_call: ([call]) => {
        const data = (call as { data: string }).data;
        if (data === hex(selector("board()"))) return hex(concatBytes(new Uint8Array(12), board));
        if (data === hex(selector("callCount()"))) return hex(word(5n));
        return "0x";
      },
      eth_getBlockByNumber: () => head,
      eth_estimateGas: () => "0x30d40",
      eth_sendTransaction: () => txHash,
      eth_getTransactionReceipt: () => receipt([relayedLog()]),
      eth_getBlockByHash: () => mined,
      ...changes,
    });
  const l2 = (changes: Record<string, (params: readonly unknown[]) => unknown> = {}) =>
    scripted({
      eth_chainId: () => "0x14a34",
      eth_call: () => "0x",
      eth_getLogs: () => [],
      eth_estimateGas: () => "0xf4240",
      ...changes,
    });
  const options = (
    l1Provider: Eip1193Provider,
    l2Provider: Eip1193Provider,
    over: Partial<RelayBallotOptions> = {},
  ): RelayBallotOptions => ({
    l1Provider,
    l1ChainId: L1,
    relay,
    l2Provider,
    l2ChainId: L2,
    board,
    from,
    record,
    fromBlock: 7n,
    sleep: async () => {},
    ...over,
  });

  it("asks the board as the deposit runs, then sends the call on L1 and checks what the relay recorded", async () => {
    const a = l1();
    const b = l2();
    expect(await relayBallot(options(a.provider, b.provider))).toEqual({
      status: "relayed",
      call: {
        index: 5n,
        l1Block: 0x65n,
        stamp: 0x6553f10cn,
        gasLimit,
        callHash,
        transactionHash: unhex(txHash),
        blockHash: unhex(blockHash),
      },
    });
    // The board is asked from the relay's alias, with the relay's next
    // index, the next L1 block and the head's time as the stamp.
    const probe = {
      from: hex(l2Alias(relay)),
      to: hex(board),
      data: hex(relayDepositData(5n, 0x65n, 0x6553f100n, MAX_TRANSACTION_GAS, record)),
    };
    expect(b.requests.find((r) => r.method === "eth_call")?.params).toEqual([probe, "latest"]);
    expect(b.requests.find((r) => r.method === "eth_estimateGas")?.params).toEqual([probe]);
    // Only relayed copies count, under the record's own hashes.
    expect(b.requests.find((r) => r.method === "eth_getLogs")?.params).toEqual([
      {
        address: hex(board),
        fromBlock: "0x7",
        toBlock: "latest",
        topics: [hex(RELAYED_BALLOT_SUBMITTED), hex(framed.definitionHash), hex(framed.ballotHash)],
      },
    ]);
    // The relay is asked without the account; the call carries the limit,
    // the L1 estimate and a quarter, and the chain.
    const data = hex(relayBallotCalldata(gasLimit, record));
    expect(a.requests.filter((r) => r.method === "eth_call").at(-1)?.params).toEqual([
      { to: hex(relay), data },
      "latest",
    ]);
    expect(a.requests.find((r) => r.method === "eth_sendTransaction")?.params[0]).toEqual({
      from: hex(from),
      to: hex(relay),
      data,
      gas: "0x3d090",
      chainId: "0xaa36a7",
    });
    expect(a.requests.filter((r) => r.method === "eth_chainId").length).toBe(2);
    expect(a.requests.find((r) => r.method === "eth_getBlockByHash")?.params).toEqual([
      blockHash,
      false,
    ]);
  });

  it("refuses what the relay refuses without asking anyone", async () => {
    const a = l1();
    const b = l2();
    const cases = [
      [record.subarray(0, 34), { kind: "relay-truncated", length: 34n }],
      [
        concatBytes(Uint8Array.of(0, 3), record.subarray(2)),
        { kind: "relay-record-type", recordType: 3 },
      ],
      [new Uint8Array(119_777), { kind: "relay-too-large", length: 119_777n }],
    ] as const;
    for (const [r, refusal] of cases)
      expect(await relayBallot(options(a.provider, b.provider, { record: r }))).toEqual({
        status: "refused",
        by: "relay",
        refusal,
      });
    expect([...a.requests, ...b.requests]).toEqual([]);
  });

  it("refuses providers on other chains and a relay for another board", async () => {
    await expect(
      relayBallot(options(l1({ eth_chainId: () => "0x1" }).provider, l2().provider)),
    ).rejects.toMatchObject({ code: "wrong-chain" });
    await expect(
      relayBallot(options(l1().provider, l2({ eth_chainId: () => "0x2105" }).provider)),
    ).rejects.toMatchObject({ code: "wrong-chain" });
    const other = l1({ eth_call: () => hex(word(0xdeadn)) });
    await expect(relayBallot(options(other.provider, l2().provider))).rejects.toMatchObject({
      code: "wrong-relay",
    });
    expect(other.requests.some((r) => r.method === "eth_sendTransaction")).toBe(false);
  });

  it("sends nothing the board refuses, at the call or at the estimate", async () => {
    for (const where of ["eth_call", "eth_estimateGas"] as const) {
      const a = l1();
      const b = l2({
        [where]: () => {
          throw revert("RelayWindow(uint64,uint64,uint64)", 0x6553f100n, 1n, 2n);
        },
      });
      expect(await relayBallot(options(a.provider, b.provider)), where).toEqual({
        status: "refused",
        by: "board",
        refusal: { kind: "window", timestamp: 0x6553f100n, opensAt: 1n, closesAt: 2n },
      });
      expect(a.requests.some((r) => r.method === "eth_sendTransaction")).toBe(false);
    }
  });

  it("finds a relayed copy instead of paying for another, and takes no ordinary one", async () => {
    const relayedData = relayDepositData(1n, 2n, 3n, 4n, record).subarray(4);
    const copy = {
      address: hex(board),
      topics: [hex(RELAYED_BALLOT_SUBMITTED), hex(framed.definitionHash), hex(framed.ballotHash)],
      data: hex(relayedData),
      transactionHash: txHash,
      blockNumber: "0x10",
      blockHash,
      logIndex: "0x2",
    };
    const a = l1();
    expect(
      await relayBallot(options(a.provider, l2({ eth_getLogs: () => [copy] }).provider)),
    ).toEqual({
      status: "already-relayed",
      path: "relayed",
      call: { index: 1n, l1Block: 2n, stamp: 3n, gasLimit: 4n },
      transactionHash: unhex(txHash),
      blockNumber: 16n,
      blockHash: unhex(blockHash),
      logIndex: 2n,
    });
    expect(a.requests.some((r) => r.method === "eth_sendTransaction")).toBe(false);
    // A node that answers with an ordinary event under the relayed topic
    // gives nothing the client takes.
    const ordinary = {
      ...copy,
      topics: [
        hex(keccak_256(new TextEncoder().encode("BallotSubmitted(bytes32,bytes32,bytes)"))),
        hex(framed.definitionHash),
        hex(framed.ballotHash),
      ],
      data: hex(concatBytes(word(32n), relayedData.subarray(160))),
    };
    expect(
      (await relayBallot(options(l1().provider, l2({ eth_getLogs: () => [ordinary] }).provider)))
        .status,
    ).toBe("relayed");
  });

  it("gives the deposit at least the portal's minimum", async () => {
    const floor = portalMinimumGasLimit(relayDepositData(0n, 0n, 0n, 0n, record).length);
    const atFloor = relayCallHash({
      l1ChainId: L1,
      relay,
      index: 5n,
      l1Block: 0x65n,
      l1Timestamp: 0x6553f10cn,
      gasLimit: floor,
      record,
    });
    const a = l1({
      eth_getTransactionReceipt: () => receipt([relayedLog({ data: hex(atFloor) })]),
    });
    const result = await relayBallot(
      options(a.provider, l2({ eth_estimateGas: () => "0x1" }).provider),
    );
    expect(result).toMatchObject({ status: "relayed", call: { gasLimit: floor } });
    expect(a.requests.find((r) => r.method === "eth_sendTransaction")?.params[0]).toMatchObject({
      data: hex(relayBallotCalldata(floor, record)),
    });
  });

  it("refuses a call the deposit market prices past one transaction's cap, and caps the margin", async () => {
    const over = l1({ eth_estimateGas: () => `0x${(MAX_TRANSACTION_GAS + 1n).toString(16)}` });
    expect(await relayBallot(options(over.provider, l2().provider))).toEqual({
      status: "over-cap",
      estimate: MAX_TRANSACTION_GAS + 1n,
      gasLimit,
    });
    expect(over.requests.some((r) => r.method === "eth_sendTransaction")).toBe(false);
    const near = l1({ eth_estimateGas: () => "0xf00000" });
    await relayBallot(options(near.provider, l2().provider));
    expect(near.requests.find((r) => r.method === "eth_sendTransaction")?.params[0]).toMatchObject({
      gas: "0x1000000",
    });
  });

  it("reports the relay's refusal before sending, and after a reverted transaction", async () => {
    const tooLarge = () => {
      throw revert("RelayTooLarge(uint256)", 200_000n);
    };
    const asked = l1({
      eth_call: ([call]) => {
        const data = (call as { data: string }).data;
        if (data === hex(selector("board()"))) return hex(concatBytes(new Uint8Array(12), board));
        if (data === hex(selector("callCount()"))) return hex(word(5n));
        return tooLarge();
      },
    });
    expect(await relayBallot(options(asked.provider, l2().provider))).toEqual({
      status: "refused",
      by: "relay",
      refusal: { kind: "relay-too-large", length: 200_000n },
    });
    expect(asked.requests.some((r) => r.method === "eth_sendTransaction")).toBe(false);

    let sent = false;
    const reverted = l1({
      eth_sendTransaction: () => {
        sent = true;
        return txHash;
      },
      eth_call: ([call]) => {
        const data = (call as { data: string }).data;
        if (data === hex(selector("board()"))) return hex(concatBytes(new Uint8Array(12), board));
        if (data === hex(selector("callCount()"))) return hex(word(5n));
        return sent ? tooLarge() : "0x";
      },
      eth_getTransactionReceipt: () => receipt([], "0x0"),
    });
    expect(await relayBallot(options(reverted.provider, l2().provider))).toEqual({
      status: "refused",
      by: "relay",
      refusal: { kind: "relay-too-large", length: 200_000n },
      transactionHash: unhex(txHash),
    });
    await expect(
      relayBallot(
        options(
          l1({ eth_getTransactionReceipt: () => receipt([], "0x0") }).provider,
          l2().provider,
        ),
      ),
    ).rejects.toMatchObject({ code: "reverted" });
  });

  it("takes only the relay's one event for this call", async () => {
    const mismatched = [
      [],
      [relayedLog(), relayedLog({ logIndex: "0x1" })],
      [relayedLog({ data: hex(new Uint8Array(32)) })],
      [relayedLog({ topics: [hex(BALLOT_RELAYED), hex(new Uint8Array(32)), hex(word(5n))] })],
      [relayedLog({ topics: [hex(BALLOT_RELAYED), hex(framed.definitionHash), hex(word(6n))] })],
      [
        relayedLog({
          topics: [hex(BALLOT_RELAYED), hex(framed.definitionHash), hex(word(1n << 64n))],
        }),
      ],
      [relayedLog({ blockHash: `0x${"00".repeat(32)}` })],
      [relayedLog({ address: hex(board) })],
      [relayedLog({ transactionHash: `0x${"00".repeat(32)}` })],
      [relayedLog({ removed: true })],
    ];
    for (const logs of mismatched)
      await expect(
        relayBallot(
          options(l1({ eth_getTransactionReceipt: () => receipt(logs) }).provider, l2().provider),
        ),
        JSON.stringify(logs),
      ).rejects.toMatchObject({ code: "event-mismatch" });
    // The stamp is the call's own block's, read by its hash.
    await expect(
      relayBallot(
        options(
          l1({ eth_getBlockByHash: () => ({ ...mined, timestamp: "0x6553f10d" }) }).provider,
          l2().provider,
        ),
      ),
    ).rejects.toMatchObject({ code: "event-mismatch" });
    await expect(
      relayBallot(
        options(
          l1({ eth_getBlockByHash: () => ({ ...mined, number: "0x66" }) }).provider,
          l2().provider,
        ),
      ),
    ).rejects.toMatchObject({ code: "bad-response" });
    await expect(
      relayBallot(
        options(
          l1({
            eth_getTransactionReceipt: () => ({ ...receipt([]), transactionHash: blockHash }),
          }).provider,
          l2().provider,
        ),
      ),
    ).rejects.toMatchObject({ code: "bad-response" });
  });

  it("gives up after its polls without a receipt", async () => {
    await expect(
      relayBallot(
        options(l1({ eth_getTransactionReceipt: () => null }).provider, l2().provider, {
          maxPolls: 3,
        }),
      ),
    ).rejects.toMatchObject({ code: "receipt-timeout" });
  });
});

describe("findRelayedBallot against a scripted provider", () => {
  const board = new Uint8Array(20).fill(0xbb);
  const record = unhex(vectors.ballots[0]?.encoding ?? "");
  const framed = frameBallot(record);
  if (framed === undefined) throw new Error("the vector ballot frames");
  const log = {
    address: hex(board),
    topics: [hex(RELAYED_BALLOT_SUBMITTED), hex(framed.definitionHash), hex(framed.ballotHash)],
    data: hex(relayDepositData(1n, 2n, 3n, 4n, record).subarray(4)),
    transactionHash: `0x${"77".repeat(32)}`,
    blockNumber: "0x10",
    blockHash: `0x${"88".repeat(32)}`,
    logIndex: "0x2",
  };
  const find = (call: { index: bigint; l1Block: bigint; stamp: bigint; gasLimit: bigint }) =>
    findRelayedBallot({
      provider: scripted({ eth_chainId: () => "0x14a34", eth_getLogs: () => [log] }).provider,
      chainId: 84_532n,
      board,
      record,
      call,
      fromBlock: 0n,
    });

  it("finds the deposit naming exactly the call, and no other", async () => {
    const call = { index: 1n, l1Block: 2n, stamp: 3n, gasLimit: 4n };
    expect(await find(call)).toMatchObject({ path: "relayed", call, blockNumber: 16n });
    for (const other of [
      { ...call, index: 0n },
      { ...call, l1Block: 3n },
      { ...call, stamp: 4n },
      { ...call, gasLimit: 5n },
    ])
      expect(await find(other)).toBeUndefined();
  });
});

const L1_CHAIN = 31_340n;
const L2_CHAIN = 31_341n;
const plurality = parametersOf("plurality");

let l1: Anvil;
let l2: Anvil;
let voter: Uint8Array;
let portal: Uint8Array;
let relay: Uint8Array;
let board: Uint8Array;
let fromBlock: bigint;
let register: (election: string, registered: readonly number[]) => Promise<void>;

/** The CREATE address of `deployer`'s contract at `nonce` (below 0x80), from RLP([deployer, nonce]). */
function createAddress(deployer: Uint8Array, nonce: bigint): Uint8Array {
  if (nonce >= 0x80n) throw new Error("nonce too large for this helper");
  const n = nonce === 0n ? Uint8Array.of(0x80) : Uint8Array.of(Number(nonce));
  return keccak_256(concatBytes(Uint8Array.of(0xd6, 0x94), deployer, n)).slice(12);
}

const relayOptions = (record: Uint8Array): RelayBallotOptions => ({
  l1Provider: l1.provider,
  l1ChainId: L1_CHAIN,
  relay,
  l2Provider: l2.provider,
  l2ChainId: L2_CHAIN,
  board,
  from: voter,
  record,
  fromBlock,
  pollInterval: 10,
});

const relayCount = async () =>
  BigInt(
    String(
      await l1.provider.request({
        method: "eth_call",
        params: [{ to: hex(relay), data: hex(selector("callCount()")) }, "latest"],
      }),
    ),
  );

beforeAll(async () => {
  // L1's genesis an hour before the vector elections open, so the stamp can
  // be put on both sides of the window; L2's time isn't judged on this path.
  [l1, l2] = await Promise.all([
    startAnvil(L1_CHAIN, plurality.opensAt - 3_600n),
    startAnvil(L2_CHAIN, plurality.opensAt - 3_600n),
  ]);
  voter = unhex(l1.accounts[4] as string);
  const deployer = unhex(l1.accounts[0] as string);
  portal = await l1.deploy("test/BallotRelay.t.sol:MockPortal");
  // The relay names the board and the board the relay, so the relay's
  // address is fixed first from the deployer's nonce.
  const relayAt = createAddress(deployer, await l1.nonce(deployer));
  const elections = await l2.deploy("test/utils/BoardFixture.sol:ElectionsStub");
  const trustees = await l2.deploy("test/utils/BoardFixture.sol:TrusteesStub");
  register = boardRegistries(l2, elections, trustees, ["plurality", "approval"]);
  board = await l2.deploy(
    "src/Board.sol:Board",
    concatBytes(...[elections, trustees, relayAt].map((a) => concatBytes(new Uint8Array(12), a))),
  );
  relay = await l1.deploy(
    "src/BallotRelay.sol:BallotRelay",
    concatBytes(...[portal, board].map((a) => concatBytes(new Uint8Array(12), a))),
  );
  expect(hex(relay)).toBe(hex(relayAt));
  fromBlock = BigInt(String(await l2.provider.request({ method: "eth_blockNumber" })));
}, 120_000);

afterAll(async () => {
  await Promise.all([l1?.stop(), l2?.stop()]);
});

/** The portal's recorded deposit `i`: `(to, value, gasLimit, isCreation, data)`. */
async function depositOf(i: bigint) {
  const out = unhex(
    String(
      await l1.provider.request({
        method: "eth_call",
        params: [
          {
            to: hex(portal),
            data: hex(concatBytes(selector("deposit(uint256)"), word(i))),
          },
          "latest",
        ],
      }),
    ),
  );
  // abi.encode of the struct: its offset, then to, value, gasLimit,
  // isCreation, data's offset (0xa0), data's length and the data.
  const at = (k: number) => BigInt(hex(out.subarray(32 + 32 * k, 64 + 32 * k)));
  const length = Number(at(5));
  return {
    to: out.subarray(32 + 12, 64),
    value: at(1),
    gasLimit: at(2),
    isCreation: at(3),
    data: out.subarray(32 + 32 * 6, 32 + 32 * 6 + length),
  };
}

describe("relayBallot against the relay and the board on Anvil", () => {
  it("sends nothing while the L1 head is before the window", async () => {
    const [v] = vectors.ballots;
    if (v === undefined) throw new Error("ballot.json has its ballots");
    await register("plurality", v.registered);
    const at = plurality.opensAt - 60n;
    await l1.mineAt(at);
    const before = await l1.nonce(voter);
    expect(await relayBallot(relayOptions(unhex(v.encoding)))).toEqual({
      status: "refused",
      by: "board",
      refusal: {
        kind: "window",
        timestamp: at,
        opensAt: plurality.opensAt,
        closesAt: plurality.closesAt,
      },
    });
    expect(await l1.nonce(voter)).toBe(before);
    expect(await relayCount()).toBe(0n);
  }, 60_000);

  it("gets the board's refusal of a ballot it refuses, sending nothing", async () => {
    await l1.mineAt(plurality.opensAt + 60n);
    const refused = vectors.ballots.filter(
      (v) => v.election === "plurality" && !["ok", "option-proof", "sum-proof"].includes(v.result),
    );
    expect(refused.length).toBeGreaterThan(0);
    for (const v of refused.slice(0, 3)) {
      await register(v.election, v.registered);
      const before = await l1.nonce(voter);
      expect(await relayBallot(relayOptions(unhex(v.encoding))), v.id).toEqual({
        status: "refused",
        by: "board",
        refusal: { kind: "refused", code: v.result },
      });
      expect(await l1.nonce(voter), v.id).toBe(before);
    }
    expect(await relayCount()).toBe(0n);
  }, 60_000);

  it("forces an honest ballot: the call, the deposit with the client's limit, the board's event", async () => {
    const [v] = vectors.ballots;
    if (v === undefined) throw new Error("ballot.json has its ballots");
    await register("plurality", v.registered);
    await l1.mineAt(plurality.opensAt + 120n);
    const record = unhex(v.encoding);
    const before = await l1.nonce(voter);

    const result = await relayBallot(relayOptions(record));
    expect(result.status).toBe("relayed");
    if (result.status !== "relayed") return;
    const { call } = result;
    expect(await l1.nonce(voter)).toBe(before + 1n);
    expect(call.index).toBe(0n);
    expect(await relayCount()).toBe(1n);
    // The word the relay stored is the client's recomputed call hash.
    const stored = await l1.provider.request({
      method: "eth_call",
      params: [
        {
          to: hex(relay),
          data: hex(concatBytes(selector("callHash(uint64)"), word(call.index))),
        },
        "latest",
      ],
    });
    expect(stored).toBe(hex(call.callHash));
    const block = (await l1.provider.request({
      method: "eth_getBlockByHash",
      params: [hex(call.blockHash), false],
    })) as { number: string; timestamp: string };
    expect([BigInt(block.number), BigInt(block.timestamp)]).toEqual([call.l1Block, call.stamp]);

    // The portal got the board's canonical call with the client's limit.
    const deposit = await depositOf(0n);
    const data = relayDepositData(call.index, call.l1Block, call.stamp, call.gasLimit, record);
    expect(hex(deposit.to)).toBe(hex(board));
    expect([deposit.value, deposit.gasLimit, deposit.isCreation]).toEqual([0n, call.gasLimit, 0n]);
    expect(hex(deposit.data)).toBe(hex(data));
    expect(call.gasLimit).toBeGreaterThanOrEqual(portalMinimumGasLimit(data.length));

    const find = () =>
      findRelayedBallot({
        provider: l2.provider,
        chainId: L2_CHAIN,
        board,
        record,
        call,
        fromBlock,
      });
    expect(await find()).toBeUndefined();

    // The L2 includes the deposit: from the relay's alias, with exactly the
    // limit the client chose, which is enough for the board's check.
    const alias = hex(l2Alias(relay));
    await l2.provider.request({ method: "anvil_impersonateAccount", params: [alias] });
    await l2.provider.request({ method: "anvil_setBalance", params: [alias, "0xde0b6b3a7640000"] });
    const tx = await l2.provider.request({
      method: "eth_sendTransaction",
      params: [
        { from: alias, to: hex(board), data: hex(data), gas: `0x${call.gasLimit.toString(16)}` },
      ],
    });
    let receipt: { status: string; gasUsed: string } | null = null;
    while (receipt === null)
      receipt = (await l2.provider.request({
        method: "eth_getTransactionReceipt",
        params: [tx],
      })) as { status: string; gasUsed: string } | null;
    expect(receipt.status).toBe("0x1");
    expect(BigInt(receipt.gasUsed)).toBeLessThan(call.gasLimit);

    const location = await find();
    expect(location).toMatchObject({ path: "relayed", transactionHash: unhex(String(tx)) });
    if (location?.path !== "relayed") return;
    expect(location.call).toEqual({
      index: call.index,
      l1Block: call.l1Block,
      stamp: call.stamp,
      gasLimit: call.gasLimit,
    });

    // Asked again, the client finds the relayed copy and pays for nothing.
    expect(await relayBallot(relayOptions(record))).toEqual({
      status: "already-relayed",
      ...location,
    });
    expect(await l1.nonce(voter)).toBe(before + 1n);
    expect(await relayCount()).toBe(1n);
  }, 60_000);

  it("sends nothing once the L1 head is past close", async () => {
    const reproved = vectors.ballots.find((b) => b.id === "ok-reproved");
    if (reproved === undefined) throw new Error("ballot.json has ok-reproved");
    await register("plurality", reproved.registered);
    await l1.mineAt(plurality.closesAt + 1n);
    const before = await l1.nonce(voter);
    expect(await relayBallot(relayOptions(unhex(reproved.encoding)))).toEqual({
      status: "refused",
      by: "board",
      refusal: {
        kind: "window",
        timestamp: plurality.closesAt + 1n,
        opensAt: plurality.opensAt,
        closesAt: plurality.closesAt,
      },
    });
    expect(await l1.nonce(voter)).toBe(before);
  }, 60_000);

  it("refuses a relay deployed for another board", async () => {
    const other = await l1.deploy(
      "src/BallotRelay.sol:BallotRelay",
      concatBytes(
        ...[portal, new Uint8Array(20).fill(0x42)].map((a) => concatBytes(new Uint8Array(12), a)),
      ),
    );
    await expect(
      relayBallot({ ...relayOptions(unhex(vectors.ballots[0]?.encoding ?? "")), relay: other }),
    ).rejects.toMatchObject({ code: "wrong-relay" });
  }, 60_000);
});
