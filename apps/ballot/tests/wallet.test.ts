// A posting from the voter's own wallet (src/wallet.ts;
// docs/spec/posting-relay.md, Own wallet): the wallet is asked only on the
// release's L2, names it in the transaction, is asked for an estimate before
// it sends, and the client stands down only on the board's event at the
// finalized head, never sending a posting the latest head already shows,
// nor anything past `c_D` (T-13, T-18, T-25, T-34).

import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import type { LoadedDeposits, LoadedPostings } from "../src/load.ts";
import { POSTING_FORCE_AFTER, POSTING_GAS_LIMIT_MAX, POSTING_POLL_MS } from "../src/posting.ts";
import {
  depositCalldata,
  depositGas,
  type Eip1193,
  injectedWallet,
  postFromWallet,
  WALLET_DEPOSIT_SPAN,
  WALLET_FORCE_MARGIN,
  WALLET_HOLD_MARGIN,
  WALLET_WAIT,
  type WalletAnswer,
  type WalletIo,
  WalletRefusal,
  WalletSession,
} from "../src/wallet.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const CHAIN = 84_532n;
const L1 = 11_155_111n;
const BOARD = { address: `0x${"b0".repeat(20)}`, portal: `0x${"9a".repeat(20)}` };
const ACCOUNT = `0x${"Ac".repeat(20)}`;
const TX = `0x${"ab".repeat(32)}`;
const CALL = Uint8Array.of(0x4b, 0x6f, 0xf1, 0xd0, 0x01);

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A rejection with EIP-1193's code for a request the user refused. */
const rejection = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
/** A node's revert, its data where wallets put it. */
const revert = () =>
  Object.assign(new Error("execution reverted"), { code: -32000, data: { data: "0xdeadbeef" } });

/** A wallet answering each method by `answers`, recording every request. */
function wallet(
  answers: Partial<Record<string, (params: readonly unknown[] | undefined) => unknown>>,
) {
  const calls: { method: string; params: readonly unknown[] | undefined }[] = [];
  const provider: Eip1193 = {
    request({ method, params }) {
      calls.push({ method, params });
      const answer = answers[method];
      if (answer === undefined) return Promise.reject(new Error(`no ${method}`));
      try {
        const value = answer(params);
        return value instanceof Promise ? value : Promise.resolve(value);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  return { provider, calls, methods: () => calls.map(({ method }) => method) };
}

const honest = (chain = CHAIN) => ({
  eth_requestAccounts: () => [ACCOUNT],
  eth_chainId: () => `0x${chain.toString(16)}`,
  eth_estimateGas: () => "0x186a0",
  eth_sendTransaction: () => TX,
});

describe("injectedWallet", () => {
  test("is the browser's provider where it has a request method, and nothing else", async () => {
    expect(injectedWallet({})).toBeUndefined();
    expect(injectedWallet({ ethereum: null })).toBeUndefined();
    expect(injectedWallet({ ethereum: "0x" })).toBeUndefined();
    expect(injectedWallet({ ethereum: { request: "eth_chainId" } })).toBeUndefined();
    const ethereum = {
      chain: "0x1",
      request(this: { chain: string }, { method }: { method: string }) {
        // Called on the provider itself, as wallets that read `this` need.
        return method === "eth_chainId" ? this.chain : undefined;
      },
    };
    const found = injectedWallet({ ethereum });
    expect(await found?.request({ method: "eth_chainId" })).toBe("0x1");
  });

  test("turns a provider that throws into a rejection", async () => {
    const found = injectedWallet({
      ethereum: {
        request() {
          throw rejection();
        },
      },
    });
    await expect(found?.request({ method: "eth_chainId" })).rejects.toMatchObject({ code: 4001 });
  });
});

describe("WalletSession.send", () => {
  test("asks for the account, checks the chain, estimates, then sends to the board with the chain named", async () => {
    const { provider, calls, methods } = wallet(honest());
    const session = new WalletSession(provider, CHAIN, BOARD, L1);
    // A quarter over the estimate of 100,000, which a deposit gives it too.
    expect(await session.send(CALL)).toEqual({ sent: "sent", gas: 125_000n });
    expect(methods()).toEqual([
      "eth_requestAccounts",
      "eth_chainId",
      "eth_estimateGas",
      "eth_sendTransaction",
    ]);
    const tx = {
      from: ACCOUNT.toLowerCase(),
      to: BOARD.address,
      data: "0x4b6ff1d001",
      value: "0x0",
    };
    expect(calls[2]?.params).toEqual([tx]);
    // A quarter over the estimate of 100,000, and the chain named (T-34).
    expect(calls[3]?.params).toEqual([{ ...tx, gas: "0x1e848", chainId: "0x14a34" }]);
  });

  test("asks for the account once a run, and checks the chain before every send", async () => {
    const { provider, methods } = wallet(honest());
    const session = new WalletSession(provider, CHAIN, BOARD, L1);
    await session.send(CALL);
    await session.send(CALL);
    expect(methods().filter((m) => m === "eth_requestAccounts")).toHaveLength(1);
    expect(methods().filter((m) => m === "eth_chainId")).toHaveLength(2);
  });

  test("asks a wallet on another chain to switch once, and sends nothing if it stays there", async () => {
    const { provider, calls, methods } = wallet({
      ...honest(1n),
      wallet_switchEthereumChain: () => null,
    });
    const session = new WalletSession(provider, CHAIN, BOARD, L1);
    await expect(session.send(CALL)).rejects.toMatchObject({ answer: "wrong-chain" });
    expect(calls.find((c) => c.method === "wallet_switchEthereumChain")?.params).toEqual([
      { chainId: "0x14a34" },
    ]);
    expect(methods()).not.toContain("eth_estimateGas");
    expect(methods()).not.toContain("eth_sendTransaction");
  });

  test("sends once the wallet switched, and reads a switch it can't make as the wrong chain", async () => {
    let chain = 1n;
    const switching = wallet({
      ...honest(),
      eth_chainId: () => `0x${chain.toString(16)}`,
      wallet_switchEthereumChain: () => {
        chain = CHAIN;
        return null;
      },
    });
    expect(await new WalletSession(switching.provider, CHAIN, BOARD, L1).send(CALL)).toMatchObject({
      sent: "sent",
    });
    const unknown = wallet({
      ...honest(1n),
      wallet_switchEthereumChain: () => {
        throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
      },
    });
    await expect(
      new WalletSession(unknown.provider, CHAIN, BOARD, L1).send(CALL),
    ).rejects.toMatchObject({ answer: "wrong-chain" });
    const declined = wallet({
      ...honest(1n),
      wallet_switchEthereumChain: () => {
        throw rejection();
      },
    });
    await expect(
      new WalletSession(declined.provider, CHAIN, BOARD, L1).send(CALL),
    ).rejects.toMatchObject({ answer: "rejected" });
  });

  test("reads a request the voter refused as rejected, wherever it comes", async () => {
    for (const method of ["eth_requestAccounts", "eth_estimateGas", "eth_sendTransaction"]) {
      const { provider } = wallet({
        ...honest(),
        [method]: () => {
          throw rejection();
        },
      });
      await expect(new WalletSession(provider, CHAIN, BOARD, L1).send(CALL)).rejects.toMatchObject({
        answer: "rejected",
      });
    }
  });

  test("sends nothing the board refuses at the estimate, and tells a revert from a failure", async () => {
    const refused = wallet({
      ...honest(),
      eth_estimateGas: () => {
        throw revert();
      },
    });
    await expect(
      new WalletSession(refused.provider, CHAIN, BOARD, L1).send(CALL),
    ).rejects.toMatchObject({ answer: "refused" });
    expect(refused.methods()).not.toContain("eth_sendTransaction");
    const down = wallet({
      ...honest(),
      eth_estimateGas: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(
      new WalletSession(down.provider, CHAIN, BOARD, L1).send(CALL),
    ).rejects.toMatchObject({
      answer: "failed",
    });
  });

  test("reads a revert at the send as failed, never refused, since it may follow a broadcast", async () => {
    const { provider } = wallet({
      ...honest(),
      eth_sendTransaction: () => {
        throw revert();
      },
    });
    await expect(new WalletSession(provider, CHAIN, BOARD, L1).send(CALL)).rejects.toMatchObject({
      answer: "failed",
    });
  });

  test("checks the cutoff again before the estimate, the first request to carry the parts", async () => {
    let late = false;
    const { provider, methods } = wallet({
      ...honest(),
      // The voter took their time over the account.
      eth_requestAccounts: () => {
        late = true;
        return [ACCOUNT];
      },
    });
    await expect(
      new WalletSession(provider, CHAIN, BOARD, L1).send(CALL, () => late),
    ).rejects.toMatchObject({ answer: "late" });
    expect(methods()).not.toContain("eth_estimateGas");
    expect(methods()).not.toContain("eth_sendTransaction");
  });

  test("reads answers no wallet gives as failed, and sends nothing on them", async () => {
    const cases: [string, unknown][] = [
      ["eth_requestAccounts", []],
      ["eth_requestAccounts", ["0x1234"]],
      ["eth_requestAccounts", "0x" + "ac".repeat(20)],
      ["eth_chainId", 84_532],
      ["eth_chainId", "0x014a34"],
      ["eth_estimateGas", "100000"],
      ["eth_estimateGas", null],
    ];
    for (const [method, value] of cases) {
      const { provider, methods } = wallet({ ...honest(), [method]: () => value });
      await expect(
        new WalletSession(provider, CHAIN, BOARD, L1).send(CALL),
        `${method} ${JSON.stringify(value)}`,
      ).rejects.toMatchObject({ answer: "failed" });
      expect(methods()).not.toContain("eth_sendTransaction");
    }
  });

  test("counts a send the wallet never answers, or answers oddly, as possibly sent", async () => {
    const held = wallet({ ...honest(), eth_sendTransaction: () => new Promise(() => {}) });
    expect(await new WalletSession(held.provider, CHAIN, BOARD, L1, 20).send(CALL)).toMatchObject({
      sent: "unknown",
    });
    const odd = wallet({ ...honest(), eth_sendTransaction: () => "0x1234" });
    expect(await new WalletSession(odd.provider, CHAIN, BOARD, L1).send(CALL)).toMatchObject({
      sent: "unknown",
    });
  });

  test("gives up on any other request the wallet never answers, having sent nothing", async () => {
    for (const method of ["eth_requestAccounts", "eth_chainId", "eth_estimateGas"]) {
      const { provider, methods } = wallet({ ...honest(), [method]: () => new Promise(() => {}) });
      await expect(
        new WalletSession(provider, CHAIN, BOARD, L1, 20).send(CALL),
      ).rejects.toMatchObject({
        answer: "failed",
      });
      expect(methods()).not.toContain("eth_sendTransaction");
    }
  });
});

describe("depositCalldata", () => {
  const selector = keccak_256(
    new TextEncoder().encode("depositTransaction(address,uint256,uint64,bool,bytes)"),
  ).slice(0, 4);
  const word = (n: bigint) => n.toString(16).padStart(64, "0");

  test("is depositTransaction(board, 0, gasLimit, false, call) in the ABI's canonical form", () => {
    const data = depositCalldata(BOARD.address, 125_000n, CALL);
    expect(hex(data)).toBe(
      hex(selector) +
        `${"0".repeat(24)}${"b0".repeat(20)}` +
        word(0n) +
        word(125_000n) +
        word(0n) +
        word(160n) +
        word(5n) +
        `4b6ff1d001${"0".repeat(54)}`,
    );
  });

  test("carries any call and gas limit whole, and nothing after the call's last word", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 300 }),
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        (call, gas) => {
          const data = depositCalldata(BOARD.address, gas, call);
          const view = new DataView(data.buffer);
          expect(data.subarray(0, 4)).toEqual(selector);
          expect(view.getBigUint64(4 + 64 + 24)).toBe(gas);
          expect(view.getUint32(4 + 128 + 28)).toBe(160);
          expect(view.getUint32(4 + 160 + 28)).toBe(call.length);
          expect(data.subarray(196, 196 + call.length)).toEqual(call);
          expect(data.length).toBe(196 + Math.ceil(call.length / 32) * 32);
          expect(data.subarray(196 + call.length).every((b) => b === 0)).toBe(true);
        },
      ),
      { numRuns },
    );
  });

  test("refuses an address that isn't the board's form, or a gas limit past uint64", () => {
    expect(() => depositCalldata(`0x${"B0".repeat(20)}`, 1n, CALL)).toThrow(RangeError);
    expect(() => depositCalldata(`0x${"b0".repeat(19)}`, 1n, CALL)).toThrow(RangeError);
    expect(() => depositCalldata(BOARD.address, 1n << 64n, CALL)).toThrow(RangeError);
    expect(() => depositCalldata(BOARD.address, -1n, CALL)).toThrow(RangeError);
  });
});

describe("depositGas", () => {
  test("keeps the send's gas between the portal's minimum and POSTING_GAS_LIMIT_MAX", () => {
    const call = new Uint8Array(1_000);
    expect(depositGas(125_000n, call)).toBe(125_000n);
    // Below the portal's minimum for 1,000 bytes the deposit would revert on L1.
    expect(depositGas(30_000n, call)).toBe(61_000n);
    // An inflated estimate can't price the deposit past the portal's caps (T-50).
    expect(depositGas(50_000_000n, call)).toBe(POSTING_GAS_LIMIT_MAX);
  });
});

describe("WalletSession.deposit", () => {
  /** A wallet on `start` that switches to whichever chain it is asked for. */
  function switching(start: bigint, extra: Parameters<typeof wallet>[0] = {}) {
    let chain = start;
    return wallet({
      ...honest(),
      eth_chainId: () => `0x${chain.toString(16)}`,
      wallet_switchEthereumChain: (params) => {
        const [asked] = params as [{ chainId: string }];
        chain = BigInt(asked.chainId);
        return null;
      },
      ...extra,
    });
  }

  test("deposits the call on L1 through the pinned portal, the chain switched and named", async () => {
    const { provider, calls, methods } = switching(CHAIN);
    const session = new WalletSession(provider, CHAIN, BOARD, L1);
    const { gas } = await session.send(CALL);
    expect(await session.deposit(CALL, gas)).toEqual({ sent: "sent", gas: 125_000n });
    expect(methods().slice(4)).toEqual([
      "eth_chainId",
      "wallet_switchEthereumChain",
      "eth_chainId",
      "eth_estimateGas",
      "eth_sendTransaction",
    ]);
    expect(calls[5]?.params).toEqual([{ chainId: "0xaa36a7" }]);
    const tx = {
      from: ACCOUNT.toLowerCase(),
      to: BOARD.portal,
      data: `0x${hex(depositCalldata(BOARD.address, 125_000n, CALL))}`,
      value: "0x0",
    };
    expect(calls[7]?.params).toEqual([tx]);
    // The L1 estimate a quarter over, and L1 named, so a wallet that moved
    // back to L2 refuses it rather than sending it to the board there.
    expect(calls[8]?.params).toEqual([{ ...tx, gas: "0x1e848", chainId: "0xaa36a7" }]);
  });

  test("deposits nothing from a wallet that won't go to L1, nor what the portal refuses", async () => {
    const stuck = wallet({ ...honest(), wallet_switchEthereumChain: () => null });
    await expect(
      new WalletSession(stuck.provider, CHAIN, BOARD, L1).deposit(CALL, 1n),
    ).rejects.toMatchObject({ answer: "wrong-chain" });
    expect(stuck.methods()).not.toContain("eth_sendTransaction");
    const refused = switching(CHAIN, {
      eth_estimateGas: () => {
        throw revert();
      },
    });
    await expect(
      new WalletSession(refused.provider, CHAIN, BOARD, L1).deposit(CALL, 1n),
    ).rejects.toMatchObject({ answer: "refused" });
    expect(refused.methods()).not.toContain("eth_sendTransaction");
  });

  test("checks the deposit's cutoff again before the estimate, the first L1 request to carry the parts", async () => {
    const { provider, methods } = switching(L1);
    await expect(
      new WalletSession(provider, CHAIN, BOARD, L1).deposit(CALL, 1n, () => true),
    ).rejects.toMatchObject({ answer: "late" });
    expect(methods()).not.toContain("eth_estimateGas");
  });

  test("counts a deposit the wallet never answers as possibly sent", async () => {
    const held = switching(L1, { eth_sendTransaction: () => new Promise(() => {}) });
    expect(
      await new WalletSession(held.provider, CHAIN, BOARD, L1, 20).deposit(CALL, 1n),
    ).toMatchObject({ sent: "unknown" });
  });
});

describe("postFromWallet", () => {
  const START = 1_800_000_000n;
  const CUTOFF = START + 100_000n;
  const A = Uint8Array.of(0, 13, 1, 0xaa);
  const B = Uint8Array.of(0, 13, 1, 0xbb);
  const POLL = BigInt(POSTING_POLL_MS / 1000);

  /**
   * A wallet and a board on a clock that moves only by the run's sleeps:
   * `finalized`, `safe` and `latest` say which records each head carries at
   * each time (seconds from `START`), `answer` what each send meets and
   * `deposited` each deposit, and `landed` the L1 time of each posting's
   * qualifying deposit the L1 read finds, given the deposits made.
   */
  function world({
    finalized = () => [],
    // By default the sequencer takes what the wallet sends: nothing is forced.
    safe = (_, sent) => sent,
    latest = () => [],
    answer = () => "sent",
    deposited = () => "sent",
    landed = (p, deposits) => {
      const made = deposits.find(({ call }) => call === p);
      return made === undefined ? undefined : START + made.at + 12n;
    },
    chainAhead = 0n,
    readFails = false,
    depositTakes = 0,
  }: {
    finalized?: (t: bigint, sent: readonly Uint8Array[]) => readonly Uint8Array[];
    safe?: (t: bigint, sent: readonly Uint8Array[]) => readonly Uint8Array[];
    latest?: (t: bigint, sent: readonly Uint8Array[]) => readonly Uint8Array[];
    answer?: (call: Uint8Array, n: number) => "sent" | "unknown" | Error;
    deposited?: (call: Uint8Array, n: number) => "sent" | "unknown" | Error;
    landed?: (
      posting: Uint8Array,
      deposits: readonly { call: Uint8Array; at: bigint }[],
    ) => bigint | undefined;
    chainAhead?: bigint;
    readFails?: boolean;
    /** Milliseconds a deposit's switch to L1 takes, before its cutoff is checked again. */
    depositTakes?: number;
  }) {
    let ms = Number(START) * 1000;
    const t = () => BigInt(Math.floor(ms / 1000));
    const sends: { call: Uint8Array; at: bigint }[] = [];
    const deposits: { call: Uint8Array; gas: bigint; at: bigint }[] = [];
    const reads: { head: string; from: bigint | undefined }[] = [];
    const l1Reads: { since: bigint; at: bigint }[] = [];
    // Each call is its posting's bytes, so a test can tell which was sent.
    const sent = () => sends.map(({ call }) => call);
    const met = (m: "sent" | "unknown" | Error, gas: bigint) =>
      m instanceof Error ? Promise.reject(m) : Promise.resolve({ sent: m, gas });
    const io: WalletIo = {
      send(call, late) {
        // The wallet's own check before its estimate, as `WalletSession` makes it.
        if (late()) return Promise.reject(new WalletRefusal("late"));
        sends.push({ call, at: t() - START });
        return met(answer(call, sends.length - 1), 1_000n + BigInt(sends.length));
      },
      deposit(call, gas, late) {
        ms += depositTakes;
        if (late()) return Promise.reject(new WalletRefusal("late"));
        deposits.push({ call, gas, at: t() - START });
        return met(deposited(call, deposits.length - 1), gas);
      },
      find(head, from): Promise<LoadedPostings> {
        reads.push({ head, from });
        if (readFails) return Promise.resolve({ ok: false, problem: "unreachable" });
        const heads = { finalized, safe, latest };
        const records = heads[head](t() - START, sent());
        return Promise.resolve({ ok: true, block: t(), timestamp: t() + chainAhead, records });
      },
      deposits(since): Promise<LoadedDeposits> {
        l1Reads.push({ since, at: t() - START });
        if (readFails) return Promise.resolve({ ok: false, problem: "unreachable" });
        return Promise.resolve({
          ok: true,
          timestamp: t(),
          landed: postings.map((p) => landed(p, deposits)),
        });
      },
      now: () => ms,
      sleep(wait) {
        ms += wait;
        return Promise.resolve();
      },
    };
    let postings: readonly Uint8Array[] = [];
    const run = (ps: readonly Uint8Array[], cutoff: bigint) => {
      postings = ps;
      return postFromWallet(io, ps, ps, cutoff);
    };
    return { io, run, sends, deposits, reads, l1Reads, elapsed: () => t() - START };
  }

  const refusal = (answer: string) =>
    new WalletRefusal(answer as Exclude<WalletAnswer, "recorded" | "forced" | "sent">);

  test("recorded once the finalized head carries every posting, each sent once", async () => {
    const w = world({
      // Each sent posting is final two rounds later.
      finalized: (t, sent) => (t >= 2n * POLL ? sent : []),
    });
    expect(await w.run([A, B], CUTOFF)).toBe("recorded");
    expect(w.sends.map(({ call }) => call)).toEqual([A, B]);
    // The finalized head is read on from where the last read ended.
    expect(w.reads.filter(({ head }) => head === "finalized").map(({ from }) => from)).toEqual([
      undefined,
      START + 1n,
      START + POLL + 1n,
    ]);
  });

  test("sends nothing for a posting the finalized head already carries", async () => {
    const w = world({ finalized: () => [A, B] });
    expect(await w.run([A, B], CUTOFF)).toBe("recorded");
    expect(w.sends).toEqual([]);
  });

  test("waits on a posting the latest head shows rather than paying for it beside the relay's (T-13)", async () => {
    const w = world({
      latest: () => [A],
      finalized: (t) => (t >= 5n * POLL ? [A] : []),
    });
    expect(await w.run([A], CUTOFF)).toBe("recorded");
    expect(w.sends).toEqual([]);
  });

  test("lets a sighting near the cutoff delay the wallet's send, never cancel it (T-25)", async () => {
    // The untrusted endpoint shows it at the latest head and never finalizes it.
    const w = world({ latest: () => [A] });
    const cutoff = START + WALLET_FORCE_MARGIN + 3n * POLL;
    expect(await w.run([A], cutoff)).toBe("sent");
    expect(w.sends).toHaveLength(1);
    expect(START + (w.sends[0]?.at ?? 0n)).toBeLessThanOrEqual(cutoff - WALLET_FORCE_MARGIN + POLL);
  });

  test("lets a sighting the sequencer never batches delay the wallet's send, never its forcing (T-50)", async () => {
    // A censoring sequencer: shown at the latest head, never at the safe head.
    const w = world({ latest: () => [A], safe: () => [] });
    const cutoff = START + WALLET_FORCE_MARGIN + 3n * POLL;
    expect(await w.run([A], cutoff)).toBe("forced");
    expect(w.deposits).toHaveLength(1);
    expect(START + (w.deposits[0]?.at ?? 0n) + WALLET_DEPOSIT_SPAN).toBeLessThanOrEqual(cutoff);
  });

  test("forces through L1, once and with its send's gas, a posting the safe head doesn't show after POSTING_FORCE_AFTER", async () => {
    const w = world({ safe: () => [] });
    expect(await w.run([A], CUTOFF)).toBe("forced");
    expect(w.deposits).toEqual([
      { call: A, gas: 1_001n, at: expect.any(BigInt) as unknown as bigint },
    ]);
    const at = w.deposits[0]?.at ?? 0n;
    expect(at).toBeGreaterThanOrEqual(POSTING_FORCE_AFTER);
    expect(at).toBeLessThan(POSTING_FORCE_AFTER + POLL);
    // The deposit's wait runs out before the run ends, and L1 is read once,
    // from the run's start.
    expect(w.elapsed()).toBeGreaterThanOrEqual(at + WALLET_WAIT);
    expect(w.l1Reads).toEqual([{ since: START, at: w.elapsed() }]);
  });

  test("forces a posting the latest head shows but the safe head doesn't: a soft confirmation isn't inclusion (T-50)", async () => {
    const w = world({ latest: (_, sent) => sent, safe: () => [] });
    expect(await w.run([A], CUTOFF)).toBe("forced");
    expect(w.deposits).toHaveLength(1);
  });

  test("forces nothing the safe head shows, and only what the safe head doesn't", async () => {
    const w = world({ safe: (_, sent) => sent.filter((p) => p === A) });
    expect(await w.run([A, B], CUTOFF)).toBe("forced");
    expect(w.deposits.map(({ call }) => call)).toEqual([B]);
  });

  test("is recorded once a forced posting's record is final", async () => {
    const w = world({
      safe: () => [],
      finalized: (t) => (t >= POSTING_FORCE_AFTER + 3n * POLL ? [A] : []),
    });
    expect(await w.run([A], CUTOFF)).toBe("recorded");
    expect(w.deposits).toHaveLength(1);
    expect(w.l1Reads).toEqual([]);
  });

  test("answers sent, not forced, unless L1 shows a qualifying deposit by the cutoff", async () => {
    const none = world({ safe: () => [], landed: () => undefined });
    expect(await none.run([A], CUTOFF)).toBe("sent");
    const late = world({ safe: () => [], landed: () => CUTOFF + 1n });
    expect(await late.run([A], CUTOFF)).toBe("sent");
    const unreadable = world({ safe: () => [] });
    unreadable.io.deposits = () => Promise.reject(new Error("l1 down"));
    expect(await unreadable.run([A], CUTOFF)).toBe("sent");
    // A deposit the wallet may still make counts only once L1 shows it.
    const unknown = world({ safe: () => [], deposited: () => "unknown" });
    expect(await unknown.run([A], CUTOFF)).toBe("forced");
  });

  test("asks for no deposit once the cutoff is within WALLET_DEPOSIT_SPAN", async () => {
    const tight = world({ safe: () => [] });
    const cutoff = START + POSTING_FORCE_AFTER + WALLET_DEPOSIT_SPAN - 1n;
    expect(await tight.run([A], cutoff)).toBe("sent");
    expect(tight.deposits).toEqual([]);
    const room = world({ safe: () => [] });
    const roomy = START + POSTING_FORCE_AFTER + WALLET_DEPOSIT_SPAN + POLL;
    expect(await room.run([A], roomy)).toBe("forced");
    expect(START + (room.deposits[0]?.at ?? 0n) + WALLET_DEPOSIT_SPAN).toBeLessThanOrEqual(roomy);
  });

  test("checks the deposit's cutoff again once the wallet is on L1", async () => {
    // Forceable when the deposit is asked for, past its cutoff after the switch.
    const cutoff = START + POSTING_FORCE_AFTER + WALLET_DEPOSIT_SPAN + POLL;
    const slow = world({ safe: () => [], depositTakes: 2 * Number(POLL) * 1000 });
    expect(await slow.run([A], cutoff)).toBe("sent");
    expect(slow.deposits).toEqual([]);
  });

  test("ends the forcing, never the run, on a deposit the wallet doesn't make", async () => {
    for (const refused of ["rejected", "refused", "wrong-chain", "failed", "late"]) {
      const w = world({ safe: () => [], deposited: () => refusal(refused) });
      expect(await w.run([A, B], CUTOFF)).toBe("sent");
      expect(w.deposits).toHaveLength(1);
      expect(w.elapsed()).toBeGreaterThanOrEqual(WALLET_WAIT);
    }
  });

  test("forces nothing on a safe head it can't read", async () => {
    const w = world({ safe: () => [] });
    const { io } = w;
    const find = io.find.bind(io);
    io.find = (head, from, stop) =>
      head === "safe" ? Promise.reject(new Error("rpc down")) : find(head, from, stop);
    expect(await w.run([A], CUTOFF)).toBe("sent");
    expect(w.deposits).toEqual([]);
  });

  test("sends a posting the latest head showed once its wait passes with no record", async () => {
    const w = world({ latest: (t) => (t < POLL ? [A] : []) });
    expect(await w.run([A], CUTOFF)).toBe("sent");
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]?.at).toBeGreaterThanOrEqual(WALLET_WAIT);
  });

  test("answers sent once every unrecorded posting was sent its whole wait ago", async () => {
    const w = world({});
    expect(await w.run([A, B], CUTOFF)).toBe("sent");
    expect(w.sends).toHaveLength(2);
    expect(w.elapsed()).toBeGreaterThanOrEqual(WALLET_WAIT);
    expect(w.elapsed()).toBeLessThan(WALLET_WAIT + POLL);
  });

  test("counts a send the wallet may still make as sent, and never asks for it again", async () => {
    const w = world({ answer: () => "unknown" });
    expect(await w.run([A], CUTOFF)).toBe("sent");
    expect(w.sends).toHaveLength(1);
  });

  test("sends nothing past the cutoff, by the device's clock or a head's time", async () => {
    const byClock = world({});
    expect(await byClock.run([A], START - 1n)).toBe("late");
    expect(byClock.sends).toEqual([]);
    const byChain = world({ chainAhead: 10n });
    expect(await byChain.run([A], START + 5n)).toBe("late");
    expect(byChain.sends).toEqual([]);
  });

  test("ignores a head's time far past the device's clock, which could refuse every send (T-25)", async () => {
    const forged = world({ chainAhead: WALLET_HOLD_MARGIN + 1n });
    expect(await forged.run([A], START + 100n)).toBe("sent");
    expect(forged.sends).toHaveLength(1);
  });

  test("answers what stopped the first send, and sent once one went", async () => {
    for (const answer of ["rejected", "refused", "wrong-chain", "failed"]) {
      const w = world({ answer: () => refusal(answer) });
      expect(await w.run([A, B], CUTOFF)).toBe(answer);
      expect(w.sends).toHaveLength(1);
    }
    const thrown = world({ answer: () => new TypeError("wallet gone") });
    expect(await thrown.run([A], CUTOFF)).toBe("failed");
    const second = world({ answer: (_, n) => (n === 0 ? "sent" : refusal("rejected")) });
    expect(await second.run([A, B], CUTOFF)).toBe("sent");
  });

  test("records nothing on reads that fail or throw", async () => {
    const failing = world({ readFails: true, finalized: () => [A] });
    expect(await failing.run([A], CUTOFF)).toBe("sent");
    const throwing = world({});
    throwing.io.find = () => Promise.reject(new Error("rpc down"));
    expect(await throwing.run([A], CUTOFF)).toBe("sent");
  });

  test("gives each read a stop that passes once every wait is over", async () => {
    const stops: (() => boolean)[] = [];
    const w = world({});
    const { io } = w;
    const find = io.find.bind(io);
    io.find = (head, from, stop) => {
      stops.push(stop);
      return find(head, from, stop);
    };
    await w.run([A], CUTOFF);
    expect(stops.every((stop) => !stop())).toBe(true);
    await w.io.sleep(POSTING_POLL_MS);
    expect(stops.at(-1)?.()).toBe(true);
  });

  test("never recorded unless the finalized head carries every posting, never sending one twice or past the cutoff", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uniqueArray(fc.integer({ min: 0, max: 2 }), { maxLength: 3 }), {
          minLength: 1,
          maxLength: 120,
        }),
        fc.array(fc.uniqueArray(fc.integer({ min: 0, max: 2 }), { maxLength: 3 }), {
          minLength: 1,
          maxLength: 120,
        }),
        fc.array(fc.uniqueArray(fc.integer({ min: 0, max: 2 }), { maxLength: 3 }), {
          minLength: 1,
          maxLength: 120,
        }),
        fc.array(fc.constantFrom("sent", "unknown", "rejected", "failed"), { minLength: 1 }),
        fc.array(fc.constantFrom("sent", "unknown", "rejected", "refused", "failed"), {
          minLength: 1,
        }),
        fc.bigInt({ min: 0n, max: 2n * WALLET_WAIT }),
        async (finals, safes, latests, answers, depositAnswers, cutoffIn) => {
          const postings = [A, B, Uint8Array.of(0, 13, 1, 0xcc)];
          const at = (rounds: number[][], t: bigint) =>
            (rounds[Math.min(Number(t / POLL), rounds.length - 1)] ?? []).map(
              (i) => postings[i] as Uint8Array,
            );
          // Every record a finalized read carried: each read goes on from the last.
          const final: Uint8Array[] = [];
          const w = world({
            finalized: (t) => {
              const records = at(finals, t);
              final.push(...records);
              return records;
            },
            safe: (t) => at(safes, t),
            latest: (t) => at(latests, t),
            answer: (_, n) => {
              const a = answers[n % answers.length] as string;
              return a === "sent" || a === "unknown" ? a : refusal(a);
            },
            deposited: (_, n) => {
              const a = depositAnswers[n % depositAnswers.length] as string;
              return a === "sent" || a === "unknown" ? a : refusal(a);
            },
          });
          const cutoff = START + cutoffIn;
          const result = await w.run(postings, cutoff);
          if (result === "recorded") for (const p of postings) expect(final).toContainEqual(p);
          // Each posting sent at most once, and only by the cutoff.
          expect(new Set(w.sends.map(({ call }) => call)).size).toBe(w.sends.length);
          for (const { at: sentAt } of w.sends) expect(START + sentAt).toBeLessThanOrEqual(cutoff);
          // Each deposited at most once, only a posting the wallet sent
          // `POSTING_FORCE_AFTER` before, and only with a deposit's span
          // left before the cutoff.
          expect(new Set(w.deposits.map(({ call }) => call)).size).toBe(w.deposits.length);
          for (const { call, at: depositedAt } of w.deposits) {
            const send = w.sends.find((s) => s.call === call);
            expect(send).toBeDefined();
            expect(depositedAt - (send?.at ?? 0n)).toBeGreaterThanOrEqual(POSTING_FORCE_AFTER);
            expect(START + depositedAt + WALLET_DEPOSIT_SPAN).toBeLessThanOrEqual(cutoff);
          }
          if (result === "forced") expect(w.deposits.length).toBeGreaterThan(0);
          // The run ends within two waits, the time to force and two rounds.
          expect(w.elapsed()).toBeLessThanOrEqual(
            2n * WALLET_WAIT + POSTING_FORCE_AFTER + 2n * POLL,
          );
        },
      ),
      { numRuns },
    );
  });

  test("takes one call for each posting", async () => {
    await expect(postFromWallet(world({}).io, [A, B], [A], CUTOFF)).rejects.toThrow(RangeError);
  });
});
