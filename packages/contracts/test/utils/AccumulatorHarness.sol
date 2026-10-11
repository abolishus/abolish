// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {EventAccumulator, EventAccumulatorLib} from "../../src/EventAccumulator.sol";

/// Exposes the accumulator's internal emitters to tests.
contract AccumulatorHarness is EventAccumulator {
    /// A typed event, emitted the way every Abolish contract emits: topic 0
    /// is the event's selector and the data is the ABI encoding of its
    /// non-indexed fields, so standard ABI decoders read the log.
    event Example(bytes32 indexed id, uint256 indexed seq, uint256 value, bytes payload);

    error Refused();

    function emitLog(bytes32[] calldata topics, bytes calldata data) external {
        _emit(topics, data);
    }

    function emitExample(bytes32 id, uint256 seq, uint256 value, bytes calldata payload) external {
        _log3(Example.selector, id, bytes32(seq), abi.encode(value, payload));
    }

    /// Emits and then reverts, so neither the log nor the step survives.
    function emitThenRevert(bytes32[] calldata topics, bytes calldata data) external {
        _emit(topics, data);
        revert Refused();
    }

    function _emit(bytes32[] calldata topics, bytes calldata data) private {
        if (topics.length == 1) _log1(topics[0], data);
        else if (topics.length == 2) _log2(topics[0], topics[1], data);
        else if (topics.length == 3) _log3(topics[0], topics[1], topics[2], data);
        else if (topics.length == 4) _log4(topics[0], topics[1], topics[2], topics[3], data);
        else revert EventAccumulatorLib.TopicCount(topics.length);
    }
}

/// External wrappers around the library, so tests can expect its reverts.
contract AccumulatorLibHarness {
    function chainId64(uint256 chainId) external pure returns (uint64) {
        return EventAccumulatorLib.chainId64(chainId);
    }

    function genesis(uint64 chainId, address emitter) external pure returns (bytes32) {
        return EventAccumulatorLib.genesis(chainId, emitter);
    }

    function step(bytes32 acc, uint64 index, bytes32[] memory topics, bytes memory data)
        external
        pure
        returns (bytes32)
    {
        return EventAccumulatorLib.step(acc, index, topics, data);
    }
}
