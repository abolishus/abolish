// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheck, BallotCheckLib, IElectionParameters} from "./BallotCheck.sol";
import {ElectionDefinitionLib} from "./ElectionDefinition.sol";
import {ElectionRegistry} from "./ElectionRegistry.sol";
import {TrusteeIdentityLib} from "./TrusteeRegistry.sol";

/// What the board reads from the election registry: the parameters, the
/// ceremony under which the trustee registry recorded a definition's key set
/// (docs/spec/contracts.md, Election registry, Parameters), and the author
/// panel's key set recorded with the definition (Author panel registration).
interface IBoardElections is IElectionParameters {
    function ceremony(bytes32 definitionHash)
        external
        view
        returns (bytes32 stubHash, bytes32 panelId);

    function authorKeySetOf(bytes32 definitionHash)
        external
        view
        returns (bytes32 keySetHash, uint256 seats);

    function authorSigningKeyOf(bytes32 definitionHash, uint256 index)
        external
        view
        returns (uint256 x, uint256 y);
}

/// What the board reads from the trustee registry: a recorded key set's
/// seats and each seat's per-election signing key (docs/spec/contracts.md,
/// Trustee registry, Registration; ADR 0028, 2B).
interface IBoardTrustees {
    function keySetOf(bytes32 stubHash, bytes32 panelId)
        external
        view
        returns (bytes32 keySetHash, uint256 seats);

    function signingKeyOf(bytes32 stubHash, bytes32 panelId, uint256 index)
        external
        view
        returns (uint256 x, uint256 y);
}

/// @title The board's checks on delivery records (docs/spec/contracts.md,
/// Board, Delivery records; docs/spec/delivery.md, Direct submit).
/// @notice A share receipt (0x000c), share-receipt batch (0x0016),
/// complaint (0x000e), complaint batch (0x0017) or obligation root (0x001a)
/// is accepted only if
/// it decodes strictly, names a registered definition and is signed by the
/// registered per-election key of a seat of that election's key set; a share
/// posting (0x000d) only if it decodes strictly and its ciphertext is the one
/// the ballot it names committed to for a qualified seat, with the sealed
/// length the definition fixes. The board can't tell a passing receipt from
/// a failing one, nor run a posting's or complaint's public check (ML-KEM
/// and ristretto255), so none of these checks lets a record occupy a slot:
/// any number per seat and ballot are accepted (T-25, T-54). Each element is
/// framed as the ballot check frames one (ADR 0028, 3B). Every failure
/// reverts, naming the record's position in its call.
/// @dev Under ballot version 4 a receipt, posting or complaint is version 2:
/// it names its seat's panel, and is judged against that panel's key set
/// and, for a posting, that panel's share hashes (Delivery records
/// (version 2); T-25, T-37, T-54). Version-2 batches and roots aren't read
/// yet, so ballot version 4 fixes none this library takes.
library DeliveryCheckLib {
    /// What a receipt, posting or complaint names before its own fields:
    /// `shift` is 1 at version 2, whose `panel` byte at 67 moves every later
    /// field one byte on, and 0 at version 1, which names the default panel.
    struct Head {
        bytes32 definitionHash;
        bytes32 ballotHash;
        uint8 panel;
        uint8 seat;
        uint256 shift;
    }

    /// Why a decoded delivery record is refused, in checking order.
    enum Code {
        /// No definition with the record's hash is registered.
        DeliveryStray,
        /// The seat isn't a seat of the election's registered key set.
        DeliverySeat,
        /// The signature doesn't verify under the seat's registered signing key.
        DeliverySignature,
        /// `sealed` isn't `4 + 64·T + 16` bytes for the definition's `T`.
        PostingLength,
        /// The ballot carried with a posting, which passed the ballot check,
        /// isn't the one the posting names: its definition hash or its
        /// ballot hash differs.
        PostingBallot,
        /// The ciphertext's hash isn't the ballot's share hash for the seat.
        PostingHash,
        /// The seat's slot for the root's kind is already filled by another
        /// root whose signature verified (the board's, never the library's).
        RootRepeat
    }

    error DeliveryMalformed(uint256 record, ElectionDefinitionLib.DecodeError code, uint256 offset);
    error DeliveryRefused(uint256 record, Code code);

    uint16 internal constant RECEIPT_TYPE = 0x000c;
    uint16 internal constant POSTING_TYPE = 0x000d;
    uint16 internal constant COMPLAINT_TYPE = 0x000e;
    uint16 internal constant BATCH_TYPE = 0x0016;
    uint16 internal constant COMPLAINT_BATCH_TYPE = 0x0017;
    uint16 internal constant ROOT_TYPE = 0x001a;
    /// A share receipt with its header; a complaint with its header.
    uint256 internal constant RECEIPT_LENGTH = 164;
    uint256 internal constant COMPLAINT_LENGTH = 228;
    /// The fields every delivery record starts with, after its 3-byte header.
    uint256 internal constant BALLOT_HASH_AT = 35;
    uint256 internal constant SEAT_AT = 67;
    /// Version 2's `panel`, where version 1 has its seat; a receipt and a
    /// complaint are one byte longer (Delivery records (version 2)).
    uint256 internal constant PANEL_AT = 67;
    uint256 internal constant RECEIPT_V2_LENGTH = 165;
    uint256 internal constant COMPLAINT_V2_LENGTH = 229;
    uint8 internal constant DEFAULT_PANEL = 1;
    uint8 internal constant AUTHOR_PANEL = 2;
    /// A posting's fields after the seat (docs/spec/share-encryption.md,
    /// Ciphertext): `m`, then `share_ciphertext`.
    uint256 internal constant M_AT = 68;
    uint256 internal constant CIPHERTEXT_AT = 100;
    uint256 internal constant CT_DH_AT = 1188;
    uint256 internal constant SEALED_AT = 1284;
    /// `sealed`'s maximum: `encode(S_i)` at `MAX_OPTIONS` and the tag.
    uint256 internal constant MAX_SEALED = 4116;
    /// A share-receipt batch's fields (docs/spec/delivery.md, Share-receipt
    /// batch): the seat, the pairs' `u32` count, then the 64-byte pairs.
    uint256 internal constant BATCH_SEAT_AT = 35;
    uint256 internal constant BATCH_COUNT_AT = 36;
    uint256 internal constant BATCH_PAIRS_AT = 40;
    /// `RECEIPT_BATCH_MAX`.
    uint256 internal constant BATCH_MAX = 1024;
    /// `COMPLAINT_BATCH_MAX`, each entry a ballot hash and a 96-byte proof.
    uint256 internal constant COMPLAINT_BATCH_MAX = 512;

    /// An obligation root's fields (docs/spec/delivery.md, Obligation root):
    /// the seat, the kind, the leaves' `u32` count, the root, the leaf
    /// object's CID and the signature, 173 bytes in all.
    uint256 internal constant ROOT_KIND_AT = 36;
    uint256 internal constant ROOT_COUNT_AT = 37;
    uint256 internal constant ROOT_ROOT_AT = 41;
    uint256 internal constant ROOT_CID_AT = 73;
    uint256 internal constant ROOT_SIG_AT = 109;
    uint256 internal constant ROOT_LENGTH = 173;
    /// A receipt root's kind and a complaint root's, and their leaves' sizes.
    uint8 internal constant RECEIPT_ROOT = 1;
    uint8 internal constant COMPLAINT_ROOT = 2;
    /// The largest leaf object one raw block holds (docs/spec/content-addressing.md,
    /// Small objects), and the first four bytes of a raw block's CID and of a
    /// dag-pb root's: CIDv1, the codec, sha2-256, 32 bytes.
    uint256 internal constant RAW_BLOCK_MAX = 1_048_576;
    uint32 internal constant RAW_CID_PREFIX = 0x01551220;
    uint32 internal constant DAG_PB_CID_PREFIX = 0x01701220;

    /// `u8(len(tag)) ‖ tag` for `abolish/v1/sig/share-receipt` (0x1c = 28),
    /// `abolish/v1/sig/share-complaint` (0x1e = 30) and
    /// `abolish/v1/share-ciphertext` (0x1b = 27).
    bytes internal constant DS_RECEIPT = "\x1cabolish/v1/sig/share-receipt";
    bytes internal constant DS_COMPLAINT = "\x1eabolish/v1/sig/share-complaint";
    bytes internal constant DS_CIPHERTEXT = "\x1babolish/v1/share-ciphertext";
    /// `abolish/v1/sig/share-receipt-2` (0x1e = 30) and
    /// `abolish/v1/sig/share-complaint-2` (0x20 = 32): new tags, so no
    /// version-1 signature verifies on a version-2 record (T-31).
    bytes internal constant DS_RECEIPT_2 = "\x1eabolish/v1/sig/share-receipt-2";
    bytes internal constant DS_COMPLAINT_2 = "\x20abolish/v1/sig/share-complaint-2";
    /// `abolish/v1/sig/share-receipt-batch` (0x22 = 34).
    bytes internal constant DS_BATCH = "\x22abolish/v1/sig/share-receipt-batch";
    /// `abolish/v1/sig/share-complaint-batch` (0x24 = 36).
    bytes internal constant DS_COMPLAINT_BATCH = "\x24abolish/v1/sig/share-complaint-batch";
    /// `abolish/v1/sig/obligation-root` (0x1e = 30).
    bytes internal constant DS_ROOT = "\x1eabolish/v1/sig/obligation-root";

    /// Checks share receipt number `index` of a batch, a 164-byte slice (165
    /// at version 2), and returns the definition and ballot hashes it names.
    function checkReceipt(
        bytes calldata r,
        uint256 index,
        IBoardElections elections,
        IBoardTrustees trustees
    ) internal view returns (bytes32 definitionHash, bytes32 ballotHash) {
        Head memory h = _head(r, index, RECEIPT_TYPE, elections);
        uint256 s = h.shift;
        _uint(r, index, 68 + s, 32);
        _signature(r, index, 100 + s);
        if (r.length != RECEIPT_LENGTH + s) {
            _malformed(index, ElectionDefinitionLib.DecodeError.TrailingBytes, RECEIPT_LENGTH + s);
        }
        // The 97-byte statement the seat signed (98 at version 2): every
        // field before the signature (docs/spec/delivery.md, Share receipt,
        // Records (version 2)).
        (uint256 x, uint256 y) = _signingKey(h, index, elections, trustees);
        _verify(r, index, s == 0 ? DS_RECEIPT : DS_RECEIPT_2, 100 + s, x, y);
        return (h.definitionHash, h.ballotHash);
    }

    /// Checks a share-receipt batch, the record of `submitReceiptBatch`, and
    /// returns the definition hash and seat it names: framed strictly, its
    /// pairs strictly ascending by ballot hash, and one signature by the
    /// seat's registered key over every field before it. The pairs' hashes
    /// are the seat's to choose, as a single receipt's are (T-17).
    function checkReceiptBatch(bytes calldata r, IBoardElections elections, IBoardTrustees trustees)
        internal
        view
        returns (bytes32 definitionHash, uint8 seat)
    {
        (definitionHash,) = _definition(r, 0, BATCH_TYPE, elections, false);
        seat = uint8(_uint(r, 0, BATCH_SEAT_AT, 1));
        uint256 count = _uint(r, 0, BATCH_COUNT_AT, 4);
        // The count is bounded before any pair is read (T-52).
        if (count > BATCH_MAX) {
            _malformed(0, ElectionDefinitionLib.DecodeError.LengthOverMax, BATCH_COUNT_AT);
        }
        if (count == 0) {
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, BATCH_COUNT_AT);
        }
        uint256 last;
        for (uint256 j; j < count; j++) {
            uint256 o = BATCH_PAIRS_AT + 64 * j;
            // Big-endian words compare as the bytes do.
            uint256 ballotHash = _uint(r, 0, o, 32);
            if (j > 0 && ballotHash <= last) {
                _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, o);
            }
            last = ballotHash;
            _uint(r, 0, o + 32, 32);
        }
        uint256 sigAt = BATCH_PAIRS_AT + 64 * count;
        _signature(r, 0, sigAt);
        if (r.length != sigAt + 64) {
            _malformed(0, ElectionDefinitionLib.DecodeError.TrailingBytes, sigAt + 64);
        }
        // `m`: the `37 + 64·c` bytes before the signature, verified once for
        // every pair (docs/spec/delivery.md, Share-receipt batch).
        _verifyDefault(r, definitionHash, seat, elections, trustees, DS_BATCH, sigAt);
    }

    /// Checks a share-complaint batch, the record of `submitComplaintBatch`,
    /// and returns the definition hash and seat it names: framed strictly,
    /// its entries strictly ascending by ballot hash, each proof framed as a
    /// single complaint's, and one signature by the seat's registered key
    /// over every field before it. The proofs are the verifier's (T-29).
    function checkComplaintBatch(
        bytes calldata r,
        IBoardElections elections,
        IBoardTrustees trustees
    ) internal view returns (bytes32 definitionHash, uint8 seat) {
        (definitionHash,) = _definition(r, 0, COMPLAINT_BATCH_TYPE, elections, false);
        seat = uint8(_uint(r, 0, BATCH_SEAT_AT, 1));
        uint256 count = _uint(r, 0, BATCH_COUNT_AT, 4);
        // The count is bounded before any entry is read (T-52).
        if (count > COMPLAINT_BATCH_MAX) {
            _malformed(0, ElectionDefinitionLib.DecodeError.LengthOverMax, BATCH_COUNT_AT);
        }
        if (count == 0) {
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, BATCH_COUNT_AT);
        }
        uint256 last;
        for (uint256 j; j < count; j++) {
            uint256 o = BATCH_PAIRS_AT + 128 * j;
            uint256 ballotHash = _uint(r, 0, o, 32);
            if (j > 0 && ballotHash <= last) {
                _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, o);
            }
            last = ballotHash;
            // `complaint_proof`: `D`, never the identity, then `c` and `z`.
            _element(r, 0, o + 32);
            _scalar(r, 0, o + 64);
            _scalar(r, 0, o + 96);
        }
        uint256 sigAt = BATCH_PAIRS_AT + 128 * count;
        _signature(r, 0, sigAt);
        if (r.length != sigAt + 64) {
            _malformed(0, ElectionDefinitionLib.DecodeError.TrailingBytes, sigAt + 64);
        }
        _verifyDefault(r, definitionHash, seat, elections, trustees, DS_COMPLAINT_BATCH, sigAt);
    }

    /// Checks an obligation root, the record of `submitObligationRoot`, and
    /// returns the definition hash, seat and kind it names: decoded strictly,
    /// its CID's framing the one its signed kind and count give, so a root
    /// whose CID can never be canonical takes no seat's slot, and signed by
    /// the seat's registered key over every field before the signature. The
    /// leaves are on neither chain, so nothing here reads them; the root, the
    /// count against the obligation's bound and the leaves' availability are
    /// the delivery check's (docs/spec/delivery.md, Obligation root; T-52).
    function checkObligationRoot(
        bytes calldata r,
        IBoardElections elections,
        IBoardTrustees trustees
    ) internal view returns (bytes32 definitionHash, uint8 seat, uint8 kind) {
        (definitionHash,) = _definition(r, 0, ROOT_TYPE, elections, false);
        seat = uint8(_uint(r, 0, BATCH_SEAT_AT, 1));
        kind = uint8(_uint(r, 0, ROOT_KIND_AT, 1));
        if (kind != RECEIPT_ROOT && kind != COMPLAINT_ROOT) {
            _malformed(0, ElectionDefinitionLib.DecodeError.InvalidEnum, ROOT_KIND_AT);
        }
        uint256 count = _uint(r, 0, ROOT_COUNT_AT, 4);
        if (count == 0) {
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, ROOT_COUNT_AT);
        }
        // Every field is present before any is judged, as the decoder reads them.
        if (r.length < ROOT_CID_AT) {
            _malformed(0, ElectionDefinitionLib.DecodeError.Truncated, ROOT_ROOT_AT);
        }
        if (r.length < ROOT_SIG_AT) {
            _malformed(0, ElectionDefinitionLib.DecodeError.Truncated, ROOT_CID_AT);
        }
        if (r.length < ROOT_LENGTH) {
            _malformed(0, ElectionDefinitionLib.DecodeError.Truncated, ROOT_SIG_AT);
        }
        // `objectCid` of `64·c` or `128·c` bytes is one raw block up to 1 MiB
        // and a dag-pb root above, so the CID's first four bytes are fixed
        // by fields the signature covers; the digest is the leaves'.
        uint256 objectLength = (kind == RECEIPT_ROOT ? 64 : 128) * count;
        if (
            _uint(r, 0, ROOT_CID_AT, 4)
                != (objectLength <= RAW_BLOCK_MAX ? RAW_CID_PREFIX : DAG_PB_CID_PREFIX)
        ) {
            _malformed(0, ElectionDefinitionLib.DecodeError.NonCanonical, ROOT_CID_AT);
        }
        _signature(r, 0, ROOT_SIG_AT);
        if (r.length != ROOT_LENGTH) {
            _malformed(0, ElectionDefinitionLib.DecodeError.TrailingBytes, ROOT_LENGTH);
        }
        // `m`: the 106 bytes before the signature (docs/spec/delivery.md,
        // Obligation root).
        _verifyDefault(r, definitionHash, seat, elections, trustees, DS_ROOT, ROOT_SIG_AT);
    }

    /// Checks a share complaint and returns the hashes it names.
    function checkComplaint(
        bytes calldata r,
        uint256 index,
        IBoardElections elections,
        IBoardTrustees trustees
    ) internal view returns (bytes32 definitionHash, bytes32 ballotHash) {
        Head memory h = _head(r, index, COMPLAINT_TYPE, elections);
        uint256 s = h.shift;
        // `complaint_proof`: `D`, never the identity, then `c` and `z`.
        _element(r, index, 68 + s);
        _scalar(r, index, 100 + s);
        _scalar(r, index, 132 + s);
        _signature(r, index, 164 + s);
        if (r.length != COMPLAINT_LENGTH + s) {
            _malformed(index, ElectionDefinitionLib.DecodeError.TrailingBytes, COMPLAINT_LENGTH + s);
        }
        // `m`: the 161 bytes before the signature, 162 at version 2
        // (docs/spec/delivery.md, Share complaint, Records (version 2)).
        (uint256 x, uint256 y) = _signingKey(h, index, elections, trustees);
        _verify(r, index, s == 0 ? DS_COMPLAINT : DS_COMPLAINT_2, 164 + s, x, y);
        return (h.definitionHash, h.ballotHash);
    }

    /// Checks a share posting against `ballot`, the record (0x0002) of the
    /// ballot it delivers, and returns the hashes it names. The ballot must
    /// pass the whole ballot check, run by `checker`, under `qualified`, its
    /// election's key sets' seats (the default panel's, then the author
    /// panel's), membership proof included, though it is never admitted or
    /// emitted here (docs/spec/delivery.md, Direct submit): otherwise anyone
    /// could make up a ballot committing to a ciphertext of their choice and
    /// archive it whole as a posting (T-17, T-52).
    function checkPosting(
        bytes calldata r,
        bytes calldata ballot,
        IBoardElections elections,
        IBoardTrustees trustees,
        BallotCheck checker,
        uint256[2] memory qualified
    ) internal view returns (bytes32 definitionHash, bytes32 ballotHash) {
        Head memory h = _head(r, 0, POSTING_TYPE, elections);
        uint256 s = h.shift;
        _uint(r, 0, M_AT + s, 32);
        if (r.length < CT_DH_AT + s) {
            _malformed(0, ElectionDefinitionLib.DecodeError.Truncated, CIPHERTEXT_AT + s);
        }
        _element(r, 0, CT_DH_AT + s);
        _scalar(r, 0, CT_DH_AT + s + 32);
        _scalar(r, 0, CT_DH_AT + s + 64);
        uint256 sealedAt = SEALED_AT + s;
        uint256 sealedLength = _uint(r, 0, sealedAt, 4);
        if (sealedLength > MAX_SEALED) {
            _malformed(0, ElectionDefinitionLib.DecodeError.LengthOverMax, sealedAt);
        }
        if (r.length < sealedAt + 4 + sealedLength) {
            _malformed(0, ElectionDefinitionLib.DecodeError.Truncated, sealedAt + 4);
        }
        if (r.length > sealedAt + 4 + sealedLength) {
            _malformed(
                0, ElectionDefinitionLib.DecodeError.TrailingBytes, sealedAt + 4 + sealedLength
            );
        }

        _requireSeat(h, 0, elections, trustees);
        // Only `m` is free in `sealed`: `encode(S_i)` has one 64-byte share
        // per option, behind a 4-byte count, then the 16-byte tag.
        uint256 options = elections.parameters(h.definitionHash).optionCount;
        if (sealedLength != 4 + 64 * options + 16) revert DeliveryRefused(0, Code.PostingLength);

        _bindBallot(r, ballot, elections, checker, qualified, h);
        return (h.definitionHash, h.ballotHash);
    }

    /// A posting's ballot: it passes the whole ballot check, its ballot
    /// hash is the posting's, and its share hash for the posting's seat, in
    /// the list of the posting's panel, is the hash of the posting's
    /// ciphertext.
    function _bindBallot(
        bytes calldata r,
        bytes calldata ballot,
        IBoardElections elections,
        BallotCheck checker,
        uint256[2] memory qualified,
        Head memory h
    ) private view {
        (BallotCheckLib.Admitted memory a, BallotCheckLib.Layout memory l) =
            checker.check(ballot, elections, qualified[0], qualified[1]);
        // Both of the posting's names: its ballot hash binds the ballot's
        // definition, never the posting's own `definition_hash`, which must
        // be the same election, or the seat, key set and length judged above
        // would be another election's than the ballot's.
        if (a.definitionHash != h.definitionHash || a.ballotHash != h.ballotHash) {
            revert DeliveryRefused(0, Code.PostingBallot);
        }
        // A posting is judged against its own panel's list only, so it never
        // stands for a seat of the other panel (T-37, T-29).
        uint256 at = l.shareHashesAt;
        uint256 count = l.shareCount;
        if (h.panel == AUTHOR_PANEL) {
            at = l.authorShareHashesAt;
            count = l.authorShareCount;
        }
        // The ballot passed `validity-shape`, so it has `n` share hashes in
        // each panel's list, and a key-set seat is at most `n`; the bound is
        // checked anyway, so the read never depends on either registry's.
        // One SHA-256 over `ct_i` as the posting encodes it, its one
        // encoding (docs/spec/delivery.md, Share posting).
        at += 32 * (uint256(h.seat) - 1);
        if (
            h.seat > count
                || sha256(bytes.concat(DS_CIPHERTEXT, r[CIPHERTEXT_AT + h.shift:]))
                    != bytes32(ballot[at:at + 32])
        ) {
            revert DeliveryRefused(0, Code.PostingHash);
        }
    }

    /// The header and the election: type, then the election the record
    /// names, then its version, which ballot versions 1 to 3 fix at 1 and
    /// ballot version 4 at 2 (docs/spec/delivery.md, Versions, Version 2);
    /// then the ballot hash, version 2's panel and the seat. As in the ballot
    /// check, the election is found before the version means anything.
    function _head(bytes calldata r, uint256 index, uint16 expected, IBoardElections elections)
        private
        view
        returns (Head memory h)
    {
        bool two;
        (h.definitionHash, two) = _definition(r, index, expected, elections, true);
        h.ballotHash = bytes32(_uint(r, index, BALLOT_HASH_AT, 32));
        h.panel = DEFAULT_PANEL;
        if (two) {
            h.shift = 1;
            h.panel = uint8(_uint(r, index, PANEL_AT, 1));
            // Not compared with the election: an author panel's record in a
            // poll without one is read, and refused at `delivery-seat`.
            if (h.panel != DEFAULT_PANEL && h.panel != AUTHOR_PANEL) {
                _malformed(index, ElectionDefinitionLib.DecodeError.InvalidEnum, PANEL_AT);
            }
        }
        h.seat = uint8(_uint(r, index, SEAT_AT + h.shift, 1));
    }

    /// The type, the election and the version, which every delivery record
    /// starts with; a batch names no ballot hash after them. `versionTwo`
    /// says whether the caller reads version 2, which ballot version 4
    /// fixes; for one that doesn't, ballot version 4 is as unknown as any
    /// later one. Returns whether the record is version 2.
    function _definition(
        bytes calldata r,
        uint256 index,
        uint16 expected,
        IBoardElections elections,
        bool versionTwo
    ) private view returns (bytes32 definitionHash, bool two) {
        uint256 t = _uint(r, index, 0, 2);
        if (t != expected) {
            _malformed(
                index,
                t != 0 && t <= BallotCheckLib.LAST_KNOWN_TYPE
                    ? ElectionDefinitionLib.DecodeError.UnexpectedRecordType
                    : ElectionDefinitionLib.DecodeError.UnknownRecordType,
                0
            );
        }
        uint256 version = _uint(r, index, 2, 1);
        definitionHash = bytes32(_uint(r, index, 3, 32));
        uint8 pinned = elections.parameters(definitionHash).ballotVersion;
        if (pinned == 0) revert DeliveryRefused(index, Code.DeliveryStray);
        // A ballot version the board doesn't know fixes delivery versions it
        // can't know either.
        if (pinned > 4 || (pinned == 4 && !versionTwo)) {
            _malformed(index, ElectionDefinitionLib.DecodeError.UnknownVersion, 2);
        }
        two = pinned == 4;
        if (version != (two ? 2 : 1)) {
            _malformed(index, ElectionDefinitionLib.DecodeError.ProfileMismatch, 2);
        }
    }

    /// The seat is one of its panel key set's, never one a submitter names
    /// (ADR 0028, 2B; T-37): for the default panel the registered key set
    /// the trustee registry recorded for the election's stub and panel, for
    /// the author panel the key set the election registry recorded with the
    /// definition (Author panel registration), empty in a poll without one.
    /// Returns the ceremony's stub hash and panel for a default seat.
    function _requireSeat(
        Head memory h,
        uint256 index,
        IBoardElections elections,
        IBoardTrustees trustees
    ) private view returns (bytes32 stub, bytes32 panel) {
        uint256 seats;
        if (h.panel == AUTHOR_PANEL) {
            (, seats) = elections.authorKeySetOf(h.definitionHash);
        } else {
            (stub, panel) = elections.ceremony(h.definitionHash);
            (, seats) = trustees.keySetOf(stub, panel);
        }
        // Seat 0 never exists, whatever a key set's bit 0 says.
        if (h.seat == 0 || (seats >> h.seat) & 1 == 0) {
            revert DeliveryRefused(index, Code.DeliverySeat);
        }
    }

    /// The registered per-election signing key of the record's seat in its
    /// panel key set, never its identity key (docs/spec/trustee-identity.md,
    /// Which key signs what), once the seat is found in that set.
    function _signingKey(
        Head memory h,
        uint256 index,
        IBoardElections elections,
        IBoardTrustees trustees
    ) private view returns (uint256 x, uint256 y) {
        (bytes32 stub, bytes32 panel) = _requireSeat(h, index, elections, trustees);
        if (h.panel == AUTHOR_PANEL) return elections.authorSigningKeyOf(h.definitionHash, h.seat);
        return trustees.signingKeyOf(stub, panel, h.seat);
    }

    /// A version-1 batch's or root's signature, by `seat` of the default
    /// panel, the record's position 0.
    function _verifyDefault(
        bytes calldata r,
        bytes32 definitionHash,
        uint8 seat,
        IBoardElections elections,
        IBoardTrustees trustees,
        bytes memory tag,
        uint256 sigAt
    ) private view {
        Head memory h;
        h.definitionHash = definitionHash;
        h.panel = DEFAULT_PANEL;
        h.seat = seat;
        (uint256 x, uint256 y) = _signingKey(h, 0, elections, trustees);
        _verify(r, 0, tag, sigAt, x, y);
    }

    /// The signature at `sigAt` on `H(DS(tag, m))`, `m` the record's bytes
    /// from the definition hash to the signature, under the signing key
    /// `(x, y)` of the seat the record names.
    function _verify(
        bytes calldata r,
        uint256 index,
        bytes memory tag,
        uint256 sigAt,
        uint256 x,
        uint256 y
    ) private view {
        if (!TrusteeIdentityLib.verify(
                sha256(bytes.concat(tag, r[3:sigAt])),
                uint256(bytes32(r[sigAt:sigAt + 32])),
                uint256(bytes32(r[sigAt + 32:sigAt + 64])),
                x,
                y
            )) {
            revert DeliveryRefused(index, Code.DeliverySignature);
        }
    }

    /// A `p256-sig` at `o`: `1 ≤ r < n` and `1 ≤ s ≤ (n − 1) / 2`, else
    /// `non-canonical` at `o` (the low-s rule: only the signer can make a
    /// second encoding, T-31).
    function _signature(bytes calldata r, uint256 index, uint256 o) private pure {
        if (r.length < o + 64) _malformed(index, ElectionDefinitionLib.DecodeError.Truncated, o);
        uint256 sigR = _uint(r, index, o, 32);
        uint256 sigS = _uint(r, index, o + 32, 32);
        if (
            sigR == 0 || sigR >= TrusteeIdentityLib.N || sigS == 0
                || sigS > TrusteeIdentityLib.HALF_N
        ) _malformed(index, ElectionDefinitionLib.DecodeError.NonCanonical, o);
    }

    /// An `element` at `o`, framed as the ballot check frames one: its
    /// little-endian value below `2²⁵⁵ − 19`, even and not the identity.
    /// Whether it decodes to a point is the verifier's (ADR 0028, 3B).
    function _element(bytes calldata r, uint256 index, uint256 o) private pure {
        uint256 s = BallotCheckLib.reversed(_uint(r, index, o, 32));
        if (s == 0 || s >= BallotCheckLib.P25519 || s & 1 == 1) {
            _malformed(index, ElectionDefinitionLib.DecodeError.NonCanonical, o);
        }
    }

    /// A `scalar` at `o`: 32 bytes little-endian below `ℓ`.
    function _scalar(bytes calldata r, uint256 index, uint256 o) private pure {
        if (BallotCheckLib.reversed(_uint(r, index, o, 32)) >= BallotCheckLib.L) {
            _malformed(index, ElectionDefinitionLib.DecodeError.NonCanonical, o);
        }
    }

    /// The `n`-byte (1 ≤ n ≤ 32) big-endian integer at `o`; `truncated` at
    /// `o` if the record ends first.
    function _uint(bytes calldata r, uint256 index, uint256 o, uint256 n)
        private
        pure
        returns (uint256 v)
    {
        if (r.length < o + n) {
            _malformed(index, ElectionDefinitionLib.DecodeError.Truncated, o);
        }
        assembly ("memory-safe") {
            v := shr(sub(256, mul(n, 8)), calldataload(add(r.offset, o)))
        }
    }

    function _malformed(uint256 index, ElectionDefinitionLib.DecodeError code, uint256 offset)
        private
        pure
    {
        revert DeliveryMalformed(index, code, offset);
    }
}
