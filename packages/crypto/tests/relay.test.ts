import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  decodeRelayBallotCalldata,
  eventAccumulatorGenesis,
  eventAccumulatorStep,
  frameRelayRecord,
  l2Alias,
  MAX_RELAY_RECORD,
  PARAMETERS,
  PORTAL_MAX_DATA,
  RELAY_DEPOSIT_SIGNATURE,
  RELAY_EVENT_SIGNATURE,
  RELAY_SIGNATURE,
  relayBallotCalldata,
  relayCallHash,
  relayDepositData,
  relayEvent,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/relay.json, from the independent Python implementation in
// scripts/relay-vectors.py (docs/spec/contracts.md, L1 relay; T-50, T-71,
// T-17, T-52). Expected values all come from the file.

interface RecordFields {
  readonly record?: string;
  readonly recordPrefix?: string;
  readonly recordLength?: number;
  readonly recordFill?: string;
}

interface VectorFile {
  readonly format: string;
  readonly tag: string;
  readonly maxRelayRecord: number;
  readonly portalMaxData: number;
  readonly aliasOffset: string;
  readonly signatures: {
    readonly relay: { readonly signature: string; readonly selector: string };
    readonly deposit: { readonly signature: string; readonly selector: string };
    readonly event: { readonly signature: string; readonly topic0: string };
  };
  readonly storage: {
    readonly namespace: string;
    readonly base: string;
    readonly countSlot: string;
    readonly callsSlot: string;
    readonly callSlots: readonly { readonly index: string; readonly slot: string }[];
  };
  readonly aliases: readonly { readonly l1: string; readonly l2: string }[];
  readonly calls: readonly (RecordFields & {
    readonly id: string;
    readonly l1ChainId: string;
    readonly relay: string;
    readonly index: string;
    readonly l1Block: string;
    readonly l1Timestamp: string;
    readonly gasLimit: string;
    readonly callHash: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly depositData?: string;
    readonly depositDataLength: number;
    readonly depositDataSha256: string;
  })[];
  readonly framing: readonly (RecordFields & {
    readonly id: string;
    readonly result: string;
    readonly definitionHash?: string;
  })[];
  readonly calldata: readonly {
    readonly id: string;
    readonly calldata: string;
    readonly result: string;
    readonly gasLimit?: string;
    readonly record?: string;
  }[];
  readonly accumulator: {
    readonly chainId: string;
    readonly address: string;
    readonly genesis: string;
    readonly steps: readonly {
      readonly n: number;
      readonly call: string;
      readonly accumulator: string;
    }[];
  };
}

const file = JSON.parse(readFileSync(new URL("relay.json", SPEC_VECTORS), "utf8")) as VectorFile;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const utf8 = (s: string) => new TextEncoder().encode(s);

/** The generator's filler: SHA-256 of `label/i` for i = 0, 1, …, cut to `n` bytes. */
function det(label: string, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0, at = 0; at < n; i++, at += 32)
    out.set(sha256(utf8(`${label}/${i}`)).subarray(0, n - at), at);
  return out;
}

function recordOf(v: RecordFields): Uint8Array {
  if (v.record !== undefined) return hex(v.record);
  if (v.recordPrefix === undefined || v.recordLength === undefined || v.recordFill === undefined)
    throw new Error("relay.json: a vector without its record");
  const prefix = hex(v.recordPrefix);
  const out = new Uint8Array(v.recordLength);
  out.set(prefix);
  out.set(det(v.recordFill, v.recordLength - prefix.length), prefix.length);
  return out;
}

describe("relay vectors (docs/spec/vectors/relay.json)", () => {
  test("file format, tag and limits", () => {
    expect(file.format).toBe("abolish-relay-vectors/1");
    expect(file.tag).toBe("abolish/v1/relay-call");
    expect(file.maxRelayRecord).toBe(MAX_RELAY_RECORD);
    expect(file.portalMaxData).toBe(PORTAL_MAX_DATA);
    expect(MAX_RELAY_RECORD).toBe(PARAMETERS.MAX_RELAY_RECORD);
  });

  test("signatures, selectors and the event's topic 0", () => {
    const { relay, deposit, event } = file.signatures;
    expect(relay.signature).toBe(RELAY_SIGNATURE);
    expect(deposit.signature).toBe(RELAY_DEPOSIT_SIGNATURE);
    expect(event.signature).toBe(RELAY_EVENT_SIGNATURE);
    expect(bytesToHex(relayBallotCalldata(0n, new Uint8Array()).subarray(0, 4))).toBe(
      relay.selector,
    );
    expect(bytesToHex(relayDepositData(0n, 0n, 0n, 0n, new Uint8Array()).subarray(0, 4))).toBe(
      deposit.selector,
    );
    const { topics } = relayEvent(new Uint8Array(32), 0n, new Uint8Array(32));
    expect(bytesToHex(topics[0] ?? new Uint8Array())).toBe(event.topic0);
  });

  test("storage slots follow ERC-7201 and Solidity's mapping layout", () => {
    const { storage } = file;
    expect(storage.namespace).toBe("abolish.ballot-relay");
    const inner = BigInt(`0x${bytesToHex(keccak_256(utf8(storage.namespace)))}`) - 1n;
    const base =
      BigInt(`0x${bytesToHex(keccak_256(hex(inner.toString(16).padStart(64, "0"))))}`) & ~0xffn;
    expect(storage.base).toBe(base.toString(16).padStart(64, "0"));
    expect(storage.countSlot).toBe(storage.base);
    expect(storage.callsSlot).toBe((base + 1n).toString(16).padStart(64, "0"));
    for (const { index, slot } of storage.callSlots) {
      const key = BigInt(index).toString(16).padStart(64, "0");
      expect(bytesToHex(keccak_256(hex(key + storage.callsSlot))), index).toBe(slot);
    }
  });

  test("L2 aliases", () => {
    expect(file.aliasOffset).toBe("1111000000000000000000000000000000001111");
    for (const { l1, l2 } of file.aliases) expect(bytesToHex(l2Alias(hex(l1))), l1).toBe(l2);
  });

  test("call hashes, deposit data and events", () => {
    for (const v of file.calls) {
      const record = recordOf(v);
      expect(frameRelayRecord(record).ok, v.id).toBe(true);
      const call = {
        l1ChainId: BigInt(v.l1ChainId),
        relay: hex(v.relay),
        index: BigInt(v.index),
        l1Block: BigInt(v.l1Block),
        l1Timestamp: BigInt(v.l1Timestamp),
        gasLimit: BigInt(v.gasLimit),
        record,
      };
      const callHash = relayCallHash(call);
      expect(bytesToHex(callHash), v.id).toBe(v.callHash);
      const data = relayDepositData(
        call.index,
        call.l1Block,
        call.l1Timestamp,
        call.gasLimit,
        record,
      );
      expect(data.length, v.id).toBe(v.depositDataLength);
      expect(data.length, v.id).toBeLessThanOrEqual(PORTAL_MAX_DATA);
      expect(bytesToHex(sha256(data)), v.id).toBe(v.depositDataSha256);
      if (v.depositData !== undefined) expect(bytesToHex(data), v.id).toBe(v.depositData);
      const event = relayEvent(record.subarray(3, 35), call.index, callHash);
      expect(event.topics.map(bytesToHex), v.id).toEqual(v.topics);
      expect(bytesToHex(event.data), v.id).toBe(v.data);
    }
  });

  test("a call binds the whole record, not only its ballot's header", () => {
    const typical = file.calls.find((c) => c.id === "typical");
    const otherProof = file.calls.find((c) => c.id === "other-proof");
    if (typical?.record === undefined || otherProof?.record === undefined)
      throw new Error("relay.json: no typical or other-proof call");
    expect(otherProof.record.slice(0, 70)).toBe(typical.record.slice(0, 70));
    expect(otherProof.record).not.toBe(typical.record);
    expect(otherProof.callHash).not.toBe(typical.callHash);
  });

  test("framing", () => {
    expect(new Set(file.framing.map((v) => v.result))).toEqual(
      new Set(["framed", "relay-too-large", "relay-truncated", "relay-record-type"]),
    );
    for (const v of file.framing) {
      const framing = frameRelayRecord(recordOf(v));
      if (v.result === "framed") {
        expect(framing.ok, v.id).toBe(true);
        if (framing.ok) expect(bytesToHex(framing.definitionHash), v.id).toBe(v.definitionHash);
      } else expect(framing, v.id).toEqual({ ok: false, code: v.result });
    }
  });

  test("calldata", () => {
    for (const v of file.calldata) {
      const calldata = hex(v.calldata);
      const decoded = decodeRelayBallotCalldata(calldata);
      if (v.result === "canonical") {
        expect(decoded, v.id).not.toBeNull();
        expect(decoded?.gasLimit.toString(), v.id).toBe(v.gasLimit);
        expect(bytesToHex(decoded?.record ?? new Uint8Array()), v.id).toBe(v.record);
        if (decoded)
          expect(bytesToHex(relayBallotCalldata(decoded.gasLimit, decoded.record)), v.id).toBe(
            v.calldata,
          );
      } else {
        expect(v.result, v.id).toBe("relay-calldata");
        expect(decoded, v.id).toBeNull();
      }
    }
  });

  test("the relay's event accumulator", () => {
    const { accumulator } = file;
    const chainId = BigInt(accumulator.chainId);
    let acc = eventAccumulatorGenesis(chainId, hex(accumulator.address));
    expect(bytesToHex(acc)).toBe(accumulator.genesis);
    for (const step of accumulator.steps) {
      const v = file.calls.find((c) => c.id === step.call);
      if (v === undefined) throw new Error(`relay.json: no call ${step.call}`);
      acc = eventAccumulatorStep(acc, BigInt(step.n), {
        block: BigInt(v.l1Block),
        timestamp: BigInt(v.l1Timestamp),
        topics: v.topics.map(hex),
        data: hex(v.data),
      });
      expect(bytesToHex(acc), step.call).toBe(step.accumulator);
    }
  });
});

describe("relay properties", () => {
  const record = fc
    .tuple(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.uint8Array({ maxLength: 300 }))
    .map(([definition, body]) => {
      const out = new Uint8Array(35 + body.length);
      out.set([0x00, 0x02, 0x01]);
      out.set(definition, 3);
      out.set(body, 35);
      return out;
    });
  const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
  const call = fc.record({
    l1ChainId: u64,
    relay: fc.uint8Array({ minLength: 20, maxLength: 20 }),
    index: u64,
    l1Block: u64,
    l1Timestamp: u64,
    gasLimit: u64,
    record,
  });

  test("changing any field of a call changes its hash", () => {
    fc.assert(
      fc.property(call, fc.nat(), fc.nat({ max: 6 }), (c, at, which) => {
        const base = bytesToHex(relayCallHash(c));
        const flip = (b: Uint8Array) => {
          const out = b.slice();
          const i = at % out.length;
          out[i] = (out[i] ?? 0) ^ 1;
          return out;
        };
        const bump = (v: bigint) => (v === 0n ? 1n : v - 1n);
        const changed = [
          { ...c, l1ChainId: bump(c.l1ChainId) },
          { ...c, relay: flip(c.relay) },
          { ...c, index: bump(c.index) },
          { ...c, l1Block: bump(c.l1Block) },
          { ...c, l1Timestamp: bump(c.l1Timestamp) },
          { ...c, gasLimit: bump(c.gasLimit) },
          { ...c, record: flip(c.record) },
        ][which];
        if (changed === undefined) return;
        expect(bytesToHex(relayCallHash(changed))).not.toBe(base);
        const longer = new Uint8Array(c.record.length + 1);
        longer.set(c.record);
        expect(bytesToHex(relayCallHash({ ...c, record: longer }))).not.toBe(base);
      }),
      { numRuns },
    );
  });

  test("calldata round-trips, and any other byte string is refused", () => {
    fc.assert(
      fc.property(u64, record, fc.nat(), fc.integer({ min: 1, max: 255 }), (gas, r, at, x) => {
        const calldata = relayBallotCalldata(gas, r);
        const decoded = decodeRelayBallotCalldata(calldata);
        expect(decoded?.gasLimit).toBe(gas);
        expect(bytesToHex(decoded?.record ?? new Uint8Array())).toBe(bytesToHex(r));
        // Any accepted calldata is the encoding of what it decodes to, so a
        // call carries no byte its record and gas limit don't define (T-17);
        // a changed selector, gas word above 64 bits, offset or padding byte
        // is refused outright.
        const i = at % calldata.length;
        const changed = calldata.slice();
        changed[i] = (changed[i] ?? 0) ^ x;
        const again = decodeRelayBallotCalldata(changed);
        if (again !== null)
          expect(bytesToHex(relayBallotCalldata(again.gasLimit, again.record))).toBe(
            bytesToHex(changed),
          );
        const fixedByte = i < 28 || (i >= 36 && i < 68) || i >= 100 + r.length;
        if (fixedByte) expect(again).toBeNull();
        const appended = new Uint8Array(calldata.length + 1);
        appended.set(calldata);
        expect(decodeRelayBallotCalldata(appended)).toBeNull();
        expect(decodeRelayBallotCalldata(calldata.subarray(0, calldata.length - 1))).toBeNull();
      }),
      { numRuns },
    );
  });

  test("a record frames exactly when its length and type allow it", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 120 }), (b) => {
        const framing = frameRelayRecord(b);
        const isBallot = b[0] === 0x00 && b[1] === 0x02;
        if (b.length < 35) expect(framing).toEqual({ ok: false, code: "relay-truncated" });
        else if (!isBallot) expect(framing).toEqual({ ok: false, code: "relay-record-type" });
        else expect(framing.ok).toBe(true);
      }),
      { numRuns },
    );
  });

  test("MAX_RELAY_RECORD is the longest record whose deposit fits the portal's cap", () => {
    const fits = (n: number) =>
      relayDepositData(0n, 0n, 0n, 0n, new Uint8Array(n)).length <= PORTAL_MAX_DATA;
    expect(fits(MAX_RELAY_RECORD)).toBe(true);
    expect(fits(MAX_RELAY_RECORD + 1)).toBe(false);
    const longest = new Uint8Array(MAX_RELAY_RECORD);
    longest.set([0x00, 0x02]);
    expect(frameRelayRecord(longest).ok).toBe(true);
    const tooLong = new Uint8Array(MAX_RELAY_RECORD + 1);
    tooLong.set([0x00, 0x02]);
    expect(frameRelayRecord(tooLong)).toEqual({ ok: false, code: "relay-too-large" });
  });

  test("rejects malformed arguments", () => {
    const c = {
      l1ChainId: 1n,
      relay: new Uint8Array(20),
      index: 0n,
      l1Block: 0n,
      l1Timestamp: 0n,
      gasLimit: 0n,
      record: new Uint8Array(35),
    };
    expect(() => relayCallHash({ ...c, index: 1n << 64n })).toThrow(RangeError);
    expect(() => relayCallHash({ ...c, l1Timestamp: -1n })).toThrow(RangeError);
    expect(() => relayCallHash({ ...c, relay: new Uint8Array(19) })).toThrow(TypeError);
    expect(() => relayBallotCalldata(1n << 64n, c.record)).toThrow(RangeError);
    expect(() => relayDepositData(0n, 1n << 64n, 0n, 0n, c.record)).toThrow(RangeError);
    expect(() => l2Alias(new Uint8Array(21))).toThrow(TypeError);
    expect(() => relayEvent(new Uint8Array(31), 0n, new Uint8Array(32))).toThrow(TypeError);
  });
});
