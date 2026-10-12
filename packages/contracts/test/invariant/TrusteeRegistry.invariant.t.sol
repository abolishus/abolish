// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {TrusteeIdentityLib, TrusteeRegistry} from "../../src/TrusteeRegistry.sol";
import {TrusteeFixture} from "../utils/TrusteeFixture.sol";
import {TestBase} from "../utils/Vm.sol";

/// Submits registrations for a few stubs under two pinned panels from any
/// account: any subset of seats, some signatures forged, some transcripts
/// zero, repeated stubs. Keeps a shadow of what the registry should hold.
contract TrusteeHandler is TestBase {
    TrusteeRegistry public immutable registry;
    uint256[8] internal secrets;

    uint256 public registrations;
    /// Set if a registration succeeded or failed against the rules.
    bool public unexpected;
    mapping(bytes32 stub => mapping(bytes32 panel => bytes32)) public shadow;

    constructor(TrusteeRegistry registry_, uint256[8] memory secrets_) {
        registry = registry_;
        secrets = secrets_;
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
        uint8 actorSeed
    ) external {
        bytes32 panel = registry.panelIds(small ? 0 : 1);
        (, uint8 size, uint8 quorum) = registry.panelOf(panel);
        bytes32 stub = stubAt(stubSeed);
        bytes32 transcript =
            transcriptSeed % 4 == 0 ? bytes32(0) : keccak256(abi.encode("t", transcriptSeed % 4));

        uint256 count;
        for (uint8 seat = 1; seat <= size; seat++) {
            if (seatMask & (1 << (seat - 1)) != 0) count++;
        }
        TrusteeFixture.Approval[] memory a = new TrusteeFixture.Approval[](count);
        uint8 forgeSeat = forgeSeed < 64 ? forgeSeed % size + 1 : 0;
        bool forged;
        uint256 at;
        for (uint8 seat = 1; seat <= size; seat++) {
            if (seatMask & (1 << (seat - 1)) == 0) continue;
            bool forge = seat == forgeSeat;
            forged = forged || forge;
            bytes32 digest = TrusteeIdentityLib.registrationDigest(
                uint64(block.chainid),
                address(registry),
                panel,
                seat,
                stub,
                forge ? keccak256("forged") : transcript
            );
            (uint256 r, uint256 s) = TrusteeFixture.sign(secrets[seat], digest);
            a[at++] = TrusteeFixture.Approval(seat, r, s);
        }

        bool allowed = transcript != bytes32(0) && count >= quorum && !forged
            && shadow[stub][panel] == bytes32(0);
        vm.prank(address(uint160(0xA000 + actorSeed % 3)));
        try registry.registerCeremony(TrusteeFixture.encode(panel, stub, transcript, a)) {
            if (!allowed) unexpected = true;
            shadow[stub][panel] = transcript;
            registrations++;
        } catch {
            if (allowed) unexpected = true;
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
        handler = new TrusteeHandler(registry, secrets);
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
            }
        }
    }

    function invariant_EveryChangeIsAccumulated() public view {
        (, uint64 count) = registry.eventAccumulator();
        assertEq(count, 2 + handler.registrations(), "event count");
    }
}
