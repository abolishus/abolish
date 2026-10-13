// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib} from "./BallotCheck.sol";
import {CanonicalCalldata} from "./CanonicalCalldata.sol";
import {DeliveryCheckLib, IBoardElections, IBoardTrustees} from "./DeliveryCheck.sol";
import {EventAccumulator} from "./EventAccumulator.sol";

/// @title The board's direct-submit path (docs/spec/contracts.md, Board).
/// @notice Anyone submits a ballot here, bypassing our servers, and every
/// share receipt, posting and complaint has its contract path here
/// (docs/spec/delivery.md, Direct submit; T-25, T-54). Each accepted record
/// is emitted whole, as its own event under the event accumulator, so it
/// reaches the board as a contract-event record carrying exactly the record
/// (ADR 0025; T-17, T-71). Every check reads the election from the registries
/// this board pins, never from a submitter (ADR 0028, 1C and 2B). A
/// byte-identical resubmission succeeds and emits nothing, so a client's
/// retry never reads as a failure and nothing is archived twice; any other
/// record that passes is accepted, however many there are per seat or
/// nullifier, so no record ever occupies a slot. There is no admin, proxy,
/// pause or upgrade path.
contract Board is EventAccumulator {
    /// @notice A ballot record (0x0002) passed the ballot check.
    event BallotSubmitted(bytes32 indexed definitionHash, bytes32 indexed ballotHash, bytes record);
    /// @notice A share receipt (0x000c) passed the delivery check.
    event ShareReceiptSubmitted(
        bytes32 indexed definitionHash, bytes32 indexed ballotHash, bytes record
    );
    /// @notice A share posting (0x000d) passed the delivery check. The ballot
    /// it was checked against isn't emitted: its hash is the posting's.
    event SharePosted(bytes32 indexed definitionHash, bytes32 indexed ballotHash, bytes record);
    /// @notice A share complaint (0x000e) passed the delivery check.
    event ShareComplaintSubmitted(
        bytes32 indexed definitionHash, bytes32 indexed ballotHash, bytes record
    );

    error InvalidDeployment();
    error ReceiptBatchLength(uint256 length);

    IBoardElections public immutable electionRegistry;
    IBoardTrustees public immutable trusteeRegistry;

    /// Every accepted record, by `keccak256` of its bytes: a storage key
    /// that nothing outside the contract recomputes, never a protocol hash.
    /// Records begin with their type, so no two types' records share one.
    mapping(bytes32 recordKey => bool) private _accepted;

    constructor(address elections, address trustees) {
        if (
            elections == address(0) || trustees == address(0) || elections == trustees
                || elections == address(this) || trustees == address(this)
        ) revert InvalidDeployment();
        electionRegistry = IBoardElections(elections);
        trusteeRegistry = IBoardTrustees(trustees);
    }

    /// @notice Submits a ballot record. Reverts with the ballot check's
    /// error unless it passes (docs/spec/contracts.md, Board, Ballots), with
    /// `share-hash-unqualified` judged against the key set the trustee
    /// registry recorded for the election's ceremony.
    function submitBallot(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        bytes32 key = keccak256(record);
        // Only an accepted record is remembered, so a repeat passed before.
        if (_accepted[key]) return;
        BallotCheckLib.Admitted memory a =
            BallotCheckLib.check(record, electionRegistry, _qualified(record));
        _accepted[key] = true;
        _log3(BallotSubmitted.selector, a.definitionHash, a.ballotHash, abi.encode(record));
    }

    /// @notice Submits share receipts: one or more 164-byte records,
    /// concatenated, so a trustee node sends what it owes in one call
    /// (docs/spec/delivery.md, What a node owes). Each is checked and
    /// emitted on its own; one that fails reverts the batch, naming it.
    function submitReceipts(bytes calldata receipts) external {
        CanonicalCalldata.requireOneBytesArgument(receipts);
        uint256 length = DeliveryCheckLib.RECEIPT_LENGTH;
        if (receipts.length == 0 || receipts.length % length != 0) {
            revert ReceiptBatchLength(receipts.length);
        }
        for (uint256 i; i < receipts.length / length; i++) {
            bytes calldata r = receipts[i * length:(i + 1) * length];
            bytes32 key = keccak256(r);
            if (_accepted[key]) continue;
            (bytes32 definitionHash, bytes32 ballotHash) =
                DeliveryCheckLib.checkReceipt(r, i, electionRegistry, trusteeRegistry);
            _accepted[key] = true;
            _log3(ShareReceiptSubmitted.selector, definitionHash, ballotHash, abi.encode(r));
        }
    }

    /// @notice Submits a share posting with the record of the ballot it
    /// delivers, which must pass the ballot check, and whose share hash for
    /// the seat the posting's ciphertext must match. Only the posting is
    /// emitted.
    function submitPosting(bytes calldata posting, bytes calldata ballot) external {
        CanonicalCalldata.requireTwoBytesArguments(posting, ballot);
        bytes32 key = keccak256(posting);
        if (_accepted[key]) return;
        (bytes32 definitionHash, bytes32 ballotHash) = DeliveryCheckLib.checkPosting(
            posting, ballot, electionRegistry, trusteeRegistry, _qualified(ballot)
        );
        _accepted[key] = true;
        _log3(SharePosted.selector, definitionHash, ballotHash, abi.encode(posting));
    }

    /// @notice Submits a share complaint.
    function submitComplaint(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        bytes32 key = keccak256(record);
        if (_accepted[key]) return;
        (bytes32 definitionHash, bytes32 ballotHash) =
            DeliveryCheckLib.checkComplaint(record, 0, electionRegistry, trusteeRegistry);
        _accepted[key] = true;
        _log3(ShareComplaintSubmitted.selector, definitionHash, ballotHash, abi.encode(record));
    }

    /// The seats of the key set the trustee registry recorded for the
    /// ceremony of the election a ballot record names, never a submitter's
    /// (ADR 0028, 2B). Zero for a record too short to name an election,
    /// which the ballot check's header refuses first.
    function _qualified(bytes calldata record) private view returns (uint256 qualified) {
        if (record.length < BallotCheckLib.TIER_AT) return 0;
        (bytes32 stub, bytes32 panel) = electionRegistry.ceremony(
            bytes32(record[BallotCheckLib.DEFINITION_AT:BallotCheckLib.TIER_AT])
        );
        (, qualified) = trusteeRegistry.keySetOf(stub, panel);
    }
}
