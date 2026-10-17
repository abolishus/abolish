import { describe, expect, test } from "vite-plus/test";
import { POLL_STUB_ENV, pollStubFromEnv } from "../src/index.ts";

// The stub step's configuration (P2-22 part 4b): all of it or none, each
// value's format, and nothing judged that core's rule judges at startup.

const key = (b: number, prefix = "02") => `${prefix}${b.toString(16).padStart(2, "0").repeat(32)}`;

const full = {
  POLL_STUB_PANEL_THRESHOLD: "2",
  POLL_STUB_PANEL_KEYS: [key(1), key(2, "03"), key(3)].join(","),
  POLL_STUB_RECEIPT_KEYS: [key(8), key(9)].join(","),
  POLL_STUB_INCLUSION_BOUND: "3600",
  POLL_STUB_SEQUENCING_WINDOW: "3600",
  POLL_STUB_MAX_SEQUENCER_DRIFT: "1800",
};

const refusal = (env: Record<string, string>) => {
  try {
    pollStubFromEnv(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("accepted");
};

describe("the stub step's configuration", () => {
  test("is absent when no variable is set, empty ones included", () => {
    expect(pollStubFromEnv({})).toBeUndefined();
    expect(pollStubFromEnv({ POLL_STUB_PANEL_KEYS: "" })).toBeUndefined();
  });

  test("reads the panel in seat order, the receipt keys as given and the bounds", () => {
    const bytes = (k: string) => Uint8Array.from(Buffer.from(k, "hex"));
    expect(pollStubFromEnv(full)).toEqual({
      panel: { threshold: 2, keys: [key(1), key(2, "03"), key(3)].map(bytes) },
      receiptKeys: [key(8), key(9)].map(bytes),
      l1InclusionBound: 3600,
      sequencingWindow: 3600n,
      maxSequencerDrift: 1800n,
    });
  });

  test("needs every variable", () => {
    for (const name of POLL_STUB_ENV) {
      const partial: Record<string, string> = { ...full };
      delete partial[name];
      expect(refusal(partial)).toContain("needs every one of");
    }
  });

  test("refuses malformed values, naming the variable and never quoting it", () => {
    for (const [name, value] of [
      ["POLL_STUB_PANEL_THRESHOLD", "0"],
      ["POLL_STUB_PANEL_THRESHOLD", "100"],
      ["POLL_STUB_PANEL_KEYS", key(1).slice(2)],
      ["POLL_STUB_PANEL_KEYS", key(1, "04")],
      ["POLL_STUB_PANEL_KEYS", `${key(1)},`],
      ["POLL_STUB_PANEL_KEYS", `0x${key(1)}`],
      ["POLL_STUB_PANEL_KEYS", Array.from({ length: 17 }, (_, i) => key(i + 1)).join(",")],
      ["POLL_STUB_RECEIPT_KEYS", `${key(8)}00`],
      ["POLL_STUB_INCLUSION_BOUND", "-1"],
      ["POLL_STUB_INCLUSION_BOUND", "4294967296"],
      ["POLL_STUB_SEQUENCING_WINDOW", "18446744073709551616"],
      ["POLL_STUB_MAX_SEQUENCER_DRIFT", "01"],
    ] as const) {
      const message = refusal({ ...full, [name]: value });
      expect(message).toBe(`malformed ${name}`);
    }
  });

  test("leaves the rule's judgements to the rule", () => {
    // A threshold above the panel and unordered receipt keys parse; core's
    // pollStubDeploymentRule refuses them at startup.
    expect(
      pollStubFromEnv({
        ...full,
        POLL_STUB_PANEL_THRESHOLD: "4",
        POLL_STUB_RECEIPT_KEYS: [key(9), key(8)].join(","),
      }),
    ).toBeDefined();
  });
});
