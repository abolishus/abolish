import { contract, MAX_PAGE_BYTES } from "@abolishus/api-contract";
import {
  BoardReadError,
  deleteIdentityBackup,
  hasDefinition,
  IdentityBackupStoreError,
  listPolls,
  lookupShortCode,
  ModerationError,
  moderationStatus,
  putIdentityBackup,
  readConsistencyProof,
  readDefinition,
  readEntries,
  readHead,
  readIdentityBackup,
  readInclusionProof,
  readModerationLog,
  report,
} from "@abolishus/core";
import { implement, ORPCError } from "@orpc/server";
import type { Sql } from "postgres";

// The contract's procedures (packages/api-contract). Each handler parses its
// already-validated input into bytes, calls core and serialises the answer:
// no protocol logic lives here (AGENTS.md, Architecture). Every answer is a
// claim the caller checks with @abolishus/crypto (T-23, T-24, T-34).
//
// The context holds the database and nothing else: no handler can see a
// request's headers, cookies or address, so no procedure can tie what it
// serves or receives to a person or session (T-10, T-11).

export interface Context {
  readonly sql: Sql;
}

const os = implement(contract).$context<Context>();

const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const ZERO_HASH = "00".repeat(32);

/** The board's position errors, as the contract names them. */
function boardError(e: unknown, outOfRange: () => Error): never {
  if (e instanceof BoardReadError) {
    if (e.code === "beyond-board") throw outOfRange();
    throw new ORPCError("BAD_REQUEST", { message: "No tree of these sizes has these positions." });
  }
  throw e;
}

/** Board procedures answer only for elections whose definition this server holds. */
async function knownElection(sql: Sql, electionId: string, notFound: () => Error) {
  const id = fromHex(electionId);
  if (!(await hasDefinition(sql, id))) throw notFound();
  return id;
}

export const router = os.router({
  elections: {
    // Discovery leaves out delisted and hidden polls (docs/moderation-policy.md; T-68).
    list: os.elections.list.handler(async ({ input, context }) => {
      const after = input.after === undefined ? undefined : fromHex(input.after);
      const elections = await listPolls(context.sql, after, Number(input.limit));
      return { elections: elections.map(toHex) };
    }),
    getDefinition: os.elections.getDefinition.handler(async ({ input, context, errors }) => {
      const definition = await readDefinition(context.sql, fromHex(input.electionId));
      if (definition === undefined) throw errors.ELECTION_NOT_FOUND();
      return { definition: toHex(definition) };
    }),
    // Short links (docs/design/sharing.md). A refusal never quotes the input,
    // and the request log records only the route (T-11, T-67).
    resolveCode: os.elections.resolveCode.handler(async ({ input, context, errors }) => {
      const match = await lookupShortCode(context.sql, input.code);
      if (match === undefined) throw errors.CODE_NOT_FOUND();
      return { electionId: toHex(match.electionId), code: match.code };
    }),
  },
  board: {
    getHead: os.board.getHead.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      const head = await readHead(context.sql, id);
      // An empty board has no chain head or root (docs/spec/board.md never
      // hashes an empty tree): size 0 comes with zeros, which no client checks
      // anything against.
      return {
        treeSize: head.size.toString(),
        chainHead: head.head === undefined ? ZERO_HASH : toHex(head.head),
        root: head.root === undefined ? ZERO_HASH : toHex(head.root),
      };
    }),
    getEntries: os.board.getEntries.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      const entries = await readEntries(
        context.sql,
        id,
        BigInt(input.start),
        Number(input.limit),
        MAX_PAGE_BYTES,
      ).catch((e: unknown) => boardError(e, errors.OUT_OF_RANGE));
      return { entries: entries.map(toHex) };
    }),
    getInclusionProof: os.board.getInclusionProof.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      const path = await readInclusionProof(
        context.sql,
        id,
        BigInt(input.index),
        BigInt(input.treeSize),
      ).catch((e: unknown) => boardError(e, errors.OUT_OF_RANGE));
      return { path: path.map(toHex) };
    }),
    getConsistencyProof: os.board.getConsistencyProof.handler(
      async ({ input, context, errors }) => {
        const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
        const path = await readConsistencyProof(
          context.sql,
          id,
          BigInt(input.firstSize),
          BigInt(input.secondSize),
        ).catch((e: unknown) => boardError(e, errors.OUT_OF_RANGE));
        return { path: path.map(toHex) };
      },
    ),
  },
  ballots: {
    // Admission (strict decoding, the membership and validity proofs, the
    // L1 reference and the poll window, verifier 5.x) isn't built yet, so
    // this server boards no ballot: it fails closed rather than board one it
    // hasn't checked (T-17, T-52, T-53). A voter can still submit directly to
    // the contracts once direct submit exists (T-25). P2-3 part 2.
    submit: os.ballots.submit.handler(async ({ input, context, errors }) => {
      await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      throw errors.ELECTION_NOT_OPEN();
    }),
  },
  // The public moderation log, a poll's state, and reports
  // (docs/moderation-policy.md; T-68). Nothing here names a moderator or a
  // reporter, and a report reaches no one but the moderators' queue.
  moderation: {
    getLog: os.moderation.getLog.handler(async ({ input, context }) => {
      const entries = await readModerationLog(
        context.sql,
        BigInt(input.after),
        Number(input.limit),
      );
      return {
        entries: entries.map((e) => ({
          seq: e.seq.toString(),
          electionId: toHex(e.electionId),
          action: e.action,
          reason: e.reason,
          decidedAt: e.decidedAt.toISOString(),
        })),
      };
    }),
    getStatus: os.moderation.getStatus.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      const { state, latest } = await moderationStatus(context.sql, id);
      if (latest === undefined) return { state };
      return {
        state,
        latest: {
          seq: latest.seq.toString(),
          action: latest.action,
          reason: latest.reason,
          decidedAt: latest.decidedAt.toISOString(),
        },
      };
    }),
    report: os.moderation.report.handler(async ({ input, context, errors }) => {
      await report(context.sql, fromHex(input.electionId), input.reason).catch((e: unknown) => {
        if (e instanceof ModerationError && e.code === "unknown-election")
          throw errors.ELECTION_NOT_FOUND();
        throw e;
      });
      return {};
    }),
  },
  // Identity backups (ADR 0017, option A, step 5): the envelope is stored,
  // served and deleted by locator, which core hashes before it reaches the
  // table. Like every route, these see no header, cookie or address (T-10).
  backups: {
    put: os.backups.put.handler(async ({ input, context, errors }) => {
      await putIdentityBackup(context.sql, fromHex(input.locator), fromHex(input.envelope)).catch(
        (e: unknown) => {
          if (e instanceof IdentityBackupStoreError)
            throw errors.BACKUP_REJECTED({ data: { code: e.code } });
          throw e;
        },
      );
      return {};
    }),
    fetch: os.backups.fetch.handler(async ({ input, context, errors }) => {
      const envelope = await readIdentityBackup(context.sql, fromHex(input.locator));
      if (envelope === undefined) throw errors.BACKUP_NOT_FOUND();
      return { envelope: toHex(envelope) };
    }),
    delete: os.backups.delete.handler(async ({ input, context, errors }) => {
      if (!(await deleteIdentityBackup(context.sql, fromHex(input.locator))))
        throw errors.BACKUP_NOT_FOUND();
      return {};
    }),
  },
});
