// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {GroupRegistry, GroupRegistryLib, VouchLib} from "../src/GroupRegistry.sol";
import {GroupTestBase} from "./GroupRegistry.t.sol";
import {DefinitionHarness, MockTrusteeRegistry} from "./utils/DefinitionHarness.sol";
import {GroupFixture} from "./utils/GroupFixture.sol";
import {RegistryFixture} from "./utils/RegistryFixture.sol";
import {Vm} from "./utils/Vm.sol";

/// The group registry's self-paid Tier 0 path (docs/spec/contracts.md, Group
/// registry, Groups and Self-paid additions): `createSelfPaidGroup` from the
/// shared counter, and `addSelfPaidMember` from anyone who sends exactly
/// `SELF_PAID_FEE`, checked in the spec's order, assigning the next index
/// and logging it as a topic. Neither kind of group takes the other's
/// records, so no self-paid addition can stall a signed batch (T-25, T-06),
/// and every fee stays locked in the registry (T-52).
contract SelfPaidAdditionsTest is GroupTestBase {
    uint256 internal constant FEE = GroupRegistryLib.SELF_PAID_FEE;

    string internal json;
    uint256[] internal secrets;
    address[] internal registrarAddrs;
    GroupRegistry internal registry;
    /// Group 0 is signed, group 1 self-paid.
    uint64 internal constant SIGNED = 0;
    uint64 internal constant SELF_PAID = 1;

    function setUp() public {
        json = vm.readFile(GroupFixture.VECTORS);
        uint8 threshold;
        (secrets, registrarAddrs, threshold) = GroupFixture.keys(json);
        registry = new GroupRegistry(threshold, registrarAddrs);
        registry.createGroup(0);
        registry.createSelfPaidGroup();
        vm.deal(address(this), 1 ether);
    }

    // --- groups --------------------------------------------------------------------

    function test_CreatesSelfPaidGroupsFromTheSharedCounter() public {
        vm.roll(7_777);
        vm.recordLogs();
        vm.prank(address(0xBEEF));
        uint64 id = registry.createSelfPaidGroup();
        uint64 next = registry.createGroup(1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(id, 2, "third group");
        assertEq(next, 3, "the counter is shared");
        assertEq(registry.groupCount(), 4, "count");
        (uint8 tier, bool exists, uint64 members) = registry.groupOf(id);
        assertTrue(tier == 0 && exists && members == 0, "record");
        assertTrue(registry.isSelfPaid(id), "self-paid");
        assertTrue(!registry.isSelfPaid(next) && !registry.isSelfPaid(SIGNED), "signed");
        assertTrue(!registry.isSelfPaid(9), "no group");
        assertEq(registry.groupCreatedBlock(id), 7_777, "created block");
        assertEq(logs.length, 2, "logs");
        assertEq(logs[0].topics.length, 2, "topics");
        assertEq(logs[0].topics[0], GroupRegistry.SelfPaidGroupCreated.selector, "topic 0");
        assertEq(logs[0].topics[0], keccak256("SelfPaidGroupCreated(uint64)"), "event signature");
        assertEq(logs[0].topics[1], bytes32(uint256(2)), "group topic");
        assertEq(logs[0].data.length, 0, "no data");
    }

    function test_CreateSelfPaidGroupRefusesAnyOtherCalldataAndEther() public {
        bytes memory canonical = abi.encodeCall(GroupRegistry.createSelfPaidGroup, ());
        bytes memory refusal =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        (bool ok, bytes memory ret) = address(registry).call(bytes.concat(canonical, hex"00"));
        _assertRefused(ok, ret, refusal, "long");
        (ok, ret) = address(registry).call(bytes.concat(canonical, bytes32(0)));
        _assertRefused(ok, ret, refusal, "extra word");
        (ok,) = address(registry).call{value: 1}(canonical);
        assertTrue(!ok, "ether");
        assertEq(registry.groupCount(), 2, "nothing created");
        (ok,) = address(registry).call(canonical);
        assertTrue(ok, "canonical");
    }

    function test_CreateSelfPaidGroupStopsAtTheLastU64() public {
        GroupFixture.setGroupCount(registry, type(uint64).max);
        assertEq(registry.createSelfPaidGroup(), type(uint64).max, "last id");
        assertTrue(registry.isSelfPaid(type(uint64).max), "created");
        (bool ok, bytes memory ret) =
            address(registry).call(abi.encodeCall(GroupRegistry.createSelfPaidGroup, ()));
        _assertRefused(
            ok, ret, abi.encodeWithSelector(GroupRegistry.TooManyGroups.selector), "overflow"
        );
    }

    // --- additions -----------------------------------------------------------------

    function test_AddsAtTheNextIndexFromAnyoneAndKeepsTheFee() public {
        vm.recordLogs();
        registry = new GroupRegistry(2, registrarAddrs);
        registry.createSelfPaidGroup();
        registry.createSelfPaidGroup();
        for (uint256 i; i < 3; i++) {
            address sender = address(uint160(0xA000 + i));
            vm.deal(sender, FEE);
            vm.prank(sender);
            registry.addSelfPaidMember{value: FEE}(_record(SELF_PAID, 1_000 + i));
            assertEq(sender.balance, 0, "fee paid");
        }
        Vm.Log[] memory all = vm.getRecordedLogs();
        _assertAccumulated(registry, all);
        // The registrars and both groups first.
        Vm.Log[] memory logs = new Vm.Log[](all.length - 3);
        for (uint256 i; i < logs.length; i++) {
            logs[i] = all[3 + i];
        }
        (,, uint64 count) = registry.groupOf(SELF_PAID);
        assertEq(count, 3, "count");
        (,, count) = registry.groupOf(0);
        assertEq(count, 0, "the other group");
        assertEq(address(registry).balance, 3 * FEE, "fees locked");
        assertEq(logs.length, 3, "logs");
        for (uint256 i; i < 3; i++) {
            assertEq(logs[i].topics.length, 3, "topics");
            assertEq(logs[i].topics[0], GroupRegistry.SelfPaidMemberAdded.selector, "topic 0");
            assertEq(
                logs[i].topics[0],
                keccak256("SelfPaidMemberAdded(uint64,uint64,bytes)"),
                "event signature"
            );
            assertEq(logs[i].topics[1], bytes32(uint256(SELF_PAID)), "group topic");
            assertEq(logs[i].topics[2], bytes32(i), "index topic");
            assertTrue(
                keccak256(logs[i].data) == keccak256(abi.encode(_record(SELF_PAID, 1_000 + i))),
                "the whole record"
            );
        }
    }

    /// No duplicate check: a commitment already held, by a signed group or
    /// this one, is added again at the next index (membership's
    /// first-occurrence rule ranks the copies, T-16).
    function test_AllowsARepeatedCommitment() public {
        uint256[] memory c = GroupFixture.commitments(5, 1);
        registry.addMembers(_signedAddition(SIGNED, 0, c));
        registry.addSelfPaidMember{value: FEE}(_record(SELF_PAID, c[0]));
        registry.addSelfPaidMember{value: FEE}(_record(SELF_PAID, c[0]));
        (,, uint64 count) = registry.groupOf(SELF_PAID);
        assertEq(count, 2, "both copies");
    }

    function test_RefusesNonCanonicalCalldata() public {
        bytes memory canonical =
            abi.encodeCall(GroupRegistry.addSelfPaidMember, (_record(SELF_PAID, 7)));
        bytes memory refusal =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        (bool ok, bytes memory ret) =
            address(registry).call{value: FEE}(bytes.concat(canonical, bytes32(0)));
        _assertRefused(ok, ret, refusal, "trailing word");
        bytes memory dirty = bytes.concat(canonical);
        dirty[dirty.length - 1] = 0x01;
        (ok, ret) = address(registry).call{value: FEE}(dirty);
        _assertRefused(ok, ret, refusal, "padding");
        bytes memory offset = bytes.concat(canonical);
        offset[35] = 0x40;
        (ok,) = address(registry).call{value: FEE}(offset);
        assertTrue(!ok, "offset");
        (ok,) = address(registry).call{value: FEE}(canonical);
        assertTrue(ok, "canonical");
    }

    function test_RefusesAnyLengthButForty() public {
        bytes memory r = _record(SELF_PAID, 7);
        uint256[5] memory lengths = [uint256(0), 8, 39, 41, 72];
        for (uint256 i; i < lengths.length; i++) {
            bytes memory b = new bytes(lengths[i]);
            for (uint256 j; j < b.length && j < 40; j++) {
                b[j] = r[j];
            }
            _expectSelfPaidRefused(
                b, FEE, abi.encodeWithSelector(GroupRegistry.MalformedRecord.selector)
            );
        }
    }

    function test_RefusesAnyFeeButTheExactOne() public {
        uint256[5] memory fees = [uint256(0), 1, FEE - 1, FEE + 1, 2 * FEE];
        for (uint256 i; i < fees.length; i++) {
            _expectSelfPaidRefused(
                _record(SELF_PAID, 7),
                fees[i],
                abi.encodeWithSelector(GroupRegistry.WrongFee.selector, fees[i])
            );
        }
        assertEq(address(registry).balance, 0, "nothing kept");
    }

    function test_RefusesAnUnknownGroupOrOneOfAnotherKind() public {
        _expectSelfPaidRefused(
            _record(9, 7), FEE, abi.encodeWithSelector(GroupRegistry.UnknownGroup.selector, 9)
        );
        _expectSelfPaidRefused(
            _record(SIGNED, 7),
            FEE,
            abi.encodeWithSelector(GroupRegistry.WrongKind.selector, SIGNED)
        );
        uint64 tier1 = registry.createGroup(1);
        _expectSelfPaidRefused(
            _record(tier1, 7), FEE, abi.encodeWithSelector(GroupRegistry.WrongKind.selector, tier1)
        );
    }

    function test_RefusesAPositionPastTheTreesLeaves() public {
        _setSelfPaidCount(SELF_PAID, uint64(GroupRegistryLib.MAX_MEMBERS - 1));
        registry.addSelfPaidMember{value: FEE}(_record(SELF_PAID, 7));
        (,, uint64 count) = registry.groupOf(SELF_PAID);
        assertEq(count, GroupRegistryLib.MAX_MEMBERS, "the last leaf");
        _expectSelfPaidRefused(
            _record(SELF_PAID, 8),
            FEE,
            abi.encodeWithSelector(
                GroupRegistry.GroupFull.selector, uint64(GroupRegistryLib.MAX_MEMBERS), 1
            )
        );
    }

    function test_RefusesForbiddenCommitments() public {
        uint256[5] memory bad =
            [uint256(0), 1, GroupRegistryLib.POSEIDON2_0_1, GroupRegistryLib.R, type(uint256).max];
        for (uint256 i; i < bad.length; i++) {
            _expectSelfPaidRefused(
                _record(SELF_PAID, bad[i]),
                FEE,
                abi.encodeWithSelector(GroupRegistry.ForbiddenCommitment.selector, 0)
            );
        }
        registry.addSelfPaidMember{value: FEE}(_record(SELF_PAID, GroupRegistryLib.R - 1));
        registry.addSelfPaidMember{value: FEE}(_record(SELF_PAID, 2));
    }

    /// Each refusal is the first failing check in the spec's order: length,
    /// fee, group, position, commitment.
    function test_ChecksRunInOrder() public {
        bytes memory forbiddenInUnknown = _record(9, 0);
        _expectSelfPaidRefused(
            bytes.concat(forbiddenInUnknown, hex"00"),
            0,
            abi.encodeWithSelector(GroupRegistry.MalformedRecord.selector)
        );
        _expectSelfPaidRefused(
            forbiddenInUnknown, 0, abi.encodeWithSelector(GroupRegistry.WrongFee.selector, 0)
        );
        _expectSelfPaidRefused(
            forbiddenInUnknown, FEE, abi.encodeWithSelector(GroupRegistry.UnknownGroup.selector, 9)
        );
        _setSelfPaidCount(SELF_PAID, uint64(GroupRegistryLib.MAX_MEMBERS));
        _expectSelfPaidRefused(
            _record(SELF_PAID, 0),
            FEE,
            abi.encodeWithSelector(
                GroupRegistry.GroupFull.selector, uint64(GroupRegistryLib.MAX_MEMBERS), 1
            )
        );
    }

    // --- the two kinds never share a group --------------------------------------------

    /// A signed record naming a self-paid group is refused, however well
    /// signed: registrars can neither add to nor remove from one (T-25).
    function test_SignedRecordsRefuseASelfPaidGroup() public {
        registry.addSelfPaidMember{value: FEE}(_record(SELF_PAID, 7));
        bytes memory add = _signedAddition(SELF_PAID, 1, GroupFixture.commitments(1, 1));
        _expectAddRefused(
            registry, add, abi.encodeWithSelector(GroupRegistry.WrongKind.selector, SELF_PAID)
        );
        uint64[] memory idx = GroupFixture.indices(1);
        idx[0] = 0;
        bytes32 d = GroupFixture.removeDigest(registry, SELF_PAID, 0, 1, idx);
        bytes memory remove = GroupFixture.encodeRemove(
            SELF_PAID, 1, idx, GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d)
        );
        _expectRemoveRefused(
            registry, remove, abi.encodeWithSelector(GroupRegistry.WrongKind.selector, SELF_PAID)
        );
        assertTrue(!registry.isRemoved(SELF_PAID, 0), "not removed");
    }

    /// No self-paid addition moves a signed group's count, so a batch signed
    /// for the next position still lands after any number of them (T-25).
    function test_SelfPaidAdditionsNeverStallASignedBatch() public {
        uint256[] memory c = GroupFixture.commitments(3, 4);
        bytes memory batch = _signedAddition(SIGNED, 0, c);
        for (uint256 i; i < 5; i++) {
            registry.addSelfPaidMember{value: FEE}(_record(SELF_PAID, c[i % 4]));
        }
        registry.addMembers(batch);
        (,, uint64 count) = registry.groupOf(SIGNED);
        assertEq(count, 4, "the signed batch landed");
    }

    /// A Tier 1 addition never names a self-paid group: its group check
    /// needs tier 1, and a self-paid group's is 0.
    function test_Tier1AdditionsRefuseASelfPaidGroup() public {
        bytes memory record = new bytes(VouchLib.RECORD_LENGTH);
        record[7] = bytes1(uint8(SELF_PAID));
        record[40] = bytes1(uint8(VouchLib.K));
        (bool ok, bytes memory ret) =
            address(registry).call(abi.encodeCall(GroupRegistry.addTier1Member, (record)));
        _assertRefused(
            ok,
            ret,
            abi.encodeWithSelector(GroupRegistry.WrongTier.selector, SELF_PAID, 0),
            "tier 1"
        );
    }

    /// Every function but `addSelfPaidMember` refuses ether, and there is no
    /// receive or fallback, so nothing but the exact fee ever reaches the
    /// registry and nothing moves it out.
    function test_NoOtherWayInForEther() public {
        bytes[4] memory calls = [
            abi.encodeCall(GroupRegistry.createGroup, (0)),
            abi.encodeCall(GroupRegistry.createSelfPaidGroup, ()),
            abi.encodeCall(
                GroupRegistry.addMembers,
                (_signedAddition(SIGNED, 0, GroupFixture.commitments(1, 1)))
            ),
            bytes("")
        ];
        for (uint256 i; i < calls.length; i++) {
            (bool ok,) = address(registry).call{value: FEE}(calls[i]);
            assertTrue(!ok, "ether accepted");
        }
        assertEq(address(registry).balance, 0, "balance");
    }

    /// The events the registry emits are contract-event version 7's records
    /// of them, topics and data byte for byte
    /// (docs/spec/vectors/contract-event-v7.json, from an independent
    /// generator), so they pass 4.4's event check (T-53).
    function test_EventsAreTheVersion7Records() public {
        string memory v7 = vm.readFile("../../docs/spec/vectors/contract-event-v7.json");
        vm.recordLogs();
        registry = new GroupRegistry(2, registrarAddrs);
        registry.createGroup(0);
        registry.createSelfPaidGroup();
        string[4] memory added = [
            "self-paid-member-added-0",
            "self-paid-member-added-1",
            "self-paid-member-added-2",
            "self-paid-member-added-repeat"
        ];
        for (uint256 i; i < added.length; i++) {
            // The record is the data's one `bytes`: 40 bytes after the offset
            // and length words.
            bytes memory data = _vectorData(v7, added[i]);
            registry.addSelfPaidMember{value: FEE}(_slice(data, 64, 40));
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3 + added.length, "logs");
        _assertVectorLog(v7, "group-created-signed", logs[1]);
        _assertVectorLog(v7, "self-paid-group-created", logs[2]);
        for (uint256 i; i < added.length; i++) {
            _assertVectorLog(v7, added[i], logs[3 + i]);
        }
    }

    function _vectorData(string memory v7, string memory id) internal pure returns (bytes memory) {
        return vm.parseBytes(
            string.concat(
                "0x",
                vm.parseJsonString(v7, string.concat(".records[?(@.id == '", id, "')].fields.data"))
            )
        );
    }

    function _assertVectorLog(string memory v7, string memory id, Vm.Log memory log) internal pure {
        string[] memory topics = vm.parseJsonStringArray(
            v7, string.concat(".records[?(@.id == '", id, "')].fields.topics")
        );
        assertEq(log.topics.length, topics.length, string.concat(id, ": topics"));
        for (uint256 t; t < topics.length; t++) {
            assertEq(log.topics[t], bytes32(vm.parseBytes(string.concat("0x", topics[t]))), id);
        }
        assertTrue(
            keccak256(log.data) == keccak256(_vectorData(v7, id)), string.concat(id, ": data")
        );
    }

    // --- personal data and polls ----------------------------------------------------

    function test_NoPersonalDataInCalldataOrEvents() public {
        bytes memory record = _record(SELF_PAID, GroupFixture.commitments(4, 1)[0]);
        assertTrue(
            !_looksLikeText(abi.encodeCall(GroupRegistry.createSelfPaidGroup, ())),
            "create calldata"
        );
        assertTrue(
            !_looksLikeText(abi.encodeCall(GroupRegistry.addSelfPaidMember, (record))),
            "add calldata"
        );
        vm.recordLogs();
        registry.createSelfPaidGroup();
        registry.addSelfPaidMember{value: FEE}(record);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "logs");
        for (uint256 i; i < logs.length; i++) {
            assertTrue(!_looksLikeText(logs[i].data), "event data");
            for (uint256 t; t < logs[i].topics.length; t++) {
                assertTrue(!_looksLikeText(abi.encode(logs[i].topics[t])), "event topic");
            }
        }
        // Text can't ride along: the record is exactly 40 bytes.
        bytes memory withText = bytes.concat(record, "Jane Doe, 1 Main Street");
        assertTrue(_looksLikeText(withText), "detector misses the text");
        _expectSelfPaidRefused(
            withText, FEE, abi.encodeWithSelector(GroupRegistry.MalformedRecord.selector)
        );
        // A 32-byte commitment of text is a field element like any other: the
        // registry can't tell, and the client draws it from its secret
        // (membership.md, Commitments and removals; T-17).
    }

    /// The self-paid path takes no election identifier, definition or
    /// nullifier (T-12, T-13): an election registered alongside, naming the
    /// self-paid group, leaves no trace of itself in the group registry's
    /// calldata or events, and the group registry emits only its own.
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
        bytes memory add = _record(SELF_PAID, GroupFixture.commitments(8, 1)[0]);
        registry.addSelfPaidMember{value: FEE}(add);
        vm.prank(address(0xC4EA));
        bytes32 electionId = elections.createElection();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(elections, electionId);
        d.electorate[0].groupId = SELF_PAID;
        bytes memory enc = RegistryFixture.approve(defs, trustees, d);
        vm.prank(address(0xC4EA));
        elections.registerDefinition(enc);
        bytes32 definitionHash = defs.hash(enc);
        registry.createSelfPaidGroup();
        bytes memory later = _record(SELF_PAID, GroupFixture.commitments(9, 1)[0]);
        registry.addSelfPaidMember{value: FEE}(later);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32[2] memory ofThePoll = [electionId, definitionHash];
        bytes[2] memory calldata_ = [
            abi.encodeCall(GroupRegistry.addSelfPaidMember, (add)),
            abi.encodeCall(GroupRegistry.addSelfPaidMember, (later))
        ];
        uint256 seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(registry)) continue;
            seen++;
            bytes32 t0 = logs[i].topics[0];
            assertTrue(
                t0 == GroupRegistry.SelfPaidGroupCreated.selector
                    || t0 == GroupRegistry.SelfPaidMemberAdded.selector,
                "unknown event"
            );
            for (uint256 s; s < 2; s++) {
                assertTrue(!_contains(logs[i].data, ofThePoll[s]), "poll in event data");
                for (uint256 t; t < logs[i].topics.length; t++) {
                    assertTrue(logs[i].topics[t] != ofThePoll[s], "poll in topic");
                }
            }
        }
        assertEq(seen, 3, "group registry events");
        for (uint256 c; c < 2; c++) {
            for (uint256 s; s < 2; s++) {
                assertTrue(!_contains(calldata_[c], ofThePoll[s]), "poll in calldata");
            }
        }
    }

    // --- fuzz ----------------------------------------------------------------------

    /// Any 40 bytes naming the self-paid group with a commitment that isn't
    /// forbidden land at the next index; any other 40 bytes are refused.
    function testFuzz_AcceptsExactlyTheRulesRecords(uint64 groupId, uint256 commitment) public {
        groupId = groupId % 4;
        bool allowed = groupId == SELF_PAID && !GroupRegistryLib.forbidden(commitment);
        (bool ok,) = address(registry).call{value: FEE}(
            abi.encodeCall(GroupRegistry.addSelfPaidMember, (_record(groupId, commitment)))
        );
        assertTrue(ok == allowed, "verdict");
        (,, uint64 count) = registry.groupOf(SELF_PAID);
        assertEq(count, allowed ? 1 : 0, "count");
        assertEq(address(registry).balance, allowed ? FEE : 0, "fee");
    }

    function testFuzz_RefusesArbitraryBytes(bytes calldata junk) public {
        vm.assume(junk.length != 40);
        (bool ok,) = address(registry).call{value: FEE}(
            abi.encodeCall(GroupRegistry.addSelfPaidMember, (junk))
        );
        assertTrue(!ok, "junk accepted");
    }

    function testFuzz_RefusesAnyOtherFee(uint256 value) public {
        value = value % 1 ether;
        vm.assume(value != FEE);
        (bool ok,) = address(registry).call{value: value}(
            abi.encodeCall(GroupRegistry.addSelfPaidMember, (_record(SELF_PAID, 7)))
        );
        assertTrue(!ok, "fee accepted");
    }

    // --- helpers -------------------------------------------------------------------

    function _record(uint64 groupId, uint256 commitment) internal pure returns (bytes memory) {
        return abi.encodePacked(groupId, commitment);
    }

    function _signedAddition(uint64 groupId, uint64 first, uint256[] memory c)
        internal
        view
        returns (bytes memory)
    {
        bytes32 d = GroupFixture.addDigest(registry, groupId, 0, first, c);
        return GroupFixture.encodeAdd(
            groupId, first, c, GroupFixture.approve(secrets, GroupFixture.seats(1, 2), d)
        );
    }

    function _expectSelfPaidRefused(bytes memory record, uint256 value, bytes memory expected)
        internal
    {
        (bool ok, bytes memory ret) = address(registry).call{value: value}(
            abi.encodeCall(GroupRegistry.addSelfPaidMember, (record))
        );
        _assertRefused(ok, ret, expected, "addSelfPaidMember");
    }

    /// A self-paid group's member count, written into its packed record
    /// (`memberCount` the low 64 bits of the slot GroupFixture.setGroup writes).
    function _setSelfPaidCount(uint64 groupId, uint64 count) internal {
        bytes32 slot = keccak256(abi.encode(uint256(groupId), GroupFixture.GROUPS_SLOT));
        uint256 packed = uint256(vm.load(address(registry), slot));
        packed = (packed & ~uint256(type(uint64).max)) | count;
        vm.store(address(registry), slot, bytes32(packed));
        (,, uint64 c) = registry.groupOf(groupId);
        require(c == count && registry.isSelfPaid(groupId), "group slot layout");
    }
}

/// The self-paid call's gas (docs/spec/contracts.md, Group registry,
/// Self-paid additions, Who pays): one storage write, the accumulator step
/// and the event, with no signature to recover.
contract SelfPaidGasTest is GroupTestBase {
    GroupRegistry internal registry;

    function setUp() public {
        string memory json = vm.readFile(GroupFixture.VECTORS);
        (, address[] memory addrs, uint8 threshold) = GroupFixture.keys(json);
        registry = new GroupRegistry(threshold, addrs);
        registry.createSelfPaidGroup();
        vm.deal(address(this), 1 ether);
        // A warm group and accumulator, as for every addition after the first.
        registry.addSelfPaidMember{value: GroupRegistryLib.SELF_PAID_FEE}(
            abi.encodePacked(uint64(0), uint256(2))
        );
    }

    function test_GasOneSelfPaidAddition() public {
        bytes memory data = abi.encodeCall(
            GroupRegistry.addSelfPaidMember, (abi.encodePacked(uint64(0), uint256(3)))
        );
        uint256 g = gasleft();
        (bool ok,) = address(registry).call{value: GroupRegistryLib.SELF_PAID_FEE}(data);
        uint256 used = g - gasleft();
        assertTrue(ok, "refused");
        // About 56,500, 9,000 of it the call's value transfer.
        assertTrue(used < 60_000, "self-paid addition");
    }
}
