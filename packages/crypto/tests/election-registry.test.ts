import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { electionId } from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/election-registry.json, from the independent Python
// implementation in scripts/election-registry-vectors.py
// (docs/spec/contracts.md, Election registry; T-23, T-24, T-34). Expected
// values all come from the file.

interface VectorFile {
  readonly format: string;
  readonly tag: string;
  readonly electionIds: readonly {
    readonly id: string;
    readonly chainId: string;
    readonly registry: string;
    readonly counter: string;
    readonly electionId: string;
  }[];
  readonly rejected: readonly {
    readonly id: string;
    readonly chainId: string;
    readonly registry: string;
    readonly counter: string;
  }[];
}

const file = JSON.parse(
  readFileSync(new URL("election-registry.json", SPEC_VECTORS), "utf8"),
) as VectorFile;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

describe("election-registry vectors", () => {
  test("file format and tag", () => {
    expect(file.format).toBe("abolish-election-registry-vectors/1");
    expect(file.tag).toBe("abolish/v1/election-id");
    expect(file.electionIds.length).toBeGreaterThan(0);
    expect(file.rejected.length).toBeGreaterThan(0);
  });

  test.each(file.electionIds.map((v) => [v.id, v] as const))("%s", (_, v) => {
    const id = electionId(BigInt(v.chainId), hex(v.registry), BigInt(v.counter));
    expect(bytesToHex(id)).toBe(v.electionId);
  });

  test.each(file.rejected.map((v) => [v.id, v] as const))("rejects %s", (_, v) => {
    expect(() => electionId(BigInt(v.chainId), hex(v.registry), BigInt(v.counter))).toThrow(
      RangeError,
    );
  });
});

describe("electionId", () => {
  const u64 = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n });
  const address = fc.uint8Array({ minLength: 20, maxLength: 20 });

  test("changes with the chain, the registry or the counter", () => {
    // Uniqueness across registries and chains is what keeps one election's
    // checkpoints from being attributed to another (docs/spec/board.md).
    fc.assert(
      fc.property(u64, address, u64, u64, address, u64, (c1, r1, n1, c2, r2, n2) => {
        const same = c1 === c2 && bytesToHex(r1) === bytesToHex(r2) && n1 === n2;
        const equal = bytesToHex(electionId(c1, r1, n1)) === bytesToHex(electionId(c2, r2, n2));
        expect(equal).toBe(same);
      }),
      { numRuns },
    );
  });

  test("rejects a registry that isn't 20 bytes", () => {
    expect(() => electionId(1n, new Uint8Array(19), 0n)).toThrow();
    expect(() => electionId(1n, new Uint8Array(21), 0n)).toThrow();
  });
});
