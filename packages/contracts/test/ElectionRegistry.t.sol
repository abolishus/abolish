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
import {MockL1Block} from "./utils/MockL1Block.sol";
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
    MockL1Block internal l1;

    function setUp() public {
        l1 = RegistryFixture.installL1Block(vm);
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

    function test_CreateEmitsOnlyIdentifierCreatorCounterAndL1Origin() public {
        vm.recordLogs();
        vm.prank(CREATOR);
        bytes32 id = registry.createElection();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one log");
        assertEq(logs[0].topics.length, 3, "topics");
        assertEq(logs[0].topics[0], ElectionRegistry.ElectionCreated.selector, "topic 0");
        assertEq(logs[0].topics[1], id, "election id topic");
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(CREATOR))), "creator topic");
        assertTrue(
            keccak256(logs[0].data)
                == keccak256(
                    abi.encode(
                        uint64(0),
                        RegistryFixture.L1_ORIGIN_NUMBER,
                        RegistryFixture.L1_ORIGIN_TIMESTAMP,
                        RegistryFixture.L1_ORIGIN_HASH
                    )
                ),
            "data"
        );
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
        // T-17: the event carries the block's L1 origin and the definition's
        // canonical bytes and nothing else, so the board and archive hold
        // only defined fields.
        assertTrue(
            keccak256(logs[0].data)
                == keccak256(
                    abi.encode(
                        RegistryFixture.L1_ORIGIN_NUMBER,
                        RegistryFixture.L1_ORIGIN_TIMESTAMP,
                        RegistryFixture.L1_ORIGIN_HASH,
                        enc
                    )
                ),
            "data"
        );
        (, uint64 count) = registry.eventAccumulator();
        assertEq(count, 2, "both events accumulated");
    }

    // --- parameters (ADR 0028, 1C; docs/spec/contracts.md, Parameters) ----------

    function test_RecordsTheBoardsParameters() public {
        bytes32 id = _create();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        d.electionType = 2;
        d.optionCount = 5;
        d.minSelections = 1;
        d.maxSelections = 4;
        d.threshold = 3;
        d.panelSize = 9;
        ElectionDefinitionLib.TierGroup[] memory e = new ElectionDefinitionLib.TierGroup[](3);
        e[0] = d.electorate[0];
        e[1] = ElectionDefinitionLib.TierGroup({
            tier: 1,
            groupId: 2,
            root: ElectionDefinitionLib.BN254_R - 1,
            rootL2Block: RegistryFixture.ROOT_BLOCK,
            groupSize: 9
        });
        e[2] = d.electorate[1];
        d.electorate = e;
        bytes memory enc = RegistryFixture.approve(lib, trustees, d);
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
        _assertParameters(lib.hash(enc), d);
    }

    /// Fuzzed limits, panel, tiers and roots: whatever is registered is what the
    /// board reads.
    function testFuzz_ParametersAreTheDefinitions(
        uint16 optionCount,
        uint16 minSelections,
        uint16 maxSelections,
        uint8 threshold,
        uint8 panelSize,
        uint8 tierMask,
        uint256 rootSeed
    ) public {
        bytes32 id = _create();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        d.electionType = 2;
        d.optionCount = uint16(_bound(optionCount, 2, 64));
        d.maxSelections = uint16(_bound(maxSelections, 1, d.optionCount));
        d.minSelections = uint16(_bound(minSelections, 0, d.maxSelections));
        d.panelSize = uint8(_bound(panelSize, 2, 16));
        d.threshold = uint8(_bound(threshold, 2, d.panelSize));
        // Any non-empty ascending subset of the tiers, each with its own root
        // below r, so the cells' order and roots are the definition's.
        uint256 mask = _bound(tierMask, 1, 7);
        uint256 count = (mask & 1) + (mask >> 1 & 1) + (mask >> 2);
        ElectionDefinitionLib.TierGroup[] memory e = new ElectionDefinitionLib.TierGroup[](count);
        uint256 n;
        for (uint8 t; t < 3; t++) {
            if (mask >> t & 1 == 0) continue;
            e[n] = ElectionDefinitionLib.TierGroup({
                tier: t,
                groupId: t + 1,
                root: uint256(keccak256(abi.encode(rootSeed, t))) % ElectionDefinitionLib.BN254_R,
                rootL2Block: RegistryFixture.ROOT_BLOCK,
                groupSize: 10
            });
            n++;
        }
        d.electorate = e;
        bytes memory enc = RegistryFixture.approve(lib, trustees, d);
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
        _assertParameters(lib.hash(enc), d);
    }

    /// Versions 3 to 5 (docs/spec/contracts.md, Parameters): the cells are
    /// every tier's `cells`, tier by tier; version 5 records each question
    /// and their total. Version 6 is refused (Profile below), so no author
    /// panel is ever recorded yet.
    function test_RecordsEachVersionsParameters() public {
        for (uint8 version = 3; version <= 5; version++) {
            bytes32 id = _create();
            ElectionDefinitionLib.Definition memory d =
                RegistryFixture.templateV(registry, id, version);
            bytes memory enc = RegistryFixture.approve(lib, trustees, d);
            vm.prank(CREATOR);
            registry.registerDefinition(enc);
            bytes32 h = lib.hash(enc);
            assertEq(registry.definitionHashOf(id), h, "registered");
            _assertParameters(h, d);
            ElectionRegistry.Parameters memory p = registry.parameters(h);
            // The values, written out, so a wrong reading in the fixture's
            // helpers can't hide one in the registry.
            assertEq(p.cellCount, 3, "three cells");
            (uint8 tier, uint256 root) = registry.cell(h, 1);
            assertEq(tier, 0, "Tier 0's second cell");
            assertEq(root, 0x1235, "its root");
            (tier, root) = registry.cell(h, 2);
            assertEq(tier, 2, "Tier 2's cell");
            assertEq(p.optionCount, version < 5 ? 3 : 8, "T");
            assertEq(p.questions.length, version < 5 ? 1 : 2, "questions");
            assertEq(p.authorThreshold, 0, "no author threshold");
            assertEq(p.authorPanelSize, 0, "no author panel");
        }
    }

    /// Fuzzed questions of a version-5 definition: each is recorded in
    /// order, with their total.
    function testFuzz_QuestionsAreTheDefinitions(uint256 seed) public {
        bytes32 id = _create();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.templateV(registry, id, 5);
        uint256 count = _bound(seed, 1, 32);
        d.questions = new ElectionDefinitionLib.Question[](count);
        uint256 budget = 64;
        for (uint256 i; i < count; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            // Leave two options for every later question.
            uint256 m = _bound(r, 2, budget - 2 * (count - 1 - i));
            budget -= m;
            uint256 mx = _bound(r >> 64, 1, m);
            d.questions[i] = ElectionDefinitionLib.Question(
                1, uint16(m), uint16(_bound(r >> 128, 0, mx)), uint16(mx)
            );
        }
        bytes memory enc = RegistryFixture.approve(lib, trustees, d);
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
        _assertParameters(lib.hash(enc), d);
    }

    // --- profile (docs/spec/contracts.md, Registration, rule 9) -----------------

    /// The profile the registry serves for each definition version it
    /// decodes, by pin (type 0x0001 to 0x0009), written from the spec: 0
    /// where any version is admitted. Version 6 has none.
    function _served(uint8 version) internal pure returns (uint8[9] memory v) {
        if (version == 1) return [1, 1, 1, 0, 0, 0, 5, 4, 1];
        if (version == 3) return [3, 2, 2, 0, 0, 0, 5, 4, 1];
        if (version == 4) return [4, 2, 2, 0, 0, 0, 5, 4, 1];
        return [5, 3, 2, 0, 0, 0, 5, 4, 2];
    }

    function _templateOf(bytes32 id, uint8 version)
        internal
        view
        returns (ElectionDefinitionLib.Definition memory)
    {
        return version == 1
            ? RegistryFixture.template(registry, id)
            : RegistryFixture.templateV(registry, id, version);
    }

    /// Every served profile registers, whatever the pins the check leaves to
    /// the verifier (the receipt, ceremony transcript and tally opening).
    function test_RegistersEachServedProfile() public {
        uint8[4] memory versions = [1, 3, 4, 5];
        for (uint256 i; i < 4; i++) {
            for (uint8 other = 1; other <= 3; other++) {
                bytes32 id = _create();
                ElectionDefinitionLib.Definition memory d = _templateOf(id, versions[i]);
                uint8[9] memory served = _served(versions[i]);
                for (uint256 t; t < 9; t++) {
                    assertEq(d.pinVersions[t], served[t] == 0 ? 1 : served[t], "template pins");
                }
                d.pinVersions[3] = other;
                d.pinVersions[4] = other;
                d.pinVersions[5] = other;
                bytes memory enc = RegistryFixture.approve(lib, trustees, d);
                vm.prank(CREATOR);
                registry.registerDefinition(enc);
                assertEq(registry.definitionHashOf(id), lib.hash(enc), "registered");
            }
        }
    }

    /// Each served pin set to any other version from 1 to 7 is refused with
    /// its record type and the version pinned, and nothing is recorded:
    /// contract-event versions 1 to 3, which can't read all the board's events;
    /// board-entry versions without the close statement; ballot versions the
    /// board can't check, or that don't name the definition's cells; opening
    /// versions that don't open the ballot's cores; and display-text versions
    /// without the definition's questions (T-25, T-50, T-42, T-53).
    function test_RefusesEachPinTheDeploymentDoesntServe() public {
        uint8[4] memory versions = [1, 3, 4, 5];
        for (uint256 i; i < 4; i++) {
            uint8[9] memory served = _served(versions[i]);
            for (uint256 t = 1; t < 9; t++) {
                if (served[t] == 0) continue;
                for (uint8 v = 1; v <= 7; v++) {
                    if (v == served[t]) continue;
                    bytes32 id = _create();
                    ElectionDefinitionLib.Definition memory d = _templateOf(id, versions[i]);
                    d.pinVersions[t] = v;
                    bytes memory enc = RegistryFixture.approve(lib, trustees, d);
                    _expectRefused(
                        CREATOR,
                        enc,
                        abi.encodeWithSelector(
                            ElectionRegistry.ProfileNotServed.selector, uint16(t + 1), v
                        )
                    );
                    _assertNoParameters(lib.hash(enc));
                }
            }
        }
    }

    /// A version-6 definition is refused at its ballot pin whatever it pins:
    /// its ballot version 4 carries the author half, which the board can't
    /// check yet (docs/spec/contracts.md, Registration; P2-16 part 5).
    function test_RefusesEveryVersion6Definition() public {
        for (uint8 v = 1; v <= 7; v++) {
            bytes32 id = _create();
            ElectionDefinitionLib.Definition memory d = RegistryFixture.templateV(registry, id, 6);
            d.pinVersions[1] = v;
            d.pinVersions[2] = 3;
            d.pinVersions[8] = 2;
            bytes memory enc = RegistryFixture.approve(lib, trustees, d);
            _expectRefused(
                CREATOR,
                enc,
                abi.encodeWithSelector(ElectionRegistry.ProfileNotServed.selector, uint16(2), v)
            );
            _assertNoParameters(lib.hash(enc));
        }
    }

    /// Any profile: registered exactly when every served pin is the served
    /// version, else refused at the first wrong one in type order.
    function testFuzz_ProfileServedExactly(uint256 which, uint8[9] memory pins) public {
        uint8[4] memory versions = [1, 3, 4, 5];
        uint8 version = versions[_bound(which, 0, 3)];
        uint8[9] memory served = _served(version);
        bytes32 id = _create();
        ElectionDefinitionLib.Definition memory d = _templateOf(id, version);
        bytes memory expected;
        for (uint256 t = 1; t < 9; t++) {
            // Mostly the served version, so registrations happen too.
            uint8 v = pins[t] % 4 == 0 ? uint8(_bound(pins[t], 1, 255)) : d.pinVersions[t];
            d.pinVersions[t] = v;
            if (expected.length == 0 && served[t] != 0 && v != served[t]) {
                expected = abi.encodeWithSelector(
                    ElectionRegistry.ProfileNotServed.selector, uint16(t + 1), v
                );
            }
        }
        bytes memory enc = RegistryFixture.approve(lib, trustees, d);
        if (expected.length == 0) {
            vm.prank(CREATOR);
            registry.registerDefinition(enc);
            assertEq(registry.definitionHashOf(id), lib.hash(enc), "registered");
        } else {
            _expectRefused(CREATOR, enc, expected);
            _assertNoParameters(lib.hash(enc));
        }
    }

    /// Each version's own rules are applied at registration: an ill-formed
    /// definition of any version is refused with its rule.
    function test_RefusesEachVersionsIllFormedDefinitions() public {
        ElectionDefinitionLib.Rule[4] memory rules = [
            ElectionDefinitionLib.Rule.Cells,
            ElectionDefinitionLib.Rule.ReceiptKeys,
            ElectionDefinitionLib.Rule.Selections,
            ElectionDefinitionLib.Rule.AuthorPanel
        ];
        for (uint8 version = 3; version <= 6; version++) {
            bytes32 id = _create();
            ElectionDefinitionLib.Definition memory d =
                RegistryFixture.templateV(registry, id, version);
            if (version == 3) d.tiers[0].cells[1].members = 1999;
            if (version == 4) d.receiptKeys = new ElectionDefinitionLib.P256Key[](0);
            if (version == 5) d.questions[1].minSelections = 3;
            if (version == 6) d.authorKeys[2] = d.authorKeys[0];
            bytes memory enc = RegistryFixture.approve(lib, trustees, d);
            _expectRefused(
                CREATOR,
                enc,
                abi.encodeWithSelector(
                    ElectionRegistry.DefinitionIllFormed.selector, rules[version - 3]
                )
            );
            _assertNoParameters(lib.hash(enc));
        }
    }

    /// A version-4 definition listing a key that isn't on P-256 doesn't
    /// decode, so it is never registered or archived (T-17, T-31).
    function test_RefusesAReceiptKeyOffTheCurve() public {
        bytes32 id = _create();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.templateV(registry, id, 4);
        // x = 1 has no point: 1 − 3 + b isn't a square mod p.
        d.receiptKeys[0] = ElectionDefinitionLib.P256Key(2, bytes32(uint256(1)));
        bytes memory enc = DefinitionEncoder.encode(d);
        uint256 at = enc.length - 33;
        _expectRefused(
            CREATOR,
            enc,
            abi.encodeWithSelector(
                ElectionDefinitionLib.DefinitionMalformed.selector,
                ElectionDefinitionLib.DecodeError.NonCanonical,
                at
            )
        );
    }

    /// The fold at its floor, and a group shared with an earlier tier's
    /// last group (docs/spec/election-definition.md, Regional cells; T-16,
    /// T-01): cases the vectors don't reach.
    function test_FoldAndGroupEdges() public {
        bytes32 id = _create();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.templateV(registry, id, 3);
        // Tier 0: one large region and two small ones summing to exactly the
        // floor, so the tier is split, with the remainder as its own cell.
        d.tiers[0].regions = new uint64[](3);
        d.tiers[0].regions[0] = 3000;
        d.tiers[0].regions[1] = 600;
        d.tiers[0].regions[2] = 400;
        d.tiers[0].groups[2].region = 2;
        d.tiers[0].cells[1].members = 1000;
        assertTrue(_rule(d) == ElectionDefinitionLib.Rule.None, "remainder at the floor");
        // The remainder cell must state its regions' sum.
        d.tiers[0].cells[1].members = 999;
        assertTrue(_rule(d) == ElectionDefinitionLib.Rule.Cells, "remainder misstated");
        // One member fewer: the remainder is below the floor, so the tier is
        // one cell of every region.
        d.tiers[0].regions[2] = 399;
        d.tiers[0].cells[1].members = 999;
        assertTrue(_rule(d) == ElectionDefinitionLib.Rule.Cells, "split below the floor");
        d.tiers[0].cells = new ElectionDefinitionLib.Cell[](1);
        d.tiers[0].cells[0] = ElectionDefinitionLib.Cell(0x1234, 3999);
        assertTrue(_rule(d) == ElectionDefinitionLib.Rule.None, "unsplit");
        // Tier 2 names Tier 0's largest group.
        d.tiers[1].groups[0].groupId = 4;
        assertTrue(_rule(d) == ElectionDefinitionLib.Rule.Electorate, "group in two tiers");
    }

    function _rule(ElectionDefinitionLib.Definition memory d)
        internal
        view
        returns (ElectionDefinitionLib.Rule)
    {
        return lib.rule(DefinitionEncoder.encode(d));
    }

    function test_AnUnregisteredHashHasNoParameters() public {
        (, bytes memory enc) = _created();
        // Approved and created, but not yet registered.
        _assertNoParameters(lib.hash(enc));
    }

    function test_ARefusedRegistrationRecordsNoParameters() public {
        (bytes32 id, bytes memory enc) = _created();
        _expectRefused(
            OTHER, enc, abi.encodeWithSelector(ElectionRegistry.NotCreator.selector, id, OTHER)
        );
        _assertNoParameters(lib.hash(enc));
        // A second definition for a registered election records nothing either.
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        d.optionCount = 4;
        bytes memory other = RegistryFixture.approve(lib, trustees, d);
        _expectRefused(
            CREATOR, other, abi.encodeWithSelector(ElectionRegistry.AlreadyRegistered.selector, id)
        );
        _assertNoParameters(lib.hash(other));
        assertEq(registry.parameters(lib.hash(enc)).optionCount, 3, "first kept");
    }

    // --- the L1 origin (ADR 0025; docs/spec/contracts.md, Events) -------------

    /// The signatures [[contracts]] lists, so a changed field order or type
    /// can't pass unnoticed.
    function test_EventSignaturesAreTheSpecifiedOnes() public pure {
        assertEq(
            ElectionRegistry.ElectionCreated.selector,
            keccak256("ElectionCreated(bytes32,address,uint64,uint64,uint64,bytes32)"),
            "ElectionCreated"
        );
        assertEq(
            ElectionRegistry.DefinitionRegistered.selector,
            keccak256("DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)"),
            "DefinitionRegistered"
        );
    }

    /// Each event carries the origin of its own block, read in the emitting
    /// call: a creation and a registration under different origins record
    /// each its own, which `f` and a retired version's cutoff rest on.
    function test_EachEventCarriesItsOwnBlocksL1Origin() public {
        l1.set(100, 1_700_000_100, keccak256("first"));
        vm.recordLogs();
        (bytes32 id, bytes memory enc) = _created();
        l1.set(101, 1_700_000_112, keccak256("second"));
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "two logs");
        (uint64 counter, uint64 n0, uint64 t0, bytes32 h0) =
            abi.decode(logs[0].data, (uint64, uint64, uint64, bytes32));
        assertEq(counter, 0, "counter");
        assertEq(n0, 100, "creation origin number");
        assertEq(t0, 1_700_000_100, "creation origin timestamp");
        assertEq(h0, keccak256("first"), "creation origin hash");
        (uint64 n1, uint64 t1, bytes32 h1, bytes memory def) =
            abi.decode(logs[1].data, (uint64, uint64, bytes32, bytes));
        assertEq(n1, 101, "registration origin number");
        assertEq(t1, 1_700_000_112, "registration origin timestamp");
        assertEq(h1, keccak256("second"), "registration origin hash");
        assertTrue(keccak256(def) == keccak256(enc), "definition");
        assertEq(logs[1].topics[1], id, "election id topic");
    }

    /// Any origin the predeploy reports, the extremes included, reaches each
    /// event exactly as reported: the registry neither checks nor alters it
    /// (the verifier does, 4.4), and the accumulator covers it.
    function testFuzz_EventsCarryTheReportedOrigin(uint64 number, uint64 timestamp, bytes32 hash)
        public
    {
        l1.set(number, timestamp, hash);
        vm.recordLogs();
        (bytes32 id, bytes memory enc) = _created();
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(
            keccak256(logs[0].data) == keccak256(abi.encode(uint64(0), number, timestamp, hash)),
            "creation data"
        );
        assertTrue(
            keccak256(logs[1].data) == keccak256(abi.encode(number, timestamp, hash, enc)),
            "registration data"
        );
        assertEq(logs[1].topics[1], id, "election id topic");
        _assertAccumulated(logs);
    }

    function test_EventsCarryAZeroOrigin() public {
        testFuzz_EventsCarryTheReportedOrigin(0, 0, bytes32(0));
    }

    function test_EventsCarryAMaximalOrigin() public {
        testFuzz_EventsCarryTheReportedOrigin(
            type(uint64).max, type(uint64).max, bytes32(type(uint256).max)
        );
    }

    /// With no predeploy (a chain that isn't an OP Stack chain, or a test
    /// that forgot it) nothing is created or registered, so no event ever
    /// lacks its origin.
    function test_RefusesToRunWithoutThePredeploy() public {
        (, bytes memory enc) = _created();
        vm.etch(registry.L1_BLOCK(), "");
        vm.prank(CREATOR);
        (bool ok,) =
            address(registry).call(abi.encodeCall(ElectionRegistry.registerDefinition, (enc)));
        assertTrue(!ok, "registered without an origin");
        vm.prank(CREATOR);
        (ok,) = address(registry).call(abi.encodeCall(ElectionRegistry.createElection, ()));
        assertTrue(!ok, "created without an origin");
        assertEq(registry.electionCount(), 1, "count unchanged");
        // Positive control: with the predeploy back, the same calls succeed,
        // so its absence was the only cause.
        RegistryFixture.installL1Block(vm);
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
        vm.prank(CREATOR);
        registry.createElection();
        assertEq(registry.electionCount(), 2, "created with the predeploy");
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

    /// δ within the close rule's bounds (docs/spec/close.md; T-35, T-50): one
    /// second outside either bound is refused, each bound itself is not.
    function test_RefusesAnInclusionBoundOutsideItsBounds() public {
        assertEq(registry.MIN_INCLUSION_BOUND(), 600, "floor, as docs/spec/parameters.md");
        assertEq(registry.MAX_INCLUSION_BOUND(), 3600, "ceiling, as docs/spec/parameters.md");
        uint32[4] memory refused = [uint32(0), 599, 3601, type(uint32).max - 1];
        for (uint256 i; i < refused.length; i++) {
            (bytes32 id,) = _created();
            ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
            d.l1InclusionBound = refused[i];
            bytes memory enc = RegistryFixture.approve(lib, trustees, d);
            _expectRefused(
                CREATOR,
                enc,
                abi.encodeWithSelector(
                    ElectionRegistry.InclusionBoundOutOfRange.selector, refused[i]
                )
            );
            _assertNoParameters(lib.hash(enc));
        }
        uint32[2] memory admitted = [uint32(600), 3600];
        for (uint256 i; i < admitted.length; i++) {
            (bytes32 id,) = _created();
            ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
            d.l1InclusionBound = admitted[i];
            bytes memory enc = RegistryFixture.approve(lib, trustees, d);
            vm.prank(CREATOR);
            registry.registerDefinition(enc);
            _assertParameters(lib.hash(enc), d);
        }
    }

    /// Any δ is admitted exactly when it is within the bounds, and an admitted
    /// one is recorded with the poll's window, which the board's close-rule
    /// checks read.
    function testFuzz_InclusionBoundAdmittedExactlyWithinItsBounds(uint32 bound, uint64 closesAt)
        public
    {
        (bytes32 id,) = _created();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        d.l1InclusionBound = bound;
        // Any close after opening that keeps closes_at + δ within u64 (`timing`).
        d.closesAt = uint64(_bound(closesAt, d.opensAt + 1, type(uint64).max - type(uint32).max));
        bytes memory enc = RegistryFixture.approve(lib, trustees, d);
        vm.prank(CREATOR);
        (bool ok,) =
            address(registry).call(abi.encodeCall(ElectionRegistry.registerDefinition, (enc)));
        assertTrue(ok == (bound >= 600 && bound <= 3600), "admitted exactly within the bounds");
        if (ok) _assertParameters(lib.hash(enc), d);
        else _assertNoParameters(lib.hash(enc));
    }

    /// The sequencing bounds a definition assumes are at most what the windows
    /// were sized for (docs/spec/parameters.md; T-50, T-35, T-71): one above
    /// either ceiling is refused, each ceiling and zero are not.
    function test_RefusesSequencingBoundsAboveTheirCeilings() public {
        assertEq(registry.MAX_SEQUENCING_WINDOW(), 3600, "window, as docs/spec/parameters.md");
        assertEq(registry.MAX_SEQUENCER_DRIFT(), 1800, "drift, as docs/spec/parameters.md");
        uint64[2] memory refused = [uint64(3601), type(uint64).max];
        for (uint256 i; i < refused.length; i++) {
            (bytes32 id,) = _created();
            ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
            d.sequencingWindow = refused[i];
            bytes memory enc = RegistryFixture.approve(lib, trustees, d);
            _expectRefused(
                CREATOR,
                enc,
                abi.encodeWithSelector(
                    ElectionRegistry.SequencingWindowTooLarge.selector, refused[i]
                )
            );
            _assertNoParameters(lib.hash(enc));
        }
        refused = [uint64(1801), type(uint64).max];
        for (uint256 i; i < refused.length; i++) {
            (bytes32 id,) = _created();
            ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
            d.maxSequencerDrift = refused[i];
            bytes memory enc = RegistryFixture.approve(lib, trustees, d);
            _expectRefused(
                CREATOR,
                enc,
                abi.encodeWithSelector(ElectionRegistry.SequencerDriftTooLarge.selector, refused[i])
            );
            _assertNoParameters(lib.hash(enc));
        }
        uint64[2][3] memory admitted = [[uint64(3600), 1800], [uint64(0), 0], [uint64(1), 1]];
        for (uint256 i; i < admitted.length; i++) {
            (bytes32 id,) = _created();
            ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
            d.sequencingWindow = admitted[i][0];
            d.maxSequencerDrift = admitted[i][1];
            bytes memory enc = RegistryFixture.approve(lib, trustees, d);
            vm.prank(CREATOR);
            registry.registerDefinition(enc);
            _assertParameters(lib.hash(enc), d);
        }
    }

    /// Any pair of sequencing bounds is admitted exactly when each is within
    /// its ceiling.
    function testFuzz_SequencingBoundsAdmittedExactlyWithinTheirCeilings(
        uint64 sequencingWindow,
        uint64 maxSequencerDrift
    ) public {
        (bytes32 id,) = _created();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.template(registry, id);
        d.sequencingWindow = sequencingWindow;
        d.maxSequencerDrift = maxSequencerDrift;
        bytes memory enc = RegistryFixture.approve(lib, trustees, d);
        vm.prank(CREATOR);
        (bool ok,) =
            address(registry).call(abi.encodeCall(ElectionRegistry.registerDefinition, (enc)));
        assertTrue(
            ok == (sequencingWindow <= 3600 && maxSequencerDrift <= 1800),
            "admitted exactly within the ceilings"
        );
        if (ok) _assertParameters(lib.hash(enc), d);
        else _assertNoParameters(lib.hash(enc));
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

    /// The same for a tier of regional cells (versions 3 to 6): the tier's
    /// one `root_l2_block` names a block before the registering one.
    function test_RefusesATierRootNotInThePast() public {
        bytes32 id = _create();
        ElectionDefinitionLib.Definition memory d = RegistryFixture.templateV(registry, id, 5);
        d.tiers[1].rootL2Block = uint64(block.number);
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
    /// identifier, creator, counter, hash, the block's L1 origin and the
    /// definition's own encoding.
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
        assertTrue(registry.L1_BLOCK() == RegistryFixture.L1_BLOCK, "predeploy");
    }

    // --- helpers -------------------------------------------------------------

    function _assertParameters(bytes32 h, ElectionDefinitionLib.Definition memory d) internal view {
        ElectionRegistry.Parameters memory p = registry.parameters(h);
        (ElectionDefinitionLib.Question[] memory qs, uint256 total) = RegistryFixture.questionsOf(d);
        (uint8[] memory cellTiers, uint256[] memory roots) = RegistryFixture.cellsOf(d);
        assertEq(p.ballotVersion, d.pinVersions[1], "ballot version");
        assertEq(p.threshold, d.threshold, "threshold");
        assertEq(p.panelSize, d.panelSize, "panel size");
        assertEq(p.authorThreshold, d.authorThreshold, "author threshold");
        assertEq(p.authorPanelSize, d.authorKeys.length, "author panel size");
        assertEq(p.opensAt, d.opensAt, "opens at");
        assertEq(p.closesAt, d.closesAt, "closes at");
        assertEq(p.l1InclusionBound, d.l1InclusionBound, "inclusion bound");
        assertEq(p.optionCount, total, "option count");
        assertEq(p.cellCount, cellTiers.length, "cell count");
        assertEq(p.questions.length, qs.length, "questions");
        // The ceremony the trustee registry recorded for it, so the board
        // finds the election's key set (ADR 0028, 2B).
        (bytes32 stub, bytes32 panel) = registry.ceremony(h);
        assertEq(stub, lib.stubHash(DefinitionEncoder.encode(d)), "stub hash");
        assertEq(panel, d.panelId, "panel");
        for (uint256 i; i < qs.length; i++) {
            assertEq(p.questions[i].method, qs[i].method, "method");
            assertEq(p.questions[i].optionCount, qs[i].optionCount, "question options");
            assertEq(p.questions[i].minSelections, qs[i].minSelections, "min selections");
            assertEq(p.questions[i].maxSelections, qs[i].maxSelections, "max selections");
        }
        uint8[] memory tiers = registry.cellTiers(h);
        assertEq(tiers.length, cellTiers.length, "cell tiers");
        for (uint256 i; i < cellTiers.length; i++) {
            assertEq(tiers[i], cellTiers[i], "tiers");
            (uint8 tier, uint256 root) = registry.cell(h, i);
            assertEq(tier, cellTiers[i], "tier");
            assertEq(root, roots[i], "root");
        }
        (bool ok,) =
            address(registry).staticcall(abi.encodeCall(ElectionRegistry.cell, (h, tiers.length)));
        assertTrue(!ok, "a cell past the last");
    }

    function _assertNoParameters(bytes32 h) internal view {
        ElectionRegistry.Parameters memory p = registry.parameters(h);
        assertEq(p.ballotVersion, 0, "ballot version");
        assertEq(p.threshold, 0, "threshold");
        assertEq(p.panelSize, 0, "panel size");
        assertEq(p.authorThreshold, 0, "author threshold");
        assertEq(p.authorPanelSize, 0, "author panel size");
        assertEq(p.opensAt, 0, "opens at");
        assertEq(p.closesAt, 0, "closes at");
        assertEq(p.l1InclusionBound, 0, "inclusion bound");
        assertEq(p.optionCount, 0, "option count");
        assertEq(p.cellCount, 0, "cell count");
        assertEq(p.questions.length, 0, "questions");
        assertEq(registry.cellTiers(h).length, 0, "cell tiers");
        (bytes32 stub, bytes32 panel) = registry.ceremony(h);
        assertEq(stub, bytes32(0), "stub hash");
        assertEq(panel, bytes32(0), "panel");
        (bool ok,) = address(registry).staticcall(abi.encodeCall(ElectionRegistry.cell, (h, 0)));
        assertTrue(!ok, "a cell");
    }

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + x % (hi - lo + 1);
    }

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
            acc = EventAccumulatorLib.step(
                acc, uint64(i), block.number, block.timestamp, logs[i].topics, logs[i].data
            );
        }
        (bytes32 stored, uint64 count) = registry.eventAccumulator();
        assertEq(stored, acc, "accumulator");
        assertEq(count, logs.length, "count");
    }

    /// A crude personal-data detector: an at sign with two printable ASCII
    /// characters on each side (an email address), or a run of 12 or more
    /// printable characters (a name, a street address, a document number).
    /// Loose enough that ~250 bytes of hash output rarely trip it (about 2%
    /// for a fresh fixture), so a failure after a fixture change needs a look,
    /// not a looser detector.
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
