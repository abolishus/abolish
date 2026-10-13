import fc from "fast-check";
import { electionStubHash, keySetHash, verifyCeremonyRegistration } from "@abolishus/crypto";
import { p256 } from "@noble/curves/nist.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, test } from "vite-plus/test";
import {
  displayText,
  type L2Deployment,
  newTrustees,
  PANEL,
  placeholder,
  runCeremony,
} from "../src/election.ts";
import { bytesCalldata, ceremonyRegistration, createAddress } from "../src/l2.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const asNumber = (b: Uint8Array) => Number(BigInt(`0x${hex(b)}`));

test("createAddress gives the addresses Anvil's first account deploys to", () => {
  const sender = hexToBytes("f39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  expect(hex(createAddress(sender, 0n))).toBe("5fbdb2315678afecb367f032d93f642f64180aa3");
  expect(hex(createAddress(sender, 1n))).toBe("e7f1725e7734ce288f8367e1bb143e90bb3f0512");
  expect(hex(createAddress(sender, 3n))).toBe("cf7ed3acca5a467e9e704c703e8d87f634fb0fc9");
});

test("one-bytes-argument calldata is the one encoding CanonicalCalldata accepts", () => {
  const selector = hex(
    keccak_256(new TextEncoder().encode("registerDefinition(bytes)")).slice(0, 4),
  );
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 400 }), (arg) => {
      const data = bytesCalldata("registerDefinition(bytes)", arg);
      expect(hex(data.slice(0, 4))).toBe(selector);
      const args = data.slice(4);
      expect(args.length).toBe(64 + Math.ceil(arg.length / 32) * 32);
      expect(asNumber(args.slice(0, 32))).toBe(32);
      expect(asNumber(args.slice(32, 64))).toBe(arg.length);
      expect(args.slice(64, 64 + arg.length)).toEqual(arg);
      expect(args.slice(64 + arg.length).every((x) => x === 0)).toBe(true);
    }),
    { numRuns },
  );
});

const l2: L2Deployment = {
  l2ChainId: 31338n,
  electionRegistry: placeholder("test/election-registry"),
  board: placeholder("test/board"),
  trusteeRegistry: placeholder("test/trustee-registry"),
  groupRegistry: placeholder("test/group-registry"),
  l1Relay: placeholder("test/l1-relay"),
};
const timing = {
  l1ChainId: 31337n,
  l1Anchor: placeholder("test/anchor"),
  opensAt: 1_800_000_000n,
  closesAt: 1_800_001_800n,
  inclusionBound: 600,
};

test("the ceremony registration record has the trustee registry's layout, every seat signing", () => {
  const trustees = newTrustees();
  const absent = 2;
  const c = runCeremony(timing, l2, trustees, displayText(), { counter: 0n, absent });
  const record = ceremonyRegistration(l2, trustees, c);
  const d = c.definition;
  const stubHash = electionStubHash(d);
  const present = PANEL.size - absent;

  expect(record.slice(0, 32)).toEqual(d.panel_id);
  expect(record.slice(32, 64)).toEqual(stubHash);
  expect(record.slice(64, 96)).toEqual(d.ceremony_transcript_hash);
  expect(record[96]).toBe(present);
  const approvalsAt = 97 + 97 * present + 1;
  expect(record[approvalsAt - 1]).toBe(present);
  expect(record.length).toBe(approvalsAt + 65 * present);

  // Each seat: its index, its KEM key's hash and its signing key's point.
  const entries = Array.from({ length: present }, (_, i) => {
    const at = 97 + 97 * i;
    const x = BigInt(`0x${hex(record.slice(at + 33, at + 65))}`);
    const y = BigInt(`0x${hex(record.slice(at + 65, at + 97))}`);
    return {
      index: record[at] as number,
      kemKeyHash: record.slice(at + 1, at + 33),
      signingKey: p256.Point.fromAffine({ x, y }).toBytes(true),
    };
  });
  expect(entries.map((e) => e.index)).toEqual([1, 2, 3, 4, 5]);
  const setHash = keySetHash(entries);
  for (let i = 0; i < present; i++) {
    const at = approvalsAt + 65 * i;
    const index = record[at] as number;
    expect(index).toBe(i + 1);
    const reg = {
      l2ChainId: d.l2_chain_id,
      trusteeRegistry: l2.trusteeRegistry,
      index,
      stubHash,
      ceremonyTranscriptHash: d.ceremony_transcript_hash,
      keySetHash: setHash,
    };
    const sig = record.slice(at + 1, at + 65);
    expect(verifyCeremonyRegistration(trustees.panel, reg, sig)).toBe(true);
    // Bound to the registry: the same signature under another one fails.
    expect(
      verifyCeremonyRegistration(
        trustees.panel,
        { ...reg, trusteeRegistry: l2.groupRegistry },
        sig,
      ),
    ).toBe(false);
  }
});
