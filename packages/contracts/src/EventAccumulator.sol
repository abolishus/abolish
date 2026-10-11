// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

/// @title The event accumulator's hash steps (docs/spec/contracts.md, Event accumulator).
/// @notice `H` is SHA-256 (docs/spec/group.md), through the EVM precompile, over
/// `DS("abolish/v1/event-accumulator", m) = u8(28) ‖ tag ‖ m` (docs/spec/domain-separation.md).
library EventAccumulatorLib {
    /// `u8(len(tag)) ‖ tag`: 0x1c = 28, the tag's length in bytes.
    bytes internal constant DS_PREFIX = "\x1cabolish/v1/event-accumulator";

    error ChainIdTooLarge(uint256 chainId);
    error TopicCount(uint256 count);
    error DataTooLong(uint256 length);

    /// `chain_id` as a `u64`, or revert: a larger chain ID has no encoding.
    function chainId64(uint256 chainId) internal pure returns (uint64) {
        if (chainId > type(uint64).max) revert ChainIdTooLarge(chainId);
        return uint64(chainId);
    }

    /// `acc_0 = H(DS(tag, u8(0) ‖ u64(chain_id) ‖ bytes[20](address)))`.
    function genesis(uint64 chainId, address emitter) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(DS_PREFIX, uint8(0), chainId, emitter));
    }

    /// `acc_{n+1} = H(DS(tag, u8(1) ‖ acc_n ‖ u64(n) ‖ u8(k) ‖ t_0 ‖ … ‖ t_{k−1} ‖ u32(len(d)) ‖ d))`.
    function step(bytes32 acc, uint64 index, bytes32[] memory topics, bytes memory data)
        internal
        pure
        returns (bytes32)
    {
        if (topics.length < 1 || topics.length > 4) revert TopicCount(topics.length);
        if (data.length > type(uint32).max) revert DataTooLong(data.length);
        // encodePacked writes a bytes32[] as its elements back to back, with no
        // length prefix: exactly t_0 ‖ … ‖ t_{k−1}.
        return sha256(
            abi.encodePacked(
                DS_PREFIX,
                uint8(1),
                acc,
                index,
                uint8(topics.length),
                topics,
                uint32(data.length),
                data
            )
        );
    }
}

/// @title A running hash and count over every log a contract emits.
/// @notice Every Abolish contract inherits this and emits only through
/// `_log1` … `_log4`, so its storage commits to its whole event sequence and a
/// verifier can prove, from an L2 output root, that the archive left nothing
/// out (T-71, T-25; docs/adr/0005-permanent-archive.md). It has no admin and
/// no way to change either value except by emitting a log.
abstract contract EventAccumulator {
    /// @custom:storage-location erc7201:abolish.event-accumulator
    struct AccumulatorStorage {
        bytes32 accumulator;
        uint64 count;
    }

    /// keccak256(abi.encode(uint256(keccak256("abolish.event-accumulator")) - 1)) & ~bytes32(uint256(0xff)):
    /// fixed whatever the inheriting contract's layout, so verifiers can
    /// request the values by slot (docs/spec/contracts.md).
    bytes32 internal constant ACCUMULATOR_SLOT =
        0x1073a090f5464cb55b258e445c2f90eb0f9b00fb8b1700430d20b9c53b939600;

    constructor() {
        _accumulatorStorage().accumulator = EventAccumulatorLib.genesis(
            EventAccumulatorLib.chainId64(block.chainid), address(this)
        );
    }

    /// @notice The accumulator and the number of logs emitted so far. A
    /// verifier uses a storage proof of `ACCUMULATOR_SLOT` instead.
    function eventAccumulator() external view returns (bytes32 accumulator, uint64 count) {
        AccumulatorStorage storage s = _accumulatorStorage();
        return (s.accumulator, s.count);
    }

    function _log1(bytes32 t0, bytes memory data) internal {
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = t0;
        _accumulate(topics, data);
        assembly ("memory-safe") {
            log1(add(data, 0x20), mload(data), t0)
        }
    }

    function _log2(bytes32 t0, bytes32 t1, bytes memory data) internal {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = t0;
        topics[1] = t1;
        _accumulate(topics, data);
        assembly ("memory-safe") {
            log2(add(data, 0x20), mload(data), t0, t1)
        }
    }

    function _log3(bytes32 t0, bytes32 t1, bytes32 t2, bytes memory data) internal {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = t0;
        topics[1] = t1;
        topics[2] = t2;
        _accumulate(topics, data);
        assembly ("memory-safe") {
            log3(add(data, 0x20), mload(data), t0, t1, t2)
        }
    }

    function _log4(bytes32 t0, bytes32 t1, bytes32 t2, bytes32 t3, bytes memory data) internal {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = t0;
        topics[1] = t1;
        topics[2] = t2;
        topics[3] = t3;
        _accumulate(topics, data);
        assembly ("memory-safe") {
            log4(add(data, 0x20), mload(data), t0, t1, t2, t3)
        }
    }

    /// The step for the log about to be emitted, as log number `count`.
    /// Checked arithmetic reverts rather than wrap the count.
    function _accumulate(bytes32[] memory topics, bytes memory data) private {
        AccumulatorStorage storage s = _accumulatorStorage();
        uint64 n = s.count;
        s.accumulator = EventAccumulatorLib.step(s.accumulator, n, topics, data);
        s.count = n + 1;
    }

    function _accumulatorStorage() private pure returns (AccumulatorStorage storage s) {
        assembly ("memory-safe") {
            s.slot := ACCUMULATOR_SLOT
        }
    }
}
