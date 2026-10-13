// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

import {MembershipProofLib} from "../../src/MembershipProof.sol";

/// Exposes the membership-proof library to tests, with the proof in calldata
/// as a contract holds it.
contract MembershipHarness {
    function check(bytes calldata proof, MembershipProofLib.Signals calldata s)
        external
        view
        returns (MembershipProofLib.Verdict, uint256)
    {
        return MembershipProofLib.check(proof, s);
    }

    /// The gas `check` used, measured inside the call so the harness's own
    /// calldata copying isn't counted.
    function checkGas(bytes calldata proof, MembershipProofLib.Signals calldata s)
        external
        view
        returns (MembershipProofLib.Verdict verdict, uint256 used)
    {
        uint256 before = gasleft();
        (verdict,) = MembershipProofLib.check(proof, s);
        used = before - gasleft();
    }

    function field(bytes32 x) external pure returns (uint256) {
        return MembershipProofLib.field(x);
    }

    function scopeBytes(bytes32 definitionHash, uint8 tier, uint256 root)
        external
        pure
        returns (bytes32)
    {
        return MembershipProofLib.scopeBytes(definitionHash, tier, root);
    }

    function scope(bytes32 definitionHash, uint8 tier, uint256 root)
        external
        pure
        returns (uint256)
    {
        return MembershipProofLib.scope(definitionHash, tier, root);
    }

    function vkEncoding() external pure returns (bytes memory) {
        return MembershipProofLib.vkEncoding();
    }

    function vkHash() external pure returns (bytes32) {
        return MembershipProofLib.vkHash();
    }
}
