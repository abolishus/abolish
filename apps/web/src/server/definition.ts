// The poll page's reading of a definition the API served. Nothing here is
// trusted: the definition is decoded and checked with @abolishus/crypto, the
// same code the verifier runs, and anything that doesn't decode, or names
// another election, is refused rather than shown (T-31, T-34). Whether the
// definition is the one registered on chain is for the verifier; the page
// shows its hash so a reader can compare (T-34). The page reads the
// definition versions the API stores, 1, 5 (several questions) and 7 (an
// electorate mode, so a rolling one), and no other: a version it can't read
// is undecodable here, never guessed at.
// The server's alone: pages get the view this builds (src/poll.ts), never
// the decoders, which would ship to every visitor (P2-28 part 2b).

import {
  BOARD_ENTRY,
  type BoardEntryVersion,
  DecodeError,
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  decodeElectionDefinitionV7,
  ELECTION_TYPES,
  electionDefinitionHash,
  type ElectionDefinition,
  electionDefinitionRule,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  type ElectionDefinitionV7,
  type ElectionDefinitionV7Failure,
  electionDefinitionV7Hash,
  electionDefinitionV7Rule,
  ELECTORATE_MODES,
  foldRegions,
  pinnedVersion,
  POLL_CLASSES,
  RECORD_TYPES,
} from "@abolishus/crypto";

import {
  type DefinitionProblem,
  instant,
  type PartitionCell,
  type PollClass,
  type PollView,
} from "../poll.ts";
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
      /**
       * The key ceremony's transcript as the definition commits to it: the
       * hash its record must have, and whether the profile pins version 1 of
       * the record, the only one (docs/spec/ceremony.md), which the board
       * page decodes the board's first entry under (src/ceremony.ts).
       */
      readonly transcript: { readonly hash: string; readonly pinned: boolean };
      /** Its tally partition, which the results page reports cell by cell. */
      readonly cells: readonly PartitionCell[];
    }
  | { readonly ok: false; readonly problem: DefinitionProblem };

// Only the version byte routes the record, as the API's store routes it
// (packages/core, `decodeStoredDefinition`); each decoder checks the
// definition's own pin again, and version 1's refuses every later version.
const versionOf = (bytes: Uint8Array) =>
  bytes.length >= 3 && bytes[0] === 0 && bytes[1] === RECORD_TYPES.electionDefinition
    ? bytes[2]
    : undefined;

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
  return questionsView(d, 5, electionDefinitionV5Hash(d), electionDefinitionV5Rule(d));
}

// The decoder admits only these three values (an `enum8`).
const CLASS_OF = {
  [POLL_CLASSES.everyday]: "everyday",
  [POLL_CLASSES.organisational]: "organisational",
  [POLL_CLASSES.civicReferendum]: "civic",
} as const satisfies Record<ElectionDefinitionV7["poll_class"], PollClass>;

/**
 * Version 7's view: version 5's under a fixed electorate; under a rolling
 * one, each rolling tier with its members at the opening root, which is what
 * the definition states and the verifier replays (2.4), never a count at the
 * close, which no definition holds.
 */
function viewV7(d: ElectionDefinitionV7): PollView {
  const view = {
    ...questionsView(d, 7, electionDefinitionV7Hash(d), electionDefinitionV7Rule(d)),
    pollClass: CLASS_OF[d.poll_class],
  };
  if (d.electorate_mode !== ELECTORATE_MODES.rolling) return view;
  return {
    ...view,
    rolling: true,
    electorate: d.rolling_electorate.map((t) => ({
      tier: t.tier,
      groupSize: t.group_size.toString(),
    })),
  };
}

function questionsView(
  d: ElectionDefinitionV5,
  version: 5 | 7,
  hash: Uint8Array,
  failure: ElectionDefinitionV7Failure | undefined,
): PollView {
  return {
    electionId: toHex(d.election_id),
    version,
    rolling: false,
    // Version 5 carries no class: an everyday poll. Version 7 sets its own.
    pollClass: "everyday",
    definitionHash: toHex(hash),
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

function cellsV5(d: ElectionDefinitionV5): PartitionCell[] {
  return d.electorate.flatMap((t) => {
    // The regions a cell holds are the fold's; a definition stating other
    // cells fails the rule `cells`, and its cells are then shown without them.
    let folded: number[][] | undefined;
    try {
      folded = foldRegions(t.regions);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    const regions =
      folded?.length === t.cells.length &&
      folded.every(
        (r, i) => r.reduce((n, at) => n + (t.regions[at] ?? 0n), 0n) === t.cells[i]?.members,
      )
        ? folded
        : undefined;
    return t.cells.map((c, i) => ({
      tier: t.tier,
      members: c.members.toString(),
      regions: regions?.[i],
    }));
  });
}

function viewV1(d: ElectionDefinition): PollView {
  const rule = electionDefinitionRule(d);
  return {
    electionId: toHex(d.election_id),
    version: 1,
    rolling: false,
    pollClass: "everyday",
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
    const version = versionOf(bytes);
    definition =
      version === 5
        ? { version: 5 as const, value: decodeElectionDefinitionV5(bytes) }
        : version === 7
          ? { version: 7 as const, value: decodeElectionDefinitionV7(bytes) }
          : { version: 1 as const, value: decodeElectionDefinition(bytes) };
  } catch (error) {
    if (error instanceof DecodeError || error instanceof RangeError)
      return { ok: false, problem: "undecodable" };
    throw error;
  }
  let poll: PollView;
  let cells: PartitionCell[];
  if (definition.version === 1) {
    poll = viewV1(definition.value);
    cells = definition.value.electorate.map((g) => ({
      tier: g.tier,
      members: g.group_size.toString(),
      regions: undefined,
    }));
  } else if (definition.version === 5) {
    poll = viewV5(definition.value);
    cells = cellsV5(definition.value);
  } else {
    poll = viewV7(definition.value);
    // A rolling tier is one cell, numbered in the rolling electorate's order
    // (docs/spec/election-definition.md, Tally partition); a fixed version 7's
    // cells are version 5's.
    cells =
      definition.value.electorate_mode === ELECTORATE_MODES.rolling
        ? poll.electorate.map((t) => ({ tier: t.tier, members: t.groupSize, regions: undefined }))
        : cellsV5(definition.value);
  }
  if (poll.electionId !== electionId) return { ok: false, problem: "another-election" };
  const pinned = pinnedVersion(definition.value, RECORD_TYPES.boardEntry);
  const boardEntryVersion =
    pinned !== undefined && Object.hasOwn(BOARD_ENTRY.versions, pinned)
      ? (pinned as BoardEntryVersion)
      : undefined;
  const transcript = {
    hash: toHex(definition.value.ceremony_transcript_hash),
    pinned: pinnedVersion(definition.value, RECORD_TYPES.ceremonyTranscript) === 1,
  };
  return { ok: true, poll, boardEntryVersion, transcript, cells };
}
