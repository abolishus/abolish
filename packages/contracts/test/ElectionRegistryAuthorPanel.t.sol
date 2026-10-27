// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {TrusteeIdentityLib, TrusteeRegistry} from "../src/TrusteeRegistry.sol";
import {DefinitionEncoder, DefinitionHarness} from "./utils/DefinitionHarness.sol";
import {RegistryFixture} from "./utils/RegistryFixture.sol";
import {AuthorPanelFixture, ServingVersion6Registry} from "./utils/AuthorPanelFixture.sol";
import {TrusteeFixture, TrusteeHarness} from "./utils/TrusteeFixture.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// The author panel's registration in the election registry
/// (docs/spec/contracts.md, Author panel registration; ADR 0035): a
/// definition with an author panel registers only with the key set a quorum
/// of its author seats approved, whose header is what the definition fixes,
/// against a real trustee registry, which runs checks 6 to 9 and whose
/// statement the author seats sign (T-25, T-54, T-37, T-14, T-17). Author
/// seat `i`'s identity key is `i·G`, so its secret is `i`.
contract ElectionRegistryAuthorPanelTest is TestBase {
    address internal constant CREATOR = address(0xC4EA);
    bytes32 internal constant DEFAULT_TRANSCRIPT = AuthorPanelFixture.DEFAULT_TRANSCRIPT;
    /// The topic 0 contract-event version 9 lists for `AuthorPanelRegistered`.
    string internal constant EVENTS_V9 = "../../docs/spec/vectors/contract-event-v9.json";

    DefinitionHarness internal lib;
    TrusteeHarness internal tlib;
    TrusteeRegistry internal trustees;
    bytes32 internal panel;
    ElectionRegistry internal registry;

    function setUp() public {
        RegistryFixture.installL1Block(vm);
        trustees = AuthorPanelFixture.trusteeRegistry();
        panel = trustees.panelIds(0);
        lib = new DefinitionHarness();
        tlib = new TrusteeHarness();
        registry = new ServingVersion6Registry(RegistryFixture.deployment(address(trustees)));
        vm.warp(RegistryFixture.NOW);
        vm.roll(RegistryFixture.BLOCK);
    }

    // --- registration ------------------------------------------------------------

    function test_RegistersTheDefinitionWithItsAuthorKeySet() public {
        (bytes32 id, bytes memory enc) = _approved(2, 3);
        TrusteeFixture.Seat[] memory seats = _authorSeats(_range(1, 3));
        bytes memory reg = _authorRegistration(enc, seats, _range(1, 2));
        vm.recordLogs();
        vm.prank(CREATOR);
        registry.registerDefinitionWithAuthorPanel(enc, reg);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 h = lib.hash(enc);
        assertEq(registry.definitionHashOf(id), h, "registered");
        (bytes32 stub, bytes32 p) = registry.ceremony(h);
        assertEq(stub, lib.stubHash(enc), "the default panel's stub");
        assertEq(p, panel, "the default panel");
        assertEq(registry.parameters(h).authorThreshold, 2, "k_A");
        assertEq(registry.parameters(h).authorPanelSize, 3, "n_A");

        (bytes32 keySetHash, uint256 mask) = registry.authorKeySetOf(h);
        assertEq(keySetHash, tlib.keySetHash(TrusteeFixture.seatBytes(seats)), "key set hash");
        assertEq(mask, 0xe, "seats 1 to 3");
        for (uint256 i; i < seats.length; i++) {
            (uint256 x, uint256 y) = registry.authorSigningKeyOf(h, seats[i].index);
            assertTrue(x == seats[i].x && y == seats[i].y, "signing key");
        }
        for (uint256 i; i <= 16; i += 4) {
            (uint256 x, uint256 y) = registry.authorSigningKeyOf(h, i);
            assertTrue(x == 0 && y == 0, "a seat outside the set");
        }

        // DefinitionRegistered, then AuthorPanelRegistered naming it.
        assertEq(logs.length, 2, "two logs");
        assertEq(logs[0].topics[0], ElectionRegistry.DefinitionRegistered.selector, "first");
        assertEq(logs[1].topics.length, 3, "topics");
        assertEq(logs[1].topics[0], ElectionRegistry.AuthorPanelRegistered.selector, "topic 0");
        assertEq(
            logs[1].topics[0],
            bytes32(vm.parseBytes(_v9Topic0("AuthorPanelRegistered(bytes32,bytes32,bytes)"))),
            "version 9's topic 0"
        );
        assertEq(logs[1].topics[1], h, "definition topic");
        assertEq(logs[1].topics[2], lib.authorPanelId(enc), "author panel topic");
        assertEq(logs[1].topics[2], bytes32(_slice(reg, 0, 32)), "the record's panel");
        assertTrue(keccak256(logs[1].data) == keccak256(abi.encode(reg)), "data");
        (, uint64 count) = registry.eventAccumulator();
        assertEq(count, 3, "creation, definition and author panel");
    }

    /// Any `q_A` of the seats approve, wherever they sit, and the key set
    /// needn't hold every seat or the approvers.
    function test_AnyQuorumOfSeatsApprovesAnyLargeEnoughKeySet() public {
        (, bytes memory enc) = _approved(2, 3);
        _register(enc, _authorRegistration(enc, _authorSeats(_seats(1, 3)), _seats(2, 3)));
        (, enc) = _approved(2, 3);
        _register(enc, _authorRegistration(enc, _authorSeats(_range(2, 3)), _range(1, 3)));
        (, uint256 mask) = registry.authorKeySetOf(lib.hash(enc));
        assertEq(mask, 0xc, "seats 2 and 3");
    }

    /// `q_A = max(k_A, n_A − 1)`: a 1-of-1 panel needs its one seat, a 2-of-4
    /// panel three, a 4-of-4 panel all four.
    function test_TheQuorumIsTheLargerOfTheThresholdAndAllButOne() public {
        uint8[3] memory k = [1, 2, 4];
        uint8[3] memory n = [1, 4, 4];
        uint8[3] memory q = [1, 3, 4];
        for (uint256 i; i < 3; i++) {
            (, bytes memory enc) = _approved(k[i], n[i]);
            TrusteeFixture.Seat[] memory seats = _authorSeats(_range(1, n[i]));
            if (q[i] > 1) {
                _expectRefused(
                    enc,
                    _authorRegistration(enc, seats, _range(1, q[i] - 1)),
                    abi.encodeWithSelector(ElectionRegistry.BelowQuorum.selector, q[i] - 1, q[i])
                );
            }
            _register(enc, _authorRegistration(enc, seats, _range(1, q[i])));
        }
    }

    function test_AnyoneButTheCreatorIsRefused() public {
        (bytes32 id, bytes memory enc) = _approved(2, 3);
        bytes memory reg = _authorRegistration(enc, _authorSeats(_range(1, 3)), _range(1, 2));
        vm.prank(address(0x07E4));
        (bool ok, bytes memory ret) = address(registry)
            .call(abi.encodeCall(ElectionRegistry.registerDefinitionWithAuthorPanel, (enc, reg)));
        _assertRefused(
            ok,
            ret,
            abi.encodeWithSelector(ElectionRegistry.NotCreator.selector, id, address(0x07E4))
        );
    }

    /// One definition per election, with or without its author panel.
    function test_RefusesASecondRegistration() public {
        (bytes32 id, bytes memory enc) = _approved(2, 3);
        bytes memory reg = _authorRegistration(enc, _authorSeats(_range(1, 3)), _range(1, 2));
        _register(enc, reg);
        vm.prank(CREATOR);
        (bool ok, bytes memory ret) = address(registry)
            .call(abi.encodeCall(ElectionRegistry.registerDefinitionWithAuthorPanel, (enc, reg)));
        _assertRefused(
            ok, ret, abi.encodeWithSelector(ElectionRegistry.AlreadyRegistered.selector, id)
        );
    }

    // --- which call --------------------------------------------------------------

    /// `registerDefinition` never registers a definition with an author
    /// panel, after every rule including 9, so no such election exists
    /// without its key set (T-25, T-54).
    function test_RegisterDefinitionRefusesAnAuthorPanel() public {
        (, bytes memory enc) = _approved(2, 3);
        vm.prank(CREATOR);
        (bool ok, bytes memory ret) =
            address(registry).call(abi.encodeCall(ElectionRegistry.registerDefinition, (enc)));
        _assertRefused(
            ok, ret, abi.encodeWithSelector(ElectionRegistry.AuthorRegistrationMissing.selector)
        );
        _assertNothingRecorded(enc);
    }

    /// The author call refuses a definition with no author panel, after rule
    /// 9: a version-6 poll without one, and every earlier version.
    function test_RefusesADefinitionWithoutAnAuthorPanel() public {
        (bytes32 id, ElectionDefinitionLib.Definition memory d) = _definition(2, 3);
        d.authorThreshold = 0;
        d.authorKeys = new ElectionDefinitionLib.P256Key[](0);
        d.authorTranscriptHash = bytes32(0);
        bytes memory enc = _approve(d);
        bytes memory reg = _authorRegistration(enc, _authorSeats(_range(1, 1)), _range(1, 1));
        _expectRefused(
            enc, reg, abi.encodeWithSelector(ElectionRegistry.AuthorPanelAbsent.selector)
        );
        // `registerDefinition` takes it.
        vm.prank(CREATOR);
        registry.registerDefinition(enc);
        assertEq(registry.definitionHashOf(id), lib.hash(enc), "registered");
        (bytes32 keySetHash, uint256 mask) = registry.authorKeySetOf(lib.hash(enc));
        assertTrue(keySetHash == 0 && mask == 0, "no author key set");

        id = _create();
        d = RegistryFixture.templateV(registry, id, 5);
        enc = _approve(_withDefaultPanel(d));
        _expectRefused(
            enc, reg, abi.encodeWithSelector(ElectionRegistry.AuthorPanelAbsent.selector)
        );
    }

    // --- the civic record (Registration, rule 8) ---------------------------------

    /// Classes 2 and 3 register only under a panel the trustee registry pins
    /// as `independent`, through both calls; under a `transitional` one each
    /// is refused after the ceremony check, recording nothing (T-14).
    function test_CivicClassesNeedAnIndependentPanel() public {
        uint8[2] memory classes = [2, 3];
        for (uint8 kind = 1; kind <= 2; kind++) {
            _useKind(kind);
            for (uint256 c; c < 2; c++) {
                for (uint256 withAuthor; withAuthor < 2; withAuthor++) {
                    (bytes32 id, ElectionDefinitionLib.Definition memory d) = _definition(2, 3);
                    d.pollClass = classes[c];
                    if (withAuthor == 0) _withoutAuthorPanel(d);
                    bytes memory enc = _approve(d);
                    bytes memory reg = withAuthor == 0
                        ? bytes("")
                        : _authorRegistration(enc, _authorSeats(_range(1, 3)), _range(1, 2));
                    bytes memory call = withAuthor == 0
                        ? abi.encodeCall(ElectionRegistry.registerDefinition, (enc))
                        : abi.encodeCall(
                            ElectionRegistry.registerDefinitionWithAuthorPanel, (enc, reg)
                        );
                    if (kind == 1) {
                        vm.prank(CREATOR);
                        (bool ok,) = address(registry).call(call);
                        assertTrue(ok, "refused under an independent panel");
                        assertEq(registry.definitionHashOf(id), lib.hash(enc), "registered");
                    } else {
                        _expectCallRefused(
                            call,
                            abi.encodeWithSelector(
                                ElectionRegistry.CivicPanelNotIndependent.selector, panel, kind
                            )
                        );
                        _assertNothingRecorded(enc);
                    }
                }
            }
        }
    }

    /// An everyday poll (class 1) runs under any pinned panel, the
    /// transitional one included.
    function test_EverydayPollsRunUnderEitherKind() public {
        for (uint8 kind = 1; kind <= 2; kind++) {
            _useKind(kind);
            (bytes32 id, ElectionDefinitionLib.Definition memory d) = _definition(2, 3);
            assertEq(d.pollClass, 1, "everyday");
            _withoutAuthorPanel(d);
            bytes memory enc = _approve(d);
            vm.prank(CREATOR);
            registry.registerDefinition(enc);
            assertEq(registry.definitionHashOf(id), lib.hash(enc), "registered");
            (, enc) = _approved(2, 3);
            _register(enc, _authorRegistration(enc, _authorSeats(_range(1, 3)), _range(1, 2)));
        }
    }

    /// The kind is asked only once the ceremony is recorded: a civic
    /// definition no quorum approved fails `CeremonyNotRecorded` under a
    /// transitional panel.
    function test_TheCeremonyIsCheckedBeforeTheKind() public {
        (, ElectionDefinitionLib.Definition memory d) = _definition(2, 3);
        d.pollClass = 3;
        _withoutAuthorPanel(d);
        bytes memory enc = DefinitionEncoder.encode(d);
        _expectCallRefused(
            abi.encodeCall(ElectionRegistry.registerDefinition, (enc)),
            abi.encodeWithSelector(
                ElectionRegistry.CeremonyNotRecorded.selector, lib.stubHash(enc), DEFAULT_TRANSCRIPT
            )
        );
    }

    /// The deployed registry serves a sealed civic poll without an author
    /// panel (rule 9, board-entry version 5) and registers it only under an
    /// independent panel: under a transitional one it is refused for its
    /// panel, recording nothing (T-14).
    function test_TheDeployedRegistryServesACivicPollOnlyUnderAnIndependentPanel() public {
        for (uint8 kind = 1; kind <= 2; kind++) {
            trustees = AuthorPanelFixture.trusteeRegistry(kind);
            registry = new ElectionRegistry(RegistryFixture.deployment(address(trustees)));
            (bytes32 id, ElectionDefinitionLib.Definition memory d) = _definition(2, 3);
            d.pollClass = 2;
            d.pinVersions[6] = 5;
            _withoutAuthorPanel(d);
            bytes memory enc = _approve(d);
            if (kind == 1) {
                vm.prank(CREATOR);
                registry.registerDefinition(enc);
                assertEq(registry.definitionHashOf(id), lib.hash(enc), "registered");
            } else {
                _expectCallRefused(
                    abi.encodeCall(ElectionRegistry.registerDefinition, (enc)),
                    abi.encodeWithSelector(
                        ElectionRegistry.CivicPanelNotIndependent.selector, panel, 2
                    )
                );
                _assertNothingRecorded(enc);
            }
        }
    }

    /// The deployed registry refuses every author panel at rule 9's
    /// board-entry pin, before the author panel's checks or
    /// `AuthorRegistrationMissing`, so it records no author key set until
    /// P2-16 part 5e-5d serves board-entry version 7.
    function test_TheDeployedRegistryRefusesItAtRule9() public {
        registry = new ElectionRegistry(RegistryFixture.deployment(address(trustees)));
        (, bytes memory enc) = _approved(2, 3);
        bytes memory reg = _authorRegistration(enc, _authorSeats(_range(1, 3)), _range(1, 2));
        bytes memory unserved =
            abi.encodeWithSelector(ElectionRegistry.ProfileNotServed.selector, uint16(0x0007), 7);
        _expectRefused(enc, reg, unserved);
        _expectCallRefused(abi.encodeCall(ElectionRegistry.registerDefinition, (enc)), unserved);
    }

    // --- checks 1 to 5 -------------------------------------------------------------

    function test_RefusesAMalformedRecord() public {
        (, bytes memory enc) = _approved(2, 3);
        bytes memory reg = _authorRegistration(enc, _authorSeats(_range(1, 3)), _range(1, 2));
        bytes memory malformed =
            abi.encodeWithSelector(ElectionRegistry.MalformedRegistration.selector);
        _expectRefused(enc, _slice(reg, 0, 96), malformed);
        _expectRefused(enc, _slice(reg, 0, 97 + 97 * 3), malformed);
        _expectRefused(enc, _slice(reg, 0, reg.length - 1), malformed);
        _expectRefused(enc, bytes.concat(reg, hex"00"), malformed);
        // Text appended to the record is refused: its length is exact (T-17).
        bytes memory withText = bytes.concat(reg, "Alice Smith, alice@example.com");
        assertTrue(_looksLikeText(withText), "detector misses the text");
        _expectRefused(enc, withText, malformed);
        // A seat count that runs past the record.
        bytes memory longer = bytes.concat(reg);
        longer[96] = bytes1(uint8(4));
        _expectRefused(enc, longer, malformed);
        _expectRefused(enc, "", malformed);
    }

    /// The header carries only what the definition fixes (T-17), so no
    /// approval for another panel, stub or transcript counts (T-37).
    function test_RefusesAHeaderTheDefinitionDoesntFix() public {
        (bytes32 id, ElectionDefinitionLib.Definition memory d) = _definition(2, 3);
        bytes memory enc = _approve(d);
        TrusteeFixture.Seat[] memory seats = _authorSeats(_range(1, 3));
        uint8[] memory approvers = _range(1, 2);
        bytes32 authorPanel = lib.authorPanelId(enc);
        bytes32 authorStub = lib.authorStubHash(enc);
        bytes32 transcript = d.authorTranscriptHash;

        // The default panel; the same keys at another threshold; seats 1
        // and 2 swapped.
        bytes32[3] memory panels;
        panels[0] = panel;
        d.authorThreshold = 3;
        panels[1] = lib.authorPanelIdOf(d);
        d.authorThreshold = 2;
        (d.authorKeys[0], d.authorKeys[1]) = (d.authorKeys[1], d.authorKeys[0]);
        panels[2] = lib.authorPanelIdOf(d);
        for (uint256 i; i < 3; i++) {
            _expectRefused(
                enc,
                _signedFor(panels[i], authorStub, transcript, seats, approvers),
                abi.encodeWithSelector(ElectionRegistry.AuthorRegistrationMismatch.selector, 1)
            );
        }
        // The default panel's stub, which keeps the author transcript hash;
        // the stub of another election's definition.
        _expectRefused(
            enc,
            _signedFor(authorPanel, lib.stubHash(enc), transcript, seats, approvers),
            abi.encodeWithSelector(ElectionRegistry.AuthorRegistrationMismatch.selector, 2)
        );
        (, bytes memory other) = _approved(2, 3);
        _expectRefused(
            enc,
            _signedFor(authorPanel, lib.authorStubHash(other), transcript, seats, approvers),
            abi.encodeWithSelector(ElectionRegistry.AuthorRegistrationMismatch.selector, 2)
        );
        // The default transcript, and zero.
        _expectRefused(
            enc,
            _signedFor(authorPanel, authorStub, DEFAULT_TRANSCRIPT, seats, approvers),
            abi.encodeWithSelector(ElectionRegistry.AuthorRegistrationMismatch.selector, 3)
        );
        _expectRefused(
            enc,
            _signedFor(authorPanel, authorStub, bytes32(0), seats, approvers),
            abi.encodeWithSelector(ElectionRegistry.AuthorRegistrationMismatch.selector, 3)
        );
        assertEq(registry.definitionHashOf(id), bytes32(0), "nothing registered");
    }

    // --- checks 6 to 9, in the trustee registry ---------------------------------------

    function test_RefusesAKeySetBelowTheThreshold() public {
        (, bytes memory enc) = _approved(2, 3);
        _expectRefused(
            enc,
            _authorRegistration(enc, _authorSeats(_range(3, 3)), _range(1, 2)),
            abi.encodeWithSelector(TrusteeRegistry.KeySetTooSmall.selector, 1, 2)
        );
    }

    function test_RefusesKeySetSeatsOutOfOrder() public {
        (, bytes memory enc) = _approved(2, 3);
        uint8[3][4] memory orders = [[0, 1, 2], [1, 1, 2], [2, 1, 3], [1, 2, 4]];
        uint8[4] memory at = [0, 1, 1, 4];
        for (uint256 i; i < 4; i++) {
            uint8[] memory s = new uint8[](3);
            for (uint256 j; j < 3; j++) {
                s[j] = orders[i][j];
            }
            _expectRefused(
                enc,
                _authorRegistration(enc, _authorSeats(s), _range(1, 2)),
                abi.encodeWithSelector(TrusteeRegistry.KeySetSeatsOutOfOrder.selector, at[i])
            );
        }
    }

    /// A signing key is a point, used by one seat only, and never an author
    /// identity key (T-37).
    function test_RefusesBadOrRepeatedSigningKeys() public {
        (, bytes memory enc) = _approved(2, 3);
        TrusteeFixture.Seat[] memory seats = _authorSeats(_range(1, 3));
        seats[1].y ^= 1;
        _expectRefused(
            enc,
            _authorRegistration(enc, seats, _range(1, 2)),
            abi.encodeWithSelector(TrusteeRegistry.InvalidSigningKey.selector, 2)
        );
        seats = _authorSeats(_range(1, 3));
        (seats[2].x, seats[2].y) = (seats[0].x, seats[0].y);
        _expectRefused(
            enc,
            _authorRegistration(enc, seats, _range(1, 2)),
            abi.encodeWithSelector(TrusteeRegistry.DuplicateSigningKey.selector, 3)
        );
        for (uint256 k = 1; k <= 3; k++) {
            seats = _authorSeats(_range(1, 3));
            (seats[1].x, seats[1].y) = vm.publicKeyP256(k);
            _expectRefused(
                enc,
                _authorRegistration(enc, seats, _range(1, 2)),
                abi.encodeWithSelector(TrusteeRegistry.DuplicateSigningKey.selector, 2)
            );
        }
    }

    /// Each approving seat counts once and sits on the author panel (T-14).
    function test_RefusesRepeatedUnorderedOrOutsideApprovals() public {
        (, bytes memory enc) = _approved(2, 3);
        TrusteeFixture.Seat[] memory seats = _authorSeats(_range(1, 3));
        uint8[2][4] memory orders = [[1, 1], [2, 1], [0, 1], [1, 4]];
        uint8[4] memory at = [1, 1, 0, 4];
        for (uint256 i; i < 4; i++) {
            uint8[] memory a = new uint8[](2);
            a[0] = orders[i][0];
            a[1] = orders[i][1];
            _expectRefused(
                enc,
                _authorRegistration(enc, seats, a),
                abi.encodeWithSelector(TrusteeRegistry.SeatsOutOfOrder.selector, at[i])
            );
        }
    }

    /// A signature counts only by its seat's key in `author_keys`, on the
    /// statement naming this chain, the deployment's trustee registry and
    /// the record's key set; every one must verify, beyond the quorum too.
    function test_RefusesSignaturesThatDontVerify() public {
        (, bytes memory enc) = _approved(2, 3);
        TrusteeFixture.Seat[] memory seats = _authorSeats(_range(1, 3));
        bytes memory bad = abi.encodeWithSelector(TrusteeRegistry.InvalidSignature.selector, 2);

        // Seat 2's approval made by seat 3's key, or by a default seat's.
        bytes memory reg = _authorRegistration(enc, seats, _range(1, 2));
        bytes memory other = _authorRegistration(enc, seats, _seats(1, 3));
        _expectRefused(enc, _withApproval(reg, 1, _approvalAt(other, 1), 2), bad);
        _expectRefused(
            enc,
            _withApprovalBy(
                enc, reg, seats, 1, TrusteeFixture.secret(vm.readFile(TrusteeFixture.VECTORS), 2), 2
            ),
            bad
        );
        // A high-s signature, the low one's twin.
        TrusteeFixture.Approval memory a = _approvalAt(reg, 1);
        a.s = TrusteeIdentityLib.N - a.s;
        _expectRefused(enc, _withApproval(reg, 1, a, 2), bad);
        // An approval beyond the quorum that doesn't verify.
        reg = _authorRegistration(enc, seats, _range(1, 3));
        _expectRefused(
            enc,
            _withApproval(reg, 2, _approvalAt(reg, 0), 3),
            abi.encodeWithSelector(TrusteeRegistry.InvalidSignature.selector, 3)
        );
        // Approvals of another key set.
        bytes memory fewer = _authorRegistration(enc, _authorSeats(_range(1, 2)), _range(1, 2));
        _expectRefused(enc, _withApproval(reg, 1, _approvalAt(fewer, 1), 2), bad);
    }

    /// The statement names the trustee registry the definition names, never
    /// this registry, and this chain (docs/spec/ceremony.md, Author panel,
    /// Approval).
    function test_RefusesApprovalsForAnotherRegistryOrChain() public {
        (, bytes memory enc) = _approved(2, 3);
        TrusteeFixture.Seat[] memory seats = _authorSeats(_range(1, 3));
        bytes memory bad = abi.encodeWithSelector(TrusteeRegistry.InvalidSignature.selector, 1);
        _expectRefused(enc, _authorRegistrationFor(enc, seats, address(registry), 0), bad);
        _expectRefused(enc, _authorRegistrationFor(enc, seats, address(trustees), 1), bad);
    }

    // --- calldata, junk and text ---------------------------------------------------------

    function test_RefusesNonCanonicalCalldata() public {
        (, bytes memory enc) = _approved(2, 3);
        bytes memory reg = _authorRegistration(enc, _authorSeats(_range(1, 3)), _range(1, 2));
        bytes memory good =
            abi.encodeCall(ElectionRegistry.registerDefinitionWithAuthorPanel, (enc, reg));
        bytes memory nonCanonical =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        _expectCallRefused(bytes.concat(good, bytes32(0)), nonCanonical);
        // The arguments' tails swapped, with the head pointing at them.
        bytes memory swapped = bytes.concat(
            bytes4(good),
            bytes32(uint256(0x40 + 32 + _padded(reg.length))),
            bytes32(uint256(0x40)),
            abi.encodePacked(reg.length, reg, new bytes(_padded(reg.length) - reg.length)),
            abi.encodePacked(enc.length, enc, new bytes(_padded(enc.length) - enc.length))
        );
        _expectCallRefused(swapped, nonCanonical);
        // A non-zero padding byte after the record.
        assertTrue(reg.length % 32 != 0, "record must need padding");
        bytes memory dirty = bytes.concat(good);
        dirty[dirty.length - 1] = 0x01;
        _expectCallRefused(dirty, nonCanonical);
        vm.prank(CREATOR);
        (bool ok,) = address(registry).call(good);
        assertTrue(ok, "the canonical call");
    }

    /// No calldata or event field of a registration carries free text
    /// (contracts skill, no PII on chain): the record's every byte is a hash,
    /// a point, a seat index or a signature.
    function test_NoFreeTextInTheRecordOrItsEvent() public {
        (, bytes memory enc) = _approved(2, 3);
        bytes memory reg = _authorRegistration(enc, _authorSeats(_range(1, 3)), _range(1, 2));
        vm.recordLogs();
        _register(enc, reg);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(!_looksLikeText(reg), "record");
        for (uint256 i; i < logs[1].topics.length; i++) {
            assertTrue(!_looksLikeText(abi.encode(logs[1].topics[i])), "topic");
        }
    }

    /// Any one-bit change to the record is refused, recording nothing: its
    /// header, key set and approvals are all checked or signed.
    function testFuzz_RefusesAnyBitFlip(uint256 bit) public {
        (, bytes memory enc) = _approved(2, 3);
        bytes memory reg = _authorRegistration(enc, _authorSeats(_range(1, 3)), _range(1, 2));
        bit = bit % (reg.length * 8);
        reg[bit / 8] ^= bytes1(uint8(0x80) >> (bit % 8));
        vm.prank(CREATOR);
        (bool ok,) = address(registry)
            .call(abi.encodeCall(ElectionRegistry.registerDefinitionWithAuthorPanel, (enc, reg)));
        assertTrue(!ok, "flipped record accepted");
        _assertNothingRecorded(enc);
    }

    function testFuzz_RefusesArbitraryRecords(bytes calldata junk) public {
        (, bytes memory enc) = _approved(2, 3);
        vm.prank(CREATOR);
        (bool ok,) = address(registry)
            .call(abi.encodeCall(ElectionRegistry.registerDefinitionWithAuthorPanel, (enc, junk)));
        assertTrue(!ok, "junk accepted");
        _assertNothingRecorded(enc);
    }

    // --- the trustee registry's view ------------------------------------------------

    /// The view returns what the registry then records, and records nothing
    /// itself: the same record checked twice gives the same answer.
    function test_TheTrusteeRegistryChecksAndRecordsNothing() public {
        (, bytes memory enc) = _approved(2, 3);
        TrusteeFixture.Seat[] memory seats = _authorSeats(_range(1, 3));
        bytes memory reg = _authorRegistration(enc, seats, _range(1, 2));
        uint256[2][] memory keys = new uint256[2][](3);
        for (uint256 i; i < 3; i++) {
            (keys[i][0], keys[i][1]) = vm.publicKeyP256(i + 1);
        }
        (bytes32 h1, uint256 m1) = trustees.checkAuthorRegistration(reg, keys, 2);
        (bytes32 h2, uint256 m2) = trustees.checkAuthorRegistration(reg, keys, 2);
        assertTrue(h1 == h2 && m1 == m2, "same answer");
        assertEq(h1, tlib.keySetHash(TrusteeFixture.seatBytes(seats)), "hash");
        assertEq(m1, 0xe, "seats");
        assertEq(trustees.transcriptOf(lib.authorStubHash(enc), lib.authorPanelId(enc)), 0, "kept");
        (bytes32 kh, uint256 km) =
            trustees.keySetOf(lib.authorStubHash(enc), lib.authorPanelId(enc));
        assertTrue(kh == 0 && km == 0, "no key set recorded");
        // Its own length check, for a caller that skipped it.
        try trustees.checkAuthorRegistration(_slice(reg, 0, 96), keys, 2) {
            revert("accepted");
        } catch (bytes memory ret) {
            assertTrue(
                keccak256(ret)
                    == keccak256(
                        abi.encodeWithSelector(TrusteeRegistry.MalformedRegistration.selector)
                    ),
                "malformed"
            );
        }
    }

    // --- helpers -----------------------------------------------------------------

    /// A trustee registry pinning the default panel with kind `kind`, and a
    /// registry serving version 6 over it.
    function _useKind(uint8 kind) internal {
        trustees = AuthorPanelFixture.trusteeRegistry(kind);
        registry = new ServingVersion6Registry(RegistryFixture.deployment(address(trustees)));
        assertEq(trustees.panelIds(0), panel, "the same panel");
    }

    function _withoutAuthorPanel(ElectionDefinitionLib.Definition memory d) internal pure {
        d.authorThreshold = 0;
        d.authorKeys = new ElectionDefinitionLib.P256Key[](0);
        d.authorTranscriptHash = bytes32(0);
    }

    function _create() internal returns (bytes32 id) {
        vm.prank(CREATOR);
        id = registry.createElection();
    }

    /// A version-6 definition for a new election with a `k`-of-`n` author
    /// panel, its default ceremony recorded in the trustee registry.
    function _approved(uint8 k, uint8 n) internal returns (bytes32 id, bytes memory enc) {
        ElectionDefinitionLib.Definition memory d;
        (id, d) = _definition(k, n);
        enc = _approve(d);
    }

    function _definition(uint8 k, uint8 n)
        internal
        returns (bytes32 id, ElectionDefinitionLib.Definition memory d)
    {
        id = _create();
        d = AuthorPanelFixture.definition(registry, id, k, n);
    }

    function _withDefaultPanel(ElectionDefinitionLib.Definition memory d)
        internal
        view
        returns (ElectionDefinitionLib.Definition memory)
    {
        return AuthorPanelFixture.withDefaultPanel(registry, d);
    }

    function _approve(ElectionDefinitionLib.Definition memory d) internal returns (bytes memory) {
        return AuthorPanelFixture.approve(trustees, lib, tlib, d);
    }

    function _authorSeats(uint8[] memory indices)
        internal
        pure
        returns (TrusteeFixture.Seat[] memory)
    {
        return AuthorPanelFixture.seats(indices);
    }

    function _authorRegistration(
        bytes memory enc,
        TrusteeFixture.Seat[] memory seats,
        uint8[] memory approvers
    ) internal view returns (bytes memory) {
        return AuthorPanelFixture.registration(address(trustees), lib, tlib, enc, seats, approvers);
    }

    /// Approved by seats 1 and 2 for the trustee registry `trusteeRegistry`
    /// on chain `block.chainid + chainOffset`.
    function _authorRegistrationFor(
        bytes memory enc,
        TrusteeFixture.Seat[] memory seats,
        address trusteeRegistry,
        uint64 chainOffset
    ) internal view returns (bytes memory) {
        bytes32 authorPanel = lib.authorPanelId(enc);
        bytes32 stub = lib.authorStubHash(enc);
        bytes32 transcript = lib.decode(enc).authorTranscriptHash;
        bytes32 keySetHash = tlib.keySetHash(TrusteeFixture.seatBytes(seats));
        TrusteeFixture.Approval[] memory a = new TrusteeFixture.Approval[](2);
        for (uint8 i; i < 2; i++) {
            bytes32 digest = TrusteeIdentityLib.registrationDigest(
                uint64(block.chainid) + chainOffset,
                trusteeRegistry,
                authorPanel,
                i + 1,
                stub,
                transcript,
                keySetHash
            );
            (uint256 r, uint256 s) = TrusteeFixture.sign(i + 1, digest);
            a[i] = TrusteeFixture.Approval(i + 1, r, s);
        }
        return TrusteeFixture.encode(authorPanel, stub, transcript, seats, a);
    }

    function _signedFor(
        bytes32 authorPanel,
        bytes32 stub,
        bytes32 transcript,
        TrusteeFixture.Seat[] memory seats,
        uint8[] memory approvers
    ) internal view returns (bytes memory) {
        return AuthorPanelFixture.signed(
            address(trustees), tlib, authorPanel, stub, transcript, seats, approvers
        );
    }

    /// Where approval `i` starts in `reg`.
    function _approvalOffset(bytes memory reg, uint256 i) internal pure returns (uint256) {
        return 97 + 97 * uint256(uint8(reg[96])) + 1 + 65 * i;
    }

    function _approvalAt(bytes memory reg, uint256 i)
        internal
        pure
        returns (TrusteeFixture.Approval memory a)
    {
        uint256 at = _approvalOffset(reg, i);
        a.index = uint8(reg[at]);
        a.r = uint256(bytes32(_slice(reg, at + 1, 32)));
        a.s = uint256(bytes32(_slice(reg, at + 33, 32)));
    }

    /// `reg` with approval `i` replaced by `a`'s signature, as seat `seat`.
    function _withApproval(
        bytes memory reg,
        uint256 i,
        TrusteeFixture.Approval memory a,
        uint8 seat
    ) internal pure returns (bytes memory out) {
        uint256 at = _approvalOffset(reg, i);
        out = bytes.concat(
            _slice(reg, 0, at),
            abi.encodePacked(seat, a.r, a.s),
            _slice(reg, at + 65, reg.length - at - 65)
        );
    }

    /// `reg` with approval `i` signed by secret `sk` as seat `seat`.
    function _withApprovalBy(
        bytes memory enc,
        bytes memory reg,
        TrusteeFixture.Seat[] memory seats,
        uint256 i,
        uint256 sk,
        uint8 seat
    ) internal view returns (bytes memory) {
        bytes32 digest = TrusteeIdentityLib.registrationDigest(
            uint64(block.chainid),
            address(trustees),
            lib.authorPanelId(enc),
            seat,
            lib.authorStubHash(enc),
            lib.decode(enc).authorTranscriptHash,
            tlib.keySetHash(TrusteeFixture.seatBytes(seats))
        );
        (uint256 r, uint256 s) = TrusteeFixture.sign(sk, digest);
        return _withApproval(reg, i, TrusteeFixture.Approval(seat, r, s), seat);
    }

    function _register(bytes memory enc, bytes memory reg) internal {
        vm.prank(CREATOR);
        registry.registerDefinitionWithAuthorPanel(enc, reg);
        assertEq(registry.definitionHashOf(lib.decode(enc).electionId), lib.hash(enc), "registered");
    }

    function _expectRefused(bytes memory enc, bytes memory reg, bytes memory expected) internal {
        _expectCallRefused(
            abi.encodeCall(ElectionRegistry.registerDefinitionWithAuthorPanel, (enc, reg)), expected
        );
        _assertNothingRecorded(enc);
    }

    function _expectCallRefused(bytes memory data, bytes memory expected) internal {
        vm.prank(CREATOR);
        (bool ok, bytes memory ret) = address(registry).call(data);
        _assertRefused(ok, ret, expected);
    }

    function _assertRefused(bool ok, bytes memory ret, bytes memory expected) internal pure {
        assertTrue(!ok, "accepted");
        assertTrue(keccak256(ret) == keccak256(expected), "wrong error");
    }

    function _assertNothingRecorded(bytes memory enc) internal view {
        bytes32 h = lib.hash(enc);
        assertEq(registry.definitionHashOf(lib.decode(enc).electionId), bytes32(0), "registered");
        assertEq(registry.parameters(h).ballotVersion, 0, "parameters");
        (bytes32 keySetHash, uint256 mask) = registry.authorKeySetOf(h);
        assertTrue(keySetHash == 0 && mask == 0, "author key set");
        for (uint256 i = 1; i <= 4; i++) {
            (uint256 x, uint256 y) = registry.authorSigningKeyOf(h, i);
            assertTrue(x == 0 && y == 0, "author signing key");
        }
    }

    function _v9Topic0(string memory signature) internal view returns (string memory) {
        string memory events = vm.readFile(EVENTS_V9);
        for (uint256 i;; i++) {
            string memory at = string.concat(".events[", vm.toString(i), "]");
            if (
                keccak256(bytes(vm.parseJsonString(events, string.concat(at, ".signature"))))
                    == keccak256(bytes(signature))
            ) {
                return string.concat("0x", vm.parseJsonString(events, string.concat(at, ".topic0")));
            }
        }
    }

    function _padded(uint256 len) internal pure returns (uint256) {
        return (len + 31) & ~uint256(31);
    }

    function _seats(uint8 a, uint8 b) internal pure returns (uint8[] memory s) {
        s = new uint8[](2);
        (s[0], s[1]) = (a, b);
    }

    function _range(uint8 from, uint8 to) internal pure returns (uint8[] memory) {
        return AuthorPanelFixture.range(from, to);
    }

    /// The election registry tests' personal-data detector: an at sign
    /// with two printable ASCII characters on each side, or a run of 12 or
    /// more printable characters.
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
