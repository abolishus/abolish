// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {AvailabilityCheckLib} from "./AvailabilityCheck.sol";
import {BallotCheck, BallotCheckLib} from "./BallotCheck.sol";
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
/// most twice per election, the second only with another claim; each seat of
/// either panel may commit one obligation root of each kind per election
/// (T-17), and attest that the board was available to it, or complain that
/// it wasn't, once per point and election (docs/spec/availability.md,
/// Contract path; T-24, T-53).
/// The ballot check runs in a contract the board creates at construction,
/// outside the board's size limit (Deployment). There is no admin, proxy,
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
    /// @notice A share-receipt batch (0x0016) passed the delivery check:
    /// one seat's receipts under one signature, archived under
    /// contract-event version 4.
    event ShareReceiptBatchSubmitted(
        bytes32 indexed definitionHash, uint8 indexed seat, bytes record
    );
    /// @notice A share-complaint batch (0x0017) passed the delivery check:
    /// one seat's complaints under one signature, archived under
    /// contract-event version 4.
    event ShareComplaintBatchSubmitted(
        bytes32 indexed definitionHash, uint8 indexed seat, bytes record
    );
    /// @notice An obligation root (0x001a) passed the delivery check and
    /// filled its seat's slot for its kind: one seat's receipts or complaints
    /// committed as one signed Merkle root, archived under contract-event
    /// version 5.
    event ObligationRootSubmitted(bytes32 indexed definitionHash, uint8 indexed seat, bytes record);
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
    /// @notice A seat's availability attestation (0x001b) passed the
    /// availability check and filled its slot, archived under contract-event
    /// version 8.
    event AvailabilityAttestationSubmitted(
        bytes32 indexed definitionHash, uint8 indexed seat, bytes record
    );
    /// @notice A seat's availability complaint (0x001c) passed the
    /// availability check and filled its slot, archived under contract-event
    /// version 8.
    event AvailabilityComplaintSubmitted(
        bytes32 indexed definitionHash, uint8 indexed seat, bytes record
    );
    /// @notice A rolling poll's ballot (version 5) passed the ballot check
    /// against `root`, the root its submitter supplied, archived under
    /// contract-event version 10. The root is carried, never trusted: the
    /// verifier compares it with the root of the step the ballot names
    /// (`root-step-mismatch`; T-04, T-08).
    event RollingBallotSubmitted(
        bytes32 indexed definitionHash, bytes32 indexed ballotHash, bytes32 root, bytes record
    );
    /// @notice A rolling poll's ballot (version 5) forced through the L1
    /// relay passed the ballot check against `root`, the root the relay
    /// carried, its stamp inside the window, archived under contract-event
    /// version 11. The call fields and the root are the deposit's, carried,
    /// never judged: the verifier matches all five, with the record, against
    /// the word the relay stored for call `index` (4.5), and compares the
    /// root with the step's (`root-step-mismatch`; T-50, T-04).
    event RelayedRollingBallotSubmitted(
        bytes32 indexed definitionHash,
        bytes32 indexed ballotHash,
        uint64 index,
        uint64 l1Block,
        uint64 stamp,
        uint64 gasLimit,
        bytes32 root,
        bytes record
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
    /// The L1 relay, whose alias alone may call `submitRelayedBallot` and
    /// `submitRelayedRollingBallot` (docs/spec/contracts.md, Board, Deployment): verifier 1.2 compares it
    /// with the definition's `l1_relay`.
    address public immutable relay;
    /// The ballot check, which this board created in its constructor, so it
    /// is at the address of the board's first creation and holds the release
    /// build's code: verifier 1.2 checks both (Deployment; T-64).
    BallotCheck public immutable ballotCheck;

    /// Every accepted record, by `keccak256` of its bytes: a storage key
    /// that nothing outside the contract recomputes, never a protocol hash.
    /// Records begin with their type, so no two types' records share one.
    mapping(bytes32 recordKey => bool) private _accepted;

    /// The claims of each seat's accepted close statements, per definition:
    /// at most two, the second another claim than the first (Close
    /// statements, `statement-limit`). Zero is an empty slot.
    mapping(bytes32 definitionHash => mapping(uint8 signer => bytes32[2])) private _claims;

    /// Each seat's obligation-root slots, per definition and panel (1 the
    /// default, 2 the author panel; a version-1 root is the default
    /// panel's): at `kind − 1` (1 for receipts, 2 for complaints) the record
    /// hash of the root accepted for that kind, zero while the slot is empty
    /// (docs/spec/delivery.md, Obligation root, One per seat and kind; Records
    /// (version 2), One per panel, seat and kind), which an attestation's
    /// roots are looked up in, in its own panel's slots only
    /// (docs/spec/contracts.md, Board, Availability records).
    mapping(
        bytes32 definitionHash => mapping(uint8 panel => mapping(uint8 seat => bytes32[2] hashes))
    ) private _roots;

    /// The availability slots each seat has filled, per definition: bit
    /// `4 · (panel − 1) + 2 · kind + (point − 1)`, `kind` 0 for an
    /// attestation and 1 for a complaint, set once its record is accepted
    /// (docs/spec/contracts.md, Board, Availability records, step 6).
    mapping(bytes32 definitionHash => mapping(uint8 seat => uint8 slots)) private _availability;

    /// `u8(len(tag)) ‖ tag` for `abolish/v1/obligation-root` (0x1a = 26),
    /// under which a root's record hash is taken (docs/spec/delivery.md,
    /// Leaf availability).
    bytes internal constant DS_OBLIGATION_ROOT = "\x1aabolish/v1/obligation-root";

    constructor(address elections, address trustees, address relay_) {
        if (
            elections == address(0) || trustees == address(0) || elections == trustees
                || elections == address(this) || trustees == address(this) || relay_ == address(0)
        ) revert InvalidDeployment();
        electionRegistry = IBoardElections(elections);
        trusteeRegistry = IBoardTrustees(trustees);
        relay = relay_;
        ballotCheck = new BallotCheck();
    }

    /// @notice Submits a ballot record. Reverts with the ballot check's
    /// error unless it passes (docs/spec/contracts.md, Board, Ballots;
    /// Ballots (version 4)), with `share-hash-unqualified` judged against the
    /// key set the trustee registry recorded for the election's ceremony and
    /// the author key set the election registry recorded with its
    /// definition, and unless the block's
    /// timestamp is inside the election's window, the ordinary path's test
    /// (docs/spec/close.md, Window), so a ballot made after close never
    /// reaches the board on this path (T-35, T-45).
    function submitBallot(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        bytes32 key = keccak256(record);
        // Only an accepted record is remembered, so a repeat passed before.
        if (_accepted[key]) return;
        uint256[2] memory q = _qualified(record);
        (BallotCheckLib.Admitted memory a,) =
            ballotCheck.check(record, electionRegistry, q[0], q[1]);
        if (block.timestamp < a.opensAt || block.timestamp > a.closesAt) {
            revert BallotWindow(block.timestamp, a.opensAt, a.closesAt);
        }
        _emit(BallotSubmitted.selector, key, a.definitionHash, a.ballotHash, record);
    }

    /// @notice Submits a rolling poll's ballot record with `root`, the root
    /// of the step tree its membership proof was made against
    /// (docs/spec/contracts.md, Board, Rolling ballots). Reverts unless the
    /// calldata is canonical, the record passes the ballot check as version
    /// 5 with its proof checked against `root` under the tier's rolling
    /// scope, and the block's timestamp is inside the window, as
    /// `submitBallot`'s. The proof fixes the root, so a repeat of an accepted
    /// record is the no-op whatever root comes with it, and a copy carrying
    /// another root fails the proof: no front-runner can keep an honest
    /// submission off the board or attach another root to it (T-25, T-38).
    /// Anyone can prove against a tree of their own, so spam control here is
    /// gas only (T-52).
    function submitRollingBallot(bytes32 root, bytes calldata record) external {
        CanonicalCalldata.requireWordsThenBytes(1, record);
        bytes32 key = keccak256(record);
        if (_accepted[key]) return;
        uint256[2] memory q = _qualified(record);
        (BallotCheckLib.Admitted memory a,) =
            ballotCheck.checkRolling(record, electionRegistry, uint256(root), q[0], q[1]);
        if (block.timestamp < a.opensAt || block.timestamp > a.closesAt) {
            revert BallotWindow(block.timestamp, a.opensAt, a.closesAt);
        }
        _accepted[key] = true;
        _log3(
            RollingBallotSubmitted.selector,
            a.definitionHash,
            a.ballotHash,
            abi.encode(root, record)
        );
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
        _requireRelay();
        CanonicalCalldata.requireWordsThenBytes(4, record);
        uint256[2] memory q = _qualified(record);
        (BallotCheckLib.Admitted memory a,) =
            ballotCheck.check(record, electionRegistry, q[0], q[1]);
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

    /// @notice A rolling poll's ballot forced through the L1 relay: the
    /// deposit the relay's rolling call `index` made, recorded in L1 block
    /// `l1Block` stamped `stamp`, with `gasLimit` gas, carrying `root`, the
    /// root of the step tree the ballot's membership proof was made against
    /// (docs/spec/contracts.md, Board, Relayed rolling ballots). Only the
    /// relay's alias may call; the record passes the ballot check as
    /// `submitRollingBallot`'s does, its proof checked against `root`, and
    /// its stamp is inside the window. As on `submitRelayedBallot`, every
    /// deposit it accepts emits, repeats included (T-50, T-25). The relay's
    /// call hash binds the root, so a deposit carrying another root matches
    /// no call, and a second call with another root fails the proof here,
    /// which fixes its root (T-38).
    function submitRelayedRollingBallot(
        uint64 index,
        uint64 l1Block,
        uint64 stamp,
        uint64 gasLimit,
        bytes32 root,
        bytes calldata record
    ) external {
        _requireRelay();
        CanonicalCalldata.requireWordsThenBytes(5, record);
        uint256[2] memory q = _qualified(record);
        (BallotCheckLib.Admitted memory a,) =
            ballotCheck.checkRolling(record, electionRegistry, uint256(root), q[0], q[1]);
        if (stamp < a.opensAt || stamp > a.closesAt) {
            revert RelayWindow(stamp, a.opensAt, a.closesAt);
        }
        _accepted[keccak256(record)] = true;
        _log3(
            RelayedRollingBallotSubmitted.selector,
            a.definitionHash,
            a.ballotHash,
            abi.encode(index, l1Block, stamp, gasLimit, root, record)
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
        _emit(
            CloseStatementSubmitted.selector,
            key,
            a.definitionHash,
            bytes32(uint256(a.signer)),
            record
        );
    }

    /// @notice Submits share receipts: one or more records of 164 bytes (165
    /// at version 2), concatenated, so a trustee node sends what it owes in one call
    /// (docs/spec/delivery.md, What a node owes). Each is checked and
    /// emitted on its own; one that fails reverts the batch, naming it.
    function submitReceipts(bytes calldata receipts) external {
        CanonicalCalldata.requireOneBytesArgument(receipts);
        // The framing first, whole: each receipt's length is the one its
        // version byte gives, and the argument ends where its last does.
        uint256 at;
        while (at < receipts.length) {
            if (receipts.length - at < 3) revert ReceiptBatchLength(receipts.length);
            at += _receiptLength(receipts[at + 2]);
        }
        if (receipts.length == 0 || at != receipts.length) {
            revert ReceiptBatchLength(receipts.length);
        }
        at = 0;
        for (uint256 i; at < receipts.length; i++) {
            uint256 end = at + _receiptLength(receipts[at + 2]);
            bytes calldata r = receipts[at:end];
            at = end;
            bytes32 key = keccak256(r);
            if (_accepted[key]) continue;
            (bytes32 definitionHash, bytes32 ballotHash) =
                DeliveryCheckLib.checkReceipt(r, i, electionRegistry, trusteeRegistry);
            _emit(ShareReceiptSubmitted.selector, key, definitionHash, ballotHash, r);
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
        _emit(
            ShareReceiptBatchSubmitted.selector, key, definitionHash, bytes32(uint256(seat)), record
        );
    }

    /// @notice Submits a share-complaint batch: up to 512 of one seat's
    /// complaints under one signature, checked and emitted whole, so a node
    /// forcing what it owes through L1 pays for one signature, one storage
    /// key and one event per batch (docs/spec/delivery.md, Capacity; T-25,
    /// T-54).
    function submitComplaintBatch(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        bytes32 key = keccak256(record);
        if (_accepted[key]) return;
        (bytes32 definitionHash, uint8 seat) =
            DeliveryCheckLib.checkComplaintBatch(record, electionRegistry, trusteeRegistry);
        _emit(
            ShareComplaintBatchSubmitted.selector,
            key,
            definitionHash,
            bytes32(uint256(seat)),
            record
        );
    }

    /// @notice Submits an obligation root: all of one seat's receipts, or all
    /// of its complaints, for one election, committed as one signed Merkle
    /// root whose leaves are published by content address, so a trustee node
    /// forcing what it owes through L1 pays for one call per kind whatever
    /// the electorate (docs/spec/delivery.md, Obligation root, Capacity;
    /// T-25, T-52, T-54). Only the first root of each panel, seat and kind
    /// whose signature verifies is accepted: only the seat's signature fills
    /// its slot, so no one else can take it, and a verifier fetches at most
    /// two leaf objects per seat (T-17, T-52). Seat `i` of the author panel
    /// is another seat than seat `i` of the default panel, so each fills its
    /// own slots. A byte-identical repeat is a no-op.
    function submitObligationRoot(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        bytes32 key = keccak256(record);
        if (_accepted[key]) return;
        (bytes32 definitionHash, uint8 panel, uint8 seat, uint8 kind) =
            DeliveryCheckLib.checkObligationRoot(record, electionRegistry, trusteeRegistry);
        bytes32[2] storage slots = _roots[definitionHash][panel][seat];
        if (slots[kind - 1] != 0) {
            revert DeliveryCheckLib.DeliveryRefused(0, DeliveryCheckLib.Code.RootRepeat);
        }
        slots[kind - 1] = sha256(bytes.concat(DS_OBLIGATION_ROOT, record));
        _emit(ObligationRootSubmitted.selector, key, definitionHash, bytes32(uint256(seat)), record);
    }

    /// @notice Submits a seat's availability attestation or complaint
    /// (docs/spec/contracts.md, Board, Availability records): its statement
    /// that it held the ballot extent or the counted extent by its deadline,
    /// naming, at the counted extent, roots the board accepted for the
    /// election, or its signed word that it couldn't fetch it. The first of
    /// each type that passes fills its seat's slot for the point, so only the
    /// seat's own signature fills it and a seat archives at most four records
    /// per election (T-17, T-52). A byte-identical repeat is a no-op, so a seat
    /// resends until its record is recorded (docs/spec/availability.md,
    /// Windows).
    function submitAvailabilityRecord(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        bytes32 key = keccak256(record);
        if (_accepted[key]) return;
        (AvailabilityCheckLib.Accepted memory a, uint256 kind, uint256 count) =
            AvailabilityCheckLib.check(record, electionRegistry, trusteeRegistry);
        if (count != 0) _requireRoots(record, a, count);
        // `availability-repeat`: one slot per type, panel, seat and point,
        // `panel` and `point` each 1 or 2, `kind` 0 or 1.
        uint8 bit;
        unchecked {
            bit = uint8(1 << (4 * (a.panel - 1) + 2 * kind + (a.point - 1)));
        }
        uint8 filled = _availability[a.definitionHash][a.seat];
        if (filled & bit != 0) {
            revert AvailabilityCheckLib.AvailabilityRefused(AvailabilityCheckLib.Code
                .AvailabilityRepeat);
        }
        _availability[a.definitionHash][a.seat] = filled | bit;
        _emit(
            kind == 0
                ? AvailabilityAttestationSubmitted.selector
                : AvailabilityComplaintSubmitted.selector,
            key,
            a.definitionHash,
            bytes32(uint256(a.seat)),
            record
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
            posting, ballot, electionRegistry, trusteeRegistry, ballotCheck, _qualified(ballot)
        );
        _emit(SharePosted.selector, key, definitionHash, ballotHash, posting);
    }

    /// @notice Submits a share complaint.
    function submitComplaint(bytes calldata record) external {
        CanonicalCalldata.requireOneBytesArgument(record);
        bytes32 key = keccak256(record);
        if (_accepted[key]) return;
        (bytes32 definitionHash, bytes32 ballotHash) =
            DeliveryCheckLib.checkComplaint(record, 0, electionRegistry, trusteeRegistry);
        _emit(ShareComplaintSubmitted.selector, key, definitionHash, ballotHash, record);
    }

    /// `availability-root`: every root an attestation names is the record
    /// hash of an obligation root the board accepted for its definition and
    /// the attestation's own panel, as the root slots of that panel key set's
    /// seats hold them, so the list carries no byte the seat chooses beyond
    /// which roots it names, and names no root the other panel judges
    /// (docs/spec/delivery.md, Leaf availability (version 2); T-17, T-25).
    function _requireRoots(
        bytes calldata record,
        AvailabilityCheckLib.Accepted memory a,
        uint256 count
    ) private view {
        uint256 seats = a.seats;
        // The library read every root inside the record, and a seat is a
        // `uint8`: nothing here overflows.
        unchecked {
            for (uint256 i; i < count; i++) {
                bytes32 root;
                uint256 at = AvailabilityCheckLib.ROOTS_AT + 32 * i;
                assembly ("memory-safe") {
                    root := calldataload(add(record.offset, at))
                }
                // An empty slot is zero, which no root's hash is.
                bool found;
                for (uint256 seat = 1; root != 0 && !found && seats >> seat != 0; seat++) {
                    if ((seats >> seat) & 1 == 0) continue;
                    bytes32[2] storage slots = _roots[a.definitionHash][a.panel][uint8(seat)];
                    found = slots[0] == root || slots[1] == root;
                }
                if (!found) {
                    revert AvailabilityCheckLib.AvailabilityRefused(AvailabilityCheckLib.Code
                        .AvailabilityRoot);
                }
            }
        }
    }

    /// Remembers an accepted record by `key` and emits it whole, ABI-encoded,
    /// as the event `selector` with topics `t1` and `t2`.
    function _emit(bytes32 selector, bytes32 key, bytes32 t1, bytes32 t2, bytes calldata record)
        private
    {
        _accepted[key] = true;
        _log3(selector, t1, t2, abi.encode(record));
    }

    /// `relay-sender`: only a deposit the relay made, or one L2 governance
    /// forges from its alias, gets past this, and 4.5 matches no call for a
    /// forgery (T-71).
    function _requireRelay() private view {
        unchecked {
            if (msg.sender != address(uint160(relay) + ALIAS_OFFSET)) {
                revert RelaySender(msg.sender);
            }
        }
    }

    /// A share receipt's length from its version byte: 165 bytes at version
    /// 2, which names its panel, and 164 otherwise (version 1, or a version
    /// its check refuses).
    function _receiptLength(bytes1 version) private pure returns (uint256) {
        return
            version == 0x02 ? DeliveryCheckLib.RECEIPT_V2_LENGTH : DeliveryCheckLib.RECEIPT_LENGTH;
    }

    /// The seats of the key set the trustee registry recorded for the
    /// ceremony of the election a ballot record names, then those of the
    /// author key set the election registry recorded with its definition (0
    /// with no author panel), never a submitter's (ADR 0028, 2B; ADR 0035).
    /// Both zero for a record too short to name an election, which the
    /// ballot check's header refuses first.
    function _qualified(bytes calldata record) private view returns (uint256[2] memory q) {
        if (record.length < BallotCheckLib.TIER_AT) return q;
        bytes32 h = bytes32(record[BallotCheckLib.DEFINITION_AT:BallotCheckLib.TIER_AT]);
        (bytes32 stub, bytes32 panel) = electionRegistry.ceremony(h);
        (, q[0]) = trusteeRegistry.keySetOf(stub, panel);
        (, q[1]) = electionRegistry.authorKeySetOf(h);
    }
}
