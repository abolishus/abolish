// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {GroupRegistry} from "../../src/GroupRegistry.sol";
import {GroupFixture} from "../utils/GroupFixture.sol";
import {NullifierKeyFixture} from "../utils/NullifierKeyFixture.sol";
import {TestBase} from "../utils/Vm.sol";

/// Submits Tier 1 additions from any account at any block around their root
/// windows: three of vouch-count.json's counted additions (groups 9, 12 and
/// 10), verbatim, as copies of ones already logged, or with one byte changed.
/// Keeps a shadow of what the registry should accept.
contract Tier1Handler is TestBase {
    /// The deployment's root window (`VOUCH_ROOT_WINDOW`).
    uint256 internal constant W = 302_400;

    GroupRegistry public immutable registry;
    bytes[] internal records;

    uint256 public accepted;
    /// Set if a call was accepted or refused against the stateless rules.
    bool public unexpected;

    constructor(GroupRegistry registry_, bytes[] memory records_) {
        registry = registry_;
        for (uint256 i; i < records_.length; i++) {
            records.push(records_[i]);
        }
    }

    /// Submits record `which` at a block from just before the earliest root
    /// block to just past the latest window, with one byte changed when
    /// `mutate` is odd.
    function submit(uint8 which, uint32 blockSeed, bool mutate, uint16 at, uint8 actorSeed)
        external
    {
        bytes memory record = bytes.concat(records[which % records.length]);
        uint256 b = 1_259_000 + uint256(blockSeed) % 306_000;
        vm.roll(b);
        // Every vouch's root block is the same in each record (1,260,000 or
        // 1,261,800), so the window is one interval.
        uint256 rootBlock = uint64(bytes8(_slice(record, 49, 8)));
        bool allowed = b >= rootBlock && b <= rootBlock + W;
        if (mutate) {
            // Any changed byte is refused (Tier1Additions.t.sol, bit flips).
            record[at % record.length] ^= 0x01;
            allowed = false;
        }
        vm.prank(address(uint160(0xB000 + actorSeed % 3)));
        try registry.addTier1Member(record) {
            if (!allowed) unexpected = true;
            accepted++;
        } catch {
            if (allowed) unexpected = true;
        }
    }

    function _slice(bytes memory b, uint256 from, uint256 len)
        internal
        pure
        returns (bytes memory out)
    {
        out = new bytes(len);
        for (uint256 i; i < len; i++) {
            out[i] = b[from + i];
        }
    }
}

/// Invariants, over any sequence of Tier 1 submissions:
/// 1. A Tier 1 addition is accepted exactly when the registry's stateless
///    rules pass at the call's block, whatever was accepted or refused
///    before it: no logged or refused addition, a copy of it included, can
///    make the registry refuse another (T-25, T-53).
/// 2. Tier 1 calls change no group record: every Tier 0 count, removed flag,
///    tier and creation block stays as set up (T-06).
/// 3. The event accumulator counts one event per accepted Tier 1 addition
///    and nothing else.
contract Tier1AdditionsInvariantTest is TestBase {
    uint256 internal constant CHAIN_ID = 84532;
    address internal constant REGISTRY = 0x5A0b5a0B5a0B5a0b5a0B5a0B5A0B5a0b5a0B5a0B;
    string internal constant COUNT = "../../docs/spec/vectors/vouch-count.json";

    GroupRegistry internal registry;
    Tier1Handler internal handler;
    uint64 internal startCount;

    function setUp() public {
        (, address[] memory addrs, uint8 threshold) =
            GroupFixture.keys(vm.readFile(GroupFixture.VECTORS));
        // The vectors' proofs bind their chain and registry address.
        vm.chainId(CHAIN_ID);
        vm.etch(
            REGISTRY,
            address(
                new GroupRegistry(
                    threshold,
                    addrs,
                    NullifierKeyFixture.trustees(),
                    NullifierKeyFixture.INITIAL_PANEL
                )
            )
            .code
        );
        registry = GroupRegistry(REGISTRY);
        GroupFixture.setGroup(registry, 0, 0, true, 5, 900_000);
        GroupFixture.setGroup(registry, 7, 2, true, 0, 1_000_000);
        GroupFixture.setGroup(registry, 9, 1, true, 0, 1_000_000);
        GroupFixture.setGroup(registry, 10, 1, true, 0, 1_000_000);
        GroupFixture.setGroup(registry, 12, 1, true, 0, 1_000_000);
        bytes[] memory records = new bytes[](3);
        string memory json = vm.readFile(COUNT);
        records[0] = _record(json, 13);
        records[1] = _record(json, 24);
        records[2] = _record(json, 34);
        handler = new Tier1Handler(registry, records);
        (, startCount) = registry.eventAccumulator();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_AcceptedExactlyByTheStatelessRules() public view {
        assertTrue(!handler.unexpected(), "a Tier 1 call broke the rules");
    }

    function invariant_GroupTableUnchanged() public view {
        (uint8 tier, bool exists, uint64 count) = registry.groupOf(0);
        assertTrue(tier == 0 && exists && count == 5, "tier 0 group");
        assertEq(registry.groupCreatedBlock(0), 900_000, "tier 0 created block");
        for (uint64 index; index < 5; index++) {
            assertTrue(!registry.isRemoved(0, index), "removed flag");
        }
        uint64[4] memory ids = [uint64(7), 9, 10, 12];
        for (uint256 i; i < 4; i++) {
            (tier, exists, count) = registry.groupOf(ids[i]);
            assertTrue(exists && count == 0, "tier 1 or 2 group");
            assertEq(tier, ids[i] == 7 ? 2 : 1, "tier");
            assertEq(registry.groupCreatedBlock(ids[i]), 1_000_000, "created block");
        }
    }

    function invariant_OneEventPerAcceptedAddition() public view {
        (, uint64 count) = registry.eventAccumulator();
        assertEq(count, startCount + handler.accepted(), "event count");
    }

    function _record(string memory json, uint256 i) internal pure returns (bytes memory) {
        return vm.parseBytes(
            string.concat(
                "0x",
                vm.parseJsonString(
                    json, string.concat(".cases[0].events[", vm.toString(i), "].record")
                )
            )
        );
    }
}
