// Contract-event evidence (docs/spec/archive.md, Contract-event evidence):
// one contract's event accumulator proven at one L2 block under the output
// root a dispute game on L1 claims, archived beside the board so 4.4 and 4.6
// can replay a contract's events once no L2 node serves its state (T-49,
// T-51). A record is read by the CID a version-2 manifest lists it under and
// held to that listing's claim; nothing it says is trusted beyond what its
// proof shows, and it is worth exactly its output root, which until P1-19
// reads dispute games is the record's word, as a bundle's is (T-71). None of
// this fails an election: evidence that doesn't hold up leaves what needs it
// unverifiable (T-53).

import {
  type ContractEventEvidence,
  DecodeError,
  decodeContractEventEvidence,
  MAX_EVIDENCE_HEADER,
  MAX_EVIDENCE_NODES,
  MAX_TRIE_NODE,
  readArchivedObject,
} from "@abolishus/crypto";
import type { EvidenceListing, TransactionSource } from "./archive.ts";
import {
  accumulatorAndNodesUsed,
  type OutputRootAccumulator,
  OutputRootError,
  type OutputRootErrorCode,
} from "./output-root.ts";

/**
 * The longest record version 1 encodes: the record's three bytes of framing,
 * its fixed fields, the longest header and every node at its longest
 * (docs/spec/archive.md, Layout (version 1)), so always one raw block.
 */
export const MAX_EVIDENCE_RECORD =
  3 +
  8 +
  20 +
  8 +
  20 +
  32 +
  32 +
  4 +
  MAX_EVIDENCE_HEADER +
  4 +
  MAX_EVIDENCE_NODES * (4 + MAX_TRIE_NODE);

/**
 * The most a record's transaction data can be: the CAR of one raw block (a
 * 59-byte header, a 3-byte length, the 36-byte CID and the block).
 */
export const EVIDENCE_DATA_LIMIT = 59 + 3 + 36 + MAX_EVIDENCE_RECORD;

/** Why a record proves nothing for its listing (docs/spec/archive.md, The evidence check). */
export type EvidenceCheckCode =
  /** Another L2, or another contract than the listing claims. */
  | "evidence-foreign"
  | OutputRootErrorCode
  /** The header's block isn't the one the listing claims. */
  | "evidence-block"
  /** A node no walk of the proof uses. */
  | "evidence-node-unused";

/** What a record that passes proves, and the game whose claim it is worth. */
export interface ProvenEvidence {
  /** The contract's accumulator and count, at the header's block, number and timestamp. */
  readonly accumulator: OutputRootAccumulator;
  readonly gameIndex: bigint;
  readonly game: Uint8Array;
  readonly outputRoot: Uint8Array;
}

export type EvidenceCheck =
  | ({ readonly ok: true } & ProvenEvidence)
  | { readonly ok: false; readonly code: EvidenceCheckCode };

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The evidence check (docs/spec/archive.md, The evidence check), in order,
 * the first that fails the result: the record is the definition's L2's and
 * the listing's contract; the contract's accumulator and count are read
 * under the record's output root from its header and nodes, with the output
 * root's codes; the header's block is the listing's; and every node is one
 * those walks used, so a record carries no bytes its proof doesn't need
 * (T-17). A pass is worth what `output_root` is, which no reader checks on
 * L1 before P1-19 (T-71).
 */
export function checkContractEventEvidence(
  record: ContractEventEvidence,
  claim: Pick<EvidenceListing, "contract" | "l2Block">,
  l2ChainId: bigint,
): EvidenceCheck {
  if (!(claim.contract instanceof Uint8Array) || claim.contract.length !== 20)
    throw new RangeError("a contract address is 20 bytes");
  if (record.l2_chain_id !== l2ChainId || !equal(record.contract, claim.contract))
    return { ok: false, code: "evidence-foreign" };
  let accumulator: OutputRootAccumulator;
  let allNodesUsed: boolean;
  try {
    ({ accumulator, allNodesUsed } = accumulatorAndNodesUsed(
      {
        outputRoot: record.output_root,
        messagePasserStorageRoot: record.message_passer_storage_root,
        header: record.header,
        nodes: record.nodes,
      },
      record.contract,
    ));
  } catch (e) {
    if (e instanceof OutputRootError) return { ok: false, code: e.code };
    throw e;
  }
  if (accumulator.block !== claim.l2Block) return { ok: false, code: "evidence-block" };
  if (!allNodesUsed) return { ok: false, code: "evidence-node-unused" };
  return {
    ok: true,
    accumulator,
    gameIndex: record.game_index,
    game: record.game,
    outputRoot: record.output_root,
  };
}

/** What reading one evidence listing came to. None is a verdict on an election. */
export type EvidenceRead =
  | ({ readonly kind: "proven"; readonly transaction: Uint8Array } & ProvenEvidence)
  /** Data that reads as the CID but checks as nothing for the listing: the CID fixes the bytes. */
  | {
      readonly kind: "evidence-check";
      readonly code: EvidenceCheckCode;
      readonly transaction: Uint8Array;
    }
  /** Data that reads as the CID but isn't a version-1 record: the CID fixes the bytes. */
  | { readonly kind: "evidence-malformed"; readonly transaction: Uint8Array }
  /** No source served data that reads as the CID from any transaction listing it. */
  | { readonly kind: "evidence-unavailable"; readonly transactions: readonly Uint8Array[] };

/**
 * Reads the record a listing names from its transactions, in walk order,
 * each answer within `EVIDENCE_DATA_LIMIT`, until one reads as its CID
 * within `MAX_EVIDENCE_RECORD` (docs/spec/archive.md, Archived objects),
 * then decodes it under version 1, the version manifest version 2 lists,
 * and checks it against the listing's claim. Data that reads as the CID
 * settles the listing whatever comes of it, since no other transaction can
 * serve other bytes under that CID; an answer that doesn't read is that
 * source's failure (T-24). A caller bounds what it asks by the listings it
 * reads: each asks at most its transactions, one data limit per answer
 * (T-52).
 */
export async function readEvidence(
  listing: EvidenceListing,
  l2ChainId: bigint,
  source: TransactionSource,
): Promise<EvidenceRead> {
  for (const transaction of listing.transactions) {
    for await (const data of await source(transaction, EVIDENCE_DATA_LIMIT)) {
      // A source past the limit is that source's failure, never parsed (T-52).
      if (data.length > EVIDENCE_DATA_LIMIT) continue;
      const got = readArchivedObject(data, listing.cid, MAX_EVIDENCE_RECORD);
      if (!got.ok) continue;
      let record: ContractEventEvidence;
      try {
        record = decodeContractEventEvidence(got.bytes, 1);
      } catch (e) {
        if (e instanceof DecodeError) return { kind: "evidence-malformed", transaction };
        throw e;
      }
      const check = checkContractEventEvidence(record, listing, l2ChainId);
      if (!check.ok) return { kind: "evidence-check", code: check.code, transaction };
      return {
        kind: "proven",
        transaction,
        accumulator: check.accumulator,
        gameIndex: check.gameIndex,
        game: check.game,
        outputRoot: check.outputRoot,
      };
    }
  }
  return { kind: "evidence-unavailable", transactions: listing.transactions };
}

/**
 * How many transactions the board's evidence reads ask of the sources when
 * the caller sets nothing: an honest archive serves the latest record from
 * its first transaction, and a few more cover records lost and listed again,
 * or written for a later block than the bundle's events reach.
 */
export const DEFAULT_EVIDENCE_READS = 64;

/**
 * One report on a contract's archived evidence (docs/spec/verifier.md,
 * Archive, step 5). None is a verdict, and none is 4.3's: the evidence
 * is read for 4.6, which a record that doesn't hold up leaves where the
 * bundle's own evidence puts it (T-53).
 */
export type EvidenceFinding =
  /** The walk kept no more references than its budget: what it found is partial. */
  | { readonly code: "evidence-over-budget"; readonly budget: number }
  | {
      readonly code: "evidence-malformed";
      readonly l2Block: bigint;
      readonly cid: Uint8Array;
      readonly transaction: Uint8Array;
    }
  | {
      readonly code: "evidence-check";
      readonly check: EvidenceCheckCode;
      readonly l2Block: bigint;
      readonly cid: Uint8Array;
      readonly transaction: Uint8Array;
    }
  | {
      readonly code: "evidence-unavailable";
      readonly l2Block: bigint;
      readonly cid: Uint8Array;
      readonly transactions: readonly Uint8Array[];
    }
  /** Proven, but over more events than the bundle carries, so nothing could replay it. */
  | {
      readonly code: "evidence-count";
      readonly l2Block: bigint;
      readonly cid: Uint8Array;
      readonly count: bigint;
    }
  /** The reads ran out before a record was proven: unverifiable for this reader. */
  | { readonly code: "evidence-reads-over-budget"; readonly maxReads: number };

/** The record a contract's accumulator is taken from, with the listing it was read under. */
export interface ArchivedAccumulator extends ProvenEvidence {
  readonly cid: Uint8Array;
  readonly transaction: Uint8Array;
}

/** What reading a contract's archived evidence came to. */
export interface ContractEvidence {
  /** The latest record proven over at most the bundle's events, if any was. */
  readonly proven?: ArchivedAccumulator;
  /** Transactions asked of the sources, against `maxReads`. */
  readonly reads: number;
  readonly findings: readonly EvidenceFinding[];
}

/**
 * The latest of a contract's archived accumulators that the bundle's events
 * can replay (docs/spec/verifier.md, Archive, step 5): its listings are
 * read from the latest claimed block down, ties in walk order, and the first
 * record proven with a count of at most `events` is taken. A later record
 * serves every point an earlier one does, since the replay judges each event
 * by its own L2 timestamp, so one is enough; one over more events than the
 * bundle carries is passed over, since no replay of them could hold.
 * Whatever comes of a listing is reported, and every transaction asked
 * counts against `maxReads`, so an authority listing many dead or
 * failing records costs at most that many asks (T-52).
 */
export async function latestEvidence(
  listings: readonly EvidenceListing[],
  l2ChainId: bigint,
  events: number,
  source: TransactionSource,
  maxReads: number = DEFAULT_EVIDENCE_READS,
): Promise<ContractEvidence> {
  if (!Number.isSafeInteger(maxReads) || maxReads < 1)
    throw new RangeError("maxReads must be a positive integer");
  const findings: EvidenceFinding[] = [];
  let reads = 0;
  // `sort` is stable, so listings of one block stay in walk order.
  const order = [...listings].sort((a, b) =>
    a.l2Block > b.l2Block ? -1 : a.l2Block < b.l2Block ? 1 : 0,
  );
  for (const listing of order) {
    const { l2Block, cid } = listing;
    const left = maxReads - reads;
    if (left === 0) {
      findings.push({ code: "evidence-reads-over-budget", maxReads });
      break;
    }
    const asked = listing.transactions.slice(0, left);
    const read = await readEvidence({ ...listing, transactions: asked }, l2ChainId, source);
    // A settled listing stopped at its transaction; an unavailable one asked them all.
    reads +=
      read.kind === "evidence-unavailable"
        ? asked.length
        : asked.findIndex((t) => equal(t, read.transaction)) + 1;
    switch (read.kind) {
      case "proven":
        if (read.accumulator.count > BigInt(events)) {
          findings.push({ code: "evidence-count", l2Block, cid, count: read.accumulator.count });
          continue;
        }
        return {
          proven: {
            accumulator: read.accumulator,
            gameIndex: read.gameIndex,
            game: read.game,
            outputRoot: read.outputRoot,
            cid,
            transaction: read.transaction,
          },
          reads,
          findings,
        };
      case "evidence-check":
        findings.push({
          code: "evidence-check",
          check: read.code,
          l2Block,
          cid,
          transaction: read.transaction,
        });
        continue;
      case "evidence-malformed":
        findings.push({ code: "evidence-malformed", l2Block, cid, transaction: read.transaction });
        continue;
      case "evidence-unavailable":
        // Transactions left unasked may serve it: the budget's, not the archive's.
        if (asked.length < listing.transactions.length) {
          findings.push({ code: "evidence-reads-over-budget", maxReads });
          return { reads, findings };
        }
        findings.push({ code: "evidence-unavailable", l2Block, cid, transactions: asked });
    }
  }
  return { reads, findings };
}
