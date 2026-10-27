// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ElectionDefinitionLib} from "../../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {TrusteeRegistry} from "../../src/TrusteeRegistry.sol";
import {AuthorPanelFixture} from "../utils/AuthorPanelFixture.sol";
import {DefinitionHarness} from "../utils/DefinitionHarness.sol";
import {RegistryFixture} from "../utils/RegistryFixture.sol";
import {TrusteeFixture, TrusteeHarness} from "../utils/TrusteeFixture.sol";
import {TestBase} from "../utils/Vm.sol";

/// Creates elections and tries to register version-6 definitions, with and
/// without author panels, through both calls, with honest, short-of-quorum
/// and corrupted author records, from the creator or another account,
/// keeping a shadow of what the registry should hold.
contract AuthorPanelHandler is TestBase {
    address internal constant CREATOR = address(0xC4EA);
    address internal constant OTHER = address(0x07E4);

    ElectionRegistry public immutable registry;
    TrusteeRegistry internal immutable trustees;
    DefinitionHarness internal immutable lib;
    TrusteeHarness internal immutable tlib;

    bytes32[] public ids;
    /// Each registered election's definition hash, and whether it has an
    /// author panel.
    mapping(bytes32 => bytes32) public shadowHash;
    mapping(bytes32 => bool) public shadowAuthor;
    /// Every definition hash a call was tried with, registered or not.
    bytes32[] public tried;
    uint256 public plainRegistrations;
    uint256 public authorRegistrations;
    /// Registrations of a civic-record class (2 or 3), which the trustee
    /// registry's transitional panel never holds (rule 8).
    uint256 public civicRegistrations;
    bool public unexpected;
    /// Whether the definition being tried is of class 2 or 3.
    bool internal civic;

    constructor(
        ElectionRegistry registry_,
        TrusteeRegistry trustees_,
        DefinitionHarness lib_,
        TrusteeHarness tlib_
    ) {
        registry = registry_;
        trustees = trustees_;
        lib = lib_;
        tlib = tlib_;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function triedCount() external view returns (uint256) {
        return tried.length;
    }

    function create() external {
        vm.prank(CREATOR);
        ids.push(registry.createElection());
    }

    /// Tries to register a definition for a created election. `variant`
    /// picks the author panel (none, 1-of-1, 2-of-3 or 3-of-4), the call
    /// (plain or with the author record), the record (honest, one approval
    /// short of the quorum, or one bit flipped at `bit`) and the caller;
    /// `idSeed`'s top bits the poll class (1 to 3).
    function register(uint256 idSeed, uint8 variant, uint256 bit) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        uint256 panel = variant % 4;
        uint8 pollClass = uint8(1 + (idSeed >> 254) % 3);
        civic = pollClass >= 2;
        bytes memory enc = _approved(id, panel, pollClass);
        tried.push(lib.hash(enc));
        address caller = variant >= 200 ? OTHER : CREATOR;
        bool fresh = shadowHash[id] == bytes32(0) && caller == CREATOR;
        if ((variant / 4) % 2 == 0) _registerPlain(id, enc, panel, caller, fresh);
        else _registerWithAuthor(id, enc, panel, (variant / 8) % 3, caller, fresh, bit);
    }

    /// `k_A` and `n_A` of author panel `panel`, 0 for none.
    function _panel(uint256 panel) internal pure returns (uint8 k, uint8 n) {
        uint8[4] memory ks = [0, 1, 2, 3];
        uint8[4] memory ns = [0, 1, 3, 4];
        return (ks[panel], ns[panel]);
    }

    function _approved(bytes32 id, uint256 panel, uint8 pollClass) internal returns (bytes memory) {
        (uint8 k, uint8 n) = _panel(panel);
        ElectionDefinitionLib.Definition memory d =
            AuthorPanelFixture.definition(registry, id, k == 0 ? 1 : k, n == 0 ? 1 : n);
        d.pollClass = pollClass;
        if (panel == 0) {
            d.authorThreshold = 0;
            d.authorKeys = new ElectionDefinitionLib.P256Key[](0);
            d.authorTranscriptHash = bytes32(0);
            // What rule 9 serves a sealed poll without one.
            d.pinVersions[5] = 1;
            d.pinVersions[6] = 5;
        }
        return AuthorPanelFixture.approve(trustees, lib, tlib, d);
    }

    function _registerPlain(bytes32 id, bytes memory enc, uint256 panel, address caller, bool fresh)
        internal
    {
        vm.prank(caller);
        try registry.registerDefinition(enc) {
            // Never a definition with an author panel, nor a civic one.
            if (panel != 0 || !fresh || civic) unexpected = true;
            if (civic) civicRegistrations++;
            shadowHash[id] = lib.hash(enc);
            plainRegistrations++;
        } catch {
            if (panel == 0 && fresh && !civic) unexpected = true;
        }
    }

    /// `recordKind` 0 is honest, 1 one approval short of `q_A` (honest still
    /// for a 1-of-1 panel, whose quorum is 1), 2 one bit flipped.
    function _registerWithAuthor(
        bytes32 id,
        bytes memory enc,
        uint256 panel,
        uint256 recordKind,
        address caller,
        bool fresh,
        uint256 bit
    ) internal {
        bytes memory reg = _record(enc, panel, recordKind, bit);
        bool honest = recordKind == 0 || (recordKind == 1 && panel == 1);
        vm.prank(caller);
        try registry.registerDefinitionWithAuthorPanel(enc, reg) {
            if (panel == 0 || !fresh || !honest || civic) unexpected = true;
            if (civic) civicRegistrations++;
            bytes32 h = lib.hash(enc);
            shadowHash[id] = h;
            shadowAuthor[id] = true;
            authorRegistrations++;
            (, uint8 n) = _panel(panel);
            (bytes32 keySetHash, uint256 mask) = registry.authorKeySetOf(h);
            if (keySetHash != tlib.keySetHash(_seatsOf(reg)) || mask != (1 << (n + 1)) - 2) {
                unexpected = true;
            }
        } catch {
            if (panel != 0 && fresh && honest && !civic) unexpected = true;
        }
    }

    function _record(bytes memory enc, uint256 panel, uint256 recordKind, uint256 bit)
        internal
        view
        returns (bytes memory reg)
    {
        (uint8 k, uint8 n) = _panel(panel);
        if (n == 0) n = 1;
        uint8 q = k > n - 1 ? k : n - 1;
        if (q == 0) q = 1;
        reg = AuthorPanelFixture.registration(
            address(trustees),
            lib,
            tlib,
            enc,
            AuthorPanelFixture.seats(AuthorPanelFixture.range(1, n)),
            AuthorPanelFixture.range(1, recordKind == 1 && q > 1 ? q - 1 : q)
        );
        if (recordKind == 2) {
            bit = bit % (reg.length * 8);
            reg[bit / 8] ^= bytes1(uint8(0x80) >> (bit % 8));
        }
    }

    function _seatsOf(bytes memory reg) internal pure returns (bytes memory out) {
        out = new bytes(97 * uint256(uint8(reg[96])));
        for (uint256 i; i < out.length; i++) {
            out[i] = reg[97 + i];
        }
    }
}

/// Invariants, over any sequence of handler calls:
/// 1. `registerDefinition` never registers a definition with an author panel,
///    and `registerDefinitionWithAuthorPanel` never one without, nor one whose
///    record is short of the quorum or corrupted (T-25, T-37).
/// 2. An author key set is recorded exactly for the definitions registered
///    with an author panel, and it is the set their record carried; every
///    other definition hash tried, registered or refused, has none (T-54).
/// 3. Each election keeps the one definition first registered for it (T-34).
/// 4. The event accumulator counts one event per creation, one per plain
///    registration and two (`DefinitionRegistered`, `AuthorPanelRegistered`)
///    per registration with an author panel.
contract ElectionRegistryAuthorPanelInvariantTest is TestBase {
    ElectionRegistry internal registry;
    AuthorPanelHandler internal handler;

    function setUp() public {
        RegistryFixture.installL1Block(vm);
        TrusteeRegistry trustees = AuthorPanelFixture.trusteeRegistry();
        registry = new ElectionRegistry(RegistryFixture.deployment(address(trustees)));
        vm.warp(RegistryFixture.NOW);
        vm.roll(RegistryFixture.BLOCK);
        handler = new AuthorPanelHandler(
            registry, trustees, new DefinitionHarness(), new TrusteeHarness()
        );
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_NothingUnexpected() public view {
        assertTrue(!handler.unexpected(), "a registration succeeded or failed against the rules");
    }

    function invariant_AuthorKeySetExactlyForAuthorRegistrations() public view {
        for (uint256 i; i < handler.triedCount(); i++) {
            bytes32 h = handler.tried(i);
            (bytes32 keySetHash, uint256 mask) = registry.authorKeySetOf(h);
            bool registeredWithAuthor;
            for (uint256 j; j < handler.idCount(); j++) {
                bytes32 id = handler.ids(j);
                if (handler.shadowHash(id) == h && handler.shadowAuthor(id)) {
                    registeredWithAuthor = true;
                }
            }
            assertTrue(registeredWithAuthor == (keySetHash != bytes32(0)), "key set hash");
            assertTrue(registeredWithAuthor == (mask != 0), "key set seats");
        }
    }

    /// Under the transitional panel no definition of class 2 or 3 is ever
    /// registered (rule 8; T-14).
    function invariant_NoCivicPollUnderATransitionalPanel() public view {
        assertEq(handler.civicRegistrations(), 0, "a civic poll registered");
    }

    function invariant_DefinitionsAreWriteOnce() public view {
        for (uint256 i; i < handler.idCount(); i++) {
            bytes32 id = handler.ids(i);
            assertEq(registry.definitionHashOf(id), handler.shadowHash(id), "definition hash");
        }
    }

    function invariant_AccumulatorCountsEveryEvent() public view {
        (, uint64 count) = registry.eventAccumulator();
        assertEq(
            count,
            handler.idCount() + handler.plainRegistrations() + 2 * handler.authorRegistrations(),
            "events"
        );
    }
}
