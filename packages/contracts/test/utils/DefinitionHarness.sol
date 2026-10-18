// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ElectionDefinitionLib} from "../../src/ElectionDefinition.sol";
import {ElectionIdLib} from "../../src/ElectionRegistry.sol";
import {ITrusteeRegistry} from "../../src/ITrusteeRegistry.sol";

/// Exposes the definition library and the election identifier to tests.
contract DefinitionHarness {
    function decode(bytes calldata d)
        external
        view
        returns (ElectionDefinitionLib.Definition memory)
    {
        return ElectionDefinitionLib.decode(d);
    }

    function rule(bytes calldata d) external view returns (ElectionDefinitionLib.Rule) {
        return ElectionDefinitionLib.rule(ElectionDefinitionLib.decode(d));
    }

    function hash(bytes calldata d) external pure returns (bytes32) {
        return ElectionDefinitionLib.hash(d);
    }

    function stubHash(bytes calldata d) external view returns (bytes32) {
        return ElectionDefinitionLib.stubHash(d, ElectionDefinitionLib.decode(d).transcriptOffset);
    }

    function authorStubHash(bytes calldata d) external view returns (bytes32) {
        return
            ElectionDefinitionLib.authorStubHash(
                d, ElectionDefinitionLib.decode(d).transcriptOffset
            );
    }

    function authorPanelId(bytes calldata d) external view returns (bytes32) {
        return ElectionDefinitionLib.authorPanelId(ElectionDefinitionLib.decode(d));
    }

    function authorPanelIdOf(ElectionDefinitionLib.Definition memory def)
        external
        pure
        returns (bytes32)
    {
        return ElectionDefinitionLib.authorPanelId(def);
    }

    function point(ElectionDefinitionLib.P256Key memory key)
        external
        view
        returns (uint256 x, uint256 y)
    {
        return ElectionDefinitionLib.point(key);
    }

    function electionId(uint64 chainId, address registry, uint64 counter)
        external
        pure
        returns (bytes32)
    {
        return ElectionIdLib.electionId(chainId, registry, counter);
    }
}

/// Appends big-endian integers to a buffer that doubles when full, so
/// encoding a definition with a tier at its list limits (about 30 KB) costs
/// linear memory, where repeated `abi.encodePacked` would copy it at every field.
library ByteWriter {
    struct Writer {
        bytes buf;
        uint256 len;
    }

    function create() internal pure returns (Writer memory) {
        return Writer(new bytes(1024), 0);
    }

    /// Appends the low `n` bytes (1 ≤ n ≤ 32) of `v`, big-endian.
    function put(Writer memory w, uint256 v, uint256 n) internal pure {
        // `mstore` writes 32 bytes, so keep that much room past the end.
        if (w.len + 32 > w.buf.length) {
            bytes memory grown = new bytes(2 * w.buf.length);
            bytes memory old = w.buf;
            for (uint256 i; i < w.len; i++) {
                grown[i] = old[i];
            }
            w.buf = grown;
        }
        bytes memory b = w.buf;
        uint256 at = w.len;
        assembly ("memory-safe") {
            mstore(add(add(b, 0x20), at), shl(sub(256, mul(n, 8)), v))
        }
        w.len = at + n;
    }

    function finish(Writer memory w) internal pure returns (bytes memory b) {
        b = w.buf;
        uint256 len = w.len;
        assembly ("memory-safe") {
            mstore(b, len)
        }
    }
}

/// Encodes a definition by the layout tables of docs/spec/election-definition.md,
/// field by field, under the layout its `version` names. Tests check it
/// against every valid vector before using it to build definitions for a
/// deployment.
library DefinitionEncoder {
    using ByteWriter for ByteWriter.Writer;

    function encode(ElectionDefinitionLib.Definition memory d)
        internal
        pure
        returns (bytes memory)
    {
        ByteWriter.Writer memory w = ByteWriter.create();
        w.put(1, 2);
        w.put(d.version, 1);
        w.put(d.protocolMajor, 1);
        w.put(d.pinTypes.length, 4);
        for (uint256 i; i < d.pinTypes.length; i++) {
            w.put(d.pinTypes[i], 2);
            w.put(d.pinVersions[i], 1);
        }
        w.put(uint256(d.electionId), 32);
        w.put(d.l2ChainId, 8);
        w.put(d.l1ChainId, 8);
        address[6] memory addresses = [
            d.electionRegistry, d.board, d.trusteeRegistry, d.groupRegistry, d.l1Anchor, d.l1Relay
        ];
        for (uint256 i; i < 6; i++) {
            w.put(uint160(addresses[i]), 20);
        }
        if (d.version < 5) {
            w.put(d.electionType, 1);
            w.put(d.tallyScheme, 1);
            w.put(d.optionCount, 2);
            w.put(d.minSelections, 2);
            w.put(d.maxSelections, 2);
        } else {
            w.put(d.questions.length, 4);
            for (uint256 i; i < d.questions.length; i++) {
                ElectionDefinitionLib.Question memory q = d.questions[i];
                w.put(q.method, 1);
                w.put(q.optionCount, 2);
                w.put(q.minSelections, 2);
                w.put(q.maxSelections, 2);
            }
            w.put(d.tallyScheme, 1);
        }
        if (d.version == 1) _electorate(w, d);
        else _tiers(w, d);
        w.put(uint256(d.membershipVkHash), 32);
        w.put(uint256(d.panelId), 32);
        w.put(d.threshold, 1);
        w.put(d.panelSize, 1);
        w.put(uint256(d.ceremonyTranscriptHash), 32);
        w.put(d.opensAt, 8);
        w.put(d.closesAt, 8);
        w.put(d.l1InclusionBound, 4);
        w.put(d.sequencingWindow, 8);
        w.put(d.maxSequencerDrift, 8);
        w.put(uint256(d.displayTextCommitment), 32);
        if (d.version >= 4) _keys(w, d.receiptKeys);
        if (d.version == 6) {
            w.put(d.pollClass, 1);
            w.put(d.resultsMode, 1);
            w.put(d.liveEvery, 4);
            w.put(d.liveBatch, 4);
            w.put(d.authorThreshold, 1);
            _keys(w, d.authorKeys);
            w.put(uint256(d.authorTranscriptHash), 32);
        }
        return w.finish();
    }

    function _electorate(ByteWriter.Writer memory w, ElectionDefinitionLib.Definition memory d)
        private
        pure
    {
        w.put(d.electorate.length, 4);
        for (uint256 i; i < d.electorate.length; i++) {
            ElectionDefinitionLib.TierGroup memory g = d.electorate[i];
            w.put(g.tier, 1);
            w.put(g.groupId, 8);
            w.put(g.root, 32);
            w.put(g.rootL2Block, 8);
            w.put(g.groupSize, 8);
        }
    }

    function _tiers(ByteWriter.Writer memory w, ElectionDefinitionLib.Definition memory d)
        private
        pure
    {
        w.put(d.tiers.length, 4);
        for (uint256 i; i < d.tiers.length; i++) {
            ElectionDefinitionLib.TierElectorate memory t = d.tiers[i];
            w.put(t.tier, 1);
            w.put(t.rootL2Block, 8);
            w.put(t.groups.length, 4);
            for (uint256 j; j < t.groups.length; j++) {
                w.put(t.groups[j].groupId, 8);
                w.put(t.groups[j].region, 2);
            }
            w.put(t.regions.length, 4);
            for (uint256 j; j < t.regions.length; j++) {
                w.put(t.regions[j], 8);
            }
            w.put(t.cells.length, 4);
            for (uint256 j; j < t.cells.length; j++) {
                w.put(t.cells[j].root, 32);
                w.put(t.cells[j].members, 8);
            }
        }
    }

    function _keys(ByteWriter.Writer memory w, ElectionDefinitionLib.P256Key[] memory keys)
        private
        pure
    {
        w.put(keys.length, 4);
        for (uint256 i; i < keys.length; i++) {
            w.put(keys[i].prefix, 1);
            w.put(uint256(keys[i].x), 32);
        }
    }
}

/// Stands in for the trustee key registry (P1-18, part 3): it reports a pair
/// as recorded once a test records it.
contract MockTrusteeRegistry is ITrusteeRegistry {
    mapping(bytes32 => bool) internal recorded;

    function record(
        bytes32 stubHash,
        bytes32 transcriptHash,
        bytes32 panelId,
        uint8 threshold,
        uint8 panelSize
    ) external {
        recorded[
            keccak256(abi.encode(stubHash, transcriptHash, panelId, threshold, panelSize))
        ] = true;
    }

    function ceremonyRecorded(
        bytes32 stubHash,
        bytes32 transcriptHash,
        bytes32 panelId,
        uint8 threshold,
        uint8 panelSize
    ) external view returns (bool) {
        return recorded[
            keccak256(abi.encode(stubHash, transcriptHash, panelId, threshold, panelSize))
        ];
    }

    /// No test registers an author panel through the mock: rule 9 refuses
    /// every version-6 definition before the call, and the author panel's
    /// tests run against a real trustee registry.
    function checkAuthorRegistration(bytes calldata, uint256[2][] calldata, uint8)
        external
        pure
        returns (bytes32, uint256)
    {
        revert("mock: no author check");
    }
}
