// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BallotCheckLib} from "./BallotCheck.sol";
import {CanonicalCalldata} from "./CanonicalCalldata.sol";
import {CloseStatementLib} from "./CloseStatement.sol";
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
/// nullifier, so no record ever occupies a slot. It takes ordinary ballots
/// only inside their election's window, and ballots forced through the L1
/// relay only from the relay's alias, judged by the relay's stamp (ADR 0030;
/// T-35, T-50). Each seat of the default panel may state the close here, at
/// most twice per election, the second only with another claim (T-17).
/// There is no admin, proxy, pause or upgrade path.
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
    /// @notice A share-receipt batch (0x0016) passed the delivery check:
    /// one seat's receipts under one signature, archived under
    /// contract-event version 4.
    event ShareReceiptBatchSubmitted(
        bytes32 indexed definitionHash, uint8 indexed seat, bytes record
    );
    /// @notice A ballot forced through the L1 relay passed the ballot check,
    /// its stamp inside the window. The relay call's index, L1 block, stamp
    /// and gas limit are the deposit's, carried, never judged: the verifier
    /// matches them against the call the relay recorded (4.5).
    event RelayedBallotSubmitted(
        bytes32 indexed definitionHash,
        bytes32 indexed ballotHash,
        uint64 index,
        uint64 l1Block,
        uint64 stamp,
        uint64 gasLimit,
        bytes record
    );
    /// @notice A seat's close statement (0x0015) passed the statement check.
    event CloseStatementSubmitted(
        bytes32 indexed definitionHash, uint8 indexed signer, bytes record
    );

    error InvalidDeployment();
    error ReceiptBatchLength(uint256 length);
    /// `ballot-window`: an ordinary ballot outside `[opens_at, closes_at]` by
    /// the block's timestamp.
    error BallotWindow(uint256 timestamp, uint64 opensAt, uint64 closesAt);
    /// `relay-sender`: the relayed-ballot call came from someone other than
    /// the relay's alias.
    error RelaySender(address caller);
    /// `relay-window`: a relayed ballot's stamp outside `[opens_at, closes_at]`.
    error RelayWindow(uint64 stamp, uint64 opensAt, uint64 closesAt);

    /// The OP Stack's L1-to-L2 alias offset: a deposit from L1 contract `a`
    /// runs on L2 from `a + offset mod 2¹⁶⁰`.
    uint160 internal constant ALIAS_OFFSET = uint160(0x1111000000000000000000000000000000001111);

    IBoardElections public immutable electionRegistry;
    IBoardTrustees public immutable trusteeRegistry;
    /// The L1 relay, whose alias alone may call `submitRelayedBallot`
    /// (docs/spec/contracts.md, Board, Deployment): verifier 1.2 compares it
    /// with the definition's `l1_relay`.
    address public immutable relay;

    /// Every accepted record, by `keccak256` of its bytes: a storage key
    /// that nothing outside the contract recomputes, never a protocol hash.
    /// Records begin with their type, so no two types' records share one.
    mapping(bytes32 recordKey => bool) private _accepted;

    /// The claims of each seat's accepted close statements, per definition:
    /// at most two, the second another claim than the first (Close
    /// statements, `statement-limit`). Zero is an empty slot.
    mapping(bytes32 definitionHash => mapping(uint8 signer => bytes32[2])) private _claims;

    constructor(address elections, address trustees, address relay_) {
        if (
            elections == address(0) || trustees == address(0) || elections == trustees
                || elections == address(this) || trustees == address(this) || relay_ == address(0)
        ) revert InvalidDeployment();
        electionRegistry = IBoardElections(elections);
        trusteeRegistry = IBoardTrustees(trustees);
        relay = relay_;
    }

    /// @notice Submits a ballot record. Reverts with the ballot check's
    /// error unless it passes (docs/spec/contracts.md, Board, Ballots), with
    /// `share-hash-unqualified` judged against the key set the trustee
    /// registry recorded for the election's ceremony, and unless the block's
    /// timestamp is inside the election's window, the ordinary path's test
    /// (docs/spec/close.md, Window), so a ballot made after close never
    /// reaches the board on this path (T-35, T-45).
    function submitBallot(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        bytes32 key = keccak256(record);
        // Only an accepted record is remembered, so a repeat passed before.
        if (_accepted[key]) return;
        BallotCheckLib.Admitted memory a =
            BallotCheckLib.check(record, electionRegistry, _qualified(record));
        if (block.timestamp < a.opensAt || block.timestamp > a.closesAt) {
            revert BallotWindow(block.timestamp, a.opensAt, a.closesAt);
        }
        _accepted[key] = true;
        _log3(BallotSubmitted.selector, a.definitionHash, a.ballotHash, abi.encode(record));
    }

    /// @notice A ballot forced through the L1 relay: the deposit the relay
    /// made for its call `index`, recorded in L1 block `l1Block` stamped
    /// `stamp`, with `gasLimit` gas (docs/spec/contracts.md, Board, Relayed
    /// ballots). Only the relay's alias may call; the record passes the
    /// ballot check exactly as an ordinary one, and its stamp is inside the
    /// window. It never consults the board's repeats: every deposit it
    /// accepts emits, so a sequencer that copies a forced ballot's bytes into
    /// an ordinary block and withholds it past `L_δ` can't turn the forced
    /// path's guarantee into the ordinary path's (T-50, T-25).
    function submitRelayedBallot(
        uint64 index,
        uint64 l1Block,
        uint64 stamp,
        uint64 gasLimit,
        bytes calldata record
    ) external {
        // Only a deposit the relay made, or one L2 governance forges from its
        // alias, gets past this, and 4.5 matches no call for a forgery (T-71).
        unchecked {
            if (msg.sender != address(uint160(relay) + ALIAS_OFFSET)) {
                revert RelaySender(msg.sender);
            }
        }
        CanonicalCalldata.requireWordsThenBytes(4, record);
        BallotCheckLib.Admitted memory a =
            BallotCheckLib.check(record, electionRegistry, _qualified(record));
        if (stamp < a.opensAt || stamp > a.closesAt) {
            revert RelayWindow(stamp, a.opensAt, a.closesAt);
        }
        // Remembered, so a later ordinary copy of the same bytes is a no-op;
        // the relayed one is judged by its own stamp.
        _accepted[keccak256(record)] = true;
        _log3(
            RelayedBallotSubmitted.selector,
            a.definitionHash,
            a.ballotHash,
            abi.encode(index, l1Block, stamp, gasLimit, record)
        );
    }

    /// @notice Submits a seat's close statement through the contract path
    /// (docs/spec/contracts.md, Board, Close statements). A byte-identical
    /// repeat is a no-op, so a node's retry never reads as a failure. At most
    /// two statements per seat and election are accepted, the second only
    /// with another claim, which shows equivocation; so a seat archives at
    /// most two statements' chosen bytes here, as through the board path
    /// (T-17). Anyone may call: the signature binds the seat.
    function submitCloseStatement(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        bytes32 key = keccak256(record);
        if (_accepted[key]) return;
        CloseStatementLib.Accepted memory a =
            CloseStatementLib.check(record, electionRegistry, trusteeRegistry);
        bytes32[2] storage claims = _claims[a.definitionHash][a.signer];
        if (claims[1] != 0 || claims[0] == a.claim) {
            revert CloseStatementLib.StatementRefused(CloseStatementLib.Code.StatementLimit);
        }
        claims[claims[0] == 0 ? 0 : 1] = a.claim;
        _accepted[key] = true;
        _log3(
            CloseStatementSubmitted.selector,
            a.definitionHash,
            bytes32(uint256(a.signer)),
            abi.encode(record)
        );
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

    /// @notice Submits a share-receipt batch: up to 1,024 of one seat's
    /// receipts under one signature, checked and emitted whole, so a trustee
    /// node forcing what it owes through L1 pays for one signature, one
    /// storage key and one event per batch (docs/spec/delivery.md, Capacity;
    /// T-25, T-54).
    function submitReceiptBatch(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        bytes32 key = keccak256(record);
        if (_accepted[key]) return;
        (bytes32 definitionHash, uint8 seat) =
            DeliveryCheckLib.checkReceiptBatch(record, electionRegistry, trusteeRegistry);
        _accepted[key] = true;
        _log3(
            ShareReceiptBatchSubmitted.selector,
            definitionHash,
            bytes32(uint256(seat)),
            abi.encode(record)
        );
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
