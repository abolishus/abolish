// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ElectionDefinitionLib} from "../../src/ElectionDefinition.sol";
import {ElectionIdLib} from "../../src/ElectionRegistry.sol";
import {ITrusteeRegistry} from "../../src/ITrusteeRegistry.sol";

/// Exposes the definition library and the election identifier to tests.
contract DefinitionHarness {
    function decode(bytes calldata d)
        external
        pure
        returns (ElectionDefinitionLib.Definition memory)
    {
        return ElectionDefinitionLib.decode(d);
    }

    function rule(bytes calldata d) external pure returns (ElectionDefinitionLib.Rule) {
        return ElectionDefinitionLib.rule(ElectionDefinitionLib.decode(d));
    }

    function hash(bytes calldata d) external pure returns (bytes32) {
        return ElectionDefinitionLib.hash(d);
    }

    function stubHash(bytes calldata d) external pure returns (bytes32) {
        return ElectionDefinitionLib.stubHash(d, ElectionDefinitionLib.decode(d).transcriptOffset);
    }

    function electionId(uint64 chainId, address registry, uint64 counter)
        external
        pure
        returns (bytes32)
    {
        return ElectionIdLib.electionId(chainId, registry, counter);
    }
}

/// Encodes a definition by the layout table of docs/spec/election-definition.md,
/// field by field. Tests check it against every valid vector before using it
/// to build definitions for a deployment.
library DefinitionEncoder {
    function encode(ElectionDefinitionLib.Definition memory d)
        internal
        pure
        returns (bytes memory out)
    {
        out = abi.encodePacked(uint16(1), uint8(1), d.protocolMajor, uint32(d.pinTypes.length));
        for (uint256 i; i < d.pinTypes.length; i++) {
            out = abi.encodePacked(out, d.pinTypes[i], d.pinVersions[i]);
        }
        out = abi.encodePacked(
            out,
            d.electionId,
            d.l2ChainId,
            d.l1ChainId,
            d.electionRegistry,
            d.board,
            d.trusteeRegistry,
            d.groupRegistry,
            d.l1Anchor,
            d.l1Relay
        );
        out = abi.encodePacked(
            out,
            d.electionType,
            d.tallyScheme,
            d.optionCount,
            d.minSelections,
            d.maxSelections,
            uint32(d.electorate.length)
        );
        for (uint256 i; i < d.electorate.length; i++) {
            ElectionDefinitionLib.TierGroup memory g = d.electorate[i];
            out = abi.encodePacked(out, g.tier, g.groupId, g.root, g.rootL2Block, g.groupSize);
        }
        out = abi.encodePacked(
            out, d.membershipVkHash, d.panelId, d.threshold, d.panelSize, d.ceremonyTranscriptHash
        );
        out = abi.encodePacked(
            out,
            d.opensAt,
            d.closesAt,
            d.l1InclusionBound,
            d.sequencingWindow,
            d.maxSequencerDrift,
            d.displayTextCommitment
        );
    }
}

/// Stands in for the trustee key registry (P1-18, part 3): it reports a pair
/// as recorded once a test records it.
contract MockTrusteeRegistry is ITrusteeRegistry {
    mapping(bytes32 => mapping(bytes32 => bool)) internal recorded;

    function record(bytes32 stubHash, bytes32 transcriptHash) external {
        recorded[stubHash][transcriptHash] = true;
    }

    function ceremonyRecorded(bytes32 stubHash, bytes32 transcriptHash)
        external
        view
        returns (bool)
    {
        return recorded[stubHash][transcriptHash];
    }
}
