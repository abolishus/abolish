// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {MembershipProofLib} from "../src/MembershipProof.sol";
import {MembershipHarness} from "./utils/MembershipHarness.sol";
import {TestBase} from "./utils/Vm.sol";

/// The on-chain membership check (docs/spec/contracts.md, Board, Membership
/// proofs) against docs/spec/vectors/membership-proof.json, which holds real
/// Semaphore proofs with snarkjs's and the spec's verdicts, and
/// membership.json, from an independent Python implementation of the scope
/// and `F`. Every expected value comes from the files, so the contract and
/// `packages/crypto` accept exactly the same proofs (T-05, T-31).
contract MembershipProofTest is TestBase {
    string internal constant PROOFS = "../../docs/spec/vectors/membership-proof.json";
    string internal constant MEMBERSHIP = "../../docs/spec/vectors/membership.json";

    MembershipHarness internal lib;

    function setUp() public {
        lib = new MembershipHarness();
    }

    function test_VectorFileFormats() public view {
        assertTrue(
            _eq(_str(vm.readFile(PROOFS), ".format"), "abolish-membership-proof-vectors/1"),
            "unknown membership-proof vector format"
        );
        assertTrue(
            _eq(_str(vm.readFile(MEMBERSHIP), ".format"), "abolish-membership-vectors/1"),
            "unknown membership vector format"
        );
        assertTrue(
            _tag(MembershipProofLib.DS_SCOPE) == keccak256("abolish/v1/nullifier-scope"),
            "scope tag"
        );
        assertTrue(
            _tag(MembershipProofLib.DS_VK) == keccak256("abolish/v1/membership-vk"), "vk tag"
        );
    }

    /// The pinned key is the vectors' depth-32 key, and its hash is
    /// `membership_vk_hash`, which an election definition carries.
    function test_PinnedKey() public view {
        string memory json = vm.readFile(PROOFS);
        assertEq(
            vm.parseJsonUint(json, ".verificationKey.depth"), MembershipProofLib.DEPTH, "depth"
        );
        assertEq(
            keccak256(lib.vkEncoding()),
            keccak256(_bytes(json, ".verificationKey.encoding")),
            "vk encoding"
        );
        assertEq(lib.vkEncoding().length, 768, "vk length");
        assertEq(
            MembershipProofLib.ZKEY_SHA256,
            bytes32(_bytes(json, ".verificationKey.zkeySha256")),
            "zkey sha256"
        );
        assertEq(lib.vkHash(), bytes32(_bytes(json, ".verificationKey.hash")), "vk hash");
        assertEq(vm.parseJsonUint(vm.readFile(MEMBERSHIP), ".depth"), 32, "membership depth");
    }

    /// Every proof vector gets the spec's verdict: real, re-randomised and
    /// sparse-tree proofs pass; tampered points and signals, another depth's
    /// key and a hidden subtree fail the pairing; signals at or above `r`
    /// fail before it; and the root-0 proof snarkjs accepts fails.
    function test_ProofVectors() public view {
        string memory json = vm.readFile(PROOFS);
        uint256 i;
        uint256 valid;
        for (; vm.keyExistsJson(json, _proof(i, "")); i++) {
            string memory name = _str(json, _proof(i, ".name"));
            MembershipProofLib.Verdict expected = MembershipProofLib.Verdict.Valid;
            if (!vm.parseJsonBool(json, _proof(i, ".valid"))) {
                expected = _reason(_str(json, _proof(i, ".reason")));
            } else {
                valid++;
            }
            (MembershipProofLib.Verdict got, uint256 offset) =
                lib.check(_bytes(json, _proof(i, ".proof")), _signals(json, _proof(i, ".signals")));
            assertTrue(got == expected, string.concat("verdict for ", name));
            assertEq(offset, 0, string.concat("offset for ", name));
        }
        assertTrue(i == 16 && valid == 3, "proof vector coverage");
    }

    /// Every rejected encoding fails decoding at the offset the vectors'
    /// README gives: B off the twist or outside the subgroup through the
    /// pairing precompile, every other rule by the library's own checks.
    function test_DecodeVectors() public view {
        string memory json = vm.readFile(PROOFS);
        MembershipProofLib.Signals memory honest = _signals(json, ".proofs[0].signals");
        uint256 i;
        for (; vm.keyExistsJson(json, _decode(i, "")); i++) {
            string memory name = _str(json, _decode(i, ".name"));
            (MembershipProofLib.Verdict expected, uint256 at) = _decodeExpected(name);
            (MembershipProofLib.Verdict got, uint256 offset) =
                lib.check(_bytes(json, _decode(i, ".proof")), honest);
            assertTrue(got == expected, string.concat("verdict for ", name));
            assertEq(offset, at, string.concat("offset for ", name));
        }
        assertTrue(i == 12, "decode vector coverage");
    }

    /// `F` and the scope, from the independent implementation, including the
    /// rejected roots and tier in the order the library checks them.
    function test_ScopeAndFieldVectors() public view {
        string memory json = vm.readFile(MEMBERSHIP);
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".fieldMap", i, "")); i++) {
            assertEq(
                lib.field(bytes32(_bytes(json, _at(".fieldMap", i, ".input")))),
                vm.parseUint(_str(json, _at(".fieldMap", i, ".output"))),
                _str(json, _at(".fieldMap", i, ".id"))
            );
        }
        assertTrue(i > 0, "no field vectors");
        uint256 rejected;
        for (i = 0; vm.keyExistsJson(json, _at(".scopes", i, "")); i++) {
            string memory id = _str(json, _at(".scopes", i, ".id"));
            bytes32 definitionHash = bytes32(_bytes(json, _at(".scopes", i, ".definitionHash")));
            uint8 tier = uint8(vm.parseJsonUint(json, _at(".scopes", i, ".tier")));
            uint256 root = uint256(bytes32(_bytes(json, _at(".scopes", i, ".root"))));
            if (vm.keyExistsJson(json, _at(".scopes", i, ".error"))) {
                bytes memory reason =
                    _scopeError(_str(json, _at(".scopes", i, ".error")), tier, root);
                try lib.scopeBytes(definitionHash, tier, root) {
                    revert(string.concat("accepted ", id));
                } catch (bytes memory got) {
                    assertEq(keccak256(got), keccak256(reason), id);
                }
                rejected++;
                continue;
            }
            assertEq(
                lib.scopeBytes(definitionHash, tier, root),
                bytes32(_bytes(json, _at(".scopes", i, ".scope"))),
                id
            );
            assertEq(
                lib.scope(definitionHash, tier, root),
                vm.parseUint(_str(json, _at(".scopes", i, ".scopeField"))),
                id
            );
        }
        assertTrue(i > rejected && rejected == 3, "scope vector coverage");
    }

    /// The proof vectors' own field mappings: each scope from the file's
    /// definition hash, tier and root, and each message's `F`, as Semaphore's
    /// `hash` computed them.
    function test_ProofFieldMappingVectors() public view {
        string memory json = vm.readFile(PROOFS);
        bytes32 definitionHash = bytes32(_bytes(json, ".definitionHash"));
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".fieldMapping", i, "")); i++) {
            string memory v = _at(".fieldMapping", i, "");
            if (vm.keyExistsJson(json, string.concat(v, ".scopeBytes"))) {
                uint8 tier = uint8(vm.parseJsonUint(json, string.concat(v, ".tier")));
                uint256 root = vm.parseUint(_str(json, string.concat(v, ".root")));
                assertEq(
                    lib.scopeBytes(definitionHash, tier, root),
                    bytes32(_bytes(json, string.concat(v, ".scopeBytes"))),
                    "scope bytes"
                );
                assertEq(
                    lib.scope(definitionHash, tier, root),
                    vm.parseUint(_str(json, string.concat(v, ".scope"))),
                    "scope"
                );
            } else {
                assertEq(
                    lib.field(bytes32(_bytes(json, string.concat(v, ".messageBytes")))),
                    vm.parseUint(_str(json, string.concat(v, ".message"))),
                    "message"
                );
            }
        }
        assertTrue(i == 4, "field-mapping vector coverage");
    }

    /// The pairing check costs about 200,000 gas (ADR 0028, Consequences),
    /// and a decode failure is found before any precompile runs.
    function test_Gas() public view {
        string memory json = vm.readFile(PROOFS);
        bytes memory proof = _bytes(json, ".proofs[0].proof");
        MembershipProofLib.Signals memory s = _signals(json, ".proofs[0].signals");
        (MembershipProofLib.Verdict verdict, uint256 used) = lib.checkGas(proof, s);
        assertTrue(verdict == MembershipProofLib.Verdict.Valid, "honest proof");
        assertTrue(used > 181_000 && used < 230_000, "pairing check gas");
        proof[0] ^= 0x01;
        (verdict, used) = lib.checkGas(proof, s);
        assertTrue(verdict == MembershipProofLib.Verdict.NonCanonical, "broken A");
        assertTrue(used < 5_000, "decode failure gas");
    }

    /// With less gas than the pairing is given, the check reverts rather
    /// than let a pairing call that ran out of gas read as a broken `B`.
    function test_InsufficientGasReverts() public {
        string memory json = vm.readFile(PROOFS);
        bytes memory proof = _bytes(json, ".proofs[0].proof");
        MembershipProofLib.Signals memory s = _signals(json, ".proofs[0].signals");
        vm.expectRevert(abi.encodeWithSelector(MembershipProofLib.InsufficientGas.selector));
        lib.check{gas: 600_000}(proof, s);
        (MembershipProofLib.Verdict got,) = lib.check{gas: 700_000}(proof, s);
        assertTrue(got == MembershipProofLib.Verdict.Valid, "enough gas");
    }

    /// The coordinate rules the vectors don't cover on their own: `A.y + p`
    /// and `C.y + p` are refused at their own offsets by the library, before
    /// the precompiles see them (which would refuse `C` only as part of the
    /// pairing, and fail on `A`'s negation), and a `C` off the curve at 192.
    function test_CoordinateRulesAtEachPoint() public view {
        string memory json = vm.readFile(PROOFS);
        MembershipProofLib.Signals memory s = _signals(json, ".proofs[0].signals");
        uint256[3] memory at = [uint256(32), 224, 224];
        uint256[3] memory delta = [MembershipProofLib.P, MembershipProofLib.P, 1];
        uint256[3] memory expected = [uint256(0), 192, 192];
        for (uint256 k; k < 3; k++) {
            bytes memory proof = _bytes(json, ".proofs[0].proof");
            _setWord(proof, at[k], _word(proof, at[k]) + delta[k]);
            (MembershipProofLib.Verdict got, uint256 offset) = lib.check(proof, s);
            assertTrue(got == MembershipProofLib.Verdict.NonCanonical, "coordinate rule");
            assertEq(offset, expected[k], "coordinate rule offset");
        }
    }

    // --- properties -------------------------------------------------------

    /// Flipping any one bit of an honest proof never leaves a valid proof:
    /// the bit lands in a coordinate, and every other point with those
    /// coordinates is either rejected by decoding or fails the pairing.
    function testFuzz_FlippedBitIsRejected(uint16 bit) public view {
        string memory json = vm.readFile(PROOFS);
        bytes memory proof = _bytes(json, ".proofs[0].proof");
        uint256 b = uint256(bit) % (8 * MembershipProofLib.PROOF_LENGTH);
        proof[b / 8] ^= bytes1(uint8(1) << uint8(b % 8));
        assertTrue(
            !_valid(proof, _signals(json, ".proofs[0].signals")), "a flipped bit still verifies"
        );
    }

    /// Changing any one signal of an honest proof's statement makes it fail:
    /// a signal at or above `r` before the pairing, never reduced (T-31).
    function testFuzz_ChangedSignalIsRejected(uint8 which, uint256 value) public view {
        string memory json = vm.readFile(PROOFS);
        MembershipProofLib.Signals memory s = _signals(json, ".proofs[0].signals");
        uint256[4] memory v = [s.root, s.nullifier, s.message, s.scope];
        uint256 k = which % 4;
        vm.assume(value != v[k]);
        v[k] = value;
        MembershipProofLib.Signals memory changed =
            MembershipProofLib.Signals(v[0], v[1], v[2], v[3]);
        (MembershipProofLib.Verdict got,) = lib.check(_bytes(json, ".proofs[0].proof"), changed);
        if (value >= MembershipProofLib.R) {
            assertTrue(got == MembershipProofLib.Verdict.Signal, "unreduced signal");
        } else if (k == 0 && value == 0) {
            assertTrue(got == MembershipProofLib.Verdict.Root, "root 0");
        } else {
            assertTrue(got == MembershipProofLib.Verdict.Pairing, "changed signal");
        }
    }

    /// Arbitrary bytes of any length never verify and never revert: the
    /// check returns a verdict for every input.
    function testFuzz_ArbitraryInputIsRejected(
        bytes calldata proof,
        MembershipProofLib.Signals calldata s
    ) public view {
        (MembershipProofLib.Verdict got,) = lib.check(proof, s);
        assertTrue(got != MembershipProofLib.Verdict.Valid, "arbitrary proof verifies");
    }

    /// Arbitrary 256-byte proofs under the honest statement never verify.
    function testFuzz_ArbitraryProofIsRejected(bytes32[8] calldata words) public view {
        string memory json = vm.readFile(PROOFS);
        bytes memory proof = abi.encodePacked(words);
        assertTrue(!_valid(proof, _signals(json, ".proofs[0].signals")), "arbitrary proof");
    }

    // --- helpers ----------------------------------------------------------

    function _valid(bytes memory proof, MembershipProofLib.Signals memory s)
        internal
        view
        returns (bool)
    {
        (MembershipProofLib.Verdict got,) = lib.check(proof, s);
        return got == MembershipProofLib.Verdict.Valid;
    }

    function _word(bytes memory b, uint256 at) internal pure returns (uint256 w) {
        for (uint256 i; i < 32; i++) {
            w = (w << 8) | uint8(b[at + i]);
        }
    }

    function _setWord(bytes memory b, uint256 at, uint256 w) internal pure {
        for (uint256 i; i < 32; i++) {
            b[at + 31 - i] = bytes1(uint8(w >> (8 * i)));
        }
    }

    function _reason(string memory reason) internal pure returns (MembershipProofLib.Verdict) {
        if (_eq(reason, "proof")) return MembershipProofLib.Verdict.Pairing;
        if (_eq(reason, "signal")) return MembershipProofLib.Verdict.Signal;
        if (_eq(reason, "root")) return MembershipProofLib.Verdict.Root;
        revert(string.concat("unknown reason ", reason));
    }

    /// The decode vectors' errors, as docs/spec/vectors/README.md lists them.
    function _decodeExpected(string memory name)
        internal
        pure
        returns (MembershipProofLib.Verdict, uint256)
    {
        if (_eq(name, "short")) return (MembershipProofLib.Verdict.Truncated, 0);
        if (_eq(name, "long")) return (MembershipProofLib.Verdict.TrailingBytes, 256);
        bytes1 point = bytes(name)[0];
        uint256 at = point == "a" ? 0 : point == "b" ? 64 : point == "c" ? 192 : type(uint256).max;
        if (at == type(uint256).max) revert(string.concat("unknown decode vector ", name));
        return (MembershipProofLib.Verdict.NonCanonical, at);
    }

    function _scopeError(string memory code, uint8 tier, uint256 root)
        internal
        pure
        returns (bytes memory)
    {
        if (_eq(code, "unknown-tier")) {
            return abi.encodeWithSelector(MembershipProofLib.UnknownTier.selector, tier);
        }
        if (_eq(code, "zero-root")) {
            return abi.encodeWithSelector(MembershipProofLib.ZeroRoot.selector);
        }
        if (_eq(code, "non-canonical")) {
            return abi.encodeWithSelector(MembershipProofLib.NonCanonicalRoot.selector, root);
        }
        revert(string.concat("unknown scope error ", code));
    }

    function _signals(string memory json, string memory key)
        internal
        pure
        returns (MembershipProofLib.Signals memory)
    {
        return MembershipProofLib.Signals(
            vm.parseUint(_str(json, string.concat(key, ".root"))),
            vm.parseUint(_str(json, string.concat(key, ".nullifier"))),
            vm.parseUint(_str(json, string.concat(key, ".message"))),
            vm.parseUint(_str(json, string.concat(key, ".scope")))
        );
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

    function _proof(uint256 i, string memory field) internal pure returns (string memory) {
        return _at(".proofs", i, field);
    }

    function _decode(uint256 i, string memory field) internal pure returns (string memory) {
        return _at(".decode", i, field);
    }

    function _at(string memory list, uint256 i, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(list, "[", vm.toString(i), "]", field);
    }

    function _str(string memory json, string memory key) internal pure returns (string memory) {
        return vm.parseJsonString(json, key);
    }

    function _bytes(string memory json, string memory key) internal pure returns (bytes memory) {
        return vm.parseBytes(_str(json, key));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
