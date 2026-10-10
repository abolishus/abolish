import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";
import { parseRsp, readVendored } from "./harness.ts";

// NIST CAVP SHA-256 byte-oriented short messages: the audited @noble/hashes
// SHA-256 we rely on (content addressing, docs/spec/content-addressing.md)
// agrees with the published vectors.
describe("@noble/hashes sha256 against NIST CAVP SHA256ShortMsg", () => {
  const records = parseRsp(readVendored("nist-cavp/SHA256ShortMsg.rsp").toString("ascii"));

  test("the file parses to all 65 vectors (0 to 512 bits) under L = 32", () => {
    // A parser that dropped vectors would otherwise pass with fewer checks.
    expect(records.map((r) => Number(r.fields["Len"]))).toEqual(
      Array.from({ length: 65 }, (_, i) => i * 8),
    );
    for (const r of records) expect(r.params).toEqual({ L: "32" });
  });

  test.each(records.map((r) => [r.fields["Len"], r.fields] as const))(
    "Len = %s",
    (_len, fields) => {
      const bits = Number(fields["Len"]);
      // CAVP writes the empty message as "00" with Len = 0; Len is authoritative.
      const msg = hexToBytes(fields["Msg"] ?? "").subarray(0, bits / 8);
      expect(bytesToHex(sha256(msg))).toBe(fields["MD"]);
    },
  );
});
