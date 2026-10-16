// The direct-submit client (P4-2): its calldata and revert decoding, its
// handling of a provider's answers, and a run against the real board
// contract on Anvil, built by forge from packages/contracts with the test
// suite's registry stubs set from ballot.json, so every vector ballot gets
// the board's own verdict through the client, an honest one lands with its
// event, and a repeat or a ballot outside the window sends nothing (T-25,
// T-17, T-35). Anvil's unlocked development accounts sign: no key is held
// here (AGENTS.md).

import { l2Alias, relayDepositData } from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  BALLOT_SUBMITTED_SIGNATURE,
  type BoardBallotRefusal,
  RELAYED_BALLOT_SUBMITTED_SIGNATURE,
  decodeBoardBallotRevert,
  directSubmitBallot,
  DirectSubmitError,
  type DirectSubmitOptions,
  type Eip1193Provider,
  revertDataOf,
  submitBallotCalldata,
} from "../src/index.ts";
import {
  type Anvil,
  boardRegistries,
  hex,
  pad32,
  parametersOf,
  selector,
  startAnvil,
  unhex,
  vectors,
  word,
} from "./anvil.ts";

const numRuns = Number(process.env.FC_NUM_RUNS ?? 100);

const BALLOT_SUBMITTED = keccak_256(new TextEncoder().encode(BALLOT_SUBMITTED_SIGNATURE));
const RELAYED_BALLOT_SUBMITTED = keccak_256(
  new TextEncoder().encode(RELAYED_BALLOT_SUBMITTED_SIGNATURE),
);

describe("submitBallotCalldata", () => {
  it("is the selector, offset 0x20, the length and the zero-padded record, nothing after", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (record) => {
        const c = submitBallotCalldata(record);
        expect(hex(c.subarray(0, 4))).toBe(hex(selector("submitBallot(bytes)")));
        expect(hex(c.subarray(4, 36))).toBe(hex(word(32n)));
        expect(hex(c.subarray(36, 68))).toBe(hex(word(BigInt(record.length))));
        expect(hex(c.subarray(68, 68 + record.length))).toBe(hex(record));
        expect(c.length).toBe(68 + pad32(record.length));
        expect(c.subarray(68 + record.length).every((b) => b === 0)).toBe(true);
      }),
      { numRuns },
    );
  });
});

const errorData = (signature: string, ...words: bigint[]) =>
  concatBytes(selector(signature), ...words.map(word));

describe("decodeBoardBallotRevert", () => {
  it("reads each code in the contracts' enum order", () => {
    const decode = [
      "truncated",
      "trailing-bytes",
      "length-over-max",
      "unknown-record-type",
      "unexpected-record-type",
      "unknown-version",
      "invalid-enum",
      "non-canonical",
      "profile-mismatch",
    ];
    for (const [i, code] of decode.entries())
      expect(
        decodeBoardBallotRevert(errorData("BallotMalformed(uint8,uint256)", BigInt(i), 108n)),
      ).toEqual({ kind: "malformed", code, offset: 108 });
    const admission = [
      "ballot-stray",
      "ballot-tier",
      "ballot-cell",
      "validity-shape",
      "share-hash-unqualified",
      "membership-proof",
    ];
    for (const [i, code] of admission.entries())
      expect(decodeBoardBallotRevert(errorData("BallotRefused(uint8)", BigInt(i)))).toEqual({
        kind: "refused",
        code,
      });
    expect(
      decodeBoardBallotRevert(errorData("BallotWindow(uint256,uint64,uint64)", 5n, 10n, 20n)),
    ).toEqual({ kind: "window", timestamp: 5n, opensAt: 10n, closesAt: 20n });
    expect(decodeBoardBallotRevert(selector("InsufficientGas()"))).toEqual({ kind: "gas" });
    expect(decodeBoardBallotRevert(selector("PrecompileFailed()"))).toEqual({ kind: "gas" });
    expect(decodeBoardBallotRevert(selector("NonCanonicalCalldata()"))).toEqual({
      kind: "calldata",
    });
  });

  it("calls anything else unknown: codes past the enum, wrong lengths, other errors", () => {
    const unknown = [
      errorData("BallotMalformed(uint8,uint256)", 9n, 0n),
      errorData("BallotMalformed(uint8,uint256)", 0n, 1n << 53n),
      errorData("BallotRefused(uint8)", 6n),
      errorData("BallotRefused(uint8)", 1n << 255n),
      concatBytes(errorData("BallotRefused(uint8)", 0n), new Uint8Array(1)),
      errorData("BallotRefused(uint8)", 0n).subarray(0, 35),
      errorData("BallotWindow(uint256,uint64,uint64)", 1n, 2n),
      errorData("BallotWindow(uint256,uint64,uint64)", 1n, 1n << 64n, 2n),
      errorData("BallotWindow(uint256,uint64,uint64)", 1n, 2n, 1n << 64n),
      concatBytes(selector("InsufficientGas()"), new Uint8Array(32)),
      errorData("Error(string)", 32n, 0n),
      new Uint8Array(),
    ];
    for (const data of unknown)
      expect(decodeBoardBallotRevert(data), hex(data)).toEqual({ kind: "unknown", data });
  });

  it("never throws on any bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 120 }), (data) => {
        expect(decodeBoardBallotRevert(data).kind).toBeTypeOf("string");
      }),
      { numRuns },
    );
  });
});

describe("revertDataOf", () => {
  it("finds the data where nodes and wallets put it, and nothing in other errors", () => {
    const data = "0x0102";
    expect(revertDataOf({ code: 3, data })).toEqual(new Uint8Array([1, 2]));
    expect(revertDataOf({ code: -32603, data: { data } })).toEqual(new Uint8Array([1, 2]));
    expect(revertDataOf({ error: { data } })).toEqual(new Uint8Array([1, 2]));
    expect(revertDataOf(new Error("x", { cause: { data } }))).toEqual(new Uint8Array([1, 2]));
    expect(revertDataOf({ code: 4001, message: "User rejected the request." })).toBeUndefined();
    expect(revertDataOf({ data: "0x123" })).toBeUndefined();
    expect(revertDataOf(new TypeError("fetch failed"))).toBeUndefined();
    const loop: { error?: unknown } = {};
    loop.error = loop;
    expect(revertDataOf(loop)).toBeUndefined();
  });
});

// A scripted provider: each method answers from `answers`, and every request
// is recorded, so a test sees what the client sent.
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

describe("directSubmitBallot against a scripted provider", () => {
  const board = new Uint8Array(20).fill(0xbb);
  const from = new Uint8Array(20).fill(0xaa);
  const [honest] = vectors.ballots;
  if (honest === undefined) throw new Error("ballot.json has its ballots");
  const record = unhex(honest.encoding);
  const definitionHash = unhex(vectors.elections.plurality?.definitionHash ?? "");
  const ballotHash = unhex(honest.ballotHash);
  const options = (provider: Eip1193Provider): DirectSubmitOptions => ({
    provider,
    chainId: 84532n,
    board,
    from,
    record,
    fromBlock: 7n,
    sleep: async () => {},
  });
  const txHash = `0x${"77".repeat(32)}`;
  const location = {
    transactionHash: unhex(txHash),
    blockNumber: 16n,
    blockHash: new Uint8Array(32).fill(0x88),
    logIndex: 2n,
  };
  const ordinaryData = concatBytes(
    word(32n),
    word(BigInt(record.length)),
    record,
    new Uint8Array(pad32(record.length) - record.length),
  );
  const relayedData = concatBytes(
    word(3n),
    word(100n),
    word(1_000n),
    word(900_000n),
    word(0xa0n),
    ordinaryData.subarray(32),
  );
  const log = (changes: Record<string, unknown> = {}) => ({
    address: hex(board),
    topics: [hex(BALLOT_SUBMITTED), hex(definitionHash), hex(ballotHash)],
    data: hex(ordinaryData),
    transactionHash: txHash,
    blockNumber: "0x10",
    blockHash: `0x${"88".repeat(32)}`,
    logIndex: "0x2",
    removed: false,
    ...changes,
  });
  const receipt = (logs: unknown[], status = "0x1") => ({ transactionHash: txHash, status, logs });
  // A board that accepts the record and holds `held`, and mines `mined`.
  const accepting = (held: unknown[], mined: unknown) =>
    scripted({
      eth_chainId: () => "0x14a34",
      eth_call: () => "0x",
      eth_getLogs: () => held,
      eth_estimateGas: () => "0x64",
      eth_sendTransaction: () => txHash,
      eth_getTransactionReceipt: () => mined,
    });

  it("refuses another chain before asking the board anything", async () => {
    const { provider, requests } = scripted({ eth_chainId: () => "0x1" });
    await expect(directSubmitBallot(options(provider))).rejects.toMatchObject({
      code: "wrong-chain",
    });
    expect(requests.map((r) => r.method)).toEqual(["eth_chainId"]);
  });

  it("asks without the account, sends on the election's chain, waits, then finds its event", async () => {
    let polls = 0;
    const { provider, requests } = scripted({
      eth_chainId: () => "0x14a34",
      eth_call: () => "0x",
      eth_getLogs: () => [],
      eth_estimateGas: () => "0x64",
      eth_sendTransaction: () => txHash,
      eth_getTransactionReceipt: () => (++polls < 3 ? null : receipt([log()])),
    });
    expect(await directSubmitBallot(options(provider))).toEqual({
      status: "submitted",
      path: "ordinary",
      ...location,
    });
    const data = hex(submitBallotCalldata(record));
    expect(requests.find((r) => r.method === "eth_call")?.params).toEqual([
      { to: hex(board), data },
      "latest",
    ]);
    // Both events, under the record's own hashes, from the caller's block.
    expect(requests.find((r) => r.method === "eth_getLogs")?.params).toEqual([
      {
        address: hex(board),
        fromBlock: "0x7",
        toBlock: "latest",
        topics: [
          [hex(BALLOT_SUBMITTED), hex(RELAYED_BALLOT_SUBMITTED)],
          hex(definitionHash),
          hex(ballotHash),
        ],
      },
    ]);
    // The estimate and a quarter more: the pairing needs its gas left.
    expect(requests.find((r) => r.method === "eth_sendTransaction")?.params[0]).toEqual({
      from: hex(from),
      to: hex(board),
      data,
      gas: "0x7d",
      chainId: "0x14a34",
    });
    expect(requests.filter((r) => r.method === "eth_chainId").length).toBe(2);
  });

  it("finds a copy on either path instead of sending", async () => {
    for (const [held, path] of [
      [log(), "ordinary"],
      [
        log({
          topics: [hex(RELAYED_BALLOT_SUBMITTED), hex(definitionHash), hex(ballotHash)],
          data: hex(relayedData),
        }),
        "relayed",
      ],
    ] as const) {
      const { provider, requests } = accepting([held], null);
      expect(await directSubmitBallot(options(provider)), path).toEqual({
        status: "already-on-board",
        path,
        ...(path === "relayed"
          ? { call: { index: 3n, l1Block: 100n, stamp: 1_000n, gasLimit: 900_000n } }
          : {}),
        ...location,
      });
      expect(requests.some((r) => r.method === "eth_sendTransaction")).toBe(false);
    }
  });

  it("takes no other log for the record's event", async () => {
    const other = (b: Uint8Array) => {
      const c = b.slice();
      c[c.length - 1] = (c[c.length - 1] ?? 0) ^ 1;
      return c;
    };
    const longer = concatBytes(record, new Uint8Array([1]));
    const notIt = [
      log({ address: hex(new Uint8Array(20).fill(0xcc)) }),
      log({
        topics: [hex(BALLOT_SUBMITTED), hex(definitionHash), hex(ballotHash), hex(ballotHash)],
      }),
      log({ topics: [hex(other(BALLOT_SUBMITTED)), hex(definitionHash), hex(ballotHash)] }),
      log({ topics: [hex(BALLOT_SUBMITTED), hex(other(definitionHash)), hex(ballotHash)] }),
      log({ data: hex(other(ordinaryData)) }),
      log({
        data: hex(
          concatBytes(
            word(32n),
            word(BigInt(longer.length)),
            longer,
            new Uint8Array(pad32(longer.length) - longer.length),
          ),
        ),
      }),
      log({ data: hex(concatBytes(ordinaryData, new Uint8Array(32))) }),
      log({ data: hex(concatBytes(word(64n), ordinaryData.subarray(32))) }),
      log({
        topics: [hex(RELAYED_BALLOT_SUBMITTED), hex(definitionHash), hex(ballotHash)],
        data: hex(ordinaryData),
      }),
      log({
        topics: [hex(RELAYED_BALLOT_SUBMITTED), hex(definitionHash), hex(ballotHash)],
        data: hex(concatBytes(word(1n << 64n), relayedData.subarray(32))),
      }),
      log({ removed: true }),
    ];
    for (const [i, held] of notIt.entries()) {
      // Neither held before sending nor emitted by the transaction.
      const { provider, requests } = accepting([held], receipt([held]));
      await expect(directSubmitBallot(options(provider)), String(i)).rejects.toMatchObject({
        code: "event-mismatch",
        message: `transaction ${txHash} succeeded with no event for the record`,
      });
      expect(requests.filter((r) => r.method === "eth_sendTransaction").length, String(i)).toBe(1);
    }
  });

  it("never calls a ballot submitted under another ballot hash", async () => {
    const wrong = log({
      topics: [hex(BALLOT_SUBMITTED), hex(definitionHash), hex(new Uint8Array(32))],
    });
    const { provider } = accepting([], receipt([wrong]));
    await expect(directSubmitBallot(options(provider))).rejects.toMatchObject({
      code: "event-mismatch",
    });
  });

  it("takes only its own transaction's receipt and logs", async () => {
    const { provider } = accepting([], {
      ...receipt([log()]),
      transactionHash: `0x${"66".repeat(32)}`,
    });
    await expect(directSubmitBallot(options(provider))).rejects.toMatchObject({
      code: "bad-response",
    });
    const foreign = log({ transactionHash: `0x${"66".repeat(32)}` });
    const second = accepting([], receipt([foreign]));
    await expect(directSubmitBallot(options(second.provider))).rejects.toMatchObject({
      code: "event-mismatch",
    });
  });

  it("finds the copy another call put first when its own call emitted nothing", async () => {
    let reads = 0;
    const { provider } = scripted({
      eth_chainId: () => "0x14a34",
      eth_call: () => "0x",
      eth_getLogs: () => (reads++ === 0 ? [] : [log({ transactionHash: `0x${"55".repeat(32)}` })]),
      eth_estimateGas: () => "0x64",
      eth_sendTransaction: () => txHash,
      eth_getTransactionReceipt: () => receipt([]),
    });
    expect(await directSubmitBallot(options(provider))).toEqual({
      status: "already-on-board",
      path: "ordinary",
      ...location,
      transactionHash: new Uint8Array(32).fill(0x55),
    });
  });

  it("gives up after its polls without a receipt", async () => {
    const { provider } = accepting([], null);
    await expect(directSubmitBallot({ ...options(provider), maxPolls: 4 })).rejects.toEqual(
      new DirectSubmitError("receipt-timeout", `transaction ${txHash} wasn't mined after 4 polls`),
    );
  });

  const windowShut = errorData("BallotWindow(uint256,uint64,uint64)", 30n, 10n, 20n);
  const reverting = () => {
    throw Object.assign(new Error("execution reverted"), { code: 3, data: hex(windowShut) });
  };
  const shut = { kind: "window", timestamp: 30n, opensAt: 10n, closesAt: 20n };

  it("reports a refusal at the estimate as the board's", async () => {
    const { provider, requests } = scripted({
      eth_chainId: () => "0x14a34",
      eth_call: () => "0x",
      eth_getLogs: () => [],
      eth_estimateGas: reverting,
    });
    expect(await directSubmitBallot(options(provider))).toEqual({
      status: "refused",
      refusal: shut,
    });
    expect(requests.some((r) => r.method === "eth_sendTransaction")).toBe(false);
  });

  it("reports a reverted transaction by the board's answer afterwards", async () => {
    // The window shut while the transaction waited.
    let calls = 0;
    const later = (afterwards: () => unknown, held: () => unknown[]) =>
      scripted({
        eth_chainId: () => "0x14a34",
        eth_call: () => (calls++ % 2 === 0 ? "0x" : afterwards()),
        eth_getLogs: held,
        eth_estimateGas: () => "0x64",
        eth_sendTransaction: () => txHash,
        eth_getTransactionReceipt: () => receipt([], "0x0"),
      });
    expect(await directSubmitBallot(options(later(reverting, () => []).provider))).toEqual({
      status: "refused",
      refusal: shut,
      transactionHash: unhex(txHash),
    });
    // Another call put the same bytes on first: the board now holds them.
    let reads = 0;
    const raced = later(
      () => "0x",
      () => (reads++ === 0 ? [] : [log()]),
    );
    expect(await directSubmitBallot(options(raced.provider))).toEqual({
      status: "already-on-board",
      path: "ordinary",
      ...location,
    });
    // The board accepts it again: the caller may send again.
    const again = later(
      () => "0x",
      () => [],
    );
    await expect(directSubmitBallot(options(again.provider))).rejects.toMatchObject({
      code: "reverted",
    });
  });

  it("passes on a provider's error that carries no revert", async () => {
    const rejected = { code: 4001, message: "User rejected the request." };
    const { provider } = scripted({
      eth_chainId: () => "0x14a34",
      eth_call: () => {
        throw rejected;
      },
    });
    await expect(directSubmitBallot(options(provider))).rejects.toBe(rejected);
  });

  it("calls the board's acceptance of a record it can't frame a bad response", async () => {
    const { provider } = accepting([], null);
    await expect(
      directSubmitBallot({ ...options(provider), record: record.subarray(0, 100) }),
    ).rejects.toMatchObject({ code: "bad-response" });
  });

  it("refuses answers no node gives", async () => {
    for (const mined of [
      { transactionHash: txHash, status: "0x1" },
      receipt([], "one"),
      "0x1",
      receipt([{ ...log(), removed: "no" }]),
    ]) {
      const { provider } = accepting([], mined);
      await expect(directSubmitBallot(options(provider))).rejects.toMatchObject({
        code: "bad-response",
      });
    }
  });
});

// --- the board on Anvil -------------------------------------------------------

const CHAIN_ID = 31_339n;

let chain: Anvil;
let provider: Eip1193Provider;
let voter: Uint8Array;
let board: Uint8Array;
let relay: Uint8Array;
let fromBlock: bigint;
let register: (election: string, registered: readonly number[]) => Promise<void>;
const plurality = parametersOf("plurality");

const send = (to: Uint8Array | undefined, data: Uint8Array, from?: string) =>
  chain.send(to, data, from);
const mineAt = (timestamp: bigint) => chain.mineAt(timestamp);
const nonce = () => chain.nonce(voter);

const submit = (record: Uint8Array) =>
  directSubmitBallot({
    provider,
    chainId: CHAIN_ID,
    board,
    from: voter,
    record,
    fromBlock,
    pollInterval: 10,
  });

beforeAll(async () => {
  // Genesis a day before the vector elections open, so the window can be
  // reached from both sides.
  chain = await startAnvil(CHAIN_ID, plurality.opensAt - 86_400n);
  ({ provider } = chain);
  voter = unhex(chain.accounts[4] as string);
  const elections = await chain.deploy("test/utils/BoardFixture.sol:ElectionsStub");
  const trustees = await chain.deploy("test/utils/BoardFixture.sol:TrusteesStub");
  register = boardRegistries(chain, elections, trustees, ["plurality", "approval"]);
  // Only the relay's alias may call the relayed path, so a test can act as
  // its deposit by impersonating that address.
  relay = new Uint8Array(20).fill(0x11);
  board = await chain.deploy(
    "src/Board.sol:Board",
    concatBytes(...[elections, trustees, relay].map((a) => concatBytes(new Uint8Array(12), a))),
  );
  fromBlock = BigInt(String(await provider.request({ method: "eth_blockNumber" })));
}, 120_000);

afterAll(async () => {
  await chain?.stop();
});

describe("directSubmitBallot against the board on Anvil", () => {
  it("sends nothing before the window opens", async () => {
    const [v] = vectors.ballots;
    if (v === undefined) throw new Error("ballot.json has its ballots");
    await register("plurality", v.registered);
    const at = plurality.opensAt - 60n;
    await mineAt(at);
    const before = await nonce();
    expect(await submit(unhex(v.encoding))).toEqual({
      status: "refused",
      refusal: {
        kind: "window",
        timestamp: at,
        opensAt: plurality.opensAt,
        closesAt: plurality.closesAt,
      },
    });
    expect(await nonce()).toBe(before);
  }, 60_000);

  it("gets the board's verdict on every ballot.json ballot, sending nothing it refuses", async () => {
    await mineAt(plurality.opensAt);
    for (const v of vectors.ballots) {
      await register(v.election, v.registered);
      const before = await nonce();
      const accepted = ["ok", "option-proof", "sum-proof"].includes(v.result);
      // Probed by eth_call alone, so the ballots the board accepts stay
      // unsent for the tests below; the client's own path is theirs.
      let refusal: BoardBallotRefusal | undefined;
      try {
        await provider.request({
          method: "eth_call",
          params: [
            {
              from: hex(voter),
              to: hex(board),
              data: hex(submitBallotCalldata(unhex(v.encoding))),
            },
            "latest",
          ],
        });
      } catch (e) {
        const data = revertDataOf(e);
        if (data === undefined) throw e;
        refusal = decodeBoardBallotRevert(data);
      }
      if (accepted) {
        expect(refusal, v.id).toBeUndefined();
        continue;
      }
      expect(refusal, v.id).toEqual({ kind: "refused", code: v.result });
      expect(await submit(unhex(v.encoding)), v.id).toEqual({
        status: "refused",
        refusal: { kind: "refused", code: v.result },
      });
      expect(await nonce(), v.id).toBe(before);
    }
  }, 120_000);

  it("reads the board's decode errors with their offsets", async () => {
    await register("plurality", [1, 2]);
    for (const v of vectors.decode) {
      const result = await submit(unhex(v.encoding));
      expect(result.status, v.id).toBe("refused");
      if (result.status !== "refused") continue;
      // The board knows every type versioning.md lists, so the file's
      // share-receipt type, unknown to a ballot decoder, is one it doesn't
      // expect here (contracts.md, Board, Ballots, step 1).
      const code = v.id === "other-type" ? "unexpected-record-type" : v.error;
      expect(result.refusal, v.id).toMatchObject({ kind: "malformed", code });
      if (v.offset !== undefined) expect(result.refusal, v.id).toMatchObject({ offset: v.offset });
    }
  }, 60_000);

  it("is refused for calldata other than the canonical encoding", async () => {
    const record = unhex(vectors.ballots[0]?.encoding ?? "");
    const canonical = submitBallotCalldata(record);
    const variants = [
      concatBytes(canonical, new Uint8Array(1)),
      concatBytes(canonical, new Uint8Array(32)),
      canonical.subarray(0, canonical.length - 1),
      (() => {
        const c = canonical.slice();
        c[c.length - 1] = 1; // dirty padding: the record isn't a whole number of words
        return c;
      })(),
      concatBytes(selector("submitBallot(bytes)"), word(64n), word(0n), canonical.subarray(36)),
    ];
    expect(record.length % 32).not.toBe(0);
    for (const data of variants) {
      const error = await provider
        .request({ method: "eth_call", params: [{ to: hex(board), data: hex(data) }, "latest"] })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      const revert = revertDataOf(error);
      expect(revert && decodeBoardBallotRevert(revert), hex(data.subarray(-40))).toEqual({
        kind: "calldata",
      });
    }
  });

  it("puts an honest ballot on the board in the window, and finds it rather than resending", async () => {
    const [v, reproved] = vectors.ballots;
    if (v === undefined || reproved === undefined) throw new Error("ballot.json has its ballots");
    expect([v.id, reproved.id]).toEqual(["ok-tier-0", "ok-reproved"]);
    await register("plurality", v.registered);
    const record = unhex(v.encoding);
    const before = await nonce();

    const result = await submit(record);
    expect(result.status).toBe("submitted");
    if (result.status !== "submitted") return;
    expect(await nonce()).toBe(before + 1n);
    const logs = (await provider.request({
      method: "eth_getLogs",
      params: [
        {
          address: hex(board),
          fromBlock: "0x0",
          toBlock: "latest",
          topics: [hex(BALLOT_SUBMITTED)],
        },
      ],
    })) as { transactionHash: string; logIndex: string; topics: string[] }[];
    expect(logs.length).toBe(1);
    expect(logs[0]?.transactionHash).toBe(hex(result.transactionHash));
    expect(BigInt(logs[0]?.logIndex ?? -1)).toBe(result.logIndex);
    expect(logs[0]?.topics).toEqual([
      hex(BALLOT_SUBMITTED),
      hex(plurality.hash),
      v.ballotHash.startsWith("0x") ? v.ballotHash : `0x${v.ballotHash}`,
    ]);

    // The same bytes again: found on the board, nothing sent (Calls, Repeats).
    const { status: _submitted, ...location } = result;
    expect(await submit(record)).toEqual({ status: "already-on-board", ...location });
    expect(await nonce()).toBe(before + 1n);

    // A ballot forced through L1 reaches the board as the relay's deposit,
    // which emits RelayedBallotSubmitted and makes an ordinary copy a no-op:
    // found as such, not sent (Relayed ballots).
    const revote = vectors.ballots.find((b) => b.id === "ok-revote");
    if (revote === undefined) throw new Error("ballot.json has ok-revote");
    const alias = hex(l2Alias(relay));
    await provider.request({ method: "anvil_impersonateAccount", params: [alias] });
    await provider.request({ method: "anvil_setBalance", params: [alias, "0xde0b6b3a7640000"] });
    // Mined before the client asks, so the board already holds the bytes.
    const deposit = await send(
      board,
      relayDepositData(0n, 1n, plurality.opensAt, 3_000_000n, unhex(revote.encoding)),
      alias,
    );
    const relayed = await submit(unhex(revote.encoding));
    expect(relayed).toMatchObject({
      status: "already-on-board",
      path: "relayed",
      call: { index: 0n, l1Block: 1n, stamp: plurality.opensAt, gasLimit: 3_000_000n },
    });
    if (relayed.status !== "already-on-board") return;
    expect(hex(relayed.transactionHash)).toBe(deposit.transactionHash);
    expect(await nonce()).toBe(before + 1n);

    // After close: a new ballot is outside the window and isn't sent; the
    // one already held is still found (docs/spec/close.md, Window).
    await mineAt(plurality.closesAt + 1n);
    expect(await submit(unhex(reproved.encoding))).toEqual({
      status: "refused",
      refusal: {
        kind: "window",
        timestamp: plurality.closesAt + 1n,
        opensAt: plurality.opensAt,
        closesAt: plurality.closesAt,
      },
    });
    expect(await submit(record)).toEqual({ status: "already-on-board", ...location });
    expect(await nonce()).toBe(before + 1n);
  }, 60_000);
});
