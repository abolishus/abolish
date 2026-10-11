// The election identifier the election registry assigns
// (docs/spec/contracts.md, Election registry). Deriving it from the chain, the
// registry's address and the registry's own counter makes it unique across
// every election whose checkpoints share an anchor contract, so a redeployed
// registry can't reuse one and have another election's checkpoints attributed
// to it (docs/spec/board.md; T-23, T-24, T-34).

import { bytesFixed, encode, u64, Writer } from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";

const MAX_U64 = 2n ** 64n - 1n;

/**
 * `election_id = H(DS("abolish/v1/election-id", u64(chain_id) ‖
 * bytes[20](registry) ‖ u64(counter)))`, where `counter` is the number of
 * elections the registry created before this one.
 */
export function electionId(chainId: bigint, registry: Uint8Array, counter: bigint): Uint8Array {
  for (const [name, v] of [
    ["chainId", chainId],
    ["counter", counter],
  ] as const)
    if (typeof v !== "bigint" || v < 0n || v > MAX_U64)
      throw new RangeError(`${name} must be a bigint from 0 to 2^64 - 1`);
  if (!(registry instanceof Uint8Array)) throw new TypeError("registry must be a Uint8Array");
  const w = new Writer();
  w.bytes(encode(u64, chainId));
  w.bytes(encode(bytesFixed(20), registry));
  w.bytes(encode(u64, counter));
  return H(ds("abolish/v1/election-id", w.finish()));
}
