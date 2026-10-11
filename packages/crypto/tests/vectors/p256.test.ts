import { p256 } from "@noble/curves/nist.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";
import { signMessage, verifyMessage } from "../../src/trustee.ts";
import { readVendored } from "./harness.ts";
import { rfcSection } from "./rfc.ts";

// Published vectors for the ECDSA configuration trustee signatures rely on
// (docs/spec/trustee-identity.md, ADR 0012): P-256, SHA-256, RFC 6979 nonces.
// They check @noble/curves through our own signing and verification rules,
// over raw messages; the DS framing on top is covered by trustee.json.

const N = p256.Point.Fn.ORDER;
const HALF_N = (N - 1n) / 2n;
const be32 = (v: bigint) => hexToBytes(v.toString(16).padStart(64, "0"));
const compress = (x: string, y: string) =>
  p256.Point.fromAffine({ x: BigInt(`0x${x}`), y: BigInt(`0x${y}`) }).toBytes(true);
const ascii = (s: string) => new TextEncoder().encode(s);

describe("RFC 6979 A.2.5: P-256 with SHA-256", () => {
  // Field names repeat across key, SHA-1 … SHA-512 and the two messages, so
  // the section is read in order and the SHA-256 blocks picked by heading.
  const lines = rfcSection(
    "rfc6979",
    "A.2.5.  ECDSA, 256 Bits (Prime Field)",
    "A.2.6.  ECDSA, 384 Bits (Prime Field)",
  );
  const value = (name: string, from = 0) => {
    const i = lines.findIndex((l, j) => j >= from && l.startsWith(`   ${name} = `));
    if (i === -1) throw new Error(`no ${name}`);
    return { value: (lines[i] ?? "").slice(`   ${name} = `.length).trim().toLowerCase(), at: i };
  };
  const d = value("x").value;
  const ux = value("Ux").value;
  const uy = value("Uy").value;
  const cases = (["sample", "test"] as const).map((msg) => {
    const at = lines.indexOf(`   With SHA-256, message = "${msg}":`);
    if (at === -1) throw new Error(`no SHA-256 block for ${msg}`);
    return { msg, r: value("r", at).value, s: value("s", at).value };
  });

  test("the key pair parses and the public key matches the secret", () => {
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(bytesToHex(p256.getPublicKey(hexToBytes(d), true))).toBe(bytesToHex(compress(ux, uy)));
    expect(cases).toHaveLength(2);
  });

  test.each(cases)('message "$msg": RFC 6979 r, and s after the low-s rule', ({ msg, r, s }) => {
    const sig = signMessage(hexToBytes(d), ascii(msg));
    const sv = BigInt(`0x${s}`);
    expect(bytesToHex(sig.subarray(0, 32))).toBe(r);
    // RFC 6979 doesn't normalise s; ours always lands in the low half.
    expect(bytesToHex(sig.subarray(32))).toBe(bytesToHex(be32(sv > HALF_N ? N - sv : sv)));
    expect(verifyMessage(compress(ux, uy), ascii(msg), sig)).toBe(true);
    // The published (unnormalised) form verifies exactly when it is low-s.
    const published = hexToBytes(r + s);
    expect(verifyMessage(compress(ux, uy), ascii(msg), published)).toBe(sv <= HALF_N);
  });

  test("one of the two published signatures has high s, so normalisation is exercised", () => {
    expect(cases.filter((c) => BigInt(`0x${c.s}`) > HALF_N)).toHaveLength(1);
  });
});

interface SigVerCase {
  readonly msg: string;
  readonly qx: string;
  readonly qy: string;
  readonly r: string;
  readonly s: string;
  readonly pass: boolean;
}

/** The `[P-256,SHA-256]` section of SigVer.rsp, strictly: six fields per case. */
function sigVerP256Sha256(): SigVerCase[] {
  const lines = readVendored("nist-cavp/SigVer.rsp").toString("ascii").split("\r\n");
  const start = lines.indexOf("[P-256,SHA-256]");
  if (start === -1) throw new Error("no [P-256,SHA-256] section");
  const out: SigVerCase[] = [];
  let f: Record<string, string> = {};
  const names = ["Msg", "Qx", "Qy", "R", "S", "Result"];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("[")) break;
    if (line === "") continue;
    const m = /^(Msg|Qx|Qy|R|S|Result) = (.+)$/.exec(line);
    if (m === null) throw new Error(`unrecognised: ${JSON.stringify(line)}`);
    const [, name = "", v = ""] = m;
    if (name !== names[Object.keys(f).length]) throw new Error(`out of order: ${line}`);
    f[name] = v;
    if (name === "Result") {
      const result = /^(P \(0 \)|F \([1-4] - (?:Message|R|S|Q) changed\))$/.exec(v);
      if (result === null) throw new Error(`bad result: ${v}`);
      for (const k of ["Msg", "Qx", "Qy", "R", "S"])
        if (!/^[0-9a-f]+$/.test(f[k] ?? "")) throw new Error(`bad ${k}`);
      out.push({
        msg: f["Msg"] ?? "",
        qx: f["Qx"] ?? "",
        qy: f["Qy"] ?? "",
        r: f["R"] ?? "",
        s: f["S"] ?? "",
        pass: v.startsWith("P"),
      });
      f = {};
    }
  }
  return out;
}

describe("NIST CAVP ECDSA SigVer [P-256,SHA-256]", () => {
  const cases = sigVerP256Sha256();

  test("the section parses to all 15 cases, some passing and some failing", () => {
    expect(cases).toHaveLength(15);
    expect(cases.some((c) => c.pass)).toBe(true);
    expect(cases.some((c) => !c.pass)).toBe(true);
  });

  test.each(cases.map((c, i) => [i + 1, c] as const))("case %i", (_i, c) => {
    // Failing cases include changed keys, which may not be on the curve.
    let key: Uint8Array;
    try {
      key = compress(c.qx, c.qy);
    } catch {
      expect(c.pass).toBe(false);
      return;
    }
    const r = BigInt(`0x${c.r}`);
    const s = BigInt(`0x${c.s}`);
    const msg = hexToBytes(c.msg);
    const sig = new Uint8Array([...be32(r), ...be32(s)]);
    // ECDSA accepts high s; the low-s rule rejects it, and accepts its twin.
    expect(verifyMessage(key, msg, sig)).toBe(c.pass && s <= HALF_N);
    if (c.pass && s > HALF_N)
      expect(verifyMessage(key, msg, new Uint8Array([...be32(r), ...be32(N - s)]))).toBe(true);
  });
});
