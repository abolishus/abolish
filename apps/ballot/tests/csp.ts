// The ballot client's Content Security Policy, pinned (T-43). The policy
// itself lives in index.html; the tests hold it to this, directive by
// directive. Both are in this package, so the owner-reviewed copy in
// .github/tools/ci/src/ballot.ts is the gate (T-59); this one repeats it.
//
// - Scripts, styles, fonts and images come only from the client's own origin:
//   no inline code, no eval, no other site.
// - connect-src 'none': this part of the client makes no request at all. The
//   API's origin is added with the screens that fetch an election (P2-8).
// - worker-src 'self': the Web Worker that encrypts and proves (part 2) loads
//   only from the client's own origin.
// - Trusted Types: any write of a string into a DOM sink that parses HTML or
//   script throws, so an injected string can't become markup. One named
//   policy, ballot-worker, may exist, for the worker's own script URL
//   (`new Worker(url)` is a script-URL sink); main.tsx creates it before
//   anything else runs (src/worker-client.ts).
// - base-uri and form-action 'none': no <base> can redirect relative URLs and
//   no form can post a choice anywhere.
// A <meta> policy can't set frame-ancestors, report-uri or sandbox; framing
// protection needs a response header from whoever serves the client.

export type Csp = Readonly<Record<string, readonly string[]>>;

export const BALLOT_CSP: Csp = {
  "default-src": ["'none'"],
  "script-src": ["'self'"],
  "style-src": ["'self'"],
  "font-src": ["'self'"],
  "img-src": ["'self'"],
  "connect-src": ["'none'"],
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
