// A seal cast in the ballot worker (src/worker/session.ts, `cast`): the
// record is proved by a prover at the other end of a channel, here
// @abolishus/membership-prover's snarkjs run in Node as the prover worker
// runs it, over the leaves of the cell the worker found from the board, and
// only a record that passes the admission checks comes back
// (docs/spec/ballot-validity.md, Casting (version 3); T-07, T-12, T-45,
// T-55). Records are judged by @abolishus/crypto's `checkBallotV3` under a
// context made here from the same records, not from the worker.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  checkBallotV3,
  decodeBallot,
  encodeShareReceipt,
  identityCommitment,
  intakeBallot,
  sealingElectionV5,
  shareCiphertextHash,
} from "@abolishus/crypto";
import { proveMembership } from "@abolishus/membership-prover";
import { describe, expect, test } from "vite-plus/test";

import { parseWitness, PROVER_PROTOCOL_VERSION } from "../src/prover/protocol.ts";
import {
  type CastRequest,
  type CastResult,
  type CheckElectionRequest,
  type FindCellRequest,
  type PostingRequest,
  PROTOCOL_VERSION,
} from "../src/worker/protocol.ts";
import { BallotSession } from "../src/worker/session.ts";
import {
  board,
  boardWith,
  cellLeaves,
  definition,
  definitionBytes,
  displayText,
  entry,
  GROUP,
  members,
  panel,
  registeredHash,
  registrars,
  seats,
} from "./poll.ts";

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const ARTIFACTS = new URL("../../../packages/membership-prover/artifacts/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", ARTIFACTS), "utf8")) as {
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
};
const vendored = (path: string) => {
  const entry = manifest.files.find((f) => f.path === path);
  const b = new Uint8Array(readFileSync(new URL(path, ARTIFACTS)));
  if (entry === undefined || createHash("sha256").update(b).digest("hex") !== entry.sha256)
    throw new Error(`${path}: not the manifest's bytes`);
  return b;
};
const artifacts = {
  zkey: vendored("snark-artifacts/semaphore-32.zkey"),
  wasm: vendored("snark-artifacts/semaphore-32.wasm"),
};

const independent = sealingElectionV5(definition, [panel], [entry]);
if (!independent.ok) throw new Error(independent.code);
const { election } = independent;

const VOTES: (0 | 1)[] = [0, 1, 0, 0, 1];
const L1 = { l1Number: 9_000_000n, l1Hash: new Uint8Array(32).fill(0xab) };
const PROOF_TIMEOUT = 60_000;

/** A prover on the other end of a channel: records what it is sent and answers with `reply`. */
function prover(reply: (witness: unknown) => unknown) {
  const { port1, port2 } = new MessageChannel();
  const received: unknown[] = [];
  port2.onmessage = async ({ data }: MessageEvent<unknown>) => {
    received.push(data);
    const answer = await reply((data as { witness?: unknown }).witness);
    if (answer !== undefined) port2.postMessage(answer);
  };
  return { port: port1, received, close: () => port2.close() };
}

/** The real prover: snarkjs over the vendored key, as src/prover/prover.ts runs it. */
const snarkjs = () => {
  const proofs: Uint8Array[] = [];
  const p = prover(async (witness) => {
    const parsed = parseWitness({ v: PROVER_PROTOCOL_VERSION, kind: "witness", witness });
    if (parsed === undefined) return { v: PROVER_PROTOCOL_VERSION, kind: "error" };
    const proof = await proveMembership(parsed.witness, artifacts);
    proofs.push(Uint8Array.from(proof));
    return { v: PROVER_PROTOCOL_VERSION, kind: "proof", proof };
  });
  return { ...p, proofs };
};

// The membership proof's bytes inside an encoded version-3 record: after the
// header, definition hash, cell, nullifier and L1 reference.
const proofIn = (ballot: Uint8Array) => {
  const at = 3 + 32 + 1 + 32 + 8 + 32;
  return ballot.slice(at, at + 256);
};

const checkRequest: CheckElectionRequest = {
  v: PROTOCOL_VERSION,
  id: 1,
  kind: "check-election",
  electionId: definition.election_id,
  registeredHash,
  definition: definitionBytes,
  displayText,
  entries: [entry],
  panels: [panel],
};

const findCellRequest = (change: Partial<FindCellRequest> = {}): FindCellRequest => ({
  v: PROTOCOL_VERSION,
  id: 5,
  kind: "find-cell",
  definitionHash: registeredHash,
  secret: Uint8Array.from(members[1] as Uint8Array),
  tier: 0,
  group: GROUP,
  entries: board,
  ...registrars,
  ...change,
});

const sealIn = (session: BallotSession, cell: number) => {
  const result = session.seal({
    v: PROTOCOL_VERSION,
    id: 2,
    kind: "seal",
    definitionHash: registeredHash,
    cell,
    votes: VOTES,
  });
  if (!result.ok) throw new Error(result.problem);
  return result.seal;
};

/**
 * A session holding the poll, the cell of member 1 found from `find` (the
 * honest board unless given; none if `null`) and one seal of `VOTES` in cell 0.
 */
function sealed(find: Partial<FindCellRequest> | null = {}): {
  session: BallotSession;
  seal: number;
} {
  const session = new BallotSession();
  const check = session.checkElection(checkRequest);
  if (!check.ok) throw new Error(check.problem);
  if (find !== null) {
    const found = session.findCell(findCellRequest(find));
    if (!found.ok) throw new Error(found.problem);
  }
  return { session, seal: sealIn(session, 0) };
}

const castRequest = (
  seal: number,
  port: MessagePort,
  change: Partial<Pick<CastRequest, "secret" | "l1Number" | "l1Hash">> = {},
): CastRequest => ({
  v: PROTOCOL_VERSION,
  id: 3,
  kind: "cast",
  seal,
  secret: Uint8Array.from(members[1] as Uint8Array),
  ...L1,
  ...change,
  prover: port,
});

const challenge = (session: BallotSession, seal: number) =>
  session.challenge({ v: PROTOCOL_VERSION, id: 4, kind: "challenge", seal });

function admitted(result: CastResult) {
  if (!result.ok) throw new Error(`refused: ${result.problem}`);
  const record = decodeBallot(result.ballot, 3);
  const verdict = checkBallotV3(election, record);
  if (!verdict.ok) throw new Error(verdict.code);
  return { record, verdict };
}

describe("casting a seal", () => {
  test(
    "each seat's receipt from intake passes for the cast it receipts, and nothing else does (Client rule 1)",
    async () => {
      const { session, seal } = sealed();
      const p = snarkjs();
      const result = await session.cast(castRequest(seal, p.port));
      p.close();
      admitted(result);
      if (!result.ok) throw new Error("unreachable");
      const receipts = result.ciphertexts.map(({ seat, ciphertext }) => {
        const secrets = seats[seat - 1];
        if (secrets === undefined) throw new Error(`no seat ${seat}`);
        const intake = intakeBallot(
          election,
          { seat, kemSecret: secrets.kem.secretKey, signingSecret: secrets.signingSecret },
          result.ballot,
          ciphertext,
        );
        if (!intake.ok) throw new Error(intake.code);
        return encodeShareReceipt({
          definition_hash: registeredHash,
          ballot_hash: intake.ballotHash,
          seat,
          share_hash: intake.shareHash,
          signature: intake.receipt,
        });
      });
      const ask = (receipt: Uint8Array, ballot = result.ballot, on = session) =>
        on.receipt({ v: PROTOCOL_VERSION, id: 6, kind: "receipt", ballot, receipt });
      // Another seat's signature under this seat's statement.
      const [first, second] = receipts as [Uint8Array, Uint8Array];
      const forged = Uint8Array.of(...first.subarray(0, -64), ...second.subarray(-64));
      expect(ask(forged)).toEqual({ ok: false, problem: "refused" });
      expect(ask(first.subarray(1))).toEqual({ ok: false, problem: "refused" });
      const firstSeat = (result.ciphertexts[0] as (typeof result.ciphertexts)[number]).seat;
      expect(ask(first)).toEqual({ ok: true, seat: firstSeat });

      // The passing receipt erased its seat's m_i from the seal, and the
      // refused ones erased nothing: a recast hands every other seat's m_i
      // as before, and none for that seat (Client rule 2; T-18, T-25).
      const shares = (cast: CastResult & { ok: true }) =>
        cast.ciphertexts.map(({ seat, ciphertext, m }) => [
          seat,
          toHex(ciphertext),
          m === undefined ? undefined : toHex(m),
        ]);
      const later = snarkjs();
      const recast = await session.cast(
        castRequest(seal, later.port, { l1Number: 9_000_100n, l1Hash: new Uint8Array(32) }),
      );
      later.close();
      admitted(recast);
      if (!recast.ok) throw new Error("unreachable");
      expect(shares(recast)).toEqual(
        shares(result).map(([seat, ct, m]) => [seat, ct, seat === firstSeat ? undefined : m]),
      );
      // The page's copy from the first cast is its own, never reached from here.
      expect(result.ciphertexts.every(({ m }) => m?.length === 32)).toBe(true);
      // A receipt counts for every recast of the seal, so each one names its seat.
      result.ciphertexts.forEach(({ seat }, i) =>
        expect(ask(receipts[i] as Uint8Array, recast.ballot)).toEqual({ ok: true, seat }),
      );
      // A ballot that isn't a cast of the poll held, or no poll held at all.
      expect(ask(first, result.ballot.subarray(1))).toEqual({ ok: false, problem: "unknown" });
      expect(ask(first, result.ballot, new BallotSession())).toEqual({
        ok: false,
        problem: "unknown",
      });
    },
    3 * PROOF_TIMEOUT,
  );

  test(
    "each seat's kept m_i passes as a posting under its own registered key, and nothing else does (Client rule 4)",
    async () => {
      const { session, seal } = sealed();
      const p = snarkjs();
      const result = await session.cast(castRequest(seal, p.port));
      p.close();
      admitted(result);
      if (!result.ok) throw new Error("unreachable");
      const ask = (
        share: { seat: number; ciphertext: Uint8Array; m: Uint8Array },
        ballot = result.ballot,
        on = session,
      ) =>
        on.posting({
          v: PROTOCOL_VERSION,
          id: 7,
          kind: "posting",
          ballot,
          seat: share.seat,
          ciphertext: share.ciphertext,
          m: Uint8Array.from(share.m),
        });
      const kept = result.ciphertexts.map(({ seat, ciphertext, m }) => {
        if (m === undefined) throw new Error(`seat ${seat}: no m kept before any receipt`);
        return { seat, ciphertext, m };
      });
      for (const share of kept) expect(ask(share)).toEqual({ ok: true });
      const [first, second] = kept as [(typeof kept)[number], (typeof kept)[number]];
      const flipped = Uint8Array.from(first.m);
      flipped[31] = (flipped[31] as number) ^ 0x80;
      expect(ask({ ...first, m: flipped })).toEqual({
        ok: false,
        problem: "refused",
        code: "posting-encapsulation",
      });
      // Another seat's m_i, or its ciphertext, never passes for this seat.
      expect(ask({ ...first, m: second.m })).toEqual({
        ok: false,
        problem: "refused",
        code: "posting-encapsulation",
      });
      expect(ask({ ...first, ciphertext: second.ciphertext })).toEqual({
        ok: false,
        problem: "refused",
        code: "posting-hash",
      });
      // The worker's copy of m is zeroed once judged; the caller's isn't touched.
      const request: PostingRequest = {
        v: PROTOCOL_VERSION,
        id: 8,
        kind: "posting",
        ballot: result.ballot,
        ...first,
        m: Uint8Array.from(first.m),
      };
      expect(session.posting(request)).toEqual({ ok: true });
      expect(request.m.every((b) => b === 0)).toBe(true);
      expect(first.m.some((b) => b !== 0)).toBe(true);
      // A ballot that isn't a cast of the poll held, a seat outside its panel, or no poll held.
      expect(ask(first, result.ballot.subarray(1))).toEqual({ ok: false, problem: "unknown" });
      expect(ask({ ...first, seat: 17 })).toEqual({ ok: false, problem: "unknown" });
      expect(ask(first, result.ballot, new BallotSession())).toEqual({
        ok: false,
        problem: "unknown",
      });
    },
    2 * PROOF_TIMEOUT,
  );

  test(
    "a decline erases every m_i the seal keeps for its cast, so a recast hands none, and nothing for another poll's ballot (Client rule 4)",
    async () => {
      const { session, seal } = sealed();
      const p = snarkjs();
      const result = await session.cast(castRequest(seal, p.port));
      p.close();
      admitted(result);
      if (!result.ok) throw new Error("unreachable");
      const decline = (ballot: Uint8Array, on = session) =>
        on.decline({ v: PROTOCOL_VERSION, id: 9, kind: "decline", ballot });
      // Bytes that aren't a version-3 record, or no poll held, erase nothing.
      expect(decline(result.ballot.subarray(1))).toEqual({ ok: false, problem: "unknown" });
      expect(decline(result.ballot, new BallotSession())).toEqual({
        ok: false,
        problem: "unknown",
      });
      const recastAt = async (l1Number: bigint) => {
        const later = snarkjs();
        const recast = await session.cast(
          castRequest(seal, later.port, { l1Number, l1Hash: new Uint8Array(32) }),
        );
        later.close();
        admitted(recast);
        if (!recast.ok) throw new Error("unreachable");
        return recast;
      };
      expect((await recastAt(9_000_100n)).ciphertexts.every(({ m }) => m?.length === 32)).toBe(
        true,
      );
      expect(decline(result.ballot)).toEqual({ ok: true });
      for (const share of (await recastAt(9_000_200n)).ciphertexts)
        expect(share).not.toHaveProperty("m");
      // The page's copy from the first cast is its own; a second decline is a no-op.
      expect(result.ciphertexts.every(({ m }) => m?.length === 32)).toBe(true);
      expect(decline(result.ballot)).toEqual({ ok: true });
    },
    4 * PROOF_TIMEOUT,
  );

  test(
    "the record passes the admission checks, carries the seal's core, and recasts with the same vote; the seal is never opened",
    async () => {
      const { session, seal } = sealed();
      const p = snarkjs();
      const secret = Uint8Array.from(members[1] as Uint8Array);
      const result = await session.cast(castRequest(seal, p.port, { secret }));
      const { record, verdict } = admitted(result);
      if (!result.ok) throw new Error("unreachable");
      // The prover heard one witness, and nothing else (T-12, T-55).
      expect(p.received).toHaveLength(1);
      expect(Object.keys(p.received[0] as object).sort()).toEqual(["kind", "v", "witness"]);
      // The worker's copy of the secret is gone (T-12).
      expect(secret.every((b) => b === 0)).toBe(true);
      expect(toHex(verdict.ballotHash)).toBe(toHex(result.ballotHash));
      // Re-randomised: the prover's bytes never leave (T-55).
      expect(p.proofs).toHaveLength(1);
      expect(toHex(proofIn(result.ballot))).not.toBe(toHex(p.proofs[0] as Uint8Array));
      expect(record.cell).toBe(0);
      expect(record.l1_ref_number).toBe(L1.l1Number);
      expect(toHex(record.l1_ref_hash)).toBe(toHex(L1.l1Hash));
      // Every seat registered, each with the ciphertext its share hash names.
      expect(result.ciphertexts.map((c) => c.seat)).toEqual(
        // Every seat ran the ceremony, so every seat qualifies.
        panel.keys.map((_, i) => i + 1),
      );
      for (const { seat, ciphertext } of result.ciphertexts)
        expect(toHex(shareCiphertextHash(ciphertext))).toBe(
          toHex(record.committed_vote.share_hashes[seat - 1] as Uint8Array),
        );
      p.close();

      // A recast under a newer block (revoting Client rule 4): the same
      // committed vote, so the same ballot hash, and a new message.
      const later = snarkjs();
      const recast = await session.cast(
        castRequest(seal, later.port, { l1Number: 9_000_100n, l1Hash: new Uint8Array(32) }),
      );
      const again = admitted(recast);
      later.close();
      expect(again.verdict.nullifier).toBe(verdict.nullifier);
      expect(toHex(again.verdict.ballotHash)).toBe(toHex(verdict.ballotHash));
      expect(toHex(again.verdict.message)).not.toBe(toHex(verdict.message));

      expect(challenge(session, seal)).toEqual({ ok: false, problem: "cast" });
    },
    3 * PROOF_TIMEOUT,
  );

  test(
    "a recast under another member's secret is refused before the prover hears anything, even once that member's cell is found",
    async () => {
      const { session, seal } = sealed();
      const p = snarkjs();
      admitted(await session.cast(castRequest(seal, p.port)));
      p.close();
      const other = () => Uint8Array.from(members[2] as Uint8Array);
      for (const find of [false, true]) {
        if (find) expect(session.findCell(findCellRequest({ secret: other() })).ok).toBe(true);
        const q = prover(() => undefined);
        const result = await session.cast(castRequest(seal, q.port, { secret: other() }));
        expect(result).toEqual({ ok: false, problem: "secret" });
        expect(q.received).toEqual([]);
        q.close();
      }
    },
    2 * PROOF_TIMEOUT,
  );

  test("a seal whose cast failed is still never opened (T-45)", async () => {
    const { session, seal } = sealed();
    const p = prover(() => ({ v: PROVER_PROTOCOL_VERSION, kind: "error" }));
    await expect(session.cast(castRequest(seal, p.port))).resolves.toEqual({
      ok: false,
      problem: "prover",
    });
    p.close();
    expect(challenge(session, seal)).toEqual({ ok: false, problem: "cast" });
  });

  test("a seal whose cast was refused before any witness is never opened either (T-45)", async () => {
    const { session, seal } = sealed();
    const p = prover(() => undefined);
    await expect(
      session.cast(castRequest(seal, p.port, { secret: new Uint8Array(32) })),
    ).resolves.toEqual({ ok: false, problem: "secret" });
    p.close();
    expect(challenge(session, seal)).toEqual({ ok: false, problem: "cast" });
  });

  test("a challenge while the cast waits on the prover is refused (T-45)", async () => {
    const { session, seal } = sealed();
    let release = () => {};
    const p = prover(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ v: PROVER_PROTOCOL_VERSION, kind: "error" });
        }),
    );
    const casting = session.cast(castRequest(seal, p.port));
    expect(challenge(session, seal)).toEqual({ ok: false, problem: "cast" });
    // Let the witness reach the prover before it answers.
    await expect.poll(() => p.received.length).toBe(1);
    release();
    await expect(casting).resolves.toEqual({ ok: false, problem: "prover" });
    p.close();
    expect(challenge(session, seal)).toEqual({ ok: false, problem: "cast" });
  });

  test("a seal the worker never made, or one challenged, isn't cast, and the prover hears nothing", async () => {
    const { session, seal } = sealed();
    expect(challenge(session, seal).ok).toBe(true);
    for (const s of [seal, seal + 1]) {
      const p = prover(() => undefined);
      const secret = Uint8Array.from(members[1] as Uint8Array);
      await expect(session.cast(castRequest(s, p.port, { secret }))).resolves.toEqual({
        ok: false,
        problem: "unknown",
      });
      expect(p.received).toEqual([]);
      expect(secret.every((b) => b === 0)).toBe(true);
      p.close();
    }
  });

  // Several seals, each a fresh sharing and encryption over every question:
  // about 6 s on a loaded CI runner, past the 5 s default.
  test(
    "a secret other than the one found, a malformed one, and a board whose leaves miss the cell's root are refused before any proving",
    async () => {
      // A valid secret, and no member's; a fresh copy each time, as the worker zeroes it.
      const outsider = () => {
        const s = new Uint8Array(32);
        s[0] = 1;
        return s;
      };
      const cases: [Partial<FindCellRequest>, Partial<CastRequest>, string][] = [
        [{}, { secret: outsider() }, "secret"],
        [{}, { secret: new Uint8Array(32) }, "secret"],
        // The cell's members in another order: the counts agree with the
        // definition, but the leaves don't climb to the cell's root.
        [{ entries: boardWith([...cellLeaves].reverse()) }, {}, "root"],
        // An outsider in the voter's place.
        [{ entries: boardWith(cellLeaves.with(0, identityCommitment(outsider()))) }, {}, "root"],
      ];
      for (const [find, change, problem] of cases) {
        const { session, seal } = sealed(find);
        const p = prover(() => undefined);
        await expect(session.cast(castRequest(seal, p.port, change))).resolves.toEqual({
          ok: false,
          problem,
        });
        expect(p.received).toEqual([]);
        p.close();
      }
    },
    PROOF_TIMEOUT,
  );

  test(
    "a seal is cast only in the voter's cell, found for the poll the worker holds",
    async () => {
      const tries: [string, () => { session: BallotSession; seal: number }][] = [
        ["no cell found", () => sealed(null)],
        [
          "a refused search",
          () => {
            const s = sealed();
            s.session.findCell(findCellRequest({ group: GROUP + 1n }));
            return s;
          },
        ],
        [
          "a seal in another cell",
          () => {
            const s = sealed();
            return { session: s.session, seal: sealIn(s.session, 1) };
          },
        ],
        [
          "a poll checked anew",
          () => {
            const s = sealed();
            s.session.checkElection(checkRequest);
            return { session: s.session, seal: sealIn(s.session, 0) };
          },
        ],
      ];
      for (const [what, make] of tries) {
        const { session, seal } = make();
        const p = prover(() => undefined);
        await expect(session.cast(castRequest(seal, p.port)), what).resolves.toEqual({
          ok: false,
          problem: "no-cell",
        });
        expect(p.received).toEqual([]);
        p.close();
        // Refused, but cast: never opened (T-45).
        expect(challenge(session, seal)).toEqual({ ok: false, problem: "cast" });
      }
    },
    PROOF_TIMEOUT,
  );

  test(
    "a proof of another cast, an artifact the prover refused, and no answer in time are refusals",
    async () => {
      // A real proof, but of the first seal's statement.
      const { session: first, seal: one } = sealed();
      const proofs: Uint8Array[] = [];
      const real = prover(async (witness) => {
        const parsed = parseWitness({ v: PROVER_PROTOCOL_VERSION, kind: "witness", witness });
        if (parsed === undefined) return { v: PROVER_PROTOCOL_VERSION, kind: "error" };
        const proof = await proveMembership(parsed.witness, artifacts);
        proofs.push(proof);
        return { v: PROVER_PROTOCOL_VERSION, kind: "proof", proof };
      });
      admitted(await first.cast(castRequest(one, real.port)));
      real.close();

      const { session, seal } = sealed();
      const replay = prover(() => ({
        v: PROVER_PROTOCOL_VERSION,
        kind: "proof",
        proof: proofs[0],
      }));
      await expect(session.cast(castRequest(seal, replay.port))).resolves.toEqual({
        ok: false,
        problem: "proof",
      });
      replay.close();

      const refused = prover(() => ({
        v: PROVER_PROTOCOL_VERSION,
        kind: "refused",
        problem: "zkey",
      }));
      await expect(session.cast(castRequest(seal, refused.port))).resolves.toEqual({
        ok: false,
        problem: "zkey",
      });
      refused.close();

      const silent = prover(() => undefined);
      await expect(session.cast(castRequest(seal, silent.port), 50)).resolves.toEqual({
        ok: false,
        problem: "prover",
      });
      silent.close();
    },
    2 * PROOF_TIMEOUT,
  );
});
