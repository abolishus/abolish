import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { newIdentitySecretWith, sealIdentityBackupWith } from "../src/identity-backup.ts";
import * as entry from "../src/index.ts";
import {
  BABYJUBJUB_ORDER,
  DecodeError,
  decodeIdentityBackup,
  encodeIdentityBackup,
  IdentityBackupError,
  identityBackupId,
  identityBackupLocator,
  identityBackupPrfSalt,
  isIdentitySecret,
  newIdentitySecret,
  openIdentityBackup,
  sealIdentityBackup,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/identity-backup.json comes from an independent Python
// implementation (scripts/identity-backup-vectors.py), so these expected
// values never come from the code under test.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

interface Vectors {
  readonly format: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly order: string;
  readonly prfSalt: string;
  readonly secrets: readonly { id: string; encoding: string; isSecret: boolean }[];
  readonly sampling: readonly { id: string; draws: readonly string[]; secret: string }[];
  readonly backups: readonly {
    id: string;
    prfOutput: string;
    secret: string;
    nonce: string;
    wrapKey: string;
    locator: string;
    backupId: string;
    aad: string;
    envelope: string;
  }[];
  readonly open: readonly { id: string; prfOutput: string; envelope: string; code: string }[];
}

const V = JSON.parse(
  readFileSync(new URL("identity-backup.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const DECODE_CODES = new Set([
  "truncated",
  "trailing-bytes",
  "unknown-record-type",
  "unknown-version",
]);

/** The error code `openIdentityBackup` throws, or the opened secret as hex. */
function opened(prf: Uint8Array, envelope: Uint8Array): string {
  try {
    return bytesToHex(openIdentityBackup(prf, envelope));
  } catch (e) {
    if (e instanceof DecodeError || e instanceof IdentityBackupError) return e.code;
    throw e;
  }
}

describe("identity-backup vectors", () => {
  test("the file is the format this test reads, with every section populated", () => {
    expect(V.format).toBe("abolish-identity-backup-vectors/1");
    expect([V.secrets.length, V.sampling.length, V.backups.length, V.open.length]).toEqual([
      10, 5, 4, 20,
    ]);
    expect(BigInt(V.order)).toBe(BABYJUBJUB_ORDER);
  });

  test("the PRF salt is H(DS(prf-salt tag, ''))", () => {
    expect(bytesToHex(identityBackupPrfSalt())).toBe(V.prfSalt);
  });

  test("identity secrets: exactly 32 bytes with 1 ≤ s < l", () => {
    for (const v of V.secrets) expect(isIdentitySecret(hex(v.encoding)), v.id).toBe(v.isSecret);
  });

  test("sampling keeps the first draw in range after clearing the top 5 bits", () => {
    for (const v of V.sampling) {
      const draws = v.draws.map(hex);
      let i = 0;
      const secret = newIdentitySecretWith(() => {
        const d = draws[i++];
        if (d === undefined) throw new Error(`${v.id}: drew past the vector`);
        return d;
      });
      expect(bytesToHex(secret), v.id).toBe(v.secret);
      expect(i, v.id).toBe(draws.length);
    }
  });

  test("each backup's locator, row id and envelope", () => {
    for (const v of V.backups) {
      const prf = hex(v.prfOutput);
      expect(bytesToHex(identityBackupLocator(prf)), v.id).toBe(v.locator);
      expect(bytesToHex(identityBackupId(hex(v.locator))), v.id).toBe(v.backupId);
      const sealed = sealIdentityBackupWith(prf, hex(v.secret), hex(v.nonce));
      expect(bytesToHex(sealed.locator), v.id).toBe(v.locator);
      expect(bytesToHex(sealed.envelope), v.id).toBe(v.envelope);
      expect(opened(prf, hex(v.envelope)), v.id).toBe(v.secret);
      // The published key and associated data open it with the AEAD alone,
      // so a third party can check the derivations independently.
      const env = hex(v.envelope);
      const plain = chacha20poly1305(hex(v.wrapKey), env.slice(3, 15), hex(v.aad)).decrypt(
        env.slice(15),
      );
      expect(bytesToHex(plain), v.id).toBe(v.secret);
    }
  });

  test("each envelope that doesn't open fails with its code", () => {
    for (const v of V.open) expect(opened(hex(v.prfOutput), hex(v.envelope)), v.id).toBe(v.code);
    for (const v of V.open)
      if (DECODE_CODES.has(v.code))
        expect(() => decodeIdentityBackup(hex(v.envelope)), v.id).toThrow(DecodeError);
  });
});

describe("identity-backup properties", () => {
  const bytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n });
  const secret = fc
    .bigInt({ min: 1n, max: BABYJUBJUB_ORDER - 1n })
    .map((s) => hex(s.toString(16).padStart(64, "0")));

  test("seal then open gives the secret back, and nothing else opens it", () => {
    fc.assert(
      fc.property(bytes(32), bytes(32), secret, (prf, other, s) => {
        const { locator, envelope } = sealIdentityBackup(prf, s);
        expect(envelope.length).toBe(63);
        expect(bytesToHex(locator)).toBe(bytesToHex(identityBackupLocator(prf)));
        expect(opened(prf, envelope)).toBe(bytesToHex(s));
        if (bytesToHex(other) !== bytesToHex(prf))
          expect(opened(other, envelope)).toBe("backup-open");
      }),
      { numRuns },
    );
  });

  test("any one-bit change of an envelope's body fails to open", () => {
    const v = V.backups[0];
    if (v === undefined) throw new Error("no backup vector");
    const env = hex(v.envelope);
    fc.assert(
      fc.property(fc.integer({ min: 3 * 8, max: 63 * 8 - 1 }), (bit) => {
        const bad = new Uint8Array(env);
        bad[bit >> 3] = (bad[bit >> 3] as number) ^ (1 << (bit & 7));
        expect(opened(hex(v.prfOutput), bad)).toBe("backup-open");
      }),
      { numRuns },
    );
  });

  test("decode(encode(x)) = x, and every accepted encoding re-encodes to itself", () => {
    fc.assert(
      fc.property(bytes(12), bytes(48), (nonce, sealed) => {
        const encoding = encodeIdentityBackup({ nonce, sealed });
        const decoded = decodeIdentityBackup(encoding);
        expect(bytesToHex(decoded.nonce)).toBe(bytesToHex(nonce));
        expect(bytesToHex(decoded.sealed)).toBe(bytesToHex(sealed));
        expect(bytesToHex(encodeIdentityBackup(decoded))).toBe(bytesToHex(encoding));
      }),
      { numRuns },
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 80 }), (b) => {
        let decoded;
        try {
          decoded = decodeIdentityBackup(b);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
          return;
        }
        expect(bytesToHex(encodeIdentityBackup(decoded))).toBe(bytesToHex(b));
      }),
      { numRuns },
    );
  });

  test("fresh secrets and nonces are identity secrets and differ", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const s = newIdentitySecret();
      expect(isIdentitySecret(s)).toBe(true);
      seen.add(bytesToHex(s));
    }
    expect(seen.size).toBe(64);
    const s = hex(V.backups[0]?.secret ?? "");
    const prf = new Uint8Array(32);
    const a = sealIdentityBackup(prf, s).envelope;
    const b = sealIdentityBackup(prf, s).envelope;
    expect(bytesToHex(a.slice(3, 15))).not.toBe(bytesToHex(b.slice(3, 15)));
  });
});

describe("identity-backup inputs", () => {
  const prf = new Uint8Array(32).fill(7);
  const s = hex(V.backups[0]?.secret ?? "");

  test("refuses to seal anything but an identity secret", () => {
    for (const bad of V.secrets.filter((v) => !v.isSecret))
      expect(() => sealIdentityBackup(prf, hex(bad.encoding)), bad.id).toThrow(RangeError);
  });

  test("refuses PRF outputs, locators and nonces of the wrong length or type", () => {
    for (const n of [0, 31, 33, 64]) {
      expect(() => identityBackupLocator(new Uint8Array(n))).toThrow(RangeError);
      expect(() => identityBackupId(new Uint8Array(n))).toThrow(RangeError);
      expect(() => sealIdentityBackup(new Uint8Array(n), s)).toThrow(RangeError);
    }
    expect(() => sealIdentityBackupWith(prf, s, new Uint8Array(11))).toThrow(RangeError);
    expect(() => identityBackupLocator([...prf] as never)).toThrow(TypeError);
    expect(() => identityBackupLocator(new Proxy(prf, {}))).toThrow(TypeError);
    expect(isIdentitySecret([...s] as never)).toBe(false);
  });

  test("doesn't change or keep the caller's buffers", () => {
    const p = new Uint8Array(prf);
    const secret = new Uint8Array(s);
    sealIdentityBackup(p, secret);
    expect(bytesToHex(p)).toBe(bytesToHex(prf));
    expect(bytesToHex(secret)).toBe(bytesToHex(s));
  });

  test("the sampler wipes each draw and gives up on a source that never lands in range", () => {
    const draws: Uint8Array[] = [];
    expect(() =>
      newIdentitySecretWith((n) => {
        const d = new Uint8Array(n);
        draws.push(d);
        return d;
      }),
    ).toThrow(Error);
    expect(draws.length).toBe(128);
    const kept = new Uint8Array(32).fill(0x01);
    newIdentitySecretWith(() => kept);
    expect(kept.every((x) => x === 0)).toBe(true);
  });

  test("the entry point doesn't export the seams that take randomness", () => {
    expect("sealIdentityBackupWith" in entry).toBe(false);
    expect("newIdentitySecretWith" in entry).toBe(false);
  });
});
