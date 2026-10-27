import { bytesToHex } from "@noble/hashes/utils.js";
import { expect, test } from "vite-plus/test";
import type { Rpc } from "../src/anvil.ts";
import { firstBlockAt, type Game, l1Client, PORTAL } from "../src/contract-events.ts";

const quantity = (n: bigint) => `0x${n.toString(16)}`;

/** An L2 node over blocks at `times`, block `i` at `times[i]`, which mines at the time it is given. */
function l2Of(times: bigint[]): Rpc & { readonly mined: bigint[] } {
  const mined: bigint[] = [];
  const block = (n: number) => ({
    number: quantity(BigInt(n)),
    timestamp: quantity(times[n] as bigint),
    hash: `0x${"00".repeat(32)}`,
    stateRoot: `0x${"00".repeat(32)}`,
  });
  return {
    mined,
    async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      if (method === "evm_mine") {
        const t = BigInt(params[0] as number);
        mined.push(t);
        times.push(t);
        return null as T;
      }
      if (method !== "eth_getBlockByNumber") throw new Error(`unexpected ${method}`);
      const tag = params[0] as string;
      return block(tag === "latest" ? times.length - 1 : Number(BigInt(tag))) as T;
    },
  };
}

test("firstBlockAt finds the first block at or after a time, and mines one past the head", async () => {
  const times = [10n, 20n, 20n, 30n, 50n];
  for (const [t, n] of [
    [0n, 0],
    [10n, 0],
    [11n, 1],
    [20n, 1],
    [21n, 3],
    [31n, 4],
    [50n, 4],
  ] as const) {
    const l2 = l2Of([...times]);
    expect(BigInt((await firstBlockAt(l2, t)).number)).toBe(BigInt(n));
    expect(l2.mined).toEqual([]);
  }
  const l2 = l2Of([...times]);
  const mined = await firstBlockAt(l2, 51n);
  expect(l2.mined).toEqual([51n]);
  expect([BigInt(mined.number), BigInt(mined.timestamp)]).toEqual([5n, 51n]);
});

test("the fixture's L1 answers the portal, factory and games, and forwards the chain", async () => {
  const forwarded: string[] = [];
  const l1: Rpc = {
    async call<T>(method: string): Promise<T> {
      forwarded.push(method);
      if (method === "eth_chainId") return "0x7a69" as T;
      throw new Error(`unexpected ${method}`);
    },
  };
  const games: Game[] = [
    { root: new Uint8Array(32).fill(1), l2Block: 28n, created: 1_000n },
    { root: new Uint8Array(32).fill(2), l2Block: 29n, created: 4_600n },
  ];
  const client = l1Client(l1, games);
  expect(await client.getChainId()).toBe(31337);
  expect(forwarded).toEqual(["eth_chainId"]);
  const read = (address: `0x${string}`, signature: string, args: readonly bigint[] = []) =>
    client.readContract({
      address,
      abi: [
        {
          type: "function",
          name: signature,
          stateMutability: "view",
          inputs: args.map(() => ({ type: "uint256", name: "i" })),
          outputs:
            signature === "gameAtIndex"
              ? [
                  { type: "uint32", name: "t" },
                  { type: "uint64", name: "c" },
                  { type: "address", name: "p" },
                ]
              : [
                  {
                    type: {
                      disputeGameFactory: "address",
                      respectedGameType: "uint32",
                      gameCount: "uint256",
                      rootClaim: "bytes32",
                      l2SequenceNumber: "uint256",
                      status: "uint8",
                    }[signature] as string,
                    name: "r",
                  },
                ],
        },
      ],
      functionName: signature,
      args,
    } as never) as Promise<unknown>;
  const factory = (await read(PORTAL, "disputeGameFactory")) as `0x${string}`;
  expect(await read(PORTAL, "respectedGameType")).toBe(0);
  expect(await read(factory, "gameCount")).toBe(2n);
  const [type, created, proxy] = (await read(factory, "gameAtIndex", [1n])) as [
    number,
    bigint,
    `0x${string}`,
  ];
  expect([type, created]).toEqual([0, 4_600n]);
  expect(await read(proxy, "rootClaim")).toBe(`0x${bytesToHex(games[1]?.root as Uint8Array)}`);
  expect(await read(proxy, "l2SequenceNumber")).toBe(29n);
  expect(await read(proxy, "status")).toBe(0);
  await expect(read(factory, "gameAtIndex", [2n])).rejects.toThrow();
});
