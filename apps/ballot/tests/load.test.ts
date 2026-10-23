// Fetching what the worker checks (src/load.ts): the registry is read at the
// pinned address on the pinned chain, at the finalized head, and every answer
// that isn't shaped like one ends in a problem, never in bytes handed on;
// requests carry no credentials or referrer and name only the election
// (T-10, T-11, T-34, T-52). The board's first entry, which carries the
// ceremony transcript, is fetched beside the records; the whole board, for
// the voter's cell, page by page, naming nothing but the election and a
// position (T-10, T-13); the whole group registry from the L2, naming
// nothing but its address and block ranges (T-11, T-13). Whether the records may be shown is the worker's
// check, tested in election.test.ts and packages/crypto.

import { decodeContractEvent, MAX_EVENT_DATA, PARAMETERS } from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

import type { Deployment } from "../src/deployment.ts";
import { confirming, STAGING } from "../src/deployment.ts";
import { parseLink } from "../src/link.ts";
import {
  DEFINITION_HASH_OF,
  type Fetch,
  loadBoard,
  loadChainTime,
  loadElection,
  loadGroupRegistry,
  loadPostings,
} from "../src/load.ts";

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

  test("a pick after the election is read as the option, in its one decimal spelling", () => {
    expect(parseLink(`#election=${ID_HEX}`)).not.toHaveProperty("pick");
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-fA-F]{64}$/), fc.nat({ max: 63 }), (x, pick) => {
        const link = parseLink(`#election=${x}&pick=${pick}`);
        if (link.kind !== "election") throw new Error(link.kind);
        expect(link.hex).toBe(x.toLowerCase());
        expect(link.pick).toBe(pick);
      }),
      { numRuns },
    );
    // Whatever parses is the link written back in its one form.
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), (s) => {
        const link = parseLink(`#election=${ID_HEX}&pick=${s}`);
        if (link.kind === "election") expect(`${link.pick}`).toBe(s);
      }),
      { numRuns },
    );
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
      `#election=${ID_HEX}&pick=01`,
      `#election=${ID_HEX}&pick=64`,
      `#election=${ID_HEX}&pick=-1`,
      `#election=${ID_HEX}&pick=+1`,
      `#election=${ID_HEX}&pick=1&pick=2`,
      `#election=${ID_HEX}&pick=`,
      `#election=${ID_HEX}&pick=1&`,
      `#pick=1&election=${ID_HEX}`,
      `#election=${ID_HEX}&Pick=1`,
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
        // The one other parameter a link may carry, in its one spelling.
        fc.pre(!/&pick=(0|[1-9][0-9]?)$/.test(s) || Number(s.split("=").at(-1)) >= 64);
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

describe("the group registry's log", () => {
  const GROUP_REGISTRY = "0x00000000000000000000000000000000000000bb";
  const DEPLOYED_AT = 100n;
  const HEAD = 140n;
  const WITH_REGISTRY: Deployment = {
    ...DEPLOYMENT,
    groupRegistry: { address: GROUP_REGISTRY, deployedAt: DEPLOYED_AT, eventVersion: 8 },
  };
  const quantity = (n: bigint) => `0x${n.toString(16)}`;

  interface Log {
    readonly block: bigint;
    readonly index: bigint;
    readonly topics: readonly string[];
    readonly data: string;
  }
  const logJson = (l: Log, change: Record<string, unknown> = {}) => ({
    address: GROUP_REGISTRY,
    topics: l.topics.map((t) => `0x${t}`),
    data: `0x${l.data}`,
    blockNumber: quantity(l.block),
    logIndex: quantity(l.index),
    removed: false,
    ...change,
  });

  /** An L2 node holding `logs`, answering each range with the ones in it, or as `answer` decides. */
  function node(
    logs: readonly Log[],
    answer: (method: string, from: bigint, to: bigint) => unknown = () => undefined,
  ) {
    const calls: { init: RequestInit; body: { id: number; method: string; params: unknown[] } }[] =
      [];
    const fetchFn: Fetch = (url, init) => {
      expect(url).toBe(WITH_REGISTRY.rpc);
      const body = JSON.parse(init.body as string) as (typeof calls)[number]["body"];
      calls.push({ init, body });
      const filter = body.params[0] as { fromBlock?: string; toBlock?: string } | undefined;
      const from = BigInt(filter?.fromBlock ?? 0);
      const to = BigInt(filter?.toBlock ?? 0);
      const own = answer(body.method, from, to);
      if (own === "network") return Promise.reject(new TypeError("Failed to fetch"));
      // `undefined` is the honest answer; anything else, `null` included, is served as it is.
      const result =
        own !== undefined
          ? own
          : body.method === "eth_chainId"
            ? "0x14a34"
            : body.method === "eth_getBlockByNumber"
              ? { number: quantity(HEAD), timestamp: "0x68f00000", transactions: [] }
              : logs.filter((l) => l.block >= from && l.block <= to).map((l) => logJson(l));
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 }),
      );
    };
    return { calls, fetchFn };
  }

  test("read through the second endpoint, every request goes to it alone, and a build naming none has none", async () => {
    const second = confirming(WITH_REGISTRY);
    expect(second).toEqual({ ...WITH_REGISTRY, rpc: "https://base-sepolia-rpc.publicnode.com" });
    expect(confirming({ ...WITH_REGISTRY, confirmRpc: undefined })).toBeUndefined();
    if (second === undefined) throw new Error("staging names a second endpoint");
    const { fetchFn, calls } = node([]);
    const urls: string[] = [];
    const loaded = await loadGroupRegistry(second, (url, init) => {
      urls.push(url);
      return fetchFn(WITH_REGISTRY.rpc, init);
    });
    expect(loaded.ok).toBe(true);
    expect(urls).toHaveLength(calls.length);
    expect(urls.every((u) => u === "https://base-sepolia-rpc.publicnode.com")).toBe(true);
  });

  const word = (b: number) => b.toString(16).padStart(64, "0");
  const arbitraryLogs = fc
    .array(
      fc.record({
        block: fc.bigInt({ min: DEPLOYED_AT, max: HEAD }),
        topics: fc.array(fc.integer({ min: 0, max: 255 }).map(word), {
          minLength: 1,
          maxLength: 4,
        }),
        data: fc.uint8Array({ maxLength: 96 }).map(hex),
      }),
      { maxLength: 40 },
    )
    .map((logs) => {
      const sorted = logs
        .slice()
        .sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
      // Log indices count up within each block, as a node numbers them.
      return sorted.map((l, i) => ({
        ...l,
        index: BigInt(sorted.slice(0, i).filter((m) => m.block === l.block).length),
      }));
    });

  test("every log since the deployment comes back in order, numbered from 0, from ranges that name only the registry", async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryLogs, fc.integer({ min: 1, max: 50 }), async (logs, range) => {
        const { calls, fetchFn } = node(logs);
        const loaded = await loadGroupRegistry(WITH_REGISTRY, fetchFn, undefined, BigInt(range));
        if (!loaded.ok) throw new Error(loaded.problem);
        expect(loaded.block).toBe(HEAD);
        expect(loaded.timestamp).toBe(0x68f00000n);
        expect(loaded.records.map((r) => decodeContractEvent(r, 8))).toEqual(
          logs.map((l, n) => ({
            contract: Uint8Array.from(Buffer.from(GROUP_REGISTRY.slice(2), "hex")),
            n: BigInt(n),
            l2_block: l.block,
            l2_timestamp: 0n,
            topics: l.topics.map((t) => Uint8Array.from(Buffer.from(t, "hex"))),
            data: Uint8Array.from(Buffer.from(l.data, "hex")),
          })),
        );
        // The finalized head, then ranges from the deployment to it, end to end.
        expect(calls.find((c) => c.body.method === "eth_getBlockByNumber")?.body.params).toEqual([
          "finalized",
          false,
        ]);
        const ranges = calls.filter((c) => c.body.method === "eth_getLogs");
        let next = DEPLOYED_AT;
        for (const { body, init } of ranges) {
          expect(body.params).toEqual([
            {
              address: GROUP_REGISTRY,
              fromBlock: quantity(next),
              toBlock: quantity(
                next + BigInt(range) - 1n < HEAD ? next + BigInt(range) - 1n : HEAD,
              ),
            },
          ]);
          next += BigInt(range);
          expect(init).toMatchObject({
            credentials: "omit",
            referrerPolicy: "no-referrer",
            redirect: "error",
          });
        }
        expect(next).toBeGreaterThan(HEAD);
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("a build that pins no group registry asks nothing of anyone", async () => {
    const { calls, fetchFn } = node([]);
    expect(await loadGroupRegistry(DEPLOYMENT, fetchFn)).toEqual({
      ok: false,
      problem: "no-registry",
    });
    expect(calls).toHaveLength(0);
  });

  test("an RPC on another chain isn't believed", async () => {
    const { fetchFn } = node([], (method) => (method === "eth_chainId" ? "0x1" : undefined));
    expect(await loadGroupRegistry(WITH_REGISTRY, fetchFn)).toEqual({
      ok: false,
      problem: "wrong-chain",
    });
  });

  const LOG: Log = { block: 120n, index: 0n, topics: [word(1)], data: "" };

  test.each([
    ["another address's log", logJson(LOG, { address: DEPLOYMENT.electionRegistry })],
    ["a log reorganised away", logJson(LOG, { removed: true })],
    ["a log outside the range asked", logJson({ ...LOG, block: HEAD + 1n })],
    ["a log before the deployment", logJson({ ...LOG, block: DEPLOYED_AT - 1n })],
    ["a log with no topics", logJson({ ...LOG, topics: [] })],
    ["a log with five topics", logJson({ ...LOG, topics: Array(5).fill(word(1)) })],
    ["a short topic", logJson(LOG, { topics: [`0x${"00".repeat(31)}`] })],
    ["odd-length data", logJson(LOG, { data: "0x0" })],
    ["data with no 0x", logJson(LOG, { data: "00" })],
    ["a block number with a leading zero", logJson(LOG, { blockNumber: "0x078" })],
    ["a log with no index", logJson(LOG, { logIndex: undefined })],
    ["an uppercase topic", logJson(LOG, { topics: [`0x${word(171).toUpperCase()}`] })],
    ["uppercase data", logJson(LOG, { data: "0xAB" })],
    ["data past MAX_EVENT_DATA", logJson({ ...LOG, data: "00".repeat(MAX_EVENT_DATA + 1) })],
    ["a log that isn't an object", "0x00"],
  ])("refuses %s", async (_, log) => {
    const { fetchFn } = node([], (method) => (method === "eth_getLogs" ? [log] : undefined));
    expect(await loadGroupRegistry(WITH_REGISTRY, fetchFn)).toEqual({
      ok: false,
      problem: "bad-answer",
    });
  });

  test("refuses logs out of order or repeated, within a range or across two", async () => {
    const a = { ...LOG, index: 3n };
    for (const logs of [
      [a, { ...a, index: 2n }],
      [a, a],
      [a, { ...a, block: a.block - 1n, index: 9n }],
    ]) {
      expect(
        await loadGroupRegistry(
          WITH_REGISTRY,
          node([], (method) => (method === "eth_getLogs" ? logs.map((l) => logJson(l)) : undefined))
            .fetchFn,
        ),
      ).toEqual({ ok: false, problem: "bad-answer" });
    }
    // The same log served again by the next range, as a node ignoring the range would.
    const { fetchFn } = node([], (method, from) =>
      method === "eth_getLogs" ? (from <= 130n ? [logJson(LOG)] : []) : undefined,
    );
    expect(await loadGroupRegistry(WITH_REGISTRY, fetchFn, undefined, 10n)).toEqual({
      ok: false,
      problem: "bad-answer",
    });
  });

  test("a finalized block, chain id or log list outside its form is refused", async () => {
    for (const [method, result] of [
      ["eth_getBlockByNumber", null],
      ["eth_getBlockByNumber", { number: "0x8c" }],
      ["eth_getBlockByNumber", { number: 140, timestamp: "0x1" }],
      ["eth_getBlockByNumber", { number: "0x8C", timestamp: "0x1" }],
      ["eth_chainId", 84532],
      ["eth_getLogs", {}],
      ["eth_getLogs", null],
    ] as const) {
      const { fetchFn } = node([], (m) => (m === method ? result : undefined));
      expect(
        await loadGroupRegistry(WITH_REGISTRY, fetchFn),
        `${method} ${JSON.stringify(result)}`,
      ).toEqual({ ok: false, problem: "bad-answer" });
    }
  });

  test("the largest event's data is read, and a finalized block's answer past its cap refused", async () => {
    const largest = { ...LOG, data: "00".repeat(MAX_EVENT_DATA) };
    const loaded = await loadGroupRegistry(WITH_REGISTRY, node([largest]).fetchFn);
    expect(loaded.ok && loaded.records.length).toBe(1);
    // 2 MiB: a block's header with tens of thousands of transaction hashes.
    const transactions = Array.from({ length: 32 * 1024 }, () => `0x${word(1)}`);
    const { fetchFn } = node([], (method) =>
      method === "eth_getBlockByNumber"
        ? { number: quantity(HEAD), timestamp: "0x1", transactions }
        : undefined,
    );
    expect(await loadGroupRegistry(WITH_REGISTRY, fetchFn)).toEqual({
      ok: false,
      problem: "bad-answer",
    });
  });

  test("a node's error or a failed network is unreachable", async () => {
    const failing = (method: string): Fetch => {
      const { fetchFn } = node([], (m) => (m === method ? "network" : undefined));
      return fetchFn;
    };
    for (const method of ["eth_chainId", "eth_getBlockByNumber", "eth_getLogs"])
      expect(await loadGroupRegistry(WITH_REGISTRY, failing(method))).toEqual({
        ok: false,
        problem: "unreachable",
      });
    // A node refusing the range ("too many results") says so in `error`.
    const fetchFn: Fetch = (_url, init) => {
      const { id, method } = JSON.parse(init.body as string) as { id: number; method: string };
      const answer =
        method === "eth_getLogs"
          ? { jsonrpc: "2.0", id, error: { code: -32005, message: "limit exceeded" } }
          : {
              jsonrpc: "2.0",
              id,
              result: method === "eth_chainId" ? "0x14a34" : { number: "0x8c", timestamp: "0x1" },
            };
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
    };
    expect(await loadGroupRegistry(WITH_REGISTRY, fetchFn)).toEqual({
      ok: false,
      problem: "unreachable",
    });
  });

  test("a registry that never ends is refused once it runs out the budget, not read forever", async () => {
    // Each range costs 1 KiB of the budget, and each log its bytes, 32 a topic and 64.
    const MiB = 1024 * 1024;
    const kilobyte = (block: bigint, index: bigint): Log => ({
      block,
      index,
      topics: [word(1)],
      data: "00".repeat(1024),
    });
    const many = Array.from({ length: 41 * 64 }, (_, i) =>
      kilobyte(DEPLOYED_AT + BigInt(Math.floor(i / 64)), BigInt(i % 64)),
    );
    expect(await loadGroupRegistry(WITH_REGISTRY, node(many).fetchFn, MiB, 1n)).toEqual({
      ok: false,
      problem: "bad-answer",
    });
    // One range a block, with nothing in it: the ranges' cost stops it.
    const empty = node([]);
    expect(await loadGroupRegistry(WITH_REGISTRY, empty.fetchFn, 4 * 1024, 1n)).toEqual({
      ok: false,
      problem: "bad-answer",
    });
    expect(empty.calls.filter((c) => c.body.method === "eth_getLogs")).toHaveLength(5);
    // A registry within the budget is read.
    const loaded = await loadGroupRegistry(WITH_REGISTRY, node(many.slice(0, 512)).fetchFn, MiB);
    expect(loaded.ok && loaded.records.length).toBe(512);
  });
});

describe("the deployments", () => {
  test("staging's origins are the ones the CSP lets the client reach, and its registry is a plain address or none", () => {
    expect(STAGING.api).toBe("https://api-staging.abolish.us");
    expect(STAGING.rpc).toBe("https://sepolia.base.org");
    expect(STAGING.confirmRpc).toBe("https://base-sepolia-rpc.publicnode.com");
    expect(STAGING.chainId).toBe(84532n);
    // 0x and 40 lowercase hex digits: eth_call's `to` as the RPC expects it, never a checksum spelling.
    if (STAGING.electionRegistry !== undefined)
      expect(STAGING.electionRegistry).toMatch(/^0x[0-9a-f]{40}$/);
    if (STAGING.groupRegistry !== undefined)
      expect(STAGING.groupRegistry.address).toMatch(/^0x[0-9a-f]{40}$/);
    // Registrars are addresses, at least `threshold` of them.
    if (STAGING.registrars !== undefined) {
      expect(STAGING.registrars.registrars.every((r) => r.length === 20)).toBe(true);
      expect(STAGING.registrars.threshold).toBeLessThanOrEqual(
        STAGING.registrars.registrars.length,
      );
    }
  });
});

describe("the chain's time", () => {
  /** An L2 node answering `eth_chainId` with `chainId` and the finalized head with `head`. */
  const node = (head: unknown, chainId: unknown = "0x14a34") =>
    network((url, method) => {
      expect(url).toBe(STAGING.rpc);
      return {
        status: 200,
        body: method === "eth_chainId" ? rpcResult(1, chainId) : rpcResult(2, head),
      };
    });

  test("is the L2's finalized head's timestamp, asked for with nothing else", async () => {
    const { calls, fetchFn } = node({ number: "0x8c", timestamp: "0x6abcdef0" });
    await expect(loadChainTime(STAGING, fetchFn)).resolves.toEqual({
      ok: true,
      timestamp: 0x6abcdef0n,
    });
    expect(calls.map(({ body }) => body)).toEqual([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: ["finalized", false] },
    ]);
    for (const { init } of calls) {
      expect(init.credentials).toBe("omit");
      expect(init.referrerPolicy).toBe("no-referrer");
    }
  });

  test("is refused from another chain, an answer that isn't a block, and a network that fails", async () => {
    await expect(
      loadChainTime(STAGING, node({ number: "0x8c", timestamp: "0x1" }, "0x1").fetchFn),
    ).resolves.toEqual({ ok: false, problem: "wrong-chain" });
    for (const head of [
      null,
      "0x1",
      { number: "0x8c" },
      { number: "0x8c", timestamp: 1 },
      { number: "0x8c", timestamp: "0x01" },
      { number: "0x8c", timestamp: "0x1".padEnd(20, "f") },
      { timestamp: "0x1" },
    ])
      await expect(loadChainTime(STAGING, node(head).fetchFn)).resolves.toEqual({
        ok: false,
        problem: "bad-answer",
      });
    await expect(loadChainTime(STAGING, network(() => "network").fetchFn)).resolves.toEqual({
      ok: false,
      problem: "unreachable",
    });
  });
});

// A posting's outcome is read from the board's own `SharePosted` events
// ([[posting-relay]], Outcome): the logs are docs/spec/vectors/
// contract-event-v9.json's, made by an independent generator, never by the
// code under test.
describe("the board's postings", () => {
  interface VectorRecord {
    readonly id: string;
    readonly fields: {
      readonly contract: string;
      readonly topics: string[];
      readonly data: string;
    };
    readonly event?: { readonly record?: string };
  }
  const vectors = JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/contract-event-v9.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly records: readonly VectorRecord[]; readonly contracts: Record<string, string> };
  const vector = (id: string) => {
    const r = vectors.records.find((v) => v.id === id);
    if (r === undefined) throw new Error(`no vector ${id}`);
    return r;
  };
  const BOARD = `0x${vectors.contracts["board"] as string}`;
  const DEPLOYED_AT = 100n;
  const HEAD = 140n;
  const WITH_BOARD: Deployment = {
    ...DEPLOYMENT,
    board: { address: BOARD, deployedAt: DEPLOYED_AT, eventVersion: 9 },
  };
  const quantity = (n: bigint) => `0x${n.toString(16)}`;
  const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

  const posting = vector("delivery-v2-posting-default");
  const other = vector("delivery-v2-posting-author");
  const [, DEFINITION_TOPIC, BALLOT_TOPIC] = posting.fields.topics as [string, string, string];
  // The record the event carries: its ABI encoding's one `bytes` tail.
  const recordOf = (data: string) => {
    const length = Number(BigInt(`0x${data.slice(64, 128)}`));
    return bytes(data.slice(128, 128 + 2 * length));
  };
  const RECORD = recordOf(posting.fields.data);

  interface Log {
    readonly block: bigint;
    readonly index: bigint;
    readonly topics: readonly string[];
    readonly data: string;
    readonly address?: string;
  }
  const at = (block: bigint, index: bigint, v: VectorRecord, change: Partial<Log> = {}): Log => ({
    block,
    index,
    topics: v.fields.topics,
    data: v.fields.data,
    ...change,
  });

  /** An L2 node holding `logs`, answering each `eth_getLogs` with those in its range and topics. */
  function node(logs: readonly Log[], head = HEAD) {
    const calls: { method: string; params: unknown[]; init: RequestInit }[] = [];
    const fetchFn: Fetch = (url, init) => {
      expect(url).toBe(WITH_BOARD.rpc);
      const body = JSON.parse(init.body as string) as {
        id: number;
        method: string;
        params: unknown[];
      };
      calls.push({ method: body.method, params: body.params, init });
      const filter = body.params[0] as { fromBlock: string; toBlock: string; topics: unknown[] };
      const result =
        body.method === "eth_chainId"
          ? "0x14a34"
          : body.method === "eth_getBlockByNumber"
            ? { number: quantity(head), timestamp: "0x68f00000", transactions: [] }
            : logs
                .filter(
                  (l) => l.block >= BigInt(filter.fromBlock) && l.block <= BigInt(filter.toBlock),
                )
                .map((l) => ({
                  address: l.address ?? BOARD,
                  topics: l.topics.map((t) => `0x${t}`),
                  data: `0x${l.data}`,
                  blockNumber: quantity(l.block),
                  logIndex: quantity(l.index),
                  removed: false,
                }));
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 }),
      );
    };
    return { calls, fetchFn };
  }

  const load = (fetchFn: Fetch, head: "finalized" | "latest" = "finalized", from?: bigint) =>
    loadPostings(WITH_BOARD, bytes(DEFINITION_TOPIC), bytes(BALLOT_TOPIC), fetchFn, head, from);

  test("the ballot's postings come back from the head asked, read by its two hashes from the deployment on", async () => {
    for (const head of ["finalized", "latest"] as const) {
      const { calls, fetchFn } = node([at(120n, 0n, posting)]);
      expect(await load(fetchFn, head)).toEqual({
        ok: true,
        block: HEAD,
        timestamp: 0x68f00000n,
        records: [RECORD],
      });
      expect(calls.find((c) => c.method === "eth_getBlockByNumber")?.params).toEqual([head, false]);
      expect(calls.filter((c) => c.method === "eth_getLogs").map((c) => c.params)).toEqual([
        [
          {
            address: BOARD,
            topics: [null, `0x${DEFINITION_TOPIC}`, `0x${BALLOT_TOPIC}`],
            fromBlock: quantity(DEPLOYED_AT),
            toBlock: quantity(HEAD),
          },
        ],
      ]);
      for (const { init } of calls)
        expect(init).toMatchObject({
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "error",
        });
    }
  });

  test("a read from a later block starts there, in ranges of the size asked", async () => {
    const { calls, fetchFn } = node([at(101n, 0n, posting), at(131n, 0n, posting)]);
    const loaded = await loadPostings(
      WITH_BOARD,
      bytes(DEFINITION_TOPIC),
      bytes(BALLOT_TOPIC),
      fetchFn,
      "finalized",
      125n,
      10n,
    );
    expect(loaded).toMatchObject({ ok: true, records: [RECORD] });
    expect(
      calls
        .filter((c) => c.method === "eth_getLogs")
        .map((c) => {
          const f = c.params[0] as { fromBlock: string; toBlock: string };
          return [f.fromBlock, f.toBlock];
        }),
    ).toEqual([
      [quantity(125n), quantity(134n)],
      [quantity(135n), quantity(HEAD)],
    ]);
  });

  test("only a SharePosted the board frames, under the ballot's own hashes, is a posting", async () => {
    // A log under another ballot's hash, served despite the filter, which
    // its record disagrees with; the record under another event's topic 0;
    // then two postings of the ballot (the vectors' are for two panels).
    const receiptTopic = Buffer.from(
      keccak_256(new TextEncoder().encode("ShareReceiptSubmitted(bytes32,bytes32,bytes)")),
    ).toString("hex");
    const [postedTopic] = posting.fields.topics as [string];
    const { fetchFn } = node([
      at(110n, 0n, posting, { topics: [postedTopic, DEFINITION_TOPIC, "ff".repeat(32)] }),
      at(111n, 0n, posting, { topics: [receiptTopic, DEFINITION_TOPIC, BALLOT_TOPIC] }),
      at(112n, 0n, other),
      at(113n, 0n, posting),
    ]);
    expect(await load(fetchFn)).toMatchObject({
      ok: true,
      records: [recordOf(other.fields.data), RECORD],
    });
  });

  test("a log of another address, outside the range or out of order is a bad answer", async () => {
    for (const logs of [
      [at(120n, 0n, posting, { address: REGISTRY })],
      [at(HEAD + 1n, 0n, posting)],
      [at(120n, 1n, posting), at(120n, 0n, posting)],
    ]) {
      const { fetchFn } = node(logs);
      // The node serves every log it holds, whatever range was asked.
      const loose: Fetch = (url, init) => {
        const body = JSON.parse(init.body as string) as { params: { toBlock?: string }[] };
        const filter = body.params[0];
        if (filter?.toBlock !== undefined) filter.toBlock = quantity(HEAD + 1n);
        return fetchFn(url, { ...init, body: JSON.stringify(body) });
      };
      expect(await load(loose)).toEqual({ ok: false, problem: "bad-answer" });
    }
  });

  test("a build that pins no board asks nothing of anyone", async () => {
    const { calls, fetchFn } = node([]);
    expect(
      await loadPostings(
        DEPLOYMENT,
        bytes(DEFINITION_TOPIC),
        bytes(BALLOT_TOPIC),
        fetchFn,
        "finalized",
      ),
    ).toEqual({ ok: false, problem: "no-registry" });
    expect(calls).toHaveLength(0);
  });
});
