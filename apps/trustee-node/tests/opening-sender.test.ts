// The seat's tally openings sent to the operator until the seal
// (docs/spec/tally.md, Destruction, When): every signed opening of a cell the
// seat hasn't read published on the anchored board is sent; an answer
// carrying it, or a refusal, waits `resendAfter` before it goes again, and
// an answer that doesn't carry it is ignored, so the operator's word only
// paces the sending and never stops it (T-54, T-53). A cell the seat reads
// published is never sent again, and once every cell is, nothing is.
import {
  decodeTallyOpening,
  encodeBoardEntry,
  encodeTallyOpening,
  signTallyOpening,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import type { ApprovedElection } from "../src/ceremony.ts";
import {
  OpeningSender,
  type OpeningSenderOptions,
  type PublishedCells,
  publishedOf,
  RESEND_AFTER,
} from "../src/opening-sender.ts";
import type { OpeningOperator, OperatorAnswer } from "../src/operator.ts";

const ELECTION_ID = new Uint8Array(32).fill(7);
const DEFINITION = new Uint8Array(32).fill(9);
const SECRET = new Uint8Array(32).fill(2);
const ELECTION = { electionId: ELECTION_ID, index: 2 } as ApprovedElection;

/** The seat's signed opening of `cell`. */
const openingOf = (cell: number, counts = [3n, 1n]) =>
  encodeTallyOpening(
    signTallyOpening(SECRET, {
      definition_hash: DEFINITION,
      cell,
      aggregate_hash: new Uint8Array(32).fill(cell),
      signer: 2,
      opening: counts.map((v) => ({ v, r: 5n })),
    }),
  );
const entryOf = (payload: Uint8Array, index = 0n) =>
  encodeBoardEntry({ election_id: ELECTION_ID, index, segment: 4, payload }, 1);

/** An operator answering each request from `answer`, recording what was sent. */
function operator(answer: (opening: Uint8Array) => OperatorAnswer) {
  const sent: { electionId: Uint8Array; opening: Uint8Array }[] = [];
  const op: OpeningOperator = {
    submit: async (electionId, opening) => {
      sent.push({ electionId, opening });
      return answer(opening);
    },
  };
  return { op, sent };
}

function sender(
  openings: ReadonlyMap<number, Uint8Array>,
  op: OpeningOperator,
  world: { now: bigint; published: PublishedCells },
  options: Partial<OpeningSenderOptions> = {},
) {
  return new OpeningSender({
    election: ELECTION,
    boardVersion: 1,
    openings: async () => openings,
    published: () => world.published,
    operator: op,
    clock: () => world.now,
    ...options,
  });
}

const unpublished = (): PublishedCells => ({ cells: new Set(), complete: false });
const boarded = (opening: Uint8Array): OperatorAnswer => ({
  state: "boarded",
  entry: entryOf(opening),
  earlier: false,
});

describe("OpeningSender", () => {
  test("sends nothing before the seat signs an opening", async () => {
    const { op, sent } = operator(boarded);
    const s = sender(new Map(), op, { now: 0n, published: unpublished() });
    expect(await s.step()).toEqual({ state: "none" });
    expect(sent).toHaveLength(0);
  });

  test("sends each opening for its election, in cell order, and waits RESEND_AFTER once it is boarded", async () => {
    const openings = new Map([
      [1, openingOf(1)],
      [0, openingOf(0)],
    ]);
    const { op, sent } = operator(boarded);
    const world = { now: 100n, published: unpublished() };
    const s = sender(openings, op, world);
    expect(await s.step()).toEqual({
      state: "sending",
      openings: [
        { cell: 0, state: "boarded", earlier: false },
        { cell: 1, state: "boarded", earlier: false },
      ],
    });
    expect(sent.map((x) => x.opening)).toEqual([openings.get(0), openings.get(1)]);
    for (const x of sent) expect(x.electionId).toEqual(ELECTION_ID);
    // Until the seat reads it on the anchored board, the operator's word
    // only delays the next send.
    world.now = 100n + RESEND_AFTER - 1n;
    await s.step();
    expect(sent).toHaveLength(2);
    world.now = 100n + RESEND_AFTER;
    await s.step();
    expect(sent).toHaveLength(4);
  });

  test("a cell the seat reads published is never sent again, and nothing is once every cell is", async () => {
    const openings = new Map([
      [0, openingOf(0)],
      [1, openingOf(1)],
    ]);
    const { op, sent } = operator(() => ({ state: "not-ready" }));
    const world = { now: 0n, published: { cells: new Set([0]), complete: false } };
    const s = sender(openings, op, world);
    expect(await s.step()).toEqual({
      state: "sending",
      openings: [
        { cell: 0, state: "published" },
        { cell: 1, state: "not-ready" },
      ],
    });
    expect(sent.map((x) => x.opening)).toEqual([openings.get(1)]);
    world.published = { cells: new Set([0, 1]), complete: true };
    expect(await s.step()).toEqual({ state: "complete" });
    expect(sent).toHaveLength(1);
  });

  test("an operator that can't take openings now ends the step's sending, and the next step sends again", async () => {
    const openings = new Map([0, 1, 2].map((c) => [c, openingOf(c)]));
    for (const answer of [
      { state: "not-ready" },
      { state: "not-open" },
      { state: "unavailable", reason: "OPENINGS_UNAVAILABLE" },
    ] as const) {
      const { op, sent } = operator(() => answer);
      const s = sender(openings, op, { now: 0n, published: unpublished() });
      const status = await s.step();
      expect(status).toEqual({
        state: "sending",
        openings: [
          { cell: 0, ...answer },
          { cell: 1, state: "unsent" },
          { cell: 2, state: "unsent" },
        ],
      });
      expect(sent).toHaveLength(1);
      // No wait: the same clock sends again.
      await s.step();
      expect(sent).toHaveLength(2);
    }
  });

  test("a refusal is reported with its code and asked again after RESEND_AFTER", async () => {
    const { op, sent } = operator(() => ({ state: "rejected", code: "tally-aggregate" }));
    const world = { now: 0n, published: unpublished() };
    const s = sender(new Map([[0, openingOf(0)]]), op, world, { resendAfter: 30n });
    expect(await s.step()).toEqual({
      state: "sending",
      openings: [{ cell: 0, state: "rejected", code: "tally-aggregate" }],
    });
    world.now = 29n;
    await s.step();
    expect(sent).toHaveLength(1);
    world.now = 30n;
    await s.step();
    expect(sent).toHaveLength(2);
  });

  test("an answered entry counts only if it carries the opening", async () => {
    const mine = openingOf(0);
    // The same signed message in other bytes: another signature over it.
    const decoded = decodeTallyOpening(mine, 1);
    const signature = Uint8Array.from(decoded.signature);
    signature[63] = (signature[63] as number) ^ 1;
    const resigned = encodeTallyOpening({ ...decoded, signature });
    expect(resigned).not.toEqual(mine);
    const other = openingOf(0, [2n, 2n]);
    const cases: [OperatorAnswer, string, boolean?][] = [
      [{ state: "boarded", entry: entryOf(mine), earlier: false }, "boarded", false],
      [{ state: "boarded", entry: entryOf(resigned), earlier: true }, "boarded", true],
      // Its own bytes again, claimed as other bytes.
      [{ state: "boarded", entry: entryOf(mine), earlier: true }, "misanswered"],
      // Other bytes, claimed as its own.
      [{ state: "boarded", entry: entryOf(resigned), earlier: false }, "misanswered"],
      // Another signed message of the cell.
      [{ state: "boarded", entry: entryOf(other), earlier: true }, "misanswered"],
      [{ state: "boarded", entry: entryOf(other), earlier: false }, "misanswered"],
      // An entry that doesn't decode, and a payload that isn't a tally opening.
      [{ state: "boarded", entry: entryOf(mine).subarray(1), earlier: false }, "misanswered"],
      [{ state: "boarded", entry: entryOf(Uint8Array.of(0, 6, 1)), earlier: true }, "misanswered"],
    ];
    expect(decodeTallyOpening(other, 1).cell).toBe(0);
    for (const [answer, state, earlier] of cases) {
      const { op, sent } = operator(() => answer);
      const world = { now: 0n, published: unpublished() };
      const s = sender(new Map([[0, mine]]), op, world);
      expect(await s.step(), state).toEqual({
        state: "sending",
        openings: [{ cell: 0, state, ...(earlier === undefined ? {} : { earlier }) }],
      });
      // A misanswer is sent again at once; a boarded one waits.
      await s.step();
      expect(sent, state).toHaveLength(state === "misanswered" ? 2 : 1);
    }
  });

  test("an entry decoded under another board-entry version than the pin is not the opening's", async () => {
    const mine = openingOf(0);
    const { op } = operator(() => ({ state: "boarded", entry: entryOf(mine), earlier: false }));
    const s = sender(
      new Map([[0, mine]]),
      op,
      { now: 0n, published: unpublished() },
      { boardVersion: 4 },
    );
    expect(await s.step()).toEqual({
      state: "sending",
      openings: [{ cell: 0, state: "misanswered" }],
    });
  });
});

describe("publishedOf", () => {
  test("names the cells a tally step read published, complete only when every cell is", () => {
    const published = { state: "published", segment: 9 } as const;
    const opened = { state: "opened" } as const;
    expect(publishedOf({ state: "waiting" })).toBeUndefined();
    expect(publishedOf({ state: "unavailable" })).toBeUndefined();
    expect(
      publishedOf({ state: "tallying", cells: [opened, published, opened], board: "read" }),
    ).toEqual({ cells: new Set([1]), complete: false });
    expect(
      publishedOf({ state: "tallying", cells: [published, published], board: "unread" }),
    ).toEqual({ cells: new Set([0, 1]), complete: true });
  });
});
