import { describe, expect, test } from "vite-plus/test";

import {
  embedHeaders,
  isEmbedPage,
  contentSecurityPolicy,
  isChallengePage,
  newNonce,
  securityHeaders,
} from "../src/security.ts";

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split("; ").map((d) => {
      const [name = "", ...values] = d.split(" ");
      return [name, values.join(" ")];
    }),
  );
}

describe("nonce", () => {
  test("is 16 random bytes of base64, fresh each time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const nonce = newNonce();
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      seen.add(nonce);
    }
    expect(seen.size).toBe(1000);
  });
});

describe("content security policy", () => {
  const nonce = newNonce();
  const csp = directives(contentSecurityPolicy(nonce));

  test("runs only our scripts and this response's inline ones (T-43)", () => {
    expect(csp.get("script-src")).toBe(`'self' 'nonce-${nonce}'`);
    for (const value of csp.values()) {
      expect(value).not.toContain("unsafe-");
      expect(value).not.toContain("*");
      expect(value).not.toMatch(/https?:|data:|blob:/);
    }
  });

  test("denies by default, and framing, base URLs and plugins entirely", () => {
    expect(csp.get("default-src")).toBe("'none'");
    expect(csp.get("frame-ancestors")).toBe("'none'");
    expect(csp.get("base-uri")).toBe("'none'");
    expect(csp.has("object-src")).toBe(false);
  });

  test("connects to our own origin only (T-10, T-67)", () => {
    expect(csp.get("connect-src")).toBe("'self'");
  });

  test.each(["", "abc", "'none'; script-src *", `${nonce} `, `${nonce}'`])(
    "refuses %j as a nonce",
    (bad) => {
      expect(() => contentSecurityPolicy(bad)).toThrow(RangeError);
    },
  );
});

describe("the poll editor's policy (P2-22 part 6c)", () => {
  const nonce = newNonce();
  const plain = directives(contentSecurityPolicy(nonce));
  const csp = directives(contentSecurityPolicy(nonce, { challenge: true }));

  test("adds exactly Turnstile's script and frame origin, and nothing else (T-43, T-55)", () => {
    expect(csp.get("script-src")).toBe(`'self' 'nonce-${nonce}' https://challenges.cloudflare.com`);
    expect(csp.get("frame-src")).toBe("https://challenges.cloudflare.com");
    expect(plain.has("frame-src")).toBe(false);
    for (const [name, value] of csp)
      if (name !== "script-src" && name !== "frame-src") expect(value).toBe(plain.get(name));
    expect([...csp.keys()].filter((k) => !plain.has(k))).toEqual(["frame-src"]);
    for (const value of csp.values()) {
      expect(value).not.toContain("unsafe-");
      expect(value).not.toContain("*");
    }
  });

  test("still connects to our own origin only, so the page sends nothing to Cloudflare itself", () => {
    expect(csp.get("connect-src")).toBe("'self'");
  });

  test.each(["/account/polls/new", `/account/polls/${"a1".repeat(16)}`])(
    "%s is the editor",
    (path) => expect(isChallengePage(path)).toBe(true),
  );

  // The verification page (P2-31 part 4): a request for a code takes a token.
  test("/account/verify asks for codes", () =>
    expect(isChallengePage("/account/verify")).toBe(true));

  test.each([
    "/",
    "/account",
    "/account/",
    "/account/polls",
    "/account/polls/",
    "/account/polls/new/",
    "/account/polls/new/x",
    // Setup's page, where a submission lands (P2-22 part 6d): never Turnstile's.
    `/account/polls/${"a1".repeat(16)}/setup`,
    "/account/polls/NEW",
    "/account/polls/%6Eew",
    "/account/verify/",
    "/account/verify/x",
    "/account/Verify",
    "/x/account/verify",
    "/account/polls/new.js",
    "/x/account/polls/new",
    "/polls/new",
    "/_serverFn/abc",
  ])("%s isn't", (path) => expect(isChallengePage(path)).toBe(false));
});

describe("headers", () => {
  test("send no referrer and allow no other origin to embed or open us", () => {
    const headers = securityHeaders(newNonce());
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
  });
});

describe("the embed's policy (P2-24 part 3)", () => {
  const csp = embedHeaders()["content-security-policy"] ?? "";
  const directives = csp.split("; ");

  test("runs no script at all, posts nothing, and sandboxes itself (T-43, T-67)", () => {
    expect(directives).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(directives).toContain("form-action 'none'");
    expect(directives).toContain("base-uri 'none'");
    expect(directives).toContain(
      "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    );
    // Never `allow-scripts`, `allow-forms` or a way to steer the host page.
    expect(csp).not.toMatch(/allow-(?:scripts|forms|top-navigation|modals)/);
  });

  test("may be framed by any site, and loads nothing but our own styles and fonts", () => {
    expect(directives).toContain("frame-ancestors *");
    expect(directives).toContain("style-src 'self'");
    expect(directives).toContain("font-src 'self'");
    expect(csp).not.toContain("connect-src");
    expect(csp).not.toContain("frame-src");
  });

  test("asks for no referrer and may be cached briefly, since it carries no nonce (T-11)", () => {
    const headers = embedHeaders();
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["cache-control"]).toBe("public, max-age=60");
  });
});

describe("embed pages", () => {
  test.each(["/embed/p/3j55dw1", "/EMBED/P/3J55DW1", "/embed/p/anything"])("%s is one", (path) =>
    expect(isEmbedPage(path)).toBe(true),
  );
  test.each(["/embed", "/embed/p", "/embed/p/", "/embed/p/a/b", "/x/embed/p/a", "/p/3j55dw1"])(
    "%s isn't",
    (path) => expect(isEmbedPage(path)).toBe(false),
  );
});
