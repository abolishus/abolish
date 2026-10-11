import * as z from "zod/mini";

// Wire forms shared by every procedure. These schemas only check transport
// shape and bounds: they never define protocol bytes. A byte string here is
// opaque to the contract, and its meaning (and strict decoding) belongs to
// `@abolishus/crypto` per docs/spec/ (T-31).

/**
 * `MAX_BOARD_PAYLOAD` from docs/spec/parameters.md: the largest record a board
 * entry carries, in bytes. A test ties this copy to the spec table.
 */
export const MAX_BOARD_PAYLOAD = 1_048_576;

/**
 * What a board entry (record `0x0007` v1, docs/spec/board.md) adds around its
 * payload: the record header (3), `election_id` (32), `index` (8), `segment`
 * (4) and the payload's `u32` length prefix (4).
 */
const BOARD_ENTRY_OVERHEAD = 3 + 32 + 8 + 4 + 4;

/** The largest encoded board entry the API carries. */
export const MAX_BOARD_ENTRY = MAX_BOARD_PAYLOAD + BOARD_ENTRY_OVERHEAD;

/** Most entries one page of the board returns. */
export const MAX_PAGE = 256;

/**
 * Most entry bytes one page returns, unless the page holds a single entry
 * (which can be up to `MAX_BOARD_ENTRY`). A server returns fewer entries than
 * asked rather than exceed it, so a page stays bounded however large the
 * entries are (T-48, T-52).
 */
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;

/**
 * Most hashes in a Merkle audit or consistency path. A tree of up to 2^64
 * entries needs at most 64 for an inclusion proof and 2·64 for a consistency
 * proof (RFC 9162, §2.1.3 and §2.1.4).
 */
export const MAX_PROOF_PATH = 128;

const U64_MAX = (1n << 64n) - 1n;
const U64_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;

/**
 * Bytes as lowercase hex, two digits per byte, no `0x` (docs/spec/notation.md).
 * Exactly one string encodes each byte string, so two services never disagree
 * on which bytes a request carried (T-31). The length bound is checked first
 * and aborts, so an oversize value never reaches the pattern (T-52).
 */
export function hexBytes(maxBytes: number) {
  return z
    .string()
    .check(
      z.maxLength(2 * maxBytes, { abort: true }),
      z.regex(/^(?:[0-9a-f]{2})*$/, "expected lowercase hex, two digits per byte"),
    );
}

/** Exactly `n` bytes as lowercase hex. */
export function hexFixed(n: number) {
  return z
    .string()
    .check(z.length(2 * n, { abort: true }), z.regex(/^[0-9a-f]*$/, "expected lowercase hex"));
}

/** A 32-byte value: `election_id`, an entry hash, a chain link or a tree root. */
export const Hash32 = hexFixed(32);

/**
 * A `u64` as a canonical decimal string: no sign, no leading zeros, at most
 * 2^64 − 1. Board positions and tree sizes are `u64` (docs/spec/board.md),
 * which a JSON number can't carry exactly above 2^53, and a decimal string is
 * what query parameters carry anyway.
 */
export const U64 = z.string().check(
  // The pattern also reaches the OpenAPI document, which the refinement can't.
  // The refinement re-tests it, so BigInt never sees a non-decimal string.
  z.regex(U64_PATTERN, "expected a canonical decimal u64"),
  z.refine((s) => U64_PATTERN.test(s) && BigInt(s) <= U64_MAX, "exceeds 2^64 - 1"),
);

const PAGE_SIZE_PATTERN = /^[1-9][0-9]{0,3}$/;

/** A page size from 1 to `MAX_PAGE`, as a canonical decimal string. */
export const PageSize = z.string().check(
  z.regex(PAGE_SIZE_PATTERN, "expected a canonical decimal page size"),
  z.refine((s) => PAGE_SIZE_PATTERN.test(s) && Number(s) <= MAX_PAGE, `exceeds ${MAX_PAGE}`),
);
