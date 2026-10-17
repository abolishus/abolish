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
  | { readonly file: string; readonly error: "not-a-car" };

export interface Mirror {
  /** The block under `cid`, if a file holds one that hashes to it. */
  readonly block: (cid: Uint8Array) => Promise<Uint8Array | undefined>;
  readonly files: readonly FileReport[];
}

/**
 * Reads every `*.car` file directly in `dir`, in name order. A file that
 * isn't a CARv1 is reported and skipped; one cut short serves the blocks
 * before the cut. Each file is held in memory whole.
 */
export async function openMirror(dir: string): Promise<Mirror> {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith(".car"))
    .map((e) => e.name)
    .sort();
  const sources: AsyncBlockSource[] = [];
  const files: FileReport[] = [];
  for (const file of names) {
    let store;
    try {
      store = readBlockStore(new Uint8Array(await readFile(join(dir, file))));
    } catch (e) {
      if (e instanceof BundleError) {
        files.push({ file, error: "not-a-car" });
        continue;
      }
      throw e;
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
