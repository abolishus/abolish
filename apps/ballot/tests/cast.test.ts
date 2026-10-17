// A seal cast in the ballot worker (src/worker/session.ts, `cast`): the
// record is proved by a prover at the other end of a channel, here
// @abolishus/membership-prover's snarkjs run in Node as the prover worker
// runs it, and only a record that passes the admission checks comes back
// (docs/spec/ballot-validity.md, Casting (version 3); T-07, T-12, T-45,
// T-55). Records are judged by @abolishus/crypto's `checkBallotV3` under a
// context made here from the same records, not from the worker.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  checkBallotV3,
  decodeBallot,
  identityCommitment,
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
  PROTOCOL_VERSION,
} from "../src/worker/protocol.ts";
import { BallotSession } from "../src/worker/session.ts";
import {
  cellLeaves,
  definition,
  definitionBytes,
  displayText,
  entry,
  members,
  panel,
  registeredHash,
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

/** A session holding the poll and one seal of `VOTES` in cell 0. */
function sealed(): { session: BallotSession; seal: number } {
  const session = new BallotSession();
  const check = session.checkElection(checkRequest);
  if (!check.ok) throw new Error(check.problem);
  const result = session.seal({
    v: PROTOCOL_VERSION,
    id: 2,
    kind: "seal",
    definitionHash: registeredHash,
    cell: 0,
    votes: VOTES,
  });
  if (!result.ok) throw new Error(result.problem);
  return { session, seal: result.seal };
}

const castRequest = (
  seal: number,
  port: MessagePort,
  change: Partial<Pick<CastRequest, "secret" | "leaves" | "l1Number" | "l1Hash">> = {},
): CastRequest => ({
  v: PROTOCOL_VERSION,
  id: 3,
  kind: "cast",
  seal,
  secret: Uint8Array.from(members[1] as Uint8Array),
  leaves: cellLeaves,
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
    "a recast under another member's secret is refused before the prover hears anything",
    async () => {
      const { session, seal } = sealed();
      const p = snarkjs();
      admitted(await session.cast(castRequest(seal, p.port)));
      p.close();
      const other = prover(() => undefined);
      const result = await session.cast(
        castRequest(seal, other.port, { secret: Uint8Array.from(members[2] as Uint8Array) }),
      );
      expect(result).toEqual({ ok: false, problem: "secret" });
      expect(other.received).toEqual([]);
      other.close();
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

  test("a non-member, leaves that miss the cell's root and a malformed secret are refused before any proving", async () => {
    // A valid secret, and no member's; a fresh copy each time, as the worker zeroes it.
    const outsider = () => {
      const s = new Uint8Array(32);
      s[0] = 1;
      return s;
    };
    const cases: [Partial<CastRequest>, string][] = [
      // A secret whose commitment isn't one of the cell's leaves.
      [{ leaves: [...cellLeaves, identityCommitment(outsider())], secret: outsider() }, "root"],
      [{ secret: outsider() }, "not-a-member"],
      // The cell's leaves without the voter's.
      [{ leaves: cellLeaves.filter((_, i) => i !== 1) }, "not-a-member"],
      // The voter's among them, out of order: they don't climb to the cell's root.
      [{ leaves: [...cellLeaves].reverse() }, "root"],
      [{ secret: new Uint8Array(32) }, "secret"],
    ];
    for (const [change, problem] of cases) {
      const { session, seal } = sealed();
      const p = prover(() => undefined);
      await expect(session.cast(castRequest(seal, p.port, change))).resolves.toEqual({
        ok: false,
        problem,
      });
      expect(p.received).toEqual([]);
      p.close();
    }
  });

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
