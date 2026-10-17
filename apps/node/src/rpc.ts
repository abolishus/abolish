// A minimal JSON-RPC client for the L1 node the operator names. Nothing it
// answers is trusted beyond which block is finalized: every word the node
// uses is proven against that block's state root, and every checkpoint must
// hash to a proven word (src/l1.ts; T-24, T-36).

/** Most bytes one answer may take: a proof over a few thousand slots is a few MiB. */
export const MAX_RPC_ANSWER = 64 * 1024 * 1024;

/** How long one request may take, headers and body: 60 s. */
export const RPC_TIMEOUT_MS = 60_000;

/** A request the node refused, or an answer that isn't JSON-RPC. */
export class RpcError extends Error {
  override readonly name = "RpcError";
}

export interface Rpc {
  readonly call: (method: string, params: readonly unknown[]) => Promise<unknown>;
}

export interface RpcOptions {
  /** Where requests go: the platform's `fetch` unless a test supplies one. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * An L1 node's URL from text: `http:` or `https:`, as the operator names it.
 * Credentials and a query stay (hosted nodes put their key there), so the
 * URL is never printed. Throws `RangeError` otherwise.
 */
export function parseRpcUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RangeError("the L1 node must be an absolute http: or https: URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new RangeError("the L1 node must be an absolute http: or https: URL");
  return url;
}

// The body as text, if it is at most `MAX_RPC_ANSWER` bytes, read as it
// streams (T-52).
async function text(res: Response): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_RPC_ANSWER) {
      await reader.cancel();
      throw new RpcError("an answer past the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function rpcClient(url: URL, options: RpcOptions = {}): Rpc {
  const fetch = options.fetch ?? globalThis.fetch;
  const target = url.href;
  let id = 0;
  return {
    call: async (method, params) => {
      const n = ++id;
      let res: Response;
      try {
        res = await fetch(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: n, method, params }),
          redirect: "error",
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
      } catch (e) {
        // The URL may hold a key: name the method, never the URL.
        throw new RpcError(`${method}: ${(e as Error).name}`);
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new RpcError(`${method}: status ${res.status}`);
      }
      let answer: string;
      try {
        answer = await text(res);
      } catch (e) {
        // Cut off mid-answer (a timeout, a reset), or past the size limit.
        throw new RpcError(`${method}: ${e instanceof RpcError ? e.message : (e as Error).name}`);
      }
      let body: unknown;
      try {
        body = JSON.parse(answer);
      } catch {
        throw new RpcError(`${method}: an answer that isn't JSON`);
      }
      if (typeof body !== "object" || body === null || (body as { id?: unknown }).id !== n)
        throw new RpcError(`${method}: an answer that isn't JSON-RPC`);
      const { result, error } = body as { result?: unknown; error?: { message?: unknown } };
      if (error !== undefined)
        throw new RpcError(
          // The node's own words, cut short: they reach the operator's terminal.
          `${method}: ${typeof error?.message === "string" ? error.message.slice(0, 200) : "refused"}`,
        );
      if (result === undefined) throw new RpcError(`${method}: an answer without a result`);
      return result;
    },
  };
}

/** The node's `eth_chainId`, refused unless a canonical quantity of at most 64 bits. */
export async function chainId(rpc: Rpc): Promise<bigint> {
  const id = await rpc.call("eth_chainId", []);
  if (typeof id !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/u.test(id))
    throw new RpcError("eth_chainId: not a chain ID");
  return BigInt(id);
}
