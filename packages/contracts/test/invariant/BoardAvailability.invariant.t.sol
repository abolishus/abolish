// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {AvailabilityCheckLib} from "../../src/AvailabilityCheck.sol";
import {Board} from "../../src/Board.sol";
import {DeliveryCheckLib} from "../../src/DeliveryCheck.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {EventAccumulatorLib} from "../../src/EventAccumulator.sol";
import {ElectionsStub, TrusteesStub} from "../utils/BoardFixture.sol";
import {TrusteeFixture} from "../utils/TrusteeFixture.sol";
import {TestBase, Vm} from "../utils/Vm.sol";

/// Submits, for delivery.json's election and its three seats, obligation
/// roots of either kind (competing for their seat's slot), availability
/// attestations of either point naming any subset of the roots the board
/// holds and, sometimes, one it doesn't, availability complaints, repeats
/// of anything accepted, and one-byte changes of each. Keeps its own model
/// of the slots and the held roots, a shadow of the accumulator over exactly
/// the logs emitted, and the first outcome that broke a rule.
contract AvailabilityHandler is TestBase {
    bytes4 internal constant RAW_PREFIX = 0x01551220;
    bytes4 internal constant DAG_PB_PREFIX = 0x01701220;

    Board public immutable board;
    bytes32 internal immutable dh;
    uint256[4] internal secrets;
    bytes internal attestationDs;
    bytes internal complaintDs;
    bytes internal rootDs;
    bytes internal rootHashDs;

    /// The model: each seat's root slots (the record hash, zero while
    /// empty), the held roots in order of acceptance, and each availability
    /// slot (bit `2 · kind + point − 1`) filled.
    mapping(uint8 seat => mapping(uint8 kind => bytes32)) public rootSlots;
    bytes32[] internal held;
    mapping(uint8 seat => uint8) public availabilitySlots;

    /// Records accepted, by keccak-256 of their bytes, and the last few
    /// calls, to repeat or change.
    mapping(bytes32 => bool) public accepted;
    uint256 public acceptedCount;
    bytes[] internal lastCalls;
    bytes32 public shadowAccumulator;
    uint64 public shadowCount;
    string public failure;

    constructor(Board board_, bytes32 dh_, uint256[4] memory secrets_, bytes[4] memory tags) {
        board = board_;
        dh = dh_;
        secrets = secrets_;
        (attestationDs, complaintDs, rootDs, rootHashDs) = (tags[0], tags[1], tags[2], tags[3]);
        shadowAccumulator = EventAccumulatorLib.genesis(uint64(block.chainid), address(board_));
    }

    // --- actions ---------------------------------------------------------------

    /// A root of `seat` and `kind`, accepted exactly while its slot is empty.
    function submitRoot(uint8 seatSeed, bool complaint, uint8 salt) external {
        uint8 seat = seatSeed % 3 + 1;
        uint8 kind = complaint ? 2 : 1;
        bytes memory r = _root(seat, kind, salt);
        bool expect = rootSlots[seat][kind] == 0 || accepted[keccak256(r)];
        _submit(abi.encodeCall(Board.submitObligationRoot, (r)), r, expect);
        if (expect && rootSlots[seat][kind] == 0) {
            bytes32 h = sha256(bytes.concat(rootHashDs, r));
            rootSlots[seat][kind] = h;
            held.push(h);
        }
    }

    /// An attestation of `seat` at `point`, naming the held roots `mask`
    /// picks (point 2 only) and, if `stray`, one the board doesn't hold:
    /// accepted exactly while its slot is empty and every root is held.
    function submitAttestation(uint8 seatSeed, bool counted, uint256 mask, bool stray, uint8 salt)
        external
    {
        uint8 seat = seatSeed % 3 + 1;
        uint8 point = counted ? 2 : 1;
        bytes32[] memory roots = new bytes32[](counted ? 7 : 0);
        uint256 n;
        if (counted) {
            for (uint256 i; i < held.length; i++) {
                if ((mask >> i) & 1 == 1) roots[n++] = held[i];
            }
            if (stray) roots[n++] = keccak256(abi.encode("stray", salt));
        }
        assembly ("memory-safe") {
            mstore(roots, n)
        }
        _sort(roots);
        bytes memory r = _attestation(seat, point, roots, salt);
        bool fresh = availabilitySlots[seat] & _bit(0, point) == 0;
        bool repeat = accepted[keccak256(r)];
        bool expect = repeat || (fresh && !(counted && stray));
        _submit(_call(r), r, expect);
        if (expect && !repeat) availabilitySlots[seat] |= _bit(0, point);
    }

    /// A complaint of `seat` at `point`, accepted exactly while its slot is
    /// empty.
    function submitComplaint(uint8 seatSeed, bool counted, bool dagPb, uint8 salt) external {
        uint8 seat = seatSeed % 3 + 1;
        uint8 point = counted ? 2 : 1;
        bytes memory r = _complaint(seat, point, dagPb, salt);
        bool repeat = accepted[keccak256(r)];
        bool expect = repeat || availabilitySlots[seat] & _bit(1, point) == 0;
        _submit(_call(r), r, expect);
        if (expect && !repeat) availabilitySlots[seat] |= _bit(1, point);
    }

    /// One of the last calls again: accepted, as the no-op, exactly when it
    /// was accepted before.
    function repeatCall(uint256 which) external {
        if (lastCalls.length == 0) return;
        bytes memory data = lastCalls[which % lastCalls.length];
        bytes memory r = _record(data);
        _submit(data, r, accepted[keccak256(r)]);
    }

    /// One of the last calls with one byte of its record changed, which no
    /// rule accepts: the signature covers every byte before it, and a changed
    /// signature fails or isn't canonical.
    function submitChanged(uint256 which, uint256 position, uint8 delta) external {
        if (lastCalls.length == 0 || delta == 0) return;
        bytes memory data = lastCalls[which % lastCalls.length];
        bytes memory r = _record(data);
        r[position % r.length] = bytes1(uint8(r[position % r.length]) ^ delta);
        if (accepted[keccak256(r)]) return;
        bytes memory changed = bytes.concat(bytes4(data), abi.encode(r));
        _submit(changed, r, false);
    }

    // --- checks ----------------------------------------------------------------

    function _submit(bytes memory data, bytes memory r, bool expect) internal {
        (bytes32 acc, uint64 count) = board.eventAccumulator();
        vm.recordLogs();
        (bool ok,) = address(board).call(data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (ok != expect) {
            _fail(string.concat(expect ? "refused: " : "accepted: ", vm.toString(r)));
            return;
        }
        if (!ok) {
            (bytes32 after_, uint64 countAfter) = board.eventAccumulator();
            if (after_ != acc || countAfter != count) _fail("a refusal changed the accumulator");
            return;
        }
        bool repeat = accepted[keccak256(r)];
        if (logs.length != (repeat ? 0 : 1)) _fail("one event per new record, none for a repeat");
        for (uint256 i; i < logs.length; i++) {
            shadowAccumulator = EventAccumulatorLib.step(
                shadowAccumulator,
                shadowCount++,
                block.number,
                block.timestamp,
                logs[i].topics,
                logs[i].data
            );
            if (keccak256(logs[i].data) != keccak256(abi.encode(r))) _fail("the event's data");
            if (
                logs[i].topics[1] != dh
                    || uint256(logs[i].topics[2]) != uint8(r[35 + _seatOffset(r)])
            ) {
                _fail("the event's topics");
            }
        }
        if (!repeat) {
            accepted[keccak256(r)] = true;
            acceptedCount++;
        }
        if (lastCalls.length < 16) lastCalls.push(data);
        else lastCalls[shadowCount % 16] = data;
    }

    function _fail(string memory why) internal {
        if (bytes(failure).length == 0) failure = why;
    }

    // --- records ---------------------------------------------------------------

    function _call(bytes memory r) internal pure returns (bytes memory) {
        return abi.encodeCall(Board.submitAvailabilityRecord, (r));
    }

    function _bit(uint256 kind, uint8 point) internal pure returns (uint8) {
        return uint8(1 << (2 * kind + point - 1));
    }

    /// A root's seat is at 35; an availability record's at 36, after its panel.
    function _seatOffset(bytes memory r) internal pure returns (uint256) {
        return uint8(r[1]) == 0x1a ? 0 : 1;
    }

    function _root(uint8 seat, uint8 kind, uint8 salt) internal view returns (bytes memory) {
        bytes32 root = keccak256(abi.encode(seat, kind, salt));
        bytes memory body = abi.encodePacked(
            dh, seat, kind, uint32(1), root, RAW_PREFIX, keccak256(abi.encode(root))
        );
        (uint256 r, uint256 s) =
            TrusteeFixture.sign(secrets[seat], sha256(bytes.concat(rootDs, body)));
        return abi.encodePacked(uint16(0x001a), uint8(1), body, r, s);
    }

    function _attestation(uint8 seat, uint8 point, bytes32[] memory roots, uint8 salt)
        internal
        view
        returns (bytes memory)
    {
        bytes memory body = abi.encodePacked(
            uint16(0x001b),
            uint8(1),
            dh,
            uint8(1),
            seat,
            point,
            keccak256(abi.encode("checkpoint", point, salt % 4)),
            uint32(roots.length),
            abi.encodePacked(roots)
        );
        (uint256 r, uint256 s) =
            TrusteeFixture.sign(secrets[seat], sha256(bytes.concat(attestationDs, body)));
        return abi.encodePacked(body, r, s);
    }

    function _complaint(uint8 seat, uint8 point, bool dagPb, uint8 salt)
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
            keccak256(abi.encode("checkpoint", point, salt % 4)),
            dagPb ? DAG_PB_PREFIX : RAW_PREFIX,
            keccak256(abi.encode("object", salt))
        );
        (uint256 r, uint256 s) =
            TrusteeFixture.sign(secrets[seat], sha256(bytes.concat(complaintDs, body)));
        return abi.encodePacked(body, r, s);
    }

    /// The `bytes` argument of a one-argument call.
    function _record(bytes memory data) internal pure returns (bytes memory r) {
        uint256 len;
        assembly ("memory-safe") {
            len := mload(add(data, 68))
        }
        r = new bytes(len);
        for (uint256 i; i < len; i++) {
            r[i] = data[68 + i];
        }
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
}

/// The availability call's invariants (docs/spec/contracts.md, Board,
/// Availability records; T-17, T-52):
/// 1. A record is accepted exactly when the model says: an obligation root
///    while its seat's slot for its kind is empty, an attestation while its
///    seat's slot for its point is empty and every root it names is one the
///    board holds for the election, a complaint while its slot is empty,
///    and anything already accepted as the no-op; a one-byte change of any
///    record is refused.
/// 2. The event count is the number of distinct records accepted, each
///    emitted once, with its definition hash and seat as topics and itself as
///    data; a refusal leaves the accumulator unchanged.
/// 3. The accumulator is the replay of exactly the logs emitted.
/// So no seat archives more than one record of a type per point, four per
/// election, and no attestation names a root the board doesn't hold.
contract BoardAvailabilityInvariantTest is TestBase {
    string internal constant DELIVERY = "../../docs/spec/vectors/delivery.json";
    string internal constant AVAILABILITY = "../../docs/spec/vectors/availability.json";
    string internal constant ROOTS = "../../docs/spec/vectors/delivery-root.json";
    bytes32 internal constant STUB = keccak256("delivery stub");
    bytes32 internal constant PANEL = keccak256("panel");

    Board internal board;
    AvailabilityHandler internal handler;

    function setUp() public {
        ElectionsStub elections = new ElectionsStub();
        TrusteesStub trustees = new TrusteesStub();
        board = new Board(address(elections), address(trustees), address(0x4E1A));
        string memory dj = vm.readFile(DELIVERY);
        bytes32 dh =
            bytes32(vm.parseUint(string.concat("0x", vm.parseJsonString(dj, ".definitionHash"))));
        ElectionRegistry.Parameters memory p;
        p.ballotVersion = 2;
        elections.set(dh, p, new uint8[](0), new uint256[](0));
        elections.setCeremony(dh, STUB, PANEL);
        uint256[4] memory secrets;
        uint256 seats;
        for (uint256 i; vm.keyExistsJson(dj, string.concat(".panel[", vm.toString(i), "]")); i++) {
            string memory at = string.concat(".panel[", vm.toString(i), "]");
            uint256 seat = vm.parseJsonUint(dj, string.concat(at, ".seat"));
            (uint256 x, uint256 y,) = TrusteeFixture.point(
                vm.parseBytes(
                    string.concat("0x", vm.parseJsonString(dj, string.concat(at, ".signingKey")))
                )
            );
            trustees.setKey(STUB, PANEL, seat, x, y);
            secrets[seat] = vm.parseUint(
                string.concat("0x", vm.parseJsonString(dj, string.concat(at, ".signingSecret")))
            );
            seats |= 1 << seat;
        }
        assertEq(seats, 0xe, "seats 1 to 3");
        trustees.setKeySet(STUB, PANEL, seats);
        string memory aj = vm.readFile(AVAILABILITY);
        string memory rj = vm.readFile(ROOTS);
        bytes[4] memory tags = [
            _ds(vm.parseJsonString(aj, ".tags.attestation")),
            _ds(vm.parseJsonString(aj, ".tags.complaint")),
            _ds(vm.parseJsonString(rj, ".tag")),
            _ds(vm.parseJsonString(rj, ".recordHashTag"))
        ];
        handler = new AvailabilityHandler(board, dh, secrets, tags);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_NoRuleBroken() public view {
        assertTrue(bytes(handler.failure()).length == 0, handler.failure());
    }

    function invariant_CountIsTheDistinctRecordsAccepted() public view {
        (, uint64 count) = board.eventAccumulator();
        assertEq(count, handler.acceptedCount(), "count");
        assertEq(count, handler.shadowCount(), "shadow count");
    }

    function invariant_AccumulatorIsTheShadowReplay() public view {
        (bytes32 acc,) = board.eventAccumulator();
        assertEq(acc, handler.shadowAccumulator(), "accumulator");
    }

    function _ds(string memory tag) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(tag).length), tag);
    }
}
