// The board anchor's earlier archive locators, from its `ArchiveLocated`
// logs (docs/spec/verifier.md, Archive, step 2; docs/spec/contracts.md,
// Archive locator). A bundle may carry the anchor's whole log sequence;
// replayed against the event accumulator the anchor keeps in its own state,
// proven at `B` under the bundle's L1 header, it is exactly the anchor's own
// sequence up to `B`, nothing left out, added or reordered, so a locator a
// seized authority overwrote in state can still be seen in the log that
// carried it, while L1 history serves the logs (T-69, T-24). Only Keccak-256
// and the accumulator's step come from libraries; the ABI framing read here
// is the anchor's own `abi.encode(locator)`.

import {
  type ArchivedContractLog,
  checkEventAccumulatorProof,
  type ContractLog,
  type EventAccumulatorProofError,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { L1Error, type L1Evidence, contractStorageRoot, storageWord, word } from "./l1.ts";
import { ACCUMULATOR_SLOT } from "./output-root.ts";

/** `keccak256("ArchiveLocated(uint16,bytes)")`, the event's `topics[0]`. */
export const ARCHIVE_LOCATED = keccak_256(new TextEncoder().encode("ArchiveLocated(uint16,bytes)"));

/** The longest locator the anchor accepts (docs/spec/contracts.md, Archive locator). */
const MAX_LOCATOR_LENGTH = 128;

/**
 * Why the anchor's logs give no earlier locators: a rule of the accumulator's
 * Verification they break, a count word no contract writes (`count`), an
 * `ArchiveLocated` log that isn't the anchor's framing of a locator
 * (`locator-log`), or logs whose locators disagree with the anchor's state
 * (`locators`: their number isn't the count posted, or the last isn't the
 * latest). Only code other than the release's could write any but the first
 * four, and those four are a bundle that isn't the anchor's whole sequence.
 */
export type AnchorLogsRule = EventAccumulatorProofError | "count" | "locator-log" | "locators";

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const wordValue = (w: Uint8Array) => w.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

// The locator `abi.encode(locator)` holds, or undefined unless `data` is
// exactly that encoding of a locator of 3 to 128 bytes: the offset word
// 0x20, the length word, the bytes and zero padding to a whole word, nothing
// after, and the version topic the locator's own first two bytes.
function locatorOf(log: ContractLog): Uint8Array | undefined {
  const { topics, data } = log;
  if (topics.length !== 2 || data.length < 96 || data.length % 32 !== 0) return undefined;
  if (wordValue(data.subarray(0, 32)) !== 32n) return undefined;
  const len = wordValue(data.subarray(32, 64));
  if (len < 3n || len > BigInt(MAX_LOCATOR_LENGTH)) return undefined;
  const n = Number(len);
  if (data.length !== 64 + Math.ceil(n / 32) * 32) return undefined;
  if (data.subarray(64 + n).some((x) => x !== 0)) return undefined;
  const locator = data.slice(64, 64 + n);
  const version = word(BigInt((locator[0] as number) * 256 + (locator[1] as number)));
  return equal(topics[1] as Uint8Array, version) ? locator : undefined;
}

/**
 * The locators of the anchor's `ArchiveLocated` logs at or before `B`, in
 * log order, from `logs`, the anchor's logs from its first in order of `n`
 * (later ones allowed, and ignored), checked against the accumulator and
 * count proven in the anchor's storage at `B` (docs/spec/contracts.md, Event
 * accumulator, Verification), and against the latest locator and the count
 * posted, as `latestLocatorFromState` read them. Throws `L1Error` where the
 * accumulator's words can't be proven, as the anchors' words can't.
 */
export function earlierLocators(
  l1: Pick<L1Evidence, "header" | "anchor" | "nodes">,
  l1ChainId: bigint,
  logs: readonly ContractLog[],
  latest: { readonly locator: Uint8Array; readonly count: bigint },
): { readonly locators: readonly Uint8Array[] } | { readonly rule: AnchorLogsRule } {
  const root = contractStorageRoot(l1.nodes, l1.header.stateRoot, l1.anchor);
  if (root === undefined) throw new L1Error("l1-anchor-absent");
  const read = (slot: bigint) => storageWord(l1.nodes.get(root, keccak_256(word(slot))));
  const accumulator = read(ACCUMULATOR_SLOT);
  const countWord = read(ACCUMULATOR_SLOT + 1n);
  // A count over 64 bits is no count the accumulator writes.
  if (countWord.subarray(0, 24).some((x) => x !== 0)) return { rule: "count" };
  const count = wordValue(countWord);
  const archived: ArchivedContractLog[] = logs.map((log, i) => ({ ...log, n: BigInt(i) }));
  const broken = checkEventAccumulatorProof(l1ChainId, l1.anchor, archived, {
    block: l1.header.number,
    accumulator,
    count,
  });
  if (broken !== null) return { rule: broken };
  // Rule 2 put every counted log at or before `B`, and none after it.
  const locators: Uint8Array[] = [];
  for (const log of logs.slice(0, Number(count))) {
    if (!equal(log.topics[0] as Uint8Array, ARCHIVE_LOCATED)) continue;
    const locator = locatorOf(log);
    if (locator === undefined) return { rule: "locator-log" };
    locators.push(locator);
  }
  // Each locator the anchor stores is logged in the same call, and counted.
  const last = locators.at(-1);
  if (
    BigInt(locators.length) !== latest.count ||
    last === undefined ||
    !equal(last, latest.locator)
  )
    return { rule: "locators" };
  return { locators };
}
