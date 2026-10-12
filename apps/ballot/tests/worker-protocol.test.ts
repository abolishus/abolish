// The page–worker boundary (src/worker/protocol.ts, src/worker-client.ts):
// the worker accepts only exact, current-version requests, and the
// ballot-worker Trusted Types policy mints a script URL for the worker's own
// script and nothing else (T-43).

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { allowWorkerUrl, WORKER_URL } from "../src/worker-client.ts";
import { parseRequest, PROTOCOL_VERSION, requestId, responseId } from "../src/worker/protocol.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const request = () => ({
  v: PROTOCOL_VERSION,
  id: 7,
  kind: "check-election",
  electionId: new Uint8Array(32),
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
    ["a definition that isn't bytes", { definition: "0102" }],
    ["display text that isn't bytes", { displayText: new Uint16Array(2) }],
    ["an extra key", { extra: true }],
  ])("refuses %s", (_, change) => {
    expect(parseRequest({ ...request(), ...change })).toBeUndefined();
  });

  test.each(["v", "id", "kind", "electionId", "definition", "displayText"])(
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

describe("responses", () => {
  test("matches a current response to its request", () => {
    expect(responseId({ v: PROTOCOL_VERSION, id: 4, kind: "check-election", result: {} })).toBe(4);
    expect(responseId({ v: PROTOCOL_VERSION, id: 4, kind: "error" })).toBe(4);
  });

  test("ignores another version's response or kind", () => {
    expect(responseId({ v: 2, id: 4, kind: "error" })).toBeUndefined();
    expect(responseId({ v: PROTOCOL_VERSION, id: 4, kind: "ready" })).toBeUndefined();
    expect(responseId({ v: PROTOCOL_VERSION, kind: "error" })).toBeUndefined();
  });
});

describe("the ballot-worker policy", () => {
  test("mints the worker's own script URL", () => {
    expect(WORKER_URL).toMatch(/worker/);
    expect(allowWorkerUrl(WORKER_URL)).toBe(WORKER_URL);
  });

  test("refuses every other URL", () => {
    for (const url of [
      "https://example.com/worker.js",
      `${WORKER_URL}?x`,
      `${WORKER_URL}#x`,
      ` ${WORKER_URL}`,
      WORKER_URL.toUpperCase(),
      "data:text/javascript,postMessage(1)",
      "blob:null/0",
    ])
      expect(() => allowWorkerUrl(url)).toThrow(TypeError);
    fc.assert(
      fc.property(fc.string(), (url) => {
        fc.pre(url !== WORKER_URL);
        expect(() => allowWorkerUrl(url)).toThrow(TypeError);
      }),
      { numRuns },
    );
  });
});
