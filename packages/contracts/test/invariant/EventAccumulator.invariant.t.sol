// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {EventAccumulatorLib} from "../../src/EventAccumulator.sol";
import {AccumulatorHarness} from "../utils/AccumulatorHarness.sol";
import {TestBase, Vm} from "../utils/Vm.sol";

/// Drives the harness with random logs across blocks and keeps a shadow
/// replay of every log that succeeded, each in the block that emitted it.
contract AccumulatorHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    AccumulatorHarness public immutable target;
    bytes32 public shadow;
    uint64 public shadowCount;
    uint64 public maxCountSeen;

    constructor(AccumulatorHarness target_) {
        target = target_;
        shadow = EventAccumulatorLib.genesis(uint64(block.chainid), address(target_));
    }

    function emitLog(uint8 topicCount, bytes32 seed, bytes calldata data) external {
        bytes32[] memory topics = new bytes32[](uint256(topicCount) % 4 + 1);
        for (uint256 t; t < topics.length; t++) {
            topics[t] = keccak256(abi.encode(seed, t));
        }
        target.emitLog(topics, data);
        shadow = EventAccumulatorLib.step(
            shadow, shadowCount, block.number, block.timestamp, topics, data
        );
        shadowCount++;
        _observe();
    }

    function emitExample(bytes32 id, uint256 seq, uint256 value, bytes calldata payload) external {
        target.emitExample(id, seq, value, payload);
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = AccumulatorHarness.Example.selector;
        topics[1] = id;
        topics[2] = bytes32(seq);
        shadow = EventAccumulatorLib.step(
            shadow, shadowCount, block.number, block.timestamp, topics, abi.encode(value, payload)
        );
        shadowCount++;
        _observe();
    }

    /// Moves to a later block and time, so logs land in many blocks.
    function advance(uint8 blocks, uint16 secs) external {
        vm.roll(block.number + uint256(blocks) + 1);
        vm.warp(block.timestamp + uint256(secs));
    }

    /// A call that reverts must leave the accumulator as it was.
    function emitThenRevert(bytes32 seed, bytes calldata data) external {
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = seed;
        try target.emitThenRevert(topics, data) {
            revert("emitThenRevert returned");
        } catch {}
        _observe();
    }

    function _observe() private {
        (, uint64 count) = target.eventAccumulator();
        if (count > maxCountSeen) maxCountSeen = count;
    }
}

/// Invariants, over any sequence of handler calls:
/// 1. The stored accumulator equals the replay of exactly the logs whose calls
///    succeeded, in order, each with its own block number and timestamp
///    (nothing dropped, added, reordered or moved; T-25, T-71).
/// 2. The stored count equals the number of those logs.
/// 3. The count never decreases.
/// 4. Both values sit at the ERC-7201 slot a storage proof reads.
contract EventAccumulatorInvariantTest is TestBase {
    bytes32 internal constant SLOT =
        0x1073a090f5464cb55b258e445c2f90eb0f9b00fb8b1700430d20b9c53b939600;

    AccumulatorHarness internal harness;
    AccumulatorHandler internal handler;

    function setUp() public {
        harness = new AccumulatorHarness();
        handler = new AccumulatorHandler(harness);
    }

    /// Only the handler is called; the harness is reached through it.
    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_AccumulatorIsReplayOfSuccessfulLogs() public view {
        (bytes32 acc, uint64 count) = harness.eventAccumulator();
        assertEq(acc, handler.shadow(), "accumulator");
        assertEq(count, handler.shadowCount(), "count");
    }

    function invariant_CountNeverDecreases() public view {
        (, uint64 count) = harness.eventAccumulator();
        assertTrue(count >= handler.maxCountSeen(), "count decreased");
    }

    function invariant_ValuesAreAtTheStorageSlot() public view {
        (bytes32 acc, uint64 count) = harness.eventAccumulator();
        assertEq(vm.load(address(harness), SLOT), acc, "accumulator slot");
        assertEq(
            uint256(vm.load(address(harness), bytes32(uint256(SLOT) + 1))), count, "count slot"
        );
    }
}
