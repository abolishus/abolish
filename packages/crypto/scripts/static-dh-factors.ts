// The factor search behind the static-DH table in
// docs/adr/0007-group-and-hash.md and docs/spec/group.md: Cheon's attack
// (EUROCRYPT 2006) turns d static-DH answers, for d dividing ℓ − 1 or ℓ + 1,
// into a loss of about ½·log₂ d bits, so the loss at a query budget depends
// on the factors of ℓ ± 1 (T-39). Trial division finds every prime factor
// below 2·10⁶; Pollard's rho (Brent's variant) then looks for one more in
// what remains. Run with `vp node packages/crypto/scripts/static-dh-factors.ts`.

import { argv } from "node:process";
import { pathToFileURL } from "node:url";

/** ristretto255's group order (RFC 9496). */
export const ELL = 2n ** 252n + 27742317777372353535851937790883648493n;

/** The prime factors below `bound` with their exponents, and the cofactor left. */
export function trialDivide(
  n: bigint,
  bound: number,
): { readonly factors: ReadonlyMap<bigint, number>; readonly rest: bigint } {
  const factors = new Map<bigint, number>();
  let rest = n;
  for (let p = 2n; p < BigInt(bound); p += p === 2n ? 1n : 2n) {
    while (rest % p === 0n) {
      factors.set(p, (factors.get(p) ?? 0) + 1);
      rest /= p;
    }
  }
  return { factors, rest };
}

const gcd = (a: bigint, b: bigint): bigint => {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
};

/**
 * Brent's variant of Pollard's rho with x ↦ x² + c, for at most `iterations`
 * steps. Returns a non-trivial factor of `n`, undefined if the walk ran out
 * without finding one, or "inconclusive" if it cycled (every gcd was `n`),
 * which says nothing about `n` and calls for another `c`.
 */
export function pollardRho(
  n: bigint,
  iterations: number,
  c = 1n,
): bigint | "inconclusive" | undefined {
  let y = 2n;
  let r = 1;
  let q = 1n;
  let steps = 0;
  const batch = 256;
  while (steps < iterations) {
    const x = y;
    for (let i = 0; i < r; i++) y = (y * y + c) % n;
    for (let k = 0; k < r && steps < iterations; k += batch) {
      const ys = y;
      const m = Math.min(batch, r - k);
      for (let i = 0; i < m; i++) {
        y = (y * y + c) % n;
        q = (q * (x > y ? x - y : y - x)) % n;
      }
      steps += m;
      const g = gcd(q, n);
      if (g === n) {
        // The batch overshot: step through it one at a time.
        let z = ys;
        for (let i = 0; i < m; i++) {
          z = (z * z + c) % n;
          const g1 = gcd(x > z ? x - z : z - x, n);
          if (g1 !== 1n) return g1 === n ? "inconclusive" : g1;
        }
        return "inconclusive";
      }
      if (g !== 1n) return g;
    }
    r *= 2;
  }
  return undefined;
}

function main(): void {
  for (const [name, n] of [
    ["ℓ − 1", ELL - 1n],
    ["ℓ + 1", ELL + 1n],
  ] as const) {
    const { factors, rest } = trialDivide(n, 2_000_000);
    const small = [...factors].map(([p, e]) => (e > 1 ? `${p}^${e}` : `${p}`)).join(" · ");
    console.log(`${name}: ${small} · (${rest.toString(2).length}-bit cofactor)`);
    // A cycled walk is retried with the next constant, never reported as "no factor".
    let found = pollardRho(rest, 2 ** 23);
    for (let c = 2n; found === "inconclusive" && c <= 4n; c++) found = pollardRho(rest, 2 ** 23, c);
    console.log(
      found === undefined
        ? `  Pollard's rho, 2^23 iterations: no factor of the cofactor found`
        : found === "inconclusive"
          ? `  Pollard's rho: inconclusive (every walk cycled)`
          : `  Pollard's rho found the factor ${found}`,
    );
  }
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) main();
