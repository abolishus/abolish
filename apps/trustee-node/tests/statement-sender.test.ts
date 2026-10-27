// The seat's destruction statement sent to the operator until the
// destruction window ends (docs/spec/tally.md, Destruction, What;
// Destruction window): nothing is sent before the seat holds its statement;
// an answer carrying it, or a refusal, waits `resendAfter` before it goes
// again, and an answer that doesn't carry it is ignored, so the operator's
// word only paces the sending and never stops it (T-14, T-54, T-53). Under
// a board-entry version that can't carry `0x000f`, nothing is sent.
import {
  type BoardEntryVersion,
  encodeBoardEntry,
  encodeDestructionStatement,
  encodeTallyOpening,
  signDestructionStatement,
  signTallyOpening,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import type { ApprovedElectionInfo } from "../src/ceremony.ts";
import { RESEND_AFTER } from "../src/opening-sender.ts";
import type { DestructionOperator, OperatorAnswer } from "../src/operator.ts";
import { StatementSender, type StatementSenderOptions } from "../src/statement-sender.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const ELECTION_ID = new Uint8Array(32).fill(7);
const DEFINITION = new Uint8Array(32).fill(9);
const SECRET = new Uint8Array(32).fill(2);
const ELECTION = { electionId: ELECTION_ID, index: 2 } as ApprovedElectionInfo;
// The first board-entry version that allows `0x000f`.
const BOARD: BoardEntryVersion = 4;

/** Seat `signer`'s signed statement. */
const statementOf = (signer = 2, definition = DEFINITION) =>
  encodeDestructionStatement(
    signDestructionStatement(SECRET, { definition_hash: definition, signer }),
  );
/**
 * The same message in other bytes, as another nonce would sign it: `r`'s
 * first byte changed, still in range. The sender compares messages and never
 * verifies a signature, since the answer only paces the sending.
 */
const resigned = (statement: Uint8Array) => {
  const other = Uint8Array.from(statement);
  other[36] = (statement[36] as number) === 1 ? 2 : 1;
  return other;
};
const entryOf = (payload: Uint8Array, version: BoardEntryVersion = BOARD) =>
  encodeBoardEntry({ election_id: ELECTION_ID, index: 3n, segment: 4, payload }, version);

/** An operator answering each request from `answer`, recording what was sent. */
function operator(answer: (statement: Uint8Array) => OperatorAnswer) {
  const sent: { electionId: Uint8Array; statement: Uint8Array }[] = [];
  const op: DestructionOperator = {
    submitDestruction: async (electionId, statement) => {
      sent.push({ electionId, statement });
      return answer(statement);
    },
  };
  return { op, sent };
}

function sender(
  held: { statement: Uint8Array | undefined },
  op: DestructionOperator,
  world: { now: bigint },
  options: Partial<StatementSenderOptions> = {},
) {
  return new StatementSender({
    election: ELECTION,
    boardVersion: BOARD,
    statement: async () => held.statement,
    operator: op,
    clock: () => world.now,
    ...options,
  });
}

const boarded = (statement: Uint8Array): OperatorAnswer => ({
  state: "boarded",
  entry: entryOf(statement),
  earlier: false,
});

describe("StatementSender", () => {
  test("sends nothing before the seat holds its statement, then sends it for its election", async () => {
    const { op, sent } = operator(boarded);
    const held: { statement: Uint8Array | undefined } = { statement: undefined };
    const s = sender(held, op, { now: 0n });
    expect(await s.step()).toEqual({ state: "none" });
    expect(sent).toHaveLength(0);
    held.statement = statementOf();
    expect(await s.step()).toEqual({
      state: "sending",
      send: { state: "boarded", earlier: false },
    });
    expect(sent).toEqual([{ electionId: ELECTION_ID, statement: held.statement }]);
  });

  test("an entry carrying it waits RESEND_AFTER, then it is sent again until the window ends", async () => {
    const { op, sent } = operator(boarded);
    const world = { now: 100n };
    const s = sender({ statement: statementOf() }, op, world);
    await s.step();
    world.now = 100n + RESEND_AFTER - 1n;
    // The operator's word only delays the next send.
    expect(await s.step()).toEqual({
      state: "sending",
      send: { state: "boarded", earlier: false },
    });
    expect(sent).toHaveLength(1);
    world.now = 100n + RESEND_AFTER;
    await s.step();
    expect(sent).toHaveLength(2);
  });

  test("a refusal is reported with its code and waits RESEND_AFTER too", async () => {
    const { op, sent } = operator(() => ({ state: "rejected", code: "destruction-repeat" }));
    const world = { now: 0n };
    const s = sender({ statement: statementOf() }, op, world, { resendAfter: 10n });
    expect(await s.step()).toEqual({
      state: "sending",
      send: { state: "rejected", code: "destruction-repeat" },
    });
    world.now = 9n;
    await s.step();
    expect(sent).toHaveLength(1);
    world.now = 10n;
    await s.step();
    expect(sent).toHaveLength(2);
  });

  test.each([
    ["not ready", { state: "not-ready" }, { state: "not-ready" }],
    ["not open", { state: "not-open" }, { state: "not-open" }],
    [
      "unavailable",
      { state: "unavailable", reason: "503" },
      { state: "unavailable", reason: "503" },
    ],
  ] as const)("an operator %s is asked again next step", async (_, answer, send) => {
    const { op, sent } = operator(() => answer);
    const s = sender({ statement: statementOf() }, op, { now: 0n });
    expect(await s.step()).toEqual({ state: "sending", send });
    expect(await s.step()).toEqual({ state: "sending", send });
    expect(sent).toHaveLength(2);
  });

  test("a re-signed statement over the same message is boarded `earlier`", async () => {
    const statement = statementOf();
    const other = resigned(statement);
    expect(other).not.toEqual(statement);
    const { op } = operator(() => ({ state: "boarded", entry: entryOf(other), earlier: true }));
    expect(await sender({ statement }, op, { now: 0n }).step()).toEqual({
      state: "sending",
      send: { state: "boarded", earlier: true },
    });
  });

  test.each([
    ["another seat's statement", () => entryOf(statementOf(3)), false],
    ["another seat's statement, as earlier", () => entryOf(statementOf(3)), true],
    ["another definition's statement, as earlier", () => entryOf(statementOf(2, SECRET)), true],
    ["its own bytes claimed as earlier", (s: Uint8Array) => entryOf(s), true],
    [
      "a re-signed statement not claimed as earlier",
      (s: Uint8Array) => entryOf(resigned(s)),
      false,
    ],
    ["an entry under another board-entry version", (s: Uint8Array) => entryOf(s, 5), false],
    ["bytes that aren't an entry", () => Uint8Array.of(0, 5, 1), false],
    [
      "an entry carrying a tally opening, as earlier",
      () =>
        entryOf(
          encodeTallyOpening(
            signTallyOpening(SECRET, {
              definition_hash: DEFINITION,
              cell: 0,
              aggregate_hash: new Uint8Array(32),
              signer: 2,
              opening: [{ v: 1n, r: 1n }],
            }),
          ),
        ),
      true,
    ],
  ] as const)(
    "an entry with %s is misanswered and sent again next step",
    async (_, entry, earlier) => {
      const statement = statementOf();
      const { op, sent } = operator((s) => ({ state: "boarded", entry: entry(s), earlier }));
      const s = sender({ statement }, op, { now: 0n });
      expect(await s.step()).toEqual({ state: "sending", send: { state: "misanswered" } });
      await s.step();
      expect(sent).toHaveLength(2);
    },
  );

  test.each([1, 3] as const)(
    "sends nothing under board-entry version %i, which can't carry a statement",
    async (version) => {
      const { op, sent } = operator(boarded);
      const s = sender({ statement: statementOf() }, op, { now: 0n }, { boardVersion: version });
      expect(await s.step()).toEqual({ state: "unboardable" });
      expect(sent).toHaveLength(0);
    },
  );

  test("whatever the operator answers, it is sent at most once a step and again within RESEND_AFTER of the last", async () => {
    const answers = fc.oneof(
      fc.constant<OperatorAnswer>({ state: "not-ready" }),
      fc.constant<OperatorAnswer>({ state: "not-open" }),
      fc.constant<OperatorAnswer>({ state: "unavailable", reason: "x" }),
      fc.constant<OperatorAnswer>({ state: "rejected", code: "destruction-repeat" }),
      fc
        .boolean()
        .map((earlier) => ({ state: "boarded", entry: Uint8Array.of(1), earlier }) as const),
      fc.constant("carries" as const),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(answers, fc.bigInt({ min: 0n, max: 2n * RESEND_AFTER })), {
          minLength: 1,
          maxLength: 30,
        }),
        async (steps) => {
          const statement = statementOf();
          let i = 0;
          const { op, sent } = operator((s) => {
            const a = (steps[i] as (typeof steps)[number])[0];
            return a === "carries" ? boarded(s) : a;
          });
          const world = { now: 0n };
          const s = sender({ statement }, op, world);
          let lastSent: bigint | undefined;
          for (const [, gap] of steps) {
            const before = sent.length;
            await s.step();
            expect(sent.length - before).toBeLessThanOrEqual(1);
            if (sent.length > before) {
              lastSent = world.now;
              i++;
            } else {
              // Held back only within RESEND_AFTER of the last send.
              expect(lastSent).toBeDefined();
              expect(world.now - (lastSent as bigint)).toBeLessThan(RESEND_AFTER);
            }
            world.now += gap;
          }
        },
      ),
      { numRuns },
    );
  });
});
