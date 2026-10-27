// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ElectionDefinitionLib} from "../../src/ElectionDefinition.sol";
import {ElectionRegistry} from "../../src/ElectionRegistry.sol";
import {TrusteeIdentityLib, TrusteeRegistry} from "../../src/TrusteeRegistry.sol";
import {DefinitionEncoder, DefinitionHarness} from "./DefinitionHarness.sol";
import {RegistryFixture} from "./RegistryFixture.sol";
import {TrusteeFixture, TrusteeHarness} from "./TrusteeFixture.sol";
import {Vm} from "./Vm.sol";

/// The election registry with rule 9 serving every version-6 profile, author
/// panels with board-entry version 7 among them, as part 5e-5d of P2-16 will:
/// until then the deployed registry refuses every author panel at its
/// board-entry pin, before any author panel check, so the tests
/// reach the author panel's registration only through this override. Every
/// other rule is the deployed contract's.
contract ServingVersion6Registry is ElectionRegistry {
    constructor(Deployment memory dep) ElectionRegistry(dep) {}

    function _requireServedProfile(ElectionDefinitionLib.Definition memory def)
        internal
        pure
        override
    {
        if (def.version != 6) super._requireServedProfile(def);
    }
}

/// Version-6 definitions with author panels and their signed registrations,
/// for the unit and invariant tests of the author panel's registration
/// (docs/spec/contracts.md, Author panel registration). The default panel is
/// `panel-4-of-7` of docs/spec/vectors/trustee.json, pinned in a real trustee
/// registry; author seat `i`'s identity key is `i·G`, so its secret is `i`.
library AuthorPanelFixture {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant DEFAULT_TRANSCRIPT = keccak256("default transcript");

    /// A trustee registry pinning `panel-4-of-7` with quorum 4, transitional.
    function trusteeRegistry() internal returns (TrusteeRegistry) {
        return trusteeRegistry(2);
    }

    /// A trustee registry pinning `panel-4-of-7` with quorum 4 and kind `kind`.
    function trusteeRegistry(uint8 kind) internal returns (TrusteeRegistry) {
        string memory json = vm.readFile(TrusteeFixture.VECTORS);
        TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](1);
        panels[0] = TrusteeFixture.panel(json, "panel-4-of-7", 4);
        panels[0].kind = kind;
        return new TrusteeRegistry(panels);
    }

    /// A version-6 definition for election `id` with a `k`-of-`n` author panel
    /// of keys `1·G` to `n·G`, pinning what part 5e-5d serves (ballot 4, opening
    /// 3, board entry 7, contract event 12, display text 2), under the trustee
    /// registry's default panel.
    function definition(ElectionRegistry registry, bytes32 id, uint8 k, uint8 n)
        internal
        view
        returns (ElectionDefinitionLib.Definition memory d)
    {
        d = withDefaultPanel(registry, RegistryFixture.templateV(registry, id, 6));
        d.pinVersions[1] = 4;
        d.pinVersions[2] = 3;
        d.pinVersions[6] = 7;
        d.pinVersions[7] = 12;
        d.pinVersions[8] = 2;
        d.authorThreshold = k;
        d.authorTranscriptHash = sha256(abi.encode("author transcript", id));
        d.authorKeys = new ElectionDefinitionLib.P256Key[](n);
        for (uint256 i; i < n; i++) {
            (uint256 x, uint256 y) = vm.publicKeyP256(i + 1);
            d.authorKeys[i] = ElectionDefinitionLib.P256Key(uint8(2 + (y & 1)), bytes32(x));
        }
    }

    /// `d` under the trustee registry's pinned panel, with the default transcript.
    function withDefaultPanel(ElectionRegistry registry, ElectionDefinitionLib.Definition memory d)
        internal
        view
        returns (ElectionDefinitionLib.Definition memory)
    {
        d.panelId = TrusteeRegistry(registry.trusteeRegistry()).panelIds(0);
        d.threshold = 4;
        d.panelSize = 7;
        d.ceremonyTranscriptHash = DEFAULT_TRANSCRIPT;
        return d;
    }

    /// Encodes `d` and records its default ceremony in the trustee registry,
    /// approved by seats 1 to 4 over `key-set-7`, unless it is recorded
    /// already (the same definition tried again).
    function approve(
        TrusteeRegistry trustees,
        DefinitionHarness lib,
        TrusteeHarness tlib,
        ElectionDefinitionLib.Definition memory d
    ) internal returns (bytes memory enc) {
        enc = DefinitionEncoder.encode(d);
        string memory json = vm.readFile(TrusteeFixture.VECTORS);
        bytes32 stub = lib.stubHash(enc);
        bytes32 panel = trustees.panelIds(0);
        if (trustees.transcriptOf(stub, panel) != bytes32(0)) return enc;
        TrusteeFixture.Seat[] memory ks =
            TrusteeFixture.keySet(vm.readFile(TrusteeFixture.KEY_SET_VECTORS), "key-set-7");
        bytes32 keySetHash = tlib.keySetHash(TrusteeFixture.seatBytes(ks));
        TrusteeFixture.Approval[] memory a = new TrusteeFixture.Approval[](4);
        for (uint8 i; i < 4; i++) {
            bytes32 digest = TrusteeIdentityLib.registrationDigest(
                uint64(block.chainid),
                address(trustees),
                panel,
                i + 1,
                stub,
                DEFAULT_TRANSCRIPT,
                keySetHash
            );
            (uint256 r, uint256 s) = TrusteeFixture.sign(TrusteeFixture.secret(json, i + 1), digest);
            a[i] = TrusteeFixture.Approval(i + 1, r, s);
        }
        trustees.registerCeremony(TrusteeFixture.encode(panel, stub, DEFAULT_TRANSCRIPT, ks, a));
    }

    /// Author seats `indices`, each with a signing key no identity key is.
    function seats(uint8[] memory indices)
        internal
        pure
        returns (TrusteeFixture.Seat[] memory out)
    {
        out = new TrusteeFixture.Seat[](indices.length);
        for (uint256 i; i < indices.length; i++) {
            (uint256 x, uint256 y) = vm.publicKeyP256(1000 + i);
            out[i] = TrusteeFixture.Seat(indices[i], keccak256(abi.encode("kem", i)), x, y);
        }
    }

    /// The author registration of `enc` with key set `ks`, approved by
    /// `approvers` under the definition's own header, for trustee registry
    /// `trustees`.
    function registration(
        address trustees,
        DefinitionHarness lib,
        TrusteeHarness tlib,
        bytes memory enc,
        TrusteeFixture.Seat[] memory ks,
        uint8[] memory approvers
    ) internal view returns (bytes memory) {
        return signed(
            trustees,
            tlib,
            lib.authorPanelId(enc),
            lib.authorStubHash(enc),
            lib.decode(enc).authorTranscriptHash,
            ks,
            approvers
        );
    }

    /// A record with this header and key set, each approver `i` signing with
    /// secret `i` (its author key; seat 0 with an unrelated key) for trustee
    /// registry `trustees`.
    function signed(
        address trustees,
        TrusteeHarness tlib,
        bytes32 authorPanel,
        bytes32 stub,
        bytes32 transcript,
        TrusteeFixture.Seat[] memory ks,
        uint8[] memory approvers
    ) internal view returns (bytes memory) {
        bytes32 keySetHash = tlib.keySetHash(TrusteeFixture.seatBytes(ks));
        TrusteeFixture.Approval[] memory a = new TrusteeFixture.Approval[](approvers.length);
        for (uint256 i; i < approvers.length; i++) {
            uint8 seat = approvers[i];
            bytes32 digest = TrusteeIdentityLib.registrationDigest(
                uint64(block.chainid), trustees, authorPanel, seat, stub, transcript, keySetHash
            );
            (uint256 r, uint256 s) = TrusteeFixture.sign(seat == 0 ? 99 : seat, digest);
            a[i] = TrusteeFixture.Approval(seat, r, s);
        }
        return TrusteeFixture.encode(authorPanel, stub, transcript, ks, a);
    }

    function range(uint8 from, uint8 to) internal pure returns (uint8[] memory s) {
        s = new uint8[](to - from + 1);
        for (uint8 i; i < s.length; i++) {
            s[i] = from + i;
        }
    }
}
