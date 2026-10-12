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
        _assertTag(
            TrusteeIdentityLib.DS_CEREMONY_REGISTRATION,
            vm.parseJsonString(json, ".tags.registration")
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

    /// Each registration vector's message is the 125-byte layout, its digest
    /// is what the contract signs over, and its signature verifies under the
    /// seat's key and nowhere else.
    function test_RegistrationVectors() public view {
        string memory json = vm.readFile(TrusteeFixture.VECTORS);
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".registrations", i, "")); i++) {
            _checkRegistration(json, i);
        }
        assertTrue(i >= 4, "registration vector coverage");
    }

    struct Registration {
        string id;
        uint64 chainId;
        address registry;
        bytes32 panel;
        uint8 index;
        bytes32 stub;
        bytes32 transcript;
    }

    function _checkRegistration(string memory json, uint256 i) internal view {
        Registration memory v;
        v.id = vm.parseJsonString(json, _at(".registrations", i, ".id"));
        TrusteeRegistry.PanelInput memory p = TrusteeFixture.panel(
            json, vm.parseJsonString(json, _at(".registrations", i, ".panel")), 4
        );
        v.panel = lib.panelId(p.threshold, uint8(p.points.length), p.keys);
        v.chainId =
            uint64(vm.parseUint(vm.parseJsonString(json, _at(".registrations", i, ".l2ChainId"))));
        v.registry = address(bytes20(_bytes(json, _at(".registrations", i, ".trusteeRegistry"))));
        v.index = uint8(vm.parseJsonUint(json, _at(".registrations", i, ".index")));
        v.stub = _bytes32(json, _at(".registrations", i, ".stubHash"));
        v.transcript = _bytes32(json, _at(".registrations", i, ".ceremonyTranscriptHash"));

        bytes memory message = _bytes(json, _at(".registrations", i, ".message"));
        assertEq(message.length, 125, v.id);
        assertTrue(
            keccak256(message)
                == keccak256(
                    abi.encodePacked(v.chainId, v.registry, v.panel, v.index, v.stub, v.transcript)
                ),
            v.id
        );
        bytes32 digest =
            lib.registrationDigest(v.chainId, v.registry, v.panel, v.index, v.stub, v.transcript);
        assertEq(
            digest, sha256(bytes.concat(TrusteeIdentityLib.DS_CEREMONY_REGISTRATION, message)), v.id
        );

        (uint256 r, uint256 s) =
            abi.decode(_bytes(json, _at(".registrations", i, ".signature")), (uint256, uint256));
        uint256[2] memory q = p.points[v.index - 1];
        assertTrue(lib.verify(digest, r, s, q[0], q[1]), v.id);
        uint256[2] memory other = p.points[v.index % p.points.length];
        assertTrue(!lib.verify(digest, r, s, other[0], other[1]), v.id);
        bytes32 elsewhere = lib.registrationDigest(
            v.chainId, address(0x5EC0), v.panel, v.index, v.stub, v.transcript
        );
        assertTrue(!lib.verify(elsewhere, r, s, q[0], q[1]), v.id);
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
    TrusteeRegistry internal registry;
    bytes32 internal panel;
    uint256[8] internal secrets;

    function setUp() public {
        json = vm.readFile(TrusteeFixture.VECTORS);
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
                    == keccak256(abi.encode(panels[i].threshold, panels[i].quorum, panels[i].keys)),
                "data"
            );
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
            TrusteeFixture.encode(panel, STUB, TRANSCRIPT, twice),
            abi.encodeWithSelector(TrusteeRegistry.SeatsOutOfOrder.selector, 3)
        );
        TrusteeFixture.Approval[] memory swapped = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        (swapped[1], swapped[2]) = (swapped[2], swapped[1]);
        _expectRefused(
            TrusteeFixture.encode(panel, STUB, TRANSCRIPT, swapped),
            abi.encodeWithSelector(TrusteeRegistry.SeatsOutOfOrder.selector, 2)
        );
    }

    function test_RefusesSeatsOutsideThePanel() public {
        TrusteeFixture.Approval[] memory a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        a[0].index = 0;
        _expectRefused(
            TrusteeFixture.encode(panel, STUB, TRANSCRIPT, a),
            abi.encodeWithSelector(TrusteeRegistry.SeatsOutOfOrder.selector, 0)
        );
        a = _approvals(STUB, TRANSCRIPT, _seats(1, 2, 3, 4));
        a[3].index = 8;
        _expectRefused(
            TrusteeFixture.encode(panel, STUB, TRANSCRIPT, a),
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
        for (uint256 c; c < 2; c++) {
            uint8[] memory seats = _seats(1, 2, 3, 4);
            TrusteeFixture.Approval[] memory a = new TrusteeFixture.Approval[](4);
            for (uint256 i; i < 4; i++) {
                bytes32 digest = TrusteeIdentityLib.registrationDigest(
                    chains[c], registries[c], panel, seats[i], STUB, TRANSCRIPT
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
            TrusteeFixture.encode(unknown, STUB, TRANSCRIPT, a),
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
        bytes memory moreCounted = bytes.concat(reg);
        moreCounted[96] = bytes1(uint8(5));
        _expectRefused(moreCounted, malformed);
        _expectRefused("", malformed);
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
        return TrusteeFixture.encode(panel, stub, transcript, _approvals(stub, transcript, seats));
    }

    function _registrationFor(
        TrusteeRegistry reg,
        bytes32 stub,
        bytes32 transcript,
        uint8[] memory seats
    ) internal view returns (bytes memory) {
        return TrusteeFixture.encode(
            panel, stub, transcript, _approvalsFor(reg, panel, stub, transcript, seats)
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
        a = new TrusteeFixture.Approval[](seats.length);
        for (uint256 i; i < seats.length; i++) {
            bytes32 digest = TrusteeIdentityLib.registrationDigest(
                uint64(block.chainid), address(reg), panelId, seats[i], stub, transcript
            );
            (uint256 r, uint256 s) = TrusteeFixture.sign(secrets[seats[i]], digest);
            a[i] = TrusteeFixture.Approval(seats[i], r, s);
        }
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
            TrusteeFixture.encode(panel, STUB, TRANSCRIPT, a),
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
