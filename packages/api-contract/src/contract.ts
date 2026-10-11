import { oc } from "@orpc/contract";
import * as z from "zod/mini";

import {
  Hash32,
  hexBytes,
  MAX_BOARD_ENTRY,
  MAX_BOARD_PAYLOAD,
  MAX_PAGE,
  MAX_PAGE_BYTES,
  MAX_PROOF_PATH,
  PageSize,
  U64,
} from "./wire.ts";

// The public API (apps/api) as a contract: what the ballot client, the SDK,
// the CLI and third parties may call. Every answer is a claim by our server,
// never a source of truth: each response carries canonical bytes that the
// caller checks itself with `@abolishus/crypto` against the chain and the
// anchored checkpoints (T-23, T-24, T-34). Nothing here names an account,
// a session or a voter, so no procedure can tie a ballot to a person (T-10),
// and no field carries a plaintext vote (T-09).

/** Error codes from docs/spec/ (`truncated`, `non-canonical`, …) and the verifier's admission checks. */
const ErrorCode = z.string().check(z.regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), z.maxLength(64));

// No route has path parameters. oRPC's compact input merges a request's query
// or body over its path parameters, so a field in both places would let the
// URL name one election while the handler serves another (T-31). Every input
// comes from the query (GET) or the body (POST) alone.
const ElectionQuery = z.strictObject({ electionId: Hash32 });

const electionNotFound = {
  ELECTION_NOT_FOUND: { status: 404, message: "No election with this id is known to this server." },
} as const;

const outOfRange = {
  OUT_OF_RANGE: {
    status: 416,
    message: "The requested positions are beyond the board this server holds.",
  },
} as const;

const getDefinition = oc
  .route({
    method: "GET",
    path: "/elections/definition",
    summary: "An election's definition record",
    description:
      "The election definition (record 0x0001) as registered. Callers hash it and compare the hash with the election registry on the L2 before using it (T-34).",
    tags: ["elections"],
  })
  .errors(electionNotFound)
  .input(ElectionQuery)
  .output(z.strictObject({ definition: hexBytes(MAX_BOARD_PAYLOAD) }));

const getHead = oc
  .route({
    method: "GET",
    path: "/board/head",
    summary: "The board's current size, chain head and tree root",
    description:
      "Unanchored until the checkpoint that covers it is on L1. Callers check later heads against it with a consistency proof (T-24). An empty board has no chain head or root (docs/spec/board.md never hashes an empty tree): it answers `treeSize` 0 with `chainHead` and `root` all zeros, which a client never checks anything against.",
    tags: ["board"],
  })
  .errors(electionNotFound)
  .input(ElectionQuery)
  .output(z.strictObject({ treeSize: U64, chainHead: Hash32, root: Hash32 }));

const getEntries = oc
  .route({
    method: "GET",
    path: "/board/entries",
    summary: "A page of board entries",
    description: `Encoded board entries (record 0x0007) from position \`start\`, in order: at most \`limit\`, and at most ${MAX_PAGE_BYTES} bytes of entries unless the page holds one entry. Fewer than \`limit\` entries is not the end of the board; an empty page (\`start\` equal to the board's size) is, and a \`start\` beyond it is \`OUT_OF_RANGE\`.`,
    tags: ["board"],
  })
  .errors({ ...electionNotFound, ...outOfRange })
  .input(z.strictObject({ electionId: Hash32, start: U64, limit: PageSize }))
  .output(
    z.strictObject({
      entries: z.array(hexBytes(MAX_BOARD_ENTRY)).check(
        // T-52: a page is bounded by bytes as well as by count.
        z.maxLength(MAX_PAGE),
        z.refine(
          (entries) =>
            entries.length <= 1 || entries.reduce((n, e) => n + e.length / 2, 0) <= MAX_PAGE_BYTES,
          `a page of more than one entry exceeds ${MAX_PAGE_BYTES} bytes`,
        ),
      ),
    }),
  );

const ProofPath = z.strictObject({
  path: z.array(Hash32).check(z.maxLength(MAX_PROOF_PATH)),
});

const getInclusionProof = oc
  .route({
    method: "GET",
    path: "/board/proofs/inclusion",
    summary: "An inclusion proof for one entry",
    description:
      "RFC 9162 audit path for entry `index` in the tree of the first `treeSize` entries, under the board's tagged hashes (docs/spec/board.md).",
    tags: ["board"],
  })
  .errors({ ...electionNotFound, ...outOfRange })
  .input(z.strictObject({ electionId: Hash32, index: U64, treeSize: U64 }))
  .output(ProofPath);

const getConsistencyProof = oc
  .route({
    method: "GET",
    path: "/board/proofs/consistency",
    summary: "A consistency proof between two tree sizes",
    description:
      "RFC 9162 consistency proof that the tree of `secondSize` entries extends the tree of `firstSize` entries (docs/spec/board.md).",
    tags: ["board"],
  })
  .errors({ ...electionNotFound, ...outOfRange })
  .input(z.strictObject({ electionId: Hash32, firstSize: U64, secondSize: U64 }))
  .output(ProofPath);

const submitBallot = oc
  .route({
    method: "POST",
    path: "/ballots",
    successStatus: 201,
    summary: "Cast or challenge a ballot",
    description:
      "Appends one ballot record (0x0002) to the board. Needs no account or session: the server must not learn who cast it (T-10). Returns the board entry that carries it and the chain link after it. The caller checks that the entry names this election and carries exactly the submitted bytes, then keeps both as its receipt and checks them against an anchored checkpoint. If this server refuses, the same record can be submitted to the contracts directly (T-25).",
    tags: ["ballots"],
  })
  .errors({
    ...electionNotFound,
    ELECTION_NOT_OPEN: { status: 409, message: "The election is not accepting ballots." },
    BALLOT_REJECTED: {
      status: 422,
      message: "The ballot failed decoding or an admission check.",
      data: z.strictObject({ code: ErrorCode }),
    },
    RATE_LIMITED: { status: 429, message: "Too many requests; retry later." },
  })
  .input(z.strictObject({ electionId: Hash32, ballot: hexBytes(MAX_BOARD_PAYLOAD) }))
  .output(z.strictObject({ entry: hexBytes(MAX_BOARD_ENTRY), link: Hash32 }));

// Moderation (docs/moderation-policy.md; T-68). The log is public, so anyone
// can see what we did to a poll's display text and why; it never names the
// moderator or a reporter. Moderation never reaches a result: these routes
// read the log and count reports, nothing else.

/** The policy's removal grounds; a test ties this copy to `@abolishus/core`. */
export const REMOVAL_REASONS = [
  "illegal",
  "personal-data",
  "threat",
  "harassment",
  "spam",
  "impersonation",
  "legal-notice",
] as const;
/** The policy's grounds for restoring; a test ties this copy to `@abolishus/core`. */
export const RESTORE_REASONS = ["appeal-upheld", "error", "notice-withdrawn"] as const;

const ModerationAction = z.enum(["delist", "hide", "restore"]);
const ModerationReason = z.enum([...REMOVAL_REASONS, ...RESTORE_REASONS]);
/** When a decision was recorded, by the database clock: UTC, to the millisecond. */
const Timestamp = z.iso.datetime({ precision: 3 });

const getModerationLog = oc
  .route({
    method: "GET",
    path: "/moderation/log",
    summary: "A page of the public moderation log",
    description:
      "Moderation decisions with a sequence number above `after`, oldest first: at most `limit`. Fewer than `limit` entries means the log ends there for now. Sequence numbers increase but may skip. Each decision delists a poll, hides its display text or restores it, under one of the policy's reason codes; none of them touches a poll's board, definition or result (docs/moderation-policy.md).",
    tags: ["moderation"],
  })
  .input(z.strictObject({ after: U64, limit: PageSize }))
  .output(
    z.strictObject({
      entries: z
        .array(
          z.strictObject({
            seq: U64,
            electionId: Hash32,
            action: ModerationAction,
            reason: ModerationReason,
            decidedAt: Timestamp,
          }),
        )
        .check(z.maxLength(MAX_PAGE)),
    }),
  );

const getModerationStatus = oc
  .route({
    method: "GET",
    path: "/moderation/status",
    summary: "A poll's moderation state",
    description:
      "`visible`, `delisted` (left out of discovery and search) or `hidden` (display text withheld; the result is still shown by option number), with the newest decision if there is one. A poll never moderated is `visible` with no `latest`.",
    tags: ["moderation"],
  })
  .errors(electionNotFound)
  .input(ElectionQuery)
  .output(
    z.strictObject({
      state: z.enum(["visible", "delisted", "hidden"]),
      latest: z.optional(
        z.strictObject({
          seq: U64,
          action: ModerationAction,
          reason: ModerationReason,
          decidedAt: Timestamp,
        }),
      ),
    }),
  );

const reportPoll = oc
  .route({
    method: "POST",
    path: "/moderation/reports",
    successStatus: 202,
    summary: "Report a poll to the moderators",
    description:
      "Counts one report of the poll under one of the policy's removal grounds. Needs no account: the server keeps the poll and the ground and nothing about who reported it. A moderator judges the poll against the policy; the number of reports is never a ground (docs/moderation-policy.md, Reports).",
    tags: ["moderation"],
  })
  .errors(electionNotFound)
  .input(z.strictObject({ electionId: Hash32, reason: z.enum(REMOVAL_REASONS) }))
  .output(z.strictObject({}));

/** The public API contract. `apps/api` implements it; clients call it. */
export const contract = {
  elections: { getDefinition },
  board: { getHead, getEntries, getInclusionProof, getConsistencyProof },
  ballots: { submit: submitBallot },
  moderation: { getLog: getModerationLog, getStatus: getModerationStatus, report: reportPoll },
};

export type Contract = typeof contract;
