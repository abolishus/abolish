// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {BoardAnchor, CheckpointLib} from "../../src/BoardAnchor.sol";
import {TestBase} from "../utils/Vm.sol";

contract InvariantAuthority {}

/// Moves the clock, sends checkpoints for a few elections and segments, and
/// registers and retires a few receipt keys, from the authority or anyone
/// else, keeping a shadow of what the anchor should hold.
contract AnchorHandler is TestBase {
    uint64 internal constant EPOCH = 1_800_000_000;

    BoardAnchor public immutable anchor;
    address internal immutable authority;

    /// Every (election, segment) slot the handler touched, packed as `id ‖ segment`.
    bytes32[] public keys;
    mapping(bytes32 key => bool) internal touched;
    mapping(bytes32 key => bytes32) public shadow;
    /// One more than the lowest segment anchored per election, as the anchor keeps it.
    mapping(bytes32 id => uint256) public shadowLowest;
    uint256 public anchored;
    /// Locators logged by successful calls.
    uint256 public locators;
    /// Receipt-key records by key index (0–3: prefixes 0x02 and 0x03 of two
    /// `x` values), as `(registeredAt, retiredAt)`, and the writes that succeeded.
    mapping(uint256 k => uint64[2]) internal shadowKey;
    uint256 public keyWrites;
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
            uint32 segment = _segment(r);
            uint64 size = uint64((r >> 16) % 4); // 0 sometimes: an empty board
            bytes32 head = keccak256(abi.encode(r, "head"));
            bytes32 root = keccak256(abi.encode(r, "root"));
            // A misframed CID now and then (dag-cbor's codec): refused (T-17).
            bool framed = (r >> 40) % 8 != 0;
            bytes memory cp = abi.encodePacked(
                id,
                segment,
                size,
                head,
                root,
                framed ? bytes4(0x01551220) : bytes4(0x01711220),
                keccak256(abi.encode(r, "object")),
                bytes4(0x01701220),
                keccak256(abi.encode(r, "hashes"))
            );
            cps = bytes.concat(cps, cp);
            bytes32 key = _key(id, segment);
            uint256 end = anchor.periodEnd(segment);
            if (
                size == 0 || !framed || block.timestamp < end
                    || block.timestamp - end > anchor.deadline()
            ) {
                allowed = false;
            }
            if (shadow[key] != bytes32(0)) allowed = false;
            for (uint256 j; j < i; j++) {
                if (batch[j] == key) allowed = false;
            }
            batch[i] = key;
            hashes[i] = CheckpointLib.hash(cp);
            if (!touched[key]) {
                touched[key] = true;
                keys.push(key);
            }
        }
        // A well-framed locator now and then: it changes no checkpoint rule.
        bytes memory locator =
            seed % 4 == 0 ? abi.encodePacked(uint16(1), keccak256(abi.encode(seed))) : bytes("");
        vm.prank(stranger ? address(0x5742) : authority);
        try anchor.anchor(cps, locator) {
            if (locator.length != 0) locators++;
            if (!allowed) unexpected = true;
            for (uint256 i; i < count; i++) {
                shadow[batch[i]] = hashes[i];
                bytes32 id = bytes32(uint256(batch[i]) >> 32);
                uint256 s = uint256(uint32(uint256(batch[i]))) + 1;
                if (shadowLowest[id] == 0 || s < shadowLowest[id]) shadowLowest[id] = s;
            }
            anchored += count;
        } catch {
            if (allowed) unexpected = true;
        }
    }

    /// Registers or retires one of four receipt keys, from the authority
    /// unless `stranger` is set.
    function writeKey(uint8 k, bool retire, bool stranger) external {
        k %= 4;
        bytes memory key = receiptKey(k);
        uint64[2] memory record = shadowKey[k];
        // Keys 2j and 2j + 1 are twins (one x, both prefixes): registering
        // either keeps the other out for good.
        bool allowed = !stranger
            && (retire
                    ? record[0] != 0 && record[1] == 0
                    : record[0] == 0 && shadowKey[k ^ 1][0] == 0);
        vm.prank(stranger ? address(0x5742) : authority);
        try (retire ? anchor.retireReceiptKey : anchor.registerReceiptKey)(key) {
            if (!allowed) unexpected = true;
            shadowKey[k][retire ? 1 : 0] = uint64(block.timestamp);
            keyWrites++;
        } catch {
            if (allowed) unexpected = true;
        }
    }

    function receiptKey(uint256 k) public pure returns (bytes memory) {
        return abi.encodePacked(uint8(2 + k % 2), keccak256(abi.encode(k / 2)));
    }

    function keyRecord(uint256 k) external view returns (uint64, uint64) {
        return (shadowKey[k][0], shadowKey[k][1]);
    }

    /// Half the time one of the two periods that ended last, so anchors
    /// succeed often; otherwise any of segments 0–7.
    function _segment(uint256 r) internal view returns (uint32) {
        uint256 elapsed = (block.timestamp - EPOCH) / anchor.period();
        uint256 back = 1 + (r >> 9) % 2;
        if ((r >> 8) % 2 == 0 && elapsed >= back) return uint32(elapsed - back);
        return uint32((r >> 10) % 8);
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
/// 3. The anchor keeps, per election, one more than the lowest segment
///    anchored, or 0 (T-24: a verifier proves every slot from there).
/// 4. The anchor's locator count equals the locators posted.
/// 5. The event accumulator counts one log per anchored checkpoint, per
///    locator and per receipt-key write.
/// 6. Each receipt key's record holds the time of its first registration and
///    of the first retirement after it, or zero: only the authority writes
///    it, and never a second time (T-26, T-69).
/// `test_HandlerAnchors` shows the handler reaches the success path, so the
/// invariants aren't checked only against an empty anchor.
contract BoardAnchorInvariantTest is TestBase {
    bytes32 internal constant ANCHOR_SLOT =
        0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00;
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

    function invariant_LowestSegmentMatchesTheShadow() public view {
        for (uint256 id; id < 3; id++) {
            assertEq(
                anchor.lowestSegmentPlusOne(bytes32(id)),
                handler.shadowLowest(bytes32(id)),
                "lowest segment"
            );
        }
    }

    function test_HandlerAnchors() public {
        for (uint256 i; i < 16; i++) {
            handler.wait(3600);
            handler.send(i, uint8(i), false);
        }
        assertTrue(handler.anchored() > 0, "nothing was anchored");
    }

    function invariant_CallsFollowTheRules() public view {
        assertTrue(!handler.unexpected(), "a call broke the rules");
    }

    function invariant_LocatorCountMatches() public view {
        (, uint256 count) = anchor.latestLocator();
        assertEq(count, handler.locators(), "locator count");
    }

    function invariant_EveryAnchorIsAccumulated() public view {
        (, uint64 count) = anchor.eventAccumulator();
        assertEq(
            count, handler.anchored() + handler.locators() + handler.keyWrites(), "event count"
        );
    }

    /// Read from the word a verifier proves, so a stray bit the getter
    /// would hide fails too: the high 128 bits stay zero and a retirement
    /// never precedes its registration (docs/spec/verifier.md 2.9,
    /// `receipt-key-record`).
    function invariant_ReceiptKeyRecordsMatchTheShadow() public view {
        for (uint256 k; k < 4; k++) {
            bytes memory key = handler.receiptKey(k);
            bytes32 inner = keccak256(abi.encode(uint256(uint8(key[0])), uint256(ANCHOR_SLOT) + 4));
            uint256 word = uint256(
                vm.load(address(anchor), keccak256(abi.encode(keccak256(abi.encode(k / 2)), inner)))
            );
            uint64 registeredAt = uint64(word);
            uint64 retiredAt = uint64(word >> 64);
            assertEq(word >> 128, 0, "high bits");
            assertTrue(retiredAt == 0 || (registeredAt != 0 && retiredAt >= registeredAt), "order");
            (uint64 wantRegistered, uint64 wantRetired) = handler.keyRecord(k);
            assertEq(registeredAt, wantRegistered, "registeredAt");
            assertEq(retiredAt, wantRetired, "retiredAt");
        }
    }

    function test_HandlerWritesReceiptKeys() public {
        for (uint256 i; i < 8; i++) {
            handler.writeKey(uint8(i), i >= 4, false);
        }
        // Keys 1 and 3 are twins of 0 and 2, so only 0 and 2 are registered and retired.
        assertEq(handler.keyWrites(), 4, "every allowed write lands");
    }
}
