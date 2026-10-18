// What the ballot worker keeps between requests (src/worker/session.ts): a
// version-5 poll is shown only once its ceremony transcript checks under the
// panel it names, and its seals are made under the key set that check
// registered, each opened at most once (T-37, T-42, T-45, T-54). The
// transcript is a real run of the ceremony's four rounds (tests/poll.ts);
// the opening is judged by @abolishus/crypto's own challenge check,
// under a context made here from the same records, not from the worker. The
// voter's cell is found from the whole board, for an identity the board's
// registry records added (T-10, T-13), and a Tier 0 registration's outcome
// from the group registry's whole log (T-11, T-13, T-16).

import {
  BABYJUBJUB_ORDER,
  checkChallengeOpeningV2,
  decodeOpening,
  identityBackupLocator,
  openIdentityBackup,
  type Panel,
  sealIdentityBackup,
  sealingElectionV5,
} from "@abolishus/crypto";
import { readFileSync } from "node:fs";

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  type BackupOpenRequest,
  type BackupSealRequest,
  type ChallengeRequest,
  type CheckElectionRequest,
  type CommitmentRequest,
  type FindCellRequest,
  PROTOCOL_VERSION,
  type SealRequest,
  type Tier0OutcomeRequest,
} from "../src/worker/protocol.ts";
import { BallotSession } from "../src/worker/session.ts";
import {
  board,
  cellLeaves,
  definition,
  definitionBytes,
  displayText,
  entry,
  GROUP,
  members,
  OTHER_GROUP,
  panel,
  registeredHash,
  registrars,
  registryWith,
} from "./poll.ts";

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

const findCellRequest = (change: Partial<FindCellRequest> = {}): FindCellRequest => ({
  v: PROTOCOL_VERSION,
  id: 4,
  kind: "find-cell",
  definitionHash: registeredHash,
  secret: Uint8Array.from(members[1] as Uint8Array),
  tier: 0,
  group: GROUP,
  entries: board,
  ...registrars,
  ...change,
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

describe("the voter's cell", () => {
  test("each member of the board's group is in cell 0, and the worker zeroes the secret", () => {
    const session = holding();
    for (const member of members) {
      const secret = Uint8Array.from(member);
      expect(session.findCell(findCellRequest({ secret }))).toEqual({ ok: true, cell: 0 });
      expect(secret.every((b) => b === 0)).toBe(true);
    }
  });

  test("a board that doesn't add the voter, or another group, tier or registrars, gives no cell", () => {
    const session = holding();
    // A valid identity secret, and no member's.
    const outsider = new Uint8Array(32);
    outsider[0] = 1;
    const cases: [Partial<FindCellRequest>, string][] = [
      [{ secret: outsider }, "not-a-member"],
      [{ group: GROUP + 1n }, "not-a-member"],
      [{ tier: 1 }, "tier-absent"],
      [{ entries: [entry] }, "group-created"],
      // Other registrars than the ones who signed the batch.
      [{ registrars: registrars.registrars.slice(1) }, "group-history"],
    ];
    for (const [change, code] of cases)
      expect(session.findCell(findCellRequest(change))).toMatchObject({
        ok: false,
        problem: "cell",
        code,
      });
  });

  test("a secret that isn't an identity secret is refused and zeroed", () => {
    const secret = new Uint8Array(32).fill(0xff);
    expect(holding().findCell(findCellRequest({ secret }))).toEqual({
      ok: false,
      problem: "secret",
    });
    expect(secret.every((b) => b === 0)).toBe(true);
  });

  test("no cell is found for another poll or none, and the secret is zeroed all the same", () => {
    for (const [session, definitionHash] of [
      [new BallotSession(), registeredHash],
      [holding(), new Uint8Array(32)],
    ] as const) {
      const secret = Uint8Array.from(members[0] as Uint8Array);
      expect(session.findCell(findCellRequest({ definitionHash, secret }))).toEqual({
        ok: false,
        problem: "no-election",
      });
      expect(secret.every((b) => b === 0)).toBe(true);
    }
  });
});

// Semaphore 4.14.3's own identities: each secret's commitment, made outside
// the workspace (docs/spec/vectors/membership-prover.json).
const MEMBERSHIP_VECTORS = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/membership-prover.json", import.meta.url),
    "utf8",
  ),
) as { members: { secret: string; commitment: string }[] };

const commitmentRequest = (secret: Uint8Array): CommitmentRequest => ({
  v: PROTOCOL_VERSION,
  id: 5,
  kind: "commitment",
  secret,
});

describe("the identity commitment", () => {
  test("is Semaphore's for each vector's secret, and the worker zeroes the secret", () => {
    expect(MEMBERSHIP_VECTORS.members.length).toBeGreaterThan(0);
    for (const { secret: hex, commitment } of MEMBERSHIP_VECTORS.members) {
      const secret = Uint8Array.from(Buffer.from(hex, "hex"));
      expect(new BallotSession().commitment(commitmentRequest(secret))).toEqual({
        ok: true,
        commitment: BigInt(commitment),
      });
      expect(secret.every((b) => b === 0)).toBe(true);
    }
  });

  test("bytes that aren't an identity secret are refused and zeroed", () => {
    for (const fill of [0x00, 0xff]) {
      const secret = new Uint8Array(32).fill(fill);
      expect(new BallotSession().commitment(commitmentRequest(secret))).toEqual({
        ok: false,
        problem: "secret",
      });
      expect(secret.every((b) => b === 0)).toBe(true);
    }
  });

  test("leaves the held poll, the voter's cell and the seals as they were", () => {
    const session = holding();
    const sealed = session.seal(sealRequest([1, 0, 0, 1, 0]));
    if (!sealed.ok) throw new Error(sealed.problem);
    expect(session.findCell(findCellRequest())).toEqual({ ok: true, cell: 0 });
    session.commitment(commitmentRequest(Uint8Array.from(members[0] as Uint8Array)));
    expect(session.seal(sealRequest([0, 1, 0, 0, 1])).ok).toBe(true);
    expect(session.challenge(challengeRequest(sealed.seal)).ok).toBe(true);
    expect(session.findCell(findCellRequest())).toEqual({ ok: true, cell: 0 });
  });
});

const backupSealRequest = (prf: Uint8Array, secret: Uint8Array): BackupSealRequest => ({
  v: PROTOCOL_VERSION,
  id: 7,
  kind: "backup-seal",
  prf,
  secret,
});

describe("the backup seal", () => {
  const prfOutput = fc.uint8Array({ minLength: 32, maxLength: 32 });
  const secret = fc
    .bigInt({ min: 1n, max: BABYJUBJUB_ORDER - 1n })
    .map((n) => Uint8Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex")));

  test("is an envelope that opens to the secret under the PRF output, stored under its locator, with both inputs zeroed", () => {
    fc.assert(
      fc.property(prfOutput, secret, (prf, s) => {
        const expected = toHex(s);
        const locator = identityBackupLocator(prf);
        const request = backupSealRequest(prf.slice(), s.slice());
        const result = new BallotSession().backupSeal(request);
        if (!result.ok) throw new Error(result.problem);
        expect(toHex(result.locator)).toBe(toHex(locator));
        expect(result.envelope).toHaveLength(63);
        expect(toHex(openIdentityBackup(prf, result.envelope))).toBe(expected);
        expect(request.prf.every((b) => b === 0)).toBe(true);
        expect(request.secret.every((b) => b === 0)).toBe(true);
      }),
      { numRuns: Math.min(numRuns, 100) },
    );
  });

  test("a fresh nonce for every seal", () => {
    const session = new BallotSession();
    const seal = () =>
      session.backupSeal(
        backupSealRequest(new Uint8Array(32).fill(1), Uint8Array.from(members[0] as Uint8Array)),
      );
    const [a, b] = [seal(), seal()];
    if (!a.ok || !b.ok) throw new Error("not sealed");
    expect(toHex(a.envelope)).not.toBe(toHex(b.envelope));
  });

  test("bytes that aren't an identity secret are refused, with both inputs zeroed", () => {
    for (const fill of [0x00, 0xff]) {
      const request = backupSealRequest(new Uint8Array(32).fill(1), new Uint8Array(32).fill(fill));
      expect(new BallotSession().backupSeal(request)).toEqual({ ok: false, problem: "secret" });
      expect(request.prf.every((b) => b === 0)).toBe(true);
      expect(request.secret.every((b) => b === 0)).toBe(true);
    }
  });

  test("leaves the held poll, the voter's cell and the seals as they were", () => {
    const session = holding();
    const sealed = session.seal(sealRequest([1, 0, 0, 1, 0]));
    if (!sealed.ok) throw new Error(sealed.problem);
    expect(session.findCell(findCellRequest())).toEqual({ ok: true, cell: 0 });
    session.backupSeal(
      backupSealRequest(new Uint8Array(32).fill(1), Uint8Array.from(members[0] as Uint8Array)),
    );
    expect(session.challenge(challengeRequest(sealed.seal)).ok).toBe(true);
    expect(session.findCell(findCellRequest())).toEqual({ ok: true, cell: 0 });
  });
});

// GROUP serves region 3 and OTHER_GROUP region 7: region codes, not indices.
const REGISTRY = registryWith(cellLeaves.slice(1));
const outcomeRequest = (change: Partial<Tier0OutcomeRequest> = {}): Tier0OutcomeRequest => ({
  v: PROTOCOL_VERSION,
  id: 6,
  kind: "tier0-outcome",
  secret: Uint8Array.from(members[1] as Uint8Array),
  region: 3,
  block: 1_000n,
  groups: [
    { group_id: GROUP, region: 3 },
    { group_id: OTHER_GROUP, region: 7 },
  ],
  records: REGISTRY,
  registry: definition.group_registry,
  chainId: definition.l2_chain_id,
  version: 8,
  ...registrars,
  ...change,
});

describe("a Tier 0 registration's outcome", () => {
  test("registered in the region it asked for, moved in any other, and the secret zeroed", () => {
    for (const [region, kind] of [
      [3, "registered"],
      [7, "moved"],
    ] as const) {
      const secret = Uint8Array.from(members[2] as Uint8Array);
      expect(new BallotSession().tier0Outcome(outcomeRequest({ secret, region }))).toEqual({
        ok: true,
        outcome: { kind, group: GROUP },
      });
      expect(secret.every((b) => b === 0)).toBe(true);
    }
  });

  test("not yet for a commitment the registry never added, or added after the block read", () => {
    const absent = Uint8Array.from(members[0] as Uint8Array);
    expect(new BallotSession().tier0Outcome(outcomeRequest({ secret: absent }))).toEqual({
      ok: true,
      outcome: { kind: "not-yet" },
    });
    // The addition is logged at block 20 (tests/poll.ts).
    for (const [block, kind] of [
      [19n, "not-yet"],
      [20n, "registered"],
    ] as const)
      expect(new BallotSession().tier0Outcome(outcomeRequest({ block }))).toMatchObject({
        ok: true,
        outcome: { kind },
      });
  });

  test("a record that isn't a contract-event record of the pinned version is refused", () => {
    const [first, ...rest] = REGISTRY;
    for (const records of [
      [new Uint8Array([0, 8]), ...rest],
      [Uint8Array.from([...(first as Uint8Array), 0]), ...rest],
    ])
      expect(new BallotSession().tier0Outcome(outcomeRequest({ records }))).toEqual({
        ok: false,
        problem: "record",
      });
    // Version 7's tables are version 8's but for events this log has none
    // of, so only the version byte refuses it.
    expect(new BallotSession().tier0Outcome(outcomeRequest({ version: 7 }))).toEqual({
      ok: false,
      problem: "record",
    });
  });

  test("a history the pinned registry and registrars didn't log is refused with the replay's code", () => {
    // The batch carries `threshold` approvals, one fewer than this asks.
    const stricter = { ...registrars, threshold: registrars.threshold + 1 };
    expect(new BallotSession().tier0Outcome(outcomeRequest(stricter))).toEqual({
      ok: false,
      problem: "registry",
      code: "group-history",
    });
    // Another contract's logs are no registry's: the listed groups were never created.
    expect(
      new BallotSession().tier0Outcome(outcomeRequest({ registry: new Uint8Array(20).fill(1) })),
    ).toEqual({ ok: false, problem: "registry", code: "group-created" });
  });

  test("bytes that aren't an identity secret are refused and zeroed", () => {
    for (const fill of [0x00, 0xff]) {
      const secret = new Uint8Array(32).fill(fill);
      expect(new BallotSession().tier0Outcome(outcomeRequest({ secret }))).toEqual({
        ok: false,
        problem: "secret",
      });
      expect(secret.every((b) => b === 0)).toBe(true);
    }
  });

  test("leaves the held poll, the voter's cell and the seals as they were", () => {
    const session = holding();
    const sealed = session.seal(sealRequest([1, 0, 0, 1, 0]));
    if (!sealed.ok) throw new Error(sealed.problem);
    expect(session.findCell(findCellRequest())).toEqual({ ok: true, cell: 0 });
    expect(session.tier0Outcome(outcomeRequest()).ok).toBe(true);
    expect(session.challenge(challengeRequest(sealed.seal)).ok).toBe(true);
    expect(session.findCell(findCellRequest())).toEqual({ ok: true, cell: 0 });
  });
});

const locatorRequest = (prf: Uint8Array) =>
  ({ v: PROTOCOL_VERSION, id: 8, kind: "backup-locator", prf }) as const;
const openRequest = (
  envelope: Uint8Array,
  change: Partial<BackupOpenRequest> = {},
): BackupOpenRequest => ({
  v: PROTOCOL_VERSION,
  id: 9,
  kind: "backup-open",
  envelope,
  block: 1_000n,
  groups: [
    { group_id: GROUP, region: 3 },
    { group_id: OTHER_GROUP, region: 7 },
  ],
  records: REGISTRY,
  registry: definition.group_registry,
  chainId: definition.l2_chain_id,
  version: 8,
  ...registrars,
  ...change,
});

describe("a recovery's open", () => {
  const PRF = new Uint8Array(32).fill(0x21);
  // members[1] and members[2] are in GROUP (region 3) in REGISTRY; members[0] in none.
  const registered = () => Uint8Array.from(members[2] as Uint8Array);
  const located = (session: BallotSession, prf = PRF) => {
    const request = locatorRequest(prf.slice());
    const { locator } = session.backupLocator(request);
    expect(request.prf.every((b) => b === 0)).toBe(true);
    return locator;
  };

  test("the locator is the spec's for any PRF output, and the page's copy is zeroed", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (prf) => {
        expect(toHex(located(new BallotSession(), prf))).toBe(toHex(identityBackupLocator(prf)));
      }),
      { numRuns: Math.min(numRuns, 100) },
    );
  });

  test("opens the envelope under the kept PRF output and names the group counting the identity, whatever region it asked for", () => {
    const session = new BallotSession();
    located(session);
    const result = session.backupOpen(openRequest(sealIdentityBackup(PRF, registered()).envelope));
    expect(result).toEqual({ ok: true, secret: registered(), group: GROUP, region: 3 });
  });

  test("names the group counting it whether the region asked of the replay is its own or another", () => {
    // The last listed group's region is asked: OTHER_GROUP's 7 above (`moved`), GROUP's 3 here (`registered`).
    const session = new BallotSession();
    located(session);
    const result = session.backupOpen(
      openRequest(sealIdentityBackup(PRF, registered()).envelope, {
        groups: [{ group_id: GROUP, region: 3 }],
      }),
    );
    expect(result).toEqual({ ok: true, secret: registered(), group: GROUP, region: 3 });
  });

  test("an envelope that opens to bytes that aren't an identity secret is refused (the spec's vectors)", () => {
    const vectors = (
      JSON.parse(
        readFileSync(
          new URL("../../../docs/spec/vectors/identity-backup.json", import.meta.url),
          "utf8",
        ),
      ) as { open: { prfOutput: string; envelope: string; code: string }[] }
    ).open.filter((v) => v.code === "backup-secret");
    expect(vectors.length).toBeGreaterThan(0);
    for (const { prfOutput, envelope } of vectors) {
      const session = new BallotSession();
      located(session, Uint8Array.from(Buffer.from(prfOutput, "hex")));
      expect(
        session.backupOpen(openRequest(Uint8Array.from(Buffer.from(envelope, "hex")))),
      ).toEqual({ ok: false, problem: "secret" });
    }
  });

  test("opens once per locator: the PRF output is gone after an open, whatever its outcome", () => {
    const session = new BallotSession();
    const { envelope } = sealIdentityBackup(PRF, registered());
    expect(session.backupOpen(openRequest(envelope))).toEqual({ ok: false, problem: "no-passkey" });
    located(session);
    expect(session.backupOpen(openRequest(new Uint8Array(63)))).toMatchObject({ ok: false });
    expect(session.backupOpen(openRequest(envelope))).toEqual({ ok: false, problem: "no-passkey" });
  });

  test("a later locator replaces the PRF output an earlier one kept", () => {
    const session = new BallotSession();
    const other = new Uint8Array(32).fill(0x22);
    located(session, other);
    located(session);
    expect(session.backupOpen(openRequest(sealIdentityBackup(PRF, registered()).envelope)).ok).toBe(
      true,
    );
  });

  test("bytes that aren't an envelope, and an envelope altered or sealed under another passkey, are refused", () => {
    const { envelope } = sealIdentityBackup(PRF, registered());
    const opened = (bytes: Uint8Array) => {
      const session = new BallotSession();
      located(session);
      return session.backupOpen(openRequest(bytes));
    };
    expect(opened(envelope.slice(0, 62))).toEqual({ ok: false, problem: "envelope" });
    expect(opened(Uint8Array.from([...envelope, 0]))).toEqual({ ok: false, problem: "envelope" });
    fc.assert(
      fc.property(fc.nat({ max: 59 }), fc.integer({ min: 1, max: 255 }), (at, flip) => {
        // Past the 3-byte header: the nonce and the sealed secret.
        const altered = envelope.slice();
        altered[3 + at] = (altered[3 + at] as number) ^ flip;
        expect(opened(altered)).toEqual({ ok: false, problem: "open" });
      }),
      { numRuns: Math.min(numRuns, 100) },
    );
    const elsewhere = sealIdentityBackup(new Uint8Array(32).fill(0x22), registered()).envelope;
    expect(opened(elsewhere)).toEqual({ ok: false, problem: "open" });
  });

  test("an identity counted in no group by the block read is refused, never handed to the page", () => {
    for (const [secret, block] of [
      [Uint8Array.from(members[0] as Uint8Array), 1_000n],
      // The addition is logged at block 20 (tests/poll.ts).
      [registered(), 19n],
    ] as const) {
      const session = new BallotSession();
      located(session);
      expect(
        session.backupOpen(openRequest(sealIdentityBackup(PRF, secret).envelope, { block })),
      ).toEqual({ ok: false, problem: "not-registered" });
    }
    const session = new BallotSession();
    located(session);
    expect(
      session.backupOpen(
        openRequest(sealIdentityBackup(PRF, registered()).envelope, { groups: [] }),
      ),
    ).toEqual({ ok: false, problem: "not-registered" });
  });

  test("a record of another version, or a history the pinned registrars didn't log, is refused", () => {
    const { envelope } = sealIdentityBackup(PRF, registered());
    const opened = (change: Partial<BackupOpenRequest>) => {
      const session = new BallotSession();
      located(session);
      return session.backupOpen(openRequest(envelope, change));
    };
    expect(opened({ version: 7 })).toEqual({ ok: false, problem: "record" });
    expect(opened({ records: [new Uint8Array([0, 8]), ...REGISTRY.slice(1)] })).toEqual({
      ok: false,
      problem: "record",
    });
    expect(opened({ threshold: registrars.threshold + 1 })).toEqual({
      ok: false,
      problem: "registry",
      code: "group-history",
    });
  });

  test("leaves the held poll, the voter's cell and the seals as they were", () => {
    const session = holding();
    const sealed = session.seal(sealRequest([1, 0, 0, 1, 0]));
    if (!sealed.ok) throw new Error(sealed.problem);
    expect(session.findCell(findCellRequest())).toEqual({ ok: true, cell: 0 });
    located(session);
    expect(session.backupOpen(openRequest(sealIdentityBackup(PRF, registered()).envelope)).ok).toBe(
      true,
    );
    expect(session.challenge(challengeRequest(sealed.seal)).ok).toBe(true);
    expect(session.findCell(findCellRequest())).toEqual({ ok: true, cell: 0 });
  });
});
