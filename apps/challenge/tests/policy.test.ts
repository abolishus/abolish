import { readFileSync } from "node:fs";

import { describe, expect, test } from "vite-plus/test";

import { STAGING } from "../src/deployment.ts";
import { checkDeployment, PAGE_POLICY, pageHeaders } from "../src/policy.ts";
import { TURNSTILE_SCRIPT } from "../src/turnstile.ts";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("the policy", () => {
  test("is the spec's, directive by directive", () => {
    // [[registration]], Challenge page, The page.
    expect(PAGE_POLICY.split("; ")).toEqual([
      "default-src 'none'",
      "script-src 'self' https://challenges.cloudflare.com",
      "frame-src https://challenges.cloudflare.com",
      "style-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
    ]);
    expect(TURNSTILE_SCRIPT).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    );
  });

  test("is index.html's <meta> policy, ahead of everything that loads", () => {
    const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/>/.exec(
      html,
    );
    expect(meta?.[1]).toBe(PAGE_POLICY);
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<link"));
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
  });

  test("is sent with frame-ancestors listing exactly the entry points, and no referrer", () => {
    const deployment = {
      siteKey: "0x4AAAAAAA_b-c",
      entryPoints: ["https://a.example", "https://b.example:8443"],
    };
    expect(pageHeaders(deployment)).toEqual({
      "content-security-policy": `${PAGE_POLICY}; frame-ancestors https://a.example https://b.example:8443`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    });
    expect(pageHeaders(STAGING)["content-security-policy"]).toBe(
      `${PAGE_POLICY}; frame-ancestors https://ballot-staging.up.railway.app`,
    );
  });

  test("never sets a cookie", () => {
    expect(Object.keys(pageHeaders(STAGING)).map((k) => k.toLowerCase())).not.toContain(
      "set-cookie",
    );
  });
});

describe("checkDeployment", () => {
  test("refuses entry points that aren't serialized HTTPS origins", () => {
    for (const origin of [
      "http://a.example",
      "https://a.example/",
      "https://A.example",
      "https://a.example:443",
      "https://a.example/x",
      "https://a.example 'unsafe-inline'",
      "https://a.example;",
      "https://a.example,b.example",
      "https://xn--bcher-kva.example:99999",
      "*",
      "'self'",
      "a.example",
      "",
    ])
      expect(() => checkDeployment({ siteKey: undefined, entryPoints: [origin] }), origin).toThrow(
        RangeError,
      );
  });

  test("refuses no entry points, a repeated one, and a site key outside Turnstile's form", () => {
    expect(() => checkDeployment({ siteKey: undefined, entryPoints: [] })).toThrow(RangeError);
    expect(() =>
      checkDeployment({
        siteKey: undefined,
        entryPoints: ["https://a.example", "https://a.example"],
      }),
    ).toThrow(RangeError);
    for (const siteKey of ["", "a b", "a;b", '"', "x".repeat(101)])
      expect(() => checkDeployment({ siteKey, entryPoints: ["https://a.example"] })).toThrow(
        RangeError,
      );
  });

  test("accepts staging's", () => {
    expect(() => checkDeployment(STAGING)).not.toThrow();
  });
});
