// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionIdLib} from "../src/ElectionRegistry.sol";
import {DefinitionEncoder, DefinitionHarness} from "./utils/DefinitionHarness.sol";
import {TestBase} from "./utils/Vm.sol";

/// The election definition's decoder, rules and hashes, and the election
/// identifier, against docs/spec/vectors/election-definition.json and
/// election-registry.json, which independent Python implementations produced
/// (T-31, T-34, T-17). Every expected value comes from the files.
contract ElectionDefinitionVectorsTest is TestBase {
    string internal constant DEFINITIONS = "../../docs/spec/vectors/election-definition.json";
    string internal constant REGISTRY = "../../docs/spec/vectors/election-registry.json";

    DefinitionHarness internal lib;

    function setUp() public {
        lib = new DefinitionHarness();
    }

    function test_DefinitionVectorFileFormat() public view {
        // The file is read into memory per test: a storage copy costs more
        // gas to load than a test has.
        string memory json = vm.readFile(DEFINITIONS);
        assertTrue(
            keccak256(bytes(vm.parseJsonString(json, ".format"))) == keccak256("abolish-vectors/1"),
            "unknown vector format"
        );
        assertTrue(
            _tag(ElectionDefinitionLib.DS_DEFINITION)
                == keccak256("abolish/v1/election-definition"),
            "definition tag"
        );
        assertTrue(
            _tag(ElectionDefinitionLib.DS_STUB) == keccak256("abolish/v1/election-stub"), "stub tag"
        );
    }

    /// Every vector: rejected with its decode error, or accepted with its
    /// hash, stub hash and well-formedness label, and re-encoding to itself.
    function test_DefinitionVectors() public view {
        string memory json = vm.readFile(DEFINITIONS);
        uint256 i;
        uint256 rejected;
        for (; vm.keyExistsJson(json, _key(i, "")); i++) {
            bytes memory b = _bytes(json, _key(i, ".encoding"));
            if (vm.keyExistsJson(json, _key(i, ".error"))) {
                _assertDecodeError(b, _str(json, _key(i, ".error")), _str(json, _key(i, ".id")));
                rejected++;
                continue;
            }
            assertEq(lib.hash(b), _bytes32(json, _key(i, ".hash")), _str(json, _key(i, ".id")));
            assertEq(
                lib.stubHash(b), _bytes32(json, _key(i, ".stubHash")), _str(json, _key(i, ".id"))
            );
            ElectionDefinitionLib.Rule expected = vm.keyExistsJson(json, _key(i, ".illFormed"))
                ? _rule(_str(json, _key(i, ".illFormed")))
                : ElectionDefinitionLib.Rule.None;
            assertTrue(lib.rule(b) == expected, _str(json, _key(i, ".id")));
            assertTrue(
                keccak256(DefinitionEncoder.encode(lib.decode(b))) == keccak256(b),
                "re-encoding differs"
            );
        }
        assertTrue(i > 0 && rejected > 0 && rejected < i, "vector coverage");
    }

    function test_ElectionIdVectors() public view {
        string memory reg = vm.readFile(REGISTRY);
        assertTrue(
            keccak256(bytes(vm.parseJsonString(reg, ".format")))
                == keccak256("abolish-election-registry-vectors/1"),
            "unknown vector format"
        );
        assertTrue(
            _tag(ElectionIdLib.DS_ELECTION_ID) == keccak256(bytes(vm.parseJsonString(reg, ".tag"))),
            "election-id tag"
        );
        uint256 i;
        for (; vm.keyExistsJson(reg, string.concat(".electionIds[", vm.toString(i), "]")); i++) {
            string memory v = string.concat(".electionIds[", vm.toString(i), "]");
            bytes32 id = lib.electionId(
                uint64(vm.parseUint(vm.parseJsonString(reg, string.concat(v, ".chainId")))),
                address(
                    bytes20(vm.parseBytes(vm.parseJsonString(reg, string.concat(v, ".registry"))))
                ),
                uint64(vm.parseUint(vm.parseJsonString(reg, string.concat(v, ".counter"))))
            );
            assertEq(
                id,
                bytes32(vm.parseBytes(vm.parseJsonString(reg, string.concat(v, ".electionId")))),
                "election id"
            );
        }
        // The rejected vectors (a chain ID or counter of 2^64) can't be
        // passed as uint64 at all: the type rules them out, and the registry
        // never derives an identifier from a wider value (its deployment
        // refuses such a chain ID and its counter can't pass 2^64 − 1).
        assertTrue(i > 0, "no election-id vectors");
    }

    /// Types specified when version 1 was frozen, other than the definition,
    /// are unexpected rather than unknown (docs/spec/contracts.md, Registration).
    function test_SpecifiedOtherTypesAreUnexpected() public view {
        string memory json = vm.readFile(DEFINITIONS);
        bytes memory b = _bytes(json, _key(0, ".encoding"));
        uint16[2] memory types = [uint16(0x0007), uint16(0x0009)];
        for (uint256 t; t < 2; t++) {
            b[0] = bytes1(uint8(types[t] >> 8));
            b[1] = bytes1(uint8(types[t]));
            _assertDecodeError(b, "unexpected-record-type", "specified type");
        }
        b[0] = 0x00;
        b[1] = 0x02; // reserved, no layout yet
        _assertDecodeError(b, "unknown-record-type", "reserved type");
    }

    // --- helpers -------------------------------------------------------------

    function _assertDecodeError(bytes memory b, string memory code, string memory id)
        internal
        view
    {
        try lib.decode(b) {
            revert(string.concat("accepted ", id));
        } catch (bytes memory reason) {
            bytes4 selector;
            uint256 got;
            assembly ("memory-safe") {
                selector := mload(add(reason, 0x20))
                got := mload(add(reason, 0x24))
            }
            assertTrue(
                reason.length == 68
                    && selector == ElectionDefinitionLib.DefinitionMalformed.selector,
                string.concat("unexpected revert for ", id)
            );
            assertEq(got, uint256(_decodeError(code)), id);
        }
    }

    function _decodeError(string memory code)
        internal
        pure
        returns (ElectionDefinitionLib.DecodeError)
    {
        bytes32 c = keccak256(bytes(code));
        if (c == keccak256("truncated")) return ElectionDefinitionLib.DecodeError.Truncated;
        if (c == keccak256("trailing-bytes")) {
            return ElectionDefinitionLib.DecodeError.TrailingBytes;
        }
        if (c == keccak256("length-over-max")) {
            return ElectionDefinitionLib.DecodeError.LengthOverMax;
        }
        if (c == keccak256("unknown-record-type")) {
            return ElectionDefinitionLib.DecodeError.UnknownRecordType;
        }
        if (c == keccak256("unexpected-record-type")) {
            return ElectionDefinitionLib.DecodeError.UnexpectedRecordType;
        }
        if (c == keccak256("unknown-version")) {
            return ElectionDefinitionLib.DecodeError.UnknownVersion;
        }
        if (c == keccak256("invalid-enum")) return ElectionDefinitionLib.DecodeError.InvalidEnum;
        if (c == keccak256("non-canonical")) {
            return ElectionDefinitionLib.DecodeError.NonCanonical;
        }
        if (c == keccak256("profile-mismatch")) {
            return ElectionDefinitionLib.DecodeError.ProfileMismatch;
        }
        revert(string.concat("unknown decode error ", code));
    }

    function _rule(string memory code) internal pure returns (ElectionDefinitionLib.Rule) {
        bytes32 c = keccak256(bytes(code));
        if (c == keccak256("protocol-major")) return ElectionDefinitionLib.Rule.ProtocolMajor;
        if (c == keccak256("profile-order")) return ElectionDefinitionLib.Rule.ProfileOrder;
        if (c == keccak256("profile-types")) return ElectionDefinitionLib.Rule.ProfileTypes;
        if (c == keccak256("profile-version")) return ElectionDefinitionLib.Rule.ProfileVersion;
        if (c == keccak256("option-count")) return ElectionDefinitionLib.Rule.OptionCount;
        if (c == keccak256("selections")) return ElectionDefinitionLib.Rule.Selections;
        if (c == keccak256("electorate")) return ElectionDefinitionLib.Rule.Electorate;
        if (c == keccak256("panel")) return ElectionDefinitionLib.Rule.Panel;
        if (c == keccak256("chain")) return ElectionDefinitionLib.Rule.Chain;
        if (c == keccak256("timing")) return ElectionDefinitionLib.Rule.Timing;
        revert(string.concat("unknown rule ", code));
    }

    /// The tag a `u8(len(tag)) ‖ tag` prefix frames, hashed for comparison.
    function _tag(bytes memory prefix) internal pure returns (bytes32) {
        assertEq(uint8(prefix[0]), prefix.length - 1, "length byte");
        bytes memory tag = new bytes(prefix.length - 1);
        for (uint256 i; i < tag.length; i++) {
            tag[i] = prefix[i + 1];
        }
        return keccak256(tag);
    }

    function _key(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".vectors[", vm.toString(i), "]", field);
    }

    function _str(string memory json, string memory key) internal pure returns (string memory) {
        return vm.parseJsonString(json, key);
    }

    function _bytes(string memory json, string memory key) internal pure returns (bytes memory) {
        string memory h = _str(json, key);
        // The vectors write empty bytes as "", which parseBytes refuses.
        return bytes(h).length == 0 ? bytes("") : vm.parseBytes(h);
    }

    function _bytes32(string memory json, string memory key) internal pure returns (bytes32) {
        bytes memory b = _bytes(json, key);
        assertEq(b.length, 32, "expected 32 bytes");
        return bytes32(b);
    }
}
