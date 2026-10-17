// The page–worker boundary (src/worker/protocol.ts, src/worker-client.ts):
// the worker accepts only exact, current-version requests, and the
// ballot-worker Trusted Types policy mints a script URL for the worker's own
// script and nothing else (T-43).

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { allowWorkerUrl, PROVER_URL, WORKER_URL } from "../src/worker-policy.ts";
import { parseRequest, PROTOCOL_VERSION, requestId, responseId } from "../src/worker/protocol.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const request = () => ({
  v: PROTOCOL_VERSION,
  id: 7,
  kind: "check-election",
  electionId: new Uint8Array(32),
  registeredHash: new Uint8Array(32).fill(1),
  definition: new Uint8Array([1, 2, 3]),
  displayText: new Uint8Array([4, 5]),
});

describe("requests", () => {
  test("accepts a well-formed request as it is", () => {
    expect(parseRequest(request())).toEqual(request());
  });

  test("accepts any id and any record bytes", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array(),
        fc.uint8Array(),
        (id, electionId, definition, displayText) => {
          const r = { ...request(), id, electionId, definition, displayText };
          expect(parseRequest(r)).toEqual(r);
        },
      ),
      { numRuns },
    );
  });

  test.each([
    ["another version", { v: 2 }],
    ["a negative id", { id: -1 }],
    ["a fractional id", { id: 1.5 }],
    ["an id that isn't a number", { id: "7" }],
    ["another kind", { kind: "encrypt" }],
    ["a short election id", { electionId: new Uint8Array(31) }],
    ["a long election id", { electionId: new Uint8Array(33) }],
    ["an election id that isn't bytes", { electionId: Array(32).fill(0) }],
    ["a short registered hash", { registeredHash: new Uint8Array(31) }],
    ["a registered hash that isn't bytes", { registeredHash: "00".repeat(32) }],
    ["a definition that isn't bytes", { definition: "0102" }],
    ["display text that isn't bytes", { displayText: new Uint16Array(2) }],
    ["an extra key", { extra: true }],
  ])("refuses %s", (_, change) => {
    expect(parseRequest({ ...request(), ...change })).toBeUndefined();
  });

  test.each(["v", "id", "kind", "electionId", "registeredHash", "definition", "displayText"])(
    "refuses a request without %s",
    (key) => {
      const r: Record<string, unknown> = request();
      delete r[key];
      expect(parseRequest(r)).toBeUndefined();
    },
  );

  test("refuses anything that isn't a request object", () => {
    for (const x of [null, undefined, 7, "request", [request()], new Uint8Array(4)])
      expect(parseRequest(x)).toBeUndefined();
    fc.assert(
      fc.property(fc.anything(), (x) => {
        expect(parseRequest(x)).toBeUndefined();
      }),
      { numRuns },
    );
  });

  test("a refused request with an id still gets its error; one without gets none", () => {
    expect(requestId({ id: 3, kind: "nonsense" })).toBe(3);
    expect(requestId({ kind: "nonsense" })).toBeUndefined();
    expect(requestId({ id: -3 })).toBeUndefined();
  });
});

describe("membership proof requests", () => {
  const { port1 } = new MessageChannel();
  const prove = () => ({
    v: PROTOCOL_VERSION,
    id: 9,
    kind: "prove-membership",
    secret: new Uint8Array(32).fill(2),
    leaves: [1n, 2n, 3n],
    definitionHash: new Uint8Array(32).fill(3),
    tier: 0,
    root: 5n,
    message: new Uint8Array(32).fill(4),
    prover: port1,
  });
  port1.close();

  test("accepts a well-formed request as it is, its port included", () => {
    const parsed = parseRequest(prove());
    expect(parsed).toEqual(prove());
    expect(parsed?.kind === "prove-membership" && parsed.prover).toBe(port1);
  });

  test("accepts any leaves and statement values: their checks are membershipProverInput's", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt()), fc.bigInt(), fc.integer(), (leaves, root, tier) => {
        const r = { ...prove(), leaves, root, tier };
        expect(parseRequest(r)).toEqual(r);
      }),
      { numRuns },
    );
  });

  test.each([
    ["a short secret", { secret: new Uint8Array(31) }],
    ["a long secret", { secret: new Uint8Array(33) }],
    ["a secret as hex", { secret: "02".repeat(32) }],
    ["leaves that aren't a list", { leaves: new BigUint64Array(3) }],
    ["a leaf that isn't a bigint", { leaves: [1n, 2, 3n] }],
    ["a leaf as a decimal string", { leaves: ["1"] }],
    ["a short definition hash", { definitionHash: new Uint8Array(31) }],
    ["a fractional tier", { tier: 0.5 }],
    ["a tier as a bigint", { tier: 0n }],
    ["a root that isn't a bigint", { root: 5 }],
    ["a short message", { message: new Uint8Array(31) }],
    ["a prover that isn't a port", { prover: {} }],
    ["an extra key", { extra: true }],
    ["another version", { v: 2 }],
  ])("refuses %s", (_, change) => {
    expect(parseRequest({ ...prove(), ...change })).toBeUndefined();
  });

  test.each(["secret", "leaves", "definitionHash", "tier", "root", "message", "prover"])(
    "refuses a request without %s",
    (key) => {
      const r: Record<string, unknown> = prove();
      delete r[key];
      expect(parseRequest(r)).toBeUndefined();
    },
  );

  test("refuses a check-election request's keys under the proof's kind, and the reverse", () => {
    expect(parseRequest({ ...request(), kind: "prove-membership" })).toBeUndefined();
    expect(parseRequest({ ...prove(), kind: "check-election" })).toBeUndefined();
  });
});

describe("responses", () => {
  test("matches a current response to its request", () => {
    expect(responseId({ v: PROTOCOL_VERSION, id: 4, kind: "check-election", result: {} })).toBe(4);
    expect(responseId({ v: PROTOCOL_VERSION, id: 4, kind: "error" })).toBe(4);
    expect(responseId({ v: PROTOCOL_VERSION, id: 5, kind: "prove-membership", result: {} })).toBe(
      5,
    );
  });

  test("ignores another version's response or kind", () => {
    expect(responseId({ v: 2, id: 4, kind: "error" })).toBeUndefined();
    expect(responseId({ v: PROTOCOL_VERSION, id: 4, kind: "ready" })).toBeUndefined();
    expect(responseId({ v: PROTOCOL_VERSION, kind: "error" })).toBeUndefined();
  });
});

describe("the ballot-worker policy", () => {
  test("mints the two workers' own script URLs", () => {
    expect(WORKER_URL).toMatch(/worker/);
    expect(allowWorkerUrl(WORKER_URL)).toBe(WORKER_URL);
    expect(PROVER_URL).toMatch(/prover/);
    expect(allowWorkerUrl(PROVER_URL)).toBe(PROVER_URL);
  });

  test("refuses every other URL", () => {
    for (const url of [
      "https://example.com/worker.js",
      `${WORKER_URL}?x`,
      `${WORKER_URL}#x`,
      ` ${WORKER_URL}`,
      WORKER_URL.toUpperCase(),
      `${PROVER_URL}?x`,
      ` ${PROVER_URL}`,
      "data:text/javascript,postMessage(1)",
      "blob:null/0",
    ])
      expect(() => allowWorkerUrl(url)).toThrow(TypeError);
    fc.assert(
      fc.property(fc.string(), (url) => {
        fc.pre(url !== WORKER_URL && url !== PROVER_URL);
        expect(() => allowWorkerUrl(url)).toThrow(TypeError);
      }),
      { numRuns },
    );
  });
});
