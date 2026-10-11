import { shake128 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { expect, test } from "vite-plus/test";

// ML-KEM-768 from @noble/post-quantum, the post-quantum half of share
// encryption (docs/spec/share-encryption.md), against the accumulated FIPS 203
// vectors of Go's crypto/mlkem tests (TestAccumulated in
// https://github.com/golang/go/blob/go1.25.0/src/crypto/mlkem/mlkem_test.go):
// a SHAKE-128 stream with empty input gives each iteration's 64-byte seed,
// 32-byte message and 1088-byte random ciphertext, and a second SHAKE-128
// absorbs ek, ct, the shared secret and the implicit-rejection secret. The
// random ciphertexts exercise implicit rejection (FIPS 203 Algorithm 18).
// The expected hashes are copied from that file, not vendored (no allowlisted
// publisher carries them).
const ACCUMULATED: Readonly<Record<number, string>> = {
  100: "1114b1b6699ed191734fa339376afa7e285c9e6acf6ff0177d346696ce564415",
  10000: "8a518cc63da366322a8e7a818c7a0d63483cb3528d34a4cf42f35d5ad73f22fc",
};

function accumulate(n: number): string {
  const step = 64 + 32 + 1088;
  const stream = shake128(new Uint8Array(), { dkLen: n * step });
  const acc = shake128.create({});
  for (let i = 0; i < n; i++) {
    const at = i * step;
    const { publicKey, secretKey } = ml_kem768.keygen(stream.slice(at, at + 64));
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(
      publicKey,
      stream.slice(at + 64, at + 96),
    );
    expect(bytesToHex(ml_kem768.decapsulate(cipherText, secretKey))).toBe(bytesToHex(sharedSecret));
    acc.update(publicKey).update(cipherText).update(sharedSecret);
    acc.update(ml_kem768.decapsulate(stream.slice(at + 96, at + step), secretKey));
  }
  return bytesToHex(acc.xof(32));
}

test("ML-KEM-768 matches 100 accumulated FIPS 203 vectors", () => {
  expect(accumulate(100)).toBe(ACCUMULATED[100]);
});

test("ML-KEM-768 matches 10 000 accumulated FIPS 203 vectors", { timeout: 180_000 }, () => {
  expect(accumulate(10000)).toBe(ACCUMULATED[10000]);
});
