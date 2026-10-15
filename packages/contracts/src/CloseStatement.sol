// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib} from "./BallotCheck.sol";
import {IBoardElections, IBoardTrustees} from "./DeliveryCheck.sol";
import {ElectionDefinitionLib} from "./ElectionDefinition.sol";
import {TrusteeIdentityLib} from "./TrusteeRegistry.sol";

/// @title The board's check of a close statement (docs/spec/contracts.md,
/// Board, Close statements; docs/spec/close.md, Close statement).
/// @notice A close statement (0x0015, version 1) is accepted through the
/// contract path only if it decodes strictly, names a registered definition,
/// and is signed by the per-election key of a seat of that election's
/// default panel's registered key set. So a statement the board archives says
/// only what its seat signed, and what anyone else can put through the call
/// is nothing (T-17, T-31). It judges neither `L_δ`, the claim nor the time:
/// the board's own L2 view is no evidence of `head(L_δ)`, and a statement is
/// in time by its submission time, which the verifier reads (docs/spec/close.md,
/// Window). The limit of two statements per seat is the board's, which
/// holds the state.
library CloseStatementLib {
    /// Why a decoded statement is refused, in checking order.
    enum Code {
        /// No definition with the statement's hash is registered.
        StatementStray,
        /// The signer isn't a seat of the election's registered key set.
        StatementSeat,
        /// The signature doesn't verify under the seat's signing key.
        StatementSignature,
        /// The board already holds two of the seat's statements for the
        /// definition, or one with the same claim.
        StatementLimit
    }

    error StatementMalformed(ElectionDefinitionLib.DecodeError code, uint256 offset);
    error StatementRefused(Code code);

    uint16 internal constant RECORD_TYPE = 0x0015;
    /// The fields' offsets (docs/spec/close.md, Close statement).
    uint256 internal constant DEFINITION_AT = 3;
    uint256 internal constant SIGNER_AT = 35;
    uint256 internal constant L1_NUMBER_AT = 36;
    uint256 internal constant L1_HASH_AT = 44;
    uint256 internal constant L2_NUMBER_AT = 76;
    uint256 internal constant L2_HASH_AT = 84;
    uint256 internal constant SIGNATURE_AT = 116;
    uint256 internal constant LENGTH = 180;

    /// `u8(len(tag)) ‖ tag` for `abolish/v1/sig/close-statement` (0x1e = 30).
    bytes internal constant DS_CLOSE_STATEMENT = "\x1eabolish/v1/sig/close-statement";

    /// What an accepted statement gives the board: the election, the seat,
    /// and a key for its claim, `keccak256(l2_number ‖ l2_hash)`, a storage
    /// key nothing outside the contract recomputes.
    struct Accepted {
        bytes32 definitionHash;
        uint8 signer;
        bytes32 claim;
    }

    /// Checks steps 1 to 4 of the statement call: strict decoding as version
    /// 1, `statement-stray`, `statement-seat` and `statement-signature`, in
    /// that order, reverting on the first failure.
    function check(bytes calldata r, IBoardElections elections, IBoardTrustees trustees)
        internal
        view
        returns (Accepted memory a)
    {
        uint256 t = _uint(r, 0, 2);
        if (t != RECORD_TYPE) {
            _malformed(
                t != 0 && t <= BallotCheckLib.LAST_KNOWN_TYPE
                    ? ElectionDefinitionLib.DecodeError.UnexpectedRecordType
                    : ElectionDefinitionLib.DecodeError.UnknownRecordType,
                0
            );
        }
        // Contract-event version 3 fixes the statement's contract-path
        // version at 1; no profile pins it (docs/spec/close.md, Version).
        if (_uint(r, 2, 1) != 1) _malformed(ElectionDefinitionLib.DecodeError.UnknownVersion, 2);
        a.definitionHash = bytes32(_uint(r, DEFINITION_AT, 32));
        a.signer = uint8(_uint(r, SIGNER_AT, 1));
        _uint(r, L1_NUMBER_AT, 8);
        _uint(r, L1_HASH_AT, 32);
        _uint(r, L2_NUMBER_AT, 8);
        _uint(r, L2_HASH_AT, 32);
        // A `p256-sig`: `1 ≤ r < n` and `1 ≤ s ≤ (n − 1) / 2`, the low-s rule,
        // so only the signer can make a second encoding (T-31).
        if (r.length < LENGTH) {
            _malformed(ElectionDefinitionLib.DecodeError.Truncated, SIGNATURE_AT);
        }
        uint256 sigR = _uint(r, SIGNATURE_AT, 32);
        uint256 sigS = _uint(r, SIGNATURE_AT + 32, 32);
        if (
            sigR == 0 || sigR >= TrusteeIdentityLib.N || sigS == 0
                || sigS > TrusteeIdentityLib.HALF_N
        ) _malformed(ElectionDefinitionLib.DecodeError.NonCanonical, SIGNATURE_AT);
        if (r.length > LENGTH) _malformed(ElectionDefinitionLib.DecodeError.TrailingBytes, LENGTH);

        if (elections.parameters(a.definitionHash).ballotVersion == 0) {
            revert StatementRefused(Code.StatementStray);
        }
        // The default panel's registered key set, which the trustee registry
        // recorded for the ceremony the election registry admitted the
        // definition on, never a submitter's (ADR 0028, 2B; T-37).
        (bytes32 stub, bytes32 panel) = elections.ceremony(a.definitionHash);
        (, uint256 seats) = trustees.keySetOf(stub, panel);
        // Seat 0 never exists, whatever a key set's bit 0 says.
        if (a.signer == 0 || (seats >> a.signer) & 1 == 0) {
            revert StatementRefused(Code.StatementSeat);
        }
        // The seat's per-election signing key, never its identity key, over
        // the record's first 116 bytes, header included, so a later version
        // can't reuse a version-1 signature (docs/spec/close.md; T-31).
        (uint256 x, uint256 y) = trustees.signingKeyOf(stub, panel, a.signer);
        if (!TrusteeIdentityLib.verify(
                sha256(bytes.concat(DS_CLOSE_STATEMENT, r[0:SIGNATURE_AT])), sigR, sigS, x, y
            )) {
            revert StatementRefused(Code.StatementSignature);
        }
        a.claim = keccak256(r[L2_NUMBER_AT:SIGNATURE_AT]);
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
        revert StatementMalformed(code, offset);
    }
}
