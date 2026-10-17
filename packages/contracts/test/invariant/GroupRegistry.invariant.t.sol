// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {GroupRegistry, GroupRegistryLib} from "../../src/GroupRegistry.sol";
import {GroupFixture} from "../utils/GroupFixture.sol";
import {TestBase} from "../utils/Vm.sol";

/// Creates signed and self-paid groups and submits additions and removals
/// from any account: any subset of registrar seats, some signatures forged,
/// some positions off by one, some indices stray, repeated or out of order,
/// signed records naming self-paid groups and self-paid ones naming signed
/// groups, some fees wrong and some commitments forbidden. Keeps a shadow of
/// what the registry should hold.
contract GroupHandler is TestBase {
    uint256 internal constant MAX_GROUPS = 4;

    GroupRegistry public immutable registry;
    uint256[] internal secrets;

    uint256 public groups;
    uint256 public events;
    /// Set if a record succeeded or failed against the rules, or the
    /// registry's state moved in a way the rules don't allow.
    bool public unexpected;
    mapping(uint64 groupId => uint64) public shadowCount;
    mapping(uint64 groupId => bool) public shadowSelfPaid;
    /// Self-paid additions accepted, each of which locked one fee.
    uint256 public selfPaidAdded;
    mapping(uint64 groupId => mapping(uint64 index => bool)) public shadowRemoved;
    /// Every removal that succeeded, as (group, index), to recheck for good.
    uint64[2][] internal removedPairs;

    constructor(GroupRegistry registry_, uint256[] memory secrets_) {
        registry = registry_;
        secrets = secrets_;
        // RegistrarsPinned, logged at deployment.
        events = 1;
    }

    function removedCount() external view returns (uint256) {
        return removedPairs.length;
    }

    function removedAt(uint256 i) external view returns (uint64 groupId, uint64 index) {
        return (removedPairs[i][0], removedPairs[i][1]);
    }

    function createGroup(uint8 actorSeed) external {
        if (groups >= MAX_GROUPS) return;
        vm.prank(address(uint160(0xA000 + actorSeed % 3)));
        try registry.createGroup(0) returns (uint64 id) {
            if (id != groups) unexpected = true;
            groups++;
            events++;
        } catch {
            unexpected = true;
        }
    }

    function createSelfPaidGroup(uint8 actorSeed) external {
        if (groups >= MAX_GROUPS) return;
        vm.prank(address(uint160(0xA000 + actorSeed % 3)));
        try registry.createSelfPaidGroup() returns (uint64 id) {
            if (id != groups) unexpected = true;
            shadowSelfPaid[id] = true;
            groups++;
            events++;
        } catch {
            unexpected = true;
        }
    }

    /// Adds one commitment to a group (or to the next, which doesn't exist
    /// yet) from any account, with the fee off by one wei when `feeSkew`
    /// says so and a forbidden commitment when `commitmentSeed < 16`.
    function addSelfPaid(uint8 groupSeed, uint256 commitmentSeed, uint8 feeSkew, uint8 actorSeed)
        external
    {
        uint64 groupId = uint64(groupSeed % (groups + 1));
        uint64 count = shadowCount[groupId];
        uint256 fee = GroupRegistryLib.SELF_PAID_FEE;
        if (feeSkew % 8 == 0) fee++;
        else if (feeSkew % 8 == 1) fee--;
        uint256 c = commitmentSeed < 16
            ? [
                uint256(0), 1, GroupRegistryLib.POSEIDON2_0_1, GroupRegistryLib.R
            ][commitmentSeed % 4]
            : 2 + commitmentSeed % (GroupRegistryLib.R - 2);
        bool allowed = groupId < groups && shadowSelfPaid[groupId]
            && fee == GroupRegistryLib.SELF_PAID_FEE && !GroupRegistryLib.forbidden(c);
        address actor = address(uint160(0xA000 + actorSeed % 3));
        vm.deal(actor, fee);
        uint256 before = address(registry).balance;
        vm.prank(actor);
        try registry.addSelfPaidMember{value: fee}(abi.encodePacked(groupId, c)) {
            if (!allowed) unexpected = true;
            // The registry assigned the next index and kept the fee.
            (,, uint64 after_) = registry.groupOf(groupId);
            if (after_ != count + 1) unexpected = true;
            if (address(registry).balance != before + fee) unexpected = true;
            shadowCount[groupId] = after_;
            selfPaidAdded++;
            events++;
        } catch {
            if (allowed) unexpected = true;
            if (address(registry).balance != before) unexpected = true;
        }
    }

    /// Adds `size % 16 + 1` members to a group (or to the next, which doesn't
    /// exist yet) at its count, or one off when `skew` says so, signed by the seats
    /// in `seatMask`, with one of them forged when `forgeSeed < 64`.
    function add(
        uint8 groupSeed,
        uint8 size,
        uint8 skew,
        uint8 seatMask,
        uint8 forgeSeed,
        uint8 actorSeed
    ) external {
        uint64 groupId = uint64(groupSeed % (groups + 1));
        uint64 count = shadowCount[groupId];
        uint64 first = skew % 8 == 0 ? count + 1 : (skew % 8 == 1 && count > 0 ? count - 1 : count);
        uint256[] memory c = GroupFixture.commitments(
            uint256(keccak256(abi.encode(groupId, first, skew))), size % 16 + 1
        );
        bytes32 d = GroupFixture.addDigest(registry, groupId, 0, first, c);
        (GroupFixture.Approval[] memory a, bool forged) = _approvals(seatMask, forgeSeed, d);

        bool allowed = groupId < groups && !shadowSelfPaid[groupId] && first == count
            && a.length >= 2 && !forged;
        vm.prank(address(uint160(0xA000 + actorSeed % 3)));
        try registry.addMembers(GroupFixture.encodeAdd(groupId, first, c, a)) {
            if (!allowed) unexpected = true;
            // The batch landed at the prior count, and the count moved by its size.
            (,, uint64 after_) = registry.groupOf(groupId);
            if (first != count || after_ != count + c.length) unexpected = true;
            shadowCount[groupId] = after_;
            events++;
        } catch {
            if (allowed) unexpected = true;
        }
    }

    /// Removes up to three indices drawn from the group's members and the
    /// index just past them, in the order drawn when `howMany` is below 128
    /// (so often unordered or repeated), else each above the one before.
    /// The signed size is the group's count, or (by `sizeSkew`) one past it
    /// or half of it, so some indices fall at or beyond it.
    function remove(
        uint8 groupSeed,
        uint64[3] memory draws,
        uint8 howMany,
        uint8 sizeSkew,
        uint8 seatMask,
        uint8 forgeSeed
    ) external {
        uint64 groupId = uint64(groupSeed % (groups + 1));
        uint64 count = shadowCount[groupId];
        uint64 size = sizeSkew % 8 == 0 ? count + 1 : (sizeSkew % 8 == 1 ? count / 2 : count);
        uint64[] memory idx = new uint64[](howMany % 3 + 1);
        bool allowed = groupId < groups && !shadowSelfPaid[groupId] && size <= count;
        for (uint256 i; i < idx.length; i++) {
            idx[i] = draws[i] % (count + 1);
            if (howMany >= 128 && i > 0) idx[i] = idx[i - 1] + 1 + draws[i] % 2;
            if (idx[i] >= size || shadowRemoved[groupId][idx[i]]) allowed = false;
            if (i > 0 && idx[i] <= idx[i - 1]) allowed = false;
        }
        bytes32 d = GroupFixture.removeDigest(registry, groupId, 0, size, idx);
        (GroupFixture.Approval[] memory a, bool forged) = _approvals(seatMask, forgeSeed, d);
        allowed = allowed && a.length >= 2 && !forged;

        try registry.removeMembers(GroupFixture.encodeRemove(groupId, size, idx, a)) {
            if (!allowed) unexpected = true;
            for (uint256 i; i < idx.length; i++) {
                shadowRemoved[groupId][idx[i]] = true;
                removedPairs.push([groupId, idx[i]]);
            }
            (,, uint64 after_) = registry.groupOf(groupId);
            if (after_ != count) unexpected = true;
            events++;
        } catch {
            if (allowed) unexpected = true;
        }
    }

    /// The seats in `seatMask` (of three) when it is below 64, else all
    /// three, in order; when `forgeSeed < 32` one of them signs another digest.
    function _approvals(uint8 seatMask, uint8 forgeSeed, bytes32 d)
        internal
        view
        returns (GroupFixture.Approval[] memory a, bool forged)
    {
        if (seatMask >= 64) seatMask = 7;
        uint256 n;
        for (uint8 seat = 1; seat <= 3; seat++) {
            if (seatMask & (1 << (seat - 1)) != 0) n++;
        }
        a = new GroupFixture.Approval[](n);
        uint8 forgeSeat = forgeSeed < 32 ? forgeSeed % 3 + 1 : 0;
        uint256 at;
        for (uint8 seat = 1; seat <= 3; seat++) {
            if (seatMask & (1 << (seat - 1)) == 0) continue;
            bool forge = seat == forgeSeat;
            forged = forged || forge;
            a[at++] =
                GroupFixture.sign(seat, secrets[seat - 1], forge ? keccak256(abi.encode(d)) : d);
        }
    }
}

/// Invariants, over any sequence of handler calls:
/// 1. A signed record is accepted exactly when its group exists and is a
///    signed group, its position is the group's count (additions), its
///    indices are strictly increasing, below the signed size (itself at most
///    the group's count) and not yet removed (removals), and at least the
///    threshold of distinct registrars signed it with every signature valid
///    (T-06, T-62, T-71). A self-paid addition is accepted exactly when its
///    group exists and is self-paid, its fee is exact and its commitment
///    isn't forbidden, whoever sends it (T-25).
/// 2. Member counts never decrease, and equal the sum of the accepted
///    additions' sizes: every accepted addition's first index was the count
///    before it, so leaves are numbered once and in order (T-06, T-13).
/// 3. A removed flag, once set, is never reset, and removals change no count.
/// 4. The event accumulator counts one event for the registrars and one per
///    group created and per record accepted.
/// 5. A group's kind never changes, and the registry holds exactly one fee
///    per accepted self-paid addition: nothing moves a fee out (T-52).
contract GroupRegistryInvariantTest is TestBase {
    GroupRegistry internal registry;
    GroupHandler internal handler;

    function setUp() public {
        string memory json = vm.readFile(GroupFixture.VECTORS);
        (uint256[] memory secrets, address[] memory addrs, uint8 threshold) =
            GroupFixture.keys(json);
        registry = new GroupRegistry(threshold, addrs);
        handler = new GroupHandler(registry, secrets);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_RecordsFollowTheRules() public view {
        assertTrue(!handler.unexpected(), "a record broke the rules");
    }

    function invariant_CountsMatchTheShadow() public view {
        assertEq(registry.groupCount(), handler.groups(), "groups");
        for (uint64 g; g <= 4; g++) {
            (, bool exists, uint64 count) = registry.groupOf(g);
            assertTrue(exists == (g < handler.groups()), "exists");
            assertEq(count, handler.shadowCount(g), "member count");
            assertTrue(registry.isSelfPaid(g) == handler.shadowSelfPaid(g), "kind");
        }
    }

    function invariant_FeesAreLocked() public view {
        assertEq(
            address(registry).balance,
            handler.selfPaidAdded() * GroupRegistryLib.SELF_PAID_FEE,
            "locked fees"
        );
    }

    function invariant_RemovalsAreForGood() public view {
        uint256 n = handler.removedCount();
        for (uint256 i; i < n; i++) {
            (uint64 g, uint64 index) = handler.removedAt(i);
            assertTrue(registry.isRemoved(g, index), "removed flag reset");
        }
    }

    function invariant_EveryChangeIsAccumulated() public view {
        (, uint64 count) = registry.eventAccumulator();
        assertEq(count, handler.events(), "event count");
    }
}
