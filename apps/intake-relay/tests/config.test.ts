import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { ConfigError, parseRelayConfig } from "../src/config.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const base = {
  host: "0.0.0.0",
  port: 8080,
  resources: [{ path: "seat-1", node: "https://seat-1.railway.internal:8443" }],
};
const parse = (v: unknown) => parseRelayConfig(JSON.stringify(v));
const refusal = (v: unknown) => {
  try {
    parse(v);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("accepted");
};

describe("parseRelayConfig", () => {
  it("takes a configuration, with the queue's and the timeout's defaults", () => {
    expect(parse(base)).toEqual({ ...base, queue: 16, timeoutSeconds: 60 });
    expect(
      parse({
        ...base,
        resources: [
          { path: "", node: "http://127.0.0.1:9000", ca: "-----BEGIN CERTIFICATE-----" },
          { path: "v1/seats/2.a_b", node: "https://[::1]:8443" },
        ],
        rate: { requests: 10, windowSeconds: 60, addressHeader: "x-real-ip" },
      }).resources.map((r) => r.path),
    ).toEqual(["", "v1/seats/2.a_b"]);
  });

  it("refuses no configuration, one that isn't JSON and unknown fields", () => {
    expect(() => parseRelayConfig(undefined)).toThrow("RELAY_CONFIG: not set");
    expect(() => parseRelayConfig("")).toThrow("RELAY_CONFIG: not set");
    expect(() => parseRelayConfig("{")).toThrow("RELAY_CONFIG: not JSON");
    expect(refusal({ ...base, extra: 1 })).toBe("RELAY_CONFIG: unrecognized_keys");
    expect(refusal({ ...base, resources: [] })).toBe("RELAY_CONFIG: resources: too_small");
  });

  it("refuses a path the deployment record can't list, and a path named twice (T-31)", () => {
    for (const path of [
      "/seat-1",
      "seat-1/",
      "a//b",
      ".",
      "a/..",
      "seat%201",
      "a?b",
      "x".repeat(129),
    ])
      expect(refusal({ ...base, resources: [{ ...base.resources[0], path }] })).toBe(
        "RELAY_CONFIG: resources.0.path: custom",
      );
    expect(refusal({ ...base, resources: [base.resources[0], { ...base.resources[0] }] })).toBe(
      "RELAY_CONFIG: resources: custom",
    );
  });

  it("refuses a node that isn't an https origin, or http off loopback (T-15), never quoting it", () => {
    for (const node of [
      "http://seat-1.railway.internal:8080",
      "https://seat-1.example/v1/sealed-intake",
      "https://seat-1.example?x",
      "ftp://seat-1.example",
      "seat-1.example",
    ]) {
      const message = refusal({ ...base, resources: [{ path: "seat-1", node }] });
      expect(message).toBe("RELAY_CONFIG: resources.0.node: custom");
    }
  });

  it("takes exactly the paths of [[release]]'s grammar", () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/);
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 20 }), (segments) => {
        const path = segments.join("/");
        const ok =
          segments.length <= 16 &&
          path.length <= 128 &&
          !segments.some((s) => s === "." || s === "..");
        let took = true;
        try {
          parse({ ...base, resources: [{ ...base.resources[0], path }] });
        } catch {
          took = false;
        }
        return took === ok;
      }),
      { numRuns },
    );
  });
});
