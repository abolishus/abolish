// The poll page's reading of a definition the API served. Nothing here is
// trusted: the definition is decoded and checked with @abolishus/crypto, the
// same code the verifier runs, and anything that doesn't decode, or names
// another election, is refused rather than shown (T-31, T-34). Whether the
// definition is the one registered on chain is for the verifier; the page
// shows its hash so a reader can compare (T-34). The page reads the
// definition versions the API stores, 1 and 5 (several questions), and no
// other: a version it can't read is undecodable here, never guessed at.
// The server's alone: pages get the view this builds (src/poll.ts), never
// the decoders, which would ship to every visitor (P2-28 part 2b).

import {
  BOARD_ENTRY,
  type BoardEntryVersion,
  DecodeError,
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  ELECTION_TYPES,
  electionDefinitionHash,
  type ElectionDefinition,
  electionDefinitionRule,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  pinnedVersion,
  RECORD_TYPES,
} from "@abolishus/crypto";

import { type DefinitionProblem, instant, type PollView } from "../poll.ts";
import { fromHex, toHex } from "../values.ts";

export type DefinitionResult =
  | {
      readonly ok: true;
      readonly poll: PollView;
      /**
       * The board-entry version the definition's profile pins, which the
       * board page decodes entries under; `undefined` unless exactly one pin
       * names a version this release reads.
       */
      readonly boardEntryVersion: BoardEntryVersion | undefined;
    }
  | { readonly ok: false; readonly problem: DefinitionProblem };

// Only the version byte routes the record, as the API's store routes it
// (packages/core, `decodeStoredDefinition`); each decoder checks the
// definition's own pin again, and version 1's refuses every later version.
const isVersion5 = (bytes: Uint8Array) =>
  bytes.length >= 3 &&
  bytes[0] === 0 &&
  bytes[1] === RECORD_TYPES.electionDefinition &&
  bytes[2] === 5;

function times(d: {
  readonly threshold: number;
  readonly panel_size: number;
  readonly opens_at: bigint;
  readonly closes_at: bigint;
}): Pick<PollView, "threshold" | "panelSize" | "opensAt" | "closesAt"> {
  return {
    threshold: d.threshold,
    panelSize: d.panel_size,
    opensAt: instant(d.opens_at),
    closesAt: instant(d.closes_at),
  };
}

function viewV5(d: ElectionDefinitionV5): PollView {
  const failure = electionDefinitionV5Rule(d);
  return {
    electionId: toHex(d.election_id),
    version: 5,
    definitionHash: toHex(electionDefinitionV5Hash(d)),
    illFormed:
      failure === undefined
        ? undefined
        : { rule: failure.rule, question: "question" in failure ? failure.question : undefined },
    counting: "questions",
    questions: d.questions.map((q) => ({
      optionCount: q.option_count,
      minSelections: q.min_selections,
      maxSelections: q.max_selections,
    })),
    electorate: d.electorate.map((t) => ({
      tier: t.tier,
      groupSize: t.regions.reduce((sum, members) => sum + members, 0n).toString(),
    })),
    ...times(d),
  };
}

function viewV1(d: ElectionDefinition): PollView {
  const rule = electionDefinitionRule(d);
  return {
    electionId: toHex(d.election_id),
    version: 1,
    definitionHash: toHex(electionDefinitionHash(d)),
    illFormed: rule === undefined ? undefined : { rule, question: undefined },
    counting: d.election_type === ELECTION_TYPES.approval ? "approval" : "plurality",
    questions: [
      {
        optionCount: d.option_count,
        minSelections: d.min_selections,
        maxSelections: d.max_selections,
      },
    ],
    electorate: d.electorate.map((g) => ({ tier: g.tier, groupSize: g.group_size.toString() })),
    ...times(d),
  };
}

/** The poll page's view of `definitionHex`, served by the API for `electionId`. */
export function definitionView(electionId: string, definitionHex: string): DefinitionResult {
  let definition;
  try {
    const bytes = fromHex(definitionHex);
    definition = isVersion5(bytes)
      ? { version: 5 as const, value: decodeElectionDefinitionV5(bytes) }
      : { version: 1 as const, value: decodeElectionDefinition(bytes) };
  } catch (error) {
    if (error instanceof DecodeError || error instanceof RangeError)
      return { ok: false, problem: "undecodable" };
    throw error;
  }
  const poll = definition.version === 5 ? viewV5(definition.value) : viewV1(definition.value);
  if (poll.electionId !== electionId) return { ok: false, problem: "another-election" };
  const pinned = pinnedVersion(definition.value, RECORD_TYPES.boardEntry);
  const boardEntryVersion =
    pinned !== undefined && Object.hasOwn(BOARD_ENTRY.versions, pinned)
      ? (pinned as BoardEntryVersion)
      : undefined;
  return { ok: true, poll, boardEntryVersion };
}
