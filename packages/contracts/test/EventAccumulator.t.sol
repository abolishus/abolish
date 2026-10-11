// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {EventAccumulator, EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {AccumulatorHarness, AccumulatorLibHarness} from "./utils/AccumulatorHarness.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// The event accumulator of docs/spec/contracts.md (T-71, T-25). The library
/// is checked against docs/spec/vectors/event-accumulator.json, which an
/// independent Python implementation produced; the contract is checked
/// against the library and against the logs it actually emits.
contract EventAccumulatorTest is TestBase {
    string internal constant VECTORS = "../../docs/spec/vectors/event-accumulator.json";

    AccumulatorHarness internal harness;
    AccumulatorLibHarness internal lib;
    string internal json;

    function setUp() public {
        harness = new AccumulatorHarness();
        lib = new AccumulatorLibHarness();
        json = vm.readFile(VECTORS);
    }

    // --- vectors -----------------------------------------------------------

    function test_VectorFileFormat() public view {
        assertTrue(
            keccak256(bytes(vm.parseJsonString(json, ".format")))
                == keccak256("abolish-event-accumulator-vectors/1"),
            "unknown vector format"
        );
        assertTrue(
            keccak256(bytes(vm.parseJsonString(json, ".tag")))
                == keccak256(bytes(_tagFromPrefix())),
            "DS_PREFIX does not frame the registered tag"
        );
    }

    function test_GenesisVectors() public view {
        uint256 i;
        for (; vm.keyExistsJson(json, _key(".genesis", i, "")); i++) {
            uint64 chainId = lib.chainId64(vm.parseUint(_str(_key(".genesis", i, ".chainId"))));
            address emitter = _address(_key(".genesis", i, ".address"));
            assertEq(
                lib.genesis(chainId, emitter),
                _bytes32(_key(".genesis", i, ".accumulator")),
                "genesis vector"
            );
        }
        assertTrue(i > 0, "no genesis vectors");
    }

    function test_SequenceVectors() public view {
        uint256 i;
        for (; vm.keyExistsJson(json, _key(".sequences", i, "")); i++) {
            string memory seq = _key(".sequences", i, "");
            bytes32 acc = lib.genesis(
                lib.chainId64(vm.parseUint(_str(string.concat(seq, ".chainId")))),
                _address(string.concat(seq, ".address"))
            );
            assertEq(acc, _bytes32(string.concat(seq, ".genesis")), "sequence genesis");
            uint256 n;
            for (; vm.keyExistsJson(json, _key(string.concat(seq, ".events"), n, "")); n++) {
                string memory ev = _key(string.concat(seq, ".events"), n, "");
                acc = lib.step(acc, uint64(n), _topics(ev), _bytes(string.concat(ev, ".data")));
                assertEq(
                    acc, _bytes32(_key(string.concat(seq, ".accumulators"), n, "")), "sequence step"
                );
            }
            assertTrue(n > 0, "empty sequence");
        }
        assertTrue(i > 0, "no sequence vectors");
    }

    function test_RejectedVectors() public {
        uint256 i;
        for (; vm.keyExistsJson(json, _key(".rejected", i, "")); i++) {
            string memory r = _key(".rejected", i, "");
            bytes32 kind = keccak256(bytes(_str(string.concat(r, ".kind"))));
            if (kind == keccak256("genesis")) {
                uint256 chainId = vm.parseUint(_str(string.concat(r, ".chainId")));
                vm.expectRevert(
                    abi.encodeWithSelector(EventAccumulatorLib.ChainIdTooLarge.selector, chainId)
                );
                lib.chainId64(chainId);
                continue;
            }
            assertTrue(kind == keccak256("step"), "unknown rejection kind");
            string[] memory hexTopics = vm.parseJsonStringArray(json, string.concat(r, ".topics"));
            bool representable = true;
            for (uint256 t; t < hexTopics.length; t++) {
                if (vm.parseBytes(hexTopics[t]).length != 32) representable = false;
            }
            // A topic that isn't 32 bytes can't be passed as bytes32 at all:
            // the type rules it out before the library sees it.
            if (!representable) continue;
            // Arguments first: a cheatcode call between expectRevert and the
            // call under test would consume the expectation.
            bytes32[] memory topics = _topics(r);
            bytes memory data = _bytes(string.concat(r, ".data"));
            vm.expectRevert(
                abi.encodeWithSelector(EventAccumulatorLib.TopicCount.selector, topics.length)
            );
            lib.step(bytes32(0), 0, topics, data);
        }
        assertTrue(i > 0, "no rejected vectors");
    }

    // --- the deployed contract -----------------------------------------------

    function test_SlotIsTheErc7201Namespace() public pure {
        bytes32 expected = keccak256(
                abi.encode(uint256(keccak256("abolish.event-accumulator")) - 1)
            ) & ~bytes32(uint256(0xff));
        assertEq(
            expected,
            0x1073a090f5464cb55b258e445c2f90eb0f9b00fb8b1700430d20b9c53b939600,
            "ERC-7201 slot"
        );
    }

    function test_DeploymentStoresGenesis() public {
        _assertGenesis(harness);
        vm.chainId(84532);
        _assertGenesis(new AccumulatorHarness());
        vm.chainId(type(uint64).max);
        _assertGenesis(new AccumulatorHarness());
    }

    function testFuzz_ChainIdAboveU64Reverts(uint256 chainId) public {
        vm.assume(chainId > type(uint64).max);
        vm.expectRevert(
            abi.encodeWithSelector(EventAccumulatorLib.ChainIdTooLarge.selector, chainId)
        );
        lib.chainId64(chainId);
    }

    /// The stored values equal a replay of the logs the contract actually
    /// emitted, read back from the EVM: no log escapes the accumulator.
    function testFuzz_StorageMatchesReplayOfEmittedLogs(bytes32 seed, uint8 count) public {
        uint256 n = uint256(count) % 12;
        vm.recordLogs();
        for (uint256 i; i < n; i++) {
            (bytes32[] memory topics, bytes memory data) = _randomLog(seed, i);
            harness.emitLog(topics, data);
        }
        harness.emitExample(seed, n, uint256(seed) >> 1, abi.encodePacked(seed, n));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, n + 1, "one log per call");
        bytes32 acc = lib.genesis(uint64(block.chainid), address(harness));
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].emitter == address(harness), "emitter");
            acc = lib.step(acc, uint64(i), logs[i].topics, logs[i].data);
        }
        _assertStored(harness, acc, logs.length);
    }

    function test_TypedEventIsAbiDecodable() public {
        vm.recordLogs();
        harness.emitExample(bytes32(uint256(7)), 3, 42, hex"c0ffee");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics.length, 3, "three topics");
        assertEq(logs[0].topics[0], AccumulatorHarness.Example.selector, "topic 0 is the selector");
        assertEq(logs[0].topics[1], bytes32(uint256(7)), "indexed id");
        assertEq(logs[0].topics[2], bytes32(uint256(3)), "indexed seq");
        (uint256 value, bytes memory payload) = abi.decode(logs[0].data, (uint256, bytes));
        assertEq(value, 42, "value");
        assertEq(keccak256(payload), keccak256(hex"c0ffee"), "payload");
    }

    function test_RevertedCallLeavesNoTrace() public {
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = keccak256("Ping()");
        harness.emitLog(topics, "");
        (bytes32 acc, uint64 count) = harness.eventAccumulator();
        vm.expectRevert(abi.encodeWithSelector(AccumulatorHarness.Refused.selector));
        harness.emitThenRevert(topics, "x");
        _assertStored(harness, acc, count);
    }

    function test_RejectsZeroAndFiveTopics() public {
        vm.expectRevert(abi.encodeWithSelector(EventAccumulatorLib.TopicCount.selector, 0));
        harness.emitLog(new bytes32[](0), "");
        vm.expectRevert(abi.encodeWithSelector(EventAccumulatorLib.TopicCount.selector, 5));
        harness.emitLog(new bytes32[](5), "");
        _assertStored(harness, lib.genesis(uint64(block.chainid), address(harness)), 0);
    }

    // --- helpers ---------------------------------------------------------------

    function _assertGenesis(AccumulatorHarness h) internal view {
        _assertStored(h, lib.genesis(uint64(block.chainid), address(h)), 0);
    }

    /// Checks both the getter and the raw slots a storage proof would read.
    function _assertStored(AccumulatorHarness h, bytes32 acc, uint256 count) internal view {
        (bytes32 a, uint64 c) = h.eventAccumulator();
        assertEq(a, acc, "accumulator");
        assertEq(c, count, "count");
        bytes32 slot = 0x1073a090f5464cb55b258e445c2f90eb0f9b00fb8b1700430d20b9c53b939600;
        assertEq(vm.load(address(h), slot), acc, "accumulator slot");
        assertEq(uint256(vm.load(address(h), bytes32(uint256(slot) + 1))), count, "count slot");
    }

    function _randomLog(bytes32 seed, uint256 i)
        internal
        pure
        returns (bytes32[] memory topics, bytes memory data)
    {
        bytes32 r = keccak256(abi.encode(seed, i));
        topics = new bytes32[](uint256(r) % 4 + 1);
        for (uint256 t; t < topics.length; t++) {
            topics[t] = keccak256(abi.encode(r, t));
        }
        data = new bytes(uint256(r >> 8) % 100);
        for (uint256 b; b < data.length; b++) {
            data[b] = r[b % 32];
        }
    }

    function _tagFromPrefix() internal pure returns (string memory) {
        bytes memory p = EventAccumulatorLib.DS_PREFIX;
        assertEq(uint8(p[0]), p.length - 1, "length byte");
        bytes memory tag = new bytes(p.length - 1);
        for (uint256 i; i < tag.length; i++) {
            tag[i] = p[i + 1];
        }
        return string(tag);
    }

    function _key(string memory base, uint256 i, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(base, "[", vm.toString(i), "]", field);
    }

    function _str(string memory key) internal view returns (string memory) {
        return vm.parseJsonString(json, key);
    }

    function _bytes(string memory key) internal view returns (bytes memory) {
        string memory h = _str(key);
        // The vectors write empty bytes as "", which parseBytes refuses.
        return bytes(h).length == 0 ? bytes("") : vm.parseBytes(h);
    }

    function _bytes32(string memory key) internal view returns (bytes32) {
        bytes memory b = _bytes(key);
        assertEq(b.length, 32, "expected 32 bytes");
        return bytes32(b);
    }

    function _address(string memory key) internal view returns (address) {
        bytes memory b = _bytes(key);
        assertEq(b.length, 20, "expected 20 bytes");
        return address(bytes20(b));
    }

    function _topics(string memory logKey) internal view returns (bytes32[] memory topics) {
        string[] memory hexTopics = vm.parseJsonStringArray(json, string.concat(logKey, ".topics"));
        topics = new bytes32[](hexTopics.length);
        for (uint256 t; t < hexTopics.length; t++) {
            bytes memory b = vm.parseBytes(hexTopics[t]);
            assertEq(b.length, 32, "topic length");
            topics[t] = bytes32(b);
        }
    }
}
