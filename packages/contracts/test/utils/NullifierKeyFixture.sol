// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {ITrusteePanels} from "../../src/NullifierKey.sol";
import {TrusteeRegistry} from "../../src/TrusteeRegistry.sol";
import {Vm} from "./Vm.sol";

/// The pinned panels of docs/spec/vectors/nullifier-key-registry.json
/// (produced by an independent Python implementation), as a trustee registry
/// deploys them, for the group registry's Tier 2 scope.
library NullifierKeyFixture {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant VECTORS = "../../docs/spec/vectors/nullifier-key-registry.json";

    /// The vectors' scope: Base Sepolia, and the second contract Anvil's
    /// first default account deploys (CREATE from `DEPLOYER` at nonce 1),
    /// after the trustee registry at nonce 0.
    uint256 internal constant VECTOR_CHAIN_ID = 84532;
    address internal constant VECTOR_REGISTRY = 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512;
    address internal constant DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    /// `initial-5`'s `panel_id`, the scope's initial panel.
    bytes32 internal constant INITIAL_PANEL =
        0x8602de41042b8fe8d503f4ac0dd274559ebca3a0248d305ef6e9a4f1d04dfca2;

    /// Panel `name` of the vectors as a deployment input. The ceremony
    /// quorum is the threshold and the kind transitional: the group registry
    /// reads neither.
    function panel(string memory json, string memory name)
        internal
        pure
        returns (TrusteeRegistry.PanelInput memory input)
    {
        string memory at = string.concat(".panels.", name);
        string[] memory keys = vm.parseJsonStringArray(json, string.concat(at, ".keys"));
        input.threshold = uint8(vm.parseJsonUint(json, string.concat(at, ".threshold")));
        input.quorum = input.threshold;
        input.kind = 2;
        input.points = new uint256[2][](keys.length);
        for (uint256 i; i < keys.length; i++) {
            input.keys = bytes.concat(input.keys, vm.parseBytes(keys[i]));
            string memory p = string.concat(at, ".points[", vm.toString(i), "]");
            input.points[i] =
                [_hex(json, string.concat(p, ".x")), _hex(json, string.concat(p, ".y"))];
        }
    }

    /// A trustee registry pinning the vectors' `pinnedPanels`, the initial
    /// panel among them.
    function trustees() internal returns (ITrusteePanels) {
        string memory json = vm.readFile(VECTORS);
        string[] memory names = vm.parseJsonStringArray(json, ".pinnedPanels");
        TrusteeRegistry.PanelInput[] memory panels = new TrusteeRegistry.PanelInput[](names.length);
        for (uint256 i; i < names.length; i++) {
            panels[i] = panel(json, names[i]);
        }
        return ITrusteePanels(address(new TrusteeRegistry(panels)));
    }

    function _hex(string memory json, string memory key) private pure returns (uint256) {
        return vm.parseUint(string.concat("0x", vm.parseJsonString(json, key)));
    }
}
