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
  decodeBoardEntry,
  decodeCheckpoint,
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  electionDefinitionHash,
  electionDefinitionV5Hash,
  encodeBoardEntry,
  encodeCheckpoint,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
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
export const HEAD = { treeSize: "30", chainHead: "1f".repeat(32), root: "2e".repeat(32) };
/** A creator profile's public handle, as the log names it. */
export const PROFILE_HANDLE = "k7qa2mzr5xw3bn4d";

export const LATEST = {
  seq: "7",
  action: "hide",
  reason: "personal-data",
  decidedAt: "2026-10-01T12:00:00.000Z",
};

/**
 * The typical poll's board, as many entries as `HEAD` claims: the valid board
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
export const BOARD = Array.from({ length: Number(HEAD.treeSize) }, (_, i) => {
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

export const definitions = new Map([
  [ID, typical.encoding],
  [QUESTIONS_ID, toHex(questionsDefinition)],
  [HIDDEN_ID, hiddenDefinition],
  [SWAPPED_ID, typical.encoding],
]);

/**
 * What the stub lists for discovery, in order, as the API would: never the
 * hidden poll. Eighteen fillers, the typical poll and one the stub has lost
 * fill the first page, with the lost one last (so it is the page's cursor
 * but not shown); the swapped poll is on the second.
 */
export const FILLER = Array.from({ length: 18 }, (_, i) =>
  (i + 1).toString(16).padStart(2, "0").repeat(32),
);
export const LOST_ID = "13".repeat(32);
export const listed = [...FILLER, ID, SWAPPED_ID, LOST_ID].sort();
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
export const displayTexts = new Map([
  [STREAM_V5, TEXT_V2.encoding],
  [STREAM_V1, TEXT_V1.encoding],
  [OPEN_ONE, TEXT_V1.encoding],
  [OPEN_MANY, TEXT_V2.encoding],
  [STREAM_BAD_TEXT, TEXT_V2.encoding],
]);
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
export const owners = new Map([
  [CODE, ID],
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
  [OPEN_ONE, OPEN_ONE_CODE],
  [OPEN_MANY, OPEN_MANY_CODE],
  [HIDDEN_ID, HIDDEN_CODE],
  [MISCODED_ID, MISCODED_CODE],
]);

/** The stub's state: while `down`, it drops every connection unanswered, as a dead API would. */
export const stub = { down: false };

/** Every request the stub API received, with its headers. */
export const seen: { path: string; query: URLSearchParams; headers: IncomingHttpHeaders }[] = [];

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
    seen.push({ path: url.pathname, query: url.searchParams, headers: req.headers });
    if (stub.down) return void req.socket.destroy();
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const electionId = url.searchParams.get("electionId") ?? "";
    const definition = definitions.get(electionId);
    if (url.pathname === "/moderation/log") {
      const after = BigInt(url.searchParams.get("after") ?? "0");
      const entries =
        after < 7n
          ? [
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
            ]
          : [];
      return json(200, { entries });
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
    if (url.pathname === "/elections") {
      const after = url.searchParams.get("after") ?? "";
      const limit = Number(url.searchParams.get("limit"));
      const sort = url.searchParams.get("sort");
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
      return json(200, { elections: listed.filter((id) => id > after).slice(0, limit) });
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
        return json(200, HEAD);
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
