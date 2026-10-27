// Stage 8, the archive's half (P4-3 part 4b-2b-2b-3b; docs/spec/archive.md):
// every board's segment objects and entry-hash lists posted to the fixture's
// Arweave (`arweave.ts`) through the worker's own client, `HttpArweaveClient`,
// each as one transaction whose data is the object's CAR; once each is
// `ARCHIVE_DEPTH` blocks deep with data that reads as its CID, the confirmed
// objects are listed in manifest 0 (version 3), which is posted and confirmed
// the same way, and the version-3 locator naming it is what the anchor's
// locator-only call carries ([[contracts]], Archive locator). The verifier
// then finds the boards from L1 and Arweave alone (4.3; T-49, T-51).
//
// The manifest is the fixture's, written through @abolishus/crypto, not
// core's archive run's: that run takes its objects from the operator's
// database, which holds only the ballots the API boarded, not the fixture's
// boards (STUBS, `archive`). Beside the objects it lists the L2 contracts'
// evidence and runs (`contract-events.ts`), posted and confirmed the same
// way, so 4.4 replays every contract's events from the archive alone.

import { ARCHIVE_DEPTH } from "@abolishus/core";
import {
  type ArchivedObject,
  encodeArchiveLocator,
  type EvidenceRef,
  type RunRef,
  encodeArchiveManifest,
  objectCar,
  objectCid,
  readArchivedObject,
} from "@abolishus/crypto";
import { arweaveWallet, HttpArweaveClient } from "@abolishus/worker";
import { generateKeyPairSync } from "node:crypto";
import { localPrice, type LocalArweave } from "./arweave.ts";
import type { EvidenceObject, RunObject } from "./contract-events.ts";

/** What the archive holds: each object's, record's and run's CID and transaction, and the locator naming manifest 0. */
export interface Archived {
  readonly objects: readonly ArchivedObject[];
  readonly evidence: readonly EvidenceRef[];
  readonly runs: readonly RunRef[];
  readonly manifest: ArchivedObject;
  readonly locator: Uint8Array;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * Archives `objects` (duplicates posted once), with the L2 contracts'
 * `events`, for the anchor at `anchor` on the L1 `l1ChainId`, through
 * `node`, mining as the posts need. The wallet is a fresh 4096-bit key for
 * each run, worth nothing on any other node.
 */
export async function archiveObjects(
  node: LocalArweave,
  objects: readonly Uint8Array[],
  deployment: { readonly l1ChainId: bigint; readonly anchor: Uint8Array },
  events: {
    readonly evidence: readonly EvidenceObject[];
    readonly runs: readonly RunObject[];
  } = { evidence: [], runs: [] },
): Promise<Archived> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096, publicExponent: 65537 });
  const wallet = arweaveWallet(privateKey.export({ format: "jwk" }));
  const largest = Math.max(
    ...[...objects, ...events.runs.map((r) => r.bytes)].map((o) => objectCar(o).length),
  );
  const client = new HttpArweaveClient(new URL(node.url), wallet, {
    maxReward: localPrice(largest + (1 << 20)),
  });
  // Posted, mined to the depth, and counted only once the node serves data
  // that reads as the CID, as core's archive run counts an upload confirmed.
  const archive = async (batch: readonly Uint8Array[]): Promise<ArchivedObject[]> => {
    const posted: { object: Uint8Array; cid: Uint8Array; transaction: Uint8Array }[] = [];
    for (const object of batch)
      posted.push({
        object,
        cid: objectCid(object),
        transaction: await client.post(objectCar(object)),
      });
    await node.mine(ARCHIVE_DEPTH);
    for (const { object, cid, transaction } of posted) {
      const depth = await client.confirmations(transaction);
      if (depth === undefined || depth < ARCHIVE_DEPTH)
        throw new Error(`the archive's upload of an object is ${depth ?? "in no block"} deep`);
      const data = await client.data(transaction, objectCar(object).length);
      const read = data === undefined ? undefined : readArchivedObject(data, cid, object.length);
      if (read?.ok !== true || hex(read.bytes) !== hex(object))
        throw new Error("the archive's upload of an object doesn't read as its CID");
    }
    return posted.map(({ cid, transaction }) => ({ cid, transaction }));
  };
  const distinct = [...new Map(objects.map((o) => [hex(objectCid(o)), o])).values()];
  const listed = (await archive(distinct)).sort((a, b) => Buffer.compare(a.cid, b.cid));
  // In the layout's orders: by contract, then block or first index, then CID.
  const evidence = (await archive(events.evidence.map((e) => e.bytes)))
    .map((a, i) => {
      const e = events.evidence[i] as EvidenceObject;
      return { contract: e.contract, l2_block: e.l2Block, ...a };
    })
    .sort(
      (a, b) =>
        Buffer.compare(a.contract, b.contract) ||
        Number(a.l2_block - b.l2_block) ||
        Buffer.compare(a.cid, b.cid),
    );
  const runs = (await archive(events.runs.map((r) => r.bytes)))
    .map((a, i) => {
      const r = events.runs[i] as RunObject;
      return { contract: r.contract, first: r.first, count: r.count, ...a };
    })
    .sort(
      (a, b) =>
        Buffer.compare(a.contract, b.contract) ||
        Number(a.first - b.first) ||
        Buffer.compare(a.cid, b.cid),
    );
  const encoded = encodeArchiveManifest(
    {
      l1_chain_id: deployment.l1ChainId,
      anchor: deployment.anchor,
      sequence: 0n,
      objects: listed,
      links: [],
      evidence,
      runs,
    },
    3,
  );
  const [manifest] = await archive([encoded]);
  if (manifest === undefined) throw new Error("the manifest wasn't archived");
  return {
    objects: listed,
    evidence,
    runs,
    manifest,
    locator: encodeArchiveLocator(manifest.cid, manifest.transaction, 3),
  };
}
