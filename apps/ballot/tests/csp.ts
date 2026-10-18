// The ballot client's Content Security Policy, pinned (T-43). The policy
// itself lives in index.html; the tests hold it to this, directive by
// directive. Both are in this package, so the owner-reviewed copy in
// .github/tools/ci/src/ballot.ts is the gate (T-59); this one repeats it.
//
// - Scripts, styles, fonts and images come only from the client's own origin:
//   no inline code, no eval, no other site. 'wasm-unsafe-eval' lets the
//   prover compile its WebAssembly (curve code and witness calculator); it
//   never allows JavaScript eval.
// - connect-src: the client's own origin, for the prover's key and witness
//   calculator from its own release; the API's origin and one L2 JSON-RPC
//   origin, both untrusted (the client checks every answer against the
//   registry, T-34); and nothing else. Staging's values; a release names its
//   own.
// - frame-src: the challenge page's origin alone (apps/challenge), where
//   Turnstile runs instead of in the client; staging's, as above.
// - worker-src 'self': the Web Workers that encrypt and prove load only from
//   the client's own origin.
// - Trusted Types: any write of a string into a DOM sink that parses HTML or
//   script throws, so an injected string can't become markup. One named
//   policy, ballot-worker, may exist, for the workers' own script URLs, the
//   ballot worker's and the prover worker's (`new Worker(url)` is a
//   script-URL sink); main.tsx creates it before anything else runs
//   (src/worker-policy.ts).
// - base-uri and form-action 'none': no <base> can redirect relative URLs and
//   no form can post a choice anywhere.
// A <meta> policy can't set frame-ancestors, report-uri or sandbox; framing
// protection needs a response header from whoever serves the client.

export type Csp = Readonly<Record<string, readonly string[]>>;

export const BALLOT_CSP: Csp = {
  "default-src": ["'none'"],
  "script-src": ["'self'", "'wasm-unsafe-eval'"],
  "style-src": ["'self'"],
  "font-src": ["'self'"],
  "img-src": ["'self'"],
  "connect-src": ["'self'", "https://api-staging.abolish.us", "https://sepolia.base.org"],
  "frame-src": ["https://challenge-staging.up.railway.app"],
  "worker-src": ["'self'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "require-trusted-types-for": ["'script'"],
  "trusted-types": ["ballot-worker"],
};

/** Parses a serialised policy; a repeated directive, which browsers ignore, is an error. */
export function parseCsp(policy: string): Csp {
  const parsed: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name === undefined || name === "") continue;
    const key = name.toLowerCase();
    if (key in parsed) throw new Error(`repeated CSP directive ${key}`);
    parsed[key] = values;
  }
  return parsed;
}
