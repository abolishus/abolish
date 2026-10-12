import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { QUEUES, type QueueSpec } from "../src/index.ts";

// Queues never join accounts to ballots (T-10): each queue is on one side
// (or, for upkeep such as the identity-backup prune, on neither),
// its job data can't name the other side's values, and data is a strict
// object, so a producer can't slip a field past the schema. Field names are
// matched by a deny-list, as the schema's no-join test does for columns, so
// a renamed field would pass; review of each new queue still has to catch it.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const ACCOUNT_LIKE =
  /account|user|person|email|phone|session|cookie|token|passkey|device|ip_?addr|address|name/i;
const BALLOT_LIKE =
  /ballot|vote|nullifier|commitment|receipt|poll|election|tier|identity|member|cast|spoil/i;

const specs = Object.entries(QUEUES) as [string, QueueSpec][];

describe.each(specs)("queue %s", (_key, spec) => {
  const fields = Object.keys(spec.data.shape);

  test("is on one side, and its fields name nothing from the other", () => {
    expect(["board", "account", "operational"]).toContain(spec.side);
    // An operational queue is on neither side, so it may name neither.
    const others =
      spec.side === "board"
        ? [ACCOUNT_LIKE]
        : spec.side === "account"
          ? [BALLOT_LIKE]
          : [ACCOUNT_LIKE, BALLOT_LIKE];
    expect(fields.filter((f) => others.some((o) => o.test(f)))).toEqual([]);
  });

  test("is a strict object, so data with a field it doesn't name is refused", () => {
    expect(spec.data.def.catchall?._zod.def.type).toBe("never");
    // And in practice: whatever a well-formed job's data, one more field fails.
    const minimal = spec.data.safeParse({});
    // A schema with required fields is covered by the check above.
    if (!minimal.success) return;
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((k) => !fields.includes(k) && k !== "__proto__"),
        fc.jsonValue(),
        (extra, value) => {
          expect(spec.data.safeParse({ ...minimal.data, [extra]: value }).success).toBe(false);
        },
      ),
      { numRuns },
    );
  });

  test("names its own hash tag, and nothing else, as its key segment", () => {
    expect(spec.name).toMatch(/^\{[a-z][a-z0-9-]*\}$/);
  });
});

test("no two queues share a name, so none shares another's keys", () => {
  const names = specs.map(([, s]) => s.name);
  expect(new Set(names).size).toBe(names.length);
});
