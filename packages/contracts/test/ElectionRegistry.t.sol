// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionIdLib, ElectionRegistry} from "../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {
    DefinitionEncoder,
    DefinitionHarness,
    MockTrusteeRegistry
} from "./utils/DefinitionHarness.sol";
import {RegistryFixture} from "./utils/RegistryFixture.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// The election registry of docs/spec/contracts.md (Election registry): each
/// admission rule, with a test that a definition breaking only that rule is
/// refused (T-34, T-17, T-37, T-08, T-13, T-25).
contract ElectionRegistryTest is TestBase {
    address internal constant CREATOR = address(0xC4EA);
    address internal constant OTHER = address(0x07E4);

    DefinitionHarness internal lib;
    MockTrusteeRegistry internal trustees;
    ElectionRegistry internal registry;

    function setUp() public {
        lib = new DefinitionHarness();
        trustees = new MockTrusteeRegistry();
        registry = new ElectionRegistry(RegistryFixture.deployment(address(trustees)));
        vm.warp(RegistryFixture.NOW);
        vm.roll(RegistryFixture.BLOCK);
    }

    // --- creation ------------------------------------------------------------

    function test_CreateAssignsDerivedIdentifiers() public {
        for (uint64 n; n < 3; n++) {
            vm.prank(CREATOR);
            bytes32 id = registry.createElection();
            assertEq(
                id, ElectionIdLib.electionId(uint64(block.chainid), address(registry), n), "id"
            );
            assertEq(id, registry.electionIdAt(n), "electionIdAt");
            assertTrue(registry.creatorOf(id) == CREATOR, "creator");
        }
        assertEq(registry.electionCount(), 3, "count");
    }

    function test_CreateEmitsOnlyIdentifierCreatorAndCounter() public {
        vm.recordLogs();
        vm.prank(CREATOR);
        bytes32 id = registry.createElection();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics.length, 3, "topics");
        assertEq(logs[0].topics[0], ElectionRegistry.ElectionCreated.selector, "topic 0");
        assertEq(logs[0].topics[1], id, "election id topic");
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(CREATOR))), "creator topic");
        assertTrue(keccak256(logs[0].data) == keccak256(abi.encode(uint64(0))), "data");
        _assertAccumulated(logs);
    }

    function test_CreateRefusesExtraCalldata() public {
        (bool ok, bytes memory ret) = address(registry)
            .call(abi.encodePacked(ElectionRegistry.createElection.selector, uint8(0)));
        _assertRefused(
            ok, ret, abi.encodeWithSelector(ElectionRegistry.NonCanonicalCalldata.selector)
        );
    }

    // --- registration ----------------------------------------------------------

    function test_RegistersAnApprovedDefinition() public {
        (bytes32 id, bytes memory enc) = _created();
        vm.recordLogs();
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(registry.definitionHashOf(id), lib.hash(enc), "stored hash");
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics[0], ElectionRegistry.DefinitionRegistered.selector, "topic 0");
        assertEq(logs[0].topics[1], id, "election id topic");
        assertEq(logs[0].topics[2], lib.hash(enc), "hash topic");
        // T-17: the event carries the definition's canonical bytes and
        // nothing else, so the board and archive hold only defined fields.
        assertTrue(keccak256(logs[0].data) == keccak256(abi.encode(enc)), "data");
        (, uint64 count) = registry.eventAccumulator();
        assertEq(count, 2, "both events accumulated");
    }

    function test_RefusesASecondRegistration() public {
        (bytes32 id, bytes memory enc) = _created();
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
        // Another definition for the same election, also approved by the panel.
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        d.optionCount = 4;
        bytes memory other = RegistryFixture.approve(lib, trustees, d);
        _expectRefused(
            CREATOR, other, abi.encodeWithSelector(ElectionRegistry.AlreadyRegistered.selector, id)
        );
        _expectRefused(
            CREATOR, enc, abi.encodeWithSelector(ElectionRegistry.AlreadyRegistered.selector, id)
        );
    }

    function test_RefusesAnyoneButTheCreator() public {
        (bytes32 id, bytes memory enc) = _created();
        _expectRefused(
            OTHER, enc, abi.encodeWithSelector(ElectionRegistry.NotCreator.selector, id, OTHER)
        );
    }

    function test_RefusesAnElectionItDidNotCreate() public {
        // An identifier this registry would assign next, but hasn't yet.
        bytes32 id = registry.electionIdAt(0);
        bytes memory enc =
            RegistryFixture.approve(lib, trustees, RegistryFixture.template(registry, id));
        _expectRefused(
            CREATOR, enc, abi.encodeWithSelector(ElectionRegistry.UnknownElection.selector, id)
        );
    }

    function test_RefusesAMalformedDefinition() public {
        (, bytes memory enc) = _created();
        bytes memory cut = new bytes(enc.length - 1);
        for (uint256 i; i < cut.length; i++) {
            cut[i] = enc[i];
        }
        _expectRefused(
            CREATOR,
            cut,
            abi.encodeWithSelector(
                ElectionDefinitionLib.DefinitionMalformed.selector,
                ElectionDefinitionLib.DecodeError.Truncated,
                cut.length - 31
            )
        );
    }

    function test_RefusesAnIllFormedDefinition() public {
        (bytes32 id,) = _created();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        d.threshold = 1; // T-14
        bytes memory enc = RegistryFixture.approve(lib, trustees, d);
        _expectRefused(
            CREATOR,
            enc,
            abi.encodeWithSelector(
                ElectionRegistry.DefinitionIllFormed.selector, ElectionDefinitionLib.Rule.Panel
            )
        );
    }

    /// Each chain ID and address must be this deployment's (T-17, T-34).
    function test_RefusesAnotherDeployment() public {
        for (uint256 f; f < 8; f++) {
            (bytes32 id,) = _created();
            ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
            address stray = address(uint160(0xDEAD0000 + f));
            if (f == 0) d.l2ChainId = 10;
            else if (f == 1) d.l1ChainId = 1;
            else if (f == 2) d.electionRegistry = stray;
            else if (f == 3) d.board = stray;
            else if (f == 4) d.trusteeRegistry = stray;
            else if (f == 5) d.groupRegistry = stray;
            else if (f == 6) d.l1Anchor = stray;
            else d.l1Relay = stray;
            bytes memory enc = RegistryFixture.approve(lib, trustees, d);
            _expectRefused(
                CREATOR,
                enc,
                abi.encodeWithSelector(
                    ElectionRegistry.WrongDeployment.selector, ElectionRegistry.DeploymentField(f)
                )
            );
        }
    }

    function test_RefusesAnElectionOpeningBeforeTheEpoch() public {
        vm.warp(RegistryFixture.EPOCH - 100);
        (bytes32 id,) = _created();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        d.opensAt = RegistryFixture.EPOCH - 1;
        bytes memory enc = RegistryFixture.approve(lib, trustees, d);
        _expectRefused(
            CREATOR,
            enc,
            abi.encodeWithSelector(
                ElectionRegistry.OpensBeforeEpoch.selector,
                RegistryFixture.EPOCH - 1,
                RegistryFixture.EPOCH
            )
        );
        // At the epoch exactly is allowed.
        d.opensAt = RegistryFixture.EPOCH;
        enc = RegistryFixture.approve(lib, trustees, d);
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
    }

    function test_RefusesAnElectionAlreadyOpen() public {
        (bytes32 id, bytes memory enc) = _created();
        uint64 opensAt = RegistryFixture.template(registry, id).opensAt;
        vm.warp(opensAt);
        _expectRefused(
            CREATOR,
            enc,
            abi.encodeWithSelector(ElectionRegistry.AlreadyOpen.selector, opensAt, opensAt)
        );
        vm.warp(opensAt - 1);
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
    }

    /// The electorate is in the past (T-08, T-13): a root at the registering
    /// block itself is refused, one block earlier is not.
    function test_RefusesARootNotInThePast() public {
        (bytes32 id,) = _created();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        d.electorate[1].rootL2Block = uint64(block.number);
        bytes memory enc = RegistryFixture.approve(lib, trustees, d);
        _expectRefused(
            CREATOR,
            enc,
            abi.encodeWithSelector(
                ElectionRegistry.RootNotInPast.selector,
                uint8(2),
                uint64(block.number),
                block.number
            )
        );
        vm.roll(block.number + 1);
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
    }

    /// T-37: a ceremony counts only for the stub it was recorded with.
    function test_RefusesACeremonyNotRecordedForThisStub() public {
        bytes32 id = _create();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        bytes memory enc = DefinitionEncoder.encode(d);
        bytes32 stub = lib.stubHash(enc);
        _expectRefused(
            CREATOR,
            enc,
            abi.encodeWithSelector(
                ElectionRegistry.CeremonyNotRecorded.selector, stub, d.ceremonyTranscriptHash
            )
        );
        // Recorded for another stub with the same transcript hash: still refused.
        trustees.record(
            bytes32(uint256(stub) ^ 1),
            d.ceremonyTranscriptHash,
            d.panelId,
            d.threshold,
            d.panelSize
        );
        _expectRefused(
            CREATOR,
            enc,
            abi.encodeWithSelector(
                ElectionRegistry.CeremonyNotRecorded.selector, stub, d.ceremonyTranscriptHash
            )
        );
    }

    /// T-14, T-37: the trustee registry is asked about the panel and
    /// threshold the definition names, so an approval recorded for this stub
    /// under another panel or threshold doesn't count.
    function test_RefusesACeremonyRecordedForAnotherPanel() public {
        bytes32 id = _create();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        bytes memory enc = DefinitionEncoder.encode(d);
        bytes32 stub = lib.stubHash(enc);
        bytes memory refusal = abi.encodeWithSelector(
            ElectionRegistry.CeremonyNotRecorded.selector, stub, d.ceremonyTranscriptHash
        );
        trustees.record(
            stub, d.ceremonyTranscriptHash, sha256("other panel"), d.threshold, d.panelSize
        );
        trustees.record(stub, d.ceremonyTranscriptHash, d.panelId, d.threshold + 1, d.panelSize);
        trustees.record(stub, d.ceremonyTranscriptHash, d.panelId, d.threshold, d.panelSize + 1);
        _expectRefused(CREATOR, enc, refusal);
        trustees.record(stub, d.ceremonyTranscriptHash, d.panelId, d.threshold, d.panelSize);
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
    }

    /// A transcript hash may repeat across definitions (election-definition.md,
    /// Stub hash): no first-come rule anyone else could use to block one (T-25).
    function test_AllowsARepeatedTranscriptHash() public {
        (bytes32 a, bytes memory encA) = _created();
        (bytes32 b,) = _created();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, b);
        d.ceremonyTranscriptHash = RegistryFixture.template(registry, a).ceremonyTranscriptHash;
        bytes memory encB = RegistryFixture.approve(lib, trustees, d);
        vm.prank(CREATOR);
        registry.registerDefinition(encA);
        vm.prank(CREATOR);
        registry.registerDefinition(encB);
    }

    // --- personal data (contracts skill, No PII on-chain; T-17) --------------

    /// Representative inputs leave no free text in calldata or events: every
    /// input is a fixed-format field, and each event carries only the
    /// identifier, creator, counter, hash and the definition's own encoding.
    function test_NoFreeTextInCalldataOrEvents() public {
        vm.recordLogs();
        (, bytes memory enc) = _created();
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(
            !_looksLikeText(abi.encodeCall(ElectionRegistry.registerDefinition, (enc))), "calldata"
        );
        assertEq(logs.length, 2, "two logs");
        for (uint256 i; i < logs.length; i++) {
            assertTrue(!_looksLikeText(logs[i].data), "event data");
            for (uint256 t; t < logs[i].topics.length; t++) {
                assertTrue(!_looksLikeText(abi.encode(logs[i].topics[t])), "event topic");
            }
        }
    }

    /// Text can't ride along with a definition: anything after its last
    /// field is refused, so a name or an email address never reaches the
    /// event or the archive that way. (Chosen bytes inside a fixed field,
    /// such as the display-text commitment, are T-17's stated residual.)
    function test_RefusesTextAppendedToADefinition() public {
        (, bytes memory enc) = _created();
        bytes memory withText = abi.encodePacked(enc, "Alice Smith, alice@example.com, P1234567");
        assertTrue(_looksLikeText(withText), "detector misses the text");
        _expectRefused(
            CREATOR,
            withText,
            abi.encodeWithSelector(
                ElectionDefinitionLib.DefinitionMalformed.selector,
                ElectionDefinitionLib.DecodeError.TrailingBytes,
                enc.length
            )
        );
    }

    // --- calldata ------------------------------------------------------------

    function test_RefusesNonCanonicalCalldata() public {
        (, bytes memory enc) = _created();
        assertTrue(enc.length % 32 != 0, "template must need padding");
        bytes memory good = abi.encodeCall(ElectionRegistry.registerDefinition, (enc));
        bytes memory refusal =
            abi.encodeWithSelector(ElectionRegistry.NonCanonicalCalldata.selector);

        bytes memory trailing = abi.encodePacked(good, bytes32(0));
        bytes memory dirtyPadding = abi.encodePacked(good);
        dirtyPadding[dirtyPadding.length - 1] = 0x01;
        // The same bytes at offset 0x40, with a junk word before them.
        bytes memory moved = abi.encodePacked(
            ElectionRegistry.registerDefinition.selector,
            uint256(0x40),
            uint256(0),
            _slice(good, 36, good.length - 36)
        );
        // Offset 0 reads the offset word itself as a zero length, so the
        // word after it is junk that the length check alone would let through.
        bytes memory zeroOffset = abi.encodePacked(
            ElectionRegistry.registerDefinition.selector, uint256(0), bytes32("junk")
        );
        bytes[4] memory bad = [trailing, dirtyPadding, moved, zeroOffset];
        for (uint256 i; i < 4; i++) {
            vm.prank(CREATOR);
            (bool ok, bytes memory ret) = address(registry).call(bad[i]);
            _assertRefused(ok, ret, refusal);
        }
        vm.prank(CREATOR);
        (bool success,) = address(registry).call(good);
        assertTrue(success, "canonical calldata refused");
    }

    // --- fuzz ----------------------------------------------------------------

    /// T-34, T-37: once the panel approved a definition, changing any one
    /// bit of it gives a definition the registry refuses, whatever the bit:
    /// the stub hash covers every field but the transcript hash, and the
    /// transcript hash is checked with it.
    function testFuzz_AnyBitFlipOfAnApprovedDefinitionIsRefused(uint256 bit) public {
        (, bytes memory enc) = _created();
        bit %= enc.length * 8;
        enc[bit / 8] ^= bytes1(uint8(1 << (7 - (bit % 8))));
        vm.prank(CREATOR);
        (bool ok,) =
            address(registry).call(abi.encodeCall(ElectionRegistry.registerDefinition, (enc)));
        assertTrue(!ok, "a changed definition was registered");
    }

    /// Arbitrary bytes are never registered.
    function testFuzz_ArbitraryBytesAreRefused(bytes calldata junk) public {
        _created();
        vm.prank(CREATOR);
        (bool ok,) =
            address(registry).call(abi.encodeCall(ElectionRegistry.registerDefinition, (junk)));
        assertTrue(!ok, "junk was registered");
    }

    // --- deployment ----------------------------------------------------------

    function test_DeploymentRefusesWhatNoDefinitionCouldName() public {
        for (uint256 c; c < 8; c++) {
            ElectionRegistry.Deployment memory dep = RegistryFixture.deployment(address(trustees));
            if (c == 0) dep.board = address(0);
            else if (c == 1) dep.groupRegistry = dep.board;
            else if (c == 2) dep.trusteeRegistry = dep.groupRegistry;
            else if (c == 3) dep.l1ChainId = 0;
            else if (c == 4) dep.l1ChainId = uint64(block.chainid);
            else if (c == 5) dep.l1Anchor = address(0);
            else if (c == 6) dep.l1Relay = address(0);
            else dep.l1Relay = dep.l1Anchor;
            vm.expectRevert(abi.encodeWithSelector(ElectionRegistry.InvalidDeployment.selector));
            new ElectionRegistry(dep);
        }
    }

    function test_DeploymentRecordsItsParameters() public view {
        ElectionRegistry.Deployment memory dep = RegistryFixture.deployment(address(trustees));
        assertTrue(registry.board() == dep.board, "board");
        assertTrue(registry.trusteeRegistry() == dep.trusteeRegistry, "trustee registry");
        assertTrue(registry.groupRegistry() == dep.groupRegistry, "group registry");
        assertEq(registry.l1ChainId(), dep.l1ChainId, "l1 chain");
        assertTrue(registry.l1Anchor() == dep.l1Anchor, "anchor");
        assertTrue(registry.l1Relay() == dep.l1Relay, "relay");
        assertEq(registry.epoch(), dep.epoch, "epoch");
        assertEq(registry.electionCount(), 0, "no elections");
    }

    // --- helpers -------------------------------------------------------------

    /// Creates an election as CREATOR and returns its approved template definition.
    function _created() internal returns (bytes32 id, bytes memory enc) {
        id = _create();
        enc = RegistryFixture.approve(lib, trustees, RegistryFixture.template(registry, id));
    }

    /// Creates an election as CREATOR, with no ceremony recorded for it.
    function _create() internal returns (bytes32 id) {
        vm.prank(CREATOR);
        id = registry.createElection();
    }

    function _expectRefused(address caller, bytes memory enc, bytes memory revertData) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) =
            address(registry).call(abi.encodeCall(ElectionRegistry.registerDefinition, (enc)));
        _assertRefused(ok, ret, revertData);
    }

    function _assertRefused(bool ok, bytes memory ret, bytes memory expected) internal pure {
        assertTrue(!ok, "call succeeded");
        assertTrue(keccak256(ret) == keccak256(expected), "unexpected revert data");
    }

    function _assertAccumulated(Vm.Log[] memory logs) internal view {
        bytes32 acc = EventAccumulatorLib.genesis(uint64(block.chainid), address(registry));
        for (uint256 i; i < logs.length; i++) {
            acc = EventAccumulatorLib.step(acc, uint64(i), logs[i].topics, logs[i].data);
        }
        (bytes32 stored, uint64 count) = registry.eventAccumulator();
        assertEq(stored, acc, "accumulator");
        assertEq(count, logs.length, "count");
    }

    /// A crude personal-data detector: an at sign, or a run of 8 or more
    /// printable ASCII characters (a name, an address, a document number).
    function _looksLikeText(bytes memory b) internal pure returns (bool) {
        uint256 run;
        for (uint256 i; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c == 0x40) return true;
            run = c >= 0x20 && c < 0x7f ? run + 1 : 0;
            if (run >= 8) return true;
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
