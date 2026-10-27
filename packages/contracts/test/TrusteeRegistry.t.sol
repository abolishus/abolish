// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {TrusteeIdentityLib, TrusteeRegistry} from "../src/TrusteeRegistry.sol";
import {DefinitionEncoder, DefinitionHarness} from "./utils/DefinitionHarness.sol";
import {RegistryFixture} from "./utils/RegistryFixture.sol";
import {TrusteeFixture, TrusteeHarness} from "./utils/TrusteeFixture.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// The identity-key, signature and panel rules of
/// docs/spec/trustee-identity.md as the contracts apply them, against
/// docs/spec/vectors/trustee.json (an independent Python implementation):
/// a deployment pins exactly the keys and panels the crypto package accepts,
/// and the signature check accepts exactly the signatures it accepts
/// (T-31, T-37, T-14).
contract TrusteeIdentityVectorsTest is TestBase {
    TrusteeHarness internal lib;

    function setUp() public {
        lib = new TrusteeHarness();
    }

    function test_VectorFileFormatAndTags() public view {
        string memory json = vm.readFile(TrusteeFixture.VECTORS);
        _assertString(json, ".format", "abolish-trustee-vectors/1");
        _assertTag(TrusteeIdentityLib.DS_PANEL, vm.parseJsonString(json, ".tags.panel"));
        // trustee.json's registration tag is the first layout's, retired
        // before any deployment; the registry signs under key-set.json's.
        string memory ks = vm.readFile(TrusteeFixture.KEY_SET_VECTORS);
        _assertString(ks, ".format", "abolish-key-set-vectors/1");
        _assertTag(
            TrusteeIdentityLib.DS_CEREMONY_REGISTRATION,
            vm.parseJsonString(ks, ".tags.registration")
        );
        _assertTag(TrusteeIdentityLib.DS_KEY_SET, vm.parseJsonString(ks, ".tags.keySet"));
        assertTrue(
            keccak256(bytes(vm.parseJsonString(json, ".tags.registration")))
                == keccak256("abolish/v1/sig/ceremony-registration"),
            "frozen tag"
        );
    }

    /// Each 33-byte key vector is accepted with the point it names, or
    /// refused under either root of its `x` (and under `x ≥ p` taken as is);
    /// a deployment refuses every rejected vector, of any length, and pins
    /// every accepted one, the two `x = 0` points included.
    function test_KeyVectors() public {
        string memory json = vm.readFile(TrusteeFixture.VECTORS);
        // A partner seat that is no key vector, so no accepted vector duplicates it.
        bytes memory partner = vm.parseBytes(vm.parseJsonString(json, ".panels[5].keys[0]"));
        (uint256 px, uint256 py,) = TrusteeFixture.point(partner);
        uint256 accepted;
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".keys", i, "")); i++) {
            string memory id = vm.parseJsonString(json, _at(".keys", i, ".id"));
            bytes memory enc = vm.parseBytes(vm.parseJsonString(json, _at(".keys", i, ".encoding")));
            bool valid = !vm.keyExistsJson(json, _at(".keys", i, ".error"));
            (uint256 x, uint256 y, bool onCurve) =
                enc.length >= 33 ? TrusteeFixture.point(enc) : (0, 0, false);
            if (enc.length == 33) {
                assertTrue(lib.keyMatches(enc, x, y) == valid, id);
                if (onCurve) assertTrue(!lib.keyMatches(enc, x, TrusteeFixture.P - y), id);
                if (!valid) assertTrue(!lib.keyMatches(enc, x, 1), id);
            } else {
                assertTrue(!valid, id);
            }

            TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](1);
            panels[0].threshold = 2;
            panels[0].quorum = 2;
            panels[0].kind = 2;
            panels[0].keys = bytes.concat(enc, partner);
            panels[0].points = new uint256[2][](2);
            panels[0].points[0] = [x, y];
            panels[0].points[1] = [px, py];
            if (valid) {
                TrusteeRegistry reg = new TrusteeRegistry(panels);
                (uint256 kx, uint256 ky) = reg.keyOf(reg.panelIds(0), 1);
                assertTrue(kx == x && ky == y, id);
                accepted++;
            } else {
                _expectPanelError(panels, TrusteeRegistry.PanelError.Key);
            }
        }
        assertTrue(accepted >= 11 && accepted < i, "key vector coverage");
    }

    /// Each signature vector verifies exactly when the file says it does.
    /// Those the record can't carry (a key or signature of the wrong length)
    /// are all invalid ones.
    function test_SignatureVectors() public view {
        string memory json = vm.readFile(TrusteeFixture.VECTORS);
        uint256 valid;
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".signatures", i, "")); i++) {
            string memory id = vm.parseJsonString(json, _at(".signatures", i, ".id"));
            bool expected = vm.parseJsonBool(json, _at(".signatures", i, ".valid"));
            bytes memory key =
                vm.parseBytes(vm.parseJsonString(json, _at(".signatures", i, ".key")));
            bytes memory sig =
                vm.parseBytes(vm.parseJsonString(json, _at(".signatures", i, ".signature")));
            bytes32 digest = sha256(_bytes(json, _at(".signatures", i, ".dsMessage")));
            (uint256 x, uint256 y, bool onCurve) = TrusteeFixture.point(key);
            if (key.length != 33 || sig.length != 64 || !onCurve || !lib.keyMatches(key, x, y)) {
                assertTrue(!expected, id);
                continue;
            }
            if (expected) {
                assertEq(digest, _bytes32(json, _at(".signatures", i, ".digest")), id);
                valid++;
            }
            (uint256 r, uint256 s) = abi.decode(sig, (uint256, uint256));
            assertTrue(lib.verify(digest, r, s, x, y) == expected, id);
        }
        assertTrue(valid >= 7 && valid < i, "signature vector coverage");
    }

    /// Under the `precompile` profile the package's test script sets
    /// `EXPECT_P256VERIFY`, and this asserts the EVM really answers at 0x100,
    /// so that run can't silently fall back to OpenZeppelin's Solidity code
    /// and test the same path twice.
    function test_PrecompileAnswersWhenExpected() public view {
        if (!vm.envOr("EXPECT_P256VERIFY", false)) return;
        string memory json = vm.readFile(TrusteeFixture.VECTORS);
        bytes memory key = vm.parseBytes(vm.parseJsonString(json, ".signatures[0].key"));
        (uint256 x, uint256 y,) = TrusteeFixture.point(key);
        bytes memory sig = vm.parseBytes(vm.parseJsonString(json, ".signatures[0].signature"));
        bytes32 digest = _bytes32(json, ".signatures[0].digest");
        (bool ok, bytes memory ret) = address(0x100).staticcall(abi.encodePacked(digest, sig, x, y));
        assertTrue(ok && ret.length == 32 && uint256(bytes32(ret)) == 1, "no P256VERIFY");
    }

    /// Each panel vector: deployed with its identifier, or refused with the
    /// code the file gives (size, threshold, key, duplicate-key), in the
    /// spec's order.
    function test_PanelVectors() public {
        string memory json = vm.readFile(TrusteeFixture.VECTORS);
        uint256 i;
        uint256 refused;
        for (; vm.keyExistsJson(json, _at(".panels", i, "")); i++) {
            string memory id = vm.parseJsonString(json, _at(".panels", i, ".id"));
            uint8 k = uint8(vm.parseJsonUint(json, _at(".panels", i, ".threshold")));
            TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](1);
            panels[0] = TrusteeFixture.panel(json, id, k);
            if (vm.keyExistsJson(json, _at(".panels", i, ".error"))) {
                _expectPanelError(
                    panels, _panelError(vm.parseJsonString(json, _at(".panels", i, ".error")))
                );
                refused++;
                continue;
            }
            bytes32 expected = _bytes32(json, _at(".panels", i, ".panelId"));
            assertEq(lib.panelId(k, uint8(panels[0].points.length), panels[0].keys), expected, id);
            TrusteeRegistry reg = new TrusteeRegistry(panels);
            assertEq(reg.panelIds(0), expected, id);
            (uint8 threshold, uint8 size, uint8 quorum) = reg.panelOf(expected);
            assertTrue(threshold == k && quorum == k && size == panels[0].points.length, id);
        }
        assertTrue(refused > 0 && refused < i, "panel vector coverage");
    }

    /// Each key set of key-set.json hashes, from the seats a registration
    /// carries, to the file's `key_set_hash`, and each seat's point is the
    /// one its `p256-key` encodes.
    function test_KeySetVectors() public view {
        string memory ks = vm.readFile(TrusteeFixture.KEY_SET_VECTORS);
        uint256 i;
        for (; vm.keyExistsJson(ks, _at(".keySets", i, "")); i++) {
            string memory id = vm.parseJsonString(ks, _at(".keySets", i, ".id"));
            TrusteeFixture.Seat[] memory seats = TrusteeFixture.keySet(ks, id);
            assertEq(
                lib.keySetHash(TrusteeFixture.seatBytes(seats)),
                _bytes32(ks, _at(".keySets", i, ".keySetHash")),
                id
            );
            for (uint256 k; k < seats.length; k++) {
                bytes memory enc = vm.parseBytes(
                    vm.parseJsonString(
                        ks,
                        string.concat(
                            _at(".keySets", i, ".entries"), "[", vm.toString(k), "].signingKey"
                        )
                    )
                );
                assertTrue(lib.keyMatches(enc, seats[k].x, seats[k].y), id);
            }
        }
        assertTrue(i >= 6, "key set vector coverage");
    }

    /// Each statement of key-set.json is the 157-byte layout, its digest is
    /// what the registry signs over, and its signature verifies under the
    /// seat's key and nowhere else.
    function test_StatementVectors() public view {
        string memory ks = vm.readFile(TrusteeFixture.KEY_SET_VECTORS);
        uint256 i;
        for (; vm.keyExistsJson(ks, _at(".statements", i, "")); i++) {
            _checkStatement(ks, i);
        }
        assertTrue(i >= 5, "statement vector coverage");
    }

    struct Statement {
        string id;
        uint64 chainId;
        address registry;
        bytes32 panel;
        uint8 index;
        bytes32 stub;
        bytes32 transcript;
        bytes32 keySetHash;
    }

    function _checkStatement(string memory ks, uint256 i) internal view {
        string memory json = vm.readFile(TrusteeFixture.VECTORS);
        Statement memory v;
        v.id = vm.parseJsonString(ks, _at(".statements", i, ".id"));
        TrusteeRegistry.PanelInput memory p =
            TrusteeFixture.panel(json, vm.parseJsonString(ks, _at(".statements", i, ".panel")), 4);
        v.panel = lib.panelId(p.threshold, uint8(p.points.length), p.keys);
        v.chainId =
            uint64(vm.parseUint(vm.parseJsonString(ks, _at(".statements", i, ".l2ChainId"))));
        v.registry = address(bytes20(_bytes(ks, _at(".statements", i, ".trusteeRegistry"))));
        v.index = uint8(vm.parseJsonUint(ks, _at(".statements", i, ".index")));
        v.stub = _bytes32(ks, _at(".statements", i, ".stubHash"));
        v.transcript = _bytes32(ks, _at(".statements", i, ".ceremonyTranscriptHash"));
        v.keySetHash = _bytes32(ks, _at(".statements", i, ".keySetHash"));
        // The key set named is the one whose hash the statement carries.
        TrusteeFixture.Seat[] memory seats =
            TrusteeFixture.keySet(ks, vm.parseJsonString(ks, _at(".statements", i, ".keySet")));
        assertEq(lib.keySetHash(TrusteeFixture.seatBytes(seats)), v.keySetHash, v.id);

        bytes memory message = _bytes(ks, _at(".statements", i, ".message"));
        assertEq(message.length, 157, v.id);
        assertTrue(
            keccak256(message)
                == keccak256(
                    abi.encodePacked(
                        v.chainId, v.registry, v.panel, v.index, v.stub, v.transcript, v.keySetHash
                    )
                ),
            v.id
        );
        bytes32 digest = lib.registrationDigest(
            v.chainId, v.registry, v.panel, v.index, v.stub, v.transcript, v.keySetHash
        );
        assertEq(digest, _bytes32(ks, _at(".statements", i, ".digest")), v.id);
        assertEq(
            digest, sha256(bytes.concat(TrusteeIdentityLib.DS_CEREMONY_REGISTRATION, message)), v.id
        );

        _checkStatementSignature(
            v, digest, _bytes(ks, _at(".statements", i, ".signature")), p.points
        );
    }

    /// The statement's signature verifies under its seat's key, and not
    /// under another seat's, for another registry or over another key set.
    function _checkStatementSignature(
        Statement memory v,
        bytes32 digest,
        bytes memory sig,
        uint256[2][] memory points
    ) internal view {
        (uint256 r, uint256 s) = abi.decode(sig, (uint256, uint256));
        uint256[2] memory q = points[v.index - 1];
        assertTrue(lib.verify(digest, r, s, q[0], q[1]), v.id);
        uint256[2] memory other = points[v.index % points.length];
        assertTrue(!lib.verify(digest, r, s, other[0], other[1]), v.id);
        assertTrue(!lib.verify(_digestOf(v, address(0x5EC0), v.keySetHash), r, s, q[0], q[1]), v.id);
        bytes32 otherSet = keccak256(abi.encode(v.keySetHash));
        assertTrue(!lib.verify(_digestOf(v, v.registry, otherSet), r, s, q[0], q[1]), v.id);
    }

    function _digestOf(Statement memory v, address registry, bytes32 keySetHash)
        internal
        view
        returns (bytes32)
    {
        return lib.registrationDigest(
            v.chainId, registry, v.panel, v.index, v.stub, v.transcript, keySetHash
        );
    }

    function _expectPanelError(
        TrusteeRegistry.PanelInput[] memory panels,
        TrusteeRegistry.PanelError reason
    ) internal {
        try new TrusteeRegistry(panels) {
            revert("panel accepted");
        } catch (bytes memory ret) {
            assertTrue(
                keccak256(ret)
                    == keccak256(
                        abi.encodeWithSelector(TrusteeRegistry.InvalidPanel.selector, 0, reason)
                    ),
                "unexpected panel error"
            );
        }
    }

    function _panelError(string memory code) internal pure returns (TrusteeRegistry.PanelError) {
        bytes32 c = keccak256(bytes(code));
        if (c == keccak256("size")) return TrusteeRegistry.PanelError.Size;
        if (c == keccak256("threshold")) return TrusteeRegistry.PanelError.Threshold;
        if (c == keccak256("key")) return TrusteeRegistry.PanelError.Key;
        if (c == keccak256("duplicate-key")) return TrusteeRegistry.PanelError.DuplicateKey;
        revert(string.concat("unknown panel error ", code));
    }

    function _assertString(string memory json, string memory key, string memory expected)
        internal
        pure
    {
        assertTrue(
            keccak256(bytes(vm.parseJsonString(json, key))) == keccak256(bytes(expected)), key
        );
    }

    function _assertTag(bytes memory prefix, string memory tag) internal pure {
        assertEq(uint8(prefix[0]), prefix.length - 1, "length byte");
        assertEq(prefix.length - 1, bytes(tag).length, "tag length");
        for (uint256 i; i < bytes(tag).length; i++) {
            assertTrue(prefix[i + 1] == bytes(tag)[i], "tag");
        }
    }

    function _at(string memory list, uint256 i, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(list, "[", vm.toString(i), "]", field);
    }

    function _bytes(string memory json, string memory key) internal pure returns (bytes memory) {
        string memory h = vm.parseJsonString(json, key);
        // The vectors write empty bytes as "", which parseBytes refuses.
        return bytes(h).length == 0 ? bytes("") : vm.parseBytes(h);
    }

    function _bytes32(string memory json, string memory key) internal pure returns (bytes32) {
        bytes memory b = _bytes(json, key);
        assertEq(b.length, 32, "expected 32 bytes");
        return bytes32(b);
    }
}

/// The trustee registry of docs/spec/contracts.md (Trustee registry): its
/// deployment checks, each refusal of a registration, write-once recording
/// and the answer the election registry gets (T-71, T-37, T-14, T-17, T-25).
contract TrusteeRegistryTest is TestBase {
    bytes32 internal constant STUB = keccak256("stub");
    bytes32 internal constant TRANSCRIPT = keccak256("transcript");

    string internal json;
    string internal keySets;
    TrusteeHarness internal lib;
    TrusteeRegistry internal registry;
    bytes32 internal panel;
    uint256[8] internal secrets;

    function setUp() public {
        json = vm.readFile(TrusteeFixture.VECTORS);
        keySets = vm.readFile(TrusteeFixture.KEY_SET_VECTORS);
        lib = new TrusteeHarness();
        for (uint8 seat = 1; seat <= 7; seat++) {
            secrets[seat] = TrusteeFixture.secret(json, seat);
        }
        TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](1);
        panels[0] = TrusteeFixture.panel(json, "panel-4-of-7", 4);
        registry = new TrusteeRegistry(panels);
        panel = registry.panelIds(0);
    }

    // --- deployment --------------------------------------------------------------

    function test_DeploymentPinsPanelsAndLogsThem() public {
        TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](2);
        panels[0] = TrusteeFixture.panel(json, "panel-4-of-7", 5);
        panels[1] = TrusteeFixture.panel(json, "panel-2-of-2", 2);
        panels[1].kind = 1;
        vm.recordLogs();
        TrusteeRegistry reg = new TrusteeRegistry(panels);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(reg.panelCount(), 2, "count");
        assertEq(logs.length, 2, "one log per panel");
        for (uint256 i; i < 2; i++) {
            bytes32 id = reg.panelIds(i);
            assertEq(logs[i].topics.length, 2, "topics");
            assertEq(logs[i].topics[0], TrusteeRegistry.PanelPinned.selector, "topic 0");
            assertEq(logs[i].topics[1], id, "panel topic");
            assertTrue(
                keccak256(logs[i].data)
                    == keccak256(
                        abi.encode(
                            panels[i].threshold, panels[i].quorum, panels[i].kind, panels[i].keys
                        )
                    ),
                "data"
            );
            assertEq(reg.kindOf(id), panels[i].kind, "kind");
            for (uint256 s; s < panels[i].points.length; s++) {
                (uint256 x, uint256 y) = reg.keyOf(id, s + 1);
                assertTrue(x == panels[i].points[s][0] && y == panels[i].points[s][1], "key");
            }
            (uint256 zx, uint256 zy) = reg.keyOf(id, 0);
            assertTrue(zx == 0 && zy == 0, "no seat 0");
        }
        (,, uint8 quorum) = reg.panelOf(reg.panelIds(0));
        assertEq(quorum, 5, "quorum");
        _assertAccumulated(reg, logs);
    }

    /// Check 7: a panel's kind is 1 (`independent`) or 2 (`transitional`),
    /// stored for `kindOf`, which is 0 for a panel the registry doesn't pin
    /// (contracts.md, Trustee registry, Deployment, The kind; T-14).
    function test_DeploymentPinsEachKind() public {
        for (uint8 kind = 1; kind <= 2; kind++) {
            TrusteeRegistry.PanelInput[] memory panels = _withQuorum(4);
            panels[0].kind = kind;
            TrusteeRegistry reg = new TrusteeRegistry(panels);
            assertEq(reg.kindOf(reg.panelIds(0)), kind, "kind");
            assertEq(reg.kindOf(bytes32(0)), 0, "no panel");
            assertEq(reg.kindOf(panel), kind, "same panel, another deployment");
        }
        assertEq(registry.kindOf(keccak256("not pinned")), 0, "not pinned");
    }

    /// Kinds 0 and 3 to 255 are refused at the panel's position, after the
    /// quorum and duplicate-panel checks; a kind word above 255 isn't a
    /// `uint8`, so the constructor's decoder refuses it before any check,
    /// even when its low byte is a valid kind.
    function testFuzz_DeploymentRefusesOtherKinds(uint8 kind) public {
        vm.assume(kind != 1 && kind != 2);
        TrusteeRegistry.PanelInput[] memory panels = _withQuorum(4);
        panels[0].kind = kind;
        _expectPanelError(panels, 0, TrusteeRegistry.PanelError.Kind);
    }

    function test_DeploymentRefusesKindsZeroThreeAnd256() public {
        uint8[2] memory small = [0, 3];
        for (uint256 i; i < 2; i++) {
            TrusteeRegistry.PanelInput[] memory panels = _withQuorum(4);
            panels[0].kind = small[i];
            _expectPanelError(panels, 0, TrusteeRegistry.PanelError.Kind);
        }
        // `kind` is the third word of the panel's tuple (threshold, quorum,
        // kind, keys' offset, points' offset), after the array's offset,
        // length and the tuple's own offset.
        bytes memory args = abi.encode(_withQuorum(4));
        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(args, add(0x20, 0xa0)))
        }
        assertEq(word, 2, "the kind's word");
        uint256[2] memory words = [uint256(256), 258];
        for (uint256 i; i < 2; i++) {
            bytes memory wide = bytes.concat(args);
            assembly ("memory-safe") {
                mstore(add(wide, add(0x20, 0xa0)), mload(add(words, mul(i, 0x20))))
            }
            bytes memory code = bytes.concat(type(TrusteeRegistry).creationCode, wide);
            address created;
            assembly ("memory-safe") {
                created := create(0, add(code, 0x20), mload(code))
            }
            assertTrue(created == address(0), "kind word above 255 accepted");
        }
        // The same bytes with kind 2 in that word deploy.
        bytes memory honest = bytes.concat(type(TrusteeRegistry).creationCode, args);
        address ok;
        assembly ("memory-safe") {
            ok := create(0, add(honest, 0x20), mload(honest))
        }
        assertTrue(ok != address(0), "honest arguments refused");
    }

    /// Check 7 runs after the quorum (5) and duplicate-panel (6) checks.
    function test_DeploymentChecksTheKindLast() public {
        TrusteeRegistry.PanelInput[] memory panels = _withQuorum(3);
        panels[0].kind = 0;
        _expectPanelError(panels, 0, TrusteeRegistry.PanelError.Quorum);
        panels = new TrusteeRegistry.PanelInput[](2);
        panels[0] = TrusteeFixture.panel(json, "panel-4-of-7", 4);
        panels[1] = TrusteeFixture.panel(json, "panel-4-of-7", 5);
        panels[1].kind = 0;
        _expectPanelError(panels, 1, TrusteeRegistry.PanelError.DuplicatePanel);
        // Another kind doesn't make another panel either.
        panels[1].kind = 1;
        _expectPanelError(panels, 1, TrusteeRegistry.PanelError.DuplicatePanel);
    }

    function test_DeploymentRefusesNoPanels() public {
        try new TrusteeRegistry(new TrusteeRegistry.PanelInput[](0)) {
            revert("accepted");
        } catch (bytes memory ret) {
            assertTrue(
                keccak256(ret)
                    == keccak256(abi.encodeWithSelector(TrusteeRegistry.NoPanels.selector)),
                "error"
            );
        }
    }

    function test_DeploymentRefusesQuorumOutsideThresholdAndSize() public {
        _expectPanelError(_withQuorum(3), 0, TrusteeRegistry.PanelError.Quorum);
        _expectPanelError(_withQuorum(8), 0, TrusteeRegistry.PanelError.Quorum);
        new TrusteeRegistry(_withQuorum(4));
        new TrusteeRegistry(_withQuorum(7));
    }

    function test_DeploymentRefusesTheSamePanelTwice() public {
        TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](2);
        panels[0] = TrusteeFixture.panel(json, "panel-4-of-7", 4);
        // Another quorum doesn't make it another panel.
        panels[1] = TrusteeFixture.panel(json, "panel-4-of-7", 5);
        _expectPanelError(panels, 1, TrusteeRegistry.PanelError.DuplicatePanel);
    }

    function test_DeploymentRefusesCoordinatesThatAreNotTheKey() public {
        // The other root of x: the encoding's parity bit no longer matches.
        TrusteeRegistry.PanelInput[] memory panels = _withQuorum(4);
        panels[0].points[2][1] = TrusteeFixture.P - panels[0].points[2][1];
        _expectPanelError(panels, 0, TrusteeRegistry.PanelError.Key);
        // Another seat's point.
        panels = _withQuorum(4);
        panels[0].points[2] = panels[0].points[3];
        _expectPanelError(panels, 0, TrusteeRegistry.PanelError.Key);
        // One point fewer than keys, and one more.
        panels = _withQuorum(4);
        uint256[2][] memory fewer = new uint256[2][](6);
        for (uint256 i; i < 6; i++) {
            fewer[i] = panels[0].points[i];
        }
        panels[0].points = fewer;
        _expectPanelError(panels, 0, TrusteeRegistry.PanelError.Key);
    }

    // --- registration --------------------------------------------------------------

    function test_RegistersWithAQuorum() public {
        bytes memory reg = _registration(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        vm.recordLogs();
        registry.registerCeremony(reg);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(registry.transcriptOf(STUB, panel), TRANSCRIPT, "stored");
        assertTrue(registry.ceremonyRecorded(STUB, TRANSCRIPT, panel, 4, 7), "recorded");
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics.length, 4, "topics");
        assertEq(logs[0].topics[0], TrusteeRegistry.CeremonyRegistered.selector, "topic 0");
        assertEq(logs[0].topics[1], STUB, "stub topic");
        assertEq(logs[0].topics[2], panel, "panel topic");
        assertEq(logs[0].topics[3], TRANSCRIPT, "transcript topic");
        assertTrue(keccak256(logs[0].data) == keccak256(abi.encode(reg)), "data");
        // The panel log came first, at deployment.
        (, uint64 count) = registry.eventAccumulator();
        assertEq(count, 2, "accumulator count");
    }

    function test_RegistersWithEverySeatAndAnyQuorumSubset() public {
        registry.registerCeremony(_registration(STUB, TRANSCRIPT, _range(1, 7)));
        registry.registerCeremony(_registration(keccak256("b"), TRANSCRIPT, _seats(2, 4, 6, 7)));
        assertTrue(registry.ceremonyRecorded(keccak256("b"), TRANSCRIPT, panel, 4, 7), "subset");
    }

    function test_AnyoneMaySubmit() public {
        vm.prank(address(0xBEEF));
        registry.registerCeremony(_registration(STUB, TRANSCRIPT, _seats(1, 3, 5, 7)));
        assertTrue(registry.ceremonyRecorded(STUB, TRANSCRIPT, panel, 4, 7), "recorded");
    }

    function test_RefusesBelowQuorum() public {
        _expectRefused(
            _registration(STUB, TRANSCRIPT, _range(1, 3)),
            abi.encodeWithSelector(TrusteeRegistry.BelowQuorum.selector, 3, 4)
        );
        // A quorum above the threshold is the one that counts.
        TrusteeRegistry strict = new TrusteeRegistry(_withQuorum(6));
        bytes memory five = _registrationFor(strict, STUB, TRANSCRIPT, _range(1, 5));
        (bool ok, bytes memory ret) =
            address(strict).call(abi.encodeCall(TrusteeRegistry.registerCeremony, (five)));
        _assertRefused(ok, ret, abi.encodeWithSelector(TrusteeRegistry.BelowQuorum.selector, 5, 6));
        strict.registerCeremony(_registrationFor(strict, STUB, TRANSCRIPT, _range(1, 6)));
    }

    /// One seat counts once: repeating a seat, even with a second valid
    /// signature of its own (another nonce), never makes a quorum (T-14).
    function test_RefusesRepeatedOrUnorderedSeats() public {
        TrusteeFixture.Approval[] memory a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        TrusteeFixture.Approval[] memory twice = new TrusteeFixture.Approval[](4);
        twice[0] = a[0];
        twice[1] = a[1];
        twice[2] = a[2];
        // Seat 3 again, with its own valid signature.
        twice[3] = TrusteeFixture.Approval(3, a[2].r, a[2].s);
        _expectRefused(
            _encode(panel, STUB, TRANSCRIPT, twice),
            abi.encodeWithSelector(TrusteeRegistry.SeatsOutOfOrder.selector, 3)
        );
        TrusteeFixture.Approval[] memory swapped = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        (swapped[1], swapped[2]) = (swapped[2], swapped[1]);
        _expectRefused(
            _encode(panel, STUB, TRANSCRIPT, swapped),
            abi.encodeWithSelector(TrusteeRegistry.SeatsOutOfOrder.selector, 2)
        );
    }

    function test_RefusesSeatsOutsideThePanel() public {
        TrusteeFixture.Approval[] memory a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        a[0].index = 0;
        _expectRefused(
            _encode(panel, STUB, TRANSCRIPT, a),
            abi.encodeWithSelector(TrusteeRegistry.SeatsOutOfOrder.selector, 0)
        );
        a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        a[3].index = 8;
        _expectRefused(
            _encode(panel, STUB, TRANSCRIPT, a),
            abi.encodeWithSelector(TrusteeRegistry.SeatsOutOfOrder.selector, 8)
        );
    }

    function test_RefusesSignaturesThatDontVerify() public {
        // A seat's signature claimed for another seat.
        TrusteeFixture.Approval[] memory a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        (a[1].r, a[1].s) = (a[0].r, a[0].s);
        _expectInvalidSignature(a, 2);
        // A signature on another stub, another transcript, another panel.
        a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        TrusteeFixture.Approval[] memory other = _approvals(keccak256("x"), TRANSCRIPT, _seats(4));
        a[3] = other[0];
        _expectInvalidSignature(a, 4);
        a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        other = _approvals(STUB, keccak256("x"), _seats(1));
        a[0] = other[0];
        _expectInvalidSignature(a, 1);
        // The high-s twin of a valid signature, and the range rules.
        a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        a[2].s = TrusteeIdentityLib.N - a[2].s;
        _expectInvalidSignature(a, 3);
        a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        a[2].r = 0;
        _expectInvalidSignature(a, 3);
        a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        a[2].r = TrusteeIdentityLib.N;
        _expectInvalidSignature(a, 3);
        a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        a[2].s = 0;
        _expectInvalidSignature(a, 3);
        // Every approval must verify, even beyond the quorum.
        a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4, 5));
        a[4].s ^= 1;
        _expectInvalidSignature(a, 5);
    }

    /// A signature made for this registry on another chain, or for another
    /// registry, doesn't count here (trustee-identity.md, Ceremony registration).
    function test_RefusesSignaturesForAnotherChainOrRegistry() public {
        uint64[2] memory chains = [uint64(block.chainid) + 1, uint64(block.chainid)];
        address[2] memory registries = [address(registry), address(0x5EC0)];
        bytes32 keySetHash = lib.keySetHash(TrusteeFixture.seatBytes(_keySetFor(registry, panel)));
        for (uint256 c; c < 2; c++) {
            uint8[] memory seats = _seats(1, 2, 3, 4);
            TrusteeFixture.Approval[] memory a = new TrusteeFixture.Approval[](4);
            for (uint256 i; i < 4; i++) {
                bytes32 digest = TrusteeIdentityLib.registrationDigest(
                    chains[c], registries[c], panel, seats[i], STUB, TRANSCRIPT, keySetHash
                );
                (uint256 r, uint256 s) = TrusteeFixture.sign(secrets[seats[i]], digest);
                a[i] = TrusteeFixture.Approval(seats[i], r, s);
            }
            _expectInvalidSignature(a, 1);
        }
    }

    function test_RecordsOneTranscriptPerStubAndPanel() public {
        registry.registerCeremony(_registration(STUB, TRANSCRIPT, _range(1, 4)));
        bytes memory again = _registration(STUB, TRANSCRIPT, _range(4, 7));
        bytes memory second = _registration(STUB, keccak256("second"), _range(4, 7));
        bytes memory refusal =
            abi.encodeWithSelector(TrusteeRegistry.AlreadyRecorded.selector, STUB, panel);
        _expectRefused(again, refusal);
        _expectRefused(second, refusal);
        assertEq(registry.transcriptOf(STUB, panel), TRANSCRIPT, "unchanged");
        assertTrue(!registry.ceremonyRecorded(STUB, keccak256("second"), panel, 4, 7), "second");
        // A transcript hash may repeat across stubs.
        registry.registerCeremony(_registration(keccak256("other"), TRANSCRIPT, _range(1, 4)));
    }

    /// A stub is recorded per panel, so a quorum of another pinned panel
    /// can't block the panel a stub names by registering first.
    function test_PanelsDontBlockEachOther() public {
        TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](2);
        panels[0] = TrusteeFixture.panel(json, "panel-2-of-2", 2);
        panels[1] = TrusteeFixture.panel(json, "panel-4-of-7", 4);
        TrusteeRegistry two = new TrusteeRegistry(panels);
        bytes32 small = two.panelIds(0);
        two.registerCeremony(
            TrusteeFixture.encode(
                small,
                STUB,
                keccak256("theirs"),
                _keySetFor(two, small),
                _approvalsFor(two, small, STUB, keccak256("theirs"), _range(1, 2))
            )
        );
        two.registerCeremony(_registrationFor(two, STUB, TRANSCRIPT, _range(1, 4)));
        assertTrue(two.ceremonyRecorded(STUB, TRANSCRIPT, two.panelIds(1), 4, 7), "big");
        assertTrue(two.ceremonyRecorded(STUB, keccak256("theirs"), small, 2, 2), "small");
        assertTrue(!two.ceremonyRecorded(STUB, TRANSCRIPT, small, 2, 2), "not crossed");
    }

    function test_RefusesUnknownPanelAndZeroTranscript() public {
        TrusteeFixture.Approval[] memory a = _approvals(STUB, TRANSCRIPT, _range(1, 4));
        bytes32 unknown = keccak256("panel");
        _expectRefused(
            _encode(unknown, STUB, TRANSCRIPT, a),
            abi.encodeWithSelector(TrusteeRegistry.UnknownPanel.selector, unknown)
        );
        _expectRefused(
            _registration(STUB, bytes32(0), _range(1, 4)),
            abi.encodeWithSelector(TrusteeRegistry.ZeroTranscriptHash.selector)
        );
    }

    function test_RefusesMalformedRecords() public {
        bytes memory reg = _registration(STUB, TRANSCRIPT, _range(1, 4));
        bytes memory malformed =
            abi.encodeWithSelector(TrusteeRegistry.MalformedRegistration.selector);
        _expectRefused(_slice(reg, 0, 96), malformed);
        _expectRefused(_slice(reg, 0, reg.length - 1), malformed);
        _expectRefused(bytes.concat(reg, hex"00"), malformed);
        // The approvals' count, after the 7 key-set seats.
        bytes memory moreCounted = bytes.concat(reg);
        moreCounted[97 + 97 * 7] = bytes1(uint8(5));
        _expectRefused(moreCounted, malformed);
        // The key set's count, one more (the record ends inside the seats
        // and approvals it then reads) and one fewer.
        bytes memory moreSeats = bytes.concat(reg);
        moreSeats[96] = bytes1(uint8(8));
        _expectRefused(moreSeats, malformed);
        bytes memory fewerSeats = bytes.concat(reg);
        fewerSeats[96] = bytes1(uint8(6));
        _expectRefused(fewerSeats, malformed);
        // A count of seats the record can't hold before its approvals' count.
        bytes memory header = _slice(reg, 0, 97);
        header[96] = bytes1(uint8(1));
        _expectRefused(bytes.concat(header, new bytes(97)), malformed);
        _expectRefused("", malformed);
    }

    // --- the key set -------------------------------------------------------------

    /// The registry records the key set's hash (the one key-set.json gives,
    /// and every approval signed), its seats and each one's signing key.
    function test_RecordsTheKeySet() public {
        string[2] memory ids = ["key-set-7", "key-set-gaps"];
        for (uint256 v; v < 2; v++) {
            bytes32 stub = keccak256(abi.encode("stub", v));
            TrusteeFixture.Seat[] memory ks = TrusteeFixture.keySet(keySets, ids[v]);
            registry.registerCeremony(
                TrusteeFixture.encode(panel, stub, TRANSCRIPT, ks, _signed(stub, ks, _range(1, 4)))
            );
            (bytes32 h, uint256 mask) = registry.keySetOf(stub, panel);
            assertEq(h, _keySetHash(ids[v]), ids[v]);
            uint256 expected;
            for (uint256 i; i < ks.length; i++) {
                expected |= 1 << ks[i].index;
                (uint256 x, uint256 y) = registry.signingKeyOf(stub, panel, ks[i].index);
                assertTrue(x == ks[i].x && y == ks[i].y, "signing key");
            }
            assertEq(mask, expected, "seats");
            for (uint256 seat; seat <= 8; seat++) {
                if (expected & (1 << seat) != 0) continue;
                (uint256 x, uint256 y) = registry.signingKeyOf(stub, panel, seat);
                assertTrue(x == 0 && y == 0, "no key outside the set");
            }
        }
        (bytes32 none, uint256 noSeats) = registry.keySetOf(keccak256("unrecorded"), panel);
        assertTrue(none == bytes32(0) && noSeats == 0, "unrecorded");
    }

    /// An approving seat needn't be in the key set: a seat the transcript
    /// check disqualified can still have checked the transcript.
    function test_ApproversNeedNotBeInTheKeySet() public {
        TrusteeFixture.Seat[] memory ks = TrusteeFixture.keySet(keySets, "key-set-gaps");
        registry.registerCeremony(
            TrusteeFixture.encode(
                panel, STUB, TRANSCRIPT, ks, _signed(STUB, ks, _seats(3, 4, 5, 6))
            )
        );
        assertTrue(registry.ceremonyRecorded(STUB, TRANSCRIPT, panel, 4, 7), "recorded");
    }

    /// Approvals over another key set's hash don't count for this one, so
    /// a set no quorum signed is never recorded (T-37, T-14).
    function test_RefusesApprovalsOfAnotherKeySet() public {
        TrusteeFixture.Seat[] memory signed = TrusteeFixture.keySet(keySets, "key-set-gaps");
        TrusteeFixture.Seat[] memory sent = TrusteeFixture.keySet(keySets, "key-set-7");
        _expectRefused(
            TrusteeFixture.encode(
                panel, STUB, TRANSCRIPT, sent, _signed(STUB, signed, _range(1, 4))
            ),
            abi.encodeWithSelector(TrusteeRegistry.InvalidSignature.selector, 1)
        );
        // Dropping a seat, or changing one's KEM-key hash, is another set.
        TrusteeFixture.Seat[] memory ks = TrusteeFixture.keySet(keySets, "key-set-7");
        TrusteeFixture.Approval[] memory a = _signed(STUB, ks, _range(1, 4));
        ks[3].kemKeyHash = keccak256("another KEM key");
        _expectRefused(
            TrusteeFixture.encode(panel, STUB, TRANSCRIPT, ks, a),
            abi.encodeWithSelector(TrusteeRegistry.InvalidSignature.selector, 1)
        );
        ks = TrusteeFixture.keySet(keySets, "key-set-7");
        _expectRefused(
            TrusteeFixture.encode(panel, STUB, TRANSCRIPT, _drop(ks, 6), a),
            abi.encodeWithSelector(TrusteeRegistry.InvalidSignature.selector, 1)
        );
    }

    function test_RefusesAKeySetBelowTheThreshold() public {
        TrusteeFixture.Seat[] memory ks = _drop(_drop(_drop(_drop(_set7(), 6), 5), 4), 3);
        _expectKeySetRefused(
            ks, abi.encodeWithSelector(TrusteeRegistry.KeySetTooSmall.selector, 3, 4)
        );
        _expectKeySetRefused(
            new TrusteeFixture.Seat[](0),
            abi.encodeWithSelector(TrusteeRegistry.KeySetTooSmall.selector, 0, 4)
        );
    }

    function test_RefusesKeySetSeatsOutOfOrder() public {
        TrusteeFixture.Seat[] memory ks = _set7();
        (ks[1], ks[2]) = (ks[2], ks[1]);
        _expectKeySetRefused(
            ks, abi.encodeWithSelector(TrusteeRegistry.KeySetSeatsOutOfOrder.selector, 2)
        );
        ks = _set7();
        ks[2].index = 2;
        _expectKeySetRefused(
            ks, abi.encodeWithSelector(TrusteeRegistry.KeySetSeatsOutOfOrder.selector, 2)
        );
        ks = _set7();
        ks[0].index = 0;
        _expectKeySetRefused(
            ks, abi.encodeWithSelector(TrusteeRegistry.KeySetSeatsOutOfOrder.selector, 0)
        );
        ks = _set7();
        ks[6].index = 8;
        _expectKeySetRefused(
            ks, abi.encodeWithSelector(TrusteeRegistry.KeySetSeatsOutOfOrder.selector, 8)
        );
    }

    function test_RefusesSigningKeysThatAreNotPoints() public {
        TrusteeFixture.Seat[] memory ks = _set7();
        ks[2].y = TrusteeFixture.P - ks[2].y + 1;
        _expectKeySetRefused(
            ks, abi.encodeWithSelector(TrusteeRegistry.InvalidSigningKey.selector, 3)
        );
        // A coordinate at p is never reduced.
        ks = _set7();
        ks[2].x = TrusteeFixture.P;
        _expectKeySetRefused(
            ks, abi.encodeWithSelector(TrusteeRegistry.InvalidSigningKey.selector, 3)
        );
        ks = _set7();
        (ks[4].x, ks[4].y) = (0, 0);
        _expectKeySetRefused(
            ks, abi.encodeWithSelector(TrusteeRegistry.InvalidSigningKey.selector, 5)
        );
    }

    /// One key never signs for two seats, and an identity key never signs as
    /// a per-election key (trustee-identity.md, Which key signs what; T-37).
    function test_RefusesRepeatedOrIdentitySigningKeys() public {
        TrusteeFixture.Seat[] memory ks = _set7();
        (ks[5].x, ks[5].y) = (ks[1].x, ks[1].y);
        _expectKeySetRefused(
            ks, abi.encodeWithSelector(TrusteeRegistry.DuplicateSigningKey.selector, 6)
        );
        // Any seat's identity key, its own or another's.
        for (uint256 seat = 1; seat <= 7; seat++) {
            ks = _set7();
            (ks[3].x, ks[3].y) = registry.keyOf(panel, seat);
            _expectKeySetRefused(
                ks, abi.encodeWithSelector(TrusteeRegistry.DuplicateSigningKey.selector, 4)
            );
        }
        // The point's other root is another key: a valid, distinct point.
        ks = _set7();
        ks[5].y = TrusteeFixture.P - ks[1].y;
        ks[5].x = ks[1].x;
        registry.registerCeremony(
            TrusteeFixture.encode(panel, STUB, TRANSCRIPT, ks, _signed(STUB, ks, _range(1, 4)))
        );
    }

    function test_RefusesNonCanonicalCalldata() public {
        bytes memory reg = _registration(STUB, TRANSCRIPT, _range(1, 4));
        bytes memory canonical = abi.encodeCall(TrusteeRegistry.registerCeremony, (reg));
        bytes memory refusal =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        (bool ok, bytes memory ret) = address(registry).call(bytes.concat(canonical, bytes32(0)));
        _assertRefused(ok, ret, refusal);
        // Dirty padding after the record (its length isn't a multiple of 32).
        bytes memory dirty = bytes.concat(canonical);
        dirty[dirty.length - 1] = 0x01;
        (ok, ret) = address(registry).call(dirty);
        _assertRefused(ok, ret, refusal);
        (ok,) = address(registry).call(canonical);
        assertTrue(ok, "canonical");
    }

    function test_CeremonyRecordedNeedsEveryField() public {
        // Nothing recorded: not even the zero transcript counts.
        assertTrue(!registry.ceremonyRecorded(STUB, bytes32(0), panel, 4, 7), "zero");
        assertTrue(!registry.ceremonyRecorded(STUB, TRANSCRIPT, panel, 4, 7), "unrecorded");
        registry.registerCeremony(_registration(STUB, TRANSCRIPT, _range(1, 4)));
        assertTrue(registry.ceremonyRecorded(STUB, TRANSCRIPT, panel, 4, 7), "recorded");
        assertTrue(!registry.ceremonyRecorded(STUB, bytes32(0), panel, 4, 7), "zero transcript");
        assertTrue(!registry.ceremonyRecorded(keccak256("b"), TRANSCRIPT, panel, 4, 7), "stub");
        assertTrue(!registry.ceremonyRecorded(STUB, keccak256("b"), panel, 4, 7), "transcript");
        assertTrue(!registry.ceremonyRecorded(STUB, TRANSCRIPT, keccak256("b"), 4, 7), "panel");
        assertTrue(!registry.ceremonyRecorded(STUB, TRANSCRIPT, panel, 3, 7), "threshold");
        assertTrue(!registry.ceremonyRecorded(STUB, TRANSCRIPT, panel, 4, 6), "size");
    }

    /// Calldata and events carry only fixed-size hashes, seat numbers and
    /// signatures (contracts skill, No PII on-chain): no text slips through.
    function test_NoPersonalDataInCalldataOrEvents() public {
        bytes memory reg = _registration(STUB, TRANSCRIPT, _range(1, 7));
        assertTrue(
            !_looksLikeText(abi.encodeCall(TrusteeRegistry.registerCeremony, (reg))), "calldata"
        );
        vm.recordLogs();
        registry.registerCeremony(reg);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(!_looksLikeText(logs[0].data), "event data");
        for (uint256 i; i < logs[0].topics.length; i++) {
            assertTrue(!_looksLikeText(abi.encode(logs[0].topics[i])), "topic");
        }
        // Text can't be appended: the record's length is exact.
        _expectRefused(
            bytes.concat(reg, "Jane Doe, 1 Main Street"),
            abi.encodeWithSelector(TrusteeRegistry.MalformedRegistration.selector)
        );
    }

    /// The election registry admits a definition exactly when this registry
    /// recorded its stub with its transcript, for the panel it names.
    function test_ElectionRegistryAsksThisRegistry() public {
        RegistryFixture.installL1Block(vm);
        DefinitionHarness defs = new DefinitionHarness();
        ElectionRegistry elections =
            new ElectionRegistry(RegistryFixture.deployment(address(registry)));
        vm.warp(RegistryFixture.NOW);
        vm.roll(RegistryFixture.BLOCK);
        vm.prank(address(0xC4EA));
        bytes32 id = elections.createElection();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(elections, id);
        d.panelId = panel;
        d.threshold = 4;
        d.panelSize = 7;
        d.ceremonyTranscriptHash = TRANSCRIPT;
        bytes memory enc = DefinitionEncoder.encode(d);
        bytes32 stub = defs.stubHash(enc);

        vm.prank(address(0xC4EA));
        (bool ok,) =
            address(elections).call(abi.encodeCall(ElectionRegistry.registerDefinition, (enc)));
        assertTrue(!ok, "admitted before the ceremony was recorded");
        registry.registerCeremony(_registration(stub, TRANSCRIPT, _range(1, 4)));
        vm.prank(address(0xC4EA));
        elections.registerDefinition(enc);
        assertEq(elections.definitionHashOf(id), defs.hash(enc), "registered");
    }

    /// Any one-bit change to a valid registration is refused.
    function testFuzz_RefusesAnyBitFlip(uint256 bit) public {
        bytes memory reg = _registration(STUB, TRANSCRIPT, _range(1, 4));
        bit = bit % (reg.length * 8);
        reg[bit / 8] ^= bytes1(uint8(0x80) >> (bit % 8));
        (bool ok,) = address(registry).call(abi.encodeCall(TrusteeRegistry.registerCeremony, (reg)));
        assertTrue(!ok, "flipped registration accepted");
        assertEq(registry.transcriptOf(STUB, panel), bytes32(0), "recorded");
    }

    function testFuzz_RefusesArbitraryBytes(bytes calldata junk) public {
        (bool ok,) =
            address(registry).call(abi.encodeCall(TrusteeRegistry.registerCeremony, (junk)));
        assertTrue(!ok, "junk accepted");
    }

    // --- helpers -----------------------------------------------------------------

    function _registration(bytes32 stub, bytes32 transcript, uint8[] memory seats)
        internal
        view
        returns (bytes memory)
    {
        return _encode(panel, stub, transcript, _approvals(stub, transcript, seats));
    }

    function _registrationFor(
        TrusteeRegistry reg,
        bytes32 stub,
        bytes32 transcript,
        uint8[] memory seats
    ) internal view returns (bytes memory) {
        return TrusteeFixture.encode(
            panel,
            stub,
            transcript,
            _keySetFor(reg, panel),
            _approvalsFor(reg, panel, stub, transcript, seats)
        );
    }

    function _approvals(bytes32 stub, bytes32 transcript, uint8[] memory seats)
        internal
        view
        returns (TrusteeFixture.Approval[] memory)
    {
        return _approvalsFor(registry, panel, stub, transcript, seats);
    }

    /// Seats of `panel-4-of-7` (and of `panel-2-of-2`, whose seats are its
    /// first two keys) signing for registry `reg`.
    function _approvalsFor(
        TrusteeRegistry reg,
        bytes32 panelId,
        bytes32 stub,
        bytes32 transcript,
        uint8[] memory seats
    ) internal view returns (TrusteeFixture.Approval[] memory a) {
        bytes32 keySetHash = lib.keySetHash(TrusteeFixture.seatBytes(_keySetFor(reg, panelId)));
        a = new TrusteeFixture.Approval[](seats.length);
        for (uint256 i; i < seats.length; i++) {
            bytes32 digest = TrusteeIdentityLib.registrationDigest(
                uint64(block.chainid), address(reg), panelId, seats[i], stub, transcript, keySetHash
            );
            (uint256 r, uint256 s) = TrusteeFixture.sign(secrets[seats[i]], digest);
            a[i] = TrusteeFixture.Approval(seats[i], r, s);
        }
    }

    function _set7() internal view returns (TrusteeFixture.Seat[] memory) {
        return TrusteeFixture.keySet(keySets, "key-set-7");
    }

    function _keySetHash(string memory id) internal view returns (bytes32 h) {
        for (uint256 i;; i++) {
            string memory at = string.concat(".keySets[", vm.toString(i), "]");
            if (
                keccak256(bytes(vm.parseJsonString(keySets, string.concat(at, ".id"))))
                    == keccak256(bytes(id))
            ) {
                return bytes32(
                    vm.parseBytes(vm.parseJsonString(keySets, string.concat(at, ".keySetHash")))
                );
            }
        }
    }

    function _drop(TrusteeFixture.Seat[] memory ks, uint256 at)
        internal
        pure
        returns (TrusteeFixture.Seat[] memory out)
    {
        out = new TrusteeFixture.Seat[](ks.length - 1);
        for (uint256 i; i < out.length; i++) {
            out[i] = ks[i < at ? i : i + 1];
        }
    }

    /// Approvals by `seats` of the default panel over key set `ks`.
    function _signed(bytes32 stub, TrusteeFixture.Seat[] memory ks, uint8[] memory seats)
        internal
        view
        returns (TrusteeFixture.Approval[] memory a)
    {
        bytes32 keySetHash = lib.keySetHash(TrusteeFixture.seatBytes(ks));
        a = new TrusteeFixture.Approval[](seats.length);
        for (uint256 i; i < seats.length; i++) {
            bytes32 digest = TrusteeIdentityLib.registrationDigest(
                uint64(block.chainid),
                address(registry),
                panel,
                seats[i],
                stub,
                TRANSCRIPT,
                keySetHash
            );
            (uint256 r, uint256 s) = TrusteeFixture.sign(secrets[seats[i]], digest);
            a[i] = TrusteeFixture.Approval(seats[i], r, s);
        }
    }

    /// A record with key set `ks` is refused with `expected`, whatever its
    /// approvals: the key set is checked before any signature.
    function _expectKeySetRefused(TrusteeFixture.Seat[] memory ks, bytes memory expected) internal {
        _expectRefused(
            TrusteeFixture.encode(
                panel, STUB, TRANSCRIPT, ks, _approvals(STUB, TRANSCRIPT, _range(1, 4))
            ),
            expected
        );
    }

    /// The key set registered for `panelId`: every seat of the 7-seat
    /// panels, both seats of `panel-2-of-2` (key-set.json).
    function _keySetFor(TrusteeRegistry reg, bytes32 panelId)
        internal
        view
        returns (TrusteeFixture.Seat[] memory)
    {
        (, uint8 size,) = reg.panelOf(panelId);
        return TrusteeFixture.keySet(keySets, size == 2 ? "key-set-2" : "key-set-7");
    }

    function _encode(
        bytes32 panelId,
        bytes32 stub,
        bytes32 transcript,
        TrusteeFixture.Approval[] memory a
    ) internal view returns (bytes memory) {
        return TrusteeFixture.encode(panelId, stub, transcript, _keySetFor(registry, panelId), a);
    }

    function _withQuorum(uint8 quorum)
        internal
        view
        returns (TrusteeRegistry.PanelInput[] memory panels)
    {
        panels = new TrusteeRegistry.PanelInput[](1);
        panels[0] = TrusteeFixture.panel(json, "panel-4-of-7", quorum);
    }

    function _seats(uint8 a) internal pure returns (uint8[] memory s) {
        s = new uint8[](1);
        s[0] = a;
    }

    function _seats(uint8 a, uint8 b, uint8 c, uint8 d) internal pure returns (uint8[] memory s) {
        s = new uint8[](4);
        (s[0], s[1], s[2], s[3]) = (a, b, c, d);
    }

    function _seats(uint8 a, uint8 b, uint8 c, uint8 d, uint8 e)
        internal
        pure
        returns (uint8[] memory s)
    {
        s = new uint8[](5);
        (s[0], s[1], s[2], s[3], s[4]) = (a, b, c, d, e);
    }

    function _range(uint8 from, uint8 to) internal pure returns (uint8[] memory s) {
        s = new uint8[](to - from + 1);
        for (uint8 i; i < s.length; i++) {
            s[i] = from + i;
        }
    }

    function _expectRefused(bytes memory reg, bytes memory expected) internal {
        (bool ok, bytes memory ret) =
            address(registry).call(abi.encodeCall(TrusteeRegistry.registerCeremony, (reg)));
        _assertRefused(ok, ret, expected);
    }

    function _expectInvalidSignature(TrusteeFixture.Approval[] memory a, uint8 index) internal {
        _expectRefused(
            _encode(panel, STUB, TRANSCRIPT, a),
            abi.encodeWithSelector(TrusteeRegistry.InvalidSignature.selector, index)
        );
    }

    function _expectPanelError(
        TrusteeRegistry.PanelInput[] memory panels,
        uint256 position,
        TrusteeRegistry.PanelError reason
    ) internal {
        try new TrusteeRegistry(panels) {
            revert("panel accepted");
        } catch (bytes memory ret) {
            assertTrue(
                keccak256(ret)
                    == keccak256(
                        abi.encodeWithSelector(
                            TrusteeRegistry.InvalidPanel.selector, position, reason
                        )
                    ),
                "unexpected panel error"
            );
        }
    }

    function _assertRefused(bool ok, bytes memory ret, bytes memory expected) internal pure {
        assertTrue(!ok, "call succeeded");
        assertTrue(keccak256(ret) == keccak256(expected), "unexpected revert data");
    }

    function _assertAccumulated(TrusteeRegistry reg, Vm.Log[] memory logs) internal view {
        bytes32 acc = EventAccumulatorLib.genesis(uint64(block.chainid), address(reg));
        for (uint256 i; i < logs.length; i++) {
            acc = EventAccumulatorLib.step(
                acc, uint64(i), block.number, block.timestamp, logs[i].topics, logs[i].data
            );
        }
        (bytes32 stored, uint64 count) = reg.eventAccumulator();
        assertEq(stored, acc, "accumulator");
        assertEq(count, logs.length, "count");
    }

    /// The election registry tests' detector (ElectionRegistry.t.sol): an at
    /// sign flanked by printable characters, or 12 printable characters in a row.
    function _looksLikeText(bytes memory b) internal pure returns (bool) {
        uint256 run;
        for (uint256 i; i < b.length; i++) {
            bool printable = uint8(b[i]) >= 0x20 && uint8(b[i]) < 0x7f;
            run = printable ? run + 1 : 0;
            if (run >= 12) return true;
            if (b[i] == 0x40 && i >= 2 && i + 2 < b.length) {
                bool flanked = true;
                for (uint256 k = i - 2; k <= i + 2; k++) {
                    if (uint8(b[k]) < 0x20 || uint8(b[k]) >= 0x7f) flanked = false;
                }
                if (flanked) return true;
            }
        }
        return false;
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

/// The events the registry emits against docs/spec/vectors/contract-event-v12.json
/// (an independent Python generator): deployed at the file's address and
/// chain with the panels its `PanelPinned` records log, at their block and
/// time, then given the registration its `CeremonyRegistered` record carries,
/// the registry emits exactly the file's six records, kind-carrying
/// `PanelPinned` first, and its accumulator steps through the file's
/// sequence (contracts.md, Contract-event record, Event tables (version 12);
/// Trustee registry, Events; T-53, T-31).
contract TrusteeRegistryEventVectorsTest is TestBase {
    string internal constant EVENTS = "../../docs/spec/vectors/contract-event-v12.json";
    /// The file's trustee-registry sequence starts with five panels.
    uint256 internal constant PANELS = 5;

    string internal json;

    function setUp() public {
        json = vm.readFile(EVENTS);
    }

    function test_EmitsVersion12sRecords() public {
        assertTrue(
            keccak256(bytes(vm.parseJsonString(json, ".format")))
                == keccak256("abolish-contract-event-vectors/12"),
            "format"
        );
        assertTrue(
            keccak256(bytes(vm.parseJsonString(json, ".sequences[0].role")))
                == keccak256("trustee-registry"),
            "sequence role"
        );
        address at = address(bytes20(_hex(".contracts.trustee-registry")));
        vm.chainId(vm.parseJsonUint(json, ".chainId"));

        TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](PANELS);
        for (uint256 i; i < PANELS; i++) {
            panels[i] = _panelOf(_record(i));
        }
        vm.recordLogs();
        _moveTo(_record(0));
        _deployAt(at, abi.encode(panels));
        TrusteeRegistry reg = TrusteeRegistry(at);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, PANELS, "one log per panel");
        for (uint256 i; i < PANELS; i++) {
            string memory r = _record(i);
            string memory id = vm.parseJsonString(json, string.concat(r, ".id"));
            assertTrue(logs[i].emitter == at, id);
            string[] memory topics =
                vm.parseJsonStringArray(json, string.concat(r, ".fields.topics"));
            assertEq(logs[i].topics.length, topics.length, id);
            for (uint256 t; t < topics.length; t++) {
                assertEq(
                    logs[i].topics[t], bytes32(vm.parseBytes(string.concat("0x", topics[t]))), id
                );
            }
            assertTrue(
                keccak256(logs[i].data) == keccak256(_hex(string.concat(r, ".fields.data"))), id
            );
            assertEq(logs[i].topics[0], TrusteeRegistry.PanelPinned.selector, id);
            assertEq(reg.kindOf(logs[i].topics[1]), panels[i].kind, id);
        }
        (bytes32 acc, uint64 n) = reg.eventAccumulator();
        assertEq(n, PANELS, "accumulator count");
        assertEq(
            acc,
            bytes32(
                vm.parseBytes(
                    string.concat(
                        "0x",
                        vm.parseJsonString(
                            json,
                            string.concat(
                                ".sequences[0].accumulators[", vm.toString(PANELS - 1), "]"
                            )
                        )
                    )
                )
            ),
            "accumulator"
        );
    }

    /// The sequence's `i`th record, found by its id.
    function _record(uint256 i) internal view returns (string memory) {
        string memory id =
            vm.parseJsonString(json, string.concat(".sequences[0].records[", vm.toString(i), "]"));
        for (
            uint256 j;
            vm.keyExistsJson(json, string.concat(".records[", vm.toString(j), "]"));
            j++
        ) {
            string memory r = string.concat(".records[", vm.toString(j), "]");
            if (
                keccak256(bytes(vm.parseJsonString(json, string.concat(r, ".id"))))
                    == keccak256(bytes(id))
            ) {
                return r;
            }
        }
        revert("record not found");
    }

    /// The deployment input a `PanelPinned` record logs: its threshold,
    /// quorum, kind and keys, each key's point decompressed from its encoding.
    function _panelOf(string memory r) internal view returns (TrusteeRegistry.PanelInput memory p) {
        (p.threshold, p.quorum, p.kind, p.keys) =
            abi.decode(_hex(string.concat(r, ".fields.data")), (uint8, uint8, uint8, bytes));
        uint256 n = p.keys.length / TrusteeIdentityLib.KEY_LENGTH;
        p.points = new uint256[2][](n);
        for (uint256 s; s < n; s++) {
            bytes memory enc = new bytes(TrusteeIdentityLib.KEY_LENGTH);
            for (uint256 b; b < enc.length; b++) {
                enc[b] = p.keys[s * TrusteeIdentityLib.KEY_LENGTH + b];
            }
            (uint256 x, uint256 y, bool onCurve) = TrusteeFixture.point(enc);
            assertTrue(onCurve, "key");
            p.points[s] = [x, y];
        }
    }

    function _moveTo(string memory r) internal {
        vm.roll(vm.parseJsonUint(json, string.concat(r, ".fields.l2Block")));
        vm.warp(vm.parseJsonUint(json, string.concat(r, ".fields.l2Timestamp")));
    }

    /// Runs the registry's constructor at `at`, as a deployment to that
    /// address would: its events and accumulator are `at`'s.
    function _deployAt(address at, bytes memory args) internal {
        vm.etch(at, bytes.concat(type(TrusteeRegistry).creationCode, args));
        (bool ok, bytes memory runtime) = at.call("");
        assertTrue(ok, "deployment");
        vm.etch(at, runtime);
    }

    function _hex(string memory key) internal view returns (bytes memory) {
        return vm.parseBytes(string.concat("0x", vm.parseJsonString(json, key)));
    }
}
