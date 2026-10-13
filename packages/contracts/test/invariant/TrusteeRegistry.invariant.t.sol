// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {TrusteeIdentityLib, TrusteeRegistry} from "../../src/TrusteeRegistry.sol";
import {TrusteeFixture, TrusteeHarness} from "../utils/TrusteeFixture.sol";
import {TestBase} from "../utils/Vm.sol";

/// Submits registrations for a few stubs under two pinned panels from any
/// account: any subset of seats, some signatures forged, some transcripts
/// zero, repeated stubs, each with its panel's key set (key-set.json) or, in
/// some calls, one seat's signing key replaced by an identity key. Keeps a
/// shadow of what the registry should hold.
contract TrusteeHandler is TestBase {
    TrusteeRegistry public immutable registry;
    TrusteeHarness internal immutable lib;
    uint256[8] internal secrets;
    /// Each panel's key set, as a record's seats, and its seat count.
    bytes[2] internal seatsOf;
    uint8[2] internal seatCountOf;

    uint256 public registrations;
    /// Set if a registration succeeded or failed against the rules.
    bool public unexpected;
    mapping(bytes32 stub => mapping(bytes32 panel => bytes32)) public shadow;
    mapping(bytes32 stub => mapping(bytes32 panel => bytes32)) public shadowKeySet;

    constructor(
        TrusteeRegistry registry_,
        uint256[8] memory secrets_,
        TrusteeFixture.Seat[][2] memory keySets
    ) {
        registry = registry_;
        lib = new TrusteeHarness();
        secrets = secrets_;
        for (uint256 p; p < 2; p++) {
            seatsOf[p] = TrusteeFixture.seatBytes(keySets[p]);
            seatCountOf[p] = uint8(keySets[p].length);
        }
    }

    function stubAt(uint256 seed) public pure returns (bytes32) {
        return keccak256(abi.encode("stub", seed % 4));
    }

    /// `seatMask` picks the seats (in order). In about a quarter of calls
    /// `forgeSeed` picks a seat that signs a different transcript, so its
    /// signature doesn't verify.
    function register(
        uint256 stubSeed,
        uint8 transcriptSeed,
        bool small,
        uint8 seatMask,
        uint8 forgeSeed,
        uint8 actorSeed,
        bool identityAsSigningKey
    ) external {
        Call memory c;
        c.panel = registry.panelIds(small ? 0 : 1);
        c.stub = stubAt(stubSeed);
        c.transcript =
            transcriptSeed % 4 == 0 ? bytes32(0) : keccak256(abi.encode("t", transcriptSeed % 4));
        bytes memory seats = _seats(c, small, identityAsSigningKey);
        // The approvals sign the set the record carries, altered or not, so
        // only the identity-key check refuses an altered one.
        c.keySetHash = lib.keySetHash(seats);
        (TrusteeFixture.Approval[] memory a, bool forged) = _approvals(c, seatMask, forgeSeed);
        bytes memory record = TrusteeFixture.encode(
            c.panel, c.stub, c.transcript, seatCountOf[small ? 0 : 1], seats, a
        );
        (,, uint8 quorum) = registry.panelOf(c.panel);
        bool allowed = c.transcript != bytes32(0) && a.length >= quorum && !forged
            && !identityAsSigningKey && shadow[c.stub][c.panel] == bytes32(0);
        vm.prank(address(uint160(0xA000 + actorSeed % 3)));
        try registry.registerCeremony(record) {
            if (!allowed) unexpected = true;
            shadow[c.stub][c.panel] = c.transcript;
            shadowKeySet[c.stub][c.panel] = c.keySetHash;
            registrations++;
        } catch {
            if (allowed) unexpected = true;
        }
    }

    /// The panel's key set as a record's seats or, if `identityAsSigningKey`,
    /// with seat 1's signing key replaced by its identity key: signed or not,
    /// such a set is refused (contracts.md, Registration, 8).
    function _seats(Call memory c, bool small, bool identityAsSigningKey)
        internal
        view
        returns (bytes memory seats)
    {
        seats = bytes.concat(seatsOf[small ? 0 : 1]);
        if (identityAsSigningKey) {
            (uint256 x, uint256 y) = registry.keyOf(c.panel, 1);
            assembly ("memory-safe") {
                mstore(add(seats, add(0x20, 33)), x)
                mstore(add(seats, add(0x20, 65)), y)
            }
        }
    }

    /// Seat `seat`'s signing key in the panel's key set, as the record
    /// carries it; zero for a seat outside the set.
    function expectedSigningKey(bool small, uint256 seat)
        external
        view
        returns (uint256 x, uint256 y)
    {
        bytes memory seats = seatsOf[small ? 0 : 1];
        for (uint256 at; at < seats.length; at += 97) {
            if (uint8(seats[at]) != seat) continue;
            assembly ("memory-safe") {
                x := mload(add(seats, add(0x20, add(at, 33))))
                y := mload(add(seats, add(0x20, add(at, 65))))
            }
        }
    }

    function _digest(Call memory c, uint8 seat, bool forge) internal view returns (bytes32) {
        return TrusteeIdentityLib.registrationDigest(
            uint64(block.chainid),
            address(registry),
            c.panel,
            seat,
            c.stub,
            forge ? keccak256("forged") : c.transcript,
            c.keySetHash
        );
    }

    struct Call {
        bytes32 panel;
        bytes32 stub;
        bytes32 transcript;
        bytes32 keySetHash;
    }

    /// The approvals of the seats `seatMask` picks, in order; in about a
    /// quarter of calls one of them signs another transcript.
    function _approvals(Call memory c, uint8 seatMask, uint8 forgeSeed)
        internal
        view
        returns (TrusteeFixture.Approval[] memory a, bool forged)
    {
        (, uint8 size,) = registry.panelOf(c.panel);
        uint256 count;
        for (uint8 seat = 1; seat <= size; seat++) {
            if (seatMask & (1 << (seat - 1)) != 0) count++;
        }
        a = new TrusteeFixture.Approval[](count);
        uint8 forgeSeat = forgeSeed < 64 ? forgeSeed % size + 1 : 0;
        uint256 at;
        for (uint8 seat = 1; seat <= size; seat++) {
            if (seatMask & (1 << (seat - 1)) == 0) continue;
            bool forge = seat == forgeSeat;
            forged = forged || forge;
            (uint256 r, uint256 s) = TrusteeFixture.sign(secrets[seat], _digest(c, seat, forge));
            a[at++] = TrusteeFixture.Approval(seat, r, s);
        }
    }
}

/// Invariants, over any sequence of handler calls:
/// 1. A registration succeeds exactly when its transcript hash is non-zero,
///    at least the panel's quorum of distinct seats signed it, every
///    signature verifies, and nothing is recorded for its stub and panel yet
///    (T-71, T-37, T-14).
/// 2. A stub's transcript under a panel is set once and never changes
///    (write-once; ceremony.md, Approval and re-runs).
/// 3. `ceremonyRecorded` is true for exactly the recorded pairs, with the
///    panel's own threshold and size, and never for a zero transcript.
/// 4. The event accumulator counts one event per pinned panel and per
///    successful registration.
/// 5. A recorded stub and panel hold the key set its approvals signed, with
///    its seats and their signing keys, and an unrecorded one holds none
///    (ADR 0028, 2B).
contract TrusteeRegistryInvariantTest is TestBase {
    TrusteeRegistry internal registry;
    TrusteeHandler internal handler;

    function setUp() public {
        string memory json = vm.readFile(TrusteeFixture.VECTORS);
        uint256[8] memory secrets;
        for (uint8 seat = 1; seat <= 7; seat++) {
            secrets[seat] = TrusteeFixture.secret(json, seat);
        }
        TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](2);
        panels[0] = TrusteeFixture.panel(json, "panel-2-of-2", 2);
        panels[1] = TrusteeFixture.panel(json, "panel-3-of-7", 4);
        registry = new TrusteeRegistry(panels);
        string memory ks = vm.readFile(TrusteeFixture.KEY_SET_VECTORS);
        TrusteeFixture.Seat[][2] memory keySets =
            [TrusteeFixture.keySet(ks, "key-set-2"), TrusteeFixture.keySet(ks, "key-set-7")];
        handler = new TrusteeHandler(registry, secrets, keySets);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_RegistrationsFollowTheRules() public view {
        assertTrue(!handler.unexpected(), "a registration broke the rules");
    }

    function invariant_RecordsMatchTheShadow() public view {
        for (uint256 p; p < 2; p++) {
            bytes32 panel = registry.panelIds(p);
            (uint8 threshold, uint8 size,) = registry.panelOf(panel);
            for (uint256 i; i < 4; i++) {
                bytes32 stub = handler.stubAt(i);
                bytes32 expected = handler.shadow(stub, panel);
                assertEq(registry.transcriptOf(stub, panel), expected, "transcript");
                assertTrue(
                    registry.ceremonyRecorded(stub, expected, panel, threshold, size)
                        == (expected != bytes32(0)),
                    "ceremonyRecorded"
                );
                assertTrue(
                    !registry.ceremonyRecorded(stub, bytes32(0), panel, threshold, size), "zero"
                );
                (bytes32 keySetHash, uint256 seats) = registry.keySetOf(stub, panel);
                assertEq(keySetHash, handler.shadowKeySet(stub, panel), "key set");
                uint256 expectedSeats = expected == bytes32(0) ? 0 : (size == 2 ? 0x6 : 0xfe);
                assertEq(seats, expectedSeats, "seats");
                for (uint256 seat; seat <= size + 1; seat++) {
                    (uint256 x, uint256 y) = registry.signingKeyOf(stub, panel, seat);
                    (uint256 ex, uint256 ey) = expected == bytes32(0)
                        ? (uint256(0), uint256(0))
                        : handler.expectedSigningKey(size == 2, seat);
                    assertTrue(x == ex && y == ey, "signing key");
                }
            }
        }
    }

    function invariant_EveryChangeIsAccumulated() public view {
        (, uint64 count) = registry.eventAccumulator();
        assertEq(count, 2 + handler.registrations(), "event count");
    }
}
