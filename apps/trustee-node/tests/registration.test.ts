import type { ContractEventRecord } from "@abolishus/crypto";
import { type Rpc, RpcError } from "@abolishus/node";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";
import {
  CEREMONY_REGISTERED,
  ceremonyRegistered,
  type Definition,
  DEFINITION_REGISTERED,
  definitionRegistered,
  KEY_SET,
  OTHER_KEY_SET,
  releaseOf,
  stubOf,
  v1Definition,
  v5Definition,
} from "../../../packages/verifier/tests/registration-logs.ts";
import { l2RegistrationCheck } from "../src/registration.ts";

// The deployment's registration check (P2-13 part 3b): the election
// registry's registration and the trustee registry's ceremony record from
// the seat's own L2 node, in finalized history, judged by the verifier's
// `registrationCheck` under the pinned registries. The logs are the
// registries' as they emit them (packages/verifier/tests/registration-logs.ts),
// with key-set.json's key set and hash (T-34, T-37, T-71).

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const FROM_BLOCK = 5n;
const FINALIZED = 100n;

interface Log {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
}

const logOf = (r: ContractEventRecord): Log => ({
  address: hex(r.contract),
  topics: r.topics.map(hex),
  data: hex(r.data),
  blockNumber: `0x${r.l2_block.toString(16)}`,
});

/** An L2 node answering `eth_getLogs` from `held` by address, range and topics, as a real one does. */
function l2Node(
  held: readonly ContractEventRecord[],
  d: Definition,
  finalized = FINALIZED,
  chain = d.value.l2_chain_id,
) {
  const asked: unknown[] = [];
  const rpc: Rpc = {
    call: async (method, params) => {
      if (method === "eth_chainId") return `0x${chain.toString(16)}`;
      if (method === "eth_getBlockByNumber") {
        expect(params).toEqual(["finalized", false]);
        return { number: `0x${finalized.toString(16)}` };
      }
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      const [filter] = params as [
        { address: string; fromBlock: string; toBlock: string; topics: string[] },
      ];
      asked.push(filter);
      return held
        .map(logOf)
        .filter(
          (l) =>
            l.address === filter.address &&
            BigInt(l.blockNumber) >= BigInt(filter.fromBlock) &&
            BigInt(l.blockNumber) <= BigInt(filter.toBlock) &&
            filter.topics.every((t, i) => t === l.topics[i]),
        );
    },
  };
  return { rpc, asked };
}

const v5 = v5Definition();
const honest = (d: Definition = v5, version?: number) => [
  ceremonyRegistered(d, version === undefined ? {} : { version }),
  definitionRegistered(d),
];
const check = (rpc: Rpc, d: Definition = v5) =>
  l2RegistrationCheck({ ...releaseOf(d), l2: rpc, fromBlock: FROM_BLOCK });

describe("l2RegistrationCheck", () => {
  test("passes a definition finalized L2 shows registered over the approved ceremony and key set", async () => {
    expect(await check(l2Node(honest(), v5).rpc)(v5, KEY_SET)).toBe(true);
    const v1 = v1Definition(1);
    expect(await check(l2Node(honest(v1, 1), v1).rpc, v1)(v1, KEY_SET)).toBe(true);
  });

  test("asks for the election's registration and its stub and panel's ceremony, from the registry's deployment to the finalized block", async () => {
    const { rpc, asked } = l2Node(honest(), v5);
    expect(await check(rpc)(v5, KEY_SET)).toBe(true);
    const range = {
      fromBlock: `0x${FROM_BLOCK.toString(16)}`,
      toBlock: `0x${FINALIZED.toString(16)}`,
    };
    expect(asked).toEqual([
      {
        address: hex(v5.value.election_registry),
        ...range,
        topics: [hex(DEFINITION_REGISTERED), hex(v5.value.election_id)],
      },
      {
        address: hex(v5.value.trustee_registry),
        ...range,
        topics: [hex(CEREMONY_REGISTERED), hex(stubOf(v5)), hex(v5.value.panel_id)],
      },
    ]);
  });

  test("refuses another key set, a missing registration or ceremony, and a second registration", async () => {
    expect(await check(l2Node(honest(), v5).rpc)(v5, OTHER_KEY_SET)).toBe(false);
    const [ceremony, registration] = honest() as [ContractEventRecord, ContractEventRecord];
    expect(await check(l2Node([ceremony], v5).rpc)(v5, KEY_SET)).toBe(false);
    expect(await check(l2Node([registration], v5).rpc)(v5, KEY_SET)).toBe(false);
    const again = definitionRegistered(v5, undefined, undefined, 30n);
    expect(await check(l2Node([...honest(), again], v5).rpc)(v5, KEY_SET)).toBe(false);
  });

  test("refuses until the registration is finalized", async () => {
    // Registered in block 20: not final while the finalized block is 19.
    expect(await check(l2Node(honest(), v5, 19n).rpc)(v5, KEY_SET)).toBe(false);
    expect(await check(l2Node(honest(), v5, 20n).rpc)(v5, KEY_SET)).toBe(true);
    // Nor before the registry's deployment block.
    expect(await check(l2Node(honest(), v5, FROM_BLOCK - 1n).rpc)(v5, KEY_SET)).toBe(false);
  });

  test("refuses a node of another chain, or a definition naming other registries", async () => {
    const other = l2Node(honest(), v5, FINALIZED, v5.value.l2_chain_id + 1n);
    expect(await check(other.rpc)(v5, KEY_SET)).toBe(false);
    expect(other.asked).toEqual([]);
    const moved = {
      ...v5,
      value: { ...v5.value, trustee_registry: new Uint8Array(20).fill(0x77) },
    };
    expect(await check(l2Node(honest(moved), moved).rpc)(moved, KEY_SET)).toBe(false);
  });

  test("refuses when the node can't be read, and rethrows anything else", async () => {
    const unreadable: Rpc = {
      call: () => Promise.reject(new RpcError("eth_chainId: unreachable")),
    };
    expect(await check(unreadable)(v5, KEY_SET)).toBe(false);
    const broken: Rpc = { call: () => Promise.reject(new TypeError("bug")) };
    await expect(check(broken)(v5, KEY_SET)).rejects.toThrow(TypeError);
  });
});
