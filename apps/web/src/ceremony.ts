// The key ceremony as the board page shows it, from the board's first entry,
// which must carry the ceremony's public transcript (docs/spec/board.md;
// docs/spec/ceremony.md, Transcript). Nothing here is trusted: the entry is
// decoded with @abolishus/crypto, its transcript's hash is computed here and
// compared with the one the poll's definition commits to (T-23, T-34, T-37),
// and each seat's rounds are read from the decoded messages. Whether every
// proof in it holds, and so which seats qualified, is the verifier's check
// (docs/spec/verifier.md, 3.1 and 3.2): it needs the panel the release pins,
// which this page doesn't read. The server's alone, as src/server/definition.ts
// is: pages get the view, never the decoders (P2-28 part 2b).

import {
  type BoardEntryVersion,
  ceremonyTranscriptHash,
  DecodeError,
  decodeBoardEntry,
  decodeCeremonyTranscript,
  RECORD_TYPES,
} from "@abolishus/crypto";

import { fromHex, toHex } from "./values.ts";

/** The four rounds of a run, in order (docs/spec/ceremony.md, Rounds). */
export const CEREMONY_ROUNDS = 4;

export interface CeremonySeat {
  /** The seat's index, from 1. */
  readonly index: number;
  /** How many of the four rounds hold a message from it. */
  readonly rounds: number;
}

export type CeremonyView =
  | {
      readonly kind: "transcript";
      /** The transcript's hash, computed here over its record. */
      readonly hash: string;
      /** Whether it is the hash the poll's definition commits to. */
      readonly committed: boolean;
      /** Every seat of the panel the definition sizes, in order. */
      readonly seats: readonly CeremonySeat[];
    }
  /** The first entry carries another kind of record: the board doesn't start with the ceremony. */
  | { readonly kind: "missing" }
  /** It carries a transcript that doesn't decode under the version the profile pins, or none is pinned. */
  | { readonly kind: "undecodable" };

/**
 * The ceremony the board's first entry, `entry` (the API's encoding, already
 * checked by `boardRows` to decode under `version` and sit at position 0 of
 * this poll's board), records: against `transcript`, the definition's
 * commitment, for a panel of `panelSize` seats.
 */
export function ceremonyView(
  entry: string,
  version: BoardEntryVersion,
  transcript: { readonly hash: string; readonly pinned: boolean },
  panelSize: number,
): CeremonyView {
  const { payload } = decodeBoardEntry(fromHex(entry), version);
  // The record header's first two bytes are its type, big-endian (docs/spec/notation.md).
  if (((payload[0] ?? 0) << 8) + (payload[1] ?? 0) !== RECORD_TYPES.ceremonyTranscript)
    return { kind: "missing" };
  if (!transcript.pinned) return { kind: "undecodable" };
  let decoded;
  try {
    decoded = decodeCeremonyTranscript(payload, 1);
  } catch (error) {
    if (error instanceof DecodeError || error instanceof RangeError) return { kind: "undecodable" };
    throw error;
  }
  const hash = toHex(ceremonyTranscriptHash(payload));
  const rounds = [decoded.keys, decoded.challenges, decoded.answers, decoded.reveals];
  return {
    kind: "transcript",
    hash,
    committed: hash === transcript.hash,
    seats: Array.from({ length: panelSize }, (_, i) => ({
      index: i + 1,
      rounds: rounds.filter((messages) => messages.some((m) => m.index === i + 1)).length,
    })),
  };
}
