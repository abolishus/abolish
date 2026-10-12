import { describe, expect, test } from "vite-plus/test";

import { contentSecurityPolicy, newNonce, securityHeaders } from "../src/security.ts";

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
