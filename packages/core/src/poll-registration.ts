// The registration step of a poll's setup ([[0032-poll-creation-operations]],
// rules 4, 12 and 14; P2-22 part 5a): once a poll's ceremony is approved, the
// creation key that created it registers the ceremony with the trustee
// registry and the definition with the election registry, and the poll moves
// to `registered` once that transaction's `DefinitionRegistered` event is in
// finalized L2 history. The chain adapter signs, sends and reads; this module
// decides what to send and when a poll moves on.
//
// The definition is the stub with the approved transcript's hash in place of
// zero, so it has the stub's hash every seat approved; the ceremony's record
// carries the key set and approvals the coordinator collected. Both are
// checked here again, by @abolishus/crypto, before any gas is spent: the
// transcript under the panel, the key set's hash and each approval under
// its seat's pinned key, the quorum, and the definition's own rules (T-37,
// T-14, T-34).
//
// Write before send (rule 12): both transactions are signed at consecutive
// nonces and recorded in the creation key's ledger beside its creations,
// under the lock that orders the key's nonces, and committed before either
// is sent. The ceremony's comes first, so the definition's runs after it;
// anyone may send the same ceremony record, so only the definition's outcome
// moves the poll.
//
// T-10: only the creation key's public transactions, and on the author's own
// record which are theirs; nothing about a voter.

import {
  checkCeremonyTranscript,
  decodeElectionDefinitionV5,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  electionStubV5Hash,
  encodeCeremonyRegistration,
  encodeElectionDefinitionV5,
  keySetEntry,
  keySetHash,
  type Panel,
  panelId,
  profileCombinationRule,
  verifyCeremonyRegistration,
} from "@abolishus/crypto";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { type ApprovedCeremony, approvedCeremony } from "./ceremony-coordinator.ts";
import { accountPolls, ceremonyStubs, pollCreationTxs } from "./db/schema/index.ts";
import {
  lockSigning,
  nextNonce,
  type PollCreationChain,
  type SignedCreation,
  unincluded,
} from "./poll-creation.ts";

/** What the chain says of one recorded `registerDefinition`, judged at the node's finalized block. */
export type RegistrationStatus =
  /** The node knows nothing of it: not sent yet, dropped, or replaced. */
  | { readonly state: "unknown" }
  /** Known to the node, and not yet final. */
  | { readonly state: "included" }
  /** Final, and reverted. */
  | { readonly state: "reverted" }
  /** Final, with the election registry's `DefinitionRegistered` event. */
  | {
      readonly state: "registered";
      readonly electionId: Uint8Array;
      readonly definitionHash: Uint8Array;
      readonly block: bigint;
    };

/** The creation key on L2, as the registration step uses it (the worker's chain adapter). */
export interface PollRegistrationChain extends Pick<
  PollCreationChain,
  "creator" | "nonces" | "broadcast"
> {
  /** Signs `registerCeremony(record)` to the deployment's trustee registry at `nonce`, sending nothing. */
  signCeremony(nonce: bigint, record: Uint8Array): Promise<SignedCreation>;
  /** Signs `registerDefinition(definition)` to the deployment's election registry at `nonce`, sending nothing. */
  signDefinition(nonce: bigint, definition: Uint8Array): Promise<SignedCreation>;
  /** The `registerDefinition` whose transaction hash is `hash`, at the node's finalized block. */
  registration(hash: Uint8Array): Promise<RegistrationStatus>;
}

/**
 * How close to `opens_at` a registration may still be signed: the registry
 * refuses one included at or after it (`AlreadyOpen`), and an L2 includes a
 * transaction within seconds, so five minutes is a node or a fee that isn't
 * moving. A poll this late waits for rule 10's new stub (part 5c).
 */
export const REGISTRATION_MARGIN_SECONDS = 5 * 60;

/**
 * How long a registration may take, from its recording to finality, before
 * its poll fails with `registration-timeout`, as for a creation (rule 14).
 */
export const REGISTRATION_DEADLINE_MS = 2 * 60 * 60_000;

/** Most new registrations one run signs; the next run takes the rest. */
export const REGISTRATIONS_PER_RUN = 20;

/** Why the registration step fails a poll (the `failure` column's codes it writes). */
export type RegistrationFailure =
  /**
   * The approved ceremony or the definition it completes fails crypto's
   * checks: no seat should have approved it, so nothing is sent.
   */
  | "registration-refused"
  /** `registerDefinition` reverted in finalized history. */
  | "registration-reverted"
  /** Another transaction of the key took its nonce in finalized history. */
  | "registration-replaced"
  /** Not registered within `REGISTRATION_DEADLINE_MS` of its recording. */
  | "registration-timeout"
  /** The finalized event names another election or another definition. */
  | "registration-mismatch";

/** One run's outcome, in counts only (T-10, T-67). */
export interface PollRegistrationReport {
  /** Polls whose two transactions were signed, recorded and sent. */
  sent: number;
  /** Recorded transactions sent again, not yet included. */
  resent: number;
  /** Sends the node refused; the next run sends them again. */
  sendFailed: number;
  /** Polls moved to `registered`. */
  registered: number;
  /** Polls in `ceremony` whose stub has no approved run yet. */
  waiting: number;
  /** Approved polls left unsigned within `REGISTRATION_MARGIN_SECONDS` of opening. */
  late: number;
  /** Approved polls whose stub names another panel than the one given. */
  mismatched: number;
  /** Polls moved to `failed`, by reason. */
  failed: Partial<Record<RegistrationFailure, number>>;
}

export interface PollRegistrationOptions {
  readonly now: Date;
  /** `REGISTRATION_DEADLINE_MS` unless a test says otherwise. */
  readonly deadlineMs?: number;
}

/** Rule 7's quorum: the approving seats every honest seat requires. */
const quorum = (panel: Panel) => Math.max(panel.threshold, panel.keys.length - 1);

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** What a poll registers: its definition and the ceremony record that lets the registry admit it. */
export interface PollRegistration {
  /** The stub with the approved transcript's hash: the definition, encoded. */
  readonly definition: Uint8Array;
  readonly definitionHash: Uint8Array;
  /** The trustee registry's `registerCeremony` record. */
  readonly record: Uint8Array;
}

/**
 * The definition and ceremony record of `stub`'s approved run, or
 * `"other-panel"` when the stub doesn't name `panel`, or `"refused"` when
 * the run doesn't pass crypto's checks: its transcript under the panel, the
 * key set's hash, a quorum of approvals each verifying under its seat's
 * pinned key, and the completed definition's own rules and stub hash.
 */
export function pollRegistration(
  stub: Uint8Array,
  stubHash: Uint8Array,
  panel: Panel,
  approved: ApprovedCeremony,
): PollRegistration | "other-panel" | "refused" {
  let decoded: ElectionDefinitionV5;
  try {
    decoded = decodeElectionDefinitionV5(stub);
  } catch {
    return "refused";
  }
  if (
    !equal(decoded.panel_id, panelId(panel)) ||
    decoded.threshold !== panel.threshold ||
    decoded.panel_size !== panel.keys.length
  )
    return "other-panel";
  if (!equal(electionStubV5Hash(decoded), stubHash)) return "refused";
  const election = {
    l2ChainId: decoded.l2_chain_id,
    trusteeRegistry: decoded.trustee_registry,
    electionId: decoded.election_id,
    stubHash,
    panel,
  };
  const check = checkCeremonyTranscript(election, approved.transcript, 1);
  if (
    !check.ok ||
    !equal(check.hash, approved.transcriptHash) ||
    check.registered.length < quorum(panel)
  )
    return "refused";
  const keySet = check.registered.map(keySetEntry);
  if (!equal(keySetHash(keySet), approved.keySetHash)) return "refused";
  const seats = approved.approvals.map((a) => a.seat);
  if (
    seats.length < quorum(panel) ||
    seats.some((s) => !Number.isSafeInteger(s) || s < 1 || s > panel.keys.length) ||
    seats.some((s, i) => i > 0 && s <= seats[i - 1]!)
  )
    return "refused";
  for (const a of approved.approvals)
    if (
      !verifyCeremonyRegistration(
        panel,
        {
          l2ChainId: election.l2ChainId,
          trusteeRegistry: election.trusteeRegistry,
          index: a.seat,
          stubHash,
          ceremonyTranscriptHash: check.hash,
          keySetHash: approved.keySetHash,
        },
        a.signature,
      )
    )
      return "refused";
  const definition: ElectionDefinitionV5 = { ...decoded, ceremony_transcript_hash: check.hash };
  if (
    electionDefinitionV5Rule(definition) !== undefined ||
    profileCombinationRule(definition) !== undefined ||
    !equal(electionStubV5Hash(definition), stubHash)
  )
    return "refused";
  return {
    definition: encodeElectionDefinitionV5(definition),
    definitionHash: electionDefinitionV5Hash(definition),
    record: encodeCeremonyRegistration({
      panelId: decoded.panel_id,
      stubHash,
      ceremonyTranscriptHash: check.hash,
      keySet,
      approvals: approved.approvals.map((a) => ({ index: a.seat, signature: a.signature })),
    }),
  };
}

/**
 * One run of the registration step for `chain`'s key, under the default
 * panel `panel`: sends again every recorded transaction of the key not yet
 * included, moves each poll whose registration finalized (to `registered`,
 * or `failed` if it reverted, its nonce went to another transaction or its
 * event isn't the poll's), fails those past the deadline, then signs,
 * records and sends the two registrations of each poll in `ceremony` whose
 * stub has an approved run, oldest first, while its `opens_at` is more than
 * `REGISTRATION_MARGIN_SECONDS` away. Each step is safe to rerun after a
 * crash at any point.
 */
export async function advancePollRegistrations(
  client: Sql,
  chain: PollRegistrationChain,
  panel: Panel,
  options: PollRegistrationOptions,
): Promise<PollRegistrationReport> {
  if (chain.creator.length !== 20) throw new RangeError("the creator must be a 20-byte address");
  // Throws on a panel that isn't one, before anything is read.
  panelId(panel);
  const deadline = options.deadlineMs ?? REGISTRATION_DEADLINE_MS;
  const { now } = options;
  const db = drizzle({ client });
  const creator = chain.creator.slice();
  const report: PollRegistrationReport = {
    sent: 0,
    resent: 0,
    sendFailed: 0,
    registered: 0,
    waiting: 0,
    late: 0,
    mismatched: 0,
    failed: {},
  };
  const fail = async (id: string, stubHash: Uint8Array, failure: RegistrationFailure) => {
    // Only from `ceremony` with the stub it was judged under: a poll another
    // run already moved keeps its state.
    const moved = await db
      .update(accountPolls)
      .set({ state: "failed", failure, updatedAt: now })
      .where(
        and(
          eq(accountPolls.id, id),
          eq(accountPolls.state, "ceremony"),
          eq(accountPolls.stubHash, stubHash),
        ),
      )
      .returning({ id: accountPolls.id });
    if (moved.length > 0) report.failed[failure] = (report.failed[failure] ?? 0) + 1;
  };
  const send = async (tx: Uint8Array) => {
    try {
      await chain.broadcast(tx);
      return true;
    } catch {
      // The node's answer can quote the transaction; the count is enough,
      // and the record makes the next run send it again.
      report.sendFailed++;
      return false;
    }
  };

  // 1. Every recorded transaction of this key the node hasn't included,
  // creations and registrations alike.
  const nonces = await chain.nonces();
  for (const tx of await unincluded(client, creator, nonces.latest))
    if (await send(tx)) report.resent++;

  // 2. Each poll in `ceremony` with a recorded registration: whether it
  // finalized, and as what.
  const recorded = await db
    .select({
      id: accountPolls.id,
      electionId: accountPolls.electionId,
      stubHash: accountPolls.stubHash,
      hash: pollCreationTxs.txHash,
      nonce: pollCreationTxs.nonce,
      sentAt: pollCreationTxs.sentAt,
    })
    .from(accountPolls)
    .leftJoin(pollCreationTxs, eq(pollCreationTxs.txHash, accountPolls.registerTxHash))
    .where(
      and(
        eq(accountPolls.state, "ceremony"),
        eq(accountPolls.creatorAddress, creator),
        isNotNull(accountPolls.registerTxHash),
      ),
    )
    .orderBy(asc(pollCreationTxs.nonce));
  for (const r of recorded) {
    // The table holds both on every poll in `ceremony`.
    const stubHash = r.stubHash as Uint8Array;
    const electionId = r.electionId as Uint8Array;
    // A registration missing from the ledger (a partial wipe by hand) can't
    // be followed: failed, so it doesn't sit in setup for good.
    if (r.hash === null || r.nonce === null || r.sentAt === null) {
      await fail(r.id, stubHash, "registration-timeout");
      continue;
    }
    const late = now.getTime() - r.sentAt.getTime() > deadline;
    if (r.nonce >= nonces.latest) {
      if (late) await fail(r.id, stubHash, "registration-timeout");
      continue;
    }
    const status = await chain.registration(r.hash);
    if (status.state === "registered") {
      // What the registry admitted must be what this step built: the
      // approved run's definition for this poll's election (T-34).
      const approved = await approvedCeremony(client, stubHash);
      const [stub] = await db
        .select({ stub: ceremonyStubs.stub })
        .from(ceremonyStubs)
        .where(eq(ceremonyStubs.stubHash, stubHash));
      const built =
        approved === undefined || stub === undefined
          ? undefined
          : pollRegistration(stub.stub, stubHash, panel, approved);
      if (
        typeof built !== "object" ||
        !equal(status.electionId, electionId) ||
        !equal(status.definitionHash, built.definitionHash)
      ) {
        await fail(r.id, stubHash, "registration-mismatch");
        continue;
      }
      if (status.block < 0n) throw new Error("the chain gave a malformed block");
      const moved = await db
        .update(accountPolls)
        .set({ state: "registered", registeredBlock: status.block, updatedAt: now })
        .where(
          and(
            eq(accountPolls.id, r.id),
            eq(accountPolls.state, "ceremony"),
            eq(accountPolls.stubHash, stubHash),
          ),
        )
        .returning({ id: accountPolls.id });
      report.registered += moved.length;
    } else if (status.state === "reverted") await fail(r.id, stubHash, "registration-reverted");
    // The node knows nothing of the transaction, and its nonce is spent in
    // finalized history: another transaction of the key took it.
    else if (status.state === "unknown" && r.nonce < nonces.finalized)
      await fail(r.id, stubHash, "registration-replaced");
    else if (late) await fail(r.id, stubHash, "registration-timeout");
  }

  // 3. New registrations, for each poll whose stub has an approved run,
  // oldest stub first.
  const waiting = await db
    .select({
      id: accountPolls.id,
      stubHash: ceremonyStubs.stubHash,
      stub: ceremonyStubs.stub,
      opensAt: ceremonyStubs.opensAt,
    })
    .from(accountPolls)
    .innerJoin(ceremonyStubs, eq(ceremonyStubs.stubHash, accountPolls.stubHash))
    .where(
      and(
        eq(accountPolls.state, "ceremony"),
        eq(accountPolls.creatorAddress, creator),
        isNull(accountPolls.registerTxHash),
      ),
    )
    .orderBy(asc(ceremonyStubs.createdAt), asc(accountPolls.id));
  const seconds = BigInt(Math.floor(now.getTime() / 1000));
  let signedThisRun = 0;
  for (const w of waiting) {
    if (signedThisRun >= REGISTRATIONS_PER_RUN) break;
    const approved = await approvedCeremony(client, w.stubHash);
    if (approved === undefined) {
      report.waiting++;
      continue;
    }
    if (seconds + BigInt(REGISTRATION_MARGIN_SECONDS) >= w.opensAt) {
      report.late++;
      continue;
    }
    const built = pollRegistration(w.stub, w.stubHash, panel, approved);
    if (built === "other-panel") {
      report.mismatched++;
      continue;
    }
    if (built === "refused") {
      await fail(w.id, w.stubHash, "registration-refused");
      continue;
    }
    const signed = await db.transaction(async (tx) => {
      await lockSigning(tx);
      const [row] = await tx
        .select({
          state: accountPolls.state,
          stubHash: accountPolls.stubHash,
          recorded: accountPolls.registerTxHash,
        })
        .from(accountPolls)
        .where(eq(accountPolls.id, w.id))
        .for("update");
      if (
        row === undefined ||
        row.state !== "ceremony" ||
        row.recorded !== null ||
        row.stubHash === null ||
        !equal(row.stubHash, w.stubHash)
      )
        return undefined;
      const nonce = await nextNonce(tx, chain);
      const ceremony = await chain.signCeremony(nonce, built.record);
      const definition = await chain.signDefinition(nonce + 1n, built.definition);
      for (const t of [ceremony, definition])
        if (t.hash.length !== 32 || t.tx.length === 0)
          throw new Error("the chain signed a malformed registration");
      await tx.insert(pollCreationTxs).values([
        {
          creatorAddress: creator,
          nonce,
          tx: ceremony.tx.slice(),
          txHash: ceremony.hash.slice(),
          sentAt: now,
          kind: "register-ceremony",
        },
        {
          creatorAddress: creator,
          nonce: nonce + 1n,
          tx: definition.tx.slice(),
          txHash: definition.hash.slice(),
          sentAt: now,
          kind: "register-definition",
        },
      ]);
      await tx
        .update(accountPolls)
        .set({
          ceremonyTxHash: ceremony.hash.slice(),
          registerTxHash: definition.hash.slice(),
          updatedAt: now,
        })
        .where(eq(accountPolls.id, w.id));
      return [ceremony, definition] as const;
    });
    if (signed === undefined) continue;
    signedThisRun++;
    // Committed: only now are they sent (rule 12), the ceremony's first.
    const [ceremony, definition] = signed;
    if ((await send(ceremony.tx)) && (await send(definition.tx))) report.sent++;
  }
  return report;
}
