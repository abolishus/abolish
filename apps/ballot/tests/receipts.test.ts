import { encodeBoardEntry, encodeShareReceipt, RECORD_TYPES } from "@abolishus/crypto";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

import { checkReceiptEntry, type ReceiptAnswer, submitReceipt } from "../src/receipts.ts";

// Submitting a kept share receipt to `receipts.submit` once its ballot is
// boarded, and judging the operator's answer (src/receipts.ts; [[delivery]],
// Client rule 3): the request carries only the election and the receipt's
// bytes, with no credential, referrer or redirect (T-10), each of the
// route's answers is read only in its own shape, the answer is read only
// up to a bound (T-52), and a boarded answer passes only if its entry names
// the election and carries exactly the bytes sent, or, when the operator
// says an earlier receipt for the seat is boarded, a share receipt for the
// same seat, left for the worker to judge (T-38).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const VECTORS = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/share-receipt.json", import.meta.url), "utf8"),
) as {
  intakes: { seat: number; ballotHash: string; shareHash: string; receipt?: string }[];
};
/** The intakes that receipted. */
const INTAKES = VECTORS.intakes.flatMap(({ receipt, ...intake }) =>
  receipt === undefined ? [] : [{ ...intake, receipt }],
);

const API = "https://api-staging.abolish.us";
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

const DEFINITION = new Uint8Array(32).fill(0xde);
/** The spec's intakes as share receipt records (version 1) of a definition. */
const RECEIPTS = INTAKES.map(({ seat, ballotHash, shareHash, receipt }) =>
  encodeShareReceipt({
    definition_hash: DEFINITION,
    ballot_hash: fromHex(ballotHash),
    seat,
    share_hash: fromHex(shareHash),
    signature: fromHex(receipt),
  }),
);
const RECEIPT = RECEIPTS[0]!;
const SEAT = INTAKES[0]!.seat;
/** Another receipt for the same seat: another ballot's, as the operator might answer. */
const EARLIER = RECEIPTS.find((r, i) => INTAKES[i]!.seat === SEAT && r !== RECEIPT)!;
/** A receipt for another seat. */
const OTHER_SEAT = RECEIPTS.find((_, i) => INTAKES[i]!.seat !== SEAT)!;
const ELECTION = new Uint8Array(32).fill(0x5e);
const LINK = new Uint8Array(32).fill(0x1c);
const VERSION = 5;

const entryOf = (payload: Uint8Array, index = 1n, segment = 0, electionId = ELECTION) =>
  encodeBoardEntry({ election_id: electionId, index, segment, payload }, VERSION);

const respond = (status: number, body: unknown) => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("submitReceipt", () => {
  test("posts the election and the receipt as lowercase hex in the body, with no credential, referrer or redirect", async () => {
    const calls: [string, RequestInit][] = [];
    const entry = toHex(entryOf(RECEIPT));
    const answer = await submitReceipt({ api: API }, ELECTION, RECEIPT, async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ entry, link: toHex(LINK), earlier: false }), {
        status: 201,
      });
    });
    expect(answer).toEqual({ kind: "boarded", entry, link: toHex(LINK), earlier: false });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/receipts`);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      mode: "cors",
      headers: { "content-type": "application/json" },
    });
    expect(Object.keys(init.headers as object)).toEqual(["content-type"]);
    expect(JSON.parse(init.body as string)).toEqual({
      electionId: toHex(ELECTION),
      record: toHex(RECEIPT),
    });
  });

  test("refuses an election id that isn't 32 bytes before sending anything", async () => {
    let sent = 0;
    const count = async () => (sent++, new Response("{}", { status: 201 }));
    await expect(submitReceipt({ api: API }, new Uint8Array(33), RECEIPT, count)).rejects.toThrow(
      RangeError,
    );
    expect(sent).toBe(0);
  });

  test.each<[string, number, unknown, ReceiptAnswer]>([
    [
      "an earlier receipt boarded",
      201,
      { entry: "00", link: "11", earlier: true },
      { kind: "boarded", entry: "00", link: "11", earlier: true },
    ],
    [
      "a rejection with its code",
      422,
      { code: "RECEIPT_REJECTED", data: { code: "share-receipt" } },
      { kind: "rejected", code: "share-receipt" },
    ],
    ["a body outside the route's forms", 400, { code: "BAD_REQUEST" }, { kind: "malformed" }],
    ["an unknown election", 404, { code: "ELECTION_NOT_FOUND" }, { kind: "not-found" }],
    ["an election past s_D", 409, { code: "ELECTION_NOT_OPEN" }, { kind: "not-open" }],
    ["too many requests", 429, { code: "RATE_LIMITED" }, { kind: "busy" }],
    ["not judged in time", 503, { code: "RECEIPTS_UNAVAILABLE" }, { kind: "unavailable" }],
    [
      "the ballot route's unavailable",
      503,
      { code: "BALLOTS_UNAVAILABLE" },
      { kind: "unreachable" },
    ],
    [
      "the ballot route's rejection",
      422,
      { code: "BALLOT_REJECTED", data: { code: "decode" } },
      { kind: "unreachable" },
    ],
    ["a rejection without data", 422, { code: "RECEIPT_REJECTED" }, { kind: "unreachable" }],
    [
      "a rejection whose code isn't the route's form",
      422,
      { code: "RECEIPT_REJECTED", data: { code: "Share Receipt" } },
      { kind: "unreachable" },
    ],
    [
      "a rejection whose code is too long",
      422,
      { code: "RECEIPT_REJECTED", data: { code: "a".repeat(65) } },
      { kind: "unreachable" },
    ],
    [
      "a rejection whose data carries more",
      422,
      { code: "RECEIPT_REJECTED", data: { code: "decode", at: 3 } },
      { kind: "unreachable" },
    ],
    [
      "a rejection at another status",
      400,
      { code: "RECEIPT_REJECTED", data: { code: "decode" } },
      { kind: "unreachable" },
    ],
    ["a refusal at another status", 503, { code: "ELECTION_NOT_OPEN" }, { kind: "unreachable" }],
    ["a bare 400", 400, "Bad Request", { kind: "unreachable" }],
    ["a proxy's 502", 502, "Bad Gateway", { kind: "unreachable" }],
    ["a 201 with a list", 201, [], { kind: "unreachable" }],
    ["a 201 that isn't JSON", 201, "<html>", { kind: "unreachable" }],
    ["a 201 without `earlier`", 201, { entry: "00", link: "00" }, { kind: "unreachable" }],
    [
      "a 201 whose `earlier` isn't a boolean",
      201,
      { entry: "00", link: "00", earlier: "false" },
      { kind: "unreachable" },
    ],
    [
      "a 201 with more than its entry, link and `earlier`",
      201,
      { entry: "00", link: "00", earlier: false, receipt: "00" },
      { kind: "unreachable" },
    ],
    [
      "a 201 whose entry isn't a string",
      201,
      { entry: 1, link: "00", earlier: false },
      { kind: "unreachable" },
    ],
    [
      "a 200 instead of a 201",
      200,
      { entry: "00", link: "00", earlier: false },
      { kind: "unreachable" },
    ],
  ])("%s reads as its answer", async (_, status, body, expected) => {
    await expect(
      submitReceipt({ api: API }, ELECTION, RECEIPT, respond(status, body)),
    ).resolves.toEqual(expected);
  });

  test("a network failure is unreachable", async () => {
    const fail = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(submitReceipt({ api: API }, ELECTION, RECEIPT, fail)).resolves.toEqual({
      kind: "unreachable",
    });
  });

  test("reads an answer only up to 4 KiB", async () => {
    const fits = JSON.stringify({
      entry: toHex(entryOf(RECEIPT)),
      link: toHex(LINK),
      earlier: false,
    });
    await expect(
      submitReceipt({ api: API }, ELECTION, RECEIPT, respond(201, fits.padEnd(4096, " "))),
    ).resolves.toMatchObject({ kind: "boarded" });
    await expect(
      submitReceipt({ api: API }, ELECTION, RECEIPT, respond(201, fits.padEnd(4097, " "))),
    ).resolves.toEqual({ kind: "unreachable" });
  });
});

describe("checkReceiptEntry", () => {
  const expected = { electionId: ELECTION, receipt: RECEIPT, boardEntryVersion: VERSION } as const;
  const answerOf = (entry: Uint8Array, earlier = false, link = LINK) => ({
    entry: toHex(entry),
    link: toHex(link),
    earlier,
  });

  test("passes an entry of the pinned version naming the election and carrying exactly the receipt, at any position", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RECEIPTS),
        fc.boolean(),
        fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
        fc.nat({ max: 0xffff_ffff }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (receipt, earlier, index, segment, electionId, link) => {
          // The operator may say `earlier` of the bytes sent, too: the
          // worker judges them either way.
          const entry = entryOf(receipt, index, segment, electionId);
          expect(
            checkReceiptEntry(answerOf(entry, earlier, link), {
              electionId,
              receipt,
              boardEntryVersion: VERSION,
            }),
          ).toEqual({ entry, link, payload: receipt, index });
        },
      ),
      { numRuns },
    );
  });

  test("passes an earlier receipt for the same seat, with that receipt as its payload", () => {
    const entry = entryOf(EARLIER, 9n);
    expect(checkReceiptEntry(answerOf(entry, true), expected)).toEqual({
      entry,
      link: LINK,
      payload: EARLIER,
      index: 9n,
    });
  });

  test("refuses other bytes unless the operator says they are an earlier receipt", () => {
    expect(checkReceiptEntry(answerOf(entryOf(EARLIER)), expected)).toBeUndefined();
  });

  test("refuses an earlier receipt for another seat, or that isn't a share receipt", () => {
    expect(checkReceiptEntry(answerOf(entryOf(OTHER_SEAT), true), expected)).toBeUndefined();
    // A ballot's header on the receipt's length: allowed on the board, not a receipt.
    const notReceipt = Uint8Array.of(
      RECORD_TYPES.ballot >> 8,
      RECORD_TYPES.ballot & 0xff,
      3,
      ...RECEIPT.subarray(3),
    );
    expect(checkReceiptEntry(answerOf(entryOf(notReceipt), true), expected)).toBeUndefined();
  });

  test("refuses an entry carrying any other bytes than those sent", () => {
    const entry = entryOf(RECEIPT);
    fc.assert(
      fc.property(
        fc.nat({ max: RECEIPT.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const altered = entry.slice();
          const i = entry.length - RECEIPT.length + at;
          altered[i] = (altered[i] as number) ^ flip;
          expect(checkReceiptEntry(answerOf(altered), expected)).toBeUndefined();
        },
      ),
      { numRuns },
    );
  });

  test("refuses an entry for another election, earlier or not", () => {
    const other = new Uint8Array(32).fill(0x5f);
    for (const earlier of [false, true])
      expect(
        checkReceiptEntry(answerOf(entryOf(RECEIPT, 1n, 0, other), earlier), expected),
      ).toBeUndefined();
  });

  test("refuses an entry carrying a receipt shorter or longer, earlier or not", () => {
    for (const earlier of [false, true])
      for (const payload of [RECEIPT.subarray(0, -1), Uint8Array.of(...RECEIPT, 0)])
        expect(checkReceiptEntry(answerOf(entryOf(payload), earlier), expected)).toBeUndefined();
  });

  test("refuses an entry of another board-entry version than the election pins", () => {
    const entry = encodeBoardEntry(
      { election_id: ELECTION, index: 1n, segment: 0, payload: RECEIPT },
      3,
    );
    expect(checkReceiptEntry(answerOf(entry), expected)).toBeUndefined();
  });

  test("refuses an entry with anything after it, or cut short", () => {
    const entry = entryOf(RECEIPT);
    expect(checkReceiptEntry(answerOf(Uint8Array.of(...entry, 0)), expected)).toBeUndefined();
    expect(checkReceiptEntry(answerOf(entry.subarray(0, -1)), expected)).toBeUndefined();
  });

  test("refuses hex that isn't lowercase, or of odd length", () => {
    const entry = toHex(entryOf(RECEIPT));
    const link = toHex(LINK);
    const earlier = false;
    expect(
      checkReceiptEntry({ entry: entry.toUpperCase(), link, earlier }, expected),
    ).toBeUndefined();
    expect(
      checkReceiptEntry({ entry, link: link.toUpperCase(), earlier }, expected),
    ).toBeUndefined();
    expect(checkReceiptEntry({ entry: `${entry}0`, link, earlier }, expected)).toBeUndefined();
    expect(
      checkReceiptEntry({ entry, link: `${link.slice(1)}g`, earlier }, expected),
    ).toBeUndefined();
  });

  test("refuses a link of any length but 32 bytes", () => {
    const entry = entryOf(RECEIPT);
    for (const n of [0, 31, 33])
      expect(
        checkReceiptEntry(answerOf(entry, false, new Uint8Array(n)), expected),
      ).toBeUndefined();
  });

  test("hands out a payload that is its own copy", () => {
    const checked = checkReceiptEntry(answerOf(entryOf(RECEIPT)), expected);
    checked!.payload.fill(0);
    expect(checked!.entry.subarray(-RECEIPT.length)).toEqual(RECEIPT);
  });
});
