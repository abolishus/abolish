// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {GroupRegistry, GroupRegistryLib} from "../src/GroupRegistry.sol";
import {GroupFixture} from "./utils/GroupFixture.sol";
import {Tier1Harness} from "./utils/Tier1Harness.sol";
import {GroupTestBase} from "./GroupRegistry.t.sol";
import {Vm} from "./utils/Vm.sol";

/// The group registry's Tier 1 path (docs/spec/contracts.md, Group registry,
/// Tier 1 additions) against docs/spec/vectors/vouch.json and
/// vouch-count.json, both written by packages/crypto/scripts/vouch-vectors.mjs
/// with Semaphore's own prover and snarkjs, sharing no code with this
/// package. The registry must accept exactly the additions that pass every
/// check of vouching.md but `root-mismatch`, `slot-spent` and `member`, which
/// it leaves to the verifier (T-25, T-53), and refuse every other one with
/// the first failing rule in its own order (T-52, T-06, T-17, T-71).
contract Tier1AdditionsTest is GroupTestBase {
    string internal constant VOUCH = "../../docs/spec/vectors/vouch.json";
    string internal constant COUNT = "../../docs/spec/vectors/vouch-count.json";

    /// Both files' context: Base Sepolia and a registry at 0x5a0b…5a0b.
    uint256 internal constant CHAIN_ID = 84532;
    address internal constant REGISTRY = 0x5A0b5a0B5a0B5a0b5a0B5a0B5A0B5a0b5a0B5a0B;

    string internal vouchJson;
    string internal countJson;
    GroupRegistry internal registry;

    function setUp() public {
        vouchJson = vm.readFile(VOUCH);
        countJson = vm.readFile(COUNT);
        (, address[] memory addrs, uint8 threshold) =
            GroupFixture.keys(vm.readFile(GroupFixture.VECTORS));
        // The vectors' proofs bind their chain and registry address, so the
        // release bytecode runs there; its storage starts empty, and each
        // test writes the group table it needs.
        vm.chainId(CHAIN_ID);
        vm.etch(REGISTRY, address(new GroupRegistry(threshold, addrs)).code);
        registry = GroupRegistry(REGISTRY);
    }

    // --- vectors -------------------------------------------------------------------

    function test_VectorParametersMatchTheRegistry() public {
        Tier1Harness h = _harness();
        (uint256 k, uint256 slots, uint256 interval, uint256 window, uint256 length) = h.constants();
        assertEq(k, vm.parseJsonUint(countJson, ".parameters.k"), "k");
        assertEq(slots, vm.parseJsonUint(countJson, ".parameters.slots"), "slots");
        assertEq(interval, _uint(countJson, ".parameters.rootInterval"), "interval");
        assertEq(window, _uint(countJson, ".parameters.rootWindow"), "window");
        assertEq(length, 41 + 626 * k, "record length");
        assertEq(_uint(countJson, ".context.chainId"), CHAIN_ID, "chain");
        assertTrue(_address(countJson, ".context.registry") == REGISTRY, "registry");
    }

    /// Every scope and message of vouch.json, as the registry computes them.
    function test_ScopeAndMessageVectors() public {
        Tier1Harness h = _harness();
        for (uint256 i; vm.keyExistsJson(vouchJson, _at(".scopes", i)); i++) {
            string memory p = _at(".scopes", i);
            uint64 chainId = uint64(_uint(vouchJson, string.concat(p, ".chainId")));
            address reg = _address(vouchJson, string.concat(p, ".registry"));
            bytes32 got = keccak256(bytes(vm.parseJsonString(vouchJson, string.concat(p, ".kind"))))
                == keccak256("slot")
                ? h.slotScope(
                    chainId, reg, uint16(vm.parseJsonUint(vouchJson, string.concat(p, ".slot")))
                )
                : h.voucheeScope(
                    chainId,
                    reg,
                    uint64(_uint(vouchJson, string.concat(p, ".groupId"))),
                    _uint(vouchJson, string.concat(p, ".commitment"))
                );
            assertEq(got, _bytes32(vouchJson, string.concat(p, ".scope")), p);
        }
        for (uint256 i; vm.keyExistsJson(vouchJson, _at(".messages", i)); i++) {
            string memory p = _at(".messages", i);
            bytes32 got = h.message(
                uint8(vm.parseJsonUint(vouchJson, string.concat(p, ".role"))),
                uint64(_uint(vouchJson, string.concat(p, ".chainId"))),
                _address(vouchJson, string.concat(p, ".registry")),
                uint64(_uint(vouchJson, string.concat(p, ".groupId"))),
                _uint(vouchJson, string.concat(p, ".commitment")),
                uint64(_uint(vouchJson, string.concat(p, ".tier2GroupId"))),
                uint64(_uint(vouchJson, string.concat(p, ".rootBlock"))),
                _uint(vouchJson, string.concat(p, ".otherNullifier"))
            );
            assertEq(got, _bytes32(vouchJson, string.concat(p, ".message")), p);
        }
    }

    /// Rule 7 over vouch.json's additions: every one the spec accepts or
    /// refuses only at `proof` gets the same verdict, naming the same vouch
    /// and proof, under its own chain. Its root blocks are off the grid, so
    /// the whole call refuses them at rule 5; the harness runs rule 7 alone.
    function test_ProofVectors() public {
        Tier1Harness h = _harness();
        uint256 checked;
        for (uint256 i; vm.keyExistsJson(vouchJson, _at(".additions", i)); i++) {
            string memory p = _at(".additions", i);
            bool valid = vm.parseJsonBool(vouchJson, string.concat(p, ".valid"));
            if (!valid && !_eq(vouchJson, string.concat(p, ".error"), "proof")) continue;
            assertTrue(_address(vouchJson, string.concat(p, ".context.registry")) == REGISTRY, p);
            vm.chainId(_uint(vouchJson, string.concat(p, ".context.chainId")));
            bytes memory record = _record(vouchJson, string.concat(p, ".record"));
            (bool ok, bytes memory ret) =
                address(h).call(abi.encodeCall(Tier1Harness.checkVouchProofs, (record)));
            if (valid) {
                assertTrue(ok, string.concat(p, ": refused"));
            } else {
                _assertRefused(ok, ret, _proofError(vouchJson, p), p);
            }
            checked++;
        }
        vm.chainId(CHAIN_ID);
        assertEq(checked, 17, "every valid and proof-refused addition");
    }

    /// vouch.json's rejected encodings, each refused by the whole call at the
    /// first rule that meets it in the registry's order, and each broken
    /// proof by rule 7 alone at its vouch and proof.
    function test_DecodeVectors() public {
        Tier1Harness h = _harness();
        GroupFixture.setGroup(registry, 9, 1, true, 0, 0);
        GroupFixture.setGroup(GroupRegistry(address(h)), 9, 1, true, 0, 0);
        uint256 n;
        for (; vm.keyExistsJson(vouchJson, _at(".decode", n)); n++) {
            string memory p = _at(".decode", n);
            bytes memory record = _record(vouchJson, string.concat(p, ".record"));
            (bool ok, bytes memory ret) =
                _call(registry, GroupRegistry.addTier1Member.selector, record);
            if (_eq(vouchJson, string.concat(p, ".error"), "length")) {
                _assertRefused(ok, ret, _err(GroupRegistry.MalformedRecord.selector), p);
                continue;
            }
            uint256 offset = vm.parseJsonUint(vouchJson, string.concat(p, ".offset"));
            if (offset == 8) {
                _assertRefused(
                    ok,
                    ret,
                    abi.encodeWithSelector(GroupRegistry.ForbiddenCommitment.selector, 0),
                    p
                );
            } else if (offset == 41 + 16) {
                _assertRefused(ok, ret, _vouchErr(GroupRegistry.VouchRoot.selector, 0), p);
            } else if (offset == 41 + 50) {
                _assertRefused(ok, ret, _vouchErr(GroupRegistry.VouchNullifier.selector, 0), p);
            } else {
                // Past vouch 0's fields: its off-grid root block comes first.
                _assertRefused(ok, ret, _vouchErr(GroupRegistry.RootGrid.selector, 0), p);
                uint256 at = offset - 41;
                uint256 vouch = at / 626;
                uint256 within = at % 626;
                if (within >= 114) {
                    (ok, ret) =
                        address(h).call(abi.encodeCall(Tier1Harness.checkVouchProofs, (record)));
                    _assertRefused(
                        ok,
                        ret,
                        abi.encodeWithSelector(
                            GroupRegistry.VouchProof.selector, vouch, within >= 370
                        ),
                        string.concat(p, ": proof")
                    );
                }
            }
        }
        assertEq(n, 16, "decode vectors");
    }

    /// vouch.json's refusals before any proof, each at its rule.
    function test_EarlyRefusalVectors() public {
        GroupFixture.setGroup(registry, 9, 1, true, 0, 0);
        _expectTier1Refused(
            _vouchAddition("forbidden-one"),
            abi.encodeWithSelector(GroupRegistry.ForbiddenCommitment.selector, 0)
        );
        _expectTier1Refused(
            _vouchAddition("forbidden-zero-one"),
            abi.encodeWithSelector(GroupRegistry.ForbiddenCommitment.selector, 0)
        );
        _expectTier1Refused(
            _vouchAddition("slot-max"), _vouchErr(GroupRegistry.VouchSlot.selector, 0)
        );
        // Vouches 0 and 1 are off the grid, which rule 5 meets first.
        _expectTier1Refused(
            _vouchAddition("slot-equals-L"), _vouchErr(GroupRegistry.RootGrid.selector, 0)
        );
        _expectTier1Refused(
            _vouchAddition("root-zero"), _vouchErr(GroupRegistry.RootGrid.selector, 0)
        );
    }

    /// vouch-count.json's deployment replayed through the registry, block by
    /// block in log order, with its group table: every addition the counting
    /// rule decides is accepted exactly when it fails nothing or fails only
    /// `root-mismatch`, `slot-spent` or `member`, and each other is refused at
    /// the registry's rule for the spec's failing check. Accepted additions
    /// log `Tier1MemberAdded` with the record, and store nothing.
    function test_DeploymentVectors() public {
        assertTrue(_eq(countJson, ".cases[0].id", "deployment"), "case");
        uint256 accepted;
        uint256 refused;
        uint256 j;
        for (uint256 i; this.hasKey(_at(".cases[0].events", i)); i++) {
            // One frame per event: each cheatcode call copies the whole file
            // into memory, which a frame of its own gives back.
            uint8 outcome = this.replayEvent(i, j);
            if (outcome == 1) accepted++;
            if (outcome == 2) refused++;
            if (outcome != 0) j++;
        }
        assertTrue(!this.hasKey(_at(".cases[0].additions", j)), "every verdict");
        // 10 counted, 6 the verifier leaves out at `root-mismatch`,
        // `slot-spent` or `member`, and 13 refused.
        assertEq(accepted, 16, "accepted");
        assertEq(refused, 13, "refused");
        // Nothing per addition: Tier 1 groups keep no member count.
        (,, uint64 members) = registry.groupOf(9);
        assertEq(members, 0, "no member count");
    }

    /// Whether vouch-count.json has `key`, in a frame of its own.
    function hasKey(string calldata key) external view returns (bool) {
        return vm.keyExistsJson(vm.readFile(COUNT), key);
    }

    /// Event `i` of the deployment case, at its block; a Tier 1 addition is
    /// judged against verdict `j`. Returns 0 for a group, 1 for an accepted
    /// addition and 2 for a refused one.
    function replayEvent(uint256 i, uint256 j) external returns (uint8) {
        // From the file, not storage: a storage string costs a load per word.
        string memory json = vm.readFile(COUNT);
        string memory e = _at(".cases[0].events", i);
        vm.roll(_uint(json, string.concat(e, ".block")));
        if (_eq(json, string.concat(e, ".kind"), "group-created")) {
            uint64 id = uint64(_uint(json, string.concat(e, ".groupId")));
            uint8 tier = uint8(vm.parseJsonUint(json, string.concat(e, ".tier")));
            GroupFixture.setGroup(registry, id, tier, true, 0, uint64(block.number));
            return 0;
        }
        if (!_eq(json, string.concat(e, ".kind"), "tier1-addition")) return 0;
        string memory a = _at(".cases[0].additions", j);
        assertEq(vm.parseJsonUint(json, string.concat(a, ".at")), i, "verdict order");
        bytes memory record = _record(json, string.concat(e, ".record"));
        vm.recordLogs();
        (bool ok, bytes memory ret) = _call(registry, GroupRegistry.addTier1Member.selector, record);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (_registryAccepts(json, a)) {
            assertTrue(ok, string.concat(e, ": refused"));
            assertEq(logs.length, 1, string.concat(e, ": one log"));
            assertEq(logs[0].topics.length, 1, string.concat(e, ": topics"));
            assertEq(logs[0].topics[0], GroupRegistry.Tier1MemberAdded.selector, "topic 0");
            assertTrue(keccak256(logs[0].data) == keccak256(abi.encode(record)), "data");
            return 1;
        }
        _assertRefused(ok, ret, _expectedRefusal(json, a, record), e);
        assertEq(logs.length, 0, string.concat(e, ": no log"));
        return 2;
    }

    // --- the call ------------------------------------------------------------------

    /// The registry keeps no slot, nullifier or commitment state, so the
    /// same addition lands again, and neither landing changes what another
    /// addition meets (T-25, T-53): the verifier refuses the copy.
    function test_AcceptsACopyAndStoresNothing() public {
        bytes memory record = _countedAddition();
        registry.addTier1Member(record);
        registry.addTier1Member(record);
        (,, uint64 members) = registry.groupOf(9);
        assertEq(members, 0, "no member count");
        (, uint64 count) = registry.eventAccumulator();
        assertEq(count, 2, "two events");
    }

    /// Who sends it changes nothing: the vouches are the authorisation (T-71).
    function test_AnySenderMaySubmit() public {
        bytes memory record = _countedAddition();
        vm.prank(address(0xBEEF));
        registry.addTier1Member(record);
        vm.prank(address(uint160(uint256(keccak256("anyone")))));
        registry.addTier1Member(record);
    }

    /// The proofs bind the chain and the registry's address: the same record
    /// under another chain, or at another registry, fails vouch 0's vouchee
    /// proof (T-30, T-32).
    function test_ProofsBindChainAndRegistry() public {
        bytes memory record = _countedAddition();
        vm.chainId(8453);
        _expectTier1Refused(
            record, abi.encodeWithSelector(GroupRegistry.VouchProof.selector, 0, false)
        );
        vm.chainId(CHAIN_ID);
        address other = address(uint160(REGISTRY) + 1);
        vm.etch(other, REGISTRY.code);
        GroupRegistry otherRegistry = GroupRegistry(other);
        _copyGroups(otherRegistry);
        (bool ok, bytes memory ret) =
            _call(otherRegistry, GroupRegistry.addTier1Member.selector, record);
        _assertRefused(
            ok, ret, abi.encodeWithSelector(GroupRegistry.VouchProof.selector, 0, false), "address"
        );
        registry.addTier1Member(record);
    }

    /// The group must be this registry's and Tier 1; a vouch's Tier 2 group
    /// must be Tier 2 and created by its root block.
    function test_RefusesTheWrongGroups() public {
        bytes memory record = _countedAddition();
        GroupFixture.setGroup(registry, 9, 0, false, 0, 0);
        _expectTier1Refused(record, abi.encodeWithSelector(GroupRegistry.UnknownGroup.selector, 9));
        GroupFixture.setGroup(registry, 9, 0, true, 0, 0);
        _expectTier1Refused(record, abi.encodeWithSelector(GroupRegistry.WrongTier.selector, 9, 0));
        GroupFixture.setGroup(registry, 9, 2, true, 0, 0);
        _expectTier1Refused(record, abi.encodeWithSelector(GroupRegistry.WrongTier.selector, 9, 2));
        GroupFixture.setGroup(registry, 9, 1, true, 0, 0);
        uint64 tier2 = _vouchTier2Group(record, 0);
        uint64 rootBlock = _vouchRootBlock(record, 0);
        GroupFixture.setGroup(registry, tier2, 1, true, 0, 0);
        _expectTier1Refused(record, _vouchErr(GroupRegistry.Tier2Group.selector, 0));
        GroupFixture.setGroup(registry, tier2, 2, false, 0, 0);
        _expectTier1Refused(record, _vouchErr(GroupRegistry.Tier2Group.selector, 0));
        GroupFixture.setGroup(registry, tier2, 2, true, 0, rootBlock + 1);
        _expectTier1Refused(record, _vouchErr(GroupRegistry.Tier2Group.selector, 0));
        GroupFixture.setGroup(registry, tier2, 2, true, 0, rootBlock);
        registry.addTier1Member(record);
    }

    /// The window is `root_block ≤ block.number ≤ root_block + W`, both ends
    /// included, against the block of the call.
    function test_WindowBoundsTheCallsBlock() public {
        bytes memory record = _countedAddition();
        uint256 rootBlock = _latestRootBlock(record);
        uint256 earliest = _earliestRootBlock(record);
        // Before every root block, vouch 0 is the first to fail.
        vm.roll(earliest - 1);
        _expectTier1Refused(record, _vouchErr(GroupRegistry.RootWindow.selector, 0));
        vm.roll(rootBlock);
        registry.addTier1Member(record);
        vm.roll(earliest + 302_400);
        registry.addTier1Member(record);
        vm.roll(earliest + 302_401);
        _expectTier1Refused(
            record,
            _vouchErr(GroupRegistry.RootWindow.selector, _vouchWithRootBlock(record, earliest))
        );
    }

    /// Tier 1 groups have no removal path, and the registrars' records add
    /// nothing to them (T-06, T-62).
    function test_RegistrarRecordsRefuseTierOneGroups() public {
        GroupFixture.setGroup(registry, 9, 1, true, 0, 0);
        bytes memory add = GroupFixture.encodeAdd(
            9, 0, GroupFixture.commitments(1, 1), new GroupFixture.Approval[](0)
        );
        _expectAddRefused(
            registry, add, abi.encodeWithSelector(GroupRegistry.WrongTier.selector, 9, 1)
        );
        bytes memory remove = GroupFixture.encodeRemove(
            9, 0, GroupFixture.indices(0), new GroupFixture.Approval[](0)
        );
        _expectRemoveRefused(
            registry, remove, abi.encodeWithSelector(GroupRegistry.WrongTier.selector, 9, 1)
        );
    }

    /// A record of any other length, or whose count byte isn't `k`, is
    /// refused before anything else is read, the group included.
    function test_RefusesEveryOtherLengthAndCount() public {
        bytes memory record = _countedAddition();
        GroupFixture.setGroup(registry, 9, 0, false, 0, 0);
        bytes memory malformed = _err(GroupRegistry.MalformedRecord.selector);
        _expectTier1Refused(_slice(record, 0, record.length - 1), malformed);
        _expectTier1Refused(bytes.concat(record, hex"00"), malformed);
        _expectTier1Refused(bytes.concat(record, new bytes(626)), malformed);
        _expectTier1Refused(_slice(record, 0, 41 + 626 * 2), malformed);
        _expectTier1Refused(new bytes(0), malformed);
        for (uint256 k; k < 256; k += 51) {
            if (k == 3) continue;
            bytes memory b = bytes.concat(record);
            b[40] = bytes1(uint8(k));
            _expectTier1Refused(b, malformed);
        }
        bytes memory two = bytes.concat(record);
        two[40] = 0x02;
        _expectTier1Refused(two, malformed);
        two[40] = 0x04;
        _expectTier1Refused(two, malformed);
    }

    /// Exactly one `bytes` argument, canonically encoded (T-17).
    function test_RefusesNonCanonicalCalldata() public {
        bytes memory record = _countedAddition();
        bytes memory canonical = abi.encodeCall(GroupRegistry.addTier1Member, (record));
        bytes memory refusal = _err(CanonicalCalldata.NonCanonicalCalldata.selector);
        (bool ok, bytes memory ret) = address(registry).call(bytes.concat(canonical, hex"00"));
        _assertRefused(ok, ret, refusal, "appended byte");
        (ok, ret) = address(registry).call(bytes.concat(canonical, bytes32(0)));
        _assertRefused(ok, ret, refusal, "appended word");
        bytes memory dirty = bytes.concat(canonical);
        dirty[dirty.length - 1] = 0x01;
        (ok, ret) = address(registry).call(dirty);
        _assertRefused(ok, ret, refusal, "dirty padding");
        (ok,) = address(registry).call(canonical);
        assertTrue(ok, "canonical");
    }

    /// The registry's own checks, in its order: rule 5 runs vouch by vouch,
    /// all of a vouch's fields before the next vouch's, and the duplicates
    /// come after every vouch's fields.
    function test_ChecksRunInTheRegistrysOrder() public {
        bytes memory record = _countedAddition();
        // A Tier 0 group and a forbidden commitment: the group first.
        bytes memory b = bytes.concat(record);
        _setWord(b, 8, 1);
        GroupFixture.setGroup(registry, 9, 0, true, 0, 0);
        _expectTier1Refused(b, abi.encodeWithSelector(GroupRegistry.WrongTier.selector, 9, 0));
        GroupFixture.setGroup(registry, 9, 1, true, 0, 0);
        _expectTier1Refused(
            b, abi.encodeWithSelector(GroupRegistry.ForbiddenCommitment.selector, 0)
        );
        // Vouch 1's slot out of range and vouch 0's root block off the grid:
        // vouch 0 first.
        b = bytes.concat(record);
        _setU16(b, 41 + 626 + 48, 12);
        _setU64(b, 41 + 8, _vouchRootBlock(record, 0) + 1);
        _expectTier1Refused(b, _vouchErr(GroupRegistry.RootGrid.selector, 0));
        // Within a vouch: slot, root, nullifiers, grid, window, Tier 2 group.
        b = bytes.concat(record);
        _setU16(b, 41 + 48, 12);
        _setWord(b, 41 + 16, 0);
        _expectTier1Refused(b, _vouchErr(GroupRegistry.VouchSlot.selector, 0));
        b = bytes.concat(record);
        _setWord(b, 41 + 16, GroupRegistryLib.R);
        _setWord(b, 41 + 50, GroupRegistryLib.R);
        _expectTier1Refused(b, _vouchErr(GroupRegistry.VouchRoot.selector, 0));
        b = bytes.concat(record);
        _setWord(b, 41 + 82, GroupRegistryLib.R);
        _setU64(b, 41 + 8, 1);
        _expectTier1Refused(b, _vouchErr(GroupRegistry.VouchNullifier.selector, 0));
        b = bytes.concat(record);
        _setU64(b, 41 + 8, 1);
        _setU64(b, 41, 1_000_000);
        _expectTier1Refused(b, _vouchErr(GroupRegistry.RootGrid.selector, 0));
        b = bytes.concat(record);
        _setU64(b, 41 + 8, 0);
        _setU64(b, 41, 1_000_000);
        _expectTier1Refused(b, _vouchErr(GroupRegistry.RootWindow.selector, 0));
        // A duplicate voucher in vouch 2 and a bad field in vouch 2: fields first.
        b = bytes.concat(record);
        _copyWord(b, 41 + 50, 41 + 626 * 2 + 50);
        _setU16(b, 41 + 626 * 2 + 48, 12);
        _expectTier1Refused(b, _vouchErr(GroupRegistry.VouchSlot.selector, 2));
        // Duplicate voucher before duplicate slot, each at the later vouch.
        b = bytes.concat(record);
        _copyWord(b, 41 + 626 + 50, 41 + 626 * 2 + 50);
        _copyWord(b, 41 + 82, 41 + 626 + 82);
        _expectTier1Refused(b, _vouchErr(GroupRegistry.DuplicateVoucher.selector, 2));
        b = bytes.concat(record);
        _copyWord(b, 41 + 82, 41 + 626 * 2 + 82);
        _expectTier1Refused(b, _vouchErr(GroupRegistry.DuplicateSlot.selector, 2));
        // Then the proofs, vouchee before slot.
        b = bytes.concat(record);
        b[41 + 626 + 370 + 255] ^= 0x01;
        b[41 + 626 * 2 + 114 + 255] ^= 0x01;
        _expectTier1Refused(b, abi.encodeWithSelector(GroupRegistry.VouchProof.selector, 1, true));
    }

    /// Calldata and the event carry only integers, field elements and proof
    /// points (contracts skill, No PII on-chain).
    function test_NoPersonalDataInCalldataOrEvent() public {
        bytes memory record = _countedAddition();
        bytes memory data = abi.encodeCall(GroupRegistry.addTier1Member, (record));
        assertTrue(!_looksLikeText(data), "calldata");
        vm.recordLogs();
        registry.addTier1Member(record);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(!_looksLikeText(logs[0].data), "event data");
        _expectTier1Refused(
            bytes.concat(record, "Jane Doe, 1 Main Street"),
            _err(GroupRegistry.MalformedRecord.selector)
        );
    }

    /// The event the registry emits is contract-event version 6's record of
    /// it, topics and data byte for byte (docs/spec/vectors/contract-event-v6.json,
    /// from an independent generator), so it passes 4.4's event check.
    function test_EventIsTheVersion6Record() public {
        bytes memory record = _countedAddition();
        vm.recordLogs();
        registry.addTier1Member(record);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        string memory v6 = vm.readFile("../../docs/spec/vectors/contract-event-v6.json");
        string memory id = ".records[?(@.id == 'tier1-deployment-0')].fields";
        string[] memory topics = vm.parseJsonStringArray(v6, string.concat(id, ".topics"));
        assertEq(topics.length, 1, "one topic");
        assertEq(
            logs[0].topics[0], bytes32(vm.parseBytes(string.concat("0x", topics[0]))), "topic 0"
        );
        bytes memory data =
            vm.parseBytes(string.concat("0x", vm.parseJsonString(v6, string.concat(id, ".data"))));
        assertTrue(keccak256(logs[0].data) == keccak256(data), "data");
    }

    /// A proof whose `B` is on the twist but outside the order-r subgroup
    /// (membership-proof.json's b-outside-subgroup) fails its pairing, so the
    /// registry never logs a record version 6's event check refuses (T-53).
    function test_RefusesAProofOutsideTheSubgroup() public {
        bytes memory record = _countedAddition();
        string memory mp = vm.readFile("../../docs/spec/vectors/membership-proof.json");
        bytes memory outside = vm.parseBytes(
            string.concat(
                "0x", vm.parseJsonString(mp, ".decode[?(@.name == 'b-outside-subgroup')].proof")
            )
        );
        uint256 at = 41 + 626 + 370;
        for (uint256 i; i < 256; i++) {
            record[at + i] = outside[i];
        }
        _expectTier1Refused(
            record, abi.encodeWithSelector(GroupRegistry.VouchProof.selector, 1, true)
        );
    }

    /// Any single changed bit of a counted addition is refused: every field
    /// is either checked or bound into a proof's signals (T-31, T-32).
    function testFuzz_RefusesAnyBitFlipOfAnAddition(uint256 bit) public {
        bytes memory record = _countedAddition();
        bit = bit % (record.length * 8);
        record[bit / 8] ^= bytes1(uint8(1 << (7 - bit % 8)));
        (bool ok,) = _call(registry, GroupRegistry.addTier1Member.selector, record);
        assertTrue(!ok, "flipped bit accepted");
    }

    /// The costs docs/spec/contracts.md (Group registry, Tier 1 additions,
    /// Who pays) quotes: the gas a counted addition consumes, from the test
    /// (the registry's execution and its event; a transaction adds 21,000
    /// and about 31,000 of calldata), and the least gas limit the call
    /// succeeds with, since each pairing needs `PAIRING_GAS` available.
    function test_GasOfACountedAddition() public {
        bytes memory record = _countedAddition();
        bytes memory data = abi.encodeCall(GroupRegistry.addTier1Member, (record));
        uint256 snapshot = vm.snapshotState();
        uint256 g = gasleft();
        (bool ok,) = address(registry).call(data);
        uint256 used = g - gasleft();
        assertTrue(ok, "refused");
        assertTrue(used > 1_450_000 && used < 1_520_000, "consumed");
        // The least gas limit that succeeds, each attempt on cold state.
        uint256 lo = used;
        uint256 hi = 2_000_000;
        while (hi - lo > 1_000) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snapshot);
            (ok,) = address(registry).call{gas: mid}(data);
            if (ok) hi = mid;
            else lo = mid;
        }
        assertTrue(hi > 1_750_000 && hi < 1_850_000, "least gas limit");
    }

    // --- helpers -------------------------------------------------------------------

    /// The deployment's first counted addition (event 13) with the group
    /// table it was logged against, at its block.
    function _countedAddition() internal returns (bytes memory record) {
        record = _record(countJson, ".cases[0].events[13].record");
        GroupFixture.setGroup(registry, 9, 1, true, 0, 1_000_000);
        for (uint256 i; i < 3; i++) {
            uint64 t2 = _vouchTier2Group(record, i);
            if (!_exists(registry, t2)) GroupFixture.setGroup(registry, t2, 2, true, 0, 1_000_000);
        }
        vm.roll(_uint(countJson, ".cases[0].events[13].block"));
    }

    function _copyGroups(GroupRegistry to) internal {
        for (uint64 id; id < 16; id++) {
            (uint8 tier, bool exists, uint64 members) = registry.groupOf(id);
            if (exists) {
                GroupFixture.setGroup(to, id, tier, true, members, registry.groupCreatedBlock(id));
            }
        }
    }

    function _exists(GroupRegistry reg, uint64 id) internal view returns (bool exists) {
        (, exists,) = reg.groupOf(id);
    }

    function _harness() internal returns (Tier1Harness h) {
        (, address[] memory addrs, uint8 threshold) =
            GroupFixture.keys(vm.readFile(GroupFixture.VECTORS));
        address at = address(uint160(REGISTRY) ^ 1);
        // Only the proof check runs on the harness; its address is the
        // vectors' registry, which the registry under test then leaves.
        vm.etch(REGISTRY, address(new Tier1Harness(threshold, addrs)).code);
        vm.etch(at, address(new GroupRegistry(threshold, addrs)).code);
        h = Tier1Harness(REGISTRY);
        registry = GroupRegistry(at);
    }

    /// Valid, or refused only by a check the registry leaves to the verifier.
    function _registryAccepts(string memory json, string memory a) internal view returns (bool) {
        if (vm.parseJsonBool(json, string.concat(a, ".valid"))) return true;
        string memory key = string.concat(a, ".error");
        return
            _eq(json, key, "root-mismatch") || _eq(json, key, "slot-spent")
                || _eq(json, key, "member");
    }

    /// The registry's refusal for the spec's failing check.
    function _expectedRefusal(string memory json, string memory a, bytes memory record)
        internal
        view
        returns (bytes memory)
    {
        string memory key = string.concat(a, ".error");
        if (_eq(json, key, "decode")) return _err(GroupRegistry.MalformedRecord.selector);
        if (_eq(json, key, "group")) {
            uint64 id = uint64(bytes8(record));
            (uint8 tier, bool exists,) = registry.groupOf(id);
            if (!exists) return abi.encodeWithSelector(GroupRegistry.UnknownGroup.selector, id);
            return abi.encodeWithSelector(GroupRegistry.WrongTier.selector, id, tier);
        }
        if (_eq(json, key, "proof")) return _proofError(json, a);
        uint256 vouch = vm.parseJsonUint(json, string.concat(a, ".vouch"));
        if (_eq(json, key, "root-grid")) {
            return _vouchErr(GroupRegistry.RootGrid.selector, vouch);
        }
        if (_eq(json, key, "root-window")) {
            return _vouchErr(GroupRegistry.RootWindow.selector, vouch);
        }
        if (_eq(json, key, "tier2-group")) {
            return _vouchErr(GroupRegistry.Tier2Group.selector, vouch);
        }
        if (_eq(json, key, "duplicate-voucher")) {
            return _vouchErr(GroupRegistry.DuplicateVoucher.selector, vouch);
        }
        revert(string.concat("unmapped error at ", a));
    }

    function _proofError(string memory json, string memory a) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            GroupRegistry.VouchProof.selector,
            vm.parseJsonUint(json, string.concat(a, ".vouch")),
            _eq(json, string.concat(a, ".which"), "slot")
        );
    }

    function _expectTier1Refused(bytes memory record, bytes memory expected) internal {
        (bool ok, bytes memory ret) = _call(registry, GroupRegistry.addTier1Member.selector, record);
        _assertRefused(ok, ret, expected, "addTier1Member");
    }

    function _vouchAddition(string memory id) internal view returns (bytes memory) {
        for (uint256 i; vm.keyExistsJson(vouchJson, _at(".additions", i)); i++) {
            string memory p = _at(".additions", i);
            if (_eq(vouchJson, string.concat(p, ".id"), id)) {
                return _record(vouchJson, string.concat(p, ".record"));
            }
        }
        revert(id);
    }

    function _vouchTier2Group(bytes memory record, uint256 i) internal pure returns (uint64) {
        return uint64(bytes8(_slice(record, 41 + 626 * i, 8)));
    }

    function _vouchRootBlock(bytes memory record, uint256 i) internal pure returns (uint64) {
        return uint64(bytes8(_slice(record, 41 + 626 * i + 8, 8)));
    }

    function _latestRootBlock(bytes memory record) internal pure returns (uint256 m) {
        for (uint256 i; i < 3; i++) {
            if (_vouchRootBlock(record, i) > m) m = _vouchRootBlock(record, i);
        }
    }

    function _earliestRootBlock(bytes memory record) internal pure returns (uint256 m) {
        m = type(uint256).max;
        for (uint256 i; i < 3; i++) {
            if (_vouchRootBlock(record, i) < m) m = _vouchRootBlock(record, i);
        }
    }

    function _vouchWithRootBlock(bytes memory record, uint256 rootBlock)
        internal
        pure
        returns (uint256)
    {
        for (uint256 i; i < 3; i++) {
            if (_vouchRootBlock(record, i) == rootBlock) return i;
        }
        revert("no vouch");
    }

    function _setWord(bytes memory b, uint256 at, uint256 v) internal pure {
        for (uint256 i; i < 32; i++) {
            b[at + i] = bytes1(uint8(v >> (8 * (31 - i))));
        }
    }

    function _setU64(bytes memory b, uint256 at, uint256 v) internal pure {
        for (uint256 i; i < 8; i++) {
            b[at + i] = bytes1(uint8(v >> (8 * (7 - i))));
        }
    }

    function _setU16(bytes memory b, uint256 at, uint256 v) internal pure {
        b[at] = bytes1(uint8(v >> 8));
        b[at + 1] = bytes1(uint8(v));
    }

    function _copyWord(bytes memory b, uint256 from, uint256 to) internal pure {
        for (uint256 i; i < 32; i++) {
            b[to + i] = b[from + i];
        }
    }

    function _vouchErr(bytes4 selector, uint256 vouch) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector, vouch);
    }

    function _err(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    function _at(string memory base, uint256 i) internal pure returns (string memory) {
        return string.concat(base, "[", vm.toString(i), "]");
    }

    function _eq(string memory json, string memory key, string memory value)
        internal
        pure
        returns (bool)
    {
        return keccak256(bytes(vm.parseJsonString(json, key))) == keccak256(bytes(value));
    }

    function _uint(string memory json, string memory key) internal pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, key));
    }

    function _address(string memory json, string memory key) internal pure returns (address) {
        return address(bytes20(vm.parseBytes(string.concat("0x", vm.parseJsonString(json, key)))));
    }

    function _bytes32(string memory json, string memory key) internal pure returns (bytes32) {
        return bytes32(vm.parseBytes(string.concat("0x", vm.parseJsonString(json, key))));
    }

    function _record(string memory json, string memory key) internal pure returns (bytes memory) {
        return vm.parseBytes(string.concat("0x", vm.parseJsonString(json, key)));
    }
}
