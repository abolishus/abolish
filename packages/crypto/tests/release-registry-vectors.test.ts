import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, test } from "vite-plus/test";
import { ds, H } from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/release-registry.json, printed by
// scripts/release-registry-vectors.py (P4-4 part 2b-2) with its own
// Keccak-256. Until the registry is in packages/contracts (part 2d) and 1.1
// in packages/verifier (part 2c), this checks the file against @noble's
// Keccak-256 and the release hash: the namespace, every slot, selector and
// topic, the history's logs and final words, and that every vector's release
// is the word its sequence's slot holds (T-41, T-64, T-36).
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);
const keccak = (b: Uint8Array) => keccak_256(b);
const word = (v: bigint) => hex(v.toString(16).padStart(64, "0"));
const big = (b: Uint8Array) => BigInt(`0x${toHex(b) || "0"}`);
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

interface Step {
  readonly description: string;
  readonly caller: "authority" | "other";
  readonly calldata: string;
  readonly timestamp: string;
  readonly refused?: number;
  readonly logs?: readonly { readonly topics: readonly string[]; readonly data: string }[];
}

interface Expect {
  readonly status: "pass" | "fail" | "unverifiable";
  readonly code?: string;
  readonly at?: Readonly<Record<string, unknown>>;
  readonly release?: {
    readonly sequence: string;
    readonly hash: string;
    readonly latest: string;
    readonly behind: string;
  };
}

interface RegistryFile {
  readonly format: string;
  readonly namespace: {
    readonly id: string;
    readonly base: string;
    readonly count: string;
    readonly releases: string;
  };
  readonly selectors: Readonly<Record<string, string>>;
  readonly topics: Readonly<Record<string, string>>;
  readonly slots: readonly {
    readonly sequence: string;
    readonly hash: string;
    readonly times: string;
  }[];
  readonly history: {
    readonly steps: readonly Step[];
    readonly storage: Readonly<Record<string, string>>;
  };
  readonly vectors: readonly {
    readonly id: string;
    readonly storage: Readonly<Record<string, string>>;
    readonly records: readonly string[];
    readonly sequence?: string;
    readonly expect: Expect;
  }[];
}

const file = JSON.parse(
  readFileSync(new URL("release-registry.json", SPEC_VECTORS), "utf8"),
) as RegistryFile;

const base = (() => {
  const n = big(keccak(utf8(file.namespace.id))) - 1n;
  return big(keccak(word(n))) & ~0xffn;
})();
const hashSlot = (s: bigint) => big(keccak(concat(word(s), word(base + 1n))));
const slotKey = (slot: bigint) => toHex(word(slot));
const releaseHash = (record: string) => toHex(H(ds("abolish/v1/release", hex(record))));

describe("release registry (docs/spec/contracts.md, Release registry)", () => {
  test("has its format and ERC-7201 namespace", () => {
    expect(file.format).toBe("abolish-release-registry-vectors/1");
    expect(file.namespace.id).toBe("abolish.release-registry");
    expect(file.namespace.base).toBe(slotKey(base));
    expect(file.namespace.count).toBe(slotKey(base));
    expect(file.namespace.releases).toBe(slotKey(base + 1n));
  });

  test("gives each sequence's hash and times slot, as Solidity lays out the mapping", () => {
    for (const s of file.slots) {
      const slot = hashSlot(BigInt(s.sequence));
      expect(s.hash, s.sequence).toBe(slotKey(slot));
      expect(s.times, s.sequence).toBe(slotKey(slot + 1n));
    }
  });

  test("gives the calls' selectors and the events' topics", () => {
    for (const [signature, selector] of Object.entries(file.selectors)) {
      expect(selector).toBe(toHex(keccak(utf8(signature)).slice(0, 4)));
    }
    for (const [signature, topic] of Object.entries(file.topics)) {
      expect(topic).toBe(toHex(keccak(utf8(signature))));
    }
  });

  test("logs each accepted call with its sequence and hash, and leaves the words they write", () => {
    const published = file.topics["ReleasePublished(uint64,bytes32,bytes32)"];
    const revoked = file.topics["ReleaseRevoked(uint64,bytes32)"];
    const hashes: string[] = [];
    for (const step of file.history.steps) {
      if (step.refused !== undefined) {
        expect(step.logs, step.description).toBeUndefined();
        continue;
      }
      const [log] = step.logs ?? [];
      const args = step.calldata.slice(8);
      if (step.calldata.startsWith(file.selectors["publish(bytes32,bytes32)"] ?? "-")) {
        expect(log?.topics).toEqual([published, slotKey(BigInt(hashes.length)), args.slice(0, 64)]);
        expect(log?.data).toBe(args.slice(64));
        hashes.push(args.slice(0, 64));
      } else {
        const s = Number(BigInt(`0x${args}`));
        expect(log?.topics).toEqual([revoked, args, hashes[s]]);
        expect(log?.data).toBe("");
      }
    }
    expect(file.history.storage[slotKey(base)]).toBe(slotKey(BigInt(hashes.length)));
    hashes.forEach((h, s) => {
      expect(file.history.storage[slotKey(hashSlot(BigInt(s)))]).toBe(h);
    });
  });

  test("lists 1.1's codes, each with a vector", () => {
    // The codes of docs/spec/verifier.md's Served client table (the rows
    // with a status); a code the generator gives that the table lacks, or one
    // the table has with no vector, fails here.
    const page = readFileSync(new URL("../verifier.md", SPEC_VECTORS), "utf8");
    const section = page.slice(
      page.indexOf("\n### Served client\n"),
      page.indexOf("\n### Procedure\n"),
    );
    const codes = [...section.matchAll(/^\| `([a-z0-9-]+)` +\| (?:fail|unverifiable) /gm)].map(
      (m) => m[1],
    );
    const given = new Set(file.vectors.flatMap((v) => (v.expect.code ? [v.expect.code] : [])));
    expect(new Set(codes)).toEqual(given);
  });

  test.each(file.vectors.map((v) => [v.id, v] as const))(
    "%s names the release its sequence's slot holds",
    (_id, v) => {
      const { release } = v.expect;
      if (release === undefined) return;
      expect(release.behind).toBe(String(BigInt(release.latest) - BigInt(release.sequence)));
      expect(v.storage[slotKey(hashSlot(BigInt(release.sequence)))]).toBe(release.hash);
      const held = v.records.some((r) => releaseHash(r) === release.hash);
      expect(held).toBe(v.expect.code !== "release-record-missing");
    },
  );
});
