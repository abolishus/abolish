// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {AvailabilityCheckLib} from "../src/AvailabilityCheck.sol";
import {Board} from "../src/Board.sol";
import {CanonicalCalldata} from "../src/CanonicalCalldata.sol";
import {DeliveryCheckLib} from "../src/DeliveryCheck.sol";
import {ElectionDefinitionLib} from "../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../src/EventAccumulator.sol";
import {ElectionsStub, TrusteesStub} from "./utils/BoardFixture.sol";
import {TrusteeFixture} from "./utils/TrusteeFixture.sol";
import {TestBase, Vm} from "./utils/Vm.sol";

/// The board's availability call (docs/spec/contracts.md, Board,
/// Availability records, Calls and Events; docs/spec/availability.md,
/// Records and Contract path) against the vectors: availability.json (its
/// records, signed by its seats, and its decode rejections),
/// contract-event-v8.json (the event each accepted record is archived as),
/// and delivery.json with delivery-root.json (an election whose roots the
/// board accepts, by their record hashes). Every expected value comes from
/// the files or from the spec's field offsets, never from the code under
/// test; the registries are stubs set from the files. Threats: T-24 and T-53
/// (a withheld board), T-17 (chosen bytes in the archive), T-52 (records
/// that cost others work), T-31.
contract BoardAvailabilityTest is TestBase {
    string internal constant AVAILABILITY = "../../docs/spec/vectors/availability.json";
    string internal constant EVENTS = "../../docs/spec/vectors/contract-event-v8.json";
    string internal constant DELIVERY = "../../docs/spec/vectors/delivery.json";
    string internal constant ROOTS = "../../docs/spec/vectors/delivery-root.json";
    string internal constant OBLIGATION = "../../docs/spec/vectors/delivery-obligation.json";

    bytes32 internal constant STUB = keccak256("availability stub");
    bytes32 internal constant STUB_DELIVERY = keccak256("delivery stub");
    bytes32 internal constant PANEL = keccak256("panel");
    address internal constant RELAY = address(0x4E1A);

    /// The spec's event signatures (contracts.md, Board, Events).
    bytes32 internal constant ATTESTATION_SUBMITTED =
        keccak256("AvailabilityAttestationSubmitted(bytes32,uint8,bytes)");
    bytes32 internal constant COMPLAINT_SUBMITTED =
        keccak256("AvailabilityComplaintSubmitted(bytes32,uint8,bytes)");

    /// The records' layouts (availability.md, Records): the shared fields,
    /// an attestation's root count and roots, a complaint's CID and
    /// signature.
    uint256 internal constant PANEL_AT = 35;
    uint256 internal constant SEAT_AT = 36;
    uint256 internal constant POINT_AT = 37;
    uint256 internal constant COUNT_AT = 70;
    uint256 internal constant ROOTS_AT = 74;
    uint256 internal constant CID_AT = 70;
    uint256 internal constant COMPLAINT_SIG_AT = 106;
    bytes4 internal constant RAW_PREFIX = 0x01551220;
    bytes4 internal constant DAG_PB_PREFIX = 0x01701220;

    ElectionsStub internal elections;
    TrusteesStub internal trustees;
    Board internal board;

    /// availability.json's definition, its default seats' secrets and its
    /// checkpoints; the tags.
    bytes32 internal ah;
    uint256[5] internal secrets;
    bytes32 internal ballotCheckpoint;
    bytes32 internal countedCheckpoint;
    bytes internal attestationDs;
    bytes internal complaintDs;
    bytes internal rootDs;
    bytes internal rootHashDs;

    /// delivery.json's definition and its seats' secrets, for roots.
    bytes32 internal h;
    uint256[4] internal deliverySecrets;

    function setUp() public {
        string memory aj = vm.readFile(AVAILABILITY);
        elections = new ElectionsStub();
        trustees = new TrusteesStub();
        board = new Board(address(elections), address(trustees), RELAY);

        string memory e = ".checks[0].election";
        ah = _b32(aj, string.concat(e, ".definitionHash"));
        ballotCheckpoint = _b32(aj, string.concat(e, ".checkpoints.ballot"));
        countedCheckpoint = _b32(aj, string.concat(e, ".checkpoints.counted"));
        _register(ah, STUB);
        uint256 seats;
        string memory reg = string.concat(e, ".panels[0].registered");
        for (uint256 i; vm.keyExistsJson(aj, _at(reg, i, "")); i++) {
            uint256 seat = vm.parseJsonUint(aj, _at(reg, i, ".index"));
            (uint256 x, uint256 y, bool onCurve) =
                TrusteeFixture.point(_bytes(aj, _at(reg, i, ".signingKey")));
            assertTrue(onCurve, "signing key");
            trustees.setKey(STUB, PANEL, seat, x, y);
            seats |= 1 << seat;
        }
        assertEq(seats, 0x1e, "default seats 1 to 4");
        trustees.setKeySet(STUB, PANEL, seats);
        // Each default seat's secret, from the records it signed.
        for (uint256 i; vm.keyExistsJson(aj, _at(".records", i, "")); i++) {
            if (vm.parseJsonUint(aj, _at(".records", i, ".fields.panel")) != 1) continue;
            uint256 seat = vm.parseJsonUint(aj, _at(".records", i, ".fields.seat"));
            secrets[seat] =
                vm.parseUint(string.concat("0x", _str(aj, _at(".records", i, ".signingSecret"))));
        }
        for (uint256 seat = 1; seat <= 4; seat++) {
            assertTrue(secrets[seat] != 0, "a secret for every default seat");
        }
        // The author seats that signed the file's author records, as the
        // election registry records an author key set with the definition.
        uint256 authorSeats;
        for (uint256 i; vm.keyExistsJson(aj, _at(".records", i, "")); i++) {
            if (vm.parseJsonUint(aj, _at(".records", i, ".fields.panel")) != 2) continue;
            uint256 seat = vm.parseJsonUint(aj, _at(".records", i, ".fields.seat"));
            (uint256 x, uint256 y, bool onCurve) =
                TrusteeFixture.point(_bytes(aj, _at(".records", i, ".signingKey")));
            assertTrue(onCurve, "author signing key");
            elections.setAuthorKey(ah, seat, x, y);
            authorSeats |= 1 << seat;
        }
        assertEq(authorSeats, (1 << 2) | (1 << 3), "author seats 2 and 3");
        elections.setAuthorKeySet(ah, authorSeats);
        attestationDs = _ds(_str(aj, ".tags.attestation"));
        complaintDs = _ds(_str(aj, ".tags.complaint"));

        string memory dj = vm.readFile(DELIVERY);
        string memory rj = vm.readFile(ROOTS);
        h = _b32(dj, ".definitionHash");
        assertEq(_b32(rj, ".definitionHash"), h, "the roots' definition");
        _register(h, STUB_DELIVERY);
        uint256 deliverySeats;
        for (uint256 i; vm.keyExistsJson(dj, _at(".panel", i, "")); i++) {
            uint256 seat = vm.parseJsonUint(dj, _at(".panel", i, ".seat"));
            (uint256 x, uint256 y,) =
                TrusteeFixture.point(_bytes(dj, _at(".panel", i, ".signingKey")));
            trustees.setKey(STUB_DELIVERY, PANEL, seat, x, y);
            deliverySecrets[seat] =
                vm.parseUint(string.concat("0x", _str(dj, _at(".panel", i, ".signingSecret"))));
            deliverySeats |= 1 << seat;
        }
        trustees.setKeySet(STUB_DELIVERY, PANEL, deliverySeats);
        rootDs = _ds(_str(rj, ".tag"));
        rootHashDs = _ds(_str(rj, ".recordHashTag"));
    }

    function test_EventSignaturesAreTheSpecs() public view {
        assertEq(
            Board.AvailabilityAttestationSubmitted.selector,
            ATTESTATION_SUBMITTED,
            "AvailabilityAttestationSubmitted"
        );
        assertEq(
            Board.AvailabilityComplaintSubmitted.selector,
            COMPLAINT_SUBMITTED,
            "AvailabilityComplaintSubmitted"
        );
        string memory ej = vm.readFile(EVENTS);
        assertTrue(_eq(_str(ej, ".format"), "abolish-contract-event-vectors/8"), "event format");
        uint256 found;
        for (uint256 i; vm.keyExistsJson(ej, _at(".events", i, "")); i++) {
            bytes32 topic = _b32(ej, _at(".events", i, ".topic0"));
            if (topic == ATTESTATION_SUBMITTED || topic == COMPLAINT_SUBMITTED) {
                assertTrue(_eq(_str(ej, _at(".events", i, ".role")), "board"), "the board's");
                found++;
            }
        }
        assertEq(found, 2, "version 8's tables name both");
    }

    /// Every record of availability.json that names no root, of either
    /// panel, is accepted and emitted whole, its topics its definition hash
    /// and seat, exactly as contract-event-v8.json's record of it carries it;
    /// a repeat emits nothing. The records naming roots are refused only for
    /// their roots, which the board doesn't hold. Without an author key set
    /// the author panel's are refused for their seat.
    function test_VectorRecords() public {
        string memory aj = vm.readFile(AVAILABILITY);
        string memory ej = vm.readFile(EVENTS);
        uint256 accepted;
        uint256 i;
        for (; vm.keyExistsJson(aj, _at(".records", i, "")); i++) {
            string memory id = _str(aj, _at(".records", i, ".id"));
            bytes memory r = _bytes(aj, _at(".records", i, ".encoding"));
            if (vm.parseJsonUint(aj, _at(".records", i, ".fields.panel")) == 2) {
                uint256 snapshot = vm.snapshotState();
                elections.setAuthorKeySet(ah, 0);
                _refuse(_call(r), _refused(AvailabilityCheckLib.Code.AvailabilitySeat), id);
                vm.revertToState(snapshot);
            }
            if (_u32(r, COUNT_AT) != 0 && _type(r) == 0x001b) {
                _refuse(_call(r), _refused(AvailabilityCheckLib.Code.AvailabilityRoot), id);
                continue;
            }
            Vm.Log[] memory logs = _accept(_call(r));
            assertEq(logs.length, 1, "one event");
            bool attestation = _type(r) == 0x001b;
            assertEq(
                logs[0].topics[0], attestation ? ATTESTATION_SUBMITTED : COMPLAINT_SUBMITTED, id
            );
            assertEq(logs[0].topics.length, 3, "three topics");
            assertEq(logs[0].topics[1], ah, "definition topic");
            assertEq(uint256(logs[0].topics[2]), uint8(r[SEAT_AT]), "seat topic");
            string memory key = _record(ej, string.concat("availability-", id));
            assertEq(
                keccak256(_bytes(ej, string.concat(key, ".fields.data"))),
                keccak256(logs[0].data),
                "the event file's data"
            );
            assertEq(_b32(ej, string.concat(key, ".fields.topics[0]")), logs[0].topics[0], id);
            assertEq(_b32(ej, string.concat(key, ".fields.topics[2]")), logs[0].topics[2], id);
            assertEq(_accept(_call(r)).length, 0, "a repeat emits nothing");
            accepted++;
        }
        assertEq(i, 7, "seven records");
        assertEq(accepted, 5, "five without roots, two of author seats");
    }

    /// Each decode rejection of availability.json is refused with its code at
    /// its offset (contracts.md, Board, Availability records, step 1). The
    /// call takes either type, so the file's two records read as the other
    /// type are decoded as their own, and a type versioning.md lists is
    /// `unexpected-record-type` where the file, which knows only the two,
    /// says unknown.
    function test_DecodeRejections() public {
        string memory aj = vm.readFile(AVAILABILITY);
        uint256 refused;
        uint256 i;
        for (; vm.keyExistsJson(aj, _at(".decodeErrors", i, "")); i++) {
            string memory id = _str(aj, _at(".decodeErrors", i, ".id"));
            bytes memory r = _bytes(aj, _at(".decodeErrors", i, ".encoding"));
            if (_eq(id, "complaint-as-attestation") || _eq(id, "attestation-as-complaint")) {
                continue;
            }
            ElectionDefinitionLib.DecodeError code =
                _decodeError(_str(aj, _at(".decodeErrors", i, ".error")));
            if (_eq(id, "destruction-type")) {
                assertTrue(code == ElectionDefinitionLib.DecodeError.UnknownRecordType, id);
                code = ElectionDefinitionLib.DecodeError.UnexpectedRecordType;
            }
            _refuse(
                _call(r),
                _malformed(code, vm.parseJsonUint(aj, _at(".decodeErrors", i, ".offset"))),
                id
            );
            refused++;
        }
        assertEq(i, 27, "twenty-seven rejections");
        assertEq(refused, 25, "every one decoded as its own type");
        // Types the board doesn't know, and other version bytes.
        bytes memory honest = _attestation(ah, 1, 1, 1, ballotCheckpoint, new bytes32[](0));
        _refuse(
            _call(_withByte(_withByte(honest, 0, 0xff), 1, 0x00)),
            _malformed(ElectionDefinitionLib.DecodeError.UnknownRecordType, 0),
            "type 0xff00"
        );
        _refuse(
            _call(_withByte(_withByte(honest, 0, 0), 1, 0)),
            _malformed(ElectionDefinitionLib.DecodeError.UnknownRecordType, 0),
            "type 0"
        );
        _refuse(
            _call(_withByte(honest, 1, 0x1d)),
            _malformed(ElectionDefinitionLib.DecodeError.UnknownRecordType, 0),
            "type 0x001d"
        );
        _refuse(
            _call(_withByte(honest, 1, 0x1a)),
            _malformed(ElectionDefinitionLib.DecodeError.UnexpectedRecordType, 0),
            "an obligation root's type"
        );
        _refuse(
            _call(_withByte(honest, 2, 0)),
            _malformed(ElectionDefinitionLib.DecodeError.ProfileMismatch, 2),
            "version 0"
        );
        _refuse(
            _call(hex"001b"),
            _malformed(ElectionDefinitionLib.DecodeError.Truncated, 2),
            "no version"
        );
        _refuse(
            _call(hex"00"), _malformed(ElectionDefinitionLib.DecodeError.Truncated, 0), "one byte"
        );
    }

    /// Refusals in the spec's order: a definition no one registered, a seat
    /// outside its panel's key set, another seat's key,
    /// another type's tag, then roots and the slot (contracts.md, Board,
    /// Availability records, steps 2 to 6). Each refusal fills nothing.
    function test_RefusalOrder() public {
        bytes32[] memory none = new bytes32[](0);
        bytes32 stray = keccak256("no such definition");
        _refuse(
            _call(_attestation(stray, 1, 1, 1, ballotCheckpoint, none)),
            _refused(AvailabilityCheckLib.Code.AvailabilityStray),
            "stray"
        );
        // A stray record is refused before its seat or signature is read.
        _refuse(
            _call(_signedAttestation(stray, 1, 9, 1, ballotCheckpoint, none, secrets[1])),
            _refused(AvailabilityCheckLib.Code.AvailabilityStray),
            "stray, any seat"
        );
        uint8[3] memory outside = [0, 5, 255];
        for (uint256 i; i < outside.length; i++) {
            _refuse(
                _call(_signedAttestation(ah, 1, outside[i], 1, ballotCheckpoint, none, secrets[1])),
                _refused(AvailabilityCheckLib.Code.AvailabilitySeat),
                string.concat("seat ", vm.toString(uint256(outside[i])))
            );
        }
        // Without an author panel an author seat has no key set, whatever
        // its index.
        (, uint256 authorSeats) = elections.authorKeySetOf(ah);
        elections.setAuthorKeySet(ah, 0);
        for (uint8 seat = 1; seat <= 4; seat++) {
            _refuse(
                _call(_signedAttestation(ah, 2, seat, 1, ballotCheckpoint, none, secrets[seat])),
                _refused(AvailabilityCheckLib.Code.AvailabilitySeat),
                "an author seat"
            );
        }
        // With one, a seat outside it is refused, and an author seat is
        // checked under its own key, never the default seat's of its index.
        elections.setAuthorKeySet(ah, authorSeats);
        _refuse(
            _call(_signedAttestation(ah, 2, 1, 1, ballotCheckpoint, none, secrets[1])),
            _refused(AvailabilityCheckLib.Code.AvailabilitySeat),
            "author seat 1, outside the author key set"
        );
        _refuse(
            _call(_signedAttestation(ah, 2, 2, 1, ballotCheckpoint, none, secrets[2])),
            _refused(AvailabilityCheckLib.Code.AvailabilitySignature),
            "author seat 2 under default seat 2's key"
        );
        _refuse(
            _call(_signedAttestation(ah, 1, 1, 1, ballotCheckpoint, none, secrets[2])),
            _refused(AvailabilityCheckLib.Code.AvailabilitySignature),
            "another seat's key"
        );
        // The complaint's tag over an attestation, and the attestation's over
        // a complaint, never verify.
        bytes memory body = abi.encodePacked(
            uint16(0x001b), uint8(1), ah, uint8(1), uint8(1), uint8(1), ballotCheckpoint, uint32(0)
        );
        (uint256 r, uint256 s) =
            TrusteeFixture.sign(secrets[1], sha256(bytes.concat(complaintDs, body)));
        _refuse(
            _call(abi.encodePacked(body, r, s)),
            _refused(AvailabilityCheckLib.Code.AvailabilitySignature),
            "a complaint's tag"
        );
        bytes memory cbody = abi.encodePacked(
            uint16(0x001c),
            uint8(1),
            ah,
            uint8(1),
            uint8(1),
            uint8(1),
            ballotCheckpoint,
            RAW_PREFIX,
            keccak256("object")
        );
        (r, s) = TrusteeFixture.sign(secrets[1], sha256(bytes.concat(attestationDs, cbody)));
        _refuse(
            _call(abi.encodePacked(cbody, r, s)),
            _refused(AvailabilityCheckLib.Code.AvailabilitySignature),
            "an attestation's tag"
        );
        bytes memory honest = _attestation(ah, 1, 1, 1, ballotCheckpoint, none);
        assertEq(_accept(_call(honest)).length, 1, "the honest record, its slot still empty");
    }

    /// One attestation and one complaint per seat and point: the first that
    /// passes fills its slot, a byte-identical repeat is the no-op, any other
    /// record of the slot is refused, and the other slots stay the seat's
    /// and every other seat's (contracts.md, Board, Availability records,
    /// step 6; T-17, T-52).
    function test_OneRecordPerSlot() public {
        bytes32[] memory none = new bytes32[](0);
        bytes memory repeat = _refused(AvailabilityCheckLib.Code.AvailabilityRepeat);
        bytes memory first = _attestation(ah, 1, 1, 1, ballotCheckpoint, none);
        // A forged record fills nothing.
        bytes memory forged = _withByte(first, first.length - 1, uint8(first[first.length - 1]) ^ 1);
        _refuse(_call(forged), _refused(AvailabilityCheckLib.Code.AvailabilitySignature), "forged");
        assertEq(_accept(_call(first)).length, 1, "seat 1's ballot-extent attestation");
        assertEq(_accept(_call(first)).length, 0, "its repeat is a no-op");
        _refuse(
            _call(_attestation(ah, 1, 1, 1, keccak256("another checkpoint"), none)),
            repeat,
            "seat 1's second ballot-extent attestation"
        );
        _refuse(
            _call(forged),
            _refused(AvailabilityCheckLib.Code.AvailabilitySignature),
            "forged, after"
        );
        // The complaint of the same point, and the other point, are other slots.
        bytes memory complained = _complaint(ah, 1, 1, ballotCheckpoint, RAW_PREFIX);
        assertEq(_accept(_call(complained)).length, 1, "seat 1's ballot-extent complaint");
        _refuse(
            _call(_complaint(ah, 1, 1, ballotCheckpoint, DAG_PB_PREFIX)),
            repeat,
            "seat 1's second ballot-extent complaint"
        );
        assertEq(
            _accept(_call(_attestation(ah, 1, 1, 2, countedCheckpoint, none))).length,
            1,
            "seat 1's counted-extent attestation"
        );
        assertEq(
            _accept(_call(_complaint(ah, 1, 2, countedCheckpoint, DAG_PB_PREFIX))).length,
            1,
            "seat 1's counted-extent complaint"
        );
        _refuse(
            _call(_complaint(ah, 1, 2, countedCheckpoint, RAW_PREFIX)),
            repeat,
            "seat 1's fifth record"
        );
        // Other seats keep their own slots.
        for (uint8 seat = 2; seat <= 4; seat++) {
            assertEq(
                _accept(_call(_attestation(ah, seat, seat, 1, ballotCheckpoint, none))).length,
                1,
                "another seat's attestation"
            );
        }
        // And another election keeps its own: delivery.json's seat 1.
        assertEq(
            _accept(
                _call(_signedAttestation(h, 1, 1, 1, ballotCheckpoint, none, deliverySecrets[1]))
            )
            .length,
            1,
            "another election's seat 1"
        );
    }

    /// An attestation's roots are the record hashes of obligation roots the
    /// board accepted for its definition, whichever seat's (contracts.md,
    /// Board, Availability records, step 5): delivery-root.json's recordHash
    /// names its root once the board holds it, and a root the board doesn't
    /// hold, holds for another election, or a zero word is refused.
    function test_RootsAreTheBoardsOwn() public {
        string memory rj = vm.readFile(ROOTS);
        bytes memory receiptRoot = _bytes(rj, ".records[0].encoding");
        bytes32 receiptHash = _b32(rj, ".records[0].recordHash");
        bytes memory complaintRoot = _bytes(rj, ".records[2].encoding");
        bytes32 complaintHash = _b32(rj, ".records[2].recordHash");
        assertEq(uint8(complaintRoot[35]), 2, "seat 2's complaint root");
        assertEq(sha256(bytes.concat(rootHashDs, receiptRoot)), receiptHash, "the record hash");

        bytes memory roots = _call(_signedOne(receiptHash, 3));
        // Not yet held.
        _refuse(roots, _refused(AvailabilityCheckLib.Code.AvailabilityRoot), "before the root");
        assertEq(
            _accept(abi.encodeCall(Board.submitObligationRoot, (receiptRoot))).length, 1, "root"
        );
        // Seat 3 names seat 1's root.
        assertEq(_accept(roots).length, 1, "another seat's root, held");

        // Two roots of two seats, ascending, by seat 2.
        assertEq(
            _accept(abi.encodeCall(Board.submitObligationRoot, (complaintRoot))).length, 1, "root 2"
        );
        bytes32[] memory both = new bytes32[](2);
        (both[0], both[1]) = receiptHash < complaintHash
            ? (receiptHash, complaintHash)
            : (complaintHash, receiptHash);
        assertEq(
            _accept(
                _call(_signedAttestation(h, 1, 2, 2, countedCheckpoint, both, deliverySecrets[2]))
            )
            .length,
            1,
            "both roots"
        );
        // One of them and one the board doesn't hold.
        bytes32[] memory mixed = new bytes32[](2);
        bytes32 other = keccak256("no such root");
        (mixed[0], mixed[1]) = receiptHash < other ? (receiptHash, other) : (other, receiptHash);
        _refuse(
            _call(_signedAttestation(h, 1, 1, 2, countedCheckpoint, mixed, deliverySecrets[1])),
            _refused(AvailabilityCheckLib.Code.AvailabilityRoot),
            "a root not held"
        );
        // A zero word: an empty slot is no root.
        bytes32[] memory zero = new bytes32[](1);
        _refuse(
            _call(_signedAttestation(h, 1, 1, 2, countedCheckpoint, zero, deliverySecrets[1])),
            _refused(AvailabilityCheckLib.Code.AvailabilityRoot),
            "zero"
        );
        // availability.json's election holds no root, whatever delivery.json's does.
        bytes32[] memory one = new bytes32[](1);
        one[0] = receiptHash;
        _refuse(
            _call(_attestation(ah, 1, 1, 2, countedCheckpoint, one)),
            _refused(AvailabilityCheckLib.Code.AvailabilityRoot),
            "another election's root"
        );
        // A refused attestation filled nothing: seat 1 still attests.
        assertEq(
            _accept(
                _call(_signedAttestation(h, 1, 1, 2, countedCheckpoint, one, deliverySecrets[1]))
            )
            .length,
            1,
            "seat 1's slot was empty"
        );
    }

    /// The board keeps each root's record hash in its seat's slot, so the
    /// slot still refuses a second root of the kind (`root-repeat`), and the
    /// root's hash, not its bytes, is what an attestation names.
    function test_RootSlotsKeepTheRecordHash() public {
        string memory rj = vm.readFile(ROOTS);
        bytes memory receiptRoot = _bytes(rj, ".records[0].encoding");
        bytes memory oneLeaf = _bytes(rj, ".records[1].encoding");
        assertEq(uint8(oneLeaf[35]), 1, "seat 1's other receipt root");
        assertEq(
            _accept(abi.encodeCall(Board.submitObligationRoot, (receiptRoot))).length, 1, "first"
        );
        _refuse(
            abi.encodeCall(Board.submitObligationRoot, (oneLeaf)),
            abi.encodeWithSelector(
                DeliveryCheckLib.DeliveryRefused.selector, 0, DeliveryCheckLib.Code.RootRepeat
            ),
            "the slot is filled"
        );
        _refuse(
            _call(_signedOne(_b32(rj, ".records[1].recordHash"), 1)),
            _refused(AvailabilityCheckLib.Code.AvailabilityRoot),
            "the refused root is no root"
        );
    }

    /// The call takes canonical calldata only (contracts.md, Board, Calls).
    function test_CanonicalCalldataOnly() public {
        bytes memory good = _call(_complaint(ah, 2, 1, ballotCheckpoint, RAW_PREFIX));
        bytes memory refusal =
            abi.encodeWithSelector(CanonicalCalldata.NonCanonicalCalldata.selector);
        bytes4 sel = bytes4(good);
        bytes[4] memory bad = [
            abi.encodePacked(good, bytes32(0)),
            _withByte(good, good.length - 1, 1),
            abi.encodePacked(sel, uint256(0x40), uint256(0), _slice(good, 36, good.length - 36)),
            abi.encodePacked(sel, uint256(0), bytes32("junk"))
        ];
        for (uint256 i; i < bad.length; i++) {
            _refuse(bad[i], refusal, string.concat("calldata ", vm.toString(i)));
        }
        assertEq(_accept(good).length, 1, "canonical calldata");
    }

    /// Any checkpoint and CID a seat signs are accepted: the board can't read
    /// L1 (contracts.md, Board, Known-weak).
    function testFuzz_AnySignedFieldsAccepted(bytes32 checkpoint, bytes32 digest, bool dagPb)
        public
    {
        assertEq(
            _accept(_call(_attestation(ah, 3, 3, 1, checkpoint, new bytes32[](0)))).length,
            1,
            "attestation"
        );
        bytes memory body = abi.encodePacked(
            uint16(0x001c),
            uint8(1),
            ah,
            uint8(1),
            uint8(3),
            uint8(1),
            checkpoint,
            dagPb ? DAG_PB_PREFIX : RAW_PREFIX,
            digest
        );
        (uint256 r, uint256 s) =
            TrusteeFixture.sign(secrets[3], sha256(bytes.concat(complaintDs, body)));
        assertEq(_accept(_call(abi.encodePacked(body, r, s))).length, 1, "complaint");
    }

    /// No arbitrary record is accepted, and every refusal is one of the
    /// availability check's errors.
    function testFuzz_ArbitraryRecordsRefused(bytes calldata r) public {
        _refuseFuzzed(_call(r));
    }

    /// No one-byte change to an honest record is accepted: it changes a
    /// field under the signature or the signature itself, or breaks the
    /// framing.
    function testFuzz_ByteChangesRefused(uint256 at, uint8 delta, bool complaint) public {
        vm.assume(delta != 0);
        bytes memory r = complaint
            ? _complaint(ah, 2, 2, countedCheckpoint, DAG_PB_PREFIX)
            : _attestation(ah, 2, 2, 2, countedCheckpoint, new bytes32[](0));
        at %= r.length;
        r[at] = bytes1(uint8(r[at]) ^ delta);
        _refuseFuzzed(_call(r));
    }

    /// What each call costs, cold, with its intrinsic gas, where P-256 goes
    /// through its precompile: an attestation or complaint fits one L1
    /// deposit, so a seat can force its record through L1 by its cutoff
    /// (availability.md, Windows), and an attestation naming every root of a
    /// 16-seat panel stays a small fraction of a deposit's gas (T-25, T-52).
    function test_ForcedPathGas() public {
        string memory fj = vm.readFile(OBLIGATION);
        uint256 maxGas = vm.parseUint(vm.parseJsonString(fj, ".portal.maxResourceLimit"));
        uint256 maxData = vm.parseJsonUint(fj, ".portal.maxDepositData");
        bytes memory complaintCall = _call(_complaint(ah, 4, 2, countedCheckpoint, DAG_PB_PREFIX));
        // Another seat, so neither call finds its slot's word already written.
        bytes memory attestationCall =
            _call(_attestation(ah, 3, 3, 2, countedCheckpoint, new bytes32[](0)));
        assertTrue(complaintCall.length <= maxData, "a complaint call fits a deposit");
        if (!_p256Precompile()) {
            if (vm.envOr("EXPECT_P256VERIFY", false)) assertTrue(false, "no P256VERIFY");
            return;
        }
        uint256 complaintGas = _withIntrinsic(complaintCall, _coldGas(complaintCall));
        uint256 attestationGas = _withIntrinsic(attestationCall, _coldGas(attestationCall));
        // Sixteen seats with both roots each, named by one attestation.
        (bytes memory full, uint256 seats) = _sixteenSeatsWithRoots();
        assertTrue(full.length <= maxData, "a full attestation fits a deposit");
        uint256 fullGas = _withIntrinsic(full, _coldGas(full));
        assertTrue(
            complaintGas < 200_000, string.concat("a complaint: ", vm.toString(complaintGas))
        );
        assertTrue(
            attestationGas < 200_000, string.concat("an attestation: ", vm.toString(attestationGas))
        );
        assertTrue(fullGas < 500_000, string.concat("32 roots: ", vm.toString(fullGas)));
        assertTrue(fullGas <= maxGas, "fits a deposit");
        assertEq(seats, 16, "sixteen seats");
    }

    // --- helpers ---------------------------------------------------------------

    /// delivery.json's election with seats 1 to 16 registered under one key
    /// (the board reads only the seat bits and that seat's key), each seat
    /// holding a receipt and a complaint root, and seat 1's counted-extent
    /// attestation naming all 32 of them, as calldata.
    function _sixteenSeatsWithRoots() internal returns (bytes memory call, uint256 count) {
        bytes32 dh = keccak256("sixteen seats");
        bytes32 stub = keccak256("sixteen stub");
        _register(dh, stub);
        uint256 sk = deliverySecrets[1];
        (uint256 x, uint256 y) = _publicKey(sk);
        uint256 mask;
        for (uint256 seat = 1; seat <= 16; seat++) {
            trustees.setKey(stub, PANEL, seat, x, y);
            mask |= 1 << seat;
        }
        trustees.setKeySet(stub, PANEL, mask);
        bytes32[] memory roots = new bytes32[](32);
        for (uint8 seat = 1; seat <= 16; seat++) {
            for (uint8 kind = 1; kind <= 2; kind++) {
                bytes memory root = _signedRoot(dh, seat, kind, sk);
                assertEq(
                    _accept(abi.encodeCall(Board.submitObligationRoot, (root))).length, 1, "root"
                );
                roots[2 * (seat - 1) + kind - 1] = sha256(bytes.concat(rootHashDs, root));
            }
        }
        _sort(roots);
        call = _call(_signedAttestation(dh, 1, 1, 2, countedCheckpoint, roots, sk));
        count = 16;
    }

    function _call(bytes memory r) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitAvailabilityRecord, (r));
    }

    function _register(bytes32 dh, bytes32 stub) internal {
        ElectionRegistry.Parameters memory p;
        p.ballotVersion = 2;
        p.threshold = 2;
        p.panelSize = 3;
        elections.set(dh, p, new uint8[](0), new uint256[](0));
        elections.setCeremony(dh, stub, PANEL);
    }

    /// availability.json's seat `seat` (its default panel's), signing as `signer`.
    function _attestation(
        bytes32 dh,
        uint8 seat,
        uint8 signer,
        uint8 point,
        bytes32 checkpoint,
        bytes32[] memory roots
    ) internal view returns (bytes memory) {
        return _signedAttestation(dh, 1, seat, point, checkpoint, roots, secrets[signer]);
    }

    function _signedAttestation(
        bytes32 dh,
        uint8 panel,
        uint8 seat,
        uint8 point,
        bytes32 checkpoint,
        bytes32[] memory roots,
        uint256 sk
    ) internal view returns (bytes memory) {
        bytes memory body = abi.encodePacked(
            uint16(0x001b),
            uint8(1),
            dh,
            panel,
            seat,
            point,
            checkpoint,
            uint32(roots.length),
            abi.encodePacked(roots)
        );
        (uint256 r, uint256 s) = TrusteeFixture.sign(sk, sha256(bytes.concat(attestationDs, body)));
        return abi.encodePacked(body, r, s);
    }

    /// Seat 1 of delivery.json's election names `root` at the counted extent,
    /// as seat `seat`.
    function _signedOne(bytes32 root, uint8 seat) internal view returns (bytes memory) {
        bytes32[] memory one = new bytes32[](1);
        one[0] = root;
        return _signedAttestation(h, 1, seat, 2, countedCheckpoint, one, deliverySecrets[seat]);
    }

    function _complaint(bytes32 dh, uint8 seat, uint8 point, bytes32 checkpoint, bytes4 prefix)
        internal
        view
        returns (bytes memory)
    {
        bytes memory body = abi.encodePacked(
            uint16(0x001c),
            uint8(1),
            dh,
            uint8(1),
            seat,
            point,
            checkpoint,
            prefix,
            keccak256(abi.encode(seat, point, prefix))
        );
        (uint256 r, uint256 s) =
            TrusteeFixture.sign(secrets[seat], sha256(bytes.concat(complaintDs, body)));
        return abi.encodePacked(body, r, s);
    }

    /// A receipt or complaint root of one leaf (delivery.md, Obligation
    /// root), its CID a raw block's, signed with `sk`.
    function _signedRoot(bytes32 dh, uint8 seat, uint8 kind, uint256 sk)
        internal
        view
        returns (bytes memory)
    {
        bytes32 root = keccak256(abi.encode(dh, seat, kind));
        bytes memory body = abi.encodePacked(
            dh, seat, kind, uint32(1), root, RAW_PREFIX, keccak256(abi.encode(root))
        );
        (uint256 r, uint256 s) = TrusteeFixture.sign(sk, sha256(bytes.concat(rootDs, body)));
        return abi.encodePacked(uint16(0x001a), uint8(1), body, r, s);
    }

    /// The public key of `sk`, from a signature the precompile-free
    /// verifier accepts: the test only needs a key the stub can hold, so it
    /// takes the one TrusteeFixture derives.
    function _publicKey(uint256 sk) internal view returns (uint256 x, uint256 y) {
        string memory dj = vm.readFile(DELIVERY);
        for (uint256 i; vm.keyExistsJson(dj, _at(".panel", i, "")); i++) {
            if (
                vm.parseUint(string.concat("0x", _str(dj, _at(".panel", i, ".signingSecret"))))
                    == sk
            ) {
                (x, y,) = TrusteeFixture.point(_bytes(dj, _at(".panel", i, ".signingKey")));
                return (x, y);
            }
        }
        revert("no such secret");
    }

    function _sort(bytes32[] memory a) internal pure {
        for (uint256 i = 1; i < a.length; i++) {
            bytes32 v = a[i];
            uint256 j = i;
            for (; j > 0 && a[j - 1] > v; j--) {
                a[j] = a[j - 1];
            }
            a[j] = v;
        }
    }

    function _accept(bytes memory data) internal returns (Vm.Log[] memory logs) {
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        vm.recordLogs();
        (bool ok, bytes memory ret) = address(board).call(data);
        if (!ok) revert(string.concat("refused: ", vm.toString(ret)));
        logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].emitter == address(board), "emitter");
            acc = EventAccumulatorLib.step(
                acc, uint64(count + i), block.number, block.timestamp, logs[i].topics, logs[i].data
            );
        }
        (bytes32 after_, uint64 countAfter) = board.eventAccumulator();
        assertEq(countAfter, count + logs.length, "accumulator count");
        assertEq(after_, acc, "accumulator");
    }

    /// Runs `data`, which the board must refuse with exactly `expected`,
    /// emitting nothing and leaving the accumulator as it was.
    function _refuse(bytes memory data, bytes memory expected, string memory what) internal {
        bytes memory ret = _refusal(data, what);
        if (keccak256(ret) != keccak256(expected)) {
            revert(string.concat(what, ": refused with ", vm.toString(ret)));
        }
    }

    /// Refused with one of the availability call's own errors, never another revert.
    function _refuseFuzzed(bytes memory data) internal {
        bytes4 s = bytes4(_refusal(data, "fuzzed input"));
        assertTrue(
            s == AvailabilityCheckLib.AvailabilityMalformed.selector
                || s == AvailabilityCheckLib.AvailabilityRefused.selector
                || s == CanonicalCalldata.NonCanonicalCalldata.selector,
            "an unexpected revert"
        );
    }

    function _refusal(bytes memory data, string memory what) internal returns (bytes memory ret) {
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        bool ok;
        (ok, ret) = address(board).call(data);
        assertTrue(!ok, string.concat(what, ": accepted"));
        (bytes32 after_, uint64 countAfter) = board.eventAccumulator();
        assertEq(countAfter, count, what);
        assertEq(after_, acc, what);
    }

    function _malformed(ElectionDefinitionLib.DecodeError code, uint256 offset)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(
            AvailabilityCheckLib.AvailabilityMalformed.selector, code, offset
        );
    }

    function _refused(AvailabilityCheckLib.Code code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(AvailabilityCheckLib.AvailabilityRefused.selector, code);
    }

    /// The board and both registries cold, accounts and slots, as in a
    /// deposit of its own; the call must succeed.
    function _coldGas(bytes memory data) internal returns (uint256 used) {
        vm.cool(address(board));
        vm.cool(address(elections));
        vm.cool(address(trustees));
        uint256 before = gasleft();
        (bool ok,) = address(board).call(data);
        used = before - gasleft();
        assertTrue(ok, "gas call refused");
    }

    /// `used` plus the transaction's intrinsic gas: 21,000 and the calldata
    /// at EIP-2028's price or EIP-7623's floor, whichever is higher.
    function _withIntrinsic(bytes memory data, uint256 used) internal pure returns (uint256) {
        uint256 zeros;
        for (uint256 i; i < data.length; i++) {
            if (data[i] == 0) zeros++;
        }
        uint256 tokens = zeros + 4 * (data.length - zeros);
        uint256 standard = 21_000 + 4 * tokens + used;
        uint256 floor = 21_000 + 10 * tokens;
        return standard > floor ? standard : floor;
    }

    /// Whether the EVM answers P-256 verification at 0x100, with one of the
    /// vectors' honest records.
    function _p256Precompile() internal view returns (bool) {
        bytes memory r = _attestation(ah, 1, 1, 1, ballotCheckpoint, new bytes32[](0));
        bytes32 digest = sha256(bytes.concat(attestationDs, _slice(r, 0, ROOTS_AT)));
        (uint256 x, uint256 y,) = TrusteeFixture.point(
            _bytes(
                vm.readFile(AVAILABILITY), ".checks[0].election.panels[0].registered[0].signingKey"
            )
        );
        (bool ok, bytes memory ret) =
            address(0x100).staticcall(abi.encodePacked(digest, _slice(r, ROOTS_AT, 64), x, y));
        return ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
    }

    function _record(string memory ej, string memory id) internal view returns (string memory) {
        for (uint256 i; vm.keyExistsJson(ej, _at(".records", i, "")); i++) {
            if (_eq(_str(ej, _at(".records", i, ".id")), id)) return _at(".records", i, "");
        }
        revert(string.concat("no record ", id));
    }

    function _decodeError(string memory s)
        internal
        pure
        returns (ElectionDefinitionLib.DecodeError)
    {
        if (_eq(s, "truncated")) {
            return ElectionDefinitionLib.DecodeError.Truncated;
        }
        if (_eq(s, "trailing-bytes")) return ElectionDefinitionLib.DecodeError.TrailingBytes;
        if (_eq(s, "length-over-max")) return ElectionDefinitionLib.DecodeError.LengthOverMax;
        if (_eq(s, "unknown-record-type")) {
            return ElectionDefinitionLib.DecodeError.UnknownRecordType;
        }
        if (_eq(s, "unexpected-record-type")) {
            return ElectionDefinitionLib.DecodeError.UnexpectedRecordType;
        }
        if (_eq(s, "unknown-version")) return ElectionDefinitionLib.DecodeError.UnknownVersion;
        if (_eq(s, "invalid-enum")) return ElectionDefinitionLib.DecodeError.InvalidEnum;
        if (_eq(s, "non-canonical")) return ElectionDefinitionLib.DecodeError.NonCanonical;
        if (_eq(s, "profile-mismatch")) return ElectionDefinitionLib.DecodeError.ProfileMismatch;
        revert(string.concat("unknown decode error ", s));
    }

    function _ds(string memory tag) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(tag).length), tag);
    }

    function _type(bytes memory r) internal pure returns (uint256) {
        return uint256(uint8(r[0])) << 8 | uint8(r[1]);
    }

    function _u32(bytes memory r, uint256 o) internal pure returns (uint256 v) {
        for (uint256 i; i < 4; i++) {
            v = v << 8 | uint8(r[o + i]);
        }
    }

    function _withByte(bytes memory r, uint256 at, uint8 b) internal pure returns (bytes memory c) {
        c = bytes.concat(r);
        c[at] = bytes1(b);
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

    function _at(string memory list, uint256 i, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(list, "[", vm.toString(i), "]", field);
    }

    function _str(string memory json, string memory key) internal pure returns (string memory) {
        return vm.parseJsonString(json, key);
    }

    function _bytes(string memory json, string memory key) internal pure returns (bytes memory) {
        return vm.parseBytes(string.concat("0x", _str(json, key)));
    }

    function _b32(string memory json, string memory key) internal pure returns (bytes32) {
        return bytes32(vm.parseUint(string.concat("0x", _str(json, key))));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
