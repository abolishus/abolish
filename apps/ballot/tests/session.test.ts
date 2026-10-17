// What the ballot worker keeps between requests (src/worker/session.ts): a
// version-5 poll is shown only once its ceremony transcript checks under the
// panel it names, and its seals are made under the key set that check
// registered, each opened at most once (T-37, T-42, T-45, T-54). The
// transcript is a real run of the ceremony's four rounds (tests/poll.ts);
// the opening is judged by @abolishus/crypto's own challenge check,
// under a context made here from the same records, not from the worker.

import {
  checkChallengeOpeningV2,
  decodeOpening,
  type Panel,
  sealingElectionV5,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  type ChallengeRequest,
  type CheckElectionRequest,
  PROTOCOL_VERSION,
  type SealRequest,
} from "../src/worker/protocol.ts";
import { BallotSession } from "../src/worker/session.ts";
import { definition, definitionBytes, displayText, entry, panel, registeredHash } from "./poll.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const checkRequest = (
  change: { entries?: Uint8Array[]; panels?: Panel[] } = {},
): CheckElectionRequest => ({
  v: PROTOCOL_VERSION,
  id: 1,
  kind: "check-election",
  electionId: definition.election_id,
  registeredHash,
  definition: definitionBytes,
  displayText,
  entries: [entry],
  panels: [panel],
  ...change,
});
const sealRequest = (votes: (0 | 1)[], definitionHash = registeredHash, cell = 0): SealRequest => ({
  v: PROTOCOL_VERSION,
  id: 2,
  kind: "seal",
  definitionHash,
  cell,
  votes,
});
const challengeRequest = (seal: number): ChallengeRequest => ({
  v: PROTOCOL_VERSION,
  id: 3,
  kind: "challenge",
  seal,
});

/** A session holding the honest poll. */
function holding(): BallotSession {
  const session = new BallotSession();
  const check = session.checkElection(checkRequest());
  if (!check.ok) throw new Error(check.problem);
  return session;
}

// The independent context the openings are judged under.
const independent = sealingElectionV5(definition, [panel], [entry]);
if (!independent.ok) throw new Error(independent.code);

// Every vote the two questions allow: one of 3, then one of 2.
const allowed = fc
  .tuple(fc.constantFrom([1, 0, 0], [0, 1, 0], [0, 0, 1]), fc.constantFrom([1, 0], [0, 1]))
  .map(([a, b]) => [...a, ...b] as (0 | 1)[]);

describe("a version-5 poll's ceremony", () => {
  test("a poll whose transcript checks under its pinned panel is shown", () => {
    const check = new BallotSession().checkElection(checkRequest());
    if (!check.ok) throw new Error(check.problem);
    expect(check.election.version).toBe(5);
    expect(check.election.definitionHash).toBe(toHex(registeredHash));
  });

  test("a poll naming a panel this build doesn't pin is refused", () => {
    expect(new BallotSession().checkElection(checkRequest({ panels: [] }))).toEqual({
      ok: false,
      problem: "ceremony-failed",
      code: "panel-unpinned",
    });
  });

  test("a board whose first entry isn't the transcript is refused", () => {
    for (const entries of [[], [new Uint8Array(8)]])
      expect(new BallotSession().checkElection(checkRequest({ entries }))).toEqual({
        ok: false,
        problem: "ceremony-failed",
        code: "ceremony-transcript-missing",
      });
  });

  test("the show check comes first: a definition the registry doesn't hold is refused as before", () => {
    const check = new BallotSession().checkElection({
      ...checkRequest({ panels: [] }),
      registeredHash: new Uint8Array(32),
    });
    expect(check).toMatchObject({ ok: false, problem: "unregistered-definition" });
  });
});

describe("seals", () => {
  test("a seal's opening is of exactly the core whose code was shown, with the votes sealed", () => {
    const session = holding();
    fc.assert(
      fc.property(allowed, (votes) => {
        const sealed = session.seal(sealRequest(votes));
        if (!sealed.ok) throw new Error(sealed.problem);
        expect(sealed.trackingCode).toHaveLength(32);
        const opened = session.challenge(challengeRequest(sealed.seal));
        if (!opened.ok) throw new Error(opened.problem);
        expect(toHex(opened.trackingCode)).toBe(toHex(sealed.trackingCode));
        const checked = checkChallengeOpeningV2(
          independent.election,
          decodeOpening(opened.opening, 2),
        );
        if (!checked.ok) throw new Error(checked.code);
        expect(toHex(checked.coreHash)).toBe(toHex(sealed.trackingCode));
        expect(checked.votes).toEqual(votes.map(BigInt));
      }),
      // Each run seals to every seat and checks the opening.
      { numRuns: Math.max(10, Math.floor(numRuns / 20)) },
    );
  }, 120_000);

  test("a seal opens once, and a seal the worker never made doesn't open", () => {
    const session = holding();
    const sealed = session.seal(sealRequest([1, 0, 0, 1, 0]));
    if (!sealed.ok) throw new Error(sealed.problem);
    expect(session.challenge(challengeRequest(sealed.seal)).ok).toBe(true);
    expect(session.challenge(challengeRequest(sealed.seal))).toEqual({
      ok: false,
      problem: "unknown",
    });
    expect(session.challenge(challengeRequest(sealed.seal + 1))).toEqual({
      ok: false,
      problem: "unknown",
    });
  });

  test("two seals of one vote show different codes", () => {
    const session = holding();
    const a = session.seal(sealRequest([0, 1, 0, 0, 1]));
    const b = session.seal(sealRequest([0, 1, 0, 0, 1]));
    if (!a.ok || !b.ok) throw new Error("not sealed");
    expect(a.seal).not.toBe(b.seal);
    expect(toHex(a.trackingCode)).not.toBe(toHex(b.trackingCode));
  });

  test("votes outside a question's limits, or a cell outside the partition, aren't sealed", () => {
    const session = holding();
    for (const votes of [
      [1, 1, 0, 1, 0],
      [0, 0, 0, 1, 0],
      [1, 0, 0, 1],
    ] as (0 | 1)[][])
      expect(session.seal(sealRequest(votes))).toEqual({ ok: false, problem: "refused" });
    const cells = definition.electorate.reduce((n, t) => n + t.cells.length, 0);
    for (const cell of [cells, -1])
      expect(session.seal(sealRequest([1, 0, 0, 1, 0], registeredHash, cell))).toEqual({
        ok: false,
        problem: "refused",
      });
  });

  test("nothing is sealed for another poll, for none, or after a refused check", () => {
    const session = new BallotSession();
    expect(session.seal(sealRequest([1, 0, 0, 1, 0]))).toEqual({
      ok: false,
      problem: "no-election",
    });
    const held = holding();
    expect(held.seal(sealRequest([1, 0, 0, 1, 0], new Uint8Array(32)))).toEqual({
      ok: false,
      problem: "no-election",
    });
    held.checkElection(checkRequest({ panels: [] }));
    expect(held.seal(sealRequest([1, 0, 0, 1, 0]))).toEqual({ ok: false, problem: "no-election" });
  });

  test("a poll checked anew drops the seals made before it", () => {
    const session = holding();
    const sealed = session.seal(sealRequest([1, 0, 0, 1, 0]));
    if (!sealed.ok) throw new Error(sealed.problem);
    expect(session.checkElection(checkRequest()).ok).toBe(true);
    expect(session.challenge(challengeRequest(sealed.seal))).toEqual({
      ok: false,
      problem: "unknown",
    });
  });
});
