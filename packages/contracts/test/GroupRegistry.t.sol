// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {GroupRegistry, GroupRegistryLib} from "../src/GroupRegistry.sol";
import {ITrusteePanels} from "../src/NullifierKey.sol";
import {DefinitionHarness, MockTrusteeRegistry} from "./utils/DefinitionHarness.sol";
import {GroupFixture, GroupHarness} from "./utils/GroupFixture.sol";
import {NullifierKeyFixture} from "./utils/NullifierKeyFixture.sol";
import {RegistryFixture} from "./utils/RegistryFixture.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// Shared helpers: refusals, the accumulator replay and the text detector.
abstract contract GroupTestBase is TestBase {
    function _call(GroupRegistry registry, bytes4 selector, bytes memory record)
        internal
        returns (bool ok, bytes memory ret)
    {
        return address(registry).call(abi.encodeWithSelector(selector, record));
    }

    function _assertRefused(bool ok, bytes memory ret, bytes memory expected, string memory id)
        internal
        pure
    {
        assertTrue(!ok, string.concat(id, ": accepted"));
        assertTrue(keccak256(ret) == keccak256(expected), string.concat(id, ": wrong error"));
    }

    function _expectAddRefused(GroupRegistry registry, bytes memory record, bytes memory expected)
        internal
    {
        (bool ok, bytes memory ret) = _call(registry, GroupRegistry.addMembers.selector, record);
        _assertRefused(ok, ret, expected, "addMembers");
    }

    function _expectRemoveRefused(
        GroupRegistry registry,
        bytes memory record,
        bytes memory expected
    ) internal {
        (bool ok, bytes memory ret) = _call(registry, GroupRegistry.removeMembers.selector, record);
        _assertRefused(ok, ret, expected, "removeMembers");
    }

    /// The accumulator replayed over `logs`, every log since deployment.
    function _assertAccumulated(GroupRegistry registry, Vm.Log[] memory logs) internal view {
        bytes32 acc = EventAccumulatorLib.genesis(uint64(block.chainid), address(registry));
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(registry)) continue;
            acc = EventAccumulatorLib.step(
                acc, uint64(n++), block.number, block.timestamp, logs[i].topics, logs[i].data
            );
        }
        (bytes32 stored, uint64 count) = registry.eventAccumulator();
        assertEq(stored, acc, "accumulator");
        assertEq(count, n, "accumulator count");
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

    /// Whether `needle` (32 bytes) occurs anywhere in `hay`, at any alignment.
    function _contains(bytes memory hay, bytes32 needle) internal pure returns (bool) {
        if (hay.length < 32) return false;
        for (uint256 i; i + 32 <= hay.length; i++) {
            bytes32 w;
            assembly ("memory-safe") {
                w := mload(add(add(hay, 0x20), i))
            }
            if (w == needle) return true;
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

/// The group registry against docs/spec/vectors/group-registry.json, an
/// independent Python implementation of docs/spec/contracts.md (Group
/// registry): its domain and type hashes, every valid record accepted with
/// its digest and signers, every rejected record refused with its error, and
/// the forbidden commitments (T-06, T-31, T-17, T-30, T-32).
contract GroupRegistryVectorsTest is GroupTestBase {
    GroupHarness internal lib;
    string internal json;
    uint256[] internal secrets;
    address[] internal registrarAddrs;
    uint8 internal threshold;

    function setUp() public {
        lib = new GroupHarness();
        json = vm.readFile(GroupFixture.VECTORS);
        (secrets, registrarAddrs, threshold) = GroupFixture.keys(json);
    }

    function test_VectorFileFormatAndConstants() public view {
        assertTrue(
            keccak256(bytes(vm.parseJsonString(json, ".format")))
                == keccak256("abolish-group-registry-vectors/1"),
            "format"
        );
        assertEq(vm.parseJsonUint(json, ".constants.maxBatch"), GroupRegistryLib.MAX_BATCH, "batch");
        assertEq(
            vm.parseJsonUint(json, ".constants.maxRegistrars"),
            GroupRegistryLib.MAX_REGISTRARS,
            "registrars"
        );
        assertEq(_word(".constants.fieldModulus"), bytes32(GroupRegistryLib.R), "r");
        assertEq(
            _word(".constants.poseidon2_0_1"), bytes32(GroupRegistryLib.POSEIDON2_0_1), "poseidon"
        );
        // Each registrar address is its secret key's.
        for (uint256 i; i < secrets.length; i++) {
            assertTrue(vm.addr(secrets[i]) == registrarAddrs[i], "registrar address");
        }
    }

    /// The type hashes are those of the type strings the vectors give, and
    /// the domain separator is the vectors' for their chain and address.
    function test_DomainAndTypeHashes() public view {
        (bytes32 domainType, bytes32 addType, bytes32 removeType) = lib.typeHashes();
        assertEq(domainType, _word(".domain.typeHash"), "domain type hash");
        assertEq(addType, _word(".types.AddMembers.typeHash"), "AddMembers type hash");
        assertEq(
            addType,
            keccak256(bytes(vm.parseJsonString(json, ".types.AddMembers.type"))),
            "AddMembers type"
        );
        assertEq(removeType, _word(".types.RemoveMembers.typeHash"), "RemoveMembers type hash");
        assertEq(
            removeType,
            keccak256(bytes(vm.parseJsonString(json, ".types.RemoveMembers.type"))),
            "RemoveMembers type"
        );
        assertTrue(
            keccak256(bytes(vm.parseJsonString(json, ".domain.name")))
                == keccak256("Abolish group registry"),
            "name"
        );
        assertTrue(
            keccak256(bytes(vm.parseJsonString(json, ".domain.version"))) == keccak256("1"),
            "version"
        );
        assertEq(vm.parseJsonUint(json, ".domain.chainId"), GroupFixture.VECTOR_CHAIN_ID, "chain");
        assertTrue(
            address(bytes20(vm.parseBytes(vm.parseJsonString(json, ".domain.verifyingContract"))))
                == GroupFixture.VECTOR_REGISTRY,
            "verifying contract"
        );
        assertEq(
            lib.domainSeparator(GroupFixture.VECTOR_CHAIN_ID, GroupFixture.VECTOR_REGISTRY),
            _word(".domain.separator"),
            "separator"
        );
    }

    /// A registry deployed at the vectors' chain and address has their domain.
    function test_DeployedRegistryHasTheVectorDomain() public {
        GroupRegistry registry = _deployAtVectorAddress();
        assertEq(registry.domainSeparator(), _word(".domain.separator"), "separator");
    }

    /// Every valid addition: its digest is the vectors', each approval
    /// recovers its seat's registrar, its record is the layout of its
    /// fields, and the registry, in a state where its group and position are
    /// right, accepts it and logs the whole record.
    function test_AdditionVectors() public {
        GroupRegistry registry = _deployAtVectorAddress();
        // The first two land in a group created by a call, one after the other.
        registry.createGroup(0);
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".additions", i, "")); i++) {
            _checkAddition(registry, _at(".additions", i, ""));
        }
        assertTrue(i >= 5, "addition vector coverage");
    }

    /// Every valid removal, likewise, in a group holding its indices.
    function test_RemovalVectors() public {
        GroupRegistry registry = _deployAtVectorAddress();
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".removals", i, "")); i++) {
            _checkRemoval(registry, _at(".removals", i, ""));
        }
        assertTrue(i >= 2, "removal vector coverage");
    }

    struct Vector {
        string id;
        uint64 groupId;
        uint8 tier;
        /// `first_index` for an addition, `size` for a removal.
        uint64 firstIndex;
        uint256[] words;
        bytes32 digest;
        bytes record;
    }

    function _vector(GroupRegistry registry, string memory at, bool add)
        internal
        view
        returns (Vector memory v)
    {
        v.id = vm.parseJsonString(json, string.concat(at, ".id"));
        v.groupId = uint64(vm.parseJsonUint(json, string.concat(at, ".groupId")));
        v.tier = uint8(vm.parseJsonUint(json, string.concat(at, ".tier")));
        bytes32 structHash;
        if (add) {
            v.firstIndex = uint64(vm.parseJsonUint(json, string.concat(at, ".firstIndex")));
            string[] memory hex_ = vm.parseJsonStringArray(json, string.concat(at, ".commitments"));
            v.words = new uint256[](hex_.length);
            for (uint256 k; k < hex_.length; k++) {
                v.words[k] = uint256(bytes32(vm.parseBytes(hex_[k])));
            }
            structHash = lib.addMembersHash(
                v.groupId, v.tier, v.firstIndex, keccak256(abi.encodePacked(v.words))
            );
        } else {
            v.firstIndex = uint64(vm.parseJsonUint(json, string.concat(at, ".size")));
            v.words = vm.parseJsonUintArray(json, string.concat(at, ".indices"));
            structHash = lib.removeMembersHash(
                v.groupId, v.tier, v.firstIndex, keccak256(abi.encodePacked(v.words))
            );
        }
        assertEq(structHash, _word(string.concat(at, ".structHash")), v.id);
        v.digest = lib.digest(registry.domainSeparator(), structHash);
        assertEq(v.digest, _word(string.concat(at, ".digest")), v.id);
        v.record = vm.parseBytes(vm.parseJsonString(json, string.concat(at, ".record")));
    }

    function _checkAddition(GroupRegistry registry, string memory at) internal {
        Vector memory v = _vector(registry, at, true);
        GroupFixture.Approval[] memory a = _vectorApprovals(at, v.digest);
        assertTrue(
            keccak256(v.record)
                == keccak256(GroupFixture.encodeAdd(v.groupId, v.firstIndex, v.words, a)),
            v.id
        );
        (, bool exists, uint64 count) = registry.groupOf(v.groupId);
        if (!exists || count != v.firstIndex) {
            GroupFixture.setGroup(registry, v.groupId, v.tier, true, v.firstIndex);
        }
        vm.recordLogs();
        registry.addMembers(v.record);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, v.id);
        assertEq(logs[0].topics.length, 3, v.id);
        assertEq(logs[0].topics[0], GroupRegistry.MembersAdded.selector, v.id);
        assertEq(logs[0].topics[1], bytes32(uint256(v.groupId)), v.id);
        assertEq(logs[0].topics[2], bytes32(uint256(v.firstIndex)), v.id);
        assertTrue(keccak256(logs[0].data) == keccak256(abi.encode(v.record)), v.id);
        (,, count) = registry.groupOf(v.groupId);
        assertEq(count, v.firstIndex + v.words.length, v.id);
        // The same record again is a replay at a stale position.
        _expectAddRefused(
            registry,
            v.record,
            abi.encodeWithSelector(GroupRegistry.WrongPosition.selector, v.firstIndex, count)
        );
    }

    function _checkRemoval(GroupRegistry registry, string memory at) internal {
        Vector memory v = _vector(registry, at, false);
        uint256 n = v.words.length;
        uint64[] memory idx = new uint64[](n);
        for (uint256 k; k < n; k++) {
            idx[k] = uint64(v.words[k]);
        }
        GroupFixture.Approval[] memory a = _vectorApprovals(at, v.digest);
        assertTrue(
            keccak256(v.record)
                == keccak256(GroupFixture.encodeRemove(v.groupId, v.firstIndex, idx, a)),
            v.id
        );
        // Refused while the group is below the signed size, accepted at it.
        uint64 count = v.firstIndex;
        GroupFixture.setGroup(registry, v.groupId, v.tier, true, count - 1);
        _expectRemoveRefused(
            registry,
            v.record,
            abi.encodeWithSelector(GroupRegistry.SizeBeyondCount.selector, count, count - 1)
        );
        GroupFixture.setGroup(registry, v.groupId, v.tier, true, count);
        vm.recordLogs();
        registry.removeMembers(v.record);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, v.id);
        assertEq(logs[0].topics.length, 2, v.id);
        assertEq(logs[0].topics[0], GroupRegistry.MembersRemoved.selector, v.id);
        assertEq(logs[0].topics[1], bytes32(uint256(v.groupId)), v.id);
        assertTrue(keccak256(logs[0].data) == keccak256(abi.encode(v.record)), v.id);
        for (uint256 k; k < n; k++) {
            assertTrue(registry.isRemoved(v.groupId, idx[k]), v.id);
            // Only the named leaves: the one below each, if not named, stays.
            if (idx[k] > 0 && (k == 0 || idx[k - 1] != idx[k] - 1)) {
                assertTrue(!registry.isRemoved(v.groupId, idx[k] - 1), v.id);
            }
        }
        (,, uint64 after_) = registry.groupOf(v.groupId);
        assertEq(after_, count, "a removal never lowers the count");
        _expectRemoveRefused(
            registry,
            v.record,
            abi.encodeWithSelector(GroupRegistry.AlreadyRemoved.selector, idx[0])
        );
    }

    /// Each group history a verifier replays: a fresh registry at the vectors'
    /// address accepts every record of a history the verifier accepts, ending
    /// with its count and removed leaves, and refuses a rejected history's
    /// record `at` after accepting those before it, so the contract refuses
    /// exactly the histories the verifier rejects. `omitted-tail`, a shorter
    /// history that still checks (the T-71 residual), is accepted like any
    /// other (docs/spec/contracts.md, Group registry, Verification).
    function test_SequenceVectors() public {
        uint256 i;
        uint256 rejected;
        // Each sequence starts from this state, so its registry is the
        // deployer's first contract, at the vectors' address.
        uint256 fresh = vm.snapshotState();
        for (; vm.keyExistsJson(json, _at(".sequences", i, "")); i++) {
            if (_checkSequence(_at(".sequences", i, ""))) rejected++;
            assertTrue(vm.revertToState(fresh), "revert to the fresh state");
        }
        assertTrue(i >= 3 && rejected > 0 && rejected < i, "sequence vector coverage");
    }

    /// Replays one sequence; returns whether it is a rejected history.
    function _checkSequence(string memory at) internal returns (bool rejected) {
        string memory id = vm.parseJsonString(json, string.concat(at, ".id"));
        assertEq(vm.parseJsonUint(json, string.concat(at, ".groupId")), 0, id);
        GroupRegistry registry = _deployAtVectorAddress();
        registry.createGroup(0);
        rejected = vm.keyExistsJson(json, string.concat(at, ".error"));
        uint256 failAt =
            rejected ? vm.parseJsonUint(json, string.concat(at, ".at")) : type(uint256).max;
        string memory records = string.concat(at, ".records");
        uint256 n;
        for (; vm.keyExistsJson(json, _at(records, n, "")); n++) {
            bool add = keccak256(bytes(vm.parseJsonString(json, _at(records, n, ".kind"))))
                == keccak256("add");
            bytes memory record =
                vm.parseBytes(vm.parseJsonString(json, _at(records, n, ".record")));
            (bool ok, bytes memory ret) = _call(
                registry,
                add ? GroupRegistry.addMembers.selector : GroupRegistry.removeMembers.selector,
                record
            );
            if (n < failAt) {
                assertTrue(ok, string.concat(id, ": record refused at ", vm.toString(n)));
                continue;
            }
            assertTrue(!ok, string.concat(id, ": rejected record accepted"));
            bytes4 expected = _historyError(vm.parseJsonString(json, string.concat(at, ".reason")));
            // A record with two faults reports the verifier's first (the
            // spec's report order); the registry may revert on the other, as
            // its own checks run in another order. Only refusal is asserted.
            if (keccak256(bytes(id)) == keccak256("two-faults")) expected = bytes4(0);
            if (expected != bytes4(0)) {
                assertTrue(ret.length >= 4 && bytes4(ret) == expected, string.concat(id, ": error"));
            }
            return rejected;
        }
        assertTrue(!rejected, string.concat(id, ": no record at `at`"));

        string[] memory leaves = vm.parseJsonStringArray(json, string.concat(at, ".leaves"));
        (,, uint64 count) = registry.groupOf(0);
        assertEq(count, vm.parseJsonUint(json, string.concat(at, ".count")), id);
        assertEq(count, leaves.length, id);
        for (uint256 k; k < leaves.length; k++) {
            bool zero = bytes32(vm.parseBytes(leaves[k])) == bytes32(0);
            assertTrue(registry.isRemoved(0, uint64(k)) == zero, string.concat(id, ": leaf"));
        }
    }

    /// The registry's error for a history `reason`, or zero where none maps cleanly.
    function _historyError(string memory reason) internal pure returns (bytes4) {
        bytes32 r = keccak256(bytes(reason));
        if (r == keccak256("position")) return GroupRegistry.WrongPosition.selector;
        if (r == keccak256("size")) return GroupRegistry.SizeBeyondCount.selector;
        if (r == keccak256("removed")) return GroupRegistry.AlreadyRemoved.selector;
        if (r == keccak256("index-range")) return GroupRegistry.IndexBeyondSize.selector;
        if (r == keccak256("approvals")) return GroupRegistry.TooFewApprovals.selector;
        if (r == keccak256("forbidden-commitment")) {
            return GroupRegistry.ForbiddenCommitment.selector;
        }
        return bytes4(0);
    }

    /// Every rejected record is refused with the error the vectors give: group
    /// 0 is empty for additions (so their position is right) and holds four
    /// members for removals (at least every vector's signed size, so the size
    /// check passes and the check each vector breaks is the one that fires).
    function test_RejectedVectors() public {
        GroupRegistry registry = _deployAtVectorAddress();
        registry.createGroup(0);
        uint256 i;
        for (; vm.keyExistsJson(json, _at(".rejected", i, "")); i++) {
            string memory id = vm.parseJsonString(json, _at(".rejected", i, ".id"));
            bool add = keccak256(bytes(vm.parseJsonString(json, _at(".rejected", i, ".kind"))))
                == keccak256("add");
            string memory hexRecord = vm.parseJsonString(json, _at(".rejected", i, ".record"));
            bytes memory record =
                bytes(hexRecord).length == 0 ? bytes("") : vm.parseBytes(hexRecord);
            GroupFixture.setGroup(registry, 0, 0, true, add ? 0 : 4);
            (bool ok, bytes memory ret) = _call(
                registry,
                add ? GroupRegistry.addMembers.selector : GroupRegistry.removeMembers.selector,
                record
            );
            _assertRefused(ok, ret, _expectedError(i, add, record), id);
        }
        assertTrue(i >= 40, "rejected vector coverage");
    }

    /// Each boundary commitment is refused exactly when the vectors mark it
    /// forbidden, by the library and by the registry, alone in a signed batch.
    function test_CommitmentVectors() public {
        GroupRegistry registry = new GroupRegistry(
            threshold,
            registrarAddrs,
            NullifierKeyFixture.trustees(),
            NullifierKeyFixture.INITIAL_PANEL
        );
        registry.createGroup(0);
        uint256 i;
        uint256 refused;
        for (; vm.keyExistsJson(json, _at(".commitments", i, "")); i++) {
            uint256 c = uint256(_word(_at(".commitments", i, ".value")));
            bool forbidden = vm.parseJsonBool(json, _at(".commitments", i, ".forbidden"));
            assertTrue(lib.forbidden(c) == forbidden, "library");
            uint256[] memory batch = new uint256[](1);
            batch[0] = c;
            bytes memory record =
                GroupFixture.addition(registry, secrets, GroupFixture.seats(1, 2), 0, batch);
            if (forbidden) {
                _expectAddRefused(
                    registry,
                    record,
                    abi.encodeWithSelector(GroupRegistry.ForbiddenCommitment.selector, 0)
                );
                refused++;
            } else {
                registry.addMembers(record);
            }
        }
        assertTrue(refused >= 5 && refused < i, "commitment vector coverage");
    }

    function _expectedError(uint256 i, bool add, bytes memory record)
        internal
        view
        returns (bytes memory)
    {
        bytes32 e = keccak256(bytes(vm.parseJsonString(json, _at(".rejected", i, ".error"))));
        if (e == keccak256("length")) {
            return abi.encodeWithSelector(GroupRegistry.MalformedRecord.selector);
        }
        uint256 count = uint16(bytes2(_slice(record, 16, 2)));
        uint256 itemsEnd = add ? 18 + 32 * count : 18 + 8 * count;
        if (e == keccak256("batch")) {
            return abi.encodeWithSelector(GroupRegistry.BatchSize.selector, count);
        }
        if (e == keccak256("forbidden-commitment")) {
            // The first forbidden commitment, found by the vectors' own list.
            for (uint256 k; k < count; k++) {
                if (_listedForbidden(bytes32(_slice(record, 18 + 32 * k, 32)))) {
                    return abi.encodeWithSelector(GroupRegistry.ForbiddenCommitment.selector, k);
                }
            }
            revert("no forbidden commitment in the record");
        }
        if (e == keccak256("index-order")) {
            for (uint256 k = 1; k < count; k++) {
                if (
                    uint64(bytes8(_slice(record, 18 + 8 * k, 8)))
                        <= uint64(bytes8(_slice(record, 10 + 8 * k, 8)))
                ) return abi.encodeWithSelector(GroupRegistry.IndicesOutOfOrder.selector, k);
            }
            revert("indices in order");
        }
        if (e == keccak256("index-range")) {
            uint64 size = uint64(bytes8(_slice(record, 8, 8)));
            for (uint256 k; k < count; k++) {
                uint64 index = uint64(bytes8(_slice(record, 18 + 8 * k, 8)));
                if (index >= size) {
                    return abi.encodeWithSelector(GroupRegistry.IndexBeyondSize.selector, index);
                }
            }
            revert("indices below size");
        }
        if (e == keccak256("approvals")) {
            return abi.encodeWithSelector(
                GroupRegistry.TooFewApprovals.selector, uint8(record[itemsEnd]), threshold
            );
        }
        uint8 seat = uint8(vm.parseJsonUint(json, _at(".rejected", i, ".seat")));
        if (e == keccak256("seat")) {
            return abi.encodeWithSelector(GroupRegistry.InvalidSeat.selector, seat);
        }
        if (e == keccak256("signature")) {
            return abi.encodeWithSelector(GroupRegistry.InvalidSignature.selector, seat);
        }
        revert(string.concat("unknown error code in ", vm.toString(i)));
    }

    function _listedForbidden(bytes32 c) internal view returns (bool) {
        for (uint256 i; vm.keyExistsJson(json, _at(".commitments", i, "")); i++) {
            if (_word(_at(".commitments", i, ".value")) == c) {
                return vm.parseJsonBool(json, _at(".commitments", i, ".forbidden"));
            }
        }
        // Not a boundary value: forbidden only if it isn't a field element.
        return uint256(c) >= GroupRegistryLib.R;
    }

    /// A vector's approvals, each checked to recover its seat's registrar
    /// (`signer`) from `digest` with plain `ecrecover`.
    function _vectorApprovals(string memory at, bytes32 digest)
        internal
        view
        returns (GroupFixture.Approval[] memory a)
    {
        string memory base = string.concat(at, ".approvals");
        uint256 n;
        while (vm.keyExistsJson(json, _at(base, n, ""))) n++;
        a = new GroupFixture.Approval[](n);
        for (uint256 k; k < n; k++) {
            a[k] = GroupFixture.Approval({
                seat: uint8(vm.parseJsonUint(json, _at(base, k, ".seat"))),
                r: _word(_at(base, k, ".r")),
                s: _word(_at(base, k, ".s")),
                v: uint8(vm.parseJsonUint(json, _at(base, k, ".v")))
            });
            address signer =
                address(bytes20(vm.parseBytes(vm.parseJsonString(json, _at(base, k, ".signer")))));
            assertTrue(signer == registrarAddrs[a[k].seat - 1], "signer is the seat's registrar");
            assertTrue(ecrecover(digest, a[k].v, a[k].r, a[k].s) == signer, "signer recovers");
            assertTrue(uint256(a[k].s) <= GroupRegistryLib.HALF_N, "low s");
        }
    }

    /// Deploys the registry at the vectors' address on their chain, the way
    /// Anvil's first deployment lands there (CREATE from `DEPLOYER` at nonce 0).
    function _deployAtVectorAddress() internal returns (GroupRegistry registry) {
        vm.chainId(GroupFixture.VECTOR_CHAIN_ID);
        // Before the prank, which the trustee registry's creation would take.
        ITrusteePanels trustees = NullifierKeyFixture.trustees();
        vm.prank(GroupFixture.DEPLOYER);
        registry = new GroupRegistry(
            threshold, registrarAddrs, trustees, NullifierKeyFixture.INITIAL_PANEL
        );
        assertTrue(address(registry) == GroupFixture.VECTOR_REGISTRY, "deployment address");
    }

    function _word(string memory key) internal view returns (bytes32) {
        bytes memory b = vm.parseBytes(vm.parseJsonString(json, key));
        assertEq(b.length, 32, key);
        return bytes32(b);
    }

    function _at(string memory list, uint256 i, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(list, "[", vm.toString(i), "]", field);
    }
}

/// The group registry of docs/spec/contracts.md (Group registry): its
/// deployment checks, group creation, each refusal of an addition or a
/// removal including the stateful ones, the domain, and the rules that keep
/// personal data and poll links off chain (T-06, T-62, T-71, T-08, T-13,
/// T-31, T-17, T-52, T-12).
contract GroupRegistryTest is GroupTestBase {
    string internal json;
    uint256[] internal secrets;
    address[] internal registrarAddrs;
    uint8 internal threshold;
    GroupRegistry internal registry;

    function setUp() public {
        json = vm.readFile(GroupFixture.VECTORS);
        (secrets, registrarAddrs, threshold) = GroupFixture.keys(json);
        registry = new GroupRegistry(
            threshold,
            registrarAddrs,
            NullifierKeyFixture.trustees(),
            NullifierKeyFixture.INITIAL_PANEL
        );
        registry.createGroup(0);
    }

    // --- deployment --------------------------------------------------------------

    function test_DeploymentPinsRegistrarsAndLogsThemFirst() public {
        ITrusteePanels trustees = NullifierKeyFixture.trustees();
        vm.recordLogs();
        GroupRegistry reg = new GroupRegistry(
            threshold, registrarAddrs, trustees, NullifierKeyFixture.INITIAL_PANEL
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics.length, 1, "topics");
        assertEq(logs[0].topics[0], GroupRegistry.RegistrarsPinned.selector, "topic 0");
        assertTrue(
            keccak256(logs[0].data) == keccak256(abi.encode(threshold, registrarAddrs)), "data"
        );
        assertEq(reg.threshold(), threshold, "threshold");
        address[] memory pinned = reg.registrars();
        assertEq(pinned.length, registrarAddrs.length, "registrar count");
        for (uint256 i; i < pinned.length; i++) {
            assertTrue(pinned[i] == registrarAddrs[i], "registrar");
        }
        assertEq(reg.groupCount(), 0, "no groups");
        _assertAccumulated(reg, logs);
    }

    function test_DeploymentRefusesTheWrongSize() public {
        _expectDeployRefused(2, _ascending(0), GroupRegistry.RegistrarError.Size);
        _expectDeployRefused(2, _ascending(1), GroupRegistry.RegistrarError.Size);
        _expectDeployRefused(2, _ascending(17), GroupRegistry.RegistrarError.Size);
        new GroupRegistry(
            2, _ascending(2), NullifierKeyFixture.trustees(), NullifierKeyFixture.INITIAL_PANEL
        );
        new GroupRegistry(
            16, _ascending(16), NullifierKeyFixture.trustees(), NullifierKeyFixture.INITIAL_PANEL
        );
    }

    function test_DeploymentRefusesTheWrongThreshold() public {
        _expectDeployRefused(0, _ascending(3), GroupRegistry.RegistrarError.Threshold);
        _expectDeployRefused(1, _ascending(3), GroupRegistry.RegistrarError.Threshold);
        _expectDeployRefused(4, _ascending(3), GroupRegistry.RegistrarError.Threshold);
        new GroupRegistry(
            3, _ascending(3), NullifierKeyFixture.trustees(), NullifierKeyFixture.INITIAL_PANEL
        );
    }

    function test_DeploymentRefusesUnorderedRepeatedOrZeroAddresses() public {
        address[] memory a = _ascending(3);
        (a[1], a[2]) = (a[2], a[1]);
        _expectDeployRefused(2, a, GroupRegistry.RegistrarError.Order);
        a = _ascending(3);
        a[2] = a[1];
        _expectDeployRefused(2, a, GroupRegistry.RegistrarError.Order);
        a = _ascending(3);
        a[0] = address(0);
        _expectDeployRefused(2, a, GroupRegistry.RegistrarError.Order);
    }

    /// The checks run in the spec's order: size, threshold, order.
    function test_DeploymentChecksRunInOrder() public {
        address[] memory unordered = new address[](17);
        // Unordered (all zero), too many, and a threshold above n.
        _expectDeployRefused(18, unordered, GroupRegistry.RegistrarError.Size);
        unordered = new address[](3);
        _expectDeployRefused(4, unordered, GroupRegistry.RegistrarError.Threshold);
        _expectDeployRefused(2, unordered, GroupRegistry.RegistrarError.Order);
    }

    // --- groups --------------------------------------------------------------------

    function test_CreateGroupNumbersGroupsAndLogsTheirTier() public {
        vm.recordLogs();
        vm.prank(address(0xBEEF));
        uint64 id = registry.createGroup(0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(id, 1, "second group");
        assertEq(registry.groupCount(), 2, "count");
        (uint8 tier, bool exists, uint64 members) = registry.groupOf(1);
        assertTrue(tier == 0 && exists && members == 0, "record");
        (, exists,) = registry.groupOf(2);
        assertTrue(!exists, "next group");
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics.length, 3, "topics");
        assertEq(logs[0].topics[0], GroupRegistry.GroupCreated.selector, "topic 0");
        assertEq(logs[0].topics[1], bytes32(uint256(1)), "group topic");
        assertEq(logs[0].topics[2], bytes32(0), "tier topic");
        assertEq(logs[0].data.length, 0, "no data");
    }

    function test_CreateGroupTakesTierOneAndRecordsItsBlock() public {
        vm.roll(4_321);
        vm.recordLogs();
        uint64 id = registry.createGroup(1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint8 tier, bool exists, uint64 members) = registry.groupOf(id);
        assertTrue(tier == 1 && exists && members == 0, "record");
        assertEq(registry.groupCreatedBlock(id), 4_321, "created block");
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics[2], bytes32(uint256(1)), "tier topic");
    }

    function test_CreateGroupRefusesTiersWithoutAnAdditionPath() public {
        uint8[2] memory tiers = [2, 255];
        for (uint256 i; i < 2; i++) {
            (bool ok, bytes memory ret) =
                address(registry).call(abi.encodeCall(GroupRegistry.createGroup, (tiers[i])));
            _assertRefused(
                ok,
                ret,
                abi.encodeWithSelector(GroupRegistry.UnsupportedTier.selector, tiers[i]),
                "tier"
            );
        }
        assertEq(registry.groupCount(), 1, "nothing created");
    }

    function test_CreateGroupRefusesAnyOtherCalldata() public {
        bytes memory canonical = abi.encodeCall(GroupRegistry.createGroup, (0));
        bytes memory refusal =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        (bool ok, bytes memory ret) = address(registry).call(bytes.concat(canonical, hex"00"));
        _assertRefused(ok, ret, refusal, "long");
        (ok, ret) = address(registry).call(bytes.concat(canonical, bytes32(0)));
        _assertRefused(ok, ret, refusal, "extra word");
        // Too short for the ABI decoder, and a tier word with high bits set.
        (ok,) = address(registry).call(_slice(canonical, 0, 35));
        assertTrue(!ok, "short");
        (ok,) = address(registry)
            .call(abi.encodePacked(GroupRegistry.createGroup.selector, uint256(256)));
        assertTrue(!ok, "dirty tier word");
        (ok,) = address(registry).call(canonical);
        assertTrue(ok, "canonical");
    }

    /// Group identifiers stay in the u64 range: group 2⁶⁴ − 1 can be created,
    /// and nothing after it.
    function test_CreateGroupStopsAtTheLastU64() public {
        GroupFixture.setGroupCount(registry, type(uint64).max);
        assertEq(registry.createGroup(0), type(uint64).max, "last id");
        (, bool exists,) = registry.groupOf(type(uint64).max);
        assertTrue(exists, "created");
        (bool ok, bytes memory ret) =
            address(registry).call(abi.encodeCall(GroupRegistry.createGroup, (0)));
        _assertRefused(
            ok, ret, abi.encodeWithSelector(GroupRegistry.TooManyGroups.selector), "overflow"
        );
    }

    // --- additions -----------------------------------------------------------------

    function test_AddsMembersAtTheRunningCount() public {
        vm.recordLogs();
        for (uint256 b; b < 3; b++) {
            bytes memory record = _addition(0, GroupFixture.commitments(b, 2 + b));
            vm.prank(address(uint160(0xA000 + b)));
            registry.addMembers(record);
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (,, uint64 count) = registry.groupOf(0);
        assertEq(count, 2 + 3 + 4, "count");
        assertEq(logs.length, 3, "logs");
        assertEq(logs[2].topics[2], bytes32(uint256(5)), "third batch's first index");
        _assertAccumulatedFromSetUp(logs);
    }

    function test_EveryApprovalMustVerifyEvenBeyondTheThreshold() public {
        uint256[] memory c = GroupFixture.commitments(1, 1);
        bytes32 d = GroupFixture.addDigest(registry, 0, 0, 0, c);
        GroupFixture.Approval[] memory a =
            GroupFixture.approve(secrets, GroupFixture.seats(1, 2, 3), d);
        a[2].s = bytes32(uint256(a[2].s) ^ 1);
        _expectAddRefused(
            registry,
            GroupFixture.encodeAdd(0, 0, c, a),
            abi.encodeWithSelector(GroupRegistry.InvalidSignature.selector, 3)
        );
        a = GroupFixture.approve(secrets, GroupFixture.seats(1, 2, 3), d);
        registry.addMembers(GroupFixture.encodeAdd(0, 0, c, a));
    }

    function test_RefusesAnUnknownGroupOrAnotherTier() public {
        bytes memory record = _addition(0, GroupFixture.commitments(1, 1));
        // The record names group 0; make it not exist, then another tier.
        GroupFixture.setGroup(registry, 0, 0, false, 0);
        _expectAddRefused(
            registry, record, abi.encodeWithSelector(GroupRegistry.UnknownGroup.selector, 0)
        );
        GroupFixture.setGroup(registry, 0, 1, true, 0);
        _expectAddRefused(
            registry, record, abi.encodeWithSelector(GroupRegistry.WrongTier.selector, 0, 1)
        );
        // A group this registry never created.
        uint256[] memory c = GroupFixture.commitments(1, 1);
        bytes32 d = GroupFixture.addDigest(registry, 9, 0, 0, c);
        _expectAddRefused(
            registry,
            GroupFixture.encodeAdd(
                9, 0, c, GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d)
            ),
            abi.encodeWithSelector(GroupRegistry.UnknownGroup.selector, 9)
        );
    }

    function test_RefusesAnEmptyOrOversizedBatch() public {
        _expectAddRefused(
            registry,
            _addition(0, new uint256[](0)),
            abi.encodeWithSelector(GroupRegistry.BatchSize.selector, 0)
        );
        _expectAddRefused(
            registry,
            _addition(0, GroupFixture.commitments(1, 257)),
            abi.encodeWithSelector(GroupRegistry.BatchSize.selector, 257)
        );
        registry.addMembers(_addition(0, GroupFixture.commitments(1, 256)));
    }

    /// A batch lands only at the position it was signed for: not replayed,
    /// not ahead, not behind (T-06, T-13).
    function test_RefusesTheWrongPosition() public {
        bytes memory first = _addition(0, GroupFixture.commitments(1, 2));
        registry.addMembers(first);
        _expectAddRefused(
            registry, first, abi.encodeWithSelector(GroupRegistry.WrongPosition.selector, 0, 2)
        );
        uint256[] memory c = GroupFixture.commitments(2, 1);
        bytes32 d = GroupFixture.addDigest(registry, 0, 0, 3, c);
        _expectAddRefused(
            registry,
            GroupFixture.encodeAdd(
                0, 3, c, GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d)
            ),
            abi.encodeWithSelector(GroupRegistry.WrongPosition.selector, 3, 2)
        );
        // Two batches signed for one position: the second is dead.
        bytes memory a = _addition(0, GroupFixture.commitments(3, 1));
        bytes memory b = _addition(0, GroupFixture.commitments(4, 1));
        registry.addMembers(b);
        _expectAddRefused(
            registry, a, abi.encodeWithSelector(GroupRegistry.WrongPosition.selector, 2, 3)
        );
    }

    /// A tier tree has 2³² leaves: a batch may fill it exactly, never past.
    function test_RefusesAPositionPastTheTreesLeaves() public {
        uint64 nearlyFull = uint64(GroupRegistryLib.MAX_MEMBERS - 1);
        GroupFixture.setGroup(registry, 0, 0, true, nearlyFull);
        _expectAddRefused(
            registry,
            _addition(0, GroupFixture.commitments(1, 2)),
            abi.encodeWithSelector(GroupRegistry.GroupFull.selector, nearlyFull, 2)
        );
        registry.addMembers(_addition(0, GroupFixture.commitments(1, 1)));
        (,, uint64 count) = registry.groupOf(0);
        assertEq(count, GroupRegistryLib.MAX_MEMBERS, "full");
        _expectAddRefused(
            registry,
            _addition(0, GroupFixture.commitments(2, 1)),
            abi.encodeWithSelector(
                GroupRegistry.GroupFull.selector, uint64(GroupRegistryLib.MAX_MEMBERS), 1
            )
        );
    }

    function test_RefusesForbiddenCommitmentsNamingTheirPosition() public {
        uint256[5] memory bad =
            [0, 1, GroupRegistryLib.POSEIDON2_0_1, GroupRegistryLib.R, type(uint256).max];
        for (uint256 i; i < bad.length; i++) {
            uint256[] memory c = GroupFixture.commitments(i, 3);
            c[2] = bad[i];
            _expectAddRefused(
                registry,
                _addition(0, c),
                abi.encodeWithSelector(GroupRegistry.ForbiddenCommitment.selector, 2)
            );
        }
    }

    /// A commitment may repeat: the registry can't refuse it without storing
    /// every commitment (docs/spec/contracts.md, Additions).
    function test_AllowsARepeatedCommitment() public {
        uint256[] memory c = GroupFixture.commitments(1, 2);
        c[1] = c[0];
        registry.addMembers(_addition(0, c));
        registry.addMembers(_addition(0, c));
    }

    function test_RefusesTooFewApprovals() public {
        uint256[] memory c = GroupFixture.commitments(1, 1);
        bytes32 d = GroupFixture.addDigest(registry, 0, 0, 0, c);
        uint8[] memory one = new uint8[](1);
        one[0] = 2;
        _expectAddRefused(
            registry,
            GroupFixture.encodeAdd(0, 0, c, GroupFixture.approve(secrets, one, d)),
            abi.encodeWithSelector(GroupRegistry.TooFewApprovals.selector, 1, 2)
        );
        _expectAddRefused(
            registry,
            GroupFixture.encodeAdd(0, 0, c, new GroupFixture.Approval[](0)),
            abi.encodeWithSelector(GroupRegistry.TooFewApprovals.selector, 0, 2)
        );
    }

    /// One registrar counts once: its second valid signature (another
    /// nonce) in another approval never makes a threshold (T-62, T-31).
    function test_RefusesRepeatedUnorderedOrUnknownSeats() public {
        uint256[] memory c = GroupFixture.commitments(1, 1);
        bytes32 d = GroupFixture.addDigest(registry, 0, 0, 0, c);
        GroupFixture.Approval[] memory a =
            GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d);
        a[1] = a[0];
        _expectAddRefused(
            registry,
            GroupFixture.encodeAdd(0, 0, c, a),
            abi.encodeWithSelector(GroupRegistry.InvalidSeat.selector, 1)
        );
        a = GroupFixture.approve(secrets, GroupFixture.seats(2, 1), d);
        _expectAddRefused(
            registry,
            GroupFixture.encodeAdd(0, 0, c, a),
            abi.encodeWithSelector(GroupRegistry.InvalidSeat.selector, 1)
        );
        a = GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d);
        a[0].seat = 0;
        _expectAddRefused(
            registry,
            GroupFixture.encodeAdd(0, 0, c, a),
            abi.encodeWithSelector(GroupRegistry.InvalidSeat.selector, 0)
        );
        a = GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d);
        a[1].seat = 4;
        _expectAddRefused(
            registry,
            GroupFixture.encodeAdd(0, 0, c, a),
            abi.encodeWithSelector(GroupRegistry.InvalidSeat.selector, 4)
        );
    }

    function test_RefusesSignaturesThatDontVerify() public {
        uint256[] memory c = GroupFixture.commitments(1, 1);
        bytes32 d = GroupFixture.addDigest(registry, 0, 0, 0, c);
        bytes memory refusal = abi.encodeWithSelector(GroupRegistry.InvalidSignature.selector, 2);
        GroupFixture.Approval[] memory a;
        // The high-s twin, and v, r and s outside their ranges.
        a = GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d);
        a[1].s = bytes32(GroupRegistryLib.N - uint256(a[1].s));
        a[1].v = a[1].v == 27 ? 28 : 27;
        assertTrue(ecrecover(d, a[1].v, a[1].r, a[1].s) == registrarAddrs[1], "twin recovers");
        _expectAddRefused(registry, GroupFixture.encodeAdd(0, 0, c, a), refusal);
        uint8[4] memory vs = [0, 1, 26, 29];
        for (uint256 i; i < 4; i++) {
            a = GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d);
            a[1].v = vs[i];
            _expectAddRefused(registry, GroupFixture.encodeAdd(0, 0, c, a), refusal);
        }
        a = GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d);
        a[1].r = 0;
        _expectAddRefused(registry, GroupFixture.encodeAdd(0, 0, c, a), refusal);
        a = GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d);
        a[1].r = bytes32(GroupRegistryLib.N);
        _expectAddRefused(registry, GroupFixture.encodeAdd(0, 0, c, a), refusal);
        a = GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d);
        a[1].s = 0;
        _expectAddRefused(registry, GroupFixture.encodeAdd(0, 0, c, a), refusal);
        // Another seat's signature, an outsider's, and seat 2 signing another batch.
        a = GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d);
        a[1] = GroupFixture.sign(2, secrets[0], d);
        _expectAddRefused(registry, GroupFixture.encodeAdd(0, 0, c, a), refusal);
        a = GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d);
        a[1] = GroupFixture.sign(2, GroupFixture.outsider(json), d);
        _expectAddRefused(registry, GroupFixture.encodeAdd(0, 0, c, a), refusal);
        a = GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d);
        a[1] = GroupFixture.sign(
            2, secrets[1], GroupFixture.addDigest(registry, 0, 0, 0, GroupFixture.commitments(2, 1))
        );
        _expectAddRefused(registry, GroupFixture.encodeAdd(0, 0, c, a), refusal);
    }

    /// A batch signed for this group on another chain, for another
    /// registry, another tier, or as a removal, doesn't count here (T-30, T-32).
    function test_RefusesSignaturesForAnotherDomainOrMessage() public {
        uint256[] memory c = GroupFixture.commitments(1, 1);
        bytes32 commitmentsHash = keccak256(abi.encodePacked(c));
        bytes32[5] memory digests = [
            GroupRegistryLib.digest(
                GroupRegistryLib.domainSeparator(block.chainid + 1, address(registry)),
                GroupRegistryLib.addMembersHash(0, 0, 0, commitmentsHash)
            ),
            GroupRegistryLib.digest(
                GroupRegistryLib.domainSeparator(block.chainid, address(0x5EC0)),
                GroupRegistryLib.addMembersHash(0, 0, 0, commitmentsHash)
            ),
            GroupRegistryLib.digest(
                registry.domainSeparator(),
                GroupRegistryLib.addMembersHash(0, 1, 0, commitmentsHash)
            ),
            GroupRegistryLib.digest(
                registry.domainSeparator(),
                GroupRegistryLib.addMembersHash(1, 0, 0, commitmentsHash)
            ),
            GroupRegistryLib.digest(
                registry.domainSeparator(),
                GroupRegistryLib.removeMembersHash(0, 0, 0, commitmentsHash)
            )
        ];
        for (uint256 i; i < digests.length; i++) {
            _expectAddRefused(
                registry,
                GroupFixture.encodeAdd(
                    0, 0, c, GroupFixture.approve(secrets, GroupFixture.seats(1, 2), digests[i])
                ),
                abi.encodeWithSelector(GroupRegistry.InvalidSignature.selector, 1)
            );
        }
    }

    function test_RefusesMalformedAdditions() public {
        bytes memory record = _addition(0, GroupFixture.commitments(1, 2));
        bytes memory malformed = abi.encodeWithSelector(GroupRegistry.MalformedRecord.selector);
        _expectAddRefused(registry, "", malformed);
        _expectAddRefused(registry, _slice(record, 0, 18), malformed);
        // count names more commitments than the record holds.
        _expectAddRefused(registry, _slice(record, 0, 18 + 64), malformed);
        _expectAddRefused(registry, _slice(record, 0, record.length - 1), malformed);
        _expectAddRefused(registry, bytes.concat(record, hex"00"), malformed);
        bytes memory moreApprovals = bytes.concat(record);
        moreApprovals[18 + 64] = bytes1(uint8(3));
        _expectAddRefused(registry, moreApprovals, malformed);
    }

    function test_RefusesNonCanonicalCalldata() public {
        bytes memory refusal =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        // The removal first: it adds the member it removes, which moves the
        // position the addition is signed for.
        bytes memory remove = abi.encodeCall(GroupRegistry.removeMembers, (_removalAfterAdding(1)));
        bytes[2] memory canonical = [
            abi.encodeCall(
                GroupRegistry.addMembers, (_addition(0, GroupFixture.commitments(1, 1)))
            ),
            remove
        ];
        for (uint256 i; i < 2; i++) {
            (bool ok, bytes memory ret) =
                address(registry).call(bytes.concat(canonical[i], bytes32(0)));
            _assertRefused(ok, ret, refusal, "trailing word");
            // Dirty padding after the record (its length isn't a multiple of 32).
            bytes memory dirty = bytes.concat(canonical[i]);
            dirty[dirty.length - 1] = 0x01;
            (ok, ret) = address(registry).call(dirty);
            _assertRefused(ok, ret, refusal, "dirty padding");
            (ok,) = address(registry).call(canonical[i]);
            assertTrue(ok, "canonical");
        }
    }

    // --- removals ------------------------------------------------------------------

    function test_RemovesMembersWithoutRenumbering() public {
        registry.addMembers(_addition(0, GroupFixture.commitments(1, 256)));
        registry.addMembers(_addition(0, GroupFixture.commitments(2, 44)));
        uint64[] memory idx = new uint64[](3);
        (idx[0], idx[1], idx[2]) = (0, 255, 299);
        vm.recordLogs();
        registry.removeMembers(_removal(0, idx));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint64 i; i < 300; i++) {
            assertTrue(registry.isRemoved(0, i) == (i == 0 || i == 255 || i == 299), "removed");
        }
        (,, uint64 count) = registry.groupOf(0);
        assertEq(count, 300, "count unchanged");
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics[1], bytes32(0), "group topic");
        // A later addition still lands at the count.
        registry.addMembers(_addition(0, GroupFixture.commitments(2, 1)));
    }

    function test_RemovalRefusesUnknownGroupTierAndBatch() public {
        bytes memory record = _removalAfterAdding(2);
        GroupFixture.setGroup(registry, 0, 0, false, 2);
        _expectRemoveRefused(
            registry, record, abi.encodeWithSelector(GroupRegistry.UnknownGroup.selector, 0)
        );
        GroupFixture.setGroup(registry, 0, 2, true, 2);
        _expectRemoveRefused(
            registry, record, abi.encodeWithSelector(GroupRegistry.WrongTier.selector, 0, 2)
        );
        GroupFixture.setGroup(registry, 0, 0, true, 300);
        _expectRemoveRefused(
            registry,
            _removal(0, new uint64[](0)),
            abi.encodeWithSelector(GroupRegistry.BatchSize.selector, 0)
        );
        uint64[] memory many = new uint64[](257);
        for (uint64 i; i < 257; i++) {
            many[i] = i;
        }
        _expectRemoveRefused(
            registry,
            _removal(0, many),
            abi.encodeWithSelector(GroupRegistry.BatchSize.selector, 257)
        );
    }

    function test_RemovalRefusesUnorderedIndices() public {
        registry.addMembers(_addition(0, GroupFixture.commitments(1, 4)));
        _expectRemoveRefused(
            registry,
            _removal(0, GroupFixture.indices(2, 1)),
            abi.encodeWithSelector(GroupRegistry.IndicesOutOfOrder.selector, 1)
        );
        _expectRemoveRefused(
            registry,
            _removal(0, GroupFixture.indices(3, 3)),
            abi.encodeWithSelector(GroupRegistry.IndicesOutOfOrder.selector, 1)
        );
    }

    /// An index must be below the signed size and not removed already, so a
    /// replayed removal reverts.
    function test_RemovalRefusesStrayIndices() public {
        registry.addMembers(_addition(0, GroupFixture.commitments(1, 4)));
        _expectRemoveRefused(
            registry,
            _removal(0, GroupFixture.indices(1, 4)),
            abi.encodeWithSelector(GroupRegistry.IndexBeyondSize.selector, 4)
        );
        bytes memory record = _removal(0, GroupFixture.indices(1, 3));
        registry.removeMembers(record);
        _expectRemoveRefused(
            registry, record, abi.encodeWithSelector(GroupRegistry.AlreadyRemoved.selector, 1)
        );
        _expectRemoveRefused(
            registry,
            _removal(0, GroupFixture.indices(2, 3)),
            abi.encodeWithSelector(GroupRegistry.AlreadyRemoved.selector, 3)
        );
        registry.removeMembers(_removal(0, GroupFixture.indices(0, 2)));
    }

    /// The signed size can't exceed the group's member count: a removal is
    /// signed for members the group already has.
    function test_RemovalRefusesASizeBeyondTheCount() public {
        registry.addMembers(_addition(0, GroupFixture.commitments(1, 2)));
        _expectRemoveRefused(
            registry,
            _removalAt(0, 3, GroupFixture.indices(1)),
            abi.encodeWithSelector(GroupRegistry.SizeBeyondCount.selector, 3, 2)
        );
        // A size below the count is fine: the group grew since it was signed.
        registry.removeMembers(_removalAt(0, 1, GroupFixture.indices(0)));
    }

    /// The removal checks run in the spec's order: the size against the
    /// count before any index, and an index against the size before
    /// whether it was removed (docs/spec/contracts.md, Removals).
    function test_RemovalChecksRunInOrder() public {
        registry.addMembers(_addition(0, GroupFixture.commitments(1, 2)));
        _expectRemoveRefused(
            registry,
            _removalAt(0, 3, GroupFixture.indices(3)),
            abi.encodeWithSelector(GroupRegistry.SizeBeyondCount.selector, 3, 2)
        );
        registry.removeMembers(_removalAt(0, 2, GroupFixture.indices(1)));
        _expectRemoveRefused(
            registry,
            _removalAt(0, 1, GroupFixture.indices(1)),
            abi.encodeWithSelector(GroupRegistry.IndexBeyondSize.selector, 1)
        );
    }

    /// A removal signed at size `s` never removes index `s` or beyond, even
    /// once the group has grown past it and a member landed there: what
    /// `size` is signed for (docs/spec/contracts.md, Removals).
    function test_RemovalSignedAtASizeCantReachLaterMembers() public {
        registry.addMembers(_addition(0, GroupFixture.commitments(1, 2)));
        bytes memory early = _removalAt(0, 2, GroupFixture.indices(1, 2));
        bytes memory refusal = abi.encodeWithSelector(GroupRegistry.IndexBeyondSize.selector, 2);
        _expectRemoveRefused(registry, early, refusal);
        registry.addMembers(_addition(0, GroupFixture.commitments(2, 8)));
        (,, uint64 count) = registry.groupOf(0);
        assertEq(count, 10, "grown");
        _expectRemoveRefused(registry, early, refusal);
        assertTrue(!registry.isRemoved(0, 2), "later member untouched");
        // The same size cannot be relabelled: the signature covers it.
        bytes memory relabelled = bytes.concat(early);
        relabelled[15] = bytes1(uint8(10));
        _expectRemoveRefused(
            registry, relabelled, abi.encodeWithSelector(GroupRegistry.InvalidSignature.selector, 2)
        );
    }

    function test_RemovalRefusesBadApprovals() public {
        registry.addMembers(_addition(0, GroupFixture.commitments(1, 2)));
        uint64[] memory idx = GroupFixture.indices(1);
        bytes32 d = GroupFixture.removeDigest(registry, 0, 0, 2, idx);
        uint8[] memory one = new uint8[](1);
        one[0] = 1;
        _expectRemoveRefused(
            registry,
            GroupFixture.encodeRemove(0, 2, idx, GroupFixture.approve(secrets, one, d)),
            abi.encodeWithSelector(GroupRegistry.TooFewApprovals.selector, 1, 2)
        );
        _expectRemoveRefused(
            registry,
            GroupFixture.encodeRemove(
                0, 2, idx, GroupFixture.approve(secrets, GroupFixture.seats(2, 1), d)
            ),
            abi.encodeWithSelector(GroupRegistry.InvalidSeat.selector, 1)
        );
        // Signed for another size, another index, and as an addition.
        bytes32 otherSize = GroupFixture.removeDigest(registry, 0, 0, 1, idx);
        _expectRemoveRefused(
            registry,
            GroupFixture.encodeRemove(
                0, 2, idx, GroupFixture.approve(secrets, GroupFixture.seats(1, 2), otherSize)
            ),
            abi.encodeWithSelector(GroupRegistry.InvalidSignature.selector, 1)
        );
        bytes32 other = GroupFixture.removeDigest(registry, 0, 0, 2, GroupFixture.indices(0));
        _expectRemoveRefused(
            registry,
            GroupFixture.encodeRemove(
                0, 2, idx, GroupFixture.approve(secrets, GroupFixture.seats(1, 2), other)
            ),
            abi.encodeWithSelector(GroupRegistry.InvalidSignature.selector, 1)
        );
        uint256[] memory asWords = new uint256[](1);
        asWords[0] = 1;
        bytes32 asAdd = GroupFixture.addDigest(registry, 0, 0, 0, asWords);
        _expectRemoveRefused(
            registry,
            GroupFixture.encodeRemove(
                0, 2, idx, GroupFixture.approve(secrets, GroupFixture.seats(1, 2), asAdd)
            ),
            abi.encodeWithSelector(GroupRegistry.InvalidSignature.selector, 1)
        );
    }

    function test_RefusesMalformedRemovals() public {
        bytes memory record = _removalAfterAdding(2);
        bytes memory malformed = abi.encodeWithSelector(GroupRegistry.MalformedRecord.selector);
        _expectRemoveRefused(registry, "", malformed);
        _expectRemoveRefused(registry, _slice(record, 0, 10), malformed);
        _expectRemoveRefused(registry, _slice(record, 0, 18), malformed);
        // count names an index the record doesn't hold.
        _expectRemoveRefused(registry, _slice(record, 0, 26), malformed);
        _expectRemoveRefused(registry, _slice(record, 0, record.length - 1), malformed);
        _expectRemoveRefused(registry, bytes.concat(record, hex"00"), malformed);
    }

    // --- domain --------------------------------------------------------------------

    function test_DomainSeparatorBindsChainAndRegistry() public {
        assertEq(
            registry.domainSeparator(),
            GroupRegistryLib.domainSeparator(block.chainid, address(registry)),
            "deployment"
        );
        // After a fork to another chain ID the domain is the new chain's, so
        // batches signed for the old chain don't count on it.
        bytes memory record = _addition(0, GroupFixture.commitments(1, 1));
        vm.chainId(block.chainid + 1);
        assertEq(
            registry.domainSeparator(),
            GroupRegistryLib.domainSeparator(block.chainid, address(registry)),
            "forked"
        );
        _expectAddRefused(
            registry, record, abi.encodeWithSelector(GroupRegistry.InvalidSignature.selector, 1)
        );
    }

    // --- personal data and poll links ------------------------------------------------

    /// Calldata and events carry only fixed-size integers, commitments and
    /// signatures (contracts skill, No PII on-chain): no text slips through,
    /// and none can be appended.
    function test_NoPersonalDataInCalldataOrEvents() public {
        bytes memory add = _addition(0, GroupFixture.commitments(1, 8));
        uint64[] memory idx = GroupFixture.indices(1, 5);
        bytes memory created = abi.encodeCall(GroupRegistry.createGroup, (0));
        assertTrue(!_looksLikeText(created), "createGroup calldata");
        assertTrue(!_looksLikeText(abi.encodeCall(GroupRegistry.addMembers, (add))), "add calldata");
        vm.recordLogs();
        registry.createGroup(0);
        registry.addMembers(add);
        bytes memory remove = _removal(0, idx);
        assertTrue(
            !_looksLikeText(abi.encodeCall(GroupRegistry.removeMembers, (remove))),
            "remove calldata"
        );
        registry.removeMembers(remove);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3, "logs");
        for (uint256 i; i < logs.length; i++) {
            assertTrue(!_looksLikeText(logs[i].data), "event data");
            for (uint256 t; t < logs[i].topics.length; t++) {
                assertTrue(!_looksLikeText(abi.encode(logs[i].topics[t])), "event topic");
            }
        }
        bytes memory withText = bytes.concat(add, "Jane Doe, 1 Main Street");
        assertTrue(_looksLikeText(withText), "detector misses the text");
        _expectAddRefused(
            registry, withText, abi.encodeWithSelector(GroupRegistry.MalformedRecord.selector)
        );
    }

    /// Nothing the group registry takes or logs links a member to a poll
    /// (T-12, T-13): run an election registry alongside, through creation and
    /// registration of a definition naming this registry's group, and check
    /// that no group-registry calldata or event carries the election's
    /// identifier or definition hash, and that its only events are its four.
    function test_NoPollLinkOnChain() public {
        DefinitionHarness defs = new DefinitionHarness();
        RegistryFixture.installL1Block(vm);
        MockTrusteeRegistry trustees = new MockTrusteeRegistry();
        ElectionRegistry.Deployment memory dep = RegistryFixture.deployment(address(trustees));
        dep.groupRegistry = address(registry);
        ElectionRegistry elections = new ElectionRegistry(dep);
        vm.warp(RegistryFixture.NOW);
        vm.roll(RegistryFixture.BLOCK);

        vm.recordLogs();
        bytes memory add = _addition(0, GroupFixture.commitments(7, 4));
        registry.addMembers(add);
        vm.prank(address(0xC4EA));
        bytes32 electionId = elections.createElection();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(elections, electionId);
        d.electorate[0].groupId = 0;
        bytes memory enc = RegistryFixture.approve(defs, trustees, d);
        vm.prank(address(0xC4EA));
        elections.registerDefinition(enc);
        bytes32 definitionHash = defs.hash(enc);
        registry.createGroup(0);
        bytes memory remove = _removal(0, GroupFixture.indices(2));
        registry.removeMembers(remove);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32[2] memory secretsOfThePoll = [electionId, definitionHash];
        bytes[2] memory calldata_ = [
            abi.encodeCall(GroupRegistry.addMembers, (add)),
            abi.encodeCall(GroupRegistry.removeMembers, (remove))
        ];
        uint256 seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(registry)) continue;
            seen++;
            bytes32 t0 = logs[i].topics[0];
            assertTrue(
                t0 == GroupRegistry.RegistrarsPinned.selector
                    || t0 == GroupRegistry.GroupCreated.selector
                    || t0 == GroupRegistry.MembersAdded.selector
                    || t0 == GroupRegistry.MembersRemoved.selector,
                "unknown event"
            );
            for (uint256 s; s < 2; s++) {
                assertTrue(!_contains(logs[i].data, secretsOfThePoll[s]), "poll in event data");
                for (uint256 t; t < logs[i].topics.length; t++) {
                    assertTrue(logs[i].topics[t] != secretsOfThePoll[s], "poll in topic");
                }
            }
        }
        assertEq(seen, 3, "group registry events");
        for (uint256 c; c < 2; c++) {
            for (uint256 s; s < 2; s++) {
                assertTrue(!_contains(calldata_[c], secretsOfThePoll[s]), "poll in calldata");
            }
        }
    }

    // --- fuzz ----------------------------------------------------------------------

    /// Any one-bit change to a valid addition is refused: every field is
    /// either checked against state, the layout, or signed.
    function testFuzz_RefusesAnyBitFlipOfAnAddition(uint256 bit) public {
        bytes memory record = _addition(0, GroupFixture.commitments(1, 2));
        bit = bit % (record.length * 8);
        record[bit / 8] ^= bytes1(uint8(0x80) >> (bit % 8));
        (bool ok,) = _call(registry, GroupRegistry.addMembers.selector, record);
        assertTrue(!ok, "flipped addition accepted");
        (,, uint64 count) = registry.groupOf(0);
        assertEq(count, 0, "added");
    }

    function testFuzz_RefusesAnyBitFlipOfARemoval(uint256 bit) public {
        registry.addMembers(_addition(0, GroupFixture.commitments(1, 8)));
        bytes memory record = _removal(0, GroupFixture.indices(2, 5));
        bit = bit % (record.length * 8);
        record[bit / 8] ^= bytes1(uint8(0x80) >> (bit % 8));
        (bool ok,) = _call(registry, GroupRegistry.removeMembers.selector, record);
        assertTrue(!ok, "flipped removal accepted");
        for (uint64 i; i < 8; i++) {
            assertTrue(!registry.isRemoved(0, i), "removed");
        }
    }

    function testFuzz_RefusesArbitraryBytes(bytes calldata junk) public {
        (bool ok,) = _call(registry, GroupRegistry.addMembers.selector, junk);
        assertTrue(!ok, "junk addition accepted");
        registry.addMembers(_addition(0, GroupFixture.commitments(1, 4)));
        (ok,) = _call(registry, GroupRegistry.removeMembers.selector, junk);
        assertTrue(!ok, "junk removal accepted");
    }

    /// Signatures by keys outside the set never count, whatever seat they claim.
    function testFuzz_RefusesSignaturesFromOtherKeys(uint256 sk, uint8 seat) public {
        sk = 1 + sk % (GroupRegistryLib.N - 1);
        address signer = vm.addr(sk);
        vm.assume(signer != registrarAddrs[0] && signer != registrarAddrs[1]);
        vm.assume(signer != registrarAddrs[2]);
        uint8 claimed = uint8(1 + seat % 2);
        uint256[] memory c = GroupFixture.commitments(sk, 1);
        bytes32 d = GroupFixture.addDigest(registry, 0, 0, 0, c);
        GroupFixture.Approval[] memory a =
            GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d);
        a[claimed - 1] = GroupFixture.sign(claimed, sk, d);
        _expectAddRefused(
            registry,
            GroupFixture.encodeAdd(0, 0, c, a),
            abi.encodeWithSelector(GroupRegistry.InvalidSignature.selector, claimed)
        );
    }

    // --- helpers -------------------------------------------------------------------

    function _addition(uint64 groupId, uint256[] memory c) internal view returns (bytes memory) {
        return GroupFixture.addition(registry, secrets, GroupFixture.seats(1, 2), groupId, c);
    }

    function _removal(uint64 groupId, uint64[] memory idx) internal view returns (bytes memory) {
        return GroupFixture.removal(registry, secrets, GroupFixture.seats(2, 3), groupId, idx);
    }

    function _removalAt(uint64 groupId, uint64 size, uint64[] memory idx)
        internal
        view
        returns (bytes memory)
    {
        return
            GroupFixture.removalAt(registry, secrets, GroupFixture.seats(2, 3), groupId, size, idx);
    }

    /// Adds `n` members to group 0 and returns a removal of member 0.
    function _removalAfterAdding(uint256 n) internal returns (bytes memory) {
        registry.addMembers(_addition(0, GroupFixture.commitments(99, n)));
        return _removal(0, GroupFixture.indices(0));
    }

    /// The accumulator over the logs from setUp (registrars, group 0) and `logs`.
    function _assertAccumulatedFromSetUp(Vm.Log[] memory logs) internal view {
        address[] memory pinned = registry.registrars();
        bytes32 acc = EventAccumulatorLib.genesis(uint64(block.chainid), address(registry));
        bytes32[] memory t = new bytes32[](1);
        t[0] = GroupRegistry.RegistrarsPinned.selector;
        acc = EventAccumulatorLib.step(
            acc, 0, block.number, block.timestamp, t, abi.encode(threshold, pinned)
        );
        t = new bytes32[](3);
        (t[0], t[1], t[2]) = (GroupRegistry.GroupCreated.selector, bytes32(0), bytes32(0));
        acc = EventAccumulatorLib.step(acc, 1, block.number, block.timestamp, t, "");
        for (uint256 i; i < logs.length; i++) {
            acc = EventAccumulatorLib.step(
                acc, uint64(2 + i), block.number, block.timestamp, logs[i].topics, logs[i].data
            );
        }
        (bytes32 stored, uint64 count) = registry.eventAccumulator();
        assertEq(stored, acc, "accumulator");
        assertEq(count, 2 + logs.length, "accumulator count");
    }

    /// `n` distinct non-zero addresses in ascending order.
    function _ascending(uint256 n) internal pure returns (address[] memory a) {
        a = new address[](n);
        for (uint256 i; i < n; i++) {
            a[i] = address(uint160(0x1000 + i));
        }
    }

    function _expectDeployRefused(
        uint8 t,
        address[] memory regs,
        GroupRegistry.RegistrarError reason
    ) internal {
        try new GroupRegistry(
            t, regs, NullifierKeyFixture.trustees(), NullifierKeyFixture.INITIAL_PANEL
        ) {
            revert("deployed");
        } catch (bytes memory ret) {
            assertTrue(
                keccak256(ret)
                    == keccak256(
                        abi.encodeWithSelector(GroupRegistry.InvalidRegistrars.selector, reason)
                    ),
                "unexpected deployment error"
            );
        }
    }
}

/// The costs docs/spec/contracts.md (Group registry, Known-weak, Gas) quotes,
/// each measured in its own test, so its storage is cold as in a transaction
/// of its own. The bounds cover the call as made from the test (cold account
/// access, the registry's execution and its event); a transaction adds 21,000
/// and its calldata gas.
contract GroupRegistryGasTest is TestBase {
    GroupRegistry internal registry;
    uint256[] internal secrets;
    bytes internal oneMember;
    bytes internal twoMembers;
    bytes internal fullBatch;
    bytes internal removal;

    function setUp() public {
        string memory json = vm.readFile(GroupFixture.VECTORS);
        address[] memory addrs;
        uint8 threshold;
        (secrets, addrs, threshold) = GroupFixture.keys(json);
        registry = new GroupRegistry(
            threshold, addrs, NullifierKeyFixture.trustees(), NullifierKeyFixture.INITIAL_PANEL
        );
        registry.createGroup(0);
        registry.addMembers(
            GroupFixture.addition(
                registry, secrets, GroupFixture.seats(1, 2), 0, GroupFixture.commitments(0, 3)
            )
        );
        oneMember = _batch(1);
        twoMembers = _batch(2);
        fullBatch = _batch(256);
        removal = GroupFixture.removal(
            registry, secrets, GroupFixture.seats(1, 2), 0, GroupFixture.indices(1)
        );
    }

    function test_GasOneMember() public {
        assertTrue(_measure(GroupRegistry.addMembers.selector, oneMember) < 75_000, "one member");
    }

    function test_GasTwoMembers() public {
        assertTrue(_measure(GroupRegistry.addMembers.selector, twoMembers) < 77_000, "two members");
    }

    function test_GasFullBatch() public {
        assertTrue(_measure(GroupRegistry.addMembers.selector, fullBatch) < 470_000, "256 members");
    }

    function test_GasRemoval() public {
        assertTrue(_measure(GroupRegistry.removeMembers.selector, removal) < 95_000, "removal");
    }

    function _batch(uint256 n) internal view returns (bytes memory) {
        return GroupFixture.addition(
            registry, secrets, GroupFixture.seats(1, 2), 0, GroupFixture.commitments(n, n)
        );
    }

    function _measure(bytes4 selector, bytes memory record) internal returns (uint256 used) {
        bytes memory data = abi.encodeWithSelector(selector, record);
        uint256 g = gasleft();
        (bool ok,) = address(registry).call(data);
        used = g - gasleft();
        assertTrue(ok, "refused");
    }
}
