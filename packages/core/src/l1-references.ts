// L1 references at submission (verifier 5.8; docs/spec/revoting.md,
// Admission): a ballot naming a block before the poll's window, after its
// close, or a finalized block by the wrong hash is one the verifier will
// reject whatever else happens, so the server needn't spend a board entry on
// it (T-17, T-52). The verdicts are @abolishus/crypto's `l1RefMin` and
// `checkL1Reference`, run unchanged over finalized L1 blocks read from a node
// (AGENTS.md, The verifier's trust base): this file only fetches the blocks
// they ask for. A reference beyond the finalized head is `pending`, which is
// how an honest client's ballot arrives (it names a block 2 deep, about 13
// minutes before L1 finalizes it), so only definite rejections are refused.

import {
  checkL1Reference,
  type FinalizedL1,
  type FinalizedL1Block,
  type L1ReferenceVerdict,
  l1RefMin,
} from "@abolishus/crypto";

/** Finalized L1 blocks, as one node reports them. */
export interface FinalizedL1Source {
  /** The node's EIP-155 chain ID, checked when the source was made. */
  readonly chainId: bigint;
  /** The number of the node's latest finalized block. */
  finalizedHead(): Promise<bigint>;
  /** Finalized block `n`, asked for only at or below a head `finalizedHead` reported. */
  block(n: bigint): Promise<FinalizedL1Block>;
}

export interface L1ReferenceOptions {
  readonly source: FinalizedL1Source;
  /** How long a finalized head is used before it is read again; one L1 slot by default. */
  readonly headTtlMs?: number;
  /** Finalized blocks kept in memory (default 4,096). */
  readonly cacheSize?: number;
  /**
   * How long one judgement may wait on the node (2 s by default). A node that
   * fails or runs out of time is not asked again for a head's lifetime, so a
   * slow node delays one ballot's batch by this much, never every ballot.
   */
  readonly budgetMs?: number;
  /** Milliseconds, for the head's lifetime and the budget; `Date.now` unless a test moves it. */
  readonly now?: () => number;
}

/**
 * Blocks one judgement may read. Finding `l1_ref_min` from block 0 probes
 * about 25 blocks on a chain of tens of millions, and a reference reads one
 * more, so a bound well above that only stops a source that never settles.
 */
const MAX_READS = 128;

/** Thrown out of a check by a block that isn't kept yet. */
class Missing {
  readonly n: bigint;
  constructor(n: bigint) {
    this.n = n;
  }
}

/** Judges ballots' L1 references against one node's finalized chain. */
export class L1References {
  readonly chainId: bigint;
  readonly #source: FinalizedL1Source;
  readonly #headTtlMs: number;
  readonly #cacheSize: number;
  readonly #budgetMs: number;
  readonly #now: () => number;
  readonly #blocks = new Map<bigint, FinalizedL1Block>();
  // `l1_ref_min` depends only on `opens_at`, and once found among finalized
  // blocks it never changes, so it is kept per `opens_at` (bounded like the
  // blocks). A window L1 hasn't reached yet is never kept.
  readonly #mins = new Map<bigint, bigint>();
  #head: { readonly number: bigint; readonly at: number } | undefined;
  #downUntil = Number.NEGATIVE_INFINITY;

  constructor({
    source,
    headTtlMs = 12_000,
    cacheSize = 4096,
    budgetMs = 2_000,
    now = Date.now,
  }: L1ReferenceOptions) {
    if (!Number.isSafeInteger(headTtlMs) || headTtlMs < 0)
      throw new RangeError("headTtlMs must be ≥ 0");
    if (!Number.isSafeInteger(cacheSize) || cacheSize < 1)
      throw new RangeError("cacheSize must be at least 1");
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1)
      throw new RangeError("budgetMs must be at least 1");
    this.chainId = source.chainId;
    this.#source = source;
    this.#headTtlMs = headTtlMs;
    this.#cacheSize = cacheSize;
    this.#budgetMs = budgetMs;
    this.#now = now;
  }

  /**
   * 5.8's verdict for `ref` in a poll with this window, as of the node's
   * finalized head. Throws if the node can't be read; the caller decides
   * what an unchecked ballot gets.
   */
  async judge(
    window: { readonly opensAt: bigint; readonly closesAt: bigint },
    ref: { readonly l1RefNumber: bigint; readonly l1RefHash: Uint8Array },
  ): Promise<L1ReferenceVerdict> {
    const start = this.#now();
    if (start < this.#downUntil) throw new Error("the L1 node failed a moment ago");
    try {
      return await this.#judge(window, ref, start + this.#budgetMs);
    } catch (e) {
      this.#downUntil = this.#now() + this.#headTtlMs;
      throw e;
    }
  }

  async #judge(
    window: { readonly opensAt: bigint; readonly closesAt: bigint },
    ref: { readonly l1RefNumber: bigint; readonly l1RefHash: Uint8Array },
    deadline: number,
  ): Promise<L1ReferenceVerdict> {
    const head = await this.#finalizedHead(deadline);
    let min = this.#mins.get(window.opensAt);
    if (min === undefined) {
      // Block 0 is before every window (or is `l1_ref_min` itself), so the
      // search needs no other known-earlier block.
      min = await this.#run(head, deadline, (l1) => l1RefMin(l1, 0n, window.opensAt));
      // The head hasn't reached the window: every reference waits for L1.
      if (min === undefined) return "pending";
      remember(this.#mins, window.opensAt, min, this.#cacheSize);
    }
    const l1RefMinimum = min;
    return this.#run(head, deadline, (l1) =>
      checkL1Reference(ref, l1, { l1RefMin: l1RefMinimum, closesAt: window.closesAt }),
    );
  }

  async #finalizedHead(deadline: number): Promise<bigint> {
    const now = this.#now();
    if (this.#head !== undefined && now - this.#head.at < this.#headTtlMs) return this.#head.number;
    const number = await this.#within(deadline, this.#source.finalizedHead());
    if (typeof number !== "bigint" || number < 0n || number > 0xffff_ffff_ffff_ffffn)
      throw new RangeError("the finalized head isn't a u64");
    // Finalized blocks never revert, so a node (or a load balancer's other
    // node) reporting a lower head is behind: the higher one stands.
    const highest =
      this.#head !== undefined && this.#head.number > number ? this.#head.number : number;
    this.#head = { number: highest, at: now };
    return highest;
  }

  /**
   * Runs `check` over the finalized chain up to `head`, reading each block
   * it asks for that isn't kept yet and running it again, so the verdict is
   * exactly the crypto package's over the blocks the node reported.
   */
  async #run<T>(head: bigint, deadline: number, check: (l1: FinalizedL1) => T): Promise<T> {
    const l1: FinalizedL1 = {
      head,
      block: (n) => {
        const kept = this.#blocks.get(n);
        if (kept === undefined) throw new Missing(n);
        return kept;
      },
    };
    for (let reads = 0; reads <= MAX_READS; reads++) {
      try {
        return check(l1);
      } catch (e) {
        if (!(e instanceof Missing)) throw e;
        if (e.n < 0n || e.n > head)
          throw new RangeError("asked for a block beyond the finalized head");
        const block = await this.#within(deadline, this.#source.block(e.n));
        remember(
          this.#blocks,
          e.n,
          { hash: new Uint8Array(block.hash), timestamp: block.timestamp },
          this.#cacheSize,
        );
      }
    }
    throw new Error("an L1 reference needed too many blocks");
  }

  /** `read`, or a rejection once the judgement's deadline passes. */
  async #within<T>(deadline: number, read: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("the L1 node took too long")),
        Math.max(0, deadline - this.#now()),
      );
    });
    try {
      return await Promise.race([read, late]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Keeps `value` under `key`, dropping the oldest beyond `size`. */
function remember<V>(cache: Map<bigint, V>, key: bigint, value: V, size: number) {
  if (!cache.has(key) && cache.size >= size) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}
