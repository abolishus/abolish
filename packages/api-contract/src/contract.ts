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
  MAX_SHARE_RECEIPT,
  MAX_SHARE_RECEIPT_ENTRY,
  PageSize,
  POSTING_MAX_DATA,
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

/** The longest search query and its most terms; a test ties these copies to `@abolishus/core`. */
export const MAX_SEARCH_QUERY = 200;
export const MAX_SEARCH_TERMS = 8;

/** One to `MAX_SEARCH_TERMS` whitespace-separated terms, at most `MAX_SEARCH_QUERY` code points. */
const SearchQuery = z
  .string()
  .check(
    z.maxLength(MAX_SEARCH_QUERY),
    z.regex(new RegExp(`^\\s*\\S+(?:\\s+\\S+){0,${MAX_SEARCH_TERMS - 1}}\\s*$`, "u")),
  );

/**
 * The listing's topics and a place's most code points, as
 * [[0041-poll-topics-and-places]] fixes them; a test ties these copies to
 * `@abolishus/core`.
 */
export const POLL_TOPICS = [
  "community",
  "culture",
  "economy",
  "education",
  "environment",
  "food",
  "government",
  "health",
  "housing",
  "safety",
  "science",
  "sport",
  "technology",
  "transport",
] as const;
export const MAX_PLACE_LENGTH = 80;

/** One to `MAX_PLACE_LENGTH` code points, which take at most twice as many UTF-16 units. */
const Place = z.string().check(z.minLength(1), z.maxLength(2 * MAX_PLACE_LENGTH));

const listElections = oc
  .route({
    method: "GET",
    path: "/elections",
    summary: "A page of the polls this server lists",
    description:
      "Election IDs of the polls our front ends list for discovery: at most `limit`, after the poll `after` in the order `sort` names (or from the first without it). Fewer than `limit` means the listing ends there for now. `id`, the default, lists every listed poll, open or closed, in ascending order of election ID, and `after` need not name a poll. `new` lists the polls open now (the definition's `opens_at` at or before the server's clock and `closes_at` after it), the latest registered on L2 first; `closing` lists the polls open now, the soonest `closes_at` first, then by election ID. Both orders are public chain data, the same for everyone and moved by nothing a voter or an account does. `answered` lists the polls open now, the most answered this week first, then by election ID: the count is of distinct voters (each tier and nullifier once, so a re-vote never counts twice) whose ballots this server boarded in the whole anchoring periods of the last seven days before the current one (direct-submitted ballots aren't counted yet), so it settles once a period and anyone can recompute it from the public board, whose entries carry their segments; it needs the anchoring clock, without which it is `SORT_UNAVAILABLE`. Under these three orders `after` must be a poll the order can place, one stored here and, for `new`, with its registration recorded, though it may have closed since (`CURSOR_NOT_FOUND` otherwise); under `answered` a poll whose count passes the cursor's between pages can be skipped or repeated. A poll that is delisted or hidden (docs/moderation-policy.md) is left out, though its definition, board and moderation state stay served by ID. With `q`, only the polls whose question text (each translation's title and questions, compared after NFKC normalisation and lower-casing) contains every whitespace-separated term are listed, in the same order and with `after` placed as without it; nothing is ranked by relevance, and a poll whose display text is taken down matches nothing. With `topic`, only the polls filed under that topic are listed; with `place`, only those filed at that place, compared after NFKC normalisation, lower-casing and collapsing whitespace, as a whole (`riverside` lists the polls at \"Riverside\", not those at \"Riverside Park\"); both in the same order and with `after` placed as without them. A poll's topic and place are listing tags its author chose, kept by this server beside the definition, which doesn't commit to them (docs/adr/0041-poll-topics-and-places.md): a poll with none matches neither filter. The listing is a convenience, never a source of truth: the election registry on the L2 names every poll, and callers check each definition against it (T-34, T-68).",
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
      q: z.optional(SearchQuery),
      topic: z.optional(z.enum(POLL_TOPICS)),
      place: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_PLACE_LENGTH))),
    }),
  )
  .output(z.strictObject({ elections: z.array(Hash32).check(z.maxLength(MAX_PAGE)) }));

const getTags = oc
  .route({
    method: "GET",
    path: "/elections/tags",
    summary: "Where a poll is listed",
    description:
      "The topic and place the poll is filed under for discovery: its author's, or moderation's once it refiled the poll (docs/moderation-policy.md, Refiling), either, both or neither. They are listing tags this server keeps beside the definition, which doesn't commit to them, so they are a claim no verifier checks and no result depends on (docs/adr/0041-poll-topics-and-places.md; T-68). Shown for a delisted poll, as its text is to anyone with its ID; `TAGS_WITHHELD` while the poll is hidden, since a place is its author's words, as its text is withheld.",
    tags: ["elections"],
  })
  .errors({
    ...electionNotFound,
    TAGS_WITHHELD: {
      status: 451,
      message:
        "This poll's tags are withheld under the moderation policy; see GET /moderation/status.",
    },
  })
  .input(ElectionQuery)
  .output(z.strictObject({ topic: z.optional(z.enum(POLL_TOPICS)), place: z.optional(Place) }));

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

const submitReceipt = oc
  .route({
    method: "POST",
    path: "/receipts",
    successStatus: 201,
    summary: "Board a trustee's share receipt",
    description:
      "Appends one share receipt record (0x000c) to the board by the board path's rules (docs/spec/delivery.md, Boarding): it names this election's definition and a registered seat, the ballot whose hash it names is already on the board, it is in time (no later than the delivery segment `s_D`, else `ELECTION_NOT_OPEN`), and its signature attributes it to the seat against that ballot. A seat's node and the voter's client both send it, and neither needs an account or session (T-10). Returns the board entry that carries it and the chain link after it, as for a ballot. The same bytes again return their entry. When the board path already carries a passing receipt for that seat of that ballot in other bytes, nothing is written and `earlier` is true: the entry returned carries that earlier receipt, which the caller checks against its ballot as it would its own, and keeps instead (Client rules 3). A receipt this server refuses still has the contract path (T-25).",
    tags: ["receipts"],
  })
  .errors({
    ...electionNotFound,
    ELECTION_NOT_OPEN: {
      status: 409,
      message: "The election is not accepting share receipts.",
    },
    RECEIPT_REJECTED: {
      status: 422,
      message: "The share receipt failed decoding or a boarding rule.",
      data: z.strictObject({ code: ErrorCode }),
    },
    RATE_LIMITED: { status: 429, message: "Too many requests; retry later." },
    // The receipt may still be boarded: the same bytes again return its entry.
    RECEIPTS_UNAVAILABLE: {
      status: 503,
      message: "The share receipt couldn't be judged in time; submit the same bytes again.",
    },
  })
  .input(z.strictObject({ electionId: Hash32, record: hexBytes(MAX_SHARE_RECEIPT) }))
  .output(
    z.strictObject({
      entry: hexBytes(MAX_SHARE_RECEIPT_ENTRY),
      link: Hash32,
      earlier: z.boolean(),
    }),
  );

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
/** The policy's grounds for refiling a poll; a test ties this copy to `@abolishus/core`. */
export const REFILE_REASONS = ["misfiled", ...REMOVAL_REASONS] as const;

/**
 * A creator profile's public handle ([[0040-creator-profiles]]): 16 lower-case
 * base32 characters. A test ties this copy to `@abolishus/core`.
 */
export const PROFILE_HANDLE = /^[a-z2-7]{16}$/;

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
      "Moderation decisions with a sequence number above `after`, oldest first: at most `limit`. Fewer than `limit` entries means the log ends there for now. Sequence numbers increase but may skip. A decision about a poll names it by `electionId` and delists it, hides its display text or restores it; one about a creator profile names it by its public `handle`, never its account, and hides its name and the polls it shows on our pages or restores it; a hide leaves those polls listed. A refiling (`refile`) names a poll by `electionId` and changes where it is listed, not its state: `topic` is the topic it filed the poll under, `null` if it filed it under none, and absent if it kept the topic; `place` says only whether it `changed` the place or filed the poll under none (`cleared`), never the place's words, which may be personal data a later refiling clears (T-17); a poll's first refiling reports both tags, so a tag it didn't give reads as `null` or `cleared` even if the poll had none; `GET /elections/tags` serves the place the poll is filed under now. Each cites one of the policy's reason codes, and every kind shares one numbering in the order they were made. None of them touches a poll's board, definition or result (docs/moderation-policy.md).",
    tags: ["moderation"],
  })
  .input(z.strictObject({ after: U64, limit: PageSize }))
  .output(
    z.strictObject({
      entries: z
        .array(
          z.union([
            z.strictObject({
              seq: U64,
              electionId: Hash32,
              action: ModerationAction,
              reason: ModerationReason,
              decidedAt: Timestamp,
            }),
            z.strictObject({
              seq: U64,
              electionId: Hash32,
              action: z.literal("refile"),
              reason: z.enum(REFILE_REASONS),
              decidedAt: Timestamp,
              topic: z.optional(z.nullable(z.enum(POLL_TOPICS))),
              place: z.optional(z.enum(["changed", "cleared"])),
            }),
            z.strictObject({
              seq: U64,
              handle: z.string().check(z.regex(PROFILE_HANDLE)),
              action: z.enum(["hide", "restore"]),
              reason: ModerationReason,
              decidedAt: Timestamp,
            }),
          ]),
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

// The posting relay (docs/spec/posting-relay.md; ADR 0042). The ballot client
// sends a seat's share posting and the ballot it delivers, both in the body
// and neither naming the election, whose definition hash the posting carries
// (T-10). No answer depends on whether the ballot was cast, receipted or
// posted before, except a repeat of the same bytes (T-13); every answer is a
// hint, and the client stands down only on the board's `SharePosted` event.
const submitPosting = oc
  .route({
    method: "POST",
    path: "/postings",
    summary: "Ask the relay to post a seat's share",
    description:
      "Sends `posting` (a share posting record, 0x000d) with `ballot` (the ballot record it delivers, 0x0002) to the board's `submitPosting` from the operator's posting key, which pays its gas (docs/spec/posting-relay.md, Answers). Checked in order: the forms, with `submitPosting`'s calldata for the pair at most 120,000 bytes; the records alone (both decode strictly, the posting's version is the one the ballot's fixes, and it names the ballot's definition and hash), answered as `POSTING_REFUSED` with code `malformed` and the failing check as `check`; the election, registered by this server's index of the registry, and the relay's latest L2 block no later than `c_D − 6,600` seconds (`unknown-election`, `too-late`, or `RELAY_UNAVAILABLE` while the index lags); the posting's public check against the election's registered key set (its code); then the queue. The route waits up to 20 seconds for the relay's worker: `sent` answers with the hash of the last transaction that carried the posting, an L2 call or, once forced, the L1 deposit; a refusal is `POSTING_REFUSED` with the worker's code; `RELAY_BUSY` means only not sent yet, and the client sends the same bytes again later, which the relay never pays for twice. The client judges a posting recorded only by the board's `SharePosted` event at the L2's finalized head, and past the relay's patience posts it from the voter's own wallet (T-25).",
    tags: ["postings"],
  })
  .errors({
    POSTING_REFUSED: {
      status: 422,
      message: "The relay won't send this posting.",
      data: z.strictObject({ code: ErrorCode, check: z.optional(ErrorCode) }),
    },
    RATE_LIMITED: { status: 429, message: "Too many requests; retry later." },
    RELAY_UNAVAILABLE: { status: 503, message: "The relay is unavailable here for now." },
    RELAY_BUSY: {
      status: 503,
      message: "The posting isn't sent yet; send the same bytes again later.",
    },
  })
  .input(
    z.strictObject({ posting: hexBytes(POSTING_MAX_DATA), ballot: hexBytes(POSTING_MAX_DATA) }),
  )
  .output(z.strictObject({ transaction: Hash32, layer: z.enum(["l2", "l1"]) }));

/** The public API contract. `apps/api` implements it; clients call it. */
export const contract = {
  elections: {
    list: listElections,
    getDefinition,
    getDisplayText,
    getTags,
    resolveCode,
    getCode,
  },
  board: { getHead, getEntries, getInclusionProof, getConsistencyProof },
  ballots: { submit: submitBallot },
  receipts: { submit: submitReceipt },
  postings: { submit: submitPosting },
  moderation: { getLog: getModerationLog, getStatus: getModerationStatus, report: reportPoll },
  backups: { put: putBackup, fetch: fetchBackup, delete: deleteBackup },
  registrations: { tier0: registerTier0, tier1: relayTier1 },
};

export type Contract = typeof contract;
