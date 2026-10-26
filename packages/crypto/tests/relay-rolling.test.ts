import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  decodeRelayRollingBallotCalldata,
  eventAccumulatorGenesis,
  eventAccumulatorStep,
  frameRollingRelayRecord,
  MAX_RELAY_RECORD,
  MAX_ROLLING_RELAY_RECORD,
  PORTAL_MAX_DATA,
  RELAY_EVENT_SIGNATURE,
  RELAY_ROLLING_DEPOSIT_SIGNATURE,
  RELAY_ROLLING_SIGNATURE,
  RELAY_SIGNATURE,
  relayCallHash,
  relayEvent,
  relayRollingBallotCalldata,
  relayRollingCallHash,
  relayRollingDepositData,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/relay-rolling.json, from the independent Python
// implementation in scripts/relay-rolling-vectors.py (docs/spec/contracts.md,
// L1 relay, Rolling ballots; T-50, T-71, T-17, T-52), against packages/crypto's
// rolling call: its framing, call hash, deposit data and calldata, beside the
// first call's hash, the event and the accumulator. Expected values all come
// from the file.

interface RecordFields {
  readonly record?: string;
  readonly recordPrefix?: string;
  readonly recordLength?: number;
  readonly recordFill?: string;
}

interface Call extends RecordFields {
  readonly id: string;
  readonly l1ChainId: string;
  readonly relay: string;
  readonly index: string;
  readonly l1Block: string;
  readonly l1Timestamp: string;
  readonly gasLimit: string;
  readonly root: string;
  readonly ballot?: string;
  readonly callHash: string;
  readonly fixedCallHash: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly depositData?: string;
  readonly depositDataLength: number;
  readonly depositDataSha256: string;
}

interface VectorFile {
  readonly format: string;
  readonly tag: string;
  readonly fixedTag: string;
  readonly maxRollingRelayRecord: number;
  readonly maxRelayRecord: number;
  readonly portalMaxData: number;
  readonly signatures: {
    readonly relay: { readonly signature: string; readonly selector: string };
    readonly deposit: { readonly signature: string; readonly selector: string };
    readonly event: { readonly signature: string; readonly topic0: string };
  };
  readonly calls: readonly Call[];
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
    readonly root?: string;
    readonly record?: string;
  }[];
  readonly sequence: {
    readonly l1ChainId: string;
    readonly relay: string;
    readonly genesis: string;
    readonly count: string;
    readonly calls: readonly {
      readonly index: string;
      readonly call: "fixed" | "rolling";
      readonly l1Block: string;
      readonly l1Timestamp: string;
      readonly gasLimit: string;
      readonly root?: string;
      readonly record: string;
      readonly slot: string;
      readonly callHash: string;
      readonly topics: readonly string[];
      readonly data: string;
      readonly accumulator: string;
    }[];
  };
}

const file = JSON.parse(
  readFileSync(new URL("relay-rolling.json", SPEC_VECTORS), "utf8"),
) as VectorFile;
const v5 = JSON.parse(readFileSync(new URL("ballot-v5-records.json", SPEC_VECTORS), "utf8")) as {
  readonly ballots: readonly { readonly id: string; readonly encoding: string }[];
};

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const utf8 = (s: string) => new TextEncoder().encode(s);
const U64_MAX = (1n << 64n) - 1n;

const selector = (signature: string) => keccak_256(utf8(signature)).subarray(0, 4);

const word = (v: bigint) => hex(v.toString(16).padStart(64, "0"));

// The framing's code, or null where the rolling call frames the record.
const frame = (record: Uint8Array) => {
  const framed = frameRollingRelayRecord(record);
  return framed.ok ? null : framed.code;
};

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
    throw new Error("relay-rolling.json: a vector without its record");
  const out = new Uint8Array(v.recordLength);
  out.set(hex(v.recordPrefix));
  out.set(det(v.recordFill, v.recordLength - 35), 35);
  return out;
}

const fields = (v: Call) => ({
  l1ChainId: BigInt(v.l1ChainId),
  relay: hex(v.relay),
  index: BigInt(v.index),
  l1Block: BigInt(v.l1Block),
  l1Timestamp: BigInt(v.l1Timestamp),
  gasLimit: BigInt(v.gasLimit),
  root: hex(v.root),
  record: recordOf(v),
});

describe("relay rolling-call vectors (docs/spec/vectors/relay-rolling.json)", () => {
  test("file format, tags and limits", () => {
    expect(file.format).toBe("abolish-relay-rolling-vectors/1");
    expect(file.tag).toBe("abolish/v1/relay-rolling-call");
    expect(file.fixedTag).toBe("abolish/v1/relay-call");
    expect(file.maxRollingRelayRecord).toBe(MAX_ROLLING_RELAY_RECORD);
    expect(file.maxRelayRecord).toBe(MAX_RELAY_RECORD);
    expect(file.portalMaxData).toBe(PORTAL_MAX_DATA);
  });

  test("signatures, selectors and the event, which both calls share", () => {
    const { relay, deposit, event } = file.signatures;
    expect(relay.signature).toBe(RELAY_ROLLING_SIGNATURE);
    expect(bytesToHex(selector(relay.signature))).toBe(relay.selector);
    expect(deposit.signature).toBe(RELAY_ROLLING_DEPOSIT_SIGNATURE);
    expect(bytesToHex(selector(deposit.signature))).toBe(deposit.selector);
    expect(relay.selector).not.toBe(bytesToHex(selector(RELAY_SIGNATURE)));
    expect(event.signature).toBe(RELAY_EVENT_SIGNATURE);
    const { topics } = relayEvent(new Uint8Array(32), 0n, new Uint8Array(32));
    expect(bytesToHex(topics[0] ?? new Uint8Array())).toBe(event.topic0);
  });

  test("call hashes, deposit data and events", () => {
    for (const v of file.calls) {
      const c = fields(v);
      expect(frame(c.record), v.id).toBeNull();
      const callHash = relayRollingCallHash(c);
      expect(bytesToHex(callHash), v.id).toBe(v.callHash);
      // The first call's word for the same fields is never this one: the
      // tags differ, so no relayed event of one kind matches a call of the
      // other (L1 relay, Verification).
      expect(bytesToHex(relayCallHash(c)), v.id).toBe(v.fixedCallHash);
      expect(v.fixedCallHash, v.id).not.toBe(v.callHash);
      const data = relayRollingDepositData(
        c.index,
        c.l1Block,
        c.l1Timestamp,
        c.gasLimit,
        c.root,
        c.record,
      );
      expect(data.length, v.id).toBe(v.depositDataLength);
      expect(data.length, v.id).toBeLessThanOrEqual(PORTAL_MAX_DATA);
      expect(bytesToHex(sha256(data)), v.id).toBe(v.depositDataSha256);
      if (v.depositData !== undefined) expect(bytesToHex(data), v.id).toBe(v.depositData);
      const event = relayEvent(c.record.subarray(3, 35), c.index, callHash);
      expect(event.topics.map(bytesToHex), v.id).toEqual(v.topics);
      expect(bytesToHex(event.data), v.id).toBe(v.data);
    }
    expect(new Set(file.calls.map((c) => c.callHash)).size).toBe(file.calls.length);
  });

  test("the real ballot's calls carry ballot-v5-records.json's bytes, and the hash binds the root", () => {
    const ballot = v5.ballots.find((b) => b.id === "ok-newest-step");
    const calls = file.calls.filter((c) => c.ballot === "ok-newest-step");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c.record).toBe(ballot?.encoding);
    const one = file.calls.find((c) => c.id === "v5-ballot");
    const other = file.calls.find((c) => c.id === "v5-ballot-other-root");
    if (one === undefined || other === undefined) throw new Error("no v5-ballot calls");
    for (const k of [
      "l1ChainId",
      "relay",
      "index",
      "l1Block",
      "l1Timestamp",
      "gasLimit",
      "record",
    ] as const)
      expect(other[k], k).toBe(one[k]);
    expect(other.root).not.toBe(one.root);
    expect(other.callHash).not.toBe(one.callHash);
    expect(other.fixedCallHash).toBe(one.fixedCallHash);
  });

  test("framing", () => {
    expect(new Set(file.framing.map((v) => v.result))).toEqual(
      new Set(["framed", "relay-too-large", "relay-truncated", "relay-record-type"]),
    );
    for (const v of file.framing) {
      const record = recordOf(v);
      expect(frame(record) ?? "framed", v.id).toBe(v.result);
      if (v.result === "framed")
        expect(bytesToHex(record.subarray(3, 35)), v.id).toBe(v.definitionHash);
    }
    expect(file.framing.find((v) => v.id === "max-relay-record")?.result).toBe("relay-too-large");
  });

  test("calldata", () => {
    for (const v of file.calldata) {
      const calldata = hex(v.calldata);
      const decoded = decodeRelayRollingBallotCalldata(calldata);
      if (v.result === "canonical") {
        expect(decoded, v.id).not.toBeNull();
        if (decoded === null) continue;
        expect(decoded.gasLimit.toString(), v.id).toBe(v.gasLimit);
        expect(bytesToHex(decoded.root), v.id).toBe(v.root);
        expect(bytesToHex(decoded.record), v.id).toBe(v.record);
        expect(
          bytesToHex(relayRollingBallotCalldata(decoded.gasLimit, decoded.root, decoded.record)),
          v.id,
        ).toBe(v.calldata);
      } else {
        expect(v.result, v.id).toBe("relay-calldata");
        expect(decoded, v.id).toBeNull();
      }
    }
  });

  // One relay, both calls: one count, a word per index of its own call's
  // kind, and one accumulator over every BallotRelayed (L1 relay, State).
  test("the relay's one sequence of both calls", () => {
    const { sequence } = file;
    const relay = hex(sequence.relay);
    const chainId = BigInt(sequence.l1ChainId);
    let acc = eventAccumulatorGenesis(chainId, relay);
    expect(bytesToHex(acc)).toBe(sequence.genesis);
    expect(new Set(sequence.calls.map((c) => c.call))).toEqual(new Set(["fixed", "rolling"]));
    const base = BigInt(
      `0x${bytesToHex(
        keccak_256(word(BigInt(`0x${bytesToHex(keccak_256(utf8("abolish.ballot-relay")))}`) - 1n)),
      )}`,
    );
    for (const [n, c] of sequence.calls.entries()) {
      expect(c.index).toBe(String(n));
      const record = hex(c.record);
      const call = {
        l1ChainId: chainId,
        relay,
        index: BigInt(c.index),
        l1Block: BigInt(c.l1Block),
        l1Timestamp: BigInt(c.l1Timestamp),
        gasLimit: BigInt(c.gasLimit),
        record,
      };
      const callHash =
        c.call === "fixed"
          ? relayCallHash(call)
          : relayRollingCallHash({ ...call, root: hex(c.root ?? "") });
      expect(bytesToHex(callHash), c.index).toBe(c.callHash);
      const slot = keccak_256(concatBytes(word(call.index), word((base & ~0xffn) + 1n)));
      expect(bytesToHex(slot), c.index).toBe(c.slot);
      const event = relayEvent(record.subarray(3, 35), call.index, callHash);
      expect(event.topics.map(bytesToHex), c.index).toEqual(c.topics);
      expect(bytesToHex(event.data), c.index).toBe(c.data);
      acc = eventAccumulatorStep(acc, BigInt(n), {
        block: call.l1Block,
        timestamp: call.l1Timestamp,
        topics: event.topics,
        data: event.data,
      });
      expect(bytesToHex(acc), c.index).toBe(c.accumulator);
    }
    expect(sequence.count).toBe(String(sequence.calls.length));
  });
});

describe("relay rolling-call properties", () => {
  const record = fc
    .tuple(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.uint8Array({ maxLength: 300 }))
    .map(([definition, body]) => concatBytes(Uint8Array.of(0x00, 0x02, 0x05), definition, body));
  const u64Arb = fc.bigInt({ min: 0n, max: U64_MAX });
  const root = fc.uint8Array({ minLength: 32, maxLength: 32 });
  const call = fc.record({
    l1ChainId: u64Arb,
    relay: fc.uint8Array({ minLength: 20, maxLength: 20 }),
    index: u64Arb,
    l1Block: u64Arb,
    l1Timestamp: u64Arb,
    gasLimit: u64Arb,
    root,
    record,
  });

  test("changing any field of a call, its root included, changes its hash", () => {
    fc.assert(
      fc.property(call, fc.nat(), fc.nat({ max: 7 }), (c, at, which) => {
        const base = bytesToHex(relayRollingCallHash(c));
        // T-71: the first call's word for the same fields is another word.
        expect(bytesToHex(relayCallHash(c))).not.toBe(base);
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
          { ...c, root: flip(c.root) },
          { ...c, record: flip(c.record) },
        ][which];
        if (changed === undefined) return;
        expect(bytesToHex(relayRollingCallHash(changed))).not.toBe(base);
      }),
      { numRuns },
    );
  });

  test("calldata round-trips, and a changed head or padding byte is refused", () => {
    fc.assert(
      fc.property(
        u64Arb,
        root,
        record,
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (gas, r, rec, at, x) => {
          const calldata = relayRollingBallotCalldata(gas, r, rec);
          const decoded = decodeRelayRollingBallotCalldata(calldata);
          expect(decoded?.gasLimit).toBe(gas);
          expect(bytesToHex(decoded?.root ?? new Uint8Array())).toBe(bytesToHex(r));
          expect(bytesToHex(decoded?.record ?? new Uint8Array())).toBe(bytesToHex(rec));
          const i = at % calldata.length;
          const changed = calldata.slice();
          changed[i] = (changed[i] ?? 0) ^ x;
          const again = decodeRelayRollingBallotCalldata(changed);
          if (again !== null)
            expect(
              bytesToHex(relayRollingBallotCalldata(again.gasLimit, again.root, again.record)),
            ).toBe(bytesToHex(changed));
          // The selector, the gas word's top 24 bytes, the offset and the
          // padding are fixed; the root's word is any 32 bytes (T-17).
          const fixedByte = i < 28 || (i >= 68 && i < 100) || i >= 132 + rec.length;
          if (fixedByte) expect(again).toBeNull();
          if (i >= 36 && i < 68) expect(again).not.toBeNull();
          expect(
            decodeRelayRollingBallotCalldata(concatBytes(calldata, Uint8Array.of(0))),
          ).toBeNull();
        },
      ),
      { numRuns },
    );
  });

  test("MAX_ROLLING_RELAY_RECORD is the longest record whose deposit fits the portal's cap", () => {
    const fits = (n: number) =>
      relayRollingDepositData(0n, 0n, 0n, 0n, new Uint8Array(32), new Uint8Array(n)).length <=
      PORTAL_MAX_DATA;
    expect(MAX_ROLLING_RELAY_RECORD).toBe(MAX_RELAY_RECORD - 32);
    expect(fits(MAX_ROLLING_RELAY_RECORD)).toBe(true);
    expect(fits(MAX_ROLLING_RELAY_RECORD + 1)).toBe(false);
  });
});
