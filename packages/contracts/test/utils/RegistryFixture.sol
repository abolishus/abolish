// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ElectionDefinitionLib} from "../../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {DefinitionEncoder, DefinitionHarness, MockTrusteeRegistry} from "./DefinitionHarness.sol";

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
    /// deployment, with identifier `electionId`.
    function template(ElectionRegistry registry, bytes32 electionId)
        internal
        view
        returns (ElectionDefinitionLib.Definition memory d)
    {
        d.protocolMajor = 1;
        d.pinTypes = new uint16[](9);
        d.pinVersions = new uint8[](9);
        for (uint256 i; i < 9; i++) {
            d.pinTypes[i] = uint16(i + 1);
            d.pinVersions[i] = 1;
        }
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

    /// Encodes `d` and has the mock trustee registry record its stub with its
    /// transcript hash, as a panel quorum would.
    function approve(
        DefinitionHarness lib,
        MockTrusteeRegistry trustees,
        ElectionDefinitionLib.Definition memory d
    ) internal returns (bytes memory encoded) {
        encoded = DefinitionEncoder.encode(d);
        trustees.record(lib.stubHash(encoded), d.ceremonyTranscriptHash);
    }
}
