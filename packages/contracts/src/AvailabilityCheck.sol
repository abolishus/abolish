// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib} from "./BallotCheck.sol";
import {IBoardElections, IBoardTrustees} from "./DeliveryCheck.sol";
import {ElectionDefinitionLib} from "./ElectionDefinition.sol";
import {TrusteeIdentityLib} from "./TrusteeRegistry.sol";

/// @title The board's check of an availability attestation or complaint
/// (docs/spec/contracts.md, Board, Availability records;
/// docs/spec/availability.md, Records and Contract path).
/// @notice An availability attestation (0x001b) or complaint (0x001c),
/// version 1, is accepted through the contract path only if it decodes
/// strictly, names a registered definition, and is signed by the
/// per-election key of a seat of that election's default panel's registered
/// key set, so a record the board archives says only what its seat signed
/// (T-17, T-31). An author seat's records are refused until the board has
/// the author panel's key set (P2-16). It judges neither the checkpoint, the
/// CID nor the time: they name L1 data the L2 doesn't read, and a record is
/// in time by its submission time, which the verifier reads (4.6). Whether an
/// attestation's roots are ones the board holds, and the one record per
/// slot, are the board's, which holds the state.
library AvailabilityCheckLib {
    /// Why a decoded record is refused, in checking order.
    enum Code {
        /// No definition with the record's hash is registered.
        AvailabilityStray,
        /// The panel isn't the default panel, or the seat isn't a seat of
        /// the election's registered key set.
        AvailabilitySeat,
        /// The signature doesn't verify under the seat's signing key.
        AvailabilitySignature,
        /// A root the attestation names isn't the record hash of an
        /// obligation root the board accepted for the definition (the
        /// board's, never the library's).
        AvailabilityRoot,
        /// The board already holds a record of the type for the definition,
        /// panel, seat and point (the board's).
        AvailabilityRepeat
    }

    error AvailabilityMalformed(ElectionDefinitionLib.DecodeError code, uint256 offset);
    error AvailabilityRefused(Code code);

    uint16 internal constant ATTESTATION_TYPE = 0x001b;
    uint16 internal constant COMPLAINT_TYPE = 0x001c;
    /// The fields both records start with (docs/spec/availability.md,
    /// Records), then an attestation's roots and a complaint's CID.
    uint256 internal constant DEFINITION_AT = 3;
    uint256 internal constant PANEL_AT = 35;
    uint256 internal constant SEAT_AT = 36;
    uint256 internal constant POINT_AT = 37;
    uint256 internal constant CHECKPOINT_AT = 38;
    uint256 internal constant COUNT_AT = 70;
    uint256 internal constant ROOTS_AT = 74;
    uint256 internal constant CID_AT = 70;
    uint256 internal constant COMPLAINT_SIG_AT = 106;
    /// `MAX_ATTESTED_ROOTS`: `2 · MAX_TRUSTEES`, one root of each kind per seat.
    uint256 internal constant MAX_ROOTS = 32;
    uint8 internal constant DEFAULT_PANEL = 1;
    uint8 internal constant BALLOT_EXTENT = 1;
    /// The first four bytes of a raw block's CID and of a dag-pb root's
    /// (CIDv1, the codec, sha2-256, 32 bytes): the only CIDs a segment
    /// object has (docs/spec/content-addressing.md).
    uint32 internal constant RAW_CID_PREFIX = 0x01551220;
    uint32 internal constant DAG_PB_CID_PREFIX = 0x01701220;

    /// `u8(len(tag)) ‖ tag` for `abolish/v1/sig/availability-attestation`
    /// (0x27 = 39) and `abolish/v1/sig/availability-complaint` (0x25 = 37).
    bytes internal constant DS_ATTESTATION = "\x27abolish/v1/sig/availability-attestation";
    bytes internal constant DS_COMPLAINT = "\x25abolish/v1/sig/availability-complaint";

    /// What an accepted record gives the board: its slot, and the seats of
    /// the key set it was checked against, which the roots are looked up by.
    struct Accepted {
        bytes32 definitionHash;
        uint8 panel;
        uint8 seat;
        uint8 point;
        uint256 seats;
    }

    /// Checks steps 1 to 4 of the availability call: strict decoding of an
    /// attestation or a complaint as version 1, `availability-stray`,
    /// `availability-seat` and `availability-signature`, in that order,
    /// reverting on the first failure. `kind` is 0 for an attestation, whose
    /// `count` roots start at `ROOTS_AT`, and 1 for a complaint.
    function check(bytes calldata r, IBoardElections elections, IBoardTrustees trustees)
        internal
        view
        returns (Accepted memory a, uint256 kind, uint256 count)
    {
        uint256 t = _uint(r, 0, 2);
        if (t != ATTESTATION_TYPE && t != COMPLAINT_TYPE) {
            _malformed(
                t != 0 && t <= BallotCheckLib.LAST_KNOWN_TYPE
                    ? ElectionDefinitionLib.DecodeError.UnexpectedRecordType
                    : ElectionDefinitionLib.DecodeError.UnknownRecordType,
                0
            );
        }
        // Contract-event version 8 fixes both records at version 1, and no
        // profile pins either (docs/spec/availability.md, Versions).
        if (_uint(r, 2, 1) != 1) _malformed(ElectionDefinitionLib.DecodeError.ProfileMismatch, 2);
        // Each field is read and validated before the next, as
        // docs/spec/availability.md (Decoding) reads them.
        a.definitionHash = bytes32(_uint(r, DEFINITION_AT, 32));
        a.panel = _enum(r, PANEL_AT);
        a.seat = uint8(_uint(r, SEAT_AT, 1));
        a.point = _enum(r, POINT_AT);
        _uint(r, CHECKPOINT_AT, 32);
        uint256 sigAt;
        if (t == ATTESTATION_TYPE) {
            count = _uint(r, COUNT_AT, 4);
            // The count is judged before any root is read (T-52), and
            // against the point, which comes before it.
            if (count > MAX_ROOTS) {
                _malformed(ElectionDefinitionLib.DecodeError.LengthOverMax, COUNT_AT);
            }
            if (a.point == BALLOT_EXTENT && count != 0) {
                _malformed(ElectionDefinitionLib.DecodeError.NonCanonical, COUNT_AT);
            }
            // Strictly ascending, so a set of roots has one encoding (T-31).
            // At most 32 roots: nothing here overflows.
            uint256 previous;
            unchecked {
                for (uint256 i; i < count; i++) {
                    uint256 at = ROOTS_AT + 32 * i;
                    uint256 root = _uint(r, at, 32);
                    if (i > 0 && root <= previous) {
                        _malformed(ElectionDefinitionLib.DecodeError.NonCanonical, at);
                    }
                    previous = root;
                }
                sigAt = ROOTS_AT + 32 * count;
            }
        } else {
            kind = 1;
            if (r.length < COMPLAINT_SIG_AT) {
                _malformed(ElectionDefinitionLib.DecodeError.Truncated, CID_AT);
            }
            uint256 prefix = _uint(r, CID_AT, 4);
            if (prefix != RAW_CID_PREFIX && prefix != DAG_PB_CID_PREFIX) {
                _malformed(ElectionDefinitionLib.DecodeError.NonCanonical, CID_AT);
            }
            sigAt = COMPLAINT_SIG_AT;
        }
        _signature(r, sigAt);
        if (r.length > sigAt + 64) {
            _malformed(ElectionDefinitionLib.DecodeError.TrailingBytes, sigAt + 64);
        }
        a.seats =
            _verify(r, a, elections, trustees, kind == 0 ? DS_ATTESTATION : DS_COMPLAINT, sigAt);
    }

    /// Steps 2 to 4: the definition is registered, the seat is a default
    /// seat of its registered key set, and the signature verifies under that
    /// seat's per-election signing key over the record before it, header
    /// included, so a later version can't reuse a version-1 signature
    /// (T-31). Returns the key set's seats.
    function _verify(
        bytes calldata r,
        Accepted memory a,
        IBoardElections elections,
        IBoardTrustees trustees,
        bytes memory tag,
        uint256 sigAt
    ) private view returns (uint256 seats) {
        if (elections.parameters(a.definitionHash).ballotVersion == 0) {
            revert AvailabilityRefused(Code.AvailabilityStray);
        }
        // The default panel's registered key set, which the trustee registry
        // recorded for the ceremony the election registry admitted the
        // definition on, never a submitter's (ADR 0028, 2B; T-37). The board
        // holds no author panel's key set, so an author seat has none.
        (bytes32 stub, bytes32 panel) = elections.ceremony(a.definitionHash);
        (, seats) = trustees.keySetOf(stub, panel);
        // Seat 0 never exists, whatever a key set's bit 0 says.
        if (a.panel != DEFAULT_PANEL || a.seat == 0 || (seats >> a.seat) & 1 == 0) {
            revert AvailabilityRefused(Code.AvailabilitySeat);
        }
        (uint256 x, uint256 y) = trustees.signingKeyOf(stub, panel, a.seat);
        if (!TrusteeIdentityLib.verify(
                sha256(bytes.concat(tag, r[0:sigAt])),
                uint256(bytes32(r[sigAt:sigAt + 32])),
                uint256(bytes32(r[sigAt + 32:sigAt + 64])),
                x,
                y
            )) {
            revert AvailabilityRefused(Code.AvailabilitySignature);
        }
    }

    /// An `enum8<1, 2>` at `o`, else `invalid-enum` there.
    function _enum(bytes calldata r, uint256 o) private pure returns (uint8 v) {
        v = uint8(_uint(r, o, 1));
        if (v != 1 && v != 2) _malformed(ElectionDefinitionLib.DecodeError.InvalidEnum, o);
    }

    /// A `p256-sig` at `o`: `1 ≤ r < n` and `1 ≤ s ≤ (n − 1) / 2`, else
    /// `non-canonical` at `o` (the low-s rule: only the signer can make a
    /// second encoding, T-31); `truncated` at `o` if it ends early.
    function _signature(bytes calldata r, uint256 o) private pure {
        if (r.length < o + 64) _malformed(ElectionDefinitionLib.DecodeError.Truncated, o);
        uint256 sigR = _uint(r, o, 32);
        uint256 sigS = _uint(r, o + 32, 32);
        if (
            sigR == 0 || sigR >= TrusteeIdentityLib.N || sigS == 0
                || sigS > TrusteeIdentityLib.HALF_N
        ) _malformed(ElectionDefinitionLib.DecodeError.NonCanonical, o);
    }

    /// The `n`-byte (1 ≤ n ≤ 32) big-endian integer at `o`; `truncated` at
    /// `o` if the record ends first.
    function _uint(bytes calldata r, uint256 o, uint256 n) private pure returns (uint256 v) {
        if (r.length < o + n) _malformed(ElectionDefinitionLib.DecodeError.Truncated, o);
        assembly ("memory-safe") {
            v := shr(sub(256, mul(n, 8)), calldataload(add(r.offset, o)))
        }
    }

    function _malformed(ElectionDefinitionLib.DecodeError code, uint256 offset) private pure {
        revert AvailabilityMalformed(code, offset);
    }
}
