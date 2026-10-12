// The ballot client's Content Security Policy, pinned (T-43). The policy
// itself lives in index.html; the tests hold it to this, directive by
// directive, so a weakening edit has to change both.
//
// - Scripts, styles, fonts and images come only from the client's own origin:
//   no inline code, no eval, no other site.
// - connect-src 'none': this part of the client makes no request at all. The
//   API's origin is added with the screens that fetch an election (P2-8).
// - Trusted Types with no policy: any write of a string into a DOM sink that
//   parses HTML or script throws, so an injected string can't become markup.
//   The Web Worker (part 2) needs one named policy for its own script URL.
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
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "require-trusted-types-for": ["'script'"],
  "trusted-types": ["'none'"],
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
