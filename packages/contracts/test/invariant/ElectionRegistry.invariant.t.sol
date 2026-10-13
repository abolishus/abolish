// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ElectionDefinitionLib} from "../../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {DefinitionHarness, MockTrusteeRegistry} from "../utils/DefinitionHarness.sol";
import {RegistryFixture} from "../utils/RegistryFixture.sol";
import {TestBase} from "../utils/Vm.sol";

/// Creates elections from several accounts and tries to register approved
/// definitions for them from any account, any number of times, keeping a
/// shadow of what the registry should hold.
contract RegistryHandler is TestBase {
    ElectionRegistry public immutable registry;
    DefinitionHarness internal immutable lib;
    MockTrusteeRegistry internal immutable trustees;

    bytes32[] public ids;
    mapping(bytes32 => address) public shadowCreator;
    mapping(bytes32 => bytes32) public shadowHash;
    uint256 public registrations;
    /// Set if a registration succeeded or failed against the rules.
    bool public unexpected;

    constructor(ElectionRegistry registry_, DefinitionHarness lib_, MockTrusteeRegistry trustees_) {
        registry = registry_;
        lib = lib_;
        trustees = trustees_;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function create(uint8 actorSeed) external {
        address actor = _actor(actorSeed);
        vm.prank(actor);
        bytes32 id = registry.createElection();
        if (shadowCreator[id] != address(0)) unexpected = true; // an identifier reused
        ids.push(id);
        shadowCreator[id] = actor;
    }

    /// Registers a definition for a created election from `actorSeed`'s
    /// account. The definition varies with `variant`, so a second, different
    /// approved definition for the same election is tried too.
    function register(uint256 idSeed, uint8 actorSeed, uint8 variant) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        address actor = _actor(actorSeed);
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        d.optionCount = 2 + variant % 4;
        bytes memory enc = RegistryFixture.approve(lib, trustees, d);
        bool allowed = actor == shadowCreator[id] && shadowHash[id] == bytes32(0);
        vm.prank(actor);
        try registry.registerDefinition(enc) {
            if (!allowed) unexpected = true;
            shadowHash[id] = lib.hash(enc);
            registrations++;
            if (!_recorded(lib.hash(enc), d)) unexpected = true;
        } catch {
            if (allowed) unexpected = true;
            // A refused definition records nothing, unless it is the one
            // already registered for this election.
            if (
                lib.hash(enc) != shadowHash[id]
                    && registry.parameters(lib.hash(enc)).ballotVersion != 0
            ) unexpected = true;
        }
    }

    /// Whether the registry recorded exactly `d`'s parameters for `h`.
    function _recorded(bytes32 h, ElectionDefinitionLib.Definition memory d)
        internal
        view
        returns (bool)
    {
        ElectionRegistry.Parameters memory p = registry.parameters(h);
        if (
            p.ballotVersion != d.pinVersions[1] || p.threshold != d.threshold
                || p.panelSize != d.panelSize || p.optionCount != d.optionCount
                || p.cellCount != d.electorate.length || p.questions.length != 1
                || p.questions[0].method != 1 || p.questions[0].optionCount != d.optionCount
                || p.questions[0].minSelections != d.minSelections
                || p.questions[0].maxSelections != d.maxSelections
        ) return false;
        for (uint256 i; i < d.electorate.length; i++) {
            (uint8 tier, uint256 root) = registry.cell(h, i);
            if (tier != d.electorate[i].tier || root != d.electorate[i].root) return false;
        }
        return true;
    }

    function _actor(uint8 seed) internal pure returns (address) {
        return address(uint160(0xA000 + seed % 3));
    }
}

/// Invariants, over any sequence of handler calls:
/// 1. The registry's election count equals the number of elections created,
///    and every identifier it assigned is distinct (T-23, T-24).
/// 2. Every election's creator is the account that created it.
/// 3. An election's definition hash is set once, by its creator, and never
///    changes afterwards (write-once; T-34, T-24).
/// 4. A registration succeeds exactly when its caller is the creator and the
///    election has no definition yet.
/// 5. The event accumulator counts one event per creation and per registration.
/// 6. The board's parameters are recorded for exactly the registered
///    definitions, each exactly the registered definition's, and a refused
///    definition records none (ADR 0028, 1C).
contract ElectionRegistryInvariantTest is TestBase {
    ElectionRegistry internal registry;
    RegistryHandler internal handler;

    function setUp() public {
        RegistryFixture.installL1Block(vm);
        DefinitionHarness lib = new DefinitionHarness();
        MockTrusteeRegistry trustees = new MockTrusteeRegistry();
        registry = new ElectionRegistry(RegistryFixture.deployment(address(trustees)));
        handler = new RegistryHandler(registry, lib, trustees);
        vm.warp(RegistryFixture.NOW);
        vm.roll(RegistryFixture.BLOCK);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_CountMatchesCreations() public view {
        assertEq(registry.electionCount(), handler.idCount(), "election count");
    }

    function invariant_CreatorsAndDefinitionsMatchTheShadow() public view {
        uint256 n = handler.idCount();
        for (uint256 i; i < n; i++) {
            bytes32 id = handler.ids(i);
            assertEq(id, registry.electionIdAt(uint64(i)), "identifier");
            assertTrue(registry.creatorOf(id) == handler.shadowCreator(id), "creator");
            bytes32 h = handler.shadowHash(id);
            assertEq(registry.definitionHashOf(id), h, "definition hash");
            // Set exactly for the registered definitions; what was recorded
            // is checked against the definition at registration.
            assertEq(registry.parameters(h).cellCount, h == bytes32(0) ? 0 : 2, "parameters");
        }
    }

    function invariant_RegistrationsFollowTheRules() public view {
        assertTrue(!handler.unexpected(), "a registration broke the rules");
    }

    function invariant_EveryChangeIsAccumulated() public view {
        (, uint64 count) = registry.eventAccumulator();
        assertEq(count, handler.idCount() + handler.registrations(), "event count");
    }
}
