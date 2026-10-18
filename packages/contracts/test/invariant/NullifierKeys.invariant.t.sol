// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {GroupRegistry} from "../../src/GroupRegistry.sol";
import {ITrusteePanels, NullifierKeyLib} from "../../src/NullifierKey.sol";
import {TrusteeRegistry} from "../../src/TrusteeRegistry.sol";
import {NullifierKeyFixture} from "../utils/NullifierKeyFixture.sol";
import {TestBase} from "../utils/Vm.sol";

/// Submits the vectors' honest initial key, reshare and refresh, in any
/// order, at any L2 block, from any account, some with one bit flipped, and
/// keeps a shadow of the chain the registry should hold.
contract NullifierKeyHandler is TestBase {
    GroupRegistry public immutable registry;

    /// The honest records, their deadlines and their key and predecessor
    /// (zero for the initial key).
    bytes[3] internal records;
    uint64[3] internal deadlines;
    bytes32[3] internal keyIds;
    bytes32[3] internal predecessors;

    /// Set if a record was accepted or refused against the rules.
    bool public unexpected;
    bytes32 public shadowKey;
    uint256 public initialKeys;
    uint256 public events;
    mapping(bytes32 keyId => bool) public shadowRecorded;

    constructor(GroupRegistry registry_, string memory json) {
        registry = registry_;
        string[3] memory names = ["initial", "reshare", "refresh"];
        for (uint256 i; i < 3; i++) {
            string memory at = string.concat(".records.", names[i]);
            records[i] = _bytes(json, string.concat(at, ".record"));
            deadlines[i] =
                uint64(vm.parseUint(vm.parseJsonString(json, string.concat(at, ".deadline"))));
            keyIds[i] = bytes32(_bytes(json, string.concat(at, ".keyId")));
            if (i > 0) predecessors[i] = bytes32(_bytes(json, string.concat(at, ".predecessor")));
        }
        // RegistrarsPinned, logged at deployment.
        events = 1;
    }

    function keyId(uint256 i) external view returns (bytes32) {
        return keyIds[i];
    }

    /// Record `which` at a block from well before its window to just past its
    /// deadline, optionally with one bit flipped.
    function submit(uint8 which, uint32 lead, bool flip, uint256 at, uint8 bit, uint8 actor)
        external
    {
        uint256 i = which % 3;
        bytes memory record = records[i];
        if (flip) {
            at %= record.length;
            record[at] = record[at] ^ bytes1(uint8(1) << (bit % 8));
        }
        uint256 maxWindow =
            i == 0 ? NullifierKeyLib.MAX_KEY_WINDOW : NullifierKeyLib.MAX_RESHARE_WINDOW;
        uint256 blockNumber = uint256(deadlines[i]) + 10 - (uint256(lead) % (maxWindow + 20_000));
        vm.roll(blockNumber);
        bool expected = !flip && blockNumber <= deadlines[i]
            && deadlines[i] <= blockNumber + maxWindow && shadowKey == predecessors[i]
            && !shadowRecorded[keyIds[i]];
        vm.prank(address(uint160(0xA000 + actor % 4)));
        (bool ok,) = address(registry)
            .call(
                i == 0
                    ? abi.encodeCall(GroupRegistry.recordNullifierKey, (record))
                    : abi.encodeCall(GroupRegistry.recordNullifierReshare, (record))
            );
        if (ok != expected) unexpected = true;
        if (ok) {
            shadowKey = keyIds[i];
            shadowRecorded[keyIds[i]] = true;
            if (i == 0) initialKeys++;
            events++;
        }
    }

    function _bytes(string memory json, string memory key) private pure returns (bytes memory) {
        return vm.parseBytes(string.concat("0x", vm.parseJsonString(json, key)));
    }
}

/// Invariants (docs/spec/contracts.md, Group registry, Nullifier keys):
/// - every record is accepted exactly when the rules accept it: unflipped,
///   recorded by its deadline and at most the window before it, the initial
///   key while no key is recorded, a successor only of the current key and
///   with a `key_id` never recorded (T-03, T-54);
/// - at most one initial key is ever recorded, and once a key is recorded
///   the scope always has one (T-03);
/// - the registry's current key and recorded set are the shadow's, so the
///   keys form one chain from the initial key;
/// - every accepted record, and nothing else, is one more accumulated event.
contract NullifierKeysInvariantTest is TestBase {
    GroupRegistry internal registry;
    NullifierKeyHandler internal handler;

    function setUp() public {
        string memory json = vm.readFile(NullifierKeyFixture.VECTORS);
        vm.chainId(NullifierKeyFixture.VECTOR_CHAIN_ID);
        string[] memory names = vm.parseJsonStringArray(json, ".pinnedPanels");
        TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](names.length);
        for (uint256 i; i < names.length; i++) {
            panels[i] = NullifierKeyFixture.panel(json, names[i]);
        }
        vm.prank(NullifierKeyFixture.DEPLOYER);
        ITrusteePanels trustees = ITrusteePanels(address(new TrusteeRegistry(panels)));
        address[] memory registrars = new address[](2);
        registrars[0] = address(0x1001);
        registrars[1] = address(0x1002);
        vm.prank(NullifierKeyFixture.DEPLOYER);
        registry = new GroupRegistry(2, registrars, trustees, NullifierKeyFixture.INITIAL_PANEL);
        require(address(registry) == NullifierKeyFixture.VECTOR_REGISTRY, "vectors' registry");
        handler = new NullifierKeyHandler(registry, json);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_RecordsFollowTheRules() public view {
        assertTrue(!handler.unexpected(), "a record was accepted or refused against the rules");
    }

    function invariant_OneChain() public view {
        assertTrue(handler.initialKeys() <= 1, "a second initial key");
        (bytes32 current, bytes32 panel) = registry.nullifierKey();
        assertEq(current, handler.shadowKey(), "current key");
        assertTrue((current == bytes32(0)) == (panel == bytes32(0)), "key without a panel");
        for (uint256 i; i < 3; i++) {
            bytes32 k = handler.keyId(i);
            assertTrue(
                registry.nullifierKeyRecorded(k) == handler.shadowRecorded(k), "recorded set"
            );
        }
    }

    function invariant_EveryChangeIsAccumulated() public view {
        (, uint64 count) = registry.eventAccumulator();
        assertEq(count, handler.events(), "accumulated events");
    }
}
