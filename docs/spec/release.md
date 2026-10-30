# Release record

What a ballot-client release is, byte for byte, as [[0036-release-record]] (option B) decides: the release record (record type `0x001f`), its strict decoding, its well-formedness rules, the release hash the L1 release registry holds, and how each of its sites is served. Notation is from [[notation]], `H` from [[group]], the sites' directory layout from [[content-addressing]] (Sites). Threats: T-41, T-43, T-49, T-64, T-69, T-31, T-52, T-36.

A served ballot client passes [[verifier]] 1.1 only if every file it serves is the file a release record lists, with the headers the record lists, at an origin the record lists, and that record's release hash is published and not revoked in the release registry. The registry is what makes a release public before any check passes it (T-41): a release made for one voter is on L1 for everyone. This page fixes what the hash commits to, so that every reader (the verifier, `apps/node`, the ballot client's own build, a third party) reads one record the same way.

What this page doesn't cover:

- **The registry:** its calls, its storage layout and how a reader proves a release published and not revoked from a finalized L1 header ([[contracts]], Release registry).
- **The served-client check:** fetching a site from an origin and comparing it with the record ([[verifier]], Served client).
- **The deployment record** (`0x0020`): the chain IDs, contract addresses, registrars, panels, published groups, API and RPC origins, RP IDs and prover hashes the client is built for, which the release record binds by hash, and the rules a release and its deployment meet together ([[deployment]]).
- **Building and publishing:** the release workflow that builds the record from two reproducible builds and the Safe transaction that appends it ([[P4-4]] part 2e, a `ci:` PR).

## Not a result-critical record

A release record decides no election result: it says which client a voter may trust, not what any ballot or tally holds. It is never on the board and never in an election's profile. It is published to IPFS and the archive beside each release, and only the release Safe ([[0020-entry-points]]) can make it count, by appending its hash to the registry. So the rule that result-critical records hold no text ([[notation]], Result-critical fields) doesn't apply, and the record carries origins, paths, media types and header values as text. No voter, author or trustee writes any of it, so it carries no one's personal data (T-17). Each text field is restricted to printable ASCII under a grammar below, so every field has one reading and nothing in it needs Unicode handling (T-31).

## Record

Record type `0x001f` ([[versioning]]), version 1.

| Field             | Type            | Meaning                                                                                                                                                |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `l1_chain_id`     | `u64`           | The chain the release registry this record is appended to runs on (11155111, Sepolia, until the owner deploys one on mainnet; [[0036-release-record]]) |
| `registry`        | `bytes[20]`     | That registry's address                                                                                                                                |
| `sequence`        | `u64`           | The record's position in that registry: 0 for its first release, then one more for each                                                                |
| `previous`        | `bytes[32]`     | The release hash of the record at `sequence − 1` in the same registry, or 32 zero bytes when `sequence` is 0                                           |
| `source_commit`   | `bytes[20]`     | The git commit on `main` of `abolishus/abolish` the release was built from (its SHA-1 object name)                                                     |
| `deployment_hash` | `bytes[32]`     | `H(DS("abolish/v1/deployment", d))`, where `d` is the encoding of the deployment record (`0x0020`) the client is built for ([[deployment]])            |
| `sites`           | `list<site, 2>` | What the release serves: the ballot client, and the challenge page when the release has one ([[registration]], Challenge page), in ascending `kind`    |

`site`:

| Field       | Type                  | Meaning                                                                                                                                                                                  |
| ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`      | `enum8<1, 2>`         | 1: the ballot client (`apps/ballot`); 2: the challenge page (`apps/challenge`)                                                                                                           |
| `origins`   | `list<bytes<267>, 8>` | The origins that serve the site, in ascending byte order: for the ballot client its entry points ([[0020-entry-points]]), for the challenge page its one origin, which the client frames |
| `loopback`  | `bool`                | Whether `apps/node` may also serve the site at a loopback origin of its own (Loopback origins, below)                                                                                    |
| `headers`   | `list<header, 16>`    | The response headers every file of the site is served with, in ascending byte order of `name`                                                                                            |
| `files`     | `list<file, 1024>`    | Every file the site serves, in ascending byte order of `path`                                                                                                                            |
| `directory` | `bytes[36]`           | The binary CID of the site's directory: a CIDv1 dag-pb root, `0x01 ‖ 0x70 ‖ 0x12 ‖ 0x20 ‖ digest`, built from `files` as [[content-addressing]] (Sites) says                             |

`header`:

| Field   | Type          | Meaning                                |
| ------- | ------------- | -------------------------------------- |
| `name`  | `bytes<64>`   | The header's field name, in lower case |
| `value` | `bytes<4096>` | Its field value, exactly as sent       |

`file`:

| Field        | Type          | Meaning                                                      |
| ------------ | ------------- | ------------------------------------------------------------ |
| `path`       | `bytes<1024>` | The file's path below the site's root, with no leading slash |
| `length`     | `u64`         | Its length in bytes                                          |
| `sha256`     | `bytes[32]`   | SHA-256 of its bytes                                         |
| `media_type` | `bytes<127>`  | The `content-type` it is served with                         |

The encoding is the record header, then the fields in table order, each `site`, `header` and `file` as its fields in order with no header of its own ([[notation]], Records).

**Decoding.** A strict decoder ([[notation]], Strict decoding) reads a release record where only `0x001f` is expected, so `0x001f` is the only type its decoder knows: any other type is `unknown-record-type`, as for an identity backup ([[identity-backup]], Envelope). Version 1 is the only version; any other is `unknown-version`. A release belongs to no election, so no profile pins its version and `profile-mismatch` never applies. Each length and count is checked against its maximum before anything it describes is read (T-52). At its maximums a version-1 record is about 2.6 MB; a typical one is a few kilobytes.

## Well-formedness

A record that decodes is **well formed** if it breaks none of the rules below. A reader rejects an ill-formed record with the first rule it breaks, in this order: `release-chain`, `site-order` and `site-ballot`, then each site in list order, all of its rules before the next site's, then `origin-shared`. Each site rule names the site by its index in `sites` (`{"site": i}`).

| Code               | The record breaks the rule if                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release-chain`    | `sequence` is 0 and `previous` isn't 32 zero bytes, or `sequence` is above 0 and `previous` is 32 zero bytes                                                                                                                                                                                                                                                                                                   |
| `site-order`       | The sites' `kind`s aren't strictly ascending (so no kind appears twice)                                                                                                                                                                                                                                                                                                                                        |
| `site-ballot`      | No site has `kind` 1: every release serves the ballot client                                                                                                                                                                                                                                                                                                                                                   |
| `origin`           | An origin isn't an origin by the grammar below                                                                                                                                                                                                                                                                                                                                                                 |
| `origin-order`     | The site's origins aren't strictly ascending in byte order                                                                                                                                                                                                                                                                                                                                                     |
| `site-unreachable` | The site has no origin and `loopback` is false                                                                                                                                                                                                                                                                                                                                                                 |
| `loopback-site`    | `loopback` is true for a site other than the ballot client: the challenge page runs Turnstile under a site key issued for its one origin ([[registration]], Challenge page), so it can't be served anywhere else                                                                                                                                                                                               |
| `challenge-origin` | A challenge-page site doesn't list exactly one origin: [[registration]] (Challenge page) holds the challenge origin to rules a second one would escape, and the client, Turnstile's site key and [[verifier]] 1.1 must all name the same one                                                                                                                                                                   |
| `header-name`      | A header name is empty or holds a byte other than `a`–`z`, `0`–`9` and ``! # $ % & ' * + - . ^ _ ` \| ~`` (RFC 9110's `tchar`, in lower case)                                                                                                                                                                                                                                                                  |
| `header-reserved`  | A header name is `connection`, `content-encoding`, `content-length`, `content-range`, `content-type`, `keep-alive`, `proxy-connection`, `te`, `transfer-encoding` or `upgrade`: the media type is per file, the length and range are the file's, and the others describe a transfer, not the bytes (HTTP/2 and HTTP/3 forbid the connection-specific ones, so a site listing one could be served over neither) |
| `header-value`     | A header value is empty, holds a byte outside `0x20`–`0x7e`, or starts or ends with a space                                                                                                                                                                                                                                                                                                                    |
| `header-order`     | The site's header names aren't strictly ascending in byte order                                                                                                                                                                                                                                                                                                                                                |
| `site-csp`         | The site lists no `content-security-policy` header. Its value is the release's to choose (Security notes), but a site never goes without one: a page's `<meta>` policy can't set `frame-ancestors`, and a dedicated worker takes its policy only from its own response (T-43)                                                                                                                                  |
| `path`             | A path isn't one to 16 segments joined by `/`, each segment 1 to 128 bytes of `A`–`Z`, `a`–`z`, `0`–`9`, `-`, `.` and `_`, and neither `.` nor `..`                                                                                                                                                                                                                                                            |
| `path-reserved`    | A path is `_redirects` or `_headers`: IPFS gateways and some static hosts read a root file of that name as rules for paths and headers rather than serving it, so a site carrying one would be served otherwise than the record lists                                                                                                                                                                          |
| `path-order`       | The site's paths aren't strictly ascending in byte order                                                                                                                                                                                                                                                                                                                                                       |
| `path-conflict`    | One path is a directory of another: some path `q` starts with another path `p` followed by `/`                                                                                                                                                                                                                                                                                                                 |
| `site-index`       | No path is `index.html`                                                                                                                                                                                                                                                                                                                                                                                        |
| `empty-file`       | A file's `length` is 0 ([[content-addressing]]: nothing the protocol stores is empty)                                                                                                                                                                                                                                                                                                                          |
| `file-too-large`   | A file's `length` is above `MAX_RELEASE_FILE` (2²⁸ bytes, 256 MiB)                                                                                                                                                                                                                                                                                                                                             |
| `media-type`       | A media type isn't `type "/" subtype`, optionally followed by exactly `"; charset=utf-8"`, where `type` and `subtype` are each a byte of `a`–`z` or `0`–`9` followed by any number of `a`–`z`, `0`–`9` and `! # $ & - ^ _ . +` (RFC 6838's restricted names, in lower case)                                                                                                                                    |
| `directory-cid`    | `directory` doesn't start with `0x01 0x70 0x12 0x20`                                                                                                                                                                                                                                                                                                                                                           |
| `origin-shared`    | An origin is listed by both sites: the challenge page's origin is never one of the client's ([[registration]], Challenge page)                                                                                                                                                                                                                                                                                 |

An **origin** is the ASCII serialisation of an HTTPS origin ([RFC 6454](https://www.rfc-editor.org/rfc/rfc6454), §6.2, as the WHATWG URL Standard serialises it):

```
origin = "https://" host [ ":" port ]
host   = label 1*( "." label )            ; 1 to 253 bytes
label  = alnum [ *61( alnum / "-" ) alnum ] ; 1 to 63 bytes
alnum  = %x61-7A / %x30-39                ; a-z, 0-9
port   = %x31-39 *4DIGIT                  ; 1 to 65535, not 443
```

and its last label starts with a letter (`a`–`z`), so no IPv4 address is an origin: a URL parser reads a host whose last label is a number, decimal or `0x` hexadecimal, as an IPv4 address (WHATWG URL Standard, host parsing), and every top-level domain starts with a letter, in its A-label form (`xn--`) too. The port is from 1 to 65535 and isn't 443. A host is in lower case and in its A-label form (an internationalised name is listed as its `xn--` labels), with no trailing dot; the default port is never written, as browsers never write it. So each origin has exactly one listing and compares, as bytes, with what a browser reports as `location.origin` (T-31), provided each `xn--` label is a valid A-label: one that decodes to an IDNA2008 U-label which encodes back to the same bytes. The grammar doesn't check punycode; the release Safe's signers do (part 2e), and a label that isn't valid can only make the entry point unreachable, never another origin's. Origins and grammars only ever narrow: an entry that isn't HTTPS can't be listed, which leaves out path gateways and IP addresses, where other content shares the origin (T-43; [[0020-entry-points]]).

A well-formed record still says nothing about its files' bytes: that `directory` is the CID its files make, or that the files are what `source_commit` builds, is checked by whoever holds the files (Serving, below) and by the release Safe's signers (part 2e). And it says nothing about the registry: whether `sequence` and `previous` agree with the registry at `registry` is part of [[verifier]] 1.1.

## Release hash

```
release_hash = H(DS("abolish/v1/release", encode(record)))
```

over the record's whole encoding, header included ([[domain-separation]]). It is what the release registry holds, what a receipt or a report names a release by, and what `previous` chains. Because the record binds `l1_chain_id`, `registry` and `sequence`, one hash names one position in one registry: a record made for the Sepolia registry has another hash than the same release made for a mainnet one.

## Serving

A host serves a site of a release, at one of its origins, by answering `GET` and `HEAD` for:

- `/` and `/index.html` with the bytes of the file at path `index.html`;
- `/` followed by each other `path` with that file's bytes;

each with `content-type` equal to the file's `media_type` and every header the site lists, with exactly its value, and nothing at any other path. The client routes by fragment, so no other path is ever asked for ([[0020-entry-points]]). IPFS gateways also answer a directory's path (`/assets/`) with a listing page of their own at the site's origin, which is something at another path: [[verifier]] 1.1 asks for no path the record doesn't list, so it doesn't see such a page, and whether a gateway entry point can be listed at all is part 3's (T-43). A header the site lists but the host doesn't send, or sends with another value, is a host that isn't serving the release, and 1.1 fails it; so does any header the host adds beyond a short list of transfer, caching and trace headers, since an added header such as `refresh` or `clear-site-data` changes the page while every listed byte matches. An entry point whose host can't send headers at all (an ENS gateway, [[0036-release-record]], Consequences) fails 1.1 ([[verifier]], Served client).

An IPFS host serves the site's directory, `directory`, built as [[content-addressing]] (Sites) says, and anyone holding the files rebuilds it: a site whose files don't make `directory` is not the site the record lists, whatever its files hash to. So `abolishus.eth`'s `contenthash` names the ballot site's `directory` of the release the registry holds (part 3), and `apps/node` pins and serves exactly that directory.

### Loopback origins

A site with `loopback` true may also be served by `apps/node` at one origin of the form `http://127.0.0.1:<port>`, `http://[::1]:<port>` or `http://localhost:<port>`, for any port from 1 to 65535 but 80, which a browser never writes (`http://127.0.0.1:80` is `http://127.0.0.1`), so a host compares with `location.origin` as listed: browsers treat these as secure contexts, so the client's Web Crypto and workers run there, and only the voter's own machine can reach them ([[0020-entry-points]]; [[P4-5]] part 4). A loopback origin is never listed in `origins`, whose grammar admits only HTTPS. The ballot client's warning at an unlisted origin (P2-8) treats a loopback origin as listed only if its release's ballot site has `loopback` true.

## Test vectors

`docs/spec/vectors/release-record.json` (Release-record vectors, [[vectors/README|vectors]]), from an independent Python implementation (`packages/crypto/scripts/release-record-vectors.py`, standard library only): valid records (the first release of a registry, a typical release with both sites, a site reachable only at loopback origins, every field at its boundary, a site of 1,024 files, the longest and deepest paths, byte-ordered names, identical files, chunk boundaries and the largest sequence), each with its release hash; an ill-formed record for every rule above, several per grammar, each with its code; and decode rejections at every bound. Every `directory` in the file is one of `docs/spec/vectors/site-directory.json`'s, which Kubo and ipfs-unixfs-importer produced and the Python generator rebuilds from [[content-addressing]] alone before writing anything.

## Security notes

- **No release for real polls is built for a testnet deployment** ([[0044-testnet-deployments]]; [[contracts]], Testnet deployments). A release offered for real polls never binds a deployment record whose `l1_chain_id` or `l2_chain_id` is 84532, 11155111 or 31337: those deployments may precede conditions that protect real polls. For now this is a rule of the release procedure only. Neither well-formedness nor [[verifier]] 2.3 checks it, so a release built against a testnet deployment would pass both, and only a reviewer reading its deployment record catches it.
- **The record is only as good as its signers.** A release Safe quorum, or whoever compels one, can publish a record listing any files and headers (a weaker CSP, a script that leaks the vote). The registry makes that release public, not impossible ([[0036-release-record]]; T-41, T-69).
- **Header values are free text.** The grammar fixes their bytes but not their meaning: a `content-security-policy` that allows more than the client needs is well formed. The release Safe's signers check the policy against the build before signing (part 2e), and [[verifier]] 1.1 reports the headers it finds; no rule here judges a policy (T-43).
- **Size is bounded, not small.** A record at its maximums is about 2.6 MB and a site at its maximums 256 GiB. A reader bounds what it fetches by the lengths the record lists, never by what a source sends ([[content-addressing]], Reading by CID; T-52), and sets its own limit below the record's when it can't spend that much.
- **`source_commit` is a SHA-1 name.** Git names commits by SHA-1, which has chosen-prefix collisions; git's collision detection catches the known attacks only. The files are bound by SHA-256, so what the record serves rests on nothing SHA-1, but the link from a release to its reviewed source does: the signers' runbook (part 2e) binds the source by a SHA-256 of its tree as well.
- **The challenge origin's separation isn't in the record.** `origin-shared` compares bytes only. That the challenge origin isn't under the RP ID's registrable domain ([[registration]], Challenge page) needs the Public Suffix List and the RP IDs, which the deployment record carries: its `challenge-rp` rule ([[deployment]], Against its release) is the part decidable without the list, and the signers and [[verifier]] 1.1 check the rest.
- **A loopback origin is the voter's own.** Anything on the voter's machine that can listen on a loopback port can serve a client there. `apps/node` is the one program the record trusts to, and a voter who runs another is outside what any check here can see (T-41).
