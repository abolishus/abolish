// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BoardAnchor, CheckpointLib} from "../../src/BoardAnchor.sol";
import {TestBase} from "../utils/Vm.sol";

contract InvariantAuthority {}

/// Moves the clock and sends checkpoints for a few elections and segments,
/// from the authority or anyone else, keeping a shadow of what the anchor
/// should hold.
contract AnchorHandler is TestBase {
    uint64 internal constant EPOCH = 1_800_000_000;

    BoardAnchor public immutable anchor;
    address internal immutable authority;

    /// Every (election, segment) slot the handler touched, packed as `id ‖ segment`.
    bytes32[] public keys;
    mapping(bytes32 key => bool) internal touched;
    mapping(bytes32 key => bytes32) public shadow;
    uint256 public anchored;
    /// Set if a call succeeded or failed against the rules.
    bool public unexpected;

    constructor(BoardAnchor anchor_, address authority_) {
        anchor = anchor_;
        authority = authority_;
        vm.warp(EPOCH);
    }

    function keyCount() external view returns (uint256) {
        return keys.length;
    }

    function wait(uint32 seconds_) external {
        vm.warp(block.timestamp + seconds_ % (4 * anchor.period()));
    }

    /// Sends up to three checkpoints in one call, for elections 0–2 and
    /// segments 0–7, from the authority unless `stranger` is set.
    function send(uint256 seed, uint8 count, bool stranger) external {
        count = 1 + count % 3;
        bytes memory cps;
        bool allowed = !stranger;
        bytes32[] memory batch = new bytes32[](count);
        bytes32[] memory hashes = new bytes32[](count);
        for (uint256 i; i < count; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            bytes32 id = bytes32(r % 3);
            uint32 segment = uint32((r >> 8) % 8);
            uint64 size = uint64((r >> 16) % 4); // 0 sometimes: an empty board
            bytes32 head = keccak256(abi.encode(r, "head"));
            bytes32 root = keccak256(abi.encode(r, "root"));
            cps = bytes.concat(cps, abi.encodePacked(id, segment, size, head, root));
            bytes32 key = _key(id, segment);
            uint256 end = anchor.periodEnd(segment);
            if (size == 0 || block.timestamp < end || block.timestamp - end > anchor.deadline()) {
                allowed = false;
            }
            if (shadow[key] != bytes32(0)) allowed = false;
            for (uint256 j; j < i; j++) {
                if (batch[j] == key) allowed = false;
            }
            batch[i] = key;
            hashes[i] = CheckpointLib.hash(id, segment, size, head, root);
            if (!touched[key]) {
                touched[key] = true;
                keys.push(key);
            }
        }
        vm.prank(stranger ? address(0x5742) : authority);
        try anchor.anchor(cps) {
            if (!allowed) unexpected = true;
            for (uint256 i; i < count; i++) {
                shadow[batch[i]] = hashes[i];
            }
            anchored += count;
        } catch {
            if (allowed) unexpected = true;
        }
    }

    function _key(bytes32 id, uint32 segment) internal pure returns (bytes32) {
        return bytes32((uint256(id) << 32) | segment);
    }
}

/// Invariants, over any sequence of handler calls:
/// 1. The anchor holds, for every election and segment, exactly the hash of
///    the first checkpoint the authority sent inside its window, or nothing;
///    a stored hash never changes (T-24).
/// 2. A call succeeds exactly when it comes from the authority and every
///    checkpoint in it is non-empty, inside its window and the first for its
///    election and segment, in the anchor and within the call (T-52, T-53).
/// 3. The event accumulator counts one log per anchored checkpoint.
contract BoardAnchorInvariantTest is TestBase {
    BoardAnchor internal anchor;
    AnchorHandler internal handler;

    function setUp() public {
        address authority = address(new InvariantAuthority());
        anchor = new BoardAnchor(BoardAnchor.Clock(1_800_000_000, 3600, 7200), authority);
        handler = new AnchorHandler(anchor, authority);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_StoredHashesMatchTheShadow() public view {
        uint256 n = handler.keyCount();
        for (uint256 i; i < n; i++) {
            bytes32 key = handler.keys(i);
            assertEq(
                anchor.checkpointHashOf(bytes32(uint256(key) >> 32), uint32(uint256(key))),
                handler.shadow(key),
                "stored hash"
            );
        }
    }

    function invariant_CallsFollowTheRules() public view {
        assertTrue(!handler.unexpected(), "a call broke the rules");
    }

    function invariant_EveryAnchorIsAccumulated() public view {
        (, uint64 count) = anchor.eventAccumulator();
        assertEq(count, handler.anchored(), "event count");
    }
}
