# Content addressing

How board data becomes IPFS blocks, CIDs and CAR files, so that every party holding the same bytes can derive the same CID and CAR, and anyone can pin or re-upload a copy that matches what was published ([[0005-permanent-archive]], CID parameters). Threats: T-51 (data loss: independent pinners must reproduce our CIDs), T-49 (verification without us), T-24 (a gateway serving different data to different viewers can't pass a CID check).

Integrity never rests on a CID alone: every byte is checked against the L1-anchored roots (P1-16, P4-1). CIDs are for finding and deduplicating data.

## Parameters

IPFS implementations disagree on defaults (chunk size, leaf encoding, links per node), so every parameter is fixed here and implementations MUST set them explicitly. The values follow the `unixfs-v1-2025` profile proposed in [IPIP-499](https://github.com/ipfs/specs/pull/499). Two independent IPFS implementations, Kubo 0.36.0 (Go) and ipfs-unixfs-importer 17.1.1 with @ipld/car 5.4.7 (JavaScript), set to them, produce identical CIDs and CARs for every vector (Test vectors), so an independent pinner using either reproduces our CIDs (T-51). Kubo needs `Import.UnixFSFileMaxLinks` set to 1024 (its default is 174) and `--cid-version=1 --raw-leaves --chunker=size-1048576`; ipfs-unixfs-importer needs `rawLeaves`, `cidVersion: 1`, `fixedSize({ chunkSize: 1048576 })` and `balanced({ maxChildrenPerNode: 1024 })`.

| Parameter      | Value                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CID version    | CIDv1                                                                                                                                                                                                                                                                      |
| Multihash      | sha2-256 (`0x12`), 32-byte digest                                                                                                                                                                                                                                          |
| Text form      | multibase base32, lowercase (`b` prefix)                                                                                                                                                                                                                                   |
| Leaf blocks    | raw (`0x55`), each holding one chunk of the object's bytes                                                                                                                                                                                                                 |
| Chunking       | fixed size, 1,048,576 bytes; the last chunk holds the remainder                                                                                                                                                                                                            |
| Interior nodes | dag-pb (`0x70`) UnixFS v1 `File` nodes: `Data` sets `Type = File`, `filesize` and one `blocksizes` entry per child, and nothing else (no `mode`, `mtime` or inline data); each link has an empty `Name` and `Tsize` equal to the total encoded size of the child's subtree |
| DAG layout     | balanced, at most 1,024 links per interior node: the chunks, left to right, are grouped into parents of up to 1,024, and those again, until one node is left                                                                                                               |
| Small objects  | an object of at most 1,048,576 bytes is a single raw block; its CID is that block's CID                                                                                                                                                                                    |
| Empty objects  | not allowed: nothing the protocol stores is empty                                                                                                                                                                                                                          |
| CAR            | CARv1 with the dag-cbor header `{roots: [root], version: 1}`, exactly one root (the object's CID), blocks in depth-first pre-order from the root, each block exactly once, no other blocks                                                                                 |

An object is any one encoded byte string the protocol stores: a board segment ([[board]], Segments and checkpoints), a display-text record ([[display-text]]), an archive manifest (P4-3) or a ballot-client release (P2-8).

Encodings, byte for byte as both implementations write them:

- A dag-pb node encodes its links (protobuf field 2) before its data (field 1), and each link its `Hash` (1), its empty `Name` (2, present with length 0) and its `Tsize` (3), in that order. The UnixFS `Data` encodes `Type` (1), `filesize` (3) and each `blocksizes` entry (4, not packed), in that order.
- A CID is `0x01 ‖ codec ‖ 0x12 ‖ 0x20 ‖ sha256(block)`, with `codec` `0x55` for a raw leaf and `0x70` for a dag-pb node.
- The CAR header is the dag-cbor map `{"roots": [root], "version": 1}`, keys in dag-cbor order (`roots` first), the root as tag 42 over `0x00 ‖ cid`; each block follows as a varint length, its CID and its bytes. Identical chunks (a run of zero bytes, say) share one leaf, which the CAR carries once, where the walk first reaches it.

## Test vectors

`docs/spec/vectors/content-addressing.json` ([[vectors/README|vectors]]): objects of one byte, one chunk exactly, one chunk and a byte, three chunks and two identical chunks under these parameters, each with its CID and CAR (whole when small, by length and sha256 otherwise); and the balanced layout's deeper trees (from one to 65 leaves, a partial last group at each level, identical chunks) under a small chunk size and fan-out no protocol object uses, since a second level needs more than a GiB at the real ones. Every value is what Kubo and ipfs-unixfs-importer both produced, refused unless they agreed byte for byte; `packages/crypto/scripts/content-addressing-vectors.mjs` prints them. `packages/crypto` (`contentDag`, `objectCid`, `objectCar`, `cidText`) reproduces each.

## Still to come

- Archive manifests and their Arweave layout: P4-3.
