// The blocks the node mirrors: every CARv1 file in one directory, read with
// the verifier's block store, so each block kept hashes to its CID and is at
// most `CHUNK_SIZE` bytes ([[verifier]], Board by CID). The node never serves
// a block it hasn't hashed (T-51: a pinner that serves corrupt blocks is no
// copy at all), and it keeps no database or cache: the files are the state.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AsyncBlockSource, CHUNK_SIZE } from "@abolishus/crypto";
import { BundleError, readBlockStore } from "@abolishus/verifier";

/** What was found in one file of the directory. */
export type FileReport =
  | { readonly file: string; readonly blocks: number; readonly unreadableBytes: number }
  | { readonly file: string; readonly error: string };

export interface Mirror {
  /** The block under `cid`, if a file holds one that hashes to it. */
  readonly block: (cid: Uint8Array) => Promise<Uint8Array | undefined>;
  readonly files: readonly FileReport[];
}

/**
 * Reads every `*.car` directly in `dir` (symlinks followed), in name order.
 * A file that can't be read (its filesystem error code), isn't a CARv1
 * (`not-a-car`) or isn't a file (`EISDIR`) is reported and skipped; one cut
 * short serves the blocks before the cut. Each file is held in memory whole.
 * Throws only if `dir` itself can't be listed.
 */
export async function openMirror(dir: string): Promise<Mirror> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".car")).sort();
  const sources: AsyncBlockSource[] = [];
  const files: FileReport[] = [];
  for (const file of names) {
    let store;
    try {
      store = readBlockStore(await readFile(join(dir, file)));
    } catch (e) {
      const code = e instanceof BundleError ? "not-a-car" : (e as NodeJS.ErrnoException).code;
      if (code === undefined) throw e;
      files.push({ file, error: code });
      continue;
    }
    sources.push(store.source);
    files.push({ file, blocks: store.blocks, unreadableBytes: store.unreadableBytes });
  }
  return {
    block: async (cid) => {
      for (const source of sources) {
        const [found] = await source(cid, CHUNK_SIZE);
        if (found !== undefined) return found;
      }
      return undefined;
    },
    files,
  };
}
