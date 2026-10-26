// Finalized L1 headers for the counted set's 5.8 (packages/core's
// `L1HeaderRun`), as the operator's boarding of tally openings reads them:
// apps/node's `headerRun` from one L1 node, from the last block before the
// window to the first after it, each block the parent of the next and the
// last at or below the node's finalized head. The node is trusted for which
// block is finalized and for the run's two ends, as the trustee node's own
// run is (T-53): a node lying about timestamps can only make the set wait
// or be refused, never fix another one, since the verifier checks every
// ballot's reference against the run. Every read is of public chain data,
// and nothing here logs or throws what it read or the node's URL (T-10).

import type { L1HeaderRun } from "@abolishus/core";
import { chainId, finalizedBlock, headerRun, MAX_RUN_BYTES, type Rpc } from "@abolishus/node";
import { decodeHeader, type L1Header, RlpError } from "@abolishus/verifier";

/** One L1 node's runs of finalized headers. Made by `connect`, which checks the chain. */
export class RpcL1HeaderRun implements L1HeaderRun {
  readonly chainId: bigint;
  readonly #rpc: Rpc;
  readonly #maxBytes: number;

  private constructor(rpc: Rpc, id: bigint, maxBytes: number) {
    this.#rpc = rpc;
    this.chainId = id;
    this.#maxBytes = maxBytes;
  }

  /**
   * Refuses a node on any chain but `chainId` (the anchor's). `maxBytes`
   * bounds one run's headers (`MAX_RUN_BYTES` unless a test lowers it).
   */
  static async connect(rpc: Rpc, id: bigint, maxBytes = MAX_RUN_BYTES): Promise<RpcL1HeaderRun> {
    if ((await chainId(rpc)) !== id) throw new Error("the L1 node is on another chain");
    return new RpcL1HeaderRun(rpc, id, maxBytes);
  }

  /**
   * Throws when the node's answers can't be read or don't chain, and when
   * the budget cut the run so that it starts inside the window: a short run
   * there would only ever make the set wait, so the caller is told instead
   * and tries again (T-52).
   */
  async run(window: { readonly before: bigint; readonly after: bigint }): Promise<L1Header[]> {
    const head = await finalizedBlock(this.#rpc);
    const run = await headerRun(this.#rpc, head, window, this.#maxBytes);
    let headers: L1Header[];
    try {
      headers = run.map(decodeHeader);
    } catch (e) {
      if (e instanceof RlpError)
        throw new Error("the L1 node answered a block that isn't a header");
      throw e;
    }
    const first = headers[0] as L1Header;
    if (first.number !== 0n && first.timestamp >= window.before)
      throw new Error("the L1 header run is past its budget");
    return headers;
  }
}
