import { oc } from "@orpc/contract";
import * as z from "zod/mini";

import {
  Hash32,
  hexBytes,
  hexFixed,
  IDENTITY_BACKUP_ENVELOPE,
  IDENTITY_BACKUP_RETENTION_MONTHS,
  IdentityBackupEnvelope,
  IdentityBackupLocator,
  MAX_BOARD_ENTRY,
  MAX_BOARD_PAYLOAD,
  MAX_DISPLAY_TEXT,
  MAX_PAGE,
  MAX_PAGE_BYTES,
  MAX_PROOF_PATH,
  PageSize,
  RegionCode,
  TurnstileResponse,
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

const getDisplayText = oc
  .route({
    method: "GET",
    path: "/elections/display-text",
    summary: "An election's display text",
    description:
      "The display-text record (0x0009) the election's definition commits to: its question, options and translations. Callers check it against the commitment in the definition whose hash the election registry on the L2 holds, and against the spec's rules, before showing it (docs/spec/display-text.md, Checks; T-34, T-41). Moderation decides what is served (docs/moderation-policy.md): a hidden poll's text is withheld, except while a poll hidden as a threat is still open.",
    tags: ["elections"],
  })
  .errors({
    ...electionNotFound,
    DISPLAY_TEXT_NOT_FOUND: {
      status: 404,
      message: "This server holds no display text for this election.",
    },
    DISPLAY_TEXT_WITHHELD: {
      status: 451,
      message:
        "This poll's text is withheld under the moderation policy; see GET /moderation/status.",
    },
  })
  .input(ElectionQuery)
  .output(z.strictObject({ displayText: hexBytes(MAX_DISPLAY_TEXT) }));

const listElections = oc
  .route({
    method: "GET",
    path: "/elections",
    summary: "A page of the polls this server lists",
    description:
      "Election IDs of the polls our front ends list for discovery: at most `limit`, after the poll `after` in the order `sort` names (or from the first without it). Fewer than `limit` means the listing ends there for now. `id`, the default, lists every listed poll, open or closed, in ascending order of election ID, and `after` need not name a poll. `new` lists the polls open now (the definition's `opens_at` at or before the server's clock and `closes_at` after it), the latest registered on L2 first; `closing` lists the polls open now, the soonest `closes_at` first, then by election ID. Both orders are public chain data, the same for everyone and moved by nothing a voter or an account does. `answered` lists the polls open now, the most answered this week first, then by election ID: the count is of distinct voters (each tier and nullifier once, so a re-vote never counts twice) whose ballots this server boarded in the whole anchoring periods of the last seven days before the current one (direct-submitted ballots aren't counted yet), so it settles once a period and anyone can recompute it from the public board, whose entries carry their segments; it needs the anchoring clock, without which it is `SORT_UNAVAILABLE`. Under these three orders `after` must be a poll the order can place, one stored here and, for `new`, with its registration recorded, though it may have closed since (`CURSOR_NOT_FOUND` otherwise); under `answered` a poll whose count passes the cursor's between pages can be skipped or repeated. A poll that is delisted or hidden (docs/moderation-policy.md) is left out, though its definition, board and moderation state stay served by ID. The listing is a convenience, never a source of truth: the election registry on the L2 names every poll, and callers check each definition against it (T-34, T-68).",
    tags: ["elections"],
  })
  .errors({
    CURSOR_NOT_FOUND: {
      status: 400,
      message: "`after` names no poll this order can place.",
    },
    SORT_UNAVAILABLE: { status: 503, message: "This order is unavailable here for now." },
  })
  .input(
    z.strictObject({
      after: z.optional(Hash32),
      limit: PageSize,
      sort: z.optional(z.enum(["id", "new", "closing", "answered"])),
    }),
  )
  .output(z.strictObject({ elections: z.array(Hash32).check(z.maxLength(MAX_PAGE)) }));

/** The longest short code (docs/design/sharing.md); a test ties this copy to `@abolishus/core`. */
export const MAX_SHORT_CODE_LENGTH = 52;

/** The most characters of input `elections.resolveCode` reads as a possible code. */
const MAX_CODE_INPUT = 64;

/** A short code in its canonical form: lower-case Crockford base32, 7 to 52 characters. */
const ShortCode = z
  .string()
  .check(z.regex(new RegExp(`^[0-9a-hjkmnp-tv-z]{7,${MAX_SHORT_CODE_LENGTH}}$`)));

const resolveCode = oc
  .route({
    method: "GET",
    path: "/elections/by-code",
    summary: "The poll a short code names",
    description: `The election ID of the poll that owns \`code\`, and the code in its canonical form. A code is a prefix of a poll's definition hash in lower-case Crockford base32 (docs/design/sharing.md, Short links): input is case-insensitive, with \`o\` read as \`0\` and \`i\` and \`l\` as \`1\`. Among registered polls in registration order, the earliest whose hash has a 7-character prefix owns it, and a later poll whose prefix is taken gets one more character than it shares with any earlier poll, so a code never moves to a later poll. Anything that isn't a code (up to ${MAX_CODE_INPUT} characters; longer input is a \`BAD_REQUEST\`), and any code no poll owns, is \`CODE_NOT_FOUND\`, which never quotes the input. Delisted and hidden polls resolve as they do by ID. The answer is a claim: anyone can recompute it from the election registry's events, and callers check the definition they then fetch against the registry (T-34, T-49).`,
    tags: ["elections"],
  })
  .errors({ CODE_NOT_FOUND: { status: 404, message: "No poll owns this code." } })
  // A transport bound only: what isn't a code within it is CODE_NOT_FOUND (T-52).
  .input(z.strictObject({ code: z.string().check(z.maxLength(MAX_CODE_INPUT, { abort: true })) }))
  .output(z.strictObject({ electionId: Hash32, code: ShortCode }));

const getCode = oc
  .route({
    method: "GET",
    path: "/elections/code",
    summary: "A poll's short code",
    description: `The canonical short code of the poll registered as \`electionId\`: the code \`elections.resolveCode\` resolves to it, the shortest prefix of its definition hash, at least 7 characters, that no poll registered before it shares (docs/design/sharing.md, Short links). \`CODE_NOT_FOUND\` if no registration is recorded for the election, since a code resolves only through one. Delisted and hidden polls keep their codes. The answer is a claim: a caller checks that the code is a prefix of the definition hash it checked against the registry (T-34), and which poll owns a shared prefix is the registry's order, which anyone can recompute from its events (T-49).`,
    tags: ["elections"],
  })
  .errors({
    CODE_NOT_FOUND: { status: 404, message: "No registration is recorded for this election." },
  })
  .input(ElectionQuery)
  .output(z.strictObject({ code: ShortCode }));

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
    // The ballot may still be boarded: the same bytes again return its entry.
    BALLOTS_UNAVAILABLE: {
      status: 503,
      message: "The ballot couldn't be judged in time; submit the same bytes again.",
    },
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

// Voting-identity recovery backups (ADR 0017, option A, step 5;
// docs/spec/identity-backup.md). The ballot client stores the envelope that
// seals its identity secret under a locator derived from its backup
// passkey's PRF output. Every route is a POST, so the locator, which lets its
// holder read, replace or delete the envelope, travels in the body and never
// in a URL a proxy or cache could keep. Like the ballot path, these need no
// account and refuse one (T-10, T-20); bodies have a fixed size (T-52).

const Locator = z.strictObject({ locator: IdentityBackupLocator });

const backupNotFound = {
  BACKUP_NOT_FOUND: { status: 404, message: "No backup is stored under this locator." },
} as const;

const putBackup = oc
  .route({
    method: "POST",
    path: "/backups",
    summary: "Store an identity backup",
    description: `Stores a version-1 envelope (record 0x000a, ${IDENTITY_BACKUP_ENVELOPE} bytes) under \`locator\`, replacing any envelope there. The server keeps it under a hash of the locator, never the locator, and can't open it. A backup not written for ${IDENTITY_BACKUP_RETENTION_MONTHS} whole months after the month of its last write is deleted; reads don't extend it, so a client rewrites its envelope to keep it.`,
    tags: ["backups"],
  })
  .errors({
    BACKUP_REJECTED: {
      status: 422,
      message: "The envelope doesn't decode strictly as a version-1 identity backup.",
      data: z.strictObject({ code: ErrorCode }),
    },
  })
  .input(z.strictObject({ locator: IdentityBackupLocator, envelope: IdentityBackupEnvelope }))
  .output(z.strictObject({}));

const fetchBackup = oc
  .route({
    method: "POST",
    path: "/backups/fetch",
    summary: "Fetch an identity backup",
    description:
      "The envelope stored under `locator`. A POST, so the locator never sits in a URL. The client opens it with its PRF output and checks the recovered identity's commitment against the tier groups it downloads in full (docs/spec/identity-backup.md, Opening). The server can return an older envelope sealed under the same passkey, or none: envelopes carry no freshness.",
    tags: ["backups"],
  })
  .errors(backupNotFound)
  .input(Locator)
  .output(z.strictObject({ envelope: IdentityBackupEnvelope }));

const deleteBackup = oc
  .route({
    method: "POST",
    path: "/backups/delete",
    summary: "Delete an identity backup",
    description: "Deletes the envelope stored under `locator`.",
    tags: ["backups"],
  })
  .errors(backupNotFound)
  .input(Locator)
  .output(z.strictObject({}));

// Tier 0 registration (docs/spec/registration.md; ADR 0024, option B). The
// ballot client sends its identity commitment, the region it asks for and a
// Turnstile token from the challenge page, all in the body, so no procedure
// reads a header (T-10). Every accepted request gets the same empty answer,
// whether the commitment is newly queued, already queued, in flight or
// already a member, so the route never says whether a commitment waits
// (T-13); the client learns the outcome from the chain alone (T-11).

const registerTier0 = oc
  .route({
    method: "POST",
    path: "/registrations/tier0",
    summary: "Ask for a Tier 0 registration",
    description:
      "Queues `commitment` (an identity commitment, a field<bn254> as 32 bytes of big-endian hex) for the published Tier 0 group of `region`, paid for by one Turnstile solve on the challenge page for the action `tier0-register`. Checked in order: the forms; a commitment below r and not forbidden (0, 1, Poseidon2(0, 1)); a region with a published group; room in the group's queue; a current Tier 0 index; then the token, so a malformed or unserviceable request never spends it. The answer is the same empty object whether the commitment is newly queued, already queued, in a batch or already a member. The service signs queued commitments into one batch per group at each 10-minute boundary, sorted by value; the client reads the group's records on the L2 to learn whether, and where, its commitment was added, and may send the request again (with a new solve) if it isn't added after about 80 minutes plus L2 finality.",
    tags: ["registrations"],
  })
  .errors({
    REGISTRATION_MALFORMED: {
      status: 422,
      message: "The commitment isn't a canonical field element, or is a forbidden value.",
      data: z.strictObject({ code: ErrorCode }),
    },
    REGION_UNKNOWN: { status: 422, message: "The region has no published Tier 0 group." },
    REGISTRATION_BUSY: {
      status: 503,
      message: "The group's queue is full; try again after the next batch.",
    },
    REGISTRATION_UNAVAILABLE: {
      status: 503,
      message: "Registration is unavailable here for now.",
    },
    CHALLENGE_REFUSED: {
      status: 403,
      message: "The Turnstile token was refused: spent, expired, or for another site or action.",
    },
    CHALLENGE_UNAVAILABLE: {
      status: 503,
      message: "The Turnstile token couldn't be checked; try again with a new one.",
    },
  })
  .input(z.strictObject({ commitment: Hash32, region: RegionCode, turnstile: TurnstileResponse }))
  .output(z.strictObject({}));

// The Tier 1 relay (docs/spec/tier1-relay.md). The ballot client sends a
// vouchee's Tier 1 addition record and a Turnstile token from the challenge
// page, both in the body (T-10). The route checks the record alone, never
// whether it counts, and every accepted request gets the same empty answer,
// whether the record is newly queued, already queued, or can never count,
// so the route says nothing about any commitment or slot (T-13, T-22); the
// client learns the outcome from the chain alone (T-11).

/** A Tier 1 addition record's length in bytes: `41 + 626 · VOUCH_K` (docs/spec/vouching.md). */
const TIER1_ADDITION_RECORD = 1919;

const relayTier1 = oc
  .route({
    method: "POST",
    path: "/registrations/tier1",
    summary: "Ask the relay to send a Tier 1 addition",
    description:
      "Queues `record` (a Tier 1 addition record, docs/spec/vouching.md, exactly 1,919 bytes of lowercase hex) for the relay, paid for by one Turnstile solve on the challenge page for the action `tier1-relay`. Checked in order: the forms; the record's checks that need it alone (decoding, a forbidden commitment, each slot below L, each root nonzero, distinct vouchers and slots) and every vouch's `root_block` on the root grid, answered as `RELAY_MALFORMED` with the check's code and the failing vouch's position; a published Tier 1 group; a current relay index; every vouch's root at or below the L2 safe head with at least 1,800 blocks of its window left past the relay's latest block; the token; then room in the queue, so a malformed or unserviceable record never spends the token and a full queue is answered only after the solve. No proof is checked here. The answer is the same empty object whether the record is newly queued, already queued, or will never count. At each 10-minute boundary the relay sends the queued records that count under its own replay of the registry; the client reads the registry's events to learn whether its commitment was added, and may send the record again (with a new solve) if nothing is logged after about two periods plus L2 finality, or submit it to the registry directly.",
    tags: ["registrations"],
  })
  .errors({
    RELAY_MALFORMED: {
      status: 422,
      message: "The record fails a check it can be judged on alone.",
      data: z.strictObject({
        code: ErrorCode,
        vouch: z.optional(z.number().check(z.int(), z.minimum(0))),
      }),
    },
    GROUP_UNKNOWN: { status: 422, message: "The record's group isn't a published Tier 1 group." },
    RELAY_UNAVAILABLE: { status: 503, message: "The relay is unavailable here for now." },
    VOUCH_WINDOW: {
      status: 422,
      message:
        "A vouch's root is past the L2 safe head, or too little of its window is left for the relay.",
    },
    CHALLENGE_REFUSED: {
      status: 403,
      message: "The Turnstile token was refused: spent, expired, or for another site or action.",
    },
    CHALLENGE_UNAVAILABLE: {
      status: 503,
      message: "The Turnstile token couldn't be checked; try again with a new one.",
    },
    RELAY_BUSY: {
      status: 503,
      message: "The relay's queue is full; try again with a new solve after the next boundary.",
    },
  })
  .input(z.strictObject({ record: hexFixed(TIER1_ADDITION_RECORD), turnstile: TurnstileResponse }))
  .output(z.strictObject({}));

/** The public API contract. `apps/api` implements it; clients call it. */
export const contract = {
  elections: { list: listElections, getDefinition, getDisplayText, resolveCode, getCode },
  board: { getHead, getEntries, getInclusionProof, getConsistencyProof },
  ballots: { submit: submitBallot },
  moderation: { getLog: getModerationLog, getStatus: getModerationStatus, report: reportPoll },
  backups: { put: putBackup, fetch: fetchBackup, delete: deleteBackup },
  registrations: { tier0: registerTier0, tier1: relayTier1 },
};

export type Contract = typeof contract;
