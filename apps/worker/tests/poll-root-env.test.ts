import { describe, expect, test } from "vite-plus/test";
import { POLL_ROOT_ENV, pollRootFromEnv } from "../src/index.ts";

// The roots step's configuration (P2-22 part 3b-2): all of it or none, the
// published groups each in one tier once, and the registrars as the release
// pins them.

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const full = {
  POLL_ROOT_GROUPS: "0:2,0:1,1:7",
  POLL_ROOT_REGISTRARS: [address(1), address(2), address(3)].join(","),
  POLL_ROOT_THRESHOLD: "2",
};

const refusal = (env: Record<string, string>) => {
  try {
    pollRootFromEnv(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("accepted");
};

describe("the roots step's configuration", () => {
  test("is absent when no variable is set, empty ones included", () => {
    expect(pollRootFromEnv({})).toBeUndefined();
    expect(pollRootFromEnv({ POLL_ROOT_GROUPS: "" })).toBeUndefined();
  });

  test("reads each tier's groups in ascending order, in region 0", () => {
    const c = pollRootFromEnv(full);
    expect(c?.groups).toEqual(
      new Map([
        [
          0,
          [
            { group_id: 1n, region: 0 },
            { group_id: 2n, region: 0 },
          ],
        ],
        [1, [{ group_id: 7n, region: 0 }]],
      ]),
    );
    expect(c?.registrars).toEqual([address(1), address(2), address(3)]);
    expect(c?.threshold).toBe(2);
  });

  test("needs every variable", () => {
    for (const name of POLL_ROOT_ENV) {
      const partial: Record<string, string> = { ...full };
      delete partial[name];
      expect(refusal(partial)).toContain("needs every one of");
    }
  });

  test("refuses malformed values, naming the variable", () => {
    for (const [name, value] of [
      ["POLL_ROOT_GROUPS", "3:1"],
      ["POLL_ROOT_GROUPS", "0:01"],
      ["POLL_ROOT_GROUPS", "0:1,"],
      ["POLL_ROOT_GROUPS", "0:18446744073709551616"],
      ["POLL_ROOT_REGISTRARS", "0x12"],
      ["POLL_ROOT_THRESHOLD", "0"],
    ] as const)
      expect(refusal({ ...full, [name]: value }), value).toMatch(/malformed POLL_ROOT_/);
  });

  test("refuses a group listed twice, a repeated registrar and a threshold above the registrars", () => {
    expect(refusal({ ...full, POLL_ROOT_GROUPS: "0:1,1:1" })).toContain("repeats a group");
    expect(refusal({ ...full, POLL_ROOT_REGISTRARS: `${address(1)},${address(1)}` })).toContain(
      "repeats a registrar",
    );
    expect(refusal({ ...full, POLL_ROOT_THRESHOLD: "4" })).toContain("above the number");
  });
});
