// A posting from the voter's own wallet (src/wallet.ts;
// docs/spec/posting-relay.md, Own wallet): the wallet is asked only on the
// release's L2, names it in the transaction, is asked for an estimate before
// it sends, and the client stands down only on the board's event at the
// finalized head, never sending a posting the latest head already shows,
// nor anything past `c_D` (T-13, T-18, T-25, T-34).

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import type { LoadedPostings } from "../src/load.ts";
import { POSTING_POLL_MS } from "../src/posting.ts";
import {
  type Eip1193,
  injectedWallet,
  postFromWallet,
  WALLET_HOLD_MARGIN,
  WALLET_WAIT,
  type WalletAnswer,
  type WalletIo,
  WalletRefusal,
  WalletSession,
} from "../src/wallet.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const CHAIN = 84_532n;
const BOARD = { address: `0x${"b0".repeat(20)}` };
const ACCOUNT = `0x${"Ac".repeat(20)}`;
const TX = `0x${"ab".repeat(32)}`;
const CALL = Uint8Array.of(0x4b, 0x6f, 0xf1, 0xd0, 0x01);

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
    const session = new WalletSession(provider, CHAIN, BOARD);
    expect(await session.send(CALL)).toBe("sent");
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
    const session = new WalletSession(provider, CHAIN, BOARD);
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
    const session = new WalletSession(provider, CHAIN, BOARD);
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
    expect(await new WalletSession(switching.provider, CHAIN, BOARD).send(CALL)).toBe("sent");
    const unknown = wallet({
      ...honest(1n),
      wallet_switchEthereumChain: () => {
        throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
      },
    });
    await expect(
      new WalletSession(unknown.provider, CHAIN, BOARD).send(CALL),
    ).rejects.toMatchObject({ answer: "wrong-chain" });
    const declined = wallet({
      ...honest(1n),
      wallet_switchEthereumChain: () => {
        throw rejection();
      },
    });
    await expect(
      new WalletSession(declined.provider, CHAIN, BOARD).send(CALL),
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
      await expect(new WalletSession(provider, CHAIN, BOARD).send(CALL)).rejects.toMatchObject({
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
      new WalletSession(refused.provider, CHAIN, BOARD).send(CALL),
    ).rejects.toMatchObject({ answer: "refused" });
    expect(refused.methods()).not.toContain("eth_sendTransaction");
    const down = wallet({
      ...honest(),
      eth_estimateGas: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(new WalletSession(down.provider, CHAIN, BOARD).send(CALL)).rejects.toMatchObject({
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
    await expect(new WalletSession(provider, CHAIN, BOARD).send(CALL)).rejects.toMatchObject({
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
      new WalletSession(provider, CHAIN, BOARD).send(CALL, () => late),
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
        new WalletSession(provider, CHAIN, BOARD).send(CALL),
        `${method} ${JSON.stringify(value)}`,
      ).rejects.toMatchObject({ answer: "failed" });
      expect(methods()).not.toContain("eth_sendTransaction");
    }
  });

  test("counts a send the wallet never answers, or answers oddly, as possibly sent", async () => {
    const held = wallet({ ...honest(), eth_sendTransaction: () => new Promise(() => {}) });
    expect(await new WalletSession(held.provider, CHAIN, BOARD, 20).send(CALL)).toBe("unknown");
    const odd = wallet({ ...honest(), eth_sendTransaction: () => "0x1234" });
    expect(await new WalletSession(odd.provider, CHAIN, BOARD).send(CALL)).toBe("unknown");
  });

  test("gives up on any other request the wallet never answers, having sent nothing", async () => {
    for (const method of ["eth_requestAccounts", "eth_chainId", "eth_estimateGas"]) {
      const { provider, methods } = wallet({ ...honest(), [method]: () => new Promise(() => {}) });
      await expect(new WalletSession(provider, CHAIN, BOARD, 20).send(CALL)).rejects.toMatchObject({
        answer: "failed",
      });
      expect(methods()).not.toContain("eth_sendTransaction");
    }
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
   * `finalized` and `latest` say which records each head carries at each
   * time (seconds from `START`), and `answer` what each send meets.
   */
  function world({
    finalized = () => [],
    latest = () => [],
    answer = () => "sent",
    chainAhead = 0n,
    readFails = false,
  }: {
    finalized?: (t: bigint, sent: readonly Uint8Array[]) => readonly Uint8Array[];
    latest?: (t: bigint, sent: readonly Uint8Array[]) => readonly Uint8Array[];
    answer?: (call: Uint8Array, n: number) => "sent" | "unknown" | Error;
    chainAhead?: bigint;
    readFails?: boolean;
  }) {
    let ms = Number(START) * 1000;
    const t = () => BigInt(Math.floor(ms / 1000));
    const sends: { call: Uint8Array; at: bigint }[] = [];
    const reads: { head: string; from: bigint | undefined }[] = [];
    // Each call is its posting's bytes, so a test can tell which was sent.
    const sent = () => sends.map(({ call }) => call);
    const io: WalletIo = {
      send(call) {
        sends.push({ call, at: t() - START });
        const met = answer(call, sends.length - 1);
        return met instanceof Error ? Promise.reject(met) : Promise.resolve(met);
      },
      find(head, from): Promise<LoadedPostings> {
        reads.push({ head, from });
        if (readFails) return Promise.resolve({ ok: false, problem: "unreachable" });
        const records = (head === "finalized" ? finalized : latest)(t() - START, sent());
        return Promise.resolve({ ok: true, block: t(), timestamp: t() + chainAhead, records });
      },
      now: () => ms,
      sleep(wait) {
        ms += wait;
        return Promise.resolve();
      },
    };
    return { io, sends, reads, elapsed: () => t() - START };
  }

  const refusal = (answer: string) =>
    new WalletRefusal(answer as Exclude<WalletAnswer, "recorded" | "sent">);

  test("recorded once the finalized head carries every posting, each sent once", async () => {
    const w = world({
      // Each sent posting is final two rounds later.
      finalized: (t, sent) => (t >= 2n * POLL ? sent : []),
    });
    expect(await postFromWallet(w.io, [A, B], [A, B], CUTOFF)).toBe("recorded");
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
    expect(await postFromWallet(w.io, [A, B], [A, B], CUTOFF)).toBe("recorded");
    expect(w.sends).toEqual([]);
  });

  test("waits on a posting the latest head shows rather than paying for it beside the relay's (T-13)", async () => {
    const w = world({
      latest: () => [A],
      finalized: (t) => (t >= 5n * POLL ? [A] : []),
    });
    expect(await postFromWallet(w.io, [A], [A], CUTOFF)).toBe("recorded");
    expect(w.sends).toEqual([]);
  });

  test("lets a sighting near the cutoff delay the wallet's send, never cancel it (T-25)", async () => {
    // The untrusted endpoint shows it at the latest head and never finalizes it.
    const w = world({ latest: () => [A] });
    const cutoff = START + WALLET_HOLD_MARGIN + 3n * POLL;
    expect(await postFromWallet(w.io, [A], [A], cutoff)).toBe("sent");
    expect(w.sends).toHaveLength(1);
    expect(START + (w.sends[0]?.at ?? 0n)).toBeLessThanOrEqual(cutoff - WALLET_HOLD_MARGIN + POLL);
  });

  test("sends a posting the latest head showed once its wait passes with no record", async () => {
    const w = world({ latest: (t) => (t < POLL ? [A] : []) });
    expect(await postFromWallet(w.io, [A], [A], CUTOFF)).toBe("sent");
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]?.at).toBeGreaterThanOrEqual(WALLET_WAIT);
  });

  test("answers sent once every unrecorded posting was sent its whole wait ago", async () => {
    const w = world({});
    expect(await postFromWallet(w.io, [A, B], [A, B], CUTOFF)).toBe("sent");
    expect(w.sends).toHaveLength(2);
    expect(w.elapsed()).toBeGreaterThanOrEqual(WALLET_WAIT);
    expect(w.elapsed()).toBeLessThan(WALLET_WAIT + POLL);
  });

  test("counts a send the wallet may still make as sent, and never asks for it again", async () => {
    const w = world({ answer: () => "unknown" });
    expect(await postFromWallet(w.io, [A], [A], CUTOFF)).toBe("sent");
    expect(w.sends).toHaveLength(1);
  });

  test("sends nothing past the cutoff, by the device's clock or a head's time", async () => {
    const byClock = world({});
    expect(await postFromWallet(byClock.io, [A], [A], START - 1n)).toBe("late");
    expect(byClock.sends).toEqual([]);
    const byChain = world({ chainAhead: 10n });
    expect(await postFromWallet(byChain.io, [A], [A], START + 5n)).toBe("late");
    expect(byChain.sends).toEqual([]);
  });

  test("ignores a head's time far past the device's clock, which could refuse every send (T-25)", async () => {
    const forged = world({ chainAhead: WALLET_HOLD_MARGIN + 1n });
    expect(await postFromWallet(forged.io, [A], [A], START + 100n)).toBe("sent");
    expect(forged.sends).toHaveLength(1);
  });

  test("answers what stopped the first send, and sent once one went", async () => {
    for (const answer of ["rejected", "refused", "wrong-chain", "failed"]) {
      const w = world({ answer: () => refusal(answer) });
      expect(await postFromWallet(w.io, [A, B], [A, B], CUTOFF)).toBe(answer);
      expect(w.sends).toHaveLength(1);
    }
    const thrown = world({ answer: () => new TypeError("wallet gone") });
    expect(await postFromWallet(thrown.io, [A], [A], CUTOFF)).toBe("failed");
    const second = world({ answer: (_, n) => (n === 0 ? "sent" : refusal("rejected")) });
    expect(await postFromWallet(second.io, [A, B], [A, B], CUTOFF)).toBe("sent");
  });

  test("records nothing on reads that fail or throw", async () => {
    const failing = world({ readFails: true, finalized: () => [A] });
    expect(await postFromWallet(failing.io, [A], [A], CUTOFF)).toBe("sent");
    const throwing = world({});
    throwing.io.find = () => Promise.reject(new Error("rpc down"));
    expect(await postFromWallet(throwing.io, [A], [A], CUTOFF)).toBe("sent");
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
    await postFromWallet(w.io, [A], [A], CUTOFF);
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
        fc.array(fc.constantFrom("sent", "unknown", "rejected", "failed"), { minLength: 1 }),
        fc.bigInt({ min: 0n, max: 2n * WALLET_WAIT }),
        async (finals, latests, answers, cutoffIn) => {
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
            latest: (t) => at(latests, t),
            answer: (_, n) => {
              const a = answers[n % answers.length] as string;
              return a === "sent" || a === "unknown" ? a : refusal(a);
            },
          });
          const cutoff = START + cutoffIn;
          const result = await postFromWallet(w.io, postings, postings, cutoff);
          if (result === "recorded") for (const p of postings) expect(final).toContainEqual(p);
          // Each posting sent at most once, and only by the cutoff.
          expect(new Set(w.sends.map(({ call }) => call)).size).toBe(w.sends.length);
          for (const { at: sentAt } of w.sends) expect(START + sentAt).toBeLessThanOrEqual(cutoff);
          // The run ends within two waits and a round.
          expect(w.elapsed()).toBeLessThanOrEqual(2n * WALLET_WAIT + POLL);
        },
      ),
      { numRuns },
    );
  });

  test("takes one call for each posting", async () => {
    await expect(postFromWallet(world({}).io, [A, B], [A], CUTOFF)).rejects.toThrow(RangeError);
  });
});
