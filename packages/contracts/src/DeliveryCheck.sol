// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib, IElectionParameters} from "./BallotCheck.sol";
import {ElectionDefinitionLib} from "./ElectionDefinition.sol";
import {ElectionRegistry} from "./ElectionRegistry.sol";
import {TrusteeIdentityLib} from "./TrusteeRegistry.sol";

/// What the board reads from the election registry: the parameters, and the
/// ceremony under which the trustee registry recorded a definition's key set
/// (docs/spec/contracts.md, Election registry, Parameters).
interface IBoardElections is IElectionParameters {
    function ceremony(bytes32 definitionHash)
        external
        view
        returns (bytes32 stubHash, bytes32 panelId);
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
/// @notice A share receipt (0x000c) or complaint (0x000e) is accepted only if
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
library DeliveryCheckLib {
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
        /// The ballot carried with a posting names another election, or its
        /// ballot hash isn't the posting's.
        PostingBallot,
        /// The ciphertext's hash isn't the ballot's share hash for the seat.
        PostingHash
    }

    error DeliveryMalformed(uint256 record, ElectionDefinitionLib.DecodeError code, uint256 offset);
    error DeliveryRefused(uint256 record, Code code);

    uint16 internal constant RECEIPT_TYPE = 0x000c;
    uint16 internal constant POSTING_TYPE = 0x000d;
    uint16 internal constant COMPLAINT_TYPE = 0x000e;
    /// A share receipt with its header; a complaint with its header.
    uint256 internal constant RECEIPT_LENGTH = 164;
    uint256 internal constant COMPLAINT_LENGTH = 228;
    /// The fields every delivery record starts with, after its 3-byte header.
    uint256 internal constant BALLOT_HASH_AT = 35;
    uint256 internal constant SEAT_AT = 67;
    /// A posting's fields after the seat (docs/spec/share-encryption.md,
    /// Ciphertext): `m`, then `share_ciphertext`.
    uint256 internal constant M_AT = 68;
    uint256 internal constant CIPHERTEXT_AT = 100;
    uint256 internal constant CT_DH_AT = 1188;
    uint256 internal constant SEALED_AT = 1284;
    /// `sealed`'s maximum: `encode(S_i)` at `MAX_OPTIONS` and the tag.
    uint256 internal constant MAX_SEALED = 4116;

    /// `u8(len(tag)) ‖ tag` for `abolish/v1/sig/share-receipt` (0x1c = 28),
    /// `abolish/v1/sig/share-complaint` (0x1e = 30) and
    /// `abolish/v1/share-ciphertext` (0x1b = 27).
    bytes internal constant DS_RECEIPT = "\x1cabolish/v1/sig/share-receipt";
    bytes internal constant DS_COMPLAINT = "\x1eabolish/v1/sig/share-complaint";
    bytes internal constant DS_CIPHERTEXT = "\x1babolish/v1/share-ciphertext";

    /// Checks share receipt number `index` of a batch, a 164-byte slice,
    /// and returns the definition and ballot hashes it names.
    function checkReceipt(
        bytes calldata r,
        uint256 index,
        IBoardElections elections,
        IBoardTrustees trustees
    ) internal view returns (bytes32 definitionHash, bytes32 ballotHash) {
        (definitionHash, ballotHash) = _header(r, index, RECEIPT_TYPE, elections);
        _uint(r, index, SEAT_AT, 1);
        _uint(r, index, 68, 32);
        _signature(r, index, 100);
        if (r.length != RECEIPT_LENGTH) {
            _malformed(index, ElectionDefinitionLib.DecodeError.TrailingBytes, RECEIPT_LENGTH);
        }
        // The 97-byte statement the seat signed: every field before the
        // signature (docs/spec/delivery.md, Share receipt).
        _verify(r, index, definitionHash, elections, trustees, DS_RECEIPT, 100);
    }

    /// Checks a share complaint and returns the hashes it names.
    function checkComplaint(
        bytes calldata r,
        uint256 index,
        IBoardElections elections,
        IBoardTrustees trustees
    ) internal view returns (bytes32 definitionHash, bytes32 ballotHash) {
        (definitionHash, ballotHash) = _header(r, index, COMPLAINT_TYPE, elections);
        _uint(r, index, SEAT_AT, 1);
        // `complaint_proof`: `D`, never the identity, then `c` and `z`.
        _element(r, index, 68);
        _scalar(r, index, 100);
        _scalar(r, index, 132);
        _signature(r, index, 164);
        if (r.length != COMPLAINT_LENGTH) {
            _malformed(index, ElectionDefinitionLib.DecodeError.TrailingBytes, COMPLAINT_LENGTH);
        }
        // `m`: the 161 bytes before the signature (docs/spec/delivery.md,
        // Share complaint).
        _verify(r, index, definitionHash, elections, trustees, DS_COMPLAINT, 164);
    }

    /// Checks a share posting against `ballot`, the record (0x0002) of the
    /// ballot it delivers, and returns the hashes it names. The ballot is
    /// framed only to recompute its ballot hash and find its share hash:
    /// a posting never admits a ballot (docs/spec/delivery.md, Direct submit).
    function checkPosting(
        bytes calldata r,
        bytes calldata ballot,
        IBoardElections elections,
        IBoardTrustees trustees
    ) internal view returns (bytes32 definitionHash, bytes32 ballotHash) {
        (definitionHash, ballotHash) = _header(r, 0, POSTING_TYPE, elections);
        uint256 seat = _uint(r, 0, SEAT_AT, 1);
        _uint(r, 0, M_AT, 32);
        if (r.length < CT_DH_AT) {
            _malformed(0, ElectionDefinitionLib.DecodeError.Truncated, CIPHERTEXT_AT);
        }
        _element(r, 0, CT_DH_AT);
        _scalar(r, 0, CT_DH_AT + 32);
        _scalar(r, 0, CT_DH_AT + 64);
        uint256 sealedLength = _uint(r, 0, SEALED_AT, 4);
        if (sealedLength > MAX_SEALED) {
            _malformed(0, ElectionDefinitionLib.DecodeError.LengthOverMax, SEALED_AT);
        }
        if (r.length < SEALED_AT + 4 + sealedLength) {
            _malformed(0, ElectionDefinitionLib.DecodeError.Truncated, SEALED_AT + 4);
        }
        if (r.length > SEALED_AT + 4 + sealedLength) {
            _malformed(
                0, ElectionDefinitionLib.DecodeError.TrailingBytes, SEALED_AT + 4 + sealedLength
            );
        }

        _requireSeat(definitionHash, seat, 0, elections, trustees);
        // Only `m` is free in `sealed`: `encode(S_i)` has one 64-byte share
        // per option, behind a 4-byte count, then the 16-byte tag.
        uint256 options = elections.parameters(definitionHash).optionCount;
        if (sealedLength != 4 + 64 * options + 16) revert DeliveryRefused(0, Code.PostingLength);

        BallotCheckLib.Admitted memory a;
        (, BallotCheckLib.Layout memory l) = BallotCheckLib.frame(ballot, elections, a);
        if (a.definitionHash != definitionHash || BallotCheckLib.ballotHash(ballot) != ballotHash) {
            revert DeliveryRefused(0, Code.PostingBallot);
        }
        // One SHA-256 over `ct_i` as the posting encodes it, its one
        // encoding (docs/spec/delivery.md, Share posting).
        if (
            seat > l.shareCount
                || sha256(bytes.concat(DS_CIPHERTEXT, r[CIPHERTEXT_AT:]))
                    != bytes32(
                        ballot[l.shareHashesAt + 32 * (seat - 1):l.shareHashesAt + 32 * seat]
                    )
        ) revert DeliveryRefused(0, Code.PostingHash);
    }

    /// The header and the election: type, then the election the record
    /// names, then its version, which ballot versions 1 to 3 fix at 1
    /// (docs/spec/delivery.md, Versions). As in the ballot check, the
    /// election is found before the version means anything.
    function _header(bytes calldata r, uint256 index, uint16 expected, IBoardElections elections)
        private
        view
        returns (bytes32 definitionHash, bytes32 ballotHash)
    {
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
        if (pinned > 3) _malformed(index, ElectionDefinitionLib.DecodeError.UnknownVersion, 2);
        if (version != 1) _malformed(index, ElectionDefinitionLib.DecodeError.ProfileMismatch, 2);
        ballotHash = bytes32(_uint(r, index, BALLOT_HASH_AT, 32));
    }

    /// The seat is one of the registered key set's, which the trustee
    /// registry recorded for the election's stub and panel, never one a
    /// submitter names (ADR 0028, 2B; T-37). Returns the ceremony's stub
    /// hash and panel.
    function _requireSeat(
        bytes32 definitionHash,
        uint256 seat,
        uint256 index,
        IBoardElections elections,
        IBoardTrustees trustees
    ) private view returns (bytes32 stub, bytes32 panel) {
        (stub, panel) = elections.ceremony(definitionHash);
        (, uint256 seats) = trustees.keySetOf(stub, panel);
        // Seat 0 never exists, whatever a key set's bit 0 says.
        if (seat == 0 || (seats >> seat) & 1 == 0) {
            revert DeliveryRefused(index, Code.DeliverySeat);
        }
    }

    /// The seat's signature, by its registered per-election signing key,
    /// never its identity key (docs/spec/trustee-identity.md, Which key signs
    /// what), on `H(DS(tag, m))` with `m` the record's bytes from the
    /// definition hash to the signature at `sigAt`.
    function _verify(
        bytes calldata r,
        uint256 index,
        bytes32 definitionHash,
        IBoardElections elections,
        IBoardTrustees trustees,
        bytes memory tag,
        uint256 sigAt
    ) private view {
        uint256 seat = uint8(r[SEAT_AT]);
        (bytes32 stub, bytes32 panel) =
            _requireSeat(definitionHash, seat, index, elections, trustees);
        (uint256 x, uint256 y) = trustees.signingKeyOf(stub, panel, seat);
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
