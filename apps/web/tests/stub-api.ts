// The API the built website is tested against (tests/ssr.test.ts,
// tests/a11y.e2e.ts): the published vectors' polls under IDs of their own,
// answered as `apps/api` answers, recording every request it is sent.

import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import { shortCode } from "@abolishus/core/short-codes";
import {
  BOARD_TREE,
  boardEntryHash,
  chainLink,
  consistencyProof,
  decodeBoardEntry,
  decodeCheckpoint,
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  decodeElectionDefinitionV7,
  electionDefinitionHash,
  electionDefinitionV5Hash,
  encodeBoardEntry,
  encodeCheckpoint,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
  encodeElectionDefinitionV7,
  inclusionProof,
  merkleRoot,
} from "@abolishus/crypto";

import { fromHex, toHex } from "../src/values.ts";

interface Vector {
  id: string;
  value?: { election_id: string };
  encoding: string;
  hash?: string;
}
type DefinitionVector = Vector & { value: { election_id: string }; hash: string };
const vectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/election-definition.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const definitionVector = (id: string): DefinitionVector => {
  const v = vectors.find((x) => x.id === id);
  if (v?.value === undefined || v.hash === undefined) throw new Error("vectors missing");
  return v as DefinitionVector;
};
export const typical = definitionVector("definition-typical");
const approval = definitionVector("definition-approval");

export const ID = typical.value.election_id;
/** Known to the stub, but its definition names another election. */
export const SWAPPED_ID = "ab".repeat(32);
export const UNKNOWN_ID = "cd".repeat(32);
/** A creator profile's public handle, as the log names it. */
export const PROFILE_HANDLE = "k7qa2mzr5xw3bn4d";

export const LATEST = {
  seq: "7",
  action: "hide",
  reason: "personal-data",
  decidedAt: "2026-10-01T12:00:00.000Z",
};

/**
 * The typical poll's board, 30 entries: the valid board
 * vector's payloads under the typical poll's ID, at their positions. The stub
 * serves these entries for every poll, so any other poll's board names
 * another election.
 */
const boardVector = (
  JSON.parse(
    readFileSync(new URL("../../../docs/spec/vectors/board.json", import.meta.url), "utf8"),
  ) as { boards: { id: string; entries: string[] }[] }
).boards.find((b) => b.id === "valid");
if (boardVector === undefined) throw new Error("vectors missing");
export const BOARD = Array.from({ length: 30 }, (_, i) => {
  const { payload } = decodeBoardEntry(
    fromHex(boardVector.entries[i % boardVector.entries.length]!),
    1,
  );
  return toHex(
    encodeBoardEntry(
      { election_id: fromHex(ID), index: BigInt(i), segment: Math.floor(i / 5), payload },
      1,
    ),
  );
});

/**
 * The typical poll's checkpoints, the latest first, as `apps/api` serves
 * them: one for each of `BOARD`'s six segments, as many as the page asks
 * for, with its size, chain head and root. `BOARD` isn't a board the verifier accepts
 * (its payloads break the openings' order), and the page reads no CID, so
 * those are placeholders. Served for every poll, so any other poll's name
 * another election.
 */
const hashes = BOARD.map((e) => boardEntryHash(fromHex(e)));
const links = hashes.reduce<Uint8Array[]>(
  (chain, h) => [...chain, chainLink(chain.at(-1) ?? new Uint8Array(32), h)],
  [],
);
/** The typical poll's head: its whole board, as the latest checkpoint has it. */
export const HEAD = {
  treeSize: String(BOARD.length),
  chainHead: toHex(links.at(-1)!),
  root: toHex(merkleRoot(BOARD_TREE, hashes)),
};
/**
 * While set, every consistency proof the stub serves has one hash changed,
 * as a server showing two histories of one board would (T-24).
 */
export const brokenProofs = { on: false };
/**
 * While set, the inclusion proof the stub serves for entry `at` has one hash
 * changed, as a server showing an entry outside its tree would (T-23, T-24).
 */
export const brokenInclusion: { at: number | undefined } = { at: undefined };
export const CHECKPOINTS = Array.from({ length: BOARD.length / 5 }, (_, s) => {
  const size = 5 * (s + 1);
  return toHex(
    encodeCheckpoint({
      election_id: fromHex(ID),
      segment: s,
      size: BigInt(size),
      head: links[size - 1]!,
      root: merkleRoot(BOARD_TREE, hashes.slice(0, size)),
      object_cid: new Uint8Array(36).fill(s),
      hashes_cid: new Uint8Array(36).fill(s + 1),
    }),
  );
}).toReversed();

/** A poll whose text moderation has hidden: the approval vector, under an ID of its own. */
export const HIDDEN_ID = "ef".repeat(32);
const hiddenDefinition = toHex(
  encodeElectionDefinition({
    ...decodeElectionDefinition(fromHex(approval.encoding)),
    election_id: fromHex(HIDDEN_ID),
  }),
);

/** A version-5 poll of four questions: the typical vector under an ID of its own. */
const typicalV5 = (
  JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/election-definition-v5.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors.find((v) => v.id === "definition-v5-typical");
if (typicalV5 === undefined) throw new Error("vectors missing");
export const QUESTIONS_ID = "a5".repeat(32);
export const questionsDefinition = encodeElectionDefinitionV5({
  ...decodeElectionDefinitionV5(fromHex(typicalV5.encoding)),
  election_id: fromHex(QUESTIONS_ID),
});

/**
 * A version-7 civic referendum: the fixed civic vector under an ID of its
 * own, unlisted. Its class puts it on the civic record, which no poll can
 * be on under the launch panel (T-14).
 */
const civicV7 = (
  JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/election-definition-v7.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors.find((v) => v.id === "definition-v7-fixed-civic");
if (civicV7 === undefined) throw new Error("vectors missing");
export const CIVIC_ID = "a7".repeat(32);
const civicDefinition = encodeElectionDefinitionV7({
  ...decodeElectionDefinitionV7(fromHex(civicV7.encoding)),
  election_id: fromHex(CIVIC_ID),
});

export const definitions = new Map([
  [ID, typical.encoding],
  [QUESTIONS_ID, toHex(questionsDefinition)],
  [CIVIC_ID, toHex(civicDefinition)],
  [HIDDEN_ID, hiddenDefinition],
  [SWAPPED_ID, typical.encoding],
]);

/**
 * Eighteen fillers, the typical poll and one the stub has lost fill the
 * register's first page (`listed`, below).
 */
export const FILLER = Array.from({ length: 18 }, (_, i) =>
  (i + 1).toString(16).padStart(2, "0").repeat(32),
);
export const LOST_ID = "13".repeat(32);
for (const id of FILLER)
  definitions.set(
    id,
    toHex(
      encodeElectionDefinition({
        ...decodeElectionDefinition(fromHex(typical.encoding)),
        election_id: fromHex(id),
      }),
    ),
  );

/**
 * The stream's polls (`/discover`), each committed to a published display
 * text: a version-5 poll of two questions, a version-1 poll, one whose
 * served text isn't the one its definition commits to, and one with no text
 * at all. The fillers follow them, without text, so the stream has a second
 * page.
 */
interface TextVector {
  id: string;
  encoding: string;
  commitment: string;
}
const textVector = (name: string, id: string) => {
  const v = (
    JSON.parse(
      readFileSync(new URL(`../../../docs/spec/vectors/${name}`, import.meta.url), "utf8"),
    ) as { vectors: TextVector[] }
  ).vectors.find((x) => x.id === id);
  if (v === undefined) throw new Error("vectors missing");
  return v;
};
const TEXT_V1 = textVector("display-text.json", "display-text-two-languages");
const TEXT_V2 = textVector("display-text-v2.json", "display-text-v2-two-questions");
export const STREAM_V5 = "c1".repeat(32);
export const STREAM_V1 = "c2".repeat(32);
export const STREAM_BAD_TEXT = "c3".repeat(32);
export const STREAM_NO_TEXT = "c4".repeat(32);
const streamV1 = (electionId: string) =>
  toHex(
    encodeElectionDefinition({
      ...decodeElectionDefinition(fromHex(typical.encoding)),
      election_id: fromHex(electionId),
      option_count: 3,
      max_selections: 1,
      display_text_commitment: fromHex(TEXT_V1.commitment),
    }),
  );
{
  const v5 = decodeElectionDefinitionV5(fromHex(typicalV5.encoding));
  definitions.set(
    STREAM_V5,
    toHex(
      encodeElectionDefinitionV5({
        ...v5,
        election_id: fromHex(STREAM_V5),
        questions: [3, 2].map((option_count) => ({
          ...v5.questions[0]!,
          option_count,
          min_selections: 0,
          max_selections: 1,
        })),
        display_text_commitment: fromHex(TEXT_V2.commitment),
      }),
    ),
  );
}
for (const id of [STREAM_V1, STREAM_BAD_TEXT, STREAM_NO_TEXT]) definitions.set(id, streamV1(id));
/** Polls still open, for their embeds: one question of three answers, and two questions. */
export const OPEN_ONE = "e1".repeat(32);
export const OPEN_MANY = "e2".repeat(32);
/** Long after any test runs. */
export const FAR = 4_102_444_800n;
definitions.set(
  OPEN_ONE,
  toHex(
    encodeElectionDefinition({
      ...decodeElectionDefinition(fromHex(streamV1(OPEN_ONE))),
      closes_at: FAR,
    }),
  ),
);
definitions.set(
  OPEN_MANY,
  toHex(
    encodeElectionDefinitionV5({
      ...decodeElectionDefinitionV5(fromHex(definitions.get(STREAM_V5)!)),
      election_id: fromHex(OPEN_MANY),
      closes_at: FAR,
    }),
  ),
);
/**
 * The version-5 stream poll's words in Tier 0 alone, whose three cells (the
 * typical vector's regions 5,000, 1,200 and 40 + 980, folded) the results
 * page shows part by part.
 */
export const CELLS_ID = "c5".repeat(32);
{
  const v5 = decodeElectionDefinitionV5(fromHex(definitions.get(STREAM_V5)!));
  definitions.set(
    CELLS_ID,
    toHex(
      encodeElectionDefinitionV5({
        ...v5,
        election_id: fromHex(CELLS_ID),
        electorate: v5.electorate.filter((t) => t.tier === 0),
      }),
    ),
  );
}
export const displayTexts = new Map([
  [STREAM_V5, TEXT_V2.encoding],
  [CELLS_ID, TEXT_V2.encoding],
  [STREAM_V1, TEXT_V1.encoding],
  [OPEN_ONE, TEXT_V1.encoding],
  [OPEN_MANY, TEXT_V2.encoding],
  [STREAM_BAD_TEXT, TEXT_V2.encoding],
]);
/**
 * What the stub lists for discovery, in order, as the API would: never the
 * hidden poll. The fillers, the typical poll and the lost one fill the first
 * page, with the lost one last (so it is the page's cursor but not shown);
 * the swapped poll and the stream's four, with and without words to show,
 * are on the second.
 */
export const listed = [
  ...FILLER,
  ID,
  SWAPPED_ID,
  LOST_ID,
  STREAM_V5,
  STREAM_V1,
  STREAM_BAD_TEXT,
  STREAM_NO_TEXT,
].sort();
/** The stream under `new`; `closing` is the same polls the other way round. */
export const streamed = [STREAM_V5, STREAM_V1, STREAM_BAD_TEXT, STREAM_NO_TEXT, ...FILLER];
export const BALLOT = "https://ballot.test/";

/** A poll's short code at `length`, from the definition the stub serves for it. */
export const codeOf = (id: string, length = 7) =>
  shortCode(
    electionDefinitionHash(decodeElectionDefinition(fromHex(definitions.get(id) ?? ""))),
    length,
  );
export const CODE = codeOf(ID);
/** The hidden poll's code, as if an earlier poll's hash shared its first 7 characters. */
export const HIDDEN_CODE = codeOf(HIDDEN_ID, 8);
/** A code the stub claims for the typical poll, though its hash doesn't start with it. */
export const FALSE_CODE = CODE.startsWith("z") ? `y${CODE.slice(1)}` : `z${CODE.slice(1)}`;
/** A code the stub claims for the swapped poll, whose served definition names another. */
export const SWAPPED_CODE = "s".repeat(7);
export const UNKNOWN_CODE = "x".repeat(7);
/** The open polls' codes. */
export const OPEN_ONE_CODE = codeOf(OPEN_ONE);
export const OPEN_MANY_CODE = shortCode(
  electionDefinitionV5Hash(decodeElectionDefinitionV5(fromHex(definitions.get(OPEN_MANY)!))),
  7,
);
/** The counted polls' codes, for their embeds' results. */
export const STREAM_V5_CODE = shortCode(
  electionDefinitionV5Hash(decodeElectionDefinitionV5(fromHex(definitions.get(STREAM_V5)!))),
  7,
);
export const STREAM_V1_CODE = codeOf(STREAM_V1);
export const owners = new Map([
  [CODE, ID],
  [STREAM_V5_CODE, STREAM_V5],
  [STREAM_V1_CODE, STREAM_V1],
  [OPEN_ONE_CODE, OPEN_ONE],
  [OPEN_MANY_CODE, OPEN_MANY],
  [HIDDEN_CODE, HIDDEN_ID],
  [FALSE_CODE, ID],
  [SWAPPED_CODE, SWAPPED_ID],
]);
/** A listed poll the stub claims a code for that isn't a prefix of its hash. */
export const MISCODED_ID = FILLER[0]!;
export const MISCODED_CODE = codeOf(MISCODED_ID).startsWith("z")
  ? `y${codeOf(MISCODED_ID).slice(1)}`
  : `z${codeOf(MISCODED_ID).slice(1)}`;
/** A listed poll whose code the stub fails to answer, as an API without the route would. */
export const CODE_FAILS_ID = FILLER[2]!;
/** Each poll's canonical code as the stub claims it; the other polls have no registration. */
export const codes = new Map([
  [ID, CODE],
  [STREAM_V5, STREAM_V5_CODE],
  [STREAM_V1, STREAM_V1_CODE],
  [OPEN_ONE, OPEN_ONE_CODE],
  [OPEN_MANY, OPEN_MANY_CODE],
  [HIDDEN_ID, HIDDEN_CODE],
  [MISCODED_ID, MISCODED_CODE],
]);

/**
 * Each poll's results, as `GET /elections/results` answers them: the
 * version-1 stream poll counted in Tier 0 with Tier 2 still partly unopened,
 * the version-5 one question by question, the hidden poll counted, the
 * typical poll and one open poll unopened, and the other open one counted
 * already, as no API should answer before the close. One filler is counted in
 * both its tiers. One poll answers counts that don't
 * fit its definition, one isn't ready and one fails; the rest are polls this
 * server counts no results of.
 */
export const RESULTS_MISFIT_ID = FILLER[4]!;
export const RESULTS_NOT_READY_ID = FILLER[5]!;
export const RESULTS_FAILS_ID = FILLER[6]!;
/** A poll whose cells don't add up to its tiers' results, which the results page refuses to show (T-34). */
export const CELLS_MISFIT_ID = FILLER[7]!;
/** A closed poll counted in both its tiers, which the register says is counted. */
export const COUNTED_ID = FILLER[8]!;
/** A poll whose board head the stub fails to answer, which the results page shows its results without. */
export const HEAD_FAILS_ID = FILLER[9]!;
const counted = (tiers: unknown[], cells: unknown[] = []) => ({
  state: "read",
  openings: 3,
  passed: false,
  cells,
  tiers,
});
const missing = (cell: number, tier: number, n: number) => ({
  cell,
  tier,
  counted: n,
  code: "tally-missing",
  signers: [],
});
// The cells poll's three cells, counted apart and summed for its tier.
const CELLS = [
  [5, ["2", "3", "0"], ["4", "1"]],
  [2, ["1", "1", "0"], ["1", "0"]],
  [1, ["1", "0", "0"], ["0", "0"]],
] as const;
const RESULTS = new Map<string, unknown>([
  [ID, { state: "unopened" }],
  [OPEN_ONE, { state: "unopened" }],
  [
    STREAM_V1,
    counted(
      [
        { tier: 0, counted: 12, counts: ["6", "3", "1"] },
        { tier: 2, counted: 2 },
      ],
      [{ cell: 0, tier: 0, counted: 12, counts: ["6", "3", "1"], signers: [1] }, missing(1, 2, 2)],
    ),
  ],
  [
    STREAM_V5,
    counted([
      {
        tier: 0,
        counted: 8,
        counts: ["4", "4", "0", "5", "1"],
        byQuestion: [
          ["4", "4", "0"],
          ["5", "1"],
        ],
      },
    ]),
  ],
  [
    CELLS_ID,
    counted(
      [
        {
          tier: 0,
          counted: 8,
          counts: ["4", "4", "0", "5", "1"],
          byQuestion: [
            ["4", "4", "0"],
            ["5", "1"],
          ],
        },
      ],
      CELLS.map(([n, first, second], cell) => ({
        cell,
        tier: 0,
        counted: n,
        counts: [...first, ...second],
        byQuestion: [first, second],
        signers: [1],
      })),
    ),
  ],
  [HIDDEN_ID, counted([{ tier: 0, counted: 3, counts: ["3", "1", "0", "0", "2"] }])],
  [
    OPEN_MANY,
    counted([
      {
        tier: 0,
        counted: 2,
        counts: ["2", "0", "0", "1", "1"],
        byQuestion: [
          ["2", "0", "0"],
          ["1", "1"],
        ],
      },
    ]),
  ],
  [RESULTS_MISFIT_ID, counted([{ tier: 0, counted: 3, counts: ["1", "1"] }])],
  [
    COUNTED_ID,
    counted([
      { tier: 0, counted: 4, counts: ["2", "1", "1"] },
      { tier: 2, counted: 1, counts: ["0", "1", "0"] },
    ]),
  ],
  [
    CELLS_MISFIT_ID,
    counted(
      [
        { tier: 0, counted: 4, counts: ["2", "1", "1"] },
        { tier: 2, counted: 0 },
      ],
      [{ cell: 0, tier: 0, counted: 4, counts: ["1", "2", "1"], signers: [1] }, missing(1, 2, 0)],
    ),
  ],
]);

/** The log's counts the stub serves, as the API does. */
export const LOG_COUNTS = {
  delist: "4",
  hide: "2",
  hideProfile: "1",
  restore: "3",
  refile: "1",
  total: "11",
  since: "2026-09-01T08:30:00.000Z",
};

/** The listing's counts the stub serves, as the API does. */
export const LISTING_COUNTS = { listed: "1234", open: "212", scheduled: "41" };
export const LISTED_PLACES = ["Old Town", "Riverside", "東京 Ward 2"];

/** The moderation log the stub serves by default, oldest first. */
export const LOG_ENTRIES: readonly Record<string, string>[] = [
  { ...LATEST, seq: "5", handle: PROFILE_HANDLE, reason: "impersonation" },
  { ...LATEST, electionId: HIDDEN_ID },
  {
    seq: "8",
    electionId: HIDDEN_ID,
    action: "refile",
    reason: "misfiled",
    decidedAt: LATEST.decidedAt,
    topic: "transport",
    place: "cleared",
  },
];

/**
 * The stub's state: while `down`, it drops every connection unanswered, as a
 * dead API would; with `logCounts` unset, its read of the log's counts fails,
 * and with `listingCounts` unset, its read of the listing's, as with
 * `listedPlaces` unset its read of the places it suggests;
 * `log` is the moderation log it serves, oldest first; `mostAnswered` is the
 * `answered` order it lists, which with it unset it can't sort by, as an API
 * without the anchoring clock can't; `answered` is how many have answered
 * each poll so far, tier by tier, as the API serves it, and with
 * `answeredManyFails` set its read of several polls' counts at once fails.
 */
export const stub: {
  down: boolean;
  logCounts: Record<string, string> | undefined;
  listingCounts: Record<string, string> | undefined;
  listedPlaces: readonly string[] | undefined;
  log: readonly Record<string, string>[];
  mostAnswered: readonly string[] | undefined;
  answered: Map<string, readonly { tier: number; answered: string }[]>;
  answeredManyFails: boolean;
} = {
  down: false,
  logCounts: LOG_COUNTS,
  listingCounts: LISTING_COUNTS,
  listedPlaces: LISTED_PLACES,
  log: LOG_ENTRIES,
  mostAnswered: undefined,
  // A count claimed for tier 1, which STREAM_V5's definition doesn't name, is
  // left out; its tier 2, with none served, counts 0.
  answered: new Map([
    [
      STREAM_V5,
      [
        { tier: 0, answered: "1204" },
        { tier: 1, answered: "7" },
      ],
    ],
  ]),
  answeredManyFails: false,
};

/** Every request the stub API received, with its headers. */
export const seen: {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body?: unknown;
}[] = [];

/**
 * The polls the stub finds for a search, as the API would from their
 * question text: "park" is in both streamed texts' questions, "library" only
 * in the version-5 poll's title. Any other query finds nothing, and a query
 * of control characters alone is refused as the API refuses one.
 */
const SEARCHES = new Map([
  ["park", [STREAM_V5, STREAM_V1]],
  ["library", [STREAM_V5]],
]);
/** The stream's polls filed under each topic, and at each place by its key. */
const TOPICS = new Map([
  ["community", [STREAM_V5, STREAM_V1]],
  ["transport", [STREAM_V1]],
]);
const PLACES = new Map([["riverside park", [STREAM_V5]]]);
/** A listed poll whose place the stub serves with a bidi override, which no draft could hold (T-67). */
export const OVERRIDE_ID = FILLER[3]!;
/** Where the stub files each poll, as `GET /elections/tags` serves it; the rest have no tags. */
const TAGS = new Map<string, { topic?: string; place?: string }>([
  [ID, { topic: "housing", place: "Old Town" }],
  [STREAM_V5, { topic: "community", place: "Riverside Park" }],
  [STREAM_V1, { topic: "transport" }],
  [OVERRIDE_ID, { topic: "food", place: "Main \u202eteertS" }],
]);

export function stubApi(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const request = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
    };
    seen.push(request);
    if (stub.down) return void req.socket.destroy();
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/elections/answered") {
      // The only POST the website's server sends the API. As `GET` answers
      // each poll, leaving out STREAM_V1, whose single read fails, as the API
      // leaves out an election it doesn't know.
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          electionIds: readonly string[];
        };
        Object.assign(request, { body });
        if (stub.answeredManyFails) return json(500, {});
        json(200, {
          elections: body.electionIds
            .filter((id) => id !== STREAM_V1)
            .map((id) => ({ electionId: id, tiers: stub.answered.get(id) ?? [] })),
        });
      });
      return;
    }
    const electionId = url.searchParams.get("electionId") ?? "";
    const definition = definitions.get(electionId);
    if (url.pathname === "/moderation/log/counts") {
      if (stub.logCounts === undefined) return json(503, { code: "INTERNAL_SERVER_ERROR" });
      return json(200, stub.logCounts);
    }
    if (url.pathname === "/moderation/log") {
      // As the API pages it: below `before`, newest first, or above `after`
      // (from the first without it), oldest first.
      const limit = Number(url.searchParams.get("limit"));
      const before = url.searchParams.get("before");
      const after = BigInt(url.searchParams.get("after") ?? "0");
      const entries =
        before === null
          ? stub.log.filter((entry) => BigInt(entry["seq"]!) > after)
          : stub.log.filter((entry) => BigInt(entry["seq"]!) < BigInt(before)).toReversed();
      return json(200, { entries: entries.slice(0, limit) });
    }
    if (url.pathname === "/elections/by-code") {
      // The API's answer for a code it is given in any form; this stub knows only canonical ones.
      const code = url.searchParams.get("code") ?? "";
      const electionId = owners.get(code);
      if (electionId === undefined)
        return json(404, {
          defined: true,
          code: "CODE_NOT_FOUND",
          status: 404,
          message: "No poll owns this code.",
        });
      return json(200, { electionId, code });
    }
    if (url.pathname === "/elections/places") {
      if (stub.listedPlaces === undefined) return json(503, { code: "INTERNAL_SERVER_ERROR" });
      return json(200, { places: stub.listedPlaces });
    }
    if (url.pathname === "/elections/counts") {
      if (stub.listingCounts === undefined) return json(503, { code: "INTERNAL_SERVER_ERROR" });
      return json(200, stub.listingCounts);
    }
    if (url.pathname === "/elections") {
      const after = url.searchParams.get("after") ?? "";
      const limit = Number(url.searchParams.get("limit"));
      const sort = url.searchParams.get("sort");
      if (sort === "answered" && stub.mostAnswered !== undefined)
        return json(200, { elections: stub.mostAnswered.slice(0, limit) });
      if (sort === "answered")
        return json(503, {
          defined: true,
          code: "SORT_UNAVAILABLE",
          status: 503,
          message: "This order is unavailable here for now.",
        });
      const q = url.searchParams.get("q");
      if (q !== null && /^[\p{Cc}\s]*$/u.test(q))
        return json(400, {
          defined: false,
          code: "BAD_REQUEST",
          status: 400,
          message: "No search term is left once normalised.",
        });
      if (sort === "new" || sort === "closing") {
        const topic = url.searchParams.get("topic");
        const place = url.searchParams.get("place");
        const filters = [
          q === null ? undefined : (SEARCHES.get(q.toLowerCase()) ?? []),
          topic === null ? undefined : (TOPICS.get(topic) ?? []),
          place === null
            ? undefined
            : (PLACES.get(place.replace(/\s+/gu, " ").trim().toLowerCase()) ?? []),
        ];
        const matches = streamed.filter((id) =>
          filters.every((only) => only === undefined || only.includes(id)),
        );
        const order = sort === "new" ? matches : matches.toReversed();
        const from = after === "" ? 0 : order.indexOf(after) + 1;
        if (from === 0 && after !== "")
          return json(400, {
            defined: true,
            code: "CURSOR_NOT_FOUND",
            status: 400,
            message: "`after` names no poll this order can place.",
          });
        return json(200, { elections: order.slice(from, from + limit) });
      }
      const only = q === null ? undefined : (SEARCHES.get(q.toLowerCase()) ?? []);
      // The register's tag filters, as `GET /elections/tags` files each poll:
      // a place matched whole, ignoring capitals and spacing.
      const key = (place: string) => place.replace(/\s+/gu, " ").trim().toLowerCase();
      const topic = url.searchParams.get("topic");
      const place = url.searchParams.get("place");
      const filed = (id: string) =>
        (topic === null || TAGS.get(id)?.topic === topic) &&
        (place === null || key(TAGS.get(id)?.place ?? "") === key(place));
      const kept = listed.filter((id) => (only === undefined || only.includes(id)) && filed(id));
      // As the API reads back from `before`: the page just below it, in the same order.
      const before = url.searchParams.get("before");
      if (before !== null) {
        const below = kept.filter((id) => id < before);
        return json(200, { elections: below.slice(Math.max(0, below.length - limit)) });
      }
      return json(200, { elections: kept.filter((id) => id > after).slice(0, limit) });
    }
    if (definition === undefined)
      return json(404, {
        defined: true,
        code: "ELECTION_NOT_FOUND",
        status: 404,
        message: "No election with this id is known to this server.",
      });
    switch (url.pathname) {
      case "/elections/definition":
        return json(200, { definition });
      case "/elections/display-text": {
        const displayText = displayTexts.get(electionId);
        return displayText === undefined
          ? json(404, {
              defined: true,
              code: "DISPLAY_TEXT_NOT_FOUND",
              status: 404,
              message: "This server holds no display text for this election.",
            })
          : json(200, { displayText });
      }
      case "/board/head":
        return electionId === HEAD_FAILS_ID ? json(500, {}) : json(200, HEAD);
      case "/board/entries": {
        const start = Number(url.searchParams.get("start"));
        if (start > BOARD.length)
          return json(416, {
            defined: true,
            code: "OUT_OF_RANGE",
            status: 416,
            message: "The requested positions are beyond the board this server holds.",
          });
        // At most 7 entries an answer, as a page the API cut short by bytes would be.
        const limit = Math.min(Number(url.searchParams.get("limit")), 7);
        return json(200, { entries: BOARD.slice(start, start + limit) });
      }
      case "/board/proofs/consistency": {
        const firstSize = Number(url.searchParams.get("firstSize"));
        const secondSize = Number(url.searchParams.get("secondSize"));
        if (firstSize < 1 || firstSize > secondSize || secondSize > BOARD.length)
          return json(416, {
            defined: true,
            code: "OUT_OF_RANGE",
            status: 416,
            message: "The requested positions are beyond the board this server holds.",
          });
        const path = consistencyProof(BOARD_TREE, hashes.slice(0, secondSize), firstSize);
        if (brokenProofs.on && path[0] !== undefined) path[0] = path[0].map((b) => b ^ 1);
        return json(200, { path: path.map(toHex) });
      }
      case "/board/proofs/inclusion": {
        const index = Number(url.searchParams.get("index"));
        const treeSize = Number(url.searchParams.get("treeSize"));
        if (index >= treeSize || treeSize > BOARD.length)
          return json(416, {
            defined: true,
            code: "OUT_OF_RANGE",
            status: 416,
            message: "The requested positions are beyond the board this server holds.",
          });
        const path = inclusionProof(BOARD_TREE, hashes.slice(0, treeSize), index);
        if (brokenInclusion.at === index && path[0] !== undefined)
          path[0] = path[0].map((b) => b ^ 1);
        return json(200, { path: path.map(toHex) });
      }
      case "/board/checkpoints": {
        const before = url.searchParams.get("before");
        const limit = Number(url.searchParams.get("limit"));
        return json(200, {
          checkpoints: CHECKPOINTS.filter(
            (c) => before === null || decodeCheckpoint(fromHex(c)).segment < Number(before),
          ).slice(0, limit),
        });
      }
      case "/moderation/status":
        return json(
          200,
          electionId === HIDDEN_ID ? { state: "hidden", latest: LATEST } : { state: "visible" },
        );
      case "/elections/tags":
        if (electionId === CODE_FAILS_ID) return json(500, {});
        if (electionId === HIDDEN_ID)
          return json(451, {
            defined: true,
            code: "TAGS_WITHHELD",
            status: 451,
            message:
              "This poll's tags are withheld under the moderation policy; see GET /moderation/status.",
          });
        return json(200, TAGS.get(electionId) ?? {});
      case "/elections/answered":
        if (electionId === STREAM_V1) return json(500, {});
        return json(200, { tiers: stub.answered.get(electionId) ?? [] });
      case "/elections/results": {
        if (electionId === RESULTS_FAILS_ID) return json(500, {});
        if (electionId === RESULTS_NOT_READY_ID)
          return json(503, {
            defined: true,
            code: "RESULTS_NOT_READY",
            status: 503,
            message: "The results can't be read yet; ask again later.",
          });
        const results = RESULTS.get(electionId);
        return results === undefined
          ? json(409, {
              defined: true,
              code: "RESULTS_NOT_COUNTED",
              status: 409,
              message:
                "This server boards no tally opening of this election, so counts no results.",
            })
          : json(200, results);
      }
      case "/elections/code": {
        if (electionId === CODE_FAILS_ID) return json(500, {});
        const code = codes.get(electionId);
        return code === undefined
          ? json(404, {
              defined: true,
              code: "CODE_NOT_FOUND",
              status: 404,
              message: "No registration is recorded for this election.",
            })
          : json(200, { code });
      }
    }
    json(404, {});
  });
}
