# Permanent archive

How board data is archived on Arweave and found again from L1 alone: what an archived object's Arweave transaction holds, the archive manifest (record type `0x0021`) that lists a run of archived objects and links the manifests before it, and the body of the board anchor's `archiveLocator` ([[contracts]], Archive locator) that names the latest confirmed manifest. Threats: T-51 (data loss once our pinning stops), T-49 (verification with our servers and domain gone), T-17 (chosen bytes in the permanent record), T-52 (input that costs a reader work), T-24 (a source serving different bytes to different readers), T-69 (a seized authority overwriting the locator). Decided by [[0005-permanent-archive]] (option A), Consequences, "Archive objects and how they are found".

Integrity never rests on the archive. Every object found through it is checked against the L1-anchored checkpoints ([[board]], Board checks) as a copy from any other source is, so a manifest or a transaction can only send a reader to bytes that fail those checks or to nothing: the election is then unverifiable from the archive, never failed by it (T-53). Arweave is one more source next to IPFS, never a required one ([[0005-permanent-archive]], Verifier and node).

## Archived objects

An archived object is a board segment object or an entry-hash list that a checkpoint names ([[board]], Segments and checkpoints), or an archive manifest. Display text is never archived ([[display-text]]; T-17). Our contracts' event-accumulator evidence ([[contracts]], Evidence) is archived from manifest version 2, which adds it (Known-weak).

Each archived object is the data of exactly one Arweave base-layer transaction, and that data is exactly `objectCar(object)`: the object's CAR under [[content-addressing]]'s parameters, with its CID as the one root. Nothing else is in the data, so the same bytes are a CAR any IPFS node imports (`ipfs dag import`), and the CID is the same whether the object is fetched from IPFS or from Arweave. A transaction is named by its 32-byte ID, the SHA-256 of its signature, which Arweave writes as 43 characters of unpadded base64url ([RFC 4648, section 5](https://www.rfc-editor.org/rfc/rfc4648#section-5)); every Arweave node and gateway serves the data by that ID. Transaction tags (`Content-Type: application/vnd.ipld.car` and the root's CID text, say) are an index for gateways, never read by a verifier and never trusted.

A transaction ID says only who posted the data, which a verifier doesn't trust: the bytes are judged by their CID. Reading an object from a transaction's data, with the object's CID `c` and a bound `M` on its length:

1. the data MUST start with the CAR header [[content-addressing]] gives for `c` (CAR), byte for byte; then
2. each block follows as a varint length, a CID and the block, as the CAR encodes it; a varint that isn't minimal or is longer than 8 bytes, a block whose CID isn't 36 bytes framed as [[content-addressing]] frames them, or a length running past the data is **inconsistent**;
3. the object is read within `M` ([[content-addressing]], Reading within a bound) from the blocks the data carries, each served only under its own CID. If its length is over `M` it is **over-bound**; any other failure of the read (an inconsistent DAG, or a block the walk reaches that the data doesn't carry) is **inconsistent**;
4. the data MUST then be exactly `objectCar` of the object read, or it is **inconsistent**: no other block, order or repetition is accepted, so one transaction's data has one reading.

Otherwise it is the object. Every outcome is a function of the data, `c` and `M` alone; a source that serves other data for a transaction ID is a source that failed, and the reader tries another, as for IPFS (T-24). `packages/crypto`'s `readArchivedObject` is this reader, over data its caller fetched within its own limit.

## Archive manifest (record type `0x0021`)

A manifest lists archived objects with the transactions that hold them, and links the manifests that confirmed before it, so every confirmed manifest is reachable from the latest one ([[0005-permanent-archive]], Archive objects and how they are found). It is a record ([[notation]], Records) and itself an archived object; its CID is `objectCid` of its encoding, which is at most 1 MiB, so it is always one raw block (`0x01 ‖ 0x55 ‖ 0x12 ‖ 0x20 ‖ SHA-256`). No profile pins its version: a manifest belongs to a deployment, not to an election, and each locator version fixes the manifest version it names (Locator).

### Layout (version 1)

| Field         | Type                 | Meaning                                                                               |
| ------------- | -------------------- | ------------------------------------------------------------------------------------- |
| `l1_chain_id` | `u64`                | The chain ID of the L1 the deployment's board anchor is on.                           |
| `anchor`      | `bytes[20]`          | The board anchor's address: the contract whose locators name this manifest's chain.   |
| `sequence`    | `u64`                | This manifest's place in the deployment's chain: 0 for the first, then one more each. |
| `objects`     | `list<object, 8192>` | The archived objects it lists.                                                        |
| `links`       | `list<link, 1024>`   | The earlier manifests it names.                                                       |

`object` is a structure of `cid` (`bytes[36]`), the object's CID, and `transaction` (`bytes[32]`), the ID of the transaction whose data is its CAR. `link` is a structure of `sequence` (`u64`), the linked manifest's `sequence`, `cid` (`bytes[36]`), its CID, and `transaction` (`bytes[32]`), the transaction holding it.

`MAX_MANIFEST_OBJECTS = 8192` and `MAX_MANIFEST_LINKS = 1024`, so a manifest is at most `43 + 8192·68 + 4 + 1024·76 = 634,927` bytes, under one chunk. A period with more objects than one manifest lists gets more than one manifest.

A decoder rejects, as `non-canonical` at the field's offset, after the framing of [[notation]]:

- an object's `cid` that isn't `0x01 ‖ codec ‖ 0x12 ‖ 0x20 ‖ digest` with `codec` raw (`0x55`) or dag-pb (`0x70`), the only CIDs [[content-addressing]] makes;
- objects not in strictly ascending byte order of `cid`, so no object is listed twice and a manifest's objects have one order;
- a link's `cid` that isn't raw (`0x01 ‖ 0x55 ‖ 0x12 ‖ 0x20 ‖ digest`), since every manifest is one raw block;
- links not in strictly ascending order of `sequence`, or a link whose `sequence` isn't below the manifest's own;
- a manifest with no objects and no links, which names nothing.

**Who writes them.** The worker that archives (P4-3 part 4) writes manifest `k` once manifests `0` to `k − 1` exist, listing the objects of the periods it covers and linking exactly the manifests below `k` that have confirmed on Arweave and that no other confirmed manifest below `k` reaches through links: the roots of the confirmed manifests' links, and only confirmed ones (at most 1,024 per manifest; the next manifest links the rest). A manifest whose upload fails is posted again with the same bytes under a new transaction, so its CID and sequence don't change. A manifest that confirms after a later one was written is a root again when the next is written, and is linked then, so a manifest may be linked more than once (once by a manifest that never confirmed, say) but every confirmed manifest is reachable from every confirmed manifest written after it confirmed. The worker names a manifest `m` in a locator only once `m` has confirmed and every manifest `0` to `m − 1` is reachable from it through links; until then the locator keeps naming the last manifest that met that rule, and the worker writes a further manifest, which links the stragglers, when they confirm. So the manifest a locator names reaches every manifest before it, out-of-order and failed uploads included ([[0005-permanent-archive]]). Listing an object again in a later manifest (a second transaction, after the first was lost) is allowed: a reader takes any listing that reads.

### The chain from a locator (verifier 4.3)

From the latest locator proven in the anchor's state at `B` ([[contracts]], Archive locator) a reader:

1. decodes it (Locator). A version it doesn't know is reported (`locator-version`) and the walk stops; a known version of the wrong length (`locator-length`), a version-1 locator naming a CID that isn't raw (`locator-cid`) and anything the anchor's framing refuses (`locator-framing`, which also covers a length word in the anchor's state that no Solidity `bytes` of at most `MAX_LOCATOR_LENGTH` bytes has, so the reader never reads more than 128 bytes' slots) are reported the same way. None of them fails anything;
2. reads the manifest it names from the named transaction, within 1 MiB, and decodes it under the version the locator fixes. It MUST have the CID the locator names (the read ensures it), the reader's `l1_chain_id` and `anchor` (`manifest-foreign` otherwise, and the walk doesn't follow it). Data that reads as the CID but doesn't decode is `manifest-malformed`: the CID fixes the bytes, so no other source can serve better. A transaction no source serves data for that reads as the CID is `unavailable`, and the walk stops;
3. reads each link's manifest the same way, requiring its `sequence` to be the link's (`link-sequence` otherwise, and the walk doesn't follow it), and continues from it, breadth first in each manifest's link order. Each sequence is read once: the first link to a sequence fixes its CID, and a later link to it naming another CID is `link-conflict`, with both (once per sequence, however many links conflict), and is never read. A later link naming the same CID under another transaction is tried while the sequence is still unreached, since a manifest whose upload failed is posted again with the same bytes (Who writes them). The reader stops after a budget of manifest reads of its own choosing (`over-budget`, unverifiable for this reader, never a verdict), since the authority chooses how many there are (T-52). A link that needs a read counts against the budget as soon as its manifest is reached, so the links waiting never outnumber the reads left, and a walk stops as soon as they would; a walk that stops there reports no gap and no unavailable link, since what it didn't read isn't missing;
4. reports the sequences from 0 to the latest's that no manifest reached, as ranges (`archive-gap`, each range's first and last), and every transaction it tried for a sequence it never reached (`unavailable`, with the link's sequence, CID and transaction). Ranges keep the report bounded however large the latest `sequence` is (T-52).

An earlier locator from an `ArchiveLocated` log at or before `B`, while L1 history serves it, names a manifest the reader checks against the CID the chain's links name at that sequence, so a locator overwritten by a seized authority is detected while the logs last (T-69; [[contracts]], Known-weak). The reader judges them in log order, a repeated locator once. A locator naming a CID the chain's links name is the chain's own manifest and never a mismatch: if that sequence is still unreached and the locator names a transaction not yet read for it, the manifest is read from it (step 3's rules, from the same budget) and the walk goes on from it, so a source's lapse on a link is not taken for an overwrite. Any other is read as step 2 reads the latest's, from the same budget, and a manifest of this deployment is `locator-mismatch`, with its sequence, its CID and the CID the chain names there if any: another manifest at a sequence the chain names, or one at a sequence it doesn't (in a gap, or above the latest's, where the locator was rolled back). Earlier locators are judged only once the latest's manifest is reached, since otherwise there is no chain to judge them against. Every listed object that a counted checkpoint of an election names is read by its transaction within the checkpoint's bound ([[board]], A copy from L1's CIDs) and must be the object the checkpoint names; a CID a counted checkpoint names that no reached manifest lists is reported (`not-archived`). All of these are reports on the archive path, never verdicts on an election: the board checks judge the bytes, wherever they came from. `packages/verifier`'s `latestLocatorFromState` and `walkArchive` are steps 1 to 4 and the earlier locators' check (P4-3 part 3b-1); reading the listed objects and `not-archived`, with the walk in the verifier's report, are part 3b-2.

## Locator

The board anchor frames a locator as `u16(version) ‖ body` ([[contracts]], Archive locator). Version 1's body is 68 bytes:

| Field         | Type        | Meaning                                                  |
| ------------- | ----------- | -------------------------------------------------------- |
| `manifest`    | `bytes[36]` | The CID of the latest confirmed manifest, raw as above.  |
| `transaction` | `bytes[32]` | The ID of the Arweave transaction whose data is its CAR. |

A version-1 locator is 70 bytes in all, under `MAX_LOCATOR_LENGTH`, and names a version-1 manifest. A version-1 body of any other length is `locator-length`, and one whose `manifest` isn't a raw CID is `locator-cid`, each reported as step 1 reports. Version 0 never occurs (the anchor refuses it), and every other version is reserved for a later scheme (ANS-104 bundles, or another store), each with its own fixed length.

The worker sends the latest confirmed manifest's locator with every anchoring call once one exists ([[contracts]], Archive locator), and after an election closes, a locator-only call once a manifest that meets the locator rule (Who writes them) reaches every manifest listing that election's objects, posting a closing manifest that only links stragglers if needed ([[0005-permanent-archive]], the final anchor).

## Test vectors

`vectors/archive.json` (format `abolish-archive-vectors/1`, see [[vectors/README|vectors]]): manifests at their bounds (one object, one link, both lists full) with their encodings and CIDs, every decode rejection at its offset, locators of version 1 and their rejections, and transaction data read as an object, over-bound or inconsistent (a missing block, a block repeated, out of order or empty, a CID of another object, a dag-pb root whose length isn't where canonical form puts it, a non-minimal or nine-byte varint, trailing bytes). `packages/crypto/scripts/archive-vectors.py`, an independent Python implementation of this page, prints them.

## Known-weak

- **Nothing archives yet.** The worker's uploads and its confirmation rule are P4-3 part 4, and the first funded upload waits for the owner ([[0005-permanent-archive]], Default). Until then the archive path reports nothing found, and the board is read from IPFS only.
- **No contract-event evidence in version 1**: the event accumulators' storage proofs ([[contracts]], Evidence) have no encoding yet; manifest version 2, with a locator version that names it, lists them once they do.
- **Base-layer transactions only**: one transaction per object costs a transaction's overhead each, about two per election per period. ANS-104 bundles, which would let a bundler pay by card, would be a new locator and manifest version carrying the bundle and item IDs, read without a gateway's index.
- **Chosen bytes**: each `transaction` is 32 bytes the authority can choose, since no verifier checks a signature behind it, so a manifest carries at most `32 · (8192 + 1024)` bytes of them, on top of the locator's 128 (T-17; [[contracts]], Known-weak). Nothing in it is personal data unless the authority puts it there, and the authority can already post anything to Arweave under its own key.
- **The tree is the authority's**: a seized authority can post a manifest that links nothing earlier and overwrite the locator with it; the gap is reported (`archive-gap`, `locator-mismatch` while the logs last), and the earlier manifests stay on Arweave, found by anyone who kept a locator or a manifest's ID (T-69).
