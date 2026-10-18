import { encodeBoardEntry } from "@abolishus/crypto";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

import { checkBoarded, sendBallot, type SendAnswer } from "../src/send.ts";

// Sending a recorded cast to `ballots.submit` and judging the operator's
// answer (src/send.ts; [[receipts]], Checks at cast): the request carries
// only the election and the ballot's bytes, with no credential, referrer or
// redirect (T-10), each of the route's answers is read only in its own shape
// (T-25), the answer is read only up to the size the ballot fixes (T-52), and
// a boarded answer passes only if its entry names the election and carries
// exactly the bytes sent (T-38).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const VECTORS = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/ballot-v3-records.json", import.meta.url),
    "utf8",
  ),
) as { ballots: { id: string; encoding: string }[] };

const API = "https://api-staging.abolish.us";
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

const BALLOT = fromHex(VECTORS.ballots[0]!.encoding);
const ELECTION = new Uint8Array(32).fill(0x5e);
const LINK = new Uint8Array(32).fill(0x1c);
const VERSION = 5;

const entryOf = (payload: Uint8Array, index = 1n, segment = 0, electionId = ELECTION) =>
  encodeBoardEntry({ election_id: electionId, index, segment, payload }, VERSION);

const respond = (status: number, body: unknown) => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("sendBallot", () => {
  test("posts the election and the ballot as lowercase hex in the body, with no credential, referrer or redirect", async () => {
    const calls: [string, RequestInit][] = [];
    const entry = toHex(entryOf(BALLOT));
    const answer = await sendBallot({ api: API }, ELECTION, BALLOT, async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ entry, link: toHex(LINK) }), { status: 201 });
    });
    expect(answer).toEqual({ kind: "boarded", entry, link: toHex(LINK) });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/ballots`);
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
      ballot: toHex(BALLOT),
    });
  });

  test("refuses an election id that isn't 32 bytes before sending anything", async () => {
    let sent = 0;
    const count = async () => (sent++, new Response("{}", { status: 201 }));
    await expect(sendBallot({ api: API }, new Uint8Array(31), BALLOT, count)).rejects.toThrow(
      RangeError,
    );
    expect(sent).toBe(0);
  });

  test.each<[string, number, unknown, SendAnswer]>([
    [
      "a rejection with its code",
      422,
      { code: "BALLOT_REJECTED", data: { code: "membership-proof" } },
      { kind: "rejected", code: "membership-proof" },
    ],
    [
      "a copy in other bytes",
      422,
      { defined: true, code: "BALLOT_REJECTED", status: 422, data: { code: "repeat" } },
      { kind: "rejected", code: "repeat" },
    ],
    ["a body outside the route's forms", 400, { code: "BAD_REQUEST" }, { kind: "malformed" }],
    ["an unknown election", 404, { code: "ELECTION_NOT_FOUND" }, { kind: "not-found" }],
    ["a closed election", 409, { code: "ELECTION_NOT_OPEN" }, { kind: "not-open" }],
    ["too many requests", 429, { code: "RATE_LIMITED" }, { kind: "busy" }],
    ["not judged in time", 503, { code: "BALLOTS_UNAVAILABLE" }, { kind: "unavailable" }],
    ["a rejection without data", 422, { code: "BALLOT_REJECTED" }, { kind: "unreachable" }],
    [
      "a rejection whose code isn't the route's form",
      422,
      { code: "BALLOT_REJECTED", data: { code: "Membership Proof" } },
      { kind: "unreachable" },
    ],
    [
      "a rejection whose code is too long",
      422,
      { code: "BALLOT_REJECTED", data: { code: "a".repeat(65) } },
      { kind: "unreachable" },
    ],
    [
      "a rejection whose data carries more",
      422,
      { code: "BALLOT_REJECTED", data: { code: "decode", at: 3 } },
      { kind: "unreachable" },
    ],
    [
      "a rejection at another status",
      400,
      { code: "BALLOT_REJECTED", data: { code: "decode" } },
      { kind: "unreachable" },
    ],
    ["a refusal at another status", 503, { code: "ELECTION_NOT_OPEN" }, { kind: "unreachable" }],
    ["an unknown code", 409, { code: "REGION_UNKNOWN" }, { kind: "unreachable" }],
    ["a bare 400", 400, "Bad Request", { kind: "unreachable" }],
    ["a proxy's 502", 502, "Bad Gateway", { kind: "unreachable" }],
    ["a 201 with a list", 201, [], { kind: "unreachable" }],
    ["a 201 that isn't JSON", 201, "<html>", { kind: "unreachable" }],
    ["a 201 without its link", 201, { entry: "00" }, { kind: "unreachable" }],
    [
      "a 201 with more than its entry and link",
      201,
      { entry: "00", link: "00", receipt: "00" },
      { kind: "unreachable" },
    ],
    ["a 201 whose entry isn't a string", 201, { entry: 1, link: "00" }, { kind: "unreachable" }],
    ["a 200 instead of a 201", 200, { entry: "00", link: "00" }, { kind: "unreachable" }],
  ])("%s reads as its answer", async (_, status, body, expected) => {
    await expect(
      sendBallot({ api: API }, ELECTION, BALLOT, respond(status, body)),
    ).resolves.toEqual(expected);
  });

  test("a network failure is unreachable", async () => {
    const fail = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(sendBallot({ api: API }, ELECTION, BALLOT, fail)).resolves.toEqual({
      kind: "unreachable",
    });
  });

  test("reads an answer only up to what the ballot's entry and link take", async () => {
    // The largest answer the route gives for this ballot, then one byte more.
    const entry = "0".repeat(2 * (BALLOT.length + 51));
    const fits = JSON.stringify({ entry, link: "0".repeat(64) });
    const limit = 2 * (BALLOT.length + 51) + 64 + 64;
    expect(fits.length).toBeLessThanOrEqual(limit);
    await expect(
      sendBallot({ api: API }, ELECTION, BALLOT, respond(201, fits.padEnd(limit, " "))),
    ).resolves.toMatchObject({ kind: "boarded" });
    await expect(
      sendBallot({ api: API }, ELECTION, BALLOT, respond(201, fits.padEnd(limit + 1, " "))),
    ).resolves.toEqual({ kind: "unreachable" });
  });
});

describe("checkBoarded", () => {
  const expected = { electionId: ELECTION, ballot: BALLOT, boardEntryVersion: VERSION } as const;
  const answerOf = (entry: Uint8Array, link = LINK) => ({ entry: toHex(entry), link: toHex(link) });

  test("passes an entry of the pinned version naming the election and carrying exactly the bytes, at any position", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VECTORS.ballots.map((b) => fromHex(b.encoding))),
        fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
        fc.nat({ max: 0xffff_ffff }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (ballot, index, segment, electionId, link) => {
          const entry = entryOf(ballot, index, segment, electionId);
          expect(
            checkBoarded(answerOf(entry, link), {
              electionId,
              ballot,
              boardEntryVersion: VERSION,
            }),
          ).toEqual({ entry, link, index, segment });
        },
      ),
      { numRuns },
    );
  });

  test("refuses an entry carrying any other bytes than those sent", () => {
    const entry = entryOf(BALLOT);
    fc.assert(
      fc.property(
        fc.nat({ max: BALLOT.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const other = BALLOT.slice();
          other[at] = (other[at] as number) ^ flip;
          // Either it isn't an entry at all, or it carries other bytes.
          const altered = entry.slice();
          altered.set(other, entry.length - BALLOT.length);
          expect(checkBoarded(answerOf(altered), expected)).toBeUndefined();
        },
      ),
      { numRuns },
    );
  });

  test("refuses an entry for another election", () => {
    const other = new Uint8Array(32).fill(0x5f);
    expect(checkBoarded(answerOf(entryOf(BALLOT, 1n, 0, other)), expected)).toBeUndefined();
  });

  test("refuses an entry carrying another ballot, shorter or longer", () => {
    for (const payload of [BALLOT.subarray(0, -1), Uint8Array.of(...BALLOT, 0)])
      expect(checkBoarded(answerOf(entryOf(payload)), expected)).toBeUndefined();
    const second = fromHex(VECTORS.ballots[1]!.encoding);
    expect(checkBoarded(answerOf(entryOf(second)), expected)).toBeUndefined();
  });

  test("refuses an entry of another board-entry version than the election pins", () => {
    const entry = encodeBoardEntry(
      { election_id: ELECTION, index: 1n, segment: 0, payload: BALLOT },
      3,
    );
    expect(checkBoarded(answerOf(entry), expected)).toBeUndefined();
  });

  test("refuses an entry with anything after it, or cut short", () => {
    const entry = entryOf(BALLOT);
    expect(checkBoarded(answerOf(Uint8Array.of(...entry, 0)), expected)).toBeUndefined();
    expect(checkBoarded(answerOf(entry.subarray(0, -1)), expected)).toBeUndefined();
  });

  test("refuses hex that isn't lowercase, or of odd length", () => {
    const entry = toHex(entryOf(BALLOT));
    const link = toHex(LINK);
    expect(checkBoarded({ entry: entry.toUpperCase(), link }, expected)).toBeUndefined();
    expect(checkBoarded({ entry, link: link.toUpperCase() }, expected)).toBeUndefined();
    expect(checkBoarded({ entry: `${entry}0`, link }, expected)).toBeUndefined();
    expect(checkBoarded({ entry: `0x${entry.slice(2)}`, link }, expected)).toBeUndefined();
    expect(checkBoarded({ entry, link: `${link.slice(1)}g` }, expected)).toBeUndefined();
  });

  test("refuses a link of any length but 32 bytes", () => {
    const entry = entryOf(BALLOT);
    for (const n of [0, 31, 33])
      expect(checkBoarded(answerOf(entry, new Uint8Array(n)), expected)).toBeUndefined();
  });
});
