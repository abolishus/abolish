// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {GroupRegistry} from "../src/GroupRegistry.sol";
import {ITrusteePanels, NullifierKeyLib} from "../src/NullifierKey.sol";
import {TrusteeIdentityLib, TrusteeRegistry} from "../src/TrusteeRegistry.sol";
import {NullifierKeyFixture} from "./utils/NullifierKeyFixture.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// Exposes NullifierKeyLib's statements and quorum to the tests.
contract NullifierKeyHarness {
    function digest(
        uint8 kind,
        uint64 chainId,
        address registry,
        bytes32 panel,
        uint8 index,
        bytes memory rest
    ) external pure returns (bytes32) {
        bytes memory ds = kind == 0
            ? NullifierKeyLib.DS_KEY_APPROVAL
            : kind == 1 ? NullifierKeyLib.DS_RESHARE_APPROVAL : NullifierKeyLib.DS_CONSENT;
        return NullifierKeyLib.digest(ds, chainId, registry, panel, index, rest);
    }

    function quorum(uint8 threshold, uint8 size) external pure returns (uint256) {
        return NullifierKeyLib.quorum(threshold, size);
    }
}

/// The group registry's Tier 2 nullifier keys (docs/spec/contracts.md, Group
/// registry, Nullifier keys) against docs/spec/vectors/nullifier-key-registry.json,
/// printed by an independent Python implementation: the registry builds the
/// three statements byte for byte, and over every replay of the vectors it
/// records exactly the chain of keys the replay records, refusing the first
/// failing record at the check the replay names (T-03, T-54, T-37, T-31).
contract NullifierKeysTest is TestBase {
    string internal json;
    NullifierKeyHarness internal lib;
    ITrusteePanels internal trustees;
    GroupRegistry internal registry;

    function setUp() public {
        json = vm.readFile(NullifierKeyFixture.VECTORS);
        lib = new NullifierKeyHarness();
        // The vectors' scope: the trustee registry is the deployer's first
        // contract and the group registry its second.
        vm.chainId(NullifierKeyFixture.VECTOR_CHAIN_ID);
        string[] memory names = vm.parseJsonStringArray(json, ".pinnedPanels");
        TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](names.length);
        for (uint256 i; i < names.length; i++) {
            panels[i] = NullifierKeyFixture.panel(json, names[i]);
        }
        vm.prank(NullifierKeyFixture.DEPLOYER);
        trustees = ITrusteePanels(address(new TrusteeRegistry(panels)));
        vm.prank(NullifierKeyFixture.DEPLOYER);
        registry = new GroupRegistry(
            2, _registrars(), trustees, _panelId(vm.parseJsonString(json, ".initialPanel"))
        );
        assertTrue(
            address(registry) == NullifierKeyFixture.VECTOR_REGISTRY, "the vectors' registry"
        );
    }

    // --- the vectors ---------------------------------------------------------

    function test_VectorFileFormatAndScope() public view {
        assertTrue(
            keccak256(bytes(vm.parseJsonString(json, ".format")))
                == keccak256("abolish-nullifier-key-registry-vectors/1"),
            "format"
        );
        assertEq(
            vm.parseUint(vm.parseJsonString(json, ".scope.l2ChainId")),
            NullifierKeyFixture.VECTOR_CHAIN_ID,
            "chain"
        );
        assertTrue(
            address(bytes20(_bytes(".scope.groupRegistry"))) == NullifierKeyFixture.VECTOR_REGISTRY,
            "registry"
        );
        assertEq(
            vm.parseJsonUint(json, ".parameters.MAX_KEY_WINDOW"),
            NullifierKeyLib.MAX_KEY_WINDOW,
            "MAX_KEY_WINDOW"
        );
        assertEq(
            vm.parseJsonUint(json, ".parameters.MAX_RESHARE_WINDOW"),
            NullifierKeyLib.MAX_RESHARE_WINDOW,
            "MAX_RESHARE_WINDOW"
        );
        _assertTag(NullifierKeyLib.DS_KEY_APPROVAL, "abolish/v1/sig/nullifier-key-approval-3");
        _assertTag(
            NullifierKeyLib.DS_RESHARE_APPROVAL, "abolish/v1/sig/nullifier-reshare-approval-2"
        );
        _assertTag(NullifierKeyLib.DS_CONSENT, "abolish/v1/sig/nullifier-reshare-consent");
    }

    /// The trustee registry pins each panel under the vectors' `panel_id`, and
    /// the quorum the group registry computes is the vectors' `max(k, n − 1)`,
    /// never the trustee registry's ceremony quorum.
    function test_PanelsAndQuorums() public view {
        string[3] memory names = ["initial-5", "next-4", "outside-3"];
        for (uint256 i; i < names.length; i++) {
            string memory at = string.concat(".panels.", names[i]);
            TrusteeRegistry.PanelInput memory p = NullifierKeyFixture.panel(json, names[i]);
            bytes32 id = TrusteeIdentityLib.panelId(p.threshold, uint8(p.points.length), p.keys);
            assertEq(id, _panelId(names[i]), names[i]);
            assertEq(
                lib.quorum(p.threshold, uint8(p.points.length)),
                vm.parseJsonUint(json, string.concat(at, ".quorum")),
                names[i]
            );
            (uint8 k,,) = trustees.panelOf(id);
            assertTrue((k != 0) == (i < 2), string.concat(names[i], ": pinned"));
        }
        assertEq(registry.initialPanelId(), _panelId("initial-5"), "initial panel");
        assertTrue(address(registry.trusteeRegistry()) == address(trustees), "trustee registry");
    }

    /// Every statement's digest, for every seat, as the registry builds it
    /// from the record's fields, and each vector signature verifies under its
    /// seat's pinned key exactly as the registry checks it.
    function test_StatementDigests() public view {
        _checkStatements(".statements.keyApproval", 0);
        _checkStatements(".statements.reshareApproval", 1);
        _checkStatements(".statements.reshareConsent", 2);
    }

    /// Every replay: each record is submitted at the block its log carries;
    /// those before the first failing record are recorded, emitting exactly
    /// their record, and the failing one reverts at the replay's check, so
    /// the chain the registry holds is the replay's. A `topic` failure is a
    /// log the registry can't emit: its record is accepted and logged with
    /// topics equal to its fields.
    /// The replays run in four tests, each within the test gas limit.
    function test_Replays0To13() public {
        _runReplays(0, 14);
    }

    function test_Replays14To27() public {
        _runReplays(14, 28);
    }

    function test_Replays28To41() public {
        _runReplays(28, 42);
    }

    function test_Replays42To55() public {
        _runReplays(42, 56);
        assertTrue(!vm.keyExistsJson(json, _replay(56, "")), "a replay no test runs");
    }

    // --- deployment ----------------------------------------------------------

    /// Deployment refuses an initial panel the trustee registry doesn't pin
    /// (`initial-panel`), after the registrars' checks, and logs only
    /// `RegistrarsPinned`: the trustee registry and the initial panel are
    /// immutables, which verifier 1.2 compares with the release's pins.
    function test_DeploymentRequiresThePinnedInitialPanel() public {
        bytes32 outside = _panelId("outside-3");
        try new GroupRegistry(2, _registrars(), trustees, outside) {
            assertTrue(false, "unpinned initial panel accepted");
        } catch (bytes memory err) {
            assertTrue(
                keccak256(err)
                    == keccak256(
                        abi.encodeWithSelector(GroupRegistry.InitialPanel.selector, outside)
                    ),
                "initial-panel"
            );
        }
        // The registrars' checks come first.
        try new GroupRegistry(1, _registrars(), trustees, outside) {
            assertTrue(false, "threshold 1 accepted");
        } catch (bytes memory err) {
            assertTrue(
                keccak256(err)
                    == keccak256(
                        abi.encodeWithSelector(
                            GroupRegistry.InvalidRegistrars.selector,
                            GroupRegistry.RegistrarError.Threshold
                        )
                    ),
                "registrars first"
            );
        }
        vm.recordLogs();
        GroupRegistry reg = new GroupRegistry(2, _registrars(), trustees, _panelId("next-4"));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics[0], GroupRegistry.RegistrarsPinned.selector, "RegistrarsPinned");
        (bytes32 keyId, bytes32 panel) = reg.nullifierKey();
        assertEq(keyId, bytes32(0), "no key");
        assertEq(panel, bytes32(0), "no panel");
    }

    // --- the calls -----------------------------------------------------------

    /// The honest chain, call by call: each record makes its key current
    /// with its panel, adds it to the recorded set and logs it; the sender
    /// isn't read.
    function test_HonestChainState() public {
        bytes memory initial = _bytes(".records.initial.record");
        bytes memory reshare = _bytes(".records.reshare.record");
        bytes memory refresh = _bytes(".records.refresh.record");
        bytes32 k0 = bytes32(_bytes(".records.initial.keyId"));
        bytes32 k1 = bytes32(_bytes(".records.reshare.keyId"));
        bytes32 k2 = bytes32(_bytes(".records.refresh.keyId"));
        bytes32 next = _panelId("next-4");

        vm.roll(1_000_000);
        vm.prank(address(0xBEEF));
        registry.recordNullifierKey(initial);
        _assertCurrent(k0, _panelId("initial-5"));
        assertTrue(registry.nullifierKeyRecorded(k0), "k0 recorded");

        vm.roll(1_150_000);
        vm.recordLogs();
        registry.recordNullifierReshare(reshare);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics.length, 4, "topics");
        assertEq(logs[0].topics[0], GroupRegistry.NullifierKeyReshared.selector, "topic 0");
        assertEq(logs[0].topics[1], k0, "predecessor");
        assertEq(logs[0].topics[2], k1, "key_id");
        assertEq(logs[0].topics[3], next, "new_panel_id");
        assertTrue(keccak256(logs[0].data) == keccak256(abi.encode(reshare)), "record");
        _assertCurrent(k1, next);

        vm.roll(1_300_000);
        registry.recordNullifierReshare(refresh);
        _assertCurrent(k2, next);
        assertTrue(registry.nullifierKeyRecorded(k0) && registry.nullifierKeyRecorded(k1), "set");

        // The chain is final: no second initial key, no successor of a
        // retired key, and the current key's own reshare can't be repeated.
        _expectRefused(
            GroupRegistry.recordNullifierKey.selector,
            initial,
            abi.encodeWithSelector(GroupRegistry.KeyAlreadyRecorded.selector, k0)
        );
        _expectRefused(
            GroupRegistry.recordNullifierReshare.selector,
            reshare,
            abi.encodeWithSelector(GroupRegistry.NotCurrentKey.selector, k0)
        );
    }

    /// Both calls take their selector and one ABI-encoded `bytes` and
    /// nothing else (T-17).
    function test_CanonicalCalldata() public {
        vm.roll(1_000_000);
        bytes memory initial = _bytes(".records.initial.record");
        bytes memory data = abi.encodeCall(GroupRegistry.recordNullifierKey, (initial));
        (bool ok, bytes memory ret) = address(registry).call(bytes.concat(data, bytes1(0)));
        assertTrue(!ok, "trailing byte accepted");
        assertTrue(bytes4(ret) == CanonicalCalldata.NonCanonicalCalldata.selector, "non-canonical");
        (ok,) = address(registry).call(data);
        assertTrue(ok, "canonical");

        vm.roll(1_150_000);
        data = abi.encodeCall(
            GroupRegistry.recordNullifierReshare, (_bytes(".records.reshare.record"))
        );
        (ok, ret) = address(registry).call(bytes.concat(data, new bytes(32)));
        assertTrue(!ok && bytes4(ret) == CanonicalCalldata.NonCanonicalCalldata.selector, "pad");
        (ok,) = address(registry).call(data);
        assertTrue(ok, "canonical reshare");
    }

    /// Any one flipped bit of the honest initial record is refused, and
    /// nothing is recorded: every byte is a length, the deadline or key every
    /// approval signed, a seat or a signature.
    function testFuzz_FlippedInitialRecordIsRefused(uint256 at, uint8 bit) public {
        bytes memory record = _bytes(".records.initial.record");
        at = at % record.length;
        record[at] = record[at] ^ bytes1(uint8(1) << (bit % 8));
        vm.roll(1_000_000);
        (bool ok,) =
            address(registry).call(abi.encodeCall(GroupRegistry.recordNullifierKey, (record)));
        assertTrue(!ok, "flipped record accepted");
        (bytes32 keyId,) = registry.nullifierKey();
        assertEq(keyId, bytes32(0), "a key was recorded");
    }

    /// The same for the honest reshare, on top of the honest initial key.
    function testFuzz_FlippedReshareRecordIsRefused(uint256 at, uint8 bit) public {
        bytes memory record = _bytes(".records.reshare.record");
        at = at % record.length;
        record[at] = record[at] ^ bytes1(uint8(1) << (bit % 8));
        vm.roll(1_000_000);
        registry.recordNullifierKey(_bytes(".records.initial.record"));
        vm.roll(1_150_000);
        (bool ok,) =
            address(registry).call(abi.encodeCall(GroupRegistry.recordNullifierReshare, (record)));
        assertTrue(!ok, "flipped record accepted");
        _assertCurrent(bytes32(_bytes(".records.initial.keyId")), _panelId("initial-5"));
    }

    /// Records of random bytes record nothing: they would need a quorum of
    /// the initial panel's signatures.
    function testFuzz_RandomRecordsRecordNothing(bytes memory record) public {
        vm.roll(1_000_000);
        (bool ok,) =
            address(registry).call(abi.encodeCall(GroupRegistry.recordNullifierKey, (record)));
        assertTrue(!ok, "random initial record accepted");
        (ok,) =
            address(registry).call(abi.encodeCall(GroupRegistry.recordNullifierReshare, (record)));
        assertTrue(!ok, "random reshare accepted");
    }

    /// Calldata and events carry only panels, seats, signatures, a deadline
    /// and key identifiers (contracts skill, No PII on-chain; T-12): no text,
    /// and nothing of any document, member or poll.
    function test_NoPersonalDataInCalldataOrEvents() public {
        bytes memory initial = _bytes(".records.initial.record");
        bytes memory reshare = _bytes(".records.reshare.record");
        assertTrue(
            !_looksLikeText(abi.encodeCall(GroupRegistry.recordNullifierKey, (initial))), "initial"
        );
        assertTrue(
            !_looksLikeText(abi.encodeCall(GroupRegistry.recordNullifierReshare, (reshare))),
            "reshare"
        );
        vm.recordLogs();
        vm.roll(1_000_000);
        registry.recordNullifierKey(initial);
        vm.roll(1_150_000);
        registry.recordNullifierReshare(reshare);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "logs");
        for (uint256 i; i < logs.length; i++) {
            assertTrue(!_looksLikeText(logs[i].data), "event data");
        }
        bytes memory withText = bytes.concat(initial, "Jane Doe, 1 Main Street");
        assertTrue(_looksLikeText(withText), "detector misses the text");
        vm.roll(1_000_000);
        GroupRegistry fresh = new GroupRegistry(2, _registrars(), trustees, _panelId("initial-5"));
        (bool ok, bytes memory ret) =
            address(fresh).call(abi.encodeCall(GroupRegistry.recordNullifierKey, (withText)));
        assertTrue(!ok && bytes4(ret) == GroupRegistry.MalformedRecord.selector, "text refused");
    }

    /// Measured here: recording the initial key with the vectors' four
    /// approvals costs about 186,000 gas with the P256VERIFY precompile and
    /// 1,144,000 on OpenZeppelin's Solidity fallback, and the reshare with
    /// four consents and three approvals about 207,000 and 1,875,000, beyond
    /// the transaction's base cost and calldata. Once per key; the bounds
    /// keep a regression visible.
    function test_Gas() public {
        bool precompile = _precompile();
        vm.roll(1_000_000);
        bytes memory record = _bytes(".records.initial.record");
        uint256 before = gasleft();
        registry.recordNullifierKey(record);
        uint256 used = before - gasleft();
        assertTrue(used < (precompile ? 220_000 : 1_300_000), "initial gas");
        vm.roll(1_150_000);
        record = _bytes(".records.reshare.record");
        before = gasleft();
        registry.recordNullifierReshare(record);
        used = before - gasleft();
        assertTrue(used < (precompile ? 250_000 : 2_100_000), "reshare gas");
    }

    // --- helpers -------------------------------------------------------------

    function _runReplays(uint256 from, uint256 to) internal {
        for (uint256 c = from; c < to; c++) {
            uint256 snapshot = vm.snapshotState();
            _runReplay(c);
            vm.revertToState(snapshot);
        }
    }

    function _runReplay(uint256 c) internal {
        string memory id = vm.parseJsonString(json, _replay(c, ".id"));
        bool ok = vm.parseJsonBool(json, _replay(c, ".result.ok"));
        uint256 failAt = ok ? type(uint256).max : vm.parseJsonUint(json, _replay(c, ".result.at"));
        string memory code = ok ? "" : vm.parseJsonString(json, _replay(c, ".result.code"));
        // A topic failure's record is accepted, and its key made current.
        bytes32 extra;
        bool topic = keccak256(bytes(code)) == keccak256("topic");
        for (uint256 e; vm.keyExistsJson(json, _event(c, e, "")); e++) {
            (bool accepted, bytes memory ret, bool initial, bytes memory record) = _submit(c, e);
            if (e < failAt || (e == failAt && topic)) {
                assertTrue(accepted, string.concat(id, ": refused an accepted record"));
                if (e == failAt) {
                    extra = _at(record, initial ? 8 : 72);
                    break;
                }
            } else {
                assertTrue(!accepted, string.concat(id, ": accepted the failing record"));
                assertTrue(bytes4(ret) == _error(code), string.concat(id, ": ", code));
                break;
            }
        }
        // The chain the registry holds is the replay's, and the topic
        // case's record after it.
        string memory keys = _replay(c, ".result.keys");
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(keys, "[", vm.toString(n), "]"))) n++;
        (bytes32 keyId, bytes32 panel) = registry.nullifierKey();
        if (extra != bytes32(0)) {
            assertEq(keyId, extra, string.concat(id, ": the topic case's key"));
        } else if (n == 0) {
            assertEq(keyId, bytes32(0), string.concat(id, ": a key"));
        } else {
            string memory last = string.concat(keys, "[", vm.toString(n - 1), "]");
            assertEq(keyId, _word(string.concat(last, ".keyId")), string.concat(id, ": key"));
            assertEq(panel, _word(string.concat(last, ".panelId")), string.concat(id, ": panel"));
        }
        for (uint256 i; i < n; i++) {
            bytes32 k = _word(string.concat(keys, "[", vm.toString(i), "].keyId"));
            assertTrue(registry.nullifierKeyRecorded(k), string.concat(id, ": recorded set"));
        }
    }

    /// Submits event `e` of replay `c`'s record at the block its log carries;
    /// an accepted record must log exactly itself.
    function _submit(uint256 c, uint256 e)
        internal
        returns (bool accepted, bytes memory ret, bool initial, bytes memory record)
    {
        vm.roll(vm.parseUint(vm.parseJsonString(json, _event(c, e, ".l2Block"))));
        initial = keccak256(bytes(vm.parseJsonString(json, _event(c, e, ".kind"))))
            == keccak256("initial");
        record = _bytes(_event(c, e, ".record"));
        bytes4 selector = initial
            ? GroupRegistry.recordNullifierKey.selector
            : GroupRegistry.recordNullifierReshare.selector;
        vm.recordLogs();
        (accepted, ret) = address(registry).call(abi.encodeWithSelector(selector, record));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (accepted) {
            _assertLogged(logs, initial, record, vm.parseJsonString(json, _replay(c, ".id")));
        } else {
            assertEq(logs.length, 0, "a refused record logged");
        }
    }

    /// One log, from the registry, whose topics are the record's own fields
    /// and whose data is the whole record.
    function _assertLogged(
        Vm.Log[] memory logs,
        bool initial,
        bytes memory record,
        string memory id
    ) internal view {
        assertEq(logs.length, 1, string.concat(id, ": one log"));
        Vm.Log memory l = logs[0];
        assertTrue(l.emitter == address(registry), id);
        assertTrue(keccak256(l.data) == keccak256(abi.encode(record)), string.concat(id, ": data"));
        if (initial) {
            assertEq(l.topics.length, 2, id);
            assertEq(l.topics[0], GroupRegistry.NullifierKeyRecorded.selector, id);
            assertEq(l.topics[1], _at(record, 8), string.concat(id, ": key_id topic"));
        } else {
            assertEq(l.topics.length, 4, id);
            assertEq(l.topics[0], GroupRegistry.NullifierKeyReshared.selector, id);
            assertEq(l.topics[1], _at(record, 0), string.concat(id, ": predecessor topic"));
            assertEq(l.topics[2], _at(record, 72), string.concat(id, ": key_id topic"));
            assertEq(l.topics[3], _at(record, 32), string.concat(id, ": new_panel_id topic"));
        }
    }

    /// The registry's error for each of the replay's codes.
    function _error(string memory code) internal pure returns (bytes4) {
        bytes32 c = keccak256(bytes(code));
        if (c == keccak256("length")) return GroupRegistry.MalformedRecord.selector;
        if (c == keccak256("key-recorded")) return GroupRegistry.KeyAlreadyRecorded.selector;
        if (c == keccak256("predecessor")) return GroupRegistry.NotCurrentKey.selector;
        if (c == keccak256("panel")) return GroupRegistry.UnknownPanel.selector;
        if (c == keccak256("deadline")) return GroupRegistry.KeyDeadline.selector;
        if (c == keccak256("key-id")) return GroupRegistry.ZeroKeyId.selector;
        if (c == keccak256("quorum")) return GroupRegistry.KeyQuorum.selector;
        if (c == keccak256("seat")) return GroupRegistry.KeySeat.selector;
        if (c == keccak256("signature")) return GroupRegistry.KeySignature.selector;
        revert(string.concat("unknown code ", code));
    }

    function _checkStatements(string memory list, uint8 kind) internal view {
        uint256 i;
        for (; vm.keyExistsJson(json, string.concat(list, "[", vm.toString(i), "]")); i++) {
            string memory at = string.concat(list, "[", vm.toString(i), "]");
            string memory name = vm.parseJsonString(json, string.concat(at, ".panel"));
            bytes32 panel = _panelId(name);
            uint8 index = uint8(vm.parseJsonUint(json, string.concat(at, ".index")));
            bytes32 keyId = _word(string.concat(at, ".keyId"));
            uint64 deadline =
                uint64(vm.parseUint(vm.parseJsonString(json, string.concat(at, ".deadline"))));
            bytes memory rest;
            if (kind == 0) {
                rest = NullifierKeyLib.keyApprovalRest(keyId, deadline);
            } else {
                bytes32 predecessor = _word(string.concat(at, ".predecessor"));
                rest = kind == 1
                    ? NullifierKeyLib.reshareApprovalRest(predecessor, keyId, deadline)
                    : NullifierKeyLib.consentRest(
                            predecessor,
                            _panelId(vm.parseJsonString(json, string.concat(at, ".newPanel"))),
                            keyId,
                            deadline
                        );
            }
            bytes memory message = _bytes(string.concat(at, ".message"));
            assertTrue(
                keccak256(message)
                    == keccak256(
                        abi.encodePacked(
                            uint64(NullifierKeyFixture.VECTOR_CHAIN_ID),
                            NullifierKeyFixture.VECTOR_REGISTRY,
                            panel,
                            index,
                            rest
                        )
                    ),
                string.concat(at, ": message")
            );
            assertEq(message.length, kind == 0 ? 101 : kind == 1 ? 133 : 165, at);
            bytes32 digest = lib.digest(
                kind,
                uint64(NullifierKeyFixture.VECTOR_CHAIN_ID),
                NullifierKeyFixture.VECTOR_REGISTRY,
                panel,
                index,
                rest
            );
            assertEq(digest, _word(string.concat(at, ".digest")), string.concat(at, ": digest"));
            bytes memory sig = _bytes(string.concat(at, ".signature"));
            (uint256 x, uint256 y) = trustees.keyOf(panel, index);
            assertTrue(
                TrusteeIdentityLib.verify(
                    digest, uint256(_at(sig, 0)), uint256(_at(sig, 32)), x, y
                ),
                string.concat(at, ": signature")
            );
        }
        assertTrue(i > 0, list);
    }

    function _assertCurrent(bytes32 keyId, bytes32 panel) internal view {
        (bytes32 k, bytes32 p) = registry.nullifierKey();
        assertEq(k, keyId, "current key");
        assertEq(p, panel, "current panel");
    }

    function _expectRefused(bytes4 selector, bytes memory record, bytes memory expected) internal {
        (bool ok, bytes memory ret) =
            address(registry).call(abi.encodeWithSelector(selector, record));
        assertTrue(!ok, "accepted");
        assertTrue(keccak256(ret) == keccak256(expected), "wrong error");
    }

    function _assertTag(bytes memory ds, string memory tag) internal pure {
        assertTrue(keccak256(ds) == keccak256(abi.encodePacked(uint8(bytes(tag).length), tag)), tag);
    }

    /// Whether P-256 goes through the precompile here, asserted where the
    /// test script expects it.
    function _precompile() internal view returns (bool precompile) {
        string memory at = ".statements.keyApproval[0]";
        bytes memory sig = _bytes(string.concat(at, ".signature"));
        (uint256 x, uint256 y) = trustees.keyOf(_panelId("initial-5"), 1);
        (bool ok, bytes memory ret) = address(0x100)
            .staticcall(abi.encodePacked(_word(string.concat(at, ".digest")), sig, x, y));
        precompile = ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
        if (vm.envOr("EXPECT_P256VERIFY", false)) assertTrue(precompile, "no P256VERIFY");
    }

    function _registrars() internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = address(0x1001);
        r[1] = address(0x1002);
    }

    function _panelId(string memory name) internal view returns (bytes32) {
        return _word(string.concat(".panels.", name, ".panelId"));
    }

    function _replay(uint256 c, string memory field) internal pure returns (string memory) {
        return string.concat(".replays[", vm.toString(c), "]", field);
    }

    function _event(uint256 c, uint256 e, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(_replay(c, ".events["), vm.toString(e), "]", field);
    }

    function _bytes(string memory key) internal view returns (bytes memory) {
        return vm.parseBytes(_hex(vm.parseJsonString(json, key)));
    }

    function _word(string memory key) internal view returns (bytes32) {
        return bytes32(_bytes(key));
    }

    function _hex(string memory s) internal pure returns (string memory) {
        return string.concat("0x", s);
    }

    function _at(bytes memory b, uint256 offset) internal pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(add(b, 0x20), offset))
        }
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
}
