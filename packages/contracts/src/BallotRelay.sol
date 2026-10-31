// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {CanonicalCalldata} from "./CanonicalCalldata.sol";
import {EventAccumulator, EventAccumulatorLib} from "./EventAccumulator.sol";

/// The OP Stack's deposit contract on L1, as the relay calls it.
interface IOptimismPortal {
    function depositTransaction(
        address to,
        uint256 value,
        uint64 gasLimit,
        bool isCreation,
        bytes memory data
    ) external payable;
}

/// @title A relay call's hash (docs/spec/contracts.md, L1 relay, Relaying
/// and Rolling ballots).
library RelayCallLib {
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/relay-call` (0x15 = 21).
    bytes internal constant DS_RELAY_CALL = "\x15abolish/v1/relay-call";
    /// `u8(len(tag)) ‖ tag` for `abolish/v1/relay-rolling-call` (0x1d = 29).
    bytes internal constant DS_RELAY_ROLLING_CALL = "\x1dabolish/v1/relay-rolling-call";

    /// `H(DS("abolish/v1/relay-call", u64(l1_chain_id) ‖ bytes[20](relay) ‖
    /// u64(i) ‖ u64(b) ‖ u64(τ) ‖ u64(gasLimit) ‖ record))`: every byte of the
    /// record, so a deposit forged with the same ballot under another proof
    /// or L1 reference matches no call (T-71, T-31).
    function callHash(
        uint64 l1ChainId,
        address relay,
        uint64 index,
        uint64 l1Block,
        uint64 stamp,
        uint64 gasLimit,
        bytes memory record
    ) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                DS_RELAY_CALL, l1ChainId, relay, index, l1Block, stamp, gasLimit, record
            )
        );
    }

    /// `H(DS("abolish/v1/relay-rolling-call", u64(l1_chain_id) ‖
    /// bytes[20](relay) ‖ u64(i) ‖ u64(b) ‖ u64(τ) ‖ u64(gasLimit) ‖
    /// bytes[32](root) ‖ record))`: the root bound beside the record, so a
    /// deposit carrying another root matches no call (T-71, T-25). Its own
    /// tag keeps a rolling call's hash apart from every fixed call's.
    function rollingCallHash(
        uint64 l1ChainId,
        address relay,
        uint64 index,
        uint64 l1Block,
        uint64 stamp,
        uint64 gasLimit,
        bytes32 root,
        bytes memory record
    ) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                DS_RELAY_ROLLING_CALL,
                l1ChainId,
                relay,
                index,
                l1Block,
                stamp,
                gasLimit,
                root,
                record
            )
        );
    }
}

/// @title The L1 relay (docs/spec/contracts.md, L1 relay).
/// @notice A voter whose direct submissions the sequencer censors forces its
/// ballot through L1 here: the relay records the call, with the number and
/// timestamp of the L1 block it ran in, and deposits the record to the
/// board through the L2's portal, which the L2 must include within its
/// sequencing window (ADR 0030; T-50, T-25). The board accepts the deposit
/// only from the relay's alias, and the close rule judges it by the stamp
/// recorded here, never by when it reached L2 (T-35, T-45). One word per
/// call, the call's hash over every field and the whole record, lets a
/// verifier match each relayed ballot on the board with exactly one call,
/// so a deposit L2 governance forges from the alias matches none (T-71).
/// A rolling poll's ballot is forced by the rolling call, which carries the
/// root its proof was made against beside the record and binds it in the
/// call's hash (Rolling ballots; ADR 0028, Direct submission).
/// The relay frames only the record's header (T-17, T-52): the board judges
/// the ballot. There is no admin, proxy, pause or upgrade path, and it
/// holds no funds.
contract BallotRelay is EventAccumulator {
    /// @notice Call `index` was recorded: its hash is now stored for the index.
    event BallotRelayed(bytes32 indexed definitionHash, uint64 indexed index, bytes32 callHash);

    /// `relay-too-large`: the record is longer than `MAX_RELAY_RECORD`, or
    /// on the rolling call `MAX_ROLLING_RELAY_RECORD`.
    error RelayTooLarge(uint256 length);
    /// `relay-truncated`: the record ends before its definition hash does.
    error RelayTruncated(uint256 length);
    /// `relay-record-type`: the record isn't a ballot record (0x0002).
    error RelayRecordType(uint16 recordType);
    error InvalidDeployment();

    /// The longest record whose deposit data, `196 + pad32(len(record))`
    /// bytes, fits the portal's 120,000 (docs/spec/parameters.md).
    uint256 public constant MAX_RELAY_RECORD = 119_776;
    /// The longest record whose rolling deposit data, `228 +
    /// pad32(len(record))` bytes, fits the portal's 120,000: one word below
    /// `MAX_RELAY_RECORD`, for the root's (docs/spec/parameters.md).
    uint256 public constant MAX_ROLLING_RELAY_RECORD = 119_744;

    /// The board's `submitRelayedBallot(uint64,uint64,uint64,uint64,bytes)`.
    bytes4 internal constant SUBMIT_RELAYED_BALLOT = 0x5c6a760f;
    /// The board's
    /// `submitRelayedRollingBallot(uint64,uint64,uint64,uint64,bytes32,bytes)`.
    bytes4 internal constant SUBMIT_RELAYED_ROLLING_BALLOT = 0xd08fb778;

    uint16 internal constant BALLOT_TYPE = 0x0002;
    /// A record type, a version and a `definition_hash`.
    uint256 internal constant HEADER_LENGTH = 35;

    /// @custom:storage-location erc7201:abolish.ballot-relay
    struct RelayStorage {
        uint64 count;
        mapping(uint64 index => bytes32) calls;
    }

    /// keccak256(abi.encode(uint256(keccak256("abolish.ballot-relay")) - 1)) & ~bytes32(uint256(0xff)):
    /// fixed, so a verifier proves the count and each call's word by slot
    /// (docs/spec/contracts.md, L1 relay, State).
    bytes32 internal constant RELAY_SLOT =
        0xeddbfcaa40c756990a5dda7c565d5921d82a1a88a4b83bd8b0415aeae8667900;

    IOptimismPortal public immutable portal;
    address public immutable board;

    constructor(address portal_, address board_) {
        if (portal_.code.length == 0 || board_ == address(0)) revert InvalidDeployment();
        portal = IOptimismPortal(portal_);
        board = board_;
    }

    /// @notice How many calls the relay has recorded.
    function callCount() external view returns (uint64) {
        return _relayStorage().count;
    }

    /// @notice Call `index`'s hash, or zero if no call `index` was recorded.
    function callHash(uint64 index) external view returns (bytes32) {
        return _relayStorage().calls[index];
    }

    /// @notice Records the call and deposits `record` to the board's
    /// `submitRelayedBallot` with `gasLimit` gas, returning the call's index.
    /// The caller's own transaction pays the portal's metering; too low a
    /// limit leaves the call recorded and the deposit reverting on L2, the
    /// caller's loss (docs/spec/contracts.md, L1 relay, Relaying).
    function relayBallot(uint64 gasLimit, bytes calldata record) external returns (uint64 index) {
        CanonicalCalldata.requireWordsThenBytes(1, record);
        // Before anything is read from the record (T-52).
        if (record.length > MAX_RELAY_RECORD) revert RelayTooLarge(record.length);
        _frame(record);
        index = _relayStorage().count;
        _record(
            index,
            RelayCallLib.callHash(
                uint64(block.chainid),
                address(this),
                index,
                uint64(block.number),
                uint64(block.timestamp),
                gasLimit,
                record
            ),
            record
        );
        // Deposits `submitRelayedBallot(index, b, τ, gasLimit, record)`, in
        // exactly the canonical encoding the board requires.
        _deposit(
            gasLimit,
            abi.encodeWithSelector(
                SUBMIT_RELAYED_BALLOT,
                index,
                uint64(block.number),
                uint64(block.timestamp),
                gasLimit,
                record
            )
        );
    }

    /// @notice Records the call and deposits `root` and `record` to the
    /// board's `submitRelayedRollingBallot` with `gasLimit` gas, returning
    /// the call's index: `relayBallot` for a rolling poll's ballot, with the
    /// root its membership proof was made against beside it
    /// (docs/spec/contracts.md, L1 relay, Rolling ballots). The root is
    /// carried, never read: whether it is 0, a field element or the proof's
    /// is the board's to judge, and whether it is the root of the step the
    /// ballot names the verifier's (T-50, T-25).
    function relayRollingBallot(uint64 gasLimit, bytes32 root, bytes calldata record)
        external
        returns (uint64 index)
    {
        CanonicalCalldata.requireWordsThenBytes(2, record);
        if (record.length > MAX_ROLLING_RELAY_RECORD) revert RelayTooLarge(record.length);
        _frame(record);
        index = _relayStorage().count;
        _record(
            index,
            RelayCallLib.rollingCallHash(
                uint64(block.chainid),
                address(this),
                index,
                uint64(block.number),
                uint64(block.timestamp),
                gasLimit,
                root,
                record
            ),
            record
        );
        _deposit(
            gasLimit,
            abi.encodeWithSelector(
                SUBMIT_RELAYED_ROLLING_BALLOT,
                index,
                uint64(block.number),
                uint64(block.timestamp),
                gasLimit,
                root,
                record
            )
        );
    }

    /// The header both calls require, and the stamp's range: nothing else
    /// of the record is read.
    function _frame(bytes calldata record) private view {
        if (record.length < HEADER_LENGTH) revert RelayTruncated(record.length);
        uint16 recordType = uint16(bytes2(record[0:2]));
        if (recordType != BALLOT_TYPE) revert RelayRecordType(recordType);

        // block.number and block.timestamp fit a u64 for billions of years;
        // the checks keep the stamp's encoding total, as the accumulator's do.
        if (block.number > type(uint64).max) {
            revert EventAccumulatorLib.BlockNumberTooLarge(block.number);
        }
        if (block.timestamp > type(uint64).max) {
            revert EventAccumulatorLib.TimestampTooLarge(block.timestamp);
        }
    }

    /// Stores call `index`'s hash `h` and emits its event. Every write comes
    /// before the portal is called, so a call re-entering through it only
    /// records a call of its own after this one. Checked arithmetic: call
    /// 2⁶⁴ − 1 can't be recorded, so the count stays a u64.
    function _record(uint64 index, bytes32 h, bytes calldata record) private {
        RelayStorage storage s = _relayStorage();
        s.calls[index] = h;
        s.count = index + 1;
        _log3(
            BallotRelayed.selector,
            bytes32(record[3:HEADER_LENGTH]),
            bytes32(uint256(index)),
            abi.encode(h)
        );
    }

    /// Deposits `data` to the board. A reverting deposit reverts the call, so
    /// every recorded call made one.
    function _deposit(uint64 gasLimit, bytes memory data) private {
        portal.depositTransaction(board, 0, gasLimit, false, data);
    }

    function _relayStorage() private pure returns (RelayStorage storage s) {
        assembly ("memory-safe") {
            s.slot := RELAY_SLOT
        }
    }
}
