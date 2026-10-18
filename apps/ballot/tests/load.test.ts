// Fetching what the worker checks (src/load.ts): the registry is read at the
// pinned address on the pinned chain, at the finalized head, and every answer
// that isn't shaped like one ends in a problem, never in bytes handed on;
// requests carry no credentials or referrer and name only the election
// (T-10, T-11, T-34, T-52). The board's first entry, which carries the
// ceremony transcript, is fetched beside the records; the whole board, for
// the voter's cell, page by page, naming nothing but the election and a
// position (T-10, T-13). Whether the records may be shown is the worker's
// check, tested in election.test.ts and packages/crypto.

import { PARAMETERS } from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import type { Deployment } from "../src/deployment.ts";
import { STAGING } from "../src/deployment.ts";
import { parseLink } from "../src/link.ts";
import { DEFINITION_HASH_OF, type Fetch, loadBoard, loadElection } from "../src/load.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const REGISTRY = "0x00000000000000000000000000000000000000aa";
const DEPLOYMENT: Deployment = { ...STAGING, electionRegistry: REGISTRY };
const ID = new Uint8Array(32).fill(0x5d);
const ID_HEX = "5d".repeat(32);
const HASH = "3f".repeat(32);
const DEFINITION = "0001abcd";
const TEXT = "0009ef";
const ENTRY = "000704aa";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: unknown;
}

type Answer = { status: number; body: string } | "network";

/** A fake network: `answer` decides each request's response from its URL and JSON-RPC method. */
function network(answer: (url: string, method: string | undefined) => Answer) {
  const calls: Call[] = [];
  const fetchFn: Fetch = (url, init) => {
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, init, body });
    const method =
      typeof body === "object" && body !== null ? (body as { method?: string }).method : undefined;
    const a = answer(url, method);
    if (a === "network") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve(new Response(a.body, { status: a.status }));
  };
  return { calls, fetchFn };
}

const rpcResult = (id: number, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });

/** An honest deployment, with any one answer replaced. */
function honest(
  override: Partial<
    Record<"chainId" | "call" | "definition" | "text" | "entries" | "status", Answer>
  > = {},
) {
  return network((url, method) => {
    if (url === DEPLOYMENT.rpc) {
      if (method === "eth_chainId")
        return override.chainId ?? { status: 200, body: rpcResult(1, "0x14a34") };
      return override.call ?? { status: 200, body: rpcResult(2, `0x${HASH}`) };
    }
    if (url === `${DEPLOYMENT.api}/elections/definition?electionId=${ID_HEX}`)
      return (
        override.definition ?? { status: 200, body: JSON.stringify({ definition: DEFINITION }) }
      );
    if (url === `${DEPLOYMENT.api}/elections/display-text?electionId=${ID_HEX}`)
      return override.text ?? { status: 200, body: JSON.stringify({ displayText: TEXT }) };
    if (url === `${DEPLOYMENT.api}/board/entries?electionId=${ID_HEX}&start=0&limit=1`)
      return override.entries ?? { status: 200, body: JSON.stringify({ entries: [ENTRY] }) };
    if (url === `${DEPLOYMENT.api}/moderation/status?electionId=${ID_HEX}`)
      return override.status ?? { status: 200, body: JSON.stringify({ state: "visible" }) };
    return { status: 500, body: "" };
  });
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("the registry read", () => {
  test("the selector is definitionHashOf(bytes32)'s", () => {
    const digest = keccak_256(new TextEncoder().encode("definitionHashOf(bytes32)"));
    expect(DEFINITION_HASH_OF).toBe(hex(digest.slice(0, 4)));
  });

  test("an honest deployment's records come back with the registry's hash", async () => {
    const { calls, fetchFn } = honest();
    const loaded = await loadElection(DEPLOYMENT, ID, fetchFn);
    if (!loaded.ok) throw new Error(loaded.problem);
    expect(hex(loaded.registeredHash)).toBe(HASH);
    expect(hex(loaded.definition)).toBe(DEFINITION);
    expect(hex(loaded.displayText)).toBe(TEXT);
    expect(loaded.entries.map(hex)).toEqual([ENTRY]);
    expect(loaded.hiddenAsThreat).toBe(false);
    const call = calls.find((c) => (c.body as { method?: string })?.method === "eth_call");
    // The pinned registry, the election's word after the selector, the finalized head.
    expect(call?.body).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "eth_call",
      params: [{ to: REGISTRY, data: `0x${DEFINITION_HASH_OF}${ID_HEX}` }, "finalized"],
    });
  });

  test("no request carries credentials or a referrer, or follows a redirect", async () => {
    const { calls, fetchFn } = honest();
    await loadElection(DEPLOYMENT, ID, fetchFn);
    expect(calls).toHaveLength(6);
    for (const { init } of calls) {
      expect(init.credentials).toBe("omit");
      expect(init.referrerPolicy).toBe("no-referrer");
      expect(init.redirect).toBe("error");
      expect(init.cache).toBe("no-store");
    }
  });

  test("a build that pins no registry asks nothing of anyone", async () => {
    const { calls, fetchFn } = honest();
    expect(await loadElection(STAGING, ID, fetchFn)).toEqual({ ok: false, problem: "no-registry" });
    expect(calls).toHaveLength(0);
  });

  test("an election the registry holds no hash for is not registered, and the API isn't asked", async () => {
    const { calls, fetchFn } = honest({
      call: { status: 200, body: rpcResult(2, `0x${"00".repeat(32)}`) },
    });
    expect(await loadElection(DEPLOYMENT, ID, fetchFn)).toEqual({
      ok: false,
      problem: "not-registered",
    });
    expect(calls.every((c) => c.url === DEPLOYMENT.rpc)).toBe(true);
  });

  test("an RPC on another chain isn't believed", async () => {
    const { fetchFn } = honest({ chainId: { status: 200, body: rpcResult(1, "0x1") } });
    expect(await loadElection(DEPLOYMENT, ID, fetchFn)).toEqual({
      ok: false,
      problem: "wrong-chain",
    });
  });

  test("a node's error is the node's trouble, not a claim about the registry", async () => {
    const { fetchFn } = honest({
      call: {
        status: 200,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32005, message: "limit" } }),
      },
    });
    expect(await loadElection(DEPLOYMENT, ID, fetchFn)).toEqual({
      ok: false,
      problem: "unreachable",
    });
  });

  test("any return value but one word is refused", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.constant(null),
          fc.stringMatching(/^0x[0-9a-fA-F]{0,130}$/),
        ),
        async (result) => {
          fc.pre(!(typeof result === "string" && /^0x[0-9a-f]{64}$/.test(result)));
          const { fetchFn } = honest({ call: { status: 200, body: rpcResult(2, result) } });
          expect(await loadElection(DEPLOYMENT, ID, fetchFn)).toEqual({
            ok: false,
            problem: "bad-answer",
          });
        },
      ),
      { numRuns },
    );
  });

  test("an answer to another request id is refused", async () => {
    const { fetchFn } = honest({ call: { status: 200, body: rpcResult(7, `0x${HASH}`) } });
    expect(await loadElection(DEPLOYMENT, ID, fetchFn)).toEqual({
      ok: false,
      problem: "bad-answer",
    });
  });
});

describe("the API's records", () => {
  test("withheld text is withheld, and a missing record is not found", async () => {
    const withheld = honest({ text: { status: 451, body: "{}" } });
    expect(await loadElection(DEPLOYMENT, ID, withheld.fetchFn)).toEqual({
      ok: false,
      problem: "withheld",
    });
    const missing = honest({ definition: { status: 404, body: "{}" } });
    expect(await loadElection(DEPLOYMENT, ID, missing.fetchFn)).toEqual({
      ok: false,
      problem: "not-found",
    });
  });

  test("a failed network or a server error is unreachable", async () => {
    for (const fetchFn of [
      honest({ definition: "network" }).fetchFn,
      honest({ call: "network" }).fetchFn,
      honest({ text: { status: 503, body: "" } }).fetchFn,
      honest({ chainId: { status: 429, body: "" } }).fetchFn,
    ])
      expect(await loadElection(DEPLOYMENT, ID, fetchFn)).toEqual({
        ok: false,
        problem: "unreachable",
      });
  });

  test("an answer with extra fields, other spellings or no JSON is refused", async () => {
    for (const body of [
      JSON.stringify({ definition: DEFINITION, extra: 1 }),
      JSON.stringify({ definition: DEFINITION.toUpperCase() }),
      JSON.stringify({ definition: "abc" }),
      JSON.stringify({ definition: `0x${DEFINITION}` }),
      JSON.stringify({ displayText: DEFINITION }),
      JSON.stringify([DEFINITION]),
      "not json",
      "",
    ])
      expect(
        await loadElection(DEPLOYMENT, ID, honest({ definition: { status: 200, body } }).fetchFn),
      ).toEqual({ ok: false, problem: "bad-answer" });
  });

  test("the largest record of each kind is read, and an answer much longer is refused", async () => {
    const at = (field: string, bytes: number) =>
      ({ status: 200, body: JSON.stringify({ [field]: "00".repeat(bytes) }) }) as const;
    const largest = await loadElection(
      DEPLOYMENT,
      ID,
      honest({
        definition: at("definition", PARAMETERS.MAX_BOARD_PAYLOAD),
        text: at("displayText", PARAMETERS.MAX_DISPLAY_TEXT),
      }).fetchFn,
    );
    if (!largest.ok) throw new Error(largest.problem);
    expect(largest.definition).toHaveLength(PARAMETERS.MAX_BOARD_PAYLOAD);
    expect(largest.displayText).toHaveLength(PARAMETERS.MAX_DISPLAY_TEXT);
    for (const override of [
      { definition: at("definition", PARAMETERS.MAX_BOARD_PAYLOAD + 200) },
      { text: at("displayText", PARAMETERS.MAX_DISPLAY_TEXT + 200) },
    ])
      expect(await loadElection(DEPLOYMENT, ID, honest(override).fetchFn)).toEqual({
        ok: false,
        problem: "bad-answer",
      });
  });

  test("an answer over the cap is cancelled, not read to its end", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(65_536).fill(0x30);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchFn: Fetch = (url, init) =>
      url.startsWith(DEPLOYMENT.api) && url.includes("/display-text")
        ? Promise.resolve(new Response(endless, { status: 200 }))
        : honest().fetchFn(url, init);
    expect(await loadElection(DEPLOYMENT, ID, fetchFn)).toEqual({
      ok: false,
      problem: "bad-answer",
    });
    expect(cancelled).toBe(true);
    expect(pulled * chunk.length).toBeLessThan(2 * PARAMETERS.MAX_DISPLAY_TEXT + 4 * chunk.length);
  });

  test("when both records fail, the same answers always show the same problem", async () => {
    // However the two requests race, withheld text outranks a missing definition.
    for (const delay of [0, 5]) {
      const { fetchFn } = honest({
        definition: { status: 404, body: "{}" },
        text: { status: 451, body: "{}" },
      });
      const slowFirst: Fetch = (url, init) =>
        url.includes("/display-text")
          ? new Promise((r) => setTimeout(r, delay)).then(() => fetchFn(url, init))
          : fetchFn(url, init);
      expect(await loadElection(DEPLOYMENT, ID, slowFirst)).toEqual({
        ok: false,
        problem: "withheld",
      });
    }
    // Another chain outranks the node's trouble with the call.
    const { fetchFn } = honest({
      chainId: { status: 200, body: rpcResult(1, "0x1") },
      call: "network",
    });
    expect(await loadElection(DEPLOYMENT, ID, fetchFn)).toEqual({
      ok: false,
      problem: "wrong-chain",
    });
  });

  test("an aborted load is thrown, never shown as a problem", async () => {
    const abort = new DOMException("aborted", "AbortError");
    await expect(loadElection(DEPLOYMENT, ID, () => Promise.reject(abort))).rejects.toBe(abort);
  });

  test("any bytes the API sends as hex come back exactly", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (bytes) => {
        const { fetchFn } = honest({
          text: { status: 200, body: JSON.stringify({ displayText: hex(bytes) }) },
        });
        const loaded = await loadElection(DEPLOYMENT, ID, fetchFn);
        if (!loaded.ok) throw new Error(loaded.problem);
        expect(hex(loaded.displayText)).toBe(hex(bytes));
      }),
      { numRuns },
    );
  });
});

describe("the board's first entry", () => {
  test("an empty board gives no entry, and the records still come back", async () => {
    const { fetchFn } = honest({ entries: { status: 200, body: JSON.stringify({ entries: [] }) } });
    const loaded = await loadElection(DEPLOYMENT, ID, fetchFn);
    if (!loaded.ok) throw new Error(loaded.problem);
    expect(loaded.entries).toEqual([]);
    expect(hex(loaded.definition)).toBe(DEFINITION);
  });

  test("more than the one entry asked for, other spellings or other shapes are refused", async () => {
    for (const body of [
      JSON.stringify({ entries: [ENTRY, ENTRY] }),
      JSON.stringify({ entries: [ENTRY.toUpperCase()] }),
      JSON.stringify({ entries: [""] }),
      JSON.stringify({ entries: ["abc"] }),
      JSON.stringify({ entries: [`0x${ENTRY}`] }),
      JSON.stringify({ entries: ENTRY }),
      JSON.stringify({ entries: [ENTRY], extra: 1 }),
      JSON.stringify({ entry: ENTRY }),
      "not json",
    ])
      expect(
        await loadElection(DEPLOYMENT, ID, honest({ entries: { status: 200, body } }).fetchFn),
      ).toEqual({ ok: false, problem: "bad-answer" });
  });

  test("the largest entry is read, and one much longer refused", async () => {
    const at = (bytes: number) =>
      ({ status: 200, body: JSON.stringify({ entries: ["00".repeat(bytes)] }) }) as const;
    const largest = await loadElection(
      DEPLOYMENT,
      ID,
      honest({ entries: at(PARAMETERS.MAX_BOARD_PAYLOAD + 51) }).fetchFn,
    );
    if (!largest.ok) throw new Error(largest.problem);
    expect(largest.entries[0]).toHaveLength(PARAMETERS.MAX_BOARD_PAYLOAD + 51);
    expect(
      await loadElection(
        DEPLOYMENT,
        ID,
        honest({ entries: at(PARAMETERS.MAX_BOARD_PAYLOAD + 300) }).fetchFn,
      ),
    ).toEqual({ ok: false, problem: "bad-answer" });
  });

  test("a board the API doesn't hold is not found, and its errors unreachable", async () => {
    expect(
      await loadElection(DEPLOYMENT, ID, honest({ entries: { status: 404, body: "{}" } }).fetchFn),
    ).toEqual({ ok: false, problem: "not-found" });
    for (const entries of ["network", { status: 503, body: "" }] as const)
      expect(await loadElection(DEPLOYMENT, ID, honest({ entries }).fetchFn)).toEqual({
        ok: false,
        problem: "unreachable",
      });
  });

  test("withheld text outranks the board's failure, whichever answers first", async () => {
    for (const delay of [0, 5]) {
      const { fetchFn } = honest({
        entries: "network",
        text: { status: 451, body: "{}" },
      });
      const slowFirst: Fetch = (url, init) =>
        url.includes("/display-text")
          ? new Promise((r) => setTimeout(r, delay)).then(() => fetchFn(url, init))
          : fetchFn(url, init);
      expect(await loadElection(DEPLOYMENT, ID, slowFirst)).toEqual({
        ok: false,
        problem: "withheld",
      });
    }
  });
});

/** A status answer: the poll hidden, its newest decision citing `reason`. */
const hidden = (reason: string): Answer => ({
  status: 200,
  body: JSON.stringify({
    state: "hidden",
    latest: { seq: "3", action: "hide", reason, decidedAt: "2026-10-18T01:00:00.000Z" },
  }),
});

// docs/moderation-policy.md, Open polls: a `threat` hide keeps the text in our
// ballot client under a notice, every other hide withholds it, and a state
// the client can't read is visible, so blocking the route can't stop voting
// (T-68).
/** The policy's removal grounds that withhold the text (docs/moderation-policy.md, Reasons). */
const WITHHOLDING = [
  "illegal",
  "personal-data",
  "harassment",
  "spam",
  "impersonation",
  "legal-notice",
];

describe("the moderation state", () => {
  test("a poll hidden as a threat comes back with its text and the notice", async () => {
    const { fetchFn } = honest({ status: hidden("threat") });
    const loaded = await loadElection(DEPLOYMENT, ID, fetchFn);
    if (!loaded.ok) throw new Error(loaded.problem);
    expect(hex(loaded.displayText)).toBe(TEXT);
    expect(loaded.hiddenAsThreat).toBe(true);
  });

  test("a poll hidden on any other ground is withheld, even if its text is served", async () => {
    for (const reason of WITHHOLDING) {
      const { fetchFn } = honest({ status: hidden(reason) });
      expect(await loadElection(DEPLOYMENT, ID, fetchFn)).toEqual({
        ok: false,
        problem: "withheld",
      });
    }
  });

  test("a withheld poll outranks the board's failure, whichever answers first", async () => {
    for (const delay of [0, 5]) {
      const { fetchFn } = honest({ entries: "network", status: hidden("illegal") });
      const slowFirst: Fetch = (url, init) =>
        url.includes("/moderation/status")
          ? new Promise((r) => setTimeout(r, delay)).then(() => fetchFn(url, init))
          : fetchFn(url, init);
      expect(await loadElection(DEPLOYMENT, ID, slowFirst)).toEqual({
        ok: false,
        problem: "withheld",
      });
    }
  });

  test("a delisted or restored poll is shown without the notice", async () => {
    for (const body of [
      { state: "delisted", latest: { seq: "1", action: "delist", reason: "spam", decidedAt: "x" } },
      {
        state: "visible",
        latest: { seq: "2", action: "restore", reason: "error", decidedAt: "x" },
      },
    ]) {
      const { fetchFn } = honest({ status: { status: 200, body: JSON.stringify(body) } });
      const loaded = await loadElection(DEPLOYMENT, ID, fetchFn);
      if (!loaded.ok) throw new Error(loaded.problem);
      expect(loaded.hiddenAsThreat).toBe(false);
    }
  });

  test("a state that can't be read is visible: the poll opens without the notice", async () => {
    const answers: Answer[] = [
      "network",
      { status: 500, body: "" },
      { status: 404, body: "{}" },
      { status: 451, body: "{}" },
      { status: 200, body: "not json" },
      { status: 200, body: JSON.stringify({ state: "hidden" }) },
      { status: 200, body: JSON.stringify({ state: "hidden", latest: { action: "delist" } }) },
      { status: 200, body: JSON.stringify({ state: "hidden", latest: { action: "hide" } }) },
      hidden("no-such-ground"),
      hidden("Illegal"),
      // An answer over the cap is refused unread, and so is visible too.
      {
        status: 200,
        body: JSON.stringify({
          state: "hidden",
          latest: { action: "hide", reason: "illegal", pad: "x".repeat(2048) },
        }),
      },
    ];
    for (const status of answers) {
      const { fetchFn } = honest({ status });
      const loaded = await loadElection(DEPLOYMENT, ID, fetchFn);
      if (!loaded.ok) throw new Error(`${JSON.stringify(status)}: ${loaded.problem}`);
      expect(loaded.hiddenAsThreat).toBe(false);
    }
  });

  test("whatever the status route answers, it never stops voting but by a withholding hide", async () => {
    const reason = fc.oneof(fc.constantFrom("threat", "error", ...WITHHOLDING), fc.string());
    const latest = fc.record(
      { action: fc.constantFrom("hide", "delist", "restore"), reason, seq: fc.string() },
      { requiredKeys: [] },
    );
    const body = fc.oneof(
      fc.record(
        { state: fc.constantFrom("visible", "delisted", "hidden"), latest },
        { requiredKeys: [] },
      ),
      fc.jsonValue(),
    );
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(200, 404, 500), body, async (code, answer) => {
        const { fetchFn } = honest({ status: { status: code, body: JSON.stringify(answer) } });
        const loaded = await loadElection(DEPLOYMENT, ID, fetchFn);
        const a = answer as { state?: unknown; latest?: { action?: unknown; reason?: unknown } };
        const hiddenBy =
          code === 200 &&
          typeof a === "object" &&
          a !== null &&
          a.state === "hidden" &&
          typeof a.latest === "object" &&
          a.latest !== null &&
          a.latest.action === "hide"
            ? a.latest.reason
            : undefined;
        if (hiddenBy === "threat") expect(loaded).toMatchObject({ ok: true, hiddenAsThreat: true });
        else if (typeof hiddenBy === "string" && WITHHOLDING.includes(hiddenBy))
          expect(loaded).toEqual({ ok: false, problem: "withheld" });
        else expect(loaded).toMatchObject({ ok: true, hiddenAsThreat: false });
      }),
      { numRuns },
    );
  });
});

describe("the link", () => {
  test("an election id in the fragment, in either case, is read as its bytes", () => {
    for (const spelling of [ID_HEX, ID_HEX.toUpperCase()]) {
      const link = parseLink(`#election=${spelling}`);
      if (link.kind !== "election") throw new Error(link.kind);
      expect(hex(link.electionId)).toBe(ID_HEX);
      expect(link.hex).toBe(ID_HEX);
    }
  });

  test("no fragment is the client's own page", () => {
    expect(parseLink("")).toEqual({ kind: "none" });
    expect(parseLink("#")).toEqual({ kind: "none" });
  });

  test("anything but exactly one 32-byte election id is malformed", () => {
    for (const hash of [
      `#election=${ID_HEX.slice(2)}`,
      `#election=${ID_HEX}00`,
      `#election=0x${ID_HEX}`,
      `#election=${ID_HEX}&pick=1`,
      `#poll=${ID_HEX}`,
      `#election=${ID_HEX.slice(1)}g`,
      `#election= ${ID_HEX}`,
    ])
      expect(parseLink(hash)).toEqual({ kind: "malformed" });
    // Around the one valid form: an id with characters cut, added or replaced,
    // or another parameter beside it.
    const id = fc.stringMatching(/^[0-9a-fA-F]{64}$/);
    const near = fc.oneof(
      id.chain((x) => fc.nat({ max: 63 }).map((n) => `election=${x.slice(0, n)}`)),
      fc.tuple(id, fc.string({ minLength: 1, maxLength: 4 })).map(([x, s]) => `election=${x}${s}`),
      fc
        .tuple(id, fc.nat({ max: 63 }), fc.constantFrom("g", "x", " ", "%", "&", "="))
        .map(([x, i, c]) => `election=${x.slice(0, i)}${c}${x.slice(i + 1)}`),
      fc.tuple(fc.string({ minLength: 1, maxLength: 8 }), id).map(([p, x]) => `${p}election=${x}`),
      fc.tuple(id, fc.string({ maxLength: 8 })).map(([x, s]) => `election=${x}&${s}`),
    );
    fc.assert(
      fc.property(near, (s) => {
        expect(parseLink(`#${s}`)).toEqual({ kind: "malformed" });
      }),
      { numRuns },
    );
    fc.assert(
      fc.property(id, (x) => {
        const link = parseLink(`#election=${x}`);
        if (link.kind !== "election") throw new Error(link.kind);
        expect(link.hex).toBe(x.toLowerCase());
        expect(hex(link.electionId)).toBe(x.toLowerCase());
      }),
      { numRuns },
    );
  });
});

describe("the whole board", () => {
  const PAGE = 256;
  const pageUrl = (start: number) =>
    `${DEPLOYMENT.api}/board/entries?electionId=${ID_HEX}&start=${start}&limit=${PAGE}`;
  /** A board of `entries`, served in pages of `size` (the API may serve fewer than asked). */
  const served = (entries: readonly string[], size = PAGE) =>
    network((url) => {
      for (let start = 0; start <= entries.length; start++)
        if (url === pageUrl(start))
          return {
            status: 200,
            body: JSON.stringify({ entries: entries.slice(start, start + size) }),
          };
      return { status: 500, body: "" };
    });

  test("every entry comes back in order, whatever page sizes the API serves, and only positions are asked", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ minLength: 1, maxLength: 8 }), { maxLength: 600 }),
        fc.integer({ min: 1, max: PAGE }),
        async (entries, size) => {
          const { calls, fetchFn } = served(entries.map(hex), size);
          const loaded = await loadBoard(DEPLOYMENT, ID, fetchFn);
          if (!loaded.ok) throw new Error(loaded.problem);
          expect(loaded.entries.map(hex)).toEqual(entries.map(hex));
          // Pages until an empty one, each from where the last ended.
          expect(calls).toHaveLength(Math.ceil(entries.length / size) + 1);
          for (const { url, init } of calls) {
            expect(url).toMatch(
              new RegExp(
                `^${DEPLOYMENT.api}/board/entries\\?electionId=${ID_HEX}&start=\\d+&limit=${PAGE}$`,
              ),
            );
            expect(init).toMatchObject({
              credentials: "omit",
              referrerPolicy: "no-referrer",
              redirect: "error",
            });
          }
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("a page longer than asked for, other spellings or shapes are refused", async () => {
    const tooMany = Array.from({ length: PAGE + 1 }, () => ENTRY);
    for (const body of [
      JSON.stringify({ entries: tooMany }),
      JSON.stringify({ entries: [ENTRY.toUpperCase()] }),
      JSON.stringify({ entries: [""] }),
      JSON.stringify({ entries: [`0x${ENTRY}`] }),
      JSON.stringify({ entries: [ENTRY], extra: 1 }),
      "not json",
    ])
      expect(
        await loadBoard(DEPLOYMENT, ID, network(() => ({ status: 200, body })).fetchFn),
      ).toEqual({ ok: false, problem: "bad-answer" });
  });

  test("a board that never ends is refused once it runs out the budget, not read forever", async () => {
    // Each page costs 64 KiB of the budget and each entry its bytes and 64.
    const MiB = 1024 * 1024;
    const kilobytes = Array.from({ length: PAGE }, () => "00".repeat(1024));
    const full = network(() => ({ status: 200, body: JSON.stringify({ entries: kilobytes }) }));
    expect(await loadBoard(DEPLOYMENT, ID, full.fetchFn, MiB)).toEqual({
      ok: false,
      problem: "bad-answer",
    });
    expect(full.calls).toHaveLength(4);
    // One tiny entry a page: the pages' cost stops it, after 16 requests for 1 MiB.
    const tiny = network(() => ({ status: 200, body: JSON.stringify({ entries: [ENTRY] }) }));
    expect(await loadBoard(DEPLOYMENT, ID, tiny.fetchFn, MiB)).toEqual({
      ok: false,
      problem: "bad-answer",
    });
    expect(tiny.calls).toHaveLength(16);
    // A board within the budget is read: three full pages of kilobyte entries.
    const within = served(Array.from({ length: 3 * PAGE }, () => "00".repeat(1024)));
    const loaded = await loadBoard(DEPLOYMENT, ID, within.fetchFn, MiB);
    expect(loaded.ok && loaded.entries.length).toBe(3 * PAGE);
  });

  test("the largest entry is read alone in a page", async () => {
    const largest = "00".repeat(PARAMETERS.MAX_BOARD_PAYLOAD + 51);
    const loaded = await loadBoard(DEPLOYMENT, ID, served([largest, ENTRY], 1).fetchFn);
    if (!loaded.ok) throw new Error(loaded.problem);
    expect(loaded.entries.map(hex)).toEqual([largest, ENTRY]);
  });

  test("a board the API doesn't hold is not found, and its errors unreachable", async () => {
    const answers: [Answer, string][] = [
      [{ status: 404, body: "{}" }, "not-found"],
      [{ status: 503, body: "" }, "unreachable"],
      ["network", "unreachable"],
    ];
    for (const [answer, problem] of answers) {
      // The failure on the second page, after a good first one.
      const { fetchFn } = network((url) =>
        url === pageUrl(0) ? { status: 200, body: JSON.stringify({ entries: [ENTRY] }) } : answer,
      );
      expect(await loadBoard(DEPLOYMENT, ID, fetchFn)).toEqual({ ok: false, problem });
    }
  });
});

describe("the deployments", () => {
  test("staging's origins are the ones the CSP lets the client reach, and its registry is a plain address or none", () => {
    expect(STAGING.api).toBe("https://api-staging.abolish.us");
    expect(STAGING.rpc).toBe("https://sepolia.base.org");
    expect(STAGING.chainId).toBe(84532n);
    // 0x and 40 lowercase hex digits: eth_call's `to` as the RPC expects it, never a checksum spelling.
    if (STAGING.electionRegistry !== undefined)
      expect(STAGING.electionRegistry).toMatch(/^0x[0-9a-f]{40}$/);
    // Registrars are addresses, at least `threshold` of them.
    if (STAGING.registrars !== undefined) {
      expect(STAGING.registrars.registrars.every((r) => r.length === 20)).toBe(true);
      expect(STAGING.registrars.threshold).toBeLessThanOrEqual(
        STAGING.registrars.registrars.length,
      );
    }
  });
});
