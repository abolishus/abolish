// Check 2.9 (docs/spec/verifier.md, Receipt keys from L1): every receipt key
// a version-4 definition lists judges the election, by its word in the board
// anchor's receipt-key record, proven from L1 state at the verifier's block
// `B`, never from a call or a list of logs (T-26, T-69, T-71). The judging
// rule and the word's reading are packages/crypto's (`receiptKeyJudgement`,
// `receiptKeyRecordFromWord`), which the ballot client's check before casting
// shares.

import { receiptKeyJudgement, receiptKeyRecordFromWord } from "@abolishus/crypto";
import { L1Error, type L1ErrorCode, type L1Evidence, receiptKeyWords } from "./l1.ts";

export type ReceiptKeyCode =
  | "receipt-key-retired"
  | "receipt-key-unregistered"
  | "receipt-key-record"
  | "receipt-key-unsettled";

export type ReceiptKeyRow =
  | { readonly status: "pass" }
  | {
      readonly status: "fail" | "unverifiable";
      readonly code: ReceiptKeyCode | L1ErrorCode;
      readonly at: { readonly key: number } | Record<string, never>;
    };

/**
 * 2.9's row for `keys` (a version-4 definition's `receipt_keys`) and
 * `opensAt`, from `l1`, whose anchor is the definition's `l1_anchor`. Keys
 * are judged in list order: the first that fails the election is reported
 * (`receipt-key-record`, `receipt-key-retired`, `receipt-key-unregistered`),
 * since each is final whatever an unread or unsettled key turns out to be;
 * otherwise the first key whose word can't be read (an L1 code) or that
 * isn't settled yet (`receipt-key-unsettled`, `B` before `opensAt`) leaves
 * the row unverifiable; otherwise it passes.
 */
export function receiptKeyRow(
  l1: L1Evidence,
  keys: readonly Uint8Array[],
  opensAt: bigint,
): ReceiptKeyRow {
  let words: (Uint8Array | L1Error)[];
  try {
    words = receiptKeyWords(l1, keys);
  } catch (e) {
    if (e instanceof L1Error) return { status: "unverifiable", code: e.code, at: {} };
    throw e;
  }
  const provenAt = l1.header.timestamp;
  let unverifiable: ReceiptKeyRow | undefined;
  for (const [i, w] of words.entries()) {
    if (!(w instanceof Uint8Array)) {
      unverifiable ??= { status: "unverifiable", code: w.code, at: { key: i } };
      continue;
    }
    const r = receiptKeyRecordFromWord(w, provenAt);
    if (r === undefined) return { status: "fail", code: "receipt-key-record", at: { key: i } };
    const judgement = receiptKeyJudgement(r, opensAt, provenAt);
    switch (judgement) {
      case "judges":
        break;
      case "retired":
        return { status: "fail", code: "receipt-key-retired", at: { key: i } };
      case "unregistered":
        return { status: "fail", code: "receipt-key-unregistered", at: { key: i } };
      case "unsettled":
        unverifiable ??= { status: "unverifiable", code: "receipt-key-unsettled", at: { key: i } };
        break;
      default: {
        const unknown: never = judgement;
        throw new Error(`unmapped receipt-key judgement ${String(unknown)}`);
      }
    }
  }
  return unverifiable ?? { status: "pass" };
}
