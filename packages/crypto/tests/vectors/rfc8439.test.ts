import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";
import { parseLabelledHex, rfcSection } from "./rfc.ts";

// ChaCha20-Poly1305 from @noble/ciphers, the AEAD of share encryption
// (docs/spec/share-encryption.md), against RFC 8439's own vectors.

function block(blocks: Map<string, string>, label: string, length: number): Uint8Array {
  const hex = blocks.get(label);
  if (hex === undefined) throw new Error(`no block ${label}`);
  expect(hex.length).toBe(2 * length);
  return hexToBytes(hex);
}

describe("RFC 8439 §2.8.2: AEAD_CHACHA20_POLY1305 encryption", () => {
  const b = parseLabelledHex(
    rfcSection(
      "rfc8439",
      "2.8.2.  Example and Test Vector for AEAD_CHACHA20_POLY1305",
      "3.  Implementation Advice",
    ),
  );

  test("seals the plaintext to the published ciphertext and tag", () => {
    const key = block(b, "Key", 32);
    const nonce = new Uint8Array([
      ...block(b, "32-bit fixed-common part", 4),
      ...block(b, "IV", 8),
    ]);
    const sealed = chacha20poly1305(key, nonce, block(b, "AAD", 12)).encrypt(
      block(b, "Plaintext", 114),
    );
    expect(bytesToHex(sealed)).toBe(
      bytesToHex(block(b, "Ciphertext", 114)) + bytesToHex(block(b, "Tag", 16)),
    );
  });
});

describe("RFC 8439 Appendix A.5: AEAD_CHACHA20_POLY1305 decryption", () => {
  const b = parseLabelledHex(
    rfcSection(
      "rfc8439",
      "A.5.  ChaCha20-Poly1305 AEAD Decryption",
      "Appendix B.  Performance Measurements of ChaCha20",
    ),
  );
  const key = block(b, "The ChaCha20 Key", 32);
  const nonce = block(b, "The nonce", 12);
  const aad = block(b, "The AAD", 12);
  const ct = block(b, "Ciphertext", 265);
  const tag = block(b, "Received Tag", 16);

  test("opens the published ciphertext to the published plaintext", () => {
    const plain = chacha20poly1305(key, nonce, aad).decrypt(new Uint8Array([...ct, ...tag]));
    expect(bytesToHex(plain)).toBe(bytesToHex(block(b, "Plaintext", 265)));
  });

  test("refuses it with a flipped tag bit", () => {
    const bad = new Uint8Array([...ct, ...tag]);
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    expect(() => chacha20poly1305(key, nonce, aad).decrypt(bad)).toThrow();
  });
});
