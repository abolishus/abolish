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
// boards (STUBS, `archive`).

import { ARCHIVE_DEPTH } from "@abolishus/core";
import {
  type ArchivedObject,
  encodeArchiveLocator,
  encodeArchiveManifest,
  objectCar,
  objectCid,
  readArchivedObject,
} from "@abolishus/crypto";
import { arweaveWallet, HttpArweaveClient } from "@abolishus/worker";
import { generateKeyPairSync } from "node:crypto";
import { localPrice, type LocalArweave } from "./arweave.ts";

/** What the archive holds: each object's CID and transaction, and the locator naming manifest 0. */
export interface Archived {
  readonly objects: readonly ArchivedObject[];
  readonly manifest: ArchivedObject;
  readonly locator: Uint8Array;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * Archives `objects` (duplicates posted once) for the anchor at `anchor` on
 * the L1 `l1ChainId`, through `node`, mining as the posts need. The wallet is
 * a fresh 4096-bit key for each run, worth nothing on any other node.
 */
export async function archiveObjects(
  node: LocalArweave,
  objects: readonly Uint8Array[],
  deployment: { readonly l1ChainId: bigint; readonly anchor: Uint8Array },
): Promise<Archived> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096, publicExponent: 65537 });
  const wallet = arweaveWallet(privateKey.export({ format: "jwk" }));
  const largest = Math.max(...objects.map((o) => objectCar(o).length));
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
  const encoded = encodeArchiveManifest(
    {
      l1_chain_id: deployment.l1ChainId,
      anchor: deployment.anchor,
      sequence: 0n,
      objects: listed,
      links: [],
      evidence: [],
      runs: [],
    },
    3,
  );
  const [manifest] = await archive([encoded]);
  if (manifest === undefined) throw new Error("the manifest wasn't archived");
  return {
    objects: listed,
    manifest,
    locator: encodeArchiveLocator(manifest.cid, manifest.transaction, 3),
  };
}
