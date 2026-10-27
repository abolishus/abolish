// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ElectionDefinitionLib} from "../../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {DefinitionEncoder, DefinitionHarness, MockTrusteeRegistry} from "./DefinitionHarness.sol";
import {MockL1Block} from "./MockL1Block.sol";
import {Vm} from "./Vm.sol";

/// A deployment and well-formed definitions for it, shared by the unit and
/// invariant tests.
library RegistryFixture {
    uint64 internal constant L1_CHAIN_ID = 11155111; // Sepolia
    uint64 internal constant EPOCH = 1_700_000_000;
    /// The block and time the tests run at: after the epoch, before any
    /// template election opens, and after every template root's block.
    uint256 internal constant NOW = EPOCH + 1000;
    uint256 internal constant BLOCK = 5000;
    uint64 internal constant ROOT_BLOCK = 4000;
    /// The OP Stack's `L1Block` predeploy, as the registry has it.
    address internal constant L1_BLOCK = 0x4200000000000000000000000000000000000015;
    /// The L1 origin the predeploy reports: a Sepolia-like block a minute
    /// before `NOW`, within the template's `max_sequencer_drift`.
    uint64 internal constant L1_ORIGIN_NUMBER = 7_000_000;
    uint64 internal constant L1_ORIGIN_TIMESTAMP = uint64(NOW) - 60;
    bytes32 internal constant L1_ORIGIN_HASH = keccak256("l1-origin");

    /// Puts a mock `L1Block` at the predeploy's address, reporting the
    /// fixture's origin. Every test that deploys a registry calls it, since a
    /// registry with no predeploy refuses to create or register.
    function installL1Block(Vm vm) internal returns (MockL1Block l1) {
        vm.etch(L1_BLOCK, address(new MockL1Block()).code);
        l1 = MockL1Block(L1_BLOCK);
        l1.set(L1_ORIGIN_NUMBER, L1_ORIGIN_TIMESTAMP, L1_ORIGIN_HASH);
    }

    function deployment(address trusteeRegistry)
        internal
        pure
        returns (ElectionRegistry.Deployment memory)
    {
        return ElectionRegistry.Deployment({
            board: address(0xB0A4D),
            trusteeRegistry: trusteeRegistry,
            groupRegistry: address(0x6409),
            l1ChainId: L1_CHAIN_ID,
            l1Anchor: address(0xA1C4),
            l1Relay: address(0x4E1A),
            epoch: EPOCH
        });
    }

    /// A plurality election for Tier 0 and Tier 2 that names `registry`'s
    /// deployment, with identifier `electionId`, and pins the profile the
    /// registry serves for definition version 1: every type at version 1 but
    /// board-entry version 5 and contract-event version 8.
    function template(ElectionRegistry registry, bytes32 electionId)
        internal
        view
        returns (ElectionDefinitionLib.Definition memory d)
    {
        d.version = 1;
        d.protocolMajor = 1;
        d.pinTypes = new uint16[](9);
        d.pinVersions = new uint8[](9);
        for (uint256 i; i < 9; i++) {
            d.pinTypes[i] = uint16(i + 1);
            d.pinVersions[i] = 1;
        }
        d.pinVersions[6] = 5;
        d.pinVersions[7] = 12;
        d.electionId = electionId;
        d.l2ChainId = uint64(block.chainid);
        d.l1ChainId = registry.l1ChainId();
        d.electionRegistry = address(registry);
        d.board = registry.board();
        d.trusteeRegistry = registry.trusteeRegistry();
        d.groupRegistry = registry.groupRegistry();
        d.l1Anchor = registry.l1Anchor();
        d.l1Relay = registry.l1Relay();
        d.electionType = 1;
        d.tallyScheme = 1;
        d.optionCount = 3;
        d.minSelections = 0;
        d.maxSelections = 1;
        d.electorate = new ElectionDefinitionLib.TierGroup[](2);
        d.electorate[0] = ElectionDefinitionLib.TierGroup({
            tier: 0, groupId: 1, root: 0x1234, rootL2Block: ROOT_BLOCK, groupSize: 5000
        });
        d.electorate[1] = ElectionDefinitionLib.TierGroup({
            tier: 2, groupId: 3, root: 0x5678, rootL2Block: ROOT_BLOCK, groupSize: 800
        });
        d.membershipVkHash = sha256("membership-vk");
        d.panelId = sha256("panel");
        d.threshold = 4;
        d.panelSize = 7;
        d.ceremonyTranscriptHash = sha256(abi.encode("transcript", electionId));
        d.opensAt = EPOCH + 10_000;
        d.closesAt = EPOCH + 10_000 + 86_400;
        d.l1InclusionBound = 3600;
        d.sequencingWindow = 3600;
        d.maxSequencerDrift = 1800;
        d.displayTextCommitment = sha256("display-text");
    }

    /// P-256's generator and its double and triple, as `p256-key`s: keys any
    /// definition may list.
    function key(uint256 i) internal pure returns (ElectionDefinitionLib.P256Key memory) {
        if (i == 0) {
            return ElectionDefinitionLib.P256Key(
                3, 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296
            );
        }
        if (i == 1) {
            return ElectionDefinitionLib.P256Key(
                3, 0x7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978
            );
        }
        return ElectionDefinitionLib.P256Key(
            2, 0x5ecbe4d1a6330a44c8f7ef951d4bf165e6c6b721efada985fb41661bc6e7fd6c
        );
    }

    /// `template` under definition version 3, 4, 5 or 6, with each field its
    /// layout adds: Tier 0 split into two regional cells and Tier 2 one cell
    /// (versions 3 to 6); one receipt key (4 to 6); two questions in place of
    /// the one (5 and 6); and a sealed everyday poll without an author panel
    /// (6). The ballot, opening and display-text pins are the versions each
    /// pairs with, so every template is one the registry serves (rule 9).
    function templateV(ElectionRegistry registry, bytes32 electionId, uint8 version)
        internal
        view
        returns (ElectionDefinitionLib.Definition memory d)
    {
        d = template(registry, electionId);
        d.version = version;
        d.pinVersions[0] = version;
        d.pinVersions[1] = version < 5 ? 2 : version == 5 ? 3 : 4;
        d.pinVersions[2] = version < 6 ? 2 : 3;
        d.pinVersions[8] = version < 5 ? 1 : 2;
        d.electorate = new ElectionDefinitionLib.TierGroup[](0);
        d.tiers = new ElectionDefinitionLib.TierElectorate[](2);
        d.tiers[0].tier = 0;
        d.tiers[0].rootL2Block = ROOT_BLOCK;
        d.tiers[0].groups = new ElectionDefinitionLib.RegionGroup[](3);
        d.tiers[0].groups[0] = ElectionDefinitionLib.RegionGroup(1, 0);
        d.tiers[0].groups[1] = ElectionDefinitionLib.RegionGroup(2, 1);
        d.tiers[0].groups[2] = ElectionDefinitionLib.RegionGroup(4, 0);
        d.tiers[0].regions = new uint64[](2);
        d.tiers[0].regions[0] = 3000;
        d.tiers[0].regions[1] = 2000;
        d.tiers[0].cells = new ElectionDefinitionLib.Cell[](2);
        d.tiers[0].cells[0] = ElectionDefinitionLib.Cell(0x1234, 3000);
        d.tiers[0].cells[1] = ElectionDefinitionLib.Cell(0x1235, 2000);
        d.tiers[1].tier = 2;
        d.tiers[1].rootL2Block = ROOT_BLOCK;
        d.tiers[1].groups = new ElectionDefinitionLib.RegionGroup[](1);
        d.tiers[1].groups[0] = ElectionDefinitionLib.RegionGroup(3, 0);
        d.tiers[1].regions = new uint64[](1);
        d.tiers[1].regions[0] = 800;
        d.tiers[1].cells = new ElectionDefinitionLib.Cell[](1);
        d.tiers[1].cells[0] = ElectionDefinitionLib.Cell(0x5678, 800);
        if (version >= 4) {
            d.receiptKeys = new ElectionDefinitionLib.P256Key[](1);
            d.receiptKeys[0] = key(0);
        }
        if (version >= 5) {
            d.electionType = 0;
            d.optionCount = 0;
            d.maxSelections = 0;
            d.questions = new ElectionDefinitionLib.Question[](2);
            d.questions[0] = ElectionDefinitionLib.Question(1, 3, 0, 1);
            d.questions[1] = ElectionDefinitionLib.Question(1, 5, 2, 2);
        }
        if (version == 6) {
            d.pollClass = 1;
            d.resultsMode = 1;
        }
    }

    /// The board's questions for `d` (docs/spec/contracts.md, Parameters),
    /// written from the spec's table rather than read from the registry.
    function questionsOf(ElectionDefinitionLib.Definition memory d)
        internal
        pure
        returns (ElectionDefinitionLib.Question[] memory qs, uint256 total)
    {
        if (d.version >= 5) {
            qs = d.questions;
        } else {
            qs = new ElectionDefinitionLib.Question[](1);
            qs[0] =
                ElectionDefinitionLib.Question(1, d.optionCount, d.minSelections, d.maxSelections);
        }
        for (uint256 i; i < qs.length; i++) {
            total += qs[i].optionCount;
        }
    }

    /// `d`'s partition in order: each cell's tier and root.
    function cellsOf(ElectionDefinitionLib.Definition memory d)
        internal
        pure
        returns (uint8[] memory tiers, uint256[] memory roots)
    {
        uint256 n = d.electorate.length;
        for (uint256 i; i < d.tiers.length; i++) {
            n += d.tiers[i].cells.length;
        }
        tiers = new uint8[](n);
        roots = new uint256[](n);
        uint256 c;
        for (uint256 i; i < d.electorate.length; i++) {
            (tiers[c], roots[c]) = (d.electorate[i].tier, d.electorate[i].root);
            c++;
        }
        for (uint256 i; i < d.tiers.length; i++) {
            for (uint256 j; j < d.tiers[i].cells.length; j++) {
                (tiers[c], roots[c]) = (d.tiers[i].tier, d.tiers[i].cells[j].root);
                c++;
            }
        }
    }

    /// Encodes `d` and has the mock trustee registry record its stub with its
    /// transcript hash, as a panel quorum would.
    function approve(
        DefinitionHarness lib,
        MockTrusteeRegistry trustees,
        ElectionDefinitionLib.Definition memory d
    ) internal returns (bytes memory encoded) {
        encoded = DefinitionEncoder.encode(d);
        trustees.record(
            lib.stubHash(encoded), d.ceremonyTranscriptHash, d.panelId, d.threshold, d.panelSize
        );
    }
}
