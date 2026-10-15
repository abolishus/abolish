// The board's public archive under simulation (docs/spec/board.md, Segment
// objects; [[content-addressing]]): once a period's entries are final, the
// operator publishes the period's segment object and entry-hash list, each
// under @abolishus/crypto's `objectCid` of its bytes, the CIDs the anchoring
// authority's checkpoint then names on L1. So the board can be fetched by
// CID from L1 and IPFS alone, with our servers and their database gone
// (T-24, T-49, T-51). The store is simulated: whole objects in memory, never
// a DAG of blocks or a CAR, with no pinning or availability attestations
// (P4-3), and it hands back whatever it holds: a reader checks the bytes by
// their CID here, and then against the anchored roots with `verifyBoard`.

import {
  boardEntryHash,
  type BoardEntryVersion,
  decodeBoardEntry,
  objectCid,
} from "@abolishus/crypto";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A content-addressed store: an IPFS network's view of what was published to it. */
export class SimulatedIpfs {
  readonly #objects = new Map<string, Uint8Array>();

  /** Publishes `object` and returns its CID, crypto's `objectCid` of its bytes. */
  put(object: Uint8Array): Uint8Array {
    const cid = objectCid(object);
    this.#objects.set(hex(cid), Uint8Array.from(object));
    return cid;
  }

  /**
   * The object published under `cid`, as a copy, or `undefined` when no one
   * serves it. A fetch is checked by its CID, as an IPFS client checks the
   * blocks it is sent, so a store holding other bytes under it serves
   * nothing.
   */
  get(cid: Uint8Array): Uint8Array | undefined {
    const held = this.#objects.get(hex(cid));
    if (held === undefined) return undefined;
    const got = objectCid(held);
    return got.length === cid.length && got.every((b, i) => b === cid[i])
      ? Uint8Array.from(held)
      : undefined;
  }

  /** How many objects the store holds. */
  get size(): number {
    return this.#objects.size;
  }

  /**
   * Test seam: replaces what the store holds under `cid`, or drops it with
   * `undefined`, as a mirror that withholds or alters an object would.
   */
  replace(cid: Uint8Array, object: Uint8Array | undefined): void {
    if (object === undefined) this.#objects.delete(hex(cid));
    else this.#objects.set(hex(cid), Uint8Array.from(object));
  }
}

/**
 * The operator's publication of segment objects: each period's object and
 * entry-hash list, once the period's entries are final, before the
 * anchoring authority anchors the checkpoint that names their CIDs.
 */
export class SegmentPublisher {
  readonly #ipfs: SimulatedIpfs;
  readonly #version: BoardEntryVersion;
  /** Entries already published, all in periods through `#through`. */
  #published = 0;
  #through = -1;

  constructor(ipfs: SimulatedIpfs, boardEntryVersion: BoardEntryVersion) {
    this.#ipfs = ipfs;
    this.#version = boardEntryVersion;
  }

  /**
   * Publishes each period from the last one handled through `segment` that
   * added entries, as `SimulatedAnchor.anchorThrough` anchors them: the
   * caller boards nothing more in those periods afterwards.
   */
  publishThrough(entries: readonly Uint8Array[], segment: number): void {
    if (segment <= this.#through) return;
    const pending: { readonly segment: number; readonly bytes: Uint8Array }[] = [];
    for (let i = this.#published; i < entries.length; i++) {
      const bytes = entries[i] as Uint8Array;
      // The operator's own entries, decoded under the pinned version.
      const s = decodeBoardEntry(bytes, this.#version).segment;
      if (s > segment) break;
      if (s <= this.#through)
        throw new Error("simulation: an entry boarded in a period already published");
      pending.push({ segment: s, bytes });
    }
    for (let i = 0; i < pending.length;) {
      const s = (pending[i] as (typeof pending)[number]).segment;
      let j = i;
      while (j < pending.length && (pending[j] as (typeof pending)[number]).segment === s) j++;
      const encodings = pending.slice(i, j).map((p) => p.bytes);
      this.#ipfs.put(concat(encodings));
      this.#ipfs.put(concat(encodings.map(boardEntryHash)));
      i = j;
    }
    this.#published += pending.length;
    this.#through = segment;
  }
}
