import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";
import { rfcSection } from "./rfc.ts";

// HKDF-SHA-256 from @noble/hashes, the key derivation of the identity backup
// (docs/spec/identity-backup.md), against RFC 5869's own SHA-256 test cases.

interface HkdfCase {
  readonly ikm: string;
  readonly salt: string;
  readonly info: string;
  readonly length: number;
  readonly okm: string;
}

/**
 * RFC 5869 Appendix A test cases: `NAME = 0x<hex> (n octets)` or
 * `NAME = (0 octets)`, hex continued on deeper-indented lines, `L = n`. Each
 * value's octet count is checked against its hex, so a dropped line fails.
 */
function parseCase(lines: readonly string[]): HkdfCase {
  const fields = new Map<string, string>();
  let last: string | undefined;
  for (const line of lines) {
    const f = /^ {3}([A-Za-z]+) *= (.*)$/.exec(line);
    if (f !== null) {
      last = f[1] ?? "";
      fields.set(last, (f[2] ?? "").trim());
    } else if (last !== undefined && /^ {10}[0-9a-f]/.test(line)) {
      fields.set(last, `${fields.get(last)} ${line.trim()}`);
    } else if (
      /^ {3}\S/.test(line) ||
      line.trim() === "" ||
      // Page footers and headers.
      /^Krawczyk & Eronen .*\[Page \d+\]$/.test(line) ||
      /^RFC 5869 .*May 2010$/.test(line)
    )
      last = undefined;
    else throw new Error(`unrecognised: ${JSON.stringify(line)}`);
  }
  const hex = (name: string) => {
    const v = fields.get(name);
    const m = v === undefined ? null : /^(?:0x([0-9a-f ]+) )?\((\d+) octets\)$/.exec(v);
    if (m === null) throw new Error(`no field ${name}`);
    const h = (m[1] ?? "").replaceAll(" ", "");
    expect(h.length).toBe(2 * Number(m[2]));
    return h;
  };
  expect(fields.get("Hash")).toBe("SHA-256");
  return {
    ikm: hex("IKM"),
    salt: hex("salt"),
    info: hex("info"),
    length: Number(fields.get("L")),
    okm: hex("OKM"),
  };
}

describe("RFC 5869 Appendix A: HKDF with SHA-256", () => {
  const cases = [
    ["A.1.  Test Case 1", "A.2.  Test Case 2"],
    ["A.2.  Test Case 2", "A.3.  Test Case 3"],
    ["A.3.  Test Case 3", "A.4.  Test Case 4"],
  ].map(([from = "", to = ""]) => parseCase(rfcSection("rfc5869", from, to)));

  test("parses all three SHA-256 test cases", () => {
    expect(cases.map((c) => c.length)).toEqual([42, 82, 42]);
  });

  test("derives each published OKM", () => {
    for (const c of cases) {
      const okm = hkdf(
        sha256,
        hexToBytes(c.ikm),
        // RFC 5869 §2.2: a zero-length salt is HashLen zero octets.
        c.salt === "" ? undefined : hexToBytes(c.salt),
        hexToBytes(c.info),
        c.length,
      );
      expect(bytesToHex(okm)).toBe(c.okm);
    }
  });
});
