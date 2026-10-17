// Verify what was pinned (docs/status/P4-5.md, part 3): for every election
// the board anchor's checkpoints name on L1, the verifier's own checks over
// the board copy read by CID from the node's directory, with every other
// input read from L1 and L2, never from our servers (T-24, T-49, T-51). The
// node only gathers inputs into a format-4 bundle the verifier parses as
// strictly as one on disk, and judges nothing itself: the report is
// `verifyBundle`'s. Each election's bundle and report are written beside
// each other, so anyone can rerun `abolish-verify` on the same inputs.
//
// Where each input comes from, and what the node is trusted for:
//
// - The board copy: the directory's blocks, each hashed against its CID and
//   authenticated against the anchored heads and roots by the board checks.
// - The anchors and `now`: proven against the finalized L1 header's state
//   root (src/l1.ts); the L1 node is trusted for which block is finalized.
// - The definition and the creation's L1 origin (so `f`): the election
//   registry's logs (src/l2.ts); the panel: the trustee registry's. The L2
//   node is trusted for them, and the verifier reports them as local inputs.
// - The clock's `epoch`, `period` and `deadline`: the anchor's getters; its
//   seal, `lastSegment`: the highest proven checkpoint's segment, since no
//   seal is derived from a definition yet ([[election-definition]], The seal).
//
// Every one of these is reported by the verifier as an unauthenticated input
// where it is one, so the verdict stays unverifiable while any is (T-53).

import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AnyElectionDefinitionRecord,
  type Checkpoint,
  CHUNK_SIZE,
  encodeCheckpoint,
  type EventContracts,
} from "@abolishus/crypto";
import {
  type BlockStore,
  BUNDLE_FORMAT_CEREMONY,
  BundleError,
  L1Error,
  type L1Header,
  parseBundle,
  readBoardByCid,
  receiptKeySlot,
  type Verdict,
  verifyBundle,
} from "@abolishus/verifier";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { type AnchorTiming, loggedCheckpoints, provenCheckpoints } from "./l1.ts";
import { L2Error, pinnedPanel, registration } from "./l2.ts";
import { type Rpc, RpcError } from "./rpc.ts";
import type { Mirror } from "./store.ts";

const U32_MAX = 0xffff_ffffn;

/** Why an election wasn't verified, beside the L1 and L2 errors' own codes. */
export type SkipCode =
  /** The definition names another board anchor than the one the node reads. */
  | "definition-anchor"
  /** The definition names another election registry than the one it was read from. */
  | "definition-registry"
  /** The definition names other chains than the nodes' (`eth_chainId`). */
  | "definition-chain"
  /** The creation's L1 origin is before the clock's epoch, or past its last `u32` segment. */
  | "creation-outside-clock"
  /** No logged checkpoint is one the anchor holds: there is no board to verify. */
  | "unanchored";

export type VerifyReport =
  | { readonly election: string; readonly error: string }
  | {
      readonly election: string;
      readonly verdict: Verdict;
      readonly verdictAgainstInputs: Verdict;
      readonly entries: number;
      /** The directory holding `bundle.json` and `report.json`. */
      readonly report: string;
    };

export interface VerifyOptions {
  readonly l1: Rpc;
  readonly anchor: Uint8Array;
  readonly header: L1Header;
  /** The header as RLP, for the bundle. */
  readonly headerRlp: Uint8Array;
  readonly timing: AnchorTiming;
  readonly l2: Rpc;
  readonly registry: Uint8Array;
  /** Each node's `eth_chainId`: the chains a definition must name. */
  readonly l1ChainId: bigint;
  readonly l2ChainId: bigint;
  /** The L2 block logs are read up to: the L2 node's finalized one. */
  readonly l2Finalized: bigint;
  readonly mirror: Mirror;
  /** Where each election's bundle and report go, under its identifier in hex. */
  readonly reports: string;
  /** The first L1 block whose logs are read: the anchor's deployment, or 0. */
  readonly fromBlock: bigint;
  /** The first L2 block whose logs are read: the registries' deployment, or 0. */
  readonly l2FromBlock: bigint;
  /** The byte budget for one election's board copy. */
  readonly maxBoardBytes: number;
  readonly report: (r: VerifyReport) => void;
}

/** What one run read from L1: how many logs it refused. */
export interface VerifyRun {
  readonly refusedLogs: number;
}

/** The mirror as the verifier's block store: the directory's blocks, nothing else. */
export function mirrorStore(mirror: Mirror): BlockStore {
  let blocks = 0;
  let unreadableBytes = 0;
  for (const f of mirror.files) {
    if ("error" in f) continue;
    blocks += f.blocks;
    unreadableBytes += f.unreadableBytes;
  }
  return {
    source: async (cid, limit) => {
      const block = await mirror.block(cid);
      return block !== undefined && block.length <= Math.min(limit, CHUNK_SIZE) ? [block] : [];
    },
    blocks,
    unreadableBytes,
  };
}

const contractsOf = (d: AnyElectionDefinitionRecord["value"]): EventContracts => ({
  electionRegistry: d.election_registry,
  trusteeRegistry: d.trustee_registry,
  groupRegistry: d.group_registry,
  board: d.board,
});

const hex = (b: Uint8Array) => bytesToHex(b);
const same = (a: Uint8Array, b: Uint8Array) => hex(a) === hex(b);

// Writes `text` to `path` through a temporary file and a rename, so a
// reader (`serve`) never sees half a report.
async function writeWhole(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.partial`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

/**
 * Most bytes of proof nodes one election's bundle holds: as hex in one JSON
 * text they must stay far below the longest string the runtime can make,
 * whatever the L1 node answers (T-52).
 */
export const MAX_BUNDLE_PROOF_BYTES = 64 * 1024 * 1024;

// An RPC error as the node reports it, naming which chain's node failed.
const tagged = (chain: "l1" | "l2") => (e: unknown) => {
  throw e instanceof RpcError ? new RpcError(`${chain}: ${e.message}`) : e;
};

// One election's bundle, as JSON, or why it can't be gathered.
async function gather(
  options: VerifyOptions,
  election: string,
  checkpoints: readonly Checkpoint[],
): Promise<{ readonly json: string } | { readonly error: string }> {
  const { l1, anchor, header, timing, l2, registry } = options;
  const reg = await registration(
    l2,
    registry,
    hexToBytes(election),
    options.l2FromBlock,
    options.l2Finalized,
  ).catch(tagged("l2"));
  const d = reg.decoded.value;
  // The L1 evidence is the node's anchor's on the node's L1, and the
  // definition was read from the node's registry on its L2: a definition
  // naming others would be judged against evidence that isn't its own.
  if (!same(d.l1_anchor, anchor)) return { error: "definition-anchor" };
  if (!same(d.election_registry, registry)) return { error: "definition-registry" };
  if (d.l1_chain_id !== options.l1ChainId || d.l2_chain_id !== options.l2ChainId)
    return { error: "definition-chain" };
  // `f` is the period containing the creation's L1 origin
  // (docs/spec/contracts.md, Board anchor, Verification).
  const origin = reg.created.timestamp;
  const f = origin < timing.epoch ? -1n : (origin - timing.epoch) / timing.period;
  if (f < 0n || f > U32_MAX) return { error: "creation-outside-clock" };
  const panel = await pinnedPanel(
    l2,
    contractsOf(d),
    d.panel_id,
    options.l2FromBlock,
    options.l2Finalized,
  ).catch(tagged("l2"));
  // Definition versions 4 and later list receipt keys, which 2.9 judges
  // from the anchor's record in the same L1 state.
  const keys = "receipt_keys" in d ? d.receipt_keys : [];
  const proven = await provenCheckpoints(l1, anchor, header, checkpoints, {
    extraSlots: keys.map(receiptKeySlot),
    maxProofBytes: MAX_BUNDLE_PROOF_BYTES,
  }).catch(tagged("l1"));
  // In segment order, as the reader proves them.
  const seal = proven.checkpoints.at(-1)?.segment;
  if (seal === undefined) return { error: "unanchored" };
  const json = JSON.stringify(
    {
      format: BUNDLE_FORMAT_CEREMONY,
      definition: hex(reg.definition),
      clock: {
        epoch: timing.epoch.toString(),
        period: timing.period.toString(),
        deadline: timing.deadline.toString(),
        lastSegment: seal.toString(),
      },
      l1: {
        firstSegment: f.toString(),
        header: hex(options.headerRlp),
        nodes: proven.nodes.map(hex),
        // Every logged checkpoint: the verifier counts only those whose
        // hash is a word it proves.
        checkpoints: checkpoints.map((c) => hex(encodeCheckpoint(c))),
      },
      panel: { threshold: panel.threshold.toString(), keys: panel.keys.map(hex) },
    },
    null,
    2,
  );
  return { json };
}

/**
 * One run: every `CheckpointAnchored` log up to the header's block, and,
 * election by election, its inputs from L1 and L2, the bundle, the copy read
 * from the mirror and the verifier's report. Each election is reported as it
 * is done; one whose inputs can't be read is reported and skipped. Throws
 * only if the logs can't be read (`RpcError`) or the reports can't be written.
 */
export async function verifyElections(options: VerifyOptions): Promise<VerifyRun> {
  const { report } = options;
  if (!Number.isSafeInteger(options.maxBoardBytes) || options.maxBoardBytes < 1)
    throw new RangeError("maxBoardBytes must be a positive integer");
  const logged = await loggedCheckpoints(
    options.l1,
    options.anchor,
    options.header,
    options.fromBlock,
  );
  const store = mirrorStore(options.mirror);
  for (const [election, checkpoints] of logged.elections) {
    const skip = (error: string) => report({ election, error });
    let gathered;
    try {
      gathered = await gather(options, election, checkpoints);
    } catch (e) {
      if (!(e instanceof L1Error) && !(e instanceof L2Error) && !(e instanceof RpcError)) throw e;
      skip(e.message);
      continue;
    }
    if ("error" in gathered) {
      skip(gathered.error);
      continue;
    }
    const { json } = gathered;
    let parsed;
    try {
      parsed = parseBundle(json, new Uint8Array());
    } catch (e) {
      // Inputs no bundle may hold, a panel the panel identifier refuses
      // among them: no report, as for any rejected bundle.
      if (!(e instanceof BundleError)) throw e;
      skip(`bundle: ${e.message}`);
      continue;
    }
    const bundle = await readBoardByCid(parsed, store, options.maxBoardBytes);
    const result = verifyBundle(bundle);
    const dir = join(options.reports, election);
    await mkdir(dir, { recursive: true });
    await writeWhole(join(dir, "bundle.json"), `${json}\n`);
    await writeWhole(join(dir, "report.json"), `${JSON.stringify(result, null, 2)}\n`);
    report({
      election,
      verdict: result.verdict,
      verdictAgainstInputs: result.verdictAgainstInputs,
      entries: result.board.entries,
      report: dir,
    });
  }
  return { refusedLogs: logged.refused };
}
